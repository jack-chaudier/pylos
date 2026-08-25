# Theory → mechanism → oracle

This document maps the results Pylos relies on to the mechanisms they license (or
constrain) and to the test oracle the kernel suite must contain. Status labels are
the source repositories' own: **THEOREM**, **EXACT** (exhaustive finite check),
**PREREGISTERED** (frozen prediction, LLM run), **OBSERVED** (exploratory / cached
re-analysis), **REFUTED**. Sources: `stark` (theorem ledger), `epistemic-debt`
(results table rows cited as "row N"), `revelation-context` (RCP), `revelation`
(kernel), and `DREAM.md` §8.

Current product claims stop at recognized, addressable retained history. “Exact”
means exact bytes or receipts within the named synthetic fixture, route, or test
oracle; it does not mean universal semantic recall, arbitrary natural-language
coverage, or unbounded operation. Provider-request and frontier budgets bound
packet accounting, not semantic width.

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
claim exists without ever presenting it as support. KERNEL A10.2 moves the
authoring further upstream than the ledger: the user's rule atomization now
runs before the packet is even compiled (tx A), so a correction made this turn
is a certificate in the very first request the model sees, and a provider
failure after that point still leaves the user's word committed as
user-authorized archive state — it is provenance, not independent verification
that the assertion is true.

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
(8×400 → 600 tokens), so every level is a loss event. A **rolling root**
(recompacting one root capsule each time a leaf seals) has the same *ledger
completeness* guarantee as a fixed-depth tree only under the oracle below:
generation count is free for that invariant, budget is not. This does not license
semantic recall or the text quality of a root after an untested number of
recompactions. What is *not* free is letting any resident capsule's terminal
budget fall below the witness knee (≈30 dense words per decision cluster).
Consequence: resident capsule count must be constant, not O(log n), and the
rolling root must be sized generously (see `docs/KERNEL_REVIEW.md`).

**Oracle (path independence of the ledger).** For any range `[a,b]` compacted two
ways (tree vs direct), `names(episodes[a..b]) ⊆ names(c.text) ∪ ledger(c)` holds
for both. This **completeness** invariant is the only sense in which the rolling
root is licensed; conservation (`ledger(parent) ⊇ ⋃ ledger(children)`) follows
from it by construction. It is not a claim that the root prose remains
semantically sufficient.

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
iff any recognized policy value is absent from the artifact by string check:
recall 1.00, precision 0.917, end-to-end 30/30 vs 26/30 for the best reader-side
router (OBSERVED, re-analysis, one model). The three items no reader-side trigger
can catch are silent: confident wrong, or coherent-but-wrong. The ledger routes
recognized losses by construction; this is not natural-language or universal
recall.

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

**The fault is routing's honest complement (KERNEL A11.1).** The rule above says
when to page; it says nothing about a question that carries no `names(q)` at
all — a conversational cue with no routable name is not a miss the ledger can
even see. Before A11.1 that turn's `pages` was simply empty: the model had no
way to tell "nothing here needed paging" from "nothing here could be found."
A11.1 turns the silent case into a receipt: when a question asks something and
refers to the conversation or the past, and none of the question's own routes
— sequence, name, lexical — resolved, the kernel writes one
`PageRecord{trigger:"fault", seqs:[], resolved:false}` and renders the
`⟨pylos fault⟩` line for the model to read. The decision is made over the
question's own routes only: a route that fired on the previous assistant
turn's names (§5.1) answered the model's sentence, not the user's question, and
does not silence the fault. A fault is not a claim about the archive or the
view — the answer may be resident under words the question didn't use, or held
under a name the extractor missed — it is a claim about the index: nothing in
it was reached. The handler is the same `recall` tool as A9.4; the fault only
guarantees the model is told to try.

