import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@pylos/protocol";
import { toAnthropicMessages } from "../src/providers/anthropic.ts";
import { streamOpenAiChat, toOpenAiMessages } from "../src/providers/openai-chat.ts";
import { inferProvider } from "../src/providers/registry.ts";
import { readSse } from "../src/providers/sse.ts";
import type { ProviderEvent } from "../src/providers/types.ts";
import { redact } from "../src/providers/types.ts";

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("the SSE reader", () => {
  test("splits frames across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"a":'));
        controller.enqueue(encoder.encode("1}\n\ndata: [DO"));
        controller.enqueue(encoder.encode("NE]\n\n"));
        controller.close();
      },
    });
    const frames: string[] = [];
    for await (const frame of readSse(body)) frames.push(frame.data);
    expect(frames).toEqual(['{"a":1}', "[DONE]"]);
  });
});

describe("the OpenAI-shaped stream", () => {
  test("emits deltas, assembles split tool calls, and reports usage", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_a", function: { name: "recall", arguments: '{"qu' } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"x"}' } }] } }],
        }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 40, completion_tokens: 5 },
        }),
        "[DONE]",
      ])) as unknown as typeof fetch;
    try {
      const events = await collect(
        streamOpenAiChat(
          { baseUrl: "https://example.test/v1", token: async () => "k", label: "Test" },
          [{ role: "user", content: "hi" }],
          { model: "grok-4.6" },
        ),
      );
      expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text)).toEqual([
        "Hel",
        "lo",
      ]);
      const call = events.find((e) => e.type === "tool_call");
      expect(call).toMatchObject({ id: "call_a", name: "recall", args: '{"query":"x"}' });
      const usage = events.find((e) => e.type === "usage");
      expect(usage?.type === "usage" && usage.usage.inputTokens).toBe(40);
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a 401 becomes an auth error the UI can act on", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    try {
      await expect(
        collect(
          streamOpenAiChat(
            { baseUrl: "https://example.test/v1", token: async () => "k", label: "xAI" },
            [{ role: "user", content: "hi" }],
            { model: "grok-4.6" },
          ),
        ),
      ).rejects.toMatchObject({ code: "auth_rejected", status: 401 });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("message translation", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "view contract" },
    { role: "user", content: "when?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "recall", args: '{"seq":7}' }],
    },
    { role: "tool", content: "⟦recovered #7⟧ …", toolCallId: "c1" },
  ];

  test("OpenAI shape keeps the tool round-trip replayable", () => {
    const out = toOpenAiMessages(messages);
    expect(out[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "recall" } }],
    });
    expect(out[3]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  test("Anthropic shape lifts system out and blocks the tool round-trip", () => {
    const { system, turns } = toAnthropicMessages(messages);
    expect(system).toBe("view contract");
    expect(turns[0]).toMatchObject({ role: "user", content: "when?" });
    const assistant = turns[1] as { content: Array<{ type: string; name?: string }> };
    expect(assistant.content[0]).toMatchObject({ type: "tool_use", name: "recall" });
    const result = turns[2] as { content: Array<{ type: string; tool_use_id?: string }> };
    expect(result.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
  });

  test("Anthropic always starts on a user turn", () => {
    const { turns } = toAnthropicMessages([{ role: "assistant", content: "orphan" }]);
    expect(turns[0]?.role).toBe("user");
  });
});

describe("routing and redaction", () => {
  test("model ids route to the right provider", () => {
    expect(inferProvider("grok-4.6")).toBe("xai");
    expect(inferProvider("claude-opus-4-5-20251101")).toBe("anthropic");
    expect(inferProvider("gpt-5.2")).toBe("openai");
    expect(inferProvider("llama3.1:8b")).toBe("ollama");
    expect(inferProvider("mystery-model")).toBe("openai-compatible");
  });

  test("redaction removes keys and bearer JWTs from error text", () => {
    expect(redact("bad key xai-abcdefghijklmn here")).not.toContain("abcdefghijklmn");
    expect(redact("token eyJhbGciOi.eyJzdWIi.sig")).toContain("•••jwt");
  });
});
