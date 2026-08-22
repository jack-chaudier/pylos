/**
 * The Vault — one SQLite database per user profile (KERNEL §1, A5, A6).
 *
 * `~/.pylos/vault.sqlite` (WAL, mode 0600), blobs content-addressed under
 * `~/.pylos/objects/<sha256>`; `PYLOS_HOME` overrides. Everything that belongs
 * to one turn commits in one transaction, so a crash can never leave an answer
 * without its derivation.
 *
 * This module owns the exact archive and nothing else: no compilation, no
 * summarization, no policy. Derived state (atoms, capsules, losses, packets)
 * lives here too but is recomputable from `episode` alone.
 */

import { Database, type Statement } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Atom,
  AtomPhase,
  Capsule,
  Episode,
  EpisodeMeta,
  LossEntry,
  Packet,
  PacketStatus,
  Role,
  Seq,
  Thread,
  ThreadSettings,
} from "@pylos/protocol";
import { canonicalHash, chainHash, genesisHash, newId, sha256 } from "./hash.ts";
import { canonicalJson } from "./pure/canonical.ts";
import { names } from "./pure/names.ts";
import { approxTokens } from "./pure/tokens.ts";
import { needsAuthorityReplay, replayAtoms } from "./replay.ts";
import {
  type AtomRow,
  type CapsuleRow,
  type EpisodeRow,
  ftsQuery,
  type LossRow,
  type PacketRow,
  type ThreadRow,
  type TombstoneRow,
  toAtom,
  toCapsule,
  toEpisode,
  toLoss,
  toPacket,
  toThread,
  toTombstone,
} from "./rows.ts";
import { AUTHORITY_REPLAY, COUNTERS, MIGRATIONS } from "./schema.ts";

/** Chain checkpoint interval (KERNEL §1). */
export const CHECKPOINT_EVERY = 4096;
/** Number of recent packets that keep their full `messages` array (KERNEL A7). */
export const PACKET_MESSAGE_RETENTION = 1000;

export interface VaultOptions {
  /** Profile directory; defaults to `$PYLOS_HOME` or `~/.pylos`. */
  home?: string;
  /** Explicit database file (overrides `home/vault.sqlite`). */
  file?: string;
  /** `synchronous=NORMAL` instead of FULL. Allowed for the bench only. */
  fast?: boolean;
  readonly?: boolean;
}

/** What the caller supplies to append an episode; the vault computes the rest. */
export interface EpisodeInput {
  role: Role;
  content: string;
  model?: string;
  provider?: string;
  ts?: number;
  meta?: EpisodeMeta;
  /** Raw attachment bytes; stored content-addressed and referenced from meta. */
  blob?: { bytes: Uint8Array; mime?: string; name?: string };
}

/** Immutable meta keys the chain has always covered (KERNEL A5). */
const CHAINED_META = ["blob", "mime", "name", "size", "from", "to"] as const;
/** The turn's receipts, chained since KERNEL A10.3. */
const CHAINED_RECEIPTS = ["packetId", "check", "roundsDigest"] as const;

/**
 * `meta_hash` (KERNEL A5, A10.3). `usage` and `pages` are never picked: they are
 * provider-reported and may be back-filled. The receipt keys are picked only for
 * episodes that carry a `roundsDigest` — the marker of an episode written under
 * A10.3 — so an archive written before this amendment hashes exactly as it did
 * and existing chains still verify.
 */
export function metaHashOf(meta: EpisodeMeta): string {
  const keys: readonly string[] =
    meta.roundsDigest === undefined ? CHAINED_META : [...CHAINED_META, ...CHAINED_RECEIPTS];
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = meta[key];
    if (value !== undefined) picked[key] = value;
  }
  return canonicalHash(picked);
}

/** The record the chain hashes. Integers and strings only, no floats. */
export function chainRecord(input: {
  seq: number;
  ts: number;
  role: string;
  model?: string;
  provider?: string;
  contentHash: string;
  metaHash: string;
}): Record<string, unknown> {
  return {
    v: 1,
    seq: input.seq,
    ts: input.ts,
    role: input.role,
    model: input.model ?? "",
    provider: input.provider ?? "",
    content_hash: input.contentHash,
    meta_hash: input.metaHash,
  };
}

/** A capsule plus its `kept` name index (internal; not part of the protocol type). */
export interface StoredCapsule extends Capsule {
  /** Names still visible in this capsule's text, with their deepest locators. */
  kept: LossEntry[];
}

/** The record of one removal (KERNEL §8, A10.6). */
export interface Tombstone {
  id: string;
  threadId: string;
  /** What the user asked to remove: `seqs:…`, `range:…` or `atoms:…`. */
  target: string;
  reason: string;
  createdAt: number;
  /** Seq of the `system` episode that records this removal; 0 for legacy rows. */
  removalSeq: Seq;
  /** Assistant episodes that carry a routing name of the removed text. */
  echoes: Seq[];
}

