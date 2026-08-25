import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  Atom,
  DemoAttachmentSpanResource,
  DemoPacketReceipt,
  DemoRouteResource,
  DemoSummary,
  Episode,
  Packet,
  ThreadStats,
} from "@pylos/protocol";
import {
  type Harness,
  type HostedHarness,
  harness,
  hostedHarness,
  jsonPost,
  withSession,
} from "./harness.ts";

let local: Harness;
let hosted: HostedHarness;

beforeAll(async () => {
  local = await harness();
  hosted = await hostedHarness();
});

afterAll(async () => {
  await local.dispose();
  await hosted.dispose();
});

test("the local demo route returns the real proof summary and is idempotent", async () => {
  const thread = await local.json<ThreadStats>("/api/threads", jsonPost({ title: "Empty proof" }));
  const firstResponse = await local.fetch(`/api/threads/${thread.threadId}/demo`, jsonPost({}));
  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as DemoSummary;
  expect(first.seeded).toBe(true);
  expect(first.proof.collection.coverage?.required).toBe(11);
  expect(first.proof.collection.coverage?.located).toBe(10);
  expect(first.proof.collection.coverage?.supported).toBe(10);
  expect(first.proof.collection.coverage?.unresolved).toBe(1);
  expect(first.proof.collection.coverage?.completeness).toBe("incomplete");
  expect(first.proof.collection.sources).toHaveLength(10);
  expect(first.proof.collection.sources.every((source) => source.text.startsWith("Launch note:"))).toBe(true);
  expect(first.proof.collection.sources.some((source) => source.text.startsWith("Archive filler"))).toBe(
    false,
  );
  expect(first.proof.correctedFact.grounded.answerReceipt?.status).toBe("released");
  expect(first.proof.invalidation.page.resolved).toBe(false);

  const removedEvidenceResponse = await local.fetch(
    `/api/threads/${thread.threadId}/demo/evidence?href=${encodeURIComponent(first.proof.invalidation.sourceHref)}`,
  );
  expect(removedEvidenceResponse.status).toBe(200);
  const removedEvidence = (await removedEvidenceResponse.json()) as {
    kind?: string;
    removed?: boolean;
    text?: string;
    locator?: unknown;
    removalReceipt?: {
      status?: string;
      contentAvailable?: boolean;
      tombstoneId?: string;
      originalContentHash?: string;
    };
  };
  expect(removedEvidence.kind).toBe("episode");
  expect(removedEvidence.removed).toBe(true);
  expect(removedEvidence.text).toMatch(/removed by user/u);
  expect(removedEvidence.locator).toBeUndefined();
  expect(removedEvidence.removalReceipt?.status).toBe("tombstoned");
  expect(removedEvidence.removalReceipt?.contentAvailable).toBe(false);
  expect(removedEvidence.removalReceipt?.tombstoneId).toMatch(/^tb_/u);
  expect(removedEvidence.removalReceipt?.originalContentHash).toMatch(/^[0-9a-f]{64}$/u);

  expect(first.proof.attachment.page.byteRange).toEqual([
    first.proof.attachment.tail.from,
    first.proof.attachment.tail.to,
  ]);

  const persistedResponse = await local.fetch(`/api/threads/${thread.threadId}/demo`);
  expect(persistedResponse.status).toBe(200);
  const persisted = (await persistedResponse.json()) as DemoSummary;
  expect(persisted.seeded).toBe(false);
  expect(persisted.final.packetId).toBe(first.final.packetId);
  expect(persisted.proof.invalidation.routeId).toBe(first.proof.invalidation.routeId);
  expect(persisted.thread).toEqual(first.thread);

  const packetResponse = await local.fetch(`/api/threads/${thread.threadId}/packets/${first.final.packetId}`);
  expect(packetResponse.status).toBe(200);
  const packet = (await packetResponse.json()) as Packet;
  expect(packet.id).toBe(first.final.packetId);
  expect(packet.coverage).toEqual(first.final.coverage);
  expect(packet.answerReceipt?.digest).toBe(first.final.answerReceipt?.digest);

  const receiptResponse = await local.fetch(first.final.links.packetReceipt ?? "");
  expect(receiptResponse.status).toBe(200);
  const receipt = (await receiptResponse.json()) as DemoPacketReceipt;
  expect(receipt.id).toBe(first.final.packetId);
  expect(receipt.threadId).toBe(thread.threadId);
  expect(receipt.turnSeq).toBe(first.final.questionSeq);
  expect(receipt.digest).toBe(packet.digest);
  expect(receipt.question).toEqual({
    seq: first.final.questionSeq,
    text: first.final.query,
    href: `/api/threads/${thread.threadId}/episodes/${first.final.questionSeq}`,
  });
  expect(receipt.answer.text).toBe(first.final.answer);
  expect(receipt.answer.href).toContain(`/api/threads/${thread.threadId}/episodes/`);
  expect(receipt.coverage?.required).toBe(first.final.coverage?.required);
  expect(receipt.coverage?.located).toBe(first.final.coverage?.located);
  expect(receipt.coverage?.supported).toBe(first.final.coverage?.supported);
  expect(receipt.coverage?.digest).toBe(first.final.coverage?.digest);
  expect(receipt.coverage?.routeCount).toBe(first.final.coverage?.routes.length);
  expect(receipt.coverage?.routes.every((route) => route.href?.includes("/episodes/") === true)).toBe(true);
  expect(receipt.answerReceipt?.digest).toBe(first.final.answerReceipt?.digest);
  expect(receipt.answerReceipt?.status).toBe("released");
  expect(
    receipt.answerReceipt?.classifications.some(
      (entry) =>
        entry.classification === "SUPPORTED" &&
        entry.kind === "collection" &&
        entry.basis?.kind === "coverage" &&
        entry.basis.metric === "located" &&
        entry.basis.value === 10 &&
        entry.basis.digest === receipt.coverage?.digest,
    ),
  ).toBe(true);
  expect(receipt.answerReceipt?.classifications.some((entry) => entry.basis?.kind === "coverage")).toBe(true);
  expect("capabilityDigests" in (receipt.answerReceipt?.classifications[0] ?? {})).toBe(false);
  expect(receipt.answerReceipt?.classifications[0]?.capabilityDigestCount).toBeDefined();
  expect(receipt.rawPacket).toBe(`/api/threads/${thread.threadId}/packets/${first.final.packetId}`);
  expect("messages" in receipt).toBe(false);
  expect("resident" in receipt).toBe(false);
  expect("evidence" in receipt).toBe(false);
  expect("rounds" in receipt).toBe(false);
  const receiptBytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
  expect(receiptBytes).toBeLessThan(20_000);

  const boundedPacketResponse = await local.fetch(
    `/api/threads/${thread.threadId}/demo/evidence?href=${encodeURIComponent(receipt.rawPacket)}`,
  );
  expect(boundedPacketResponse.status).toBe(200);
  expect(((await boundedPacketResponse.json()) as DemoPacketReceipt).id).toBe(receipt.id);

  const receiptBySeq = await local.json<DemoPacketReceipt>(
    `/api/threads/${thread.threadId}/demo/packets/${first.final.questionSeq}`,
  );
  expect(receiptBySeq.id).toBe(receipt.id);
  const rawFromReceipt = await local.fetch(receipt.rawPacket);
  expect(rawFromReceipt.status).toBe(200);
  expect(((await rawFromReceipt.json()) as Packet).id).toBe(receipt.id);

  local.provider.reply("oversized-proof-answer ".repeat(1_000));
  const oversizedEvents = await local.sse(`/api/threads/${thread.threadId}/turn`, {
    text: "What should remain bounded?",
    model: "grok-4.6",
  });
  const oversizedPacketEvent = oversizedEvents.find((event) => event.type === "packet");
  expect(oversizedPacketEvent?.type).toBe("packet");
  if (oversizedPacketEvent?.type !== "packet") throw new Error("oversized turn did not emit a packet");
  const oversizedReceipt = await local.fetch(
    `/api/threads/${thread.threadId}/demo/packets/${oversizedPacketEvent.packetId}`,
  );
  expect(oversizedReceipt.status).toBe(404);
  const oversizedRaw = await local.fetch(
    `/api/threads/${thread.threadId}/packets/${oversizedPacketEvent.packetId}`,
  );
  expect(oversizedRaw.status).toBe(200);

  const routeResponse = await local.fetch(
    `/api/threads/${thread.threadId}/demo/routes/${first.proof.invalidation.routeId}`,
  );
  expect(routeResponse.status).toBe(200);
  const route = (await routeResponse.json()) as DemoRouteResource;
  expect(route.id).toBe(first.proof.invalidation.routeId);
  expect(route.threadId).toBe(thread.threadId);
  expect(route.status).toBe("invalidated");
  expect(route.witnesses.length).toBeGreaterThan(0);
  // Public bounded JSON names the event's target explicitly.  The kernel's
  // historical `invalidated_by` column is an implementation detail and must
  // not make an event look like it was caused by its parent route.
  expect(route.closesRouteId).toBeString();
  expect((route as unknown as Record<string, unknown>).invalidatedBy).toBeUndefined();
  if (route.closesRouteId === undefined) throw new Error("route closure target is missing");
  const parentRouteResponse = await local.fetch(
    `/api/threads/${thread.threadId}/demo/routes/${route.closesRouteId}`,
  );
  expect(parentRouteResponse.status).toBe(200);
  const parentRoute = (await parentRouteResponse.json()) as DemoRouteResource;
  expect(parentRoute.id).toBe(route.closesRouteId);
  expect(parentRoute.closedByRouteId).toBe(route.id);
  expect((parentRoute as unknown as Record<string, unknown>).closedBy).toBeUndefined();

  const spanResponse = await local.fetch(
    `/api/threads/${thread.threadId}/demo/attachments/${first.proof.attachment.seq}/spans/${first.proof.attachment.spans - 1}`,
  );
  expect(spanResponse.status).toBe(200);
  const span = (await spanResponse.json()) as DemoAttachmentSpanResource;
  expect(span.threadId).toBe(thread.threadId);
  expect(span.manifestId).toBe(first.proof.attachment.manifestId);
  expect(span.span.hash).toBe(span.digest);
  expect(span.byteLength).toBe(span.span.to - span.span.from);
  const boundedSpanResponse = await local.fetch(
    `/api/threads/${thread.threadId}/demo/evidence?href=${encodeURIComponent(
      `/api/threads/${thread.threadId}/demo/attachments/${first.proof.attachment.seq}/spans/${first.proof.attachment.spans - 1}`,
    )}`,
  );
  expect(boundedSpanResponse.status).toBe(200);
  expect(Buffer.from(span.bytesBase64, "base64").toString("utf8")).toContain(
    first.proof.attachment.tail.marker,
  );

  expect(
    (await local.fetch(`/api/threads/${thread.threadId}/packets/${first.final.packetId}-missing`)).status,
  ).toBe(404);
  expect(
    (
      await local.fetch(
        `/api/threads/${thread.threadId}/demo/attachments/${first.proof.attachment.seq}/spans/${first.proof.attachment.spans}`,
      )
    ).status,
  ).toBe(404);

  const second = await local.json<DemoSummary>(`/api/threads/${thread.threadId}/demo`, jsonPost({}));
  expect(second.seeded).toBe(false);
  expect(second.final.packetId).toBe(first.final.packetId);
  expect(second.proof.invalidation.routeId).toBe(first.proof.invalidation.routeId);
});

