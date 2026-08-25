import { afterAll, expect, test } from "bun:test";
import type { AnswerReceipt, ChatMessage, EvidenceCapability, Packet } from "@pylos/protocol";
import { MAX_ADDRESS_ROUTE_ITEMS, MAX_ADDRESS_ROUTE_JSON_BYTES } from "@pylos/protocol";
import {
  addressRouteDigestOf,
  addressRouteRowBoundsFailure,
  answerReceiptDigestOf,
  atomize,
  canonicalAddressQuery,
  canonicalHash,
  claimScanDigestOf,
  compact,
  compile,
  exportBundle,
  forget,
  importBundle,
  invalidateAddressRoute,
  type Provider,
  packetText,
  recordAddressRouteFromReceipt,
  runTurn,
  scanRememberedClaims,
  sha256,
  type Vault,
  verify,
  witnessForEpisode,
} from "../src/index.ts";
import { cleanup, rng, syntheticTurn, tempVault } from "./helpers.ts";

afterAll(cleanup);

type Row = Record<string, unknown>;

/**
 * A15 is deliberately an archive contract.  Keeping these reads in the oracle
 * means a route cannot be made to look correct by a mutable in-memory cache.
 * The aliases below tolerate the two natural SQLite spellings while keeping
 * the asserted values exact.
 */
function addressRows(vault: Vault, threadId: string): Row[] {
  return vault.db
    .query("SELECT * FROM address_route WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Row[];
}

function aliasRows(vault: Vault, threadId: string): Row[] {
  return vault.db
    .query("SELECT * FROM address_alias WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Row[];
}

function first(row: Row, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }
  return undefined;
}

function queryDigest(row: Row): string {
  return String(first(row, "query_digest", "queryDigest", "digest"));
}

function routeStatus(row: Row): string {
  return String(first(row, "status", "state", "validity") ?? "active").toLowerCase();
}

function routeReason(row: Row): string {
  return String(
    first(row, "reason", "invalidation_reason", "invalidationReason", "event") ?? "",
  ).toLowerCase();
}

function routeSeqs(row: Row): number[] {
  const raw = first(row, "source_seqs", "sourceSeqs", "seqs", "witnesses", "source_seq", "sourceSeq");
  if (typeof raw === "number") return [raw];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      if (typeof item === "number") return [item];
      if (typeof item === "object" && item !== null) {
        const seq = first(item as Row, "seq", "source_seq", "sourceSeq");
        return typeof seq === "number" ? [seq] : [];
      }
      return [];
    });
  }
  if (typeof raw === "object" && raw !== null) {
    const seq = first(raw as Row, "seq", "source_seq", "sourceSeq");
    return typeof seq === "number" ? [seq] : [];
  }
  if (typeof raw === "string") {
    try {
      return routeSeqs({ witnesses: JSON.parse(raw) });
    } catch {
      const seq = Number(raw);
      return Number.isInteger(seq) ? [seq] : [];
    }
  }
  return [];
}

function tokenFromRequest(request: unknown): string {
  if (request !== null && typeof request === "object") {
    const evidence = (request as { evidence?: EvidenceCapability[] }).evidence;
    const direct = evidence?.find((capability) => typeof capability.token === "string")?.token;
    if (direct !== undefined) return direct;
    const messages = (request as { messages?: ChatMessage[] }).messages;
    if (Array.isArray(messages)) return tokenFromText(messages.map((message) => message.content).join("\n"));
  }
  return tokenFromText(JSON.stringify(request));
}

function tokenFromText(text: string): string {
  const candidates = text.match(/[A-Za-z0-9_:-]{16,}/g) ?? [];
  const preferred = candidates.find(
    (candidate) =>
      /cap|evidence|witness/i.test(candidate) && !/^(?:capability|evidence|witness)$/i.test(candidate),
  );
  if (preferred !== undefined) return preferred;
  const fallback = candidates.find((candidate) => !/^[a-f0-9]{64}$/i.test(candidate));
  if (fallback !== undefined) return fallback;
  throw new Error("the provider packet did not expose an evidence capability");
}

function groundedProvider(text: string): Provider {
  return async function* (request) {
    yield { type: "delta", text };
    yield {
      type: "tool_call",
      id: "address-claim-map",
      name: "submit_claim_map",
      arguments: JSON.stringify({
        claims: [{ outputSpan: [0, text.length], capabilityTokens: [tokenFromRequest(request)] }],
      }),
    };
    yield { type: "done" };
  };
}

function locationGroundedProvider(text: string): Provider {
  return async function* (request) {
    yield { type: "delta", text };
    const capability = request.evidence?.find((candidate) => candidate.byteRange[0] === 0);
    if (capability === undefined) throw new Error("the provider packet did not expose the location span");
    yield {
      type: "tool_call",
      id: "address-location-claim-map",
      name: "submit_claim_map",
      arguments: JSON.stringify({
        claims: [{ outputSpan: [0, text.length], capabilityTokens: [capability.token] }],
      }),
    };
    yield { type: "done" };
  };
}

async function ground(
  vault: ReturnType<typeof tempVault>["vault"],
  threadId: string,
  question: string,
  answer: string,
) {
  return runTurn(vault, threadId, {
    text: question,
    model: "oracle-model",
    provider: groundedProvider(answer),
    budget: 8192,
  });
}

function seedLostSource(content: string, seed = 101) {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, { role: "user", content });
  // Production turns atomize every user episode before compaction.  Keep this
  // fixture on that same path so a one-term refer-back can reach the current
  // certificate rather than relying on a non-authoritative capsule line.
  atomize(vault, thread.id, [source.seq]);
  const next = rng(seed);
  for (let i = 0; i < 360; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  compact(vault, thread.id, { budget: 8192 });
  return { vault, thread, source };
}

function routeFor(rows: Row[], digest: string): Row[] {
  return rows.filter((row) => queryDigest(row) === digest);
}

function activeSeqSet(rows: Row[]): number[] {
  // A15 invalidations are append-only event rows. The original edge remains
  // `status='active'`, so the oracle resolves effective activity through the
  // event's `invalidated_by` pointer instead of treating status alone as live.
  const closed = new Set(
    rows
      .filter((row) => ["invalidated", "superseded", "revoked"].includes(routeStatus(row)))
      .map((row) => first(row, "invalidated_by", "invalidatedBy"))
      .filter((id): id is string => typeof id === "string"),
  );
  return [
    ...new Set(
      rows
        .filter((row) => routeStatus(row) === "active" && !closed.has(String(first(row, "id"))))
        .flatMap(routeSeqs),
    ),
  ].sort((a, b) => a - b);
}

