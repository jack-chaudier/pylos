import { afterAll, expect, test } from "bun:test";
import type {
  AnswerReceipt,
  Atom,
  CoverageReceipt,
  EpisodeMeta,
  PageRecord,
  RequestRound,
} from "@pylos/protocol";
import {
  type AddressWitness,
  addressRouteDigestOf,
  answerReceiptDigestOf,
  atomize,
  canonicalHash,
  chainHash,
  chainRecord,
  coverageFor,
  forget,
  invalidateAddressRoute,
  metaHashOf,
  type Provider,
  recordAddressRouteFromReceipt,
  renderCoverage,
  roundsDigest,
  runTurn,
  sha256,
  verify,
  witnessForEpisode,
} from "../src/index.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

test("verify chain replay does not retain a full large row batch", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const largeContent = "x".repeat(128 * 1024);
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 1024 }, () => ({ role: "assistant" as const, content: largeContent })),
  );

  let maxRows = 0;
  let maxBytes = 0;
  const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (
      !/SELECT seq, ts, role, model, provider, content, content_hash, prev_hash, hash, meta FROM episode/iu.test(
        sql,
      ) &&
      !/SELECT seq, role, content, content_hash, hash, meta FROM episode/iu.test(sql)
    ) {
      return statement;
    }
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const rows = method.apply(target, parameters) as Array<Record<string, unknown>>;
            maxRows = Math.max(maxRows, rows.length);
            maxBytes = Math.max(
              maxBytes,
              rows.reduce(
                (total, row) =>
                  total +
                  (typeof row.content === "string" ? row.content.length : 0) +
                  (typeof row.meta === "string" ? row.meta.length : 0),
                0,
              ),
            );
            return rows;
          };
        }
        if (property === "iterate") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const rows = method.apply(target, parameters) as Iterable<Record<string, unknown>>;
            return (function* () {
              for (const row of rows) {
                maxRows = Math.max(maxRows, 1);
                maxBytes = Math.max(
                  maxBytes,
                  (typeof row.content === "string" ? row.content.length : 0) +
                    (typeof row.meta === "string" ? row.meta.length : 0),
                );
                yield row;
              }
            })();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.query;
  try {
    const initialVerification = verify(vault, thread.id, { full: true });
    expect(initialVerification.ok, initialVerification.reason).toBe(true);
  } finally {
    db.query = originalQuery;
  }

  expect(maxRows).toBeGreaterThan(0);
  expect(maxRows).toBe(1);
  expect(maxBytes).toBeGreaterThan(0);
  expect(maxBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test("full verification rejects malformed stored packet reachability", async () => {
  const { vault, thread } = tempVault();
  const provider: Provider = async function* () {
    yield { type: "delta", text: "Stored packet reachability remains verified." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "Verify the stored packet.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  vault.db
    .query("UPDATE packet SET reachability = ? WHERE id = ?")
    .run(JSON.stringify([{ bad: 1 }]), result.packet.id);

  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/packet.*reachability|reachability.*packet|invalid.*span/i);
});

test("full verification rejects a lowered empty packet reachability snapshot", async () => {
  const { vault, thread } = tempVault();
  const provider: Provider = async function* () {
    yield { type: "delta", text: "The archive is not empty." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "Is the archive empty?",
    model: "integrity",
    provider,
    budget: 8192,
  });
  vault.db
    .query("UPDATE packet SET reachability = '[]', reachability_as_of_seq = 0 WHERE id = ?")
    .run(result.packet.id);

  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/reachability.*snapshot|snapshot.*turn|packet.*reachability/i);
});

test("stored packet answer binding uses an indexed two-row candidate lookup", async () => {
  const { vault, thread } = tempVault();
  const provider: Provider = async function* () {
    yield { type: "delta", text: "The indexed answer binding is intact." };
    yield { type: "done" };
  };
  await runTurn(vault, thread.id, {
    text: "Verify the indexed answer binding.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 512 }, (_, index) => ({
      role: "assistant" as const,
      content: `Unrelated assistant row ${index}.`,
    })),
  );

  let bindingQueries = 0;
  let bindingRows = 0;
  const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const normalized = sql.replace(/\s+/gu, " ");
    if (
      /FROM episode WHERE thread_id = \? AND role = 'assistant'.*json_extract\(meta, '\$\.packetId'\).*LIMIT 2/u.test(
        normalized,
      )
    ) {
      expect(normalized).not.toMatch(/COUNT\(|MIN\(|SUM\(/u);
      const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
      return new Proxy(statement, {
        get(target, property) {
          if (property !== "all") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const rows = method.apply(target, parameters) as unknown[];
            bindingQueries += 1;
            bindingRows += rows.length;
            expect(rows.length).toBeLessThanOrEqual(2);
            return rows;
          };
        },
      });
    }
    return originalQuery.call(vault.db, sql, ...args);
  }) as typeof db.query;
  try {
    const verified = verify(vault, thread.id, { full: true });
    expect(verified.ok, verified.reason).toBe(true);
  } finally {
    db.query = originalQuery;
  }
  expect(bindingQueries).toBe(1);
  expect(bindingRows).toBe(1);

  const plan = vault.db
    .query(
      "EXPLAIN QUERY PLAN SELECT seq FROM episode WHERE thread_id = ? AND role = 'assistant' " +
        "AND (CASE WHEN json_valid(meta) = 1 THEN json_extract(meta, '$.packetId') END) = ? " +
        "ORDER BY seq LIMIT 2",
    )
    .all(thread.id, "packet-oracle") as Array<{ detail: string }>;
  expect(plan.some((row) => /episode_assistant_packet_binding/u.test(row.detail))).toBe(true);
});

test("full verification rejects an orphan support-bearing packet visible at its turn", async () => {
  const { vault, thread } = tempVault();
  const provider: Provider = async function* () {
    yield { type: "delta", text: "The bound packet is legitimate." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "Create one bound packet.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  const orphanId = "pk_orphan_support_packet";
  vault.packets.insert({
    ...structuredClone(result.packet),
    id: orphanId,
    createdAt: result.packet.createdAt + 1,
  });
  expect(vault.packets.get(thread.id, result.packet.turnSeq)?.id).toBe(orphanId);

  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/packet.*assistant|orphan|answer.*binding/i);
});

async function explicitPageFixture(
  options: { quotedMarkers?: boolean } = {},
): Promise<ReceiptFixture & { sourceSeq: number; duplicateSeq: number }> {
  const { vault, thread } = tempVault({ budget: 1024 });
  const content = "The exact duplicated source says ORBIT-DELTA.";
  const source = vault.episodes.append(thread.id, { role: "user", content });
  const duplicate = vault.episodes.append(thread.id, { role: "user", content });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 160 }, (_, index) => ({
      role: "user" as const,
      content: `unrelated filler ${index} keeps the explicit sources outside the recent window`,
    })),
  );
  if (options.quotedMarkers === true) {
    // Archive text that merely quotes a recovery marker: an earlier turn's
    // recall kept as a tool result, and a marker a person typed by hand.
    vault.episodes.append(thread.id, {
      role: "tool",
      content: `recall({"query":"orbit"}) →\n⟦recovered #123 · user⟧\nan earlier turn's recovered block`,
    });
    vault.episodes.append(thread.id, {
      role: "user",
      content: "I can type ⟦recovered #77 · user⟧ myself and it is still only my sentence.",
    });
  }
  const provider: Provider = async function* () {
    yield { type: "delta", text: "The exact source says ORBIT-DELTA." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: `What did I say on turn ${source.seq}?`,
    model: "integrity",
    provider,
    budget: 1024,
  });
  const firstPage = result.packet.rounds?.[0]?.pages[0];
  if (firstPage === undefined || !firstPage.seqs.includes(source.seq)) {
    throw new Error("explicit page fixture did not recover its requested source");
  }
  return { vault, thread, result, sourceSeq: source.seq, duplicateSeq: duplicate.seq };
}

/** The retained messages of a packet, as the verifier reads them. */
function retainedMessages(fixture: ReceiptFixture): Array<{ role: string; content: string }> {
  const row = fixture.vault.db
    .query("SELECT messages FROM packet WHERE id = ?")
    .get(fixture.result.packet.id) as {
    messages: string | null;
  } | null;
  if (row?.messages == null) throw new Error("packet fixture retained no messages");
  return JSON.parse(row.messages) as Array<{ role: string; content: string }>;
}

test("verify accepts recovery markers quoted inside retained episode content", async () => {
  const fixture = await explicitPageFixture({ quotedMarkers: true });
  const messages = retainedMessages(fixture);
  const header = messages[0];
  if (header === undefined) throw new Error("packet fixture retained no header");
  expect(header.role).toBe("system");
  expect(header.content).toContain(`⟦recovered #${fixture.sourceSeq} ·`);
  expect(fixture.result.packet.rounds?.[0]?.admittedPageSeqs).toContain(fixture.sourceSeq);
  const quoted = messages.slice(1).map((message) => message.content);
  expect(quoted.some((content) => content.includes("⟦recovered #123 ·"))).toBe(true);
  expect(quoted.some((content) => content.includes("⟦recovered #77 ·"))).toBe(true);

  const verified = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(verified.ok, verified.reason).toBe(true);
});

test("verify rejects an initial round that disowns a page insert its header shows", async () => {
  const fixture = await explicitPageFixture({ quotedMarkers: true });
  rewriteRoundPages(fixture, (rounds) => {
    const round = rounds[0];
    if (round === undefined) throw new Error("page admission fixture lost its initial round");
    rounds[0] = { ...round, admittedPageSeqs: [] };
  });

  const verified = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/page insert is missing from its admitted page sources/u);
});

