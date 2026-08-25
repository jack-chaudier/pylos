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

/** Hosted accounts may select only providers whose endpoint is fixed by the
 * server. Local Ollama and user-supplied compatible gateways are deliberately
 * absent: otherwise a signed-in user could make the public server fetch an
 * arbitrary loopback, private, metadata, redirected, or DNS-rebound target. */
export const HOSTED_PROVIDER_IDS: readonly ProviderId[] = ["xai", "anthropic", "openai"];

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, Provider>();
  private readonly catalogues = new Map<string, { at: number; models: ModelInfo[] }>();

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

  async models(force = false, allowedProviders?: readonly ProviderId[]): Promise<ModelInfo[]> {
    const now = Date.now();
    const ids = allowedProviders ?? [...this.providers.keys()];
    const key = ids.join("\u0000");
    const cached = this.catalogues.get(key);
    if (!force && cached !== undefined && now - cached.at < CATALOGUE_TTL_MS) {
      return cached.models;
    }
    const lists = await Promise.all(
      ids.map(
        (id) =>
          this.providers
            .get(id)
            ?.models()
            .catch(() => []) ?? Promise.resolve([]),
      ),
    );
    const models = lists.flat();
    this.catalogues.set(key, { at: now, models });
    return models;
  }

  /** `model` may be a bare id (`grok-4.6`) or namespaced (`anthropic/claude-…`). */
  async resolve(
    model: string,
    allowedProviders?: readonly ProviderId[],
  ): Promise<{ provider: ProviderId; model: string }> {
    const allowed = allowedProviders === undefined ? undefined : new Set(allowedProviders);
    const slash = model.indexOf("/");
    if (slash > 0) {
      const head = model.slice(0, slash) as ProviderId;
      if (this.providers.has(head)) {
        if (allowed !== undefined && !allowed.has(head)) throw hostedProviderForbidden();
        return { provider: head, model: model.slice(slash + 1) };
      }
    }
    const models = await this.models(false, allowedProviders);
    const exact = models.find((entry) => entry.id === model);
    if (exact !== undefined) {
      if (allowed !== undefined && !allowed.has(exact.provider)) throw hostedProviderForbidden();
      return { provider: exact.provider, model: exact.id };
    }
    const provider = inferProvider(model);
    if (allowed !== undefined && !allowed.has(provider)) throw hostedProviderForbidden();
    return { provider, model };
  }

  /** The bound stream handed to the kernel's `runTurn`. */
  async providerFn(
    model: string,
    allowedProviders?: readonly ProviderId[],
  ): Promise<{ fn: ProviderFn; provider: ProviderId; model: string }> {
    const resolved = await this.resolve(model, allowedProviders);
    const provider = this.get(resolved.provider);
    return {
      provider: resolved.provider,
      model: resolved.model,
      fn: (messages, opts) => provider.stream(messages, { ...opts, model: resolved.model }),
    };
  }
}

function hostedProviderForbidden(): ProviderError {
  return new ProviderError(
    "hosted_provider_forbidden",
    "Hosted accounts may use only server-managed provider endpoints.",
    403,
  );
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
