import { expect, test } from "bun:test";
import {
  approxTokens,
  conservationViolations,
  deriveLedger,
  nameSet,
  names,
  parseNumberName,
  retained,
  sourceNamesOfEpisode,
  truncateLines,
  writeCapsule,
} from "../src/pure/index.ts";

test("names() extracts entities, numbers, dates, quotes and code", () => {
  const text =
    'Kestrel Systems shipped ingest_worker on 2026-06-03 at 3.2 ms, and Ada said "keep the dry run exactly as written".';
  const found = names(text);
  const byKind = (kind: string) => found.filter((h) => h.kind === kind).map((h) => h.name);
  expect(byKind("entity")).toContain("kestrel systems");
  expect(byKind("date")).toContain("2026-06-03");
  expect(byKind("number")).toContain("3.2 ms");
  expect(byKind("code")).toContain("ingest_worker");
  expect(byKind("quote")[0]).toBe("keep the dry run exactly as");
});

test("bare small integers and years are not routing keys", () => {
  const found = nameSet("We had 3 options in 2024 and 4 reviewers.");
  expect(found.has("3")).toBe(false);
  expect(found.has("4")).toBe(false);
  expect(found.has("2024")).toBe(false);
  expect(nameSet("The count reached 4821.").has("4821")).toBe(true);
});

test("a single capitalized word at a sentence start is not an entity", () => {
  expect(nameSet("Later we shipped it.").has("later")).toBe(false);
  expect(nameSet("We shipped it to Lisbon.").has("lisbon")).toBe(true);
  expect(nameSet("Lisbon Porto were both considered.").has("lisbon porto")).toBe(true);
});

test("normalization is case-, punctuation- and format-insensitive", () => {
  expect(nameSet("visited LISBON today").has("lisbon")).toBe(true);
  expect(nameSet("on June 3, 2026").has("2026-06-03")).toBe(true);
  expect(nameSet("on 06/03/2026").has("2026-06-03")).toBe(true);
  expect(nameSet("cost 1,200 usd").has("1200 usd")).toBe(true);
  expect(nameSet("Ada Okafor's report").has("ada okafor")).toBe(true);
});

test("kernel markup never becomes vocabulary", () => {
  const found = nameSet("⟨lost: 14 · names: Boston, 2026-06-03⟩ Lisbon is fine.");
  expect(found.has("boston")).toBe(false);
  expect(found.has("lisbon")).toBe(true);
});

test("names() is line-local, so concatenation only adds names", () => {
  const a = "Kestrel Systems shipped on 2026-06-03.";
  const b = "Halden Works replied at 4.5 ms.";
  const joined = nameSet(`${a}\n${b}`);
  for (const name of nameSet(a)) expect(joined.has(name)).toBe(true);
  for (const name of nameSet(b)) expect(joined.has(name)).toBe(true);
});

test("the vocabulary is capped by kind priority", () => {
  const text = Array.from({ length: 200 }, (_, i) => `Entity${i} appeared`).join(". ");
  expect(names(text).length).toBeLessThanOrEqual(64);
});

test("numeric presence is rounding-equivalence, not a tolerance window (KERNEL A9.2)", () => {
  expect(retained("value was 100.4", 100.4)).toBe(true);
  expect(retained("value was 100", 100.4)).toBe(true);
  // 101 is a different number, however close: the 1% window is gone.
  expect(retained("value was 101", 100.4)).toBe(false);
  expect(retained("value was 130", 100.4)).toBe(false);
  // The near-collision from the audit: an unrelated 4950 ms is not a witness.
  expect(retained("p99 latency at 4950 ms", 5000, "ms")).toBe(false);
  expect(retained("p99 latency at 5,000.0 ms", 5000, "ms")).toBe(true);
});

test("a number retains another only when the unit agrees", () => {
  expect(retained("the invoice was 48,250 USD", 48250, "usd")).toBe(true);
  expect(retained("the invoice was 48,250 USD", 48250, "eur")).toBe(false);
  expect(retained("the invoice was 48250 eur", 48250, "usd")).toBe(false);
  // A lost name without a unit is not made stricter by one in the text.
  expect(retained("the invoice was 48,250 USD", 48250)).toBe(true);
});

