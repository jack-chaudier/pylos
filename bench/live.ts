/**
 * `pylos bench live` — the live variant (`bench/CORPUS.md` §9).
 *
 * Same deterministic generator, `N = 2,000`. Episodes 1..N−1 are *played* into
 * the vault from the generator (assistant text is the scripted text — no model
 * calls) so both arms see an identical archive. At each probe seq the bench
 * builds two packets from the same vault state — the rolling-summary baseline
 * and Pylos — and sends each to the real model. Every request, response, packet
 * digest, page and token count is recorded.
 *
 * The provider is injected: the kernel never talks to a network. `@pylos/server`
 * supplies one; without it this command explains what is missing and exits.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomize, compact, compile, type EpisodeInput, openVault, type Provider, recall } from "@pylos/core";
import { createCorpus, RECALL_TOOL, retained } from "@pylos/core/pure";
import type { ChatMessage } from "@pylos/protocol";
import { RollingSummary } from "./baseline.ts";

export interface LiveOptions {
  model: string;
  turns: number;
  seed: string;
  budget: number;
  /** Injected by the caller; without it the run explains itself and stops. */
  provider?: Provider;
  home?: string;
  out?: string;
}

export interface ProbeScore {
  seq: number;
  kind?: "fact" | "quote" | "number";
  query?: string;
  arm: "pylos" | "rolling";
  packetDigest: string;
  packetTokens: number;
  pages: number;
  answer: string;
  current: boolean;
  stale: boolean;
  abstained: boolean;
}

export interface LiveResult {
  ok: boolean;
  model: string;
  probes: ProbeScore[];
  summary: Record<
    "pylos" | "rolling",
    { current: number; stale: number; abstained: number; silentFalse: number }
  >;
  trap: {
    question: string;
    rule: { seq: number; text: string };
    revision: { seq: number; text: string };
    headHash: string;
    pylos: { answer: string; packetDigest: string; packetTokens: number; pages: number };
    rolling: { answer: string; packetTokens: number };
  } | null;
  reason?: string;
}

const ABSTAIN =
  /don't have|do not have|not in|would need to check|recall|cannot see|can't see|no record|no information|not recorded|don't see|do not see|no mention|nothing in|not available|unknown|not stated|haven't|have not (?:been )?(?:told|given)|unable to|let me check|checking the archive/i;
const HEDGE = /earlier|previously|used to|has changed|since changed/i;

