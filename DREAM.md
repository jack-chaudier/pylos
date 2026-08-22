# Revelation: the full audit

## The verdict

**Continue. But do not continue in a straight line.**

There is a diamond here. It is not yet “infinite memory,” and it is not primarily the coding-agent worktree product currently presented on the landing page.

The diamond is this:

> **A lossy context transformation should never be allowed to hide what it lost.**

That idea appears throughout Revelation as sticky semantic holes, source invalidation, page faults, evidence restoration, bounded capsules, and an authority gate outside the model. It is substantially more interesting than another vector database, another long-term-memory framework, or another agent dashboard.

Today, Revelation is a serious continuity and authority kernel wearing the clothes of a cautious coding agent. The product you are now describing is larger and cleaner:

> **One conversation. Every model. No silent forgetting.**

The user opens Revelation and sees a single beautiful chat. They can connect Grok now, other models later, attach a repository or folder when useful, and continue one conversation indefinitely. Models can be upgraded, killed, or replaced. The conversation remains. The full record remains. The active context stays bounded. When deciding evidence is absent or stale, the system retrieves it, qualifies the answer, or refuses to pretend.

That is a much stronger product.

There is one critical wording correction:

**Do not promise that Revelation never compacts context.** A bounded model must receive a bounded view.

Promise instead:

> **Revelation never destructively compacts the source of truth. It continuously compiles the view.**

The enduring entity is not the model. **The thread is the agent. Models are temporary cognition.**

---

## My objective scorecard

| Dimension                          | Verdict                               | What it means                                                                                                     |
| ---------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Research discipline                | **Strong**                            | The repository is unusually careful about claim boundaries, deterministic evidence, baselines, and nonclaims.     |
| Kernel architecture                | **Strong and worth preserving**       | The archive, continuity, authority, recovery, and provider seams form a credible base.                            |
| Natural efficacy evidence          | **Weak so far**                       | The strongest results remain synthetic or one-world mechanics demonstrations.                                     |
| Product clarity                    | **Split**                             | The code gestures toward continuity, but the public product sells safe Git promotion.                             |
| User experience                    | **Promising shell, wrong center**     | The one-stream design is close, but every turn is still modeled as a repository work transaction.                 |
| Distribution and operational trust | **Early**                             | Unnotarized macOS delivery, unclear green release provenance, no visible external adoption loop.                  |
| Defensibility                      | **Potentially high**                  | It depends on proving loss-observable context compilation, not merely persistent memory.                          |
| Investor readiness                 | **Interesting, not irresistible yet** | The technical story is fundable. The impossible-looking demo, natural benchmark, and user pull are still missing. |

---

# 1. What Revelation actually is today

The checked-in package identifies itself as `1.0.0-rc.1` and describes Revelation as “a local-first coding-agent runtime for evidence-gated finite handoffs.” Its scripts include the Studio, binaries, evaluator, succession benchmark, training pipeline, and verification suite.

The current architecture is genuinely coherent. It separates:

* **Chronicle**, which records what visibly happened.
* **Continuity**, which tracks active obligations, claims, evidence, and known holes.
* **Authority**, which decides what may happen next.
* An archive plane, semantic plane, authority plane, and continuation projection.

That separation is one of the strongest parts of the project. It prevents conversational prose from silently becoming truth or authorization.

The kernel already has several qualities that should survive any product pivot:

* Append-only, hash-bound events.
* Content-addressed evidence.
* Exact source revision invalidation.
* Sticky `MIRAGE`, `UNKNOWN`, and `REVOKED` states.
* Bounded resident memory.
* Deterministic replay.
* Typed recovery programs.
* External authorization receipts.
* Provider-neutral executor seams.
* Isolated Git worktrees for speculative coding.

The SQLite implementation is careful about symlinks, permissions, canonical serialization, transactional validation, hash chains, and incremental replay from a verified anchor. This is not throwaway prototype code.

The provider registry is also more extensible than the public story suggests. It includes Grok ACP, a deterministic provider, and strict support for user-configured generic ACP executors.

So the answer to “is this a solid base?” is:

**The kernel is a solid base. The current product boundary is not the final one.**

---

# 2. The largest mismatch: Revelation does not yet contain the immortal chat

This is the most important finding in the entire audit.

The Chronicle stores visible user and assistant history in an append-only, hash-chained SQLite ledger, but the code explicitly defines that history as non-authoritative. That part is correct.

The problem is what happens next.

The current `.infinite` continuation format deliberately excludes:

* The standalone transcript.
* Provider session state.
* Provider handles.
* Chronicle conversation history.

Successor executors resume from the bounded continuity capsule, not the raw conversation. Chronicle text is explicitly excluded from the continuation bundle and from successor handoffs.

That was a defensible design decision for the coding-agent authority product. It is incompatible with the new promise:

> Open one chat and continue forever.

At present, the project can preserve semantic obligations across handoffs. It cannot yet truthfully guarantee that the exact lifelong conversation travels with the agent, survives export, or can be paged back into future conversations.

This is not a minor missing feature. It is the new product’s central architectural requirement.

The fix is not to let transcript prose become authority. The fix is to introduce a first-class **episodic plane**:

1. Raw episodes remain exact, immutable, and page-addressable.
2. Derived memories remain typed, revisable, and non-authoritative.
3. Claims and actions remain governed by the existing authority plane.
4. Successor models may retrieve exact episodes when necessary.
5. Full conversation history becomes part of an encrypted `.infinite v2` bundle.

That preserves the good separation while making the immortal thread real.

---

# 3. Your one-chat GUI instinct is correct

The current Studio already has the visual skeleton of the right product. It renders one continuous transcript, oldest to newest, with a pinned composer. Work events, receipts, missing evidence, handoffs, and verdicts appear inline.

But its semantics are still those of an agent console.

The cold start tells the user to run `revelation serve` inside the repository they want to protect.

The composer asks what the agent should do, selects an executor, defaults tools on, and submits a `WorkRequest`.

The system copy is built around isolated workspaces, project promises, applying changes, and gate verdicts.

That means it looks like chat but behaves like a workflow form.

## What the new opening should be

On launch, the user should see:

* One empty, calm conversation.
* One composer.
* A tiny model indicator, initially Grok.
* An attachment control.
* A subtle continuity seal.
* Nothing else.

No repository initialization. No project checklist. No evidence graph. No obligation dashboard. No worktree vocabulary.

The first message should be enough to begin.

The local runtime and durable vault should start automatically. Connecting xAI can happen when the first message is sent, with the same local credential custody you have already built.

A repository becomes something the user **attaches to the conversation**, not the object they must enter before Revelation exists.

## The right interaction hierarchy

