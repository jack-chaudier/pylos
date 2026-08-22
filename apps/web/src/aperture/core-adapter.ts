/**
 * `@pylos/core/pure`, wearing the shape the aperture asks for.
 *
 * The kernel's browser-safe half exposes its pieces separately —
 * `names`/`deriveLedger`/`writeCapsule`/`allocate`/`renderCapsules` — because
 * the compiler in `packages/core` assembles them against a vault. The aperture
 * has no vault; it streams a synthetic thread. This module does the assembling,
 * so that every rule the landing page demonstrates is executed by the real
 * implementation and not by a copy of it:
 *
 *   names()               → pure/names.ts
 *   the extractive writer → pure/capsule.ts writeCapsule + capsuleBudget
 *   dropped / kept        → pure/ledger.ts deriveLedger
 *   the ledger digest     → pure/ledger.ts renderLedgerDigest
 *   budget allocation     → pure/budget.ts allocate
 *   header / capsules     → pure/render.ts renderHeader, renderCapsules, renderPaged
 *   the tokenizer         → pure/tokens.ts approxTokens
 *
 * Only the hierarchy's geometry (leaf 32, fan-out 8) is stated here, because it
 * lives in the compaction scheduler on the vault side, which a browser has no
 * business importing. It is the same constant, from KERNEL §3.
 *
 * If any of the above stops existing, `kernel.ts` rejects this module and the
 * page runs — and says it is running — the local simulation instead.
 */

import {
  allocate,
  approxTokens,
  atomLine,
  type CapsuleView,
  capsuleBudget,
  names as coreNames,
  deriveLedger,
  nameSet,
  queryNames,
  renderCapsules,
  renderLedgerDigest,
  renderPaged,
  type SourceName,
  writeCapsule,
} from "@pylos/core/pure";

import type {
  Capsule,
  CapsuleAtomLine,
  CompileInput,
  Episode,
  LossEntry,
  LossKind,
  Packet,
  PageRecord,
  PageRequest,
  Slot,
} from "../sim/kernel";

/** KERNEL §3: leaf size S = 32 episodes, fan-out F = 8. */
export const LEAF_SIZE = 32;
export const FAN_OUT = 8;

const MAX_NAMES_PER_TEXT = 4096;

// ── the pieces the aperture uses directly ───────────────────────────────────

export const countTokens = approxTokens;

export function names(text: string): Set<string> {
  return nameSet(text, { max: MAX_NAMES_PER_TEXT });
}

export function namesWithSpans(text: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const hit of coreNames(text, { max: MAX_NAMES_PER_TEXT })) {
    if (!out.has(hit.name)) out.set(hit.name, [hit.start, hit.end]);
  }
  return out;
}

export function classify(name: string): LossKind {
  return (coreNames(name, { max: 1 })[0]?.kind ?? "entity") as LossKind;
}

export { atomLine };

export function ledgerDigest(c: Capsule, maxNames = 6): string {
  const sample: string[] = [];
  for (const n of c.ledger) {
    if (sample.length >= maxNames) break;
    sample.push(n);
  }
  return renderLedgerDigest(c.ledger.size, sample, maxNames);
}

// ── sealing ─────────────────────────────────────────────────────────────────

function toCapsule(
  level: number,
  fromSeq: number,
  toSeq: number,
  text: string,
  tokens: number,
  dropped: readonly LossEntry[],
  kept: readonly LossEntry[],
  carried: Set<string>,
  carriedCount: number,
): Capsule {
  const ledger = new Set<string>(carried);
  for (const d of dropped) ledger.add(d.name);
  const locators = new Map<string, LossEntry>();
  for (const k of kept) locators.set(k.name, k);
  return {
    id: `c${level}:${fromSeq}`,
    level,
    fromSeq,
    toSeq,
    text,
    tokens,
    dropped: dropped as LossEntry[],
    carriedCount,
    ledger,
    locators,
  };
}

export function sealLeaf(episodes: readonly Episode[], atoms: readonly CapsuleAtomLine[]): Capsule {
  const source: SourceName[] = [];
  for (const ep of episodes) {
    for (const hit of coreNames(ep.content, { max: 64 })) {
      source.push({ name: hit.name, kind: hit.kind, seq: ep.seq, span: [hit.start, hit.end] });
    }
  }
  const written = writeCapsule(
    episodes.map((ep) => ({ seq: ep.seq, text: ep.content })),
    atoms,
    { maxTokens: capsuleBudget(0) },
  );
  const { dropped, kept } = deriveLedger(source, written.text);
  const from = episodes[0]?.seq ?? 0;
  const to = episodes[episodes.length - 1]?.seq ?? from;
  return toCapsule(0, from, to, written.text, written.tokens, dropped, kept, new Set(), 0);
}

