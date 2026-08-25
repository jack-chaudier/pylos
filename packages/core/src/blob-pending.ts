/**
 * Crash-safe promotion for content-addressed blob files.
 *
 * Bytes are copied and synced under `objects/.pending/<transaction>/<sha256>`.
 * Callers commit the matching `blob` rows, then synchronously rename the files
 * into `objects/`.  Startup recovery uses the committed row as the decision:
 * install a verified pending object when the row exists, otherwise erase the
 * uncommitted plaintext.  Every operation is idempotent across another crash.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const COPY_FILE_EXCL = 1;
const HASH = /^[0-9a-f]{64}$/;
const VERIFY_BUFFER = 64 * 1024;
const PENDING = ".pending";
const IMPORT_PENDING = ".import-pending";
const COMMITTED_MARKER = ".committed";
const COMMITTED_MARKER_CONTENT = "pylos-blob-promotion-committed-v1\n";
const COMMITTED_MARKER_BYTES = Buffer.byteLength(COMMITTED_MARKER_CONTENT, "utf8");

/** Bounds for the two independent pending roots; these are not delete-journal caps. */
export const MAX_BLOB_PENDING_STAGES = 4_096;
/** Maximum object files in one promotion directory. */
export const MAX_BLOB_PROMOTION_ENTRIES = 65_536;

export interface BlobPromotion {
  readonly objectsDir: string;
  readonly root: string;
  readonly dir: string;
  readonly staged: ReadonlyMap<string, number>;
}

interface MutableBlobPromotion extends BlobPromotion {
  readonly staged: Map<string, number>;
}

export type CommittedBlob = { size: number } | null;

function ownerIsAlive(name: string): boolean {
  const match = /^import-(\d+)-/.exec(name);
  if (match === null) throw new Error("invalid pending import owner");
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid pending import owner");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
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

/** Count without retaining names; reading one entry beyond the cap fails closed. */
function boundedDirectoryCount(
  path: string,
  max: number,
  error: string,
  ignore?: (name: string) => boolean,
): number {
  const directory = opendirSync(path);
  let count = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) return count;
      if (ignore?.(entry.name) === true) continue;
      count += 1;
      if (count > max) throw new Error(`${error} (${max})`);
    }
  } finally {
    directory.closeSync();
  }
}

function preparePendingRoot(objectsDir: string, root: string, label: string): void {
  const existing = lstatOrNull(root);
  if (existing !== null && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(`invalid ${label} root`);
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const count = boundedDirectoryCount(
    root,
    MAX_BLOB_PENDING_STAGES,
    `${label} stages exceed bounded capacity`,
  );
  if (count >= MAX_BLOB_PENDING_STAGES) {
    throw new Error(`${label} stages exceed bounded capacity (${MAX_BLOB_PENDING_STAGES})`);
  }
  syncDirectory(objectsDir);
}

function readCommittedMarker(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== COMMITTED_MARKER_BYTES) {
    throw new Error("invalid committed blob promotion marker");
  }
  const fd = openSync(path, "r");
  const bytes = Buffer.alloc(COMMITTED_MARKER_BYTES);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error("invalid committed blob promotion marker");
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, null) !== 0) {
      throw new Error("invalid committed blob promotion marker");
    }
  } finally {
    closeSync(fd);
  }
  if (bytes.toString("utf8") !== COMMITTED_MARKER_CONTENT) {
    throw new Error("invalid committed blob promotion marker");
  }
}

/**
 * Mark a staged promotion only after its SQLite rows have committed. The
 * marker is itself durable, so recovery may process a stage even when the
 * original PID is still alive (for example, a same-process reopen after a
 * post-commit filesystem error).
 */
function markPromotionCommitted(promotion: BlobPromotion): void {
  const marker = join(promotion.dir, COMMITTED_MARKER);
  if (existsSync(marker)) {
    readCommittedMarker(marker);
    return;
  }
  writeFileSync(marker, COMMITTED_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
  const fd = openSync(marker, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(promotion.dir);
}

function promotionWasCommitted(dir: string): boolean {
  const marker = join(dir, COMMITTED_MARKER);
  if (lstatOrNull(marker) === null) return false;
  readCommittedMarker(marker);
  return true;
}

/** Verify a canonical or staged object without following a symlink. */
export function verifiedBlobFile(path: string, hash: string, size: number): boolean {
  if (!HASH.test(hash) || !existsSync(path)) return false;
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(path);
  } catch {
    return false;
  }
  if (!link.isFile() || link.isSymbolicLink()) return false;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size !== size) return false;
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(VERIFY_BUFFER);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
  return digest.digest("hex") === hash;
}

