import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EpisodeInput } from "../src/index.ts";
import {
  atomize,
  compact,
  compile,
  genesisHash,
  openVault,
  type Vault,
  VaultError,
  verify,
} from "../src/index.ts";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function freshVault(): Vault {
  const home = mkdtempSync(join(tmpdir(), "pylos-provenance-"));
  homes.push(home);
  return openVault({ home, fast: true });
}

const EPISODES: EpisodeInput[] = [
  { role: "user", content: "the ledger conserves what the capsule drops", ts: 1_760_000_000_000 },
  {
    role: "assistant",
    content: "and the chain proves it",
    ts: 1_760_000_060_000,
    model: "test",
    provider: "bench",
  },
];

test("an explicit provenance makes two vaults agree on identity and chain", () => {
  const provenance = { id: "th_fixture_seed_7", createdAt: 1_760_000_000_000 };
  const heads = [freshVault(), freshVault()].map((vault) => {
    const thread = vault.threads.create("Fixture", { budget: 8192 }, provenance);
    expect(thread.id).toBe(provenance.id);
    expect(thread.createdAt).toBe(provenance.createdAt);
    expect(thread.headHash).toBe(genesisHash(provenance.id));
    vault.episodes.appendMany(thread.id, EPISODES);
    expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
    const stored = vault.threads.get(thread.id);
    expect(stored?.createdAt).toBe(provenance.createdAt);
    return stored?.headHash;
  });
  expect(heads[0]).toBe(heads[1] as string);
});

test("a duplicate thread id is refused", () => {
  const vault = freshVault();
  vault.threads.create("First", {}, { id: "th_fixture_dup" });
  expect(() => vault.threads.create("Second", {}, { id: "th_fixture_dup" })).toThrow(VaultError);
  expect(() => vault.threads.create("Second", {}, { id: "th_fixture_dup" })).toThrow(/already exists/u);
  expect(vault.threads.get("th_fixture_dup")?.title).toBe("First");
});

test("a malformed provenance is refused", () => {
  const vault = freshVault();
  for (const id of ["", "th_", "fixture", "at_fixture", "th_bad id", "th_bad/id", `th_${"a".repeat(128)}`]) {
    expect(() => vault.threads.create("Bad", {}, { id })).toThrow(/thread id must be/u);
  }
  for (const createdAt of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    expect(() => vault.threads.create("Bad", {}, { createdAt })).toThrow(/createdAt/u);
  }
  expect(vault.threads.list()).toEqual([]);
});

test("an omitted provenance still mints a random id and a clock timestamp", () => {
  const vault = freshVault();
  const before = Date.now();
  const first = vault.threads.create("One");
  const second = vault.threads.create("Two");
  expect(first.id).not.toBe(second.id);
  for (const thread of [first, second]) {
    expect(thread.id.startsWith("th_")).toBe(true);
    expect(thread.createdAt).toBeGreaterThanOrEqual(before);
  }
});

test("two vaults built from the same script derive the same capsules and packets", () => {
  const decisions = [
    "ripgrep for the log pipeline",
    "Litestream for the backup runner",
    "age for the config store",
    "DuckDB for the notification fanout",
    "sops for the search index",
    "pgbouncer for the feature flags",
  ];
  const inputs: EpisodeInput[] = Array.from({ length: 96 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content:
      index % 2 === 0
        ? `Decision: use ${decisions[(index / 2) % decisions.length] as string}.`
        : "Decision recorded.",
    ts: 1_760_000_000_000 + index * 60_000,
  }));
  const derived = [freshVault(), freshVault()].map((vault) => {
    const thread = vault.threads.create(
      "Script",
      { budget: 8192 },
      { id: "th_fixture_script", createdAt: 1_760_000_000_000 },
    );
    vault.tx(() => {
      const written = vault.episodes.appendMany(thread.id, inputs);
      atomize(
        vault,
        thread.id,
        written.map((episode) => episode.seq),
      );
      compact(vault, thread.id, { budget: 8192 });
    });
    return {
      head: vault.threads.get(thread.id)?.headHash,
      capsules: vault.capsules.list(thread.id).map((capsule) => capsule.hash),
      packet: compile(vault, thread.id, { query: "which log pipeline did we choose?", budget: 8192 }).digest,
    };
  });
  expect((derived[0]?.capsules ?? []).length).toBeGreaterThan(0);
  expect(derived[0]).toEqual(derived[1] as (typeof derived)[number]);
});
