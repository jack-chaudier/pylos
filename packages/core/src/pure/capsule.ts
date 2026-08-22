/**
 * The deterministic extractive capsule writer (KERNEL §3).
 *
 * Contract-blind and value-dense: it never paraphrases, so every line it emits
 * is a verbatim span of its source. That is what makes the loss ledger sound —
 * `names(capsule.text) ⊆ names(src)` holds by construction, so a name that is
 * missing from the capsule really is missing from the view.
 *
 * Priority order (KERNEL §3): atom certificate lines, then decision/rule/task
 * sentences, then the first sentence of each source unit. Truncation happens at
 * line boundaries only, and what it removed is returned so the caller can put it
 * in the ledger rather than losing it quietly.
 */

import type { Seq } from "@pylos/protocol";
import { isSalient, splitSentences } from "./rules.ts";
import { approxTokens, type Tokenizer, truncateLines } from "./tokens.ts";

/** One piece of source material: an episode (level 0) or a child capsule (level > 0). */
export interface CapsuleUnit {
  /** Locator for the unit — the episode seq, or a child capsule's first seq. */
  seq: Seq;
  text: string;
  /** Optional label rendered before the first sentence, e.g. `user` / `assistant`. */
  label?: string;
}

/** An atom certificate line, `key = value ⟨#seq⟩`. */
export interface CapsuleAtomLine {
  key: string;
  value: string;
  seq: Seq;
}

export interface CapsuleWriteOptions {
  maxTokens: number;
  tokenizer?: Tokenizer;
  /** Max sentences kept per unit at priority 2. Default 1 (the first sentence). */
  leadSentences?: number;
}

export interface CapsuleWriteResult {
  text: string;
  tokens: number;
  /** Lines the token budget forced out. Their names still reach the ledger. */
  truncated: string[];
}

/** Default capsule token budgets: 400 at level 0, 600 above (KERNEL §3). */
export function capsuleBudget(level: number): number {
  return level === 0 ? 400 : 600;
}

/** `key = value ⟨#seq⟩` — the certificate form used everywhere in the view. */
export function atomLine(line: CapsuleAtomLine): string {
  return `${line.key} = ${collapse(line.value)} ⟨#${line.seq}⟩`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const ATOM_LINE = / = .* ⟨#\d+⟩$/;
const MARKED = /⟨#\d+⟩$/;

/**
 * Write a capsule over `units`, given the atoms whose validity starts inside the
 * covered range.
 */
export function writeCapsule(
  units: readonly CapsuleUnit[],
  atoms: readonly CapsuleAtomLine[],
  options: CapsuleWriteOptions,
): CapsuleWriteResult {
  const tokenizer = options.tokenizer ?? approxTokens;
  const lead = options.leadSentences ?? 1;
  const seen = new Set<string>();
  const tier0: string[] = [];
  const tier1: string[] = [];
  const tier2: string[] = [];

  const push = (bucket: string[], line: string): void => {
    const value = collapse(line);
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    bucket.push(value);
  };

  for (const atom of atoms) push(tier0, atomLine(atom));

  for (const unit of units) {
    const isCapsuleText = unit.text.includes("\n") && MARKED.test(unit.text.split("\n")[0] ?? "");
    if (isCapsuleText) {
      // Level > 0: the source is child capsule text, already one claim per line.
      // Capsule text is already one claim per line: keep every line and let the
      // token budget decide what survives, so the contraction is visible in the
      // ledger rather than hidden in an arbitrary per-unit cap.
      for (const line of unit.text.split("\n")) {
        if (ATOM_LINE.test(line)) push(tier0, line);
        else if (isSalient(line)) push(tier1, line);
        else push(tier2, line);
      }
      continue;
    }
    const sentences = splitSentences(unit.text);
    let leads = 0;
    for (const sentence of sentences) {
      if (isSalient(sentence.text)) {
        push(tier1, `${sentence.text} ⟨#${unit.seq}⟩`);
      } else if (leads < lead) {
        const prefix = unit.label ? `${unit.label}: ` : "";
        push(tier2, `${prefix}${sentence.text} ⟨#${unit.seq}⟩`);
        leads += 1;
      }
    }
  }

  const all = [...tier0, ...tier1, ...tier2];
  const joined = all.join("\n");
  const cut = truncateLines(joined, options.maxTokens, tokenizer);
  const truncated = cut.dropped.length > 0 ? cut.dropped.split("\n").filter((l) => l.length > 0) : [];
  return { text: cut.kept, tokens: cut.keptTokens, truncated };
}
