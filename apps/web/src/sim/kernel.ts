/**
 * Local, browser-safe reimplementation of the Pylos kernel rules that the
 * aperture needs (docs/KERNEL.md §3–§5).
 *
 * This file exists ONLY so the landing page can run while `packages/core` is
 * still being written. It is a faithful restatement of the same rules — same
 * tokenizer, same `names()` vocabulary, same extractive capsule writer, same
 * ledger set algebra, same budget allocation — not an impression of them.
 *
 * When `@pylos/core/pure` lands, `scripts/link-kernel.ts` repoints
 * `src/aperture/kernel-impl.ts` at it and this module is used only as the guard
 * fallback. See `src/aperture/kernel.ts`.
 */

// ---------------------------------------------------------------- tokenizer

/**
 * KERNEL §4: "an approximate tokenizer (chars/3.6 with a 10% safety margin)".
 * The kernel must never exceed the budget by its own count, so the margin is
 * applied upward.
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil((text.length / 3.6) * 1.1);
}

// -------------------------------------------------------------------- names

/**
 * KERNEL §2.1 / §3: the loss-ledger vocabulary — capitalized multiword
 * entities, numbers with units, dates, quoted strings, code identifiers.
 *
 * One combined alternation, ordered longest-form-first, so the whole scan is a
 * single pass. Hot path: this runs over every episode in the stream.
 */
const NAME_RE =
  /"[^"\n]{2,64}"|\b\d{4}-\d{2}-\d{2}\b|\b\d[\d,]*(?:\.\d+)?\s?(?:ms|s|GB|MB|kB|%|x|USD)\b|\b[A-Z][a-z]{2,}(?:[ -][A-Z][a-z]{2,})*\b|\b[a-z]{2,14}(?:[._-][a-z0-9]{1,14})+\b/g;

/**
 * Function words are not routing keys. Without this, every sentence-initial
 * "The" would become a ledger entry and the digest would be noise.
 */
const STOP = new Set([
  "the",
  "this",
  "that",
  "there",
  "then",
  "these",
  "those",
  "and",
  "but",
  "for",
  "with",
  "from",
  "into",
  "what",
  "when",
  "where",
  "which",
]);

/** Normalized routing key: case-folded, whitespace-collapsed, quotes stripped. */
export function normalizeName(raw: string): string {
  let s = raw.trim();
  if (s.length > 1 && s.charCodeAt(0) === 34) s = s.slice(1, -1).trim();
  return s.replace(/\s+/g, " ").toLowerCase();
}

/** `names(x)` — the set of normalized routing keys occurring in `x`. */
export function names(text: string): Set<string> {
  const out = new Set<string>();
  NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null = NAME_RE.exec(text);
  while (m !== null) {
    const n = normalizeName(m[0]);
    if (n.length >= 2 && !STOP.has(n)) out.add(n);
    m = NAME_RE.exec(text);
  }
  return out;
}

/** `names()` with the first offset of each key, so losses carry exact locators. */
export function namesWithSpans(text: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null = NAME_RE.exec(text);
  while (m !== null) {
    const n = normalizeName(m[0]);
    if (n.length >= 2 && !STOP.has(n) && !out.has(n)) out.set(n, [m.index, m.index + m[0].length]);
    m = NAME_RE.exec(text);
  }
  return out;
}

export type LossKind = "entity" | "number" | "quote" | "date" | "code" | "atom";

export function classify(name: string): LossKind {
  if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return "date";
  if (/^\d/.test(name)) return "number";
  if (/[._]/.test(name) && !/ /.test(name)) return "code";
  if (/ /.test(name) && name.split(" ").length > 3) return "quote";
  return "entity";
}

// ----------------------------------------------------------------- episodes

export interface Episode {
  seq: number;
  /** The corpus also emits `system` (a resumed session) and `handoff` turns. */
  role: "user" | "assistant" | "system" | "handoff";
  content: string;
  tokens: number;
}

