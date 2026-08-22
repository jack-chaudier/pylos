/**
 * The aperture's truth boundary.
 *
 * The exhibit is allowed to show a recovery only when the run's ledger actually
 * routed to the revision turn and that turn's exact text went through the run.
 * These tests guard the shape of the committed snapshot the page serves, so a
 * fabricated quote or a mismatched locator cannot ship silently.
 */
import { describe, expect, test } from "bun:test";
import snapshot from "../public/aperture/final.json";
import { REVISION_SEQ, REVISION_TEXT, TOTAL_TURNS } from "../src/sim/corpus";

const run = snapshot as {
  engine: string;
  turn: number;
  routed: boolean;
  lossRows: number;
  recovered: { seq: number; text: string; trigger: string; quote: string } | null;
};

describe("aperture snapshot", () => {
  test("is a finished run of the real compiler", () => {
    expect(run.engine).toBe("core");
    expect(run.turn).toBe(TOTAL_TURNS);
    expect(run.routed).toBe(true);
    expect(run.lossRows).toBeGreaterThan(0);
  });

  test("only ever cites the revision turn", () => {
    if (run.recovered === null) return;
    expect(run.recovered.seq).toBe(REVISION_SEQ);
  });

  test("carries the exact text of the turn it cites, not a stand-in", () => {
    if (run.recovered === null) return;
    expect(run.recovered.text).toBe(REVISION_TEXT);
  });

  test("highlights a span that is really in that text", () => {
    if (run.recovered === null) return;
    expect(run.recovered.quote.length).toBeGreaterThan(0);
    expect(run.recovered.text.toLowerCase()).toContain(run.recovered.quote.toLowerCase());
  });

  test("names the ledger route that fired", () => {
    if (run.recovered === null) return;
    expect(run.recovered.trigger).toStartWith("ledger");
  });
});
