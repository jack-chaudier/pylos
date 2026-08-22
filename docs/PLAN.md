# Plan — Pylos v1.0.0

## Team

* **Orchestrator** (this session): owns the vision, the contract (`docs/KERNEL.md`,
  `packages/protocol`), integration, release, and the final verification.
* **Partner** (Fable, medium): reads the math repos deeply, writes `docs/THEORY.md`
  (result → mechanism → test oracle), reviews the kernel spec for soundness,
  designs the bench corpus and the trap, and red-teams claims before they reach the landing page.
* **Core** (Opus, high): `packages/core` — vault, atomizer, compaction + ledger, compiler, pager, export/import, forget, verify, CLI `pylos`, bench. Headless, tested.
* **App** (Opus, high): `packages/server` (local HTTP+SSE API, providers: xAI / Anthropic / OpenAI / Ollama / OpenAI-compatible, auth custody, OpenAI-compatible gateway) and `apps/desktop` (Tauri 2 shell + React UI: transcript, composer, seal, X-ray, timeline rail).
* **Web** (Opus, high): `apps/web` — the landing page on Vercel, the in-browser aperture running the real compiler, the trap exhibit, brand assets, OG image.

## Repository layout (Bun workspaces)

```
pylos/
  DREAM.md                      the audit that seeded this
  docs/ VISION.md KERNEL.md DESIGN.md THEORY.md PLAN.md
  packages/protocol             shared types + API contract (no deps)
  packages/core                 the kernel (bun:sqlite)
  packages/server               local API + providers (Bun.serve)
  apps/desktop                  Tauri 2 + React/Vite UI; bundles `pylos` as sidecar
  apps/web                      landing (Vite static; Vercel)
  bench/                        million-turn bench + results
  scripts/                      build, release, scan-secrets
```

## Milestones

Status 2026-08-22: 1–7 done for v1.0.0 (see `bench/results/` and the GitHub release). Open: Linux AppImage is best-effort in CI (deb ships), notarization, and the natural-conversation benchmark (MirageBench) — see DREAM.md §15. Milestone 8 (v1.1, the web app) shipped a hosted backend on RunPod; that hosted deployment has since been **retired** — see Decisions below and milestone 9. Milestone 9 (v1.2, the integrity sprint) is released as v1.2.0: A10.1–A10.7 are implemented and tested, turn serialization moved the user's atomization ahead of `compile()`, the gateway's check semantics carry a `status` instead of a flag, and the landing page's console (the impossible thread) is live.

| # | Milestone | Done means |
| --- | --- | --- |
| 1 | Contract | `docs/KERNEL.md`, `packages/protocol` typecheck; repo public on GitHub. |
| 2 | Kernel | `bun test` green: hash chain, atomizer rules, compaction conservation, compiler ≤ B, paging exactness, export/import round-trip, forget. `pylos bench million` completes with a report. |
| 3 | Server + providers | `pylos serve` streams a Grok turn end-to-end; xAI device sign-in + API key; model list; switch models mid-thread; recall tool round-trip. |
| 4 | Desktop | Tauri app opens to one composer; streams; virtualized infinite scroll to turn 1; seal + X-ray; attachments (text/code/md/pdf text); dark mode; `.pylos` export/import from the UI. macOS build (DMG) and Linux build (AppImage/deb). |
| 5 | Web | Landing deployed on Vercel with the live aperture and the trap exhibit from real bench output. |
| 6 | Proofs | Millionth Turn (deterministic + live sample), Brain Transplant (Grok → Claude → Ollama), Laptop Funeral (export/destroy/import/verify/continue), recorded in `bench/results` and linked from README. |
| 7 | v1.0.0 | CHANGELOG, tagged release with artifacts, README with honest claim boundary. |
| 8 | Web app (v1.1) | Hosted server with one vault per signed-in user; xAI device-grant login; the app served at `/app/` by `pylos serve`; landing page rewritten around **Open Pylos** as the primary CTA; the hosted app deployed at a public URL. Superseded by milestone 9: the hosted deployment is retired. |
| 9 | Integrity sprint (v1.2) | KERNEL A10.1 (support-aware routing and the check round), A10.2 (user atoms committed before `compile()`), A10.3 (every provider request of a turn ≤ B, receipted in `Packet.rounds`), A10.4 (check status `revised`/`confirmed`/`none`/`check-failed`), A10.5 (authority migrated by replay), A10.6 (forgetting complete and chain-bound), A10.7 (export as a reachability closure, import restores packets) — each with a kernel test as the referee; turn serialization and the gateway's check semantics updated to match; the landing page's console — the impossible thread — live over the bench's own corpus, no model calls. Released as v1.2.0. |

## Decisions already made (do not relitigate)

* TypeScript + Bun for the kernel and server; Tauri 2 for the shell (Electron only if Tauri cannot build on this machine); Vite + React for UI; static Vite site for the landing.
* xAI first (grok-4.6 default; grok-4.5, grok-4.3, grok-4.20 selectable), then Anthropic, OpenAI, Ollama, custom OpenAI-compatible. Credentials in `~/.pylos/auth.json` (`0600`), never in the vault, never in exports.
* Budget default 32k tokens; demo/bench at 8k. Leaf capsule 32 episodes, fan-out 8.
* Deterministic ledger (string-presence) is the source of truth; model writers are optional and truncated mechanically.
* No training run unless a measured natural residual demands one (DREAM §18). RunPod budget is reserved for an optional local atomizer/sentinel only after v1 works.
* Tools default off. Retrieved content is data, never instructions.
* Web app first: v1.1 made the hosted web app the primary way in. xAI
  device-grant login is the identity — no other identity provider. Users
  bring their own xAI account for inference; Pylos does not proxy or pay for
  it. The hosted backend was a single Bun process with one SQLite vault per
  user under `<home>/users/<id>/` — no Postgres, no separate database
  service.
* **Superseding the above: production is local-first.** The RunPod-hosted
  deployment is retired; Pylos does not run a hosted instance. `pylos serve`
  → `http://127.0.0.1:7334/app/`, or the desktop app, is the product; `pylos
  serve --hosted` stays supported in the binary for anyone who wants to run
  their own multi-user server, but that is self-hosting, not something Pylos
  operates.
* The landing page's demo (the console, `#console`) runs against the bench's
  own generator — `createCorpus(seed, n)` in `@pylos/core/pure` — so
  `apps/web` and `bench` share one corpus and one thread; no model is called
  from the browser.

## Claim boundary for v1 (what we will and won't say)

Will say: exact archive; bounded view with a fixed budget; deterministic loss
ledger that is conserved; exact paging; any model can continue; export/restore
verified; 1,000,000-turn deterministic bench with reported numbers.

Won't say: "never forgets" (we forget on command); "the model cannot be wrong";
any natural-conversation benchmark number we have not measured.
