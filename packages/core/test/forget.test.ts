import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ATTACHMENT_CHUNK_SIZE,
  atomize,
  compact,
  compile,
  exportBundle,
  forget,
  importBundle,
  MAX_BLOB_DELETION_ENTRIES,
  MAX_BLOB_DELETION_JOURNAL_BYTES,
  MAX_BLOB_DELETION_STAGES,
  MAX_FORGET_DELETION_OBJECTS,
  MAX_FORGET_TARGETS,
  nameSet,
  openVault,
  ROOT_LEVEL,
  recoverBlobDeletionsBatched,
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

test("repeating forget is an exact no-op when no authoritative target changed", () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "This value is removed once.",
  });
  const first = forget(vault, thread.id, { seqs: [source.seq], reason: "no-op oracle" });
  const tombstonesBefore = (
    vault.db.query("SELECT COUNT(*) AS count FROM tombstone WHERE thread_id = ?").get(thread.id) as {
      count: number;
    }
  ).count;
  const headBefore = vault.threads.get(thread.id)?.headSeq;

  const repeated = forget(vault, thread.id, { seqs: [source.seq], reason: "same request again" });
  const missing = forget(vault, thread.id, { seqs: [source.seq + 10_000], reason: "missing request" });

  expect(first.removalSeq).toBeGreaterThan(source.seq);
  expect(repeated).toEqual({
    tombstoneId: "",
    episodes: [],
    atoms: 0,
    lossRows: 0,
    capsules: 0,
    packets: 0,
    blobs: [],
    cleanupPending: false,
    echoes: [],
    removalSeq: 0,
  });
  expect(missing).toEqual(repeated);
  expect(
    (
      vault.db.query("SELECT COUNT(*) AS count FROM tombstone WHERE thread_id = ?").get(thread.id) as {
        count: number;
      }
    ).count,
  ).toBe(tombstonesBefore);
  expect(vault.threads.get(thread.id)?.headSeq).toBe(headBefore);
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

test("A10.6 rolls SQL back and restores every staged attachment span", () => {
  const { vault, thread } = tempVault();
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_SIZE * 2 + 17);
  bytes.fill(0x41);
  const episode = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "atomic.bin",
    blob: { bytes, mime: "application/octet-stream", name: "atomic.bin" },
  });
  const manifest = episode.meta.manifest;
  if (manifest === undefined || typeof episode.meta.blob !== "string") throw new Error("manifest fixture");
  const hashes = [...new Set([episode.meta.blob, ...manifest.spans.map((span) => span.objectHash)])];
  const originalAppend = vault.episodes.append;
  vault.episodes.append = ((threadId: string, input: Parameters<typeof originalAppend>[1]) => {
    if (input.role === "system") throw new Error("fault after deletion staging");
    return originalAppend(threadId, input);
  }) as typeof originalAppend;
  try {
    expect(() => forget(vault, thread.id, { seqs: [episode.seq] })).toThrow("fault after deletion staging");
  } finally {
    vault.episodes.append = originalAppend;
  }
  expect(vault.episodes.get(thread.id, episode.seq)?.meta.removed).toBeUndefined();
  for (const hash of hashes) expect(existsSync(join(vault.objectsDir, hash))).toBe(true);
  expect(existsSync(join(vault.objectsDir, ".delete-pending"))).toBe(false);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("A10.6 startup recovery keeps live objects after a precommit crash", () => {
  const { vault, thread } = tempVault();
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_SIZE + 13);
  bytes.fill(0x52);
  const episode = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "live.bin",
    blob: { bytes, mime: "application/octet-stream", name: "live.bin" },
  });
  const manifest = episode.meta.manifest;
  if (manifest === undefined || typeof episode.meta.blob !== "string") throw new Error("manifest fixture");
  const hashes = [...new Set([episode.meta.blob, ...manifest.spans.map((span) => span.objectHash)])];
  const stage = vault.blobs.beginDelete();
  for (const hash of hashes) {
    const size = vault.blobs.size(hash);
    if (size === null) throw new Error("blob row missing");
    vault.blobs.stageDelete(stage, hash, size);
  }
  vault.db.close();
  const reopened = openVault({ home: vault.home, fast: true });
  for (const hash of hashes) expect(reopened.blobs.get(hash)).not.toBeNull();
  expect(existsSync(join(reopened.objectsDir, ".delete-pending"))).toBe(false);
  reopened.db.close();
});

test("A10.6 ignores a torn journal replacement temp and uses the durable journal", () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode("journal replacement fixture");
  const episode = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "journal.txt",
    blob: { bytes, mime: "text/plain", name: "journal.txt" },
  });
  const hash = episode.meta.blob;
  if (typeof hash !== "string") throw new Error("blob fixture");
  const size = vault.blobs.size(hash);
  if (size === null) throw new Error("blob row missing");
  const stage = vault.blobs.beginDelete();
  vault.blobs.stageDelete(stage, hash, size);
  writeFileSync(`${stage.journal}.tmp-crash`, '{"v":1', { mode: 0o600 });
  vault.db.close();
  const reopened = openVault({ home: vault.home, fast: true });
  expect(reopened.blobs.get(hash)).not.toBeNull();
  expect(existsSync(join(reopened.objectsDir, ".delete-pending"))).toBe(false);
  reopened.db.close();
});

