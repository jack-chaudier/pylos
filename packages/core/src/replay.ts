/**
 * Rebuilding derived atom state from the exact archive (KERNEL A10.5).
 *
 * Migration `005-authority` read every pre-existing atom as `authority = 'user'`.
 * v1.0 atomized assistant turns too, so an assistant's claim could cross that
 * migration wearing the user's authority and then hold the slot against the
 * user's own word. Atoms are derived and the episodes are exact, so the repair
 * is a replay, not a patch: clear the atoms, run the current rules over every
 * episode in order, and let A9.1 decide what each one is allowed to do.
 *
 * The repair is resumable. A poisoned thread is cleared once, then replayed in
 * bounded episode pages across opens. The per-thread cursor and the global
 * thread cursor live in `migration_progress`; pinned keys live in the durable
 * `atom_replay_pin` table so a process crash cannot silently lose a pin.
 */

import type { Seq } from "@pylos/protocol";
import { atomize } from "./atomize.ts";
import { AUTHORITY_REPLAY, COUNTERS } from "./schema.ts";
import type { Vault } from "./vault.ts";

/** Durable global cursor row for authority replay. */
export const AUTHORITY_REPLAY_CURSOR = "__pylos_authority_replay__";
/** Poisoned threads examined per open. */
export const AUTHORITY_REPLAY_THREADS_PER_OPEN = 8;
/** Episode rows incorporated per open (including rows with no atom drafts). */
export const AUTHORITY_REPLAY_ROWS_PER_OPEN = 512;
/** UTF-8 source bytes hydrated by one replay open. */
export const AUTHORITY_REPLAY_BYTES_PER_OPEN = 512 * 1024;

export interface ReplayBatchOptions {
  maxRows?: number;
  maxBytes?: number;
}

export interface ReplayBatchResult {
  created: number;
  rows: number;
  bytes: number;
  complete: boolean;
}

/**
 * The tell: an atom that claims user authority but was read from a turn the user
 * did not speak. Only migration 005 could have written one.
 *
 * Without a thread argument this is deliberately one global EXISTS. A clean
 * vault therefore pays one atom-side probe rather than one query per thread.
 */
export function needsAuthorityReplay(vault: Vault, threadId?: string): boolean {
  const scoped = threadId === undefined ? "" : " AND a.thread_id = ?";
  const row =
    threadId === undefined
      ? vault.db
          .query(
            "SELECT 1 FROM atom a JOIN episode e ON e.thread_id = a.thread_id AND e.seq = a.source_seq " +
              "WHERE a.authority = 'user' AND e.role IN ('assistant', 'tool') " +
              "AND NOT EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = a.thread_id) LIMIT 1",
          )
          .get()
      : vault.db
          .query(
            "SELECT 1 FROM atom a JOIN episode e ON e.thread_id = a.thread_id AND e.seq = a.source_seq " +
              "WHERE a.authority = 'user' AND e.role IN ('assistant', 'tool') " +
              "AND NOT EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = a.thread_id)" +
              scoped +
              " LIMIT 1",
          )
          .get(threadId);
  return row !== null;
}

function boundedOption(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid authority replay budget");
  return value;
}

/**
 * Replay one bounded page of one thread. The caller persists the global thread
 * cursor only after this result reports `complete`; a partial thread remains
 * hidden behind the fail-closed routing projection until its next page commits.
 */
