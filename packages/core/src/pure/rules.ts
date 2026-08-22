/**
 * Rule-based atomizer patterns (KERNEL §2, stage 1).
 *
 * Deterministic, always on, cheap enough to run on every episode of a
 * million-turn thread. Rules only ever *propose* atoms; they never delete, and
 * supersession is decided by the caller against the vault (see `atomize.ts`).
 *
 * Everything here is pure so the landing page can run the same extraction in the
 * browser that the kernel runs on disk.
 */

import type { AtomKind, Role } from "@pylos/protocol";

/** A proposed atom, before it is given an id and reconciled with the vault. */
export interface AtomDraft {
  kind: AtomKind;
  /** Normalized slot. Two statements about the same slot supersede each other. */
  key: string;
  value: string;
  /** The human sentence the atom came from — quoted verbatim from the episode. */
  text: string;
  /** `[start, end)` char offsets into the episode content. */
  span: [number, number];
  /** Rule name; becomes `created_by = "rule:<name>"`. */
  rule: string;
  confidence: number;
  /**
   * For corrections of the form "not X, Y": the previous value being replaced.
   * The caller looks it up among SUPPORTED atoms to find the key to supersede.
   */
  supersedesValue?: string;
}

/** One sentence with its offsets in the containing text. */
export interface Sentence {
  text: string;
  start: number;
  end: number;
}

/** Split into sentences, keeping exact offsets. Breaks on `.!?` and newlines. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    const isBreak = ch === "\n" || ((ch === "." || ch === "!" || ch === "?") && isBoundary(text, i));
    if (!isBreak) continue;
    const end = ch === "\n" ? i : i + 1;
    pushSentence(out, text, start, end);
    start = i + 1;
  }
  pushSentence(out, text, start, text.length);
  return out;
}

function isBoundary(text: string, index: number): boolean {
  const next = text[index + 1];
  return next === undefined || next === " " || next === "\n" || next === '"' || next === "'";
}

function pushSentence(out: Sentence[], text: string, from: number, to: number): void {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start] as string)) start += 1;
  while (end > start && /\s/.test(text[end - 1] as string)) end -= 1;
  if (end - start < 2) return;
  out.push({ text: text.slice(start, end), start, end });
}

const SLUG_STOP = new Set(["a", "an", "the", "to", "of", "that", "is", "are", "was", "were"]);

/** Deterministic slug for atom keys: first `words` significant words, hyphenated. */
export function slug(text: string, words = 8): string {
  const parts = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !SLUG_STOP.has(w));
  const taken = parts.slice(0, words).join("-");
  return taken.length > 60 ? taken.slice(0, 60).replace(/-+$/, "") : taken;
}

/** Cue words that make a sentence worth keeping verbatim in a capsule (KERNEL §3). */
export const SALIENT_CUE =
  /\b(?:remember|from now on|always|never|we decided|we agreed|let'?s go with|going with|decision|rule:|i will|i'?ll|todo|remind me|actually|correction|must|should never|deadline|due)\b/i;

/** True if a sentence states a decision, rule, obligation or correction. */
export function isSalient(sentence: string): boolean {
  return SALIENT_CUE.test(sentence);
}

interface RuleSpec {
  name: string;
  re: RegExp;
  roles: Role[];
  build: (m: RegExpExecArray) => Omit<AtomDraft, "span" | "text" | "rule"> | null;
}

const NAMEY = "[A-Za-z][\\w'’-]*(?:[ ]+[A-Za-z][\\w'’-]*)*";

/**
 * Rule cues are matched case-insensitively, which would let `[A-Z]` inside the
 * value pattern match lowercase too. So the captured value is re-checked here,
 * case-sensitively: a proper noun is a run of capitalized words, optionally
 * joined by a lowercase particle ("Bank of England", "Ludwig van Beethoven").
 */
function properNoun(raw: string): string | null {
  const m = /^[A-Z][\w'’-]*(?:[ ]+(?:of|de|la|van|der|den|du|di)[ ]+[A-Z][\w'’-]*|[ ]+[A-Z][\w'’-]*)*/.exec(
    raw.trim(),
  );
  if (m === null) return null;
  const value = m[0].trim();
  return value.length >= 2 ? value : null;
}

/** Split `remember that X is Y` into a subject slot and a value. */
function copula(clause: string): { key: string; value: string } | null {
  const m = /^(.{2,70}?)\s+(?:is|are|was|were|=)\s+(.{1,160})$/i.exec(clause);
  if (!m) return null;
  const subject = slug(m[1] as string, 6);
  if (subject.length < 2) return null;
  return { key: subject, value: (m[2] as string).replace(/[.]$/, "").trim() };
}