test("A10.6 child SIGKILL before removal append restores live whole and span objects", async () => {
  const { vault, thread } = tempVault();
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_SIZE * 2 + 17);
  bytes.fill(0x68);
  const episode = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "killed.bin",
    blob: { bytes, mime: "application/octet-stream", name: "killed.bin" },
  });
  const manifest = episode.meta.manifest;
  if (manifest === undefined || typeof episode.meta.blob !== "string") throw new Error("manifest fixture");
  const hashes = [...new Set([episode.meta.blob, ...manifest.spans.map((span) => span.objectHash)])];
  vault.db.close();
  const coreUrl = new URL("../src/index.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        const core = await import(${JSON.stringify(coreUrl)});
        const vault = core.openVault({ home: process.env.PYLOS_HOME, fast: true });
        const append = vault.episodes.append;
        vault.episodes.append = (threadId, input) => {
          if (input.role === "system") process.kill(process.pid, "SIGKILL");
          return append(threadId, input);
        };
        core.forget(vault, process.env.PYLOS_THREAD, { seqs: [${episode.seq}] });
      `,
    ],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...process.env, PYLOS_HOME: vault.home, PYLOS_THREAD: thread.id },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exit = await child.exited;
  expect(exit).not.toBe(0);
  const reopened = openVault({ home: vault.home, fast: true });
  for (const hash of hashes) expect(reopened.blobs.get(hash)).not.toBeNull();
  expect(reopened.episodes.get(thread.id, episode.seq)?.meta.removed).toBeUndefined();
  expect(existsSync(join(reopened.objectsDir, ".delete-pending"))).toBe(false);
  expect(verify(reopened, thread.id, { full: true }).ok).toBe(true);
  reopened.db.close();
});

test("A10.6 child SIGKILL after SQL commit leaves a recoverable committed journal", async () => {
  const { vault, thread } = tempVault();
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_SIZE + 19);
  bytes.fill(0x79);
  const episode = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "postcommit.bin",
    blob: { bytes, mime: "application/octet-stream", name: "postcommit.bin" },
  });
  const hash = episode.meta.blob as string;
  vault.db.close();
  const coreUrl = new URL("../src/index.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        const core = await import(${JSON.stringify(coreUrl)});
        const vault = core.openVault({ home: process.env.PYLOS_HOME, fast: true });
        vault.blobs.cleanupDelete = () => process.kill(process.pid, "SIGKILL");
        core.forget(vault, process.env.PYLOS_THREAD, { seqs: [${episode.seq}] });
      `,
    ],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...process.env, PYLOS_HOME: vault.home, PYLOS_THREAD: thread.id },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exit = await child.exited;
  expect(exit).not.toBe(0);
  const reopened = openVault({ home: vault.home, fast: true });
  expect(reopened.blobs.get(hash)).toBeNull();
  expect(reopened.episodes.get(thread.id, episode.seq)?.meta.removed).toBe(true);
  expect(existsSync(join(reopened.objectsDir, ".delete-pending"))).toBe(false);
  expect(verify(reopened, thread.id, { full: true }).ok).toBe(true);
  reopened.db.close();
});

test("A10.6 committed cleanup journals survive a crash and erase forgotten spans on reopen", () => {
  const { vault, thread } = tempVault();
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_SIZE * 2 + 17);
  bytes.fill(0x63);
  const episode = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "committed.bin",
    blob: { bytes, mime: "application/octet-stream", name: "committed.bin" },
  });
  const originalCleanup = vault.blobs.cleanupDelete;
  vault.blobs.cleanupDelete = (() => {
    throw new Error("fault after SQL commit");
  }) as typeof originalCleanup;
  const result = forget(vault, thread.id, { seqs: [episode.seq] });
  vault.blobs.cleanupDelete = originalCleanup;
  expect(result.cleanupPending).toBe(true);
  expect(existsSync(join(vault.objectsDir, ".delete-pending"))).toBe(true);
  vault.db.close();
  const reopened = openVault({ home: vault.home, fast: true });
  expect(reopened.blobs.list()).toEqual([]);
  expect(readdirSync(reopened.objectsDir)).toEqual([]);
  expect(verify(reopened, thread.id, { full: true }).ok).toBe(true);
  reopened.db.close();
});

