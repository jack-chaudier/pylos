/**
 * The loss ledger — mechanical, exact, conserved (KERNEL §3).
 *
 *   names(x)   := normalized routing keys found in x
 *   dropped(c) := names(src) \ names(c.text)      each with an exact locator
 *   carried(c) := ⋃_child (dropped(child) ∪ carried(child))
 *   ledger(c)  := dropped(c) ∪ carried(c)
 *
 * The set algebra lives here, in pure code, so it can be run in a browser and
 * checked in a test without a database. The database is only an index over it.
 */

import {
  CAPSULE_SOURCE_EPISODE_BYTES,
  CAPSULE_SOURCE_NAMES_PER_EPISODE,
  type LossEntry,
  type LossKind,
  type Seq,
} from "@pylos/protocol";
import { names } from "./names.ts";

export function capsuleSourceContentFailure(content: string): string | null {
  if (
    content.length > CAPSULE_SOURCE_EPISODE_BYTES / 4 &&
    new TextEncoder().encode(content).byteLength > CAPSULE_SOURCE_EPISODE_BYTES
  ) {
    return `episode exceeds capsule source byte capacity (${CAPSULE_SOURCE_EPISODE_BYTES})`;
  }
  if (!/[`"'“”0-9A-Z_./$€£-]/u.test(content)) return null;
  if (
    names(content, { max: CAPSULE_SOURCE_NAMES_PER_EPISODE, stopWhenExceeded: true }).length >
    CAPSULE_SOURCE_NAMES_PER_EPISODE
  ) {
    return `episode exceeds capsule source-name capacity (${CAPSULE_SOURCE_NAMES_PER_EPISODE})`;
  }
  return null;
}

/** A routing key found in a capsule's source material, with its deepest locator. */
export interface SourceName {
  name: string;
  kind: LossKind;
  /** The episode this name can be paged back from. */
  seq: Seq;
  /** `[start, end)` inside that episode's content, when known. */
  span?: [number, number];
}

export interface LedgerResult {
  /** Names present in the source but absent from the capsule text. */
  dropped: LossEntry[];
  /**
   * Names the capsule text still contains, with their deepest locators. This is
   * what a parent compaction consults so that a loss recorded two levels up
   * still points at the original episode, not at an intermediate summary.
   */
  kept: LossEntry[];
}

/** Extract the routing keys of one episode as `SourceName`s. */
export function sourceNamesOfEpisode(seq: Seq, content: string, max?: number): SourceName[] {
  return names(content, max === undefined ? {} : { max, stopWhenExceeded: true }).map((hit) => ({
    name: hit.name,
    kind: hit.kind,
    seq,
    span: [hit.start, hit.end] as [number, number],
  }));
}

/**
 * Split the source vocabulary against the capsule text.
 *
 * Duplicate names collapse to their **most recent** locator: when a value is
 * mentioned repeatedly, the newest mention is the one worth paging back.
 */
export function deriveLedger(source: Iterable<SourceName>, capsuleText: string): LedgerResult {
  const present = new Set<string>();
  for (const hit of names(capsuleText, { max: 4096 })) present.add(hit.name);

  const best = new Map<string, SourceName>();
  for (const entry of source) {
    const prior = best.get(entry.name);
    if (prior === undefined || entry.seq >= prior.seq) best.set(entry.name, entry);
  }

  const dropped: LossEntry[] = [];
  const kept: LossEntry[] = [];
  for (const entry of best.values()) {
    const row: LossEntry = { name: entry.name, kind: entry.kind, seq: entry.seq };
    if (entry.span) row.span = entry.span;
    if (present.has(entry.name)) kept.push(row);
    else dropped.push(row);
  }
  dropped.sort(compareEntries);
  kept.sort(compareEntries);
  return { dropped, kept };
}

function compareEntries(a: LossEntry, b: LossEntry): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Conservation check (KERNEL §3): a parent's ledger must contain every entry of
 * every child's ledger. Re-summarizing may add losses, never remove one.
 */
export function conservationViolations(
  parentLedger: Iterable<string>,
  childLedgers: Iterable<Iterable<string>>,
): string[] {
  const parent = new Set(parentLedger);
  const missing: string[] = [];
  for (const child of childLedgers) {
    for (const name of child) if (!parent.has(name)) missing.push(name);
  }
  return [...new Set(missing)].sort();
}

/**
 * The strong form of the invariant, and the one the tests actually assert:
 * every name in the original source material is either still visible in the
 * surviving text, or named in the ledger. Nothing vanishes silently.
 */
export function unaccountedNames(
  source: Iterable<SourceName>,
  survivingText: string,
  ledger: Iterable<string>,
): string[] {
  const present = new Set<string>();
  for (const hit of names(survivingText, { max: 4096 })) present.add(hit.name);
  const known = new Set(ledger);
  const missing = new Set<string>();
  for (const entry of source) {
    if (!present.has(entry.name) && !known.has(entry.name)) missing.add(entry.name);
  }
  return [...missing].sort();
}

/**
 * Render the resident ledger digest that follows a capsule in the packet
 * (KERNEL §4): `⟨lost: 14 · names: Boston, 2026-06-03, "dry-run" …⟩`.
 * Bounded by construction — the packet never grows with archive size.
 */
export function renderLedgerDigest(count: number, residentNames: readonly string[], max = 8): string {
  if (count === 0) return "⟨lost: 0⟩";
  const shown = residentNames.slice(0, max);
  const ellipsis = residentNames.length > shown.length ? " …" : "";
  if (shown.length === 0) return `⟨lost: ${count}⟩`;
  return `⟨lost: ${count} · names: ${shown.join(", ")}${ellipsis}⟩`;
}