export function replayAtomsBounded(
  vault: Vault,
  threadId: string,
  options: ReplayBatchOptions = {},
): ReplayBatchResult {
  const thread = vault.threads.header(threadId);
  if (thread === null) return { created: 0, rows: 0, bytes: 0, complete: true };
  const maxRows = Math.min(
    boundedOption(options.maxRows, AUTHORITY_REPLAY_ROWS_PER_OPEN),
    AUTHORITY_REPLAY_ROWS_PER_OPEN,
  );
  const maxBytes = Math.min(
    boundedOption(options.maxBytes, AUTHORITY_REPLAY_BYTES_PER_OPEN),
    AUTHORITY_REPLAY_BYTES_PER_OPEN,
  );

  return vault.withMigrationDerivedReads(() =>
    vault.tx(() => {
      const progress = vault.db
        .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
        .get(threadId, AUTHORITY_REPLAY) as { cursor: number; status: string } | null;
      if (progress?.status === "complete") {
        return { created: 0, rows: 0, bytes: 0, complete: true };
      }
      // A source row larger than the per-open byte envelope cannot be safely
      // rule-atomized from a bounded prefix. Keep the thread explicitly
      // unresolved rather than silently treating that prefix as the complete
      // episode; the global readiness marker therefore remains false forever
      // until a future exact-stream repair is available.
      if (progress?.status === "incomplete") {
        return { created: 0, rows: 0, bytes: 0, complete: false };
      }

      if (progress === null) {
        // A pre-progress vault may contain a stale derived name projection. It
        // is cheaper and safer to clear it before the first replay page.
        vault.db
          .query(
            "INSERT INTO migration_progress (thread_id, name, cursor, status) VALUES (?, ?, 0, 'partial')",
          )
          .run(threadId, AUTHORITY_REPLAY);
        vault.db.query("DELETE FROM atom_replay_pin WHERE thread_id = ?").run(threadId);
        vault.db
          .query(
            "INSERT OR IGNORE INTO atom_replay_pin (thread_id, key) " +
              "SELECT thread_id, key FROM atom WHERE thread_id = ? AND pinned = 1",
          )
          .run(threadId);
        vault.db.query("DELETE FROM atom_name WHERE thread_id = ?").run(threadId);
        vault.db.query("DELETE FROM atom WHERE thread_id = ?").run(threadId);
        vault.db
          .query("DELETE FROM counter WHERE thread_id = ? AND key IN (?, ?, ?)")
          .run(threadId, COUNTERS.atomsSupported, COUNTERS.atomsHistorical, COUNTERS.atomsProposed);
      }

      const afterSeq = progress?.cursor ?? 0;
      const sourceRows = vault.db
        .query(
          "SELECT seq, length(CAST(content AS BLOB)) AS content_bytes, " +
            "length(CAST(meta AS BLOB)) AS meta_bytes " +
            "FROM episode WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
        )
        .all(threadId, afterSeq, maxRows + 1) as Array<{
        seq: number;
        content_bytes: number | null;
        meta_bytes: number | null;
      }>;

      const selected: Array<{ seq: Seq; bytes: number; contentLimit?: number; metaLimit?: number }> = [];
      let bytes = 0;
      for (const row of sourceRows.slice(0, maxRows)) {
        const contentBytes = Number.isSafeInteger(row.content_bytes) ? (row.content_bytes as number) : 0;
        const metaBytes = Number.isSafeInteger(row.meta_bytes) ? (row.meta_bytes as number) : 0;
        const rowBytes = contentBytes + metaBytes;
        // An overfull legacy row is selected only to record an explicit
        // incomplete status below; it is never prefix-atomized. The archive
        // remains valid and pageable while its derived authority stays hidden.
        if (selected.length > 0 && bytes + rowBytes > maxBytes) break;
        if (rowBytes > maxBytes) {
          const metaLimit = Math.min(metaBytes, Math.max(0, Math.floor(maxBytes / 4)));
          const contentLimit = Math.max(1, maxBytes - metaLimit);
          selected.push({ seq: row.seq, bytes: maxBytes, contentLimit, metaLimit });
          bytes = maxBytes;
        } else {
          selected.push({ seq: row.seq, bytes: rowBytes });
          bytes += rowBytes;
        }
        if (bytes >= maxBytes) break;
      }

      if (selected.length === 0) {
        const first = sourceRows[0];
        if (first === undefined) {
          const pin = vault.db.query(
            "UPDATE atom SET pinned = 1 WHERE thread_id = ? AND phase = 'SUPPORTED' " +
              "AND EXISTS (SELECT 1 FROM atom_replay_pin p WHERE p.thread_id = atom.thread_id AND p.key = atom.key)",
          );
          pin.run(threadId);
          vault.db.query("DELETE FROM atom_replay_pin WHERE thread_id = ?").run(threadId);
          vault.db
            .query("UPDATE migration_progress SET status = 'complete' WHERE thread_id = ? AND name = ?")
            .run(threadId, AUTHORITY_REPLAY);
          return { created: 0, rows: 0, bytes: 0, complete: true };
        }
        const contentBytes = Number.isSafeInteger(first.content_bytes) ? (first.content_bytes as number) : 0;
        const metaBytes = Number.isSafeInteger(first.meta_bytes) ? (first.meta_bytes as number) : 0;
        const rowBytes = contentBytes + metaBytes;
        if (rowBytes > maxBytes) {
          const metaLimit = Math.min(metaBytes, Math.max(0, Math.floor(maxBytes / 4)));
          selected.push({
            seq: first.seq,
            bytes: maxBytes,
            contentLimit: Math.max(1, maxBytes - metaLimit),
            metaLimit,
          });
          bytes = maxBytes;
        } else {
          selected.push({ seq: first.seq, bytes: rowBytes });
          bytes = rowBytes;
        }
      }

      const truncatedSource = selected.find((row) => row.contentLimit !== undefined);
      if (truncatedSource !== undefined) {
        vault.db
          .query(
            "UPDATE migration_progress SET cursor = ?, status = 'incomplete' WHERE thread_id = ? AND name = ?",
          )
          .run(afterSeq, threadId, AUTHORITY_REPLAY);
        return { created: 0, rows: 0, bytes: 0, complete: false };
      }

      const created = atomize(
        vault,
        threadId,
        selected.map((row) => row.seq),
      ).length;
      const nextSeq = selected.at(-1)?.seq ?? afterSeq;
      const complete = sourceRows.length <= maxRows && selected.length === sourceRows.length;
      if (complete) {
        const pin = vault.db.query(
          "UPDATE atom SET pinned = 1 WHERE thread_id = ? AND phase = 'SUPPORTED' " +
            "AND EXISTS (SELECT 1 FROM atom_replay_pin p WHERE p.thread_id = atom.thread_id AND p.key = atom.key)",
        );
        pin.run(threadId);
        vault.db.query("DELETE FROM atom_replay_pin WHERE thread_id = ?").run(threadId);
      }
      vault.db
        .query("UPDATE migration_progress SET cursor = ?, status = ? WHERE thread_id = ? AND name = ?")
        .run(nextSeq, complete ? "complete" : "partial", threadId, AUTHORITY_REPLAY);
      return { created, rows: selected.length, bytes, complete };
    }),
  );
}

/**
 * Replay the complete thread for callers that explicitly request the repair.
 * The migration path uses `replayAtomsBounded` directly; this compatibility
 * wrapper preserves the historical number-returning API while still using the
 * durable page state and pin journal.
 */
export function replayAtoms(vault: Vault, threadId: string): number {
  let created = 0;
  for (;;) {
    const page = replayAtomsBounded(vault, threadId);
    created += page.created;
    if (page.complete) return created;
    if (page.rows === 0) throw new Error("authority replay made no progress");
  }
}