test("A10.6 preserves a span shared by distinct whole attachments", () => {
  const { vault, thread } = tempVault();
  const prefix = new Uint8Array(ATTACHMENT_CHUNK_SIZE);
  prefix.fill(0x70);
  const tailA = new Uint8Array(31);
  const tailB = new Uint8Array(31);
  tailA.fill(0x71);
  tailB.fill(0x72);
  const bytesA = new Uint8Array(prefix.byteLength + tailA.byteLength);
  const bytesB = new Uint8Array(prefix.byteLength + tailB.byteLength);
  bytesA.set(prefix);
  bytesA.set(tailA, prefix.byteLength);
  bytesB.set(prefix);
  bytesB.set(tailB, prefix.byteLength);
  const first = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "a.bin",
    blob: { bytes: bytesA, mime: "application/octet-stream", name: "a.bin" },
  });
  const second = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "b.bin",
    blob: { bytes: bytesB, mime: "application/octet-stream", name: "b.bin" },
  });
  const manifestA = first.meta.manifest;
  const manifestB = second.meta.manifest;
  if (
    manifestA === undefined ||
    manifestB === undefined ||
    typeof first.meta.blob !== "string" ||
    typeof second.meta.blob !== "string"
  )
    throw new Error("manifest fixture");
  const shared = manifestA.spans[0]?.objectHash;
  const sharedB = manifestB.spans[0]?.objectHash;
  const tailHashA = manifestA.spans.at(-1)?.objectHash;
  const tailHashB = manifestB.spans.at(-1)?.objectHash;
  if (shared === undefined || sharedB === undefined || tailHashA === undefined || tailHashB === undefined)
    throw new Error("span fixture");
  expect(shared).toBe(sharedB);
  expect(tailHashA).not.toBe(tailHashB);

  forget(vault, thread.id, { seqs: [first.seq] });
  expect(vault.blobs.get(shared)).not.toBeNull();
  expect(vault.blobs.get(tailHashA)).toBeNull();
  expect(vault.blobs.get(tailHashB)).not.toBeNull();
  expect(vault.blobs.get(first.meta.blob)).toBeNull();

  forget(vault, thread.id, { seqs: [second.seq] });
  expect(vault.blobs.list()).toEqual([]);
  expect(readdirSync(vault.objectsDir)).toEqual([]);
});

test("A10.6 rechecks deduplicated references before unlinking after commit", () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode("a reference created after the forget commit");
  const original = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "before.txt",
    blob: { bytes, mime: "text/plain", name: "before.txt" },
  });
  const originalCleanup = vault.blobs.cleanupDelete;
  vault.blobs.cleanupDelete = ((stage, liveReference) => {
    vault.episodes.append(thread.id, {
      role: "attachment",
      content: "after.txt",
      blob: { bytes, mime: "text/plain", name: "after.txt" },
    });
    return originalCleanup(stage, liveReference);
  }) as typeof originalCleanup;
  const result = forget(vault, thread.id, { seqs: [original.seq] });
  vault.blobs.cleanupDelete = originalCleanup;
  expect(result.cleanupPending).toBe(false);
  expect(vault.blobs.get(original.meta.blob as string)).not.toBeNull();
  expect(vault.episodes.list(thread.id).some((episode) => episode.content === "after.txt")).toBe(true);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("A10.6 keeps a blob row published before its episode reference", () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode("a row can be visible before its episode");
  const original = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "before-row.txt",
    blob: { bytes, mime: "text/plain", name: "before-row.txt" },
  });
  const hash = original.meta.blob as string;
  const originalCleanup = vault.blobs.cleanupDelete;
  vault.blobs.cleanupDelete = ((stage, liveReference) => {
    // Model a producer that committed the content-addressed row before it
    // published its episode metadata. The row is itself a retention witness
    // until the next writer either references or removes it explicitly.
    vault.blobs.put(bytes, "text/plain");
    return originalCleanup(stage, liveReference);
  }) as typeof originalCleanup;
  const result = forget(vault, thread.id, { seqs: [original.seq] });
  vault.blobs.cleanupDelete = originalCleanup;
  expect(result.cleanupPending).toBe(false);
  expect(vault.blobs.get(hash)).not.toBeNull();
  expect(vault.blobs.size(hash)).toBe(bytes.byteLength);
});

test("A10.6 recovery preserves a blob row published after commit before cleanup", () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode("a committed row survives a cleanup crash");
  const original = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "after-commit.txt",
    blob: { bytes, mime: "text/plain", name: "after-commit.txt" },
  });
  const hash = original.meta.blob as string;
  const originalCleanup = vault.blobs.cleanupDelete;
  vault.blobs.cleanupDelete = (() => {
    throw new Error("fault after SQL commit");
  }) as typeof originalCleanup;
  const result = forget(vault, thread.id, { seqs: [original.seq] });
  vault.blobs.cleanupDelete = originalCleanup;
  expect(result.cleanupPending).toBe(true);

  // The writer can commit its deduplicated row after the forget transaction
  // and before the process dies, while its episode metadata is still pending.
  // Startup must treat that row as a live witness and retain the bytes.
  vault.blobs.put(bytes, "text/plain");
  vault.db.close();
  const reopened = openVault({ home: vault.home, fast: true });
  expect(reopened.blobs.size(hash)).toBe(bytes.byteLength);
  expect(reopened.blobs.get(hash)).not.toBeNull();
  expect(existsSync(join(reopened.objectsDir, ".delete-pending"))).toBe(false);
  reopened.db.close();
});

