import { afterAll, expect, test } from "bun:test";
import type { Packet, RequestRound } from "@pylos/protocol";
import { bundlePacketFailure } from "../src/bundle-derived.ts";
import { packetRoundsFailure } from "../src/pure/budget.ts";
import { verify } from "../src/verify.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

function packet(threadId: string, overrides: Partial<Packet> = {}): Packet {
  return {
    id: "packet-budget-oracle",
    threadId,
    turnSeq: 1,
    model: "budget-test",
    budget: 128,
    tokens: 8,
    digest: "a".repeat(64),
    messages: [],
    resident: [],
    ledger: { count: 0, residentNames: [], historical: [] },
    pages: [],
    rounds: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

test("packet insertion rejects a spend above its hard budget before a row exists", () => {
  const { vault, thread } = tempVault();
  const candidate = packet(thread.id, { tokens: 129 });

  expect(() => vault.packets.insert(candidate, "pending")).toThrow(/tokens.*budget/iu);
  expect(vault.db.query("SELECT 1 FROM packet WHERE id = ?").get(candidate.id)).toBeNull();
});

test("packet insertion rejects missing and mismatched round budget fields before a row exists", () => {
  const { vault, thread } = tempVault();
  const round = {
    ordinal: 0,
    messagesDigest: "d".repeat(64),
    tokens: 8,
    budget: 64,
    pages: [],
    admittedPageSeqs: [],
    status: "done" as const,
  };
  const mismatched = packet(thread.id, { id: "packet-round-mismatch", rounds: [round] });
  expect(() => vault.packets.insert(mismatched, "pending")).toThrow(/budget does not match/iu);
  expect(vault.db.query("SELECT 1 FROM packet WHERE id = ?").get(mismatched.id)).toBeNull();

  const missing = packet(thread.id, {
    id: "packet-round-missing",
    rounds: [{ ordinal: 0, pages: [], admittedPageSeqs: [], status: "done" } as unknown as RequestRound],
  });
  expect(() => vault.packets.insert(missing, "pending")).toThrow(/budget fields are missing/iu);
  expect(vault.db.query("SELECT 1 FROM packet WHERE id = ?").get(missing.id)).toBeNull();
});

test("bundle packet admission rejects an independently bounded over-budget spend", () => {
  const row = {
    id: "packet-budget-bundle",
    thread_id: "thread-budget-bundle",
    turn_seq: 1,
    model: "bundle-model",
    budget: 128,
    tokens: 129,
    digest: "b".repeat(64),
    status: "pending",
    compiler_version: "1",
    messages: null,
    resident: "[]",
    ledger: '{"count":0,"residentNames":[],"historical":[]}',
    pages: "[]",
    rounds: "[]",
    created_at: 1,
  };

  expect(bundlePacketFailure(row, row.thread_id)).toMatch(/tokens.*budget/iu);
});

test("bundle packet admission applies the shared round scalar gate", () => {
  const row = {
    id: "packet-round-bundle",
    thread_id: "thread-round-bundle",
    turn_seq: 1,
    model: "bundle-model",
    budget: 128,
    tokens: 8,
    digest: "e".repeat(64),
    status: "pending",
    compiler_version: "1",
    messages: null,
    resident: "[]",
    ledger: '{"count":0,"residentNames":[],"historical":[]}',
    pages: "[]",
    rounds: JSON.stringify([{ ordinal: 0, pages: [], admittedPageSeqs: [], status: "done" }]),
    created_at: 1,
  };
  expect(bundlePacketFailure(row, row.thread_id)).toMatch(/budget fields are missing/iu);
  row.rounds = JSON.stringify([
    { ordinal: 0, tokens: 129, budget: 128, pages: [], admittedPageSeqs: [], status: "done" },
  ]);
  expect(bundlePacketFailure(row, row.thread_id)).toMatch(/tokens.*budget/iu);
  row.rounds = JSON.stringify([
    { ordinal: 0, tokens: 8, budget: 64, pages: [], admittedPageSeqs: [], status: "done" },
  ]);
  expect(bundlePacketFailure(row, row.thread_id)).toMatch(/budget does not match/iu);
});

test("full verify catches a recomputed-row over-budget packet", () => {
  const { vault, thread } = tempVault();
  const stored = packet(thread.id, { id: "packet-over-budget-row" });
  vault.packets.insert(stored, "pending");
  vault.db.query("UPDATE packet SET tokens = budget + 1 WHERE id = ?").run(stored.id);

  const result = verify(vault, thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/packet.*tokens.*budget/iu);
});

test("full verify catches an over-budget round after its stored JSON is recomputed", () => {
  const { vault, thread } = tempVault();
  const validRound = {
    ordinal: 0,
    messagesDigest: "f".repeat(64),
    tokens: 8,
    budget: 128,
    pages: [],
    admittedPageSeqs: [],
    status: "done" as const,
  };
  const stored = packet(thread.id, { id: "packet-over-budget-round", rounds: [validRound] });
  vault.packets.insert(stored, "pending");
  vault.db
    .query("UPDATE packet SET rounds = ? WHERE id = ?")
    .run(JSON.stringify([{ ...validRound, tokens: 129 }]), stored.id);

  const result = verify(vault, thread.id, { full: true });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/round.*tokens.*budget/iu);
});

test("round scalar validation binds each round to the packet budget", () => {
  const round = {
    ordinal: 0,
    messagesDigest: "c".repeat(64),
    tokens: 129,
    budget: 128,
    pages: [],
    admittedPageSeqs: [],
    status: "done",
  };

  expect(packetRoundsFailure([round], 128)).toMatch(/tokens.*budget/iu);
  expect(packetRoundsFailure([{ ...round, tokens: 8, budget: 64 }], 128)).toMatch(/budget does not match/iu);
  expect(packetRoundsFailure([{ ordinal: 0 }], 128)).toMatch(/budget fields are missing/iu);
});