export interface AppendResult {
  episode: Episode;
  headSeq: Seq;
  headHash: string;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** Resolve the profile directory: explicit → `$PYLOS_HOME` → `~/.pylos`. */
export function pylosHome(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.PYLOS_HOME;
  if (env && env.length > 0) return env;
  return join(homedir(), ".pylos");
}

export class Vault {
  readonly db: Database;
  readonly home: string;
  readonly file: string;
  readonly objectsDir: string;
  private readonly statements = new Map<string, Statement>();
  private depth = 0;

  constructor(options: VaultOptions = {}) {
    this.home = pylosHome(options.home);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.objectsDir = join(this.home, "objects");
    mkdirSync(this.objectsDir, { recursive: true, mode: 0o700 });
    this.file = options.file ?? join(this.home, "vault.sqlite");
    this.db = new Database(this.file, { create: true, readwrite: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA synchronous = ${options.fast === true ? "NORMAL" : "FULL"}`);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA temp_store = MEMORY");
    this.db.exec("PRAGMA cache_size = -32000");
    this.migrate();
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Filesystems without POSIX modes still hold the data correctly.
    }
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migration (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const applied = new Set(
      (this.db.query("SELECT name FROM migration").all() as Array<{ name: string }>).map((r) => r.name),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .query("INSERT INTO migration (name, applied_at) VALUES (?, ?)")
          .run(migration.name, Date.now());
      })();
    }
    if (!applied.has(AUTHORITY_REPLAY)) this.replayAuthority();
  }

  /**
   * KERNEL A10.5. Not expressible in SQL: what an atom is allowed to do depends
   * on the rules, so the repair is to run them again over the exact episodes. A
   * vault without the tell — every vault this version created — is marked done
   * after one indexed query.
   */
  private replayAuthority(): void {
    for (const thread of this.threads.list()) {
      if (needsAuthorityReplay(this, thread.id)) replayAtoms(this, thread.id);
    }
    this.db.query("INSERT INTO migration (name, applied_at) VALUES (?, ?)").run(AUTHORITY_REPLAY, Date.now());
  }

  /** Cached prepared statement. */
  private stmt(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Run `fn` in a transaction; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth += 1;
    try {
      return this.db.transaction(fn)();
    } finally {
      this.depth -= 1;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- threads

  readonly threads = {
    create: (title?: string, settings: ThreadSettings = {}): Thread => {
      const id = newId("th");
      const thread: Thread = {
        id,
        title: title ?? "Untitled thread",
        createdAt: Date.now(),
        headSeq: 0,
        headHash: genesisHash(id),
        settings,
      };
      this.stmt(
        "INSERT INTO thread (id, title, created_at, head_seq, head_hash, settings) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(thread.id, thread.title, thread.createdAt, 0, thread.headHash, canonicalJson(settings));
      return thread;
    },
    get: (id: string): Thread | null => {
      const row = this.stmt("SELECT * FROM thread WHERE id = ?").get(id) as ThreadRow | undefined;
      return row == null ? null : toThread(row);
    },
    list: (): Thread[] =>
      (this.stmt("SELECT * FROM thread ORDER BY created_at ASC").all() as ThreadRow[]).map(toThread),
    setTitle: (id: string, title: string): void => {
      this.stmt("UPDATE thread SET title = ? WHERE id = ?").run(title, id);
    },
    setSettings: (id: string, settings: ThreadSettings): void => {
      this.stmt("UPDATE thread SET settings = ? WHERE id = ?").run(canonicalJson(settings), id);
    },
    /** The one thread a fresh profile opens with; created on demand. */
    primary: (): Thread => {
      const existing = this.threads.list();
      return existing[0] ?? this.threads.create("Pylos");
    },
  };

  private requireThread(threadId: string): Thread {
    const thread = this.threads.get(threadId);
    if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
    return thread;
  }

  // --------------------------------------------------------------- episodes

  readonly episodes = {
    /** Append one episode, extending the hash chain. */
    append: (threadId: string, input: EpisodeInput): Episode =>
      this.tx(() => this.episodes.appendMany(threadId, [input])[0] as Episode),

    /**
     * Append a batch in one transaction. The bench relies on this: 2,000
     * episodes per transaction keeps ingest amortized O(1) per turn.
     */
    appendMany: (threadId: string, inputs: readonly EpisodeInput[]): Episode[] =>
      this.tx(() => {
        const thread = this.requireThread(threadId);
        let seq = thread.headSeq;
        let prevHash = thread.headHash;
        const out: Episode[] = [];
        const insert = this.stmt(
          "INSERT INTO episode (seq, thread_id, ts, role, model, provider, content, content_hash, tokens, prev_hash, hash, meta) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const fts = this.stmt("INSERT INTO episode_fts (rowid, content) VALUES (?, ?)");
        const counters: Record<string, number> = {};
        for (const input of inputs) {
          seq += 1;
          const meta: EpisodeMeta = { ...(input.meta ?? {}) };
          if (input.blob) {
            const hash = this.blobs.put(input.blob.bytes, input.blob.mime);
            meta.blob = hash;
            if (input.blob.mime) meta.mime = input.blob.mime;
            if (input.blob.name) meta.name = input.blob.name;
            meta.size = input.blob.bytes.byteLength;
          }
          const ts = input.ts ?? Date.now();
          const contentHash = sha256(input.content);
          const hash = chainHash(
            prevHash,
            chainRecord({
              seq,
              ts,
              role: input.role,
              model: input.model,
              provider: input.provider,
              contentHash,
              metaHash: metaHashOf(meta),
            }),
          );
          const tokens = approxTokens(input.content);
          const result = insert.run(
            seq,
            threadId,
            ts,
            input.role,
            input.model ?? null,
            input.provider ?? null,
            input.content,
            contentHash,
            tokens,
            prevHash,
            hash,
            canonicalJson(meta),
          );
          fts.run(Number(result.lastInsertRowid), input.content);
          out.push({
            threadId,
            seq,
            ts,
            role: input.role,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            content: input.content,
            tokens,
            prevHash,
            hash,
            meta,
          });
          counters[COUNTERS.episodes] = (counters[COUNTERS.episodes] ?? 0) + 1;
          counters[COUNTERS.bytes] = (counters[COUNTERS.bytes] ?? 0) + Buffer.byteLength(input.content);
          const roleKey =
            input.role === "user"
              ? COUNTERS.userEpisodes
              : input.role === "assistant"
                ? COUNTERS.assistantEpisodes
                : COUNTERS.otherEpisodes;
          counters[roleKey] = (counters[roleKey] ?? 0) + 1;
          if (seq % CHECKPOINT_EVERY === 0) {
            this.stmt("INSERT OR REPLACE INTO chain_checkpoint (thread_id, seq, hash) VALUES (?, ?, ?)").run(
              threadId,
              seq,
              hash,
            );
          }
          prevHash = hash;
        }
        this.stmt("UPDATE thread SET head_seq = ?, head_hash = ? WHERE id = ?").run(seq, prevHash, threadId);
        this.bump(threadId, counters);
        return out;
      }),

    get: (threadId: string, seq: Seq): Episode | null => {
      const row = this.stmt("SELECT * FROM episode WHERE thread_id = ? AND seq = ?").get(threadId, seq) as
        | EpisodeRow
        | undefined;
      return row == null ? null : toEpisode(row);
    },

    /** Inclusive `[from, to]` range, ascending. */
    range: (threadId: string, from: Seq, to: Seq): Episode[] =>
      (
        this.stmt("SELECT * FROM episode WHERE thread_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC").all(
          threadId,
          from,
          to,
        ) as EpisodeRow[]
      ).map(toEpisode),

    /** Newest-last page for the transcript view. */
    list: (threadId: string, opts: { before?: Seq; after?: Seq; limit?: number } = {}): Episode[] => {
      const limit = Math.max(1, Math.min(opts.limit ?? 100, 5000));
      if (opts.after !== undefined) {
        return (
          this.stmt("SELECT * FROM episode WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?").all(
            threadId,
            opts.after,
            limit,
          ) as EpisodeRow[]
        ).map(toEpisode);
      }
      const before = opts.before ?? Number.MAX_SAFE_INTEGER;
      const rows = this.stmt(
        "SELECT * FROM episode WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
      ).all(threadId, before, limit) as EpisodeRow[];
      return rows.reverse().map(toEpisode);
    },

    /** The last `limit` episodes, ascending. */
    tail: (threadId: string, limit: number): Episode[] => {
      const rows = this.stmt("SELECT * FROM episode WHERE thread_id = ? ORDER BY seq DESC LIMIT ?").all(
        threadId,
        Math.max(1, limit),
      ) as EpisodeRow[];
      return rows.reverse().map(toEpisode);
    },

    count: (threadId: string): number => this.counter(threadId, COUNTERS.episodes),

    /** FTS5/BM25 lexical search (KERNEL §5.3). Returns best matches first. */
    search: (threadId: string, query: string, limit = 10): Episode[] => {
      const run = (match: string): Episode[] => {
        try {
          const rows = this.stmt(
            "SELECT e.* FROM episode_fts f JOIN episode e ON e.rowid = f.rowid " +
              "WHERE episode_fts MATCH ? AND e.thread_id = ? " +
              // Equal scores must not depend on how SQLite happened to walk the
              // index: the newest matching turn wins, always.
              "ORDER BY bm25(episode_fts) ASC, e.seq DESC LIMIT ?",
          ).all(match, threadId, limit) as EpisodeRow[];
          return rows.map(toEpisode);
        } catch {
          return [];
        }
      };
      const strict = ftsQuery(query, "and");
      const found = strict === null ? [] : run(strict);
      if (found.length > 0) return found;
      const loose = ftsQuery(query, "or");
      return loose === null ? [] : run(loose);
    },
  };

  // ------------------------------------------------------------------ blobs

  readonly blobs = {
    put: (bytes: Uint8Array, mime?: string): string => {
      const hash = sha256(bytes);
      const path = join(this.objectsDir, hash);
      if (!existsSync(path)) {
        writeFileSync(path, bytes, { mode: 0o600 });
      }
      this.stmt("INSERT OR IGNORE INTO blob (hash, mime, size, created_at) VALUES (?, ?, ?, ?)").run(
        hash,
        mime ?? null,
        bytes.byteLength,
        Date.now(),
      );
      return hash;
    },
    get: (hash: string): Uint8Array | null => {
      const path = join(this.objectsDir, hash);
      if (!existsSync(path)) return null;
      return new Uint8Array(readFileSync(path));
    },
    list: (): Array<{ hash: string; mime: string | null; size: number }> =>
      this.stmt("SELECT hash, mime, size FROM blob").all() as Array<{
        hash: string;
        mime: string | null;
        size: number;
      }>,
    /**
     * True if any episode that has not itself been removed still references this
     * hash — across every thread, since `objects/` is one content-addressed store.
     * A scan of `meta`: `forget` is user-initiated and rare, and the alternative
     * is an index paid for on every append.
     */
    referenced: (hash: string): boolean =>
      this.stmt(
        "SELECT 1 FROM episode WHERE json_extract(meta, '$.blob') = ? " +
          "AND COALESCE(json_extract(meta, '$.removed'), 0) != 1 LIMIT 1",
      ).get(hash) !== null,
    /** Delete the bytes and the row. Only `forget` may call this (KERNEL A10.6). */
    delete: (hash: string): void => {
      rmSync(join(this.objectsDir, hash), { force: true });
      this.stmt("DELETE FROM blob WHERE hash = ?").run(hash);
    },
  };

  // ------------------------------------------------------------------ atoms

  readonly atoms = {
    insert: (atom: Atom): void => {
      this.stmt(
        "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
          "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        atom.id,
        atom.threadId,
        atom.kind,
        atom.key,
        atom.value,
        atom.text,
        atom.sourceSeq,
        atom.sourceSpan ? canonicalJson(atom.sourceSpan) : null,
        atom.validFromSeq,
        atom.validToSeq ?? null,
        atom.supersededBy ?? null,
        atom.phase,
        atom.authority,
        atom.scope,
        atom.pinned ? 1 : 0,
        atom.confidence,
        atom.createdBy,
        atom.createdAt,
      );
      // Index the names this atom is *about*, so a query naming the subject can
      // reach the current certificate even when the frontier is over capacity.
      const link = this.stmt("INSERT OR IGNORE INTO atom_name (thread_id, name, atom_id) VALUES (?, ?, ?)");
      const seen = new Set<string>([atom.key.toLowerCase()]);
      for (const hit of names(atom.text, { max: 6 })) seen.add(hit.name);
      const value = atom.value.replace(/\s+/g, " ").trim().toLowerCase();
      if (value.length > 1 && value.length <= 96) seen.add(value);
      for (const name of seen) link.run(atom.threadId, name.slice(0, 96), atom.id);
      this.bump(atom.threadId, { [phaseCounter(atom.phase)]: 1 });
    },

    /** Current atoms for a key, most recent first. */
    byKey: (threadId: string, key: string, phase: AtomPhase = "SUPPORTED"): Atom[] =>
      (
        this.stmt(
          "SELECT * FROM atom WHERE thread_id = ? AND key = ? AND phase = ? ORDER BY valid_from_seq DESC",
        ).all(threadId, key, phase) as AtomRow[]
      ).map(toAtom),

    /** All atoms for a key across phases, newest first. */
    historyOf: (threadId: string, key: string): Atom[] =>
      (
        this.stmt("SELECT * FROM atom WHERE thread_id = ? AND key = ? ORDER BY valid_from_seq DESC").all(
          threadId,
          key,
        ) as AtomRow[]
      ).map(toAtom),

    list: (
      threadId: string,
      opts: { phase?: AtomPhase; key?: string; limit?: number; kind?: string; kinds?: string[] } = {},
    ): Atom[] => {
      const clauses = ["thread_id = ?"];
      const params: unknown[] = [threadId];
      if (opts.phase) {
        clauses.push("phase = ?");
        params.push(opts.phase);
      }
      if (opts.key) {
        clauses.push("key = ?");
        params.push(opts.key);
      }
      if (opts.kind) {
        clauses.push("kind = ?");
        params.push(opts.kind);
      }
      if (opts.kinds && opts.kinds.length > 0) {
        clauses.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
        params.push(...opts.kinds);
      }
      params.push(Math.max(1, Math.min(opts.limit ?? 500, 20000)));
      return (
        this.stmt(
          // `pinned` is not in any index; the caller re-orders pinned atoms to
          // the front, so ordering here by the indexed column keeps this read
          // independent of how much memory the thread has accumulated.
          `SELECT * FROM atom WHERE ${clauses.join(" AND ")} ORDER BY valid_from_seq DESC LIMIT ?`,
        ).all(...(params as never[])) as AtomRow[]
      ).map(toAtom);
    },

    get: (id: string): Atom | null => {
      const row = this.stmt("SELECT * FROM atom WHERE id = ?").get(id) as AtomRow | undefined;
      return row == null ? null : toAtom(row);
    },

    /**
     * Atoms a query name refers to: the current certificate first, then the
     * superseded ones. This is the frontier-overflow path (THEORY §12) — when
     * the live frontier is wider than the budget, the answer is paged, exactly,
     * rather than dropped.
     */
    /** SUPPORTED atoms whose normalized value equals this string (indexed). */
    byValue: (threadId: string, value: string, limit = 4): Atom[] =>
      (
        this.stmt(
          "SELECT a.* FROM atom_name n JOIN atom a ON a.id = n.atom_id " +
            "WHERE n.thread_id = ? AND n.name = ? AND a.phase = 'SUPPORTED' " +
            "ORDER BY a.valid_from_seq DESC LIMIT ?",
        ).all(threadId, value, limit) as AtomRow[]
      ).map(toAtom),

    byName: (threadId: string, name: string, limit = 4): Atom[] =>
      (
        this.stmt(
          "SELECT a.* FROM atom_name n JOIN atom a ON a.id = n.atom_id " +
            "WHERE n.thread_id = ? AND n.name = ? AND a.phase != 'REVOKED' " +
            "ORDER BY (a.phase = 'SUPPORTED') DESC, a.valid_from_seq DESC LIMIT ?",
        ).all(threadId, name, limit) as AtomRow[]
      ).map(toAtom),

    /** Atoms whose validity begins inside `[from, to]` — the capsule's certificates. */
    inRange: (threadId: string, from: Seq, to: Seq): Atom[] =>
      (
        this.stmt(
          "SELECT * FROM atom WHERE thread_id = ? AND valid_from_seq BETWEEN ? AND ? ORDER BY valid_from_seq ASC",
        ).all(threadId, from, to) as AtomRow[]
      ).map(toAtom),

    /**
     * Supersede: never overwrite, always interval-close (KERNEL §2). Also how an
     * open proposal is closed when the user finally rules on its key (A9.1) —
     * `prior.phase` says which counter the row is leaving.
     */
    supersede: (threadId: string, prior: Atom, byId: string, atSeq: Seq): void => {
      this.stmt(
        "UPDATE atom SET phase = 'HISTORICAL', valid_to_seq = ?, superseded_by = ? WHERE id = ? AND thread_id = ?",
      ).run(atSeq, byId, prior.id, threadId);
      this.bump(threadId, { [phaseCounter(prior.phase)]: -1 });
      this.bump(threadId, { [COUNTERS.atomsHistorical]: 1 });
    },

    pin: (threadId: string, atomId: string, pinned: boolean): void => {
      this.stmt("UPDATE atom SET pinned = ? WHERE id = ? AND thread_id = ?").run(
        pinned ? 1 : 0,
        atomId,
        threadId,
      );
    },

    revoke: (threadId: string, atomId: string): void => {
      this.stmt("UPDATE atom SET phase = 'REVOKED' WHERE id = ? AND thread_id = ?").run(atomId, threadId);
    },
  };

  // --------------------------------------------------------------- capsules

  readonly capsules = {
    insert: (capsule: StoredCapsule): void => {
      this.stmt(
        "INSERT OR REPLACE INTO capsule (id, thread_id, level, from_seq, to_seq, text, tokens, dropped, " +
          "carried_count, kept, hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        capsule.id,
        capsule.threadId,
        capsule.level,
        capsule.fromSeq,
        capsule.toSeq,
        capsule.text,
        capsule.tokens,
        canonicalJson(capsule.dropped),
        capsule.carriedCount,
        canonicalJson(capsule.kept),
        capsule.hash,
        capsule.createdBy,
        capsule.createdAt,
      );
      this.bump(capsule.threadId, { [COUNTERS.capsules]: 1 });
    },

    /** Replace the rolling root in place (KERNEL A3). */
    replace: (capsule: StoredCapsule): void => {
      this.stmt(
        "UPDATE capsule SET level = ?, from_seq = ?, to_seq = ?, text = ?, tokens = ?, dropped = ?, " +
          "carried_count = ?, kept = ?, hash = ?, created_by = ?, created_at = ? WHERE id = ?",
      ).run(
        capsule.level,
        capsule.fromSeq,
        capsule.toSeq,
        capsule.text,
        capsule.tokens,
        canonicalJson(capsule.dropped),
        capsule.carriedCount,
        canonicalJson(capsule.kept),
        capsule.hash,
        capsule.createdBy,
        capsule.createdAt,
        capsule.id,
      );
    },

    get: (id: string): StoredCapsule | null => {
      const row = this.stmt("SELECT * FROM capsule WHERE id = ?").get(id) as CapsuleRow | undefined;
      return row == null ? null : toCapsule(row);
    },

    at: (threadId: string, level: number, fromSeq: Seq): StoredCapsule | null => {
      const row = this.stmt("SELECT * FROM capsule WHERE thread_id = ? AND level = ? AND from_seq = ?").get(
        threadId,
        level,
        fromSeq,
      ) as CapsuleRow | undefined;
      return row == null ? null : toCapsule(row);
    },

    /** The most recent `limit` capsules at a level, newest first. */
    recent: (threadId: string, level: number, limit: number): StoredCapsule[] =>
      (
        this.stmt(
          "SELECT * FROM capsule WHERE thread_id = ? AND level = ? ORDER BY from_seq DESC LIMIT ?",
        ).all(threadId, level, limit) as CapsuleRow[]
      ).map(toCapsule),

    list: (threadId: string, level?: number, limit = 500): StoredCapsule[] =>
      (level === undefined
        ? (this.stmt(
            "SELECT * FROM capsule WHERE thread_id = ? ORDER BY level DESC, from_seq ASC LIMIT ?",
          ).all(threadId, limit) as CapsuleRow[])
        : (this.stmt(
            "SELECT * FROM capsule WHERE thread_id = ? AND level = ? ORDER BY from_seq ASC LIMIT ?",
          ).all(threadId, level, limit) as CapsuleRow[])
      ).map(toCapsule),

    /** Capsules at a level that begin after `fromSeq`, ascending. */
    after: (threadId: string, level: number, fromSeq: Seq, limit = 16): StoredCapsule[] =>
      (
        this.stmt(
          "SELECT * FROM capsule WHERE thread_id = ? AND level = ? AND from_seq > ? ORDER BY from_seq ASC LIMIT ?",
        ).all(threadId, level, fromSeq, limit) as CapsuleRow[]
      ).map(toCapsule),

    children: (threadId: string, level: number, fromSeq: Seq, toSeq: Seq): StoredCapsule[] =>
      (
        this.stmt(
          "SELECT * FROM capsule WHERE thread_id = ? AND level = ? AND from_seq >= ? AND to_seq <= ? ORDER BY from_seq ASC",
        ).all(threadId, level - 1, fromSeq, toSeq) as CapsuleRow[]
      ).map(toCapsule),

    count: (threadId: string): number => this.counter(threadId, COUNTERS.capsules),
  };

  // ----------------------------------------------------------------- losses

  readonly losses = {
    /** Append ledger rows. Rows are written once, at the deepest drop (KERNEL A2). */
    add: (threadId: string, capsuleId: string, level: number, entries: readonly LossEntry[]): number => {
      if (entries.length === 0) return 0;
      const insert = this.stmt(
        "INSERT INTO loss (thread_id, capsule_id, name, kind, level, seq, span) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const entry of entries) {
        insert.run(
          threadId,
          capsuleId,
          entry.name,
          entry.kind,
          level,
          entry.seq,
          entry.span ? canonicalJson(entry.span) : null,
        );
      }
      this.bump(threadId, { [COUNTERS.losses]: entries.length });
      return entries.length;
    },

    /** `ledger(c)` — the seq-range query that makes conservation implicit (KERNEL A2). */
    inRange: (threadId: string, from: Seq, to: Seq, limit = 100000): LossEntry[] =>
      (
        this.stmt(
          "SELECT name, kind, seq, span, capsule_id, resolved_by FROM loss " +
            "WHERE thread_id = ? AND seq BETWEEN ? AND ? AND resolved_by IS NULL LIMIT ?",
        ).all(threadId, from, to, limit) as LossRow[]
      ).map(toLoss),

    countInRange: (threadId: string, from: Seq, to: Seq): number =>
      (
        this.stmt(
          "SELECT COUNT(*) AS n FROM loss WHERE thread_id = ? AND seq BETWEEN ? AND ? AND resolved_by IS NULL",
        ).get(threadId, from, to) as { n: number }
      ).n,

    /** Distinct names in a range, newest locator first — the digest source. */
    namesInRange: (threadId: string, from: Seq, to: Seq, limit = 32): string[] =>
      (
        this.stmt(
          "SELECT name, MAX(seq) AS s FROM loss WHERE thread_id = ? AND seq BETWEEN ? AND ? AND resolved_by IS NULL " +
            "GROUP BY name ORDER BY s DESC LIMIT ?",
        ).all(threadId, from, to, limit) as Array<{ name: string; s: number }>
      ).map((r) => r.name),

    /** Locators for one routing key, most recent first (KERNEL §5.1). */
    byName: (threadId: string, name: string, limit = 4): LossEntry[] =>
      (
        this.stmt(
          "SELECT name, kind, seq, span, capsule_id, resolved_by FROM loss " +
            "WHERE thread_id = ? AND name = ? AND resolved_by IS NULL ORDER BY seq DESC LIMIT ?",
        ).all(threadId, name, limit) as LossRow[]
      ).map(toLoss),

    /** True if any unresolved row exists for the name. */
    has: (threadId: string, name: string): boolean =>
      this.stmt("SELECT 1 FROM loss WHERE thread_id = ? AND name = ? AND resolved_by IS NULL LIMIT 1").get(
        threadId,
        name,
      ) !== null,

    resolve: (threadId: string, from: Seq, to: Seq, tombstoneId: string): number => {
      const result = this.stmt(
        "UPDATE loss SET resolved_by = ? WHERE thread_id = ? AND seq BETWEEN ? AND ? AND resolved_by IS NULL",
      ).run(tombstoneId, threadId, from, to);
      const changed = Number(result.changes);
      this.bump(threadId, { [COUNTERS.losses]: -changed });
      return changed;
    },

    total: (threadId: string): number => this.counter(threadId, COUNTERS.losses),

    /** Frontier evictions are losses too, recorded once per key (KERNEL A4). */
    noteFrontierEviction: (threadId: string, name: string, seq: Seq): void => {
      const exists = this.stmt(
        "SELECT 1 FROM loss WHERE thread_id = ? AND name = ? AND capsule_id = 'frontier' LIMIT 1",
      ).get(threadId, name);
      if (exists !== null) return;
      this.losses.add(threadId, "frontier", -1, [{ name, kind: "atom", seq }]);
    },
  };

  // -------------------------------------------------------------- stopnames

  readonly stopNames = {
    /** A name in > 2% of the last 10,000 episodes: recorded, never auto-routed. */
    recompute: (threadId: string, headSeq: Seq): void => {
      const from = Math.max(1, headSeq - 10000);
      const threshold = Math.max(4, Math.floor(Math.min(10000, headSeq - from + 1) * 0.02));
      this.tx(() => {
        this.stmt("DELETE FROM stop_name WHERE thread_id = ?").run(threadId);
        this.stmt(
          "INSERT INTO stop_name (thread_id, name, hits) SELECT thread_id, name, COUNT(DISTINCT seq) AS n " +
            "FROM loss WHERE thread_id = ? AND seq >= ? GROUP BY name HAVING n > ?",
        ).run(threadId, from, threshold);
      });
    },
    all: (threadId: string): Set<string> =>
      new Set(
        (
          this.stmt("SELECT name FROM stop_name WHERE thread_id = ?").all(threadId) as Array<{
            name: string;
          }>
        ).map((r) => r.name),
      ),
    has: (threadId: string, name: string): boolean =>
      this.stmt("SELECT 1 FROM stop_name WHERE thread_id = ? AND name = ?").get(threadId, name) !== null,
  };

  // ---------------------------------------------------------------- packets

  readonly packets = {
    /** Write a packet row. `status='pending'` until the reply lands (KERNEL A6). */
    insert: (packet: Packet, status: PacketStatus = "done"): void => {
      this.stmt(
        "INSERT OR REPLACE INTO packet (id, thread_id, turn_seq, model, budget, tokens, digest, status, " +
          "compiler_version, messages, resident, ledger, pages, rounds, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        packet.id,
        packet.threadId,
        packet.turnSeq,
        packet.model,
        packet.budget,
        packet.tokens,
        packet.digest,
        status,
        COMPILER_VERSION,
        JSON.stringify(packet.messages),
        JSON.stringify(packet.resident),
        JSON.stringify(packet.ledger),
        JSON.stringify(packet.pages),
        JSON.stringify(packet.rounds ?? []),
        packet.createdAt,
      );
    },

    /** Close the packet with what was served and what was sent (KERNEL A10.3). */
    finish: (packetId: string, pages: unknown[], rounds: unknown[] = []): void => {
      this.stmt("UPDATE packet SET status = 'done', pages = ?, rounds = ? WHERE id = ?").run(
        JSON.stringify(pages),
        JSON.stringify(rounds),
        packetId,
      );
    },

    /** Drop `messages` from all but the most recent 1,000 packets (KERNEL A7). */
    prune: (threadId: string, retain = PACKET_MESSAGE_RETENTION): void => {
      this.stmt(
        "UPDATE packet SET messages = NULL WHERE thread_id = ? AND messages IS NOT NULL AND turn_seq < " +
          "(SELECT MIN(turn_seq) FROM (SELECT turn_seq FROM packet WHERE thread_id = ? ORDER BY turn_seq DESC LIMIT ?))",
      ).run(threadId, threadId, retain);
    },

    get: (threadId: string, turnSeq: Seq): Packet | null => {
      const row = this.stmt(
        "SELECT * FROM packet WHERE thread_id = ? AND turn_seq = ? ORDER BY created_at DESC LIMIT 1",
      ).get(threadId, turnSeq) as PacketRow | undefined;
      return row == null ? null : toPacket(row);
    },

    byId: (id: string): Packet | null => {
      const row = this.stmt("SELECT * FROM packet WHERE id = ?").get(id) as PacketRow | undefined;
      return row == null ? null : toPacket(row);
    },

    last: (threadId: string): Packet | null => {
      const row = this.stmt(
        "SELECT * FROM packet WHERE thread_id = ? ORDER BY turn_seq DESC, created_at DESC LIMIT 1",
      ).get(threadId) as PacketRow | undefined;
      return row == null ? null : toPacket(row);
    },
  };

  // ------------------------------------------------------------- tombstones

  readonly tombstones = {
    create: (threadId: string, target: string, reason: string): string => {
      const id = newId("tb");
      this.stmt(
        "INSERT INTO tombstone (id, thread_id, target, reason, created_at, removal_seq, echoes) " +
          "VALUES (?, ?, ?, ?, ?, NULL, '[]')",
      ).run(id, threadId, target, reason, Date.now());
      return id;
    },
    /** Bind a tombstone to its chain event and the echoes it found (KERNEL A10.6). */
    record: (id: string, removalSeq: Seq, echoes: readonly Seq[]): void => {
      this.stmt("UPDATE tombstone SET removal_seq = ?, echoes = ? WHERE id = ?").run(
        removalSeq,
        canonicalJson([...echoes]),
        id,
      );
    },
    get: (id: string): Tombstone | null => {
      const row = this.stmt("SELECT * FROM tombstone WHERE id = ?").get(id) as TombstoneRow | undefined;
      return row == null ? null : toTombstone(row);
    },
    list: (threadId: string): Tombstone[] =>
      (
        this.stmt("SELECT * FROM tombstone WHERE thread_id = ? ORDER BY created_at ASC").all(
          threadId,
        ) as TombstoneRow[]
      ).map(toTombstone),
  };

  // --------------------------------------------------------------- internal

  /** Remove an episode's text from the FTS index (used by `forget`). */
  ftsDelete(threadId: string, seq: Seq): void {
    const row = this.stmt("SELECT rowid, content FROM episode WHERE thread_id = ? AND seq = ?").get(
      threadId,
      seq,
    ) as { rowid: number; content: string } | undefined;
    if (row == null) return;
    this.stmt("INSERT INTO episode_fts (episode_fts, rowid, content) VALUES ('delete', ?, ?)").run(
      row.rowid,
      row.content,
    );
  }

  /** Replace an episode's stored content, keeping `content_hash` (KERNEL A5). */
  redactContent(threadId: string, seq: Seq, replacement: string, meta: EpisodeMeta): void {
    this.ftsDelete(threadId, seq);
    this.stmt("UPDATE episode SET content = ?, meta = ? WHERE thread_id = ? AND seq = ?").run(
      replacement,
      canonicalJson(meta),
      threadId,
      seq,
    );
  }

  /** Incremental counters; a COUNT(*) over a million-row table is not O(1). */
  bump(threadId: string, deltas: Record<string, number>): void {
    const statement = this.stmt(
      "INSERT INTO counter (thread_id, key, value) VALUES (?, ?, ?) " +
        "ON CONFLICT(thread_id, key) DO UPDATE SET value = value + excluded.value",
    );
    for (const [key, delta] of Object.entries(deltas)) {
      if (delta === 0) continue;
      statement.run(threadId, key, delta);
    }
  }

  counter(threadId: string, key: string): number {
    const row = this.stmt("SELECT value FROM counter WHERE thread_id = ? AND key = ?").get(threadId, key) as
      | { value: number }
      | undefined;
    return row?.value ?? 0;
  }

  /**
   * Bytes on disk: database file + WAL + content-addressed objects. Whole-vault,
   * not per-thread — v1 keeps one thread per profile, and a per-thread figure
   * would have to be an estimate, which is not what the seal should report.
   */
  archiveBytes(): number {
    let total = 0;
    for (const path of [this.file, `${this.file}-wal`]) {
      try {
        total += statSync(path).size;
      } catch {
        // missing WAL is fine
      }
    }
    for (const blob of this.blobs.list()) total += blob.size;
    return total;
  }

  /** Latest trusted chain checkpoint at or before `seq`. */
  checkpointBefore(threadId: string, seq: Seq): { seq: Seq; hash: string } | null {
    const row = this.stmt(
      "SELECT seq, hash FROM chain_checkpoint WHERE thread_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 1",
    ).get(threadId, seq) as { seq: number; hash: string } | undefined;
    return row == null ? null : row;
  }

  putCheckpoint(threadId: string, seq: Seq, hash: string): void {
    this.stmt("INSERT OR REPLACE INTO chain_checkpoint (thread_id, seq, hash) VALUES (?, ?, ?)").run(
      threadId,
      seq,
      hash,
    );
  }
}

/** Which O(1) counter a phase belongs to. `REVOKED` atoms are counted nowhere. */
export function phaseCounter(phase: AtomPhase): string {
  if (phase === "SUPPORTED") return COUNTERS.atomsSupported;
  if (phase === "PROPOSED") return COUNTERS.atomsProposed;
  return COUNTERS.atomsHistorical;
}

/** The compiler version stamped into packets so an X-ray can be re-rendered. */
export const COMPILER_VERSION = "1";

/** Open (or create) a vault. */
export function openVault(options: VaultOptions = {}): Vault {
  return new Vault(options);
}

/**
 * True if this exact locator is already in the ledger. Dedupe is by
 * `(name, seq)`, not by name: a later mention of the same name is a *different*
 * locator, and routing must be able to reach the newest one — otherwise a query
 * about a revised fact pages back the version before the revision.
 */
export function lossExists(vault: Vault, threadId: string, name: string, seq: Seq): boolean {
  return (
    vault.db
      .query("SELECT 1 FROM loss WHERE thread_id = ? AND name = ? AND seq = ? LIMIT 1")
      .get(threadId, name, seq) !== null
  );
}
