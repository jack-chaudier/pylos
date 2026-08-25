/**
 * Hash-bound question addresses (KERNEL A15.1) and model-proposed aliases
 * (KERNEL A15.2).
 *
 * This module deliberately contains no routing policy.  A caller may discover
 * a candidate route, but the only operation that writes an active route is
 * `recordAddressRoute`, which requires the caller to say that the answer was
 * released by the claim gate and then re-checks every witness against the
 * archive.  The model can therefore suggest an address, never turn it into a
 * fact.
 */

import type {
  AnswerReceipt,
  AttachmentManifest,
  ByteLocator,
  ClaimCandidate,
  EvidenceAuthority,
  EvidenceLocator,
  Seq,
} from "@pylos/protocol";
import {
  MAX_ADDRESS_ROUTE_ITEMS,
  MAX_ADDRESS_ROUTE_JSON_BYTES,
  MAX_ADDRESS_ROUTE_ROW_BYTES,
} from "@pylos/protocol";
import { manifestPartitionValid, readAttachmentRange } from "./attachment.ts";
import { answerReceiptDigestOf, claimScanDigestOf, scanRememberedClaims } from "./claim-gate.ts";
import { canonicalHash, newId, sha256 } from "./hash.ts";
import { canonicalJson } from "./pure/canonical.ts";
import { names } from "./pure/names.ts";
import { sequenceRefs } from "./pure/sequence.ts";
import { ftsTerms } from "./pure/terms.ts";
import type { Vault } from "./vault.ts";

export type AddressRouteStatus = "active" | "invalidated" | "superseded" | "revoked";
export type AddressInvalidationReason =
  | "source-deleted"
  | "source-tampered"
  | "source-revised"
  | "router-upgrade"
  | "route-replaced"
  | "invalid-witness";

/** The immutable source binding carried by an address edge. */
export interface AddressWitness {
  /** The episode that owns the bytes (or the attachment episode). */
  seq: Seq;
  /** The episode `content_hash`, or the attachment manifest whole-object hash. */
  contentHash: string;
  /** Byte-exact half-open range in the source. */
  byteRange: [number, number];
  /** A current atom/episode revision chosen by the kernel. */
  revision?: string;
  /** The source authority is checked against the archive role. */
  authority: EvidenceAuthority;
  /** Optional hash of the exact byte range. */
  spanHash?: string;
  /** `episode:<seq>` by default; `blob:<manifest hash>` for attachments. */
  source?: string;
  /** Attachment manifest id when the witness is an attachment span. */
  manifestId?: string;
}

export interface AddressRouteRecordInput {
  threadId: string;
  query: string;
  routerVersion: string;
  questionSeq: Seq;
  answerSeq?: Seq;
  packetId?: string;
  packetDigest?: string;
  witnesses: readonly AddressWitness[];
  /** A route is only writable after the answer gate has released it. */
  completed?: boolean;
  gateStatus?: "released" | "qualified";
  /** Alias accepted for callers that use the answer receipt's status field. */
  answerStatus?: "released" | "qualified";
}

/**
 * The only write authorization accepted by the tx-B address recorder.  The
 * receipt is checked against the committed packet and answer episodes before
 * witnesses are derived; a provider/caller supplied `completed` flag can never
 * mint an active edge.
 */
export interface AddressReceiptRouteRecordInput {
  threadId: string;
  query: string;
  routerVersion: string;
  questionSeq: Seq;
  answerSeq: Seq;
  packetId: string;
  packetDigest: string;
  receipt: AnswerReceipt;
}

export interface AddressRouteRow {
  id: string;
  threadId: string;
  queryDigest: string;
  normalizedQuery: string;
  routerVersion: string;
  questionSeq: Seq;
  answerSeq?: Seq;
  packetId?: string;
  packetDigest?: string;
  sourceSeqs: Seq[];
  witnesses: AddressWitness[];
  routeDigest: string;
  status: AddressRouteStatus;
  reason?: string;
  invalidatedBy?: string;
  createdAt: number;
}

/**
 * Current read projection of an append-only route row.
 *
 * `status` is deliberately the effective status for this projection, while
 * `storedStatus` preserves the immutable SQL value.  In particular, an
 * original row that was active when it was written remains `storedStatus:
 * "active"` but is never exposed as currently active after a closure event or
 * source tombstone.  `asOfSeq` makes the projection's temporal boundary
 * explicit and `closedBy` makes the reverse side of `invalidatedBy` explicit.
 */
export interface AddressRouteView extends AddressRouteRow {
  storedStatus: AddressRouteStatus;
  effectiveStatus: AddressRouteStatus;
  asOfSeq: Seq;
  closedBy?: string;
}

export interface AddressReuseResult {
  route: AddressRouteRow | null;
  reused: boolean;
  invalidated: AddressRouteRow[];
  reason?: string;
}

export interface AddressRevalidation {
  valid: boolean;
  route: AddressRouteRow;
  reason?: AddressInvalidationReason | string;
}

export interface AddressRouteWriteResult {
  accepted: boolean;
  route?: AddressRouteRow;
  invalidated: AddressRouteRow[];
  reason?: string;
}

export interface AddressAliasProposal {
  alias: string;
  sourceSeq: Seq;
  span: [number, number];
  /** Verbatim source bytes represented by `span`. */
  quote: string;
  sourceHash: string;
  /** Model is the only accepted authority for this namespace. */
  authority?: string;
}

export interface AddressAliasRow {
  id: string;
  threadId: string;
  alias: string;
  sourceSeq: Seq;
  byteFrom: number;
  byteTo: number;
  sourceHash: string;
  quoteHash: string;
  authority: "model";
  status: "proposed" | "revoked";
  createdAt: number;
}

export interface AddressAliasResult {
  accepted: boolean;
  alias?: string;
  id?: string;
  reason?: string;
}

export interface AddressAliasRevalidation {
  valid: boolean;
  alias: AddressAliasRow;
  reason?: string;
}

export interface AliasPresenceCheck {
  accepted: boolean;
  reason?: string;
  normalizedAlias?: string;
  sourceHash?: string;
  quoteHash?: string;
}

const AUTHORITIES = new Set<EvidenceAuthority>(["user", "tool", "attachment", "assistant", "model"]);
const CURRENT_AUTHORITIES = new Set<EvidenceAuthority>(["user", "tool", "attachment"]);
const ACTIVE: AddressRouteStatus = "active";
/**
 * A route lookup is a bounded page, not a history export.  Older immutable
 * rows remain available through the audit/list surfaces, while reuse only
 * considers this deterministic current-candidate window.
 */
const ADDRESS_ROUTE_CANDIDATE_LIMIT = 64;
/** Array-returning audit helpers fail closed above this page; bundle export is streaming. */
export const ADDRESS_ROUTE_LIST_LIMIT = 256;
/**
 * A receipt may inspect only a bounded atom frontier for one source.  If the
 * source has more derived rows than this window, the route fails closed rather
 * than choosing from a silent partial scan.  The extra row is fetched only to
 * detect overflow without a count over the whole atom history.
 */
const RECEIPT_ATOM_CANDIDATE_LIMIT = 512;
/** Ordinary alias reads are bounded; full history is available through bundle/audit iterators. */
export const ADDRESS_ALIAS_LIST_LIMIT = 512;
const ADDRESS_ALIAS_SQL_BOUNDS =
  "length(CAST(COALESCE(id, '') AS BLOB)) <= 160 AND " +
  "length(CAST(COALESCE(thread_id, '') AS BLOB)) <= 160 AND " +
  "length(CAST(COALESCE(alias, '') AS BLOB)) <= 160 AND " +
  "length(CAST(COALESCE(source_hash, '') AS BLOB)) <= 64 AND " +
  "length(CAST(COALESCE(quote_hash, '') AS BLOB)) <= 64 AND " +
  "length(CAST(COALESCE(authority, '') AS BLOB)) <= 5 AND " +
  "length(CAST(COALESCE(status, '') AS BLOB)) <= 8";
/** SQL-side payload predicate used by ordinary route projections. */
const ADDRESS_ROUTE_SQL_BOUNDS =
  `length(CAST(COALESCE(source_seqs, '') AS BLOB)) <= ${MAX_ADDRESS_ROUTE_JSON_BYTES} ` +
  `AND length(CAST(COALESCE(witnesses, '') AS BLOB)) <= ${MAX_ADDRESS_ROUTE_JSON_BYTES}`;
/** Version of the canonical query identity payload. */
export const ADDRESS_QUERY_DIGEST_VERSION = "a15.2";

/**
 * Canonical query identity. NFKC makes compatibility forms agree; collapsing
 * all Unicode whitespace before lower-casing makes ordinary spacing/case
 * changes one address while preserving every non-whitespace character.
 */
export function normalizeAddressQuery(query: string): string {
  if (typeof query !== "string") throw new TypeError("address query must be a string");
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  if (normalized.length === 0) throw new TypeError("address query must not be empty");
  return normalized;
}

export function canonicalAddressQuery(query: string): { normalized: string; digest: string } {
  const normalized = normalizeAddressQuery(query);
  // The digest binds the stable query text and the deterministic route
  // vocabulary.  Sequence references and FTS terms are derived by the kernel,
  // never accepted from model output; changing this payload requires a new
  // version so old persisted edges can be invalidated explicitly.
  const refs = sequenceRefs(normalized).map((reference) => [reference.from, reference.to]);
  const routeNames = names(normalized, { max: 128 }).map((hit) => ({ name: hit.name, kind: hit.kind }));
  const terms = ftsTerms(normalized);
  return {
    normalized,
    digest: sha256(
      canonicalJson({
        version: ADDRESS_QUERY_DIGEST_VERSION,
        text: normalized,
        sequenceRefs: refs,
        names: routeNames,
        ftsTerms: terms,
      }),
    ),
  };
}

export const addressQueryDigest = (query: string): string => canonicalAddressQuery(query).digest;

function rowValue(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (row[key] !== undefined) return row[key];
  return undefined;
}

/**
 * Estimate an already-decoded route row without serializing it.  The helper is
 * intentionally conservative: it returns over-budget as soon as the bounded
 * walk proves that the row cannot fit.  This lets import/read paths reject a
 * 16 MiB JSON field before `JSON.parse` is called on either witness array.
 */
function boundedRouteValueBytes(value: unknown, depth = 0): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (value === null || typeof value === "number" || typeof value === "boolean") return 8;
  if (depth > 4) return MAX_ADDRESS_ROUTE_ROW_BYTES + 1;
  if (Array.isArray(value)) {
    if (value.length > MAX_ADDRESS_ROUTE_ITEMS) return MAX_ADDRESS_ROUTE_ROW_BYTES + 1;
    let total = 2;
    for (const item of value) {
      total += boundedRouteValueBytes(item, depth + 1);
      if (total > MAX_ADDRESS_ROUTE_ROW_BYTES) return MAX_ADDRESS_ROUTE_ROW_BYTES + 1;
    }
    return total;
  }
  if (typeof value === "object") {
    let total = 2;
    let entries = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      entries += 1;
      if (entries > MAX_ADDRESS_ROUTE_ITEMS) return MAX_ADDRESS_ROUTE_ROW_BYTES + 1;
      total += Buffer.byteLength(key, "utf8") + boundedRouteValueBytes(item, depth + 1);
      if (total > MAX_ADDRESS_ROUTE_ROW_BYTES) return MAX_ADDRESS_ROUTE_ROW_BYTES + 1;
    }
    return total;
  }
  return MAX_ADDRESS_ROUTE_ROW_BYTES + 1;
}

/**
 * Cheap pre-parse boundary for imported/tampered rows.  It deliberately does
 * not call `JSON.parse`; callers can use it before commit, while `routeFromRow`
 * uses the same oracle before parsing rows read from SQLite.
 */
