import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { MAX_THREAD_MODEL_BYTES } from "@pylos/protocol";
import { openVault } from "../src/index.ts";
import { stats } from "../src/stats.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

test("stats reads only scalar packet summary fields for a high-payload packet", () => {
  const { vault, thread } = tempVault();
  const digest = "a".repeat(64);
  const huge = "x".repeat(2_000_000);
  vault.db
    .query(
      "INSERT INTO packet (id, thread_id, turn_seq, model, budget, tokens, digest, status, compiler_version, messages, resident, ledger, pages, rounds, reachability, reachability_as_of_seq, coverage, evidence, answer_receipt, semantic, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?, ?, '[]', ?, ?, '[]', NULL, NULL, ?, NULL, NULL, NULL, ?)",
    )
    .run(
      "packet-high-payload",
      thread.id,
      1,
      "oracle-model",
      8192,
      123,
      digest,
      "v2",
      JSON.stringify([{ role: "user", content: huge }]),
      JSON.stringify({ count: 1, residentNames: [], historical: [] }),
      JSON.stringify([{ trigger: "search", seqs: [], tokens: 1, latencyMs: 0, resolved: false }]),
      huge,
      Date.now(),
    );

  const database = vault.db as unknown as { prepare: (sql: string) => unknown };
  const originalPrepare = database.prepare;
  let packetProjection: string | undefined;
  database.prepare = ((sql: string) => {
    if (/\bFROM packet\b/u.test(sql)) {
      packetProjection = sql;
      if (/SELECT\s+\*/iu.test(sql)) throw new Error("stats allocated the full packet row");
      expect(sql).toContain("json_array_length");
    }
    return originalPrepare.call(vault.db, sql);
  }) as typeof database.prepare;
  try {
    const summary = stats(vault, thread.id);
    expect(summary.lastPacket).toEqual({ tokens: 123, budget: 8192, pages: 1, digest });
  } finally {
    database.prepare = originalPrepare;
  }
  expect(packetProjection).toBeDefined();
});

test("stats fails closed when the last packet page JSON is malformed", () => {
  const { vault, thread } = tempVault();
  const digest = "b".repeat(64);
  vault.db
    .query(
      "INSERT INTO packet (id, thread_id, turn_seq, model, budget, tokens, digest, status, compiler_version, messages, resident, ledger, pages, rounds, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?, NULL, '[]', ?, ?, '[]', ?)",
    )
    .run(
      "packet-malformed-pages",
      thread.id,
      1,
      "oracle-model",
      8192,
      123,
      digest,
      "v2",
      JSON.stringify({ count: 0, residentNames: [], historical: [] }),
      "not-json-array",
      Date.now(),
    );

  expect(stats(vault, thread.id).lastPacket).toBeUndefined();
});

test("stats keeps older distinct models after many duplicate recent rows", () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "assistant", content: "older model", model: "older-model" });
  for (let index = 0; index < 40; index += 1) {
    vault.episodes.append(thread.id, {
      role: "assistant",
      content: `recent ${index}`,
      model: "recent-model",
    });
  }
  expect(stats(vault, thread.id).models).toEqual(["older-model", "recent-model"]);
});

test("stats model history includes only assistant speakers", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(thread.id, [
    { role: "user", content: "user-attached model", model: "user-model" },
    { role: "tool", content: "tool-attached model", model: "tool-model" },
  ]);

  expect(stats(vault, thread.id).models).toEqual([]);
});

