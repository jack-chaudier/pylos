import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ThreadListPage, ThreadStats } from "@pylos/protocol";
import {
  MAX_THREAD_LIST_RESPONSE_BYTES,
  MAX_THREAD_LIST_ROWS,
  MAX_THREAD_MODEL_BYTES,
  MAX_THREAD_TITLE_BYTES,
} from "@pylos/protocol";
import { type Harness, harness, jsonPost } from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await harness();
});

afterAll(async () => {
  await h.dispose();
});

describe("thread API boundaries", () => {
  test("accepts a title at the UTF-8 cap and rejects one byte beyond it", async () => {
    const exact = "😀".repeat(MAX_THREAD_TITLE_BYTES / 4);
    const created = await h.fetch("/api/threads", jsonPost({ title: exact }));
    expect(created.status).toBe(200);
    const body = (await created.json()) as ThreadStats;
    expect(Buffer.byteLength(body.title, "utf8")).toBe(MAX_THREAD_TITLE_BYTES);

    const tooLong = await h.fetch("/api/threads", jsonPost({ title: `${exact}x` }));
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toMatchObject({ code: "title_too_large" });
  });

  test("rejects oversized settings atomically and leaves the thread usable", async () => {
    const created = await h.fetch("/api/threads", jsonPost({ title: "settings-boundary" }));
    const thread = (await created.json()) as ThreadStats;
    const tooLong = await h.fetch(
      `/api/threads/${thread.threadId}/settings`,
      jsonPost({ model: "m".repeat(MAX_THREAD_MODEL_BYTES + 1) }),
    );
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toMatchObject({ code: "model_too_large" });

    const oneMiB = await h.fetch(
      `/api/threads/${thread.threadId}/settings`,
      jsonPost({ model: "m".repeat(1_048_000) }),
    );
    expect(oneMiB.status).toBe(413);
    expect((await h.fetch(`/api/threads/${thread.threadId}`)).status).toBe(200);
  });

  test("durable source quarantine rejects writes before lane/provider work but leaves forget remediation", async () => {
    const created = await h.fetch("/api/threads", jsonPost({ title: "legacy-quarantine" }));
    const thread = (await created.json()) as ThreadStats;
    const before = await h.json<ThreadStats>(`/api/threads/${thread.threadId}`);
    const originalForget = h.context.kernel.forget;
    const providerCalls = h.provider.calls.length;
    let forgets = 0;
    const adapter = h.context.kernel as unknown as {
      vault: { db: { query(sql: string): { run(...args: unknown[]): unknown } } };
    };
    adapter.vault.db
      .query(
        "INSERT OR REPLACE INTO capsule_source_readiness " +
          "(thread_id, status, checked_through, seq, reason, checked_at) VALUES (?, 'noncompactable', 0, ?, ?, ?)",
      )
      .run(thread.threadId, 1, "episode exceeds capsule source byte capacity", Date.now());
    h.context.kernel.forget = async () => {
      forgets += 1;
      return {
        tombstoneId: "tombstone-quarantine",
        removalSeq: before.turns + 1,
        echoes: [],
        capsules: 0,
        packets: 0,
        blobs: 0,
        cleanupPending: false,
      };
    };
    try {
      const responses = await Promise.all([
        h.fetch(`/api/threads/${thread.threadId}/settings`, jsonPost({ model: "grok-4.6" })),
        h.fetch(`/api/threads/${thread.threadId}/turn`, jsonPost({ text: "must not call provider" })),
        h.fetch("/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Pylos-Thread": thread.threadId },
          body: JSON.stringify({
            model: "grok-4.6",
            messages: [{ role: "user", content: "must not call provider" }],
          }),
        }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "source_not_ready" });
      }
      expect(h.provider.calls).toHaveLength(providerCalls);

      const forget = await h.fetch(`/api/threads/${thread.threadId}/forget`, jsonPost({ seqs: [1] }));
      expect(forget.status).toBe(200);
      expect(forgets).toBe(1);
      const after = await h.json<ThreadStats>(`/api/threads/${thread.threadId}`);
      expect(after.headHash).toBe(before.headHash);
      expect(after.turns).toBe(before.turns);
    } finally {
      h.context.kernel.forget = originalForget;
    }
  });

  test("validates packet shares as one exact map before settings mutation", async () => {
    const created = await h.fetch("/api/threads", jsonPost({ title: "shares-boundary" }));
    const thread = (await created.json()) as ThreadStats;
    const invalid = await h.fetch(
      `/api/threads/${thread.threadId}/settings`,
      jsonPost({ shares: { header: 1, frontier: 1, capsules: 0, paged: 0 } }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_shares" });

    const valid = await h.fetch(
      `/api/threads/${thread.threadId}/settings`,
      jsonPost({ shares: { header: 0.04, frontier: 0.2, capsules: 0.18, paged: 0.18 } }),
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      shares: { header: 0.04, frontier: 0.2, capsules: 0.18, paged: 0.18 },
    });
  });

  test("returns bounded keyset pages and a continuation cursor", async () => {
    const made: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await h.fetch("/api/threads", jsonPost({ title: `page-${index}` }));
      made.push(((await response.json()) as ThreadStats).threadId);
    }

    const first = await h.fetch("/api/threads?limit=2");
    expect(first.status).toBe(200);
    const page = (await first.json()) as ThreadListPage;
    expect(page.threads).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      MAX_THREAD_LIST_RESPONSE_BYTES,
    );
    expect(page.byteLength).toBe(Buffer.byteLength(JSON.stringify(page), "utf8"));

    const after = page.nextCursor;
    expect(after).toBeDefined();
    const second = await h.fetch(`/api/threads?limit=2&after=${encodeURIComponent(after ?? "")}`);
    expect(second.status).toBe(200);
    const next = (await second.json()) as ThreadListPage;
    expect(next.threads).toHaveLength(2);
    expect(next.threads.map((thread) => thread.threadId)).not.toEqual(
      expect.arrayContaining(page.threads.map((thread) => thread.threadId)),
    );
    expect([...made, ...page.threads.map((thread) => thread.threadId)]).toHaveLength(
      made.length + page.threads.length,
    );
  });

  test("bounds the default unpaginated response instead of hydrating every row", async () => {
    for (let index = 0; index < MAX_THREAD_LIST_ROWS + 2; index += 1) {
      const response = await h.fetch("/api/threads", jsonPost({ title: `bounded-${index}` }));
      expect(response.status).toBe(200);
    }

    const response = await h.fetch("/api/threads");
    expect(response.status).toBe(200);
    const body = (await response.json()) as ThreadStats[] | ThreadListPage;
    const page = Array.isArray(body) ? undefined : body;
    expect(page).toBeDefined();
    expect(page?.threads.length).toBeLessThanOrEqual(MAX_THREAD_LIST_ROWS);
    expect(page?.hasMore).toBe(true);
  });

  test("maintenance advances a capsule-free backlog while turns wait for readiness", async () => {
    const created = await h.fetch("/api/threads", jsonPost({ title: "maintenance-boundary" }));
    const thread = (await created.json()) as ThreadStats;
    const adapter = h.context.kernel as unknown as {
      vault: {
        episodes: { appendMany(threadId: string, inputs: Array<Record<string, unknown>>): unknown[] };
      };
    };
    adapter.vault.episodes.appendMany(
      thread.threadId,
      Array.from({ length: 8_192 }, (_, index) => ({
        role: "user",
        content: `imported backlog episode ${index + 1}`,
      })),
    );
    const before = await h.json<ThreadStats>(`/api/threads/${thread.threadId}`);
    expect(before.compaction?.pending ?? before.compactionPending).toBe(true);
    const providerCalls = h.provider.calls.length;
    const blocked = await h.fetch(
      `/api/threads/${thread.threadId}/turn`,
      jsonPost({ text: "wait for maintenance" }),
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "compaction_pending" });
    expect(h.provider.calls).toHaveLength(providerCalls);

    let progress = before.compaction?.sealedThrough ?? 0;
    let latest = before;
    for (
      let attempt = 0;
      attempt < 32 && (latest.compaction?.pending ?? latest.compactionPending);
      attempt += 1
    ) {
      const response = await h.fetch(`/api/threads/${thread.threadId}/maintenance`, jsonPost({}));
      expect(response.status).toBe(200);
      latest = (await response.json()) as ThreadStats;
      expect(latest.compaction?.sealedThrough ?? 0).toBeGreaterThanOrEqual(progress);
      progress = latest.compaction?.sealedThrough ?? progress;
    }
    expect(latest.compaction?.pending ?? latest.compactionPending).toBe(false);
  });

  test("full-v2 import exposes bounded progress, then reopens ready for a turn", async () => {
    const sourceResponse = await h.fetch("/api/threads", jsonPost({ title: "v2-zero-capsule-source" }));
    const source = (await sourceResponse.json()) as ThreadStats;
    const sourceAdapter = h.context.kernel as unknown as {
      vault: {
        episodes: { appendMany(threadId: string, inputs: Array<Record<string, unknown>>): unknown[] };
      };
    };
    sourceAdapter.vault.episodes.appendMany(
      source.threadId,
      Array.from({ length: 8_192 }, (_, index) => ({
        role: "user",
        content: `v2 imported episode ${index + 1}`,
      })),
    );
    const exported = await h.fetch(
      `/api/threads/${source.threadId}/export`,
      jsonPost({ passphrase: "correct horse battery" }),
    );
    expect(exported.status).toBe(200);
    const bytes = new Uint8Array(await exported.arrayBuffer());

    const fresh = await harness();
    try {
      const form = new FormData();
      form.append("file", new File([bytes as BlobPart], "v2-zero-capsule.pylos"));
      form.append("passphrase", "correct horse battery");
      const importedResponse = await fresh.fetch("/api/import", { method: "POST", body: form });
      expect(importedResponse.status).toBe(200);
      let latest = (await importedResponse.json()) as ThreadStats;
      expect(latest.compaction?.pending ?? latest.compactionPending).toBe(true);
      const importedAdapter = fresh.context.kernel as unknown as {
        vault: { db: { query(sql: string): { get(...args: unknown[]): unknown } } };
      };
      const readiness = importedAdapter.vault.db
        .query("SELECT status, checked_through FROM capsule_source_readiness WHERE thread_id = ?")
        .get(latest.threadId) as { status: string; checked_through: number } | null;
      expect(readiness).toMatchObject({ status: "ready", checked_through: latest.turns });
      const before = await fresh.json<ThreadStats>(`/api/threads/${latest.threadId}`);
      const providerCalls = fresh.provider.calls.length;
      const blocked = await fresh.fetch(
        `/api/threads/${latest.threadId}/turn`,
        jsonPost({ text: "must wait for imported index" }),
      );
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ code: "compaction_pending" });
      expect(fresh.provider.calls).toHaveLength(providerCalls);
      const afterBlocked = await fresh.json<ThreadStats>(`/api/threads/${latest.threadId}`);
      expect(afterBlocked.headHash).toBe(before.headHash);
      expect(afterBlocked.turns).toBe(before.turns);
      for (
        let attempt = 0;
        attempt < 32 && (latest.compaction?.pending ?? latest.compactionPending);
        attempt += 1
      ) {
        const maintenance = await fresh.fetch(`/api/threads/${latest.threadId}/maintenance`, jsonPost({}));
        expect(maintenance.status).toBe(200);
        latest = (await maintenance.json()) as ThreadStats;
      }
      expect(latest.compaction?.pending ?? latest.compactionPending).toBe(false);

      fresh.provider.reply("after imported index");
      const events = await fresh.sse(`/api/threads/${latest.threadId}/turn`, {
        text: "now continue the imported thread",
      });
      expect(events.some((event) => event.type === "done")).toBe(true);
      const reopened = await fresh.json<ThreadStats>(`/api/threads/${latest.threadId}`);
      expect(reopened.compaction?.pending ?? reopened.compactionPending).toBe(false);
      expect(reopened.turns).toBeGreaterThan(before.turns);
    } finally {
      await fresh.dispose();
    }
  });
});
