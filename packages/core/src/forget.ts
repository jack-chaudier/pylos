/**
 * Forgetting (KERNEL §8, A5).
 *
 * Pylos forgets only on command, and records that it did. `forget` writes a
 * tombstone, marks the atoms REVOKED, resolves the ledger rows that pointed into
 * the removed material, deletes the FTS rows and replaces the inline content
 * with `⟦removed by user · <tombstone>⟧`.
 *
 * The hash chain stays valid because it is computed over the stored
 * `content_hash`, not over the stored text: the archive can prove that something
 * was there and that it was removed on request, without keeping it.
 */

import type { Seq } from "@pylos/protocol";
import { COUNTERS } from "./schema.ts";
import { type Vault, VaultError } from "./vault.ts";

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
}

export function forget(vault: Vault, threadId: string, target: ForgetTarget): ForgetResult {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);

  return vault.tx(() => {
    const seqs = new Set<Seq>(target.seqs ?? []);
    if (target.range) {
      for (let seq = target.range[0]; seq <= target.range[1]; seq += 1) seqs.add(seq);
    }
    for (const atomId of target.atomIds ?? []) {
      const atom = vault.atoms.get(atomId);
      if (atom !== null) seqs.add(atom.sourceSeq);
    }
    const tombstoneId = vault.tombstones.create(
      threadId,
      canonicalTarget(target, seqs),
      target.reason ?? "user request",
    );

    const removed: Seq[] = [];
    let bytes = 0;
    for (const seq of [...seqs].sort((a, b) => a - b)) {
      const episode = vault.episodes.get(threadId, seq);
      if (episode === null || episode.meta.removed === true) continue;
      bytes += Buffer.byteLength(episode.content);
      vault.redactContent(threadId, seq, `⟦removed by user · ${tombstoneId}⟧`, {
        ...episode.meta,
        removed: true,
        tombstone: tombstoneId,
      });
      removed.push(seq);
    }
    if (bytes > 0) vault.bump(threadId, { [COUNTERS.bytes]: -bytes });

    let atoms = 0;
    for (const seq of removed) {
      const affected = vault.db
        .query("SELECT id, phase FROM atom WHERE thread_id = ? AND source_seq = ?")
        .all(threadId, seq) as Array<{ id: string; phase: string }>;
      for (const row of affected) {
        vault.atoms.revoke(threadId, row.id);
        vault.bump(threadId, {
          [row.phase === "SUPPORTED" ? COUNTERS.atomsSupported : COUNTERS.atomsHistorical]: -1,
        });
        atoms += 1;
      }
    }
    for (const atomId of target.atomIds ?? []) {
      const atom = vault.atoms.get(atomId);
      if (atom === null || atom.phase === "REVOKED") continue;
      vault.atoms.revoke(threadId, atomId);
      atoms += 1;
    }

    let lossRows = 0;
    for (const seq of removed) lossRows += vault.losses.resolve(threadId, seq, seq, tombstoneId);

    return { tombstoneId, episodes: removed, atoms, lossRows };
  });
}

function canonicalTarget(target: ForgetTarget, seqs: Set<Seq>): string {
  if (target.range) return `range:${target.range[0]}-${target.range[1]}`;
  if (seqs.size > 0) return `seqs:${[...seqs].sort((a, b) => a - b).join(",")}`;
  return `atoms:${(target.atomIds ?? []).join(",")}`;
}
