/**
 * Bounds and shape checks for derived rows carried by an untrusted bundle.
 *
 * The episode chain authenticates archive episodes, not the atom/capsule/loss
 * projections derived from them.  Import therefore treats these rows as
 * untrusted input even after the bundle envelope and member digests verify.
 */

import {
  MAX_PACKET_JSON_BYTES,
  MAX_PACKET_MESSAGES_BYTES,
  MAX_PACKET_RESPONSE_BYTES,
  MAX_THREAD_BUDGET,
  MAX_THREAD_MODEL_BYTES,
  MAX_THREAD_SETTINGS_BYTES,
} from "@pylos/protocol";
import { packetRoundsFailure, packetTokensFailure } from "./pure/budget.ts";

export const BUNDLE_DERIVED_LIMITS = {
  atomRowBytes: 2 * 1024 * 1024,
  capsuleRowBytes: 6 * 1024 * 1024,
  lossRowBytes: 32 * 1024,
  capsuleLedgerRowBytes: 32 * 1024,
  addressAliasRowBytes: 4 * 1024,
  atomizationReceiptRowBytes: 4 * 1024,
  packetRowBytes: 16 * 1024 * 1024,
  packetJsonBytes: MAX_PACKET_JSON_BYTES,
  addressAliasStringBytes: 160,
  addressAliasSpanBytes: 64 * 1024,
  manifestBytes: 16 * 1024 * 1024,
  episodeModelBytes: MAX_THREAD_MODEL_BYTES,
  episodeProviderBytes: MAX_THREAD_MODEL_BYTES,
  episodeMetaBytes: 1024 * 1024,
  settingsBytes: MAX_THREAD_SETTINGS_BYTES,
  jsonDepth: 32,
  jsonNodes: 65_536,
  jsonObjectKeys: 4_096,
  idBytes: 512,
  keyBytes: 4 * 1024,
  nameBytes: 4 * 1024,
  valueBytes: 256 * 1024,
  atomTextBytes: 256 * 1024,
  capsuleTextBytes: 1024 * 1024,
  createdByBytes: 1024,
  scopeBytes: 4 * 1024,
  ledgerJsonBytes: 2 * 1024 * 1024,
  ledgerItems: 32_768,
  level: 1_000_000,
  spanOffset: 16 * 1024 * 1024,
} as const;

export type BundleDerivedRowKind = "atom" | "capsule" | "loss" | "capsule-ledger";

const ATOM_KINDS = new Set([
  "identity",
  "fact",
  "preference",
  "decision",
  "promise",
  "task",
  "correction",
  "hypothesis",
]);
const ATOM_PHASES = new Set(["PROPOSED", "SUPPORTED", "HISTORICAL", "REVOKED"]);
const ATOM_AUTHORITIES = new Set(["user", "assistant", "model"]);
const LOSS_KINDS = new Set(["entity", "number", "quote", "atom", "date", "code"]);
const LEDGER_KEYS = new Set(["name", "kind", "seq", "span", "capsuleId", "resolvedBy"]);
const HASH = /^[0-9a-f]{64}$/;
const ROLES = new Set(["user", "assistant", "tool", "system", "attachment", "handoff"]);
const ADDRESS_ALIAS_STATUSES = new Set(["proposed", "revoked"]);
const PACKET_STATUSES = new Set(["pending", "done"]);
const ATOMIZATION_STATUSES = new Set(["complete", "incomplete"]);
const ATOMIZATION_REASONS = new Set(["candidate-cap", "invalid-candidate", "extractor-output"]);
const ATOMIZATION_KEYS = new Set([
  "thread_id",
  "source_seq",
  "source_hash",
  "status",
  "model",
  "candidate_count",
  "accepted_count",
  "omitted_count",
  "reason",
  "created_at",
]);

const utf8 = new TextEncoder();

function byteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function bundleJsonObjectFailure(value: unknown, maximumBytes: number, field: string): string | null {
  const root = record(value);
  if (root === null) return `${field} is not an object`;
  let encoded: string;
  try {
    encoded = JSON.stringify(root);
  } catch {
    return `${field} is not JSON serializable`;
  }
  if (byteLength(encoded) > maximumBytes) return `${field} exceeds ${maximumBytes} JSON bytes`;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const next = pending.pop() as { value: unknown; depth: number };
    nodes += 1;
    if (nodes > BUNDLE_DERIVED_LIMITS.jsonNodes) return `${field} has too many JSON nodes`;
    if (next.depth > BUNDLE_DERIVED_LIMITS.jsonDepth) return `${field} is nested too deeply`;
    if (Array.isArray(next.value)) {
      for (const item of next.value) pending.push({ value: item, depth: next.depth + 1 });
      continue;
    }
    const object = record(next.value);
    if (object === null) continue;
    const keys = Object.keys(object);
    if (keys.length > BUNDLE_DERIVED_LIMITS.jsonObjectKeys) return `${field} object has too many keys`;
    for (const key of keys) {
      if (byteLength(key) > 256) return `${field} has an oversized key`;
      pending.push({ value: object[key], depth: next.depth + 1 });
    }
  }
  return null;
}

export function bundleEpisodeFailure(value: unknown): string | null {
  const row = record(value);
  if (row === null) return "row is not an object";
  return (
    stringFailure(row.threadId, "threadId", BUNDLE_DERIVED_LIMITS.idBytes) ??
    integerFailure(row.seq, "seq", 1) ??
    integerFailure(row.ts, "ts", 0) ??
    (typeof row.role === "string" && ROLES.has(row.role) ? null : "role is invalid") ??
    (row.role !== "assistant" && (row.model !== undefined || row.provider !== undefined)
      ? "only assistant episodes may declare model or provider"
      : null) ??
    stringFailure(row.model, "model", BUNDLE_DERIVED_LIMITS.episodeModelBytes, {
      empty: true,
      optional: true,
    }) ??
    stringFailure(row.provider, "provider", BUNDLE_DERIVED_LIMITS.episodeProviderBytes, {
      empty: true,
      optional: true,
    }) ??
    stringFailure(row.content, "content", BUNDLE_DERIVED_LIMITS.atomRowBytes * 8, { empty: true }) ??
    stringFailure(row.contentHash, "contentHash", 64, { optional: true }) ??
    (row.contentHash === undefined || (typeof row.contentHash === "string" && HASH.test(row.contentHash))
      ? null
      : "contentHash is not lowercase sha256") ??
    integerFailure(row.tokens, "tokens", 0, 16 * 1024 * 1024) ??
    (typeof row.prevHash === "string" && HASH.test(row.prevHash)
      ? null
      : "prevHash is not lowercase sha256") ??
    (typeof row.hash === "string" && HASH.test(row.hash) ? null : "hash is not lowercase sha256") ??
    (row.meta === undefined
      ? null
      : bundleJsonObjectFailure(row.meta, BUNDLE_DERIVED_LIMITS.episodeMetaBytes, "meta"))
  );
}

/** Validate one persisted address-only alias before it can reach SQLite. */
export function bundleAddressAliasFailure(value: unknown, expectedThreadId?: string): string | null {
  const row = record(value);
  if (row === null) return "row is not an object";
  let encoded: string;
  try {
    encoded = JSON.stringify(row);
  } catch {
    return "row is not JSON serializable";
  }
  if (byteLength(encoded) > BUNDLE_DERIVED_LIMITS.addressAliasRowBytes) {
    return `row exceeds ${BUNDLE_DERIVED_LIMITS.addressAliasRowBytes} JSON bytes`;
  }
  return (
    stringFailure(row.id, "id", BUNDLE_DERIVED_LIMITS.addressAliasStringBytes) ??
    stringFailure(row.thread_id, "thread_id", BUNDLE_DERIVED_LIMITS.addressAliasStringBytes) ??
    (expectedThreadId !== undefined && row.thread_id !== expectedThreadId
      ? "thread_id does not match the bundle"
      : null) ??
    stringFailure(row.alias, "alias", BUNDLE_DERIVED_LIMITS.addressAliasStringBytes) ??
    (typeof row.alias === "string" &&
    row.alias === row.alias.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase()
      ? null
      : "alias is not canonically normalized") ??
    integerFailure(row.source_seq, "source_seq", 1) ??
    integerFailure(row.byte_from, "byte_from", 0, BUNDLE_DERIVED_LIMITS.spanOffset) ??
    integerFailure(row.byte_to, "byte_to", 1, BUNDLE_DERIVED_LIMITS.spanOffset) ??
    ((row.byte_to as number) <= (row.byte_from as number) ||
    (row.byte_to as number) - (row.byte_from as number) > BUNDLE_DERIVED_LIMITS.addressAliasSpanBytes
      ? "alias byte range is outside its bounds"
      : null) ??
    (typeof row.source_hash === "string" && HASH.test(row.source_hash)
      ? null
      : "source_hash is not lowercase sha256") ??
    (typeof row.quote_hash === "string" && HASH.test(row.quote_hash)
      ? null
      : "quote_hash is not lowercase sha256") ??
    (row.authority === "model" ? null : "authority is invalid") ??
    (typeof row.status === "string" && ADDRESS_ALIAS_STATUSES.has(row.status) ? null : "status is invalid") ??
    integerFailure(row.created_at, "created_at", 1)
  );
}

