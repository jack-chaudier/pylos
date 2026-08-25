import { afterEach, expect, test } from "bun:test";
import type { ThreadStats } from "@pylos/protocol";
import { api } from "../src/api.ts";
import { FALLBACK_MODEL, selectedBudgetForThread, selectedModelForThread } from "../src/thread-selection.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const thread = (id: string): ThreadStats =>
  ({
    threadId: id,
    title: id,
    turns: 0,
    episodes: { user: 0, assistant: 0, other: 0 },
    archiveBytes: 0,
    capsules: 0,
    losses: 0,
    atoms: { supported: 0, historical: 0, proposed: 0 },
    headHash: "0".repeat(64),
    models: [],
    modelsTruncated: false,
    modelsComplete: true,
    selectedBudget: 32_768,
  }) as ThreadStats;

test("reopen uses the durable model after A-B-A and capped history", () => {
  expect(
    selectedModelForThread({
      ...thread("aba"),
      models: ["model-a", "model-b", "model-a"],
      selectedModel: "model-a",
    }),
  ).toBe("model-a");

  expect(
    selectedModelForThread({
      ...thread("many"),
      models: Array.from({ length: 32 }, (_, index) => `model-${index}`),
      modelsTruncated: true,
      selectedModel: "model-32",
    }),
  ).toBe("model-32");

  expect(
    selectedModelForThread({
      ...thread("legacy-history"),
      models: ["stale-model"],
    }),
  ).toBe(FALLBACK_MODEL);
});

test("reopen uses a changed durable budget without a new packet", () => {
  expect(
    selectedBudgetForThread({
      ...thread("budget"),
      selectedBudget: 1234,
      lastPacket: { tokens: 10, budget: 8192, pages: 0, digest: "0".repeat(64) },
    }),
  ).toBe(1234);
});

test("listThreadsPage accepts the old array response without inventing a cursor", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([thread("legacy")]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

  await expect(api.listThreadsPage()).resolves.toMatchObject({
    threads: [thread("legacy")],
    hasMore: false,
  });
});
