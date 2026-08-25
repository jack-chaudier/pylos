/**
 * Export / import — the `.pylos` bundle (KERNEL §7, A7).
 *
 * One file: AES-256-GCM over a v2 framed archive of
 * `{manifest.json, episodes.jsonl, atoms.jsonl, capsules.jsonl, loss.jsonl,
 * packets.jsonl, tombstones.jsonl, atomization-receipts.jsonl, objects/*}`,
 * keyed from a passphrase with
 * PBKDF2-SHA256 ≥ 600k (WebCrypto). The v1 ZIP container remains readable for
 * existing archives and is available through the explicit legacy writer.
 *
 * The ciphertext is written in 1 MiB chunks with a per-chunk nonce
 * (`base ‖ counter`) and the cleartext header as AAD. New v2 streams stage
 * JSONL members and object spans on disk, then emit a framed archive through the
 * authenticated envelope without constructing the archive in memory. The byte
 * API remains a compatibility wrapper with the explicitly bounded whole-result
 * cost its return type promises; v1 ZIP bundles remain readable.
 *
 * Never contains credentials. `import` verifies the hash chain before accepting
 * and refuses on mismatch; it also recomputes `dropped()` on a sample of
 * capsules and refuses if the ledger does not agree with the episodes.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  type Atom,
  type AttachmentManifest,
  CAPSULE_FANOUT,
  type Capsule,
  type Episode,
  LEAF_CAPSULE_EPISODES,
  type LossEntry,
  MAX_THREAD_ID_BYTES,
  MAX_THREAD_MODEL_BYTES,
  MAX_THREAD_SETTINGS_BYTES,
  MAX_THREAD_TITLE_BYTES,
  type Seq,
} from "@pylos/protocol";
import { addressRouteRowBoundsFailure } from "./address.ts";
import { manifestPartitionValid } from "./attachment.ts";
import {
  createBlobPromotion,
  createImportStage,
  discardBlobPromotion,
  discardImportStage,
  stageBlobBytesForPromotion,
  stageBlobForPromotion,
} from "./blob-pending.ts";
import {
  BUNDLE_DERIVED_LIMITS,
  type BundleDerivedRowKind,
  bundleAddressAliasFailure,
  bundleAtomizationReceiptFailure,
  bundleDerivedRowFailure,
  bundleEpisodeFailure,
  bundleJsonObjectFailure,
  bundlePacketFailure,
} from "./bundle-derived.ts";
import { ROOT_LEVEL, rederiveCapsuleLedger, sourceNamesForRangeStream } from "./compact.ts";
import { canonicalHash, chainHash, genesisHash, sha256 } from "./hash.ts";
import { budgetSharesFailure } from "./pure/budget.ts";
import { canonicalJson } from "./pure/canonical.ts";
import { capsuleSourceContentFailure } from "./pure/ledger.ts";
import { names } from "./pure/names.ts";
import { type AtomDraft, applyRules } from "./pure/rules.ts";
import {
  type AtomRow,
  type CapsuleRow,
  type EpisodeRow,
  type ThreadRow,
  toAtom,
  toCapsule,
  toEpisode,
  toThread,
} from "./rows.ts";
import { COUNTERS } from "./schema.ts";
import { chainRecord, metaHashOf, type StoredCapsule, type Vault, VaultError } from "./vault.ts";
import { verify } from "./verify.ts";
import { crc32Update, unzip, zip } from "./zip.ts";

/** File magic and format version. */
export const BUNDLE_MAGIC = "PYLOS1\n";
const CHUNK_SIZE = 1024 * 1024;
const PBKDF2_ITERATIONS = 600_000;
const MAX_MANIFEST_BYTES = BUNDLE_DERIVED_LIMITS.manifestBytes;
const MAX_ADDRESS_ALIAS_LINE_BYTES = BUNDLE_DERIVED_LIMITS.addressAliasRowBytes + 1;
const COMPATIBILITY_MAX_BYTES = 64 * 1024 * 1024;
/** Raw imports may be large, but a source that produces no bytes for this long
 * is not making progress and must not retain plaintext staging indefinitely. */
export const BUNDLE_READ_INACTIVITY_MS = 5_000;
/** Million-turn imports remain finite even when a source keeps producing tiny
 * chunks just before each inactivity deadline. */
export const BUNDLE_TRANSFER_DEADLINE_MS = 30 * 60_000;

/** Defensive bounds for untrusted bundle streams. They are deliberately large
 * enough for a million-turn archive, while keeping framing/decompression
 * mistakes from turning an import into an unbounded allocation. */
export interface BundleLimits {
  maxBundleBytes: number;
  maxHeaderBytes: number;
  maxFrames: number;
  maxFrameBytes: number;
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxLineBytes: number;
}

export type BundleProgressPhase =
  | "staging"
  | "encrypting"
  | "decrypting"
  | "extracting"
  | "installing"
  | "loading"
  | "done";

/** Kernel-computed transport telemetry; it is diagnostic, never an import receipt. */
export interface BundleProgress {
  phase: BundleProgressPhase;
  bytes: number;
  /** Bytes staged on disk for the current bundle/archive. */
  stagedBytes: number;
  /** Rows observed while staging/loading JSONL members. */
  rows: number;
  entries: number;
  /** Current bounded transport/frame buffers; excludes staged files, parser
   * strings/metadata, and any chunk retained by an upstream caller. */
  bufferedBytes: number;
  /** Conservative transport-buffer bound, not total process RSS. */
  peakBufferedBytes: number;
}

export const BUNDLE_LIMITS: BundleLimits = {
  maxBundleBytes: 8 * 1024 * 1024 * 1024,
  maxHeaderBytes: 64 * 1024,
  maxFrames: 2_000_000,
  maxFrameBytes: 16 * 1024 * 1024,
  maxArchiveBytes: 8 * 1024 * 1024 * 1024,
  maxEntries: 100_000,
  maxEntryBytes: 1 * 1024 * 1024 * 1024,
  maxLineBytes: 16 * 1024 * 1024,
};

/** v1 is a whole-ZIP compatibility format. Keep its streamed reader bounded
 * to the byte-sized compatibility contract even when callers raise the v2
 * limits for a full-scale framed archive. */
function legacyCompatibilityLimits(limits: BundleLimits): BundleLimits {
  return {
    ...limits,
    maxBundleBytes: Math.min(limits.maxBundleBytes, COMPATIBILITY_MAX_BYTES),
    maxArchiveBytes: Math.min(limits.maxArchiveBytes, COMPATIBILITY_MAX_BYTES),
    maxEntryBytes: Math.min(limits.maxEntryBytes, COMPATIBILITY_MAX_BYTES),
    maxEntries: Math.min(limits.maxEntries, 65_535),
    maxFrameBytes: Math.min(limits.maxFrameBytes, CHUNK_SIZE + 16),
  };
}

export interface BundleHeader {
  v: 1 | 2;
  kdf: "pbkdf2-sha256";
  iters: number;
  /** base64 salt. */
  salt: string;
  /** base64 nonce prefix; per-chunk nonce is `base ‖ uint32le(counter)`. */
  nonce: string;
  threadId: string;
  headSeq: number;
  headHash: string;
  partial?: { from: Seq; to: Seq; prevHash: string };
}

export interface BundleManifest {
  schema: "pylos.bundle.v1" | "pylos.bundle.v2";
  threadId: string;
  title: string;
  createdAt: number;
  exportedAt: number;
  headSeq: number;
  headHash: string;
  counts: { episodes: number; atoms: number; capsules: number; loss: number; packets: number };
  partial: boolean;
  files: Record<string, string>;
  /** Bounded thread configuration; absent in historical bundles. */
  settings?: Record<string, unknown>;
  /** Added in the witnessed-continuity format; optional for v1 readers. */
  countsExtended?: {
    addressRoutes: number;
    addressAliases: number;
    tombstones?: number;
    atomizationReceipts?: number;
    capsuleLedgerEntries?: number;
  };
}

export interface ExportOptions {
  passphrase: string;
  /** Inclusive seq range for a partial export. */
  range?: [Seq, Seq];
  /** Include full packet `messages` (off by default; they are large). */
  includePacketMessages?: boolean;
  onProgress?: (progress: BundleProgress) => void;
}

export interface ImportOptions {
  passphrase: string;
  /** Install a partial fragment under this local id. Full bundles retain their
   * authenticated thread id because capsule/address identities are bound to it. */
  threadId?: string;
  /** Number of capsules whose ledger is recomputed from episodes. Default 8. */
  sampleCapsules?: number;
  /** Override import limits for trusted local tooling only. */
  limits?: Partial<BundleLimits>;
  onProgress?: (progress: BundleProgress) => void;
  /** Absolute raw-stream transfer deadline. Defaults to 30 minutes. Primarily
   * configurable for trusted tooling and deterministic fault oracles. */
  transferDeadlineMs?: number;
}

function derivedRowLineLimit(kind: BundleDerivedRowKind, limits: BundleLimits): number {
  const rowLimit =
    kind === "atom"
      ? BUNDLE_DERIVED_LIMITS.atomRowBytes
      : kind === "capsule"
        ? BUNDLE_DERIVED_LIMITS.capsuleRowBytes
        : kind === "loss"
          ? BUNDLE_DERIVED_LIMITS.lossRowBytes
          : BUNDLE_DERIVED_LIMITS.capsuleLedgerRowBytes;
  return Math.min(limits.maxLineBytes, rowLimit);
}

function assertBundleDerivedRow(
  kind: BundleDerivedRowKind,
  row: unknown,
  direction: "import" | "export",
): void {
  const failure = bundleDerivedRowFailure(kind, row);
  if (failure !== null) throw new VaultError(`invalid ${kind} bundle row on ${direction}: ${failure}`);
}

function assertBundleAddressAlias(
  row: unknown,
  expectedThreadId: string,
  direction: "import" | "export",
): void {
  const failure = bundleAddressAliasFailure(row, expectedThreadId);
  if (failure !== null) throw new VaultError(`invalid address alias on ${direction}: ${failure}`);
}

function assertBundleAtomizationReceipt(
  vault: Vault,
  row: unknown,
  expectedThreadId: string,
  direction: "import" | "export",
  sourceThreadId = expectedThreadId,
): void {
  const failure = bundleAtomizationReceiptFailure(row, expectedThreadId);
  if (failure !== null) throw new VaultError(`invalid atomization receipt on ${direction}: ${failure}`);
  const receipt = row as { source_seq: number; source_hash: string };
  const source = vault.db
    .query("SELECT hash FROM episode WHERE thread_id = ? AND seq = ? LIMIT 1")
    .get(sourceThreadId, receipt.source_seq) as { hash: string } | null;
  if (source === null || source.hash !== receipt.source_hash) {
    throw new VaultError(`invalid atomization receipt on ${direction}: source revision is not retained`);
  }
}

function assertBundlePacket(row: unknown, expectedThreadId: string, direction: "import" | "export"): void {
  const failure = bundlePacketFailure(row, expectedThreadId);
  if (failure !== null) throw new VaultError(`invalid packet bundle row on ${direction}: ${failure}`);
}

/** Cross-row invariants that individual JSON shape checks cannot establish. */
function assertImportedDerivedTopology(vault: Vault, threadId: string, headSeq: Seq): void {
  const duplicateCurrent = vault.db
    .query(
      "SELECT key, phase FROM atom WHERE thread_id = ? AND phase IN ('SUPPORTED', 'PROPOSED') " +
        "GROUP BY key, phase HAVING COUNT(*) > 1 LIMIT 1",
    )
    .get(threadId) as { key: string; phase: string } | null;
  if (duplicateCurrent !== null) {
    throw new VaultError(
      `invalid atom bundle topology: multiple ${duplicateCurrent.phase} rows for one current key`,
    );
  }
  const overfullParent = vault.db
    .query(
      "SELECT p.id FROM capsule p JOIN capsule c ON c.thread_id = p.thread_id AND c.level = p.level - 1 " +
        "AND c.from_seq >= p.from_seq AND c.to_seq <= p.to_seq " +
        "WHERE p.thread_id = ? GROUP BY p.id HAVING COUNT(c.id) > ? LIMIT 1",
    )
    .get(threadId, CAPSULE_FANOUT) as { id: string } | null;
  if (overfullParent !== null) {
    throw new VaultError(`invalid capsule bundle topology: parent exceeds ${CAPSULE_FANOUT} direct children`);
  }
  assertImportedCapsuleTopology(vault, threadId, headSeq);
  assertImportedCapsuleLedgerReceipts(vault, threadId);
  assertImportedAtomAuthority(vault, threadId);
}

function assertImportedCapsuleLedgerReceipts(vault: Vault, threadId: string): void {
  const orphan = vault.db
    .query(
      "SELECT e.capsule_id FROM capsule_ledger_entry e LEFT JOIN capsule c ON c.id = e.capsule_id " +
        "WHERE e.thread_id = ? AND (c.id IS NULL OR c.thread_id != ?) LIMIT 1",
    )
    .get(threadId, threadId) as { capsule_id: string } | null;
  if (orphan !== null) throw new VaultError(`capsule ledger entry has no capsule ${orphan.capsule_id}`);
  const outside = vault.db
    .query(
      "SELECT e.capsule_id FROM capsule_ledger_entry e JOIN capsule c ON c.id = e.capsule_id " +
        "WHERE e.thread_id = ? AND (e.seq < c.from_seq OR e.seq > c.to_seq) LIMIT 1",
    )
    .get(threadId) as { capsule_id: string } | null;
  if (outside !== null) throw new VaultError(`capsule ledger entry points outside ${outside.capsule_id}`);
  const missingLoss = vault.db
    .query(
      "SELECT e.capsule_id FROM capsule_ledger_entry e WHERE e.thread_id = ? AND e.part = 'dropped' " +
        "AND NOT EXISTS (SELECT 1 FROM loss l WHERE l.thread_id = e.thread_id AND l.name = e.name " +
        "AND l.kind = e.kind AND l.seq = e.seq AND COALESCE(l.span, '') = COALESCE(e.span, '')) " +
        "LIMIT 1",
    )
    .get(threadId) as { capsule_id: string } | null;
  if (missingLoss !== null) {
    throw new VaultError(`capsule ledger omission has no exact loss row for ${missingLoss.capsule_id}`);
  }

  const rows = vault.db
    .query("SELECT * FROM capsule WHERE thread_id = ? ORDER BY level ASC, from_seq ASC")
    .iterate(threadId) as Iterable<CapsuleRow>;
  for (const row of rows) {
    const capsule = toCapsule(row);
    const receipt = capsule.ledgerReceipt;
    const entryCount = (
      vault.db
        .query("SELECT COUNT(*) AS n FROM capsule_ledger_entry WHERE capsule_id = ?")
        .get(capsule.id) as { n: number }
    ).n;
    if (receipt === undefined) {
      if (entryCount !== 0) throw new VaultError(`legacy capsule ${capsule.id} has continuation rows`);
      continue;
    }
    for (const part of ["dropped", "kept"] as const) {
      const embedded = capsule[part];
      const expected = receipt[part];
      const hash = createHash("sha256");
      let count = 0;
      for (const entryRow of vault.db
        .query(
          "SELECT ordinal, name, kind, seq, span FROM capsule_ledger_entry " +
            "WHERE capsule_id = ? AND part = ? ORDER BY ordinal ASC",
        )
        .iterate(capsule.id, part) as Iterable<{
        ordinal: number;
        name: string;
        kind: LossEntry["kind"];
        seq: number;
        span: string | null;
      }>) {
        if (entryRow.ordinal !== count)
          throw new VaultError(`capsule ${capsule.id} has a ledger ordinal gap`);
        const entry: LossEntry = {
          name: entryRow.name,
          kind: entryRow.kind,
          seq: entryRow.seq,
          ...(entryRow.span === null ? {} : { span: JSON.parse(entryRow.span) as [number, number] }),
        };
        hash.update(`${canonicalJson(entry)}\n`, "utf8");
        if (count < embedded.length && canonicalJson(entry) !== canonicalJson(embedded[count])) {
          throw new VaultError(`capsule ${capsule.id} ${part} preview disagrees with continuation`);
        }
        count += 1;
      }
      if (
        count !== expected.count ||
        count < expected.embeddedCount ||
        embedded.length !== expected.embeddedCount
      ) {
        throw new VaultError(`capsule ${capsule.id} ${part} receipt count mismatch`);
      }
      if (hash.digest("hex") !== expected.digest) {
        throw new VaultError(`capsule ${capsule.id} ${part} receipt digest mismatch`);
      }
      if (!expected.complete) {
        let cursor: Record<string, unknown>;
        try {
          cursor = JSON.parse(Buffer.from(expected.cursor ?? "", "base64url").toString("utf8")) as Record<
            string,
            unknown
          >;
        } catch {
          throw new VaultError(`capsule ${capsule.id} ${part} receipt cursor is invalid`);
        }
        if (
          cursor.version !== 1 ||
          cursor.capsuleId !== capsule.id ||
          cursor.capsuleHash !== capsule.hash ||
          cursor.part !== part ||
          cursor.after !== expected.embeddedCount - 1
        ) {
          throw new VaultError(`capsule ${capsule.id} ${part} receipt cursor mismatch`);
        }
      }
    }
    const visible = new Set(names(capsule.text, { max: 4097 }).map((hit) => hit.name));
    if (visible.size > 4096) throw new VaultError(`capsule ${capsule.id} has too many visible names`);
    const invisibleKept = vault.db
      .query(
        "SELECT name FROM capsule_ledger_entry WHERE capsule_id = ? AND part = 'kept' ORDER BY ordinal ASC",
      )
      .iterate(capsule.id) as Iterable<{ name: string }>;
    for (const entry of invisibleKept) {
      if (!visible.has(entry.name)) {
        throw new VaultError(`capsule ${capsule.id} kept receipt names absent text`);
      }
    }
    // Rebuild the exact source vocabulary in SQLite. The same newest-locator
    // UPSERT as compaction keeps this pass external-memory and authenticates
    // every locator field, not only attacker-controlled sidecar names.
    const clearStage = vault.db.query("DELETE FROM capsule_ledger_stage WHERE capsule_id = ?");
    const stageSource = vault.db.query(
      "INSERT INTO capsule_ledger_stage (capsule_id, name, kind, seq, span, kept) " +
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(capsule_id, name) DO UPDATE SET " +
        "kind = excluded.kind, seq = excluded.seq, span = excluded.span, kept = excluded.kept " +
        "WHERE excluded.seq >= capsule_ledger_stage.seq",
    );
    const addSource = (entry: LossEntry): void => {
      stageSource.run(
        capsule.id,
        entry.name,
        entry.kind,
        entry.seq,
        entry.span === undefined ? null : canonicalJson(entry.span),
        visible.has(entry.name) ? 1 : 0,
      );
    };
    clearStage.run(capsule.id);
    try {
      if (capsule.level === 0) {
        for (const source of sourceNamesForRangeStream(vault, threadId, capsule.fromSeq, capsule.toSeq))
          addSource(source);
      } else {
        const sourceLevel = capsule.level === BUNDLE_ROOT_LEVEL ? 0 : capsule.level - 1;
        const childKept = vault.db
          .query(
            "SELECT e.name, e.kind, e.seq, e.span FROM capsule c " +
              "JOIN capsule_ledger_entry e ON e.capsule_id = c.id " +
              "WHERE c.thread_id = ? AND c.level = ? AND c.from_seq >= ? AND c.to_seq <= ? " +
              "AND e.part = 'kept' ORDER BY c.from_seq ASC, e.ordinal ASC",
          )
          .iterate(threadId, sourceLevel, capsule.fromSeq, capsule.toSeq) as Iterable<{
          name: string;
          kind: LossEntry["kind"];
          seq: number;
          span: string | null;
        }>;
        for (const entry of childKept) {
          addSource({
            name: entry.name,
            kind: entry.kind,
            seq: entry.seq,
            ...(entry.span === null ? {} : { span: JSON.parse(entry.span) as [number, number] }),
          });
        }
      }

      const mismatch = vault.db
        .query(
          "SELECT s.name FROM capsule_ledger_stage s LEFT JOIN capsule_ledger_entry e " +
            "ON e.capsule_id = s.capsule_id AND e.name = s.name " +
            "WHERE s.capsule_id = ? AND (e.name IS NULL OR e.kind != s.kind OR e.seq != s.seq " +
            "OR COALESCE(e.span, '') != COALESCE(s.span, '') " +
            "OR e.part != CASE s.kept WHEN 1 THEN 'kept' ELSE 'dropped' END) LIMIT 1",
        )
        .get(capsule.id) as { name: string } | null;
      if (mismatch !== null) {
        throw new VaultError(`capsule ${capsule.id} receipt mismatches source locator ${mismatch.name}`);
      }
      const fabricated = vault.db
        .query(
          "SELECT e.name FROM capsule_ledger_entry e LEFT JOIN capsule_ledger_stage s " +
            "ON s.capsule_id = e.capsule_id AND s.name = e.name " +
            "WHERE e.capsule_id = ? AND s.name IS NULL LIMIT 1",
        )
        .get(capsule.id) as { name: string } | null;
      if (fabricated !== null) {
        throw new VaultError(`capsule ${capsule.id} receipt fabricates source locator ${fabricated.name}`);
      }
    } finally {
      clearStage.run(capsule.id);
    }
  }
}

