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

Status 2026-08-22: 1–7 done for v1.0.0 (see `bench/results/` and the GitHub release). Open: Linux AppImage is best-effort in CI (deb ships), notarization, and the natural-conversation benchmark (MirageBench) — see DREAM.md §15. Milestone 8 (v1.1, the web app) is in progress: deployment. `pylos serve --hosted` and the app served at `/app/` exist, along with the sign-in screen, evidence bar, landing rewrites, and the `million-2` bench artifact (kernel 1.1.0, `bench/results/million-2.md`); the deployed hosted URL is not yet up.

| # | Milestone | Done means |
| --- | --- | --- |
| 1 | Contract | `docs/KERNEL.md`, `packages/protocol` typecheck; repo public on GitHub. |
| 2 | Kernel | `bun test` green: hash chain, atomizer rules, compaction conservation, compiler ≤ B, paging exactness, export/import round-trip, forget. `pylos bench million` completes with a report. |
| 3 | Server + providers | `pylos serve` streams a Grok turn end-to-end; xAI device sign-in + API key; model list; switch models mid-thread; recall tool round-trip. |
| 4 | Desktop | Tauri app opens to one composer; streams; virtualized infinite scroll to turn 1; seal + X-ray; attachments (text/code/md/pdf text); dark mode; `.pylos` export/import from the UI. macOS build (DMG) and Linux build (AppImage/deb). |
| 5 | Web | Landing deployed on Vercel with the live aperture and the trap exhibit from real bench output. |
| 6 | Proofs | Millionth Turn (deterministic + live sample), Brain Transplant (Grok → Claude → Ollama), Laptop Funeral (export/destroy/import/verify/continue), recorded in `bench/results` and linked from README. |
| 7 | v1.0.0 | CHANGELOG, tagged release with artifacts, README with honest claim boundary. |
| 8 | Web app (v1.1) | Hosted server with one vault per signed-in user; xAI device-grant login; the app served at `/app/` by `pylos serve`; landing page rewritten around **Open Pylos** as the primary CTA; the hosted app deployed at a public URL. |

## Decisions already made (do not relitigate)

* TypeScript + Bun for the kernel and server; Tauri 2 for the shell (Electron only if Tauri cannot build on this machine); Vite + React for UI; static Vite site for the landing.
* xAI first (grok-4.6 default; grok-4.5, grok-4.3, grok-4.20 selectable), then Anthropic, OpenAI, Ollama, custom OpenAI-compatible. Credentials in `~/.pylos/auth.json` (`0600`), never in the vault, never in exports.
* Budget default 32k tokens; demo/bench at 8k. Leaf capsule 32 episodes, fan-out 8.
* Deterministic ledger (string-presence) is the source of truth; model writers are optional and truncated mechanically.
* No training run unless a measured natural residual demands one (DREAM §18). RunPod budget is reserved for an optional local atomizer/sentinel only after v1 works.
* Tools default off. Retrieved content is data, never instructions.
* Web app first: v1.1 makes the hosted web app the primary way in. xAI
  device-grant login is the identity — no other identity provider in v1.1.
  Users bring their own xAI account for inference; Pylos does not proxy or
  pay for it. Desktop remains the local-first option, wrapping the same app.
  The hosted backend is a single Bun process with one SQLite vault per user
  under `<home>/users/<id>/` — no Postgres, no separate database service.

## Claim boundary for v1 (what we will and won't say)

Will say: exact archive; bounded view with a fixed budget; deterministic loss
ledger that is conserved; exact paging; any model can continue; export/restore
verified; 1,000,000-turn deterministic bench with reported numbers.

Won't say: "never forgets" (we forget on command); "the model cannot be wrong";
any natural-conversation benchmark number we have not measured.
