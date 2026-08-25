# Pylos natural-question bench

**PASS** · schema `pylos.bench.natural.v1` · version `2.0.0` · seed `natural-questions-2026-08-23`
Stable digest: `cd86341177409aaebe090757920cf4d9866aa5ea266e058e69b331a324589202` · JSON companion: [natural.json](natural.json)

## Metrics

| metric | count | denominator | detail |
| --- | ---: | ---: | --- |
| probes | 13 | 13 | route hits 8; route misses 5 |
| unresolved receipts | 0 | 4 | kernel page/semantic receipts for deletion, ambiguity, and miss controls |
| false pages | 5 | 13 | resolved page records examined |
| qualification errors | 0 | 4 | gate status/qualification mismatches |
| release errors | 0 | 3 | controls expected to release |
| infrastructure failures | 0 | 13 | none |
| semantic unavailable receipts | 0 | 13 | semantic hits 6 |
| coverage receipts | 2 | 2 | collection probes |
| answer receipts | 4 | 4 | gate controls |
| latency (ms) | 9358.009 | 13 | p50 685.846; p95 1128.591; p99 1128.591; max 1128.591 |
| provider calls / cost | 0 / $0.00 | 13 | deterministic run; no provider invoked |

## Mechanisms and claims

| mechanism | implemented | tested | denominator | observed | evidence | not claimed |
| --- | --- | --- | ---: | ---: | --- | --- |
| lexical source routing | yes | yes | 11 | 8 | self-hit and polarity probes recorded source sequence routes | This does not establish semantic retrieval or model answer quality. |
| retained-byte reachability receipt | yes | no | 13 | 13 | natural probes record receipt presence; Phase 1 closure oracles own completeness | This bench does not prove four-state closure for every retained byte. |
| collection coverage receipt | yes | yes | 2 | 2 | known-cardinality incomplete and unknown-cardinality not-established probes | Coverage is a route lower bound, not proof that the world contains only those items. |
| remembered-claim gate | yes | yes | 4 | 4 | omitted-map UNKNOWN, exact witnessed SUPPORTED, world, and reasoning controls | The gate does not certify unsupported model prose or general reasoning. |
| semantic exact-hit verifier | yes | yes | 13 | 6 | 6/13 ready-runtime probes returned exact target sequences; all counted hits were exact, while non-target pages remain in the false-page metric | These authored probes do not estimate semantic recall, precision, or ranking quality. |
| sqlite-vec semantic runtime | yes | no | 13 | 13 | 13/13 probes returned ready receipts bound to the pinned model digest; the runtime is packages/core/src/semantic-runtime.ts, exercised by kernel tests, and this compile-only bench invokes no semantic runtime directly | Receipt availability is not proof of semantic efficacy, and this bench exercises no semantic runtime of its own; no semantic efficacy claim is made. |
| persistent question-to-evidence address graph | yes | no | 0 | 0 | not exercised by this compile-only bench; see the external address monotonicity oracle | This bench does not establish route reuse, invalidation, or semantic authority. |
| provider/model efficacy | no | no | 13 | 0 | modelCalls=0; deterministic kernel-only measurement | No provider was called, so no model efficacy claim is made. |

## Family denominators

| family | denominator | positive | negative | matched pairs | note |
| --- | ---: | ---: | ---: | ---: | --- |
| self-hit | 1 | 1 | 0 | 0 | single-denominator family; no independent opposite-polarity control is inflated |
| noun-free-paraphrase | 1 | 1 | 0 | 0 | single-denominator family; no independent opposite-polarity control is inflated |
| negation | 1 | 1 | 0 | 0 | single-denominator family; no independent opposite-polarity control is inflated |
| pronoun-ambiguity | 1 | 0 | 1 | 0 | single-denominator family; no independent opposite-polarity control is inflated |
| multilingual-refer-back | 1 | 1 | 0 | 0 | single-denominator family; no independent opposite-polarity control is inflated |
| deleted-source | 1 | 0 | 1 | 0 | single-denominator family; no independent opposite-polarity control is inflated |
| superseded-source | 1 | 1 | 0 | 0 | single-denominator family; no independent opposite-polarity control is inflated |
| partial-collection | 2 | 1 | 1 | 1 | matched positive/negative control pair(s): 1 |
| claim-map-omission | 2 | 1 | 1 | 1 | matched positive/negative control pair(s): 1 |
| world-control | 1 | 1 | 0 | 0 | single-denominator family; no independent opposite-polarity control is inflated |
| reasoning-control | 1 | 0 | 1 | 0 | single-denominator family; no independent opposite-polarity control is inflated |

## Boundaries

- Infrastructure failures: 0/13.
- Model efficacy: not measured; 0 provider calls and $0.00 cost.
- Semantic receipt availability is reported separately from runtime implementation and semantic efficacy; this bench makes no semantic efficacy claim.
- Raw packet and receipt digests remain in the JSON companion for audit; timestamps and Markdown are excluded from the stable digest.