test("verify rejects an admitted page source that no retained message ever showed", async () => {
  const fixture = await explicitPageFixture({ quotedMarkers: true });
  rewriteRoundPages(fixture, (rounds, packetPages) => {
    const round = rounds[0];
    const first = round?.pages[0];
    if (round === undefined || first === undefined) throw new Error("page admission fixture lost its pages");
    const widened = { ...first, seqs: [...first.seqs, fixture.duplicateSeq] };
    rounds[0] = {
      ...round,
      pages: [widened, ...round.pages.slice(1)],
      admittedPageSeqs: [...round.admittedPageSeqs, fixture.duplicateSeq].sort((a, b) => a - b),
    };
    packetPages.splice(0, 1, widened);
  });

  const verified = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/admitted page sources changed in retained provider messages/u);
});

test("verify rejects a round page mutation after every outer digest is recomputed", async () => {
  const fixture = await explicitPageFixture();
  expect(verify(fixture.vault, fixture.thread.id, { full: true }).ok).toBe(true);
  rewriteRoundPages(fixture, (rounds) => {
    const first = rounds[0]?.pages[0];
    if (first === undefined) throw new Error("round page mutation fixture lost its first page");
    rounds[0] = {
      ...(rounds[0] as RequestRound),
      pages: [{ ...first, routeId: "chain-consistent-round-page-tamper" }],
    };
  });

  const verified = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/round.*page|page.*round|packet.*page/i);
});

test("verify rejects an unrelated duplicate-content page source after rechaining", async () => {
  const fixture = await explicitPageFixture();
  rewriteRoundPages(fixture, (rounds, packetPages) => {
    const first = rounds[0]?.pages[0];
    if (first === undefined) throw new Error("duplicate page fixture lost its first page");
    const substituted = { ...first, seqs: [fixture.duplicateSeq] };
    rounds[0] = { ...(rounds[0] as RequestRound), pages: [substituted] };
    packetPages.splice(0, 1, substituted);
  });

  const verified = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/page.*source|recovered.*page|packet.*page|round.*page/i);
});

interface ReceiptFixture {
  vault: ReturnType<typeof tempVault>["vault"];
  thread: ReturnType<typeof tempVault>["thread"];
  result: Awaited<ReturnType<typeof runTurn>>;
}

function rewriteRoundPages(
  fixture: ReceiptFixture,
  mutate: (rounds: RequestRound[], packetPages: PageRecord[]) => void,
): void {
  const packetRow = fixture.vault.db
    .query("SELECT rounds, pages, answer_receipt FROM packet WHERE id = ?")
    .get(fixture.result.packet.id) as {
    rounds: string;
    pages: string;
    answer_receipt: string;
  } | null;
  if (packetRow === null) throw new Error("round page fixture packet disappeared");
  const rounds = JSON.parse(packetRow.rounds) as RequestRound[];
  const packetPages = JSON.parse(packetRow.pages) as PageRecord[];
  mutate(rounds, packetPages);
  const receipt = JSON.parse(packetRow.answer_receipt) as AnswerReceipt;
  const rewrittenReceipt: AnswerReceipt = {
    ...receipt,
    roundsDigest: roundsDigest(rounds),
  };
  rewrittenReceipt.digest = answerReceiptDigestOf(rewrittenReceipt);
  fixture.vault.db
    .query("UPDATE packet SET rounds = ?, pages = ?, answer_receipt = ? WHERE id = ?")
    .run(
      JSON.stringify(rounds),
      JSON.stringify(packetPages),
      JSON.stringify(rewrittenReceipt),
      fixture.result.packet.id,
    );

  const assistant = fixture.vault.episodes.get(fixture.thread.id, fixture.result.assistantEpisode.seq);
  if (assistant === null) throw new Error("round page fixture assistant disappeared");
  const meta: EpisodeMeta = {
    ...assistant.meta,
    pages: packetPages,
    roundsDigest: rewrittenReceipt.roundsDigest,
    answerReceipt: rewrittenReceipt,
    answerReceiptDigest: rewrittenReceipt.digest,
  };
  const raw = fixture.vault.db
    .query(
      "SELECT ts, role, model, provider, prev_hash, content_hash FROM episode WHERE thread_id = ? AND seq = ?",
    )
    .get(fixture.thread.id, assistant.seq) as {
    ts: number;
    role: string;
    model: string | null;
    provider: string | null;
    prev_hash: string;
    content_hash: string;
  } | null;
  if (raw === null) throw new Error("round page fixture assistant row disappeared");
  const hash = chainHash(
    raw.prev_hash,
    chainRecord({
      seq: assistant.seq,
      ts: raw.ts,
      role: raw.role,
      ...(raw.model === null ? {} : { model: raw.model }),
      ...(raw.provider === null ? {} : { provider: raw.provider }),
      contentHash: raw.content_hash,
      metaHash: metaHashOf(meta),
    }),
  );
  fixture.vault.db
    .query("UPDATE episode SET meta = ?, hash = ? WHERE thread_id = ? AND seq = ?")
    .run(JSON.stringify(meta), hash, fixture.thread.id, assistant.seq);
  fixture.vault.db.query("UPDATE thread SET head_hash = ? WHERE id = ?").run(hash, fixture.thread.id);
}

interface Grounded extends ReceiptFixture {
  vault: ReturnType<typeof tempVault>["vault"];
  thread: ReturnType<typeof tempVault>["thread"];
  answerSeq: number;
  packetId: string;
  packetDigest: string;
  routeId: string;
}

async function grounded(): Promise<Grounded> {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, {
    role: "user",
    content: "The amount was 48250 USD.",
  });
  const provider: Provider = async function* (request) {
    const text = "The amount was 48250 USD.";
    yield { type: "delta", text };
    const capability = request.evidence?.find((candidate) => candidate.authority === "user");
    if (capability !== undefined) {
      yield {
        type: "tool_call",
        id: "integrity-claim-map",
        name: "submit_claim_map",
        arguments: JSON.stringify({
          claims: [{ outputSpan: [15, 24], capabilityTokens: [capability.token] }],
        }),
      };
    }
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "What was the contract amount?",
    model: "integrity",
    provider,
    budget: 8192,
  });
  const receipt = result.assistantEpisode.meta.answerReceipt;
  if (receipt === undefined) throw new Error("grounded fixture did not produce a receipt");

  let route = vault.db
    .query(
      "SELECT id FROM address_route WHERE thread_id = ? AND status = 'active' ORDER BY rowid DESC LIMIT 1",
    )
    .get(thread.id) as { id: string } | null;
  if (route === null) {
    const written = recordAddressRouteFromReceipt(vault, {
      threadId: thread.id,
      query: "What was the contract amount?",
      routerVersion: "1",
      questionSeq: result.userEpisode.seq,
      answerSeq: result.assistantEpisode.seq,
      packetId: result.packet.id,
      packetDigest: result.packet.digest,
      receipt,
    });
    if (!written.accepted || written.route === undefined) throw new Error("grounded fixture route failed");
    route = { id: written.route.id };
  }
  return {
    vault,
    thread,
    result,
    answerSeq: result.assistantEpisode.seq,
    packetId: result.packet.id,
    packetDigest: result.packet.digest,
    routeId: route.id,
  };
}

async function coverageGrounded(): Promise<ReceiptFixture> {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, {
    role: "user",
    content: "The launch note was Oslo.",
  });
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found one launch note: Oslo." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "List every launch note.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  const packetRow = vault.db.query("SELECT coverage FROM packet WHERE id = ?").get(result.packet.id) as {
    coverage: string | null;
  } | null;
  if (packetRow?.coverage === null || packetRow?.coverage === undefined) {
    throw new Error("coverage fixture did not produce a coverage receipt");
  }
  const coverage = JSON.parse(packetRow.coverage) as CoverageReceipt;
  if (coverage.routes.length !== 1) {
    throw new Error(`coverage fixture expected one locator, got ${coverage.routes.length}`);
  }
  return { vault, thread, result };
}

interface AttachmentGrounded extends ReceiptFixture {
  targetSeq: number;
  bytes: Uint8Array;
  hash: string;
}

async function groundedAttachment(duplicate = false): Promise<AttachmentGrounded> {
  const { vault, thread } = tempVault();
  const marker = "ATTACHMENT_INTEGRITY_MARKER";
  const content = `${"indexed attachment line\n".repeat(7_000)}The final marker is ${marker}.`;
  const bytes = new TextEncoder().encode(content);
  const first = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes, mime: "text/plain", name: "first.txt" },
  });
  const target = duplicate
    ? vault.episodes.append(thread.id, {
        role: "attachment",
        content,
        blob: { bytes, mime: "text/plain", name: "second.txt" },
      })
    : first;
  const answer = `The final marker is ${marker}.`;
  const provider: Provider = async function* (request) {
    const capability = request.evidence?.find(
      (candidate) => candidate.authority === "attachment" && candidate.seq === target.seq,
    );
    if (capability === undefined) throw new Error("attachment integrity capability was not exposed");
    yield { type: "delta", text: answer };
    yield {
      type: "tool_call",
      id: "integrity-attachment-claim-map",
      name: "submit_claim_map",
      arguments: JSON.stringify({
        claims: [{ outputSpan: [0, answer.length], capabilityTokens: [capability.token] }],
      }),
    };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: duplicate ? "What did the tail of second.txt say?" : "What did the tail of first.txt say?",
    model: "integrity",
    provider,
    budget: 8192,
  });
  return { vault, thread, result, targetSeq: target.seq, bytes, hash: sha256(bytes) };
}

