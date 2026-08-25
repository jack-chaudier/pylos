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
  type EpisodeView,
  type LedgerDigest,
  MAX_PACKET_JSON_BYTES,
  type Packet,
  type PageRecord,
  type ResidentItem,
  type ResidentLocator,
  type SemanticReceipt,
  type Seq,
} from "@pylos/protocol";
import { residentCapsules } from "./compact.ts";
import { canonicalHash, newId, sha256 } from "./hash.ts";
import { coverageFor, renderCoverage } from "./obligation.ts";
import { type PageResult, page, TOKENS_PER_PAGE } from "./page.ts";
import {
  allocate,
  type BudgetShares,
  budgetSharesFailure,
  checkedBudgetShares,
  DEFAULT_SHARES,
} from "./pure/budget.ts";
import { names } from "./pure/names.ts";
import {
  atomCertificate,
  type CapsuleView,
  epistemicOfRole,
  type PagedBlock,
  packetText,
  renderCapsules,
  renderFault,
  renderFrontier,
  renderHeader,
  renderPaged,
  renderRecent,
  renderUnknownPages,
} from "./pure/render.ts";
import { approxTokens, type Tokenizer } from "./pure/tokens.ts";
import { buildReachability, reachabilityNotice } from "./reachability.ts";
import { COUNTERS } from "./schema.ts";
import {
  COMPILER_VERSION,
  checkedBudget,
  checkedModel,
  FRONTIER_ATOM_PREFETCH_BYTES,
  FRONTIER_LOCATOR_CONTENT_LIMIT,
  type StoredCapsule,
  type Vault,
  VaultError,
} from "./vault.ts";

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
  /** Router version used to revalidate persisted address edges. */
  routerVersion?: string;
  /** Request the optional address-only semantic capability. */
  semantic?: boolean;
  /** Untrusted semantic addresses injected by an optional index/runtime. */
  semanticHits?: readonly unknown[];
  /** Kernel/runtime receipt bound to those proposed addresses. */
  semanticReceipt?: SemanticReceipt;
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
const FRONTIER_KIND_ORDER: AtomKind[] = [
  "preference",
  "decision",
  "identity",
  "task",
  "fact",
  "promise",
  "correction",
  "hypothesis",
];
const TEXT_ENCODER = new TextEncoder();

/** A compiled packet and the text of its SUPPORTED spans (KERNEL A10.1). */
export interface Compilation {
  packet: Packet;
  /**
   * Everything the packet presents as evidence: user-authority certificates,
   * exact user/tool episodes, and the supported material paged for this turn.
   * This — never the whole packet — is what routing, the numeric presence test
   * and the verification round read as "already in the view".
   */
  support: string;
}

export function compile(vault: Vault, threadId: string, options: CompileOptions = {}): Packet {
  return compileView(vault, threadId, options).packet;
}

