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
  /** Parser-side defense for fragmented tool JSON; core independently meters the emitted stream. */
  maxOutputBytes?: number;
  maxOutputScope?: "round" | "turn";
  maxOutputReportedBytes?: number;
  /** Testable override; production uses the shared provider-header deadline. */
  headerTimeoutMs?: number;
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

/**
 * Bounds strings while an HTTP provider is still assembling its wire format.
 * This is defense in depth only; the kernel re-counts every emitted UTF-8 byte.
 */
export class ProviderOutputMeter {
  private bytes = 0;

  constructor(
    private readonly limit: number | undefined,
    private readonly scope: "round" | "turn" = "round",
    private readonly reportedLimit: number | undefined = limit,
  ) {}

  add(...parts: string[]): void {
    if (this.limit === undefined) return;
    let next = this.bytes;
    for (const part of parts) next += Buffer.byteLength(part, "utf8");
    if (next > this.limit) {
      throw new ProviderError(
        "provider_output_limit",
        `Provider output exceeded the ${this.reportedLimit}-byte ${this.scope} limit.`,
        502,
      );
    }
    this.bytes = next;
  }
}

/** Never let a provider body leak a credential into a log or an API response. */
export function redact(text: string): string {
  return text
    .replace(/\b(xai|sk|sk-ant|sk-proj|gsk)-[A-Za-z0-9_-]{6,}/g, "$1-••••")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g, "•••jwt");
}
