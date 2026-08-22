import { afterAll, expect, test } from "bun:test";
import {
  atomize,
  compact,
  levelSpan,
  nameSet,
  ROOT_LEVEL,
  residentCapsules,
  residentLeafCount,
  sourceNamesForRange,
} from "../src/index.ts";
import { resolves } from "../src/page.ts";
import { cleanup, rng, syntheticTurn, tempVault } from "./helpers.ts";

afterAll(cleanup);

function fill(seed: number, count: number, settings: Record<string, unknown> = {}) {
  const { vault, thread } = tempVault(settings);
  const next = rng(seed);
  const inputs = Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: syntheticTurn(next, i),
  }));
  for (let i = 0; i < inputs.length; i += 64) {
    const batch = inputs.slice(i, i + 64);
    const appended = vault.episodes.appendMany(thread.id, batch);
    atomize(
      vault,
      thread.id,
      appended.map((e) => e.seq),
    );
    compact(vault, thread.id, { budget: 8192 });
  }
  return { vault, thread };
}

test("capsules seal on the 32 / 256 / 2048 schedule", () => {
  const { vault, thread } = fill(11, 640);
  expect(levelSpan(0)).toBe(32);
  expect(levelSpan(1)).toBe(256);
  expect(levelSpan(2)).toBe(2048);
  expect(vault.capsules.list(thread.id, 0, 1000)).toHaveLength(640 / 32);
  expect(vault.capsules.list(thread.id, 1, 1000)).toHaveLength(2);
  expect(vault.capsules.list(thread.id, 2, 1000)).toHaveLength(0);
});

test("compaction is idempotent", () => {
  const { vault, thread } = fill(12, 256);
  const before = vault.capsules.count(thread.id);
  const losses = vault.losses.total(thread.id);
  expect(compact(vault, thread.id, { budget: 8192 })).toHaveLength(0);
  expect(vault.capsules.count(thread.id)).toBe(before);
  expect(vault.losses.total(thread.id)).toBe(losses);
});

test("the resident capsule set is fixed-size and covers a contiguous prefix", () => {
  for (const count of [320, 640, 1280, 2560]) {
    const { vault, thread } = fill(13, count);
    const resident = residentCapsules(vault, thread.id);
    expect(resident.length).toBeLessThanOrEqual(residentLeafCount(8192) + 1);
    expect(resident[0]?.level).toBe(ROOT_LEVEL);
    expect(resident[0]?.fromSeq).toBe(1);
    for (let i = 1; i < resident.length; i += 1) {
      expect(resident[i]?.fromSeq).toBe((resident[i - 1]?.toSeq ?? 0) + 1);
    }
    // The cover reaches the last sealed leaf; the recent window takes the rest.
    const lastLeaf = Math.floor(count / 32) * 32;
    expect(resident.at(-1)?.toSeq).toBe(lastLeaf);
  }
});

test("completeness: every source name is either in the capsule text or in its ledger", () => {
  const { vault, thread } = fill(14, 1024);
  for (const capsule of vault.capsules.list(thread.id, undefined, 200)) {
    const source = sourceNamesForRange(vault, thread.id, capsule.fromSeq, capsule.toSeq);
    const present = nameSet(capsule.text, { max: 8192 });
    const ledger = new Set(
      vault.losses.inRange(thread.id, capsule.fromSeq, capsule.toSeq).map((l) => l.name),
    );
    const unaccounted = [...new Set(source.map((s) => s.name))].filter(
      (name) => !present.has(name) && !ledger.has(name),
    );
    expect({ capsule: capsule.id, unaccounted }).toEqual({ capsule: capsule.id, unaccounted: [] });
  }
});

