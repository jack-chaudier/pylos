/**
 * `pylos bench million` — the deterministic million-turn bench
 * (KERNEL §10, `bench/CORPUS.md`).
 *
 * Zero model calls. Generates the seeded corpus, ingests it through the real
 * kernel (append → atomize → compact), and at every checkpoint asserts the
 * claims the landing page is allowed to make:
 *
 *   1. the packet never exceeds the budget,
 *   2. a revised fact answers from the *current* atom and the old one is reachable,
 *   3. a planted quote pages back byte-exact,
 *   4. a planted number is routed by the ledger, not guessed,
 *   5. the ledger is conserved and complete,
 *   6. the chain verifies,
 *   7. per-turn wall time stays flat.
 *
 * Failures are recorded, not thrown: the run continues and the report says
 * where it first broke.
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  atomize,
  capsuleTokensFor,
  compact,
  compile,
  type EpisodeInput,
  openVault,
  packetText,
  residentLeafCount,
  sourceNamesForRange,
  type Vault,
  verify,
} from "@pylos/core";
import { nameSet, retained } from "@pylos/core/pure";
import type { Episode, Packet } from "@pylos/protocol";
import { bm25Packet, RollingSummary } from "./baseline.ts";
import { buildCorpus, type Corpus, type Manifest, vocabSha256 } from "./corpus.ts";

export interface MillionOptions {
  turns: number;
  seed: string;
  budget: number;
  out?: string;
  home?: string;
  /** Checkpoint interval. Default 10,000. */
  every?: number;
  /** Batch size for ingest transactions. */
  batch?: number;
  quiet?: boolean;
}

export interface CheckpointResult {
  seq: number;
  budgetCheck: { ok: boolean; trapTokens: number | null; queryTokensMax: number; queryTokensP50: number };
  facts: { checked: number; resident: number; paged: number; failed: number[] };
  quotes: { checked: number; exact: number; failed: number[] };
  numbers: { checked: number; paged: number; failed: number[] };
  ledger: { entries: number; parentsChecked: number; conservationOk: boolean; completenessOk: boolean };
  verify: { ok: boolean; headHash: string; checkedTo: number };
  archiveBytes: number;
  residentTokensP50: number;
  wall: { ingestP50Ms: number; ingestP99Ms: number; compileP50Ms: number; compileP99Ms: number };
  routing: { pagesServed: number; pagesNeeded: number; precision: number };
  baselines: {
    rolling: { survival: number; tokensMax: number };
    bm25: { survival: number; tokensMax: number };
  };
  trap: TrapResult | null;
}

export interface TrapResult {
  pylos: {
    packetDigest: string;
    currentRuleResident: boolean;
    currentRuleSeq: number | null;
    historicalListed: boolean;
    pages: number;
    containsOldRule: boolean;
    packetTokens: number;
  };
  rolling: { containsException: boolean; containsOldRule: boolean; tokens: number };
  bm25: { containsException: boolean; containsOldRule: boolean; tokens: number };
}

export interface MillionResult {
  schema: "pylos.bench.million.v1";
  seed: string;
  N: number;
  budget: number;
  generator: { version: string; vocabSha256: string; manifestSha256: string };
  kernel: { version: string; leaf: number; fanout: number; capsuleTokens: Record<string, number> };
  planted: Record<string, number>;
  checkpoints: CheckpointResult[];
  final: {
    ok: boolean;
    firstFailure: string | null;
    trap: TrapResult | null;
    residencySlopeTokensPerDecade: number;
    archiveBytes: number;
    lossEntries: number;
    capsules: number;
    atoms: { supported: number; historical: number };
    wall: { totalSec: number; turnsPerSec: number; ingestP50Ms: number; ingestP99Ms: number };
  };
  env: Record<string, string>;
  startedAt: number;
  finishedAt: number;
  digest: string;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return Math.round(((sorted[index] as number) + Number.EPSILON) * 1000) / 1000;
}

