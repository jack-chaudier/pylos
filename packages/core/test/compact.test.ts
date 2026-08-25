import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CAPSULE_SOURCE_NAMES_PER_EPISODE } from "@pylos/protocol";
import {
  atomize,
  compact,
  compactionPending,
  exportBundleStream,
  importBundleStream,
  levelSpan,
  MAX_CAPSULE_WORK_PER_COMPACT,
  nameSet,
  openVault,
  ROOT_LEVEL,
  residentCapsules,
  residentLeafCount,
  runTurn,
  sourceNamesForRange,
  stats,
} from "../src/index.ts";
import { resolves } from "../src/page.ts";
import { canonicalJson } from "../src/pure/canonical.ts";
import { names } from "../src/pure/names.ts";
import { cleanup, rng, syntheticTurn, tempVault } from "./helpers.ts";

afterAll(cleanup);

function fill(seed: number, count: number, settings: Record<string, unknown> = {}) {
  const { vault, thread } = tempVault(settings);
  const next = rng(seed);
  const inputs = Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: syntheticTurn(next, i),
  }));
  for (let i = 0; i < inputs.length; i += 64) {
    const batch = inputs.slice(i, i + 64);
    const appended = vault.episodes.appendMany(thread.id, batch);
    atomize(
      vault,
      thread.id,
      appended.map((e) => e.seq),
    );
    compact(vault, thread.id, { budget: 8192 });
  }
  return { vault, thread };
}

test("capsules seal on the 32 / 256 / 2048 schedule", () => {
  const { vault, thread } = fill(11, 640);
  expect(levelSpan(0)).toBe(32);
  expect(levelSpan(1)).toBe(256);
  expect(levelSpan(2)).toBe(2048);
  expect(vault.capsules.list(thread.id, 0, 1000)).toHaveLength(640 / 32);
  expect(vault.capsules.list(thread.id, 1, 1000)).toHaveLength(2);
  expect(vault.capsules.list(thread.id, 2, 1000)).toHaveLength(0);
});

test("compaction is idempotent", () => {
  const { vault, thread } = fill(12, 256);
  const before = vault.capsules.count(thread.id);
  const losses = vault.losses.total(thread.id);
  expect(compact(vault, thread.id, { budget: 8192 })).toHaveLength(0);
  expect(vault.capsules.count(thread.id)).toBe(before);
  expect(vault.losses.total(thread.id)).toBe(losses);
});

test("the resident capsule set is fixed-size and covers a contiguous prefix", () => {
  for (const count of [320, 640, 1280, 2560]) {
    const { vault, thread } = fill(13, count);
    const resident = residentCapsules(vault, thread.id);
    expect(resident.length).toBeLessThanOrEqual(residentLeafCount(8192) + 1);
    expect(resident[0]?.level).toBe(ROOT_LEVEL);
    expect(resident[0]?.fromSeq).toBe(1);
    for (let i = 1; i < resident.length; i += 1) {
      expect(resident[i]?.fromSeq).toBe((resident[i - 1]?.toSeq ?? 0) + 1);
    }
    // The cover reaches the last sealed leaf; the recent window takes the rest.
    const lastLeaf = Math.floor(count / 32) * 32;
    expect(resident.at(-1)?.toSeq).toBe(lastLeaf);
  }
});

test("completeness: every source name is either in the capsule text or in its ledger", () => {
  const { vault, thread } = fill(14, 1024);
  for (const capsule of vault.capsules.list(thread.id, undefined, 200)) {
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
});

test("a proposal is never a capsule certificate, but its key is still in the ledger", () => {
  const { vault, thread } = tempVault();
  const claimed = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "Halden Works is based in Valletta.",
  });
  atomize(vault, thread.id, [claimed.seq]);
  const key = "person.halden-works.location";
  expect(vault.atoms.byKey(thread.id, key, "PROPOSED")).toHaveLength(1);

  const next = rng(16);
  for (let i = 0; i < 64; i += 1) {
    const appended = vault.episodes.append(thread.id, {
      role: "user",
      content: syntheticTurn(next, i),
    });
    atomize(vault, thread.id, [appended.seq]);
  }
  compact(vault, thread.id, { budget: 8192 });

  const capsule = vault.capsules.list(thread.id, 0, 10).find((c) => c.fromSeq <= 1 && c.toSeq >= 1);
  expect(capsule).toBeDefined();
  const sealed = capsule as NonNullable<typeof capsule>;
  // No certificate line for a proposal — a model's claim never reads as settled.
  expect(sealed.text).not.toContain(`${key} = Valletta`);
  // But the key is accounted for: dropped, with an exact locator.
  const entry = vault.losses.inRange(thread.id, sealed.fromSeq, sealed.toSeq).find((l) => l.name === key);
  expect(entry?.kind).toBe("atom");
  expect(entry?.seq).toBe(1);

  const source = sourceNamesForRange(vault, thread.id, sealed.fromSeq, sealed.toSeq);
  const present = nameSet(sealed.text, { max: 8192 });
  const ledger = new Set(vault.losses.inRange(thread.id, sealed.fromSeq, sealed.toSeq).map((l) => l.name));
  const unaccounted = [...new Set(source.map((s) => s.name))].filter(
    (name) => !present.has(name) && !ledger.has(name),
  );
  expect(unaccounted).toEqual([]);
});