function rewriteStoredReceipt(
  fixture: ReceiptFixture,
  rewrite: (receipt: AnswerReceipt) => AnswerReceipt,
): void {
  const receipt = fixture.result.assistantEpisode.meta.answerReceipt;
  if (receipt === undefined) throw new Error("attachment fixture did not produce a receipt");
  const body = rewrite(receipt);
  const rewritten = { ...body, digest: answerReceiptDigestOf(body) };
  fixture.vault.db
    .query("UPDATE packet SET answer_receipt = ? WHERE id = ?")
    .run(JSON.stringify(rewritten), fixture.result.packet.id);

  const episode = fixture.vault.episodes.get(fixture.thread.id, fixture.result.assistantEpisode.seq);
  if (episode === null) throw new Error("attachment assistant episode disappeared");
  const meta = {
    ...episode.meta,
    answerReceipt: rewritten,
    answerReceiptDigest: rewritten.digest,
  } as EpisodeMeta;
  const row = fixture.vault.db
    .query(
      "SELECT ts, role, model, provider, prev_hash, content_hash FROM episode WHERE thread_id = ? AND seq = ?",
    )
    .get(fixture.thread.id, episode.seq) as {
    ts: number;
    role: string;
    model: string | null;
    provider: string | null;
    prev_hash: string;
    content_hash: string;
  } | null;
  if (row === null) throw new Error("attachment assistant row disappeared");
  const hashAfter = chainHash(
    row.prev_hash,
    chainRecord({
      seq: episode.seq,
      ts: row.ts,
      role: row.role,
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.provider === null ? {} : { provider: row.provider }),
      contentHash: row.content_hash,
      metaHash: metaHashOf(meta),
    }),
  );
  fixture.vault.db
    .query("UPDATE episode SET meta = ?, hash = ? WHERE thread_id = ? AND seq = ?")
    .run(JSON.stringify(meta), hashAfter, fixture.thread.id, episode.seq);
  fixture.vault.db.query("UPDATE thread SET head_hash = ? WHERE id = ?").run(hashAfter, fixture.thread.id);
}

function rewriteCoverageChain(
  fixture: ReceiptFixture,
  rewrite: (coverage: CoverageReceipt) => CoverageReceipt,
): void {
  const packetRow = fixture.vault.db
    .query("SELECT coverage, answer_receipt FROM packet WHERE id = ?")
    .get(fixture.result.packet.id) as { coverage: string; answer_receipt: string };
  const original = JSON.parse(packetRow.coverage) as CoverageReceipt;
  const body = rewrite(original);
  const { digest: _digest, ...coverageBody } = body;
  const coverage: CoverageReceipt = { ...body, digest: canonicalHash(coverageBody) };
  const receipt = JSON.parse(packetRow.answer_receipt) as AnswerReceipt;
  const rewrittenReceipt: AnswerReceipt = {
    ...receipt,
    coverageDigest: coverage.digest,
    coverageRouterVersion: coverage.routerVersion,
    coverageRoutesRun: coverage.routesRun,
  };
  rewrittenReceipt.digest = answerReceiptDigestOf(rewrittenReceipt);
  fixture.vault.db
    .query("UPDATE packet SET coverage = ?, answer_receipt = ? WHERE id = ?")
    .run(JSON.stringify(coverage), JSON.stringify(rewrittenReceipt), fixture.result.packet.id);

  const assistant = fixture.vault.episodes.get(fixture.thread.id, fixture.result.assistantEpisode.seq);
  if (assistant === null) throw new Error("coverage assistant episode disappeared");
  const meta: EpisodeMeta = {
    ...assistant.meta,
    coverage,
    answerReceipt: rewrittenReceipt,
    answerReceiptDigest: rewrittenReceipt.digest,
  };
  const row = fixture.vault.db
    .query(
      "SELECT ts, role, model, provider, prev_hash, content_hash FROM episode WHERE thread_id = ? AND seq = ?",
    )
    .get(fixture.thread.id, assistant.seq) as {
    ts: number;
    role: string;
    model: string | null;
    provider: string | null;
    prev_hash: string;
    content_hash: string;
  } | null;
  if (row === null) throw new Error("coverage assistant row disappeared");
  const hashAfter = chainHash(
    row.prev_hash,
    chainRecord({
      seq: assistant.seq,
      ts: row.ts,
      role: row.role,
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.provider === null ? {} : { provider: row.provider }),
      contentHash: row.content_hash,
      metaHash: metaHashOf(meta),
    }),
  );
  fixture.vault.db
    .query("UPDATE episode SET meta = ?, hash = ? WHERE thread_id = ? AND seq = ?")
    .run(JSON.stringify(meta), hashAfter, fixture.thread.id, assistant.seq);
  fixture.vault.db.query("UPDATE thread SET head_hash = ? WHERE id = ?").run(hashAfter, fixture.thread.id);
}

/** Rebuild the immutable issuance basis and its route outcomes after a test mutation. */
function rehashCoverageBasis(
  coverage: CoverageReceipt,
  mutate: (basis: CoverageReceipt["basis"]) => void,
): CoverageReceipt {
  const changed = structuredClone(coverage);
  mutate(changed.basis);
  for (const [routeName, route] of Object.entries(changed.basis.routeMembers)) {
    const run = changed.routesRun.find((candidate) => candidate.route === routeName);
    if (run !== undefined) route.outcome = run;
    const { membersDigest: _membersDigest, ...body } = route;
    route.membersDigest = canonicalHash(body);
  }
  const { digest: _digest, ...body } = changed.basis;
  changed.basis = { ...changed.basis, digest: canonicalHash(body) };
  return changed;
}

/** Persist a test-only page projection while preserving packet, receipt, and chain bindings. */
function rewritePacketPages(fixture: ReceiptFixture, pages: PageRecord[], coverage: CoverageReceipt): void {
  const packetRow = fixture.vault.db
    .query("SELECT messages, rounds, coverage, answer_receipt FROM packet WHERE id = ?")
    .get(fixture.result.packet.id) as {
    messages: string | null;
    rounds: string;
    coverage: string | null;
    answer_receipt: string;
  } | null;
  if (packetRow === null || packetRow.messages === null || packetRow.coverage === null) {
    throw new Error("page replay fixture packet material is missing");
  }
  const newCoverageText = renderCoverage(coverage);
  let replacedCoverageText = false;
  const messages = (JSON.parse(packetRow.messages) as Array<Record<string, unknown>>).map((message) => {
    if (message.role === "system" && typeof message.content === "string") {
      const start = message.content.indexOf("⟨pylos coverage");
      const end = start < 0 ? -1 : message.content.indexOf("⟩", start);
      if (start >= 0 && end > start) {
        replacedCoverageText = true;
        return {
          ...message,
          content: `${message.content.slice(0, start)}${newCoverageText}${message.content.slice(end + 1)}`,
        };
      }
    }
    return message;
  });
  if (!replacedCoverageText) throw new Error("page replay fixture coverage block is missing");
  const packetDigest = canonicalHash(messages);
  const rounds = JSON.parse(packetRow.rounds) as Array<Record<string, unknown>>;
  if (rounds.length === 0) throw new Error("page replay fixture has no request round");
  const rewrittenRounds = rounds.map((round, index) =>
    index === 0 ? { ...round, messagesDigest: packetDigest, pages } : round,
  );
  const rewrittenRoundsDigest = roundsDigest(rewrittenRounds as unknown as RequestRound[]);
  const receipt = JSON.parse(packetRow.answer_receipt) as AnswerReceipt;
  const rewrittenReceipt: AnswerReceipt = {
    ...receipt,
    packetDigest,
    roundsDigest: rewrittenRoundsDigest,
    coverageDigest: coverage.digest,
    coverageRouterVersion: coverage.routerVersion,
    coverageRoutesRun: coverage.routesRun,
  };
  rewrittenReceipt.digest = answerReceiptDigestOf(rewrittenReceipt);
  fixture.vault.db
    .query(
      "UPDATE packet SET messages = ?, digest = ?, pages = ?, rounds = ?, coverage = ?, answer_receipt = ? WHERE id = ?",
    )
    .run(
      JSON.stringify(messages),
      packetDigest,
      JSON.stringify(pages),
      JSON.stringify(rewrittenRounds),
      JSON.stringify(coverage),
      JSON.stringify(rewrittenReceipt),
      fixture.result.packet.id,
    );

  const assistant = fixture.vault.episodes.get(fixture.thread.id, fixture.result.assistantEpisode.seq);
  if (assistant === null) throw new Error("page replay assistant episode disappeared");
  const meta: EpisodeMeta = {
    ...assistant.meta,
    pages,
    coverage,
    answerReceipt: rewrittenReceipt,
    answerReceiptDigest: rewrittenReceipt.digest,
    roundsDigest: rewrittenRoundsDigest,
  };
  const row = fixture.vault.db
    .query(
      "SELECT ts, role, model, provider, prev_hash, content_hash FROM episode WHERE thread_id = ? AND seq = ?",
    )
    .get(fixture.thread.id, assistant.seq) as {
    ts: number;
    role: string;
    model: string | null;
    provider: string | null;
    prev_hash: string;
    content_hash: string;
  } | null;
  if (row === null) throw new Error("page replay assistant row disappeared");
  const hashAfter = chainHash(
    row.prev_hash,
    chainRecord({
      seq: assistant.seq,
      ts: row.ts,
      role: row.role,
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.provider === null ? {} : { provider: row.provider }),
      contentHash: row.content_hash,
      metaHash: metaHashOf(meta),
    }),
  );
  fixture.vault.db
    .query("UPDATE episode SET meta = ?, hash = ? WHERE thread_id = ? AND seq = ?")
    .run(JSON.stringify(meta), hashAfter, fixture.thread.id, assistant.seq);
  fixture.vault.db.query("UPDATE thread SET head_hash = ? WHERE id = ?").run(hashAfter, fixture.thread.id);
}

