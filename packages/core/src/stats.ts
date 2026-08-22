/**
 * Thread statistics — the numbers behind the seal and the X-ray (KERNEL §9).
 * Every field is an O(1) read: counters are maintained inside the turn
 * transaction, because a COUNT(*) over a million-row table is not a statistic,
 * it is a scan.
 */

import type { ThreadStats } from "@pylos/protocol";
import { COUNTERS } from "./schema.ts";
import { type Vault, VaultError } from "./vault.ts";
import { verify } from "./verify.ts";

export function stats(vault: Vault, threadId: string, options: { verify?: boolean } = {}): ThreadStats {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
  const last = vault.packets.last(threadId);
  const models = (
    vault.db
      .query("SELECT DISTINCT model FROM episode WHERE thread_id = ? AND model IS NOT NULL LIMIT 32")
      .all(threadId) as Array<{ model: string }>
  ).map((r) => r.model);

  const verified = options.verify === true ? verify(vault, threadId) : null;

  return {
    threadId,
    title: thread.title,
    turns: thread.headSeq,
    episodes: {
      user: vault.counter(threadId, COUNTERS.userEpisodes),
      assistant: vault.counter(threadId, COUNTERS.assistantEpisodes),
      other: vault.counter(threadId, COUNTERS.otherEpisodes),
    },
    archiveBytes: vault.archiveBytes(),
    capsules: vault.counter(threadId, COUNTERS.capsules),
    losses: vault.counter(threadId, COUNTERS.losses),
    atoms: {
      supported: vault.counter(threadId, COUNTERS.atomsSupported),
      historical: vault.counter(threadId, COUNTERS.atomsHistorical),
    },
    ...(last === null
      ? {}
      : {
          lastPacket: {
            tokens: last.tokens,
            budget: last.budget,
            pages: last.pages.length,
            digest: last.digest,
          },
        }),
    headHash: thread.headHash,
    ...(verified === null ? {} : { verifiedTo: verified.checkedTo }),
    models,
  };
}