const BUNDLE_ROOT_LEVEL = 99;

/**
 * A capsule is a kernel-computed projection, not arbitrary archive prose.  Do
 * this metadata/hash pass before the ledger sampler can ask for its episode
 * range: otherwise one forged leaf can turn an eight-row sample into a huge
 * materialization.
 */
function assertImportedCapsuleTopology(vault: Vault, threadId: string, headSeq: Seq): void {
  let roots = 0;
  const rows = vault.db
    .query(
      "SELECT id, level, from_seq, to_seq, text, hash FROM capsule " +
        "WHERE thread_id = ? ORDER BY level ASC, from_seq ASC, rowid ASC",
    )
    .iterate(threadId) as Iterable<{
    id: string;
    level: number;
    from_seq: number;
    to_seq: number;
    text: string;
    hash: string;
  }>;
  for (const row of rows) {
    if (row.to_seq > headSeq) {
      throw new VaultError(`invalid capsule bundle topology: ${row.id} exceeds the thread head`);
    }
    if (
      row.hash !== canonicalHash({ level: row.level, from: row.from_seq, to: row.to_seq, text: row.text })
    ) {
      throw new VaultError(`invalid capsule bundle topology: ${row.id} has a noncanonical hash`);
    }
    if (row.level === BUNDLE_ROOT_LEVEL) {
      roots += 1;
      if (
        roots > 1 ||
        row.id !== `root:${threadId}` ||
        row.from_seq !== 1 ||
        row.to_seq % LEAF_CAPSULE_EPISODES !== 0
      ) {
        throw new VaultError(`invalid capsule bundle topology: ${row.id} is not the canonical rolling root`);
      }
      continue;
    }
    if (row.level < 0 || row.level >= BUNDLE_ROOT_LEVEL) {
      throw new VaultError(`invalid capsule bundle topology: ${row.id} has an unsupported level`);
    }
    const span = LEAF_CAPSULE_EPISODES * CAPSULE_FANOUT ** row.level;
    if (
      !Number.isSafeInteger(span) ||
      (row.from_seq - 1) % span !== 0 ||
      row.to_seq !== row.from_seq + span - 1 ||
      row.id !== `cap:${threadId}:${row.level}:${row.from_seq}`
    ) {
      throw new VaultError(`invalid capsule bundle topology: ${row.id} has noncanonical geometry`);
    }
  }

  const incompleteParent = vault.db
    .query(
      "SELECT p.id FROM capsule p WHERE p.thread_id = ? AND p.level BETWEEN 1 AND 98 " +
        "AND (SELECT COUNT(*) FROM capsule c WHERE c.thread_id = p.thread_id " +
        "AND c.level = p.level - 1 AND c.from_seq >= p.from_seq AND c.to_seq <= p.to_seq) != ? LIMIT 1",
    )
    .get(threadId, CAPSULE_FANOUT) as { id: string } | null;
  if (incompleteParent !== null) {
    throw new VaultError(
      `invalid capsule bundle topology: ${incompleteParent.id} does not bind ${CAPSULE_FANOUT} exact children`,
    );
  }
  const incompleteRoot = vault.db
    .query(
      "SELECT r.id FROM capsule r WHERE r.thread_id = ? AND r.level = 99 " +
        "AND (SELECT COUNT(*) FROM capsule c WHERE c.thread_id = r.thread_id AND c.level = 0 " +
        "AND c.from_seq >= r.from_seq AND c.to_seq <= r.to_seq) != (r.to_seq / ?) LIMIT 1",
    )
    .get(threadId, LEAF_CAPSULE_EPISODES) as { id: string } | null;
  if (incompleteRoot !== null) {
    throw new VaultError(
      `invalid capsule bundle topology: ${incompleteRoot.id} has an incomplete leaf cover`,
    );
  }
}

function normalizedAtomValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function ruleDraftBindingKey(input: {
  text: string;
  span: readonly [number, number];
  value: string;
  createdBy: string;
  confidence: number;
}): string {
  return canonicalJson([
    input.text,
    input.span[0],
    input.span[1],
    normalizedAtomValue(input.value),
    input.createdBy,
    input.confidence,
  ]);
}

/** An encrypted bundle authenticates bytes, not the authority of derived facts. */
function assertImportedAtomAuthority(vault: Vault, threadId: string): void {
  const rows = vault.db
    .query("SELECT a.* FROM atom a WHERE a.thread_id = ? ORDER BY a.source_seq ASC, a.rowid ASC")
    .iterate(threadId) as Iterable<Record<string, unknown>>;
  const sourceEpisode = vault.db.query(
    "SELECT content, role, meta FROM episode WHERE thread_id = ? AND seq = ? LIMIT 1",
  );
  const successor = vault.db.query(
    "SELECT key, kind, value, valid_from_seq FROM atom WHERE thread_id = ? AND id = ? LIMIT 1",
  );
  const predecessor = vault.db.query(
    "SELECT key, kind, value FROM atom WHERE thread_id = ? AND superseded_by = ? " +
      "ORDER BY valid_from_seq DESC LIMIT 1",
  );
  let cachedSourceSeq = -1;
  let cachedContent = "";
  let cachedRole = "";
  let cachedRemoved = false;
  let cachedDrafts = new Map<string, AtomDraft[]>();
  for (const row of rows) {
    const id = String(row.id ?? "");
    const sourceSeq = Number(row.source_seq);
    if (sourceSeq !== cachedSourceSeq) {
      const source = sourceEpisode.get(threadId, sourceSeq) as {
        content: string;
        role: string;
        meta: string;
      } | null;
      if (source === null) {
        throw new VaultError(`invalid atom bundle authority: ${id} has no exact source episode`);
      }
      let meta: Record<string, unknown>;
      try {
        const parsed = JSON.parse(source.meta) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
        meta = parsed as Record<string, unknown>;
      } catch {
        throw new VaultError(`invalid atom bundle authority: ${id} has malformed source metadata`);
      }
      cachedSourceSeq = sourceSeq;
      cachedContent = source.content;
      cachedRole = source.role;
      cachedRemoved = meta.removed === true;
      cachedDrafts = new Map<string, AtomDraft[]>();
      for (const draft of applyRules(source.content, source.role as Episode["role"])) {
        const key = ruleDraftBindingKey({
          text: draft.text,
          span: draft.span,
          value: draft.value,
          createdBy: `rule:${draft.rule}`,
          confidence: draft.confidence,
        });
        const grouped = cachedDrafts.get(key);
        if (grouped === undefined) cachedDrafts.set(key, [draft]);
        else grouped.push(draft);
      }
    }
    if (row.phase === "REVOKED") {
      // Forget keeps the derived row as an immutable, non-authoritative audit
      // record after replacing the source bytes. It can no longer establish a
      // fact, so source-text replay is neither possible nor necessary.
      if (row.valid_from_seq !== row.source_seq || row.scope !== "global") {
        throw new VaultError(`invalid atom bundle authority: ${id} has a noncanonical source interval`);
      }
      continue;
    }
    if (cachedRemoved) {
      throw new VaultError(`invalid atom bundle authority: ${id} cites removed material`);
    }
    if (row.valid_from_seq !== row.source_seq || row.scope !== "global") {
      throw new VaultError(`invalid atom bundle authority: ${id} has a noncanonical source interval`);
    }
    let span: [number, number];
    try {
      const parsed = JSON.parse(String(row.source_span)) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        !Number.isSafeInteger(parsed[0]) ||
        !Number.isSafeInteger(parsed[1])
      ) {
        throw new Error("shape");
      }
      span = [parsed[0] as number, parsed[1] as number];
    } catch {
      throw new VaultError(`invalid atom bundle authority: ${id} has no exact source span`);
    }
    if (span[0] < 0 || span[1] <= span[0] || span[1] > cachedContent.length) {
      throw new VaultError(`invalid atom bundle authority: ${id} has an out-of-range source span`);
    }
    const authority = row.authority;
    const phase = row.phase;
    if (authority === "model") {
      if (
        !String(row.created_by).startsWith("model:") ||
        (phase !== "PROPOSED" && phase !== "HISTORICAL") ||
        span[1] - span[0] < 3
      ) {
        throw new VaultError(`invalid atom bundle authority: ${id} is not a bounded proposal`);
      }
    } else {
      const expectedAuthority = cachedRole === "assistant" ? "assistant" : "user";
      if (
        authority !== expectedAuthority ||
        (expectedAuthority === "user"
          ? phase !== "SUPPORTED" && phase !== "HISTORICAL"
          : phase !== "PROPOSED" && phase !== "HISTORICAL")
      ) {
        throw new VaultError(`invalid atom bundle authority: ${id} exceeds its source role`);
      }
      const draftKey = ruleDraftBindingKey({
        text: String(row.text),
        span,
        value: String(row.value),
        createdBy: String(row.created_by),
        confidence: Number(row.confidence),
      });
      const matched = (cachedDrafts.get(draftKey) ?? []).some((draft) => {
        if (draft.supersedesValue === undefined) return row.key === draft.key && row.kind === draft.kind;
        const prior = predecessor.get(threadId, id) as { key: string; kind: string; value: string } | null;
        return (
          prior !== null &&
          prior.key === row.key &&
          prior.kind === row.kind &&
          normalizedAtomValue(prior.value) === normalizedAtomValue(draft.supersedesValue)
        );
      });
      if (!matched) throw new VaultError(`invalid atom bundle authority: ${id} is not a kernel rule result`);
    }
    if (phase === "HISTORICAL") {
      if (typeof row.superseded_by !== "string" || !Number.isSafeInteger(row.valid_to_seq)) {
        throw new VaultError(`invalid atom bundle authority: ${id} has no successor binding`);
      }
      const next = successor.get(threadId, row.superseded_by) as {
        key: string;
        kind: string;
        value: string;
        valid_from_seq: number;
      } | null;
      if (
        next === null ||
        next.key !== row.key ||
        next.kind !== row.kind ||
        next.valid_from_seq !== row.valid_to_seq ||
        (authority === "user" && normalizedAtomValue(next.value) === normalizedAtomValue(String(row.value)))
      ) {
        throw new VaultError(`invalid atom bundle authority: ${id} has an invalid successor`);
      }
    } else if (row.valid_to_seq !== null || row.superseded_by !== null) {
      throw new VaultError(`invalid atom bundle authority: ${id} has an unexpected successor`);
    }
  }
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BUNDLE_HASH = /^[0-9a-f]{64}$/;

function manifestInteger(value: unknown, minimum = 0): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validBundleThreadId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BUNDLE_ID.test(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_THREAD_ID_BYTES
  );
}

function exportRange(thread: { headSeq: number }, requested?: [Seq, Seq]): [Seq, Seq] {
  if (requested === undefined) return [1, thread.headSeq];
  const [from, to] = requested;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 1 ||
    to < from ||
    to > thread.headSeq
  ) {
    throw new VaultError("bundle export range is outside the authenticated thread head");
  }
  return [from, to];
}

function assertFragmentExportRange(
  fragment: { fromSeq: Seq; toSeq: Seq } | null,
  requested: [Seq, Seq] | undefined,
  from: Seq,
  to: Seq,
): void {
  if (fragment === null) return;
  if (requested === undefined) {
    throw new VaultError("authenticated fragments cannot be exported as full threads");
  }
  if (from < fragment.fromSeq || to > fragment.toSeq) {
    throw new VaultError(`fragment export range must stay within #${fragment.fromSeq}-#${fragment.toSeq}`);
  }
}

function settingsFailure(value: unknown): string | null {
  const structural = bundleJsonObjectFailure(value, MAX_THREAD_SETTINGS_BYTES, "settings");
  if (structural !== null) return structural;
  const settings = value as Record<string, unknown>;
  if (
    settings.budget !== undefined &&
    (!manifestInteger(settings.budget, 1) || (settings.budget as number) > 1_000_000)
  ) {
    return "settings.budget is outside its integer bounds";
  }
  if (
    settings.model !== undefined &&
    (typeof settings.model !== "string" || Buffer.byteLength(settings.model, "utf8") > MAX_THREAD_MODEL_BYTES)
  ) {
    return "settings.model exceeds its string bounds";
  }
  if (settings.shares !== undefined) {
    const failure = budgetSharesFailure(settings.shares);
    if (failure !== null) return `settings.${failure}`;
  }
  for (const field of ["capsuleTokens"] as const) {
    const group = settings[field];
    if (group === undefined) continue;
    if (group === null || typeof group !== "object" || Array.isArray(group))
      return `settings.${field} is invalid`;
    for (const entry of Object.values(group as Record<string, unknown>)) {
      if (!manifestInteger(entry, 0) || (entry as number) > 1_000_000) {
        return "settings.capsuleTokens contains an invalid count";
      }
    }
  }
  return null;
}

function validateBundleManifest(
  value: unknown,
  header: BundleHeader,
  version: 1 | 2,
): asserts value is BundleManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError("bundle manifest has an unsupported shape");
  }
  const manifest = value as Partial<BundleManifest>;
  if (
    manifest.schema !== `pylos.bundle.v${version}` ||
    !validBundleThreadId(manifest.threadId) ||
    typeof manifest.title !== "string" ||
    Buffer.byteLength(manifest.title, "utf8") > MAX_THREAD_TITLE_BYTES ||
    !manifestInteger(manifest.createdAt) ||
    !manifestInteger(manifest.exportedAt) ||
    !manifestInteger(manifest.headSeq) ||
    typeof manifest.headHash !== "string" ||
    !BUNDLE_HASH.test(manifest.headHash) ||
    typeof manifest.partial !== "boolean" ||
    manifest.files === null ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    manifest.counts === null ||
    typeof manifest.counts !== "object"
  ) {
    throw new VaultError("bundle manifest has an unsupported shape");
  }
  for (const field of ["episodes", "atoms", "capsules", "loss", "packets"] as const) {
    if (!manifestInteger(manifest.counts[field])) {
      throw new VaultError(`bundle manifest has an invalid ${field} count`);
    }
  }
  if (manifest.countsExtended !== undefined) {
    if (
      manifest.countsExtended === null ||
      typeof manifest.countsExtended !== "object" ||
      !manifestInteger(manifest.countsExtended.addressRoutes) ||
      !manifestInteger(manifest.countsExtended.addressAliases) ||
      (manifest.countsExtended.tombstones !== undefined &&
        !manifestInteger(manifest.countsExtended.tombstones)) ||
      (manifest.countsExtended.atomizationReceipts !== undefined &&
        !manifestInteger(manifest.countsExtended.atomizationReceipts)) ||
      (manifest.countsExtended.capsuleLedgerEntries !== undefined &&
        !manifestInteger(manifest.countsExtended.capsuleLedgerEntries))
    ) {
      throw new VaultError("bundle manifest has invalid extended counts");
    }
  }
  if (
    version === 1 &&
    (manifest.countsExtended?.atomizationReceipts !== undefined ||
      Object.hasOwn(manifest.files, "atomization-receipts.jsonl"))
  ) {
    throw new VaultError("legacy v1 bundle cannot carry atomization receipts; use v2");
  }
  if (
    version === 1 &&
    (manifest.countsExtended?.capsuleLedgerEntries !== undefined ||
      Object.hasOwn(manifest.files, "capsule-ledger-entries.jsonl"))
  ) {
    throw new VaultError("legacy v1 bundle cannot carry capsule ledger continuations; use v2");
  }
  if (manifest.settings !== undefined) {
    const failure = settingsFailure(manifest.settings);
    if (failure !== null) throw new VaultError(`bundle manifest has invalid ${failure}`);
  }
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!isSafeBundleName(name) || typeof digest !== "string" || !BUNDLE_HASH.test(digest)) {
      throw new VaultError("bundle manifest has an invalid file binding");
    }
  }
  if (
    header.v !== version ||
    header.threadId !== manifest.threadId ||
    header.headSeq !== manifest.headSeq ||
    header.headHash !== manifest.headHash ||
    (header.partial !== undefined) !== manifest.partial
  ) {
    throw new VaultError("bundle header and manifest bindings disagree");
  }
  const expectedEpisodes =
    header.partial === undefined ? header.headSeq : header.partial.to - header.partial.from + 1;
  if (manifest.counts.episodes !== expectedEpisodes) {
    throw new VaultError("bundle manifest episode count does not match its declared range");
  }
}

