import { afterEach, expect, test } from "bun:test";
import type { ChatMessage } from "@pylos/protocol";
import type { ProviderEvent, StreamOptions } from "../src/providers/types.ts";
import { FakeProvider } from "./fake-provider.ts";
import { type Harness, harness, jsonPost } from "./harness.ts";

const open: Harness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
});

type ApiEvent =
  | { type: "gate"; receipt: Record<string, unknown> }
  | { type: "delta"; text: string }
  | { type: "done"; episode: { content: string } }
  | { type: string; [key: string]: unknown };

interface GatewayChunk {
  choices?: Array<{ delta?: { content?: string; role?: string }; finish_reason?: string | null }>;
  x_pylos?: { event?: string; receipt?: Record<string, unknown>; retract?: boolean };
  error?: { message?: string; code?: string };
}

/** Scripted provider with multi-delta responses and no network or model state. */
class GateProvider extends FakeProvider {
  private readonly scripts: Array<() => ProviderEvent[]> = [];

  chunks(...texts: string[]): void {
    this.scripts.push(() => [
      ...texts.map((text) => ({ type: "delta" as const, text })),
      { type: "done" as const, finishReason: "stop" },
    ]);
  }

  override async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    const script = this.scripts.shift() ?? (() => [{ type: "done" as const, finishReason: "stop" }]);
    for (const event of script()) yield event;
  }
}

async function newThread(h: Harness): Promise<string> {
  return (await h.json<{ threadId: string }>("/api/threads", jsonPost({ title: "Gate stream" }))).threadId;
}

