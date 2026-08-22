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
 *   5. an addressed turn comes back byte-exact — on the millionth turn, the 345th,
 *   6. a memory carrying no routing name at all is still reachable by search,
 *   7. the assistant's own claim never becomes a fact (KERNEL A9.1),
 *   8. the ledger is conserved and complete,
 *   9. the chain verifies,
 *  10. per-turn wall time stays flat.
 *
 * Failures are recorded, not thrown: the run continues and the report says
 * where it first broke.
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  atomize,
  COUNTERS,
  capsuleTokensFor,
  compact,
  compile,
  type EpisodeInput,
  openVault,
  packetText,
  residentLeafCount,
  sourceNamesForRange,
  TOKENS_PER_PAGE,
  type Vault,
  verify,
} from "@pylos/core";
import {
  type Corpus,
  type CorpusManifest,
  createCorpus,
  nameSet,
  type PlantedPerson,
  type PoisonVariant,
  parseNumberName,
  retained,
  stream,
  vocabSha256,
} from "@pylos/core/pure";
import type { Episode, Packet, Role } from "@pylos/protocol";
import corePackage from "../packages/core/package.json";
import { bm25Packet, RollingSummary } from "./baseline.ts";

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

/** "What did I say on turn N?" — KERNEL A9.3. */
export interface SequenceResult {
  checked: number;
  paged: number;
  resident: number;
  failed: number[];
  /** Resolved pages served for these queries under any trigger but `sequence`. */
  falsePages: number;
  maxTokens: number;
  /** The targets forced at the final checkpoint — turn 1 and turn 345 — with their roles. */
  forced: Array<{ seq: number; role: Role }>;
}

/** A memory with no routing name in it — KERNEL A9.4. */
export interface MemoryResult {
  checked: number;
  found: number;
  resident: number;
  failed: number[];
  /** Ledger rows whose locator lands on a memory episode. Must be zero. */
  ledgerRows: number;
  maxTokens: number;
}

/** The authority law — KERNEL A9.1. */
export interface PoisonResult {
  A: { checked: number; passed: number };
  B: { checked: number; passed: number };
  C: { checked: number; passed: number };
  failed: number[];
  proposedAtoms: number;
  maxTokens: number;
}

export interface CheckpointResult {
  seq: number;
  budgetCheck: { ok: boolean; trapTokens: number | null; queryTokensMax: number; queryTokensP50: number };
  facts: { checked: number; resident: number; paged: number; failed: number[] };
  quotes: { checked: number; exact: number; failed: number[] };
  numbers: { checked: number; paged: number; failed: number[] };
  sequence: SequenceResult;
  memories: MemoryResult;
  poison: PoisonResult;
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
  schema: "pylos.bench.million.v2";
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
  const corpus = createCorpus(options.seed, options.turns);
  const manifest = corpus.manifest;
  const rolling = new RollingSummary(options.budget);