/** `key = value ⟨#seq⟩` — the certificate form used everywhere in the view. */
export interface CapsuleAtomLine {
  key: string;
  value: string;
  seq: number;
}

export function atomLine(line: CapsuleAtomLine): string {
  return `${line.key} = ${line.value.replace(/\s+/g, " ").trim()} ⟨#${line.seq}⟩`;
}

export interface LossEntry {
  name: string;
  kind: LossKind;
  seq: number;
  /** Optional only because a name carried up from a child may have lost its
   * offsets; the kernel's own `LossEntry` shape is the same. */
  span?: [number, number];
}

export interface Capsule {
  id: string;
  level: number;
  fromSeq: number;
  toSeq: number;
  text: string;
  tokens: number;
  /** Losses created by THIS compaction. */
  dropped: LossEntry[];
  /** |ledger transported from children| — never subtracted. */
  carriedCount: number;
  /** dropped ∪ carried, as routing keys. Kept for the conservation check. */
  ledger: Set<string>;
  /**
   * For every name still present in `text`, the *deepest* locator into the
   * exact archive. Parents inherit these so a loss recorded four levels up
   * still points at the original episode span, never at a capsule.
   */
  locators: Map<string, LossEntry>;
}

// --------------------------------------------------------- capsule geometry

/** KERNEL §3: leaf size S = 32 episodes, fan-out F = 8. */
export const LEAF_SIZE = 32;
export const FAN_OUT = 8;
export const CAPSULE_TOKENS_LEAF = 400;
export const CAPSULE_TOKENS_UP = 600;

