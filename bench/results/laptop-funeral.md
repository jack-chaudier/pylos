# Laptop Funeral drill — 2026-08-22

Durable infinity, end to end, with the core CLI and no server:

1. Source profile: the live-bench vault (`live-1`, 1,999 episodes, 70 capsules, 1,606 ledger entries), head hash `6983e7db1ab80130ffd754ef25c0eab53b8fbdea5d304b5093147eea1efa7af6`.
2. `pylos export --out funeral.pylos` with a passphrase → **0.26 MiB** encrypted bundle (AES-256-GCM, chunked, PBKDF2-SHA256 600k; no credentials inside).
3. Destroy: a brand-new, empty profile directory (`--home` on a clean path).
4. `pylos import funeral.pylos` → `imported 1999 episodes · head 6983e7db1ab80130… · chain verified` (the import re-derives the ledger for a sample of capsules from the episodes and refuses on disagreement).
5. `pylos verify --full` on the clean profile → `ok · checked #0→#1999 · head 6983e7db1ab80130…`.
6. `pylos stats` on the clean profile: 1,999 turns, 70 capsules, 1,606 ledger entries — identical to the source.

Found and fixed during the drill: the cached `capsules` counter was double-counted on import (data was correct; `stats` showed 140). Fixed in `bundle.ts`; re-imported; 70.

Continuing with a different model after restore is exercised by the Brain Transplant drill (server + desktop) and recorded separately.