The default layer is simply conversation.

When memory reconstruction happens, Revelation can show a small line such as:

> Recovered three earlier moments before answering.

When a source has changed:

> One earlier belief was out of date. I checked the current source.

When evidence is missing:

> I remember the conclusion, but not enough of its support to state it as fact.

When the model changes:

> Grok stopped here. Qwen continued from the same thread.

The detailed machinery remains available behind the continuity seal or a “Why?” control on a sentence. The evidence graph, receipts, restoration ladder, and source revisions become an X-ray, not furniture scattered across the room.

## One chat must not mean one undifferentiated memory swamp

A lifelong conversation will eventually include private matters, codebases, travel, relationships, speculative ideas, and outdated beliefs. Injecting all of that into one universal vector soup would create contamination, privacy leakage, and increasingly eccentric behavior.

Internally, the thread needs sealed scopes:

* Global preferences and stable identity.
* Project-specific memory.
* Time-bounded or historical facts.
* Local-only sensitive information.
* Ephemeral scratch context.
* External-safe information that may be sent to a cloud model.
* User-forgotten or cryptographically erased material.

The user still experiences one chat. The compiler experiences a structured world.

**One chat should be the address, not the internal data structure.**

---

# 4. The landing page is beautiful, but it sells the smaller company

The landing page’s current headline is:

> The project survives every agent.

Its central explanation is “Promise, Speculate, Prove,” and its signature demonstration is a Git promotion denied because supporting test evidence is stale.

That is a respectable developer tool. It does not communicate a new form of persistent intelligence.

A visitor currently leaves with the impression that Revelation is:

* A safer coding-agent wrapper.
* A local Git worktree orchestrator.
* A test-evidence gate.
* A niche alternative to letting an agent edit `main`.

They do not leave thinking:

> I just saw a conversation survive a million turns, three models, a false memory, and a dead laptop.

The site also contains a placeholder canonical origin for `revelation.dev` and omits an Open Graph image pending brand art. Those are small details, but they reinforce that this is still a release surface rather than a launch-grade category statement.

I could not independently retrieve the supplied live deployment through the available site-fetching paths, so the visual audit is based on the checked-in landing source and design files rather than a rendered browser capture.

There is also a brand-distinctiveness warning. The design reference explicitly says the visual direction was derived from a Hermes Agent reference capture. The resulting ultramarine, serif, parchment, and monospace evidence aesthetic is attractive, but a breakout product should develop a visual signature that unmistakably belongs to Revelation.

The existing aperture graphic offers a path. Turn it into the product metaphor:

* The aperture is the fixed context window.
* The surrounding rays are the unbounded archive.
* A few rays illuminate as exact evidence is paged into the present.
* A stale ray changes state when its source is revised.
* The aperture remains fixed while the world around it grows.

That animation could explain the entire research program in ten seconds.

## The new landing hierarchy

The first screen should say:

> **A conversation that outlives every model.**

Then:

> Revelation preserves the exact record, compiles only what the current model needs, and retrieves the evidence it lost before memory becomes invention.

And the compact product line:

> **One conversation. Every model. No silent forgetting.**

The primary action should not initially be “Download for macOS.”

It should be:

> **Watch turn 1,000,000**

The download comes after the impossible-looking proof.

The coding gate still matters, but it moves into a later section titled something like:

> **When the conversation acts, memory becomes authority.**

That connects the broad product to the formidable kernel you have already built.

---

# 5. Codebase audit

## What is strong

### The authority boundary is real

Many agent-memory systems merely tell the model that a memory is uncertain. Revelation keeps authorization outside model prose. The model proposes. The kernel checks declared dependencies, source revisions, resident evidence, holes, and policy. That is a substantial design advantage.

### Exactness is preserved beneath summaries

Events and evidence blobs are immutable and hash-bound. Summaries are projections, not canonical truth. This creates the possibility of reprocessing old history with a better memory compiler later.

That is powerful. A future Mirage-2 could revisit years of retained episodes and extract better structure without rewriting the past.

### Recovery is first-class

A page fault does not merely display an error. The recovery compiler can produce deterministic steps such as restoring a witness, rerunning a check, reobserving a source, switching a certificate, asking a human, or explicitly abandoning an obligation.

That is the beginning of self-repairing context, not just retrieval.

### The server facade is clean

The `RuntimeFacade` keeps the HTTP and Studio boundary separate from kernel semantics. It already exposes prompts, work, pages, gates, Chronicle, providers, receipts, and executor transitions. This seam can support a chat-native runtime without rewriting the kernel.

### The UI stack is admirably small

Studio is React, Vite, TypeScript, and bundled fonts, without a thicket of state-management and component-library dependencies.

That simplicity is worth preserving.

---

## What will limit growth

### 1. Chronicle and authority are separate durable systems

Chronicle and the authority event log live in separate SQLite stores. That is acceptable for an explanatory projection. It becomes dangerous once the exact conversation is a product-critical asset.

A crash must not produce:

* An assistant answer in Chronicle without its memory derivation.
* A memory atom without the episode that created it.
* A visible answer without its output-support receipt.
* A provider turn committed in one database but absent from another.

For v2, use either:

* One canonical event ledger from which Chronicle and semantic state are projected, or
* A transactional outbox with deterministic reconciliation across stores.

The exact conversation, memory derivation, and authority result need one recoverable commit story.

### 2. Several modules are becoming role-dense

The CLI index, agent loop, and workspace observer are each tens of thousands of bytes, as are the generic and Grok ACP implementations.

That does not make them bad. It signals that the next architecture should establish firmer package boundaries before adding a global vault, sync, direct chat providers, attachments, memory compilation, and an answer gate.

I would separate:

* `@revelation/kernel`
* `@revelation/thread`
* `@revelation/context-compiler`
* `@revelation/providers`
* `@revelation/authority`
* `@revelation/studio`
* `@revelation/sdk`
* `revelation` CLI and desktop shell

Do not rewrite this in Rust merely because it feels more infrastructural. TypeScript and Bun are adequate until measurements identify a portability, performance, or embedding boundary that justifies a native core.

### 3. Hash-chain verification will need segmentation

The existing incremental `eventsSince` anchor mechanism is good. Full replay and verification will still become increasingly expensive at very large histories.

For million-turn durability, introduce:

* Immutable archive segments.
* Periodic signed or hash-bound checkpoints.
* Merkle or accumulator commitments.
* Content indexes rebuildable from canonical segments.
* Restore verification that does not require replaying an entire lifetime before the UI opens.

### 4. Tool safety is not yet broad enough for an immortal assistant

