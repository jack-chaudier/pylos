/**
 * Forgetting (KERNEL §8, A5, A10.6).
 *
 * Pylos forgets only on command, and records that it did. `forget` writes a
 * tombstone, marks the atoms REVOKED, resolves the ledger rows that pointed into
 * the removed material, deletes the FTS rows and replaces the inline content
 * with `⟦removed by user · <tombstone>⟧`.
 *
 * Removing the episode is not enough: the sentence also lives in capsule text,
 * in the `messages` of the packets that carried it, and — for an attachment — in
 * `objects/`. All three are cleared here. What is *not* touched is an assistant
 * turn that restated the material: that is an episode of its own, and the
 * tombstone only names it as a candidate so the interface can ask.
 *
 * The hash chain stays valid because it is computed over the stored
 * `content_hash`, not over the stored text: the archive can prove that something
 * was there and that it was removed on request, without keeping it. Removal is
 * itself appended to the chain as a `system` episode, so `verify` can insist
 * that every removed episode has one — a `removed` flag set by hand in the
 * database fails verification instead of skipping the content check.
 */

import {
  type AtomPhase,
  type LossEntry,
  MAX_PACKET_JSON_BYTES,
  MAX_PACKET_MESSAGES_BYTES,
  MAX_PACKET_RESPONSE_BYTES,
  type PageRecord,
  type ResidentItem,
  type Seq,
} from "@pylos/protocol";
import { invalidateAddressRoutesForSourcesCount } from "./address.ts";
import { type BlobDeletionStage, MAX_BLOB_DELETION_ENTRIES } from "./blob-delete.ts";
import { rederiveCapsuleLedger, sourceNamesForRangeStream } from "./compact.ts";
import { canonicalHash } from "./hash.ts";
import { containsName } from "./page.ts";
import type { SourceName } from "./pure/ledger.ts";
import { type NameHit, names } from "./pure/names.ts";
import { approxTokens } from "./pure/tokens.ts";
import { COUNTERS } from "./schema.ts";
import { phaseCounter, type StoredCapsule, type Vault, VaultError } from "./vault.ts";

export interface ForgetTarget {
  seqs?: Seq[];
  range?: [Seq, Seq];
  atomIds?: string[];
  reason?: string;
}

export interface ForgetResult {
  tombstoneId: string;
  episodes: Seq[];
  atoms: number;
  lossRows: number;
  /** Capsules whose text was re-derived without the removed episodes. */
  capsules: number;
  /** Packets whose `messages` were cleared; their receipts are kept. */
  packets: number;
  /** Attachment hashes whose bytes were deleted (nothing else referenced them). */
  blobs: string[];
  /** True only when committed deletion cleanup remains in the durable journal. */
  cleanupPending: boolean;
  /** Assistant episodes that carry a routing name of the removed text (A10.6). */
  echoes: Seq[];
  /** Seq of the `system` episode that records this removal; 0 if nothing was removed. */
  removalSeq: Seq;
}

/** Routing names taken from each removed episode, by the kind priority of A1. */
const NAMES_PER_EPISODE = 8;
/** Cap on the distinct names carried into the echo search, over the whole target. */
const ECHO_NAMES = 24;
/** Cap on the assistant episodes reported as echoes. */
const ECHO_LIMIT = 16;

/**
 * Forget is user-authorized, but its target is still an input boundary.  A
 * caller can split a larger request into multiple tombstoned operations; one
 * transaction must never hydrate an archive-sized target list.
 */
export const MAX_FORGET_TARGETS = 8_192;
/** Aggregate cap across whole-object and manifest-span hashes for one forget. */
export const MAX_FORGET_DELETION_OBJECTS = MAX_BLOB_DELETION_ENTRIES;
const FORGET_SCAN_BATCH = 256;
const MAX_CAPSULE_LEVELS = 32;
const MAX_CAPSULES_PER_SOURCE = 32;
const MAX_PACKET_SCAN_ROWS = 256;