// ------------------------------------------------------------------ crypto

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function chunkNonce(base: Uint8Array, counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(base.subarray(0, 8), 0);
  new DataView(nonce.buffer).setUint32(8, counter, true);
  return nonce;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function unb64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

function validateBundleHeader(value: unknown): asserts value is BundleHeader {
  if (value === null || typeof value !== "object")
    throw new VaultError("bundle header has an unsupported shape");
  const header = value as Partial<BundleHeader>;
  if (header.v !== 1 && header.v !== 2)
    throw new VaultError(`unsupported bundle version ${String(header.v)}`);
  if (header.kdf !== "pbkdf2-sha256" || header.iters !== PBKDF2_ITERATIONS) {
    throw new VaultError("unsupported bundle key derivation parameters");
  }
  if (typeof header.salt !== "string" || typeof header.nonce !== "string") {
    throw new VaultError("bundle header is missing its crypto parameters");
  }
  let salt: Uint8Array;
  let nonce: Uint8Array;
  try {
    salt = unb64(header.salt);
    nonce = unb64(header.nonce);
  } catch {
    throw new VaultError("bundle header has invalid crypto parameters");
  }
  if (salt.byteLength !== 16 || nonce.byteLength !== 8) {
    throw new VaultError("bundle header has invalid crypto parameter lengths");
  }
  if (
    !validBundleThreadId(header.threadId) ||
    !manifestInteger(header.headSeq) ||
    typeof header.headHash !== "string" ||
    !BUNDLE_HASH.test(header.headHash)
  ) {
    throw new VaultError("bundle header has invalid archive bindings");
  }
  if (header.partial !== undefined) {
    if (
      !manifestInteger(header.partial.from, 1) ||
      !manifestInteger(header.partial.to, 1) ||
      header.partial.to < header.partial.from ||
      header.partial.to !== header.headSeq ||
      typeof header.partial.prevHash !== "string" ||
      !BUNDLE_HASH.test(header.partial.prevHash)
    ) {
      throw new VaultError("bundle header has invalid partial range bindings");
    }
  }
}

function assertImportThreadOverride(header: BundleHeader, requestedThreadId: string | undefined): void {
  if (requestedThreadId === undefined) return;
  if (!validBundleThreadId(requestedThreadId)) {
    throw new VaultError("bundle import destination thread id is invalid");
  }
  if (header.partial === undefined) {
    throw new VaultError("full bundle thread id cannot be overridden; import it under its authenticated id");
  }
}

// ------------------------------------------------------------------ export

/**
 * Compatibility byte API. New callers should use the stream form; this wrapper
 * deliberately materializes only because its return type promises one byte
 * array. The emitted container is v2, while importBundle still accepts v1.
 */
export async function exportBundle(
  vault: Vault,
  threadId: string,
  options: ExportOptions,
): Promise<Uint8Array> {
  const stream = await exportBundleStream(vault, threadId, options);
  return collectReadable(stream);
}

const LEGACY_PREFLIGHT_RESERVE = 256 * 1024;

interface LegacyMaterializationBudget {
  readonly bytes: number;
  consume(size: number): void;
}

function legacyMaterializationBudget(): LegacyMaterializationBudget {
  let bytes = 0;
  return {
    get bytes() {
      return bytes;
    },
    consume(size: number) {
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new VaultError("legacy bundle compatibility preflight found an invalid byte size");
      }
      if (bytes + size > COMPATIBILITY_MAX_BYTES - LEGACY_PREFLIGHT_RESERVE) {
        throw new VaultError("legacy bundle compatibility preflight exceeds the byte limit");
      }
      bytes += size;
    },
  };
}

