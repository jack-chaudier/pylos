# Pylos Kernel — specification (v1)

The kernel is a TypeScript library (`@pylos/core`, Bun, `bun:sqlite`) with no UI
dependency. It owns the archive, the memory IR, the context compiler, the loss
ledger, the pager, and the receipts. It must be fully testable headlessly, and
the million-turn bench must run against it with zero model calls.

Everything in this document is a contract the implementation must satisfy; the
test suite is the referee.

## 0. Vocabulary

| Term | Meaning |
| --- | --- |
| **Thread** | The one lifelong conversation. Has an id, a head sequence, a head hash. |
| **Episode** | One exact, immutable, hash-chained record: a user turn, assistant turn, tool result, attachment, system note, or handoff. |
| **Atom** | A typed, derived, revisable memory object (fact, preference, decision, promise, task, correction, hypothesis) bound to exact source spans. Non-authoritative; recomputable from episodes. |
| **Capsule** | A compaction artifact covering a contiguous episode range at some level of the hierarchy. Carries a **loss ledger**. |
| **Loss ledger / MirageMark** | The set of names, values, quotes and atoms that a capsule's text no longer contains, each with an exact locator. Conserved across levels. |
| **Packet** | The bounded, model-visible context compiled for one turn: `K_t`. Has a digest. |
| **Page** | An exact retrieval of omitted archive material into the packet, with a recorded trigger. |
| **Frontier** | The set of currently valid atoms (open obligations, current facts) — the minimum live state. |
| **Phase** | `SUPPORTED` (resident, current) · `HISTORICAL` (superseded, kept with validity interval) · `LOST` (known omitted, pageable) · `UNKNOWN` (locator failed) · `REVOKED` (user-deleted; tombstoned). |

## 1. Storage: the Vault

One SQLite database per user profile: `~/.pylos/vault.sqlite` (WAL, `0600`),
blobs in `~/.pylos/objects/<sha256>` (content-addressed). `PYLOS_HOME`
overrides. All writes that belong to one turn commit in **one transaction**
(episode + atoms + capsules + packet + pages): a crash can never leave an answer
without its derivation.

```sql
CREATE TABLE thread (
  id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0, head_hash TEXT NOT NULL,
  settings JSON NOT NULL DEFAULT '{}'
);
CREATE TABLE episode (
  seq INTEGER NOT NULL, thread_id TEXT NOT NULL, ts INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system','attachment','handoff')),
  model TEXT, provider TEXT,
  content TEXT NOT NULL,           -- exact text (≤ 64 KiB inline; larger → blob ref in meta)
  tokens INTEGER NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL,  -- hash = sha256(prev_hash || canonical(episode))
  meta JSON NOT NULL DEFAULT '{}', -- {blob, mime, name, usage, packetId, ...}
  PRIMARY KEY (thread_id, seq)
);
CREATE VIRTUAL TABLE episode_fts USING fts5(content, content='episode', content_rowid='rowid');
CREATE TABLE blob (hash TEXT PRIMARY KEY, mime TEXT, size INTEGER, created_at INTEGER);
CREATE TABLE atom (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- fact|preference|decision|promise|task|correction|hypothesis|identity
  key TEXT NOT NULL,               -- normalized slot, e.g. user.location, project.db.migration_rule
  value TEXT NOT NULL, text TEXT NOT NULL,
  source_seq INTEGER NOT NULL, source_span JSON,   -- [start,end] char offsets in episode.content
  valid_from_seq INTEGER NOT NULL, valid_to_seq INTEGER,
  superseded_by TEXT, phase TEXT NOT NULL,         -- SUPPORTED|HISTORICAL|REVOKED
  scope TEXT NOT NULL DEFAULT 'global', pinned INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX atom_key ON atom(thread_id, key, valid_from_seq);
CREATE TABLE capsule (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, level INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL,
  text TEXT NOT NULL, tokens INTEGER NOT NULL,
  dropped JSON NOT NULL,           -- LossEntry[] created by THIS compaction
  carried_count INTEGER NOT NULL,  -- |ledger transported from children| (entries live in `loss`)
  hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX capsule_range ON capsule(thread_id, level, from_seq);
CREATE TABLE loss (                -- the full, indexed ledger (Mirage conservation lives here)
  id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, capsule_id TEXT NOT NULL,
  name TEXT NOT NULL,              -- normalized routing key (entity, number, quote-head, atom key)
  kind TEXT NOT NULL,              -- entity|number|quote|atom|date|code
  seq INTEGER NOT NULL, span JSON, -- exact locator into episode
  resolved_by TEXT                 -- null | tombstone id (user deletion). Never deleted.
);
CREATE INDEX loss_name ON loss(thread_id, name);
CREATE TABLE packet (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_seq INTEGER NOT NULL,
  model TEXT NOT NULL, budget INTEGER NOT NULL, tokens INTEGER NOT NULL,
  digest TEXT NOT NULL,            -- sha256 of the exact messages array sent
  resident JSON NOT NULL,          -- ResidentItem[] {type, ref, tokens}
  ledger JSON NOT NULL,            -- LedgerDigest {count, residentNames[], levels}
  pages JSON NOT NULL,             -- PageRecord[] {trigger, name?, query?, seqs[], tokens, latencyMs, resolved}
  created_at INTEGER NOT NULL
);
CREATE TABLE tombstone (id TEXT PRIMARY KEY, thread_id TEXT, target TEXT, reason TEXT, created_at INTEGER);
```

