import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openVault } from "../src/index.ts";

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