function rewriteReceiptWithBareAttachmentWitness(
  fixture: AttachmentGrounded,
  hash: string,
  byteRange: [number, number],
): void {
  rewriteStoredReceipt(fixture, (receipt) => {
    const supported = receipt.classifications.find((entry) => entry.classification === "SUPPORTED");
    if (supported === undefined) throw new Error("attachment fixture did not produce a supported claim");
    const bareWitness = { source: `blob:${hash}`, from: byteRange[0], to: byteRange[1], hash };
    const classifications = receipt.classifications.map((entry) => {
      if (entry !== supported) return entry;
      const { witness: _witness, evidenceWitness: _evidenceWitness, ...rest } = entry;
      return { ...rest, evidenceWitness: bareWitness };
    });
    return { ...receipt, classifications } as unknown as AnswerReceipt;
  });
}

function rewriteReceiptWithBareEpisodeWitness(fixture: Grounded): void {
  rewriteStoredReceipt(fixture, (receipt) => {
    const supported = receipt.classifications.find((entry) => entry.classification === "SUPPORTED");
    if (supported?.evidenceWitness === undefined) {
      throw new Error("grounded fixture did not produce a typed evidence witness");
    }
    const { source, from, to, hash } = supported.evidenceWitness;
    if (!source.startsWith("episode:")) throw new Error("grounded witness was not an episode locator");
    const bareWitness = { source, from, to, hash };
    const classifications = receipt.classifications.map((entry) => {
      if (entry !== supported) return entry;
      const { witness: _witness, evidenceWitness: _evidenceWitness, ...rest } = entry;
      return { ...rest, witness: bareWitness };
    });
    return { ...receipt, classifications };
  });
}

test("verify rejects a packet receipt body tamper even when the episode chain is intact", async () => {
  const fixture = await grounded();
  const row = fixture.vault.db
    .query("SELECT answer_receipt FROM packet WHERE id = ?")
    .get(fixture.packetId) as { answer_receipt: string };
  const receipt = JSON.parse(row.answer_receipt) as { qualifications?: string[] };
  receipt.qualifications = ["tampered receipt body"];
  fixture.vault.db
    .query("UPDATE packet SET answer_receipt = ? WHERE id = ?")
    .run(JSON.stringify(receipt), fixture.packetId);
  const result = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/packet answer receipt binding/i);
});

test("verify rejects an UNKNOWN to WORLD_KNOWLEDGE rechain on a memory question", async () => {
  const { vault, thread } = tempVault();
  const result = await runTurn(vault, thread.id, {
    text: "What did we record about the launch code?",
    model: "integrity",
    provider: async function* () {
      yield { type: "delta", text: "The launch code is x999." };
      yield { type: "done" };
    },
    budget: 8192,
  });
  const original = result.assistantEpisode.meta.answerReceipt;
  if (original === undefined) throw new Error("memory fixture did not produce a receipt");
  expect(original.classifications.some((entry) => entry.classification === "UNKNOWN")).toBe(true);
  const assistant = vault.episodes.get(thread.id, result.assistantEpisode.seq);
  if (assistant === null) throw new Error("memory assistant disappeared");
  const baseText = assistant.content.replace(/\n\n⟨pylos UNKNOWN ·[^\n]+⟩/gu, "");
  vault.db
    .query("UPDATE episode SET content = ?, content_hash = ? WHERE thread_id = ? AND seq = ?")
    .run(baseText, sha256(baseText), thread.id, assistant.seq);
  const fixture: ReceiptFixture = { vault, thread, result };
  rewriteStoredReceipt(fixture, (receipt) => ({
    ...receipt,
    answerDigest: sha256(baseText),
    classifications: receipt.classifications.map((entry) =>
      entry.classification === "UNKNOWN" ? { ...entry, classification: "WORLD_KNOWLEDGE" } : entry,
    ),
    qualifications: [],
    status: "released",
  }));
  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/world-knowledge.*memory|memory.*world-knowledge/i);
});

test("verify rejects a route-provenance deletion even after packet, receipt, and chain digests are recomputed", async () => {
  const { vault, thread } = tempVault();
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found 0 launch notes." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "List every launch note.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  const packetRow = vault.db
    .query("SELECT coverage, answer_receipt FROM packet WHERE id = ?")
    .get(result.packet.id) as { coverage: string; answer_receipt: string };
  const coverage = JSON.parse(packetRow.coverage) as CoverageReceipt;
  coverage.routesRun = coverage.routesRun.slice(0, -1);
  const { digest: _coverageDigest, ...coverageBody } = coverage;
  coverage.digest = canonicalHash(coverageBody);
  const receipt = JSON.parse(packetRow.answer_receipt) as AnswerReceipt;
  const rewrittenReceipt: AnswerReceipt = {
    ...receipt,
    coverageDigest: coverage.digest,
    coverageRoutesRun: coverage.routesRun,
  };
  rewrittenReceipt.digest = answerReceiptDigestOf(rewrittenReceipt);
  vault.db
    .query("UPDATE packet SET coverage = ?, answer_receipt = ? WHERE id = ?")
    .run(JSON.stringify(coverage), JSON.stringify(rewrittenReceipt), result.packet.id);

  const assistant = vault.episodes.get(thread.id, result.assistantEpisode.seq);
  if (assistant === null) throw new Error("integrity assistant episode disappeared");
  const meta: EpisodeMeta = {
    ...assistant.meta,
    coverage,
    answerReceipt: rewrittenReceipt,
    answerReceiptDigest: rewrittenReceipt.digest,
  };
  const row = vault.db
    .query(
      "SELECT ts, role, model, provider, prev_hash, content_hash FROM episode WHERE thread_id = ? AND seq = ?",
    )
    .get(thread.id, assistant.seq) as {
    ts: number;
    role: string;
    model: string | null;
    provider: string | null;
    prev_hash: string;
    content_hash: string;
  } | null;
  if (row === null) throw new Error("integrity assistant row disappeared");
  const hashAfter = chainHash(
    row.prev_hash,
    chainRecord({
      seq: assistant.seq,
      ts: row.ts,
      role: row.role,
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.provider === null ? {} : { provider: row.provider }),
      contentHash: row.content_hash,
      metaHash: metaHashOf(meta),
    }),
  );
  vault.db
    .query("UPDATE episode SET meta = ?, hash = ? WHERE thread_id = ? AND seq = ?")
    .run(JSON.stringify(meta), hashAfter, thread.id, assistant.seq);
  vault.db.query("UPDATE thread SET head_hash = ? WHERE id = ?").run(hashAfter, thread.id);

  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/coverage route set|route provenance/i);
});

test("verify rejects coverage locator source and binding tamper after every outer digest is recomputed", async () => {
  const mutations: Array<
    [string, (locator: CoverageReceipt["routes"][number]) => CoverageReceipt["routes"][number]]
  > = [
    ["source", (locator) => ({ ...locator, source: "episode:999" })],
    ["range", (locator) => ({ ...locator, byteRange: [0, 1] })],
    ["revision", (locator) => ({ ...locator, revision: "tampered-revision" })],
    ["authority", (locator) => ({ ...locator, authority: "assistant" })],
  ];

  for (const [kind, mutate] of mutations) {
    const fixture = await coverageGrounded();
    expect(verify(fixture.vault, fixture.thread.id, { full: true }).ok).toBe(true);
    rewriteCoverageChain(fixture, (coverage) => {
      const original = coverage.routes[0];
      if (original === undefined) throw new Error("coverage locator disappeared");
      const changed = mutate(original);
      const { digest: _digest, ...locatorBody } = changed;
      const rewritten = { ...changed, digest: canonicalHash(locatorBody) };
      return { ...coverage, routes: [rewritten] };
    });
    const result = verify(fixture.vault, fixture.thread.id, { full: true });
    expect(result.ok, `${kind} tamper unexpectedly verified`).toBe(false);
    expect(result.reason).toMatch(/coverage locator|coverage route/i);
  }
});

test("verify rejects a chain-consistent omission from the deterministic search set", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "The launch note was Oslo." });
  vault.episodes.append(thread.id, { role: "user", content: "The launch note was Porto." });
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found one launch note." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "List every 1 launch note.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  const packetCoverage = result.packet.coverage;
  if (packetCoverage === undefined || packetCoverage.routes.length !== 2) {
    throw new Error("search omission fixture did not produce two locators");
  }
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  rewriteCoverageChain({ vault, thread, result }, (coverage) => ({
    ...coverage,
    located: 1,
    supported: 1,
    historical: 0,
    unresolved: 0,
    completeness: "complete",
    routes: [coverage.routes[0] as CoverageReceipt["routes"][number]],
  }));
  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/search|locator set|coverage route/i);
});

test("verify rejects a chain-consistent omission of a name-only member and locator", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "Alice is a user.",
  });
  vault.atoms.insert({
    id: "integrity-name-only-atom",
    threadId: thread.id,
    kind: "identity",
    key: "identity.name",
    value: "Alice",
    text: "Alice",
    sourceSeq: source.seq,
    sourceSpan: [0, "Alice".length],
    validFromSeq: source.seq,
    phase: "SUPPORTED",
    authority: "user",
    scope: "global",
    pinned: false,
    confidence: 1,
    createdBy: "integrity-name-only-oracle",
    createdAt: 1,
  });
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found Alice." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "List every 1 record: Alice.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  const coverage = result.packet.coverage;
  if (coverage === undefined) throw new Error("name-only omission fixture has no coverage");
  expect(coverage.routes).toHaveLength(1);
  expect(coverage.routesRun).toContainEqual(expect.objectContaining({ route: "names", returned: 1 }));
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);

  rewriteCoverageChain({ vault, thread, result }, (original) => {
    const changed = rehashCoverageBasis(original, (basis) => {
      basis.routeMembers.names.members = [];
      basis.routeMembers.names.memberCount = 0;
      basis.locatorDigests = [];
    });
    changed.located = 0;
    changed.supported = 0;
    changed.historical = 0;
    changed.unresolved = 1;
    changed.completeness = "incomplete";
    changed.routes = [];
    changed.routesRun = changed.routesRun.map((run) =>
      run.route === "names" ? { ...run, returned: 0, status: "empty" } : run,
    );
    return rehashCoverageBasis(changed, () => undefined);
  });
  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/name|locator|coverage route/i);
});

