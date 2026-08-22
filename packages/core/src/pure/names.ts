/**
 * `names(text)` — the routing vocabulary (KERNEL §3–§5, KERNEL_REVIEW fix 4).
 *
 * The loss ledger is defined by set difference over this function:
 * `dropped(c) = names(src) \ names(c.text)`. It is therefore *the* definition of
 * "what a summary no longer contains", and it must be
 *
 *  - **deterministic** — same text ⇒ same names, same order, same spans;
 *  - **line-local** — no hit spans a `\n` and no capitalized run crosses a
 *    sentence boundary, which gives `names(a ‖ "\n" ‖ b) ⊇ names(a) ∪ names(b)`.
 *    Capsule text is assembled from verbatim source lines, so cutting at a line
 *    boundary can only remove names, never invent one. This is what makes the
 *    completeness invariant `names(episodes) ⊆ names(c.text) ∪ ledger(c)`
 *    provable rather than hoped for;
 *  - **cheap** — it runs over every episode of a million-turn thread;
 *  - **bounded** — at most 64 names per episode, taken by kind priority.
 *
 * Over-inclusion is safe (an extra ledger entry is an extra thing we promise to
 * page back). Under-inclusion is not: a name we fail to see is a name a summary
 * can drop silently.
 */

import type { LossKind } from "@pylos/protocol";

/** One occurrence of a routing key inside a text. */
export interface NameHit {
  /** Normalized routing key — the value stored in `loss.name`. */
  name: string;
  kind: LossKind;
  /** Char offsets into the source text: `[start, end)`. */
  start: number;
  end: number;
  /** The exact substring, before normalization. */
  raw: string;
}

export interface NamesOptions {
  /** Cap on distinct names per text; taken by kind priority. Default 64. */
  max?: number;
}

/** KERNEL_REVIEW fix 4: cap 64 names per episode. */
export const DEFAULT_MAX_NAMES = 64;

/** Routing priority: rarer, more decisive kinds win the cap and the page slot. */
export const KIND_PRIORITY: Record<LossKind, number> = {
  quote: 0,
  number: 1,
  code: 2,
  date: 3,
  atom: 4,
  entity: 5,
};

/** Bare integers below this are not routing keys (KERNEL_REVIEW fix 4). */
export const MIN_BARE_NUMBER = 32;

const STOP_WORDS =
  "i a an the and or but if so we you he she it they them their there here then this that these those " +
  "when what where why how who whom which whose yes no ok okay sure thanks thank please also just now " +
  "today tomorrow yesterday tonight can could will would shall should may might must do does did done " +
  "have has had be been being am is are was were get got let lets my your our his her its me him us " +
  "not never always from for with without about into onto over under after before during since until " +
  "as at by in on to of up out off per via vs use used using see note good great nice sorry hi hello " +
  "hey right left new old next last first second third one two three four five six seven eight nine " +
  "ten actually really very much more most less least because while unless both each every any all " +
  "some none other another such only own same than too very still even ever again once here there " +
  "monday tuesday wednesday thursday friday saturday sunday january february march april may june " +
  "july august september october november december mon tue wed thu fri sat sun jan feb mar apr jun " +
  "jul aug sep sept oct nov dec english spanish french german chinese japanese american european " +
  "update updated updates noted recorded understood decision decisions rule rules status final " +
  "quick long short session resumed running done ready hold onto keep kept";
/** ~200 capitalized function words that are never entities. */
const ENTITY_STOP = new Set(STOP_WORDS.split(" ").filter((w) => w.length > 0));

/** Units that may follow a number: alphabetic, ≤ 6 chars, from a fixed list. */
const UNIT_LIST = [
  "%",
  "ms",
  "s",
  "sec",
  "secs",
  "min",
  "mins",
  "h",
  "hr",
  "hrs",
  "d",
  "day",
  "days",
  "wk",
  "wks",
  "mo",
  "yr",
  "yrs",
  "b",
  "kb",
  "mb",
  "gb",
  "tb",
  "kib",
  "mib",
  "gib",
  "bytes",
  "byte",
  "k",
  "m",
  "bn",
  "x",
  "px",
  "pt",
  "em",
  "rem",
  "usd",
  "eur",
  "gbp",
  "kg",
  "g",
  "lb",
  "lbs",
  "km",
  "mi",
  "cm",
  "mm",
  "rows",
  "users",
  "req",
  "rps",
  "qps",
  "tps",
  "tokens",
  "cores",
  "gpus",
  "cpus",
  "c",
  "f",
  "rpm",
  "iops",
  "pass",
  "fail",
];
const UNITS = new Set(UNIT_LIST);

const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

const MONTH_NAMES =
  "Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December";

interface Pattern {
  kind: LossKind;
  re: RegExp;
  /** Claim the span without emitting a name (kernel markup). */
  skip?: boolean;
  /** Extra acceptance / normalization; return null to reject the match. */
  refine?: (m: RegExpExecArray, text: string) => string | null;
}

