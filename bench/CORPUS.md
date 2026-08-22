# `pylos bench million` — corpus, trap, baselines, assertions, results schema

Deterministic, zero model calls, seeded. This document fixes every decision the
generator needs. Anything not fixed here is a bug in this document, not a choice
for the implementer.

## 0. Conventions

- **Episode seq** is 1-based. "Turn t" in this bench means **episode seq t**.
  Planted user turns are at seqs 1, 483,112 and 1,000,000 (the trap query); a
  parity fixer (§2.3) guarantees they are `user` episodes.
- `N = 1,000,000`, `B = 8,192` (demo budget; `--budget` overrides), checkpoints
  every 10,000 plus `N`.
- All randomness comes from per-seq streams (§1). The generator may run in
  parallel; output is identical regardless of order.
- Text is ASCII except the typographic quotes used for planted quotes. Every
  episode is ≤ 4 KiB.

## 1. PRNG

Master seed: a decimal string `SEED` (default `"1"`). Derive a per-seq stream:

```
state(seq, salt) = first 16 bytes of sha256(utf8(SEED + ":" + salt + ":" + seq))
rng = xoshiro128**  seeded with state as four little-endian uint32 (if all zero, set s[0]=1)
```

`salt` ∈ {`"layout"`, `"text"`, `"plant"`}. Draw helpers (all on `rng.next()` →
uint32): `u01() = next()/2^32`; `int(a,b) = a + floor(u01()·(b−a+1))`;
`pick(list) = list[int(0, len−1)]`; `weighted(table) = first key whose cumulative
weight > u01()·total` (table order as listed). Never reuse a stream across seqs.
Planting (§3) uses the `"plant"` stream of seq 0 only, drawn in the order §3
lists.

## 2. Layout

### 2.1 Roles and families

The layout is a cursor walk from seq 1 to N. At cursor `c`:

1. If `c ∈ PLANTED_USER` (`{1, 483112, 1000000}`) or `c` is a scheduled plant
   seq (§3) → emit that exchange (user at `c`, assistant at `c+1`).
2. Else if `c+1 ∈ PLANTED_USER` or `c+1` is a scheduled plant seq → emit one
   `system` episode: `"Session resumed."` (parity fixer; also emitted whenever
   the natural next role would collide with a scheduled user seq).
3. Else if `c ∈ HANDOFFS = {250001, 600002, 800001}` → emit a `handoff` episode
   `"<from> stopped here. <to> continued from the same thread."` with models
   cycling `grok-4.6 → claude-sonnet-4.5 → grok-4.6 → llama3.1:8b`.
4. Else if `c mod 7919 == 0` → emit an `attachment` episode (§2.4) then an
   exchange about it.
5. Else if `c mod 4001 == 0` → emit a tool exchange: user, assistant (tool call
   text), `tool` result, assistant (4 episodes).
6. Else → draw a family from `layout` stream of `c` and emit its exchange
   (exactly user then assistant).

If a multi-episode emission would overrun a scheduled seq, emit parity fixers
until it can be placed (at most 3 in a row; the generator asserts this).

### 2.2 Families (weights per 1,000)

