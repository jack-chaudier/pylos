import { afterAll, expect, test } from "bun:test";
import type { Episode, PageRecord } from "@pylos/protocol";
import {
  approxTokens,
  compact,
  compile,
  FAULT_NOTICE_NO_TOOLS,
  FAULT_NOTICE_TOOLS,
  forget,
  type Provider,
  packetText,
  page,
  recall,
  runTurn,
  sequenceRefs,
} from "../src/index.ts";
import { renderUnknownPages } from "../src/pure/index.ts";
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
  // Turn numbers are read as the interface prints them (KERNEL A11.3).
  expect(targets("what did I say on turn 483,112?")).toEqual([{ from: 483112, to: 483112 }]);
  expect(targets("#483,112")).toEqual([{ from: 483112, to: 483112 }]);
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

/**
 * A thread whose last reply names nothing routable. The previous assistant turn
 * is a route of its own (KERNEL A9.4), and a turn it answers is not a fault.
 */
function quietThread(size: number, planted: Map<number, string> = new Map()) {
  const built = longThread(size, planted);
  built.vault.episodes.append(built.thread.id, { role: "assistant", content: "Noted." });
  return built;
}

test("a question no route can reach records a fault, not silence (KERNEL A11.1)", () => {
  const { vault, thread } = quietThread(1024);

  // One searchable term: the lexical route cannot even fire, so nothing was
  // tried but the question's own words — exactly what the fault says.
  const packet = compile(vault, thread.id, { query: "what did we decide?", budget: 8192 });
  expect(packet.pages.map((p) => p.trigger)).toEqual(["fault"]);
  expect(packet.pages[0]?.resolved).toBe(false);
  expect(packet.pages[0]?.seqs).toEqual([]);
  expect(packet.pages[0]?.tokens).toBe(approxTokens(FAULT_NOTICE_TOOLS));
  const text = packetText(packet.messages);
  expect(text).toContain(FAULT_NOTICE_TOOLS);
  expect(text).toContain("That says nothing about whether the archive holds the answer.");
  expect(text).not.toContain("⟨UNKNOWN");
  expect(packet.tokens).toBeLessThanOrEqual(8192);
  expect(packet.resident.some((r) => r.type === "paged" && r.ref === "fault")).toBe(true);

  // The search ran and found nothing: the fault line replaces the UNKNOWN line
  // for its own record, so the question is named once, not twice.
  const searched = compile(vault, thread.id, {
    query: "what did we decide about the awning?",
    budget: 8192,
  });
  expect(searched.pages.map((p) => p.trigger)).toEqual(["search", "fault"]);
  const unknown = /⟨UNKNOWN[^⟩]*⟩/.exec(packetText(searched.messages))?.[0] ?? "";
  expect(unknown).toContain("what did we decide about the awning?");
  expect(unknown.split("awning")).toHaveLength(2);
  expect(packetText(searched.messages)).toContain("⟨pylos fault⟩");
  expect(searched.tokens).toBeLessThanOrEqual(8192);
});

test("the fault is about routing: a hit, a turn in view or a question about the world do not (KERNEL A11.1)", () => {
  const planted = new Map([[450, "we settled on the copper awning for the terrace."]]);
  const { vault, thread } = quietThread(1024, planted);

  const found = compile(vault, thread.id, { query: "what did we decide about the awning?", budget: 8192 });
  expect(found.pages.find((p) => p.trigger === "search")?.resolved).toBe(true);
  expect(found.pages.some((p) => p.trigger === "fault")).toBe(false);
  expect(packetText(found.messages)).not.toContain("⟨pylos fault⟩");

  // The turn reference addressed the view: the material is here, nothing missed.
  const resident = page(vault, thread.id, {
    query: "what did I say on turn 3?",
    budget: 2000,
    residentSeqs: new Set([3]),
    search: false,
  });
  expect(resident.records).toEqual([]);
  const withSearch = page(vault, thread.id, {
    query: "what did I say on turn 3?",
    budget: 2000,
    residentSeqs: new Set([3]),
  });
  expect(withSearch.records.some((r) => r.trigger === "fault")).toBe(false);

  // A question about the world, not about the conversation.
  const world = compile(vault, thread.id, { query: "what is a monad?", budget: 8192 });
  expect(world.pages.some((p) => p.trigger === "fault")).toBe(false);

  // The search reaches a turn the view already holds, and that turn carries
  // every term of the question: the view is answering, so nothing is served and
  // nothing faults — the case a resident planted memory hit in the bench.
  const inView = page(vault, thread.id, {
    query: "what did we settle on for the copper awning on the terrace?",
    budget: 2000,
    residentSeqs: new Set([450]),
  });
  expect(inView.records.some((r) => r.trigger === "fault")).toBe(false);
  // …and it writes no search receipt: an unresolved record here would render
  // `⟨UNKNOWN: no exact material found for …⟩` about material the packet holds.
  expect(inView.records.find((r) => r.trigger === "search")).toBeUndefined();
  expect(renderUnknownPages(inView.records)).toBe("");
});

