/**
 * Token counting (KERNEL §4).
 *
 * v1 uses an approximate tokenizer — `chars / 3.6` with a 10% safety margin —
 * because the kernel must never *undercount*: the contract is that the packet
 * never exceeds the budget **by the kernel's own count**, and a margin makes the
 * kernel's count conservative with respect to real BPE tokenizers.
 *
 * A real tokenizer can be plugged in through {@link Tokenizer}; everything in
 * the kernel takes the counter as a parameter and never reaches for a global.
 */

/** Characters per token before the safety margin. */
export const CHARS_PER_TOKEN = 3.6;
/** Multiplicative safety margin applied to the raw estimate. */
export const TOKEN_MARGIN = 1.1;

/** A pluggable token counter. Must be deterministic and monotone in input length. */
export type Tokenizer = (text: string) => number;

/** The default approximate counter: `ceil(len / 3.6 * 1.1)`. */
export function approxTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * TOKEN_MARGIN);
}

/**
 * Wrap a character-based counter so that callers can pass `undefined`.
 * Keeping this in one place means "the kernel's own count" has one definition.
 */
export function tokenizerOr(tokenizer?: Tokenizer): Tokenizer {
  return tokenizer ?? approxTokens;
}

/**
 * The largest prefix of `text`, cut at a line boundary, that costs at most
 * `maxTokens`. Cutting at line boundaries is load-bearing: capsule text is made
 * of verbatim source lines, and `names()` is line-local, so a line-boundary cut
 * can only ever *remove* names — it can never invent one. See `names.ts`.
 *
 * Returns the kept prefix and the removed suffix so the caller can account for
 * what the truncation lost (Pylos never truncates silently).
 */
export function truncateLines(
  text: string,
  maxTokens: number,
  tokenizer: Tokenizer = approxTokens,
): { kept: string; dropped: string; keptTokens: number } {
  if (maxTokens <= 0) return { kept: "", dropped: text, keptTokens: 0 };
  const total = tokenizer(text);
  if (total <= maxTokens) return { kept: text, dropped: "", keptTokens: total };
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const cost = tokenizer(line) + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxTokens) break;
    kept.push(line);
    used += cost;
  }
  const keptText = kept.join("\n");
  return { kept: keptText, dropped: lines.slice(index).join("\n"), keptTokens: used };
}

/** Sum of the token cost of a list of strings joined by newlines. */
export function joinedTokens(parts: readonly string[], tokenizer: Tokenizer = approxTokens): number {
  if (parts.length === 0) return 0;
  return tokenizer(parts.join("\n"));
}
