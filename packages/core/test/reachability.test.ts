import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_PACKET_JSON_BYTES,
  MAX_PACKET_MESSAGES_BYTES,
  MAX_PACKET_RESPONSE_BYTES,
  MAX_THREAD_BUDGET,
} from "@pylos/protocol";
import * as core from "../src/index.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

type ReachabilityState = "resident" | "capsule" | "pageable" | "opaque";

interface ExplicitReachabilitySpan {
  kind?: "episode" | "attachment";
  /** `episode:<seq>` for episode text, or `blob:<sha256>` for attachment bytes. */
  source: string;
  from: number;
  to: number;
  hash: string;
  state: ReachabilityState;
  /** Exact source locator for `pageable`; absent for resident/capsule/opaque. */
  locator?: { source: string; from: number; to: number; hash: string };
  capsuleId?: string;
  manifest?: string;
}

interface EpisodeRangeReachabilitySpan {
  kind: "episode-range";
  fromSeq: number;
  toSeq: number;
  state: "capsule" | "pageable";
  locatorTemplate?: string;
  capsuleId?: string;
  digest?: string;
}

interface AttachmentRangeReachabilitySpan {
  kind: "attachment-range";
  fromSeq: number;
  toSeq: number;
  state: "pageable";
  locatorTemplate: "attachment:{seq}";
  digest: string;
}

type ReachabilitySpan =
  | ExplicitReachabilitySpan
  | EpisodeRangeReachabilitySpan
  | AttachmentRangeReachabilitySpan;

interface ReachabilityModule {
  verifyReachability?: (
    vault: unknown,
    threadId: string,
    packet: unknown,
  ) => { ok: boolean; status?: "current" | "invalidated"; reason?: string };
}

const kernel = core as unknown as ReachabilityModule;

function packetField(packet: unknown, key: string): unknown {
  expect(typeof packet).toBe("object");
  expect(packet).not.toBeNull();
  return (packet as Record<string, unknown>)[key];
}

function reachability(packet: unknown): ReachabilitySpan[] {
  const value = packetField(packet, "reachability");
  expect(Array.isArray(value)).toBe(true);
  return value as ReachabilitySpan[];
}

function verifyReachability(
  vault: unknown,
  threadId: string,
  packet: unknown,
): { ok: boolean; status?: "current" | "invalidated"; reason?: string } {
  expect(typeof kernel.verifyReachability).toBe("function");
  return kernel.verifyReachability?.(vault, threadId, packet) ?? { ok: false, reason: "missing verifier" };
}

function packetText(packet: unknown): string {
  const messages = packetField(packet, "messages");
  expect(Array.isArray(messages)).toBe(true);
  return (messages as Array<Record<string, unknown>>)
    .map((message) => String(message.content ?? ""))
    .join("\n");
}

function intervalsFor(spans: readonly ReachabilitySpan[], source: string): ExplicitReachabilitySpan[] {
  return spans
    .filter(
      (span): span is ExplicitReachabilitySpan =>
        span.kind !== "episode-range" && span.kind !== "attachment-range" && span.source === source,
    )
    .sort((a, b) => a.from - b.from);
}

function coversEpisode(span: ReachabilitySpan, seq: number): boolean {
  if (span.kind === "episode-range") return span.fromSeq <= seq && seq <= span.toSeq;
  if (span.kind === "attachment-range") return false;
  return span.source === `episode:${seq}`;
}

function coversAttachment(span: ReachabilitySpan, seq: number): boolean {
  return span.kind === "attachment-range" && span.fromSeq <= seq && seq <= span.toSeq;
}

function assertAttachmentCoverage(
  spans: readonly ReachabilitySpan[],
  episodeSeq: number,
  manifest: Record<string, unknown>,
): void {
  const ranges = spans.filter((span): span is AttachmentRangeReachabilitySpan =>
    coversAttachment(span, episodeSeq),
  );
  const manifestId = String(manifest.id);
  const wholeHash = String(manifest.hash);
  const explicit = spans.filter(
    (span): span is ExplicitReachabilitySpan =>
      span.kind !== "episode-range" &&
      span.kind !== "attachment-range" &&
      span.kind === "attachment" &&
      (span.manifest === manifestId || span.source === `blob:${wholeHash}`),
  );
  expect(explicit.length + ranges.length).toBeGreaterThan(0);
  if (ranges.length > 0) {
    expect(explicit).toHaveLength(0);
    expect(ranges).toHaveLength(1);
    const range = ranges[0] as AttachmentRangeReachabilitySpan;
    expect(range.locatorTemplate).toBe("attachment:{seq}");
    expect(range.digest).toMatch(/^[0-9a-f]{64}$/);
    return;
  }

  const manifestSpans = manifest.spans as Array<Record<string, unknown>>;
  const ordered = [...explicit].sort((a, b) => a.from - b.from);
  let cursor = 0;
  for (const row of ordered) {
    expect(row.from).toBe(cursor);
    expect(row.to).toBeGreaterThan(row.from);
    const manifestSpan = manifestSpans.find((span) => span.from === row.from);
    expect(manifestSpan).toBeDefined();
    expect(row.hash).toBe(String((manifestSpan as Record<string, unknown>).hash));
    cursor = row.to;
  }
  expect(cursor).toBe(Number(manifest.size));
}

test("compile ignores arbitrarily many tombstones and keeps range work constant", () => {
  const { vault, thread } = tempVault({ budget: 256 });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 8 }, (_, index) => ({
      role: "user" as const,
      content: `tombstone boundedness source ${index}`,
    })),
  );
  const insert = vault.db.query(
    "INSERT INTO tombstone (id, thread_id, target, reason, created_at, removal_seq, echoes) " +
      "VALUES (?, ?, ?, ?, ?, 0, '[]')",
  );
  vault.tx(() => {
    for (let index = 0; index < 100_000; index += 1) {
      insert.run(
        `compile-tombstone-${index}`,
        thread.id,
        `seqs:${(index % 8) + 1}`,
        "boundedness oracle",
        index + 1,
      );
    }
  });

  // The old path hydrated every row through tombstones.list() once per trim.
  // A compile must not consult tombstones at all: episode ranges cover the
  // numeric archive, and the verifier assigns no state to valid holes.
  const tombstones = vault.tombstones as unknown as {
    list: (threadId: string) => unknown;
  };
  const originalList = tombstones.list;
  tombstones.list = () => {
    throw new Error("unbounded tombstone list must not be used by compile");
  };
  try {
    const packet = core.compile(vault, thread.id, {
      query: "what was in the boundedness source?",
      budget: 512,
      tokenizer: (text) => Math.max(1, Math.ceil(text.length / 3)),
    });
    expect(packet.reachability?.length ?? 0).toBeGreaterThan(0);
  } finally {
    tombstones.list = originalList;
  }
});

