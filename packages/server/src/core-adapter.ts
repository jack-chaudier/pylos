/**
 * Binds `@pylos/core` (KERNEL §9) to the server's `Kernel` interface.
 *
 * The kernel is synchronous over `bun:sqlite`; the server is async. This file
 * is the only place that seam exists, and the only place that knows the kernel
 * is SQLite at all.
 */
import type {
  Atom,
  AtomPage,
  AtomPhase,
  AttachmentManifest,
  AttachmentSpan,
  BudgetShares,
  Capsule,
  CapsulePage,
  DemoAnswerReceipt,
  DemoAttachmentSpanResource,
  DemoEpisodeResource,
  DemoPacketCoverage,
  DemoPacketReceipt,
  DemoRemovalReceipt,
  DemoRouteResource,
  DemoSummary,
  DemoWitness,
  Episode,
  EpisodePage,
  EpisodeView,
  LedgerPage,
  LossEntry,
  Packet,
  ProviderId,
  SearchPage,
  Seq,
  ThreadId,
  ThreadListOptions,
  ThreadListPage,
  ThreadSourceReadiness,
  ThreadStats,
  ToolDef,
  TurnEvent,
} from "@pylos/protocol";
import {
  MAX_ATOM_PAGE_ITEMS,
  MAX_CAPSULE_PAGE_ITEMS,
  MAX_DERIVED_RESPONSE_BYTES,
  MAX_LEDGER_PAGE_ITEMS,
  MAX_PACKET_RESPONSE_BYTES,
  MAX_THREAD_ID_BYTES,
  MAX_THREAD_LIST_RESPONSE_BYTES,
  MAX_THREAD_LIST_ROW_BYTES,
  MAX_THREAD_LIST_ROWS,
  MAX_TRANSCRIPT_RESPONSE_BYTES,
} from "@pylos/protocol";
import type {
  AttachInput,
  ForgetOutcome,
  ForgetTarget,
  Kernel,
  ThreadFragmentStatus,
  ThreadSettings,
  ThreadVerification,
  TurnInput,
} from "./kernel.ts";
import type { ProviderFn, ProviderEvent as ServerProviderEvent } from "./providers/types.ts";
import { type Ticket, TurnQueue } from "./turn-queue.ts";

// The kernel's own vocabulary, structurally typed so the server never imports
// its concrete classes at type level (the module is loaded dynamically).
interface CoreProviderRequest {
  model: string;
  messages: unknown[];
  tools: ToolDef[];
  signal?: AbortSignal;
  maxOutputBytes?: number;
  maxOutputScope?: "round" | "turn";
  maxOutputReportedBytes?: number;
}

interface CoreAddressWitness {
  seq: Seq;
  contentHash: string;
  byteRange: [number, number];
  spanHash?: string;
  revision?: string;
  authority: DemoWitness["authority"];
  source?: string;
  manifestId?: string;
}

interface CoreAddressRoute {
  id: string;
  threadId: string;
  queryDigest: string;
  normalizedQuery: string;
  routerVersion: string;
  questionSeq: Seq;
  answerSeq?: Seq;
  packetId?: string;
  packetDigest?: string;
  sourceSeqs: Seq[];
  witnesses: CoreAddressWitness[];
  routeDigest: string;
  status: DemoRouteResource["status"];
  storedStatus: DemoRouteResource["storedStatus"];
  effectiveStatus: DemoRouteResource["effectiveStatus"];
  asOfSeq: Seq;
  reason?: string;
  invalidatedBy?: string;
  closedBy?: string;
  createdAt: number;
}

type CoreProviderEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done"; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string; code?: string };

interface Vault {
  home: string;
  close(): void;
  threads: {
    create(title?: string): { id: string };
    get(id: string): { id: string; title: string; settings: Record<string, unknown> } | null;
    header(id: string): {
      id: string;
      title: string | null;
      titleBytes: number;
      headSeq: number;
      headHash: string;
    } | null;
    runtime(id: string): { id: string; settings: Record<string, unknown> } | null;
    list(): Array<{ id: string }>;
    listPage(options?: { after?: { createdAt: number; id: string }; limit?: number }): {
      threads: Array<{ id: string; createdAt: number }>;
      hasMore: boolean;
    };
    primary(): { id: string };
    setSettings(id: string, settings: Record<string, unknown>): void;
    setTitle(id: string, title: string): void;
  };
  fragments: {
    get(id: string): {
      threadId: string;
      originalThreadId: string;
      fromSeq: Seq;
      toSeq: Seq;
      prevHash: string;
      headHash: string;
      createdAt: number;
    } | null;
  };
  capsuleSourceReadiness(
    threadId: string,
    headSeq?: Seq,
  ): { status: "pending" | "noncompactable"; readOnly: true; seq?: Seq; reason: string } | null;
  /** Bounded migration step; it may report pending until the next leaf is checked. */
  continueCapsuleSourceReadiness(
    threadId: string,
  ): { status: "pending" | "noncompactable"; readOnly: true; seq?: Seq; reason: string } | null;
  archiveBytes(): number;
  episodes: {
    append(threadId: string, input: Record<string, unknown>): Episode;
    appendMany(threadId: string, inputs: Array<Record<string, unknown>>): Episode[];
    get(threadId: string, seq: Seq): Episode | null;
    lastSpokenModel(threadId: string): string | undefined;
    getBounded(threadId: string, seq: Seq, contentLimit?: number, metaLimit?: number): EpisodeView | null;
    list(threadId: string, opts: { before?: Seq; after?: Seq; limit?: number }): Episode[];
    listBounded(
      threadId: string,
      opts: { before?: Seq; after?: Seq; limit?: number },
      contentLimit?: number,
      metaLimit?: number,
    ): EpisodeView[];
    search(threadId: string, query: string, limit?: number): Episode[];
    searchBounded(
      threadId: string,
      query: string,
      limit?: number,
      opts?: { mode?: "both" | "strict"; exclude?: Seq; before?: Seq },
      contentLimit?: number,
      metaLimit?: number,
    ): EpisodeView[];
  };
  blobs: {
    put(bytes: Uint8Array, mime?: string): string;
    get(hash: string): Uint8Array | null;
    size(hash: string): number | null;
  };
  atoms: {
    list(threadId: string, opts: { phase?: AtomPhase; limit?: number }): Atom[];
    listBounded(
      threadId: string,
      opts?: { phase?: AtomPhase; limit?: number; after?: string },
    ): { atoms: AtomPage["atoms"]; hasMore: boolean; nextCursor?: string };
    getBounded(threadId: string, atomId: string): AtomPage["atoms"][number] | null;
    searchBounded(
      threadId: string,
      query: string,
      limit?: number,
      textLimit?: number,
      valueLimit?: number,
    ): Atom[];
    get(id: string): Atom | null;
    pin(threadId: string, atomId: string, pinned: boolean): void;
  };
  capsules: {
    list(threadId: string, level?: number, limit?: number): Capsule[];
    listBounded(
      threadId: string,
      level?: number,
      opts?: { limit?: number; after?: string },
    ): { capsules: CapsulePage["capsules"]; hasMore: boolean; nextCursor?: string };
  };
  losses: {
    byName(threadId: string, name: string, limit?: number): LossEntry[];
    inRange(threadId: string, from: Seq, to: Seq, limit?: number): LossEntry[];
    listBounded(
      threadId: string,
      opts?: { from?: Seq; to?: Seq; name?: string; limit?: number; after?: string },
    ): { entries: LedgerPage["entries"]; hasMore: boolean; nextCursor?: string };
  };
  packets: {
    preflight(threadId: string, turnSeq: Seq): "ok" | "missing" | "oversized" | "malformed";
    preflightById(id: string): {
      status: "ok" | "missing" | "oversized" | "malformed";
      threadId?: string;
    };
    get(threadId: string, turnSeq: Seq): Packet | null;
    byId(id: string): Packet | null;
    demo(threadId: string, turnSeq: Seq): Packet | null;
    demoById(id: string): Packet | null;
    last(threadId: string): Packet | null;
  };
  addresses: {
    list(threadId: string, query?: string): CoreAddressRoute[];
    /** Exact-id, effective-state lookup; never hydrates append-only history. */
    get(threadId: string, routeId: string): CoreAddressRoute | null;
  };
}

