# Brain Transplant drill — 2026-08-22

Agency infinity, exercised through the **shipping sidecar** (`Pylos.app` → `pylos-server serve` on 127.0.0.1:7334), not a test harness. Default budget 32,768.

| # | model | turn | answer (verbatim, trimmed) | packet |
| --- | --- | --- | --- | ---: |
| 1 | grok-4.3 | "My name is Jack. I live in Boston. Ground rule for this project: never deploy on Fridays." | "Got it, Jack from Boston. I'll keep the ground rule in mind: no deployments on Fridays…" | 245 |
| 2 | grok-4.3 | "Actually, I moved to New York last month." | "Got it—updated: you live in New York now. The ground rule still stands…" | 370 |
| 3 | grok-4.3 | "Where do I live now, and where did I live before? One line." | "You live in New York now and lived in Boston before." | 470 |
| — | handoff | `POST /handoff {model: "qwen3:4b"}` | episode: *Grok stopped here. qwen3 continued from the same thread.* | — |
| 4 | **qwen3:4b (local, Ollama)** | "Continue. What is my name, my deploy rule, and where do I live now?" | "Jack, never deploy on Fridays, New York" | 620 |

After turn 4: `stats` → 9 episodes, models `["grok-4.3","qwen3:4b"]`, atoms supported 4 / historical 1 (`user.location: Boston → New York @#3`), head `d3a1d252619c…`. The X-ray for turn 4 shows the packet the local model saw: header 207 · frontier 84 (certificates: name, location, rule) · recent 216 tokens; the historical revision is listed in the ledger digest.

No provider session id was reused anywhere; the second model received only the compiled packet. The same drill is what the model chip does in the desktop UI.

Found during the drill: `ledger.historical` listed the same key twice (cosmetic; fixed in `compile.ts`).