test("verify rejects a re-chained search receipt that inflates returned count with source zero", async () => {
  const fixture = await coverageGrounded();
  expect(verify(fixture.vault, fixture.thread.id, { full: true }).ok).toBe(true);
  rewriteCoverageChain(fixture, (original) => {
    const changed = rehashCoverageBasis(original, (basis) => {
      const search = basis.routeMembers.search;
      search.members.push({
        kind: "candidate",
        sourceSeq: 0,
        contentHash: sha256("forged-source-zero-search-member"),
        outcome: "no-locator",
        locatorDigests: [],
        key: sha256("launch note"),
        ordinal: search.members.length,
      });
      search.memberCount += 1;
    });
    changed.routesRun = changed.routesRun.map((run) =>
      run.route === "search" ? { ...run, returned: run.returned + 1 } : run,
    );
    return rehashCoverageBasis(changed, () => undefined);
  });
  const verified = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/search|source|basis|route/i);
});

test("verify replays collection search before the asking turn, ignoring later matching appends", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "The launch note was Oslo." });
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found one launch note." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "List every launch note.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  vault.episodes.append(thread.id, { role: "user", content: "The launch note was Porto." });
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  expect(result.packet.coverage?.routesRun.find((run) => run.route === "search")?.returned).toBe(1);
});

test(
  "verify rejects deleting the 1025th search sentinel and re-chaining an exact result",
  async () => {
    const { vault, thread } = tempVault({ budget: 1024 });
    for (let index = 0; index < 1025; index += 1) {
      vault.episodes.append(thread.id, {
        role: "user",
        content: `launch note ${index + 1}: harbor route.`,
      });
    }
    const provider: Provider = async function* () {
      yield { type: "delta", text: "I found 1024 launch notes." };
      yield { type: "done" };
    };
    const result = await runTurn(vault, thread.id, {
      text: "List every 1024 launch notes.",
      model: "integrity",
      provider,
      budget: 8192,
    });
    const coverage = result.packet.coverage;
    if (coverage === undefined) throw new Error("search sentinel fixture has no coverage");
    const searchRun = coverage.routesRun.find((run) => run.route === "search");
    expect(searchRun).toMatchObject({ returned: 1025, status: "unresolved" });
    expect(coverage.basis.routeMembers.search.members).toHaveLength(257);
    expect(coverage.basis.routeMembers.search.members.at(-1)?.kind).toBe("sentinel");
    const initialVerification = verify(vault, thread.id, { full: true });
    expect(initialVerification.ok, initialVerification.reason).toBe(true);

    rewriteCoverageChain({ vault, thread, result }, (original) => {
      const changed = rehashCoverageBasis(original, (basis) => {
        const search = basis.routeMembers.search;
        search.members = search.members.slice(0, 256);
        search.memberCount = 256;
      });
      changed.routesRun = changed.routesRun.map((run) =>
        run.route === "search" ? { ...run, returned: 256, status: "complete" } : run,
      );
      changed.completeness = "complete";
      return rehashCoverageBasis(changed, () => undefined);
    });
    const verified = verify(vault, thread.id, { full: true });
    expect(verified.ok).toBe(false);
    expect(verified.reason).toMatch(/search|sentinel|basis|route/i);
  },
  { timeout: 30_000 },
);

test("verify rejects dropping one atom locator from a source with multiple facts", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "I live in Lisbon. My name is Alice.",
  });
  const fromLocation = source.content.indexOf("Lisbon");
  const fromName = source.content.indexOf("Alice");
  vault.atoms.insert({
    id: "integrity-location-atom",
    threadId: thread.id,
    kind: "identity",
    key: "identity.location",
    value: "Lisbon",
    text: "I live in Lisbon.",
    sourceSeq: source.seq,
    sourceSpan: [fromLocation, fromLocation + "Lisbon".length],
    validFromSeq: source.seq,
    phase: "SUPPORTED",
    authority: "user",
    scope: "global",
    pinned: false,
    confidence: 1,
    createdBy: "integrity-oracle",
    createdAt: 1,
  });
  vault.atoms.insert({
    id: "integrity-name-atom",
    threadId: thread.id,
    kind: "identity",
    key: "identity.name",
    value: "Alice",
    text: "My name is Alice.",
    sourceSeq: source.seq,
    sourceSpan: [fromName, fromName + "Alice".length],
    validFromSeq: source.seq,
    phase: "SUPPORTED",
    authority: "user",
    scope: "global",
    pinned: false,
    confidence: 1,
    createdBy: "integrity-oracle",
    createdAt: 2,
  });
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found Lisbon." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "List every 1 Lisbon record.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  const coverage = result.packet.coverage;
  if (coverage === undefined || coverage.routes.length < 2) {
    throw new Error("atom omission fixture did not produce multiple locators");
  }
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  rewriteCoverageChain({ vault, thread, result }, (receipt) => ({
    ...receipt,
    located: 1,
    supported: 1,
    historical: 0,
    unresolved: 0,
    completeness: "complete",
    routes: [receipt.routes[0] as CoverageReceipt["routes"][number]],
  }));
  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/locator set|coverage route/i);
});

test(
  "coverage replay reads one bounded source snapshot for 256 same-source locators",
  async () => {
    const { vault, thread } = tempVault();
    const facts = Array.from({ length: 256 }, (_, index) => `Dense launch record ${index}.`);
    const content = facts.join(" ");
    const source = vault.episodes.append(thread.id, { role: "user", content });
    let offset = 0;
    for (const [index, fact] of facts.entries()) {
      const value = `record ${index}`;
      const start = offset + fact.indexOf(value);
      vault.atoms.insert({
        id: `coverage-replay-dense-${index}`,
        threadId: thread.id,
        kind: "fact",
        key: `dense.launch.${index}`,
        value,
        text: fact,
        sourceSeq: source.seq,
        sourceSpan: [start, start + value.length],
        validFromSeq: source.seq,
        phase: "SUPPORTED",
        authority: "user",
        scope: "global",
        pinned: false,
        confidence: 1,
        createdBy: "coverage-replay-cache-oracle",
        createdAt: index,
      });
      offset += fact.length + 1;
    }
    const provider: Provider = async function* () {
      yield { type: "delta", text: "The dense launch records are present." };
      yield { type: "done" };
    };
    const result = await runTurn(vault, thread.id, {
      text: "List every dense launch record.",
      model: "integrity",
      provider,
      budget: 8192,
    });
    expect(result.packet.coverage?.routes).toHaveLength(256);

    const stats = { sourceScalars: 0, atomSnapshots: 0, atomRows: 0, fullSourceGets: 0 };
    const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
    const originalQuery = db.query;
    db.query = ((sql: string, ...args: unknown[]) => {
      const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
      const normalized = sql.replace(/\s+/gu, " ");
      const sourceScalar =
        /SELECT seq, role, content_hash, hash, .*content_bytes.*meta_bytes.*FROM episode WHERE thread_id = \? AND seq = \?/u.test(
          normalized,
        );
      const atomSnapshot = /substr\(key, 1, 512\).*FROM atom WHERE thread_id = \? AND source_seq = \?/u.test(
        normalized,
      );
      const fullSource = /SELECT seq, role, content, content_hash, hash, meta FROM episode/u.test(normalized);
      if (!sourceScalar && !atomSnapshot && !fullSource) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "get") {
            return (...parameters: unknown[]) => {
              if (sourceScalar && parameters.includes(source.seq)) stats.sourceScalars += 1;
              if (fullSource && parameters.includes(source.seq)) stats.fullSourceGets += 1;
              const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
              return method.apply(target, parameters);
            };
          }
          if (property === "all") {
            return (...parameters: unknown[]) => {
              const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
              const rows = method.apply(target, parameters) as unknown[];
              if (atomSnapshot && parameters.includes(source.seq)) {
                stats.atomSnapshots += 1;
                stats.atomRows += rows.length;
              }
              return rows;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof db.query;
    try {
      const verified = verify(vault, thread.id, { full: true });
      expect(verified.ok, verified.reason).toBe(true);
    } finally {
      db.query = originalQuery;
    }
    expect(stats.sourceScalars).toBe(1);
    expect(stats.atomSnapshots).toBe(1);
    expect(stats.atomRows).toBe(256);
    expect(stats.fullSourceGets).toBe(0);
  },
  { timeout: 45_000 },
);

test(
  "coverage replay stops hydrating large attachment sources at the issuance work cap",
  async () => {
    const { vault, thread } = tempVault();
    const sourceBytes = 900 * 1024;
    for (let index = 0; index < 5; index += 1) {
      const prefix = `bounded attachment payload ${index}\n`;
      const content = prefix + "x".repeat(sourceBytes - prefix.length);
      vault.episodes.append(thread.id, {
        role: "attachment",
        content,
        blob: {
          bytes: new TextEncoder().encode(content),
          mime: "text/plain",
          name: `bounded-${index}.txt`,
        },
      });
    }
    const provider: Provider = async function* () {
      yield { type: "delta", text: "The bounded attachment payloads are present." };
      yield { type: "done" };
    };
    const result = await runTurn(vault, thread.id, {
      text: "List every bounded attachment payload.",
      model: "integrity",
      provider,
      budget: 8192,
    });
    expect(result.packet.coverage?.routesRun).toContainEqual(
      expect.objectContaining({ route: "search", status: "unresolved" }),
    );

    let hydratedBytes = 0;
    let hydratedSources = 0;
    const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
    const originalQuery = db.query;
    db.query = ((sql: string, ...args: unknown[]) => {
      const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
      if (
        sql.replace(/\s+/gu, " ").trim() !== "SELECT content FROM episode WHERE thread_id = ? AND seq = ?"
      ) {
        return statement;
      }
      return new Proxy(statement, {
        get(target, property) {
          if (property !== "get") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const row = method.apply(target, parameters) as { content?: string } | null;
            if (typeof row?.content === "string") {
              hydratedSources += 1;
              hydratedBytes += new TextEncoder().encode(row.content).byteLength;
            }
            return row;
          };
        },
      });
    }) as typeof db.query;
    try {
      const verified = verify(vault, thread.id, { full: true });
      expect(verified.ok, verified.reason).toBe(true);
    } finally {
      db.query = originalQuery;
    }
    expect(hydratedSources).toBeGreaterThan(0);
    expect(hydratedSources).toBeLessThanOrEqual(5);
    expect(hydratedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  },
  { timeout: 60_000 },
);

test("verify keeps a collection receipt valid when its source is forgotten later", async () => {
  const fixture = await coverageGrounded();
  expect(verify(fixture.vault, fixture.thread.id, { full: true }).ok).toBe(true);
  forget(fixture.vault, fixture.thread.id, { seqs: [1], reason: "later coverage forget" });
  expect(verify(fixture.vault, fixture.thread.id, { full: true }).ok).toBe(true);
});

test("verify keeps a coverage receipt bound when its asking question is forgotten later", async () => {
  const fixture = await coverageGrounded();
  expect(verify(fixture.vault, fixture.thread.id, { full: true }).ok).toBe(true);
  forget(fixture.vault, fixture.thread.id, {
    seqs: [fixture.result.userEpisode.seq],
    reason: "later question forget",
  });
  const verified = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(verified.ok, verified.reason).toBe(true);
});

test("verify keeps an unresolved opaque attachment receipt valid after later forget", async () => {
  const { vault, thread } = tempVault();
  const content = "Launch note alpha was extracted from the attachment.";
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: {
      bytes: new TextEncoder().encode("opaque bytes with no indexed prefix"),
      mime: "text/plain",
      name: "opaque-integrity.txt",
    },
  });
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found one launch note." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "List every 1 launch note.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  const coverage = result.packet.coverage;
  if (coverage === undefined) throw new Error("opaque attachment fixture has no coverage");
  expect(coverage.routes.some((route) => route.status === "unresolved")).toBe(true);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  forget(vault, thread.id, { seqs: [attachment.seq], reason: "later opaque attachment forget" });
  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok, verified.reason).toBe(true);
});

