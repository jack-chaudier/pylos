/**
 * The deterministic corpus — one generator, shared by `pylos bench million`
 * (`bench/CORPUS.md`) and by the landing page's in-browser thread.
 *
 * Zero model calls, seeded, and reproducible: every episode is a pure function
 * of `(seed, seq)`, so the generator can be resumed, sharded, or replayed and
 * produce byte-identical text. The planted structure — one rule, its revision
 * 483,112 turns later, 2,000 revised facts, 200 exact quotes, 50 exact numbers —
 * is what the assertions are written against.
 *
 * It lives in `pure` because the browser has to be able to generate the same
 * million turns the bench does, byte for byte, with no Bun or Node import.
 */

import type { Role } from "@pylos/protocol";
import { names } from "../names.ts";
import { ftsTerms } from "../terms.ts";
import { sha256Hex, sha256Into } from "./sha256.ts";
import * as V from "./vocab.ts";

/** A generator invariant. Failing one means the corpus, not the kernel, is wrong. */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`corpus: ${message}`);
}

// ------------------------------------------------------------------- prng

/** xoshiro128** — small, fast, and identical across platforms. */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /** Seeded from the first four words of a digest, read little-endian. */
  constructor(digest: Uint32Array) {
    this.s0 = swap32(digest[0] as number);
    this.s1 = swap32(digest[1] as number);
    this.s2 = swap32(digest[2] as number);
    this.s3 = swap32(digest[3] as number);
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  next(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7) >>> 0, 9) >>> 0) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  u01(): number {
    return this.next() / 4294967296;
  }

  int(a: number, b: number): number {
    return a + Math.floor(this.u01() * (b - a + 1));
  }

  pick<T>(list: readonly T[]): T {
    return list[this.int(0, list.length - 1)] as T;
  }

  weighted(table: ReadonlyArray<readonly [string, number]>): string {
    const total = table.reduce((sum, [, w]) => sum + w, 0);
    let target = this.u01() * total;
    for (const [key, weight] of table) {
      target -= weight;
      if (target <= 0) return key;
    }
    return table[table.length - 1]?.[0] as string;
  }
}

function rotl(x: number, k: number): number {
  return (((x << k) | (x >>> (32 - k))) >>> 0) as number;
}

/** Big-endian words to little-endian, so the seeding is the byte order it always was. */
function swap32(x: number): number {
  return (((x >>> 24) | ((x >>> 8) & 0xff00) | ((x << 8) & 0xff0000) | ((x << 24) & 0xff000000)) >>>
    0) as number;
}

const digest = new Uint32Array(8);

/** `state(seq, salt) = first 16 bytes of sha256(SEED ‖ ":" ‖ salt ‖ ":" ‖ seq)`. */
export function stream(seed: string, salt: string, seq: number): Rng {
  sha256Into(`${seed}:${salt}:${seq}`, digest);
  return new Rng(digest);
}

// --------------------------------------------------------------- manifest

export interface PlantedFact {
  id: number;
  kind: "fact";
  slot: "location" | "employer";
  person: string;
  key: string;
  value1: string;
  seq1: number;
  value2: string;
  seq2: number;
  queries: string[];
}

export interface PlantedQuote {
  kind: "quote";
  person: string;
  text: string;
  head: string;
  seq: number;
  span: [number, number];
  query: string;
}

export interface PlantedNumber {
  kind: "number";
  person: string;
  key: string;
  value: number;
  valueText: string;
  name: string;
  seq: number;
  span: [number, number];
  query: string;
}

/**
 * A memory with no routing key in it: all lowercase, no number, no quote, no
 * identifier, so `names()` is empty and the ledger never sees it. The only way
 * back to it is the lexical search route (KERNEL A9.4).
 */
export interface PlantedMemory {
  id: number;
  kind: "memory";
  nounA: string;
  verb: string;
  adj: string;
  nounB: string;
  /** The exact sentence, as it is written into the archive. */
  text: string;
  seq: number;
  /** The question, with the adjective withheld. */
  query: string;
}

