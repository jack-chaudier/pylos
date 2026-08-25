import type { ChatMessage, ToolDef } from "@pylos/protocol";
import { fetchProvider } from "./fetch.ts";
import { parseJson, readSse } from "./sse.ts";
import {
  ProviderError,
  type ProviderEvent,
  ProviderOutputMeter,
  redact,
  type StreamOptions,
} from "./types.ts";

/**
 * One streaming client for every OpenAI-shaped `/chat/completions` endpoint:
 * xAI, OpenAI, Ollama's compatibility layer and arbitrary gateways.
 */
export interface OpenAiChatConfig {
  baseUrl: string;
  /** Resolved lazily so an OAuth access token can be refreshed per call. */
  token: () => Promise<string | undefined>;
  headers?: Record<string, string>;
  /** `stream_options.include_usage` — not universally supported. */
  includeUsage?: boolean;
  label: string;
}

interface OpenAiToolCallDraft {
  id: string;
  name: string;
  args: string;
}

export function toOpenAiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? "",
      };
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: message.content.length > 0 ? message.content : null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.args },
        })),
      };
    }
    return message.name === undefined
      ? { role: message.role, content: message.content }
      : { role: message.role, content: message.content, name: message.name };
  });
}

export function toOpenAiTools(tools: ToolDef[] | undefined): Record<string, unknown>[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export async function* streamOpenAiChat(
  config: OpenAiChatConfig,
  messages: ChatMessage[],
  opts: StreamOptions,
): AsyncGenerator<ProviderEvent> {
  const token = await config.token();
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOpenAiMessages(messages),
    stream: true,
  };
  const tools = toOpenAiTools(opts.tools);
  if (tools !== undefined) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (config.includeUsage === true) body.stream_options = { include_usage: true };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...config.headers,
  };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetchProvider(
      fetch,
      `${config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      {
        label: config.label,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        ...(opts.headerTimeoutMs === undefined ? {} : { timeoutMs: opts.headerTimeoutMs }),
      },
    );
  } catch (error) {
    if (opts.signal?.aborted === true) throw error;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "provider_unreachable",
      `${config.label} is unreachable: ${redact(String(error))}`,
      502,
    );
  }
  if (!response.ok || response.body === null) {
    throw await providerHttpError(config.label, response);
  }

  const drafts = new Map<number, OpenAiToolCallDraft>();
  const output = new ProviderOutputMeter(
    opts.maxOutputBytes,
    opts.maxOutputScope,
    opts.maxOutputReportedBytes,
  );
  let sawUsage = false;
  let finishReason: string | undefined;
  for await (const frame of readSse(response.body, { signal: opts.signal })) {
    if (frame.data === "[DONE]") break;
    const chunk = parseJson(frame.data);
    if (chunk === undefined) continue;
    const error = chunk.error;
    if (error !== undefined && error !== null) {
      throw new ProviderError("provider_error", `${config.label}: ${describe(error)}`, 502);
    }
    const usage = chunk.usage;
    if (isRecord(usage)) {
      sawUsage = true;
      yield {
        type: "usage",
        usage: {
          inputTokens: numberOr(usage.prompt_tokens, 0),
          outputTokens: numberOr(usage.completion_tokens, 0),
          ...cachedFrom(usage),
        },
      };
    }
    const choices = chunk.choices;
    if (!Array.isArray(choices)) continue;
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const delta = choice.delta;
      if (isRecord(delta)) {
        const content = delta.content;
        if (typeof content === "string" && content.length > 0) {
          output.add(content);
          yield { type: "delta", text: content };
        }
        const reasoning = delta.reasoning_content;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          // Reasoning traces are never archived as answer text.
        }
        const toolCalls = delta.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const call of toolCalls) {
            if (!isRecord(call)) continue;
            const index = numberOr(call.index, 0);
            const draft = drafts.get(index) ?? { id: "", name: "", args: "" };
            if (typeof call.id === "string" && call.id.length > 0 && draft.id.length === 0) {
              output.add(call.id);
              draft.id = call.id;
            }
            const fn = call.function;
            if (isRecord(fn)) {
              if (typeof fn.name === "string" && fn.name.length > 0 && draft.name.length === 0) {
                output.add(fn.name);
                draft.name = fn.name;
              }
              if (typeof fn.arguments === "string") {
                output.add(fn.arguments);
                draft.args += fn.arguments;
              }
            }
            drafts.set(index, draft);
          }
        }
      }
      const finish = choice.finish_reason;
      if (typeof finish === "string" && finish.length > 0) {
        finishReason = finish;
        // Do not stop here: xAI and OpenAI send the usage chunk *after* this one.
        for (const draft of sortedDrafts(drafts)) {
          yield { type: "tool_call", id: draft.id, name: draft.name, args: draft.args };
        }
        drafts.clear();
      }
    }
  }
  for (const draft of sortedDrafts(drafts)) {
    yield { type: "tool_call", id: draft.id, name: draft.name, args: draft.args };
  }
  if (!sawUsage) yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
  yield finishReason === undefined ? { type: "done" } : { type: "done", finishReason };
}

function sortedDrafts(drafts: Map<number, OpenAiToolCallDraft>): OpenAiToolCallDraft[] {
  return [...drafts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, draft]) => draft)
    .filter((draft) => draft.name.length > 0)
    .map((draft, index) => (draft.id.length > 0 ? draft : { ...draft, id: `call_${index}` }));
}

export async function providerHttpError(
  label: string,
  response: Response,
  readOptions: ProviderBodyReadOptions = {},
): Promise<ProviderError> {
  if (response.status === 401 || response.status === 403) {
    return new ProviderError(
      "auth_rejected",
      `${label} rejected the credential. Sign in again or use an API key.`,
      401,
    );
  }
  if (response.status === 429) {
    return new ProviderError("rate_limited", `${label} is rate limiting this request.`, 429);
  }
  let detail = "";
  try {
    // Redact the whole bounded byte window before taking the display excerpt so
    // a credential crossing character 400 cannot leak through the cut.
    detail = redact(await readProviderErrorBody(response, readOptions)).slice(0, 400);
  } catch {
    detail = "";
  }
  return new ProviderError(
    "provider_error",
    `${label} returned ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
    502,
  );
}