/** Validate one kernel-issued bounded model-extraction receipt. */
export function bundleAtomizationReceiptFailure(value: unknown, expectedThreadId?: string): string | null {
  const row = record(value);
  if (row === null) return "row is not an object";
  let encoded: string;
  try {
    encoded = JSON.stringify(row);
  } catch {
    return "row is not JSON serializable";
  }
  if (byteLength(encoded) > BUNDLE_DERIVED_LIMITS.atomizationReceiptRowBytes) {
    return `row exceeds ${BUNDLE_DERIVED_LIMITS.atomizationReceiptRowBytes} JSON bytes`;
  }
  if (Object.keys(row).some((key) => !ATOMIZATION_KEYS.has(key))) return "row has an unknown field";
  const status = row.status;
  const reason = row.reason;
  const candidateCount = row.candidate_count;
  const acceptedCount = row.accepted_count;
  const omittedCount = row.omitted_count;
  return (
    stringFailure(row.thread_id, "thread_id", BUNDLE_DERIVED_LIMITS.idBytes) ??
    (expectedThreadId !== undefined && row.thread_id !== expectedThreadId
      ? "thread_id does not match the bundle"
      : null) ??
    integerFailure(row.source_seq, "source_seq", 1) ??
    (typeof row.source_hash === "string" && HASH.test(row.source_hash)
      ? null
      : "source_hash is not lowercase sha256") ??
    (typeof status === "string" && ATOMIZATION_STATUSES.has(status) ? null : "status is invalid") ??
    stringFailure(row.model, "model", MAX_THREAD_MODEL_BYTES, { nullable: true }) ??
    integerFailure(candidateCount, "candidate_count", 0) ??
    integerFailure(acceptedCount, "accepted_count", 0) ??
    integerFailure(omittedCount, "omitted_count", 0) ??
    (typeof candidateCount === "number" && typeof acceptedCount === "number" && acceptedCount > candidateCount
      ? "accepted_count exceeds candidate_count"
      : null) ??
    (reason === null ||
    reason === undefined ||
    (typeof reason === "string" && ATOMIZATION_REASONS.has(reason))
      ? null
      : "reason is invalid") ??
    (status === "complete" && (omittedCount !== 0 || reason !== null)
      ? "complete receipt carries an omission"
      : null) ??
    (status === "incomplete" && (typeof reason !== "string" || !ATOMIZATION_REASONS.has(reason))
      ? "incomplete receipt has no bounded reason"
      : null) ??
    integerFailure(row.created_at, "created_at", 0)
  );
}

function packetJsonFailure(
  value: unknown,
  field: string,
  shape: "array" | "object",
  options: { nullable?: boolean; optional?: boolean; maximum?: number } = {},
): string | null {
  if (value === undefined && options.optional === true) return null;
  if (value === null && options.nullable === true) return null;
  if (typeof value !== "string") return `${field} is not encoded JSON`;
  if (byteLength(value) > (options.maximum ?? BUNDLE_DERIVED_LIMITS.packetJsonBytes)) {
    return `${field} exceeds its JSON byte bound`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return `${field} is not valid JSON`;
  }
  if (shape === "array" ? !Array.isArray(parsed) : record(parsed) === null) {
    return `${field} has the wrong JSON shape`;
  }
  return bundleJsonObjectFailure(
    { value: parsed },
    options.maximum ?? BUNDLE_DERIVED_LIMITS.packetJsonBytes,
    field,
  );
}

