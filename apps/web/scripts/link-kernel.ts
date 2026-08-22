/**
 * Point the aperture at the real compiler when it exists.
 *
 * The landing page runs Pylos's own compaction and ledger math in the browser.
 * While `packages/core` is still being written it runs the local simulation in
 * `src/sim/kernel.ts` — the same rules, restated. This script flips
 * `src/aperture/kernel-impl.ts` between the two, and the page reports which one
 * it actually ran.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CORE_PURE = resolve(here, "../../../packages/core/src/pure/index.ts");
const TARGET = resolve(here, "../src/aperture/kernel-impl.ts");

const source = existsSync(CORE_PURE) ? "core" : "sim";
const specifier = source === "core" ? "./core-adapter" : "../sim/kernel";

const banner = `/**
 * GENERATED SELECTOR — the one file that changes when the real kernel lands.
 *
 * \`scripts/link-kernel.ts\` (run by \`prebuild\` and \`predev\`) rewrites this file
 * to point at \`@pylos/core/pure\` as soon as \`packages/core/src/pure/index.ts\`
 * exists, and back to the local simulation if it does not. Editing it by hand
 * is fine; it will be regenerated.
 */
import * as impl from "${specifier}";

export const IMPL: unknown = impl;
export const IMPL_SOURCE = "${source}";
`;

const current = existsSync(TARGET) ? await readFile(TARGET, "utf8") : "";
if (current !== banner) {
  await writeFile(TARGET, banner, "utf8");
  console.log(`[pylos/web] aperture kernel → ${specifier} (${source})`);
} else {
  console.log(`[pylos/web] aperture kernel already → ${specifier} (${source})`);
}
