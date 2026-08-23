/**
 * The console's routes.
 *
 * Every card the console renders has to be archive material or a certificate
 * derived from it. These tests check the routing against the corpus itself: if
 * a card ever cites a turn whose text is not the text `episodeAt` produces, the
 * exhibit is inventing, and that is the one thing this page may not do. They
 * also fix the two ends of a miss: a question about the world is not a fault,
 * and a question that refers back and reaches nothing is. Between those ends
 * sits the name a visitor half-remembers — a first name, lower case, no
 * surname: that is a route, and its answer is the candidates.
 */
import { describe, expect, test } from "bun:test";
import {
  answer,
  MEMORY_PROBE,
  PERSON_PROBE,
  SEQUENCE_PROBE,
  SUGGESTIONS,
  TELL_EXAMPLE,
  turnRef,
} from "../src/aperture/console";
import { corpus, REVISION_SEQ, TOTAL_TURNS, TRAP_QUESTION } from "../src/aperture/thread";

const text = (question: string): string =>
  answer(question)
    .lines.map((line) => line.text)
    .join("\n");

describe("the sequence route", () => {
  test("reads a turn number as an address, not as a value", () => {
    expect(turnRef("What did I say on turn 345?")).toBe(345);
    expect(turnRef("#483112")).toBe(483_112);
    expect(turnRef("What did I say on turn 483,112?")).toBe(483_112);
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

describe("the name route", () => {
  const [firstName, surname] = PERSON_PROBE.person.split(" ") as [string, string];
  const plantedPeople = new Set<string>([
    ...corpus.planted.facts.map((f) => f.person),
    ...corpus.planted.persons.map((p) => p.person),
    ...corpus.planted.quotes.map((q) => q.person),
    ...corpus.planted.numbers.map((n) => n.person),
  ]);
  /** The people a card offers, without the `and N more` tail. */
  const candidates = (line: string): string[] =>
    (line.split(" — ")[0] as string).split(" · ").filter((name) => !name.startsWith("and "));

  test("a first name the thread holds is a route, however the visitor writes it", () => {
    for (const query of [
      `Where does ${firstName} live?`,
      `where does ${firstName.toLowerCase()} live`,
      `who is ${firstName}`,
      firstName,
      surname.toLowerCase(),
    ]) {
      const card = answer(query);
      expect(card.headline).toContain("ambiguous");
      expect(card.seq).toBeNull();
      expect(card.lines[0]?.kind).toBe("absent");
      // and every person it offers is one the corpus really planted
      for (const name of candidates(card.lines[0]?.text ?? "")) expect(plantedPeople).toContain(name);
      expect(card.meta.join(" ")).not.toContain("fault");
    }
  });

  test("the full name resolves to one certificate, in any case", () => {
    const chip = answer(`Where does ${PERSON_PROBE.person} live now?`);
    for (const query of [
      `where does ${PERSON_PROBE.person.toLowerCase()} live now?`,
      `WHERE DOES ${PERSON_PROBE.person.toUpperCase()} LIVE NOW?`,
      `${firstName.toLowerCase()} ${surname.toLowerCase()}`,
    ]) {
      const card = answer(query);
      expect(card.seq).toBe(chip.seq);
      expect(card.lines.map((line) => line.text)).toEqual(chip.lines.map((line) => line.text));
    }
  });

  test("a question that refers back with a name the thread holds is not a fault", () => {
    const card = answer(`Where did I say ${firstName} lives?`);
    expect(card.headline).not.toContain("page fault");
    expect(card.headline).not.toContain("not a memory");
    expect(card.meta).not.toContain("trigger fault");
  });
});

describe("the chips", () => {
  test("each chip is the question it asks, and each one routes", () => {
    expect(SUGGESTIONS).toContain(TELL_EXAMPLE);
    for (const suggestion of SUGGESTIONS) {
      if (suggestion === TELL_EXAMPLE) continue; // asked once, in the append tests below
      const card = answer(suggestion);
      expect(card.question).toBe(suggestion);
      expect(card.seq).not.toBeNull();
      expect(card.headline).not.toContain("page fault");
      expect(card.headline).not.toContain("not a memory");
    }
  });
});

describe("when nothing routes", () => {
  test("a question about the world is not a fault", () => {
    for (const query of ["what is the capital of Bolivia?", "how does a diesel engine start?"]) {
      const card = answer(query);
      expect(card.seq).toBeNull();
      expect(card.headline).toBe("⟦not a memory⟧");
      expect(text(query)).toContain("A model would answer it from the world");
      expect(card.meta.join(" ")).not.toContain("fault");
    }
  });

  test("a question that refers back and reaches nothing is a fault (KERNEL A11.1)", () => {
    const card = answer("what did I say about the glass bridge?");
    expect(card.seq).toBeNull();
    expect(card.headline).toContain("page fault");
    expect(card.headline).toContain("no route fired");
    expect(card.meta).toContain("trigger fault");
    expect(text(card.question)).toContain("does not guess");
  });
});

// `remember:` mutates the thread this module holds, so these run last — and
// each `remember:` is asked exactly once, or it would append twice.
describe("telling the thread something", () => {
  test("`remember:` appends a turn after the millionth", () => {
    const card = answer(TELL_EXAMPLE);
    expect(card.seq).toBe(TOTAL_TURNS + 1);
    expect(card.headline).toBe("⟦appended #1,000,001 · user⟧");
    expect(card.lines[0]?.text).toContain("my dog is called Biscuit");
  });

  test("and the same routes reach it again: lexical, by name, by number", () => {
    const byWords = answer("what is my dog called?");
    expect(byWords.seq).toBe(TOTAL_TURNS + 1);
    expect(byWords.headline).toContain("lexical");
    expect(byWords.lines[0]?.text).toContain("my dog is called Biscuit");

    const byName = answer("who is Biscuit?");
    expect(byName.seq).toBe(TOTAL_TURNS + 1);
    expect(byName.headline).toContain("name");

    expect(turnRef(`turn ${TOTAL_TURNS + 1}`)).toBe(TOTAL_TURNS + 1);
    const byNumber = answer(`What did I say on turn ${TOTAL_TURNS + 1}?`);
    expect(byNumber.seq).toBe(TOTAL_TURNS + 1);
    expect(byNumber.headline).toContain("sequence");
  });

  test("a second one lands on the next turn, and the first still answers", () => {
    const second = answer("remember: the harbour siren rang at dusk over the quiet estuary");
    expect(second.seq).toBe(TOTAL_TURNS + 2);
    expect(answer("what did the harbour siren do at dusk?").seq).toBe(TOTAL_TURNS + 2);
    expect(answer("who is Biscuit?").seq).toBe(TOTAL_TURNS + 1);
  });
});