test("bounded demo evidence never returns an oversized episode body", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>("/api/threads", jsonPost({ title: "Bounded evidence" }));
    await isolated.json<DemoSummary>(`/api/threads/${thread.threadId}/demo`, jsonPost({}));
    const kernel = isolated.context.kernel as unknown as {
      vault: { episodes: { append: (id: string, input: Record<string, unknown>) => Episode } };
    };
    const episode = kernel.vault.episodes.append(thread.threadId, {
      role: "user",
      // Keep the fixture below capsule-source admission while well above the
      // bounded evidence projection cap.
      content: "large imported source ".repeat(40_000),
    });
    const sourceHref = `/api/threads/${thread.threadId}/episodes/${episode.seq}`;
    const response = await isolated.fetch(
      `/api/threads/${thread.threadId}/demo/evidence?href=${encodeURIComponent(sourceHref)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kind?: string;
      text?: string;
      textBytes?: number;
      byteLength?: number;
      textTruncated?: boolean;
      locator?: { source?: string; byteRange?: [number, number] };
    };
    expect(body.kind).toBe("episode");
    expect(body.textTruncated).toBe(true);
    expect(body.textBytes).toBeLessThanOrEqual(8_192);
    expect(body.text?.length ?? 0).toBeLessThan(10_000);
    expect(body.byteLength).toBeGreaterThan(body.textBytes ?? 0);
    expect(body.locator?.source).toBe(`episode:${episode.seq}`);
    expect(body.locator?.byteRange?.[0]).toBe(0);
    expect(body.locator?.byteRange?.[1]).toBe(body.textBytes);
    expect((await response.clone().arrayBuffer()).byteLength).toBeLessThan(20_000);
  } finally {
    await isolated.dispose();
  }
});

test("bounded demo packet receipt never selects raw provider messages", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>("/api/threads", jsonPost({ title: "Bounded packet" }));
    const summary = await isolated.json<DemoSummary>(`/api/threads/${thread.threadId}/demo`, jsonPost({}));
    const packetId = summary.final.packetId;
    const db = (isolated.context.kernel as unknown as { vault: { db: Database } }).vault.db;
    db.query("UPDATE packet SET messages = ? WHERE id = ?").run(
      JSON.stringify(Array.from({ length: 50_000 }, () => ({ role: "user", content: "provider output" }))),
      packetId,
    );
    const instrumented = db as unknown as { prepare: (sql: string) => unknown };
    const originalPrepare = instrumented.prepare;
    let selectedRawPacket = false;
    instrumented.prepare = ((sql: string) => {
      if (/SELECT \* FROM packet/u.test(sql)) selectedRawPacket = true;
      return originalPrepare.call(db, sql);
    }) as typeof instrumented.prepare;
    try {
      const response = await isolated.fetch(`/api/threads/${thread.threadId}/demo/packets/${packetId}`);
      expect(response.status).toBe(200);
      expect((await response.clone().arrayBuffer()).byteLength).toBeLessThan(20_000);
      expect("messages" in ((await response.json()) as Record<string, unknown>)).toBe(false);
    } finally {
      instrumented.prepare = originalPrepare;
    }
    expect(selectedRawPacket).toBe(false);
  } finally {
    await isolated.dispose();
  }
});

test("ordinary transcript and search return bounded episode pages with exact UTF-8 locators", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>(
      "/api/threads",
      jsonPost({ title: "Bounded transcript" }),
    );
    const kernel = isolated.context.kernel as unknown as {
      vault: { episodes: { append: (id: string, input: Record<string, unknown>) => Episode } };
    };
    const source = `${"launch note ".repeat(700)}\nmarker-utf8-😀\n${"tail ".repeat(300)}`;
    const expected = Buffer.from(source, "utf8");
    for (let index = 0; index < 80; index += 1) {
      kernel.vault.episodes.append(thread.threadId, {
        role: "user",
        content: `${source}\nsearch-bound-${index}`,
      });
    }

    const db = (isolated.context.kernel as unknown as { vault: { db: Database } }).vault.db;
    const observed = { calls: 0, rows: 0, maxRows: 0 };
    const instrumented = db as unknown as { prepare: (sql: string) => unknown };
    const originalPrepare = instrumented.prepare;
    instrumented.prepare = ((sql: string) => {
      const statement = originalPrepare.call(db, sql) as Record<string, unknown>;
      if (!/content_prefix|episode_fts/u.test(sql)) return statement;
      observed.calls += 1;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") {
            return (...parameters: unknown[]) => {
              const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
              const value = method.apply(target, parameters);
              const rows = Array.isArray(value) ? value.length : 0;
              observed.rows += rows;
              observed.maxRows = Math.max(observed.maxRows, rows);
              return value;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof instrumented.prepare;

    try {
      const transcript = await isolated.fetch(`/api/threads/${thread.threadId}/episodes?limit=5000`);
      expect(transcript.status).toBe(200);
      const page = (await transcript.json()) as {
        episodes?: Array<
          Episode & {
            contentBytes: number;
            contentTruncated: boolean;
            locator: { source: string; byteRange: [number, number]; contentHash: string; revision: string };
            continuation?: { from: number; to: number; fullBytes: number; source: string };
          }
        >;
        truncated?: boolean;
        byteLength?: number;
      };
      expect(page.truncated).toBe(true);
      expect(page.episodes?.length ?? 0).toBeGreaterThan(0);
      expect(page.byteLength).toBeLessThanOrEqual(256 * 1024);
      expect((await transcript.clone().arrayBuffer()).byteLength).toBeLessThanOrEqual(256 * 1024);
      const first = page.episodes?.[0];
      expect(first?.contentTruncated).toBe(true);
      expect(first?.contentBytes).toBeGreaterThan(Buffer.byteLength(first?.content ?? "", "utf8"));
      expect(first?.locator.source).toBe(`episode:${first?.seq}`);
      expect(first?.locator.byteRange[0]).toBe(0);
      expect(first?.locator.byteRange[1]).toBe(Buffer.byteLength(first?.content ?? "", "utf8"));
      expect(first?.continuation?.source).toBe(first?.locator.source);
      expect(first?.continuation?.fullBytes).toBe(first?.contentBytes);
      const prefixBytes = Buffer.from(first?.content ?? "", "utf8");
      expect(prefixBytes.byteLength).toBeLessThanOrEqual(8 * 1024);
      expect(prefixBytes.equals(expected.subarray(0, prefixBytes.byteLength))).toBe(true);

      const older = await isolated.fetch(
        `/api/threads/${thread.threadId}/episodes?before=${first?.seq ?? 1}&limit=60`,
      );
      expect(older.status).toBe(200);
      const olderPage = (await older.json()) as { episodes?: Array<Episode & { seq: number }> };
      expect(olderPage.episodes?.at(-1)?.seq ?? Number.MAX_SAFE_INTEGER).toBeLessThan(first?.seq ?? 1);

      const search = await isolated.fetch(
        `/api/threads/${thread.threadId}/search?q=${encodeURIComponent("search-bound")}`,
      );
      expect(search.status).toBe(200);
      const searchPage = (await search.json()) as {
        episodes?: Array<Episode & { contentTruncated: boolean; locator: { byteRange: [number, number] } }>;
        truncated?: boolean;
        byteLength?: number;
      };
      expect(searchPage.truncated).toBe(true);
      expect(searchPage.episodes?.length ?? 0).toBeGreaterThan(0);
      expect(searchPage.byteLength).toBeLessThanOrEqual(256 * 1024);
      expect((await search.clone().arrayBuffer()).byteLength).toBeLessThanOrEqual(256 * 1024);
      expect(searchPage.episodes?.every((episode) => episode.contentTruncated)).toBe(true);
      // Equal BM25 scores are newest-first; the best-ranked prefix survives
      // aggregate truncation rather than a suffix of lower-ranked hits.
      expect(searchPage.episodes?.[0]?.seq).toBe(80);
    } finally {
      instrumented.prepare = originalPrepare;
    }
    expect(observed.calls).toBeLessThanOrEqual(3);
    expect(observed.rows).toBeLessThanOrEqual(192);
    expect(observed.maxRows).toBeLessThanOrEqual(64);
  } finally {
    await isolated.dispose();
  }
});

test("ordinary search projects oversized atoms in SQL before they reach the JS heap", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>(
      "/api/threads",
      jsonPost({ title: "Bounded atom search" }),
    );
    const kernel = isolated.context.kernel as unknown as {
      vault: {
        episodes: { append: (id: string, input: Record<string, unknown>) => Episode };
        atoms: { insert: (atom: Atom) => void };
        db: Database;
      };
    };
    const source = kernel.vault.episodes.append(thread.threadId, {
      role: "user",
      content: "The oversized atom source is retained in the archive.",
    });
    const giantText = `atom-prefix-${"x".repeat(256 * 1024)}-needle-at-tail`;
    const giantValue = `value-prefix-${"v".repeat(256 * 1024)}-value-tail`;
    kernel.vault.atoms.insert({
      id: `bounded-atom-${source.seq}`,
      threadId: thread.threadId,
      kind: "fact",
      key: "oversized.atom",
      value: giantValue,
      text: giantText,
      sourceSeq: source.seq,
      sourceSpan: [0, source.content.length],
      validFromSeq: source.seq,
      phase: "SUPPORTED",
      authority: "user",
      scope: "global",
      pinned: false,
      confidence: 1,
      createdBy: "user",
      createdAt: Date.now(),
    });

    const observed = { rawSelect: false, rows: 0, maxRows: 0 };
    const instrumented = kernel.vault.db as unknown as { prepare: (sql: string) => unknown };
    const originalPrepare = instrumented.prepare;
    instrumented.prepare = ((sql: string) => {
      const statement = originalPrepare.call(kernel.vault.db, sql) as Record<string, unknown>;
      if (!/\bFROM\s+atom\b/u.test(sql) || !/^\s*SELECT\b/u.test(sql)) return statement;
      if (/SELECT\s+\*\s+FROM\s+atom/u.test(sql)) observed.rawSelect = true;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") {
            return (...parameters: unknown[]) => {
              const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
              const value = method.apply(target, parameters);
              const rows = Array.isArray(value) ? value.length : 0;
              observed.rows += rows;
              observed.maxRows = Math.max(observed.maxRows, rows);
              return value;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof instrumented.prepare;
    try {
      const response = await isolated.fetch(
        `/api/threads/${thread.threadId}/search?q=${encodeURIComponent("needle-at-tail")}`,
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        atoms?: Array<
          Atom & {
            textBytes?: number;
            textTruncated?: boolean;
            valueBytes?: number;
            valueTruncated?: boolean;
          }
        >;
        byteLength?: number;
      };
      const atom = page.atoms?.[0];
      expect(atom?.id).toBe(`bounded-atom-${source.seq}`);
      expect(atom?.textTruncated).toBe(true);
      expect(atom?.valueTruncated).toBe(true);
      expect(atom?.textBytes).toBe(Buffer.byteLength(giantText, "utf8"));
      expect(atom?.valueBytes).toBe(Buffer.byteLength(giantValue, "utf8"));
      expect(Buffer.byteLength(atom?.text ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024);
      expect(Buffer.byteLength(atom?.value ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024);
      expect(page.byteLength).toBeLessThanOrEqual(256 * 1024);
      expect((await response.clone().arrayBuffer()).byteLength).toBeLessThanOrEqual(256 * 1024);
    } finally {
      instrumented.prepare = originalPrepare;
    }
    expect(observed.rawSelect).toBe(false);
    expect(observed.rows).toBeLessThanOrEqual(40);
    expect(observed.maxRows).toBeLessThanOrEqual(40);
  } finally {
    await isolated.dispose();
  }
});

test("search reports an unknown continuation at its bounded best-first window", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>(
      "/api/threads",
      jsonPost({ title: "Search continuation" }),
    );
    const kernel = isolated.context.kernel as unknown as {
      vault: { episodes: { append: (id: string, input: Record<string, unknown>) => Episode } };
    };
    for (let index = 0; index < 40; index += 1) {
      kernel.vault.episodes.append(thread.threadId, {
        role: "user",
        content: `bounded search window ${index}`,
      });
    }
    const response = await isolated.fetch(
      `/api/threads/${thread.threadId}/search?q=${encodeURIComponent("bounded search window")}`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      episodes?: Episode[];
      truncated?: boolean;
      byteLength?: number;
      continuation?: { omittedLowerBound?: number; omittedUnknown?: boolean };
    };
    expect(page.episodes).toHaveLength(40);
    expect(page.truncated).toBe(true);
    expect(page.continuation?.omittedUnknown).toBe(true);
    expect(page.continuation?.omittedLowerBound).toBeGreaterThanOrEqual(1);
    expect(page.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect((await response.clone().arrayBuffer()).byteLength).toBeLessThanOrEqual(256 * 1024);
  } finally {
    await isolated.dispose();
  }
});

test("ordinary atom, capsule, ledger, and raw packet readers fail closed before full hydration", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>(
      "/api/threads",
      jsonPost({ title: "Bounded derived state" }),
    );
    isolated.provider.reply("packet fixture");
    const packetEvents = await isolated.sse(`/api/threads/${thread.threadId}/turn`, {
      text: "create packet fixture",
      model: "grok-4.6",
    });
    expect(packetEvents.some((event) => event.type === "packet")).toBe(true);
    const kernel = isolated.context.kernel as unknown as {
      vault: { db: Database };
    };
    const db = kernel.vault.db;
    const source = db
      .query("SELECT seq FROM episode WHERE thread_id = ? ORDER BY seq DESC LIMIT 1")
      .get(thread.threadId) as { seq?: number } | null;
    const sourceSeq = source?.seq ?? 0;
    const giant = "x".repeat(512 * 1024);
    db.query(
      "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
        "VALUES (?, ?, 'fact', ?, ?, ?, ?, NULL, ?, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'user', ?)",
    ).run("bounded-derived-atom", thread.threadId, giant, giant, giant, sourceSeq, sourceSeq, Date.now());
    db.query(
      "INSERT INTO capsule (id, thread_id, level, from_seq, to_seq, text, tokens, dropped, carried_count, kept, hash, created_by, created_at) " +
        "VALUES (?, ?, 0, 1, 1, ?, 1, ?, 3, ?, ?, 'test', ?)",
    ).run(
      "bounded-derived-capsule",
      thread.threadId,
      giant,
      JSON.stringify([{ name: giant, kind: "fact", seq: 1 }]),
      JSON.stringify([{ name: "kept", kind: "fact", seq: 1 }]),
      "a".repeat(64),
      Date.now(),
    );
    db.query(
      "INSERT INTO loss (thread_id, capsule_id, name, kind, level, seq, span) VALUES (?, ?, ?, 'fact', 0, 1, ?)",
    ).run(thread.threadId, "bounded-derived-capsule", giant, JSON.stringify([0, 1]));

    const atomResponse = await isolated.fetch(`/api/threads/${thread.threadId}/atoms?limit=1`);
    expect(atomResponse.status).toBe(200);
    const atomBody = (await atomResponse.json()) as
      | Array<{ key: string; value: string; text: string; keyBytes: number; textTruncated?: boolean }>
      | {
          atoms?: Array<{
            key: string;
            value: string;
            text: string;
            keyBytes: number;
            textTruncated?: boolean;
          }>;
          byteLength?: number;
        };
    const atomRows = Array.isArray(atomBody) ? atomBody : (atomBody.atoms ?? []);
    const atom = atomRows.find((row) => row.keyBytes === giant.length);
    expect(atom).toBeDefined();
    expect(atom?.textTruncated).toBe(true);
    expect(new TextEncoder().encode(atom?.key ?? "").byteLength).toBeLessThanOrEqual(512);
    expect(new TextEncoder().encode(atom?.value ?? "").byteLength).toBeLessThanOrEqual(2 * 1024);
    expect(new TextEncoder().encode(atom?.text ?? "").byteLength).toBeLessThanOrEqual(2 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(atomBody)).byteLength).toBeLessThanOrEqual(256 * 1024);

    const capsuleResponse = await isolated.fetch(`/api/threads/${thread.threadId}/capsules?limit=1`);
    expect(capsuleResponse.status).toBe(200);
    const capsuleBody = (await capsuleResponse.json()) as
      | Array<{ id: string; text?: string; dropped?: unknown[]; droppedBytes: number }>
      | {
          capsules?: Array<{ id: string; text?: string; dropped?: unknown[]; droppedBytes: number }>;
          byteLength?: number;
        };
    const capsuleRows = Array.isArray(capsuleBody) ? capsuleBody : (capsuleBody.capsules ?? []);
    const capsule = capsuleRows.find((row) => row.id === "bounded-derived-capsule");
    expect(capsule?.text).toBeUndefined();
    expect(capsule?.dropped).toBeUndefined();
    expect(capsule?.droppedBytes).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(capsuleBody)).byteLength).toBeLessThanOrEqual(256 * 1024);

    const ledgerResponse = await isolated.fetch(`/api/threads/${thread.threadId}/ledger?limit=1`);
    expect(ledgerResponse.status).toBe(200);
    const ledgerBody = (await ledgerResponse.json()) as
      | Array<{ name: string; nameBytes: number; nameTruncated?: boolean }>
      | {
          entries?: Array<{ name: string; nameBytes: number; nameTruncated?: boolean }>;
          byteLength?: number;
        };
    const ledgerRows = Array.isArray(ledgerBody) ? ledgerBody : (ledgerBody.entries ?? []);
    expect(ledgerRows[0]?.nameBytes).toBe(giant.length);
    expect(ledgerRows[0]?.nameTruncated).toBe(true);
    expect(new TextEncoder().encode(ledgerRows[0]?.name ?? "").byteLength).toBeLessThanOrEqual(512);
    expect(new TextEncoder().encode(JSON.stringify(ledgerBody)).byteLength).toBeLessThanOrEqual(256 * 1024);

    const packet = db
      .query("SELECT id FROM packet WHERE thread_id = ? ORDER BY turn_seq DESC LIMIT 1")
      .get(thread.threadId) as { id?: string } | null;
    if (packet?.id === undefined) throw new Error("packet fixture missing");
    const database = db as unknown as { prepare: (sql: string) => unknown };
    const originalPrepare = database.prepare;
    const packetStatements: string[] = [];
    database.prepare = ((sql: string) => {
      if (/\bFROM\s+packet\b/iu.test(sql)) packetStatements.push(sql);
      return originalPrepare.call(db, sql);
    }) as typeof database.prepare;
    try {
      db.query("UPDATE packet SET messages = ? WHERE id = ?").run(
        JSON.stringify([{ role: "user", content: "x".repeat(256 * 1024 + 1) }]),
        packet.id,
      );
      const nearCap = await isolated.fetch(`/api/threads/${thread.threadId}/packets/${packet.id}`);
      expect(nearCap.status).toBe(200);

      // Deliberately malformed and over the cap: the scalar preflight must
      // reject it as oversized without asking SQLite's JSON parser to inspect
      // the giant value.
      const oversizedMessages = `{"x":"${"x".repeat(1_572_864 + 1)}`;
      db.query("UPDATE packet SET messages = ? WHERE id = ?").run(oversizedMessages, packet.id);
      const oversized = await isolated.fetch(`/api/threads/${thread.threadId}/packets/${packet.id}`);
      expect(oversized.status).toBe(413);
      expect(((await oversized.json()) as { code?: string }).code).toBe("packet_too_large");

      const otherThread = await isolated.json<ThreadStats>(
        "/api/threads",
        jsonPost({ title: "Foreign packet" }),
      );
      isolated.provider.reply("foreign packet fixture");
      await isolated.sse(`/api/threads/${otherThread.threadId}/turn`, {
        text: "foreign packet",
        model: "grok-4.6",
      });
      const foreignPacket = db
        .query("SELECT id FROM packet WHERE thread_id = ? ORDER BY turn_seq DESC LIMIT 1")
        .get(otherThread.threadId) as { id?: string } | null;
      if (foreignPacket?.id === undefined) throw new Error("foreign packet fixture missing");
      db.query("UPDATE packet SET messages = ? WHERE id = ?").run(
        `{"x":"${"x".repeat(1_572_864 + 1)}`,
        foreignPacket.id,
      );
      const crossThread = await isolated.fetch(`/api/threads/${thread.threadId}/packets/${foreignPacket.id}`);
      expect(crossThread.status).toBe(404);
    } finally {
      database.prepare = originalPrepare;
    }
    const preflightIndex = packetStatements.findIndex((sql) => /length\(CAST\(model/iu.test(sql));
    const rawIndex = packetStatements.findIndex((sql) => /SELECT\s+\*/iu.test(sql));
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(rawIndex).toBeGreaterThan(preflightIndex);
  } finally {
    await isolated.dispose();
  }
});

test("atom pin is thread-scoped and returns only the bounded projection", async () => {
  const isolated = await harness();
  try {
    const owner = await isolated.json<ThreadStats>("/api/threads", jsonPost({ title: "Pin owner" }));
    const foreign = await isolated.json<ThreadStats>("/api/threads", jsonPost({ title: "Pin foreign" }));
    const db = (isolated.context.kernel as unknown as { vault: { db: Database } }).vault.db;
    const giant = "x".repeat(512 * 1024);
    db.query(
      "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
        "VALUES (?, ?, 'fact', ?, ?, ?, 1, NULL, 1, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'user', ?)",
    ).run("pin-foreign-giant", foreign.threadId, giant, giant, giant, Date.now());
    db.query(
      "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
        "VALUES (?, ?, 'fact', ?, ?, ?, 1, NULL, 1, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'user', ?)",
    ).run("pin-owner-giant", owner.threadId, giant, giant, giant, Date.now());

    const database = db as unknown as { prepare: (sql: string) => unknown };
    const originalPrepare = database.prepare;
    let rawAtomSelect = false;
    database.prepare = ((sql: string) => {
      if (/\bFROM\s+atom\b/iu.test(sql) && /SELECT\s+\*/iu.test(sql)) rawAtomSelect = true;
      return originalPrepare.call(db, sql);
    }) as typeof database.prepare;
    try {
      const own = await isolated.fetch(`/api/threads/${owner.threadId}/atoms/pin-owner-giant/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      expect(own.status).toBe(200);
      const ownBody = (await own.json()) as { text: string; textBytes: number; textTruncated?: boolean };
      expect(ownBody.textTruncated).toBe(true);
      expect(ownBody.textBytes).toBe(giant.length);
      expect(new TextEncoder().encode(ownBody.text).byteLength).toBeLessThanOrEqual(2 * 1024);

      const cross = await isolated.fetch(`/api/threads/${owner.threadId}/atoms/pin-foreign-giant/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      expect(cross.status).toBe(404);
    } finally {
      database.prepare = originalPrepare;
    }
    expect(rawAtomSelect).toBe(false);
  } finally {
    await isolated.dispose();
  }
});

test("ordinary atom pages use a bounded SQL window and an opaque continuation", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>("/api/threads", jsonPost({ title: "Atom page" }));
    const db = (isolated.context.kernel as unknown as { vault: { db: Database } }).vault.db;
    const insert = db.query(
      "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
        "VALUES (?, ?, 'fact', ?, ?, ?, 1, NULL, 1, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'user', ?)",
    );
    for (let index = 0; index < 40; index += 1) {
      insert.run(
        `page-atom-${index}`,
        thread.threadId,
        `page.key.${index}`,
        `value-${index}`,
        `text-${index}`,
        Date.now(),
      );
    }
    const database = db as unknown as { prepare: (sql: string) => unknown };
    const originalPrepare = database.prepare;
    let sawBoundedProjection = false;
    database.prepare = ((sql: string) => {
      if (/\bFROM\s+atom\b/iu.test(sql)) {
        expect(sql).not.toMatch(/SELECT\s+\*/iu);
        if (/reader_rowid/u.test(sql)) sawBoundedProjection = true;
      }
      return originalPrepare.call(db, sql);
    }) as typeof database.prepare;
    try {
      const firstResponse = await isolated.fetch(`/api/threads/${thread.threadId}/atoms?limit=256`);
      expect(firstResponse.status).toBe(200);
      const first = (await firstResponse.json()) as {
        atoms: Array<{ id: string }>;
        byteLength: number;
        truncated: boolean;
        hasMore: boolean;
        continuation?: { cursor?: string };
      };
      expect(first.atoms).toHaveLength(32);
      expect(first.truncated).toBe(true);
      expect(first.hasMore).toBe(true);
      expect(first.continuation?.cursor).toEqual(expect.any(String));
      expect(first.byteLength).toBe(Buffer.byteLength(JSON.stringify(first), "utf8"));

      const secondResponse = await isolated.fetch(
        `/api/threads/${thread.threadId}/atoms?limit=256&after=${encodeURIComponent(first.continuation?.cursor ?? "")}`,
      );
      expect(secondResponse.status).toBe(200);
      const second = (await secondResponse.json()) as { atoms: Array<{ id: string }>; hasMore: boolean };
      expect(second.atoms).toHaveLength(8);
      expect(second.hasMore).toBe(false);
      expect(second.atoms.map((atom) => atom.id)).not.toEqual(
        expect.arrayContaining(first.atoms.map((atom) => atom.id)),
      );
    } finally {
      database.prepare = originalPrepare;
    }
    expect(sawBoundedProjection).toBe(true);
  } finally {
    await isolated.dispose();
  }
});

