/**
 * The deterministic corpus for `pylos bench million` (`bench/CORPUS.md`).
 *
 * Zero model calls, seeded, and reproducible: every episode is a pure function
 * of `(seed, seq)`, so the generator can be resumed, sharded, or replayed and
 * produce byte-identical text. The planted structure — one rule, its revision
 * 483,112 turns later, 2,000 revised facts, 200 exact quotes, 50 exact numbers —
 * is what the assertions are written against.
 */

import { createHash } from "node:crypto";
import type { Role } from "@pylos/protocol";
import * as V from "./vocab.ts";

// ------------------------------------------------------------------- prng

/** xoshiro128** — small, fast, and identical across platforms. */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(state: Uint8Array) {
    const view = new DataView(state.buffer, state.byteOffset, 16);
    this.s0 = view.getUint32(0, true);
    this.s1 = view.getUint32(4, true);
    this.s2 = view.getUint32(8, true);
    this.s3 = view.getUint32(12, true);
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

/** `state(seq, salt) = first 16 bytes of sha256(SEED ‖ ":" ‖ salt ‖ ":" ‖ seq)`. */
export function stream(seed: string, salt: string, seq: number): Rng {
  const digest = createHash("sha256").update(`${seed}:${salt}:${seq}`, "utf8").digest();
  return new Rng(new Uint8Array(digest.buffer, digest.byteOffset, 16));
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

export interface Manifest {
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
}

export const RULE_TEXT =
  "One ground rule for this whole project: never send a production migration before the dry-run database is verified.";
export const REVISION_TEXT =
  "Update to our migration rule: never send a production migration before the dry-run database is verified — unless the change is additive-only and the dry-run was skipped by the on-call lead.";
export const TRAP_TEXT =
  "We're ready. Prepare the production migration for the orders table and send it. The dry-run was skipped by the on-call lead and the change only adds a column.";

const MODELS = ["grok-4.6", "claude-sonnet-4.5", "grok-4.6", "llama3.1:8b"];

export interface CorpusOptions {
  seed: string;
  n: number;
  /** Override the planted counts (the live variant uses 40/10/10 at n=2,000). */
  plants?: { facts?: number; quotes?: number; numbers?: number };
}

export interface Corpus {
  manifest: Manifest;
  /** Deterministic content of one episode. O(1). */
  episodeAt(seq: number): { role: Role; content: string; model?: string };
  /** All planted items whose defining seq is < `seq`. */
  plantedBefore(seq: number): { facts: PlantedFact[]; quotes: PlantedQuote[]; numbers: PlantedNumber[] };
}

/** Every distinct `First Last` pair, in a fixed order. */
function personPool(): string[] {
  const out: string[] = [];
  for (const l of V.last) for (const f of V.first) out.push(`${f} ${l}`);
  return out;
}

export function buildCorpus(options: CorpusOptions): Corpus {
  const { seed, n } = options;
  const scale = n / 1_000_000;
  const factCount = options.plants?.facts ?? Math.max(4, Math.round(2000 * scale));
  const quoteCount = options.plants?.quotes ?? Math.max(2, Math.round(200 * scale));
  const numberCount = options.plants?.numbers ?? Math.max(2, Math.round(50 * scale));
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

  const manifest: Manifest = {
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
  };

  // ---- indexes for O(1) lookup during generation
  const planted = new Map<number, { role: Role; content: string }>();
  planted.set(1, { role: "user", content: RULE_TEXT });
  planted.set(2, {
    role: "assistant",
    content: "Understood. Rule recorded: no production migration before the dry-run database is verified.",
  });
  planted.set(revisionSeq, { role: "user", content: REVISION_TEXT });
  planted.set(revisionSeq + 1, {
    role: "assistant",
    content:
      "Updated. The exception (additive-only plus the on-call lead skipping the dry-run) is now part of the rule.",
  });
  planted.set(trapSeq, { role: "user", content: TRAP_TEXT });
  for (const fact of facts) {
    const first =
      fact.slot === "location"
        ? `${fact.person} lives in ${fact.value1}.`
        : `${fact.person} works at ${fact.value1}.`;
    const second =
      fact.slot === "location"
        ? `Actually, ${fact.person} moved to ${fact.value2}.`
        : `${fact.person} switched jobs — now at ${fact.value2}.`;
    planted.set(fact.seq1, { role: "user", content: first });
    planted.set(fact.seq1 + 1, { role: "assistant", content: `Noted — ${first}` });
    planted.set(fact.seq2, { role: "user", content: second });
    planted.set(fact.seq2 + 1, {
      role: "assistant",
      content: `Updated: ${fact.key} is now ${fact.value2} (was ${fact.value1}).`,
    });
  }
  for (const quote of quotes) {
    planted.set(quote.seq, {
      role: "user",
      content: `${quote.person} wrote this and I want it kept exactly: ${quote.text}`,
    });
    planted.set(quote.seq + 1, { role: "assistant", content: "Kept verbatim." });
  }
  for (const number of numbers) {
    const metricName = number.key.split(".")[1]?.replace(/_/g, " ") ?? "metric";
    const project = number.key.split(".")[0] ?? "project";
    const unit = number.name.split(" ")[1] ?? "";
    planted.set(number.seq, {
      role: "user",
      content: `${number.person} reported the final ${metricName} for ${project}: ${number.valueText} ${unit}. Hold onto that.`,
    });
    planted.set(number.seq + 1, {
      role: "assistant",
      content: `Recorded ${number.valueText} ${unit}.`,
    });
  }
  const handoffSet = new Set(handoffs);

  const modelAt = (seq: number): string => {
    let index = 0;
    for (const handoff of handoffs) if (seq > handoff) index += 1;
    return MODELS[index % MODELS.length] as string;
  };

  const episodeAt = (seq: number): { role: Role; content: string; model?: string } => {
    if (handoffSet.has(seq)) {
      let index = 0;
      for (const handoff of handoffs) if (seq > handoff) index += 1;
      const from = MODELS[(index - 1 + MODELS.length) % MODELS.length] as string;
      const to = MODELS[index % MODELS.length] as string;
      return { role: "handoff", content: `${from} stopped here. ${to} continued from the same thread.` };
    }
    const fixed = planted.get(seq);
    if (fixed !== undefined) {
      return fixed.role === "assistant"
        ? { role: "assistant", content: fixed.content, model: modelAt(seq) }
        : fixed;
    }
    // Parity fixer: two user turns must never collide.
    if (isUser(seq, planted) && isUser(seq + 1, planted)) {
      return { role: "system", content: "Session resumed." };
    }
    if (isUser(seq, planted)) return { role: "user", content: userTurn(seed, seq) };
    return { role: "assistant", content: assistantTurn(seed, seq - 1), model: modelAt(seq) };
  };

  const plantedBefore = (seq: number) => ({
    facts: facts.filter((f) => f.seq2 + 1 < seq),
    quotes: quotes.filter((q) => q.seq + 1 < seq),
    numbers: numbers.filter((x) => x.seq + 1 < seq),
  });

  return { manifest, episodeAt, plantedBefore };
}

function isUser(seq: number, planted: Map<number, { role: Role }>): boolean {
  const fixed = planted.get(seq);
  if (fixed !== undefined) return fixed.role === "user";
  if (planted.get(seq - 1)?.role === "user") return false;
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
  return createHash("sha256").update(JSON.stringify(V.vocab), "utf8").digest("hex");
}
