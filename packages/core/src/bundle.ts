/**
 * Export / import — the `.pylos` bundle (KERNEL §7, A7).
 *
 * One file: AES-256-GCM over a zip of `{manifest.json, episodes.jsonl,
 * atoms.jsonl, capsules.jsonl, loss.jsonl, packets.jsonl, tombstones.jsonl,
 * objects/*}`, keyed from a passphrase with PBKDF2-SHA256 ≥ 600k (WebCrypto).
 *
 * The ciphertext is written in 1 MiB chunks with a per-chunk nonce
 * (`base ‖ counter`) and the cleartext header as AAD, so a million-episode
 * bundle can be verified as it streams rather than held whole in memory.
 *
 * Never contains credentials. `import` verifies the hash chain before accepting
 * and refuses on mismatch; it also recomputes `dropped()` on a sample of
 * capsules and refuses if the ledger does not agree with the episodes.
 */

import type { Atom, Capsule, Episode, LossEntry, Seq } from "@pylos/protocol";
import { compact } from "./compact.ts";
import { sha256 } from "./hash.ts";
import { canonicalJson } from "./pure/canonical.ts";
import { deriveLedger, sourceNamesOfEpisode } from "./pure/ledger.ts";
import { normalizeName } from "./pure/names.ts";
import { type StoredCapsule, type Vault, VaultError } from "./vault.ts";
import { verify } from "./verify.ts";
import { unzip, zip } from "./zip.ts";

/** File magic and format version. */
export const BUNDLE_MAGIC = "PYLOS1\n";
const CHUNK_SIZE = 1024 * 1024;
const PBKDF2_ITERATIONS = 600_000;

export interface BundleHeader {
  v: 1;
  kdf: "pbkdf2-sha256";
  iters: number;
  /** base64 salt. */
  salt: string;
  /** base64 nonce prefix; per-chunk nonce is `base ‖ uint32le(counter)`. */
  nonce: string;
  threadId: string;
  headSeq: number;
  headHash: string;
  partial?: { from: Seq; to: Seq; prevHash: string };
}

export interface BundleManifest {
  schema: "pylos.bundle.v1";
  threadId: string;
  title: string;
  createdAt: number;
  exportedAt: number;
  headSeq: number;
  headHash: string;
  counts: { episodes: number; atoms: number; capsules: number; loss: number; packets: number };
  partial: boolean;
  files: Record<string, string>;
}

export interface ExportOptions {
  passphrase: string;
  /** Inclusive seq range for a partial export. */
  range?: [Seq, Seq];
  /** Include full packet `messages` (off by default; they are large). */
  includePacketMessages?: boolean;
}

export interface ImportOptions {
  passphrase: string;
  /** Reuse this thread id instead of the one in the bundle. */
  threadId?: string;
  /** Number of capsules whose ledger is recomputed from episodes. Default 8. */
  sampleCapsules?: number;
}