test("stored packet reachability replay visits a growing archive only linearly and imports", async () => {
  const episodeCount = 48;
  const { vault, thread } = tempVault({ budget: 2048 });
  for (let index = 0; index < episodeCount; index += 1) {
    const query = vault.episodes.append(thread.id, {
      role: "user",
      content: `nonempty retained reachability history row ${index}`,
    });
    const packet = core.compile(vault, thread.id, {
      turnSeq: query.seq,
      query: query.content,
      budget: 2048,
    });
    vault.packets.insert(packet);
    // Compiler v1 completed packets predate answer authority and therefore do
    // not require an assistant answer binding. Reachability remains present,
    // making this a focused retained-packet replay fixture.
    vault.db.query("UPDATE packet SET compiler_version = '1' WHERE id = ?").run(packet.id);
  }
  // Later chain-bound forgets invalidate historical packet witnesses without
  // authorizing a packet-by-tombstone rescan during retained verification.
  for (const seq of [3, 7, 11, 15, 19, 23, 27, 31]) {
    core.forget(vault, thread.id, { seqs: [seq], reason: `linear replay tombstone ${seq}` });
  }
  const archiveEpisodeCount = vault.threads.get(thread.id)?.headSeq ?? 0;

  const metadataRows = { visited: 0 };
  const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (
      !/SELECT seq, role, length\(CAST\(content AS BLOB\)\) AS content_bytes, meta(?:, content_hash)? FROM episode/iu.test(
        sql,
      )
    ) {
      return statement;
    }
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property !== "all" && property !== "iterate") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...parameters: unknown[]) => {
          const method = Reflect.get(target, property, receiver) as (...values: unknown[]) => unknown;
          const value = method.apply(target, parameters);
          if (property === "all") {
            metadataRows.visited += (value as unknown[]).length;
            return value;
          }
          const rows = value as Iterable<unknown>;
          return (function* () {
            for (const row of rows) {
              metadataRows.visited += 1;
              yield row;
            }
          })();
        };
      },
    });
  }) as typeof db.query;
  try {
    const result = core.verify(vault, thread.id, { full: true });
    expect(result.ok, result.reason).toBe(true);
  } finally {
    db.query = originalQuery;
  }
  expect(metadataRows.visited).toBeGreaterThan(0);
  expect(metadataRows.visited).toBeLessThanOrEqual(archiveEpisodeCount * 2);

  const bundle = await core.exportBundle(vault, thread.id, { passphrase: "linear-reachability-replay" });
  const importedVault = tempVault({ budget: 2048 }).vault;
  const imported = await core.importBundle(importedVault, bundle, {
    passphrase: "linear-reachability-replay",
  });
  expect(imported.episodes).toBe(archiveEpisodeCount);
  const importedPackets = importedVault.db
    .query("SELECT COUNT(*) AS count FROM packet WHERE thread_id = ?")
    .get(imported.threadId) as { count: number };
  expect(importedPackets.count).toBe(episodeCount);
  expect(core.verify(importedVault, imported.threadId, { full: true }).ok).toBe(true);
});

test("standalone reachability verification hydrates at most one large metadata row", () => {
  const rowCount = 512;
  const { vault, thread } = tempVault({ budget: 1024 });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: rowCount }, (_, index) => ({
      role: "user" as const,
      content: `large metadata row ${index}`,
      meta: { padding: "m".repeat(32 * 1024) } as never,
    })),
  );
  const spans = core.buildReachability(vault, thread.id, { resident: [], capsules: [] });
  const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
  const originalQuery = db.query;
  let maxRows = 0;
  let maxMetaBytes = 0;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (
      !/SELECT seq, role, length\(CAST\(content AS BLOB\)\) AS content_bytes, meta FROM episode/iu.test(sql)
    ) {
      return statement;
    }
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const rows = method.apply(target, parameters) as Array<{ meta: string }>;
            maxRows = Math.max(maxRows, rows.length);
            maxMetaBytes = Math.max(
              maxMetaBytes,
              rows.reduce((total, row) => total + row.meta.length, 0),
            );
            return rows;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.query;
  try {
    const result = core.verifyReachability(vault, thread.id, {
      reachability: spans,
      reachabilityAsOfSeq: rowCount,
      resident: [],
    });
    expect(result.ok, result.reason).toBe(true);
  } finally {
    db.query = originalQuery;
  }
  expect(maxRows).toBe(1);
  expect(maxMetaBytes).toBeLessThan(40 * 1024);
});

function assertExclusiveClosure(
  spans: readonly ReachabilitySpan[],
  seq: number,
  source: string,
  byteLength: number,
): void {
  const ranges = spans.filter(
    (span): span is EpisodeRangeReachabilitySpan =>
      span.kind === "episode-range" && span.fromSeq <= seq && seq <= span.toSeq,
  );
  const rows = intervalsFor(spans, source);
  expect(rows.length + ranges.length).toBeGreaterThan(0);

  // A million-turn packet may cover a capsule/pageable run with one sequence
  // range. Expand only this fixture sequence for the byte-closure check; the
  // kernel verifier must still validate each source byte independently.
  if (ranges.length > 0) {
    expect(rows).toHaveLength(0);
    expect(ranges).toHaveLength(1);
    const range = ranges[0] as EpisodeRangeReachabilitySpan;
    expect(range.fromSeq).toBeLessThanOrEqual(seq);
    expect(range.toSeq).toBeGreaterThanOrEqual(seq);
    expect(byteLength).toBeGreaterThan(0);
    if (range.state === "capsule") {
      expect(range.capsuleId ?? range.digest).toBeDefined();
      expect(range.locatorTemplate).toBeUndefined();
    } else {
      expect(range.locatorTemplate).toBe("episode:{seq}");
    }
    return;
  }

  expect(rows.length).toBeGreaterThan(0);
  let cursor = 0;
  for (const row of rows) {
    expect(row.from).toBe(cursor);
    expect(row.to).toBeGreaterThan(row.from);
    expect(row.to).toBeLessThanOrEqual(byteLength);
    expect(["resident", "capsule", "pageable", "opaque"]).toContain(row.state);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    if (row.state === "pageable") {
      expect(row.locator).toBeDefined();
      expect(row.locator?.source).toBe(source);
      expect(row.locator?.from).toBe(row.from);
      expect(row.locator?.to).toBe(row.to);
      expect(row.locator?.hash).toBe(row.hash);
    } else if (row.state === "capsule") {
      expect(row.capsuleId).toEqual(expect.any(String));
      expect(row.locator).toBeUndefined();
    } else {
      expect(row.locator).toBeUndefined();
    }
    cursor = row.to;
  }
  expect(cursor).toBe(byteLength);
}

