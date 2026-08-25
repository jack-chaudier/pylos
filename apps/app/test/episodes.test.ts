import { afterEach, expect, test } from "bun:test";
import type { Episode } from "@pylos/protocol";
import { ApiError, api, MAX_TRANSCRIPT_RESPONSE_BYTES } from "../src/api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("transcript API unwraps the bounded page and never exposes an oversized response", async () => {
  const content = "safe prefix";
  const row = {
    threadId: "thread-1",
    seq: 7,
    ts: 1,
    role: "user",
    content,
    tokens: 2,
    prevHash: "prev",
    hash: "chain",
    meta: {},
    contentBytes: 200_000,
    contentTruncated: true,
    locator: {
      source: "episode:7",
      byteRange: [0, content.length],
      contentHash: "content",
      revision: "chain",
    },
    continuation: { from: content.length, to: 200_000, fullBytes: 200_000, source: "episode:7" },
  } satisfies Episode & Record<string, unknown>;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ episodes: [row], truncated: true, byteLength: 300, continuation: row.continuation }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;

  const episodes = await api.episodes("thread-1", { limit: 60 });
  expect(episodes).toHaveLength(1);
  expect(episodes[0]?.content).toBe(content);
  expect((episodes[0] as Episode & { contentTruncated: boolean }).contentTruncated).toBe(true);

  globalThis.fetch = (async () =>
    new Response("x".repeat(MAX_TRANSCRIPT_RESPONSE_BYTES + 1), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  await expect(api.episodes("thread-1", { limit: 60 })).rejects.toMatchObject(
    new ApiError("response_too_large", expect.any(String), 413),
  );
});

test("ordinary reader pages stay bounded and do not auto-follow", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(
      JSON.stringify({
        atoms: [
          {
            id: "atom-1",
            threadId: "thread-1",
            kind: "fact",
            key: "name",
            value: "Ada",
            text: "Ada",
            sourceSeq: 4,
            validFromSeq: 4,
            phase: "SUPPORTED",
            authority: "user",
            pinned: false,
            keyBytes: 4,
            valueBytes: 3,
            textBytes: 3,
          },
        ],
        byteLength: 300,
        truncated: true,
        hasMore: true,
        continuation: { cursor: "next", reason: "page-cap" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const page = await api.atomsPage("thread-1", { limit: 1 });
  expect(page.atoms).toHaveLength(1);
  expect(page.hasMore).toBe(true);
  expect(page.continuation?.cursor).toBe("next");
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("/api/threads/thread-1/atoms?limit=1");
});

test("raw packet reader rejects an oversized body before JSON parsing", async () => {
  let seen = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen = String(input);
    return new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(api.packet("thread-1", 7)).rejects.toMatchObject({
    code: "response_too_large",
    status: 413,
  });
  expect(seen).toBe("/api/threads/thread-1/packets/7");
});