test("conservation: a parent's ledger contains every child's ledger", () => {
  const { vault, thread } = fill(15, 2048);
  let checked = 0;
  for (let level = 1; level <= 2; level += 1) {
    for (const parent of vault.capsules.list(thread.id, level, 200)) {
      const parentLedger = new Set(
        vault.losses.inRange(thread.id, parent.fromSeq, parent.toSeq).map((l) => l.name),
      );
      for (const child of vault.capsules.children(thread.id, level, parent.fromSeq, parent.toSeq)) {
        for (const entry of vault.losses.inRange(thread.id, child.fromSeq, child.toSeq)) {
          expect(parentLedger.has(entry.name)).toBe(true);
        }
        checked += 1;
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test("the ledger is monotone across repeated compaction", () => {
  const { vault, thread } = tempVault();
  const next = rng(16);
  let previous = 0;
  for (let round = 0; round < 12; round += 1) {
    vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 64 }, (_, i) => ({
        role: "user" as const,
        content: syntheticTurn(next, round * 64 + i),
      })),
    );
    compact(vault, thread.id, { budget: 8192 });
    compact(vault, thread.id, { budget: 8192 });
    const total = vault.losses.total(thread.id);
    expect(total).toBeGreaterThanOrEqual(previous);
    previous = total;
  }
  expect(previous).toBeGreaterThan(0);
});

test("exact pageability: every loss row resolves to a span containing the name", () => {
  const { vault, thread } = fill(17, 512);
  const rows = vault.db
    .query("SELECT name, kind, seq, span FROM loss WHERE thread_id = ? AND capsule_id != 'frontier'")
    .all(thread.id) as Array<{ name: string; kind: string; seq: number; span: string | null }>;
  expect(rows.length).toBeGreaterThan(100);
  let checkedSpans = 0;
  for (const row of rows) {
    const episode = vault.episodes.get(thread.id, row.seq);
    expect(episode).not.toBeNull();
    const content = (episode as { content: string }).content;
    const found = resolves(vault, thread.id, content, row.seq, row);
    expect({ name: row.name, seq: row.seq, found }).toEqual({
      name: row.name,
      seq: row.seq,
      found: true,
    });
    if (row.span !== null) {
      const [start, end] = JSON.parse(row.span) as [number, number];
      const slice = content.slice(start, end);
      expect(slice.length).toBeGreaterThan(0);
      checkedSpans += 1;
    }
  }
  expect(checkedSpans).toBeGreaterThan(50);
});

test("the model writer's output is hard-truncated by the kernel", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 64 }, (_, i) => ({ role: "user" as const, content: `Turn ${i} about Lisbon.` })),
  );
  const capsules = compact(vault, thread.id, {
    budget: 8192,
    writer: () => `${"Overlong prose about Lisbon and Porto. ".repeat(400)}`,
  });
  const leaf = capsules.find((c) => c.level === 0);
  expect(leaf).toBeDefined();
  expect(leaf?.tokens).toBeLessThanOrEqual(205);
  expect(leaf?.createdBy).toBe("model");
});

test("capsule text with more than 4096 visible names is mechanically truncated before sealing", () => {
  const { vault, thread } = tempVault({ budget: 1_000_000 });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 32 }, (_, index) => ({ role: "user" as const, content: `source ${index}` })),
  );
  const proposed = Array.from(
    { length: 4_097 },
    (_, index) => `"visible-${index.toString().padStart(4, "0")}"`,
  ).join(" ");
  expect(() => compact(vault, thread.id, { budget: 1_000_000, writer: () => proposed })).not.toThrow();
  const capsule = vault.capsules.at(thread.id, 0, 1);
  expect(capsule).not.toBeNull();
  expect(names(capsule?.text ?? "", { max: 4097 }).length).toBeLessThanOrEqual(4096);
  expect(capsule?.ledgerReceipt).toBeDefined();
});

