/**
 * The aperture — the whole compiler, in memory, in the browser.
 *
 * `@pylos/core` runs the kernel against SQLite. This runs the *same* pure
 * pieces — `applyRules`, `writeCapsule`, `deriveLedger`, `allocate`, the
 * renderers — over a plain array of episodes, so a landing page can show a real
 * packet being compiled from a real archive rather than a mock of one.
 *
 * It is not a second implementation of the kernel: every step below calls the
 * same function the vault-backed compiler calls. What it leaves out is
 * persistence, the hash chain, FTS, and paging triggers that need an index.
 */

import type { Atom, ChatMessage, LossEntry, Role, Seq } from "@pylos/protocol";
import { allocate } from "./budget.ts";
import { type CapsuleAtomLine, type CapsuleUnit, writeCapsule } from "./capsule.ts";
import { deriveLedger, type SourceName, sourceNamesOfEpisode } from "./ledger.ts";
import { KIND_PRIORITY, names, normalizeName } from "./names.ts";
import {
  type CapsuleView,
  type PagedBlock,
  renderCapsules,
  renderFrontier,
  renderHeader,
  renderPaged,
  renderRecent,
} from "./render.ts";
import { applyRules } from "./rules.ts";
import { approxTokens, type Tokenizer } from "./tokens.ts";

export interface ApertureEpisode {
  seq: Seq;
  role: Role;
  content: string;
}

export interface ApertureOptions {
  budget: number;
  /** The current question; drives ledger routing. */
  query?: string;
  /** Episodes per leaf capsule. Default 32, as in the kernel. */
  leafSize?: number;
  /** Leaf capsules kept resident beside the rolling root. Default 4. */
  residentLeaves?: number;
  model?: string;
  tokenizer?: Tokenizer;
}

export interface AperturePage {
  name: string;
  seq: Seq;
  text: string;
}

export interface ApertureResult {
  messages: ChatMessage[];
  tokens: number;
  budget: number;
  /** Certificate lines currently resident. */
  frontier: string[];
  capsules: CapsuleView[];
  /** Exactly what was recovered for this query, and why. */
  pages: AperturePage[];
  /** Names the view no longer contains, with their locators. */
  lost: LossEntry[];
  /** Seqs shown verbatim. */
  recent: Seq[];
  atoms: Atom[];
}