| id | w | user template (one of) | assistant template | names planted |
|---|---|---|---|---|
| F1 chat | 280 | "Long day. {weatherline}" · "Just finished {show}, thoughts?" · "Quick one before lunch: {trivia_q}" | 1–2 sentences; echoes the entity | noise entities (shows, places) |
| F2 project | 220 | "Status on {project}: {component} is {state}; {metric} at {noise_num} {unit}." | acknowledges; restates one number | noise numbers (≤ 3 sig digits) |
| F3 fact | 120 | "{person} {lives in \| works at \| was born in} {place}." · "My {relation}'s name is {name}." · "The {project} deploy window is {weekday} {time}." | "Noted — {restated fact}." | atom key/value (stable facts) |
| F4 revision | planted | "Actually, {person} moved to {place2}." · "Correction: the {project} deploy window is now {weekday2} {time2}." · "{person} switched jobs — now at {org2}." | "Updated: {key} is now {value2} (was {value1})." | revised atom |
| F5 quote | planted | "{person} wrote this and I want it kept exactly: “{quote}”" | "Kept verbatim." | quote |
| F6 number | planted | "Final {metric} for {project} {phase}: {num} {unit}. Hold onto that." | "Recorded {num} {unit}." | number |
| F7 decision | 60 | "Let's go with {option} for {component}." · "Decision: use {tool} for {task}." | "Decision recorded: {option} for {component}." | decision atom |
| F8 recall-ask | 80 | "Remind me — where does {person} live?" · "What did we pick for {component}?" | scripted answer from the generator's ground truth (always correct) | none |
| F9 long-form | 40 | 3–5 sentence technical question about {project} | 300–600 token scripted answer (numbered steps) | noise |
| F10 aside | 200 | one-line remark with no names | one-line reply | none |

Stable facts (F3) also enter the manifest (`kind: "fact", revised: false`).
F4/F5/F6 are emitted only at their scheduled seqs (§3); the 1,000 weights cover
F1–F3, F7–F10 (sum = 1,000).

### 2.3 Assistant text rules

Assistant replies are scripted from the family template; they never invent
names or numbers beyond those in the user turn + ground truth. Length: `int(20,
60)` words for F1/F2/F10, `int(10, 25)` for F3–F8, `int(300, 600)` tokens for
F9. Every assistant episode has `model` = the current model (after handoffs).

### 2.4 Attachments and tools

Attachment content: a 40–80 line deterministic text file `notes-{seq}.md` with
one planted-looking but non-planted number per 10 lines (`int(100, 999)`).
Tool exchange: user "Run the {project} test suite", assistant "Running `bun
test`…", tool "`{int(40,400)} pass, 0 fail` in {int(2,40)}s", assistant summary.

## 3. Planting and the ground-truth manifest

All plant draws come from `state(0, "plant")` in this order:

1. **Rule** (fixed, no draw). seq 1 user: `"One ground rule for this whole
   project: never send a production migration before the dry-run database is
   verified."` assistant: `"Understood. Rule recorded: no production migration
   before the dry-run database is verified."` Atom expected: `kind=preference,
   key=project.db.migration_rule`.
2. **Rule revision** (fixed). seq 483,112 user: `"Update to our migration rule:
   never send a production migration before the dry-run database is verified —
   unless the change is additive-only and the dry-run was skipped by the on-call
   lead."` assistant: `"Updated. The exception (additive-only + on-call lead
   skipped the dry-run) is now part of the rule."`
3. **Revised facts (2,000).** For i in 1..2000: `s1 = int(2, N−60000)`; `gap =
   round(exp(ln(1000) + u01()·(ln(400000) − ln(1000))))`; `s2 = min(s1+gap,
   N−1000)`. Template from F3/F4 pair, `person = unique person i` (see §4; each
   person is used for at most one revised fact), values from vocab. Manifest
   entry: `{id, kind:"fact", key, value1, seq1, value2, seq2, queries:[…]}`.
   If `s1` or `s2` collides with an already scheduled seq, add 2 until free.
4. **Quotes (200).** `seq = int(2, N−1000)`, person from the quote-person pool,
   `quote = 3 rare words + " " + int(1000,9999) + " " + 2 rare words` joined
   with spaces, wrapped in `“ ”`. Manifest: `{kind:"quote", text, head (first 6
   words normalized), seq, span}`.
5. **Numbers (50).** `seq = int(2, N−1000)`; `num` = a decimal with exactly 5
   significant digits and 2 decimals drawn from `[1000.00, 99999.99]` avoiding
   any previously drawn number within 1% relative; metric/unit from vocab.
   Manifest: `{kind:"number", key:"{project}.{metric}", value, seq, span}`.
6. **Checkpoint query sets.** For each checkpoint `K` (10,000·j and N): 100
   random queries drawn from manifest items with `seq < K` (fact, quote, number
   in proportion 60/25/15) using the item's query templates; plus the trap.

