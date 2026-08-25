import { afterAll, expect, test } from "bun:test";
import { sha256 } from "../src/hash.ts";
import { page } from "../src/page.ts";
import {
  buildSemanticReceipt,
  DEFAULT_SEMANTIC_UNAVAILABLE_REASON,
  probeSemanticCapability,
  semanticPageRecord,
  verifySemanticHit,
  verifySemanticHits,
} from "../src/semantic.ts";
import {
  semanticEpistemic,
  semanticPhaseForSpan,
  semanticPhaseForSpanResolution,
} from "../src/semantic-phase.ts";
import { type Provider, runTurn } from "../src/turn.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

function addSemanticAtoms(
  vault: ReturnType<typeof tempVault>["vault"],
  threadId: string,
  sourceSeq: number,
  count = 1_000,
): void {
  const insert = vault.db.query(
    "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
      "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
      "VALUES (?, ?, 'fact', ?, 'x', 'x', ?, ?, ?, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'semantic-cap-oracle', ?)",
  );
  vault.tx(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(
        `semantic-cap-atom-${sourceSeq}-${index}`,
        threadId,
        `semantic.cap.${sourceSeq}.${index}`,
        sourceSeq,
        JSON.stringify([0, 1]),
        sourceSeq,
        index,
      );
    }
  });
}

test("A15.2 capability probing is unavailable by default and never guesses readiness", () => {
  const capability = probeSemanticCapability();
  expect(capability.status).toBe("unavailable");
  expect(capability.reason).toContain(DEFAULT_SEMANTIC_UNAVAILABLE_REASON);
  expect(buildSemanticReceipt(capability)).toEqual({
    status: "unavailable",
    indexed: 0,
    eligible: 0,
    reason: DEFAULT_SEMANTIC_UNAVAILABLE_REASON,
  });
});

test("A15.2 ready requires pinned extension, model, and complete index", () => {
  const modelDigest = "a".repeat(64);
  const capability = probeSemanticCapability({
    sqliteVec: { available: true, version: "0.1.9" },
    embedding: { model: "local-test", modelDigest, dimension: 384 },
    eligible: 3,
    indexed: 3,
  });
  expect(capability.status).toBe("ready");
  expect(buildSemanticReceipt(capability)).toEqual({
    status: "ready",
    model: "local-test",
    modelDigest,
    indexed: 3,
    eligible: 3,
  });
});

test("A15.2 validates UTF-8 byte ranges and keeps a hit address-only", () => {
  const content = "A π beacon is green.";
  const bytes = new TextEncoder().encode(content);
  const from = 2;
  const to = bytes.byteLength - 1;
  const spanHash = sha256(bytes.slice(from, to));
  const sourceHash = sha256(bytes);
  const result = verifySemanticHit(
    { seq: 7, span: [from, to], sourceHash, hash: spanHash, revision: "r1" },
    { seq: 7, content, contentHash: sourceHash, role: "assistant", revision: "r1" },
  );
  expect(result.accepted).toBe(true);
  if (!result.accepted) return;
  expect(result.text).toBe("π beacon is green");
  expect(result.sourceHash).toBe(sourceHash);
  expect(result.spanHash).toBe(spanHash);
  expect(result.authority).toBe("assistant");
  expect(result.addressOnly).toBe(true);
  expect(semanticPageRecord(result, { tokens: 20, latencyMs: 1 })).toMatchObject({
    trigger: "semantic",
    seqs: [7],
    resolved: true,
    byteRange: [from, to],
    authority: "assistant",
  });
});

test("A15.2 rejects deleted, tampered, out-of-bounds, and split UTF-8 proposals", () => {
  const content = "A π beacon is green.";
  const bytes = new TextEncoder().encode(content);
  const sourceHash = sha256(bytes);
  const fullHash = sha256(bytes);
  const base = { seq: 7, span: [0, bytes.byteLength] as [number, number], hash: fullHash };
  expect(verifySemanticHit(base, { seq: 7, content, contentHash: sourceHash, removed: true }).accepted).toBe(
    false,
  );
  expect(
    verifySemanticHit(base, { seq: 7, content: `${content} changed`, contentHash: sourceHash }).accepted,
  ).toBe(false);
  expect(verifySemanticHit({ ...base, span: [0, bytes.byteLength + 1] }, { seq: 7, content }).accepted).toBe(
    false,
  );
  // π occupies bytes 2–3; a one-byte range cuts the code point and must not
  // be decoded with U+FFFD or otherwise treated as evidence.
  const split = verifySemanticHit(
    { seq: 7, span: [2, 3], hash: sha256(bytes.slice(2, 3)) },
    { seq: 7, content },
  );
  expect(split).toMatchObject({ accepted: false, reason: "invalid-utf8" });
});