test("A10.6 recovery resolves a multi-entry journal with one bounded episode scan", () => {
  const { vault, thread } = tempVault();
  // Put the live attachment references after enough unrelated rows that a
  // per-hash callback has to parse the same episode frontier repeatedly.
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 256 }, (_, index) => ({
      role: "user" as const,
      content: `recovery scan filler ${index}`,
    })),
  );
  const attachments = Array.from({ length: 8 }, (_, index) =>
    vault.episodes.append(thread.id, {
      role: "attachment",
      content: `recovery-${index}.txt`,
      blob: { bytes: new TextEncoder().encode(`recovery journal object ${index}`), mime: "text/plain" },
    }),
  );
  const hashes = [
    ...new Set(
      attachments.map((episode) => episode.meta.blob).filter((hash): hash is string => hash !== undefined),
    ),
  ];
  expect(hashes).toHaveLength(attachments.length);

  const stage = vault.blobs.beginDelete();
  for (const hash of hashes) {
    const size = vault.blobs.size(hash);
    if (size === null) throw new Error("blob row missing");
    vault.blobs.stageDelete(stage, hash, size);
  }
  // Remove the row witnesses so recovery must resolve the live episode meta,
  // just as it must for a crash after a forget transaction removed blob rows.
  vault.db.query(`DELETE FROM blob WHERE hash IN (${hashes.map(() => "?").join(", ")})`).run(...hashes);
  vault.db.close();

  const stats = { queries: 0, rows: 0 };
  const originalQuery = Database.prototype.query;
  const sourceSql = /SELECT (?:rowid, )?meta FROM episode\s+WHERE/iu;
  const rawQuery = originalQuery as unknown as (this: Database, sql: string, ...args: unknown[]) => unknown;
  Database.prototype.query = function (this: Database, sql: string, ...args: unknown[]) {
    const statement = rawQuery.call(this, sql, ...args) as Record<string, unknown>;
    if (!sourceSql.test(sql)) return statement;
    stats.queries += 1;
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const rows = method.apply(target, parameters);
            stats.rows += Array.isArray(rows) ? rows.length : 0;
            return rows;
          };
        }
        if (property === "iterate") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const rows = method.apply(target, parameters) as Iterable<unknown>;
            return (function* () {
              for (const row of rows) {
                stats.rows += 1;
                yield row;
              }
            })();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } as unknown as typeof originalQuery;
  let reopened: ReturnType<typeof openVault> | null = null;
  try {
    reopened = openVault({ home: vault.home, fast: true });
  } finally {
    Database.prototype.query = originalQuery;
  }
  if (reopened === null) throw new Error("reopen did not return a vault");
  expect(stats.rows).toBeLessThanOrEqual(attachments.length + 256);
  expect(stats.queries).toBeLessThanOrEqual(2);
  for (const hash of hashes) expect(reopened.blobs.get(hash)).not.toBeNull();
  expect(existsSync(join(reopened.objectsDir, ".delete-pending"))).toBe(false);
  reopened.close();
});

test(
  "forget and startup recovery keep oversized metadata scalar-only",
  () => {
    const { vault, thread } = tempVault();
    const oversized = "x".repeat(1_000_000);
    const removed = vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 256 }, (_, index) => ({
        role: "user" as const,
        content: `already removed metadata ${index}`,
        meta: { removed: true, padding: oversized },
      })),
    );
    const bytes = new TextEncoder().encode("shared oversized metadata attachment");
    const first = vault.episodes.append(thread.id, {
      role: "attachment",
      content: "oversized-first.txt",
      blob: { bytes, mime: "text/plain", name: "oversized-first.txt" },
    });
    const second = vault.episodes.append(thread.id, {
      role: "attachment",
      content: "oversized-second.txt",
      blob: { bytes, mime: "text/plain", name: "oversized-second.txt" },
    });
    const hash = first.meta.blob;
    if (typeof hash !== "string" || second.meta.blob !== hash) throw new Error("shared blob fixture");
    const size = vault.blobs.size(hash);
    if (size === null) throw new Error("shared blob row missing");

    const stats = { largeMetaRows: 0 };
    const originalQuery = Database.prototype.query;
    const rawQuery = originalQuery as unknown as (this: Database, sql: string, ...args: unknown[]) => unknown;
    const inspect = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const row of value) inspect(row);
        return;
      }
      const meta = (value as { meta?: unknown }).meta;
      if (typeof meta === "string" && Buffer.byteLength(meta, "utf8") > 64 * 1024) stats.largeMetaRows += 1;
    };
    Database.prototype.query = function (this: Database, sql: string, ...args: unknown[]) {
      const statement = rawQuery.call(this, sql, ...args) as Record<string, unknown>;
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property === "all" || property === "get") {
            return (...parameters: unknown[]) => {
              const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
              const result = method.apply(target, parameters);
              inspect(result);
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } as unknown as typeof originalQuery;
    let reopened: ReturnType<typeof openVault> | null = null;
    try {
      const noOp = forget(vault, thread.id, {
        seqs: removed.map((episode) => episode.seq),
        reason: "oversized metadata residency oracle",
      });
      expect(noOp.episodes).toEqual([]);

      expect(forget(vault, thread.id, { seqs: [first.seq] }).blobs).toEqual([]);
      const stage = vault.blobs.beginDelete();
      vault.blobs.stageDelete(stage, hash, size);
      vault.db.query("DELETE FROM blob WHERE hash = ?").run(hash);
      vault.db.close();

      reopened = openVault({ home: vault.home, fast: true });
      expect(reopened.blobs.get(hash)).not.toBeNull();
      reopened.close();
    } finally {
      Database.prototype.query = originalQuery;
      if (reopened !== null) reopened.close();
    }
    expect(stats.largeMetaRows).toBe(0);
  },
  { timeout: 120_000 },
);

