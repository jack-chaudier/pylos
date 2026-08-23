import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomize,
  compact,
  compile,
  exportBundle,
  importBundle,
  openVault,
  packetText,
  runTurn,
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

test("a bundle carries the attachments its own episodes reach, and no others", async () => {
  const { vault, thread } = tempVault();
  const other = vault.threads.create("Other thread", { budget: 8192 });
  const mine = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "mine.txt",
    blob: { bytes: new TextEncoder().encode("thread A attachment"), mime: "text/plain", name: "mine.txt" },
  });
  vault.episodes.append(other.id, {
    role: "attachment",
    content: "theirs.txt",
    blob: {
      bytes: new TextEncoder().encode("thread B attachment"),
      mime: "text/plain",
      name: "theirs.txt",
    },
  });
  expect(vault.blobs.list()).toHaveLength(2);

  const bytes = await exportBundle(vault, thread.id, { passphrase: "pw" });
  const target = freshVault();
  const imported = await importBundle(target, bytes, { passphrase: "pw" });
  const objects = Object.keys(imported.manifest.files).filter((name) => name.startsWith("objects/"));
  expect(objects).toEqual([`objects/${mine.meta.blob as string}`]);
  expect(target.blobs.list().map((b) => b.hash)).toEqual([mine.meta.blob as string]);
});

test("a partial export reaches only the attachments inside its range", async () => {
  const { vault, thread } = tempVault();
  const early = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "early.txt",
    blob: { bytes: new TextEncoder().encode("early bytes"), mime: "text/plain", name: "early.txt" },
  });
  for (let i = 0; i < 8; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: `filler ${i}` });
  }
  const late = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "late.txt",
    blob: { bytes: new TextEncoder().encode("late bytes"), mime: "text/plain", name: "late.txt" },
  });

  const bytes = await exportBundle(vault, thread.id, { passphrase: "pw", range: [early.seq, late.seq - 1] });
  const target = freshVault();
  const imported = await importBundle(target, bytes, { passphrase: "pw" });
  const objects = Object.keys(imported.manifest.files).filter((name) => name.startsWith("objects/"));
  expect(objects).toEqual([`objects/${early.meta.blob as string}`]);
});

test("the receipts survive the round trip so the X-ray does too", async () => {
  const { vault, thread } = seeded(36, 96);
  const turn = vault.episodes.append(thread.id, { role: "user", content: "where does Ada Okafor live?" });
  const packet = compile(vault, thread.id, { query: turn.content, turnSeq: turn.seq });
  vault.packets.insert(packet);

  const bytes = await exportBundle(vault, thread.id, { passphrase: "pw" });
  const target = freshVault();
  const imported = await importBundle(target, bytes, { passphrase: "pw" });
  expect(imported.manifest.counts.packets).toBe(1);

  const restored = target.packets.byId(packet.id);
  expect(restored?.threadId).toBe(imported.threadId);
  expect(restored?.turnSeq).toBe(packet.turnSeq);
  expect(restored?.digest).toBe(packet.digest);
  expect(restored?.resident).toEqual(packet.resident);
  expect(restored?.ledger).toEqual(packet.ledger);
  expect(restored?.pages).toEqual(packet.pages);
  expect(restored?.status).toBe("done");
  // Messages are large and off by default: the X-ray re-renders from resident[].
  expect(restored?.messages).toEqual([]);
});

test("a bundle exported with packet messages restores them verbatim", async () => {
  const { vault, thread } = seeded(37, 64);
  const turn = vault.episodes.append(thread.id, { role: "user", content: "what did we decide?" });
  const packet = compile(vault, thread.id, { query: turn.content, turnSeq: turn.seq });
  vault.packets.insert(packet);

  const bytes = await exportBundle(vault, thread.id, { passphrase: "pw", includePacketMessages: true });
  const target = freshVault();
  const imported = await importBundle(target, bytes, { passphrase: "pw" });
  expect(target.packets.byId(packet.id)?.messages).toEqual(packet.messages);
  expect(verify(target, imported.threadId, { full: true }).ok).toBe(true);
});

test("import rebuilds the atom name index (KERNEL A11.4)", async () => {
  const { vault, thread } = seeded(38, 200);
  const subject = vault.atoms.list(thread.id, { phase: "SUPPORTED", limit: 1 })[0];
  expect(subject).toBeDefined();
  const name = (subject as { key: string }).key.toLowerCase();

  const bytes = await exportBundle(vault, thread.id, { passphrase: "pw" });
  const target = freshVault();
  const imported = await importBundle(target, bytes, { passphrase: "pw" });

  const restored = target.atoms.byName(imported.threadId, name).map((a) => a.id);
  expect(restored.length).toBeGreaterThan(0);
  expect(restored).toEqual(vault.atoms.byName(thread.id, name).map((a) => a.id));
});

test("packets travel, so a paraphrase still finds the source after import (KERNEL A11.2)", async () => {
  const source = "The kiln at Sagres fired unevenly because the flue was blocked.";
  const { vault, thread } = tempVault();
  const next = rng(39);
  for (let i = 0; i < 150; i += 1) {
    vault.episodes.append(thread.id, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: syntheticTurn(next, i),
    });
  }
  const planted = vault.episodes.append(thread.id, { role: "user", content: source });
  for (let i = 0; i < 150; i += 1) {
    vault.episodes.append(thread.id, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: syntheticTurn(next, i),
    });
  }
  // A question that addressed the source by number: the packet it left is the
  // only edge from the question's words back to the source (KERNEL A11.2).
  const asked = await runTurn(vault, thread.id, {
    text: `what did the vent gasket memo cover on turn ${planted.seq}?`,
    model: "m",
    provider: async function* () {
      yield { type: "delta", text: "Noted." };
      yield { type: "done" };
    },
    budget: 8192,
    check: false,
  });
  for (let i = 0; i < 300; i += 1) {
    vault.episodes.append(thread.id, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: syntheticTurn(next, i),
    });
  }
  compact(vault, thread.id, { budget: 8192 });

  const bytes = await exportBundle(vault, thread.id, { passphrase: "pw" });
  const target = freshVault();
  const imported = await importBundle(target, bytes, { passphrase: "pw" });

  const packet = compile(target, imported.threadId, {
    query: "what was in the vent gasket memo?",
    budget: 8192,
  });
  const path = packet.pages.find((p) => p.trigger === "path");
  expect(path?.query).toBe(`#${asked.userEpisode.seq}`);
  expect(path?.seqs).toContain(planted.seq);
  expect(packetText(packet.messages)).toContain(source);
});
