import { afterAll, expect, test } from "bun:test";
import { compact, compile, packetText, page, recall, sequenceRefs } from "../src/index.ts";
import { cleanup, rng, syntheticTurn, tempVault } from "./helpers.ts";

afterAll(cleanup);

/**
 * A long thread with one memory that carries no routing name at all — the
 * failure the second audit found: exact bytes on disk, no address to reach them.
 */
function longThread(size: number, planted: Map<number, string> = new Map()) {
  const { vault, thread } = tempVault();
  const next = rng(77);
  for (let i = 0; i < size; i += 64) {
    const batch = Array.from({ length: Math.min(64, size - i) }, (_, k) => {
      const seq = i + k + 1;
      const content = planted.get(seq);
      return {
        role: (seq % 2 === 1 ? "user" : "assistant") as "user" | "assistant",
        content: content ?? syntheticTurn(next, seq),
      };
    });
    vault.episodes.appendMany(thread.id, batch);
    compact(vault, thread.id, { budget: 8192 });
  }
  return { vault, thread };
}

const targets = (query: string) => sequenceRefs(query).map(({ from, to }) => ({ from, to }));

test("turn references are cue words, never bare numbers (KERNEL A9.3)", () => {
  expect(targets("what did I say on turn 345?")).toEqual([{ from: 345, to: 345 }]);
  expect(targets("look at #345 again")).toEqual([{ from: 345, to: 345 }]);
  expect(targets("turns 10-12 please")).toEqual([{ from: 10, to: 12 }]);
  expect(targets("the 345th message")).toEqual([{ from: 345, to: 345 }]);
  expect(targets("episode 7 and seq 9")).toEqual([
    { from: 7, to: 7 },
    { from: 9, to: 9 },
  ]);
  expect(targets("I have 345 apples")).toEqual([]);
  expect(targets("nothing numeric here")).toEqual([]);
  // Someone else's numbering is not ours.
  expect(targets("see issue #12")).toEqual([]);
  expect(targets("PR #12 broke it")).toEqual([]);
  expect(targets("gh#12")).toEqual([]);
  // Ranges are capped, and so is the number of references.
  expect(targets("turns 100-999")).toEqual([{ from: 100, to: 105 }]);
  expect(targets("turn 1, turn 2, turn 3, turn 4")).toHaveLength(3);
  // The span is reported so the pager can consume it before names() runs.
  expect(sequenceRefs("what did I say on turn 345?")[0]).toEqual({
    from: 345,
    to: 345,
    start: 18,
    end: 26,
  });
});

test("a query naming a turn pages that turn exactly, at any archive size", () => {
  const { vault, thread } = longThread(4000, new Map([[345, "The kiln at Sagres fired unevenly."]]));

  const packet = compile(vault, thread.id, { query: "what did I say on turn 345?", budget: 8192 });
  const text = packetText(packet.messages);
  expect(text).toContain("⟦recovered #345 · user · sequence⟧");
  expect(text).toContain("The kiln at Sagres fired unevenly.");
  const record = packet.pages.find((p) => p.trigger === "sequence");
  expect(record?.resolved).toBe(true);
  expect(record?.seqs).toContain(345);
  expect(packet.tokens).toBeLessThanOrEqual(8192);
});

test("an address is not a value: turn 345 does not also route the number 345", () => {
  const { vault, thread } = longThread(1024, new Map([[345, "The kiln at Sagres fired unevenly."]]));
  compact(vault, thread.id, { budget: 8192 });
  const result = page(vault, thread.id, { query: "what did I say on turn 345?", budget: 2000 });
  expect(result.records).toHaveLength(1);
  expect(result.records[0]?.trigger).toBe("sequence");
  expect(result.records.some((r) => r.trigger === "ledger")).toBe(false);
});

test("a turn already in the view is not paged again", () => {
  const { vault, thread } = longThread(64);
  const result = page(vault, thread.id, {
    query: "what did I say on turn 12?",
    budget: 2000,
    residentSeqs: new Set([12]),
    search: false,
  });
  expect(result.records).toEqual([]);
  expect(result.blocks).toEqual([]);
});