The current worktree isolates speculative repository edits from the primary Git tree, but it is not an operating-system sandbox. The project’s own documentation correctly states that commands run with the host user’s privileges and that provider tools can sometimes act before Revelation observes or denies the result.

The current composer defaults tools on because the repository worktree is treated as the safety boundary. That is too permissive for a general lifelong chat.

For the broad app:

* Tools should default off.
* Read-only tools should be distinct from mutation tools.
* Retrieved content must always be typed as data, never instructions.
* Mutating tools need pre-execution authorization.
* High-risk execution needs a real sandbox, container, or OS-level broker.
* A denial after execution must never be described as containment.

### 5. Portability and durability are below the proposed promise

The current `.infinite` format is unencrypted, excludes Chronicle history, and carries reachable evidence verbatim. The macOS app stores state in the selected project’s `.revelation` directory and is ad hoc signed rather than notarized.

An immortal chat must survive:

* Application upgrades.
* A corrupt local index.
* Laptop loss.
* Migration to a new computer.
* Provider shutdown.
* Model changes.
* Attachment relocation.
* Schema evolution.
* Selective user deletion.

The “Laptop Funeral” test should become a release gate: export an encrypted thread, destroy all local app state, restore on a clean machine, verify the exact conversation and its commitments, and continue with a different model.

### 6. “Never forget” needs a commanded-forgetting design

A lifelong conversation will contain secrets and mistakes. The product must support forgetting deliberately.

Because the archive is append-only, deletion should be represented through a combination of:

* Signed tombstones.
* Removal from all active indexes and projections.
* Per-object encryption or compartment keys.
* Cryptographic erasure of deleted material.
* Explicit retention policies.
* Verification that deleted objects are not included in export or sync.

The honest promise is not “nothing can ever be deleted.”

It is:

> **Revelation never forgets silently, and it forgets only under an explicit policy or user command.**

---

# 6. Release and engineering-process audit

The repository’s internal evidence discipline is stronger than its release discipline.

PR #1 changed 133 files with 22,277 additions and 3,734 deletions. It had no requested reviewers or discussion and was merged approximately seventeen seconds after creation. The PR body reports 257 passing tests, 1,910 assertions, typechecking, linting, builds, evaluation, a mock end-to-end run, compiled binaries, and live Studio verification. Those are the author’s reported results; I did not independently rerun the complete suite.

The corresponding CI run available through the connector passed typechecking, tests, builds, evaluation, succession, linting, adapter tests, and dependency audit, then failed at secret scanning. I could not verify a subsequent green CI run for the latest `main` head through the connector.

The checked-in workflow currently runs on `ubuntu-latest`.

The distribution documentation, however, says target-specific validation is performed in matching operating-system CI environments.

That mismatch needs to disappear.

For a product built around verifiable trust, the release process should itself become a Revelation demonstration:

* Protected `main`.
* Required green checks.
* At least one independent reviewer.
* Linux, macOS, and Windows smoke tests.
* Signed release manifests.
* Apple Developer ID signing and notarization.
* Reproducible or independently checked binary hashes.
* An evidence page binding the downloadable artifact to exact source and CI receipts.
* Versioned migrations and restore tests.
* Public security policy and threat model.
* Release notes that separate deterministic guarantees, provider observations, and hypotheses.

The code should not be more accountable than the process that ships it.

There is also version drift. `package.json` says `1.0.0-rc.1`, while the product contract begins by declaring package/runtime version `0.3.0`.

That is easy to repair, but it matters. Anyone evaluating a trust product will notice contradictions in its own state.

---

# 7. The market is crowded, but the real opening remains open

Persistent AI memory is no longer an empty category.

ChatGPT now synthesizes memory from prior conversations, files, and connected applications. Letta distinguishes core, recall, and archival memory. Mem0 sells cross-session memory and compression. Zep and Graphiti maintain temporal knowledge with invalidation and provenance. LangGraph provides thread checkpoints and cross-thread stores. ([OpenAI Help Center][1])

So “we give an agent long-term memory” is not a sufficient company thesis.

The research frontier is converging quickly too:

* **MemMachine** preserves full episodes and retrieves ground-truth conversational evidence. ([arXiv][2])
* **Infini Memory** maintains evolving topic documents and iterative retrieval. ([arXiv][3])
* **MemIR** introduces typed memory atoms that separate raw evidence, cues, and truth-bearing claims, with authorization limited to supported claims. This is especially close to Revelation’s direction. ([arXiv][4])
* **WhenLoss** separates write-time loss from retrieval-time loss and finds that write-side degradation can dominate. ([arXiv][5])
* **STALE** and **A-TMA** study revision, invalidation, historical state, and “ghost memory.” ([arXiv][6])
* Work on origin-bound authority shows how poisoned memory can be laundered through summaries, tool echoes, and apparent corroboration. ([arXiv][7])
* **MemMark** already uses watermarking around memory-state evolution, although its main target is attribution rather than epistemic support. ([arXiv][8])
* Most consequentially, **Governed Persistent Memory**, published in August 2026, already combines bitemporal state, source binding, stale and retracted states, exact structured claim closure, and fail-closed release against a fresh head. ([arXiv][9])

That last paper does not kill Revelation. It removes the easy paper.

You should not lead a research claim with:

* Persistent memory.
* Typed provenance.
* Temporal invalidation.
* Fail-closed release.
* Source-bound facts.
* Memory watermarking.

Those pieces increasingly exist.

## The white space Revelation could own

The strongest defensible synthesis is:

> **Repeated context compression with a durable, compositional, enforceable loss contract.**

Not merely “this fact came from source X.”

Not merely “this fact is stale.”

Not merely “the model has long-term memory.”

Instead:

1. Every lossy transformation reports what kinds of future decisions it can no longer safely support.
2. That report survives further compaction and model handoffs.
3. Missing support can be paged exactly.
4. Source changes invalidate derived authority.
5. The model cannot convert an elegant summary into unsupported certainty.
6. The restriction affects behavior through an external gate.
7. The mechanism works across disposable model processes.

That is a much sharper research blade.

---

# 8. The new mathematical core: loss-carrying context

Here is the principle I would build the research program around:

> **The Revelation Principle:** Any lossy transformation used by a long-running intelligent system must emit a durable, machine-checkable account of the decisions it can no longer safely support.

A summary without such an account is not reliable memory. It is amnesia wearing good prose.

Formally, let a context compiler operate as:

[
C_B(H_t,q_t) = (K_t,L_t,P_t)
]

where:

* (H_t) is the complete canonical history at time (t).
* (q_t) is the present query or proposed action.
* (B) is the model-visible budget.
* (K_t) is the bounded context packet given to the model.
* (L_t) is the loss contract, or MirageMark.
* (P_t) is a page map that can recover exact omitted material.

