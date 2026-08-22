/**
 * `@pylos/core/pure` — the browser-safe half of the kernel.
 *
 * Everything exported here is deterministic TypeScript with no Bun, Node or
 * SQLite import, so the landing page can run the *real* compiler logic
 * in-browser: the same tokenizer, the same `names()`, the same capsule writer,
 * the same ledger algebra, the same packet rendering the desktop app uses.
 */

export {
  type ApertureEpisode,
  type ApertureOptions,
  type AperturePage,
  type ApertureResult,
  aperture,
} from "./aperture.ts";
export { type Allocation, allocate, type BudgetShares, DEFAULT_SHARES, spare } from "./budget.ts";
export { CanonicalJsonError, canonicalJson, compareUtf8 } from "./canonical.ts";
export {
  atomLine,
  type CapsuleAtomLine,
  type CapsuleUnit,
  type CapsuleWriteOptions,
  type CapsuleWriteResult,
  capsuleBudget,
  writeCapsule,
} from "./capsule.ts";
export {
  type Corpus,
  type CorpusEpisode,
  type CorpusManifest,
  type CorpusOptions,
  createCorpus,
  type Planted,
  type PlantedFact,
  type PlantedMemory,
  type PlantedNumber,
  type PlantedPerson,
  type PlantedQuote,
  type PoisonVariant,
  REVISION_TEXT,
  Rng,
  RULE_TEXT,
  stream,
  TRAP_TEXT,
  vocabSha256,
} from "./corpus/index.ts";
export {
  conservationViolations,
  deriveLedger,
  type LedgerResult,
  renderLedgerDigest,
  type SourceName,
  sourceNamesOfEpisode,
  unaccountedNames,
} from "./ledger.ts";
export {
  DEFAULT_MAX_NAMES,
  KIND_PRIORITY,
  MIN_BARE_NUMBER,
  type NameHit,
  type NamesOptions,
  type NumberOccurrence,
  nameSet,
  names,
  normalizeName,
  numberOccurrences,
  parseNumberName,
  queryNames,
  retained,
} from "./names.ts";
export {
  atomCertificate,
  type CapsuleRender,
  type CapsuleView,
  epistemicOfRole,
  type FrontierRender,
  fitRound,
  type HeaderInfo,
  type HeaderOptions,
  type PagedBlock,
  packetText,
  RECALL_CLAUSE_NO_TOOLS,
  RECALL_CLAUSE_TOOLS,
  RECALL_TOOL,
  renderCapsules,
  renderFrontier,
  renderHeader,
  renderPaged,
  renderRecent,
  renderUnknownPages,
  VIEW_CONTRACT,
} from "./render.ts";
export {
  type AtomDraft,
  applyRules,
  isSalient,
  SALIENT_CUE,
  type Sentence,
  slug,
  splitSentences,
} from "./rules.ts";
export { ftsTerms } from "./terms.ts";
export {
  approxTokens,
  CHARS_PER_TOKEN,
  joinedTokens,
  TOKEN_MARGIN,
  type Tokenizer,
  tokenizerOr,
  truncateLines,
} from "./tokens.ts";
