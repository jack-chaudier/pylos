import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import {
  MAX_THREAD_ID_BYTES,
  MAX_THREAD_MODEL_BYTES,
  MAX_THREAD_SETTINGS_BYTES,
  MAX_THREAD_TITLE_BYTES,
} from "@pylos/protocol";
import { chainHash, chainRecord, metaHashOf, sha256 } from "../src/index.ts";
import { stats } from "../src/stats.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

test("thread list projects only bounded cursor fields and primary does not scan every thread", () => {
  const queries: string[] = [];
  const databasePrototype = Database.prototype as unknown as { prepare: (sql: string) => unknown };
  const originalPrepare = databasePrototype.prepare;
  databasePrototype.prepare = function (this: Database, sql: string) {
    if (/FROM thread\b/u.test(sql)) queries.push(sql);
    return originalPrepare.call(this, sql);
  };
  const { vault } = tempVault();
  try {
    expect(vault.threads.listPage({ limit: 1 }).threads).toHaveLength(1);
    expect(vault.threads.runtime(vault.threads.listPage({ limit: 1 }).threads[0]?.id ?? "")).toBeDefined();
    expect(vault.threads.primary().id).toBeDefined();
  } finally {
    databasePrototype.prepare = originalPrepare;
  }
  const listProjection = queries.find((sql) => /ORDER BY created_at DESC/u.test(sql));
  expect(listProjection).toBeDefined();
  expect(listProjection).toContain(`length(CAST(id AS BLOB))`);
  expect(listProjection).not.toMatch(/SELECT\s+\*/iu);
  expect(listProjection).toContain("LIMIT ?");
  const runtimeProjection = queries.find((sql) => /settings_bytes/u.test(sql));
  expect(runtimeProjection).toBeDefined();
  expect(runtimeProjection).not.toMatch(/SELECT\s+\*/iu);
  expect(MAX_THREAD_ID_BYTES).toBeGreaterThan(0);
});

test("thread stats reject oversized legacy title and model fields before hydration", () => {
  const { vault, thread } = tempVault();
  vault.db
    .query("UPDATE thread SET title = ? WHERE id = ?")
    .run("x".repeat(MAX_THREAD_TITLE_BYTES + 1), thread.id);
  expect(() => stats(vault, thread.id)).toThrow(/title/u);

  vault.db.query("UPDATE thread SET title = ? WHERE id = ?").run("bounded", thread.id);
  vault.db
    .query("UPDATE thread SET settings = ? WHERE id = ?")
    .run(JSON.stringify({ oversized: "x".repeat(MAX_THREAD_SETTINGS_BYTES) }), thread.id);
  expect(() => vault.threads.runtime(thread.id)).toThrow(/settings/u);
  vault.db.query("UPDATE thread SET settings = ? WHERE id = ?").run("{}", thread.id);
  vault.episodes.append(thread.id, {
    role: "assistant",
    content: "a model field boundary",
    model: "m".repeat(MAX_THREAD_MODEL_BYTES + 1),
  });
  expect(() => stats(vault, thread.id)).toThrow(/model/u);
});

test("thread title updates keep the same UTF-8 boundary as creation", () => {
  const { vault, thread } = tempVault();
  const exact = "😀".repeat(MAX_THREAD_TITLE_BYTES / 4);
  vault.threads.setTitle(thread.id, exact);
  expect(vault.threads.get(thread.id)?.title).toBe(exact);
  expect(() => vault.threads.setTitle(thread.id, `${exact}x`)).toThrow(/title/u);
  expect(vault.threads.get(thread.id)?.title).toBe(exact);
});

