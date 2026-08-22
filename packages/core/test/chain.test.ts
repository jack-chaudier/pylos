import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalHash,
  chainHash,
  chainRecord,
  forget,
  genesisHash,
  openVault,
  type Provider,
  runTurn,
  sha256,
  verify,
} from "../src/index.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

test("the hash chain links every episode from genesis", () => {
  const { vault, thread } = tempVault();
  const first = vault.episodes.append(thread.id, { role: "user", content: "hello" });
  expect(first.prevHash).toBe(genesisHash(thread.id));
  const second = vault.episodes.append(thread.id, { role: "assistant", content: "hi" });
  expect(second.prevHash).toBe(first.hash);
  expect(vault.threads.get(thread.id)?.headHash).toBe(second.hash);
  expect(verify(vault, thread.id).ok).toBe(true);
});

test("verify replays a long chain and reports how far it checked", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 500 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  const result = verify(vault, thread.id, { full: true });
  expect(result.ok).toBe(true);
  expect(result.checkedTo).toBe(500);
  expect(result.checkedFrom).toBe(0);
});

test("tampering with stored content is detected", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  vault.db
    .query("UPDATE episode SET content = ? WHERE thread_id = ? AND seq = ?")
    .run("turn 5 (edited)", thread.id, 6);
  const result = verify(vault, thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.failedAt).toBe(6);
  expect(result.reason).toBe("content does not match content_hash");
});

test("tampering with a chain hash is detected", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  vault.db
    .query("UPDATE episode SET hash = ? WHERE thread_id = ? AND seq = ?")
    .run("0".repeat(64), thread.id, 4);
  const result = verify(vault, thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.failedAt).toBe(4);
});

test("reordering the archive breaks prev_hash", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 8 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  vault.db
    .query("UPDATE episode SET prev_hash = ? WHERE thread_id = ? AND seq = 5")
    .run("f".repeat(64), thread.id);
  const result = verify(vault, thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe("prev_hash mismatch");
});

test("checkpoints let verification start mid-chain", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 4200 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  const incremental = verify(vault, thread.id);
  expect(incremental.ok).toBe(true);
  expect(incremental.checkedFrom).toBe(4096);
  expect(verify(vault, thread.id, { full: true }).checkedFrom).toBe(0);
});

test("the receipts of a turn are inside the chain (KERNEL A10.3)", async () => {
  const { vault, thread } = tempVault();
  const provider: Provider = async function* () {
    yield { type: "delta", text: "done." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, { text: "hello", model: "m", provider, budget: 8192 });
  expect(result.assistantEpisode.meta.roundsDigest?.length).toBe(64);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);

  // Rewriting what the check said, or which packet answered, breaks the chain.
  const meta = {
    ...result.assistantEpisode.meta,
    check: { names: ["x"], status: "confirmed", draftSha256: "" },
  };
  vault.db
    .query("UPDATE episode SET meta = ? WHERE thread_id = ? AND seq = ?")
    .run(JSON.stringify(meta), thread.id, result.assistantEpisode.seq);
  const tampered = verify(vault, thread.id, { full: true });
  expect(tampered.ok).toBe(false);
  expect(tampered.failedAt).toBe(result.assistantEpisode.seq);
});

test("an episode written before the receipts were chained still verifies (KERNEL A10.3)", () => {
  const { vault, thread } = tempVault();
  // v1.1 shape: `packetId` and `check` in meta, no `roundsDigest`.
  const episode = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "an answer from before the amendment",
    model: "m",
    meta: { packetId: "pk_old", usage: { inputTokens: 1, outputTokens: 1 } },
  });
  // Hashed exactly as v1.1 hashed it: the receipts are not in the pick.
  const v11Pick = ["blob", "mime", "name", "size", "from", "to"] as const;
  const picked: Record<string, unknown> = {};
  for (const key of v11Pick) {
    const value = episode.meta[key];
    if (value !== undefined) picked[key] = value;
  }
  expect(episode.hash).toBe(
    chainHash(
      episode.prevHash,
      chainRecord({
        seq: episode.seq,
        ts: episode.ts,
        role: "assistant",
        model: "m",
        contentHash: sha256(episode.content),
        metaHash: canonicalHash(picked),
      }),
    ),
  );
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});
test("a `removed` flag set by hand does not skip the content check", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  // The flag is outside meta_hash, so the chain still links; only the removal
  // record can license skipping sha256(content) === content_hash (KERNEL A10.6).
  vault.db
    .query("UPDATE episode SET content = ?, meta = ? WHERE thread_id = ? AND seq = ?")
    .run("⟦removed by user⟧", '{"removed":true}', thread.id, 5);
  const result = verify(vault, thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.failedAt).toBe(5);
  expect(result.reason).toBe("removed without a tombstone");
});

test("a tombstone with no chain-bound removal record is refused", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  vault.db
    .query("INSERT INTO tombstone (id, thread_id, target, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("tb_forged", thread.id, "seqs:5", "forged", Date.now());
  vault.db
    .query("UPDATE episode SET content = ?, meta = ? WHERE thread_id = ? AND seq = ?")
    .run("⟦removed by user⟧", '{"removed":true,"tombstone":"tb_forged"}', thread.id, 5);
  const result = verify(vault, thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe("removed without a chain-bound removal record");
});

test("forget's removal record is what makes a removed episode verify", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  const result = forget(vault, thread.id, { seqs: [5] });
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);

  // Unbind the tombstone from its chain event: the removal is no longer proven.
  vault.db.query("UPDATE tombstone SET removal_seq = NULL WHERE id = ?").run(result.tombstoneId);
  expect(verify(vault, thread.id, { full: true }).reason).toBe(
    "removed without a chain-bound removal record",
  );

  // A removal from before the amendment carries 0 and is accepted as legacy.
  vault.db.query("UPDATE tombstone SET removal_seq = 0 WHERE id = ?").run(result.tombstoneId);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("a vault whose removals predate the amendment still verifies", () => {
  const home = mkdtempSync(join(tmpdir(), "pylos-legacy-"));
  const file = join(home, "vault.sqlite");
  try {
    const vault = openVault({ home, file, fast: true });
    const thread = vault.threads.create("Legacy", { budget: 8192 });
    vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
    );
    const result = forget(vault, thread.id, { seqs: [3] });
    vault.close();

    // Rewind the vault to before migration 008: a tombstone, a removed episode,
    // and no column to record a chain event in.
    const raw = new Database(file, { readwrite: true });
    raw.exec("ALTER TABLE tombstone DROP COLUMN removal_seq");
    raw.exec("ALTER TABLE tombstone DROP COLUMN echoes");
    raw.query("DELETE FROM migration WHERE name = ?").run("008-removal-record");
    raw.close();

    const reopened = openVault({ home, file, fast: true });
    expect(reopened.tombstones.get(result.tombstoneId)?.removalSeq).toBe(0);
    expect(verify(reopened, thread.id, { full: true }).ok).toBe(true);
    reopened.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