const ALL: Role[] = ["user", "assistant", "system", "handoff", "tool", "attachment"];
const USER_ONLY: Role[] = ["user"];
const SPOKEN: Role[] = ["user", "assistant"];

const RULES: RuleSpec[] = [
  {
    name: "identity.name",
    roles: USER_ONLY,
    re: new RegExp(`\\b(?:my name is|call me|i(?:'m| am) called)\\s+(${NAMEY})`, "i"),
    build: (m) => {
      const value = properNoun(m[1] as string);
      return value === null ? null : { kind: "identity", key: "identity.name", value, confidence: 1 };
    },
  },
  {
    name: "user.location",
    roles: USER_ONLY,
    re: new RegExp(
      `\\b(?:i (?:live|reside) in|i(?:'ve| have)?\\s*(?:just\\s+)?moved to|i(?:'m| am)\\s*(?:now\\s+)?(?:living|based) in|i relocated to)\\s+(${NAMEY})`,
      "i",
    ),
    build: (m) => {
      const value = properNoun(m[1] as string);
      return value === null ? null : { kind: "fact", key: "user.location", value, confidence: 1 };
    },
  },
  {
    name: "remember",
    roles: SPOKEN,
    re: /\bremember(?:\s+that)?\s*[,:]?\s+(.{3,200})$/i,
    build: (m) => {
      const clause = (m[1] as string).trim().replace(/[.]$/, "");
      const split = copula(clause);
      if (split) return { kind: "fact", key: `fact.${split.key}`, value: split.value, confidence: 1 };
      return { kind: "fact", key: `fact.${slug(clause, 6)}`, value: clause, confidence: 0.9 };
    },
  },
  {
    name: "rule",
    roles: SPOKEN,
    re: /^(?:please\s+)?(?:rule:\s*|from now on[,:]?\s*|from here on[,:]?\s*|always\s+|never\s+|don'?t ever\s+)(.{3,220})$/i,
    build: (m, raw?: string) => {
      const clause = (m[1] as string).trim().replace(/[.]$/, "");
      const negated = /^(?:please\s+)?(?:never|don'?t ever)\b/i.test(raw ?? m.input);
      return {
        kind: "preference",
        key: `rule.${slug(clause, 8)}`,
        value: `${negated ? "never: " : ""}${clause}`,
        confidence: 1,
      };
    },
  },
  {
    name: "decision.stated",
    roles: SPOKEN,
    re: /^(?:decision:\s*|we (?:have )?decided(?:\s+(?:to|on|that))?\s+|we agreed(?:\s+(?:to|on|that))?\s+|let'?s go with\s+|we(?:'re| are) going with\s+|we'?ll use\s+)(.{3,200})$/i,
    build: (m) => {
      const clause = (m[1] as string).trim().replace(/[.]$/, "");
      return { kind: "decision", key: `decision.${slug(clause, 6)}`, value: clause, confidence: 1 };
    },
  },
  {
    name: "decision.use-for",
    roles: SPOKEN,
    re: /\b(?:we(?:'ll| will)?\s+)?use\s+(.{2,60}?)\s+for\s+(.{2,80}?)(?:[.]|$)/i,
    build: (m) => {
      const target = slug(m[2] as string, 6);
      if (target.length < 2) return null;
      return {
        kind: "decision",
        key: `decision.${target}`,
        value: (m[1] as string).trim(),
        confidence: 0.9,
      };
    },
  },
  {
    name: "task",
    roles: SPOKEN,
    re: /^(?:todo:?\s*|remind me to\s+|i will\s+|i'?ll\s+|i need to\s+|i'?m going to\s+)(.{3,200})$/i,
    build: (m) => {
      const clause = (m[1] as string).trim().replace(/[.]$/, "");
      return { kind: "task", key: `task.${slug(clause, 6)}`, value: clause, confidence: 0.85 };
    },
  },
  {
    name: "person.location",
    roles: SPOKEN,
    re: new RegExp(
      `^(${NAMEY})\\s+(?:lives in|now lives in|has moved to|moved to|relocated to|is based in)\\s+(${NAMEY})`,
      "i",
    ),
    build: (m) => {
      const who = properNoun(m[1] as string);
      const value = properNoun(m[2] as string);
      if (who === null || value === null) return null;
      return { kind: "fact", key: `person.${slug(who, 4)}.location`, value, confidence: 0.95 };
    },
  },
  {
    name: "person.employer",
    roles: SPOKEN,
    re: new RegExp(
      `^(${NAMEY})\\s+(?:works at|joined|switched jobs\\s*[—-]\\s*now at|is now at|now works at)\\s+(${NAMEY})`,
      "i",
    ),
    build: (m) => {
      const who = properNoun(m[1] as string);
      const value = properNoun(m[2] as string);
      if (who === null || value === null) return null;
      return { kind: "fact", key: `person.${slug(who, 4)}.employer`, value, confidence: 0.95 };
    },
  },
  {
    name: "person.birthplace",
    roles: SPOKEN,
    re: new RegExp(`^(${NAMEY})\\s+was born in\\s+(${NAMEY})`, "i"),
    build: (m) => {
      const who = properNoun(m[1] as string);
      const value = properNoun(m[2] as string);
      if (who === null || value === null) return null;
      return { kind: "fact", key: `person.${slug(who, 4)}.birthplace`, value, confidence: 0.95 };
    },
  },
  {
    // "The amber-ledger deploy window is Tuesday 09:30." — a concrete third-person
    // value statement. Gated on the value carrying a number, time, date or entity
    // so ordinary chat ("the weather is nice") does not become a fact.
    name: "fact.copula",
    roles: SPOKEN,
    re: /^(?:the|our)\s+([\w][\w '/-]{2,60}?)\s+(?:is|are|was|were)\s+(?:now\s+|currently\s+)?(.{2,90}?)[.]?$/i,
    build: (m) => {
      const value = (m[2] as string).trim();
      if (!/\d|^[A-Z]/.test(value)) return null;
      const key = slug(m[1] as string, 5);
      if (key.length < 3) return null;
      return { kind: "fact", key: `fact.${key}`, value, confidence: 0.85 };
    },
  },
  {
    name: "correction.not-but",
    roles: ALL,
    re: /\bnot\s+(.{2,80}?)\s*,\s*(?:but\s+|it'?s\s+|its\s+)?(.{2,120}?)(?:[.]|$)/i,
    build: (m) => ({
      kind: "correction",
      key: `correction.${slug(m[2] as string, 6)}`,
      value: (m[2] as string).trim(),
      supersedesValue: (m[1] as string).trim(),
      confidence: 0.95,
    }),
  },
];

/** The `actually …` / `correction: …` prefix — re-run the rules on the remainder. */
const CORRECTION_PREFIX = /^(?:actually|correction|sorry|no)\b[,:]?\s+(.{3,220})$/i;

/**
 * Apply the rule cascade to one episode's content.
 * Returns drafts in source order; the caller assigns ids and resolves supersession.
 */
export function applyRules(content: string, role: Role): AtomDraft[] {
  const drafts: AtomDraft[] = [];
  for (const sentence of splitSentences(content)) {
    collect(drafts, sentence.text, sentence, role, false);
    // Rules and decisions are often stated after a lead-in clause:
    // "One ground rule for this project: never send a production migration …".
    const colon = sentence.text.indexOf(": ");
    if (colon > 0 && colon < sentence.text.length - 4) {
      collect(drafts, sentence.text.slice(colon + 2), sentence, role, false);
    }
    const corrected = CORRECTION_PREFIX.exec(sentence.text);
    if (corrected) {
      const before = drafts.length;
      collect(drafts, corrected[1] as string, sentence, role, true);
      if (drafts.length === before) {
        const clause = (corrected[1] as string).trim().replace(/[.]$/, "");
        drafts.push({
          kind: "correction",
          key: `correction.${slug(clause, 6)}`,
          value: clause,
          text: sentence.text,
          span: [sentence.start, sentence.end],
          rule: "correction.bare",
          confidence: 0.8,
        });
      }
    }
  }
  return drafts;
}

function collect(out: AtomDraft[], probe: string, sentence: Sentence, role: Role, correction: boolean): void {
  for (const spec of RULES) {
    if (!spec.roles.includes(role)) continue;
    const match = spec.re.exec(probe);
    if (!match) continue;
    const built = (spec.build as (m: RegExpExecArray, raw?: string) => ReturnType<RuleSpec["build"]>)(
      match,
      probe,
    );
    if (!built) continue;
    out.push({
      ...built,
      text: sentence.text,
      span: [sentence.start, sentence.end],
      rule: correction ? `${spec.name}+correction` : spec.name,
      confidence: correction ? Math.min(1, built.confidence) : built.confidence,
    });
  }
}
