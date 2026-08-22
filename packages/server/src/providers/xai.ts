import type { ChatMessage, ModelInfo } from "@pylos/protocol";
import type { AuthService } from "../auth/xai.ts";
import { XAI_API_BASE } from "../auth/xai.ts";
import { isRecord, streamOpenAiChat } from "./openai-chat.ts";
import type { Provider, ProviderEvent, StreamOptions } from "./types.ts";

/** Ships first, defaults to grok-4.6 (PLAN.md). Used when /v1/models is unreachable. */
const STATIC_MODELS: Array<{ id: string; label: string; contextLength: number }> = [
  { id: "grok-4.6", label: "Grok 4.6", contextLength: 2_000_000 },
  { id: "grok-4.5", label: "Grok 4.5", contextLength: 2_000_000 },
  { id: "grok-4.3", label: "Grok 4.3", contextLength: 256_000 },
  { id: "grok-4.20", label: "Grok 4.20", contextLength: 256_000 },
];

const NON_CHAT = /(image|embed|vision-beta|tts|whisper|rerank)/i;

export class XaiProvider implements Provider {
  readonly id = "xai" as const;

  constructor(private readonly auth: AuthService) {}

  stream(messages: ChatMessage[], opts: StreamOptions): AsyncIterable<ProviderEvent> {
    return streamOpenAiChat(
      {
        baseUrl: XAI_API_BASE,
        token: () => this.auth.token("xai"),
        includeUsage: true,
        label: "xAI",
      },
      messages,
      opts,
    );
  }

  async models(): Promise<ModelInfo[]> {
    const available = await this.auth.configured("xai");
    const fallback = STATIC_MODELS.map((entry) => ({
      id: entry.id,
      provider: "xai" as const,
      label: entry.label,
      contextLength: entry.contextLength,
      available,
      supportsTools: true,
    }));
    if (!available) return fallback;
    const remote = await this.remoteModels().catch(() => undefined);
    if (remote === undefined || remote.length === 0) return fallback;
    const seen = new Set(remote.map((model) => model.id));
    return [...remote, ...fallback.filter((model) => !seen.has(model.id))];
  }

  private async remoteModels(): Promise<ModelInfo[]> {
    const token = await this.auth.token("xai");
    const response = await fetch(`${XAI_API_BASE}/language-models`, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    });
    const source = response.ok ? response : await fetchModels(token);
    if (!source.ok) return [];
    const value: unknown = await source.json();
    const rows = isRecord(value) && Array.isArray(value.models) ? value.models : listOf(value);
    const models: ModelInfo[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = typeof row.id === "string" ? row.id : undefined;
      if (id === undefined || NON_CHAT.test(id)) continue;
      const context = typeof row.max_prompt_length === "number" ? row.max_prompt_length : undefined;
      models.push({
        id,
        provider: "xai",
        label: labelFor(id),
        ...(context === undefined ? {} : { contextLength: context }),
        available: true,
        supportsTools: true,
      });
    }
    return models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  }
}

async function fetchModels(token: string | undefined): Promise<Response> {
  return fetch(`${XAI_API_BASE}/models`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
}

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.data)) return value.data;
  return [];
}

export function labelFor(id: string): string {
  const known = STATIC_MODELS.find((entry) => entry.id === id);
  if (known !== undefined) return known.label;
  return id
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}
