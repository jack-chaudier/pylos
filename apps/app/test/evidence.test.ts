import { describe, expect, test } from "bun:test";
import type { ClaimClassificationReceipt, DemoApiLinks, ThreadStats } from "@pylos/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EvidenceFigures, figureHints } from "../src/components/Evidence.tsx";
import { focusedReceiptHref } from "../src/components/ProofTour.tsx";
import { formatClaimEvidence } from "../src/components/Xray.tsx";

const baseClaim: ClaimClassificationReceipt = {
  span: [0, 10],
  kind: "collection",
  classification: "SUPPORTED",
  capabilityDigests: [],
};

const baseLinks: DemoApiLinks = {
  packet: "/packet",
  questionEpisode: "/question",
  answerEpisode: "/answer",
};

describe("evidence receipt presentation", () => {
  test("counts and names a coverage basis as current evidence", () => {
    expect(
      formatClaimEvidence({
        ...baseClaim,
        basis: {
          kind: "coverage",
          digest: "abcdef0123456789",
          metric: "located",
          value: 10,
        },
      }),
    ).toBe("coverage · located 10 · abcdef01…6789");
  });

  test("keeps unsupported claims visibly unwitnessed", () => {
    expect(formatClaimEvidence(baseClaim)).toBe("no current witness");
  });

  test("prefers a focused receipt over a raw packet", () => {
    expect(focusedReceiptHref({ ...baseLinks, packetReceipt: "/packet-receipt" })).toBe("/packet-receipt");
    expect(
      focusedReceiptHref({
        ...baseLinks,
        packetReceipt: "/packet-receipt",
        receipt: "/receipt",
      } as DemoApiLinks & {
        receipt: string;
      }),
    ).toBe("/receipt");
    expect(focusedReceiptHref(baseLinks)).toBeUndefined();
  });
});

/** Words a first-time reader has not been taught yet. A hint that needs one is not a hint. */
const JARGON = ["packet", "capsule", "ledger", "compaction", "verbatim", "X-ray", "span"];

function hintsFor(over: Partial<Parameters<typeof figureHints>[0]>): ReturnType<typeof figureHints> {
  return figureHints({
    turns: 1204118,
    recovered: 3,
    viewTokens: 7900,
    viewRounds: 1,
    budget: 32768,
    verifiedTo: 1204118,
    archiveBytes: 1160077414,
    ...over,
  });
}

describe("the four figures say what they measure", () => {
  test("each hint is a plain sentence that ends at the X-ray", () => {
    const hints = hintsFor({});
    for (const hint of Object.values(hints)) {
      expect(hint.length).toBeGreaterThan(40);
      expect(hint).toEndWith("Click to open what the model saw.");
      for (const word of JARGON) expect(hint.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  test("the figures name their own subject", () => {
    const hints = hintsFor({});
    expect(hints.archive).toContain("kept exactly");
    expect(hints.archive).toContain("1.08 GiB");
    expect(hints.view).toContain("bounded text the model reads");
    expect(hints.view).toContain("7.9k of 32.8k tokens");
    expect(hints.paged).toContain("brought back exactly");
    expect(hints.chain).toContain("hash chain verified");
    expect(hints.chain).toContain("it holds through all 1,204,118 turns");
  });

  test("a turn that cost more than one request says so", () => {
    expect(hintsFor({ viewRounds: 3 }).view).toContain("took 3 requests");
  });

  test("before a first turn the empty figures say nothing has happened yet", () => {
    const hints = hintsFor({ turns: 0, recovered: 0, viewTokens: undefined, verifiedTo: 0 });
    expect(hints.view).toContain("nothing has been compiled for a model yet");
    expect(hints.chain).toContain("nothing has been written to this thread yet");
    expect(hints.paged).toContain("nothing has been asked yet");
    expect(hints.archive).toContain("nothing has been said in this thread yet");
  });

  test("a chain checked only part of the way does not read as verified", () => {
    expect(hintsFor({ verifiedTo: 900000 }).chain).toContain("checked through turn 900,000 of 1,204,118");
  });

  test("every figure carries its hint as a tooltip and to a screen reader", () => {
    const stats = { verifiedTo: 4, archiveBytes: 2048 } as ThreadStats;
    const html = renderToStaticMarkup(
      createElement(EvidenceFigures, {
        stats,
        turns: 4,
        recovered: 1,
        viewTokens: 900,
        viewRounds: 2,
        budget: 8192,
        onOpen: () => undefined,
      }),
    );
    const titles = [...html.matchAll(/title="([^"]*)"/g)].map((match) => match[1] ?? "");
    const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1] ?? "");
    expect(titles).toHaveLength(4);
    expect(labels).toHaveLength(4);
    for (const title of titles) expect(title).toContain("what the model saw");
    expect(labels[0]).toStartWith("archive 4 turns — ");
    expect(labels[1]).toStartWith("view 900 / 8.2k · 2 rounds — ");
    expect(labels[2]).toStartWith("paged 1 — ");
    expect(labels[3]).toStartWith("chain ✓ — ");
  });
});