interface CoreModule {
  openVault(options?: { home?: string }): Vault;
  runTurn(
    vault: Vault,
    threadId: string,
    options: Record<string, unknown>,
  ): Promise<{ assistantEpisode: Episode; usage?: unknown }>;
  demo(vault: Vault, threadId: string): Promise<DemoSummary>;
  readDemo(vault: Vault, threadId: string): DemoSummary | null;
  /** One bounded derived-index pass; the adapter never loops without a cap. */
  compact?(vault: Vault, threadId: string, options?: { budget?: number }): unknown[];
  readAttachmentSpan?(
    vault: Vault,
    threadId: string,
    seq: Seq,
    ordinal: number,
  ): {
    episode: Episode;
    manifest: AttachmentManifest;
    span: AttachmentSpan;
    bytes: Uint8Array;
  } | null;
  manifestPartitionValid?(manifest: AttachmentManifest): boolean;
  sha256?(value: string | Uint8Array): string;
  forget(
    vault: Vault,
    threadId: string,
    target: ForgetTarget,
  ): {
    tombstoneId: string;
    removalSeq: Seq;
    echoes: Seq[];
    capsules: number;
    packets: number;
    blobs: string[];
    cleanupPending: boolean;
  };
  stats(vault: Vault, threadId: string, options?: { verify?: boolean; archiveBytes?: number }): ThreadStats;
  verify(
    vault: Vault,
    threadId: string,
    options?: { full?: boolean },
  ): {
    ok: boolean;
    headHash: string;
    checkedTo: Seq;
    checkedFrom?: Seq;
    failedAt?: Seq;
    reason?: string;
    fragmentVerified?: boolean;
    fragment?: {
      originalThreadId: string;
      fromSeq: Seq;
      toSeq: Seq;
      prevHash: string;
      headHash: string;
    };
  };
  exportBundle(
    vault: Vault,
    threadId: string,
    options: { passphrase: string; range?: [Seq, Seq] },
  ): Promise<Uint8Array>;
  exportBundleStream?(
    vault: Vault,
    threadId: string,
    options: { passphrase: string; range?: [Seq, Seq] },
  ): Promise<ReadableStream<Uint8Array>>;
  importBundle(
    vault: Vault,
    bytes: Uint8Array,
    options: { passphrase: string; threadId?: string },
  ): Promise<{ threadId: string }>;
  importBundleStream?(
    vault: Vault,
    stream: ReadableStream<Uint8Array>,
    options: { passphrase: string; threadId?: string },
  ): Promise<{ threadId: string }>;
}

const DEMO_PACKET_PAGE_LIMIT = 128;
const DEMO_PACKET_ROUTE_LIMIT = 256;
const DEMO_PACKET_SEARCH_LIMIT = 64;
const DEMO_PACKET_CLAIM_LIMIT = 256;
const DEMO_PACKET_TEXT_LIMIT = 16 * 1024;
const DEMO_ATTACHMENT_SPAN_LIMIT = 64 * 1024;
/** Prefix retained by the bounded proof endpoint for a large episode. */
export const DEMO_EVIDENCE_TEXT_LIMIT = 8 * 1024;
/** Aggregate safety bounds for ordinary transcript/search projections. */
const TRANSCRIPT_RESPONSE_ROW_BUDGET = 192 * 1024;
const TRANSCRIPT_META_LIMIT = 16 * 1024;
const TRANSCRIPT_ATOM_TEXT_LIMIT = 2 * 1024;
const MAINTENANCE_PASSES = 4;

function boundedText(value: string, limit: number): { text: string; bytes: number } {
  const source = Buffer.from(value, "utf8");
  let end = Math.min(source.byteLength, limit);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end >= 0) {
    try {
      return { text: decoder.decode(source.subarray(0, end)), bytes: end };
    } catch {
      end -= 1;
    }
  }
  return { text: "", bytes: 0 };
}

interface ThreadCursor {
  createdAt: number;
  id: string;
}

function encodeThreadCursor(thread: ThreadCursor): string {
  return Buffer.from(JSON.stringify(thread), "utf8").toString("base64url");
}

function decodeThreadCursor(value: string | undefined): ThreadCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.createdAt === "number" &&
      Number.isSafeInteger(parsed.createdAt) &&
      parsed.createdAt >= 0 &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0 &&
      Buffer.byteLength(parsed.id, "utf8") <= MAX_THREAD_ID_BYTES
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // Fall through to the stable HTTP error below.
  }
  throw Object.assign(new Error("The thread-list cursor is invalid."), {
    status: 400,
    code: "invalid_thread_cursor",
  });
}

function threadPageEnvelope(
  threads: ThreadStats[],
  hasMore: boolean,
  last: ThreadCursor | undefined,
): ThreadListPage {
  const nextCursor = hasMore && last !== undefined ? encodeThreadCursor(last) : undefined;
  const base = {
    threads,
    hasMore,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
  let byteLength = Buffer.byteLength(JSON.stringify(base), "utf8");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const envelope = { ...base, byteLength };
    const actual = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    if (actual === byteLength) return envelope;
    byteLength = actual;
  }
  return { ...base, byteLength };
}

function boundedEpisodePage(
  rows: EpisodeView[],
  opts: { before?: Seq; after?: Seq },
  source: "episode-page" | "search",
  forcedTruncated = false,
  mode: "transcript" | "search" = "transcript",
): EpisodePage {
  const sizes = rows.map((row) => Buffer.byteLength(JSON.stringify(row), "utf8"));
  let kept: EpisodeView[];
  let byteLength = 2;
  if (mode === "transcript" && opts.after === undefined) {
    // `listBounded` is ascending after reversing SQLite's newest-first page.
    // Keep the newest suffix so the UI's next request can use before=firstSeq
    // and recover every omitted older row without duplication.
    let start = rows.length;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const size = sizes[index] ?? 0;
      if (start < rows.length && byteLength + size + 1 > TRANSCRIPT_RESPONSE_ROW_BUDGET) break;
      start = index;
      byteLength += size + (start === rows.length - 1 ? 0 : 1);
    }
    kept = rows.slice(start);
  } else {
    let end = 0;
    for (; end < rows.length; end += 1) {
      const size = sizes[end] ?? 0;
      if (end > 0 && byteLength + size + 1 > TRANSCRIPT_RESPONSE_ROW_BUDGET) break;
      byteLength += size + (end === 0 ? 0 : 1);
    }
    kept = rows.slice(0, end);
  }
  let truncated = forcedTruncated || kept.length < rows.length;
  const build = (): EpisodePage => {
    const cursor = mode === "transcript" && opts.after === undefined ? kept[0]?.seq : kept.at(-1)?.seq;
    const continuation = truncated
      ? {
          source,
          omittedLowerBound: Math.max(1, rows.length - kept.length),
          omittedUnknown: forcedTruncated,
          ...(mode === "transcript" && opts.after === undefined
            ? cursor === undefined
              ? {}
              : { before: cursor }
            : cursor === undefined
              ? {}
              : { after: cursor }),
          reason: "response-byte-cap" as const,
        }
      : undefined;
    byteLength = Buffer.byteLength(JSON.stringify({ episodes: kept }), "utf8");
    return {
      episodes: kept,
      byteLength,
      truncated,
      ...(continuation === undefined ? {} : { continuation }),
    };
  };
  let page = build();
  // The row budget is intentionally conservative, but the receipt fields and
  // continuation are part of the wire contract too. Trim the same direction
  // as the display mode until the serialized envelope itself fits.
  while (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_TRANSCRIPT_RESPONSE_BYTES && kept.length > 0) {
    kept = mode === "transcript" && opts.after === undefined ? kept.slice(1) : kept.slice(0, -1);
    truncated = true;
    page = build();
  }
  return page;
}