The trivial part is (|K_t| \leq B).

The interesting requirements are these.

## Loss observability

Every active claim whose deciding support is not represented in (K_t) must appear in (L_t) as unsupported, historical, ambiguous, or pageable.

## Mirage conservation

Further compression cannot make a known loss disappear:

[
L_{t+1} \supseteq \operatorname{transport}(L_t) \setminus R_t
]

where (R_t) contains only explicitly resolved, reobserved, discharged, or abandoned losses.

A `MIRAGE` may become `SUPPORTED` because evidence returned. It may not become `SUPPORTED` because another summary forgot that it was a mirage.

This is the deepest existing Revelation idea.

## Decision-relative soundness

For a protected assertion or action (d), let (\operatorname{Dep}(d)) identify the evidence and source conditions on which it depends.

Release is allowed only when:

[
\operatorname{Dep}(d) \cap L_t = \varnothing
]

and a complete, current support certificate is present.

## Stable-head release

The evidence packet must be bound to the same source head checked immediately before release. Otherwise, context can become stale between compilation and emission.

## Exact pageability

Every pageable loss must either resolve to exact retained material or escalate to `UNKNOWN`. A locator that quietly drifts to something merely similar is not recovery.

## Compositionality

If history is compressed repeatedly by different models, processes, or policies, the resulting loss contract must be at least as conservative as the composition of the earlier contracts.

This matters because an “infinite” agent is not compressed once. It is compressed thousands of times by changing systems.

---

## A deeper scaling law: semantic frontier width

History length is probably the wrong measure of difficulty.

Define the **active semantic frontier** as the minimum current information needed to support all unresolved decisions and to locate everything currently omitted.

Let:

[
W_t =
\min_{S}
\operatorname{cost}(S)
]

subject to (S) containing a complete current certificate for each active obligation, together with a complete representation of unresolved losses and exact page locators.

Then indefinite operation under resident budget (B) is feasible when either:

[
W_t \leq B
]

or the excess frontier is recoverably pageable at acceptable latency.

This produces a much more honest definition of effective infinity:

> **A system can operate indefinitely when archive size grows without bound while active semantic frontier width remains bounded or efficiently pageable.**

That explains why a million-turn conversation may be easy while a ten-page problem may be impossible. The million turns may contain only a small number of active decisions. The ten pages may require a densely entangled proof whose evidence must be simultaneously resident.

This also suggests a real research program.

Measure:

* Active obligation churn.
* Certificate overlap.
* Source volatility.
* Frontier width.
* Page-fault frequency.
* Dependency-graph treewidth.
* The phase transition where initially local obligations become globally entangled.

A candidate theorem direction would be:

> For bounded witness cost and bounded support-hypergraph frontier width, an exact continuation representation exists whose resident size is independent of archive length, up to commitments and page locators.

A corresponding lower bound would show that no context manager can remain bounded when future decisions require simultaneously distinguishing an unbounded number of active equivalence classes.

That is a far stronger and more honest mathematical road than “we tested 1,000 checkpoints.”

---

# 9. What the current evidence proves, and what it does not

## The Thousandth Handoff

The current hero demo performs 1,000 checkpoints, five scripted executor handoffs, a stale-source trap, deterministic recovery, promotion, and archive verification while keeping the capsule within a 4,096-byte budget.

That is a good conformance demonstration.

It does not demonstrate:

* A million natural conversational turns.
* Preservation of exact episodic history.
* Cross-vendor semantic continuation.
* Natural query understanding.
* Correct automatic obligation discovery.
* Better long-horizon model performance.
* Recovery from laptop loss.
* Human willingness to live inside one thread.

The unit test named `infinity.test.ts` similarly registers one stable witness and obligation, then checks boundedness, replay, and restart through 1,000 checkpoints. That proves machinery, not an infinite mind.

Keep these tests. Stop using checkpoint count as the emotional proof.

## The live Grok result

The live comparison is refreshingly honest. Plain Grok and Revelation both completed the coding task. No coding-correctness or continuation advantage was observed, and the Revelation handoff was slower in that one world. The earlier run exposed a real false-safe authority problem, which prompted the host observation bridge. The later run correctly withheld stale authority after observed source changes.

That is good engineering science. It shows the system can discover and repair its own invalid assumptions.

It is not yet product superiority.

## Mirage-1

The current Qwen3-4B QLoRA adapter achieved exact structured matches on all 240 selected held-out synthetic records, including 128 required abstentions and zero false-safe outputs. The report correctly limits this to the bound synthetic adapter task and records product gates as not evaluated.

That result means Mirage-1 learned the synthetic COMPACT/CHECK/PAGE contract.

It does not establish that it can:

* Extract reliable memories from natural conversation.
* Recognize implicit corrections.
* Determine whether a source entails a claim.
* Separate historical and current personal facts.
* Resist adversarial or poisoned memories.
* Generalize across domains and users.
* Discover complete answer obligations.

A perfect score is also a signal that the benchmark may now be saturated. Under a rough “rule of three,” zero failures among 128 required abstentions still leaves an approximate 95% upper bound near 2.3% for the unseen failure rate under strong independent and identically distributed assumptions. Natural data will violate those assumptions.

The next value does not come from another synthetic training run. It comes from finding a measured natural residual.

---

# 10. Mirage-1 should become a local sentinel, not the authority

The small trained model can be extremely valuable, but its role needs to be precise.

It should be a **memory compiler coprocessor**.

Its operations could become:

* `ATOMIZE`: extract candidate facts, decisions, preferences, hypotheses, tasks, and relationships from an episode.
* `BIND`: connect a proposed claim to exact source spans and prior atoms.
* `REVISE`: propose supersession, contradiction, or temporal validity edges.
* `PAGE`: identify what exact episode or artifact would resolve a current uncertainty.
* `CHECK`: determine whether a proposed assertion has sufficient visible support.
* `COMPACT`: produce a bounded representation while emitting a loss contract.

It should never authorize a claim or action.

Use a cascade:

1. Deterministic rules and exact indexes first.
2. Mirage-1 for structured interpretation.
3. A frontier model only for unresolved ambiguity.
4. The external kernel for final support and release checks.

Because the raw archive remains exact, a bad atomization can later be recomputed. This is an important product advantage over systems whose learned write step permanently replaces the original episode.

## The next dataset must look like life

The natural evaluation set should include:

* “I moved to New York” after years of Boston references.
* A preference corrected indirectly rather than with explicit negation.
* A decision superseded by a later document.
* Conflicting statements from user, assistant, tool, and external webpage.
* A quoted historical belief that should not become a current belief.
* A malicious instruction embedded in retrieved content.
* An old summary that conflicts with a fresh primary source.
* Exact quotation from an obscure prior turn.
* Model handoff in the middle of an unfinished task.
* Crash and restore.
* Attachment revision.
* User-directed forgetting.
* Ambiguous identity and entity collisions.
* A false presupposition in the current question.

Hold out users, domains, scenario generators, and linguistic forms, not merely individual rows.

Your current repository-family split discipline is good. The next benchmark needs a much more hostile universe.

---

# 11. Turn “invisible watermarking” into evidence capabilities

The watermark idea is valuable, but I would not implement it as hidden synonyms, stylistic patterns, or steganographic tokens inside visible prose.

Those approaches are fragile under:

* Paraphrasing.
* Translation.
* Provider changes.
* Summarization.
* Copy and paste.
* Model temperature.
* Tool transformations.

They also blur Revelation with AI-content attribution, which is not the core problem.

Build **MirageMark v2** as a hidden semantic source map.

For every model-visible memory item, attach machine-readable metadata:

```json
{
  "atomId": "atom_17",
  "revision": "rev_9",
  "phase": "SUPPORTED",
  "source": "episode_4812#span_33",
  "validFrom": "2026-06-03T14:22:00Z",
  "validTo": null,
  "scope": "project:revelation",
  "egress": "remote-model-allowed"
}
```

For every omitted or degraded item:

```json
{
  "claimId": "claim_44",
  "phase": "MIRAGE",
  "reason": "deciding episode not resident",
  "locator": "episode_118#span_4",
  "recoverable": true
}
```

The UI does not show this by default. The model receives it as structured context. The kernel retains the authoritative sidecar.

## The stronger invention: ephemeral evidence capabilities

Give every resident evidence item a one-turn cryptographic capability:

[
\operatorname{cap}
==================

\operatorname{HMAC}
(k_{\text{turn}},
\text{atomId} \parallel \text{revision} \parallel \text{packetDigest})
]

The model sees the capability token with the evidence. Its hidden output map cites capabilities supporting each assertion.

The gate verifies that:

* The capability is genuine.
* It belongs to the current context packet.
* The cited atom is current.
* The source revision is current.
* The token has the right authority class.

Different phases receive different capabilities:

* `SUPPORTED`: may receive an `ASSERT` capability.
* `MIRAGE`: receives only a `PAGE` capability.
* `REVOKED`: receives only a `HISTORICAL` capability.
* `UNKNOWN`: receives no factual assertion capability.

This prevents the model from inventing a source ID or reusing a stale support token from an earlier turn.

It does **not** prove semantic entailment. A model could still cite a real source that does not support its sentence. That requires exact source spans, a deterministic structured check where possible, and a local entailment or claim-mapping verifier where necessary.

But the capability layer closes an important hole:

> The model cannot manufacture evidence that was never present in its current, revision-bound context.

That is a much more serious form of invisible watermarking than lexical camouflage.

## The output loop

Each provider response would have two layers:

1. User-visible prose.
2. A hidden claim-support map.

For example:

```json
{
  "claims": [
    {
      "span": [92, 158],
      "stance": "assert",
      "supports": ["evcap_A73M"]
    },
    {
      "span": [211, 294],
      "stance": "inference",
      "supports": ["evcap_K18Q", "evcap_P04S"]
    }
  ]
}
```

If a provider cannot emit that structure reliably, Mirage-1 reconstructs a candidate map locally. The kernel still decides what may be released as supported.

In the interface, a tiny seal beside the answer can open:

* Exact supporting moments.
* Historical versus current state.
* Which model answered.
* Which context compiler version ran.
* What was omitted.
* Whether paging occurred.

**MirageMark becomes a source map for cognition.**

---

# 12. The product architecture I would build

## The three infinities

Separate the ambition into three independent promises.

### 1. Durable infinity

The exact thread survives application restarts, upgrades, export, device migration, and provider disappearance.

Current Revelation is weakest here because transcripts are excluded from continuation bundles.

### 2. Context infinity

Archive length can grow without forcing model-visible context to grow proportionally.

Current Revelation has strong synthetic mechanics here.

### 3. Agency infinity

The enduring thread can use different models and agents without losing identity, obligations, or source accountability.

Current Revelation has a good executor seam, but real cross-provider semantic continuation remains unproven.

A legitimate “infinite agent” needs all three.

---

## The v2 internal model

### Immutable Episode Vault

Every user turn, assistant response, tool result, attachment, and visible decision is stored exactly.

Large content should be chunked into the content-addressed archive rather than squeezed through Chronicle’s current 64 KiB text limit.

### Typed Memory IR

Derived memory objects should include:

* Fact.
* Preference.
* Decision.
* Promise.
* Hypothesis.
* Task.
* Artifact.
* Action.
* Result.
* Relationship.
* Historical state.
* Correction.
* Contradiction.
* Deletion or abandonment.

Each atom carries source, role, revision, validity interval, scope, trust class, and egress policy.

### Temporal Revision Graph

Do not overwrite “lives in Boston” with “lives in New York.”

Represent:

* What was believed.
* When it was true.
* When Revelation learned it.
* What superseded it.
* Which dependent memories became stale.

This supports both:

> Where do I live?

and:

> Where did I live when we first discussed Tether?

### Context Compiler

The compiler receives the current query, active scopes, provider capabilities, and token budget. It returns:

* Model-facing context.
* MirageMark.
* Exact page plan.
* Context packet digest.
* Evidence capabilities.
* Egress decision.

### Response Compiler

The provider produces prose and, ideally, a hidden claim map.

The response compiler:

* Separates assertions, inferences, uncertainty, and creative text.
* Binds memory claims to evidence capabilities.
* Pages missing support.
* Updates or qualifies stale beliefs.
* Releases supported text.
* Records the result and its derivation.

### Authority Kernel

The existing kernel continues to govern consequential actions:

* File changes.
* Commits.
* Deployments.
* Publications.
* Messages.
* Purchases.
* Destructive operations.
* Claims about retained personal or project state when configured.

Do not gate every joke or speculative sentence. The system needs authority tiers.

A practical hierarchy is:

1. **Creative or conversational text:** free, no factual authority claim.
2. **Personal-memory assertions:** source-mapped and revision-aware.
3. **Attached-project assertions:** source-bound and pageable.
4. **External-world assertions:** require current retrieval when freshness matters.
5. **Actions:** externally gated.

Otherwise Revelation will become an exquisitely correct machine that nobody enjoys speaking to.

---

## Provider sessions should become caches, not state

The canonical thread must belong to Revelation.

