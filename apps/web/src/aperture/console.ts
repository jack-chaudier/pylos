/**
 * The console — the part of the exhibit a visitor can drive.
 *
 * The aperture streams a million turns through the compiler; this puts
 * questions to that archive. Five routes, each the one the kernel would use:
 *
 *   sequence   a turn number is an address (KERNEL A9.3) — `episodeAt(n)` is
 *              exact for every n, because the thread is a function of the seed
 *   frontier   the standing rule is a certificate; the revision replaced its
 *              value and the turn-1 version stays, labelled ⟨historical⟩
 *   ledger     a name a capsule dropped has an exact locator; the quote or the
 *              number on that turn comes back as it was written (KERNEL §5.1)
 *   atom       the user's turn is the certificate; the assistant's restatement
 *              is a proposal, and a proposal is never promoted (KERNEL A9.1)
 *   lexical    a sentence with no name, number or quote has no ledger address;
 *              this browser exhibit's fallback is stemmed, ANDed terms (KERNEL A9.4)
 *
 * A name the thread holds is a route even when the question gives only part of
 * it, or gives it in lower case — `names()` sees capitalized runs, a visitor
 * types what they remember. The corpus plants every First × Last pair it uses,
 * so a bare first name usually matches many people; the card then answers with
 * the candidates, which is what an exact routing key can honestly say.
 *
 * No model is called anywhere in here. Every line rendered is archive text, a
 * certificate derived from archive text, or — in the trap card — an answer
 * quoted from the recorded live-bench artifact and labelled as one.
 *
 * The visitor can also append to the thread: `remember: …` writes turn
 * 1,000,001 and the same routes reach it afterwards. The appended turns live in
 * this tab and nowhere else.
 */

import { ftsTerms, names, sequenceRefs } from "@pylos/core/pure";
import { loadTrap, type TrapArtifact } from "../trap";
import { K } from "./kernel";
import type { RunState } from "./run";
import { BUDGET, corpus, episodeAt, REVISION_SEQ, ruleCertificate, TOTAL_TURNS } from "./thread";

const nf = new Intl.NumberFormat("en-US");
const MAX_CARDS = 4;

const SLOTS = ["header", "frontier", "capsules", "paged", "recent"] as const;

export interface ConsoleHandle {
  /** The run whose packet composition the cards report. */
  setState(state: RunState, source: "live" | "snapshot"): void;
}

type PlantedPerson = (typeof corpus.planted.persons)[number];
type PlantedFact = (typeof corpus.planted.facts)[number];
type PlantedQuote = (typeof corpus.planted.quotes)[number];
type PlantedNumber = (typeof corpus.planted.numbers)[number];
type PlantedMemory = (typeof corpus.planted.memories)[number];

/** The suggestions, drawn from the thread itself rather than written here. */
export const PERSON_PROBE = corpus.planted.persons.find((p) => p.variant === "A") as PlantedPerson;
export const MEMORY_PROBE = corpus.planted.memories[0] as PlantedMemory;
export const SEQUENCE_PROBE = 345;
/** The chip that shows what `remember:` does, and what to ask afterwards. */
export const TELL_EXAMPLE = "remember: my dog is called Biscuit";

/**
 * The chips. Each one *is* its question: the label a visitor reads is the exact
 * string the chip puts in the input, so typing what the chip says works too.
 */
export const SUGGESTIONS: readonly string[] = [
  `What did I say on turn ${SEQUENCE_PROBE}?`,
  "What is the migration rule now?",
  `Where does ${PERSON_PROBE.person} live now?`,
  MEMORY_PROBE.query,
  TELL_EXAMPLE,
];

// ── what a route produces ───────────────────────────────────────────────────

type LineKind = "text" | "cert" | "proposal" | "historical" | "absent";

export interface AnswerLine {
  kind: LineKind;
  text: string;
  /** Marked in ember: the span the route resolved. */
  mark?: string;
}