function boundedSearchPage(episodes: EpisodeView[], atoms: Atom[]): SearchPage {
  let kept = boundedEpisodePage(episodes, {}, "search", false, "search").episodes;
  let keptAtoms = atoms;
  // The SQL readers deliberately stop at the bounded best-first window. A
  // full window is an unknown lower bound, not proof that the collection ends
  // there, so carry a continuation receipt even when the aggregate envelope
  // itself has room for every returned row.
  let truncated = kept.length < episodes.length || episodes.length >= 40 || atoms.length >= 40;
  const build = (): SearchPage => {
    const payloadBytes = Buffer.byteLength(JSON.stringify({ episodes: kept, atoms: keptAtoms }), "utf8");
    const omitted = episodes.length - kept.length + (atoms.length - keptAtoms.length);
    return {
      episodes: kept,
      atoms: keptAtoms,
      byteLength: payloadBytes,
      truncated,
      ...(truncated || keptAtoms.length < atoms.length
        ? {
            continuation: {
              source: "search" as const,
              omittedLowerBound: Math.max(1, omitted),
              // Search is intentionally capped at the best 40 hits before the
              // aggregate byte cap, so lower-ranked hits may still exist.
              omittedUnknown: true,
              reason: "response-byte-cap" as const,
            },
          }
        : {}),
    };
  };
  let page = build();
  while (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_TRANSCRIPT_RESPONSE_BYTES) {
    if (keptAtoms.length > 0) {
      keptAtoms = keptAtoms.slice(0, -1);
    } else if (kept.length > 0) {
      kept = kept.slice(0, -1);
    } else {
      // The fixed receipt envelope is well below the cap; this branch is a
      // fail-closed guard if a future protocol field violates that contract.
      break;
    }
    truncated = true;
    page = build();
  }
  return page;
}

const DERIVED_ATOM_FETCH = 32;
const DERIVED_CAPSULE_FETCH = 64;
const DERIVED_LEDGER_FETCH = 128;

function derivedEnvelope<T extends Record<string, unknown>>(value: T): T & { byteLength: number } {
  let byteLength = 0;
  for (;;) {
    const candidate = { ...value, byteLength } as T & { byteLength: number };
    const measured = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (measured === byteLength) return candidate;
    byteLength = measured;
  }
}

function atomPageFrom(result: { atoms: AtomPage["atoms"]; hasMore: boolean; nextCursor?: string }): AtomPage {
  const envelope = {
    atoms: result.atoms,
    truncated: result.hasMore,
    hasMore: result.hasMore,
    ...(result.hasMore && result.nextCursor !== undefined
      ? { continuation: { cursor: result.nextCursor, reason: "page-cap" as const } }
      : {}),
  };
  const measured = derivedEnvelope(envelope);
  if (measured.byteLength > MAX_DERIVED_RESPONSE_BYTES) {
    throw Object.assign(new Error("The atom projection exceeded its response safety bound."), {
      status: 413,
      code: "derived_projection_too_large",
    });
  }
  return measured;
}

function capsulePageFrom(result: {
  capsules: CapsulePage["capsules"];
  hasMore: boolean;
  nextCursor?: string;
}): CapsulePage {
  const envelope = {
    capsules: result.capsules,
    truncated: result.hasMore,
    hasMore: result.hasMore,
    ...(result.hasMore && result.nextCursor !== undefined
      ? { continuation: { cursor: result.nextCursor, reason: "page-cap" as const } }
      : {}),
  };
  const measured = derivedEnvelope(envelope);
  if (measured.byteLength > MAX_DERIVED_RESPONSE_BYTES) {
    throw Object.assign(new Error("The capsule projection exceeded its response safety bound."), {
      status: 413,
      code: "derived_projection_too_large",
    });
  }
  return measured;
}

function ledgerPageFrom(result: {
  entries: LedgerPage["entries"];
  hasMore: boolean;
  nextCursor?: string;
}): LedgerPage {
  const envelope = {
    entries: result.entries,
    truncated: result.hasMore,
    hasMore: result.hasMore,
    ...(result.hasMore && result.nextCursor !== undefined
      ? { continuation: { cursor: result.nextCursor, reason: "page-cap" as const } }
      : {}),
  };
  const measured = derivedEnvelope(envelope);
  if (measured.byteLength > MAX_DERIVED_RESPONSE_BYTES) {
    throw Object.assign(new Error("The ledger projection exceeded its response safety bound."), {
      status: 413,
      code: "derived_projection_too_large",
    });
  }
  return measured;
}

function checkedPacket(packet: Packet): Packet {
  const serializedBytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
  if (serializedBytes > MAX_PACKET_RESPONSE_BYTES) {
    throw Object.assign(new Error("The packet response exceeds the raw-reader safety bound."), {
      status: 413,
      code: "packet_too_large",
    });
  }
  return packet;
}

export function bindCore(module: unknown, home: string): Kernel {
  const core = module as CoreModule;
  const vault = core.openVault({ home });
  return new CoreKernel(core, vault, home);
}

class CoreKernel implements Kernel {
  readonly backend = "core" as const;
  private readonly turns = new TurnQueue();

  constructor(
    private readonly core: CoreModule,
    private readonly vault: Vault,
    readonly home: string,
  ) {}

  private thread(threadId: ThreadId): { id: string; settings: Record<string, unknown> } {
    const thread = this.vault.threads.runtime(threadId);
    if (thread === null) {
      throw Object.assign(new Error("No such thread."), {
        status: 404,
        code: "thread_not_found",
      });
    }
    return thread;
  }

  private sourceReadinessForThread(threadId: ThreadId): ThreadSourceReadiness | undefined {
    const header = this.vault.threads.header(threadId);
    if (header === null) return undefined;
    // A short legacy tail may not have a durable migration row yet. Advance
    // exactly one bounded leaf before any mutation/provider boundary so an
    // offending row becomes a typed quarantine instead of a late 500.
    const readiness = this.vault.continueCapsuleSourceReadiness(threadId);
    // `pending` is an internal bounded migration audit. It must not make a
    // normal thread look quarantined or block a second append; only the
    // durable noncompactable marker is a product read-only boundary.
    return readiness?.status === "noncompactable" ? readiness : undefined;
  }

  private assertSourceReady(threadId: ThreadId): void {
    const readiness = this.sourceReadinessForThread(threadId);
    if (readiness === undefined) return;
    throw Object.assign(
      new Error(
        `Thread ${threadId} is quarantined at episode ${readiness.seq}: ${readiness.reason}. ` +
          "Forget the offending episode before starting a new turn.",
      ),
      { status: 409, code: "source_not_ready" },
    );
  }

  private assertCompactionReady(threadId: ThreadId): void {
    let current = this.core.stats(this.vault, threadId);
    if (current.compaction?.pending === true || current.compactionPending === true) {
      const budget = current.selectedBudget;
      if (this.core.compact !== undefined) {
        for (let pass = 0; pass < MAINTENANCE_PASSES; pass += 1) {
          this.core.compact(this.vault, threadId, { budget });
          current = this.core.stats(this.vault, threadId);
          if (current.compaction?.pending !== true && current.compactionPending !== true) break;
        }
      }
    }
    if (current.compaction?.pending === true || current.compactionPending === true) {
      throw Object.assign(
        new Error(
          `Thread ${threadId} is rebuilding its bounded archive index ` +
            `(sealed through episode ${current.compaction?.sealedThrough ?? 0} of ${current.compaction?.headSeq ?? current.turns}). Retry after maintenance advances.`,
        ),
        { status: 409, code: "compaction_pending" },
      );
    }
  }

