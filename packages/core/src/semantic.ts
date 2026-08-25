/**
 * Address-only semantic routing primitives (KERNEL A15.2).
 *
 * This module deliberately has no Vault, SQLite, or provider dependency.  A
 * semantic index may propose a sequence and a byte range, but the kernel must
 * validate that proposal against the current episode before it can be paged.
 * The helpers below are the seam between an optional index implementation and
 * that validation step.  They never turn a hit into an atom, certificate, or
 * authority claim.
 */

import type { EvidenceAuthority, PageRecord, Role, SemanticReceipt, Seq, Sha256 } from "@pylos/protocol";
import { sha256 } from "./hash.ts";

/** The conservative default when no extension/model runtime is packaged. */
export const DEFAULT_SEMANTIC_UNAVAILABLE_REASON =
  "sqlite-vec and a pinned embedding runtime are not packaged";

/** A capability description supplied by a runtime probe, not by a model. */
export interface SemanticProbeInput {
  /** The loaded sqlite-vec extension and its pinned version, if any. */
  sqliteVec?: {
    available: boolean;
    version?: string;
    reason?: string;
  };
  /** The embedding model/tokenizer artifact used to produce the index. */
  embedding?: {
    model: string;
    modelDigest: Sha256;
    dimension: number;
  };
  /** Number of eligible source spans and the number indexed byte-exactly. */
  eligible?: number;
  indexed?: number;
}

/** The probed capability, with operational metadata kept outside the packet receipt. */
export interface SemanticCapability {
  status: SemanticReceipt["status"];
  model?: string;
  modelDigest?: Sha256;
  extensionVersion?: string;
  dimension?: number;
  indexed: number;
  eligible: number;
  reason?: string;
}

/**
 * Capability probing is fail-closed.  In particular, an absent probe is not
 * interpreted as “the extension probably works”; it is an unavailable route.
 * `ready` requires a pinned extension, a pinned embedding artifact, valid
 * dimensions, and a complete index.
 */
export function probeSemanticCapability(input: SemanticProbeInput = {}): SemanticCapability {
  const indexed = nonNegativeCount(input.indexed);
  const eligible = nonNegativeCount(input.eligible);
  const extension = input.sqliteVec;
  const embedding = input.embedding;

  if (extension?.available !== true) {
    return {
      status: "unavailable",
      indexed,
      eligible,
      reason: extension?.reason ?? DEFAULT_SEMANTIC_UNAVAILABLE_REASON,
    };
  }

  if (extension.version === undefined || extension.version.trim().length === 0) {
    return {
      status: "incompatible",
      indexed,
      eligible,
      reason: "sqlite-vec is present but its extension version is not pinned",
    };
  }

  if (
    embedding === undefined ||
    embedding.model.trim().length === 0 ||
    !isSha256(embedding.modelDigest) ||
    !Number.isSafeInteger(embedding.dimension) ||
    embedding.dimension <= 0
  ) {
    return {
      status: "incomplete",
      extensionVersion: extension.version,
      indexed,
      eligible,
      reason: "a pinned embedding model, digest, and positive dimension are required",
    };
  }

  const base = {
    model: embedding.model,
    modelDigest: embedding.modelDigest,
    extensionVersion: extension.version,
    dimension: embedding.dimension,
    indexed,
    eligible,
  } satisfies Omit<SemanticCapability, "status" | "reason">;

  if (input.indexed === undefined || input.eligible === undefined) {
    return {
      status: "incomplete",
      ...base,
      reason: "semantic index coverage was not measured",
    };
  }
  if (indexed > eligible) {
    return {
      status: "incompatible",
      ...base,
      reason: "semantic index count exceeds eligible source count",
    };
  }
  if (indexed < eligible) {
    return {
      status: "incomplete",
      ...base,
      reason: `semantic index is incomplete: indexed ${indexed} of ${eligible} eligible spans`,
    };
  }
  return { status: "ready", ...base };
}

/** Convert an operational capability into the protocol's stable receipt. */
export function buildSemanticReceipt(capability: SemanticCapability | SemanticReceipt): SemanticReceipt {
  const receipt: SemanticReceipt = {
    status: capability.status,
    ...(capability.model === undefined ? {} : { model: capability.model }),
    ...(capability.modelDigest === undefined ? {} : { modelDigest: capability.modelDigest }),
    ...(capability.indexed === undefined ? {} : { indexed: capability.indexed }),
    ...(capability.eligible === undefined ? {} : { eligible: capability.eligible }),
    ...(capability.reason === undefined ? {} : { reason: capability.reason }),
  };
  return receipt;
}

/** A hit proposed by an optional semantic index.  All hashes are untrusted input. */
export interface SemanticHit {
  seq: Seq;
  /** Preferred protocol spelling; `span` is accepted for the existing route seam. */
  byteRange?: [number, number];
  span?: [number, number];
  /** Whole UTF-8 episode content hash. `sourceHash` is an accepted alias. */
  contentHash?: Sha256;
  sourceHash?: Sha256;
  /** Hash of the exact proposed UTF-8 byte span. `hash` is the legacy alias. */
  spanHash?: Sha256;
  hash?: Sha256;
  revision?: string;
  distance?: number;
}