test("a model without tools is told to abstain rather than to recall (KERNEL A11.1)", () => {
  const { vault, thread } = quietThread(256);
  const packet = compile(vault, thread.id, {
    query: "what did we decide?",
    budget: 8192,
    supportsTools: false,
  });
  const text = packetText(packet.messages);
  expect(text).toContain(FAULT_NOTICE_NO_TOOLS);
  expect(text).toContain("ask for a word from the original conversation");
  expect(text).not.toContain("call `recall` with other words");
});

test("a recall that finds nothing is UNKNOWN to the model, never a fault (KERNEL A11.1)", () => {
  const { vault, thread } = quietThread(256);
  const missed = recall(vault, thread.id, { query: "what was under the awning on the terrace?" });
  expect(missed.text).toContain("UNKNOWN");
  expect(missed.result.records.some((r) => r.trigger === "fault")).toBe(false);
});

/**
 * The question is appended before the view is compiled, so it sits in the index
 * like every other turn. Counted as a hit, it reported that every term of the
 * question had been found, the broader pass never ran, and a naturally worded
 * question — cue word, name, and the source's own terms — faulted on material
 * the archive held under a plainer wording (KERNEL A10.1).
 */
test("the question's own turn is never its own search hit (KERNEL A10.1, A11.1)", () => {
  const source = "Virgil crossed the glass bridge and promised it would sing before dawn.";
  const { vault, thread } = quietThread(512, new Map([[120, source]]));
  const ask = (text: string) => {
    const question = vault.episodes.append(thread.id, { role: "user", content: text });
    return compile(vault, thread.id, { query: text, turnSeq: question.seq, budget: 8192 });
  };

  // "did … say" is the cue and "say" is not a word of the source: the strict
  // pass can only match the question itself, so the fallback must still run.
  const natural = ask("What did Virgil say about the glass bridge?");
  expect(natural.pages.find((p) => p.trigger === "search")?.seqs).toEqual([120]);
  expect(natural.pages.some((p) => p.trigger === "fault")).toBe(false);
  expect(packetText(natural.messages)).toContain(source);

  // The wording that always worked still works.
  const control = ask("What Virgil glass bridge?");
  expect(control.pages.find((p) => p.trigger === "search")?.seqs).toEqual([120]);
});

const SOURCE = "The kiln at Sagres fired unevenly because the flue was blocked.";

/** A provider that answers with one fixed sentence. */
const scripted = (text: string): Provider =>
  async function* () {
    yield { type: "delta", text };
    yield { type: "done" };
  };

/**
 * A thread that has already reached #451 three ways — a question the search
 * answered, a question that addressed it by number, and a statement that did —
 * and then buried all of them under later turns. Those turns are the path's
 * index; the packets they left are the edges back to the source (KERNEL A11.2).
 */
async function answeredThread(): Promise<{
  vault: ReturnType<typeof tempVault>["vault"];
  threadId: string;
  reply: Episode;
  memo: Episode;
  note: Episode;
}> {
  const { vault, thread } = longThread(1024, new Map([[451, SOURCE]]));
  const answered = await runTurn(vault, thread.id, {
    text: "why did the kiln fire unevenly?",
    model: "m",
    provider: scripted("The firing problem came from a clogged vent duct."),
    budget: 8192,
    check: false,
  });
  const asked = await runTurn(vault, thread.id, {
    text: "what did the vent gasket memo cover on turn 451?",
    model: "m",
    provider: scripted("Noted."),
    budget: 8192,
    check: false,
  });
  const stated = await runTurn(vault, thread.id, {
    text: "Filing a note about turn 451 for the record: the marbled trellis latch stayed with me.",
    model: "m",
    provider: scripted("Noted."),
    budget: 8192,
    check: false,
  });
  const next = rng(21);
  for (let i = 0; i < 600; i += 1) {
    vault.episodes.append(thread.id, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: syntheticTurn(next, i),
    });
  }
  compact(vault, thread.id, { budget: 8192 });
  return {
    vault,
    threadId: thread.id,
    reply: answered.assistantEpisode,
    memo: asked.userEpisode,
    note: stated.userEpisode,
  };
}

