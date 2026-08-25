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
 *
 * Authority (KERNEL A9.1) decides what a new atom is allowed to do. An atom read
 * from an assistant turn, or proposed by the stage-2 extractor, is committed
 * `PROPOSED`: it may close an earlier proposal on its key, and nothing else. The
 * model may propose; only the user authorizes.
 */

import type { Atom, AtomAuthority, AtomizationReceipt, AtomKind, Episode, Role, Seq } from "@pylos/protocol";
import { newId } from "./hash.ts";
import { type AtomDraft, applyRulesBounded } from "./pure/rules.ts";
import type { Vault } from "./vault.ts";

export type { AtomizationReceipt } from "@pylos/protocol";

export interface AtomizeOptions {
  /** Optional stage-2 extractor; see `atomizeWithModel`. */
  modelExtractor?: ModelExtractor;
  /** Stamped into `created_by`. Defaults to the rule name. */
  createdBy?: string;
  /** Optional bounded source projection used by startup replay. */
  maxContentBytes?: number;
  /** Optional bounded metadata projection used by startup replay. */
  maxMetaBytes?: number;
}

/** Hard bound on deterministic rule candidates inspected per source episode. */
export const MAX_RULE_ATOM_CANDIDATES = 512;

/** A model-extracted atom candidate. `quote` must be verbatim from the episode. */
export interface ModelAtomCandidate {
  kind: AtomKind;
  key: string;
  value: string;
  text: string;
  quote: string;
}

/** Hard bound on model output inspected by one kernel atomization pass. */
export const MAX_MODEL_ATOM_CANDIDATES = 512;
/** Hard bound on source episodes handed to one optional extractor pass. */
export const MAX_MODEL_ATOM_EPISODES = 64;
const MAX_MODEL_ATOM_KEY_BYTES = 512;
const MAX_MODEL_ATOM_VALUE_BYTES = 2 * 1024;
const MAX_MODEL_ATOM_TEXT_BYTES = 4 * 1024;
const MAX_MODEL_ATOM_QUOTE_BYTES = 16 * 1024;
const MAX_MODEL_ATOM_MODEL_BYTES = 512;
const MODEL_TEXT_ENCODER = new TextEncoder();
const ATOM_KINDS = new Set<AtomKind>([
  "identity",
  "fact",
  "preference",
  "decision",
  "promise",
  "task",
  "correction",
  "hypothesis",
]);

/** Stage 2: the cheapest configured model, called with a JSON schema (KERNEL §2). */
export type ModelExtractor = (input: {
  episodes: Episode[];
}) => Promise<{ atoms: ModelAtomCandidate[]; model: string }>;

function normalizeValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Who is speaking (KERNEL A9.1). Only user and assistant turns carry rules
 * (`SPOKEN` in `rules.ts`); tool payloads and attachments are retrieved data and
 * are never atomized, so everything that is not the assistant is the user.
 */
export function authorityOf(role: Role): AtomAuthority {
  return role === "assistant" ? "assistant" : "user";
}

