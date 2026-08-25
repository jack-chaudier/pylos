/**
 * Row shapes and row→object mappers for the vault.
 *
 * SQLite gives back snake_case rows; the protocol speaks camelCase and omits
 * absent fields rather than carrying nulls. Keeping the translation in one file
 * means there is exactly one place where the archive's on-disk shape and its
 * in-memory shape are reconciled.
 */

import type {
  Atom,
  AtomAuthority,
  AtomPhase,
  CapsuleLedgerReceipt,
  Episode,
  EpisodeMeta,
  LossEntry,
  Packet,
  PacketStatus,
  Role,
  Seq,
  Thread,
  ThreadSettings,
} from "@pylos/protocol";
import { budgetSharesFailure } from "./pure/budget.ts";
import { ftsTerms } from "./pure/terms.ts";
import type { StoredCapsule, Tombstone } from "./vault.ts";

export interface EpisodeRow {
  seq: number;
  thread_id: string;
  ts: number;
  role: Role;
  model: string | null;
  provider: string | null;
  content: string;
  content_hash: string;
  tokens: number;
  prev_hash: string;
  hash: string;
  meta: string;
}

/** Scalar/projection row used by bounded transcript and search reads. */
export interface EpisodeViewRow extends Omit<EpisodeRow, "content" | "meta"> {
  content_prefix: string;
  content_bytes: number;
  meta_json: string | null;
  meta_bytes: number;
  meta_removed: number | null;
  meta_name: string | null;
  meta_size: number | null;
}

export interface AtomRow {
  id: string;
  thread_id: string;
  kind: string;
  key: string;
  value: string;
  text: string;
  source_seq: number;
  source_span: string | null;
  valid_from_seq: number;
  valid_to_seq: number | null;
  superseded_by: string | null;
  phase: string;
  authority: string;
  scope: string;
  pinned: number;
  confidence: number;
  created_by: string;
  created_at: number;
}

/** Scalar/projection row used by bounded ordinary search reads. */
export interface AtomViewRow extends Omit<AtomRow, "key" | "value" | "text" | "source_span"> {
  key_prefix: string;
  key_bytes: number;
  value_prefix: string;
  value_bytes: number;
  text_prefix: string;
  text_bytes: number;
  source_span_prefix: string | null;
}

/** Scalar-only atom row for the ordinary memory/X-ray projection. */
export interface AtomPageRow {
  reader_rowid: number;
  id: string;
  thread_id: string;
  kind: string;
  key_prefix: string | Uint8Array;
  key_bytes: number;
  value_prefix: string | Uint8Array;
  value_bytes: number;
  text_prefix: string | Uint8Array;
  text_bytes: number;
  source_seq: number;
  valid_from_seq: number;
  valid_to_seq: number | null;
  phase: string;
  authority: string;
  pinned: number;
}

export interface CapsuleRow {
  id: string;
  thread_id: string;
  level: number;
  from_seq: number;
  to_seq: number;
  text: string;
  tokens: number;
  dropped: string;
  carried_count: number;
  kept: string;
  ledger_receipt?: string | null;
  hash: string;
  created_by: string;
  created_at: number;
}

/** Scalar-only capsule row; prose and loss JSON never cross the SQL boundary. */
export interface CapsuleViewRow {
  reader_rowid: number;
  id: string;
  thread_id: string;
  level: number;
  from_seq: number;
  to_seq: number;
  tokens: number;
  carried_count: number;
  hash: string;
  created_by: string;
  created_at: number;
  text_bytes: number;
  dropped_bytes: number;
  kept_bytes: number;
  dropped_count: number;
  kept_count: number;
}

export interface LossRow {
  name: string;
  kind: string;
  seq: number;
  span: string | null;
  capsule_id: string;
  resolved_by: string | null;
}

/** Scalar-only loss row; names and spans are byte-prefix projected in SQLite. */
export interface LossViewRow {
  reader_rowid: number;
  name_prefix: string | Uint8Array;
  name_bytes: number;
  kind: string;
  seq: number;
  span_prefix: string | Uint8Array | null;
  span_bytes: number;
  capsule_id_prefix: string | Uint8Array;
  resolved_by_prefix: string | Uint8Array | null;
}

export interface PacketRow {
  id: string;
  thread_id: string;
  turn_seq: number;
  model: string;
  budget: number;
  tokens: number;
  digest: string;
  status: string;
  messages: string | null;
  resident: string;
  ledger: string;
  pages: string;
  rounds: string | null;
  reachability: string | null;
  reachability_as_of_seq: number | null;
  coverage: string | null;
  evidence: string | null;
  answer_receipt: string | null;
  semantic: string | null;
  created_at: number;
}

export interface ThreadRow {
  id: string;
  title: string | null;
  created_at: number;
  head_seq: number;
  head_hash: string;
  settings: string;
}

export interface TombstoneRow {
  id: string;
  thread_id: string;
  target: string;
  reason: string;
  created_at: number;
  /** NULL only on a row no `forget` wrote; 0 means legacy (KERNEL A10.6). */
  removal_seq: number | null;
  echoes: string | null;
}

