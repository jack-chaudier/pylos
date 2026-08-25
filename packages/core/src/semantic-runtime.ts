/**
 * Optional local semantic address router (KERNEL A15.2).
 *
 * This module is deliberately a small adapter around sqlite-vec and
 * sqlite-lembed.  It is not a source of evidence: the index stores only a
 * revision/hash-bound address, and callers must still pass every returned
 * `SemanticHit` through `verifySemanticHit` before paging an episode.
 *
 * The packages and model are pinned below.  A runtime that cannot load both
 * extensions, verify the model digest, or establish the exact vec0 schema is
 * returned as unavailable/incompatible; it never silently falls back to FTS
 * or pretends that lexical hits are semantic hits.
 */

import { existsSync, readFileSync } from "node:fs";
import type { SemanticReceipt, Seq, Sha256 } from "@pylos/protocol";
import * as sqliteLembed from "sqlite-lembed";
import * as sqliteVec from "sqlite-vec";
import { sha256 } from "./hash.ts";
import {
  buildSemanticReceipt,
  probeSemanticCapability,
  type SemanticCapability,
  type SemanticHit,
} from "./semantic.ts";

/** Resources accepted by the production local route. */
export const SEMANTIC_RESOURCES = {
  sqliteVec: {
    package: "sqlite-vec",
    version: "0.1.8",
    integrity:
      "sha512-L3xKhQUYQ7kcb3v31KPyPaEigE2upETMSx/5K3vTwm8HRsbci9PKGklXU+mxEYVogojpkenM0TZK5Sz/2FXTQw==",
  },
  sqliteLembed: {
    package: "sqlite-lembed",
    version: "0.0.1-alpha.8",
    integrity:
      "sha512-TPj4Nwh2xVTJgb29FLFb/onMQ7nIi1P5aNceGi9EHKX7VM33CKtcelnMLmsiBbAkuFFaZMDv8oxHxDhO1IqDvg==",
  },
  model: {
    name: "all-MiniLM-L6-v2",
    sha256: "71f1d177171468fb5f186c07019e303015aea17af275a67767760bba7be8d2e6",
    dimensions: 384,
  },
  distanceMetric: "cosine",
} as const;

export const SEMANTIC_RUNTIME_SCHEMA_VERSION = "pylos-semantic-v1";
export const DEFAULT_SEMANTIC_TABLE_PREFIX = "pylos_semantic";
export const DEFAULT_SEMANTIC_MAX_BATCH = 64;
export const DEFAULT_SEMANTIC_MAX_SPAN_BYTES = 64 * 1024;
export const DEFAULT_SEMANTIC_MAX_CANDIDATES = 256;
const SEMANTIC_DELETE_BATCH = 256;
const SEMANTIC_STARTUP_DELETE_BUDGET = 256;

export interface SemanticRuntimeIdentity {
  schemaVersion: typeof SEMANTIC_RUNTIME_SCHEMA_VERSION;
  sqliteVec: { package: string; version: string };
  sqliteLembed: { package: string; version: string };
  model: { name: string; digest: Sha256; dimensions: number };
  distanceMetric: typeof SEMANTIC_RESOURCES.distanceMetric;
}

export const SEMANTIC_RUNTIME_IDENTITY: SemanticRuntimeIdentity = {
  schemaVersion: SEMANTIC_RUNTIME_SCHEMA_VERSION,
  sqliteVec: {
    package: SEMANTIC_RESOURCES.sqliteVec.package,
    version: SEMANTIC_RESOURCES.sqliteVec.version,
  },
  sqliteLembed: {
    package: SEMANTIC_RESOURCES.sqliteLembed.package,
    version: SEMANTIC_RESOURCES.sqliteLembed.version,
  },
  model: {
    name: SEMANTIC_RESOURCES.model.name,
    digest: SEMANTIC_RESOURCES.model.sha256,
    dimensions: SEMANTIC_RESOURCES.model.dimensions,
  },
  distanceMetric: SEMANTIC_RESOURCES.distanceMetric,
};

/** The part of Bun's SQLite API used by this adapter. */
export interface SemanticSqlStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
}

/** A caller-owned extension-capable SQLite connection. */
export interface SemanticSqlDatabase {
  loadExtension(path: string, entrypoint?: string): void;
  exec(sql: string): void;
  query(sql: string): SemanticSqlStatement;
}

export interface SemanticRuntimeOptions {
  /** Absolute path to the exact pinned GGUF artifact. */
  modelPath: string;
  /** Logical model name used by sqlite-lembed's temp model table. */
  modelName?: string;
  /** Number of source spans known to be eligible, if the caller measured it. */
  eligible?: number;
  /** Bound for one indexing call; excess input is reported as truncated. */
  maxBatch?: number;
  /** Bound for one exact indexed span. */
  maxSpanBytes?: number;
  /** Bound on vec candidates fetched before deterministic JS ordering. */
  maxCandidates?: number;
  /** Safe SQL identifier prefix for the ordinary and vec0 side tables. */
  tablePrefix?: string;
  /** Optional packaged extension paths; when supplied, both paths are required. */
  sqliteVecPath?: string;
  sqliteLembedPath?: string;
}