export function compileView(vault: Vault, threadId: string, options: CompileOptions = {}): Compilation {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
  if (!vault.atomDerivedReady(threadId)) vault.continueMigrations();
  vault.assertAtomDerivedReady(threadId);
  const tokenizer = options.tokenizer ?? approxTokens;
  const budget = checkedBudget(
    options.budget ?? (thread.settings.budget as number | undefined) ?? DEFAULT_BUDGET,
  );
  const sharesInput = options.shares ?? thread.settings.shares ?? DEFAULT_SHARES;
  const sharesFailure = budgetSharesFailure(sharesInput);
  if (sharesFailure !== null) throw new VaultError(`invalid budget shares: ${sharesFailure}`);
  const shares = checkedBudgetShares(sharesInput);
  const allocation = allocate(budget, shares);
  const model = checkedModel(options.model ?? (thread.settings.model as string | undefined) ?? "unknown");
  const supportsTools = options.supportsTools !== false;
  const query = options.query ?? "";
  // The turn this packet answers. When no episode has been appended for it — the
  // bench, an X-ray re-render — it is the turn that would come next, so the
  // recent window covers the whole archive tail (KERNEL A10.1).
  const turnSeq = options.turnSeq ?? thread.headSeq + 1;
  const queryEpisode = vault.episodes.get(threadId, turnSeq);

  // ---- frontier: SUPPORTED atoms only (KERNEL A4; HISTORICAL is never resident)
  // Two reads, so that a standing rule from turn 1 cannot be pushed out of the
  // candidate set by a million later facts: obligations and decisions first,
  // then the most recent everything-else.
  const pinnedCandidates: Array<{ atoms: Atom[]; bytes: number; hasMore: boolean }> = [];
  const ordinaryCandidates: Array<{ atoms: Atom[]; bytes: number; hasMore: boolean }> = [];
  let frontierPrefetchBytes = 0;
  const pinnedKinds = new Set(
    vault.atoms.hasPinned(threadId, "SUPPORTED")
      ? vault.atoms.frontierKinds(threadId, "SUPPORTED", true)
      : [],
  );
  const ordinaryKinds = new Set(vault.atoms.frontierKinds(threadId, "SUPPORTED", false));
  const knownKinds = new Set(FRONTIER_KIND_ORDER);
  const unknownFrontierKinds = [...pinnedKinds, ...ordinaryKinds].some(
    (kind) => !knownKinds.has(kind as AtomKind),
  );
  const collectLane = (
    output: Array<{ atoms: Atom[]; bytes: number; hasMore: boolean }>,
    pinned: boolean,
    kind: AtomKind,
  ): void => {
    const byteBudget = Math.max(0, FRONTIER_ATOM_PREFETCH_BYTES - frontierPrefetchBytes);
    const page =
      byteBudget === 0
        ? { atoms: [] as Atom[], bytes: 0, hasMore: true }
        : vault.atoms.frontierCandidates(threadId, {
            phase: "SUPPORTED",
            limit: 600,
            kinds: [kind],
            pinned,
            byteBudget,
          });
    output.push(page);
    frontierPrefetchBytes += page.bytes;
  };
  // A4's priority is a lane ordering, not a post-query sort.  Fill every
  // pinned lane before opening any ordinary lane; otherwise a large earlier
  // ordinary lane could consume the aggregate prefetch budget and silently
  // displace an older pinned certificate from a later kind.
  for (const kind of FRONTIER_KIND_ORDER) {
    if (pinnedKinds.has(kind)) collectLane(pinnedCandidates, true, kind);
  }
  for (const kind of FRONTIER_KIND_ORDER) {
    if (ordinaryKinds.has(kind)) collectLane(ordinaryCandidates, false, kind);
  }
  const ordinaryAtoms = ordinaryCandidates.flatMap((page) => page.atoms);
  const obligations = exactFrontierCandidates([
    ...pinnedCandidates.flatMap((page) => page.atoms),
    ...ordinaryCandidates.slice(0, 5).flatMap((page) => page.atoms),
  ]);
  const recentAtoms = exactFrontierCandidates(ordinaryAtoms);
  const frontierContinued =
    unknownFrontierKinds ||
    pinnedCandidates.some((page) => page.hasMore) ||
    ordinaryCandidates.some((page) => page.hasMore);
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
  const frontierNotice = frontierContinued
    ? "⟨frontier continued: additional current atoms may remain; route to inspect them⟩"
    : "";
  const frontierNoticeTokens = frontierNotice.length === 0 ? 0 : tokenizer(frontierNotice) + 1;
  const renderedFrontier = renderFrontier(
    ordered,
    Math.max(0, allocation.frontier - frontierNoticeTokens),
    tokenizer,
  );
  const frontier = {
    ...renderedFrontier,
    text: frontierNotice.length === 0 ? renderedFrontier.text : `${renderedFrontier.text}\n${frontierNotice}`,
    tokens: renderedFrontier.tokens + frontierNoticeTokens,
  };
  const includedAtoms = new Set(frontier.included);
  // Only the user's own current certificates are support (KERNEL A10.1).
  const frontierSupport = ordered
    .filter((atom) => includedAtoms.has(atom.id) && atom.authority === "user")
    .map(atomCertificate);
  // Locators are bounded metadata attached to the frontier item.  They expose
  // exact source bytes to the evidence gate without adding one `seq` field per
  // atom (which would incorrectly make every source a resident reachability
  // edge).
  const locatorEpisodes = new Map<number, EpisodeView | null>();
  const frontierLocators = ordered
    .filter((atom) => includedAtoms.has(atom.id))
    .slice(0, 256)
    .flatMap((atom) => frontierLocator(vault, threadId, atom, locatorEpisodes));
  const evicted = ordered.filter((a) => !includedAtoms.has(a.id));
  if (options.record === true) {
    for (const atom of evicted) {
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
    lossCount: capsule.carriedCount + (capsule.ledgerReceipt?.dropped.count ?? capsule.dropped.length),
    lossNames: capsule.dropped
      .slice(-16)
      .reverse()
      .map((entry) => entry.name),
  }));
  const coveredTo = stored.length === 0 ? 0 : Math.max(...stored.map((c) => c.toSeq));

  // ---- recent window: the episodes before this turn, verbatim, newest-first fill
  let recent = fillRecent(vault, threadId, turnSeq, allocation.recent, tokenizer);

  // ---- paging (KERNEL §5): what the view *supports* is never paged again
  //
  // Presence is not support (KERNEL A10.1). The header, the capsule gist and the
  // question being asked are all in the packet and none of them is evidence, so
  // the routing test reads the supported spans only — otherwise the question
  // would suppress the page that answers it.
  const preSupport = [...frontierSupport, ...supportedEpisodes(recent)].join("\n");
  const residentNames = new Set<string>();
  for (const hit of names(preSupport, { max: 4096 })) residentNames.add(hit.name);
  const residentSeqs = new Set<Seq>(recent.map((e) => e.seq));
  residentSeqs.add(turnSeq);

  const prevAssistant = findPreviousAssistant(vault, threadId, turnSeq);
  // Nothing has been compacted and the window reaches turn 1: the view is the
  // archive, so a question the index could not route is not a miss (KERNEL A11.1).
  const archiveInView = coveredTo === 0 && (recent[0]?.seq ?? turnSeq) <= 1;
  const maxPages = Math.max(1, Math.floor(allocation.paged / TOKENS_PER_PAGE)) + (supportsTools ? 0 : 1);
  const wantsSemantic = options.semantic !== false;
  const localSemantic =
    wantsSemantic && options.semanticHits === undefined && options.noPages !== true && query.length > 0
      ? vault.semanticRoute(threadId, query, turnSeq, maxPages)
      : undefined;
  const semanticHits = options.semanticHits ?? localSemantic?.hits;
  const semanticReceipt = options.semanticReceipt ?? localSemantic?.receipt ?? vault.semanticStatus(threadId);
  const runPage = (hits?: readonly unknown[]): PageResult =>
    page(vault, threadId, {
      query,
      ...(prevAssistant === null ? {} : { prevAssistant }),
      budget: allocation.paged,
      maxPages,
      residentNames,
      residentSeqs,
      residentText: preSupport,
      archiveInView,
      ...(queryEpisode === null ? {} : { querySeq: turnSeq }),
      ...(options.routerVersion === undefined ? {} : { routerVersion: options.routerVersion }),
      semantic: wantsSemantic,
      semanticReceipt,
      ...(hits === undefined ? {} : { semanticHits: hits }),
      tokenizer,
    });
  let paged: PageResult =
    options.noPages === true || query.length === 0
      ? {
          blocks: [] as PagedBlock[],
          records: [] as PageRecord[],
          historical: [],
          tokens: 0,
          semantic: semanticReceipt,
        }
      : runPage();
  // Semantic addresses are proposals after every deterministic route.  Only a
  // deterministic miss spends their bounded page, so a bad vector can add one
  // failed page but can never suppress an exact sequence/name/FTS result.
  if (
    options.noPages !== true &&
    query.length > 0 &&
    semanticHits !== undefined &&
    semanticHits.length > 0 &&
    !paged.records.some((record) => record.resolved)
  ) {
    paged = runPage(semanticHits);
  }

  // The capability receipt is emitted even when no sqlite-vec/runtime is
  // packaged. A caller can distinguish an unavailable semantic route from a
  // lexical miss; the model never infers capability from absent pages.
  const semantic: SemanticReceipt = paged.semantic ?? semanticReceipt;

  const pagedRender = renderPaged(paged.blocks, allocation.paged, tokenizer);
  // Collection obligations are kernel-derived from the asking turn and the
  // exact deterministic routes above. The block is packet material, so it is
  // included in both the budget and packet digest below; it is deliberately
  // not part of `support` because receipt prose is not evidence.
  const coverage = coverageFor(vault, threadId, {
    question: query,
    querySeq: turnSeq,
    pages: paged.records,
    routerVersion: options.routerVersion ?? COMPILER_VERSION,
  });
  const coverageText = coverage === undefined ? "" : renderCoverage(coverage);
  // A fault is a receipt for the whole turn, not a page, so it is never priced
  // out of the paged slot: it is rendered whatever the slot held and its ~70
  // tokens come off the recent window, like every other fixed cost (KERNEL A11.1).
  const faultText = renderFault(paged.records, supportsTools);
  const faultTokens = faultText.length === 0 ? 0 : tokenizer(faultText);
  // The fault costs what its notice costs; only the compiler knows which wording
  // this model gets, so the record is priced here (KERNEL A11.1).
  for (const record of paged.records) {
    if (record.trigger === "fault") record.tokens = faultTokens;
  }

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
  // The current turn is rendered once, at the end, as the `query` span — never as
  // part of the recent window, so it can never stand as its own witness.
  const queryMessages = queryEpisode === null ? [] : renderRecent([queryEpisode]);
  const queryTokens = queryMessages.length === 0 ? 0 : tokenizer(packetText(queryMessages));
  const coverageTokens = coverageText.length === 0 ? 0 : tokenizer(coverageText);
  const fixed =
    tokenizer(headerText) + frontier.tokens + coverageTokens + pagedRender.tokens + faultTokens + queryTokens;
  const capsuleBudget = Math.min(allocation.capsules, Math.max(0, budget - fixed - 200));
  const capsules = renderCapsules(capsuleViews, capsuleBudget, tokenizer);
  // `fixed` already includes every rendered fixed block.  Keeping another
  // arbitrary reserve here made a small-but-valid preceding episode vanish
  // whenever the header consumed most of a tiny packet budget; the final
  // render/measure loop below is the actual safety valve.
  const recentBudget =
    allocation.recent <= 0 || shares.header + shares.frontier + shares.capsules + shares.paged >= 1
      ? 0
      : Math.max(0, budget - fixed - capsules.tokens);
  recent = fillRecent(vault, threadId, turnSeq, recentBudget, tokenizer);

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
    .filter((h) => {
      if (seenHistoricalKeys.has(h.key)) return false;
      seenHistoricalKeys.add(h.key);
      return true;
    })
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
    coverage: coverageText,
    paged: pagedRender.text,
    unknown: renderUnknownPages(paged.records),
    fault: faultText,
    ledger: probeLedger,
    coveredTo,
    recent,
    query: queryMessages,
    reachabilityNotice: "",
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
  const renderedCapsuleIds = new Set(capsules2.included);
  let capsulesRendered = true;
  let receiptCapsules: readonly StoredCapsule[] = stored.filter((capsule) =>
    renderedCapsuleIds.has(capsule.id),
  );
  let receipt: ReturnType<typeof buildReachability> = [];
  let receiptNotice = "";
  const refreshReceipt = (): void => {
    const receiptResident: ResidentItem[] = [
      ...recent.map((episode) => ({
        type: "recent" as const,
        ref: `ep:${episode.seq}`,
        seq: episode.seq,
        tokens: episode.tokens,
        epistemic: epistemicOfRole(episode.role),
      })),
      ...(queryEpisode === null
        ? []
        : [
            {
              type: "query" as const,
              ref: `ep:${queryEpisode.seq}`,
              seq: queryEpisode.seq,
              tokens: queryTokens,
              epistemic: "NON_AUTHORITATIVE" as const,
            },
          ]),
    ];
    receipt = buildReachability(vault, threadId, {
      resident: receiptResident,
      capsules: receiptCapsules,
      asOfSeq: Math.min(thread.headSeq, turnSeq),
    });
    receiptNotice = reachabilityNotice(receipt);
  };
  const build = (window: Episode[], withCapsules: boolean): ChatMessage[] =>
    assemble({
      headerText,
      frontier: frontier.text,
      capsules: withCapsules ? capsules2.text : "",
      coverage: coverageText,
      paged: pagedRender.text,
      unknown: renderUnknownPages(paged.records),
      fault: faultText,
      ledger,
      coveredTo,
      recent: window,
      query: queryMessages,
      reachabilityNotice: receiptNotice,
    });

  let messages = build(recent, true);
  let tokens = tokenizer(packetText(messages));
  // A receipt is packet-visible material.  Recompute it after each trim so a
  // newly opened tail cannot disappear behind the previous receipt.
  refreshReceipt();
  messages = build(recent, true);
  tokens = tokenizer(packetText(messages));
  let trimPasses = 0;
  while (tokens > budget && recent.length > 1 && trimPasses < 4096) {
    recent = recent.slice(1);
    trimPasses += 1;
    refreshReceipt();
    messages = build(recent, true);
    tokens = tokenizer(packetText(messages));
  }
  if (tokens > budget) {
    receiptCapsules = [];
    capsulesRendered = false;
    refreshReceipt();
    messages = build(recent, false);
    tokens = tokenizer(packetText(messages));
  }

  const resident: ResidentItem[] = [
    { type: "header", tokens: tokenizer(headerText), epistemic: "NON_AUTHORITATIVE" },
    {
      type: "frontier",
      tokens: frontier.tokens,
      epistemic: "SUPPORTED",
      ...(frontierLocators.length === 0 ? {} : { locators: frontierLocators }),
    },
    ...(capsulesRendered ? [...renderedCapsuleIds] : []).map((id) => ({
      type: "capsule" as const,
      ref: id,
      tokens: 0,
      epistemic: "NON_AUTHORITATIVE" as const,
    })),
    ...pagedRender.included.map((block) => ({
      type: "paged" as const,
      seq: block.seq,
      tokens: 0,
      epistemic: block.epistemic,
    })),
    ...(faultText.length === 0
      ? []
      : [
          {
            type: "paged" as const,
            ref: "fault",
            tokens: faultTokens,
            epistemic: "NON_AUTHORITATIVE" as const,
          },
        ]),
    ...recent.map((e) => ({
      type: "recent" as const,
      ref: `ep:${e.seq}`,
      seq: e.seq,
      tokens: e.tokens,
      epistemic: epistemicOfRole(e.role),
    })),
    ...(queryEpisode === null
      ? []
      : [
          {
            type: "query" as const,
            ref: `ep:${queryEpisode.seq}`,
            seq: queryEpisode.seq,
            tokens: queryTokens,
            epistemic: "NON_AUTHORITATIVE" as const,
          },
        ]),
  ];

  const support = [
    ...frontierSupport,
    ...pagedRender.included.filter((b) => b.epistemic === "SUPPORTED").map((b) => b.text),
    ...supportedEpisodes(recent),
  ].join("\n");

  // The renderer trims every optional section, but a mandatory header/query can
  // still exceed a very small caller-selected budget. Returning that packet
  // would violate the kernel contract; fail before a direct compile can expose
  // over-budget output. runTurn maps this typed failure to `turn_too_large` in
  // its preflight path, after SQLite has rolled back the dry append.
  if (tokens > budget) throw compileTooLarge(budget, tokens);

  return {
    packet: {
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
      reachability: receipt,
      reachabilityAsOfSeq: Math.min(thread.headSeq, turnSeq),
      ...(coverage === undefined ? {} : { coverage }),
      semantic,
      createdAt: Date.now(),
    },
    support,
  };
}