/**
 * `A` the user states it and the assistant later restates it wrongly · `B` the
 * assistant claims it and the user never did · `C` the user states it, the
 * assistant restates it wrongly, the user corrects it (KERNEL A9.1).
 */
export type PoisonVariant = "A" | "B" | "C";

export interface PlantedPerson {
  id: number;
  kind: "poison";
  variant: PoisonVariant;
  person: string;
  key: string;
  /** What the user said, and where. Absent in `B`. */
  value1?: string;
  statedSeq?: number;
  /** What the assistant claimed, and the seq of the assistant episode. */
  value2: string;
  claimSeq: number;
  /** The user's correction. Present only in `C`. */
  value3?: string;
  correctedSeq?: number;
  query: string;
}

export interface CorpusManifest {
  seed: string;
  n: number;
  ruleSeq: number;
  revisionSeq: number;
  trapSeq: number;
  ruleText: string;
  revisionText: string;
  trapText: string;
  handoffs: number[];
  facts: PlantedFact[];
  quotes: PlantedQuote[];
  numbers: PlantedNumber[];
  memories: PlantedMemory[];
  persons: PlantedPerson[];
}

export const RULE_TEXT =
  "One ground rule for this whole project: never send a production migration before the dry-run database is verified.";
export const REVISION_TEXT =
  "Update to our migration rule: never send a production migration before the dry-run database is verified — unless the change is additive-only and the dry-run was skipped by the on-call lead.";
export const TRAP_TEXT =
  "We're ready. Prepare the production migration for the orders table and send it. The dry-run was skipped by the on-call lead and the change only adds a column.";

const MODELS = ["grok-4.6", "claude-sonnet-4.5", "grok-4.6", "llama3.1:8b"];

export interface CorpusOptions {
  /** Override the planted counts (the live variant uses 40/10/10 at n=2,000). */
  plants?: { facts?: number; quotes?: number; numbers?: number; memories?: number; persons?: number };
}

export interface Planted {
  facts: PlantedFact[];
  quotes: PlantedQuote[];
  numbers: PlantedNumber[];
  memories: PlantedMemory[];
  persons: PlantedPerson[];
}

export interface CorpusEpisode {
  role: Role;
  content: string;
  model?: string;
}

export interface Corpus {
  seed: string;
  n: number;
  manifest: CorpusManifest;
  /** The planted structure, by kind — the same arrays the manifest carries. */
  planted: Planted;
  /** Deterministic content of one episode. O(1). */
  episodeAt(seq: number): CorpusEpisode;
  /** All planted items whose defining seq is < `seq`. */
  plantedBefore(seq: number): Planted;
}

/** Every distinct `First Last` pair, in a fixed order. */
function personPool(): string[] {
  const out: string[] = [];
  for (const l of V.last) for (const f of V.first) out.push(`${f} ${l}`);
  return out;
}

