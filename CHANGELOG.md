# Changelog

## 1.0.0 — 2026-08-22

First release. One conversation, every model, nothing forgotten silently.

* **Kernel** (`@pylos/core`): exact hash-chained archive (SQLite, WAL, content-addressed blobs), rule-based atomizer with supersession (current vs historical), hierarchical compaction (leaf 32, fan-out 8) with a deterministic, conserved, complete **loss ledger**, fixed-budget context compiler (header / frontier certificates / capsules / paged / recent), exact paging (ledger routing, historical keys, search, `recall` tool), encrypted `.pylos` export/import with chain verification, user-commanded forgetting with tombstones, incremental verify.
* **Server** (`@pylos/server`): loopback HTTP + SSE API, providers xAI (device sign-in, API key, Grok CLI import), Anthropic, OpenAI, Ollama, OpenAI-compatible; OpenAI-compatible gateway (`/v1/chat/completions` + `X-Pylos-Thread`).
* **Desktop** (Tauri 2 + React): one composer, model chip, attachments, the seal, the X-ray, timeline rail, virtualized infinite scroll, handoff dividers, recovery lines, export/import, forget; macOS `.dmg`, Linux AppImage/deb via CI.
* **Web**: pylos.vercel.app — the aperture runs the real compiler over 1,000,000 synthetic turns in the browser; the trap exhibit renders the live bench artifact.
* **Proofs** (`bench/results/`): Millionth Turn (1,000,000 turns, packet ≤ 8,192, 2000/2000 facts, 200/200 quotes byte-exact, ledger conserved, chain verified); live sample (grok-4.3, 36 probes/arm: Pylos 36/36 current, 0 silent-false; rolling summary 5/36, 2 silent-false); Laptop Funeral; Brain Transplant (Grok → local qwen3:4b).