function forgetOverflow(kind: string): VaultError {
  return new VaultError(`forget ${kind} exceeds bounded capacity (${MAX_FORGET_TARGETS})`);
}

/** Resolve explicit/range/atom targets without enumerating numeric ranges. */
function resolveForgetSeqs(vault: Vault, threadId: string, target: ForgetTarget): Set<Seq> {
  const seqs = new Set<Seq>();
  const explicitSeqs = target.seqs ?? [];
  if (explicitSeqs.length > MAX_FORGET_TARGETS) throw forgetOverflow("target");
  for (const seq of explicitSeqs) {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new VaultError("forget sequence is invalid");
    seqs.add(seq);
    if (seqs.size > MAX_FORGET_TARGETS) throw forgetOverflow("target");
  }

  if (target.range !== undefined) {
    const [from, to] = target.range;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
      throw new VaultError("forget range is invalid");
    }
    let cursor = from - 1;
    const rows = vault.db.query(
      "SELECT seq FROM episode WHERE thread_id = ? AND seq >= ? AND seq <= ? AND seq > ? " +
        "ORDER BY seq ASC LIMIT ?",
    );
    for (;;) {
      const batch = rows.all(threadId, from, to, cursor, FORGET_SCAN_BATCH) as Array<{ seq: number }>;
      if (batch.length === 0) break;
      for (const row of batch) {
        cursor = row.seq;
        seqs.add(row.seq);
        if (seqs.size > MAX_FORGET_TARGETS) throw forgetOverflow("range target");
      }
    }
  }

  const atomIds = target.atomIds ?? [];
  if (atomIds.length > MAX_FORGET_TARGETS) throw forgetOverflow("atom target");
  for (const atomId of atomIds) {
    const atom = vault.atoms.get(atomId);
    if (atom === null) continue;
    seqs.add(atom.sourceSeq);
    if (seqs.size > MAX_FORGET_TARGETS) throw forgetOverflow("target");
  }
  return seqs;
}

/**
 * Find the still-authoritative episode targets without hydrating their bodies.
 * A repeated forget is allowed to do bounded metadata work, but it must not
 * create a new chain event merely because the caller named an already removed
 * or nonexistent sequence.
 */
function activeForgetSeqs(vault: Vault, threadId: string, seqs: Iterable<Seq>): Set<Seq> {
  const ordered = [...seqs].sort((a, b) => a - b);
  const active = new Set<Seq>();
  const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(", ");
  for (let offset = 0; offset < ordered.length; offset += FORGET_SCAN_BATCH) {
    const batch = ordered.slice(offset, offset + FORGET_SCAN_BATCH);
    if (batch.length === 0) continue;
    const rows = vault.db
      .query(
        `SELECT seq, json_valid(meta) AS meta_valid, ` +
          `CASE WHEN json_valid(meta) = 1 AND json_type(meta, '$.removed') IN ('true', 'false', 'integer') ` +
          `THEN json_extract(meta, '$.removed') ELSE NULL END AS meta_removed, ` +
          `CASE WHEN json_valid(meta) = 1 THEN json_type(meta, '$.removed') ELSE NULL END AS removed_type ` +
          `FROM episode WHERE thread_id = ? AND seq IN (${placeholders(batch.length)})`,
      )
      .all(threadId, ...batch) as Array<{
      seq: number;
      meta_valid: number;
      meta_removed: unknown;
      removed_type: unknown;
    }>;
    for (const row of rows) {
      if (row.meta_valid !== 1) {
        throw new VaultError(`forget target metadata is malformed for episode ${row.seq}`);
      }
      if (
        row.removed_type !== null &&
        row.removed_type !== "true" &&
        row.removed_type !== "false" &&
        row.removed_type !== "integer"
      ) {
        throw new VaultError(`forget target removed flag is malformed for episode ${row.seq}`);
      }
      if (row.meta_removed !== 1) active.add(row.seq);
    }
  }
  return active;
}

