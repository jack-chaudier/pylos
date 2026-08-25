/**
 * The Vault — one SQLite database per user profile (KERNEL §1, A5, A6).
 *
 * `~/.pylos/vault.sqlite` (WAL, mode 0600), blobs content-addressed under
 * `~/.pylos/objects/<sha256>`; `PYLOS_HOME` overrides. Everything that belongs
 * to one turn commits in one transaction, so a crash can never leave an answer
 * without its derivation.
 *
 * This module owns the exact archive and nothing else: no compilation, no
 * summarization, no policy. Derived state (atoms, capsules, losses, packets)
 * lives here too but is recomputable from `episode` alone.
 */

import { Database, type Statement } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Atom,
  AtomAuthority,
  AtomizationReceipt,
  AtomPhase,
  AtomView,
  Capsule,
  CapsuleLedgerReceipt,
  CapsuleView,
  Episode,
  EpisodeMeta,
  EpisodeView,
  LossEntry,
  LossEntryView,
  Packet,
  PacketStatus,
  Role,
  SemanticReceipt,
  Seq,
  Thread,
  ThreadSettings,
} from "@pylos/protocol";
import {
  CAPSULE_FANOUT,
  CAPSULE_SOURCE_EPISODE_BYTES,
  LEAF_CAPSULE_EPISODES,
  MAX_ATOM_KEY_BYTES,
  MAX_ATOM_PAGE_ITEMS,
  MAX_ATOM_TEXT_BYTES,
  MAX_ATOM_VALUE_BYTES,
  MAX_CAPSULE_PAGE_ITEMS,
  MAX_DERIVED_RESPONSE_BYTES,
  MAX_LEDGER_NAME_BYTES,
  MAX_LEDGER_PAGE_ITEMS,
  MAX_LEDGER_SPAN_BYTES,
  MAX_PACKET_JSON_BYTES,
  MAX_PACKET_MESSAGES_BYTES,
  MAX_PACKET_RESPONSE_BYTES,
  MAX_THREAD_BUDGET,
  MAX_THREAD_ID_BYTES,
  MAX_THREAD_LIST_ROWS,
  MAX_THREAD_MODEL_BYTES,
  MAX_THREAD_SETTINGS_BYTES,
  MAX_THREAD_TITLE_BYTES,
} from "@pylos/protocol";
import {
  type AddressAliasProposal,
  type AddressRouteRecordInput,
  canonicalAddressQuery,
  getAddressRoute,
  invalidateAddressRoute,
  listAddressAliases,
  listAddressRoutes,
  listCurrentAddressRoutes,
  listEffectiveAddressRoutes,
  proposeAddressAlias,
  recordAddressRoute,
  reuseAddressRoute,
  revalidateAddressAlias,
  revalidateAddressRoute,
} from "./address.ts";
import {
  attachmentMetadataFailure,
  attachmentNameFromMeta,
  buildAttachmentManifest,
  normalizeAttachmentName,
} from "./attachment.ts";
import {
  type BlobDeletionStage,
  cleanupBlobDeletion,
  commitBlobDeletion,
  createBlobDeletion,
  discardBlobDeletion,
  MAX_BLOB_DELETION_ENTRIES,
  recoverBlobDeletionsBatched,
  stageBlobForDeletion,
} from "./blob-delete.ts";
import {
  type BlobPromotion,
  commitBlobPromotion,
  createBlobPromotion,
  discardBlobPromotion,
  recoverBlobPromotions,
  recoverImportStages,
  stageBlobBytesForPromotion,
  syncVerifiedBlobFile,
  verifiedBlobFile,
} from "./blob-pending.ts";
import { BUNDLE_DERIVED_LIMITS } from "./bundle-derived.ts";
import { canonicalHash, chainHash, genesisHash, newId, sha256 } from "./hash.ts";
import { budgetSharesFailure, packetRoundsFailure, packetTokensFailure } from "./pure/budget.ts";
import { canonicalJson } from "./pure/canonical.ts";
import { capsuleSourceContentFailure } from "./pure/ledger.ts";
import { names } from "./pure/names.ts";
import { approxTokens } from "./pure/tokens.ts";
import {
  AUTHORITY_REPLAY_BYTES_PER_OPEN,
  AUTHORITY_REPLAY_CURSOR,
  AUTHORITY_REPLAY_ROWS_PER_OPEN,
  AUTHORITY_REPLAY_THREADS_PER_OPEN,
  replayAtomsBounded,
} from "./replay.ts";
import {
  type AtomPageRow,
  type AtomRow,
  type AtomViewRow,
  type CapsuleRow,
  type CapsuleViewRow,
  type EpisodeRow,
  type EpisodeViewRow,
  ftsQuery,
  type LossRow,
  type LossViewRow,
  type PacketRow,
  type ThreadRow,
  type TombstoneRow,
  toAtom,
  toCapsule,
  toEpisode,
  toLoss,
  toPacket,
  toThread,
  toTombstone,
} from "./rows.ts";
import {
  ATOM_NAME_REBUILD,
  ATTACHMENT_NAME_REBUILD,
  AUTHORITY_REPLAY,
  COUNTERS,
  MIGRATIONS,
} from "./schema.ts";
import type { SemanticHit } from "./semantic.ts";
import {
  openKernelSemanticRuntime,
  prepareSemanticSqlite,
  SEMANTIC_BACKFILL_EPISODES,
  semanticGenerationId,
  semanticIndexPlan,
} from "./semantic-kernel.ts";
import {
  ensureSemanticDurableTables,
  removeSemanticMetadata,
  type SemanticRuntime,
  type SemanticRuntimeProbe,
  type SemanticSqlDatabase,
} from "./semantic-runtime.ts";

/** Chain checkpoint interval (KERNEL §1). */
export const CHECKPOINT_EVERY = 4096;
/** Number of recent packets that keep their full `messages` array (KERNEL A7). */
export const PACKET_MESSAGE_RETENTION = 1000;

export interface VaultThreadListCursor {
  createdAt: number;
  id: string;
}

export interface VaultThreadListRow {
  id: string;
  createdAt: number;
}

export interface VaultThreadListPage {
  threads: VaultThreadListRow[];
  hasMore: boolean;
}

export interface VaultThreadHeader {
  id: string;
  title: string | null;
  titleBytes: number;
  headSeq: number;
  headHash: string;
}

/** Scalar-only source row used by collection coverage planning. */
export interface CoverageEpisodeRow {
  seq: Seq;
  role: Role;
  contentHash: string;
  contentBytes: number;
  removed: boolean;
}

export interface ThreadFragment {
  threadId: string;
  originalThreadId: string;
  fromSeq: Seq;
  toSeq: Seq;
  prevHash: string;
  headHash: string;
  createdAt: number;
}

/** Maximum values used by the server's ordinary transcript projection. */
export const DEFAULT_EPISODE_VIEW_CONTENT_LIMIT = 8 * 1024;
export const DEFAULT_EPISODE_VIEW_META_LIMIT = 16 * 1024;
/** Strict prefix used when a frontier locator binds a source episode. */
export const FRONTIER_LOCATOR_CONTENT_LIMIT = 64 * 1024;
/** Per-field limits for the compiler's SQL-first atom candidate projection. */
const FRONTIER_ATOM_KEY_LIMIT = 512;
const FRONTIER_ATOM_VALUE_LIMIT = 2 * 1024;
const FRONTIER_ATOM_TEXT_LIMIT = 2 * 1024;
const FRONTIER_ATOM_SPAN_LIMIT = 256;
/** Aggregate bytes allowed to cross from SQLite for one frontier projection. */
export const FRONTIER_ATOM_PREFETCH_BYTES = 512 * 1024;
const FRONTIER_ATOM_METADATA_BYTES = 512;
const FRONTIER_ATOM_SCAN_BATCH = 128;
const FRONTIER_ATOM_MAX_SCAN = 4_096;
const EPISODE_VIEW_META_NAME_LIMIT = 512;
const DEMO_PACKET_JSON_LIMIT = 128 * 1024;
/** Maximum assistant rows incorporated by one startup summary pass. */
const MODEL_SUMMARY_BACKFILL_BATCH = 512;

/** Candidate rowids a search overfetches per requested row, and per widening. */
const FTS_OVERFETCH = 8;
/** No search reads fewer candidates than this, however small its `limit`. */
const FTS_CANDIDATE_FLOOR = 256;
/**
 * Widenings before a tie set is conceded and the unbounded statement runs.
 * Four takes the candidate window past a million rows; a widening costs one
 * more index scan and no row seeks, so it is always the cheaper guess.
 */
const FTS_CANDIDATE_WIDENINGS = 4;

/** What the bounded search path adds to a projection to prove its own page. */
interface FtsProbe {
  fts_score: number;
  fts_count: number;
  fts_worst: number;
}

/** Migration-only keyset page; unlike online ranges this exhausts a dense seq. */
const ATOM_MIGRATION_BATCH = 128;
/** Durable global cursor row for atom-name rebuild. */
export const ATOM_NAME_MIGRATION_CURSOR = "__pylos_atom_name_rebuild__";
/** Atom rows indexed by one startup open. */
export const ATOM_NAME_MIGRATION_ROWS_PER_OPEN = 1_024;
/** Normal threads visited by one startup open. */
export const ATOM_NAME_MIGRATION_THREADS_PER_OPEN = 128;
/** UTF-8 atom projection bytes hydrated by one startup open. */
export const ATOM_NAME_MIGRATION_BYTES_PER_OPEN = 512 * 1024;
const ATTACHMENT_NAME_MIGRATION_BATCH = 256;
export const ATTACHMENT_NAME_MIGRATION_ROWS_PER_OPEN = 512;
export const ATTACHMENT_NAME_MIGRATION_THREADS_PER_OPEN = 128;
export const ATTACHMENT_NAME_MIGRATION_CURSOR = "__pylos_attachment_name_rebuild__";

function boundedUtf8Prefix(
  value: string | Uint8Array | null | undefined,
  limit: number,
): { text: string; bytes: number } {
  const source =
    typeof value === "string"
      ? Buffer.from(value, "utf8")
      : value === null || value === undefined
        ? Buffer.alloc(0)
        : Buffer.from(value);
  let end = Math.min(source.byteLength, Math.max(0, Math.floor(limit)));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end >= 0) {
    try {
      const text = decoder.decode(source.subarray(0, end));
      return { text, bytes: end };
    } catch {
      // A UTF-8 code point is at most four bytes. Backtracking is bounded by
      // the decoder, and the returned range always re-encodes byte-exactly.
      end -= 1;
    }
  }
  return { text: "", bytes: 0 };
}

function boundedEpisodeColumns(alias: string): string {
  const q = alias.length === 0 ? "" : `${alias}.`;
  return [
    `${q}seq`,
    `${q}thread_id`,
    `${q}ts`,
    `${q}role`,
    `${q}model`,
    `${q}provider`,
    `substr(${q}content, 1, ?) AS content_prefix`,
    `length(CAST(${q}content AS BLOB)) AS content_bytes`,
    `${q}content_hash`,
    `${q}tokens`,
    `${q}prev_hash`,
    `${q}hash`,
    `CASE WHEN length(CAST(${q}meta AS BLOB)) <= ? THEN ${q}meta ELSE NULL END AS meta_json`,
    `length(CAST(${q}meta AS BLOB)) AS meta_bytes`,
    `CASE WHEN length(CAST(${q}meta AS BLOB)) <= ${DEFAULT_EPISODE_VIEW_META_LIMIT} AND json_valid(${q}meta) = 1 ` +
      `THEN json_extract(${q}meta, '$.removed') ELSE NULL END AS meta_removed`,
    `CASE WHEN length(CAST(${q}meta AS BLOB)) <= ${DEFAULT_EPISODE_VIEW_META_LIMIT} AND json_valid(${q}meta) = 1 ` +
      `THEN substr(json_extract(${q}meta, '$.name'), 1, ${EPISODE_VIEW_META_NAME_LIMIT}) ELSE NULL END AS meta_name`,
    `CASE WHEN length(CAST(${q}meta AS BLOB)) <= ${DEFAULT_EPISODE_VIEW_META_LIMIT} AND json_valid(${q}meta) = 1 ` +
      `THEN json_extract(${q}meta, '$.size') ELSE NULL END AS meta_size`,
  ].join(", ");
}

export interface FrontierAtomCandidates {
  atoms: Atom[];
  /** Bytes of bounded prefixes hydrated into the compiler heap. */
  bytes: number;
  /** True when a keyset continuation or byte-budget stop remains. */
  hasMore: boolean;
  /** Number of bounded metadata rows read by this candidate page. */
  scanned: number;
}

export interface FrontierAtomCandidateOptions {
  phase?: AtomPhase;
  kinds?: string[];
  pinned?: boolean;
  limit?: number;
  byteBudget?: number;
}

interface FrontierAtomMetadataRow {
  reader_rowid: number;
  valid_from_seq: number;
  key_bytes: number;
  value_bytes: number;
  text_bytes: number;
  source_span_bytes: number;
}

function frontierAtomBytes(row: FrontierAtomMetadataRow): number {
  return (
    FRONTIER_ATOM_METADATA_BYTES +
    Math.min(Math.max(0, row.key_bytes), FRONTIER_ATOM_KEY_LIMIT) +
    Math.min(Math.max(0, row.value_bytes), FRONTIER_ATOM_VALUE_LIMIT) +
    Math.min(Math.max(0, row.text_bytes), FRONTIER_ATOM_TEXT_LIMIT) +
    Math.min(Math.max(0, row.source_span_bytes), FRONTIER_ATOM_SPAN_LIMIT)
  );
}

/**
 * Explicit atom projection for ordinary search. SQLite evaluates the match
 * against the full indexed text, but only bounded prefixes cross into the JS
 * heap. In particular, never use `SELECT * FROM atom` on the reader path: a
 * valid imported atom may carry a large value or quoted text.
 */
function boundedAtomColumns(alias: string): string {
  const q = alias.length === 0 ? "" : `${alias}.`;
  return [
    `${q}id`,
    `${q}thread_id`,
    `substr(${q}kind, 1, 32) AS kind`,
    `substr(${q}key, 1, 512) AS key_prefix`,
    `length(CAST(${q}key AS BLOB)) AS key_bytes`,
    `substr(${q}value, 1, 2048) AS value_prefix`,
    `length(CAST(${q}value AS BLOB)) AS value_bytes`,
    `substr(${q}text, 1, 2048) AS text_prefix`,
    `length(CAST(${q}text AS BLOB)) AS text_bytes`,
    `${q}source_seq`,
    `substr(${q}source_span, 1, 256) AS source_span_prefix`,
    `${q}valid_from_seq`,
    `${q}valid_to_seq`,
    `${q}superseded_by`,
    `substr(${q}phase, 1, 16) AS phase`,
    `substr(${q}authority, 1, 16) AS authority`,
    `substr(${q}scope, 1, 256) AS scope`,
    `${q}pinned`,
    `${q}confidence`,
    `substr(${q}created_by, 1, 256) AS created_by`,
    `${q}created_at`,
  ].join(", ");
}

function toBoundedAtom(row: AtomViewRow, textLimit: number, valueLimit: number): Atom {
  const key = boundedUtf8Prefix(row.key_prefix ?? "", 512);
  const value = boundedUtf8Prefix(row.value_prefix ?? "", valueLimit);
  const text = boundedUtf8Prefix(row.text_prefix ?? "", textLimit);
  let sourceSpan: string | null = null;
  if (row.source_span_prefix !== null) {
    try {
      const parsed = JSON.parse(row.source_span_prefix) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        typeof parsed[0] === "number" &&
        typeof parsed[1] === "number" &&
        Number.isSafeInteger(parsed[0]) &&
        Number.isSafeInteger(parsed[1])
      ) {
        sourceSpan = JSON.stringify(parsed);
      }
    } catch {
      // A malformed derived locator is not allowed to break the bounded
      // search response; omit it and leave source bytes to the kernel.
    }
  }
  const atom = toAtom({
    id: row.id,
    thread_id: row.thread_id,
    kind: row.kind,
    key: key.text,
    value: value.text,
    text: text.text,
    source_seq: row.source_seq,
    source_span: sourceSpan,
    valid_from_seq: row.valid_from_seq,
    valid_to_seq: row.valid_to_seq,
    superseded_by: row.superseded_by,
    phase: row.phase,
    authority: row.authority,
    scope: row.scope,
    pinned: row.pinned,
    confidence: row.confidence,
    created_by: row.created_by,
    created_at: row.created_at,
  });
  return {
    ...atom,
    keyBytes: row.key_bytes,
    keyTruncated: row.key_bytes > Buffer.byteLength(key.text, "utf8"),
    valueBytes: row.value_bytes,
    valueTruncated: row.value_bytes > value.bytes,
    textBytes: row.text_bytes,
    textTruncated: row.text_bytes > text.bytes,
  } as Atom;
}

function boundedAtomPageColumns(alias: string): string {
  const q = alias.length === 0 ? "" : `${alias}.`;
  return [
    `${q}id`,
    `${q}thread_id`,
    `substr(${q}kind, 1, 32) AS kind`,
    `substr(CAST(${q}key AS BLOB), 1, ${MAX_ATOM_KEY_BYTES}) AS key_prefix`,
    `length(CAST(${q}key AS BLOB)) AS key_bytes`,
    `substr(CAST(${q}value AS BLOB), 1, ${MAX_ATOM_VALUE_BYTES}) AS value_prefix`,
    `length(CAST(${q}value AS BLOB)) AS value_bytes`,
    `substr(CAST(${q}text AS BLOB), 1, ${MAX_ATOM_TEXT_BYTES}) AS text_prefix`,
    `length(CAST(${q}text AS BLOB)) AS text_bytes`,
    `${q}source_seq`,
    `${q}valid_from_seq`,
    `${q}valid_to_seq`,
    `substr(${q}phase, 1, 16) AS phase`,
    `substr(${q}authority, 1, 16) AS authority`,
    `${q}pinned`,
  ].join(", ");
}

function toAtomView(row: AtomPageRow): AtomView {
  const key = boundedUtf8Prefix(row.key_prefix, MAX_ATOM_KEY_BYTES);
  const value = boundedUtf8Prefix(row.value_prefix, MAX_ATOM_VALUE_BYTES);
  const text = boundedUtf8Prefix(row.text_prefix, MAX_ATOM_TEXT_BYTES);
  return {
    id: row.id,
    threadId: row.thread_id,
    kind: row.kind as Atom["kind"],
    key: key.text,
    value: value.text,
    text: text.text,
    sourceSeq: row.source_seq,
    validFromSeq: row.valid_from_seq,
    ...(row.valid_to_seq === null ? {} : { validToSeq: row.valid_to_seq }),
    phase: row.phase as AtomPhase,
    authority: row.authority as AtomAuthority,
    pinned: row.pinned === 1,
    keyBytes: row.key_bytes,
    valueBytes: row.value_bytes,
    textBytes: row.text_bytes,
    ...(row.key_bytes > key.bytes ? { keyTruncated: true } : {}),
    ...(row.value_bytes > value.bytes ? { valueTruncated: true } : {}),
    ...(row.text_bytes > text.bytes ? { textTruncated: true } : {}),
  };
}

function toCapsuleView(row: CapsuleViewRow): CapsuleView {
  return {
    id: row.id,
    threadId: row.thread_id,
    level: row.level,
    fromSeq: row.from_seq,
    toSeq: row.to_seq,
    droppedCount: row.dropped_count,
    keptCount: row.kept_count,
    carriedCount: row.carried_count,
    hash: row.hash,
    createdBy: row.created_by,
    createdAt: row.created_at,
    textBytes: row.text_bytes,
    droppedBytes: row.dropped_bytes,
    keptBytes: row.kept_bytes,
    ...(row.text_bytes > 0 ? { textTruncated: true } : {}),
    ...(row.dropped_bytes > 0 ? { droppedTruncated: true } : {}),
    ...(row.kept_bytes > 0 ? { keptTruncated: true } : {}),
  };
}

function boundedCapsuleColumns(alias: string): string {
  const q = alias.length === 0 ? "" : `${alias}.`;
  return [
    `${q}id`,
    `${q}thread_id`,
    `${q}level`,
    `${q}from_seq`,
    `${q}to_seq`,
    `${q}tokens`,
    `${q}carried_count`,
    `${q}hash`,
    `substr(${q}created_by, 1, 256) AS created_by`,
    `${q}created_at`,
    `length(CAST(${q}text AS BLOB)) AS text_bytes`,
    `length(CAST(${q}dropped AS BLOB)) AS dropped_bytes`,
    `length(CAST(${q}kept AS BLOB)) AS kept_bytes`,
    `CASE WHEN ${q}ledger_receipt IS NOT NULL AND json_valid(${q}ledger_receipt) = 1 ` +
      `AND json_type(${q}ledger_receipt, '$.dropped.count') = 'integer' ` +
      `THEN json_extract(${q}ledger_receipt, '$.dropped.count') ` +
      `WHEN length(CAST(${q}dropped AS BLOB)) <= ${MAX_DERIVED_RESPONSE_BYTES} ` +
      `AND json_valid(${q}dropped) = 1 AND json_type(${q}dropped) = 'array' ` +
      `THEN json_array_length(${q}dropped) ELSE -1 END AS dropped_count`,
    `CASE WHEN ${q}ledger_receipt IS NOT NULL AND json_valid(${q}ledger_receipt) = 1 ` +
      `AND json_type(${q}ledger_receipt, '$.kept.count') = 'integer' ` +
      `THEN json_extract(${q}ledger_receipt, '$.kept.count') ` +
      `WHEN length(CAST(${q}kept AS BLOB)) <= ${MAX_DERIVED_RESPONSE_BYTES} ` +
      `AND json_valid(${q}kept) = 1 AND json_type(${q}kept) = 'array' ` +
      `THEN json_array_length(${q}kept) ELSE -1 END AS kept_count`,
  ].join(", ");
}

function toLossView(row: LossViewRow): LossEntryView {
  const name = boundedUtf8Prefix(row.name_prefix, MAX_LEDGER_NAME_BYTES);
  const capsule = boundedUtf8Prefix(row.capsule_id_prefix, 256);
  const resolved = boundedUtf8Prefix(row.resolved_by_prefix, 256);
  const span = boundedUtf8Prefix(row.span_prefix, MAX_LEDGER_SPAN_BYTES);
  let parsedSpan: [number, number] | undefined;
  if (row.span_prefix !== null && row.span_bytes <= span.bytes) {
    try {
      const candidate = JSON.parse(span.text) as unknown;
      if (
        Array.isArray(candidate) &&
        candidate.length === 2 &&
        Number.isSafeInteger(candidate[0]) &&
        Number.isSafeInteger(candidate[1]) &&
        (candidate[0] as number) >= 0 &&
        (candidate[1] as number) >= candidate[0]
      ) {
        parsedSpan = [candidate[0] as number, candidate[1] as number];
      }
    } catch {
      // A malformed derived locator remains visible as an unresolved shape,
      // never as an authority-bearing span.
    }
  }
  return {
    name: name.text,
    kind: row.kind as LossEntry["kind"],
    seq: row.seq,
    ...(parsedSpan === undefined ? {} : { span: parsedSpan }),
    ...(capsule.text.length > 0 ? { capsuleId: capsule.text } : {}),
    ...(resolved.text.length > 0 ? { resolvedBy: resolved.text } : {}),
    nameBytes: row.name_bytes,
    ...(row.name_bytes > name.bytes ? { nameTruncated: true } : {}),
    ...(row.span_prefix === null ? {} : { spanBytes: row.span_bytes }),
    ...(row.span_prefix !== null && row.span_bytes > span.bytes ? { spanTruncated: true } : {}),
  };
}

function boundedLossColumns(alias: string): string {
  const q = alias.length === 0 ? "" : `${alias}.`;
  return [
    `${q}rowid AS reader_rowid`,
    `substr(CAST(${q}name AS BLOB), 1, ${MAX_LEDGER_NAME_BYTES}) AS name_prefix`,
    `length(CAST(${q}name AS BLOB)) AS name_bytes`,
    `${q}kind`,
    `${q}seq`,
    `substr(CAST(${q}span AS BLOB), 1, ${MAX_LEDGER_SPAN_BYTES}) AS span_prefix`,
    `COALESCE(length(CAST(${q}span AS BLOB)), 0) AS span_bytes`,
    `substr(CAST(${q}capsule_id AS BLOB), 1, 256) AS capsule_id_prefix`,
    `substr(CAST(${q}resolved_by AS BLOB), 1, 256) AS resolved_by_prefix`,
  ].join(", ");
}

function encodeReaderCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeReaderRowid(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0 || value.length > 256) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { rowid?: unknown };
    return typeof decoded.rowid === "number" && Number.isSafeInteger(decoded.rowid) && decoded.rowid > 0
      ? decoded.rowid
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeCapsuleLedgerCursor(
  value: string | undefined,
): { capsuleId: string; capsuleHash: string; part: "dropped" | "kept"; after: number } | undefined {
  if (value === undefined || value.length === 0 || value.length > 1024) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      decoded.version !== 1 ||
      typeof decoded.capsuleId !== "string" ||
      typeof decoded.capsuleHash !== "string" ||
      (decoded.part !== "dropped" && decoded.part !== "kept") ||
      !Number.isSafeInteger(decoded.after) ||
      (decoded.after as number) < -1
    ) {
      return undefined;
    }
    return {
      capsuleId: decoded.capsuleId,
      capsuleHash: decoded.capsuleHash,
      part: decoded.part,
      after: decoded.after as number,
    };
  } catch {
    return undefined;
  }
}

function decodeCapsuleCursor(
  value: string | undefined,
): { level: number; fromSeq: number; rowid: number } | undefined {
  if (value === undefined || value.length === 0 || value.length > 256) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      level?: unknown;
      fromSeq?: unknown;
      rowid?: unknown;
    };
    if (
      typeof decoded.level === "number" &&
      Number.isSafeInteger(decoded.level) &&
      typeof decoded.fromSeq === "number" &&
      Number.isSafeInteger(decoded.fromSeq) &&
      typeof decoded.rowid === "number" &&
      Number.isSafeInteger(decoded.rowid) &&
      decoded.rowid > 0
    ) {
      return { level: decoded.level, fromSeq: decoded.fromSeq, rowid: decoded.rowid };
    }
  } catch {
    // The caller turns an invalid opaque cursor into a bounded request error.
  }
  return undefined;
}

function toEpisodeView(row: EpisodeViewRow, contentLimit: number, metaLimit: number): EpisodeView {
  const prefix = boundedUtf8Prefix(row.content_prefix ?? "", contentLimit);
  let meta: EpisodeMeta = {};
  if (row.meta_json !== null) {
    try {
      meta = JSON.parse(row.meta_json) as EpisodeMeta;
    } catch {
      meta = {};
    }
  }
  let metaTruncated = row.meta_bytes > metaLimit;
  if (typeof meta.name === "string" && Buffer.byteLength(meta.name, "utf8") > EPISODE_VIEW_META_NAME_LIMIT) {
    meta.name = boundedUtf8Prefix(meta.name, EPISODE_VIEW_META_NAME_LIMIT).text;
    metaTruncated = true;
  }
  if (row.meta_removed !== null) meta.removed = row.meta_removed === 1;
  if (row.meta_name !== null) meta.name = row.meta_name;
  if (row.meta_size !== null && Number.isFinite(row.meta_size)) meta.size = row.meta_size;
  const source = `episode:${row.seq}`;
  const truncated = row.content_bytes > prefix.bytes;
  const removed = meta.removed === true;
  const metadataComplete = row.meta_json !== null && row.meta_bytes <= metaLimit;
  return {
    threadId: row.thread_id,
    seq: row.seq,
    ts: row.ts,
    role: row.role,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    content: prefix.text,
    tokens: row.tokens,
    prevHash: row.prev_hash,
    hash: row.hash,
    meta,
    contentBytes: row.content_bytes,
    contentTruncated: truncated,
    ...(removed
      ? { originalContentHash: row.content_hash, locatorOmittedReason: "removed" as const }
      : !metadataComplete
        ? { locatorOmittedReason: "metadata-truncated" as const }
        : {
            locator: {
              source,
              byteRange: [0, prefix.bytes] as [number, number],
              contentHash: row.content_hash,
              revision: row.hash,
            },
          }),
    ...(truncated && !removed && metadataComplete
      ? { continuation: { source, from: prefix.bytes, to: row.content_bytes, fullBytes: row.content_bytes } }
      : {}),
    metaBytes: row.meta_bytes,
    metaTruncated,
  };
}