function compileTooLarge(budget: number, tokens: number): Error & { code: "packet_too_large" } {
  const error = new VaultError(
    `compiled packet costs ${tokens} tokens, above the selected budget ${budget}`,
  ) as Error & {
    code: "packet_too_large";
  };
  error.code = "packet_too_large";
  return error;
}

/** The exact text of the episodes in a window that count as support (KERNEL A10.1). */
function supportedEpisodes(episodes: readonly Episode[]): string[] {
  return episodes.filter((e) => epistemicOfRole(e.role) === "SUPPORTED").map((e) => e.content);
}

type BoundedFrontierAtom = Atom & {
  keyTruncated?: boolean;
  valueTruncated?: boolean;
};

/**
 * A bounded SQL projection may be an address candidate, but a truncated key or
 * value cannot be rendered as a certificate. Keep it unresolved and let the
 * continuation notice expose that the candidate set was not exhaustive.
 */
function exactFrontierCandidates(atoms: readonly Atom[]): Atom[] {
  return atoms.filter((atom) => {
    const bounded = atom as BoundedFrontierAtom;
    return bounded.keyTruncated !== true && bounded.valueTruncated !== true;
  });
}

/** Build one exact, bounded source locator for a current frontier atom. */
function frontierLocator(
  vault: Vault,
  threadId: string,
  atom: Atom,
  cache: Map<number, EpisodeView | null>,
): ResidentLocator[] {
  let episode = cache.get(atom.sourceSeq);
  if (episode === undefined && !cache.has(atom.sourceSeq)) {
    episode = vault.episodes.getBounded(threadId, atom.sourceSeq, FRONTIER_LOCATOR_CONTENT_LIMIT);
    cache.set(atom.sourceSeq, episode);
  }
  if (
    episode === undefined ||
    episode === null ||
    episode.meta.removed === true ||
    episode.locator === undefined
  ) {
    return [];
  }
  if (episode.contentTruncated && atom.sourceSpan === undefined) return [];
  const bytes = new TextEncoder().encode(episode.content);
  const span = atom.sourceSpan;
  let byteRange: [number, number] = [0, bytes.byteLength];
  if (span !== undefined && span.length === 2) {
    const [charFrom, charTo] = span;
    if (
      Number.isInteger(charFrom) &&
      Number.isInteger(charTo) &&
      charFrom >= 0 &&
      charTo > charFrom &&
      charTo <= episode.content.length
    ) {
      const from = new TextEncoder().encode(episode.content.slice(0, charFrom)).byteLength;
      const to = new TextEncoder().encode(episode.content.slice(0, charTo)).byteLength;
      if (to > from && to <= bytes.byteLength) {
        byteRange = [from, to];
      } else {
        return [];
      }
    }
  }
  if (episode.contentTruncated && byteRange[1] > bytes.byteLength) return [];
  const authority: ResidentLocator["authority"] =
    atom.authority === "user" ? "user" : atom.authority === "assistant" ? "assistant" : "model";
  return [
    {
      source: episode.locator.source,
      seq: episode.seq,
      byteRange,
      contentHash: episode.locator.contentHash,
      spanHash: sha256(bytes.slice(byteRange[0], byteRange[1])),
      revision: episode.hash,
      authority,
      atomId: atom.id,
      atomKey: atom.key,
    },
  ];
}

