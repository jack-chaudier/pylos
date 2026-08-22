import type { ModelInfo, ProviderId } from "@pylos/protocol";
import type { AuthService } from "../auth/xai.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAiProvider } from "./openai.ts";
import { OpenAiCompatibleProvider } from "./openai-compatible.ts";
import { type Provider, ProviderError, type ProviderFn } from "./types.ts";
import { XaiProvider } from "./xai.ts";

export const DEFAULT_MODEL = "grok-4.6";

const CATALOGUE_TTL_MS = 30_000;

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, Provider>();
  private catalogue: { at: number; models: ModelInfo[] } | undefined;

  constructor(auth: AuthService, overrides?: Partial<Record<ProviderId, Provider>>) {
    this.providers.set("xai", overrides?.xai ?? new XaiProvider(auth));
    this.providers.set("anthropic", overrides?.anthropic ?? new AnthropicProvider(auth));
    this.providers.set("openai", overrides?.openai ?? new OpenAiProvider(auth));
    this.providers.set("ollama", overrides?.ollama ?? new OllamaProvider());
    this.providers.set(
      "openai-compatible",
      overrides?.["openai-compatible"] ?? new OpenAiCompatibleProvider(auth),
    );
  }

  get(id: ProviderId): Provider {
    const provider = this.providers.get(id);
    if (provider === undefined) throw new ProviderError("unknown_provider", `Unknown: ${id}`, 400);
    return provider;
  }

  async models(force = false): Promise<ModelInfo[]> {
    const now = Date.now();
    if (!force && this.catalogue !== undefined && now - this.catalogue.at < CATALOGUE_TTL_MS) {
      return this.catalogue.models;
    }
    const lists = await Promise.all(
      [...this.providers.values()].map((provider) => provider.models().catch(() => [])),
    );
    const models = lists.flat();
    this.catalogue = { at: now, models };
    return models;
  }

  /** `model` may be a bare id (`grok-4.6`) or namespaced (`anthropic/claude-…`). */
  async resolve(model: string): Promise<{ provider: ProviderId; model: string }> {
    const slash = model.indexOf("/");
    if (slash > 0) {
      const head = model.slice(0, slash) as ProviderId;
      if (this.providers.has(head)) return { provider: head, model: model.slice(slash + 1) };
    }
    const models = await this.models();
    const exact = models.find((entry) => entry.id === model);
    if (exact !== undefined) return { provider: exact.provider, model: exact.id };
    return { provider: inferProvider(model), model };
  }

  /** The bound stream handed to the kernel's `runTurn`. */
  async providerFn(model: string): Promise<{ fn: ProviderFn; provider: ProviderId; model: string }> {
    const resolved = await this.resolve(model);
    const provider = this.get(resolved.provider);
    return {
      provider: resolved.provider,
      model: resolved.model,
      fn: (messages, opts) => provider.stream(messages, { ...opts, model: resolved.model }),
    };
  }
}

export function inferProvider(model: string): ProviderId {
  if (/^grok/i.test(model)) return "xai";
  if (/^claude/i.test(model)) return "anthropic";
  if (/^(gpt-|o[1-9]|chatgpt)/i.test(model)) return "openai";
  if (model.includes(":")) return "ollama";
  return "openai-compatible";
}

export function providerLabel(id: ProviderId): string {
  switch (id) {
    case "xai":
      return "xAI";
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "ollama":
      return "Ollama";
    default:
      return "Compatible";
  }
}
