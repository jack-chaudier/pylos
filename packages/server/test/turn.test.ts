import { afterEach, describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  type Episode,
  MAX_THREAD_BUDGET,
  MAX_THREAD_MODEL_BYTES,
  type ModelInfo,
  type Packet,
  type ThreadStats,
  type TurnEvent,
} from "@pylos/protocol";
import { fetchProvider } from "../src/providers/fetch.ts";
import { providerHttpError } from "../src/providers/openai-chat.ts";
import { readSse } from "../src/providers/sse.ts";
import type { ProviderEvent, StreamOptions } from "../src/providers/types.ts";
import { FakeProvider } from "./fake-provider.ts";
import { collectSse, type Harness, harness, jsonPost } from "./harness.ts";

const open: Harness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
});

async function fixture(): Promise<{ h: Harness; provider: FakeProvider }> {
  const provider = new FakeProvider();
  const h = await harness({ provider });
  open.push(h);
  return { h, provider };
}

async function newThread(h: Harness): Promise<string> {
  return (await h.json<ThreadStats>("/api/threads", jsonPost({ title: "Test" }))).threadId;
}

/** Lets everything already in flight reach its next await. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * The model catalogue is the await a test can hold open on the turn path: one
 * request can be made to spend its preparation waiting where the next does not.
 */
class HeldCatalogue extends FakeProvider {
  private held: Promise<void> | undefined;

  /** Holds the next catalogue read until the returned function is called. */
  holdCatalogue(): () => void {
    let release = (): void => {};
    this.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  override async models(): Promise<ModelInfo[]> {
    const held = this.held;
    this.held = undefined;
    if (held !== undefined) await held;
    return super.models();
  }
}

class StalledSseProvider extends FakeProvider {
  private invocation = 0;

  override async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    this.invocation += 1;
    if (this.invocation === 1) {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"partial":'));
          return new Promise<void>(() => {});
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      });
      for await (const _frame of readSse(body, { inactivityTimeoutMs: 25 })) {
        // A complete frame would be translated here; this oracle deliberately
        // never supplies one.
      }
      return;
    }
    yield { type: "delta", text: "the lane recovered" };
    yield { type: "done", finishReason: "stop" };
  }
}

class StalledHeaderProvider extends FakeProvider {
  private invocation = 0;

  override async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    this.invocation += 1;
    if (this.invocation === 1) {
      await fetchProvider(
        () => new Promise<Response>(() => {}),
        "https://provider.test/chat",
        {},
        { label: "Test provider", signal: opts.signal, timeoutMs: 25 },
      );
      return;
    }
    yield { type: "delta", text: "headers recovered" };
    yield { type: "done", finishReason: "stop" };
  }
}

class PostHeaderAbortProvider extends FakeProvider {
  private invocation = 0;
  private markStalled = (): void => {};
  readonly stalled = new Promise<void>((resolve) => {
    this.markStalled = resolve;
  });

  override async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    this.invocation += 1;
    if (this.invocation === 1) {
      const markStalled = this.markStalled;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"partial":'));
          markStalled();
          return new Promise<void>(() => {});
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      });
      for await (const _frame of readSse(body, {
        inactivityTimeoutMs: 30_000,
        signal: opts.signal,
      })) {
        // The post-header caller abort must settle this read first.
      }
      return;
    }
    yield { type: "delta", text: "post-header abort released the lane" };
    yield { type: "done", finishReason: "stop" };
  }
}

class CommentHeartbeatProvider extends FakeProvider {
  private invocation = 0;

  override async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    this.invocation += 1;
    if (this.invocation === 1) {
      const heartbeat = new TextEncoder().encode(": keep-alive\n\n");
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              try {
                controller.enqueue(heartbeat);
              } catch {
                // The hard deadline may have cancelled first.
              }
              resolve();
            }, 5);
          });
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      });
      for await (const _frame of readSse(body, {
        inactivityTimeoutMs: 100,
        totalTimeoutMs: 40,
        maxStreamBytes: 1024,
        signal: opts.signal,
      })) {
        // Comments produce no frames; the overall deadline remains binding.
      }
      return;
    }
    yield { type: "delta", text: "heartbeat deadline released the lane" };
    yield { type: "done", finishReason: "stop" };
  }
}