function emptyForgetResult(): ForgetResult {
  return {
    tombstoneId: "",
    episodes: [],
    atoms: 0,
    lossRows: 0,
    capsules: 0,
    packets: 0,
    blobs: [],
    cleanupPending: false,
    echoes: [],
    removalSeq: 0,
  };
}

export function forget(vault: Vault, threadId: string, target: ForgetTarget): ForgetResult {
  vault.fragments.assertMutable(threadId);
  const thread = vault.threads.get(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);

  // The SQL transaction decides whether the removal committed. Object bytes
  // are hard-linked into a durable deletion stage while it is open; the
  // canonical paths stay readable until the transaction returns successfully.
  // A thrown callback therefore rolls SQL back and the catch discards only the
  // pending hard links. A process death is reconciled by Vault construction.
  let deletion: BlobDeletionStage | null = null;
  let result: ForgetResult;
  try {
    result = vault.tx(() => {
      const seqs = resolveForgetSeqs(vault, threadId, target);
      const activeSeqs = activeForgetSeqs(vault, threadId, seqs);
      const activeAtomIds = (target.atomIds ?? []).filter((atomId) => {
        const atom = vault.atoms.get(atomId);
        return atom !== null && atom.phase !== "REVOKED";
      });
      if (activeSeqs.size === 0 && activeAtomIds.length === 0) return emptyForgetResult();
      const removed: Seq[] = [];
      const byName = new Map<string, NameHit>();
      const blobs = new Set<string>();
      let bytes = 0;
      for (const seq of [...seqs].sort((a, b) => a - b)) {
        if (!activeSeqs.has(seq)) continue;
        const episode = vault.episodes.get(threadId, seq);
        if (episode === null || episode.meta.removed === true) continue;
        bytes += Buffer.byteLength(episode.content);
        for (const hit of names(episode.content, { max: NAMES_PER_EPISODE })) {
          if (byName.size >= ECHO_NAMES) break;
          if (!byName.has(hit.name)) byName.set(hit.name, hit);
        }
        if (typeof episode.meta.blob === "string") blobs.add(episode.meta.blob);
        removed.push(seq);
      }
      // This is a check-time kernel bound, before the tombstone, redactions,
      // routes, or deletion journal can be published.  The planner stops at
      // cap+1, so a many-span attachment fails atomically and the user can
      // split the request into smaller authorized forgets.
      if (blobs.size > 0) {
        vault.blobs.assertDeletionObjectBudget([...blobs], MAX_FORGET_DELETION_OBJECTS);
      }
      const tombstoneId = vault.tombstones.create(
        threadId,
        canonicalTarget(target, seqs),
        target.reason ?? "user request",
      );
      for (const seq of removed) {
        const episode = vault.episodes.get(threadId, seq);
        if (episode === null || episode.meta.removed === true) {
          throw new VaultError(`forget episode ${seq} disappeared during the transaction`);
        }
        vault.redactContent(threadId, seq, `⟦removed by user · ${tombstoneId}⟧`, {
          ...episode.meta,
          removed: true,
          tombstone: tombstoneId,
        });
      }
      if (bytes > 0) vault.bump(threadId, { [COUNTERS.bytes]: -bytes });

      let atoms = 0;
      for (const seq of removed) {
        atoms += revokeAtomsForSource(vault, threadId, seq);
      }
      for (const atomId of target.atomIds ?? []) {
        const atom = vault.atoms.get(atomId);
        if (atom === null || atom.phase === "REVOKED") continue;
        vault.atoms.revoke(threadId, atomId);
        atoms += 1;
      }

      let lossRows = 0;
      for (const seq of removed) lossRows += vault.losses.resolve(threadId, seq, seq, tombstoneId);

      const removedSet = new Set(removed);
      // Address edges are append-only: close effective routes whose witnesses
      // point into the removed material before the forget transaction commits.
      // The helper is keyset-paged and reuses the current transaction, so a
      // million-route archive never becomes one unbounded allocation.  Proposed
      // aliases are address-only; revoke them by source key without creating any
      // atom or authority.
      if (removedSet.size > 0) {
        invalidateAddressRoutesForSourcesCount(vault, threadId, removedSet, "source deleted by user");
        for (const seq of removedSet) {
          // The vector is a derived address only, but it must disappear in this
          // same user-authorized transaction so no concurrent query can propose
          // bytes after their tombstone commits.
          vault.removeSemanticSource(threadId, seq);
          vault.db
            .query(
              "UPDATE address_alias SET status = 'revoked' " +
                "WHERE thread_id = ? AND source_seq = ? AND status = 'proposed'",
            )
            .run(threadId, seq);
        }
      }
      const hits = [...byName.values()];
      const capsules = rederiveCapsules(vault, threadId, removedSet, hits);
      const packets = clearPacketMessages(vault, threadId, removedSet, capsules, hits);
      let deleted: string[] = [];
      if (blobs.size > 0) {
        if (deletion === null) deletion = vault.blobs.beginDelete();
        const stage = deletion;
        deleted = vault.blobs.deleteMany([...blobs], stage, MAX_FORGET_DELETION_OBJECTS);
        if (deleted.length === 0) {
          vault.blobs.discardDelete(stage);
          deletion = null;
        }
      }
      const echoes = findEchoes(vault, threadId, hits, removedSet);

      // The chain records the removal itself: a later `system` episode naming what
      // was removed and under which tombstone. `verify` requires it.
      let removalSeq = 0;
      if (removed.length > 0) {
        const removal = vault.episodes.append(threadId, {
          role: "system",
          content: removalText(removed, tombstoneId),
        });
        removalSeq = removal.seq;
        // A tombstone that removed nothing keeps `removal_seq` NULL: only the
        // migration may mark a tombstone legacy, so 0 cannot be borrowed.
        vault.tombstones.record(tombstoneId, removalSeq, echoes);
      }

      return {
        tombstoneId,
        episodes: removed,
        atoms,
        lossRows,
        capsules: capsules.length,
        packets,
        blobs: deleted,
        cleanupPending: false,
        echoes,
        removalSeq,
      };
    });
  } catch (error) {
    if (deletion !== null) vault.blobs.discardDelete(deletion);
    throw error;
  }

  if (deletion !== null) {
    // SQLite has committed. Never roll that decision back for a cleanup error;
    // the committed journal is intentionally left for the next Vault open.
    try {
      vault.blobs.commitDelete(deletion);
      // Recheck under a SQLite write transaction. A concurrent append may
      // legitimately reuse a deduplicated object after the forget commit; the
      // lock makes the reference check and unlink one indivisible decision.
      vault.tx(() => {
        const staged = deletion as BlobDeletionStage;
        const referenced = vault.blobs.referencedMany([...staged.entries.keys()]);
        vault.blobs.cleanupDelete(staged, (hash) => {
          const size = vault.blobs.size(hash);
          return referenced.has(hash) || size !== null ? { size } : null;
        });
      });
    } catch {
      // The bytes remain recoverable under .delete-pending. The result still
      // describes the committed user operation, and startup retries cleanup.
      result = { ...result, cleanupPending: true };
    }
  }
  return result;
}