  async listThreads(options: ThreadListOptions = {}): Promise<ThreadListPage> {
    const limit = Math.max(
      1,
      Math.min(Math.floor(options.limit ?? MAX_THREAD_LIST_ROWS), MAX_THREAD_LIST_ROWS),
    );
    const after = decodeThreadCursor(options.after);
    let page = this.vault.threads.listPage({
      ...(after === undefined ? {} : { after }),
      limit,
    });
    if (page.threads.length === 0 && after === undefined) {
      this.vault.threads.primary();
      page = this.vault.threads.listPage({ limit });
    }

    const archiveBytes = this.vault.archiveBytes();
    const projected: ThreadStats[] = [];
    let last: ThreadCursor | undefined;
    for (const [index, thread] of page.threads.entries()) {
      const stat = this.core.stats(this.vault, thread.id, { archiveBytes });
      const rowBytes = Buffer.byteLength(JSON.stringify(stat), "utf8");
      if (rowBytes > MAX_THREAD_LIST_ROW_BYTES) {
        throw Object.assign(new Error("A thread row exceeds the response safety bound."), {
          status: 500,
          code: "thread_row_too_large",
        });
      }
      const candidate = [...projected, stat];
      const candidateLast = { createdAt: thread.createdAt, id: thread.id };
      const candidateEnvelope = threadPageEnvelope(
        candidate,
        page.hasMore || index < page.threads.length - 1,
        candidateLast,
      );
      if (projected.length > 0 && candidateEnvelope.byteLength > MAX_THREAD_LIST_RESPONSE_BYTES) {
        break;
      }
      projected.push(stat);
      last = candidateLast;
    }

    const hasMore = page.hasMore || projected.length < page.threads.length;
    const envelope = threadPageEnvelope(projected, hasMore, last);
    if (envelope.byteLength > MAX_THREAD_LIST_RESPONSE_BYTES) {
      throw Object.assign(new Error("The thread list response exceeds its safety bound."), {
        status: 500,
        code: "thread_response_too_large",
      });
    }
    return envelope;
  }

  async createThread(title?: string): Promise<ThreadStats> {
    const created = this.vault.threads.create(title);
    return this.core.stats(this.vault, created.id);
  }

  async getThread(id: ThreadId): Promise<ThreadStats | undefined> {
    return this.vault.threads.runtime(id) === null ? undefined : this.core.stats(this.vault, id);
  }

  async stats(threadId: ThreadId): Promise<ThreadStats> {
    this.thread(threadId);
    return this.core.stats(this.vault, threadId);
  }

  async fragmentStatus(threadId: ThreadId): Promise<ThreadFragmentStatus | undefined> {
    this.thread(threadId);
    const fragment = this.vault.fragments.get(threadId);
    if (fragment === null) return undefined;
    return {
      readOnly: true,
      threadId: fragment.threadId,
      originalThreadId: fragment.originalThreadId,
      fromSeq: fragment.fromSeq,
      toSeq: fragment.toSeq,
      prevHash: fragment.prevHash,
      headHash: fragment.headHash,
      createdAt: fragment.createdAt,
    };
  }

  async sourceReadiness(threadId: ThreadId): Promise<ThreadSourceReadiness | undefined> {
    if (this.vault.threads.header(threadId) === null) {
      throw Object.assign(new Error("No such thread."), { status: 404, code: "thread_not_found" });
    }
    return this.sourceReadinessForThread(threadId);
  }

  async maintenance(threadId: ThreadId): Promise<ThreadStats> {
    this.assertSourceReady(threadId);
    const settings = this.thread(threadId).settings;
    if (this.core.compact === undefined) {
      throw Object.assign(new Error("bounded maintenance is unavailable in the loaded core"), {
        status: 503,
        code: "maintenance_unavailable",
      });
    }
    // Migration 029 audits at most one leaf per call. A pending result is
    // expected while the archive is large; a persisted noncompactable marker
    // is returned as a durable quarantine instead of becoming a 500.
    const sourceProgress = this.vault.continueCapsuleSourceReadiness(threadId);
    if (sourceProgress?.status === "noncompactable") return this.core.stats(this.vault, threadId);
    const budget = typeof settings.budget === "number" ? settings.budget : undefined;
    // Each request advances a fixed number of bounded passes. The client may
    // yield and call again; no request is allowed to scan the whole archive.
    for (let pass = 0; pass < MAINTENANCE_PASSES; pass += 1) {
      this.core.compact(this.vault, threadId, budget === undefined ? {} : { budget });
    }
    return this.core.stats(this.vault, threadId);
  }

  async demo(threadId: ThreadId): Promise<DemoSummary> {
    this.assertSourceReady(threadId);
    this.thread(threadId);
    const ticket = this.turns.enter(threadId);
    try {
      await ticket.ready();
      return await this.core.demo(this.vault, threadId);
    } finally {
      ticket.release();
    }
  }

  async demoSummary(threadId: ThreadId): Promise<DemoSummary | undefined> {
    this.thread(threadId);
    return this.core.readDemo(this.vault, threadId) ?? undefined;
  }

  async settings(threadId: ThreadId): Promise<ThreadSettings> {
    const settings = this.thread(threadId).settings;
    return {
      ...(typeof settings.model === "string" ? { model: settings.model } : {}),
      ...(typeof settings.budget === "number" ? { budget: settings.budget } : {}),
      ...(settings.shares === undefined ? {} : { shares: settings.shares as BudgetShares }),
    };
  }

  async setSettings(threadId: ThreadId, patch: ThreadSettings): Promise<void> {
    this.assertSourceReady(threadId);
    const current = this.thread(threadId).settings;
    this.vault.threads.setSettings(threadId, { ...current, ...patch });
  }

  async episodes(
    threadId: ThreadId,
    opts: { before?: Seq; after?: Seq; limit?: number },
  ): Promise<Episode[]> {
    this.thread(threadId);
    return (await this.episodesPage(threadId, opts)).episodes;
  }

  async episodesPage(
    threadId: ThreadId,
    opts: { before?: Seq; after?: Seq; limit?: number },
  ): Promise<EpisodePage> {
    this.thread(threadId);
    // Never hydrate all 5,000 requested rows. A capped SQL page is enough to
    // construct the response receipt; the next request carries the normal
    // before/after cursor and conservatively resumes from there.
    const requested = Math.max(1, Math.min(opts.limit ?? 100, 5_000));
    const fetchLimit = Math.min(requested, 64);
    const rows = this.vault.episodes.listBounded(
      threadId,
      { ...opts, limit: fetchLimit },
      DEMO_EVIDENCE_TEXT_LIMIT,
      TRANSCRIPT_META_LIMIT,
    );
    return boundedEpisodePage(
      rows,
      opts,
      "episode-page",
      requested > fetchLimit && rows.length >= fetchLimit,
    );
  }

  async episode(threadId: ThreadId, seq: Seq): Promise<EpisodeView | undefined> {
    this.thread(threadId);
    return (
      this.vault.episodes.getBounded(threadId, seq, DEMO_EVIDENCE_TEXT_LIMIT, TRANSCRIPT_META_LIMIT) ??
      undefined
    );
  }

