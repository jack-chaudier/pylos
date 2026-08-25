/**
 * The proof chart's data, derived from the bench artifact rather than typed.
 *
 * `bench/results/million-6.json` is checkpoint detail; the chart on
 * the landing page needs eight numbers per checkpoint and one receipt. This
 * reduces one to the other, deterministically, so the page cannot state a
 * figure the artifact does not contain. The output is tracked: it is the same
 * file for the same artifact, and a diff means the artifact changed.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = "bench/results/million-6.json";
const src = resolve(here, "../../../", SOURCE);
const out = resolve(here, "../public/bench/series.json");

interface Family {
  checked: number;
  failed: unknown[];
}

interface Checkpoint {
  seq: number;
  budgetCheck: { queryTokensMax: number };
  facts: Family & { paged: number; resident: number };
  quotes: Family & { exact: number };
  numbers: Family & { paged: number };
  sequence: Family & { paged: number; resident: number };
  memories: Family & { found: number; resident: number };
  poison: {
    A: { checked: number; passed: number };
    B: { checked: number; passed: number };
    C: { checked: number; passed: number };
    failed: unknown[];
  };
  faults: { asked: number; faulted: number; falseFaults: number };
  ledger: { entries: number };
  verify: { ok: boolean; headHash: string };
  archiveBytes: number;
  residentTokensP50: number;
  baselines: { rolling: { survival: number }; bm25: { survival: number } };
}

interface Artifact {
  seed: string | number;
  N: number;
  budget: number;
  checkpoints: Checkpoint[];
  final: { archiveBytes: number; lossEntries: number; capsules: number };
}

const artifact = JSON.parse(await readFile(src, "utf8")) as Artifact;

/**
 * The seven planted families, each reduced to "did every probe survive at this
 * checkpoint". A family passes when nothing failed and every probe was
 * accounted for — paged back, or already resident, which is the same claim
 * about the packet and a cheaper way to satisfy it.
 */
function families(c: Checkpoint): boolean[] {
  return [
    c.facts.failed.length === 0 && c.facts.paged + c.facts.resident === c.facts.checked,
    c.quotes.failed.length === 0 && c.quotes.exact === c.quotes.checked,
    c.numbers.failed.length === 0 && c.numbers.paged === c.numbers.checked,
    c.sequence.failed.length === 0,
    c.memories.failed.length === 0 && c.memories.found + c.memories.resident === c.memories.checked,
    c.poison.failed.length === 0 &&
      c.poison.A.passed === c.poison.A.checked &&
      c.poison.B.passed === c.poison.B.checked &&
      c.poison.C.passed === c.poison.C.checked,
    c.faults.falseFaults === 0 && c.faults.faulted === c.faults.asked,
  ];
}

const points = artifact.checkpoints.map((c) => {
  const fam = families(c);
  return {
    seq: c.seq,
    archiveBytes: c.archiveBytes,
    viewP50: c.residentTokensP50,
    viewMax: c.budgetCheck.queryTokensMax,
    ledger: c.ledger.entries,
    rolling: c.baselines.rolling.survival,
    bm25: c.baselines.bm25.survival,
    pylos: Number((fam.filter(Boolean).length / fam.length).toFixed(4)),
  };
});

const last = artifact.checkpoints[artifact.checkpoints.length - 1];
if (!last) throw new Error(`series: ${SOURCE} has no checkpoints`);

/** Summed across the run: these probes are re-drawn at every checkpoint. */
const sum = (pick: (c: Checkpoint) => number): number =>
  artifact.checkpoints.reduce((total, c) => total + pick(c), 0);

const payload = {
  source: SOURCE,
  seed: String(artifact.seed),
  turns: artifact.N,
  budget: artifact.budget,
  points,
  // Exhaustive at the last checkpoint (facts, quotes, numbers, memories);
  // summed over the run for the probes that are re-drawn each time.
  final: {
    archiveBytes: artifact.final.archiveBytes,
    lossEntries: artifact.final.lossEntries,
    capsules: artifact.final.capsules,
    facts: { checked: last.facts.checked, passed: last.facts.paged + last.facts.resident },
    quotes: { checked: last.quotes.checked, passed: last.quotes.exact },
    numbers: { checked: last.numbers.checked, passed: last.numbers.paged },
    memories: { checked: last.memories.checked, passed: last.memories.found + last.memories.resident },
    sequence: {
      checked: sum((c) => c.sequence.checked),
      passed: sum((c) => c.sequence.checked - c.sequence.failed.length),
    },
    faults: { asked: sum((c) => c.faults.asked), receipted: sum((c) => c.faults.faulted) },
    verifyOk: last.verify.ok,
    headHash: last.verify.headHash,
  },
};

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(
  `[pylos/web] proof series · ${points.length} checkpoints · ` +
    `${(payload.final.archiveBytes / 2 ** 20).toFixed(0)} MiB archive · ` +
    `${payload.final.lossEntries.toLocaleString("en-US")} ledger entries ← ${SOURCE}`,
);
