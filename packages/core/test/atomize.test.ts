import { afterAll, expect, test } from "bun:test";
import { CAPSULE_SOURCE_EPISODE_BYTES, CAPSULE_SOURCE_NAMES_PER_EPISODE } from "@pylos/protocol";
import { atomize, compile, packetText, page, stats } from "../src/index.ts";
import { names } from "../src/pure/names.ts";
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

test("an assistant claim proposes, it never becomes current truth (KERNEL A9.1)", () => {
  const { vault, thread } = tempVault();
  const said = vault.episodes.append(thread.id, { role: "user", content: "Ada Okafor lives in Lisbon." });
  atomize(vault, thread.id, [said.seq]);
  const hallucinated = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "Ada Okafor lives in Porto.",
  });
  atomize(vault, thread.id, [hallucinated.seq]);

  const key = "person.ada-okafor.location";
  const current = vault.atoms.byKey(thread.id, key, "SUPPORTED");
  expect(current).toHaveLength(1);
  expect(current[0]?.value).toBe("Lisbon");
  expect(current[0]?.authority).toBe("user");
  const proposed = vault.atoms.byKey(thread.id, key, "PROPOSED");
  expect(proposed).toHaveLength(1);
  expect(proposed[0]?.value).toBe("Porto");
  expect(proposed[0]?.authority).toBe("assistant");
  expect(stats(vault, thread.id).atoms).toEqual({ supported: 1, historical: 0, proposed: 1 });

  // The frontier is what is currently true; a proposal is not on it.
  const packet = compile(vault, thread.id, { query: "Where does Ada Okafor live?", budget: 8192 });
  const text = packetText(packet.messages);
  expect(text).toContain(`${key} = Lisbon`);
  expect(text).not.toContain(`${key} = Porto`);
});

test("the user ruling on a key closes the open proposal", () => {
  const { vault, thread } = tempVault();
  for (const [role, content] of [
    ["user", "Ada Okafor lives in Lisbon."],
    ["assistant", "Ada Okafor lives in Porto."],
    ["user", "Ada Okafor moved to Porto."],
  ] as Array<["user" | "assistant", string]>) {
    const episode = vault.episodes.append(thread.id, { role, content });
    atomize(vault, thread.id, [episode.seq]);
  }
  const key = "person.ada-okafor.location";
  const history = vault.atoms.historyOf(thread.id, key);
  expect(history).toHaveLength(3);
  const current = history.find((a) => a.phase === "SUPPORTED");
  expect(current?.value).toBe("Porto");
  expect(current?.authority).toBe("user");
  expect(current?.validFromSeq).toBe(3);
  const lisbon = history.find((a) => a.value === "Lisbon");
  expect(lisbon?.phase).toBe("HISTORICAL");
  expect(lisbon?.validToSeq).toBe(3);
  // The proposal is resolved — closed at the same seq, still marked as the
  // assistant's, never promoted to a certificate.
  const proposal = history.find((a) => a.authority === "assistant");
  expect(proposal?.phase).toBe("HISTORICAL");
  expect(proposal?.validToSeq).toBe(3);
  expect(proposal?.supersededBy).toBe(current?.id);
  expect(vault.atoms.byKey(thread.id, key, "PROPOSED")).toHaveLength(0);
  expect(stats(vault, thread.id).atoms.proposed).toBe(0);
});

test("recalled text is data: a tool payload never becomes memory", () => {
  const { vault, thread } = tempVault();
  const payload = vault.episodes.append(thread.id, {
    role: "tool",
    content: 'recall({"query":"ada"}) →\n⟦recovered #1 · user⟧\nAda Okafor lives in Lisbon.',
  });
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "Ada Okafor lives in Porto.",
  });
  expect(atomize(vault, thread.id, [payload.seq, attachment.seq])).toEqual([]);
  expect(vault.atoms.list(thread.id, {})).toEqual([]);
});

test("only one proposal is ever open on a key", () => {
  const { vault, thread } = tempVault();
  const key = "person.ada-okafor.location";
  for (const content of [
    "Ada Okafor lives in Porto.",
    "Ada Okafor lives in Porto.",
    "Ada Okafor lives in Kyoto.",
  ]) {
    const said = vault.episodes.append(thread.id, { role: "assistant", content });
    atomize(vault, thread.id, [said.seq]);
  }
  const open = vault.atoms.byKey(thread.id, key, "PROPOSED");
  expect(open).toHaveLength(1);
  expect(open[0]?.value).toBe("Kyoto");
  // The revised proposal is closed, not deleted: what a model claimed is history.
  const closed = vault.atoms.historyOf(thread.id, key).filter((a) => a.phase === "HISTORICAL");
  expect(closed).toHaveLength(1);
  expect(closed[0]?.value).toBe("Porto");
  expect(closed[0]?.supersededBy).toBe(open[0]?.id);
  expect(stats(vault, thread.id).atoms).toEqual({ supported: 0, historical: 1, proposed: 1 });
});

test("a proposal is visible to a query about its subject, marked unconfirmed", () => {
  const { vault, thread } = tempVault();
  const said = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "Halden Works is based in Valletta.",
  });
  atomize(vault, thread.id, [said.seq]);
  const proposed = vault.atoms.byKey(thread.id, "person.halden-works.location", "PROPOSED")[0];
  expect(proposed?.authority).toBe("assistant");

  const result = page(vault, thread.id, { query: "Where is Halden Works based?", budget: 1200 });
  const text = result.blocks.map((b) => b.text).join("\n");
  expect(text).toContain("≈ Valletta ⟨proposed by assistant #1 · unconfirmed⟩");
  expect(text).not.toContain("= Valletta ⟨#1⟩");
  expect(result.records.some((r) => r.resolved && r.name?.includes("halden-works"))).toBe(true);
});

