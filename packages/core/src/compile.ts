/**
 * The context compiler `C_B(H_t, q_t) → (K_t, L_t, P_t)` (KERNEL §4, A3, A4).
 *
 * Selects material, then renders it, then measures the rendered string and trims
 * until it fits. The contract is absolute: **the packet never exceeds `B` by the
 * kernel's own count**, and every name the view no longer contains is either in
 * the ledger digest or was paged back.
 *
 * Slots: header ≤ 4%, frontier ≤ 20%, capsules ≤ 18%, paged ≤ 18%, recent the
 * remainder. Unused slot budget flows to the recent window.
 */

import {
  type Atom,
  type AtomKind,
  type ChatMessage,
  DEFAULT_BUDGET,
  type Episode,
  type LedgerDigest,
  type Packet,
  type PageRecord,
  type ResidentItem,
  type Seq,
} from "@pylos/protocol";
import { residentCapsules } from "./compact.ts";
import { canonicalHash, newId } from "./hash.ts";
import { page, TOKENS_PER_PAGE } from "./page.ts";
import { allocate, type BudgetShares, DEFAULT_SHARES } from "./pure/budget.ts";
import { names } from "./pure/names.ts";
import {
  atomCertificate,
  type CapsuleView,
  type PagedBlock,
  renderCapsules,
  renderFrontier,
  renderHeader,
  renderPaged,
  renderRecent,
  renderUnknownPages,
} from "./pure/render.ts";
import { approxTokens, type Tokenizer } from "./pure/tokens.ts";
import { COUNTERS } from "./schema.ts";
import { COMPILER_VERSION, type Vault, VaultError } from "./vault.ts";

export interface CompileOptions {
  /** The current user turn; drives ledger routing. */
  query?: string;
  budget?: number;
  model?: string;
  tokenizer?: Tokenizer;
  shares?: BudgetShares;
  /** The user episode this packet answers. Defaults to the head. */
  turnSeq?: Seq;
  /** Models without tools get a different view contract and one more page. */
  supportsTools?: boolean;
  /** Record frontier evictions in the ledger. True during a real turn. */
  record?: boolean;
  /** Skip paging entirely (baseline comparisons, X-ray re-render). */
  noPages?: boolean;
}

/** Frontier eviction order after `pinned` (KERNEL A4). */
const KIND_ORDER: Record<AtomKind, number> = {
  preference: 0,
  decision: 1,
  identity: 2,
  task: 3,
  fact: 4,
  promise: 5,
  correction: 6,
  hypothesis: 7,
};

/** The exact string the kernel counts tokens over (KERNEL A4). */
export function packetText(messages: readonly ChatMessage[]): string {
  return messages.map((m) => `${m.role}\n${m.content}`).join("\n\n");
}