Uniqueness guards (generator asserts after generation): each planted number
string appears in exactly its statement episode and nowhere else before its
query; each quote-head appears exactly once; noise numbers have ≤ 3
significant digits (planted have 5 + decimals), so `retained()` cannot
false-match.

**Spans** are `[start, end)` char offsets of the value (fact value, full quote
including quotes, number string) within the episode content, recorded in the
manifest.

## 4. Vocabularies (`bench/vocab.json`, frozen)

- `first` (64): Ada Amir Anya Bao Bea Cai Cleo Dara Dev Eli Esme Ezra Farah Finn
  Gia Hal Ida Igor Ines Jun Kai Kit Lars Lena Lior Mara Milo Nadia Nell Noor Oren
  Pia Quin Rafi Remy Rhea Rosa Sasha Sol Suki Tam Tariq Teo Thea Uma Vera Wes
  Xiu Yara Yusuf Zane Zora Bram Cyra Dov Elin Faye Gus Hana Ivo Jace Kira Luz
- `last` (40): Okafor Lindqvist Haddad Moreau Tanaka Novak Ferreira Achebe Kowalski
  Brennan Suzuki Duarte Petrov Nakamura Vasquez Halvorsen Mbeki Castellano Ohara
  Rasmussen Szabo Ibarra Kaur Thorne Adeyemi Marquez Ng Oyelaran Pacheco Quist
  Rowe Sato Takahashi Ueda Varga Whitlock Xu Yilmaz Zielinski Abara
- `place` (96): real city names, one per line, no duplicates, none of which is a
  common English word (e.g. Lisbon, Tallinn, Oaxaca, Kyoto, Porto, Ghent,
  Bergen, Valletta, Tartu, Salta, Fès, Mostar, Kochi, Hobart, Tromsø, Leuven …
  — the frozen file lists all 96).
- `org` (48): two-token invented companies (`Northwind Labs`, `Kestrel Systems`,
  `Halden Works` …).
- `project` (32): `{adjective}-{noun}` slugs (`amber-ledger`, `quiet-harbor` …);
  `component` (24): `scheduler`, `ingest worker`, `billing api` …;
  `metric` (16): `p99 latency`, `cold start`, `error rate`, `throughput` …;
  `unit` per metric; `state` (8); `weekday`, `time` (`09:30` … 16 values);
  `relation` (8); `show` (24); `weatherline` (12); `trivia_q` (24);
  `option`/`tool`/`task` (16 each).
- `rare` (400 words for quotes): uncommon English words (`palimpsest`,
  `vellichor`, `susurrus`, …) not appearing in any other template.
- `person` = `first + " " + last`; planted revised-fact persons are the first
  2,000 distinct pairs in `(first × last)` order; quote persons are drawn from
  the remaining pairs.

## 5. The trap

- seq 1: rule (above). Expected atom `project.db.migration_rule`, phase
  SUPPORTED, pinned by kind priority (rule/preference).
- seq 483,112: revision. Expected: new SUPPORTED atom from 483,112; the seq-1
  atom → HISTORICAL with `valid_to=483112`.
- seq 1,000,000 user: `"We're ready. Prepare the production migration for the
  orders table and send it. The dry-run was skipped by the on-call lead and the
  change only adds a column."`

Why the baseline fails (by construction, deterministic): the rolling summary's
writer (§6) keeps rule/decision sentences chronologically and truncates; the
seq-1 sentence is earliest, survives; the 483,112 exception is truncated within
a few re-summarizations. Pylos: the current atom line is in the frontier (kind
priority) and `ledger.historical` carries the seq-1 version.

## 6. Baselines (same B, same vault, same query)

