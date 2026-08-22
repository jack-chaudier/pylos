/**
 * The turn protocol (KERNEL §6, A6).
 *
 * ```
 * tx A : user (+ attachment) episodes, packet row with status='pending'
 *  ⋯   : stream the provider; serve `recall` tool calls from the archive (§5.4)
 * tx B : tool episodes + assistant episode + rule atoms + sealed capsules,
 *        packet status='done'
 * tx C : (optional, async) model-extracted atoms — frontier only
 * ```
 *
 * Provider sessions are caches. Step 2 must work on a brand-new provider session
 * every time; no provider conversation id is ever required to continue.
 */

import type { ChatMessage, Episode, Packet, PageRecord, ToolDef, TurnEvent, Usage } from "@pylos/protocol";
import { atomize, atomizeWithModel, type ModelExtractor } from "./atomize.ts";
import { compact } from "./compact.ts";
import { type CompileOptions, compile } from "./compile.ts";
import { recall } from "./page.ts";
import { RECALL_TOOL } from "./pure/render.ts";
import type { Tokenizer } from "./pure/tokens.ts";
import type { EpisodeInput, Vault } from "./vault.ts";

/** What a provider streams back. Providers live in `@pylos/server`. */
export type ProviderEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done"; usage?: Usage }
  | { type: "error"; message: string; code?: string };

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  /** Tool definitions; empty when the model has no tools. */
  tools: ToolDef[];
}

/** The one function a provider must implement. */
export type Provider = (request: ProviderRequest) => AsyncIterable<ProviderEvent>;

export interface RunTurnOptions {
  text: string;
  model: string;
  provider: Provider;
  budget?: number;
  supportsTools?: boolean;
  /** Attachment episodes appended before the user turn. */
  attachments?: EpisodeInput[];
  providerId?: string;
  tokenizer?: Tokenizer;
  /** Max provider round-trips spent serving `recall` calls. */
  maxRecallRounds?: number;
  /** Stage 2 atomization; runs after the reply, never blocks it. */
  modelExtractor?: ModelExtractor;
  onEvent?: (event: TurnEvent) => void;
  compileOptions?: Partial<CompileOptions>;
}

export interface TurnResult {
  userEpisode: Episode;
  attachmentEpisodes: Episode[];
  toolEpisodes: Episode[];
  assistantEpisode: Episode;
  packet: Packet;
  pages: PageRecord[];
  text: string;
  usage?: Usage;
}