test("every retained episode byte has exactly one closure state and a verifier receipt", () => {
  const { vault, thread } = tempVault({ budget: 512 });
  const source = [
    "The older record is exact: café, naïve, and 🐉 stay byte-addressable.",
    "A second record keeps a locator even if the recent view cannot fit it.",
    "The tail remains visible after the view budget is spent.",
  ];
  source.forEach((content) => {
    vault.episodes.append(thread.id, { role: "user", content });
  });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 96 }, (_, i) => ({ role: "user" as const, content: `filler-${i} quiet archive` })),
  );
  core.compact(vault, thread.id, { budget: 512 });
  const packet = core.compile(vault, thread.id, {
    budget: 512,
    query: "",
    tokenizer: (text) => Math.ceil(new TextEncoder().encode(text).byteLength / 3),
  });
  const spans = reachability(packet);

  const headSeq = vault.threads.get(thread.id)?.headSeq ?? 0;
  for (const episode of vault.episodes.range(thread.id, 1, headSeq)) {
    const bytes = new TextEncoder().encode(episode.content);
    assertExclusiveClosure(spans, episode.seq, `episode:${episode.seq}`, bytes.byteLength);
  }
  const states = new Set(spans.map((span) => span.state));
  expect([...states].every((state) => ["resident", "capsule", "pageable", "opaque"].includes(state))).toBe(
    true,
  );
  expect(states.has("unknown" as ReachabilityState)).toBe(false);
  expect(verifyReachability(vault, thread.id, packet).ok).toBe(true);

  const tampered = structuredClone(packet) as unknown as Record<string, unknown>;
  const tamperedSpans = reachability(tampered);
  const first = tamperedSpans[0] as ReachabilitySpan;
  if (first.kind === "episode-range") {
    tamperedSpans[0] = { ...first, toSeq: first.fromSeq };
  } else if (first.kind === "attachment-range") {
    tamperedSpans[0] = { ...first, toSeq: first.fromSeq };
  } else {
    tamperedSpans[0] = { ...first, from: first.from + 1 };
  }
  expect(verifyReachability(vault, thread.id, tampered).ok).toBe(false);
});

test("capsule closure requires the resident capsule and its intact loss-bearing record", () => {
  const { vault, thread } = tempVault({ budget: 512 });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 192 }, (_, index) => ({
      role: "user" as const,
      content: `capsule source ${index} keeps an exact locator`,
    })),
  );
  core.compact(vault, thread.id, { budget: 512 });
  const packet = core.compile(vault, thread.id, { query: "", budget: 512 });
  const capsuleRange = reachability(packet).find(
    (span): span is EpisodeRangeReachabilitySpan => span.kind === "episode-range" && span.state === "capsule",
  );
  expect(capsuleRange?.capsuleId).toEqual(expect.any(String));
  const capsuleId = capsuleRange?.capsuleId as string;
  expect(packet.resident.some((item) => item.type === "capsule" && item.ref === capsuleId)).toBe(true);
  expect(verifyReachability(vault, thread.id, packet).ok).toBe(true);

  const withoutResidentCapsule = structuredClone(packet);
  withoutResidentCapsule.resident = withoutResidentCapsule.resident.filter(
    (item) => !(item.type === "capsule" && item.ref === capsuleId),
  );
  expect(verifyReachability(vault, thread.id, withoutResidentCapsule).ok).toBe(false);

  vault.db.query("UPDATE capsule SET text = text || ' tampered' WHERE id = ?").run(capsuleId);
  expect(verifyReachability(vault, thread.id, packet).ok).toBe(false);
});

test("an oversized recent episode is skipped, but its exact pageable locator is exposed", () => {
  const { vault, thread } = tempVault({ budget: 256 });
  const older = vault.episodes.append(thread.id, {
    role: "user",
    content: "The small preceding note is still needed after the oversized turn.",
  });
  const huge = vault.episodes.append(thread.id, {
    role: "user",
    content: `oversized-${"x".repeat(20_000)}`,
  });
  const packet = core.compile(vault, thread.id, {
    budget: 256,
    // Keep the ordinary pager out of this oracle: only fillRecent may decide
    // whether the preceding note is visible.
    query: "",
  });
  const resident = packet.resident.filter((item) => item.type === "recent").map((item) => item.seq);
  expect(resident).toContain(older.seq);
  expect(resident).not.toContain(huge.seq);

  const skipped = reachability(packet).filter((span) => coversEpisode(span, huge.seq));
  expect(skipped.some((span) => span.state === "pageable")).toBe(true);
  expect(packetText(packet)).not.toContain(huge.content);
  expect(packetText(packet)).toMatch(new RegExp(`(?:pageable|recoverable).{0,120}#${huge.seq}`));
  expect(verifyReachability(vault, thread.id, packet).ok).toBe(true);
});

test("fillRecent continues beyond the former scan horizon", () => {
  const { vault, thread } = tempVault({ budget: 16_384 });
  const old = vault.episodes.append(thread.id, {
    role: "user",
    content: "the older note fits the recent allocation",
  });
  vault.episodes.appendMany(
    thread.id,
    // Deliberately exceeds the former 4,096 scan horizon: the older fitting
    // witness must remain resident rather than being silently skipped.
    Array.from({ length: 4_097 }, (_, index) => ({
      role: "user" as const,
      content: `oversized-recent-${index}`,
    })),
  );
  const tokenizer = (text: string): number =>
    text.startsWith("oversized-recent-") ? 100_000 : Math.max(1, Math.ceil(text.length / 10));
  const packet = core.compile(vault, thread.id, {
    budget: 16_384,
    query: "",
    tokenizer,
  });
  const resident = packet.resident.filter((item) => item.type === "recent").map((item) => item.seq);
  expect(resident).toContain(old.seq);
});

