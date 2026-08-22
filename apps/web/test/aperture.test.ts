/**
 * The aperture's truth boundary.
 *
 * The exhibit is allowed to show a recovery only when the run's ledger actually
 * routed to a turn and that turn's exact text went through the run. These tests
 * guard the shape of the committed snapshot the page serves, so a fabricated
 * quote or a mismatched locator cannot ship silently.
 */
import { describe, expect, test } from "bun:test";
import snapshot from "../public/aperture/final.json";
import { corpus, REVISION_SEQ, SEED, TOTAL_TURNS } from "../src/aperture/thread";

const run = snapshot as {
  engine: string;
  seed: string;
  turn: number;
  routed: boolean;
  lossRows: number;
  packet: { tokens: number; budget: number };
  recovered: { seq: number; text: string; trigger: string; quote: string; query: string } | null;
  resident: { seq: number; line: string; historical: string | null; query: string } | null;
};

describe("aperture snapshot", () => {
  test("is a finished run of the real compiler over the bench's own thread", () => {
    expect(run.engine).toBe("core");
    expect(run.seed).toBe(SEED);
    expect(run.turn).toBe(TOTAL_TURNS);
    expect(run.routed).toBe(true);
    expect(run.lossRows).toBeGreaterThan(0);
    expect(run.packet.tokens).toBeLessThanOrEqual(run.packet.budget);
  });

  test("cites a turn that really is in the archive, verbatim", () => {
    if (run.recovered === null) return;
    expect(run.recovered.text).toBe(corpus.episodeAt(run.recovered.seq).content);
  });

  test("highlights a span that is really in that text", () => {
    if (run.recovered === null) return;
    expect(run.recovered.quote.length).toBeGreaterThan(0);
    expect(run.recovered.text.toLowerCase()).toContain(run.recovered.quote.toLowerCase());
  });

  test("names the ledger route that fired, and the question that fired it", () => {
    if (run.recovered === null) return;
    expect(run.recovered.trigger).toStartWith("ledger");
    expect(run.recovered.query.length).toBeGreaterThan(0);
  });

  test("answers the trap from the resident rule certificate, not from a page", () => {
    expect(run.resident).not.toBeNull();
    const resident = run.resident as NonNullable<typeof run.resident>;
    expect(resident.seq).toBe(REVISION_SEQ);
    expect(resident.line).toContain("additive-only");
    expect(resident.line).toContain(`⟨#${REVISION_SEQ}⟩`);
    // The superseded rule is labelled, never dropped.
    expect(resident.historical).toContain("historical");
    expect(resident.query).toBe(corpus.manifest.trapText);
  });
});
