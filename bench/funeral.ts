#!/usr/bin/env bun

/**
 * Full-scale Laptop Funeral measurement harness.
 *
 * This runner is deliberately a file-to-file exercise: the bundle leaves the
 * source vault through `exportBundleStream`, and the restore consumes the file
 * through `importBundleStream`. It never asks the compatibility byte API to
 * collect an archive in memory. A source profile is read only; the restore
 * home is a unique, explicitly-derived temporary path that is removed after
 * the report is written.
 *
 * A small deterministic fixture can be created in an explicit `--home` with
 * `--turns 1000`. The fixture is useful for smoke checks, but its telemetry is
 * reported as a fixture run and is not a million-turn claim.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  BUNDLE_TRANSPORT_BUFFER_BOUND,
  type BundleProgress,
  canonicalHash,
  canonicalJson,
  type EpisodeInput,
  exportBundleStream,
  importBundleStream,
  openVault,
  page,
  type Vault,
  verify,
} from "@pylos/core";

const REPORT_SCHEMA = "pylos.bench.laptop-funeral.v3" as const;
const ARCHIVE_MANIFEST_SCHEMA = "pylos.bench.archive-manifest.v1" as const;
const RECEIPT_COVERAGE_SCHEMA = "pylos.bench.receipt-coverage.v1" as const;
const DEFAULT_PAGE_BUDGET = 1_350;
const FIXTURE_BATCH = 512;
const FIXTURE_TS_BASE = 1_760_000_000_000;
const RECEIPT_BATCH = 1_024;
const RECEIPT_SAMPLE_SIZE = 8;
const DECLARED_BUFFER_BOUND = BUNDLE_TRANSPORT_BUFFER_BOUND;

interface CliOptions {
  home: string;
  thread: string;
  out: string;
  bundle: string;
  passphrase?: string;
  turns?: number;
  pageSeq?: number;
  pageQuery?: string;
  millionResult?: string;
  budget: number;
  keepDestination: boolean;
}

export interface MillionArtifactReference {
  digest: string;
  verifiedHeadHash: string;
}

interface MemorySample {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

interface ProgressSummary {
  eventCount: number;
  phases: string[];
  final: BundleProgress | null;
  declaredBufferBoundBytes: number;
  withinDeclaredBufferBound: boolean;
  max: {
    bytes: number | null;
    stagedBytes: number | null;
    rows: number | null;
    entries: number | null;
    bufferedBytes: number | null;
    peakBufferedBytes: number | null;
  };
}

interface ReceiptSnapshot {
  /** Counts and digests cover every row; samples are only for human inspection. */
  packets: {
    count: number;
    digest: string;
    sample: Array<{
      turnSeq: number;
      digest: string;
      status: string;
      coverageDigest: string | null;
      answerReceiptDigest: string | null;
    }>;
  };
  answerReceipts: { count: number; digest: string; sample: Array<{ turnSeq: number; digest: string }> };
  coverageReceipts: { count: number; digest: string; sample: Array<{ turnSeq: number; digest: string }> };
  addresses: {
    count: number;
    digest: string;
    sample: Array<Record<string, unknown>>;
  };
  aliases: { count: number; digest: string };
}

const ARCHIVE_TABLES = [
  "episodes",
  "atoms",
  "capsules",
  "capsuleLedgerEntries",
  "loss",
  "packets",
  "tombstones",
  "addressRoutes",
  "addressAliases",
  "atomizationReceipts",
] as const;

type ArchiveTable = (typeof ARCHIVE_TABLES)[number];

interface TableSnapshot {
  count: number;
  digest: string;
}

interface ArchiveManifestSnapshot {
  schema: typeof ARCHIVE_MANIFEST_SCHEMA;
  headSeq: number;
  headHash: string;
  tables: Record<ArchiveTable, TableSnapshot>;
  digest: string;
}

const RECEIPT_NAMESPACES = [
  "packet",
  "request-round",
  "reachability",
  "coverage",
  "evidence",
  "answer",
  "semantic",
  "address-route",
  "address-alias",
  "atomization",
  "capsule-ledger",
  "tombstone",
  "attachment-manifest",
] as const;

type ReceiptNamespace = (typeof RECEIPT_NAMESPACES)[number];
type ReceiptNamespaceCounts = Record<ReceiptNamespace, number>;

interface ReceiptNamespaceCoverage {
  schema: typeof RECEIPT_COVERAGE_SCHEMA;
  namespaces: Record<ReceiptNamespace, { source: number; restore: number; exercised: boolean }>;
  exercised: ReceiptNamespace[];
  unexercised: ReceiptNamespace[];
  digest: string;
}

interface PageSnapshot {
  requested: boolean;
  request: { seq?: number; query?: string };
  records: Array<Record<string, unknown>>;
  blocks: Array<{ seq: number; role: string; trigger: string; text: string; epistemic: string }>;
  digest: string | null;
  exact: boolean | null;
  resolvedSeqs: number[];
}

interface FuneralResult {
  schema: typeof REPORT_SCHEMA;
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  source: {
    threadId: string;
    turns: number;
    headHash: string;
    fullVerify: ReturnType<typeof verify>;
    receipts: ReceiptSnapshot;
    manifest: ArchiveManifestSnapshot;
  };
  restore: {
    threadId: string;
    turns: number;
    headHash: string;
    import: { episodes: number; verified: boolean; headSeq: number; headHash: string };
    fullVerify: ReturnType<typeof verify>;
    receipts: ReceiptSnapshot;
    manifest: ArchiveManifestSnapshot;
  };
  bundle: {
    bytes: number;
    sha256: string;
    exportMs: number;
    importMs: number;
    exportProgress: ProgressSummary;
    importProgress: ProgressSummary;
  };
  receiptCoverage: ReceiptNamespaceCoverage;
  page: {
    source: PageSnapshot;
    restore: PageSnapshot;
    digestEqual: boolean | null;
    byteExact: boolean | null;
  };
  memory: {
    beforeExport: MemorySample;
    afterExport: MemorySample;
    afterImport: MemorySample;
    afterVerify: MemorySample;
    deltas: {
      export: MemorySample;
      import: MemorySample;
      verify: MemorySample;
    };
  };
  passphrase: "provided" | "generated";
  fixture?: { turns: number; plantedSeq: number; seeded: boolean };
  destinationCleaned: boolean;
  failures: string[];
}

class ProgressRecorder {
  private readonly events: BundleProgress[] = [];

  observe = (progress: BundleProgress): void => {
    this.events.push({ ...progress });
  };

  withinDeclaredBufferBound(): boolean {
    return this.events.every(
      (event) =>
        event.peakBufferedBytes <= DECLARED_BUFFER_BOUND && event.bufferedBytes <= DECLARED_BUFFER_BOUND,
    );
  }