test("A15.2 keeps false proposals observable while only exact hits are accepted", () => {
  const source = { seq: 3, content: "The harbor beacon is green.", role: "user" as const };
  const validBytes = new TextEncoder().encode(source.content);
  const validHash = sha256(validBytes);
  const result = verifySemanticHits(
    [
      { seq: 3, span: [0, validBytes.byteLength], hash: validHash },
      { seq: 3, span: [0, validBytes.byteLength], hash: "0".repeat(64) },
      { seq: 99, span: [0, 4], hash: "0".repeat(64) },
    ],
    (seq) => (seq === source.seq ? source : null),
  );
  expect(result.accepted).toHaveLength(1);
  expect(result.accepted[0]?.authority).toBe("user");
  expect(result.rejected).toHaveLength(2);
  expect(result.rejected.map((entry) => entry.reason)).toEqual(["span-hash-mismatch", "missing-source"]);
  const rejected = result.rejected[0];
  expect(rejected).toBeDefined();
  if (rejected === undefined) return;
  expect(semanticPageRecord(rejected, { tokens: 8, latencyMs: 1 }).seqs).toEqual([]);
});

test("A15.2 caps atom phase reads and fails closed on an overfull semantic source", () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, { role: "user", content: "x" });
  addSemanticAtoms(vault, thread.id, source.seq);

  const stats = { rows: 0, maxRows: 0, limit: undefined as unknown };
  const db = vault.db as unknown as {
    query: (sql: string, ...args: unknown[]) => unknown;
  };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (!/FROM atom WHERE thread_id = \? AND source_seq = \?/u.test(sql)) return statement;
    const limit = /LIMIT\s+(\d+)/iu.exec(sql)?.[1];
    stats.limit = limit === undefined ? undefined : Number(limit);
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
    const resolution = semanticPhaseForSpanResolution(vault, thread.id, source, [0, 1]);
    expect(resolution).toEqual({ status: "overflow", rows: 513 });
    expect(semanticPhaseForSpan(vault, thread.id, source, [0, 1])).toBeUndefined();
    expect(semanticEpistemic(source.role, resolution)).toBe("NON_AUTHORITATIVE");
    stats.rows = 0;
    stats.maxRows = 0;
    const bytes = new TextEncoder().encode(source.content);
    const pageResult = page(vault, thread.id, {
      query: "What did I say?",
      budget: 8192,
      semanticHits: [
        {
          seq: source.seq,
          byteRange: [0, bytes.byteLength],
          contentHash: sha256(bytes),
          spanHash: sha256(bytes),
          revision: source.hash,
        },
      ],
    });
    expect(pageResult.blocks[0]?.epistemic).toBe("NON_AUTHORITATIVE");
  } finally {
    db.query = originalQuery;
  }
  expect(stats.limit).toBe(513);
  expect(stats.maxRows).toBeLessThanOrEqual(513);
  expect(stats.rows).toBeLessThanOrEqual(513);
});

test("A15.2 keeps the explicit role fallback for an ordinary zero-atom source", () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, { role: "user", content: "x" });
  const bytes = new TextEncoder().encode(source.content);
  const pageResult = page(vault, thread.id, {
    query: "What did I say?",
    budget: 8192,
    semanticHits: [
      {
        seq: source.seq,
        byteRange: [0, bytes.byteLength],
        contentHash: sha256(bytes),
        spanHash: sha256(bytes),
        revision: source.hash,
      },
    ],
  });
  expect(pageResult.blocks[0]?.epistemic).toBe("SUPPORTED");
});

test("A15.2 overfull semantic phases issue no current evidence capability", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, { role: "user", content: "x" });
  addSemanticAtoms(vault, thread.id, source.seq);
  const bytes = new TextEncoder().encode(source.content);
  const semanticHit = {
    seq: source.seq,
    byteRange: [0, bytes.byteLength] as [number, number],
    contentHash: sha256(bytes),
    spanHash: sha256(bytes),
    revision: source.hash,
  };
  let seen: string | undefined;
  const provider: Provider = async function* (request) {
    seen = request.evidence?.find((capability) => capability.seq === source.seq)?.token;
    yield { type: "delta", text: "I cannot verify that source." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "What did I say?",
    model: "oracle",
    provider,
    check: false,
    budget: 8_192,
    compileOptions: {
      semanticHits: [semanticHit],
      semanticReceipt: { status: "ready", indexed: 1, eligible: 1 },
    },
  });
  expect(seen).toBeUndefined();
  expect(result.packet.pages.some((record) => record.trigger === "semantic" && record.resolved)).toBe(true);
});