/** Build the corpus of `n` turns for `seed`. The manifest is materialised; the text is not. */
export function createCorpus(seed: string, n: number, options: CorpusOptions = {}): Corpus {
  const scale = n / 1_000_000;
  const factCount = options.plants?.facts ?? Math.max(4, Math.round(2000 * scale));
  const quoteCount = options.plants?.quotes ?? Math.max(2, Math.round(200 * scale));
  const numberCount = options.plants?.numbers ?? Math.max(2, Math.round(50 * scale));
  const memoryCount = options.plants?.memories ?? Math.max(4, Math.round(2000 * scale));
  const personCount = options.plants?.persons ?? Math.max(4, Math.round(200 * scale));
  const revisionSeq = n >= 1_000_000 ? 483_112 : Math.max(4, Math.floor(n * 0.483112));
  const trapSeq = n;
  const handoffs = [0.250001, 0.600002, 0.800001]
    .map((f) => Math.floor(f * n))
    .filter((s) => s > 4 && s < n - 4);

  const scheduled = new Set<number>([1, revisionSeq, trapSeq, ...handoffs]);
  const claim = (want: number): number => {
    let seq = want % 2 === 0 ? want + 1 : want;
    while (scheduled.has(seq) || scheduled.has(seq + 1) || seq >= n - 2 || seq < 3) {
      seq += 2;
      if (seq >= n - 2) seq = 3;
    }
    scheduled.add(seq);
    scheduled.add(seq + 1);
    return seq;
  };

  const plant = stream(seed, "plant", 0);
  const people = personPool();
  let personCursor = 0;
  const nextPerson = (): string => people[personCursor++ % people.length] as string;

  // 3. revised facts
  const facts: PlantedFact[] = [];
  const lnLo = Math.log(Math.max(20, Math.round(1000 * scale)));
  const lnHi = Math.log(Math.max(60, Math.round(400_000 * scale)));
  for (let i = 1; i <= factCount; i += 1) {
    const person = nextPerson();
    const slot: PlantedFact["slot"] = i % 2 === 0 ? "employer" : "location";
    const value1 = slot === "location" ? plant.pick(V.place) : plant.pick(V.org);
    let value2 = slot === "location" ? plant.pick(V.place) : plant.pick(V.org);
    if (value2 === value1)
      value2 =
        slot === "location"
          ? V.place[0] === value1
            ? (V.place[1] as string)
            : (V.place[0] as string)
          : V.org[0] === value1
            ? (V.org[1] as string)
            : (V.org[0] as string);
    let s1 = claim(plant.int(3, Math.max(5, n - Math.round(60_000 * scale))));
    const gap = Math.round(Math.exp(lnLo + plant.u01() * (lnHi - lnLo)));
    let s2 = claim(Math.min(s1 + gap, n - Math.max(4, Math.round(1000 * scale))));
    // `claim` wraps to the start when it runs past the end; the statement must precede the revision.
    if (s2 < s1) [s1, s2] = [s2, s1];
    facts.push({
      id: i,
      kind: "fact",
      slot,
      person,
      key: `person.${slugOf(person)}.${slot}`,
      value1,
      seq1: s1,
      value2,
      seq2: s2,
      queries: [
        slot === "location" ? `Remind me — where does ${person} live now?` : `Where does ${person} work now?`,
      ],
    });
  }

  // 4. quotes
  const quotes: PlantedQuote[] = [];
  for (let i = 0; i < quoteCount; i += 1) {
    const person = nextPerson();
    const words = [
      plant.pick(V.rare),
      plant.pick(V.rare),
      plant.pick(V.rare),
      String(plant.int(1000, 9999)),
      plant.pick(V.rare),
      plant.pick(V.rare),
    ];
    const text = `“${words.join(" ")}”`;
    const seq = claim(plant.int(3, n - Math.max(4, Math.round(1000 * scale))));
    const prefix = `${person} wrote this and I want it kept exactly: `;
    quotes.push({
      kind: "quote",
      person,
      text,
      head: words.join(" ").toLowerCase(),
      seq,
      span: [prefix.length, prefix.length + text.length],
      query: `I need the exact wording of what ${person} wrote — can you get it?`,
    });
  }

  // 5. numbers
  const numbers: PlantedNumber[] = [];
  const used: number[] = [];
  for (let i = 0; i < numberCount; i += 1) {
    const person = nextPerson();
    const metric = plant.pick(V.metric);
    const project = plant.pick(V.project);
    let value = 0;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      value = Math.round((1000 + plant.u01() * 98_999) * 100) / 100;
      if (used.every((prior) => Math.abs(prior - value) / Math.max(prior, 1) > 0.01)) break;
    }
    used.push(value);
    const valueText = value.toFixed(2);
    const seq = claim(plant.int(3, n - Math.max(4, Math.round(1000 * scale))));
    const prefix = `${person} reported the final ${metric.name} for ${project}: `;
    numbers.push({
      kind: "number",
      person,
      key: `${project}.${metric.name.replace(/\s+/g, "_")}`,
      value,
      valueText,
      name: normalizeNumberName(valueText, metric.unit),
      seq,
      span: [prefix.length, prefix.length + `${valueText} ${metric.unit}`.length],
      query: `What number did ${person} report?`,
    });
  }

  // 6. name-free memories — drawn after every plant above, from their own
  // stream, so a given seed's fact/quote/number manifest is unchanged by them.
  assertNameFree();
  const memoryStream = stream(seed, "memory", 0);
  const memories: PlantedMemory[] = [];
  const tuples = new Set<string>();
  for (let i = 1; i <= memoryCount; i += 1) {
    let nounA = "";
    let verb = "";
    let prep = "";
    let nounB = "";
    let tuple = "";
    // The four content words are the whole address: two memories sharing them
    // would make the search ambiguous and the probe would measure collision.
    for (let attempt = 0; attempt < 64; attempt += 1) {
      nounA = memoryStream.pick(V.memNoun);
      verb = memoryStream.pick(V.memVerb);
      prep = memoryStream.pick(V.memPrep);
      nounB = memoryStream.pick(V.memNoun);
      tuple = `${nounA}|${verb}|${prep}|${nounB}`;
      if (nounA !== nounB && !tuples.has(tuple)) break;
    }
    assert(!tuples.has(tuple), `memory ${i}: no unique word tuple after 64 draws`);
    tuples.add(tuple);
    const adj = memoryStream.pick(V.memAdj);
    const text = `the ${nounA} ${verb}ed ${adj} ${prep} the ${nounB}.`;
    assert(names(text).length === 0, `memory ${i}: "${text}" carries a routing name`);
    const seq = claim(memoryStream.int(3, n - Math.max(4, Math.round(1000 * scale))));
    memories.push({
      id: i,
      kind: "memory",
      nounA,
      verb,
      adj,
      nounB,
      text,
      seq,
      query: `how did the ${nounA} ${verb} ${prep} the ${nounB}?`,
    });
  }

  // 7. authority poison — the assistant restates a fact wrongly (KERNEL A9.1).
  const poisonStream = stream(seed, "poison", 0);
  const persons: PlantedPerson[] = [];
  const gapLo = Math.max(4, Math.round(2000 * scale));
  const gapHi = Math.max(gapLo + 4, Math.round(200_000 * scale));
  for (let i = 1; i <= personCount; i += 1) {
    const person = nextPerson();
    const variant: PoisonVariant = i % 4 === 3 ? "C" : i % 4 === 2 ? "B" : "A";
    const [value1, value2, value3] = distinctPlaces(poisonStream);
    const want = poisonStream.int(3, Math.max(5, n - Math.round(60_000 * scale)));
    const gap1 = poisonStream.int(gapLo, gapHi);
    const gap2 = poisonStream.int(gapLo, gapHi);
    const key = `person.${slugOf(person)}.location`;
    const query = `Remind me — where does ${person} live now?`;
    if (variant === "B") {
      persons.push({
        id: i,
        kind: "poison",
        variant,
        person,
        key,
        value2,
        claimSeq: claim(want) + 1,
        query,
      });
      continue;
    }
    // `claim` wraps at the end of the archive, so the story is ordered by seq
    // after the fact: what is said first is whatever landed first.
    const wants = variant === "C" ? [want, want + gap1, want + gap1 + gap2] : [want, want + gap1];
    const seqs = wants.map((w) => claim(w)).sort((a, b) => a - b);
    persons.push({
      id: i,
      kind: "poison",
      variant,
      person,
      key,
      value1,
      statedSeq: seqs[0] as number,
      value2,
      claimSeq: (seqs[1] as number) + 1,
      ...(variant === "C" ? { value3, correctedSeq: seqs[2] as number } : {}),
      query,
    });
  }
  assert(personCursor <= people.length, `person pool exhausted: ${personCursor} > ${people.length}`);

  const manifest: CorpusManifest = {
    seed,
    n,
    ruleSeq: 1,
    revisionSeq,
    trapSeq,
    ruleText: RULE_TEXT,
    revisionText: REVISION_TEXT,
    trapText: TRAP_TEXT,
    handoffs,
    facts,
    quotes,
    numbers,
    memories,
    persons,
  };

  // ---- indexes for O(1) lookup during generation
  const scripted = new Map<number, { role: Role; content: string }>();
  scripted.set(1, { role: "user", content: RULE_TEXT });
  scripted.set(2, {
    role: "assistant",
    content: "Understood. Rule recorded: no production migration before the dry-run database is verified.",
  });
  scripted.set(revisionSeq, { role: "user", content: REVISION_TEXT });
  scripted.set(revisionSeq + 1, {
    role: "assistant",
    content:
      "Updated. The exception (additive-only plus the on-call lead skipping the dry-run) is now part of the rule.",
  });
  scripted.set(trapSeq, { role: "user", content: TRAP_TEXT });
  for (const fact of facts) {
    const first =
      fact.slot === "location"
        ? `${fact.person} lives in ${fact.value1}.`
        : `${fact.person} works at ${fact.value1}.`;
    const second =
      fact.slot === "location"
        ? `Actually, ${fact.person} moved to ${fact.value2}.`
        : `${fact.person} switched jobs — now at ${fact.value2}.`;
    scripted.set(fact.seq1, { role: "user", content: first });
    scripted.set(fact.seq1 + 1, { role: "assistant", content: `Noted — ${first}` });
    scripted.set(fact.seq2, { role: "user", content: second });
    scripted.set(fact.seq2 + 1, {
      role: "assistant",
      content: `Updated: ${fact.key} is now ${fact.value2} (was ${fact.value1}).`,
    });
  }
  for (const quote of quotes) {
    scripted.set(quote.seq, {
      role: "user",
      content: `${quote.person} wrote this and I want it kept exactly: ${quote.text}`,
    });
    scripted.set(quote.seq + 1, { role: "assistant", content: "Kept verbatim." });
  }
  for (const number of numbers) {
    const metricName = number.key.split(".")[1]?.replace(/_/g, " ") ?? "metric";
    const project = number.key.split(".")[0] ?? "project";
    const unit = number.name.split(" ")[1] ?? "";
    scripted.set(number.seq, {
      role: "user",
      content: `${number.person} reported the final ${metricName} for ${project}: ${number.valueText} ${unit}. Hold onto that.`,
    });
    scripted.set(number.seq + 1, {
      role: "assistant",
      content: `Recorded ${number.valueText} ${unit}.`,
    });
  }
  for (const memory of memories) {
    scripted.set(memory.seq, { role: "user", content: memory.text });
    scripted.set(memory.seq + 1, { role: "assistant", content: "Noted." });
  }
  for (const person of persons) {
    if (person.statedSeq !== undefined) {
      scripted.set(person.statedSeq, {
        role: "user",
        content: `${person.person} lives in ${person.value1}.`,
      });
      scripted.set(person.statedSeq + 1, { role: "assistant", content: "Noted." });
    }
    scripted.set(person.claimSeq - 1, { role: "user", content: `Any news on ${person.person}?` });
    scripted.set(person.claimSeq, {
      role: "assistant",
      content: `${person.person} lives in ${person.value2}. I can draft the note.`,
    });
    if (person.correctedSeq !== undefined) {
      scripted.set(person.correctedSeq, {
        role: "user",
        content: `Actually, ${person.person} moved to ${person.value3}.`,
      });
      scripted.set(person.correctedSeq + 1, { role: "assistant", content: "Noted." });
    }
  }
  const handoffSet = new Set(handoffs);

  const modelAt = (seq: number): string => {
    let index = 0;
    for (const handoff of handoffs) if (seq > handoff) index += 1;
    return MODELS[index % MODELS.length] as string;
  };

  const episodeAt = (seq: number): CorpusEpisode => {
    if (handoffSet.has(seq)) {
      let index = 0;
      for (const handoff of handoffs) if (seq > handoff) index += 1;
      const from = MODELS[(index - 1 + MODELS.length) % MODELS.length] as string;
      const to = MODELS[index % MODELS.length] as string;
      return { role: "handoff", content: `${from} stopped here. ${to} continued from the same thread.` };
    }
    const fixed = scripted.get(seq);
    if (fixed !== undefined) {
      return fixed.role === "assistant"
        ? { role: "assistant", content: fixed.content, model: modelAt(seq) }
        : fixed;
    }
    // Parity fixer: two user turns must never collide.
    if (isUser(seq, scripted) && isUser(seq + 1, scripted)) {
      return { role: "system", content: "Session resumed." };
    }
    if (isUser(seq, scripted)) return { role: "user", content: userTurn(seed, seq) };
    return { role: "assistant", content: assistantTurn(seed, seq - 1), model: modelAt(seq) };
  };

  const plantedBefore = (seq: number): Planted => ({
    facts: facts.filter((f) => f.seq2 + 1 < seq),
    quotes: quotes.filter((q) => q.seq + 1 < seq),
    numbers: numbers.filter((x) => x.seq + 1 < seq),
    memories: memories.filter((m) => m.seq + 1 < seq),
    // The whole story must be in the archive before the law can be checked.
    persons: persons.filter((p) => lastSeqOf(p) + 1 < seq),
  });

  return {
    seed,
    n,
    manifest,
    planted: { facts, quotes, numbers, memories, persons },
    episodeAt,
    plantedBefore,
  };
}