function expectInvalidation(rows: Row[], digest: string, reason: RegExp): void {
  const invalidated = routeFor(rows, digest).filter((row) =>
    ["invalidated", "superseded", "revoked"].includes(routeStatus(row)),
  );
  expect(invalidated.length).toBeGreaterThan(0);
  expect(invalidated.some((row) => reason.test(routeReason(row)))).toBe(true);
}

test("A15.1 canonicalizes query identity and does not create a second edge for case or spacing", async () => {
  const line = "Aster Logistics approved the cobalt route for 417 units on 2026-07-11.";
  const { vault, thread, source } = seedLostSource(line);
  const firstTurn = await ground(vault, thread.id, "What route did Aster Logistics approve?", line);
  const rowsAfterFirst = addressRows(vault, thread.id);
  expect(rowsAfterFirst.length).toBeGreaterThan(0);

  const firstDigest = queryDigest(rowsAfterFirst[0] as Row);
  expect(firstDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(activeSeqSet(routeFor(rowsAfterFirst, firstDigest))).toContain(source.seq);
  expect(
    firstTurn.assistantEpisode.meta.addressReceipt ?? firstTurn.assistantEpisode.meta.answerReceipt,
  ).toBeDefined();

  await ground(vault, thread.id, "  WHAT   ROUTE DID ASTER LOGISTICS APPROVE? ", line);
  await ground(vault, thread.id, "What\u00a0route did Aster Logistics approve?", line);
  const rowsAfterEquivalent = addressRows(vault, thread.id);
  const digests = [...new Set(rowsAfterEquivalent.map(queryDigest))];
  expect(digests).toEqual([firstDigest]);
  expect(activeSeqSet(routeFor(rowsAfterEquivalent, firstDigest))).toEqual([source.seq]);
});

test("A15.1 reuses the same ordered witnesses after unrelated turns and new lexical hits", async () => {
  const line = "The amber ferry left Skagen at 06:40 with manifest 77A.";
  const { vault, thread, source } = seedLostSource(line, 102);
  await ground(vault, thread.id, "When did the amber ferry leave?", line);
  const before = addressRows(vault, thread.id);
  const digest = queryDigest(before[0] as Row);
  const expected = activeSeqSet(routeFor(before, digest));

  // These turns deliberately introduce stronger lexical hits for the same
  // words.  An active address edge must win over mutable ranking.
  vault.episodes.append(thread.id, {
    role: "user",
    content: "A later harbor note mentions the amber ferry and a different manifest 88B at 08:15.",
  });
  for (let i = 0; i < 220; i += 1) {
    vault.episodes.append(thread.id, {
      role: "user",
      content: `Unrelated dock report ${i} about a ferry schedule.`,
    });
  }
  compact(vault, thread.id, { budget: 8192 });
  const repeated = await ground(vault, thread.id, "When did the amber ferry leave?", line);
  const after = addressRows(vault, thread.id);
  expect(activeSeqSet(routeFor(after, digest))).toEqual(expected);
  expect(expected).toEqual([source.seq]);
  expect(repeated.pages.filter((page) => page.resolved).flatMap((page) => page.seqs)).not.toContain(
    source.seq + 1,
  );
});

test("A15.1 correction appends a new edge and explicitly invalidates the old witness", async () => {
  const { vault, thread, source } = seedLostSource("I live in Lisbon.", 103);
  await ground(vault, thread.id, "Where do I live?", "I live in Lisbon.");
  const firstRows = addressRows(vault, thread.id);
  const digest = queryDigest(firstRows[0] as Row);
  expect(activeSeqSet(routeFor(firstRows, digest))).toContain(source.seq);

  const correction = vault.episodes.append(thread.id, {
    role: "user",
    content: "Correction: I moved to Porto.",
  });
  atomize(vault, thread.id, [correction.seq]);
  await ground(vault, thread.id, "Where do I live?", "I moved to Porto.");
  const rows = addressRows(vault, thread.id);
  expectInvalidation(rows, digest, /revision|correction|authority|supersed/);
  expect(activeSeqSet(routeFor(rows, digest))).toContain(correction.seq);
  expect(activeSeqSet(routeFor(rows, digest))).not.toContain(source.seq);
});

test("A15.1 correction does not reuse a route whose location witness shares an episode with identity", async () => {
  const { vault, thread, source } = seedLostSource("I live in Lisbon. My name is Alice.", 113);
  const firstTurn = await runTurn(vault, thread.id, {
    text: "Where do I live?",
    model: "oracle-model",
    provider: locationGroundedProvider("I live in Lisbon."),
    budget: 8192,
  });
  expect(firstTurn.assistantEpisode.meta.answerReceipt?.status).toBe("released");

  const firstRows = addressRows(vault, thread.id);
  const firstRoute = firstRows.find((row) => routeStatus(row) === "active");
  expect(firstRoute).toBeDefined();
  if (firstRoute === undefined) return;
  const digest = queryDigest(firstRoute);
  const locationAtom = vault.atoms.byKey(thread.id, "user.location", "SUPPORTED")[0];
  const identityAtom = vault.atoms.byKey(thread.id, "identity.name", "SUPPORTED")[0];
  expect(locationAtom?.sourceSeq).toBe(source.seq);
  expect(identityAtom?.sourceSeq).toBe(source.seq);
  const firstWitnesses = JSON.parse(String(first(firstRoute, "witnesses") ?? "[]")) as Array<{
    revision?: string;
  }>;
  expect(firstWitnesses.some((witness) => witness.revision === locationAtom?.id)).toBe(true);
  expect(firstWitnesses.some((witness) => witness.revision === identityAtom?.id)).toBe(false);

  const correction = vault.episodes.append(thread.id, { role: "user", content: "I live in Porto." });
  atomize(vault, thread.id, [correction.seq]);
  const packet = compile(vault, thread.id, {
    query: "Where do I live?",
    turnSeq: (vault.threads.get(thread.id)?.headSeq ?? 0) + 1,
    budget: 8192,
  });

  const rows = addressRows(vault, thread.id);
  expectInvalidation(rows, digest, /revision|correction|supersed|stale/);
  expect(activeSeqSet(routeFor(rows, digest))).not.toContain(source.seq);
  expect(packet.pages.filter((page) => page.resolved).flatMap((page) => page.seqs)).not.toContain(source.seq);
});

test("A15.1 deletion invalidates a route explicitly and never serves the removed source", async () => {
  const line = "The sealed archive key is Zephyrine 998877.";
  const { vault, thread, source } = seedLostSource(line, 104);
  await ground(vault, thread.id, "What is the sealed archive key?", line);
  const before = addressRows(vault, thread.id);
  const digest = queryDigest(before[0] as Row);
  expect(activeSeqSet(routeFor(before, digest))).toContain(source.seq);
  const alias = vault.aliases.propose(thread.id, {
    alias: "sealed archive key",
    sourceSeq: source.seq,
    quote: line,
    span: [0, Buffer.byteLength(line, "utf8")],
    sourceHash: sha256(line),
  });
  expect(alias.accepted).toBe(true);

  forget(vault, thread.id, { seqs: [source.seq], reason: "address oracle" });
  const next = compile(vault, thread.id, {
    query: "What is the sealed archive key?",
    turnSeq: (vault.threads.get(thread.id)?.headSeq ?? 0) + 1,
    budget: 8192,
  });
  const rows = addressRows(vault, thread.id);
  expectInvalidation(rows, digest, /delet|forget|remov|tombston/);
  expect(activeSeqSet(routeFor(rows, digest))).not.toContain(source.seq);
  // `forget` preserves an assistant echo as a reportable episode (KERNEL
  // A10.6); the route/page must nevertheless no longer expose the removed
  // source.  Do not require redaction of the independent assistant episode.
  expect(next.pages.filter((page) => page.resolved).flatMap((page) => page.seqs)).not.toContain(source.seq);
  expect(aliasRows(vault, thread.id).find((row) => first(row, "id") === alias.id)?.status).toBe("revoked");
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("A15.1 source tampering produces an explicit hash invalidation, never a retarget", async () => {
  const line = "The dry-run budget is 73125 USD for the harbor migration.";
  const { vault, thread, source } = seedLostSource(line, 105);
  await ground(vault, thread.id, "What is the dry-run budget?", line);
  const before = addressRows(vault, thread.id);
  const digest = queryDigest(before[0] as Row);
  expect(activeSeqSet(routeFor(before, digest))).toContain(source.seq);

  // This simulates a corrupt object or an old buggy importer.  The hash-bound
  // edge must become an auditable invalidation; it may not point at a new row.
  vault.db
    .query("UPDATE episode SET content = ?, content_hash = ? WHERE thread_id = ? AND seq = ?")
    .run(
      "The dry-run budget is 99999 USD for the harbor migration.",
      sha256("The dry-run budget is 99999 USD for the harbor migration."),
      thread.id,
      source.seq,
    );
  compile(vault, thread.id, {
    query: "What is the dry-run budget?",
    turnSeq: (vault.threads.get(thread.id)?.headSeq ?? 0) + 1,
    budget: 8192,
  });
  const rows = addressRows(vault, thread.id);
  expectInvalidation(rows, digest, /hash|tamper|corrupt|invalid/);
  expect(activeSeqSet(routeFor(rows, digest))).not.toContain(source.seq + 1);
});

test("A15.1 router upgrade appends an explicit supersession instead of silently changing an edge", async () => {
  const line = "The north pier inspection passed on 2026-08-04.";
  const { vault, thread, source } = seedLostSource(line, 106);
  await ground(vault, thread.id, "Did the north pier inspection pass?", line);
  const before = addressRows(vault, thread.id);
  const digest = queryDigest(before[0] as Row);
  const oldRouter = first(before[0] as Row, "router_version", "routerVersion");
  expect(oldRouter).toBeDefined();

  compile(vault, thread.id, {
    query: "Did the north pier inspection pass?",
    turnSeq: (vault.threads.get(thread.id)?.headSeq ?? 0) + 1,
    budget: 8192,
    ...({ routerVersion: "a15-router-upgrade" } as { routerVersion: string }),
  });
  const rows = addressRows(vault, thread.id);
  expectInvalidation(rows, digest, /router|upgrade|supersed/);
  expect(activeSeqSet(routeFor(rows, digest))).not.toContain(source.seq);
  expect(
    new Set(routeFor(rows, digest).map((row) => first(row, "router_version", "routerVersion"))),
  ).toContain("a15-router-upgrade");
});

test("A15.1 invalidation appends an event and leaves the original edge byte-identical", () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "The immutable harbor witness is bound to source bytes.",
  });
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "What is the immutable harbor witness?",
  });
  const answer = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "The immutable harbor witness is bound to source bytes.",
  });
  const witness = witnessForEpisode(vault, thread.id, source.seq);
  expect(witness).toBeDefined();
  const packet = compile(vault, thread.id, {
    query: question.content,
    turnSeq: question.seq,
    budget: 8192,
  });
  vault.packets.insert(packet, "pending");
  const candidates = scanRememberedClaims(question.content, answer.content);
  const receiptBody = {
    answerDigest: sha256(answer.content),
    scanDigest: claimScanDigestOf(candidates),
    packetDigest: packet.digest,
    roundsDigest: sha256(""),
    grammarVersion: "a14-grammar-v1",
    candidates,
    classifications: candidates.map((candidate) => ({
      span: candidate.span,
      kind: candidate.kind,
      classification: "SUPPORTED" as const,
      witness: {
        source: `episode:${source.seq}`,
        from: 0,
        to: Buffer.byteLength(source.content, "utf8"),
        hash: sha256(source.content),
      },
      capabilityDigests: [sha256("direct-test-capability")],
    })),
    qualifications: [],
    status: "released" as const,
  };
  const receipt: AnswerReceipt = {
    ...receiptBody,
    digest: answerReceiptDigestOf({ ...receiptBody, digest: "0".repeat(64) }),
  };
  vault.packets.finish(packet.id, [], [], { answerReceipt: receipt });
  const written = recordAddressRouteFromReceipt(vault, {
    threadId: thread.id,
    query: question.content,
    routerVersion: "a15-test",
    questionSeq: question.seq,
    answerSeq: answer.seq,
    packetId: packet.id,
    packetDigest: packet.digest,
    receipt,
  });
  expect(written.accepted, written.reason).toBe(true);
  const original = written.route;
  expect(original).toBeDefined();
  const routeId = original?.id ?? "missing";
  const before = vault.db.query("SELECT * FROM address_route WHERE id = ?").get(routeId) as Row;
  const beforeBytes = JSON.stringify(before);

  const event = vault.addresses.invalidate(routeId, "source revised");
  expect(event?.status).toBe("invalidated");
  expect(event?.invalidatedBy).toBe(original?.id);
  expect(event?.routeDigest).not.toBe(original?.routeDigest);
  const after = vault.db.query("SELECT * FROM address_route WHERE id = ?").get(routeId) as Row;
  expect(JSON.stringify(after)).toBe(beforeBytes);
  expect(vault.addresses.active(thread.id, question.content)).toHaveLength(0);
  expect(
    vault.db
      .query("SELECT 1 FROM address_route WHERE invalidated_by = ? AND status != 'active'")
      .get(routeId),
  ).not.toBeNull();
});

