/**
 * The thread this page runs on.
 *
 * It is not a page-local invention: `createCorpus` is the generator in
 * `@pylos/core/pure` that `pylos bench million --seed 1` uses, so the million
 * turns compiled in this tab are byte-for-byte the million turns the published
 * bench ingests — the rule at turn 1, its revision at turn 483,112, 2,000
 * revised facts, 200 exact quotes, 50 exact numbers, 2,000 name-free memories
 * and 200 stories where the assistant states a fact the user never did.
 *
 * `episodeAt(seq)` is O(1) for any seq, which is why the console can answer
 * "what did I say on turn 345?" without the archive being anywhere but here.
 */

import {
  applyRules,
  atomLine,
  type CapsuleAtomLine,
  createCorpus,
  REVISION_TEXT,
  RULE_TEXT,
} from "@pylos/core/pure";
import type { Episode } from "../sim/kernel";
import { K } from "./kernel";

export const SEED = "1";
export const TOTAL_TURNS = 1_000_000;
export const BUDGET = 8192;

export const corpus = createCorpus(SEED, TOTAL_TURNS);

export const RULE_SEQ = corpus.manifest.ruleSeq;
export const REVISION_SEQ = corpus.manifest.revisionSeq;
/** The millionth turn: the question the whole exhibit is aimed at. */
export const TRAP_SEQ = corpus.manifest.trapSeq;
export const TRAP_QUESTION = corpus.manifest.trapText;
export { REVISION_TEXT, RULE_TEXT };

/** One archived turn, in the shape the aperture's compiler consumes. */
export function episodeAt(seq: number): Episode {
  const episode = corpus.episodeAt(seq);
  return {
    seq,
    role:
      episode.role === "assistant" || episode.role === "handoff"
        ? episode.role
        : episode.role === "user"
          ? "user"
          : "system",
    content: episode.content,
    tokens: K.countTokens(episode.content),
  };
}

/**
 * The certificate a turn produces, when it produces one.
 *
 * Only the user's turns do. An assistant restating a fact is a *proposal*, and
 * a proposal is never a certificate (KERNEL A9.1) — which is the whole point of
 * the 200 poisoned stories in the corpus, and why they are absent here.
 */
const certificates = new Map<number, CapsuleAtomLine>();
for (const fact of corpus.planted.facts) {
  certificates.set(fact.seq1, { key: fact.key, value: fact.value1, seq: fact.seq1 });
  certificates.set(fact.seq2, { key: fact.key, value: fact.value2, seq: fact.seq2 });
}
for (const person of corpus.planted.persons) {
  if (person.statedSeq !== undefined && person.value1 !== undefined) {
    certificates.set(person.statedSeq, { key: person.key, value: person.value1, seq: person.statedSeq });
  }
  if (person.correctedSeq !== undefined && person.value3 !== undefined) {
    certificates.set(person.correctedSeq, {
      key: person.key,
      value: person.value3,
      seq: person.correctedSeq,
    });
  }
}

/** The certificate lines carried by the episodes of one leaf, for the capsule writer. */
export function certificatesIn(episodes: readonly Episode[]): CapsuleAtomLine[] {
  const out: CapsuleAtomLine[] = [];
  for (const episode of episodes) {
    const line = certificates.get(episode.seq);
    if (line) out.push(line);
  }
  return out;
}

/** The rule atom of a turn, extracted by the kernel's own rules stage. */
function ruleAtomOf(text: string, seq: number): CapsuleAtomLine {
  const draft = applyRules(text, "user").find((d) => d.kind === "preference");
  if (!draft) throw new Error("thread: the migration rule no longer parses as a rule");
  return { key: draft.key, value: draft.value, seq };
}

const RULE_ATOM = ruleAtomOf(RULE_TEXT, RULE_SEQ);
const REVISED_RULE_ATOM = ruleAtomOf(REVISION_TEXT, REVISION_SEQ);

/**
 * The standing rule as of `atSeq`. Both turns produce the same key, so the
 * revision supersedes the original on turn 483,112 — which is the trap.
 */
export function ruleAtom(atSeq: number): CapsuleAtomLine {
  return atSeq >= REVISION_SEQ ? REVISED_RULE_ATOM : RULE_ATOM;
}

/**
 * The rule as the packet states it: the current certificate, and — once the
 * revision lands — the superseded value, labelled rather than dropped.
 */
export function ruleCertificate(atSeq: number): { seq: number; line: string; historical: string | null } {
  const current = ruleAtom(atSeq);
  return {
    seq: current.seq,
    line: atomLine(current),
    historical:
      atSeq >= REVISION_SEQ
        ? `${RULE_ATOM.key} = ${RULE_ATOM.value} ⟨historical #${RULE_SEQ}→#${REVISION_SEQ}⟩`
        : null,
  };
}

/**
 * The closing probe: an exact quote from far enough back that the capsules no
 * longer carry the name, so the only way to it is the loss ledger. The newest
 * such quote, chosen from the manifest — deterministic, like everything here.
 */
export const QUOTE_PROBE = [...corpus.planted.quotes]
  .filter((q) => q.seq < TOTAL_TURNS - 100_000)
  .sort((a, b) => a.seq - b.seq)
  .at(-1) as (typeof corpus.planted.quotes)[number];

/**
 * The frontier — what is currently true, as certificates.
 *
 * Every line is an atom the kernel's own rules extract from an archived turn:
 * the standing rule, then the most recently revised facts. The seq on each line
 * is the turn it came from, so any of them can be checked against the archive.
 */
export function frontierLines(atSeq: number, max = 160): string[] {
  const lines = [atomLine(ruleAtom(atSeq))];
  const facts = corpus.planted.facts;
  for (let i = facts.length - 1; i >= 0 && lines.length < max; i -= 1) {
    const fact = facts[i] as (typeof facts)[number];
    if (fact.seq2 < atSeq) lines.push(atomLine({ key: fact.key, value: fact.value2, seq: fact.seq2 }));
    else if (fact.seq1 < atSeq) lines.push(atomLine({ key: fact.key, value: fact.value1, seq: fact.seq1 }));
  }
  return lines;
}
