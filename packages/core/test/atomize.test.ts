import { afterAll, expect, test } from "bun:test";
import { atomize } from "../src/index.ts";
import { applyRules } from "../src/pure/rules.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

function atomsFor(lines: string[]) {
  const { vault, thread } = tempVault();
  const seqs = lines.map((line) => vault.episodes.append(thread.id, { role: "user", content: line }).seq);
  const created = atomize(vault, thread.id, seqs);
  return { vault, thread, created };
}

test("identity, location and move rules", () => {
  const { created } = atomsFor([
    "My name is Ada Okafor.",
    "I live in Lisbon.",
    "Actually I have moved to Tallinn.",
  ]);
  const byKey = new Map(created.map((a) => [a.key, a]));
  expect(byKey.get("identity.name")?.value).toBe("Ada Okafor");
  const locations = created.filter((a) => a.key === "user.location").map((a) => a.value);
  expect(locations).toEqual(["Lisbon", "Tallinn"]);
});

test("supersession closes the validity interval and never overwrites", () => {
  const { vault, thread, created } = atomsFor(["I live in Lisbon.", "I have moved to Tallinn."]);
  expect(created).toHaveLength(2);
  const history = vault.atoms.historyOf(thread.id, "user.location");
  expect(history).toHaveLength(2);
  const current = history.find((a) => a.phase === "SUPPORTED");
  const previous = history.find((a) => a.phase === "HISTORICAL");
  expect(current?.value).toBe("Tallinn");
  expect(current?.validFromSeq).toBe(2);
  expect(previous?.value).toBe("Lisbon");
  expect(previous?.validFromSeq).toBe(1);
  expect(previous?.validToSeq).toBe(2);
  expect(previous?.supersededBy).toBe(current?.id);
});

test("remember with a copula becomes a revisable slot", () => {
  const { created } = atomsFor(["Remember that the deploy window is Tuesday 09:30."]);
  const atom = created.find((a) => a.key.startsWith("fact."));
  expect(atom?.value).toBe("Tuesday 09:30");
});

test("rules stated after a lead-in clause are still rules", () => {
  const drafts = applyRules(
    "One ground rule for this whole project: never send a production migration before the dry-run database is verified.",
    "user",
  );
  const rule = drafts.find((d) => d.rule === "rule");
  expect(rule).toBeDefined();
  expect(rule?.kind).toBe("preference");
  expect(rule?.value.startsWith("never: send a production migration")).toBe(true);
});

test("a rule revision supersedes by key, not by text", () => {
  const { vault, thread } = tempVault();
  const a = vault.episodes.append(thread.id, {
    role: "user",
    content:
      "One ground rule for this whole project: never send a production migration before the dry-run database is verified.",
  });
  atomize(vault, thread.id, [a.seq]);
  const key = vault.atoms.list(thread.id, { phase: "SUPPORTED" })[0]?.key as string;
  expect(key.startsWith("rule.")).toBe(true);

  const b = vault.episodes.append(thread.id, {
    role: "user",
    content:
      "Update to our migration rule: never send a production migration before the dry-run database is verified — unless the change is additive-only and the dry-run was skipped by the on-call lead.",
  });
  atomize(vault, thread.id, [b.seq]);
  const history = vault.atoms.historyOf(thread.id, key);
  expect(history).toHaveLength(2);
  expect(history[0]?.phase).toBe("SUPPORTED");
  expect(history[0]?.value).toContain("additive-only");
  expect(history[1]?.phase).toBe("HISTORICAL");
  expect(history[1]?.validToSeq).toBe(b.seq);
});

test("decisions and tasks are extracted", () => {
  const { created } = atomsFor([
    "Let's go with Postgres for the ledger store.",
    "Todo: send the migration plan to the on-call lead.",
  ]);
  expect(created.some((a) => a.kind === "decision")).toBe(true);
  expect(created.some((a) => a.kind === "task")).toBe(true);
});

test("a correction of the form 'not X, Y' supersedes the atom holding X", () => {
  const { vault, thread } = tempVault();
  const a = vault.episodes.append(thread.id, { role: "user", content: "I live in Lisbon." });
  atomize(vault, thread.id, [a.seq]);
  const b = vault.episodes.append(thread.id, {
    role: "user",
    content: "Correction: not Lisbon, Porto.",
  });
  atomize(vault, thread.id, [b.seq]);
  const history = vault.atoms.historyOf(thread.id, "user.location");
  expect(history[0]?.value).toBe("Porto");
  expect(history[0]?.phase).toBe("SUPPORTED");
  expect(history[1]?.phase).toBe("HISTORICAL");
});

test("a correction matching no key becomes a new fact, never silently dropped", () => {
  const { created } = atomsFor(["Actually, not Bergen, Tromso."]);
  expect(created.length).toBeGreaterThan(0);
  expect(created.every((a) => a.value.length > 0)).toBe(true);
});

test("restating the same value does not churn the atom table", () => {
  const { vault, thread } = tempVault();
  for (let i = 0; i < 3; i += 1) {
    const e = vault.episodes.append(thread.id, { role: "user", content: "I live in Lisbon." });
    atomize(vault, thread.id, [e.seq]);
  }
  expect(vault.atoms.historyOf(thread.id, "user.location")).toHaveLength(1);
});

test("model-extracted atoms without a verbatim quote are discarded", async () => {
  const { vault, thread } = tempVault();
  const e = vault.episodes.append(thread.id, { role: "user", content: "The launch is on 2026-06-03." });
  const { atomizeWithModel } = await import("../src/index.ts");
  const created = await atomizeWithModel(vault, thread.id, [e.seq], async () => ({
    model: "test",
    atoms: [
      { kind: "fact", key: "launch.date", value: "2026-06-03", text: "launch", quote: "on 2026-06-03" },
      { kind: "fact", key: "launch.venue", value: "Lisbon", text: "venue", quote: "in Lisbon" },
    ],
  }));
  expect(created).toHaveLength(1);
  expect(created[0]?.key).toBe("launch.date");
  expect(created[0]?.createdBy).toBe("model:test");
});