/** The chain-bound removal record: `⟦removed #12, #13 · tb_…⟧`. */
function removalText(seqs: readonly Seq[], tombstoneId: string): string {
  return `⟦removed ${seqs.map((seq) => `#${seq}`).join(", ")} · ${tombstoneId}⟧`;
}

const REMOVAL = /^⟦removed ((?:#\d+, )*#\d+) · (\S+)⟧$/;

/** The seqs a removal episode names, if it names this tombstone (KERNEL A10.6). */
export function removalRecord(content: string, tombstoneId: string): Set<Seq> {
  const match = REMOVAL.exec(content);
  if (match === null || match[2] !== tombstoneId) return new Set();
  return new Set((match[1] as string).split(", ").map((token) => Number(token.slice(1))));
}

const LOCATOR = /⟨#(\d+)⟩$/;

/** Revoke source atoms in bounded rowid pages; phase counters stay exact. */
function revokeAtomsForSource(vault: Vault, threadId: string, sourceSeq: Seq): number {
  const query = vault.db.query(
    "SELECT rowid, id, phase FROM atom " +
      "WHERE thread_id = ? AND source_seq = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
  );
  let cursor = 0;
  let count = 0;
  for (;;) {
    const rows = query.all(threadId, sourceSeq, cursor, FORGET_SCAN_BATCH) as Array<{
      rowid: number;
      id: string;
      phase: string;
    }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.rowid;
      vault.atoms.revoke(threadId, row.id);
      vault.bump(threadId, { [phaseCounter(row.phase as AtomPhase)]: -1 });
      count += 1;
    }
  }
  return count;
}

/**
 * Re-derive the text of every capsule that quotes a removed episode.
 *
 * A capsule's text is a set of located lines, so the extractive writer's output
 * over the surviving source is the same text minus the lines a removed episode
 * produced. Names that leave the text this way are re-accounted against the
 * surviving source vocabulary and the ledger gains the rows it did not have;
 * `capsule.dropped` and existing `loss` rows are left exactly as they are.
 */
function rederiveCapsules(
  vault: Vault,
  threadId: string,
  removed: Set<Seq>,
  hits: readonly NameHit[],
): string[] {
  const changed: string[] = [];
  const seqs = Array.from(removed).sort((a, b) => a - b);
  if (seqs.length === 0) return [];

  // There is at most one normal capsule at a level covering a source seq. The
  // indexed source-targeted lookup keeps sparse endpoints from hydrating every
  // capsule between them; malformed imported overlaps are still explicit
  // overflow rather than silently truncated.
  const levels = vault.db
    .query("SELECT DISTINCT level FROM capsule WHERE thread_id = ? ORDER BY level ASC LIMIT ?")
    .all(threadId, MAX_CAPSULE_LEVELS + 1) as Array<{ level: number }>;
  if (levels.length > MAX_CAPSULE_LEVELS) {
    throw new VaultError(`forget capsule levels exceed bounded capacity (${MAX_CAPSULE_LEVELS})`);
  }
  const candidates = vault.db.query(
    "SELECT id FROM capsule WHERE thread_id = ? AND level = ? AND from_seq <= ? AND to_seq >= ? " +
      "ORDER BY from_seq DESC LIMIT ?",
  );
  for (const levelRow of levels) {
    const ids = new Set<string>();
    for (const seq of seqs) {
      const rows = candidates.all(threadId, levelRow.level, seq, seq, MAX_CAPSULES_PER_SOURCE + 1) as Array<{
        id: string;
      }>;
      if (rows.length > MAX_CAPSULES_PER_SOURCE) {
        throw new VaultError(
          `forget capsule candidates exceed bounded capacity (${MAX_CAPSULES_PER_SOURCE})`,
        );
      }
      for (const row of rows) ids.add(row.id);
    }
    const ordered = Array.from(ids)
      .map((id) => vault.capsules.get(id))
      .filter((capsule): capsule is StoredCapsule => capsule !== null)
      .sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq || a.id.localeCompare(b.id));
    for (const capsule of ordered) {
      const lines = capsule.text.split("\n");
      const surviving = lines.filter((line) => {
        const match = LOCATOR.exec(line);
        const seq = match === null ? 0 : Number(match[1]);
        // A model writer's lines carry no usable locator (KERNEL §3 truncates its
        // output as one unit), so they are judged by what they say instead.
        if (seq > 0) return !removed.has(seq);
        return !hits.some((hit) => containsName(line, hit));
      });
      if (surviving.length === lines.length) continue;

      const text = surviving.join("\n");
      const source = survivingSource(vault, threadId, capsule, removed);
      const ledger = rederiveCapsuleLedger(vault, capsule, source, text);
      vault.capsules.replace({
        ...capsule,
        text,
        tokens: approxTokens(text),
        dropped: ledger.dropped,
        kept: ledger.kept,
        ledgerReceipt: ledger.receipt,
        hash: canonicalHash({ level: capsule.level, from: capsule.fromSeq, to: capsule.toSeq, text }),
      });
      changed.push(capsule.id);
    }
  }
  return changed;
}

