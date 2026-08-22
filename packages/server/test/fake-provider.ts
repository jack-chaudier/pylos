import type { ChatMessage, ModelInfo } from "@pylos/protocol";
import type { Provider, ProviderEvent, StreamOptions } from "../src/providers/types.ts";

/** Scripted provider: no network, deterministic, records what it was sent. */
export class FakeProvider implements Provider {
  readonly id = "xai" as const;
  readonly calls: Array<{ messages: ChatMessage[]; opts: StreamOptions }> = [];
  private script: ProviderEvent[][] = [];

  constructor(script?: ProviderEvent[][]) {
    if (script !== undefined) this.script = script;
  }

  reply(text: string): void {
    this.script.push([
      { type: "delta", text },
      { type: "usage", usage: { inputTokens: 11, outputTokens: 7 } },
      { type: "done", finishReason: "stop" },
    ]);
  }

  recallThen(args: Record<string, unknown>, text: string): void {
    this.script.push([
      { type: "tool_call", id: "call_1", name: "recall", args: JSON.stringify(args) },
      { type: "done", finishReason: "tool_calls" },
    ]);
    this.script.push([
      { type: "delta", text },
      { type: "usage", usage: { inputTokens: 21, outputTokens: 9 } },
      { type: "done", finishReason: "stop" },
    ]);
  }

  async *stream(messages: ChatMessage[], opts: StreamOptions): AsyncGenerator<ProviderEvent> {
    this.calls.push({ messages: structuredClone(messages), opts });
    const turn = this.script.shift() ?? [
      { type: "delta" as const, text: "(no script)" },
      { type: "done" as const },
    ];
    for (const event of turn) yield event;
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