/** Minimal current source supplied by the kernel's archive lookup. */
export interface SemanticSource {
  seq: Seq;
  content: string;
  role?: Role;
  /** Stored content hash, when the lookup already fetched it. */
  contentHash?: Sha256;
  removed?: boolean;
  /** Current atom/source revision, when the route is revision-bound. */
  revision?: string;
}

export type SemanticHitRejection =
  | "malformed-hit"
  | "missing-source"
  | "deleted-source"
  | "sequence-mismatch"
  | "missing-range"
  | "range-out-of-bounds"
  | "invalid-utf8"
  | "missing-hash"
  | "source-hash-mismatch"
  | "span-hash-mismatch"
  | "revision-mismatch";

export interface VerifiedSemanticHit {
  accepted: true;
  seq: Seq;
  byteRange: [number, number];
  sourceHash: Sha256;
  spanHash: Sha256;
  text: string;
  bytes: Uint8Array;
  role?: Role;
  authority: EvidenceAuthority;
  revision?: string;
  /** Explicitly remains an address proposal; callers must not promote it. */
  addressOnly: true;
  distance?: number;
}

export interface RejectedSemanticHit {
  accepted: false;
  hit: unknown;
  reason: SemanticHitRejection;
  seq?: Seq;
  byteRange?: [number, number];
}

export type SemanticHitVerification = VerifiedSemanticHit | RejectedSemanticHit;

export interface VerifySemanticHitsOptions {
  /** Cap model/index proposals before they consume a page budget. */
  maxHits?: number;
  /** Do not let a single proposed span allocate an unbounded buffer. */
  maxBytes?: number;
}

export interface VerifySemanticHitsResult {
  accepted: VerifiedSemanticHit[];
  rejected: RejectedSemanticHit[];
}

const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });
const ENCODER = new TextEncoder();

function nonNegativeCount(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validSeq(value: unknown): value is Seq {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    Number.isSafeInteger(value[1]) &&
    value[0] >= 0 &&
    value[1] > value[0]
  );
}

function authorityOf(role: Role | undefined): EvidenceAuthority {
  if (role === "user") return "user";
  if (role === "tool") return "tool";
  if (role === "attachment") return "attachment";
  // A semantic page preserves this non-authoritative role.  The return type
  // has no “system” authority, so assistant is the conservative label.
  return "assistant";
}

function malformed(hit: unknown, reason: SemanticHitRejection, seq?: Seq): RejectedSemanticHit {
  return { accepted: false, hit, reason, ...(seq === undefined ? {} : { seq }) };
}

/** Validate one untrusted semantic address against one current source. */
export function verifySemanticHit(
  hit: unknown,
  source: SemanticSource | null | undefined,
  options: VerifySemanticHitsOptions = {},
): SemanticHitVerification {
  if (typeof hit !== "object" || hit === null) return malformed(hit, "malformed-hit");
  const candidate = hit as Partial<SemanticHit>;
  if (!validSeq(candidate.seq)) return malformed(hit, "malformed-hit");
  const seq = candidate.seq;
  if (source === null || source === undefined) return malformed(hit, "missing-source", seq);
  if (source.seq !== seq) return malformed(hit, "sequence-mismatch", seq);
  if (source.removed === true) return malformed(hit, "deleted-source", seq);
  if (typeof source.content !== "string") return malformed(hit, "missing-source", seq);

  const range = candidate.byteRange ?? candidate.span;
  if (!validRange(range)) return malformed(hit, "missing-range", seq);
  const [from, to] = range;
  const bytes = ENCODER.encode(source.content);
  if (to > bytes.byteLength) return { ...malformed(hit, "range-out-of-bounds", seq), byteRange: range };
  if (options.maxBytes !== undefined && to - from > options.maxBytes) {
    return { ...malformed(hit, "range-out-of-bounds", seq), byteRange: range };
  }

  const sourceHash = sha256(bytes);
  if (source.contentHash !== undefined && source.contentHash !== sourceHash) {
    return { ...malformed(hit, "source-hash-mismatch", seq), byteRange: range };
  }
  const expectedContentHash = candidate.contentHash ?? candidate.sourceHash;
  if (expectedContentHash !== undefined && expectedContentHash !== sourceHash) {
    return { ...malformed(hit, "source-hash-mismatch", seq), byteRange: range };
  }

  let text: string;
  try {
    // A fatal decoder rejects both continuation-byte cuts and malformed UTF-8;
    // no replacement character can cross the evidence boundary.
    text = FATAL_UTF8.decode(bytes.subarray(from, to));
  } catch {
    return { ...malformed(hit, "invalid-utf8", seq), byteRange: range };
  }
  const spanBytes = bytes.slice(from, to);
  const spanHash = sha256(spanBytes);
  const expectedSpanHash = candidate.spanHash ?? candidate.hash;
  if (expectedSpanHash === undefined) {
    // A whole-content `hash` is accepted only for a whole-content range.  A
    // partial address must carry its own span digest.
    if (candidate.hash !== sourceHash || from !== 0 || to !== bytes.byteLength) {
      return { ...malformed(hit, "missing-hash", seq), byteRange: range };
    }
  } else if (expectedSpanHash !== spanHash) {
    // A legacy `hash` may denote the whole source, but never for a partial
    // range. Explicit `spanHash` is always interpreted as a span digest.
    if (
      !(
        candidate.spanHash === undefined &&
        candidate.hash === sourceHash &&
        from === 0 &&
        to === bytes.byteLength
      )
    ) {
      return { ...malformed(hit, "span-hash-mismatch", seq), byteRange: range };
    }
  }
  if (candidate.revision !== undefined && candidate.revision !== source.revision) {
    return { ...malformed(hit, "revision-mismatch", seq), byteRange: range };
  }
  if (candidate.distance !== undefined && !Number.isFinite(candidate.distance)) {
    return { ...malformed(hit, "malformed-hit", seq), byteRange: range };
  }

  return {
    accepted: true,
    seq,
    byteRange: [from, to],
    sourceHash,
    spanHash,
    text,
    bytes: spanBytes,
    ...(source.role === undefined ? {} : { role: source.role }),
    authority: authorityOf(source.role),
    ...(source.revision === undefined ? {} : { revision: source.revision }),
    addressOnly: true,
    ...(candidate.distance === undefined ? {} : { distance: candidate.distance }),
  };
}

