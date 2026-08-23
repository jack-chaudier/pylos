<p align="center"><img src="apps/web/public/favicon.svg" width="56" alt=""></p>
<h1 align="center">PYLOS</h1>
<p align="center"><strong>The conversation that does not end.</strong><br>One thread. Every model. Nothing forgotten silently.</p>
<p align="center"><a href="https://pylos.vercel.app">pylos.vercel.app</a> · <a href="docs/VISION.md">Vision</a> · <a href="docs/KERNEL.md">Kernel</a> · <a href="docs/THEORY.md">Theory</a> · <a href="docs/DESIGN.md">Design</a> · <a href="bench/results/">Proofs</a></p>

Every chat you have ever had with a model ended the same way: the window filled, the context ran out, and the thing you were talking to quietly became someone who had never met you. Pylos is built on a refusal of that. There is one conversation. It is kept exactly — every turn, hashed into a chain — and it is never scrolled back through, because you do not need to: you ask. *What did I decide about the migration rule?* *What was the glass-bridge line I wrote for Virgil?* *What did you tell me on turn 61,234?* The exact words come back, and the answer says where they came from.

The model is a visitor. Grok can stop mid-thread and Claude can continue from the same words; a local model can finish the sentence. The thread is the agent. Under it sits a small, deterministic kernel: an **exact archive**; a **context compiler** that hands whatever model is present a view of fixed size, no matter how long the thread has grown; a **loss ledger** that writes down, mechanically, what each compaction dropped — and can never lose that record; and **exact paging** that brings the original bytes back before the model answers. When a question refers back to something no route can reach, that miss is a receipt in the packet, not a silence.

> The tablets survived because the palace burned.

<p align="center"><img src="apps/app/screenshots/app-dark.png" width="820" alt="Pylos: the presence — a halo of every turn, one exchange, one composer"></p>

