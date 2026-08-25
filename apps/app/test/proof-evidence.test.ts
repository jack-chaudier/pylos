import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  api,
  MAX_EVIDENCE_JSON_CHARS,
  MAX_EVIDENCE_RESPONSE_BYTES,
  MAX_EVIDENCE_TAIL_BYTES,
  normalizeEvidenceResource,
} from "../src/api.ts";
import {
  ExactTailReceipt,
  formatEvidenceResource,
  formatExactTailReceipt,
  sha256Bytes,
  verifyExactTail,
} from "../src/components/ProofTour.tsx";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("proof evidence viewer resources", () => {
  test("does not parse a raw oversized episode body and asks the bounded evidence endpoint", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      const oversized = JSON.stringify({ content: "x".repeat(MAX_EVIDENCE_RESPONSE_BYTES * 2) });
      return new Response(oversized, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await expect(api.demoEvidence("/api/threads/thread-proof/episodes/42")).rejects.toMatchObject({
      code: "evidence_too_large",
      status: 413,
    });
    expect(seenUrl).toContain("/api/threads/thread-proof/demo/evidence?");
    expect(seenUrl).not.toBe("/api/threads/thread-proof/episodes/42");
  });

  test("does not parse a raw oversized packet body", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      const oversized = JSON.stringify({ messages: Array.from({ length: 20_000 }, () => "provider output") });
      return new Response(oversized, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    await expect(api.demoEvidence("/api/threads/thread-proof/packets/packet-1")).rejects.toMatchObject({
      code: "evidence_too_large",
      status: 413,
    });
    expect(seenUrl).toContain("/api/threads/thread-proof/demo/evidence?");
  });

  test("fetches an existing local href and drops attachment base64 after a bounded tail decode", async () => {
    const source = new TextEncoder().encode(`${"x".repeat(3_000)}TAIL · exact stored words`);
    const encoded = base64(source);
    let seenUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({
          threadId: "thread-proof",
          seq: 17,
          ordinal: 1,
          manifestId: "manifest-17",
          manifest: {
            id: "manifest-17",
            name: "launch-notes.txt",
            mime: "text/plain",
            size: source.byteLength,
            chunkSize: 65_536,
            spans: [],
            hash: "h",
            digest: "m",
          },
          span: {
            ordinal: 1,
            from: 65_536,
            to: 65_536 + source.byteLength,
            hash: "span-hash",
            state: "indexed",
            objectHash: "object-hash",
            encoding: "utf-8",
          },
          bytesBase64: encoded,
          byteLength: source.byteLength,
          digest: "span-hash",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const resource = await api.demoEvidence("/api/threads/thread-proof/demo/attachments/17/spans/1");

    expect(seenUrl).toContain("/api/threads/thread-proof/demo/evidence?");
    expect(seenUrl).toContain(encodeURIComponent("/api/threads/thread-proof/demo/attachments/17/spans/1"));
    expect(resource.kind).toBe("attachment-span");
    if (resource.kind !== "attachment-span") throw new Error("expected attachment resource");
    expect(resource.href).toBe("/api/threads/thread-proof/demo/attachments/17/spans/1");
    expect(resource).not.toHaveProperty("bytesBase64");
    expect(JSON.stringify(resource)).not.toContain(encoded);
    expect(resource.byteLength).toBe(source.byteLength);
    expect(resource.excerptTruncated).toBe(true);
    expect(resource.excerpt).toContain("TAIL · exact stored words");
    expect(resource.tailBytes.byteLength).toBeLessThanOrEqual(MAX_EVIDENCE_TAIL_BYTES);
    expect(resource.tailBytesTo - resource.tailBytesFrom).toBe(resource.tailBytes.byteLength);
    const view = formatEvidenceResource(resource);
    expect(view.rows.find((row) => row.label === "containing-span tail window")?.value).toContain(
      "TAIL · exact stored words",
    );
    expect(view.body?.label).toBe("containing-span tail window");
    expect(view.note).toContain("not the requested tail range");
  });

  test("slices an offset requested range and visibly proves an exact tail MATCH", async () => {
    const spanFrom = 104_000;
    const spanTo = 108_192;
    const spanBytes = new Uint8Array(spanTo - spanFrom);
    spanBytes.fill(0x2e);
    const marker = new TextEncoder().encode("EXACT_REQUESTED_TAIL");
    const requestedFrom = 106_554;
    const requestedTo = 108_026;
    const requestedOffset = requestedFrom - spanFrom;
    spanBytes.set(marker, requestedOffset);
    const resource = normalizeEvidenceResource("/api/span", {
      threadId: "thread-proof",
      seq: 43,
      ordinal: 1,
      manifestId: "manifest-43",
      manifest: {
        id: "manifest-43",
        name: "proof-tail.txt",
        mime: "text/plain",
        size: spanBytes.byteLength,
        chunkSize: spanBytes.byteLength,
        spans: [],
        hash: "manifest-hash",
        digest: "manifest-digest",
      },
      span: {
        ordinal: 1,
        from: spanFrom,
        to: spanTo,
        hash: "containing-span-hash",
        state: "indexed",
        objectHash: "object-hash",
        encoding: "utf-8",
      },
      bytesBase64: base64(spanBytes),
      byteLength: spanBytes.byteLength,
      digest: "containing-span-hash",
    });
    if (resource.kind !== "attachment-span") throw new Error("expected attachment resource");
    const expectedBytes = resource.tailBytes.slice(
      requestedFrom - resource.tailBytesFrom,
      requestedTo - resource.tailBytesFrom,
    );
    const expectedHash = await sha256Bytes(expectedBytes);
    const receipt = await verifyExactTail(resource, [requestedFrom, requestedTo], expectedHash);

    expect(receipt.status).toBe("MATCH");
    expect(receipt.exactByteCount).toBe(1_472);
    expect(receipt.exactBytes).toEqual(expectedBytes);
    expect(receipt.expectedHash).toBe(expectedHash);
    expect(receipt.recomputedHash).toBe(expectedHash);
    expect(receipt.displayText).toContain("EXACT_REQUESTED_TAIL");
    const presentation = formatExactTailReceipt(receipt);
    expect(presentation.rows.find((row) => row.label === "requested byte range")?.value).toBe(
      "106554–108026",
    );
    expect(presentation.rows.find((row) => row.label === "exact byte count")?.value).toBe("1,472");
    expect(presentation.rows.find((row) => row.label === "verification")?.value).toBe("MATCH");
    expect(presentation.rows.find((row) => row.label === "containing span SHA-256")?.value).toBe(
      "containing-span-hash",
    );
    const html = renderToStaticMarkup(createElement(ExactTailReceipt, { receipt }));
    expect(html).toContain('data-exact-tail-status="MATCH"');
    expect(html).toContain("106554–108026");
    expect(html).toContain(expectedHash);
    expect(html).toContain("MATCH");
    expect(html).toContain("exact requested bytes");
  });

  test("withholds exact bytes on hash mismatch and reports the recomputation", async () => {
    const resource = normalizeEvidenceResource("/api/span", {
      threadId: "thread-proof",
      seq: 43,
      ordinal: 1,
      manifestId: "manifest-43",
      manifest: {
        id: "manifest-43",
        name: "tail.bin",
        mime: "application/octet-stream",
        size: 2048,
        spans: [],
      },
      span: {
        ordinal: 1,
        from: 100_000,
        to: 102_048,
        hash: "span-hash",
        state: "indexed",
        objectHash: "object-hash",
        encoding: "binary",
      },
      bytesBase64: base64(new Uint8Array(2_048).fill(0x41)),
      byteLength: 2_048,
      digest: "span-hash",
    });
    if (resource.kind !== "attachment-span") throw new Error("expected attachment resource");
    const receipt = await verifyExactTail(resource, [100_100, 100_200], "0".repeat(64));
    expect(receipt.status).toBe("MISMATCH");
    expect(receipt.exactByteCount).toBe(100);
    expect(receipt.exactBytes.byteLength).toBe(0);
    expect(receipt.recomputedHash).not.toBe("0".repeat(64));
    expect(formatExactTailReceipt(receipt).body.text).toContain("withheld");
    expect(formatExactTailReceipt(receipt).note).toContain("MISMATCH");
  });

  test("uses bounded base64 for a matching non-UTF-8 exact tail", async () => {
    const spanBytes = new Uint8Array(2_048);
    for (let index = 0; index < spanBytes.length; index += 1) spanBytes[index] = index % 2 === 0 ? 0xff : 0;
    const resource = normalizeEvidenceResource("/api/span", {
      threadId: "thread-proof",
      seq: 43,
      ordinal: 1,
      manifestId: "manifest-43",
      manifest: {
        id: "manifest-43",
        name: "tail.bin",
        mime: "application/octet-stream",
        size: 2_048,
        spans: [],
      },
      span: {
        ordinal: 1,
        from: 200_000,
        to: 202_048,
        hash: "span-hash",
        state: "indexed",
        objectHash: "object-hash",
        encoding: "binary",
      },
      bytesBase64: base64(spanBytes),
      byteLength: 2_048,
      digest: "span-hash",
    });
    if (resource.kind !== "attachment-span") throw new Error("expected attachment resource");
    const exactBytes = resource.tailBytes.slice(17, 117);
    const expectedHash = await sha256Bytes(exactBytes);
    const receipt = await verifyExactTail(
      resource,
      [resource.tailBytesFrom + 17, resource.tailBytesFrom + 117],
      expectedHash,
    );
    expect(receipt.status).toBe("MATCH");
    expect(receipt.displayEncoding).toBe("base64");
    expect(receipt.displayText).toBe(base64(exactBytes));
  });

  test("fails closed when a requested range is outside the span or outside the retained tail window", async () => {
    const resource = normalizeEvidenceResource("/api/span", {
      threadId: "thread-proof",
      seq: 43,
      ordinal: 1,
      manifestId: "manifest-43",
      manifest: {
        id: "manifest-43",
        name: "tail.bin",
        mime: "application/octet-stream",
        size: 4_096,
        spans: [],
      },
      span: {
        ordinal: 1,
        from: 104_000,
        to: 108_096,
        hash: "span-hash",
        state: "indexed",
        objectHash: "object-hash",
        encoding: "utf-8",
      },
      bytesBase64: base64(new Uint8Array(4_096).fill(0x42)),
      byteLength: 4_096,
      digest: "span-hash",
    });
    if (resource.kind !== "attachment-span") throw new Error("expected attachment resource");
    const outsideSpan = await verifyExactTail(resource, [103_999, 104_001], "expected");
    expect(outsideSpan.status).toBe("MISMATCH");
    expect(outsideSpan.reason).toContain("not contained by the manifest span");
    const outsideTail = await verifyExactTail(resource, [104_001, 104_100], "expected");
    expect(outsideTail.status).toBe("MISMATCH");
    expect(outsideTail.reason).toContain("outside the retained");
  });

  test("exposes a redacted bounded JSON response through the local evidence proxy", async () => {
    let seenUrl = "";
    const encoded = base64(new TextEncoder().encode("secret tail bytes"));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({
          kind: "attachment-span",
          bytesBase64: encoded,
          span: { from: 65_536, to: 70_000 },
          digest: "span-digest",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const raw = await api.demoEvidenceJson("/api/threads/thread-proof/demo/attachments/17/spans/1");

    expect(seenUrl).toContain("/api/threads/thread-proof/demo/evidence?");
    expect(raw).toContain('"kind": "attachment-span"');
    expect(raw).toContain("redacted");
    expect(raw).not.toContain(encoded);
  });

  test("surfaces bounded JSON fetch failures instead of offering a dead navigation link", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "evidence unavailable", code: "evidence_missing" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(api.demoEvidenceJson("/api/threads/thread-proof/episodes/42")).rejects.toMatchObject({
      code: "evidence_missing",
      status: 404,
    });
  });

  test("rejects external evidence hrefs before making a request", async () => {
    await expect(api.demoEvidence("https://example.com/not-a-pylos-receipt")).rejects.toMatchObject({
      code: "invalid_evidence_href",
      status: 400,
    });
    await expect(api.demoEvidence("/app/not-an-api-receipt")).rejects.toMatchObject({
      code: "invalid_evidence_href",
      status: 400,
    });
  });

  test("formats compact packet coverage and aggregate answer basis in plain language", () => {
    const resource = normalizeEvidenceResource("/api/packet-receipt", {
      id: "packet-1",
      threadId: "thread-proof",
      turnSeq: 192,
      digest: "packet-digest",
      status: "done",
      question: { seq: 192, text: "List every launch note." },
      answer: { seq: 193, text: "I found 10 launch-note sources." },
      pages: [
        {
          trigger: "attachment-tail",
          seqs: [17],
          tokens: 12,
          latencyMs: 1,
          resolved: true,
          source: "attachment:17",
          byteRange: [56_320, 57_792],
          spanHash: "requested-tail-span-hash",
        },
      ],
      pageCount: 1,
      pagesTruncated: false,
      coverage: {
        cue: "every",
        querySeq: 192,
        asOfSeq: 198,
        required: 11,
        located: 10,
        supported: 10,
        historical: 0,
        unresolved: 1,
        completeness: "incomplete",
        routes: [],
        routeCount: 0,
        routesTruncated: false,
        digest: "coverage-digest",
      },
      answerReceipt: {
        answerDigest: "answer-digest",
        scanDigest: "scan-digest",
        packetDigest: "packet-digest",
        roundsDigest: "rounds-digest",
        coverageDigest: "coverage-digest",
        grammarVersion: "A14.3",
        qualifications: ["one requested source remains unresolved"],
        status: "released",
        digest: "receipt-digest",
        candidates: [],
        candidateCount: 0,
        candidatesTruncated: false,
        classifications: [
          {
            span: [0, 31],
            kind: "collection",
            classification: "SUPPORTED",
            basis: { kind: "coverage", digest: "coverage-digest", metric: "located", value: 10 },
            capabilityDigestCount: 0,
          },
        ],
        classificationCount: 1,
        classificationsTruncated: false,
      },
      rawPacket: "/api/threads/thread-proof/packets/192",
    });
    expect(resource.kind).toBe("packet-receipt");
    if (resource.kind !== "packet-receipt") throw new Error("expected packet receipt");

    const view = formatEvidenceResource(resource);
    expect(view.rows.find((row) => row.label === "coverage")?.value).toContain("located 10");
    expect(view.rows.find((row) => row.label === "coverage")?.value).toContain("required 11");
    expect(view.rows.find((row) => row.label === "packet locator")?.value).toBe(
      "/api/threads/thread-proof/packets/192",
    );
    expect(view.rawHref).toBe("/api/packet-receipt");
    expect(view.rows.find((row) => row.label === "answer gate")?.value).toContain("released");
    expect(view.rows.find((row) => row.label === "attachment page trigger")?.value).toBe("attachment-tail");
    expect(view.rows.find((row) => row.label === "requested byte range")?.value).toBe("56320–57792");
    expect(view.rows.find((row) => row.label === "requested tail hash")?.value).toBe(
      "requested-tail-span-hash",
    );
  });

  test("labels an episode hash as a chain entry, not a content digest", () => {
    const resource = normalizeEvidenceResource("/api/threads/thread-proof/episodes/3", {
      threadId: "thread-proof",
      seq: 3,
      ts: 1,
      role: "user",
      content: "I live in Porto.",
      tokens: 5,
      prevHash: "previous-chain-entry",
      hash: "current-chain-entry",
      meta: {},
    });
    expect(resource.kind).toBe("episode");
    if (resource.kind !== "episode") throw new Error("expected episode resource");
    const view = formatEvidenceResource(resource);
    expect(view.rows.find((row) => row.label === "chain entry hash")?.value).toBe("current-chain-entry");
    expect(view.rows.some((row) => row.label === "content hash")).toBe(false);
  });

  test("shows the bounded episode locator and truncation receipt", () => {
    const resource = normalizeEvidenceResource("/api/threads/thread-proof/demo/evidence", {
      kind: "episode",
      threadId: "thread-proof",
      seq: 42,
      role: "user",
      text: "safe prefix",
      textBytes: 11,
      byteLength: 200_000,
      textTruncated: true,
      chainHash: "chain-42",
      removed: false,
      locator: {
        source: "episode:42",
        byteRange: [0, 11],
        contentHash: "content-42",
        revision: "chain-42",
        authority: "user",
      },
    });
    const view = formatEvidenceResource(resource);
    expect(view.rows.find((row) => row.label === "source locator")?.value).toContain("episode:42");
    expect(view.note).toContain("200,000");
  });

  test("renders a truncated stored source as bounded head and tail windows", () => {
    const resource = normalizeEvidenceResource("/api/threads/thread-proof/demo/evidence", {
      kind: "episode",
      threadId: "thread-proof",
      seq: 42,
      role: "user",
      text: `${"a".repeat(4_000)}TAIL_MARKER`,
      textBytes: 4_011,
      byteLength: 200_000,
      textTruncated: true,
      chainHash: "chain-42",
      removed: false,
      locator: {
        source: "episode:42",
        byteRange: [0, 4_011],
        contentHash: "content-42",
        revision: "chain-42",
        authority: "user",
      },
    });
    const view = formatEvidenceResource(resource);
    expect(view.body?.label).toBe("bounded source head / tail");
    expect(view.body?.text).toContain("omitted bounded-prefix bytes");
    expect(view.body?.text).toContain("TAIL_MARKER");
    expect(view.note).toContain("head bytes 0–384");
    expect(view.body?.text.length).toBeLessThan(1_000);
  });

  test("renders a removed episode as a tombstone receipt, never a missing-evidence error", () => {
    const resource = normalizeEvidenceResource("/api/threads/thread-proof/episodes/42", {
      kind: "episode",
      threadId: "thread-proof",
      seq: 42,
      role: "user",
      text: "⟦removed by user · tb_demo42⟧",
      textBytes: 34,
      byteLength: 21,
      textTruncated: false,
      chainHash: "chain-42",
      removed: true,
      removalReceipt: {
        status: "tombstoned",
        contentAvailable: false,
        tombstoneId: "tb_demo42",
        originalContentHash: "a".repeat(64),
        locatorOmittedReason: "removed",
      },
    });
    expect(resource.kind).toBe("episode");
    if (resource.kind !== "episode") throw new Error("expected tombstone resource");
    expect(resource.locator).toBeUndefined();
    const view = formatEvidenceResource(resource);
    expect(view.eyebrow).toBe("bounded removal receipt");
    expect(view.title).toContain("tombstone");
    expect(view.summary).toContain("source bytes unavailable");
    expect(view.rows.find((row) => row.label === "removal status")?.value).toContain("tombstoned");
    expect(view.rows.find((row) => row.label === "tombstone")?.value).toBe("tb_demo42");
    expect(view.body?.text).toContain("No source bytes remain");
    expect(view.note).toContain("not a broken evidence link");
  });

  test("formats route status, stored lineage, and witness authority", () => {
    const resource = normalizeEvidenceResource("/api/route/closed", {
      id: "route-1",
      threadId: "thread-proof",
      queryDigest: "query-digest",
      normalizedQuery: "where is the launch?",
      routerVersion: "address-v1",
      questionSeq: 42,
      answerSeq: 43,
      sourceSeqs: [7],
      witnesses: [
        {
          seq: 7,
          source: "episode:7",
          byteRange: [0, 32],
          contentHash: "content-hash",
          authority: "user",
        },
      ],
      routeDigest: "route-digest",
      status: "invalidated",
      storedStatus: "active",
      effectiveStatus: "invalidated",
      asOfSeq: 49,
      closedByRouteId: "route-close-1",
      createdAt: 1,
    });
    expect(resource.kind).toBe("route");
    if (resource.kind !== "route") throw new Error("expected route");
    const view = formatEvidenceResource(resource);
    expect(view.summary).toContain("invalidated");
    expect(view.rows.find((row) => row.label === "stored status")?.value).toBe("active");
    expect(view.body?.text).toContain("user");
    expect(view.body?.text).toContain("episode:7");
    expect(view.rows.find((row) => row.label === "lineage")?.value).toBe("closed by event route-close-1");
    expect(view.note).toContain("no longer effective");
  });

  test("redacts attachment payloads and caps unknown JSON previews", () => {
    const huge = "z".repeat(MAX_EVIDENCE_JSON_CHARS * 3);
    const encoded = "base64-secret".repeat(400);
    const resource = normalizeEvidenceResource("/api/unknown", {
      bytesBase64: encoded,
      huge,
      other: "kept only in a bounded preview",
    });
    expect(resource.kind).toBe("json");
    if (resource.kind !== "json") throw new Error("expected generic JSON resource");
    expect(resource.preview).not.toContain(encoded);
    expect(resource.preview).toContain("redacted");
    expect(resource.preview.length).toBeLessThanOrEqual(MAX_EVIDENCE_JSON_CHARS + 90);
  });
});
