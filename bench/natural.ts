/**
 * Deterministic natural-question measurement gate (THEORY §15.13, KERNEL A15).
 *
 * This bench deliberately makes no provider or model call. It measures the
 * kernel's address, receipt, and claim-gate behaviour against small fixtures.
 * Semantic search is measured only when the configured compiler returns a
 * ready, artifact-bound receipt; unavailable and incomplete receipts are never
 * counted as hits. Every probe appends its asking turn before compiling and
 * binds its observations to source hashes and the resulting packet/receipt
 * digests.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  atomize,
  type CompileOptions,
  canonicalHash,
  compact,
  compile,
  coverageFor,
  forget,
  gateAnswer,
  issueEvidenceCapabilities,
  openVault,
  packetText,
  sha256,
  type Vault,
} from "@pylos/core";
import type {
  AnswerReceipt,
  CoverageReceipt,
  Epistemic,
  EvidenceLocator,
  Packet,
  SemanticReceipt,
  Seq,
} from "@pylos/protocol";
import { PYLOS_VERSION } from "@pylos/protocol";

const SCHEMA = "pylos.bench.natural.v1" as const;
const SEED = "natural-questions-2026-08-23" as const;
const BUDGET = 2_048;
const FILLER_TURNS = 256;
const BASE_TS = 1_756_000_000_000;
const RESULT_PATH = join(import.meta.dir, "results", "natural.json");

type SourceSpec = { label: string; content: string };

type GateMode = "omitted" | "supported" | "world" | "reasoning";
type Polarity = "positive" | "negative";

interface Fixture {
  id: string;
  family: string;
  polarity: Polarity;
  pairKey?: string;
  expectation: string;
  question: string;
  sources: SourceSpec[];
  atomizeSources?: boolean;
  removeSourceIndexes?: number[];
  gate?: GateMode;
  targetIndexes?: number[];
  collection?: { required?: number; completeness: CoverageReceipt["completeness"] };
}

interface SourceBinding {
  label: string;
  seq: Seq;
  contentHash: string;
  /** Episode revision (the chain hash), distinct from the whole-source hash. */
  revision: string;
  byteLength: number;
  removed: boolean;
}

interface SemanticObservation {
  status: SemanticReceipt["status"] | "missing";
  hit: boolean;
  resolvedSeqs: Seq[];
  witnesses: Array<{ seq: Seq; epistemic: Epistemic | "missing" }>;
  addressOnly: boolean;
  receiptDigest?: string;
  reason?: string;
}

interface GateObservation {
  status: AnswerReceipt["status"];
  digest: string;
  receiptDigest: string;
  answerDigest: string;
  scanDigest: string;
  packetDigest: string;
  roundsDigest: string;
  grammarVersion: string;
  coverageDigest?: string;
  coverageRouterVersion?: string;
  coverageRoutesRun?: AnswerReceipt["coverageRoutesRun"];
  classifications: AnswerReceipt["classifications"];
  qualifications: string[];
  candidates: AnswerReceipt["candidates"];
  candidateCount: number;
}

interface ProbeResult {
  id: string;
  family: string;
  expectation: string;
  askingTurnIndexed: true;
  question: string;
  querySeq: Seq;
  sources: SourceBinding[];
  packet: {
    id: string;
    digest: string;
    tokens: number;
    budget: number;
    pageCount: number;
    resolvedPageCount: number;
    pageTriggers: string[];
    pageSeqs: Seq[];
    reachabilityPresent: boolean;
    coverageDigest?: string;
    semanticDigest?: string;
  };
  coverage?: CoverageReceipt;
  semantic: SemanticObservation;
  gate?: GateObservation;
  receipts: {
    packetDigest: string;
    coverageDigest?: string;
    semanticReceiptDigest?: string;
    answerReceiptDigest?: string;
    answerPacketDigest?: string;
    answerDigest?: string;
    answerScanDigest?: string;
    answerRoundsDigest?: string;
    answerCoverageDigest?: string;
    answerCoverageRouterVersion?: string;
    answerCoverageRoutesRun?: AnswerReceipt["coverageRoutesRun"];
  };
  metrics: {
    sourceRoutes: number;
    sourceResident: number;
    resolvedPages: number;
    falsePages: number;
    unresolvedReceipt: boolean;
    qualificationError: boolean;
    releaseError: boolean;
    latencyMs: number;
    selfHitExcluded: boolean;
    modelCalls: 0;
    providerCostUsd: 0;
  };
  oracle: { ok: boolean; violations: string[] };
}

export interface NaturalResult {
  schema: typeof SCHEMA;
  seed: typeof SEED;
  currentVersion: string;
  budget: number;
  startedAt: string;
  finishedAt: string;
  modelEfficacy: { status: "not-run"; modelCalls: 0; reason: string };
  mechanisms: MechanismClaim[];
  familyCoverage: FamilyCoverage[];
  infrastructureFailures: InfrastructureFailure[];
  metrics: {
    attempted: number;
    probes: number;
    routeHits: number;
    routeMisses: number;
    semanticHits: number;
    unresolvedReceipts: { count: number; denominator: number };
    falsePages: { count: number; denominator: number };
    qualificationErrors: { count: number; denominator: number };
    releaseErrors: { count: number; denominator: number };
    infrastructureFailures: { count: number; denominator: number };
    semanticUnavailableReceipts: { count: number; denominator: number };
    coverageReceipts: number;
    gateReceipts: number;
    gateQualifications: number;
    latencyMs: {
      denominator: number;
      total: number;
      p50: number;
      p95: number;
      p99: number;
      max: number;
    };
    provider: { modelCalls: 0; costUsd: 0; denominator: number };
    oracleViolations: number;
  };
  cases: ProbeResult[];
  ok: boolean;
  violations: string[];
  digest: string;
}

export interface NaturalRunOptions {
  outputPath?: string;
  markdownPath?: string;
}

interface RetainedNaturalFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface NaturalRepeatabilityEnvelope {
  schema: "pylos.bench.natural-repeatability.v1";
  runs: Array<{ digest: string; artifact: RetainedNaturalFile }>;
  stableDigest: string;
  stableDigestEqual: boolean;
}

interface MechanismClaim {
  mechanism: string;
  claim: string;
  denominator: number;
  observed: number;
  implemented: boolean;
  tested: boolean;
  bench: string;
  notClaimed: string;
}

interface FamilyCoverage {
  family: string;
  denominator: number;
  positive: number;
  negative: number;
  matchedPairs: number;
  note: string;
}

interface InfrastructureFailure {
  id: string;
  family: string;
  message: string;
}