  async search(threadId: ThreadId, query: string): Promise<SearchPage> {
    this.thread(threadId);
    const needle = query.trim().toLowerCase();
    const episodes =
      needle.length === 0
        ? []
        : this.vault.episodes.searchBounded(
            threadId,
            query,
            40,
            {},
            DEMO_EVIDENCE_TEXT_LIMIT,
            TRANSCRIPT_META_LIMIT,
          );
    const atoms =
      needle.length === 0
        ? []
        : this.vault.atoms.searchBounded(
            threadId,
            query,
            40,
            TRANSCRIPT_ATOM_TEXT_LIMIT,
            TRANSCRIPT_ATOM_TEXT_LIMIT,
          );
    return boundedSearchPage(episodes, atoms);
  }

  async packet(threadId: ThreadId, turnSeq: Seq): Promise<Packet | undefined> {
    const status = this.vault.packets.preflight(threadId, turnSeq);
    if (status === "oversized") {
      throw Object.assign(new Error("The packet exceeds the raw-reader safety bound."), {
        status: 413,
        code: "packet_too_large",
      });
    }
    if (status === "malformed") {
      throw Object.assign(new Error("The packet JSON is malformed."), {
        status: 422,
        code: "packet_malformed",
      });
    }
    if (status === "missing") return undefined;
    const packet = this.vault.packets.get(threadId, turnSeq);
    return packet === null ? undefined : checkedPacket(packet);
  }

  async packetById(threadId: ThreadId, packetId: string): Promise<Packet | undefined> {
    this.thread(threadId);
    const preflight = this.vault.packets.preflightById(packetId);
    // Ownership is decided from the scalar preflight row before exposing even
    // a malformed/oversized status for another thread's packet.
    if (preflight.status === "missing" || preflight.threadId !== threadId) return undefined;
    const status = preflight.status;
    if (status === "oversized") {
      throw Object.assign(new Error("The packet exceeds the raw-reader safety bound."), {
        status: 413,
        code: "packet_too_large",
      });
    }
    if (status === "malformed") {
      throw Object.assign(new Error("The packet JSON is malformed."), {
        status: 422,
        code: "packet_malformed",
      });
    }
    const packet = this.vault.packets.byId(packetId);
    return packet === null ? undefined : checkedPacket(packet);
  }

  async demoEpisode(threadId: ThreadId, seq: Seq): Promise<DemoEpisodeResource | undefined> {
    const thread = this.thread(threadId);
    if (thread.settings.demoVersion !== "proof-v1") return undefined;
    if (!Number.isSafeInteger(seq) || seq <= 0) return undefined;
    const episode = this.vault.episodes.getBounded(
      threadId,
      seq,
      DEMO_EVIDENCE_TEXT_LIMIT,
      TRANSCRIPT_META_LIMIT,
    );
    if (episode === null || episode === undefined) return undefined;
    const prefix = boundedText(episode.content, DEMO_EVIDENCE_TEXT_LIMIT);
    const text = prefix.text;
    if (episode.meta.removed === true || episode.locatorOmittedReason === "removed") {
      if (episode.originalContentHash === undefined) return undefined;
      const removalReceipt: DemoRemovalReceipt = {
        status: "tombstoned",
        contentAvailable: false,
        ...(typeof episode.meta.tombstone === "string" ? { tombstoneId: episode.meta.tombstone } : {}),
        originalContentHash: episode.originalContentHash,
        locatorOmittedReason: "removed",
      };
      return {
        kind: "episode",
        threadId,
        seq,
        role: episode.role,
        text,
        textBytes: Buffer.byteLength(text, "utf8"),
        byteLength: episode.contentBytes,
        textTruncated: episode.contentTruncated,
        chainHash: episode.hash,
        removed: true,
        removalReceipt,
      };
    }
    const contentHash = episode.locator?.contentHash;
    // The SQL projection ensures that this endpoint never hydrates a large
    // imported body merely to display a prefix. Metadata-truncated rows have
    // no source locator and fail closed rather than pretending to prove one.
    if (episode.locator === undefined || contentHash === undefined) return undefined;
    const authority = demoEpisodeAuthority(episode.role);
    return {
      kind: "episode",
      threadId,
      seq,
      role: episode.role,
      text,
      textBytes: Buffer.byteLength(text, "utf8"),
      byteLength: episode.contentBytes,
      textTruncated: episode.contentTruncated,
      chainHash: episode.hash,
      removed: false,
      locator: {
        source: `episode:${seq}`,
        byteRange: [0, Buffer.byteLength(text, "utf8")],
        contentHash,
        revision: episode.hash,
        ...(authority === undefined ? {} : { authority }),
      },
    };
  }

  async demoPacket(threadId: ThreadId, packetIdOrTurnSeq: string): Promise<DemoPacketReceipt | undefined> {
    const thread = this.thread(threadId);
    // This is a demo exhibit, not a second generic packet serialization path.
    // Keep arbitrary user answers on the raw X-ray endpoint, where clients have
    // explicitly opted into the full bounded-view payload.
    if (thread.settings.demoVersion !== "proof-v1") return undefined;
    const packet = /^[1-9]\d*$/u.test(packetIdOrTurnSeq)
      ? this.vault.packets.demo(threadId, Number(packetIdOrTurnSeq))
      : this.vault.packets.demoById(packetIdOrTurnSeq);
    if (packet === null || packet.threadId !== threadId) return undefined;
    const question = this.vault.episodes.getBounded(
      threadId,
      packet.turnSeq,
      DEMO_PACKET_TEXT_LIMIT,
      TRANSCRIPT_META_LIMIT,
    );
    if (question === null || question.role !== "user" || question.contentTruncated) return undefined;
    const answer = this.vault.episodes
      .listBounded(
        threadId,
        { after: packet.turnSeq, limit: DEMO_PACKET_SEARCH_LIMIT },
        DEMO_PACKET_TEXT_LIMIT,
        TRANSCRIPT_META_LIMIT,
      )
      .find((episode) => episode.role === "assistant" && episode.meta.packetId === packet.id);
    if (answer === undefined || answer.contentTruncated) {
      return undefined;
    }
    return toDemoPacketReceipt(threadId, packet, question, answer);
  }

  async demoRoute(threadId: ThreadId, routeId: string): Promise<DemoRouteResource | undefined> {
    const thread = this.thread(threadId);
    if (thread.settings.demoVersion !== "proof-v1") return undefined;
    const route = this.vault.addresses.get(threadId, routeId);
    if (route === null || route.threadId !== threadId) return undefined;
    return toDemoRouteResource(route);
  }

