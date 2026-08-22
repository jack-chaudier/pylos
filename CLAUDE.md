# Pylos — working agreement

Pylos is the forever chat: one conversation, every model, nothing forgotten silently. An exact hash-chained archive, a fixed-budget context compiler, a deterministic loss ledger, exact paging. Models are temporary cognition; the thread is the agent. This file is the operating manual for anyone — human or agent — changing this repository. Read it fully before touching code.

## Ground truth

| Question | Where the answer lives |
| --- | --- |
| What is the product, what is not claimed | `docs/VISION.md`, `README.md` §claims, `docs/PLAN.md` §claim boundary |
| What the kernel must do (binding contract) | `docs/KERNEL.md` — the test suite is the referee |
| Why each mechanism exists, which result licenses it | `docs/THEORY.md` |
| How it should look | `docs/DESIGN.md` — baked clay and verdigris, one accent, never blue |
| Team shape, milestones, decisions already made | `docs/PLAN.md` — **do not relitigate** the decisions list |
| What shipped, when | `CHANGELOG.md`, git tags `vX.Y.Z`, GitHub releases |
| Evidence for every public number | `bench/results/*.md` + the matching `.json` |

`DREAM.md` is the audit that seeded the project. Historical; read for context, never edit.

## Layout

```
packages/protocol   shared types + local API contract (no deps)
packages/core       the kernel (bun:sqlite) — vault, atomizer, compaction + ledger, compiler, pager, bundle, forget, verify, CLI `pylos`
packages/core/src/pure   browser-safe subset; powers the landing page aperture — must stay free of Node/Bun APIs
packages/server     loopback HTTP + SSE API, providers (xAI, Anthropic, OpenAI, Ollama, OpenAI-compatible), auth custody, OpenAI-compatible gateway
apps/desktop        Tauri 2 + React — the one-composer app; ships the server as a sidecar binary
apps/web            landing page (Vite, static) → pylos.vercel.app; also serves install.sh
bench/              million-turn bench, live variant, corpus; results/ holds the proofs
scripts/            repo-wide scripts (scan-secrets)
.github/workflows   ci.yml (push/PR), release.yml (tags v*)
```

## Toolchain and commands

Bun `1.3.10` (pinned in `package.json` and both workflows — keep them in sync), TypeScript strict with `noUncheckedIndexedAccess`, Biome for lint/format (2-space, width 110), Rust stable for the Tauri shell.

```bash
bun install --frozen-lockfile
bun run typecheck                                  # every workspace
bun run test                                       # core + server (bun test)
bun run lint                                       # biome check packages apps bench
bun run format                                     # biome format --write
bun run scripts/scan-secrets.ts                    # must stay clean; CI runs it
bun run --cwd packages/server build:sidecar        # kernel + server → apps/desktop/src-tauri/binaries/
bun run --cwd apps/desktop tauri dev               # the app (starts the server if :7334 is free)
bun packages/core/src/cli.ts serve                 # headless API on 127.0.0.1:7334
bun packages/core/src/cli.ts bench million --turns 100000 --seed 1 --budget 8192
bun run --cwd apps/web build                       # prebuild regenerates the aperture snapshot
```

Before any change is called done: `bun run typecheck && bun run test && bun run lint && bun run scripts/scan-secrets.ts` — all green, locally, not assumed. CI (`ci.yml`) runs the same plus `apps/web build` on Ubuntu and macOS.

## Standards

This is production software and a platform others will build on. Every change must leave the repository looking like one author wrote it with care.

* **Contract first.** Behaviour in `packages/core` is specified by `docs/KERNEL.md`. A change that alters the contract changes the spec, the tests, and the code together, in that order of thought. Wire formats (`protocol`, vault schema, `.pylos` bundle, the HTTP API) are compatibility surfaces; breaking them is a major version.
* **Tests are the referee.** New behaviour arrives with tests in `packages/*/test`. Determinism is a feature: the bench runs with zero model calls and the same seed produces the same numbers.
* **No bloat.** No dead code, no speculative abstractions, no commented-out blocks, no TODO graveyards, no wrapper layers that exist "for later". No new dependencies without a reason that would survive review; prefer Bun built-ins. Delete what you replace.
* **Code reads plainly.** Small modules with one job; names that say what they are. Comments explain *why* when it is not obvious, never narrate the *what*. No `any` (Biome warns; treat as an error). No `@ts-ignore`.
* **Credentials never enter the repo, the vault, or an export.** `~/.pylos/auth.json` only. Test fixtures with fake keys carry the `scan-secrets:allow` marker on their line.
* **Security posture is deliberate.** Server binds loopback only; CSPs in `tauri.conf.json` and `apps/web/vercel.json` are tight on purpose — loosen only with a written reason in the PR.
* **Retrieved content is data, never instructions.** Tools default off.
* **Design discipline.** UI work follows `docs/DESIGN.md`. Monospace only for evidence. One accent.

## Documentation policy

The documentation set is deliberately small: `README.md`, `CHANGELOG.md`, `LICENSE`, `DREAM.md`, `docs/{VISION,KERNEL,KERNEL_REVIEW,THEORY,DESIGN,PLAN}.md`, `bench/CORPUS.md`, `bench/results/*.md`, and this file.