const FIXTURES: readonly Fixture[] = [
  {
    id: "self-hit",
    family: "self-hit",
    polarity: "positive",
    expectation: "exact source route; asking turn cannot satisfy itself",
    question: "What happened to the kiln when the flue was blocked?",
    sources: [
      {
        label: "kiln",
        content: "The kiln at Sagres fired unevenly because the flue was blocked.",
      },
    ],
    targetIndexes: [0],
  },
  {
    id: "noun-free-paraphrase",
    family: "noun-free-paraphrase",
    polarity: "positive",
    expectation: "semantic address if available; otherwise an explicit unavailable receipt",
    question: "What flavor followed the storm?",
    sources: [{ label: "tea", content: "The tea tasted smoky after the rain." }],
    targetIndexes: [0],
  },
  {
    id: "negation",
    family: "negation",
    polarity: "positive",
    expectation: "a positive route must preserve the source polarity",
    question: "Should the launch proceed before Cedar Review?",
    sources: [
      {
        label: "launch-rule",
        content: "The launch must not proceed before Cedar Review.",
      },
    ],
    targetIndexes: [0],
  },
  {
    id: "pronoun-ambiguity",
    family: "pronoun-ambiguity",
    polarity: "negative",
    expectation: "a bounded exact candidate receipt without claiming that the pronoun ambiguity was resolved",
    question: "What did she say about it?",
    sources: [
      { label: "mira-nova", content: "Mira briefed Nova about the harbor gate." },
      { label: "she-gate", content: "She said the gate opens at dawn." },
    ],
    targetIndexes: [0, 1],
  },
  {
    id: "multilingual-refer-back",
    family: "multilingual-refer-back",
    polarity: "positive",
    expectation:
      "an exact semantic address if found; a miss or false page remains receipted and address-only",
    question: "What stayed closed after the storm?",
    sources: [
      {
        label: "compuerta",
        content: "La compuerta quedó cerrada después de la tormenta.",
      },
    ],
    targetIndexes: [0],
  },
  {
    id: "deleted-source",
    family: "deleted-source",
    polarity: "negative",
    expectation: "removed bytes are not routable; any fallback stays exact, bounded, and address-only",
    question: "What is the retired deployment token?",
    sources: [
      {
        label: "retired-token",
        content: "The retired deployment token is Zephyrine 998877.",
      },
    ],
    removeSourceIndexes: [0],
    targetIndexes: [0],
  },
  {
    id: "supersession",
    family: "superseded-source",
    polarity: "positive",
    expectation: "an old semantic address is historical or absent; current resolution is not assumed",
    question: "Where do I live now?",
    sources: [
      { label: "old-location", content: "I live in Lisbon." },
      { label: "current-location", content: "Correction: I moved to Porto." },
    ],
    atomizeSources: true,
    targetIndexes: [1],
  },
  {
    id: "partial-known-cardinality",
    family: "partial-collection",
    polarity: "positive",
    pairKey: "partial-collection-cardinality",
    expectation: "known cardinality is a lower bound, never an inferred total",
    question: "List every 3 rollout owners.",
    sources: [
      { label: "owner-alpha", content: "Rollout owner Alpha approved the harbor plan." },
      { label: "owner-beta", content: "Rollout owner Beta approved the harbor plan." },
    ],
    targetIndexes: [0, 1],
    collection: { required: 3, completeness: "incomplete" },
  },
  {
    id: "partial-unknown-cardinality",
    family: "partial-collection",
    polarity: "negative",
    pairKey: "partial-collection-cardinality",
    expectation: "unknown cardinality says completeness is not established",
    question: "List every rollout owner.",
    sources: [
      { label: "owner-alpha", content: "Rollout owner Alpha approved the harbor plan." },
      { label: "owner-beta", content: "Rollout owner Beta approved the harbor plan." },
    ],
    targetIndexes: [0, 1],
    collection: { completeness: "not-established" },
  },
  {
    id: "claim-map-omission",
    family: "claim-map-omission",
    polarity: "negative",
    pairKey: "claim-map",
    expectation: "an omitted capability map cannot release a remembered number",
    question: "What is the vault pin?",
    sources: [{ label: "vault-pin", content: "The vault pin is 314159." }],
    gate: "omitted",
    targetIndexes: [0],
  },
  {
    id: "claim-map-supported",
    family: "claim-map-omission",
    polarity: "positive",
    pairKey: "claim-map",
    expectation: "the same number releases only with a current exact capability",
    question: "What is the vault pin?",
    sources: [{ label: "vault-pin", content: "The vault pin is 314159." }],
    gate: "supported",
    targetIndexes: [0],
  },
  {
    id: "world-control",
    family: "world-control",
    polarity: "positive",
    expectation: "world knowledge is classified separately from archive UNKNOWN",
    question: "What is the capital of France?",
    sources: [],
    gate: "world",
  },
  {
    id: "reasoning-control",
    family: "reasoning-control",
    polarity: "negative",
    expectation: "reasoning and creative prose remain outside the remembered-fact gate",
    question: "Explain why a bounded context needs a receipt.",
    sources: [],
    gate: "reasoning",
  },
] as const;

interface SourceHashes {
  contentHash: string;
  revision: string;
}