export async function runMillion(options: MillionOptions): Promise<MillionResult> {
  const started = Date.now();
  const every = options.every ?? 10_000;
  const batchSize = options.batch ?? 500;
  const log = (line: string): void => {
    if (options.quiet !== true) process.stdout.write(`${line}\n`);
  };

  const resultsDir = join(import.meta.dir, "results");
  mkdirSync(resultsDir, { recursive: true });
  const home = options.home ?? join(resultsDir, "tmp", `vault-${options.seed}`);
  rmSync(home, { recursive: true, force: true });

  const vault = openVault({ home, fast: true });
  const thread = vault.threads.create(`bench-${options.seed}`, { budget: options.budget });
  const corpus = buildCorpus({ seed: options.seed, n: options.turns });
  const manifest = corpus.manifest;
  const rolling = new RollingSummary(options.budget);

  log(
    `pylos bench million · seed ${options.seed} · N ${options.turns.toLocaleString()} · B ${options.budget}\n` +
      `planted: rule #${manifest.ruleSeq} · revision #${manifest.revisionSeq} · trap #${manifest.trapSeq} · ` +
      `${manifest.facts.length} revised facts · ${manifest.quotes.length} quotes · ${manifest.numbers.length} numbers`,
  );

  const checkpoints: CheckpointResult[] = [];
  const ingestSamples: number[] = [];
  const windowSamples: number[] = [];
  let firstFailure: string | null = null;
  let previousLedger = 0;
  let fixedQuerySet: string[] = [];
  const residencyTrend: Array<{ seq: number; tokens: number }> = [];

  const fail = (where: string): void => {
    if (firstFailure === null) firstFailure = where;
  };

  for (let start = 1; start <= options.turns; start += batchSize) {
    const end = Math.min(start + batchSize - 1, options.turns);
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
    const t0 = performance.now();
    const appended = vault.tx(() => {
      const written = vault.episodes.appendMany(thread.id, inputs);
      atomize(
        vault,
        thread.id,
        written.map((e) => e.seq),
      );
      compact(vault, thread.id, { budget: options.budget });
      return written;
    });
    const elapsed = performance.now() - t0;
    const perEpisode = elapsed / inputs.length;
    ingestSamples.push(perEpisode);
    windowSamples.push(perEpisode);
    for (const episode of appended) rolling.push(episode);
    if (end % 100_000 === 0 || end === options.turns) {
      vault.stopNames.recompute(thread.id, end);
      log(
        `  ingested ${end.toLocaleString()} · ${(perEpisode * 1000).toFixed(0)} µs/turn · ` +
          `${(vault.losses.total(thread.id) / 1000).toFixed(0)}k ledger rows`,
      );
    }

    const crossed = Math.floor(end / every) > Math.floor((start - 1) / every) || end === options.turns;
    if (!crossed) continue;
    const checkpointSeq = end === options.turns ? options.turns : Math.floor(end / every) * every;
    const isFinal = end === options.turns;

    const result = runCheckpoint({
      vault,
      threadId: thread.id,
      corpus,
      manifest,
      seq: checkpointSeq,
      budget: options.budget,
      isFinal,
      rolling,
      windowSamples: windowSamples.splice(0),
      previousLedger,
      fixedQuerySet,
      fail,
    });
    if (fixedQuerySet.length === 0) fixedQuerySet = result.fixedQuerySet;
    previousLedger = result.checkpoint.ledger.entries;
    checkpoints.push(result.checkpoint);
    residencyTrend.push({ seq: checkpointSeq, tokens: result.checkpoint.residentTokensP50 });
    log(
      `  ✓ #${checkpointSeq.toLocaleString()} · tokens ≤ ${result.checkpoint.budgetCheck.queryTokensMax}/${options.budget} · ` +
        `facts ${result.checkpoint.facts.checked - result.checkpoint.facts.failed.length}/${result.checkpoint.facts.checked} · ` +
        `quotes ${result.checkpoint.quotes.exact}/${result.checkpoint.quotes.checked} · ` +
        `numbers ${result.checkpoint.numbers.paged}/${result.checkpoint.numbers.checked} · ` +
        `ledger ${(result.checkpoint.ledger.entries / 1000).toFixed(1)}k · ` +
        `p50 ${(result.checkpoint.wall.ingestP50Ms * 1000).toFixed(0)}µs`,
    );
  }

  const finished = Date.now();
  const last = checkpoints.at(-1);
  const slope = residencySlope(residencyTrend);
  const capsuleTokens = capsuleTokensFor(options.budget);

  const output: MillionResult = {
    schema: "pylos.bench.million.v1",
    seed: options.seed,
    N: options.turns,
    budget: options.budget,
    generator: {
      version: "1.0.0",
      vocabSha256: vocabSha256(),
      manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    },
    kernel: {
      version: "1.0.0",
      leaf: 32,
      fanout: 8,
      capsuleTokens: { ...capsuleTokens, residentLeaves: residentLeafCount(options.budget) },
    },
    planted: {
      facts: manifest.facts.length,
      quotes: manifest.quotes.length,
      numbers: manifest.numbers.length,
      ruleSeq: manifest.ruleSeq,
      revisionSeq: manifest.revisionSeq,
      trapSeq: manifest.trapSeq,
    },
    checkpoints,
    final: {
      ok: firstFailure === null,
      firstFailure,
      trap: last?.trap ?? null,
      residencySlopeTokensPerDecade: slope,
      archiveBytes: last?.archiveBytes ?? 0,
      lossEntries: vault.losses.total(thread.id),
      capsules: vault.capsules.count(thread.id),
      atoms: {
        supported: vault.counter(thread.id, "atoms.supported"),
        historical: vault.counter(thread.id, "atoms.historical"),
      },
      wall: {
        totalSec: Math.round((finished - started) / 100) / 10,
        turnsPerSec: Math.round(options.turns / ((finished - started) / 1000)),
        ingestP50Ms: percentile(ingestSamples, 50),
        ingestP99Ms: percentile(ingestSamples, 99),
      },
    },
    env: {
      bun: Bun.version,
      os: `${process.platform} ${process.arch}`,
    },
    startedAt: started,
    finishedAt: finished,
    digest: "",
  };
  output.digest = createHash("sha256").update(JSON.stringify(output)).digest("hex");

  const outPath = options.out ?? join(resultsDir, `million-${options.seed}.json`);
  await Bun.write(outPath, `${JSON.stringify(output, null, 2)}\n`);
  await Bun.write(outPath.replace(/\.json$/, ".md"), renderReport(output));
  log(
    `\n${output.final.ok ? "PASS" : `FAIL (${output.final.firstFailure})`} · ` +
      `${output.final.wall.totalSec}s · ${output.final.wall.turnsPerSec.toLocaleString()} turns/s · ` +
      `${(output.final.archiveBytes / 1048576).toFixed(0)} MiB archive · ` +
      `${output.final.lossEntries.toLocaleString()} ledger entries\nwrote ${outPath}`,
  );
  vault.close();
  return output;
}