/**
 * Patterns in priority order. Earlier patterns claim their character range, so a
 * quoted string is never also mined for the identifiers inside it.
 * Every pattern is newline-free by construction.
 */
const PATTERNS: Pattern[] = [
  // Kernel markup (⟨#12⟩, ⟨lost: …⟩, ⟦recovered …⟧) is claimed but never emitted:
  // the view's own scaffolding must not become part of the routing vocabulary.
  { kind: "code", re: /[⟨⟦][^⟩⟧\n]{0,4000}[⟩⟧]/g, skip: true },
  // quote-heads: quoted spans of ≥ 3 words, named by their first six words
  {
    kind: "quote",
    re: /"([^"\n]{4,400})"|“([^”\n]{4,400})”|(?<![A-Za-z])'([^'\n]{4,400})'(?![A-Za-z])/g,
    refine: (m) => quoteHead(m[1] ?? m[2] ?? m[3] ?? ""),
  },
  // backticked code
  { kind: "code", re: /`([^`\n]{1,160})`/g, refine: (m) => codeName(m[1] ?? "") },
  // ISO dates
  { kind: "date", re: /\b\d{4}-\d{2}-\d{2}\b/g, refine: (m) => m[0] },
  // Month D, YYYY  /  D Month YYYY  /  Month YYYY
  {
    kind: "date",
    re: new RegExp(
      `\\b(?:(${MONTH_NAMES})\\.?[ ]+(\\d{1,2})(?:st|nd|rd|th)?,?[ ]+(\\d{4})` +
        `|(\\d{1,2})(?:st|nd|rd|th)?[ ]+(${MONTH_NAMES})\\.?,?[ ]+(\\d{4})` +
        `|(${MONTH_NAMES})[ ]+(\\d{4}))\\b`,
      "g",
    ),
    refine: (m) => monthDate(m),
  },
  // MM/DD/YYYY
  {
    kind: "date",
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
    refine: (m) => `${m[3]}-${(m[1] as string).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`,
  },
  // currency
  { kind: "number", re: /[$€£]\s?-?\d[\d,]*(?:\.\d+)?/g, refine: (m) => numberName(m[0], "") },
  // number, optionally followed by a unit token
  {
    kind: "number",
    re: /(-?\d[\d,]*(?:\.\d+)?)(?:[ ]?([A-Za-z%]{1,6}))?\b/g,
    refine: (m) => numberName(m[1] as string, m[2] ?? ""),
  },
  // dotted / snake / kebab / path identifiers, filenames with an extension
  { kind: "code", re: /\b[A-Za-z_][A-Za-z0-9_]*(?:[._\-/][A-Za-z0-9_]+)+\b/g, refine: (m) => codeName(m[0]) },
  // camelCase identifiers
  { kind: "code", re: /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g, refine: (m) => codeName(m[0]) },
  // capitalized runs; `[ ]` only, so a run can never cross a newline or sentence end
  {
    kind: "entity",
    re: /\b[A-Z][\p{L}\p{N}'’&]*(?:[ ]+[A-Z][\p{L}\p{N}'’&]*)*/gu,
    refine: (m, text) => entityName(m, text),
  },
];

function fold(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Quote-head: first six words of a quoted span of ≥ 3 words, punctuation stripped. */
function quoteHead(inner: string): string | null {
  const words = fold(inner)
    .replace(/[^\p{L}\p{N}\s.'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length < 3) return null;
  const head = words.slice(0, 6).join(" ");
  return head.length >= 6 ? head.slice(0, 96) : null;
}

function codeName(raw: string): string | null {
  const value = raw
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^[`'"]+|[`'"]+$/g, "");
  if (value.length < 3 || value.length > 96) return null;
  if (!/[a-z0-9]/.test(value)) return null;
  return value;
}

function monthDate(m: RegExpExecArray): string | null {
  if (m[1]) {
    const month =
      MONTHS[(m[1] as string).slice(0, 4).toLowerCase()] ?? MONTHS[(m[1] as string).toLowerCase()];
    if (month) return `${m[3]}-${month}-${(m[2] as string).padStart(2, "0")}`;
  }
  if (m[5]) {
    const month =
      MONTHS[(m[5] as string).slice(0, 4).toLowerCase()] ?? MONTHS[(m[5] as string).toLowerCase()];
    if (month) return `${m[6]}-${month}-${(m[4] as string).padStart(2, "0")}`;
  }
  if (m[7]) {
    const month =
      MONTHS[(m[7] as string).slice(0, 4).toLowerCase()] ?? MONTHS[(m[7] as string).toLowerCase()];
    if (month) return `${m[8]}-${month}`;
  }
  return null;
}

/**
 * Number names: commas stripped, trailing decimal zeros stripped, a whitelisted
 * unit kept. Bare integers < 32 and bare 4-digit years are not routing keys.
 */
