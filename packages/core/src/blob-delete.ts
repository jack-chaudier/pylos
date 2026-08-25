/**
 * Crash-safe deletion staging for content-addressed attachment objects.
 *
 * Forgetting changes SQLite and the object store together, but SQLite is the
 * commit authority.  A deletion stage therefore keeps the canonical object in
 * place while the SQL transaction is open and creates a hard link under a
 * durable, same-filesystem pending directory.  After SQLite commits, the
 * journal is marked committed and the canonical link is removed.  If the
 * process dies at either boundary, startup decides from live (non-removed)
 * episode references: live references preserve/restore the object, while no
 * live reference permits both canonical and pending copies to be erased.
 *
 * This is deliberately separate from blob promotion.  Promotion uses a row
 * as an authority to install an object; deletion uses a live episode
 * reference as an authority to retain one.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ROOT_NAME = ".delete-pending";
const JOURNAL_NAME = "journal.json";
const HASH = /^[0-9a-f]{64}$/;
const READ_SIZE = 64 * 1024;
const JOURNAL_SIZE_ERROR = "blob deletion journal exceeds byte capacity";

/** Maximum distinct object entries in one deletion stage or one forget. */
export const MAX_BLOB_DELETION_ENTRIES = 65_536;
/** Maximum journal entries reconciled across all stages in one reopen. */
export const MAX_BLOB_DELETION_ENTRIES_TOTAL = 131_072;
/** Maximum UTF-8 bytes in one durable deletion journal. */
export const MAX_BLOB_DELETION_JOURNAL_BYTES = 16 * 1024 * 1024;
/** Maximum pending deletion stages scanned during one reopen or writer call. */
export const MAX_BLOB_DELETION_STAGES = 4_096;

export interface BlobDeletionEntry {
  readonly hash: string;
  readonly size: number;
}

export interface BlobDeletionStage {
  readonly objectsDir: string;
  readonly root: string;
  readonly dir: string;
  readonly journal: string;
  readonly entries: ReadonlyMap<string, BlobDeletionEntry>;
  readonly state: "prepared" | "committed";
}

interface MutableStage extends BlobDeletionStage {
  readonly entries: Map<string, BlobDeletionEntry>;
  state: "prepared" | "committed";
}

interface Journal {
  v: 1;
  state: "prepared" | "committed";
  entries: BlobDeletionEntry[];
}

/** A committed reference, or null when no surviving episode reaches hash. */
export interface LiveBlobReference {
  readonly size: number | null;
}

/**
 * Resolve a set of journaled hashes against one database snapshot.
 *
 * Recovery discovers every hash before it mutates any stage.  The batch
 * resolver is intentionally a map rather than an array so a caller cannot
 * accidentally associate a reference with the wrong content address.  A
 * missing key is a failed-closed resolver result and aborts recovery.
 */
