/**
 * Thread statistics — the numbers behind the seal and the X-ray (KERNEL §9).
 * Every field is an O(1) read: counters are maintained inside the turn
 * transaction, because a COUNT(*) over a million-row table is not a statistic,
 * it is a scan.
 */

import { DEFAULT_BUDGET, type ThreadCompactionStatus, type ThreadStats } from "@pylos/protocol";
import { compactionPending } from "./compact.ts";
import { COUNTERS } from "./schema.ts";
import { type Vault, VaultError } from "./vault.ts";
import { verify } from "./verify.ts";

export function stats(
  vault: Vault,
  threadId: string,
  options: { verify?: boolean; archiveBytes?: number } = {},
): ThreadStats {
  const thread = vault.threads.header(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
  const fragment = vault.fragments.get(threadId);
  // A pending source audit is an internal migration state, not a durable
  // quarantine. Only a persisted noncompactable marker changes the product
  // boundary; otherwise ordinary fresh threads would appear read-only between
  // their first and second append.
  const sourceCandidate = vault.capsuleSourceReadiness(threadId, thread.headSeq);
  const sourceReadiness = sourceCandidate?.status === "noncompactable" ? sourceCandidate : null;
  const last = vault.packets.lastSummary(threadId);
  const backfill = vault.db.query("SELECT complete FROM thread_model_backfill WHERE id = 1").get() as {
    complete: number;
  } | null;
  const modelsComplete = backfill?.complete === 1;
  const modelState = vault.db
    .query("SELECT oversized_count FROM thread_model_state WHERE thread_id = ?")
    .get(threadId) as { oversized_count: number } | null;
  if (
    modelState !== null &&
    (!Number.isSafeInteger(modelState.oversized_count) ||
      modelState.oversized_count < 0 ||
      (modelState.oversized_count > 0 && modelsComplete))
  ) {
    throw new VaultError("model identifier exceeds the bounded statistics projection");
  }
  // The migration backfills first rowid once and the insert trigger keeps this
  // index current. Read one sentinel row so the response can report history
  // truncation without scanning or grouping the episode archive.
  const modelRows = vault.db
    .query("SELECT model FROM thread_model WHERE thread_id = ? ORDER BY first_rowid ASC LIMIT 33")
    .all(threadId) as Array<{ model: string }>;
  const modelsTruncated = modelRows.length > 32;
  const models = modelRows.slice(0, 32).map((row) => row.model);

  // Settings are a bounded, validated projection. They are the durable source
  // of the active model/budget; the packet is only the last observed request.
  const runtime = vault.threads.runtime(threadId);
  if (runtime === null) throw new VaultError(`unknown thread ${threadId}`);
  const selectedModel =
    typeof runtime.settings.model === "string" && runtime.settings.model.length > 0
      ? runtime.settings.model
      : vault.episodes.lastSpokenModel(threadId);
  const selectedBudget =
    typeof runtime.settings.budget === "number" ? runtime.settings.budget : DEFAULT_BUDGET;
  const pending = compactionPending(vault, threadId);
  const sealed = vault.db
    .query(
      "SELECT to_seq AS sealed_through FROM capsule WHERE thread_id = ? AND level = 0 ORDER BY to_seq DESC LIMIT 1",
    )
    .get(threadId) as { sealed_through: number } | null;
  const compaction: ThreadCompactionStatus = {
    pending,
    sealedThrough: sealed?.sealed_through ?? 0,
    headSeq: thread.headSeq,
  };

  // Without `verify`, the frontier is the O(1) record a previous pass left; a
  // requested verify replaces it with what this run just checked.
  const verified = options.verify === true ? verify(vault, threadId) : null;
  const verifiedTo = verified === null ? vault.verifiedFrontier(threadId) : verified.checkedTo;

  return {
    threadId,
    title: thread.title ?? "Untitled thread",
    turns: thread.headSeq,
    episodes: {
      user: vault.counter(threadId, COUNTERS.userEpisodes),
      assistant: vault.counter(threadId, COUNTERS.assistantEpisodes),
      other: vault.counter(threadId, COUNTERS.otherEpisodes),
    },
    archiveBytes: options.archiveBytes ?? vault.archiveBytes(),
    capsules: vault.counter(threadId, COUNTERS.capsules),
    losses: vault.counter(threadId, COUNTERS.losses),
    atoms: {
      supported: vault.counter(threadId, COUNTERS.atomsSupported),
      historical: vault.counter(threadId, COUNTERS.atomsHistorical),
      proposed: vault.counter(threadId, COUNTERS.atomsProposed),
    },
    ...(last === null
      ? {}
      : {
          lastPacket: {
            tokens: last.tokens,
            budget: last.budget,
            pages: last.pages,
            digest: last.digest,
          },
        }),
    headHash: thread.headHash,
    ...(verifiedTo > 0 ? { verifiedTo } : {}),
    models,
    modelsTruncated,
    modelsComplete,
    selectedBudget,
    ...(selectedModel === undefined ? {} : { selectedModel }),
    ...(fragment === null
      ? {}
      : {
          fragment: {
            readOnly: true as const,
            threadId: fragment.threadId,
            originalThreadId: fragment.originalThreadId,
            fromSeq: fragment.fromSeq,
            toSeq: fragment.toSeq,
            prevHash: fragment.prevHash,
            headHash: fragment.headHash,
            createdAt: fragment.createdAt,
          },
        }),
    ...(sourceReadiness === null ? {} : { sourceReadiness }),
    compaction,
    ...(pending ? { compactionPending: true } : {}),
  };
}
