/**
 * `pageLabel` is what the transcript's recovery line says a page came back for.
 * Every trigger the kernel can record has to have a reader's word for it — a
 * missing case would print nothing above an answer that paged real material.
 */
import { describe, expect, test } from "bun:test";
import type { PageRecord } from "@pylos/protocol";
import { pageLabel, turnList } from "../src/format.ts";

const record = (page: Partial<PageRecord> & { trigger: PageRecord["trigger"] }): PageRecord => ({
  seqs: [],
  tokens: 0,
  latencyMs: 0,
  resolved: true,
  ...page,
});

describe("pageLabel", () => {
  test("names every trigger the kernel records", () => {
    const triggers: Array<PageRecord["trigger"]> = [
      "sequence",
      "ledger",
      "historical",
      "search",
      "path",
      "model",
      "explicit",
      "check",
      "fault",
    ];
    for (const trigger of triggers) {
      expect(pageLabel(record({ trigger, seqs: [7], query: "#61234", name: "orders" }))).not.toBe("");
    }
  });

  test("a fault is named as one — KERNEL A11.1", () => {
    expect(pageLabel(record({ trigger: "fault", query: "did I mention it?", resolved: false }))).toBe(
      "page fault",
    );
  });

  test("a path page names the turn whose receipt led to it — KERNEL A11.2", () => {
    expect(pageLabel(record({ trigger: "path", query: "#61234", seqs: [450] }))).toBe(
      "by way of turn 61,234",
    );
    // The label is grouped as the interface prints turn numbers everywhere else.
    expect(pageLabel(record({ trigger: "path", query: "#7", seqs: [3] }))).toBe("by way of turn 7");
  });
});

/**
 * The recovery line names the turns it brought back. It used to repeat the
 * search query, which told the reader nothing they had not just typed.
 */
describe("turnList", () => {
  test("one turn is named in the singular", () => {
    expect(turnList([966])).toBe("turn 966");
  });

  test("two turns are joined by and", () => {
    expect(turnList([1, 966])).toBe("turns 1 and 966");
  });

  test("three turns are a list", () => {
    expect(turnList([1, 966, 4120])).toBe("turns 1, 966 and 4,120");
  });

  test("past three the line counts the rest instead of listing it", () => {
    expect(turnList([1, 966, 4120, 5001])).toBe("turns 1, 966 and 2 more");
    expect(turnList([1, 966, 4120, 5001, 6002, 7003])).toBe("turns 1, 966 and 4 more");
  });

  test("turn numbers carry thousands separators", () => {
    expect(turnList([61234])).toBe("turn 61,234");
    expect(turnList([1000000, 1000001])).toBe("turns 1,000,000 and 1,000,001");
  });

  test("nothing recovered names nothing", () => {
    expect(turnList([])).toBe("");
  });
});