export function addressRouteRowBoundsFailure(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "address route row is not an object";
  }
  const raw = value as Record<string, unknown>;
  for (const [label, field] of [
    ["source sequence", rowValue(raw, "source_seqs", "sourceSeqs")],
    ["witness", rowValue(raw, "witnesses")],
  ] as const) {
    if (typeof field === "string" && Buffer.byteLength(field, "utf8") > MAX_ADDRESS_ROUTE_JSON_BYTES) {
      return `address route ${label} JSON exceeds bounded size`;
    }
    if (Array.isArray(field) && field.length > MAX_ADDRESS_ROUTE_ITEMS) {
      return `address route ${label} array exceeds bounded count`;
    }
    if (typeof field === "string") {
      try {
        const parsed: unknown = JSON.parse(field);
        if (!Array.isArray(parsed)) return `address route ${label} JSON is not an array`;
        if (parsed.length > MAX_ADDRESS_ROUTE_ITEMS) {
          return `address route ${label} JSON array exceeds bounded count`;
        }
      } catch {
        return `address route ${label} JSON is malformed`;
      }
    }
  }
  if (boundedRouteValueBytes(raw) > MAX_ADDRESS_ROUTE_ROW_BYTES) {
    return "address route JSON row exceeds bounded size";
  }
  return null;
}

function boundedJsonArray(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.length <= MAX_ADDRESS_ROUTE_ITEMS ? value : null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_ADDRESS_ROUTE_JSON_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length <= MAX_ADDRESS_ROUTE_ITEMS ? parsed : null;
  } catch {
    return null;
  }
}

function asSeqs(value: unknown): Seq[] {
  if (!Array.isArray(value)) return [];
  return value.filter((seq): seq is number => Number.isInteger(seq) && seq > 0);
}

function asRange(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const from = Number(value[0]);
  const to = Number(value[1]);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  return [from, to];
}

function parseWitness(value: unknown): AddressWitness | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const seq = Number(rowValue(raw, "seq", "sourceSeq", "source_seq"));
  const contentHash = rowValue(raw, "contentHash", "content_hash", "sourceHash", "source_hash");
  const byteRange = asRange(rowValue(raw, "byteRange", "byte_range", "span"));
  const authority = rowValue(raw, "authority");
  if (!Number.isInteger(seq) || seq <= 0 || typeof contentHash !== "string" || byteRange === null)
    return null;
  if (typeof authority !== "string" || !AUTHORITIES.has(authority as EvidenceAuthority)) return null;
  const revision = rowValue(raw, "revision");
  const spanHash = rowValue(raw, "spanHash", "span_hash");
  const source = rowValue(raw, "source");
  const manifestId = rowValue(raw, "manifestId", "manifest_id", "manifest");
  for (const [, field] of [
    ["content hash", contentHash],
    ["revision", revision],
    ["span hash", spanHash],
    ["source", source],
    ["manifest id", manifestId],
  ] as const) {
    if (typeof field === "string" && Buffer.byteLength(field, "utf8") > MAX_ADDRESS_ROUTE_JSON_BYTES) {
      return null;
    }
  }
  return {
    seq,
    contentHash,
    byteRange,
    authority: authority as EvidenceAuthority,
    ...(typeof revision === "string" ? { revision } : {}),
    ...(typeof spanHash === "string" ? { spanHash } : {}),
    ...(typeof source === "string" ? { source } : {}),
    ...(typeof manifestId === "string" ? { manifestId } : {}),
  };
}

/** Read-only witness parser used by bounded integrity checks. */
export function parseAddressWitness(value: unknown): AddressWitness | null {
  return parseWitness(value);
}

function routeFromRow(raw: Record<string, unknown>): AddressRouteRow | null {
  if (addressRouteRowBoundsFailure(raw) !== null) return null;
  const id = rowValue(raw, "id");
  const threadId = rowValue(raw, "thread_id", "threadId");
  const queryDigest = rowValue(raw, "query_digest", "queryDigest", "digest");
  const normalizedQuery = rowValue(raw, "normalized_query", "normalizedQuery");
  const routerVersion = rowValue(raw, "router_version", "routerVersion");
  const questionSeq = Number(rowValue(raw, "question_seq", "questionSeq"));
  const routeDigest = rowValue(raw, "route_digest", "routeDigest");
  const status = String(rowValue(raw, "status", "state", "validity") ?? "active") as AddressRouteStatus;
  if (
    typeof id !== "string" ||
    typeof threadId !== "string" ||
    typeof queryDigest !== "string" ||
    typeof normalizedQuery !== "string" ||
    typeof routerVersion !== "string" ||
    !Number.isInteger(questionSeq) ||
    typeof routeDigest !== "string" ||
    !["active", "invalidated", "superseded", "revoked"].includes(status)
  ) {
    return null;
  }
  const parsedWitnesses = boundedJsonArray(rowValue(raw, "witnesses"));
  if (parsedWitnesses === null) return null;
  const witnesses = parsedWitnesses.flatMap((entry) => {
    const witness = parseWitness(entry);
    return witness === null ? [] : [witness];
  });
  const rawSourceSeqs = boundedJsonArray(rowValue(raw, "source_seqs", "sourceSeqs"));
  if (rawSourceSeqs === null) return null;
  const sourceSeqs = asSeqs(rawSourceSeqs);
  const answerSeq = Number(rowValue(raw, "answer_seq", "answerSeq"));
  const createdAt = Number(rowValue(raw, "created_at", "createdAt"));
  const packetId = rowValue(raw, "packet_id", "packetId");
  const packetDigest = rowValue(raw, "packet_digest", "packetDigest");
  const reason = rowValue(raw, "reason");
  const invalidatedBy = rowValue(raw, "invalidated_by", "invalidatedBy");
  return {
    id,
    threadId,
    queryDigest,
    normalizedQuery,
    routerVersion,
    questionSeq,
    ...(Number.isInteger(answerSeq) && answerSeq > 0 ? { answerSeq } : {}),
    ...(typeof packetId === "string" ? { packetId } : {}),
    ...(typeof packetDigest === "string" ? { packetDigest } : {}),
    sourceSeqs: sourceSeqs.length > 0 ? sourceSeqs : witnesses.map((witness) => witness.seq),
    witnesses,
    routeDigest,
    status,
    ...(typeof reason === "string" ? { reason } : {}),
    ...(typeof invalidatedBy === "string" ? { invalidatedBy } : {}),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  };
}

/** Parse one raw route row without listing the unbounded route table. */
export function parseAddressRouteRow(raw: Record<string, unknown>): AddressRouteRow | null {
  return routeFromRow(raw);
}

function aliasFromRow(raw: Record<string, unknown>): AddressAliasRow | null {
  const id = rowValue(raw, "id");
  const threadId = rowValue(raw, "thread_id", "threadId");
  const alias = rowValue(raw, "alias");
  const sourceSeq = Number(rowValue(raw, "source_seq", "sourceSeq"));
  const byteFrom = Number(rowValue(raw, "byte_from", "byteFrom"));
  const byteTo = Number(rowValue(raw, "byte_to", "byteTo"));
  const sourceHash = rowValue(raw, "source_hash", "sourceHash");
  const quoteHash = rowValue(raw, "quote_hash", "quoteHash");
  const authority = rowValue(raw, "authority");
  const status = String(rowValue(raw, "status") ?? "proposed");
  const createdAt = Number(rowValue(raw, "created_at", "createdAt"));
  if (
    typeof id !== "string" ||
    typeof threadId !== "string" ||
    typeof alias !== "string" ||
    !Number.isInteger(sourceSeq) ||
    !Number.isInteger(byteFrom) ||
    !Number.isInteger(byteTo) ||
    typeof sourceHash !== "string" ||
    typeof quoteHash !== "string" ||
    authority !== "model" ||
    id.length === 0 ||
    threadId.length === 0 ||
    alias.length === 0 ||
    new TextEncoder().encode(id).byteLength > 160 ||
    new TextEncoder().encode(threadId).byteLength > 160 ||
    new TextEncoder().encode(alias).byteLength > 160 ||
    !/^[0-9a-f]{64}$/.test(sourceHash) ||
    !/^[0-9a-f]{64}$/.test(quoteHash) ||
    !Number.isSafeInteger(sourceSeq) ||
    sourceSeq <= 0 ||
    !Number.isSafeInteger(byteFrom) ||
    byteFrom < 0 ||
    !Number.isSafeInteger(byteTo) ||
    byteTo <= byteFrom ||
    byteTo - byteFrom > 64 * 1024 ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0 ||
    (status !== "proposed" && status !== "revoked")
  ) {
    return null;
  }
  return {
    id,
    threadId,
    alias,
    sourceSeq,
    byteFrom,
    byteTo,
    sourceHash,
    quoteHash,
    authority: "model",
    status,
    createdAt,
  };
}

/** Parse one raw alias row without listing the unbounded alias table. */
export function parseAddressAliasRow(raw: Record<string, unknown>): AddressAliasRow | null {
  return aliasFromRow(raw);
}

function roleAuthority(role: string): EvidenceAuthority {
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  if (role === "attachment") return "attachment";
  if (role === "system" || role === "handoff") return "model";
  return "user";
}

export interface AddressSourceSnapshot {
  content: string;
  contentHash: string;
  chainHash: string;
  role: string;
  meta: Record<string, unknown>;
}

/**
 * Bounded source state shared by the integrity route and alias passes.
 *
 * Address verification is deliberately fail-closed when one source would make
 * the replay budget exceed its fixed limits.  The cache is a small LRU scoped
 * to one verify call, so an archive with many distinct sources remains
 * verifiable without retaining the archive in JavaScript memory.
 */
export interface AddressSourceReplayCache {
  sources: Map<string, AddressSourceSnapshot | null>;
  verifiedTextHashes: Set<string>;
  bytes: number;
  workBytes: number;
  sourceReads: number;
  maxBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
  maxWorkBytes: number;
  maxReads: number;
  sourceBytes: Map<string, number>;
  failure?: string;
}

const ADDRESS_SOURCE_REPLAY_MAX_BYTES = 32 * 1024 * 1024;
const ADDRESS_SOURCE_REPLAY_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const ADDRESS_SOURCE_REPLAY_MAX_ENTRIES = 128;
const ADDRESS_SOURCE_REPLAY_MAX_WORK_BYTES = 256 * 1024 * 1024;
const ADDRESS_SOURCE_REPLAY_MAX_READS = 4096;

export function createAddressSourceReplayCache(
  options: Partial<
    Pick<AddressSourceReplayCache, "maxBytes" | "maxEntryBytes" | "maxEntries" | "maxWorkBytes" | "maxReads">
  > = {},
): AddressSourceReplayCache {
  return {
    sources: new Map(),
    verifiedTextHashes: new Set(),
    bytes: 0,
    workBytes: 0,
    sourceReads: 0,
    maxBytes: options.maxBytes ?? ADDRESS_SOURCE_REPLAY_MAX_BYTES,
    maxEntryBytes: options.maxEntryBytes ?? ADDRESS_SOURCE_REPLAY_MAX_ENTRY_BYTES,
    maxEntries: options.maxEntries ?? ADDRESS_SOURCE_REPLAY_MAX_ENTRIES,
    maxWorkBytes: options.maxWorkBytes ?? ADDRESS_SOURCE_REPLAY_MAX_WORK_BYTES,
    maxReads: options.maxReads ?? ADDRESS_SOURCE_REPLAY_MAX_READS,
    sourceBytes: new Map(),
  };
}

function sourceCacheKey(threadId: string, seq: Seq): string {
  return `${threadId.length}:${threadId}:${seq}`;
}

function touchSourceCache(cache: AddressSourceReplayCache, key: string): void {
  const value = cache.sources.get(key);
  if (value === undefined && !cache.sources.has(key)) return;
  cache.sources.delete(key);
  cache.sources.set(key, value ?? null);
}

