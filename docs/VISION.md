# Pylos — the forever chat

> One conversation. Every model. Nothing forgotten silently.

Pylos is local-first: install it, run `pylos serve`, and the app opens at
`http://127.0.0.1:7334/app/` on your own machine, with your thread in your
own vault. The same React app is wrapped by a desktop shell (Tauri, macOS +
Linux) for the same local experience without a terminal. `--hosted` is a
trusted, operator-managed self-hosting mode; its operator supplies filesystem
quotas and free-space monitoring, and it is not a public multi-tenant safety
claim. Pylos itself does not operate one. Every surface is one text box, one
scrolling conversation, an attachment control, and a small model switch. That
is the whole visible product. The invisible product is the reason the
conversation never has to end.

Before any of that, the landing page carries a demo that needs no install: a
console running the real, browser-safe half of the kernel over the bench's
own 1,000,000-turn corpus, in the tab, with no model call. See
`docs/DESIGN.md` §"the landing page".

## Why the name

In 1939 the palace of Pylos burned. The fire that destroyed the palace baked
its clay administrative tablets — the Linear B archive — and so the records
outlived the civilization that wrote them by three thousand years. The palace
was temporary. The archive was not.

In Pylos-the-app, **the model is the palace and the thread is the archive.**
Models are temporary cognition; they get upgraded, killed, swapped, rate
limited, deprecated. The conversation is the enduring entity. *The thread is
the agent.* (Pylos is also, conveniently, Greek for gate — πύλη — and a gate is
what stands between a bounded model view and an unbounded archive.)

## The problem with every chat you have ever had

Every chat interface eventually does one of three things:

1. **Stops.** "This conversation is too long. Start a new chat."
2. **Lies.** It rolls history into a summary and the model answers from the
   summary with the confidence it had when it could see the source.
3. **Cheats.** It quietly drops the middle and hopes you don't ask about it.

The second failure is the interesting one, and it is the one this program's
mathematics is about. Under compression, **answers outlive their
justifications**: a system can keep producing correct-looking verdicts long
after it has lost the reason for them (the *mirage shelf*, `stark`), a
downstream reader cannot recover what the compactor destroyed (*debt is
artifact-borne*, `epistemic-debt` row 10), and a smarter reader cannot repair a
cheap compactor (row 13). Summaries do not merely lose detail. They launder
uncertainty into confidence.

## The idea Pylos is built on

> **A lossy context transformation must never be allowed to hide what it lost.**

Pylos keeps the **exact, append-only, hash-chained archive** of every turn and
compiles a **bounded view** for the current model on every turn. Every
compaction step emits a **loss ledger** — a deterministic, machine-checkable
record of the names, values, quotes and decisions that the compacted text no
longer contains, each with an exact locator back into the archive. Ledgers are
*conserved*: further compaction may add to them but can never erase an entry
except by explicit resolution. When a question touches something in the
ledger, the kernel **pages the exact material back** before the model answers
(`epistemic-debt` row 21: deterministic loss-ledger routing, recall 1.00). When
it cannot, the model is told so, rather than being allowed to improvise.

The result is the honest form of "infinite chat":

> The archive grows without bound. The active context stays fixed. The active
> **semantic frontier** — what is needed to support current obligations plus
> exact locators for everything omitted — stays bounded or cheaply pageable.
> (`revelation-context`: 1,000 → 1,000,000 events with invariant resident
> context at fixed frontier.)

Pylos never promises to never compact. It promises to **never destructively
compact the source of truth, and never let the view forget what it forgot.**

## Three infinities (what v1 actually ships)

| Promise | Meaning | v1 proof |
| --- | --- | --- |
| **Durable infinity** | The exact thread survives restart, upgrade, export, machine migration, provider death. | `pylos export` → destroy state → `pylos import` on a clean profile → identical hash chain, continue with a different model ("Laptop Funeral"). |
| **Context infinity** | Archive length can grow by orders of magnitude while the model-visible budget stays fixed and recovery stays exact. | `pylos bench million`: one million deterministic turns, resident packet ≤ budget at every checkpoint, every paged loss resolves to exact spans, zero ledger entries lost ("The Millionth Turn"). |
| **Agency infinity** | Any model can continue the same thread from a compiled packet; provider sessions are caches, never state. | Mid-thread switch Grok → Claude → local (Ollama) with a visible handoff divider and no loss of frontier ("Brain Transplant"). |