  log(
    `pylos bench million · seed ${options.seed} · N ${options.turns.toLocaleString()} · B ${options.budget}\n` +
      `planted: rule #${manifest.ruleSeq} · revision #${manifest.revisionSeq} · trap #${manifest.trapSeq} · ` +
      `${manifest.facts.length} revised facts · ${manifest.quotes.length} quotes · ${manifest.numbers.length} numbers · ` +
      `${manifest.memories.length} name-free memories · ${manifest.persons.length} poisoned people`,
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
    for (const episode of appended) {
      rolling.push(episode);
      // The sequence probe asserts a byte-exact episode in the packet, which is
      // only meaningful while no template is large enough to be excerpted.
      if (episode.tokens > TOKENS_PER_PAGE) fail(`episode-too-long@${episode.seq}`);
    }
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
        `turns ${result.checkpoint.sequence.checked - result.checkpoint.sequence.failed.length}/${result.checkpoint.sequence.checked} · ` +
        `memories ${result.checkpoint.memories.found + result.checkpoint.memories.resident}/${result.checkpoint.memories.checked} · ` +
        `authority ${passedPoison(result.checkpoint.poison)}/${checkedPoison(result.checkpoint.poison)} · ` +
        `ledger ${(result.checkpoint.ledger.entries / 1000).toFixed(1)}k · ` +
        `p50 ${(result.checkpoint.wall.ingestP50Ms * 1000).toFixed(0)}µs`,
    );
  }

  const finished = Date.now();
  const last = checkpoints.at(-1);
  const slope = residencySlope(residencyTrend);
  const capsuleTokens = capsuleTokensFor(options.budget);

  const output: MillionResult = {
    schema: "pylos.bench.million.v2",
    seed: options.seed,
    N: options.turns,
    budget: options.budget,
    generator: {
      version: corePackage.version,
      vocabSha256: vocabSha256(),
      manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    },
    kernel: {
      version: corePackage.version,
      leaf: 32,
      fanout: 8,
      capsuleTokens: { ...capsuleTokens, residentLeaves: residentLeafCount(options.budget) },
    },
    planted: {
      facts: manifest.facts.length,
      quotes: manifest.quotes.length,
      numbers: manifest.numbers.length,
      memories: manifest.memories.length,
      persons: manifest.persons.length,
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
  manifest: CorpusManifest;
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
    // The planted unit is part of the name (KERNEL A9.2): `48250 usd` is not a
    // witness for `48250 eur`, and a certificate's own ⟨#48250⟩ is not a witness
    // for anything.
    const unit = parseNumberName(number.name)?.unit ?? "";
    if (retained(text, number.value, unit) && text.includes(number.valueText)) numbersResult.paged += 1;
    else numbersResult.failed.push(number.seq);
  }
  if (numbersResult.failed.length > 0) fail(`numbers@${seq}`);

  // ---- 4b. the sequence route: a turn addressed by position comes back exactly
  const sequenceResult: SequenceResult = {
    checked: 0,
    paged: 0,
    resident: 0,
    failed: [],
    falsePages: 0,
    maxTokens: 0,
    forced: [],
  };
  for (const target of sequenceTargets(manifest.seed, seq, input.corpus, isFinal)) {
    const packet = packetFor(`What did I say on turn ${target}?`);
    tokens.push(packet.tokens);
    if (packet.tokens > budget) budgetOk = false;
    sequenceResult.checked += 1;
    sequenceResult.maxTokens = Math.max(sequenceResult.maxTokens, packet.tokens);
    sequenceResult.falsePages += packet.pages.filter((p) => p.resolved && p.trigger !== "sequence").length;
    const text = packetText(packet.messages);
    const exact = text.includes(input.corpus.episodeAt(target).content);
    const paged = packet.pages.some((p) => p.trigger === "sequence" && p.resolved && p.seqs.includes(target));
    const resident = packet.resident.some((r) => r.type === "recent" && r.seq === target);
    if (exact && paged) sequenceResult.paged += 1;
    else if (exact && resident) sequenceResult.resident += 1;
    else sequenceResult.failed.push(target);
  }
  if (isFinal) {
    for (const target of forcedTargets(seq)) {
      sequenceResult.forced.push({ seq: target, role: input.corpus.episodeAt(target).role });
    }
  }
  if (sequenceResult.failed.length > 0) fail(`sequence@${seq}`);

  // ---- 4c. name-free memories: no entity, no number, no quote, nothing the
  // ledger can see. Only the lexical route can find them, and the question
  // shares four content words with the sentence and withholds the fifth.
  const memoryResult: MemoryResult = {
    checked: 0,
    found: 0,
    resident: 0,
    failed: [],
    ledgerRows: 0,
    maxTokens: 0,
  };
  for (const memory of sample(planted.memories, isFinal ? planted.memories.length : 8)) {
    const packet = packetFor(memory.query);
    tokens.push(packet.tokens);
    if (packet.tokens > budget) budgetOk = false;
    memoryResult.checked += 1;
    memoryResult.maxTokens = Math.max(memoryResult.maxTokens, packet.tokens);
    memoryResult.ledgerRows += vault.losses.countInRange(threadId, memory.seq, memory.seq + 1);
    const text = packetText(packet.messages);
    const found = text.includes(memory.text);
    const searched = packet.pages.some(
      (p) => p.trigger === "search" && p.resolved && p.seqs.includes(memory.seq),
    );
    const resident = packet.resident.some((r) => r.type === "recent" && r.seq === memory.seq);
    if (found && searched) memoryResult.found += 1;
    else if (found && resident) memoryResult.resident += 1;
    else memoryResult.failed.push(memory.seq);
  }
  if (memoryResult.failed.length > 0) fail(`memories@${seq}`);
  if (memoryResult.ledgerRows > 0) fail(`memory-ledger@${seq}`);

  // ---- 4d. the authority law: the assistant proposes, it does not authorize
  const poisonResult: PoisonResult = {
    A: { checked: 0, passed: 0 },
    B: { checked: 0, passed: 0 },
    C: { checked: 0, passed: 0 },
    failed: [],
    proposedAtoms: vault.counter(threadId, COUNTERS.atomsProposed),
    maxTokens: 0,
  };
  for (const person of poisonSample(planted.persons, isFinal ? Number.MAX_SAFE_INTEGER : 4, sample)) {
    const packet = packetFor(person.query);
    tokens.push(packet.tokens);
    if (packet.tokens > budget) budgetOk = false;
    poisonResult.maxTokens = Math.max(poisonResult.maxTokens, packet.tokens);
    const arm = poisonResult[person.variant];
    arm.checked += 1;
    if (authorityHolds(packetText(packet.messages), packet, person)) arm.passed += 1;
    else poisonResult.failed.push(person.id);
  }
  if (poisonResult.failed.length > 0) fail(`poison@${seq}`);

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
      sequence: sequenceResult,
      memories: memoryResult,
      poison: poisonResult,
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

/**
 * Hard-wrap a paragraph at 100 columns. The numbers interpolated into the report
 * change width with the run, so the prose is wrapped after they are filled in
 * rather than laid out by hand around them.
 */
function wrap(paragraph: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of paragraph.split(/\s+/).filter((w) => w.length > 0)) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= 100) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join("\n");
}

