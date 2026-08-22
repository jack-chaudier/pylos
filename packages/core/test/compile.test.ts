import { afterAll, expect, test } from "bun:test";
import { approxTokens, atomize, compact, compile, compileView, nameSet, packetText } from "../src/index.ts";
import { cleanup, rng, syntheticTurn, tempVault } from "./helpers.ts";

afterAll(cleanup);

function build(seed: number, count: number) {
  const { vault, thread } = tempVault();
  const next = rng(seed);
  for (let i = 0; i < count; i += 64) {
    const batch = Array.from({ length: Math.min(64, count - i) }, (_, k) => ({
      role: ((i + k) % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: syntheticTurn(next, i + k),
    }));
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

const QUERIES = [
  "Where does Ada Okafor live?",
  "What did we decide for the ingest pipeline?",
  "What was the p99 latency number?",
  "Remind me about the palimpsest quote.",
  "Nothing in particular, just chatting.",
  "What is the deploy window on 2026-03-13?",
];

test("the packet never exceeds the budget, at 2k / 8k / 32k", () => {
  for (const budget of [2048, 8192, 32768]) {
    for (const size of [40, 300, 1100]) {
      const { vault, thread } = build(budget + size, size);
      for (const query of QUERIES) {
        const packet = compile(vault, thread.id, { query, budget, model: "test" });
        expect(packet.tokens).toBeLessThanOrEqual(budget);
        expect(approxTokens(packetText(packet.messages))).toBeLessThanOrEqual(budget);
      }
    }
  }
});

test("every frontier certificate carries a value and a pointer (THEORY §7)", () => {
  const { vault, thread } = build(21, 400);
  const packet = compile(vault, thread.id, { query: "status", budget: 8192 });
  const system = packet.messages[0]?.content as string;
  const lines = system.split("\n").filter((l) => / = .* ⟨#\d+⟩$/.test(l));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const match = /^★?\s*(\S+) = (.*) ⟨#(\d+)⟩$/.exec(line);
    expect(match).not.toBeNull();
    const captured = match as RegExpExecArray;
    expect((captured[2] as string).trim().length).toBeGreaterThan(0);
    expect(vault.episodes.get(thread.id, Number(captured[3]))).not.toBeNull();
  }
});

test("the ⟨lost⟩ digest never names something the packet already contains (THEORY §11)", () => {
  const { vault, thread } = build(22, 900);
  for (const query of QUERIES) {
    const packet = compile(vault, thread.id, { query, budget: 8192 });
    const present = nameSet(packetText(packet.messages), { max: 8192 });
    for (const name of packet.ledger.residentNames) {
      expect({ name, resident: present.has(name) }).toEqual({ name, resident: false });
    }
  }
});

test("ledger routing pages the planted revision back", () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, {
    role: "user",
    content:
      "Kestrel Systems signed the Valletta contract on 2026-06-03 for 48250.75 usd — keep that number.",
  });
  const next = rng(23);
  for (let i = 0; i < 600; i += 64) {
    const appended = vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 64 }, (_, k) => ({
        role: ((i + k) % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: syntheticTurn(next, i + k),
      })),
    );
    atomize(
      vault,
      thread.id,
      appended.map((e) => e.seq),
    );
    compact(vault, thread.id, { budget: 8192 });
  }
  const cold = compile(vault, thread.id, { query: "How is the rollout going?", budget: 8192 });
  expect(packetText(cold.messages)).not.toContain("48250.75");

  const packet = compile(vault, thread.id, {
    query: "What did Kestrel Systems sign on 2026-06-03?",
    budget: 8192,
  });
  const ledgerPages = packet.pages.filter((p) => p.trigger === "ledger" && p.resolved);
  expect(ledgerPages.length).toBeGreaterThan(0);
  expect(packetText(packet.messages)).toContain("Kestrel Systems signed the Valletta contract");
  expect(ledgerPages.some((p) => p.seqs.includes(1))).toBe(true);
});

