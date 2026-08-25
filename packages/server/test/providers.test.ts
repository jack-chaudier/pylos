import { describe, expect, test } from "bun:test";
import type { ChatMessage, ModelInfo, ProviderId } from "@pylos/protocol";
import type { AuthService } from "../src/auth/xai.ts";
import { AnthropicProvider, toAnthropicMessages } from "../src/providers/anthropic.ts";
import {
  MAX_PROVIDER_JSON_BODY_BYTES,
  providerHttpError,
  readProviderJson,
  streamOpenAiChat,
  toOpenAiMessages,
} from "../src/providers/openai-chat.ts";
import { HOSTED_PROVIDER_IDS, inferProvider, ProviderRegistry } from "../src/providers/registry.ts";
import { readSse } from "../src/providers/sse.ts";
import type { Provider, ProviderEvent } from "../src/providers/types.ts";
import { redact } from "../src/providers/types.ts";

const RAW_SSE_FRAME_LIMIT = 1024 * 1024;

function countedProvider(id: ProviderId, calls: Map<ProviderId, number>): Provider {
  return {
    id,
    stream(): AsyncIterable<ProviderEvent> {
      throw new Error(`unexpected ${id} stream`);
    },
    async models(): Promise<ModelInfo[]> {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      return [{ id: `${id}-model`, provider: id, label: id, available: true, supportsTools: true }];
    },
  };
}