/** Enough for a useful 400-character excerpt with generous UTF-8 headroom. */
export const MAX_PROVIDER_ERROR_BODY_BYTES = 4 * 1024;
export const MAX_PROVIDER_JSON_BODY_BYTES = 1024 * 1024;
const PROVIDER_ERROR_READ_TIMEOUT_MS = 250;
const PROVIDER_JSON_READ_TIMEOUT_MS = 1000;
const PROVIDER_ERROR_TOTAL_TIMEOUT_MS = 1000;
const PROVIDER_JSON_TOTAL_TIMEOUT_MS = 10_000;

export interface ProviderBodyReadOptions {
  inactivityTimeoutMs?: number;
  totalTimeoutMs?: number;
}

/**
 * Reads provider error detail without `Response.text()`: bytes are copied into
 * one fixed buffer across fragments, each read and the whole body have
 * deadlines, and cancellation is initiated without awaiting a potentially
 * hostile upstream `cancel()`.
 */
async function readProviderErrorBody(
  response: Response,
  options: ProviderBodyReadOptions = {},
): Promise<string> {
  if (response.body === null) return "";
  const inactivityTimeoutMs = positiveLimit(
    options.inactivityTimeoutMs,
    PROVIDER_ERROR_READ_TIMEOUT_MS,
    "provider error body inactivity timeout",
  );
  const totalTimeoutMs = positiveLimit(
    options.totalTimeoutMs,
    PROVIDER_ERROR_TOTAL_TIMEOUT_MS,
    "provider error body total timeout",
  );
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_PROVIDER_ERROR_BODY_BYTES);
  const deadline = performance.now() + totalTimeoutMs;
  let length = 0;
  try {
    while (length < MAX_PROVIDER_ERROR_BODY_BYTES) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      const result = await readProviderChunk(
        reader,
        Math.max(1, Math.ceil(Math.min(remainingMs, inactivityTimeoutMs))),
      );
      if (result === undefined || result.done || result.value === undefined) break;
      if (performance.now() >= deadline) break;
      const remaining = MAX_PROVIDER_ERROR_BODY_BYTES - length;
      const take = Math.min(remaining, result.value.byteLength);
      bytes.set(result.value.subarray(0, take), length);
      length += take;
      if (take < result.value.byteLength) break;
    }
    return new TextDecoder().decode(bytes.subarray(0, length));
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function readProviderChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array } | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    void reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** Bounded JSON reader for provider catalogues and other non-stream responses. */
export async function readProviderJson(
  response: Response,
  options: ProviderBodyReadOptions = {},
): Promise<unknown> {
  if (response.body === null) {
    throw new ProviderError("provider_error", "Provider returned an empty JSON body.", 502);
  }
  const inactivityTimeoutMs = positiveLimit(
    options.inactivityTimeoutMs,
    PROVIDER_JSON_READ_TIMEOUT_MS,
    "provider JSON body inactivity timeout",
  );
  const totalTimeoutMs = positiveLimit(
    options.totalTimeoutMs,
    PROVIDER_JSON_TOTAL_TIMEOUT_MS,
    "provider JSON body total timeout",
  );
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_PROVIDER_JSON_BODY_BYTES);
  const deadline = performance.now() + totalTimeoutMs;
  let length = 0;
  try {
    for (;;) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw providerJsonTotalTimeout(totalTimeoutMs);
      const overallDeadlineWins = remainingMs <= inactivityTimeoutMs;
      const result = await readProviderChunk(
        reader,
        Math.max(1, Math.ceil(Math.min(remainingMs, inactivityTimeoutMs))),
      );
      if (result === undefined) {
        if (overallDeadlineWins || performance.now() >= deadline) {
          throw providerJsonTotalTimeout(totalTimeoutMs);
        }
        throw new ProviderError("provider_unreachable", "Provider JSON body stalled.", 502);
      }
      if (performance.now() >= deadline) throw providerJsonTotalTimeout(totalTimeoutMs);
      if (result.done || result.value === undefined) break;
      const remaining = MAX_PROVIDER_JSON_BODY_BYTES - length;
      if (result.value.byteLength > remaining) {
        throw new ProviderError(
          "provider_output_limit",
          `Provider JSON body exceeded the ${MAX_PROVIDER_JSON_BODY_BYTES}-byte limit.`,
          502,
        );
      }
      bytes.set(result.value, length);
      length += result.value.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    } catch {
      throw new ProviderError("provider_error", "Provider returned invalid JSON.", 502);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function providerJsonTotalTimeout(timeoutMs: number): ProviderError {
  return new ProviderError(
    "provider_timeout",
    `Provider JSON body exceeded the ${timeoutMs} ms overall deadline.`,
    504,
  );
}

function cachedFrom(usage: Record<string, unknown>): { cachedTokens?: number } {
  const details = usage.prompt_tokens_details;
  if (isRecord(details) && typeof details.cached_tokens === "number") {
    return { cachedTokens: details.cached_tokens };
  }
  if (typeof usage.cached_tokens === "number") return { cachedTokens: usage.cached_tokens };
  return {};
}

function describe(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") return redact(value.message);
  return redact(String(value));
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
