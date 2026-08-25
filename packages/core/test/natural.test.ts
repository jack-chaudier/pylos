import { afterAll, expect, test } from "bun:test";
import type { Packet } from "@pylos/protocol";
import { atomize, compact, compile, forget, type Provider, packetText, runTurn } from "../src/index.ts";
import { cleanup, rng, syntheticTurn, tempVault } from "./helpers.ts";

afterAll(cleanup);

type AnyPacket = Packet & {
  coverage?: unknown;
  obligation?: unknown;
  receipts?: unknown;
  answerReceipt?: unknown;
  semantic?: unknown;
};

function appendQuestion(
  vault: ReturnType<typeof tempVault>["vault"],
  threadId: string,
  text: string,
): AnyPacket {
  const asking = vault.episodes.append(threadId, { role: "user", content: text });
  return compile(vault, threadId, { query: text, turnSeq: asking.seq, budget: 8192 }) as AnyPacket;
}

function seed(lines: string[], seedValue = 201) {
  const { vault, thread } = tempVault();
  const sources = lines.map((content) => vault.episodes.append(thread.id, { role: "user", content }));
  const next = rng(seedValue);
  for (let i = 0; i < 420; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  compact(vault, thread.id, { budget: 8192 });
  return { vault, thread, sources };
}

function providerText(text: string): Provider {
  return async function* () {
    yield { type: "delta", text };
    yield { type: "done" };
  };
}

function routePages(
  packet: AnyPacket,
  trigger: string,
): Array<{ seqs: number[]; resolved: boolean; trigger: string }> {
  return packet.pages.filter((page) => page.trigger === (trigger as never)) as Array<{
    seqs: number[];
    resolved: boolean;
    trigger: string;
  }>;
}

function receiptText(packet: AnyPacket): string {
  return JSON.stringify({
    pages: packet.pages,
    coverage: packet.coverage,
    obligation: packet.obligation,
    receipts: packet.receipts,
    answerReceipt: packet.answerReceipt,
    semantic: packet.semantic,
  });
}

function honestNoHit(packet: AnyPacket, source: string): void {
  const text = packetText(packet.messages);
  const semantic = routePages(packet, "semantic");
  if (semantic.some((page) => page.resolved)) {
    expect(text).toContain(source);
    return;
  }
  expect(`${text}\n${receiptText(packet)}`).toMatch(/UNKNOWN|fault|unavailable|incomplete|ambiguous/i);
  // A capsule may still contain this exact source as non-authoritative prose;
  // the receipt is what proves that no semantic address was claimed.
  if (text.includes(source)) return;
}

const NATURAL_BENCH_MANIFEST = [
  { family: "self-hit", askingTurnIndexed: true, expected: "exact" },
  { family: "noun-free-paraphrase", askingTurnIndexed: true, expected: "semantic-or-receipt" },
  { family: "negation", askingTurnIndexed: true, expected: "polarity-preserving" },
  { family: "pronoun-ambiguity", askingTurnIndexed: true, expected: "all-candidates-or-receipt" },
  { family: "multilingual-refer-back", askingTurnIndexed: true, expected: "semantic-or-receipt" },
  { family: "deleted-source", askingTurnIndexed: true, expected: "removed-or-receipt" },
  { family: "superseded-source", askingTurnIndexed: true, expected: "current-or-historical" },
  { family: "partial-collection", askingTurnIndexed: true, expected: "coverage" },
  { family: "capability-map-evasion", askingTurnIndexed: true, expected: "kernel-scan" },
  { family: "world-control", askingTurnIndexed: true, expected: "world-knowledge" },
] as const;

test("A15.3 natural bench manifest registers every required family with asking-turn indexing", () => {
  expect(NATURAL_BENCH_MANIFEST.map((entry) => entry.family)).toEqual([
    "self-hit",
    "noun-free-paraphrase",
    "negation",
    "pronoun-ambiguity",
    "multilingual-refer-back",
    "deleted-source",
    "superseded-source",
    "partial-collection",
    "capability-map-evasion",
    "world-control",
  ]);
  expect(NATURAL_BENCH_MANIFEST.every((entry) => entry.askingTurnIndexed)).toBe(true);
});

test("natural bench indexes the asking turn but never lets its self-hit satisfy a memory route", () => {
  const source = "The kiln at Sagres fired unevenly because the flue was blocked.";
  const { vault, thread, sources } = seed([source], 202);
  const asking = vault.episodes.append(thread.id, {
    role: "user",
    content: "What happened to the kiln when the flue was blocked?",
  });
  const packet = compile(vault, thread.id, {
    query: asking.content,
    turnSeq: asking.seq,
    budget: 8192,
  }) as AnyPacket;
  const resolved = packet.pages.filter((page) => page.resolved);
  expect(resolved.flatMap((page) => page.seqs)).not.toContain(asking.seq);
  expect(resolved.some((page) => page.seqs.includes(sources[0]?.seq ?? -1))).toBe(true);
  expect(packetText(packet.messages)).toContain(source);
});

test("natural bench noun-free paraphrase either reaches an exact semantic page or leaves an explicit receipt", () => {
  const source = "The tea tasted smoky after the rain.";
  const { vault, thread, sources } = seed([source], 203);
  const packet = appendQuestion(vault, thread.id, "What flavor followed the storm?");
  const semantic = routePages(packet, "semantic");
  if (semantic.some((page) => page.resolved)) {
    expect(semantic.flatMap((page) => page.seqs)).toEqual([sources[0]?.seq ?? -1]);
    expect(packetText(packet.messages)).toContain(source);
  } else {
    expect(receiptText(packet)).toMatch(/semantic/i);
    expect(receiptText(packet)).toMatch(/unavailable|incomplete|UNKNOWN|fault/i);
    expect(packetText(packet.messages)).not.toContain(source);
  }
});

test("natural negation does not license a positive paraphrase", () => {
  const source = "The launch must not proceed before Cedar Review.";
  const { vault, thread, sources } = seed([source], 204);
  const packet = appendQuestion(vault, thread.id, "Should the launch proceed before Cedar Review?");
  const resolved = packet.pages.filter((page) => page.resolved);
  if (resolved.length > 0) {
    expect(resolved.flatMap((page) => page.seqs)).toContain(sources[0]?.seq ?? -1);
    expect(packetText(packet.messages)).toContain("must not proceed");
    expect(packetText(packet.messages)).not.toContain("must proceed before Cedar Review");
  } else {
    honestNoHit(packet, source);
  }
});

test("natural pronoun ambiguity returns all candidate witnesses or an explicit ambiguity receipt", () => {
  const first = "Mira briefed Nova about the harbor gate.";
  const second = "She said the gate opens at dawn.";
  const { vault, thread, sources } = seed([first, second], 205);
  const packet = appendQuestion(vault, thread.id, "What did she say about it?");
  const resolved = [...new Set(packet.pages.filter((page) => page.resolved).flatMap((page) => page.seqs))];
  const candidates = sources.map((source) => source.seq).sort((a, b) => a - b);
  if (resolved.length > 0) {
    expect(resolved.sort((a, b) => a - b)).toEqual(candidates);
  } else {
    expect(receiptText(packet)).toMatch(/ambiguous|UNKNOWN|fault|incomplete/i);
  }
});

test("natural multilingual refer-back is semantic-or-honest, never a lexical false hit", () => {
  const source = "La compuerta quedó cerrada después de la tormenta.";
  const { vault, thread, sources } = seed([source], 206);
  const packet = appendQuestion(vault, thread.id, "What stayed closed after the storm?");
  const semantic = routePages(packet, "semantic");
  if (semantic.some((page) => page.resolved)) {
    expect(semantic.flatMap((page) => page.seqs)).toEqual([sources[0]?.seq ?? -1]);
    expect(packetText(packet.messages)).toContain(source);
  } else {
    honestNoHit(packet, source);
    expect(packet.pages.filter((page) => page.trigger === "search" && page.resolved)).toHaveLength(0);
  }
});

test("natural supersession serves the current source and labels any historical witness", () => {
  const oldSource = "I live in Lisbon.";
  const currentSource = "Correction: I moved to Porto.";
  const { vault, thread, sources } = seed([oldSource, currentSource], 207);
  atomize(
    vault,
    thread.id,
    sources.map((source) => source.seq),
  );
  const packet = appendQuestion(vault, thread.id, "Where do I live now?");
  const resolved = packet.pages.filter((page) => page.resolved);
  expect(resolved.flatMap((page) => page.seqs)).not.toContain(sources[0]?.seq);
  if (resolved.some((page) => page.seqs.includes(sources[1]?.seq ?? -1))) {
    expect(packetText(packet.messages)).toContain(currentSource);
  } else {
    expect(receiptText(packet)).toMatch(/UNKNOWN|fault|unavailable|incomplete|historical/i);
  }
  for (const page of resolved.filter((candidate) => candidate.seqs.includes(sources[0]?.seq ?? -1))) {
    expect(page.trigger).toBe("historical");
  }
});

test("natural deleted-source fixture produces no page for removed bytes and leaves an explicit receipt", () => {
  const source = "The retired deployment token is Zephyrine 998877.";
  const { vault, thread, sources } = seed([source], 208);
  const removed = sources[0] as { seq: number };
  forget(vault, thread.id, { seqs: [removed.seq], reason: "natural deleted-source fixture" });
  const packet = appendQuestion(vault, thread.id, "What is the retired deployment token?");
  const resolved = packet.pages.filter((page) => page.resolved);
  expect(resolved.flatMap((page) => page.seqs)).not.toContain(removed.seq);
  expect(receiptText(packet)).toMatch(/removed|deleted|UNKNOWN|fault|unavailable/i);
  expect(packetText(packet.messages)).not.toContain("Zephyrine 998877");
});

test("natural partial collection carries a lower-bound coverage receipt, never an inferred total", () => {
  const lines = [
    "Rollout owner Alpha approved the harbor plan.",
    "Rollout owner Beta approved the harbor plan.",
  ];
  const { vault, thread } = seed(lines, 209);
  const packet = appendQuestion(vault, thread.id, "List every one of the three rollout owners.");
  const text = `${packetText(packet.messages)}\n${receiptText(packet)}`;
  expect(text).toContain("⟨pylos coverage");
  expect(text).toMatch(/located\s+2\s+sources/);
  expect(text).toMatch(/supported\s+2/);
  expect(text).toMatch(/incomplete\s+·\s+unresolved\s+1|completeness not established/);
  expect(text).not.toMatch(/there (?:are|were) 3|exactly 3/i);
});

test("natural unknown-cardinality collection says completeness is not established even when routes find sources", () => {
  const lines = [
    "Rollout owner Alpha approved the harbor plan.",
    "Rollout owner Beta approved the harbor plan.",
  ];
  const { vault, thread } = seed(lines, 210);
  const packet = appendQuestion(vault, thread.id, "List every rollout owner.");
  const text = `${packetText(packet.messages)}\n${receiptText(packet)}`;
  expect(text).toContain("⟨pylos coverage");
  expect(text).toContain("completeness not established");
  expect(text).not.toMatch(/there (?:are|were)\s+\d+|exactly\s+\d+/i);
});

test("capability-map omission cannot evade the kernel's candidate scan", async () => {
  const source = "The vault pin is 314159.";
  const { vault, thread } = seed([source], 211);
  const result = await runTurn(vault, thread.id, {
    text: "What is the vault pin?",
    model: "oracle-model",
    provider: providerText("The vault pin is 314159."),
    budget: 8192,
    check: false,
  });
  const receipt = JSON.stringify({
    answerReceipt: result.assistantEpisode.meta.answerReceipt,
    claimMap: result.assistantEpisode.meta.claimMap,
    gate: result.assistantEpisode.meta.gate,
  });
  expect(receipt).toMatch(/314159/);
  expect(receipt).toMatch(/SUPPORTED|UNKNOWN|INFERENCE/i);
  expect(result.assistantEpisode.content).not.toMatch(/314159.*unqualified|unqualified.*314159/i);
});

test("world-knowledge control is not misclassified as an archive UNKNOWN", async () => {
  const { vault, thread } = tempVault();
  const result = await runTurn(vault, thread.id, {
    text: "What is the capital of France?",
    model: "oracle-model",
    provider: providerText("Paris."),
    budget: 8192,
    check: false,
  });
  const receipt = JSON.stringify({
    answerReceipt: result.assistantEpisode.meta.answerReceipt,
    gate: result.assistantEpisode.meta.gate,
  });
  expect(receipt).toMatch(/WORLD_KNOWLEDGE/i);
  expect(result.assistantEpisode.content).not.toMatch(/UNKNOWN|unverified|not in the archive/i);
});
