/**
 * Run the aperture to turn 1,000,000 in Bun and write the end state to
 * `public/aperture/final.json`.
 *
 * Two uses: `prefers-reduced-motion` renders the finished run instantly instead
 * of spending ten seconds of CPU on an animation nobody asked for, and the page
 * can state the run's numbers before the run has produced them. Same seed, same
 * kernel, same numbers as the live run — if they ever disagree, one of them is
 * lying, and the snapshot is regenerated on every build so it cannot drift.
 *
 * The file carries no timestamp and no wall clock: it is tracked, so a rebuild
 * on an unchanged kernel must produce a byte-identical file. The run's cost is
 * reported on stdout instead.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE } from "../src/aperture/kernel";
import { ApertureRun } from "../src/aperture/run";
import { REVISION_SEQ, RULE_SEQ, SEED, TRAP_QUESTION } from "../src/aperture/thread";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../public/aperture/final.json");

const t0 = performance.now();
const state = new ApertureRun().runToEnd();
const ms = Math.round(performance.now() - t0);

const payload = {
  engine: ENGINE,
  seed: SEED,
  ruleSeq: RULE_SEQ,
  revisionSeq: REVISION_SEQ,
  question: TRAP_QUESTION,
  turn: state.turn,
  total: state.total,
  archiveBytes: state.archiveBytes,
  lossRows: state.lossRows,
  capsules: state.capsules,
  levelCounts: state.levelCounts,
  packet: state.packet,
  strip: state.strip,
  recovered: state.recovered,
  resident: state.resident,
  routed: state.routed,
};

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(
  `[pylos/web] aperture snapshot · ${state.turn.toLocaleString("en-US")} turns · ` +
    `${state.packet.tokens}/${state.packet.budget} tokens · ${state.lossRows.toLocaleString("en-US")} ledger rows · ${ms}ms (${ENGINE})`,
);