test("authenticated legacy oversized rows are scanned one at a time for compile and verification", () => {
  const { vault, thread } = tempVault({ budget: 256 });
  const old = vault.episodes.append(thread.id, {
    role: "user",
    content: "the fitting witness must survive an imported oversized tail",
  });
  const legacy = vault.episodes.append(thread.id, {
    role: "user",
    content: "legacy import placeholder",
  });
  // Current writers reject this source before mutation. Rebind the final row
  // as an authenticated legacy/import-shaped episode so the read-time oracle
  // does not weaken the production admission cap merely to create its fixture.
  const content = `imported-oversized-${"x".repeat(1_100_000)}`;
  const contentHash = core.sha256(content);
  const hash = core.chainHash(
    old.hash,
    core.chainRecord({
      seq: legacy.seq,
      ts: legacy.ts,
      role: legacy.role,
      contentHash,
      metaHash: core.metaHashOf(legacy.meta),
    }),
  );
  vault.db
    .query("UPDATE episode SET content = ?, content_hash = ?, hash = ? WHERE thread_id = ? AND seq = ?")
    .run(content, contentHash, hash, thread.id, legacy.seq);
  vault.db.query("UPDATE thread SET head_hash = ? WHERE id = ?").run(hash, thread.id);
  expect(core.verify(vault, thread.id, { full: true }).ok).toBe(true);

  const episodes = vault.episodes as unknown as {
    range: (id: string, from: number, to: number) => Array<{ seq: number; content: string }>;
  };
  const originalRange = episodes.range;
  const rangeBytes: Array<{ bytes: number; rows: number }> = [];
  episodes.range = (id, from, to) => {
    const rows = originalRange(id, from, to);
    rangeBytes.push({
      bytes: rows.reduce((sum, row) => sum + new TextEncoder().encode(row.content).byteLength, 0),
      rows: rows.length,
    });
    return rows;
  };
  try {
    const packet = core.compile(vault, thread.id, { query: "", budget: 256 });
    expect(packet.resident.some((item) => item.type === "recent" && item.seq === old.seq)).toBe(true);
    expect(verifyReachability(vault, thread.id, packet).ok).toBe(true);
    expect(rangeBytes.length).toBeGreaterThan(0);
    expect(rangeBytes.every((range) => range.bytes <= 256 * 1024 || range.rows === 1)).toBe(true);
  } finally {
    episodes.range = originalRange;
  }
});

test("a reachability receipt remains verifiable at its compile snapshot after append and forget", () => {
  const { vault, thread } = tempVault({ budget: 512 });
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "The historical witness is retained only through its receipt.",
  });
  vault.episodes.append(thread.id, { role: "assistant", content: "I saw the historical witness." });
  const packet = core.compile(vault, thread.id, { query: "", budget: 512 });
  expect(verifyReachability(vault, thread.id, packet).ok).toBe(true);

  // The packet is immutable evidence for the head that existed when it was
  // compiled; a later append must not make that old receipt incomplete.
  vault.episodes.append(thread.id, { role: "user", content: "A later turn is outside this packet." });
  expect(verifyReachability(vault, thread.id, packet).ok).toBe(true);
  const futureBound = structuredClone(packet) as unknown as Record<string, unknown>;
  futureBound.reachabilityAsOfSeq = (vault.threads.get(thread.id)?.headSeq ?? 0) + 1;
  expect(verifyReachability(vault, thread.id, futureBound).ok).toBe(false);
  const negativeBound = structuredClone(packet) as unknown as Record<string, unknown>;
  negativeBound.reachabilityAsOfSeq = -1;
  expect(verifyReachability(vault, thread.id, negativeBound).ok).toBe(false);

  // Forget clears packet messages and the source bytes, but preserves the
  // receipt.  Only a chain-bound tombstone may make the historical witness
  // auditable after the bytes are gone.
  const stored = structuredClone(packet);
  vault.packets.insert(stored, "pending");
  const removal = core.forget(vault, thread.id, { seqs: [source.seq], reason: "snapshot oracle" });
  expect(removal.removalSeq).toBeGreaterThan(source.seq);
  const historical = verifyReachability(vault, thread.id, stored);
  expect(historical.ok).toBe(true);
  expect(historical.status).toBe("invalidated");

  const invalidated = structuredClone(stored) as unknown as Record<string, unknown>;
  const invalidatedSpans = reachability(invalidated);
  const sourceSpan = invalidatedSpans.find(
    (span) =>
      span.kind !== "episode-range" &&
      span.kind !== "attachment-range" &&
      span.source === `episode:${source.seq}`,
  );
  if (sourceSpan !== undefined) {
    const index = invalidatedSpans.indexOf(sourceSpan);
    invalidatedSpans[index] = {
      ...(sourceSpan as ExplicitReachabilitySpan),
      hash: "0".repeat(64),
    };
  }
  expect(verifyReachability(vault, thread.id, invalidated).ok).toBe(false);
});

test("a historical reachability receipt survives a nonempty bundle roundtrip", async () => {
  const { vault, thread } = tempVault({ budget: 512 });
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "Bundle this historical witness before its authorized removal.",
  });
  vault.episodes.append(thread.id, { role: "assistant", content: "The witness is in the archive." });
  const packet = core.compile(vault, thread.id, { query: "", budget: 512 });
  vault.packets.insert(packet, "pending");
  vault.episodes.append(thread.id, { role: "user", content: "A later question advances the head." });
  core.forget(vault, thread.id, { seqs: [source.seq], reason: "bundle snapshot oracle" });

  const bundle = await core.exportBundle(vault, thread.id, { passphrase: "snapshot-roundtrip" });
  const target = tempVault().vault;
  const imported = await core.importBundle(target, bundle, { passphrase: "snapshot-roundtrip" });
  const restored = target.packets.get(imported.threadId, packet.turnSeq);
  expect(restored?.reachabilityAsOfSeq).toBe(2);
  expect(restored?.reachability?.length).toBeGreaterThan(0);
  expect(verifyReachability(target, imported.threadId, restored).ok).toBe(true);
});

test("a packet compiled after forget does not receipt removed bytes", () => {
  const { vault, thread } = tempVault({ budget: 512 });
  const removed = vault.episodes.append(thread.id, { role: "user", content: "Erase this before compiling." });
  vault.episodes.append(thread.id, { role: "assistant", content: "A surviving turn." });
  core.forget(vault, thread.id, { seqs: [removed.seq], reason: "current packet oracle" });
  const packet = core.compile(vault, thread.id, { query: "", budget: 512 });
  expect(verifyReachability(vault, thread.id, packet).ok).toBe(true);
  expect(reachability(packet).some((span) => coversEpisode(span, removed.seq))).toBe(false);
});