/** The vocabulary a capsule is still responsible for after a removal. */
function* survivingSource(
  vault: Vault,
  threadId: string,
  capsule: StoredCapsule,
  removed: Set<Seq>,
): Iterable<SourceName> {
  if (capsule.level === 0) {
    for (const entry of sourceNamesForRangeStream(vault, threadId, capsule.fromSeq, capsule.toSeq)) {
      if (!removed.has(entry.seq)) yield entry;
    }
    return;
  }
  const children = vault.capsules.children(threadId, capsule.level, capsule.fromSeq, capsule.toSeq);
  // The rolling root has no children of its own level (KERNEL A3): it absorbed
  // them one at a time, so what it kept is the vocabulary it answers for.
  if (children.length === 0) {
    for (const entry of capsule.kept) {
      if (!removed.has(entry.seq)) yield toSourceName(entry);
    }
    return;
  }
  for (const child of children) {
    for (const entry of child.kept) {
      if (!removed.has(entry.seq)) yield toSourceName(entry);
    }
  }
}

function toSourceName(entry: LossEntry): SourceName {
  return {
    name: entry.name,
    kind: entry.kind,
    seq: entry.seq,
    ...(entry.span ? { span: entry.span } : {}),
  };
}

/**
 * Drop `messages` from every packet that could still be carrying the removed
 * material: it answered that turn, it had the episode resident or paged, it was
 * built on a capsule that quoted it, or its rendered text still names it — a
 * frontier certificate read from the removed sentence leaves no structural
 * trace, so the text is the last check. The receipt — digest, resident set,
 * ledger digest, pages — stays, and the X-ray labels the packet reconstructed
 * (KERNEL A7, A10.6).
 */