test("source-name admission accepts the exact cap and rejects max plus one without wedging the leaf", () => {
  const { vault, thread } = tempVault({ budget: 1_000_000 });
  const dense = (count: number): string =>
    Array.from({ length: count }, (_, index) => `\`source_${index.toString().padStart(4, "0")}\``).join(" ");
  vault.episodes.append(thread.id, {
    role: "user",
    content: dense(CAPSULE_SOURCE_NAMES_PER_EPISODE),
  });
  const head = vault.threads.get(thread.id)?.headSeq;
  expect(() =>
    vault.episodes.append(thread.id, {
      role: "user",
      content: dense(CAPSULE_SOURCE_NAMES_PER_EPISODE + 1),
    }),
  ).toThrow(/capsule source-name capacity/);
  expect(vault.threads.get(thread.id)?.headSeq).toBe(head);
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 31 }, (_, index) => ({ role: "assistant" as const, content: `pad ${index}` })),
  );
  expect(() => compact(vault, thread.id, { budget: 1_000_000 })).not.toThrow();
  expect(vault.capsules.at(thread.id, 0, 1)?.ledgerReceipt).toBeDefined();
});

test("a reopened pre-cap tail is durably reported read-only before another episode commits", () => {
  const { vault, thread } = tempVault({ budget: 1_000_000 });
  vault.episodes.append(thread.id, { role: "user", content: "legacy source" });
  const oversized = "x".repeat(1024 * 1024 + 1);
  vault.db.query("UPDATE episode SET content = ? WHERE thread_id = ? AND seq = 1").run(oversized, thread.id);
  vault.db.query("DELETE FROM capsule_source_readiness WHERE thread_id = ?").run(thread.id);
  const home = vault.home;
  vault.close();
  const reopened = openVault({ home, fast: true });
  expect(stats(reopened, thread.id).sourceReadiness).toBeUndefined();
  expect(() => reopened.episodes.append(thread.id, { role: "user", content: "must not commit" })).toThrow(
    /legacy noncompactable tail/,
  );
  expect(stats(reopened, thread.id).sourceReadiness).toMatchObject({
    status: "noncompactable",
    readOnly: true,
    seq: 1,
  });
  expect(reopened.threads.get(thread.id)?.headSeq).toBe(1);
  expect(reopened.episodes.get(thread.id, 1)?.content).toBe(oversized);
});

test("thread readiness statistics stay scalar across 64 persisted quarantines", () => {
  const { vault, thread } = tempVault();
  const threads = [thread];
  for (let index = 1; index < 64; index += 1) threads.push(vault.threads.create(`legacy ${index}`));
  const insert = vault.db.query(
    "INSERT OR REPLACE INTO capsule_source_readiness " +
      "(thread_id, status, checked_through, seq, reason, checked_at) " +
      "VALUES (?, 'noncompactable', 0, 1, 'legacy oversized source', 1)",
  );
  for (const candidate of threads) insert.run(candidate.id);
  const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    if (/SELECT[\s\S]*content[\s\S]*FROM episode/iu.test(sql)) {
      throw new Error("readiness statistics hydrated episode content");
    }
    return originalQuery.call(vault.db, sql, ...args);
  }) as typeof db.query;
  try {
    for (const candidate of threads) {
      expect(stats(vault, candidate.id).sourceReadiness?.status).toBe("noncompactable");
    }
  } finally {
    db.query = originalQuery;
  }
});

test("validated multi-batch appends advance readiness without rescanning prior episode content", () => {
  const { vault, thread } = tempVault();
  const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    if (/SELECT[\s\S]*content[\s\S]*FROM episode/iu.test(sql)) {
      throw new Error("validated append rescanned prior episode content");
    }
    return originalQuery.call(vault.db, sql, ...args);
  }) as typeof db.query;
  try {
    for (let batch = 0; batch < 4; batch += 1) {
      vault.episodes.appendMany(
        thread.id,
        Array.from({ length: 512 }, (_, index) => ({
          role: "user" as const,
          content: `validated batch ${batch} episode ${index}`,
        })),
      );
      const row = vault.db
        .query("SELECT status, checked_through FROM capsule_source_readiness WHERE thread_id = ?")
        .get(thread.id) as { status: string; checked_through: number };
      expect(row).toEqual({ status: "ready", checked_through: (batch + 1) * 512 });
    }
  } finally {
    db.query = originalQuery;
  }
});