export function compile(vault: Vault, threadId: string, options: CompileOptions = {}): Packet {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
  const tokenizer = options.tokenizer ?? approxTokens;
  const budget = options.budget ?? (thread.settings.budget as number | undefined) ?? DEFAULT_BUDGET;
  const shares = options.shares ?? (thread.settings.shares as BudgetShares | undefined) ?? DEFAULT_SHARES;
  const allocation = allocate(budget, shares);
  const model = options.model ?? (thread.settings.model as string | undefined) ?? "unknown";
  const supportsTools = options.supportsTools !== false;
  const query = options.query ?? "";
  const turnSeq = options.turnSeq ?? thread.headSeq;

  // ---- frontier: SUPPORTED atoms only (KERNEL A4; HISTORICAL is never resident)
  // Two reads, so that a standing rule from turn 1 cannot be pushed out of the
  // candidate set by a million later facts: obligations and decisions first,
  // then the most recent everything-else.
  const obligations = vault.atoms.list(threadId, {
    phase: "SUPPORTED",
    limit: 600,
    kinds: ["preference", "decision", "identity", "task", "promise"],
  });
  const recentAtoms = vault.atoms.list(threadId, { phase: "SUPPORTED", limit: 1200 });
  const supported = [...obligations];
  const seenAtoms = new Set(obligations.map((a) => a.id));
  for (const atom of recentAtoms) {
    if (!seenAtoms.has(atom.id)) supported.push(atom);
  }
  const ordered = [...supported].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ka = KIND_ORDER[a.kind] ?? 9;
    const kb = KIND_ORDER[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    return b.validFromSeq - a.validFromSeq;
  });
  const frontier = renderFrontier(ordered, allocation.frontier, tokenizer);
  const includedAtoms = new Set(frontier.included);
  const evicted = ordered.filter((a) => !includedAtoms.has(a.id));
  if (options.record === true) {
    for (const atom of evicted.slice(0, 32)) {
      vault.losses.noteFrontierEviction(threadId, atom.key.toLowerCase(), atom.sourceSeq);
    }
  }

  // ---- capsules: the fixed resident set (rolling root + recent leaves)
  const stored = residentCapsules(vault, threadId);
  const stale = new Map<string, number | null>();
  const capsuleViews: CapsuleView[] = stored.map((capsule) => ({
    id: capsule.id,
    level: capsule.level,
    fromSeq: capsule.fromSeq,
    toSeq: capsule.toSeq,
    text: markSuperseded(vault, threadId, capsule.text, stale),
    // Cached on the capsule at seal time: a COUNT(*) over a growing seq range
    // would make the compiler O(archive), which is the one thing it must not be.
    lossCount: capsule.carriedCount + capsule.dropped.length,
    lossNames: capsule.dropped
      .slice(-16)
      .reverse()
      .map((entry) => entry.name),
  }));
  const coveredTo = stored.length === 0 ? 0 : Math.max(...stored.map((c) => c.toSeq));

  // ---- recent window: the most recent episodes verbatim, newest-first fill
  let recent = fillRecent(vault, threadId, thread.headSeq, allocation.recent, tokenizer);

  // ---- paging (KERNEL §5): what is resident is never paged again
  const preResidentText = [
    frontier.text,
    ...capsuleViews.map((c) => c.text),
    ...recent.map((e) => e.content),
  ].join("\n");
  const residentNames = new Set<string>();
  for (const hit of names(preResidentText, { max: 4096 })) residentNames.add(hit.name);
  const residentSeqs = new Set<Seq>(recent.map((e) => e.seq));

  const prevAssistant = findPreviousAssistant(vault, threadId, turnSeq);
  const maxPages = Math.max(1, Math.floor(allocation.paged / TOKENS_PER_PAGE)) + (supportsTools ? 0 : 1);
  const paged =
    options.noPages === true || query.length === 0
      ? { blocks: [] as PagedBlock[], records: [] as PageRecord[], historical: [], tokens: 0 }
      : page(vault, threadId, {
          query,
          ...(prevAssistant === null ? {} : { prevAssistant }),
          budget: allocation.paged,
          maxPages,
          residentNames,
          residentSeqs,
          residentText: preResidentText,
          tokenizer,
        });

  const pagedRender = renderPaged(paged.blocks, allocation.paged, tokenizer);

  // ---- refill the recent window with whatever the bounded slots did not use
  const headerInfo = {
    ...(thread.title ? { title: thread.title } : {}),
    turns: thread.headSeq,
    date: new Date().toISOString().slice(0, 10),
    archiveBytes: vault.counter(threadId, COUNTERS.bytes),
    ledgerCount: vault.losses.total(threadId),
    budget,
    model,
  };
  const headerText = renderHeader(headerInfo, {
    supportsTools,
    historical: countHistorical(vault, threadId),
  });
  const fixed = tokenizer(headerText) + frontier.tokens + pagedRender.tokens;
  const capsuleBudget = Math.min(allocation.capsules, Math.max(0, budget - fixed - 200));
  const capsules = renderCapsules(capsuleViews, capsuleBudget, tokenizer);
  const recentBudget = Math.max(0, budget - fixed - capsules.tokens - 64);
  recent = fillRecent(vault, threadId, thread.headSeq, recentBudget, tokenizer);

  // ---- ledger digest: L_t := ledger ∖ names(K_t) (THEORY §11)
  //
  // A ledger name that is *present* in this packet is not a loss of this packet,
  // so the ⟨lost: …⟩ lines are filtered against the rendered view. That needs the
  // rendered view, so the capsules are rendered twice: once to know what is in
  // the packet, once with the digests the packet actually deserves.
  const namesOfPacket = (text: string): Set<string> => {
    const set = new Set<string>();
    for (const hit of names(text, { max: 8192 })) set.add(hit.name);
    return set;
  };
  const firstPass = namesOfPacket(
    [headerText, frontier.text, capsules.text, pagedRender.text, ...recent.map((e) => e.content)].join("\n"),
  );
  const seenHistoricalKeys = new Set<string>();
  const historicalDigest = [...paged.historical, ...recentHistorical(vault, threadId)]
    .filter((h) => (seenHistoricalKeys.has(h.key) ? false : (seenHistoricalKeys.add(h.key), true)))
    .slice(0, 3);
  const filteredViews = capsuleViews.map((view) => ({
    ...view,
    lossNames: view.lossNames.filter((name) => !firstPass.has(name)),
  }));
  const capsules2 = renderCapsules(filteredViews, capsuleBudget, tokenizer);
  // Measure names over the *assembled* packet, not over its parts: the ⟦changed⟧
  // line and the recovered blocks put values into the view too, and a name the
  // model can already read is not a loss of this packet.
  const probeLedger: LedgerDigest = {
    count: vault.losses.total(threadId),
    residentNames: [],
    historical: historicalDigest,
  };
  const probe = assemble({
    headerText,
    frontier: frontier.text,
    capsules: capsules2.text,
    paged: pagedRender.text,
    unknown: renderUnknownPages(paged.records),
    ledger: probeLedger,
    coveredTo,
    recent,
  });
  const packetNames = namesOfPacket(packetText(probe));
  const digestNames: string[] = [];
  const addName = (name: string): void => {
    if (!packetNames.has(name) && !digestNames.includes(name)) digestNames.push(name);
  };
  for (const view of filteredViews) {
    for (const name of view.lossNames) addName(name);
  }
  for (const item of capsules2.truncatedText) {
    for (const hit of names(item.text, { max: 64 })) addName(hit.name);
  }
  for (const atom of evicted.slice(0, 16)) addName(atom.key.toLowerCase());

  const ledger: LedgerDigest = { ...probeLedger, residentNames: digestNames.slice(0, 24) };

  // ---- render, measure, trim
  //
  // The budget is enforced on the *rendered string*, not on a sum of estimates,
  // and it is enforced by removing material rather than by hoping. The recent
  // window gives ground first; the capsule block only if that is not enough.
  const build = (window: Episode[], withCapsules: boolean): ChatMessage[] =>
    assemble({
      headerText,
      frontier: frontier.text,
      capsules: withCapsules ? capsules2.text : "",
      paged: pagedRender.text,
      unknown: renderUnknownPages(paged.records),
      ledger,
      coveredTo,
      recent: window,
    });

  let messages = build(recent, true);
  let tokens = tokenizer(packetText(messages));
  while (tokens > budget && recent.length > 1) {
    recent = recent.slice(1);
    messages = build(recent, true);
    tokens = tokenizer(packetText(messages));
  }
  if (tokens > budget) {
    messages = build(recent, false);
    tokens = tokenizer(packetText(messages));
  }

  const resident: ResidentItem[] = [
    { type: "header", tokens: tokenizer(headerText) },
    { type: "frontier", tokens: frontier.tokens },
    ...capsules2.included.map((id) => ({ type: "capsule" as const, ref: id, tokens: 0 })),
    ...pagedRender.included.map((seq) => ({ type: "paged" as const, seq, tokens: 0 })),
    ...recent.map((e) => ({ type: "recent" as const, ref: `ep:${e.seq}`, seq: e.seq, tokens: e.tokens })),
  ];

  return {
    id: newId("pk"),
    threadId,
    turnSeq,
    model,
    budget,
    tokens,
    digest: canonicalHash(messages),
    compilerVersion: COMPILER_VERSION,
    messages,
    resident,
    ledger,
    pages: paged.records,
    createdAt: Date.now(),
  };
}