test("bounded demo episode locators never split UTF-8", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>("/api/threads", jsonPost({ title: "UTF-8 boundary" }));
    await isolated.json<DemoSummary>(`/api/threads/${thread.threadId}/demo`, jsonPost({}));
    const kernel = isolated.context.kernel as unknown as {
      vault: { episodes: { append: (id: string, input: Record<string, unknown>) => Episode } };
    };
    const content = `${"a".repeat(8_191)}😀tail`;
    const episode = kernel.vault.episodes.append(thread.threadId, { role: "user", content });
    const response = await isolated.fetch(
      `/api/threads/${thread.threadId}/demo/evidence?href=${encodeURIComponent(
        `/api/threads/${thread.threadId}/episodes/${episode.seq}`,
      )}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      text: string;
      textBytes: number;
      locator: { byteRange: [number, number] };
    };
    const sourceBytes = Buffer.from(content, "utf8");
    const retainedBytes = Buffer.from(body.text, "utf8");
    expect(body.textBytes).toBe(retainedBytes.byteLength);
    expect(body.locator.byteRange).toEqual([0, retainedBytes.byteLength]);
    expect(retainedBytes.equals(sourceBytes.subarray(0, retainedBytes.byteLength))).toBe(true);
    expect(retainedBytes.byteLength).toBeLessThanOrEqual(8 * 1024);
  } finally {
    await isolated.dispose();
  }
});

test("bounded projection does not issue a live locator for a redacted episode", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>(
      "/api/threads",
      jsonPost({ title: "Removed projection" }),
    );
    const kernel = isolated.context.kernel as unknown as {
      vault: { episodes: { append: (id: string, input: Record<string, unknown>) => Episode } };
    };
    const episode = kernel.vault.episodes.append(thread.threadId, {
      role: "user",
      content: "private launch note that must not receive a current locator",
    });
    const forgotten = await isolated.fetch(
      `/api/threads/${thread.threadId}/forget`,
      jsonPost({ seqs: [episode.seq], reason: "bounded projection oracle" }),
    );
    expect(forgotten.status).toBe(200);
    const response = await isolated.fetch(`/api/threads/${thread.threadId}/episodes/${episode.seq}`);
    expect(response.status).toBe(200);
    const row = (await response.json()) as Episode & {
      originalContentHash?: string;
      locator?: unknown;
    };
    expect(row.meta.removed).toBe(true);
    expect(row.locator).toBeUndefined();
    expect(row.originalContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(row.content).toContain("removed by user");
  } finally {
    await isolated.dispose();
  }
});

test("bounded projection caps an imported oversized metadata name", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>("/api/threads", jsonPost({ title: "Huge metadata" }));
    const kernel = isolated.context.kernel as unknown as {
      vault: { episodes: { append: (id: string, input: Record<string, unknown>) => Episode } };
    };
    const episode = kernel.vault.episodes.append(thread.threadId, {
      role: "attachment",
      content: "indexed attachment prefix",
      meta: { name: "N".repeat(100_000), size: 100_000 },
    });
    const response = await isolated.fetch(`/api/threads/${thread.threadId}/episodes/${episode.seq}`);
    expect(response.status).toBe(200);
    const row = (await response.json()) as Episode & {
      metaBytes?: number;
      metaTruncated?: boolean;
    };
    expect(row.metaTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(row), "utf8")).toBeLessThan(40_000);
    expect(
      typeof row.meta.name === "string" ? Buffer.byteLength(row.meta.name, "utf8") : 0,
    ).toBeLessThanOrEqual(2_048);
  } finally {
    await isolated.dispose();
  }
});

test("read-only demo GET refuses empty and ordinary threads without changing them", async () => {
  const empty = await local.json<ThreadStats>("/api/threads", jsonPost({ title: "Not a proof" }));
  const emptyBefore = await local.json<ThreadStats>(`/api/threads/${empty.threadId}`);
  const emptyResponse = await local.fetch(`/api/threads/${empty.threadId}/demo`);
  expect(emptyResponse.status).toBe(404);
  expect(await emptyResponse.json()).toEqual({
    code: "demo_not_found",
    error: "No persisted proof demo exists for this thread.",
  });
  expect(await local.json<ThreadStats>(`/api/threads/${empty.threadId}`)).toEqual(emptyBefore);

  const ordinary = await local.json<ThreadStats>("/api/threads", jsonPost({ title: "Ordinary" }));
  local.provider.reply("An ordinary answer.");
  const events = await local.sse(`/api/threads/${ordinary.threadId}/turn`, {
    text: "An ordinary question.",
    model: "grok-4.6",
  });
  expect(events.some((event) => event.type === "done")).toBe(true);
  const ordinaryBefore = await local.json<ThreadStats>(`/api/threads/${ordinary.threadId}`);
  const ordinaryResponse = await local.fetch(`/api/threads/${ordinary.threadId}/demo`);
  expect(ordinaryResponse.status).toBe(404);
  expect(await local.json<ThreadStats>(`/api/threads/${ordinary.threadId}`)).toEqual(ordinaryBefore);

  const proofThread = await local.json<ThreadStats>("/api/threads", jsonPost({ title: "Proof scope" }));
  const proofSummary = await local.json<DemoSummary>(
    `/api/threads/${proofThread.threadId}/demo`,
    jsonPost({}),
  );
  expect(
    (
      await local.fetch(
        `/api/threads/${ordinary.threadId}/demo/routes/${proofSummary.proof.invalidation.routeId}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await local.fetch(
        `/api/threads/${ordinary.threadId}/demo/attachments/${proofSummary.proof.attachment.seq}/spans/0`,
      )
    ).status,
  ).toBe(404);
});

