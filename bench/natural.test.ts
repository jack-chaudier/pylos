import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalHash, gateAnswer, issueEvidenceCapabilities, sha256 } from "@pylos/core";
import type { CoverageReceipt, EvidenceLocator, Seq } from "@pylos/protocol";
import {
  type NaturalResult,
  naturalRepeatabilityEnvelope,
  stableDigestOf,
  writeNaturalRepeatabilityEnvelope,
} from "./natural.ts";

const packetDigest = sha256("natural-contract-packet");
const roundsDigest = sha256("natural-contract-rounds");

test("A14 natural-bench gate keeps a typed evidence witness and receipt bindings", () => {
  const text = "The vault pin is 314159.";
  const bytes = new TextEncoder().encode(text);
  const seq: Seq = 2;
  const revision = sha256("natural-contract-revision");
  const issued = issueEvidenceCapabilities({
    threadId: "thread-natural-contract",
    turnSeq: 3,
    roundOrdinal: 0,
    messagesDigest: packetDigest,
    packetDigest,
    sources: [
      {
        seq,
        byteRange: [0, bytes.byteLength],
        sourceDigest: sha256(bytes),
        spanDigest: sha256(bytes),
        revision,
        authority: "user",
        text,
      },
    ],
  });
  const entry = issued[0];
  if (entry === undefined) throw new Error("contract fixture did not issue a capability");
  const capabilities = new Map([[entry.capability.token, entry]]);
  const result = gateAnswer({
    question: "What is the vault pin?",
    draft: text,
    packetDigest,
    roundsDigest,
    claimMap: [
      {
        outputSpan: [0, text.length],
        capabilityTokens: [entry.capability.token],
      },
    ],
    capabilities,
    revalidate: (candidate) => ({
      valid: true,
      classification: "current",
      text: candidate.source.text,
      source: {
        source: `episode:${seq}`,
        from: 0,
        to: bytes.byteLength,
        hash: sha256(bytes),
        seq,
        revision,
        spanHash: sha256(bytes),
        authority: "user",
      } satisfies EvidenceLocator,
    }),
  });
  const supported = result.receipt.classifications.find((entry) => entry.classification === "SUPPORTED");
  expect(result.receipt.status).toBe("released");
  expect(supported?.evidenceWitness).toMatchObject({
    source: `episode:${seq}`,
    seq,
    revision,
    spanHash: sha256(bytes),
    authority: "user",
  });
  expect(result.receipt.packetDigest).toBe(packetDigest);
  expect(result.receipt.roundsDigest).toBe(roundsDigest);
  expect(result.receipt.answerDigest).toBe(sha256(result.text));
  expect(result.receipt.scanDigest).toMatch(/^[0-9a-f]{64}$/u);
});