/** Compile a bounded packet from an in-memory archive. Deterministic and pure. */
export function aperture(episodes: readonly ApertureEpisode[], options: ApertureOptions): ApertureResult {
  const tokenizer = options.tokenizer ?? approxTokens;
  const leafSize = options.leafSize ?? 32;
  const residentLeaves = options.residentLeaves ?? 4;
  const allocation = allocate(options.budget);

  // ---- memory: rules, then supersession by key
  const atoms: Atom[] = [];
  const current = new Map<string, Atom>();
  for (const episode of episodes) {
    for (const draft of applyRules(episode.content, episode.role)) {
      const prior = current.get(draft.key);
      if (prior !== undefined && prior.value.toLowerCase() === draft.value.toLowerCase()) continue;
      const atom: Atom = {
        id: `${draft.key}@${episode.seq}`,
        threadId: "aperture",
        kind: draft.kind,
        key: draft.key,
        value: draft.value.replace(/\s+/g, " ").trim(),
        text: draft.text,
        sourceSeq: episode.seq,
        sourceSpan: draft.span,
        validFromSeq: episode.seq,
        phase: "SUPPORTED",
        authority: episode.role === "assistant" ? "assistant" : "user",
        scope: "global",
        pinned: false,
        confidence: draft.confidence,
        createdBy: `rule:${draft.rule}`,
        createdAt: 0,
      };
      if (prior !== undefined) {
        prior.phase = "HISTORICAL";
        prior.validToSeq = episode.seq;
        prior.supersededBy = atom.id;
      }
      current.set(draft.key, atom);
      atoms.push(atom);
    }
  }

  // ---- compaction: leaves, then a rolling root over everything older
  const head = episodes.at(-1)?.seq ?? 0;
  const byIndex = new Map(episodes.map((e, i) => [e.seq, i]));
  const leaves: Array<{ fromSeq: Seq; toSeq: Seq; text: string; dropped: LossEntry[]; kept: LossEntry[] }> =
    [];
  for (let start = 0; start + leafSize <= episodes.length; start += leafSize) {
    const slice = episodes.slice(start, start + leafSize);
    const from = (slice[0] as ApertureEpisode).seq;
    const to = (slice.at(-1) as ApertureEpisode).seq;
    const units: CapsuleUnit[] = slice.map((e) => ({ seq: e.seq, text: e.content }));
    const lines: CapsuleAtomLine[] = atoms
      .filter((a) => a.validFromSeq >= from && a.validFromSeq <= to)
      .map((a) => ({ key: a.key, value: a.value, seq: a.sourceSeq }));
    const source = sourceNamesFor(slice, atoms, from, to);
    const written = writeCapsule(units, lines, { maxTokens: Math.max(150, Math.floor(options.budget / 40)) });
    const { dropped, kept } = deriveLedger(source, written.text);
    leaves.push({ fromSeq: from, toSeq: to, text: written.text, dropped, kept });
  }

  const rootTokens = Math.max(300, Math.floor(options.budget / 16));
  const absorbed = Math.max(0, leaves.length - residentLeaves);
  let root: { fromSeq: Seq; toSeq: Seq; text: string; dropped: LossEntry[]; kept: LossEntry[] } | null = null;
  const lost: LossEntry[] = [];
  for (let i = 0; i < absorbed; i += 1) {
    const leaving = leaves[i] as (typeof leaves)[number];
    for (const entry of leaving.dropped) lost.push(entry);
    const units: CapsuleUnit[] = [];
    if (root !== null) units.push({ seq: root.fromSeq, text: root.text });
    units.push({ seq: leaving.fromSeq, text: leaving.text });
    const source: SourceName[] = [...(root?.kept ?? []), ...leaving.kept].map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      seq: entry.seq,
      ...(entry.span ? { span: entry.span } : {}),
    }));
    const written = writeCapsule(units, [], { maxTokens: rootTokens });
    const { dropped, kept } = deriveLedger(source, written.text);
    for (const entry of dropped) lost.push(entry);
    root = {
      fromSeq: (episodes[0] as ApertureEpisode).seq,
      toSeq: leaving.toSeq,
      text: written.text,
      dropped,
      kept,
    };
  }
  const residentLeafList = leaves.slice(absorbed);
  for (const leaf of residentLeafList) for (const entry of leaf.dropped) lost.push(entry);

  const lostByName = new Map<string, LossEntry>();
  for (const entry of lost) {
    const prior = lostByName.get(entry.name);
    if (prior === undefined || entry.seq >= prior.seq) lostByName.set(entry.name, entry);
  }

  const capsuleViews: CapsuleView[] = [
    ...(root === null
      ? []
      : [
          {
            id: "root",
            level: 99,
            fromSeq: root.fromSeq,
            toSeq: root.toSeq,
            text: root.text,
            lossCount: lost.filter((l) => l.seq <= (root as { toSeq: Seq }).toSeq).length,
            lossNames: root.dropped.slice(-8).map((d) => d.name),
          },
        ]),
    ...residentLeafList.map((leaf, i) => ({
      id: `leaf:${leaf.fromSeq}`,
      level: 0,
      fromSeq: leaf.fromSeq,
      toSeq: leaf.toSeq,
      text: leaf.text,
      lossCount: leaf.dropped.length,
      lossNames: leaf.dropped.slice(-8).map((d) => d.name),
      _order: i,
    })),
  ];

  // ---- recent window
  const coveredTo = capsuleViews.at(-1)?.toSeq ?? 0;
  const recent: ApertureEpisode[] = [];
  let recentUsed = 0;
  for (let i = episodes.length - 1; i >= 0; i -= 1) {
    const episode = episodes[i] as ApertureEpisode;
    if (episode.seq <= coveredTo) break;
    const cost = tokenizer(episode.content) + 4;
    if (recentUsed + cost > allocation.recent) break;
    recent.unshift(episode);
    recentUsed += cost;
  }

  // ---- frontier
  const supported = atoms.filter((a) => a.phase === "SUPPORTED");
  supported.sort((a, b) => {
    const ka = ORDER[a.kind] ?? 9;
    const kb = ORDER[b.kind] ?? 9;
    return ka - kb || b.validFromSeq - a.validFromSeq;
  });
  const frontier = renderFrontier(supported, allocation.frontier, tokenizer);

  // ---- paging: exactly the kernel's rule, over the in-memory ledger
  const residentText = [
    frontier.text,
    ...capsuleViews.map((c) => c.text),
    ...recent.map((e) => e.content),
  ].join("\n");
  const residentNames = new Set<string>();
  for (const hit of names(residentText, { max: 4096 })) residentNames.add(hit.name);
  const pages: AperturePage[] = [];
  const blocks: PagedBlock[] = [];
  const maxPages = Math.max(1, Math.floor(allocation.paged / 450));
  const queryHits = [...names(options.query ?? "")].sort(
    (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || b.name.length - a.name.length,
  );
  for (const hit of queryHits) {
    if (pages.length >= maxPages) break;
    if (residentNames.has(hit.name)) continue;
    const locator = lostByName.get(hit.name);
    if (locator === undefined) continue;
    const index = byIndex.get(locator.seq);
    if (index === undefined) continue;
    const episode = episodes[index] as ApertureEpisode;
    pages.push({ name: hit.name, seq: episode.seq, text: episode.content });
    blocks.push({
      seq: episode.seq,
      role: episode.role,
      trigger: `ledger:${hit.name}`,
      text: episode.content,
    });
  }
  const paged = renderPaged(blocks, allocation.paged, tokenizer);

  const capsules = renderCapsules(capsuleViews, allocation.capsules, tokenizer);
  const header = renderHeader(
    {
      title: "aperture",
      turns: head,
      date: new Date().toISOString().slice(0, 10),
      archiveBytes: episodes.reduce((sum, e) => sum + e.content.length, 0),
      ledgerCount: lostByName.size,
      budget: options.budget,
      model: options.model ?? "any",
    },
    { historical: atoms.filter((a) => a.phase === "HISTORICAL").length },
  );

  const packetNames = new Set<string>();
  for (const hit of names(
    [header, frontier.text, capsules.text, paged.text, ...recent.map((e) => e.content)].join("\n"),
    { max: 8192 },
  )) {
    packetNames.add(hit.name);
  }
  const digestNames = [...lostByName.keys()].filter((name) => !packetNames.has(name)).slice(0, 24);

  const parts = [header];
  if (frontier.text.length > 0) parts.push(frontier.text);
  if (capsules.text.length > 0) parts.push(capsules.text);
  if (digestNames.length > 0) {
    parts.push(`⟦omitted, recoverable⟧ ⟨lost: ${lostByName.size} · names: ${digestNames.join(", ")}⟩`);
  }
  if (paged.text.length > 0) parts.push(paged.text);
  const messages: ChatMessage[] = [
    { role: "system", content: parts.join("\n\n") },
    ...renderRecent(
      recent.map((e) => ({
        threadId: "aperture",
        seq: e.seq,
        ts: 0,
        role: e.role,
        content: e.content,
        tokens: tokenizer(e.content),
        prevHash: "",
        hash: "",
        meta: {},
      })),
    ),
  ];
  const tokens = tokenizer(messages.map((m) => `${m.role}\n${m.content}`).join("\n\n"));

  return {
    messages,
    tokens,
    budget: options.budget,
    frontier: frontier.text.split("\n").slice(1),
    capsules: capsuleViews,
    pages,
    lost: [...lostByName.values()],
    recent: recent.map((e) => e.seq),
    atoms,
  };
}

const ORDER: Record<string, number> = {
  preference: 0,
  decision: 1,
  identity: 2,
  task: 3,
  fact: 4,
  promise: 5,
  correction: 6,
  hypothesis: 7,
};

function sourceNamesFor(
  slice: readonly ApertureEpisode[],
  atoms: readonly Atom[],
  from: Seq,
  to: Seq,
): SourceName[] {
  const source: SourceName[] = [];
  for (const episode of slice) source.push(...sourceNamesOfEpisode(episode.seq, episode.content));
  for (const atom of atoms) {
    if (atom.validFromSeq < from || atom.validFromSeq > to) continue;
    const span = atom.sourceSpan ? { span: atom.sourceSpan } : {};
    source.push({ name: normalizeName(atom.key, "atom"), kind: "atom", seq: atom.sourceSeq, ...span });
    const value = normalizeName(atom.value, "atom");
    if (value.length > 1) source.push({ name: value, kind: "atom", seq: atom.sourceSeq, ...span });
  }
  return source;
}