test("capsule-free backlog advances in bounded passes before any provider call", async () => {
  const { vault, thread } = tempVault({ budget: 8_192 });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 8_192 }, (_, index) => ({
      role: "user" as const,
      content: `backlog episode ${index + 32}`,
    })),
  );
  expect(vault.capsules.count(thread.id)).toBe(0);
  const passphrase = "bounded zero-capsule backlog";
  const target = tempVault({ budget: 8_192 }).vault;
  const imported = await importBundleStream(
    target,
    await exportBundleStream(vault, thread.id, { passphrase }),
    {
      passphrase,
    },
  );
  expect(target.capsules.count(imported.threadId)).toBe(0);
  expect(target.capsuleSourceReadiness(imported.threadId)).toBeNull();
  expect(compactionPending(target, imported.threadId)).toBe(true);
  let providerCalled = false;
  await expect(
    runTurn(target, imported.threadId, {
      text: "must wait for bounded catch-up",
      model: "test-model",
      provider: async function* () {
        providerCalled = true;
        yield { type: "done" as const };
      },
    }),
  ).rejects.toThrow(/bounded compaction backfill is pending/);
  expect(providerCalled).toBe(false);
  expect(target.threads.get(imported.threadId)?.headSeq).toBe(8_192);
  expect(target.capsules.count(imported.threadId)).toBeLessThanOrEqual(MAX_CAPSULE_WORK_PER_COMPACT * 4);
});

test("a dense legal leaf compacts without the online atom-range cap", () => {
  const { vault, thread } = tempVault({ budget: 8_192 });
  const dense = vault.episodes.append(thread.id, {
    role: "user",
    content: Array.from({ length: 512 }, (_, index) => `Remember dense fact ${index}: value ${index}.`).join(
      " ",
    ),
  });
  atomize(vault, thread.id, [dense.seq]);
  expect(vault.atoms.list(thread.id, { phase: "SUPPORTED", limit: 2_000 }).length).toBe(512);
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 31 }, (_, index) => ({ role: "user" as const, content: `filler ${index}` })),
  );
  expect(() => compact(vault, thread.id, { budget: 8_192 })).not.toThrow();
  expect(vault.capsules.at(thread.id, 0, 1)?.toSeq).toBe(32);
});

