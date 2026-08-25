import { MAX_THREAD_MODEL_BYTES } from "@pylos/protocol";

/**
 * The vault schema (KERNEL §1), applied through a tiny forward-only migration
 * table. Every statement here is idempotent so `openVault` on an existing file
 * is a no-op.
 */

export interface Migration {
  name: string;
  sql: string;
}

/**
 * Applied in array order, once each, keyed by `name`; the numeric prefix is a
 * label for reading, not the order. `009` and `010` belong to the code
 * migrations below, which released v1 vaults already carry under those names.
 */
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
    name: "007-packet-rounds",
    sql: `
-- KERNEL A10.3: every provider request of a turn, in order, with its digest,
-- its token count and the pages served to build it. Existing packets read as
-- NULL — they were compiled before rounds were receipted.
ALTER TABLE packet ADD COLUMN rounds TEXT;
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
  {
    name: "011-witnessed-continuity",
    sql: `
-- KERNEL A12-A14: additive packet receipts. NULL preserves v1.3 packets.
ALTER TABLE packet ADD COLUMN reachability TEXT;
ALTER TABLE packet ADD COLUMN reachability_as_of_seq INTEGER;
ALTER TABLE packet ADD COLUMN coverage TEXT;
ALTER TABLE packet ADD COLUMN evidence TEXT;
ALTER TABLE packet ADD COLUMN answer_receipt TEXT;
ALTER TABLE packet ADD COLUMN semantic TEXT;

-- A12 compilation asks only for the sparse attachment sequence envelope. Keep
-- that aggregate on the thread/role/sequence index so a million-turn vault is
-- not scanned merely to emit one attachment-range receipt.
CREATE INDEX IF NOT EXISTS episode_thread_role_seq
  ON episode(thread_id, role, seq);