  async demoAttachmentSpan(
    threadId: ThreadId,
    seq: Seq,
    ordinal: number,
  ): Promise<DemoAttachmentSpanResource | undefined> {
    const thread = this.thread(threadId);
    if (thread.settings.demoVersion !== "proof-v1") return undefined;
    if (!Number.isSafeInteger(seq) || seq <= 0 || !Number.isSafeInteger(ordinal) || ordinal < 0) {
      return undefined;
    }
    // Attachment exhibits need only bounded metadata; never hydrate the
    // extracted text body merely to select one manifest span.
    const episode = this.vault.episodes.getBounded(threadId, seq, 0, TRANSCRIPT_META_LIMIT);
    if (episode === null || episode.role !== "attachment" || episode.meta.removed === true) return undefined;
    const manifest = episode.meta.manifest;
    const blob = typeof episode.meta.blob === "string" ? episode.meta.blob : undefined;
    const spans = manifest !== undefined && Array.isArray(manifest.spans) ? manifest.spans : undefined;
    const span = spans?.[ordinal];
    if (
      manifest === undefined ||
      blob === undefined ||
      span === undefined ||
      typeof span.from !== "number" ||
      typeof span.to !== "number" ||
      typeof span.objectHash !== "string" ||
      typeof span.hash !== "string"
    ) {
      return undefined;
    }
    const declaredLength = span.to - span.from;
    // Check the manifest-declared length before touching either the whole
    // object or the span object. A malformed manifest cannot turn this read
    // only exhibit into an unbounded file response.
    let partitionValid = false;
    try {
      partitionValid = this.core.manifestPartitionValid?.(manifest) === true;
    } catch {
      partitionValid = false;
    }
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > DEMO_ATTACHMENT_SPAN_LIMIT ||
      !partitionValid ||
      manifest.hash !== blob
    ) {
      return undefined;
    }
    const objectSize = this.vault.blobs.size(span.objectHash);
    if (objectSize === null || objectSize !== declaredLength || objectSize > DEMO_ATTACHMENT_SPAN_LIMIT) {
      return undefined;
    }
    const bytes = this.vault.blobs.get(span.objectHash);
    const hash = this.core.sha256;
    if (
      bytes === null ||
      hash === undefined ||
      bytes.byteLength !== declaredLength ||
      hash(bytes) !== span.objectHash ||
      hash(bytes) !== span.hash
    ) {
      return undefined;
    }
    return {
      threadId,
      seq,
      ordinal,
      manifestId: manifest.id,
      manifest,
      span,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      byteLength: bytes.byteLength,
      digest: span.hash,
    };
  }

  async atoms(threadId: ThreadId, phase?: AtomPhase): Promise<Atom[]> {
    return (await this.atomsPage(threadId, { ...(phase === undefined ? {} : { phase }) }))
      .atoms as unknown as Atom[];
  }

  async atomsPage(
    threadId: ThreadId,
    opts: { phase?: AtomPhase; after?: string; limit?: number } = {},
  ): Promise<AtomPage> {
    this.thread(threadId);
    const requested = Math.max(
      1,
      Math.min(Math.floor(opts.limit ?? MAX_ATOM_PAGE_ITEMS), MAX_ATOM_PAGE_ITEMS),
    );
    const result = this.vault.atoms.listBounded(threadId, {
      ...(opts.phase === undefined ? {} : { phase: opts.phase }),
      ...(opts.after === undefined ? {} : { after: opts.after }),
      limit: Math.min(requested, DERIVED_ATOM_FETCH),
    });
    return atomPageFrom(result);
  }

  async pinAtom(threadId: ThreadId, atomId: string, pinned: boolean): Promise<Atom | undefined> {
    this.assertSourceReady(threadId);
    this.thread(threadId);
    this.vault.atoms.pin(threadId, atomId, pinned);
    const atom = this.vault.atoms.getBounded(threadId, atomId);
    return atom === null ? undefined : (atom as unknown as Atom);
  }

  async capsules(threadId: ThreadId, level?: number): Promise<Capsule[]> {
    return (await this.capsulesPage(threadId, { ...(level === undefined ? {} : { level }) }))
      .capsules as unknown as Capsule[];
  }

  async capsulesPage(
    threadId: ThreadId,
    opts: { level?: number; after?: string; limit?: number } = {},
  ): Promise<CapsulePage> {
    this.thread(threadId);
    const requested = Math.max(
      1,
      Math.min(Math.floor(opts.limit ?? MAX_CAPSULE_PAGE_ITEMS), MAX_CAPSULE_PAGE_ITEMS),
    );
    const result = this.vault.capsules.listBounded(threadId, opts.level, {
      ...(opts.after === undefined ? {} : { after: opts.after }),
      limit: Math.min(requested, DERIVED_CAPSULE_FETCH),
    });
    return capsulePageFrom(result);
  }

  async ledger(threadId: ThreadId, opts: { name?: string; limit?: number }): Promise<LossEntry[]> {
    return (await this.ledgerPage(threadId, opts)).entries as unknown as LossEntry[];
  }

  async ledgerPage(
    threadId: ThreadId,
    opts: { name?: string; after?: string; limit?: number } = {},
  ): Promise<LedgerPage> {
    const stats = this.core.stats(this.vault, threadId);
    const requested = Math.max(
      1,
      Math.min(Math.floor(opts.limit ?? MAX_LEDGER_PAGE_ITEMS), MAX_LEDGER_PAGE_ITEMS),
    );
    const result = this.vault.losses.listBounded(threadId, {
      from: 1,
      to: Math.max(1, stats.turns),
      ...(opts.name === undefined ? {} : { name: opts.name }),
      ...(opts.after === undefined ? {} : { after: opts.after }),
      limit: Math.min(requested, DERIVED_LEDGER_FETCH),
    });
    return ledgerPageFrom(result);
  }

  async attach(threadId: ThreadId, files: AttachInput[]): Promise<Episode[]> {
    this.assertSourceReady(threadId);
    this.thread(threadId);
    const appended = this.vault.episodes.appendMany(
      threadId,
      files.map((file) => ({
        role: "attachment",
        content: extractText(file),
        // Let the kernel own whole-object and span writes.  Supplying only
        // `blob` keeps the upload path identical to turn attachments, so the
        // chain-covered manifest and hash-addressed chunks cannot be skipped
        // by an adapter-created legacy meta pointer.
        blob: { bytes: file.bytes, mime: file.mime, name: file.name },
      })),
    );
    // The archive write is exact, but the multipart response is an ordinary
    // reader surface. Rehydrate only the kernel's bounded EpisodeView for each
    // newly appended row so a legal 32 MiB upload cannot echo the whole file or
    // an oversized manifest back through JSON. The attachment route still
    // returns one projection per accepted file, preserving its array contract.
    return appended.map(
      (episode) =>
        this.vault.episodes.getBounded(
          threadId,
          episode.seq,
          DEMO_EVIDENCE_TEXT_LIMIT,
          TRANSCRIPT_META_LIMIT,
        ) ?? episode,
    );
  }

  /**
   * Switches the model an API client will run the next turn with. The divider is
   * written only if a model has already spoken and it was a different one — a
   * chip moved before anyone spoke divides nothing (KERNEL §6).
   */
  async handoff(threadId: ThreadId, model: string, provider: ProviderId): Promise<Episode | undefined> {
    this.assertSourceReady(threadId);
    const settings = this.thread(threadId).settings;
    const spoke = this.lastSpokenModel(threadId);
    if (spoke === undefined) {
      throw Object.assign(new Error("No model has spoken in this thread yet."), {
        status: 409,
        code: "no_speaker",
      });
    }
    this.vault.threads.setSettings(threadId, { ...settings, model, provider });
    return spoke === model ? undefined : this.appendHandoff(threadId, spoke, model);
  }

  /**
   * The divider sentence reads in plain names; `meta` keeps the exact model ids
   * so the transcript and the model list stay machine-checkable.
   */
  private appendHandoff(threadId: ThreadId, from: string, to: string): Episode {
    return this.vault.episodes.append(threadId, {
      role: "handoff",
      content: `${shortName(from)} stopped here. ${shortName(to)} continued from the same thread.`,
      meta: { from, to },
    });
  }

  /**
   * The model that last spoke here, read from the archive rather than from the
   * thread's settings: settings record what was asked for, and a turn that never
   * reached a model must not look like a speaker. Attachments, tool results and
   * removals are stepped over by the kernel's indexed newest-assistant query;
   * the server never hydrates archive content or metadata for this decision.
   */
  private lastSpokenModel(threadId: ThreadId): string | undefined {
    return this.vault.episodes.lastSpokenModel(threadId);
  }

  async forget(threadId: ThreadId, target: ForgetTarget): Promise<ForgetOutcome> {
    this.thread(threadId);
    const result = this.core.forget(this.vault, threadId, target);
    return {
      tombstoneId: result.tombstoneId,
      removalSeq: result.removalSeq,
      echoes: result.echoes,
      capsules: result.capsules,
      packets: result.packets,
      blobs: result.blobs.length,
      cleanupPending: result.cleanupPending,
    };
  }

  async exportBundle(
    threadId: ThreadId,
    opts: { passphrase: string; range?: [Seq, Seq] },
  ): Promise<Uint8Array> {
    this.thread(threadId);
    return this.core.exportBundle(this.vault, threadId, opts);
  }

  async exportBundleStream(
    threadId: ThreadId,
    opts: { passphrase: string; range?: [Seq, Seq] },
  ): Promise<ReadableStream<Uint8Array>> {
    this.thread(threadId);
    if (this.core.exportBundleStream === undefined) {
      throw new Error("stream-native bundle export is unavailable in the loaded core");
    }
    return this.core.exportBundleStream(this.vault, threadId, opts);
  }

  /**
   * A thread's hash chain is seeded from its id, so a bundle can only be
   * restored under that id. Importing one this vault already holds is refused
   * rather than silently re-identified into an unverifiable copy.
   */
  async importBundle(data: Uint8Array, passphrase: string): Promise<ThreadStats> {
    let result: { threadId: string };
    try {
      result = await this.core.importBundle(this.vault, data, { passphrase });
    } catch (error) {
      throw importError(error);
    }
    return this.core.stats(this.vault, result.threadId);
  }

  async importBundleStream(stream: ReadableStream<Uint8Array>, passphrase: string): Promise<ThreadStats> {
    let result: { threadId: string };
    try {
      if (this.core.importBundleStream !== undefined) {
        result = await this.core.importBundleStream(this.vault, stream, { passphrase });
      } else {
        throw new Error("stream-native bundle import is unavailable in the loaded core");
      }
    } catch (error) {
      throw importError(error);
    }
    return this.core.stats(this.vault, result.threadId);
  }

  async verify(threadId: ThreadId): Promise<ThreadVerification> {
    this.thread(threadId);
    return this.core.verify(this.vault, threadId, { full: true });
  }

  /**
   * The thread must exist before a slot is claimed for it, so a turn on a thread
   * that is not there is a `404` rather than a place in a queue nobody owns.
   */
  enterTurn(threadId: ThreadId): Ticket {
    this.assertSourceReady(threadId);
    this.thread(threadId);
    this.assertCompactionReady(threadId);
    return this.turns.enter(threadId);
  }

  /**
   * Streams the turn once the turns ahead of it have committed, on the lane the
   * route already claimed. Without a ticket the slot is claimed here — a full
   * queue is a `429` before the caller has opened a stream.
   */
  runTurn(
    threadId: ThreadId,
    input: TurnInput,
    provider: ProviderFn,
    ticket?: Ticket,
  ): AsyncIterable<TurnEvent> {
    this.assertSourceReady(threadId);
    this.thread(threadId);
    return this.streamTurn(ticket ?? this.turns.enter(threadId), threadId, input, provider);
  }

  /**
   * The kernel emits `TurnEvent`s through a callback and resolves when the turn
   * commits; the HTTP layer wants an async iterable. This is that bridge, with
   * a bounded queue so a slow client cannot stall the kernel's transaction.
   */
  private async *streamTurn(
    ticket: Ticket,
    threadId: ThreadId,
    input: TurnInput,
    provider: ProviderFn,
  ): AsyncGenerator<TurnEvent> {
    try {
      await ticket.ready(input.signal);
      if (input.signal?.aborted === true) return;
      // Recheck after waiting: a queued request must not write settings after
      // an older turn exposes a legacy noncompactable source tail.
      this.assertSourceReady(threadId);
      // A queued/direct caller must also wait for bounded capsule backfill;
      // this check runs before settings, handoff, or provider work.
      this.assertCompactionReady(threadId);
      // Inside the lane: the thread's model and budget are read, merged and
      // written where no other turn on this thread can come between them.
      await this.setSettings(threadId, { model: input.model, budget: input.budget });
      // The divider belongs to the turn that changes speaker, not to the moment
      // a model was picked: it is written here, once a model has spoken and the
      // next turn is going to a different one (KERNEL §6).
      const spoke = this.lastSpokenModel(threadId);
      if (spoke !== undefined && spoke !== input.model) {
        yield { type: "episode", episode: this.appendHandoff(threadId, spoke, input.model) };
      }
      yield* this.turnEvents(threadId, input, provider);
    } finally {
      ticket.release();
    }
  }

  private async *turnEvents(
    threadId: ThreadId,
    input: TurnInput,
    provider: ProviderFn,
  ): AsyncGenerator<TurnEvent> {
    const queue: TurnEvent[] = [];
    let notify: (() => void) | undefined;
    let finished = false;
    let failure: unknown;
    let kernelErrorEmitted = false;
    /** The kernel rethrows a plain Error; this keeps the provider's own code. */
    let providerFailure: unknown;

    const push = (event: TurnEvent): void => {
      if (event.type === "error") kernelErrorEmitted = true;
      queue.push(event);
      notify?.();
    };

    const running = this.core
      .runTurn(this.vault, threadId, {
        text: input.text,
        model: input.model,
        providerId: input.provider,
        budget: input.budget,
        supportsTools: input.supportsTools !== false,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        onEvent: push,
        provider: (request: CoreProviderRequest) =>
          adaptProvider(provider, request, input.model, (error) => {
            providerFailure = error;
          }),
      })
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        finished = true;
        notify?.();
      });

    try {
      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift();
          if (event !== undefined) yield event;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = undefined;
            resolve();
          };
        });
      }
    } finally {
      // A client that leaves mid-turn does not release the thread: the kernel's
      // transactions finish before the next turn on this thread may start.
      await running;
    }
    // The kernel's typed error event is the one wire failure. Re-throw only
    // failures that happened before the kernel could emit one; otherwise native
    // and gateway streams would each receive the same failure twice.
    if (failure !== undefined && !kernelErrorEmitted) throw providerFailure ?? failure;
  }

  async close(): Promise<void> {
    this.vault.close();
  }
}

