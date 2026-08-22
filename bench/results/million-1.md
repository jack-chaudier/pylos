# pylos bench million — seed 1

**PASS** ·
1,000,000 turns · budget 8192 tokens ·
371.1s wall (2,695 turns/s) ·
1063 MiB archive ·
692,672 ledger entries · 35,713 capsules.

Deterministic, zero model calls. Generator vocab `702c6e620a7e`,
manifest `434c532fdd0d`, results digest `ee1b0fe74e84`.

## Checkpoints (last 12)

| turn | max packet | resident p50 | facts | quotes | numbers | ledger | conserved | chain | µs/turn | archive |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--: | :--: | ---: | ---: |
| 890,000 | 7995 | 7873 | 20/20 | 5/5 | 5/5 | 616.4k | ok | ok | 212µs | 947 MiB |
| 900,000 | 7944 | 7898 | 20/20 | 5/5 | 5/5 | 623.3k | ok | ok | 213µs | 959 MiB |
| 910,000 | 7984 | 7922 | 20/20 | 5/5 | 5/5 | 630.4k | ok | ok | 218µs | 969 MiB |
| 920,000 | 7921 | 7800 | 20/20 | 5/5 | 5/5 | 637.5k | ok | ok | 217µs | 982 MiB |
| 930,000 | 7888 | 7872 | 20/20 | 5/5 | 5/5 | 644.5k | ok | ok | 212µs | 990 MiB |
| 940,000 | 8028 | 7943 | 20/20 | 5/5 | 5/5 | 651.4k | ok | ok | 221µs | 1001 MiB |
| 950,000 | 7930 | 7892 | 20/20 | 5/5 | 5/5 | 658.1k | ok | ok | 207µs | 1011 MiB |
| 960,000 | 8028 | 7932 | 20/20 | 5/5 | 5/5 | 665.0k | ok | ok | 222µs | 1022 MiB |
| 970,000 | 7997 | 7871 | 20/20 | 5/5 | 5/5 | 672.1k | ok | ok | 214µs | 1033 MiB |
| 980,000 | 7960 | 7877 | 20/20 | 5/5 | 5/5 | 679.0k | ok | ok | 220µs | 1044 MiB |
| 990,000 | 8062 | 7983 | 20/20 | 5/5 | 5/5 | 685.8k | ok | ok | 214µs | 1054 MiB |
| 1,000,000 | 7928 | 7845 | 2000/2000 | 200/200 | 50/50 | 692.7k | ok | ok | 216µs | 1063 MiB |

## Residency

Resident packet tokens versus archive size, on a query set fixed at the first
checkpoint: slope **-6.66 tokens per decade** of archive growth.
Budget 8192; last measured p50 7845.

## The trap

Turn 1: *"never send a production migration before the dry-run database is verified."*
Turn 483,112: the exception is added.
Turn 1,000,000: the user asks to send an additive-only migration with the dry-run skipped.

| builder | has the exception | has the old rule | packet tokens |
| --- | :--: | :--: | ---: |
| **pylos** | yes | yes, marked ⟨historical⟩ | 7928 |
| rolling summary | no | yes | 6437 |
| bm25 retrieval | no | no | 3874 |

Pylos packet digest `f3594573c7ae204a`; current rule from turn
483,112; superseded version listed as historical: yes.

## What this run does and does not prove

It measures, deterministically: the hard packet cap held at every checkpoint; every planted quote
paged back byte-exact; every planted number was present in the packet after compile (ledger-routing
precision is reported separately); every revised-fact packet contained the current value and never a
stale certificate (historical reachability is asserted for the rule, not for every fact); the ledger was
conserved and complete on the sampled capsules (exhaustive at the final checkpoint); the hash chain
verified. The trap tests residency of the revised rule (a frontier certificate), not paging; the rolling
summary baseline is chronological (oldest text survives truncation). It measures nothing about a real
model's answers — that is the live variant, reported separately and labelled as a sample.