function clearPacketMessages(
  vault: Vault,
  threadId: string,
  removed: Set<Seq>,
  capsules: readonly string[],
  hits: readonly NameHit[],
): number {
  const quoted = new Set(capsules);
  // Never select packet JSON in the page query. Imported rows are legal up to
  // the packet caps, and 256 such rows would otherwise hydrate hundreds of MB
  // before the first update. SQLite measures and validates each candidate
  // scalar-only; a detail fetch is admitted one row at a time below.
  const query = vault.db.query(
    "SELECT rowid, turn_seq, " +
      "COALESCE(length(CAST(resident AS BLOB)), 0) AS resident_bytes, " +
      "COALESCE(length(CAST(pages AS BLOB)), 0) AS pages_bytes, " +
      "COALESCE(length(CAST(messages AS BLOB)), 0) AS messages_bytes, " +
      "CASE WHEN resident IS NOT NULL AND typeof(resident) = 'text' AND json_valid(resident) = 1 " +
      "AND json_type(resident) = 'array' THEN 1 ELSE 0 END AS resident_valid, " +
      "CASE WHEN pages IS NOT NULL AND typeof(pages) = 'text' AND json_valid(pages) = 1 " +
      "AND json_type(pages) = 'array' THEN 1 ELSE 0 END AS pages_valid, " +
      "CASE WHEN messages IS NOT NULL AND typeof(messages) = 'text' AND json_valid(messages) = 1 " +
      "AND json_type(messages) = 'array' THEN 1 ELSE 0 END AS messages_valid " +
      "FROM packet WHERE thread_id = ? AND messages IS NOT NULL AND rowid > ? " +
      "ORDER BY rowid ASC LIMIT ?",
  );
  let cursor = 0;
  let count = 0;
  for (;;) {
    const rows = query.all(threadId, cursor, MAX_PACKET_SCAN_ROWS) as PacketClearScalarRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      const scalar = parsePacketClearScalar(row);
      cursor = scalar.rowid;

      // The turn itself is authoritative evidence that this packet carried the
      // removed material. Do not hydrate any of its JSON columns just to prove
      // a fact already present in the scalar projection.
      let carries = removed.has(scalar.turnSeq);
      if (!carries) {
        const detail = vault.db
          .query("SELECT resident, pages, messages FROM packet WHERE rowid = ? LIMIT 1")
          .get(scalar.rowid) as PacketClearDetailRow | undefined;
        if (detail === undefined) throw new VaultError("forget packet disappeared during the transaction");
        const resident = parsePacketClearJson<ResidentItem>(
          detail.resident,
          scalar.residentBytes,
          "resident",
        );
        const pages = parsePacketClearJson<PageRecord>(detail.pages, scalar.pagesBytes, "pages");
        const messages = parsePacketClearJson<unknown>(detail.messages, scalar.messagesBytes, "messages");
        carries = packetClearCarries(
          resident.value,
          pages.value,
          messages.value,
          messages.text,
          removed,
          quoted,
          hits,
        );
      }
      if (!carries) continue;
      vault.db.query("UPDATE packet SET messages = NULL WHERE rowid = ?").run(scalar.rowid);
      count += 1;
    }
  }
  return count;
}