const PACKET_JSON_COLUMNS = [
  "messages",
  "resident",
  "ledger",
  "pages",
  "rounds",
  "reachability",
  "coverage",
  "evidence",
  "answer_receipt",
  "semantic",
] as const;

function packetEnvelopeFailure(row: Record<string, unknown>): string | null {
  let aggregate = 0;
  for (const field of PACKET_JSON_COLUMNS) {
    const value = row[field];
    if (value === null || value === undefined || typeof value !== "string") continue;
    const size = byteLength(value);
    const maximum = field === "messages" ? MAX_PACKET_MESSAGES_BYTES : MAX_PACKET_JSON_BYTES;
    if (size > maximum) return `${field} exceeds ${maximum} JSON bytes`;
    aggregate += size;
    if (aggregate > MAX_PACKET_RESPONSE_BYTES) {
      return `packet JSON fields exceed ${MAX_PACKET_RESPONSE_BYTES} aggregate bytes`;
    }
  }
  return null;
}

/** Apply the shared scalar round gate after the bounded packet JSON parser. */
function packetRoundsBundleFailure(value: unknown, packetBudget: unknown): string | null {
  if (typeof value !== "string") return null;
  let rounds: unknown;
  try {
    rounds = JSON.parse(value) as unknown;
  } catch {
    // packetJsonFailure reports the canonical parse error below in the
    // admission chain; this helper only supplies the cross-field relation.
    return null;
  }
  return packetRoundsFailure(rounds, packetBudget);
}

/** Scalar and JSON admission gate for packet rows before untrusted import insertion. */
export function bundlePacketFailure(value: unknown, expectedThreadId?: string): string | null {
  const row = record(value);
  if (row === null) return "row is not an object";
  let encoded: string;
  try {
    encoded = JSON.stringify(row);
  } catch {
    return "row is not JSON serializable";
  }
  if (byteLength(encoded) > BUNDLE_DERIVED_LIMITS.packetRowBytes) {
    return `row exceeds ${BUNDLE_DERIVED_LIMITS.packetRowBytes} JSON bytes`;
  }
  return (
    stringFailure(row.id, "id", BUNDLE_DERIVED_LIMITS.idBytes) ??
    stringFailure(row.thread_id, "thread_id", BUNDLE_DERIVED_LIMITS.idBytes, { optional: true }) ??
    (expectedThreadId !== undefined && row.thread_id !== undefined && row.thread_id !== expectedThreadId
      ? "thread_id does not match the bundle"
      : null) ??
    integerFailure(row.turn_seq, "turn_seq", 1) ??
    stringFailure(row.model, "model", MAX_THREAD_MODEL_BYTES, { empty: true }) ??
    integerFailure(row.budget, "budget", 1, MAX_THREAD_BUDGET) ??
    integerFailure(row.tokens, "tokens", 0, MAX_THREAD_BUDGET) ??
    packetTokensFailure(row.tokens, row.budget) ??
    (typeof row.digest === "string" && HASH.test(row.digest) ? null : "digest is not lowercase sha256") ??
    (typeof row.status === "string" && PACKET_STATUSES.has(row.status) ? null : "status is invalid") ??
    stringFailure(row.compiler_version, "compiler_version", 256) ??
    packetEnvelopeFailure(row) ??
    packetJsonFailure(row.messages, "messages", "array", {
      nullable: true,
      maximum: MAX_PACKET_MESSAGES_BYTES,
    }) ??
    packetJsonFailure(row.resident, "resident", "array") ??
    packetJsonFailure(row.ledger, "ledger", "object") ??
    packetJsonFailure(row.pages, "pages", "array") ??
    packetJsonFailure(row.rounds, "rounds", "array", { nullable: true }) ??
    packetRoundsBundleFailure(row.rounds, row.budget) ??
    packetJsonFailure(row.reachability, "reachability", "array", { nullable: true, optional: true }) ??
    integerFailure(row.reachability_as_of_seq, "reachability_as_of_seq", 0, Number.MAX_SAFE_INTEGER, {
      nullable: true,
      optional: true,
    }) ??
    packetJsonFailure(row.coverage, "coverage", "object", { nullable: true, optional: true }) ??
    packetJsonFailure(row.evidence, "evidence", "array", { nullable: true, optional: true }) ??
    packetJsonFailure(row.answer_receipt, "answer_receipt", "object", { nullable: true, optional: true }) ??
    packetJsonFailure(row.semantic, "semantic", "object", { nullable: true, optional: true }) ??
    integerFailure(row.created_at, "created_at", 0)
  );
}