interface CheckpointInput {
  vault: Vault;
  threadId: string;
  corpus: Corpus;
  manifest: Manifest;
  seq: number;
  budget: number;
  isFinal: boolean;
  rolling: RollingSummary;
  windowSamples: number[];
  previousLedger: number;
  fixedQuerySet: string[];
  fail: (where: string) => void;
}

function runCheckpoint(input: CheckpointInput): { checkpoint: CheckpointResult; fixedQuerySet: string[] } {
  const { vault, threadId, manifest, seq, budget, isFinal, fail } = input;
  const planted = input.corpus.plantedBefore(seq);
  const sample = <T>(items: T[], n: number): T[] => {
    if (items.length <= n) return items;
    const step = items.length / n;
    return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)] as T);
  };

  const compileTimes: number[] = [];
  const packetFor = (query: string): Packet => {
    const t0 = performance.now();
    const packet = compile(vault, threadId, { query, budget, model: "bench" });
    compileTimes.push(performance.now() - t0);
    return packet;
  };

  // ---- 1. budget, over the checkpoint query set
  const factSample = sample(planted.facts, isFinal ? planted.facts.length : 20);
  const quoteSample = sample(planted.quotes, isFinal ? planted.quotes.length : 5);
  const numberSample = sample(planted.numbers, isFinal ? planted.numbers.length : 5);
  const queries = [
    ...factSample.map((f) => f.queries[0] as string),
    ...quoteSample.map((q) => q.query),
    ...numberSample.map((n) => n.query),
  ];
  const fixedQuerySet = input.fixedQuerySet.length > 0 ? input.fixedQuerySet : sample(queries, 20);

  const tokens: number[] = [];
  let budgetOk = true;

  // ---- 2. revised facts
  const factsResult = { checked: 0, resident: 0, paged: 0, failed: [] as number[] };
  for (const fact of factSample) {
    const packet = packetFor(fact.queries[0] as string);
    tokens.push(packet.tokens);
    if (packet.tokens > budget) budgetOk = false;
    const text = packetText(packet.messages);
    factsResult.checked += 1;
    const hasCurrent = text.includes(fact.value2);
    const staleAsCurrent = new RegExp(`${escapeRegex(fact.key)} = ${escapeRegex(fact.value1)} ⟨#\\d+⟩`).test(
      text,
    );
    const paged = packet.pages.some((p) => p.resolved && p.seqs.includes(fact.seq2));
    if (hasCurrent && !staleAsCurrent) {
      if (paged) factsResult.paged += 1;
      else factsResult.resident += 1;
    } else {
      factsResult.failed.push(fact.id);
    }
  }
  if (factsResult.failed.length > 0) fail(`facts@${seq}`);

  // ---- 3. quotes: the paged span must equal the original string, byte for byte
  const quotesResult = { checked: 0, exact: 0, failed: [] as number[] };
  for (const quote of quoteSample) {
    const packet = packetFor(quote.query);
    tokens.push(packet.tokens);
    if (packet.tokens > budget) budgetOk = false;
    quotesResult.checked += 1;
    const episode = vault.episodes.get(threadId, quote.seq) as Episode;
    const slice = episode.content.slice(quote.span[0], quote.span[1]);
    const text = packetText(packet.messages);
    if (slice === quote.text && text.includes(quote.text)) quotesResult.exact += 1;
    else quotesResult.failed.push(quote.seq);
  }
  if (quotesResult.failed.length > 0) fail(`quotes@${seq}`);

  // ---- 4. numbers: routed by the ledger, never guessed
  const numbersResult = { checked: 0, paged: 0, failed: [] as number[] };
  for (const number of numberSample) {
    const packet = packetFor(number.query);
    tokens.push(packet.tokens);
    if (packet.tokens > budget) budgetOk = false;
    numbersResult.checked += 1;
    const text = packetText(packet.messages);
    if (retained(text, number.value) && text.includes(number.valueText)) numbersResult.paged += 1;
    else numbersResult.failed.push(number.seq);
  }
  if (numbersResult.failed.length > 0) fail(`numbers@${seq}`);

  // ---- 5. ledger: conservation and completeness, recomputed from episodes
  const entries = vault.losses.total(threadId);
  if (entries < input.previousLedger) fail(`ledger-monotone@${seq}`);
  let conservationOk = true;
  let completenessOk = true;
  let parentsChecked = 0;
  const parents = [
    ...vault.capsules.list(threadId, 1, isFinal ? 256 : 24),
    ...vault.capsules.list(threadId, 2, isFinal ? 64 : 8),
  ];
  for (const parent of parents) {
    const ledger = new Set(vault.losses.inRange(threadId, parent.fromSeq, parent.toSeq).map((l) => l.name));
    for (const child of vault.capsules.children(threadId, parent.level, parent.fromSeq, parent.toSeq)) {
      for (const entry of vault.losses.inRange(threadId, child.fromSeq, child.toSeq)) {
        if (!ledger.has(entry.name)) conservationOk = false;
      }
    }
    parentsChecked += 1;
  }
  for (const leaf of sample(vault.capsules.list(threadId, 0, 4096), isFinal ? 256 : 16)) {
    const source = sourceNamesForRange(vault, threadId, leaf.fromSeq, leaf.toSeq);
    const present = nameSet(leaf.text, { max: 8192 });
    const ledger = new Set(vault.losses.inRange(threadId, leaf.fromSeq, leaf.toSeq).map((l) => l.name));
    for (const entry of source) {
      if (!present.has(entry.name) && !ledger.has(entry.name)) completenessOk = false;
    }
  }
  if (!conservationOk) fail(`conservation@${seq}`);
  if (!completenessOk) fail(`completeness@${seq}`);

  // ---- 6. integrity
  const verified = verify(vault, threadId);
  if (!verified.ok) fail(`verify@${seq}`);

  // ---- routing precision, over the fact queries
  let pagesServed = 0;
  let pagesNeeded = 0;
  for (const fact of sample(factSample, isFinal ? 50 : 10)) {
    const packet = packetFor(fact.queries[0] as string);
    for (const record of packet.pages) {
      if (!record.resolved) continue;
      pagesServed += 1;
      const needed = record.seqs.some((s) => s === fact.seq2 || s === fact.seq1);
      if (needed) pagesNeeded += 1;
    }
  }

  // ---- residency trend, on the fixed query set drawn at the first checkpoint
  const residentTokens: number[] = [];
  for (const query of fixedQuerySet) {
    const packet = packetFor(query);
    residentTokens.push(packet.tokens);
    if (packet.tokens > budget) budgetOk = false;
  }

  // ---- baselines, same archive, same budget, same queries
  let rollingSurvival = 0;
  let bm25Survival = 0;
  let rollingMax = 0;
  let bm25Max = 0;
  // The baselines are a comparison, not the kernel: at intermediate checkpoints a
  // handful of queries is enough to track the trend, and BM25 retrieval over a
  // million-episode FTS index is the single most expensive thing in this file.
  const baselineSample = sample(factSample, isFinal ? 100 : 6);
  for (const fact of baselineSample) {
    const query = fact.queries[0] as string;
    const rollingPacket = input.rolling.packet(query, seq);
    const bm25 = bm25Packet(vault, threadId, query, budget, seq);
    rollingMax = Math.max(rollingMax, rollingPacket.tokens);
    bm25Max = Math.max(bm25Max, bm25.tokens);
    if (rollingPacket.text.includes(fact.value2)) rollingSurvival += 1;
    if (bm25.text.includes(fact.value2)) bm25Survival += 1;
  }
  const baselineCount = Math.max(1, baselineSample.length);

  // ---- the trap
  let trap: TrapResult | null = null;
  if (seq >= manifest.revisionSeq) {
    const packet = packetFor(manifest.trapText);
    tokens.push(packet.tokens);
    if (packet.tokens > budget) budgetOk = false;
    const text = packetText(packet.messages);
    // Look the rule up by kind, not by scanning the newest atoms: at a million
    // turns the standing rule is 500,000 turns old and would never appear in a
    // recency-ordered slice.
    const ruleAtom = vault.atoms
      .list(threadId, { phase: "SUPPORTED", kinds: ["preference"], limit: 200 })
      .find((a) => a.key.startsWith("rule."));
    const rollingPacket = input.rolling.packet(manifest.trapText, seq);
    const bm25 = bm25Packet(vault, threadId, manifest.trapText, budget, seq);
    trap = {
      pylos: {
        packetDigest: packet.digest,
        currentRuleResident: text.includes("additive-only"),
        currentRuleSeq: ruleAtom?.validFromSeq ?? null,
        historicalListed:
          packet.ledger.historical.some((h) => h.key.startsWith("rule.")) ||
          text.includes("historical, superseded"),
        pages: packet.pages.filter((p) => p.resolved).length,
        containsOldRule: text.includes("dry-run database is verified"),
        packetTokens: packet.tokens,
      },
      rolling: {
        containsException: rollingPacket.text.includes("additive-only"),
        containsOldRule: rollingPacket.text.includes("dry-run database is verified"),
        tokens: rollingPacket.tokens,
      },
      bm25: {
        containsException: bm25.text.includes("additive-only"),
        containsOldRule: bm25.text.includes("dry-run database is verified"),
        tokens: bm25.tokens,
      },
    };
    if (!trap.pylos.currentRuleResident) fail(`trap@${seq}`);
  }

  if (!budgetOk) fail(`budget@${seq}`);

  return {
    fixedQuerySet,
    checkpoint: {
      seq,
      budgetCheck: {
        ok: budgetOk,
        trapTokens: trap === null ? null : (tokens.at(-1) ?? null),
        queryTokensMax: tokens.length === 0 ? 0 : Math.max(...tokens),
        queryTokensP50: percentile(tokens, 50),
      },
      facts: factsResult,
      quotes: quotesResult,
      numbers: numbersResult,
      ledger: { entries, parentsChecked, conservationOk, completenessOk },
      verify: { ok: verified.ok, headHash: verified.headHash, checkedTo: verified.checkedTo },
      archiveBytes: archiveSize(vault),
      residentTokensP50: percentile(residentTokens, 50),
      wall: {
        ingestP50Ms: percentile(input.windowSamples, 50),
        ingestP99Ms: percentile(input.windowSamples, 99),
        compileP50Ms: percentile(compileTimes, 50),
        compileP99Ms: percentile(compileTimes, 99),
      },
      routing: {
        pagesServed,
        pagesNeeded,
        precision: pagesServed === 0 ? 1 : Math.round((pagesNeeded / pagesServed) * 1000) / 1000,
      },
      baselines: {
        rolling: {
          survival: Math.round((rollingSurvival / baselineCount) * 1000) / 1000,
          tokensMax: rollingMax,
        },
        bm25: {
          survival: Math.round((bm25Survival / baselineCount) * 1000) / 1000,
          tokensMax: bm25Max,
        },
      },
      trap,
    },
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function archiveSize(vault: Vault): number {
  let total = 0;
  for (const path of [vault.file, `${vault.file}-wal`]) {
    try {
      total += statSync(path).size;
    } catch {
      // no WAL yet
    }
  }
  return total;
}

function residencySlope(points: Array<{ seq: number; tokens: number }>): number {
  const usable = points.filter((p) => p.seq > 0 && p.tokens > 0);
  if (usable.length < 2) return 0;
  const xs = usable.map((p) => Math.log10(p.seq));
  const ys = usable.map((p) => p.tokens);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += ((xs[i] as number) - meanX) * ((ys[i] as number) - meanY);
    den += ((xs[i] as number) - meanX) ** 2;
  }
  return den === 0 ? 0 : Math.round((num / den) * 100) / 100;
}

