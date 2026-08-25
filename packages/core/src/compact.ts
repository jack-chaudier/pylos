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

import { createHash } from "node:crypto";
import {
  type Atom,
  CAPSULE_FANOUT,
  CAPSULE_LEDGER_PREVIEW_ITEMS,
  CAPSULE_SOURCE_EPISODE_BYTES,
  CAPSULE_SOURCE_NAMES_PER_EPISODE,
  CAPSULE_SOURCE_NAMES_PER_RANGE,
  type Capsule,
  type CapsuleLedgerReceipt,
  DEFAULT_BUDGET,
  LEAF_CAPSULE_EPISODES,
  type LossEntry,
  MAX_THREAD_BUDGET,
  type Seq,
} from "@pylos/protocol";
import { canonicalHash } from "./hash.ts";
import { canonicalJson } from "./pure/canonical.ts";
import { type CapsuleAtomLine, type CapsuleUnit, writeCapsule } from "./pure/capsule.ts";
import { type SourceName, sourceNamesOfEpisode } from "./pure/ledger.ts";
import { names, normalizeName } from "./pure/names.ts";
import { approxTokens } from "./pure/tokens.ts";
import { type StoredCapsule, type Vault, VaultError } from "./vault.ts";

/** The rolling root's level. Above every hierarchy level, and unique per thread. */
export const ROOT_LEVEL = 99;
/** Atom certificate lines presented to one capsule writer; the rest page via the ledger. */
const CAPSULE_ATOM_LINE_LIMIT = 512;
/** `names(capsuleText, { max: … })` makes this a hard kernel bound. */
const CAPSULE_KEPT_ITEMS = 4096;
const LEDGER_WRITE_PAGE = 128;
const CAPSULE_DROPPED_PREVIEW_BYTES = 64 * 1024;
export const MAX_CAPSULE_WORK_PER_COMPACT = 32;

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
  if (!vault.atomDerivedReady(threadId)) vault.continueMigrations();
  vault.assertAtomDerivedReady(threadId);
  vault.fragments.assertMutable(threadId);
  return vault.tx(() => {
    const thread = vault.threads.get(threadId);
    if (thread === null) return [];
    const budget = options.budget ?? (thread.settings.budget as number | undefined) ?? DEFAULT_BUDGET;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_THREAD_BUDGET) {
      throw new VaultError(`capsule budget must be an integer from 1 through ${MAX_THREAD_BUDGET}`);
    }
    const tokens = capsuleTokensFor(budget);
    const head = thread.headSeq;
    const sealed: StoredCapsule[] = [];
    let work = 0;

    // --- level 0: leaves over episodes
    const lastLeaf = maxSealed(vault, threadId, 0);
    for (let to = lastLeaf + LEAF_CAPSULE_EPISODES; to <= head; to += LEAF_CAPSULE_EPISODES) {
      if (work >= MAX_CAPSULE_WORK_PER_COMPACT) return sealed;
      sealed.push(sealLeaf(vault, threadId, to - LEAF_CAPSULE_EPISODES + 1, to, tokens.leaf, options));
      work += 1;
    }

    // --- levels 1..: each is a 5× contraction of its 8 children
    const maxLevel = options.maxLevel ?? 8;
    for (let level = 1; level <= maxLevel; level += 1) {
      const span = levelSpan(level);
      if (span > head) break;
      const last = maxSealed(vault, threadId, level);
      for (let to = last + span; to <= head; to += span) {
        if (work >= MAX_CAPSULE_WORK_PER_COMPACT) return sealed;
        const capsule = sealUpper(vault, threadId, level, to - span + 1, to, tokens.mid, options);
        if (capsule !== null) {
          sealed.push(capsule);
          work += 1;
        }
      }
    }

    // --- the rolling root absorbs leaves as they leave the resident window
    const rolled = rollRoot(
      vault,
      threadId,
      budget,
      tokens.root,
      options,
      MAX_CAPSULE_WORK_PER_COMPACT - work,
    );
    if (rolled.capsule !== null) sealed.push(rolled.capsule);

    return sealed;
  });
}

