import { describe, expect, test } from "bun:test";
import type { ChatMessage, ThreadStats } from "@pylos/protocol";
import { TurnConcurrencyGate } from "../src/limits.ts";
import type { ProviderEvent, StreamOptions } from "../src/providers/types.ts";
import { FakeProvider } from "./fake-provider.ts";
import { collectSse, hostedHarness, jsonPost, withSession } from "./harness.ts";

class FirstTwoTurnsStall extends FakeProvider {
  private failures = 0;
  private releaseHeld = (): void => {};
  private readonly held = new Promise<void>((resolve) => {
    this.releaseHeld = resolve;
  });

  release(): void {
    this.releaseHeld();
  }

  failNext(): void {
    this.failures += 1;
  }

  override async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    if (this.calls.length <= 2) await this.held;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("provider fixture failure");
    }
    yield { type: "delta", text: "the admitted turn completed" };
    yield { type: "done", finishReason: "stop" };
  }
}

describe("hosted active-turn admission", () => {
  test("one subject cannot hold more than its multi-thread response-body cap", async () => {
    const provider = new FirstTwoTurnsStall();
    const local = await hostedHarness({ provider, turns: new TurnConcurrencyGate(2, 8) });
    try {
      const { session } = await local.login("turn-cap-subject");
      const threads = await createThreads(local, session, 3);
      const first = await nativeTurn(local, session, threads[0] as string, "one");
      const second = await nativeTurn(local, session, threads[1] as string, "two");
      await callsReach(provider, 2);

      const refused = await nativeTurn(local, session, threads[2] as string, "three");
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ code: "turn_capacity" });
      expect(provider.calls).toHaveLength(2);

      await first.body?.cancel("client closed one held response");
      const recovered = await nativeTurn(local, session, threads[2] as string, "four");
      expect(recovered.status).toBe(200);
      expect((await collectSse(recovered)).at(-1)?.type).toBe("done");

      provider.failNext();
      const failed = await nativeTurn(local, session, threads[2] as string, "five");
      expect((await collectSse(failed)).at(-1)?.type).toBe("error");
      const afterFailure = await nativeTurn(local, session, threads[2] as string, "six");
      expect((await collectSse(afterFailure)).at(-1)?.type).toBe("done");

      await second.body?.cancel("test cleanup");
      provider.release();
    } finally {
      provider.release();
      await local.dispose();
    }
  });

  test("the global cap spans subjects and includes OpenAI-compatible streams", async () => {
    const provider = new FirstTwoTurnsStall();
    const local = await hostedHarness({ provider, turns: new TurnConcurrencyGate(2, 2) });
    try {
      const { session: sessionA } = await local.login("turn-global-a");
      const { session: sessionB } = await local.login("turn-global-b");
      const [threadA] = await createThreads(local, sessionA, 1);
      const [threadB, retryThread] = await createThreads(local, sessionB, 2);
      const first = await nativeTurn(local, sessionA, threadA as string, "one");
      const second = await gatewayTurn(local, sessionB, threadB as string, "two");
      await callsReach(provider, 2);

      const refused = await gatewayTurn(local, sessionB, retryThread as string, "three");
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ code: "turn_capacity" });
      expect(provider.calls).toHaveLength(2);

      await second.body?.cancel("client closed one held gateway response");
      const recovered = await gatewayTurn(local, sessionB, retryThread as string, "four");
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toContain("[DONE]");

      await first.body?.cancel("test cleanup");
      provider.release();
    } finally {
      provider.release();
      await local.dispose();
    }
  });
});

async function createThreads(
  local: Awaited<ReturnType<typeof hostedHarness>>,
  session: string,
  count: number,
): Promise<string[]> {
  const threads: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const thread = await local.json<ThreadStats>("/api/threads", jsonPost({}), session);
    threads.push(thread.threadId);
  }
  return threads;
}

function nativeTurn(
  local: Awaited<ReturnType<typeof hostedHarness>>,
  session: string,
  threadId: string,
  text: string,
): Promise<Response> {
  return local.fetch(`/api/threads/${threadId}/turn`, withSession(jsonPost({ text }), session));
}

function gatewayTurn(
  local: Awaited<ReturnType<typeof hostedHarness>>,
  session: string,
  threadId: string,
  text: string,
): Promise<Response> {
  const init = withSession(
    jsonPost({ model: "grok-4.6", stream: true, messages: [{ role: "user", content: text }] }),
    session,
  );
  const headers = new Headers(init.headers);
  headers.set("x-pylos-thread", threadId);
  return local.fetch("/v1/chat/completions", { ...init, headers });
}

async function callsReach(provider: FakeProvider, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && provider.calls.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(provider.calls).toHaveLength(count);
}