function stringFailure(
  value: unknown,
  field: string,
  maximum: number,
  options: { empty?: boolean; nullable?: boolean; optional?: boolean } = {},
): string | null {
  if (value === undefined && options.optional === true) return null;
  if (value === null && options.nullable === true) return null;
  if (typeof value !== "string") return `${field} is not a string`;
  if (options.empty !== true && value.length === 0) return `${field} is empty`;
  return byteLength(value) <= maximum ? null : `${field} exceeds ${maximum} UTF-8 bytes`;
}

function integerFailure(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
  options: { nullable?: boolean; optional?: boolean } = {},
): string | null {
  if (value === undefined && options.optional === true) return null;
  if (value === null && options.nullable === true) return null;
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? null
    : `${field} is outside its integer bounds`;
}

function spanFailure(value: unknown, field: string, encoded: boolean): string | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (encoded) {
    if (typeof value !== "string" || byteLength(value) > 128) return `${field} is not a bounded JSON span`;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return `${field} is not valid JSON`;
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return `${field} is not a two-offset span`;
  const [from, to] = parsed;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    (from as number) < 0 ||
    (to as number) < (from as number) ||
    (to as number) > BUNDLE_DERIVED_LIMITS.spanOffset
  ) {
    return `${field} is outside its offset bounds`;
  }
  return null;
}

function ledgerEntryFailure(value: unknown, field: string): string | null {
  const row = record(value);
  if (row === null) return `${field} is not an object`;
  if (Object.keys(row).some((key) => !LEDGER_KEYS.has(key))) return `${field} has an unknown field`;
  return (
    stringFailure(row.name, `${field}.name`, BUNDLE_DERIVED_LIMITS.nameBytes) ??
    (typeof row.kind === "string" && LOSS_KINDS.has(row.kind) ? null : `${field}.kind is invalid`) ??
    integerFailure(row.seq, `${field}.seq`, 1) ??
    spanFailure(row.span, `${field}.span`, false) ??
    stringFailure(row.capsuleId, `${field}.capsuleId`, BUNDLE_DERIVED_LIMITS.idBytes, {
      optional: true,
    }) ??
    stringFailure(row.resolvedBy, `${field}.resolvedBy`, BUNDLE_DERIVED_LIMITS.idBytes, {
      optional: true,
    })
  );
}

function ledgerFailure(value: unknown, field: string, optional = false): string | null {
  if (value === undefined && optional) return null;
  if (!Array.isArray(value)) return `${field} is not an array`;
  if (value.length > BUNDLE_DERIVED_LIMITS.ledgerItems) {
    return `${field} exceeds ${BUNDLE_DERIVED_LIMITS.ledgerItems} entries`;
  }
  const encoded = JSON.stringify(value);
  if (byteLength(encoded) > BUNDLE_DERIVED_LIMITS.ledgerJsonBytes) {
    return `${field} exceeds ${BUNDLE_DERIVED_LIMITS.ledgerJsonBytes} JSON bytes`;
  }
  for (let index = 0; index < value.length; index += 1) {
    const failure = ledgerEntryFailure(value[index], `${field}[${index}]`);
    if (failure !== null) return failure;
  }
  return null;
}