interface AssembleInput {
  headerText: string;
  frontier: string;
  capsules: string;
  paged: string;
  unknown: string;
  ledger: LedgerDigest;
  coveredTo: Seq;
  recent: Episode[];
}

function assemble(input: AssembleInput): ChatMessage[] {
  const parts = [input.headerText];
  if (input.frontier.length > 0) parts.push(input.frontier);
  if (input.capsules.length > 0) parts.push(input.capsules);
  // Trimming the recent window to fit can open a hole between the last capsule
  // and the oldest resident turn. Recomputed here, after every trim, so the view
  // can never quietly skip a stretch of the archive.
  const oldest = input.recent[0]?.seq;
  if (input.coveredTo > 0 && oldest !== undefined && oldest > input.coveredTo + 1) {
    parts.push(
      `⟨gap: episodes #${input.coveredTo + 1}–#${oldest - 1} are in the archive but not in this view⟩`,
    );
  }
  if (input.ledger.residentNames.length > 0) {
    parts.push(
      `⟦omitted, recoverable⟧ ⟨lost: ${input.ledger.count} · names: ${input.ledger.residentNames.join(", ")}⟩`,
    );
  }
  if (input.ledger.historical.length > 0) {
    parts.push(
      `⟦changed⟧ ${input.ledger.historical
        .map((h) => `${h.key}: now ${h.current}, was ${h.previous} ⟨changed #${h.changedAtSeq}⟩`)
        .join(" · ")}`,
    );
  }
  if (input.paged.length > 0) parts.push(input.paged);
  if (input.unknown.length > 0) parts.push(input.unknown);
  return [{ role: "system", content: parts.join("\n\n") }, ...renderRecent(input.recent)];
}

function fillRecent(
  vault: Vault,
  threadId: string,
  headSeq: Seq,
  maxTokens: number,
  tokenizer: Tokenizer,
): Episode[] {
  if (maxTokens <= 0 || headSeq === 0) return [];
  const estimate = Math.max(4, Math.min(400, Math.ceil(maxTokens / 20)));
  const candidates = vault.episodes.tail(threadId, estimate);
  const out: Episode[] = [];
  let used = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const episode = candidates[i] as Episode;
    const cost = tokenizer(episode.content) + 4;
    if (used + cost > maxTokens) break;
    out.unshift(episode);
    used += cost;
  }
  return out;
}

function findPreviousAssistant(vault: Vault, threadId: string, turnSeq: Seq): string | null {
  const row = vault.db
    .query(
      "SELECT content FROM episode WHERE thread_id = ? AND seq < ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1",
    )
    .get(threadId, turnSeq) as { content: string } | undefined;
  return row?.content ?? null;
}

function countHistorical(vault: Vault, threadId: string): number {
  return vault.counter(threadId, COUNTERS.atomsHistorical);
}

/** The ≤ 3 most recently changed keys, for the header's `changed` line. */
function recentHistorical(
  vault: Vault,
  threadId: string,
): Array<{ key: string; current: string; previous: string; changedAtSeq: Seq }> {
  const rows = vault.db
    .query(
      "SELECT key, value, valid_to_seq FROM atom WHERE thread_id = ? AND phase = 'HISTORICAL' " +
        "AND valid_to_seq IS NOT NULL ORDER BY valid_to_seq DESC LIMIT 3",
    )
    .all(threadId) as Array<{ key: string; value: string; valid_to_seq: number }>;
  const out: Array<{ key: string; current: string; previous: string; changedAtSeq: Seq }> = [];
  for (const row of rows) {
    const current = vault.atoms.byKey(threadId, row.key, "SUPPORTED")[0];
    if (current === undefined) continue;
    out.push({
      key: row.key,
      current: current.value,
      previous: row.value,
      changedAtSeq: row.valid_to_seq,
    });
  }
  return out;
}

/**
 * A capsule is written once and never rewritten, so an atom certificate frozen
 * into its text can go stale. A stale certificate is exactly the mirage this
 * system exists to prevent — a value that still looks current after its support
 * changed — so every capsule line whose key has since been superseded is
 * re-marked ⟨historical⟩ at render time, with the seq where it changed.
 */
function markSuperseded(
  vault: Vault,
  threadId: string,
  text: string,
  cache: Map<string, number | null>,
): string {
  if (!text.includes(" = ")) return text;
  return text
    .split("\n")
    .map((line) => {
      const match = /^(★ )?(\S+) = (.*) ⟨#(\d+)⟩$/.exec(line);
      if (match === null) return line;
      const key = match[2] as string;
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
      const pointer = Number(match[4]);
      if (current === null || current <= pointer) return line;
      return `${line.slice(0, line.length - `⟨#${pointer}⟩`.length)}⟨#${pointer} · historical, superseded at #${current}⟩`;
    })
    .join("\n");
}

export type { Atom };
/** Frontier certificate for one atom — exported for the X-ray and the web demo. */
export { atomCertificate };
