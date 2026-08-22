/**
 * The console's four routes.
 *
 * Every card the console renders has to be archive material or a certificate
 * derived from it. These tests check the routing against the corpus itself: if
 * a card ever cites a turn whose text is not the text `episodeAt` produces, the
 * exhibit is inventing, and that is the one thing this page may not do.
 */
import { describe, expect, test } from "bun:test";
import { answer, MEMORY_PROBE, PERSON_PROBE, SEQUENCE_PROBE, turnRef } from "../src/aperture/console";
import { corpus, REVISION_SEQ, TOTAL_TURNS, TRAP_QUESTION } from "../src/aperture/thread";

const text = (question: string): string =>
  answer(question)
    .lines.map((line) => line.text)
    .join("\n");

describe("the sequence route", () => {
  test("reads a turn number as an address, not as a value", () => {
    expect(turnRef("What did I say on turn 345?")).toBe(345);
    expect(turnRef("#483112")).toBe(483_112);
    expect(turnRef("turn 1,000,000")).toBe(TOTAL_TURNS);
    expect(turnRef("I have 345 apples")).toBeNull();
    expect(turnRef(`turn ${TOTAL_TURNS + 1}`)).toBeNull();
  });

  test("returns the exact archived turn", () => {
    const card = answer(`What did I say on turn ${SEQUENCE_PROBE}?`);
    expect(card.seq).toBe(SEQUENCE_PROBE);
    expect(card.headline).toContain(`#${SEQUENCE_PROBE}`);
    expect(card.headline).toContain("sequence");
    expect(text(card.question)).toContain(corpus.episodeAt(SEQUENCE_PROBE).content);
  });

  test("works at any position in the archive, not only where the demo points", () => {
    for (const seq of [1, 2, 12_345, 700_001, TOTAL_TURNS]) {
      expect(text(`#${seq}`)).toContain(corpus.episodeAt(seq).content);
    }
  });
});

describe("the trap", () => {
  test("answers from the resident certificate and shows both versions of the rule", () => {
    const card = answer(TRAP_QUESTION);
    expect(card.seq).toBe(REVISION_SEQ);
    expect(card.trap).toBe(true);
    const kinds = card.lines.map((line) => line.kind);
    expect(kinds).toContain("cert");
    expect(kinds).toContain("historical");
    const body = text(TRAP_QUESTION);
    expect(body).toContain("additive-only");
    expect(body).toContain(`⟨historical #1→#${REVISION_SEQ}⟩`);
    // The exact turn the certificate points at, verbatim.
    expect(body).toContain(corpus.episodeAt(REVISION_SEQ).content);
  });
});

describe("the authority route", () => {
  test("the user's value is the certificate; the assistant's is a proposal", () => {
    const card = answer(PERSON_PROBE.query);
    const cert = card.lines.find((line) => line.kind === "cert");
    const proposal = card.lines.find((line) => line.kind === "proposal");
    expect(cert?.text).toContain(`${PERSON_PROBE.key} = ${PERSON_PROBE.value1}`);
    expect(cert?.text).toContain(`⟨#${PERSON_PROBE.statedSeq}⟩`);
    expect(proposal?.text).toContain(`${PERSON_PROBE.key} ≈ ${PERSON_PROBE.value2}`);
    expect(proposal?.text).toContain(`proposed by assistant #${PERSON_PROBE.claimSeq}`);
    expect(proposal?.text).toContain("unconfirmed");
    // and the assistant's claim is quoted from the archive, not paraphrased
    expect(text(PERSON_PROBE.query)).toContain(corpus.episodeAt(PERSON_PROBE.claimSeq).content);
  });
});

describe("the lexical route", () => {
  test("finds a memory with no name in it, by its stemmed terms", () => {
    const card = answer(MEMORY_PROBE.query);
    expect(card.seq).toBe(MEMORY_PROBE.seq);
    expect(card.headline).toContain("lexical");
    expect(text(MEMORY_PROBE.query)).toContain(MEMORY_PROBE.text);
    expect(corpus.episodeAt(MEMORY_PROBE.seq).content).toBe(MEMORY_PROBE.text);
  });

  test("every planted memory is reachable from its own question", () => {
    for (const memory of corpus.planted.memories.slice(0, 50)) {
      const card = answer(memory.query);
      expect(card.seq).toBe(memory.seq);
    }
  });
});

describe("the ledger route", () => {
  test("a quote comes back byte for byte, with its span marked", () => {
    const quote = corpus.planted.quotes[0];
    if (!quote) throw new Error("no planted quotes");
    const card = answer(quote.query);
    expect(card.seq).toBe(quote.seq);
    expect(card.headline).toContain("ledger");
    expect(text(card.question)).toContain(corpus.episodeAt(quote.seq).content);
    expect(card.lines[0]?.mark).toBe(quote.text);
  });

  test("a number comes back with its unit", () => {
    const number = corpus.planted.numbers[0];
    if (!number) throw new Error("no planted numbers");
    const card = answer(number.query);
    expect(card.seq).toBe(number.seq);
    expect(card.lines[0]?.mark).toContain(number.valueText);
  });
});

describe("when nothing routes", () => {
  test("the console says so rather than answering anyway", () => {
    const card = answer("what is the capital of Bolivia?");
    expect(card.seq).toBeNull();
    expect(card.headline).toContain("no route fired");
    expect(text(card.question)).toContain("does not guess");
  });
});
