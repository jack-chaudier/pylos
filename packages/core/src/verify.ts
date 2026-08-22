/**
 * Chain verification (KERNEL §1, A5).
 *
 * `hash_i = sha256(hash_{i-1} ‖ cjson({v, seq, ts, role, model, provider,
 * content_hash, meta_hash}))`, `hash_0 = sha256("pylos:" + thread.id)`.
 *
 * Verification is incremental: a trusted checkpoint every 4,096 episodes means
 * the UI never waits on a full replay. `{full: true}` replays from genesis and
 * is what the tamper tests use.
 */

import type { Seq } from "@pylos/protocol";
import { removalRecord } from "./forget.ts";
import { canonicalHash, chainHash, genesisHash, sha256 } from "./hash.ts";
import { CHECKPOINT_EVERY, chainRecord, type Vault, VaultError } from "./vault.ts";

export interface VerifyResult {
  ok: boolean;
  headHash: string;
  /** The highest seq whose chain link was checked. */
  checkedTo: Seq;
  /** Where the replay started (a checkpoint, or 0 for a full replay). */
  checkedFrom: Seq;
  /** First seq that failed, if any. */
  failedAt?: Seq;
  reason?: string;
}

const IMMUTABLE_META = ["blob", "mime", "name", "size", "from", "to"] as const;

interface Row {
  seq: number;
  ts: number;
  role: string;
  model: string | null;
  provider: string | null;
  content: string;
  content_hash: string;
  prev_hash: string;
  hash: string;
  meta: string;
}

/**
 * Replay the chain and compare. Also checks, for every episode whose content has
 * not been redacted by `forget`, that `sha256(content) === content_hash` — so a
 * silent edit of the stored text is caught even though the chain covers the hash.
 */
export function verify(vault: Vault, threadId: string, options: { full?: boolean } = {}): VerifyResult {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
  if (thread.headSeq === 0) {
    return { ok: true, headHash: thread.headHash, checkedTo: 0, checkedFrom: 0 };
  }

  const checkpoint = options.full === true ? null : vault.checkpointBefore(threadId, thread.headSeq);
  const startSeq = checkpoint?.seq ?? 0;
  let prevHash = checkpoint?.hash ?? genesisHash(threadId);

  const rows = vault.db
    .query(
      "SELECT seq, ts, role, model, provider, content, content_hash, prev_hash, hash, meta FROM episode " +
        "WHERE thread_id = ? AND seq > ? ORDER BY seq ASC",
    )
    .all(threadId, startSeq) as Row[];

  let checkedTo = startSeq;
  for (const row of rows) {
    if (row.prev_hash !== prevHash) {
      return {
        ok: false,
        headHash: thread.headHash,
        checkedTo,
        checkedFrom: startSeq,
        failedAt: row.seq,
        reason: "prev_hash mismatch",
      };
    }
    const meta = JSON.parse(row.meta) as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const key of IMMUTABLE_META) {
      if (meta[key] !== undefined) picked[key] = meta[key];
    }
    const expected = chainHash(
      prevHash,
      chainRecord({
        seq: row.seq,
        ts: row.ts,
        role: row.role,
        ...(row.model === null ? {} : { model: row.model }),
        ...(row.provider === null ? {} : { provider: row.provider }),
        contentHash: row.content_hash,
        metaHash: canonicalHash(picked),
      }),
    );
    if (expected !== row.hash) {
      return {
        ok: false,
        headHash: thread.headHash,
        checkedTo,
        checkedFrom: startSeq,
        failedAt: row.seq,
        reason: "hash mismatch",
      };
    }
    if (meta.removed === true) {
      const problem = removalProblem(vault, threadId, row.seq, meta.tombstone);
      if (problem !== null) {
        return {
          ok: false,
          headHash: thread.headHash,
          checkedTo,
          checkedFrom: startSeq,
          failedAt: row.seq,
          reason: problem,
        };
      }
    } else if (sha256(row.content) !== row.content_hash) {
      return {
        ok: false,
        headHash: thread.headHash,
        checkedTo,
        checkedFrom: startSeq,
        failedAt: row.seq,
        reason: "content does not match content_hash",
      };
    }
    prevHash = row.hash;
    checkedTo = row.seq;
    if (row.seq % CHECKPOINT_EVERY === 0) vault.putCheckpoint(threadId, row.seq, row.hash);
  }

  if (prevHash !== thread.headHash) {
    return {
      ok: false,
      headHash: thread.headHash,
      checkedTo,
      checkedFrom: startSeq,
      failedAt: checkedTo,
      reason: "head hash mismatch",
    };
  }
  return { ok: true, headHash: thread.headHash, checkedTo, checkedFrom: startSeq };
}

/**
 * Why this episode's `removed` flag is not backed by a removal (KERNEL A10.6),
 * or `null` if it is.
 *
 * `meta.removed` is outside `meta_hash` — it has to be, since the chain is
 * immutable — so on its own it is a way to skip the `content_hash` check by
 * editing the database. It is backed instead by two records the chain does
 * cover: a tombstone, and a later `system` episode whose content names both this
 * seq and that tombstone.
 */
function removalProblem(vault: Vault, threadId: string, seq: Seq, tombstoneId: unknown): string | null {
  if (typeof tombstoneId !== "string" || tombstoneId.length === 0) return "removed without a tombstone";
  const tombstone = vault.db
    .query("SELECT removal_seq FROM tombstone WHERE id = ? AND thread_id = ?")
    .get(tombstoneId, threadId) as { removal_seq: number | null } | undefined;
  if (tombstone == null) return "removed without a tombstone";
  // Removals from before the amendment have no chain event and cannot be given
  // one retroactively; the migration marks them, and nothing else may be 0.
  if (tombstone.removal_seq === 0) return null;
  if (tombstone.removal_seq === null || tombstone.removal_seq <= seq) {
    return "removed without a chain-bound removal record";
  }
  const record = vault.db
    .query("SELECT role, content FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, tombstone.removal_seq) as { role: string; content: string } | undefined;
  if (record == null || record.role !== "system" || !removalRecord(record.content, tombstoneId).has(seq)) {
    return "removed without a chain-bound removal record";
  }
  return null;
}
