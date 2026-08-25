import { afterEach, describe, expect, test } from "bun:test";
import type { DemoSummary, ThreadStats } from "@pylos/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api.ts";
import {
  ARCHIVE_PULL_SOURCE_HIT_SIZE,
  ARCHIVE_PULL_TRACK_MIN_WIDTH,
  archivePullModel,
  archiveTurnAddress,
  isProofDemoThread,
  ProofDemoPrompt,
  ProofTour,
  proofCollectionReceipt,
} from "../src/components/ProofTour.tsx";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("proof demo transport", () => {
  test("recognizes a persisted proof thread without confusing an ordinary thread", () => {
    const thread = (models: string[]) => ({ models }) as ThreadStats;
    expect(isProofDemoThread(thread(["pylos-proof-demo"]))).toBe(true);
    expect(isProofDemoThread(thread(["grok-4.6"]))).toBe(false);
    expect(isProofDemoThread(undefined)).toBe(false);
  });

  test("renders the tombstone action and scoped archive count in the proof tour", () => {
    const page = {
      trigger: "invalidation",
      resolved: false,
      source: "episode:42",
      byteRange: [0, 34],
    };
    const links = {
      packet: "/api/threads/thread-proof/packets/1",
      packetReceipt: "/api/threads/thread-proof/demo/packets/1",
      questionEpisode: "/api/threads/thread-proof/episodes/1",
      answerEpisode: "/api/threads/thread-proof/episodes/2",
      route: "/api/threads/thread-proof/demo/routes/route-1",
      attachment: "/api/threads/thread-proof/episodes/43",
      span: "/api/threads/thread-proof/demo/attachments/43/spans/1",
    };
    const turn = {
      query: "What is the vault access code?",
      questionSeq: 1,
      answerSeq: 2,
      packetId: "packet-1",
      answer: "I can no longer verify the vault access code.",
      pages: [page],
      links,
      answerReceipt: { status: "released", digest: "receipt" },
    };
    const sourceSeqs = [11, 13, 15, 17, 19, 21, 23, 25, 27, 29];
    const sources = sourceSeqs.map((seq) => ({
      seq,
      text: `Launch note: source ${seq}.`,
      href: `/api/threads/thread-proof/episodes/${seq}`,
    }));
    const summary = {
      version: "proof-v1",
      seeded: false,
      thread: {
        threadId: "thread-proof",
        title: "The proof thread",
        turns: 198,
        archiveBytes: 11_900_000,
        capsules: 30,
        losses: 26,
        headHash: "head",
        verifiedTo: 198,
        lastPacket: { tokens: 3_512, budget: 8_192, pages: 0, digest: "packet" },
      },
      proof: {
        correctedFact: {
          originalSeq: 3,
          correctionSeq: 5,
          historicalValue: "Lisbon",
          currentValue: "Porto",
          originalText: "I live in Lisbon.",
          currentText: "I live in Porto.",
          grounded: turn,
          routeId: "route-current",
          currentWitness: {
            seq: 5,
            source: "episode:5",
            byteRange: [0, 17],
            contentHash: "content",
            authority: "user",
          },
        },
        collection: {
          ...turn,
          query: "List all 11 launch notes.",
          answer: "I found 10 launch-note sources.",
          required: 11,
          located: 10,
          supported: 10,
          completeness: "incomplete",
          sources,
          coverage: {
            required: 11,
            located: 10,
            supported: 10,
            historical: 0,
            unresolved: 1,
            completeness: "incomplete",
            routes: [],
            digest: "coverage",
          },
        },
        invalidation: {
          grounded: turn,
          repeated: turn,
          sourceSeq: 42,
          sourceText: "⟦removed by user · tb_demo42⟧",
          sourceReceipt: {
            status: "tombstoned",
            contentAvailable: false,
            tombstoneId: "tb_demo42",
            originalContentHash: "a".repeat(64),
            locatorOmittedReason: "removed",
          },
          sourceHref: "/api/threads/thread-proof/episodes/42",
          routeId: "route-1",
          page,
        },
        attachment: {
          seq: 43,
          name: "proof-tail.txt",
          manifestId: "manifest-1",
          spans: 2,
          tail: { from: 10, to: 20, hash: "tail", marker: "TAIL_MARKER" },
          page: { trigger: "attachment-tail", resolved: true, source: "attachment:43", byteRange: [10, 20] },
          links,
        },
      },
      final: {
        ...turn,
        query: "List all 11 launch notes.",
        answer: "I found 10 launch-note sources.",
        questionSeq: 197,
        answerSeq: 198,
        pages: [],
      },
    } as unknown as DemoSummary;
    const html = renderToStaticMarkup(createElement(ProofTour, { summary, onClose: () => undefined }));
    expect(html).toContain("Open tombstone receipt");
    expect(html).toContain("Open historical statement");
    expect(html).not.toContain("Open deleted statement");
    expect(html).not.toContain("Open bounded response");
    expect(html).toContain("Inspect bounded JSON");
    expect(html).toContain("linked source");
    expect(html).toContain("requested tail range");
    expect(html).toContain("Open containing-span tail");
    expect(html).toContain("Open exact tail receipt");
    expect(html).toContain('data-evidence-href="/api/threads/thread-proof/demo/packets/1"');
    expect(html).toContain("containing manifest span");
    expect(html).toContain("Not rechecked this session");
    expect(html).toContain("archive omissions · loss ledger");
    expect(html).toContain("loss-ledger count");
    expect(html).toContain("not a universal recall claim");
    // The count in the intro is honest only if it names as many acts as the tour has.
    expect(html.match(/class="proof-step"/g)).toHaveLength(5);
    expect(html).toContain("the exact tail of a stored file");
    expect(html).toContain("million-turn export and restore proof");
    expect(html).not.toContain("Laptop Funeral");
    expect(html).toContain("168-turn pull");
    expect(html).toContain("collection routes / source bindings");
    expect(html).toContain("3,512 / 8,192");
    expect(html).toContain("11 requested / 10 exact sources / 1 unresolved");
    expect(html).toContain("3,512 / 8,192 bounded-view context");
    expect(html).toContain("question #197");
    expect(html).toContain("Newest exact source");
    expect(html).toContain(">#29</strong>");
    expect(html).toContain("168 turns before question");
    expect(html).toContain("Choose any archived turn 1–198");
    expect(html).toContain("not semantic recall");
    expect(html.match(/data-archive-pull-source=/g)).toHaveLength(10);
    expect(html.match(/aria-label="Open launch note \d+, episode #\d+"/g)).toHaveLength(10);
    for (const seq of sourceSeqs) {
      expect(html).toContain(`Launch note #${seq}`);
      expect(html).toContain(`data-archive-pull-source="${seq}"`);
      expect(html).toContain(`data-archive-pull-source-href="/api/threads/thread-proof/episodes/${seq}"`);
      expect(html).toContain(`Open note ${sourceSeqs.indexOf(seq) + 1} · #${seq}`);
    }
  });

  test("validates direct sequence addresses without claiming semantic recall", () => {
    expect(archiveTurnAddress("thread-proof", "7", 198)).toEqual({
      ok: true,
      seq: 7,
      href: "/api/threads/thread-proof/episodes/7",
    });
    expect(archiveTurnAddress("thread-proof", "198", 198)).toEqual({
      ok: true,
      seq: 198,
      href: "/api/threads/thread-proof/episodes/198",
    });
    for (const raw of ["", "0", "199", "7.5", "1e2", "-7", "  "]) {
      expect(archiveTurnAddress("thread-proof", raw, 198).ok).toBe(false);
    }
  });

  test("derives the 168-turn source-binding map without manufacturing the unresolved source", () => {
    const sourceSeqs = [11, 13, 15, 17, 19, 21, 23, 25, 27, 29];
    const sources = sourceSeqs.map((seq) => ({
      seq,
      text: `Launch note: source ${seq}.`,
      href: `/api/threads/thread-proof/episodes/${seq}`,
    }));
    const summary = {
      thread: {
        turns: 198,
        lastPacket: { tokens: 3_512, budget: 8_192, pages: 0, digest: "packet" },
      },
      proof: {
        collection: {
          required: 11,
          located: 10,
          supported: 10,
          completeness: "incomplete",
          sources,
          coverage: {
            required: 11,
            located: 10,
            supported: 10,
            historical: 0,
            unresolved: 1,
            completeness: "incomplete",
          },
        },
      },
      final: {
        questionSeq: 197,
        pages: [],
        answer: "I found 10 launch-note sources.",
        answerReceipt: { status: "released", digest: "receipt" },
      },
    } as unknown as DemoSummary;
    const model = archivePullModel(summary);
    expect(model.totalTurns).toBe(198);
    expect(model.questionSeq).toBe(197);
    expect(model.newestSourceSeq).toBe(29);
    expect(model.distanceFromNewestSource).toBe(168);
    expect(model.requested).toBe(11);
    expect(model.exactSources).toBe(10);
    expect(model.unresolved).toBe(1);
    expect(model.viewTokens).toBe(3_512);
    expect(model.viewBudget).toBe(8_192);
    expect(model.packetPages).toBe(0);
    expect(model.sources.map((source) => source.seq)).toEqual(sourceSeqs);
    expect(model.sources.some((source) => source.seq === 31)).toBe(false);
    expect(new Set(model.sources.map((source) => source.href)).size).toBe(10);
    expect(new Set(model.sources.map((source) => source.lane)).size).toBeGreaterThan(1);
    for (const lane of new Set(model.sources.map((source) => source.lane))) {
      const laneSources = model.sources
        .filter((source) => source.lane === lane)
        .toSorted((left, right) => left.position - right.position);
      for (let index = 1; index < laneSources.length; index += 1) {
        const previous = laneSources[index - 1];
        const current = laneSources[index];
        if (previous === undefined || current === undefined) continue;
        const gap = ((current.position - previous.position) / 100) * ARCHIVE_PULL_TRACK_MIN_WIDTH;
        expect(gap).toBeGreaterThanOrEqual(ARCHIVE_PULL_SOURCE_HIT_SIZE);
      }
    }

    const missingSource = {
      ...summary,
      proof: {
        collection: {
          ...summary.proof.collection,
          sources: sources.filter((source) => source.seq !== 19),
        },
      },
    } as unknown as DemoSummary;
    expect(archivePullModel(missingSource).sources).toHaveLength(0);

    const duplicateHref = {
      ...summary,
      proof: {
        collection: {
          ...summary.proof.collection,
          sources: sources.map((source, index) =>
            index === 1 ? { ...source, href: sources[0]?.href ?? source.href } : source,
          ),
        },
      },
    } as unknown as DemoSummary;
    expect(archivePullModel(duplicateHref).sources).toHaveLength(0);
  });

  test("keeps the proof tour counts and source list on one verified receipt", () => {
    const sources = Array.from({ length: 10 }, (_, index) => ({
      seq: index + 1,
      text: `Launch note: source ${index + 1}.`,
      href: `/api/threads/thread-proof/episodes/${index + 1}`,
    }));
    const valid = {
      proof: {
        collection: {
          required: 11,
          located: 10,
          supported: 10,
          completeness: "incomplete",
          sources,
          answer: "I found 10 launch-note sources.",
          coverage: {
            required: 11,
            located: 10,
            supported: 10,
            unresolved: 1,
            completeness: "incomplete",
          },
        },
      },
      final: {
        answer: "I found 10 launch-note sources.",
        answerReceipt: { status: "released", digest: "receipt" },
      },
    } as unknown as DemoSummary;
    const receipt = proofCollectionReceipt(valid);
    expect(receipt.verified).toBe(true);
    expect(receipt.required).toBe(11);
    expect(receipt.located).toBe(10);
    expect(receipt.supported).toBe(10);
    expect(receipt.unresolved).toBe(1);
    expect(receipt.sources).toHaveLength(10);

    const inconsistent = {
      ...valid,
      proof: {
        collection: {
          ...valid.proof.collection,
          coverage: {
            ...valid.proof.collection.coverage,
            located: 11,
            supported: 11,
            unresolved: 0,
            completeness: "complete",
          },
          sources: [...sources, { seq: 52, text: "Archive filler 52", href: "/episodes/52" }],
        },
      },
      final: {
        ...valid.final,
        answer: "I found 10 launch-note sources.\n\n⟨pylos UNKNOWN · mismatch⟩",
        answerReceipt: { status: "qualified", digest: "receipt" },
      },
    } as unknown as DemoSummary;
    const withheld = proofCollectionReceipt(inconsistent);
    expect(withheld.verified).toBe(false);
    expect(withheld.sources).toHaveLength(0);
    expect(withheld.answer).toContain("withheld");
  });

  test("posts to the thread-scoped demo route", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(JSON.stringify({ seeded: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await api.demo("thread-proof");

    expect(result.seeded).toBe(true);
    expect(seenUrl).toBe("/api/threads/thread-proof/demo");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.body).toBe("{}");
  });

  test("reopens a persisted proof through the read-only route", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(JSON.stringify({ seeded: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await api.demoSummary("thread-proof");

    expect(result.seeded).toBe(false);
    expect(seenUrl).toBe("/api/threads/thread-proof/demo");
    expect(seenInit?.method).toBeUndefined();
    expect(seenInit?.body).toBeUndefined();
  });
});

describe("empty thread invitation", () => {
  test("offers a way to connect a model only while no provider is connected", () => {
    const connected = renderToStaticMarkup(
      createElement(ProofDemoPrompt, {
        busy: false,
        error: undefined,
        onOpen: () => undefined,
        onConnect: undefined,
      }),
    );

    expect(connected).toContain("Say anything. It will be kept.");
    expect(connected).toContain("or open the proof thread →");
    expect(connected).not.toContain("Connect a model");

    const coldStart = renderToStaticMarkup(
      createElement(ProofDemoPrompt, {
        busy: false,
        error: undefined,
        onOpen: () => undefined,
        onConnect: () => undefined,
      }),
    );

    expect(coldStart).toContain("Connect a model →");
    expect(coldStart).toContain('class="ghost coldstart-connect"');
    expect(coldStart).toContain("or open the proof thread →");
  });
});