function checkedPoison(poison: PoisonResult): number {
  return poison.A.checked + poison.B.checked + poison.C.checked;
}

function passedPoison(poison: PoisonResult): number {
  return poison.A.passed + poison.B.passed + poison.C.passed;
}

/** Sequence probes per checkpoint. */
const SEQUENCE_PROBES = 100;
/**
 * The two turns the headline is about: the first turn of the thread, and the
 * 345th. At the final checkpoint they are asked for by name — on the millionth
 * turn, recall the 345th — instead of being left to the draw.
 */
const FORCED_SEQS = [1, 345];

function forcedTargets(checkpointSeq: number): number[] {
  return FORCED_SEQS.filter((s) => s <= checkpointSeq - 2);
}

/**
 * 100 turn numbers per checkpoint, from a stream of their own so the plants
 * above are untouched, each advanced to the next user turn: the question is
 * "what did *I* say".
 */
function sequenceTargets(seed: string, checkpointSeq: number, corpus: Corpus, isFinal: boolean): number[] {
  const rng = stream(seed, "probe", 0);
  const targets: number[] = [];
  for (let i = 0; i < SEQUENCE_PROBES; i += 1) {
    let target = rng.int(1, Math.max(1, checkpointSeq - 2));
    for (let step = 0; step < 4 && target < checkpointSeq && corpus.episodeAt(target).role !== "user"; ) {
      target += 1;
      step += 1;
    }
    targets.push(target);
  }
  if (isFinal) {
    const forced = forcedTargets(checkpointSeq);
    for (let i = 0; i < forced.length; i += 1) targets[i] = forced[i] as number;
  }
  return targets;
}

/**
 * A step sample over the person list would keep hitting the same `i mod 4`, so
 * the three variants are sampled separately.
 */
function poisonSample(
  persons: readonly PlantedPerson[],
  perVariant: number,
  sample: <T>(items: T[], n: number) => T[],
): PlantedPerson[] {
  const out: PlantedPerson[] = [];
  for (const variant of ["A", "B", "C"] as PoisonVariant[]) {
    out.push(
      ...sample(
        persons.filter((p) => p.variant === variant),
        perVariant,
      ),
    );
  }
  return out;
}