test("attachment hash projections reject attacker-sized nested fields without hydration", () => {
  const { vault, thread } = tempVault();
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "nested-hash-field.txt",
    blob: { bytes: new TextEncoder().encode("nested hash field"), mime: "text/plain" },
  });
  const hash = attachment.meta.blob;
  if (typeof hash !== "string") throw new Error("nested hash fixture did not publish a blob hash");
  const oversizedHash = "a".repeat(1_000_000);
  vault.db
    .query("UPDATE episode SET meta = json_set(meta, '$.blob', ?) WHERE thread_id = ? AND seq = ?")
    .run(oversizedHash, thread.id, attachment.seq);

  const stats = { largeMetaRows: 0 };
  const originalQuery = Database.prototype.query;
  const rawQuery = originalQuery as unknown as (this: Database, sql: string, ...args: unknown[]) => unknown;
  const inspect = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const row of value) inspect(row);
      return;
    }
    const meta = (value as { meta?: unknown }).meta;
    if (typeof meta === "string" && Buffer.byteLength(meta, "utf8") > 64 * 1024) stats.largeMetaRows += 1;
  };
  Database.prototype.query = function (this: Database, sql: string, ...args: unknown[]) {
    const statement = rawQuery.call(this, sql, ...args) as Record<string, unknown>;
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "all" || property === "get") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const result = method.apply(target, parameters);
            inspect(result);
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } as unknown as typeof originalQuery;
  try {
    expect(() => vault.blobs.referenced(hash)).toThrow("attachment object hash is malformed");
    vault.db.query("DELETE FROM blob WHERE hash = ?").run(hash);
    const liveBlobReferences = (
      vault as unknown as { liveBlobReferences(hashes: readonly string[]): unknown }
    ).liveBlobReferences.bind(vault);
    expect(() => liveBlobReferences([hash])).toThrow("attachment object hash is malformed");
    expect(() => vault.blobs.assertDeletionObjectBudget([hash])).toThrow(
      "attachment object hash is malformed",
    );

    vault.db
      .query("UPDATE episode SET meta = json_set(meta, '$.blob', ?) WHERE thread_id = ? AND seq = ?")
      .run(hash, thread.id, attachment.seq);
    vault.db
      .query(
        "UPDATE episode SET meta = json_set(meta, '$.manifest.spans[0].objectHash', ?) " +
          "WHERE thread_id = ? AND seq = ?",
      )
      .run(oversizedHash, thread.id, attachment.seq);
    expect(() => vault.blobs.assertDeletionObjectBudget([hash])).toThrow("invalid span hash");
  } finally {
    Database.prototype.query = originalQuery;
  }
  expect(stats.largeMetaRows).toBe(0);
});

test("forget rejects the first over-cap manifest span before redaction", () => {
  const { vault, thread } = tempVault();
  const episodes = [
    vault.episodes.append(thread.id, {
      role: "attachment",
      content: "over-cap-a.bin",
      blob: { bytes: new TextEncoder().encode("over-cap fixture A"), mime: "application/octet-stream" },
    }),
    vault.episodes.append(thread.id, {
      role: "attachment",
      content: "over-cap-b.bin",
      blob: { bytes: new TextEncoder().encode("over-cap fixture B"), mime: "application/octet-stream" },
    }),
  ];
  const spanCount = Math.floor(MAX_FORGET_DELETION_OBJECTS / 2) + 1;
  for (const [episodeIndex, episode] of episodes.entries()) {
    const manifest = episode.meta.manifest;
    if (manifest === undefined) throw new Error("manifest fixture");
    const spans = Array.from({ length: spanCount }, (_, index) => ({
      objectHash: (episodeIndex * spanCount + index).toString(16).padStart(64, "0"),
    }));
    vault.db
      .query("UPDATE episode SET meta = ? WHERE thread_id = ? AND seq = ?")
      .run(JSON.stringify({ ...episode.meta, manifest: { ...manifest, spans } }), thread.id, episode.seq);
  }

  expect(() => forget(vault, thread.id, { seqs: episodes.map((episode) => episode.seq) })).toThrow(
    /forget attachment objects exceed bounded capacity/,
  );
  for (const episode of episodes)
    expect(vault.episodes.get(thread.id, episode.seq)?.meta.removed).toBeUndefined();
  expect(vault.tombstones.list(thread.id)).toHaveLength(0);
  for (const episode of episodes) expect(vault.blobs.get(episode.meta.blob as string)).not.toBeNull();
});