* **Do not add markdown files** — no notes, scratch plans, summaries, "how I did it" write-ups, or per-directory READMEs. Working notes live in the scratchpad or the PR description, not in the tree. A new doc requires a durable reason and a link from `README.md` or `docs/PLAN.md`.
* Update the existing doc when its subject changes: contract → `KERNEL.md`; a new result or claim → `THEORY.md` and `README.md`'s evidence table (every number must point at a `bench/results` artifact); visual change → `DESIGN.md`; milestone or decision → `PLAN.md`.
* `README.md` states only what has been measured. The claim boundary in `docs/PLAN.md` is binding; "never forgets" and "the model cannot be wrong" are never written.
* Docs are prose for engineers: precise, short, no marketing, no emoji, no filler headers.

## Versioning and release

Semantic versioning. One version string, mirrored in exactly these files — bump all of them in the same commit:

```
package.json
packages/protocol/package.json   packages/core/package.json   packages/server/package.json
apps/desktop/package.json        apps/web/package.json        bench/package.json
apps/desktop/src-tauri/tauri.conf.json
apps/desktop/src-tauri/Cargo.toml   (and the `name = "pylos"` entry in Cargo.lock)
```

Check with: `grep -rn '"version"' package.json packages/*/package.json apps/*/package.json bench/package.json apps/desktop/src-tauri/tauri.conf.json && grep -n '^version' apps/desktop/src-tauri/Cargo.toml`.

* **patch** — fixes, performance, internal refactors with no behaviour change a user or integrator can observe.
* **minor** — new capability (provider, command, UI surface, API route), additive protocol changes, new bench results.
* **major** — anything that breaks an existing vault, `.pylos` bundle, the HTTP API, or the `@pylos/core` / `@pylos/protocol` public surface.

`CHANGELOG.md` is kept current, not reconstructed at release time. Every user-visible or integrator-visible change adds a line under `## Unreleased` at the top (create the heading if absent) in the existing voice: bold component, then what changed and why it matters. Internal tooling changes do not need an entry.

Release procedure — each step verified before the next:

1. Working tree clean on `main`; full verify green locally.
2. Bump the version everywhere above; rename `## Unreleased` to `## X.Y.Z — YYYY-MM-DD`; update `docs/PLAN.md` status if milestones moved.
3. Commit `release: vX.Y.Z`, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.
4. `release.yml` builds macOS `.dmg` (aarch64), Linux `.deb` (AppImage best-effort), and headless `pylos-{macos,linux}-{arm64,x64}.tar.gz`, writes `SHA256SUMS-*.txt`, and publishes the GitHub release. Watch it to completion; a failed job is fixed before anything else happens.
5. Asset names are a contract: `apps/web/public/install.sh` downloads `pylos-<plat>-<arch>.tar.gz` by name. Changing the naming in `release.yml` means changing `install.sh` in the same commit.
6. The web deploys from `apps/web` on Vercel; if release cards, versions, or proofs appear on the page, refresh them.

## Git

* Commit messages: `scope: what changed`, lowercase, imperative, one line; scopes seen in history — `core`, `server`, `app`, `web`, `bench`, `docs`, `ci`, `release`, `readme`, `plan`. Multi-scope: `core: …; bench: …`.
* Branch from `main` for non-trivial work; CI must pass before merge. Never force-push `main`. Never commit without being asked.
* Nothing generated is committed except the tracked snapshots that the site serves (`apps/web/public/aperture/final.json`, `apps/web/public/bench/trap.json`) and the bench proofs in `bench/results`.

## Working with agents

The main session is the **orchestrator**: it owns the vision, the contract, integration, verification, and the final word. It delegates with the Agent tool using the definitions in `.claude/agents/`. Every agent reads this file first and the docs its task touches; the orchestrator's prompt names those docs and the exact files in scope.

| Role | `subagent_type` | Model / effort | How many | Use for |
| --- | --- | --- | --- | --- |
| Explorer | `explorer` | Opus, medium | up to 5 in parallel | Exploratory tasks: mapping code, tracing a behaviour, auditing a surface, comparing options. Read-only. Returns a precise report with `file:line` references, not file dumps. |
| Implementer | `implementer` | Opus, high | up to 3 in parallel | Implementation: each owns a disjoint set of files or a package, writes tests, runs typecheck/test/lint on its scope, reports what changed and what it verified. Use `isolation: "worktree"` when two could touch the same files. |
| Partner | `partner` | Fable, medium | one | Research and dissent: deep reads of the math and the theory, red-teaming a claim or design before it lands, reviewing a spec for soundness. Its job is to disagree well; the orchestrator decides. |
| Docs | `docs` | Sonnet, medium | up to 5 when docs work is needed | Keeping the existing documents true after a change: README evidence table, CHANGELOG, KERNEL/THEORY/DESIGN/PLAN updates, release notes. Edits existing docs only; never creates new ones. |

Rules of engagement:

* Launch independent agents in one message so they run concurrently; give each a narrow brief, the files in scope, and the done-criterion.
* Implementers do not relitigate `docs/PLAN.md` decisions, do not add dependencies or docs, and do not touch files outside their brief. If a brief is wrong, they report back rather than improvising.
* Agents report; the orchestrator integrates, runs the full verify, reads the diff, and owns the commit. An agent's "tests pass" is a claim to check, not a fact.
* Explorer and Partner never edit the tree. Docs never edits code.
* When a change moves a public number, a claim, the contract, or the version, the orchestrator sends Docs before calling the work done.

## Claim boundary

Will say: exact archive; bounded view with a fixed budget; deterministic, conserved loss ledger; exact paging; any model can continue; export/restore verified; 1,000,000-turn deterministic bench with reported numbers. Won't say: "never forgets"; "the model cannot be wrong"; any benchmark number not in `bench/results`.