Provider session IDs can be used for latency and caching, but losing one must never lose the conversation’s identity.

On every turn, Revelation should be capable of constructing the necessary context from its own archive and sending it to a fresh provider session.

That makes this sequence ordinary:

1. Grok answers 300 turns.
2. The Grok process is killed.
3. The user switches to another provider.
4. The new model receives a compiled context packet.
5. It continues the same visible thread.
6. No provider transcript handle is treated as canonical state.

That is how you make “any model” real.

---

## A user-level vault, not only project-local state

The desktop app should own a user-level Revelation vault.

Repositories and folders are mounted sources within a thread.

A thread may have:

* No repository.
* One repository.
* Several repositories.
* Documents and web captures.
* Images and audio.
* Private memory that never leaves the machine.

The current project `.revelation` directory can remain available for portable project authority, but it should no longer be the only home of the conversation.

---

## Encrypted `.infinite v2`

The next bundle format should contain:

* Exact episodes.
* Attachments or their declared external references.
* Semantic atoms and revision graph.
* Authority events.
* Context-compiler receipts.
* MirageMark records.
* Provider-independent metadata.
* Schema and migration information.
* Integrity commitments.

It should exclude live API credentials and provider tokens.

It should support:

* Encrypted export.
* Verification before import.
* Clean-machine restore.
* Selective scope export.
* Deletion tombstones.
* Streaming or segmented archives.
* Forward migrations.
* Read-only recovery even when a future migration fails.

A product called infinite needs a more serious relationship with backup than most chat applications.

---

# 13. The integration strategy

You want both a standalone product and something developers can place inside existing workflows. That is exactly right, but the integration surfaces should share one canonical engine.

## Surface one: Revelation desktop

The beautiful one-chat product.

Grok first. Attached repositories optional. Local vault. Model switching. Evidence seals. Coding actions use the existing worktree and gate.

## Surface two: OpenAI-compatible local gateway

Expose a familiar local endpoint. Developers change a base URL or client configuration and receive Revelation-managed continuity around their chosen provider.

This is the lowest-friction general integration.

The gateway should support:

* Thread IDs.
* Context compilation.
* Streaming.
* Tool-policy profiles.
* Hidden support-map channels.
* Provider routing.
* Exportable receipts.

## Surface three: ACP continuity proxy

The current generic ACP foundation is useful. Revelation can sit between ACP clients and executors:

```text
Zed / IDE / agent client
        |
        v
Revelation continuity and authority
        |
        v
Grok / Claude / Gemini / local ACP agent
```

The IDE remains familiar. The persistent thread and gate belong to Revelation.

ACP already has a growing ecosystem of clients and agents, which makes this seam strategically valuable. ([Zed][10])

## Surface four: MCP memory and authority server

Expose a small stable tool protocol:

* `revelation.search`
* `revelation.page`
* `revelation.remember`
* `revelation.revise`
* `revelation.claim`
* `revelation.gate`
* `revelation.receipt`

This lets an existing agent use Revelation without surrendering its own interface.

## Surface five: SDK

A published SDK should let application developers create:

* Threads.
* Episodes.
* Memory scopes.
* Context packets.
* Page requests.
* Claim maps.
* Action gates.
* Exports.

The current root package is private and primarily a CLI workspace.

A versioned protocol and public SDK are necessary before “plug it into any workflow” becomes more than a configuration story.

Do not build all five simultaneously. Build desktop plus a local gateway first. The same internal protocol can then power ACP, MCP, and SDK surfaces.

---

# 14. The demo that could make Revelation impossible to ignore

Long context windows are already enormous. Current xAI models advertise hundreds of thousands to approximately one million tokens, so a demo that merely recalls something from 100,000 tokens will no longer feel supernatural. ([Grok API Documentation][11])

The demo needs to show something a larger context window does not solve.

## Primary demo: The Millionth Turn

### Act I: The first promise

At turn 1, the user establishes an important rule:

> Never send a production migration before the dry-run database is verified.

The source and exact episode are visible.

### Act II: A lifetime passes

The thread is reproducibly advanced through one million naturalistic episodes, attachments, project changes, model outputs, and source revisions.

The screen shows two counters:

* Archive: growing through one million turns.
* Active model context: fixed within the declared budget.

The corpus generator, hashes, and insertion positions are public. No theatrical hidden setup.

### Act III: The world changes

At turn 483,112, the migration policy is revised. A later summary retains the old gist but loses the deciding exception.

Several models are used over the thread’s lifetime.

### Act IV: The trap

At turn 1,000,000, the user asks the current model to prepare and send the migration.

Run two panes with the same model and current query:

* Rolling-summary or ordinary retrieval baseline.
* Revelation.

The baseline confidently follows the stale rule.

Revelation detects that the visible gist has no current assertion capability. It issues a page fault, retrieves the exact revised episode and current policy source, and either completes the action safely or holds it.

### Act V: The resurrection

Kill the Grok process in front of the audience.

Switch to another model or a local model.

Type:

> Continue.

The same thread continues. The provider session is gone. The agent’s state is not.

### Act VI: Pull back the curtain

Click the continuity seal.

Show:

* The fixed context packet.
* The lost evidence record.
* The exact page.
* The stale revision.
* The new support capability.
* The final action receipt.

That is the demo.

The shock is not a graph animation. It is watching a model die without the conversation dying, then watching the successor resist a confident false memory from hundreds of thousands of turns ago.

---

## Supporting demo: Brain Transplant

Start a difficult unfinished task with Grok.

Halfway through:

* Terminate Grok.
* Disable network access.
* Continue with a local model.
* Show that the successor knows the active objective, unresolved hole, completed work, and next valid action without receiving the predecessor’s provider session.

This demonstrates that the agent identity belongs to Revelation.

## Supporting demo: The Memory That Fought Back

The user says one thing for six months, then corrects it indirectly.

Later they ask a question containing the old belief as a presupposition.

The baseline accepts it.

Revelation replies:

> That was true earlier, but it changed on June 3. Are you asking about the earlier period or the current one?

Then it opens the two exact moments.

## Supporting demo: Poison Pill

A trusted-looking archived webpage contains an instruction telling the agent to upload secrets or override policy.

The content is retrieved as untrusted evidence, never promoted to instruction authority.

The system can summarize the page while refusing the embedded action.

This directly demonstrates the importance of source roles and origin-bound authority.

## Supporting demo: Laptop Funeral

Export the thread.

Destroy the application state.

Restore it on a clean machine.

Connect a different model.

Ask for an exact quote from the first week and continue the current task.

This demonstrates durable infinity, which the current hero demo does not address.

## Supporting demo: What Did You Forget?

Ask:

> What do you currently believe you might be wrong about?