interface AssembleInput {
  headerText: string;
  frontier: string;
  capsules: string;
  /** Kernel-generated collection coverage block, if this turn has a cue. */
  coverage: string;
  paged: string;
  unknown: string;
  /** The page fault line, when every route of this turn came back empty (KERNEL A11.1). */
  fault: string;
  ledger: LedgerDigest;
  coveredTo: Seq;
  recent: Episode[];
  /** The current turn, rendered last and outside the recent window (KERNEL A10.1). */
  query: ChatMessage[];
  /** The compact retained-byte receipt and its packet-visible notice. */
  reachabilityNotice?: string;
}

function assemble(input: AssembleInput): ChatMessage[] {
  const parts = [input.headerText];
  if (input.frontier.length > 0) parts.push(input.frontier);
  if (input.capsules.length > 0) parts.push(input.capsules);
  if (input.coverage.length > 0) parts.push(input.coverage);
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
  if (input.reachabilityNotice !== undefined && input.reachabilityNotice.length > 0) {
    parts.push(input.reachabilityNotice);
  }
  if (input.paged.length > 0) parts.push(input.paged);
  if (input.unknown.length > 0) parts.push(input.unknown);
  if (input.fault.length > 0) parts.push(input.fault);
  return [{ role: "system", content: parts.join("\n\n") }, ...renderRecent(input.recent), ...input.query];
}

