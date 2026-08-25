import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATOM_NAME_MIGRATION_CURSOR,
  ATOM_NAME_MIGRATION_ROWS_PER_OPEN,
  ATOM_NAME_REBUILD,
  ATTACHMENT_NAME_MIGRATION_CURSOR,
  ATTACHMENT_NAME_MIGRATION_ROWS_PER_OPEN,
  ATTACHMENT_NAME_MIGRATION_THREADS_PER_OPEN,
  ATTACHMENT_NAME_REBUILD,
  AUTHORITY_REPLAY,
  AUTHORITY_REPLAY_CURSOR,
  AUTHORITY_REPLAY_ROWS_PER_OPEN,
  atomize,
  COUNTERS,
  compact,
  compile,
  MIGRATIONS,
  needsAuthorityReplay,
  openVault,
} from "../src/index.ts";

/**
 * A vault written by an earlier build: migrations 001–004 only, so no
 * `atom.authority` column and an unstemmed FTS index that was never populated
 * for this episode.
 */
function oldVault(): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), "pylos-migrate-"));
  const file = join(home, "vault.sqlite");
  const db = new Database(file, { create: true, readwrite: true });
  db.exec(
    "CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at INTEGER NOT NULL)",
  );
  for (const migration of MIGRATIONS.slice(0, 4)) {
    db.exec(migration.sql);
    db.query("INSERT INTO migration (name, applied_at) VALUES (?, ?)").run(migration.name, 0);
  }
  db.query(
    "INSERT INTO thread (id, title, created_at, head_seq, head_hash, settings) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("t1", "Old thread", 0, 1, "hash", "{}");
  db.query(
    "INSERT INTO episode (seq, thread_id, ts, role, content, content_hash, tokens, prev_hash, hash, meta) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(1, "t1", 0, "user", "the tea tasted smoky after the rain.", "ch", 12, "p", "h", "{}");
  db.query(
    "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, valid_from_seq, phase, scope, " +
      "pinned, confidence, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "at1",
    "t1",
    "fact",
    "user.location",
    "Lisbon",
    "I live in Lisbon.",
    1,
    1,
    "SUPPORTED",
    "global",
    0,
    1,
    "rule:user.location",
    0,
  );
  db.close();
  return { home, file };
}

test("an existing vault gains authority and a stemmed index without losing anything", () => {
  const { home, file } = oldVault();
  try {
    const vault = openVault({ home, file, fast: true });

    // 005: atoms written before the authority lattice are the user's.
    const atom = vault.atoms.get("at1");
    expect(atom?.value).toBe("Lisbon");
    expect(atom?.authority).toBe("user");
    expect(atom?.phase).toBe("SUPPORTED");

    // 006: the index is rebuilt from `episode`, and it stems.
    expect(vault.episodes.search("t1", "taste").map((e) => e.seq)).toEqual([1]);
    expect(vault.episodes.search("t1", "storms").map((e) => e.seq)).toEqual([]);

    // Re-opening is a no-op: migrations are forward-only and idempotent.
    vault.close();
    const again = openVault({ home, file, fast: true });
    expect(again.atoms.get("at1")?.authority).toBe("user");
    again.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * A vault as v1.0 left it, then patched by migration 005: the assistant's claim
 * crossed over wearing the user's authority and took the slot from the user's
 * own word. Migrations 001–006 are applied; the replay has never run.
 */
function poisonedVault(): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), "pylos-poison-"));
  const file = join(home, "vault.sqlite");
  const db = new Database(file, { create: true, readwrite: true });
  db.exec(
    "CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at INTEGER NOT NULL)",
  );
  for (const migration of MIGRATIONS.slice(0, 6)) {
    db.exec(migration.sql);
    db.query("INSERT INTO migration (name, applied_at) VALUES (?, ?)").run(migration.name, 0);
  }
  db.query(
    "INSERT INTO thread (id, title, created_at, head_seq, head_hash, settings) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("t1", "Poisoned thread", 0, 2, "hash", "{}");
  const episode = db.query(
    "INSERT INTO episode (seq, thread_id, ts, role, content, content_hash, tokens, prev_hash, hash, meta) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')",
  );
  episode.run(1, "t1", 0, "user", "Dara Novak lives in Lisbon.", "c1", 8, "p", "h1");
  episode.run(2, "t1", 0, "assistant", "Dara Novak moved to Porto.", "c2", 8, "h1", "h2");
  const atom = db.query(
    "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, valid_from_seq, valid_to_seq, " +
      "superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
      "VALUES (?, ?, 'fact', 'person.dara-novak.location', ?, ?, ?, ?, ?, ?, ?, 'user', 'global', ?, 1, 'rule:person.location', 0)",
  );
  // The user's value, closed by the assistant's; the assistant's holds the slot.
  atom.run("at1", "t1", "Lisbon", "Dara Novak lives in Lisbon.", 1, 1, 2, "at2", "HISTORICAL", 1);
  atom.run("at2", "t1", "Porto", "Dara Novak moved to Porto.", 2, 2, null, null, "SUPPORTED", 0);
  db.close();
  return { home, file };
}

test("a vault whose atoms crossed migration 005 is repaired by replay (KERNEL A10.5)", () => {
  const { home, file } = poisonedVault();
  try {
    const vault = openVault({ home, file, fast: true });
    const history = vault.atoms.historyOf("t1", "person.dara-novak.location");
    const current = history.find((a) => a.phase === "SUPPORTED");
    const proposal = history.find((a) => a.phase === "PROPOSED");
    // The user's word holds the slot; the model's is visible and unconfirmed.
    expect(current?.value).toBe("Lisbon");
    expect(current?.authority).toBe("user");
    expect(proposal?.value).toBe("Porto");
    expect(proposal?.authority).toBe("assistant");
    // The pin follows the key, not the row it was set on.
    expect(current?.pinned).toBe(true);
    expect(vault.counter("t1", COUNTERS.atomsSupported)).toBe(1);
    expect(vault.counter("t1", COUNTERS.atomsProposed)).toBe(1);

    // Replay runs once: reopening neither repeats it nor undoes it.
    vault.close();
    const again = openVault({ home, file, fast: true });
    expect(again.atoms.list("t1").length).toBe(2);
    expect(
      (
        again.db.query("SELECT COUNT(*) AS n FROM migration WHERE name = ?").get(AUTHORITY_REPLAY) as {
          n: number;
        }
      ).n,
    ).toBe(1);
    again.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pre-summary vault opens with bounded assistant-model backfill", () => {
  const home = mkdtempSync(join(tmpdir(), "pylos-model-summary-migrate-"));
  const file = join(home, "vault.sqlite");
  const db = new Database(file, { create: true, readwrite: true });
  db.exec(
    "CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at INTEGER NOT NULL)",
  );
  for (const migration of MIGRATIONS.slice(0, 12)) {
    db.exec(migration.sql);
    db.query("INSERT INTO migration (name, applied_at) VALUES (?, ?) ").run(migration.name, 0);
  }
  db.query(
    "INSERT INTO thread (id, title, created_at, head_seq, head_hash, settings) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("summary-thread", "Summary thread", 0, 2_048, "head", "{}");
  const insert = db.query(
    "INSERT INTO episode (seq, thread_id, ts, role, model, content, content_hash, tokens, prev_hash, hash, meta) " +
      "VALUES (?, ?, ?, 'assistant', ?, ?, ?, 1, ?, ?, '{}')",
  );
  for (let seq = 1; seq <= 2_048; seq += 1) {
    insert.run(
      seq,
      "summary-thread",
      seq,
      `legacy-${seq}`,
      "assistant row",
      "content-hash",
      "prev",
      `hash-${seq}`,
    );
  }
  db.close();

  const observedExec: string[] = [];
  const originalExec = Database.prototype.exec;
  const rawExec = originalExec as unknown as (this: Database, sql: string) => unknown;
  Database.prototype.exec = function (this: Database, sql: string) {
    if (/LEFT\s+JOIN\s+episode|FROM\s+thread\s+t[\s\S]+GROUP\s+BY/iu.test(sql)) observedExec.push(sql);
    return rawExec.call(this, sql);
  } as unknown as typeof originalExec;

  let vault: ReturnType<typeof openVault> | undefined;
  try {
    vault = openVault({ home, file, fast: true });
  } finally {
    Database.prototype.exec = originalExec;
  }
  if (vault === undefined) throw new Error("model-summary migration did not open the vault");
  try {
    expect(observedExec).toHaveLength(0);
    expect(vault.db.query("SELECT complete FROM thread_model_backfill WHERE id = 1").get()).toMatchObject({
      complete: 0,
    });
    expect(vault.db.query("SELECT COUNT(*) AS n FROM thread_model").get()).toMatchObject({ n: 512 });
  } finally {
    vault.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a vault with no poisoned atom is marked without being replayed", () => {
  const { home, file } = oldVault();
  try {
    const vault = openVault({ home, file, fast: true });
    // The atom was never re-derived: the row v1.0 wrote is still the one on disk.
    expect(vault.atoms.get("at1")?.value).toBe("Lisbon");
    expect(needsAuthorityReplay(vault, "t1")).toBe(false);
    vault.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "clean authority discovery stays keyset-bounded on a 100k atom archive",
  () => {
    const { home, file } = oldVault();
    const db = new Database(file, { create: false, readwrite: true });
    try {
      for (const migration of MIGRATIONS.slice(4)) {
        db.exec(migration.sql);
        db.query("INSERT INTO migration (name, applied_at) VALUES (?, ?)").run(migration.name, 0);
      }
      const insert = db.query(
        "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
          "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
          "VALUES (?, 't1', 'fact', 'clean.key', ?, 'clean source', 1, NULL, 1, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'migration-oracle', 0)",
      );
      db.transaction(() => {
        for (let index = 0; index < 100_001; index += 1) {
          insert.run(`clean-${index.toString().padStart(6, "0")}`, `value-${index}`);
        }
      })();
    } finally {
      db.close();
    }

    try {
      const vault = openVault({ home, file, fast: true });
      const progress = vault.db
        .query("SELECT cursor, cursor_text, status FROM migration_progress WHERE thread_id = ? AND name = ?")
        .get("t1", AUTHORITY_REPLAY) as { cursor: number; cursor_text: string; status: string };
      expect(progress.status).toBe("scan");
      expect(progress.cursor).toBe(1);
      expect(progress.cursor_text.length).toBeGreaterThan(0);
      expect(needsAuthorityReplay(vault)).toBe(false);
      expect(vault.atoms.byName("t1", "clean.key")).toEqual([]);
      const plan = vault.db
        .query(
          "EXPLAIN QUERY PLAN SELECT 1 FROM atom a JOIN episode e ON e.thread_id = a.thread_id AND e.seq = a.source_seq " +
            "WHERE a.authority = 'user' AND e.role IN ('assistant', 'tool') LIMIT 1",
        )
        .all() as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes("atom_authority_global"))).toBe(true);
      expect(plan.some((row) => row.detail.includes("SCAN a"))).toBe(false);
      vault.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  { timeout: 30_000 },
);

test("derived migration continuation advances readiness in one open", () => {
  const { home, file } = oldVault();
  const db = new Database(file, { create: false, readwrite: true });
  try {
    for (const migration of MIGRATIONS.slice(4)) {
      db.exec(migration.sql);
      db.query("INSERT INTO migration (name, applied_at) VALUES (?, ?)").run(migration.name, 0);
    }
    const insert = db.query(
      "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
        "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
        "VALUES (?, 't1', 'fact', ?, ?, 'continuation source', 1, NULL, 1, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'migration-oracle', 0)",
    );
    db.transaction(() => {
      for (let index = 0; index < 700; index += 1) {
        insert.run(`continue-${index}`, `continue.key.${index}`, `continue-value-${index}`);
      }
    })();
  } finally {
    db.close();
  }

  try {
    const vault = openVault({ home, file, fast: true });
    expect(vault.atoms.byName("t1", "continue.key.0")).toEqual([]);
    const before = vault.db
      .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY) as { status: string };
    expect(before.status).toBe("partial");
    vault.continueMigrations();
    const after = vault.db
      .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY) as { status: string };
    expect(after.status).toBe("complete");
    expect(vault.atoms.byName("t1", "continue.key.0")).toHaveLength(1);
    expect(
      (
        vault.db
          .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
          .get(ATOM_NAME_MIGRATION_CURSOR, ATOM_NAME_REBUILD) as { status: string }
      ).status,
    ).toBe("complete");
    vault.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an old vault's atom name index is rebuilt on first open (KERNEL A11.4)", () => {
  const { home, file } = oldVault();
  try {
    const vault = openVault({ home, file, fast: true });
    // The index is derived, so nothing carried it; it is rebuilt from the atoms.
    expect(vault.atoms.byName("t1", "user.location").map((a) => a.id)).toEqual(["at1"]);
    expect(vault.atoms.byName("t1", "lisbon").map((a) => a.id)).toEqual(["at1"]);

    // Once, and never again: reopening neither repeats the work nor undoes it.
    vault.close();
    const again = openVault({ home, file, fast: true });
    expect(again.atoms.byName("t1", "lisbon")).toHaveLength(1);
    expect(
      (
        again.db.query("SELECT COUNT(*) AS n FROM migration WHERE name = ?").get(ATOM_NAME_REBUILD) as {
          n: number;
        }
      ).n,
    ).toBe(1);
    again.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("atom-name migration exhausts a dense sequence without using the online range cap", () => {
  const { home, file } = oldVault();
  const db = new Database(file, { create: false, readwrite: true });
  try {
    for (const migration of MIGRATIONS.slice(4)) {
      db.exec(migration.sql);
      db.query("INSERT INTO migration (name, applied_at) VALUES (?, ?)").run(migration.name, 0);
    }
    db.query("DELETE FROM atom_name WHERE thread_id = ?").run("t1");
    const insert = db.query(
      "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
        "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
        "VALUES (?, ?, 'fact', ?, ?, ?, 1, NULL, 1, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'migration-oracle', 0)",
    );
    for (let index = 0; index < 512; index += 1) {
      insert.run(`dense-${index}`, "t1", `dense.key.${index}`, `value-${index}`, `Dense marker ${index}.`);
    }
  } finally {
    db.close();
  }
  try {
    let vault: ReturnType<typeof openVault> | undefined;
    expect(() => {
      vault = openVault({ home, file, fast: true });
    }).not.toThrow();
    if (vault === undefined) throw new Error("migration oracle did not open a vault");
    // Authority discovery is now bounded independently of name indexing. The
    // fixture has 513 atom rows, so let the durable open cursor reach the
    // name-rebuild phase before inspecting the derived projection.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const authority = vault.db
        .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
        .get(AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY) as { status: string } | null;
      const names = vault.db
        .query("SELECT COUNT(*) AS n FROM atom_name WHERE thread_id = ? AND name LIKE 'dense.key.%'")
        .get("t1") as { n: number };
      if (authority?.status === "complete" && names.n === 512) break;
      vault.close();
      vault = openVault({ home, file, fast: true });
    }
    const names = vault.db
      .query(
        "SELECT name, COUNT(*) AS n FROM atom_name WHERE thread_id = ? AND name LIKE 'dense.key.%' GROUP BY name",
      )
      .all("t1") as Array<{ name: string; n: number }>;
    expect(names).toHaveLength(512);
    expect(names.every((row) => row.n === 1)).toBe(true);
    expect(
      (
        vault.db.query("SELECT COUNT(*) AS n FROM migration WHERE name = ?").get(ATOM_NAME_REBUILD) as {
          n: number;
        }
      ).n,
    ).toBe(1);
    vault.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("atom-name migration persists a global cursor and fails closed while partial", () => {
  const { home, file } = oldVault();
  const db = new Database(file, { create: false, readwrite: true });
  try {
    for (const migration of MIGRATIONS.slice(4)) {
      db.exec(migration.sql);
      db.query("INSERT INTO migration (name, applied_at) VALUES (?, ?)").run(migration.name, 0);
    }
    const insert = db.query(
      "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
        "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
        "VALUES (?, ?, 'fact', ?, ?, ?, 1, NULL, 1, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'migration-oracle', 0)",
    );
    for (let index = 0; index < 2 * ATOM_NAME_MIGRATION_ROWS_PER_OPEN + 257; index += 1) {
      insert.run(
        `bounded-${index}`,
        "t1",
        `bounded.key.${index}`,
        `bounded-value-${index}`,
        `Bounded marker ${index}.`,
      );
    }
    db.query("INSERT INTO migration (name, applied_at) VALUES (?, ?)").run(AUTHORITY_REPLAY, 0);
    db.query(
      "INSERT INTO migration_progress (thread_id, name, cursor, status) VALUES (?, ?, 0, 'complete')",
    ).run(AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY);
  } finally {
    db.close();
  }
  try {
    let vault = openVault({ home, file, fast: true });
    const global = vault.db
      .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(ATOM_NAME_MIGRATION_CURSOR, ATOM_NAME_REBUILD) as { cursor: number; status: string };
    expect(global.status).toBe("partial");
    expect(global.cursor).toBe(0);
    expect(vault.atoms.byName("t1", "bounded.key.0")).toEqual([]);
    expect(() => compile(vault, "t1", { budget: 2048 })).toThrow("atom name migration is incomplete");
    vault.close();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      vault = openVault({ home, file, fast: true });
      const state = vault.db
        .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
        .get(ATOM_NAME_MIGRATION_CURSOR, ATOM_NAME_REBUILD) as { status: string };
      if (state.status === "complete") break;
      vault.close();
    }
    expect(vault.atoms.byName("t1", "bounded.key.0")).toHaveLength(1);
    vault.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("authority replay resumes a poisoned archive under its row budget", () => {
  const home = mkdtempSync(join(tmpdir(), "pylos-authority-replay-budget-"));
  const file = join(home, "vault.sqlite");
  let vault = openVault({ home, file, fast: true });
  const thread = vault.threads.create("Replay budget");
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 4 * AUTHORITY_REPLAY_ROWS_PER_OPEN + 88 }, () => ({
      role: "assistant" as const,
      content: "assistant filler",
    })),
  );
  vault.episodes.append(thread.id, { role: "user", content: "I live in Lisbon." });
  vault.close();

  const raw = new Database(file, { create: false, readwrite: true });
  try {
    raw.query("DELETE FROM migration WHERE name = ?").run(AUTHORITY_REPLAY);
    raw.query("DELETE FROM migration_progress WHERE name = ?").run(AUTHORITY_REPLAY);
    raw
      .query(
        "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
          "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
          "VALUES ('poisoned-replay', ?, 'fact', 'person.location', 'Porto', 'assistant claim', ?, NULL, ?, NULL, NULL, 'SUPPORTED', 'user', 'global', 1, 1, 'migration-oracle', 0)",
      )
      .run(thread.id, AUTHORITY_REPLAY_ROWS_PER_OPEN, AUTHORITY_REPLAY_ROWS_PER_OPEN);
  } finally {
    raw.close();
  }

  try {
    vault = openVault({ home, file, fast: true });
    const first = vault.db
      .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(thread.id, AUTHORITY_REPLAY) as { cursor: number; status: string };
    expect(first.status).toBe("partial");
    // The discovery probe itself consumes one row from the same per-open
    // envelope before the replay page begins.
    expect(first.cursor).toBe(AUTHORITY_REPLAY_ROWS_PER_OPEN - 1);
    expect(vault.atoms.byName(thread.id, "lisbon")).toEqual([]);
    expect(() => compile(vault, thread.id, { budget: 2048 })).toThrow(
      "atom authority migration is incomplete",
    );
    expect(() => atomize(vault, thread.id, [1])).toThrow("atom authority migration is incomplete");
    expect(() => compact(vault, thread.id, { budget: 2048 })).toThrow(
      "atom authority migration is incomplete",
    );
    expect(
      (
        vault.db.query("SELECT COUNT(*) AS n FROM capsule WHERE thread_id = ?").get(thread.id) as {
          n: number;
        }
      ).n,
    ).toBe(0);
    vault.close();

    vault = openVault({ home, file, fast: true });
    expect(
      (
        vault.db
          .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
          .get(thread.id, AUTHORITY_REPLAY) as { status: string }
      ).status,
    ).toBe("complete");
    expect(vault.atoms.byName(thread.id, "lisbon")).toHaveLength(1);
    vault.close();
  } finally {
    try {
      vault.close();
    } catch {
      // The assertion path may already have closed it.
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("authority replay never certifies a truncated legacy source row", () => {
  const home = mkdtempSync(join(tmpdir(), "pylos-authority-replay-overfull-"));
  const file = join(home, "vault.sqlite");
  let vault = openVault({ home, file, fast: true });
  const thread = vault.threads.create("Overfull replay");
  const source = `${"legacy prefix ".repeat(50_000)}I live in Lisbon.`;
  vault.episodes.append(thread.id, { role: "user", content: source });
  vault.episodes.append(thread.id, { role: "assistant", content: "assistant claim" });
  vault.close();

  const raw = new Database(file, { create: false, readwrite: true });
  try {
    raw.query("DELETE FROM migration WHERE name = ?").run(AUTHORITY_REPLAY);
    raw.query("DELETE FROM migration_progress WHERE name = ?").run(AUTHORITY_REPLAY);
    raw
      .query(
        "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
          "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
          "VALUES ('overfull-poison', ?, 'fact', 'person.location', 'Porto', 'assistant claim', 2, NULL, 2, NULL, NULL, 'SUPPORTED', 'user', 'global', 1, 1, 'migration-oracle', 0)",
      )
      .run(thread.id);
  } finally {
    raw.close();
  }

  try {
    vault = openVault({ home, file, fast: true });
    const first = vault.db
      .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(thread.id, AUTHORITY_REPLAY) as { cursor: number; status: string };
    const global = vault.db
      .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(AUTHORITY_REPLAY_CURSOR, AUTHORITY_REPLAY) as { cursor: number; status: string };
    expect(first.status).toBe("incomplete");
    expect(first.cursor).toBe(0);
    expect(global.status).toBe("partial");
    expect(vault.atoms.byName(thread.id, "lisbon")).toEqual([]);
    expect(() => compile(vault, thread.id, { budget: 2048 })).toThrow(
      "atom authority migration is incomplete",
    );
    vault.close();

    vault = openVault({ home, file, fast: true });
    expect(
      (
        vault.db
          .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
          .get(thread.id, AUTHORITY_REPLAY) as { status: string }
      ).status,
    ).toBe("incomplete");
    expect(
      (
        vault.db.query("SELECT COUNT(*) AS n FROM migration WHERE name = ?").get(AUTHORITY_REPLAY) as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(vault.atoms.byName(thread.id, "lisbon")).toEqual([]);
    vault.close();
  } finally {
    try {
      vault.close();
    } catch {
      // The assertion path may already have closed it.
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("attachment-name migration is incremental and keeps the route unresolved until complete", () => {
  const home = mkdtempSync(join(tmpdir(), "pylos-attachment-name-migrate-"));
  const file = join(home, "vault.sqlite");
  try {
    const vault = openVault({ home, file, fast: true });
    const thread = vault.threads.create("Attachment migration");
    const target = vault.episodes.append(thread.id, {
      role: "attachment",
      content: "legacy target bytes",
      blob: {
        bytes: new TextEncoder().encode("legacy target bytes"),
        mime: "text/plain",
        name: "legacy-target.txt",
      },
    });
    vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 1_199 }, (_, index) => ({
        role: "attachment" as const,
        content: `legacy filler ${index}`,
        meta: { name: `legacy-filler-${index}.txt` },
      })),
    );
    vault.close();

    const raw = new Database(file, { create: false, readwrite: true });
    raw
      .query("DELETE FROM migration WHERE name IN (?, ?)")
      .run("017-attachment-name-index", ATTACHMENT_NAME_REBUILD);
    raw.query("DELETE FROM migration_progress WHERE name = ?").run(ATTACHMENT_NAME_REBUILD);
    raw.query("DROP TABLE attachment_name").run();
    raw.close();

    let reopened = openVault({ home, file, fast: true });
    const partial = reopened.db
      .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(thread.id, ATTACHMENT_NAME_REBUILD) as { cursor: number; status: string };
    expect(partial.status).toBe("partial");
    expect(partial.cursor).toBeLessThanOrEqual(ATTACHMENT_NAME_MIGRATION_ROWS_PER_OPEN);
    const question = reopened.episodes.append(thread.id, {
      role: "user",
      content: "What is in the final tail of legacy-target.txt?",
    });
    const incomplete = coreCompile(reopened, thread.id, question.seq, question.content);
    const unresolved = incomplete.pages.find((page) => page.trigger === "attachment-tail");
    expect(unresolved?.resolved).toBe(false);
    expect(unresolved?.source).toContain("index-incomplete");
    reopened.close();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      reopened = openVault({ home, file, fast: true });
      const state = reopened.db
        .query("SELECT status FROM migration_progress WHERE thread_id = ? AND name = ?")
        .get(thread.id, ATTACHMENT_NAME_REBUILD) as { status: string };
      if (state.status === "complete") break;
      reopened.close();
    }
    expect(reopened.attachmentNamesReady(thread.id)).toBe(true);
    const complete = coreCompile(reopened, thread.id, question.seq, question.content);
    expect(complete.pages.some((page) => page.trigger === "attachment-tail" && page.resolved)).toBe(true);
    expect(complete.pages.some((page) => page.seqs.includes(target.seq) && page.resolved)).toBe(true);
    reopened.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("attachment-name migration completes normal threads without waiting on fragments", () => {
  const home = mkdtempSync(join(tmpdir(), "pylos-attachment-name-fragment-"));
  const file = join(home, "vault.sqlite");
  try {
    const vault = openVault({ home, file, fast: true });
    const normal = vault.threads.create("Normal attachment thread");
    const fragment = vault.threads.create("Imported fragment");
    vault.episodes.append(normal.id, {
      role: "attachment",
      content: "normal attachment bytes",
      blob: {
        bytes: new TextEncoder().encode("normal attachment bytes"),
        mime: "text/plain",
        name: "normal-target.txt",
      },
    });
    vault.episodes.append(fragment.id, {
      role: "attachment",
      content: "fragment attachment bytes",
      meta: { name: "fragment-target.txt" },
    });
    vault.db
      .query(
        "INSERT INTO thread_fragment " +
          "(thread_id, original_thread_id, from_seq, to_seq, prev_hash, head_hash, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(fragment.id, "source-thread", 1, 1, "fragment-prev", fragment.headHash, Date.now());
    vault.close();

    const raw = new Database(file, { create: false, readwrite: true });
    raw.query("DELETE FROM migration WHERE name = ?").run(ATTACHMENT_NAME_REBUILD);
    raw.query("DELETE FROM migration_progress WHERE name = ?").run(ATTACHMENT_NAME_REBUILD);
    // Fragment-derived rows are immutable once the fragment marker exists;
    // only clear the normal thread to force its rebuild.
    raw.query("DELETE FROM attachment_name WHERE thread_id = ?").run(normal.id);
    raw.close();

    let reopened = openVault({ home, file, fast: true });
    expect(
      (
        reopened.db
          .query("SELECT COUNT(*) AS n FROM migration WHERE name = ?")
          .get(ATTACHMENT_NAME_REBUILD) as { n: number }
      ).n,
    ).toBe(1);
    expect(reopened.attachmentNamesReady(normal.id)).toBe(true);
    expect(
      (
        reopened.db
          .query("SELECT COUNT(*) AS n FROM attachment_name WHERE thread_id = ? AND normalized_name = ?")
          .get(normal.id, "normal-target.txt") as { n: number }
      ).n,
    ).toBe(1);
    const question = reopened.episodes.append(normal.id, {
      role: "user",
      content: "What is in the final tail of normal-target.txt?",
    });
    expect(
      coreCompile(reopened, normal.id, question.seq, question.content).pages.some(
        (page) => page.trigger === "attachment-tail" && page.resolved,
      ),
    ).toBe(true);
    reopened.close();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      reopened = openVault({ home, file, fast: true });
      expect(reopened.attachmentNamesReady(normal.id)).toBe(true);
      expect(
        (
          reopened.db
            .query("SELECT COUNT(*) AS n FROM migration WHERE name = ?")
            .get(ATTACHMENT_NAME_REBUILD) as { n: number }
        ).n,
      ).toBe(1);
      reopened.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("attachment-name migration bounds empty-thread work and resumes its thread cursor", () => {
  const home = mkdtempSync(join(tmpdir(), "pylos-attachment-name-thread-budget-"));
  const file = join(home, "vault.sqlite");
  try {
    const vault = openVault({ home, file, fast: true });
    const emptyThreads = Array.from({ length: ATTACHMENT_NAME_MIGRATION_THREADS_PER_OPEN + 17 }, (_, index) =>
      vault.threads.create(`Empty migration thread ${index}`),
    );
    const legacy = vault.threads.create("Old attachment thread");
    vault.episodes.append(legacy.id, {
      role: "attachment",
      content: "old attachment bytes",
      meta: { name: "old-thread-target.txt" },
    });
    const firstEmpty = emptyThreads[0];
    if (firstEmpty === undefined) throw new Error("empty-thread oracle did not create a thread");
    const firstEmptyRowid = (
      vault.db.query("SELECT rowid FROM thread WHERE id = ?").get(firstEmpty.id) as { rowid: number }
    ).rowid;
    const legacyRowid = (
      vault.db.query("SELECT rowid FROM thread WHERE id = ?").get(legacy.id) as { rowid: number }
    ).rowid;
    vault.close();

    const raw = new Database(file, { create: false, readwrite: true });
    raw.query("DELETE FROM migration WHERE name = ?").run(ATTACHMENT_NAME_REBUILD);
    raw.query("DELETE FROM migration_progress WHERE name = ?").run(ATTACHMENT_NAME_REBUILD);
    raw.query("DELETE FROM attachment_name WHERE thread_id = ?").run(legacy.id);
    raw.close();

    let threadQueries = 0;
    const databasePrototype = Database.prototype as unknown as {
      query: (sql: string, ...bindings: unknown[]) => unknown;
    };
    const originalQuery = databasePrototype.query;
    databasePrototype.query = function (sql: string, ...bindings: unknown[]): unknown {
      if (sql.includes("FROM thread t")) threadQueries += 1;
      return Reflect.apply(originalQuery as (...args: unknown[]) => unknown, this, [sql, ...bindings]);
    };
    let reopened: ReturnType<typeof openVault>;
    try {
      reopened = openVault({ home, file, fast: true });
    } finally {
      databasePrototype.query = originalQuery;
    }
    expect(threadQueries).toBeLessThanOrEqual(2);
    const first = reopened.db
      .query("SELECT cursor, status FROM migration_progress WHERE thread_id = ? AND name = ?")
      .get(ATTACHMENT_NAME_MIGRATION_CURSOR, ATTACHMENT_NAME_REBUILD) as {
      cursor: number;
      status: string;
    };
    expect(first.status).toBe("partial");
    expect(first.cursor).toBeGreaterThanOrEqual(firstEmptyRowid);
    expect(first.cursor).toBeLessThan(legacyRowid);
    expect(reopened.attachmentNamesReady(legacy.id)).toBe(false);
    reopened.close();

    reopened = openVault({ home, file, fast: true });
    expect(reopened.attachmentNamesReady(legacy.id)).toBe(true);
    expect(
      (
        reopened.db.query("SELECT COUNT(*) AS n FROM attachment_name WHERE thread_id = ?").get(legacy.id) as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(
      (
        reopened.db
          .query("SELECT COUNT(*) AS n FROM migration WHERE name = ?")
          .get(ATTACHMENT_NAME_REBUILD) as { n: number }
      ).n,
    ).toBe(1);
    reopened.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function coreCompile(vault: ReturnType<typeof openVault>, threadId: string, turnSeq: number, query: string) {
  return compile(vault, threadId, { turnSeq, query, budget: 2048 });
}
