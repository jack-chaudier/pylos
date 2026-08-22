/**
 * Baseline packet builders (`bench/CORPUS.md` §6).
 *
 * These exist to isolate the three mechanisms Pylos adds — the loss ledger, the
 * frontier, and exact paging — by running the *same* archive, the *same* budget
 * and the *same* query through builders that lack them.
 *
 * **Rolling summary (primary).** Header + a summary `S` (≤ 25% of B) + a recent
 * window (≤ 70% of B). When the recent window overflows, the oldest episodes are
 * folded into `S` with the same deterministic extractive writer Pylos uses for
 * capsules, minus the atom lines. No ledger, no frontier, no paging, no tools.
 * This is what every chat app does today.
 *
 * **BM25 (secondary).** Header + recent window (50%) + top-k episodes by FTS5
 * BM25 on the query (45%). Retrieval without a record of what was lost.
 */

import type { Vault } from "@pylos/core";
import { approxTokens, isSalient, type Tokenizer, truncateLines } from "@pylos/core/pure";
import type { ChatMessage, Episode } from "@pylos/protocol";

export interface BaselinePacket {
  messages: ChatMessage[];
  tokens: number;
  text: string;
}

function render(messages: readonly ChatMessage[]): string {
  return messages.map((m) => `${m.role}\n${m.content}`).join("\n\n");
}

/** The rolling-summary baseline: a compactor with no record of what it dropped. */
export class RollingSummary {
  private summary = "";
  private recent: Episode[] = [];
  private recentTokens = 0;

  constructor(
    private readonly budget: number,
    private readonly tokenizer: Tokenizer = approxTokens,
  ) {}

  private get summaryBudget(): number {
    return Math.floor(this.budget * 0.25);
  }

  private get recentBudget(): number {
    return Math.floor(this.budget * 0.7);
  }

  push(episode: Episode): void {
    this.recent.push(episode);
    this.recentTokens += this.tokenizer(episode.content) + 4;
    if (this.recentTokens <= this.recentBudget) return;
    const evicted: Episode[] = [];
    // Fold down to 80% so the writer runs on batches, not on every turn.
    while (this.recent.length > 1 && this.recentTokens > this.recentBudget * 0.8) {
      const gone = this.recent.shift() as Episode;
      this.recentTokens -= this.tokenizer(gone.content) + 4;
      evicted.push(gone);
    }
    this.fold(evicted);
  }

  /** `S := writer(S ‖ evicted)` — value-dense, chronological, hard-truncated. */
  private fold(evicted: readonly Episode[]): void {
    const lines: string[] = this.summary.length > 0 ? this.summary.split("\n") : [];
    const salient: string[] = [];
    const leads: string[] = [];
    for (const episode of evicted) {
      const sentences = episode.content.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 1);
      let lead = false;
      for (const sentence of sentences) {
        if (isSalient(sentence)) salient.push(sentence.trim());
        else if (!lead) {
          leads.push(sentence.trim());
          lead = true;
        }
      }
    }
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const line of [...lines, ...salient, ...leads]) {
      if (line.length === 0 || seen.has(line)) continue;
      seen.add(line);
      merged.push(line);
    }
    this.summary = truncateLines(merged.join("\n"), this.summaryBudget, this.tokenizer).kept;
  }

  packet(query: string, turns: number): BaselinePacket {
    const header = [
      "You are continuing one long conversation.",
      `Archive length: ${turns} turns. Below is a running summary and the most recent messages.`,
    ].join("\n");
    const system = `${header}\n\n⟦summary so far⟧\n${this.summary}`;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...this.recent.map((episode) => ({
        role: (episode.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
        content: episode.content,
      })),
      { role: "user", content: query },
    ];
    let text = render(messages);
    let tokens = this.tokenizer(text);
    while (tokens > this.budget && messages.length > 2) {
      messages.splice(1, 1);
      text = render(messages);
      tokens = this.tokenizer(text);
    }
    return { messages, tokens, text };
  }
}

/** The BM25 baseline: retrieval, but no record of what compaction removed. */
export function bm25Packet(
  vault: Vault,
  threadId: string,
  query: string,
  budget: number,
  turns: number,
  tokenizer: Tokenizer = approxTokens,
): BaselinePacket {
  const recentBudget = Math.floor(budget * 0.5);
  const retrievedBudget = Math.floor(budget * 0.45);
  const recent: Episode[] = [];
  let used = 0;
  for (const episode of vault.episodes.tail(threadId, 200).reverse()) {
    const cost = tokenizer(episode.content) + 4;
    if (used + cost > recentBudget) break;
    recent.unshift(episode);
    used += cost;
  }
  const residentSeqs = new Set(recent.map((e) => e.seq));
  const retrieved: Episode[] = [];
  let retrievedUsed = 0;
  for (const episode of vault.episodes.search(threadId, query, 20)) {
    if (residentSeqs.has(episode.seq)) continue;
    const cost = tokenizer(episode.content) + 8;
    if (retrievedUsed + cost > retrievedBudget) break;
    retrieved.push(episode);
    retrievedUsed += cost;
  }
  const system = [
    "You are continuing one long conversation.",
    `Archive length: ${turns} turns. Relevant earlier messages were retrieved by search.`,
    "",
    ...retrieved.map((e) => `⟦retrieved #${e.seq}⟧\n${e.content}`),
  ].join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...recent.map((episode) => ({
      role: (episode.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
      content: episode.content,
    })),
    { role: "user", content: query },
  ];
  let text = render(messages);
  let tokens = tokenizer(text);
  while (tokens > budget && messages.length > 2) {
    messages.splice(1, 1);
    text = render(messages);
    tokens = tokenizer(text);
  }
  return { messages, tokens, text };
}
