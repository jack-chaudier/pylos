import type {
  Atom,
  AtomPhase,
  Capsule,
  Episode,
  LossEntry,
  Packet,
  ProviderId,
  Seq,
  ThreadId,
  ThreadStats,
  TurnEvent,
} from "@pylos/protocol";
import { pylosHome } from "./home.ts";
import type { ProviderFn } from "./providers/types.ts";

export interface TurnInput {
  text: string;
  model: string;
  provider: ProviderId;
  budget: number;
  attachmentSeqs?: Seq[];
  /** KERNEL A4: a toolless model gets a different view contract and one more page. */
  supportsTools?: boolean;
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
}

/**
 * Everything the server needs from `@pylos/core` (KERNEL.md §9), behind one
 * interface so the HTTP layer never depends on the kernel's internals.
 */
export interface Kernel {
  readonly home: string;
  readonly backend: "core";
  listThreads(): Promise<ThreadStats[]>;
  createThread(title?: string): Promise<ThreadStats>;
  getThread(id: ThreadId): Promise<ThreadStats | undefined>;
  episodes(threadId: ThreadId, opts: { before?: Seq; after?: Seq; limit?: number }): Promise<Episode[]>;
  episode(threadId: ThreadId, seq: Seq): Promise<Episode | undefined>;
  search(threadId: ThreadId, query: string): Promise<{ episodes: Episode[]; atoms: Atom[] }>;
  packet(threadId: ThreadId, turnSeq: Seq): Promise<Packet | undefined>;
  atoms(threadId: ThreadId, phase?: AtomPhase): Promise<Atom[]>;
  pinAtom(threadId: ThreadId, atomId: string, pinned: boolean): Promise<Atom | undefined>;
  capsules(threadId: ThreadId, level?: number): Promise<Capsule[]>;
  ledger(threadId: ThreadId, opts: { name?: string; limit?: number }): Promise<LossEntry[]>;
  runTurn(threadId: ThreadId, input: TurnInput, provider: ProviderFn): AsyncIterable<TurnEvent>;
  attach(threadId: ThreadId, files: AttachInput[]): Promise<Episode[]>;
  handoff(threadId: ThreadId, model: string, provider: ProviderId): Promise<Episode>;
  forget(threadId: ThreadId, target: ForgetTarget): Promise<{ tombstoneId: string }>;
  exportBundle(threadId: ThreadId, opts: { passphrase: string; range?: [Seq, Seq] }): Promise<Uint8Array>;
  importBundle(data: Uint8Array, passphrase: string): Promise<ThreadStats>;
  verify(threadId: ThreadId): Promise<{ ok: boolean; headHash: string; checkedTo: Seq }>;
  stats(threadId: ThreadId): Promise<ThreadStats>;
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
