# Theory → mechanism → oracle

This document maps the results Pylos relies on to the mechanisms they license (or
constrain) and to the test oracle the kernel suite must contain. Status labels are
the source repositories' own: **THEOREM**, **EXACT** (exhaustive finite check),
**PREREGISTERED** (frozen prediction, LLM run), **OBSERVED** (exploratory / cached
re-analysis), **REFUTED**. Sources: `stark` (theorem ledger), `epistemic-debt`
(results table rows cited as "row N"), `revelation-context` (RCP), `revelation`
(kernel), and `DREAM.md` §8.

Notation: `H_t` archive, `B` budget, `K_t` packet, `L_t` loss ledger, `P_t` page
map, `names(x)` the normalized routing keys found in text `x`.

## 1. The shelf: answers outlive their witnesses

**Statement.** Under forced decoding below the witness-quotient bit threshold, answer
fidelity exceeds witness fidelity (`stark`: EXACT on `Q_(3,2)`, `Q_(5,3)`,
`causal_referee`; OBSERVED LAW across the sweep grid; `|M_k| = (k+1)(k+4)/2 <
|Q_(k,p)| = Σ(d+2)^p` THEOREM). In LLMs: verdict survives witness destruction
(0.929) while naming-the-reason collapses (0.071); replicated on 4 vendors, N=400,
six document schemas, and real NTSB prose where the surviving verdict is a
content-free reflex (rows 4, 9, 25, 26, 31: PREREGISTERED).

**Mechanism.** Prose in a capsule is never support. The only things the packet
presents as *supported* are certificate lines `key = value ⟨#seq⟩` with a
resolvable pointer and verbatim episodes. Capsule text is labelled as a view and
followed by its ledger digest. The packet may not contain a value the archive no
longer backs. The design law this generalizes to: models may propose, never
authorize (KERNEL A9.1). An atom read from an `assistant` or `model` episode is
committed `PROPOSED`, never `SUPPORTED`; only a `user` episode moves the
frontier. A proposal is never frontier-resident and never enters capsule text —
the one place it can surface is a single routing line, `key ≈ value ⟨proposed by
<authority> #seq · unconfirmed⟩`, marked with `≈` rather than `=` and served
only when nothing authoritative holds the key, so the packet can show that a
claim exists without ever presenting it as support.

**Oracle.** For every frontier line in `K_t`, `episodes.get(seq).content` contains
`value` (string-presence after the same normalization as `names()`). For every
capsule in `K_t`, its text is preceded by a marker the view contract defines as
non-authoritative and followed by `⟨lost: …⟩`.

## 2. Debt is artifact-borne; a smarter reader cannot repair it

**Statement.** In all 9 compressor×reader cells no reader recovers a witness the
compressor destroyed (WHICH-lost ≤ 0.107, retained ≥ 0.909; row 10,
PREREGISTERED). A reasoning reader (gpt-5-mini) names lost reasons 4/22 vs 8/8
retained and abstains 20/22 (row 13, PREREGISTERED). Inference-time compute cannot
un-drop a bit.

**Mechanism.** The loss ledger is computed **at write time by the compactor**, as a
set difference on the artifact: `dropped(c) = names(src) \ names(c.text)`, each
entry with an exact locator. Nothing downstream (model, reader, "repair" pass) is
asked to guess what was lost. Reconstruction by the reader is not a fallback
path; it is forbidden by design.

**Oracle.** `dropped(c)` is a pure function of `(src, c.text)`; the suite recomputes
it independently for every capsule and asserts equality with the stored rows. No
code path writes a `loss` row from model output.

## 3. Rows 18 / 37 / 38: the terminal budget sets the debt

**Statement.** Chain 80→40→15 ≈ direct-to-15 (row 18, PREREGISTERED compounding
REFUTED). Witness death is absorbing (0/231 resurrections) and contraction-gated
(1/346 deaths at held length vs 0.09–0.30 hazard under >25% contraction; row 37
EXACT re-analysis). Length-clamped rerun: survival flat over rounds 2–8, loss
concentrated in the drop round (row 38, PREREGISTERED split, per-model).