function evictSourceCache(cache: AddressSourceReplayCache): void {
  while (cache.sources.size > cache.maxEntries || cache.bytes > cache.maxBytes) {
    if (!evictOldestSourceCache(cache)) break;
  }
}

function evictOldestSourceCache(cache: AddressSourceReplayCache): boolean {
  const oldest = cache.sources.keys().next().value as string | undefined;
  if (oldest === undefined) return false;
  cache.sources.delete(oldest);
  cache.verifiedTextHashes.delete(oldest);
  cache.bytes -= cache.sourceBytes.get(oldest) ?? 0;
  cache.sourceBytes.delete(oldest);
  return true;
}

function sourceAt(
  vault: Vault,
  threadId: string,
  seq: Seq,
  cache?: AddressSourceReplayCache,
): AddressSourceSnapshot | null {
  const key = cache === undefined ? undefined : sourceCacheKey(threadId, seq);
  if (cache !== undefined && key !== undefined && cache.sources.has(key)) {
    touchSourceCache(cache, key);
    return cache.sources.get(key) ?? null;
  }
  let admittedBytes = 0;
  if (cache !== undefined && key !== undefined) {
    const size = vault.db
      .query(
        "SELECT length(CAST(content AS BLOB)) AS content_bytes, " +
          "length(CAST(meta AS BLOB)) AS meta_bytes " +
          "FROM episode WHERE thread_id = ? AND seq = ?",
      )
      .get(threadId, seq) as { content_bytes?: unknown; meta_bytes?: unknown } | null;
    if (size === null) {
      cache.sources.set(key, null);
      return null;
    }
    const contentBytes = Number(size.content_bytes ?? 0);
    const metaBytes = Number(size.meta_bytes ?? 0);
    admittedBytes = contentBytes + metaBytes;
    if (
      !Number.isSafeInteger(contentBytes) ||
      !Number.isSafeInteger(metaBytes) ||
      !Number.isSafeInteger(admittedBytes) ||
      contentBytes < 0 ||
      metaBytes < 0 ||
      admittedBytes > cache.maxEntryBytes ||
      admittedBytes > cache.maxBytes ||
      cache.sourceReads >= cache.maxReads ||
      admittedBytes > cache.maxWorkBytes - cache.workBytes
    ) {
      cache.failure ??= "address source replay exceeded bounded work";
      cache.sources.set(key, null);
      return null;
    }
    while (
      (cache.sources.size >= cache.maxEntries || cache.bytes + admittedBytes > cache.maxBytes) &&
      cache.sources.size > 0
    ) {
      if (!evictOldestSourceCache(cache)) break;
    }
  }
  const row = vault.db
    .query("SELECT content, content_hash, hash, role, meta FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, seq) as Record<string, unknown> | null;
  if (row === null) {
    if (cache !== undefined && key !== undefined) cache.sources.set(key, null);
    return null;
  }
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.meta ?? "{}"));
    if (parsed !== null && typeof parsed === "object") meta = parsed as Record<string, unknown>;
  } catch {
    if (cache !== undefined && key !== undefined) cache.sources.set(key, null);
    return null;
  }
  const source: AddressSourceSnapshot = {
    content: String(row.content ?? ""),
    contentHash: String(row.content_hash ?? sha256(String(row.content ?? ""))),
    chainHash: String(row.hash ?? ""),
    role: String(row.role ?? "user"),
    meta,
  };
  if (cache !== undefined && key !== undefined) {
    cache.sourceReads += 1;
    cache.workBytes += admittedBytes;
    cache.bytes += admittedBytes;
    cache.sources.set(key, source);
    cache.sourceBytes.set(key, admittedBytes);
    evictSourceCache(cache);
    // Text witnesses and aliases both need a whole-source hash check.  Do it
    // once per source, then all subsequent checks use bounded range bytes.
    if (source.role !== "attachment") {
      if (sha256(source.content) !== source.contentHash) {
        cache.failure ??= "address source hash changed";
      } else {
        cache.verifiedTextHashes.add(key);
      }
    }
  }
  return source;
}

/** Locate the deterministic attachment episode that owns a whole-object hash. */
function sourceForBlob(
  vault: Vault,
  threadId: string,
  blobHash: string,
  expectedSeq?: Seq,
): { seq: Seq; source: AddressSourceSnapshot } | null {
  if (!/^[0-9a-f]{64}$/u.test(blobHash)) return null;
  if (expectedSeq !== undefined) {
    if (!Number.isSafeInteger(expectedSeq) || expectedSeq <= 0) return null;
    const source = sourceAt(vault, threadId, expectedSeq);
    if (source === null || source.role !== "attachment" || source.meta.removed === true) return null;
    const manifest = source.meta.manifest;
    const declaredManifestHash =
      manifest !== null &&
      typeof manifest === "object" &&
      typeof (manifest as Record<string, unknown>).hash === "string"
        ? ((manifest as Record<string, unknown>).hash as string)
        : undefined;
    const declaredBlob = typeof source.meta.blob === "string" ? source.meta.blob : undefined;
    return declaredManifestHash === blobHash || declaredBlob === blobHash
      ? { seq: expectedSeq, source }
      : null;
  }
  let cursor = 0;
  const query = vault.db.query(
    "SELECT seq FROM episode WHERE thread_id = ? AND role = 'attachment' AND seq > ? " +
      "ORDER BY seq ASC LIMIT 256",
  );
  for (;;) {
    const rows = query.all(threadId, cursor) as Array<{ seq: number }>;
    if (rows.length === 0) return null;
    const lastSeq = rows.at(-1)?.seq;
    if (!Number.isSafeInteger(lastSeq) || (lastSeq as number) <= cursor) return null;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.seq) || row.seq <= cursor) continue;
      cursor = row.seq;
      const source = sourceAt(vault, threadId, row.seq);
      if (source === null || source.meta.removed === true) continue;
      const manifest = source.meta.manifest;
      const declaredManifestHash =
        manifest !== null &&
        typeof manifest === "object" &&
        typeof (manifest as Record<string, unknown>).hash === "string"
          ? ((manifest as Record<string, unknown>).hash as string)
          : undefined;
      const declaredBlob = typeof source.meta.blob === "string" ? source.meta.blob : undefined;
      if (declaredManifestHash !== blobHash && declaredBlob !== blobHash) continue;
      // The later witness/range verifier authenticates the manifest bytes.
      // This lookup only maps a declared whole-object digest to its episode;
      // loading the object here would defeat bounded address paging.
      return { seq: row.seq, source };
    }
    if (rows.length < 256) return null;
  }
}

function typedEvidenceLocator(value: ByteLocator): EvidenceLocator | null {
  const raw = value as unknown as Record<string, unknown>;
  if (
    typeof raw.hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.hash) ||
    !Number.isSafeInteger(raw.seq) ||
    (raw.seq as number) <= 0 ||
    typeof raw.revision !== "string" ||
    raw.revision.length === 0 ||
    typeof raw.spanHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.spanHash) ||
    raw.authority !== "attachment" ||
    typeof raw.manifestId !== "string" ||
    raw.manifestId.length === 0
  ) {
    return null;
  }
  return value as EvidenceLocator;
}

/**
 * Attachment address routes may name only a bounded range fully contained in
 * one indexed manifest span.  Opaque spans remain pageable custody receipts;
 * they are never decoded into a remembered fact route.  Check the manifest
 * partition and range before calling the reader so a malformed imported row
 * cannot make a large allocation in a helper.
 */
function indexedAttachmentRange(source: AddressSourceSnapshot, range: [number, number]): boolean {
  if (source.role !== "attachment") return false;
  const rawManifest = source.meta.manifest;
  if (rawManifest === null || typeof rawManifest !== "object") return false;
  const manifest = rawManifest as AttachmentManifest;
  if (!manifestPartitionValid(manifest) || source.meta.blob !== manifest.hash) return false;
  const [from, to] = range;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to > manifest.size ||
    to - from > 64 * 1024
  ) {
    return false;
  }
  return manifest.spans.some((span) => span.state === "indexed" && span.from <= from && to <= span.to);
}

/** Text-only helper; attachment bytes must go through readAttachmentRange. */
function textSourceBytes(source: AddressSourceSnapshot): Uint8Array {
  return new TextEncoder().encode(source.content);
}

interface AliasRangeRead {
  bytes: Uint8Array;
  sourceHash: string;
  manifestId?: string;
}

/** Copy one bounded UTF-8 range without materializing the entire episode. */
function textByteRange(content: string, range: [number, number]): Uint8Array | null {
  const [from, to] = range;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to - from > 64 * 1024
  ) {
    return null;
  }
  const selected = new Uint8Array(to - from);
  const encoder = new TextEncoder();
  let cursor = 0;
  let written = 0;
  for (const character of content) {
    const encoded = encoder.encode(character);
    const next = cursor + encoded.byteLength;
    if (next > from && cursor < to) {
      const start = Math.max(0, from - cursor);
      const end = Math.min(encoded.byteLength, to - cursor);
      selected.set(encoded.subarray(start, end), written);
      written += end - start;
    }
    cursor = next;
    if (cursor >= to) break;
  }
  return cursor >= to && written === selected.byteLength ? selected : null;
}

/**
 * Read only the bounded bytes an alias can quote. Attachment aliases use the
 * manifest reader, so the whole object is hash-checked by streaming spans and
 * only an indexed range is retained. Legacy/opaque attachment bytes are
 * custody-only and cannot become model-written aliases.
 */
function readAliasRange(
  vault: Vault,
  threadId: string,
  seq: Seq,
  source: AddressSourceSnapshot,
  range: [number, number],
  textHashVerified = false,
): AliasRangeRead | null {
  if (source.role === "attachment") {
    if (!indexedAttachmentRange(source, range)) return null;
    const read = readAttachmentRange(vault, threadId, seq, range);
    if (read === null || read.opaque) return null;
    return { bytes: read.bytes, sourceHash: read.manifest.hash, manifestId: read.manifest.id };
  }
  if (!textHashVerified && sha256(source.content) !== source.contentHash) return null;
  const bytes = textByteRange(source.content, range);
  return bytes === null ? null : { bytes, sourceHash: source.contentHash };
}

function sourceHasRevision(
  source: AddressSourceSnapshot,
  vault: Vault,
  threadId: string,
  seq: Seq,
  revision: string,
): boolean {
  if (revision === source.chainHash || revision === source.contentHash) return true;
  const manifest = source.meta.manifest;
  if (manifest !== null && typeof manifest === "object") {
    const record = manifest as Record<string, unknown>;
    if (revision === record.id || revision === record.digest) return true;
  }
  // Atom ids and valid-from sequence are useful revisions for current-memory
  // routes.  They are derived, but still checked against the exact source row.
  // Query by the indexed atom id or validity sequence instead of paging the
  // complete source history when an imported/stale revision is presented.
  if (revision.startsWith("seq:")) {
    const validFromSeq = Number(revision.slice("seq:".length));
    if (!Number.isSafeInteger(validFromSeq) || validFromSeq <= 0) return false;
    return (
      vault.db
        .query(
          "SELECT 1 FROM atom WHERE thread_id = ? AND source_seq = ? AND valid_from_seq = ? " +
            "AND phase = 'SUPPORTED' LIMIT 1",
        )
        .get(threadId, seq, validFromSeq) !== null
    );
  }
  return (
    vault.db
      .query(
        "SELECT 1 FROM atom WHERE thread_id = ? AND source_seq = ? AND id = ? " +
          "AND phase = 'SUPPORTED' LIMIT 1",
      )
      .get(threadId, seq, revision) !== null
  );
}