test("a range pages each turn in it; an impossible turn is UNKNOWN, not a guess", () => {
  const { vault, thread } = longThread(256);

  const ranged = page(vault, thread.id, { query: "show me turns 10-12", budget: 2000 });
  expect(ranged.records[0]?.trigger).toBe("sequence");
  expect(ranged.records[0]?.seqs.slice(0, 3)).toEqual([10, 11, 12]);

  const beyond = page(vault, thread.id, { query: "what happened on turn 999999?", budget: 2000 });
  const record = beyond.records.find((r) => r.trigger === "sequence");
  expect(record?.resolved).toBe(false);
  expect(record?.seqs).toEqual([]);

  const bare = page(vault, thread.id, { query: "I have 345 apples", budget: 2000 });
  expect(bare.records.some((r) => r.trigger === "sequence")).toBe(false);
});

test("free-text recall searches the archive even when the query names nothing", () => {
  const planted = new Map([[450, "the tea tasted smoky after the rain."]]);
  const { vault, thread } = longThread(4096, planted);

  const found = recall(vault, thread.id, { query: "what did the tea taste like after the rain" });
  expect(found.text).toContain("the tea tasted smoky after the rain.");
  expect(found.result.records.some((r) => r.resolved)).toBe(true);

  // Paraphrase with no lexical overlap is not found deterministically. That is
  // what the model's own rewording is for; the kernel never guesses.
  const missed = recall(vault, thread.id, { query: "flavour of storm" });
  expect(missed.text).toContain("UNKNOWN");
});

test("a question no deterministic route answers falls back to lexical search", () => {
  const planted = new Map([[450, "the tea tasted smoky after the rain."]]);
  const { vault, thread } = longThread(4096, planted);

  const packet = compile(vault, thread.id, {
    query: "what did the tea taste like after the rain?",
    budget: 8192,
  });
  const search = packet.pages.find((p) => p.trigger === "search");
  expect(search?.resolved).toBe(true);
  expect(search?.seqs).toContain(450);
  expect(packetText(packet.messages)).toContain("the tea tasted smoky after the rain.");
});

test("a name-free question still searches when the previous reply carried routable names", () => {
  const planted = new Map([[450, "the tea tasted smoky after the rain."]]);
  const { vault, thread } = longThread(4096, planted);
  // The previous assistant turn names a value the ledger knows; that route may
  // resolve, but it answers the model's sentence, not this name-free question.
  const prev = vault.episodes.get(thread.id, 4096)?.content ?? "";
  const result = page(vault, thread.id, {
    query: "how did the tea taste after the rain?",
    prevAssistant: `${prev} The p50 latency is 250 ms; I will keep an eye on it.`,
    budget: 1500,
    search: true,
  });
  const search = result.records.find((r) => r.trigger === "search");
  expect(search?.resolved).toBe(true);
  expect(search?.seqs).toContain(450);
});

test("the previous reply's names never starve the question being asked", () => {
  const planted = new Map([[450, "the tea tasted smoky after the rain."]]);
  const { vault, thread } = longThread(4096, planted);
  // Three names the ledger knows, all from the model's previous sentence: on a
  // small budget that is the whole paged slot if they route first.
  const sample = vault.db
    .query("SELECT DISTINCT name FROM loss WHERE thread_id = ? AND kind = 'entity' LIMIT 3")
    .all(thread.id) as Array<{ name: string }>;
  expect(sample.length).toBe(3);
  const result = page(vault, thread.id, {
    query: "how did the tea taste after the rain?",
    prevAssistant: `Noted: ${sample.map((r) => r.name).join(", ")}.`,
    budget: 1350,
    search: true,
  });
  const search = result.records.findIndex((r) => r.trigger === "search");
  expect(search).toBeGreaterThanOrEqual(0);
  expect(result.records[search]?.resolved).toBe(true);
  expect(result.records[search]?.seqs).toContain(450);
  // routes fired for the previous reply come after the search, never before
  const prevRoute = result.records.findIndex((r) => r.trigger === "ledger" || r.trigger === "historical");
  expect(prevRoute === -1 || prevRoute > search).toBe(true);
});