test("A15.1 persists and reuses a grounded attachment-tail blob witness", () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode("header\nNAVY-42");
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    // The extracted episode text is the exact indexed prefix.  This fixture
    // intentionally proves a truthful indexed attachment witness; the opaque
    // case is covered separately below.
    content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    blob: { bytes, mime: "text/plain", name: "tail.txt" },
  });
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "What did the attached tail say?",
  });
  const answer = vault.episodes.append(thread.id, { role: "assistant", content: "NAVY-42" });
  const packet = compile(vault, thread.id, {
    query: question.content,
    turnSeq: question.seq,
    budget: 8192,
  });
  vault.packets.insert(packet, "pending");
  const candidates = scanRememberedClaims(question.content, answer.content);
  expect(candidates.length).toBeGreaterThan(0);
  const wholeHash = sha256(bytes);
  const tailFrom = Buffer.byteLength("header\n", "utf8");
  const spanHash = sha256(bytes.slice(tailFrom));
  const attachmentWitness = {
    source: `blob:${wholeHash}`,
    from: tailFrom,
    to: bytes.byteLength,
    hash: wholeHash,
    seq: attachment.seq,
    revision: attachment.hash,
    spanHash,
    authority: "attachment" as const,
    manifestId: attachment.meta.manifest?.id,
  };
  const receiptBody = {
    answerDigest: sha256(answer.content),
    scanDigest: claimScanDigestOf(candidates),
    packetDigest: packet.digest,
    roundsDigest: sha256(""),
    grammarVersion: "a14-grammar-v1",
    candidates,
    classifications: candidates.map((candidate) => ({
      span: candidate.span,
      kind: candidate.kind,
      classification: "SUPPORTED" as const,
      witness: attachmentWitness,
      evidenceWitness: attachmentWitness,
      capabilityDigests: [sha256("attachment-tail-capability")],
    })),
    qualifications: [],
    status: "released" as const,
  };
  const receipt: AnswerReceipt = {
    ...receiptBody,
    digest: answerReceiptDigestOf({ ...receiptBody, digest: "0".repeat(64) }),
  };
  vault.packets.finish(packet.id, [], [], { answerReceipt: receipt });
  const written = recordAddressRouteFromReceipt(vault, {
    threadId: thread.id,
    query: question.content,
    routerVersion: "a15-test",
    questionSeq: question.seq,
    answerSeq: answer.seq,
    packetId: packet.id,
    packetDigest: packet.digest,
    receipt,
  });
  expect(written.accepted, written.reason).toBe(true);
  expect(written.route?.witnesses[0]).toMatchObject({
    seq: attachment.seq,
    source: `blob:${wholeHash}`,
    contentHash: wholeHash,
    byteRange: [tailFrom, bytes.byteLength],
    authority: "attachment",
  });

  const reused = vault.addresses.reuse(thread.id, question.content, "a15-test");
  expect(reused.reused).toBe(true);
  expect(reused.route?.witnesses[0]?.source).toBe(`blob:${wholeHash}`);
  expect(vault.addresses.active(thread.id, question.content)).toHaveLength(1);
});