test("verify replays a resolved-empty page record as one bounded page member", async () => {
  const { vault, thread } = tempVault();
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found no launch notes." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "List every launch note.",
    model: "integrity",
    provider,
    budget: 8192,
    compileOptions: { noPages: true },
  });
  const emptyPage: PageRecord = {
    trigger: "search",
    seqs: [],
    tokens: 0,
    latencyMs: 0,
    resolved: true,
    routeId: "resolved-empty-integrity-oracle",
  };
  const coverage = coverageFor(vault, thread.id, {
    question: result.userEpisode.content,
    querySeq: result.userEpisode.seq,
    pages: [emptyPage],
    routerVersion: result.packet.coverage?.routerVersion ?? "2",
  });
  if (coverage === undefined) throw new Error("resolved-empty page fixture has no coverage");
  expect(coverage.basis.routeMembers.pages.members).toHaveLength(1);
  expect(coverage.basis.routeMembers.pages.members[0]?.sourceSeq).toBe(0);
  rewritePacketPages({ vault, thread, result }, [emptyPage], coverage);
  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok, verified.reason).toBe(true);
});

test(
  "verify caps resolved page replay at 256 members and rejects sentinel or retained-tail tamper",
  async () => {
    const { vault, thread } = tempVault({ budget: 1024 });
    const sources = Array.from({ length: 1025 }, (_, index) =>
      vault.episodes.append(thread.id, {
        role: "user",
        content: `bounded page source ${index + 1} with no collection subject.`,
      }),
    );
    const provider: Provider = async function* () {
      yield { type: "delta", text: "I found 1024 records." };
      yield { type: "done" };
    };
    const result = await runTurn(vault, thread.id, {
      text: "List every 1024 records.",
      model: "integrity",
      provider,
      budget: 8192,
      compileOptions: { noPages: true },
    });
    const pages: PageRecord[] = sources.map((source, index) => ({
      trigger: "explicit",
      seqs: [source.seq],
      tokens: 1,
      latencyMs: 0,
      resolved: true,
      routeId: `bounded-page-${index}`,
    }));
    const coverage = coverageFor(vault, thread.id, {
      question: result.userEpisode.content,
      querySeq: result.userEpisode.seq,
      pages,
      routerVersion: result.packet.coverage?.routerVersion ?? "2",
    });
    if (coverage === undefined) throw new Error("bounded page fixture has no coverage");
    expect(coverage.basis.routeMembers.pages.members).toHaveLength(257);
    expect(coverage.basis.routeMembers.pages.members.at(-1)?.key).toBe("__page-overflow__");
    expect(coverage.routesRun).toContainEqual(
      expect.objectContaining({ route: "pages", returned: 1025, status: "unresolved" }),
    );
    rewritePacketPages({ vault, thread, result }, pages, coverage);

    let tailLookups = 0;
    let episodeGets = 0;
    const tailSeq = sources.at(-1)?.seq;
    if (tailSeq === undefined) throw new Error("bounded page tail source disappeared");
    const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
    const originalQuery = db.query;
    db.query = ((sql: string, ...args: unknown[]) => {
      const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
      if (!/\bFROM episode\b/iu.test(sql)) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "get") {
            return (...parameters: unknown[]) => {
              episodeGets += 1;
              if (parameters.includes(tailSeq)) tailLookups += 1;
              const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
              return method.apply(target, parameters);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof db.query;
    let verified: ReturnType<typeof verify>;
    try {
      verified = verify(vault, thread.id, { full: true });
    } finally {
      db.query = originalQuery;
    }
    expect(verified.ok, verified.reason).toBe(true);
    expect(tailLookups).toBe(0);
    // The verifier may revalidate a bounded source through several independent
    // route/binding checks, but must not turn the 256-member projection into
    // an unbounded scan.  Five source-row reads per retained member is the
    // current fixed ceiling; the remaining reads are packet/route overhead.
    expect(episodeGets).toBeLessThanOrEqual(5 * 256 + 32);

    rewriteCoverageChain({ vault, thread, result }, (original) => {
      const changed = rehashCoverageBasis(original, (basis) => {
        const pageRoute = basis.routeMembers.pages;
        pageRoute.members = pageRoute.members.slice(0, 256);
        pageRoute.memberCount = 256;
      });
      changed.routesRun = changed.routesRun.map((run) =>
        run.route === "pages" ? { ...run, returned: 256, status: "complete" } : run,
      );
      changed.completeness = "complete";
      return rehashCoverageBasis(changed, () => undefined);
    });
    const sentinelTamper = verify(vault, thread.id, { full: true });
    expect(sentinelTamper.ok).toBe(false);
    expect(sentinelTamper.reason).toMatch(/page|sentinel|basis|route/i);

    rewritePacketPages({ vault, thread, result }, pages, coverage);
    rewriteCoverageChain({ vault, thread, result }, (original) => {
      const changed = rehashCoverageBasis(original, (basis) => {
        const pageRoute = basis.routeMembers.pages;
        const retainedTail = pageRoute.members[255];
        if (retainedTail === undefined) throw new Error("bounded page retained tail disappeared");
        pageRoute.members[255] = {
          ...retainedTail,
          sourceSeq: tailSeq,
          contentHash: sha256(new TextEncoder().encode(sources.at(-1)?.content ?? "")),
        };
      });
      return rehashCoverageBasis(changed, () => undefined);
    });
    const retainedTailTamper = verify(vault, thread.id, { full: true });
    expect(retainedTailTamper.ok).toBe(false);
    expect(retainedTailTamper.reason).toMatch(/page|basis|source|locator|route/i);
  },
  { timeout: 45_000 },
);

test("verify evaluates an atom locator at the collection query snapshot after correction", async () => {
  const { vault, thread } = tempVault();
  const lisbon = vault.episodes.append(thread.id, { role: "user", content: "My name is Lisbon." });
  atomize(vault, thread.id, [lisbon.seq]);
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found Lisbon." };
    yield { type: "done" };
  };
  await runTurn(vault, thread.id, {
    text: "List every 1 Lisbon record.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  const porto = vault.episodes.append(thread.id, { role: "user", content: "My name is Porto." });
  atomize(vault, thread.id, [porto.seq]);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("verify keeps a non-ASCII atom locator valid after later deletion without reading tombstone bytes", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, { role: "user", content: "Élodie lives in Lisbon." });
  const from = source.content.indexOf("Lisbon");
  const atom: Atom = {
    id: "integrity-nonascii-atom",
    threadId: thread.id,
    kind: "identity",
    key: "identity.location",
    value: "Lisbon",
    text: source.content,
    sourceSeq: source.seq,
    sourceSpan: [from, from + "Lisbon".length],
    validFromSeq: source.seq,
    phase: "SUPPORTED",
    authority: "user",
    scope: "global",
    pinned: false,
    confidence: 1,
    createdBy: "integrity-oracle",
    createdAt: 1,
  };
  vault.atoms.insert(atom);
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found Lisbon." };
    yield { type: "done" };
  };
  await runTurn(vault, thread.id, {
    text: "List every 1 Lisbon record.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  forget(vault, thread.id, { seqs: [source.seq], reason: "later atom coverage forget" });
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("verify rejects a forged locator for a source deleted before the asking snapshot", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, { role: "user", content: "The launch note was Oslo." });
  const originalHash = sha256(source.content);
  forget(vault, thread.id, { seqs: [source.seq], reason: "deleted before query" });
  const provider: Provider = async function* () {
    yield { type: "delta", text: "I found one launch note." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "List every launch note.",
    model: "integrity",
    provider,
    budget: 8192,
  });
  const byteRange: [number, number] = [0, "The launch note was Oslo.".length];
  rewriteCoverageChain({ vault, thread, result }, (coverage) => {
    const body = {
      route: "search" as const,
      source: `episode:${source.seq}`,
      byteRange,
      revision: `episode:${source.seq}:${originalHash}`,
      authority: "user" as const,
      status: "supported" as const,
    };
    return {
      ...coverage,
      located: 1,
      supported: 1,
      historical: 0,
      unresolved: 0,
      completeness: "not-established",
      routes: [{ ...body, digest: canonicalHash(body) }],
    };
  });
  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok).toBe(false);
  expect(verified.reason).toMatch(/deleted before query snapshot|coverage locator source/i);
});

test("verify rejects a receipt digest tamper", async () => {
  const fixture = await grounded();
  const row = fixture.vault.db
    .query("SELECT answer_receipt FROM packet WHERE id = ?")
    .get(fixture.packetId) as { answer_receipt: string };
  const receipt = JSON.parse(row.answer_receipt) as { digest: string };
  receipt.digest = "0".repeat(64);
  fixture.vault.db
    .query("UPDATE packet SET answer_receipt = ? WHERE id = ?")
    .run(JSON.stringify(receipt), fixture.packetId);
  expect(verify(fixture.vault, fixture.thread.id, { full: true }).ok).toBe(false);
});

test("verify rejects a legacy bare episode witness even when the chain is recomputed", async () => {
  const fixture = await grounded();
  expect(verify(fixture.vault, fixture.thread.id, { full: true }).ok).toBe(true);
  rewriteReceiptWithBareEpisodeWitness(fixture);
  const result = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/supported evidence witness is missing|malformed/i);
});

test("verify rejects an untyped duplicate-hash attachment witness", async () => {
  const fixture = await groundedAttachment(true);
  rewriteReceiptWithBareAttachmentWitness(fixture, fixture.hash, [0, fixture.bytes.byteLength]);
  const result = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/supported evidence witness is malformed|attachment evidence witness/i);
});

test("verify never loads a whole large blob for an untyped attachment witness", async () => {
  const fixture = await groundedAttachment();
  rewriteReceiptWithBareAttachmentWitness(fixture, fixture.hash, [0, fixture.bytes.byteLength]);
  const originalGet = fixture.vault.blobs.get;
  let calls = 0;
  fixture.vault.blobs.get = (hash: string) => {
    calls += 1;
    return originalGet(hash);
  };
  const result = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(calls).toBe(0);
});

test("verify revalidates an active route witness against surviving bytes", async () => {
  const fixture = await grounded();
  const row = fixture.vault.db
    .query("SELECT query_digest, router_version, witnesses FROM address_route WHERE id = ?")
    .get(fixture.routeId) as { query_digest: string; router_version: string; witnesses: string };
  const witnesses = JSON.parse(row.witnesses) as Array<Record<string, unknown>>;
  witnesses[0] = { ...witnesses[0], contentHash: "0".repeat(64) };
  const digest = addressRouteDigestOf(
    row.query_digest,
    row.router_version,
    witnesses as unknown as AddressWitness[],
  );
  fixture.vault.db
    .query("UPDATE address_route SET witnesses = ?, route_digest = ? WHERE id = ?")
    .run(JSON.stringify(witnesses), digest, fixture.routeId);
  const result = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/active address witness/i);
});

test("verify rejects an active route digest tamper", async () => {
  const fixture = await grounded();
  fixture.vault.db
    .query("UPDATE address_route SET route_digest = ? WHERE id = ?")
    .run("0".repeat(64), fixture.routeId);
  const result = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/address route digest/i);
});