test("deletion recovery rejects an oversized journal before resolving live references", () => {
  const { vault } = tempVault();
  const root = join(vault.objectsDir, ".delete-pending");
  const stage = join(root, "delete-over-cap");
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const entries = Array.from({ length: MAX_BLOB_DELETION_ENTRIES + 1 }, (_, index) => ({
    hash: index.toString(16).padStart(64, "0"),
    size: 0,
  }));
  writeFileSync(join(stage, "journal.json"), JSON.stringify({ v: 1, state: "prepared", entries }), {
    mode: 0o600,
  });
  try {
    expect(() => recoverBlobDeletionsBatched(vault.objectsDir, () => new Map())).toThrow(
      /blob deletion journal exceeds bounded capacity/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deletion recovery rejects an oversized journal before reading or resolving it", () => {
  const { vault } = tempVault();
  const root = join(vault.objectsDir, ".delete-pending");
  const stage = join(root, "delete-oversized-file");
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const journal = join(stage, "journal.json");
  writeFileSync(journal, "", { mode: 0o600 });
  truncateSync(journal, MAX_BLOB_DELETION_JOURNAL_BYTES + 1);
  let resolved = false;
  try {
    expect(() =>
      recoverBlobDeletionsBatched(vault.objectsDir, () => {
        resolved = true;
        return new Map();
      }),
    ).toThrow(/blob deletion journal exceeds byte capacity/);
    expect(resolved).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deletion recovery caps empty stages before collecting an unbounded directory", () => {
  const { vault } = tempVault();
  const root = join(vault.objectsDir, ".delete-pending");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const journal = JSON.stringify({ v: 1, state: "prepared", entries: [] });
  for (let index = 0; index <= MAX_BLOB_DELETION_STAGES; index += 1) {
    const stage = join(root, `delete-empty-${index}`);
    mkdirSync(stage, { mode: 0o700 });
    writeFileSync(join(stage, "journal.json"), journal, { mode: 0o600 });
  }
  let resolved = false;
  try {
    expect(() =>
      recoverBlobDeletionsBatched(vault.objectsDir, () => {
        resolved = true;
        return new Map();
      }),
    ).toThrow(/blob deletion stages exceed bounded capacity/);
    expect(resolved).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forget resolves all candidate attachment spans with one live-reference scan", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 96 }, (_, index) => ({
      role: "user" as const,
      content: `span scan filler ${index}`,
    })),
  );
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_SIZE * 2 + 17);
  bytes.fill(0x4a);
  const target = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "one-scan.bin",
    blob: { bytes, mime: "application/octet-stream" },
  });

  const stats = { reads: 0, rows: 0 };
  const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
  const originalQuery = db.query;
  const sourceSql = /COALESCE\(json_extract\(meta, '\$\.removed'\), 0\) != 1/iu;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (!sourceSql.test(sql)) return statement;
    return new Proxy(statement, {
      get(inner, property) {
        if (property === "all" || property === "iterate") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(inner, property, inner) as (...values: unknown[]) => unknown;
            const value = method.apply(inner, parameters);
            stats.reads += 1;
            if (property === "all") {
              stats.rows += Array.isArray(value) ? value.length : 0;
              return value;
            }
            return (function* () {
              for (const row of value as Iterable<unknown>) {
                stats.rows += 1;
                yield row;
              }
            })();
          };
        }
        const value = Reflect.get(inner, property, inner);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
  }) as typeof db.query;
  try {
    forget(vault, thread.id, { seqs: [target.seq] });
  } finally {
    db.query = originalQuery;
  }
  // A per-span `referenced()` implementation reads the same active archive
  // once for every manifest span.  The deletion planner must resolve all
  // candidate hashes through one bounded/keyset scan instead.
  expect(stats.reads).toBeLessThanOrEqual(2);
  expect(stats.rows).toBeLessThanOrEqual(194);
});