test("A15.1 route reuse is bounded under append-only replacement churn", async () => {
  const line = "The bounded route fixture lives in Oslo.";
  const { vault, thread } = seedLostSource(line, 114);
  const question = "Where does the bounded route fixture live?";
  await ground(vault, thread.id, question, line);
  const initial = addressRows(vault, thread.id).find((row) => routeStatus(row) === "active");
  expect(initial).toBeDefined();
  if (initial === undefined) return;
  const routerVersion = String(first(initial, "router_version", "routerVersion") ?? "a15-test");

  // Build a deliberately large append-only lineage without routing through the
  // public writer: this is a storage oracle for the lookup itself. Every old
  // active edge is closed by an immutable event, then replaced by one newer
  // active edge with the same canonical query. Only the final edge is current.
  const churn = 2_048;
  let parentId = String(first(initial, "id"));
  for (let index = 0; index < churn; index += 1) {
    const eventId = `address-stress-event-${index}`;
    const nextId = `address-stress-active-${index}`;
    const row = vault.db.query("SELECT * FROM address_route WHERE id = ?").get(parentId) as Row;
    expect(row).toBeDefined();
    vault.db
      .query(
        "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
          "SELECT ?, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest || ?, 'invalidated', 'stress replacement', ?, created_at + ? FROM address_route WHERE id = ?",
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
  expect(addressRows(vault, thread.id).length).toBeGreaterThan(churn);

  const stats = { calls: 0, rows: 0, maxRows: 0 };
  const db = vault.db as unknown as {
    query: (sql: string, ...args: unknown[]) => unknown;
  };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (!/\baddress_route\b/u.test(sql)) return statement;
    stats.calls += 1;
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all" || property === "get") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const value = method.apply(target, parameters);
            const count =
              property === "all" ? (Array.isArray(value) ? value.length : 0) : value === null ? 0 : 1;
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
    const reused = vault.addresses.reuse(thread.id, question, routerVersion);
    expect(reused.reused).toBe(true);
    expect(reused.route?.id).toBe(parentId);

    // Reuse and compile are separate bounded projections.  Capture the reuse
    // window before resetting the counters for the compile path; otherwise
    // the final assertions accidentally combine both operations and turn a
    // valid per-operation bound into a false history-size failure.
    const reuseStats = { calls: stats.calls, rows: stats.rows, maxRows: stats.maxRows };
    expect(reuseStats.maxRows).toBeLessThanOrEqual(64);
    expect(reuseStats.rows).toBeLessThanOrEqual(64);
    expect(reuseStats.calls).toBeLessThanOrEqual(8);

    // The actual turn-time page path performs its own before/after route
    // projections around reuse. They must observe the same bounded window,
    // rather than falling back to the full immutable lineage.
    stats.calls = 0;
    stats.rows = 0;
    stats.maxRows = 0;
    const packet = compile(vault, thread.id, {
      query: question,
      turnSeq: (vault.threads.get(thread.id)?.headSeq ?? 0) + 1,
      budget: 8192,
    });
    expect(packet.pages.some((page) => page.trigger === "address")).toBe(true);
    expect(stats.maxRows).toBeLessThanOrEqual(64);
    expect(stats.rows).toBeLessThanOrEqual(256);
    expect(stats.calls).toBeLessThanOrEqual(16);
  } finally {
    db.query = originalQuery;
  }
});

test("A15.1 receipt atom binding fails closed at the bounded source frontier", async () => {
  const line = "The bounded receipt fixture lives in Oslo.";
  const { vault, thread, source } = seedLostSource(line, 116);
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "Where does the bounded receipt fixture live?",
  });
  const answer = vault.episodes.append(thread.id, { role: "assistant", content: line });
  const atomCount = 600;
  for (let index = 0; index < atomCount; index += 1) {
    vault.db
      .query(
        "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
          "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
          "VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, ?, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'address-cap-oracle', ?)",
      )
      .run(
        `address-cap-atom-${index}`,
        thread.id,
        `address.cap.${index}`,
        "Oslo",
        "Oslo",
        source.seq,
        JSON.stringify([line.indexOf("Oslo"), line.length]),
        source.seq,
        index,
      );
  }

  const stats = { rows: 0, maxRows: 0 };
  const db = vault.db as unknown as {
    query: (sql: string, ...args: unknown[]) => unknown;
  };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    const normalizedSql = sql.replace(/\s+/gu, " ");
    if (
      !/SELECT rowid AS __rowid, id, key, value, text, source_span, phase, valid_from_seq, created_at FROM atom WHERE thread_id = \? AND source_seq = \? ORDER BY valid_from_seq DESC/u.test(
        normalizedSql,
      )
    ) {
      return statement;
    }
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
    const packet = compile(vault, thread.id, {
      query: question.content,
      turnSeq: question.seq,
      budget: 8192,
    });
    vault.packets.insert(packet, "pending");
    const candidates = scanRememberedClaims(question.content, answer.content);
    expect(candidates.length).toBeGreaterThan(0);
    const sourceBytes = new TextEncoder().encode(source.content);
    const locator = {
      source: `episode:${source.seq}`,
      from: 0,
      to: sourceBytes.byteLength,
      hash: sha256(sourceBytes),
    };
    const receiptBody = {
      answerDigest: sha256(answer.content),
      scanDigest: claimScanDigestOf(candidates),
      packetDigest: packet.digest,
      roundsDigest: sha256(""),
      grammarVersion: "a14-grammar-v1",
      candidates,
      classifications: candidates.map((candidate) => ({
        span: candidate.span,
        kind: candidate.kind,
        classification: "SUPPORTED" as const,
        witness: locator,
        capabilityDigests: [],
      })),
      qualifications: [],
      status: "released" as const,
    };
    const receipt: AnswerReceipt = {
      ...receiptBody,
      digest: answerReceiptDigestOf({ ...receiptBody, digest: "0".repeat(64) }),
    };
    vault.packets.finish(packet.id, [], [], { answerReceipt: receipt });
    const written = recordAddressRouteFromReceipt(vault, {
      threadId: thread.id,
      query: question.content,
      routerVersion: "a15-cap-oracle",
      questionSeq: question.seq,
      answerSeq: answer.seq,
      packetId: packet.id,
      packetDigest: packet.digest,
      receipt,
    });
    expect(written.accepted).toBe(false);
    expect(written.reason).toMatch(/stale|witness|atom/i);
  } finally {
    db.query = originalQuery;
  }
  expect(stats.maxRows).toBeLessThanOrEqual(513);
  expect(stats.rows).toBeLessThanOrEqual(513);
  expect(addressRows(vault, thread.id)).toHaveLength(0);
});

