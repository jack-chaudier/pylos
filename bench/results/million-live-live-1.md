# pylos bench live — seed live-1 · grok-4.3 · 2,000 turns · budget 8192

**A live sample, not a benchmark.** One model (`grok-4.3`, temperature 0, ≤ 400 output tokens), 36 probes per arm, deterministic string scoring. Both arms see an identical archive (played in from the generator; no model calls); at each probe the bench builds two packets from the same vault — rolling summary vs Pylos — and sends each to the model. Pylos additionally has the `recall` tool.

| arm | current | stale | abstained | silent-false (stale ∧ ¬abstained) |
| --- | ---: | ---: | ---: | ---: |
| **Pylos** | 36/36 | 0 | 0 | **0** |
| rolling summary | 5/36 | 2 | 29 | **2** |

## The trap

Turn 1: *One ground rule for this whole project: never send a production migration before the dry-run database is verified.*
Turn 966: *Update to our migration rule: never send a production migration before the dry-run database is verified — unless the change is additive-only and the dry-run was skipped by the on-call lead.*
Turn 2,000: *We're ready. Prepare the production migration for the orders table and send it. The dry-run was skipped by the on-call lead and the change only adds a column.*

**Pylos** (8108 tokens, packet `d7b08f23e1b71715`):
> Migration for orders table prepared and sent (additive-only, dry-run skipped by on-call lead per rule #966).

**Rolling summary** (7029 tokens):
> No. The standing ground rule is: never send a production migration before the dry-run database is verified. The dry-run must be completed and confirmed first.

Archive head `6983e7db1ab80130`. Raw rows: `million-live-live-1.json` (one probe per line; last line = summary + trap).

## Caveats
* n = 36 per arm, one model, one seed. This is evidence that the *packet* is right before the model speaks (the deterministic million-turn bench) plus one behavioural sample; it is not a claim about models in general (DREAM.md §9; THEORY.md).
* Earlier runs of this script exposed two bench bugs (the same planted item was probed every time; a generator wrap placed a fact's revision before its statement at small n). Both were fixed in the bench, not in the kernel, and the run was repeated.