export function toTombstone(row: TombstoneRow): Tombstone {
  return {
    id: row.id,
    threadId: row.thread_id,
    target: row.target,
    reason: row.reason,
    createdAt: row.created_at,
    removalSeq: row.removal_seq ?? 0,
    echoes: row.echoes === null ? [] : (JSON.parse(row.echoes) as Seq[]),
  };
}

export function toThread(row: ThreadRow): Thread {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.settings) as unknown;
  } catch {
    throw new Error("thread settings are malformed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("thread settings are malformed");
  }
  const settings = parsed as ThreadSettings;
  if (settings.shares !== undefined) {
    const failure = budgetSharesFailure(settings.shares);
    if (failure !== null) throw new Error(`thread settings ${failure}`);
  }
  return {
    id: row.id,
    title: row.title ?? "Untitled thread",
    createdAt: row.created_at,
    headSeq: row.head_seq,
    headHash: row.head_hash,
    settings,
  };
}

export function toEpisode(row: EpisodeRow): Episode {
  return {
    threadId: row.thread_id,
    seq: row.seq,
    ts: row.ts,
    role: row.role,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    content: row.content,
    tokens: row.tokens,
    prevHash: row.prev_hash,
    hash: row.hash,
    meta: JSON.parse(row.meta) as EpisodeMeta,
  };
}

export function toAtom(row: AtomRow): Atom {
  return {
    id: row.id,
    threadId: row.thread_id,
    kind: row.kind as Atom["kind"],
    key: row.key,
    value: row.value,
    text: row.text,
    sourceSeq: row.source_seq,
    ...(row.source_span === null ? {} : { sourceSpan: JSON.parse(row.source_span) as [number, number] }),
    validFromSeq: row.valid_from_seq,
    ...(row.valid_to_seq === null ? {} : { validToSeq: row.valid_to_seq }),
    ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
    phase: row.phase as AtomPhase,
    authority: row.authority as AtomAuthority,
    scope: row.scope,
    pinned: row.pinned === 1,
    confidence: row.confidence,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function toCapsule(row: CapsuleRow): StoredCapsule {
  return {
    id: row.id,
    threadId: row.thread_id,
    level: row.level,
    fromSeq: row.from_seq,
    toSeq: row.to_seq,
    text: row.text,
    tokens: row.tokens,
    dropped: JSON.parse(row.dropped) as LossEntry[],
    carriedCount: row.carried_count,
    kept: JSON.parse(row.kept) as LossEntry[],
    ...(row.ledger_receipt == null
      ? {}
      : { ledgerReceipt: JSON.parse(row.ledger_receipt) as CapsuleLedgerReceipt }),
    hash: row.hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function toLoss(row: LossRow): LossEntry {
  return {
    name: row.name,
    kind: row.kind as LossEntry["kind"],
    seq: row.seq,
    ...(row.span === null ? {} : { span: JSON.parse(row.span) as [number, number] }),
    capsuleId: row.capsule_id,
    ...(row.resolved_by === null ? {} : { resolvedBy: row.resolved_by }),
  };
}

export function toPacket(row: PacketRow): Packet {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnSeq: row.turn_seq,
    model: row.model,
    budget: row.budget,
    tokens: row.tokens,
    digest: row.digest,
    status: row.status as PacketStatus,
    messages: row.messages === null ? [] : (JSON.parse(row.messages) as Packet["messages"]),
    resident: JSON.parse(row.resident) as Packet["resident"],
    ledger: JSON.parse(row.ledger) as Packet["ledger"],
    pages: JSON.parse(row.pages) as Packet["pages"],
    ...(row.rounds === null ? {} : { rounds: JSON.parse(row.rounds) as Packet["rounds"] }),
    ...(row.reachability === null
      ? {}
      : { reachability: JSON.parse(row.reachability) as Packet["reachability"] }),
    ...(row.reachability_as_of_seq === null ? {} : { reachabilityAsOfSeq: row.reachability_as_of_seq }),
    ...(row.coverage === null ? {} : { coverage: JSON.parse(row.coverage) as Packet["coverage"] }),
    ...(row.evidence === null ? {} : { evidence: JSON.parse(row.evidence) as Packet["evidence"] }),
    ...(row.answer_receipt === null
      ? {}
      : { answerReceipt: JSON.parse(row.answer_receipt) as Packet["answerReceipt"] }),
    ...(row.semantic === null ? {} : { semantic: JSON.parse(row.semantic) as Packet["semantic"] }),
    createdAt: row.created_at,
  };
}

/** Build a safe FTS5 MATCH expression from free text. */
export function ftsQuery(query: string, mode: "and" | "or" = "and"): string | null {
  const unique = ftsTerms(query);
  if (unique.length === 0) return null;
  if (mode === "and") return unique.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND ");
  // Fallback: the rarest-looking terms only, so an OR cannot match the archive.
  const rare = [...unique]
    .sort((a, b) => b.length - a.length)
    .filter((t) => t.length >= 5)
    .slice(0, 3);
  if (rare.length === 0) return null;
  return rare.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}
