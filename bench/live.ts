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
import { retained } from "@pylos/core/pure";
import type { ChatMessage } from "@pylos/protocol";
import { RollingSummary } from "./baseline.ts";
import { buildCorpus } from "./corpus.ts";

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
  trap: { pylos: string; rolling: string } | null;
  reason?: string;
}

const ABSTAIN = /don't have|do not have|not in|would need to check|recall|cannot see|can't see/i;
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
  const corpus = buildCorpus({ seed: options.seed, n: options.turns });
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
  for (let seq = 200; seq < options.turns; seq += 100) probeSeqs.push(seq);
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
        tools: [],
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

  for (const seq of probeSeqs) {
    const fact = corpus.manifest.facts.filter((f) => f.seq2 < seq).at(-1);
    if (fact === undefined) continue;
    const query = fact.queries[0] as string;

    const packet = compile(vault, thread.id, { query, budget: options.budget, model: options.model });
    const pylosAnswer = await ask([...packet.messages, { role: "user", content: query }], true);
    probes.push(score(seq, "pylos", packet.digest, packet.tokens, pylosAnswer.pages, pylosAnswer.text, fact));

    const baseline = rolling.packet(query, seq);
    const rollingAnswer = await ask(baseline.messages, false);
    probes.push(score(seq, "rolling", "", baseline.tokens, 0, rollingAnswer.text, fact));
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
  const trapRolling = await ask(rolling.packet(corpus.manifest.trapText, options.turns).messages, false);

  const result: LiveResult = {
    ok: true,
    model: options.model,
    probes,
    summary,
    trap: { pylos: trapPylos.text, rolling: trapRolling.text },
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
  fact: { value1: string; value2: string },
): ProbeScore {
  const current = answer.includes(fact.value2) || retained(answer, Number(fact.value2));
  const stale = answer.includes(fact.value1) && !HEDGE.test(answer);
  return {
    seq,
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