test("stats reads the bounded indexed model summary instead of scanning episodes", () => {
  const { vault, thread } = tempVault();
  for (let index = 0; index < 96; index += 1) {
    vault.episodes.append(thread.id, {
      role: "assistant",
      content: `distinct model ${index}`,
      model: `model-${index}`,
    });
  }

  const plan = vault.db
    .query(
      "EXPLAIN QUERY PLAN SELECT model FROM thread_model " +
        "WHERE thread_id = ? ORDER BY first_rowid ASC LIMIT 33",
    )
    .all(thread.id) as Array<{ detail: string }>;
  const planText = plan.map((row) => row.detail).join(" ");
  expect(planText).toMatch(/thread_model_first|sqlite_autoindex_thread_model/iu);
  expect(planText).not.toMatch(/SCAN episode/iu);

  const database = vault.db as unknown as { prepare: (sql: string) => unknown };
  const originalPrepare = database.prepare;
  const observed: string[] = [];
  database.prepare = ((sql: string) => {
    if (/\bFROM (?:episode|thread_model|thread_model_state)\b/iu.test(sql)) observed.push(sql);
    // The selected-model fallback is one indexed assistant-row lookup. Reject
    // any archive projection while allowing that bounded scalar query.
    if (/\bFROM episode\b/iu.test(sql) && !/ORDER BY[\s\S]*seq\s+DESC[\s\S]*LIMIT\s+1/iu.test(sql)) {
      throw new Error("stats scanned episode archive");
    }
    return originalPrepare.call(vault.db, sql);
  }) as typeof database.prepare;
  try {
    expect(stats(vault, thread.id).models).toHaveLength(32);
  } finally {
    database.prepare = originalPrepare;
  }

  expect(observed.some((sql) => /FROM thread_model_state\b/iu.test(sql))).toBe(true);
  const modelQuery = observed.find((sql) => /FROM thread_model\b/iu.test(sql));
  expect(modelQuery).toBeDefined();
  expect(modelQuery).toMatch(/ORDER BY first_rowid\s+ASC\s+LIMIT 33/iu);
  expect(modelQuery).not.toMatch(/GROUP BY|DISTINCT/iu);
  const selectedModelQuery = observed.find((sql) => /FROM episode\b/iu.test(sql));
  expect(selectedModelQuery).toBeDefined();
  expect(selectedModelQuery).toMatch(/role\s*=\s*['"]assistant['"]/iu);
  expect(selectedModelQuery).toMatch(/ORDER BY[\s\S]*seq\s+DESC[\s\S]*LIMIT\s+1/iu);
  expect(selectedModelQuery).not.toMatch(/SELECT\s+\*/iu);
});

test("stats fails closed when an episode model is mutated beyond the bound", () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, {
    role: "assistant",
    content: "model update",
    model: "bounded-model",
  });
  vault.db
    .query("UPDATE episode SET model = ? WHERE thread_id = ? AND seq = 1")
    .run("m".repeat(MAX_THREAD_MODEL_BYTES + 1), thread.id);
  expect(() => stats(vault, thread.id)).toThrow(/model/iu);
  vault.db
    .query("UPDATE episode SET model = ? WHERE thread_id = ? AND seq = 1")
    .run("restored-model", thread.id);
  expect(() => stats(vault, thread.id)).not.toThrow();
});

test("stats reports assistant model history truncation separately", () => {
  const { vault, thread } = tempVault();
  for (let index = 0; index < 33; index += 1) {
    vault.episodes.append(thread.id, {
      role: "assistant",
      content: `distinct assistant model ${index}`,
      model: `model-${index}`,
    });
  }

  const summary = stats(vault, thread.id);
  expect(summary.models).toHaveLength(32);
  expect(summary.models[0]).toBe("model-0");
  expect(summary.models.at(-1)).toBe("model-31");
  expect(summary.modelsTruncated).toBe(true);
});

test("stats returns durable selected settings instead of the last packet", () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, {
    role: "assistant",
    content: "spoken with the previous selection",
    model: "spoken-model",
  });
  vault.threads.setSettings(thread.id, { model: "settings-model", budget: 1234 });

  expect(stats(vault, thread.id)).toMatchObject({
    selectedModel: "settings-model",
    selectedBudget: 1234,
  });
});

test("reopen advances assistant-model backfill in a bounded batch", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 2_048 }, (_, index) => ({
      role: "assistant" as const,
      content: `legacy assistant ${index}`,
      model: `legacy-model-${index}`,
    })),
  );
  vault.db.query("DELETE FROM thread_model").run();
  vault.db.query("UPDATE thread_model_backfill SET after_rowid = 0, complete = 0 WHERE id = 1").run();
  vault.close();

  const observed: string[] = [];
  const originalQuery = Database.prototype.query;
  const rawQuery = originalQuery as unknown as (this: Database, sql: string, ...args: unknown[]) => unknown;
  Database.prototype.query = function (this: Database, sql: string, ...args: unknown[]) {
    if (/\bFROM episode\b|thread_model_backfill/iu.test(sql)) observed.push(sql);
    return rawQuery.call(this, sql, ...args);
  } as unknown as typeof originalQuery;

  let reopened: ReturnType<typeof openVault> | undefined;
  try {
    reopened = openVault({ home: vault.home, fast: true });
  } finally {
    Database.prototype.query = originalQuery;
  }
  if (reopened === undefined) throw new Error("reopen did not return a vault");

  const backfillQuery = observed.find((sql) => /FROM episode\b/iu.test(sql));
  expect(backfillQuery).toBeDefined();
  expect(backfillQuery).toMatch(/\brole\b/iu);
  expect(backfillQuery).toMatch(/LIMIT\s+\?/iu);
  expect(backfillQuery).not.toMatch(/\bcontent\b|\bmeta\b/iu);
  expect(observed.join(" ")).not.toMatch(/LEFT\s+JOIN\s+episode|GROUP\s+BY/iu);
  expect(stats(reopened, thread.id).modelsComplete).toBe(false);
  expect(
    reopened.db.query("SELECT after_rowid, complete FROM thread_model_backfill WHERE id = 1").get(),
  ).toMatchObject({ complete: 0 });
  reopened.close();
});