class SlowErrorBodyProvider extends FakeProvider {
  private invocation = 0;

  override async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    this.invocation += 1;
    if (this.invocation === 1) {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              try {
                controller.enqueue(new Uint8Array([120]));
              } catch {
                // The absolute body deadline may have cancelled first.
              }
              resolve();
            }, 5);
          });
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      });
      throw await providerHttpError("Test provider", new Response(body, { status: 500 }), {
        inactivityTimeoutMs: 100,
        totalTimeoutMs: 40,
      });
    }
    yield { type: "delta", text: "error body deadline released the lane" };
    yield { type: "done", finishReason: "stop" };
  }
}

/** A first stream that ends without an answer, then an ordinary reply. */
class SilentProvider extends FakeProvider {
  private invocation = 0;
  private readonly silence: string | undefined;

  constructor(silence?: string) {
    super();
    this.silence = silence;
  }

  override async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    this.invocation += 1;
    if (this.invocation === 1) {
      if (this.silence !== undefined) yield { type: "delta", text: this.silence };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    yield { type: "delta", text: "the retry was recorded" };
    yield { type: "done", finishReason: "stop" };
  }
}

describe("turns on one thread are serialized", () => {
  test("a stalled provider frame fails and releases the thread lane", async () => {
    const provider = new StalledSseProvider();
    const h = await harness({ provider });
    open.push(h);
    const thread = await newThread(h);

    const failed = await h.sse(`/api/threads/${thread}/turn`, { text: "first question" });
    expect(failed.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ code: "provider_timeout" }),
    ]);
    expect(
      failed.some((event) => event.type === "gate" || event.type === "delta" || event.type === "done"),
    ).toBe(false);

    const recovered = await h.sse(`/api/threads/${thread}/turn`, { text: "second question" });
    expect(recovered.at(-1)).toMatchObject({
      type: "done",
      episode: { content: "the lane recovered" },
    });
    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.role)).toEqual(["user", "user", "assistant"]);
  });

  test("a stalled provider header fetch fails and releases the thread lane", async () => {
    const provider = new StalledHeaderProvider();
    const h = await harness({ provider });
    open.push(h);
    const thread = await newThread(h);

    const failed = await h.sse(`/api/threads/${thread}/turn`, { text: "first question" });
    expect(failed.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ code: "provider_timeout" }),
    ]);
    const recovered = await h.sse(`/api/threads/${thread}/turn`, { text: "second question" });
    expect(recovered.at(-1)).toMatchObject({ type: "done", episode: { content: "headers recovered" } });
  });

  test("a client abort after provider headers cancels the stalled body and releases the thread lane", async () => {
    const provider = new PostHeaderAbortProvider();
    const h = await harness({ provider });
    open.push(h);
    const thread = await newThread(h);
    const abandoned = new AbortController();
    const first = h
      .fetch(`/api/threads/${thread}/turn`, {
        ...jsonPost({ text: "first question" }),
        signal: abandoned.signal,
      })
      .then(collectSse);

    await provider.stalled;
    abandoned.abort(new Error("client left after provider headers"));
    await first.catch(() => undefined);

    const recovered = await h.sse(`/api/threads/${thread}/turn`, { text: "second question" });
    expect(recovered.at(-1)).toMatchObject({
      type: "done",
      episode: { content: "post-header abort released the lane" },
    });
    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.role)).toEqual(["user", "user", "assistant"]);
  }, 2_000);

  test("comment heartbeats hit the hard deadline and release the thread lane", async () => {
    const provider = new CommentHeartbeatProvider();
    const h = await harness({ provider });
    open.push(h);
    const thread = await newThread(h);

    const failed = await h.sse(`/api/threads/${thread}/turn`, { text: "first question" });
    expect(failed.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        code: "provider_timeout",
        message: "Provider stream exceeded the 40 ms overall deadline.",
      }),
    ]);
    expect(
      failed.some((event) => event.type === "gate" || event.type === "delta" || event.type === "done"),
    ).toBe(false);

    const recovered = await h.sse(`/api/threads/${thread}/turn`, { text: "second question" });
    expect(recovered.at(-1)).toMatchObject({
      type: "done",
      episode: { content: "heartbeat deadline released the lane" },
    });
  });

  test("a slow-drip provider error body hits its deadline and releases the thread lane", async () => {
    const provider = new SlowErrorBodyProvider();
    const h = await harness({ provider });
    open.push(h);
    const thread = await newThread(h);

    const failed = await h.sse(`/api/threads/${thread}/turn`, { text: "first question" });
    expect(failed.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ code: "provider_error" }),
    ]);
    const recovered = await h.sse(`/api/threads/${thread}/turn`, { text: "second question" });
    expect(recovered.at(-1)).toMatchObject({
      type: "done",
      episode: { content: "error body deadline released the lane" },
    });
  });

  test("the slower turn still commits first: user A, assistant A, user B, assistant B", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);
    // A's provider is still thinking when B arrives, and B's answers instantly.
    const releaseA = provider.deferReply("answer A");
    provider.reply("answer B");

    const a = h.sse(`/api/threads/${thread}/turn`, { text: "question A" });
    await settle();
    const b = h.sse(`/api/threads/${thread}/turn`, { text: "question B" });
    await settle();
    releaseA();
    await Promise.all([a, b]);

    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.content)).toEqual([
      "question A",
      "answer A",
      "question B",
      "answer B",
    ]);
    expect(episodes.map((episode) => episode.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const verified = await h.json<{ ok: boolean }>(`/api/threads/${thread}/verify`, jsonPost({}));
    expect(verified.ok).toBe(true);
  });

  test("the request that arrives first commits first, however slowly it prepares", async () => {
    const provider = new HeldCatalogue();
    const h = await harness({ provider });
    open.push(h);
    const thread = await newThread(h);
    provider.reply("answer A");
    provider.reply("answer B");

    // A stalls where B does not — reading the catalogue — so the two are ready
    // to run in the opposite order to the one they arrived in.
    const releaseCatalogue = provider.holdCatalogue();
    const a = h.sse(`/api/threads/${thread}/turn`, { text: "question A" });
    await settle();
    const b = h.sse(`/api/threads/${thread}/turn`, { text: "question B" });
    await settle();
    releaseCatalogue();
    await Promise.all([a, b]);

    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.content)).toEqual([
      "question A",
      "answer A",
      "question B",
      "answer B",
    ]);
  });

  test("a turn refused before it starts gives the lane back", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);

    for (let i = 0; i < 3; i += 1) {
      const rejected = await h.fetch(`/api/threads/${thread}/turn`, jsonPost({ text: 42 }));
      expect(rejected.status).toBe(400);
    }

    // The lane is empty again: one turn runs and eight still fit behind it.
    const release = provider.deferReply("answer 0");
    for (let i = 1; i <= 8; i += 1) provider.reply(`answer ${i}`);
    const streams: Response[] = [];
    for (let i = 0; i <= 8; i += 1) {
      streams.push(await h.fetch(`/api/threads/${thread}/turn`, jsonPost({ text: `question ${i}` })));
    }
    expect(streams.every((response) => response.status === 200)).toBe(true);
    expect((await h.fetch(`/api/threads/${thread}/turn`, jsonPost({ text: "one too many" }))).status).toBe(
      429,
    );

    release();
    await Promise.all(streams.map((response) => collectSse(response)));
    const stats = await h.json<ThreadStats>(`/api/threads/${thread}`);
    expect(stats.turns).toBe(18);
  });

  test("another thread runs while the first one waits", async () => {
    const { h, provider } = await fixture();
    const first = await newThread(h);
    const second = await newThread(h);
    const releaseFirst = provider.deferReply("held");
    provider.reply("free");

    const held = h.sse(`/api/threads/${first}/turn`, { text: "slow" });
    await settle();
    const other = await h.sse(`/api/threads/${second}/turn`, { text: "quick" });
    expect(other.at(-1)?.type).toBe("done");

    releaseFirst();
    await held;
  });

  test("a ninth waiting turn is refused with 429 thread_busy", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);
    const release = provider.deferReply("answer 0");
    for (let i = 1; i <= 8; i += 1) provider.reply(`answer ${i}`);

    const streams: Response[] = [];
    for (let i = 0; i <= 8; i += 1) {
      streams.push(await h.fetch(`/api/threads/${thread}/turn`, jsonPost({ text: `question ${i}` })));
    }
    expect(streams.every((response) => response.status === 200)).toBe(true);

    const refused = await h.fetch(`/api/threads/${thread}/turn`, jsonPost({ text: "one too many" }));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "thread_busy" });

    release();
    await Promise.all(streams.map((response) => collectSse(response)));
    const stats = await h.json<ThreadStats>(`/api/threads/${thread}`);
    expect(stats.turns).toBe(18);
  });

  test("a client that leaves lets the next turn through", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);
    const release = provider.deferReply("answer A");
    provider.reply("answer B");

    const first = h.sse(`/api/threads/${thread}/turn`, { text: "question A" });
    await settle();
    const abandoned = new AbortController();
    const waiting = h.fetch(`/api/threads/${thread}/turn`, {
      ...jsonPost({ text: "abandoned" }),
      signal: abandoned.signal,
    });
    await settle();
    abandoned.abort();
    release();
    await first;
    await waiting.catch(() => undefined);
    await settle();

    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.content)).toEqual(["question A", "answer A"]);
  });
});