test("kernel markup is never a numeric witness", () => {
  // A certificate's own pointer must not stand in for the value it points at.
  expect(retained("rule.x = never ⟨#48250⟩", 48250.37)).toBe(false);
  expect(retained("… ⟨#345⟩", 345)).toBe(false);
  expect(retained("⟦recovered #12 · user⟧\nthe figure was 345", 345)).toBe(true);
});

test("parseNumberName splits a normalized number-name into value and unit", () => {
  expect(parseNumberName("3.2 ms")).toEqual({ value: 3.2, unit: "ms" });
  expect(parseNumberName("483112")).toEqual({ value: 483112, unit: "" });
  expect(parseNumberName("ada okafor")).toBeNull();
});

test("the extractive writer keeps atom lines before prose, and truncates at lines", () => {
  const units = Array.from({ length: 40 }, (_, i) => ({
    seq: i + 1,
    text: `Ordinary sentence number ${i} about the harbour. A second sentence about ${i}.`,
  }));
  const atoms = [{ key: "user.location", value: "Lisbon", seq: 3 }];
  const written = writeCapsule(units, atoms, { maxTokens: 120 });
  expect(written.text.split("\n")[0]).toBe("user.location = Lisbon ⟨#3⟩");
  expect(written.tokens).toBeLessThanOrEqual(120);
  expect(written.truncated.length).toBeGreaterThan(0);
  // every emitted line is a verbatim source line, never a paraphrase
  for (const line of written.text.split("\n").slice(1)) {
    expect(units.some((u) => u.text.includes(line.replace(/ ⟨#\d+⟩$/, "")))).toBe(true);
  }
});

test("deriveLedger splits the source vocabulary against the capsule text", () => {
  const source = [
    ...sourceNamesOfEpisode(1, "Kestrel Systems paid 48250.75 usd on 2026-06-03."),
    ...sourceNamesOfEpisode(2, "Halden Works replied from Valletta."),
  ];
  const { dropped, kept } = deriveLedger(source, "Kestrel Systems paid 48250.75 usd on 2026-06-03.");
  const droppedNames = dropped.map((d) => d.name);
  expect(droppedNames).toContain("halden works");
  expect(droppedNames).toContain("valletta");
  expect(kept.map((k) => k.name)).toContain("kestrel systems");
  for (const entry of dropped) expect(entry.seq).toBe(2);
});

test("conservation is a set containment check on names", () => {
  expect(conservationViolations(["a", "b"], [["a"], ["b"]])).toEqual([]);
  expect(conservationViolations(["a"], [["a"], ["c"]])).toEqual(["c"]);
});

test("truncateLines never cuts mid-line", () => {
  const text = ["one two three", "four five six", "seven eight nine"].join("\n");
  const cut = truncateLines(text, approxTokens("one two three") + 1);
  expect(cut.kept).toBe("one two three");
  expect(cut.dropped).toBe("four five six\nseven eight nine");
});

test("the browser aperture compiles a real bounded packet from an array of episodes", async () => {
  const { aperture } = await import("../src/pure/index.ts");
  const episodes = Array.from({ length: 400 }, (_, i) => ({
    seq: i + 1,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content:
      i === 4
        ? "Remember that the amber-ledger deploy window is Tuesday 09:30."
        : i === 40
          ? "Kestrel Systems paid 48250.75 usd on 2026-06-03 for the Valletta contract."
          : `Turn ${i}: the ingest worker is degraded; p99 latency at ${300 + i} ms.`,
  }));
  const cold = aperture(episodes, { budget: 4096, query: "how is it going?" });
  expect(cold.tokens).toBeLessThanOrEqual(4096);
  expect(cold.messages.map((m) => m.content).join("\n")).not.toContain("48250.75");
  expect(cold.lost.length).toBeGreaterThan(0);

  const routed = aperture(episodes, {
    budget: 4096,
    query: "What did Kestrel Systems pay on 2026-06-03?",
  });
  expect(routed.tokens).toBeLessThanOrEqual(4096);
  expect(routed.pages.length).toBeGreaterThan(0);
  expect(routed.messages.map((m) => m.content).join("\n")).toContain("48250.75");
  expect(routed.frontier.some((line) => line.includes("Tuesday 09:30"))).toBe(true);
});

test("digits glued to a letter are an identifier fragment, not a number (p50, v2)", () => {
  const found = names("the p50 latency of v2 is 250 ms").map((n) => n.name);
  expect(found).not.toContain("50");
  expect(found).not.toContain("2");
  expect(found).toContain("250 ms");
});