Hash chain: `hash_i = sha256(hash_{i-1} ‖ canonicalJSON({seq, ts, role, model, provider, content_hash, meta}))`,
`hash_0 = sha256("pylos:" + thread.id)`. `verify(thread)` replays the chain and
must succeed after import. Verification must be incremental (store a checkpoint
every 4,096 episodes) so the UI never waits on a full replay.

## 2. Memory IR: atoms and revisions

Atoms are **derived and recomputable**. A wrong extraction can always be redone
because the episode is exact. Supersession never overwrites:

```
insert atom(key=K, value=V2, source_seq=s2, valid_from=s2, phase=SUPPORTED)
update prior atom(key=K, phase=SUPPORTED) → valid_to=s2, superseded_by=new.id, phase=HISTORICAL
```

This supports both "where do I live?" (current) and "where did I live when we
first discussed X?" (historical, by seq interval).

### Atomizer (write-time, after every episode)

Cascade — cheapest first, each stage may add atoms; none may delete:

1. **Rules** (deterministic, always on): patterns such as
   `my name is X` → identity.name; `I live in / moved to X` → user.location;
   `call me X`; `remember (that) …` → fact (key = slug of the clause);
   `from now on … / always … / never …` → preference or rule;
   `we decided / let's go with / use X for Y` → decision; `I will / todo / remind me` → task;
   `actually … / correction: … / not X, Y` → correction (supersedes by key match).
   Also extract **named values**: capitalized multiword entities, numbers with
   units, dates, quoted strings, code identifiers — these feed the loss ledger
   vocabulary (§4) even when no atom is created.
2. **Model extraction** (optional, async, never blocks the reply): call the
   cheapest configured model with a JSON schema
   `{atoms:[{kind,key,value,text,quote}]}` over the latest user+assistant pair.
   Every returned atom must cite a `quote` that is a verbatim substring of the
   episode; otherwise it is discarded. `created_by = "model:<id>"`.

## 3. Compaction: capsules with loss ledgers

Hierarchy with fan-out `F = 8` and leaf size `S = 32` episodes:
level-0 capsule covers 32 episodes, level-1 covers 8 level-0 (256), level-2
covers 2,048, … ⇒ O(log n) capsules span any prefix. A level-k capsule is
created as soon as its 8 children exist. Compaction runs at write time and is
amortized O(1) per turn.

### The capsule text

Two writers, same contract:

* **Deterministic extractive writer** (always available; used by the bench and
  offline): keeps, in order, every atom line (`key = value ⟨#seq⟩`), every
  decision/rule/task sentence, and the first sentence of each episode, then
  truncates to the capsule token budget (`capsuleTokens`, default 400 for
  level 0, 600 above). This is the value-dense, contract-blind writer
  (`epistemic-debt` row 16).
