/**
 * The vault schema (KERNEL §1), applied through a tiny forward-only migration
 * table. Every statement here is idempotent so `openVault` on an existing file
 * is a no-op.
 */

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: "001-kernel",
    sql: `
CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0, head_hash TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS episode (
  seq INTEGER NOT NULL, thread_id TEXT NOT NULL, ts INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system','attachment','handoff')),
  model TEXT, provider TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (thread_id, seq)
);

CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts
  USING fts5(content, content='episode', content_rowid='rowid', tokenize='unicode61');

CREATE TABLE IF NOT EXISTS blob (hash TEXT PRIMARY KEY, mime TEXT, size INTEGER, created_at INTEGER);

CREATE TABLE IF NOT EXISTS atom (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
  kind TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL, text TEXT NOT NULL,
  source_seq INTEGER NOT NULL, source_span TEXT,
  valid_from_seq INTEGER NOT NULL, valid_to_seq INTEGER,
  superseded_by TEXT, phase TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global', pinned INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS atom_key ON atom(thread_id, key, valid_from_seq);
CREATE INDEX IF NOT EXISTS atom_phase ON atom(thread_id, phase, kind, valid_from_seq);
CREATE INDEX IF NOT EXISTS atom_source ON atom(thread_id, source_seq);

-- Which routing names an atom is about (its key, its value, and the names in the
-- sentence it came from). Lets a query reach the current certificate when the
-- frontier slot cannot hold every SUPPORTED atom.
CREATE TABLE IF NOT EXISTS atom_name (
  thread_id TEXT NOT NULL, name TEXT NOT NULL, atom_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, name, atom_id)
);
CREATE INDEX IF NOT EXISTS atom_name_lookup ON atom_name(thread_id, name);

CREATE TABLE IF NOT EXISTS capsule (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, level INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL,
  text TEXT NOT NULL, tokens INTEGER NOT NULL,
  dropped TEXT NOT NULL, carried_count INTEGER NOT NULL,
  kept TEXT NOT NULL DEFAULT '[]',
  hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS capsule_range ON capsule(thread_id, level, from_seq);
CREATE UNIQUE INDEX IF NOT EXISTS capsule_slot ON capsule(thread_id, level, from_seq, to_seq);

CREATE TABLE IF NOT EXISTS loss (
  id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, capsule_id TEXT NOT NULL,
  name TEXT NOT NULL, kind TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL, span TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS loss_name ON loss(thread_id, name);
CREATE INDEX IF NOT EXISTS loss_seq ON loss(thread_id, seq);
CREATE INDEX IF NOT EXISTS loss_capsule ON loss(capsule_id);

CREATE TABLE IF NOT EXISTS packet (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_seq INTEGER NOT NULL,
  model TEXT NOT NULL, budget INTEGER NOT NULL, tokens INTEGER NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',
  compiler_version TEXT NOT NULL DEFAULT '1',
  messages TEXT,
  resident TEXT NOT NULL, ledger TEXT NOT NULL, pages TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS packet_turn ON packet(thread_id, turn_seq);

CREATE TABLE IF NOT EXISTS tombstone (
  id TEXT PRIMARY KEY, thread_id TEXT, target TEXT, reason TEXT, created_at INTEGER
);

-- Incremental chain verification: a trusted checkpoint every 4,096 episodes so
-- the UI never waits on a full replay (KERNEL §1).
CREATE TABLE IF NOT EXISTS chain_checkpoint (
  thread_id TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
);

-- O(1) statistics. Counting 1.5M loss rows on every turn would make the
-- compiler O(archive); these counters are maintained inside the turn transaction.
-- Names that appear in > 2% of the last 10,000 episodes: still recorded in the
-- ledger, never auto-routed (KERNEL A1). Recomputed every 10,000 episodes.
CREATE TABLE IF NOT EXISTS stop_name (
  thread_id TEXT NOT NULL, name TEXT NOT NULL, hits INTEGER NOT NULL,
  PRIMARY KEY (thread_id, name)
);

CREATE TABLE IF NOT EXISTS counter (
  thread_id TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, key)
);
`,
  },
  {
    name: "002-hot-paths",
    sql: `
-- Capsule sealing asks for the atoms whose validity starts inside a range on
-- every 32nd episode; without this it is a full scan of the atom table and
-- compaction stops being amortized O(1).
CREATE INDEX IF NOT EXISTS atom_valid ON atom(thread_id, valid_from_seq);

-- The atomizer asks "what is the current atom for this key?" on every extraction.
-- Without key+phase in one index the planner picks (thread_id, phase, …) and
-- scans every SUPPORTED atom, which makes write-time atomization O(memory size).
CREATE INDEX IF NOT EXISTS atom_current ON atom(thread_id, key, phase, valid_from_seq);
`,
  },
  {
    name: "003-changed",
    sql: `
-- The header's "what changed recently" line asks for the most recently
-- superseded atoms. Without this it sorts every HISTORICAL atom in the archive
-- on every compile — 150k rows at a million turns, and the compiler is supposed
-- to be independent of archive length.
CREATE INDEX IF NOT EXISTS atom_changed ON atom(thread_id, phase, valid_to_seq);

-- The frontier candidate read orders by recency within a phase.
CREATE INDEX IF NOT EXISTS atom_recent ON atom(thread_id, phase, valid_from_seq);
`,
  },
  {
    name: "004-routing",
    sql: `
-- Ledger routing asks for the most recent locator of one name. With only
-- (thread_id, name) the planner satisfies "ORDER BY seq DESC" by walking the
-- (thread_id, seq) index across the whole ledger — 700k rows at a million turns.
-- Carrying seq in the same index makes the lookup a two-row read.
CREATE INDEX IF NOT EXISTS loss_route ON loss(thread_id, name, seq DESC);
`,
  },
  {
    name: "005-authority",
    sql: `
-- KERNEL A9.1: who asserted an atom. Everything written before this migration
-- was read from a user or tool episode by the rule atomizer, or entered by the
-- user, so 'user' is the correct reading for existing rows as well as the default.
ALTER TABLE atom ADD COLUMN authority TEXT NOT NULL DEFAULT 'user';
`,
  },
  {
    name: "006-fts-porter",
    sql: `
-- KERNEL A9.4: stemming, so "tasted" is reachable from "taste". The index is
-- external-content, so it is dropped and rebuilt from \`episode\` — no archive
-- text lives here. Removed episodes carry only their tombstone placeholder in
-- \`content\`, so the rebuild cannot resurrect forgotten text.
DROP TABLE IF EXISTS episode_fts;
CREATE VIRTUAL TABLE episode_fts
  USING fts5(content, content='episode', content_rowid='rowid', tokenize='porter unicode61');
INSERT INTO episode_fts(episode_fts) VALUES('rebuild');
`,
  },
  {
    name: "008-removal-record",
    sql: `
-- KERNEL A10.6: removal is an append-only event. \`removal_seq\` is the seq of the
-- \`system\` episode that records the removal in the chain, and \`echoes\` the
-- assistant turns that carry a routing name of the removed text.
ALTER TABLE tombstone ADD COLUMN removal_seq INTEGER;
ALTER TABLE tombstone ADD COLUMN echoes TEXT;

-- Tombstones written before this amendment are legacy: their removal predates the
-- chain event, and a chain event cannot be minted retroactively. \`verify\` accepts
-- 0 and rejects NULL, so a row inserted by hand cannot pass as one of these.
UPDATE tombstone SET removal_seq = 0 WHERE removal_seq IS NULL;
`,
  },
];

/** Counter keys maintained incrementally (see `counter`). */
export const COUNTERS = {
  episodes: "episodes",
  bytes: "bytes",
  userEpisodes: "episodes.user",
  assistantEpisodes: "episodes.assistant",
  otherEpisodes: "episodes.other",
  capsules: "capsules",
  losses: "losses",
  atomsSupported: "atoms.supported",
  atomsHistorical: "atoms.historical",
  atomsProposed: "atoms.proposed",
} as const;