export interface Answer {
  question: string;
  /** `⟦brought back turn #345 · by its number⟧` — plain speech; the route is named in `meta`. */
  headline: string;
  lines: AnswerLine[];
  /** Mono receipts: trigger, locator, cost. */
  meta: string[];
  /** The turn this answer stands on, for the archive-position rail. */
  seq: number | null;
  caption: string;
  /** Set only by the trap card: the recorded live-bench answers. */
  trap?: boolean;
}

// ── what the visitor added ──────────────────────────────────────────────────

/** A turn the visitor appended in this tab, indexed the way the thread's own turns are. */
export interface ToldTurn {
  seq: number;
  text: string;
  terms: Set<string>;
  names: Set<string>;
}

const told: ToldTurn[] = [];

/** Append a user turn after the millionth and index it for the name and lexical routes. */
export function tell(text: string): ToldTurn {
  const turn: ToldTurn = {
    seq: TOTAL_TURNS + told.length + 1,
    text,
    terms: new Set(stemmed(text)),
    names: new Set(names(text).map((hit) => hit.name)),
  };
  told.push(turn);
  return turn;
}

/** The appended turns, newest first — the order the routes prefer. */
function toldNewestFirst(): ToldTurn[] {
  return told.slice().reverse();
}

// ── routes ──────────────────────────────────────────────────────────────────

/** The first turn this question addresses, if it addresses one this thread has. */
export function turnRef(query: string): number | null {
  const seq = sequenceRefs(query)[0]?.from;
  return seq !== undefined && seq <= TOTAL_TURNS + told.length ? seq : null;
}

/**
 * KERNEL A11.1, copied faithfully from `packages/core/src/page.ts` (the vault
 * side of the same gate, which imports `bun:sqlite` and so cannot be reached
 * from a browser). A miss is only a *fault* when the question both asks
 * something and refers back to the conversation; anything else is a question
 * about the world, which this thread has no turn about and no business
 * pretending to.
 */
const INTERROGATIVE = /\b(?:what|where|when|who|which|why|how|did|do|does|is|are|was|were|can|could)\b/i;
const REFERS_BACK =
  /\b(?:my|mine|our|did|was|were|had|ago|earlier|before|previously|last|back|remember(?:ed|s)?|recall(?:ed|s)?|remind(?:ed|s)?|mention(?:ed|s)?|said|told|discuss(?:ed|ing|es)?|talk(?:ed|ing|s)?|decide[ds]?|agree[ds]?|promise[ds]?|chose|name[ds]?|call(?:ed|s)?)\b/i;

function faults(query: string): boolean {
  const asks = query.includes("?") || INTERROGATIVE.test(query);
  return asks && REFERS_BACK.test(query) && ftsTerms(query).length >= 1;
}

const ruleNames = new Set(names(corpus.manifest.revisionText).map((hit) => hit.name));

function asksAboutTheRule(query: string): boolean {
  if (/\bmigration\b/i.test(query)) return true;
  return names(query).some((hit) => ruleNames.has(hit.name));
}

/** What one of the thread's people is attached to. */
interface Subject {
  poison?: PlantedPerson;
  fact?: PlantedFact;
  quote?: PlantedQuote;
  number?: PlantedNumber;
}

/** Planted people, by the lowercase form `names()` normalizes a name to. */
const people = new Map<string, Subject>();
/** The same people as they are written in the archive, for a card to print. */
const written = new Map<string, string>();
const attach = (person: string, entry: Subject): void => {
  const key = person.toLowerCase();
  people.set(key, { ...people.get(key), ...entry });
  written.set(key, person);
};
for (const fact of corpus.planted.facts) attach(fact.person, { fact });
for (const person of corpus.planted.persons) attach(person.person, { poison: person });
for (const quote of corpus.planted.quotes) attach(quote.person, { quote });
for (const number of corpus.planted.numbers) attach(number.person, { number });

/** The same people, indexed by each part of the name, so `esme` reaches `Esme Whitlock`. */
const byNamePart = new Map<string, string[]>();
for (const key of people.keys()) {
  for (const part of key.split(" ")) {
    const bucket = byNamePart.get(part);
    if (bucket === undefined) byNamePart.set(part, [key]);
    else bucket.push(key);
  }
}

