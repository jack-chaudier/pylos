import type { ChatMessage, ModelInfo } from "@pylos/protocol";
import type { AuthService } from "../auth/xai.ts";
import { fetchProvider } from "./fetch.ts";
import { isRecord, readProviderJson, streamOpenAiChat } from "./openai-chat.ts";
import type { Provider, ProviderEvent, StreamOptions } from "./types.ts";

const API_BASE = "https://api.openai.com/v1";
const CHAT_MODEL = /^(gpt-|o[1-9]|chatgpt-)/;
const NON_CHAT = /(embedding|audio|realtime|tts|whisper|image|moderation|transcribe|search|dall)/i;

const STATIC_MODELS: Array<{ id: string; label: string }> = [
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-5.1", label: "GPT-5.1" },
  { id: "gpt-4.1", label: "GPT-4.1" },
];

export class OpenAiProvider implements Provider {
  readonly id = "openai" as const;

  constructor(private readonly auth: AuthService) {}

  stream(messages: ChatMessage[], opts: StreamOptions): AsyncIterable<ProviderEvent> {
    return streamOpenAiChat(
      {
        baseUrl: API_BASE,
        token: () => this.auth.token("openai"),
        includeUsage: true,
        label: "OpenAI",
      },
      messages,
      opts,
    );
  }

  async models(): Promise<ModelInfo[]> {
    const available = await this.auth.configured("openai");
    const fallback = STATIC_MODELS.map((entry) => ({
      id: entry.id,
      provider: "openai" as const,
      label: entry.label,
      available,
      supportsTools: true,
    }));
    if (!available) return fallback;
    try {
      const key = await this.auth.token("openai");
      const response = await fetchProvider(
        fetch,
        `${API_BASE}/models`,
        {
          headers: key === undefined ? {} : { Authorization: `Bearer ${key}` },
        },
        { label: "OpenAI" },
      );
      if (!response.ok) return fallback;
      const value = await readProviderJson(response);
      const rows = isRecord(value) && Array.isArray(value.data) ? value.data : [];
      const models = rows.flatMap((row): ModelInfo[] => {
        if (!isRecord(row) || typeof row.id !== "string") return [];
        if (!CHAT_MODEL.test(row.id) || NON_CHAT.test(row.id)) return [];
        return [{ id: row.id, provider: "openai", label: row.id, available: true, supportsTools: true }];
      });
      return models.length > 0
        ? models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))
        : fallback;
    } catch {
      return fallback;
    }
  }
}