/** Translates the server's provider stream into the kernel's event vocabulary. */
async function* adaptProvider(
  provider: ProviderFn,
  request: CoreProviderRequest,
  fallbackModel: string,
  onFailure: (error: unknown) => void,
): AsyncGenerator<CoreProviderEvent> {
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    const stream = provider(request.messages as never, {
      model: request.model.length > 0 ? request.model : fallbackModel,
      ...(request.tools.length === 0 ? {} : { tools: request.tools }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.maxOutputBytes === undefined
        ? {}
        : {
            maxOutputBytes: request.maxOutputBytes,
            maxOutputScope: request.maxOutputScope ?? "round",
            maxOutputReportedBytes: request.maxOutputReportedBytes ?? request.maxOutputBytes,
            // A cooperative provider may stop earlier, but the byte meter in
            // core remains authoritative when this hint is ignored.
            maxTokens: Math.max(1, Math.min(8192, Math.floor(request.maxOutputBytes / 4))),
          }),
    });
    for await (const event of stream as AsyncIterable<ServerProviderEvent>) {
      if (event.type === "delta") {
        yield { type: "delta", text: event.text };
      } else if (event.type === "tool_call") {
        yield { type: "tool_call", id: event.id, name: event.name, arguments: event.args };
      } else if (event.type === "usage") {
        usage = { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens };
      }
    }
    yield usage === undefined ? { type: "done" } : { type: "done", usage };
  } catch (error) {
    onFailure(error);
    const candidate = error as { message?: string; code?: string };
    yield {
      type: "error",
      message: candidate.message ?? "The provider failed.",
      ...(candidate.code === undefined ? {} : { code: candidate.code }),
    };
  }
}