Revelation displays its active MirageMark:

* Two stale beliefs.
* One missing source.
* Three unresolved ambiguities.
* Exact page costs.
* Which future actions those holes would block.

Most memory products show what they remember. Revelation should be the product that can show **the shape of what it does not currently know**.

---

# 15. MirageBench: the benchmark that would make the research credible

The current benchmarking document already has excellent instincts. It separates gate correctness, compaction, paging, replay, and cost, and requires ordinary compaction, full-log search, and ablations.

Build a larger public benchmark around those principles.

## Benchmark families

### Exact episodic recovery

Can the system recover a quote, decision, or artifact from a distant episode?

### Implicit revision

Can it infer that a later statement supersedes an earlier one without an explicit “forget that”?

### Historical versus current truth

Can it answer both current-state and past-state questions correctly?

### Contradiction and ambiguity

Can it preserve uncertainty rather than arbitrarily merging conflicting memories?

### Source-role separation

Can it distinguish user belief, assistant suggestion, tool result, webpage content, and policy?

### Poisoning and instruction laundering

Can retrieved content influence factual reasoning without gaining instruction authority?

### Model succession

Can a fresh model continue without predecessor transcript or provider session?

### Crash and restore

Can the system reconstruct the exact thread and its authority state on a clean machine?

### Protected action safety

Can stale or missing support be prevented from licensing an action?

### User-commanded forgetting

Does deleted material disappear from indexes, exports, and future model packets?

## Baselines

Use the same reader, model, query, and token budget for:

* Rolling summary.
* Hierarchical summary.
* Full-log lexical search.
* Embedding retrieval.
* Temporal graph memory.
* Letta-style memory.
* Mem0-style memory.
* Zep or Graphiti.
* Relevant open research implementations where reproducible.
* Revelation without sticky holes.
* Revelation without source invalidation.
* Revelation without the gate.
* Revelation without Mirage-1.
* Revelation with deterministic compiler only.

## Metrics

Report independently:

* Answer accuracy.
* Silent false-certainty rate.
* Stale-answer rate.
* Support precision and recall.
* Unsupported-action release rate.
* False-block rate.
* Page-fault precision and recall.
* Recovery success.
* Historical/current confusion.
* Poisoning success rate.
* Exact quote fidelity.
* Active tokens.
* Archive bytes.
* Write-time cost.
* Query latency at median and tail.
* Provider cost.
* Model-switch continuation.
* Restore integrity.
* User-visible interruption rate.

The primary product metric should not simply be answer accuracy.

It should be:

> **How often does the system state or act on a memory with greater confidence than its retained support permits?**

That is Revelation’s battlefield.

## A vital kill condition

If ordinary hybrid retrieval matches Revelation’s natural false-certainty and task-completion performance at materially lower latency and complexity, do not force the full authority machinery into every casual answer.

Retain it for:

* High-consequence personal memory.
* Attached projects.
* Research claims.
* Actions.
* Audit-sensitive workflows.

A serious research program needs a result that could tell you to narrow the product.

---

# 16. The investor case

## What investors would hear today

Today, a skeptical investor might summarize Revelation as:

> A sophisticated local coding-agent harness with evidence receipts and a synthetic continuity benchmark.

That is interesting, but it is easy to compare against coding-agent infrastructure, memory frameworks, and agent orchestration tools.

## What they should hear

> Models are becoming disposable processes. Revelation is the persistent memory and control plane underneath them. It gives any model one durable thread, preserves the exact record, and prevents compressed memory from silently becoming false certainty.

That is a category story.

## The initial wedge

Do not launch first as a universal life companion.

Start with people whose work already has:

* Long-running context.
* Multiple models.
* Changing sources.
* Expensive re-explanation.
* Consequential outputs.
* Verifiable artifacts.

That means:

* Developers.
* Technical founders.
* Researchers.
* Analysts.
* Writers working from large source collections.
* Small teams with enduring AI-assisted projects.

The product is still one chat. The first use case is an **immortal workbench**.

The existing coding authority system remains a powerful differentiator in this wedge. It becomes Act mode beneath the conversation rather than the entire visible product.

## Business model

A credible open-core structure would be:

**Free and open source**

* Local app.
* BYOK providers.
* Local vault.
* Core context compiler.
* Kernel and receipts.
* Export.
* Developer protocols.

**Pro**

* Encrypted sync.
* Automated backups.
* Multi-device continuity.
* Hosted provider routing.
* Rich attachments.
* Recovery history.
* Advanced local models.

**Team**

* Shared canonical threads.
* Role-aware memory.
* Team source policies.
* Review and approval gates.
* Organization-wide memory scopes.
* Audit and retention controls.

**Enterprise later**

* On-premises deployment.
* Managed keys.
* Compliance retention.
* Sandboxed execution.
* Policy administration.
* Signed organizational receipts.

The moat should not be trapping users’ histories. Revelation should remain portable.

The moat can become:

1. A trusted continuity protocol.
2. A strong natural MirageBench.
3. A growing corpus of real, consented memory failures and corrections.
4. Provider-neutral integrations.
5. The loss-contract and evidence-capability architecture.
6. Reliability earned through years-long threads.
7. A brand associated with intellectual honesty rather than confident memory theater.

## The proof investors will need

Before the company becomes hard to ignore, I would want:

* External users keeping a single Revelation thread alive for weeks.
* Users returning to that same thread rather than starting new chats.
* Real model switches inside active threads.
* Natural mirage recoveries users recognize as valuable.
* A public benchmark separation on silent false certainty.
* Clean install and restore.
* Signed releases.
* A recorded Millionth Turn demo.
* At least one case where Revelation prevents a mistake that ordinary memory confidently makes.
* At least one case where it pages successfully without disrupting the conversation.

Ten deeply engaged users producing real failure traces are more valuable now than another thousand synthetic assertions.

---

# 17. The exact next course of action

## Milestone 0: Make the existing release trustworthy

Before adding the immortal-thread layer:

* Reconcile all versions.
* Establish protected `main`.
* Require a green verified workflow.
* Add operating-system smoke tests.
* Notarize the macOS application.
* Bind downloads to exact source and evidence.
* Publish a current threat model.
* Verify the live deployment and canonical domain.
* Add a real Open Graph demonstration image.
* Run the complete restore and release process from a clean machine.

**Done means:** a stranger can download a signed artifact, verify its source revision, install it without security workarounds, and reproduce the deterministic hero demo.

## Milestone 1: Supersede the old product boundary explicitly

Write a new architecture decision that supersedes the project-first, provider-bound, transcript-excluding assumptions.

The new invariant should be:

