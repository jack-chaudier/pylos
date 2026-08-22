/**
 * Rebuilding derived atom state from the exact archive (KERNEL A10.5).
 *
 * Migration `005-authority` read every pre-existing atom as `authority = 'user'`.
 * v1.0 atomized assistant turns too, so an assistant's claim could cross that
 * migration wearing the user's authority and then hold the slot against the
 * user's own word. Atoms are derived and the episodes are exact, so the repair is
 * a replay, not a patch: clear the atoms, run the current rules over every
 * episode in order, and let A9.1 decide what each one is allowed to do.
 *
 * Cost: `O(archive)`, once, on the first open of an affected vault. A vault that
 * does not show the tell pays one indexed query and is marked done.
 */

import type { Seq } from "@pylos/protocol";
import { atomize } from "./atomize.ts";
import { COUNTERS } from "./schema.ts";
import type { Vault } from "./vault.ts";

/** Episodes replayed per statement batch; keeps memory flat on a long archive. */
const BATCH = 512;

/**
 * The tell: an atom that claims user authority but was read from a turn the user
 * did not speak. Only migration 005 could have written one.
 */
export function needsAuthorityReplay(vault: Vault, threadId: string): boolean {
  return (
    vault.db
      .query(
        "SELECT 1 FROM atom a JOIN episode e ON e.thread_id = a.thread_id AND e.seq = a.source_seq " +
          "WHERE a.thread_id = ? AND a.authority = 'user' AND e.role IN ('assistant', 'tool') LIMIT 1",
      )
      .get(threadId) !== null
  );
}

/**
 * Replay the rule atomizer over one thread inside a single transaction. `pinned`
 * survives by key: the user pinned a slot, not a row id.
 */
export function replayAtoms(vault: Vault, threadId: string): number {
  const thread = vault.threads.get(threadId);
  if (thread === null) return 0;
  return vault.tx(() => {
    const pinnedRows = vault.db
      .query("SELECT DISTINCT key FROM atom WHERE thread_id = ? AND pinned = 1")
      .all(threadId) as Array<{ key: string }>;
    const pinned = pinnedRows.map((row) => row.key);
    vault.db.query("DELETE FROM atom_name WHERE thread_id = ?").run(threadId);
    vault.db.query("DELETE FROM atom WHERE thread_id = ?").run(threadId);
    vault.db
      .query("DELETE FROM counter WHERE thread_id = ? AND key IN (?, ?, ?)")
      .run(threadId, COUNTERS.atomsSupported, COUNTERS.atomsHistorical, COUNTERS.atomsProposed);

    let created = 0;
    for (let from: Seq = 1; from <= thread.headSeq; from += BATCH) {
      const to = Math.min(thread.headSeq, from + BATCH - 1);
      const seqs: Seq[] = [];
      for (let seq = from; seq <= to; seq += 1) seqs.push(seq);
      created += atomize(vault, threadId, seqs).length;
    }
    for (const key of pinned) {
      const current = vault.atoms.byKey(threadId, key)[0];
      if (current !== undefined) vault.atoms.pin(threadId, current.id, true);
    }
    return created;
  });
}