/** Sync an already verified canonical object before publishing a SQLite row. */
export function syncVerifiedBlobFile(path: string, hash: string, size: number): void {
  if (!verifiedBlobFile(path, hash, size)) {
    throw new Error(`canonical blob ${hash} failed its hash or length`);
  }
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeEmptyPromotion(dir: string, root: string, objectsDir: string): void {
  rmdirSync(dir);
  syncDirectory(root);
  if (directoryIsEmpty(root)) {
    rmdirSync(root);
    syncDirectory(objectsDir);
  }
}

export function createBlobPromotion(objectsDir: string): BlobPromotion {
  const root = join(objectsDir, PENDING);
  preparePendingRoot(objectsDir, root, "pending blob promotion");
  const dir = join(root, `import-${process.pid}-${randomUUID()}`);
  mkdirSync(dir, { mode: 0o700 });
  syncDirectory(root);
  return { objectsDir, root, dir, staged: new Map<string, number>() };
}

/** Import ciphertext, decrypted archives, and extracted entries live under the
 * object store so a killed process leaves them inside the startup recovery
 * domain without exposing plaintext elsewhere in the profile. */
export function createImportStage(objectsDir: string): string {
  const root = join(objectsDir, IMPORT_PENDING);
  preparePendingRoot(objectsDir, root, "pending import");
  const dir = join(root, `import-${process.pid}-${randomUUID()}`);
  mkdirSync(dir, { mode: 0o700 });
  syncDirectory(root);
  return dir;
}

export function discardImportStage(objectsDir: string, dir: string): void {
  const root = join(objectsDir, IMPORT_PENDING);
  rmSync(dir, { recursive: true, force: true });
  if (!existsSync(root)) return;
  syncDirectory(root);
  if (directoryIsEmpty(root)) {
    rmdirSync(root);
    syncDirectory(objectsDir);
  }
}

/** SQLite has already replayed its WAL when this runs. No import SQL rows can
 * be pending across process death, so every leftover stage is uncommitted and
 * its decrypted contents must be erased. */
export function recoverImportStages(objectsDir: string): void {
  const root = join(objectsDir, IMPORT_PENDING);
  const rootStat = lstatOrNull(root);
  if (rootStat === null) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid pending import root");
  boundedDirectoryCount(root, MAX_BLOB_PENDING_STAGES, "pending import stages exceed bounded capacity");
  const directory = opendirSync(root);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (ownerIsAlive(entry.name)) continue;
      const dir = join(root, entry.name);
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("invalid pending import stage");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    directory.closeSync();
  }
  syncDirectory(root);
  if (directoryIsEmpty(root)) {
    rmdirSync(root);
    syncDirectory(objectsDir);
  }
}

export function stageBlobForPromotion(
  promotion: BlobPromotion,
  source: string,
  hash: string,
  size: number,
): void {
  if (!HASH.test(hash) || !Number.isSafeInteger(size) || size < 0) {
    throw new Error(`invalid pending blob ${hash}`);
  }
  const mutable = promotion as MutableBlobPromotion;
  if (mutable.staged.has(hash)) return;
  if (mutable.staged.size >= MAX_BLOB_PROMOTION_ENTRIES) {
    throw new Error(`blob promotion entries exceed bounded capacity (${MAX_BLOB_PROMOTION_ENTRIES})`);
  }
  const pending = join(promotion.dir, hash);
  copyFileSync(source, pending, COPY_FILE_EXCL);
  finishStagedBlob(mutable, pending, hash, size);
}

/** Compatibility v1 already holds each bounded object as a byte array. Write
 * it directly into the same crash-recoverable promotion journal. */
export function stageBlobBytesForPromotion(promotion: BlobPromotion, bytes: Uint8Array, hash: string): void {
  const mutable = promotion as MutableBlobPromotion;
  if (!HASH.test(hash)) throw new Error(`invalid pending blob ${hash}`);
  if (mutable.staged.has(hash)) return;
  if (mutable.staged.size >= MAX_BLOB_PROMOTION_ENTRIES) {
    throw new Error(`blob promotion entries exceed bounded capacity (${MAX_BLOB_PROMOTION_ENTRIES})`);
  }
  const pending = join(promotion.dir, hash);
  writeFileSync(pending, bytes, { flag: "wx", mode: 0o600 });
  finishStagedBlob(mutable, pending, hash, bytes.byteLength);
}

