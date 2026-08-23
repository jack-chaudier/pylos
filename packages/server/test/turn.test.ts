import { afterEach, describe, expect, test } from "bun:test";
import type { Episode, ModelInfo, Packet, ThreadStats, TurnEvent } from "@pylos/protocol";
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