/** True when another bounded compact pass is required before a turn may call a provider. */
export function compactionPending(
  vault: Vault,
  threadId: string,
  maxLevel = 8,
  budgetOverride?: number,
): boolean {
  const thread = vault.threads.get(threadId);
  if (thread === null) return false;
  const head = thread.headSeq;
  if (maxSealed(vault, threadId, 0) + LEAF_CAPSULE_EPISODES <= head) return true;
  for (let level = 1; level <= maxLevel; level += 1) {
    const span = levelSpan(level);
    if (span > head) break;
    if (maxSealed(vault, threadId, level) + span <= head) return true;
  }
  const budget = budgetOverride ?? (thread.settings.budget as number | undefined) ?? DEFAULT_BUDGET;
  const target = maxSealed(vault, threadId, 0) - residentLeafCount(budget) * LEAF_CAPSULE_EPISODES;
  const root = vault.db
    .query("SELECT to_seq FROM capsule WHERE thread_id = ? AND level = ? AND from_seq = 1 LIMIT 1")
    .get(threadId, ROOT_LEVEL) as { to_seq: number } | null;
  return target > (root?.to_seq ?? 0);
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
  const units: CapsuleUnit[] = episodes.map((e) => ({ seq: e.seq, text: e.content }));
  const atomLines: CapsuleAtomLine[] = [];
  let atomRows = 0;
  forEachAtomInRange(vault, threadId, from, to, (atom) => {
    if (atom.phase === "REVOKED") return;
    if (atom.phase !== "PROPOSED" && atomRows < CAPSULE_ATOM_LINE_LIMIT) {
      atomLines.push({ key: atom.key, value: atom.value, seq: atom.sourceSeq });
    }
    atomRows += 1;
  });

  const text = renderText(options, { level: 0, units, atoms: atomLines, maxTokens });
  // The source vocabulary is streamed one episode/atom page at a time.  The
  // ledger's dedupe map is the receipt itself (one entry per distinct name),
  // so we never retain a second archive-sized source array just to derive it.
  const capsuleId = `cap:${threadId}:0:${from}`;
  const ledger = derivePersistedLedger(
    vault,
    threadId,
    capsuleId,
    0,
    from,
    to,
    sourceNamesForRangeStream(vault, threadId, from, to),
    text.text,
  );
  const capsule = store(
    vault,
    threadId,
    0,
    from,
    to,
    text.text,
    text.tokens,
    ledger.dropped,
    ledger.kept,
    ledger.receipt,
    options,
  );
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
  const capsuleId = `cap:${threadId}:${level}:${from}`;
  const ledger = derivePersistedLedger(vault, threadId, capsuleId, level, from, to, source, text.text);
  const carried = children.reduce((sum, c) => sum + droppedCount(c) + c.carriedCount, 0);
  const capsule = store(
    vault,
    threadId,
    level,
    from,
    to,
    text.text,
    text.tokens,
    ledger.dropped,
    ledger.kept,
    ledger.receipt,
    options,
    carried,
  );
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
  maxWork: number,
): { capsule: StoredCapsule | null; work: number } {
  const lastLeafEnd = maxSealed(vault, threadId, 0);
  const target = lastLeafEnd - residentLeafCount(budget) * LEAF_CAPSULE_EPISODES;
  if (target <= 0 || maxWork <= 0) return { capsule: null, work: 0 };

  let root = vault.capsules.at(threadId, ROOT_LEVEL, 1);
  let changed = false;
  let work = 0;
  for (;;) {
    if (work >= maxWork) break;
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
    const source = function* (): Iterable<SourceName> {
      // Keep the root receipt cumulative. Prior root omissions stay in the
      // exact sidecar instead of disappearing into an unreplayable predecessor,
      // so an imported root can be rebuilt from its retained leaf lineage.
      if (root !== null) {
        const prior = vault.db
          .query(
            "SELECT name, kind, seq, span FROM capsule_ledger_entry " +
              "WHERE capsule_id = ? ORDER BY seq ASC, name ASC",
          )
          .iterate(root.id) as Iterable<LedgerStageRow>;
        for (const row of prior) yield stageEntry(row);
      }
      for (const entry of leaving.kept) {
        yield {
          name: entry.name,
          kind: entry.kind,
          seq: entry.seq,
          ...(entry.span ? { span: entry.span } : {}),
        };
      }
    };
    const text = renderText(options, { level: ROOT_LEVEL, units, atoms: [], maxTokens });
    const from = 1;
    const to = leaving.toSeq;
    const capsuleId = root?.id ?? `root:${threadId}`;
    const ledger = derivePersistedLedger(
      vault,
      threadId,
      capsuleId,
      ROOT_LEVEL,
      from,
      to,
      source(),
      text.text,
    );

    const next: StoredCapsule = {
      id: capsuleId,
      threadId,
      level: ROOT_LEVEL,
      fromSeq: from,
      toSeq: to,
      text: text.text,
      tokens: text.tokens,
      dropped: ledger.dropped,
      carriedCount: (root?.carriedCount ?? 0) + droppedCount(leaving) + leaving.carriedCount,
      kept: ledger.kept,
      ledgerReceipt: ledger.receipt,
      hash: canonicalHash({ level: ROOT_LEVEL, from, to, text: text.text }),
      createdBy: options.writer ? "model" : "extractive",
      createdAt: Date.now(),
    };
    if (root === null) vault.capsules.insert(next);
    else vault.capsules.replace(next);
    root = next;
    changed = true;
    work += 1;
  }
  return { capsule: changed ? root : null, work };
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
  let rendered: { text: string; tokens: number };
  if (options.writer) {
    // Row 30: models override word budgets, so enforcement is mechanical — the
    // kernel hard-truncates whatever the writer returns and computes dropped()
    // on the post-truncation text.
    const raw = options.writer(input);
    const cut = writeCapsule([{ seq: 0, text: raw }], [], { maxTokens: input.maxTokens });
    rendered = { text: cut.text, tokens: cut.tokens };
  } else {
    const written = writeCapsule(input.units, input.atoms, { maxTokens: input.maxTokens });
    rendered = { text: written.text, tokens: written.tokens };
  }
  if (
    names(rendered.text, { max: CAPSULE_KEPT_ITEMS, stopWhenExceeded: true }).length <= CAPSULE_KEPT_ITEMS
  ) {
    return rendered;
  }
  const lines = rendered.text.split("\n");
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = lines.slice(0, middle).join("\n");
    if (names(candidate, { max: CAPSULE_KEPT_ITEMS, stopWhenExceeded: true }).length <= CAPSULE_KEPT_ITEMS)
      low = middle;
    else high = middle - 1;
  }
  const text = lines.slice(0, low).join("\n");
  return { text, tokens: approxTokens(text) };
}

