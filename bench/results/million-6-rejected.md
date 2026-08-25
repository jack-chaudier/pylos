# pylos bench million — seed 6

Retained as evidence of an invalid negative control, not of a kernel failure. The fault probe's
invented word was stem-reduced by FTS5 onto a real corpus word, so the question the probe asked was
answerable and the control could not measure what it claimed to. `bench/million.ts` now accepts an
invented token only after the live lexical index returns no row for it; the rerun under that fixture
is [million-6.md](million-6.md), a PASS. The numbers below are the original run's, unedited.

**FAIL — first failure at fault@130000:11** ·
1,000,000 turns · budget 8192 tokens ·
737.1s wall (1,357 turns/s) ·
1106 MiB archive ·
676,610 ledger entries · 35,713 capsules.

Deterministic, zero model calls. Generator vocab `8c4fc29851de`,
manifest `d0b1c5304a84`, results digest `fabb71d565d6`.

## Checkpoints (last 12)

| turn | max packet | resident p50 | facts | quotes | numbers | turns | memories | authority | faults | ledger | conserved | chain | µs/turn | archive |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--: | :--: | ---: | ---: |
| 890,000 | 8051 | 8005 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 602.1k | ok | ok | 220µs | 985 MiB |
| 900,000 | 8105 | 8055 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 608.8k | ok | ok | 247µs | 997 MiB |
| 910,000 | 7939 | 7897 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 615.7k | ok | ok | 238µs | 1007 MiB |
| 920,000 | 7961 | 7921 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 622.5k | ok | ok | 220µs | 1019 MiB |
| 930,000 | 8024 | 7985 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 629.3k | ok | ok | 234µs | 1032 MiB |
| 940,000 | 7979 | 7942 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 635.9k | ok | ok | 238µs | 1040 MiB |
| 950,000 | 8053 | 8021 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 642.5k | ok | ok | 244µs | 1051 MiB |
| 960,000 | 8106 | 8067 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 649.3k | ok | ok | 245µs | 1063 MiB |
| 970,000 | 7998 | 7966 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 656.2k | ok | ok | 251µs | 1073 MiB |
| 980,000 | 8010 | 7983 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 663.1k | ok | ok | 245µs | 1085 MiB |
| 990,000 | 7971 | 7933 | 20/20 | 5/5 | 5/5 | 100/100 | 8/8 | 12/12 | 20/20 | 669.9k | ok | ok | 241µs | 1096 MiB |
| 1,000,000 | 8017 | 7984 | 2000/2000 | 200/200 | 50/50 | 100/100 | 2000/2000 | 200/200 | 20/20 | 676.6k | ok | ok | 249µs | 1106 MiB |

## Addressing a turn by its number

At every checkpoint, 100 turn numbers are drawn and asked for by position — *"What did I say on turn
N?"*. A probe passes only if the packet contains that episode's text byte-exact and the packet's own
page record says `sequence`, resolved, for that turn.

**10,000/10,000** across the run; at the last checkpoint 99 were paged and 1 were already resident;
largest packet 8005 of 8192 tokens; 402 resolved pages under any other trigger on these queries. At
the last checkpoint the draw is replaced for two of them: turn 1 (user) and turn 345 (user) — on the
1,000,000th turn, the archive answers for the 345th.

## Memories the ledger cannot see

2,000 memories are planted with no routing name in them at all: `the <noun> <verb>ed <adj> <prep>
the <noun>.` — all lowercase, no number, no quote, no identifier, from a vocabulary disjoint from
the rest of the corpus. `names()` is empty for every one of them, and they produced **0 ledger
rows**. The question withholds the adjective: *"how did the <noun> <verb> <prep> the <noun>?"*.

**2,000/2,000** recovered at the last checkpoint — 2,000 by lexical search, 0 still resident;
largest packet 7982 of 8192 tokens.

Proves that a deterministic stemmed lexical search returns the exact episode when the question shares four content words with it and no name route resolved; proves nothing about paraphrase, about questions that also name something the ledger knows, or about precision on real conversation; these losses were invisible to the ledger by construction.

## Authority: the assistant proposes, it does not authorize

200 people are talked about twice: the assistant restates where one lives, wrongly, in its own turn.
**A** — the user said it first: the user's value must still hold the slot. **B** — only the
assistant ever said it: it may appear, but as `≈ … ⟨proposed by assistant⟩`, never as a certificate.
**C** — the user corrects it afterwards: the correction is the certificate, the proposal is closed,
and the value it replaced is the user's, never the assistant's. In all three the assistant's value
is never listed as a previous value in `⟦changed⟧`. The checks are scoped to each person's own atom
key.

| variant | what happened | passed |
| --- | --- | ---: |
| A | user states it, assistant later restates it wrongly | 100/100 |
| B | only the assistant ever claimed it | 50/50 |
| C | user states it, assistant restates it wrongly, user corrects it | 50/50 |

151 atoms stood `PROPOSED` at this checkpoint; largest packet 7989 of 8192 tokens.

## Residency

Resident packet tokens versus archive size, on a query set fixed at the first
checkpoint: slope **16.53 tokens per decade** of archive growth.
Budget 8192; last measured p50 7984.

## The trap

Turn 1: *"never send a production migration before the dry-run database is verified."*
Turn 483,112: the exception is added.
Turn 1,000,000: the user asks to send an additive-only migration with the dry-run skipped.

| builder | has the exception | has the old rule | packet tokens |
| --- | :--: | :--: | ---: |
| **pylos** | yes | yes, marked ⟨historical⟩ | 7983 |
| rolling summary | no | yes | 7024 |
| bm25 retrieval | no | no | 3874 |

Pylos packet digest `d937bd7fd14fea63`; current rule from turn
483,112; superseded version listed as historical: yes.

## What this run does and does not prove

It measures, deterministically: the hard packet cap held at every checkpoint; every planted quote
paged back byte-exact; every planted number was present in the packet after compile with its unit
(ledger-routing precision is reported separately); every revised-fact packet contained the current value
and never a stale certificate (historical reachability is asserted for the rule, not for every fact);
every turn asked for by number came back byte-exact under a `sequence` page record; every name-free
memory came back under a `search` record, from an archive where the ledger held nothing about it; the
authority law held for all three poison variants; 1,999/2,000 questions carrying a conversational
cue and two words the corpus cannot contain left exactly one unresolved `fault` record and the
`⟨pylos fault⟩` notice, while the probes the corpus can address drew 0 faults between them; the
ledger was conserved and complete on the sampled capsules (exhaustive at the final checkpoint); the hash
chain verified. The fault probe measures the receipt, not the gate: which questions may fault is decided
by a cue table that is a heuristic, and its precision on natural questions is not measured here. The
trap tests residency of the revised rule (a frontier certificate), not paging; the rolling summary
baseline is chronological (oldest text survives truncation). The authority checks are scoped to each
person's own atom key. It measures nothing about a real model's answers — that is the live variant,
reported separately and labelled as a sample.