test("a numeric episode range may straddle a chain-bound removed hole", () => {
  const { vault, thread } = tempVault({ budget: 512 });
  const removed = vault.episodes.append(thread.id, { role: "user", content: "A hole in the archive." });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 4 }, (_, index) => ({
      role: "user" as const,
      content: `surviving range row ${index}`,
    })),
  );
  core.forget(vault, thread.id, { seqs: [removed.seq], reason: "range-hole oracle" });

  const spans = core.buildReachability(vault, thread.id, { resident: [], capsules: [] });
  const range = spans.find((span) => span.kind === "episode-range");
  const headSeq = vault.threads.get(thread.id)?.headSeq ?? 0;
  expect(range).toBeDefined();
  expect(range?.fromSeq).toBe(1);
  expect(range?.toSeq).toBe(headSeq);
  expect(
    verifyReachability(vault, thread.id, {
      reachability: spans,
      reachabilityAsOfSeq: headSeq,
      resident: [],
    }).ok,
  ).toBe(true);
});

test("reachability rejects a forged removed flag without a chain-bound record", () => {
  const { vault, thread } = tempVault({ budget: 512 });
  const source = vault.episodes.append(thread.id, { role: "user", content: "Never forge this closure." });
  vault.db
    .query("UPDATE episode SET content = ?, meta = ? WHERE thread_id = ? AND seq = ?")
    .run(
      "⟦removed by user · forged⟧",
      JSON.stringify({ removed: true, tombstone: "missing" }),
      thread.id,
      source.seq,
    );
  const result = verifyReachability(vault, thread.id, {
    reachability: [
      {
        kind: "episode-range",
        fromSeq: source.seq,
        toSeq: source.seq,
        state: "pageable",
        locatorTemplate: "episode:{seq}",
      },
    ],
    reachabilityAsOfSeq: source.seq,
    resident: [],
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/removed episode|chain-bound|tombstone/i);
});

test("forget invalidates an old attachment receipt without reviving deleted objects", () => {
  const { vault, thread } = tempVault({ budget: 512 });
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "old.bin",
    blob: { bytes: Uint8Array.from([3, 1, 4, 1, 5, 9]), mime: "application/octet-stream", name: "old.bin" },
  });
  vault.episodes.append(thread.id, { role: "assistant", content: "The object was archived." });
  const packet = core.compile(vault, thread.id, { query: "", budget: 512 });
  vault.packets.insert(packet, "pending");
  const blob = String(attachment.meta.blob);
  expect(vault.blobs.get(blob)).not.toBeNull();
  core.forget(vault, thread.id, { seqs: [attachment.seq], reason: "attachment deletion oracle" });
  expect(vault.blobs.get(blob)).toBeNull();
  const result = verifyReachability(vault, thread.id, packet);
  expect(result.ok).toBe(true);
  expect(result.status).toBe("invalidated");

  const current = core.compile(vault, thread.id, { query: "", budget: 512 });
  expect(verifyReachability(vault, thread.id, current).ok).toBe(true);
  const currentSpans = reachability(current);
  expect(currentSpans.some((span) => coversAttachment(span, attachment.seq))).toBe(false);
});

test("a zero recent allocation still receipts every skipped episode", () => {
  const { vault, thread } = tempVault({ budget: 69 });
  const old = vault.episodes.append(thread.id, { role: "user", content: "old note" });
  const newer = vault.episodes.append(thread.id, { role: "user", content: "newer note" });
  const packet = core.compile(vault, thread.id, {
    budget: 69,
    shares: { header: 0.25, frontier: 0.25, capsules: 0.25, paged: 0.25 },
    query: "check the notes",
    tokenizer: (text) => Math.max(1, Math.ceil(text.length / 100)),
  });
  const recent = packet.resident.filter((item) => item.type === "recent");
  expect(recent).toHaveLength(0);
  const skipped = reachability(packet).filter((span) => span.state === "pageable");
  expect(skipped.some((span) => coversEpisode(span, old.seq))).toBe(true);
  expect(skipped.some((span) => coversEpisode(span, newer.seq))).toBe(true);
  expect(packetText(packet)).toMatch(/pageable|recoverable/i);
  expect(verifyReachability(vault, thread.id, packet).ok).toBe(true);
});

test("render-time recent trimming adds a pageable receipt for the removed tail", () => {
  const { vault, thread } = tempVault({ budget: 512 });
  const episodes = vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 18 }, (_, i) => ({
      role: "user" as const,
      content: `recent-${i} ${"word ".repeat(12)}`,
    })),
  );
  const packet = core.compile(vault, thread.id, {
    budget: 512,
    query: "which recent records are available?",
    tokenizer: (text) => Math.ceil(text.length / 2),
  });
  const resident = new Set(packet.resident.filter((item) => item.type === "recent").map((item) => item.seq));
  const trimmed = episodes.filter((episode) => !resident.has(episode.seq));
  expect(trimmed.length).toBeGreaterThan(0);
  const spans = reachability(packet);
  for (const episode of trimmed) {
    expect(spans.some((span) => coversEpisode(span, episode.seq) && span.state === "pageable")).toBe(true);
  }
  expect(packetText(packet)).toMatch(/pageable|recoverable/i);
  expect(verifyReachability(vault, thread.id, packet).ok).toBe(true);
});