test(
  "100k concentrated names stay externally derived, exactly pageable, and v2 portable",
  async () => {
    const { vault, thread } = tempVault({ budget: 8_192 });
    vault.episodes.append(thread.id, { role: "user", content: "dense external ledger source" });
    vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 31 }, (_, index) => ({ role: "user" as const, content: `pad ${index}` })),
    );
    const insert = vault.db.query(
      "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, " +
        "valid_from_seq, valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, " +
        "created_by, created_at) VALUES (?, ?, 'fact', ?, ?, '', 1, '[0,3]', 1, NULL, NULL, " +
        "'PROPOSED', 'model', 'global', 0, 1, 'model:oracle', 1)",
    );
    vault.db.transaction(() => {
      for (let index = 0; index < 100_000; index += 1) {
        const name = `dense-${index.toString().padStart(6, "0")}`;
        insert.run(`dense-atom-${index}`, thread.id, name, name);
      }
    })();

    const stats = { atomPage: 0, lossBatch: 0, sqlRows: 0, rawRowBytes: 0 };
    const atoms = vault.atoms as typeof vault.atoms & {
      inRangeForMigration: typeof vault.atoms.inRangeForMigration;
    };
    const originalAtomPage = atoms.inRangeForMigration;
    atoms.inRangeForMigration = ((...args: Parameters<typeof originalAtomPage>) => {
      const page = originalAtomPage(...args);
      stats.atomPage = Math.max(stats.atomPage, page.atoms.length);
      return page;
    }) as typeof originalAtomPage;
    const losses = vault.losses as typeof vault.losses & { add: typeof vault.losses.add };
    const originalLossAdd = losses.add;
    losses.add = ((...args: Parameters<typeof originalLossAdd>) => {
      stats.lossBatch = Math.max(stats.lossBatch, args[3].length);
      return originalLossAdd(...args);
    }) as typeof originalLossAdd;
    const originalQuery = Database.prototype.query;
    const rawQuery = originalQuery as unknown as (this: Database, sql: string, ...args: unknown[]) => unknown;
    Database.prototype.query = function (this: Database, sql: string, ...args: unknown[]) {
      const statement = rawQuery.call(this, sql, ...args) as Record<string, unknown>;
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property === "all") {
            return (...parameters: unknown[]) => {
              const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
              const result = method.apply(target, parameters);
              if (Array.isArray(result)) {
                stats.sqlRows = Math.max(stats.sqlRows, result.length);
                for (const row of result) {
                  stats.rawRowBytes = Math.max(
                    stats.rawRowBytes,
                    Buffer.byteLength(JSON.stringify(row), "utf8"),
                  );
                }
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } as unknown as typeof originalQuery;

    try {
      compact(vault, thread.id, { budget: 8_192, writer: () => "" });
      const leaf = vault.capsules.at(thread.id, 0, 1);
      expect(leaf).not.toBeNull();
      const sealed = leaf as NonNullable<typeof leaf>;
      const receipt = sealed.ledgerReceipt;
      if (receipt === undefined) throw new Error("dense capsule receipt missing");
      expect(receipt.dropped.count).toBe(100_000);
      expect(receipt.dropped.complete).toBe(false);
      expect(receipt.dropped.embeddedCount).toBe(sealed.dropped.length);
      expect(Buffer.byteLength(canonicalJson(sealed.dropped), "utf8")).toBeLessThanOrEqual(64 * 1024);
      expect(Buffer.byteLength(canonicalJson(sealed.ledgerReceipt), "utf8")).toBeLessThan(2 * 1024);
      expect(
        (vault.db.query("SELECT COUNT(*) AS n FROM loss WHERE thread_id = ?").get(thread.id) as { n: number })
          .n,
      ).toBe(100_000);

      const digest = createHash("sha256");
      let exact = 0;
      for (const entry of sealed.dropped) {
        digest.update(`${canonicalJson(entry)}\n`, "utf8");
        exact += 1;
      }
      let cursor = receipt.dropped.cursor;
      while (cursor !== undefined) {
        const page = vault.capsules.ledgerPage(sealed.id, "dropped", { after: cursor, limit: 256 });
        expect(page.entries.length).toBeLessThanOrEqual(256);
        for (const entry of page.entries) {
          digest.update(`${canonicalJson(entry)}\n`, "utf8");
          exact += 1;
        }
        cursor = page.nextCursor;
      }
      expect(exact).toBe(100_000);
      expect(digest.digest("hex")).toBe(receipt.dropped.digest);

      vault.episodes.appendMany(
        thread.id,
        Array.from({ length: 224 }, (_, index) => ({
          role: "user" as const,
          content: `later sibling ${index}`,
        })),
      );
      compact(vault, thread.id, { budget: 8_192, writer: () => "" });
      expect(vault.capsules.at(thread.id, 1, 1)?.carriedCount).toBeGreaterThanOrEqual(100_000);

      const passphrase = "dense-ledger-v2-oracle";
      const stream = await exportBundleStream(vault, thread.id, { passphrase });
      const target = tempVault().vault;
      const imported = await importBundleStream(target, stream, {
        passphrase,
      });
      expect(imported.verified).toBe(true);
      const restored = target.capsules.get(sealed.id);
      expect(restored?.ledgerReceipt).toEqual(sealed.ledgerReceipt);
      expect(
        (
          target.db
            .query("SELECT COUNT(*) AS n FROM capsule_ledger_entry WHERE capsule_id = ? AND part = 'dropped'")
            .get(sealed.id) as { n: number }
        ).n,
      ).toBe(100_000);
      target.episodes.appendMany(
        imported.threadId,
        Array.from({ length: 32 }, (_, index) => ({
          role: "user" as const,
          content: `post-import continuation ${index}`,
        })),
      );
      expect(() => compact(target, imported.threadId, { budget: 8_192, writer: () => "" })).not.toThrow();
      expect(target.capsules.at(imported.threadId, 1, 1)?.carriedCount).toBeGreaterThanOrEqual(100_000);
    } finally {
      atoms.inRangeForMigration = originalAtomPage;
      losses.add = originalLossAdd;
      Database.prototype.query = originalQuery;
    }
    expect(stats.atomPage).toBeLessThanOrEqual(128);
    expect(stats.lossBatch).toBeLessThanOrEqual(128);
    expect(stats.sqlRows).toBeLessThanOrEqual(256);
    expect(stats.rawRowBytes).toBeLessThanOrEqual(128 * 1024);
  },
  { timeout: 240_000 },
);
