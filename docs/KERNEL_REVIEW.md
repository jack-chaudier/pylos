# KERNEL.md review (partner pass, v1)

Ordered by severity. "Fix:" is proposed replacement text.

## Soundness holes

1. **§4 capsules slot cannot hold O(log n) capsules.** With F=8, S=32 a prefix of
   1M episodes needs up to 35 unsealed capsules (16 at exactly 1M); at 400–600
   tokens each that is 9.6k–21k tokens against an 18% slot (1,474 tokens at 8k,
   5,898 at 32k). The spec is unimplementable as written and the bench would
   fail assertion 1.
   **Fix:** decouple residency from the hierarchy. "Resident capsules are a fixed
   set: one **rolling root** covering `[1, a)`, the ≤2 most recent level-1
   capsules, the ≤2 most recent level-0 capsules. The root is recompacted (root
   text + the capsule leaving the window → `rootTokens`) whenever a capsule
   leaves the window; rows 18/37/38 license this (loss is contraction-gated and
   the ledger is conserved). Capsule token budgets derive from B: leaf
   `max(150, B/40)`, mid `max(200, B/32)`, root `max(300, B/16)`; resident
   capsule tokens ≤ 18% of B by construction. The hierarchy remains for ledger
   construction and the timeline rail." Also state when a level-k capsule seals:
   in the same tx as the episode with `seq mod (32·8^k) = 0`.
2. **§3 states conservation but not completeness.** `ledger(p) ⊇ ⋃ ledger(c)` is
   satisfied by an empty ledger everywhere. **Fix:** add the load-bearing
   invariant: "for every capsule `c`, `names(episodes[c.from..c.to]) ⊆
   names(c.text) ∪ ledger(c)`," and make `ledger(c)` a range query: `loss` rows
   with `seq ∈ [c.from, c.to]` (so `carried()` is implicit, rows are written once
   at the deepest drop, and the table is O(names) not O(names·levels)).
3. **§5.1 routes on `names(q) ∩ loss.name` without checking residency** → false
   pages for names already in the frontier/recent window, burning the paged
   slot. **Fix (the rule):** "page iff `n ∈ names(q_t) ∪ names(prev assistant)`
   ∧ `n ∈ loss` unresolved ∧ `n ∉ names(K_t^resident)` ∧ `n ∉ stopNames`.
   Numbers compare with the row-21 tolerance (exact, 1% relative, or equal after
   rounding to 0/1 dp); all else exact normalized string. Rank by kind priority
   quote > number > code > date > atom > entity, then most recent locator; dedupe
   by seq; serve ≤ `P_max = floor(pagedSlot / 450)` pages (3 at 8k, 13 at 32k);
   neighbours ±1 only while budget remains; skip names whose locator seq is
   already resident. Record precision per kind in `packet.pages`."
4. **§2 `names()` is undefined** and the ledger vocabulary will explode.
   **Fix — define `names(x)` exactly:**
   - *number*: `-?\d[\d,]*(?:\.\d+)?` → strip commas, strip trailing zeros; keep
     a following unit token if alphabetic ≤ 6 chars (`"483112"`, `"3.2 ms"`).
     Ignore bare integers < 32 and 4-digit years (those are dates).
   - *date*: ISO `YYYY-MM-DD`, `Month D, YYYY`, `D Month YYYY`, `MM/DD/YYYY` →
     `YYYY-MM-DD`; month+year → `YYYY-MM`.
   - *quote*: text inside `"…"`, `“…”`, `'…'` with ≥ 3 words → name = first six
     words, NFKC, case-folded, punctuation stripped (the quote-head).
   - *code*: backticked spans; tokens matching `[A-Za-z_][\w]*(\.[\w]+)+`,
     `snake_case` with ≥1 `_`, `camelCase` with an internal capital, filenames
     with an extension.
   - *entity*: runs of capitalized tokens not at sentence start (or ≥ 2
     consecutive anywhere); NFKC, case-fold, strip possessive `'s`, collapse
     whitespace; max 6 tokens, 64 chars. No stemming.
   - *atom*: every atom key and its value (value normalized as above).
   - Drop a stoplist of ~200 capitalized function words (I, The, Monday, June,
     English…). Cap 64 names per episode by kind priority. A name present in
     > 2% of the last 10,000 episodes becomes a *stop-name*: still recorded,
     never auto-routed (routable by explicit `recall`).
