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
claim exists without ever presenting it as support. KERNEL A10.2 moves the
authoring further upstream than the ledger: the user's rule atomization now
runs before the packet is even compiled (tx A), so a correction made this turn
is a certificate in the very first request the model sees, and a provider
failure after that point still leaves the user's word committed — the archive
does not need a reply to be true.

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

**KERNEL A10.3 extends the bound past the compiled packet.** `W_t ≤ B` held only
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
  — presence against the archive, not truth of the claim. When the check round
  itself cannot be completed, `meta.check.status = check-failed` (KERNEL
  A10.4), the draft is kept as before, and the kernel appends one line naming
  what could not be re-checked rather than presenting it as confirmed.
- That an assistant cannot mislead a later model. A proposal (KERNEL A9.1) is
  shown unconfirmed, `key ≈ value ⟨proposed by assistant #seq · unconfirmed⟩`,
  not hidden or suppressed; nothing stops a later model from reading it and
  restating it.
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
- That a question needing many sources — *compare the eleven stories* — is
  known to be incompletely answered when only one source is found. A question
  today is answered from whichever routes fire; there is no receipt for the
  n−k sources that did not resolve. The fault (KERNEL A11.1) covers the total
  miss, not the partial one; collection completeness is the next kernel
  milestone (A12), not a shipped one.

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
    kernel 1.3.0; `million-4.md` is the same kernel before the version bump). Whether the cue
    list fires on the right natural sentences, and how often it fires on ones
    that need no fault, is not a number this or any release reports.
12. **The path's precision on natural conversation (KERNEL A11.2) is
    unmeasured, and it has no run-scale number.** The kernel tests establish
    that the mechanism does what §13 describes on planted fixtures; nothing in
    `bench/results` runs it at the million-turn scale or asks whether the
    edges it follows on natural paraphrase are the ones a user meant.
13. **The search self-hit was invisible to the deterministic bench.** The
    lexical route's strict AND pass matched the asking turn's own episode
    before the broader OR pass could run, so a natural question with a cue
    could fault instead of recovering the line it named — fixed by excluding
    the asking turn from `episodes.search` inside the SQL, with a kernel
    regression test. The bench never surfaced it because it compiles without
    a question seq: the corpus's probes are asked of an already-compiled
    packet, not appended as a turn that then searches the index containing
    itself. A natural-question family that compiles *with* the asking turn in
    the index — the shape a real conversation has — is a measurement still
    owed.
14. **Collection completeness is unmeasured and unbuilt.** A question that
    needs n sources is answered today from whichever routes fire, with
    nothing recorded about the n−k that did not resolve; the fault (KERNEL
    A11.1) is a receipt for a total miss, not a count against a known n. This
    is the next kernel milestone (A12), not a claim this release makes.