export async function runTurn(vault: Vault, threadId: string, options: RunTurnOptions): Promise<TurnResult> {
  const emit = options.onEvent ?? (() => {});
  const supportsTools = options.supportsTools !== false;

  // ---------------------------------------------------------------- tx A
  const { userEpisode, attachmentEpisodes, packet } = vault.tx(() => {
    const attachments = options.attachments ? vault.episodes.appendMany(threadId, options.attachments) : [];
    const user = vault.episodes.append(threadId, { role: "user", content: options.text });
    const compiled = compile(vault, threadId, {
      query: options.text,
      model: options.model,
      turnSeq: user.seq,
      supportsTools,
      record: true,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.tokenizer === undefined ? {} : { tokenizer: options.tokenizer }),
      ...options.compileOptions,
    });
    vault.packets.insert(compiled, "pending");
    return { userEpisode: user, attachmentEpisodes: attachments, packet: compiled };
  });

  for (const episode of attachmentEpisodes) emit({ type: "episode", episode });
  emit({ type: "episode", episode: userEpisode });
  emit({
    type: "packet",
    packetId: packet.id,
    tokens: packet.tokens,
    budget: packet.budget,
    pages: packet.pages,
    ledger: packet.ledger,
    digest: packet.digest,
  });

  // ------------------------------------------------- stream + recall loop
  const messages: ChatMessage[] = [...packet.messages];
  const pages: PageRecord[] = [...packet.pages];
  const toolPayloads: Array<{ content: string }> = [];
  const residentSeqs = new Set(
    packet.resident.filter((r) => r.seq !== undefined).map((r) => r.seq as number),
  );
  const maxRounds = options.maxRecallRounds ?? 3;
  let text = "";
  let usage: Usage | undefined;

  for (let round = 0; ; round += 1) {
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    let failed: string | null = null;
    for await (const event of options.provider({
      model: options.model,
      messages,
      tools: supportsTools ? [RECALL_TOOL] : [],
    })) {
      if (event.type === "delta") {
        text += event.text;
        emit({ type: "delta", text: event.text });
      } else if (event.type === "tool_call") {
        calls.push({ id: event.id, name: event.name, arguments: event.arguments });
      } else if (event.type === "done") {
        if (event.usage) usage = event.usage;
      } else if (event.type === "error") {
        failed = event.message;
      }
    }
    if (failed !== null) {
      emit({ type: "error", message: failed });
      throw new Error(failed);
    }
    const recalls = calls.filter((c) => c.name === "recall");
    if (recalls.length === 0 || round >= maxRounds) break;

    for (const call of recalls) {
      const args = parseArgs(call.arguments);
      const served = recall(vault, threadId, args, {
        budget: Math.max(400, Math.floor(packet.budget * 0.18)),
        residentSeqs,
        ...(options.tokenizer === undefined ? {} : { tokenizer: options.tokenizer }),
      });
      for (const record of served.result.records) {
        pages.push(record);
        emit({ type: "page", page: record });
        for (const seq of record.seqs) residentSeqs.add(seq);
      }
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: call.id, name: "recall", args: call.arguments }],
      });
      messages.push({ role: "tool", content: served.text, toolCallId: call.id, name: "recall" });
      toolPayloads.push({ content: `recall(${JSON.stringify(args)}) →\n${served.text}` });
    }
  }

  // ---------------------------------------------------------------- tx B
  const { assistantEpisode, toolEpisodes } = vault.tx(() => {
    const tools = toolPayloads.map((payload) => ({
      role: "tool" as const,
      content: payload.content,
      meta: { packetId: packet.id },
    }));
    const toolEps = tools.length > 0 ? vault.episodes.appendMany(threadId, tools) : [];
    const assistant = vault.episodes.append(threadId, {
      role: "assistant",
      content: text,
      model: options.model,
      ...(options.providerId === undefined ? {} : { provider: options.providerId }),
      meta: {
        packetId: packet.id,
        ...(usage === undefined ? {} : { usage }),
        ...(pages.length === 0 ? {} : { pages }),
      },
    });
    atomize(vault, threadId, [userEpisode.seq, assistant.seq]);
    compact(vault, threadId, options.budget === undefined ? {} : { budget: options.budget });
    vault.packets.finish(packet.id, pages);
    vault.packets.prune(threadId);
    if (assistant.seq % 10000 === 0) vault.stopNames.recompute(threadId, assistant.seq);
    return { assistantEpisode: assistant, toolEpisodes: toolEps };
  });

  emit({ type: "done", episode: assistantEpisode, ...(usage === undefined ? {} : { usage }) });

  // ---------------------------------------------------------------- tx C
  if (options.modelExtractor) {
    void atomizeWithModel(
      vault,
      threadId,
      [userEpisode.seq, assistantEpisode.seq],
      options.modelExtractor,
    ).catch(() => {
      // Stage 2 is best-effort by contract: it may never block or fail a turn.
    });
  }

  return {
    userEpisode,
    attachmentEpisodes,
    toolEpisodes,
    assistantEpisode,
    packet: { ...packet, pages },
    pages,
    text,
    ...(usage === undefined ? {} : { usage }),
  };
}

function parseArgs(raw: string): { query?: string; seq?: number; range?: [number, number] } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: { query?: string; seq?: number; range?: [number, number] } = {};
    if (typeof parsed.query === "string") out.query = parsed.query.slice(0, 500);
    if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) out.seq = Math.floor(parsed.seq);
    if (Array.isArray(parsed.range) && parsed.range.length === 2) {
      const from = Number(parsed.range[0]);
      const to = Number(parsed.range[1]);
      if (Number.isFinite(from) && Number.isFinite(to)) out.range = [Math.floor(from), Math.floor(to)];
    }
    return out;
  } catch {
    return { query: raw.slice(0, 500) };
  }
}

/** Model switch: a `handoff` episode, then an ordinary turn (KERNEL §6). */
export function handoff(vault: Vault, threadId: string, from: string, to: string): Episode {
  return vault.episodes.append(threadId, {
    role: "handoff",
    content: `${from} stopped here. ${to} continued from the same thread.`,
    meta: { from, to },
  });
}
