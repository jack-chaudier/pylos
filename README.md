<p align="center"><img src="apps/web/public/favicon.svg" width="56" alt=""></p>
<h1 align="center">Pylos</h1>
<p align="center"><strong>The forever chat.</strong> One conversation. Every model. Nothing forgotten silently.</p>
<p align="center"><a href="https://pylos.vercel.app">pylos.vercel.app</a> · <a href="docs/VISION.md">Vision</a> · <a href="docs/KERNEL.md">Kernel</a> · <a href="docs/THEORY.md">Theory</a> · <a href="docs/DESIGN.md">Design</a> · <a href="bench/results/">Proofs</a></p>

Pylos is a desktop chat app (macOS, Linux) with a single text box and a single conversation that does not end. Underneath it: an exact, hash-chained archive of every turn; a context compiler that hands the current model a **fixed-budget view**; a **loss ledger** that records, deterministically, what each compaction step dropped and never lets that record disappear; and **exact paging** that brings the original material back before the model answers. Models are temporary cognition. The thread is the agent.

> The tablets survived because the palace burned.

## What is proven (and what is not)

| Claim | Evidence |
| --- | --- |
| The view stays bounded while the archive grows without bound | `bench/results/million-1.md`: 1,000,000 turns, packet never above 8,192 tokens (max 7,998), residency slope ≈ 0 tokens per decade |
| What was compacted away is recoverable, exactly | same run: 200/200 planted quotes paged back byte-exact, 50/50 numbers routed by the ledger, 2,000/2,000 revised facts answered from the current value with the old value kept as historical |
| The ledger is conserved and complete; the chain verifies | same run: conservation + completeness recomputed from episodes at every checkpoint; `verify()` ok to #1,000,000 |
| A model answering from a Pylos packet is less likely to state a stale value as current | `bench/results/million-live-live-1.md` (a live **sample**, grok-4.3, 36 probes/arm): Pylos 36/36 current, 0 silent-false; rolling summary 5/36 current, 29 abstentions, 2 silent-false; the trap: Pylos honours the revised rule, the summary follows the stale one |
| The thread survives the machine | `bench/results/laptop-funeral.md`: export → clean profile → import → identical head hash, chain verified |
| Any model can continue the same thread | `bench/results/brain-transplant.md`: Grok → local `qwen3:4b` mid-thread through the shipping sidecar |

Not claimed: that a model cannot still be wrong; any natural-conversation benchmark we have not run; "never forgets" (Pylos forgets only on command, and records that it did). See `docs/THEORY.md` §"what we are not claiming".

## Run it

```bash
bun install
bun run --cwd packages/server build:sidecar      # kernel + server → one binary for the Tauri sidecar
bun run --cwd apps/desktop tauri dev             # the app (starts the sidecar; first Rust build takes a while)
# or headless:
bun packages/core/src/cli.ts serve               # local API on 127.0.0.1:7334
bun packages/core/src/cli.ts bench million --turns 100000 --seed 1 --budget 8192
```

Connect xAI on first send (API key, device sign-in, or import your Grok CLI login); Anthropic / OpenAI keys and local Ollama models appear in the model chip. Credentials live in `~/.pylos/auth.json` (0600) and never enter the vault or an export.

Release builds: `.dmg` (Apple Silicon) and `.AppImage`/`.deb` from the [releases page](https://github.com/jack-chaudier/pylos/releases), built by `.github/workflows/release.yml`.

## Layout

```
packages/protocol   shared types + the local API contract
packages/core       the kernel (bun:sqlite) · src/pure is browser-safe and powers the landing page's aperture
packages/server     local API, providers, auth custody, OpenAI-compatible gateway
apps/desktop        Tauri 2 + React (the one-composer app)
apps/web            the landing page (Vite, static, Vercel)
bench/              the million-turn bench, the live variant, and results
docs/               VISION · KERNEL (contract) · THEORY (results → mechanisms) · DESIGN · PLAN
```

## Lineage

Pylos starts fresh but stands on [`revelation`](https://github.com/jack-chaudier/revelation), [`stark`](https://github.com/jack-chaudier/stark), [`epistemic-debt`](https://github.com/jack-chaudier/epistemic-debt), and [`revelation-context`](https://github.com/jack-chaudier/revelation-context). `DREAM.md` is the audit that seeded it.

Apache-2.0.