test("forget resolves a huge sparse range without enumerating its numeric span", () => {
  const { vault, thread } = tempVault();
  const first = vault.episodes.append(thread.id, { role: "user", content: "sparse endpoint one" });
  const second = vault.episodes.append(thread.id, { role: "user", content: "sparse endpoint two" });

  const result = forget(vault, thread.id, { range: [1, 1_000_000_000] });
  expect(result.episodes).toEqual([first.seq, second.seq]);
  expect(vault.episodes.get(thread.id, first.seq)?.meta.removed).toBe(true);
  expect(vault.episodes.get(thread.id, second.seq)?.meta.removed).toBe(true);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("forget rejects an over-cap target atomically before touching the archive", () => {
  const { vault, thread } = tempVault();
  const episodes = vault.episodes.appendMany(
    thread.id,
    Array.from({ length: MAX_FORGET_TARGETS + 1 }, (_, index) => ({
      role: "user" as const,
      content: `bounded forget target ${index}`,
    })),
  );
  expect(() =>
    forget(vault, thread.id, {
      seqs: episodes.map((episode) => episode.seq),
    }),
  ).toThrow(/forget target exceeds bounded capacity/);
  expect(vault.episodes.get(thread.id, episodes[0]?.seq ?? 1)?.meta.removed).toBeUndefined();
  expect(vault.tombstones.list(thread.id)).toHaveLength(0);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);

  expect(() => forget(vault, thread.id, { range: [1, MAX_FORGET_TARGETS + 1] })).toThrow(
    /forget range target exceeds bounded capacity/,
  );
  expect(vault.episodes.get(thread.id, episodes.at(-1)?.seq ?? 1)?.meta.removed).toBeUndefined();
  expect(vault.tombstones.list(thread.id)).toHaveLength(0);
});

test("forget's capsule lookup is source-targeted for far-apart endpoints", () => {
  const { vault, thread } = tempVault();
  const episodes = vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 4_096 }, (_, index) => ({
      role: "user" as const,
      content:
        index === 0
          ? "far endpoint alpha must be removed"
          : index === 4_095
            ? "far endpoint omega must be removed"
            : `capsule filler ${index}`,
    })),
  );
  compact(vault, thread.id, { budget: 8_192 });
  const capsules = vault.capsules as typeof vault.capsules;
  const originalGet = capsules.get;
  let hydrated = 0;
  capsules.get = ((id: string) => {
    hydrated += 1;
    return originalGet(id);
  }) as typeof originalGet;
  const first = episodes[0];
  const last = episodes.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("endpoint fixture did not produce episodes");
  }
  try {
    const result = forget(vault, thread.id, { seqs: [first.seq, last.seq] });
    expect(result.capsules).toBeGreaterThan(0);
  } finally {
    capsules.get = originalGet;
  }
  // A bounding-range lookup would hydrate every capsule between the endpoints;
  // source-targeted lookup needs only the two endpoint lineages.
  expect(hydrated).toBeLessThan(64);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test(
  "forget streams dense sibling source names in bounded pages",
  () => {
    const { vault, thread } = tempVault({ budget: 8_192 });
    const episodes = vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 2_048 }, (_, index) => ({
        role: "user" as const,
        content:
          index === 0
            ? Array.from(
                { length: 513 },
                (_, fact) => `Remember dense sibling fact ${fact}: value ${fact}.`,
              ).join(" ")
            : `Decision sibling ${index}: retain fact ${index}.`,
      })),
    );
    const dense = episodes[0];
    if (dense === undefined) throw new Error("dense sibling fixture did not produce a source");
    atomize(vault, thread.id, [dense.seq]);
    expect(vault.atoms.list(thread.id, { phase: "SUPPORTED", limit: 2_000 }).length).toBeGreaterThan(256);
    for (let pass = 0; pass < 80 && vault.capsules.at(thread.id, 2, 1) === null; pass += 1) {
      compact(vault, thread.id, { budget: 1_000_000 });
    }

    const upper = vault.capsules.at(thread.id, 2, 1);
    expect(upper).not.toBeNull();
    const parentChildren = vault.capsules.children(thread.id, 2, 1, 2_048);
    expect(parentChildren).toHaveLength(8);
    const siblingKeptEntries = parentChildren.reduce((total, child) => total + child.kept.length, 0);
    expect(siblingKeptEntries).toBeGreaterThan(256);

    const atoms = vault.atoms as typeof vault.atoms;
    const episodesStore = vault.episodes as typeof vault.episodes;
    const capsules = vault.capsules as typeof vault.capsules;
    const originalAtomPage = atoms.inRangeForMigration;
    const originalAtomRange = atoms.inRange;
    const originalEpisodeRange = episodesStore.range;
    const originalChildren = capsules.children;
    let atomPages = 0;
    let atomRows = 0;
    let largestAtomPage = 0;
    let episodeRanges = 0;
    let largestEpisodeRange = 0;
    let childQueries = 0;
    let largestChildSet = 0;
    atoms.inRangeForMigration = ((threadId, from, to, afterRowid, limit) => {
      const page = originalAtomPage(threadId, from, to, afterRowid, limit);
      atomPages += 1;
      atomRows += page.atoms.length;
      largestAtomPage = Math.max(largestAtomPage, page.atoms.length);
      return page;
    }) as typeof originalAtomPage;
    atoms.inRange = (() => {
      throw new Error("dense sibling oracle: unbounded atom range");
    }) as typeof originalAtomRange;
    episodesStore.range = ((threadId, from, to, limit) => {
      const rows = originalEpisodeRange(threadId, from, to, limit);
      episodeRanges += 1;
      largestEpisodeRange = Math.max(largestEpisodeRange, rows.length);
      return rows;
    }) as typeof originalEpisodeRange;
    capsules.children = ((threadId, level, from, to) => {
      const children = originalChildren(threadId, level, from, to);
      childQueries += 1;
      largestChildSet = Math.max(largestChildSet, children.length);
      return new Proxy(children, {
        get(target, property, receiver) {
          if (property === "flatMap") throw new Error("dense sibling oracle: flatMap allocation");
          return Reflect.get(target, property, receiver);
        },
      });
    }) as typeof originalChildren;
    try {
      const result = forget(vault, thread.id, {
        seqs: [dense.seq],
        reason: "dense sibling allocation oracle",
      });
      expect(result.episodes).toEqual([dense.seq]);
      expect(result.capsules).toBeGreaterThan(0);
      expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
    } finally {
      atoms.inRangeForMigration = originalAtomPage;
      atoms.inRange = originalAtomRange;
      episodesStore.range = originalEpisodeRange;
      capsules.children = originalChildren;
    }

    // The dense leaf is paged through the migration API, never selected as one
    // all-atom range; source episodes use scalar one-row projections instead of
    // hydrating any range; and upper capsules visit their bounded fanout.
    expect(atomRows).toBeGreaterThan(256);
    expect(atomPages).toBeGreaterThan(1);
    expect(largestAtomPage).toBeLessThanOrEqual(128);
    expect(episodeRanges).toBe(0);
    expect(largestEpisodeRange).toBe(0);
    expect(childQueries).toBeGreaterThan(0);
    expect(largestChildSet).toBeLessThanOrEqual(8);
  },
  { timeout: 120_000 },
);