export interface SemanticIndexSpan {
  threadId: string;
  seq: Seq;
  content: string;
  byteRange?: [number, number];
  /** Both spellings are accepted at the seam; the stored value is canonical. */
  contentHash?: Sha256;
  sourceHash?: Sha256;
  spanHash?: Sha256;
  hash?: Sha256;
  /** A current source revision is mandatory for every indexed proposal. */
  revision: string;
}

export type SemanticIndexRejectionReason =
  | "malformed-span"
  | "missing-thread"
  | "invalid-sequence"
  | "invalid-revision"
  | "invalid-range"
  | "span-too-large"
  | "invalid-utf8"
  | "source-hash-mismatch"
  | "span-hash-mismatch"
  | "database-error";

export interface SemanticIndexRejection {
  span: unknown;
  reason: SemanticIndexRejectionReason;
}

export interface SemanticIndexBatchResult {
  requested: number;
  processed: number;
  indexed: number;
  replaced: number;
  rejected: SemanticIndexRejection[];
  /** Number of input proposals intentionally left for a later bounded call. */
  truncated: number;
  receipt: SemanticReceipt;
}

export interface SemanticSearchOptions {
  limit?: number;
  maxDistance?: number;
}

export interface SemanticRemoveResult {
  removed: number;
  /** `empty` is an honest no-row result; `unavailable` never claims cleanup. */
  status: "removed" | "empty" | "unavailable";
  reason?: string;
  receipt: SemanticReceipt;
}

export interface SemanticDurableRemoval {
  /** Ordinary metadata rows removed without requiring sqlite-vec. */
  metadataRemoved: number;
  /** A retry tombstone is left until native vector cleanup succeeds. */
  pending: boolean;
}

export interface SemanticRuntimeProbe {
  capability: SemanticCapability;
  receipt: SemanticReceipt;
  identity: SemanticRuntimeIdentity;
  reason?: string;
}

export interface SemanticRuntime {
  readonly probe: SemanticRuntimeProbe;
  readonly receipt: SemanticReceipt;
  readonly identity: SemanticRuntimeIdentity;
  /** True only after both extensions, the model, and the vec schema load. */
  readonly operational: boolean;
  /** Build a coverage receipt for one thread instead of the whole index. */
  receiptFor(threadId: string, eligible?: number): SemanticReceipt;
  receiptForThread(threadId: string, eligible?: number): SemanticReceipt;
  indexBatch(spans: readonly SemanticIndexSpan[]): SemanticIndexBatchResult;
  search(threadId: string, query: string, options?: SemanticSearchOptions): SemanticHit[];
  remove(threadId: string, seq: Seq, byteRange?: [number, number]): SemanticRemoveResult;
  clearThread(threadId: string): SemanticRemoveResult;
}

export interface SemanticRuntimeOpenResult {
  runtime: SemanticRuntime;
  probe: SemanticRuntimeProbe;
}

interface NormalizedSpan {
  threadId: string;
  seq: Seq;
  from: number;
  to: number;
  text: string;
  sourceHash: Sha256;
  spanHash: Sha256;
  revision: string;
}

interface StoredSpan {
  id: number;
  threadId: string;
  seq: Seq;
  from: number;
  to: number;
  sourceHash: Sha256;
  spanHash: Sha256;
  revision: string;
}

interface SourceIdsPage {
  ids: number[];
  metadataAfter: number;
  vectorAfter: number;
  metadataHasMore: boolean;
  vectorHasMore: boolean;
}

interface SourceDeleteResult {
  removed: number;
  complete: boolean;
}

interface RuntimeTables {
  metadata: string;
  vector: string;
}

interface RuntimeFailure {
  status: SemanticCapability["status"];
  reason: string;
}

const HEX_256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
const UTF8 = new TextEncoder();
const loadedDatabases = new WeakSet<object>();
const loadedModels = new WeakMap<object, Set<string>>();

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && HEX_256.test(value);
}

function safeCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`unsafe semantic table identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

function durableDeletionTable(tablePrefix: string): string {
  return quoteIdentifier(`${tablePrefix}_deletions`);
}

function metadataTable(tablePrefix: string): string {
  return quoteIdentifier(`${tablePrefix}_spans`);
}

/**
 * Create the ordinary-SQL deletion journal before probing native extensions.
 * This table is intentionally not a vec0 table: a vault reopened without its
 * optional resources can still erase metadata and leave a retryable tombstone.
 */
export function ensureSemanticDurableTables(
  db: Pick<SemanticSqlDatabase, "exec">,
  tablePrefix = DEFAULT_SEMANTIC_TABLE_PREFIX,
): void {
  const table = durableDeletionTable(tablePrefix);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, seq)
    );
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tablePrefix}_deletions_created`)}
      ON ${table}(created_at, thread_id, seq);`,
  );
}

function missingTable(error: unknown): boolean {
  return /no such table|does not exist/i.test(reasonFor(error));
}

/**
 * Remove the ordinary span metadata and journal the source deletion without
 * loading sqlite-vec.  Native vector rows may remain temporarily; metadata
 * absence makes them unservable, and the journal lets a later capable open
 * remove the orphaned vectors before search resumes.
 */
export function removeSemanticMetadata(
  db: SemanticSqlDatabase,
  threadId: string,
  seq: Seq,
  tablePrefix = DEFAULT_SEMANTIC_TABLE_PREFIX,
): SemanticDurableRemoval {
  ensureSemanticDurableTables(db, tablePrefix);
  let metadataRemoved = 0;
  try {
    const metadata = metadataTable(tablePrefix);
    const rows = db.query(`SELECT id FROM ${metadata} WHERE thread_id = ? AND seq = ?`).all(threadId, seq);
    metadataRemoved = rows.length;
    if (metadataRemoved > 0) {
      db.query(`DELETE FROM ${metadata} WHERE thread_id = ? AND seq = ?`).run(threadId, seq);
    }
  } catch (error) {
    // A vault that never loaded semantic resources has no metadata table yet;
    // this is an honest empty route. Any other failure must abort forgetting.
    if (!missingTable(error)) throw error;
  }
  db.query(
    `INSERT INTO ${durableDeletionTable(tablePrefix)} (thread_id, seq, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(thread_id, seq) DO UPDATE SET created_at = excluded.created_at`,
  ).run(threadId, seq, Date.now());
  return { metadataRemoved, pending: true };
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusFromFailure(failure: RuntimeFailure): SemanticCapability {
  return {
    status: failure.status,
    indexed: 0,
    eligible: 0,
    reason: failure.reason,
  };
}

function normalizedRange(value: unknown, byteLength: number): [number, number] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isSafeInteger(value[0]) ||
    !Number.isSafeInteger(value[1]) ||
    value[0] < 0 ||
    value[1] <= value[0] ||
    value[1] > byteLength
  ) {
    return null;
  }
  return [value[0], value[1]];
}

function hashMatches(value: unknown, expected: Sha256): boolean {
  return value === undefined || (isSha256(value) && value === expected);
}

function normalizeSpan(
  span: unknown,
  maxSpanBytes: number,
): { value?: NormalizedSpan; rejection?: SemanticIndexRejection } {
  if (typeof span !== "object" || span === null) {
    return { rejection: { span, reason: "malformed-span" } };
  }
  const candidate = span as Partial<SemanticIndexSpan>;
  if (typeof candidate.threadId !== "string" || candidate.threadId.length === 0) {
    return { rejection: { span, reason: "missing-thread" } };
  }
  const seq = candidate.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    return { rejection: { span, reason: "invalid-sequence" } };
  }
  const revision = candidate.revision;
  if (typeof revision !== "string" || revision.length === 0) {
    return { rejection: { span, reason: "invalid-revision" } };
  }
  if (typeof candidate.content !== "string") {
    return { rejection: { span, reason: "malformed-span" } };
  }

  const bytes = UTF8.encode(candidate.content);
  const range =
    normalizedRange(candidate.byteRange, bytes.byteLength) ??
    (candidate.byteRange === undefined && bytes.byteLength > 0 ? [0, bytes.byteLength] : null);
  if (range === null) return { rejection: { span, reason: "invalid-range" } };
  const [from, to] = range;
  if (to - from > maxSpanBytes) {
    return { rejection: { span, reason: "span-too-large" } };
  }
  let text: string;
  try {
    text = UTF8_FATAL.decode(bytes.subarray(from, to));
  } catch {
    return { rejection: { span, reason: "invalid-utf8" } };
  }
  const sourceHash = sha256(bytes);
  const spanHash = sha256(bytes.slice(from, to));
  const suppliedSourceHash = candidate.contentHash ?? candidate.sourceHash;
  const suppliedSpanHash = candidate.spanHash ?? candidate.hash;
  if (!hashMatches(suppliedSourceHash, sourceHash)) {
    return { rejection: { span, reason: "source-hash-mismatch" } };
  }
  if (!hashMatches(suppliedSpanHash, spanHash)) {
    return { rejection: { span, reason: "span-hash-mismatch" } };
  }
  return {
    value: {
      threadId: candidate.threadId,
      seq,
      from,
      to,
      text,
      sourceHash,
      spanHash,
      revision,
    },
  };
}

function failureReceipt(failure: RuntimeFailure): SemanticRuntimeProbe {
  const capability = statusFromFailure(failure);
  return {
    capability,
    receipt: buildSemanticReceipt(capability),
    identity: SEMANTIC_RUNTIME_IDENTITY,
    reason: failure.reason,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function toStoredSpan(value: unknown): StoredSpan | null {
  const row = asRecord(value);
  if (row === null) return null;
  const id = Number(row.id ?? row.rowid);
  const seq = Number(row.seq);
  const from = Number(row.byte_from);
  const to = Number(row.byte_to);
  const threadId = row.thread_id;
  const sourceHash = row.source_hash;
  const spanHash = row.span_hash;
  const revision = row.revision;
  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    !Number.isSafeInteger(from) ||
    from < 0 ||
    !Number.isSafeInteger(to) ||
    to <= from ||
    typeof threadId !== "string" ||
    typeof revision !== "string" ||
    revision.length === 0 ||
    !isSha256(sourceHash) ||
    !isSha256(spanHash)
  ) {
    return null;
  }
  return { id, threadId, seq, from, to, sourceHash, spanHash, revision };
}

class SqliteSemanticRuntime implements SemanticRuntime {
  readonly probe: SemanticRuntimeProbe;
  readonly operational: boolean;
  readonly identity = SEMANTIC_RUNTIME_IDENTITY;

  private readonly db: SemanticSqlDatabase;
  private readonly options: Required<
    Pick<SemanticRuntimeOptions, "modelName" | "maxBatch" | "maxSpanBytes" | "maxCandidates" | "tablePrefix">
  > & {
    eligible?: number;
    modelPath: string;
    sqliteVecPath?: string;
    sqliteLembedPath?: string;
  };
  private readonly tables: RuntimeTables;
  private readonly modelName: string;
  private savepointCounter = 0;
  private pendingDeletes = 0;

  constructor(db: SemanticSqlDatabase, options: SemanticRuntimeOptions) {
    this.db = db;
    this.options = {
      modelPath: options.modelPath,
      modelName: options.modelName ?? "pylos_minilm_l6_v2",
      eligible: safeCount(options.eligible),
      maxBatch: safeLimit(options.maxBatch, DEFAULT_SEMANTIC_MAX_BATCH, 1024),
      maxSpanBytes: safeLimit(options.maxSpanBytes, DEFAULT_SEMANTIC_MAX_SPAN_BYTES, 1024 * 1024),
      maxCandidates: safeLimit(options.maxCandidates, DEFAULT_SEMANTIC_MAX_CANDIDATES, 4096),
      tablePrefix: options.tablePrefix ?? DEFAULT_SEMANTIC_TABLE_PREFIX,
      sqliteVecPath: options.sqliteVecPath,
      sqliteLembedPath: options.sqliteLembedPath,
    };
    this.modelName = this.options.modelName;
    if (!IDENTIFIER.test(this.options.tablePrefix)) {
      this.tables = { metadata: "", vector: "" };
      const failure: RuntimeFailure = {
        status: "incompatible",
        reason: "semantic table prefix is not a safe SQL identifier",
      };
      this.probe = failureReceipt(failure);
      this.operational = false;
      return;
    }
    this.tables = {
      metadata: `${this.options.tablePrefix}_spans`,
      vector: `${this.options.tablePrefix}_vec`,
    };
    try {
      ensureSemanticDurableTables(this.db, this.options.tablePrefix);
    } catch (error) {
      const failure: RuntimeFailure = {
        status: "unavailable",
        reason: `semantic durable deletion table could not be opened: ${reasonFor(error)}`,
      };
      this.probe = failureReceipt(failure);
      this.operational = false;
      return;
    }
    const failure = this.initialize();
    if (failure !== null) {
      this.probe = failureReceipt(failure);
      this.operational = false;
      return;
    }
    this.probe = this.makeProbe();
    this.operational = true;
  }

  get receipt(): SemanticReceipt {
    if (!this.operational) return this.probe.receipt;
    return this.receiptForCounts(this.countIndexed(), this.options.eligible);
  }

  receiptFor(threadId: string, eligible?: number): SemanticReceipt {
    if (!this.operational || typeof threadId !== "string" || threadId.length === 0) {
      return this.receipt;
    }
    const knownEligible = safeCount(eligible);
    return this.receiptForCounts(this.countIndexed(threadId), knownEligible);
  }

  receiptForThread(threadId: string, eligible?: number): SemanticReceipt {
    return this.receiptFor(threadId, eligible);
  }

  private receiptForCounts(indexed: number, eligible: number | undefined): SemanticReceipt {
    return buildSemanticReceipt(this.capabilityForCounts(indexed, eligible));
  }

  private withPendingCleanup(capability: SemanticCapability): SemanticCapability {
    if (
      this.pendingDeletes === 0 ||
      capability.status === "unavailable" ||
      capability.status === "incompatible"
    ) {
      return capability;
    }
    return {
      ...capability,
      status: "incomplete",
      reason: `semantic deletion cleanup pending for ${this.pendingDeletes} source${
        this.pendingDeletes === 1 ? "" : "s"
      }`,
    };
  }

  private capabilityForCounts(indexed: number, eligible: number | undefined): SemanticCapability {
    return this.withPendingCleanup(
      probeSemanticCapability({
        sqliteVec: { available: true, version: SEMANTIC_RESOURCES.sqliteVec.version },
        embedding: {
          model: SEMANTIC_RESOURCES.model.name,
          modelDigest: SEMANTIC_RESOURCES.model.sha256,
          dimension: SEMANTIC_RESOURCES.model.dimensions,
        },
        indexed,
        ...(eligible === undefined ? {} : { eligible }),
      }),
    );
  }

  indexBatch(spans: readonly SemanticIndexSpan[]): SemanticIndexBatchResult {
    const requested = Array.isArray(spans) ? spans.length : 0;
    if (!this.operational) {
      return {
        requested,
        processed: 0,
        indexed: 0,
        replaced: 0,
        rejected: [{ span: spans, reason: "database-error" }],
        truncated: requested,
        receipt: this.receipt,
      };
    }
    const maxBatch = this.options.maxBatch;
    const selected = Array.from(spans).slice(0, maxBatch);
    const rejected: SemanticIndexRejection[] = [];
    const normalized: NormalizedSpan[] = [];
    for (const span of selected) {
      const result = normalizeSpan(span, this.options.maxSpanBytes);
      if (result.value !== undefined) normalized.push(result.value);
      else if (result.rejection !== undefined) rejected.push(result.rejection);
    }
    let indexed = 0;
    let replaced = 0;
    let savepoint: string | undefined;
    try {
      savepoint = this.beginSavepoint();
      for (const span of normalized) {
        const existing = this.lookupExact(span);
        if (existing !== null) {
          if (
            existing.sourceHash === span.sourceHash &&
            existing.spanHash === span.spanHash &&
            existing.revision === span.revision
          ) {
            indexed += 1;
            continue;
          }
          this.deleteIds([existing.id]);
          replaced += 1;
        }
        const embedding = this.db.query(`SELECT lembed(?, ?) AS vector`).get(this.modelName, span.text);
        const embeddingValue = asRecord(embedding)?.vector;
        if (!(embeddingValue instanceof Uint8Array) && !ArrayBuffer.isView(embeddingValue)) {
          throw new Error("sqlite-lembed did not return a vector blob");
        }
        const inserted = this.db
          .query(
            `INSERT INTO ${quoteIdentifier(this.tables.metadata)}
             (thread_id, seq, byte_from, byte_to, source_hash, revision, span_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          )
          .get(span.threadId, span.seq, span.from, span.to, span.sourceHash, span.revision, span.spanHash);
        const id = Number(asRecord(inserted)?.id);
        if (!Number.isSafeInteger(id) || id < 1)
          throw new Error("semantic metadata row did not return an id");
        this.db
          .query(
            `INSERT INTO ${quoteIdentifier(this.tables.vector)}
             (rowid, embedding, thread_id, seq, byte_from, byte_to, source_hash, revision, span_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            embeddingValue,
            span.threadId,
            span.seq,
            span.from,
            span.to,
            span.sourceHash,
            span.revision,
            span.spanHash,
          );
        indexed += 1;
      }
      this.releaseSavepoint(savepoint);
    } catch (error) {
      if (savepoint !== undefined) this.rollbackSavepoint(savepoint);
      rejected.push({ span: normalized, reason: "database-error" });
      indexed = 0;
      replaced = 0;
      void error;
    }
    return {
      requested,
      processed: selected.length,
      indexed,
      replaced,
      rejected,
      truncated: Math.max(0, requested - selected.length),
      receipt: this.receipt,
    };
  }

  search(threadId: string, query: string, options: SemanticSearchOptions = {}): SemanticHit[] {
    if (
      !this.operational ||
      typeof threadId !== "string" ||
      threadId.length === 0 ||
      typeof query !== "string"
    ) {
      return [];
    }
    const limit = safeLimit(options.limit, 8, this.options.maxCandidates);
    const candidates = Math.max(limit, this.options.maxCandidates);
    let rows: unknown[];
    try {
      rows = this.db
        .query(
          `SELECT rowid, distance FROM ${quoteIdentifier(this.tables.vector)}
           WHERE embedding MATCH lembed(?, ?) AND k = ? AND thread_id = ?`,
        )
        .all(this.modelName, query, candidates, threadId);
    } catch {
      return [];
    }
    const ids = rows
      .map((row) => Number(asRecord(row)?.rowid))
      .filter((id) => Number.isSafeInteger(id) && id >= 1);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    let metadataRows: unknown[];
    try {
      metadataRows = this.db
        .query(
          `SELECT id, thread_id, seq, byte_from, byte_to, source_hash, revision, span_hash
           FROM ${quoteIdentifier(this.tables.metadata)} WHERE id IN (${placeholders})`,
        )
        .all(...ids);
    } catch {
      return [];
    }
    const metadata = new Map<number, StoredSpan>();
    for (const row of metadataRows) {
      const stored = toStoredSpan(row);
      if (stored !== null && stored.threadId === threadId) metadata.set(stored.id, stored);
    }
    const distanceById = new Map<number, number>();
    for (const row of rows) {
      const record = asRecord(row);
      const id = Number(record?.rowid);
      const distance = Number(record?.distance);
      if (metadata.has(id) && Number.isFinite(distance) && distance >= 0) distanceById.set(id, distance);
    }
    const ordered = [...metadata.values()]
      .filter((span) => distanceById.has(span.id))
      .sort((a, b) => {
        const distanceA = distanceById.get(a.id) ?? Number.POSITIVE_INFINITY;
        const distanceB = distanceById.get(b.id) ?? Number.POSITIVE_INFINITY;
        if (distanceA !== distanceB) return distanceA - distanceB;
        if (a.seq !== b.seq) return a.seq - b.seq;
        if (a.from !== b.from) return a.from - b.from;
        if (a.to !== b.to) return a.to - b.to;
        if (a.spanHash !== b.spanHash) return a.spanHash < b.spanHash ? -1 : 1;
        return a.id - b.id;
      });
    const hits: SemanticHit[] = [];
    for (const span of ordered.slice(0, limit)) {
      const distance = distanceById.get(span.id);
      if (distance === undefined) continue;
      if (options.maxDistance !== undefined && distance > options.maxDistance) continue;
      hits.push({
        seq: span.seq,
        byteRange: [span.from, span.to],
        contentHash: span.sourceHash,
        spanHash: span.spanHash,
        revision: span.revision,
        distance,
      });
    }
    return hits;
  }

  remove(threadId: string, seq: Seq, byteRange?: [number, number]): SemanticRemoveResult {
    if (!this.operational || typeof threadId !== "string" || threadId.length === 0) {
      return {
        removed: 0,
        status: "unavailable",
        reason: "semantic native resources are unavailable",
        receipt: this.receipt,
      };
    }
    let savepoint: string | undefined;
    try {
      savepoint = this.beginSavepoint();
      const removed = this.deleteSourceRows(threadId, seq, byteRange).removed;
      this.releaseSavepoint(savepoint);
      return {
        removed,
        status: removed === 0 ? "empty" : "removed",
        receipt: this.receipt,
      };
    } catch (error) {
      if (savepoint !== undefined) this.rollbackSavepoint(savepoint);
      // A real native delete failure must escape the caller's outer forget
      // transaction; returning zero would commit a tombstone while a vector
      // row survives.  The durable no-runtime path is handled by Vault.
      throw new Error(`semantic deletion failed: ${reasonFor(error)}`);
    }
  }

  clearThread(threadId: string): SemanticRemoveResult {
    if (!this.operational || typeof threadId !== "string" || threadId.length === 0) {
      return {
        removed: 0,
        status: "unavailable",
        reason: "semantic native resources are unavailable",
        receipt: this.receipt,
      };
    }
    return this.clearThreadRows(threadId);
  }

  private clearThreadRows(threadId: string): SemanticRemoveResult {
    let savepoint: string | undefined;
    try {
      savepoint = this.beginSavepoint();
      let metadataAfter = 0;
      let vectorAfter = 0;
      let removed = 0;
      for (;;) {
        const metadataIds = this.db
          .query(
            `SELECT id FROM ${quoteIdentifier(this.tables.metadata)}
             WHERE thread_id = ? AND id > ?
             ORDER BY id ASC LIMIT ${SEMANTIC_DELETE_BATCH}`,
          )
          .all(threadId, metadataAfter)
          .map((row) => Number(asRecord(row)?.id))
          .filter((id) => Number.isSafeInteger(id) && id >= 1);
        const vectorIds = this.db
          .query(
            `SELECT rowid AS id FROM ${quoteIdentifier(this.tables.vector)}
             WHERE thread_id = ? AND rowid > ?
             ORDER BY rowid ASC LIMIT ${SEMANTIC_DELETE_BATCH}`,
          )
          .all(threadId, vectorAfter)
          .map((row) => Number(asRecord(row)?.id))
          .filter((id) => Number.isSafeInteger(id) && id >= 1);
        if (metadataIds.length === 0 && vectorIds.length === 0) break;
        const metadataLast = metadataIds.at(-1);
        if (metadataLast !== undefined) metadataAfter = metadataLast;
        const vectorLast = vectorIds.at(-1);
        if (vectorLast !== undefined) vectorAfter = vectorLast;
        const ids = [...new Set([...metadataIds, ...vectorIds])];
        this.deleteIds(ids);
        removed += ids.length;
      }
      this.releaseSavepoint(savepoint);
      return {
        removed,
        status: removed === 0 ? "empty" : "removed",
        receipt: this.receipt,
      };
    } catch (error) {
      if (savepoint !== undefined) this.rollbackSavepoint(savepoint);
      throw new Error(`semantic deletion failed: ${reasonFor(error)}`);
    }
  }

  private initialize(): RuntimeFailure | null {
    const modelPath = this.options.modelPath;
    if (typeof modelPath !== "string" || modelPath.length === 0 || !existsSync(modelPath)) {
      return { status: "unavailable", reason: "the pinned semantic model artifact is not present" };
    }
    let digest: string;
    try {
      digest = sha256(readFileSync(modelPath));
    } catch (error) {
      return {
        status: "unavailable",
        reason: `the pinned semantic model could not be read: ${reasonFor(error)}`,
      };
    }
    if (digest !== SEMANTIC_RESOURCES.model.sha256) {
      return {
        status: "incompatible",
        reason: `semantic model digest mismatch: expected ${SEMANTIC_RESOURCES.model.sha256}, got ${digest}`,
      };
    }
    try {
      const explicitVec = this.options.sqliteVecPath;
      const explicitLembed = this.options.sqliteLembedPath;
      if ((explicitVec === undefined) !== (explicitLembed === undefined)) {
        return {
          status: "incompatible",
          reason: "both sqlite-vec and sqlite-lembed extension paths are required",
        };
      }
      if (!loadedDatabases.has(this.db as object)) {
        if (explicitVec !== undefined && explicitLembed !== undefined) {
          if (!existsSync(explicitVec) || !existsSync(explicitLembed)) {
            return {
              status: "unavailable",
              reason: "a configured semantic extension artifact is not present",
            };
          }
          this.db.loadExtension(explicitVec);
          this.db.loadExtension(explicitLembed);
        } else {
          sqliteVec.load(this.db);
          sqliteLembed.load(this.db);
        }
        loadedDatabases.add(this.db as object);
      }
      const versions = asRecord(
        this.db.query("SELECT vec_version() AS vec, lembed_version() AS lembed").get(),
      );
      const vecVersion = normalizeExtensionVersion(versions?.vec);
      const lembedVersion = normalizeExtensionVersion(versions?.lembed);
      if (vecVersion !== SEMANTIC_RESOURCES.sqliteVec.version) {
        return { status: "incompatible", reason: `sqlite-vec version mismatch: ${String(versions?.vec)}` };
      }
      if (lembedVersion !== SEMANTIC_RESOURCES.sqliteLembed.version) {
        return {
          status: "incompatible",
          reason: `sqlite-lembed version mismatch: ${String(versions?.lembed)}`,
        };
      }
      const loaded = loadedModels.get(this.db as object) ?? new Set<string>();
      if (!loaded.has(this.modelName)) {
        this.db
          .query("INSERT INTO temp.lembed_models(name, model) SELECT ?, lembed_model_from_file(?)")
          .run(this.modelName, modelPath);
        loaded.add(this.modelName);
        loadedModels.set(this.db as object, loaded);
      }
      const dimension = Number(
        asRecord(this.db.query("SELECT vec_length(lembed(?, ?)) AS dimension").get(this.modelName, "pylos"))
          ?.dimension,
      );
      if (dimension !== SEMANTIC_RESOURCES.model.dimensions) {
        return { status: "incompatible", reason: `embedding dimension mismatch: ${dimension}` };
      }
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(this.tables.metadata)} (
          id INTEGER PRIMARY KEY,
          thread_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          byte_from INTEGER NOT NULL,
          byte_to INTEGER NOT NULL,
          source_hash TEXT NOT NULL,
          revision TEXT NOT NULL,
          span_hash TEXT NOT NULL,
          UNIQUE(thread_id, seq, byte_from, byte_to)
        );
        CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.options.tablePrefix}_spans_thread_seq`)}
          ON ${quoteIdentifier(this.tables.metadata)} (thread_id, seq);
        CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdentifier(this.tables.vector)} USING vec0(
          embedding float[384] distance_metric=cosine,
          thread_id text partition key,
          +seq integer,
          +byte_from integer,
          +byte_to integer,
          +source_hash text,
          +revision text,
          +span_hash text
        );`,
      );
      this.drainPendingDeletes();
      return null;
    } catch (error) {
      return { status: "unavailable", reason: `semantic runtime probe failed: ${reasonFor(error)}` };
    }
  }

  private makeProbe(): SemanticRuntimeProbe {
    const capability = this.capabilityForCounts(this.countIndexed(), this.options.eligible);
    const receipt = buildSemanticReceipt(capability);
    return {
      capability,
      receipt,
      identity: SEMANTIC_RUNTIME_IDENTITY,
      ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
    };
  }

  /** Retry a bounded prefix of ordinary-SQL deletion journal entries on each open. */
  private drainPendingDeletes(): void {
    const pending = durableDeletionTable(this.options.tablePrefix);
    const rows = this.db
      .query(
        `SELECT thread_id, seq FROM ${pending}
         ORDER BY created_at, thread_id, seq LIMIT ${SEMANTIC_STARTUP_DELETE_BUDGET}`,
      )
      .all() as Array<{ thread_id?: unknown; seq?: unknown }>;
    for (const row of rows) {
      const threadId = row.thread_id;
      const seq = row.seq;
      if (
        typeof threadId !== "string" ||
        threadId.length === 0 ||
        typeof seq !== "number" ||
        !Number.isSafeInteger(seq) ||
        seq < 1
      ) {
        throw new Error("semantic deletion journal contains a malformed row");
      }
      const savepoint = this.beginSavepoint();
      try {
        const cleanup = this.deleteSourceRows(threadId, seq, undefined, SEMANTIC_DELETE_BATCH);
        if (cleanup.complete) {
          this.db.query(`DELETE FROM ${pending} WHERE thread_id = ? AND seq = ?`).run(threadId, seq);
        }
        this.releaseSavepoint(savepoint);
        if (!cleanup.complete) break;
      } catch (error) {
        this.rollbackSavepoint(savepoint);
        throw new Error(`semantic pending deletion failed: ${reasonFor(error)}`);
      }
    }
    this.pendingDeletes = this.pendingDeleteCount(pending);
  }

  private pendingDeleteCount(pending = durableDeletionTable(this.options.tablePrefix)): number {
    const row = this.db.query(`SELECT count(*) AS count FROM ${pending}`).get();
    const count = Number(asRecord(row)?.count);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }

  private countIndexed(threadId?: string): number {
    if (!this.operationalTables()) return 0;
    try {
      const row =
        threadId === undefined
          ? this.db
              .query(
                `SELECT count(*) AS count
               FROM ${quoteIdentifier(this.tables.metadata)} AS m
               INNER JOIN ${quoteIdentifier(this.tables.vector)} AS v ON v.rowid = m.id`,
              )
              .get()
          : this.db
              .query(
                `SELECT count(*) AS count
               FROM ${quoteIdentifier(this.tables.metadata)} AS m
               INNER JOIN ${quoteIdentifier(this.tables.vector)} AS v ON v.rowid = m.id
               WHERE m.thread_id = ?`,
              )
              .get(threadId);
      return Number(asRecord(row)?.count) || 0;
    } catch {
      return 0;
    }
  }

  private operationalTables(): boolean {
    return this.tables.metadata.length > 0 && this.tables.vector.length > 0;
  }

  /** Page metadata and vector rowids, including orphaned native rows. */
  private sourceIds(
    threadId: string,
    seq: Seq,
    byteRange: [number, number] | undefined,
    metadataAfter: number,
    vectorAfter: number,
    limit: number,
  ): SourceIdsPage {
    const condition =
      byteRange === undefined
        ? "thread_id = ? AND seq = ?"
        : "thread_id = ? AND seq = ? AND byte_from = ? AND byte_to = ?";
    const parameters: unknown[] =
      byteRange === undefined ? [threadId, seq] : [threadId, seq, byteRange[0], byteRange[1]];
    const metadataRows = this.db
      .query(
        `SELECT id FROM ${quoteIdentifier(this.tables.metadata)}
         WHERE ${condition} AND id > ?
         ORDER BY id ASC LIMIT ${limit}`,
      )
      .all(...parameters, metadataAfter);
    const vectorRows = this.db
      .query(
        `SELECT rowid AS id FROM ${quoteIdentifier(this.tables.vector)}
         WHERE ${condition} AND rowid > ?
         ORDER BY rowid ASC LIMIT ${limit}`,
      )
      .all(...parameters, vectorAfter);
    const metadataIds = metadataRows
      .map((row) => Number(asRecord(row)?.id))
      .filter((id) => Number.isSafeInteger(id) && id >= 1);
    const vectorIds = vectorRows
      .map((row) => Number(asRecord(row)?.id))
      .filter((id) => Number.isSafeInteger(id) && id >= 1);
    if (metadataRows.length !== metadataIds.length || vectorRows.length !== vectorIds.length) {
      throw new Error("semantic source deletion encountered a malformed row");
    }
    return {
      ids: [...new Set([...metadataIds, ...vectorIds])],
      metadataAfter: metadataIds.at(-1) ?? metadataAfter,
      vectorAfter: vectorIds.at(-1) ?? vectorAfter,
      metadataHasMore: metadataRows.length >= limit,
      vectorHasMore: vectorRows.length >= limit,
    };
  }

  private deleteSourceRows(
    threadId: string,
    seq: Seq,
    byteRange?: [number, number],
    maxSpans = Number.POSITIVE_INFINITY,
  ): SourceDeleteResult {
    let metadataAfter = 0;
    let vectorAfter = 0;
    let removed = 0;
    for (;;) {
      const remaining = Number.isFinite(maxSpans) ? maxSpans - removed : SEMANTIC_DELETE_BATCH;
      if (remaining <= 0) return { removed, complete: false };
      const page = this.sourceIds(
        threadId,
        seq,
        byteRange,
        metadataAfter,
        vectorAfter,
        Math.min(SEMANTIC_DELETE_BATCH, remaining),
      );
      if (page.ids.length === 0) {
        return {
          removed,
          complete: !page.metadataHasMore && !page.vectorHasMore,
        };
      }
      metadataAfter = page.metadataAfter;
      vectorAfter = page.vectorAfter;
      this.deleteIds(page.ids);
      removed += page.ids.length;
      if (Number.isFinite(maxSpans) && removed >= maxSpans) {
        return {
          removed,
          complete: !page.metadataHasMore && !page.vectorHasMore,
        };
      }
      if (!page.metadataHasMore && !page.vectorHasMore) return { removed, complete: true };
    }
  }

  private lookupExact(span: NormalizedSpan): StoredSpan | null {
    const row = this.db
      .query(
        `SELECT id, thread_id, seq, byte_from, byte_to, source_hash, revision, span_hash
         FROM ${quoteIdentifier(this.tables.metadata)}
         WHERE thread_id = ? AND seq = ? AND byte_from = ? AND byte_to = ?`,
      )
      .get(span.threadId, span.seq, span.from, span.to);
    return toStoredSpan(row);
  }

  private deleteIds(ids: readonly number[]): void {
    for (const id of ids) {
      this.db.query(`DELETE FROM ${quoteIdentifier(this.tables.vector)} WHERE rowid = ?`).run(id);
      this.db.query(`DELETE FROM ${quoteIdentifier(this.tables.metadata)} WHERE id = ?`).run(id);
    }
  }

  private beginSavepoint(): string {
    const name = `pylos_semantic_sp_${++this.savepointCounter}`;
    this.db.exec(`SAVEPOINT ${name}`);
    return name;
  }

  private releaseSavepoint(name: string): void {
    this.db.exec(`RELEASE SAVEPOINT ${name}`);
  }

  private rollbackSavepoint(name: string): void {
    try {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    } catch {
      // The savepoint may already have been released by a driver error.
    }
    try {
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
    } catch {
      // Keep rollback itself fail-closed if the connection is already unusable.
    }
  }
}

function normalizeExtensionVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.startsWith("v") ? value.slice(1) : value;
}

/** Open a local route; all extension/model failures are represented in `probe`. */
export function createSemanticRuntime(
  db: SemanticSqlDatabase,
  options: SemanticRuntimeOptions,
): SemanticRuntimeOpenResult {
  const runtime = new SqliteSemanticRuntime(db, options);
  return { runtime, probe: runtime.probe };
}

/** Probe and open in one call for orchestrators that only need a capability. */
export function probeSemanticRuntime(
  db: SemanticSqlDatabase,
  options: SemanticRuntimeOptions,
): SemanticRuntimeProbe {
  return createSemanticRuntime(db, options).probe;
}

/** A pure helper for callers that need a receipt before a DB is available. */
export function unavailableSemanticRuntime(reason?: string): SemanticRuntimeProbe {
  const capability = probeSemanticCapability({
    sqliteVec: { available: false, reason: reason ?? "semantic runtime was not opened" },
  });
  return {
    capability,
    receipt: buildSemanticReceipt(capability),
    identity: SEMANTIC_RUNTIME_IDENTITY,
    reason: capability.reason,
  };
}