test("A15.1 imported opaque attachment routes fail closed in reuse and full verify", () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode("opaque-secret-tail");
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "opaque.bin",
    blob: { bytes, mime: "application/octet-stream", name: "opaque.bin" },
  });
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "What is in the opaque attachment?",
  });
  const answer = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "opaque-secret-tail",
  });
  const manifest = attachment.meta.manifest;
  expect(manifest).toBeDefined();
  if (manifest === undefined) return;
  const witness = {
    seq: attachment.seq,
    contentHash: manifest.hash,
    byteRange: [0, bytes.byteLength] as [number, number],
    authority: "attachment" as const,
    spanHash: sha256(bytes),
    source: `blob:${manifest.hash}`,
    manifestId: manifest.id,
    revision: attachment.hash,
  };
  const canonical = canonicalAddressQuery(question.content);
  const routerVersion = "a15-imported-opaque";
  const packet = compile(vault, thread.id, {
    query: question.content,
    turnSeq: question.seq,
    budget: 8192,
  });
  vault.packets.insert(packet, "pending");
  vault.packets.finish(packet.id, [], []);
  const id = "imported-opaque-route";
  vault.db
    .query(
      "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?)",
    )
    .run(
      id,
      thread.id,
      canonical.digest,
      canonical.normalized,
      routerVersion,
      question.seq,
      answer.seq,
      packet.id,
      packet.digest,
      JSON.stringify([witness.seq]),
      JSON.stringify([witness]),
      addressRouteDigestOf(canonical.digest, routerVersion, [witness]),
      Date.now(),
    );

  // An imported row may look structurally active, but its opaque range is not
  // an indexed answer witness. The integrity oracle and the reuse path must
  // agree and must not reinterpret the attachment label/content as evidence.
  expect(verify(vault, thread.id, { full: true }).ok).toBe(false);
  const reused = vault.addresses.reuse(thread.id, question.content, routerVersion);
  expect(reused.reused).toBe(false);
  expect(reused.invalidated.some((row) => /attachment|span|opaque|typed/i.test(row.reason ?? ""))).toBe(true);
  expect(vault.addresses.active(thread.id, question.content)).toHaveLength(0);
});

