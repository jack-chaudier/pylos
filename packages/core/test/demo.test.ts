import { afterAll, expect, test } from "bun:test";
import { demo, listAddressRoutes, readAttachmentSpan, sha256 } from "../src/index.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

test("the proof demo is built from durable coverage, gate, route, forget, and tail receipts", async () => {
  const { vault, thread } = tempVault();
  const first = await demo(vault, thread.id);

  expect(first.seeded).toBe(true);
  expect(first.version).toBe("proof-v1");
  expect(first.thread.title).toBe("The proof thread");
  expect(first.thread.turns).toBeGreaterThan(160);
  expect(first.thread.verifiedTo).toBe(first.thread.turns);
  expect(first.thread.capsules).toBeGreaterThan(0);

  expect(first.proof.correctedFact.historicalValue).toBe("Lisbon");
  expect(first.proof.correctedFact.currentValue).toBe("Porto");
  expect(first.proof.correctedFact.originalText).toBe("I live in Lisbon.");
  expect(first.proof.correctedFact.currentText).toBe("I live in Porto.");
  expect(first.proof.correctedFact.grounded.answerReceipt?.status).toBe("released");
  expect(first.proof.correctedFact.grounded.answer).toBe("I live in Porto.");
  expect(first.proof.correctedFact.currentWitness.href).toBe(
    `/api/threads/${thread.id}/episodes/${first.proof.correctedFact.correctionSeq}`,
  );
  expect(first.proof.correctedFact.grounded.links.route).toContain(`/api/threads/${thread.id}/demo/routes/`);
  const currentEpisode = vault.episodes.get(thread.id, first.proof.correctedFact.correctionSeq);
  expect(currentEpisode?.meta.removed).not.toBe(true);
  expect(first.proof.correctedFact.routeId.length).toBeGreaterThan(0);
  expect(first.proof.correctedFact.currentWitness.seq).toBe(first.proof.correctedFact.correctionSeq);
  expect(first.proof.correctedFact.currentWitness.source).toBe(
    `episode:${first.proof.correctedFact.correctionSeq}`,
  );
  const currentBytes = new TextEncoder().encode(currentEpisode?.content ?? "");
  expect(first.proof.correctedFact.currentWitness.contentHash).toBe(sha256(currentBytes));
  expect(first.proof.correctedFact.currentWitness.byteRange).toEqual([0, currentBytes.byteLength]);
  const currentSpanHash = first.proof.correctedFact.currentWitness.spanHash;
  expect(currentSpanHash).toBeDefined();
  if (currentSpanHash === undefined) throw new Error("the demo current witness has no span hash");
  expect(
    sha256(
      currentBytes.slice(
        first.proof.correctedFact.currentWitness.byteRange[0],
        first.proof.correctedFact.currentWitness.byteRange[1],
      ),
    ),
  ).toBe(currentSpanHash);

  const collection = first.proof.collection;
  expect(collection.query).toBe("List all 11 launch notes.");
  expect(collection.coverage).toBeDefined();
  expect(collection.coverage?.required).toBe(11);
  expect(collection.coverage?.located).toBe(10);
  expect(collection.coverage?.supported).toBe(10);
  expect(collection.coverage?.historical).toBe(0);
  expect(collection.coverage?.unresolved).toBe(1);
  expect(collection.coverage?.completeness).toBe("incomplete");
  expect(collection.sources.map((source) => source.text)).toEqual([
    "Launch note: the kiln test began at 09:10.",
    "Launch note: the blue crate goes to Dock 3.",
    "Launch note: Mina owns the backup key.",
    "Launch note: the relay check passed on Tuesday.",
    "Launch note: the spare battery is in the north cabinet.",
    "Launch note: the release window starts after lunch.",
    "Launch note: the paper map stays with the field kit.",
    "Launch note: the first rehearsal uses the small room.",
    "Launch note: the archive copy is stored off-site.",
    "Launch note: the signal test needs a quiet channel.",
  ]);
  expect(collection.sources.map((source) => source.text)).not.toContain(first.final.answer);
  expect(
    collection.sources.every((source) => source.href.includes(`/api/threads/${thread.id}/episodes/`)),
  ).toBe(true);
  const finalPacket = vault.packets.get(thread.id, first.final.questionSeq);
  expect(finalPacket?.coverage).toEqual(collection.coverage);
  expect(finalPacket?.answerReceipt?.digest).toBe(first.final.answerReceipt?.digest);
  expect(first.final.answerReceipt?.status).toBe("released");
  expect(finalPacket?.answerReceipt?.qualifications).toEqual([]);
  expect(
    finalPacket?.answerReceipt?.classifications.some(
      (entry) =>
        entry.classification === "SUPPORTED" &&
        entry.kind === "collection" &&
        entry.basis?.kind === "coverage" &&
        entry.basis.metric === "located" &&
        entry.basis.value === 10 &&
        entry.basis.digest === collection.coverage?.digest,
    ),
  ).toBe(true);
  expect(finalPacket?.answerReceipt?.qualifications).toEqual([]);

  const routes = listAddressRoutes(vault, thread.id, "What is the vault access code?");
  expect(first.proof.invalidation.grounded.answerReceipt?.status).toBe("released");
  expect(first.proof.invalidation.repeated.answerReceipt?.status).toBe("qualified");
  expect(
    first.proof.invalidation.repeated.pages.filter((page) => page.trigger === "invalidation"),
  ).toHaveLength(1);
  const invalidation = routes.find((route) => route.id === first.proof.invalidation.routeId);
  expect(invalidation?.status).toBe("invalidated");
  expect(invalidation?.reason).toMatch(/deleted|source/i);
  expect(first.proof.invalidation.sourceSeq).toBeGreaterThan(0);
  expect(vault.episodes.get(thread.id, first.proof.invalidation.sourceSeq)?.meta.removed).toBe(true);
  expect(first.proof.invalidation.page.trigger).toBe("invalidation");
  expect(first.proof.invalidation.page.resolved).toBe(false);
  expect(first.proof.invalidation.sourceText).toMatch(/removed by user/u);
  expect(first.proof.invalidation.sourceReceipt).toEqual({
    status: "tombstoned",
    contentAvailable: false,
    tombstoneId: expect.stringMatching(/^tb_/u),
    originalContentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    locatorOmittedReason: "removed",
  });
  expect(first.proof.invalidation.sourceHref).toBe(
    `/api/threads/${thread.id}/episodes/${first.proof.invalidation.sourceSeq}`,
  );
  expect(first.proof.invalidation.repeated.links.route).toContain(`/api/threads/${thread.id}/demo/routes/`);

  const attachment = vault.episodes.get(thread.id, first.proof.attachment.seq);
  const manifest = attachment?.meta.manifest;
  expect(attachment?.role).toBe("attachment");
  expect(manifest?.id).toBe(first.proof.attachment.manifestId);
  expect(manifest?.spans.length).toBeGreaterThan(1);
  const last = readAttachmentSpan(
    vault,
    thread.id,
    first.proof.attachment.seq,
    (manifest?.spans.length ?? 1) - 1,
  );
  expect(last).not.toBeNull();
  expect(new TextDecoder().decode(last?.bytes)).toContain(first.proof.attachment.tail.marker);
  const [from, to] =
    first.proof.attachment.tail.from <= (last?.span.from ?? 0)
      ? [last?.span.from ?? 0, last?.span.to ?? 0]
      : [first.proof.attachment.tail.from, first.proof.attachment.tail.to];
  const tailStart = Math.max(0, first.proof.attachment.tail.from - (last?.span.from ?? 0));
  const tailEnd = Math.min(
    last?.bytes.byteLength ?? 0,
    first.proof.attachment.tail.to - (last?.span.from ?? 0),
  );
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  expect(sha256(last?.bytes.slice(tailStart, tailEnd) ?? new Uint8Array())).toBe(
    first.proof.attachment.tail.hash,
  );
  expect(first.proof.attachment.page.trigger).toBe("attachment-tail");
  expect(first.proof.attachment.page.byteRange).toEqual([
    first.proof.attachment.tail.from,
    first.proof.attachment.tail.to,
  ]);
  expect(first.proof.attachment.links.attachment).toBe(
    `/api/threads/${thread.id}/episodes/${first.proof.attachment.seq}`,
  );
  expect(first.proof.attachment.links.span).toBe(
    "/api/threads/" +
      thread.id +
      "/demo/attachments/" +
      first.proof.attachment.seq +
      "/spans/" +
      ((manifest?.spans.length ?? 1) - 1),
  );
  expect(first.final.links.packet).toBe(`/api/threads/${thread.id}/packets/${first.final.questionSeq}`);
  expect(first.final.links.answerEpisode).toBe(`/api/threads/${thread.id}/episodes/${first.final.answerSeq}`);

  const second = await demo(vault, thread.id);
  expect(second.seeded).toBe(false);
  expect(second.final.packetId).toBe(first.final.packetId);
  expect(second.proof.invalidation.routeId).toBe(first.proof.invalidation.routeId);
  expect(second.proof.attachment.manifestId).toBe(first.proof.attachment.manifestId);
});