test("a max-budget long tail stays within packet preflight while remaining fully receipted", () => {
  const { vault, thread } = tempVault({ budget: MAX_THREAD_BUDGET });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 20_000 }, () => ({ role: "user" as const, content: "x" })),
  );
  const packet = core.compile(vault, thread.id, { budget: MAX_THREAD_BUDGET, query: "" });
  vault.packets.insert(packet, "pending");

  const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  expect(bytes(packet.messages)).toBeLessThanOrEqual(MAX_PACKET_MESSAGES_BYTES);
  expect(bytes(packet.resident)).toBeLessThanOrEqual(MAX_PACKET_JSON_BYTES);
  expect(bytes(packet.reachability)).toBeLessThanOrEqual(MAX_PACKET_JSON_BYTES);
  expect(bytes(packet)).toBeLessThanOrEqual(MAX_PACKET_RESPONSE_BYTES);
  expect(vault.packets.preflight(thread.id, packet.turnSeq)).toBe("ok");
  expect(packet.resident.filter((item) => item.type === "recent").length).toBeLessThan(20_000);
  expect(core.verifyReachability(vault, thread.id, packet).ok).toBe(true);
  expect(core.verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("reachability and packet writes reject oversized resident projections", () => {
  const { vault, thread } = tempVault();
  const packet = core.compile(vault, thread.id, { query: "" });
  const oversized = Array.from({ length: 20_000 }, (_, index) => ({
    type: "recent" as const,
    ref: `ep:${index + 1}`,
    seq: index + 1,
    tokens: 1,
    epistemic: "SUPPORTED" as const,
  }));
  packet.resident = oversized;
  expect(() =>
    core.buildReachability(vault, thread.id, {
      resident: oversized,
      capsules: [],
    }),
  ).toThrow(/resident projection/i);
  expect(() => vault.packets.insert(packet)).toThrow(/resident/i);
  expect(vault.packets.preflight(thread.id, packet.turnSeq)).toBe("missing");
});

test("packet finish rejects an aggregate overflow and preserves the pending row", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const packet = core.compile(vault, thread.id, { query: "", budget: 1024 });
  packet.messages = [{ role: "system", content: "m".repeat(1_400_000) }];
  packet.resident = [
    {
      type: "header",
      ref: "r".repeat(250_000),
      tokens: 1,
      epistemic: "NON_AUTHORITATIVE",
    },
  ];
  packet.ledger = {
    count: 0,
    residentNames: ["l".repeat(250_000)],
    historical: [],
  };
  packet.pages = [];
  packet.rounds = [];
  packet.reachability = undefined;
  packet.coverage = undefined;
  packet.evidence = undefined;
  packet.answerReceipt = undefined;
  packet.semantic = undefined;

  vault.packets.insert(packet, "pending");
  expect(vault.packets.preflightById(packet.id).status).toBe("ok");
  const overflowPage = {
    trigger: "explicit" as const,
    seqs: [1],
    tokens: 1,
    latencyMs: 0,
    resolved: true,
    name: "p".repeat(210_000),
  };
  expect(() => vault.packets.finish(packet.id, [overflowPage])).toThrow(/aggregate/i);

  const pending = vault.packets.byId(packet.id);
  expect(pending?.status).toBe("pending");
  expect(pending?.pages).toEqual([]);
  expect(vault.packets.preflightById(packet.id).status).toBe("ok");
});

test("large UTF-8 and binary attachments use exact indexed/opaque spans and an exact tail route", async () => {
  const { vault, thread } = tempVault({ budget: 2048 });
  const encoder = new TextEncoder();
  // Repeated vocabulary keeps the exact text source within the admitted name
  // cardinality while still crossing multiple UTF-8 manifest chunks.
  const text = "archive line — café naïve dragon 🐉\n".repeat(10_000);
  const textBytes = encoder.encode(text);
  expect(textBytes.byteLength).toBeGreaterThan(200_000);
  const binaryBytes = Uint8Array.from({ length: 96_000 }, (_, i) => (i % 3 === 0 ? 0xff : i % 251));
  const textEpisode = vault.episodes.append(thread.id, {
    role: "attachment",
    // The manifest may label a span indexed only when these exact bytes are
    // present in the episode FTS row.  The filename remains metadata, while
    // this fixture models a fully extracted text attachment.
    content: text,
    blob: { bytes: textBytes, mime: "text/plain", name: "long.txt" },
  });
  const binaryEpisode = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "payload.bin",
    blob: { bytes: binaryBytes, mime: "application/octet-stream", name: "payload.bin" },
  });

  const textMeta = textEpisode.meta as Record<string, unknown>;
  const binaryMeta = binaryEpisode.meta as Record<string, unknown>;
  const textManifest = textMeta.manifest as Record<string, unknown>;
  const binaryManifest = binaryMeta.manifest as Record<string, unknown>;
  expect(textManifest.hash).toBe(core.sha256(textBytes));
  expect(textManifest.size).toBe(textBytes.byteLength);
  expect(binaryManifest.hash).toBe(core.sha256(binaryBytes));
  expect(binaryManifest.size).toBe(binaryBytes.byteLength);

  const textSpans = textManifest.spans as Array<Record<string, unknown>>;
  const binarySpans = binaryManifest.spans as Array<Record<string, unknown>>;
  expect(textSpans.length).toBeGreaterThan(1);
  expect(binarySpans.length).toBeGreaterThan(1);
  expect(textSpans[0]?.from).toBe(0);
  expect(textSpans.at(-1)?.to).toBe(textBytes.byteLength);
  expect(binarySpans[0]?.from).toBe(0);
  expect(binarySpans.at(-1)?.to).toBe(binaryBytes.byteLength);
  expect(textSpans.every((span) => span.state === "indexed")).toBe(true);
  expect(binarySpans.every((span) => span.state === "opaque")).toBe(true);
  for (const span of textSpans) {
    const from = Number(span.from);
    const to = Number(span.to);
    expect(to).toBeGreaterThan(from);
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(textBytes.subarray(from, to)),
    ).not.toThrow();
    expect(span.hash).toBe(core.sha256(textBytes.subarray(from, to)));
  }
  for (const span of binarySpans) {
    const from = Number(span.from);
    const to = Number(span.to);
    expect(span.hash).toBe(core.sha256(binaryBytes.subarray(from, to)));
  }

  const attachmentPacket = core.compile(vault, thread.id, { query: "", budget: 2048 });
  const attachmentReceipt = reachability(attachmentPacket);
  assertAttachmentCoverage(attachmentReceipt, textEpisode.seq, textManifest);
  assertAttachmentCoverage(attachmentReceipt, binaryEpisode.seq, binaryManifest);
  expect(verifyReachability(vault, thread.id, attachmentPacket).ok).toBe(true);
  const blobStore = vault.blobs as unknown as {
    get: (hash: string) => Uint8Array | null;
  };
  const originalGet = blobStore.get;
  const wholeTextHash = String(textManifest.hash);
  blobStore.get = (hash) => {
    if (hash === wholeTextHash) throw new Error("reachability verifier loaded a whole attachment object");
    return originalGet(hash);
  };
  try {
    expect(verifyReachability(vault, thread.id, attachmentPacket).ok).toBe(true);
  } finally {
    blobStore.get = originalGet;
  }

  const textQuestion = vault.episodes.append(thread.id, {
    role: "user",
    content: "What are the last lines of long.txt?",
  });
  const textPacket = core.compile(vault, thread.id, {
    turnSeq: textQuestion.seq,
    query: textQuestion.content,
    budget: 2048,
  });
  const textTail = textPacket.pages.find(
    (page) => (page as unknown as Record<string, unknown>).trigger === "attachment-tail",
  );
  expect(textTail).toBeDefined();
  expect(textTail?.resolved).toBe(true);
  const textTailMeta = textTail as unknown as Record<string, unknown>;
  expect(textTailMeta.manifest).toBeDefined();
  expect(textTailMeta.spanHash).toMatch(/^[0-9a-f]{64}$/);
  expect(textTailMeta.encoding).toBe("utf-8");
  expect(textTailMeta.byteRange).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
  const textRange = textTailMeta.byteRange as [number, number];
  expect(packetText(textPacket)).toContain(
    new TextDecoder().decode(textBytes.subarray(textRange[0], textRange[1])),
  );
  expect(verifyReachability(vault, thread.id, textPacket).ok).toBe(true);

  const binaryQuestion = vault.episodes.append(thread.id, {
    role: "user",
    content: "Show the tail of payload.bin.",
  });
  const binaryPacket = core.compile(vault, thread.id, {
    turnSeq: binaryQuestion.seq,
    query: binaryQuestion.content,
    budget: 2048,
  });
  const binaryTail = binaryPacket.pages.find(
    (page) => (page as unknown as Record<string, unknown>).trigger === "attachment-tail",
  );
  expect(binaryTail).toBeDefined();
  expect(binaryTail?.resolved).toBe(true);
  const binaryTailMeta = binaryTail as unknown as Record<string, unknown>;
  expect(binaryTailMeta.opaque).toBe(true);
  expect(binaryTailMeta.spanHash).toMatch(/^[0-9a-f]{64}$/);
  expect(packetText(binaryPacket)).not.toContain("�");
  expect(verifyReachability(vault, thread.id, binaryPacket).ok).toBe(true);
  // These packets are reachability fixtures, not completed assistant turns.
  // Keep them pending so stored-packet verification does not require the
  // answer receipt that a real gateway turn binds when it closes.
  vault.packets.insert(attachmentPacket, "pending");
  vault.packets.insert(textPacket, "pending");
  vault.packets.insert(binaryPacket, "pending");

  const importedVault = tempVault({ budget: 2048 }).vault;
  const bundle = await core.exportBundle(vault, thread.id, { passphrase: "reachability-streaming" });
  const imported = await core.importBundle(importedVault, bundle, { passphrase: "reachability-streaming" });
  const importedPacket = importedVault.packets.get(imported.threadId, binaryPacket.turnSeq);
  expect(importedPacket).not.toBeNull();
  const importedText = importedVault.episodes.get(imported.threadId, textEpisode.seq);
  const importedHash = String(importedText?.meta.blob);
  const importedStore = importedVault.blobs as unknown as {
    get: (hash: string) => Uint8Array | null;
  };
  const importedGet = importedStore.get;
  importedStore.get = (hash) => {
    if (hash === importedHash) throw new Error("imported verifier loaded a whole attachment object");
    return importedGet(hash);
  };
  try {
    expect(verifyReachability(importedVault, imported.threadId, importedPacket).ok).toBe(true);
  } finally {
    importedStore.get = importedGet;
  }
});

