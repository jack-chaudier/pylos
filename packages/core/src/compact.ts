/**
 * Compaction: capsules with loss ledgers (KERNEL §3, A2, A3).
 *
 * The hierarchy (leaf 32 episodes, fan-out 8) is what *constructs* the ledger:
 * every contraction event records the names its text no longer contains, once,
 * at the deepest drop. Residency is a separate question (KERNEL A3): the packet
 * shows a **rolling root** plus the most recent leaf capsules, a fixed-size set,
 * so the view does not grow with the archive.
 *
 * The invariant that matters is completeness:
 *
 *     names(episodes[c.from..c.to]) ⊆ names(c.text) ∪ ledger(c)
 *     ledger(c) := unresolved loss rows with seq ∈ [c.from, c.to]
 *
 * Conservation (`ledger(parent) ⊇ ⋃ ledger(children)`) then holds by
 * construction, because `ledger` is a range query over an append-only table.
 */

import {
  CAPSULE_FANOUT,
  type Capsule,
  DEFAULT_BUDGET,
  LEAF_CAPSULE_EPISODES,
  type LossEntry,
  type Seq,
} from "@pylos/protocol";
import { canonicalHash } from "./hash.ts";
import { type CapsuleAtomLine, type CapsuleUnit, writeCapsule } from "./pure/capsule.ts";
import { deriveLedger, type SourceName, sourceNamesOfEpisode } from "./pure/ledger.ts";
import { normalizeName } from "./pure/names.ts";
import { lossExists, type StoredCapsule, type Vault } from "./vault.ts";

/** The rolling root's level. Above every hierarchy level, and unique per thread. */
export const ROOT_LEVEL = 99;

/** Capsule token budgets derived from the packet budget (KERNEL A3). */
export interface CapsuleTokens {
  leaf: number;
  mid: number;
  root: number;
}

export function capsuleTokensFor(budget: number): CapsuleTokens {
  return {
    leaf: Math.max(150, Math.floor(budget / 40)),
    mid: Math.max(200, Math.floor(budget / 32)),
    root: Math.max(300, Math.floor(budget / 16)),
  };
}

/**
 * How many leaf capsules stay resident alongside the rolling root.
 * Sized so `root + leaves ≤ 18%` of the budget — the capsules slot — and so the
 * cover is **gapless**: root ∪ leaves reaches the last sealed leaf boundary, and
 * the recent window covers the ≤ 31 episodes after it.
 */
export function residentLeafCount(budget: number): number {
  const tokens = capsuleTokensFor(budget);
  const slot = Math.floor(budget * 0.18);
  return Math.max(2, Math.min(6, Math.floor((slot - tokens.root) / Math.max(1, tokens.leaf))));
}

/** The span, in episodes, of a level-`k` capsule: `32 · 8^k`. */
export function levelSpan(level: number): number {
  return LEAF_CAPSULE_EPISODES * CAPSULE_FANOUT ** level;
}

export interface CompactOptions {
  /** Packet budget the capsule sizes derive from. Defaults to the thread setting. */
  budget?: number;
  /** Optional model writer; its output is hard-truncated by the kernel (KERNEL §3). */
  writer?: CapsuleWriter;
  /** Stop sealing above this level (tests). */
  maxLevel?: number;
}

/** A pluggable capsule writer. The kernel truncates whatever it returns. */
export type CapsuleWriter = (input: {
  level: number;
  units: CapsuleUnit[];
  atoms: CapsuleAtomLine[];
  maxTokens: number;
}) => string;

/**
 * Seal every capsule whose boundary has been crossed, and roll the root forward.
 * Idempotent: calling it twice does nothing the second time. Amortized O(1) per
 * turn — a leaf seals once every 32 episodes, a level-k capsule once every
 * `32·8^k`, and the root absorbs one leaf every 32.
 */