export function sealParent(children: readonly Capsule[]): Capsule {
  const level = (children[0]?.level ?? 0) + 1;
  const source: SourceName[] = [];
  const carried = new Set<string>();
  let carriedCount = 0;

  for (const c of children) {
    for (const n of c.ledger) carried.add(n);
    carriedCount += c.ledger.size;
    // deepest source: the child already resolved every surviving name to an
    // episode span, so a loss recorded here still points at the original turn
    for (const entry of c.locators.values()) {
      source.push(
        entry.span
          ? { name: entry.name, kind: entry.kind, seq: entry.seq, span: entry.span }
          : { name: entry.name, kind: entry.kind, seq: entry.seq },
      );
    }
  }

  const written = writeCapsule(
    children.map((c) => ({ seq: c.toSeq, text: c.text })),
    [],
    { maxTokens: capsuleBudget(level) },
  );
  const { dropped, kept } = deriveLedger(source, written.text);
  const from = children[0]?.fromSeq ?? 0;
  const to = children[children.length - 1]?.toSeq ?? from;
  return toCapsule(level, from, to, written.text, written.tokens, dropped, kept, carried, carriedCount);
}

// ── the compiler ────────────────────────────────────────────────────────────

function fill(items: readonly string[], cap: number): number {
  let used = 0;
  for (const it of items) {
    const t = approxTokens(it);
    if (used + t > cap) break;
    used += t;
  }
  return used;
}

/**
 * `C_B(H_t, q_t) → K_t`, assembled from the kernel's own allocator and
 * renderers. Slots are caps, not reservations; `recent` absorbs the remainder.
 */
export function compile(input: CompileInput): Packet {
  const B = input.budget;
  const a = allocate(B);
  const caps: Record<Slot, number> = {
    header: a.header,
    frontier: a.frontier,
    capsules: a.capsules,
    paged: a.paged,
    recent: a.recent,
  };

  const header = Math.min(approxTokens(input.header), caps.header);
  const frontier = fill(input.frontier, caps.frontier);

  const views: CapsuleView[] = input.capsules.map((c) => ({
    id: c.id,
    level: c.level,
    fromSeq: c.fromSeq,
    toSeq: c.toSeq,
    text: c.text,
    lossCount: c.ledger.size,
    lossNames: sample(c.ledger, 8),
  }));
  const rendered = renderCapsules(views, caps.capsules);
  const capsules = Math.min(rendered.tokens, caps.capsules);

  const pagedRender = renderPaged(
    input.paged.map((text, i) => ({
      seq: i,
      role: "user",
      trigger: "ledger",
      text,
      epistemic: "SUPPORTED" as const,
    })),
    caps.paged,
  );
  const paged = pagedRender.tokens;
  const pagedCount = pagedRender.included.length;

  const spent = header + frontier + capsules + paged;
  const recent = fill(input.recent, Math.max(0, Math.min(caps.recent, B - spent)));

  return {
    budget: B,
    tokens: spent + recent,
    slots: { header, frontier, capsules, paged, recent },
    caps,
    ledgerCount: input.ledgerCount,
    pagedCount,
    capsuleCount: rendered.included.length,
  };
}

// ── the pager ───────────────────────────────────────────────────────────────

/**
 * KERNEL §5.1 — ledger routing, using the kernel's own `queryNames`. Exact,
 * most recent locator first, never fuzzy.
 */
export function routeByLedger(req: PageRequest, limit = 4): PageRecord[] {
  const hits: LossEntry[] = [];
  for (const hit of queryNames(req.query)) {
    const e = req.index.get(hit.name);
    if (e) hits.push(e);
  }
  hits.sort((x, y) => y.seq - x.seq);
  const out: PageRecord[] = [];
  for (const e of hits.slice(0, limit)) {
    out.push({
      trigger: "ledger",
      name: e.name,
      seq: e.seq,
      span: e.span ?? [0, 0],
      resolved: true,
    });
  }
  return out;
}

function sample(set: ReadonlySet<string>, n: number): string[] {
  const out: string[] = [];
  for (const v of set) {
    if (out.length >= n) break;
    out.push(v);
  }
  return out;
}

export const KERNEL_SOURCE = "core" as const;