test("A13 natural-bench coverage is carried into answer receipt provenance", () => {
  const routeBase = {
    route: "search" as const,
    source: "episode:1",
    byteRange: [0, 8] as [number, number],
    revision: sha256("coverage-revision"),
    authority: "user" as const,
    status: "supported" as const,
  };
  const route = { ...routeBase, digest: canonicalHash(routeBase) };
  const routeRun = { route: "search", returned: 1, status: "complete" as const };
  const basisMember = {
    kind: "candidate" as const,
    sourceSeq: 1,
    contentHash: sha256("natural-contract-source"),
    outcome: "supported" as const,
    locatorDigests: [route.digest],
    key: sha256("launch owner"),
    ordinal: 0,
  };
  const basisRouteBody = {
    members: [basisMember],
    memberCount: 1,
    overflow: false,
    outcome: routeRun,
  };
  const basisRoute = { ...basisRouteBody, membersDigest: canonicalHash(basisRouteBody) };
  const emptyBasisRoute = (outcome: { route: string; returned: number; status: "empty" | "not-run" }) => {
    const body = { members: [] as (typeof basisMember)[], memberCount: 0, overflow: false, outcome };
    return { ...body, membersDigest: canonicalHash(body) };
  };
  const basisBody = {
    version: 1 as const,
    queryContentHash: sha256("List every rollout owner."),
    initialPagesDigest: canonicalHash([]),
    locatorDigests: [route.digest],
    routeMembers: {
      names: emptyBasisRoute({ route: "names", returned: 0, status: "empty" }),
      pages: emptyBasisRoute({ route: "pages", returned: 0, status: "not-run" }),
      search: basisRoute,
    },
  };
  const basis = { ...basisBody, digest: canonicalHash(basisBody) };
  const coverageBase = {
    cue: "list" as const,
    querySeq: 2,
    asOfSeq: 2,
    routerVersion: "natural-contract-router-v1",
    routesRun: [routeRun],
    required: 1,
    located: 1,
    supported: 1,
    historical: 0,
    unresolved: 0,
    completeness: "complete" as const,
    routes: [route],
    basis,
  } satisfies Omit<CoverageReceipt, "digest">;
  const coverage: CoverageReceipt = { ...coverageBase, digest: canonicalHash(coverageBase) };
  const result = gateAnswer({
    question: "List every rollout owner.",
    draft: "I found 1.",
    packetDigest,
    roundsDigest,
    coverage,
    claimMap: [],
    capabilities: new Map(),
    revalidate: () => ({ valid: false }),
  });
  expect(result.receipt.coverageDigest).toBe(coverage.digest);
  expect(result.receipt.coverageRouterVersion).toBe(coverage.routerVersion);
  expect(result.receipt.coverageRoutesRun).toEqual(coverage.routesRun);
});

