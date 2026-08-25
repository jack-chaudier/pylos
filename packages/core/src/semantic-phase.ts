/**
 * Atom-aware phase classification for address-only semantic spans.
 *
 * A semantic hit is an address, not an authority claim.  When a hit happens
 * to land on an atom span, this helper carries the atom's phase alongside the
 * address so a superseded user span cannot be reintroduced as current merely
 * because its episode role is `user`.  Mixed spans intentionally return no
 * phase; the claim gate can then use the candidate text to choose the exact
 * atom, preserving unchanged facts that share an episode with a correction.
 */

import type { Episode, Epistemic, Role } from "@pylos/protocol";
import type { Vault } from "./vault.ts";

export type SemanticSourcePhase = "current" | "historical" | "proposed";

/**
 * The bounded atom lookup has three intentionally different outcomes.  An
 * empty source keeps the historical role-based fallback (a user episode is
 * still current evidence); an overfull source does not.  Keeping overflow
 * explicit prevents callers from confusing a bounded refusal with "there were
 * no atoms" and accidentally restoring episode-wide authority.
 */
export type SemanticPhaseResolution =
  | { status: "resolved"; phase: SemanticSourcePhase }
  | { status: "unresolved"; reason: "invalid-range" | "no-atoms" | "mixed" | "malformed" }
  | { status: "overflow"; rows: 513 };

const MAX_PHASE_ROWS = 512;
const PHASE_ROW_LIMIT = (MAX_PHASE_ROWS + 1) as 513;

const UTF8 = new TextEncoder();

interface AtomPhaseRow {
  value: string;
  source_span: string | null;
  phase: string;
  authority: string;
}

function phaseOf(row: AtomPhaseRow): SemanticSourcePhase | undefined {
  if (row.phase === "REVOKED") return undefined;
  const authoritative =
    row.authority === "user" || row.authority === "tool" || row.authority === "attachment";
  if (row.phase === "HISTORICAL" && authoritative) return "historical";
  if (row.phase === "SUPPORTED" && authoritative) return "current";
  return "proposed";
}

function parsedSpan(raw: string | null): [number, number] | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      Number.isSafeInteger(value[0]) &&
      Number.isSafeInteger(value[1]) &&
      value[0] >= 0 &&
      value[1] > value[0]
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // A malformed derived span is not authority. The value fallback below may
    // still identify a narrower exact location, otherwise phase stays unknown.
  }
  return undefined;
}

function byteSpan(episode: Episode, row: AtomPhaseRow): [number, number] | undefined {
  const charSpan = parsedSpan(row.source_span);
  const fromChar = charSpan?.[0] ?? episode.content.indexOf(row.value);
  const toChar = charSpan?.[1] ?? (fromChar < 0 ? -1 : fromChar + row.value.length);
  if (fromChar < 0 || toChar <= fromChar || toChar > episode.content.length) {
    return undefined;
  }
  return [
    UTF8.encode(episode.content.slice(0, fromChar)).byteLength,
    UTF8.encode(episode.content.slice(0, toChar)).byteLength,
  ];
}

function overlaps(left: [number, number], right: [number, number]): boolean {
  return left[0] < right[1] && right[0] < left[1];
}

/** Return one phase only when every overlapping atom agrees on it. */
export function semanticPhaseForSpan(
  vault: Vault,
  threadId: string,
  episode: Episode,
  byteRange: [number, number],
): SemanticSourcePhase | undefined {
  const resolution = semanticPhaseForSpanResolution(vault, threadId, episode, byteRange);
  return resolution.status === "resolved" ? resolution.phase : undefined;
}

/**
 * Resolve atom phase without reading an unbounded source-local atom set.
 * `LIMIT 513` is deliberate: 512 rows can be classified; the extra row is a
 * kernel-computed overflow witness and causes a fail-closed result.
 */
export function semanticPhaseForSpanResolution(
  vault: Vault,
  threadId: string,
  episode: Episode,
  byteRange: [number, number],
): SemanticPhaseResolution {
  const bytes = UTF8.encode(episode.content);
  if (
    !Number.isSafeInteger(byteRange[0]) ||
    !Number.isSafeInteger(byteRange[1]) ||
    byteRange[0] < 0 ||
    byteRange[1] <= byteRange[0] ||
    byteRange[1] > bytes.byteLength
  ) {
    return { status: "unresolved", reason: "invalid-range" };
  }
  const rows = vault.db
    .query(
      "SELECT value, source_span, phase, authority FROM atom WHERE thread_id = ? AND source_seq = ? " +
        `ORDER BY rowid LIMIT ${PHASE_ROW_LIMIT}`,
    )
    .all(threadId, episode.seq) as AtomPhaseRow[];
  if (rows.length > MAX_PHASE_ROWS) return { status: "overflow", rows: PHASE_ROW_LIMIT };
  if (rows.length === 0) return { status: "unresolved", reason: "no-atoms" };
  const phases = new Set<SemanticSourcePhase>();
  let overlapping = 0;
  let malformed = false;
  for (const row of rows) {
    const phase = phaseOf(row);
    const span = byteSpan(episode, row);
    if (span === undefined) {
      malformed = true;
      continue;
    }
    if (phase !== undefined && overlaps(span, byteRange)) {
      overlapping += 1;
      phases.add(phase);
    }
  }
  if (phases.size === 1 && overlapping > 0) {
    return { status: "resolved", phase: [...phases][0] as SemanticSourcePhase };
  }
  if (malformed) return { status: "unresolved", reason: "malformed" };
  return { status: "unresolved", reason: phases.size > 1 ? "mixed" : "no-atoms" };
}

/** Map a semantic source phase to the packet epistemic label. */
export function semanticEpistemic(
  role: Role | string,
  phase: SemanticSourcePhase | SemanticPhaseResolution | undefined,
): Epistemic {
  if (typeof phase === "object") {
    if (phase.status === "resolved") phase = phase.phase;
    else if (phase.status === "overflow") return "NON_AUTHORITATIVE";
    else phase = undefined;
  }
  if (phase === "historical") return "HISTORICAL";
  if (phase === "proposed") return "PROPOSED";
  if (role === "assistant") return "PROPOSED";
  if (role === "user" || role === "tool" || role === "attachment") return "SUPPORTED";
  return "NON_AUTHORITATIVE";
}