test("a proposal is never a capsule certificate, but its key is still in the ledger", () => {
  const { vault, thread } = tempVault();
  const claimed = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "Halden Works is based in Valletta.",
  });
  atomize(vault, thread.id, [claimed.seq]);
  const key = "person.halden-works.location";
  expect(vault.atoms.byKey(thread.id, key, "PROPOSED")).toHaveLength(1);

  const next = rng(16);
  for (let i = 0; i < 64; i += 1) {
    const appended = vault.episodes.append(thread.id, {
      role: "user",
      content: syntheticTurn(next, i),
    });
    atomize(vault, thread.id, [appended.seq]);
  }
  compact(vault, thread.id, { budget: 8192 });

  const capsule = vault.capsules.list(thread.id, 0, 10).find((c) => c.fromSeq <= 1 && c.toSeq >= 1);
  expect(capsule).toBeDefined();
  const sealed = capsule as NonNullable<typeof capsule>;
  // No certificate line for a proposal — a model's claim never reads as settled.
  expect(sealed.text).not.toContain(`${key} = Valletta`);
  // But the key is accounted for: dropped, with an exact locator.
  const entry = vault.losses.inRange(thread.id, sealed.fromSeq, sealed.toSeq).find((l) => l.name === key);
  expect(entry?.kind).toBe("atom");
  expect(entry?.seq).toBe(1);

  const source = sourceNamesForRange(vault, thread.id, sealed.fromSeq, sealed.toSeq);
  const present = nameSet(sealed.text, { max: 8192 });
  const ledger = new Set(vault.losses.inRange(thread.id, sealed.fromSeq, sealed.toSeq).map((l) => l.name));
  const unaccounted = [...new Set(source.map((s) => s.name))].filter(
    (name) => !present.has(name) && !ledger.has(name),
  );
  expect(unaccounted).toEqual([]);
});

test("conservation: a parent's ledger contains every child's ledger", () => {
  const { vault, thread } = fill(15, 2048);
  let checked = 0;
  for (let level = 1; level <= 2; level += 1) {
    for (const parent of vault.capsules.list(thread.id, level, 200)) {
      const parentLedger = new Set(
        vault.losses.inRange(thread.id, parent.fromSeq, parent.toSeq).map((l) => l.name),
      );
      for (const child of vault.capsules.children(thread.id, level, parent.fromSeq, parent.toSeq)) {
        for (const entry of vault.losses.inRange(thread.id, child.fromSeq, child.toSeq)) {
          expect(parentLedger.has(entry.name)).toBe(true);
        }
        checked += 1;
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test("the ledger is monotone across repeated compaction", () => {
  const { vault, thread } = tempVault();
  const next = rng(16);
  let previous = 0;
  for (let round = 0; round < 12; round += 1) {
    vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 64 }, (_, i) => ({
        role: "user" as const,
        content: syntheticTurn(next, round * 64 + i),
      })),
    );
    compact(vault, thread.id, { budget: 8192 });
    compact(vault, thread.id, { budget: 8192 });
    const total = vault.losses.total(thread.id);
    expect(total).toBeGreaterThanOrEqual(previous);
    previous = total;
  }
  expect(previous).toBeGreaterThan(0);
});

test("exact pageability: every loss row resolves to a span containing the name", () => {
  const { vault, thread } = fill(17, 512);
  const rows = vault.db
    .query("SELECT name, kind, seq, span FROM loss WHERE thread_id = ? AND capsule_id != 'frontier'")
    .all(thread.id) as Array<{ name: string; kind: string; seq: number; span: string | null }>;
  expect(rows.length).toBeGreaterThan(100);
  let checkedSpans = 0;
  for (const row of rows) {
    const episode = vault.episodes.get(thread.id, row.seq);
    expect(episode).not.toBeNull();
    const content = (episode as { content: string }).content;
    const found = resolves(vault, thread.id, content, row.seq, row);
    expect({ name: row.name, seq: row.seq, found }).toEqual({
      name: row.name,
      seq: row.seq,
      found: true,
    });
    if (row.span !== null) {
      const [start, end] = JSON.parse(row.span) as [number, number];
      const slice = content.slice(start, end);
      expect(slice.length).toBeGreaterThan(0);
      checkedSpans += 1;
    }
  }
  expect(checkedSpans).toBeGreaterThan(50);
});

test("the model writer's output is hard-truncated by the kernel", () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 64 }, (_, i) => ({ role: "user" as const, content: `Turn ${i} about Lisbon.` })),
  );
  const capsules = compact(vault, thread.id, {
    budget: 8192,
    writer: () => `${"Overlong prose about Lisbon and Porto. ".repeat(400)}`,
  });
  const leaf = capsules.find((c) => c.level === 0);
  expect(leaf).toBeDefined();
  expect(leaf?.tokens).toBeLessThanOrEqual(205);
  expect(leaf?.createdBy).toBe("model");
});