interface PacketClearScalarRow {
  rowid: unknown;
  turn_seq: unknown;
  resident_bytes: unknown;
  pages_bytes: unknown;
  messages_bytes: unknown;
  resident_valid: unknown;
  pages_valid: unknown;
  messages_valid: unknown;
}

interface PacketClearScalarValues {
  rowid: number;
  turnSeq: number;
  residentBytes: number;
  pagesBytes: number;
  messagesBytes: number;
}

interface PacketClearDetailRow {
  resident: unknown;
  pages: unknown;
  messages: unknown;
}

function parsePacketClearScalar(row: PacketClearScalarRow): PacketClearScalarValues {
  if (
    typeof row.rowid !== "number" ||
    !Number.isSafeInteger(row.rowid) ||
    row.rowid <= 0 ||
    typeof row.turn_seq !== "number" ||
    !Number.isSafeInteger(row.turn_seq) ||
    row.turn_seq < 1 ||
    typeof row.resident_bytes !== "number" ||
    !Number.isSafeInteger(row.resident_bytes) ||
    row.resident_bytes < 0 ||
    typeof row.pages_bytes !== "number" ||
    !Number.isSafeInteger(row.pages_bytes) ||
    row.pages_bytes < 0 ||
    typeof row.messages_bytes !== "number" ||
    !Number.isSafeInteger(row.messages_bytes) ||
    row.messages_bytes < 0 ||
    typeof row.resident_valid !== "number" ||
    row.resident_valid !== 1 ||
    typeof row.pages_valid !== "number" ||
    row.pages_valid !== 1 ||
    typeof row.messages_valid !== "number" ||
    row.messages_valid !== 1
  ) {
    throw new VaultError("forget packet has malformed JSON or scalar fields");
  }
  if (
    row.resident_bytes > MAX_PACKET_JSON_BYTES ||
    row.pages_bytes > MAX_PACKET_JSON_BYTES ||
    row.messages_bytes > MAX_PACKET_MESSAGES_BYTES ||
    row.resident_bytes + row.pages_bytes + row.messages_bytes > MAX_PACKET_RESPONSE_BYTES
  ) {
    throw new VaultError("forget packet JSON exceeds bounded capacity");
  }
  return {
    rowid: row.rowid as number,
    turnSeq: row.turn_seq as number,
    residentBytes: row.resident_bytes as number,
    pagesBytes: row.pages_bytes as number,
    messagesBytes: row.messages_bytes as number,
  };
}