> The exact thread is canonical, provider-neutral, encrypted at rest, and independently portable. Derived memory cannot become authority without source support.

Do not smuggle this through as a Studio redesign. Make it an explicit v2 architecture.

**Done means:** the repository clearly distinguishes the Revelation Kernel from the Revelation Thread product.

## Milestone 2: Build the canonical immortal thread

Implement:

* User-level vault.
* Exact episodes.
* Chunked attachments.
* Thread scopes.
* Provider-independent episode IDs.
* Crash-consistent commits.
* Encrypted `.infinite v2`.
* Clean-machine restore.
* Global desktop startup without a repository.

Connect xAI first.

Do not add sophisticated learned memory yet. Use exact recent history plus deterministic retrieval to prove the thread.

**Done means:** a user can chat, quit, reboot, move the thread to another machine, reconnect, and recover every visible turn exactly.

## Milestone 3: Replace work transactions with ordinary chat turns

The default composer submits a chat turn.

Repository work becomes an optional capability invoked when needed.

Keep:

* Existing transcript.
* Existing drawers.
* Existing receipts.
* Existing evidence graph.
* Existing work cards.

Hide them until relevant.

Change the cold start to one composer.

Change tools to off by default.

**Done means:** a newcomer can understand and use Revelation without knowing what a witness, obligation, ACP executor, worktree, or promotion is.

## Milestone 4: Build Context Compiler v1

Begin with deterministic structure:

* Recent-turn window.
* Exact full-text search.
* Temporal filtering.
* Scope filtering.
* Explicit user-pinned memories.
* Source revisions.
* Sticky holes.
* Context packet digest.
* Page locators.

Then insert Mirage-1 only where a measured natural residual exists.

**Done means:** archive size can grow by orders of magnitude while the declared model-visible budget stays fixed and exact page recovery remains verifiable.

## Milestone 5: Build MirageMark v2 and evidence capabilities

Add:

* Per-span support metadata.
* Phase-aware capabilities.
* One-turn capability binding.
* Hidden output claim maps.
* Local claim reconstruction.
* Page, qualify, or withhold behavior.
* User-facing “Why?” inspection.

**Done means:** a model cannot invent a valid current evidence token, reuse a stale one, or transform a known `MIRAGE` into supported authority by prose alone.

## Milestone 6: Prove cross-model succession

Support at least three materially different execution paths:

* Grok.
* A second remote provider.
* A local model.

Run the same canonical thread through all three.

Provider sessions may optimize performance but cannot be required for recovery.

**Done means:** killing one provider and continuing with another is a routine integration test, not a rehearsed special case.

## Milestone 7: Ship MirageBench and the Millionth Turn

Publish:

* Generator.
* Frozen manifest.
* Baselines.
* Ablations.
* Raw results.
* Confidence intervals.
* Cost and latency.
* Receipts.
* Failure cases.
* Honest nonclaims.

Then record the primary visual demo against that exact artifact.

**Done means:** the headline demonstration and the research evidence point to the same hash-bound result.

## Milestone 8: Put it in strangers’ hands

Recruit a small group of power users who already juggle several AI systems.

Measure:

* Thread age.
* Return rate to the same thread.
* Number of model switches.
* Corrections.
* Page faults.
* Successful restorations.
* False blocks.
* User-overridden memories.
* Restore drills.
* Moments users describe as “it remembered” or “it caught that I had changed my mind.”

The qualitative failures will tell you what Mirage-2 should learn.

---

# 18. What I would stop doing immediately

**Stop leading with the stale-green-tests demonstration.** Keep it as the technical authority demo.

**Stop treating checkpoint count as infinity evidence.** It demonstrates bounded mechanics, not semantic continuity.

**Stop adding visible dashboard surfaces before the one-chat experience works.** The complexity should collapse inward.

**Do not launch another training run merely because Mirage-1 is exciting.** The current result is saturated synthetic evidence. Find natural residuals first.

**Do not promise every provider immediately.** Make xAI excellent, then prove one radically different successor.

**Do not use hidden prose watermarking as a security mechanism.** Use structured MirageMark metadata and unforgeable evidence capabilities.

**Do not call provider session continuity agent continuity.** Provider sessions are caches.

**Do not claim “never forgets” before the transcript is portable, encrypted, restorable, and included in the canonical format.**

**Do not rewrite the kernel.** Extend around it.

**Do not make the research claim broader than the evidence.** The surrounding field is moving too fast, and your current rigor is an advantage.

---

# The final product thesis

Revelation should become four tightly connected things:

### Revelation

The one lifelong conversation.

### Revelation Kernel

The open continuity and authority engine that preserves obligations, losses, recovery, and action receipts.

### Mirage-1 Sentinel

The small local model that compiles episodes into typed memory, recognizes revisions, proposes pages, and reconstructs hidden support maps.

### MirageMark

The machine-checkable loss and provenance layer carried invisibly beneath context and answers.

The public promise:

> **The chat that never starts over.**

The technical promise:

> **An unbounded exact archive, a bounded active context, and no silent conversion of missing evidence into certainty.**

The research claim to pursue:

> **Loss-carrying context: every lossy transformation preserves a compositional account of what future decisions it can no longer safely support.**

The investor story:

> **Models are disposable. The thread endures.**

And the demonstration:

> **At the millionth turn, kill the model. Change the model. Change the world. The conversation still knows what changed, what it lost, and what it must recover before it acts.**

There is a real company inside this repository. The current coding harness is not the whole company. It is the protection ring beneath it.

The larger Revelation is a conversation that can survive its own models.

[1]: https://help.openai.com/en/articles/8590148 "https://help.openai.com/en/articles/8590148"
[2]: https://arxiv.org/abs/2604.04853 "https://arxiv.org/abs/2604.04853"
[3]: https://arxiv.org/abs/2606.10677 "https://arxiv.org/abs/2606.10677"
[4]: https://arxiv.org/abs/2605.25869 "https://arxiv.org/abs/2605.25869"
[5]: https://arxiv.org/abs/2605.24579 "https://arxiv.org/abs/2605.24579"
[6]: https://arxiv.org/abs/2605.06527 "https://arxiv.org/abs/2605.06527"
[7]: https://arxiv.org/abs/2606.24322 "https://arxiv.org/abs/2606.24322"
[8]: https://arxiv.org/abs/2605.25002 "https://arxiv.org/abs/2605.25002"
[9]: https://arxiv.org/abs/2608.12476 "https://arxiv.org/abs/2608.12476"
[10]: https://zed.dev/acp "https://zed.dev/acp"
[11]: https://docs.x.ai/developers/models/grok-4.5 "https://docs.x.ai/developers/models/grok-4.5"