// ------------------------------------------------------------------ crypto

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function chunkNonce(base: Uint8Array, counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(base.subarray(0, 8), 0);
  new DataView(nonce.buffer).setUint32(8, counter, true);
  return nonce;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function unb64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

// ------------------------------------------------------------------ export

export async function exportBundle(
  vault: Vault,
  threadId: string,
  options: ExportOptions,
): Promise<Uint8Array> {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
  const from = options.range?.[0] ?? 1;
  const to = options.range?.[1] ?? thread.headSeq;
  const partial = from !== 1 || to !== thread.headSeq;

  // The chain is verified over `content_hash`, so the export carries it; removed
  // content never leaves the machine (KERNEL §8) but its hash still does.
  const episodes = vault.episodes.range(threadId, from, to).map((episode) => {
    const row = vault.db
      .query("SELECT content_hash FROM episode WHERE thread_id = ? AND seq = ?")
      .get(threadId, episode.seq) as { content_hash: string };
    return {
      ...episode,
      contentHash: row.content_hash,
      ...(episode.meta.removed === true ? { content: `⟦removed by user⟧` } : {}),
    };
  });
  const atoms = vault.db
    .query("SELECT * FROM atom WHERE thread_id = ? AND source_seq BETWEEN ? AND ?")
    .all(threadId, from, to) as unknown[];
  const capsules = vault.capsules.list(threadId, undefined, 100000).filter((c) => c.toSeq <= to);
  const loss = vault.db
    .query("SELECT * FROM loss WHERE thread_id = ? AND seq BETWEEN ? AND ?")
    .all(threadId, from, to) as unknown[];
  const packets = vault.db
    .query(
      `SELECT id, thread_id, turn_seq, model, budget, tokens, digest, status, compiler_version, ${
        options.includePacketMessages === true ? "messages" : "NULL AS messages"
      }, resident, ledger, pages, created_at FROM packet WHERE thread_id = ? AND turn_seq BETWEEN ? AND ?`,
    )
    .all(threadId, from, to) as unknown[];
  const tombstones = vault.tombstones.list(threadId) as unknown[];

  const files: Array<{ name: string; data: Uint8Array }> = [
    { name: "episodes.jsonl", data: jsonl(episodes) },
    { name: "atoms.jsonl", data: jsonl(atoms) },
    { name: "capsules.jsonl", data: jsonl(capsules) },
    { name: "loss.jsonl", data: jsonl(loss) },
    { name: "packets.jsonl", data: jsonl(packets) },
    { name: "tombstones.jsonl", data: jsonl(tombstones) },
  ];
  for (const blob of vault.blobs.list()) {
    const bytes = vault.blobs.get(blob.hash);
    if (bytes !== null) files.push({ name: `objects/${blob.hash}`, data: bytes });
  }

  const manifest: BundleManifest = {
    schema: "pylos.bundle.v1",
    threadId,
    title: thread.title,
    createdAt: thread.createdAt,
    exportedAt: Date.now(),
    headSeq: to,
    headHash: (episodes.at(-1)?.hash ?? thread.headHash) as string,
    counts: {
      episodes: episodes.length,
      atoms: atoms.length,
      capsules: capsules.length,
      loss: loss.length,
      packets: packets.length,
    },
    partial,
    files: Object.fromEntries(files.map((f) => [f.name, sha256(f.data)])),
  };
  const archive = zip([
    { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
    ...files,
  ]);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonceBase = crypto.getRandomValues(new Uint8Array(8));
  const header: BundleHeader = {
    v: 1,
    kdf: "pbkdf2-sha256",
    iters: PBKDF2_ITERATIONS,
    salt: b64(salt),
    nonce: b64(nonceBase),
    threadId,
    headSeq: to,
    headHash: manifest.headHash,
    ...(partial
      ? {
          partial: {
            from,
            to,
            prevHash: (episodes[0]?.prevHash ?? thread.headHash) as string,
          },
        }
      : {}),
  };
  const headerBytes = new TextEncoder().encode(canonicalJson(header));
  const key = await deriveKey(options.passphrase, salt);

  const parts: Uint8Array[] = [];
  const magic = new TextEncoder().encode(BUNDLE_MAGIC);
  const headerLength = new Uint8Array(4);
  new DataView(headerLength.buffer).setUint32(0, headerBytes.length, true);
  parts.push(magic, headerLength, headerBytes);

  let counter = 0;
  for (let offset = 0; offset < archive.length; offset += CHUNK_SIZE) {
    const slice = archive.subarray(offset, Math.min(offset + CHUNK_SIZE, archive.length));
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: chunkNonce(nonceBase, counter) as BufferSource,
          additionalData: headerBytes as BufferSource,
        },
        key,
        slice as BufferSource,
      ),
    );
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, cipher.length, true);
    parts.push(length, cipher);
    counter += 1;
  }
  const terminator = new Uint8Array(4);
  new DataView(terminator.buffer).setUint32(0, 0, true);
  parts.push(terminator);
  return concat(parts);
}

// ------------------------------------------------------------------ import

export interface ImportResult {
  threadId: string;
  headSeq: Seq;
  headHash: string;
  episodes: number;
  verified: boolean;
  manifest: BundleManifest;
}

