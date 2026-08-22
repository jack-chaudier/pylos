import { afterAll, expect, test } from "bun:test";
import { genesisHash, verify } from "../src/index.ts";
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
