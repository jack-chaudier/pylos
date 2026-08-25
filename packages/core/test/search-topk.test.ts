import { afterAll, expect, test } from "bun:test";
import type { Thread } from "@pylos/protocol";
import { ftsQuery, type Vault } from "../src/index.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

/**
 * The bounded-overfetch search path (KERNEL §5.3, A9.4) must return what the
 * unbounded statement would have returned, so the unbounded statement is the
 * oracle here: the same SQL the vault keeps as its fallback, run directly.
 * The corpus is templated on purpose — dozens of turns share one bm25 score,
 * which is the case where a naive top-k picks the wrong side of a tie.
 */
const UNBOUNDED =
  "SELECT e.seq FROM episode_fts f JOIN episode e ON e.rowid = f.rowid " +
  "WHERE episode_fts MATCH ? AND e.thread_id = ? AND e.seq IS NOT ? AND e.seq < ? " +
  "ORDER BY bm25(episode_fts) ASC, e.seq DESC LIMIT ?";

interface SearchOpts {
  mode?: "both" | "strict";
  exclude?: number;
  before?: number;
}

function oracle(vault: Vault, threadId: string, query: string, limit: number, opts: SearchOpts): number[] {
  const run = (match: string): number[] =>
    (
      vault.db
        .query(UNBOUNDED)
        .all(match, threadId, opts.exclude ?? null, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as Array<{
        seq: number;
      }>
    ).map((row) => row.seq);
  const strict = ftsQuery(query, "and");
  const found = strict === null ? [] : run(strict);
  if (found.length > 0 || opts.mode === "strict") return found;
  const loose = ftsQuery(query, "or");
  return loose === null ? [] : run(loose);
}

function seed(vault: Vault, thread: Thread, contents: readonly string[]): void {
  vault.episodes.appendMany(
    thread.id,
    contents.map((content) => ({ role: "user" as const, content })),
  );
}

const TIED = "the ledger rollout reached the harbor stage";
const STALLED = "the ledger rollout stalled overnight";

/** 40 identical turns, 12 identical turns scoring differently, 4 singletons. */
function tiedVault(): { vault: Vault; thread: Thread } {
  const { vault, thread } = tempVault();
  const contents: string[] = [];
  for (let i = 0; i < 40; i += 1) contents.push(TIED);
  for (let i = 0; i < 12; i += 1) contents.push(STALLED);
  contents.push("the scheduler ingest backlog cleared in Tallinn");
  contents.push("a palimpsest of Valletta, kept exactly as written");
  contents.push("the ledger rollout reached the harbor stage and then the harbor stage again");
  contents.push("nothing here matches anything else at all");
  seed(vault, thread, contents);
  return { vault, thread };
}

const QUERIES = [
  "ledger harbor rollout?",
  "ledger rollout?",
  "which harbor stage did the rollout reach?",
  "scheduler ingest backlog?",
  "palimpsest Valletta?",
  "who cleared the Tallinn backlog and the harbor stage?",
  "nothing matches anything?",
];

test("search equals the unbounded query across queries, limits and options", () => {
  const { vault, thread } = tiedVault();
  const options: SearchOpts[] = [
    {},
    { mode: "strict" },
    { exclude: 20 },
    { before: 30 },
    { exclude: 36, before: 41 },
    { mode: "strict", exclude: 5, before: 45 },
  ];
  let compared = 0;
  for (const query of QUERIES) {
    for (const limit of [1, 2, 3, 5, 10, 40, 60]) {
      for (const opts of options) {
        const got = vault.episodes.search(thread.id, query, limit, opts).map((e) => e.seq);
        expect(got).toEqual(oracle(vault, thread.id, query, limit, opts));
        compared += 1;
      }
    }
  }
  expect(compared).toBe(QUERIES.length * 7 * options.length);
});

test("a tie straddling the limit keeps the newest turns of the tie", () => {
  const { vault, thread } = tiedVault();
  const got = vault.episodes.search(thread.id, "ledger harbor rollout?", 5, { mode: "strict" });
  expect(got.map((e) => e.seq)).toEqual([40, 39, 38, 37, 36]);
  expect(got.map((e) => e.seq)).toEqual(oracle(vault, thread.id, "ledger harbor rollout?", 5, {}));
});

test("every match tied still resolves to the newest turns", () => {
  const { vault, thread } = tempVault();
  const contents: string[] = [];
  for (let i = 0; i < 30; i += 1) contents.push(TIED);
  seed(vault, thread, contents);
  const got = vault.episodes.search(thread.id, "ledger harbor rollout?", 4, { mode: "strict" });
  expect(got.map((e) => e.seq)).toEqual([30, 29, 28, 27]);
  expect(got.map((e) => e.seq)).toEqual(oracle(vault, thread.id, "ledger harbor rollout?", 4, {}));
});

test("fewer matches than the limit returns them all", () => {
  const { vault, thread } = tiedVault();
  const got = vault.episodes.search(thread.id, "palimpsest Valletta?", 10, { mode: "strict" });
  expect(got.map((e) => e.seq)).toEqual([54]);
  expect(got.map((e) => e.seq)).toEqual(oracle(vault, thread.id, "palimpsest Valletta?", 10, {}));
});

test("exclude drops a boundary row and the next tied turn takes its place", () => {
  const { vault, thread } = tiedVault();
  const opts = { mode: "strict" as const, exclude: 37 };
  const got = vault.episodes.search(thread.id, "ledger harbor rollout?", 5, opts);
  expect(got.map((e) => e.seq)).toEqual([40, 39, 38, 36, 35]);
  expect(got.map((e) => e.seq)).toEqual(oracle(vault, thread.id, "ledger harbor rollout?", 5, opts));
});

test("before cuts the newest tie without disturbing the order", () => {
  const { vault, thread } = tiedVault();
  const opts = { mode: "strict" as const, before: 38 };
  const got = vault.episodes.search(thread.id, "ledger harbor rollout?", 5, opts);
  expect(got.map((e) => e.seq)).toEqual([37, 36, 35, 34, 33]);
  expect(got.map((e) => e.seq)).toEqual(oracle(vault, thread.id, "ledger harbor rollout?", 5, opts));
});

/**
 * 300 tied rows outrun the first candidate window (256), so the first pass
 * cannot prove itself and the search has to widen before it answers.
 */
test("a tie set larger than the first candidate window is still exact", () => {
  const { vault, thread } = tempVault();
  const contents: string[] = [];
  for (let i = 0; i < 300; i += 1) contents.push(TIED);
  contents.push("the ledger rollout reached the harbor stage and then the harbor stage again");
  seed(vault, thread, contents);
  for (const limit of [1, 5, 32, 260]) {
    for (const opts of [{}, { exclude: 299 }, { before: 250 }] as SearchOpts[]) {
      const got = vault.episodes.search(thread.id, "ledger harbor rollout?", limit, opts).map((e) => e.seq);
      expect(got).toEqual(oracle(vault, thread.id, "ledger harbor rollout?", limit, opts));
    }
  }
  expect(vault.episodes.search(thread.id, "ledger harbor rollout?", 3, {}).map((e) => e.seq)).toEqual([
    300, 299, 298,
  ]);
});

test("searchBounded and searchCoverage select the same rows in the same order", () => {
  const { vault, thread } = tiedVault();
  const options: SearchOpts[] = [{}, { mode: "strict" }, { exclude: 37 }, { before: 38 }];
  for (const query of QUERIES) {
    for (const limit of [1, 5, 40]) {
      for (const opts of options) {
        const expected = oracle(vault, thread.id, query, limit, opts);
        expect(vault.episodes.searchBounded(thread.id, query, limit, opts).map((v) => v.seq)).toEqual(
          expected,
        );
        expect(vault.episodes.searchCoverage(thread.id, query, limit, opts).map((r) => r.seq)).toEqual(
          expected,
        );
      }
    }
  }
});

test("the bounded projections still carry their own columns", () => {
  const { vault, thread } = tiedVault();
  const views = vault.episodes.searchBounded(thread.id, "palimpsest Valletta?", 5, { mode: "strict" });
  expect(views).toHaveLength(1);
  const view = views[0];
  if (view === undefined) throw new Error("no view");
  expect(view.content).toBe("a palimpsest of Valletta, kept exactly as written");
  expect(view.contentTruncated).toBe(false);
  const rows = vault.episodes.searchCoverage(thread.id, "palimpsest Valletta?", 5, { mode: "strict" });
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error("no row");
  expect(row.role).toBe("user");
  expect(row.removed).toBe(false);
  expect(row.contentBytes).toBe(Buffer.byteLength(view.content, "utf8"));
  const stored = vault.db
    .query("SELECT content_hash AS hash FROM episode WHERE thread_id = ? AND seq = ?")
    .get(thread.id, row.seq) as { hash: string };
  expect(row.contentHash).toBe(stored.hash);
});
