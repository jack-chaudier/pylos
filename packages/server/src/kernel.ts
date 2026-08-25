import type {
  Atom,
  AtomPage,
  AtomPhase,
  BudgetShares,
  Capsule,
  CapsulePage,
  DemoAttachmentSpanResource,
  DemoEpisodeResource,
  DemoPacketReceipt,
  DemoRouteResource,
  DemoSummary,
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
  TurnEvent,
} from "@pylos/protocol";
import { pylosHome } from "./home.ts";
import type { ProviderFn } from "./providers/types.ts";
import type { Ticket } from "./turn-queue.ts";

export interface TurnInput {
  text: string;
  model: string;
  provider: ProviderId;
  budget: number;
  /** KERNEL A4: a toolless model gets a different view contract and one more page. */
  supportsTools?: boolean;
  /** The request's signal: a turn still waiting for the thread gives up when the client does. */
  signal?: AbortSignal;
}

export interface AttachInput {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ForgetTarget {
  seqs?: Seq[];
  atomIds?: string[];
  reason?: string;
}

export interface ThreadSettings {
  model?: string;
  budget?: number;
  shares?: BudgetShares;
}

/**
 * The authenticated boundary of a partial bundle.  A fragment is useful as a
 * read-only archive, but it is not a new genesis chain that the server may
 * append to or edit.
 */
export interface ThreadFragmentStatus {
  readOnly: true;
  threadId: ThreadId;
  originalThreadId: ThreadId;
  fromSeq: Seq;
  toSeq: Seq;
  prevHash: string;
  headHash: string;
  createdAt: number;
}

export interface ThreadVerification {
  ok: boolean;
  headHash: string;
  checkedTo: Seq;
  checkedFrom?: Seq;
  failedAt?: Seq;
  reason?: string;
  fragmentVerified?: boolean;
  fragment?: Pick<ThreadFragmentStatus, "originalThreadId" | "fromSeq" | "toSeq" | "prevHash" | "headHash">;
}

/** What a removal did, and what it deliberately left alone (KERNEL A10.6). */
export interface ForgetOutcome {
  tombstoneId: string;
  /** Seq of the `system` episode that records the removal in the chain. */
  removalSeq: Seq;
  /** Assistant turns that restated the removed text. Never removed on a guess. */
  echoes: Seq[];
  /** Capsules whose text was re-derived over the surviving source. */
  capsules: number;
  /** Packets whose `messages` were cleared; their receipts stay. */
  packets: number;
  /** Attachment blobs deleted because nothing surviving referenced them. */
  blobs: number;
  /** True when SQLite committed but object cleanup remains in a durable journal. */
  cleanupPending: boolean;
}

/**
 * Everything the server needs from `@pylos/core` (KERNEL.md §9), behind one
 * interface so the HTTP layer never depends on the kernel's internals.
 */
export interface Kernel {
  readonly home: string;
  readonly backend: "core";
  listThreads(options?: ThreadListOptions): Promise<ThreadListPage>;
  createThread(title?: string): Promise<ThreadStats>;
  getThread(id: ThreadId): Promise<ThreadStats | undefined>;
  episodes(threadId: ThreadId, opts: { before?: Seq; after?: Seq; limit?: number }): Promise<Episode[]>;
  episodesPage(threadId: ThreadId, opts: { before?: Seq; after?: Seq; limit?: number }): Promise<EpisodePage>;
  episode(threadId: ThreadId, seq: Seq): Promise<EpisodeView | undefined>;
  search(threadId: ThreadId, query: string): Promise<SearchPage>;
  packet(threadId: ThreadId, turnSeq: Seq): Promise<Packet | undefined>;
  packetById(threadId: ThreadId, packetId: string): Promise<Packet | undefined>;
  /** Bounded proof exhibit for an exact episode locator; never returns raw content. */
  demoEpisode(threadId: ThreadId, seq: Seq): Promise<DemoEpisodeResource | undefined>;
  demoPacket(threadId: ThreadId, packetIdOrTurnSeq: string): Promise<DemoPacketReceipt | undefined>;
  demoRoute(threadId: ThreadId, routeId: string): Promise<DemoRouteResource | undefined>;
  demoAttachmentSpan(
    threadId: ThreadId,
    seq: Seq,
    ordinal: number,
  ): Promise<DemoAttachmentSpanResource | undefined>;
  atoms(threadId: ThreadId, phase?: AtomPhase): Promise<Atom[]>;
  atomsPage(
    threadId: ThreadId,
    opts?: { phase?: AtomPhase; after?: string; limit?: number },
  ): Promise<AtomPage>;
  pinAtom(threadId: ThreadId, atomId: string, pinned: boolean): Promise<Atom | undefined>;
  capsules(threadId: ThreadId, level?: number): Promise<Capsule[]>;
  capsulesPage(
    threadId: ThreadId,
    opts?: { level?: number; after?: string; limit?: number },
  ): Promise<CapsulePage>;
  ledger(threadId: ThreadId, opts: { name?: string; limit?: number }): Promise<LossEntry[]>;
  ledgerPage(
    threadId: ThreadId,
    opts?: { name?: string; after?: string; limit?: number },
  ): Promise<LedgerPage>;
  /**
   * Claims this thread's place in the turn queue, synchronously, so a route can
   * take it the moment the request arrives and hand it to `runTurn` later. A
   * full queue throws `429 thread_busy` from here; the caller owns the ticket
   * until it passes it on, and must release it if it never does.
   */
  enterTurn(threadId: ThreadId): Ticket;
  /**
   * Turns on one thread are serialized, in the order they claimed their place.
   * Without a ticket this claims one itself — a full queue throws
   * `429 thread_busy` before the caller has opened a stream. The turn records
   * its model and budget as the thread's settings once it holds the lane.
   */
  runTurn(
    threadId: ThreadId,
    input: TurnInput,
    provider: ProviderFn,
    ticket?: Ticket,
  ): AsyncIterable<TurnEvent>;
  attach(threadId: ThreadId, files: AttachInput[]): Promise<Episode[]>;
  /**
   * Switches the thread's model and writes the divider — but only when a model
   * has already spoken and it was a different one. `undefined` means the thread
   * is already on this model; no assistant turn at all is `409 no_speaker`.
   * An ordinary turn writes its own divider, so this is for API clients.
   */
  handoff(threadId: ThreadId, model: string, provider: ProviderId): Promise<Episode | undefined>;
  forget(threadId: ThreadId, target: ForgetTarget): Promise<ForgetOutcome>;
  exportBundle(threadId: ThreadId, opts: { passphrase: string; range?: [Seq, Seq] }): Promise<Uint8Array>;
  exportBundleStream(
    threadId: ThreadId,
    opts: { passphrase: string; range?: [Seq, Seq] },
  ): Promise<ReadableStream<Uint8Array>>;
  importBundle(data: Uint8Array, passphrase: string): Promise<ThreadStats>;
  importBundleStream(stream: ReadableStream<Uint8Array>, passphrase: string): Promise<ThreadStats>;
  verify(threadId: ThreadId): Promise<ThreadVerification>;
  stats(threadId: ThreadId): Promise<ThreadStats>;
  /** Read-only fragment marker; absence means ordinary mutable thread. */
  fragmentStatus(threadId: ThreadId): Promise<ThreadFragmentStatus | undefined>;
  /** Legacy source quarantine marker; absence means new turns are admissible. */
  sourceReadiness(threadId: ThreadId): Promise<ThreadSourceReadiness | undefined>;
  /** Advance a fixed bounded number of derived-index passes and return progress. */
  maintenance(threadId: ThreadId): Promise<ThreadStats>;
  /** Seed the deterministic receipt-backed proof thread on an empty thread. */
  demo(threadId: ThreadId): Promise<DemoSummary>;
  /** Read a persisted proof thread without seeding or mutating the vault. */
  demoSummary(threadId: ThreadId): Promise<DemoSummary | undefined>;
  settings(threadId: ThreadId): Promise<ThreadSettings>;
  setSettings(threadId: ThreadId, patch: ThreadSettings): Promise<void>;
  close(): Promise<void>;
}

type CoreModule = { createKernel?: (home: string) => Kernel | Promise<Kernel> } & Record<string, unknown>;

let staticCore: CoreModule | undefined;

/**
 * Lets the sidecar build statically bundle `@pylos/core` (a bare dynamic
 * `import()` of a computed specifier is not bundleable).
 */
export function registerCore(module: CoreModule): void {
  staticCore = module;
}

export interface OpenKernelOptions {
  home?: string;
}

export async function openKernel(options: OpenKernelOptions = {}): Promise<Kernel> {
  const home = options.home ?? pylosHome();
  const core = staticCore ?? (await loadCore());
  if (core === undefined) {
    throw new Error("`@pylos/core` could not be loaded. Run `bun install` at the repository root.");
  }
  const adapted = await adaptCore(core, home);
  if (adapted === undefined) {
    throw new Error("`@pylos/core` does not expose the kernel surface this server expects.");
  }
  return adapted;
}

async function loadCore(): Promise<CoreModule | undefined> {
  const specifier = "@pylos/core";
  try {
    return (await import(/* @vite-ignore */ specifier)) as CoreModule;
  } catch {
    return undefined;
  }
}

/**
 * `@pylos/core` is being built concurrently. When it exposes a `createKernel`
 * adapter we use it directly; otherwise we bind the §9 surface by name. Any
 * shape we do not recognise falls back to the harness rather than half-working.
 */
async function adaptCore(core: CoreModule, home: string): Promise<Kernel | undefined> {
  if (typeof core.createKernel === "function") return core.createKernel(home);
  if (typeof core.openVault !== "function") return undefined;
  const { bindCore } = await import("./core-adapter.ts");
  return bindCore(core, home);
}
