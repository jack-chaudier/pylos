/**
 * The atomizer (KERNEL §2, A8).
 *
 * Atoms are **derived and recomputable**: a wrong extraction can always be redone
 * because the episode is exact. Supersession never overwrites — it closes the
 * previous atom's validity interval and points at its replacement, so both
 * "where do I live?" and "where did I live when we first discussed X?" are
 * answerable.
 *
 * Stage 1 (rules) is deterministic and always on. Stage 2 (a model extractor) is
 * optional, asynchronous, never blocks the reply, and every atom it returns must
 * cite a verbatim quote from the episode or it is discarded.
 */

import type { Atom, AtomKind, Episode, Seq } from "@pylos/protocol";
import { newId } from "./hash.ts";
import { type AtomDraft, applyRules } from "./pure/rules.ts";
import type { Vault } from "./vault.ts";

export interface AtomizeOptions {
  /** Optional stage-2 extractor; see `atomizeWithModel`. */
  modelExtractor?: ModelExtractor;
  /** Stamped into `created_by`. Defaults to the rule name. */
  createdBy?: string;
}

/** A model-extracted atom candidate. `quote` must be verbatim from the episode. */
export interface ModelAtomCandidate {
  kind: AtomKind;
  key: string;
  value: string;
  text: string;
  quote: string;
}

/** Stage 2: the cheapest configured model, called with a JSON schema (KERNEL §2). */
export type ModelExtractor = (input: {
  episodes: Episode[];
}) => Promise<{ atoms: ModelAtomCandidate[]; model: string }>;

function normalizeValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Run the rule cascade over the given episodes and commit the resulting atoms.
 * Must be called inside the turn transaction.
 */
export function atomize(
  vault: Vault,
  threadId: string,
  seqs: readonly Seq[],
  options: AtomizeOptions = {},
): Atom[] {
  const created: Atom[] = [];
  for (const seq of seqs) {
    const episode = vault.episodes.get(threadId, seq);
    if (episode === null || episode.meta.removed === true) continue;
    const drafts = applyRules(episode.content, episode.role);
    const seenKeys = new Set<string>();
    for (const draft of drafts) {
      const resolved = resolveKey(vault, threadId, draft);
      if (seenKeys.has(resolved.key)) continue;
      seenKeys.add(resolved.key);
      const atom = commit(vault, threadId, episode, resolved, options.createdBy);
      if (atom !== null) created.push(atom);
    }
  }
  return created;
}

/**
 * A correction of the form "not X, Y" supersedes whichever SUPPORTED atom
 * currently holds the value X. If nothing matches, the correction becomes a new
 * fact rather than being silently dropped (KERNEL A8).
 */
function resolveKey(vault: Vault, threadId: string, draft: AtomDraft): AtomDraft {
  if (draft.supersedesValue === undefined) return draft;
  const target = normalizeValue(draft.supersedesValue);
  for (const atom of vault.atoms.byValue(threadId, target, 4)) {
    if (normalizeValue(atom.value) === target) return { ...draft, key: atom.key, kind: atom.kind };
  }
  return { ...draft, kind: "fact" };
}

function commit(
  vault: Vault,
  threadId: string,
  episode: Episode,
  draft: AtomDraft,
  createdBy?: string,
): Atom | null {
  const prior = vault.atoms.byKey(threadId, draft.key, "SUPPORTED");
  const head = prior[0];
  if (head !== undefined && normalizeValue(head.value) === normalizeValue(draft.value)) {
    // A restatement, not a revision: nothing changed, so nothing is recorded.
    return null;
  }
  const atom: Atom = {
    id: newId("at"),
    threadId,
    kind: draft.kind,
    key: draft.key,
    value: draft.value.replace(/\s+/g, " ").trim(),
    text: draft.text,
    sourceSeq: episode.seq,
    sourceSpan: draft.span,
    validFromSeq: episode.seq,
    phase: "SUPPORTED",
    scope: "global",
    pinned: false,
    confidence: draft.confidence,
    createdBy: createdBy ?? `rule:${draft.rule}`,
    createdAt: Date.now(),
  };
  vault.atoms.insert(atom);
  for (const previous of prior) {
    vault.atoms.supersede(threadId, previous.id, atom.id, episode.seq);
  }
  return atom;
}

/**
 * Stage 2. Runs after the reply has been delivered (transaction C in KERNEL A6)
 * and only ever *adds* atoms. Every candidate must cite a quote that is a
 * verbatim substring of one of the source episodes; otherwise it is discarded.
 */
export async function atomizeWithModel(
  vault: Vault,
  threadId: string,
  seqs: readonly Seq[],
  extractor: ModelExtractor,
): Promise<Atom[]> {
  const episodes = seqs
    .map((seq) => vault.episodes.get(threadId, seq))
    .filter((e): e is Episode => e !== null && e.meta.removed !== true);
  if (episodes.length === 0) return [];

  const result = await extractor({ episodes });
  const accepted: Array<{ candidate: ModelAtomCandidate; episode: Episode; span: [number, number] }> = [];
  for (const candidate of result.atoms) {
    if (typeof candidate.quote !== "string" || candidate.quote.length < 3) continue;
    let placed = false;
    for (const episode of episodes) {
      const at = episode.content.indexOf(candidate.quote);
      if (at < 0) continue;
      accepted.push({
        candidate,
        episode,
        span: [at, at + candidate.quote.length],
      });
      placed = true;
      break;
    }
    if (!placed) continue;
  }

  const created: Atom[] = [];
  vault.tx(() => {
    for (const entry of accepted) {
      const draft: AtomDraft = {
        kind: entry.candidate.kind,
        key: entry.candidate.key,
        value: entry.candidate.value,
        text: entry.candidate.text || entry.candidate.quote,
        span: entry.span,
        rule: "model",
        confidence: 0.7,
      };
      const atom = commit(vault, threadId, entry.episode, draft, `model:${result.model}`);
      if (atom !== null) created.push(atom);
    }
  });
  return created;
}
