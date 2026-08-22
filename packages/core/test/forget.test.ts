import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomize,
  compact,
  compile,
  exportBundle,
  forget,
  importBundle,
  nameSet,
  openVault,
  ROOT_LEVEL,
  type StoredCapsule,
  sourceNamesForRange,
  verify,
} from "../src/index.ts";
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

  // The removal travels with the archive: the imported thread verifies, which
  // means the tombstone and its chain-bound record arrived too (KERNEL A10.6).
  const home = mkdtempSync(join(tmpdir(), "pylos-forget-"));
  const target = openVault({ home, fast: true });
  const imported = await importBundle(target, bytes, { passphrase: "pw" });
  expect(imported.verified).toBe(true);
  expect(verify(target, imported.threadId, { full: true }).ok).toBe(true);
  expect(target.episodes.get(imported.threadId, secret.seq)?.content).toBe("⟦removed by user⟧");
  rmSync(home, { recursive: true, force: true });
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

test("the removal is appended to the chain and names what it removed", () => {
  const { vault, thread } = seeded(45, 32);
  const secret = vault.episodes.append(thread.id, {
    role: "user",
    content: "The launch code is Zephyrine and I want it gone.",
  });
  const result = forget(vault, thread.id, { seqs: [secret.seq] });

  const removal = vault.episodes.get(thread.id, result.removalSeq);
  expect(removal?.role).toBe("system");
  expect(removal?.content).toBe(`⟦removed #${secret.seq} · ${result.tombstoneId}⟧`);
  expect(result.removalSeq).toBeGreaterThan(secret.seq);
  expect(vault.tombstones.get(result.tombstoneId)?.removalSeq).toBe(result.removalSeq);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("capsules stop quoting the removed episode and the survivors stay accounted for", () => {
  const { vault, thread } = seeded(46, 32);
  const secret = vault.episodes.append(thread.id, {
    role: "user",
    content: "We decided to use the Zephyrine cipher for the Valletta contract.",
  });
  atomize(vault, thread.id, [secret.seq]);
  const next = rng(46);
  for (let i = 0; i < 320; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
    if (i % 32 === 0) compact(vault, thread.id, { budget: 8192 });
  }
  compact(vault, thread.id, { budget: 8192 });
  const all = (): StoredCapsule[] => vault.capsules.list(thread.id, undefined, 200);
  const quoting = (): number => all().filter((c) => c.text.includes("Zephyrine")).length;
  // The rolling root has absorbed the leaf that covers the secret.
  const root = all().find((c) => c.level === ROOT_LEVEL);
  expect(root?.toSeq).toBeGreaterThan(secret.seq);
  expect(quoting()).toBeGreaterThan(0);

  // A packet compiled hundreds of turns later still quotes the secret, through
  // the capsules it is built on.
  const packet = compile(vault, thread.id, { query: "what did we decide about the cipher?" });
  vault.packets.insert(packet);
  expect(packet.messages.some((message) => message.content.includes("Zephyrine"))).toBe(true);

  const result = forget(vault, thread.id, { seqs: [secret.seq] });
  expect(result.capsules).toBeGreaterThan(0);
  expect(quoting()).toBe(0);
  expect(result.packets).toBe(1);
  expect(vault.packets.byId(packet.id)?.messages).toEqual([]);

  // Completeness (KERNEL A2) still holds over the episodes that survive.
  for (const capsule of all()) {
    const source = sourceNamesForRange(vault, thread.id, capsule.fromSeq, capsule.toSeq);
    const present = nameSet(capsule.text, { max: 8192 });
    const ledger = new Set(
      vault.losses.inRange(thread.id, capsule.fromSeq, capsule.toSeq).map((l) => l.name),
    );
    const unaccounted = [...new Set(source.map((s) => s.name))].filter(
      (name) => !present.has(name) && !ledger.has(name),
    );
    expect({ capsule: capsule.id, unaccounted }).toEqual({ capsule: capsule.id, unaccounted: [] });
  }
  // No ledger row may point at removed material — that is where a name would leak.
  const leaked = vault.db
    .query("SELECT COUNT(*) AS n FROM loss WHERE thread_id = ? AND seq = ? AND resolved_by IS NULL")
    .get(thread.id, secret.seq) as { n: number };
  expect(leaked.n).toBe(0);
});

test("packets that carried the episode lose their messages and keep their receipt", () => {
  const { vault, thread } = seeded(47, 16);
  const secret = vault.episodes.append(thread.id, {
    role: "user",
    content: "My passport number is Zephyrine 998877.",
  });
  const packet = compile(vault, thread.id, { query: "what is the passport number?" });
  vault.packets.insert(packet);
  expect(packet.messages.length).toBeGreaterThan(0);
  expect(packet.resident.some((item) => item.seq === secret.seq)).toBe(true);

  const result = forget(vault, thread.id, { seqs: [secret.seq] });
  expect(result.packets).toBe(1);
  const after = vault.packets.byId(packet.id);
  expect(after?.messages).toEqual([]);
  expect(after?.digest).toBe(packet.digest);
  expect(after?.resident).toEqual(packet.resident);
  expect(after?.pages).toEqual(packet.pages);
  expect(JSON.stringify(after)).not.toContain("Zephyrine");
});

test("an attachment's bytes go when nothing else references them, and stay when something does", () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode("Zephyrine, the codename, in a file.");
  const first = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "codename.txt",
    blob: { bytes, mime: "text/plain", name: "codename.txt" },
  });
  const hash = first.meta.blob as string;
  const second = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "codename-again.txt",
    blob: { bytes, mime: "text/plain", name: "codename-again.txt" },
  });
  expect(second.meta.blob).toBe(hash);

  // Still referenced by the second episode: the bytes stay.
  expect(forget(vault, thread.id, { seqs: [first.seq] }).blobs).toEqual([]);
  expect(vault.blobs.get(hash)).not.toBeNull();

  const result = forget(vault, thread.id, { seqs: [second.seq] });
  expect(result.blobs).toEqual([hash]);
  expect(vault.blobs.get(hash)).toBeNull();
  expect(vault.blobs.list()).toEqual([]);
  // The reference stays in the chained meta — the archive still proves it was there.
  expect(vault.episodes.get(thread.id, second.seq)?.meta.blob).toBe(hash);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("an assistant echo is reported, never guessed at", () => {
  const { vault, thread } = seeded(48, 8);
  const secret = vault.episodes.append(thread.id, {
    role: "user",
    content: "The codename is Zephyrine and nobody else should see it.",
  });
  const echo = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "Understood — Zephyrine stays between us.",
  });

  const result = forget(vault, thread.id, { seqs: [secret.seq] });
  expect(result.echoes).toEqual([echo.seq]);
  expect(vault.tombstones.get(result.tombstoneId)?.echoes).toEqual([echo.seq]);
  // Reported, not removed: the user decides.
  expect(vault.episodes.get(thread.id, echo.seq)?.content).toContain("Zephyrine");
  expect(vault.episodes.get(thread.id, echo.seq)?.meta.removed).toBeUndefined();

  const second = forget(vault, thread.id, { seqs: [echo.seq] });
  expect(second.episodes).toEqual([echo.seq]);
  expect(vault.episodes.search(thread.id, "Zephyrine")).toHaveLength(0);
});
