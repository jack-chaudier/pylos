/**
 * The deterministic corpus: one generator, one vocabulary, one set of trap
 * constants, used by the bench and by the landing page.
 */

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
} from "./corpus.ts";
