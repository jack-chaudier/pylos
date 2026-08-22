import type { ChatMessage, ModelInfo } from "@pylos/protocol";
import type { Provider, ProviderEvent, StreamOptions } from "../src/providers/types.ts";

/** One scripted response; `held` delays it until the test lets it go. */
interface Scripted {
  events: ProviderEvent[];
  held?: Promise<void>;
}

/** Scripted provider: no network, deterministic, records what it was sent. */
export class FakeProvider implements Provider {
  readonly id = "xai" as const;
  readonly calls: Array<{ messages: ChatMessage[]; opts: StreamOptions }> = [];
  private readonly script: Scripted[] = [];

  reply(text: string): void {
    this.script.push({ events: answer(text) });
  }

  /** A reply that arrives only when the returned function is called. */
  deferReply(text: string): () => void {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.script.push({ events: answer(text), held });
    return release;
  }

  recallThen(args: Record<string, unknown>, text: string): void {
    this.script.push({
      events: [
        { type: "tool_call", id: "call_1", name: "recall", args: JSON.stringify(args) },
        { type: "done", finishReason: "tool_calls" },
      ],
    });
    this.script.push({
      events: [
        { type: "delta", text },
        { type: "usage", usage: { inputTokens: 21, outputTokens: 9 } },
        { type: "done", finishReason: "stop" },
      ],
    });
  }

  async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    const turn = this.script.shift() ?? {
      events: [{ type: "delta" as const, text: "(no script)" }, { type: "done" as const }],
    };
    if (turn.held !== undefined) await turn.held;
    for (const event of turn.events) yield event;
  }

  async models(): Promise<ModelInfo[]> {
    return [
      {
        id: "grok-4.6",
        provider: "xai",
        label: "Grok 4.6",
        available: true,
        supportsTools: true,
      },
      {
        id: "grok-toolless",
        provider: "xai",
        label: "Grok Toolless",
        available: true,
        supportsTools: false,
      },
    ];
  }
}

function answer(text: string): ProviderEvent[] {
  return [
    { type: "delta", text },
    { type: "usage", usage: { inputTokens: 11, outputTokens: 7 } },
    { type: "done", finishReason: "stop" },
  ];
}