function sourceHashes(vault: Vault, threadId: string, seq: Seq): SourceHashes {
  const row = vault.db
    .query("SELECT content_hash, hash FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, seq) as { content_hash: string; hash: string } | null;
  if (row === null) throw new Error(`missing content hash for episode #${seq}`);
  return { contentHash: row.content_hash, revision: row.hash };
}

function seedFiller(vault: Vault, threadId: string, startTs: number): void {
  const inputs = Array.from({ length: FILLER_TURNS }, (_, index) => ({
    role: "user" as const,
    content: `Bench filler ${index + 1}: deterministic archive context remains available for measurement.`,
    ts: startTs + index,
  }));
  vault.episodes.appendMany(threadId, inputs);
}

function pageSeqs(packet: Packet): Seq[] {
  return [...new Set(packet.pages.flatMap((page) => page.seqs))].sort((a, b) => a - b);
}

function semanticObservation(
  packet: Packet,
  targets: readonly Seq[],
  addressOnly: boolean,
): SemanticObservation {
  const semanticPages = packet.pages.filter(
    (page) => page.trigger === "semantic" || page.trigger === "semantic-unavailable",
  );
  const resolvedSemanticPages = semanticPages.filter((page) => page.resolved);
  const resolvedSeqs = [...new Set(resolvedSemanticPages.flatMap((page) => page.seqs))].sort((a, b) => a - b);
  const configured = packet.semantic ?? semanticPages.find((page) => page.semantic)?.semantic;
  const witnesses: SemanticObservation["witnesses"] = resolvedSeqs.map((seq) => ({
    seq,
    epistemic:
      packet.resident.find((item) => item.type === "paged" && item.seq === seq)?.epistemic ?? "missing",
  }));
  if (configured === undefined) {
    return { status: "missing", hit: false, resolvedSeqs, witnesses, addressOnly };
  }
  const status = configured.status;
  const hit =
    status === "ready" &&
    resolvedSemanticPages.length > 0 &&
    resolvedSeqs.length > 0 &&
    resolvedSeqs.every((seq) => targets.includes(seq));
  return {
    status,
    hit,
    resolvedSeqs,
    witnesses,
    addressOnly,
    receiptDigest: canonicalHash(configured),
    ...(configured.reason === undefined ? {} : { reason: configured.reason }),
  };
}

function packetSemanticReceipt(packet: Packet): SemanticReceipt | undefined {
  return packet.semantic ?? packet.pages.find((page) => page.semantic !== undefined)?.semantic;
}

function gateObservation(
  mode: GateMode,
  question: string,
  packet: Packet,
  source: SourceBinding | undefined,
  sourceText: string | undefined,
  coverage: CoverageReceipt | undefined,
): GateObservation {
  const drafts: Record<GateMode, string> = {
    omitted: "The vault pin is 271828.",
    supported: "The vault pin is 314159.",
    world: "Paris.",
    reasoning: "Because a receipt exposes what the route returned, reasoning can stay honest.",
  };
  const draft = drafts[mode];
  const roundsDigest = sha256(`natural-bench-round:${mode}`);
  const sourceBytes = sourceText === undefined ? undefined : new TextEncoder().encode(sourceText);
  const issued =
    (mode === "omitted" || mode === "supported") && source !== undefined && sourceBytes !== undefined
      ? issueEvidenceCapabilities({
          threadId: packet.threadId,
          turnSeq: packet.turnSeq,
          roundOrdinal: 0,
          messagesDigest: packet.digest,
          packetDigest: packet.digest,
          sources: [
            {
              seq: source.seq,
              byteRange: [0, sourceBytes.byteLength],
              sourceDigest: source.contentHash,
              spanDigest: sha256(sourceBytes),
              revision: source.revision,
              authority: "user",
              text: sourceText as string,
            },
          ],
        })
      : [];
  const capabilities = new Map(issued.map((entry) => [entry.capability.token, entry]));
  const claimMap =
    mode === "supported" && issued[0] !== undefined
      ? [
          {
            outputSpan: [0, draft.length] as [number, number],
            capabilityTokens: [issued[0].capability.token],
          },
        ]
      : [];
  const result = gateAnswer({
    question,
    draft,
    packetDigest: packet.digest,
    roundsDigest,
    ...(coverage === undefined ? {} : { coverage }),
    claimMap,
    capabilities,
    revalidate: (entry) => ({
      valid:
        entry.capability.turnSeq === packet.turnSeq &&
        entry.capability.seq === source?.seq &&
        entry.capability.byteRange[1] === source?.byteLength &&
        entry.capability.sourceDigest === source?.contentHash &&
        entry.capability.revision === source?.revision,
      classification: "current",
      text: entry.source.text,
      ...(entry.capability.seq === undefined || entry.capability.revision === undefined
        ? {}
        : {
            source: {
              source: `episode:${entry.capability.seq}`,
              from: entry.capability.byteRange[0],
              to: entry.capability.byteRange[1],
              hash: entry.capability.sourceDigest,
              seq: entry.capability.seq,
              revision: entry.capability.revision,
              spanHash:
                entry.capability.spanDigest ??
                sha256(
                  new TextEncoder()
                    .encode(entry.source.text)
                    .slice(entry.capability.byteRange[0], entry.capability.byteRange[1]),
                ),
              authority: entry.capability.authority,
              ...(entry.capability.manifestId === undefined
                ? {}
                : { manifestId: entry.capability.manifestId }),
            } satisfies EvidenceLocator,
          }),
    }),
  });
  return {
    status: result.receipt.status,
    digest: result.receipt.digest,
    receiptDigest: result.receipt.digest,
    answerDigest: result.receipt.answerDigest,
    scanDigest: result.receipt.scanDigest,
    packetDigest: result.receipt.packetDigest,
    roundsDigest: result.receipt.roundsDigest,
    grammarVersion: result.receipt.grammarVersion,
    ...(result.receipt.coverageDigest === undefined ? {} : { coverageDigest: result.receipt.coverageDigest }),
    ...(result.receipt.coverageRouterVersion === undefined
      ? {}
      : { coverageRouterVersion: result.receipt.coverageRouterVersion }),
    ...(result.receipt.coverageRoutesRun === undefined
      ? {}
      : { coverageRoutesRun: result.receipt.coverageRoutesRun }),
    classifications: result.receipt.classifications,
    qualifications: result.receipt.qualifications,
    candidates: result.receipt.candidates,
    candidateCount: result.receipt.candidates.length,
  };
}

function asCoverage(receipt: CoverageReceipt | undefined): ProbeResult["coverage"] {
  return receipt;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function evidenceLocatorShape(locator: EvidenceLocator | undefined): boolean {
  return (
    locator !== undefined &&
    locator.source.length > 0 &&
    Number.isSafeInteger(locator.from) &&
    Number.isSafeInteger(locator.to) &&
    locator.from >= 0 &&
    locator.to >= locator.from &&
    isSha256(locator.hash) &&
    Number.isSafeInteger(locator.seq) &&
    locator.seq > 0 &&
    locator.revision.length > 0 &&
    isSha256(locator.spanHash) &&
    ["user", "tool", "attachment", "assistant", "model"].includes(locator.authority)
  );
}

function includesOriginalText(packet: Packet, sourceText: string): boolean {
  return packetText(packet.messages).includes(sourceText);
}

function hasKernelUnresolvedReceipt(packet: Packet): boolean {
  return (
    packet.pages.some((page) => !page.resolved) ||
    packetSemanticReceipt(packet)?.status === "unavailable" ||
    packetSemanticReceipt(packet)?.status === "incomplete" ||
    packetSemanticReceipt(packet)?.status === "incompatible"
  );
}

function falsePageCount(
  fixture: Fixture,
  packet: Packet,
  targets: readonly Seq[],
  allSourceSeqs: readonly Seq[],
  removedSeqs: readonly Seq[],
): number {
  const oldSeq = fixture.family === "superseded-source" ? allSourceSeqs[0] : undefined;
  return packet.pages.filter((page) => {
    if (!page.resolved) return false;
    if (page.seqs.includes(packet.turnSeq)) return true;
    if (page.seqs.some((seq) => removedSeqs.includes(seq))) return true;
    if (
      oldSeq !== undefined &&
      page.seqs.includes(oldSeq) &&
      !packet.resident.some(
        (item) => item.type === "paged" && item.seq === oldSeq && item.epistemic === "HISTORICAL",
      )
    )
      return true;
    if (targets.length === 0) return true;
    return !page.seqs.some((seq) => targets.includes(seq));
  }).length;
}

function gateErrors(
  mode: GateMode | undefined,
  gate: GateObservation | undefined,
): { qualificationError: boolean; releaseError: boolean } {
  if (mode === undefined) return { qualificationError: false, releaseError: false };
  if (gate === undefined) return { qualificationError: true, releaseError: mode !== "omitted" };
  if (mode === "omitted") {
    return {
      qualificationError: gate.status !== "qualified" || gate.qualifications.length === 0,
      releaseError: false,
    };
  }
  return {
    qualificationError: gate.status !== "released" || gate.qualifications.length > 0,
    releaseError: gate.status !== "released",
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return Number((sorted[index] as number).toFixed(3));
}

function runProbe(fixture: Fixture, home: string): ProbeResult {
  const startedAt = performance.now();
  const vault = openVault({ home, fast: true });
  // The id seeds the hash chain and prints in packet headers; naming it from the
  // fixture keeps every digest a function of the fixture alone.
  const thread = vault.threads.create(
    `natural-${fixture.id}`,
    { budget: BUDGET },
    { id: `th_natural_${fixture.id}`, createdAt: BASE_TS },
  );
  const sourceEpisodes = fixture.sources.map((source, index) =>
    vault.episodes.append(thread.id, {
      role: "user",
      content: source.content,
      ts: BASE_TS + index,
    }),
  );
  const bindings: SourceBinding[] = sourceEpisodes.map((episode, index) => ({
    label: fixture.sources[index]?.label ?? `source-${index}`,
    seq: episode.seq,
    ...sourceHashes(vault, thread.id, episode.seq),
    byteLength: new TextEncoder().encode(episode.content).byteLength,
    removed: false,
  }));
  if (fixture.atomizeSources === true)
    atomize(
      vault,
      thread.id,
      sourceEpisodes.map((episode) => episode.seq),
    );
  seedFiller(vault, thread.id, BASE_TS + 10_000);
  compact(vault, thread.id, { budget: BUDGET });
  const removed = new Set(fixture.removeSourceIndexes ?? []);
  if (removed.size > 0) {
    forget(vault, thread.id, {
      seqs: [...removed]
        .map((index) => sourceEpisodes[index]?.seq)
        .filter((seq): seq is Seq => seq !== undefined),
      reason: `natural bench fixture ${fixture.id}`,
    });
    for (const index of removed) {
      const binding = bindings[index];
      if (binding !== undefined) binding.removed = true;
    }
  }
  const asking = vault.episodes.append(thread.id, {
    role: "user",
    content: fixture.question,
    ts: BASE_TS + 20_000,
  });
  const compileOptions = {
    query: fixture.question,
    turnSeq: asking.seq,
    budget: BUDGET,
    model: "natural-bench",
    supportsTools: true,
    semantic: true,
  } as CompileOptions & { semantic: true };
  const durableAuthorityBefore = vault.db
    .query(
      "SELECT " +
        "(SELECT COUNT(*) FROM atom WHERE thread_id = ?) AS atoms, " +
        "(SELECT COUNT(*) FROM address_route WHERE thread_id = ?) AS routes",
    )
    .get(thread.id, thread.id) as { atoms: number; routes: number };
  const packet = compile(vault, thread.id, compileOptions);
  const durableAuthorityAfter = vault.db
    .query(
      "SELECT " +
        "(SELECT COUNT(*) FROM atom WHERE thread_id = ?) AS atoms, " +
        "(SELECT COUNT(*) FROM address_route WHERE thread_id = ?) AS routes",
    )
    .get(thread.id, thread.id) as { atoms: number; routes: number };
  const computedCoverage = coverageFor(vault, thread.id, {
    question: fixture.question,
    querySeq: asking.seq,
    pages: packet.pages,
  });
  const coverage = packet.coverage ?? computedCoverage;
  const targets = (fixture.targetIndexes ?? [])
    .map((index) => bindings[index]?.seq)
    .filter((seq): seq is Seq => seq !== undefined);
  const resolvedPages = packet.pages.filter((page) => page.resolved);
  const pageSequences = pageSeqs(packet);
  const sourceRoutes = targets.filter((seq) => resolvedPages.some((page) => page.seqs.includes(seq))).length;
  const sourceResident = targets.filter((seq) => {
    const source = fixture.sources[bindings.findIndex((binding) => binding.seq === seq)];
    return source !== undefined && includesOriginalText(packet, source.content);
  }).length;
  const selfHitExcluded =
    !packet.pages.some((page) => page.seqs.includes(asking.seq)) &&
    !(coverage?.routes ?? []).some((route) => route.source === `episode:${asking.seq}`);
  const semantic = semanticObservation(
    packet,
    targets,
    durableAuthorityAfter.atoms === durableAuthorityBefore.atoms &&
      durableAuthorityAfter.routes === durableAuthorityBefore.routes,
  );
  const semanticReceipt = packetSemanticReceipt(packet);
  const gate =
    fixture.gate === undefined
      ? undefined
      : gateObservation(
          fixture.gate,
          fixture.question,
          packet,
          bindings[fixture.targetIndexes?.[0] ?? -1],
          fixture.sources[fixture.targetIndexes?.[0] ?? -1]?.content,
          coverage,
        );

  const violations: string[] = [];
  const allSourceSeqs = bindings.map((binding) => binding.seq);
  const removedSeqs = bindings.filter((binding) => binding.removed).map((binding) => binding.seq);
  const unresolvedExpected =
    (fixture.family === "deleted-source" ||
      fixture.family === "noun-free-paraphrase" ||
      fixture.family === "multilingual-refer-back" ||
      fixture.family === "pronoun-ambiguity") &&
    resolvedPages.length === 0;
  const unresolvedReceipt = unresolvedExpected && hasKernelUnresolvedReceipt(packet);
  const falsePages = falsePageCount(fixture, packet, targets, allSourceSeqs, removedSeqs);
  const { qualificationError, releaseError } = gateErrors(fixture.gate, gate);
  if (!selfHitExcluded) violations.push("asking turn appeared as a resolved evidence route");
  if (fixture.collection !== undefined) {
    if (packet.coverage === undefined) violations.push("collection packet omitted its coverage block");
    if (coverage === undefined) violations.push("collection coverage could not be computed");
    if (coverage !== undefined) {
      if (coverage.completeness !== fixture.collection.completeness) {
        violations.push(
          `coverage completeness ${coverage.completeness} != ${fixture.collection.completeness}`,
        );
      }
      if (fixture.collection.required !== undefined && coverage.required !== fixture.collection.required) {
        violations.push(
          `coverage required ${coverage.required ?? "missing"} != ${fixture.collection.required}`,
        );
      }
      if (coverage.supported > coverage.located) violations.push("coverage supported exceeds located");
      if (coverage.historical > coverage.located) violations.push("coverage historical exceeds located");
      if (coverage.completeness === "incomplete" && (coverage.unresolved ?? 0) < 1) {
        violations.push("incomplete coverage omitted its unresolved lower bound");
      }
      if (coverage.completeness === "not-established" && coverage.required !== undefined) {
        violations.push("unknown-cardinality coverage carried a claimed requirement");
      }
      if (coverage.querySeq !== asking.seq) {
        violations.push("coverage receipt query sequence did not bind asking turn");
      }
      if (coverage.asOfSeq !== asking.seq) {
        violations.push("coverage receipt snapshot did not bind asking turn");
      }
      if (coverage.routerVersion.length === 0) {
        violations.push("coverage receipt omitted router version");
      }
      if (!Array.isArray(coverage.routesRun) || coverage.routesRun.length === 0) {
        violations.push("coverage receipt omitted route execution receipts");
      } else {
        for (const route of coverage.routesRun) {
          if (
            route.route.length === 0 ||
            !Number.isSafeInteger(route.returned) ||
            route.returned < 0 ||
            !["complete", "empty", "capped", "ambiguous", "unresolved", "not-run"].includes(route.status)
          ) {
            violations.push("coverage route execution receipt was malformed");
            break;
          }
        }
      }
      if (!Array.isArray(coverage.routes)) {
        violations.push("coverage receipt omitted typed route locators");
      }
    }
  } else if (packet.coverage !== undefined) {
    violations.push("non-collection packet carried a coverage block");
  }
  if (semantic.status === "missing") {
    violations.push("semantic=true produced no kernel semantic receipt");
  }
  if (semantic.hit && semantic.status !== "ready")
    violations.push("semantic hit was counted without a ready receipt");
  if (semantic.status === "unavailable" && semantic.hit) {
    violations.push("semantic-unavailable receipt was counted as a hit");
  }
  if (!semantic.addressOnly) violations.push("semantic routing wrote an atom or address edge");
  for (const record of packet.pages.filter((page) => page.trigger === "semantic" && page.resolved)) {
    if (
      record.source === undefined ||
      record.contentHash === undefined ||
      record.spanHash === undefined ||
      record.byteRange === undefined
    ) {
      violations.push("resolved semantic page lacked an exact source/hash/span receipt");
    }
  }
  if (fixture.family === "self-hit" && pageSequences.includes(asking.seq)) {
    violations.push("self-hit page sequence included the asking turn");
  }
  if (fixture.family === "deleted-source") {
    if (pageSequences.some((seq) => removedSeqs.includes(seq))) violations.push("deleted source was paged");
    if (includesOriginalText(packet, fixture.sources[0]?.content ?? "")) {
      violations.push("deleted source text remained visible in the packet");
    }
  }
  if (fixture.family === "superseded-source" && bindings[0] !== undefined) {
    const oldSeq = bindings[0].seq;
    const oldPages = resolvedPages.some((page) => page.seqs.includes(oldSeq));
    const oldIsHistorical = packet.resident.some(
      (item) => item.type === "paged" && item.seq === oldSeq && item.epistemic === "HISTORICAL",
    );
    if (oldPages && !oldIsHistorical) {
      violations.push("superseded semantic source was exposed as current support");
    }
  }
  if (unresolvedExpected && !unresolvedReceipt) {
    violations.push("expected unresolved outcome lacked a kernel receipt");
  }
  if (fixture.gate !== undefined && gate === undefined)
    violations.push("claim gate did not produce a receipt");
  if ((fixture.gate === "omitted" || fixture.gate === "supported") && sourceResident === 0) {
    violations.push("claim-gate control did not compile an exact packet-visible source");
  }
  if (fixture.gate === "omitted" && gate !== undefined) {
    if (gate.status !== "qualified") violations.push("omitted claim map released a remembered claim");
    if (!gate.classifications.some((entry) => entry.classification === "UNKNOWN")) {
      violations.push("omitted claim map did not classify the remembered claim UNKNOWN");
    }
  }
  if (fixture.gate === "supported" && gate !== undefined) {
    if (gate.status !== "released") violations.push("current witnessed claim was qualified");
    if (!gate.classifications.some((entry) => entry.classification === "SUPPORTED")) {
      violations.push("current witnessed claim did not classify SUPPORTED");
    }
    if (gate.packetDigest !== packet.digest)
      violations.push("answer receipt packet digest did not bind packet");
  }
  if (gate !== undefined) {
    if (!isSha256(gate.digest)) violations.push("answer receipt digest was malformed");
    if (!isSha256(gate.answerDigest)) violations.push("answer receipt answer digest was malformed");
    if (!isSha256(gate.scanDigest)) violations.push("answer receipt scan digest was malformed");
    if (!isSha256(gate.packetDigest) || gate.packetDigest !== packet.digest) {
      violations.push("answer receipt packet binding was malformed");
    }
    if (!isSha256(gate.roundsDigest)) violations.push("answer receipt rounds digest was malformed");
    if (gate.grammarVersion.length === 0) violations.push("answer receipt grammar version was missing");
    if (coverage === undefined) {
      if (gate.coverageDigest !== undefined) {
        violations.push("answer receipt carried coverage binding without coverage");
      }
      if (gate.coverageRouterVersion !== undefined || gate.coverageRoutesRun !== undefined) {
        violations.push("answer receipt carried coverage route provenance without coverage");
      }
    } else if (
      gate.coverageDigest !== coverage.digest ||
      gate.coverageRouterVersion !== coverage.routerVersion ||
      JSON.stringify(gate.coverageRoutesRun) !== JSON.stringify(coverage.routesRun)
    ) {
      violations.push("answer receipt coverage bindings did not match coverage receipt");
    }
    for (const classification of gate.classifications) {
      if (classification.classification !== "SUPPORTED") continue;
      if (!evidenceLocatorShape(classification.evidenceWitness)) {
        violations.push("supported answer classification lacked a typed evidence witness");
        break;
      }
      if (classification.witness === undefined) {
        violations.push("supported answer classification lacked its compact witness");
        break;
      }
    }
  }
  if (fixture.gate === "world" && gate !== undefined) {
    if (!gate.classifications.some((entry) => entry.classification === "WORLD_KNOWLEDGE")) {
      violations.push("world-knowledge control entered archive UNKNOWN");
    }
  }
  if (fixture.gate === "reasoning" && gate !== undefined) {
    if (gate.candidates.length !== 0 || gate.status !== "released") {
      violations.push("reasoning control entered remembered-claim gate");
    }
  }
  if (packet.tokens > packet.budget) violations.push("packet exceeded its declared budget");
  if (packet.digest.length !== 64) violations.push("packet digest is not a sha256 witness");

  const result: ProbeResult = {
    id: fixture.id,
    family: fixture.family,
    expectation: fixture.expectation,
    askingTurnIndexed: true,
    question: fixture.question,
    querySeq: asking.seq,
    sources: bindings,
    packet: {
      id: packet.id,
      digest: packet.digest,
      tokens: packet.tokens,
      budget: packet.budget,
      pageCount: packet.pages.length,
      resolvedPageCount: resolvedPages.length,
      pageTriggers: packet.pages.map((page) => page.trigger),
      pageSeqs: pageSequences,
      reachabilityPresent: packet.reachability !== undefined,
      ...(packet.coverage === undefined ? {} : { coverageDigest: packet.coverage.digest }),
      ...(semanticReceipt === undefined ? {} : { semanticDigest: canonicalHash(semanticReceipt) }),
    },
    ...(coverage === undefined ? {} : { coverage: asCoverage(coverage) }),
    semantic,
    ...(gate === undefined ? {} : { gate }),
    receipts: {
      packetDigest: packet.digest,
      ...(coverage?.digest === undefined ? {} : { coverageDigest: coverage.digest }),
      ...(semanticReceipt === undefined ? {} : { semanticReceiptDigest: canonicalHash(semanticReceipt) }),
      ...(gate?.receiptDigest === undefined ? {} : { answerReceiptDigest: gate.receiptDigest }),
      ...(gate?.packetDigest === undefined ? {} : { answerPacketDigest: gate.packetDigest }),
      ...(gate?.answerDigest === undefined ? {} : { answerDigest: gate.answerDigest }),
      ...(gate?.scanDigest === undefined ? {} : { answerScanDigest: gate.scanDigest }),
      ...(gate?.roundsDigest === undefined ? {} : { answerRoundsDigest: gate.roundsDigest }),
      ...(gate?.coverageDigest === undefined ? {} : { answerCoverageDigest: gate.coverageDigest }),
      ...(gate?.coverageRouterVersion === undefined
        ? {}
        : { answerCoverageRouterVersion: gate.coverageRouterVersion }),
      ...(gate?.coverageRoutesRun === undefined ? {} : { answerCoverageRoutesRun: gate.coverageRoutesRun }),
    },
    metrics: {
      sourceRoutes,
      sourceResident,
      resolvedPages: resolvedPages.length,
      falsePages,
      unresolvedReceipt,
      qualificationError,
      releaseError,
      latencyMs: Number((performance.now() - startedAt).toFixed(3)),
      selfHitExcluded,
      modelCalls: 0,
      providerCostUsd: 0,
    },
    oracle: { ok: violations.length === 0, violations },
  };
  vault.db.close();
  return result;
}

type CoverageRouteForDigest = CoverageReceipt["routes"][number];
type CoverageBasisRouteForDigest = CoverageReceipt["basis"]["routeMembers"]["names"];

function stableCoverageRouteRuns(
  routes: CoverageReceipt["routesRun"] | undefined,
): Array<{ route: string; returned: number; status: string }> | undefined {
  if (routes === undefined) return undefined;
  return routes
    .map(({ route, returned, status }) => ({ route, returned, status }))
    .sort((left, right) => left.route.localeCompare(right.route));
}

function stableCoverageLocator(locator: CoverageRouteForDigest): unknown {
  // `revision` and `digest` are retained in the JSON receipt, but the former
  // includes the random synthetic thread genesis and the latter is derived
  // from it. Source, range, authority, and status are the semantic address.
  return {
    route: locator.route,
    source: locator.source,
    byteRange: locator.byteRange,
    authority: locator.authority,
    status: locator.status,
  };
}

function stableCoverageBasisRoute(route: CoverageBasisRouteForDigest): unknown {
  return {
    members: route.members.map((member) => ({
      kind: member.kind,
      sourceSeq: member.sourceSeq,
      contentHash: member.contentHash,
      outcome: member.outcome,
      // Atom ids and locator digests are runtime/chain-derived. Their
      // semantic multiplicity remains represented by this count and by the
      // top-level exact locator list.
      locatorCount: member.locatorDigests.length,
      ...(member.key === undefined ? {} : { key: member.key }),
      ...(member.ordinal === undefined ? {} : { ordinal: member.ordinal }),
    })),
    memberCount: route.memberCount,
    overflow: route.overflow,
    outcome: {
      route: route.outcome.route,
      returned: route.outcome.returned,
      status: route.outcome.status,
    },
  };
}

function stableCoverageForDigest(receipt: CoverageReceipt): unknown {
  const routes = receipt.routes
    .map(stableCoverageLocator)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    cue: receipt.cue,
    querySeq: receipt.querySeq,
    asOfSeq: receipt.asOfSeq,
    routerVersion: receipt.routerVersion,
    routesRun: stableCoverageRouteRuns(receipt.routesRun),
    ...(receipt.required === undefined ? {} : { required: receipt.required }),
    located: receipt.located,
    supported: receipt.supported,
    historical: receipt.historical,
    ...(receipt.unresolved === undefined ? {} : { unresolved: receipt.unresolved }),
    completeness: receipt.completeness,
    routes,
    basis: {
      version: receipt.basis.version,
      // queryContentHash, initialPagesDigest, locatorDigests, membersDigest,
      // and basis.digest are derived digests. The question, page shape,
      // locator set, and route outcomes remain represented elsewhere here.
      routeMembers: {
        names: stableCoverageBasisRoute(receipt.basis.routeMembers.names),
        pages: stableCoverageBasisRoute(receipt.basis.routeMembers.pages),
        search: stableCoverageBasisRoute(receipt.basis.routeMembers.search),
      },
    },
  };
}

function stableClaimLocator(locator: unknown): unknown {
  if (locator === undefined || locator === null || typeof locator !== "object") return undefined;
  const value = locator as Record<string, unknown>;
  return {
    source: value.source,
    from: value.from,
    to: value.to,
    hash: value.hash,
    ...(typeof value.seq === "number" ? { seq: value.seq } : {}),
    ...(typeof value.spanHash === "string" ? { spanHash: value.spanHash } : {}),
    ...(typeof value.authority === "string" ? { authority: value.authority } : {}),
    ...(typeof value.manifestId === "string" ? { manifestId: value.manifestId } : {}),
  };
}

function stableClaimCandidate(candidate: AnswerReceipt["candidates"][number]): unknown {
  return {
    span: candidate.span,
    kind: candidate.kind,
    text: candidate.text,
    ...(candidate.classification === undefined ? {} : { classification: candidate.classification }),
  };
}

function stableClaimClassification(classification: AnswerReceipt["classifications"][number]): unknown {
  return {
    span: classification.span,
    kind: classification.kind,
    classification: classification.classification,
    ...(classification.witness === undefined ? {} : { witness: stableClaimLocator(classification.witness) }),
    ...(classification.evidenceWitness === undefined
      ? {}
      : { evidenceWitness: stableClaimLocator(classification.evidenceWitness) }),
    ...(classification.basis === undefined
      ? {}
      : {
          basis: {
            kind: classification.basis.kind,
            metric: classification.basis.metric,
            value: classification.basis.value,
          },
        }),
  };
}

function stableGateForDigest(gate: GateObservation): unknown {
  return {
    status: gate.status,
    grammarVersion: gate.grammarVersion,
    candidates: gate.candidates.map(stableClaimCandidate),
    classifications: gate.classifications.map(stableClaimClassification),
    qualifications: gate.qualifications,
    ...(gate.coverageRouterVersion === undefined
      ? {}
      : { coverageRouterVersion: gate.coverageRouterVersion }),
    ...(gate.coverageRoutesRun === undefined
      ? {}
      : { coverageRoutesRun: stableCoverageRouteRuns(gate.coverageRoutesRun) }),
  };
}

/**
 * Stable semantic projection for repeatability measurement. Raw wire receipts
 * remain untouched in the JSON artifact; this projection excludes only
 * environment/runtime-derived IDs, chain revisions, timing anchors, and
 * digests that transitively contain them.
 */
export function stableDigestProjection(result: NaturalResult): unknown {
  return {
    schema: result.schema,
    seed: result.seed,
    currentVersion: result.currentVersion,
    budget: result.budget,
    mechanisms: result.mechanisms,
    familyCoverage: result.familyCoverage,
    provider: result.metrics.provider,
    cases: result.cases.map((probe) => ({
      id: probe.id,
      family: probe.family,
      querySeq: probe.querySeq,
      question: probe.question,
      sources: probe.sources.map((source) => ({
        seq: source.seq,
        contentHash: source.contentHash,
        removed: source.removed,
      })),
      packet: {
        tokens: probe.packet.tokens,
        budget: probe.packet.budget,
        pageCount: probe.packet.pageCount,
        resolvedPageCount: probe.packet.resolvedPageCount,
        pageTriggers: probe.packet.pageTriggers,
        pageSeqs: probe.packet.pageSeqs,
        reachabilityPresent: probe.packet.reachabilityPresent,
      },
      coverage: probe.coverage === undefined ? undefined : stableCoverageForDigest(probe.coverage),
      semantic: {
        status: probe.semantic.status,
        hit: probe.semantic.hit,
        resolvedSeqs: probe.semantic.resolvedSeqs,
        witnesses: probe.semantic.witnesses,
        addressOnly: probe.semantic.addressOnly,
      },
      gate: probe.gate === undefined ? undefined : stableGateForDigest(probe.gate),
      metrics: {
        sourceRoutes: probe.metrics.sourceRoutes,
        sourceResident: probe.metrics.sourceResident,
        resolvedPages: probe.metrics.resolvedPages,
        falsePages: probe.metrics.falsePages,
        unresolvedReceipt: probe.metrics.unresolvedReceipt,
        qualificationError: probe.metrics.qualificationError,
        releaseError: probe.metrics.releaseError,
        selfHitExcluded: probe.metrics.selfHitExcluded,
        modelCalls: probe.metrics.modelCalls,
        providerCostUsd: probe.metrics.providerCostUsd,
      },
      oracle: probe.oracle,
    })),
    infrastructureFailures: result.infrastructureFailures,
  };
}

export function stableDigestOf(result: NaturalResult): string {
  return canonicalHash(stableDigestProjection(result));
}

function retainedFile(path: string): RetainedNaturalFile {
  const bytes = readFileSync(path);
  return { path: basename(path), sha256: sha256(bytes), bytes: bytes.byteLength };
}

function retainedNaturalArtifact(path: string, result: NaturalResult): RetainedNaturalFile {
  const artifact = retainedFile(path);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as NaturalResult;
  if (parsed.digest !== result.digest || stableDigestOf(parsed) !== parsed.digest)
    throw new Error(`natural artifact digest field does not match ${path}`);
  return artifact;
}

/**
 * Retain both sides of a repeatability check without overwriting either run.
 * The natural bench itself writes one result per invocation; callers that run
 * it twice can persist this envelope beside those two JSON artifacts.
 */
export function naturalRepeatabilityEnvelope(
  results: readonly [NaturalResult, NaturalResult] | readonly NaturalResult[],
  artifactPaths?: readonly string[],
): NaturalRepeatabilityEnvelope {
  if (results.length < 2) throw new Error("natural repeatability needs at least two runs");
  if (artifactPaths === undefined || artifactPaths.length !== results.length) {
    throw new Error("natural repeatability requires one retained JSON path per run");
  }
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    throw new Error("natural repeatability requires distinct retained JSON paths");
  }
  const first = results[0] as NaturalResult;
  const stableDigest = stableDigestOf(first);
  const stableDigestEqual = results.every((result) => stableDigestOf(result) === stableDigest);
  if (!stableDigestEqual) throw new Error("natural repeatability stable digest changed between runs");
  const runs = results.map((result, index) => ({
    digest: result.digest,
    artifact: retainedNaturalArtifact(artifactPaths[index] as string, result),
  }));
  return {
    schema: "pylos.bench.natural-repeatability.v1",
    runs,
    stableDigest,
    stableDigestEqual,
  };
}

/** Read two retained run JSON files and write a non-destructive envelope. */
export function writeNaturalRepeatabilityEnvelope(
  firstPath: string,
  secondPath: string,
  outputPath: string,
): NaturalRepeatabilityEnvelope {
  const first = JSON.parse(readFileSync(firstPath, "utf8")) as NaturalResult;
  const second = JSON.parse(readFileSync(secondPath, "utf8")) as NaturalResult;
  const envelope = naturalRepeatabilityEnvelope([first, second], [firstPath, secondPath]);
  if (existsSync(outputPath)) throw new Error(`repeatability envelope already exists: ${outputPath}`);
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return envelope;
}

function familyCoverageFor(fixtures: readonly Fixture[]): FamilyCoverage[] {
  const families = [...new Set(fixtures.map((fixture) => fixture.family))];
  return families.map((family) => {
    const members = fixtures.filter((fixture) => fixture.family === family);
    const pairKeys = [
      ...new Set(members.flatMap((fixture) => (fixture.pairKey === undefined ? [] : [fixture.pairKey]))),
    ];
    const matchedPairs = pairKeys.filter((pairKey) => {
      const pair = members.filter((fixture) => fixture.pairKey === pairKey);
      return (
        pair.some((fixture) => fixture.polarity === "positive") &&
        pair.some((fixture) => fixture.polarity === "negative")
      );
    }).length;
    return {
      family,
      denominator: members.length,
      positive: members.filter((fixture) => fixture.polarity === "positive").length,
      negative: members.filter((fixture) => fixture.polarity === "negative").length,
      matchedPairs,
      note:
        matchedPairs > 0
          ? `matched positive/negative control pair(s): ${matchedPairs}`
          : "single-denominator family; no independent opposite-polarity control is inflated",
    };
  });
}

function mechanismsFor(cases: readonly ProbeResult[], violations: readonly string[]): MechanismClaim[] {
  const collectionCases = cases.filter((probe) => probe.family === "partial-collection");
  const gateCases = cases.filter((probe) => probe.gate !== undefined);
  const semanticReceipts = cases.filter((probe) => probe.semantic.receiptDigest !== undefined);
  const semanticRuntimeCases = semanticReceipts.filter((probe) => probe.semantic.status === "ready");
  const semanticExactHits = semanticRuntimeCases.filter((probe) => probe.semantic.hit);
  const relevantViolations = violations.length === 0;
  return [
    {
      mechanism: "lexical source routing",
      claim: "A deterministic lexical route can return an exact source-bound page.",
      denominator: cases.filter((probe) => probe.sources.length > 0).length,
      observed: cases.filter((probe) => probe.metrics.sourceRoutes > 0).length,
      implemented: cases.some((probe) => probe.metrics.sourceRoutes > 0),
      tested: cases.some((probe) => probe.id === "self-hit" && probe.metrics.sourceRoutes > 0),
      bench: "self-hit and polarity probes recorded source sequence routes",
      notClaimed: "This does not establish semantic retrieval or model answer quality.",
    },
    {
      mechanism: "retained-byte reachability receipt",
      claim: "Compiled packets carry a kernel reachability receipt when present.",
      denominator: cases.length,
      observed: cases.filter((probe) => probe.packet.reachabilityPresent).length,
      implemented: cases.length > 0 && cases.every((probe) => probe.packet.reachabilityPresent),
      tested: false,
      bench: "natural probes record receipt presence; Phase 1 closure oracles own completeness",
      notClaimed: "This bench does not prove four-state closure for every retained byte.",
    },
    {
      mechanism: "collection coverage receipt",
      claim: "Collection cues expose located/support counts without inventing cardinality.",
      denominator: collectionCases.length,
      observed: collectionCases.filter((probe) => probe.coverage !== undefined).length,
      implemented:
        collectionCases.length > 0 && collectionCases.every((probe) => probe.coverage !== undefined),
      tested:
        collectionCases.length > 0 &&
        collectionCases.every((probe) => probe.oracle.ok && probe.packet.coverageDigest !== undefined),
      bench: "known-cardinality incomplete and unknown-cardinality not-established probes",
      notClaimed: "Coverage is a route lower bound, not proof that the world contains only those items.",
    },
    {
      mechanism: "remembered-claim gate",
      claim: "Kernel scanning and witness-bound capabilities classify remembered assertions.",
      denominator: gateCases.length,
      observed: gateCases.filter((probe) => probe.gate !== undefined).length,
      implemented: gateCases.length > 0 && gateCases.every((probe) => probe.gate !== undefined),
      tested: gateCases.length > 0 && gateCases.every((probe) => probe.oracle.ok),
      bench: "omitted-map UNKNOWN, exact witnessed SUPPORTED, world, and reasoning controls",
      notClaimed: "The gate does not certify unsupported model prose or general reasoning.",
    },
    {
      mechanism: "semantic exact-hit verifier",
      claim: "A ready semantic address is counted only when it returns an exact target sequence.",
      denominator: semanticRuntimeCases.length,
      observed: semanticExactHits.length,
      implemented: semanticRuntimeCases.length > 0,
      tested: semanticExactHits.length > 0 && relevantViolations,
      bench: `${semanticExactHits.length}/${semanticRuntimeCases.length} ready-runtime probes returned exact target sequences; all counted hits were exact, while non-target pages remain in the false-page metric`,
      notClaimed: "These authored probes do not estimate semantic recall, precision, or ranking quality.",
    },
    {
      mechanism: "sqlite-vec semantic runtime",
      claim: "A packaged sqlite-vec and pinned embedding runtime is available to produce semantic addresses.",
      denominator: semanticReceipts.length,
      observed: semanticRuntimeCases.length,
      implemented: true,
      tested: false,
      bench: `${semanticRuntimeCases.length}/${semanticReceipts.length} probes returned ready receipts bound to the pinned model digest; the runtime is packages/core/src/semantic-runtime.ts, exercised by kernel tests, and this compile-only bench invokes no semantic runtime directly`,
      notClaimed:
        "Receipt availability is not proof of semantic efficacy, and this bench exercises no semantic runtime of its own; no semantic efficacy claim is made.",
    },
    {
      mechanism: "persistent question-to-evidence address graph",
      claim: "Successful grounded turns can be reused through persisted routes.",
      denominator: 0,
      observed: 0,
      implemented: true,
      tested: false,
      bench: "not exercised by this compile-only bench; see the external address monotonicity oracle",
      notClaimed: "This bench does not establish route reuse, invalidation, or semantic authority.",
    },
    {
      mechanism: "provider/model efficacy",
      claim: "A model answers natural questions accurately.",
      denominator: cases.length,
      observed: cases.reduce((sum, probe) => sum + probe.metrics.modelCalls, 0),
      implemented: false,
      tested: false,
      bench: "modelCalls=0; deterministic kernel-only measurement",
      notClaimed: "No provider was called, so no model efficacy claim is made.",
    },
  ];
}

function markdownCell(value: unknown): string {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Render the proof companion; this function is called only after a PASS. */
function renderNaturalMarkdown(result: NaturalResult): string {
  const metrics = result.metrics;
  const lines = [
    "# Pylos natural-question bench",
    "",
    `**PASS** · schema \`${result.schema}\` · version \`${result.currentVersion}\` · seed \`${result.seed}\``,
    `Stable digest: \`${result.digest}\` · JSON companion: [natural.json](natural.json)`,
    "",
    "## Metrics",
    "",
    "| metric | count | denominator | detail |",
    "| --- | ---: | ---: | --- |",
    `| probes | ${metrics.probes} | ${metrics.attempted} | route hits ${metrics.routeHits}; route misses ${metrics.routeMisses} |`,
    `| unresolved receipts | ${metrics.unresolvedReceipts.count} | ${metrics.unresolvedReceipts.denominator} | kernel page/semantic receipts for deletion, ambiguity, and miss controls |`,
    `| false pages | ${metrics.falsePages.count} | ${metrics.falsePages.denominator} | resolved page records examined |`,
    `| qualification errors | ${metrics.qualificationErrors.count} | ${metrics.qualificationErrors.denominator} | gate status/qualification mismatches |`,
    `| release errors | ${metrics.releaseErrors.count} | ${metrics.releaseErrors.denominator} | controls expected to release |`,
    `| infrastructure failures | ${metrics.infrastructureFailures.count} | ${metrics.infrastructureFailures.denominator} | ${result.infrastructureFailures.length === 0 ? "none" : "see JSON"} |`,
    `| semantic unavailable receipts | ${metrics.semanticUnavailableReceipts.count} | ${metrics.semanticUnavailableReceipts.denominator} | semantic hits ${metrics.semanticHits} |`,
    `| coverage receipts | ${metrics.coverageReceipts} | ${result.familyCoverage.find((family) => family.family === "partial-collection")?.denominator ?? 0} | collection probes |`,
    `| answer receipts | ${metrics.gateReceipts} | ${metrics.qualificationErrors.denominator} | gate controls |`,
    `| latency (ms) | ${metrics.latencyMs.total} | ${metrics.latencyMs.denominator} | p50 ${metrics.latencyMs.p50}; p95 ${metrics.latencyMs.p95}; p99 ${metrics.latencyMs.p99}; max ${metrics.latencyMs.max} |`,
    `| provider calls / cost | ${metrics.provider.modelCalls} / $${metrics.provider.costUsd.toFixed(2)} | ${metrics.provider.denominator} | deterministic run; no provider invoked |`,
    "",
    "## Mechanisms and claims",
    "",
    "| mechanism | implemented | tested | denominator | observed | evidence | not claimed |",
    "| --- | --- | --- | ---: | ---: | --- | --- |",
    ...result.mechanisms.map(
      (entry) =>
        `| ${markdownCell(entry.mechanism)} | ${entry.implemented ? "yes" : "no"} | ${entry.tested ? "yes" : "no"} | ${entry.denominator} | ${entry.observed} | ${markdownCell(entry.bench)} | ${markdownCell(entry.notClaimed)} |`,
    ),
    "",
    "## Family denominators",
    "",
    "| family | denominator | positive | negative | matched pairs | note |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...result.familyCoverage.map(
      (family) =>
        `| ${markdownCell(family.family)} | ${family.denominator} | ${family.positive} | ${family.negative} | ${family.matchedPairs} | ${markdownCell(family.note)} |`,
    ),
    "",
    "## Boundaries",
    "",
    `- Infrastructure failures: ${metrics.infrastructureFailures.count}/${metrics.infrastructureFailures.denominator}.`,
    `- Model efficacy: not measured; ${metrics.provider.modelCalls} provider calls and $${metrics.provider.costUsd.toFixed(2)} cost.`,
    "- Semantic receipt availability is reported separately from runtime implementation and semantic efficacy; this bench makes no semantic efficacy claim.",
    "- Raw packet and receipt digests remain in the JSON companion for audit; timestamps and Markdown are excluded from the stable digest.",
    "",
  ];
  return lines.join("\n");
}

export async function runNaturalBench(options: NaturalRunOptions = {}): Promise<NaturalResult> {
  const startedAt = new Date().toISOString();
  const outputPath = options.outputPath ?? RESULT_PATH;
  const markdownPath = options.markdownPath ?? outputPath.replace(/\.json$/u, ".md");
  for (const path of [outputPath, markdownPath]) {
    if (existsSync(path))
      throw new Error(`natural run output already exists: ${path}; choose a unique run output`);
  }
  const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pylos-natural-"));
  const cases: ProbeResult[] = [];
  const infrastructureFailures: InfrastructureFailure[] = [];
  try {
    for (const fixture of FIXTURES) {
      const home = join(root, fixture.id);
      mkdirSync(home, { recursive: true });
      try {
        cases.push(runProbe(fixture, home));
      } catch (error) {
        infrastructureFailures.push({
          id: fixture.id,
          family: fixture.family,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const finishedAt = new Date().toISOString();
  const violations = [
    ...cases.flatMap((probe) => probe.oracle.violations.map((v) => `${probe.id}: ${v}`)),
    ...infrastructureFailures.map((failure) => `${failure.id}: infrastructure failure: ${failure.message}`),
  ];
  const latencies = cases.map((probe) => probe.metrics.latencyMs);
  // Count every fixture eligible for an unresolved receipt; a ready false page
  // must remain visible in the denominator rather than collapsing it to 0/0.
  const unresolvedFamilies = new Set([
    "deleted-source",
    "noun-free-paraphrase",
    "multilingual-refer-back",
    "pronoun-ambiguity",
  ]);
  const unresolvedDenominator = FIXTURES.filter((fixture) => unresolvedFamilies.has(fixture.family)).length;
  const metrics: NaturalResult["metrics"] = {
    attempted: FIXTURES.length,
    probes: cases.length,
    routeHits: cases.reduce((sum, probe) => sum + (probe.metrics.sourceRoutes > 0 ? 1 : 0), 0),
    routeMisses: cases.reduce((sum, probe) => sum + (probe.metrics.sourceRoutes === 0 ? 1 : 0), 0),
    semanticHits: cases.filter((probe) => probe.semantic.hit).length,
    unresolvedReceipts: {
      count: cases.filter((probe) => probe.metrics.unresolvedReceipt).length,
      denominator: unresolvedDenominator,
    },
    falsePages: {
      count: cases.reduce((sum, probe) => sum + probe.metrics.falsePages, 0),
      denominator: cases.reduce((sum, probe) => sum + probe.metrics.resolvedPages, 0),
    },
    qualificationErrors: {
      count: cases.filter((probe) => probe.metrics.qualificationError).length,
      denominator: FIXTURES.filter((fixture) => fixture.gate !== undefined).length,
    },
    releaseErrors: {
      count: cases.filter((probe) => probe.metrics.releaseError).length,
      denominator: FIXTURES.filter(
        (fixture) => fixture.gate === "supported" || fixture.gate === "world" || fixture.gate === "reasoning",
      ).length,
    },
    infrastructureFailures: {
      count: infrastructureFailures.length,
      denominator: FIXTURES.length,
    },
    semanticUnavailableReceipts: {
      count: cases.filter((probe) => probe.semantic.status === "unavailable").length,
      denominator: cases.length,
    },
    coverageReceipts: cases.filter((probe) => probe.coverage !== undefined).length,
    gateReceipts: cases.filter((probe) => probe.gate !== undefined).length,
    gateQualifications: cases.filter((probe) => probe.gate?.status === "qualified").length,
    latencyMs: {
      denominator: latencies.length,
      total: Number(latencies.reduce((sum, latency) => sum + latency, 0).toFixed(3)),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
    provider: { modelCalls: 0, costUsd: 0, denominator: FIXTURES.length },
    oracleViolations: violations.length,
  };
  const result: NaturalResult = {
    schema: SCHEMA,
    seed: SEED,
    currentVersion: PYLOS_VERSION,
    budget: BUDGET,
    startedAt,
    finishedAt,
    modelEfficacy: {
      status: "not-run",
      modelCalls: 0,
      reason: "This bench measures deterministic kernel routes, receipts, and gates; no provider was called.",
    },
    mechanisms: mechanismsFor(cases, violations),
    familyCoverage: familyCoverageFor(FIXTURES),
    infrastructureFailures,
    metrics,
    cases,
    ok: violations.length === 0,
    violations,
    digest: "",
  };
  result.digest = stableDigestOf(result);
  if (result.ok) {
    mkdirSync(join(import.meta.dir, "results"), { recursive: true });
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    writeFileSync(markdownPath, renderNaturalMarkdown(result), "utf8");
  }
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--repeat-envelope") {
    const firstPath = args[1];
    const secondPath = args[2];
    const outputPath = args[3];
    if (firstPath === undefined || secondPath === undefined || outputPath === undefined) {
      process.stderr.write(
        "usage: bun run bench/natural.ts --repeat-envelope FIRST.json SECOND.json OUT.json\n",
      );
      process.exitCode = 2;
    } else {
      const envelope = writeNaturalRepeatabilityEnvelope(firstPath, secondPath, outputPath);
      process.stdout.write(
        `wrote natural repeatability envelope ${outputPath} · stable ${envelope.stableDigest}\n`,
      );
    }
  } else {
    const outputIndex = args.indexOf("--out");
    const markdownIndex = args.indexOf("--markdown-out");
    const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
    const markdownPath = markdownIndex >= 0 ? args[markdownIndex + 1] : undefined;
    if (
      (outputIndex >= 0 && outputPath === undefined) ||
      (markdownIndex >= 0 && markdownPath === undefined)
    ) {
      process.stderr.write("usage: bun run bench/natural.ts [--out RUN.json] [--markdown-out RUN.md]\n");
      process.exitCode = 2;
      process.exit();
    }
    const result = await runNaturalBench({
      ...(outputPath === undefined ? {} : { outputPath }),
      ...(markdownPath === undefined ? {} : { markdownPath }),
    });
    process.stdout.write(
      `pylos bench natural · ${result.cases.length} probes · ` +
        `${result.metrics.oracleViolations} oracle violations · ${result.digest}\n`,
    );
    if (!result.ok) process.exitCode = 1;
  }
}