test("verify rejects an invalidation event whose parent pointer was tampered", async () => {
  const fixture = await grounded();
  const event = invalidateAddressRoute(fixture.vault, fixture.routeId, "source revised");
  if (event === null) throw new Error("invalidation fixture did not create an event");
  fixture.vault.db
    .query("UPDATE address_route SET invalidated_by = ? WHERE id = ?")
    .run("missing-parent", event.id);
  const result = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/invalidation parent/i);
});

test("verify rejects an invalidation event digest tamper", async () => {
  const fixture = await grounded();
  const event = invalidateAddressRoute(fixture.vault, fixture.routeId, "source revised");
  if (event === null) throw new Error("invalidation fixture did not create an event");
  fixture.vault.db
    .query("UPDATE address_route SET route_digest = ? WHERE id = ?")
    .run("0".repeat(64), event.id);
  const result = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/invalidation digest/i);
});

test("verify keeps contextual invalidation checks bounded by the parent edge", async () => {
  const fixture = await grounded();
  const parent = fixture.vault.db.query("SELECT * FROM address_route WHERE id = ?").get(fixture.routeId) as {
    thread_id: string;
    query_digest: string;
    normalized_query: string;
    router_version: string;
    question_seq: number;
    answer_seq: number | null;
    packet_id: string | null;
    packet_digest: string | null;
    source_seqs: string;
    witnesses: string;
    route_digest: string;
    created_at: number;
  } | null;
  if (parent === null) throw new Error("high-cardinality route parent disappeared");
  const duplicateCount = 320;
  for (let index = 0; index < duplicateCount; index += 1) {
    fixture.vault.db
      .query(
        "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, " +
          "answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?)",
      )
      .run(
        `contextual-route-${index}`,
        parent.thread_id,
        parent.query_digest,
        parent.normalized_query,
        parent.router_version,
        parent.question_seq,
        parent.answer_seq,
        parent.packet_id,
        parent.packet_digest,
        parent.source_seqs,
        parent.witnesses,
        parent.route_digest,
        Number(parent.created_at) + index + 1,
      );
  }

  const stats = { calls: 0, rows: 0 };
  const db = fixture.vault.db as unknown as {
    query: (sql: string, ...args: unknown[]) => unknown;
  };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(fixture.vault.db, sql, ...args) as Record<string, unknown>;
    if (!/SELECT rowid AS __rowid, id FROM address_route/iu.test(sql)) return statement;
    stats.calls += 1;
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const rows = method.apply(target, parameters) as unknown[];
            stats.rows += rows.length;
            return rows;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.query;
  try {
    const reused = fixture.vault.addresses.reuse(
      fixture.thread.id,
      "What was the contract amount?",
      String(parent.router_version),
    );
    expect(reused.reused).toBe(true);
    const result = verify(fixture.vault, fixture.thread.id, { full: true });
    expect(result.ok, result.reason).toBe(true);
  } finally {
    db.query = originalQuery;
  }
  expect(stats.calls).toBe(0);
  expect(stats.rows).toBe(0);
});

test("address closure probes use the answer-packet route index", async () => {
  const fixture = await grounded();
  const plan = fixture.vault.db
    .query(
      "EXPLAIN QUERY PLAN SELECT rowid AS __rowid, * FROM address_route " +
        "WHERE thread_id = ? AND answer_seq = ? AND packet_id = ? AND status = 'active' " +
        "AND rowid > ? ORDER BY rowid ASC LIMIT ?",
    )
    .all(fixture.thread.id, fixture.answerSeq, fixture.packetId, 0, 16) as Array<{ detail?: string }>;
  expect(
    plan.some(
      (entry) => typeof entry.detail === "string" && entry.detail.includes("address_route_answer_packet"),
    ),
  ).toBe(true);
});

test("array route listings fail closed above the bounded audit page", async () => {
  const fixture = await grounded();
  const parent = fixture.vault.db.query("SELECT * FROM address_route WHERE id = ?").get(fixture.routeId) as {
    thread_id: string;
    query_digest: string;
    normalized_query: string;
    router_version: string;
    question_seq: number;
    answer_seq: number | null;
    packet_id: string | null;
    packet_digest: string | null;
    source_seqs: string;
    witnesses: string;
    route_digest: string;
    created_at: number;
  } | null;
  if (parent === null) throw new Error("list-bound parent route disappeared");
  for (let index = 0; index < 256; index += 1) {
    fixture.vault.db
      .query(
        "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, " +
          "answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?)",
      )
      .run(
        `list-bound-route-${index}`,
        parent.thread_id,
        parent.query_digest,
        parent.normalized_query,
        parent.router_version,
        parent.question_seq,
        parent.answer_seq,
        parent.packet_id,
        parent.packet_digest,
        parent.source_seqs,
        parent.witnesses,
        parent.route_digest,
        parent.created_at + index + 1,
      );
  }
  expect(() => fixture.vault.addresses.list(fixture.thread.id)).toThrow(/bounded list page/iu);
});