const RULE_RE =
  /\b(never|always|from now on|we decided|let's go with|use |remember|correction|actually|must|do not)\b/i;

function firstSentence(text: string): string {
  const i = text.search(/[.!?](\s|$)/);
  return i === -1 ? text : text.slice(0, i + 1);
}

/**
 * KERNEL §3: the deterministic extractive writer. Keeps, in order, every atom
 * line, every decision/rule/task sentence, and the first sentence of each
 * episode, then truncates to the capsule token budget. Value-dense and
 * contract-blind — this is the writer that *creates* the loss the ledger
 * records.
 */
export function writeLeafCapsule(episodes: readonly Episode[], atoms: readonly CapsuleAtomLine[]): string {
  const parts: string[] = [];
  for (const atom of atoms) parts.push(atomLine(atom));
  for (const ep of episodes) {
    const s = firstSentence(ep.content);
    if (RULE_RE.test(ep.content)) {
      // rules and decisions survive whole; everything else is clipped
      parts.push(ep.content.length > 240 ? `${ep.content.slice(0, 240)}…` : ep.content);
    } else {
      parts.push(s);
    }
  }
  return truncateToTokens(parts.join("\n"), CAPSULE_TOKENS_LEAF);
}

export function writeUpperCapsule(children: readonly Capsule[]): string {
  const parts: string[] = [];
  for (const c of children) {
    const lines = c.text.split("\n");
    for (const l of lines) {
      if (RULE_RE.test(l)) parts.push(l);
    }
    parts.push(firstSentence(c.text));
  }
  return truncateToTokens(parts.join("\n"), CAPSULE_TOKENS_UP);
}

/** Mechanical hard truncation — models never get to override the budget. */
export function truncateToTokens(text: string, budget: number): string {
  const maxChars = Math.floor((budget * 3.6) / 1.1);
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n", maxChars);
  return text.slice(0, cut > maxChars * 0.6 ? cut : maxChars);
}

// -------------------------------------------------------------------- ledger

/**
 * `dropped(c) := names(src) \ names(c.text)` with the deepest exact locator.
 */
export function computeDropped(sourceNames: Map<string, LossEntry>, capsuleText: string): LossEntry[] {
  const kept = names(capsuleText);
  const out: LossEntry[] = [];
  for (const [name, entry] of sourceNames) {
    if (!kept.has(name)) out.push(entry);
  }
  return out;
}

/** Build one level-0 capsule from a run of exactly-LEAF_SIZE episodes. */
export function sealLeaf(episodes: readonly Episode[], atoms: readonly CapsuleAtomLine[]): Capsule {
  const sourceNames = new Map<string, LossEntry>();
  for (const ep of episodes) {
    for (const [name, span] of namesWithSpans(ep.content)) {
      // deepest (most recent) locator wins — §5.1 pages most-recent-first
      sourceNames.set(name, { name, kind: classify(name), seq: ep.seq, span });
    }
  }
  const text = writeLeafCapsule(episodes, atoms);
  const kept = names(text);
  const dropped: LossEntry[] = [];
  const locators = new Map<string, LossEntry>();
  for (const [name, entry] of sourceNames) {
    if (kept.has(name)) locators.set(name, entry);
    else dropped.push(entry);
  }
  const ledger = new Set<string>();
  for (const d of dropped) ledger.add(d.name);
  const from = episodes[0]?.seq ?? 0;
  const to = episodes[episodes.length - 1]?.seq ?? from;
  return {
    id: `c0:${from}`,
    level: 0,
    fromSeq: from,
    toSeq: to,
    text,
    tokens: countTokens(text),
    dropped,
    carriedCount: 0,
    ledger,
    locators,
  };
}

/**
 * Build a level-k capsule from exactly FAN_OUT children.
 * Conservation: `ledger(p) ⊇ ⋃ ledger(c)`. Carried entries are transported, never
 * subtracted; re-summarizing may only add.
 */
export function sealParent(children: readonly Capsule[]): Capsule {
  const level = (children[0]?.level ?? 0) + 1;
  const sourceNames = new Map<string, LossEntry>();
  const carried = new Set<string>();
  let carriedCount = 0;
  for (const c of children) {
    for (const n of c.ledger) carried.add(n);
    carriedCount += c.ledger.size;
    // deepest source: the child already resolved each surviving name to an
    // episode span, so the parent inherits the locator rather than inventing one
    for (const [name, entry] of c.locators) sourceNames.set(name, entry);
  }
  const text = writeUpperCapsule(children);
  const kept = names(text);
  const dropped: LossEntry[] = [];
  const locators = new Map<string, LossEntry>();
  for (const [name, entry] of sourceNames) {
    if (kept.has(name)) locators.set(name, entry);
    else dropped.push(entry);
  }
  const ledger = new Set<string>(carried);
  for (const d of dropped) ledger.add(d.name);
  const from = children[0]?.fromSeq ?? 0;
  const to = children[children.length - 1]?.toSeq ?? from;
  return {
    id: `c${level}:${from}`,
    level,
    fromSeq: from,
    toSeq: to,
    text,
    tokens: countTokens(text),
    dropped,
    carriedCount,
    ledger,
    locators,
  };
}

// ------------------------------------------------------------ the compiler

export interface CompileInput {
  budget: number;
  /** Header text: identity, turn count, archive size, the view contract. */
  header: string;
  /** Certificate lines `key = value ⟨#seq⟩`, most important first. */
  frontier: readonly string[];
  /** O(log n) capsules covering the prefix, coarse → fine. */
  capsules: readonly Capsule[];
  /** Exact episodes recovered this turn, each prefixed ⟦recovered #seq · trigger⟧. */
  paged: readonly string[];
  /** Most recent episodes verbatim, newest first. */
  recent: readonly string[];
  /** Resident ledger digest size. */
  ledgerCount: number;
}

export type Slot = "header" | "frontier" | "capsules" | "paged" | "recent";

export interface Packet {
  budget: number;
  tokens: number;
  /** Tokens actually spent per slot. */
  slots: Record<Slot, number>;
  /** The cap each slot was allowed. */
  caps: Record<Slot, number>;
  ledgerCount: number;
  pagedCount: number;
  capsuleCount: number;
}

/** KERNEL §4 budget allocation. Shares are caps, not reservations. */
export const SHARES: Record<Slot, number> = {
  header: 0.04,
  frontier: 0.2,
  capsules: 0.18,
  paged: 0.18,
  recent: 0.4,
};

function fill(items: readonly string[], cap: number, extra = 0): number {
  let used = 0;
  for (const it of items) {
    const t = countTokens(it) + extra;
    if (used + t > cap) break;
    used += t;
  }
  return used;
}

/**
 * `C_B(H_t, q_t) → K_t`. Fills each slot up to its cap, coarse→fine for
 * capsules and newest-first for recent, then lets `recent` absorb the
 * remainder. The result must never exceed B by the kernel's own count.
 */
export function compile(input: CompileInput): Packet {
  const B = input.budget;
  const caps: Record<Slot, number> = {
    header: Math.floor(B * SHARES.header),
    frontier: Math.floor(B * SHARES.frontier),
    capsules: Math.floor(B * SHARES.capsules),
    paged: Math.floor(B * SHARES.paged),
    recent: Math.floor(B * SHARES.recent),
  };

  const header = Math.min(countTokens(input.header), caps.header);
  const frontier = fill(input.frontier, caps.frontier);

  // each capsule is followed by its ledger digest ⟨lost: n · names: …⟩
  let capsules = 0;
  let capsuleCount = 0;
  for (const c of input.capsules) {
    const digest = ledgerDigest(c);
    const t = c.tokens + countTokens(digest);
    if (capsules + t > caps.capsules) break;
    capsules += t;
    capsuleCount += 1;
  }

  let paged = 0;
  let pagedCount = 0;
  for (const p of input.paged) {
    const t = countTokens(p);
    if (paged + t > caps.paged) break;
    paged += t;
    pagedCount += 1;
  }

  const spent = header + frontier + capsules + paged;
  const recentCap = Math.max(caps.recent, B - spent);
  const recent = fill(input.recent, Math.min(recentCap, B - spent));

  const tokens = spent + recent;
  return {
    budget: B,
    tokens,
    slots: { header, frontier, capsules, paged, recent },
    caps,
    ledgerCount: input.ledgerCount,
    pagedCount,
    capsuleCount,
  };
}

/** The resident digest a capsule carries into the packet. */
export function ledgerDigest(c: Capsule, maxNames = 6): string {
  const list: string[] = [];
  for (const n of c.ledger) {
    if (list.length >= maxNames) break;
    list.push(n);
  }
  return `⟨lost: ${c.ledger.size} · names: ${list.join(", ")}${c.ledger.size > maxNames ? " …" : ""}⟩`;
}

// -------------------------------------------------------------------- pager

export interface PageRequest {
  query: string;
  /** name → locator, as the resident page map §4 `P_t`. */
  index: Map<string, LossEntry>;
}

export interface PageRecord {
  trigger: "ledger" | "historical" | "lexical" | "model";
  name: string;
  seq: number;
  span?: [number, number];
  resolved: boolean;
}

/**
 * KERNEL §5.1 — ledger routing. `names(q) ∩ loss.name` → page the exact source
 * spans, most recent locator first. A page that finds no exact material returns
 * UNKNOWN; pages are never fuzzy.
 */
export function routeByLedger(req: PageRequest, limit = 4): PageRecord[] {
  const out: PageRecord[] = [];
  const wanted = names(req.query);
  const hits: LossEntry[] = [];
  for (const n of wanted) {
    const e = req.index.get(n);
    if (e) hits.push(e);
  }
  hits.sort((a, b) => b.seq - a.seq);
  for (const e of hits.slice(0, limit)) {
    out.push({ trigger: "ledger", name: e.name, seq: e.seq, span: e.span, resolved: true });
  }
  return out;
}

/** Marker so the aperture can report which engine it actually ran. */
export const KERNEL_SOURCE = "sim" as const;
