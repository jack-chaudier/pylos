/**
 * Binds `@pylos/core` (KERNEL §9) to the server's `Kernel` interface.
 *
 * The kernel is synchronous over `bun:sqlite`; the server is async. This file
 * is the only place that seam exists, and the only place that knows the kernel
 * is SQLite at all.
 */
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
  ToolDef,
  TurnEvent,
} from "@pylos/protocol";
import type {
  AttachInput,
  ForgetTarget,
  Kernel,
  ThreadSettings,
  TurnInput,
} from "./kernel.ts";
import type { ProviderEvent as ServerProviderEvent, ProviderFn } from "./providers/types.ts";

// The kernel's own vocabulary, structurally typed so the server never imports
// its concrete classes at type level (the module is loaded dynamically).
interface CoreProviderRequest {
  model: string;
  messages: unknown[];
  tools: ToolDef[];
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
    list(): Array<{ id: string }>;
    primary(): { id: string };
    setSettings(id: string, settings: Record<string, unknown>): void;
    setTitle(id: string, title: string): void;
  };
  episodes: {
    append(threadId: string, input: Record<string, unknown>): Episode;
    appendMany(threadId: string, inputs: Array<Record<string, unknown>>): Episode[];
    get(threadId: string, seq: Seq): Episode | null;
    list(threadId: string, opts: { before?: Seq; after?: Seq; limit?: number }): Episode[];
    search(threadId: string, query: string, limit?: number): Episode[];
  };
  blobs: { put(bytes: Uint8Array, mime?: string): string };
  atoms: {
    list(threadId: string, opts: { phase?: AtomPhase; limit?: number }): Atom[];
    get(id: string): Atom | null;
    pin(threadId: string, atomId: string, pinned: boolean): void;
  };
  capsules: { list(threadId: string, level?: number, limit?: number): Capsule[] };
  losses: {
    byName(threadId: string, name: string, limit?: number): LossEntry[];
    inRange(threadId: string, from: Seq, to: Seq, limit?: number): LossEntry[];
  };
  packets: { get(threadId: string, turnSeq: Seq): Packet | null; last(threadId: string): Packet | null };
}

interface CoreModule {
  openVault(options?: { home?: string }): Vault;
  runTurn(
    vault: Vault,
    threadId: string,
    options: Record<string, unknown>,
  ): Promise<{ assistantEpisode: Episode; usage?: unknown }>;
  handoff(vault: Vault, threadId: string, from: string, to: string): Episode;
  forget(
    vault: Vault,
    threadId: string,
    target: ForgetTarget,
  ): { tombstoneId: string };
  stats(vault: Vault, threadId: string, options?: { verify?: boolean }): ThreadStats;
  verify(
    vault: Vault,
    threadId: string,
    options?: { full?: boolean },
  ): { ok: boolean; headHash: string; checkedTo: Seq };
  exportBundle(
    vault: Vault,
    threadId: string,
    options: { passphrase: string; range?: [Seq, Seq] },
  ): Promise<Uint8Array>;
  importBundle(
    vault: Vault,
    bytes: Uint8Array,
    options: { passphrase: string; threadId?: string },
  ): Promise<{ threadId: string }>;
}

export function bindCore(module: unknown, home: string): Kernel {
  const core = module as CoreModule;
  const vault = core.openVault({ home });
  return new CoreKernel(core, vault, home);
}

class CoreKernel implements Kernel {
  readonly backend = "core" as const;

  constructor(
    private readonly core: CoreModule,
    private readonly vault: Vault,
    readonly home: string,
  ) {}

  private thread(threadId: ThreadId): { id: string; settings: Record<string, unknown> } {
    const thread = this.vault.threads.get(threadId);
    if (thread === null) {
      throw Object.assign(new Error("No such thread."), {
        status: 404,
        code: "thread_not_found",
      });
    }
    return thread;
  }

  async listThreads(): Promise<ThreadStats[]> {
    const threads = this.vault.threads.list();
    if (threads.length === 0) {
      return [this.core.stats(this.vault, this.vault.threads.primary().id)];
    }
    return threads.map((thread) => this.core.stats(this.vault, thread.id));
  }

  async createThread(title?: string): Promise<ThreadStats> {
    const created = this.vault.threads.create(title);
    return this.core.stats(this.vault, created.id);
  }

  async getThread(id: ThreadId): Promise<ThreadStats | undefined> {
    return this.vault.threads.get(id) === null ? undefined : this.core.stats(this.vault, id);
  }

  async stats(threadId: ThreadId): Promise<ThreadStats> {
    this.thread(threadId);
    return this.core.stats(this.vault, threadId);
  }

  async settings(threadId: ThreadId): Promise<ThreadSettings> {
    const settings = this.thread(threadId).settings;
    return {
      ...(typeof settings.model === "string" ? { model: settings.model } : {}),
      ...(typeof settings.budget === "number" ? { budget: settings.budget } : {}),
    };
  }

  async setSettings(threadId: ThreadId, patch: ThreadSettings): Promise<void> {
    const current = this.thread(threadId).settings;
    this.vault.threads.setSettings(threadId, { ...current, ...patch });
  }

  async episodes(
    threadId: ThreadId,
    opts: { before?: Seq; after?: Seq; limit?: number },
  ): Promise<Episode[]> {
    this.thread(threadId);
    return this.vault.episodes.list(threadId, opts);
  }

  async episode(threadId: ThreadId, seq: Seq): Promise<Episode | undefined> {
    return this.vault.episodes.get(threadId, seq) ?? undefined;
  }