/**
 * A thread where an exact value was said early and has since fallen out of the
 * view: the ledger knows where it is, and a draft that states it is checked.
 */
async function threadWithLostValue(h: Harness, provider: FakeProvider): Promise<string> {
  const thread = await newThread(h);
  provider.reply("Noted.");
  await h.sse(`/api/threads/${thread}/turn`, {
    text: "Kestrel Systems signed the Valletta contract for 48250 usd.",
    budget: 1024,
  });
  for (let i = 0; i < 24; i += 1) {
    provider.reply(`Reply ${i} about the rollout in Tallinn.`);
    await h.sse(`/api/threads/${thread}/turn`, {
      text: `Turn ${i}: the ingest worker in Oaxaca is degraded; p99 latency at ${300 + i} ms.`,
      budget: 1024,
    });
  }
  return thread;
}

const DRAFT = "The amount was 48250 usd.";
const REISSUED = "The amount was 48250 usd — the Valletta contract.";
const QUALIFIED_REISSUED = `${REISSUED}\n\n⟨pylos UNKNOWN · no turn in the archive backs this recollection⟩`;
const ATTACHED = "The kiln at Sagres fired unevenly because the flue was blocked.";

describe("the full turn path", () => {
  test("recall, check and receipts reach the client and the packet", async () => {
    const { h, provider } = await fixture();
    const thread = await threadWithLostValue(h, provider);
    provider.recallThen({ seq: 3 }, DRAFT);
    provider.reply(REISSUED);

    const events = await h.sse(`/api/threads/${thread}/turn`, {
      text: "Tell me the number again.",
      budget: 1024,
    });
    expect(events.map((event) => event.type)).toEqual([
      "episode",
      "packet",
      "page",
      "check",
      "gate",
      "delta",
      "done",
    ]);

    const check = events.find((event) => event.type === "check");
    expect(check?.type === "check" && check.names).toEqual(["48250 usd"]);
    expect(check?.type === "check" && check.pages.some((page) => page.seqs.includes(1))).toBe(true);
    const gate = events.find((event) => event.type === "gate");
    expect(gate?.type === "gate" && gate.receipt.digest).toMatch(/^[0-9a-f]{64}$/);

    const done = events.at(-1) as Extract<TurnEvent, { type: "done" }>;
    expect(done.episode.content).toBe(QUALIFIED_REISSUED);
    expect(done.episode.meta.check?.status).toBe("revised");
    expect(done.episode.meta.check?.names).toEqual(["48250 usd"]);
    expect(done.episode.meta.roundsDigest).toMatch(/^[0-9a-f]{64}$/);

    const user = events[0] as Extract<TurnEvent, { type: "episode" }>;
    const packet = await h.json<Packet>(`/api/threads/${thread}/packets/${user.episode.seq}`);
    expect(packet.rounds).toHaveLength(3);
    expect(packet.rounds?.map((round) => round.ordinal)).toEqual([0, 1, 2]);
    expect(packet.rounds?.[0]?.messagesDigest).toBe(packet.digest);
    for (const round of packet.rounds ?? []) {
      expect(round.tokens).toBeLessThanOrEqual(round.budget);
      expect(round.status).toBe("done");
    }
    expect(packet.rounds?.[1]?.pages.some((page) => page.trigger === "model")).toBe(true);
    expect(packet.rounds?.[2]?.pages.some((page) => page.trigger === "check")).toBe(true);
  }, 20_000);

  test("a provider answer quoting a recovery marker still verifies on the next turn", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);
    provider.reply("You showed me ⟦recovered #1 · user⟧ and I am quoting it back.");
    await h.sse(`/api/threads/${thread}/turn`, { text: "what were you shown?" });
    provider.reply("Nothing new since then.");
    await h.sse(`/api/threads/${thread}/turn`, { text: "and now?" });

    // The quoted marker is archive text in the second turn's recent window; it
    // is not a page this packet admitted, and verification must not read it as one.
    const sent = (provider.calls.at(-1)?.messages ?? []).map((message) => message.content).join("\n");
    expect(sent).toContain("⟦recovered #1 · user⟧");
    const verified = await h.json<{ ok: boolean; reason?: string }>(
      `/api/threads/${thread}/verify`,
      jsonPost({}),
    );
    expect(verified.ok, verified.reason).toBe(true);
  });

  test("an attachment uploaded before the turn is in the view the model is sent", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);
    const form = new FormData();
    form.append("f", new File([ATTACHED], "kiln.txt", { type: "text/plain" }));
    const attached = await h.json<Episode[]>(`/api/threads/${thread}/attach`, {
      method: "POST",
      body: form,
    });
    expect(attached.map((episode) => episode.role)).toEqual(["attachment"]);

    provider.reply("Unevenly, because the flue was blocked.");
    await h.sse(`/api/threads/${thread}/turn`, { text: "what does the note say about the kiln?" });
    const sent = (provider.calls[0]?.messages ?? []).map((message) => message.content).join("\n");
    expect(sent).toContain(ATTACHED);

    // `/attach` appends the episode; the compiler's recent window is what puts it
    // in the view, and the turn must never append it a second time — the chain
    // would carry the same bytes twice.
    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.role)).toEqual(["attachment", "user", "assistant"]);
    expect(episodes[0]?.meta.name).toBe("kiln.txt");
  });
});