function parseBoundedPacketJson<T>(value: string | null, limit: number): T | undefined {
  if (value === null || Buffer.byteLength(value, "utf8") > limit) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

interface DemoPacketProjectionRow {
  id: string;
  thread_id: string;
  turn_seq: number;
  model: string;
  budget: number;
  tokens: number;
  digest: string;
  status: string;
  pages_json: string | null;
  pages_bytes: number;
  coverage_json: string | null;
  coverage_bytes: number | null;
  answer_receipt_json: string | null;
  answer_receipt_bytes: number | null;
  created_at: number;
}

function toBoundedDemoPacket(row: DemoPacketProjectionRow): Packet | null {
  if (packetTokensFailure(row.tokens, row.budget) !== null) return null;
  const pages = parseBoundedPacketJson<Packet["pages"]>(row.pages_json, DEMO_PACKET_JSON_LIMIT);
  if (!Array.isArray(pages)) return null;
  const coverage = parseBoundedPacketJson<Packet["coverage"]>(row.coverage_json, DEMO_PACKET_JSON_LIMIT);
  const answerReceipt = parseBoundedPacketJson<Packet["answerReceipt"]>(
    row.answer_receipt_json,
    DEMO_PACKET_JSON_LIMIT,
  );
  if (row.coverage_bytes !== null && coverage === undefined) return null;
  if (row.answer_receipt_bytes !== null && answerReceipt === undefined) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    turnSeq: row.turn_seq,
    model: row.model,
    budget: row.budget,
    tokens: row.tokens,
    digest: row.digest,
    status: row.status as Packet["status"],
    messages: [],
    resident: [],
    ledger: {} as Packet["ledger"],
    pages,
    ...(coverage === undefined ? {} : { coverage }),
    ...(answerReceipt === undefined ? {} : { answerReceipt }),
    createdAt: row.created_at,
  };
}

export interface VaultOptions {
  /** Profile directory; defaults to `$PYLOS_HOME` or `~/.pylos`. */
  home?: string;
  /** Explicit database file (overrides `home/vault.sqlite`). */
  file?: string;
  /** `synchronous=NORMAL` instead of FULL. Allowed for the bench only. */
  fast?: boolean;
  readonly?: boolean;
}

/** What the caller supplies to append an episode; the vault computes the rest. */
export interface EpisodeInput {
  role: Role;
  content: string;
  model?: string;
  provider?: string;
  ts?: number;
  meta?: EpisodeMeta;
  /** Raw attachment bytes; stored content-addressed and referenced from meta. */
  blob?: { bytes: Uint8Array; mime?: string; name?: string };
}

/** Immutable meta keys the chain has always covered (KERNEL A5). */
const CHAINED_META = ["blob", "mime", "name", "size", "from", "to"] as const;
/** The turn's receipts, chained since KERNEL A10.3. */
const CHAINED_RECEIPTS = ["packetId", "check", "roundsDigest"] as const;

/**
 * `meta_hash` (KERNEL A5, A10.3). `usage` and `pages` are never picked: they are
 * provider-reported and may be back-filled. The receipt keys are picked only for
 * episodes that carry a `roundsDigest` — the marker of an episode written under
 * A10.3 — so an archive written before this amendment hashes exactly as it did
 * and existing chains still verify.
 */
export function metaHashOf(meta: EpisodeMeta): string {
  const keys: string[] = [...CHAINED_META];
  // v1 bundles had no manifest in the chain record. Imports annotate those
  // legacy whole-blob episodes with `legacy: true` so the receipt is explicit
  // without rewriting an otherwise valid historical hash chain.
  if (meta.manifest !== undefined && meta.manifest.legacy !== true) keys.push("manifest");
  if (meta.roundsDigest !== undefined) keys.push(...CHAINED_RECEIPTS);
  // A coverage receipt and the final answer receipt digest are kernel-produced
  // witnesses.  Bind them when present, while leaving every older meta hash
  // unchanged when neither field exists.
  if (meta.coverage !== undefined) keys.push("coverage");
  if (meta.answerReceiptDigest !== undefined) keys.push("answerReceiptDigest");
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = meta[key];
    if (value !== undefined) picked[key] = value;
  }
  return canonicalHash(picked);
}

/** The record the chain hashes. Integers and strings only, no floats. */
export function chainRecord(input: {
  seq: number;
  ts: number;
  role: string;
  model?: string;
  provider?: string;
  contentHash: string;
  metaHash: string;
}): Record<string, unknown> {
  return {
    v: 1,
    seq: input.seq,
    ts: input.ts,
    role: input.role,
    model: input.model ?? "",
    provider: input.provider ?? "",
    content_hash: input.contentHash,
    meta_hash: input.metaHash,
  };
}

/** A capsule plus its `kept` name index (internal; not part of the protocol type). */
export interface StoredCapsule extends Capsule {
  /** Names still visible in this capsule's text, with their deepest locators. */
  kept: LossEntry[];
}

/** The record of one removal (KERNEL §8, A10.6). */
export interface Tombstone {
  id: string;
  threadId: string;
  /** What the user asked to remove: `seqs:…`, `range:…` or `atoms:…`. */
  target: string;
  reason: string;
  createdAt: number;
  /** Seq of the `system` episode that records this removal; 0 for legacy rows. */
  removalSeq: Seq;
  /** Assistant episodes that carry a routing name of the removed text. */
  echoes: Seq[];
}

export interface AppendResult {
  episode: Episode;
  headSeq: Seq;
  headHash: string;
}

interface SemanticGenerationRow {
  id: string;
  thread_id: string;
  status: string;
  indexed: number;
  eligible: number;
  reason: string | null;
  watermark_seq: number;
  gaps: number;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** Validate the one token-budget invariant shared by settings, compile, and turns. */
export function checkedBudget(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_THREAD_BUDGET) {
    throw new VaultError(`thread budget must be an integer from 1 through ${MAX_THREAD_BUDGET}`);
  }
  return value as number;
}

/** Validate model identifiers before they can enter a packet or provider request. */
export function checkedModel(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_THREAD_MODEL_BYTES) {
    throw new VaultError(`thread model exceeds the ${MAX_THREAD_MODEL_BYTES}-byte UTF-8 limit`);
  }
  return value;
}

function assertThreadTitle(title: string): void {
  if (Buffer.byteLength(title, "utf8") > MAX_THREAD_TITLE_BYTES) {
    throw new VaultError(`Thread title exceeds the ${MAX_THREAD_TITLE_BYTES}-byte UTF-8 limit.`);
  }
}

/**
 * Caller-supplied thread identity. Reproducible fixtures (the benches) need the
 * genesis hash, and so every packet digest and head hash above it, to depend on
 * the seed alone rather than on `newId` entropy and the wall clock.
 */
export interface ThreadProvenance {
  id?: string;
  createdAt?: number;
}

const THREAD_ID_RE = /^th_[A-Za-z0-9_-]{1,127}$/u;

/** Validate a caller-chosen thread id against the shape `newId("th")` mints. */
function checkedThreadId(value: unknown): string {
  if (typeof value !== "string" || !THREAD_ID_RE.test(value)) {
    throw new VaultError("thread id must be th_ followed by 1 to 127 characters from [A-Za-z0-9_-]");
  }
  return value;
}

function checkedThreadCreatedAt(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new VaultError("thread createdAt must be a non-negative integer millisecond timestamp");
  }
  return value as number;
}

function canonicalThreadSettings(settings: ThreadSettings): string {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new VaultError("thread settings must be an object");
  }
  if (settings.model !== undefined) {
    checkedModel(settings.model);
  }
  if (settings.budget !== undefined) checkedBudget(settings.budget);
  if (settings.shares !== undefined) {
    const failure = budgetSharesFailure(settings.shares);
    if (failure !== null) throw new VaultError(`thread settings ${failure}`);
  }
  let serialized: string;
  try {
    serialized = canonicalJson(settings);
  } catch (error) {
    throw new VaultError(error instanceof Error ? error.message : "thread settings are malformed");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_THREAD_SETTINGS_BYTES) {
    throw new VaultError("thread settings exceed their UTF-8 byte limit");
  }
  return serialized;
}

/** Scalar packet fields needed by thread statistics; large JSON columns stay in SQLite. */
export interface PacketSummary {
  tokens: number;
  budget: number;
  pages: number;
  digest: string;
}

export type PacketPreflightStatus = "ok" | "missing" | "oversized" | "malformed";

interface PacketPreflightRow {
  thread_id?: unknown;
  budget: unknown;
  tokens: unknown;
  model_bytes: unknown;
  messages_bytes: unknown;
  resident_bytes: unknown;
  ledger_bytes: unknown;
  pages_bytes: unknown;
  rounds_bytes: unknown;
  reachability_bytes: unknown;
  coverage_bytes: unknown;
  evidence_bytes: unknown;
  answer_receipt_bytes: unknown;
  semantic_bytes: unknown;
  messages_valid: unknown;
  resident_valid: unknown;
  ledger_valid: unknown;
  pages_valid: unknown;
  rounds_valid: unknown;
  reachability_valid: unknown;
  coverage_valid: unknown;
  evidence_valid: unknown;
  answer_receipt_valid: unknown;
  semantic_valid: unknown;
}

function packetPreflightSelect(): string {
  const jsonColumns = [
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
  const lengths = jsonColumns.map(
    (column) =>
      `COALESCE(length(CAST(${column} AS BLOB)), 0) AS ${column === "answer_receipt" ? "answer_receipt" : column}_bytes`,
  );
  const valid = jsonColumns.map(
    (column) =>
      `CASE WHEN ${column} IS NULL THEN 1 WHEN length(CAST(${column} AS BLOB)) <= ${
        column === "messages" ? MAX_PACKET_MESSAGES_BYTES : MAX_PACKET_JSON_BYTES
      } THEN json_valid(${column}) ELSE 0 END AS ${column === "answer_receipt" ? "answer_receipt" : column}_valid`,
  );
  return [
    "thread_id",
    "budget",
    "tokens",
    "length(CAST(model AS BLOB)) AS model_bytes",
    ...lengths,
    ...valid,
  ].join(", ");
}

function packetPreflight(row: PacketPreflightRow | null | undefined): PacketPreflightStatus {
  if (row === null || row === undefined) return "missing";
  if (packetTokensFailure(row.tokens, row.budget) !== null) return "malformed";
  const otherLengths = [
    row.resident_bytes,
    row.ledger_bytes,
    row.pages_bytes,
    row.rounds_bytes,
    row.reachability_bytes,
    row.coverage_bytes,
    row.evidence_bytes,
    row.answer_receipt_bytes,
    row.semantic_bytes,
  ];
  if (
    typeof row.model_bytes !== "number" ||
    !Number.isSafeInteger(row.model_bytes) ||
    row.model_bytes < 0 ||
    row.model_bytes > MAX_THREAD_MODEL_BYTES ||
    otherLengths.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > MAX_PACKET_JSON_BYTES,
    ) ||
    typeof row.messages_bytes !== "number" ||
    !Number.isSafeInteger(row.messages_bytes) ||
    row.messages_bytes < 0 ||
    row.messages_bytes > MAX_PACKET_MESSAGES_BYTES
  ) {
    return "oversized";
  }
  const messageBytes =
    typeof row.messages_bytes === "number" ? row.messages_bytes : MAX_PACKET_RESPONSE_BYTES;
  const aggregateLengths = [messageBytes, ...otherLengths];
  const aggregate = aggregateLengths.reduce<number>(
    (sum, value) => sum + (typeof value === "number" ? value : MAX_PACKET_RESPONSE_BYTES),
    0,
  );
  if (aggregate > MAX_PACKET_RESPONSE_BYTES) return "oversized";
  const valid = [
    row.messages_valid,
    row.resident_valid,
    row.ledger_valid,
    row.pages_valid,
    row.rounds_valid,
    row.reachability_valid,
    row.coverage_valid,
    row.evidence_valid,
    row.answer_receipt_valid,
    row.semantic_valid,
  ];
  return valid.every((value) => value === 1) ? "ok" : "malformed";
}

/** Serialize packet JSON before SQLite sees it, so an oversized object is never
 * made durable and cannot wait for a later read-side preflight to discover it. */
function serializePacketJson(value: unknown, cap: number, field: string): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new VaultError(
      `packet ${field} is not JSON-serializable: ${error instanceof Error ? error.message : "malformed"}`,
    );
  }
  if (serialized === undefined) throw new VaultError(`packet ${field} is not JSON-serializable`);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > cap) throw new VaultError(`packet ${field} exceeds ${cap} JSON bytes`);
  return serialized;
}

/** Check the serialized packet envelope before a write can make it durable. */
function assertPacketAggregateBytes(values: readonly unknown[]): void {
  let aggregate = 0;
  for (const value of values) {
    const bytes =
      typeof value === "string"
        ? Buffer.byteLength(value, "utf8")
        : value === null || value === undefined
          ? 0
          : value;
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) {
      throw new VaultError("packet JSON column length is malformed");
    }
    aggregate += bytes as number;
  }
  if (aggregate > MAX_PACKET_RESPONSE_BYTES) {
    throw new VaultError(`packet JSON aggregate exceeds ${MAX_PACKET_RESPONSE_BYTES} bytes`);
  }
}

function packetJsonFields(packet: Packet): {
  messages: string;
  resident: string;
  ledger: string;
  pages: string;
  rounds: string;
  reachability: string | null;
  coverage: string | null;
  evidence: string | null;
  answerReceipt: string | null;
  semantic: string | null;
} {
  const messages = serializePacketJson(packet.messages, MAX_PACKET_MESSAGES_BYTES, "messages");
  const resident = serializePacketJson(packet.resident, MAX_PACKET_JSON_BYTES, "resident");
  const ledger = serializePacketJson(packet.ledger, MAX_PACKET_JSON_BYTES, "ledger");
  const pages = serializePacketJson(packet.pages, MAX_PACKET_JSON_BYTES, "pages");
  const roundsValue = packet.rounds ?? [];
  const roundsFailure = packetRoundsFailure(roundsValue, packet.budget);
  if (roundsFailure !== null) throw new VaultError(roundsFailure);
  const rounds = serializePacketJson(roundsValue, MAX_PACKET_JSON_BYTES, "rounds");
  const optional = (value: unknown, field: string): string | null =>
    value === undefined ? null : serializePacketJson(value, MAX_PACKET_JSON_BYTES, field);
  const reachability = optional(packet.reachability, "reachability");
  const coverage = optional(packet.coverage, "coverage");
  const evidence = optional(packet.evidence, "evidence");
  const answerReceipt = optional(packet.answerReceipt, "answer_receipt");
  const semantic = optional(packet.semantic, "semantic");
  assertPacketAggregateBytes([
    messages,
    resident,
    ledger,
    pages,
    rounds,
    reachability,
    coverage,
    evidence,
    answerReceipt,
    semantic,
  ]);
  return {
    messages,
    resident,
    ledger,
    pages,
    rounds,
    reachability,
    coverage,
    evidence,
    answerReceipt,
    semantic,
  };
}

interface PacketSummaryRow {
  tokens: unknown;
  budget: unknown;
  page_count: unknown;
  digest: unknown;
}

function toPacketSummary(row: PacketSummaryRow | null | undefined): PacketSummary | null {
  if (row === null || row === undefined) return null;
  if (
    packetTokensFailure(row.tokens, row.budget) !== null ||
    typeof row.page_count !== "number" ||
    !Number.isSafeInteger(row.page_count) ||
    row.page_count < 0 ||
    typeof row.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(row.digest)
  ) {
    return null;
  }
  return {
    tokens: row.tokens as number,
    budget: row.budget as number,
    pages: row.page_count,
    digest: row.digest,
  };
}

/** Resolve the profile directory: explicit → `$PYLOS_HOME` → `~/.pylos`. */
export function pylosHome(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.PYLOS_HOME;
  if (env && env.length > 0) return env;
  return join(homedir(), ".pylos");
}

export class Vault {
  readonly db: Database;
  readonly home: string;
  readonly file: string;
  readonly objectsDir: string;
  readonly semanticRuntime: SemanticRuntime | null;
  readonly semanticProbe: SemanticRuntimeProbe;
  private readonly statements = new Map<string, Statement>();
  private depth = 0;
  private savepointCounter = 0;
  /** Derived routing reads may be used while an incremental repair is active. */
  private migrationDerivedReadDepth = 0;
  /** Promotions survive nested `tx()` calls until the outer SQL commit. */
  private readonly pendingBlobPromotions: BlobPromotion[] = [];