function toDemoRouteResource(route: CoreAddressRoute): DemoRouteResource {
  return {
    id: route.id,
    threadId: route.threadId,
    queryDigest: route.queryDigest,
    normalizedQuery: route.normalizedQuery,
    routerVersion: route.routerVersion,
    questionSeq: route.questionSeq,
    ...(route.answerSeq === undefined ? {} : { answerSeq: route.answerSeq }),
    ...(route.packetId === undefined ? {} : { packetId: route.packetId }),
    ...(route.packetDigest === undefined ? {} : { packetDigest: route.packetDigest }),
    sourceSeqs: [...route.sourceSeqs],
    witnesses: route.witnesses.map((witness) => ({
      seq: witness.seq,
      source: witness.source ?? `episode:${witness.seq}`,
      byteRange: [...witness.byteRange] as [number, number],
      contentHash: witness.contentHash,
      ...(witness.spanHash === undefined ? {} : { spanHash: witness.spanHash }),
      ...(witness.manifestId === undefined ? {} : { manifestId: witness.manifestId }),
      ...(witness.revision === undefined ? {} : { revision: witness.revision }),
      authority: witness.authority,
    })),
    routeDigest: route.routeDigest,
    status: route.status,
    storedStatus: route.storedStatus,
    effectiveStatus: route.effectiveStatus,
    asOfSeq: route.asOfSeq,
    ...(route.reason === undefined ? {} : { reason: route.reason }),
    // The kernel keeps `invalidatedBy`/`closedBy` as append-only storage and
    // current-projection vocabulary.  Never leak those directional names
    // through the bounded demo resource: an event closes its parent route,
    // while a parent is closed by a later event.
    ...(route.invalidatedBy === undefined ? {} : { closesRouteId: route.invalidatedBy }),
    ...(route.closedBy === undefined ? {} : { closedByRouteId: route.closedBy }),
    createdAt: route.createdAt,
  };
}

function demoEpisodeAuthority(
  role: Episode["role"],
): NonNullable<DemoEpisodeResource["locator"]>["authority"] {
  if (role === "user") return "user";
  if (role === "tool") return "tool";
  if (role === "attachment") return "attachment";
  if (role === "assistant") return "assistant";
  return undefined;
}

function toDemoPacketReceipt(
  threadId: ThreadId,
  packet: Packet,
  question: Episode,
  answer: Episode,
): DemoPacketReceipt {
  const apiRoot = `/api/threads/${encodeURIComponent(threadId)}`;
  const pages = packet.pages.slice(0, DEMO_PACKET_PAGE_LIMIT);
  const coverage = packet.coverage === undefined ? undefined : toDemoPacketCoverage(apiRoot, packet.coverage);
  return {
    id: packet.id,
    threadId,
    turnSeq: packet.turnSeq,
    digest: packet.digest,
    status: packet.status ?? "done",
    question: {
      seq: question.seq,
      text: question.content,
      href: `${apiRoot}/episodes/${question.seq}`,
    },
    answer: {
      seq: answer.seq,
      text: answer.content,
      href: `${apiRoot}/episodes/${answer.seq}`,
    },
    pages,
    pageCount: packet.pages.length,
    pagesTruncated: packet.pages.length > DEMO_PACKET_PAGE_LIMIT,
    ...(coverage === undefined ? {} : { coverage }),
    ...(packet.answerReceipt === undefined
      ? {}
      : { answerReceipt: toDemoAnswerReceipt(packet.answerReceipt) }),
    rawPacket: `${apiRoot}/packets/${encodeURIComponent(packet.id)}`,
  };
}

function toDemoAnswerReceipt(receipt: NonNullable<Packet["answerReceipt"]>): DemoAnswerReceipt {
  const candidates = receipt.candidates.slice(0, DEMO_PACKET_CLAIM_LIMIT);
  const classifications = receipt.classifications.slice(0, DEMO_PACKET_CLAIM_LIMIT).map((entry) => {
    const { capabilityDigests, ...projected } = entry;
    return { ...projected, capabilityDigestCount: capabilityDigests.length };
  });
  return {
    answerDigest: receipt.answerDigest,
    scanDigest: receipt.scanDigest,
    packetDigest: receipt.packetDigest,
    roundsDigest: receipt.roundsDigest,
    ...(receipt.coverageDigest === undefined ? {} : { coverageDigest: receipt.coverageDigest }),
    ...(receipt.coverageRouterVersion === undefined
      ? {}
      : { coverageRouterVersion: receipt.coverageRouterVersion }),
    ...(receipt.coverageRoutesRun === undefined ? {} : { coverageRoutesRun: receipt.coverageRoutesRun }),
    grammarVersion: receipt.grammarVersion,
    qualifications: [...receipt.qualifications],
    status: receipt.status,
    digest: receipt.digest,
    candidates,
    ...(receipt.candidateOverflow === undefined ? {} : { candidateOverflow: receipt.candidateOverflow }),
    candidateCount: receipt.candidates.length,
    candidatesTruncated: receipt.candidates.length > DEMO_PACKET_CLAIM_LIMIT,
    classifications,
    classificationCount: receipt.classifications.length,
    classificationsTruncated: receipt.classifications.length > DEMO_PACKET_CLAIM_LIMIT,
  };
}

function toDemoPacketCoverage(
  apiRoot: string,
  coverage: NonNullable<Packet["coverage"]>,
): DemoPacketCoverage {
  const routes = coverage.routes.slice(0, DEMO_PACKET_ROUTE_LIMIT).map((locator) => {
    const match = /^episode:(\d+)$/u.exec(locator.source);
    const href = match === null ? undefined : `${apiRoot}/episodes/${match[1]}`;
    return {
      ...locator,
      ...(href === undefined ? {} : { href }),
    };
  });
  return {
    cue: coverage.cue,
    querySeq: coverage.querySeq,
    asOfSeq: coverage.asOfSeq,
    routerVersion: coverage.routerVersion,
    routesRun: coverage.routesRun,
    ...(coverage.required === undefined ? {} : { required: coverage.required }),
    located: coverage.located,
    supported: coverage.supported,
    historical: coverage.historical,
    ...(coverage.unresolved === undefined ? {} : { unresolved: coverage.unresolved }),
    completeness: coverage.completeness,
    routes,
    basis: coverage.basis,
    digest: coverage.digest,
    routeCount: coverage.routes.length,
    routesTruncated: coverage.routes.length > DEMO_PACKET_ROUTE_LIMIT,
  };
}

/** A bundle that will not open is the caller's problem, not a server fault. */
function importError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/already exists/i.test(message)) {
    return Object.assign(new Error("This thread is already in your vault. Its archive is bound to its id."), {
      status: 409,
      code: "import_duplicate",
    });
  }
  const unopenable = /passphrase|decrypt|not a \.pylos|magic|manifest|chain|verif|unsupported/i.test(message);
  return Object.assign(new Error(message), {
    status: unopenable ? 422 : 500,
    code: unopenable ? "import_refused" : "import_failed",
  });
}

function extractText(file: AttachInput): string {
  const textual = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml))/.test(file.mime);
  if (textual || /\.(md|txt|ts|tsx|js|json|py|rs|go|css|html|yml|yaml|toml|csv)$/i.test(file.name)) {
    try {
      // Replacement characters are not evidence. If a nominally textual file
      // is not valid UTF-8, keep only the custody label below so arbitrary
      // bytes (including a later ASCII secret) cannot enter episode content or
      // FTS through a lossy decoder.
      return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes).slice(0, 200_000);
    } catch {
      return `⟦opaque attachment · ${file.name} · ${file.mime} · ${file.bytes.byteLength} bytes⟧`;
    }
  }
  return `⟦binary attachment · ${file.name} · ${file.mime} · ${file.bytes.byteLength} bytes⟧`;
}

function shortName(model: string): string {
  if (/^grok/i.test(model)) return "Grok";
  if (/^claude/i.test(model)) return "Claude";
  if (/^(gpt|o[1-9])/i.test(model)) return "GPT";
  return model.split(/[:/]/)[0] ?? model;
}