test("last spoken model uses a scalar bounded projection over the indexed speaker rows", () => {
  const { vault, thread } = tempVault();
  const giant = "x".repeat(8 * 1024 * 1024);
  // Ordinary appends correctly reject content beyond the capsule-source
  // admission bound. Model lookup must nevertheless remain safe for legacy
  // imported rows that predate that bound, so install one chain-consistent
  // oversized row through the same scalar fields an importer authenticates.
  const legacyMeta = { legalImportedMetadata: giant };
  const legacySeq = thread.headSeq + 1;
  const legacyTs = Date.now();
  const legacyContentHash = sha256(giant);
  const legacyHash = chainHash(
    thread.headHash,
    chainRecord({
      seq: legacySeq,
      ts: legacyTs,
      role: "assistant",
      model: "window-model",
      contentHash: legacyContentHash,
      metaHash: metaHashOf(legacyMeta),
    }),
  );
  const legacyInsert = vault.db
    .query(
      "INSERT INTO episode (seq, thread_id, ts, role, model, provider, content, content_hash, tokens, prev_hash, hash, meta) " +
        "VALUES (?, ?, ?, 'assistant', ?, NULL, ?, ?, 1, ?, ?, ?)",
    )
    .run(
      legacySeq,
      thread.id,
      legacyTs,
      "window-model",
      giant,
      legacyContentHash,
      thread.headHash,
      legacyHash,
      JSON.stringify(legacyMeta),
    );
  vault.db
    .query("INSERT INTO episode_fts (rowid, content) VALUES (?, ?)")
    .run(Number(legacyInsert.lastInsertRowid), giant);
  vault.db
    .query("UPDATE thread SET head_seq = ?, head_hash = ? WHERE id = ?")
    .run(legacySeq, legacyHash, thread.id);
  // Mark the imported row as already audited by the legacy readiness pass so
  // subsequent ordinary appends can add the non-speaker gap for this oracle.
  vault.db
    .query(
      "INSERT OR REPLACE INTO capsule_source_readiness " +
        "(thread_id, status, checked_through, seq, reason, checked_at) VALUES (?, 'ready', ?, NULL, NULL, ?)",
    )
    .run(thread.id, legacySeq, Date.now());
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 512 }, (_, index) => ({
      role: "user" as const,
      content: `window filler ${index}`,
    })),
  );

  const database = vault.db as unknown as { prepare: (sql: string) => unknown };
  const originalPrepare = database.prepare;
  const queries: string[] = [];
  database.prepare = ((sql: string) => {
    queries.push(sql);
    return originalPrepare.call(vault.db, sql);
  }) as typeof database.prepare;
  try {
    const episodes = vault.episodes as unknown as {
      lastSpokenModel?: (threadId: string) => string | undefined;
    };
    expect(episodes.lastSpokenModel).toBeFunction();
    // Non-speaker rows do not hide a prior assistant, even after a large gap.
    expect(episodes.lastSpokenModel?.(thread.id)).toBe("window-model");

    vault.episodes.append(thread.id, {
      role: "assistant",
      content: "latest answer",
      model: "latest-model",
    });
    expect(episodes.lastSpokenModel?.(thread.id)).toBe("latest-model");

    vault.db
      .query(
        "UPDATE episode SET model = ? WHERE thread_id = ? AND seq = (SELECT MAX(seq) FROM episode WHERE thread_id = ?)",
      )
      .run("m".repeat(MAX_THREAD_MODEL_BYTES + 1), thread.id, thread.id);
    // Oversized model identifiers are not partially returned and cannot fall
    // back to an older speaker: the safe answer is no speaker.
    expect(episodes.lastSpokenModel?.(thread.id)).toBeUndefined();
  } finally {
    database.prepare = originalPrepare;
  }

  const scalar = queries.find((sql) => /FROM episode\b/u.test(sql));
  expect(scalar).toBeDefined();
  expect(scalar).not.toMatch(/SELECT\s+\*/iu);
  expect(scalar).toContain("length(CAST");
  expect(scalar).toMatch(/\bmodel\b/iu);
  expect(scalar).not.toMatch(/\bcontent\b|\bmeta\b|\bprovider\b|\btokens\b|\bhash\b/iu);
  expect(scalar).not.toMatch(/head_seq|JOIN\s+thread/iu);
  expect(scalar).toMatch(/role\s*=\s*['"]assistant['"]/iu);
  expect(scalar).toMatch(/ORDER BY[\s\S]*seq\s+DESC/iu);
  expect(scalar).toMatch(/LIMIT\s+1/iu);
  const plan = vault.db
    .query(`EXPLAIN QUERY PLAN ${scalar}`)
    .all(MAX_THREAD_MODEL_BYTES, thread.id) as Array<{ detail?: string }>;
  expect(plan.map((row) => row.detail ?? "").join(" ")).toMatch(/episode_thread_role_seq|USING INDEX/iu);
});