describe("hosted provider policy", () => {
  test("catalogue and resolution never touch local or user-supplied endpoints", async () => {
    const calls = new Map<ProviderId, number>();
    const ids: ProviderId[] = ["xai", "anthropic", "openai", "ollama", "openai-compatible"];
    const overrides = Object.fromEntries(ids.map((id) => [id, countedProvider(id, calls)])) as Record<
      ProviderId,
      Provider
    >;
    const registry = new ProviderRegistry({} as AuthService, overrides);

    const models = await registry.models(true, HOSTED_PROVIDER_IDS);
    expect(models.map((model) => model.provider).sort()).toEqual(["anthropic", "openai", "xai"]);
    expect(calls.get("ollama") ?? 0).toBe(0);
    expect(calls.get("openai-compatible") ?? 0).toBe(0);
    await expect(registry.resolve("ollama/llama3", HOSTED_PROVIDER_IDS)).rejects.toMatchObject({
      code: "hosted_provider_forbidden",
      status: 403,
    });
    await expect(
      registry.resolve("openai-compatible/redirecting-model", HOSTED_PROVIDER_IDS),
    ).rejects.toMatchObject({ code: "hosted_provider_forbidden", status: 403 });
    expect(calls.get("ollama") ?? 0).toBe(0);
    expect(calls.get("openai-compatible") ?? 0).toBe(0);
  });
});

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

  test("refuses and cancels an oversized undelimited raw frame", async () => {
    let chunks = 0;
    let cancelled = false;
    const raw = new TextEncoder().encode("€".repeat(Math.ceil((RAW_SSE_FRAME_LIMIT + 128 * 1024) / 3)));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        const next = Math.min(raw.byteLength, offset + 64 * 1024 + 1);
        controller.enqueue(raw.subarray(offset, next));
        offset = next;
        if (offset >= raw.byteLength) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(collectFrames(readSse(body))).rejects.toMatchObject({
      code: "provider_output_limit",
      message: `Provider stream frame exceeded the ${RAW_SSE_FRAME_LIMIT}-byte limit.`,
    });
    // Web Streams may queue one pull while the current chunk is being
    // inspected; retained frame memory remains fixed at the reader's cap.
    expect(chunks).toBeLessThanOrEqual(18);
    expect(cancelled).toBe(true);
  });

  test("a provider cancel that never resolves cannot hold the frame refusal open", async () => {
    let chunks = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(97));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("reader cancellation held the refusal open")), 250);
    });

    try {
      await expect(Promise.race([collectFrames(readSse(body)), timeout])).rejects.toMatchObject({
        code: "provider_output_limit",
        message: `Provider stream frame exceeded the ${RAW_SSE_FRAME_LIMIT}-byte limit.`,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // A pending pull may already be queued when cancellation begins.
    expect(chunks).toBeLessThanOrEqual(18);
    expect(cancelled).toBe(true);
  });

  test("a stalled partial SSE frame times out and cancels without awaiting cancel", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('data: {"partial":'));
          return;
        }
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });

    await expect(collectFrames(readSse(body, { inactivityTimeoutMs: 25 }))).rejects.toMatchObject({
      code: "provider_timeout",
      status: 504,
      message: "Provider stream was inactive for 25 ms.",
    });
    expect(cancelled).toBe(true);
  });

  test("comment heartbeats cannot evade the overall stream deadline", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            try {
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
            } catch {
              // The deadline may have cancelled the stream first.
            }
            resolve();
          }, 5);
        });
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });

    await expect(
      collectFrames(
        readSse(body, {
          inactivityTimeoutMs: 100,
          totalTimeoutMs: 35,
          maxStreamBytes: 1024,
        }),
      ),
    ).rejects.toMatchObject({
      code: "provider_timeout",
      status: 504,
      message: "Provider stream exceeded the 35 ms overall deadline.",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
  });

  test("SSE comments and framing count toward the total raw byte ceiling", async () => {
    let cancelled = false;
    const heartbeat = new TextEncoder().encode(": heartbeat\n\n");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(heartbeat);
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      collectFrames(readSse(body, { maxStreamBytes: 30, totalTimeoutMs: 1000 })),
    ).rejects.toMatchObject({
      code: "provider_output_limit",
      status: 502,
      message: "Provider stream exceeded the 30-byte raw limit.",
    });
    expect(cancelled).toBe(true);
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

  test("a fetcher that never returns headers hits the fixed provider deadline", async () => {
    const original = globalThis.fetch;
    let aborted = false;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>(() => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
      })) as typeof fetch;
    try {
      await expect(
        collect(
          streamOpenAiChat(
            { baseUrl: "https://example.test/v1", token: async () => "k", label: "Test" },
            [{ role: "user", content: "hi" }],
            { model: "grok-4.6", headerTimeoutMs: 25 },
          ),
        ),
      ).rejects.toMatchObject({
        code: "provider_timeout",
        status: 504,
        message: "Test did not return response headers within 25 ms.",
      });
      expect(aborted).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("caller cancellation wins without being relabeled by the provider wrapper", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const pending = collect(
      streamOpenAiChat(
        { baseUrl: "https://example.test/v1", token: async () => "k", label: "Test" },
        [{ role: "user", content: "hi" }],
        { model: "grok-4.6", signal: controller.signal, headerTimeoutMs: 1000 },
      ),
    );
    controller.abort(reason);
    try {
      await expect(pending).rejects.toBe(reason);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("caller cancellation after headers interrupts a stalled OpenAI body", async () => {
    const original = globalThis.fetch;
    let pulls = 0;
    let forwardedSignal: AbortSignal | undefined;
    let markPulled = (): void => {};
    const pulled = new Promise<void>((resolve) => {
      markPulled = resolve;
    });
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls > 1) return new Promise<void>(() => {});
            markPulled();
            controller.enqueue(new TextEncoder().encode('data: {"partial":'));
          },
          cancel() {},
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const controller = new AbortController();
    const reason = new Error("caller left after headers");
    const pending = collect(
      streamOpenAiChat(
        { baseUrl: "https://example.test/v1", token: async () => "k", label: "Test" },
        [{ role: "user", content: "hi" }],
        { model: "grok-4.6", signal: controller.signal },
      ),
    );
    try {
      await pulled;
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(forwardedSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("split tool arguments are bounded while the provider parser assembles them", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "c", function: { name: "recall", arguments: "x".repeat(20) } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "x".repeat(20) } }] } }],
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "x".repeat(20) } }] } }],
        }),
      ])) as unknown as typeof fetch;
    try {
      await expect(
        collect(
          streamOpenAiChat(
            { baseUrl: "https://example.test/v1", token: async () => "k", label: "Test" },
            [{ role: "user", content: "hi" }],
            { model: "grok-4.6", maxOutputBytes: 50 },
          ),
        ),
      ).rejects.toMatchObject({ code: "provider_output_limit", status: 502 });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a single oversized OpenAI SSE frame is refused before JSON parsing", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "x".repeat(RAW_SSE_FRAME_LIMIT) } }] }),
      ])) as unknown as typeof fetch;
    try {
      await expect(
        collect(
          streamOpenAiChat(
            { baseUrl: "https://example.test/v1", token: async () => "k", label: "Test" },
            [{ role: "user", content: "hi" }],
            { model: "grok-4.6" },
          ),
        ),
      ).rejects.toMatchObject({
        code: "provider_output_limit",
        message: `Provider stream frame exceeded the ${RAW_SSE_FRAME_LIMIT}-byte limit.`,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("the Anthropic stream preserves the same oversized-frame refusal", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "x".repeat(RAW_SSE_FRAME_LIMIT) },
        }),
      ])) as unknown as typeof fetch;
    const auth = { token: async () => "k" } as unknown as AuthService;
    try {
      await expect(
        collect(new AnthropicProvider(auth).stream([{ role: "user", content: "hi" }], { model: "claude" })),
      ).rejects.toMatchObject({
        code: "provider_output_limit",
        message: `Provider stream frame exceeded the ${RAW_SSE_FRAME_LIMIT}-byte limit.`,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("the Anthropic stream uses the same response-header deadline", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const auth = { token: async () => "k" } as unknown as AuthService;
    try {
      await expect(
        collect(
          new AnthropicProvider(auth).stream([{ role: "user", content: "hi" }], {
            model: "claude",
            headerTimeoutMs: 25,
          }),
        ),
      ).rejects.toMatchObject({
        code: "provider_timeout",
        status: 504,
        message: "Anthropic did not return response headers within 25 ms.",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("caller cancellation after headers interrupts a stalled Anthropic body", async () => {
    const original = globalThis.fetch;
    let pulls = 0;
    let forwardedSignal: AbortSignal | undefined;
    let markPulled = (): void => {};
    const pulled = new Promise<void>((resolve) => {
      markPulled = resolve;
    });
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls > 1) return new Promise<void>(() => {});
            markPulled();
            controller.enqueue(new TextEncoder().encode('event: content_block_delta\ndata: {"partial":'));
          },
          cancel() {},
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const auth = { token: async () => "k" } as unknown as AuthService;
    const controller = new AbortController();
    const reason = new Error("caller left after Anthropic headers");
    const pending = collect(
      new AnthropicProvider(auth).stream([{ role: "user", content: "hi" }], {
        model: "claude",
        signal: controller.signal,
      }),
    );
    try {
      await pulled;
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(forwardedSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a fragmented oversized error body is capped, cancelled, and redacted", async () => {
    let chunks = 0;
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        if (chunks === 1) controller.enqueue(encoder.encode("bad key xai-"));
        else if (chunks === 2) controller.enqueue(encoder.encode("abcdefghijklmnop "));
        else controller.enqueue(new Uint8Array(1024).fill(120));
        if (chunks >= 12) controller.close();
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });

    const error = await providerHttpError("Test", new Response(body, { status: 500 }));
    expect(error).toMatchObject({ code: "provider_error", status: 502 });
    expect(error.message).toContain("Test returned 500");
    expect(error.message).not.toContain("abcdefghijklmnop");
    expect(error.message).toContain("xai-••••");
    // One additional pull may already be queued by the Web Streams high-water
    // mark, but the reader retains at most the fixed 4 KiB window.
    expect(chunks).toBeLessThanOrEqual(7);
    expect(cancelled).toBe(true);
  });

  test("a stalled error body cannot hold provider status mapping open", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode("server caught fire"));
          return;
        }
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("stalled provider body held status mapping open")), 750);
    });
    try {
      const error = await Promise.race([
        providerHttpError("Test", new Response(body, { status: 500 })),
        timeout,
      ]);
      expect(error).toMatchObject({ code: "provider_error", status: 502 });
      expect(error.message).toContain("server caught fire");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    expect(cancelled).toBe(true);
  });

  test("a slow-drip error body cannot reset the absolute body deadline", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            try {
              controller.enqueue(new Uint8Array([120]));
            } catch {
              // The absolute deadline may have cancelled first.
            }
            resolve();
          }, 5);
        });
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const error = await providerHttpError("Test", new Response(body, { status: 500 }), {
      inactivityTimeoutMs: 100,
      totalTimeoutMs: 35,
    });

    expect(error).toMatchObject({ code: "provider_error", status: 502 });
    expect(pulls).toBeLessThan(20);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
  });

  test("fragmented provider catalogue JSON is refused at its raw byte ceiling", async () => {
    let chunks = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(120));
        if (chunks >= 20) controller.close();
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });

    await expect(readProviderJson(new Response(body))).rejects.toMatchObject({
      code: "provider_output_limit",
      message: `Provider JSON body exceeded the ${MAX_PROVIDER_JSON_BODY_BYTES}-byte limit.`,
    });
    expect(chunks).toBeLessThanOrEqual(18);
    expect(cancelled).toBe(true);
  });

  test("a slow-drip JSON body cannot reset the absolute body deadline", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            try {
              controller.enqueue(new Uint8Array([32]));
            } catch {
              // The absolute deadline may have cancelled first.
            }
            resolve();
          }, 5);
        });
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });

    await expect(
      readProviderJson(new Response(body), {
        inactivityTimeoutMs: 100,
        totalTimeoutMs: 35,
      }),
    ).rejects.toMatchObject({
      code: "provider_timeout",
      status: 504,
      message: "Provider JSON body exceeded the 35 ms overall deadline.",
    });
    expect(pulls).toBeLessThan(20);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
  });
});

async function collectFrames(stream: AsyncIterable<{ data: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const frame of stream) out.push(frame.data);
  return out;
}

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