test("proof demo re-entry uses a bounded current route projection", async () => {
  const { vault, thread } = tempVault();
  const first = await demo(vault, thread.id);
  const db = vault.db as unknown as {
    query: (sql: string, ...args: unknown[]) => unknown;
  };
  const base = (
    db.query("SELECT * FROM address_route WHERE id = ?") as {
      get: (id: string) => Record<string, unknown>;
    }
  ).get(first.proof.correctedFact.routeId);
  expect(base).toBeDefined();
  let parentId = first.proof.correctedFact.routeId;
  for (let index = 0; index < 512; index += 1) {
    const eventId = `demo-route-churn-event-${index}`;
    const nextId = `demo-route-churn-active-${index}`;
    vault.db
      .query(
        "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
          "SELECT ?, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest || ?, 'invalidated', 'demo churn', ?, created_at + ? FROM address_route WHERE id = ?",
      )
      .run(eventId, `:event-${index}`, parentId, index + 1, parentId);
    vault.db
      .query(
        "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
          "SELECT ?, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, 'active', NULL, NULL, created_at + ? FROM address_route WHERE id = ?",
      )
      .run(nextId, index + 1, parentId);
    parentId = nextId;
  }
  expect(base).toBeDefined();

  const stats = { calls: 0, rows: 0, maxRows: 0 };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (!/\baddress_route\b/u.test(sql) || !/ORDER BY[\s\S]*created_at/u.test(sql)) return statement;
    stats.calls += 1;
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const value = method.apply(target, parameters);
            const count = Array.isArray(value) ? value.length : 0;
            stats.rows += count;
            stats.maxRows = Math.max(stats.maxRows, count);
            return value;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.query;
  try {
    const second = await demo(vault, thread.id);
    expect(second.seeded).toBe(false);
    expect(second.proof.correctedFact.routeId).toBe(parentId);
  } finally {
    db.query = originalQuery;
  }
  expect(stats.rows).toBeLessThanOrEqual(256);
  expect(stats.maxRows).toBeLessThanOrEqual(64);
  expect(stats.calls).toBeLessThanOrEqual(16);
});

test("proof demo collection stays on exact lexical sources with semantic routing enabled", async () => {
  const { vault, thread } = tempVault();
  const first = await demo(vault, thread.id);
  const coverage = first.proof.collection.coverage;
  expect(coverage?.required).toBe(11);
  expect(coverage?.located).toBe(10);
  expect(coverage?.supported).toBe(10);
  expect(coverage?.unresolved).toBe(1);
  expect(coverage?.completeness).toBe("incomplete");
  expect(coverage?.routes.every((route) => route.route === "search")).toBe(true);
  expect(first.proof.collection.sources).toHaveLength(10);
  expect(first.proof.collection.sources.every((source) => source.text.startsWith("Launch note:"))).toBe(true);
  expect(first.final.answerReceipt?.status).toBe("released");
});