function repeatableNaturalResult(runSalt: string): NaturalResult {
  const hash = (value: string): string => sha256(value);
  const routeBase = {
    route: "search" as const,
    source: "episode:1",
    byteRange: [0, 8] as [number, number],
    revision: hash(`chain-revision-${runSalt}`),
    authority: "user" as const,
    status: "supported" as const,
  };
  const route = { ...routeBase, digest: hash(`locator-digest-${runSalt}`) };
  const routeRun = { route: "search", returned: 1, status: "complete" as const };
  const member = {
    kind: "candidate" as const,
    sourceSeq: 1,
    contentHash: hash("natural-stable-source"),
    outcome: "supported" as const,
    locatorDigests: [route.digest],
    atomId: `atom-${runSalt}`,
    key: "rollout-owner",
    ordinal: 0,
  };
  const basisRouteBody = {
    members: [member],
    memberCount: 1,
    overflow: false,
    outcome: routeRun,
  };
  const basisRoute = { ...basisRouteBody, membersDigest: hash(`members-digest-${runSalt}`) };
  const emptyBasisRoute = (outcome: { route: string; returned: number; status: "empty" | "not-run" }) => ({
    members: [],
    memberCount: 0,
    overflow: false,
    outcome,
    membersDigest: hash(`${outcome.route}-members-${runSalt}`),
  });
  const basis = {
    version: 1 as const,
    queryContentHash: hash("query-content"),
    initialPagesDigest: hash(`page-latency-${runSalt}`),
    locatorDigests: [route.digest],
    routeMembers: {
      names: emptyBasisRoute({ route: "names", returned: 0, status: "empty" }),
      pages: emptyBasisRoute({ route: "pages", returned: 0, status: "not-run" }),
      search: basisRoute,
    },
    digest: hash(`basis-digest-${runSalt}`),
  };
  const coverage = {
    cue: "list" as const,
    querySeq: 2,
    asOfSeq: 2,
    routerVersion: "natural-stable-router-v1",
    routesRun: [routeRun],
    required: 1,
    located: 1,
    supported: 1,
    historical: 0,
    unresolved: 0,
    completeness: "complete" as const,
    routes: [route],
    basis,
    digest: hash(`coverage-digest-${runSalt}`),
  } satisfies CoverageReceipt;
  const witness = {
    source: "episode:1",
    from: 0,
    to: 8,
    hash: hash("natural-stable-source"),
    seq: 1,
    revision: hash(`witness-revision-${runSalt}`),
    spanHash: hash("natural-stable-span"),
    authority: "user" as const,
  };
  const gate = {
    status: "released" as const,
    digest: hash(`answer-receipt-${runSalt}`),
    receiptDigest: hash(`answer-receipt-${runSalt}`),
    answerDigest: hash("answer"),
    scanDigest: hash("scan"),
    packetDigest: hash(`packet-${runSalt}`),
    roundsDigest: hash("rounds"),
    grammarVersion: "a14-grammar-v1",
    coverageDigest: coverage.digest,
    coverageRouterVersion: coverage.routerVersion,
    coverageRoutesRun: coverage.routesRun,
    classifications: [
      {
        span: [0, 8] as [number, number],
        kind: "number" as const,
        classification: "SUPPORTED" as const,
        witness,
        evidenceWitness: witness,
        capabilityDigests: [hash(`capability-${runSalt}`)],
      },
    ],
    qualifications: [],
    candidates: [{ span: [0, 8] as [number, number], kind: "number" as const, text: "314159" }],
    candidateCount: 1,
  };
  const result: NaturalResult = {
    schema: "pylos.bench.natural.v1",
    seed: "natural-questions-2026-08-23",
    currentVersion: "2.0.0",
    budget: 2_048,
    startedAt: `2026-08-23T22:45:${runSalt}.000Z`,
    finishedAt: `2026-08-23T22:46:${runSalt}.000Z`,
    modelEfficacy: { status: "not-run", modelCalls: 0, reason: "fixture" },
    mechanisms: [],
    familyCoverage: [],
    infrastructureFailures: [],
    metrics: {
      attempted: 1,
      probes: 1,
      routeHits: 1,
      routeMisses: 0,
      semanticHits: 0,
      unresolvedReceipts: { count: 0, denominator: 0 },
      falsePages: { count: 0, denominator: 1 },
      qualificationErrors: { count: 0, denominator: 1 },
      releaseErrors: { count: 0, denominator: 1 },
      infrastructureFailures: { count: 0, denominator: 1 },
      semanticUnavailableReceipts: { count: 0, denominator: 1 },
      coverageReceipts: 1,
      gateReceipts: 1,
      gateQualifications: 0,
      latencyMs: {
        denominator: 1,
        total: Number(runSalt),
        p50: Number(runSalt),
        p95: Number(runSalt),
        p99: Number(runSalt),
        max: Number(runSalt),
      },
      provider: { modelCalls: 0, costUsd: 0, denominator: 1 },
      oracleViolations: 0,
    },
    cases: [
      {
        id: "stable-fixture",
        family: "partial-collection",
        expectation: "fixture",
        askingTurnIndexed: true,
        question: "List every rollout owner.",
        querySeq: 2,
        sources: [
          {
            label: "owner",
            seq: 1,
            contentHash: hash("natural-stable-source"),
            revision: hash(`source-revision-${runSalt}`),
            byteLength: 8,
            removed: false,
          },
        ],
        packet: {
          id: `packet-${runSalt}`,
          digest: hash(`packet-${runSalt}`),
          tokens: 100,
          budget: 2_048,
          pageCount: 1,
          resolvedPageCount: 1,
          pageTriggers: ["search"],
          pageSeqs: [1],
          reachabilityPresent: true,
          coverageDigest: coverage.digest,
        },
        coverage,
        semantic: {
          status: "unavailable",
          hit: false,
          resolvedSeqs: [],
          witnesses: [],
          addressOnly: true,
          receiptDigest: hash(`semantic-${runSalt}`),
        },
        gate,
        receipts: {
          packetDigest: hash(`packet-${runSalt}`),
          coverageDigest: coverage.digest,
          answerReceiptDigest: gate.digest,
        },
        metrics: {
          sourceRoutes: 1,
          sourceResident: 1,
          resolvedPages: 1,
          falsePages: 0,
          unresolvedReceipt: false,
          qualificationError: false,
          releaseError: false,
          latencyMs: Number(runSalt),
          selfHitExcluded: true,
          modelCalls: 0,
          providerCostUsd: 0,
        },
        oracle: { ok: true, violations: [] },
      },
    ],
    ok: true,
    violations: [],
    digest: "",
  };
  result.digest = stableDigestOf(result);
  return result;
}

