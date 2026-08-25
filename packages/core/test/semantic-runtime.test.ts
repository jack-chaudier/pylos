import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSemanticRuntime,
  ensureSemanticDurableTables,
  removeSemanticMetadata,
} from "../src/semantic-runtime.ts";

const SQLITE_PATH = "/opt/homebrew/Cellar/sqlite/3.51.3/lib/libsqlite3.3.51.3.dylib";
const MODEL_PATH = "/private/tmp/pylos-semantic-assets/all-MiniLM-L6-v2.e4ce9877.q8_0.gguf";
const RESOURCE_DIR = "/private/tmp/pylos-semantic-preflight";
const LIVE_RUNTIME = existsSync(SQLITE_PATH) && existsSync(MODEL_PATH);
const LIVE_VAULT_RUNTIME = existsSync(join(RESOURCE_DIR, "manifest.json"));

test("A15.2 runtime fails closed when its pinned model is absent", () => {
  const db = new Database(":memory:");
  const { runtime, probe } = createSemanticRuntime(db, {
    modelPath: "/private/tmp/pylos-semantic-assets/no-such-model.gguf",
  });
  expect(runtime.operational).toBe(false);
  expect(probe.receipt.status).toBe("unavailable");
  expect(probe.reason).toContain("model artifact");
});