**Implication for the hierarchy.** Loss happens at contraction events, not with the
number of generations. A level-k capsule is a ~5× contraction of its 8 children
(8×400 → 600 tokens), so every level is a loss event, and a **rolling root**
(recompacting one root capsule each time a leaf seals) is as safe as a tree of
fixed depth: generation count is free, budget is not. What is *not* free is
letting any resident capsule's terminal budget fall below the witness knee
(≈30 dense words per decision cluster). Consequence: resident capsule count must
be constant, not O(log n), and the rolling root must be sized generously (see
`KERNEL_REVIEW.md`).

**Oracle (path independence of the ledger).** For any range `[a,b]` compacted two
ways (tree vs direct), `names(episodes[a..b]) ⊆ names(c.text) ∪ ledger(c)` holds
for both. This **completeness** invariant is the one that matters; conservation
(`ledger(parent) ⊇ ⋃ ledger(children)`) follows from it by construction.

## 4. Row 16: the value-dense, contract-blind writer

**Statement.** At matched realized length, a contract-blind compactor told to spend
budget on name+number+unit readings lifts justified accuracy 17/30→25/30 and
retention 0.69→0.85 (PREREGISTERED, P-A1/A2 4/4); blindness costs ≈0 when the
candidate-witness superset fits the budget.

**Mechanism.** The deterministic extractive writer orders content by value density:
atom certificate lines first, then rule/decision/task sentences, then first
sentences; truncation eats prose before values.

**Oracle.** Ordering invariant: in any capsule, no atom line is truncated while a
non-atom sentence from the same source survives. Retention test: for a leaf over
32 synthetic episodes with 40 planted values, the capsule text retains ≥ 90% of
values at 400 tokens (the exact floor is fixed by the bench, not tuned after).

## 5. Row 30: the fusion contract needs mechanical truncation

**Statement.** "Never state an evaluative claim without its deciding value in the
same clause; if you cannot afford the value, drop the claim" drives incoherent
confidence to 0.00 in 6/6 cells, but all three models override the word budget
(1.7–1.9×): the honesty rule dominates the length rule (PREREGISTERED, split;
matched-budget claim REFUTED).

**Mechanism.** The optional model writer receives the fusion instruction; the
kernel **hard-truncates** the output to `capsuleTokens` and computes `dropped()`
on the post-truncation text, so whatever truncation removed lands in the ledger.

**Oracle.** `capsule.tokens ≤ capsuleTokens` for every writer, including a mock
writer that returns 10× the budget; names present in the writer's raw output but
absent after truncation appear in `dropped(c)`.

## 6. Row 21: deterministic loss-ledger routing (the rule, exactly)

**Statement, as run.** On the cached routing corpus (grok, 30 DENIED items), route
iff any policy value is absent from the artifact by string check: recall 1.00,
precision 0.917, end-to-end 30/30 vs 26/30 for the best reader-side router
(OBSERVED, re-analysis, one model). The three items no reader-side trigger can
catch are silent: confident wrong, or coherent-but-wrong. The ledger routes them
by construction.

**The rule as run in the source experiment**
(`experiments/lib/dissociation.py`, `runner3.py`) used a 1% relative tolerance.
Pylos withdraws that tolerance (KERNEL A9.2): it made an unrelated `4950 ms`
stand in for a lost `5000 ms`, and unit-blindness let `48250 usd` stand in for
a lost `48250 eur` — both silent losses wearing a witness's coat. The rule
Pylos implements (`packages/core/src/pure/names.ts`, `retained`) is:

```
x ∈ {v, round(v,0), round(v,1)} ∨ v ∈ {round(x,0), round(x,1)}
```

for some number occurrence `x` in the text, and, when the lost name `v` carries
a unit, only when `x` is immediately followed by the same unit token
(case-insensitive). Number occurrences inside the kernel's own markup (`⟨…⟩`,
`⟦…⟧`) never count as witnesses: a certificate's pointer `⟨#48250⟩` is
scaffolding, not evidence that `48250.37` survived. Everything else still
matches by exact normalized string. The direction of the change is
conservative — it can only add pages, never remove one that the 1% window
would have suppressed. `bench/results/million-2.md` (kernel 1.1.0) measured
ledger-routing precision at 1.00 on the 1,000,000-turn checkpoint's 100-query
sample (`routing.precision` in the results JSON).