  summary(): ProgressSummary {
    const max = (key: keyof BundleProgress): number | null => {
      if (this.events.length === 0) return null;
      return Math.max(...this.events.map((event) => Number(event[key])));
    };
    return {
      eventCount: this.events.length,
      phases: [...new Set(this.events.map((event) => event.phase))],
      final: this.events.at(-1) ?? null,
      declaredBufferBoundBytes: DECLARED_BUFFER_BOUND,
      withinDeclaredBufferBound: this.withinDeclaredBufferBound(),
      max: {
        bytes: max("bytes"),
        stagedBytes: max("stagedBytes"),
        rows: max("rows"),
        entries: max("entries"),
        bufferedBytes: max("bufferedBytes"),
        peakBufferedBytes: max("peakBufferedBytes"),
      },
    };
  }
}

function parseArgs(argv: readonly string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function requiredText(args: Record<string, string | true>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function numberOption(args: Record<string, string | true>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === true) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function parseOptions(args: Record<string, string | true>): CliOptions {
  const out = resolve(requiredText(args, "out"));
  const home = resolve(requiredText(args, "home"));
  const turns = numberOption(args, "turns");
  const budget = numberOption(args, "budget") ?? 8192;
  const pageSeq = numberOption(args, "page-seq");
  const pageQueryValue = args["page-query"];
  if (pageQueryValue !== undefined && pageQueryValue === true) throw new Error("--page-query needs text");
  const millionResultValue = args["million-result"];
  if (millionResultValue !== undefined && millionResultValue === true)
    throw new Error("--million-result needs a JSON path");
  const bundleArg = args.bundle;
  const bundle = resolve(typeof bundleArg === "string" && bundleArg.length > 0 ? bundleArg : `${out}.pylos`);
  return {
    home,
    thread: requiredText(args, "thread"),
    out,
    bundle,
    ...(typeof args.passphrase === "string" ? { passphrase: args.passphrase } : {}),
    ...(turns === undefined ? {} : { turns }),
    ...(pageSeq === undefined ? {} : { pageSeq }),
    ...(typeof pageQueryValue === "string" ? { pageQuery: pageQueryValue } : {}),
    ...(typeof millionResultValue === "string" ? { millionResult: resolve(millionResultValue) } : {}),
    budget,
    keepDestination: args["keep-destination"] === true,
  };
}

function printUsage(): void {
  process.stdout.write(
    `${[
      "Usage: bun run bench/funeral.ts --home HOME --thread THREAD --out REPORT.json [options]",
      "",
      "Required: --home, --thread, --out",
      "Options:",
      "  --bundle PATH       encrypted stream destination (default REPORT.json.pylos)",
      "  --passphrase TEXT  passphrase (otherwise a process-local random secret is used)",
      "  --turns N           seed a deterministic fixture when THREAD is absent/empty",
      "  --page-seq N        exact sequence to page on both vaults",
      "  --page-query TEXT   query to page on both vaults",
      "  --million-result JSON  bind the source vault to a million bench result digest",
      "  --budget N          page budget (default 8192 for fixture and verification)",
      "  --keep-destination  keep the explicitly-derived restore home for inspection",
      "  --render-existing JSON  render a passing JSON report to a sibling Markdown artifact",
      "  --markdown-out PATH    Markdown destination for --render-existing",
    ].join("\n")}\n`,
  );
}

function randomPassphrase(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function memorySample(): MemorySample {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers ?? 0,
  };
}

function memoryDelta(before: MemorySample, after: MemorySample): MemorySample {
  return {
    rss: after.rss - before.rss,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

function artifactDiagnostic(value: string): string {
  return value.replace(
    /(^|[\s("'`])\/(?:[^\s"'`()<>{}[\]]+\/?)+/g,
    (_match, prefix: string) => `${prefix}<local-path>`,
  );
}

function artifactVerifyResult(result: ReturnType<typeof verify>): ReturnType<typeof verify> {
  return result.reason === undefined ? result : { ...result, reason: artifactDiagnostic(result.reason) };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Validate the million artifact before it can authorize a funeral comparison. */
export function validateMillionArtifact(path: string): MillionArtifactReference {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    digest?: unknown;
    schema?: unknown;
    N?: unknown;
    final?: { ok?: unknown };
    checkpoints?: Array<{ verify?: { ok?: unknown; headHash?: unknown } }>;
  };
  if (parsed.schema !== "pylos.bench.million.v3") throw new Error("million artifact schema is invalid");
  if (typeof parsed.digest !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.digest)) {
    throw new Error("million artifact digest is missing or malformed");
  }
  const recomputed = createHash("sha256")
    .update(JSON.stringify({ ...parsed, digest: "" }))
    .digest("hex");
  if (recomputed !== parsed.digest) throw new Error("million artifact digest mismatch");
  if (parsed.N !== 1_000_000 || parsed.final?.ok !== true) {
    throw new Error("million artifact is not a passing one-million-turn run");
  }
  const checkpoint = parsed.checkpoints?.at(-1)?.verify;
  if (
    checkpoint?.ok !== true ||
    typeof checkpoint.headHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(checkpoint.headHash)
  ) {
    throw new Error("million artifact has no verified final checkpoint head");
  }
  return {
    digest: parsed.digest,
    verifiedHeadHash: checkpoint.headHash,
  };
}

function nestedDigest(value: unknown, key: string): string | null {
  const parsed = parseJson(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = (parsed as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

interface DigestSnapshot<T> {
  count: number;
  digest: string;
  sample: T[];
}

/** Hash a canonical JSON array incrementally while retaining only its ends. */
class CanonicalArrayDigest<T> {
  private readonly hash = createHash("sha256");
  private countValue = 0;
  private small: T[] = [];
  private first: T[] = [];
  private last: T[] = [];
  private overflow = false;

  add(value: T): void {
    this.hash.update(this.countValue === 0 ? "[" : ",");
    this.hash.update(canonicalJson(value));
    this.countValue += 1;
    if (!this.overflow) {
      this.small.push(value);
      if (this.small.length > RECEIPT_SAMPLE_SIZE) {
        this.overflow = true;
        this.first = this.small.slice(0, RECEIPT_SAMPLE_SIZE / 2);
        this.last = this.small.slice(-RECEIPT_SAMPLE_SIZE / 2);
        this.small = [];
      }
      return;
    }
    this.last.push(value);
    if (this.last.length > RECEIPT_SAMPLE_SIZE / 2) this.last.shift();
  }

  finish(): DigestSnapshot<T> {
    this.hash.update("]");
    return {
      count: this.countValue,
      digest: this.hash.digest("hex"),
      sample: this.overflow ? [...this.first, ...this.last] : [...this.small],
    };
  }
}

function digestRows(vault: Vault, sql: string, threadId: string): TableSnapshot {
  const hash = createHash("sha256");
  const query = vault.db.query(sql);
  let count = 0;
  try {
    for (const row of query.iterate(threadId) as Iterable<Record<string, unknown>>) {
      hash.update(count === 0 ? "[" : ",");
      hash.update(canonicalJson(row));
      count += 1;
    }
  } finally {
    query.finalize();
  }
  hash.update("]");
  return { count, digest: hash.digest("hex") };
}

function archiveManifestSnapshot(
  vault: Vault,
  threadId: string,
  headSeq: number,
  headHash: string,
): ArchiveManifestSnapshot {
  const tables: Record<ArchiveTable, TableSnapshot> = {
    episodes: digestRows(
      vault,
      "SELECT seq, ts, role, model, provider, content, content_hash, tokens, prev_hash, hash, meta " +
        "FROM episode WHERE thread_id = ? ORDER BY seq ASC",
      threadId,
    ),
    atoms: digestRows(
      vault,
      "SELECT id, kind, key, value, text, source_seq, source_span, valid_from_seq, valid_to_seq, " +
        "superseded_by, phase, scope, pinned, confidence, created_by, created_at FROM atom " +
        "WHERE thread_id = ? ORDER BY source_seq ASC, id ASC",
      threadId,
    ),
    capsules: digestRows(
      vault,
      "SELECT id, level, from_seq, to_seq, text, tokens, dropped, carried_count, kept, hash, " +
        "created_by, created_at, ledger_receipt FROM capsule WHERE thread_id = ? " +
        "ORDER BY level ASC, from_seq ASC, id ASC",
      threadId,
    ),
    capsuleLedgerEntries: digestRows(
      vault,
      "SELECT capsule_id, part, ordinal, name, kind, seq, span FROM capsule_ledger_entry " +
        "WHERE thread_id = ? ORDER BY capsule_id ASC, part ASC, ordinal ASC",
      threadId,
    ),
    loss: digestRows(
      vault,
      "SELECT id, capsule_id, name, kind, level, seq, span, resolved_by FROM loss " +
        "WHERE thread_id = ? ORDER BY seq ASC, id ASC",
      threadId,
    ),
    packets: digestRows(
      vault,
      "SELECT id, turn_seq, model, budget, tokens, digest, status, compiler_version, NULL AS messages, " +
        "resident, ledger, pages, rounds, reachability, reachability_as_of_seq, coverage, evidence, " +
        "answer_receipt, semantic, created_at FROM packet WHERE thread_id = ? ORDER BY turn_seq ASC, id ASC",
      threadId,
    ),
    tombstones: digestRows(
      vault,
      "SELECT id, target, reason, created_at, removal_seq FROM tombstone WHERE thread_id = ? ORDER BY id ASC",
      threadId,
    ),
    addressRoutes: digestRows(
      vault,
      "SELECT id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, " +
        "packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at " +
        "FROM address_route WHERE thread_id = ? ORDER BY question_seq ASC, id ASC",
      threadId,
    ),
    addressAliases: digestRows(
      vault,
      "SELECT id, alias, source_seq, byte_from, byte_to, source_hash, quote_hash, authority, status, created_at " +
        "FROM address_alias WHERE thread_id = ? ORDER BY source_seq ASC, id ASC",
      threadId,
    ),
    atomizationReceipts: digestRows(
      vault,
      "SELECT source_seq, source_hash, status, model, candidate_count, accepted_count, omitted_count, reason, " +
        "created_at FROM atomization_receipt WHERE thread_id = ? ORDER BY source_seq ASC",
      threadId,
    ),
  };
  const body = { schema: ARCHIVE_MANIFEST_SCHEMA, headSeq, headHash, tables };
  return { ...body, digest: canonicalHash(body) };
}

function scalarCount(vault: Vault, sql: string, threadId: string): number {
  const row = vault.db.query(sql).get(threadId) as { count: number | null } | null;
  return Number(row?.count ?? 0);
}

function receiptNamespaceCounts(vault: Vault, threadId: string): ReceiptNamespaceCounts {
  return {
    packet: scalarCount(vault, "SELECT COUNT(*) AS count FROM packet WHERE thread_id = ?", threadId),
    "request-round": scalarCount(
      vault,
      "SELECT COALESCE(SUM(CASE WHEN json_valid(rounds) = 1 AND json_type(rounds) = 'array' " +
        "THEN json_array_length(rounds) ELSE 0 END), 0) AS count FROM packet WHERE thread_id = ?",
      threadId,
    ),
    reachability: scalarCount(
      vault,
      "SELECT COUNT(*) AS count FROM packet WHERE thread_id = ? AND reachability IS NOT NULL",
      threadId,
    ),
    coverage: scalarCount(
      vault,
      "SELECT COUNT(*) AS count FROM packet WHERE thread_id = ? AND coverage IS NOT NULL",
      threadId,
    ),
    evidence: scalarCount(
      vault,
      "SELECT COUNT(*) AS count FROM packet WHERE thread_id = ? AND evidence IS NOT NULL",
      threadId,
    ),
    answer: scalarCount(
      vault,
      "SELECT COUNT(*) AS count FROM packet WHERE thread_id = ? AND answer_receipt IS NOT NULL",
      threadId,
    ),
    semantic: scalarCount(
      vault,
      "SELECT COUNT(*) AS count FROM packet WHERE thread_id = ? AND semantic IS NOT NULL",
      threadId,
    ),
    "address-route": scalarCount(
      vault,
      "SELECT COUNT(*) AS count FROM address_route WHERE thread_id = ?",
      threadId,
    ),
    "address-alias": scalarCount(
      vault,
      "SELECT COUNT(*) AS count FROM address_alias WHERE thread_id = ?",
      threadId,
    ),
    atomization: scalarCount(
      vault,
      "SELECT COUNT(*) AS count FROM atomization_receipt WHERE thread_id = ?",
      threadId,
    ),
    "capsule-ledger": scalarCount(
      vault,
      "SELECT COUNT(*) AS count FROM capsule WHERE thread_id = ? AND ledger_receipt IS NOT NULL",
      threadId,
    ),
    tombstone: scalarCount(vault, "SELECT COUNT(*) AS count FROM tombstone WHERE thread_id = ?", threadId),
    "attachment-manifest": scalarCount(
      vault,
      "SELECT COUNT(*) AS count FROM episode WHERE thread_id = ? AND " +
        "CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.manifest') ELSE NULL END = 'object'",
      threadId,
    ),
  };
}

function receiptNamespaceCoverage(
  source: ReceiptNamespaceCounts,
  restore: ReceiptNamespaceCounts,
): ReceiptNamespaceCoverage {
  const namespaces = Object.fromEntries(
    RECEIPT_NAMESPACES.map((namespace) => {
      const sourceCount = source[namespace];
      const restoreCount = restore[namespace];
      return [
        namespace,
        { source: sourceCount, restore: restoreCount, exercised: sourceCount > 0 || restoreCount > 0 },
      ];
    }),
  ) as ReceiptNamespaceCoverage["namespaces"];
  const exercised = RECEIPT_NAMESPACES.filter((namespace) => namespaces[namespace].exercised);
  const unexercised = RECEIPT_NAMESPACES.filter((namespace) => !namespaces[namespace].exercised);
  const body = { schema: RECEIPT_COVERAGE_SCHEMA, namespaces, exercised, unexercised };
  return { ...body, digest: canonicalHash(body) };
}

interface KeysetRow {
  rowId: number;
}

function scanKeyset<T extends KeysetRow>(
  vault: Vault,
  sql: string,
  threadId: string,
  visit: (row: T) => void,
): void {
  const query = vault.db.query(sql);
  let cursor = 0;
  for (;;) {
    const rows = query.all(threadId, cursor, RECEIPT_BATCH) as T[];
    if (rows.length === 0) return;
    for (const row of rows) visit(row);
    cursor = rows[rows.length - 1]?.rowId ?? cursor;
    if (rows.length < RECEIPT_BATCH) return;
  }
}

function receiptSnapshot(vault: Vault, threadId: string): ReceiptSnapshot {
  type PacketEntry = {
    turnSeq: number;
    digest: string;
    status: string;
    coverageDigest: string | null;
    answerReceiptDigest: string | null;
  };
  const packetDigest = new CanonicalArrayDigest<PacketEntry>();
  const answerDigest = new CanonicalArrayDigest<{ turnSeq: number; digest: string }>();
  const coverageDigest = new CanonicalArrayDigest<{ turnSeq: number; digest: string }>();
  scanKeyset<
    KeysetRow & {
      turn_seq: number;
      digest: string;
      status: string;
      coverage: unknown;
      answer_receipt: unknown;
    }
  >(
    vault,
    "SELECT rowid AS rowId, turn_seq, digest, status, coverage, answer_receipt FROM packet " +
      "WHERE thread_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
    threadId,
    (row) => {
      const entry: PacketEntry = {
        turnSeq: Number(row.turn_seq),
        digest: String(row.digest),
        status: String(row.status),
        coverageDigest: nestedDigest(row.coverage, "digest"),
        answerReceiptDigest: nestedDigest(row.answer_receipt, "digest"),
      };
      packetDigest.add(entry);
      if (entry.answerReceiptDigest !== null)
        answerDigest.add({ turnSeq: entry.turnSeq, digest: entry.answerReceiptDigest });
      if (entry.coverageDigest !== null)
        coverageDigest.add({ turnSeq: entry.turnSeq, digest: entry.coverageDigest });
    },
  );

  const routeDigest = new CanonicalArrayDigest<Record<string, unknown>>();
  scanKeyset<
    KeysetRow & {
      query_digest: string;
      normalized_query: string;
      router_version: string;
      question_seq: number;
      answer_seq: number | null;
      packet_digest: string | null;
      source_seqs: unknown;
      witnesses: unknown;
      route_digest: string;
      status: string;
      reason: string | null;
      invalidated_by: string | null;
    }
  >(
    vault,
    "SELECT rowid AS rowId, query_digest, normalized_query, router_version, question_seq, answer_seq, " +
      "packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by FROM address_route " +
      "WHERE thread_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
    threadId,
    (row) => {
      routeDigest.add({
        queryDigest: String(row.query_digest),
        normalizedQuery: String(row.normalized_query),
        routerVersion: String(row.router_version),
        questionSeq: Number(row.question_seq),
        answerSeq: row.answer_seq === null ? null : Number(row.answer_seq),
        packetDigest: row.packet_digest === null ? null : String(row.packet_digest),
        sourceSeqs: parseJson(row.source_seqs),
        witnesses: parseJson(row.witnesses),
        routeDigest: String(row.route_digest),
        status: String(row.status),
        reason: row.reason === null ? null : String(row.reason),
        invalidatedBy: row.invalidated_by === null ? null : String(row.invalidated_by),
      });
    },
  );
  const aliasDigest = new CanonicalArrayDigest<Record<string, unknown>>();
  scanKeyset<
    KeysetRow & {
      alias: string;
      source_seq: number;
      byte_from: number;
      byte_to: number;
      source_hash: string;
      quote_hash: string;
      authority: string;
      status: string;
    }
  >(
    vault,
    "SELECT rowid AS rowId, alias, source_seq, byte_from, byte_to, source_hash, quote_hash, authority, status " +
      "FROM address_alias WHERE thread_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
    threadId,
    (row) => {
      aliasDigest.add({
        alias: String(row.alias),
        sourceSeq: Number(row.source_seq),
        byteFrom: Number(row.byte_from),
        byteTo: Number(row.byte_to),
        sourceHash: String(row.source_hash),
        quoteHash: String(row.quote_hash),
        authority: String(row.authority),
        status: String(row.status),
      });
    },
  );
  const packets = packetDigest.finish();
  const answers = answerDigest.finish();
  const coverage = coverageDigest.finish();
  const addresses = routeDigest.finish();
  const aliases = aliasDigest.finish();
  return {
    packets: { count: packets.count, digest: packets.digest, sample: packets.sample },
    answerReceipts: { count: answers.count, digest: answers.digest, sample: answers.sample },
    coverageReceipts: { count: coverage.count, digest: coverage.digest, sample: coverage.sample },
    addresses: { count: addresses.count, digest: addresses.digest, sample: addresses.sample },
    aliases: { count: aliases.count, digest: aliases.digest },
  };
}

function pageSnapshot(
  vault: Vault,
  threadId: string,
  request: { seq?: number; query?: string },
  budget: number,
): PageSnapshot {
  const result = page(vault, threadId, {
    ...(request.seq === undefined ? {} : { seq: request.seq }),
    ...(request.query === undefined ? {} : { query: request.query }),
    budget,
    maxPages: 3,
    trigger: "explicit",
  });
  const records = result.records.map(({ latencyMs: _latencyMs, ...record }) => record);
  const blocks = result.blocks.map((block) => ({
    seq: block.seq,
    role: block.role,
    trigger: block.trigger,
    text: block.text,
    epistemic: block.epistemic,
  }));
  const resolvedSeqs = [
    ...new Set(records.flatMap((record) => (record.seqs as number[] | undefined) ?? [])),
  ].sort((a, b) => a - b);
  let exact: boolean | null = null;
  if (request.seq !== undefined || request.query !== undefined) {
    exact =
      blocks.length > 0 &&
      blocks.every((block) => {
        const episode = vault.episodes.get(threadId, block.seq);
        return (
          episode !== null &&
          Buffer.from(new TextEncoder().encode(episode.content)).equals(
            Buffer.from(new TextEncoder().encode(block.text)),
          )
        );
      });
  }
  return {
    requested: true,
    request,
    records,
    blocks,
    digest: canonicalHash({ records, blocks }),
    exact,
    resolvedSeqs,
  };
}

function noPageSnapshot(): PageSnapshot {
  return {
    requested: false,
    request: {},
    records: [],
    blocks: [],
    digest: null,
    exact: null,
    resolvedSeqs: [],
  };
}

function fixtureInputs(turns: number, plantedSeq: number): EpisodeInput[] {
  const out: EpisodeInput[] = [];
  for (let seq = 1; seq <= turns; seq += 1) {
    const planted =
      seq === plantedSeq
        ? `Funeral fixture witness: the distant turn carries byte-exact marker FNF-${plantedSeq}.`
        : `Fixture turn ${seq}: deterministic continuity sample ${((seq * 2654435761) >>> 0).toString(16)}.`;
    out.push({
      role: seq % 2 === 0 ? "assistant" : "user",
      content: planted,
      ts: FIXTURE_TS_BASE + seq * 60_000,
      ...(seq % 2 === 0 ? { model: "funeral-fixture", provider: "bench" } : {}),
    });
  }
  return out;
}

/**
 * A fixture thread is named from the requested label, never minted: the id seeds
 * the hash chain, so a random one would move every head hash between runs. A
 * label that is already a thread id is kept, so `--thread th_… --turns N` seeds
 * exactly the thread the caller asked for.
 */
function fixtureThreadId(label: string): string {
  return label.startsWith("th_")
    ? label
    : `th_funeral_${label.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 64)}`;
}

function seedFixture(vault: Vault, threadId: string, turns: number): number {
  const plantedSeq = Math.max(1, Math.floor(turns * 0.73));
  const inputs = fixtureInputs(turns, plantedSeq);
  vault.tx(() => {
    for (let offset = 0; offset < inputs.length; offset += FIXTURE_BATCH) {
      vault.episodes.appendMany(threadId, inputs.slice(offset, offset + FIXTURE_BATCH));
    }
  });
  return plantedSeq;
}

function pathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel));
}

function assertOutputOutsideSource(options: CliOptions): void {
  const source = resolve(options.home);
  for (const path of [options.out, options.bundle]) {
    if (pathInside(path, source)) {
      throw new Error(`output path ${path} is inside source home ${source}; choose a separate output path`);
    }
  }
}

function compareReceipts(source: ReceiptSnapshot, restored: ReceiptSnapshot, failures: string[]): void {
  if (source.packets.count !== restored.packets.count) failures.push("packet count mismatch");
  if (source.packets.digest !== restored.packets.digest) failures.push("packet digest mismatch");
  if (source.answerReceipts.count !== restored.answerReceipts.count)
    failures.push("answer receipt count mismatch");
  if (source.answerReceipts.digest !== restored.answerReceipts.digest)
    failures.push("answer receipt digest mismatch");
  if (source.coverageReceipts.count !== restored.coverageReceipts.count)
    failures.push("coverage receipt count mismatch");
  if (source.coverageReceipts.digest !== restored.coverageReceipts.digest)
    failures.push("coverage receipt digest mismatch");
  if (source.addresses.count !== restored.addresses.count) failures.push("address receipt count mismatch");
  if (source.addresses.digest !== restored.addresses.digest) failures.push("address receipt digest mismatch");
  if (source.aliases.count !== restored.aliases.count) failures.push("address alias count mismatch");
  if (source.aliases.digest !== restored.aliases.digest) failures.push("address alias digest mismatch");
}

function compareArchiveManifests(
  source: ArchiveManifestSnapshot,
  restored: ArchiveManifestSnapshot,
  failures: string[],
): void {
  for (const table of ARCHIVE_TABLES) {
    if (source.tables[table].count !== restored.tables[table].count) {
      failures.push(`${table} table count mismatch`);
    }
    if (source.tables[table].digest !== restored.tables[table].digest) {
      failures.push(`${table} table digest mismatch`);
    }
  }
  if (source.digest !== restored.digest) failures.push("archive manifest digest mismatch");
}

function compareReceiptNamespaceCounts(coverage: ReceiptNamespaceCoverage, failures: string[]): void {
  for (const namespace of RECEIPT_NAMESPACES) {
    const counts = coverage.namespaces[namespace];
    if (counts.source !== counts.restore) {
      failures.push(`${namespace} receipt namespace count mismatch`);
    }
  }
}

function emptyArchiveManifest(): ArchiveManifestSnapshot {
  const empty = { count: 0, digest: canonicalHash([]) };
  const tables = Object.fromEntries(ARCHIVE_TABLES.map((table) => [table, { ...empty }])) as Record<
    ArchiveTable,
    TableSnapshot
  >;
  const body = { schema: ARCHIVE_MANIFEST_SCHEMA, headSeq: 0, headHash: "", tables };
  return { ...body, digest: canonicalHash(body) };
}

function emptyReceiptCoverage(): ReceiptNamespaceCoverage {
  const counts = Object.fromEntries(
    RECEIPT_NAMESPACES.map((namespace) => [namespace, 0]),
  ) as ReceiptNamespaceCounts;
  return receiptNamespaceCoverage(counts, counts);
}

function checkProgress(label: string, progress: ProgressSummary, failures: string[]): void {
  if (progress.eventCount === 0 || progress.final === null) {
    failures.push(`${label} bundle progress was not emitted`);
    return;
  }
  if (progress.final.phase !== "done") failures.push(`${label} bundle progress did not finish`);
  if (!progress.withinDeclaredBufferBound) {
    failures.push(`${label} progress exceeded declared ${DECLARED_BUFFER_BOUND} byte buffer bound`);
  }
}

async function writeReport(path: string, result: FuneralResult): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(result, null, 2)}\n`);
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(3)}s`;
}

function formatBytes(value: number): string {
  return `${formatCount(value)} bytes (${(value / (1024 * 1024)).toFixed(3)} MiB)`;
}

function formatOptionalBytes(value: number | null | undefined): string {
  return typeof value === "number" ? formatBytes(value) : "not recorded";
}

function markdownPathFor(jsonPath: string): string {
  return jsonPath.toLowerCase().endsWith(".json")
    ? `${jsonPath.slice(0, -".json".length)}.md`
    : `${jsonPath}.md`;
}

function maxRss(report: FuneralResult): number {
  return Math.max(
    report.memory.beforeExport.rss,
    report.memory.afterExport.rss,
    report.memory.afterImport.rss,
    report.memory.afterVerify.rss,
  );
}

function assertReportManifests(report: FuneralResult): void {
  for (const [label, manifest] of [
    ["source", report.source.manifest],
    ["restore", report.restore.manifest],
  ] as const) {
    const expected = canonicalHash({
      schema: manifest.schema,
      headSeq: manifest.headSeq,
      headHash: manifest.headHash,
      tables: manifest.tables,
    });
    if (manifest.schema !== ARCHIVE_MANIFEST_SCHEMA || manifest.digest !== expected) {
      throw new Error(`${label} archive manifest digest is invalid`);
    }
  }
  if (report.source.manifest.digest !== report.restore.manifest.digest) {
    throw new Error("source and restore archive manifest digests differ");
  }
  const coverage = report.receiptCoverage;
  const expectedCoverage = canonicalHash({
    schema: coverage.schema,
    namespaces: coverage.namespaces,
    exercised: coverage.exercised,
    unexercised: coverage.unexercised,
  });
  if (coverage.schema !== RECEIPT_COVERAGE_SCHEMA || coverage.digest !== expectedCoverage) {
    throw new Error("receipt namespace coverage digest is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(report.bundle.sha256)) {
    throw new Error("bundle SHA-256 is invalid");
  }
}

function renderFuneralMarkdown(report: FuneralResult): string {
  if (report.schema !== REPORT_SCHEMA) throw new Error(`unsupported funeral report schema ${report.schema}`);
  if (!report.ok) throw new Error("refusing to render a failed funeral report as PASS evidence");
  assertReportManifests(report);
  const source = report.source;
  const restored = report.restore;
  const bundle = report.bundle;
  const page = report.page;
  const exportProgress = bundle.exportProgress;
  const importProgress = bundle.importProgress;
  const receiptRows = RECEIPT_NAMESPACES.map(
    (namespace) =>
      [
        namespace,
        report.receiptCoverage.namespaces[namespace].source,
        report.receiptCoverage.namespaces[namespace].restore,
      ] as const,
  );
  const tableRows = ARCHIVE_TABLES.map(
    (table) => [table, source.manifest.tables[table].count, restored.manifest.tables[table].count] as const,
  );
  const rssSamples = [
    ["before export", report.memory.beforeExport.rss],
    ["after export", report.memory.afterExport.rss],
    ["after import", report.memory.afterImport.rss],
    ["after verify", report.memory.afterVerify.rss],
  ] as const;
  const pageTarget = page.source.request.seq ?? page.restore.request.seq;
  const pageDescription =
    pageTarget === undefined
      ? `query \`${page.source.request.query ?? page.restore.request.query ?? "not recorded"}\``
      : `turn **#${formatCount(pageTarget)}**`;
  const declaredBound =
    typeof exportProgress.declaredBufferBoundBytes === "number"
      ? formatBytes(exportProgress.declaredBufferBoundBytes)
      : "not recorded";
  const lines = [
    "# Laptop Funeral — PASS",
    "",
    `Schema: \`${report.schema}\` · source and restore both passed full chain verification.`,
    "",
    "## Archive and transport",
    "",
    `- Source episodes: **${formatCount(source.turns)}**; restored episodes: **${formatCount(restored.turns)}**; import reported **${formatCount(restored.import.episodes)}** episodes.`,
    `- Source and restore head: \`${source.headHash}\` (identical).`,
    `- Full verify: source through #${formatCount(source.fullVerify.checkedTo)}; restore through #${formatCount(restored.fullVerify.checkedTo)}.`,
    `- Bundle: **${formatBytes(bundle.bytes)}**.`,
    `- Bundle SHA-256: \`${bundle.sha256}\`.`,
    `- Source manifest: \`${source.manifest.digest}\`; restore manifest: \`${restored.manifest.digest}\` (identical).`,
    `- Timing: export **${formatSeconds(bundle.exportMs)}** · import **${formatSeconds(bundle.importMs)}** · total **${formatSeconds(report.durationMs)}**.`,
    `- Staging telemetry: export max staged **${formatOptionalBytes(exportProgress.max.stagedBytes)}**, import max staged **${formatOptionalBytes(importProgress.max.stagedBytes)}**, max rows **${exportProgress.max.rows === null || importProgress.max.rows === null ? "not recorded" : formatCount(Math.max(exportProgress.max.rows, importProgress.max.rows))}**.`,
    `- Transport buffer: declared bound **${declaredBound}**; export peak **${formatOptionalBytes(exportProgress.max.peakBufferedBytes)}**, import peak **${formatOptionalBytes(importProgress.max.peakBufferedBytes)}**; both stayed within the declared bound.`,
    "",
    "## Transported tables",
    "",
    "| Table | Source count | Restore count |",
    "| --- | ---: | ---: |",
    ...tableRows.map(
      ([name, sourceCount, restoreCount]) =>
        `| ${name} | ${formatCount(sourceCount)} | ${formatCount(restoreCount)} |`,
    ),
    "",
    "## Exact page",
    "",
    `- Requested page: ${pageDescription}.`,
    `- Source and restore page digests equal: **${page.digestEqual === true ? "yes" : "no"}**; byte-exact page: **${page.byteExact === true ? "yes" : "no"}**.`,
    `- Page digest: \`${page.source.digest ?? "not recorded"}\`.`,
    "",
    "## Receipt boundary",
    "",
    "| Namespace | Source count | Restore count |",
    "| --- | ---: | ---: |",
    ...receiptRows.map(
      ([name, sourceCount, restoreCount]) =>
        `| ${name} | ${formatCount(sourceCount)} | ${formatCount(restoreCount)} |`,
    ),
    "",
    `- Exercised namespaces: ${report.receiptCoverage.exercised.length === 0 ? "none" : report.receiptCoverage.exercised.map((namespace) => `\`${namespace}\``).join(", ")}.`,
    `- Unexercised namespaces: ${report.receiptCoverage.unexercised.length === 0 ? "none" : report.receiptCoverage.unexercised.map((namespace) => `\`${namespace}\``).join(", ")}.`,
    "",
    "**Important limitation:** any namespace listed as unexercised has only a matching empty-set transport digest. This artifact does **not** license nonempty Phase 2/4 receipt survival for those namespaces.",
    "",
    "## Memory observations",
    "",
    ...rssSamples.map(([label, value]) => `- RSS snapshot ${label}: **${formatBytes(value)}**.`),
    `- Maximum sampled RSS: **${formatBytes(maxRss(report))}**. RSS snapshots are observations, not an absolute process-memory bound; the transport bound above is the kernel progress contract.`,
    "",
    `Result duration measured by the harness: **${formatSeconds(report.durationMs)}**.`,
    "",
  ];
  return lines.join("\n");
}

async function writeFuneralMarkdown(path: string, report: FuneralResult): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${renderFuneralMarkdown(report)}\n`);
}

async function renderExistingReport(jsonPath: string, markdownPath?: string): Promise<string> {
  const input = resolve(jsonPath);
  const output = resolve(markdownPath ?? markdownPathFor(input));
  if (input === output) throw new Error("render output must differ from the JSON input");
  const report = JSON.parse(readFileSync(input, "utf8")) as FuneralResult;
  await writeFuneralMarkdown(output, report);
  return output;
}

/** Consume the kernel stream into an explicitly named file without collecting chunks. */
async function writeBundleStream(
  path: string,
  stream: ReadableStream<Uint8Array>,
): Promise<{ bytes: number; sha256: string }> {
  const file = await open(path, "w", 0o600);
  const reader = stream.getReader();
  const digest = createHash("sha256");
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new Error("bundle stream yielded a non-byte chunk");
      await file.write(next.value);
      digest.update(next.value);
      total += next.value.byteLength;
    }
    complete = true;
    return { bytes: total, sha256: digest.digest("hex") };
  } finally {
    if (!complete) {
      await reader.cancel("bundle file write failed").catch(() => undefined);
      rmSync(path, { force: true });
    }
    reader.releaseLock();
    await file.close();
  }
}

async function run(options: CliOptions): Promise<FuneralResult> {
  assertOutputOutsideSource(options);
  if (existsSync(options.out)) {
    throw new Error(`funeral report already exists: ${options.out}; choose a unique run output`);
  }
  // Reject an unusable million artifact before any output is staged.
  const millionReference =
    options.millionResult === undefined ? undefined : validateMillionArtifact(options.millionResult);
  mkdirSync(dirname(options.out), { recursive: true });
  mkdirSync(dirname(options.bundle), { recursive: true });
  if (existsSync(options.bundle)) throw new Error(`bundle output already exists: ${options.bundle}`);

  const startedAt = Date.now();
  const sourceVault = openVault({ home: options.home, fast: true });
  const destinationHome = `${options.bundle}.restore-${process.pid}-${Date.now().toString(36)}`;
  let destinationCreated = false;
  let destinationCleaned = false;
  let targetVault: Vault | undefined;
  let fixture: { turns: number; plantedSeq: number; seeded: boolean } | undefined;
  const failures: string[] = [];
  const passphrase = options.passphrase ?? randomPassphrase();
  let report: FuneralResult | undefined;

  try {
    let sourceThread =
      sourceVault.threads.get(options.thread) ?? sourceVault.threads.get(fixtureThreadId(options.thread));
    let plantedSeq: number | undefined;
    if (sourceThread === null && options.turns === undefined) {
      throw new Error(`thread ${options.thread} was not found; provide --turns for fixture mode`);
    }
    if (sourceThread === null) {
      sourceThread = sourceVault.threads.create(
        `funeral fixture · ${options.thread}`,
        { budget: options.budget },
        { id: fixtureThreadId(options.thread), createdAt: FIXTURE_TS_BASE },
      );
      plantedSeq = seedFixture(sourceVault, sourceThread.id, options.turns as number);
      fixture = { turns: options.turns as number, plantedSeq, seeded: true };
    } else if (options.turns !== undefined && sourceThread.headSeq === 0) {
      plantedSeq = seedFixture(sourceVault, sourceThread.id, options.turns);
      fixture = { turns: options.turns, plantedSeq, seeded: true };
    } else if (options.turns !== undefined) {
      fixture = {
        turns: options.turns,
        plantedSeq: Math.max(1, Math.floor(options.turns * 0.73)),
        seeded: false,
      };
    }
    sourceThread = sourceVault.threads.get(sourceThread.id);
    if (sourceThread === null) throw new Error("source thread disappeared during fixture setup");
    if (millionReference !== undefined && millionReference.verifiedHeadHash !== sourceThread.headHash) {
      throw new Error("million artifact final checkpoint head does not match source vault head");
    }
    const sourceVerification = verify(sourceVault, sourceThread.id, { full: true });
    if (!sourceVerification.ok)
      failures.push(`source full verify failed at #${sourceVerification.failedAt ?? 0}`);
    const sourceReceipts = receiptSnapshot(sourceVault, sourceThread.id);

    const requestedPage: { seq?: number; query?: string } =
      options.pageSeq !== undefined
        ? { seq: options.pageSeq }
        : options.pageQuery !== undefined
          ? { query: options.pageQuery }
          : plantedSeq !== undefined
            ? { seq: plantedSeq }
            : {};
    const pageRequested = requestedPage.seq !== undefined || requestedPage.query !== undefined;
    const sourcePage = pageRequested
      ? pageSnapshot(sourceVault, sourceThread.id, requestedPage, options.budget || DEFAULT_PAGE_BUDGET)
      : noPageSnapshot();
    if (pageRequested && sourcePage.exact !== true) failures.push("source page was not byte-exact");

    const exportProgress = new ProgressRecorder();
    const beforeExport = memorySample();
    const exportStarted = performance.now();
    const exportStream = await exportBundleStream(sourceVault, sourceThread.id, {
      passphrase,
      onProgress: exportProgress.observe,
    });
    const sourceManifest = archiveManifestSnapshot(
      sourceVault,
      sourceThread.id,
      sourceThread.headSeq,
      sourceThread.headHash,
    );
    const sourceNamespaceCounts = receiptNamespaceCounts(sourceVault, sourceThread.id);
    const written = await writeBundleStream(options.bundle, exportStream);
    const exportMs = Math.round((performance.now() - exportStarted) * 1000) / 1000;
    const bundleBytes = statSync(options.bundle).size;
    if (written.bytes !== bundleBytes) failures.push("stream writer byte count disagrees with bundle size");
    const afterExport = memorySample();

    if (existsSync(destinationHome))
      throw new Error(`restore destination already exists: ${destinationHome}`);
    mkdirSync(destinationHome, { recursive: true, mode: 0o700 });
    destinationCreated = true;
    if (resolve(destinationHome) === resolve(options.home))
      throw new Error("restore destination equals source home");
    targetVault = openVault({ home: destinationHome, fast: true });
    const importProgress = new ProgressRecorder();
    const importStarted = performance.now();
    const imported = await importBundleStream(targetVault, Bun.file(options.bundle).stream(), {
      passphrase,
      onProgress: importProgress.observe,
    });
    const importMs = Math.round((performance.now() - importStarted) * 1000) / 1000;
    const afterImport = memorySample();
    const restoredThread = targetVault.threads.get(imported.threadId);
    if (restoredThread === null) throw new Error("import returned a thread that was not found");
    const restoredVerification = verify(targetVault, imported.threadId, { full: true });
    const restoredReceipts = receiptSnapshot(targetVault, imported.threadId);
    const restoredManifest = archiveManifestSnapshot(
      targetVault,
      imported.threadId,
      restoredThread.headSeq,
      restoredThread.headHash,
    );
    const restoredNamespaceCounts = receiptNamespaceCounts(targetVault, imported.threadId);
    const namespaceCoverage = receiptNamespaceCoverage(sourceNamespaceCounts, restoredNamespaceCounts);
    const restoredPage = pageRequested
      ? pageSnapshot(targetVault, imported.threadId, requestedPage, options.budget || DEFAULT_PAGE_BUDGET)
      : noPageSnapshot();
    const afterVerify = memorySample();
    const exportProgressSummary = exportProgress.summary();
    const importProgressSummary = importProgress.summary();
    checkProgress("export", exportProgressSummary, failures);
    checkProgress("import", importProgressSummary, failures);
    compareReceipts(sourceReceipts, restoredReceipts, failures);
    compareArchiveManifests(sourceManifest, restoredManifest, failures);
    compareReceiptNamespaceCounts(namespaceCoverage, failures);
    if (sourceThread.headSeq !== restoredThread.headSeq) failures.push("episode count mismatch");
    if (sourceThread.headHash !== restoredThread.headHash) failures.push("head hash mismatch");
    if (imported.headSeq !== sourceThread.headSeq) failures.push("import result episode count mismatch");
    if (imported.headHash !== sourceThread.headHash) failures.push("import result head hash mismatch");
    if (!imported.verified || !restoredVerification.ok) failures.push("restored full verify did not pass");
    if (pageRequested) {
      if (sourcePage.digest !== restoredPage.digest) failures.push("page digest mismatch");
      if (restoredPage.exact !== true) failures.push("restored page was not byte-exact");
    }
    const finishedAt = Date.now();
    report = {
      schema: REPORT_SCHEMA,
      ok: failures.length === 0,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      source: {
        threadId: sourceThread.id,
        turns: sourceThread.headSeq,
        headHash: sourceThread.headHash,
        fullVerify: artifactVerifyResult(sourceVerification),
        receipts: sourceReceipts,
        manifest: sourceManifest,
      },
      restore: {
        threadId: imported.threadId,
        turns: restoredThread.headSeq,
        headHash: restoredThread.headHash,
        import: {
          episodes: imported.episodes,
          verified: imported.verified,
          headSeq: imported.headSeq,
          headHash: imported.headHash,
        },
        fullVerify: artifactVerifyResult(restoredVerification),
        receipts: restoredReceipts,
        manifest: restoredManifest,
      },
      bundle: {
        bytes: bundleBytes,
        sha256: written.sha256,
        exportMs,
        importMs,
        exportProgress: exportProgressSummary,
        importProgress: importProgressSummary,
      },
      receiptCoverage: namespaceCoverage,
      page: {
        source: sourcePage,
        restore: restoredPage,
        digestEqual: pageRequested ? sourcePage.digest === restoredPage.digest : null,
        byteExact: pageRequested ? sourcePage.exact === true && restoredPage.exact === true : null,
      },
      memory: {
        beforeExport,
        afterExport,
        afterImport,
        afterVerify,
        deltas: {
          export: memoryDelta(beforeExport, afterExport),
          import: memoryDelta(afterExport, afterImport),
          verify: memoryDelta(afterImport, afterVerify),
        },
      },
      passphrase: options.passphrase === undefined ? "generated" : "provided",
      ...(fixture === undefined ? {} : { fixture }),
      destinationCleaned: false,
      failures,
    };
    return report;
  } finally {
    targetVault?.close();
    sourceVault.close();
    if (destinationCreated && !options.keepDestination) {
      rmSync(destinationHome, { recursive: true, force: true });
      destinationCleaned = true;
    }
    if (destinationCreated && options.keepDestination) {
      process.stderr.write(`kept restore destination ${destinationHome}\n`);
    }
    if (report !== undefined) report.destinationCleaned = destinationCleaned;
  }
}

/** Flags only; non-flag tokens are ignored, so `pylos bench funeral …` forwards its whole argv. */
export async function runFuneralCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help === true || args.h === true) {
    printUsage();
    return 0;
  }
  const existing = args["render-existing"];
  if (existing !== undefined) {
    if (typeof existing !== "string") {
      process.stderr.write("--render-existing needs a JSON report path\n");
      return 2;
    }
    const markdownArg = args["markdown-out"];
    if (markdownArg !== undefined && typeof markdownArg !== "string") {
      process.stderr.write("--markdown-out needs a path\n");
      return 2;
    }
    try {
      const markdownPath = await renderExistingReport(existing, markdownArg as string | undefined);
      process.stdout.write(`rendered funeral Markdown ${markdownPath}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
    return 0;
  }
  let options: CliOptions;
  try {
    options = parseOptions(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    printUsage();
    return 2;
  }
  let result: FuneralResult | null = null;
  try {
    result = await run(options);
  } catch (error) {
    const finishedAt = Date.now();
    const message = artifactDiagnostic(error instanceof Error ? error.message : String(error));
    result = {
      schema: REPORT_SCHEMA,
      ok: false,
      startedAt: finishedAt,
      finishedAt,
      durationMs: 0,
      source: {
        threadId: "",
        turns: 0,
        headHash: "",
        fullVerify: { ok: false, headHash: "", checkedTo: 0, checkedFrom: 0, reason: message },
        receipts: {
          packets: { count: 0, digest: canonicalHash([]), sample: [] },
          answerReceipts: { count: 0, digest: canonicalHash([]), sample: [] },
          coverageReceipts: { count: 0, digest: canonicalHash([]), sample: [] },
          addresses: { count: 0, digest: canonicalHash([]), sample: [] },
          aliases: { count: 0, digest: canonicalHash([]) },
        },
        manifest: emptyArchiveManifest(),
      },
      restore: {
        threadId: "",
        turns: 0,
        headHash: "",
        import: { episodes: 0, verified: false, headSeq: 0, headHash: "" },
        fullVerify: { ok: false, headHash: "", checkedTo: 0, checkedFrom: 0, reason: message },
        receipts: {
          packets: { count: 0, digest: canonicalHash([]), sample: [] },
          answerReceipts: { count: 0, digest: canonicalHash([]), sample: [] },
          coverageReceipts: { count: 0, digest: canonicalHash([]), sample: [] },
          addresses: { count: 0, digest: canonicalHash([]), sample: [] },
          aliases: { count: 0, digest: canonicalHash([]) },
        },
        manifest: emptyArchiveManifest(),
      },
      bundle: {
        bytes: existsSync(options.bundle) ? statSync(options.bundle).size : 0,
        sha256: "",
        exportMs: 0,
        importMs: 0,
        exportProgress: {
          eventCount: 0,
          phases: [],
          final: null,
          declaredBufferBoundBytes: DECLARED_BUFFER_BOUND,
          withinDeclaredBufferBound: false,
          max: {
            bytes: null,
            stagedBytes: null,
            rows: null,
            entries: null,
            bufferedBytes: null,
            peakBufferedBytes: null,
          },
        },
        importProgress: {
          eventCount: 0,
          phases: [],
          final: null,
          declaredBufferBoundBytes: DECLARED_BUFFER_BOUND,
          withinDeclaredBufferBound: false,
          max: {
            bytes: null,
            stagedBytes: null,
            rows: null,
            entries: null,
            bufferedBytes: null,
            peakBufferedBytes: null,
          },
        },
      },
      receiptCoverage: emptyReceiptCoverage(),
      page: { source: noPageSnapshot(), restore: noPageSnapshot(), digestEqual: null, byteExact: null },
      memory: {
        beforeExport: memorySample(),
        afterExport: memorySample(),
        afterImport: memorySample(),
        afterVerify: memorySample(),
        deltas: {
          export: { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
          import: { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
          verify: { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
        },
      },
      passphrase: options.passphrase === undefined ? "generated" : "provided",
      destinationCleaned: false,
      failures: [message],
    };
  }
  try {
    await writeReport(options.out, result);
    if (result.ok) await writeFuneralMarkdown(markdownPathFor(options.out), result);
  } catch (error) {
    process.stderr.write(
      `could not write funeral evidence: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  process.stdout.write(
    `laptop funeral ${result.ok ? "ok" : "FAILED"} · ${result.source.turns} turns · ${result.bundle.bytes} bundle bytes · report ${options.out}${result.ok ? ` · markdown ${markdownPathFor(options.out)}` : ""}\n`,
  );
  if (!result.ok) {
    process.stderr.write(`${result.failures.map((failure) => `- ${failure}`).join("\n")}\n`);
    return 2;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await runFuneralCli(process.argv.slice(2));