/** The only authority that may move the frontier. */
function authorizes(authority: AtomAuthority): boolean {
  return authority === "user";
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
  if (!vault.atomDerivedReady(threadId)) vault.continueMigrations();
  vault.assertAtomDerivedReady(threadId);
  const created: Atom[] = [];
  for (const seq of seqs) {
    const episode =
      options.maxContentBytes === undefined
        ? vault.episodes.get(threadId, seq)
        : vault.episodes.getBounded(
            threadId,
            seq,
            Math.max(1, Math.floor(options.maxContentBytes)),
            Math.max(0, Math.floor(options.maxMetaBytes ?? 16 * 1024)),
          );
    if (episode === null || episode.meta.removed === true) continue;
    const bounded = applyRulesBounded(episode.content, episode.role, MAX_RULE_ATOM_CANDIDATES + 1);
    const drafts = bounded.drafts.slice(0, MAX_RULE_ATOM_CANDIDATES);
    const seenKeys = new Set<string>();
    let createdForEpisode = 0;
    for (const draft of drafts) {
      const resolved = resolveKey(vault, threadId, draft);
      if (seenKeys.has(resolved.key)) continue;
      seenKeys.add(resolved.key);
      const atom = commit(vault, threadId, episode, resolved, options.createdBy);
      if (atom !== null) {
        created.push(atom);
        createdForEpisode += 1;
      }
    }
    if (bounded.overflow) {
      recordModelReceipt(vault, episode, {
        status: "incomplete",
        candidateCount: bounded.drafts.length,
        acceptedCount: createdForEpisode,
        omittedCount: Math.max(1, bounded.drafts.length - MAX_RULE_ATOM_CANDIDATES),
        reason: "candidate-cap",
      });
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
  authority: AtomAuthority = authorityOf(episode.role),
): Atom | null {
  const value = draft.value.replace(/\s+/g, " ").trim();
  const supported = vault.atoms.byKey(threadId, draft.key, "SUPPORTED");
  const proposals = vault.atoms.byKey(threadId, draft.key, "PROPOSED");
  const head = supported[0];
  if (head !== undefined && normalizeValue(head.value) === normalizeValue(value)) {
    // A restatement, not a revision: nothing changed, so nothing is recorded.
    return null;
  }
  const authoritative = authorizes(authority);
  if (!authoritative && proposals.some((p) => normalizeValue(p.value) === normalizeValue(value))) {
    // The same proposal, made twice. Repeating it does not make it more true.
    return null;
  }
  const atom: Atom = {
    id: newId("at"),
    threadId,
    kind: draft.kind,
    key: draft.key,
    value,
    text: draft.text,
    sourceSeq: episode.seq,
    sourceSpan: draft.span,
    validFromSeq: episode.seq,
    phase: authoritative ? "SUPPORTED" : "PROPOSED",
    authority,
    scope: "global",
    pinned: false,
    confidence: draft.confidence,
    createdBy: createdBy ?? `rule:${draft.rule}`,
    createdAt: Date.now(),
  };
  vault.atoms.insert(atom);
  // A proposal closes the proposal it revises, so exactly one is ever open per
  // key; it closes nothing else. When the user rules on the key, the previous
  // value becomes history and any open proposal is closed with it — answered,
  // whether or not it turned out to be right.
  for (const previous of authoritative ? [...supported, ...proposals] : proposals) {
    vault.atoms.supersede(threadId, previous, atom.id, episode.seq);
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
  if (!vault.atomDerivedReady(threadId)) vault.continueMigrations();
  vault.assertAtomDerivedReady(threadId);
  const selectedSeqs: Seq[] = [];
  const seenSeqs = new Set<Seq>();
  let sourceOverflow = false;
  for (const seq of seqs) {
    if (seenSeqs.has(seq)) continue;
    seenSeqs.add(seq);
    if (selectedSeqs.length < MAX_MODEL_ATOM_EPISODES) selectedSeqs.push(seq);
    else sourceOverflow = true;
  }
  const episodes = selectedSeqs
    .map((seq) => vault.episodes.get(threadId, seq))
    .filter((e): e is Episode => e !== null && e.meta.removed !== true);
  if (episodes.length === 0) return [];

  let result: { atoms: ModelAtomCandidate[]; model: string };
  try {
    result = await extractor({ episodes });
  } catch (error) {
    // The model is optional; persist an unresolved receipt before surfacing its
    // failure so a later route cannot mistake an absent model pass for a clean
    // exhaustive scan.
    vault.tx(() => {
      for (const episode of episodes) {
        recordModelReceipt(vault, episode, {
          status: "incomplete",
          candidateCount: 0,
          acceptedCount: 0,
          omittedCount: 0,
          reason: "extractor-output",
        });
      }
    });
    throw error;
  }

  const rawCandidates: unknown = result !== null && typeof result === "object" ? result.atoms : undefined;
  const candidateList = Array.isArray(rawCandidates) ? rawCandidates : [];
  const outputMalformed = !Array.isArray(rawCandidates);
  const candidateCount = candidateList.length;
  const candidateOverflow = candidateCount > MAX_MODEL_ATOM_CANDIDATES;
  const inspectCount = Math.min(candidateCount, MAX_MODEL_ATOM_CANDIDATES);
  const accepted: Array<{ candidate: ModelAtomCandidate; episode: Episode; span: [number, number] }> = [];
  let invalidCount = 0;
  const acceptedBySeq = new Map<Seq, number>();
  for (let index = 0; index < inspectCount; index += 1) {
    const candidate = boundedModelCandidate(candidateList[index]);
    if (candidate === null) {
      invalidCount += 1;
      continue;
    }
    let placed = false;
    for (const episode of episodes) {
      const at = episode.content.indexOf(candidate.quote);
      if (at < 0) continue;
      accepted.push({
        candidate,
        episode,
        span: [at, at + candidate.quote.length],
      });
      acceptedBySeq.set(episode.seq, (acceptedBySeq.get(episode.seq) ?? 0) + 1);
      placed = true;
      break;
    }
    if (!placed) invalidCount += 1;
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
      // `model`, not the quoted episode's role: quoting the user is not being
      // the user (KERNEL A9.1).
      const atom = commit(vault, threadId, entry.episode, draft, `model:${result.model}`, "model");
      if (atom !== null) created.push(atom);
    }
    const model =
      typeof result?.model === "string" &&
      MODEL_TEXT_ENCODER.encode(result.model).byteLength <= MAX_MODEL_ATOM_MODEL_BYTES
        ? result.model
        : undefined;
    const omittedCount =
      Math.max(0, candidateCount - inspectCount) +
      invalidCount +
      (sourceOverflow ? 1 : 0) +
      (model === undefined ? 1 : 0) +
      (outputMalformed ? 1 : 0);
    const status: AtomizationReceipt["status"] =
      candidateOverflow || sourceOverflow || invalidCount > 0 || model === undefined || outputMalformed
        ? "incomplete"
        : "complete";
    const reason: AtomizationReceipt["reason"] = candidateOverflow
      ? "candidate-cap"
      : outputMalformed
        ? "extractor-output"
        : sourceOverflow || invalidCount > 0 || model === undefined
          ? "invalid-candidate"
          : undefined;
    for (const episode of episodes) {
      recordModelReceipt(vault, episode, {
        status,
        model,
        candidateCount,
        acceptedCount: acceptedBySeq.get(episode.seq) ?? 0,
        omittedCount,
        ...(reason === undefined ? {} : { reason }),
      });
    }
  });
  return created;
}

function boundedModelCandidate(value: unknown): ModelAtomCandidate | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ModelAtomCandidate>;
  if (
    typeof candidate.kind !== "string" ||
    !ATOM_KINDS.has(candidate.kind as AtomKind) ||
    typeof candidate.key !== "string" ||
    typeof candidate.value !== "string" ||
    typeof candidate.text !== "string" ||
    typeof candidate.quote !== "string"
  ) {
    return null;
  }
  if (
    MODEL_TEXT_ENCODER.encode(candidate.key).byteLength > MAX_MODEL_ATOM_KEY_BYTES ||
    MODEL_TEXT_ENCODER.encode(candidate.value).byteLength > MAX_MODEL_ATOM_VALUE_BYTES ||
    MODEL_TEXT_ENCODER.encode(candidate.text).byteLength > MAX_MODEL_ATOM_TEXT_BYTES ||
    MODEL_TEXT_ENCODER.encode(candidate.quote).byteLength > MAX_MODEL_ATOM_QUOTE_BYTES ||
    candidate.quote.length < 3
  ) {
    return null;
  }
  return {
    kind: candidate.kind as AtomKind,
    key: candidate.key,
    value: candidate.value,
    text: candidate.text,
    quote: candidate.quote,
  };
}

function recordModelReceipt(
  vault: Vault,
  episode: Episode,
  input: Omit<AtomizationReceipt, "threadId" | "sourceSeq" | "sourceHash" | "createdAt">,
): void {
  vault.atomization.record({
    threadId: episode.threadId,
    sourceSeq: episode.seq,
    sourceHash: episode.hash,
    createdAt: Date.now(),
    ...input,
  });
}