**Oracle.** A cue-bearing question with no resolving route leaves exactly one
`fault` record and no resolved record of its own, and the `⟨pylos fault⟩` line
appears in the packet at unchanged budget (`packages/core/test/page.test.ts`,
"a question no route can reach records a fault, not silence"); an addressable
probe — one with a turn number, a routable name, or lexical overlap — never
draws a fault (same file, "the fault is about routing: a hit, a turn in view or
a question about the world do not").

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

## 9. Row 41 and the finite 1K→1M result: what may be resident

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
`(B, frontier, fixed capsule count)` and must not trend with `n` under the
fixed-frontier fixture. This is a finite accounting result, not a bound on
semantic coverage or universal recall.

**Oracle.** Bench: at checkpoints with the planted frontier held fixed,
`packet.tokens` for a fixed query set does not trend with `n` (slope of tokens vs
`log n` within header-digit noise); no HISTORICAL atom is resident unless the
query names its key; an all-as-of query ("where did X live when we first
discussed Y") is answered by a page, with both intervals in `ledger.historical`.
The oracle covers the stated fixture and routes only.

## 10. Mirage conservation `L_{t+1} ⊇ transport(L_t) \ R_t`

**Status.** Design law (`DREAM.md` §8); mechanically enforced in `revelation`
(`Hole` is "never inferred away by compaction; only a distinct event can
transition it out of OPEN"). Not an empirical result.

**Mechanism.** `loss` rows are append-only; the only transition is `resolved_by =
tombstone`; export carries them; import verifies counts. KERNEL A10.6 gives
forgetting the same shape at the level of the chain itself: `forget` never
deletes a `loss` row or rewrites `capsule.dropped` — a redacted capsule's text
is re-derived and any newly absent name is *appended* to the ledger with a
locator outside the removed material — and the removal itself is a chain event,
not a database edit: one `system` episode, `⟦removed #a, #b · <tombstone>⟧`,
is appended and its seq recorded on the tombstone, so `verify()` can require a
tombstone and a later removal episode for every `meta.removed = true` row and
fail a hand-set flag instead of skipping the content-hash check. KERNEL A10.7
gives export the matching shape on the object side: the bundle's `objects/`
set is a reachability closure over the exported episodes' own `meta.blob`
references, not the profile's whole object store, so exporting one thread
never ships another thread's attachments and a partial export ships only what
its range reaches; `packets.jsonl` is restored on import so the X-ray survives
transport, not just the ledger.

**Oracle.** Row count of `loss` is monotone across any sequence of `compact()`
calls, including `forget`; conservation + completeness (§3) hold for every
parent after a redaction, recomputed over the surviving source. After
export→import, `count(loss)` and every `(name, seq, span)` are identical, the
restored `packets` count matches `manifest.counts.packets`, and the object set
on disk is exactly the removed-episode-excluding closure the manifest declares
— nothing more, nothing less. A `removed = true` episode with no matching
tombstone-and-removal-episode pair fails `verify()`.

## 11. Decision-relative soundness `Dep(d) ∩ L_t = ∅`

**Status.** Design law (`DREAM.md` §8; `revelation` gate). Pylos v1 gates no
actions; the chat analogue is: nothing the packet marks SUPPORTED depends on an
unresolved loss. Ledger names that are resident elsewhere in the packet are not
losses *of this packet*: `L_t := ledger ∖ names(K_t)`. The same law is why a
PROPOSED atom cannot satisfy a dependency: it is not in `SUPPORTED`, so nothing
downstream may treat `Dep(d) ∩ {proposals}` as if it were `Dep(d) ∩ L_t = ∅`
(KERNEL A9.1 — models may propose, never authorize).

**KERNEL A10.1 sharpens `names(K_t)` to `Support(K_t)`.** Being *in* the packet
and being *evidence* are different things: a name surviving in a capsule's
prose is a mention, the current user turn is not a witness for itself, and a
value resident only in an assistant episode is not support just because it is
resident. `Support(K) := names(SUPPORTED spans)` — the frontier certificates
of `user`-authority atoms and the `user`/`tool`/`attachment` episodes in the
paged and recent slots, never capsule prose, `PROPOSED` lines, `HISTORICAL`
certificates, or the header. Every dependent rule reads `Support`, not
`packetText`:

```
page(n)  ⇔  n ∈ names(q) ∧ n ∈ L ∧ n ∉ Support(K)          -- ledger routing (§5, A4)
check(c) ⇔  Dependencies(c) ⊄ Support(K)                    -- the verification round (§6, A9.5)
```

The consequence for `Dep(d) ∩ L_t = ∅` above: `L_t` is decided against
`Support(K_t)`, not `names(K_t)`, so a value the model stated only because an
earlier turn of its own said so is treated exactly as if the packet had never
carried it — the archive, not the model's own prior word, is what discharges
the dependency.

**Oracle.** The `⟨lost: …⟩` digest never lists a name present in `Support(K_t)`;
every ledger page served is recorded with its trigger in `packet.pages` before
the provider call is made; a fixture where a name is resident only in an
assistant episode or only in capsule prose still pages on request and still
fires the check round if the final draft restates it unconfirmed.

## 12. Provider/frontier budget is not semantic width

**Status.** `W_t ≤ B` is a packet/request accounting definition (`DREAM.md` §8),
not a semantic-width theorem. Empirically, `revelation-context` measured the
project-level frontier on real sessions as **sublinear, not bounded**
(`frontier-sublinear`, median α = 0.344; "bounded" withdrawn) and showed that the
declared witness cap, not the mechanism, is what holds residency down. Neither
observation bounds the number, variety, or paraphrase coverage of meanings in
the retained archive.

**Mechanism.** The provider-facing frontier slot is capped; overflow recognized
atoms are evicted by (pinned > kind priority > recency) and each eviction writes
a `loss` row of kind `atom` so the overflow is pageable, never silent. This
controls the packet's resident state, not semantic width.

**Oracle.** When `|SUPPORTED atoms| × line tokens > frontier slot`, every
non-resident SUPPORTED atom key recognized by the oracle appears in the unresolved
ledger; a query naming it pages it. The receipt is exact for that recognized
address, not evidence of semantic recall.

**KERNEL A10.3 extends the provider-request bound past the compiled packet.**
`W_t ≤ B` held only
for the first message the provider saw; a `recall` result or the check prompt
(A9.5) could grow a later request in the same turn without limit. Every
provider request of a turn is now measured by the kernel's own count over
`packetText(messages)` and fit to the same `B` by `fitRound`: a pure function
that keeps the system header and the final prompt, drops from the front of the
recent window first — recoverable by sequence, unlike the material the round
is about — and never separates a tool result from the call that asked for it.
Ordinal 0 is the compiled packet (`rounds[0].messagesDigest = packet.digest`);
each later round records `{messagesDigest, tokens, budget, pages,
responseDigest, usage, status}` in `Packet.rounds`, and
`roundsDigest = sha256(concat(rounds[i].messagesDigest))` is inside the hash
chain (A5) via the assistant episode's `meta`. **Oracle.** For every round in
every recorded turn, `tokens ≤ budget`; `rounds[0].messagesDigest ==
packet.digest`; recomputing `roundsDigest` from the stored rounds matches
`meta.roundsDigest`.

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
  (`#seq`, deterministic — "turn 345" pages that seq exactly, KERNEL A9.3;
  A11.3 makes the neighbour speaker-aware — "what did I say on #450" follows
  the question that reply answered rather than the next episode by position,
  and `#n` accepts thousands separators) and the lexical address (FTS5, porter
  stemming, KERNEL A9.4). Neither is a ledger guarantee — the sequence route
  answers "what's at this position", not "what was lost", and the lexical
  route is a best-effort address over stemmed text, not a completeness proof.
  **The path (KERNEL A11.2) is a third, and it rides on the second:** a
  question and its reply are the thread's own vocabulary for a memory, and the
  packet that answered the question is the edge back to the evidence. When the
  lexical route (or `recall`) reaches a hit that is itself an answered question
  or its reply, the pager follows that hit's own page records — their
  locators, not their neighbours — and serves those as `path` pages, so a
  paraphrase that only overlaps the *later* retelling of a memory still reaches
  the original spans. It is an address, not an authority: a source reached this
  way keeps its role label and its `epistemic` (A10.1) exactly as the archive
  holds it; depth is one — a path page is served, not itself followed, in the
  turn that serves it; it is bounded by the same `P_max` and paged budget as
  every other page; it is closed by forgetting (a removed source fails to
  resolve) and conserved by export (`packets.jsonl` travels, so the edge
  survives a Laptop Funeral, KERNEL A10.7). The oracle is the kernel test
  suite, not a bench result this release: `packages/core/test/page.test.ts`
  ("a paraphrase reaches the source through the turn that answered it", "the
  path follows locators in priority order, and only the question's own names",
  "the path skips a source the view already holds", "a forgotten source is not
  served by the path, and records nothing") and
  `packages/core/test/bundle.test.ts` ("packets travel, so a paraphrase still
  finds the source after import"). No bench result measures the path this
  release; "a recurring question gets cheaper" is the mechanism's intent, not a
  measured claim.
- **Frontier factorization lemma** (proved, finite portfolio model): minimum page
  portfolios factor over connected components — Pylos pages per ledger name
  independently, which is exact only because names are treated as independent.

### A12–A15 release map: mechanism, oracle, and claim boundary

The following rows are the public boundary for the v2.0.0 contract. A kernel test
licenses the existence and failure mode of a mechanism; it does not turn a test
fixture into a natural-language or run-scale efficacy result.

| Mechanism | Oracle / evidence | What it licenses | What it does not license |
| --- | --- | --- | --- |
| A12 retained-byte closure | `packages/core/test/reachability.test.ts`, [`natural.md`](../bench/results/natural.md) + `natural.json` | Within the tested retained-byte domains, every retained interval is represented as resident, capsule, pageable, or explicit opaque; recent overflow and attachment-tail receipts are mechanically checked. The natural run observed reachability-receipt presence on 13/13 probes. | Natural discoverability, a full-scale four-state receipt audit, paraphrase recall, or semantic coverage outside the named byte domains. |
| A12 stream bundles | `packages/core/test/bundle-stream.test.ts`, [`funeral-6.md`](../bench/results/funeral-6.md) + `funeral-6.json` | Framed export/import, staging, late-corruption refusal, and exact million-episode/atom/capsule/loss/table transport are evidenced; turn-730,000 paging restored byte-exact within that synthetic artifact. | Nonempty Phase 2/4 receipt survival at scale, a total process-RSS bound, or universal transport/recall claims. |
| A13 collection obligations | `packages/core/test/obligation.test.ts`, `packages/core/test/integrity.test.ts`, [`natural.md`](../bench/results/natural.md) + `natural.json` | Cue-bearing questions carry located/supported/historical/unresolved counts plus a bounded kernel issuance basis for exact route membership; 2/2 authored coverage probes emitted receipts; known cardinality may be incomplete and unknown cardinality remains unestablished. User-authorized archive assertions remain provenance state, not verified truth. | An archive total, world cardinality, natural collection-recall rate, independent fact verification, or cryptographic proof against a full database rewrite and replacement hash-chain head. |
| A14 remembered-claim gate | `packages/core/test/claim-gate.test.ts`, `packages/server/test/gate-stream.test.ts`, [`natural.md`](../bench/results/natural.md) + `natural.json` | Kernel-issued capabilities, independent candidate scanning, source revalidation, qualifications, and post-gate streaming; 4 gate receipts and 0 safety-oracle violations in the authored run. It gates release of an authorized/provenance-bearing claim, not truth. | Entailment, fact-checking, model truth, or arbitrary-prose certification. |
| A15 address graph | `packages/core/test/address.test.ts` | A grounded route persists until an explicit invalidation or supersession, including export/import and source-hash checks. | Correct routing for arbitrary natural paraphrase or a measured second-question cost reduction. |
| A15 semantic and alias addresses | `packages/core/test/semantic.test.ts`, `address.test.ts`, `semantic-runtime.test.ts`, [`natural.md`](../bench/results/natural.md) + `natural.json` | Optional pinned local resources and model-written aliases can propose exact byte addresses; the compile-only authored run observed semantic receipt availability on 13/13 probes, produced 6/13 exact target semantic addresses, and recorded 5/13 false/non-target pages on the reported resolved-page denominator. It marks the `sqlite-vec` runtime mechanism implemented:yes/tested:no — the runtime exists in-tree (`packages/core/src/semantic-runtime.ts`) with kernel tests, but this compile-only bench invokes no semantic runtime directly. A separate arm64 macOS compiled-C preflight receipt is retained at [`semantic-preflight-aarch64-apple-darwin.md`](../bench/results/semantic-preflight-aarch64-apple-darwin.md) + `.json`: it shows one host loading pinned staged assets and answering one KNN probe, not an installed application or packaged/signed runtime; Linux semantic runtime support is unproven. | Semantic recall, precision, ranking, multilingual quality, authority, provider efficacy, or any packaged-runtime claim beyond the retained evidence. |
| Proof-thread demo | `packages/core/test/demo.test.ts`, `packages/server/test/demo.test.ts`, `apps/app/src/components/ProofTour.tsx` | A scripted local tour reads durable correction, coverage, invalidation, attachment-tail, and answer-gate receipts. | A benchmark number or provider/model quality claim. |
| Natural-question bench | `bench/natural.ts`, `packages/core/test/natural.test.ts`, [`natural.md`](../bench/results/natural.md) + `natural.json` | The asking turn is in the index; the linked artifacts retain one execution's result, digest `cd86341177409aaebe090757920cf4d9866aa5ea266e058e69b331a324589202`. Repeated-run stability of that digest is not evidenced by the retained artifact. It records 13 probes, 0 safety-oracle violations, semantic receipt availability 13/13, exact target semantic addresses 6/13, false pages 5/13, unresolved receipts 0/4, qualification errors 0/4, release errors 0/3, infrastructure failures 0/13, coverage receipts 2, answer/gate receipts 4, and model calls 0. | Recall, precision, ranking, multilingual, graph-reuse, provider efficacy, or packaged sqlite-vec runtime implementation; most families remain single-denominator and only two families have matched pairs. |

## 14. What we are NOT claiming

- That the finite, one-million-turn synthetic evidence proves unbounded storage,
  universal recall, or arbitrary natural-language coverage. The claim ceiling is
  recognized/addressable retained history only.
- That exact pageable bytes or receipts extend beyond their stated route and
  retained-byte domains; a receipt is evidence of a kernel route/oracle, not a
  guarantee that every meaning or paraphrase is discoverable.
- That a model cannot be wrong, or that entailment is checked. Pylos bounds
  *silent* loss of context; it does not police reasoning.
- That a user-authorized archive assertion is independently true. User episodes
  can establish provenance/authority state for routing, while truth verification
  remains outside this kernel.
- That resident context is bounded for natural conversations. Measured frontier
  growth on real sessions is sublinear (α ≈ 0.34); Pylos degrades to the ledger.
- That the natural-question result is a recall, precision, ranking, multilingual,
  graph-reuse, or provider-efficacy benchmark. [`natural.md`](../bench/results/natural.md)
  + `natural.json` is a stable, deterministic authored-fixture safety
  measurement with 13 probes and 0 oracle violations; semantic receipt
  availability is not proof of semantic efficacy. The compile-only mechanism
  row is implemented:yes/tested:no — the runtime exists in-tree with kernel
  tests, but this bench invokes no semantic runtime directly. It has
  single-denominator families except for one matched pair in partial collections
  and one in claim-map omission. The live variant remains a sample, not a
  natural efficacy result.
- That the capsule hierarchy is information-theoretically small (RCP's byte
  ratios are implementation artifacts; ours will be too).
- That succession across vendors preserves behaviour; it preserves the packet.
- That a reply has been fact-checked. The verification round (KERNEL A9.5)
  pages only the names the ledger recorded as dropped when a draft states them
  — presence against the archive, not truth of the claim. When the check round
  itself cannot be completed, `meta.check.status = check-failed` (KERNEL
  A10.4), the draft is kept as before, and the kernel appends one line naming
  what could not be re-checked rather than presenting it as confirmed.
- That an assistant cannot mislead a later model. A proposal (KERNEL A9.1) is
  shown unconfirmed, `key ≈ value ⟨proposed by assistant #seq · unconfirmed⟩`,
  not hidden or suppressed; nothing stops a later model from reading it and
  restating it.
- That a provider-request or frontier budget is a bound on semantic width. It
  bounds packet accounting and recognized resident state, not the number,
  variety, or paraphrase coverage of meanings.
- That only the compiled packet is bounded and only it is receipted. Recall
  results and the check prompt used to be appended to a request with neither
  cap nor record; every provider request of a turn is now `≤ B` by
  construction (`fitRound`) and receipted in `Packet.rounds`, chained into the
  assistant episode's `meta.roundsDigest` (KERNEL A10.3).
- That a fault means the archive lacks the answer. A `⟨pylos fault⟩` line
  (KERNEL A11.1) says the question's own routes found nothing; the answer may
  be resident under other words, or absent entirely — the kernel does not know
  which, and says so rather than guessing either way.
- That the fault gate is precise on natural questions. The cue list (a
  possessive, a past tense, a time word, a memory verb) is a heuristic chosen
  to make a false positive cheap — an extra sentence the model can act on or
  ignore — not a classifier with measured precision or recall (THEORY §15).
- That the path (KERNEL A11.2) makes a recurring question cheaper. That is the
  mechanism's intent; no bench result measures a cost reduction, and none is
  claimed.
- That a question needing many sources — *compare the eleven stories* — has an
  archive-total or completeness guarantee when only some sources are found.
  A13 records located, supported, historical, unresolved, and (only when
  authorized or explicit) required counts; unknown cardinality remains
  `completeness not established`.
- That the internal hash chain and A13 issuance basis are an external signature.
  They replay current sources and preserve later-forgotten route membership
  relative to the retained head. An attacker who can rewrite the whole vault,
  rewrite the basis, and replace every later hash needs an independently
  anchored head, MAC, or signing key to be distinguishable.
- That rolling-root safety extends beyond the ledger completeness oracle. The
  oracle licenses conservation of recognized names; root prose quality after
  long or untested recompaction is not established.
- That the operator-managed `serve --hosted` mode is a public Pylos service. It
  is a self-hosted/operator boundary with operator-supplied quotas and
  monitoring; Pylos does not operate a public multi-tenant deployment.
- That the v2 preview is a signed release. It is unsigned and source-only,
  pending a tagged release.
- That the reported arm64 macOS semantic preflight is a retained receipt, or
  that Linux semantic runtime support is proven. No preflight receipt is linked
  here; Linux remains unproven.
- That the historical v1 model drill or handoff sample generalizes to current
  providers, models, or product behavior.
- That checkpoint counts can be added to make a larger success total. Final-
  checkpoint counts and across-checkpoint probe totals are different
  denominators and must remain labelled separately.

## 15. Where the mechanism exceeds the evidence

1. **`names()` on natural language.** Row 21's recall 1.00 is for synthetic
   numeric policy values with a collision guard. Our name extractor (entities,
   dates, quotes, code ids, atom keys) is unmeasured; recall is 1.00 only for
   names it recognizes, and precision in free text is unknown. The bench measures
   false-page rate; it cannot measure misses of names the extractor never saw.
2. **Precision 0.917 was on 30 items, one model.** Free-text queries will fire on
   common names; the routing cap and stop-names exist for this reason.
3. **Rows 18/37/38 are 1–3 models, 3–8 generations.** A rolling root recompacted
   30,000 times is far outside the tested regime; the ledger oracle preserves
   recognized-name completeness, but the *quality* of the root text is untested.
4. **The extractive writer was never run in epistemic-debt**; row 16 tested model
   writers with a value-dense instruction. Our writer is value-dense by
   construction, which is a stronger property, but its capsule quality is unmeasured.
5. **The view contract's effect on grok-4.x is unmeasured** (row 12 says
   reader-side manifests help some models, not others).
6. **Frontier = current atoms** assumes the atomizer finds the key. Rule-based
   atomization on natural text is the weakest link; a missed atom is still in the
   ledger only if `names()` caught a value in it.
7. **The finite 1K→1M comparison (RCP)** used stable keys known in advance and an
   oracle selector. Pylos's keys are discovered by the atomizer; the bench plants
   them. It is not evidence of semantic-width or universal-recall invariance.
8. **The lexical route (KERNEL A9.4) is an address, not a guarantee.** It finds
   an episode only when the query shares ≥ 2 stemmed content words with it and
   either the query names something unknown or no name route resolved a page
   this turn. `bench/results/million-2.md` measured 2,000/2,000 planted
   name-free memories (0 ledger rows, no routing name at all) found by this
   route at the 1,000,000-turn checkpoint; paraphrase without lexical overlap
   is still not found deterministically, and precision on real conversation is
   unmeasured.
9. **The verification round (KERNEL A9.5, A10.1, A10.4) fires only for names
   the ledger recorded as dropped from `Support(K_t)`.** Its effect on answers
   is unmeasured: whether the reissued round actually corrects a stated value,
   how often `status` lands on `confirmed` vs `revised` on natural text, and
   how a model treats a `⟨pylos check⟩` prompt at all are not in any bench
   result — row 12 (reader-facing manifests help some models, not others) is
   the closest evidence we have, and it is about a different manifest.
10. **Support vs presence (KERNEL A10.1) is unmeasured on natural language.**
    The bench plants poison at the atom level (A9.1) and checks the frontier
    slot mechanically; it does not measure how often a natural draft restates
    a value it only saw in capsule prose or in its own earlier turn, nor the
    precision of the check round's page selection outside the synthetic
    corpus. The mechanism is exact by construction; its natural-language
    precision is not measured.
11. **The fault gate's precision and recall on natural questions (KERNEL
    A11.1) are unmeasured.** The bench measures the two things it can measure
    deterministically: that a routing miss on a question carrying a
    conversational cue and two words the corpus cannot contain leaves exactly
    one `fault` record and the notice, and that every addressable probe —
   sequence, name, or lexical — never draws one (`bench/results/million-5.md`,
   kernel 1.3.0; `million-4.md`, kernel 1.2.0). Whether the cue list fires on
   the right natural sentences, and how often it fires on ones
    that need no fault, is not a number this or any release reports.
12. **The path's precision on natural conversation (KERNEL A11.2) is
    unmeasured, and it has no run-scale number.** The kernel tests establish
    that the mechanism does what §13 describes on planted fixtures; nothing in
    `bench/results` runs it at the million-turn scale or asks whether the
    edges it follows on natural paraphrase are the ones a user meant.
13. **The search self-hit was invisible to the old deterministic bench.** The
    lexical route's strict AND pass matched the asking turn's own episode
    before the broader OR pass could run, so a natural question with a cue
    could fault instead of recovering the line it named — fixed by excluding
    the asking turn from `episodes.search` inside the SQL, with a kernel
    regression test. The old million bench still compiles probes without a
    question seq; `bench/natural.ts` now supplies the real-turn shape. The
    retained artifact ([`natural.md`](../bench/results/natural.md) +
    `natural.json`) carries one execution's result, digest `cd863411…`;
    repeated-run stability of that digest is not evidenced by the retained
    artifact. It is a safety measurement, not a recall or precision result.
14. **Collection coverage is measured as receipt safety, not natural recall.**
    A13 records lower-bound routes and explicit unresolved/unknown states; the
    natural run emitted 2/2 authored coverage receipts with no invented
    cardinality. It does not measure natural cue precision, collection recall,
    or the quality of a provider's qualified answer.
15. **The optional semantic runtime is an address mechanism, not evidence.**
    `sqlite-vec`, `sqlite-lembed`, the embedding model, dimensions, extension
    versions, and asset hashes are pinned; absent or incompatible resources
    fail closed. The compile-only authored natural run observed semantic receipt
    availability on 13/13 probes, exact target semantic addresses on 6/13, and
    false/non-target pages on 5/13 of the reported resolved-page denominator;
    its mechanism row is implemented:yes/tested:no, since the runtime exists
    in-tree with kernel tests but this bench invokes no semantic runtime
    directly. A separate local
    compiled-C arm64 macOS preflight receipt is retained at
    [`semantic-preflight-aarch64-apple-darwin.md`](../bench/results/semantic-preflight-aarch64-apple-darwin.md)
    + `.json`: pinned staged assets loaded and answered one KNN probe on that
    host; it does not exercise an installed application, packaging, signing,
    or notarization, and Linux semantic runtime support is unproven. None of
    these observations estimate semantic recall, precision, ranking,
    multilingual quality, or authority.
16. **The proof thread is a product demonstration, not a benchmark.** It uses a
    deterministic scripted provider and reads kernel receipts for correction,
    coverage, invalidation, attachment tail, and the memory gate. Its tests
    establish the demo contract; they do not establish provider quality or
    natural recall.
17. **The v2 stream path has one finite synthetic million-turn transport result,
    with a narrow receipt boundary.** [`funeral-6.md`](../bench/results/funeral-6.md) +
    `funeral-6.json` restores 1,000,000 episodes with the
    same head, full verification, exact turn-730,000 paging, 1,000,000 max
    staged rows, and declared transport bound 35,848,320 bytes with 1 MiB
    maximum buffers.
    Packet, answer, coverage, address, and alias counts were all zero, so the
    run does not establish nonempty Phase 2/4 receipt survival. RSS values are
    snapshots, not a bound; the historical v1 Laptop Funeral remains separate
    evidence for its old bundle. The local v2 preview remains unsigned and
    source-only pending a tagged release; this artifact is not a public hosted
    service or universal-recall claim.
