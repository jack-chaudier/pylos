import { afterEach, expect, test } from "bun:test";
import { api } from "../src/api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("live proof verification posts to the thread-scoped chain check", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response(JSON.stringify({ ok: true, checkedTo: 198, headHash: "head-live" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await api.verify("thread-proof");

  expect(result).toEqual({ ok: true, checkedTo: 198, headHash: "head-live" });
  expect(seenUrl).toBe("/api/threads/thread-proof/verify");
  expect(seenInit?.method).toBe("POST");
  expect(seenInit?.body).toBe("{}");
});