export interface PersistedLedgerResult {
  dropped: LossEntry[];
  kept: LossEntry[];
  receipt: CapsuleLedgerReceipt;
}

/** Recompute one existing capsule after a forget without hydrating its vocabulary. */
export function rederiveCapsuleLedger(
  vault: Vault,
  capsule: StoredCapsule,
  source: Iterable<SourceName>,
  text: string,
): PersistedLedgerResult {
  return derivePersistedLedger(
    vault,
    capsule.threadId,
    capsule.id,
    capsule.level,
    capsule.fromSeq,
    capsule.toSeq,
    source,
    text,
  );
}

interface LedgerStageRow {
  name: string;
  kind: LossEntry["kind"];
  seq: number;
  span: string | null;
}

function stageEntry(row: LedgerStageRow): LossEntry {
  return {
    name: row.name,
    kind: row.kind,
    seq: row.seq,
    ...(row.span === null ? {} : { span: JSON.parse(row.span) as [number, number] }),
  };
}

function receiptDigest(rows: Iterable<LedgerStageRow>): string {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${canonicalJson(stageEntry(row))}\n`, "utf8");
  return hash.digest("hex");
}

/**
 * Exact external-memory ledger derivation. SQLite owns the distinct-name set;
 * JavaScript sees one source row while staging, one loss write page, and a
 * fixed preview. The stage is disposable, while every omitted locator is
 * copied to `loss` before it is deleted.
 */
function derivePersistedLedger(
  vault: Vault,
  threadId: string,
  capsuleId: string,
  level: number,
  from: Seq,
  to: Seq,
  source: Iterable<SourceName>,
  capsuleText: string,
): PersistedLedgerResult {
  const capsuleHash = canonicalHash({ level, from, to, text: capsuleText });
  const presentHits = names(capsuleText, { max: CAPSULE_KEPT_ITEMS + 1 });
  if (presentHits.length > CAPSULE_KEPT_ITEMS) {
    throw new VaultError(`capsule visible-name set exceeds bounded capacity (${CAPSULE_KEPT_ITEMS})`);
  }
  const present = new Set(presentHits.map((hit) => hit.name));
  const clear = vault.db.query("DELETE FROM capsule_ledger_stage WHERE capsule_id = ?");
  clear.run(capsuleId);
  const insert = vault.db.query(
    "INSERT INTO capsule_ledger_stage (capsule_id, name, kind, seq, span, kept) " +
      "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(capsule_id, name) DO UPDATE SET " +
      "kind = excluded.kind, seq = excluded.seq, span = excluded.span, kept = excluded.kept " +
      "WHERE excluded.seq >= capsule_ledger_stage.seq",
  );
  try {
    for (const entry of source) {
      insert.run(
        capsuleId,
        entry.name,
        entry.kind,
        entry.seq,
        entry.span === undefined ? null : canonicalJson(entry.span),
        present.has(entry.name) ? 1 : 0,
      );
    }

    const counts = vault.db
      .query(
        "SELECT COUNT(*) AS total, COALESCE(SUM(kept), 0) AS kept " +
          "FROM capsule_ledger_stage WHERE capsule_id = ?",
      )
      .get(capsuleId) as { total: number; kept: number };
    const keptCount = counts.kept;
    const droppedCount = counts.total - keptCount;
    if (keptCount > CAPSULE_KEPT_ITEMS) {
      throw new VaultError(`capsule kept ledger exceeds bounded capacity (${CAPSULE_KEPT_ITEMS})`);
    }

    const ordered = (kept: 0 | 1): Iterable<LedgerStageRow> =>
      vault.db
        .query(
          "SELECT name, kind, seq, span FROM capsule_ledger_stage " +
            "WHERE capsule_id = ? AND kept = ? ORDER BY seq ASC, name ASC",
        )
        .iterate(capsuleId, kept) as Iterable<LedgerStageRow>;
    const droppedDigest = receiptDigest(ordered(0));
    const keptDigest = receiptDigest(ordered(1));

    vault.db.query("DELETE FROM capsule_ledger_entry WHERE capsule_id = ?").run(capsuleId);
    vault.db
      .query(
        "INSERT INTO capsule_ledger_entry " +
          "(thread_id, capsule_id, part, ordinal, name, kind, seq, span) " +
          "SELECT ?, capsule_id, CASE kept WHEN 1 THEN 'kept' ELSE 'dropped' END, " +
          "ROW_NUMBER() OVER (PARTITION BY kept ORDER BY seq ASC, name ASC) - 1, name, kind, seq, span " +
          "FROM capsule_ledger_stage WHERE capsule_id = ?",
      )
      .run(threadId, capsuleId);

    // Copy every newly omitted locator in bounded pages. The NOT EXISTS keeps
    // the original deepest-drop invariant without one SQL probe per name.
    let afterSeq = 0;
    let afterName = "";
    for (;;) {
      const rows = vault.db
        .query(
          "SELECT s.name, s.kind, s.seq, s.span FROM capsule_ledger_stage s " +
            "WHERE s.capsule_id = ? AND s.kept = 0 " +
            "AND (s.seq > ? OR (s.seq = ? AND s.name > ?)) " +
            "AND NOT EXISTS (SELECT 1 FROM loss l WHERE l.thread_id = ? AND l.name = s.name AND l.seq = s.seq) " +
            "ORDER BY s.seq ASC, s.name ASC LIMIT ?",
        )
        .all(capsuleId, afterSeq, afterSeq, afterName, threadId, LEDGER_WRITE_PAGE) as LedgerStageRow[];
      if (rows.length === 0) break;
      const entries = rows.map(stageEntry);
      vault.losses.add(threadId, capsuleId, level, entries);
      const last = rows.at(-1) as LedgerStageRow;
      afterSeq = last.seq;
      afterName = last.name;
    }

    const dropped: LossEntry[] = [];
    let droppedBytes = 2;
    for (const row of vault.db
      .query(
        "SELECT name, kind, seq, span FROM capsule_ledger_entry " +
          "WHERE capsule_id = ? AND part = 'dropped' ORDER BY ordinal ASC LIMIT ?",
      )
      .iterate(capsuleId, CAPSULE_LEDGER_PREVIEW_ITEMS) as Iterable<LedgerStageRow>) {
      const entry = stageEntry(row);
      const entryBytes = Buffer.byteLength(canonicalJson(entry), "utf8") + (dropped.length === 0 ? 0 : 1);
      if (droppedBytes + entryBytes > CAPSULE_DROPPED_PREVIEW_BYTES) break;
      dropped.push(entry);
      droppedBytes += entryBytes;
    }
    const kept: LossEntry[] = [];
    for (const row of ordered(1)) kept.push(stageEntry(row));
    if (Buffer.byteLength(canonicalJson(kept), "utf8") > 2 * 1024 * 1024) {
      throw new VaultError("capsule kept ledger exceeds 2097152 JSON bytes");
    }
    const continuation = (part: "dropped" | "kept", after: number): string =>
      Buffer.from(JSON.stringify({ version: 1, capsuleId, capsuleHash, part, after }), "utf8").toString(
        "base64url",
      );
    return {
      dropped,
      kept,
      receipt: {
        version: 1,
        dropped: {
          count: droppedCount,
          embeddedCount: dropped.length,
          digest: droppedDigest,
          complete: droppedCount <= dropped.length,
          ...(droppedCount > dropped.length ? { cursor: continuation("dropped", dropped.length - 1) } : {}),
        },
        kept: {
          count: keptCount,
          embeddedCount: kept.length,
          digest: keptDigest,
          complete: true,
        },
      },
    };
  } finally {
    clear.run(capsuleId);
  }
}

function droppedCount(capsule: StoredCapsule): number {
  return capsule.ledgerReceipt?.dropped.count ?? capsule.dropped.length;
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
  ledgerReceipt: CapsuleLedgerReceipt,
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
    ledgerReceipt,
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
  for (const entry of sourceNamesForRangeStream(vault, threadId, from, to)) source.push(entry);
  return source;
}

/**
 * Stream the exact source vocabulary for a range.  The public array helper
 * above remains useful to audits, but compaction and forget use this iterator
 * so a dense leaf never creates a second all-atoms `source` allocation.  The
 * only collection made by `deriveLedger` is its one-entry-per-name receipt.
 */
export function* sourceNamesForRangeStream(
  vault: Vault,
  threadId: string,
  from: Seq,
  to: Seq,
): Iterable<SourceName> {
  let afterSeq = from - 1;
  let episodeNames = 0;
  for (;;) {
    const episode = vault.db
      .query(
        "SELECT seq, CASE WHEN length(CAST(content AS BLOB)) <= ? THEN content ELSE NULL END AS content, " +
          "length(CAST(content AS BLOB)) AS content_bytes, json_valid(meta) AS meta_valid, " +
          "CASE WHEN json_valid(meta) THEN json_extract(meta, '$.removed') ELSE NULL END AS removed " +
          "FROM episode WHERE thread_id = ? AND seq BETWEEN ? AND ? AND seq > ? " +
          "ORDER BY seq ASC LIMIT 1",
      )
      .get(CAPSULE_SOURCE_EPISODE_BYTES, threadId, from, to, afterSeq) as {
      seq: number;
      content: string | null;
      content_bytes: number;
      meta_valid: number;
      removed: unknown;
    } | null;
    if (episode === null) break;
    afterSeq = episode.seq;
    if (episode.meta_valid !== 1) throw new VaultError(`episode ${episode.seq} has malformed metadata`);
    if (episode.removed === 1) continue;
    if (episode.content === null || episode.content_bytes > CAPSULE_SOURCE_EPISODE_BYTES) {
      throw new VaultError(
        `episode ${episode.seq} exceeds capsule source byte capacity (${CAPSULE_SOURCE_EPISODE_BYTES})`,
      );
    }
    const entries = sourceNamesOfEpisode(episode.seq, episode.content, CAPSULE_SOURCE_NAMES_PER_EPISODE);
    if (entries.length > CAPSULE_SOURCE_NAMES_PER_EPISODE) {
      throw new VaultError(
        `episode ${episode.seq} exceeds capsule source-name capacity (${CAPSULE_SOURCE_NAMES_PER_EPISODE})`,
      );
    }
    episodeNames += entries.length;
    if (episodeNames > CAPSULE_SOURCE_NAMES_PER_RANGE) {
      throw new VaultError(`capsule source range exceeds name capacity (${CAPSULE_SOURCE_NAMES_PER_RANGE})`);
    }
    for (const entry of entries) yield entry;
  }
  // Keep the atom scan as a direct keyset loop so at most one bounded page is
  // live at a time.
  let afterRowid = 0;
  for (;;) {
    const page = vault.atoms.inRangeForMigration(threadId, from, to, afterRowid);
    for (const atom of page.atoms) {
      if (atom.phase === "REVOKED") continue;
      const span = atom.sourceSpan;
      yield {
        name: normalizeName(atom.key, "atom"),
        kind: "atom",
        seq: atom.sourceSeq,
        ...(span ? { span } : {}),
      };
      const value = normalizeName(atom.value, "atom");
      if (value.length > 1) {
        yield { name: value, kind: "atom", seq: atom.sourceSeq, ...(span ? { span } : {}) };
      }
    }
    if (page.nextRowid === undefined || !page.hasMore) return;
    afterRowid = page.nextRowid;
  }
}

/**
 * Compaction is an archive write, not an online projection. A dense legal leaf
 * may contain more than the reader cap, so walk the exact rows by rowid pages
 * instead of routing through `atoms.inRange`, whose fail-closed bound protects
 * request latency. Each page is bounded; the capsule writer still decides what
 * can be retained and the ledger accounts for every source name.
 */
function forEachAtomInRange(
  vault: Vault,
  threadId: string,
  from: Seq,
  to: Seq,
  visit: (atom: Atom) => void,
): void {
  let afterRowid = 0;
  for (;;) {
    const page = vault.atoms.inRangeForMigration(threadId, from, to, afterRowid);
    for (const atom of page.atoms) visit(atom);
    if (page.nextRowid === undefined || !page.hasMore) return;
    afterRowid = page.nextRowid;
  }
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