  async search(threadId: ThreadId, query: string): Promise<{ episodes: Episode[]; atoms: Atom[] }> {
    this.thread(threadId);
    const needle = query.trim().toLowerCase();
    const episodes = needle.length === 0 ? [] : this.vault.episodes.search(threadId, query, 40);
    const atoms =
      needle.length === 0
        ? []
        : this.vault.atoms
            .list(threadId, { limit: 400 })
            .filter((atom) => atom.text.toLowerCase().includes(needle))
            .slice(0, 40);
    return { episodes, atoms };
  }

  async packet(threadId: ThreadId, turnSeq: Seq): Promise<Packet | undefined> {
    return this.vault.packets.get(threadId, turnSeq) ?? undefined;
  }

  async atoms(threadId: ThreadId, phase?: AtomPhase): Promise<Atom[]> {
    this.thread(threadId);
    return this.vault.atoms.list(threadId, {
      ...(phase === undefined ? {} : { phase }),
      limit: 500,
    });
  }

  async pinAtom(threadId: ThreadId, atomId: string, pinned: boolean): Promise<Atom | undefined> {
    this.vault.atoms.pin(threadId, atomId, pinned);
    return this.vault.atoms.get(atomId) ?? undefined;
  }

  async capsules(threadId: ThreadId, level?: number): Promise<Capsule[]> {
    this.thread(threadId);
    return this.vault.capsules.list(threadId, level, 2000);
  }

  async ledger(threadId: ThreadId, opts: { name?: string; limit?: number }): Promise<LossEntry[]> {
    const stats = this.core.stats(this.vault, threadId);
    const limit = Math.min(opts.limit ?? 200, 2000);
    if (opts.name !== undefined) return this.vault.losses.byName(threadId, opts.name, limit);
    return this.vault.losses.inRange(threadId, 1, Math.max(1, stats.turns), limit);
  }

  async attach(threadId: ThreadId, files: AttachInput[]): Promise<Episode[]> {
    this.thread(threadId);
    return this.vault.episodes.appendMany(
      threadId,
      files.map((file) => ({
        role: "attachment",
        content: extractText(file),
        meta: {
          blob: this.vault.blobs.put(file.bytes, file.mime),
          mime: file.mime,
          name: file.name,
          size: file.bytes.byteLength,
        },
      })),
    );
  }

  /**
   * The divider sentence reads in plain names; `meta` keeps the exact model ids
   * so the transcript and the model list stay machine-checkable.
   */
  async handoff(threadId: ThreadId, model: string, provider: ProviderId): Promise<Episode> {
    const settings = this.thread(threadId).settings;
    const from = typeof settings.model === "string" ? settings.model : "the previous model";
    const episode = this.vault.episodes.append(threadId, {
      role: "handoff",
      content: `${shortName(from)} stopped here. ${shortName(model)} continued from the same thread.`,
      meta: { from, to: model },
    });
    this.vault.threads.setSettings(threadId, { ...settings, model, provider });
    return episode;
  }

  async forget(threadId: ThreadId, target: ForgetTarget): Promise<{ tombstoneId: string }> {
    this.thread(threadId);
    const result = this.core.forget(this.vault, threadId, target);
    return { tombstoneId: result.tombstoneId };
  }

  async exportBundle(
    threadId: ThreadId,
    opts: { passphrase: string; range?: [Seq, Seq] },
  ): Promise<Uint8Array> {
    this.thread(threadId);
    return this.core.exportBundle(this.vault, threadId, opts);
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

  async verify(threadId: ThreadId): Promise<{ ok: boolean; headHash: string; checkedTo: Seq }> {
    this.thread(threadId);
    const result = this.core.verify(this.vault, threadId, { full: true });
    return { ok: result.ok, headHash: result.headHash, checkedTo: result.checkedTo };
  }

  /**
   * The kernel emits `TurnEvent`s through a callback and resolves when the turn
   * commits; the HTTP layer wants an async iterable. This is that bridge, with
   * a bounded queue so a slow client cannot stall the kernel's transaction.
   */
  async *runTurn(
    threadId: ThreadId,
    input: TurnInput,
    provider: ProviderFn,
  ): AsyncGenerator<TurnEvent> {
    this.thread(threadId);
    const queue: TurnEvent[] = [];
    let notify: (() => void) | undefined;
    let finished = false;
    let failure: unknown;
    /** The kernel rethrows a plain Error; this keeps the provider's own code. */
    let providerFailure: unknown;

    const push = (event: TurnEvent): void => {
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
    await running;
    if (failure !== undefined) throw providerFailure ?? failure;
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

/** A bundle that will not open is the caller's problem, not a server fault. */
function importError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/already exists/i.test(message)) {
    return Object.assign(
      new Error("This thread is already in your vault. Its archive is bound to its id."),
      { status: 409, code: "import_duplicate" },
    );
  }
  const unopenable =
    /passphrase|decrypt|not a \.pylos|magic|manifest|chain|verif|unsupported/i.test(message);
  return Object.assign(new Error(message), {
    status: unopenable ? 422 : 500,
    code: unopenable ? "import_refused" : "import_failed",
  });
}

function extractText(file: AttachInput): string {
  const textual = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml))/.test(
    file.mime,
  );
  if (textual || /\.(md|txt|ts|tsx|js|json|py|rs|go|css|html|yml|yaml|toml|csv)$/i.test(file.name)) {
    return new TextDecoder().decode(file.bytes).slice(0, 200_000);
  }
  return `⟦binary attachment · ${file.name} · ${file.mime} · ${file.bytes.byteLength} bytes⟧`;
}

function shortName(model: string): string {
  if (/^grok/i.test(model)) return "Grok";
  if (/^claude/i.test(model)) return "Claude";
  if (/^(gpt|o[1-9])/i.test(model)) return "GPT";
  return model.split(/[:/]/)[0] ?? model;
}