test(
  "thousands of multi-span attachments keep the compile-time receipt bounded",
  () => {
    const { vault, thread } = tempVault({ budget: 1024 });
    const attachmentCount = 1_024;
    const objectSize = 65_537;
    const template = new Uint8Array(objectSize);
    for (let i = 0; i < attachmentCount; i += 1) {
      const bytes = template.slice();
      bytes[0] = i & 0xff;
      bytes[1] = (i >>> 8) & 0xff;
      bytes[2] = (i >>> 16) & 0xff;
      vault.episodes.append(thread.id, {
        role: "attachment",
        content: `attachment-${i}.bin`,
        blob: { bytes, mime: "application/octet-stream", name: `attachment-${i}.bin` },
      });
    }

    const packet = core.compile(vault, thread.id, { query: "", budget: 1024 });
    const spans = reachability(packet);
    expect(verifyReachability(vault, thread.id, packet).ok).toBe(true);
    const ranges = spans.filter(
      (span): span is AttachmentRangeReachabilitySpan => span.kind === "attachment-range",
    );
    expect(ranges.length).toBeGreaterThan(0);
    for (const seq of [1, Math.floor(attachmentCount / 2), attachmentCount]) {
      expect(ranges.some((range) => coversAttachment(range, seq))).toBe(true);
    }
    // Each attachment has two 64 KiB manifest spans.  The packet may retain a
    // bounded resident tail, but it must not enumerate both chunks for every
    // attachment during compile.
    expect(spans.length).toBeLessThanOrEqual(attachmentCount + 64);
  },
  { timeout: 30_000 },
);

test("attachment envelope compilation does not aggregate attachment history", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const bytes = Uint8Array.from([0x70, 0x79, 0x6c, 0x6f, 0x73]);
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 600 }, (_, index) => ({
      role: "attachment" as const,
      content: `attachment-${index}.bin`,
      blob: { bytes, mime: "application/octet-stream", name: `attachment-${index}.bin` },
    })),
  );

  const db = vault.db as unknown as {
    query: (sql: string) => { get: (...params: unknown[]) => unknown };
  };
  const originalQuery = db.query;
  let aggregateQueries = 0;
  let boundaryQueries = 0;
  db.query = ((sql: string) => {
    if (/MIN\(seq\).*MAX\(seq\).*COUNT\(\*\)/iu.test(sql.replace(/\s+/gu, " "))) {
      aggregateQueries += 1;
    }
    if (/SELECT seq FROM episode .*ORDER BY seq (?:ASC|DESC) LIMIT 1/iu.test(sql.replace(/\s+/gu, " "))) {
      boundaryQueries += 1;
    }
    return originalQuery.call(vault.db, sql);
  }) as typeof db.query;
  let packet: ReturnType<typeof core.compile>;
  try {
    packet = core.compile(vault, thread.id, { query: "", budget: 1024 });
  } finally {
    db.query = originalQuery;
  }
  expect(aggregateQueries).toBe(0);
  // Rendering may rebuild the bounded receipt while trimming, but every
  // rebuild performs two indexed single-row probes rather than one history
  // aggregate or materialized attachment list.
  expect(boundaryQueries).toBeGreaterThan(0);
  expect(boundaryQueries).toBeLessThanOrEqual(128);
  const verification = verifyReachability(vault, thread.id, packet);
  expect(verification.ok).toBe(true);
  const plan = vault.db
    .query(
      "EXPLAIN QUERY PLAN SELECT seq FROM episode INDEXED BY episode_active_attachment_seq " +
        "WHERE thread_id = ? AND role = 'attachment' " +
        "AND seq <= ? AND COALESCE(json_extract(meta, '$.removed'), 0) != 1 ORDER BY seq ASC LIMIT 1",
    )
    .all(thread.id, 600) as Array<{ detail: string }>;
  expect(plan.some((row) => /episode_active_attachment_seq/iu.test(row.detail))).toBe(true);
});