/** The episodes immediately before `turnSeq`, newest-first fill (KERNEL §4, A10.1). */
// Episode content is untrusted and may be a multi-megabyte imported line.
// Metadata is scanned in keyset batches, then a byte-capped contiguous slice
// is materialized. A single oversized row may exceed the cap, but no second
// row is loaded alongside it.
const RECENT_SCAN_BATCH = 256;
const RECENT_BYTE_CAP = 256 * 1024;
// Reachability is a packet field too: one explicit resident episode carries a
// hash-bound span, and retaining an unbounded recent tail would therefore turn
// a legal large-budget compile into an oversized receipt.  The remainder is
// represented by the arithmetic pageable range emitted by buildReachability.
const RECENT_RESIDENT_COUNT_CAP = 256;
const RECENT_RESIDENT_BYTE_CAP = Math.floor(MAX_PACKET_JSON_BYTES / 2);

function fillRecent(
  vault: Vault,
  threadId: string,
  turnSeq: Seq,
  maxTokens: number,
  tokenizer: Tokenizer,
): Episode[] {
  if (maxTokens <= 0 || turnSeq <= 1) return [];
  const out: Episode[] = [];
  let used = 0;
  let residentBytes = 0;
  let before = turnSeq;
  // Keyset pagination bounds memory to one batch while the walk itself is
  // exhaustive.  A fitting older row must never disappear behind an arbitrary
  // scan horizon; if no row fits, the archive is still represented by the
  // pageable reachability ranges assembled by the caller.
  while (used < maxTokens && out.length < RECENT_RESIDENT_COUNT_CAP && before > 1) {
    const metadata = vault.db
      .query(
        "SELECT seq, length(CAST(content AS BLOB)) AS bytes FROM episode " +
          "WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(threadId, before, RECENT_SCAN_BATCH) as Array<{ seq: number; bytes: number }>;
    if (metadata.length === 0) break;

    const selectedMetadata: Array<{ seq: number; bytes: number }> = [];
    let selectedBytes = 0;
    for (const row of metadata) {
      const bytes = Number.isSafeInteger(row.bytes) && row.bytes >= 0 ? row.bytes : 0;
      // Keep one oversized candidate so it can be skipped by the exact
      // tokenizer, but never load it together with another large row.
      if (selectedMetadata.length > 0 && selectedBytes + bytes > RECENT_BYTE_CAP) break;
      selectedMetadata.push({ seq: row.seq, bytes });
      selectedBytes += bytes;
      if (selectedBytes >= RECENT_BYTE_CAP) break;
    }
    const newest = selectedMetadata[0];
    const oldest = selectedMetadata.at(-1);
    if (newest === undefined || oldest === undefined) break;
    const candidates = vault.episodes.range(threadId, oldest.seq, newest.seq);
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const episode = candidates[i] as Episode;
      const cost = tokenizer(episode.content) + 4;
      // A single oversized tail must not stop the walk.  Older, smaller
      // episodes are still useful witnesses and the skipped episode receives
      // a pageable reachability range in the packet assembled by the caller.
      const bytes = TEXT_ENCODER.encode(episode.content).byteLength;
      if (
        cost > maxTokens ||
        used + cost > maxTokens ||
        bytes > RECENT_RESIDENT_BYTE_CAP ||
        residentBytes + bytes > RECENT_RESIDENT_BYTE_CAP
      ) {
        continue;
      }
      out.unshift(episode);
      used += cost;
      residentBytes += bytes;
      if (used >= maxTokens || out.length >= RECENT_RESIDENT_COUNT_CAP) break;
    }
    before = oldest.seq;
    if (selectedMetadata.length < metadata.length || used >= maxTokens) continue;
    if (metadata.length < RECENT_SCAN_BATCH) break;
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
      // Authority filter: a closed proposal is HISTORICAL too, but it was never
      // true, so it can never be the "was" of a ⟦changed⟧ line (KERNEL A9.1).
      "SELECT key, value, valid_to_seq FROM atom WHERE thread_id = ? AND phase = 'HISTORICAL' " +
        "AND authority = 'user' AND valid_to_seq IS NOT NULL ORDER BY valid_to_seq DESC LIMIT 3",
    )
    .all(threadId) as Array<{ key: string; value: string; valid_to_seq: number }>;
  const out: Array<{ key: string; current: string; previous: string; changedAtSeq: Seq }> = [];
  for (const row of rows) {
    const current = vault.atoms.latestByKey(threadId, row.key, "SUPPORTED");
    if (current === null) continue;
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
