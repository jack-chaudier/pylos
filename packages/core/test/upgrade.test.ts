import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATOM_NAME_REBUILD, AUTHORITY_REPLAY, compile, openVault, page, verify } from "../src/index.ts";

/**
 * `vault.sqlite` was written by the released v1.3.0 kernel (tag `v1.3.0`) and
 * carries its schema exactly: migrations 001–008 plus the two code migrations
 * `009-authority-replay` and `010-atom-name-rebuild`. Four user turns, four
 * assistant turns, compacted; the head hash below is the one that kernel wrote.
 */
const FIXTURE = join(import.meta.dir, "fixtures", "vault-1.3.0", "vault.sqlite");
const HEAD_HASH = "9764904273027b19893b85731fdff2aa4810919f4ec14bbc73d4ca42ba23f3da";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A writable copy, because opening a vault migrates it in place. */
function restoredHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pylos-upgrade-"));
  homes.push(home);
  mkdirSync(join(home, "objects"), { recursive: true });
  copyFileSync(FIXTURE, join(home, "vault.sqlite"));
  return home;
}

test("a v1.3.0 vault opens, migrates, verifies, compiles and pages under this kernel", () => {
  const vault = openVault({ home: restoredHome() });
  const threads = vault.threads.list();
  expect(threads).toHaveLength(1);
  const thread = threads[0];
  if (thread === undefined) throw new Error("the 1.3.0 fixture has no thread");
  expect(thread.title).toBe("A thread written by the 1.3.0 kernel");
  expect(thread.headSeq).toBe(8);
  expect(thread.headHash).toBe(HEAD_HASH);

  // The v1.3.0 code migrations keep their names; the v2 schema is applied on
  // top of them rather than renumbered over them.
  const applied = (vault.db.query("SELECT name FROM migration").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
  expect(applied).toContain(AUTHORITY_REPLAY);
  expect(applied).toContain(ATOM_NAME_REBUILD);
  expect(applied).toContain("011-witnessed-continuity");
  expect(applied).toContain("028-capsule-source-readiness");

  // The chain the older kernel wrote replays byte for byte under this one.
  const verified = verify(vault, thread.id, { full: true });
  expect(verified).toMatchObject({ ok: true, headHash: HEAD_HASH, checkedTo: 8 });

  const packet = compile(vault, thread.id, {
    query: "what is the deploy window?",
    budget: 2_048,
    model: "grok-4.3",
  });
  expect(packet.tokens).toBeLessThanOrEqual(2_048);
  expect(packet.digest).toMatch(/^[0-9a-f]{64}$/u);

  const paged = page(vault, thread.id, { seq: 1, budget: 512 });
  expect(paged.records).toEqual([expect.objectContaining({ trigger: "model", resolved: true, seqs: [1] })]);
  expect(paged.blocks.map((block) => block.text)).toEqual([
    "Never send a production migration before the dry-run database is verified.",
  ]);

  vault.close();
});

test("the migrated v1.3.0 vault still accepts new episodes on the same chain", () => {
  const vault = openVault({ home: restoredHome() });
  const thread = vault.threads.list()[0];
  if (thread === undefined) throw new Error("the 1.3.0 fixture has no thread");

  const appended = vault.episodes.append(thread.id, {
    role: "user",
    content: "The staging host is now bramble-09.",
  });
  expect(appended.seq).toBe(9);
  expect(verify(vault, thread.id, { full: true })).toMatchObject({ ok: true, checkedTo: 9 });
  expect(vault.threads.get(thread.id)?.headHash).not.toBe(HEAD_HASH);

  vault.close();
});