test("a paraphrase reaches the source through the turn that answered it (KERNEL A11.2)", async () => {
  const { vault, threadId, reply, memo } = await answeredThread();

  // Shares words with the reply, none with the source.
  const viaReply = compile(vault, threadId, { query: "what was the clogged vent duct?", budget: 8192 });
  expect(viaReply.pages.find((p) => p.trigger === "search")?.seqs).toContain(reply.seq);
  const fromReply = viaReply.pages.find((p) => p.trigger === "path");
  expect(fromReply?.query).toBe(`#${reply.seq}`);
  expect(fromReply?.seqs).toEqual([451]);
  expect(fromReply?.resolved).toBe(true);
  const text = packetText(viaReply.messages);
  expect(text).toContain(`⟦recovered #451 · user · via #${reply.seq}⟧`);
  expect(text).toContain("via #n — reached by way of the turn that once answered a question with it");
  expect(text).toContain(SOURCE);
  // The path is bounded like every other page (KERNEL A11.2).
  expect(viaReply.tokens).toBeLessThanOrEqual(8192);
  expect(viaReply.pages.filter((p) => p.resolved).length).toBeLessThanOrEqual(3);

  // Shares words with the question, none with the source: the packet compiled
  // for that user turn is the edge, and it travelled no further than the vault.
  const viaQuestion = compile(vault, threadId, { query: "what was in the vent gasket memo?", budget: 8192 });
  expect(viaQuestion.pages.find((p) => p.trigger === "search")?.seqs).toContain(memo.seq);
  const fromQuestion = viaQuestion.pages.find((p) => p.trigger === "path");
  expect(fromQuestion?.query).toBe(`#${memo.seq}`);
  expect(fromQuestion?.seqs).toContain(451);
  expect(packetText(viaQuestion.messages)).toContain(SOURCE);
});

test("a user turn that asks nothing is not followed (KERNEL A11.2)", async () => {
  const { vault, threadId, note } = await answeredThread();
  const packet = compile(vault, threadId, {
    query: "what happened to the marbled trellis latch?",
    budget: 8192,
  });
  expect(packet.pages.find((p) => p.trigger === "search")?.seqs).toContain(note.seq);
  expect(packet.pages.some((p) => p.trigger === "path")).toBe(false);
  expect(packetText(packet.messages)).not.toContain(SOURCE);
});

test("a forgotten source is not served by the path, and records nothing (KERNEL A11.2)", async () => {
  const { vault, threadId, reply } = await answeredThread();
  forget(vault, threadId, { seqs: [451], reason: "test" });

  const packet = compile(vault, threadId, { query: "what was the clogged vent duct?", budget: 8192 });
  expect(packet.pages.find((p) => p.trigger === "search")?.seqs).toContain(reply.seq);
  expect(packet.pages.some((p) => p.trigger === "path")).toBe(false);
  expect(packetText(packet.messages)).not.toContain(SOURCE);
});

test("the path skips a source the view already holds (KERNEL A11.2)", async () => {
  const { vault, threadId, reply } = await answeredThread();
  const result = page(vault, threadId, {
    query: "what was the clogged vent duct?",
    budget: 2000,
    residentSeqs: new Set([451]),
  });
  expect(result.records.find((r) => r.trigger === "search")?.seqs).toContain(reply.seq);
  expect(result.records.some((r) => r.trigger === "path")).toBe(false);
});

test("the neighbour of a named turn follows the speaker cue (KERNEL A11.3)", () => {
  const { vault, thread } = longThread(64);
  // In this thread odd seqs are the user's turns and even seqs are the replies.
  const served = (query: string): number[] => {
    const result = page(vault, thread.id, { query, budget: 2000, search: false });
    return result.records.find((r) => r.trigger === "sequence")?.seqs ?? [];
  };

  // "I" about a reply wants the question that reply answered, not the turn after it.
  expect(served("what did I say on turn 12?")).toEqual([12, 11]);
  // "you" about a question wants the reply.
  expect(served("what did you say to turn 11?")).toEqual([11, 12]);
  // No cue: the turn after, as before.
  expect(served("show turn 12 again")).toEqual([12, 13]);
  // The bench asks this a million times: a user turn and its reply.
  expect(served("What did I say on turn 11?")).toEqual([11, 12]);
});

test("a route that fired on the previous reply's names does not silence the fault (KERNEL A11.1)", () => {
  const { vault, thread } = longThread(1024);
  // A name the ledger knows, carried only by the model's last sentence.
  const result = page(vault, thread.id, {
    query: "what did we decide?",
    prevAssistant: "Noted: Ada Okafor.",
    budget: 2000,
  });
  // The previous reply's route answered the model's sentence, not the question.
  expect(result.records.some((r) => r.trigger === "ledger" && r.resolved)).toBe(true);
  expect(result.records.at(-1)?.trigger).toBe("fault");
});

