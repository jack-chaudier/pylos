import type { ChatMessage, ToolDef } from "@pylos/protocol";
import { parseJson, readSse } from "./sse.ts";
import { ProviderError, type ProviderEvent, redact, type StreamOptions } from "./types.ts";

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
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  } catch (error) {
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
  let sawUsage = false;
  let finishReason: string | undefined;
  for await (const frame of readSse(response.body)) {
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
            if (typeof call.id === "string" && call.id.length > 0) draft.id = call.id;
            const fn = call.function;
            if (isRecord(fn)) {
              if (typeof fn.name === "string" && fn.name.length > 0) draft.name = fn.name;
              if (typeof fn.arguments === "string") draft.args += fn.arguments;
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

export async function providerHttpError(label: string, response: Response): Promise<ProviderError> {
  let detail = "";
  try {
    detail = redact((await response.text()).slice(0, 400));
  } catch {
    detail = "";
  }
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
  return new ProviderError(
    "provider_error",
    `${label} returned ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
    502,
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