test("A15.2 base SQLite deletion removes metadata and leaves a retry tombstone", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pylos_semantic_spans (
      id INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      byte_from INTEGER NOT NULL,
      byte_to INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      revision TEXT NOT NULL,
      span_hash TEXT NOT NULL
    );
    INSERT INTO pylos_semantic_spans
      (id, thread_id, seq, byte_from, byte_to, source_hash, revision, span_hash)
    VALUES (1, 'thread', 7, 0, 5, '${"a".repeat(64)}', 'rev-7', '${"b".repeat(64)}');
  `);
  ensureSemanticDurableTables(db);
  const result = removeSemanticMetadata(db, "thread", 7);
  expect(result).toEqual({ metadataRemoved: 1, pending: true });
  expect(
    db
      .query("SELECT COUNT(*) AS count FROM pylos_semantic_spans WHERE thread_id = ? AND seq = ?")
      .get("thread", 7),
  ).toMatchObject({ count: 0 });
  expect(db.query("SELECT thread_id, seq FROM pylos_semantic_deletions").all()).toEqual([
    { thread_id: "thread", seq: 7 },
  ]);
});

test(
  "A15.2 startup deletion cleanup is bounded and resumable across opens",
  () => {
    if (!LIVE_RUNTIME) return;
    const runtimePath = `${import.meta.dir}/../src/semantic-runtime.ts`;
    const childScript = `
    import { Database } from "bun:sqlite";
    import { createSemanticRuntime, ensureSemanticDurableTables } from ${JSON.stringify(runtimePath)};
    Database.setCustomSQLite(${JSON.stringify(SQLITE_PATH)});
    const db = new Database(":memory:");
    ensureSemanticDurableTables(db);
    const insert = db.query("INSERT INTO pylos_semantic_deletions (thread_id, seq, created_at) VALUES (?, ?, ?)");
    for (let seq = 1; seq <= 8192; seq += 1) insert.run("large-journal", seq, 1);
    const countPending = () => Number(db.query("SELECT count(*) AS count FROM pylos_semantic_deletions").get().count);
    let previous = 8192;
    let opens = 0;
    while (previous > 0 && opens < 40) {
      const opened = createSemanticRuntime(db, {
        modelPath: ${JSON.stringify(MODEL_PATH)},
        eligible: 0,
      });
      if (!opened.runtime.operational) throw new Error("runtime");
      const pending = countPending();
      if (pending >= previous || pending < previous - 256) throw new Error("startup-budget");
      if (pending > 0 && opened.runtime.receipt.status !== "incomplete") throw new Error("pending-receipt");
      previous = pending;
      opens += 1;
    }
    if (previous !== 0 || opens > 33) throw new Error("journal-not-drained");
    const final = createSemanticRuntime(db, { modelPath: ${JSON.stringify(MODEL_PATH)}, eligible: 0 });
    if (!final.runtime.operational || final.runtime.receipt.status !== "ready") throw new Error("final-ready");
    console.log("bounded-startup-ok");
  `;
    const child = Bun.spawnSync(["bun", "-e", childScript], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    expect(child.exitCode, stderr).toBe(0);
    expect(stdout).toContain("bounded-startup-ok");
  },
  { timeout: 30_000 },
);

test(
  "A15.2 repeated-span deletion pages orphan vectors and keeps them unservable",
  () => {
    if (!LIVE_RUNTIME) return;
    const runtimePath = `${import.meta.dir}/../src/semantic-runtime.ts`;
    const childScript = `
    import { Database } from "bun:sqlite";
    import { createSemanticRuntime, removeSemanticMetadata } from ${JSON.stringify(runtimePath)};
    Database.setCustomSQLite(${JSON.stringify(SQLITE_PATH)});
    const db = new Database(":memory:");
    const content = "x".repeat(600);
    const opened = createSemanticRuntime(db, { modelPath: ${JSON.stringify(MODEL_PATH)}, eligible: 600 });
    if (!opened.runtime.operational) throw new Error("runtime");
    for (let offset = 0; offset < 600; offset += 64) {
      const batch = Array.from({ length: Math.min(64, 600 - offset) }, (_, index) => ({
        threadId: "repeated-span",
        seq: 1,
        content,
        byteRange: [offset + index, offset + index + 1],
        revision: "repeat-" + (offset + index),
      }));
      const result = opened.runtime.indexBatch(batch);
      if (result.indexed !== batch.length) throw new Error("index");
    }
    if (Number(db.query("SELECT count(*) AS count FROM pylos_semantic_spans WHERE thread_id = ?").get("repeated-span").count) !== 600) {
      throw new Error("span-count");
    }
    removeSemanticMetadata(db, "repeated-span", 1);
    const expectedVectors = [344, 88, 0];
    for (const expected of expectedVectors) {
      const reopened = createSemanticRuntime(db, { modelPath: ${JSON.stringify(MODEL_PATH)}, eligible: 0 });
      if (!reopened.runtime.operational) throw new Error("reopen");
      const pending = Number(db.query("SELECT count(*) AS count FROM pylos_semantic_deletions").get().count);
      const vectors = Number(db.query("SELECT count(*) AS count FROM pylos_semantic_vec WHERE thread_id = ?").get("repeated-span").count);
      if (vectors !== expected || (expected === 0 ? pending !== 0 : pending !== 1)) throw new Error("paged-cleanup");
      if (expected !== 0 && reopened.runtime.receipt.status !== "incomplete") throw new Error("pending-receipt");
      if (reopened.runtime.search("repeated-span", "x").length !== 0) throw new Error("orphan-served");
    }
    console.log("repeated-span-cleanup-ok");
  `;
    const child = Bun.spawnSync(["bun", "-e", childScript], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    expect(child.exitCode, stderr).toBe(0);
    expect(stdout).toContain("repeated-span-cleanup-ok");
  },
  { timeout: 30_000 },
);

test(
  "A15.2 forgetting without resources bounds restore cleanup and drains vectors on continuation",
  () => {
    if (!LIVE_VAULT_RUNTIME) return;
    const pendingSourceCount = 300;
    const home = mkdtempSync(join(tmpdir(), "pylos-semantic-forget-"));
    const corePath = `${import.meta.dir}/../src/index.ts`;
    const child = (
      script: string,
      resources: boolean,
    ): { exitCode: number; stdout: string; stderr: string } => {
      const result = Bun.spawnSync(["bun", "-e", script], {
        cwd: `${import.meta.dir}/..`,
        env: {
          ...process.env,
          ...(resources ? { PYLOS_SEMANTIC_RESOURCES: RESOURCE_DIR } : { PYLOS_SEMANTIC_RESOURCES: "" }),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    };
    try {
      const indexed = child(
        `
        const core = await import(${JSON.stringify(corePath)});
        const vault = core.openVault({ home: ${JSON.stringify(home)} });
        const thread = vault.threads.primary();
        for (let offset = 0; offset < ${pendingSourceCount}; offset += 64) {
          vault.episodes.appendMany(thread.id, Array.from({ length: Math.min(64, ${pendingSourceCount} - offset) }, (_, index) => ({
            role: "user",
            content: "The private semantic source is removable #" + (offset + index + 1),
          })));
        }
        const spans = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_spans WHERE thread_id = ?").get(thread.id).count);
        if (!vault.semanticRuntime?.operational || spans !== ${pendingSourceCount}) throw new Error("index");
        vault.close();
      `,
        true,
      );
      expect(indexed.exitCode, indexed.stderr).toBe(0);

      const forgotten = child(
        `
        const core = await import(${JSON.stringify(corePath)});
        const vault = core.openVault({ home: ${JSON.stringify(home)} });
        const thread = vault.threads.primary();
        const before = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_spans WHERE thread_id = ?").get(thread.id).count);
        if (before !== ${pendingSourceCount} || vault.semanticRuntime !== null) throw new Error("no-runtime-open");
        core.forget(vault, thread.id, { seqs: Array.from({ length: ${pendingSourceCount} }, (_, index) => index + 1), reason: "privacy oracle" });
        const after = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_spans WHERE thread_id = ?").get(thread.id).count);
        const pending = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_deletions WHERE thread_id = ?").get(thread.id).count);
        if (after !== 0 || pending !== ${pendingSourceCount}) throw new Error("durable-delete");
        vault.close();
      `,
        false,
      );
      expect(forgotten.exitCode, forgotten.stderr).toBe(0);

      const restored = child(
        `
        const core = await import(${JSON.stringify(corePath)});
        const vault = core.openVault({ home: ${JSON.stringify(home)} });
        const thread = vault.threads.primary();
        const pending = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_deletions WHERE thread_id = ?").get(thread.id).count);
        const metadata = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_spans WHERE thread_id = ?").get(thread.id).count);
        const vectors = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_vec WHERE thread_id = ?").get(thread.id).count);
        if (!vault.semanticRuntime?.operational || pending !== ${pendingSourceCount - 256} || metadata !== 0 || vectors !== ${pendingSourceCount - 256}) throw new Error("bounded-restore-cleanup");
        if (vault.semanticRuntime.receipt.status !== "incomplete") throw new Error("pending-receipt");
        if (vault.semanticRuntime.search(thread.id, "private semantic source").length !== 0) throw new Error("resurrected");
        vault.close();
      `,
        true,
      );
      expect(restored.exitCode, restored.stderr).toBe(0);

      const continued = child(
        `
        const core = await import(${JSON.stringify(corePath)});
        const vault = core.openVault({ home: ${JSON.stringify(home)} });
        const thread = vault.threads.primary();
        const pending = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_deletions WHERE thread_id = ?").get(thread.id).count);
        const metadata = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_spans WHERE thread_id = ?").get(thread.id).count);
        const vectors = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_vec WHERE thread_id = ?").get(thread.id).count);
        if (!vault.semanticRuntime?.operational || pending !== 0 || metadata !== 0 || vectors !== 0) throw new Error("continued-restore-cleanup");
        if (vault.semanticRuntime.search(thread.id, "private semantic source").length !== 0) throw new Error("resurrected");
        vault.close();
      `,
        true,
      );
      expect(continued.exitCode, continued.stderr).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  { timeout: 30_000 },
);

test("A15.2 a malformed deletion journal fails closed instead of being skipped", () => {
  if (!LIVE_VAULT_RUNTIME) return;
  const home = mkdtempSync(join(tmpdir(), "pylos-semantic-malformed-journal-"));
  const corePath = `${import.meta.dir}/../src/index.ts`;
  const child = (
    resources: boolean,
    script: string,
  ): { exitCode: number; stdout: string; stderr: string } => {
    const result = Bun.spawnSync(["bun", "-e", script], {
      cwd: `${import.meta.dir}/..`,
      env: {
        ...process.env,
        ...(resources ? { PYLOS_SEMANTIC_RESOURCES: RESOURCE_DIR } : { PYLOS_SEMANTIC_RESOURCES: "" }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  };
  try {
    const staged = child(
      false,
      `
        const core = await import(${JSON.stringify(corePath)});
        const vault = core.openVault({ home: ${JSON.stringify(home)} });
        vault.db.query("INSERT INTO pylos_semantic_deletions (thread_id, seq, created_at) VALUES (?, ?, ?)").run("", 1, 1);
        vault.close();
      `,
    );
    expect(staged.exitCode, staged.stderr).toBe(0);

    const reopened = child(
      true,
      `
        const core = await import(${JSON.stringify(corePath)});
        const vault = core.openVault({ home: ${JSON.stringify(home)} });
        const pending = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_deletions").get().count);
        if (vault.semanticRuntime?.operational === true || pending !== 1) throw new Error("malformed-journal-was-accepted");
        if (!vault.semanticProbe.receipt.reason?.includes("malformed")) throw new Error("missing-malformed-receipt");
        vault.close();
      `,
    );
    expect(reopened.exitCode, reopened.stderr).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("A15.2 native semantic delete failure aborts the outer forget transaction", () => {
  if (!LIVE_VAULT_RUNTIME) return;
  const home = mkdtempSync(join(tmpdir(), "pylos-semantic-delete-failure-"));
  const corePath = `${import.meta.dir}/../src/index.ts`;
  try {
    const result = Bun.spawnSync(
      [
        "bun",
        "-e",
        `
          const core = await import(${JSON.stringify(corePath)});
          const vault = core.openVault({ home: ${JSON.stringify(home)} });
          const thread = vault.threads.primary();
          const source = vault.episodes.append(thread.id, { role: "user", content: "This source must survive a failed forget." });
          if (!vault.semanticRuntime?.operational) throw new Error("runtime");
          vault.db.exec("DROP TABLE pylos_semantic_vec");
          let failed = false;
          try { core.forget(vault, thread.id, { seqs: [source.seq], reason: "failure oracle" }); } catch { failed = true; }
          const after = vault.episodes.get(thread.id, source.seq);
          const tombstones = Number(vault.db.query("SELECT count(*) AS count FROM tombstone").get().count);
          if (!failed || after?.meta.removed === true || after?.content !== source.content || tombstones !== 0) throw new Error("forget-committed");
          vault.close();
          console.log("semantic-delete-failure-ok");
        `,
      ],
      {
        cwd: `${import.meta.dir}/..`,
        env: { ...process.env, PYLOS_SEMANTIC_RESOURCES: RESOURCE_DIR },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = new TextDecoder().decode(result.stderr);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode, stderr).toBe(0);
    expect(stdout).toContain("semantic-delete-failure-ok");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "A15.2 live sqlite route is tested in an isolated process",
  () => {
    if (!LIVE_RUNTIME) return;
    const runtimePath = `${import.meta.dir}/../src/semantic-runtime.ts`;
    const semanticPath = `${import.meta.dir}/../src/semantic.ts`;
    const hashPath = `${import.meta.dir}/../src/hash.ts`;
    const childScript = `
    import { Database } from "bun:sqlite";
    import { createSemanticRuntime } from ${JSON.stringify(runtimePath)};
    import { verifySemanticHit } from ${JSON.stringify(semanticPath)};
    import { sha256 } from ${JSON.stringify(hashPath)};
    Database.setCustomSQLite(${JSON.stringify(SQLITE_PATH)});
    const rawDb = new Database(":memory:");
    const clearAllSizes = [];
    const db = {
      loadExtension: (path, entrypoint) => rawDb.loadExtension(path, entrypoint),
      exec: (sql) => rawDb.exec(sql),
      query: (sql) => {
        const statement = rawDb.query(sql);
        return {
          get: (...parameters) => statement.get(...parameters),
          run: (...parameters) => statement.run(...parameters),
          all: (...parameters) => {
            const rows = statement.all(...parameters);
            if (
              (sql.includes("pylos_semantic_spans") || sql.includes("pylos_semantic_vec")) &&
              /SELECT (id|rowid AS id)/i.test(sql)
            ) {
              clearAllSizes.push(rows.length);
            }
            return rows;
          },
        };
      },
    };
    const opened = createSemanticRuntime(db, {
      modelPath: ${JSON.stringify(MODEL_PATH)},
      eligible: 3,
    });
    if (!opened.runtime.operational || opened.probe.receipt.status !== "incomplete") throw new Error("probe");
    const exact = "The π courtroom discussed firearm charges.";
    const sourceHash = sha256(new TextEncoder().encode(exact));
    const indexed = opened.runtime.indexBatch([
      { threadId: "alpha", seq: 2, content: exact, revision: "rev-2" },
      { threadId: "alpha", seq: 1, content: exact, revision: "rev-1" },
      { threadId: "bravo", seq: 9, content: exact, revision: "rev-9" },
    ]);
    if (indexed.indexed !== 3 || indexed.rejected.length !== 0 || indexed.receipt.status !== "ready") {
      throw new Error("index");
    }
    const alpha = opened.runtime.search("alpha", "firearm courtroom", { limit: 8 });
    if (alpha.map((hit) => hit.seq).join(",") !== "1,2") throw new Error("tie-order");
    if (opened.runtime.receiptFor("alpha", 2).status !== "ready") throw new Error("thread-receipt");
    if (!alpha.every((hit) => hit.contentHash === sourceHash && hit.revision === "rev-" + hit.seq)) {
      throw new Error("binding");
    }
    if (opened.runtime.search("bravo", "firearm courtroom", { limit: 8 }).map((hit) => hit.seq).join(",") !== "9") {
      throw new Error("thread-partition");
    }
    const first = alpha[0];
    if (
      first === undefined ||
      !verifySemanticHit(first, {
        seq: first.seq,
        content: exact,
        contentHash: sourceHash,
        revision: first.revision,
      }).accepted
    ) throw new Error("exact-verifier");
    if (verifySemanticHit({ seq: 999, byteRange: [0, 1], contentHash: sourceHash, spanHash: sourceHash }, null).accepted) {
      throw new Error("false-hit");
    }
    if (
      opened.runtime.remove("alpha", 1).removed !== 1 ||
      opened.runtime.search("alpha", "courtroom").some((hit) => hit.seq === 1)
    ) {
      throw new Error("deletion");
    }
    opened.runtime.indexBatch([{ threadId: "alpha", seq: 1, content: exact, revision: "rev-1" }]);
    db.query("UPDATE pylos_semantic_spans SET source_hash = ? WHERE thread_id = ? AND seq = ?").run(
      "0".repeat(64),
      "alpha",
      1,
    );
    const tampered = opened.runtime.search("alpha", "courtroom").find((hit) => hit.seq === 1);
    if (
      tampered === undefined ||
      verifySemanticHit(tampered, {
        seq: 1,
        content: exact,
        contentHash: sourceHash,
        revision: "rev-1",
      }).accepted
    ) throw new Error("tamper");
    for (let offset = 0; offset < 300; offset += 64) {
      const batch = Array.from({ length: Math.min(64, 300 - offset) }, (_, index) => ({
        threadId: "forever",
        seq: offset + index + 1,
        content: "A high-cardinality semantic source " + (offset + index + 1),
        revision: "forever-" + (offset + index + 1),
      }));
      const indexedForever = opened.runtime.indexBatch(batch);
      if (indexedForever.indexed !== batch.length) throw new Error("high-cardinality-index");
    }
    clearAllSizes.length = 0;
    const clearedForever = opened.runtime.clearThread("forever");
    if (
      clearedForever.removed !== 300 ||
      clearAllSizes.length === 0 ||
      Math.max(...clearAllSizes) > 256 ||
      Number(rawDb.query("SELECT count(*) AS count FROM pylos_semantic_spans WHERE thread_id = ?").get("forever").count) !== 0 ||
      Number(rawDb.query("SELECT count(*) AS count FROM pylos_semantic_vec WHERE thread_id = ?").get("forever").count) !== 0
    ) {
      throw new Error("clear-unbounded");
    }
    const bounded = createSemanticRuntime(db, {
      modelPath: ${JSON.stringify(MODEL_PATH)},
      maxBatch: 2,
      tablePrefix: "pylos_semantic_bounded",
    });
    const boundedResult = bounded.runtime.indexBatch([
      { threadId: "alpha", seq: 1, content: "one", revision: "r1" },
      { threadId: "alpha", seq: 2, content: "two", revision: "r2" },
      { threadId: "alpha", seq: 3, content: "three", revision: "r3" },
    ]);
    if (boundedResult.truncated !== 1 || boundedResult.receipt.status !== "incomplete") throw new Error("bound");
    const malformed = bounded.runtime.indexBatch([
      { threadId: "alpha", seq: 4, content: "A π", byteRange: [2, 3], revision: "r4" },
    ]);
    if (malformed.rejected[0]?.reason !== "invalid-utf8") throw new Error("utf8");
    db.exec("BEGIN");
    const transactional = bounded.runtime.indexBatch([
      { threadId: "outer", seq: 1, content: "outer", revision: "r" },
    ]);
    if (transactional.indexed !== 1) throw new Error("savepoint");
    db.exec("ROLLBACK");
    if (bounded.runtime.search("outer", "outer").length !== 0) throw new Error("outer-transaction");
    if (opened.runtime.remove("alpha", 999).status !== "empty") throw new Error("empty-delete");
    const beforeFailure = Number(
      db.query("SELECT count(*) AS count FROM pylos_semantic_spans WHERE thread_id = ? AND seq = ?").get(
        "alpha",
        2,
      ).count,
    );
    db.exec("DROP TABLE pylos_semantic_vec");
    let failed = false;
    try {
      opened.runtime.remove("alpha", 2);
    } catch {
      failed = true;
    }
    const afterFailure = Number(
      db.query("SELECT count(*) AS count FROM pylos_semantic_spans WHERE thread_id = ? AND seq = ?").get(
        "alpha",
        2,
      ).count,
    );
    if (!failed || beforeFailure !== 1 || afterFailure !== beforeFailure) throw new Error("delete-failure");
    console.log("semantic-runtime-smoke-ok");
  `;
    const child = Bun.spawnSync(["bun", "-e", childScript], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    expect(child.exitCode, stderr).toBe(0);
    expect(stdout).toContain("semantic-runtime-smoke-ok");
  },
  { timeout: 30_000 },
);