-- KERNEL A15.1: append-only, hash-bound question-to-evidence routes.
CREATE TABLE IF NOT EXISTS address_route (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  query_digest TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  router_version TEXT NOT NULL,
  question_seq INTEGER NOT NULL,
  answer_seq INTEGER,
  packet_id TEXT,
  packet_digest TEXT,
  source_seqs TEXT NOT NULL DEFAULT '[]',
  witnesses TEXT NOT NULL DEFAULT '[]',
  route_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','invalidated','superseded','revoked')),
  reason TEXT,
  invalidated_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS address_route_query
  ON address_route(thread_id, query_digest, router_version, created_at);
CREATE INDEX IF NOT EXISTS address_route_status
  ON address_route(thread_id, status, query_digest);

-- A model may propose an address, never authority. Rows remain source/hash bound.
CREATE TABLE IF NOT EXISTS address_alias (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  byte_from INTEGER NOT NULL,
  byte_to INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  authority TEXT NOT NULL DEFAULT 'model',
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at INTEGER NOT NULL,
  UNIQUE(thread_id, alias, source_seq, byte_from, byte_to)
);
CREATE INDEX IF NOT EXISTS address_alias_lookup ON address_alias(thread_id, alias);
CREATE INDEX IF NOT EXISTS address_alias_source ON address_alias(thread_id, source_seq);

-- sqlite-vec itself is capability-gated; ordinary metadata must remain readable
-- when no native extension/model is packaged.
CREATE TABLE IF NOT EXISTS semantic_generation (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  model_digest TEXT,
  extension_version TEXT,
  indexed INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS semantic_generation_thread
  ON semantic_generation(thread_id, created_at DESC);
`,
  },
  {
    name: "012-semantic-backfill",
    sql: `
-- The vector tables are derived and intentionally absent when the native
-- runtime is unavailable.  This ordinary row is the bounded rebuild cursor:
-- it makes partial coverage explicit without scanning a million-turn archive
-- on every question.
ALTER TABLE semantic_generation ADD COLUMN watermark_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE semantic_generation ADD COLUMN gaps INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS semantic_generation_current
  ON semantic_generation(thread_id, id);
`,
  },
  {
    name: "013-address-route-closure-index",
    sql: `
-- A15 route reuse filters immutable active edges through their append-only
-- closure events.  Keep the correlated NOT EXISTS probe on the owning thread,
-- parent edge, and event state so lookup work is bounded by the candidate page
-- rather than by every historical route row.
CREATE INDEX IF NOT EXISTS address_route_closure
      ON address_route(thread_id, invalidated_by, status);
`,
  },
  {
    name: "014-thread-list-order",
    sql: `
-- Thread navigation is keyset-paged by creation time and id. Keep the query
-- bounded even when a hosted account owns a large number of threads.
CREATE INDEX IF NOT EXISTS thread_created ON thread(created_at, id);
`,
  },
  {
    name: "015-thread-model-summary",
    sql: `
-- Thread statistics must not GROUP BY the archive on every GET.  This summary
-- records the first rowid for each bounded model and a per-thread malformed
-- count; migration 018 adds a resumable bounded backfill, while the trigger
-- keeps later appends O(1).
CREATE TABLE IF NOT EXISTS thread_model (
  thread_id TEXT NOT NULL,
  model TEXT NOT NULL,
  first_rowid INTEGER NOT NULL,
  CHECK(length(CAST(model AS BLOB)) <= ${MAX_THREAD_MODEL_BYTES}),
  PRIMARY KEY (thread_id, model)
);
CREATE INDEX IF NOT EXISTS thread_model_first ON thread_model(thread_id, first_rowid);

CREATE TABLE IF NOT EXISTS thread_model_state (
  thread_id TEXT PRIMARY KEY,
  oversized_count INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS episode_model_summary_insert
AFTER INSERT ON episode
BEGIN
  INSERT OR IGNORE INTO thread_model (thread_id, model, first_rowid)
  SELECT NEW.thread_id, NEW.model, NEW.rowid
  WHERE NEW.role = 'assistant'
    AND NEW.model IS NOT NULL
    AND length(CAST(NEW.model AS BLOB)) <= ${MAX_THREAD_MODEL_BYTES};

  INSERT INTO thread_model_state (thread_id, oversized_count)
  VALUES (
    NEW.thread_id,
    CASE
      WHEN NEW.role = 'assistant' AND NEW.model IS NOT NULL AND length(CAST(NEW.model AS BLOB)) > ${MAX_THREAD_MODEL_BYTES}
      THEN 1 ELSE 0
    END
  )
  ON CONFLICT(thread_id) DO UPDATE SET
    oversized_count = thread_model_state.oversized_count + excluded.oversized_count;
END;

CREATE TRIGGER IF NOT EXISTS episode_model_summary_update
AFTER UPDATE OF model ON episode
BEGIN
  INSERT OR IGNORE INTO thread_model (thread_id, model, first_rowid)
  SELECT NEW.thread_id, NEW.model, NEW.rowid
  WHERE NEW.role = 'assistant'
    AND NEW.model IS NOT NULL
    AND length(CAST(NEW.model AS BLOB)) <= ${MAX_THREAD_MODEL_BYTES};

  INSERT INTO thread_model_state (thread_id, oversized_count)
  VALUES (
    NEW.thread_id,
    CASE
      WHEN NEW.role = 'assistant' AND NEW.model IS NOT NULL AND length(CAST(NEW.model AS BLOB)) > ${MAX_THREAD_MODEL_BYTES}
      THEN 1 ELSE 0
    END - CASE
      WHEN OLD.role = 'assistant' AND OLD.model IS NOT NULL AND length(CAST(OLD.model AS BLOB)) > ${MAX_THREAD_MODEL_BYTES}
      THEN 1 ELSE 0
    END
  )
  ON CONFLICT(thread_id) DO UPDATE SET
    oversized_count = thread_model_state.oversized_count + excluded.oversized_count;
END;
`,
  },
  {
    name: "016-thread-model-assistant-summary",
    sql: `
-- Model history means models that spoke, not models attached to user/tool rows.
-- Do not rebuild the archive in this migration.  Existing profiles resume a
-- bounded assistant-only backfill from the cursor below when they open; the
-- vault reports incomplete history until that cursor reaches the current tail.
DROP TRIGGER IF EXISTS episode_model_summary_insert;
DROP TRIGGER IF EXISTS episode_model_summary_update;
DELETE FROM thread_model;
DELETE FROM thread_model_state;

CREATE TABLE IF NOT EXISTS thread_model_backfill (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  after_rowid INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0, 1))
);
INSERT OR IGNORE INTO thread_model_backfill (id, after_rowid, complete) VALUES (1, 0, 0);

CREATE TRIGGER IF NOT EXISTS episode_model_summary_insert
AFTER INSERT ON episode
BEGIN
  INSERT OR IGNORE INTO thread_model (thread_id, model, first_rowid)
  SELECT NEW.thread_id, NEW.model, NEW.rowid
  WHERE NEW.role = 'assistant'
    AND NEW.model IS NOT NULL
    AND length(CAST(NEW.model AS BLOB)) <= ${MAX_THREAD_MODEL_BYTES}
    AND (
      COALESCE((SELECT complete FROM thread_model_backfill WHERE id = 1), 1) = 1
      OR NEW.rowid <= COALESCE((SELECT after_rowid FROM thread_model_backfill WHERE id = 1), 0)
    );

  INSERT INTO thread_model_state (thread_id, oversized_count)
  VALUES (
    NEW.thread_id,
    CASE
      WHEN NEW.role = 'assistant' AND NEW.model IS NOT NULL AND length(CAST(NEW.model AS BLOB)) > ${MAX_THREAD_MODEL_BYTES}
        AND (
          COALESCE((SELECT complete FROM thread_model_backfill WHERE id = 1), 1) = 1
          OR NEW.rowid <= COALESCE((SELECT after_rowid FROM thread_model_backfill WHERE id = 1), 0)
        )
      THEN 1 ELSE 0
    END
  )
  ON CONFLICT(thread_id) DO UPDATE SET
    oversized_count = thread_model_state.oversized_count + excluded.oversized_count;
END;

CREATE TRIGGER IF NOT EXISTS episode_model_summary_update
AFTER UPDATE OF model ON episode
BEGIN
  INSERT OR IGNORE INTO thread_model (thread_id, model, first_rowid)
  SELECT NEW.thread_id, NEW.model, NEW.rowid
  WHERE NEW.role = 'assistant'
    AND NEW.model IS NOT NULL
    AND length(CAST(NEW.model AS BLOB)) <= ${MAX_THREAD_MODEL_BYTES}
    AND (
      COALESCE((SELECT complete FROM thread_model_backfill WHERE id = 1), 1) = 1
      OR NEW.rowid <= COALESCE((SELECT after_rowid FROM thread_model_backfill WHERE id = 1), 0)
    );

  INSERT INTO thread_model_state (thread_id, oversized_count)
  VALUES (
    NEW.thread_id,
    CASE
      WHEN NEW.role = 'assistant' AND NEW.model IS NOT NULL AND length(CAST(NEW.model AS BLOB)) > ${MAX_THREAD_MODEL_BYTES}
        AND (
          COALESCE((SELECT complete FROM thread_model_backfill WHERE id = 1), 1) = 1
          OR NEW.rowid <= COALESCE((SELECT after_rowid FROM thread_model_backfill WHERE id = 1), 0)
        )
      THEN 1 ELSE 0
    END - CASE
      WHEN OLD.role = 'assistant' AND OLD.model IS NOT NULL AND length(CAST(OLD.model AS BLOB)) > ${MAX_THREAD_MODEL_BYTES}
        AND (
          COALESCE((SELECT complete FROM thread_model_backfill WHERE id = 1), 1) = 1
          OR OLD.rowid <= COALESCE((SELECT after_rowid FROM thread_model_backfill WHERE id = 1), 0)
        )
      THEN 1 ELSE 0
    END
  )
  ON CONFLICT(thread_id) DO UPDATE SET
    oversized_count = thread_model_state.oversized_count + excluded.oversized_count;
END;
`,
  },
  {
    name: "017-attachment-name-index",
    sql: `
-- A12.3: attachment filenames are write-time address projections.  The
-- episode remains the authority; this table only bounds candidate lookup.
CREATE TABLE IF NOT EXISTS attachment_name (
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  normalized_name TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY(thread_id, seq)
);
CREATE INDEX IF NOT EXISTS attachment_name_lookup
  ON attachment_name(thread_id, normalized_name, seq DESC);
CREATE INDEX IF NOT EXISTS attachment_name_seq
  ON attachment_name(thread_id, seq);
`,
  },
  {
    name: "018-thread-fragment-quarantine",
    sql: `
-- A partial archive is an authenticated fragment, not a mutable thread.  Keep
-- its original chain boundary and make every thread-scoped write fail closed;
-- import installs the marker only after all authenticated fragment rows.
CREATE TABLE IF NOT EXISTS thread_fragment (
  thread_id TEXT PRIMARY KEY,
  original_thread_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  head_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS fragment_thread_update
BEFORE UPDATE ON thread WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;

CREATE TRIGGER IF NOT EXISTS fragment_episode_insert
BEFORE INSERT ON episode WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_episode_update
BEFORE UPDATE ON episode WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_episode_delete
BEFORE DELETE ON episode WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;

CREATE TRIGGER IF NOT EXISTS fragment_atom_insert
BEFORE INSERT ON atom WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_atom_update
BEFORE UPDATE ON atom WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_atom_delete
BEFORE DELETE ON atom WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_atom_name_insert
BEFORE INSERT ON atom_name WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_atom_name_update
BEFORE UPDATE ON atom_name WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_atom_name_delete
BEFORE DELETE ON atom_name WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;

CREATE TRIGGER IF NOT EXISTS fragment_capsule_insert
BEFORE INSERT ON capsule WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_capsule_update
BEFORE UPDATE ON capsule WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_capsule_delete
BEFORE DELETE ON capsule WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;

CREATE TRIGGER IF NOT EXISTS fragment_loss_insert
BEFORE INSERT ON loss WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_loss_update
BEFORE UPDATE ON loss WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_loss_delete
BEFORE DELETE ON loss WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;

CREATE TRIGGER IF NOT EXISTS fragment_packet_insert
BEFORE INSERT ON packet WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_packet_update
BEFORE UPDATE ON packet WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_packet_delete
BEFORE DELETE ON packet WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;

CREATE TRIGGER IF NOT EXISTS fragment_address_route_insert
BEFORE INSERT ON address_route WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_address_route_update
BEFORE UPDATE ON address_route WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_address_route_delete
BEFORE DELETE ON address_route WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_address_alias_insert
BEFORE INSERT ON address_alias WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_address_alias_update
BEFORE UPDATE ON address_alias WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_address_alias_delete
BEFORE DELETE ON address_alias WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_semantic_generation_insert
BEFORE INSERT ON semantic_generation WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_semantic_generation_update
BEFORE UPDATE ON semantic_generation WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_semantic_generation_delete
BEFORE DELETE ON semantic_generation WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_attachment_name_insert
BEFORE INSERT ON attachment_name WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_attachment_name_update
BEFORE UPDATE ON attachment_name WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_attachment_name_delete
BEFORE DELETE ON attachment_name WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;

CREATE TRIGGER IF NOT EXISTS fragment_checkpoint_insert
BEFORE INSERT ON chain_checkpoint WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_counter_insert
BEFORE INSERT ON counter WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_counter_update
BEFORE UPDATE ON counter WHEN EXISTS (SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_tombstone_insert
BEFORE INSERT ON tombstone WHEN NEW.thread_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id
)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
`,
  },
  {
    name: "019-atomization-receipts-and-frontier-lanes",
    sql: `
-- A4's pinned/kind lanes must be indexed before their bounded LIMIT.  Without
-- pinned in the leading key, an existence probe can walk every current atom
-- just to discover that the lane is empty, and a dense ordinary lane can hide
-- a late pinned certificate behind an archive-sized scan.
CREATE INDEX IF NOT EXISTS atom_frontier_lane
  ON atom(thread_id, phase, pinned, kind, valid_from_seq DESC);

-- Model extraction is optional and address-only.  A bounded extractor must
-- leave an immutable, durable receipt when it could not inspect every emitted
-- candidate; name routes fail closed while the receipt is incomplete.
CREATE TABLE IF NOT EXISTS atomization_receipt (
  thread_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','incomplete')),
  model TEXT,
  candidate_count INTEGER NOT NULL,
  accepted_count INTEGER NOT NULL,
  omitted_count INTEGER NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(thread_id, source_seq)
);
CREATE INDEX IF NOT EXISTS atomization_receipt_status
  ON atomization_receipt(thread_id, status, source_seq);
CREATE TRIGGER IF NOT EXISTS fragment_atomization_receipt_insert
BEFORE INSERT ON atomization_receipt WHEN EXISTS (
  SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id
)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_atomization_receipt_update
BEFORE UPDATE ON atomization_receipt WHEN EXISTS (
  SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id
)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_atomization_receipt_delete
BEFORE DELETE ON atomization_receipt WHEN EXISTS (
  SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id
)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
`,
  },
  {
    name: "020-assistant-packet-binding",
    sql: `
-- Full verification binds each support-bearing packet to exactly one later
-- assistant answer.  The CASE keeps malformed legacy metadata out of the
-- expression index, while seq lets the verifier read at most two candidates
-- without an archive-wide assistant scan per packet.
CREATE INDEX IF NOT EXISTS episode_assistant_packet_binding
  ON episode(
    thread_id,
    (CASE WHEN json_valid(meta) = 1 THEN json_extract(meta, '$.packetId') END),
    seq
  ) WHERE role = 'assistant';
`,
  },
  {
    name: "021-reachability-replay-indexes",
    sql: `
-- A12 v2 attachment envelopes use indexed first/last probes rather than an
-- archive-length COUNT during compile or retained-packet verification.
CREATE INDEX IF NOT EXISTS episode_active_attachment_seq
  ON episode(thread_id, seq)
  WHERE role = 'attachment' AND COALESCE(json_extract(meta, '$.removed'), 0) != 1;
CREATE INDEX IF NOT EXISTS tombstone_thread_removal
  ON tombstone(thread_id, removal_seq, id);
CREATE INDEX IF NOT EXISTS episode_removed_attachment_tombstone
  ON episode(thread_id, json_extract(meta, '$.tombstone'), seq)
  WHERE role = 'attachment' AND json_extract(meta, '$.removed') = 1;
`,
  },
  {
    name: "022-frontier-lane-tie-break",
    sql: `
-- A4 candidate pages are ordered by a deterministic unique tie-breaker. The
-- old lane ended at valid_from_seq and forced SQLite to sort a dense equal-seq
-- lane by rowid before LIMIT; id is already unique and belongs in the index.
DROP INDEX IF EXISTS atom_frontier_lane;
CREATE INDEX IF NOT EXISTS atom_frontier_lane
  ON atom(thread_id, phase, pinned, kind, valid_from_seq DESC, id DESC);
`,
  },
  {
    name: "023-atom-migration-keyset",
    sql: `
-- Startup repair walks atom rows by the same deterministic key as the index.
-- The rowid-only walk used by the original migration forced SQLite to build a
-- temporary sort for dense validity ranges.  The atom id is already unique,
-- so it is the stable tie-breaker for the resumable keyset.
CREATE INDEX IF NOT EXISTS atom_migration_range
  ON atom(thread_id, valid_from_seq ASC, id ASC);

-- Authority repair probes the source role for a candidate thread.  Keep that
-- probe on the atom side of the join; clean vaults use one global EXISTS and
-- never enumerate every thread.
CREATE INDEX IF NOT EXISTS atom_authority_source
  ON atom(thread_id, authority, source_seq);
CREATE INDEX IF NOT EXISTS atom_authority_global
  ON atom(authority, thread_id, source_seq);
CREATE INDEX IF NOT EXISTS atom_authority_scan
  ON atom(thread_id, source_seq ASC, id ASC);

-- Authority discovery uses the same exact source/id keyset. The legacy
-- migration_progress table had only a numeric cursor; keep that as source_seq
-- and carry the unique id tie-breaker in this additive text cursor.
CREATE TABLE IF NOT EXISTS migration_progress (
  thread_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  PRIMARY KEY(thread_id, name)
);
ALTER TABLE migration_progress ADD COLUMN cursor_text TEXT NOT NULL DEFAULT '';

-- Pinned state survives an incremental authority replay.  This table is
-- migration-only and is cleared as soon as a thread's replay commits.
CREATE TABLE IF NOT EXISTS atom_replay_pin (
  thread_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY(thread_id, key)
);
`,
  },
  {
    name: "024-atom-source-value",
    sql: `
-- Candidate-directed atom revalidation must not search the value/text payload
-- with an archive-sized instr(lower(...)) scan.  The source sequence and exact
-- derived value are both kernel selectors; the claim gate still verifies the
-- returned source span before it can authorize prose.
CREATE INDEX IF NOT EXISTS atom_source_value
  ON atom(thread_id, source_seq, value);
`,
  },
  {
    name: "025-bounded-capsule-ledger",
    sql: `
-- A capsule embeds only a bounded routing preview.  The kernel receipt says
-- exactly how many rows were classified, hashes their deterministic order, and
-- makes truncation explicit. NULL preserves capsules sealed by older kernels.
ALTER TABLE capsule ADD COLUMN ledger_receipt TEXT;

-- Compaction's exact dedupe set lives in SQLite instead of the JS heap. Rows
-- exist only inside the surrounding compaction transaction and are deleted
-- before it commits; a rollback also removes every staged row.
CREATE TABLE IF NOT EXISTS capsule_ledger_stage (
  capsule_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  span TEXT,
  kept INTEGER NOT NULL CHECK(kept IN (0, 1)),
  PRIMARY KEY(capsule_id, name)
);
CREATE INDEX IF NOT EXISTS capsule_ledger_stage_order
  ON capsule_ledger_stage(capsule_id, kept, seq, name);

-- Stable, exact continuation behind a capsule's bounded arrays. This is a
-- derived index: loss remains the authoritative page locator for omissions,
-- while this table binds each capsule receipt to its exact classification.
CREATE TABLE IF NOT EXISTS capsule_ledger_entry (
  thread_id TEXT NOT NULL,
  capsule_id TEXT NOT NULL,
  part TEXT NOT NULL CHECK(part IN ('dropped', 'kept')),
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  span TEXT,
  PRIMARY KEY(capsule_id, part, ordinal),
  UNIQUE(capsule_id, part, name)
);
CREATE INDEX IF NOT EXISTS capsule_ledger_entry_thread
  ON capsule_ledger_entry(thread_id, capsule_id, part, ordinal);
CREATE INDEX IF NOT EXISTS capsule_ledger_entry_name
  ON capsule_ledger_entry(capsule_id, name);
CREATE TRIGGER IF NOT EXISTS fragment_capsule_ledger_entry_insert
BEFORE INSERT ON capsule_ledger_entry WHEN EXISTS (
  SELECT 1 FROM thread_fragment f WHERE f.thread_id = NEW.thread_id
)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_capsule_ledger_entry_update
BEFORE UPDATE ON capsule_ledger_entry WHEN EXISTS (
  SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id
)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
CREATE TRIGGER IF NOT EXISTS fragment_capsule_ledger_entry_delete
BEFORE DELETE ON capsule_ledger_entry WHEN EXISTS (
  SELECT 1 FROM thread_fragment f WHERE f.thread_id = OLD.thread_id
)
BEGIN SELECT RAISE(ABORT, 'authenticated fragment is read-only'); END;
      `,
  },
  {
    name: "026-address-route-answer-packet-index",
    sql: `
-- A15 receipt-closure checks bind a locator to its exact answer packet before
-- accepting a later invalidation. Keep that probe on the route identity and
-- event state; rowid remains the deterministic keyset tie-breaker.
CREATE INDEX IF NOT EXISTS address_route_answer_packet
  ON address_route(thread_id, answer_seq, packet_id, status);
`,
  },
  {
    name: "027-capsule-ledger-name-index",
    sql: `
-- Exact bundle replay compares every independently rebuilt source locator to
-- its capsule row by name. Keep the join linear for 100k-name legal leaves.
CREATE INDEX IF NOT EXISTS capsule_ledger_entry_name
  ON capsule_ledger_entry(capsule_id, name);
`,
  },
  {
    name: "028-capsule-source-readiness",
    sql: `
-- Historical vaults may contain exact episodes created before bounded source
-- work existed. Persist their read-only quarantine so reopen/UI state does not
-- pretend a turn can commit into an uncompactable leaf.
CREATE TABLE IF NOT EXISTS capsule_source_readiness (
  thread_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('ready', 'noncompactable')),
  checked_through INTEGER NOT NULL DEFAULT 0,
  seq INTEGER,
  reason TEXT,
  checked_at INTEGER NOT NULL
);
`,
  },
  {
    name: "029-chain-verified",
    sql: `
-- What a successful verify() certified, so the UI can state it without
-- replaying the chain on every read. Distinct from chain_checkpoint, which the
-- writer also fills on append: a checkpoint says where a replay may resume, not
-- that anyone has replayed.
CREATE TABLE IF NOT EXISTS chain_verified (
  thread_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL
);
`,
  },
];

/** The code migration that replays derived atom state under v1.1 rules (KERNEL A10.5). */
export const AUTHORITY_REPLAY = "009-authority-replay";

/** The code migration that rebuilds the derived atom name index (KERNEL A11.4). */
export const ATOM_NAME_REBUILD = "010-atom-name-rebuild";

/** The code migration that rebuilds the derived attachment filename index. */
export const ATTACHMENT_NAME_REBUILD = "017-attachment-name-rebuild";

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