export type LiveBlobReferenceBatch = (
  hashes: readonly string[],
) => ReadonlyMap<string, LiveBlobReference | null>;

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Distinguish an absent path from a dangling symlink or other bad entry. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function fileHash(path: string): { hash: string; size: number } | null {
  const stat = lstatOrNull(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(READ_SIZE);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return { hash: digest.digest("hex"), size: stat.size };
}

function verified(path: string, hash: string, size: number | null): boolean {
  const actual = fileHash(path);
  return actual !== null && actual.hash === hash && (size === null || actual.size === size);
}

function sameFile(left: string, right: string): boolean {
  const a = lstatOrNull(left);
  const b = lstatOrNull(right);
  if (a === null || b === null) return false;
  return (
    a.isFile() &&
    b.isFile() &&
    !a.isSymbolicLink() &&
    !b.isSymbolicLink() &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}

function parseJournal(path: string, knownStat?: Stats): Journal {
  const stat = knownStat ?? lstatOrNull(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("invalid blob deletion journal");
  }
  if (!Number.isSafeInteger(stat.size) || stat.size > MAX_BLOB_DELETION_JOURNAL_BYTES) {
    throw new Error(`${JOURNAL_SIZE_ERROR} (${MAX_BLOB_DELETION_JOURNAL_BYTES})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path, MAX_BLOB_DELETION_JOURNAL_BYTES));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(JOURNAL_SIZE_ERROR)) throw error;
    throw new Error("invalid blob deletion journal");
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("invalid blob deletion journal");
  const value = parsed as Record<string, unknown>;
  if (value.v !== 1 || (value.state !== "prepared" && value.state !== "committed")) {
    throw new Error("unsupported blob deletion journal");
  }
  if (!Array.isArray(value.entries)) throw new Error("blob deletion journal has no entries");
  if (value.entries.length > MAX_BLOB_DELETION_ENTRIES) {
    throw new Error(`blob deletion journal exceeds bounded capacity (${MAX_BLOB_DELETION_ENTRIES})`);
  }
  const entries: BlobDeletionEntry[] = [];
  const seen = new Set<string>();
  for (const item of value.entries) {
    if (item === null || typeof item !== "object") throw new Error("invalid blob deletion entry");
    const row = item as Record<string, unknown>;
    const hash = row.hash;
    const size = row.size;
    if (typeof hash !== "string" || !HASH.test(hash) || !Number.isSafeInteger(size) || Number(size) < 0) {
      throw new Error("invalid blob deletion entry");
    }
    if (seen.has(hash)) throw new Error("duplicate blob deletion entry");
    seen.add(hash);
    entries.push({ hash, size: Number(size) });
  }
  return { v: 1, state: value.state, entries };
}

function readFile(path: string, maxBytes = Number.MAX_SAFE_INTEGER): string {
  const fd = openSync(path, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.alloc(READ_SIZE);
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) {
        throw new Error(`${JOURNAL_SIZE_ERROR} (${MAX_BLOB_DELETION_JOURNAL_BYTES})`);
      }
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJournal(stage: MutableStage): void {
  const journal: Journal = {
    v: 1,
    state: stage.state,
    entries: [...stage.entries.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
  };
  const serialized = JSON.stringify(journal);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BLOB_DELETION_JOURNAL_BYTES) {
    throw new Error(`${JOURNAL_SIZE_ERROR} (${MAX_BLOB_DELETION_JOURNAL_BYTES})`);
  }
  const temporary = `${stage.journal}.tmp-${randomUUID()}`;
  writeFileSync(temporary, serialized, { mode: 0o600 });
  syncFile(temporary);
  renameSync(temporary, stage.journal);
  syncDirectory(stage.dir);
}

function removeStage(stage: BlobDeletionStage): void {
  rmSync(stage.dir, { recursive: true, force: true });
  if (lstatOrNull(stage.root) === null) return;
  syncDirectory(stage.root);
  if (directoryIsEmpty(stage.root)) {
    rmdirSync(stage.root);
    syncDirectory(stage.objectsDir);
  }
}

function directoryIsEmpty(path: string): boolean {
  const directory = opendirSync(path);
  try {
    return directory.readSync() === null;
  } finally {
    directory.closeSync();
  }
}

/** Reject a new stage before creating its directory when the root is full. */
function assertStageCapacityForCreate(root: string): void {
  const directory = opendirSync(root);
  let count = 0;
  try {
    for (;;) {
      if (directory.readSync() === null) return;
      count += 1;
      if (count >= MAX_BLOB_DELETION_STAGES) {
        throw new Error(`blob deletion stages exceed bounded capacity (${MAX_BLOB_DELETION_STAGES})`);
      }
    }
  } finally {
    directory.closeSync();
  }
}

export function createBlobDeletion(objectsDir: string): BlobDeletionStage {
  const root = join(objectsDir, ROOT_NAME);
  const existingRoot = lstatOrNull(root);
  if (existingRoot !== null && (!existingRoot.isDirectory() || existingRoot.isSymbolicLink())) {
    throw new Error("invalid blob deletion root");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertStageCapacityForCreate(root);
  syncDirectory(objectsDir);
  const dir = join(root, `delete-${process.pid}-${randomUUID()}`);
  mkdirSync(dir, { mode: 0o700 });
  const stage: MutableStage = {
    objectsDir,
    root,
    dir,
    journal: join(dir, JOURNAL_NAME),
    entries: new Map(),
    state: "prepared",
  };
  writeJournal(stage);
  syncDirectory(root);
  return stage;
}

/** Add and hard-link one object. The canonical object remains readable. */
export function stageBlobForDeletion(stage: BlobDeletionStage, hash: string, size: number): void {
  if (!HASH.test(hash) || !Number.isSafeInteger(size) || size < 0) {
    throw new Error(`invalid deletion blob ${hash}`);
  }
  const mutable = stage as MutableStage;
  if (mutable.state !== "prepared") throw new Error("blob deletion stage is committed");
  if (mutable.entries.has(hash)) return;
  if (mutable.entries.size >= MAX_BLOB_DELETION_ENTRIES) {
    throw new Error(`blob deletion stage exceeds bounded capacity (${MAX_BLOB_DELETION_ENTRIES})`);
  }
  const source = join(stage.objectsDir, hash);
  if (!verified(source, hash, size)) throw new Error(`attachment object ${hash} is missing or corrupt`);

  // Make the durable intent visible before creating the hard link. If the
  // process dies during linkSync, recovery can still discard the empty entry;
  // the canonical object has not moved and remains safe for SQL rollback.
  mutable.entries.set(hash, { hash, size });
  const pending = join(stage.dir, hash);
  try {
    writeJournal(mutable);
    linkSync(source, pending);
    if (!verified(pending, hash, size)) throw new Error(`pending deletion ${hash} failed verification`);
    syncFile(pending);
    syncDirectory(stage.dir);
  } catch (error) {
    mutable.entries.delete(hash);
    writeJournal(mutable);
    rmSync(pending, { force: true });
    throw error;
  }
}

/** Mark the SQL commit durable. Canonical files are still present until cleanup. */
export function commitBlobDeletion(stage: BlobDeletionStage): void {
  const mutable = stage as MutableStage;
  if (mutable.state === "committed") return;
  mutable.state = "committed";
  writeJournal(mutable);
  syncDirectory(stage.root);
}

/**
 * Remove only the old canonical inode. A different inode at the same hash
 * path may have been recreated after commit and is never overwritten/deleted.
 * Cleanup failure intentionally leaves the committed journal for recovery.
 */
export function cleanupBlobDeletion(
  stage: BlobDeletionStage,
  liveReference?: (hash: string) => LiveBlobReference | null,
): void {
  if (stage.state !== "committed") throw new Error("blob deletion SQL commit is not marked");
  for (const entry of stage.entries.values()) {
    const source = join(stage.objectsDir, entry.hash);
    const pending = join(stage.dir, entry.hash);
    // The caller normally invokes this inside a SQLite write transaction. A
    // new append cannot publish a live reference between this check and the
    // unlink, so a deduplicated object is never removed from under its new
    // owner. Leave the canonical link and retire only our hard link.
    const live = liveReference?.(entry.hash);
    // Read paths after the reference decision. A producer may publish a new
    // canonical inode while the callback is running; stale lstat results must
    // never cause cleanup to overwrite or unlink that inode.
    const sourceStat = lstatOrNull(source);
    const pendingStat = lstatOrNull(pending);
    if (sourceStat?.isSymbolicLink() || pendingStat?.isSymbolicLink()) {
      throw new Error(`symlink at deletion object ${entry.hash}`);
    }
    if (live !== undefined && live !== null) {
      if (sourceStat !== null) {
        if (!sourceStat.isFile()) throw new Error(`live object ${entry.hash} is not a regular file`);
        if (!verified(source, entry.hash, live.size ?? entry.size)) {
          throw new Error(`live object ${entry.hash} failed verification`);
        }
        rmSync(pending, { force: true });
      } else if (pendingStat !== null) {
        if (!pendingStat.isFile()) throw new Error(`pending deletion ${entry.hash} is not a regular file`);
        if (!verified(pending, entry.hash, live.size ?? entry.size)) {
          throw new Error(`live pending object ${entry.hash} failed verification`);
        }
        renameSync(pending, source);
        syncDirectory(stage.objectsDir);
      } else {
        throw new Error(`live object ${entry.hash} is missing from canonical and pending paths`);
      }
      continue;
    }
    if (pendingStat !== null && !pendingStat.isFile()) {
      throw new Error(`pending deletion ${entry.hash} is not a regular file`);
    }
    if (pendingStat !== null && !verified(pending, entry.hash, entry.size)) {
      throw new Error(`pending deletion ${entry.hash} failed verification`);
    }
    if (sameFile(source, pending)) {
      unlinkSync(source);
    } else if (sourceStat !== null) {
      if (!sourceStat.isFile()) throw new Error(`recreated object ${entry.hash} is not a regular file`);
      // A recreated matching object is outside this stage. Verify it before
      // making the callback-backed live-reference decision.
      if (!verified(source, entry.hash, entry.size)) {
        throw new Error(`recreated object ${entry.hash} failed verification`);
      }
      // In the production Vault caller the callback was evaluated under the
      // same SQLite write lock. A matching inode with no row/reference is an
      // orphan and can be removed; with no callback, keep it conservatively.
      if (liveReference !== undefined) unlinkSync(source);
    }
    rmSync(pending, { force: true });
  }
  syncDirectory(stage.objectsDir);
  removeStage(stage);
}

/** Roll back a still-uncommitted stage; canonical objects were never moved. */
export function discardBlobDeletion(stage: BlobDeletionStage): void {
  if (stage.state === "committed") return;
  removeStage(stage);
}

function cleanupUnreferenced(objectsDir: string, dir: string, entries: readonly BlobDeletionEntry[]): void {
  for (const entry of entries) {
    const pending = join(dir, entry.hash);
    const target = join(objectsDir, entry.hash);
    const targetStat = lstatOrNull(target);
    const pendingStat = lstatOrNull(pending);
    if (targetStat?.isSymbolicLink() || pendingStat?.isSymbolicLink()) {
      throw new Error(`symlink at deletion object ${entry.hash}`);
    }
    if (targetStat !== null && !targetStat.isFile()) {
      throw new Error(`object ${entry.hash} at its address is not a regular file`);
    }
    if (pendingStat !== null && !pendingStat.isFile()) {
      throw new Error(`pending deletion ${entry.hash} is not a regular file`);
    }
    const live = fileHash(target);
    if (live !== null && live.hash !== entry.hash) {
      // Never delete or replace an inode that no longer satisfies its address.
      // The journal remains so an operator can repair the corrupt store.
      throw new Error(`object ${entry.hash} at its address failed verification`);
    }
    rmSync(pending, { force: true });
    rmSync(target, { force: true });
  }
}

/** Recover every interrupted deletion after SQLite WAL replay. */
export function recoverBlobDeletions(
  objectsDir: string,
  liveReference: (hash: string) => LiveBlobReference | null,
): void {
  recoverBlobDeletionsBatched(objectsDir, (hashes) => {
    const references = new Map<string, LiveBlobReference | null>();
    for (const hash of hashes) references.set(hash, liveReference(hash));
    return references;
  });
}

/**
 * Recover every interrupted deletion after SQLite WAL replay with one
 * live-reference resolution pass.  The historical single-hash API above is
 * retained for callers that do not have a batch-capable store; Vault uses
 * this path so reopening a vault does not rescan every episode once per
 * staged object hash.
 */
export function recoverBlobDeletionsBatched(
  objectsDir: string,
  liveReferences: LiveBlobReferenceBatch,
): void {
  const root = join(objectsDir, ROOT_NAME);
  const rootStat = lstatOrNull(root);
  if (rootStat === null) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid blob deletion root");
  const stages: Array<{ dir: string; journal: Journal }> = [];
  const hashes = new Set<string>();
  let totalEntries = 0;

  // Read and validate every durable journal before asking the database for a
  // decision.  This keeps malformed stages fail-closed and makes the set of
  // hashes supplied to the resolver complete and deterministic.
  const directory = opendirSync(root);
  let stageCount = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      stageCount += 1;
      if (stageCount > MAX_BLOB_DELETION_STAGES) {
        throw new Error(`blob deletion stages exceed bounded capacity (${MAX_BLOB_DELETION_STAGES})`);
      }
      const dir = join(root, entry.name);
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid blob deletion stage");
      const journalPath = join(dir, JOURNAL_NAME);
      const journalStat = lstatSync(journalPath);
      if (!journalStat.isFile() || journalStat.isSymbolicLink()) {
        throw new Error("invalid blob deletion journal");
      }
      const journal = parseJournal(journalPath, journalStat);
      totalEntries += journal.entries.length;
      if (totalEntries > MAX_BLOB_DELETION_ENTRIES_TOTAL) {
        throw new Error(
          `blob deletion journals exceed bounded capacity (${MAX_BLOB_DELETION_ENTRIES_TOTAL})`,
        );
      }
      for (const journalEntry of journal.entries) {
        const pending = join(dir, journalEntry.hash);
        const pendingStat = lstatOrNull(pending);
        if (pendingStat !== null) {
          if (!pendingStat.isFile() || pendingStat.isSymbolicLink()) {
            throw new Error(`invalid pending deletion ${journalEntry.hash}`);
          }
        }
        hashes.add(journalEntry.hash);
      }
      stages.push({ dir, journal });
    }
  } finally {
    directory.closeSync();
  }

  const requested = [...hashes].sort();
  const references =
    requested.length === 0 ? new Map<string, LiveBlobReference | null>() : liveReferences(requested);
  for (const hash of requested) {
    if (!references.has(hash)) throw new Error(`missing live-reference decision for ${hash}`);
  }

  for (const stage of stages) {
    for (const entry of stage.journal.entries) {
      // Presence was checked above.  Keep the explicit lookup here so an
      // implementation cannot silently turn an absent decision into an
      // unreferenced object and delete bytes on a resolver bug.
      const live = references.get(entry.hash);
      if (live === undefined) throw new Error(`missing live-reference decision for ${entry.hash}`);
      if (live !== null) {
        const target = join(objectsDir, entry.hash);
        const targetStat = lstatOrNull(target);
        const pending = join(stage.dir, entry.hash);
        const pendingStat = lstatOrNull(pending);
        if (targetStat?.isSymbolicLink()) throw new Error(`symlink at live object ${entry.hash}`);
        if (targetStat !== null) {
          if (!targetStat.isFile()) throw new Error(`live object ${entry.hash} is not a regular file`);
          if (!verified(target, entry.hash, live.size ?? entry.size)) {
            throw new Error(`live object ${entry.hash} failed verification`);
          }
          rmSync(pending, { force: true });
        } else if (pendingStat !== null) {
          if (!verified(pending, entry.hash, live.size ?? entry.size)) {
            throw new Error(`live pending object ${entry.hash} failed verification`);
          }
          renameSync(pending, target);
          syncDirectory(objectsDir);
        } else {
          throw new Error(`live object ${entry.hash} is missing from canonical and pending paths`);
        }
        continue;
      }
      cleanupUnreferenced(objectsDir, stage.dir, [entry]);
    }
    syncDirectory(objectsDir);
    rmSync(stage.dir, { recursive: true, force: true });
    syncDirectory(root);
  }
  if (directoryIsEmpty(root)) {
    rmdirSync(root);
    syncDirectory(objectsDir);
  }
}