async function collectGateway(response: Response): Promise<GatewayChunk[]> {
  if (response.body === null) throw new Error("no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunks: GatewayChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        chunks.push(JSON.parse(payload) as GatewayChunk);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return chunks;
}

test("the native thread SSE emits no delta before the gate receipt", async () => {
  const provider = new GateProvider();
  provider.chunks("There ", "were 2 launch notes.");
  const h = await harness({ provider });
  open.push(h);
  const thread = await newThread(h);

  const events = (await h.sse(`/api/threads/${thread}/turn`, {
    text: "List every launch note.",
    budget: 8192,
  })) as unknown as ApiEvent[];
  const gate = events.findIndex((event) => event.type === "gate");
  expect(gate).toBeGreaterThanOrEqual(0);
  expect((events[gate] as Extract<ApiEvent, { type: "gate" }>).receipt).toBeDefined();
  const deltas = events
    .map((event, index) => (event.type === "delta" ? index : -1))
    .filter((index) => index >= 0);
  expect(deltas.length).toBeGreaterThan(0);
  expect(deltas.every((index) => index > gate)).toBe(true);

  const done = events.find((event) => event.type === "done") as
    | { type: "done"; episode: { content: string } }
    | undefined;
  expect(done?.episode.content).toMatch(/I found 2|UNKNOWN|unverified/i);
});

test("the OpenAI-compatible SSE buffers content until its x_pylos gate chunk", async () => {
  const provider = new GateProvider();
  provider.chunks("There ", "were 2 launch notes.");
  const h = await harness({ provider });
  open.push(h);
  const thread = await newThread(h);

  const response = await h.fetch("/v1/chat/completions", {
    ...jsonPost({
      model: "grok-4.6",
      stream: true,
      messages: [{ role: "user", content: "List every launch note." }],
    }),
    headers: {
      "Content-Type": "application/json",
      "X-Pylos-Thread": thread,
    },
  });
  expect(response.status).toBe(200);
  const chunks = await collectGateway(response);
  const gate = chunks.findIndex((chunk) => chunk.x_pylos?.event === "gate");
  expect(gate).toBeGreaterThanOrEqual(0);
  expect(chunks[gate]?.x_pylos?.receipt).toBeDefined();
  expect(chunks.slice(0, gate).some((chunk) => chunk.choices !== undefined)).toBe(false);
  expect(chunks[gate]?.choices?.[0]?.delta?.role).toBe("assistant");
  expect(chunks.some((chunk) => chunk.x_pylos?.event === "check")).toBe(false);
  expect(chunks.some((chunk) => chunk.x_pylos?.retract === true)).toBe(false);
  const content = chunks
    .map((chunk, index) => ({ index, text: chunk.choices?.[0]?.delta?.content }))
    .filter((entry): entry is { index: number; text: string } => entry.text !== undefined);
  expect(content.length).toBeGreaterThan(0);
  expect(content.every((entry) => entry.index > gate)).toBe(true);
  expect(content.map((entry) => entry.text).join("")).toMatch(/I found 2|UNKNOWN|unverified/i);
});

test("gateway non-streaming output is only the committed, qualified answer", async () => {
  const provider = new GateProvider();
  provider.chunks("There were 2 launch notes.");
  const h = await harness({ provider });
  open.push(h);
  const thread = await newThread(h);

  const response = await h.fetch("/v1/chat/completions", {
    ...jsonPost({
      model: "grok-4.6",
      stream: false,
      messages: [{ role: "user", content: "List every launch note." }],
    }),
    headers: {
      "Content-Type": "application/json",
      "X-Pylos-Thread": thread,
    },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content ?? "";
  expect(text).toMatch(/I found 2|UNKNOWN|unverified/i);
  expect(text.toLowerCase()).not.toContain("there were 2");
});

test("catalogue-declared toolless models receive no recall or claim-map tools", async () => {
  const provider = new GateProvider();
  provider.chunks("Native answer.");
  provider.chunks("Gateway stream answer.");
  provider.chunks("Gateway non-stream answer.");
  const h = await harness({ provider });
  open.push(h);
  const thread = await newThread(h);

  await h.sse(`/api/threads/${thread}/turn`, {
    text: "Answer without archive tools.",
    model: "grok-toolless",
  });
  const nativeCall = provider.calls.at(-1);
  expect(nativeCall?.opts.tools ?? []).toHaveLength(0);
  expect(nativeCall?.messages.find((message) => message.role === "system")?.content).not.toContain(
    "`recall`",
  );
  expect(nativeCall?.messages.find((message) => message.role === "system")?.content).not.toContain(
    "submit_claim_map",
  );

  const streamed = await h.fetch("/v1/chat/completions", {
    ...jsonPost({
      model: "grok-toolless",
      stream: true,
      messages: [{ role: "user", content: "Answer without archive tools." }],
    }),
    headers: { "Content-Type": "application/json", "X-Pylos-Thread": thread },
  });
  expect(streamed.status).toBe(200);
  await collectGateway(streamed);
  const gatewayStreamCall = provider.calls.at(-1);
  expect(gatewayStreamCall?.opts.tools ?? []).toHaveLength(0);
  expect(gatewayStreamCall?.messages.find((message) => message.role === "system")?.content).not.toContain(
    "`recall`",
  );
  expect(gatewayStreamCall?.messages.find((message) => message.role === "system")?.content).not.toContain(
    "submit_claim_map",
  );

  const nonStreamed = await h.fetch("/v1/chat/completions", {
    ...jsonPost({
      model: "grok-toolless",
      stream: false,
      messages: [{ role: "user", content: "Answer without archive tools." }],
    }),
    headers: { "Content-Type": "application/json", "X-Pylos-Thread": thread },
  });
  expect(nonStreamed.status).toBe(200);
  await nonStreamed.json();
  const gatewayNonStreamCall = provider.calls.at(-1);
  expect(gatewayNonStreamCall?.opts.tools ?? []).toHaveLength(0);
  expect(gatewayNonStreamCall?.messages.find((message) => message.role === "system")?.content).not.toContain(
    "`recall`",
  );
  expect(gatewayNonStreamCall?.messages.find((message) => message.role === "system")?.content).not.toContain(
    "submit_claim_map",
  );
});

class OversizedProvider extends FakeProvider {
  aborted = false;

  constructor(private readonly output: "text" | "tool") {
    super();
  }

  override async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    opts.signal?.addEventListener("abort", () => {
      this.aborted = true;
    });
    try {
      if (this.output === "tool") {
        yield {
          type: "tool_call",
          id: "call_oversized",
          name: "recall",
          args: JSON.stringify({ query: "x".repeat(65 * 1024) }),
        };
      } else {
        for (let i = 0; i < 65; i += 1) yield { type: "delta", text: "¢".repeat(512) };
      }
      yield { type: "done", finishReason: "stop" };
    } finally {
      this.aborted ||= opts.signal?.aborted === true;
    }
  }
}

test("native SSE refuses oversized provider text without leaking an assistant delta", async () => {
  const provider = new OversizedProvider("text");
  const h = await harness({ provider });
  open.push(h);
  const thread = await newThread(h);

  const events = (await h.sse(`/api/threads/${thread}/turn`, {
    text: "Keep the user turn only.",
    budget: 8192,
  })) as unknown as ApiEvent[];
  expect(events.filter((event) => event.type === "error")).toEqual([
    expect.objectContaining({ code: "provider_output_limit" }),
  ]);
  expect(
    events.some((event) => event.type === "delta" || event.type === "gate" || event.type === "done"),
  ).toBe(false);
  expect(provider.aborted).toBe(true);
  const episodes = await h.json<Array<{ role: string }>>(`/api/threads/${thread}/episodes`);
  expect(episodes.map((episode) => episode.role)).toEqual(["user"]);
});

test("gateway streaming refuses oversized tool arguments before gate or content", async () => {
  const provider = new OversizedProvider("tool");
  const h = await harness({ provider });
  open.push(h);
  const thread = await newThread(h);
  const response = await h.fetch("/v1/chat/completions", {
    ...jsonPost({
      model: "grok-4.6",
      stream: true,
      max_tokens: 1_000_000,
      messages: [{ role: "user", content: "Do not release provider output." }],
    }),
    headers: { "Content-Type": "application/json", "X-Pylos-Thread": thread },
  });

  expect(response.status).toBe(200);
  const chunks = await collectGateway(response);
  expect(chunks.filter((chunk) => chunk.error !== undefined)).toEqual([
    expect.objectContaining({ error: expect.objectContaining({ code: "provider_output_limit" }) }),
  ]);
  expect(chunks.some((chunk) => chunk.x_pylos?.event === "gate")).toBe(false);
  expect(chunks.some((chunk) => chunk.choices?.[0]?.delta?.content !== undefined)).toBe(false);
  expect(chunks.some((chunk) => chunk.choices !== undefined)).toBe(false);
  expect(provider.calls[0]?.opts.maxTokens).toBe(8192);
  expect(provider.aborted).toBe(true);
  const episodes = await h.json<Array<{ role: string }>>(`/api/threads/${thread}/episodes`);
  expect(episodes.map((episode) => episode.role)).toEqual(["user"]);
});

test("gateway non-streaming returns a bounded deterministic oversized-output failure", async () => {
  const provider = new OversizedProvider("text");
  const h = await harness({ provider });
  open.push(h);
  const thread = await newThread(h);
  const response = await h.fetch("/v1/chat/completions", {
    ...jsonPost({
      model: "grok-4.6",
      stream: false,
      messages: [{ role: "user", content: "Keep only this user turn." }],
    }),
    headers: { "Content-Type": "application/json", "X-Pylos-Thread": thread },
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "Provider output exceeded the 65536-byte round limit.",
    code: "provider_output_limit",
  });
  expect(provider.aborted).toBe(true);
});
