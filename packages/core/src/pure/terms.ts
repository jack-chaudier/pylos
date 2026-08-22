/**
 * The lexical route's vocabulary: which words of a query are worth searching.
 *
 * Terms are ANDed, not ORed, and function words are dropped: an OR over
 * "where"/"live"/"now" matches most of a million-episode archive and BM25 then
 * has to score all of it. Lexical search is a fallback, and a fallback that
 * costs half a second is not one.
 *
 * It sits in `pure` because the same tokenization decides three things in three
 * places: what the vault's FTS5 MATCH expression contains, what the corpus
 * generator asserts about its name-free vocabulary, and what the landing page's
 * in-browser lexical route matches on.
 */

const FTS_STOP = new Set(
  (
    "the and for that with this from what where when who which why how does did was were are you your " +
    "our their his her its not but all any can could will would should about into onto over under " +
    "have has had been being remind tell give show much many some other than then there here now " +
    "like after before earlier said back again still yet"
  ).split(" "),
);

/**
 * The searchable terms of a query: ≥ 3 characters (KERNEL A9.4 — "tea" and
 * "rain" are addresses), stoplisted, deduplicated, capped at 6.
 */
export function ftsTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length < 40 && !FTS_STOP.has(t));
  return [...new Set(terms)].slice(0, 6);
}