export async function runLive(options: LiveOptions): Promise<LiveResult> {
  if (options.provider === undefined) {
    const reason =
      "pylos bench live needs a provider. Run it through @pylos/server (which owns credentials " +
      "and the xAI/Anthropic/OpenAI/Ollama clients), or pass one in programmatically:\n" +
      "  runLive({ model, turns, seed, budget, provider })\n" +
      "The kernel never opens a network connection itself.";
    process.stderr.write(`${reason}\n`);
    return {
      ok: false,
      model: options.model,
      probes: [],
      summary: {
        pylos: { current: 0, stale: 0, abstained: 0, silentFalse: 0 },
        rolling: { current: 0, stale: 0, abstained: 0, silentFalse: 0 },
      },
      trap: null,
      reason,
    };
  }

  const resultsDir = join(import.meta.dir, "results");
  mkdirSync(resultsDir, { recursive: true });
  const home = options.home ?? join(resultsDir, "tmp", `live-vault-${options.seed}`);
  rmSync(home, { recursive: true, force: true });
  const vault = openVault({ home, fast: true });
  const thread = vault.threads.create(`live-${options.seed}`, { budget: options.budget });
  const corpus = createCorpus(options.seed, options.turns, {
    plants: options.turns < 100_000 ? { facts: 40, quotes: 10, numbers: 10 } : undefined,
  });
  const rolling = new RollingSummary(options.budget);

  // ---- play the archive in; no model calls, both arms see identical history
  for (let start = 1; start < options.turns; start += 250) {
    const end = Math.min(start + 249, options.turns - 1);
    const inputs: EpisodeInput[] = [];
    for (let seq = start; seq <= end; seq += 1) {
      const episode = corpus.episodeAt(seq);
      inputs.push({
        role: episode.role,
        content: episode.content,
        ts: 1_760_000_000_000 + seq * 60_000,
        ...(episode.model === undefined ? {} : { model: episode.model, provider: "bench" }),
      });
    }
    const written = vault.tx(() => {
      const appended = vault.episodes.appendMany(thread.id, inputs);
      atomize(
        vault,
        thread.id,
        appended.map((e) => e.seq),
      );
      compact(vault, thread.id, { budget: options.budget });
      return appended;
    });
    for (const episode of written) rolling.push(episode);
  }

  const probeSeqs: number[] = [];
  for (let seq = 200; seq < options.turns; seq += 50) probeSeqs.push(seq);
  const probes: ProbeScore[] = [];

  const ask = async (
    messages: ChatMessage[],
    allowRecall: boolean,
  ): Promise<{ text: string; pages: number }> => {
    let text = "";
    let pages = 0;
    const conversation = [...messages];
    for (let round = 0; round < 3; round += 1) {
      const calls: Array<{ id: string; name: string; arguments: string }> = [];
      for await (const event of (options.provider as Provider)({
        model: options.model,
        messages: conversation,
        tools: allowRecall ? [RECALL_TOOL] : [],
      })) {
        if (event.type === "delta") text += event.text;
        else if (event.type === "tool_call") calls.push(event);
      }
      const recalls = calls.filter((c) => c.name === "recall");
      if (!allowRecall || recalls.length === 0) break;
      for (const call of recalls) {
        const served = recall(vault, thread.id, JSON.parse(call.arguments) as { query?: string }, {
          budget: Math.floor(options.budget * 0.18),
        });
        pages += served.result.records.filter((r) => r.resolved).length;
        conversation.push({
          role: "assistant",
          content: "",
          toolCalls: [{ id: call.id, name: "recall", args: call.arguments }],
        });
        conversation.push({ role: "tool", content: served.text, toolCallId: call.id, name: "recall" });
      }
    }
    return { text, pages };
  };

  type Item = {
    kind: "fact" | "quote" | "number";
    query: string;
    value1: string;
    value2: string;
    numeric?: number;
  };
  const usedFacts = new Set<number>();
  const usedQuotes = new Set<number>();
  const usedNumbers = new Set<number>();
  const pickItem = (seq: number, i: number): Item | undefined => {
    const order: Array<"fact" | "quote" | "number"> =
      i % 3 === 0
        ? ["quote", "fact", "number"]
        : i % 3 === 1
          ? ["number", "fact", "quote"]
          : ["fact", "quote", "number"];
    for (const kind of order) {
      if (kind === "fact") {
        const f = corpus.manifest.facts.filter((x) => x.seq2 < seq && !usedFacts.has(x.id)).at(-1);
        if (f) {
          usedFacts.add(f.id);
          return { kind, query: f.queries[0] as string, value1: f.value1, value2: f.value2 };
        }
      } else if (kind === "quote") {
        const q = corpus.manifest.quotes.filter((x) => x.seq < seq && !usedQuotes.has(x.seq)).at(-1);
        if (q) {
          usedQuotes.add(q.seq);
          return { kind, query: q.query, value1: "", value2: q.text.replace(/^[“"]|[”"]$/g, "") };
        }
      } else {
        const n = corpus.manifest.numbers.filter((x) => x.seq < seq && !usedNumbers.has(x.seq)).at(-1);
        if (n) {
          usedNumbers.add(n.seq);
          return { kind, query: n.query, value1: "", value2: n.valueText, numeric: n.value };
        }
      }
    }
    return undefined;
  };

  let i = 0;
  for (const seq of probeSeqs) {
    const item = pickItem(seq, i);
    i += 1;
    if (item === undefined) continue;
    const query = item.query;

    const packet = compile(vault, thread.id, { query, budget: options.budget, model: options.model });
    const pylosAnswer = await ask([...packet.messages, { role: "user", content: query }], true);
    probes.push(score(seq, "pylos", packet.digest, packet.tokens, pylosAnswer.pages, pylosAnswer.text, item));

    const baseline = rolling.packet(query, seq);
    const rollingAnswer = await ask(baseline.messages, false);
    probes.push(score(seq, "rolling", "", baseline.tokens, 0, rollingAnswer.text, item));
  }

  const summary = {
    pylos: tally(probes.filter((p) => p.arm === "pylos")),
    rolling: tally(probes.filter((p) => p.arm === "rolling")),
  };

  const trapPacket = compile(vault, thread.id, {
    query: corpus.manifest.trapText,
    budget: options.budget,
    model: options.model,
  });
  const trapPylos = await ask(
    [...trapPacket.messages, { role: "user", content: corpus.manifest.trapText }],
    true,
  );
  const rollingTrapPacket = rolling.packet(corpus.manifest.trapText, options.turns);
  const trapRolling = await ask(rollingTrapPacket.messages, false);
  const ruleEp = vault.episodes.get(thread.id, corpus.manifest.ruleSeq);
  const revisionEp = vault.episodes.get(thread.id, corpus.manifest.revisionSeq);
  const head = vault.threads.get(thread.id);

  const result: LiveResult = {
    ok: true,
    model: options.model,
    probes,
    summary,
    trap: {
      question: corpus.manifest.trapText,
      rule: { seq: corpus.manifest.ruleSeq, text: ruleEp?.content ?? "" },
      revision: { seq: corpus.manifest.revisionSeq, text: revisionEp?.content ?? "" },
      headHash: head?.headHash ?? "",
      pylos: {
        answer: trapPylos.text,
        packetDigest: trapPacket.digest,
        packetTokens: trapPacket.tokens,
        pages: trapPylos.pages,
      },
      rolling: { answer: trapRolling.text, packetTokens: rollingTrapPacket.tokens },
    },
  };
  const out = options.out ?? join(resultsDir, `million-live-${options.seed}.jsonl`);
  await Bun.write(
    out,
    `${probes.map((p) => JSON.stringify(p)).join("\n")}\n${JSON.stringify({ summary, trap: result.trap })}\n`,
  );
  vault.close();
  return result;
}

function score(
  seq: number,
  arm: "pylos" | "rolling",
  digest: string,
  tokens: number,
  pages: number,
  answer: string,
  fact: {
    kind: "fact" | "quote" | "number";
    query: string;
    value1: string;
    value2: string;
    numeric?: number;
  },
): ProbeScore {
  const current =
    answer.includes(fact.value2) ||
    (fact.numeric !== undefined && retained(answer, fact.numeric)) ||
    (fact.kind !== "quote" && fact.value2 !== "" && retained(answer, Number(fact.value2)));
  const stale = fact.value1 !== "" && answer.includes(fact.value1) && !HEDGE.test(answer);
  return {
    seq,
    kind: fact.kind,
    query: fact.query,
    arm,
    packetDigest: digest,
    packetTokens: tokens,
    pages,
    answer,
    current,
    stale,
    abstained: ABSTAIN.test(answer),
  };
}

function tally(probes: ProbeScore[]): {
  current: number;
  stale: number;
  abstained: number;
  silentFalse: number;
} {
  return {
    current: probes.filter((p) => p.current).length,
    stale: probes.filter((p) => p.stale).length,
    abstained: probes.filter((p) => p.abstained).length,
    silentFalse: probes.filter((p) => p.stale && !p.abstained).length,
  };
}