function witnessFailure(
  vault: Vault,
  threadId: string,
  witness: AddressWitness,
  sourceCache?: AddressSourceReplayCache,
): string | null {
  if (!AUTHORITIES.has(witness.authority)) return "invalid witness authority";
  const [from, to] = witness.byteRange;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    return "invalid witness byte range";
  }
  const source = sourceAt(vault, threadId, witness.seq, sourceCache);
  if (sourceCache?.failure !== undefined) return sourceCache.failure;
  if (source === null || source.meta.removed === true) return "source deleted";
  const expectedSource = witness.source ?? `episode:${witness.seq}`;
  if (!expectedSource.startsWith("episode:") && !expectedSource.startsWith("blob:")) {
    return "source hash changed";
  }
  if (expectedSource.startsWith("episode:") && expectedSource !== `episode:${witness.seq}`) {
    return "source hash changed";
  }
  // Attachment route witnesses must use the typed, episode-bound blob form.
  // A display-label episode locator, a whole-hash-only locator, an opaque
  // manifest span, or a duplicate same-hash episode is never current evidence.
  if (source.role === "attachment") {
    const typed = typedEvidenceLocator({
      source: expectedSource,
      from,
      to,
      hash: witness.contentHash,
      seq: witness.seq,
      revision: witness.revision,
      spanHash: witness.spanHash,
      authority: witness.authority,
      manifestId: witness.manifestId,
    } as EvidenceLocator);
    if (
      typed === null ||
      !expectedSource.startsWith("blob:") ||
      expectedSource !== `blob:${typed.hash}` ||
      typed.seq !== witness.seq ||
      typed.authority !== "attachment" ||
      typed.revision !== source.chainHash ||
      witness.authority !== "attachment" ||
      witness.manifestId === undefined ||
      witness.manifestId !== typed.manifestId ||
      witness.contentHash !== typed.hash ||
      !indexedAttachmentRange(source, [from, to])
    ) {
      return "source attachment witness is not typed current evidence";
    }
    const range = readAttachmentRange(vault, threadId, witness.seq, [from, to]);
    if (
      range === null ||
      range.opaque ||
      range.manifest.hash !== typed.hash ||
      range.manifest.id !== typed.manifestId ||
      typed.spanHash !== sha256(range.bytes) ||
      witness.spanHash !== typed.spanHash
    ) {
      return "source attachment span changed";
    }
    return null;
  }
  if (expectedSource.startsWith("blob:")) return "source hash changed";
  const manifest = source.meta.manifest;
  const manifestId =
    manifest !== null &&
    typeof manifest === "object" &&
    typeof (manifest as Record<string, unknown>).id === "string"
      ? ((manifest as Record<string, unknown>).id as string)
      : undefined;
  if (sourceCache !== undefined) {
    const key = sourceCacheKey(threadId, witness.seq);
    if (!sourceCache.verifiedTextHashes.has(key)) return "source hash changed";
    if (to - from > 64 * 1024) return "witness span exceeds bounded replay range";
    const spanBytes = textByteRange(source.content, [from, to]);
    if (spanBytes === null) return "witness range outside source";
    if (witness.manifestId !== undefined && witness.manifestId !== manifestId) {
      return "source revision changed";
    }
    if (witness.contentHash !== source.contentHash) return "source hash changed";
    if (witness.spanHash !== undefined && witness.spanHash !== sha256(spanBytes)) {
      return "witness span changed";
    }
    if (
      witness.revision !== undefined &&
      !sourceHasRevision(source, vault, threadId, witness.seq, witness.revision)
    ) {
      return "source revision changed";
    }
    if (witness.authority !== roleAuthority(source.role)) return "source authority changed";
    return null;
  }
  const bytesInfo = { bytes: new TextEncoder().encode(source.content), manifestId };
  if (
    witness.manifestId !== undefined &&
    witness.manifestId !== bytesInfo.manifestId &&
    witness.manifestId !== manifestId
  ) {
    return "source revision changed";
  }
  if (to > bytesInfo.bytes.byteLength) return "witness range outside source";
  // Text episodes bind their content_hash; attachment witnesses bind the
  // manifest whole-object hash.  Accepting the computed text digest also
  // allows old imported rows whose content_hash was not materialized.
  const computedHash = sha256(bytesInfo.bytes);
  const expectedHash = source.contentHash;
  if (expectedHash !== computedHash) return "source hash changed";
  if (witness.contentHash !== expectedHash) {
    return "source hash changed";
  }
  if (witness.spanHash !== undefined && witness.spanHash !== sha256(bytesInfo.bytes.slice(from, to))) {
    return "witness span changed";
  }
  if (
    witness.revision !== undefined &&
    !sourceHasRevision(source, vault, threadId, witness.seq, witness.revision)
  ) {
    return "source revision changed";
  }
  if (witness.authority !== roleAuthority(source.role)) return "source authority changed";
  return null;
}

/** Read-only witness oracle; route revalidation may write an event, this never does. */
export function addressWitnessFailure(
  vault: Vault,
  threadId: string,
  witness: AddressWitness,
  sourceCache?: AddressSourceReplayCache,
): string | null {
  return witnessFailure(vault, threadId, witness, sourceCache);
}