function parsePacketClearJson<T>(
  value: unknown,
  bytes: number,
  column: string,
): { value: T[]; text: string } {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") !== bytes) {
    throw new VaultError(`forget packet ${column} changed or is not UTF-8 text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new VaultError(`forget packet ${column} is malformed JSON`);
  }
  if (!Array.isArray(parsed)) throw new VaultError(`forget packet ${column} is not an array`);
  return { value: parsed as T[], text: value };
}

function packetClearCarries(
  resident: readonly ResidentItem[],
  pages: readonly PageRecord[],
  messages: readonly unknown[],
  messageText: string,
  removed: ReadonlySet<Seq>,
  quoted: ReadonlySet<string>,
  hits: readonly NameHit[],
): boolean {
  let carries = false;
  for (const item of resident as readonly unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new VaultError("forget packet resident items are malformed");
    }
    const row = item as Record<string, unknown>;
    if (
      (row.seq !== undefined &&
        (typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 1)) ||
      (row.ref !== undefined && typeof row.ref !== "string")
    ) {
      throw new VaultError("forget packet resident items are malformed");
    }
    if (
      (typeof row.seq === "number" && removed.has(row.seq)) ||
      (typeof row.ref === "string" && quoted.has(row.ref))
    ) {
      carries = true;
    }
  }
  for (const page of pages as readonly unknown[]) {
    if (page === null || typeof page !== "object" || Array.isArray(page)) {
      throw new VaultError("forget packet pages are malformed");
    }
    const row = page as Record<string, unknown>;
    if (!Array.isArray(row.seqs)) throw new VaultError("forget packet pages are malformed");
    for (const seq of row.seqs) {
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
        throw new VaultError("forget packet pages are malformed");
      }
      if (removed.has(seq)) carries = true;
    }
  }
  for (const message of messages) {
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      typeof (message as Record<string, unknown>).role !== "string" ||
      typeof (message as Record<string, unknown>).content !== "string"
    ) {
      throw new VaultError("forget packet messages are malformed");
    }
  }
  return carries || namesRemoved(messageText, hits);
}

/** The cheap half of `containsName`, over text that may be tens of kilobytes. */
function namesRemoved(text: string, hits: readonly NameHit[]): boolean {
  const normalized = text.replace(/\s+/g, " ").toLowerCase();
  return hits.some((hit) => text.includes(hit.raw) || normalized.includes(hit.name));
}

/**
 * Assistant episodes that carry a routing name of the removed text. Reported,
 * never removed: guessing which replies quoted the user is the kernel deciding
 * what to forget, and it only forgets on command.
 */
function findEchoes(vault: Vault, threadId: string, hits: readonly NameHit[], removed: Set<Seq>): Seq[] {
  const found = new Set<Seq>();
  for (const hit of hits) {
    if (found.size >= ECHO_LIMIT) break;
    for (const episode of vault.episodes.search(threadId, hit.raw, 8)) {
      if (episode.role !== "assistant" || episode.meta.removed === true) continue;
      if (removed.has(episode.seq) || found.has(episode.seq)) continue;
      if (!containsName(episode.content, hit)) continue;
      found.add(episode.seq);
      if (found.size >= ECHO_LIMIT) break;
    }
  }
  return [...found].sort((a, b) => a - b);
}

function canonicalTarget(target: ForgetTarget, seqs: Set<Seq>): string {
  if (target.range) return `range:${target.range[0]}-${target.range[1]}`;
  if (seqs.size > 0) return `seqs:${[...seqs].sort((a, b) => a - b).join(",")}`;
  return `atoms:${(target.atomIds ?? []).join(",")}`;
}