/**
 * Validate a bounded list of model/index proposals.  Rejected proposals are
 * retained as receipts so a false address is observable; only `accepted`
 * entries may be handed to an exact pager by the orchestrator.
 */
export function verifySemanticHits(
  hits: readonly unknown[],
  lookup: (seq: Seq) => SemanticSource | null | undefined,
  options: VerifySemanticHitsOptions = {},
): VerifySemanticHitsResult {
  const maxHits = options.maxHits === undefined ? 32 : Math.max(0, Math.floor(options.maxHits));
  const accepted: VerifiedSemanticHit[] = [];
  const rejected: RejectedSemanticHit[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(hits)) return { accepted, rejected: [malformed(hits, "malformed-hit")] };
  for (const hit of hits.slice(0, maxHits)) {
    const seq = typeof hit === "object" && hit !== null ? (hit as { seq?: unknown }).seq : undefined;
    const range =
      typeof hit === "object" && hit !== null
        ? ((hit as { byteRange?: unknown; span?: unknown }).byteRange ?? (hit as { span?: unknown }).span)
        : undefined;
    const digest =
      typeof hit === "object" && hit !== null
        ? JSON.stringify({
            spanHash: (hit as { spanHash?: unknown }).spanHash,
            hash: (hit as { hash?: unknown }).hash,
            contentHash: (hit as { contentHash?: unknown }).contentHash,
            sourceHash: (hit as { sourceHash?: unknown }).sourceHash,
            revision: (hit as { revision?: unknown }).revision,
          })
        : undefined;
    const key =
      validSeq(seq) && validRange(range)
        ? `${seq}:${range[0]}:${range[1]}:${typeof digest === "string" ? digest : ""}`
        : undefined;
    if (key !== undefined && seen.has(key)) continue;
    if (key !== undefined) seen.add(key);
    const result = verifySemanticHit(hit, validSeq(seq) ? lookup(seq) : undefined, options);
    if (result.accepted) accepted.push(result);
    else rejected.push(result);
  }
  return { accepted, rejected };
}

/** Convert a validated address into a packet page record without changing authority. */
export function semanticPageRecord(
  result: SemanticHitVerification,
  input: { tokens: number; latencyMs: number; query?: string },
): PageRecord {
  if (!result.accepted) {
    return {
      trigger: "semantic",
      // A rejected proposal is a receipt, not a served source.  Keeping its
      // sequence out of `seqs` prevents downstream callers from mistaking the
      // address suggestion for an exact page.
      seqs: [],
      ...(result.byteRange === undefined ? {} : { byteRange: result.byteRange }),
      ...(input.query === undefined ? {} : { query: input.query }),
      tokens: input.tokens,
      latencyMs: input.latencyMs,
      resolved: false,
    };
  }
  return {
    trigger: "semantic",
    ...(input.query === undefined ? {} : { query: input.query }),
    seqs: [result.seq],
    tokens: input.tokens,
    latencyMs: input.latencyMs,
    resolved: true,
    source: `episode:${result.seq}`,
    sourceHash: result.sourceHash,
    contentHash: result.sourceHash,
    spanHash: result.spanHash,
    byteRange: result.byteRange,
    revision: result.revision,
    authority: result.authority,
  };
}