test("proof-v1 route exhibits use bounded exact-id reads over many append-only routes", async () => {
  const isolated = await harness();
  try {
    const thread = await isolated.json<ThreadStats>("/api/threads", jsonPost({ title: "Bounded proof" }));
    const summary = await isolated.json<DemoSummary>(`/api/threads/${thread.threadId}/demo`, jsonPost({}));
    const targetSource = summary.proof.correctedFact.routeId;
    const kernel = isolated.context.kernel as unknown as { vault: { db: Database } };
    const db = kernel.vault.db;
    const churn = 2_048;
    for (let index = 0; index < churn; index += 1) {
      db.query(
        "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
          "SELECT ?, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest || ?, 'active', NULL, NULL, created_at + ? FROM address_route WHERE thread_id = ? AND id = ?",
      ).run(`demo-bounded-route-${index}`, `:bounded-${index}`, index + 1, thread.threadId, targetSource);
    }
    const count = db
      .query("SELECT COUNT(*) AS count FROM address_route WHERE thread_id = ?")
      .get(thread.threadId) as { count: number };
    expect(count.count).toBeGreaterThan(churn);

    const observed = { calls: 0, rows: 0, maxRows: 0 };
    const instrumented = db as unknown as {
      query: (sql: string, ...args: unknown[]) => unknown;
    };
    const originalQuery = instrumented.query;
    instrumented.query = ((sql: string, ...args: unknown[]) => {
      const statement = originalQuery.call(db, sql, ...args) as Record<string, unknown>;
      if (!/\baddress_route\b/u.test(sql)) return statement;
      observed.calls += 1;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all" || property === "get") {
            return (...parameters: unknown[]) => {
              const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
              const value = method.apply(target, parameters);
              const rows =
                property === "all" ? (Array.isArray(value) ? value.length : 0) : value === null ? 0 : 1;
              observed.rows += rows;
              observed.maxRows = Math.max(observed.maxRows, rows);
              return value;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof instrumented.query;
    try {
      const response = await isolated.fetch(`/api/threads/${thread.threadId}/demo/routes/${targetSource}`);
      expect(response.status).toBe(200);
      const route = (await response.json()) as DemoRouteResource;
      expect(route.id).toBe(targetSource);
    } finally {
      instrumented.query = originalQuery;
    }

    expect(observed.calls).toBeLessThanOrEqual(3);
    expect(observed.rows).toBeLessThanOrEqual(3);
    expect(observed.maxRows).toBeLessThanOrEqual(1);
  } finally {
    await isolated.dispose();
  }
});

test("demo attachment span rejects an oversized manifest before reading bytes", async () => {
  const isolated = await harness();
  let db: Database | undefined;
  try {
    const thread = await isolated.json<ThreadStats>("/api/threads", jsonPost({ title: "Oversized proof" }));
    const summary = await isolated.json<DemoSummary>(`/api/threads/${thread.threadId}/demo`, jsonPost({}));
    const episode = await isolated.json<Episode>(
      `/api/threads/${thread.threadId}/episodes/${summary.proof.attachment.seq}`,
    );
    const manifest = episode.meta.manifest;
    expect(manifest).toBeDefined();
    if (manifest === undefined) throw new Error("proof attachment manifest is missing");
    const target = manifest.spans.at(-1);
    expect(target).toBeDefined();
    if (target === undefined) throw new Error("proof attachment tail span is missing");

    const tamperedMeta = structuredClone(episode.meta);
    const tamperedManifest = tamperedMeta.manifest;
    if (tamperedManifest === undefined) throw new Error("proof attachment manifest clone is missing");
    const tamperedSpan = tamperedManifest.spans.at(-1);
    if (tamperedSpan === undefined) throw new Error("proof attachment span clone is missing");
    tamperedSpan.to = tamperedSpan.from + 64 * 1024 + 1;

    db = new Database(join(isolated.home, "vault.sqlite"));
    db.query("UPDATE episode SET meta = ? WHERE thread_id = ? AND seq = ?").run(
      JSON.stringify(tamperedMeta),
      thread.threadId,
      episode.seq,
    );
    db.close();
    db = undefined;

    const response = await isolated.fetch(
      `/api/threads/${thread.threadId}/demo/attachments/${episode.seq}/spans/${target.ordinal}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "demo_span_not_found",
      error: "No such attachment span.",
    });
  } finally {
    db?.close();
    await isolated.dispose();
  }
});

test("the hosted demo is account-scoped", async () => {
  const accountA = await hosted.login("demo-account-a");
  const accountB = await hosted.login("demo-account-b");
  const threadA = await hosted.json<ThreadStats>("/api/threads", jsonPost({}), accountA.session);
  const threadB = await hosted.json<ThreadStats>("/api/threads", jsonPost({}), accountB.session);

  const responseA = await hosted.fetch(
    `/api/threads/${threadA.threadId}/demo`,
    withSession(jsonPost({}), accountA.session),
  );
  const responseB = await hosted.fetch(
    `/api/threads/${threadB.threadId}/demo`,
    withSession(jsonPost({}), accountB.session),
  );
  expect(responseA.status).toBe(200);
  expect(responseB.status).toBe(200);
  const summaryA = (await responseA.json()) as DemoSummary;
  const summaryB = (await responseB.json()) as DemoSummary;
  expect(summaryA.thread.threadId).toBe(threadA.threadId);
  expect(summaryB.thread.threadId).toBe(threadB.threadId);
  expect(summaryA.final.packetId).not.toBe(summaryB.final.packetId);

  const crossAccount = await hosted.fetch(
    `/api/threads/${threadB.threadId}/demo`,
    withSession(jsonPost({}), accountA.session),
  );
  expect(crossAccount.status).toBe(404);
});