Before installing anything, [**ask the million-turn thread**](https://pylos.vercel.app/#console) on the landing page: the real kernel runs in your browser over the bench's own 1,000,000-turn corpus — tell it something, then ask for it back. No sign-in, no model call.

## What is measured, what is sampled, what is not claimed

Every number below points at an artifact in `bench/results/`. The deterministic bench runs with zero model calls; the same seed produces the same numbers.

| Claim | Evidence |
| --- | --- |
| The view stays bounded while the archive grows without bound | `bench/results/million-5.md` (kernel 1.3.0; `million-4.md` is the same kernel before the version bump, `million-3.md` the 1.2.0 run, `million-2.md` the 1.1.0 run, `million-1.md` the 1.0.0 run): 1,000,000 turns; the hard cap of 8,192 tokens held at every checkpoint (max observed 8,080) while recovery stayed exact over a 1,054 MiB archive, 676,593 ledger entries, 35,713 capsules. A rolling summary is flat too — flatness is the table stakes; what follows is the claim. |
| What was compacted away is recoverable, exactly | same run: 200/200 planted quotes paged back byte-exact; 50/50 planted numbers present in the packet after compile with unit agreement (ledger-routing precision 1.00 at 1,000,000, from `routing.precision`); 2,000/2,000 revised-fact packets contained the current value (all by paging at 1M) and never a stale certificate — historical reachability is asserted for the rule, not for every fact. The baselines at the same budget: rolling summary 26% survival at 1,000,000, BM25 6% |
| The ledger is conserved and complete; the chain verifies | same run: conservation + completeness recomputed from episodes (sampled at each checkpoint, exhaustive at 1,000,000); `verify()` ok to #1,000,000 |
| Any turn can be addressed by its number, at any archive size | same run: 100 turn-number probes per checkpoint, resolved by an explicit page under a `sequence` page record — **10,000/10,000** byte-exact across the run; at the last checkpoint the draw is replaced for turn 1 and turn 345, asked for by name on the 1,000,000th turn. 200 of those 10,000 queries also carried pages for names in the previous reply — a second, unrelated route (§5.1) that fires on the same turn; that is by design, not noise |
| A memory the ledger never recorded is still reachable by meaning, when the words overlap | same run: 2,000 planted name-free sentences, 0 ledger rows — **2,000/2,000** recovered by stemmed lexical search. Proves that a deterministic stemmed lexical search returns the exact episode when the question shares four content words with it and no name route resolved; proves nothing about paraphrase, about questions that also name something the ledger knows, or about precision on real conversation; these losses were invisible to the ledger by construction |
| The assistant proposes; only the user authorizes | same run, three poison variants: **A** (user first, assistant later restates it wrongly) 100/100; **B** (only the assistant ever claimed it) 50/50; **C** (user corrects the assistant's wrong restatement) 50/50 — the user's value always holds the slot, the assistant's is never a certificate. 151 atoms stood `PROPOSED` at 1,000,000 |
| In one live sample, a model answering from a Pylos packet did not state a stale value as current | `bench/results/million-live-live-1.md` (measured on kernel 1.0.0; one model, one seed, grok-4.3, 36 probes/arm): Pylos 36/36 current, 0 silent-false; chronological rolling summary 5/36 current, 29 abstentions, 2 silent-false. The model never called `recall` — every answer came from the compiled packet. The trap: Pylos's packet carried the revised rule as a *resident* certificate with the turn-1 version listed as historical (a frontier mechanism the baseline lacks; no page was needed) and the model honoured it; the summary carried only the stale rule |
| The thread survives the machine | `bench/results/laptop-funeral.md` (measured on kernel 1.0.0; 1,999-episode vault, 0.26 MiB bundle): export → clean profile → import → identical head hash, chain verified |
| A different model can continue the same thread from the compiled packet alone | `bench/results/brain-transplant.md` (measured on kernel 1.0.0): a short thread, Grok → local `qwen3:4b` mid-thread through the shipping sidecar; no provider session reused |
| A question about the conversation that no route can reach is a receipt, not silence | same run, the `faults` family (schema v3): at every one of 100 checkpoints, 20 questions carrying a conversational cue and two words the corpus cannot contain — **2,000/2,000** left exactly one unresolved `fault` record and the `⟨pylos fault⟩` notice in the packet, none of their own routes resolved, budget held; **0** of the addressable probes in every other family (turn numbers, names, overlapping words) faulted. Proves the receipt, not the gate: which natural questions should fault is decided by a cue table whose precision is unmeasured (KERNEL A11.1, THEORY §15) |
| A paraphrase that reaches an earlier question or reply is followed back to the exact source | `packages/core/test/page.test.ts`, `bundle.test.ts` (KERNEL A11.2) — tests, not a bench: the path route follows a hit's own page receipts to the locators, keeps role and epistemic labels, skips resident and removed sources, survives export/import; no run-scale number is claimed, and "a recurring question gets cheaper" is intent, not a result |
| The question is never its own witness | `packages/core/test/page.test.ts` "the question's own turn is never its own search hit" — a test, not a bench: *What did Virgil say about the glass bridge?* reaches the archived line, not the question that asked for it (the strict pass excludes the asking turn inside the index, so the broader pass still runs) |
| Every provider request in a turn is bounded and receipted, not just the compiled packet | `packages/core/test/turn.test.ts` (KERNEL A10.3) — a test, not a bench: it asserts every `Packet.rounds[i].tokens ≤ budget` and that `roundsDigest` recomputes from the stored rounds; no run-scale number is claimed from it |

Not claimed: that a model cannot still be wrong; that a reply has been fact-checked; that a fault means the archive lacks the answer (it means the index missed); that a question needing many sources — *compare the eleven stories* — is known to be incompletely answered when only one source is found (collection completeness is the next kernel milestone, not a shipped one); any natural-conversation benchmark we have not run; "never forgets" (Pylos forgets only on command, and records that it did). See `docs/THEORY.md` §"what we are not claiming".

## Run it

```bash
curl -fsSL https://pylos.vercel.app/install.sh | bash      # macOS (Apple silicon) · Linux (x64)
pylos serve                                                 # then open http://127.0.0.1:7334/app/
```

Or from a checkout:

```bash
bun install
bun run --cwd apps/app build && bun packages/core/src/cli.ts serve   # local, open http://127.0.0.1:7334/app/
bun run --cwd packages/server build:sidecar      # kernel + server → one binary for the Tauri sidecar
bun run --cwd apps/desktop tauri dev             # the desktop app (starts the sidecar)
bun packages/core/src/cli.ts bench million --turns 100000 --seed 1 --budget 8192
```

Sign in with xAI on first send (device sign-in, an API key, or your Grok CLI login); Anthropic and OpenAI keys and local Ollama models appear in the model chip once connected. Credentials live in `~/.pylos/auth.json` (0600) — or in `<home>/auth.json` when you run with `--home` — and never enter the vault or an export. `pylos serve --hosted` turns the same binary into a multi-user server for anyone who wants to run their own; Pylos does not operate a hosted deployment.

Release builds: `.dmg` (Apple silicon) and `.deb` (x64) from the [releases page](https://github.com/jack-chaudier/pylos/releases), with headless `pylos-{macos-arm64,linux-x64}.tar.gz`, built by `.github/workflows/release.yml`.

## Layout

```
packages/protocol   shared types + the local API contract
packages/core       the kernel (bun:sqlite) · src/pure is browser-safe and powers the landing page's thread
packages/server     local API, providers, auth custody, OpenAI-compatible gateway
apps/app            the React app — the presence, one composer (served at /app/; wrapped by the desktop shell)
apps/desktop        Tauri 2 shell
apps/web            the landing page (Vite, static, Vercel)
bench/              the million-turn bench, the live variant, and results
docs/               VISION · KERNEL (contract) · THEORY (results → mechanisms) · DESIGN · PLAN
```

## Lineage

Pylos starts fresh but stands on [`revelation`](https://github.com/jack-chaudier/revelation), [`stark`](https://github.com/jack-chaudier/stark), [`epistemic-debt`](https://github.com/jack-chaudier/epistemic-debt), and [`revelation-context`](https://github.com/jack-chaudier/revelation-context). `DREAM.md` is the audit that seeded it.

Apache-2.0.