  constructor(options: VaultOptions = {}) {
    // `setCustomSQLite` is process-global and must happen before the first
    // connection. Missing or invalid resources become a semantic receipt; the
    // exact archive and FTS5 continue on Bun's built-in SQLite.
    prepareSemanticSqlite();
    this.home = pylosHome(options.home);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.objectsDir = join(this.home, "objects");
    mkdirSync(this.objectsDir, { recursive: true, mode: 0o700 });
    this.file = options.file ?? join(this.home, "vault.sqlite");
    this.db = new Database(this.file, { create: true, readwrite: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA synchronous = ${options.fast === true ? "NORMAL" : "FULL"}`);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA temp_store = MEMORY");
    this.db.exec("PRAGMA cache_size = -32000");
    this.migrate();
    this.resumeThreadModelBackfill();
    recoverImportStages(this.objectsDir);
    recoverBlobPromotions(
      this.objectsDir,
      (hash) => this.db.query("SELECT size FROM blob WHERE hash = ?").get(hash) as { size: number } | null,
    );
    recoverBlobDeletionsBatched(this.objectsDir, (hashes) => this.liveBlobReferences(hashes));
    // Keep the deletion journal available even when optional semantic
    // extensions are absent. Forgetting removes ordinary metadata now and
    // retries native vector cleanup after a capable reopen.
    ensureSemanticDurableTables(this.db as unknown as SemanticSqlDatabase);
    const semantic = openKernelSemanticRuntime(this.db);
    this.semanticRuntime = semantic.runtime;
    this.semanticProbe = semantic.probe;
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Filesystems without POSIX modes still hold the data correctly.
    }
  }

  /**
   * Resolve deletion-journal hashes against one immutable startup snapshot.
   * Blob rows are checked in bounded IN batches first because a committed row
   * is itself a retention witness.  Only hashes absent from that table need
   * the live-episode scan, which parses each metadata row at most once rather
   * than once per staged object.
   */
  private liveBlobReferences(hashes: readonly string[]): ReadonlyMap<string, { size: number | null } | null> {
    const references = new Map<string, { size: number | null } | null>();
    if (hashes.length === 0) return references;

    const wanted = new Set(hashes);
    const blobSizes = new Map<string, number | null>();
    const hashBatchSize = 512;
    for (let offset = 0; offset < hashes.length; offset += hashBatchSize) {
      const batch = hashes.slice(offset, offset + hashBatchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .query(`SELECT hash, size FROM blob WHERE hash IN (${placeholders})`)
        .all(...batch) as Array<{ hash: string; size: number | null }>;
      for (const row of rows) {
        if (!wanted.has(row.hash)) continue;
        blobSizes.set(
          row.hash,
          Number.isSafeInteger(row.size) && (row.size as number) >= 0 ? row.size : null,
        );
      }
    }
    for (const hash of hashes) {
      // A row is authoritative even when no surviving episode has published
      // its reference yet (the append/promotion crash window).
      if (blobSizes.has(hash)) references.set(hash, { size: blobSizes.get(hash) ?? null });
    }

    const unresolved = new Set(hashes.filter((hash) => !references.has(hash)));
    if (unresolved.size > 0) {
      const scanBatchSize = 256;
      const wantedHashes = [...unresolved];
      const wantedJson = JSON.stringify(wantedHashes);
      let afterRowid = 0;
      let afterSpan = -1;
      const rowsQuery = this.db.query(
        "WITH metadata AS (" +
          "SELECT rowid AS episode_rowid, " +
          "json_valid(meta) AS meta_valid, " +
          "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.removed') IN ('true', 'false', 'integer') " +
          "THEN json_extract(meta, '$.removed') ELSE NULL END AS removed, " +
          "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.blob') = 'text' " +
          "AND length(CAST(json_extract(meta, '$.blob') AS BLOB)) = 64 " +
          "THEN json_extract(meta, '$.blob') ELSE NULL END AS blob, " +
          "CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.blob') ELSE NULL END AS blob_type, " +
          "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.blob') = 'text' " +
          "THEN length(CAST(json_extract(meta, '$.blob') AS BLOB)) ELSE NULL END AS blob_bytes, " +
          "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.size') IN ('integer', 'real') " +
          "THEN json_extract(meta, '$.size') ELSE NULL END AS size, " +
          "CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.manifest') ELSE NULL END AS manifest_type, " +
          "CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.manifest.spans') ELSE NULL END AS spans_type, " +
          "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.manifest.spans') = 'array' " +
          "THEN json_extract(meta, '$.manifest.spans') ELSE '[]' END AS spans_json " +
          "FROM episode" +
          "), candidates AS (" +
          "SELECT episode_rowid, meta_valid, removed, blob, blob_type, blob_bytes, size, manifest_type, spans_type, " +
          "-1 AS span_index, NULL AS span_hash, NULL AS span_hash_type, NULL AS span_hash_bytes, " +
          "NULL AS span_from, NULL AS span_to " +
          "FROM metadata " +
          "WHERE episode_rowid > ? OR (episode_rowid = ? AND -1 > ?) " +
          "UNION ALL " +
          "SELECT m.episode_rowid, m.meta_valid, m.removed, m.blob, m.blob_type, m.blob_bytes, m.size, m.manifest_type, m.spans_type, " +
          "CAST(s.key AS INTEGER) AS span_index, " +
          "CASE WHEN json_type(s.value, '$.objectHash') = 'text' " +
          "AND length(CAST(json_extract(s.value, '$.objectHash') AS BLOB)) = 64 " +
          "THEN json_extract(s.value, '$.objectHash') ELSE NULL END AS span_hash, " +
          "json_type(s.value, '$.objectHash') AS span_hash_type, " +
          "CASE WHEN json_type(s.value, '$.objectHash') = 'text' " +
          "THEN length(CAST(json_extract(s.value, '$.objectHash') AS BLOB)) ELSE NULL END AS span_hash_bytes, " +
          "CASE WHEN json_type(s.value, '$.from') IN ('integer', 'real') " +
          "THEN json_extract(s.value, '$.from') ELSE NULL END AS span_from, " +
          "CASE WHEN json_type(s.value, '$.to') IN ('integer', 'real') " +
          "THEN json_extract(s.value, '$.to') ELSE NULL END AS span_to " +
          "FROM metadata m JOIN json_each(m.spans_json) s ON true " +
          "WHERE m.meta_valid = 1 AND COALESCE(m.removed, 0) != 1 " +
          "AND (EXISTS (SELECT 1 FROM json_each(?) wanted WHERE wanted.value = json_extract(s.value, '$.objectHash')) " +
          "OR COALESCE(json_type(s.value, '$.objectHash') != 'text', 1) = 1 " +
          "OR COALESCE(length(CAST(json_extract(s.value, '$.objectHash') AS BLOB)) != 64, 1) = 1 " +
          "OR COALESCE(json_extract(s.value, '$.objectHash') GLOB '*[^0-9a-f]*', 1) = 1) " +
          "AND (m.episode_rowid > ? OR (m.episode_rowid = ? AND CAST(s.key AS INTEGER) > ?))" +
          ") SELECT episode_rowid, meta_valid, removed, blob, blob_type, blob_bytes, size, manifest_type, spans_type, " +
          "span_index, span_hash, span_hash_type, span_hash_bytes, span_from, span_to FROM candidates " +
          "ORDER BY episode_rowid ASC, span_index ASC LIMIT ?",
      );
      while (unresolved.size > 0) {
        const rows = rowsQuery.all(
          afterRowid,
          afterRowid,
          afterSpan,
          wantedJson,
          afterRowid,
          afterRowid,
          afterSpan,
          scanBatchSize,
        ) as Array<{
          episode_rowid: number;
          meta_valid: number;
          removed: unknown;
          blob: unknown;
          blob_type: unknown;
          blob_bytes: unknown;
          size: unknown;
          manifest_type: unknown;
          spans_type: unknown;
          span_index: number;
          span_hash: unknown;
          span_hash_type: unknown;
          span_hash_bytes: unknown;
          span_from: unknown;
          span_to: unknown;
        }>;
        if (rows.length === 0) break;
        for (const row of rows) {
          if (
            !Number.isSafeInteger(row.episode_rowid) ||
            row.episode_rowid < afterRowid ||
            (row.episode_rowid === afterRowid && row.span_index <= afterSpan)
          ) {
            throw new Error("invalid episode rowid during blob deletion recovery");
          }
          afterRowid = row.episode_rowid;
          afterSpan = row.span_index;
          if (row.meta_valid !== 1) {
            throw new VaultError("episode metadata is malformed during blob deletion recovery");
          }
          if (
            row.blob_type !== null &&
            (row.blob_type !== "text" ||
              row.blob_bytes !== 64 ||
              typeof row.blob !== "string" ||
              !/^[0-9a-f]{64}$/u.test(row.blob))
          ) {
            throw new VaultError("attachment object hash is malformed during blob deletion recovery");
          }
          if (row.manifest_type !== null && row.manifest_type !== "object") {
            throw new VaultError("attachment manifest is malformed during blob deletion recovery");
          }
          if (row.manifest_type === "object" && row.spans_type !== null && row.spans_type !== "array") {
            throw new VaultError("attachment manifest spans are malformed during blob deletion recovery");
          }
          if (
            row.span_index >= 0 &&
            (row.span_hash_type !== "text" ||
              row.span_hash_bytes !== 64 ||
              typeof row.span_hash !== "string" ||
              !/^[0-9a-f]{64}$/u.test(row.span_hash))
          ) {
            throw new VaultError("attachment span object hash is malformed during blob deletion recovery");
          }
          if (row.removed === 1) continue;
          if (row.span_index < 0 && typeof row.blob === "string" && unresolved.has(row.blob)) {
            references.set(row.blob, {
              size: Number.isSafeInteger(row.size) && (row.size as number) >= 0 ? (row.size as number) : null,
            });
            unresolved.delete(row.blob);
          }
          if (row.span_index >= 0 && typeof row.span_hash === "string" && unresolved.has(row.span_hash)) {
            const spanFrom = Number.isSafeInteger(row.span_from) ? (row.span_from as number) : -1;
            const spanTo = Number.isSafeInteger(row.span_to) ? (row.span_to as number) : -1;
            const spanSize = spanFrom >= 0 && spanTo >= spanFrom ? spanTo - spanFrom : -1;
            references.set(row.span_hash, {
              size: spanSize >= 0 ? spanSize : null,
            });
            unresolved.delete(row.span_hash);
          }
        }
        if (rows.length < scanBatchSize) break;
      }
    }
    for (const hash of hashes) {
      // Explicit null decisions are required for every requested hash.  The
      // deletion reconciler will then validate and remove only an object that
      // has no row or live episode witness.
      if (!references.has(hash)) references.set(hash, null);
    }
    return references;
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at INTEGER NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migration_progress (" +
        "thread_id TEXT NOT NULL, name TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, " +
        "status TEXT NOT NULL, PRIMARY KEY(thread_id, name))",
    );
    const applied = new Set(
      (this.db.query("SELECT name FROM migration").all() as Array<{ name: string }>).map((r) => r.name),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) continue;
      // Migration 006 is the historical FTS5 rebuild. Its `INSERT ... rebuild`
      // remains a one-time archive index build; atom authority/name readiness
      // below is independently resumable and does not claim to bound that
      // legacy FTS operation.
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .query("INSERT INTO migration (name, applied_at) VALUES (?, ?)")
          .run(migration.name, Date.now());
      })();
    }
    this.continueMigrationsForOpen();
  }

  /**
   * Advance each resumable derived migration by one bounded pass without
   * reopening the database. Startup invokes the same pass once; callers that
   * receive a fail-closed readiness result can explicitly continue it in the
   * foreground/background and observe the durable progress rows between calls.
   * No call performs an unbounded archive walk.
   */
  continueMigrations(): void {
    // A turn/compile may already be inside its rollback-safe preflight
    // transaction. Savepoints cannot make migration progress durable when the
    // caller rolls that transaction back, so the production retry path invokes
    // this before entering tx; direct callers inside tx simply re-check below.
    if (this.depth > 0) return;
    this.continueMigrationsForOpen();
  }

  private continueMigrationsForOpen(): void {
    if (!this.migrationReady(AUTHORITY_REPLAY)) this.replayAuthority();
    if (!this.migrationReady(ATOM_NAME_REBUILD)) this.rebuildAtomNames();
    if (
      this.db.query("SELECT 1 FROM migration WHERE name = ? LIMIT 1").get(ATTACHMENT_NAME_REBUILD) === null
    ) {
      this.rebuildAttachmentNames();
    }
  }

  /**
   * Advance the assistant-model summary by one bounded row batch. Migration
   * 018 deliberately installs the cursor and triggers without joining the
   * archive, so opening a legacy million-turn profile never performs a global
   * rebuild. New appends are captured by the triggers while old rows catch up;
   * `complete=0` remains an explicit, durable qualification for the partial
   * model history returned by stats.
   */
  private resumeThreadModelBackfill(): void {
    const marker = this.db
      .query("SELECT after_rowid, complete FROM thread_model_backfill WHERE id = 1")
      .get() as { after_rowid: number; complete: number } | null;
    if (
      marker === null ||
      marker.complete === 1 ||
      !Number.isSafeInteger(marker.after_rowid) ||
      marker.after_rowid < 0
    ) {
      return;
    }

    this.db.transaction(() => {
      const rows = this.db
        .query(
          "SELECT rowid, thread_id, role, " +
            "CASE WHEN length(CAST(model AS BLOB)) <= ? THEN model ELSE NULL END AS model, " +
            "length(CAST(model AS BLOB)) AS model_bytes " +
            "FROM episode WHERE rowid > ? " +
            "ORDER BY rowid ASC LIMIT ?",
        )
        .all(MAX_THREAD_MODEL_BYTES, marker.after_rowid, MODEL_SUMMARY_BACKFILL_BATCH) as Array<{
        rowid: number;
        thread_id: string;
        role: string;
        model: string | null;
        model_bytes: number | null;
      }>;
      const afterRowid = rows.at(-1)?.rowid ?? marker.after_rowid;
      const complete = rows.length < MODEL_SUMMARY_BACKFILL_BATCH ? 1 : 0;
      const ensureState = this.db.query(
        "INSERT OR IGNORE INTO thread_model_state (thread_id, oversized_count) VALUES (?, 0)",
      );
      const addOversized = this.db.query(
        "UPDATE thread_model_state SET oversized_count = oversized_count + 1 WHERE thread_id = ?",
      );
      const insertModel = this.db.query(
        "INSERT INTO thread_model (thread_id, model, first_rowid) VALUES (?, ?, ?) " +
          "ON CONFLICT(thread_id, model) DO UPDATE SET first_rowid = MIN(thread_model.first_rowid, excluded.first_rowid)",
      );
      for (const row of rows) {
        if (row.role !== "assistant") continue;
        ensureState.run(row.thread_id);
        if (
          typeof row.model_bytes === "number" &&
          Number.isSafeInteger(row.model_bytes) &&
          row.model_bytes > MAX_THREAD_MODEL_BYTES
        ) {
          addOversized.run(row.thread_id);
        } else if (typeof row.model === "string" && row.model_bytes !== null) {
          insertModel.run(row.thread_id, row.model, row.rowid);
        }
      }
      this.db
        .query("UPDATE thread_model_backfill SET after_rowid = ?, complete = ? WHERE id = 1")
        .run(afterRowid, complete);
    })();
  }

  /**
   * KERNEL A10.5. Not expressible in SQL: what an atom is allowed to do depends
   * on the rules, so the repair is to run them again over the exact episodes.
   * Authority discovery itself is resumable: each normal thread gets a
   * `(source_seq,id)` atom cursor, so a clean million-row thread also obeys the
   * same row/byte envelope. A poisoned thread then swaps that scan cursor for
   * replay progress and is rebuilt in bounded episode pages across opens.
   */
  private replayAuthority(): void {
    const global = this.db
      .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY) as { cursor: number; status: string } | null;
    if (global?.status === "complete") {
      this.db
        .query("INSERT OR IGNORE INTO migration (name, applied_at) VALUES (?, ?)")
        .run(AUTHORITY_REPLAY, Date.now());
      return;
    }
    if (global === null) {
      this.db
        .query("INSERT INTO migration_progress (thread_id, name, cursor, status) VALUES (?, ?, 0, 'partial')")
        .run(AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY);
    }

    let afterThreadRowid = global?.cursor ?? 0;
    let remainingRows = AUTHORITY_REPLAY_ROWS_PER_OPEN;
    let remainingBytes = AUTHORITY_REPLAY_BYTES_PER_OPEN;
    let remainingThreads = AUTHORITY_REPLAY_THREADS_PER_OPEN;
    const threads = this.authorityMigrationThreads(afterThreadRowid, remainingThreads);
    for (const thread of threads) {
      if (remainingRows <= 0 || remainingBytes <= 0 || remainingThreads <= 0) break;
      remainingThreads -= 1;
      const threadProgress = this.db
        .query("SELECT cursor, cursor_text, status FROM migration_progress WHERE thread_id = ? AND name = ?")
        .get(thread.id, AUTHORITY_REPLAY) as {
        cursor: number;
        cursor_text: string;
        status: string;
      } | null;
      if (threadProgress?.status === "complete") {
        afterThreadRowid = thread.rowid;
        this.db
          .query("UPDATE migration_progress SET cursor = ? WHERE thread_id = ? AND name = ?")
          .run(afterThreadRowid, AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY);
        continue;
      }
      if (threadProgress?.status === "partial") {
        const page = replayAtomsBounded(this, thread.id, {
          maxRows: remainingRows,
          maxBytes: remainingBytes,
        });
        remainingRows -= page.rows;
        remainingBytes -= page.bytes;
        if (!page.complete) break;
        afterThreadRowid = thread.rowid;
        this.db
          .query("UPDATE migration_progress SET cursor = ? WHERE thread_id = ? AND name = ?")
          .run(afterThreadRowid, AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY);
        continue;
      }
      if (threadProgress?.status === "replay-pending") {
        this.db
          .query("DELETE FROM migration_progress WHERE thread_id = ? AND name = ?")
          .run(thread.id, AUTHORITY_REPLAY);
        if (remainingRows <= 0 || remainingBytes <= 0) break;
        const page = replayAtomsBounded(this, thread.id, {
          maxRows: remainingRows,
          maxBytes: remainingBytes,
        });
        remainingRows -= page.rows;
        remainingBytes -= page.bytes;
        if (!page.complete) break;
        afterThreadRowid = thread.rowid;
        this.db
          .query("UPDATE migration_progress SET cursor = ? WHERE thread_id = ? AND name = ?")
          .run(afterThreadRowid, AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY);
        continue;
      }
      if (threadProgress?.status === "incomplete") {
        // A bounded prefix was insufficient to run the exact atom rules. Keep
        // this thread and the global authority marker unresolved; a later
        // exact-stream implementation may resume it without exposing a false
        // complete frontier today.
        break;
      }

      // Scan only scalar authority/role fields. The exact keyset is persisted
      // separately from replay's sequence cursor, so a clean thread never
      // hydrates episode prose merely to prove it is clean.
      const scanCursor = threadProgress?.cursor ?? 0;
      const scanId = threadProgress?.cursor_text ?? "";
      const scanLimit = Math.max(1, Math.min(remainingRows, AUTHORITY_REPLAY_ROWS_PER_OPEN));
      const scanRows = this.db
        .query(
          "SELECT a.source_seq, a.id, a.authority, e.role " +
            "FROM atom a JOIN episode e ON e.thread_id = a.thread_id AND e.seq = a.source_seq " +
            "WHERE a.thread_id = ? " +
            "AND (a.source_seq > ? OR (a.source_seq = ? AND a.id > ?)) " +
            "ORDER BY a.source_seq ASC, a.id ASC LIMIT ?",
        )
        .all(thread.id, scanCursor, scanCursor, scanId, scanLimit + 1) as Array<{
        source_seq: number;
        id: string;
        authority: string;
        role: string;
      }>;
      const scanned: typeof scanRows = [];
      let scanBytes = 0;
      for (const row of scanRows.slice(0, scanLimit)) {
        const rowBytes = Buffer.byteLength(row.id) + 32;
        if (scanned.length > 0 && scanBytes + rowBytes > remainingBytes) break;
        scanned.push(row);
        scanBytes += rowBytes;
      }
      if (scanned.length === 0 && scanRows[0] !== undefined) {
        scanned.push(scanRows[0]);
        scanBytes = Buffer.byteLength(scanRows[0].id) + 32;
      }
      const poisoned = scanned.some(
        (row) => row.authority === "user" && (row.role === "assistant" || row.role === "tool"),
      );
      remainingRows -= scanned.length;
      remainingBytes -= scanBytes;
      const scanHasMore = scanRows.length > scanned.length;
      if (poisoned) {
        this.db
          .query("DELETE FROM migration_progress WHERE thread_id = ? AND name = ?")
          .run(thread.id, AUTHORITY_REPLAY);
        if (remainingRows <= 0 || remainingBytes <= 0) {
          this.db
            .query(
              "INSERT INTO migration_progress (thread_id, name, cursor, status) VALUES (?, ?, 0, 'replay-pending')",
            )
            .run(thread.id, AUTHORITY_REPLAY);
          break;
        }
        const page = replayAtomsBounded(this, thread.id, {
          maxRows: remainingRows,
          maxBytes: remainingBytes,
        });
        remainingRows -= page.rows;
        remainingBytes -= page.bytes;
        if (!page.complete) break;
        afterThreadRowid = thread.rowid;
        this.db
          .query("UPDATE migration_progress SET cursor = ? WHERE thread_id = ? AND name = ?")
          .run(afterThreadRowid, AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY);
        continue;
      }
      if (scanned.length > 0) {
        const last = scanned.at(-1) as { source_seq: number; id: string };
        if (scanHasMore) {
          this.db
            .query(
              "INSERT INTO migration_progress (thread_id, name, cursor, cursor_text, status) VALUES (?, ?, ?, ?, 'scan') " +
                "ON CONFLICT(thread_id, name) DO UPDATE SET cursor = excluded.cursor, cursor_text = excluded.cursor_text, status = 'scan'",
            )
            .run(thread.id, AUTHORITY_REPLAY, last.source_seq, last.id);
          break;
        }
      }
      this.db
        .query(
          "INSERT OR IGNORE INTO migration_progress (thread_id, name, cursor, status) VALUES (?, ?, 0, 'complete')",
        )
        .run(thread.id, AUTHORITY_REPLAY);
      afterThreadRowid = thread.rowid;
      this.db
        .query("UPDATE migration_progress SET cursor = ? WHERE thread_id = ? AND name = ?")
        .run(afterThreadRowid, AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY);
    }

    const next = this.authorityMigrationThreads(afterThreadRowid, 1);
    if (next.length === 0) {
      this.db
        .query("UPDATE migration_progress SET status = 'complete' WHERE thread_id = ? AND name = ?")
        .run(AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY);
      this.db
        .query("INSERT OR IGNORE INTO migration (name, applied_at) VALUES (?, ?)")
        .run(AUTHORITY_REPLAY, Date.now());
    } else {
      this.db
        .query(
          "UPDATE migration_progress SET cursor = ?, status = 'partial' WHERE thread_id = ? AND name = ?",
        )
        .run(afterThreadRowid, AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY);
    }
  }

  /**
   * KERNEL A11.4. `atom_name` is derived, so nothing carries it: a thread
   * imported under 1.1 or 1.2 holds atoms that no question can route to by
   * subject. The global cursor bounds thread probes and the per-thread cursor
   * bounds atom rows. Fragment threads are excluded because their derived rows
   * are authenticated at import and their triggers make mutation illegal.
   */
  private rebuildAtomNames(): void {
    // Do not build a second projection over a replay that has not yet reached a
    // stable authority frontier. The global readiness check below remains false
    // until both migrations have committed their completion markers.
    if (!this.migrationReady(AUTHORITY_REPLAY)) return;

    const global = this.db
      .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(ATOM_NAME_MIGRATION_CURSOR, ATOM_NAME_REBUILD) as { cursor: number; status: string } | null;
    if (global?.status === "complete") {
      this.db
        .query("INSERT OR IGNORE INTO migration (name, applied_at) VALUES (?, ?)")
        .run(ATOM_NAME_REBUILD, Date.now());
      return;
    }
    if (global === null) {
      this.db
        .query("INSERT INTO migration_progress (thread_id, name, cursor, status) VALUES (?, ?, 0, 'partial')")
        .run(ATOM_NAME_MIGRATION_CURSOR, ATOM_NAME_REBUILD);
    }

    let afterThreadRowid = global?.cursor ?? 0;
    let remainingRows = ATOM_NAME_MIGRATION_ROWS_PER_OPEN;
    let remainingBytes = ATOM_NAME_MIGRATION_BYTES_PER_OPEN;
    let remainingThreads = ATOM_NAME_MIGRATION_THREADS_PER_OPEN;
    const threads = this.atomNameMigrationThreads(afterThreadRowid, remainingThreads);
    for (const thread of threads) {
      if (remainingRows <= 0 || remainingBytes <= 0 || remainingThreads <= 0) break;
      remainingThreads -= 1;
      const progress = this.db
        .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
        .get(thread.id, ATOM_NAME_REBUILD) as { cursor: number; status: string } | null;
      if (progress?.status === "complete") {
        afterThreadRowid = thread.rowid;
        continue;
      }
      if (progress === null) {
        // A pre-progress vault may already contain a partial derived index. It
        // is cheaper and safer to rebuild it than to mistake one row for a
        // complete route set.
        this.tx(() => {
          this.db.query("DELETE FROM atom_name WHERE thread_id = ?").run(thread.id);
          this.db
            .query(
              "INSERT INTO migration_progress (thread_id, name, cursor, status) VALUES (?, ?, 0, 'partial')",
            )
            .run(thread.id, ATOM_NAME_REBUILD);
        });
      }

      let current = progress?.cursor ?? 0;
      for (;;) {
        if (remainingRows <= 0 || remainingBytes <= 0) break;
        const page = this.atoms.atomNameMigrationPage(
          thread.id,
          1,
          thread.headSeq,
          current,
          Math.min(ATOM_MIGRATION_BATCH, remainingRows),
          remainingBytes,
        );
        if (page.rows.length > 0) {
          this.tx(() => {
            for (const row of page.rows) this.atoms.indexNamesForMigration(row);
            this.db
              .query("UPDATE migration_progress SET cursor = ?, status = ? WHERE thread_id = ? AND name = ?")
              .run(
                page.nextRowid ?? current,
                page.hasMore ? "partial" : "complete",
                thread.id,
                ATOM_NAME_REBUILD,
              );
          });
          remainingRows -= page.rows.length;
          remainingBytes -= page.bytes;
          current = page.nextRowid ?? current;
          if (page.hasMore) continue;
        } else {
          this.db
            .query("UPDATE migration_progress SET status = 'complete' WHERE thread_id = ? AND name = ?")
            .run(thread.id, ATOM_NAME_REBUILD);
        }
        break;
      }
      const state = this.db
        .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
        .get(thread.id, ATOM_NAME_REBUILD) as { cursor: number; status: string } | null;
      if (state?.status !== "complete") break;
      afterThreadRowid = thread.rowid;
      this.db
        .query("UPDATE migration_progress SET cursor = ? WHERE thread_id = ? AND name = ?")
        .run(afterThreadRowid, ATOM_NAME_MIGRATION_CURSOR, ATOM_NAME_REBUILD);
    }

    const next = this.atomNameMigrationThreads(afterThreadRowid, 1);
    if (next.length === 0) {
      this.db
        .query("UPDATE migration_progress SET status = 'complete' WHERE thread_id = ? AND name = ?")
        .run(ATOM_NAME_MIGRATION_CURSOR, ATOM_NAME_REBUILD);
      this.db
        .query("INSERT OR IGNORE INTO migration (name, applied_at) VALUES (?, ?)")
        .run(ATOM_NAME_REBUILD, Date.now());
      return;
    }
    this.db
      .query("UPDATE migration_progress SET cursor = ?, status = 'partial' WHERE thread_id = ? AND name = ?")
      .run(afterThreadRowid, ATOM_NAME_MIGRATION_CURSOR, ATOM_NAME_REBUILD);
  }

  /** Bounded keyset walk for normal (non-fragment) migration threads. */
  private atomNameMigrationThreads(
    afterRowid: number,
    limit: number,
  ): Array<{ rowid: number; id: string; headSeq: Seq }> {
    return this.db
      .query(
        "SELECT t.rowid, t.id, t.head_seq AS headSeq FROM thread t " +
          "WHERE t.rowid > ? AND NOT EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = t.id) " +
          "ORDER BY t.rowid ASC LIMIT ?",
      )
      .all(afterRowid, limit) as Array<{ rowid: number; id: string; headSeq: Seq }>;
  }

  /** Bounded keyset walk for authority candidates; clean vaults never call it. */
  private authorityMigrationThreads(
    afterRowid: number,
    limit: number,
  ): Array<{ rowid: number; id: string; headSeq: Seq }> {
    return this.db
      .query(
        "SELECT t.rowid, t.id, t.head_seq AS headSeq FROM thread t " +
          "WHERE t.rowid > ? AND NOT EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = t.id) " +
          "ORDER BY t.rowid ASC LIMIT ?",
      )
      .all(afterRowid, limit) as Array<{ rowid: number; id: string; headSeq: Seq }>;
  }

  /** True only after a migration's global completion marker is durable. */
  private migrationReady(name: string): boolean {
    const cursor = name === AUTHORITY_REPLAY ? AUTHORITY_REPLAY_CURSOR : ATOM_NAME_MIGRATION_CURSOR;
    const progress = this.db
      .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(cursor, name) as { status: string } | null;
    return progress?.status === "complete";
  }

  private atomRoutingReady(): boolean {
    if (this.migrationDerivedReadsAllowed()) return true;
    return this.migrationReady(AUTHORITY_REPLAY) && this.migrationReady(ATOM_NAME_REBUILD);
  }

  /**
   * A partial authority replay has a deliberately incomplete atom table. Any
   * authoritative consumer must refuse that table until the global marker is
   * complete; this is separate from the name-index readiness check.
   */
  atomAuthorityReady(_threadId?: string): boolean {
    return this.migrationDerivedReadsAllowed() || this.migrationReady(AUTHORITY_REPLAY);
  }

  /** True only when both derived atom projections have global completion markers. */
  atomDerivedReady(_threadId?: string): boolean {
    return (
      this.migrationDerivedReadsAllowed() ||
      (this.migrationReady(AUTHORITY_REPLAY) && this.migrationReady(ATOM_NAME_REBUILD))
    );
  }

  /**
   * Mutators that derive authority state must refuse a partial replay. Returning
   * an empty frontier is safe for a read, but sealing that empty frontier or
   * appending atoms on top of it would make an incomplete migration durable.
   * Startup replay runs inside `withMigrationDerivedReads`, which deliberately
   * permits its own bounded rebuild pages.
   */
  assertAtomAuthorityReady(threadId?: string): void {
    if (!this.atomAuthorityReady(threadId)) {
      throw new VaultError("atom authority migration is incomplete; retry after startup repair");
    }
  }

  assertAtomDerivedReady(threadId?: string): void {
    if (!this.atomAuthorityReady(threadId)) {
      throw new VaultError("atom authority migration is incomplete; retry after startup repair");
    }
    if (!this.migrationDerivedReadsAllowed() && !this.migrationReady(ATOM_NAME_REBUILD)) {
      throw new VaultError("atom name migration is incomplete; retry after startup repair");
    }
  }

  /**
   * Rebuild the write-time attachment filename projection in bounded sequence
   * pages.  Malformed or oversized metadata is deliberately omitted: the
   * immutable episode remains, but an address that cannot be represented by
   * this derived table never authorizes a tail lookup.
   */
  private rebuildAttachmentNames(): void {
    const global = this.db
      .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(ATTACHMENT_NAME_MIGRATION_CURSOR, ATTACHMENT_NAME_REBUILD) as {
      cursor: number;
      status: string;
    } | null;
    if (global?.status === "complete") {
      this.db
        .query("INSERT OR IGNORE INTO migration (name, applied_at) VALUES (?, ?)")
        .run(ATTACHMENT_NAME_REBUILD, Date.now());
      return;
    }
    if (global === null) {
      this.db
        .query("INSERT INTO migration_progress (thread_id, name, cursor, status) VALUES (?, ?, 0, 'partial')")
        .run(ATTACHMENT_NAME_MIGRATION_CURSOR, ATTACHMENT_NAME_REBUILD);
    }
    let afterThreadRowid = global?.cursor ?? 0;
    let remaining = ATTACHMENT_NAME_MIGRATION_ROWS_PER_OPEN;
    let threadBudget = ATTACHMENT_NAME_MIGRATION_THREADS_PER_OPEN;
    const threads = this.attachmentMigrationThreads(afterThreadRowid, threadBudget);
    for (const thread of threads) {
      if (remaining <= 0 || threadBudget <= 0) break;
      threadBudget -= 1;
      const progress = this.db
        .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
        .get(thread.id, ATTACHMENT_NAME_REBUILD) as { cursor: number; status: string } | null;
      if (progress?.status !== "complete") {
        if (progress === null) {
          this.tx(() => {
            this.db.query("DELETE FROM attachment_name WHERE thread_id = ?").run(thread.id);
            this.db
              .query(
                "INSERT INTO migration_progress (thread_id, name, cursor, status) VALUES (?, ?, 0, 'partial')",
              )
              .run(thread.id, ATTACHMENT_NAME_REBUILD);
          });
        }
        let afterSeq = progress?.cursor ?? 0;
        for (; remaining > 0; ) {
          const pageLimit = Math.min(ATTACHMENT_NAME_MIGRATION_BATCH, remaining);
          const rows = this.db
            .query(
              "SELECT seq, role, " +
                "CASE WHEN json_valid(meta) = 1 AND COALESCE(json_extract(meta, '$.removed'), 0) != 1 " +
                "AND length(CAST(meta AS BLOB)) <= ? " +
                "THEN COALESCE(NULLIF(json_extract(meta, '$.name'), ''), json_extract(meta, '$.manifest.name')) END AS name " +
                "FROM episode WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
            )
            .all(BUNDLE_DERIVED_LIMITS.episodeMetaBytes, thread.id, afterSeq, pageLimit + 1) as Array<{
            seq: number;
            role: string;
            name: unknown;
          }>;
          const selected = rows.slice(0, pageLimit);
          if (selected.length === 0) {
            this.db
              .query("UPDATE migration_progress SET status = 'complete' WHERE thread_id = ? AND name = ?")
              .run(thread.id, ATTACHMENT_NAME_REBUILD);
            break;
          }
          this.tx(() => {
            for (const row of selected) {
              if (row.role !== "attachment") continue;
              this.indexAttachmentName(thread.id, row.seq, { name: row.name });
            }
            const cursor = selected.at(-1)?.seq ?? afterSeq;
            this.db
              .query("UPDATE migration_progress SET cursor = ?, status = ? WHERE thread_id = ? AND name = ?")
              .run(
                cursor,
                rows.length > pageLimit ? "partial" : "complete",
                thread.id,
                ATTACHMENT_NAME_REBUILD,
              );
          });
          remaining -= selected.length;
          const cursor = selected.at(-1)?.seq;
          if (cursor === undefined || rows.length <= pageLimit) break;
          afterSeq = cursor;
        }
      }
      const state = this.db
        .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
        .get(thread.id, ATTACHMENT_NAME_REBUILD) as { status: string } | null;
      if (state?.status !== "complete") break;
      afterThreadRowid = thread.rowid;
      this.db
        .query("UPDATE migration_progress SET cursor = ? WHERE thread_id = ? AND name = ?")
        .run(afterThreadRowid, ATTACHMENT_NAME_MIGRATION_CURSOR, ATTACHMENT_NAME_REBUILD);
    }
    const next = this.attachmentMigrationThreads(afterThreadRowid, 1);
    if (next.length === 0) {
      this.db
        .query("UPDATE migration_progress SET status = 'complete' WHERE thread_id = ? AND name = ?")
        .run(ATTACHMENT_NAME_MIGRATION_CURSOR, ATTACHMENT_NAME_REBUILD);
      this.db
        .query("INSERT OR IGNORE INTO migration (name, applied_at) VALUES (?, ?)")
        .run(ATTACHMENT_NAME_REBUILD, Date.now());
      return;
    }
    this.db
      .query("UPDATE migration_progress SET cursor = ?, status = 'partial' WHERE thread_id = ? AND name = ?")
      .run(afterThreadRowid, ATTACHMENT_NAME_MIGRATION_CURSOR, ATTACHMENT_NAME_REBUILD);
  }

  /** Bounded keyset walk for the attachment-name rebuild. Fragments are
   * immutable and intentionally excluded from both work and completion. */
  private attachmentMigrationThreads(
    afterRowid: number,
    limit: number,
  ): Array<{ rowid: number; id: string; headSeq: Seq }> {
    return this.db
      .query(
        "SELECT t.rowid, t.id, t.head_seq AS headSeq FROM thread t " +
          "WHERE t.rowid > ? " +
          "AND NOT EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = t.id) " +
          "ORDER BY t.rowid ASC LIMIT ?",
      )
      .all(afterRowid, limit) as Array<{ rowid: number; id: string; headSeq: Seq }>;
  }

  /** Cached prepared statement. */
  private stmt(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * Persisted question addresses.  These methods are intentionally thin
   * namespaces over the kernel helpers: callers still have to provide a
   * released gate result before `record` can write an active edge.
   */
  readonly addresses = {
    canonicalize: canonicalAddressQuery,
    record: (input: AddressRouteRecordInput) => recordAddressRoute(this, input),
    reuse: (threadId: string, query: string, routerVersion: string, invalidatedBy?: string) =>
      reuseAddressRoute(this, threadId, query, routerVersion, invalidatedBy),
    revalidate: (
      route: Parameters<typeof revalidateAddressRoute>[1],
      options?: Parameters<typeof revalidateAddressRoute>[2],
    ) => revalidateAddressRoute(this, route, options),
    invalidate: (routeId: string, reason: string, status?: "invalidated" | "superseded" | "revoked") =>
      invalidateAddressRoute(this, routeId, reason, status),
    list: (threadId: string, query?: string) => listAddressRoutes(this, threadId, query),
    current: (threadId: string, query: string) => listCurrentAddressRoutes(this, threadId, query),
    get: (threadId: string, routeId: string) => getAddressRoute(this, threadId, routeId),
    active: (threadId: string, query?: string) => listEffectiveAddressRoutes(this, threadId, query),
  };

  /**
   * Model-proposed aliases.  The wrapper fixes authority to `model` in the
   * helper and never calls atom/name indexing; an alias is only an address.
   */
  readonly aliases = {
    propose: (
      threadId: string,
      input: AddressAliasProposal | Record<string, unknown>,
    ): ReturnType<typeof proposeAddressAlias> => {
      const raw = input as Record<string, unknown>;
      const spanValue = raw.span;
      const span: [number, number] = Array.isArray(spanValue)
        ? [Number(spanValue[0]), Number(spanValue[1])]
        : [Number(raw.byteFrom), Number(raw.byteTo)];
      const proposal: AddressAliasProposal = {
        alias: String(raw.alias ?? ""),
        sourceSeq: Number(raw.sourceSeq ?? raw.source_seq),
        span,
        quote: String(raw.quote ?? ""),
        sourceHash: String(raw.sourceHash ?? raw.source_hash ?? ""),
        authority: "model",
      };
      return proposeAddressAlias(this, threadId, proposal);
    },
    list: (threadId: string, alias?: string) => listAddressAliases(this, threadId, alias),
    revalidate: (alias: Parameters<typeof revalidateAddressAlias>[1]) => revalidateAddressAlias(this, alias),
  };

  /**
   * Atom replay must continue to use the current atomizer while its derived
   * routing index is intentionally incomplete. Keep that exception private to
   * the repair call stack; ordinary readers still fail closed globally.
   */
  withMigrationDerivedReads<T>(fn: () => T): T {
    this.migrationDerivedReadDepth += 1;
    try {
      return fn();
    } finally {
      this.migrationDerivedReadDepth -= 1;
    }
  }

  private migrationDerivedReadsAllowed(): boolean {
    return this.migrationDerivedReadDepth > 0;
  }

  /** Run `fn` in a transaction; nested calls use rollback-safe savepoints. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      // Joining the outer SQLite transaction is not enough: a nested append
      // can fail after staging bytes and after publishing some rows. A
      // savepoint lets its caller catch the error and still commit unrelated
      // outer work without retaining a partial episode/blob set.
      const savepoint = `pylos_nested_${this.savepointCounter++}`;
      const pendingStart = this.pendingBlobPromotions.length;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this.depth += 1;
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        } finally {
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
        this.discardPendingBlobPromotionsFrom(pendingStart);
        throw error;
      } finally {
        this.depth -= 1;
      }
    }
    this.depth += 1;
    let sqlCommitted = false;
    try {
      const result = this.db.transaction(fn)();
      sqlCommitted = true;
      // SQLite is now the commit authority. Promotion is synchronous for the
      // normal path, while a kill between these two lines is repaired by the
      // startup `blob-pending` reconciler from the committed blob rows.
      this.commitPendingBlobPromotions();
      return result;
    } catch (error) {
      // Never remove a durable stage after SQL has committed: doing so would
      // publish a row whose object cannot be recovered after a transient
      // promotion failure. A stage left after the commit is intentionally
      // recoverable on the next open.
      if (!sqlCommitted) this.discardPendingBlobPromotions();
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  private commitPendingBlobPromotions(): void {
    // Remove each promotion only after its synchronous rename loop succeeds.
    // If a filesystem error interrupts promotion after SQL commit, the
    // verified stage remains visible to transaction-local readers and can be
    // retried (or recovered on reopen) instead of becoming an unreachable row.
    while (this.pendingBlobPromotions.length > 0) {
      const promotion = this.pendingBlobPromotions[0] as BlobPromotion;
      commitBlobPromotion(promotion);
      this.pendingBlobPromotions.shift();
    }
  }

  private discardPendingBlobPromotions(): void {
    this.discardPendingBlobPromotionsFrom(0);
  }

  private discardPendingBlobPromotionsFrom(start: number): void {
    const promotions = this.pendingBlobPromotions.splice(start);
    for (const promotion of promotions) discardBlobPromotion(promotion);
  }

  /**
   * Atomically hand an already verified import promotion to one root SQL
   * transaction. Transaction-local attachment verification can resolve the
   * private staged paths through `blobObjectPath`; rollback erases them and SQL
   * commit promotes them synchronously. Keeping registration and `tx()` in one
   * call prevents a nested savepoint from missing the promotion in its rollback
   * snapshot, and prevents a caller from registering bytes without transacting.
   */
  txWithPendingBlobPromotion<T>(promotion: BlobPromotion, fn: () => T): T {
    if (this.depth !== 0) throw new VaultError("blob promotion requires a root transaction");
    if (promotion.objectsDir !== this.objectsDir || this.pendingBlobPromotions.includes(promotion)) {
      throw new VaultError("blob promotion does not belong to this vault");
    }
    this.pendingBlobPromotions.push(promotion);
    return this.tx(fn);
  }

  /**
   * Resolve a verified content-addressed object for a kernel read.
   *
   * An attachment append can be nested inside a larger vault transaction. In
   * that window SQLite already exposes the episode/manifest, while its fsynced
   * bytes intentionally remain under `.pending` until the outer SQL commit.
   * Readers owned by this Vault may consume those bytes, but only after the
   * same hash/size check used for canonical objects. No arbitrary caller can
   * turn this into an unverified path lookup.
   */
  blobObjectPath(hash: string, size: number): string | null {
    if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 0) return null;
    const canonical = join(this.objectsDir, hash);
    let canonicalExists = false;
    try {
      lstatSync(canonical);
      canonicalExists = true;
    } catch {
      // A staged object is expected to have no canonical path before commit.
    }
    if (canonicalExists) return verifiedBlobFile(canonical, hash, size) ? canonical : null;

    for (const promotion of this.pendingBlobPromotions) {
      if (promotion.objectsDir !== this.objectsDir || promotion.staged.get(hash) !== size) continue;
      const pending = join(promotion.dir, hash);
      if (verifiedBlobFile(pending, hash, size)) return pending;
    }
    return null;
  }

  /**
   * Validate a canonical object before allowing a new blob row to reference
   * it. A same-hash regular file is safe to deduplicate, but a stale,
   * truncated, non-regular, or symlink path is never silently adopted.
   */
  private stageAttachmentBlob(
    promotion: BlobPromotion,
    bytes: Uint8Array,
    mime: string,
    staged: Map<string, { size: number; mime: string }>,
  ): string {
    const hash = sha256(bytes);
    const path = join(this.objectsDir, hash);
    let canonical = false;
    try {
      const link = lstatSync(path);
      if (!link.isFile() || link.isSymbolicLink() || !verifiedBlobFile(path, hash, bytes.byteLength)) {
        throw new VaultError(`canonical attachment object ${hash} is corrupt or not a regular file`);
      }
      syncVerifiedBlobFile(path, hash, bytes.byteLength);
      canonical = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!canonical) stageBlobBytesForPromotion(promotion, bytes, hash);
    const row = this.stmt("SELECT size FROM blob WHERE hash = ?").get(hash) as { size: number } | null;
    if (row !== null && row.size !== bytes.byteLength) {
      throw new VaultError(`blob row ${hash} has the wrong size`);
    }
    staged.set(hash, { size: bytes.byteLength, mime });
    return hash;
  }

  private ensureSemanticGeneration(threadId: string): SemanticGenerationRow {
    const id = semanticGenerationId(threadId);
    const existing = this.db
      .query("SELECT * FROM semantic_generation WHERE id = ? AND thread_id = ?")
      .get(id, threadId) as SemanticGenerationRow | null;
    if (existing !== null) return existing;
    const thread = this.requireThread(threadId);
    const complete = thread.headSeq === 0;
    this.db
      .query(
        "INSERT INTO semantic_generation " +
          "(id, thread_id, status, model, model_digest, extension_version, indexed, eligible, reason, created_at, watermark_seq, gaps) " +
          "VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 0)",
      )
      .run(
        id,
        threadId,
        complete ? "complete" : "incomplete",
        this.semanticProbe.identity.model.name,
        this.semanticProbe.identity.model.digest,
        this.semanticProbe.identity.sqliteVec.version,
        complete ? null : "existing archive awaits bounded semantic backfill",
        Date.now(),
      );
    return this.db
      .query("SELECT * FROM semantic_generation WHERE id = ? AND thread_id = ?")
      .get(id, threadId) as SemanticGenerationRow;
  }

  private writeSemanticGeneration(
    state: SemanticGenerationRow,
    input: {
      status: "complete" | "incomplete" | "unavailable" | "incompatible";
      watermark: number;
      eligible: number;
      gaps: number;
      indexed: number;
      reason?: string;
    },
  ): SemanticGenerationRow {
    this.db
      .query(
        "UPDATE semantic_generation SET status = ?, indexed = ?, eligible = ?, reason = ?, " +
          "watermark_seq = ?, gaps = ? WHERE id = ? AND thread_id = ?",
      )
      .run(
        input.status,
        input.indexed,
        input.eligible,
        input.reason ?? null,
        input.watermark,
        input.gaps,
        state.id,
        state.thread_id,
      );
    return {
      ...state,
      status: input.status,
      indexed: input.indexed,
      eligible: input.eligible,
      reason: input.reason ?? null,
      watermark_seq: input.watermark,
      gaps: input.gaps,
    };
  }

  private semanticReceiptForState(state: SemanticGenerationRow): SemanticReceipt {
    const runtime = this.semanticRuntime;
    if (runtime === null || !runtime.operational) return this.semanticProbe.receipt;
    const complete = state.status === "complete" && state.gaps === 0;
    const receipt = runtime.receiptFor(state.thread_id, complete ? state.eligible : undefined);
    if (complete || receipt.status === "unavailable" || receipt.status === "incompatible") return receipt;
    return {
      ...receipt,
      status: "incomplete",
      reason:
        state.gaps > 0
          ? `semantic index has ${state.gaps} bounded source gap${state.gaps === 1 ? "" : "s"}`
          : `semantic backfill is complete through episode ${state.watermark_seq}`,
    };
  }

  private indexSemanticAppends(threadId: string, episodes: readonly Episode[]): void {
    if (episodes.length === 0) return;
    let state = this.ensureSemanticGeneration(threadId);
    const runtime = this.semanticRuntime;
    if (runtime === null || !runtime.operational) {
      this.writeSemanticGeneration(state, {
        status: this.semanticProbe.receipt.status === "incompatible" ? "incompatible" : "unavailable",
        watermark: state.watermark_seq,
        eligible: state.eligible,
        gaps: state.gaps,
        indexed: state.indexed,
        reason: this.semanticProbe.receipt.reason ?? "semantic runtime is unavailable",
      });
      return;
    }
    let watermark = state.watermark_seq;
    let eligible = state.eligible;
    let gaps = state.gaps;
    for (const episode of episodes) {
      const plan = semanticIndexPlan(episode);
      const result = runtime.indexBatch(plan.spans);
      const success =
        result.processed === plan.spans.length &&
        result.indexed === plan.spans.length &&
        result.rejected.length === 0 &&
        result.truncated === 0;
      if (!success) break;
      // Only a contiguous cursor can certify coverage. New rows may still be
      // indexed while an older archive is catching up; the backfill will count
      // those exact duplicate spans when it reaches them.
      if (episode.seq !== watermark + 1) continue;
      watermark = episode.seq;
      eligible += plan.spans.length + (plan.truncated ? 1 : 0);
      if (plan.truncated) gaps += 1;
    }
    const head = this.requireThread(threadId).headSeq;
    const complete = watermark >= head && gaps === 0;
    const receipt = runtime.receiptFor(threadId, complete ? eligible : undefined);
    state = this.writeSemanticGeneration(state, {
      status: complete ? "complete" : "incomplete",
      watermark,
      eligible,
      gaps,
      indexed: receipt.indexed ?? state.indexed,
      ...(complete ? {} : { reason: `semantic backfill is complete through episode ${watermark}` }),
    });
    void state;
  }

  private backfillSemantic(threadId: string, throughSeq: Seq): SemanticGenerationRow {
    let state = this.ensureSemanticGeneration(threadId);
    const runtime = this.semanticRuntime;
    if (runtime === null || !runtime.operational || state.watermark_seq >= throughSeq) return state;
    const rows = this.episodes
      .list(threadId, { after: state.watermark_seq, limit: SEMANTIC_BACKFILL_EPISODES })
      .filter((episode) => episode.seq <= throughSeq);
    const plans: Array<{ episode: Episode; plan: ReturnType<typeof semanticIndexPlan> }> = [];
    const spans: ReturnType<typeof semanticIndexPlan>["spans"] = [];
    for (const episode of rows) {
      const plan = semanticIndexPlan(episode);
      if (spans.length > 0 && spans.length + plan.spans.length > 64) break;
      plans.push({ episode, plan });
      spans.push(...plan.spans);
    }
    if (plans.length === 0) return state;
    const result = runtime.indexBatch(spans);
    if (
      result.processed !== spans.length ||
      result.indexed !== spans.length ||
      result.rejected.length > 0 ||
      result.truncated > 0
    ) {
      return this.writeSemanticGeneration(state, {
        status: "incomplete",
        watermark: state.watermark_seq,
        eligible: state.eligible,
        gaps: state.gaps,
        indexed: runtime.receiptFor(threadId).indexed ?? state.indexed,
        reason: "semantic backfill failed closed before advancing its cursor",
      });
    }
    let eligible = state.eligible;
    let gaps = state.gaps;
    for (const { plan } of plans) {
      eligible += plan.spans.length + (plan.truncated ? 1 : 0);
      if (plan.truncated) gaps += 1;
    }
    const watermark = plans.at(-1)?.episode.seq ?? state.watermark_seq;
    const complete = watermark >= throughSeq && gaps === 0;
    const receipt = runtime.receiptFor(threadId, complete ? eligible : undefined);
    state = this.writeSemanticGeneration(state, {
      status: complete ? "complete" : "incomplete",
      watermark,
      eligible,
      gaps,
      indexed: receipt.indexed ?? state.indexed,
      ...(complete
        ? {}
        : {
            reason:
              gaps > 0
                ? `semantic index has ${gaps} bounded source gap${gaps === 1 ? "" : "s"}`
                : `semantic backfill is complete through episode ${watermark}`,
          }),
    });
    return state;
  }

  /** Bounded check-time refresh followed by a thread-partitioned address query. */
  semanticRoute(
    threadId: string,
    query: string,
    throughSeq: Seq,
    limit = 8,
  ): { hits: SemanticHit[]; receipt: SemanticReceipt } {
    const runtime = this.semanticRuntime;
    let state = this.ensureSemanticGeneration(threadId);
    if (runtime === null || !runtime.operational) {
      return { hits: [], receipt: this.semanticProbe.receipt };
    }
    state = this.backfillSemantic(threadId, throughSeq);
    return {
      // The asking turn is indexed at write time for future questions, but it
      // can never be its own evidence address in this packet (A10.1).
      hits: runtime
        .search(threadId, query, { limit: limit + 1 })
        .filter((hit) => hit.seq !== throughSeq)
        .slice(0, limit),
      receipt: this.semanticReceiptForState(state),
    };
  }

  semanticStatus(threadId: string): SemanticReceipt {
    return this.semanticReceiptForState(this.ensureSemanticGeneration(threadId));
  }

  /** Remove a derived address in the caller's transaction; exact bytes remain authoritative. */
  removeSemanticSource(threadId: string, seq: Seq): void {
    const state = this.ensureSemanticGeneration(threadId);
    const runtime = this.semanticRuntime;
    if (runtime === null || !runtime.operational) {
      // The metadata table is ordinary SQLite and remains deletable when the
      // native vec0 module is absent.  A durable journal row prevents a later
      // resource restore from resurrecting the orphaned vector address.
      const durable = removeSemanticMetadata(this.db as unknown as SemanticSqlDatabase, threadId, seq);
      this.writeSemanticGeneration(state, {
        status: "unavailable",
        watermark: state.watermark_seq,
        eligible: Math.max(0, state.eligible - durable.metadataRemoved),
        gaps: state.gaps,
        indexed: Math.max(0, state.indexed - durable.metadataRemoved),
        reason: "semantic metadata removed; native vector cleanup pending",
      });
      return;
    }
    const result = runtime.remove(threadId, seq);
    if (result.status === "unavailable") {
      // An operational runtime must never silently downgrade a failed delete.
      // Let forget's outer transaction abort instead of committing a tombstone
      // while a native row remains.
      throw new VaultError(result.reason ?? "semantic deletion is unavailable");
    }
    const removed = result.removed;
    if (removed === 0) return;
    const eligible = Math.max(0, state.eligible - removed);
    const receipt = runtime.receiptFor(threadId, eligible);
    this.writeSemanticGeneration(state, {
      status:
        state.status === "complete" && state.gaps === 0 && receipt.status === "ready"
          ? "complete"
          : "incomplete",
      watermark: state.watermark_seq,
      eligible,
      gaps: state.gaps,
      indexed: receipt.indexed ?? Math.max(0, state.indexed - removed),
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
    });
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- threads

  readonly fragments = {
    get: (threadId: string): ThreadFragment | null => {
      const row = this.stmt(
        "SELECT thread_id, original_thread_id, from_seq, to_seq, prev_hash, head_hash, created_at " +
          "FROM thread_fragment WHERE thread_id = ? LIMIT 1",
      ).get(threadId) as {
        thread_id: string;
        original_thread_id: string;
        from_seq: number;
        to_seq: number;
        prev_hash: string;
        head_hash: string;
        created_at: number;
      } | null;
      return row === null
        ? null
        : {
            threadId: row.thread_id,
            originalThreadId: row.original_thread_id,
            fromSeq: row.from_seq,
            toSeq: row.to_seq,
            prevHash: row.prev_hash,
            headHash: row.head_hash,
            createdAt: row.created_at,
          };
    },
    assertMutable: (threadId: string): void => {
      const fragment = this.fragments.get(threadId);
      if (fragment !== null) {
        throw new VaultError(
          `thread ${threadId} is an authenticated read-only fragment #${fragment.fromSeq}-#${fragment.toSeq}`,
        );
      }
    },
  };

  readonly threads = {
    /**
     * Mint a thread. `provenance` lets a caller fix the identity a run depends
     * on: `id` is used verbatim, including as the genesis-hash seed, and must
     * match `th_[A-Za-z0-9_-]{1,127}`; `createdAt` replaces the wall clock.
     * Either field omitted keeps the random id / `Date.now()` default.
     */
    create: (title?: string, settings: ThreadSettings = {}, provenance: ThreadProvenance = {}): Thread => {
      const id = provenance.id === undefined ? newId("th") : checkedThreadId(provenance.id);
      const resolvedTitle = title ?? "Untitled thread";
      assertThreadTitle(resolvedTitle);
      const settingsJson = canonicalThreadSettings(settings);
      const thread: Thread = {
        id,
        title: resolvedTitle,
        createdAt:
          provenance.createdAt === undefined ? Date.now() : checkedThreadCreatedAt(provenance.createdAt),
        headSeq: 0,
        headHash: genesisHash(id),
        settings,
      };
      const insert = this.stmt(
        "INSERT INTO thread (id, title, created_at, head_seq, head_hash, settings) VALUES (?, ?, ?, ?, ?, ?)",
      );
      try {
        insert.run(thread.id, thread.title, thread.createdAt, 0, thread.headHash, settingsJson);
      } catch (error) {
        if (this.threads.get(id) !== null) throw new VaultError(`thread ${id} already exists`);
        throw error;
      }
      return thread;
    },
    get: (id: string): Thread | null => {
      const row = this.stmt("SELECT * FROM thread WHERE id = ?").get(id) as ThreadRow | undefined;
      return row == null ? null : toThread(row);
    },
    header: (id: string): VaultThreadHeader | null => {
      const row = this.stmt(
        "SELECT id, " +
          "CASE WHEN title IS NULL OR length(CAST(title AS BLOB)) <= ? THEN title ELSE NULL END AS title, " +
          "length(CAST(title AS BLOB)) AS title_bytes, head_seq, head_hash " +
          "FROM thread WHERE id = ?",
      ).get(MAX_THREAD_TITLE_BYTES, id) as
        | {
            id: string;
            title: string | null;
            title_bytes: number | null;
            head_seq: number;
            head_hash: string;
          }
        | undefined;
      if (row == null) return null;
      const titleBytes = row.title_bytes === null ? 0 : Number(row.title_bytes);
      if (!Number.isSafeInteger(titleBytes) || titleBytes < 0 || titleBytes > MAX_THREAD_TITLE_BYTES) {
        throw new VaultError("thread title exceeds the bounded statistics projection");
      }
      return {
        id: row.id,
        title: row.title,
        titleBytes,
        headSeq: row.head_seq,
        headHash: row.head_hash,
      };
    },
    runtime: (id: string): { id: string; settings: Record<string, unknown> } | null => {
      const row = this.stmt(
        "SELECT id, " +
          "CASE WHEN length(CAST(settings AS BLOB)) <= ? THEN settings ELSE NULL END AS settings_json, " +
          "length(CAST(settings AS BLOB)) AS settings_bytes " +
          "FROM thread WHERE id = ?",
      ).get(MAX_THREAD_SETTINGS_BYTES, id) as
        | { id: string; settings_json: string | null; settings_bytes: number | null }
        | undefined;
      if (row == null) return null;
      const settingsBytes = row.settings_bytes === null ? -1 : Number(row.settings_bytes);
      if (
        row.settings_json === null ||
        !Number.isSafeInteger(settingsBytes) ||
        settingsBytes < 0 ||
        settingsBytes > MAX_THREAD_SETTINGS_BYTES
      ) {
        throw new VaultError("thread settings exceed the bounded runtime projection");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.settings_json);
      } catch {
        throw new VaultError("thread settings are malformed");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new VaultError("thread settings are malformed");
      }
      const settings = canonicalThreadSettings(parsed as ThreadSettings);
      return { id: row.id, settings: JSON.parse(settings) as Record<string, unknown> };
    },
    list: (): Thread[] =>
      (this.stmt("SELECT * FROM thread ORDER BY created_at ASC").all() as ThreadRow[]).map(toThread),
    listPage: (options: { after?: VaultThreadListCursor; limit?: number } = {}): VaultThreadListPage => {
      const limit = Math.max(1, Math.min(options.limit ?? MAX_THREAD_LIST_ROWS, MAX_THREAD_LIST_ROWS));
      const projection =
        "CASE WHEN length(CAST(id AS BLOB)) <= ? THEN id ELSE NULL END AS id, " +
        "length(CAST(id AS BLOB)) AS id_bytes, created_at";
      const rows =
        options.after === undefined
          ? (this.stmt(`SELECT ${projection} FROM thread ORDER BY created_at DESC, id DESC LIMIT ?`).all(
              MAX_THREAD_ID_BYTES,
              limit + 1,
            ) as Array<{ id: string | null; id_bytes: number | null; created_at: number }>)
          : (this.stmt(
              `SELECT ${projection} FROM thread WHERE (created_at < ?) OR (created_at = ? AND id < ?) ` +
                "ORDER BY created_at DESC, id DESC LIMIT ?",
            ).all(
              MAX_THREAD_ID_BYTES,
              options.after.createdAt,
              options.after.createdAt,
              options.after.id,
              limit + 1,
            ) as Array<{ id: string | null; id_bytes: number | null; created_at: number }>);
      const bounded = rows.map((row) => {
        const idBytes = row.id_bytes === null ? -1 : Number(row.id_bytes);
        if (
          row.id === null ||
          !Number.isSafeInteger(idBytes) ||
          idBytes < 1 ||
          idBytes > MAX_THREAD_ID_BYTES ||
          !Number.isSafeInteger(row.created_at) ||
          row.created_at < 0
        ) {
          throw new VaultError("thread list row exceeds the bounded cursor projection");
        }
        return { id: row.id, createdAt: row.created_at };
      });
      return { threads: bounded.slice(0, limit), hasMore: bounded.length > limit };
    },
    setTitle: (id: string, title: string): void => {
      assertThreadTitle(title);
      this.stmt("UPDATE thread SET title = ? WHERE id = ?").run(title, id);
    },
    setSettings: (id: string, settings: ThreadSettings): void => {
      this.stmt("UPDATE thread SET settings = ? WHERE id = ?").run(canonicalThreadSettings(settings), id);
    },
    /** The one thread a fresh profile opens with; created on demand. */
    primary: (): Thread => {
      const existing = this.threads.listPage({ limit: 1 }).threads[0];
      if (existing === undefined) return this.threads.create("Pylos");
      return this.threads.get(existing.id) ?? this.threads.create("Pylos");
    },
  };

  private requireThread(threadId: string): Thread {
    const thread = this.threads.get(threadId);
    if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
    return thread;
  }

  capsuleSourceReadiness(
    threadId: string,
    headSeq?: number,
  ): {
    status: "pending" | "noncompactable";
    readOnly: true;
    seq?: number;
    reason: string;
  } | null {
    const head = headSeq ?? this.requireThread(threadId).headSeq;
    const row = this.stmt(
      "SELECT status, checked_through, seq, reason FROM capsule_source_readiness WHERE thread_id = ?",
    ).get(threadId) as
      | {
          status: "ready" | "noncompactable";
          checked_through: number;
          seq: number | null;
          reason: string | null;
        }
      | undefined;
    if (row?.status === "noncompactable") {
      return {
        status: "noncompactable",
        readOnly: true,
        ...(row.seq === null ? {} : { seq: row.seq }),
        reason: row.reason ?? "legacy capsule source is not representable",
      };
    }
    const sealed = this.stmt(
      "SELECT to_seq FROM capsule WHERE thread_id = ? AND level = 0 ORDER BY to_seq DESC LIMIT 1",
    ).get(threadId) as { to_seq: number } | undefined;
    const checked = Math.max(row?.checked_through ?? 0, sealed?.to_seq ?? 0);
    if (checked >= head) return null;
    return {
      status: "pending",
      readOnly: true,
      reason: `bounded capsule source audit is pending after episode ${checked}`,
    };
  }

  prepareCapsuleSourceReadiness(threadId: string, head?: number): void {
    const targetHead = head ?? this.requireThread(threadId).headSeq;
    const current = this.capsuleSourceReadiness(threadId, targetHead);
    if (current?.status === "noncompactable") {
      throw new VaultError(
        `thread has a legacy noncompactable tail at episode ${current.seq}: ${current.reason}`,
      );
    }
    const stored = this.stmt("SELECT checked_through FROM capsule_source_readiness WHERE thread_id = ?").get(
      threadId,
    ) as { checked_through: number } | undefined;
    const sealed = this.stmt(
      "SELECT to_seq FROM capsule WHERE thread_id = ? AND level = 0 ORDER BY to_seq DESC LIMIT 1",
    ).get(threadId) as { to_seq: number } | undefined;
    const checked = Math.max(stored?.checked_through ?? 0, sealed?.to_seq ?? 0);
    if (checked >= targetHead) return;
    const from = checked + 1;
    const next = this.stmt(
      "SELECT seq, CASE WHEN length(CAST(content AS BLOB)) <= ? THEN content ELSE NULL END AS content, " +
        "CASE WHEN json_valid(meta) THEN json_extract(meta, '$.removed') ELSE NULL END AS removed " +
        "FROM episode WHERE thread_id = ? AND seq BETWEEN ? AND ? AND seq > ? ORDER BY seq ASC LIMIT 1",
    );
    const to = Math.min(targetHead, checked + LEAF_CAPSULE_EPISODES);
    let after = from - 1;
    for (;;) {
      const row = next.get(CAPSULE_SOURCE_EPISODE_BYTES, threadId, from, to, after) as {
        seq: number;
        content: string | null;
        removed: unknown;
      } | null;
      if (row === null) break;
      after = row.seq;
      if (row.removed === 1) continue;
      const failure =
        row.content === null
          ? "episode exceeds capsule source byte capacity"
          : capsuleSourceContentFailure(row.content);
      if (failure !== null) {
        this.stmt(
          "INSERT OR REPLACE INTO capsule_source_readiness " +
            "(thread_id, status, checked_through, seq, reason, checked_at) " +
            "VALUES (?, 'noncompactable', ?, ?, ?, ?)",
        ).run(threadId, row.seq - 1, row.seq, failure, Date.now());
        throw new VaultError(`thread has a legacy noncompactable tail at episode ${row.seq}: ${failure}`);
      }
    }
    this.stmt(
      "INSERT OR REPLACE INTO capsule_source_readiness " +
        "(thread_id, status, checked_through, seq, reason, checked_at) VALUES (?, 'ready', ?, NULL, NULL, ?)",
    ).run(threadId, to, Date.now());
    if (to < targetHead) {
      throw new VaultError(`bounded capsule source audit is pending after episode ${to}; retry`);
    }
  }

  /** Advance one legacy 32-row readiness page without turning pending/quarantine into an exception. */
  continueCapsuleSourceReadiness(threadId: string): ReturnType<Vault["capsuleSourceReadiness"]> {
    try {
      this.prepareCapsuleSourceReadiness(threadId);
    } catch (error) {
      if (
        !(error instanceof VaultError) ||
        (!error.message.includes("bounded capsule source audit is pending") &&
          !error.message.includes("legacy noncompactable tail"))
      ) {
        throw error;
      }
    }
    return this.capsuleSourceReadiness(threadId);
  }

  /**
   * One lexical search pass: the `limit` best matches in the contract order
   * `bm25 ASC, seq DESC` (§5.3, A9.4), projected however the caller asks.
   *
   * That compound order is what makes this delicate. Joined to `episode` in a
   * single statement it defeats SQLite's top-k sorter: every match has to be
   * looked up in the episode table and sorted before the LIMIT can apply, so a
   * search costs a row seek per match and its price grows with the archive
   * instead of with `limit`. So take the `candidates` best-scoring rowids from
   * the FTS index alone, join and filter only those, and prove the page is the
   * one the unbounded statement would have returned before handing it back.
   *
   * The proof has to be tie-aware — a templated corpus ties by the dozen — and
   * it is exactly this: the page is right when either every match was fetched
   * (`fts_count < candidates`), or the page is full and the worst score fetched
   * is *strictly* worse than the last row's, so no unfetched row can displace
   * that row or tie it and win on `seq`. Anything else widens `candidates`; a
   * tie set that outruns the widening falls back to the unbounded statement,
   * which stays here as the reference definition of the answer.
   */
  private ftsPage<Row>(
    projection: string,
    projectionParams: readonly number[],
    match: string,
    threadId: string,
    opts: { exclude?: Seq; before?: Seq },
    limit: number,
  ): Row[] {
    const exclude = opts.exclude ?? null;
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    // `IS NOT` so a bound NULL — nothing to exclude — keeps every row.
    const filter = "WHERE e.thread_id = ? AND e.seq IS NOT ? AND e.seq < ? ";
    const bounded =
      "WITH m AS MATERIALIZED (SELECT rowid AS rid, bm25(episode_fts) AS s FROM episode_fts " +
      "WHERE episode_fts MATCH ? ORDER BY s ASC LIMIT ?) " +
      `SELECT ${projection}, m.s AS fts_score, (SELECT COUNT(*) FROM m) AS fts_count, ` +
      "(SELECT MAX(s) FROM m) AS fts_worst FROM m JOIN episode e ON e.rowid = m.rid " +
      filter +
      "ORDER BY m.s ASC, e.seq DESC LIMIT ?";
    let candidates = Math.max(limit * FTS_OVERFETCH, FTS_CANDIDATE_FLOOR);
    for (let widening = 0; widening <= FTS_CANDIDATE_WIDENINGS; widening += 1) {
      const rows = this.stmt(bounded).all(
        match,
        candidates,
        ...projectionParams,
        threadId,
        exclude,
        before,
        limit,
      ) as Array<Row & FtsProbe>;
      const last = rows[rows.length - 1];
      if (last === undefined) {
        if (this.ftsMatchCount(match, candidates) < candidates) return [];
      } else if (last.fts_count < candidates || (rows.length === limit && last.fts_worst > last.fts_score)) {
        return rows;
      }
      candidates *= FTS_OVERFETCH;
    }
    return this.stmt(
      `SELECT ${projection} FROM episode_fts f JOIN episode e ON e.rowid = f.rowid ` +
        "WHERE episode_fts MATCH ? AND e.thread_id = ? AND e.seq IS NOT ? AND e.seq < ? " +
        // Equal scores must not depend on how SQLite happened to walk the
        // index: the newest matching turn wins, always.
        "ORDER BY bm25(episode_fts) ASC, e.seq DESC LIMIT ?",
    ).all(...projectionParams, match, threadId, exclude, before, limit) as Row[];
  }

  /** How many rows a match has, counted no further than `cap`. */
  private ftsMatchCount(match: string, cap: number): number {
    const row = this.stmt(
      "SELECT COUNT(*) AS n FROM (SELECT rowid FROM episode_fts WHERE episode_fts MATCH ? LIMIT ?)",
    ).get(match, cap) as { n: number } | null;
    return row === null ? 0 : row.n;
  }

  // --------------------------------------------------------------- episodes

  readonly episodes = {
    /** Append one episode, extending the hash chain. */
    append: (threadId: string, input: EpisodeInput): Episode =>
      this.episodes.appendMany(threadId, [input])[0] as Episode,

    /**
     * Append a batch in one transaction. The bench relies on this: 2,000
     * episodes per transaction keeps ingest amortized O(1) per turn.
     */
    appendMany: (threadId: string, inputs: readonly EpisodeInput[]): Episode[] => {
      let promotion: BlobPromotion | undefined;
      this.fragments.assertMutable(threadId);
      this.prepareCapsuleSourceReadiness(threadId);
      return this.tx(() => {
        this.fragments.assertMutable(threadId);
        const thread = this.requireThread(threadId);
        for (const input of inputs) {
          const sourceFailure = capsuleSourceContentFailure(input.content);
          if (sourceFailure !== null) throw new VaultError(sourceFailure);
          if (input.blob === undefined) continue;
          const mime = input.blob.mime ?? "application/octet-stream";
          const name = input.blob.name ?? "";
          const metadataFailure = attachmentMetadataFailure(mime, name);
          if (metadataFailure !== null) throw new VaultError(metadataFailure);
        }
        if (inputs.some((input) => input.blob !== undefined)) {
          promotion = createBlobPromotion(this.objectsDir);
          this.pendingBlobPromotions.push(promotion);
        }
        const staged = new Map<string, { size: number; mime: string }>();
        let seq = thread.headSeq;
        let prevHash = thread.headHash;
        const out: Episode[] = [];
        const insert = this.stmt(
          "INSERT INTO episode (seq, thread_id, ts, role, model, provider, content, content_hash, tokens, prev_hash, hash, meta) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const fts = this.stmt("INSERT INTO episode_fts (rowid, content) VALUES (?, ?)");
        const counters: Record<string, number> = {};
        for (const input of inputs) {
          seq += 1;
          const meta: EpisodeMeta = { ...(input.meta ?? {}) };
          if (input.blob) {
            const mime = input.blob.mime ?? "application/octet-stream";
            const name = input.blob.name ?? "";
            if (promotion === undefined) throw new VaultError("attachment promotion was not prepared");
            const stage = (bytes: Uint8Array, spanMime: string): string =>
              this.stageAttachmentBlob(promotion as BlobPromotion, bytes, spanMime, staged);
            const hash = stage(input.blob.bytes, mime);
            // Keep the whole object under the v1 pointer and write every span
            // through the same content-addressed store.  The manifest is part
            // of this episode's chain-covered metadata (A12.3).
            const manifest = buildAttachmentManifest(input.blob.bytes, mime, name, stage, input.content);
            for (const [objectHash, object] of staged) {
              this.stmt("INSERT OR IGNORE INTO blob (hash, mime, size, created_at) VALUES (?, ?, ?, ?)").run(
                objectHash,
                object.mime,
                object.size,
                Date.now(),
              );
            }
            meta.blob = hash;
            meta.manifest = manifest;
            meta.mime = mime;
            meta.name = name;
            meta.size = input.blob.bytes.byteLength;
            if (Buffer.byteLength(canonicalJson(meta), "utf8") > BUNDLE_DERIVED_LIMITS.episodeMetaBytes) {
              throw new VaultError(
                `attachment episode metadata exceeds ${BUNDLE_DERIVED_LIMITS.episodeMetaBytes} JSON bytes`,
              );
            }
          }
          const ts = input.ts ?? Date.now();
          const contentHash = sha256(input.content);
          const hash = chainHash(
            prevHash,
            chainRecord({
              seq,
              ts,
              role: input.role,
              model: input.model,
              provider: input.provider,
              contentHash,
              metaHash: metaHashOf(meta),
            }),
          );
          const tokens = approxTokens(input.content);
          const result = insert.run(
            seq,
            threadId,
            ts,
            input.role,
            input.model ?? null,
            input.provider ?? null,
            input.content,
            contentHash,
            tokens,
            prevHash,
            hash,
            canonicalJson(meta),
          );
          fts.run(Number(result.lastInsertRowid), input.content);
          if (input.role === "attachment" && meta.removed !== true)
            this.indexAttachmentName(threadId, seq, meta);
          out.push({
            threadId,
            seq,
            ts,
            role: input.role,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            content: input.content,
            tokens,
            prevHash,
            hash,
            meta,
          });
          counters[COUNTERS.episodes] = (counters[COUNTERS.episodes] ?? 0) + 1;
          counters[COUNTERS.bytes] = (counters[COUNTERS.bytes] ?? 0) + Buffer.byteLength(input.content);
          const roleKey =
            input.role === "user"
              ? COUNTERS.userEpisodes
              : input.role === "assistant"
                ? COUNTERS.assistantEpisodes
                : COUNTERS.otherEpisodes;
          counters[roleKey] = (counters[roleKey] ?? 0) + 1;
          if (seq % CHECKPOINT_EVERY === 0) {
            this.stmt("INSERT OR REPLACE INTO chain_checkpoint (thread_id, seq, hash) VALUES (?, ?, ?)").run(
              threadId,
              seq,
              hash,
            );
          }
          prevHash = hash;
        }
        this.stmt("UPDATE thread SET head_seq = ?, head_hash = ? WHERE id = ?").run(seq, prevHash, threadId);
        this.stmt(
          "INSERT OR REPLACE INTO capsule_source_readiness " +
            "(thread_id, status, checked_through, seq, reason, checked_at) VALUES (?, 'ready', ?, NULL, NULL, ?)",
        ).run(threadId, seq, Date.now());
        this.bump(threadId, counters);
        this.indexSemanticAppends(threadId, out);
        return out;
      });
    },

    get: (threadId: string, seq: Seq): Episode | null => {
      const row = this.stmt("SELECT * FROM episode WHERE thread_id = ? AND seq = ?").get(threadId, seq) as
        | EpisodeRow
        | undefined;
      return row == null ? null : toEpisode(row);
    },

    /**
     * Return the newest assistant model from a scalar, index-bounded
     * projection.  This is deliberately separate from `list`: a legal
     * imported episode may contain very large content and metadata, neither
     * of which is needed to decide who last spoke.  The newest assistant row
     * wins even when its model is malformed or oversized; returning no model
     * in that case is fail-closed rather than falling back to older evidence.
     */
    lastSpokenModel: (threadId: string): string | undefined => {
      const row = this.stmt(
        "SELECT CASE WHEN length(CAST(e.model AS BLOB)) <= ? THEN e.model ELSE NULL END AS model, " +
          "length(CAST(e.model AS BLOB)) AS model_bytes " +
          "FROM episode e " +
          "WHERE e.thread_id = ? AND e.role = 'assistant' " +
          "ORDER BY e.seq DESC LIMIT 1",
      ).get(MAX_THREAD_MODEL_BYTES, threadId) as
        | { model: string | null; model_bytes: number | null }
        | undefined;
      if (row == null || row.model === null) return undefined;
      if (
        typeof row.model !== "string" ||
        typeof row.model_bytes !== "number" ||
        !Number.isSafeInteger(row.model_bytes) ||
        row.model_bytes < 0 ||
        row.model_bytes > MAX_THREAD_MODEL_BYTES
      ) {
        return undefined;
      }
      return row.model;
    },

    /**
     * Read one episode without hydrating its full content or metadata. The
     * SQL projection bounds both columns before the row reaches JavaScript;
     * the returned locator binds the retained prefix to the immutable chain.
     */
    getBounded: (
      threadId: string,
      seq: Seq,
      contentLimit = DEFAULT_EPISODE_VIEW_CONTENT_LIMIT,
      metaLimit = DEFAULT_EPISODE_VIEW_META_LIMIT,
    ): EpisodeView | null => {
      const row = this.stmt(
        `SELECT ${boundedEpisodeColumns("e")} FROM episode e WHERE e.thread_id = ? AND e.seq = ?`,
      ).get(contentLimit, metaLimit, threadId, seq) as EpisodeViewRow | undefined;
      return row == null ? null : toEpisodeView(row, contentLimit, metaLimit);
    },

    /** Inclusive `[from, to]` range, ascending. An optional limit is SQL-bound. */
    range: (threadId: string, from: Seq, to: Seq, limit?: number): Episode[] => {
      if (limit === undefined) {
        return (
          this.stmt("SELECT * FROM episode WHERE thread_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC").all(
            threadId,
            from,
            to,
          ) as EpisodeRow[]
        ).map(toEpisode);
      }
      const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(5_000, Math.floor(limit))) : 0;
      if (boundedLimit === 0) return [];
      return (
        this.stmt(
          "SELECT * FROM episode WHERE thread_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC LIMIT ?",
        ).all(threadId, from, to, boundedLimit) as EpisodeRow[]
      ).map(toEpisode);
    },

    /** Newest-last page for the transcript view. */
    list: (threadId: string, opts: { before?: Seq; after?: Seq; limit?: number } = {}): Episode[] => {
      const limit = Math.max(1, Math.min(opts.limit ?? 100, 5000));
      if (opts.after !== undefined) {
        return (
          this.stmt("SELECT * FROM episode WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?").all(
            threadId,
            opts.after,
            limit,
          ) as EpisodeRow[]
        ).map(toEpisode);
      }
      const before = opts.before ?? Number.MAX_SAFE_INTEGER;
      const rows = this.stmt(
        "SELECT * FROM episode WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
      ).all(threadId, before, limit) as EpisodeRow[];
      return rows.reverse().map(toEpisode);
    },

    /** Bounded transcript page; unlike `list`, it never selects full content/meta. */
    listBounded: (
      threadId: string,
      opts: { before?: Seq; after?: Seq; limit?: number } = {},
      contentLimit = DEFAULT_EPISODE_VIEW_CONTENT_LIMIT,
      metaLimit = DEFAULT_EPISODE_VIEW_META_LIMIT,
    ): EpisodeView[] => {
      const limit = Math.max(1, Math.min(opts.limit ?? 100, 5_000));
      if (opts.after !== undefined) {
        const rows = this.stmt(
          `SELECT ${boundedEpisodeColumns("e")} FROM episode e ` +
            "WHERE e.thread_id = ? AND e.seq > ? ORDER BY e.seq ASC LIMIT ?",
        ).all(contentLimit, metaLimit, threadId, opts.after, limit) as EpisodeViewRow[];
        return rows.map((row) => toEpisodeView(row, contentLimit, metaLimit));
      }
      const before = opts.before ?? Number.MAX_SAFE_INTEGER;
      const rows = this.stmt(
        `SELECT ${boundedEpisodeColumns("e")} FROM episode e ` +
          "WHERE e.thread_id = ? AND e.seq < ? ORDER BY e.seq DESC LIMIT ?",
      ).all(contentLimit, metaLimit, threadId, before, limit) as EpisodeViewRow[];
      return rows.reverse().map((row) => toEpisodeView(row, contentLimit, metaLimit));
    },

    /** The last `limit` episodes, ascending. */
    tail: (threadId: string, limit: number): Episode[] => {
      const rows = this.stmt("SELECT * FROM episode WHERE thread_id = ? ORDER BY seq DESC LIMIT ?").all(
        threadId,
        Math.max(1, limit),
      ) as EpisodeRow[];
      return rows.reverse().map(toEpisode);
    },

    count: (threadId: string): number => this.counter(threadId, COUNTERS.episodes),

    /**
     * FTS5/BM25 lexical search (KERNEL §5.3, A9.4), best matches first: every
     * term (AND) first, the rarest terms (OR) only when that found nothing.
     * `mode: "strict"` runs the AND pass alone — for asking whether a turn holds
     * *every* word of a question, not merely one of them. `exclude` drops one
     * seq from both passes; `before` applies a strict sequence snapshot to both
     * passes. The turn being asked is indexed like any other, and
     * a question that matched itself would report a hit and so suppress the
     * fallback that reaches the answer (KERNEL A10.1).
     */
    search: (
      threadId: string,
      query: string,
      limit = 10,
      opts: { mode?: "both" | "strict"; exclude?: Seq; before?: Seq } = {},
    ): Episode[] => {
      const run = (match: string): Episode[] => {
        try {
          return this.ftsPage<EpisodeRow>("e.*", [], match, threadId, opts, limit).map(toEpisode);
        } catch {
          return [];
        }
      };
      const strict = ftsQuery(query, "and");
      const found = strict === null ? [] : run(strict);
      if (found.length > 0 || opts.mode === "strict") return found;
      const loose = ftsQuery(query, "or");
      return loose === null ? [] : run(loose);
    },

    /** Bounded FTS search projection with the same snapshot semantics as `search`. */
    searchBounded: (
      threadId: string,
      query: string,
      limit = 40,
      opts: { mode?: "both" | "strict"; exclude?: Seq; before?: Seq } = {},
      contentLimit = DEFAULT_EPISODE_VIEW_CONTENT_LIMIT,
      metaLimit = DEFAULT_EPISODE_VIEW_META_LIMIT,
    ): EpisodeView[] => {
      const boundedLimit = Math.max(1, Math.min(limit, 5_000));
      const run = (match: string): EpisodeView[] => {
        try {
          return this.ftsPage<EpisodeViewRow>(
            boundedEpisodeColumns("e"),
            [contentLimit, metaLimit],
            match,
            threadId,
            opts,
            boundedLimit,
          ).map((row) => toEpisodeView(row, contentLimit, metaLimit));
        } catch {
          return [];
        }
      };
      const strict = ftsQuery(query, "and");
      const found = strict === null ? [] : run(strict);
      if (found.length > 0 || opts.mode === "strict") return found;
      const loose = ftsQuery(query, "or");
      return loose === null ? [] : run(loose);
    },

    /**
     * Scalar FTS projection for A13 coverage. Unlike search/searchBounded it
     * never crosses content or metadata into JavaScript; coverage re-reads
     * each selected source through its own bounded projection only when that
     * source reaches the locator cap.
     */
    searchCoverage: (
      threadId: string,
      query: string,
      limit = 40,
      opts: { mode?: "both" | "strict"; exclude?: Seq; before?: Seq } = {},
    ): CoverageEpisodeRow[] => {
      const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 5_000));
      const run = (match: string): CoverageEpisodeRow[] => {
        try {
          const rows = this.ftsPage<{
            seq: number;
            role: Role;
            content_hash: string;
            content_bytes: number;
            removed: number;
          }>(
            "e.seq, e.role, e.content_hash, length(CAST(e.content AS BLOB)) AS content_bytes, " +
              "CASE WHEN json_valid(e.meta) = 1 THEN COALESCE(json_extract(e.meta, '$.removed'), 0) ELSE 0 END AS removed",
            [],
            match,
            threadId,
            opts,
            boundedLimit,
          );
          return rows
            .filter(
              (row) =>
                Number.isSafeInteger(row.seq) &&
                typeof row.content_hash === "string" &&
                Number.isSafeInteger(row.content_bytes) &&
                row.content_bytes >= 0,
            )
            .map((row) => ({
              seq: row.seq,
              role: row.role,
              contentHash: row.content_hash,
              contentBytes: row.content_bytes,
              removed: row.removed === 1,
            }));
        } catch {
          return [];
        }
      };
      const strict = ftsQuery(query, "and");
      const found = strict === null ? [] : run(strict);
      if (found.length > 0 || opts.mode === "strict") return found;
      const loose = ftsQuery(query, "or");
      return loose === null ? [] : run(loose);
    },
  };

  private attachmentDeletionPlan(
    hashes: readonly string[],
    maxEntries = MAX_BLOB_DELETION_ENTRIES,
  ): {
    roots: string[];
    spans: Map<string, Set<string>>;
    objects: Set<string>;
  } {
    const roots = [...new Set(hashes)];
    const wanted = new Set(roots);
    const objects = new Set<string>();
    const spans = new Map<string, Set<string>>();
    for (const hash of roots) {
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new VaultError(`invalid attachment object hash ${hash}`);
      objects.add(hash);
    }
    if (objects.size > maxEntries) {
      throw new VaultError(`forget attachment objects exceed bounded capacity (${maxEntries})`);
    }

    // The target's whole-object hash is retained in immutable metadata after
    // redaction. Scan only scalar metadata columns, then page each matching
    // manifest's scalar span hashes. No full metadata string crosses into JS.
    const rowsQuery = this.db.query(
      "SELECT rowid AS episode_rowid, " +
        "json_valid(meta) AS meta_valid, " +
        "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.blob') = 'text' " +
        "AND length(CAST(json_extract(meta, '$.blob') AS BLOB)) = 64 " +
        "THEN json_extract(meta, '$.blob') ELSE NULL END AS blob, " +
        "CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.blob') ELSE NULL END AS blob_type, " +
        "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.blob') = 'text' " +
        "THEN length(CAST(json_extract(meta, '$.blob') AS BLOB)) ELSE NULL END AS blob_bytes, " +
        "CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.manifest') ELSE NULL END AS manifest_type, " +
        "CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.manifest.spans') ELSE NULL END AS spans_type " +
        "FROM episode WHERE rowid > ? ORDER BY rowid ASC LIMIT ?",
    );
    const spansQuery = this.db.query(
      "SELECT CAST(s.key AS INTEGER) AS span_index, " +
        "CASE WHEN json_type(s.value, '$.objectHash') = 'text' " +
        "AND length(CAST(json_extract(s.value, '$.objectHash') AS BLOB)) = 64 " +
        "THEN json_extract(s.value, '$.objectHash') ELSE NULL END AS span_hash, " +
        "json_type(s.value, '$.objectHash') AS span_hash_type, " +
        "CASE WHEN json_type(s.value, '$.objectHash') = 'text' " +
        "THEN length(CAST(json_extract(s.value, '$.objectHash') AS BLOB)) ELSE NULL END AS span_hash_bytes " +
        "FROM episode e JOIN json_each(" +
        "CASE WHEN json_valid(e.meta) = 1 AND json_type(e.meta, '$.manifest.spans') = 'array' " +
        "THEN json_extract(e.meta, '$.manifest.spans') ELSE '[]' END" +
        ") s ON true WHERE e.rowid = ? ORDER BY CAST(s.key AS INTEGER) ASC LIMIT ?",
    );
    let afterRowid = 0;
    for (;;) {
      const rows = rowsQuery.all(afterRowid, 256) as Array<{
        episode_rowid: number;
        meta_valid: number;
        blob: unknown;
        blob_type: unknown;
        blob_bytes: unknown;
        manifest_type: unknown;
        spans_type: unknown;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        if (!Number.isSafeInteger(row.episode_rowid) || row.episode_rowid <= afterRowid) {
          throw new VaultError("invalid episode rowid during attachment deletion planning");
        }
        afterRowid = row.episode_rowid;
        if (row.meta_valid !== 1)
          throw new VaultError("episode metadata is malformed during attachment deletion planning");
        if (
          row.blob_type !== null &&
          (row.blob_type !== "text" ||
            row.blob_bytes !== 64 ||
            typeof row.blob !== "string" ||
            !/^[0-9a-f]{64}$/u.test(row.blob))
        ) {
          throw new VaultError("attachment object hash is malformed during attachment deletion planning");
        }
        if (row.manifest_type !== null && row.manifest_type !== "object") {
          throw new VaultError("attachment manifest is malformed during attachment deletion planning");
        }
        if (typeof row.blob !== "string" || !wanted.has(row.blob)) continue;
        if (row.manifest_type === null) continue;
        if (row.spans_type !== "array")
          throw new VaultError(`attachment manifest for ${row.blob} is invalid`);
        const targetSpans = spans.get(row.blob) ?? new Set<string>();
        const spanRows = spansQuery.all(row.episode_rowid, maxEntries + 1) as Array<{
          span_index: number;
          span_hash: unknown;
          span_hash_type: unknown;
          span_hash_bytes: unknown;
        }>;
        if (spanRows.length > maxEntries) {
          throw new VaultError(`forget attachment objects exceed bounded capacity (${maxEntries})`);
        }
        for (const span of spanRows) {
          if (
            span.span_hash_type !== "text" ||
            span.span_hash_bytes !== 64 ||
            typeof span.span_hash !== "string" ||
            !/^[0-9a-f]{64}$/u.test(span.span_hash)
          ) {
            throw new VaultError(`attachment manifest for ${row.blob} has an invalid span hash`);
          }
          targetSpans.add(span.span_hash);
          objects.add(span.span_hash);
          // The +1 is intentional: detect the first over-cap object and abort
          // before any forget mutation or stage/journal is published.
          if (objects.size > maxEntries) {
            throw new VaultError(`forget attachment objects exceed bounded capacity (${maxEntries})`);
          }
        }
        spans.set(row.blob, targetSpans);
      }
      if (rows.length < 256) break;
    }
    return { roots, spans, objects };
  }

  private liveAttachmentReferences(hashes: readonly string[]): Set<string> {
    const wanted = new Set(hashes);
    const found = new Set<string>();
    if (wanted.size === 0) return found;
    const wantedHashes = [...wanted];
    const wantedJson = JSON.stringify(wantedHashes);
    const rowsQuery = this.db.query(
      "WITH metadata AS (" +
        "SELECT rowid AS episode_rowid, " +
        "json_valid(meta) AS meta_valid, " +
        "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.removed') IN ('true', 'false', 'integer') " +
        "THEN json_extract(meta, '$.removed') ELSE NULL END AS removed, " +
        "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.blob') = 'text' " +
        "AND length(CAST(json_extract(meta, '$.blob') AS BLOB)) = 64 " +
        "THEN json_extract(meta, '$.blob') ELSE NULL END AS blob, " +
        "CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.blob') ELSE NULL END AS blob_type, " +
        "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.blob') = 'text' " +
        "THEN length(CAST(json_extract(meta, '$.blob') AS BLOB)) ELSE NULL END AS blob_bytes, " +
        "CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.manifest') ELSE NULL END AS manifest_type, " +
        "CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.manifest.spans') ELSE NULL END AS spans_type, " +
        "CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.manifest.spans') = 'array' " +
        "THEN json_extract(meta, '$.manifest.spans') ELSE '[]' END AS spans_json " +
        "FROM episode" +
        "), candidates AS (" +
        "SELECT episode_rowid, meta_valid, removed, blob, blob_type, blob_bytes, manifest_type, spans_type, " +
        "-1 AS span_index, NULL AS span_hash, NULL AS span_hash_type, NULL AS span_hash_bytes " +
        "FROM metadata " +
        "WHERE episode_rowid > ? OR (episode_rowid = ? AND -1 > ?) " +
        "UNION ALL " +
        "SELECT m.episode_rowid, m.meta_valid, m.removed, m.blob, m.blob_type, m.blob_bytes, m.manifest_type, m.spans_type, " +
        "CAST(s.key AS INTEGER) AS span_index, " +
        "CASE WHEN json_type(s.value, '$.objectHash') = 'text' " +
        "AND length(CAST(json_extract(s.value, '$.objectHash') AS BLOB)) = 64 " +
        "THEN json_extract(s.value, '$.objectHash') ELSE NULL END AS span_hash, " +
        "json_type(s.value, '$.objectHash') AS span_hash_type, " +
        "CASE WHEN json_type(s.value, '$.objectHash') = 'text' " +
        "THEN length(CAST(json_extract(s.value, '$.objectHash') AS BLOB)) ELSE NULL END AS span_hash_bytes " +
        "FROM metadata m JOIN json_each(m.spans_json) s ON true " +
        "WHERE m.meta_valid = 1 AND COALESCE(m.removed, 0) != 1 " +
        "AND (EXISTS (SELECT 1 FROM json_each(?) wanted WHERE wanted.value = json_extract(s.value, '$.objectHash')) " +
        "OR COALESCE(json_type(s.value, '$.objectHash') != 'text', 1) = 1 " +
        "OR COALESCE(length(CAST(json_extract(s.value, '$.objectHash') AS BLOB)) != 64, 1) = 1 " +
        "OR COALESCE(json_extract(s.value, '$.objectHash') GLOB '*[^0-9a-f]*', 1) = 1) " +
        "AND (m.episode_rowid > ? OR (m.episode_rowid = ? AND CAST(s.key AS INTEGER) > ?))" +
        ") SELECT episode_rowid, meta_valid, removed, blob, blob_type, blob_bytes, manifest_type, spans_type, " +
        "span_index, span_hash, span_hash_type, span_hash_bytes " +
        "FROM candidates ORDER BY episode_rowid ASC, span_index ASC LIMIT ?",
    );
    let afterRowid = 0;
    let afterSpan = -1;
    while (found.size < wanted.size) {
      const rows = rowsQuery.all(
        afterRowid,
        afterRowid,
        afterSpan,
        wantedJson,
        afterRowid,
        afterRowid,
        afterSpan,
        256,
      ) as Array<{
        episode_rowid: number;
        meta_valid: number;
        removed: unknown;
        blob: unknown;
        blob_type: unknown;
        blob_bytes: unknown;
        manifest_type: unknown;
        spans_type: unknown;
        span_index: number;
        span_hash: unknown;
        span_hash_type: unknown;
        span_hash_bytes: unknown;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.episode_rowid) ||
          row.episode_rowid < afterRowid ||
          (row.episode_rowid === afterRowid && row.span_index <= afterSpan)
        ) {
          throw new VaultError("invalid episode rowid during attachment reference scan");
        }
        afterRowid = row.episode_rowid;
        afterSpan = row.span_index;
        if (row.meta_valid !== 1)
          throw new VaultError("episode metadata is malformed during attachment reference scan");
        if (
          row.blob_type !== null &&
          (row.blob_type !== "text" ||
            row.blob_bytes !== 64 ||
            typeof row.blob !== "string" ||
            !/^[0-9a-f]{64}$/u.test(row.blob))
        ) {
          throw new VaultError("attachment object hash is malformed during attachment reference scan");
        }
        if (row.manifest_type !== null && row.manifest_type !== "object") {
          throw new VaultError("attachment manifest is malformed during attachment reference scan");
        }
        if (row.manifest_type === "object" && row.spans_type !== "array") {
          throw new VaultError("attachment manifest spans are malformed during attachment reference scan");
        }
        if (
          row.span_index >= 0 &&
          (row.span_hash_type !== "text" ||
            row.span_hash_bytes !== 64 ||
            typeof row.span_hash !== "string" ||
            !/^[0-9a-f]{64}$/u.test(row.span_hash))
        ) {
          throw new VaultError("attachment span object hash is malformed during attachment reference scan");
        }
        if (row.removed === 1) continue;
        if (row.span_index < 0 && typeof row.blob === "string" && wanted.has(row.blob)) found.add(row.blob);
        if (row.span_index >= 0 && typeof row.span_hash === "string" && wanted.has(row.span_hash)) {
          found.add(row.span_hash);
        }
      }
      if (rows.length < 256) break;
    }
    return found;
  }

  private deleteAttachmentObjects(
    hashes: readonly string[],
    deletion: BlobDeletionStage,
    maxEntries = MAX_BLOB_DELETION_ENTRIES,
  ): string[] {
    const plan = this.attachmentDeletionPlan(hashes, maxEntries);
    const live = this.liveAttachmentReferences([...plan.objects]);
    const processed = new Set<string>();
    const deleteObject = (hash: string): void => {
      if (processed.has(hash)) return;
      processed.add(hash);
      const path = join(this.objectsDir, hash);
      const size = this.blobs.size(hash) ?? (existsSync(path) ? statSync(path).size : null);
      if (size !== null && existsSync(path)) stageBlobForDeletion(deletion, hash, size);
      this.stmt("DELETE FROM blob WHERE hash = ?").run(hash);
    };
    const deleted: string[] = [];
    for (const root of plan.roots) {
      if (live.has(root)) continue;
      deleteObject(root);
      deleted.push(root);
      for (const spanHash of plan.spans.get(root) ?? []) {
        if (!live.has(spanHash)) deleteObject(spanHash);
      }
    }
    return deleted;
  }

  // ------------------------------------------------------------------ blobs

  readonly blobs = {
    /** Begin a durable object deletion stage for a user-authorized forget. */
    beginDelete: (): BlobDeletionStage => createBlobDeletion(this.objectsDir),
    stageDelete: (stage: BlobDeletionStage, hash: string, size: number): void =>
      stageBlobForDeletion(stage, hash, size),
    commitDelete: (stage: BlobDeletionStage): void => commitBlobDeletion(stage),
    cleanupDelete: (
      stage: BlobDeletionStage,
      liveReference?: (hash: string) => { size: number | null } | null,
    ): void => cleanupBlobDeletion(stage, liveReference),
    discardDelete: (stage: BlobDeletionStage): void => discardBlobDeletion(stage),
    put: (bytes: Uint8Array, mime?: string): string => {
      const hash = sha256(bytes);
      return this.tx(() => {
        const promotion = createBlobPromotion(this.objectsDir);
        this.pendingBlobPromotions.push(promotion);
        const staged = new Map<string, { size: number; mime: string }>();
        this.stageAttachmentBlob(promotion, bytes, mime ?? "", staged);
        for (const [objectHash, object] of staged) {
          this.stmt("INSERT OR IGNORE INTO blob (hash, mime, size, created_at) VALUES (?, ?, ?, ?)").run(
            objectHash,
            object.mime.length === 0 ? (mime ?? null) : object.mime,
            object.size,
            Date.now(),
          );
        }
        return hash;
      });
    },
    /** Read the indexed object size without opening the object file. */
    size: (hash: string): number | null => {
      const row = this.stmt("SELECT size FROM blob WHERE hash = ?").get(hash) as { size: number } | undefined;
      return row?.size ?? null;
    },
    get: (hash: string): Uint8Array | null => {
      const path = join(this.objectsDir, hash);
      if (!existsSync(path)) return null;
      return new Uint8Array(readFileSync(path));
    },
    list: (): Array<{ hash: string; mime: string | null; size: number }> =>
      this.stmt("SELECT hash, mime, size FROM blob").all() as Array<{
        hash: string;
        mime: string | null;
        size: number;
      }>,
    /**
     * True if any episode that has not itself been removed still references this
     * hash — across every thread, since `objects/` is one content-addressed store.
     * A scan of `meta`: `forget` is user-initiated and rare, and the alternative
     * is an index paid for on every append.
     */
    referenced: (hash: string): boolean => {
      return this.liveAttachmentReferences([hash]).has(hash);
    },
    /** Resolve all active references in one bounded archive scan. */
    referencedMany: (hashes: readonly string[]): Set<string> => this.liveAttachmentReferences(hashes),
    /** Check the aggregate attachment-object budget before a forget mutates SQL. */
    assertDeletionObjectBudget: (hashes: readonly string[], maxEntries = MAX_BLOB_DELETION_ENTRIES): void => {
      this.attachmentDeletionPlan(hashes, maxEntries);
    },
    deleteMany: (
      hashes: readonly string[],
      deletion: BlobDeletionStage,
      maxEntries = MAX_BLOB_DELETION_ENTRIES,
    ): string[] => this.deleteAttachmentObjects(hashes, deletion, maxEntries),
    /** Delete one whole object and any now-unshared manifest spans. */
    delete: (hash: string, deletion: BlobDeletionStage): void => {
      this.deleteAttachmentObjects([hash], deletion);
    },
  };

  // ------------------------------------------------------ atomization receipts

  /**
   * Durable status for the optional model extractor.  These rows are kernel
   * output, not model assertions: an incomplete row makes any name route from
   * that source unresolved until a later bounded pass replaces it.
   */
  readonly atomization = {
    record: (receipt: AtomizationReceipt): void => {
      this.fragments.assertMutable(receipt.threadId);
      const prior = this.stmt(
        "SELECT status, model, candidate_count, accepted_count, omitted_count, reason, created_at " +
          "FROM atomization_receipt WHERE thread_id = ? AND source_seq = ?",
      ).get(receipt.threadId, receipt.sourceSeq) as {
        status: "complete" | "incomplete";
        model: string | null;
        candidate_count: number;
        accepted_count: number;
        omitted_count: number;
        reason: AtomizationReceipt["reason"] | null;
        created_at: number;
      } | null;
      // A later optional model pass must never erase a bounded rule-stage
      // omission. Keep the worst-known receipt until a future schema can carry
      // independent per-stage rows; route readers therefore remain fail-closed.
      const effective: AtomizationReceipt =
        prior?.status === "incomplete"
          ? {
              ...receipt,
              status: "incomplete",
              model: receipt.model ?? prior.model ?? undefined,
              candidateCount: Math.max(receipt.candidateCount, prior.candidate_count),
              acceptedCount: Math.max(receipt.acceptedCount, prior.accepted_count),
              omittedCount: Math.max(1, receipt.omittedCount, prior.omitted_count),
              reason: receipt.reason ?? prior.reason ?? "candidate-cap",
              createdAt: Math.max(receipt.createdAt, prior.created_at),
            }
          : receipt;
      this.stmt(
        "INSERT INTO atomization_receipt (thread_id, source_seq, source_hash, status, model, " +
          "candidate_count, accepted_count, omitted_count, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(thread_id, source_seq) DO UPDATE SET source_hash = excluded.source_hash, " +
          "status = excluded.status, model = excluded.model, candidate_count = excluded.candidate_count, " +
          "accepted_count = excluded.accepted_count, omitted_count = excluded.omitted_count, " +
          "reason = excluded.reason, created_at = excluded.created_at",
      ).run(
        effective.threadId,
        effective.sourceSeq,
        effective.sourceHash,
        effective.status,
        effective.model ?? null,
        effective.candidateCount,
        effective.acceptedCount,
        effective.omittedCount,
        effective.reason ?? null,
        effective.createdAt,
      );
    },
    get: (threadId: string, sourceSeq: Seq): AtomizationReceipt | null => {
      const row = this.stmt(
        "SELECT thread_id, source_seq, source_hash, status, model, candidate_count, accepted_count, " +
          "omitted_count, reason, created_at FROM atomization_receipt WHERE thread_id = ? AND source_seq = ?",
      ).get(threadId, sourceSeq) as {
        thread_id: string;
        source_seq: number;
        source_hash: string;
        status: "complete" | "incomplete";
        model: string | null;
        candidate_count: number;
        accepted_count: number;
        omitted_count: number;
        reason: AtomizationReceipt["reason"] | null;
        created_at: number;
      } | null;
      if (row === null) return null;
      return {
        threadId: row.thread_id,
        sourceSeq: row.source_seq,
        sourceHash: row.source_hash,
        status: row.status,
        ...(row.model === null ? {} : { model: row.model }),
        candidateCount: row.candidate_count,
        acceptedCount: row.accepted_count,
        omittedCount: row.omitted_count,
        ...(row.reason === null ? {} : { reason: row.reason }),
        createdAt: row.created_at,
      };
    },
    hasIncomplete: (threadId: string, sourceSeq?: Seq): boolean => {
      const row =
        sourceSeq === undefined
          ? this.stmt(
              "SELECT 1 FROM atomization_receipt WHERE thread_id = ? AND status = 'incomplete' LIMIT 1",
            ).get(threadId)
          : this.stmt(
              "SELECT 1 FROM atomization_receipt WHERE thread_id = ? AND source_seq = ? AND status = 'incomplete' LIMIT 1",
            ).get(threadId, sourceSeq);
      return row !== null;
    },
    incomplete: (threadId: string): AtomizationReceipt[] => {
      const rows = this.stmt(
        "SELECT thread_id, source_seq, source_hash, status, model, candidate_count, accepted_count, " +
          "omitted_count, reason, created_at FROM atomization_receipt " +
          "WHERE thread_id = ? AND status = 'incomplete' ORDER BY source_seq ASC LIMIT 512",
      ).all(threadId) as Array<{
        thread_id: string;
        source_seq: number;
        source_hash: string;
        status: "complete" | "incomplete";
        model: string | null;
        candidate_count: number;
        accepted_count: number;
        omitted_count: number;
        reason: AtomizationReceipt["reason"] | null;
        created_at: number;
      }>;
      return rows.map((row) => ({
        threadId: row.thread_id,
        sourceSeq: row.source_seq,
        sourceHash: row.source_hash,
        status: row.status,
        ...(row.model === null ? {} : { model: row.model }),
        candidateCount: row.candidate_count,
        acceptedCount: row.accepted_count,
        omittedCount: row.omitted_count,
        ...(row.reason === null ? {} : { reason: row.reason }),
        createdAt: row.created_at,
      }));
    },
  };

  // ------------------------------------------------------------------ atoms

  readonly atoms = {
    insert: (atom: Atom): void => {
      this.assertAtomDerivedReady(atom.threadId);
      this.stmt(
        "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
          "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        atom.id,
        atom.threadId,
        atom.kind,
        atom.key,
        atom.value,
        atom.text,
        atom.sourceSeq,
        atom.sourceSpan ? canonicalJson(atom.sourceSpan) : null,
        atom.validFromSeq,
        atom.validToSeq ?? null,
        atom.supersededBy ?? null,
        atom.phase,
        atom.authority,
        atom.scope,
        atom.pinned ? 1 : 0,
        atom.confidence,
        atom.createdBy,
        atom.createdAt,
      );
      this.atoms.indexNames(atom);
      this.bump(atom.threadId, { [phaseCounter(atom.phase)]: 1 });
    },

    /**
     * Index the names this atom is *about*, so a query naming the subject can
     * reach the current certificate even when the frontier is over capacity.
     * Derived, never exported: import rebuilds it row by row (KERNEL A11.4).
     */
    indexNames: (atom: Atom): void => {
      const link = this.stmt("INSERT OR IGNORE INTO atom_name (thread_id, name, atom_id) VALUES (?, ?, ?)");
      const seen = new Set<string>([atom.key.toLowerCase()]);
      for (const hit of names(atom.text, { max: 6 })) seen.add(hit.name);
      const value = atom.value.replace(/\s+/g, " ").trim().toLowerCase();
      if (value.length > 1 && value.length <= 96) seen.add(value);
      for (const name of seen) link.run(atom.threadId, name.slice(0, 96), atom.id);
    },

    /**
     * Bounded migration projection. Legacy atoms can exceed the online atom
     * field caps; the migration keeps their rows valid and routes by the
     * bounded key/value/text projection it was able to hydrate.
     */
    indexNamesForMigration: (row: {
      thread_id: string;
      id: string;
      key_prefix: string;
      value_prefix: string;
      text: string;
      phase: string;
    }): void => {
      if (row.phase === "REVOKED") return;
      const link = this.stmt("INSERT OR IGNORE INTO atom_name (thread_id, name, atom_id) VALUES (?, ?, ?)");
      const seen = new Set<string>([row.key_prefix.toLowerCase()]);
      for (const hit of names(row.text, { max: 6 })) seen.add(hit.name);
      const value = row.value_prefix.replace(/\s+/g, " ").trim().toLowerCase();
      if (value.length > 1 && value.length <= 96) seen.add(value);
      for (const name of seen) link.run(row.thread_id, name.slice(0, 96), row.id);
    },

    /** Current atoms for a key, most recent first. */
    byKey: (threadId: string, key: string, phase: AtomPhase = "SUPPORTED"): Atom[] =>
      (
        this.stmt(
          "SELECT * FROM atom WHERE thread_id = ? AND key = ? AND phase = ? ORDER BY valid_from_seq DESC",
        ).all(threadId, key, phase) as AtomRow[]
      ).map(toAtom),

    /** One current or historical atom, without materializing the revision chain. */
    latestByKey: (
      threadId: string,
      key: string,
      phase: AtomPhase = "SUPPORTED",
      authority?: AtomAuthority,
    ): Atom | null => {
      const row =
        authority === undefined
          ? (this.stmt(
              "SELECT * FROM atom WHERE thread_id = ? AND key = ? AND phase = ? " +
                "ORDER BY valid_from_seq DESC LIMIT 1",
            ).get(threadId, key, phase) as AtomRow | undefined)
          : (this.stmt(
              "SELECT * FROM atom WHERE thread_id = ? AND key = ? AND phase = ? AND authority = ? " +
                "ORDER BY valid_from_seq DESC LIMIT 1",
            ).get(threadId, key, phase, authority) as AtomRow | undefined);
      return row == null ? null : toAtom(row);
    },

    /** All atoms for a key across phases, newest first. */
    historyOf: (threadId: string, key: string): Atom[] =>
      (
        this.stmt("SELECT * FROM atom WHERE thread_id = ? AND key = ? ORDER BY valid_from_seq DESC").all(
          threadId,
          key,
        ) as AtomRow[]
      ).map(toAtom),

    list: (
      threadId: string,
      opts: { phase?: AtomPhase; key?: string; limit?: number; kind?: string; kinds?: string[] } = {},
    ): Atom[] => {
      const clauses = ["thread_id = ?"];
      const params: unknown[] = [threadId];
      if (opts.phase) {
        clauses.push("phase = ?");
        params.push(opts.phase);
      }
      if (opts.key) {
        clauses.push("key = ?");
        params.push(opts.key);
      }
      if (opts.kind) {
        clauses.push("kind = ?");
        params.push(opts.kind);
      }
      if (opts.kinds && opts.kinds.length > 0) {
        clauses.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
        params.push(...opts.kinds);
      }
      params.push(Math.max(1, Math.min(opts.limit ?? 500, 20000)));
      return (
        this.stmt(
          // The frontier lane index covers phase/pinned/kind; this general
          // reader still keeps its projection bounded independently of it.
          `SELECT * FROM atom WHERE ${clauses.join(" AND ")} ORDER BY valid_from_seq DESC LIMIT ?`,
        ).all(...(params as never[])) as AtomRow[]
      ).map(toAtom);
    },

    /**
     * SQL-first candidate projection for the context frontier. Metadata is
     * walked by `(valid_from_seq,id)` keyset pages; only rows admitted by
     * the aggregate prefix budget are hydrated, and every text field is
     * projected with a strict cap before crossing into JavaScript.
     */
    frontierCandidates: (
      threadId: string,
      opts: FrontierAtomCandidateOptions = {},
    ): FrontierAtomCandidates => {
      if (!this.atomAuthorityReady(threadId)) return { atoms: [], bytes: 0, hasMore: true, scanned: 0 };
      const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 500), 2_000));
      const byteBudget = Math.max(
        0,
        Math.min(Math.floor(opts.byteBudget ?? FRONTIER_ATOM_PREFETCH_BYTES), FRONTIER_ATOM_PREFETCH_BYTES),
      );
      if (byteBudget === 0) return { atoms: [], bytes: 0, hasMore: true, scanned: 0 };
      const where = ["thread_id = ?"];
      const baseParams: unknown[] = [threadId];
      if (opts.phase !== undefined) {
        where.push("phase = ?");
        baseParams.push(opts.phase);
      }
      if (opts.kinds !== undefined && opts.kinds.length > 0) {
        where.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
        baseParams.push(...opts.kinds);
      }
      if (opts.pinned !== undefined) {
        where.push("pinned = ?");
        baseParams.push(opts.pinned ? 1 : 0);
      }
      const metadataBase =
        "SELECT rowid AS reader_rowid, valid_from_seq, " +
        "length(CAST(key AS BLOB)) AS key_bytes, " +
        "length(CAST(value AS BLOB)) AS value_bytes, " +
        "length(CAST(text AS BLOB)) AS text_bytes, " +
        "length(CAST(source_span AS BLOB)) AS source_span_bytes " +
        "FROM atom WHERE " +
        `${where.join(" AND ")} `;
      // Ties break on rowid — insertion order — because atom ids carry `newId`
      // entropy and this order decides which atoms a packet shows.
      const firstMetadata = this.stmt(`${metadataBase}ORDER BY valid_from_seq DESC, rowid DESC LIMIT ?`);
      const continuedMetadata = this.stmt(
        `${metadataBase}AND (valid_from_seq < ? OR (valid_from_seq = ? AND rowid < ?)) ` +
          "ORDER BY valid_from_seq DESC, rowid DESC LIMIT ?",
      );
      const atoms: Atom[] = [];
      let bytes = 0;
      let scanned = 0;
      let cursorSeq: number | undefined;
      let cursorRowid: number | undefined;
      let hasMore = false;
      while (atoms.length < limit && scanned < FRONTIER_ATOM_MAX_SCAN) {
        const batchLimit = Math.min(FRONTIER_ATOM_SCAN_BATCH, FRONTIER_ATOM_MAX_SCAN - scanned);
        const rows = (
          cursorSeq === undefined
            ? firstMetadata.all(...baseParams, batchLimit)
            : continuedMetadata.all(...baseParams, cursorSeq, cursorSeq, cursorRowid, batchLimit)
        ) as FrontierAtomMetadataRow[];
        if (rows.length === 0) break;
        scanned += rows.length;
        const selected: FrontierAtomMetadataRow[] = [];
        let stop = false;
        for (const row of rows) {
          const cost = frontierAtomBytes(row);
          if (cost > byteBudget - bytes || atoms.length + selected.length >= limit) {
            hasMore = true;
            stop = true;
            break;
          }
          selected.push(row);
          bytes += cost;
        }
        if (selected.length > 0) {
          const placeholders = selected.map(() => "?").join(", ");
          const projected = this.stmt(
            `SELECT ${boundedAtomColumns("a")}, a.rowid AS reader_rowid FROM atom a ` +
              `WHERE a.thread_id = ? AND a.rowid IN (${placeholders})`,
          ).all(threadId, ...selected.map((row) => row.reader_rowid)) as Array<
            AtomViewRow & { reader_rowid: number }
          >;
          const byRowid = new Map<number, Atom>();
          for (const row of projected) {
            byRowid.set(
              row.reader_rowid,
              toBoundedAtom(row, FRONTIER_ATOM_TEXT_LIMIT, FRONTIER_ATOM_VALUE_LIMIT),
            );
          }
          for (const row of selected) {
            const atom = byRowid.get(row.reader_rowid);
            if (atom !== undefined) atoms.push(atom);
          }
          const last = selected.at(-1) as FrontierAtomMetadataRow;
          cursorSeq = last.valid_from_seq;
          cursorRowid = last.reader_rowid;
        }
        if (stop) break;
        const last = rows.at(-1) as FrontierAtomMetadataRow;
        cursorSeq = last.valid_from_seq;
        cursorRowid = last.reader_rowid;
        if (rows.length < batchLimit) break;
        if (scanned >= FRONTIER_ATOM_MAX_SCAN) hasMore = true;
      }
      if (scanned >= FRONTIER_ATOM_MAX_SCAN) hasMore = true;
      return { atoms, bytes, hasMore, scanned };
    },

    /** Indexed existence probe used to avoid eight empty pinned lanes per turn. */
    hasPinned: (threadId: string, phase: AtomPhase = "SUPPORTED"): boolean => {
      if (!this.atomAuthorityReady(threadId)) return false;
      return (
        this.stmt("SELECT 1 FROM atom WHERE thread_id = ? AND phase = ? AND pinned = 1 LIMIT 1").get(
          threadId,
          phase,
        ) !== null
      );
    },

    /** Distinct indexed kinds let the compiler open only non-empty priority lanes. */
    frontierKinds: (threadId: string, phase: AtomPhase = "SUPPORTED", pinned?: boolean): string[] => {
      if (!this.atomAuthorityReady(threadId)) return [];
      const clauses = ["thread_id = ?", "phase = ?"];
      const params: unknown[] = [threadId, phase];
      if (pinned !== undefined) {
        clauses.push("pinned = ?");
        params.push(pinned ? 1 : 0);
      }
      return (
        this.stmt(`SELECT kind FROM atom WHERE ${clauses.join(" AND ")} GROUP BY kind ORDER BY kind ASC`).all(
          ...(params as never[]),
        ) as Array<{ kind: string }>
      ).map((row) => row.kind);
    },

    /**
     * SQL-first atom page for ordinary readers.  The selected strings are
     * byte-prefixes, and one extra row is selected only as a hasMore sentinel;
     * no full derived atom crosses into JavaScript.
     */
    listBounded: (
      threadId: string,
      opts: {
        phase?: AtomPhase;
        limit?: number;
        after?: string;
      } = {},
    ): { atoms: AtomView[]; hasMore: boolean; nextCursor?: string } => {
      const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? MAX_ATOM_PAGE_ITEMS), MAX_ATOM_PAGE_ITEMS));
      const afterRowid = decodeReaderRowid(opts.after);
      if (opts.after !== undefined && afterRowid === undefined) {
        throw new VaultError("invalid atom reader cursor");
      }
      const where = ["a.thread_id = ?"];
      const params: unknown[] = [threadId];
      if (opts.phase !== undefined) {
        where.push("a.phase = ?");
        params.push(opts.phase);
      }
      if (afterRowid !== undefined) {
        where.push("a.rowid < ?");
        params.push(afterRowid);
      }
      params.push(limit + 1);
      const rows = this.stmt(
        `SELECT a.rowid AS reader_rowid, ${boundedAtomPageColumns("a")} FROM atom a ` +
          `WHERE ${where.join(" AND ")} ORDER BY a.rowid DESC LIMIT ?`,
      ).all(...(params as never[])) as AtomPageRow[];
      const hasMore = rows.length > limit;
      const kept = hasMore ? rows.slice(0, limit) : rows;
      const last = kept.at(-1);
      return {
        atoms: kept.map(toAtomView),
        hasMore,
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeReaderCursor({ rowid: last.reader_rowid }) }
          : {}),
      };
    },

    /** Thread-scoped bounded atom lookup for ordinary mutation responses. */
    getBounded: (threadId: string, atomId: string): AtomView | null => {
      const row = this.stmt(
        `SELECT a.rowid AS reader_rowid, ${boundedAtomPageColumns("a")} FROM atom a ` +
          "WHERE a.thread_id = ? AND a.id = ? LIMIT 1",
      ).get(threadId, atomId) as AtomPageRow | undefined;
      return row == null ? null : toAtomView(row);
    },

    /**
     * Bounded lexical atom search for the ordinary search endpoint. The
     * predicate runs inside SQLite over the full text, while every selected
     * string column is projected to a bounded prefix before the row reaches
     * JavaScript. This preserves matches that occur after the retained prefix
     * without hydrating the imported source.
     */
    searchBounded: (
      threadId: string,
      query: string,
      limit = 40,
      textLimit = 2_048,
      valueLimit = 2_048,
    ): Atom[] => {
      const needle = query.trim();
      if (needle.length === 0) return [];
      const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 40));
      const rows = this.stmt(
        `SELECT ${boundedAtomColumns("a")} FROM atom a ` +
          "WHERE a.thread_id = ? AND instr(lower(a.text), lower(?)) > 0 " +
          "ORDER BY a.valid_from_seq DESC, a.id DESC LIMIT ?",
      ).all(threadId, needle, boundedLimit) as AtomViewRow[];
      return rows.map((row) => toBoundedAtom(row, textLimit, valueLimit));
    },

    get: (id: string): Atom | null => {
      const row = this.stmt("SELECT * FROM atom WHERE id = ?").get(id) as AtomRow | undefined;
      return row == null ? null : toAtom(row);
    },

    /**
     * Atoms a query name refers to: the current certificate first, then the
     * superseded ones. This is the frontier-overflow path (THEORY §12) — when
     * the live frontier is wider than the budget, the answer is paged, exactly,
     * rather than dropped.
     */
    /** SUPPORTED atoms whose normalized value equals this string (indexed). */
    byValue: (threadId: string, value: string, limit = 4): Atom[] => {
      if (!this.atomRoutingReady()) return [];
      return (
        this.stmt(
          "SELECT a.* FROM atom_name n JOIN atom a ON a.id = n.atom_id " +
            "WHERE n.thread_id = ? AND n.name = ? AND a.phase = 'SUPPORTED' " +
            "AND NOT EXISTS (SELECT 1 FROM atomization_receipt r WHERE r.thread_id = a.thread_id " +
            "AND r.source_seq = a.source_seq AND r.status = 'incomplete') " +
            "AND NOT EXISTS (SELECT 1 FROM migration_progress p WHERE p.thread_id = n.thread_id " +
            "AND p.name = ? AND p.status != 'complete') " +
            "ORDER BY a.valid_from_seq DESC LIMIT ?",
        ).all(threadId, value, ATOM_NAME_REBUILD, limit) as AtomRow[]
      ).map(toAtom);
    },

    byName: (threadId: string, name: string, limit = 4): Atom[] => {
      if (!this.atomRoutingReady()) return [];
      return (
        this.stmt(
          "SELECT a.* FROM atom_name n JOIN atom a ON a.id = n.atom_id " +
            "WHERE n.thread_id = ? AND n.name = ? AND a.phase != 'REVOKED' " +
            "AND NOT EXISTS (SELECT 1 FROM atomization_receipt r WHERE r.thread_id = a.thread_id " +
            "AND r.source_seq = a.source_seq AND r.status = 'incomplete') " +
            "AND NOT EXISTS (SELECT 1 FROM migration_progress p WHERE p.thread_id = n.thread_id " +
            "AND p.name = ? AND p.status != 'complete') " +
            "ORDER BY (a.phase = 'SUPPORTED') DESC, a.valid_from_seq DESC LIMIT ?",
        ).all(threadId, name, ATOM_NAME_REBUILD, limit) as AtomRow[]
      ).map(toAtom);
    },

    /**
     * Startup-only atom-name page. The candidate walk is ordered by the exact
     * `(thread_id, valid_from_seq, id)` index. `afterRowid` remains the public
     * cursor for existing compaction callers; it is resolved to the indexed
     * `(valid_from_seq,id)` boundary before the page query, so no temporary
     * rowid sort is needed.
     */
    atomNameMigrationPage: (
      threadId: string,
      from: Seq,
      to: Seq,
      afterRowid = 0,
      limit = ATOM_MIGRATION_BATCH,
      byteBudget = ATOM_NAME_MIGRATION_BYTES_PER_OPEN,
    ): {
      rows: Array<{
        thread_id: string;
        id: string;
        key_prefix: string;
        value_prefix: string;
        text: string;
        phase: string;
      }>;
      nextRowid?: number;
      hasMore: boolean;
      bytes: number;
    } => {
      const boundedLimit = Math.max(1, Math.min(Math.floor(limit), ATOM_MIGRATION_BATCH));
      const boundedBytes = Math.max(1, Math.floor(byteBudget));
      if (!Number.isSafeInteger(afterRowid) || afterRowid < 0) {
        throw new VaultError("invalid atom migration cursor");
      }
      const boundary =
        afterRowid === 0
          ? null
          : (this.stmt("SELECT valid_from_seq, id FROM atom WHERE thread_id = ? AND rowid = ? LIMIT 1").get(
              threadId,
              afterRowid,
            ) as { valid_from_seq: number; id: string } | undefined);
      if (afterRowid > 0 && boundary === undefined) {
        throw new VaultError("invalid atom migration cursor");
      }
      const rows = (
        boundary === null
          ? this.stmt(
              "SELECT rowid AS reader_rowid, id, thread_id, phase, " +
                "CAST(substr(CAST(key AS BLOB), 1, 96) AS TEXT) AS key_prefix, " +
                "CAST(substr(CAST(value AS BLOB), 1, 96) AS TEXT) AS value_prefix, " +
                "length(CAST(text AS BLOB)) AS text_bytes " +
                "FROM atom WHERE thread_id = ? AND valid_from_seq BETWEEN ? AND ? " +
                "ORDER BY valid_from_seq ASC, id ASC LIMIT ?",
            ).all(threadId, from, to, boundedLimit + 1)
          : this.stmt(
              "SELECT rowid AS reader_rowid, id, thread_id, phase, " +
                "CAST(substr(CAST(key AS BLOB), 1, 96) AS TEXT) AS key_prefix, " +
                "CAST(substr(CAST(value AS BLOB), 1, 96) AS TEXT) AS value_prefix, " +
                "length(CAST(text AS BLOB)) AS text_bytes " +
                "FROM atom WHERE thread_id = ? AND valid_from_seq BETWEEN ? AND ? " +
                "AND (valid_from_seq > ? OR (valid_from_seq = ? AND id > ?)) " +
                "ORDER BY valid_from_seq ASC, id ASC LIMIT ?",
            ).all(
              threadId,
              from,
              to,
              boundary?.valid_from_seq,
              boundary?.valid_from_seq,
              boundary?.id,
              boundedLimit + 1,
            )
      ) as Array<{
        reader_rowid: number;
        id: string;
        thread_id: string;
        phase: string;
        key_prefix: string | Uint8Array | null;
        value_prefix: string | Uint8Array | null;
        text_bytes: number | null;
      }>;
      const selected = rows.slice(0, boundedLimit);
      const textStmt = this.stmt(
        "SELECT CAST(substr(CAST(text AS BLOB), 1, ?) AS TEXT) AS text FROM atom " +
          "WHERE thread_id = ? AND rowid = ? LIMIT 1",
      );
      const decode = (value: string | Uint8Array | null): string => {
        if (typeof value === "string") return value;
        if (value === null) return "";
        return new TextDecoder().decode(value);
      };
      const output: Array<{
        thread_id: string;
        id: string;
        key_prefix: string;
        value_prefix: string;
        text: string;
        phase: string;
      }> = [];
      let bytes = 0;
      for (const row of selected) {
        const key = decode(row.key_prefix);
        const value = decode(row.value_prefix);
        const baseBytes = Buffer.byteLength(key) + Buffer.byteLength(value);
        if (output.length > 0 && bytes + baseBytes > boundedBytes) break;
        const remaining = Math.max(0, boundedBytes - bytes - baseBytes);
        const textBytes = Number.isSafeInteger(row.text_bytes) ? (row.text_bytes as number) : 0;
        const textLimit = Math.min(textBytes, remaining);
        const textRow =
          textLimit > 0
            ? (textStmt.get(textLimit, threadId, row.reader_rowid) as { text: string | null } | undefined)
            : undefined;
        const text = textRow?.text ?? "";
        const rowBytes = baseBytes + Buffer.byteLength(text);
        output.push({
          thread_id: row.thread_id,
          id: row.id,
          key_prefix: key,
          value_prefix: value,
          text,
          phase: row.phase,
        });
        bytes += rowBytes;
        if (bytes >= boundedBytes) break;
      }
      const nextRowid = output.length === 0 ? undefined : selected[output.length - 1]?.reader_rowid;
      return {
        rows: output,
        ...(nextRowid === undefined ? {} : { nextRowid }),
        hasMore: rows.length > output.length,
        bytes,
      };
    },

    /** Atoms whose validity begins inside `[from, to]` — the capsule's certificates. */
    inRange: (threadId: string, from: Seq, to: Seq): Atom[] =>
      !this.atomAuthorityReady(threadId)
        ? []
        : (
            this.stmt(
              "SELECT * FROM atom WHERE thread_id = ? AND valid_from_seq BETWEEN ? AND ? ORDER BY valid_from_seq ASC",
            ).all(threadId, from, to) as AtomRow[]
          ).map(toAtom),

    /**
     * Exhaustive startup-repair page. This is deliberately separate from
     * `inRange`: online callers fail closed at the aggregate projection cap,
     * while a derived-index migration must keyset through a dense sequence
     * range until every atom has been visited.
     */
    inRangeForMigration: (
      threadId: string,
      from: Seq,
      to: Seq,
      afterRowid = 0,
      limit = ATOM_MIGRATION_BATCH,
    ): { atoms: Atom[]; nextRowid?: number; hasMore: boolean } => {
      if (!this.atomAuthorityReady(threadId)) {
        throw new VaultError("atom authority migration is incomplete; retry after startup repair");
      }
      const boundedLimit = Math.max(1, Math.min(Math.floor(limit), ATOM_MIGRATION_BATCH));
      if (!Number.isSafeInteger(afterRowid) || afterRowid < 0) {
        throw new VaultError("invalid atom migration cursor");
      }
      const boundary =
        afterRowid === 0
          ? null
          : (this.stmt("SELECT valid_from_seq FROM atom WHERE thread_id = ? AND rowid = ? LIMIT 1").get(
              threadId,
              afterRowid,
            ) as { valid_from_seq: number } | undefined);
      if (afterRowid > 0 && boundary === undefined) {
        throw new VaultError("invalid atom migration cursor");
      }
      // Ties break on rowid — insertion order — because atom ids carry `newId`
      // entropy, and a capsule's text and ledger are derived from this order.
      const rows = (
        boundary === null
          ? this.stmt(
              "SELECT rowid AS reader_rowid, a.* FROM atom a " +
                "WHERE a.thread_id = ? AND a.valid_from_seq BETWEEN ? AND ? " +
                "ORDER BY a.valid_from_seq ASC, a.rowid ASC LIMIT ?",
            ).all(threadId, from, to, boundedLimit + 1)
          : this.stmt(
              "SELECT rowid AS reader_rowid, a.* FROM atom a " +
                "WHERE a.thread_id = ? AND a.valid_from_seq BETWEEN ? AND ? " +
                "AND (a.valid_from_seq > ? OR (a.valid_from_seq = ? AND a.rowid > ?)) " +
                "ORDER BY a.valid_from_seq ASC, a.rowid ASC LIMIT ?",
            ).all(
              threadId,
              from,
              to,
              boundary?.valid_from_seq,
              boundary?.valid_from_seq,
              afterRowid,
              boundedLimit + 1,
            )
      ) as Array<AtomRow & { reader_rowid: number }>;
      const selected = rows.slice(0, boundedLimit);
      const nextRowid = selected.at(-1)?.reader_rowid;
      return {
        atoms: selected.map(toAtom),
        ...(nextRowid === undefined ? {} : { nextRowid }),
        hasMore: rows.length > boundedLimit,
      };
    },

    /**
     * Supersede: never overwrite, always interval-close (KERNEL §2). Also how an
     * open proposal is closed when the user finally rules on its key (A9.1) —
     * `prior.phase` says which counter the row is leaving.
     */
    supersede: (threadId: string, prior: Atom, byId: string, atSeq: Seq): void => {
      this.stmt(
        "UPDATE atom SET phase = 'HISTORICAL', valid_to_seq = ?, superseded_by = ? WHERE id = ? AND thread_id = ?",
      ).run(atSeq, byId, prior.id, threadId);
      this.bump(threadId, { [phaseCounter(prior.phase)]: -1 });
      this.bump(threadId, { [COUNTERS.atomsHistorical]: 1 });
    },

    pin: (threadId: string, atomId: string, pinned: boolean): void => {
      this.stmt("UPDATE atom SET pinned = ? WHERE id = ? AND thread_id = ?").run(
        pinned ? 1 : 0,
        atomId,
        threadId,
      );
    },

    revoke: (threadId: string, atomId: string): void => {
      this.stmt("UPDATE atom SET phase = 'REVOKED' WHERE id = ? AND thread_id = ?").run(atomId, threadId);
    },
  };

  /**
   * Upgrade receipt-null capsule arrays on demand before a v2 export. JSON1
   * walks one locator at a time, so an old dense `dropped` value never crosses
   * the SQLite/JS boundary as one string or array.
   */
  normalizeLegacyCapsuleLedgers(threadId: string): number {
    const rows = this.stmt(
      "SELECT id, level, from_seq, to_seq, hash FROM capsule " +
        "WHERE thread_id = ? AND ledger_receipt IS NULL ORDER BY level ASC, from_seq ASC",
    ).iterate(threadId) as Iterable<{
      id: string;
      level: number;
      from_seq: number;
      to_seq: number;
      hash: string;
    }>;
    let changed = 0;
    for (const capsule of rows) {
      this.tx(() => {
        const arrays = this.stmt(
          "SELECT json_valid(dropped) AS dropped_valid, json_type(dropped) AS dropped_type, " +
            "json_valid(kept) AS kept_valid, json_type(kept) AS kept_type FROM capsule WHERE id = ?",
        ).get(capsule.id) as {
          dropped_valid: number;
          dropped_type: string | null;
          kept_valid: number;
          kept_type: string | null;
        };
        if (
          arrays.dropped_valid !== 1 ||
          arrays.dropped_type !== "array" ||
          arrays.kept_valid !== 1 ||
          arrays.kept_type !== "array"
        ) {
          throw new VaultError(`legacy capsule ${capsule.id} has malformed ledger arrays`);
        }
        this.stmt("DELETE FROM capsule_ledger_entry WHERE capsule_id = ?").run(capsule.id);
        const receipt = { version: 1 } as CapsuleLedgerReceipt;
        let droppedPreview: LossEntry[] = [];
        let keptEntries: LossEntry[] = [];
        for (const part of ["dropped", "kept"] as const) {
          const column = part === "dropped" ? "dropped" : "kept";
          const hash = createHash("sha256");
          const embedded: LossEntry[] = [];
          let embeddedBytes = 2;
          let count = 0;
          const entries = this.stmt(
            `SELECT json_extract(j.value, '$.name') AS name, json_extract(j.value, '$.kind') AS kind, ` +
              `json_extract(j.value, '$.seq') AS seq, json_extract(j.value, '$.span') AS span ` +
              `FROM capsule c, json_each(c.${column}) j WHERE c.id = ? ` +
              `ORDER BY seq ASC, name ASC`,
          ).iterate(capsule.id) as Iterable<{
            name: unknown;
            kind: unknown;
            seq: unknown;
            span: unknown;
          }>;
          const insert = this.stmt(
            "INSERT INTO capsule_ledger_entry " +
              "(thread_id, capsule_id, part, ordinal, name, kind, seq, span) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          );
          for (const row of entries) {
            if (
              typeof row.name !== "string" ||
              typeof row.kind !== "string" ||
              !["entity", "number", "quote", "atom", "date", "code"].includes(row.kind) ||
              !Number.isSafeInteger(row.seq) ||
              (row.seq as number) < capsule.from_seq ||
              (row.seq as number) > capsule.to_seq
            ) {
              throw new VaultError(`legacy capsule ${capsule.id} has an invalid ledger locator`);
            }
            let span: [number, number] | undefined;
            if (row.span !== null) {
              const candidate = typeof row.span === "string" ? (JSON.parse(row.span) as unknown) : row.span;
              if (
                !Array.isArray(candidate) ||
                candidate.length !== 2 ||
                !Number.isSafeInteger(candidate[0]) ||
                !Number.isSafeInteger(candidate[1]) ||
                (candidate[0] as number) < 0 ||
                (candidate[1] as number) < (candidate[0] as number)
              ) {
                throw new VaultError(`legacy capsule ${capsule.id} has an invalid ledger span`);
              }
              span = [candidate[0] as number, candidate[1] as number];
            }
            const entry: LossEntry = {
              name: row.name,
              kind: row.kind as LossEntry["kind"],
              seq: row.seq as number,
              ...(span === undefined ? {} : { span }),
            };
            const encoded = canonicalJson(entry);
            hash.update(`${encoded}\n`, "utf8");
            insert.run(
              threadId,
              capsule.id,
              part,
              count,
              entry.name,
              entry.kind,
              entry.seq,
              entry.span === undefined ? null : canonicalJson(entry.span),
            );
            const nextBytes = Buffer.byteLength(encoded, "utf8") + (embedded.length === 0 ? 0 : 1);
            if (
              (part === "kept" || embedded.length < 256) &&
              embeddedBytes + nextBytes <= (part === "kept" ? 2 * 1024 * 1024 : 64 * 1024)
            ) {
              embedded.push(entry);
              embeddedBytes += nextBytes;
            }
            count += 1;
          }
          if (part === "kept" && embedded.length !== count) {
            throw new VaultError("legacy capsule kept ledger exceeds 2097152 JSON bytes");
          }
          const complete = embedded.length === count;
          const cursor = complete
            ? undefined
            : Buffer.from(
                JSON.stringify({
                  version: 1,
                  capsuleId: capsule.id,
                  capsuleHash: capsule.hash,
                  part,
                  after: embedded.length - 1,
                }),
                "utf8",
              ).toString("base64url");
          receipt[part] = {
            count,
            embeddedCount: embedded.length,
            digest: hash.digest("hex"),
            complete,
            ...(cursor === undefined ? {} : { cursor }),
          };
          if (part === "dropped") droppedPreview = embedded;
          else keptEntries = embedded;
        }
        this.stmt("UPDATE capsule SET dropped = ?, kept = ?, ledger_receipt = ? WHERE id = ?").run(
          canonicalJson(droppedPreview),
          canonicalJson(keptEntries),
          canonicalJson(receipt),
          capsule.id,
        );
      });
      changed += 1;
    }
    return changed;
  }

  // --------------------------------------------------------------- capsules

  readonly capsules = {
    insert: (capsule: StoredCapsule): void => {
      this.stmt(
        "INSERT OR REPLACE INTO capsule (id, thread_id, level, from_seq, to_seq, text, tokens, dropped, " +
          "carried_count, kept, ledger_receipt, hash, created_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        capsule.id,
        capsule.threadId,
        capsule.level,
        capsule.fromSeq,
        capsule.toSeq,
        capsule.text,
        capsule.tokens,
        canonicalJson(capsule.dropped),
        capsule.carriedCount,
        canonicalJson(capsule.kept),
        capsule.ledgerReceipt === undefined ? null : canonicalJson(capsule.ledgerReceipt),
        capsule.hash,
        capsule.createdBy,
        capsule.createdAt,
      );
      this.bump(capsule.threadId, { [COUNTERS.capsules]: 1 });
    },

    /** Replace the rolling root in place (KERNEL A3). */
    replace: (capsule: StoredCapsule): void => {
      this.stmt(
        "UPDATE capsule SET level = ?, from_seq = ?, to_seq = ?, text = ?, tokens = ?, dropped = ?, " +
          "carried_count = ?, kept = ?, ledger_receipt = ?, hash = ?, created_by = ?, created_at = ? " +
          "WHERE id = ?",
      ).run(
        capsule.level,
        capsule.fromSeq,
        capsule.toSeq,
        capsule.text,
        capsule.tokens,
        canonicalJson(capsule.dropped),
        capsule.carriedCount,
        canonicalJson(capsule.kept),
        capsule.ledgerReceipt === undefined ? null : canonicalJson(capsule.ledgerReceipt),
        capsule.hash,
        capsule.createdBy,
        capsule.createdAt,
        capsule.id,
      );
    },

    get: (id: string): StoredCapsule | null => {
      const row = this.stmt("SELECT * FROM capsule WHERE id = ?").get(id) as CapsuleRow | undefined;
      return row == null ? null : toCapsule(row);
    },

    at: (threadId: string, level: number, fromSeq: Seq): StoredCapsule | null => {
      const row = this.stmt("SELECT * FROM capsule WHERE thread_id = ? AND level = ? AND from_seq = ?").get(
        threadId,
        level,
        fromSeq,
      ) as CapsuleRow | undefined;
      return row == null ? null : toCapsule(row);
    },

    /** The most recent `limit` capsules at a level, newest first. */
    recent: (threadId: string, level: number, limit: number): StoredCapsule[] =>
      (
        this.stmt(
          "SELECT * FROM capsule WHERE thread_id = ? AND level = ? ORDER BY from_seq DESC LIMIT ?",
        ).all(threadId, level, limit) as CapsuleRow[]
      ).map(toCapsule),

    list: (threadId: string, level?: number, limit = 500): StoredCapsule[] =>
      (level === undefined
        ? (this.stmt(
            "SELECT * FROM capsule WHERE thread_id = ? ORDER BY level DESC, from_seq ASC LIMIT ?",
          ).all(threadId, limit) as CapsuleRow[])
        : (this.stmt(
            "SELECT * FROM capsule WHERE thread_id = ? AND level = ? ORDER BY from_seq ASC LIMIT ?",
          ).all(threadId, level, limit) as CapsuleRow[])
      ).map(toCapsule),

    /** SQL-first capsule metadata page; capsule prose and loss arrays stay in SQLite. */
    listBounded: (
      threadId: string,
      level?: number,
      opts: { limit?: number; after?: string } = {},
    ): { capsules: CapsuleView[]; hasMore: boolean; nextCursor?: string } => {
      const limit = Math.max(
        1,
        Math.min(Math.floor(opts.limit ?? MAX_CAPSULE_PAGE_ITEMS), MAX_CAPSULE_PAGE_ITEMS),
      );
      const cursor = decodeCapsuleCursor(opts.after);
      if (opts.after !== undefined && cursor === undefined) {
        throw new VaultError("invalid capsule reader cursor");
      }
      const where = ["c.thread_id = ?"];
      const params: unknown[] = [threadId];
      if (level !== undefined) {
        where.push("c.level = ?");
        params.push(level);
      }
      if (cursor !== undefined) {
        if (level === undefined) {
          where.push(
            "(c.level < ? OR (c.level = ? AND (c.from_seq > ? OR (c.from_seq = ? AND c.rowid > ?))))",
          );
          params.push(cursor.level, cursor.level, cursor.fromSeq, cursor.fromSeq, cursor.rowid);
        } else {
          where.push("(c.from_seq > ? OR (c.from_seq = ? AND c.rowid > ?))");
          params.push(cursor.fromSeq, cursor.fromSeq, cursor.rowid);
        }
      }
      params.push(limit + 1);
      const rows = this.stmt(
        `SELECT c.rowid AS reader_rowid, ${boundedCapsuleColumns("c")} FROM capsule c ` +
          `WHERE ${where.join(" AND ")} ORDER BY c.level DESC, c.from_seq ASC, c.rowid ASC LIMIT ?`,
      ).all(...(params as never[])) as CapsuleViewRow[];
      const hasMore = rows.length > limit;
      const kept = hasMore ? rows.slice(0, limit) : rows;
      const last = kept.at(-1);
      return {
        capsules: kept.map(toCapsuleView),
        hasMore,
        ...(hasMore && last !== undefined
          ? {
              nextCursor: encodeReaderCursor({
                level: last.level,
                fromSeq: last.from_seq,
                rowid: last.reader_rowid,
              }),
            }
          : {}),
      };
    },

    /** Capsules at a level that begin after `fromSeq`, ascending. */
    after: (threadId: string, level: number, fromSeq: Seq, limit = 16): StoredCapsule[] =>
      (
        this.stmt(
          "SELECT * FROM capsule WHERE thread_id = ? AND level = ? AND from_seq > ? ORDER BY from_seq ASC LIMIT ?",
        ).all(threadId, level, fromSeq, limit) as CapsuleRow[]
      ).map(toCapsule),

    children: (threadId: string, level: number, fromSeq: Seq, toSeq: Seq): StoredCapsule[] => {
      const rows = this.stmt(
        "SELECT * FROM capsule WHERE thread_id = ? AND level = ? AND from_seq >= ? AND to_seq <= ? " +
          "ORDER BY from_seq ASC LIMIT ?",
      ).all(threadId, level - 1, fromSeq, toSeq, CAPSULE_FANOUT + 1) as CapsuleRow[];
      if (rows.length > CAPSULE_FANOUT) {
        throw new VaultError(`capsule child set exceeds bounded fanout (${CAPSULE_FANOUT})`);
      }
      return rows.map(toCapsule);
    },

    /** Exact capsule-ledger continuation; stale rolling-root cursors fail closed. */
    ledgerPage: (
      capsuleId: string,
      part: "dropped" | "kept",
      opts: { after?: string; limit?: number } = {},
    ): { entries: LossEntry[]; hasMore: boolean; nextCursor?: string } => {
      const capsule = this.stmt("SELECT hash FROM capsule WHERE id = ?").get(capsuleId) as
        | { hash: string }
        | undefined;
      if (capsule === undefined) throw new VaultError(`unknown capsule ${capsuleId}`);
      const decoded = opts.after === undefined ? undefined : decodeCapsuleLedgerCursor(opts.after);
      if (
        opts.after !== undefined &&
        (decoded === undefined ||
          decoded.capsuleId !== capsuleId ||
          decoded.capsuleHash !== capsule.hash ||
          decoded.part !== part)
      ) {
        throw new VaultError("invalid or stale capsule ledger cursor");
      }
      const after = decoded?.after ?? -1;
      const limit = Math.max(
        1,
        Math.min(Math.floor(opts.limit ?? MAX_LEDGER_PAGE_ITEMS), MAX_LEDGER_PAGE_ITEMS),
      );
      const rows = this.stmt(
        "SELECT ordinal, name, kind, seq, span, capsule_id, NULL AS resolved_by " +
          "FROM capsule_ledger_entry WHERE capsule_id = ? AND part = ? AND ordinal > ? " +
          "ORDER BY ordinal ASC LIMIT ?",
      ).all(capsuleId, part, after, limit + 1) as Array<LossRow & { ordinal: number }>;
      const hasMore = rows.length > limit;
      const selected = hasMore ? rows.slice(0, limit) : rows;
      const last = selected.at(-1);
      return {
        entries: selected.map((row) => ({
          name: row.name,
          kind: row.kind as LossEntry["kind"],
          seq: row.seq,
          ...(row.span === null ? {} : { span: JSON.parse(row.span) as [number, number] }),
        })),
        hasMore,
        ...(hasMore && last !== undefined
          ? {
              nextCursor: encodeReaderCursor({
                version: 1,
                capsuleId,
                capsuleHash: capsule.hash,
                part,
                after: last.ordinal,
              }),
            }
          : {}),
      };
    },

    count: (threadId: string): number => this.counter(threadId, COUNTERS.capsules),
  };

  // ----------------------------------------------------------------- losses

  readonly losses = {
    /** Append ledger rows. Rows are written once, at the deepest drop (KERNEL A2). */
    add: (threadId: string, capsuleId: string, level: number, entries: readonly LossEntry[]): number => {
      if (entries.length === 0) return 0;
      const insert = this.stmt(
        "INSERT INTO loss (thread_id, capsule_id, name, kind, level, seq, span) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const entry of entries) {
        insert.run(
          threadId,
          capsuleId,
          entry.name,
          entry.kind,
          level,
          entry.seq,
          entry.span ? canonicalJson(entry.span) : null,
        );
      }
      this.bump(threadId, { [COUNTERS.losses]: entries.length });
      return entries.length;
    },

    /** `ledger(c)` — the seq-range query that makes conservation implicit (KERNEL A2). */
    inRange: (threadId: string, from: Seq, to: Seq, limit = 100000): LossEntry[] =>
      (
        this.stmt(
          "SELECT name, kind, seq, span, capsule_id, resolved_by FROM loss " +
            "WHERE thread_id = ? AND seq BETWEEN ? AND ? AND resolved_by IS NULL LIMIT ?",
        ).all(threadId, from, to, limit) as LossRow[]
      ).map(toLoss),

    /** SQL-first ledger page.  Names/spans are byte-prefix projected before mapping. */
    listBounded: (
      threadId: string,
      opts: {
        from?: Seq;
        to?: Seq;
        name?: string;
        capsuleId?: string;
        limit?: number;
        after?: string;
      } = {},
    ): { entries: LossEntryView[]; hasMore: boolean; nextCursor?: string } => {
      const limit = Math.max(
        1,
        Math.min(Math.floor(opts.limit ?? MAX_LEDGER_PAGE_ITEMS), MAX_LEDGER_PAGE_ITEMS),
      );
      const afterRowid = decodeReaderRowid(opts.after);
      if (opts.after !== undefined && afterRowid === undefined) {
        throw new VaultError("invalid ledger reader cursor");
      }
      const where = ["l.thread_id = ?", "l.resolved_by IS NULL"];
      const params: unknown[] = [threadId];
      if (opts.from !== undefined) {
        where.push("l.seq >= ?");
        params.push(opts.from);
      }
      if (opts.to !== undefined) {
        where.push("l.seq <= ?");
        params.push(opts.to);
      }
      if (opts.name !== undefined) {
        where.push("l.name = ?");
        params.push(opts.name);
      }
      if (opts.capsuleId !== undefined) {
        where.push("l.capsule_id = ?");
        params.push(opts.capsuleId);
      }
      if (afterRowid !== undefined) {
        where.push("l.rowid < ?");
        params.push(afterRowid);
      }
      params.push(limit + 1);
      const rows = this.stmt(
        `SELECT ${boundedLossColumns("l")} FROM loss l ` +
          `WHERE ${where.join(" AND ")} ORDER BY l.rowid DESC LIMIT ?`,
      ).all(...(params as never[])) as LossViewRow[];
      const hasMore = rows.length > limit;
      const kept = hasMore ? rows.slice(0, limit) : rows;
      const last = kept.at(-1);
      return {
        entries: kept.map(toLossView),
        hasMore,
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeReaderCursor({ rowid: last.reader_rowid }) }
          : {}),
      };
    },

    countInRange: (threadId: string, from: Seq, to: Seq): number =>
      (
        this.stmt(
          "SELECT COUNT(*) AS n FROM loss WHERE thread_id = ? AND seq BETWEEN ? AND ? AND resolved_by IS NULL",
        ).get(threadId, from, to) as { n: number }
      ).n,

    /** Distinct names in a range, newest locator first — the digest source. */
    namesInRange: (threadId: string, from: Seq, to: Seq, limit = 32): string[] =>
      (
        this.stmt(
          "SELECT name, MAX(seq) AS s FROM loss WHERE thread_id = ? AND seq BETWEEN ? AND ? AND resolved_by IS NULL " +
            "GROUP BY name ORDER BY s DESC LIMIT ?",
        ).all(threadId, from, to, limit) as Array<{ name: string; s: number }>
      ).map((r) => r.name),

    /** Locators for one routing key, most recent first (KERNEL §5.1). */
    byName: (threadId: string, name: string, limit = 4): LossEntry[] =>
      (
        this.stmt(
          "SELECT name, kind, seq, span, capsule_id, resolved_by FROM loss " +
            "WHERE thread_id = ? AND name = ? AND resolved_by IS NULL ORDER BY seq DESC LIMIT ?",
        ).all(threadId, name, limit) as LossRow[]
      ).map(toLoss),

    /** True if any unresolved row exists for the name. */
    has: (threadId: string, name: string): boolean =>
      this.stmt("SELECT 1 FROM loss WHERE thread_id = ? AND name = ? AND resolved_by IS NULL LIMIT 1").get(
        threadId,
        name,
      ) !== null,

    resolve: (threadId: string, from: Seq, to: Seq, tombstoneId: string): number => {
      const result = this.stmt(
        "UPDATE loss SET resolved_by = ? WHERE thread_id = ? AND seq BETWEEN ? AND ? AND resolved_by IS NULL",
      ).run(tombstoneId, threadId, from, to);
      const changed = Number(result.changes);
      this.bump(threadId, { [COUNTERS.losses]: -changed });
      return changed;
    },

    total: (threadId: string): number => this.counter(threadId, COUNTERS.losses),

    /** Frontier evictions are losses too, recorded once per key (KERNEL A4). */
    noteFrontierEviction: (threadId: string, name: string, seq: Seq): void => {
      const exists = this.stmt(
        "SELECT 1 FROM loss WHERE thread_id = ? AND name = ? AND capsule_id = 'frontier' LIMIT 1",
      ).get(threadId, name);
      if (exists !== null) return;
      this.losses.add(threadId, "frontier", -1, [{ name, kind: "atom", seq }]);
    },
  };

  // -------------------------------------------------------------- stopnames

  readonly stopNames = {
    /** A name in > 2% of the last 10,000 episodes: recorded, never auto-routed. */
    recompute: (threadId: string, headSeq: Seq): void => {
      const from = Math.max(1, headSeq - 10000);
      const threshold = Math.max(4, Math.floor(Math.min(10000, headSeq - from + 1) * 0.02));
      this.tx(() => {
        this.stmt("DELETE FROM stop_name WHERE thread_id = ?").run(threadId);
        this.stmt(
          "INSERT INTO stop_name (thread_id, name, hits) SELECT thread_id, name, COUNT(DISTINCT seq) AS n " +
            "FROM loss WHERE thread_id = ? AND seq >= ? GROUP BY name HAVING n > ?",
        ).run(threadId, from, threshold);
      });
    },
    all: (threadId: string): Set<string> =>
      new Set(
        (
          this.stmt("SELECT name FROM stop_name WHERE thread_id = ?").all(threadId) as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      ),
    has: (threadId: string, name: string): boolean =>
      this.stmt("SELECT 1 FROM stop_name WHERE thread_id = ? AND name = ?").get(threadId, name) !== null,
    /**
     * Check only an already-bounded candidate set. Never hydrate the complete
     * stop-name table into a compiler or turn request.
     */
    hasMany: (threadId: string, namesToCheck: readonly string[]): Set<string> => {
      const unique = [...new Set(namesToCheck)].filter((name) => name.length > 0);
      const found = new Set<string>();
      const chunkSize = 256;
      for (let offset = 0; offset < unique.length; offset += chunkSize) {
        const chunk = unique.slice(offset, offset + chunkSize);
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => "?").join(",");
        const rows = this.stmt(
          `SELECT name FROM stop_name WHERE thread_id = ? AND name IN (${placeholders})`,
        ).all(threadId, ...chunk) as Array<{ name: string }>;
        for (const row of rows) found.add(row.name);
      }
      return found;
    },
  };

  // ---------------------------------------------------------------- packets

  readonly packets = {
    /** Write a packet row. `status='pending'` until the reply lands (KERNEL A6). */
    insert: (packet: Packet, status: PacketStatus = "done"): void => {
      checkedModel(packet.model);
      checkedBudget(packet.budget);
      const tokenFailure = packetTokensFailure(packet.tokens, packet.budget);
      if (tokenFailure !== null) throw new VaultError(`packet ${tokenFailure}`);
      const json = packetJsonFields(packet);
      this.stmt(
        "INSERT OR REPLACE INTO packet (id, thread_id, turn_seq, model, budget, tokens, digest, status, " +
          "compiler_version, messages, resident, ledger, pages, rounds, reachability, coverage, evidence, " +
          "reachability_as_of_seq, answer_receipt, semantic, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        packet.id,
        packet.threadId,
        packet.turnSeq,
        packet.model,
        packet.budget,
        packet.tokens,
        packet.digest,
        status,
        COMPILER_VERSION,
        json.messages,
        json.resident,
        json.ledger,
        json.pages,
        json.rounds,
        json.reachability,
        json.coverage,
        json.evidence,
        packet.reachabilityAsOfSeq === undefined ? null : packet.reachabilityAsOfSeq,
        json.answerReceipt,
        json.semantic,
        packet.createdAt,
      );
    },

    /** Close the packet with what was served and what was sent (KERNEL A10.3). */
    finish: (
      packetId: string,
      pages: unknown[],
      rounds: unknown[] = [],
      receipts?: Pick<Packet, "reachability" | "coverage" | "evidence" | "answerReceipt" | "semantic">,
    ): void => {
      const pagesJson = serializePacketJson(pages, MAX_PACKET_JSON_BYTES, "pages");
      const roundsJson = serializePacketJson(rounds, MAX_PACKET_JSON_BYTES, "rounds");
      const existing = this.stmt(
        "SELECT budget, tokens, COALESCE(length(CAST(messages AS BLOB)), 0) AS messages_bytes, " +
          "COALESCE(length(CAST(resident AS BLOB)), 0) AS resident_bytes, " +
          "COALESCE(length(CAST(ledger AS BLOB)), 0) AS ledger_bytes, " +
          "COALESCE(length(CAST(reachability AS BLOB)), 0) AS reachability_bytes, " +
          "COALESCE(length(CAST(coverage AS BLOB)), 0) AS coverage_bytes, " +
          "COALESCE(length(CAST(evidence AS BLOB)), 0) AS evidence_bytes, " +
          "COALESCE(length(CAST(answer_receipt AS BLOB)), 0) AS answer_receipt_bytes, " +
          "COALESCE(length(CAST(semantic AS BLOB)), 0) AS semantic_bytes " +
          "FROM packet WHERE id = ? LIMIT 1",
      ).get(packetId) as PacketPreflightRow | null | undefined;
      if (existing == null) throw new VaultError(`unknown packet ${packetId}`);
      const tokenFailure = packetTokensFailure(existing.tokens, existing.budget);
      if (tokenFailure !== null) throw new VaultError(`packet ${tokenFailure}`);
      const roundsFailure = packetRoundsFailure(rounds, existing.budget);
      if (roundsFailure !== null) throw new VaultError(roundsFailure);
      if (receipts === undefined) {
        assertPacketAggregateBytes([
          existing.messages_bytes,
          existing.resident_bytes,
          existing.ledger_bytes,
          pagesJson,
          roundsJson,
          existing.reachability_bytes,
          existing.coverage_bytes,
          existing.evidence_bytes,
          existing.answer_receipt_bytes,
          existing.semantic_bytes,
        ]);
        this.stmt("UPDATE packet SET status = 'done', pages = ?, rounds = ? WHERE id = ?").run(
          pagesJson,
          roundsJson,
          packetId,
        );
        return;
      }
      const receiptJson = {
        reachability:
          receipts.reachability === undefined
            ? null
            : serializePacketJson(receipts.reachability, MAX_PACKET_JSON_BYTES, "reachability"),
        coverage:
          receipts.coverage === undefined
            ? null
            : serializePacketJson(receipts.coverage, MAX_PACKET_JSON_BYTES, "coverage"),
        evidence:
          receipts.evidence === undefined
            ? null
            : serializePacketJson(receipts.evidence, MAX_PACKET_JSON_BYTES, "evidence"),
        answerReceipt:
          receipts.answerReceipt === undefined
            ? null
            : serializePacketJson(receipts.answerReceipt, MAX_PACKET_JSON_BYTES, "answer_receipt"),
        semantic:
          receipts.semantic === undefined
            ? null
            : serializePacketJson(receipts.semantic, MAX_PACKET_JSON_BYTES, "semantic"),
      };
      assertPacketAggregateBytes([
        existing.messages_bytes,
        existing.resident_bytes,
        existing.ledger_bytes,
        pagesJson,
        roundsJson,
        receiptJson.reachability,
        receiptJson.coverage,
        receiptJson.evidence,
        receiptJson.answerReceipt,
        receiptJson.semantic,
      ]);
      this.stmt(
        "UPDATE packet SET status = 'done', pages = ?, rounds = ?, reachability = ?, coverage = ?, " +
          "evidence = ?, answer_receipt = ?, semantic = ? WHERE id = ?",
      ).run(
        pagesJson,
        roundsJson,
        receiptJson.reachability,
        receiptJson.coverage,
        receiptJson.evidence,
        receiptJson.answerReceipt,
        receiptJson.semantic,
        packetId,
      );
    },

    /** Drop `messages` from all but the most recent 1,000 packets (KERNEL A7). */
    prune: (threadId: string, retain = PACKET_MESSAGE_RETENTION): void => {
      this.stmt(
        "UPDATE packet SET messages = NULL WHERE thread_id = ? AND messages IS NOT NULL AND turn_seq < " +
          "(SELECT MIN(turn_seq) FROM (SELECT turn_seq FROM packet WHERE thread_id = ? ORDER BY turn_seq DESC LIMIT ?))",
      ).run(threadId, threadId, retain);
    },

    /**
     * Scalar-only packet gate.  Every JSON column is measured and validated in
     * SQLite before the raw packet mapper can allocate a string or call
     * JSON.parse.  Raw packet readers receive either the unchanged packet or
     * a typed rejection from the adapter.
     */
    preflight: (threadId: string, turnSeq: Seq): PacketPreflightStatus => {
      const row = this.stmt(
        `SELECT ${packetPreflightSelect()} FROM packet WHERE thread_id = ? AND turn_seq = ? ` +
          "ORDER BY created_at DESC LIMIT 1",
      ).get(threadId, turnSeq) as PacketPreflightRow | undefined;
      return packetPreflight(row);
    },

    preflightById: (id: string): { status: PacketPreflightStatus; threadId?: string } => {
      const row = this.stmt(`SELECT ${packetPreflightSelect()} FROM packet WHERE id = ? LIMIT 1`).get(id) as
        | PacketPreflightRow
        | undefined;
      return {
        status: packetPreflight(row),
        ...(typeof row?.thread_id === "string" ? { threadId: row.thread_id } : {}),
      };
    },

    get: (threadId: string, turnSeq: Seq): Packet | null => {
      const row = this.stmt(
        "SELECT * FROM packet WHERE thread_id = ? AND turn_seq = ? ORDER BY created_at DESC LIMIT 1",
      ).get(threadId, turnSeq) as PacketRow | undefined;
      return row == null ? null : toPacket(row);
    },

    byId: (id: string): Packet | null => {
      const row = this.stmt("SELECT * FROM packet WHERE id = ?").get(id) as PacketRow | undefined;
      return row == null ? null : toPacket(row);
    },

    /**
     * Proof-view packet projection. Messages/resident/evidence are never
     * selected; the receipt JSON is admitted only when each selected field is
     * within the fixed projection bound.
     */
    demo: (threadId: string, turnSeq: Seq): Packet | null => {
      const row = this.stmt(
        "SELECT id, thread_id, turn_seq, model, budget, tokens, digest, status, " +
          "CASE WHEN length(CAST(pages AS BLOB)) <= ? THEN pages ELSE NULL END AS pages_json, " +
          "length(CAST(pages AS BLOB)) AS pages_bytes, " +
          "CASE WHEN length(CAST(coverage AS BLOB)) <= ? THEN coverage ELSE NULL END AS coverage_json, " +
          "length(CAST(coverage AS BLOB)) AS coverage_bytes, " +
          "CASE WHEN length(CAST(answer_receipt AS BLOB)) <= ? THEN answer_receipt ELSE NULL END AS answer_receipt_json, " +
          "length(CAST(answer_receipt AS BLOB)) AS answer_receipt_bytes, " +
          "created_at FROM packet WHERE thread_id = ? AND turn_seq = ? ORDER BY created_at DESC LIMIT 1",
      ).get(DEMO_PACKET_JSON_LIMIT, DEMO_PACKET_JSON_LIMIT, DEMO_PACKET_JSON_LIMIT, threadId, turnSeq) as
        | DemoPacketProjectionRow
        | undefined;
      return row === undefined ? null : toBoundedDemoPacket(row);
    },

    demoById: (id: string): Packet | null => {
      const row = this.stmt(
        "SELECT id, thread_id, turn_seq, model, budget, tokens, digest, status, " +
          "CASE WHEN length(CAST(pages AS BLOB)) <= ? THEN pages ELSE NULL END AS pages_json, " +
          "length(CAST(pages AS BLOB)) AS pages_bytes, " +
          "CASE WHEN length(CAST(coverage AS BLOB)) <= ? THEN coverage ELSE NULL END AS coverage_json, " +
          "length(CAST(coverage AS BLOB)) AS coverage_bytes, " +
          "CASE WHEN length(CAST(answer_receipt AS BLOB)) <= ? THEN answer_receipt ELSE NULL END AS answer_receipt_json, " +
          "length(CAST(answer_receipt AS BLOB)) AS answer_receipt_bytes, " +
          "created_at FROM packet WHERE id = ? LIMIT 1",
      ).get(DEMO_PACKET_JSON_LIMIT, DEMO_PACKET_JSON_LIMIT, DEMO_PACKET_JSON_LIMIT, id) as
        | DemoPacketProjectionRow
        | undefined;
      return row === undefined ? null : toBoundedDemoPacket(row);
    },

    last: (threadId: string): Packet | null => {
      const row = this.stmt(
        "SELECT * FROM packet WHERE thread_id = ? ORDER BY turn_seq DESC, created_at DESC LIMIT 1",
      ).get(threadId) as PacketRow | undefined;
      return row == null ? null : toPacket(row);
    },

    /**
     * O(1) scalar projection for thread stats.  Deliberately do not call
     * `toPacket`: packet JSON can contain multi-megabyte A13/A14 receipts.
     * Invalid page JSON or scalar fields fail closed by returning null.
     */
    lastSummary: (threadId: string): PacketSummary | null => {
      const row = this.stmt(
        "SELECT tokens, budget, digest, " +
          "CASE WHEN json_valid(pages) AND json_type(pages) = 'array' " +
          "THEN json_array_length(pages) ELSE NULL END AS page_count " +
          "FROM packet WHERE thread_id = ? ORDER BY turn_seq DESC, created_at DESC LIMIT 1",
      ).get(threadId) as PacketSummaryRow | undefined;
      return toPacketSummary(row);
    },
  };

  // ------------------------------------------------------------- tombstones

  readonly tombstones = {
    create: (threadId: string, target: string, reason: string): string => {
      const id = newId("tb");
      this.stmt(
        "INSERT INTO tombstone (id, thread_id, target, reason, created_at, removal_seq, echoes) " +
          "VALUES (?, ?, ?, ?, ?, NULL, '[]')",
      ).run(id, threadId, target, reason, Date.now());
      return id;
    },
    /** Bind a tombstone to its chain event and the echoes it found (KERNEL A10.6). */
    record: (id: string, removalSeq: Seq, echoes: readonly Seq[]): void => {
      this.stmt("UPDATE tombstone SET removal_seq = ?, echoes = ? WHERE id = ?").run(
        removalSeq,
        canonicalJson([...echoes]),
        id,
      );
    },
    get: (id: string): Tombstone | null => {
      const row = this.stmt("SELECT * FROM tombstone WHERE id = ?").get(id) as TombstoneRow | undefined;
      return row == null ? null : toTombstone(row);
    },
    list: (threadId: string): Tombstone[] =>
      (
        this.stmt("SELECT * FROM tombstone WHERE thread_id = ? ORDER BY created_at ASC").all(
          threadId,
        ) as TombstoneRow[]
      ).map(toTombstone),
  };

  // --------------------------------------------------------------- internal

  /** Remove an episode's text from the FTS index (used by `forget`). */
  ftsDelete(threadId: string, seq: Seq): void {
    const row = this.stmt("SELECT rowid, content FROM episode WHERE thread_id = ? AND seq = ?").get(
      threadId,
      seq,
    ) as { rowid: number; content: string } | undefined;
    if (row == null) return;
    this.stmt("INSERT INTO episode_fts (episode_fts, rowid, content) VALUES ('delete', ?, ?)").run(
      row.rowid,
      row.content,
    );
  }

  /** Maintain the derived attachment-name address after an episode write. */
  indexAttachmentName(threadId: string, seq: Seq, meta: unknown): void {
    if (
      meta !== null &&
      typeof meta === "object" &&
      !Array.isArray(meta) &&
      (meta as Record<string, unknown>).removed === true
    )
      return;
    const name = attachmentNameFromMeta(meta);
    const normalized = normalizeAttachmentName(name);
    if (name === null || normalized === null) return;
    this.stmt(
      "INSERT INTO attachment_name (thread_id, seq, normalized_name, name) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(thread_id, seq) DO UPDATE SET normalized_name = excluded.normalized_name, name = excluded.name",
    ).run(threadId, seq, normalized, name);
  }

  /** Startup rebuilds are intentionally incremental; callers must abstain until complete. */
  attachmentNamesReady(threadId: string): boolean {
    const migration = this.db
      .query("SELECT 1 FROM migration WHERE name = ? LIMIT 1")
      .get(ATTACHMENT_NAME_REBUILD);
    if (migration === null) return false;
    const row = this.db
      .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(threadId, ATTACHMENT_NAME_REBUILD) as { status: string } | null;
    return row === null || row.status === "complete";
  }

  /** Replace an episode's stored content, keeping `content_hash` (KERNEL A5). */
  redactContent(threadId: string, seq: Seq, replacement: string, meta: EpisodeMeta): void {
    this.ftsDelete(threadId, seq);
    this.stmt("DELETE FROM attachment_name WHERE thread_id = ? AND seq = ?").run(threadId, seq);
    this.stmt("UPDATE episode SET content = ?, meta = ? WHERE thread_id = ? AND seq = ?").run(
      replacement,
      canonicalJson(meta),
      threadId,
      seq,
    );
  }

  /** Incremental counters; a COUNT(*) over a million-row table is not O(1). */
  bump(threadId: string, deltas: Record<string, number>): void {
    const statement = this.stmt(
      "INSERT INTO counter (thread_id, key, value) VALUES (?, ?, ?) " +
        "ON CONFLICT(thread_id, key) DO UPDATE SET value = value + excluded.value",
    );
    for (const [key, delta] of Object.entries(deltas)) {
      if (delta === 0) continue;
      statement.run(threadId, key, delta);
    }
  }

  counter(threadId: string, key: string): number {
    const row = this.stmt("SELECT value FROM counter WHERE thread_id = ? AND key = ?").get(threadId, key) as
      | { value: number }
      | undefined;
    return row?.value ?? 0;
  }

  /**
   * Bytes on disk: database file + WAL + content-addressed objects. Whole-vault,
   * not per-thread — v1 keeps one thread per profile, and a per-thread figure
   * would have to be an estimate, which is not what the seal should report.
   */
  archiveBytes(): number {
    const MAX = Number.MAX_SAFE_INTEGER;
    let total = 0;
    const add = (value: number): void => {
      if (!Number.isFinite(value) || value < 0) {
        total = MAX;
        return;
      }
      total = Math.min(MAX, total + Math.trunc(value));
    };
    for (const path of [this.file, `${this.file}-wal`]) {
      try {
        add(statSync(path).size);
      } catch {
        // missing WAL is fine
      }
    }
    try {
      const row = this.stmt(
        "SELECT COALESCE(SUM(CASE WHEN size > 0 THEN size ELSE 0 END), 0) AS bytes FROM blob",
      ).get() as { bytes: number | bigint | string | null } | undefined;
      const raw = row?.bytes;
      add(raw === null || raw === undefined ? 0 : Number(raw));
    } catch {
      // SQLite integer SUM can report overflow for a corrupt or truly massive
      // vault. The public protocol is a JS number, so saturate rather than
      // materializing rows or returning a wrapped/negative byte count.
      total = MAX;
    }
    return total;
  }

  /** Latest trusted chain checkpoint at or before `seq`. */
  checkpointBefore(threadId: string, seq: Seq): { seq: Seq; hash: string } | null {
    const row = this.stmt(
      "SELECT seq, hash FROM chain_checkpoint WHERE thread_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 1",
    ).get(threadId, seq) as { seq: number; hash: string } | undefined;
    return row == null ? null : row;
  }

  putCheckpoint(threadId: string, seq: Seq, hash: string): void {
    this.stmt("INSERT OR REPLACE INTO chain_checkpoint (thread_id, seq, hash) VALUES (?, ?, ?)").run(
      threadId,
      seq,
      hash,
    );
  }

  /**
   * How far a successful `verify()` has certified this chain, or 0.
   *
   * The record is only as good as the row it anchors on, so this applies the
   * rule an incremental `verify()` applies to a checkpoint it resumes from: the
   * episode at that seq must still carry the hash that was certified, and the
   * seq must still be within the head. A rewritten or truncated tail therefore
   * reads as unverified rather than as an old claim.
   */
  verifiedFrontier(threadId: string): Seq {
    const row = this.stmt(
      "SELECT v.seq AS seq FROM chain_verified v " +
        "JOIN thread t ON t.id = v.thread_id AND v.seq <= t.head_seq " +
        "JOIN episode e ON e.thread_id = v.thread_id AND e.seq = v.seq AND e.hash = v.hash " +
        "WHERE v.thread_id = ?",
    ).get(threadId) as { seq: number } | undefined;
    return row == null ? 0 : row.seq;
  }

  putVerifiedFrontier(threadId: string, seq: Seq, hash: string): void {
    const row = this.stmt("SELECT seq, hash FROM chain_verified WHERE thread_id = ?").get(threadId) as
      | { seq: number; hash: string }
      | undefined;
    // Verifying an unchanged chain again must not dirty the vault: the archive
    // size the UI reports would move for a read.
    if (row?.seq === seq && row.hash === hash) return;
    this.stmt("INSERT OR REPLACE INTO chain_verified (thread_id, seq, hash) VALUES (?, ?, ?)").run(
      threadId,
      seq,
      hash,
    );
  }

  clearVerifiedFrontier(threadId: string): void {
    this.stmt("DELETE FROM chain_verified WHERE thread_id = ?").run(threadId);
  }
}

/** Which O(1) counter a phase belongs to. `REVOKED` atoms are counted nowhere. */
export function phaseCounter(phase: AtomPhase): string {
  if (phase === "SUPPORTED") return COUNTERS.atomsSupported;
  if (phase === "PROPOSED") return COUNTERS.atomsProposed;
  return COUNTERS.atomsHistorical;
}

/** The compiler version stamped into packets so an X-ray can be re-rendered. */
export const COMPILER_VERSION = "2";

/** Open (or create) a vault. */
export function openVault(options: VaultOptions = {}): Vault {
  return new Vault(options);
}

/**
 * True if this exact locator is already in the ledger. Dedupe is by
 * `(name, seq)`, not by name: a later mention of the same name is a *different*
 * locator, and routing must be able to reach the newest one — otherwise a query
 * about a revised fact pages back the version before the revision.
 */
export function lossExists(vault: Vault, threadId: string, name: string, seq: Seq): boolean {
  return (
    vault.db
      .query("SELECT 1 FROM loss WHERE thread_id = ? AND name = ? AND seq = ? LIMIT 1")
      .get(threadId, name, seq) !== null
  );
}