function capsuleLedgerPartFailure(
  value: unknown,
  field: string,
  embedded: unknown,
  requireComplete: boolean,
): string | null {
  const row = record(value);
  if (row === null) return `${field} is not an object`;
  if (
    Object.keys(row).some((key) => !["count", "embeddedCount", "digest", "complete", "cursor"].includes(key))
  ) {
    return `${field} has an unknown field`;
  }
  const embeddedCount = Array.isArray(embedded) ? embedded.length : -1;
  return (
    integerFailure(row.count, `${field}.count`, 0) ??
    integerFailure(row.embeddedCount, `${field}.embeddedCount`, 0) ??
    (row.embeddedCount !== embeddedCount
      ? `${field}.embeddedCount disagrees with the capsule array`
      : null) ??
    (typeof row.digest === "string" && HASH.test(row.digest)
      ? null
      : `${field}.digest is not lowercase sha256`) ??
    (typeof row.complete === "boolean" ? null : `${field}.complete is not boolean`) ??
    (row.complete === true && row.count !== row.embeddedCount
      ? `${field} falsely claims completeness`
      : null) ??
    (row.complete === false && row.count === row.embeddedCount
      ? `${field} has a spurious continuation`
      : null) ??
    (requireComplete && row.complete !== true ? `${field} must be complete` : null) ??
    stringFailure(row.cursor, `${field}.cursor`, 1024, { optional: row.complete === true }) ??
    (row.complete === true && row.cursor !== undefined ? `${field} complete receipt carries a cursor` : null)
  );
}

function capsuleLedgerReceiptFailure(value: unknown, dropped: unknown, kept: unknown): string | null {
  if (value === undefined) return null;
  const row = record(value);
  if (row === null) return "ledgerReceipt is not an object";
  if (Object.keys(row).some((key) => !["version", "dropped", "kept"].includes(key))) {
    return "ledgerReceipt has an unknown field";
  }
  return (
    (row.version === 1 ? null : "ledgerReceipt.version is invalid") ??
    capsuleLedgerPartFailure(row.dropped, "ledgerReceipt.dropped", dropped, false) ??
    capsuleLedgerPartFailure(row.kept, "ledgerReceipt.kept", kept, true)
  );
}

function atomFailure(row: Record<string, unknown>): string | null {
  const authority = row.authority;
  const validFrom = row.valid_from_seq;
  const validTo = row.valid_to_seq;
  return (
    stringFailure(row.id, "id", BUNDLE_DERIVED_LIMITS.idBytes) ??
    stringFailure(row.thread_id, "thread_id", BUNDLE_DERIVED_LIMITS.idBytes, { optional: true }) ??
    (typeof row.kind === "string" && ATOM_KINDS.has(row.kind) ? null : "kind is invalid") ??
    stringFailure(row.key, "key", BUNDLE_DERIVED_LIMITS.keyBytes) ??
    stringFailure(row.value, "value", BUNDLE_DERIVED_LIMITS.valueBytes, { empty: true }) ??
    stringFailure(row.text, "text", BUNDLE_DERIVED_LIMITS.atomTextBytes, { empty: true }) ??
    integerFailure(row.source_seq, "source_seq", 1) ??
    spanFailure(row.source_span, "source_span", true) ??
    integerFailure(validFrom, "valid_from_seq", 1) ??
    integerFailure(validTo, "valid_to_seq", 1, Number.MAX_SAFE_INTEGER, { nullable: true }) ??
    (typeof validTo === "number" && typeof validFrom === "number" && validTo < validFrom
      ? "valid_to_seq precedes valid_from_seq"
      : null) ??
    stringFailure(row.superseded_by, "superseded_by", BUNDLE_DERIVED_LIMITS.idBytes, { nullable: true }) ??
    (typeof row.phase === "string" && ATOM_PHASES.has(row.phase) ? null : "phase is invalid") ??
    (typeof authority === "string" && ATOM_AUTHORITIES.has(authority) ? null : "authority is invalid") ??
    stringFailure(row.scope, "scope", BUNDLE_DERIVED_LIMITS.scopeBytes) ??
    (row.pinned === 0 || row.pinned === 1 ? null : "pinned is not 0 or 1") ??
    (typeof row.confidence === "number" &&
    Number.isFinite(row.confidence) &&
    row.confidence >= 0 &&
    row.confidence <= 1
      ? null
      : "confidence is outside [0,1]") ??
    stringFailure(row.created_by, "created_by", BUNDLE_DERIVED_LIMITS.createdByBytes) ??
    integerFailure(row.created_at, "created_at", 0)
  );
}

