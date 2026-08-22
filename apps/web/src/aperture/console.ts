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
 *              stemmed terms, ANDed, are the only way back to it (KERNEL A9.4)
 *
 * No model is called anywhere in here. Every line rendered is archive text, a
 * certificate derived from archive text, or — in the trap card — an answer
 * quoted from the recorded live-bench artifact and labelled as one.
 */

import { ftsTerms, names } from "@pylos/core/pure";
import { loadTrap, type TrapArtifact } from "../trap";
import { K } from "./kernel";
import type { RunState } from "./run";
import {
  BUDGET,
  corpus,
  episodeAt,
  REVISION_SEQ,
  ruleCertificate,
  TOTAL_TURNS,
  TRAP_QUESTION,
} from "./thread";

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
  /** `⟦recovered #345 · sequence⟧` — the packet's own label for the material. */
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

// ── routes ──────────────────────────────────────────────────────────────────

/**
 * A turn reference in a question. The vault-side counterpart is `sequenceRefs`
 * in `packages/core/src/page.ts`: a bare number is never an address, so a cue
 * word or `#` is required.
 */
export function turnRef(query: string): number | null {
  const cue = /#(\d{1,9})|\b(?:turns?|messages?|episodes?|seq)\s*#?\s*([\d,]{1,11})/i.exec(query);
  const raw = (cue?.[1] ?? cue?.[2] ?? "").replace(/,/g, "");
  if (raw === "") return null;
  const seq = Number(raw);
  return Number.isInteger(seq) && seq >= 1 && seq <= TOTAL_TURNS ? seq : null;
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
const attach = (person: string, entry: Subject): void => {
  const key = person.toLowerCase();
  people.set(key, { ...people.get(key), ...entry });
};
for (const fact of corpus.planted.facts) attach(fact.person, { fact });
for (const person of corpus.planted.persons) attach(person.person, { poison: person });
for (const quote of corpus.planted.quotes) attach(quote.person, { quote });
for (const number of corpus.planted.numbers) attach(number.person, { number });

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
    headline: `⟦recovered #${nf.format(seq)} · sequence⟧`,
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
    text: `⟦#${nf.format(REVISION_SEQ)} · the turn the certificate points at⟧ ${revision.content}`,
    mark: "additive-only",
  });
  return {
    question,
    headline: `● resident #${nf.format(rule.seq)} · frontier certificate`,
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
    headline: `⟦recovered #${nf.format(subject.seq)} · ledger⟧`,
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
      seq === null ? "⟦no certificate · one unconfirmed proposal⟧" : `⟦certificate #${nf.format(seq)}⟧`,
    lines,
    meta,
    seq,
    caption:
      "Only your turns write certificates. When the assistant states a fact, the kernel records it as a " +
      "proposal — ash, ≈, unconfirmed — and never promotes it, however confidently it was said. " +
      "This thread plants 200 of these on purpose; the million-turn bench checks every one.",
  };
}

function memoryAnswer(question: string, found: { memory: PlantedMemory; terms: string[] }): Answer {
  const { memory, terms } = found;
  return {
    question,
    headline: `⟦recovered #${nf.format(memory.seq)} · lexical⟧`,
    lines: [{ kind: "text", text: `user · ${memory.text}`, mark: memory.adj }],
    meta: [
      `trigger lexical · ${terms.join(" AND ")}`,
      `locator #${nf.format(memory.seq)} · names() found 0 routing keys`,
      `${nf.format(K.countTokens(memory.text))} tokens paged`,
    ],
    seq: memory.seq,
    caption:
      "That sentence carries no name, no number, no quote and no identifier, so the loss ledger has no " +
      "address for it — the only way back is search. Lexical, stemmed, ANDed: the kernel's own tokenizer " +
      "over the 2,000 name-free memories this thread plants. In the app the same query runs as SQLite " +
      "FTS5 with the porter stemmer over the whole archive; a browser has no SQLite, so the stemmer here " +
      "is a suffix rule. No meaning model, either way.",
  };
}

function nothing(question: string): Answer {
  return {
    question,
    headline: "⟦no route fired⟧",
    lines: [
      {
        kind: "absent",
        text:
          "Nothing in this archive is addressed by that question. Pylos does not guess: it says the " +
          "material is not there, rather than answering from the shape of the question.",
      },
    ],
    meta: ["trigger none", "0 tokens paged"],
    seq: null,
    caption:
      "What this thread can be asked about: a turn number, the migration rule, any of the people in " +
      "it, and any of its name-free memories. Anything else is honestly a miss — the suggestions " +
      "above all land, and so does any turn number up to 1,000,000.",
  };
}

/** Route one question. Pure: the same question always produces the same card. */
export function answer(question: string): Answer {
  const query = question.trim();
  const seq = turnRef(query);
  if (seq !== null) return sequenceAnswer(query, seq);
  if (asksAboutTheRule(query)) return trapAnswer(query);
  for (const hit of names(query)) {
    const entry = people.get(hit.name);
    if (entry === undefined) continue;
    if (entry.poison !== undefined || entry.fact !== undefined) return personAnswer(query, entry);
    const span = entry.quote ?? entry.number;
    if (span !== undefined) return spanAnswer(query, span);
  }
  const memory = lexical(query);
  if (memory !== null) return memoryAnswer(query, memory);
  return nothing(query);
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
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const suggestions: Array<{ label: string; query: string }> = [
    { label: `turn ${SEQUENCE_PROBE}`, query: `What did I say on turn ${SEQUENCE_PROBE}?` },
    { label: "the migration rule", query: TRAP_QUESTION },
    { label: `where ${PERSON_PROBE.person.split(" ")[0]} lives`, query: PERSON_PROBE.query },
    { label: "the memory with no name", query: MEMORY_PROBE.query },
  ];
  for (const suggestion of suggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ask";
    button.textContent = suggestion.label;
    button.title = suggestion.query;
    button.addEventListener("click", () => {
      input.value = suggestion.query;
      ask(suggestion.query);
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

function statusLine(state: RunState | null): string {
  if (state === null) return `Archive ${nf.format(TOTAL_TURNS)} turns · budget ${nf.format(BUDGET)} tokens`;
  return (
    `Archive ${nf.format(state.turn)} turns · packet ${nf.format(state.packet.tokens)}/` +
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
  const wrap = el("div", "ans__rail");
  const tick = el("i", "");
  tick.style.left = `${((seq / TOTAL_TURNS) * 100).toFixed(3)}%`;
  wrap.append(tick, el("span", "", `#${nf.format(seq)} of ${nf.format(TOTAL_TURNS)}`));
  return wrap;
}

function meter(state: RunState): HTMLElement {
  const bar = el("div", "meter");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", "Packet composition against the token budget");
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
