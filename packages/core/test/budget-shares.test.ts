import { afterAll, expect, test } from "bun:test";
import * as core from "../src/index.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

const validShares = { header: 0.04, frontier: 0.2, capsules: 0.18, paged: 0.18 };

test("budget shares are an exact four-key finite allocation", () => {
  expect(core.budgetSharesFailure(validShares)).toBeNull();
  expect(core.budgetSharesFailure({})).toMatch(/exactly/iu);
  expect(core.budgetSharesFailure({ ...validShares, extra: 0 })).toMatch(/exactly/iu);
  expect(core.budgetSharesFailure({ ...validShares, frontier: Number.NaN })).toMatch(/finite/iu);
  expect(core.budgetSharesFailure({ header: 0.25, frontier: 0.25, capsules: 0.25, paged: 0.26 })).toMatch(
    /at most 1/iu,
  );
});

test("invalid shares fail settings writes without changing the row", () => {
  const { vault, thread } = tempVault();
  const before = vault.threads.get(thread.id);
  expect(() =>
    vault.threads.setSettings(thread.id, {
      ...(before?.settings ?? {}),
      shares: {} as never,
    }),
  ).toThrow(/shares/iu);
  expect(vault.threads.get(thread.id)).toEqual(before);
});

test("direct compile refuses an over-budget mandatory packet", () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "tiny row" });
  for (const budget of [1, 64, 128]) {
    expect(() => core.compile(vault, thread.id, { budget, query: "" })).toThrow(
      /compiled packet costs|packet_too_large/iu,
    );
  }
});

test("invalid shares reject compile and turn before durable rows", async () => {
  const { vault, thread } = tempVault();
  const before = vault.threads.get(thread.id);
  const beforeEpisodes = vault.episodes.count(thread.id);
  const beforePackets = (vault.db.query("SELECT COUNT(*) AS count FROM packet").get() as { count: number })
    .count;
  expect(() =>
    core.compile(vault, thread.id, {
      query: "compile must not write",
      shares: { header: 1, frontier: 1, capsules: 0, paged: 0 } as never,
    }),
  ).toThrow(/shares/iu);
  expect(vault.episodes.count(thread.id)).toBe(beforeEpisodes);
  expect((vault.db.query("SELECT COUNT(*) AS count FROM packet").get() as { count: number }).count).toBe(
    beforePackets,
  );

  let providerCalls = 0;
  const provider: core.Provider = async function* () {
    providerCalls += 1;
    yield { type: "done" };
  };
  await expect(
    core.runTurn(vault, thread.id, {
      text: "turn must not write",
      model: "test",
      provider,
      compileOptions: { shares: {} as never },
    }),
  ).rejects.toThrow(/shares/iu);
  expect(providerCalls).toBe(0);
  expect(vault.threads.get(thread.id)).toEqual(before);
  expect(vault.episodes.count(thread.id)).toBe(beforeEpisodes);
  expect((vault.db.query("SELECT COUNT(*) AS count FROM packet").get() as { count: number }).count).toBe(
    beforePackets,
  );
});