/**
 * The authority law, read off the packet (KERNEL A9.1).
 *
 * The checks are scoped to the person's own key: a packet a million turns deep
 * carries other people's certificates, and an unscoped "the string `= Palermo`
 * is absent" would be a statement about them, not about this law.
 */
function authorityHolds(text: string, packet: Packet, person: PlantedPerson): boolean {
  const key = person.key;
  const historical = packet.ledger.historical.filter((h) => h.key === key);
  // A closed proposal is history, but it was never true: it can never be the
  // "was" of a ⟦changed⟧ line, and it can never be the current value.
  const digestClean = historical.every((h) => h.previous !== person.value2 && h.current !== person.value2);
  if (person.variant === "B") {
    // Nobody but the assistant ever said it: a proposal, marked as one, and no
    // certificate anywhere.
    return (
      digestClean &&
      text.includes(`${key} ≈ ${person.value2} ⟨proposed by assistant #${person.claimSeq}`) &&
      !text.includes(`${key} = `)
    );
  }
  if (person.variant === "A") {
    // The user said it once; the assistant later said something else. The user's
    // value still holds the slot, with its original pointer.
    return (
      digestClean &&
      text.includes(`${key} = ${person.value1} ⟨#${person.statedSeq}⟩`) &&
      !text.includes(`${key} = ${person.value2}`)
    );
  }
  // The user corrected it: the correction is the certificate, the proposal is
  // closed and no longer shown, and the value it replaced is the user's, not the
  // assistant's.
  return (
    digestClean &&
    text.includes(`${key} = ${person.value3} ⟨#${person.correctedSeq}⟩`) &&
    !text.includes(`${key} ≈ `)
  );
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

function sequenceSection(result: MillionResult): string {
  const last = result.checkpoints.at(-1);
  if (last === undefined) return "_Not reached in this run._";
  const total = result.checkpoints.reduce((sum, c) => sum + c.sequence.checked, 0);
  const failed = result.checkpoints.reduce((sum, c) => sum + c.sequence.failed.length, 0);
  const falsePages = result.checkpoints.reduce((sum, c) => sum + c.sequence.falsePages, 0);
  const forced = last.sequence.forced.map((f) => `turn ${f.seq.toLocaleString()} (${f.role})`).join(" and ");
  return [
    wrap(
      `At every checkpoint, ${SEQUENCE_PROBES} turn numbers are drawn and asked for by position — ` +
        `*"What did I say on turn N?"*. A probe passes only if the packet contains that episode's text ` +
        "byte-exact and the packet's own page record says `sequence`, resolved, for that turn.",
    ),
    "",
    wrap(
      `**${(total - failed).toLocaleString()}/${total.toLocaleString()}** across the run; at the last ` +
        `checkpoint ${last.sequence.paged.toLocaleString()} were paged and ` +
        `${last.sequence.resident.toLocaleString()} were already resident; largest packet ` +
        `${last.sequence.maxTokens} of ${result.budget} tokens; ${falsePages.toLocaleString()} resolved ` +
        `page${falsePages === 1 ? "" : "s"} under any other trigger on these queries.` +
        (forced.length === 0
          ? ""
          : ` At the last checkpoint the draw is replaced for two of them: ${forced} — on the ` +
            `${result.N.toLocaleString()}th turn, the archive answers for the 345th.`),
    ),
  ].join("\n");
}

function memorySection(result: MillionResult): string {
  const last = result.checkpoints.at(-1);
  if (last === undefined || last.memories.checked === 0) return "_Not reached in this run._";
  const m = last.memories;
  return [
    wrap(
      `${(result.planted.memories ?? 0).toLocaleString()} memories are planted with no routing name in ` +
        "them at all: `the <noun> <verb>ed <adj> <prep> the <noun>.` — all lowercase, no number, no " +
        "quote, no identifier, from a vocabulary disjoint from the rest of the corpus. `names()` is " +
        `empty for every one of them, and they produced **${m.ledgerRows} ledger rows**. The question ` +
        'withholds the adjective: *"how did the <noun> <verb> <prep> the <noun>?"*.',
    ),
    "",
    wrap(
      `**${(m.found + m.resident).toLocaleString()}/${m.checked.toLocaleString()}** recovered at the ` +
        `last checkpoint — ${m.found.toLocaleString()} by lexical search, ` +
        `${m.resident.toLocaleString()} still resident; largest packet ${m.maxTokens} of ` +
        `${result.budget} tokens.`,
    ),
    "",
    // One line, unwrapped: this sentence is the claim boundary for the probe and
    // must stay quotable byte-for-byte.
    "Proves that a deterministic stemmed lexical search returns the exact episode when the question shares four content words with it and no name route resolved; proves nothing about paraphrase, about questions that also name something the ledger knows, or about precision on real conversation; these losses were invisible to the ledger by construction.",
  ].join("\n");
}

function poisonSection(result: MillionResult): string {
  const last = result.checkpoints.at(-1);
  if (last === undefined || checkedPoison(last.poison) === 0) return "_Not reached in this run._";
  const p = last.poison;
  return [
    wrap(
      `${(result.planted.persons ?? 0).toLocaleString()} people are talked about twice: the assistant ` +
        "restates where one lives, wrongly, in its own turn. **A** — the user said it first: the user's " +
        "value must still hold the slot. **B** — only the assistant ever said it: it may appear, but as " +
        "`≈ … ⟨proposed by assistant⟩`, never as a certificate. **C** — the user corrects it afterwards: " +
        "the correction is the certificate, the proposal is closed, and the value it replaced is the " +
        "user's, never the assistant's. In all three the assistant's value is never listed as a previous " +
        "value in `⟦changed⟧`. The checks are scoped to each person's own atom key.",
    ),
    "",
    "| variant | what happened | passed |",
    "| --- | --- | ---: |",
    `| A | user states it, assistant later restates it wrongly | ${p.A.passed}/${p.A.checked} |`,
    `| B | only the assistant ever claimed it | ${p.B.passed}/${p.B.checked} |`,
    `| C | user states it, assistant restates it wrongly, user corrects it | ${p.C.passed}/${p.C.checked} |`,
    "",
    wrap(
      `${p.proposedAtoms.toLocaleString()} atoms stood \`PROPOSED\` at this checkpoint; largest packet ` +
        `${p.maxTokens} of ${result.budget} tokens.`,
    ),
  ].join("\n");
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
        `${c.numbers.paged}/${c.numbers.checked} | ` +
        `${c.sequence.checked - c.sequence.failed.length}/${c.sequence.checked} | ` +
        `${c.memories.found + c.memories.resident}/${c.memories.checked} | ` +
        `${passedPoison(c.poison)}/${checkedPoison(c.poison)} | ${(c.ledger.entries / 1000).toFixed(1)}k | ` +
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

| turn | max packet | resident p50 | facts | quotes | numbers | turns | memories | authority | ledger | conserved | chain | µs/turn | archive |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--: | :--: | ---: | ---: |
${rows}

## Addressing a turn by its number

${sequenceSection(result)}

## Memories the ledger cannot see

${memorySection(result)}

## Authority: the assistant proposes, it does not authorize

${poisonSection(result)}

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
paged back byte-exact; every planted number was present in the packet after compile with its unit
(ledger-routing precision is reported separately); every revised-fact packet contained the current value
and never a stale certificate (historical reachability is asserted for the rule, not for every fact);
every turn asked for by number came back byte-exact under a \`sequence\` page record; every name-free
memory came back under a \`search\` record, from an archive where the ledger held nothing about it; the
authority law held for all three poison variants; the ledger was conserved and complete on the sampled
capsules (exhaustive at the final checkpoint); the hash chain verified. The trap tests residency of the
revised rule (a frontier certificate), not paging; the rolling summary baseline is chronological (oldest
text survives truncation). The authority checks are scoped to each person's own atom key. It measures
nothing about a real model's answers — that is the live variant, reported separately and labelled as a
sample.
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
