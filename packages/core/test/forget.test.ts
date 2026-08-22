import { afterAll, expect, test } from "bun:test";
import { atomize, compact, exportBundle, forget, verify } from "../src/index.ts";
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

test("forget removes the content, keeps the chain valid, and says so", () => {
  const { vault, thread } = seeded(41, 128);
  const secret = vault.episodes.append(thread.id, {
    role: "user",
    content: "My passport number is Zephyrine 998877 and I want it gone.",
  });
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);

  const result = forget(vault, thread.id, { seqs: [secret.seq], reason: "test" });
  expect(result.episodes).toEqual([secret.seq]);

  const after = vault.episodes.get(thread.id, secret.seq);
  expect(after?.content).toBe(`⟦removed by user · ${result.tombstoneId}⟧`);
  expect(after?.meta.removed).toBe(true);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("forget deletes the FTS row so the text is no longer searchable", () => {
  const { vault, thread } = seeded(42, 64);
  const secret = vault.episodes.append(thread.id, {
    role: "user",
    content: "The codename is Zephyrine and nobody else should see it.",
  });
  expect(vault.episodes.search(thread.id, "Zephyrine").map((e) => e.seq)).toContain(secret.seq);
  forget(vault, thread.id, { seqs: [secret.seq] });
  expect(vault.episodes.search(thread.id, "Zephyrine")).toHaveLength(0);
});

test("forget resolves the ledger rows that pointed into the removed material", () => {
  const { vault, thread } = seeded(43, 64);
  const secret = vault.episodes.append(thread.id, {
    role: "user",
    content:
      "Here is the contract note for the quarter. Kestrel Systems paid 48250.75 usd on 2026-06-03 for the Valletta contract.",
  });
  for (let i = 0; i < 96; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: `filler ${i} about nothing` });
  }
  compact(vault, thread.id, { budget: 8192 });
  const before = vault.db
    .query("SELECT COUNT(*) AS n FROM loss WHERE thread_id = ? AND seq = ? AND resolved_by IS NULL")
    .get(thread.id, secret.seq) as { n: number };
  expect(before.n).toBeGreaterThan(0);

  const result = forget(vault, thread.id, { seqs: [secret.seq] });
  expect(result.lossRows).toBe(before.n);
  const after = vault.db
    .query("SELECT COUNT(*) AS n FROM loss WHERE thread_id = ? AND seq = ? AND resolved_by IS NULL")
    .get(thread.id, secret.seq) as { n: number };
  expect(after.n).toBe(0);
  // The rows are never deleted — the archive records that it forgot.
  const tombstoned = vault.db
    .query("SELECT COUNT(*) AS n FROM loss WHERE thread_id = ? AND seq = ? AND resolved_by = ?")
    .get(thread.id, secret.seq, result.tombstoneId) as { n: number };
  expect(tombstoned.n).toBe(before.n);
});

test("removed content never leaves in an export", async () => {
  const { vault, thread } = seeded(44, 32);
  const secret = vault.episodes.append(thread.id, {
    role: "user",
    content: "Zephyrine 998877 must not be exported.",
  });
  forget(vault, thread.id, { seqs: [secret.seq] });
  const bytes = await exportBundle(vault, thread.id, { passphrase: "pw" });
  expect(Buffer.from(bytes).includes(Buffer.from("Zephyrine"))).toBe(false);
});

test("atoms derived from removed material are REVOKED", () => {
  const { vault, thread } = tempVault();
  const episode = vault.episodes.append(thread.id, { role: "user", content: "I live in Lisbon." });
  atomize(vault, thread.id, [episode.seq]);
  expect(vault.atoms.list(thread.id, { phase: "SUPPORTED" })).toHaveLength(1);
  forget(vault, thread.id, { seqs: [episode.seq] });
  expect(vault.atoms.list(thread.id, { phase: "SUPPORTED" })).toHaveLength(0);
  expect(vault.atoms.list(thread.id, { phase: "REVOKED" })).toHaveLength(1);
});