function finishStagedBlob(
  promotion: MutableBlobPromotion,
  pending: string,
  hash: string,
  size: number,
): void {
  if (promotion.staged.size >= MAX_BLOB_PROMOTION_ENTRIES) {
    throw new Error(`blob promotion entries exceed bounded capacity (${MAX_BLOB_PROMOTION_ENTRIES})`);
  }
  if (!verifiedBlobFile(pending, hash, size)) {
    rmSync(pending, { force: true });
    throw new Error(`pending blob ${hash} failed its hash or length`);
  }
  const fd = openSync(pending, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  promotion.staged.set(hash, size);
  syncDirectory(promotion.dir);
}

/** Promote after the SQL transaction commits. No asynchronous work may occur
 * between that commit and this synchronous rename loop. */
export function commitBlobPromotion(promotion: BlobPromotion): void {
  if (promotion.staged.size > MAX_BLOB_PROMOTION_ENTRIES) {
    throw new Error(`blob promotion entries exceed bounded capacity (${MAX_BLOB_PROMOTION_ENTRIES})`);
  }
  // The public contract of this function is "after SQL commit". Recording
  // that boundary before the first rename is what makes interrupted promotion
  // recoverable even while this process's PID remains alive.
  markPromotionCommitted(promotion);
  // Child-process crash oracle only. Production paths cannot arm this hook;
  // it proves the exact post-SQL/pre-first-rename recovery window.
  if (
    process.env.NODE_ENV === "test" &&
    process.env.PYLOS_TEST_BLOB_PROMOTION_FAULT === "kill-after-commit-before-rename"
  ) {
    process.kill(process.pid, "SIGKILL");
  }
  for (const [hash, size] of promotion.staged) {
    const pending = join(promotion.dir, hash);
    const target = join(promotion.objectsDir, hash);
    if (existsSync(target)) {
      if (verifiedBlobFile(target, hash, size)) {
        rmSync(pending, { force: true });
        continue;
      }
      // A same-name writer raced the preflight with corrupt bytes. The pending
      // file was already verified and synced, so replace the invalid winner
      // atomically rather than exposing a committed row without valid bytes.
      renameSync(pending, target);
      continue;
    }
    renameSync(pending, target);
  }
  syncDirectory(promotion.objectsDir);
  rmSync(join(promotion.dir, COMMITTED_MARKER), { force: true });
  syncDirectory(promotion.dir);
  removeEmptyPromotion(promotion.dir, promotion.root, promotion.objectsDir);
}

/** Best-effort live rollback. A hard kill is handled by startup recovery. */
export function discardBlobPromotion(promotion: BlobPromotion): void {
  rmSync(promotion.dir, { recursive: true, force: true });
  if (!existsSync(promotion.root)) return;
  syncDirectory(promotion.root);
  if (directoryIsEmpty(promotion.root)) {
    rmdirSync(promotion.root);
    syncDirectory(promotion.objectsDir);
  }
}

/** Reconcile every interrupted promotion before the Vault becomes available. */
export function recoverBlobPromotions(objectsDir: string, committed: (hash: string) => CommittedBlob): void {
  const root = join(objectsDir, PENDING);
  const rootStat = lstatOrNull(root);
  if (rootStat === null) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid pending blob root");
  boundedDirectoryCount(root, MAX_BLOB_PENDING_STAGES, "pending blob stages exceed bounded capacity");
  const rootDirectory = opendirSync(root);
  try {
    for (;;) {
      const rootEntry = rootDirectory.readSync();
      if (rootEntry === null) break;
      const transaction = rootEntry.name;
      if (!transaction.startsWith("import-")) throw new Error("unknown pending blob operation");
      const dir = join(root, transaction);
      // Uncommitted stages are protected from a live writer. A committed marker
      // overrides that PID check because the SQL rows are already durable and a
      // same-process reopen must finish the rename.
      const committedStage = promotionWasCommitted(dir);
      if (!committedStage && ownerIsAlive(transaction)) continue;
      const transactionStat = lstatSync(dir);
      if (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()) {
        throw new Error("invalid pending blob transaction");
      }
      boundedDirectoryCount(
        dir,
        MAX_BLOB_PROMOTION_ENTRIES,
        "blob promotion entries exceed bounded capacity",
        (name) => name === COMMITTED_MARKER,
      );
      const directory = opendirSync(dir);
      try {
        for (;;) {
          const entry = directory.readSync();
          if (entry === null) break;
          const hash = entry.name;
          if (hash === COMMITTED_MARKER) continue;
          if (!HASH.test(hash)) throw new Error("invalid pending blob name");
          const pending = join(dir, hash);
          const pendingStat = lstatSync(pending);
          if (!pendingStat.isFile() || pendingStat.isSymbolicLink()) {
            throw new Error(`invalid pending blob ${hash}`);
          }
          const row = committed(hash);
          if (row === null) {
            rmSync(pending, { force: true });
            continue;
          }
          const target = join(objectsDir, hash);
          const pendingValid = verifiedBlobFile(pending, hash, row.size);
          const targetValid = verifiedBlobFile(target, hash, row.size);
          if (targetValid) {
            rmSync(pending, { force: true });
            continue;
          }
          if (!pendingValid) {
            throw new Error(`committed pending blob ${hash} failed its content hash`);
          }
          renameSync(pending, target);
        }
      } finally {
        directory.closeSync();
      }
      syncDirectory(objectsDir);
      rmSync(join(dir, COMMITTED_MARKER), { force: true });
      syncDirectory(dir);
      removeEmptyPromotion(dir, root, objectsDir);
    }
  } finally {
    rootDirectory.closeSync();
  }
}
