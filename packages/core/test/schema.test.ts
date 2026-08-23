import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATOM_NAME_REBUILD,
  AUTHORITY_REPLAY,
  COUNTERS,
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