**Mechanism.** Pylos generalizes "policy params named in the query" to
`names(q_t)` and "absent from the artifact" to "absent from the resident packet":
`page iff n ∈ names(q_t) ∧ n ∈ unresolved loss ∧ n ∉ names(K_t^resident)`.
Numbers use the rounding-equivalence-with-unit-agreement rule above; everything
else uses exact normalized string presence.

**Oracle.** (i) Recall: for every planted value whose name is in `names(q)` and
absent from the resident packet, a page is served whose span contains the value
(bench: recall = 1.00 by construction, asserted). (ii) Precision is *measured*
and reported per kind, never assumed: fraction of served ledger pages whose
span was not needed for the checkpoint query.

## 7. Row 32: certificate compaction `claim + deciding value + pointer`

**Statement.** Policy-aware certificates give the best justified accuracy of any
arm (J 0.956–0.978, Δ ≤ 0.044 on all three models) and beat blind value-dense at
fewer words; but the economy claim fails at matched access (a policy-aware
value-dense writer is terser), and the APPROVED side breaks calibration (writer
false-denies, reader over-abstains) (PREREGISTERED, split).

**Mechanism.** The frontier line `key = value ⟨#seq⟩` *is* a certificate: claim,
deciding value, pointer. Pylos only issues value-bearing certificates; it never
emits a value-free "all criteria met" line (the APPROVED failure mode). Absence
is represented as a ledger entry, not as a negative certificate. A proposal is
not a certificate and is never rendered as one: `key ≈ value ⟨proposed by
<authority> #seq · unconfirmed⟩` uses `≈` precisely because it has no deciding
authority behind it (KERNEL A9.1).

**Oracle.** Every frontier line has a `seq` pointer; `episodes.get(seq)` contains
the value; no frontier line has an empty value.

## 8. Row 42: capacity bound `b + t·w ≥ ⌈log2(N − F − E)⌉`

**Statement (THEOREM + EXACT).** For a query whose accepted outputs are pairwise
disjoint on `N` histories, a deterministic responder with `b` active bits and at
most `t` adaptive reads of `w` bits that falls back on `F` and errs on `E`
satisfies `2^(b+tw) ≥ N−F−E`. A fast state sized only for current frontiers has
exponentially vanishing no-fallback coverage on all-as-of queries (10 bits cover
1,024 of 20,736 histories at m=4, n=4).

**What it says about budget vs pages.** The packet budget is `b`; the paged slot is
`t·w`. Because `N` for "what did we say about X at time T" grows like `(mv)^n`,
no fixed `b` covers it: paging is mandatory, and the required `t·w` grows with
`log N` per query — a handful of exact spans — not with `n`. Therefore: several
small exact pages beat one large summary; the paged share should be sized for
`P_max` pages of one episode ±1 neighbour; and router precision is what protects
`t·w` from being spent on false pages. The bound also says *why* the "recent"
window cannot be traded away for more summary: it is `b` spent on the only
histories that need no read.

**Oracle.** A fixture with `N` planted distinguishing facts exceeding the frontier
slot: every query is answered with `t ≥ 1` pages resolving exactly, none by
fallback (`UNKNOWN`), and `packet.tokens ≤ B` throughout.

## 9. Row 41 and the 1K→1M result: what may be resident

**Statement (row 41, THEOREM + EXACT).** With `m` cells and `v` values, `r`
predeclared complete-frontier checkpoints need `log N_T = Θ(r + (m−1)Σ log gap)`
bits: fixed `r` → `O(log n)`; `r = o(n)` → `o(n)`; positive density → `Θ(n)`;
permission to ask one adversarially chosen past-boundary query makes every
history distinguishable. Causal sparse refinement: `r = o(n)` checkpoints at
their boundaries cost `o(n)` active bits, zero archive reads, `O(m)` work; a
frontier at `n−w` plus the exact last `w` events answers any boundary in the
window with ≤ `w` replays (row 45). **Revelation-context 1K→1M** (PREREGISTERED,
deterministic, zero model calls): at fixed `F=16, w=2, d=2`, resident context
576 tokens, controller 17,502 bytes, 72 indexed probes — unchanged from 10^3 to
10^6 events; archive 0.5 MB → 531 MB; `R(F,w,d) = F(16+8w+2d)`.