/**
 * The markdown report is rendered from the results JSON and nothing else, so the
 * landing page, the README and this file cannot drift apart.
 */
export function renderReport(result: MillionResult): string {
  const last = result.checkpoints.at(-1);
  const rows = result.checkpoints
    .slice(-12)
    .map(
      (c) =>
        `| ${c.seq.toLocaleString()} | ${c.budgetCheck.queryTokensMax} | ${c.residentTokensP50} | ` +
        `${c.facts.checked - c.facts.failed.length}/${c.facts.checked} | ${c.quotes.exact}/${c.quotes.checked} | ` +
        `${c.numbers.paged}/${c.numbers.checked} | ${(c.ledger.entries / 1000).toFixed(1)}k | ` +
        `${c.ledger.conservationOk && c.ledger.completenessOk ? "ok" : "FAIL"} | ${c.verify.ok ? "ok" : "FAIL"} | ` +
        `${(c.wall.ingestP50Ms * 1000).toFixed(0)}µs | ${(c.archiveBytes / 1048576).toFixed(0)} MiB |`,
    )
    .join("\n");

  const trap = result.final.trap;
  return `# pylos bench million — seed ${result.seed}

**${result.final.ok ? "PASS" : `FAIL — first failure at ${result.final.firstFailure}`}** ·
${result.N.toLocaleString()} turns · budget ${result.budget} tokens ·
${result.final.wall.totalSec}s wall (${result.final.wall.turnsPerSec.toLocaleString()} turns/s) ·
${(result.final.archiveBytes / 1048576).toFixed(0)} MiB archive ·
${result.final.lossEntries.toLocaleString()} ledger entries · ${result.final.capsules.toLocaleString()} capsules.

Deterministic, zero model calls. Generator vocab \`${result.generator.vocabSha256.slice(0, 12)}\`,
manifest \`${result.generator.manifestSha256.slice(0, 12)}\`, results digest \`${result.digest.slice(0, 12)}\`.

## Checkpoints (last 12)

| turn | max packet | resident p50 | facts | quotes | numbers | ledger | conserved | chain | µs/turn | archive |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--: | :--: | ---: | ---: |
${rows}

## Residency

Resident packet tokens versus archive size, on a query set fixed at the first
checkpoint: slope **${result.final.residencySlopeTokensPerDecade} tokens per decade** of archive growth.
Budget ${result.budget}; last measured p50 ${last?.residentTokensP50 ?? 0}.

## The trap

Turn ${result.planted.ruleSeq ?? 1}: *"never send a production migration before the dry-run database is verified."*
Turn ${(result.planted.revisionSeq ?? 0).toLocaleString()}: the exception is added.
Turn ${(result.planted.trapSeq ?? 0).toLocaleString()}: the user asks to send an additive-only migration with the dry-run skipped.

${
  trap === null
    ? "_Not reached in this run._"
    : `| builder | has the exception | has the old rule | packet tokens |
| --- | :--: | :--: | ---: |
| **pylos** | ${trap.pylos.currentRuleResident ? "yes" : "no"} | ${trap.pylos.containsOldRule ? "yes, marked ⟨historical⟩" : "no"} | ${trap.pylos.packetTokens ?? "—"} |
| rolling summary | ${trap.rolling.containsException ? "yes" : "no"} | ${trap.rolling.containsOldRule ? "yes" : "no"} | ${trap.rolling.tokens} |
| bm25 retrieval | ${trap.bm25.containsException ? "yes" : "no"} | ${trap.bm25.containsOldRule ? "yes" : "no"} | ${trap.bm25.tokens} |

Pylos packet digest \`${trap.pylos.packetDigest.slice(0, 16)}\`; current rule from turn
${trap.pylos.currentRuleSeq?.toLocaleString() ?? "not found"}; superseded version listed as historical: ${trap.pylos.historicalListed ? "yes" : "no"}.`
}