test("A15.1 pending and failed providers never create address edges", async () => {
  const pending = seedLostSource("The pending export destination is Oslo.", 107);
  let entered = false;
  let release!: () => void;
  const waitProvider: Provider = async function* () {
    entered = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    yield { type: "delta", text: "The pending export destination is Oslo." };
    yield { type: "done" };
  };
  const waiting = runTurn(pending.vault, pending.thread.id, {
    text: "Where is the pending export going?",
    model: "oracle-model",
    provider: waitProvider,
    budget: 8192,
    check: false,
  });
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(addressRows(pending.vault, pending.thread.id)).toHaveLength(0);
  release();
  await waiting;

  const failed = seedLostSource("The failed import source is Tartu.", 108);
  const broken: Provider = async function* () {
    yield { type: "error", message: "provider unavailable" };
  };
  await expect(
    runTurn(failed.vault, failed.thread.id, {
      text: "Where is the failed import source?",
      model: "oracle-model",
      provider: broken,
      budget: 8192,
      check: false,
    }),
  ).rejects.toThrow("provider unavailable");
  expect(addressRows(failed.vault, failed.thread.id)).toHaveLength(0);
});

test("A15.1 address routes and invalidations survive encrypted export/import", async () => {
  const line = "The recovery phrase is amber-lantern-42.";
  const { vault, thread, source } = seedLostSource(line, 109);
  await ground(vault, thread.id, "What is the recovery phrase?", line);
  const before = addressRows(vault, thread.id);
  expect(before.length).toBeGreaterThan(0);
  const expected = before.map((row) => ({
    digest: queryDigest(row),
    router: first(row, "router_version", "routerVersion"),
    status: routeStatus(row),
    reason: routeReason(row),
    seqs: routeSeqs(row),
  }));

  const bytes = await exportBundle(vault, thread.id, { passphrase: "address-oracle" });
  const target = tempVault();
  const imported = await importBundle(target.vault, bytes, { passphrase: "address-oracle" });
  const after = addressRows(target.vault, imported.threadId).map((row) => ({
    digest: queryDigest(row),
    router: first(row, "router_version", "routerVersion"),
    status: routeStatus(row),
    reason: routeReason(row),
    seqs: routeSeqs(row),
  }));
  expect(after).toEqual(expected);
  expect(after.flatMap((entry) => entry.seqs)).toContain(source.seq);
  expect(verify(target.vault, imported.threadId, { full: true }).ok).toBe(true);
});

test("A15.1 current route views close deleted-source lineage without rewriting history", async () => {
  const line = "The deleted-source access code is amber-lantern-episode-7.";
  const { vault, thread, source } = seedLostSource(line, 112);
  const question = "What is the deleted-source access code?";
  await ground(vault, thread.id, question, line);

  const before = vault.addresses.list(thread.id, question);
  const original = before.find((route) => route.status === "active");
  expect(original).toBeDefined();
  if (original === undefined) return;

  forget(vault, thread.id, { seqs: [source.seq], reason: "lineage oracle" });

  const current = vault.addresses.list(thread.id, question);
  const event = current.find((route) => route.invalidatedBy === original.id);
  const parent = current.find((route) => route.id === event?.invalidatedBy);
  expect(event?.status).toBe("invalidated");
  expect(event?.storedStatus).toBe("invalidated");
  expect(event?.effectiveStatus).toBe("invalidated");
  expect(parent?.storedStatus).toBe("active");
  expect(parent?.status).toBe("invalidated");
  expect(parent?.effectiveStatus).toBe("invalidated");
  expect(parent?.closedBy).toBe(event?.id);
  expect(parent?.witnesses.some((witness) => witness.seq === source.seq)).toBe(true);
  expect(parent?.asOfSeq).toBe(vault.threads.get(thread.id)?.headSeq);

  // The append-only parent remains exactly active in storage, but the public
  // projection cannot dereference it as a currently active tombstoned route.
  const stored = vault.db.query("SELECT status FROM address_route WHERE id = ?").get(original.id) as {
    status: string;
  };
  expect(stored.status).toBe("active");
});

test("A15.1 exact route lookup projects effective state without listing thread history", async () => {
  const { vault, thread, source } = seedLostSource("The exact route lookup code is amber-42.", 115);
  const question = "What is the exact route lookup code?";
  await ground(vault, thread.id, question, "The exact route lookup code is amber-42.");
  const route = vault.addresses.list(thread.id, question).find((candidate) => candidate.status === "active");
  expect(route).toBeDefined();
  if (route === undefined) return;

  const active = vault.addresses.get(thread.id, route.id);
  expect(active?.id).toBe(route.id);
  expect(active?.status).toBe("active");
  expect(active?.effectiveStatus).toBe("active");

  forget(vault, thread.id, { seqs: [source.seq], reason: "exact-id oracle" });
  const closed = vault.addresses.get(thread.id, route.id);
  expect(closed?.storedStatus).toBe("active");
  expect(closed?.status).toBe("invalidated");
  expect(closed?.effectiveStatus).toBe("invalidated");
  expect(closed?.closedBy).toBeDefined();

  const other = tempVault();
  expect(other.vault.addresses.get(other.thread.id, route.id)).toBeNull();
});

test("A15.1 bounded current projection never relabels a manually closed parent active", async () => {
  const { vault, thread } = seedLostSource("The manual closure code is amber-manual-42.", 116);
  const question = "What is the manual closure code?";
  await ground(vault, thread.id, question, "The manual closure code is amber-manual-42.");
  const route = vault.addresses.list(thread.id, question).find((candidate) => candidate.status === "active");
  expect(route).toBeDefined();
  if (route === undefined) return;
  const event = invalidateAddressRoute(vault, route.id, "manual closure oracle");
  expect(event?.status).toBe("invalidated");
  expect(vault.addresses.active(thread.id, question)).toHaveLength(0);
  const current = vault.addresses.current(thread.id, question);
  expect(current.length).toBeGreaterThan(0);
  expect(current.every((candidate) => candidate.effectiveStatus === "invalidated")).toBe(true);
  expect(current.some((candidate) => candidate.id === route.id && candidate.status === "active")).toBe(false);
});

test("A15.2 unavailable or incomplete semantic capability is an explicit receipt, never lexical relabeling", () => {
  const { vault, thread } = seedLostSource("The tea tasted smoky after the rain.", 110);
  const asking = vault.episodes.append(thread.id, {
    role: "user",
    content: "What flavor followed the storm?",
  });
  const packet = compile(vault, thread.id, {
    query: asking.content,
    turnSeq: asking.seq,
    budget: 8192,
    ...({ semantic: true } as { semantic: boolean }),
  }) as Packet & { receipts?: unknown; semantic?: unknown };
  const receiptText = JSON.stringify({
    pages: packet.pages,
    receipts: packet.receipts,
    semantic: packet.semantic,
  });
  expect(receiptText).toMatch(/semantic/i);
  expect(receiptText).toMatch(/unavailable|incomplete/i);
  expect(packet.pages.some((page) => page.trigger === ("semantic" as never) && page.resolved)).toBe(false);
  expect(packetText(packet.messages)).not.toContain("The tea tasted smoky after the rain.");
});