export function compact(vault: Vault, threadId: string, options: CompactOptions = {}): StoredCapsule[] {
  return vault.tx(() => {
    const thread = vault.threads.get(threadId);
    if (thread === null) return [];
    const budget = options.budget ?? (thread.settings.budget as number | undefined) ?? DEFAULT_BUDGET;
    const tokens = capsuleTokensFor(budget);
    const head = thread.headSeq;
    const sealed: StoredCapsule[] = [];

    // --- level 0: leaves over episodes
    const lastLeaf = maxSealed(vault, threadId, 0);
    for (let to = lastLeaf + LEAF_CAPSULE_EPISODES; to <= head; to += LEAF_CAPSULE_EPISODES) {
      sealed.push(sealLeaf(vault, threadId, to - LEAF_CAPSULE_EPISODES + 1, to, tokens.leaf, options));
    }

    // --- levels 1..: each is a 5× contraction of its 8 children
    const maxLevel = options.maxLevel ?? 8;
    for (let level = 1; level <= maxLevel; level += 1) {
      const span = levelSpan(level);
      if (span > head) break;
      const last = maxSealed(vault, threadId, level);
      for (let to = last + span; to <= head; to += span) {
        const capsule = sealUpper(vault, threadId, level, to - span + 1, to, tokens.mid, options);
        if (capsule !== null) sealed.push(capsule);
      }
    }

    // --- the rolling root absorbs leaves as they leave the resident window
    const rolled = rollRoot(vault, threadId, budget, tokens.root, options);
    if (rolled !== null) sealed.push(rolled);

    return sealed;
  });
}

function maxSealed(vault: Vault, threadId: string, level: number): number {
  // `MAX(to_seq)` cannot use `capsule_range`; ordering by the indexed column can.
  const row = vault.db
    .query("SELECT to_seq AS m FROM capsule WHERE thread_id = ? AND level = ? ORDER BY from_seq DESC LIMIT 1")
    .get(threadId, level) as { m: number } | null;
  return row?.m ?? 0;
}

function sealLeaf(
  vault: Vault,
  threadId: string,
  from: Seq,
  to: Seq,
  maxTokens: number,
  options: CompactOptions,
): StoredCapsule {
  const episodes = vault.episodes.range(threadId, from, to);
  // A proposal is never a certificate (KERNEL A9.1): it must not be frozen into
  // capsule text, where it would read as settled long after its turn scrolled by.
  const atoms = vault.atoms.inRange(threadId, from, to).filter((a) => a.phase !== "PROPOSED");
  const units: CapsuleUnit[] = episodes.map((e) => ({ seq: e.seq, text: e.content }));
  const atomLines: CapsuleAtomLine[] = atoms.map((a) => ({
    key: a.key,
    value: a.value,
    seq: a.sourceSeq,
  }));

  const source = sourceNamesForRange(vault, threadId, from, to);

  const text = renderText(options, { level: 0, units, atoms: atomLines, maxTokens });
  const { dropped, kept } = deriveLedger(source, text.text);
  const capsule = store(vault, threadId, 0, from, to, text.text, text.tokens, dropped, kept, options);
  vault.losses.add(threadId, capsule.id, 0, dropped);
  return capsule;
}

function sealUpper(
  vault: Vault,
  threadId: string,
  level: number,
  from: Seq,
  to: Seq,
  maxTokens: number,
  options: CompactOptions,
): StoredCapsule | null {
  const children = vault.capsules.children(threadId, level, from, to);
  if (children.length === 0) return null;
  const units: CapsuleUnit[] = children.map((c) => ({ seq: c.fromSeq, text: c.text }));
  const source: SourceName[] = [];
  for (const child of children) {
    for (const entry of child.kept) {
      source.push({
        name: entry.name,
        kind: entry.kind,
        seq: entry.seq,
        ...(entry.span ? { span: entry.span } : {}),
      });
    }
  }
  const text = renderText(options, { level, units, atoms: [], maxTokens });
  const { dropped, kept } = deriveLedger(source, text.text);
  const fresh = dropped.filter((entry) => !lossExists(vault, threadId, entry.name, entry.seq));
  const carried = children.reduce((sum, c) => sum + c.dropped.length + c.carriedCount, 0);
  const capsule = store(
    vault,
    threadId,
    level,
    from,
    to,
    text.text,
    text.tokens,
    dropped,
    kept,
    options,
    carried,
  );
  vault.losses.add(threadId, capsule.id, level, fresh);
  return capsule;
}