test("stored sparse attachment envelopes verify and survive full bundle import", async () => {
  const { vault, thread } = tempVault({ budget: 2048 });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 9 }, (_, index) => ({ role: "user" as const, content: `prefix ${index}` })),
  );
  const first = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "first.bin",
    blob: { bytes: Uint8Array.from([1, 2, 3]), name: "first.bin" },
  });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 39 }, (_, index) => ({ role: "user" as const, content: `middle ${index}` })),
  );
  const last = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "last.bin",
    blob: { bytes: Uint8Array.from([4, 5, 6]), name: "last.bin" },
  });
  const query = vault.episodes.append(thread.id, { role: "user", content: "Verify both sparse files." });
  expect(first.seq).toBe(10);
  expect(last.seq).toBe(50);
  const packet = core.compile(vault, thread.id, {
    turnSeq: query.seq,
    query: query.content,
    budget: 2048,
  });
  const envelope = reachability(packet).find(
    (span): span is AttachmentRangeReachabilitySpan => span.kind === "attachment-range",
  );
  expect(envelope?.fromSeq).toBe(10);
  expect(envelope?.toSeq).toBe(50);
  vault.packets.insert(packet);
  vault.db.query("UPDATE packet SET compiler_version = '1' WHERE id = ?").run(packet.id);
  const verified = core.verify(vault, thread.id, { full: true });
  expect(verified.ok, verified.reason).toBe(true);

  const bundle = await core.exportBundle(vault, thread.id, { passphrase: "sparse-envelope" });
  const target = tempVault({ budget: 2048 }).vault;
  const imported = await core.importBundle(target, bundle, { passphrase: "sparse-envelope" });
  expect(core.verify(target, imported.threadId, { full: true }).ok).toBe(true);
});

test("a missing or corrupt non-tail attachment span fails the closure verifier", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const bytes = Uint8Array.from({ length: 2 * 65_536 + 17 }, (_, index) => (index * 29 + 7) & 0xff);
  const episode = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "chunked.bin",
    blob: { bytes, mime: "application/octet-stream", name: "chunked.bin" },
  });
  const manifest = episode.meta.manifest;
  expect(manifest).toBeDefined();
  expect(manifest?.spans.length ?? 0).toBeGreaterThan(2);
  const packet = core.compile(vault, thread.id, { query: "", budget: 1024 });
  expect(core.verifyReachability(vault, thread.id, packet).ok).toBe(true);

  const nonTail = manifest?.spans[0];
  expect(nonTail).toBeDefined();
  const objectPath = join(vault.objectsDir, nonTail?.objectHash ?? "");
  rmSync(objectPath);
  expect(core.readAttachmentSpan(vault, thread.id, episode.seq, nonTail?.ordinal ?? 0)).toBeNull();
  expect(core.verifyReachability(vault, thread.id, packet).ok).toBe(false);

  const replacement = bytes.subarray(nonTail?.from ?? 0, nonTail?.to ?? 0).slice();
  replacement[0] = (replacement[0] ?? 0) ^ 0xff;
  writeFileSync(objectPath, replacement, { mode: 0o600 });
  expect(core.readAttachmentSpan(vault, thread.id, episode.seq, nonTail?.ordinal ?? 0)).toBeNull();
  expect(core.verifyReachability(vault, thread.id, packet).ok).toBe(false);
  // The intact whole-object pointer is not enough to authorize the missing or
  // corrupt span: the check above must inspect the content-addressed chunk.
  expect(vault.blobs.get(String(manifest?.hash))).toEqual(bytes);
});

test("duplicate attachment hashes use a bounded snapshot source lookup", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const bytes = new TextEncoder().encode("shared duplicate attachment bytes");
  const duplicateCount = 260;
  const first = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "",
    blob: { bytes, mime: "text/plain", name: "shared-0.txt" },
  });
  // Keep one unrelated attachment in a narrow attachment-range so the shared
  // hash witnesses remain explicit without making every duplicate double
  // covered by that range.
  vault.episodes.append(thread.id, {
    role: "attachment",
    content: "",
    blob: {
      bytes: new TextEncoder().encode("unrelated attachment bytes"),
      mime: "text/plain",
      name: "unrelated.txt",
    },
  });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: duplicateCount - 1 }, (_, index) => ({
      role: "attachment" as const,
      content: "",
      blob: { bytes, mime: "text/plain", name: `shared-${index + 1}.txt` },
    })),
  );
  const headSeq = vault.threads.get(thread.id)?.headSeq ?? 0;
  const manifest = first.meta.manifest;
  expect(manifest).toBeDefined();
  if (manifest === undefined) return;
  const source = `blob:${manifest.hash}`;
  const explicit = {
    kind: "attachment" as const,
    source,
    from: 0,
    to: bytes.byteLength,
    hash: core.sha256(bytes),
    state: "pageable" as const,
    locator: { source, from: 0, to: bytes.byteLength, hash: core.sha256(bytes) },
    manifest: manifest.id,
  };
  const attachmentRange = {
    kind: "attachment-range" as const,
    fromSeq: 2,
    toSeq: 2,
    state: "pageable" as const,
    locatorTemplate: "attachment:{seq}" as const,
    digest: core.canonicalHash({
      threadId: thread.id,
      fromSeq: 2,
      toSeq: 2,
      count: 1,
      asOfSeq: headSeq,
    }),
  };
  const packet = {
    reachability: [explicit, attachmentRange],
    reachabilityAsOfSeq: headSeq,
    resident: [],
  };

  const db = vault.db as unknown as {
    query: (sql: string, ...args: unknown[]) => unknown;
  };
  const originalQuery = db.query;
  const stats = { rows: 0, allCalls: 0 };
  const sourceSql = /FROM episode WHERE thread_id = \? AND seq <= \? AND role = 'attachment'/u;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (!sourceSql.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "all" || property === "get") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, receiver) as (...values: unknown[]) => unknown;
            const value = method.apply(target, parameters);
            if (property === "all") {
              stats.allCalls += 1;
              stats.rows += Array.isArray(value) ? value.length : 0;
            }
            return value;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }) as typeof db.query;
  try {
    const verification = core.verifyReachability(vault, thread.id, packet);
    expect(verification.ok).toBe(true);
  } finally {
    db.query = originalQuery;
  }
  // The source probe must stop at the first active witness.  It may not
  // materialize every duplicate row merely because they share one hash.
  expect(stats.allCalls).toBe(0);
  expect(stats.rows).toBe(0);
});