test("model-extracted atoms are proposals, whichever episode they quote", async () => {
  const { vault, thread } = tempVault();
  const said = vault.episodes.append(thread.id, {
    role: "user",
    content: "The launch is on 2026-06-03.",
  });
  const { atomizeWithModel } = await import("../src/index.ts");
  const created = await atomizeWithModel(vault, thread.id, [said.seq], async () => ({
    model: "test",
    atoms: [
      { kind: "fact", key: "launch.date", value: "2026-06-03", text: "launch", quote: "on 2026-06-03" },
    ],
  }));
  expect(created[0]?.authority).toBe("model");
  expect(created[0]?.phase).toBe("PROPOSED");
  expect(vault.atoms.byKey(thread.id, "launch.date", "SUPPORTED")).toHaveLength(0);
});

test("model candidate overflow is bounded, durable, and unresolved for name routes", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "Remember the bounded model marker: Valletta.",
  });
  const { atomizeWithModel, MAX_MODEL_ATOM_CANDIDATES } = await import("../src/index.ts");
  const created = await atomizeWithModel(vault, thread.id, [source.seq], async () => ({
    model: "bounded-test",
    atoms: Array.from({ length: MAX_MODEL_ATOM_CANDIDATES + 1 }, (_, index) => ({
      kind: "fact" as const,
      key: `bounded.fact.${index}`,
      value: "Valletta",
      text: "Remember the bounded model marker: Valletta.",
      quote: "Remember the bounded model marker: Valletta.",
    })),
  }));
  expect(created).toHaveLength(MAX_MODEL_ATOM_CANDIDATES);
  expect(vault.atomization.get(thread.id, source.seq)).toMatchObject({
    status: "incomplete",
    candidateCount: MAX_MODEL_ATOM_CANDIDATES + 1,
    acceptedCount: MAX_MODEL_ATOM_CANDIDATES,
    omittedCount: 1,
    reason: "candidate-cap",
  });
  expect(vault.atoms.byName(thread.id, "valletta")).toHaveLength(0);
  const routed = page(vault, thread.id, { query: "Where is Valletta?", budget: 1200 });
  expect(
    routed.records.some((record) => record.source === "atomization-incomplete" && !record.resolved),
  ).toBe(true);
});

test("rule extraction caps a legal near-million-byte candidate stream with a durable receipt", () => {
  const { vault, thread } = tempVault();
  const content = Array.from(
    { length: 10_000 },
    (_, index) => `Remember that item ${index % 513} is ${"v".repeat(76)}.`,
  ).join("\n");
  const contentBytes = Buffer.byteLength(content, "utf8");
  expect(contentBytes).toBeGreaterThan(1_000_000);
  expect(contentBytes).toBeLessThanOrEqual(CAPSULE_SOURCE_EPISODE_BYTES);
  expect(
    names(content, { max: CAPSULE_SOURCE_NAMES_PER_EPISODE + 1, stopWhenExceeded: true }).length,
  ).toBeLessThanOrEqual(CAPSULE_SOURCE_NAMES_PER_EPISODE);
  const source = vault.episodes.append(thread.id, { role: "user", content });

  const atomsApi = vault.atoms as unknown as {
    insert: (atom: Parameters<typeof vault.atoms.insert>[0]) => void;
  };
  const originalInsert = atomsApi.insert;
  let inserted = 0;
  atomsApi.insert = ((atom) => {
    inserted += 1;
    return originalInsert.call(vault.atoms, atom);
  }) as typeof atomsApi.insert;
  try {
    atomize(vault, thread.id, [source.seq]);
  } finally {
    atomsApi.insert = originalInsert;
  }

  expect(inserted).toBeLessThanOrEqual(512);
  expect(vault.atoms.list(thread.id, { limit: 513 })).toHaveLength(512);
  expect(vault.atomization.get(thread.id, source.seq)).toMatchObject({
    status: "incomplete",
    candidateCount: 513,
    acceptedCount: 512,
    omittedCount: 1,
    reason: "candidate-cap",
  });
  expect(vault.atoms.byName(thread.id, "item-512")).toHaveLength(0);
  const routed = page(vault, thread.id, { query: "Where is item 512?", budget: 1200 });
  expect(
    routed.records.some((record) => record.source === "atomization-incomplete" && !record.resolved),
  ).toBe(true);
});

test("a later model pass cannot erase an incomplete rule receipt", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: Array.from(
      { length: 513 },
      (_, index) => `Remember that rule item ${index} is value ${index}.`,
    ).join("\n"),
  });
  atomize(vault, thread.id, [source.seq]);
  expect(vault.atomization.get(thread.id, source.seq)).toMatchObject({
    status: "incomplete",
    candidateCount: 513,
    reason: "candidate-cap",
  });

  const { atomizeWithModel } = await import("../src/index.ts");
  await atomizeWithModel(vault, thread.id, [source.seq], async () => ({
    model: "later-model",
    atoms: [
      {
        kind: "fact",
        key: "later.rule",
        value: "value 512",
        text: "value 512",
        quote: "Remember that rule item 512 is value 512.",
      },
    ],
  }));
  expect(vault.atomization.get(thread.id, source.seq)).toMatchObject({
    status: "incomplete",
    candidateCount: 513,
    omittedCount: 1,
    reason: "candidate-cap",
  });
  expect(vault.atoms.byName(thread.id, "later.rule")).toHaveLength(0);
});