describe("a stream that carries no answer", () => {
  test("zero deltas fail the turn: nothing is appended and the resend succeeds", async () => {
    const provider = new SilentProvider();
    const h = await harness({ provider });
    open.push(h);
    const thread = await newThread(h);

    const failed = await h.sse(`/api/threads/${thread}/turn`, { text: "who signed it?" });
    expect(failed.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        code: "empty_answer",
        message: "The model returned no reply — the turn was not recorded; send again to retry.",
      }),
    ]);
    expect(
      failed.some((event) => event.type === "gate" || event.type === "delta" || event.type === "done"),
    ).toBe(false);

    // The question was said, so it stays; nothing else was written for it.
    const said = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(said.map((episode) => episode.role)).toEqual(["user"]);
    // The attempt's receipt is queryable exactly as a provider failure leaves it.
    const packet = await h.json<Packet>(`/api/threads/${thread}/packets/1`);
    expect(packet.status).toBe("pending");
    expect(packet.answerReceipt).toBeUndefined();

    const recovered = await h.sse(`/api/threads/${thread}/turn`, { text: "who signed it?" });
    const done = recovered.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.type === "done" && done.episode.content).toContain("the retry was recorded");
    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.role)).toEqual(["user", "user", "assistant"]);
    const verified = await h.json<{ ok: boolean; reason?: string }>(
      `/api/threads/${thread}/verify`,
      jsonPost({}),
    );
    expect(verified.ok, verified.reason).toBe(true);
  });

  test("a whitespace-only answer is refused the same way", async () => {
    const provider = new SilentProvider("  \n\t ");
    const h = await harness({ provider });
    open.push(h);
    const thread = await newThread(h);

    const failed = await h.sse(`/api/threads/${thread}/turn`, { text: "say something" });
    expect(failed.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ code: "empty_answer" }),
    ]);
    expect(
      failed.some((event) => event.type === "gate" || event.type === "delta" || event.type === "done"),
    ).toBe(false);
    const said = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(said.map((episode) => episode.role)).toEqual(["user"]);

    const recovered = await h.sse(`/api/threads/${thread}/turn`, { text: "say something" });
    const done = recovered.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.type === "done" && done.episode.content).toContain("the retry was recorded");
  });

  test("the gateway reports the same failure instead of an empty completion", async () => {
    const provider = new SilentProvider();
    const h = await harness({ provider });
    open.push(h);
    const thread = await newThread(h);

    const response = await h.fetch("/v1/chat/completions", {
      ...jsonPost({
        model: "grok-4.6",
        stream: false,
        messages: [{ role: "user", content: "who signed it?" }],
      }),
      headers: { "Content-Type": "application/json", "X-Pylos-Thread": thread },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The model returned no reply — the turn was not recorded; send again to retry.",
      code: "empty_answer",
    });
    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.role)).toEqual(["user"]);
  });
});

