<p align="center"><img src="apps/web/public/favicon.svg" width="56" alt=""></p>
<h1 align="center">Pylos</h1>
<p align="center"><strong>The forever chat.</strong> One conversation. Every model. Nothing forgotten silently.</p>
<p align="center"><a href="https://pylos.vercel.app">pylos.vercel.app</a> · <a href="docs/VISION.md">Vision</a> · <a href="docs/KERNEL.md">Kernel</a> · <a href="docs/THEORY.md">Theory</a> · <a href="docs/DESIGN.md">Design</a> · <a href="bench/results/">Proofs</a></p>

Pylos is a chat app with a single text box and a single conversation that does not end. It ships three ways: a hosted web app (sign in with your xAI account; your thread lives in your own vault on the server), a local-first desktop app (macOS, Linux), and a headless `pylos serve` — all three share the same kernel and the same `.pylos` bundle. Underneath it: an exact, hash-chained archive of every turn; a context compiler that hands the current model a **fixed-budget view**; a **loss ledger** that records, deterministically, what each compaction step dropped and never lets that record disappear; and **exact paging** that brings the original material back before the model answers. Models are temporary cognition. The thread is the agent.

> The tablets survived because the palace burned.

<p align="center"><img src="apps/app/screenshots/app-dark.png" width="820" alt="Pylos: one composer, the evidence bar, the timeline rail"></p>

## What is measured (deterministic), what is sampled (live) — and what is not

| Claim | Evidence |
| --- | --- |
| The view stays bounded while the archive grows without bound | `bench/results/million-1.md`: 1,000,000 turns; the hard cap of 8,192 tokens held at every checkpoint (max observed 8,062) while recovery stayed exact over a 1,063 MiB archive |
| What was compacted away is recoverable, exactly | same run: 200/200 planted quotes paged back byte-exact; 50/50 planted numbers present in the packet after compile (ledger-routing precision 1.00 on the 100-query sample); 2,000/2,000 revised-fact packets contained the current value (all by paging at 1M) and never a stale certificate — historical reachability is asserted for the rule, not for every fact |
| The ledger is conserved and complete; the chain verifies | same run: conservation + completeness recomputed from episodes (sampled at each checkpoint, exhaustive at 1,000,000); `verify()` ok to #1,000,000 |
| In one live sample, a model answering from a Pylos packet did not state a stale value as current | `bench/results/million-live-live-1.md` (one model, one seed, grok-4.3, 36 probes/arm): Pylos 36/36 current, 0 silent-false; chronological rolling summary 5/36 current, 29 abstentions, 2 silent-false. The model never called `recall` — every answer came from the compiled packet. The trap: Pylos's packet carried the revised rule as a *resident* certificate with the turn-1 version listed as historical (a frontier mechanism the baseline lacks; no page was needed) and the model honoured it; the summary carried only the stale rule |
| The thread survives the machine | `bench/results/laptop-funeral.md` (1,999-episode vault, 0.26 MiB bundle): export → clean profile → import → identical head hash, chain verified |
| A different model can continue the same thread from the compiled packet alone | `bench/results/brain-transplant.md`: a short thread, Grok → local `qwen3:4b` mid-thread through the shipping sidecar; no provider session reused |

Not claimed: that a model cannot still be wrong; any natural-conversation benchmark we have not run; "never forgets" (Pylos forgets only on command, and records that it did). See `docs/THEORY.md` §"what we are not claiming".

## Run it

```bash
bun install
bun run --cwd apps/app build && bun packages/core/src/cli.ts serve   # web app, open http://127.0.0.1:7334/app/
# hosted (multi-user, one vault per signed-in xAI account):
pylos serve --hosted --origin https://your-domain --web apps/app/dist
# or the desktop shell:
bun run --cwd packages/server build:sidecar      # kernel + server → one binary for the Tauri sidecar
bun run --cwd apps/desktop tauri dev             # the app (starts the sidecar; first Rust build takes a while)
# or headless, no UI:
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
apps/app            the React app (served at /app/ by the server; wrapped by the desktop shell)
apps/desktop        Tauri 2 + React (the one-composer app)
apps/web            the landing page (Vite, static, Vercel)
bench/              the million-turn bench, the live variant, and results
docs/               VISION · KERNEL (contract) · THEORY (results → mechanisms) · DESIGN · PLAN
```

## Lineage

Pylos starts fresh but stands on [`revelation`](https://github.com/jack-chaudier/revelation), [`stark`](https://github.com/jack-chaudier/stark), [`epistemic-debt`](https://github.com/jack-chaudier/epistemic-debt), and [`revelation-context`](https://github.com/jack-chaudier/revelation-context). `DREAM.md` is the audit that seeded it.

Apache-2.0.