/**
 * The rolling root: one capsule covering `[1, r]`, recompacted each time a leaf
 * leaves the resident window. Rows 18/37/38 license this — loss is
 * contraction-gated, not generation-gated, so a rolling root is as safe as a
 * tree of fixed depth, and the ledger keeps every name it drops.
 */
function rollRoot(
  vault: Vault,
  threadId: string,
  budget: number,
  maxTokens: number,
  options: CompactOptions,
): StoredCapsule | null {
  const lastLeafEnd = maxSealed(vault, threadId, 0);
  const target = lastLeafEnd - residentLeafCount(budget) * LEAF_CAPSULE_EPISODES;
  if (target <= 0) return null;

  let root = vault.capsules.at(threadId, ROOT_LEVEL, 1);
  let changed = false;
  for (;;) {
    const nextFrom = (root?.toSeq ?? 0) + 1;
    const leaving = vault.capsules.at(threadId, 0, nextFrom);
    if (leaving === null || leaving.toSeq > target) break;

    const units: CapsuleUnit[] = [];
    // A certificate whose key has since been revised is exactly the mirage this
    // system exists to prevent, and it must not squat in the root forever. Drop
    // it here; `deriveLedger` then records its names as lost, with locators, so
    // the old value stays exactly pageable instead of quietly looking current.
    const rootText = root === null ? "" : pruneSuperseded(vault, threadId, root.text);
    const leavingText = pruneSuperseded(vault, threadId, leaving.text);
    if (rootText.length > 0) units.push({ seq: root?.fromSeq ?? 1, text: rootText });
    units.push({ seq: leaving.fromSeq, text: leavingText });
    const source: SourceName[] = [];
    for (const entry of [...(root?.kept ?? []), ...leaving.kept]) {
      source.push({
        name: entry.name,
        kind: entry.kind,
        seq: entry.seq,
        ...(entry.span ? { span: entry.span } : {}),
      });
    }
    const text = renderText(options, { level: ROOT_LEVEL, units, atoms: [], maxTokens });
    const { dropped, kept } = deriveLedger(source, text.text);
    const from = 1;
    const to = leaving.toSeq;
    const fresh = dropped.filter((entry) => !lossExists(vault, threadId, entry.name, entry.seq));

    const next: StoredCapsule = {
      id: root?.id ?? `root:${threadId}`,
      threadId,
      level: ROOT_LEVEL,
      fromSeq: from,
      toSeq: to,
      text: text.text,
      tokens: text.tokens,
      dropped,
      carriedCount:
        (root?.carriedCount ?? 0) +
        (root?.dropped.length ?? 0) +
        leaving.dropped.length +
        leaving.carriedCount,
      kept,
      hash: canonicalHash({ level: ROOT_LEVEL, from, to, text: text.text }),
      createdBy: options.writer ? "model" : "extractive",
      createdAt: Date.now(),
    };
    if (root === null) vault.capsules.insert(next);
    else vault.capsules.replace(next);
    vault.losses.add(threadId, next.id, ROOT_LEVEL, fresh);
    root = next;
    changed = true;
  }
  return changed ? root : null;
}

const CERTIFICATE = /^(\S+) = (.*) ⟨#(\d+)⟩$/;

/** Remove capsule lines whose atom key has a newer SUPPORTED value. */
function pruneSuperseded(vault: Vault, threadId: string, text: string): string {
  if (!text.includes(" = ")) return text;
  const cache = new Map<string, number | null>();
  return text
    .split("\n")
    .filter((line) => {
      const match = CERTIFICATE.exec(line);
      if (match === null) return true;
      const key = match[1] as string;
      let current = cache.get(key);
      if (current === undefined) {
        const row = vault.db
          .query(
            "SELECT MAX(valid_from_seq) AS s FROM atom WHERE thread_id = ? AND key = ? AND phase = 'SUPPORTED'",
          )
          .get(threadId, key) as { s: number | null };
        current = row.s;
        cache.set(key, current);
      }
      return current === null || current <= Number(match[3]);
    })
    .join("\n");
}