function legacyExportPreflight(vault: Vault, threadId: string, from: Seq, to: Seq): Set<string> {
  let estimated = LEGACY_PREFLIGHT_RESERVE;
  const maxRawRow = Math.floor((COMPATIBILITY_MAX_BYTES - LEGACY_PREFLIGHT_RESERVE) / 6);
  const measure = (expression: string, table: string, where: string, ...bindings: unknown[]): void => {
    const row = vault.db
      .query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(${expression}), 0) AS bytes, ` +
          `COALESCE(MAX(${expression}), 0) AS max_row FROM ${table} WHERE ${where}`,
      )
      .get(...(bindings as never[])) as { count: number; bytes: number; max_row: number };
    const bytes = Number(row.bytes);
    const count = Number(row.count);
    const maximum = Number(row.max_row);
    if (![bytes, count, maximum].every(Number.isSafeInteger) || maximum > maxRawRow) {
      throw new VaultError("legacy bundle compatibility preflight found an oversized row");
    }
    estimated += bytes + count * 128;
    if (!Number.isSafeInteger(estimated) || estimated > COMPATIBILITY_MAX_BYTES) {
      throw new VaultError("legacy bundle compatibility preflight exceeds the byte limit");
    }
  };

  measure(
    "length(CAST(content AS BLOB)) + length(CAST(meta AS BLOB)) + length(content_hash) + " +
      "length(prev_hash) + length(hash) + length(role) + length(COALESCE(model, '')) + " +
      "length(COALESCE(provider, ''))",
    "episode",
    "thread_id = ? AND seq BETWEEN ? AND ?",
    threadId,
    from,
    to,
  );
  measure(
    "length(id) + length(kind) + length(key) + length(value) + length(text) + " +
      "length(COALESCE(source_span, '')) + length(scope) + length(created_by) + length(authority)",
    "atom",
    "thread_id = ? AND source_seq BETWEEN ? AND ?",
    threadId,
    from,
    to,
  );
  measure(
    "length(id) + length(text) + length(dropped) + length(kept) + length(hash) + length(created_by)",
    "capsule",
    "thread_id = ? AND to_seq <= ?",
    threadId,
    to,
  );
  measure(
    "length(capsule_id) + length(name) + length(kind) + length(COALESCE(span, ''))",
    "loss",
    "thread_id = ? AND seq BETWEEN ? AND ?",
    threadId,
    from,
    to,
  );
  measure(
    "length(id) + length(model) + length(digest) + length(status) + length(compiler_version) + " +
      "length(COALESCE(messages, '')) + length(resident) + length(ledger) + length(pages) + " +
      "length(COALESCE(rounds, '')) + length(COALESCE(reachability, '')) + length(COALESCE(coverage, '')) + " +
      "length(COALESCE(evidence, '')) + length(COALESCE(answer_receipt, '')) + " +
      "length(COALESCE(semantic, ''))",
    "packet",
    "thread_id = ? AND turn_seq BETWEEN ? AND ?",
    threadId,
    from,
    to,
  );
  measure(
    "length(id) + length(COALESCE(target, '')) + length(COALESCE(reason, '')) + " +
      "length(COALESCE(echoes, ''))",
    "tombstone",
    "thread_id = ?",
    threadId,
  );
  measure(
    "length(id) + length(query_digest) + length(normalized_query) + length(router_version) + " +
      "length(packet_id) + length(packet_digest) + length(source_seqs) + length(witnesses) + " +
      "length(route_digest) + length(status) + length(COALESCE(reason, '')) + " +
      "length(COALESCE(invalidated_by, ''))",
    "address_route",
    "thread_id = ? AND question_seq BETWEEN ? AND ?",
    threadId,
    from,
    to,
  );
  measure(
    "length(id) + length(alias) + length(source_hash) + length(quote_hash) + length(authority) + length(status)",
    "address_alias",
    "thread_id = ? AND source_seq BETWEEN ? AND ?",
    threadId,
    from,
    to,
  );

  const reachable = new Set<string>();
  const addObject = (hash: unknown): void => {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new VaultError("legacy bundle compatibility preflight found an invalid object hash");
    }
    if (reachable.has(hash)) return;
    if (reachable.size >= BUNDLE_LIMITS.maxEntries)
      throw new VaultError("legacy bundle has too many object entries");
    const row = vault.db.query("SELECT size FROM blob WHERE hash = ?").get(hash) as { size: number } | null;
    const path = join(vault.objectsDir, hash);
    if (row === null || !existsSync(path)) {
      throw new VaultError(`legacy bundle reachable object ${hash} is missing`);
    }
    const size = Number(row.size);
    const link = lstatSync(path);
    const fileSize = statSync(path).size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !link.isFile() ||
      link.isSymbolicLink() ||
      fileSize !== size
    ) {
      throw new VaultError(`legacy bundle reachable object ${hash} has an invalid size`);
    }
    estimated += size + 256;
    if (!Number.isSafeInteger(estimated) || estimated > COMPATIBILITY_MAX_BYTES) {
      throw new VaultError("legacy bundle compatibility preflight exceeds the byte limit");
    }
    reachable.add(hash);
  };
  const rows = vault.db
    .query("SELECT meta FROM episode WHERE thread_id = ? AND seq BETWEEN ? AND ? ORDER BY seq")
    .iterate(threadId, from, to) as Iterable<{ meta: string }>;
  for (const row of rows) {
    let meta: Episode["meta"];
    try {
      meta = JSON.parse(row.meta) as Episode["meta"];
    } catch {
      throw new VaultError("legacy bundle compatibility preflight found invalid episode metadata");
    }
    if (meta.removed === true) continue;
    if (meta.blob !== undefined) addObject(meta.blob);
    for (const span of meta.manifest?.spans ?? []) addObject(span.objectHash);
  }
  return reachable;
}

function assertLegacyAddressCompatibility(vault: Vault, threadId: string, from: number, to: number): void {
  const row = vault.db
    .query(
      `SELECT
        EXISTS(
          SELECT 1 FROM address_route
          WHERE thread_id = ? AND question_seq BETWEEN ? AND ?
          LIMIT 1
        ) AS has_routes,
        EXISTS(
          SELECT 1 FROM address_alias
          WHERE thread_id = ? AND source_seq BETWEEN ? AND ?
          LIMIT 1
        ) AS has_aliases`,
    )
    .get(threadId, from, to, threadId, from, to) as { has_routes: number; has_aliases: number };
  if (row.has_routes !== 0 || row.has_aliases !== 0) {
    throw new VaultError(
      "legacy v1 export cannot preserve witnessed-continuity address routes or aliases for historical readers; use v2",
    );
  }
}

function assertLegacyPacketCompatibility(vault: Vault, threadId: string, from: number, to: number): void {
  const row = vault.db
    .query(
      "SELECT 1 FROM packet WHERE thread_id = ? AND turn_seq BETWEEN ? AND ? AND (" +
        "reachability IS NOT NULL OR reachability_as_of_seq IS NOT NULL OR coverage IS NOT NULL OR " +
        "evidence IS NOT NULL OR answer_receipt IS NOT NULL OR semantic IS NOT NULL) LIMIT 1",
    )
    .get(threadId, from, to);
  if (row !== null) {
    throw new VaultError(
      "legacy v1 export cannot preserve reachability, coverage, evidence, answer receipts, or semantic receipts; use v2",
    );
  }
}

function assertLegacyAtomizationCompatibility(vault: Vault, threadId: string): void {
  const row = vault.db.query("SELECT 1 FROM atomization_receipt WHERE thread_id = ? LIMIT 1").get(threadId);
  if (row !== null) {
    throw new VaultError("legacy v1 export cannot preserve atomization receipts; use v2");
  }
}

function assertLegacyCapsuleLedgerCompatibility(vault: Vault, threadId: string): void {
  const row = vault.db
    .query(
      "SELECT 1 FROM capsule WHERE thread_id = ? AND ledger_receipt IS NOT NULL AND (" +
        "json_valid(ledger_receipt) != 1 OR json_extract(ledger_receipt, '$.dropped.complete') != 1 OR " +
        "json_extract(ledger_receipt, '$.kept.complete') != 1 OR " +
        "json_extract(ledger_receipt, '$.dropped.count') != json_array_length(dropped) OR " +
        "json_extract(ledger_receipt, '$.kept.count') != json_array_length(kept)) LIMIT 1",
    )
    .get(threadId);
  if (row !== null) {
    throw new VaultError("legacy v1 export cannot preserve capsule ledger continuations; use v2");
  }
}

/** Explicit legacy v1 writer retained for fixture/old-profile compatibility. */
export async function exportBundleV1(
  vault: Vault,
  threadId: string,
  options: ExportOptions,
): Promise<Uint8Array> {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
  const threadSettingsFailure = settingsFailure(thread.settings);
  if (threadSettingsFailure !== null) {
    throw new VaultError(`invalid thread settings on bundle export: ${threadSettingsFailure}`);
  }
  const [from, to] = exportRange(thread, options.range);
  const fragment = vault.fragments.get(threadId);
  assertFragmentExportRange(fragment, options.range, from, to);
  const bundleThreadId = fragment?.originalThreadId ?? threadId;
  const partial = from !== 1 || to !== thread.headSeq;
  // Historical v1 readers ignore files they do not understand. Refuse before
  // preflight or materialization when this range contains A15 address state,
  // because emitting those rows would make a successful legacy restore look
  // complete while silently discarding witnessed continuity.
  if (!partial) {
    assertLegacyAddressCompatibility(vault, threadId, from, to);
    assertLegacyPacketCompatibility(vault, threadId, from, to);
    assertLegacyAtomizationCompatibility(vault, threadId);
    assertLegacyCapsuleLedgerCompatibility(vault, threadId);
  }
  const reachable = legacyExportPreflight(vault, threadId, from, to);
  const materialized = legacyMaterializationBudget();

  // The chain is verified over `content_hash`, so the export carries it; removed
  // content never leaves the machine (KERNEL §8) but its hash still does.
  const episodes = vault.episodes.range(threadId, from, to).map((episode) => {
    const row = vault.db
      .query("SELECT content_hash FROM episode WHERE thread_id = ? AND seq = ?")
      .get(threadId, episode.seq) as { content_hash: string };
    const exported = {
      ...episode,
      threadId: bundleThreadId,
      contentHash: row.content_hash,
      ...(episode.meta.removed === true ? { content: `⟦removed by user⟧` } : {}),
    };
    const failure = bundleEpisodeFailure(exported);
    if (failure !== null) throw new VaultError(`invalid episode bundle row on export: ${failure}`);
    return exported;
  });
  const atoms = partial
    ? []
    : (vault.db
        .query("SELECT * FROM atom WHERE thread_id = ? AND source_seq BETWEEN ? AND ?")
        .all(threadId, from, to) as unknown[]);
  const capsules = partial
    ? []
    : (
        vault.db
          .query(
            "SELECT * FROM capsule WHERE thread_id = ? AND from_seq >= ? AND to_seq <= ? " +
              "ORDER BY level DESC, from_seq ASC",
          )
          .all(threadId, from, to) as CapsuleRow[]
      ).map((row) => {
        const { ledgerReceipt: _receipt, ...legacy } = toCapsule(row);
        return legacy;
      });
  const loss = partial
    ? []
    : (vault.db
        .query("SELECT * FROM loss WHERE thread_id = ? AND seq BETWEEN ? AND ?")
        .all(threadId, from, to) as unknown[]);
  const packets = partial
    ? []
    : (vault.db
        .query(
          `SELECT id, thread_id, turn_seq, model, budget, tokens, digest, status, compiler_version, ${
            options.includePacketMessages === true ? "messages" : "NULL AS messages"
          }, resident, ledger, pages, rounds,
        created_at FROM packet WHERE thread_id = ? AND turn_seq BETWEEN ? AND ?`,
        )
        .all(threadId, from, to) as unknown[]);
  for (const row of packets) assertBundlePacket(row, threadId, "export");
  const tombstones = partial
    ? []
    : (vault.db.query("SELECT * FROM tombstone WHERE thread_id = ?").all(threadId) as unknown[]);
  const addressRoutes = partial
    ? []
    : (vault.db
        .query("SELECT * FROM address_route WHERE thread_id = ? AND question_seq BETWEEN ? AND ?")
        .all(threadId, from, to) as unknown[]);
  for (const row of addressRoutes) {
    const routeFailure = addressRouteRowBoundsFailure(row);
    if (routeFailure !== null) throw new VaultError(`invalid address route export: ${routeFailure}`);
  }
  const addressAliases = partial
    ? []
    : (vault.db
        .query("SELECT * FROM address_alias WHERE thread_id = ? AND source_seq BETWEEN ? AND ?")
        .all(threadId, from, to) as unknown[]);
  for (const row of addressAliases) assertBundleAddressAlias(row, threadId, "export");
  for (const row of atoms) assertBundleDerivedRow("atom", row, "export");
  for (const row of capsules) assertBundleDerivedRow("capsule", row, "export");
  for (const row of loss) assertBundleDerivedRow("loss", row, "export");

  const files: Array<{ name: string; data: Uint8Array }> = [
    { name: "episodes.jsonl", data: jsonl(episodes, materialized) },
    { name: "atoms.jsonl", data: jsonl(atoms, materialized) },
    { name: "capsules.jsonl", data: jsonl(capsules, materialized) },
    { name: "loss.jsonl", data: jsonl(loss, materialized) },
    { name: "packets.jsonl", data: jsonl(packets, materialized) },
    { name: "tombstones.jsonl", data: jsonl(tombstones, materialized) },
    { name: "address-routes.jsonl", data: jsonl(addressRoutes, materialized) },
    { name: "address-aliases.jsonl", data: jsonl(addressAliases, materialized) },
  ];
  // Reachability, not the whole store (KERNEL A10.7): a bundle carries the
  // attachments its own episodes reach, so exporting one thread never ships
  // another's, and a partial export ships only what its range reaches.
  for (const hash of reachable) {
    const bytes = vault.blobs.get(hash);
    if (bytes === null || sha256(bytes) !== hash) {
      throw new VaultError(`legacy bundle reachable object ${hash} is missing or corrupt`);
    }
    materialized.consume(bytes.byteLength);
    files.push({ name: `objects/${hash}`, data: bytes });
  }

  const manifest: BundleManifest = {
    schema: "pylos.bundle.v1",
    threadId: bundleThreadId,
    title: thread.title,
    createdAt: thread.createdAt,
    exportedAt: Date.now(),
    headSeq: to,
    headHash: (episodes.at(-1)?.hash ?? thread.headHash) as string,
    counts: {
      episodes: episodes.length,
      atoms: atoms.length,
      capsules: capsules.length,
      loss: loss.length,
      packets: packets.length,
    },
    countsExtended: {
      addressRoutes: addressRoutes.length,
      addressAliases: addressAliases.length,
      tombstones: tombstones.length,
    },
    partial,
    files: Object.fromEntries(files.map((f) => [f.name, sha256(f.data)])),
    settings: thread.settings,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  materialized.consume(manifestBytes.byteLength);
  const archiveEntries = [{ name: "manifest.json", data: manifestBytes }, ...files];
  const zipOverhead =
    22 + archiveEntries.reduce((sum, entry) => sum + 76 + 2 * Buffer.byteLength(entry.name), 0);
  if (materialized.bytes + zipOverhead > COMPATIBILITY_MAX_BYTES) {
    throw new VaultError("legacy bundle compatibility preflight exceeds the byte limit");
  }
  const archive = zip(archiveEntries);
  if (archive.byteLength > COMPATIBILITY_MAX_BYTES) {
    throw new VaultError("legacy bundle compatibility preflight exceeds the byte limit");
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonceBase = crypto.getRandomValues(new Uint8Array(8));
  const header: BundleHeader = {
    v: 1,
    kdf: "pbkdf2-sha256",
    iters: PBKDF2_ITERATIONS,
    salt: b64(salt),
    nonce: b64(nonceBase),
    threadId: bundleThreadId,
    headSeq: to,
    headHash: manifest.headHash,
    ...(partial
      ? {
          partial: {
            from,
            to,
            prevHash: (episodes[0]?.prevHash ?? thread.headHash) as string,
          },
        }
      : {}),
  };
  const headerBytes = new TextEncoder().encode(canonicalJson(header));
  if (headerBytes.byteLength > BUNDLE_LIMITS.maxHeaderBytes) {
    throw new VaultError("bundle header exceeds the header byte limit");
  }
  const key = await deriveKey(options.passphrase, salt);

  const parts: Uint8Array[] = [];
  const magic = new TextEncoder().encode(BUNDLE_MAGIC);
  const headerLength = new Uint8Array(4);
  new DataView(headerLength.buffer).setUint32(0, headerBytes.length, true);
  parts.push(magic, headerLength, headerBytes);

  let counter = 0;
  for (let offset = 0; offset < archive.length; offset += CHUNK_SIZE) {
    const slice = archive.subarray(offset, Math.min(offset + CHUNK_SIZE, archive.length));
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: chunkNonce(nonceBase, counter) as BufferSource,
          additionalData: headerBytes as BufferSource,
        },
        key,
        slice as BufferSource,
      ),
    );
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, cipher.length, true);
    parts.push(length, cipher);
    counter += 1;
  }
  const terminator = new Uint8Array(4);
  new DataView(terminator.buffer).setUint32(0, 0, true);
  parts.push(terminator);
  const result = concat(parts);
  if (result.byteLength > COMPATIBILITY_MAX_BYTES) {
    throw new VaultError("legacy bundle exceeds the compatibility byte limit; use a stream export");
  }
  return result;
}

/**
 * Stream an encrypted v2 bundle in bounded chunks. The legacy byte API remains
 * the compatibility boundary; callers that may hold a million-turn archive
 * should consume this stream directly so the envelope is never duplicated by
 * the transport layer. JSONL members and object spans are staged individually;
 * encryption and transport are frame-streamed and each emitted chunk is about
 * 1 MiB or smaller.
 */
export async function exportBundleStream(
  vault: Vault,
  threadId: string,
  options: ExportOptions,
): Promise<ReadableStream<Uint8Array>> {
  const staged = await stageBundle(vault, threadId, options);
  const stream = asyncGeneratorStream(encryptedBundle(staged, options.passphrase), () => {
    rmSync(staged.dir, { recursive: true, force: true });
  });
  return stream;
}

interface StagedEntry {
  name: string;
  path: string;
  size: number;
  digest: string;
  crc: number;
  rowCount?: number;
}

interface DecryptedBundle extends StagedEntry {
  version: 1 | 2;
  header: BundleHeader;
}

interface StagedBundle {
  dir: string;
  threadId: string;
  title: string;
  createdAt: number;
  headSeq: number;
  headHash: string;
  firstPrevHash: string;
  from: Seq;
  to: Seq;
  partial: boolean;
  entries: StagedEntry[];
  stagedBytes: number;
  rows: number;
  onProgress?: (progress: BundleProgress) => void;
}

const STAGE_WRITE_SIZE = 64 * 1024;
const STREAM_FILE_CHUNK = 64 * 1024;
// The largest live transport buffers are one bounded ciphertext frame, its
// plaintext, the v2 encryption frame, and the small staging/file copies.
// This intentionally excludes parser strings, manifest metadata, and an
// arbitrary chunk retained by an upstream caller.
export const BUNDLE_TRANSPORT_BUFFER_BOUND =
  2 * BUNDLE_LIMITS.maxFrameBytes + 2 * CHUNK_SIZE + 2 * STAGE_WRITE_SIZE + STREAM_FILE_CHUNK + 128;
const utf8 = new TextEncoder();

function reportProgress(
  callback: ((progress: BundleProgress) => void) | undefined,
  phase: BundleProgressPhase,
  bytes: number,
  entries: number,
  bufferedBytes: number,
  stagedBytes = bytes,
  rows = 0,
): void {
  callback?.({
    phase,
    bytes,
    stagedBytes,
    rows,
    entries,
    bufferedBytes,
    peakBufferedBytes: BUNDLE_TRANSPORT_BUFFER_BOUND,
  });
}

/** Once SQLite and object promotion commit, progress is observation only. An
 * observer failure cannot retroactively turn an installed import into a failed
 * operation whose retry would collide with its own durable thread. */
function reportCommittedProgress(
  callback: ((progress: BundleProgress) => void) | undefined,
  phase: BundleProgressPhase,
  bytes: number,
  entries: number,
  bufferedBytes: number,
  stagedBytes = bytes,
  rows = 0,
): void {
  try {
    reportProgress(callback, phase, bytes, entries, bufferedBytes, stagedBytes, rows);
  } catch {
    // Telemetry is deliberately non-authoritative after commit.
  }
}

function injectLegacyStagedBlobFault(): void {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.PYLOS_TEST_BUNDLE_IMPORT_FAULT === "kill-after-v1-blob-stage-before-commit"
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}

class StageWriter {
  private readonly hash = createHash("sha256");
  private crc = 0xffffffff;
  private size = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly file: Awaited<ReturnType<typeof open>>,
  ) {}

  static async create(path: string): Promise<StageWriter> {
    return new StageWriter(path, await open(path, "w", 0o600));
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("stage writer is closed");
    if (bytes.byteLength === 0) return;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(STAGE_WRITE_SIZE - this.pendingBytes, bytes.byteLength - offset);
      const slice = bytes.subarray(offset, offset + take);
      const body = Buffer.from(slice);
      this.hash.update(body);
      this.crc = crc32Update(this.crc, slice);
      this.size += take;
      this.pending.push(body);
      this.pendingBytes += take;
      offset += take;
      if (this.pendingBytes >= STAGE_WRITE_SIZE) await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.pendingBytes === 0) return;
    const body = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    let offset = 0;
    while (offset < body.byteLength) {
      const result = await this.file.write(body.subarray(offset));
      if (result.bytesWritten <= 0) throw new VaultError("bundle stage made no write progress");
      offset += result.bytesWritten;
    }
  }

  async finish(): Promise<StagedEntry> {
    if (this.closed) throw new Error("stage writer is closed");
    await this.flush();
    await this.file.close();
    this.closed = true;
    return {
      name: "",
      path: this.path,
      size: this.size,
      digest: this.hash.digest("hex"),
      crc: (this.crc ^ 0xffffffff) >>> 0,
    };
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.file.close().catch(() => undefined);
  }
}

async function stageRows<T>(
  dir: string,
  name: string,
  rows: Iterable<T>,
  transform: (row: T) => unknown = (row) => row,
): Promise<StagedEntry> {
  const writer = await StageWriter.create(join(dir, name.replaceAll("/", "_")));
  let rowCount = 0;
  try {
    for (const row of rows) {
      const line = utf8.encode(`${JSON.stringify(transform(row))}\n`);
      if (line.byteLength > BUNDLE_LIMITS.maxLineBytes) {
        throw new VaultError(`bundle JSONL line exceeds the line byte limit for ${name}`);
      }
      await writer.write(line);
      rowCount += 1;
    }
    const entry = await writer.finish();
    return { ...entry, name, rowCount };
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

async function stageBytes(dir: string, name: string, bytes: Uint8Array): Promise<StagedEntry> {
  const writer = await StageWriter.create(join(dir, name.replaceAll("/", "_")));
  try {
    await writer.write(bytes);
    const entry = await writer.finish();
    return { ...entry, name };
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

async function stageFile(
  dir: string,
  name: string,
  source: string,
  expectedDigest?: string,
): Promise<StagedEntry> {
  const writer = await StageWriter.create(join(dir, name.replaceAll("/", "_")));
  try {
    const reader = Bun.file(source).stream().getReader();
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > BUNDLE_LIMITS.maxEntryBytes) {
          throw new VaultError(`bundle entry ${name} exceeds its byte limit`);
        }
        await writer.write(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const entry = { ...(await writer.finish()), name };
    if (expectedDigest !== undefined && entry.digest !== expectedDigest) {
      throw new VaultError(`object ${name} failed its content hash`);
    }
    return entry;
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

const BUNDLE_ROW_BATCH = 1024;

interface StagedEpisodes {
  entry: StagedEntry;
  count: number;
  headHash: string;
  firstPrevHash: string;
}

async function stageEpisodes(
  snapshot: Database,
  dir: string,
  objectsDir: string,
  reachableTable: string,
  threadId: string,
  exportThreadId: string,
  from: Seq,
  to: Seq,
  defaultHeadHash: string,
  objectEntries: StagedEntry[],
): Promise<StagedEpisodes> {
  // Keyset pages close before the next page and before any temp-table write.
  // The read connection's transaction keeps every page on one SQLite WAL
  // snapshot while object spans are copied at their first observation.
  const writer = await StageWriter.create(join(dir, "episodes.jsonl"));
  let count = 0;
  let cursor = from - 1;
  let headHash = defaultHeadHash;
  let firstPrevHash = defaultHeadHash;
  const episodeQuery = snapshot.query(
    "SELECT seq, thread_id, ts, role, model, provider, content, content_hash, tokens, prev_hash, hash, meta " +
      "FROM episode WHERE thread_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?",
  );
  const stageObject = async (hash: string): Promise<void> => {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new VaultError(`invalid attachment object hash ${hash}`);
    snapshot.query(`INSERT OR IGNORE INTO ${reachableTable} (hash) VALUES (?)`).run(hash);
    const state = snapshot.query(`SELECT staged FROM ${reachableTable} WHERE hash = ?`).get(hash) as
      | { staged: number }
      | undefined;
    if (state?.staged === 1) return;
    const source = join(objectsDir, hash);
    if (!existsSync(source)) throw new VaultError(`attachment object ${hash} is missing`);
    const entry = await stageFile(dir, `objects/${hash}`, source, hash);
    objectEntries.push(entry);
    if (objectEntries.length + 9 > BUNDLE_LIMITS.maxEntries) {
      throw new VaultError("bundle has too many entries");
    }
    snapshot
      .query(
        `UPDATE ${reachableTable} SET staged = 1, path = ?, size = ?, digest = ?, crc = ? WHERE hash = ?`,
      )
      .run(entry.path, entry.size, entry.digest, entry.crc, hash);
  };
  try {
    for (;;) {
      const rows = episodeQuery.all(threadId, cursor, to, BUNDLE_ROW_BATCH) as EpisodeRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const episode = toEpisode(row);
        if (count === 0) firstPrevHash = episode.prevHash;
        count += 1;
        cursor = episode.seq;
        headHash = episode.hash;
        if (episode.meta.removed !== true) {
          if (typeof episode.meta.blob === "string") await stageObject(episode.meta.blob);
          for (const span of episode.meta.manifest?.spans ?? []) {
            if (typeof span.objectHash === "string") await stageObject(span.objectHash);
          }
        }
        const exported = {
          ...episode,
          threadId: exportThreadId,
          contentHash: row.content_hash,
          ...(episode.meta.removed === true ? { content: "⟦removed by user⟧" } : {}),
        };
        const failure = bundleEpisodeFailure(exported);
        if (failure !== null) throw new VaultError(`invalid episode bundle row on export: ${failure}`);
        const line = utf8.encode(`${JSON.stringify(exported)}\n`);
        if (line.byteLength > BUNDLE_LIMITS.maxLineBytes) {
          throw new VaultError("bundle JSONL line exceeds the line byte limit for episodes.jsonl");
        }
        await writer.write(line);
      }
      if (rows.length < BUNDLE_ROW_BATCH) break;
    }
    return {
      entry: { ...(await writer.finish()), name: "episodes.jsonl", rowCount: count },
      count,
      headHash,
      firstPrevHash,
    };
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

async function stageBundle(vault: Vault, threadId: string, options: ExportOptions): Promise<StagedBundle> {
  // v2 externalizes capsule ledgers. Upgrade receipt-null legacy arrays through
  // SQLite JSON1 before the read snapshot so even a historical dense capsule
  // never has to hydrate its old monolithic JSON in the exporter.
  vault.normalizeLegacyCapsuleLedgers(threadId);
  const root = vault.capsules.at(threadId, ROOT_LEVEL, 1);
  if (root !== null) {
    const source = vault.db
      .query(
        "SELECT e.name, e.kind, e.seq, e.span FROM capsule c " +
          "JOIN capsule_ledger_entry e ON e.capsule_id = c.id " +
          "WHERE c.thread_id = ? AND c.level = 0 AND c.from_seq >= ? AND c.to_seq <= ? " +
          "AND e.part = 'kept' ORDER BY c.from_seq ASC, e.ordinal ASC",
      )
      .iterate(threadId, root.fromSeq, root.toSeq) as Iterable<{
      name: string;
      kind: LossEntry["kind"];
      seq: number;
      span: string | null;
    }>;
    const ledger = rederiveCapsuleLedger(
      vault,
      root,
      (function* () {
        for (const entry of source) {
          yield {
            name: entry.name,
            kind: entry.kind,
            seq: entry.seq,
            ...(entry.span === null ? {} : { span: JSON.parse(entry.span) as [number, number] }),
          };
        }
      })(),
      root.text,
    );
    const carried = vault.db
      .query(
        "SELECT COALESCE(SUM(carried_count + CASE WHEN ledger_receipt IS NOT NULL " +
          "THEN json_extract(ledger_receipt, '$.dropped.count') ELSE json_array_length(dropped) END), 0) AS n " +
          "FROM capsule WHERE thread_id = ? AND level = 0 AND from_seq >= ? AND to_seq <= ?",
      )
      .get(threadId, root.fromSeq, root.toSeq) as { n: number };
    vault.capsules.replace({
      ...root,
      dropped: ledger.dropped,
      kept: ledger.kept,
      ledgerReceipt: ledger.receipt,
      carriedCount: carried.n,
    });
  }
  const dir = mkdtempSync(join(tmpdir(), "pylos-bundle-stage-"));
  let snapshot: Database | undefined;
  try {
    // Do not use the live writer connection here: staging awaits filesystem I/O
    // between rows, so a live connection could mix appends/forgets from two
    // generations. A read-only WAL transaction gives the archive one durable
    // database view without blocking normal turns.
    snapshot = new Database(vault.file, { readonly: true });
    snapshot.exec("PRAGMA busy_timeout = 5000");
    snapshot.exec("BEGIN");
    const threadRow = snapshot.query("SELECT * FROM thread WHERE id = ?").get(threadId) as
      | ThreadRow
      | undefined;
    const thread = threadRow === undefined ? null : toThread(threadRow);
    if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
    const threadSettingsFailure = settingsFailure(thread.settings);
    if (threadSettingsFailure !== null) {
      throw new VaultError(`invalid thread settings on bundle export: ${threadSettingsFailure}`);
    }
    const [from, to] = exportRange(thread, options.range);
    const fragmentRow = snapshot
      .query("SELECT original_thread_id, from_seq, to_seq FROM thread_fragment WHERE thread_id = ? LIMIT 1")
      .get(threadId) as { original_thread_id: string; from_seq: number; to_seq: number } | null;
    assertFragmentExportRange(
      fragmentRow === null ? null : { fromSeq: fragmentRow.from_seq, toSeq: fragmentRow.to_seq },
      options.range,
      from,
      to,
    );
    const bundleThreadId = fragmentRow?.original_thread_id ?? threadId;
    const partial = from !== 1 || to !== thread.headSeq;
    const reachableTable = `bundle_reachable_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    snapshot.exec(
      `CREATE TEMP TABLE ${reachableTable} (hash TEXT PRIMARY KEY, staged INTEGER NOT NULL DEFAULT 0, path TEXT, size INTEGER, digest TEXT, crc INTEGER)`,
    );
    const entries: StagedEntry[] = [];
    const objectEntries: StagedEntry[] = [];
    const episodeStage = await stageEpisodes(
      snapshot,
      dir,
      vault.objectsDir,
      reachableTable,
      threadId,
      bundleThreadId,
      from,
      to,
      thread.headHash,
      objectEntries,
    );
    entries.push(episodeStage.entry);
    const episodeCount = episodeStage.count;
    const headHash = episodeStage.headHash;
    const firstPrevHash = episodeStage.firstPrevHash;

    const atomQuery = snapshot.query("SELECT * FROM atom WHERE thread_id = ? AND source_seq BETWEEN ? AND ?");
    const atoms = await stageRows(
      dir,
      "atoms.jsonl",
      partial ? [] : (atomQuery.iterate(threadId, from, to) as Iterable<unknown>),
      (row) => {
        assertBundleDerivedRow("atom", row, "export");
        return row;
      },
    );
    entries.push(atoms);
    const atomCount = countStageRows(atoms);

    const capsuleQuery = snapshot.query(
      "SELECT * FROM capsule WHERE thread_id = ? AND from_seq >= ? AND to_seq <= ? " +
        "ORDER BY level ASC, from_seq ASC",
    );
    const capsules = await stageRows(
      dir,
      "capsules.jsonl",
      partial ? [] : (capsuleQuery.iterate(threadId, from, to) as Iterable<CapsuleRow>),
      (row) => {
        const capsule = toCapsule(row);
        assertBundleDerivedRow("capsule", capsule, "export");
        return capsule;
      },
    );
    entries.push(capsules);
    const capsuleCount = countStageRows(capsules);

    const capsuleLedgerQuery = snapshot.query(
      "SELECT e.thread_id, e.capsule_id, e.part, e.ordinal, e.name, e.kind, e.seq, e.span " +
        "FROM capsule_ledger_entry e JOIN capsule c ON c.id = e.capsule_id " +
        "WHERE c.thread_id = ? AND c.from_seq >= ? AND c.to_seq <= ? " +
        "ORDER BY c.level ASC, c.from_seq ASC, e.part ASC, e.ordinal ASC",
    );
    const capsuleLedgerEntries = await stageRows(
      dir,
      "capsule-ledger-entries.jsonl",
      partial ? [] : (capsuleLedgerQuery.iterate(threadId, from, to) as Iterable<unknown>),
      (row) => {
        assertBundleDerivedRow("capsule-ledger", row, "export");
        return row;
      },
    );
    entries.push(capsuleLedgerEntries);
    const capsuleLedgerEntryCount = countStageRows(capsuleLedgerEntries);

    const lossQuery = snapshot.query("SELECT * FROM loss WHERE thread_id = ? AND seq BETWEEN ? AND ?");
    const losses = await stageRows(
      dir,
      "loss.jsonl",
      partial ? [] : (lossQuery.iterate(threadId, from, to) as Iterable<unknown>),
      (row) => {
        assertBundleDerivedRow("loss", row, "export");
        return row;
      },
    );
    entries.push(losses);
    const lossCount = countStageRows(losses);

    const packetMessages = options.includePacketMessages === true ? "messages" : "NULL AS messages";
    const packetQuery = snapshot.query(
      `SELECT id, thread_id, turn_seq, model, budget, tokens, digest, status, compiler_version, ${packetMessages},
        resident, ledger, pages, rounds, reachability, reachability_as_of_seq, coverage, evidence, answer_receipt, semantic,
        created_at FROM packet WHERE thread_id = ? AND turn_seq BETWEEN ? AND ?`,
    );
    const packets = await stageRows(
      dir,
      "packets.jsonl",
      partial ? [] : (packetQuery.iterate(threadId, from, to) as Iterable<unknown>),
      (row) => {
        assertBundlePacket(row, threadId, "export");
        return row;
      },
    );
    entries.push(packets);
    const packetCount = countStageRows(packets);

    const tombstoneQuery = snapshot.query("SELECT * FROM tombstone WHERE thread_id = ?");
    const tombstones = await stageRows(
      dir,
      "tombstones.jsonl",
      partial ? [] : (tombstoneQuery.iterate(threadId) as Iterable<unknown>),
    );
    entries.push(tombstones);
    const tombstoneCount = countStageRows(tombstones);

    const routeQuery = snapshot.query(
      "SELECT * FROM address_route WHERE thread_id = ? AND question_seq BETWEEN ? AND ?",
    );
    const routes = await stageRows(
      dir,
      "address-routes.jsonl",
      partial ? [] : (routeQuery.iterate(threadId, from, to) as Iterable<unknown>),
      (row) => {
        const routeFailure = addressRouteRowBoundsFailure(row);
        if (routeFailure !== null) throw new VaultError(`invalid address route export: ${routeFailure}`);
        return row;
      },
    );
    entries.push(routes);
    const routeCount = countStageRows(routes);

    const aliasQuery = snapshot.query(
      "SELECT * FROM address_alias WHERE thread_id = ? AND source_seq BETWEEN ? AND ?",
    );
    const aliases = await stageRows(
      dir,
      "address-aliases.jsonl",
      partial ? [] : (aliasQuery.iterate(threadId, from, to) as Iterable<unknown>),
      (row) => {
        assertBundleAddressAlias(row, threadId, "export");
        return row;
      },
    );
    entries.push(aliases);
    const aliasCount = countStageRows(aliases);

    const atomizationReceiptQuery = snapshot.query(
      "SELECT thread_id, source_seq, source_hash, status, model, candidate_count, accepted_count, " +
        "omitted_count, reason, created_at FROM atomization_receipt WHERE thread_id = ? ORDER BY source_seq ASC",
    );
    const atomizationReceipts = await stageRows(
      dir,
      "atomization-receipts.jsonl",
      partial ? [] : (atomizationReceiptQuery.iterate(threadId) as Iterable<unknown>),
      (row) => {
        assertBundleAtomizationReceipt(vault, row, threadId, "export");
        return row;
      },
    );
    entries.push(atomizationReceipts);
    const atomizationReceiptCount = countStageRows(atomizationReceipts);
    entries.push(...objectEntries);
    if (entries.length + 1 > BUNDLE_LIMITS.maxEntries) {
      throw new VaultError("bundle has too many entries");
    }

    const manifest: BundleManifest = {
      schema: "pylos.bundle.v2",
      threadId: bundleThreadId,
      title: thread.title,
      createdAt: thread.createdAt,
      exportedAt: Date.now(),
      headSeq: to,
      headHash,
      counts: {
        episodes: episodeCount,
        atoms: atomCount,
        capsules: capsuleCount,
        loss: lossCount,
        packets: packetCount,
      },
      countsExtended: {
        addressRoutes: routeCount,
        addressAliases: aliasCount,
        tombstones: tombstoneCount,
        atomizationReceipts: atomizationReceiptCount,
        capsuleLedgerEntries: capsuleLedgerEntryCount,
      },
      partial,
      files: Object.fromEntries(entries.map((entry) => [entry.name, entry.digest])),
      settings: thread.settings,
    };
    const manifestEntry = await stageBytes(
      dir,
      "manifest.json",
      utf8.encode(JSON.stringify(manifest, null, 2)),
    );
    entries.unshift(manifestEntry);
    const stagedBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (stagedBytes > BUNDLE_LIMITS.maxArchiveBytes) {
      throw new VaultError("bundle exceeds the archive byte limit");
    }
    reportProgress(
      options.onProgress,
      "staging",
      stagedBytes,
      entries.length,
      STAGE_WRITE_SIZE,
      stagedBytes,
      episodeCount +
        atomCount +
        capsuleCount +
        lossCount +
        packetCount +
        tombstoneCount +
        routeCount +
        aliasCount,
    );
    return {
      dir,
      threadId: bundleThreadId,
      title: thread.title,
      createdAt: thread.createdAt,
      headSeq: to,
      headHash,
      firstPrevHash,
      from,
      to,
      partial,
      entries,
      stagedBytes,
      rows:
        episodeCount +
        atomCount +
        capsuleCount +
        lossCount +
        packetCount +
        tombstoneCount +
        routeCount +
        aliasCount,
      onProgress: options.onProgress,
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    if (snapshot !== undefined) {
      try {
        snapshot.exec("ROLLBACK");
      } catch {
        // The read snapshot may already have been closed after an open error.
      }
      snapshot.close();
    }
  }
}