test("a page that finds nothing exact is recorded as UNKNOWN, never as something similar", () => {
  const { vault, thread } = build(24, 200);
  const packet = compile(vault, thread.id, {
    query: "What did Nonexistent Corporation Xyzzy decide in 1997-01-01?",
    budget: 8192,
  });
  for (const record of packet.pages) {
    if (!record.resolved) expect(record.seqs).toHaveLength(0);
  }
  // Nothing similar is offered; if anything was looked for and missed, the view
  // says UNKNOWN in as many words.
  const text = packetText(packet.messages);
  const unresolved = packet.pages.filter((p) => !p.resolved);
  if (unresolved.length > 0) expect(text).toContain("⟨UNKNOWN:");
  // Nothing similar is substituted: no page was served for the invented name.
  expect(packet.pages.some((p) => p.resolved && p.trigger === "ledger")).toBe(false);
});

test("historical atoms are not resident, but the current one is, and both are reachable", () => {
  const { vault, thread } = tempVault();
  const first = vault.episodes.append(thread.id, { role: "user", content: "I live in Lisbon." });
  atomize(vault, thread.id, [first.seq]);
  const next = rng(25);
  for (let i = 0; i < 200; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  const moved = vault.episodes.append(thread.id, { role: "user", content: "I have moved to Porto." });
  atomize(vault, thread.id, [moved.seq]);
  compact(vault, thread.id, { budget: 8192 });

  const packet = compile(vault, thread.id, { query: "Where do I live now?", budget: 8192 });
  const system = packet.messages[0]?.content as string;
  expect(system).toContain("user.location = Porto");
  expect(system).not.toContain("user.location = Lisbon ⟨#1⟩");

  const asOf = compile(vault, thread.id, {
    query: "Where did I live before, when user.location was different?",
    budget: 8192,
  });
  const changed = asOf.ledger.historical.find((h) => h.key === "user.location");
  expect(changed?.current).toBe("Porto");
  expect(changed?.previous).toBe("Lisbon");
  expect(changed?.changedAtSeq).toBe(moved.seq);
});

test("resident tokens do not trend with archive size (row 41 / 1K→1M)", () => {
  const sizes = [200, 800, 3200];
  const measured: number[] = [];
  for (const size of sizes) {
    const { vault, thread } = build(26, size);
    const packet = compile(vault, thread.id, { query: "status on the rollout", budget: 8192 });
    measured.push(packet.tokens);
  }
  const spread = Math.max(...measured) - Math.min(...measured);
  // Header digits and capsule fill move a little; the packet must not grow with n.
  expect(spread).toBeLessThan(1200);
  for (const tokens of measured) expect(tokens).toBeLessThanOrEqual(8192);
});

test("the packet digest is stable for identical inputs", () => {
  const { vault, thread } = build(27, 128);
  const a = compile(vault, thread.id, { query: "same query", budget: 8192, model: "m" });
  const b = compile(vault, thread.id, { query: "same query", budget: 8192, model: "m" });
  expect(a.digest).toBe(b.digest);
});

test("when the frontier is wider than its slot, the current value is paged, not dropped", () => {
  const { vault, thread } = tempVault();
  // Far more current atoms than the 20% frontier slot can hold.
  const seqs: number[] = [];
  for (let i = 0; i < 400; i += 1) {
    seqs.push(
      vault.episodes.append(thread.id, {
        role: "user",
        content: `Person${i} Vantwood lives in ${["Lisbon", "Tallinn", "Kyoto", "Porto"][i % 4]}.`,
      }).seq,
    );
  }
  atomize(vault, thread.id, seqs);
  const moved = vault.episodes.append(thread.id, {
    role: "user",
    content: "Actually, Person7 Vantwood moved to Valletta.",
  });
  atomize(vault, thread.id, [moved.seq]);
  const next = rng(28);
  for (let i = 0; i < 400; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  compact(vault, thread.id, { budget: 8192 });

  const packet = compile(vault, thread.id, {
    query: "Where does Person7 Vantwood live now?",
    budget: 8192,
  });
  const text = packetText(packet.messages);
  expect(text).toContain("person.person7-vantwood.location = Valletta");
  expect(text).toContain("historical");
  expect(packet.pages.some((p) => p.resolved)).toBe(true);
  expect(packet.tokens).toBeLessThanOrEqual(8192);
});

test("older packets keep their receipts but drop their message bodies", () => {
  const { vault, thread } = build(29, 40);
  for (let turn = 1; turn <= 12; turn += 1) {
    const packet = compile(vault, thread.id, { query: `q${turn}`, budget: 4096, turnSeq: turn });
    vault.packets.insert(packet);
  }
  vault.packets.prune(thread.id, 5);
  const old = vault.packets.get(thread.id, 1);
  const recent = vault.packets.get(thread.id, 12);
  expect(old?.messages).toHaveLength(0);
  expect(old?.digest.length).toBe(64);
  expect((old?.resident.length ?? 0) > 0).toBe(true);
  expect((recent?.messages.length ?? 0) > 0).toBe(true);
});

test("resident spans are labelled by what they may support (KERNEL A10.1)", () => {
  const { vault, thread } = build(31, 400);
  const said = vault.episodes.append(thread.id, {
    role: "user",
    content: "The Ostend depot holds 4200 crates.",
  });
  const echoed = vault.episodes.append(thread.id, {
    role: "assistant",
    content: "Noted: the Ostend depot holds 4200 crates.",
  });
  const asked = vault.episodes.append(thread.id, { role: "user", content: "How many crates again?" });
  const compiled = compileView(vault, thread.id, {
    query: asked.content,
    turnSeq: asked.seq,
    budget: 8192,
  });
  const byType = (type: string) => compiled.packet.resident.filter((r) => r.type === type);
  expect(byType("header")[0]?.epistemic).toBe("NON_AUTHORITATIVE");
  for (const capsule of byType("capsule")) expect(capsule.epistemic).toBe("NON_AUTHORITATIVE");
  expect(compiled.packet.resident.find((r) => r.seq === said.seq)?.epistemic).toBe("SUPPORTED");
  expect(compiled.packet.resident.find((r) => r.seq === echoed.seq)?.epistemic).toBe("PROPOSED");
  expect(byType("query").map((r) => r.seq)).toEqual([asked.seq]);

  // The support text is the evidence, and it is a strict part of the packet.
  const text = packetText(compiled.packet.messages);
  expect(text).toContain(asked.content);
  expect(compiled.support).toContain(said.content);
  expect(compiled.support).not.toContain(echoed.content);
  expect(compiled.support).not.toContain(asked.content);
  expect(compiled.support.length).toBeLessThan(text.length);
});

test("the turn being answered is rendered once, at the end, outside the window", () => {
  const { vault, thread } = build(32, 60);
  const asked = vault.episodes.append(thread.id, { role: "user", content: "and the deploy window?" });
  const packet = compile(vault, thread.id, { query: asked.content, turnSeq: asked.seq, budget: 8192 });
  expect(packet.messages.at(-1)).toEqual({ role: "user", content: asked.content });
  expect(packet.messages.filter((m) => m.content === asked.content)).toHaveLength(1);
  expect(packet.resident.some((r) => r.type === "recent" && r.seq === asked.seq)).toBe(false);
  // With no episode appended for it, the packet answers the turn that comes next.
  const cold = compile(vault, thread.id, { query: "same question, no episode", budget: 8192 });
  expect(cold.turnSeq).toBe(asked.seq + 1);
  expect(cold.resident.some((r) => r.type === "query")).toBe(false);
  expect(cold.resident.some((r) => r.type === "recent" && r.seq === asked.seq)).toBe(true);
});
