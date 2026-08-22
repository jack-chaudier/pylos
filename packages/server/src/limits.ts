/** Body-size and request-rate guards for a public host. In-process, no state to share. */

export const MAX_JSON_BYTES = 1_048_576;
export const MAX_UPLOAD_BYTES = 33_554_432;

/** Turns per minute for one signed-in subject; keyed by subject so new sessions do not reset it. */
export const TURNS_PER_MINUTE = 64;
/** Sign-in attempts per minute from one address. */
export const LOGINS_PER_MINUTE = 20;

const MINUTE_MS = 60_000;
const MAX_KEYS = 8_192;

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
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at };
    const refill = ((at - bucket.at) / this.windowMs) * this.capacity;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
    bucket.at = at;
    if (this.buckets.size >= MAX_KEYS) this.prune(at);
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private prune(at: number): void {
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.at >= this.windowMs) this.buckets.delete(key);
    }
  }
}