/** A staged file's row count is intentionally not inferred from bytes. This
 * helper is only used for export manifest counters; DB query counters remain
 * authoritative, so use the inexpensive SQL count when available. */
function countStageRows(_entry: StagedEntry): number {
  return _entry.rowCount ?? 0;
}

async function* encryptedBundle(staged: StagedBundle, passphrase: string): AsyncGenerator<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonceBase = crypto.getRandomValues(new Uint8Array(8));
  const header: BundleHeader = {
    v: 2,
    kdf: "pbkdf2-sha256",
    iters: PBKDF2_ITERATIONS,
    salt: b64(salt),
    nonce: b64(nonceBase),
    threadId: staged.threadId,
    headSeq: staged.to,
    headHash: staged.headHash,
    ...(staged.partial
      ? { partial: { from: staged.from, to: staged.to, prevHash: staged.firstPrevHash } }
      : {}),
  };
  const headerBytes = utf8.encode(canonicalJson(header));
  if (headerBytes.byteLength > BUNDLE_LIMITS.maxHeaderBytes) {
    throw new VaultError("bundle header exceeds the header byte limit");
  }
  const headerLength = new Uint8Array(4);
  new DataView(headerLength.buffer).setUint32(0, headerBytes.byteLength, true);
  const headerChunk = concat([utf8.encode(BUNDLE_MAGIC), headerLength, headerBytes]);
  let outputBytes = headerChunk.byteLength;
  yield headerChunk;
  const key = await deriveKey(passphrase, salt);
  const frame = new Uint8Array(CHUNK_SIZE);
  let filled = 0;
  let counter = 0;
  let total = 0;
  if (staged.entries.length > BUNDLE_LIMITS.maxEntries) {
    throw new VaultError("bundle has too many entries");
  }
  for await (const archiveChunk of stagedFramed(staged)) {
    let offset = 0;
    while (offset < archiveChunk.byteLength) {
      const take = Math.min(frame.byteLength - filled, archiveChunk.byteLength - offset);
      frame.set(archiveChunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      total += take;
      if (total > BUNDLE_LIMITS.maxArchiveBytes)
        throw new VaultError("bundle exceeds the archive byte limit");
      if (filled === frame.byteLength) {
        if (counter >= BUNDLE_LIMITS.maxFrames) throw new VaultError("bundle has too many encrypted frames");
        const encrypted = await encryptedFrame(frame, key, nonceBase, headerBytes, counter);
        if (outputBytes + encrypted.byteLength + 4 > BUNDLE_LIMITS.maxBundleBytes) {
          throw new VaultError("bundle exceeds the stream byte limit");
        }
        outputBytes += encrypted.byteLength;
        yield encrypted;
        counter += 1;
        reportProgress(
          staged.onProgress,
          "encrypting",
          total,
          staged.entries.length,
          CHUNK_SIZE,
          staged.stagedBytes,
          staged.rows,
        );
        filled = 0;
      }
    }
  }
  if (filled > 0) {
    if (counter >= BUNDLE_LIMITS.maxFrames) throw new VaultError("bundle has too many encrypted frames");
    const encrypted = await encryptedFrame(frame.subarray(0, filled), key, nonceBase, headerBytes, counter);
    if (outputBytes + encrypted.byteLength + 4 > BUNDLE_LIMITS.maxBundleBytes) {
      throw new VaultError("bundle exceeds the stream byte limit");
    }
    outputBytes += encrypted.byteLength;
    yield encrypted;
    reportProgress(
      staged.onProgress,
      "encrypting",
      total,
      staged.entries.length,
      filled,
      staged.stagedBytes,
      staged.rows,
    );
  }
  if (outputBytes + 4 > BUNDLE_LIMITS.maxBundleBytes) {
    throw new VaultError("bundle exceeds the stream byte limit");
  }
  yield new Uint8Array(4);
  reportProgress(staged.onProgress, "done", total, staged.entries.length, 0, staged.stagedBytes, staged.rows);
}

async function encryptedFrame(
  plain: Uint8Array,
  key: CryptoKey,
  nonceBase: Uint8Array,
  headerBytes: Uint8Array,
  counter: number,
): Promise<Uint8Array> {
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: chunkNonce(nonceBase, counter) as BufferSource,
        additionalData: headerBytes as BufferSource,
      },
      key,
      plain as BufferSource,
    ),
  );
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, cipher.byteLength, true);
  return concat([length, cipher]);
}

async function* stagedFramed(staged: StagedBundle): AsyncGenerator<Uint8Array> {
  // v2 deliberately uses a framed archive rather than ZIP32. It has no central
  // directory, so a million object spans do not hit ZIP's 65,535-entry or 4 GiB
  // offset ceilings, and import can extract each entry directly to disk.
  yield utf8.encode("PYLOS2\n");
  for (const entry of staged.entries) {
    if (entry.size > BUNDLE_LIMITS.maxEntryBytes) {
      throw new VaultError(`bundle entry ${entry.name} exceeds its byte limit`);
    }
    const name = utf8.encode(entry.name);
    if (name.byteLength > 0xffff) throw new VaultError("bundle entry name is too long");
    const header = new Uint8Array(4 + 8 + 64);
    const view = new DataView(header.buffer);
    view.setUint32(0, name.byteLength, true);
    view.setBigUint64(4, BigInt(entry.size), true);
    header.set(utf8.encode(entry.digest), 12);
    yield header;
    yield name;
    const reader = Bun.file(entry.path).stream().getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        // Bun's file stream is currently 64 KiB, but keep the container
        // contract independent of that implementation detail.
        for (let offset = 0; offset < next.value.byteLength; offset += STREAM_FILE_CHUNK) {
          yield next.value.subarray(offset, Math.min(offset + STREAM_FILE_CHUNK, next.value.byteLength));
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  yield new Uint8Array(4);
}

function asyncGeneratorStream(
  generator: AsyncGenerator<Uint8Array>,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  let finished = false;
  const close = (): void => {
    if (finished) return;
    finished = true;
    cleanup();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await generator.next();
        if (next.done) {
          close();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel() {
      close();
      void generator.return(undefined);
    },
  });
}

// ------------------------------------------------------------------ import

export interface ImportResult {
  threadId: string;
  headSeq: Seq;
  headHash: string;
  episodes: number;
  verified: boolean;
  /** A partial archive's internal links and declared range verified without claiming genesis continuity. */
  fragmentVerified?: boolean;
  manifest: BundleManifest;
}

function installFragmentMarker(
  vault: Vault,
  installedThreadId: string,
  manifest: BundleManifest,
  partial: BundleHeader["partial"],
): void {
  if (!manifest.partial || partial === undefined) return;
  vault.db
    .query(
      "INSERT INTO thread_fragment " +
        "(thread_id, original_thread_id, from_seq, to_seq, prev_hash, head_hash, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      installedThreadId,
      manifest.threadId,
      partial.from,
      partial.to,
      partial.prevHash,
      manifest.headHash,
      Date.now(),
    );
}

class BundleEpisodeChainValidator {
  private readonly from: number;
  private readonly to: number;
  private expectedSeq: number;
  private previousHash: string;
  private count = 0;

  constructor(
    private readonly manifest: BundleManifest,
    header: BundleHeader,
  ) {
    this.from = header.partial?.from ?? 1;
    this.to = header.partial?.to ?? header.headSeq;
    this.expectedSeq = this.from;
    this.previousHash = header.partial?.prevHash ?? genesisHash(manifest.threadId);
  }

  accept(value: unknown): string {
    const failure = bundleEpisodeFailure(value);
    if (failure !== null) throw new VaultError(`invalid episode bundle row: ${failure}`);
    const episode = value as Episode & { contentHash?: string };
    if (episode.threadId !== undefined && episode.threadId !== this.manifest.threadId) {
      throw new VaultError("bundle episode thread binding changed");
    }
    if (episode.seq !== this.expectedSeq || episode.seq > this.to) {
      throw new VaultError("bundle episode sequence is not contiguous with its declared range");
    }
    if (episode.prevHash !== this.previousHash) {
      throw new VaultError(`bundle episode #${episode.seq} has an invalid previous hash`);
    }
    const contentHash = episode.contentHash ?? sha256(episode.content);
    if (episode.meta?.removed !== true && sha256(episode.content) !== contentHash) {
      throw new VaultError(`bundle episode #${episode.seq} content does not match contentHash`);
    }
    const expected = chainHash(
      this.previousHash,
      chainRecord({
        seq: episode.seq,
        ts: episode.ts,
        role: episode.role,
        ...(episode.model === undefined ? {} : { model: episode.model }),
        ...(episode.provider === undefined ? {} : { provider: episode.provider }),
        contentHash,
        metaHash: metaHashOf(episode.meta ?? {}),
      }),
    );
    if (episode.hash !== expected) throw new VaultError(`bundle episode #${episode.seq} hash is invalid`);
    this.previousHash = episode.hash;
    this.expectedSeq += 1;
    this.count += 1;
    return contentHash;
  }

  finish(): void {
    if (
      this.count !== this.manifest.counts.episodes ||
      this.expectedSeq !== this.to + 1 ||
      this.previousHash !== this.manifest.headHash
    ) {
      throw new VaultError("bundle episode tail does not match its declared count, range, and head");
    }
  }
}

function seedImportedCheckpoints(vault: Vault, threadId: string): void {
  const rows = vault.db
    .query("SELECT seq, hash FROM episode WHERE thread_id = ? AND seq % 4096 = 0 ORDER BY seq")
    .all(threadId) as Array<{ seq: number; hash: string }>;
  for (const row of rows) vault.putCheckpoint(threadId, row.seq, row.hash);
}

interface PreflightedImportStream {
  header: BundleHeader;
  stream: ReadableStream<Uint8Array>;
  remainingDeadlineMs: number;
}

/** Read only the bounded clear header before allocating a private import stage.
 * The header can reject an operation, but it authorizes nothing until AES-GCM
 * authentication and manifest validation succeed later in the import. */
async function preflightImportStream(
  stream: ReadableStream<Uint8Array>,
  limits: BundleLimits,
  transferDeadlineMs: number,
): Promise<PreflightedImportStream> {
  if (!Number.isSafeInteger(transferDeadlineMs) || transferDeadlineMs <= 0) {
    throw new VaultError("bundle transfer deadline must be a positive safe integer");
  }
  const absoluteDeadline = Date.now() + transferDeadlineMs;
  const [probe, replay] = stream.tee();
  const reader = probe.getReader();
  const prefixLength = BUNDLE_MAGIC.length + 4;
  const buffered = new Uint8Array(prefixLength + limits.maxHeaderBytes);
  let bufferedBytes = 0;
  let totalBytes = 0;
  let headerLength: number | undefined;
  try {
    for (;;) {
      const remaining = absoluteDeadline - Date.now();
      if (remaining <= 0) throw new VaultError("bundle stream exceeded its transfer deadline");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Date.now() >= absoluteDeadline
                ? new VaultError("bundle stream exceeded its transfer deadline")
                : new VaultError("bundle stream stalled waiting for bytes"),
            ),
          Math.min(BUNDLE_READ_INACTIVITY_MS, remaining),
        );
      });
      const next = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      if (next.done) throw new VaultError("truncated .pylos bundle");
      if (!(next.value instanceof Uint8Array)) {
        throw new VaultError("bundle stream yielded a non-byte chunk");
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > limits.maxBundleBytes) throw new VaultError("bundle exceeds the stream byte limit");
      const copied = Math.min(next.value.byteLength, buffered.byteLength - bufferedBytes);
      if (copied > 0) {
        buffered.set(next.value.subarray(0, copied), bufferedBytes);
        bufferedBytes += copied;
      }
      if (headerLength === undefined && bufferedBytes >= prefixLength) {
        if (new TextDecoder().decode(buffered.subarray(0, BUNDLE_MAGIC.length)) !== BUNDLE_MAGIC) {
          throw new VaultError("not a .pylos bundle");
        }
        headerLength = new DataView(buffered.buffer).getUint32(BUNDLE_MAGIC.length, true);
        if (headerLength > limits.maxHeaderBytes) {
          throw new VaultError("bundle header exceeds the header byte limit");
        }
      }
      if (headerLength === undefined || bufferedBytes < prefixLength + headerLength) continue;
      let header: BundleHeader;
      try {
        header = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffered.subarray(prefixLength, prefixLength + headerLength),
          ),
        ) as BundleHeader;
      } catch {
        throw new VaultError("bundle header is not valid JSON");
      }
      validateBundleHeader(header);
      const remainingDeadlineMs = absoluteDeadline - Date.now();
      if (remainingDeadlineMs <= 0) {
        throw new VaultError("bundle stream exceeded its transfer deadline");
      }
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
      return { header, stream: replay, remainingDeadlineMs };
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    reader.releaseLock();
    void replay.cancel(error).catch(() => undefined);
    throw error;
  }
}

/** Import from a stream. All authentication, container and manifest checks run
 * before the destination transaction begins, so a late frame/auth failure can
 * never leave a half-restored thread or object file behind. */
export async function importBundleStream(
  vault: Vault,
  stream: ReadableStream<Uint8Array>,
  options: ImportOptions,
): Promise<ImportResult> {
  const limits = { ...BUNDLE_LIMITS, ...(options.limits ?? {}) };
  const preflight = await preflightImportStream(
    stream,
    limits,
    options.transferDeadlineMs ?? BUNDLE_TRANSFER_DEADLINE_MS,
  );
  assertImportThreadOverride(preflight.header, options.threadId);
  let dir: string;
  try {
    dir = createImportStage(vault.objectsDir);
  } catch (error) {
    void preflight.stream.cancel(error).catch(() => undefined);
    throw error;
  }
  try {
    const input = await stageIncomingStream(
      dir,
      preflight.stream,
      limits,
      options.onProgress,
      preflight.remainingDeadlineMs,
    );
    const decrypted = await decryptBundleFile(
      input.path,
      dir,
      options.passphrase,
      limits,
      options.onProgress,
    );
    const archiveLimits = decrypted.version === 1 ? legacyCompatibilityLimits(limits) : limits;
    const archiveFile = await open(decrypted.path, "r");
    let format: string;
    try {
      format = new TextDecoder().decode(await readAt(archiveFile, 0, 7));
    } finally {
      await archiveFile.close();
    }
    const framed = format === "PYLOS2\n";
    if ((decrypted.version === 2) !== framed) {
      throw new VaultError(`bundle header v${decrypted.version} does not match its container`);
    }
    const entries = framed
      ? await extractFramedFile(decrypted.path, dir, archiveLimits, options.onProgress)
      : await extractZipFile(decrypted.path, dir, archiveLimits, options.onProgress);
    return await importStagedArchive(
      vault,
      entries,
      options,
      archiveLimits,
      decrypted.version,
      decrypted.header,
    );
  } finally {
    discardImportStage(vault.objectsDir, dir);
  }
}

async function stageIncomingStream(
  dir: string,
  stream: ReadableStream<Uint8Array>,
  limits: BundleLimits,
  onProgress?: (progress: BundleProgress) => void,
  transferDeadlineMs = BUNDLE_TRANSFER_DEADLINE_MS,
): Promise<StagedEntry> {
  if (!Number.isSafeInteger(transferDeadlineMs) || transferDeadlineMs <= 0) {
    throw new VaultError("bundle transfer deadline must be a positive safe integer");
  }
  const writer = await StageWriter.create(join(dir, "bundle.pylos"));
  const reader = stream.getReader();
  let released = false;
  let total = 0;
  const absoluteDeadline = Date.now() + transferDeadlineMs;
  try {
    for (;;) {
      const remaining = absoluteDeadline - Date.now();
      if (remaining <= 0) throw new VaultError("bundle stream exceeded its transfer deadline");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Date.now() >= absoluteDeadline
                ? new VaultError("bundle stream exceeded its transfer deadline")
                : new VaultError("bundle stream stalled waiting for bytes"),
            ),
          Math.min(BUNDLE_READ_INACTIVITY_MS, remaining),
        );
      });
      const next = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new VaultError("bundle stream yielded a non-byte chunk");
      total += next.value.byteLength;
      if (total > limits.maxBundleBytes) throw new VaultError("bundle exceeds the stream byte limit");
      await writer.write(next.value);
    }
    reader.releaseLock();
    released = true;
    const entry = { ...(await writer.finish()), name: "bundle.pylos" };
    reportProgress(onProgress, "staging", total, 0, STAGE_WRITE_SIZE);
    return entry;
  } catch (error) {
    if (!released) {
      void reader.cancel(error).catch(() => undefined);
      reader.releaseLock();
    }
    await writer.abort();
    throw error;
  }
}

async function readAt(
  file: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (length < 0 || length > 1_100_000_000) throw new VaultError("bundle range is too large");
  const out = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const result = await file.read(out, total, length - total, offset + total);
    if (result.bytesRead === 0) throw new VaultError("truncated staged bundle");
    total += result.bytesRead;
  }
  return out;
}

