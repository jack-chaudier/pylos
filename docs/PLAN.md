# Plan — Pylos

## Team

* **Orchestrator** (this session): owns the vision, the contract (`docs/KERNEL.md`,
  `packages/protocol`), integration, release, and the final verification.
* **Partner** (Fable, medium): reads the math repos deeply, writes `docs/THEORY.md`
  (result → mechanism → test oracle), reviews the kernel spec for soundness,
  designs the bench corpus and the trap, and red-teams claims before they reach the landing page.
* **Core** (Opus, high): `packages/core` — vault, atomizer, compaction + ledger, compiler, pager, export/import, forget, verify, CLI `pylos`, bench. Headless, tested.
* **App** (Opus, high): `packages/server` (local HTTP+SSE API, providers: xAI / Anthropic / OpenAI / Ollama / OpenAI-compatible, auth custody, OpenAI-compatible gateway) and `apps/desktop` (Tauri 2 shell + React UI: transcript, composer, seal, X-ray, timeline rail).
* **Web** (Opus, high): `apps/web` — the landing page on Vercel, the in-browser aperture running the real compiler, the trap exhibit, brand assets, OG image.
* **Beta tester** (`beta`, Fable, medium, one at a time): meets the product cold — the landing page, the README, the app — knowing none of the vocabulary; reports confusion, friction, and what would impress a stranger. Read-only on the tree. Runs before any public surface is called done.

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

Status 2026-08-23: 1–7 done for v1.0.0 (see `bench/results/` and the GitHub release). Open: Linux AppImage is best-effort in CI (deb ships), notarization, and the natural-conversation benchmark (MirageBench) — see DREAM.md §15. Milestone 8 (v1.1, the web app) shipped a hosted backend on RunPod; that hosted deployment has since been **retired** — see Decisions below and milestone 9. Milestone 9 (v1.2, the integrity sprint) is released as v1.2.0: A10.1–A10.7 are implemented and tested, turn serialization moved the user's atomization ahead of `compile()`, the gateway's check semantics carry a `status` instead of a flag, and the landing page's console (the impossible thread) is live. Milestone 10 (v1.3, the addressing sprint) is implemented in the tree: KERNEL A11.1–A11.4, the server's turn lane now claimed at arrival (`packages/server/src/turn-queue.ts`), and bench schema v3 with the `faults` family. `bench/results/million-5.md` is the 1,000,000-turn artifact for this milestone on kernel 1.3.0 (`million-4.md` is the same kernel run before the version bump). Milestone 10 is not released on its own — it ships as v1.3.0 together with milestone 11 below.

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
| 10 | Addressing sprint (v1.3) | KERNEL A11.1 (a routing miss on a question that refers back is a receipt — `fault` — and a line the model reads), A11.2 (the path route: the thread's own question/answer receipts are an index back to exact sources), A11.3 (speaker-aware neighbour; thousands separators; `sequenceRefs` in pure), A11.4 (import indexes atom names; migration 010), the server's turn lane claimed at arrival, the app and web surfaces for a fault and a path recovery, and the bench's `faults` family — each with a kernel or server test as the referee; the 1,000,000-turn bench re-run on the new kernel. |
| 11 | The presence (v1.3) | `docs/DESIGN.md` rewritten to kiln-and-bone (Instrument Serif, Courier Prime, two-colour halftoned public-domain plates); the landing page rebuilt in that system with the story (the trap in four beats), the proof chart drawn from `public/bench/series.json` (derived from `bench/results/million-5.json` at build), the console answering world questions with `⟦not a memory⟧` and accepting `remember:` to append a visitor's own turn; the app rebuilt around the presence ring, one exchange in view, the archive as a drawer, the model menu listing connected providers first, handoff appended only when the next turn runs; `pylos serve` keeps the process alive, `--home` owns `auth.json`, `no_provider` is 409; the beta tester's report read before release; release.yml gates equal to ci.yml plus a clean-tree check. |
| 12 | Collection completeness (A12, next) | Not started. A question that needs many sources (compare the eleven stories) must compile into an obligation with a count, and the packet must carry a completeness receipt (`required 11 · located 10 · unresolved 1`) — the extension of "nothing forgotten silently" from total misses to partial evidence; plus the `fillRecent` case where an episode larger than the recent slot contributes nothing and is not ledgered (`packages/core/src/compile.ts` ~466) — a silent loss to close. |

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
* The fault gate (A11.1) is a stated heuristic — a cue-word match on
  first-person possessives, past-tense auxiliaries, time references, and
  memory verbs — accepted as unmeasured on natural questions, and made cheap
  to be wrong about rather than pretended exact.
* The path route (A11.2) is measured by kernel tests only this release: the
  deterministic bench ingests turns without `runTurn`, so it produces no
  packets and no receipts for a path to follow, and fabricating packet rows
  to measure it was rejected as measuring a mechanism the bench never runs.
* The semantic handler for a fault is the model's own `recall` (A9.4) — no
  second model, no embeddings, no new dependency — until a measured residual
  demands more.
* `#n` stays the archive sequence number; A11.3 changes which neighbour a
  sequence route serves, not what the number addresses.
* The design decision: kiln `#D9450E` and bone; never blue; Courier Prime is
  the only voice that states a number; engravings enter the tree only as
  finished two-colour WebP — sources and the processor stay out.
* The product decision: the app is a presence, not a transcript — the
  transcript is a drawer. The handoff episode is appended when the next turn
  runs with a different model, not when the model-selector chip changes.
  The console's `remember:` appends to the in-browser archive only and is
  never written anywhere.
* Intel macOS and ARM Linux are not built by the release workflow, so
  `install.sh` and the landing page name only Apple silicon and Linux x64.

## Claim boundary for v1 (what we will and won't say)

Will say: exact archive; bounded view with a fixed budget; deterministic loss
ledger that is conserved; exact paging; any model can continue; export/restore
verified; 1,000,000-turn deterministic bench with reported numbers.

Won't say: "never forgets" (we forget on command); "the model cannot be wrong";
any natural-conversation benchmark number we have not measured; that a page
fault means the archive lacks the answer (it means no route fired, which is a
fact about routing, not about the archive — KERNEL A11.1); that a recurring
question gets cheaper the second time (the path route's intent, not a
measured result until `bench/results` says otherwise); that a question needing
several sources was answered completely when only some were found (A12 is not
shipped).