* **Model writer** (optional): a configured model summarizes with the
  instruction *"never state an evaluative claim without its deciding value in
  the same clause"* (the fusion contract, row 30) and the output is **hard
  truncated** to the token budget by the kernel (row 30: models override word
  budgets; enforcement must be mechanical).

### The loss ledger — mechanical, exact, conserved

For a capsule `c` with source material `src` (episodes for level 0; children
capsules' text for level > 0):

```
names(x)      := normalized routing keys found in x (entities, numbers, dates, quoted strings, code ids, atom keys)
dropped(c)    := names(src) \ names(c.text)            -- each with an exact locator {seq, span} (deepest source)
carried(c)    := ⋃_{child} (dropped(child) ∪ carried(child))   -- level > 0; never subtracted
ledger(c)     := dropped(c) ∪ carried(c)
```

Invariants (tested):

* **Conservation.** For every capsule `p` with children `C`: `ledger(p) ⊇ ⋃_{c∈C} ledger(c)`. Re-summarizing can add losses, never remove one. A loss entry leaves the ledger only via a tombstone (`resolved_by`).
* **Exact pageability.** Every `loss` row's locator resolves to an episode span whose text contains the name, or paging returns `UNKNOWN` (never "something similar").
* **Boundedness.** Resident ledger text in a packet is a *digest* (counts + names carried by the capsules in view, truncated); the full ledger is an index. The packet never grows with archive size.

This is the deployable form of `epistemic-debt` row 21 (route iff a value is
absent from the artifact) and of the Mirage-conservation law
`L_{t+1} ⊇ transport(L_t) \ R_t` from `DREAM.md`.

## 4. The context compiler `C_B(H_t, q_t) → (K_t, L_t, P_t)`

Input: thread, budget `B` (tokens; default 32,768; the demo runs at 8,192 to
make the point), the query `q_t`, the target model's capabilities.
Token counting: an approximate tokenizer (chars/3.6 with a 10% safety margin)
is acceptable in v1; the packet must never exceed `B` by the kernel's own count.

Budget allocation (defaults, all tunable in `settings`):

| Slot | Share | Content |
| --- | --- | --- |
| header | ≤ 4% | identity, turn count, date, archive size, the **view contract** (below) |
| frontier | ≤ 20% | pinned atoms, then SUPPORTED atoms by recency; certificate form `key = value ⟨#seq⟩` |
| capsules | ≤ 18% | the O(log n) capsules covering everything before the exact window, coarse→fine, each followed by its ledger digest `⟨lost: 14 · names: Boston, 2026-06-03, "dry-run" …⟩` |
| paged | ≤ 18% | exact episodes recovered for this turn (§5), each prefixed `⟦recovered #seq · trigger⟧` |
| recent | remainder (≈ 40%) | the most recent episodes verbatim, newest-first fill |

**View contract** (rendered into the system header, in plain words):

> You are continuing one long conversation. You see a bounded view of an exact
> archive of N turns. Lines marked ⟨lost: …⟩ name things the view no longer
> contains. If your answer depends on one of them, call `recall` first or say
> that you would need to check. Never state a lost value from memory. Things
> marked ⟨historical⟩ were true earlier and have changed.

The compiler emits:

* `K_t`: provider-neutral messages array + optional `recall` tool definition.
* `L_t`: `{count, names[] (resident digest), historical[]}`.
* `P_t`: the page map — for every resident ledger name, its locator; for the
  pages served this turn, their records.
* `digest = sha256(canonical(K_t))`, recorded in `packet`.

## 5. Paging (read-time)

Triggers, in order, each bounded by the `paged` share:

1. **Ledger routing (deterministic).** `names(q_t) ∩ loss.name` → page the
   exact source spans (episode ± 1 neighbour) — recall-first, most recent
   locator first. Also routes on names in the previous assistant turn (the
   model may be mid-task).
2. **Historical keys.** If `q_t` mentions an atom key or value that has a
   HISTORICAL atom, include both the current and historical atoms with their
   validity intervals.
3. **Lexical search.** FTS5/BM25 over episodes and atoms for `q_t` terms, excluding resident seqs, top-k.
4. **Model-requested recall.** Tool `recall({query?: string, seq?: number, range?: [from,to]})`
   returns exact spans; the kernel records a `PageRecord{trigger:'model'}` and
   the turn continues. Responses to recall are data, never instructions.

A page that finds no exact material returns `UNKNOWN` and is recorded as such.
Pages are never fuzzy.

## 6. Turn protocol

```
turn(thread, text, attachments?, model) :
  1. append user episode (and attachment episodes) — tx
  2. packet = compile(thread, q=text, B, model)       -- pure over the vault
  3. stream provider(model, packet.messages, tools=[recall]) ; serve recall tool calls via §5.4
  4. append assistant episode with meta{packetId, usage, pages}; atomize; compact — tx
  5. emit receipts: packet digest, pages, stats
```

Provider sessions are caches. Step 3 must work on a brand-new provider session
every time; no provider conversation id is ever required to continue.

**Model switch** = a `handoff` episode (`"Grok stopped here. Claude continued from the same thread."`) followed by an ordinary turn.

## 7. Export / import — `.pylos` bundle

A single file: `pylos-<threadid>-<headseq>.pylos` = AES-256-GCM over a zip of
`{manifest.json, episodes.jsonl, atoms.jsonl, capsules.jsonl, loss.jsonl,
packets.jsonl, tombstones.jsonl, objects/*}` with a key derived from a
passphrase (PBKDF2-SHA256 ≥ 600k iterations or scrypt; WebCrypto). Never
contains credentials. `import` verifies the hash chain before accepting and
refuses on mismatch. Selective export by seq range is allowed and marks the
manifest as partial.

## 8. Forgetting

`forget(target)` writes a tombstone, marks atoms `REVOKED`, sets
`loss.resolved_by`, deletes FTS rows and the inline content of the targeted
episodes (replacing it with `⟦removed by user · tombstone id⟧`, keeping the
hash chain valid by hashing the tombstone record). Export excludes removed
content. Pylos forgets only on command, and records that it did.

## 9. Public surface of `@pylos/core`

```ts
openVault(opts?: {home?: string}): Vault
vault.threads.create(title?) / list() / get(id)
vault.episodes.append(threadId, ep) / list(threadId, {before, limit}) / get(threadId, seq) / search(threadId, q)
vault.atoms.list(threadId, {phase, key}) / pin / revise
compile(vault, threadId, {query, budget, model, tokenizer}): Packet   // §4
page(vault, threadId, request): PageResult                           // §5
atomize(vault, threadId, seqs, {modelExtractor?}): Atom[]            // §2
compact(vault, threadId): Capsule[]                                  // §3, idempotent
verify(vault, threadId): {ok, headHash, checkedTo}                   // §1
exportBundle / importBundle                                          // §7
forget(vault, threadId, target)                                      // §8
stats(vault, threadId): ThreadStats
```

Types live in `@pylos/protocol` and are shared with the server and UI.

## 10. The bench: `pylos bench million`

Deterministic, zero model calls, seeded. Generates a naturalistic synthetic
thread of N = 1,000,000 episodes (templated dialogue about projects, places,
people, numbers; realistic distribution of fact statements, revisions,
digressions) with planted structure:

* turn 1: a rule — *"Never send a production migration before the dry-run database is verified."*
* turn 483,112: the rule is revised — *"…unless the change is additive-only and the dry-run was skipped by the on-call lead."*
* scattered: 2,000 facts each later revised once; 200 exact quotes; 50 numbers.

At checkpoints (every 10,000 turns, plus 1,000,000) the bench asserts:

1. `packet.tokens ≤ B` for the trap query and for 100 random queries.
2. Every planted revision is answered from the *current* atom, and the historical one is reachable.
3. For every planted exact quote, the paged span equals the original string.
4. Ledger conservation holds across all capsule parents (sampled exhaustively at the end).
5. `verify()` passes; archive bytes and resident tokens are reported side by side.
6. Wall-clock per turn stays flat (amortized), reported as p50/p99.

It writes `bench/results/million-<seed>.json` plus a markdown report, and the
landing page renders the same numbers. A live variant (`--live --model grok-4.3
--turns 2000`) then asks the trap question through two packet builders —
rolling-summary baseline vs Pylos — against the real provider and records both
answers. The claim the landing page makes must be the claim the bench proves.
