/**
 * The corpus is a wire format in everything but name: `bench/results/*.json`
 * quote its manifest digest, and a landing page compiles the same million turns
 * in a browser. The literals below were computed from the generator as it stood
 * when it moved out of `bench/` and into `pure/`; if one of them changes, the
 * bench is measuring a different thread and the published numbers no longer
 * describe it.
 */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256Hex } from "../src/pure/corpus/sha256.ts";
import { createCorpus, names, REVISION_TEXT, RULE_TEXT, TRAP_TEXT, vocabSha256 } from "../src/pure/index.ts";

const SEED = "1";
const N = 1_000_000;
const corpus = createCorpus(SEED, N);

test("sha256 agrees with node:crypto", () => {
  for (const message of ["", "abc", "1:layout:483112", "x".repeat(55), "y".repeat(56), "é☃𝄞"]) {
    expect(sha256Hex(message)).toBe(createHash("sha256").update(message, "utf8").digest("hex"));
  }
});

test("the frozen vocabulary is the one the results files name", () => {
  expect(vocabSha256()).toBe("8c4fc29851de49b1299ceb8c9921d499d5f1fa77a3515b39ac4f5f26bb3d5362");
});

test("the manifest for seed 1 at a million turns is unchanged", () => {
  const digest = createHash("sha256").update(JSON.stringify(corpus.manifest)).digest("hex");
  expect(digest).toBe("9b114fc3eb2785ace99e38a7043049f1b9af4cf86bb76d4636a34f7303b70b39");
  expect(corpus.manifest.ruleSeq).toBe(1);
  expect(corpus.manifest.revisionSeq).toBe(483_112);
  expect(corpus.manifest.trapSeq).toBe(N);
  expect(corpus.manifest.handoffs).toEqual([250_000, 600_002, 800_001]);
  expect(corpus.planted.facts.length).toBe(2000);
  expect(corpus.planted.quotes.length).toBe(200);
  expect(corpus.planted.numbers.length).toBe(50);
  expect(corpus.planted.memories.length).toBe(2000);
  expect(corpus.planted.persons.length).toBe(200);
});

test("episodeAt is the exact text of the turn, at both ends of the archive", () => {
  expect(corpus.episodeAt(1)).toEqual({ role: "user", content: RULE_TEXT });
  expect(corpus.episodeAt(345)).toEqual({ role: "user", content: "Long day. Grey but dry." });
  expect(corpus.episodeAt(483_112)).toEqual({ role: "user", content: REVISION_TEXT });
  expect(corpus.episodeAt(N)).toEqual({ role: "user", content: TRAP_TEXT });
  expect(corpus.episodeAt(250_000)).toEqual({
    role: "handoff",
    content: "llama3.1:8b stopped here. grok-4.6 continued from the same thread.",
  });
});

test("the first 200,000 turns hash to the same stream they always have", () => {
  const digest = createHash("sha256");
  for (let seq = 1; seq <= 200_000; seq += 1) {
    const episode = corpus.episodeAt(seq);
    digest.update(`${seq}\t${episode.role}\t${episode.model ?? ""}\t${episode.content}\n`);
  }
  expect(digest.digest("hex")).toBe("d7060ded98e130168b3aa604efa907be7c4a5950975c0932f6a3448cf3e62bbb");
});

test("planted memories carry no routing name — the lexical route is their only address", () => {
  for (const memory of corpus.planted.memories.slice(0, 200)) {
    expect(names(memory.text)).toEqual([]);
    expect(corpus.episodeAt(memory.seq).content).toBe(memory.text);
  }
});

test("planted values are exactly where the manifest says they are", () => {
  const fact = corpus.planted.facts[0];
  if (!fact) throw new Error("no planted facts");
  expect(corpus.episodeAt(fact.seq1).content).toContain(fact.value1);
  expect(corpus.episodeAt(fact.seq2).content).toContain(fact.value2);

  const quote = corpus.planted.quotes[0];
  if (!quote) throw new Error("no planted quotes");
  const text = corpus.episodeAt(quote.seq).content;
  expect(text.slice(quote.span[0], quote.span[1])).toBe(quote.text);

  const poisoned = corpus.planted.persons.find((p) => p.variant === "A");
  if (!poisoned?.statedSeq) throw new Error("no A-variant poison");
  expect(corpus.episodeAt(poisoned.statedSeq)).toEqual({
    role: "user",
    content: `${poisoned.person} lives in ${poisoned.value1}.`,
  });
  expect(corpus.episodeAt(poisoned.claimSeq).role).toBe("assistant");
  expect(corpus.episodeAt(poisoned.claimSeq).content).toContain(poisoned.value2);
});

test("a shorter run scales the plants and moves the revision with it", () => {
  const small = createCorpus(SEED, 2000, { plants: { facts: 40, quotes: 10, numbers: 10 } });
  expect(small.manifest.revisionSeq).toBe(966);
  expect(small.planted.facts.length).toBe(40);
  expect(small.episodeAt(966).content).toBe(REVISION_TEXT);
  expect(small.episodeAt(2000).content).toBe(TRAP_TEXT);
});