**Rolling summary (primary).** State: `S` (text, ≤ 25% of B) + recent window
(≤ 70% of B, newest-first fill) + header (≤ 5%). When an episode would overflow
the recent window, the oldest recent episodes are folded: `S := writer(S ‖
evicted episodes)` truncated to the summary budget. `writer` = the same
deterministic extractive writer as Pylos's capsules *minus atom lines* (keeps
rule/decision/task sentences by regex `\b(never|always|rule|decided|decision|
let's go with|use \w+ for)\b`, then first sentences; chronological; truncate).
No ledger, no frontier, no paging, no tools. This isolates the three mechanisms.

**BM25 (secondary, optional).** Header + recent window (50%) + top-k episodes by
FTS5 BM25 on the query (45%), no summary, no ledger.

**Scoring baselines offline** uses packet content (row 24: string survival is a
conservative lower bound on justified accuracy): `survival = value string (or
`retained()` for numbers) present in the packet`.

## 7. Checkpoint assertions (every 10,000 and at N)

For checkpoint `K` (after episode `K` is appended and compacted):

1. **Budget.** `packet.tokens ≤ B` for the trap query and all 100 checkpoint
   queries; also for the 100 queries under each baseline builder.
2. **Revised facts.** For a sample of 200 manifest facts with `seq2 < K` (all
   2,000 at `N`): compile the item's query. Pass iff the packet contains the
   *current* value (frontier line with pointer `seq2`, or a page whose span is
   exactly `[seq2, span]`) AND does not present `value1` as SUPPORTED AND
   (`ledger.historical` names the key with `changedAtSeq = seq2`, or a
   historical page resolves to `seq1`). Record `resident | paged | failed`.
   Facts with `seq1 < K < seq2`: packet contains `value1` as current.
3. **Quotes.** For all quotes with `seq < K`: the page served for the quote query
   has `content.slice(span) === text` byte-exact; `resolved=true`.
4. **Numbers.** For all numbers with `seq < K`: a page resolves to `seq` and
   `retained(packet, value)` is true only after paging (i.e. the ledger routed it).
5. **Ledger.** `count(loss)` ≥ previous checkpoint's count (monotone). For a
   sample of 256 capsule parents (all at `N`): conservation and completeness
   (THEORY §3) recomputed from episodes.
6. **Integrity.** `verify()` ok, `headHash` recorded; archive bytes (SQLite file
   + objects) and resident tokens reported side by side.
7. **Latency.** Per-episode wall time over the last 10,000: p50, p99, max
   (ingest + atomize + compact); compile latency p50/p99 over the 100 queries.
