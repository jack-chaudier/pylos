import type { ChatMessage, ModelInfo } from "@pylos/protocol";
import type { AuthService } from "../auth/xai.ts";
import { fetchProvider } from "./fetch.ts";
import { isRecord, numberOr, providerHttpError, readProviderJson } from "./openai-chat.ts";
import { parseJson, readSse } from "./sse.ts";
import {
  type Provider,
  ProviderError,
  type ProviderEvent,
  ProviderOutputMeter,
  redact,
  type StreamOptions,
} from "./types.ts";

const API_BASE = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";

const STATIC_MODELS: Array<{ id: string; label: string }> = [
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

interface AnthropicBlock {
  type: string;
  [k: string]: unknown;
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;

  constructor(private readonly auth: AuthService) {}

  async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    const key = await this.auth.token("anthropic");
    const { system, turns } = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 8192,
      messages: turns,
      stream: true,
    };
    if (system.length > 0) body.system = system;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.tools !== undefined && opts.tools.length > 0) {
      body.tools = opts.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    let response: Response;
    try {
      response = await fetchProvider(
        fetch,
        `${API_BASE}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "anthropic-version": VERSION,
            ...(key === undefined ? {} : { "x-api-key": key }),
          },
          body: JSON.stringify(body),
        },
        {
          label: "Anthropic",
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          ...(opts.headerTimeoutMs === undefined ? {} : { timeoutMs: opts.headerTimeoutMs }),
        },
      );
    } catch (error) {
      if (opts.signal?.aborted === true) throw error;
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "provider_unreachable",
        `Anthropic is unreachable: ${redact(String(error))}`,
        502,
      );
    }
    if (!response.ok || response.body === null) throw await providerHttpError("Anthropic", response);

    const toolDrafts = new Map<number, { id: string; name: string; args: string }>();
    const output = new ProviderOutputMeter(
      opts.maxOutputBytes,
      opts.maxOutputScope,
      opts.maxOutputReportedBytes,
    );
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;

    for await (const frame of readSse(response.body, { signal: opts.signal })) {
      const event = parseJson(frame.data);
      if (event === undefined) continue;
      const type = typeof event.type === "string" ? event.type : frame.event;
      if (type === "error") {
        throw new ProviderError("provider_error", `Anthropic: ${redact(frame.data)}`, 502);
      }
      if (type === "message_start" && isRecord(event.message)) {
        const usage = event.message.usage;
        if (isRecord(usage)) {
          inputTokens = numberOr(usage.input_tokens, 0);
          cachedTokens =
            numberOr(usage.cache_read_input_tokens, 0) + numberOr(usage.cache_creation_input_tokens, 0);
        }
      } else if (type === "content_block_start") {
        const block = event.content_block;
        if (isRecord(block) && block.type === "tool_use") {
          const id = typeof block.id === "string" ? block.id : `call_${toolDrafts.size}`;
          const name = typeof block.name === "string" ? block.name : "";
          output.add(id, name);
          toolDrafts.set(numberOr(event.index, 0), {
            id,
            name,
            args: "",
          });
        }
      } else if (type === "content_block_delta") {
        const delta = event.delta;
        if (!isRecord(delta)) continue;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          output.add(delta.text);
          yield { type: "delta", text: delta.text };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const draft = toolDrafts.get(numberOr(event.index, 0));
          if (draft !== undefined) {
            output.add(delta.partial_json);
            draft.args += delta.partial_json;
          }
        }
      } else if (type === "message_delta") {
        const usage = event.usage;
        if (isRecord(usage)) outputTokens = numberOr(usage.output_tokens, outputTokens);
      } else if (type === "message_stop") {
        break;
      }
    }

    for (const draft of [...toolDrafts.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d)) {
      if (draft.name.length === 0) continue;
      yield {
        type: "tool_call",
        id: draft.id,
        name: draft.name,
        args: draft.args.length > 0 ? draft.args : "{}",
      };
    }
    yield {
      type: "usage",
      usage: {
        inputTokens,
        outputTokens,
        ...(cachedTokens > 0 ? { cachedTokens } : {}),
      },
    };
    yield { type: "done" };
  }

  async models(): Promise<ModelInfo[]> {
    const available = await this.auth.configured("anthropic");
    const fallback = STATIC_MODELS.map((entry) => ({
      id: entry.id,
      provider: "anthropic" as const,
      label: entry.label,
      contextLength: 200_000,
      available,
      supportsTools: true,
    }));
    if (!available) return fallback;
    try {
      const key = await this.auth.token("anthropic");
      const response = await fetchProvider(
        fetch,
        `${API_BASE}/models?limit=100`,
        {
          headers: {
            "anthropic-version": VERSION,
            ...(key === undefined ? {} : { "x-api-key": key }),
          },
        },
        { label: "Anthropic" },
      );
      if (!response.ok) return fallback;
      const value = await readProviderJson(response);
      const rows = isRecord(value) && Array.isArray(value.data) ? value.data : [];
      const models = rows.flatMap((row): ModelInfo[] => {
        if (!isRecord(row) || typeof row.id !== "string") return [];
        return [
          {
            id: row.id,
            provider: "anthropic",
            label: typeof row.display_name === "string" ? row.display_name : row.id,
            contextLength: 200_000,
            available: true,
            supportsTools: true,
          },
        ];
      });
      return models.length > 0 ? models : fallback;
    } catch {
      return fallback;
    }
  }
}

export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  turns: Record<string, unknown>[];
} {
  const systemParts: string[] = [];
  const turns: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      };
      const last = turns.at(-1);
      if (last !== undefined && last.role === "user" && Array.isArray(last.content)) {
        (last.content as AnthropicBlock[]).push(block);
      } else {
        turns.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const blocks: AnthropicBlock[] = [];
      if (message.content.length > 0) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: safeJson(call.args),
        });
      }
      turns.push({ role: "assistant", content: blocks });
      continue;
    }
    const content = message.content.length > 0 ? message.content : "(empty)";
    const last = turns.at(-1);
    if (last !== undefined && last.role === message.role && typeof last.content === "string") {
      last.content = `${last.content}\n\n${content}`;
    } else if (last !== undefined && last.role === message.role && Array.isArray(last.content)) {
      (last.content as AnthropicBlock[]).push({ type: "text", text: content });
    } else {
      turns.push({ role: message.role, content });
    }
  }
  if (turns.length === 0 || turns[0]?.role !== "user") {
    turns.unshift({ role: "user", content: "(continue)" });
  }
  return { system: systemParts.join("\n\n"), turns };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.length > 0 ? text : "{}");
  } catch {
    return {};
  }
}
