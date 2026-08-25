/** Body-size, request-rate, and in-process concurrency guards for a public host. */

import { BUNDLE_LIMITS } from "@pylos/core";

export const MAX_JSON_BYTES = 1_048_576;
/** Thread creation accepts a bounded JSON envelope; the title itself is capped separately. */
export const MAX_THREAD_CREATE_BODY_BYTES = 1_048_576;
export const MAX_UPLOAD_BYTES = 33_554_432;
/**
 * Bun's socket-level ceiling. The raw bundle importer streams and stages up
 * to the kernel's full archive bound, so this must not be reduced to the
 * multipart upload limit. Routes with smaller contracts enforce those limits
 * before materialising their bodies. This is a per-request bound, not a
 * profile disk quota; aggregate hosted profile storage remains not-claimed.
 */
export const MAX_REQUEST_BODY_BYTES = BUNDLE_LIMITS.maxBundleBytes;

/** Turns per minute for one signed-in subject; keyed by subject so new sessions do not reset it. */
export const TURNS_PER_MINUTE = 64;
/** Sign-in attempts per minute from one address. */
export const LOGINS_PER_MINUTE = 20;
/** Heavy hosted operations are serialized per subject to protect one vault. */
export const MAX_HEAVY_PER_SUBJECT = 1;
/** A process-wide cap keeps concurrent imports/exports from exhausting the host. */
export const MAX_HEAVY_GLOBAL = 4;
/** Active response-held turns one subject may occupy across distinct threads. */
export const MAX_ACTIVE_TURNS_PER_SUBJECT = 4;
/** Process-wide active response-held turns across every hosted subject. */
export const MAX_ACTIVE_TURNS_GLOBAL = 32;

const MINUTE_MS = 60_000;
export const MAX_RATE_LIMIT_KEYS = 8_192;

/** The part of `Bun.serve`'s server handle a request handler needs. */
export interface RequestServer {
  requestIP(request: Request): { address: string } | null;
}

/**
 * The key a per-address limit counts against. `X-Forwarded-For` is honoured only
 * when the socket peer is itself local or private — that is, a reverse proxy in
 * front of us — so a client on the internet cannot choose its own bucket. It is
 * a rate-limit key and nothing else: no identity decision reads it.
 */
export function clientKey(request: Request, server: RequestServer | undefined): string {
  const peer = server?.requestIP(request)?.address;
  if (peer === undefined) return "unknown";
  if (!isPrivate(peer)) return peer;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded !== undefined && forwarded.length > 0 ? forwarded : peer;
}

function isPrivate(address: string): boolean {
  const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (bare === "::1" || bare === "127.0.0.1") return true;
  if (/^127\./.test(bare) || /^10\./.test(bare) || /^192\.168\./.test(bare)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(bare)) return true;
  return /^f[cd]/i.test(bare);
}

export function declaredLength(request: Request): number {
  const value = Number(request.headers.get("content-length") ?? "");
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Continuous refill: `capacity` tokens per `windowMs`, so bursts are allowed but the mean is not. */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number = MINUTE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    const at = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= MAX_RATE_LIMIT_KEYS) this.prune(at);
      // Refuse an untracked key after expiry pruning. Evicting a fresh bucket
      // would let a rotating client reset its limit; inserting would make the
      // public pre-auth map unbounded. Existing keys continue normally.
      if (this.buckets.size >= MAX_RATE_LIMIT_KEYS) return false;
      bucket = { tokens: this.capacity, at };
      this.buckets.set(key, bucket);
    }
    const refill = ((at - bucket.at) / this.windowMs) * this.capacity;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
    bucket.at = at;
    // Map insertion order is the LRU order used by prune. Refreshing the row
    // keeps expiry pruning proportional to entries actually removed.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private prune(at: number): void {
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.at < this.windowMs) break;
      this.buckets.delete(key);
    }
  }
}

export interface HeavyOperationLease {
  release(): void;
}

export interface TurnConcurrencyLease {
  release(): void;
}

/** Immediate admission gate held until the hosted turn response body settles. */
export class TurnConcurrencyGate {
  private activeGlobal = 0;
  private readonly activeBySubject = new Map<string, number>();

  constructor(
    private readonly perSubject = MAX_ACTIVE_TURNS_PER_SUBJECT,
    private readonly global = MAX_ACTIVE_TURNS_GLOBAL,
  ) {
    if (!Number.isSafeInteger(perSubject) || perSubject < 1) {
      throw new RangeError("per-subject turn concurrency must be a positive integer");
    }
    if (!Number.isSafeInteger(global) || global < 1) {
      throw new RangeError("global turn concurrency must be a positive integer");
    }
  }

  tryAcquire(subject: string): TurnConcurrencyLease | undefined {
    const active = this.activeBySubject.get(subject) ?? 0;
    if (active >= this.perSubject || this.activeGlobal >= this.global) return undefined;
    this.activeBySubject.set(subject, active + 1);
    this.activeGlobal += 1;
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.activeGlobal -= 1;
        const remaining = (this.activeBySubject.get(subject) ?? 1) - 1;
        if (remaining <= 0) this.activeBySubject.delete(subject);
        else this.activeBySubject.set(subject, remaining);
      },
    };
  }
}

/** Immediate, non-queueing concurrency gate for expensive hosted operations. */
export class HeavyOperationGate {
  private activeGlobal = 0;
  private readonly activeBySubject = new Map<string, number>();

  constructor(
    private readonly perSubject = MAX_HEAVY_PER_SUBJECT,
    private readonly global = MAX_HEAVY_GLOBAL,
  ) {
    if (!Number.isSafeInteger(perSubject) || perSubject < 1) {
      throw new RangeError("per-subject heavy concurrency must be a positive integer");
    }
    if (!Number.isSafeInteger(global) || global < 1) {
      throw new RangeError("global heavy concurrency must be a positive integer");
    }
  }

  tryAcquire(subject: string): HeavyOperationLease | undefined {
    const active = this.activeBySubject.get(subject) ?? 0;
    if (active >= this.perSubject || this.activeGlobal >= this.global) return undefined;
    this.activeBySubject.set(subject, active + 1);
    this.activeGlobal += 1;
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.activeGlobal -= 1;
        const remaining = (this.activeBySubject.get(subject) ?? 1) - 1;
        if (remaining <= 0) this.activeBySubject.delete(subject);
        else this.activeBySubject.set(subject, remaining);
      },
    };
  }
}