/** Which planted people a question names, when it names one by part rather than in full. */
function peopleNamedIn(query: string): { part: string; keys: string[] } | null {
  const words: string[] = query.toLowerCase().match(/[a-z][a-z'’]*/g) ?? [];
  let part: string | null = null;
  const hit = new Set<string>();
  for (const word of words) {
    const bucket = byNamePart.get(word);
    if (bucket === undefined) continue;
    part ??= word;
    for (const key of bucket) hit.add(key);
  }
  if (part === null) return null;
  // Both parts of one name beat either part on its own: `esme whitlock` is exact.
  const keys = [...hit];
  const whole = keys.filter((key) => key.split(" ").every((token) => words.includes(token)));
  return { part, keys: whole.length > 0 ? whole : keys };
}

/**
 * A suffix stemmer, standing in for the porter stemmer FTS5 gives the vault.
 * The tokenizer either side of it is the kernel's own `ftsTerms`.
 */
function stem(term: string): string {
  const word = term.replace(/[^a-z0-9]/g, "");
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

function stemmed(text: string): string[] {
  return ftsTerms(text)
    .map(stem)
    .filter((term) => term.length > 0);
}

const memoryIndex = corpus.planted.memories.map((memory) => ({
  memory,
  terms: new Set(stemmed(memory.text)),
}));

/** Every planted memory whose text carries all of the query's terms. */
function lexical(query: string): { memory: PlantedMemory; terms: string[] } | null {
  const terms = stemmed(query);
  if (terms.length < 2) return null;
  for (const entry of memoryIndex) {
    if (terms.every((term) => entry.terms.has(term))) return { memory: entry.memory, terms };
  }
  return null;
}

// ── the four answers ────────────────────────────────────────────────────────

function sequenceAnswer(question: string, seq: number): Answer {
  const episode = episodeAt(seq);
  return {
    question,
    headline: `⟦brought back turn #${nf.format(seq)} · by its number⟧`,
    lines: [{ kind: "text", text: `${episode.role} · ${episode.content}` }],
    meta: [
      "trigger sequence",
      `locator #${nf.format(seq)} of ${nf.format(TOTAL_TURNS)}`,
      `${nf.format(K.countTokens(episode.content))} tokens paged`,
    ],
    seq,
    caption:
      "A turn number is an address, not a search: the archive is exact, so the turn comes back verbatim " +
      "however old it is. Any number up to 1,000,000 works — try another.",
  };
}

function trapAnswer(question: string): Answer {
  const rule = ruleCertificate(TOTAL_TURNS);
  const revision = episodeAt(REVISION_SEQ);
  const lines: AnswerLine[] = [{ kind: "cert", text: rule.line }];
  if (rule.historical !== null) lines.push({ kind: "historical", text: rule.historical });
  lines.push({
    kind: "text",
    text: `⟦turn #${nf.format(REVISION_SEQ)} · where you changed the rule⟧ ${revision.content}`,
    mark: "additive-only",
  });
  return {
    question,
    headline: `● already in the view · turn #${nf.format(rule.seq)} · nothing had to be fetched`,
    lines,
    meta: [
      "trigger frontier · no page needed",
      `current #${nf.format(REVISION_SEQ)} · superseded #1 kept, labelled`,
      "0 tokens paged",
    ],
    seq: REVISION_SEQ,
    caption:
      "The standing rule is a certificate, and certificates are kept resident by kind, whatever their age " +
      "— so the revision at turn 483,112 is in the view and the turn-1 version is labelled rather than " +
      "dropped. Nothing had to be paged. Below: the same question, put to the same model twice in the " +
      "recorded live bench — once behind a rolling summary, once behind Pylos.",
    trap: true,
  };
}

/**
 * An exact span, addressed by the name beside it.
 *
 * This is the ledger route the run above fires live: a capsule dropped the
 * name, the ledger kept its locator, and the locator resolves to the turn the
 * material is really on. Here the locator comes from the thread's manifest
 * rather than from a second full run in this tab — the same turn either way,
 * and checkable by asking for that turn by number.
 */
function spanAnswer(question: string, subject: PlantedQuote | PlantedNumber): Answer {
  const episode = episodeAt(subject.seq);
  const mark = episode.content.slice(subject.span[0], subject.span[1]);
  return {
    question,
    headline: `⟦brought back turn #${nf.format(subject.seq)} · by the name beside it⟧`,
    lines: [{ kind: "text", text: `user · ${episode.content}`, mark }],
    meta: [
      `trigger ledger · "${subject.person.toLowerCase()}"`,
      `locator #${nf.format(subject.seq)} · span [${subject.span[0]}, ${subject.span[1]})`,
      `${nf.format(K.countTokens(episode.content))} tokens paged`,
    ],
    seq: subject.seq,
    caption:
      subject.kind === "quote"
        ? "A quote is kept as a quote: the span comes back byte for byte, not as a paraphrase of what " +
          "was said. The million-turn bench checks 200 of these at turn 1,000,000 and requires every " +
          "one to survive exactly."
        : "A number is only recovered if the same number comes back, with the same unit — a value " +
          "that is merely close is a silent loss. The bench checks 50 of these at turn 1,000,000.",
  };
}

function personAnswer(question: string, entry: Subject): Answer {
  const lines: AnswerLine[] = [];
  const meta: string[] = [];
  const poison = entry.poison;
  const fact = entry.fact;
  let seq: number | null = null;

  if (poison !== undefined) {
    const stated = poison.statedSeq;
    const corrected = poison.correctedSeq;
    if (corrected !== undefined && poison.value3 !== undefined) {
      lines.push({ kind: "cert", text: `${poison.key} = ${poison.value3} ⟨#${corrected}⟩` });
      if (stated !== undefined && poison.value1 !== undefined) {
        lines.push({
          kind: "historical",
          text: `${poison.key} = ${poison.value1} ⟨historical #${stated}→#${corrected}⟩`,
        });
      }
      seq = corrected;
    } else if (stated !== undefined && poison.value1 !== undefined) {
      lines.push({ kind: "cert", text: `${poison.key} = ${poison.value1} ⟨#${stated}⟩` });
      seq = stated;
    } else {
      lines.push({
        kind: "absent",
        text: `${poison.key} — no certificate: you never stated it`,
      });
    }
    lines.push({
      kind: "proposal",
      text: `${poison.key} ≈ ${poison.value2} ⟨proposed by assistant #${poison.claimSeq} · unconfirmed⟩`,
    });
    lines.push({
      kind: "text",
      text: `⟦#${nf.format(poison.claimSeq)} · assistant⟧ ${episodeAt(poison.claimSeq).content}`,
      mark: poison.value2,
    });
    meta.push(
      "trigger atom · authority",
      seq === null
        ? `proposal only · #${nf.format(poison.claimSeq)}`
        : `certificate #${nf.format(seq)} · proposal #${nf.format(poison.claimSeq)}`,
    );
  } else if (fact !== undefined) {
    lines.push({ kind: "cert", text: `${fact.key} = ${fact.value2} ⟨#${fact.seq2}⟩` });
    lines.push({
      kind: "historical",
      text: `${fact.key} = ${fact.value1} ⟨historical #${fact.seq1}→#${fact.seq2}⟩`,
    });
    lines.push({
      kind: "text",
      text: `⟦#${nf.format(fact.seq2)} · user⟧ ${episodeAt(fact.seq2).content}`,
      mark: fact.value2,
    });
    seq = fact.seq2;
    meta.push(
      "trigger atom · supersession",
      `current #${nf.format(fact.seq2)} · was #${nf.format(fact.seq1)}`,
    );
  }

  meta.push(`${nf.format(K.countTokens(lines.map((l) => l.text).join("\n")))} tokens paged`);
  return {
    question,
    headline:
      seq === null
        ? "⟦you never stated it · one unconfirmed claim by the model⟧"
        : `⟦you stated it, and it still stands · turn #${nf.format(seq)}⟧`,
    lines,
    meta,
    seq,
    caption:
      "Only your turns write certificates. When the assistant states a fact, the kernel records it as a " +
      "proposal — ash, ≈, unconfirmed — and never promotes it, however confidently it was said. " +
      "This thread plants 200 of these on purpose; the million-turn bench checks every one.",
  };
}

/** Whichever of the two name cards this person's material calls for. */
function subjectAnswer(question: string, entry: Subject): Answer | null {
  if (entry.poison !== undefined || entry.fact !== undefined) return personAnswer(question, entry);
  const span = entry.quote ?? entry.number;
  return span === undefined ? null : spanAnswer(question, span);
}

/** How many candidates a card prints before it counts the rest. */
const CANDIDATES_SHOWN = 5;

/**
 * A name that reaches more than one person. The thread plants every First ×
 * Last pair it uses, so a bare first name is usually several people — and an
 * exact routing key may not choose between them.
 */
function ambiguousAnswer(question: string, part: string, keys: string[]): Answer {
  const shown = keys.slice(0, CANDIDATES_SHOWN).map((key) => written.get(key) ?? key);
  const rest = keys.length - shown.length;
  const capitalized = part.charAt(0).toUpperCase() + part.slice(1);
  return {
    question,
    headline: `⟦${nf.format(keys.length)} people in this thread are named ${capitalized}⟧`,
    lines: [
      {
        kind: "absent",
        text:
          `${shown.join(" · ")}${rest > 0 ? ` · and ${nf.format(rest)} more` : ""} — ` +
          "ask again with the full name.",
      },
    ],
    meta: [
      `trigger name · ambiguous · "${part}"`,
      `${nf.format(keys.length)} people match`,
      "0 tokens paged",
    ],
    seq: null,
    caption:
      "A name is a routing key, not a guess. Several people in this thread answer to that name, so there " +
      "is no one certificate to return and Pylos will not pick one for you — give the full name and the " +
      "exact turn comes back. A near match is never promoted to a hit.",
  };
}

function memoryAnswer(question: string, found: { memory: PlantedMemory; terms: string[] }): Answer {
  const { memory, terms } = found;
  return {
    question,
    headline: `⟦brought back turn #${nf.format(memory.seq)} · by its own words⟧`,
    lines: [{ kind: "text", text: `user · ${memory.text}`, mark: memory.adj }],
    meta: [
      `trigger lexical · ${terms.join(" AND ")}`,
      `locator #${nf.format(memory.seq)} · names() found 0 routing keys`,
      `${nf.format(K.countTokens(memory.text))} tokens paged`,
    ],
    seq: memory.seq,
    caption:
      "That sentence carries no name, no number, no quote and no identifier, so the loss ledger has no " +
      "direct address for it. A bounded address proposal may still nominate a source; this browser card " +
      "exercises the lexical fallback — stemmed, ANDed terms over the 2,000 name-free memories this " +
      "thread plants. Any semantic mechanism remains only an address until the kernel verifies the exact " +
      "witness. The browser has no SQLite or meaning model here.",
  };
}

/** The receipt for a turn the visitor just wrote into the thread. */
function toldAnswer(question: string, turn: ToldTurn): Answer {
  return {
    question,
    headline: `⟦added to the thread · turn #${nf.format(turn.seq)}⟧`,
    lines: [{ kind: "text", text: `user · ${turn.text}` }],
    meta: [
      "trigger append",
      `locator #${nf.format(turn.seq)} · after the millionth turn`,
      `${nf.format(K.countTokens(turn.text))} tokens archived`,
    ],
    seq: turn.seq,
    caption:
      "Your turn is now the newest turn of a million-turn thread. Ask for it back — by its number, " +
      "by a name in it, or by its words — and it comes back the same way every other turn does. " +
      "It lives in this tab only: nothing is uploaded, and a reload forgets it.",
  };
}

/** How each route reads in plain speech; the route's own name stays in the receipt line. */
const ROUTE_PLAINLY: Record<string, string> = {
  sequence: "by its number",
  name: "by a name in it",
  lexical: "by its own words",
};

/** A turn the visitor added, reached again by one of the thread's own routes. */
function toldRecovered(question: string, turn: ToldTurn, trigger: string, locator: string): Answer {
  return {
    question,
    headline: `⟦brought back turn #${nf.format(turn.seq)} · ${ROUTE_PLAINLY[trigger] ?? trigger}⟧`,
    lines: [{ kind: "text", text: `user · ${turn.text}` }],
    meta: [`trigger ${trigger}`, locator, `${nf.format(K.countTokens(turn.text))} tokens paged`],
    seq: turn.seq,
    caption:
      "The turn you added is addressed by the same routes as the other million: a number is an " +
      "address, a name is a ledger key, and a sentence with neither gets only a bounded lexical fallback " +
      "in this browser card.",
  };
}

/**
 * Not every miss is a loss. A question that never refers back to the
 * conversation is a question about the world — the thread has no turn about it,
 * and saying so is the honest answer, not a fault (KERNEL A11.1).
 */
function notAMemory(question: string): Answer {
  return {
    question,
    headline: "⟦no turn about that · not a memory⟧",
    lines: [
      {
        kind: "absent",
        text: "The thread has no turn about that. A model would answer it from the world.",
      },
    ],
    meta: ["no route attempted · the question does not refer back", "0 tokens paged"],
    seq: null,
    caption:
      "Pylos only claims the conversation. A question with no cue that it refers back — no “my”, no " +
      "past tense, no “you said” — is not a memory request, so nothing is searched and nothing is " +
      "receipted. In the app the model answers it from its own knowledge, with the thread quiet.",
  };
}

function nothing(question: string): Answer {
  return {
    question,
    headline: "⟦looked back, found no route to a turn · page fault⟧",
    lines: [
      {
        kind: "absent",
        text:
          "No turn number, recorded name or search term reached the archive for that question. " +
          "Pylos does not guess.",
      },
    ],
    meta: ["trigger fault", "0 tokens paged"],
    seq: null,
    caption:
      "In the app this is a receipt: the kernel records the fault and tells the model no route fired, " +
      "and the model may re-ask the archive in its own words — a memory none of whose words are in the " +
      "question is not found deterministically. This console has no model.",
  };
}

/**
 * Route one question. Deterministic: the same question over the same thread
 * always produces the same card. `remember: …` is the one input that changes
 * the thread, and it changes it by appending, never by editing.
 */
export function answer(question: string): Answer {
  const query = question.trim();

  const tellMatch = /^remember\s*[:—-]\s*(.+)$/is.exec(query);
  if (tellMatch?.[1] !== undefined) return toldAnswer(query, tell(tellMatch[1].trim()));

  const seq = turnRef(query);
  if (seq !== null) {
    const added = told.find((turn) => turn.seq === seq);
    return added === undefined
      ? sequenceAnswer(query, seq)
      : toldRecovered(query, added, "sequence", `locator #${nf.format(seq)} · you added it in this tab`);
  }
  if (asksAboutTheRule(query)) return trapAnswer(query);

  const queried = names(query);
  for (const turn of toldNewestFirst()) {
    const hit = queried.find((n) => turn.names.has(n.name));
    if (hit !== undefined)
      return toldRecovered(query, turn, "name", `locator #${nf.format(turn.seq)} · "${hit.name}"`);
  }
  for (const hit of queried) {
    const entry = people.get(hit.name);
    if (entry === undefined) continue;
    const card = subjectAnswer(query, entry);
    if (card !== null) return card;
  }

  const terms = stemmed(query);
  if (terms.length >= 2) {
    for (const turn of toldNewestFirst()) {
      if (terms.every((term) => turn.terms.has(term))) {
        return toldRecovered(
          query,
          turn,
          "lexical",
          `locator #${nf.format(turn.seq)} · ${terms.join(" AND ")}`,
        );
      }
    }
  }
  const memory = lexical(query);
  if (memory !== null) return memoryAnswer(query, memory);

  // Last before the fault gate, so a question that gives a name the thread
  // holds is answered by the name rather than receipted as a miss.
  const named = peopleNamedIn(query);
  if (named !== null) {
    const only = named.keys.length === 1 ? people.get(named.keys[0] as string) : undefined;
    if (only !== undefined) {
      const card = subjectAnswer(query, only);
      if (card !== null) return card;
    }
    if (named.keys.length > 1) return ambiguousAnswer(query, named.part, named.keys);
  }

  return faults(query) ? nothing(query) : notAMemory(query);
}

// ── the DOM ─────────────────────────────────────────────────────────────────

export function mountConsole(): ConsoleHandle | null {
  const section = document.querySelector<HTMLElement>("#console");
  if (!section) return null;
  const form = section.querySelector<HTMLFormElement>("[data-console-form]");
  const input = section.querySelector<HTMLInputElement>("[data-console-input]");
  const cards = section.querySelector<HTMLElement>("[data-console-cards]");
  const chips = section.querySelector<HTMLElement>("[data-console-chips]");
  const status = section.querySelector<HTMLElement>("[data-console-status]");
  if (!form || !input || !cards || !chips || !status) return null;

  let state: RunState | null = null;
  let trap: TrapArtifact | null = null;

  // An arrow declared after the guard above, so the narrowed elements survive.
  const ask = (question: string): void => {
    if (question.trim().length === 0) return;
    const card = render(answer(question), state, trap);
    cards.prepend(card);
    while (cards.childElementCount > MAX_CARDS) cards.lastElementChild?.remove();
    status.textContent = statusLine(state);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  };

  for (const suggestion of SUGGESTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ask";
    button.textContent = suggestion;
    button.addEventListener("click", () => {
      input.value = suggestion;
      ask(suggestion);
    });
    chips.append(button);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(input.value);
  });

  void loadTrap().then((artifact) => {
    trap = artifact;
  });

  const gloss = el("p", "mono console__gloss", subsetGloss(null));
  status.after(gloss);
  void benchFinal().then((final) => {
    if (final !== null) gloss.textContent = subsetGloss(final);
  });

  status.textContent = statusLine(null);
  return {
    setState(next: RunState, source: "live" | "snapshot"): void {
      // A live run supersedes the served snapshot; never the other way round.
      if (state !== null && source === "snapshot") return;
      state = next;
      status.textContent = statusLine(next);
    },
  };
}

/** The bench's own totals, so the two number sets on this page can be told apart. */
interface BenchFinal {
  entries: number;
  mib: number;
}

/**
 * The status line counts *this tab's* run — the browser-safe subset, which has
 * no vault and no index — while the proof strip counts the full kernel's bench
 * over the same million turns. Both are true; saying so is cheaper than a
 * visitor deciding one of them is wrong.
 */
function subsetGloss(final: BenchFinal | null): string {
  const bench = final === null ? "" : ` (${nf.format(final.entries)} entries · ${nf.format(final.mib)} MiB)`;
  return (
    "This tab keeps no vault and no index, so its ledger and byte counts are smaller than the " +
    `bench's${bench}; the turns are the same million.`
  );
}

/** `final` from the served bench series — the artifact the proof section draws. */
async function benchFinal(): Promise<BenchFinal | null> {
  try {
    const res = await fetch("/bench/series.json", { cache: "no-cache" });
    if (!res.ok) return null;
    const series = (await res.json()) as { final: { archiveBytes: number; lossEntries: number } };
    return {
      entries: series.final.lossEntries,
      mib: Math.round(series.final.archiveBytes / 1024 / 1024),
    };
  } catch {
    return null;
  }
}

function statusLine(state: RunState | null): string {
  const added = told.length === 0 ? "" : ` + ${nf.format(told.length)} you added`;
  if (state === null) {
    return `Archive ${nf.format(TOTAL_TURNS)} turns${added} · budget ${nf.format(BUDGET)} tokens`;
  }
  return (
    `Archive ${nf.format(state.turn)} turns${added} · packet ${nf.format(state.packet.tokens)}/` +
    `${nf.format(state.packet.budget)} tokens · ledger ${nf.format(state.lossRows)} entries · no model calls`
  );
}

function render(item: Answer, state: RunState | null, trap: TrapArtifact | null): HTMLElement {
  const card = document.createElement("article");
  card.className = "ans";
  card.append(el("p", "ans__q", item.question), el("p", "ans__head", item.headline));

  const body = el("div", "ans__body");
  for (const line of item.lines) {
    const node = el("p", `ans__line ans__line--${line.kind}`);
    if (line.mark !== undefined && line.mark.length > 0) {
      for (const part of split(line.text, line.mark)) {
        if (part.hit) {
          const mark = document.createElement("mark");
          mark.textContent = part.text;
          node.append(mark);
        } else {
          node.append(document.createTextNode(part.text));
        }
      }
    } else {
      node.textContent = line.text;
    }
    body.append(node);
  }
  card.append(body);

  if (item.seq !== null) card.append(rail(item.seq));

  const meta = el("p", "ans__meta");
  for (const fact of item.meta) meta.append(el("span", "", fact));
  if (state !== null) {
    meta.append(
      el(
        "span",
        "",
        `packet at #${nf.format(state.turn)} · ${nf.format(state.packet.tokens)}/${nf.format(state.packet.budget)}`,
      ),
    );
  }
  card.append(meta);
  if (state !== null) card.append(meter(state));

  if (item.trap === true && trap !== null) card.append(recorded(trap));
  card.append(el("p", "ans__caption", item.caption));
  return card;
}

/** Where the answer sits in a million turns. */
function rail(seq: number): HTMLElement {
  const total = TOTAL_TURNS + told.length;
  const wrap = el("div", "ans__rail");
  const tick = el("i", "");
  tick.style.left = `${((seq / total) * 100).toFixed(3)}%`;
  wrap.append(tick, el("span", "", `#${nf.format(seq)} of ${nf.format(total)}`));
  return wrap;
}

function meter(state: RunState): HTMLElement {
  const bar = el("div", "meter");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", "What fills the model's view, against its fixed budget");
  for (const slot of SLOTS) {
    const span = el("span", "meter__slot");
    span.dataset.slot = slot;
    span.style.width = `${((state.packet.slots[slot] / state.packet.budget) * 100).toFixed(3)}%`;
    bar.append(span);
  }
  return bar;
}

/** The two recorded answers, quoted from the bench artifact and labelled as recorded. */
function recorded(trap: TrapArtifact): HTMLElement {
  const wrap = el("div", "ans__recorded");
  wrap.append(
    el(
      "p",
      "mono",
      `Recorded · ${trap.model} · ${nf.format(trap.turns)} turns · packet ${short(trap.hashes.packet)}`,
    ),
  );
  const cols = el("div", "ans__cols");
  for (const which of ["baseline", "pylos"] as const) {
    const side = trap[which];
    const col = el("div", `ans__col${which === "pylos" ? " ans__col--pylos" : ""}`);
    col.append(
      el("p", "mono", side.label ?? (which === "pylos" ? "Pylos" : "Rolling summary")),
      el("p", "ans__answer", side.answer),
      el(
        "p",
        `ans__verdict ${side.usedStale ? "bad" : "good"}`,
        side.usedStale
          ? `✕ answered from the superseded rule (#${nf.format(trap.rule.seq)})`
          : `✓ answered from the current rule (#${nf.format(trap.revision.seq)})`,
      ),
    );
    cols.append(col);
  }
  wrap.append(cols);
  return wrap;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function el(tag: string, cls = "", text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function short(hash: string): string {
  return hash && hash.length > 16 ? `${hash.slice(0, 12)}…` : hash || "—";
}

function split(text: string, needle: string): { text: string; hit: boolean }[] {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i === -1) return [{ text, hit: false }];
  return [
    { text: text.slice(0, i), hit: false },
    { text: text.slice(i, i + needle.length), hit: true },
    { text: text.slice(i + needle.length), hit: false },
  ].filter((part) => part.text.length > 0);
}