test("full route and alias verification reads one bounded source snapshot", async () => {
  const fixture = await grounded();
  const giantText = `${"G".repeat(900 * 1024)}\nmarker`;
  const source = fixture.vault.episodes.append(fixture.thread.id, {
    role: "user",
    content: giantText,
  });
  const witness = witnessForEpisode(fixture.vault, fixture.thread.id, source.seq, [0, 64]);
  if (witness === null) throw new Error("giant source witness was not produced");
  const parent = fixture.vault.db.query("SELECT * FROM address_route WHERE id = ?").get(fixture.routeId) as {
    query_digest: string;
    normalized_query: string;
    router_version: string;
    question_seq: number;
    answer_seq: number;
    packet_id: string;
    packet_digest: string;
  } | null;
  if (parent === null) throw new Error("giant source route parent disappeared");
  const routeDigest = addressRouteDigestOf(parent.query_digest, parent.router_version, [witness]);
  for (let index = 0; index < 48; index += 1) {
    fixture.vault.db
      .query(
        "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, " +
          "answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?)",
      )
      .run(
        `giant-route-${index}`,
        fixture.thread.id,
        parent.query_digest,
        parent.normalized_query,
        parent.router_version,
        parent.question_seq,
        parent.answer_seq,
        parent.packet_id,
        parent.packet_digest,
        JSON.stringify([source.seq]),
        JSON.stringify([witness]),
        routeDigest,
        Date.now() + index + 1,
      );
  }
  const sourceBytes = new TextEncoder().encode(giantText);
  const quoteBytes = sourceBytes.slice(0, 64);
  const groundedSourceBytes = new TextEncoder().encode(
    fixture.vault.episodes.get(fixture.thread.id, 1)?.content ?? "",
  ).byteLength;
  for (let index = 0; index < 48; index += 1) {
    fixture.vault.db
      .query(
        "INSERT INTO address_alias (id, thread_id, alias, source_seq, byte_from, byte_to, source_hash, quote_hash, authority, status, created_at) " +
          "VALUES (?, ?, ?, ?, 0, 64, ?, ?, 'model', 'proposed', ?)",
      )
      .run(
        `giant-alias-${index}`,
        fixture.thread.id,
        `giant alias ${index}`,
        source.seq,
        sha256(giantText),
        sha256(quoteBytes),
        Date.now() + index + 1,
      );
  }

  let sourceReads = 0;
  let sourceBytesRead = 0;
  let giantSourceReads = 0;
  let packetBodyReads = 0;
  let maxRouteRows = 0;
  let maxRouteJsonBytes = 0;
  const db = fixture.vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
  const originalQuery = db.query;
  const packets = fixture.vault.packets as unknown as { byId: (id: string) => unknown };
  const originalPacketById = packets.byId;
  packets.byId = (id: string) => {
    packetBodyReads += 1;
    return originalPacketById.call(fixture.vault.packets, id);
  };
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(fixture.vault.db, sql, ...args) as Record<string, unknown>;
    if (
      !/SELECT content, content_hash, hash, role, meta FROM episode WHERE thread_id = \? AND seq = \?/iu.test(
        sql,
      )
    ) {
      if (!/SELECT rowid AS __rowid, \* FROM address_route WHERE thread_id = \?/iu.test(sql)) {
        return statement;
      }
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") {
            return (...parameters: unknown[]) => {
              const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
              const rows = method.apply(target, parameters) as Array<Record<string, unknown>>;
              maxRouteRows = Math.max(maxRouteRows, rows.length);
              maxRouteJsonBytes = Math.max(
                maxRouteJsonBytes,
                rows.reduce(
                  (total, row) =>
                    total +
                    (typeof row.source_seqs === "string"
                      ? new TextEncoder().encode(row.source_seqs).byteLength
                      : 0) +
                    (typeof row.witnesses === "string"
                      ? new TextEncoder().encode(row.witnesses).byteLength
                      : 0),
                  0,
                ),
              );
              return rows;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    return new Proxy(statement, {
      get(target, property) {
        if (property === "get") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const row = method.apply(target, parameters) as Record<string, unknown> | null;
            if (row !== null) {
              sourceReads += 1;
              if (parameters[1] === source.seq) giantSourceReads += 1;
              sourceBytesRead +=
                typeof row.content === "string" ? new TextEncoder().encode(row.content).byteLength : 0;
            }
            return row;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.query;
  try {
    const result = verify(fixture.vault, fixture.thread.id, { full: true });
    expect(result.ok, result.reason).toBe(true);
  } finally {
    db.query = originalQuery;
    packets.byId = originalPacketById;
  }
  expect(giantSourceReads).toBe(1);
  expect(sourceReads).toBeLessThanOrEqual(2);
  expect(sourceBytesRead).toBeLessThanOrEqual(sourceBytes.byteLength + groundedSourceBytes);
  expect(packetBodyReads).toBe(1);
  expect(maxRouteRows).toBeLessThanOrEqual(16);
  expect(maxRouteJsonBytes).toBeLessThanOrEqual(16 * 256 * 1024);
});

test("full route replay groups cyclic sources before bounded witness reads", async () => {
  const fixture = await grounded();
  const parent = fixture.vault.db.query("SELECT * FROM address_route WHERE id = ?").get(fixture.routeId) as {
    query_digest: string;
    normalized_query: string;
    router_version: string;
    question_seq: number;
    answer_seq: number;
    packet_id: string;
    packet_digest: string;
  } | null;
  if (parent === null) throw new Error("cyclic-source parent route disappeared");
  const sources: Array<{ seq: number; witness: AddressWitness }> = [];
  for (let index = 0; index < 129; index += 1) {
    const source = fixture.vault.episodes.append(fixture.thread.id, {
      role: "user",
      content: `${"C".repeat(64 * 1024)}${index}`,
    });
    const witness = witnessForEpisode(fixture.vault, fixture.thread.id, source.seq, [0, 64]);
    if (witness === null) throw new Error("cyclic-source witness was not produced");
    sources.push({ seq: source.seq, witness });
  }
  let routeIndex = 0;
  // Interleave the sources in insertion order.  The verifier must stage and
  // replay by source sequence; a 128-entry LRU alone would thrash source 129.
  for (let repeat = 0; repeat < 4; repeat += 1) {
    for (const source of sources) {
      const routeDigest = addressRouteDigestOf(parent.query_digest, parent.router_version, [source.witness]);
      fixture.vault.db
        .query(
          "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, " +
            "answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?)",
        )
        .run(
          `cyclic-source-route-${routeIndex}`,
          fixture.thread.id,
          parent.query_digest,
          "what was the contract amount?",
          parent.router_version,
          parent.question_seq,
          parent.answer_seq,
          parent.packet_id,
          parent.packet_digest,
          JSON.stringify([source.seq]),
          JSON.stringify([source.witness]),
          routeDigest,
          Date.now() + routeIndex + 1,
        );
      routeIndex += 1;
    }
  }
  const reads = new Map<number, number>();
  const db = fixture.vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(fixture.vault.db, sql, ...args) as Record<string, unknown>;
    if (
      !/SELECT content, content_hash, hash, role, meta FROM episode WHERE thread_id = \? AND seq = \?/iu.test(
        sql,
      )
    ) {
      return statement;
    }
    return new Proxy(statement, {
      get(target, property) {
        if (property === "get") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const row = method.apply(target, parameters) as Record<string, unknown> | null;
            if (row !== null && Number.isSafeInteger(parameters[1])) {
              const seq = parameters[1] as number;
              reads.set(seq, (reads.get(seq) ?? 0) + 1);
            }
            return row;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.query;
  try {
    const result = verify(fixture.vault, fixture.thread.id, { full: true });
    expect(result.ok, result.reason).toBe(true);
  } finally {
    db.query = originalQuery;
  }
  expect(reads.size).toBe(130);
  expect(Math.max(...reads.values())).toBe(1);
});

test("full verification does not impose a cumulative source-cache archive cap", async () => {
  const fixture = await grounded();
  const parent = fixture.vault.db.query("SELECT * FROM address_route WHERE id = ?").get(fixture.routeId) as {
    query_digest: string;
    normalized_query: string;
    router_version: string;
    question_seq: number;
    answer_seq: number;
    packet_id: string;
    packet_digest: string;
  } | null;
  if (parent === null) throw new Error("source-cache parent route disappeared");
  const sourceText = "S".repeat(512 * 1024);
  for (let index = 0; index < 70; index += 1) {
    const source = fixture.vault.episodes.append(fixture.thread.id, {
      role: "user",
      content: `${sourceText}${index}`,
    });
    const witness = witnessForEpisode(fixture.vault, fixture.thread.id, source.seq, [0, 64]);
    if (witness === null) throw new Error("source-cache witness was not produced");
    const routeDigest = addressRouteDigestOf(parent.query_digest, parent.router_version, [witness]);
    fixture.vault.db
      .query(
        "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, " +
          "answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?)",
      )
      .run(
        `distinct-source-route-${index}`,
        fixture.thread.id,
        parent.query_digest,
        parent.normalized_query,
        parent.router_version,
        parent.question_seq,
        parent.answer_seq,
        parent.packet_id,
        parent.packet_digest,
        JSON.stringify([source.seq]),
        JSON.stringify([witness]),
        routeDigest,
        Date.now() + index + 1,
      );
  }
  const result = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(result.ok, result.reason).toBe(true);
});

test("verify keeps a removed assistant receipt bound to its immutable content hash", async () => {
  const fixture = await grounded();
  forget(fixture.vault, fixture.thread.id, {
    seqs: [fixture.answerSeq],
    reason: "integrity oracle",
  });
  const result = verify(fixture.vault, fixture.thread.id, { full: true });
  expect(result.ok).toBe(true);
});