/** The last episode of a poison story — the point from which its law is checkable. */
function lastSeqOf(person: PlantedPerson): number {
  return Math.max(person.claimSeq, person.correctedSeq ?? 0);
}

/** Three different places, in draw order. */
function distinctPlaces(rng: Rng): [string, string, string] {
  const out: string[] = [];
  while (out.length < 3) {
    const place = rng.pick(V.place);
    if (!out.includes(place)) out.push(place);
  }
  return [out[0] as string, out[1] as string, out[2] as string];
}

/**
 * The name-free vocabulary carries no routing key, no FTS stop word, and no word
 * the rest of the corpus already uses. Asserted every run: if one of these words
 * ever became a name, the memories would be findable by the ledger and the probe
 * would prove something else than it claims.
 */
function assertNameFree(): void {
  const used = new Set<string>();
  for (const [list, items] of Object.entries(V.vocab)) {
    if (list.startsWith("mem")) continue;
    for (const item of items as readonly unknown[]) {
      const text = typeof item === "string" ? item : Object.values(item as Record<string, string>).join(" ");
      for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (word.length > 0) used.add(word);
      }
    }
  }
  const seen = new Set<string>();
  for (const word of [...V.memNoun, ...V.memVerb, ...V.memAdj, ...V.memPrep]) {
    assert(!seen.has(word), `name-free word "${word}" appears in two lists`);
    seen.add(word);
    assert(word === word.toLowerCase(), `name-free word "${word}" is not lowercase`);
    assert(!used.has(word), `name-free word "${word}" is already in the corpus vocabulary`);
    assert(ftsTerms(word).length === 1, `name-free word "${word}" does not survive ftsTerms`);
  }
  for (const verb of V.memVerb) {
    assert(ftsTerms(`${verb}ed`).length === 1, `past tense "${verb}ed" does not survive ftsTerms`);
  }
}