5. **§1 hash canonicalization is underspecified and breaks under `forget`.**
   **Fix:** "`hash_i = sha256(hash_{i-1} ‖ cjson({v:1, seq, ts, role, model,
   provider, content_hash, meta_hash}))` where `cjson` = UTF-8 byte-sorted keys,
   no whitespace, integers only, strings as-is (no NFC); `content_hash =
   sha256(utf8(content))` stored as a column; `meta_hash` covers only immutable
   meta (`blob, mime, name, size, from, to`), never `packetId/usage/pages/removed`.
   `forget` replaces `content` and keeps `content_hash`; `verify()` checks the
   chain over stored `content_hash` and, for non-removed rows, `sha256(content)
   == content_hash`. Checkpoints every 4,096 store `(seq, hash)`."
6. **§1/§6 crash story is internally inconsistent.** One turn has two transactions
   (user append; assistant append) with a network call between; async model
   atomization adds a third. **Fix:** "tx A: user/attachment episodes + packet
   (status `pending`). tx B: assistant episode + rule atoms + capsules + packet
   status `done`. Async model atoms commit in tx C, frontier-only (sealed capsules
   are never rewritten). A dangling `pending` packet after restart is shown as
   *no reply* and the user episode is retried on the next turn. `PRAGMA
   journal_mode=WAL; synchronous=FULL` for tx A/B (NORMAL allowed in bench)."
7. **§7 `packets.jsonl` with full `messages` is unbounded.** 1M packets × 8k
   tokens ≈ 30 GB in the vault and the export. **Fix:** store `messages` only
   for the last 1,000 packets; all packets keep `digest`, `resident[]`, `pages`,
   and `compilerVersion`; the X-ray re-renders from `resident[]` and asserts the
   digest matches (or shows "reconstructed" if atoms changed since).

## Ambiguities an implementer will trip on

- **HISTORICAL atoms in the frontier: no.** Row 41: all-as-of state is
  identity-like. Resident only via the §5.2 trigger; header shows `historical: n`
  count; digest lists ≤ 3 most recently changed keys.
- **Frontier eviction order** unstated. Fix: pinned → kind priority (rule,
  decision, identity, preference, task, fact, promise, hypothesis) → recency;
  each eviction writes a `loss` row of kind `atom`.
- **§5.3 lexical search on every turn** contradicts "pages are never fuzzy" in
  spirit and will burn the slot. Fix: trigger only when the query contains a
  question mark or an interrogative and ≥ 1 name that is neither resident nor in
  the ledger; `k = 2`; trigger `search`; counted against `P_max`.
- **`names(q)` routing "most recent locator first" vs "deepest source"**: pages
  resolve to episodes, always; "deepest" refers to where the drop was recorded.
- **Models without tools** (`supportsTools=false`): the view contract must not
  say "call `recall`"; fix: render a variant ("say you would need to check") and
  raise `P_max` by one.
- **§2 `correction` supersession "by key match"**: specify key normalization =
  `slug(kind + subject)` and that a correction whose key matches nothing creates
  a new fact (never silently dropped).
- **Token counting** applies to the rendered packet string, not a per-item sum.
- **FTS5 external-content table** needs its sync triggers; `forget` must run the
  delete trigger before replacing content.
- **`atom_key` index** lacks phase: add `(thread_id, phase, kind, valid_from_seq)`.
- **§10 "answered from the current atom" with zero model calls** is undefined;
  see `bench/CORPUS.md` for the packet-content oracle.

## Export format

- AES-256-GCM over one zip: use a 1 MiB chunked stream (per-chunk nonce =
  base‖counter, AAD = cleartext header `{v, kdf, salt, N, r, p | iters,
  threadId, headSeq, headHash, partial?:{from,to,prevHash}}`) so import can
  stream-verify a million-episode bundle; scrypt `N=2^17, r=8, p=1` preferred,
  PBKDF2-SHA256 ≥ 600k fallback. Partial exports must include the `prev_hash`
  at `from` so the chain verifies from the manifest.
- `manifest.json` carries per-file sha256 and the `loss` row count; import
  refuses if recomputed `dropped()` on any sampled capsule disagrees.

## Contradictions with the math (minor)

- "O(log n) capsules … the packet never grows with archive size" — true only
  after fix 1; the header's turn count still grows by digits (acceptable, say so).
- "Recall 1.00" in §3 should read "recall 1.00 by construction for names the
  extractor recognizes" (THEORY §15).