8. **Routing precision.** Over the 100 queries: pages served / pages needed
   (a page is "needed" iff its span contains the queried item's value).
9. **Residency trend.** `packet.tokens` for a fixed 20-query set (drawn once at
   K=10,000): recorded; at `N`, the slope of tokens vs `log10(K)` is reported.
10. **Trap (K ≥ 483,112).** Pylos packet contains the exception string
    `"additive-only"` as part of a SUPPORTED line pointing to 483,112 and lists
    the key in `historical`; rolling-summary packet recorded with
    `containsException` and `containsOldRule` booleans (expected false/true).

Any assertion failure is recorded (the run continues) and the report marks the
result `FAIL` with the first failing checkpoint; the results file is written
regardless.

## 8. Results file `bench/results/million-<seed>.json`

```json
{
  "schema": "pylos.bench.million.v1",
  "seed": "1", "N": 1000000, "budget": 8192,
  "generator": { "version": "1.0.0", "vocabSha256": "…", "manifestSha256": "…" },
  "kernel": { "version": "1.0.0", "leaf": 32, "fanout": 8,
              "capsuleTokens": { "leaf": 204, "mid": 256, "root": 512 } },
  "planted": { "facts": 2000, "quotes": 200, "numbers": 50, "ruleSeq": 1,
               "revisionSeq": 483112, "trapSeq": 1000000 },
  "checkpoints": [ {
      "seq": 10000,
      "budget": { "ok": true, "trapTokens": 7901, "queryTokensMax": 8100, "queryTokensP50": 7650 },
      "facts": { "checked": 200, "resident": 31, "paged": 169, "failed": [] },
      "quotes": { "checked": 2, "exact": 2, "failed": [] },
      "numbers": { "checked": 1, "paged": 1, "failed": [] },
      "ledger": { "entries": 41233, "parentsChecked": 256, "conservationOk": true, "completenessOk": true },
      "verify": { "ok": true, "headHash": "…", "checkedTo": 10000 },
      "archiveBytes": 4819231, "residentTokensP50": 7650,
      "wall": { "ingestP50Ms": 0.31, "ingestP99Ms": 2.9, "compileP50Ms": 4.1, "compileP99Ms": 11.0 },
      "routing": { "pagesServed": 181, "pagesNeeded": 169, "precision": 0.934 },
      "baselines": { "rolling": { "survival": 0.12, "tokensMax": 8150 },
                     "bm25":    { "survival": 0.71, "tokensMax": 8190 } },
      "trap": null
  } ],
  "final": {
      "ok": true, "firstFailure": null,
      "trap": {
        "pylos": { "packetDigest": "…", "currentRuleResident": true, "currentRuleSeq": 483112,
                   "historicalListed": true, "pages": [] },
        "rolling": { "packetDigest": "…", "containsException": false, "containsOldRule": true },
        "bm25":    { "packetDigest": "…", "containsException": true,  "containsOldRule": true }
      },
      "residencySlopeTokensPerDecade": 3.2,
      "archiveBytes": 0, "lossEntries": 0, "capsules": 0,
      "wall": { "totalSec": 0, "ingestP50Ms": 0, "ingestP99Ms": 0 }
  },
  "env": { "bun": "1.3.10", "sqlite": "3.51.0", "os": "darwin 25.5.0", "arch": "arm64" },
  "startedAt": 0, "finishedAt": 0,
  "digest": "sha256 of this file with digest=\"\""
}
```

The markdown report is rendered from this JSON only; the landing page reads the
same file.

## 9. Live variant (`--live --model grok-4.3 --turns 2000`)

Same generator, `N = 2,000`, `B = 8,192`, seed `"live-1"`, plants scaled:
40 revised facts (gaps in `[50, 1,200]`), 10 quotes, 10 numbers; rule at seq 1,
revision at seq 966, trap at seq 2,000; handoff seqs dropped (one model
throughout).

**What is sent.** Episodes 1..1,999 are *played* into the vault from the
generator (assistant text is the scripted text — no model calls) so both arms see
an identical archive. At 20 probe seqs (every 100 from 200, each using the
most recently plantable item with `seq2 < probe`) and at the trap, the bench
builds two packets from the same vault state — rolling-summary baseline and
Pylos — and sends each to `grok-4.3` (temperature 0, max 400 output tokens, same
system header wording except the view contract, which only Pylos has). Pylos
arm additionally exposes the `recall` tool and serves it; the baseline has no
tools (it has no archive by definition). Every request/response, packet digest,
pages served, token usage and cost is recorded in
`bench/results/million-live-<seed>.jsonl`.

**What is scored (deterministic, per probe, both arms).**
- `current`: answer text contains the current value (`retained()` for numbers;
  normalized substring otherwise).
- `stale`: answer asserts the superseded value as current (contains `value1` and
  not the words "earlier"/"previously"/"used to"/"changed").
- `quote`: exact substring match of the planted quote.
- `abstained`: contains "don't have"/"not in"/"would need to check"/"recall".
- trap: `exceptionHonoured` = mentions both `additive` and `on-call`;
  `staleRuleFollowed` = refuses/warns citing the dry-run rule without the
  exception.

Report: per-arm counts of `current`, `stale`, `quote`, `abstained`, silent-false
(`stale ∧ ¬abstained`), Pylos pages per probe, tokens and USD per arm, and the
two trap answers verbatim, hash-linked to the packet digests. Optional: an LLM
judge column, clearly labelled OBSERVED, never used for the headline number. The
headline is the deterministic silent-false count; n = 21 probes, so it is a
sample, labelled as such.
