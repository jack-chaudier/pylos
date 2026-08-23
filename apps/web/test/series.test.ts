/**
 * The proof chart's data.
 *
 * `public/bench/series.json` is the only thing the chart reads, and it is
 * derived from `bench/results/million-5.json` at build time. If the reduction
 * ever disagrees with the artifact — a survival curve that flatters, a receipt
 * figure that is not in the run — the page states a number the bench did not
 * measure. These tests are that boundary.
 */
import { describe, expect, test } from "bun:test";
import artifact from "../../../bench/results/million-5.json";
import series from "../public/bench/series.json";

const run = artifact as {
  N: number;
  budget: number;
  checkpoints: {
    seq: number;
    archiveBytes: number;
    residentTokensP50: number;
    budgetCheck: { queryTokensMax: number };
    ledger: { entries: number };
    baselines: { rolling: { survival: number }; bm25: { survival: number } };
    verify: { ok: boolean; headHash: string };
  }[];
  final: { archiveBytes: number; lossEntries: number; capsules: number };
};

const last = run.checkpoints[run.checkpoints.length - 1];
if (!last) throw new Error("million-5.json has no checkpoints");

describe("the proof series", () => {
  test("has one point per bench checkpoint, in order", () => {
    expect(series.points).toHaveLength(100);
    expect(series.points).toHaveLength(run.checkpoints.length);
    expect(series.turns).toBe(run.N);
    expect(series.budget).toBe(run.budget);
    expect(series.points.map((p) => p.seq)).toEqual(run.checkpoints.map((c) => c.seq));
  });

  test("every planted family survived at every checkpoint", () => {
    for (const point of series.points) {
      expect(point.pylos).toBe(1);
    }
  });

  test("carries the bench's own numbers, not rounded ones", () => {
    for (const [i, point] of series.points.entries()) {
      const c = run.checkpoints[i];
      if (!c) throw new Error(`no checkpoint ${i}`);
      expect(point.archiveBytes).toBe(c.archiveBytes);
      expect(point.viewP50).toBe(c.residentTokensP50);
      expect(point.viewMax).toBe(c.budgetCheck.queryTokensMax);
      expect(point.ledger).toBe(c.ledger.entries);
      expect(point.rolling).toBe(c.baselines.rolling.survival);
      expect(point.bm25).toBe(c.baselines.bm25.survival);
    }
  });

  test("the view never exceeded the budget the page prints", () => {
    for (const point of series.points) {
      expect(point.viewMax).toBeLessThanOrEqual(series.budget);
      expect(point.viewP50).toBeLessThanOrEqual(point.viewMax);
    }
  });

  test("the receipt figures are the run's own", () => {
    const f = series.final;
    expect(f.archiveBytes).toBe(run.final.archiveBytes);
    expect(f.lossEntries).toBe(run.final.lossEntries);
    expect(f.capsules).toBe(run.final.capsules);
    expect(f.verifyOk).toBe(last.verify.ok);
    expect(f.headHash).toBe(last.verify.headHash);
    // Exhaustive at the last checkpoint; summed for the probes re-drawn each time.
    expect(f.facts).toEqual({ checked: 2000, passed: 2000 });
    expect(f.quotes).toEqual({ checked: 200, passed: 200 });
    expect(f.numbers).toEqual({ checked: 50, passed: 50 });
    expect(f.memories).toEqual({ checked: 2000, passed: 2000 });
    expect(f.sequence).toEqual({ checked: 10_000, passed: 10_000 });
    expect(f.faults).toEqual({ asked: 2000, receipted: 2000 });
  });
});