test("A15.2 a false semantic hit pays only the bounded exact-page cost and cannot become authority", () => {
  const { vault, thread } = seedLostSource("The tea tasted smoky after the rain.", 111);
  const falseSource = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "A model guessed that the tea tasted sweet before the storm.",
  });
  const asking = vault.episodes.append(thread.id, {
    role: "user",
    content: "What flavor followed the storm?",
  });
  const packet = compile(vault, thread.id, {
    query: asking.content,
    turnSeq: asking.seq,
    budget: 8192,
    ...({
      semanticHits: [
        {
          seq: falseSource.seq,
          span: [0, falseSource.content.length],
          hash: canonicalHash("wrong-source-hash"),
          distance: 0,
        },
      ],
    } as { semanticHits: unknown[] }),
  }) as Packet;
  const semanticPages = packet.pages.filter((page) => page.trigger === ("semantic" as never));
  expect(semanticPages).toHaveLength(1);
  expect(semanticPages[0]?.resolved).toBe(false);
  expect(semanticPages[0]?.seqs).toHaveLength(0);
  expect(semanticPages[0]?.tokens).toBeLessThanOrEqual(450);
  expect(
    vault.atoms.list(thread.id, { phase: "SUPPORTED" }).some((atom) => atom.sourceSeq === falseSource.seq),
  ).toBe(false);
  expect(addressRows(vault, thread.id)).toHaveLength(0);
});

test("A15.2 model aliases require string presence and remain address-only", () => {
  const sourceText = "The smoky flavor followed the rain.";
  const { vault, thread, source } = seedLostSource(sourceText, 112);
  const aliases = (
    vault as unknown as {
      aliases?: {
        propose: (
          threadId: string,
          input: Record<string, unknown>,
        ) => {
          accepted: boolean;
          reason?: string;
          id?: string;
        };
      };
    }
  ).aliases;
  expect(aliases).toBeDefined();
  const rejected = aliases?.propose(thread.id, {
    alias: "storm flavor",
    sourceSeq: source.seq,
    quote: "The moon was blue.",
    span: [0, 5],
    sourceHash: sha256(source.content),
  });
  expect(rejected?.accepted).toBe(false);
  expect(rejected?.reason).toMatch(/string|presence|quote/i);
  expect(aliasRows(vault, thread.id)).toHaveLength(0);

  const accepted = aliases?.propose(thread.id, {
    alias: "smoky flavor",
    sourceSeq: source.seq,
    quote: sourceText,
    span: [0, sourceText.length],
    sourceHash: sha256(source.content),
  });
  expect(accepted?.accepted).toBe(true);
  const rows = aliasRows(vault, thread.id);
  expect(rows).toHaveLength(1);
  expect(first(rows[0] as Row, "authority", "phase", "kind")).not.toMatch(/supported|user/i);
  expect(vault.atoms.byName(thread.id, "smoky flavor")).toHaveLength(0);
  expect(addressRows(vault, thread.id)).toHaveLength(0);

  const mutable = vault.episodes.append(thread.id, {
    role: "user",
    content: "prefix target suffix",
  });
  const mutableAlias = aliases?.propose(thread.id, {
    alias: "target",
    sourceSeq: mutable.seq,
    quote: "target",
    span: [7, 13],
    sourceHash: sha256(mutable.content),
  });
  expect(mutableAlias?.accepted).toBe(true);
  const mutableRow = vault.aliases.list(thread.id, "target")[0];
  expect(mutableRow?.id).toBe(mutableAlias?.id);
  vault.db
    .query("UPDATE episode SET content = ? WHERE thread_id = ? AND seq = ?")
    .run("prefix altered target suffix", thread.id, mutable.seq);
  expect(mutableRow).toBeDefined();
  if (mutableRow !== undefined) {
    const revalidated = vault.aliases.revalidate(mutableRow);
    expect(revalidated.valid).toBe(false);
    expect(revalidated.reason).toMatch(/hash|changed/i);
  }
});

test("A15.2 attachment aliases are bounded and reject opaque spans", () => {
  const { vault, thread } = tempVault();
  const indexedBytes = new TextEncoder().encode("indexed attachment text\n");
  const largeBytes = new Uint8Array(96 * 1024);
  largeBytes.set(indexedBytes);
  const large = vault.episodes.append(thread.id, {
    role: "attachment",
    content: new TextDecoder().decode(indexedBytes),
    blob: { bytes: largeBytes, mime: "text/plain", name: "large.txt" },
  });
  const oversized = vault.aliases.propose(thread.id, {
    alias: "oversized attachment quote",
    sourceSeq: large.seq,
    quote: new TextDecoder().decode(largeBytes.slice(0, 65 * 1024)),
    span: [0, 65 * 1024],
    sourceHash: sha256(largeBytes),
  });
  expect(oversized.accepted).toBe(false);
  expect(oversized.reason).toMatch(/bounded|span/i);

  const opaqueBytes = new TextEncoder().encode("opaque attachment bytes");
  const opaque = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "opaque.bin",
    blob: { bytes: opaqueBytes, mime: "application/octet-stream", name: "opaque.bin" },
  });
  const rejected = vault.aliases.propose(thread.id, {
    alias: "opaque attachment bytes",
    sourceSeq: opaque.seq,
    quote: new TextDecoder().decode(opaqueBytes),
    span: [0, opaqueBytes.byteLength],
    sourceHash: sha256(opaqueBytes),
  });
  expect(rejected.accepted).toBe(false);
  expect(rejected.reason).toMatch(/indexed|source|span/i);
  expect(aliasRows(vault, thread.id)).toHaveLength(0);
});

