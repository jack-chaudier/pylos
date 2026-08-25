import type { ChatMessage, ModelInfo } from "@pylos/protocol";
import type { AuthService } from "../auth/xai.ts";
import { fetchProvider } from "./fetch.ts";
import { isRecord, readProviderJson, streamOpenAiChat } from "./openai-chat.ts";
import { type Provider, ProviderError, type ProviderEvent, type StreamOptions } from "./types.ts";

/** Any other endpoint that speaks `/chat/completions`: base URL + key. */
export class OpenAiCompatibleProvider implements Provider {
  readonly id = "openai-compatible" as const;

  constructor(private readonly auth: AuthService) {}

  async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    const baseUrl = await this.auth.baseUrl("openai-compatible");
    if (baseUrl === undefined) {
      throw new ProviderError("auth_required", "No compatible endpoint is configured.", 401);
    }
    yield* streamOpenAiChat(
      {
        baseUrl,
        token: () => this.auth.token("openai-compatible"),
        includeUsage: true,
        label: "The configured endpoint",
      },
      messages,
      opts,
    );
  }

  async models(): Promise<ModelInfo[]> {
    const baseUrl = await this.auth.baseUrl("openai-compatible");
    if (baseUrl === undefined) return [];
    try {
      const key = await this.auth.token("openai-compatible");
      const response = await fetchProvider(
        fetch,
        `${baseUrl}/models`,
        {
          headers: key === undefined ? {} : { Authorization: `Bearer ${key}` },
        },
        { label: "The configured endpoint", timeoutMs: 3000 },
      );
      if (!response.ok) return [];
      const value = await readProviderJson(response);
      const rows = isRecord(value) && Array.isArray(value.data) ? value.data : [];
      return rows.flatMap((row): ModelInfo[] => {
        if (!isRecord(row) || typeof row.id !== "string") return [];
        return [
          {
            id: row.id,
            provider: "openai-compatible",
            label: row.id,
            available: true,
            supportsTools: true,
          },
        ];
      });
    } catch {
      return [];
    }
  }
}