async function decryptBundleFile(
  inputPath: string,
  dir: string,
  passphrase: string,
  limits: BundleLimits,
  onProgress?: (progress: BundleProgress) => void,
): Promise<DecryptedBundle> {
  const input = await open(inputPath, "r");
  try {
    const inputSize = (await input.stat()).size;
    if (inputSize > limits.maxBundleBytes) throw new VaultError("bundle exceeds the stream byte limit");
    if (inputSize < BUNDLE_MAGIC.length + 4) throw new VaultError("truncated .pylos bundle");
    const prefix = await readAt(input, 0, BUNDLE_MAGIC.length + 4);
    if (new TextDecoder().decode(prefix.subarray(0, BUNDLE_MAGIC.length)) !== BUNDLE_MAGIC) {
      throw new VaultError("not a .pylos bundle");
    }
    const headerLength = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(
      BUNDLE_MAGIC.length,
      true,
    );
    if (headerLength > limits.maxHeaderBytes || BUNDLE_MAGIC.length + 4 + headerLength > inputSize) {
      throw new VaultError("bundle header exceeds the header byte limit");
    }
    const headerBytes = await readAt(input, BUNDLE_MAGIC.length + 4, headerLength);
    let header: BundleHeader;
    try {
      header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes)) as BundleHeader;
    } catch {
      throw new VaultError("bundle header is not valid JSON");
    }
    validateBundleHeader(header);
    const frameLimits = header.v === 1 ? legacyCompatibilityLimits(limits) : limits;
    if (inputSize > frameLimits.maxBundleBytes) {
      throw new VaultError("legacy bundle exceeds the compatibility byte limit");
    }
    const key = await deriveKey(passphrase, unb64(header.salt));
    const nonceBase = unb64(header.nonce);
    const archiveWriter = await StageWriter.create(join(dir, "archive.bin"));
    let pointer = BUNDLE_MAGIC.length + 4 + headerLength;
    let counter = 0;
    let archiveBytes = 0;
    try {
      for (;;) {
        if (pointer + 4 > inputSize) throw new VaultError("truncated bundle frame");
        const lengthBytes = await readAt(input, pointer, 4);
        pointer += 4;
        const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0, true);
        if (length === 0) break;
        if (counter >= frameLimits.maxFrames) throw new VaultError("bundle has too many encrypted frames");
        if (length > frameLimits.maxFrameBytes || pointer + length > inputSize) {
          throw new VaultError("bundle frame exceeds the frame byte limit");
        }
        const cipher = await readAt(input, pointer, length);
        pointer += length;
        let plain: ArrayBuffer;
        try {
          plain = await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: chunkNonce(nonceBase, counter) as BufferSource,
              additionalData: headerBytes as BufferSource,
            },
            key,
            cipher as BufferSource,
          );
        } catch {
          throw new VaultError("decryption failed — wrong passphrase or corrupt bundle");
        }
        const part = new Uint8Array(plain);
        archiveBytes += part.byteLength;
        if (archiveBytes > frameLimits.maxArchiveBytes)
          throw new VaultError("bundle exceeds the archive byte limit");
        await archiveWriter.write(part);
        counter += 1;
        reportProgress(onProgress, "decrypting", archiveBytes, counter, part.byteLength);
      }
      if (pointer !== inputSize) throw new VaultError("trailing bytes after bundle terminator");
      return { ...(await archiveWriter.finish()), name: "archive.bin", version: header.v, header };
    } catch (error) {
      await archiveWriter.abort();
      throw error;
    }
  } finally {
    await input.close();
  }
}

async function extractFramedFile(
  archivePath: string,
  dir: string,
  limits: BundleLimits,
  onProgress?: (progress: BundleProgress) => void,
): Promise<StagedEntry[]> {
  const file = await open(archivePath, "r");
  try {
    const size = (await file.stat()).size;
    const marker = await readAt(file, 0, 7);
    if (new TextDecoder().decode(marker) !== "PYLOS2\n") throw new VaultError("invalid v2 bundle container");
    const entries: StagedEntry[] = [];
    const names = new Set<string>();
    let pointer = 7;
    let total = 0;
    while (pointer < size) {
      if (entries.length >= limits.maxEntries) throw new VaultError("bundle has too many entries");
      if (pointer + 4 > size) throw new VaultError("truncated framed bundle entry");
      const nameLengthBytes = await readAt(file, pointer, 4);
      pointer += 4;
      const nameLength = nameLengthBytes.readUInt32LE(0);
      if (nameLength === 0) {
        if (pointer !== size) throw new VaultError("trailing bytes after framed bundle terminator");
        return entries;
      }
      if (nameLength > 0xffff || pointer + 8 + 64 + nameLength > size) {
        throw new VaultError("framed bundle entry name exceeds its limit");
      }
      const header = await readAt(file, pointer, 8 + 64);
      pointer += 8 + 64;
      const dataSizeBig = header.readBigUInt64LE(0);
      if (dataSizeBig > BigInt(Number.MAX_SAFE_INTEGER))
        throw new VaultError("framed bundle entry is too large");
      const dataSize = Number(dataSizeBig);
      if (dataSize > limits.maxEntryBytes || dataSize > size - pointer - nameLength) {
        throw new VaultError("framed bundle entry exceeds its limit");
      }
      total += dataSize;
      if (total > limits.maxArchiveBytes)
        throw new VaultError("framed bundle exceeds the archive byte limit");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(await readAt(file, pointer, nameLength));
      pointer += nameLength;
      if (!isSafeBundleName(name) || names.has(name)) {
        throw new VaultError(`unsafe or duplicate framed entry ${name}`);
      }
      const expectedDigest = new TextDecoder().decode(header.subarray(8, 72));
      if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw new VaultError(`invalid digest for ${name}`);
      const stagePath = join(dir, `entry-${entries.length}.bin`);
      const writer = await StageWriter.create(stagePath);
      try {
        await copyRange(file, pointer, dataSize, writer);
        pointer += dataSize;
        const entry = { ...(await writer.finish()), name };
        if (entry.digest !== expectedDigest) throw new VaultError(`framed entry ${name} failed its digest`);
        entries.push(entry);
        names.add(name);
        reportProgress(onProgress, "extracting", total, entries.length, STREAM_FILE_CHUNK);
      } catch (error) {
        await writer.abort();
        throw error;
      }
    }
    throw new VaultError("framed bundle has no terminator");
  } finally {
    await file.close();
  }
}

async function extractZipFile(
  archivePath: string,
  dir: string,
  limits: BundleLimits,
  onProgress?: (progress: BundleProgress) => void,
): Promise<StagedEntry[]> {
  const file = await open(archivePath, "r");
  try {
    const size = (await file.stat()).size;
    if (size > limits.maxArchiveBytes || size < 22) throw new VaultError("invalid staged zip size");
    const tailLength = Math.min(size, 22 + 65_535);
    const tail = await readAt(file, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new VaultError("not a zip archive");
    const count = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (count > limits.maxEntries || centralOffset + centralSize > size) {
      throw new VaultError("zip central directory exceeds its limit");
    }
    const central = await readAt(file, centralOffset, centralSize);
    const entries: StagedEntry[] = [];
    const names = new Set<string>();
    let pointer = 0;
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      if (pointer + 46 > central.length || central.readUInt32LE(pointer) !== 0x02014b50) {
        throw new VaultError("corrupt central directory");
      }
      const method = central.readUInt16LE(pointer + 10);
      const crc = central.readUInt32LE(pointer + 16);
      const compSize = central.readUInt32LE(pointer + 20);
      const rawSize = central.readUInt32LE(pointer + 24);
      const nameLen = central.readUInt16LE(pointer + 28);
      const extraLen = central.readUInt16LE(pointer + 30);
      const commentLen = central.readUInt16LE(pointer + 32);
      const localOffset = central.readUInt32LE(pointer + 42);
      if (method !== 0 && method !== 8) throw new VaultError("unsupported zip compression method");
      if (
        rawSize > limits.maxEntryBytes ||
        compSize > limits.maxEntryBytes ||
        rawSize > limits.maxArchiveBytes - total ||
        pointer + 46 + nameLen + extraLen + commentLen > central.length
      ) {
        throw new VaultError("zip entry exceeds its byte limit");
      }
      const name = central.toString("utf8", pointer + 46, pointer + 46 + nameLen);
      if (!isSafeBundleName(name)) throw new VaultError(`unsafe zip entry name ${name}`);
      if (names.has(name)) throw new VaultError(`duplicate zip entry ${name}`);
      const local = await readAt(file, localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new VaultError(`truncated local header for ${name}`);
      const localNameLen = local.readUInt16LE(26);
      const localExtraLen = local.readUInt16LE(28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      if (dataStart + compSize > size) throw new VaultError(`truncated zip entry ${name}`);
      const stagePath = join(dir, `entry-${index}.bin`);
      const writer = await StageWriter.create(stagePath);
      try {
        if (method === 0) {
          await copyRange(file, dataStart, compSize, writer);
        } else {
          const payload = await readAt(file, dataStart, compSize);
          const raw = inflateRawSync(payload, { maxOutputLength: limits.maxEntryBytes });
          await writer.write(raw);
        }
        const entry = { ...(await writer.finish()), name };
        if (entry.size !== rawSize || entry.crc !== crc)
          throw new VaultError(`zip entry ${name} failed its CRC`);
        entries.push(entry);
        names.add(name);
        total += entry.size;
        reportProgress(onProgress, "extracting", total, entries.length, STREAM_FILE_CHUNK);
      } catch (error) {
        await writer.abort();
        throw error;
      }
      pointer += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await file.close();
  }
}

async function copyRange(
  file: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
  writer: StageWriter,
): Promise<void> {
  let cursor = 0;
  while (cursor < length) {
    const take = Math.min(STREAM_FILE_CHUNK, length - cursor);
    await writer.write(await readAt(file, offset + cursor, take));
    cursor += take;
  }
}

async function verifyObjectFile(path: string, expectedHash: string, expectedSize: number): Promise<void> {
  const file = await open(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(STREAM_FILE_CHUNK);
  let size = 0;
  try {
    const stat = await file.stat();
    if (stat.size !== expectedSize || stat.size > BUNDLE_LIMITS.maxEntryBytes) {
      throw new VaultError(`existing object ${expectedHash} failed its size check`);
    }
    for (;;) {
      const result = await file.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      size += result.bytesRead;
    }
  } finally {
    await file.close();
  }
  if (size !== expectedSize || hash.digest("hex") !== expectedHash) {
    throw new VaultError(`existing object ${expectedHash} failed its content hash`);
  }
}

function readStagedManifest(
  entries: readonly StagedEntry[],
  limits: BundleLimits,
  header: BundleHeader,
  version: 1 | 2,
): BundleManifest {
  const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
  if (manifestEntry === undefined) throw new VaultError("bundle has no manifest");
  if (manifestEntry.size > Math.min(limits.maxEntryBytes, MAX_MANIFEST_BYTES)) {
    throw new VaultError("bundle manifest is too large");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(manifestEntry.path)),
    ) as unknown;
  } catch {
    throw new VaultError("bundle manifest is not valid JSON");
  }
  validateBundleManifest(manifest, header, version);
  return manifest;
}

function validateStagedEntries(
  entries: readonly StagedEntry[],
  manifest: BundleManifest,
  limits: BundleLimits,
): Map<string, StagedEntry> {
  if (entries.length > limits.maxEntries) throw new VaultError("bundle has too many entries");
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const fileNames = Object.keys(manifest.files);
  if (fileNames.length > limits.maxEntries) throw new VaultError("bundle manifest has too many files");
  const expected = new Set(["manifest.json", ...fileNames]);
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry.name))) {
    throw new VaultError("bundle contains an unlisted file");
  }
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!isSafeBundleName(name)) throw new VaultError(`unsafe bundle file ${name}`);
    const entry = byName.get(name);
    if (entry === undefined) throw new VaultError(`bundle missing ${name}`);
    if (entry.digest !== digest) throw new VaultError(`bundle file ${name} failed its digest`);
    if (name.startsWith("objects/")) {
      const objectHash = name.slice("objects/".length);
      if (!/^[0-9a-f]{64}$/.test(objectHash) || entry.digest !== objectHash) {
        throw new VaultError(`bundle object ${name} failed its filename hash`);
      }
    }
  }
  return byName;
}

function* readJsonlSync<T>(path: string, maxLineBytes: number): Generator<T> {
  const fd = openSync(path, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const bytes = Buffer.alloc(STREAM_FILE_CHUNK);
  let carry = "";
  let offset = 0;
  try {
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, null);
      if (count === 0) break;
      carry += decoder.decode(bytes.subarray(0, count), { stream: true });
      let newline = carry.indexOf("\n");
      while (newline >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        const lineBytes = Buffer.byteLength(line);
        if (lineBytes > maxLineBytes) throw new VaultError("bundle JSONL line exceeds the line byte limit");
        if (line.trim().length > 0) {
          try {
            yield JSON.parse(line) as T;
          } catch {
            throw new VaultError(`invalid JSONL at byte ${offset}`);
          }
        }
        offset += lineBytes + 1;
        newline = carry.indexOf("\n");
      }
      if (Buffer.byteLength(carry) > maxLineBytes) {
        throw new VaultError("bundle JSONL line exceeds the line byte limit");
      }
    }
    carry += decoder.decode();
    if (Buffer.byteLength(carry) > maxLineBytes)
      throw new VaultError("bundle JSONL line exceeds the line byte limit");
    if (carry.trim().length > 0) {
      try {
        yield JSON.parse(carry) as T;
      } catch {
        throw new VaultError(`invalid JSONL at byte ${offset}`);
      }
    }
  } finally {
    closeSync(fd);
  }
}

function updateHashFromStagedEntry(
  hash: ReturnType<typeof createHash>,
  entry: StagedEntry,
  buffer: Buffer,
): number {
  const fd = openSync(entry.path, "r");
  let size = 0;
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) return size;
      hash.update(buffer.subarray(0, count));
      size += count;
    }
  } finally {
    closeSync(fd);
  }
}

function normalizeAttachmentEpisodeStaged(
  episode: Episode & { contentHash?: string },
  entries: ReadonlyMap<string, StagedEntry>,
): Episode & { contentHash?: string } {
  if (episode.role !== "attachment") return episode;
  const meta = episode.meta ?? {};
  const blob = typeof meta.blob === "string" ? meta.blob : undefined;
  let manifest = meta.manifest;
  if (manifest === undefined && blob !== undefined) {
    const entry = entries.get(`objects/${blob}`);
    if (entry === undefined) throw new VaultError(`bundle missing attachment object ${blob}`);
    manifest = legacyAttachmentManifestForSize(episode, blob, entry.size);
  }
  if (manifest !== undefined) {
    if (!manifestPartitionValid(manifest)) {
      throw new VaultError(`attachment ${episode.seq} has an invalid manifest partition`);
    }
    const { digest, legacy: _legacy, ...manifestBase } = manifest;
    if (typeof digest !== "string" || canonicalHash(manifestBase) !== digest) {
      throw new VaultError(`attachment ${episode.seq} has an invalid manifest digest`);
    }
    const whole = createHash("sha256");
    let wholeSize = 0;
    const buffer = Buffer.alloc(STREAM_FILE_CHUNK);
    for (const span of manifest.spans) {
      const entry = entries.get(`objects/${span.objectHash}`);
      if (entry === undefined) throw new VaultError(`bundle missing attachment span ${span.objectHash}`);
      if (entry.digest !== span.objectHash || entry.size !== span.to - span.from) {
        throw new VaultError(`attachment span ${span.objectHash} failed its hash or length`);
      }
      wholeSize += updateHashFromStagedEntry(whole, entry, buffer);
    }
    verifyAttachmentWholeHash(episode, manifest, blob, wholeSize, whole.digest("hex"));
    const wholeEntry = blob === undefined ? undefined : entries.get(`objects/${blob}`);
    if (wholeEntry === undefined) {
      throw new VaultError(`attachment ${episode.seq} is missing its whole attachment object`);
    }
    const retained = createHash("sha256");
    const retainedSize = updateHashFromStagedEntry(retained, wholeEntry, buffer);
    if (
      wholeEntry.digest !== manifest.hash ||
      retainedSize !== manifest.size ||
      retained.digest("hex") !== manifest.hash
    ) {
      throw new VaultError(`attachment ${episode.seq} whole attachment object failed its hash or length`);
    }
  }
  return manifest === meta.manifest ? episode : { ...episode, meta: { ...meta, manifest } };
}

function verifyAttachmentWholeHash(
  episode: Episode,
  manifest: AttachmentManifest,
  blob: string | undefined,
  size: number,
  hash: string,
): void {
  if (
    blob === undefined ||
    !/^[0-9a-f]{64}$/.test(manifest.hash) ||
    manifest.size !== size ||
    manifest.hash !== hash ||
    manifest.hash !== blob
  ) {
    throw new VaultError(`attachment ${episode.seq} whole-object hash does not match its spans and blob`);
  }
}

function legacyAttachmentManifestForSize(
  episode: Episode,
  hash: string,
  size: number,
): NonNullable<Episode["meta"]["manifest"]> {
  const base = {
    id: `legacy:${episode.seq}:${hash.slice(0, 16)}`,
    hash,
    size,
    mime: episode.meta.mime ?? "application/octet-stream",
    name: episode.meta.name ?? episode.content,
    chunkSize: size,
    spans: [
      {
        ordinal: 0,
        from: 0,
        to: size,
        hash,
        state: "opaque" as const,
        objectHash: hash,
      },
    ],
  };
  return {
    ...base,
    digest: sha256(new TextEncoder().encode(canonicalJson(base))),
    legacy: true,
  };
}