test("forget scans packet messages exhaustively in bounded pages", () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "packet rows must clear this exact forget marker",
  });
  const base = compile(vault, thread.id, { query: "packet rows must clear this exact forget marker" });
  const total = 1_024;
  for (let index = 0; index < total; index += 1) {
    vault.packets.insert({ ...base, id: `packet-bound-${index}` }, "pending");
  }
  const result = forget(vault, thread.id, { seqs: [source.seq] });
  expect(result.packets).toBe(total);
  expect(
    vault.db
      .query("SELECT COUNT(*) AS n FROM packet WHERE thread_id = ? AND messages IS NOT NULL")
      .get(thread.id),
  ).toEqual({ n: 0 });
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("forget packet scan keeps large message pages scalar-only", () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "large packet rows must clear without hydrating a page",
  });
  const base = compile(vault, thread.id, { query: source.content });
  const message = JSON.stringify([
    {
      role: "assistant",
      content: "large packet payload ".repeat(2_048),
    },
  ]);
  expect(Buffer.byteLength(message, "utf8")).toBeGreaterThan(32 * 1024);
  expect(Buffer.byteLength(message, "utf8")).toBeLessThan(1_572_864);
  const total = 256;
  for (let index = 0; index < total; index += 1) {
    vault.packets.insert({ ...base, id: `packet-large-${index}`, turnSeq: source.seq }, "pending");
    vault.db.query("UPDATE packet SET messages = ? WHERE id = ?").run(message, `packet-large-${index}`);
  }

  const stats = { hydratedRows: 0, hydratedBytes: 0 };
  const originalQuery = Database.prototype.query;
  const rawQuery = originalQuery as unknown as (this: Database, sql: string, ...args: unknown[]) => unknown;
  Database.prototype.query = function (this: Database, sql: string, ...args: unknown[]) {
    const statement = rawQuery.call(this, sql, ...args) as Record<string, unknown>;
    if (!/SELECT rowid,.*FROM packet/isu.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property !== "all") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...parameters: unknown[]) => {
          const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
          const rows = method.apply(target, parameters);
          if (Array.isArray(rows)) {
            for (const row of rows) {
              if (row !== null && typeof row === "object" && "messages" in row) {
                const messages = (row as { messages?: unknown }).messages;
                if (typeof messages === "string") {
                  stats.hydratedRows += 1;
                  stats.hydratedBytes += Buffer.byteLength(messages, "utf8");
                }
              }
            }
          }
          return rows;
        };
      },
    });
  } as unknown as typeof originalQuery;
  try {
    expect(forget(vault, thread.id, { seqs: [source.seq] }).packets).toBe(total);
  } finally {
    Database.prototype.query = originalQuery;
  }
  expect(stats.hydratedRows).toBe(0);
  expect(stats.hydratedBytes).toBe(0);
  expect(
    vault.db
      .query("SELECT COUNT(*) AS n FROM packet WHERE thread_id = ? AND messages IS NOT NULL")
      .get(thread.id),
  ).toEqual({ n: 0 });
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