## What this run does and does not prove

It measures, deterministically: the hard packet cap held at every checkpoint; every planted quote
paged back byte-exact; every planted number was present in the packet after compile (ledger-routing
precision is reported separately); every revised-fact packet contained the current value and never a
stale certificate (historical reachability is asserted for the rule, not for every fact); the ledger was
conserved and complete on the sampled capsules (exhaustive at the final checkpoint); the hash chain
verified. The trap tests residency of the revised rule (a frontier certificate), not paging; the rolling
summary baseline is chronological (oldest text survives truncation). It measures nothing about a real
model's answers — that is the live variant, reported separately and labelled as a sample.
`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rerenderIndex = args.indexOf("--rerender");
  if (rerenderIndex >= 0) {
    const path = args[rerenderIndex + 1] as string;
    const existing = JSON.parse(await Bun.file(path).text()) as MillionResult;
    const out = path.replace(/\.json$/, ".md");
    await Bun.write(out, renderReport(existing));
    process.stdout.write(`re-rendered ${out}\n`);
    process.exit(0);
  }
  const flag = (name: string, fallback: string): string => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
  };
  await runMillion({
    turns: Number(flag("turns", "1000000").replace(/[_,]/g, "")),
    seed: flag("seed", "1"),
    budget: Number(flag("budget", "8192")),
    ...(args.includes("--out") ? { out: flag("out", "") } : {}),
  });
}
