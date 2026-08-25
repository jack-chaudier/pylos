import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINT_EVERY,
  canonicalHash,
  chainHash,
  chainRecord,
  forget,
  genesisHash,
  metaHashOf,
  openVault,
  type Provider,
  runTurn,
  sha256,
  stats,
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

test("full verification rejects a deleted and rechained middle sequence", () => {
  const { vault, thread } = tempVault();
  const [first, _second, third] = vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 3 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  if (first === undefined || third === undefined) throw new Error("chain gap fixture was not created");

  const forgedHash = chainHash(
    first.hash,
    chainRecord({
      seq: third.seq,
      ts: third.ts,
      role: third.role,
      contentHash: sha256(third.content),
      metaHash: metaHashOf(third.meta),
    }),
  );
  vault.db.query("DELETE FROM episode WHERE thread_id = ? AND seq = 2").run(thread.id);
  vault.db
    .query("UPDATE episode SET prev_hash = ?, hash = ? WHERE thread_id = ? AND seq = 3")
    .run(first.hash, forgedHash, thread.id);
  vault.db.query("UPDATE thread SET head_hash = ? WHERE id = ?").run(forgedHash, thread.id);

  const result = verify(vault, thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.checkedTo).toBe(1);
  expect(result.failedAt).toBe(3);
  expect(result.reason).toMatch(/episode.*sequence|sequence.*gap/i);
});

test("full verification rejects a missing tail with a forged head and head sequence", () => {
  const { vault, thread } = tempVault();
  const episodes = vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 3 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  const second = episodes[1];
  if (second === undefined) throw new Error("chain tail fixture was not created");

  vault.db.query("DELETE FROM episode WHERE thread_id = ? AND seq = 3").run(thread.id);
  vault.db.query("UPDATE thread SET head_seq = 2, head_hash = ? WHERE id = ?").run(second.hash, thread.id);

  const result = verify(vault, thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/episode.*count|head.*sequence|sequence.*head/i);
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

test("checkpoint verification rejects a gap immediately before its anchor", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 4_100 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  vault.db.query("DELETE FROM episode WHERE thread_id = ? AND seq = 4095").run(thread.id);

  const result = verify(vault, thread.id);
  expect(result.ok).toBe(false);
  expect(result.checkedFrom).toBe(4096);
  expect(result.reason).toMatch(/checkpoint.*predecessor|episode.*count|sequence.*gap/i);
});

test("checkpoint verification rejects a gap immediately after its anchor", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 4_100 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  vault.db.query("DELETE FROM episode WHERE thread_id = ? AND seq = 4097").run(thread.id);

  const result = verify(vault, thread.id);
  expect(result.ok).toBe(false);
  expect(result.checkedFrom).toBe(4096);
  expect(result.failedAt).toBe(4098);
  expect(result.reason).toMatch(/episode.*sequence|sequence.*gap/i);
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
    // Later migrations index this column. SQLite cannot drop a column while a
    // dependent index remains, so remove the modern derived index as part of
    // constructing the intentionally pre-008 fixture.
    raw.exec("DROP INDEX IF EXISTS tombstone_thread_removal");
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

test("the verified frontier records what a pass certified, and no more", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 5 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  expect(vault.verifiedFrontier(thread.id)).toBe(0);
  expect(stats(vault, thread.id).verifiedTo).toBeUndefined();

  expect(verify(vault, thread.id).ok).toBe(true);
  expect(vault.verifiedFrontier(thread.id)).toBe(5);
  expect(stats(vault, thread.id).verifiedTo).toBe(5);

  // Later turns are unverified until someone verifies them.
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 3 }, (_, i) => ({ role: "user" as const, content: `later ${i}` })),
  );
  expect(vault.verifiedFrontier(thread.id)).toBe(5);
  const after = stats(vault, thread.id);
  expect(after.verifiedTo).toBe(5);
  expect(after.turns).toBe(8);

  const again = verify(vault, thread.id);
  expect(again.ok).toBe(true);
  expect(vault.verifiedFrontier(thread.id)).toBe(again.checkedTo);
  expect(stats(vault, thread.id).verifiedTo).toBe(8);
});

test("a checkpoint the writer left is not a claim that anything was verified", () => {
  const { vault, thread } = tempVault();
  for (let batch = 0; batch < 5; batch += 1) {
    vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 1000 }, (_, i) => ({ role: "user" as const, content: `turn ${batch}-${i}` })),
    );
  }
  // Appending past 4,096 leaves a checkpoint a replay may resume from...
  expect(vault.checkpointBefore(thread.id, 5000)?.seq).toBe(CHECKPOINT_EVERY);
  // ...which says nothing about verification.
  expect(vault.verifiedFrontier(thread.id)).toBe(0);
  expect(stats(vault, thread.id).verifiedTo).toBeUndefined();

  const result = verify(vault, thread.id);
  expect(result.checkedFrom).toBe(CHECKPOINT_EVERY);
  expect(vault.verifiedFrontier(thread.id)).toBe(5000);
});

test("a failed verify withdraws the frontier it had certified", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  expect(vault.verifiedFrontier(thread.id)).toBe(20);

  vault.db
    .query("UPDATE episode SET content = ? WHERE thread_id = ? AND seq = ?")
    .run("turn 5 (edited)", thread.id, 6);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(false);
  expect(vault.verifiedFrontier(thread.id)).toBe(0);
  expect(stats(vault, thread.id).verifiedTo).toBeUndefined();
});

test("the frontier is refused when the row it anchors on changed", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  expect(vault.verifiedFrontier(thread.id)).toBe(10);

  // The same rule an incremental verify applies to a checkpoint anchor: the
  // certified hash must still be the one stored at that seq.
  vault.db
    .query("UPDATE episode SET hash = ? WHERE thread_id = ? AND seq = ?")
    .run("f".repeat(64), thread.id, 10);
  expect(vault.verifiedFrontier(thread.id)).toBe(0);
});

test("the frontier stops counting when the head is rewound behind it", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 4 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  expect(verify(vault, thread.id).ok).toBe(true);
  expect(vault.verifiedFrontier(thread.id)).toBe(4);
  vault.db.query("UPDATE thread SET head_seq = head_seq - 1 WHERE id = ?").run(thread.id);
  // A truncated tail puts the record beyond the head, so it stops counting.
  expect(vault.verifiedFrontier(thread.id)).toBe(0);
});

test("verifying an unchanged chain again writes nothing", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `turn ${i}` })),
  );
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  const settled = stats(vault, thread.id).archiveBytes;
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  expect(stats(vault, thread.id).archiveBytes).toBe(settled);
});
