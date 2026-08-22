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

import type { EpisodeMeta, Seq } from "@pylos/protocol";
import { chainHash, genesisHash, sha256 } from "./hash.ts";
import { CHECKPOINT_EVERY, chainRecord, metaHashOf, type Vault, VaultError } from "./vault.ts";

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
    const meta = JSON.parse(row.meta) as EpisodeMeta;
    const expected = chainHash(
      prevHash,
      chainRecord({
        seq: row.seq,
        ts: row.ts,
        role: row.role,
        ...(row.model === null ? {} : { model: row.model }),
        ...(row.provider === null ? {} : { provider: row.provider }),
        contentHash: row.content_hash,
        metaHash: metaHashOf(meta),
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
    if (meta.removed !== true && sha256(row.content) !== row.content_hash) {
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