function retainNaturalFixture(root: string, name: string, result: NaturalResult): string {
  const jsonPath = join(root, `${name}.json`);
  writeFileSync(jsonPath, JSON.stringify(result), "utf8");
  return jsonPath;
}

test("natural stable digest ignores runtime IDs, chain revisions, receipt digests, and page timing", () => {
  const first = repeatableNaturalResult("1");
  const second = repeatableNaturalResult("2");
  expect(stableDigestOf(first)).toBe(stableDigestOf(second));

  const routeChanged = structuredClone(second);
  const route = routeChanged.cases[0]?.coverage?.routes[0];
  if (route === undefined) throw new Error("stable fixture route missing");
  route.status = "historical";
  expect(stableDigestOf(routeChanged)).not.toBe(stableDigestOf(second));

  const sourceChanged = structuredClone(second);
  const source = sourceChanged.cases[0]?.sources[0];
  if (source === undefined) throw new Error("stable fixture source missing");
  source.contentHash = sha256("changed-source");
  expect(stableDigestOf(sourceChanged)).not.toBe(stableDigestOf(second));
});

test("natural repeatability retains both run artifacts and one stable digest", () => {
  const first = repeatableNaturalResult("1");
  const second = repeatableNaturalResult("2");
  const root = mkdtempSync(join(tmpdir(), "pylos-natural-repeatability-"));
  try {
    const firstPath = retainNaturalFixture(root, "first", first);
    const secondPath = retainNaturalFixture(root, "second", second);
    const envelope = naturalRepeatabilityEnvelope([first, second], [firstPath, secondPath]);
    expect(envelope.schema).toBe("pylos.bench.natural-repeatability.v1");
    expect(envelope.runs).toHaveLength(2);
    expect(envelope.runs[0]?.digest).toBe(first.digest);
    expect(envelope.runs[0]?.artifact.path).toBe("first.json");
    expect(envelope.runs[0]?.artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(envelope.runs[1]?.artifact.bytes).toBe(readFileSync(secondPath).byteLength);
    expect(envelope.stableDigest).toBe(stableDigestOf(first));
    expect(envelope.stableDigestEqual).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("natural repeatability helper writes a retained two-run JSON envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "pylos-natural-repeatability-"));
  try {
    const firstPath = join(root, "first.json");
    const secondPath = join(root, "second.json");
    const outputPath = join(root, "repeatability.json");
    const first = repeatableNaturalResult("1");
    const second = repeatableNaturalResult("2");
    writeFileSync(firstPath, JSON.stringify(first), "utf8");
    writeFileSync(secondPath, JSON.stringify(second), "utf8");
    const envelope = writeNaturalRepeatabilityEnvelope(firstPath, secondPath, outputPath);
    const retained = JSON.parse(readFileSync(outputPath, "utf8")) as typeof envelope;
    expect(retained.runs).toHaveLength(2);
    expect(retained.runs[0]?.digest).toBe(first.digest);
    expect(retained.runs[1]?.artifact.path).toBe("second.json");
    expect(retained.stableDigestEqual).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("natural repeatability refuses a changed stable digest and retained-file tampering", () => {
  const root = mkdtempSync(join(tmpdir(), "pylos-natural-repeatability-red-"));
  try {
    const first = repeatableNaturalResult("1");
    const second = repeatableNaturalResult("2");
    const firstPath = retainNaturalFixture(root, "first", first);
    const secondPath = retainNaturalFixture(root, "second", second);
    const routeChanged = structuredClone(second);
    const route = routeChanged.cases[0]?.coverage?.routes[0];
    if (route === undefined) throw new Error("stable fixture route missing");
    route.status = "historical";
    expect(() => naturalRepeatabilityEnvelope([first, routeChanged], [firstPath, secondPath])).toThrow(
      "stable digest changed",
    );
    writeFileSync(secondPath, `${JSON.stringify({ ...second, digest: sha256("tampered") })}\n`, "utf8");
    expect(() =>
      writeNaturalRepeatabilityEnvelope(firstPath, secondPath, join(root, "rejected.json")),
    ).toThrow("artifact digest field does not match");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