function numberName(digits: string, unit: string): string | null {
  const cleaned = digits.replace(/[,$€£\s]/g, "");
  if (!/^-?\d/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  const hasUnit = unit.length > 0 && UNITS.has(unit.toLowerCase());
  if (!hasUnit) {
    if (Number.isInteger(value) && Math.abs(value) < MIN_BARE_NUMBER) return null;
    if (Number.isInteger(value) && cleaned.length === 4 && value >= 1500 && value <= 2999) return null;
  }
  let normalized = cleaned;
  if (normalized.includes(".")) normalized = normalized.replace(/0+$/, "").replace(/\.$/, "");
  return hasUnit ? `${normalized} ${unit.toLowerCase()}` : normalized;
}

/**
 * Entity names: a run of capitalized tokens. A *single* capitalized token at a
 * sentence start is not an entity (it is just a capital letter); two or more
 * consecutive capitalized tokens are an entity anywhere.
 */
function entityName(m: RegExpExecArray, text: string): string | null {
  const raw = m[0];
  const multiword = raw.includes(" ");
  if (!multiword && atSentenceStart(text, m.index)) return null;
  let value = fold(raw).replace(/[’']s$/, "");
  const tokens = value.split(" ").filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  if (tokens.length > 6) value = tokens.slice(0, 6).join(" ");
  if (!multiword && ENTITY_STOP.has(value)) return null;
  if (multiword && tokens.every((t) => ENTITY_STOP.has(t))) return null;
  if (value.length < 2 || value.length > 64) return null;
  return value;
}

function atSentenceStart(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0) {
    const ch = text[i] as string;
    if (ch === " " || ch === "\t" || ch === '"' || ch === "“" || ch === "'" || ch === "(") {
      i -= 1;
      continue;
    }
    return ch === "\n" || ch === "." || ch === "!" || ch === "?" || ch === ":" || ch === ";";
  }
  return true;
}

/**
 * Extract the routing keys of `text`. Deduplicated by normalized name (first hit
 * wins, so spans point at the earliest occurrence), capped by kind priority, and
 * returned in source order.
 */
export function names(text: string, options: NamesOptions = {}): NameHit[] {
  const max = options.max ?? DEFAULT_MAX_NAMES;
  if (text.length === 0 || max <= 0) return [];
  const claimed = new Uint8Array(text.length);
  const hits: NameHit[] = [];
  const seen = new Set<string>();

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let match = pattern.re.exec(text);
    while (match !== null) {
      const start = match.index;
      const end = start + match[0].length;
      let overlap = false;
      for (let i = start; i < end; i += 1) {
        if (claimed[i] === 1) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        if (pattern.skip === true) {
          claimed.fill(1, start, end);
        } else {
          const name = pattern.refine ? pattern.refine(match, text) : match[0];
          if (name !== null && name.length > 0) {
            claimed.fill(1, start, end);
            if (!seen.has(name)) {
              seen.add(name);
              hits.push({ name, kind: pattern.kind, start, end, raw: match[0] });
            }
          }
        }
      }
      if (pattern.re.lastIndex === match.index) pattern.re.lastIndex += 1;
      match = pattern.re.exec(text);
    }
  }

  if (hits.length > max) {
    hits.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.start - b.start);
    hits.length = max;
  }
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

/** The name set of a text — the form used by the ledger set algebra. */
export function nameSet(text: string, options?: NamesOptions): Set<string> {
  const set = new Set<string>();
  for (const hit of names(text, options)) set.add(hit.name);
  return set;
}

/** Routing keys of a query. Exact, never fuzzy (KERNEL §5). */
export function queryNames(query: string): NameHit[] {
  return names(query, { max: 64 });
}

/** Numbers appearing in a text, for the row-21 `retained` tolerance. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /-?\d[\d,]*(?:\.\d+)?/g;
  let m = re.exec(text);
  while (m !== null) {
    const value = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(value)) out.push(value);
    m = re.exec(text);
  }
  return out;
}

/**
 * Row-21 numeric presence: exact, within 1% relative, or equal after rounding to
 * 0 or 1 decimal places (THEORY §6). Used so a number is not "paged back" when
 * the packet already contains it in a slightly different rendering.
 */
export function retained(text: string, value: number): boolean {
  for (const x of numbersIn(text)) {
    if (Math.abs(x - value) < 1e-9) return true;
    if (value !== 0 && Math.abs(x - value) / Math.abs(value) <= 0.01) return true;
    if (x === Math.round(value) || x === Math.round(value * 10) / 10) return true;
  }
  return false;
}

/** Parse a normalized number-name back to its numeric value, if it is one. */
export function numericValue(name: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)(?:\s|$)/.exec(name);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

/** Normalize an arbitrary string as a name of the given kind (for atom keys/values). */
export function normalizeName(raw: string, kind: LossKind): string {
  if (kind === "number") return numberName(raw, "") ?? fold(raw);
  if (kind === "quote") return quoteHead(raw) ?? fold(raw);
  return fold(raw).slice(0, 96);
}