test("A15.2 accepted aliases survive export/import without becoming authority", async () => {
  const sourceText = "The harbor beacon is green at dawn.";
  const { vault, thread, source } = seedLostSource(sourceText, 113);
  const aliases = (
    vault as unknown as {
      aliases?: { propose: (threadId: string, input: Record<string, unknown>) => { accepted: boolean } };
    }
  ).aliases;
  expect(aliases).toBeDefined();
  expect(
    aliases?.propose(thread.id, {
      alias: "beacon green dawn",
      sourceSeq: source.seq,
      quote: sourceText,
      span: [0, sourceText.length],
      sourceHash: sha256(source.content),
    }).accepted,
  ).toBe(true);
  const bytes = await exportBundle(vault, thread.id, { passphrase: "alias-oracle" });
  const target = tempVault();
  const imported = await importBundle(target.vault, bytes, { passphrase: "alias-oracle" });
  const rows = aliasRows(target.vault, imported.threadId);
  expect(rows).toHaveLength(1);
  expect(first(rows[0] as Row, "alias", "text")).toBe("beacon green dawn");
  expect(target.vault.atoms.byName(imported.threadId, "beacon green dawn")).toHaveLength(0);
});

test("A15.1 imported oversized route rows fail closed before repeated-question expansion", () => {
  const { vault, thread, source } = seedLostSource("The bounded import route source is Oslo.", 117);
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "Where is the bounded import route source?",
  });
  const canonical = canonicalAddressQuery(question.content);
  const witnesses = Array.from({ length: MAX_ADDRESS_ROUTE_ITEMS + 1 }, () => ({
    seq: source.seq,
    contentHash: sha256(source.content),
    byteRange: [0, source.content.length] as [number, number],
    authority: "user" as const,
    source: `episode:${source.seq}`,
  }));
  const oversizedCount = {
    id: "imported-oversized-count-route",
    thread_id: thread.id,
    query_digest: canonical.digest,
    normalized_query: canonical.normalized,
    router_version: "imported",
    question_seq: question.seq,
    source_seqs: JSON.stringify(witnesses.map((witness) => witness.seq)),
    witnesses: JSON.stringify(witnesses),
    route_digest: "0".repeat(64),
    status: "active",
    created_at: Date.now(),
  };
  expect(addressRouteRowBoundsFailure(oversizedCount)).toMatch(/bounded count/i);

  const oversizedJson = {
    ...oversizedCount,
    id: "imported-oversized-json-route",
    source_seqs: JSON.stringify([source.seq]),
    witnesses: JSON.stringify([
      {
        ...witnesses[0],
        source: "x".repeat(MAX_ADDRESS_ROUTE_JSON_BYTES),
      },
    ]),
  };
  expect(addressRouteRowBoundsFailure(oversizedJson)).toMatch(/bounded size|row/i);

  // Simulate an already-installed legacy/import row to prove every read path
  // remains fail-closed even when the SQL write boundary is bypassed. The
  // count payload is below the byte cap, so this specifically exercises the
  // post-JSON.parse array-count oracle.
  vault.db
    .query(
      "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, source_seqs, witnesses, route_digest, status, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
    )
    .run(
      oversizedCount.id,
      thread.id,
      canonical.digest,
      canonical.normalized,
      oversizedCount.router_version,
      question.seq,
      oversizedCount.source_seqs,
      oversizedCount.witnesses,
      oversizedCount.route_digest,
      oversizedCount.created_at,
    );

  for (let attempt = 0; attempt < 128; attempt += 1) {
    expect(vault.addresses.current(thread.id, question.content)).toHaveLength(0);
    expect(vault.addresses.list(thread.id, question.content)).toHaveLength(0);
  }
  expect(vault.addresses.get(thread.id, oversizedCount.id)).toBeNull();
  expect(vault.addresses.reuse(thread.id, question.content, "imported").reused).toBe(false);
  const integrity = verify(vault, thread.id, { full: true });
  expect(integrity.ok).toBe(false);
  expect(integrity.reason).toMatch(/address route row is malformed/i);
});

test("A15.1 forget closes every high-churn route without retaining the event history", () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "The high-churn source lives in Oslo.",
  });
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "Where does the high-churn source live?",
  });
  const witness = witnessForEpisode(vault, thread.id, source.seq);
  if (witness === null) throw new Error("high-churn fixture witness was not resident");
  const canonical = canonicalAddressQuery(question.content);
  const routerVersion = "a15-delete-bound";
  const routeDigest = addressRouteDigestOf(canonical.digest, routerVersion, [witness]);
  const routeCount = 768;
  for (let index = 0; index < routeCount; index += 1) {
    vault.db
      .query(
        "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, " +
          "answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 'active', NULL, NULL, ?)",
      )
      .run(
        `high-churn-route-${index}`,
        thread.id,
        canonical.digest,
        canonical.normalized,
        routerVersion,
        question.seq,
        JSON.stringify([source.seq]),
        JSON.stringify([witness]),
        routeDigest,
        Date.now() + index,
      );
  }

  const stats = { batches: 0, rows: 0, maxRows: 0 };
  const db = vault.db as unknown as {
    query: (sql: string, ...args: unknown[]) => unknown;
  };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (!/\baddress_route\b/u.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const value = method.apply(target, parameters);
            const count = Array.isArray(value) ? value.length : 0;
            stats.batches += 1;
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
    const result = forget(vault, thread.id, { seqs: [source.seq], reason: "bounded delete oracle" });
    expect(result.episodes).toEqual([source.seq]);
  } finally {
    db.query = originalQuery;
  }

  expect(stats.batches).toBeGreaterThan(1);
  expect(stats.maxRows).toBeLessThanOrEqual(256);
  const counts = vault.db
    .query("SELECT status, COUNT(*) AS count FROM address_route WHERE thread_id = ? GROUP BY status")
    .all(thread.id) as Array<{ status: string; count: number }>;
  // The original edges are immutable audit history. Their stored status stays
  // active; the appended invalidation rows establish the effective closure.
  expect(counts.find((row) => row.status === "active")?.count ?? 0).toBe(routeCount);
  expect(counts.find((row) => row.status === "invalidated")?.count ?? 0).toBe(routeCount);
  const currentProjection = vault.addresses.current(thread.id, question.content);
  expect(currentProjection.length).toBeGreaterThan(0);
  expect(currentProjection.length).toBeLessThanOrEqual(256);
  expect(currentProjection.every((route) => route.effectiveStatus === "invalidated")).toBe(true);
  expect(() => vault.addresses.active(thread.id, question.content)).toThrow(/bounded list page/);
  expect(
    (
      vault.db
        .query(
          "SELECT COUNT(*) AS count FROM address_route WHERE thread_id = ? AND invalidated_by IS NOT NULL",
        )
        .get(thread.id) as { count: number }
    ).count,
  ).toBe(routeCount);
});
