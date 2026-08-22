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
  Episode,
  EpisodeMeta,
  LossEntry,
  Packet,
  PacketStatus,
  Role,
  Thread,
  ThreadSettings,
} from "@pylos/protocol";
import { ftsTerms } from "./pure/terms.ts";
import type { StoredCapsule } from "./vault.ts";

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
  hash: string;
  created_by: string;
  created_at: number;
}

export interface LossRow {
  name: string;
  kind: string;
  seq: number;
  span: string | null;
  capsule_id: string;
  resolved_by: string | null;
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

export function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title ?? "Untitled thread",
    createdAt: row.created_at,
    headSeq: row.head_seq,
    headHash: row.head_hash,
    settings: JSON.parse(row.settings) as ThreadSettings,
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
    createdAt: row.created_at,
  };
}

/** The tokenizer lives in `pure/terms.ts`; `page.ts` and `index.ts` take it from here. */
export { ftsTerms };

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