function isUser(seq: number, scripted: Map<number, { role: Role }>): boolean {
  const fixed = scripted.get(seq);
  if (fixed !== undefined) return fixed.role === "user";
  if (scripted.get(seq - 1)?.role === "user") return false;
  return seq % 2 === 1;
}

const FAMILIES: ReadonlyArray<readonly [string, number]> = [
  ["chat", 280],
  ["project", 220],
  ["fact", 120],
  ["decision", 60],
  ["ask", 80],
  ["longform", 40],
  ["aside", 200],
];

function userTurn(seed: string, seq: number): string {
  const layout = stream(seed, "layout", seq);
  const text = stream(seed, "text", seq);
  switch (layout.weighted(FAMILIES)) {
    case "chat":
      return text.u01() < 0.4
        ? `Long day. ${text.pick(V.weatherline)}`
        : text.u01() < 0.5
          ? `Just finished ${text.pick(V.show)}, thoughts?`
          : `Quick one before lunch: ${text.pick(V.trivia_q)}`;
    case "project": {
      const metric = text.pick(V.metric);
      return `Status on ${text.pick(V.project)}: the ${text.pick(V.component)} is ${text.pick(V.state)}; ${metric.name} at ${text.int(4, 899)} ${metric.unit}.`;
    }
    case "fact": {
      const person = `${text.pick(V.first)} ${text.pick(V.noiseLast)}`;
      return text.u01() < 0.5
        ? `${person} was born in ${text.pick(V.place)}.`
        : `My ${text.pick(V.relation)}'s name is ${text.pick(V.first)}.`;
    }
    case "decision":
      return text.u01() < 0.5
        ? `Let's go with ${text.pick(V.option)} for the ${text.pick(V.component)}.`
        : `Decision: use ${text.pick(V.tool)} for ${text.pick(V.task)}.`;
    case "ask":
      return text.u01() < 0.5
        ? `Remind me — what did we pick for the ${text.pick(V.component)}?`
        : `What was the plan for ${text.pick(V.project)} again?`;
    case "longform": {
      const project = text.pick(V.project);
      const component = text.pick(V.component);
      return [
        `I want to think through ${project} properly.`,
        `The ${component} is ${text.pick(V.state)} and I do not understand why.`,
        `We changed the ${text.pick(V.component)} last week and the ${text.pick(V.metric).name} moved.`,
        `What would you check first, and in what order?`,
      ].join(" ");
    }
    default:
      return `${text.pick(V.weatherline)} Nothing much to report.`;
  }
}