export async function importBundle(
  vault: Vault,
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult> {
  const magic = new TextDecoder().decode(bytes.subarray(0, BUNDLE_MAGIC.length));
  if (magic !== BUNDLE_MAGIC) throw new VaultError("not a .pylos bundle");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pointer = BUNDLE_MAGIC.length;
  const headerLength = view.getUint32(pointer, true);
  pointer += 4;
  const headerBytes = bytes.subarray(pointer, pointer + headerLength);
  pointer += headerLength;
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as BundleHeader;
  if (header.v !== 1) throw new VaultError(`unsupported bundle version ${header.v}`);

  const key = await deriveKey(options.passphrase, unb64(header.salt));
  const nonceBase = unb64(header.nonce);
  const chunks: Uint8Array[] = [];
  let counter = 0;
  for (;;) {
    const length = view.getUint32(pointer, true);
    pointer += 4;
    if (length === 0) break;
    const cipher = bytes.subarray(pointer, pointer + length);
    pointer += length;
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: chunkNonce(nonceBase, counter) as BufferSource,
          additionalData: headerBytes as BufferSource,
        },
        key,
        cipher as BufferSource,
      );
    } catch {
      throw new VaultError("decryption failed — wrong passphrase or corrupt bundle");
    }
    chunks.push(new Uint8Array(plain));
    counter += 1;
  }

  const archive = unzip(concat(chunks));
  const manifestBytes = archive.get("manifest.json");
  if (manifestBytes == null) throw new VaultError("bundle has no manifest");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest;
  for (const [name, digest] of Object.entries(manifest.files)) {
    const data = archive.get(name);
    if (data === undefined) throw new VaultError(`bundle missing ${name}`);
    if (sha256(data) !== digest) throw new VaultError(`bundle file ${name} failed its digest`);
  }

  const episodes = parseJsonl<Episode & { contentHash?: string }>(archive.get("episodes.jsonl"));
  const atoms = parseJsonl<Record<string, unknown>>(archive.get("atoms.jsonl"));
  const capsules = parseJsonl<StoredCapsule>(archive.get("capsules.jsonl"));
  const loss = parseJsonl<Record<string, unknown>>(archive.get("loss.jsonl"));
  const tombstones = parseJsonl<Record<string, unknown>>(archive.get("tombstones.jsonl"));

  const threadId = options.threadId ?? manifest.threadId;
  const existing = vault.threads.get(threadId);
  if (existing !== null && existing.headSeq > 0) {
    throw new VaultError(`thread ${threadId} already exists in this vault`);
  }

  const result = vault.tx(() => {
    if (existing === null) {
      vault.db
        .query(
          "INSERT INTO thread (id, title, created_at, head_seq, head_hash, settings) VALUES (?, ?, ?, ?, ?, '{}')",
        )
        .run(threadId, manifest.title, manifest.createdAt, 0, manifest.headHash);
    }
    for (const [name, data] of archive) {
      if (!name.startsWith("objects/")) continue;
      vault.blobs.put(data);
    }
    const insert = vault.db.prepare(
      "INSERT INTO episode (seq, thread_id, ts, role, model, provider, content, content_hash, tokens, prev_hash, hash, meta) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const fts = vault.db.prepare("INSERT INTO episode_fts (rowid, content) VALUES (?, ?)");
    let bytes = 0;
    const counters: Record<string, number> = {};
    for (const episode of episodes) {
      const meta = episode.meta ?? {};
      const row = insert.run(
        episode.seq,
        threadId,
        episode.ts,
        episode.role,
        episode.model ?? null,
        episode.provider ?? null,
        episode.content,
        (episode as unknown as { contentHash?: string }).contentHash ?? sha256(episode.content),
        episode.tokens,
        episode.prevHash,
        episode.hash,
        canonicalJson(meta),
      );
      if (meta.removed !== true) fts.run(Number(row.lastInsertRowid), episode.content);
      bytes += Buffer.byteLength(episode.content);
      counters.episodes = (counters.episodes ?? 0) + 1;
      const roleKey =
        episode.role === "user"
          ? "episodes.user"
          : episode.role === "assistant"
            ? "episodes.assistant"
            : "episodes.other";
      counters[roleKey] = (counters[roleKey] ?? 0) + 1;
      if (episode.seq % 4096 === 0) vault.putCheckpoint(threadId, episode.seq, episode.hash);
    }
    counters.bytes = bytes;
    for (const atom of atoms) insertRow(vault, "atom", { ...atom, thread_id: threadId });
    for (const capsule of capsules) {
      vault.capsules.insert({ ...capsule, threadId });
    }
    for (const row of loss) {
      const { id: _id, ...rest } = row;
      insertRow(vault, "loss", { ...rest, thread_id: threadId });
    }
    for (const row of tombstones) insertRow(vault, "tombstone", { ...row, thread_id: threadId });
    counters["atoms.supported"] = atoms.filter((a) => a.phase === "SUPPORTED").length;
    counters["atoms.historical"] = atoms.filter((a) => a.phase === "HISTORICAL").length;
    counters.capsules = capsules.length;
    counters.losses = loss.filter((l) => l.resolved_by === null || l.resolved_by === undefined).length;
    vault.bump(threadId, counters);

    const last = episodes.at(-1);
    vault.db
      .query("UPDATE thread SET head_seq = ?, head_hash = ? WHERE id = ?")
      .run(last?.seq ?? 0, last?.hash ?? manifest.headHash, threadId);

    const verified = verify(vault, threadId, { full: manifest.partial !== true });
    if (!verified.ok && manifest.partial !== true) {
      throw new VaultError(`imported chain failed verification at #${verified.failedAt}`);
    }
    checkLedgerSample(vault, threadId, capsules, options.sampleCapsules ?? 8);
    return {
      threadId,
      headSeq: last?.seq ?? 0,
      headHash: last?.hash ?? manifest.headHash,
      episodes: episodes.length,
      verified: verified.ok,
      manifest,
    };
  });

  // A partial import has no ancestors, so its capsules are rebuilt locally.
  if (manifest.partial) compact(vault, result.threadId);
  return result;
}