async function importStagedArchive(
  vault: Vault,
  entries: readonly StagedEntry[],
  options: ImportOptions,
  limits: BundleLimits,
  version: 1 | 2,
  header: BundleHeader,
): Promise<ImportResult> {
  const stagedBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  reportProgress(options.onProgress, "loading", 0, entries.length, 0, stagedBytes, 0);
  assertImportThreadOverride(header, options.threadId);
  const manifest = readStagedManifest(entries, limits, header, version);
  const byName = validateStagedEntries(entries, manifest, limits);
  const required = (name: string): StagedEntry => {
    const entry = byName.get(name);
    if (entry === undefined) throw new VaultError(`bundle missing ${name}`);
    return entry;
  };
  const episodesEntry = required("episodes.jsonl");
  const atomsEntry = required("atoms.jsonl");
  const capsulesEntry = required("capsules.jsonl");
  const lossEntry = required("loss.jsonl");
  const packetsEntry = required("packets.jsonl");
  const tombstonesEntry = required("tombstones.jsonl");
  const routesEntry = byName.get("address-routes.jsonl");
  const aliasesEntry = byName.get("address-aliases.jsonl");
  const atomizationReceiptsEntry = byName.get("atomization-receipts.jsonl");
  const capsuleLedgerEntriesEntry = byName.get("capsule-ledger-entries.jsonl");
  let packetCount = 0;
  for (const _row of readJsonlSync<Record<string, unknown>>(packetsEntry.path, limits.maxLineBytes))
    packetCount += 1;
  if (packetCount !== manifest.counts.packets) {
    throw new VaultError(`bundle declares ${manifest.counts.packets} packets and carries ${packetCount}`);
  }
  const threadId = options.threadId ?? manifest.threadId;
  const existing = vault.threads.get(threadId);
  if (existing !== null) {
    throw new VaultError(`thread ${threadId} already exists in this vault`);
  }
  // A content-addressed filename is only useful if an already-present target
  // is checked too. Do this before opening the destination transaction so a
  // corrupt pre-existing object cannot be silently accepted as a witness.
  for (const entry of entries) {
    if (!entry.name.startsWith("objects/")) continue;
    const hash = entry.name.slice("objects/".length);
    const target = join(vault.objectsDir, hash);
    if (existsSync(target)) await verifyObjectFile(target, hash, entry.size);
  }
  const promotion = createBlobPromotion(vault.objectsDir);
  let loadedRows = 0;
  let promotionOwned = true;
  try {
    for (const entry of entries) {
      if (!entry.name.startsWith("objects/")) continue;
      const hash = entry.name.slice("objects/".length);
      if (!existsSync(join(vault.objectsDir, hash))) {
        stageBlobForPromotion(promotion, entry.path, hash, entry.size);
      }
    }
    // This explicit boundary is useful transport telemetry and the crash-test
    // fault point: every plaintext object is durable under a private pending
    // name, while no imported SQL row has committed yet.
    reportProgress(
      options.onProgress,
      "installing",
      stagedBytes,
      entries.length,
      STREAM_FILE_CHUNK,
      stagedBytes,
      loadedRows,
    );
    const result = vault.txWithPendingBlobPromotion(promotion, () => {
      promotionOwned = false;
      if (existing === null) {
        vault.db
          .query(
            "INSERT INTO thread (id, title, created_at, head_seq, head_hash, settings) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            threadId,
            manifest.title,
            manifest.createdAt,
            0,
            manifest.headHash,
            canonicalJson(manifest.settings ?? {}),
          );
      }
      const insert = vault.db.prepare(
        "INSERT INTO episode (seq, thread_id, ts, role, model, provider, content, content_hash, tokens, prev_hash, hash, meta) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const fts = vault.db.prepare("INSERT INTO episode_fts (rowid, content) VALUES (?, ?)");
      let episodeCount = 0;
      let bytes = 0;
      let last: (Episode & { contentHash?: string }) | undefined;
      const chainValidator = new BundleEpisodeChainValidator(manifest, header);
      const counters: Record<string, number> = {};
      for (const raw of readJsonlSync<Episode & { contentHash?: string }>(
        episodesEntry.path,
        limits.maxLineBytes,
      )) {
        const contentHash = chainValidator.accept(raw);
        const episode = normalizeAttachmentEpisodeStaged(raw, byName);
        if (!manifest.partial) {
          const sourceFailure = capsuleSourceContentFailure(episode.content);
          if (sourceFailure !== null) throw new VaultError(`invalid episode on import: ${sourceFailure}`);
        }
        last = episode;
        episodeCount += 1;
        loadedRows += 1;
        const meta = episode.meta ?? {};
        const row = insert.run(
          episode.seq,
          threadId,
          episode.ts,
          episode.role,
          episode.model ?? null,
          episode.provider ?? null,
          episode.content,
          contentHash,
          episode.tokens,
          episode.prevHash,
          episode.hash,
          canonicalJson(meta),
        );
        if (meta.removed !== true) fts.run(Number(row.lastInsertRowid), episode.content);
        if (episode.role === "attachment" && meta.removed !== true)
          vault.indexAttachmentName(threadId, episode.seq, meta);
        bytes += Buffer.byteLength(episode.content);
        counters.episodes = (counters.episodes ?? 0) + 1;
        const roleKey =
          episode.role === "user"
            ? "episodes.user"
            : episode.role === "assistant"
              ? "episodes.assistant"
              : "episodes.other";
        counters[roleKey] = (counters[roleKey] ?? 0) + 1;
      }
      chainValidator.finish();
      if (episodeCount !== manifest.counts.episodes) {
        throw new VaultError(
          `bundle declares ${manifest.counts.episodes} episodes and carries ${episodeCount}`,
        );
      }
      counters.bytes = bytes;
      let atomCount = 0;
      for (const atom of readJsonlSync<AtomRow>(atomsEntry.path, derivedRowLineLimit("atom", limits))) {
        assertBundleDerivedRow("atom", atom, "import");
        const row = { ...atom, thread_id: threadId };
        insertRow(vault, "atom", row);
        vault.atoms.indexNames(toAtom(row));
        atomCount += 1;
        loadedRows += 1;
      }
      if (atomCount !== manifest.counts.atoms) {
        throw new VaultError(`bundle declares ${manifest.counts.atoms} atoms and carries ${atomCount}`);
      }
      let capsuleCount = 0;
      for (const capsule of readJsonlSync<StoredCapsule>(
        capsulesEntry.path,
        derivedRowLineLimit("capsule", limits),
      )) {
        assertBundleDerivedRow("capsule", capsule, "import");
        insertCapsuleRow(vault, threadId, capsule);
        capsuleCount += 1;
        loadedRows += 1;
      }
      if (capsuleCount !== manifest.counts.capsules) {
        throw new VaultError(
          `bundle declares ${manifest.counts.capsules} capsules and carries ${capsuleCount}`,
        );
      }
      let capsuleLedgerEntryCount = 0;
      if (capsuleLedgerEntriesEntry !== undefined) {
        for (const row of readJsonlSync<Record<string, unknown>>(
          capsuleLedgerEntriesEntry.path,
          derivedRowLineLimit("capsule-ledger", limits),
        )) {
          assertBundleDerivedRow("capsule-ledger", row, "import");
          insertRow(vault, "capsule_ledger_entry", { ...row, thread_id: threadId });
          capsuleLedgerEntryCount += 1;
          loadedRows += 1;
        }
      }
      if (capsuleLedgerEntryCount !== (manifest.countsExtended?.capsuleLedgerEntries ?? 0)) {
        throw new VaultError(
          `bundle declares ${manifest.countsExtended?.capsuleLedgerEntries ?? 0} capsule ledger entries and carries ${capsuleLedgerEntryCount}`,
        );
      }
      let lossCount = 0;
      for (const row of readJsonlSync<Record<string, unknown>>(
        lossEntry.path,
        derivedRowLineLimit("loss", limits),
      )) {
        assertBundleDerivedRow("loss", row, "import");
        const { id: _id, ...rest } = row;
        insertRow(vault, "loss", { ...rest, thread_id: threadId });
        lossCount += 1;
        loadedRows += 1;
      }
      if (lossCount !== manifest.counts.loss) {
        throw new VaultError(`bundle declares ${manifest.counts.loss} losses and carries ${lossCount}`);
      }
      assertImportedDerivedTopology(vault, threadId, manifest.headSeq);
      let packetCount = 0;
      let tombstoneCount = 0;
      for (const row of readJsonlSync<Record<string, unknown>>(packetsEntry.path, limits.maxLineBytes)) {
        assertBundlePacket(row, manifest.threadId, "import");
        insertRow(vault, "packet", { ...row, thread_id: threadId });
        packetCount += 1;
        loadedRows += 1;
      }
      if (packetCount !== manifest.counts.packets) {
        throw new VaultError(`bundle declares ${manifest.counts.packets} packets and carries ${packetCount}`);
      }
      for (const row of readJsonlSync<Record<string, unknown>>(tombstonesEntry.path, limits.maxLineBytes)) {
        insertRow(vault, "tombstone", { ...row, thread_id: threadId });
        tombstoneCount += 1;
        loadedRows += 1;
      }
      if (tombstoneCount !== (manifest.countsExtended?.tombstones ?? 0)) {
        throw new VaultError(
          `bundle declares ${manifest.countsExtended?.tombstones ?? 0} tombstones and carries ${tombstoneCount}`,
        );
      }
      if (routesEntry !== undefined) {
        let routeCount = 0;
        for (const row of readJsonlSync<Record<string, unknown>>(routesEntry.path, limits.maxLineBytes)) {
          const routeFailure = addressRouteRowBoundsFailure(row);
          if (routeFailure !== null) throw new VaultError(`invalid address route import: ${routeFailure}`);
          insertRow(vault, "address_route", { ...row, thread_id: threadId });
          routeCount += 1;
          loadedRows += 1;
        }
        if (routeCount !== (manifest.countsExtended?.addressRoutes ?? 0)) {
          throw new VaultError(
            `bundle declares ${manifest.countsExtended?.addressRoutes ?? 0} address routes and carries ${routeCount}`,
          );
        }
      } else if (
        manifest.countsExtended?.addressRoutes !== undefined &&
        manifest.countsExtended.addressRoutes !== 0
      ) {
        throw new VaultError("bundle declares address routes but carries no address-routes.jsonl");
      }
      if (aliasesEntry !== undefined) {
        let aliasCount = 0;
        for (const row of readJsonlSync<Record<string, unknown>>(
          aliasesEntry.path,
          Math.min(limits.maxLineBytes, MAX_ADDRESS_ALIAS_LINE_BYTES),
        )) {
          assertBundleAddressAlias(row, manifest.threadId, "import");
          insertRow(vault, "address_alias", { ...row, thread_id: threadId });
          aliasCount += 1;
          loadedRows += 1;
        }
        if (aliasCount !== (manifest.countsExtended?.addressAliases ?? 0)) {
          throw new VaultError(
            `bundle declares ${manifest.countsExtended?.addressAliases ?? 0} address aliases and carries ${aliasCount}`,
          );
        }
      } else if (
        manifest.countsExtended?.addressAliases !== undefined &&
        manifest.countsExtended.addressAliases !== 0
      ) {
        throw new VaultError("bundle declares address aliases but carries no address-aliases.jsonl");
      }
      if (atomizationReceiptsEntry !== undefined) {
        let atomizationReceiptCount = 0;
        for (const row of readJsonlSync<Record<string, unknown>>(
          atomizationReceiptsEntry.path,
          Math.min(limits.maxLineBytes, BUNDLE_DERIVED_LIMITS.atomizationReceiptRowBytes),
        )) {
          assertBundleAtomizationReceipt(vault, row, manifest.threadId, "import", threadId);
          insertRow(vault, "atomization_receipt", { ...row, thread_id: threadId });
          atomizationReceiptCount += 1;
          loadedRows += 1;
        }
        if (atomizationReceiptCount !== (manifest.countsExtended?.atomizationReceipts ?? 0)) {
          throw new VaultError(
            `bundle declares ${manifest.countsExtended?.atomizationReceipts ?? 0} atomization receipts and carries ${atomizationReceiptCount}`,
          );
        }
      } else if (
        manifest.countsExtended?.atomizationReceipts !== undefined &&
        manifest.countsExtended.atomizationReceipts !== 0
      ) {
        throw new VaultError(
          "bundle declares atomization receipts but carries no atomization-receipts.jsonl",
        );
      }
      counters["atoms.supported"] = 0;
      counters["atoms.historical"] = 0;
      counters["atoms.proposed"] = 0;
      counters[COUNTERS.capsules] = capsuleCount;
      for (const phase of ["SUPPORTED", "HISTORICAL", "PROPOSED"]) {
        counters[`atoms.${phase.toLowerCase()}`] = Number(
          (
            vault.db
              .query("SELECT COUNT(*) AS count FROM atom WHERE thread_id = ? AND phase = ?")
              .get(threadId, phase) as {
              count: number;
            }
          ).count,
        );
      }
      counters.losses = Number(
        (
          vault.db
            .query("SELECT COUNT(*) AS count FROM loss WHERE thread_id = ? AND resolved_by IS NULL")
            .get(threadId) as { count: number }
        ).count,
      );
      vault.bump(threadId, counters);
      vault.db
        .query("UPDATE thread SET head_seq = ?, head_hash = ? WHERE id = ?")
        .run(last?.seq ?? 0, last?.hash ?? manifest.headHash, threadId);
      if (!manifest.partial) {
        vault.db
          .query(
            "INSERT OR REPLACE INTO capsule_source_readiness " +
              "(thread_id, status, checked_through, seq, reason, checked_at) " +
              "VALUES (?, 'ready', ?, NULL, NULL, ?)",
          )
          .run(threadId, last?.seq ?? 0, Date.now());
        seedImportedCheckpoints(vault, threadId);
      }
      const verified = manifest.partial ? null : verify(vault, threadId, { full: true });
      if (verified !== null && !verified.ok) {
        throw new VaultError(
          `imported chain failed verification${verified.failedAt === undefined ? "" : ` at #${verified.failedAt}`}: ${verified.reason ?? "unknown reason"}`,
        );
      }
      const sample = vault.capsules.list(threadId, 0, Math.max(1, options.sampleCapsules ?? 8));
      checkLedgerSample(vault, threadId, sample, options.sampleCapsules ?? 8);
      for (const entry of entries) {
        if (!entry.name.startsWith("objects/")) continue;
        const hash = entry.name.slice("objects/".length);
        vault.db
          .query("INSERT OR IGNORE INTO blob (hash, mime, size, created_at) VALUES (?, ?, ?, ?)")
          .run(hash, null, entry.size, Date.now());
      }
      installFragmentMarker(vault, threadId, manifest, header.partial);
      return {
        threadId,
        headSeq: last?.seq ?? 0,
        headHash: last?.hash ?? manifest.headHash,
        episodes: episodeCount,
        verified: verified?.ok ?? false,
        ...(manifest.partial ? { fragmentVerified: true } : {}),
        manifest,
      };
    });
    // `vault.tx` promoted the registered objects synchronously after SQLite
    // committed. A kill in that tiny window is completed by Vault startup.
    reportCommittedProgress(
      options.onProgress,
      "loading",
      stagedBytes,
      entries.length,
      0,
      stagedBytes,
      loadedRows,
    );
    reportCommittedProgress(
      options.onProgress,
      "done",
      stagedBytes,
      entries.length,
      0,
      stagedBytes,
      loadedRows,
    );
    return result;
  } catch (error) {
    // Before registration this function still owns the private stage. Once
    // registered, Vault transaction rollback/commit/recovery owns its fate.
    if (promotionOwned) discardBlobPromotion(promotion);
    throw error;
  }
}

export async function importBundle(
  vault: Vault,
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult> {
  const limits = { ...BUNDLE_LIMITS, ...(options.limits ?? {}) };
  if (bytes.byteLength > Math.min(limits.maxBundleBytes, COMPATIBILITY_MAX_BYTES)) {
    throw new VaultError("bundle exceeds the compatibility byte limit; use importBundleStream");
  }
  if (bytes.byteLength < BUNDLE_MAGIC.length + 4) throw new VaultError("truncated .pylos bundle");
  const magic = new TextDecoder().decode(bytes.subarray(0, BUNDLE_MAGIC.length));
  if (magic !== BUNDLE_MAGIC) throw new VaultError("not a .pylos bundle");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pointer = BUNDLE_MAGIC.length;
  const headerLength = view.getUint32(pointer, true);
  pointer += 4;
  if (headerLength > limits.maxHeaderBytes || headerLength > bytes.byteLength - pointer) {
    throw new VaultError("bundle header exceeds the header byte limit");
  }
  const headerBytes = bytes.subarray(pointer, pointer + headerLength);
  pointer += headerLength;
  let header: BundleHeader;
  try {
    header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes)) as BundleHeader;
  } catch {
    throw new VaultError("bundle header is not valid JSON");
  }
  validateBundleHeader(header);
  assertImportThreadOverride(header, options.threadId);
  if (header.v === 2) return importBundleStream(vault, bytesToStream(bytes), options);
  const archiveLimits = legacyCompatibilityLimits(limits);

  const key = await deriveKey(options.passphrase, unb64(header.salt));
  const nonceBase = unb64(header.nonce);
  const chunks: Uint8Array[] = [];
  let counter = 0;
  let archiveBytes = 0;
  for (;;) {
    if (pointer + 4 > bytes.length) throw new VaultError("truncated bundle frame");
    const length = view.getUint32(pointer, true);
    pointer += 4;
    if (length === 0) break;
    if (counter >= archiveLimits.maxFrames) throw new VaultError("bundle has too many encrypted frames");
    if (length > archiveLimits.maxFrameBytes || length > bytes.length - pointer) {
      throw new VaultError("bundle frame exceeds the frame byte limit");
    }
    const cipher = bytes.subarray(pointer, pointer + length);
    pointer += length;
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: chunkNonce(nonceBase, counter) as BufferSource,
          additionalData: headerBytes as BufferSource,
        },
        key,
        cipher as BufferSource,
      );
    } catch {
      throw new VaultError("decryption failed — wrong passphrase or corrupt bundle");
    }
    const part = new Uint8Array(plain);
    archiveBytes += part.byteLength;
    if (archiveBytes > archiveLimits.maxArchiveBytes)
      throw new VaultError("bundle exceeds the archive byte limit");
    chunks.push(part);
    counter += 1;
  }
  if (pointer !== bytes.length) throw new VaultError("trailing bytes after bundle terminator");

  const archive = unzip(concat(chunks), {
    maxEntries: archiveLimits.maxEntries,
    maxEntryBytes: archiveLimits.maxEntryBytes,
    maxTotalBytes: archiveLimits.maxArchiveBytes,
  });
  const manifestBytes = archive.get("manifest.json");
  if (manifestBytes == null) throw new VaultError("bundle has no manifest");
  if (manifestBytes.byteLength > Math.min(archiveLimits.maxEntryBytes, MAX_MANIFEST_BYTES)) {
    throw new VaultError("bundle manifest is too large");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown;
  } catch {
    throw new VaultError("bundle manifest is not valid JSON");
  }
  validateBundleManifest(manifest, header, 1);
  const fileNames = Object.keys(manifest.files);
  if (fileNames.length > archiveLimits.maxEntries) throw new VaultError("bundle manifest has too many files");
  const expected = new Set(["manifest.json", ...fileNames]);
  if (archive.size !== expected.size || [...archive.keys()].some((name) => !expected.has(name))) {
    throw new VaultError("bundle contains an unlisted file");
  }
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!isSafeBundleName(name)) throw new VaultError(`unsafe bundle file ${name}`);
    const data = archive.get(name);
    if (data === undefined) throw new VaultError(`bundle missing ${name}`);
    if (sha256(data) !== digest) throw new VaultError(`bundle file ${name} failed its digest`);
    if (name.startsWith("objects/")) {
      const objectHash = name.slice("objects/".length);
      if (!/^[0-9a-f]{64}$/.test(objectHash) || sha256(data) !== objectHash) {
        throw new VaultError(`bundle object ${name} failed its filename hash`);
      }
    }
  }

  const episodes = parseJsonl<Episode & { contentHash?: string }>(
    archive.get("episodes.jsonl"),
    limits.maxLineBytes,
  );
  const atoms = parseJsonl<AtomRow>(archive.get("atoms.jsonl"), derivedRowLineLimit("atom", limits));
  const capsules = parseJsonl<StoredCapsule>(
    archive.get("capsules.jsonl"),
    derivedRowLineLimit("capsule", limits),
  );
  const loss = parseJsonl<Record<string, unknown>>(
    archive.get("loss.jsonl"),
    derivedRowLineLimit("loss", limits),
  );
  for (const row of atoms) assertBundleDerivedRow("atom", row, "import");
  for (const row of capsules) assertBundleDerivedRow("capsule", row, "import");
  for (const row of loss) assertBundleDerivedRow("loss", row, "import");
  const packets = parseJsonl<Record<string, unknown>>(archive.get("packets.jsonl"), limits.maxLineBytes);
  for (const row of packets) assertBundlePacket(row, manifest.threadId, "import");
  const tombstones = parseJsonl<Record<string, unknown>>(
    archive.get("tombstones.jsonl"),
    limits.maxLineBytes,
  );
  const addressRoutes = parseJsonl<Record<string, unknown>>(
    archive.get("address-routes.jsonl"),
    limits.maxLineBytes,
  );
  const addressAliases = parseJsonl<Record<string, unknown>>(
    archive.get("address-aliases.jsonl"),
    Math.min(limits.maxLineBytes, MAX_ADDRESS_ALIAS_LINE_BYTES),
  );
  if (atoms.length !== manifest.counts.atoms) {
    throw new VaultError(`bundle declares ${manifest.counts.atoms} atoms and carries ${atoms.length}`);
  }
  if (capsules.length !== manifest.counts.capsules) {
    throw new VaultError(
      `bundle declares ${manifest.counts.capsules} capsules and carries ${capsules.length}`,
    );
  }
  if (loss.length !== manifest.counts.loss) {
    throw new VaultError(`bundle declares ${manifest.counts.loss} losses and carries ${loss.length}`);
  }
  for (const row of addressAliases) assertBundleAddressAlias(row, manifest.threadId, "import");
  for (const row of addressRoutes) {
    const routeFailure = addressRouteRowBoundsFailure(row);
    if (routeFailure !== null) throw new VaultError(`invalid address route import: ${routeFailure}`);
  }
  if (packets.length !== manifest.counts.packets) {
    throw new VaultError(`bundle declares ${manifest.counts.packets} packets and carries ${packets.length}`);
  }
  if (tombstones.length !== (manifest.countsExtended?.tombstones ?? 0)) {
    throw new VaultError(
      `bundle declares ${manifest.countsExtended?.tombstones ?? 0} tombstones and carries ${tombstones.length}`,
    );
  }
  if (addressRoutes.length !== (manifest.countsExtended?.addressRoutes ?? 0)) {
    throw new VaultError(
      `bundle declares ${manifest.countsExtended?.addressRoutes ?? 0} address routes and carries ${addressRoutes.length}`,
    );
  }
  if (addressAliases.length !== (manifest.countsExtended?.addressAliases ?? 0)) {
    throw new VaultError(
      `bundle declares ${manifest.countsExtended?.addressAliases ?? 0} address aliases and carries ${addressAliases.length}`,
    );
  }

  const chainValidator = new BundleEpisodeChainValidator(manifest, header);
  const validatedContentHashes = episodes.map((episode) => chainValidator.accept(episode));
  chainValidator.finish();

  // The v1 archive predates A12 and only named one whole object in meta.blob.
  // Normalize it before the transaction so every imported attachment has an
  // explicit, hash-bound opaque span. New manifests are validated against every
  // object span here as well; no target rows or object files exist yet.
  const normalizedEpisodes = episodes.map((episode) => normalizeAttachmentEpisode(episode, archive));
  const legacySourceFailure = manifest.partial
    ? undefined
    : normalizedEpisodes
        .map((episode) => ({ episode, failure: capsuleSourceContentFailure(episode.content) }))
        .find((candidate) => candidate.failure !== null);

  const threadId = options.threadId ?? manifest.threadId;
  const existing = vault.threads.get(threadId);
  if (existing !== null) {
    throw new VaultError(`thread ${threadId} already exists in this vault`);
  }

  const promotion = createBlobPromotion(vault.objectsDir);
  let promotionOwned = true;
  try {
    for (const [name, data] of archive) {
      if (!name.startsWith("objects/")) continue;
      stageBlobBytesForPromotion(promotion, data, name.slice("objects/".length));
    }
    // Child-process crash oracle only: every compatibility object is verified
    // and fsynced under the private promotion journal, but no import row has
    // entered SQLite. This is the exact legacy pre-commit recovery boundary.
    injectLegacyStagedBlobFault();
    reportProgress(options.onProgress, "installing", archiveBytes, archive.size, CHUNK_SIZE);
    const result = vault.txWithPendingBlobPromotion(promotion, () => {
      promotionOwned = false;
      if (existing === null) {
        vault.db
          .query(
            "INSERT INTO thread (id, title, created_at, head_seq, head_hash, settings) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            threadId,
            manifest.title,
            manifest.createdAt,
            0,
            manifest.headHash,
            canonicalJson(manifest.settings ?? {}),
          );
      }
      const insert = vault.db.prepare(
        "INSERT INTO episode (seq, thread_id, ts, role, model, provider, content, content_hash, tokens, prev_hash, hash, meta) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const fts = vault.db.prepare("INSERT INTO episode_fts (rowid, content) VALUES (?, ?)");
      let bytes = 0;
      const counters: Record<string, number> = {};
      for (const [index, episode] of normalizedEpisodes.entries()) {
        const meta = episode.meta ?? {};
        const row = insert.run(
          episode.seq,
          threadId,
          episode.ts,
          episode.role,
          episode.model ?? null,
          episode.provider ?? null,
          episode.content,
          validatedContentHashes[index] as string,
          episode.tokens,
          episode.prevHash,
          episode.hash,
          canonicalJson(meta),
        );
        if (meta.removed !== true) fts.run(Number(row.lastInsertRowid), episode.content);
        if (episode.role === "attachment" && meta.removed !== true)
          vault.indexAttachmentName(threadId, episode.seq, meta);
        bytes += Buffer.byteLength(episode.content);
        counters.episodes = (counters.episodes ?? 0) + 1;
        const roleKey =
          episode.role === "user"
            ? "episodes.user"
            : episode.role === "assistant"
              ? "episodes.assistant"
              : "episodes.other";
        counters[roleKey] = (counters[roleKey] ?? 0) + 1;
      }
      counters.bytes = bytes;
      for (const atom of atoms) {
        const row = { ...atom, thread_id: threadId };
        insertRow(vault, "atom", row);
        // `atom_name` is derived, so it is not in the bundle; without it an imported
        // thread cannot route a question by an atom's subject (KERNEL A11.4). The
        // counters are set below, so the index is rebuilt without `atoms.insert`.
        vault.atoms.indexNames(toAtom(row));
      }
      for (const capsule of capsules) insertCapsuleRow(vault, threadId, capsule);
      for (const row of loss) {
        const { id: _id, ...rest } = row;
        insertRow(vault, "loss", { ...rest, thread_id: threadId });
      }
      assertImportedDerivedTopology(vault, threadId, manifest.headSeq);
      // The receipts travel with the archive (KERNEL A10.7): an imported thread can
      // still show what each turn was compiled from, and re-render the older
      // packets from `resident[]`.
      for (const row of packets) insertRow(vault, "packet", { ...row, thread_id: threadId });
      for (const row of tombstones) insertRow(vault, "tombstone", { ...row, thread_id: threadId });
      for (const row of addressRoutes) insertRow(vault, "address_route", { ...row, thread_id: threadId });
      for (const row of addressAliases) insertRow(vault, "address_alias", { ...row, thread_id: threadId });
      counters["atoms.supported"] = atoms.filter((a) => a.phase === "SUPPORTED").length;
      counters["atoms.historical"] = atoms.filter((a) => a.phase === "HISTORICAL").length;
      counters["atoms.proposed"] = atoms.filter((a) => a.phase === "PROPOSED").length;
      counters[COUNTERS.capsules] = capsules.length;
      counters.losses = loss.filter((l) => l.resolved_by === null || l.resolved_by === undefined).length;
      vault.bump(threadId, counters);

      const last = normalizedEpisodes.at(-1);
      vault.db
        .query("UPDATE thread SET head_seq = ?, head_hash = ? WHERE id = ?")
        .run(last?.seq ?? 0, last?.hash ?? manifest.headHash, threadId);

      if (!manifest.partial) {
        if (legacySourceFailure === undefined) {
          vault.db
            .query(
              "INSERT OR REPLACE INTO capsule_source_readiness " +
                "(thread_id, status, checked_through, seq, reason, checked_at) " +
                "VALUES (?, 'ready', ?, NULL, NULL, ?)",
            )
            .run(threadId, last?.seq ?? 0, Date.now());
        } else {
          vault.db
            .query(
              "INSERT OR REPLACE INTO capsule_source_readiness " +
                "(thread_id, status, checked_through, seq, reason, checked_at) " +
                "VALUES (?, 'noncompactable', ?, ?, ?, ?)",
            )
            .run(
              threadId,
              Math.max(0, legacySourceFailure.episode.seq - 1),
              legacySourceFailure.episode.seq,
              legacySourceFailure.failure,
              Date.now(),
            );
        }
        seedImportedCheckpoints(vault, threadId);
      }
      const verified = manifest.partial ? null : verify(vault, threadId, { full: true });
      if (verified !== null && !verified.ok) {
        throw new VaultError(
          `imported chain failed verification${verified.failedAt === undefined ? "" : ` at #${verified.failedAt}`}: ${verified.reason ?? "unknown reason"}`,
        );
      }
      checkLedgerSample(vault, threadId, capsules, options.sampleCapsules ?? 8);
      // Rows authorize promotion only after this transaction commits. Until
      // then every canonical object remains under the private pending name.
      for (const [name, data] of archive) {
        if (!name.startsWith("objects/")) continue;
        vault.db
          .query("INSERT OR IGNORE INTO blob (hash, mime, size, created_at) VALUES (?, ?, ?, ?)")
          .run(name.slice("objects/".length), null, data.byteLength, Date.now());
      }
      installFragmentMarker(vault, threadId, manifest, header.partial);
      return {
        threadId,
        headSeq: last?.seq ?? 0,
        headHash: last?.hash ?? manifest.headHash,
        episodes: episodes.length,
        verified: verified?.ok ?? false,
        ...(manifest.partial ? { fragmentVerified: true } : {}),
        manifest,
      };
    });
    return result;
  } catch (error) {
    if (promotionOwned) discardBlobPromotion(promotion);
    throw error;
  }
}