function capsuleFailure(row: Record<string, unknown>): string | null {
  const from = row.fromSeq;
  const to = row.toSeq;
  const shape =
    stringFailure(row.id, "id", BUNDLE_DERIVED_LIMITS.idBytes) ??
    stringFailure(row.threadId, "threadId", BUNDLE_DERIVED_LIMITS.idBytes, { optional: true }) ??
    integerFailure(row.level, "level", 0, BUNDLE_DERIVED_LIMITS.level) ??
    integerFailure(from, "fromSeq", 1) ??
    integerFailure(to, "toSeq", 1) ??
    (typeof from === "number" && typeof to === "number" && to < from ? "toSeq precedes fromSeq" : null) ??
    stringFailure(row.text, "text", BUNDLE_DERIVED_LIMITS.capsuleTextBytes, { empty: true }) ??
    integerFailure(row.tokens, "tokens", 0, 16 * 1024 * 1024) ??
    ledgerFailure(row.dropped, "dropped") ??
    integerFailure(row.carriedCount, "carriedCount", 0) ??
    ledgerFailure(row.kept, "kept", true) ??
    capsuleLedgerReceiptFailure(row.ledgerReceipt, row.dropped, row.kept) ??
    (typeof row.hash === "string" && HASH.test(row.hash) ? null : "hash is not lowercase sha256") ??
    stringFailure(row.createdBy, "createdBy", BUNDLE_DERIVED_LIMITS.createdByBytes) ??
    integerFailure(row.createdAt, "createdAt", 0);
  if (shape !== null) return shape;
  for (const field of ["dropped", "kept"] as const) {
    for (const entry of (row[field] ?? []) as Array<Record<string, unknown>>) {
      if (
        typeof entry.seq !== "number" ||
        typeof from !== "number" ||
        typeof to !== "number" ||
        entry.seq < from ||
        entry.seq > to
      ) {
        return `${field} entry points outside the capsule range`;
      }
    }
  }
  return null;
}

function lossFailure(row: Record<string, unknown>): string | null {
  return (
    integerFailure(row.id, "id", 1, Number.MAX_SAFE_INTEGER, { optional: true }) ??
    stringFailure(row.thread_id, "thread_id", BUNDLE_DERIVED_LIMITS.idBytes, { optional: true }) ??
    stringFailure(row.capsule_id, "capsule_id", BUNDLE_DERIVED_LIMITS.idBytes) ??
    stringFailure(row.name, "name", BUNDLE_DERIVED_LIMITS.nameBytes) ??
    (typeof row.kind === "string" && LOSS_KINDS.has(row.kind) ? null : "kind is invalid") ??
    integerFailure(row.level, "level", -1, BUNDLE_DERIVED_LIMITS.level) ??
    integerFailure(row.seq, "seq", 1) ??
    spanFailure(row.span, "span", true) ??
    stringFailure(row.resolved_by, "resolved_by", BUNDLE_DERIVED_LIMITS.idBytes, { nullable: true })
  );
}

function capsuleLedgerFailure(row: Record<string, unknown>): string | null {
  if (
    Object.keys(row).some(
      (key) => !["thread_id", "capsule_id", "part", "ordinal", "name", "kind", "seq", "span"].includes(key),
    )
  ) {
    return "capsule ledger row has an unknown field";
  }
  return (
    stringFailure(row.thread_id, "thread_id", BUNDLE_DERIVED_LIMITS.idBytes, { optional: true }) ??
    stringFailure(row.capsule_id, "capsule_id", BUNDLE_DERIVED_LIMITS.idBytes) ??
    (row.part === "dropped" || row.part === "kept" ? null : "part is invalid") ??
    integerFailure(row.ordinal, "ordinal", 0) ??
    stringFailure(row.name, "name", BUNDLE_DERIVED_LIMITS.nameBytes) ??
    (typeof row.kind === "string" && LOSS_KINDS.has(row.kind) ? null : "kind is invalid") ??
    integerFailure(row.seq, "seq", 1) ??
    spanFailure(row.span, "span", true)
  );
}

export function bundleDerivedRowFailure(kind: BundleDerivedRowKind, value: unknown): string | null {
  const row = record(value);
  if (row === null) return "row is not an object";
  if (kind === "atom") return atomFailure(row);
  if (kind === "capsule") return capsuleFailure(row);
  if (kind === "loss") return lossFailure(row);
  return capsuleLedgerFailure(row);
}