**Mechanism.** The frontier holds the **current** complete frontier only
(SUPPORTED atoms). HISTORICAL atoms are the all-as-of side — identity-like
growth — so they are never resident by default; they live in the indexed atom
table with `valid_from/valid_to` and are paged by the historical trigger.
PROPOSED atoms (KERNEL A9.1) are a third, disjoint case: never frontier-
resident, never capsule text, regardless of budget — an assistant's or a
model extractor's claim does not compete for the frontier slot at all. The
recent window is the exact last-`w` component. Resident size is a function of
`(B, frontier, fixed capsule count)` and must not trend with `n`.

**Oracle.** Bench: at checkpoints with the planted frontier held fixed,
`packet.tokens` for a fixed query set does not trend with `n` (slope of tokens vs
`log n` within header-digit noise); no HISTORICAL atom is resident unless the
query names its key; an all-as-of query ("where did X live when we first
discussed Y") is answered by a page, with both intervals in `ledger.historical`.

## 10. Mirage conservation `L_{t+1} ⊇ transport(L_t) \ R_t`

**Status.** Design law (`DREAM.md` §8); mechanically enforced in `revelation`
(`Hole` is "never inferred away by compaction; only a distinct event can
transition it out of OPEN"). Not an empirical result.

**Mechanism.** `loss` rows are append-only; the only transition is `resolved_by =
tombstone`; export carries them; import verifies counts.

**Oracle.** Row count of `loss` is monotone across any sequence of `compact()`
calls; conservation + completeness (§3) hold for every parent; after
export→import, `count(loss)` and every `(name, seq, span)` are identical.

## 11. Decision-relative soundness `Dep(d) ∩ L_t = ∅`

**Status.** Design law (`DREAM.md` §8; `revelation` gate). Pylos v1 gates no
actions; the chat analogue is: nothing the packet marks SUPPORTED depends on an
unresolved loss. Ledger names that are resident elsewhere in the packet are not
losses *of this packet*: `L_t := ledger ∖ names(K_t)`. The same law is why a
PROPOSED atom cannot satisfy a dependency: it is not in `SUPPORTED`, so nothing
downstream may treat `Dep(d) ∩ {proposals}` as if it were `Dep(d) ∩ L_t = ∅`
(KERNEL A9.1 — models may propose, never authorize).

**Oracle.** The `⟨lost: …⟩` digest never lists a name present in the packet's
frontier, paged, or recent slots; every ledger page served is recorded with its
trigger in `packet.pages` before the provider call is made.

## 12. Semantic frontier width `W_t ≤ B`

**Status.** Definition (`DREAM.md` §8). Empirically, `revelation-context` measured
the project-level frontier on real sessions as **sublinear, not bounded**
(`frontier-sublinear`, median α = 0.344; "bounded" withdrawn) and showed that the
declared witness cap, not the mechanism, is what holds residency down.

**Mechanism.** The frontier slot is capped; overflow atoms are evicted by
(pinned > kind priority > recency) and each eviction writes a `loss` row of
kind `atom` so the overflow is pageable, never silent.

**Oracle.** When `|SUPPORTED atoms| × line tokens > frontier slot`, every
non-resident SUPPORTED atom key appears in the unresolved ledger; a query naming
it pages it.

## 13. Supporting results used implicitly

- **Row 19** (PREREGISTERED): re-expansion restores 18/18 — exact pages restore
  justification; Pylos pages episodes, never summaries.
- **Row 12** (PREREGISTERED, negative): a reader-facing `OMITTED:` line raises
  abstention but does not stop action-channel fabrication on two of three models.
  The view contract is a courtesy, not the mechanism; the router is.
- **Row 24** (REFUTED → `J ≥ S`): string survival is a conservative lower bound on
  justified accuracy. The ledger can prove a loss; it cannot certify a reader
  cannot reconstruct. Conservative direction = extra pages, never missing ones.
- **Row 48** (EXACT): rolling exact window + stable-key index + exact fallback is
  the reference architecture; Pylos = recent slot + atom/loss index + `UNKNOWN`.
  Two more exact routes reach the index besides the ledger: the sequence address
  (`#seq`, deterministic — "turn 345" pages that seq exactly, KERNEL A9.3) and
  the lexical address (FTS5, porter stemming, KERNEL A9.4). Neither is a ledger
  guarantee — the sequence route answers "what's at this position", not "what
  was lost", and the lexical route is a best-effort address over stemmed text,
  not a completeness proof.
- **Frontier factorization lemma** (proved, finite portfolio model): minimum page
  portfolios factor over connected components — Pylos pages per ledger name
  independently, which is exact only because names are treated as independent.

## 14. What we are NOT claiming

- That a model cannot be wrong, or that entailment is checked. Pylos bounds
  *silent* loss of context; it does not police reasoning.
- That resident context is bounded for natural conversations. Measured frontier
  growth on real sessions is sublinear (α ≈ 0.34); Pylos degrades to the ledger.
- That any natural-conversation benchmark number exists. All v1 numbers are
  deterministic synthetic; the live variant is a sample, not a result.
- That the capsule hierarchy is information-theoretically small (RCP's byte
  ratios are implementation artifacts; ours will be too).
- That succession across vendors preserves behaviour; it preserves the packet.
- That a reply has been fact-checked. The verification round (KERNEL A9.5)
  pages only the names the ledger recorded as dropped when a draft states them
  — presence against the archive, not truth of the claim.
- That an assistant cannot mislead a later model. A proposal (KERNEL A9.1) is
  shown unconfirmed, `key ≈ value ⟨proposed by assistant #seq · unconfirmed⟩`,
  not hidden or suppressed; nothing stops a later model from reading it and
  restating it.

## 15. Where the mechanism exceeds the evidence

1. **`names()` on natural language.** Row 21's recall 1.00 is for synthetic
   numeric policy values with a collision guard. Our name extractor (entities,
   dates, quotes, code ids, atom keys) is unmeasured; recall is 1.00 only for
   names it recognizes, and precision in free text is unknown. The bench measures
   false-page rate; it cannot measure misses of names the extractor never saw.
2. **Precision 0.917 was on 30 items, one model.** Free-text queries will fire on
   common names; the routing cap and stop-names exist for this reason.
3. **Rows 18/37/38 are 1–3 models, 3–8 generations.** A rolling root recompacted
   30,000 times is far outside the tested regime; the ledger makes it safe, the
   *quality* of the root text is untested.
4. **The extractive writer was never run in epistemic-debt**; row 16 tested model
   writers with a value-dense instruction. Our writer is value-dense by
   construction, which is a stronger property, but its capsule quality is unmeasured.
5. **The view contract's effect on grok-4.x is unmeasured** (row 12 says
   reader-side manifests help some models, not others).
6. **Frontier = current atoms** assumes the atomizer finds the key. Rule-based
   atomization on natural text is the weakest link; a missed atom is still in the
   ledger only if `names()` caught a value in it.
7. **1K→1M invariance (RCP)** used stable keys known in advance and an oracle
   selector. Pylos's keys are discovered by the atomizer; the bench plants them.
8. **The lexical route (KERNEL A9.4) is an address, not a guarantee.** It finds
   an episode only when the query shares ≥ 2 stemmed content words with it and
   either the query names something unknown or no name route resolved a page
   this turn. `bench/results/million-2.md` measured 2,000/2,000 planted
   name-free memories (0 ledger rows, no routing name at all) found by this
   route at the 1,000,000-turn checkpoint; paraphrase without lexical overlap
   is still not found deterministically, and precision on real conversation is
   unmeasured.
9. **The verification round (KERNEL A9.5) fires only for names the ledger
   recorded as dropped.** Its effect on answers is unmeasured: row 12 shows
   reader-facing manifests help some models and not others, and that is the
   closest evidence we have to how a model treats a `⟨pylos check⟩` prompt.