function renderText(
  options: CompactOptions,
  input: { level: number; units: CapsuleUnit[]; atoms: CapsuleAtomLine[]; maxTokens: number },
): { text: string; tokens: number } {
  if (options.writer) {
    // Row 30: models override word budgets, so enforcement is mechanical — the
    // kernel hard-truncates whatever the writer returns and computes dropped()
    // on the post-truncation text.
    const raw = options.writer(input);
    const cut = writeCapsule([{ seq: 0, text: raw }], [], { maxTokens: input.maxTokens });
    return { text: cut.text, tokens: cut.tokens };
  }
  const written = writeCapsule(input.units, input.atoms, { maxTokens: input.maxTokens });
  return { text: written.text, tokens: written.tokens };
}

function store(
  vault: Vault,
  threadId: string,
  level: number,
  from: Seq,
  to: Seq,
  text: string,
  tokens: number,
  dropped: LossEntry[],
  kept: LossEntry[],
  options: CompactOptions,
  carried = 0,
): StoredCapsule {
  const capsule: StoredCapsule = {
    id: `cap:${threadId}:${level}:${from}`,
    threadId,
    level,
    fromSeq: from,
    toSeq: to,
    text,
    tokens,
    dropped,
    carriedCount: carried,
    kept,
    hash: canonicalHash({ level, from, to, text }),
    createdBy: options.writer ? "model" : "extractive",
    createdAt: Date.now(),
  };
  vault.capsules.insert(capsule);
  return capsule;
}

/**
 * The routing vocabulary of an episode range: every name in every episode, plus
 * every atom key and value whose validity starts inside the range (KERNEL A1).
 * Shared by the compactor and by the completeness test, so the test cannot
 * accidentally check a different definition than the one the kernel uses.
 */
export function sourceNamesForRange(vault: Vault, threadId: string, from: Seq, to: Seq): SourceName[] {
  const source: SourceName[] = [];
  for (const episode of vault.episodes.range(threadId, from, to)) {
    if (episode.meta.removed === true) continue;
    source.push(...sourceNamesOfEpisode(episode.seq, episode.content));
  }
  for (const atom of vault.atoms.inRange(threadId, from, to)) {
    const span = atom.sourceSpan ? { span: atom.sourceSpan } : {};
    source.push({ name: normalizeName(atom.key, "atom"), kind: "atom", seq: atom.sourceSeq, ...span });
    const value = normalizeName(atom.value, "atom");
    if (value.length > 1) {
      source.push({ name: value, kind: "atom", seq: atom.sourceSeq, ...span });
    }
  }
  return source;
}

/** The fixed resident capsule set: the rolling root, then the recent leaves. */
export function residentCapsules(vault: Vault, threadId: string): StoredCapsule[] {
  const root = vault.capsules.at(threadId, ROOT_LEVEL, 1);
  // Everything the root has not absorbed, in order: the cover is gapless by
  // construction, and asking for "the last k leaves" instead would leave a hole
  // whenever this budget differs from the one the capsules were sealed for.
  const leaves = vault.capsules.after(threadId, 0, root?.toSeq ?? 0, 16);
  return root === null ? leaves : [root, ...leaves];
}

/** The last episode covered by a capsule; the recent window starts after it. */
export function coveredTo(vault: Vault, threadId: string): Seq {
  const row = vault.db
    .query("SELECT MAX(to_seq) AS m FROM capsule WHERE thread_id = ? AND level = 0")
    .get(threadId) as { m: number | null };
  return row.m ?? 0;
}

/** Recompute a capsule's ledger from the episodes, for tests and the bench. */
export function capsuleLedgerNames(vault: Vault, capsule: Capsule): Set<string> {
  const names = new Set<string>();
  for (const entry of vault.losses.inRange(capsule.threadId, capsule.fromSeq, capsule.toSeq)) {
    names.add(entry.name);
  }
  return names;
}