/**
 * KERNEL A7: recompute `dropped()` for a sample of leaf capsules straight from
 * the episodes and refuse the import if the bundled ledger disagrees.
 */
function checkLedgerSample(
  vault: Vault,
  threadId: string,
  capsules: readonly StoredCapsule[],
  sample: number,
): void {
  const leaves = capsules.filter((c) => c.level === 0);
  if (leaves.length === 0 || sample <= 0) return;
  const step = Math.max(1, Math.floor(leaves.length / sample));
  for (let i = 0; i < leaves.length; i += step) {
    const capsule = leaves[i] as StoredCapsule;
    const episodes = vault.episodes.range(threadId, capsule.fromSeq, capsule.toSeq);
    if (episodes.length === 0) continue;
    if (episodes.some((e) => e.meta.removed === true)) continue;
    const source = episodes.flatMap((e) => sourceNamesOfEpisode(e.seq, e.content));
    for (const atom of vault.atoms.inRange(threadId, capsule.fromSeq, capsule.toSeq)) {
      source.push({ name: normalizeName(atom.key, "atom"), kind: "atom", seq: atom.sourceSeq });
      source.push({ name: normalizeName(atom.value, "atom"), kind: "atom", seq: atom.sourceSeq });
    }
    const recomputed = new Set(deriveLedger(source, capsule.text).dropped.map((d) => d.name));
    const stored = new Set(capsule.dropped.map((d) => d.name));
    for (const name of recomputed) {
      if (!stored.has(name)) {
        throw new VaultError(
          `bundle ledger disagrees with episodes for capsule ${capsule.id}: "${name}" is missing`,
        );
      }
    }
  }
}

function insertRow(vault: Vault, table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  vault.db.prepare(sql).run(...(keys.map((k) => row[k] ?? null) as never[]));
}

function jsonl(rows: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(rows.map((row) => JSON.stringify(row)).join("\n"));
}

function parseJsonl<T>(bytes: Uint8Array | undefined): T[] {
  if (bytes === undefined || bytes.length === 0) return [];
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export type { Atom, Capsule, LossEntry };
