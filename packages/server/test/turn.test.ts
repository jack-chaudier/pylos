import { afterEach, describe, expect, test } from "bun:test";
import type { Episode, Packet, ThreadStats, TurnEvent } from "@pylos/protocol";
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

describe("turns on one thread are serialized", () => {
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
      "delta",
      "check",
      "delta",
      "done",
    ]);

    const check = events.find((event) => event.type === "check");
    expect(check?.type === "check" && check.names).toEqual(["48250 usd"]);
    expect(check?.type === "check" && check.pages.some((page) => page.seqs.includes(1))).toBe(true);

    const done = events.at(-1) as Extract<TurnEvent, { type: "done" }>;
    expect(done.episode.content).toBe(REISSUED);
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

  test("a stream retracts the draft before the replacement deltas", async () => {
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
    const retractAt = frames.findIndex((frame) => frame.x_pylos !== undefined);
    const finalAt = frames.findIndex((frame) => frame.choices?.[0]?.delta.content === REISSUED);
    expect(draftAt).toBeGreaterThanOrEqual(0);
    expect(retractAt).toBeGreaterThan(draftAt);
    expect(finalAt).toBeGreaterThan(retractAt);
    expect(frames[retractAt]?.x_pylos).toEqual({ event: "check", names: ["48250 usd"], retract: true });
    expect(frames[retractAt]?.choices?.[0]?.delta).toEqual({});
    expect(frames.at(-1)?.choices?.[0]?.finish_reason).toBe("stop");
  }, 20_000);

  test("a check that could not be run still streams the kept draft", async () => {
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
    const text = await response.text();
    expect(text).toContain('"retract":true');
    expect(text).toContain("could not be re-read");

    const episodes = await h.json<Episode[]>(`/api/threads/${thread}/episodes?limit=1`);
    expect(episodes[0]?.meta.check?.status).toBe("check-failed");
  }, 20_000);
});

interface GatewayChunk {
  choices?: Array<{ delta: { content?: string }; finish_reason: string | null }>;
  x_pylos?: { event: string; names: string[]; retract: boolean };
}
