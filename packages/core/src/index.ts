/**
 * `@pylos/core` — the Pylos kernel (KERNEL §9).
 *
 * The archive, the memory IR, the context compiler, the loss ledger, the pager
 * and the receipts. No UI dependency, fully testable headlessly.
 *
 * ```ts
 * const vault = openVault();
 * const thread = vault.threads.primary();
 * const result = await runTurn(vault, thread.id, { text, model, provider });
 * ```
 *
 * The browser-safe half is exported separately as `@pylos/core/pure`.
 */

export {
  type AtomizeOptions,
  atomize,
  atomizeWithModel,
  type ModelAtomCandidate,
  type ModelExtractor,
} from "./atomize.ts";
export {
  type BundleManifest,
  type ExportOptions,
  exportBundle,
  type ImportOptions,
  importBundle,
} from "./bundle.ts";
export {
  type CapsuleTokens,
  type CapsuleWriter,
  type CompactOptions,
  capsuleLedgerNames,
  capsuleTokensFor,
  compact,
  coveredTo,
  levelSpan,
  ROOT_LEVEL,
  residentCapsules,
  residentLeafCount,
  sourceNamesForRange,
} from "./compact.ts";
export { type CompileOptions, compile, packetText } from "./compile.ts";
export { type ForgetResult, type ForgetTarget, forget } from "./forget.ts";
export { canonicalHash, chainHash, genesisHash, newId, sha256 } from "./hash.ts";
export {
  containsName,
  excerpt,
  type PageRequest,
  type PageResult,
  page,
  recall,
  resolves,
  TOKENS_PER_PAGE,
} from "./page.ts";
// The pure layer is re-exported for convenience; `@pylos/core/pure` is the
// browser-safe entry point that carries no Bun or SQLite import.
export * from "./pure/index.ts";
export { COUNTERS, MIGRATIONS } from "./schema.ts";
export { stats } from "./stats.ts";
export {
  handoff,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
  type RunTurnOptions,
  runTurn,
  type TurnResult,
} from "./turn.ts";
export {
  CHECKPOINT_EVERY,
  COMPILER_VERSION,
  type EpisodeInput,
  openVault,
  PACKET_MESSAGE_RETENTION,
  pylosHome,
  type StoredCapsule,
  Vault,
  VaultError,
  type VaultOptions,
} from "./vault.ts";
export { type VerifyResult, verify } from "./verify.ts";