function assistantTurn(seed: string, userSeq: number): string {
  const layout = stream(seed, "layout", userSeq);
  const text = stream(seed, "text", userSeq);
  const family = layout.weighted(FAMILIES);
  // Draw the same tokens the user turn drew, so the reply echoes the same names.
  switch (family) {
    case "chat":
      return "Noted. Nothing to change on our side today.";
    case "project": {
      const metric = text.pick(V.metric);
      void text.pick(V.project);
      void text.pick(V.component);
      void text.pick(V.state);
      return `Acknowledged — ${metric.name} is the number to watch. I will keep an eye on it.`;
    }
    case "fact":
      return "Noted and recorded.";
    case "decision":
      return "Decision recorded.";
    case "ask":
      return "Let me check the archive before I answer that.";
    case "longform":
      return [
        "Here is how I would work through it, in order.",
        "First, confirm the change actually landed where you think it did.",
        "Second, compare the metric before and after the change window, not against last month.",
        "Third, look for a second change in the same window; two changes in one window is the usual story.",
        "Fourth, if nothing explains it, widen the window and check the dependency you did not touch.",
        "Fifth, write down what you expected before you look, so the check stays honest.",
      ].join(" ");
    default:
      return "Understood.";
  }
}

function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !["a", "an", "the", "to", "of"].includes(w))
    .slice(0, 4)
    .join("-");
}

function normalizeNumberName(valueText: string, unit: string): string {
  let normalized = valueText;
  if (normalized.includes(".")) normalized = normalized.replace(/0+$/, "").replace(/\.$/, "");
  return `${normalized} ${unit.toLowerCase()}`;
}

/** sha256 of the frozen vocabularies — recorded in the results file. */
export function vocabSha256(): string {
  return sha256Hex(JSON.stringify(V.vocab));
}