function normalizedWitnesses(
  vault: Vault,
  threadId: string,
  input: readonly AddressWitness[],
): AddressWitness[] {
  const out: AddressWitness[] = [];
  const seen = new Set<string>();
  for (const source of input) {
    const parsed = parseWitness(source);
    if (parsed === null) throw new TypeError("invalid address witness");
    if (parsed.revision === undefined) {
      const source = sourceAt(vault, threadId, parsed.seq);
      if (source !== null && source.chainHash.length > 0) parsed.revision = source.chainHash;
    }
    const key = canonicalJson(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

function routeDigest(
  queryDigest: string,
  routerVersion: string,
  witnesses: readonly AddressWitness[],
): string {
  return canonicalHash({ queryDigest, routerVersion, witnesses });
}

/** Canonical active-edge digest, shared with the bounded verifier (A15.1). */
export function addressRouteDigestOf(
  queryDigest: string,
  routerVersion: string,
  witnesses: readonly AddressWitness[],
): string {
  return routeDigest(queryDigest, routerVersion, witnesses);
}

/** Canonical digest of an append-only route invalidation event (A15.1). */
export function addressInvalidationDigestOf(input: {
  routeId: string;
  routeDigest: string;
  routerVersion: string;
  status: Exclude<AddressRouteStatus, "active">;
  reason: string;
  context?: string;
}): string {
  return canonicalHash({
    kind: "address-invalidation",
    invalidates: input.routeId,
    routeDigest: input.routeDigest,
    routerVersion: input.routerVersion,
    status: input.status,
    reason: input.reason,
    ...(input.context === undefined ? {} : { context: input.context }),
  });
}

function sqlRow(vault: Vault, id: string): AddressRouteRow | null {
  const raw = vault.db
    .query(`SELECT * FROM address_route WHERE id = ? AND ${ADDRESS_ROUTE_SQL_BOUNDS}`)
    .get(id) as Record<string, unknown> | null;
  return raw === null ? null : routeFromRow(raw);
}

/**
 * Exact-id current projection for server/demo resources.  The route id is an
 * address, not a reason to hydrate a thread's full append-only history; the
 * closure index and bounded witness checks establish effective state here.
 */
export function getAddressRoute(vault: Vault, threadId: string, routeId: string): AddressRouteView | null {
  const raw = vault.db
    .query(
      `SELECT * FROM address_route WHERE thread_id = ? AND id = ? AND ${ADDRESS_ROUTE_SQL_BOUNDS} LIMIT 1`,
    )
    .get(threadId, routeId) as Record<string, unknown> | null;
  if (raw === null) return null;
  const route = routeFromRow(raw);
  if (route === null) return null;
  const closure = route.status === ACTIVE ? closingEvent(vault, route) : null;
  return routeView(vault, route, route.status === ACTIVE ? { knownClosure: closure } : {});
}

function routeRows(vault: Vault, threadId: string, digest?: string): AddressRouteRow[] {
  const raw =
    digest === undefined
      ? (vault.db
          .query(
            `SELECT * FROM address_route WHERE thread_id = ? AND ${ADDRESS_ROUTE_SQL_BOUNDS} ` +
              `ORDER BY created_at, rowid LIMIT ${ADDRESS_ROUTE_LIST_LIMIT + 1}`,
          )
          .all(threadId) as Record<string, unknown>[])
      : (vault.db
          .query(
            `SELECT * FROM address_route WHERE thread_id = ? AND query_digest = ? AND ${ADDRESS_ROUTE_SQL_BOUNDS} ` +
              `ORDER BY created_at, rowid LIMIT ${ADDRESS_ROUTE_LIST_LIMIT + 1}`,
          )
          .all(threadId, digest) as Record<string, unknown>[]);
  if (raw.length > ADDRESS_ROUTE_LIST_LIMIT) {
    throw new RangeError("address route history exceeds bounded list page; use streaming export");
  }
  return raw.flatMap((row) => {
    const parsed = routeFromRow(row);
    return parsed === null ? [] : [parsed];
  });
}

/** Compatibility lookup for pre-versioned rows; current rows use the indexed digest path. */
function routeRowsByNormalized(vault: Vault, threadId: string, normalized: string): AddressRouteRow[] {
  const raw = vault.db
    .query(
      `SELECT * FROM address_route WHERE thread_id = ? AND normalized_query = ? AND ${ADDRESS_ROUTE_SQL_BOUNDS} ` +
        `ORDER BY created_at, rowid LIMIT ${ADDRESS_ROUTE_LIST_LIMIT + 1}`,
    )
    .all(threadId, normalized) as Record<string, unknown>[];
  if (raw.length > ADDRESS_ROUTE_LIST_LIMIT) {
    throw new RangeError("address route history exceeds bounded list page; use streaming export");
  }
  return raw.flatMap((row) => {
    const parsed = routeFromRow(row);
    return parsed === null ? [] : [parsed];
  });
}

/**
 * Read only currently open edges for a canonical address.  The append-only
 * route table deliberately retains every old edge and closure event, so a
 * history-shaped SELECT followed by JavaScript filtering would make reuse
 * O(history) and would issue one closure query per candidate.  The correlated
 * NOT EXISTS is the kernel's current-edge predicate; the deterministic LIMIT
 * is a safety boundary for duplicate/imported rows as well as memory.
 */
function currentRouteRows(
  vault: Vault,
  threadId: string,
  field: "query_digest" | "normalized_query",
  value: string,
): AddressRouteRow[] {
  const raw = vault.db
    .query(
      `SELECT route.* FROM address_route AS route
       WHERE route.thread_id = ?
         AND route.${field} = ?
         AND route.status = 'active'
         AND length(CAST(COALESCE(route.source_seqs, '') AS BLOB)) <= ${MAX_ADDRESS_ROUTE_JSON_BYTES}
         AND length(CAST(COALESCE(route.witnesses, '') AS BLOB)) <= ${MAX_ADDRESS_ROUTE_JSON_BYTES}
         AND NOT EXISTS (
           SELECT 1 FROM address_route AS closure
           WHERE closure.thread_id = route.thread_id
             AND closure.invalidated_by = route.id
             AND closure.status != 'active'
         )
       ORDER BY route.created_at ASC, route.rowid ASC
       LIMIT ${ADDRESS_ROUTE_CANDIDATE_LIMIT}`,
    )
    .all(threadId, value) as Record<string, unknown>[];
  return raw.flatMap((row) => {
    const parsed = routeFromRow(row);
    return parsed === null ? [] : [parsed];
  });
}

/**
 * Preserve the pre-versioned fallback rule without loading its history: if an
 * exact-digest row exists but all of its edges are closed, do not silently
 * switch to a different digest merely because it shares normalized text.
 */
function currentRouteCandidates(
  vault: Vault,
  threadId: string,
  canonical: { digest: string; normalized: string },
): AddressRouteRow[] {
  const exact = currentRouteRows(vault, threadId, "query_digest", canonical.digest);
  if (exact.length > 0) return exact;
  const exactHistory = vault.db
    .query("SELECT 1 FROM address_route WHERE thread_id = ? AND query_digest = ? LIMIT 1")
    .get(threadId, canonical.digest);
  if (exactHistory !== null) return [];
  return currentRouteRows(vault, threadId, "normalized_query", canonical.normalized);
}

/**
 * An active edge is effective only until a later non-active event names its id
 * in `invalidated_by`.  The original row remains immutable for audit/export;
 * callers must use this relation instead of treating `status='active'` alone
 * as proof that an edge is still live.
 */
function isEffectiveActive(vault: Vault, route: AddressRouteRow): boolean {
  if (route.status !== ACTIVE) return false;
  return closingEvent(vault, route) === null && !hasTombstonedSource(vault, route);
}

/** Current rows returned by `currentRouteRows` already passed the closure
 * predicate in SQLite.  Keep the source-tombstone check kernel-side, but do
 * not repeat the correlated closure query for every candidate. */
function isCurrentActive(vault: Vault, route: AddressRouteRow): boolean {
  return route.status === ACTIVE && !hasTombstonedSource(vault, route);
}

/** A stored active row can receive one closure event even when its source is
 * already tombstoned.  Forget must preserve that append-only lineage rather
 * than letting the read-time fail-closed check suppress the receipt. */
function isStoredOpen(vault: Vault, route: AddressRouteRow): boolean {
  return route.status === ACTIVE && closingEvent(vault, route) === null;
}

function effectiveActiveRows<T extends AddressRouteRow>(routes: readonly T[], vault: Vault): T[] {
  return routes.filter((route) => isEffectiveActive(vault, route));
}

function currentActiveRows<T extends AddressRouteRow>(routes: readonly T[], vault: Vault): T[] {
  return routes.filter((route) => isCurrentActive(vault, route));
}

/**
 * Return the first append-only event that closes an original active row.
 * Event rows point back to the row they close through `invalidated_by`; the
 * original row is not mutated, so this lookup is the source of current
 * lineage for public projections.
 */
function closingEvent(vault: Vault, route: AddressRouteRow): AddressRouteRow | null {
  if (route.status !== ACTIVE) return null;
  const raw = vault.db
    .query(
      `SELECT * FROM address_route WHERE thread_id = ? AND invalidated_by = ? AND ${ADDRESS_ROUTE_SQL_BOUNDS} ` +
        "AND status != 'active' ORDER BY rowid ASC LIMIT 1",
    )
    .get(route.threadId, route.id) as Record<string, unknown> | null;
  return raw === null ? null : routeFromRow(raw);
}

/**
 * A tombstone is a current source failure even if an imported/legacy archive
 * predates the append-only closure event.  This check intentionally inspects
 * only source residency metadata (not model output or a caller status flag),
 * and keeps the public projection fail-closed without mutating history.
 */
function hasTombstonedSource(vault: Vault, route: AddressRouteRow): boolean {
  for (const witness of route.witnesses) {
    const source = sourceAt(vault, route.threadId, witness.seq);
    if (source === null || source.meta.removed === true) return true;
  }
  return false;
}

function routeView(
  vault: Vault,
  route: AddressRouteRow,
  options: { knownClosure?: AddressRouteRow | null } = {},
): AddressRouteView {
  const storedStatus = route.status;
  const closure =
    storedStatus === ACTIVE
      ? options.knownClosure === undefined
        ? closingEvent(vault, route)
        : options.knownClosure
      : null;
  const tombstoned = storedStatus === ACTIVE && closure === null && hasTombstonedSource(vault, route);
  const effectiveStatus =
    storedStatus !== ACTIVE
      ? storedStatus
      : (closure?.status ?? (tombstoned ? ("invalidated" as const) : ("active" as const)));
  const effectiveReason = route.reason ?? closure?.reason ?? (tombstoned ? "source deleted" : undefined);
  const asOfSeq = vault.threads.get(route.threadId)?.headSeq ?? route.questionSeq;
  return {
    ...route,
    status: effectiveStatus,
    storedStatus,
    effectiveStatus,
    asOfSeq,
    ...(closure === null ? {} : { closedBy: closure.id }),
    ...(effectiveReason === undefined ? {} : { reason: effectiveReason }),
  };
}

function invalidateRow(
  vault: Vault,
  route: AddressRouteRow,
  status: Exclude<AddressRouteStatus, "active">,
  reason: string,
  _invalidatedBy?: string,
  eventRouterVersion?: string,
  options: { knownOpen?: boolean } = {},
): AddressRouteRow {
  // A route row is immutable.  Invalidation is a new row carrying the exact
  // old edge and a separately bound digest; `invalidated_by` points back to
  // the edge being closed, not to a mutable cache or model proposal.
  if (!options.knownOpen && !isStoredOpen(vault, route)) return route;
  const eventId = newId("addr");
  const eventDigest = addressInvalidationDigestOf({
    routeId: route.id,
    routeDigest: route.routeDigest,
    routerVersion: eventRouterVersion ?? route.routerVersion,
    status,
    reason,
  });
  vault.db
    .query(
      "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      eventId,
      route.threadId,
      route.queryDigest,
      route.normalizedQuery,
      eventRouterVersion ?? route.routerVersion,
      route.questionSeq,
      route.answerSeq ?? null,
      route.packetId ?? null,
      route.packetDigest ?? null,
      canonicalJson(route.sourceSeqs),
      canonicalJson(route.witnesses),
      eventDigest,
      status,
      reason,
      route.id,
      Date.now(),
    );
  return (
    sqlRow(vault, eventId) ?? {
      ...route,
      id: eventId,
      routerVersion: eventRouterVersion ?? route.routerVersion,
      routeDigest: eventDigest,
      status,
      reason,
      invalidatedBy: route.id,
      createdAt: Date.now(),
    }
  );
}

/** Revalidate one active route against current bytes, authority, and revision. */
function revalidateAddressRouteInternal(
  vault: Vault,
  route: AddressRouteRow,
  options: { routerVersion?: string; invalidatedBy?: string } = {},
  closureChecked = false,
): AddressRevalidation {
  if (route.status !== ACTIVE) return { valid: false, route, reason: route.reason ?? "route inactive" };
  if (closureChecked ? !isCurrentActive(vault, route) : !isEffectiveActive(vault, route)) {
    return { valid: false, route, reason: "route invalidated" };
  }
  if (route.sourceSeqs.length === 0 || route.witnesses.length !== route.sourceSeqs.length) {
    const invalidated = invalidateRow(
      vault,
      route,
      "invalidated",
      "invalid witness record",
      options.invalidatedBy,
      undefined,
      { knownOpen: closureChecked },
    );
    return { valid: false, route: invalidated, reason: "invalid witness record" };
  }
  if (options.routerVersion !== undefined && options.routerVersion !== route.routerVersion) {
    const invalidated = invalidateRow(
      vault,
      route,
      "superseded",
      `router upgrade: ${route.routerVersion} -> ${options.routerVersion}`,
      options.invalidatedBy,
      options.routerVersion,
      { knownOpen: closureChecked },
    );
    return { valid: false, route: invalidated, reason: "router upgrade" };
  }
  for (const witness of route.witnesses) {
    const failure = witnessFailure(vault, route.threadId, witness);
    if (failure === null) continue;
    const reason = /deleted/i.test(failure)
      ? "source deleted"
      : /authority/i.test(failure)
        ? "source authority changed"
        : /revision/i.test(failure)
          ? "source revision changed"
          : /span|attachment|typed|opaque|indexed/i.test(failure)
            ? "source span changed"
            : "source hash changed";
    const invalidated = invalidateRow(vault, route, "invalidated", reason, options.invalidatedBy, undefined, {
      knownOpen: closureChecked,
    });
    return { valid: false, route: invalidated, reason };
  }
  return { valid: true, route };
}

/** Public callers must recompute closure state; only the SQL current-candidate
 * reader may use the private closure-checked fast path below. */
export function revalidateAddressRoute(
  vault: Vault,
  route: AddressRouteRow,
  options: { routerVersion?: string; invalidatedBy?: string } = {},
): AddressRevalidation {
  return revalidateAddressRouteInternal(vault, route, options, false);
}

/**
 * Reuse the exact active route for a canonical query.  Mutable lexical hits
 * are intentionally not consulted when this succeeds.
 */
function reuseAddressRouteInTransaction(
  vault: Vault,
  threadId: string,
  query: string,
  routerVersion: string,
  invalidatedBy?: string,
): AddressReuseResult {
  const canonical = canonicalAddressQuery(query);
  const invalidated: AddressRouteRow[] = [];
  // Read by digest first, then by normalized text for imported pre-versioned
  // rows.  The latter are deliberately not reusable: the versioned canonical
  // payload must produce an explicit supersession event rather than silently
  // turning an old identity into a current one.
  const candidates = currentActiveRows(currentRouteCandidates(vault, threadId, canonical), vault);
  let reusable: AddressRouteRow | null = null;
  for (const candidate of candidates) {
    if (candidate.queryDigest !== canonical.digest) {
      invalidated.push(
        invalidateRow(
          vault,
          candidate,
          "superseded",
          "query digest version upgrade",
          undefined,
          routerVersion,
          { knownOpen: true },
        ),
      );
      continue;
    }
    const check = revalidateAddressRouteInternal(
      vault,
      candidate,
      {
        routerVersion,
        invalidatedBy,
      },
      true,
    );
    if (!check.valid) {
      invalidated.push(check.route);
      continue;
    }
    if (reusable === null) reusable = check.route;
    else {
      // A pre-existing duplicate is made explicit rather than creating another
      // route.  Keep the oldest edge as the deterministic one.
      invalidated.push(
        invalidateRow(vault, check.route, "superseded", "duplicate active route", reusable.id, undefined, {
          knownOpen: true,
        }),
      );
    }
  }
  return {
    route: reusable,
    reused: reusable !== null,
    invalidated,
    ...(reusable === null && invalidated.length > 0 ? { reason: invalidated.at(-1)?.reason } : {}),
  };
}

/** Reuse or invalidate all active candidates atomically. */
export function reuseAddressRoute(
  vault: Vault,
  threadId: string,
  query: string,
  routerVersion: string,
  invalidatedBy?: string,
): AddressReuseResult {
  return vault.tx(() => reuseAddressRouteInTransaction(vault, threadId, query, routerVersion, invalidatedBy));
}

const RECEIPT_AUTHORIZATION = Symbol("pylos kernel answer receipt");

/** Record an active route only after a successful claim-gate release. */
function recordAddressRouteInTransaction(
  vault: Vault,
  input: AddressRouteRecordInput,
  authorization?: symbol,
): AddressRouteWriteResult {
  // Keep the legacy shape parseable for imported callers, but do not let any
  // public boolean/status field authorize persistence.  Only the receipt
  // verifier below owns this symbol.
  if (authorization !== RECEIPT_AUTHORIZATION) {
    return { accepted: false, invalidated: [], reason: "route requires a kernel answer receipt" };
  }
  if (!Number.isInteger(input.questionSeq) || input.questionSeq <= 0) {
    return { accepted: false, invalidated: [], reason: "invalid question sequence" };
  }
  const thread = vault.threads.get(input.threadId);
  if (thread === null) return { accepted: false, invalidated: [], reason: "thread not found" };
  if (
    input.questionSeq > thread.headSeq ||
    (input.answerSeq !== undefined && input.answerSeq > thread.headSeq)
  ) {
    return { accepted: false, invalidated: [], reason: "sequence is outside thread" };
  }
  if (typeof input.routerVersion !== "string" || input.routerVersion.trim().length === 0) {
    return { accepted: false, invalidated: [], reason: "router version is required" };
  }
  if (!Array.isArray(input.witnesses) || input.witnesses.length > MAX_ADDRESS_ROUTE_ITEMS) {
    return {
      accepted: false,
      invalidated: [],
      reason: "address route witness array exceeds bounded count",
    };
  }
  let canonical: { normalized: string; digest: string };
  let witnesses: AddressWitness[];
  try {
    canonical = canonicalAddressQuery(input.query);
    witnesses = normalizedWitnesses(vault, input.threadId, input.witnesses);
  } catch (error) {
    return {
      accepted: false,
      invalidated: [],
      reason: error instanceof Error ? error.message : "invalid route",
    };
  }
  if (witnesses.length === 0) return { accepted: false, invalidated: [], reason: "route needs a witness" };
  for (const witness of witnesses) {
    if (!CURRENT_AUTHORITIES.has(witness.authority)) {
      return { accepted: false, invalidated: [], reason: "route witness is not current authority" };
    }
    const failure = witnessFailure(vault, input.threadId, witness);
    if (failure !== null) return { accepted: false, invalidated: [], reason: failure };
  }
  const digest = routeDigest(canonical.digest, input.routerVersion, witnesses);
  const invalidated: AddressRouteRow[] = [];
  const existing = currentActiveRows(currentRouteCandidates(vault, input.threadId, canonical), vault);
  for (const route of existing) {
    if (route.queryDigest !== canonical.digest) {
      invalidated.push(
        invalidateRow(
          vault,
          route,
          "superseded",
          "query digest version upgrade",
          undefined,
          input.routerVersion,
          { knownOpen: true },
        ),
      );
      continue;
    }
    const check = revalidateAddressRouteInternal(
      vault,
      route,
      {
        routerVersion: input.routerVersion,
      },
      true,
    );
    if (!check.valid) {
      invalidated.push(check.route);
      continue;
    }
    if (route.routeDigest === digest) return { accepted: true, route: check.route, invalidated };
    invalidated.push(
      invalidateRow(vault, check.route, "invalidated", "route replaced", undefined, undefined, {
        knownOpen: true,
      }),
    );
  }
  const id = newId("addr");
  const createdAt = Date.now();
  vault.db
    .query(
      "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?)",
    )
    .run(
      id,
      input.threadId,
      canonical.digest,
      canonical.normalized,
      input.routerVersion,
      input.questionSeq,
      input.answerSeq ?? null,
      input.packetId ?? null,
      input.packetDigest ?? null,
      canonicalJson(witnesses.map((witness) => witness.seq)),
      canonicalJson(witnesses),
      digest,
      createdAt,
    );
  return { accepted: true, route: sqlRow(vault, id) ?? undefined, invalidated };
}

interface ReceiptAtomRow {
  id: string;
  key: string;
  value: string;
  text: string;
  source_span: string | null;
  phase: string;
  valid_from_seq: number;
  created_at: number;
  __rowid: number;
}

interface ParsedAtomSpan {
  chars: [number, number];
  bytes: [number, number];
}

function parsedAtomSpan(content: string, row: ReceiptAtomRow): ParsedAtomSpan | undefined {
  let span: unknown;
  if (row.source_span !== null) {
    try {
      span = JSON.parse(row.source_span);
    } catch {
      span = undefined;
    }
  }
  let fromChar: number;
  let toChar: number;
  if (
    Array.isArray(span) &&
    span.length === 2 &&
    Number.isSafeInteger(span[0]) &&
    Number.isSafeInteger(span[1]) &&
    (span[0] as number) >= 0 &&
    (span[1] as number) > (span[0] as number) &&
    (span[1] as number) <= content.length
  ) {
    fromChar = span[0] as number;
    toChar = span[1] as number;
  } else {
    fromChar = content.indexOf(row.value);
    if (fromChar < 0) return undefined;
    toChar = fromChar + row.value.length;
  }
  const encoder = new TextEncoder();
  const from = encoder.encode(content.slice(0, fromChar)).byteLength;
  const to = encoder.encode(content.slice(0, toChar)).byteLength;
  return to > from ? { chars: [fromChar, toChar], bytes: [from, to] } : undefined;
}

function addressText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function byteSpansOverlap(left: [number, number], right: [number, number]): boolean {
  return left[0] < right[1] && right[0] < left[1];
}

/**
 * Pick the current atom that actually covers a receipt claim.  An episode may
 * carry several independent atoms, so selecting the latest SUPPORTED atom by
 * episode alone can bind a location claim to an unrelated identity revision.
 * The candidate and query are kernel-derived inputs; they are only used to
 * rank exact source spans, never to authorize an address by themselves.
 *
 * `undefined` means the source has no atoms and can use its episode revision.
 * `null` means atoms exist but no current, unambiguous claim binding exists;
 * the conservative result is to reject the route and page again.
 */
function receiptAtomRevision(
  vault: Vault,
  threadId: string,
  source: AddressSourceSnapshot,
  seq: Seq,
  locator: ByteLocator,
  query: string,
  candidate?: ClaimCandidate,
): string | null | undefined {
  const rows = vault.db
    .query(
      "SELECT rowid AS __rowid, id, key, value, text, source_span, phase, valid_from_seq, created_at " +
        "FROM atom WHERE thread_id = ? AND source_seq = ? " +
        `ORDER BY valid_from_seq DESC, created_at DESC, rowid DESC LIMIT ${RECEIPT_ATOM_CANDIDATE_LIMIT + 1}`,
    )
    .all(threadId, seq) as ReceiptAtomRow[];
  if (rows.length === 0) return undefined;
  // Never turn a partial source scan into an arbitrary current witness.  A
  // deterministic extra-row check keeps both memory and lookup work bounded;
  // the caller can page/retry through a narrower evidence capability.
  if (rows.length > RECEIPT_ATOM_CANDIDATE_LIMIT) return null;
  const supported = rows.filter((row) => row.phase === "SUPPORTED");
  if (supported.length === 0) return null;

  const locatorRange: [number, number] = [locator.from, locator.to];
  const queryTerms = ftsTerms(query);
  const candidateText = candidate === undefined ? "" : addressText(candidate.text);
  const candidateTerms = candidate === undefined ? [] : ftsTerms(candidate.text);
  const scored = supported.flatMap((row) => {
    const span = parsedAtomSpan(source.content, row);
    if (span === undefined) return [];
    // Atom spans are UTF-16 offsets converted to byte ranges. Reconstructing
    // the text from the character range keeps matching exact even for UTF-8
    // multibyte source content.
    const spanText = addressText(source.content.slice(span.chars[0], span.chars[1]));
    const searchable = addressText(`${spanText} ${row.text} ${row.value} ${row.key}`);
    const candidateExact =
      candidateText.length > 0 &&
      (spanText.includes(candidateText) ||
        (addressText(row.value).length >= 3 && candidateText.includes(addressText(row.value))));
    const candidateHits = candidateTerms.filter((term) => searchable.includes(term)).length;
    const queryHits = queryTerms.filter((term) => searchable.includes(term)).length;
    const overlaps = byteSpansOverlap(span.bytes, locatorRange);
    const exactRange = span.bytes[0] === locatorRange[0] && span.bytes[1] === locatorRange[1];
    const score =
      (candidateExact ? 1000 : 0) +
      candidateHits * 100 +
      queryHits * 25 +
      (overlaps ? 20 : 0) +
      (exactRange ? 50 : 0);
    const matched = candidateExact || candidateHits > 0 || queryHits > 0 || overlaps;
    return [{ row, span, score, matched, candidateExact }];
  });
  if (scored.length === 0) return null;
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.span.bytes[1] - left.span.bytes[0] - (right.span.bytes[1] - right.span.bytes[0]) ||
      left.row.id.localeCompare(right.row.id),
  );
  const best = scored[0];
  if (best === undefined || !best.matched) return null;
  const runner = scored[1];
  // Do not let a deterministic tie turn a claim into an arbitrary atom when
  // two current facts share a sentence/range. The caller can page more exact
  // evidence and retry with a narrower capability.
  if (runner !== undefined && runner.score === best.score && !best.candidateExact) return null;
  return best.row.id;
}

function receiptWitness(
  vault: Vault,
  threadId: string,
  locator: ByteLocator,
  query: string,
  candidate?: ClaimCandidate,
): AddressWitness | null {
  const episodeMatch = /^episode:(\d+)$/u.exec(locator.source);
  let seq: Seq;
  let source: AddressSourceSnapshot | null;
  let bytes: Uint8Array;
  let sourceHash: string;
  let authority: EvidenceAuthority;
  let manifestId: string | undefined;
  let spanHash: string | undefined;
  let attachmentEvidence: EvidenceLocator | null = null;
  if (episodeMatch !== null) {
    seq = Number(episodeMatch[1]);
    if (!Number.isSafeInteger(seq) || seq <= 0) return null;
    source = sourceAt(vault, threadId, seq);
    if (source === null || source.meta.removed === true) return null;
    // Attachment evidence must name the content-addressed whole object.  The
    // episode's display label is not the retained bytes and cannot authorize a
    // route to the tail or any other attachment span.
    if (source.role === "attachment") return null;
    authority = roleAuthority(source.role);
    bytes = new TextEncoder().encode(source.content);
    sourceHash = sha256(bytes);
    const manifest = source.meta.manifest;
    manifestId =
      manifest !== null &&
      typeof manifest === "object" &&
      typeof (manifest as Record<string, unknown>).id === "string"
        ? ((manifest as Record<string, unknown>).id as string)
        : undefined;
  } else {
    const blobMatch = /^blob:([0-9a-f]{64})$/u.exec(locator.source);
    if (blobMatch === null) return null;
    // A content hash is not provenance.  Attachment routes require the
    // additive evidence witness so a duplicate episode with the same blob
    // cannot be substituted, and so the exact manifest/revision/span are
    // checked before persistence.
    attachmentEvidence = typedEvidenceLocator(locator);
    if (attachmentEvidence === null) return null;
    const found = sourceForBlob(vault, threadId, blobMatch[1] as string, attachmentEvidence.seq);
    if (found === null) return null;
    seq = found.seq;
    source = found.source;
    if (!indexedAttachmentRange(source, [locator.from, locator.to])) return null;
    const range = readAttachmentRange(vault, threadId, seq, [locator.from, locator.to]);
    if (range === null || range.opaque) return null;
    const manifest = range.manifest;
    if (
      manifest.hash !== blobMatch[1] ||
      manifest.id !== attachmentEvidence.manifestId ||
      source.chainHash !== attachmentEvidence.revision ||
      attachmentEvidence.authority !== "attachment"
    ) {
      return null;
    }
    bytes = range.bytes;
    sourceHash = blobMatch[1] as string;
    spanHash = sha256(bytes);
    if (spanHash !== attachmentEvidence.spanHash) return null;
    authority = "attachment";
    manifestId = manifest.id;
  }
  if (source === null || !CURRENT_AUTHORITIES.has(authority)) return null;
  if (locator.hash !== sourceHash) return null;
  if (attachmentEvidence === null) {
    if (
      !Number.isSafeInteger(locator.from) ||
      !Number.isSafeInteger(locator.to) ||
      locator.from < 0 ||
      locator.to <= locator.from ||
      locator.to > bytes.byteLength
    ) {
      return null;
    }
    spanHash = sha256(bytes.slice(locator.from, locator.to));
  }
  const revision =
    attachmentEvidence === null
      ? receiptAtomRevision(vault, threadId, source, seq, locator, query, candidate)
      : attachmentEvidence.revision;
  if (revision === null) return null;
  return {
    seq,
    contentHash: sourceHash,
    byteRange: [locator.from, locator.to],
    spanHash,
    source: locator.source,
    authority,
    revision: revision ?? source.chainHash,
    ...(manifestId === undefined ? {} : { manifestId }),
  };
}

function receiptRouteWitnesses(
  vault: Vault,
  input: AddressReceiptRouteRecordInput,
): { witnesses: AddressWitness[] } | { reason: string } {
  const { receipt } = input;
  if (receipt.status !== "released") return { reason: "answer receipt is not released" };
  if (receipt.packetDigest !== input.packetDigest) return { reason: "answer packet digest mismatch" };
  if (receipt.digest !== answerReceiptDigestOf(receipt)) return { reason: "answer receipt digest mismatch" };

  const packet = vault.db
    .query("SELECT thread_id, turn_seq, digest, status, answer_receipt FROM packet WHERE id = ?")
    .get(input.packetId) as {
    thread_id: string;
    turn_seq: number;
    digest: string;
    status: string;
    answer_receipt: string | null;
  } | null;
  if (packet === null) return { reason: "answer packet is missing" };
  if (
    packet.thread_id !== input.threadId ||
    packet.turn_seq !== input.questionSeq ||
    packet.digest !== input.packetDigest ||
    packet.status !== "done"
  ) {
    return { reason: "answer packet binding is invalid" };
  }
  if (packet.answer_receipt !== null) {
    try {
      const stored = JSON.parse(packet.answer_receipt) as { digest?: unknown };
      if (stored.digest !== receipt.digest) return { reason: "answer packet receipt mismatch" };
    } catch {
      return { reason: "answer packet receipt is malformed" };
    }
  }

  const question = sourceAt(vault, input.threadId, input.questionSeq);
  const answer = sourceAt(vault, input.threadId, input.answerSeq);
  if (question === null || question.meta.removed === true || question.role !== "user") {
    return { reason: "answer question binding is invalid" };
  }
  if (answer === null || answer.meta.removed === true || answer.role !== "assistant") {
    return { reason: "answer episode binding is invalid" };
  }
  try {
    if (normalizeAddressQuery(question.content) !== normalizeAddressQuery(input.query)) {
      return { reason: "answer query binding is invalid" };
    }
  } catch {
    return { reason: "answer query binding is invalid" };
  }
  if (sha256(answer.content) !== receipt.answerDigest) return { reason: "answer digest mismatch" };

  // A receipt is an authorization produced by the same scanner as the gate,
  // not a caller-owned assertion.  Released receipts have no qualification
  // suffix, so the scan can be deterministically replayed over the committed
  // answer text.
  const rescanned = scanRememberedClaims(input.query, answer.content);
  if (
    claimScanDigestOf(rescanned) !== receipt.scanDigest ||
    canonicalJson(rescanned) !== canonicalJson(receipt.candidates)
  ) {
    return { reason: "answer receipt scan mismatch" };
  }

  const unsafe = receipt.classifications.some(
    (classification) =>
      classification.classification !== "SUPPORTED" && classification.classification !== "WORLD_KNOWLEDGE",
  );
  if (unsafe) return { reason: "answer receipt contains an unsafe classification" };
  const supported = receipt.classifications.filter(
    (classification) => classification.classification === "SUPPORTED",
  );
  if (supported.length === 0) return { reason: "answer receipt has no supported remembered claim" };
  if (supported.length > MAX_ADDRESS_ROUTE_ITEMS) {
    return { reason: "answer receipt supported witness count exceeds bounded route capacity" };
  }

  const witnesses: AddressWitness[] = [];
  const seen = new Set<string>();
  for (const classification of supported) {
    const evidenceWitness = classification.evidenceWitness;
    const locator = evidenceWitness ?? classification.witness;
    if (locator === undefined) return { reason: "supported claim has no witness" };
    if (
      evidenceWitness !== undefined &&
      classification.witness !== undefined &&
      canonicalJson(evidenceWitness) !== canonicalJson(classification.witness)
    ) {
      return { reason: "supported evidence witness binding mismatch" };
    }
    if (
      typeof locator.source === "string" &&
      locator.source.startsWith("blob:") &&
      evidenceWitness === undefined
    ) {
      return { reason: "supported attachment evidence witness is missing" };
    }
    const candidate = receipt.candidates.find(
      (item) =>
        item.kind === classification.kind &&
        item.span[0] === classification.span[0] &&
        item.span[1] === classification.span[1],
    );
    const witness = receiptWitness(vault, input.threadId, locator, input.query, candidate);
    if (witness === null) return { reason: "supported claim witness is stale" };
    const failure = witnessFailure(vault, input.threadId, witness);
    if (failure !== null) return { reason: failure };
    const key = canonicalJson(witness);
    if (seen.has(key)) continue;
    seen.add(key);
    witnesses.push(witness);
  }
  return witnesses.length === 0 ? { reason: "route needs a supported witness" } : { witnesses };
}

/**
 * Record a question-to-evidence edge from the kernel's committed answer
 * receipt.  This is the tx-B boundary: no public status boolean, provider map,
 * semantic hit, or assistant source can authorize the write.
 */
export function recordAddressRouteFromReceipt(
  vault: Vault,
  input: AddressReceiptRouteRecordInput,
): AddressRouteWriteResult {
  return vault.tx(() => {
    const validated = receiptRouteWitnesses(vault, input);
    if ("reason" in validated) return { accepted: false, invalidated: [], reason: validated.reason };
    return recordAddressRouteInTransaction(
      vault,
      {
        threadId: input.threadId,
        query: input.query,
        routerVersion: input.routerVersion,
        questionSeq: input.questionSeq,
        answerSeq: input.answerSeq,
        packetId: input.packetId,
        packetDigest: input.packetDigest,
        witnesses: validated.witnesses,
      },
      RECEIPT_AUTHORIZATION,
    );
  });
}

/** Record an edge atomically with any invalidations it supersedes. */
export function recordAddressRoute(vault: Vault, input: AddressRouteRecordInput): AddressRouteWriteResult {
  return vault.tx(() => recordAddressRouteInTransaction(vault, input));
}

export function listAddressRoutes(vault: Vault, threadId: string, query?: string): AddressRouteView[] {
  const rows =
    query === undefined
      ? routeRows(vault, threadId)
      : (() => {
          const canonical = canonicalAddressQuery(query);
          const exact = routeRows(vault, threadId, canonical.digest);
          if (exact.length > 0) return exact;
          // Compatibility read for pre-versioned rows.  `reuseAddressRoute`
          // appends an explicit supersession event before any source can be
          // served, so this fallback is a locator for invalidation, never
          // authority.
          return routeRowsByNormalized(vault, threadId, canonical.normalized);
        })();
  // This is the public/current read surface.  Keep the SQL row immutable, but
  // project every route through the kernel-computed effective state so a
  // dereferenced invalidation parent cannot still look active after closure.
  return rows.map((route) => routeView(vault, route));
}

/**
 * Bounded turn-time route projection.  Full `listAddressRoutes` remains the
 * audit/export surface; this API is the only read used while compiling a
 * repeated question. It returns current SQL candidates plus a bounded tail of
 * append-only events so a stale edge can still produce its receipt without
 * hydrating the complete route lineage.
 */
export function listCurrentAddressRoutes(vault: Vault, threadId: string, query: string): AddressRouteView[] {
  const canonical = canonicalAddressQuery(query);
  const exactHistory = vault.db
    .query("SELECT 1 FROM address_route WHERE thread_id = ? AND query_digest = ? LIMIT 1")
    .get(threadId, canonical.digest);
  const field = exactHistory === null ? "normalized_query" : "query_digest";
  const value = exactHistory === null ? canonical.normalized : canonical.digest;
  const recentRaw = vault.db
    .query(
      `SELECT * FROM address_route
       WHERE thread_id = ? AND ${field} = ?
         AND ${ADDRESS_ROUTE_SQL_BOUNDS}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ${ADDRESS_ROUTE_CANDIDATE_LIMIT}`,
    )
    .all(threadId, value) as Record<string, unknown>[];
  const recent = recentRaw.flatMap((raw) => {
    const route = routeFromRow(raw);
    return route === null ? [] : [route];
  });
  const current = currentActiveRows(currentRouteCandidates(vault, threadId, canonical), vault);
  const byId = new Map<string, AddressRouteRow>();
  for (const route of current) byId.set(route.id, route);
  for (const route of recent) byId.set(route.id, route);
  const selected = [...byId.values()];
  // Keep every current candidate, then fill the remaining window with the
  // newest event rows. This is deterministic even when imported timestamps are
  // unusual and caps the returned projection at the same route page budget.
  const currentIds = new Set(current.map((route) => route.id));
  const currentSelected = current.slice(0, ADDRESS_ROUTE_CANDIDATE_LIMIT);
  const remaining = Math.max(0, ADDRESS_ROUTE_CANDIDATE_LIMIT - currentSelected.length);
  // Closed active parents are immutable lineage, not current candidates. Do
  // not hydrate them into the bounded tail: routeView would otherwise issue a
  // closure lookup per parent and could re-label them while compiling a turn.
  const eventTail = recent
    .filter((route) => !currentIds.has(route.id) && route.status !== ACTIVE)
    .slice(0, remaining);
  const chosen = [...currentSelected, ...eventTail];
  // `selected` is only used to retain a current row if a duplicate key was
  // collapsed by the recent tail ordering; this branch is bounded as well.
  const finalRows = chosen.length === 0 ? selected.slice(0, ADDRESS_ROUTE_CANDIDATE_LIMIT) : chosen;
  return finalRows.map((route) =>
    currentIds.has(route.id) ? routeView(vault, route, { knownClosure: null }) : routeView(vault, route),
  );
}

/** Return only routes that have not been closed by a later event row. */
export function listEffectiveAddressRoutes(
  vault: Vault,
  threadId: string,
  query?: string,
): AddressRouteView[] {
  return effectiveActiveRows(listAddressRoutes(vault, threadId, query), vault);
}

export function invalidateAddressRoute(
  vault: Vault,
  routeId: string,
  reason: string,
  status: Exclude<AddressRouteStatus, "active"> = "invalidated",
  invalidatedBy?: string,
): AddressRouteRow | null {
  const route = sqlRow(vault, routeId);
  if (route === null || route.status !== ACTIVE) return route;
  return invalidateRow(vault, route, status, reason, invalidatedBy);
}

/**
 * Close every effective edge that names one of the user-removed episodes.  The
 * scan is keyset-paged so a large route table never becomes one unbounded
 * allocation; each closure is still an append-only event row.
 */
function invalidateAddressRoutesForSourcesInternal(
  vault: Vault,
  threadId: string,
  sourceSeqs: ReadonlySet<Seq> | readonly Seq[],
  reason = "source deleted",
  collect: boolean,
): AddressRouteRow[] | number {
  return vault.tx(() => {
    const removed = sourceSeqs instanceof Set ? sourceSeqs : new Set(sourceSeqs);
    if (removed.size === 0) return collect ? [] : 0;
    const events: AddressRouteRow[] | undefined = collect ? [] : undefined;
    let closed = 0;
    let lastRowid = 0;
    for (;;) {
      const rows = vault.db
        .query(
          "SELECT rowid, * FROM address_route WHERE thread_id = ? AND rowid > ? " +
            `AND ${ADDRESS_ROUTE_SQL_BOUNDS} ` +
            "ORDER BY rowid ASC LIMIT 256",
        )
        .all(threadId, lastRowid) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      for (const raw of rows) {
        const rowid = Number(raw.rowid);
        if (Number.isSafeInteger(rowid) && rowid > lastRowid) lastRowid = rowid;
        const route = routeFromRow(raw);
        if (
          route === null ||
          route.status !== ACTIVE ||
          !isStoredOpen(vault, route) ||
          !route.witnesses.some((witness) => removed.has(witness.seq))
        ) {
          continue;
        }
        const event = invalidateRow(vault, route, "invalidated", reason, undefined, undefined, {
          knownOpen: true,
        });
        closed += 1;
        events?.push(event);
      }
    }
    return events ?? closed;
  });
}

/**
 * Collect append-only closure rows for callers that need the public lineage
 * result.  The scan itself remains keyset-paged.
 */
export function invalidateAddressRoutesForSources(
  vault: Vault,
  threadId: string,
  sourceSeqs: ReadonlySet<Seq> | readonly Seq[],
  reason = "source deleted",
): AddressRouteRow[] {
  return invalidateAddressRoutesForSourcesInternal(
    vault,
    threadId,
    sourceSeqs,
    reason,
    true,
  ) as AddressRouteRow[];
}

/**
 * Close source-backed edges without retaining every event row.  Forget uses
 * this count-only path because its user-visible result does not expose route
 * events; a million-route archive therefore retains at most one scan batch.
 */
export function invalidateAddressRoutesForSourcesCount(
  vault: Vault,
  threadId: string,
  sourceSeqs: ReadonlySet<Seq> | readonly Seq[],
  reason = "source deleted",
): number {
  return invalidateAddressRoutesForSourcesInternal(vault, threadId, sourceSeqs, reason, false) as number;
}

/** Build a hash-bound witness for a resident textual episode. */
export function witnessForEpisode(
  vault: Vault,
  threadId: string,
  seq: Seq,
  byteRange?: [number, number],
  revision?: string,
): AddressWitness | null {
  const source = sourceAt(vault, threadId, seq);
  if (source === null || source.meta.removed === true) return null;
  if (source.role === "attachment") {
    const rawManifest = source.meta.manifest;
    if (rawManifest === null || typeof rawManifest !== "object") return null;
    const manifest = rawManifest as AttachmentManifest;
    const range = byteRange ?? ([0, manifest.size] as [number, number]);
    if (!indexedAttachmentRange(source, range)) return null;
    if (revision !== undefined && revision !== source.chainHash) return null;
    const read = readAttachmentRange(vault, threadId, seq, range);
    if (read === null || read.opaque) return null;
    return {
      seq,
      contentHash: manifest.hash,
      byteRange: range,
      authority: "attachment",
      spanHash: sha256(read.bytes),
      source: `blob:${manifest.hash}`,
      manifestId: manifest.id,
      revision: revision ?? source.chainHash,
    };
  }
  const bytes = textSourceBytes(source);
  const range = byteRange ?? ([0, bytes.byteLength] as [number, number]);
  if (range[0] < 0 || range[1] < range[0] || range[1] > bytes.byteLength) return null;
  return {
    seq,
    contentHash: source.contentHash,
    byteRange: range,
    authority: roleAuthority(source.role),
    spanHash: sha256(bytes.slice(range[0], range[1])),
    source: `episode:${seq}`,
    revision: revision ?? source.chainHash,
  };
}

/** Read-only alias oracle; a revoked row is an explicit, auditable closure. */
export function addressAliasFailure(
  vault: Vault,
  alias: AddressAliasRow,
  sourceCache?: AddressSourceReplayCache,
): string | null {
  if (alias.authority !== "model") return "alias authority changed";
  if (alias.status === "revoked") return null;
  const source = sourceAt(vault, alias.threadId, alias.sourceSeq, sourceCache);
  if (sourceCache?.failure !== undefined) return sourceCache.failure;
  if (source === null || source.meta.removed === true) return "source deleted";
  if (
    !Number.isInteger(alias.byteFrom) ||
    !Number.isInteger(alias.byteTo) ||
    alias.byteFrom < 0 ||
    alias.byteTo < alias.byteFrom ||
    alias.byteTo - alias.byteFrom > 64 * 1024
  ) {
    return "alias span changed";
  }
  const read = readAliasRange(
    vault,
    alias.threadId,
    alias.sourceSeq,
    source,
    [alias.byteFrom, alias.byteTo],
    sourceCache?.verifiedTextHashes.has(sourceCacheKey(alias.threadId, alias.sourceSeq)) ?? false,
  );
  if (read === null || alias.sourceHash !== read.sourceHash) return "source hash changed";
  if (sha256(read.bytes) !== alias.quoteHash) return "alias span changed";
  return null;
}

/** Exact byte-presence oracle for model-written aliases. */
export function verifyAliasPresence(
  vault: Vault,
  threadId: string,
  proposal: AddressAliasProposal,
): AliasPresenceCheck {
  if (typeof proposal.alias !== "string") return { accepted: false, reason: "alias must be a string" };
  const normalizedAlias = normalizeAddressQuery(proposal.alias);
  if (normalizedAlias.length < 2 || normalizedAlias.length > 160) {
    return { accepted: false, reason: "alias length is outside the bounded range" };
  }
  if (!Number.isInteger(proposal.sourceSeq) || proposal.sourceSeq <= 0) {
    return { accepted: false, reason: "source sequence is invalid" };
  }
  if (typeof proposal.quote !== "string" || proposal.quote.length === 0) {
    return { accepted: false, reason: "quote is required for string presence" };
  }
  const range = asRange(proposal.span);
  if (range === null || range[1] <= range[0]) return { accepted: false, reason: "quote span is invalid" };
  const quoteBytes = new TextEncoder().encode(proposal.quote);
  if (range[1] - range[0] > 64 * 1024 || quoteBytes.byteLength > 64 * 1024) {
    return { accepted: false, reason: "quote span exceeds the bounded alias range" };
  }
  const source = sourceAt(vault, threadId, proposal.sourceSeq);
  if (source === null || source.meta.removed === true)
    return { accepted: false, reason: "source is deleted" };
  const read = readAliasRange(vault, threadId, proposal.sourceSeq, source, range);
  if (read === null) return { accepted: false, reason: "quote span is outside indexed source" };
  const declared = read.bytes;
  if (
    declared.byteLength !== quoteBytes.byteLength ||
    !declared.every((byte, index) => byte === quoteBytes[index])
  ) {
    return { accepted: false, reason: "quote is not present at the declared span" };
  }
  const currentHash = read.sourceHash;
  if (proposal.sourceHash !== currentHash) {
    return { accepted: false, reason: "source hash does not match current bytes" };
  }
  return {
    accepted: true,
    normalizedAlias,
    sourceHash: currentHash,
    quoteHash: sha256(quoteBytes),
  };
}

/** Verify and persist an address-only alias. It never creates an atom/name. */
function proposeAddressAliasInTransaction(
  vault: Vault,
  threadId: string,
  proposal: AddressAliasProposal,
): AddressAliasResult {
  let check: AliasPresenceCheck;
  try {
    check = verifyAliasPresence(vault, threadId, proposal);
  } catch (error) {
    return { accepted: false, reason: error instanceof Error ? error.message : "invalid alias" };
  }
  if (
    !check.accepted ||
    check.normalizedAlias === undefined ||
    check.sourceHash === undefined ||
    check.quoteHash === undefined
  ) {
    return { accepted: false, reason: check.reason ?? "alias presence check failed" };
  }
  const from = proposal.span[0];
  const to = proposal.span[1];
  const id = newId("alias");
  vault.db
    .query(
      "INSERT OR IGNORE INTO address_alias (id, thread_id, alias, source_seq, byte_from, byte_to, source_hash, quote_hash, authority, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'model', 'proposed', ?)",
    )
    .run(
      id,
      threadId,
      check.normalizedAlias,
      proposal.sourceSeq,
      from,
      to,
      check.sourceHash,
      check.quoteHash,
      Date.now(),
    );
  const row = vault.db
    .query(
      "SELECT id FROM address_alias WHERE thread_id = ? AND alias = ? AND source_seq = ? AND byte_from = ? AND byte_to = ?",
    )
    .get(threadId, check.normalizedAlias, proposal.sourceSeq, from, to) as { id: string } | null;
  return { accepted: row !== null, ...(row ? { id: row.id } : {}), alias: check.normalizedAlias };
}

/** Verify and persist an alias atomically. */
export function proposeAddressAlias(
  vault: Vault,
  threadId: string,
  proposal: AddressAliasProposal,
): AddressAliasResult {
  return vault.tx(() => proposeAddressAliasInTransaction(vault, threadId, proposal));
}

export function listAddressAliases(vault: Vault, threadId: string, alias?: string): AddressAliasRow[] {
  const normalizedAlias = alias === undefined ? undefined : normalizeAddressQuery(alias);
  const unsafe =
    normalizedAlias === undefined
      ? vault.db
          .query(
            `SELECT 1 FROM (` +
              `SELECT * FROM address_alias WHERE thread_id = ? ORDER BY created_at, rowid LIMIT ?` +
              `) WHERE NOT (${ADDRESS_ALIAS_SQL_BOUNDS}) LIMIT 1`,
          )
          .get(threadId, ADDRESS_ALIAS_LIST_LIMIT + 1)
      : vault.db
          .query(
            `SELECT 1 FROM (` +
              `SELECT * FROM address_alias WHERE thread_id = ? AND alias = ? ` +
              `ORDER BY created_at, rowid LIMIT ?` +
              `) WHERE NOT (${ADDRESS_ALIAS_SQL_BOUNDS}) LIMIT 1`,
          )
          .get(threadId, normalizedAlias, ADDRESS_ALIAS_LIST_LIMIT + 1);
  if (unsafe !== null) throw new RangeError("address alias row exceeds its bounded projection");
  const raw =
    alias === undefined
      ? (vault.db
          .query("SELECT * FROM address_alias WHERE thread_id = ? ORDER BY created_at, rowid LIMIT ?")
          .all(threadId, ADDRESS_ALIAS_LIST_LIMIT + 1) as Record<string, unknown>[])
      : (vault.db
          .query(
            "SELECT * FROM address_alias WHERE thread_id = ? AND alias = ? ORDER BY created_at, rowid LIMIT ?",
          )
          .all(threadId, normalizedAlias as string, ADDRESS_ALIAS_LIST_LIMIT + 1) as Record<
          string,
          unknown
        >[]);
  if (raw.length > ADDRESS_ALIAS_LIST_LIMIT) {
    throw new RangeError(`address alias listing exceeds ${ADDRESS_ALIAS_LIST_LIMIT} rows`);
  }
  const parsed = raw.map((row) => {
    const parsed = aliasFromRow(row);
    if (parsed === null) throw new RangeError("address alias row has an invalid shape");
    return parsed;
  });
  // Listing is the page-time boundary for aliases: an address is never handed
  // to a caller while its source hash/span has gone stale.
  return parsed.map((row) => (row.status === "proposed" ? revalidateAddressAlias(vault, row).alias : row));
}

/** Recheck an alias's source bytes before using it as a route address. */
export function revalidateAddressAlias(vault: Vault, alias: AddressAliasRow): AddressAliasRevalidation {
  if (alias.status !== "proposed") return { valid: false, alias, reason: "alias revoked" };
  const source = sourceAt(vault, alias.threadId, alias.sourceSeq);
  if (source === null || source.meta.removed === true) {
    vault.db
      .query("UPDATE address_alias SET status = 'revoked' WHERE id = ? AND status = 'proposed'")
      .run(alias.id);
    return {
      valid: false,
      alias: { ...alias, status: "revoked" },
      reason: "source deleted",
    };
  }
  if (
    !Number.isInteger(alias.byteFrom) ||
    !Number.isInteger(alias.byteTo) ||
    alias.byteFrom < 0 ||
    alias.byteTo <= alias.byteFrom ||
    alias.byteTo - alias.byteFrom > 64 * 1024
  ) {
    vault.db
      .query("UPDATE address_alias SET status = 'revoked' WHERE id = ? AND status = 'proposed'")
      .run(alias.id);
    return {
      valid: false,
      alias: { ...alias, status: "revoked" },
      reason: "alias span changed",
    };
  }
  const read = readAliasRange(vault, alias.threadId, alias.sourceSeq, source, [alias.byteFrom, alias.byteTo]);
  if (read === null || alias.sourceHash !== read.sourceHash) {
    vault.db
      .query("UPDATE address_alias SET status = 'revoked' WHERE id = ? AND status = 'proposed'")
      .run(alias.id);
    return {
      valid: false,
      alias: { ...alias, status: "revoked" },
      reason: "source hash changed",
    };
  }
  if (sha256(read.bytes) !== alias.quoteHash) {
    vault.db
      .query("UPDATE address_alias SET status = 'revoked' WHERE id = ? AND status = 'proposed'")
      .run(alias.id);
    return {
      valid: false,
      alias: { ...alias, status: "revoked" },
      reason: "alias span changed",
    };
  }
  return { valid: true, alias };
}
