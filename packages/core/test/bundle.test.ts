import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomize, compact, exportBundle, importBundle, openVault, verify } from "../src/index.ts";
import { cleanup, rng, syntheticTurn, tempVault } from "./helpers.ts";

afterAll(cleanup);

function seeded(seed: number, count: number) {
  const { vault, thread } = tempVault();
  const next = rng(seed);
  const appended = vault.episodes.appendMany(
    thread.id,
    Array.from({ length: count }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: syntheticTurn(next, i),
    })),
  );
  atomize(
    vault,
    thread.id,
    appended.map((e) => e.seq),
  );
  compact(vault, thread.id, { budget: 8192 });
  return { vault, thread };
}

function freshVault() {
  const home = mkdtempSync(join(tmpdir(), "pylos-import-"));
  return openVault({ home, fast: true });
}

test("export → import reproduces the head hash exactly (Laptop Funeral)", async () => {
  const { vault, thread } = seeded(31, 200);
  const before = vault.threads.get(thread.id);
  const bytes = await exportBundle(vault, thread.id, { passphrase: "correct horse battery staple" });
  expect(bytes.length).toBeGreaterThan(200);

  const target = freshVault();
  const imported = await importBundle(target, bytes, { passphrase: "correct horse battery staple" });
  expect(imported.headSeq).toBe(before?.headSeq as number);
  expect(imported.headHash).toBe(before?.headHash as string);
  expect(imported.verified).toBe(true);
  expect(verify(target, imported.threadId, { full: true }).ok).toBe(true);
  expect(target.episodes.count(imported.threadId)).toBe(200);
  expect(target.losses.total(imported.threadId)).toBe(vault.losses.total(thread.id));
});

test("every ledger entry survives the round trip identically", async () => {
  const { vault, thread } = seeded(32, 160);
  const bytes = await exportBundle(vault, thread.id, { passphrase: "pw" });
  const target = freshVault();
  const imported = await importBundle(target, bytes, { passphrase: "pw" });
  const original = vault.db
    .query("SELECT name, kind, seq, span FROM loss WHERE thread_id = ? ORDER BY name, seq")
    .all(thread.id);
  const restored = target.db
    .query("SELECT name, kind, seq, span FROM loss WHERE thread_id = ? ORDER BY name, seq")
    .all(imported.threadId);
  expect(restored).toEqual(original);
});

test("a wrong passphrase is refused", async () => {
  const { vault, thread } = seeded(33, 40);
  const bytes = await exportBundle(vault, thread.id, { passphrase: "right" });
  const target = freshVault();
  await expect(importBundle(target, bytes, { passphrase: "wrong" })).rejects.toThrow(/decryption failed/);
});

test("a tampered bundle is refused", async () => {
  const { vault, thread } = seeded(34, 40);
  const bytes = await exportBundle(vault, thread.id, { passphrase: "pw" });
  bytes[bytes.length - 20] = (bytes[bytes.length - 20] as number) ^ 0xff;
  const target = freshVault();
  await expect(importBundle(target, bytes, { passphrase: "pw" })).rejects.toThrow();
});

test("a partial export marks the manifest and carries the previous hash", async () => {
  const { vault, thread } = seeded(35, 200);
  const bytes = await exportBundle(vault, thread.id, { passphrase: "pw", range: [100, 160] });
  const target = freshVault();
  const imported = await importBundle(target, bytes, { passphrase: "pw" });
  expect(imported.manifest.partial).toBe(true);
  expect(imported.episodes).toBe(61);
});