/**
 * KERNEL A7: recompute `dropped()` for a sample of leaf capsules straight from
 * the episodes and refuse the import if the bundled ledger disagrees.
 */
function checkLedgerSample(
  vault: Vault,
  threadId: string,
  capsules: readonly StoredCapsule[],
  sample: number,
): void {
  const leaves = capsules.filter((c) => c.level === 0);
  if (leaves.length === 0 || sample <= 0) return;
  const step = Math.max(1, Math.floor(leaves.length / sample));
  for (let i = 0; i < leaves.length; i += step) {
    const capsule = leaves[i] as StoredCapsule;
    if (capsule.ledgerReceipt !== undefined) continue;
    const present = new Set(names(capsule.text, { max: 4096 }).map((hit) => hit.name));
    const legacyStored = new Set(capsule.dropped.map((d) => d.name));
    const requireAccounted = (name: string): void => {
      if (name.length === 0 || present.has(name) || legacyStored.has(name)) return;
      throw new VaultError(
        `bundle ledger disagrees with episodes for capsule ${capsule.id}: "${name}" is missing`,
      );
    };
    try {
      for (const source of sourceNamesForRangeStream(vault, threadId, capsule.fromSeq, capsule.toSeq))
        requireAccounted(source.name);
    } catch (error) {
      if (!(error instanceof VaultError) || !error.message.includes("capsule source")) throw error;
      // Historical v1 custody can predate source-work receipts. Its exact
      // episodes remain readable, while append admission quarantines an
      // uncompactable tail instead of letting a later turn commit into a wedge.
    }
  }
}

const BUNDLE_ALLOWED_COLUMNS: Record<string, ReadonlySet<string>> = {
  atom: new Set([
    "id",
    "thread_id",
    "kind",
    "key",
    "value",
    "text",
    "source_seq",
    "source_span",
    "valid_from_seq",
    "valid_to_seq",
    "superseded_by",
    "phase",
    "authority",
    "scope",
    "pinned",
    "confidence",
    "created_by",
    "created_at",
  ]),
  loss: new Set(["thread_id", "capsule_id", "name", "kind", "level", "seq", "span", "resolved_by"]),
  capsule: new Set([
    "id",
    "thread_id",
    "level",
    "from_seq",
    "to_seq",
    "text",
    "tokens",
    "dropped",
    "carried_count",
    "kept",
    "ledger_receipt",
    "hash",
    "created_by",
    "created_at",
  ]),
  capsule_ledger_entry: new Set([
    "thread_id",
    "capsule_id",
    "part",
    "ordinal",
    "name",
    "kind",
    "seq",
    "span",
  ]),
  packet: new Set([
    "id",
    "thread_id",
    "turn_seq",
    "model",
    "budget",
    "tokens",
    "digest",
    "status",
    "compiler_version",
    "messages",
    "resident",
    "ledger",
    "pages",
    "rounds",
    "reachability",
    "reachability_as_of_seq",
    "coverage",
    "evidence",
    "answer_receipt",
    "semantic",
    "created_at",
  ]),
  tombstone: new Set(["id", "thread_id", "target", "reason", "created_at", "removal_seq", "echoes"]),
  address_route: new Set([
    "id",
    "thread_id",
    "query_digest",
    "normalized_query",
    "router_version",
    "question_seq",
    "answer_seq",
    "packet_id",
    "packet_digest",
    "source_seqs",
    "witnesses",
    "route_digest",
    "status",
    "reason",
    "invalidated_by",
    "created_at",
  ]),
  atomization_receipt: new Set([
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
  ]),
  address_alias: new Set([
    "id",
    "thread_id",
    "alias",
    "source_seq",
    "byte_from",
    "byte_to",
    "source_hash",
    "quote_hash",
    "authority",
    "status",
    "created_at",
  ]),
};

function insertCapsuleRow(vault: Vault, threadId: string, capsule: StoredCapsule): void {
  insertRow(vault, "capsule", {
    id: capsule.id,
    thread_id: threadId,
    level: capsule.level,
    from_seq: capsule.fromSeq,
    to_seq: capsule.toSeq,
    text: capsule.text,
    tokens: capsule.tokens,
    dropped: canonicalJson(capsule.dropped),
    carried_count: capsule.carriedCount,
    kept: canonicalJson(capsule.kept ?? []),
    ledger_receipt: capsule.ledgerReceipt === undefined ? null : canonicalJson(capsule.ledgerReceipt),
    hash: capsule.hash,
    created_by: capsule.createdBy,
    created_at: capsule.createdAt,
  });
}

function insertRow(vault: Vault, table: string, row: Record<string, unknown>): void {
  const columns = BUNDLE_ALLOWED_COLUMNS[table];
  if (columns === undefined) throw new VaultError(`bundle cannot write table ${table}`);
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  if (keys.length === 0 || keys.some((key) => !columns.has(key))) {
    throw new VaultError("bundle row contains an unsafe column name");
  }
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  vault.db.prepare(sql).run(...(keys.map((k) => row[k] ?? null) as never[]));
}

function jsonl(rows: readonly unknown[], budget: LegacyMaterializationBudget): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const bytes = encoder.encode(`${index === 0 ? "" : "\n"}${JSON.stringify(rows[index])}`);
    budget.consume(bytes.byteLength);
    chunks.push(bytes);
  }
  return concat(chunks);
}

function parseJsonl<T>(bytes: Uint8Array | undefined, maxLineBytes = BUNDLE_LIMITS.maxLineBytes): T[] {
  if (bytes === undefined || bytes.length === 0) return [];
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const rows: T[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > maxLineBytes) throw new VaultError("bundle JSONL line exceeds the line byte limit");
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      try {
        rows.push(JSON.parse(trimmed) as T);
      } catch {
        throw new VaultError(`invalid JSONL at byte ${offset}`);
      }
    }
    offset += lineBytes + 1;
  }
  return rows;
}

function isSafeBundleName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  );
}

function normalizeAttachmentEpisode(
  episode: Episode & { contentHash?: string },
  archive: Map<string, Uint8Array>,
): Episode & { contentHash?: string } {
  if (episode.role !== "attachment") return episode;
  const meta = episode.meta ?? {};
  const blob = typeof meta.blob === "string" ? meta.blob : undefined;
  let manifest = meta.manifest;
  if (manifest === undefined && blob !== undefined) {
    const bytes = archive.get(`objects/${blob}`);
    if (bytes === undefined) throw new VaultError(`bundle missing attachment object ${blob}`);
    if (sha256(bytes) !== blob) throw new VaultError(`attachment object ${blob} failed its hash`);
    manifest = legacyAttachmentManifest(episode, blob, bytes);
  }
  if (manifest !== undefined) {
    if (!manifestPartitionValid(manifest)) {
      throw new VaultError(`attachment ${episode.seq} has an invalid manifest partition`);
    }
    const { digest, legacy: _legacy, ...manifestBase } = manifest;
    if (typeof digest !== "string" || canonicalHash(manifestBase) !== digest) {
      throw new VaultError(`attachment ${episode.seq} has an invalid manifest digest`);
    }
    if (!/^[0-9a-f]{64}$/.test(manifest.hash)) {
      throw new VaultError(`attachment ${episode.seq} has an invalid whole-object hash`);
    }
    if (!Number.isSafeInteger(manifest.size) || manifest.size < 0) {
      throw new VaultError(`attachment ${episode.seq} has an invalid byte size`);
    }
    if (!Array.isArray(manifest.spans) || manifest.spans.length === 0) {
      throw new VaultError(`attachment ${episode.seq} has no byte spans`);
    }
    const whole = createHash("sha256");
    let wholeSize = 0;
    for (const span of manifest.spans) {
      if (
        !Number.isSafeInteger(span.from) ||
        !Number.isSafeInteger(span.to) ||
        span.from < 0 ||
        span.to < span.from ||
        span.to > manifest.size ||
        !/^[0-9a-f]{64}$/.test(span.objectHash)
      ) {
        throw new VaultError(`attachment ${episode.seq} has an invalid span`);
      }
      const object = archive.get(`objects/${span.objectHash}`);
      if (object === undefined) throw new VaultError(`bundle missing attachment span ${span.objectHash}`);
      if (sha256(object) !== span.objectHash) {
        throw new VaultError(`attachment span ${span.objectHash} failed its hash`);
      }
      if (object.byteLength !== span.to - span.from) {
        throw new VaultError(`attachment span ${span.objectHash} has an invalid length`);
      }
      whole.update(object);
      wholeSize += object.byteLength;
    }
    verifyAttachmentWholeHash(episode, manifest, blob, wholeSize, whole.digest("hex"));
    const wholeObject = blob === undefined ? undefined : archive.get(`objects/${blob}`);
    if (wholeObject === undefined) {
      throw new VaultError(`attachment ${episode.seq} is missing its whole attachment object`);
    }
    if (wholeObject.byteLength !== manifest.size || sha256(wholeObject) !== manifest.hash) {
      throw new VaultError(`attachment ${episode.seq} whole attachment object failed its hash or length`);
    }
  }
  if (manifest === meta.manifest) return episode;
  return { ...episode, meta: { ...meta, manifest } };
}

function legacyAttachmentManifest(
  episode: Episode,
  hash: string,
  bytes: Uint8Array,
): NonNullable<Episode["meta"]["manifest"]> {
  const base = {
    id: `legacy:${episode.seq}:${hash.slice(0, 16)}`,
    hash,
    size: bytes.byteLength,
    mime: episode.meta.mime ?? "application/octet-stream",
    name: episode.meta.name ?? episode.content,
    chunkSize: bytes.byteLength,
    spans: [
      {
        ordinal: 0,
        from: 0,
        to: bytes.byteLength,
        hash,
        state: "opaque" as const,
        objectHash: hash,
      },
    ],
  };
  return {
    ...base,
    digest: sha256(new TextEncoder().encode(canonicalJson(base))),
    legacy: true,
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

async function collectReadable(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let complete = false;
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > COMPATIBILITY_MAX_BYTES) {
        throw new VaultError("bundle exceeds the compatibility byte-result limit; use exportBundleStream");
      }
      chunks.push(next.value);
    }
    complete = true;
  } finally {
    if (!complete) void reader.cancel("compatibility byte-result limit exceeded").catch(() => undefined);
    reader.releaseLock();
  }
  return concat(chunks);
}

export type { Atom, Capsule, LossEntry };
