import type { ChatMessage, ModelInfo, ProviderId, ToolDef, Usage } from "@pylos/protocol";

/**
 * The provider contract. One function, one shape, five implementations.
 *
 * Providers are stateless: every call carries the complete messages array the
 * kernel compiled. No provider conversation id is ever required to continue a
 * thread (KERNEL.md §6).
 */
export type ProviderEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason?: string };

export interface StreamOptions {
  model: string;
  tools?: ToolDef[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface Provider {
  readonly id: ProviderId;
  /** Streams one assistant response. Never mutates `messages`. */
  stream(messages: ChatMessage[], opts: StreamOptions): AsyncIterable<ProviderEvent>;
  /** Model catalogue. Falls back to the static list when the network is unavailable. */
  models(): Promise<ModelInfo[]>;
}

/** What the kernel's `runTurn` is handed: a bound provider stream. */
export type ProviderFn = (messages: ChatMessage[], opts: StreamOptions) => AsyncIterable<ProviderEvent>;

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Never let a provider body leak a credential into a log or an API response. */
export function redact(text: string): string {
  return text
    .replace(/\b(xai|sk|sk-ant|sk-proj|gsk)-[A-Za-z0-9_-]{6,}/g, "$1-••••")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g, "•••jwt");
}