describe("the model divider", () => {
  test("a switch between two turns is a handoff episode, written by the second turn", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);
    provider.reply("first");
    await h.sse(`/api/threads/${thread}/turn`, { text: "one", model: "grok-4.6" });
    provider.reply("second");
    const events = await h.sse(`/api/threads/${thread}/turn`, { text: "two", model: "grok-toolless" });

    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.role)).toEqual([
      "user",
      "assistant",
      "handoff",
      "user",
      "assistant",
    ]);
    expect(episodes[2]?.meta.from).toBe("grok-4.6");
    expect(episodes[2]?.meta.to).toBe("grok-toolless");
    // The client sees the divider as it is appended, before the turn's own user turn.
    const appended = events.filter((event) => event.type === "episode");
    expect(appended.map((event) => event.episode.role)).toEqual(["handoff", "user"]);
    expect((await h.json<{ ok: boolean }>(`/api/threads/${thread}/verify`, jsonPost({}))).ok).toBe(true);
  });

  test("attachments between the two turns do not hide the model that spoke", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);
    provider.reply("first");
    await h.sse(`/api/threads/${thread}/turn`, { text: "one", model: "grok-4.6" });

    // More attachment episodes than one step of the walk back reads.
    const form = new FormData();
    for (let i = 0; i < 12; i += 1) {
      form.append(`f${i}`, new File([`note ${i}`], `note-${i}.txt`, { type: "text/plain" }));
    }
    await h.json<Episode[]>(`/api/threads/${thread}/attach`, { method: "POST", body: form });

    provider.reply("second");
    await h.sse(`/api/threads/${thread}/turn`, { text: "two", model: "grok-toolless" });
    const roles = (await h.json<Episode[]>(`/api/threads/${thread}/episodes`)).map((e) => e.role);
    expect(roles.filter((role) => role === "handoff")).toHaveLength(1);
    expect(roles.slice(-3)).toEqual(["handoff", "user", "assistant"]);
  });

  test("a switch before any model has spoken divides nothing", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);
    const refused = await h.fetch(`/api/threads/${thread}/handoff`, jsonPost({ model: "grok-toolless" }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "no_speaker" });

    provider.reply("first");
    await h.sse(`/api/threads/${thread}/turn`, { text: "one", model: "grok-toolless" });
    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.role)).toEqual(["user", "assistant"]);
  });

  test("handing off to the model that last spoke writes nothing", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);
    provider.reply("first");
    await h.sse(`/api/threads/${thread}/turn`, { text: "one", model: "grok-4.6" });

    const response = await h.fetch(`/api/threads/${thread}/handoff`, jsonPost({ model: "grok-4.6" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, changed: false });

    provider.reply("second");
    await h.sse(`/api/threads/${thread}/turn`, { text: "two", model: "grok-4.6" });
    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    expect(episodes.map((episode) => episode.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("speaker lookup crosses a 512-episode gap for handoff and the next turn", async () => {
    const appendGap = (thread: string, h: Harness): void => {
      const kernel = h.context.kernel as unknown as {
        vault: {
          episodes: {
            appendMany(threadId: string, inputs: Array<Record<string, unknown>>): Episode[];
          };
        };
      };
      kernel.vault.episodes.appendMany(
        thread,
        Array.from({ length: 513 }, (_, index) => ({
          role: "system",
          content: `gap ${index}`,
        })),
      );
    };

    const { h, provider } = await fixture();
    const direct = await newThread(h);
    provider.reply("first direct");
    await h.sse(`/api/threads/${direct}/turn`, { text: "one", model: "grok-4.6" });
    appendGap(direct, h);
    const handoff = await h.fetch(`/api/threads/${direct}/handoff`, jsonPost({ model: "grok-toolless" }));
    expect(handoff.status).toBe(200);
    expect(((await handoff.json()) as Episode).role).toBe("handoff");

    const automatic = await newThread(h);
    provider.reply("first automatic");
    await h.sse(`/api/threads/${automatic}/turn`, { text: "one", model: "grok-4.6" });
    appendGap(automatic, h);
    provider.reply("second automatic");
    const events = await h.sse(`/api/threads/${automatic}/turn`, {
      text: "two",
      model: "grok-toolless",
    });
    expect(events.filter((event) => event.type === "episode").map((event) => event.episode.role)).toEqual([
      "handoff",
      "user",
    ]);
  });
});

describe("request field bounds", () => {
  test("native turn rejects invalid budget and model before claiming the lane or writing rows", async () => {
    const { h } = await fixture();
    const thread = await newThread(h);
    const originalEnter = h.context.kernel.enterTurn;
    let entered = 0;
    h.context.kernel.enterTurn = (threadId) => {
      entered += 1;
      return originalEnter.call(h.context.kernel, threadId);
    };
    try {
      const cases = [
        { body: { text: "too much", budget: MAX_THREAD_BUDGET + 1 }, status: 413, code: "budget_too_large" },
        { body: { text: "not positive", budget: 0 }, status: 400, code: "invalid_budget" },
        { body: { text: "not text", model: 42 }, status: 400, code: "invalid_model" },
        {
          body: { text: "too long", model: "m".repeat(MAX_THREAD_MODEL_BYTES + 1) },
          status: 413,
          code: "model_too_large",
        },
      ] as const;
      for (const testCase of cases) {
        const response = await h.fetch(`/api/threads/${thread}/turn`, jsonPost(testCase.body));
        expect(response.status).toBe(testCase.status);
        expect(await response.json()).toMatchObject({ code: testCase.code });
      }
      expect(entered).toBe(0);
      expect(await h.json<Episode[]>(`/api/threads/${thread}/episodes`)).toEqual([]);
    } finally {
      h.context.kernel.enterTurn = originalEnter;
    }
  });

  test("a turn larger than its own budget streams turn_too_large and writes nothing (A12.2)", async () => {
    const { h, provider } = await fixture();
    const thread = await newThread(h);
    provider.reply("the lane is free");

    const failed = await h.sse(`/api/threads/${thread}/turn`, { text: "x".repeat(20_000), budget: 64 });
    expect(failed.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ code: "turn_too_large" }),
    ]);
    expect(
      failed.some((event) => event.type === "gate" || event.type === "delta" || event.type === "done"),
    ).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(await h.json<Episode[]>(`/api/threads/${thread}/episodes`)).toEqual([]);

    // The refused turn recorded its budget on the thread, so the recovery turn
    // states an ordinary one; the lane itself must be free.
    const recovered = await h.sse(`/api/threads/${thread}/turn`, {
      text: "a question that fits",
      budget: 8_192,
    });
    expect(recovered.at(-1)).toMatchObject({ type: "done", episode: { content: "the lane is free" } });
  });

  test("gateway and handoff reject untyped or oversized models before side effects", async () => {
    const { h } = await fixture();
    const thread = await newThread(h);
    const cases = [
      { model: 42, status: 400, code: "invalid_model" },
      { model: "m".repeat(MAX_THREAD_MODEL_BYTES + 1), status: 413, code: "model_too_large" },
    ] as const;
    let created = 0;
    const originalCreate = h.context.kernel.createThread;
    h.context.kernel.createThread = async (...args) => {
      created += 1;
      return originalCreate.apply(h.context.kernel, args);
    };
    try {
      for (const testCase of cases) {
        const response = await h.fetch("/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: testCase.model, messages: [{ role: "user", content: "hello" }] }),
        });
        expect(response.status).toBe(testCase.status);
        expect(await response.json()).toMatchObject({ code: testCase.code });
      }
      expect(created).toBe(0);
    } finally {
      h.context.kernel.createThread = originalCreate;
    }

    const before = await h.json<Episode[]>(`/api/threads/${thread}/episodes`);
    for (const testCase of cases) {
      const response = await h.fetch(`/api/threads/${thread}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: testCase.model }),
      });
      expect(response.status).toBe(testCase.status);
      expect(await response.json()).toMatchObject({ code: testCase.code });
    }
    expect(await h.json<Episode[]>(`/api/threads/${thread}/episodes`)).toEqual(before);
  });
});

describe("the gateway and the check round", () => {
  test("a non-streaming completion carries only the final text", async () => {
    const { h, provider } = await fixture();
    const thread = await threadWithLostValue(h, provider);
    provider.reply(DRAFT);
    provider.reply(REISSUED);

    const response = await h.fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pylos-Thread": thread },
      body: JSON.stringify({ model: "grok-4.6", messages: [{ role: "user", content: "The number?" }] }),
    });
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe(REISSUED);
  }, 20_000);

  test("a stream gates the committed answer without draft or retract chunks", async () => {
    const { h, provider } = await fixture();
    const thread = await threadWithLostValue(h, provider);
    provider.reply(DRAFT);
    provider.reply(REISSUED);

    const response = await h.fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pylos-Thread": thread },
      body: JSON.stringify({
        model: "grok-4.6",
        stream: true,
        messages: [{ role: "user", content: "The number?" }],
      }),
    });
    const frames = (await response.text())
      .split("\n\n")
      .flatMap((frame) => (frame.startsWith("data: ") ? [frame.slice(6)] : []))
      .filter((payload) => payload !== "[DONE]")
      .map((payload) => JSON.parse(payload) as GatewayChunk);

    const draftAt = frames.findIndex((frame) => frame.choices?.[0]?.delta.content === DRAFT);
    const gateAt = frames.findIndex((frame) => frame.x_pylos?.event === "gate");
    const finalAt = frames.findIndex((frame) => frame.choices?.[0]?.delta.content === REISSUED);
    expect(draftAt).toBe(-1);
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(frames[gateAt]?.x_pylos?.receipt).toBeDefined();
    expect(frames.some((frame) => frame.x_pylos?.event === "check")).toBe(false);
    expect(frames.some((frame) => frame.x_pylos?.retract === true)).toBe(false);
    expect(finalAt).toBeGreaterThan(gateAt);
    expect(frames.at(-1)?.choices?.[0]?.finish_reason).toBe("stop");
  }, 20_000);

  test("a check that could not be run still streams the qualified kept draft", async () => {
    const { h, provider } = await fixture();
    const thread = await threadWithLostValue(h, provider);
    provider.reply(DRAFT);
    // Nothing scripted for the check round: the provider says nothing at all.
    provider.reply("");

    const response = await h.fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pylos-Thread": thread },
      body: JSON.stringify({
        model: "grok-4.6",
        stream: true,
        messages: [{ role: "user", content: "The number?" }],
      }),
    });
    const frames = (await response.text())
      .split("\n\n")
      .flatMap((frame) => (frame.startsWith("data: ") ? [frame.slice(6)] : []))
      .filter((payload) => payload !== "[DONE]")
      .map((payload) => JSON.parse(payload) as GatewayChunk);
    const gateAt = frames.findIndex((frame) => frame.x_pylos?.event === "gate");
    const answerAt = frames.findIndex((frame) => frame.choices?.[0]?.delta.content?.includes(DRAFT));
    const answer = frames.map((frame) => frame.choices?.[0]?.delta.content ?? "").join("");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(frames[gateAt]?.x_pylos?.receipt).toBeDefined();
    expect(answerAt).toBeGreaterThan(gateAt);
    expect(answer).toContain(DRAFT);
    expect(answer).not.toContain("could not be re-read");
    expect(frames.some((frame) => frame.x_pylos?.event === "check")).toBe(false);
    expect(frames.some((frame) => frame.x_pylos?.retract === true)).toBe(false);

    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes?limit=1`);
    expect(episodes[0]?.meta.check?.status).toBe("check-failed");
  }, 20_000);
});

interface GatewayChunk {
  choices?: Array<{ delta: { content?: string }; finish_reason: string | null }>;
  x_pylos?: { event?: string; receipt?: Record<string, unknown>; names?: string[]; retract?: boolean };
}
