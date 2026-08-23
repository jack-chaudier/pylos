/**
 * Turn references — the sequence route's parser (KERNEL A9.3, A11.3). Pure:
 * the pager and the landing page's console address the archive by position
 * with this one function.
 */

import type { Seq } from "@pylos/protocol";

/** At most this many turn references per query, and this many episodes per range. */
const MAX_SEQUENCE_REFS = 3;
const MAX_SEQUENCE_SPAN = 6;

// A turn number as the interface prints it: "345", "483,112" (KERNEL A11.3).
const N = String.raw`(\d{1,3}(?:,\d{3})+|\d{1,9})`;
const RANGE = String.raw`(?:\s*(?:-|–|—|to|through)\s*#?${N})?`;

const SEQUENCE_CUES = [
  // "#345", "#345-350"
  new RegExp(`#${N}${RANGE}`, "g"),
  // "turn 345", "turns 345-350", "message 345", "episode 345", "seq 345"
  new RegExp(String.raw`\b(?:turns?|messages?|episodes?|seq)\s*#?\s*${N}${RANGE}`, "gi"),
  // "the 345th turn"
  new RegExp(String.raw`\bthe\s+${N}(?:st|nd|rd|th)\s+(?:turn|message|episode)\b`, "gi"),
];

/** "issue #12", "PR #12", "gh #12" number somebody else's archive, not ours. */
const FOREIGN_HASH = /(?:issue|pr|pull|ticket|bug|gh)\s?$/i;

/** One turn reference, with the span of the query text that produced it. */
export interface SequenceRef {
  from: Seq;
  to: Seq;
  /** `[start, end)` in the query — consumed before `names()` sees it. */
  start: number;
  end: number;
}

const digits = (text: string): number => Number(text.replace(/,/g, ""));

/**
 * Explicit turn references in a query (KERNEL A9.3). A bare number is never a
 * reference — "I have 345 apples" addresses no turn — so a cue word or `#` is
 * required, and a `#` that belongs to an issue or pull-request number is not
 * ours. Returned in the order they were written, deduplicated by target.
 */
export function sequenceRefs(query: string): SequenceRef[] {
  if (query.length === 0) return [];
  const found: SequenceRef[] = [];
  for (const pattern of SEQUENCE_CUES) {
    pattern.lastIndex = 0;
    let match = pattern.exec(query);
    while (match !== null) {
      const from = digits(match[1] ?? "");
      const to = match[2] === undefined || match[2] === "" ? from : digits(match[2]);
      if (from >= 1 && to >= from && !FOREIGN_HASH.test(query.slice(0, match.index))) {
        found.push({
          from,
          to: Math.min(to, from + MAX_SEQUENCE_SPAN - 1),
          start: match.index,
          end: match.index + match[0].length,
        });
      }
      match = pattern.exec(query);
    }
  }
  found.sort((a, b) => a.start - b.start);
  const out: SequenceRef[] = [];
  for (const reference of found) {
    if (out.some((r) => r.from === reference.from && r.to === reference.to)) continue;
    out.push(reference);
    if (out.length >= MAX_SEQUENCE_REFS) break;
  }
  return out;
}

/**
 * Blank out the spans a trigger has already consumed, keeping every offset. A
 * turn reference is an address, not a value: "turn 345" must not also enter the
 * routing vocabulary as the number 345 (KERNEL A9.3).
 */
export function consumeRefs(text: string, spans: readonly SequenceRef[]): string {
  let out = text;
  for (const span of spans) {
    out = out.slice(0, span.start) + " ".repeat(span.end - span.start) + out.slice(span.end);
  }
  return out;
}
