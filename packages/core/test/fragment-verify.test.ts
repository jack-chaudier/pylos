import { afterAll, expect, test } from "bun:test";
import { exportBundle, importBundle, stats, verify } from "../src/index.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

test("verify reports authenticated fragment continuity without claiming a full chain", async () => {
  const source = tempVault();
  source.vault.episodes.appendMany(
    source.thread.id,
    Array.from({ length: 5 }, (_, index) => ({
      role: "user" as const,
      content: `authenticated fragment row ${index + 1}`,
    })),
  );
  const passphrase = "fragment verify oracle";
  const bundle = await exportBundle(source.vault, source.thread.id, {
    passphrase,
    range: [2, 4],
  });
  const target = tempVault();
  const imported = await importBundle(target.vault, bundle, { passphrase });

  const verified = verify(target.vault, imported.threadId, { full: true });
  expect(verified).toMatchObject({
    ok: false,
    fragmentVerified: true,
    checkedFrom: 1,
    checkedTo: 4,
    fragment: {
      originalThreadId: source.thread.id,
      fromSeq: 2,
      toSeq: 4,
      headHash: imported.headHash,
    },
  });
  expect(verified.reason).toMatch(/fragment verified.*genesis/iu);
  // A fragment is authenticated between its own bounds, so it never records a
  // frontier a reader could mistake for genesis continuity.
  expect(target.vault.verifiedFrontier(imported.threadId)).toBe(0);
  expect(stats(target.vault, imported.threadId).verifiedTo).toBeUndefined();

  target.vault.db
    .query("UPDATE thread_fragment SET prev_hash = ? WHERE thread_id = ?")
    .run("0".repeat(64), imported.threadId);
  const tampered = verify(target.vault, imported.threadId, { full: true });
  expect(tampered.ok).toBe(false);
  expect(tampered.fragmentVerified).toBe(false);
  expect(tampered.reason).toMatch(/fragment prev_hash mismatch/iu);
});