test("a view that holds the whole archive cannot fault (KERNEL A11.1)", () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "I moved to Porto last week." });
  const packet = compile(vault, thread.id, { query: "what did I just say?", budget: 8192 });
  expect(packet.pages.some((p) => p.trigger === "fault")).toBe(false);
  expect(packetText(packet.messages)).not.toContain("⟨pylos fault⟩");
});

test("the path follows locators in priority order, and only the question's own names (KERNEL A11.2)", () => {
  const planted = new Map([
    [451, "The kiln at Sagres fired unevenly."],
    [453, "A neighbour turn that the ledger record also served."],
    [455, "Bea Moreau reported the trellis latch."],
    [457, "The gasket order arrived on Tuesday."],
  ]);
  const { vault, thread } = longThread(1024, planted);
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "what happened with the kiln at Sagres?",
  });
  const receipt: PageRecord[] = [
    // Its locator is #451; #453 is a neighbour it also served, not an address.
    { trigger: "ledger", name: "sagres", seqs: [451, 453], tokens: 20, latencyMs: 0, resolved: true },
    // A name the question never used: that route answered the model's sentence.
    { trigger: "ledger", name: "bea moreau", seqs: [455], tokens: 20, latencyMs: 0, resolved: true },
    { trigger: "search", query: "gasket", seqs: [457], tokens: 20, latencyMs: 0, resolved: true },
  ];
  const packet = compile(vault, thread.id, {
    query: question.content,
    turnSeq: question.seq,
    budget: 8192,
  });
  vault.packets.insert(packet);
  vault.packets.finish(packet.id, receipt);
  const reply = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "The marbled vent duct clogged.",
    meta: { packetId: packet.id, pages: receipt },
  });
  const next = rng(23);
  for (let i = 0; i < 600; i += 1) {
    vault.episodes.append(thread.id, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: syntheticTurn(next, i),
    });
  }
  compact(vault, thread.id, { budget: 8192 });

  const asked = compile(vault, thread.id, { query: "what was the marbled vent duct clog?", budget: 8192 });
  expect(asked.pages.find((p) => p.trigger === "search")?.seqs).toContain(reply.seq);
  // Search before ledger, two pages at most, locators only.
  expect(asked.pages.find((p) => p.trigger === "path")?.seqs).toEqual([457, 451]);
  const text = packetText(asked.messages);
  expect(text).toContain(planted.get(457) as string);
  expect(text).toContain(planted.get(451) as string);
  expect(text).not.toContain(planted.get(453) as string);
  expect(text).not.toContain(planted.get(455) as string);
});

test("a recall keeps the path receipt while its own pages become the model's (KERNEL A11.2)", async () => {
  const { vault, threadId, reply } = await answeredThread();
  const served = recall(vault, threadId, { query: "what was the clogged vent duct?" });
  expect(served.text).toContain(SOURCE);
  const triggers = served.result.records.map((r) => r.trigger);
  expect(triggers).toContain("model");
  expect(triggers).toContain("path");
  expect(served.result.records.find((r) => r.trigger === "path")?.query).toBe(`#${reply.seq}`);
});

test("the neighbour walk steps over retrieved data, and falls back to +1 (KERNEL A11.3)", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(thread.id, [
    { role: "user", content: "Ship the kiln order on Friday." },
    { role: "tool", content: "lookup(order) → pending" },
    { role: "tool", content: "lookup(carrier) → booked" },
    { role: "tool", content: "lookup(invoice) → unpaid" },
    { role: "assistant", content: "Booked; the invoice is still open." },
    { role: "user", content: "Thanks." },
  ]);
  const walked = page(vault, thread.id, { query: "what did I say on turn 5?", budget: 2000, search: false });
  // #5 is the reply; the turn it answered is #1, three tool results back.
  expect(walked.records[0]?.seqs).toEqual([5, 1]);

  const { vault: lonely, thread: quiet } = tempVault();
  lonely.episodes.appendMany(
    quiet.id,
    Array.from({ length: 14 }, (_, i) => ({ role: "assistant" as const, content: `reply ${i + 1}` })),
  );
  lonely.episodes.append(quiet.id, { role: "user", content: "the last word" });
  const fallback = page(lonely, quiet.id, {
    query: "what did I say on turn 14?",
    budget: 2000,
    search: false,
  });
  // No user turn within reach: the neighbour is #15, as it always was.
  expect(fallback.records[0]?.seqs).toEqual([14, 15]);
});
