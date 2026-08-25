import type { ChatMessage, ModelInfo } from "@pylos/protocol";
import { fetchProvider } from "./fetch.ts";
import { isRecord, readProviderJson, streamOpenAiChat } from "./openai-chat.ts";
import type { Provider, ProviderEvent, StreamOptions } from "./types.ts";

const HOST = process.env.OLLAMA_HOST?.replace(/\/+$/, "") ?? "http://127.0.0.1:11434";

/** Local models. Absence is normal and must never be an error (PLAN.md). */
export class OllamaProvider implements Provider {
  readonly id = "ollama" as const;

  stream(messages: ChatMessage[], opts: StreamOptions): AsyncIterable<ProviderEvent> {
    return streamOpenAiChat(
      {
        baseUrl: `${HOST}/v1`,
        token: async () => "ollama",
        includeUsage: false,
        label: "Ollama",
      },
      messages,
      opts,
    );
  }

  async models(): Promise<ModelInfo[]> {
    try {
      const response = await fetchProvider(
        fetch,
        `${HOST}/api/tags`,
        {},
        { label: "Ollama", timeoutMs: 1200 },
      );
      if (!response.ok) return [];
      const value = await readProviderJson(response);
      const rows = isRecord(value) && Array.isArray(value.models) ? value.models : [];
      return rows.flatMap((row): ModelInfo[] => {
        if (!isRecord(row) || typeof row.name !== "string") return [];
        const details = row.details;
        const family = isRecord(details) && typeof details.family === "string" ? details.family : "";
        return [
          {
            id: row.name,
            provider: "ollama",
            label: row.name,
            available: true,
            supportsTools: /llama|qwen|mistral|command|hermes|firefunction|granite/i.test(
              `${row.name} ${family}`,
            ),
          },
        ];
      });
    } catch {
      return [];
    }
  }
}