The v1 proof rows above remain historical evidence. The v2.0.0 contract extends
the kernel's custody boundary rather than changing those claims: every retained
byte receives a mechanical state or an opaque receipt; collection questions
carry lower-bound coverage; remembered claims need a current witness or a
visible qualification; and grounded query routes can be invalidated explicitly.
The optional semantic runtime proposes addresses only, with pinned resources and
fail-closed startup. [`natural.md`](../bench/results/natural.md) + `natural.json`
(digest `cd86341177409aaebe090757920cf4d9866aa5ea266e058e69b331a324589202`) are an
authored-fixture safety measurement: 13 probes, no safety-oracle violations,
semantic receipt availability 13/13, model calls 0 — not recall, precision, or
provider efficacy.
The compile-only bench marks the `sqlite-vec` runtime mechanism
implemented:yes/tested:no — the runtime exists in-tree with kernel tests, but
this bench invokes no semantic runtime directly; a separate local arm64 macOS compiled-C
preflight passed one runtime/KNN smoke path. The million-turn
[`funeral-6.md`](../bench/results/funeral-6.md) + `funeral-6.json` artifacts
verify episode/atom/capsule/loss/table transport, exact restore, and exact
paging; the synthetic funeral had zero packet, answer, coverage, address, and
alias rows, so it does not establish nonempty Phase 2/4 receipt survival or an
RSS bound.

## What the user sees

* An empty, calm conversation. One composer. A tiny model indicator. An
  attachment button. A quiet **evidence bar** in the corner: `archive 12,408
  turns · view 23.1k / 24k · 2 recovered`.
* When the kernel pages something back: a single quiet line above the answer —
  *Recovered two earlier moments before answering.*
* When a draft states something the view did not contain and the archive is
  re-read to check it: *↺ reopened the archive · names.* If the re-check
  itself could not run, the line says so instead — *archive could not be
  re-read · names — unverified* — the draft stands, but the gap is not hidden.
* When a belief has changed: *That was true earlier, but it changed on turn
  4,812.* with both moments one click away.
* When a fault was handled by the model's own search: *↺ page fault ·
  recovered one earlier moment · recall.* A question the index cannot reach is
  told to the model, never guessed. A path recovery — the archive answering
  through the turn that once answered the same question — reads *↺ recovered
  one earlier moment · by way of turn 61,234.*
* When the model changes: a hairline divider — *Grok stopped here. Claude
  continued from the same thread.*
* Click the evidence bar → the **X-ray**: the exact packet the model saw, the
  ledger, what was paged and why, the hash of the archive head.
* On an empty local thread, **Open the proof thread** starts a deterministic
  scripted tour. Five receipt-backed moments show a corrected fact, an
  incomplete collection, an invalidated route, an exact attachment tail, and
  the final memory gate. It is a product demo; the receipts, not a model's
  reassurance, supply the figures.

Everything else collapses inward. No dashboards. No vocabulary.

## What v1 deliberately is not

* Not a vector database wearing a chat UI.
* Not a semantic authority. The optional local vector route proposes an exact
  address; it cannot create a fact, certificate, atom, or active route without
  the ordinary kernel witnesses and gate.
* Not a coding agent. Attachments are evidence, not a workspace.
* Not a claim that a model cannot still be wrong. Pylos bounds *silent*
  false certainty from lost context; it does not police entailment.
* Not a promise that nothing can be deleted. Pylos forgets only under explicit
  user command, and records that it did.
* Not a fact-checker. The verification round pages the archive and gives the
  model one more try only for names the ledger already recorded as dropped;
  it does not check a reply against the world.
* Not a claim that a fault is evidence of absence. When Pylos cannot address a
  question against its index, it says the index missed — not that the archive
  lacks the answer.
* Not a natural-language efficacy result. The frozen natural-question artifact
  is authored fixture-safety evidence with most families single-denominator and
  only two matched-pair families; it does not estimate recall, precision,
  ranking, multilingual quality, graph reuse, or provider efficacy. Its
  compile-only semantic runtime row is implemented:yes/tested:no, since the
  runtime exists in-tree with kernel tests but this bench invokes no semantic
  runtime directly; receipt availability is not proof of semantic efficacy. The proof thread is a scripted
  demonstration. The v2 stream path has a million-turn transport/restore
  result, but its synthetic funeral has empty Phase 2/4 receipt sets and RSS
  snapshots are not bounds.

## Lineage

Pylos starts fresh but stands on `revelation` (kernel discipline, sticky
MIRAGE/UNKNOWN states, receipts), `stark` (the mirage shelf; witness vs answer
quotients), `epistemic-debt` (artifact-borne debt; fusion contract; ledger
routing; capacity bound `b + t·w ≥ log2(N−F−E)`), and `revelation-context`
(frontier-invariant resident context over 1M events; proof-carrying context).
See `docs/THEORY.md` for the exact mapping from results to mechanisms.
