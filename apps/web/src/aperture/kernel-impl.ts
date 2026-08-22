/**
 * GENERATED SELECTOR — the one file that changes when the real kernel lands.
 *
 * `scripts/link-kernel.ts` (run by `prebuild` and `predev`) rewrites this file
 * to point at `@pylos/core/pure` as soon as `packages/core/src/pure/index.ts`
 * exists, and back to the local simulation if it does not. Editing it by hand
 * is fine; it will be regenerated.
 */
import * as impl from "./core-adapter";

export const IMPL: unknown = impl;
export const IMPL_SOURCE = "core";
