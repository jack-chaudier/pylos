import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBlobPromotion,
  discardBlobPromotion,
  stageBlobBytesForPromotion,
} from "../src/blob-pending.ts";
import { BUNDLE_MAGIC } from "../src/bundle.ts";
import * as core from "../src/index.ts";
import { canonicalJson } from "../src/pure/canonical.ts";
import { unzip, zip } from "../src/zip.ts";
import { cleanup, tempVault } from "./helpers.ts";

interface StreamOptions {
  passphrase: string;
  range?: [number, number];
  includePacketMessages?: boolean;
  limits?: Partial<core.BundleLimits>;
  onProgress?: (progress: core.BundleProgress) => void;
  transferDeadlineMs?: number;
}

interface StreamModule {
  exportBundleStream?: (
    vault: unknown,
    threadId: string,
    options: StreamOptions,
  ) => ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
  importBundleStream?: (
    vault: unknown,
    stream: ReadableStream<Uint8Array>,
    options: StreamOptions & { threadId?: string },
  ) => Promise<{ threadId: string; headSeq: number; headHash: string; episodes: number; verified: boolean }>;
}

const kernel = core as unknown as StreamModule;
const streamHomes: string[] = [];
const CORE_URL = new URL("../src/index.ts", import.meta.url).href;
const BLOB_PENDING_URL = new URL("../src/blob-pending.ts", import.meta.url).href;

function freshVault(): core.Vault {
  const home = mkdtempSync(join(tmpdir(), "pylos-stream-import-"));
  streamHomes.push(home);
  return core.openVault({ home, fast: true });
}

afterAll(() => {
  cleanup();
  for (const home of streamHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function streamValue(
  value: ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>,
): Promise<ReadableStream<Uint8Array>> {
  return await value;
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ chunks: Uint8Array[]; max: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let max = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      chunks.push(chunk.slice());
      max = Math.max(max, chunk.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
  return { chunks, max };
}

async function exportWithProgress(
  vault: core.Vault,
  threadId: string,
  passphrase: string,
): Promise<{ encoded: { chunks: Uint8Array[]; max: number }; progress: core.BundleProgress[] }> {
  const progress: core.BundleProgress[] = [];
  const exportStream = requireExportStream();
  const stream = await streamValue(
    exportStream?.(vault, threadId, { passphrase, onProgress: (entry) => progress.push(entry) }) as
      | ReadableStream<Uint8Array>
      | Promise<ReadableStream<Uint8Array>>,
  );
  return { encoded: await readStream(stream), progress };
}

function chunkStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk.slice());
    },
  });
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function filesContaining(root: string, marker: Uint8Array): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && Buffer.from(readFileSync(path)).includes(marker)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function frameNonce(base: Uint8Array, counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(base, 0);
  new DataView(nonce.buffer).setUint32(8, counter, true);
  return nonce;
}

interface TestBundleHeader {
  v: 1 | 2;
  salt: string;
  nonce: string;
}

async function testBundleKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 600_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function decryptLegacyArchive(bundle: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const headerLength = view.getUint32(BUNDLE_MAGIC.length, true);
  const headerStart = BUNDLE_MAGIC.length + 4;
  const headerBytes = bundle.slice(headerStart, headerStart + headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as TestBundleHeader;
  expect(header.v).toBe(1);
  const key = await testBundleKey(passphrase, new Uint8Array(Buffer.from(header.salt, "base64")));
  const nonce = new Uint8Array(Buffer.from(header.nonce, "base64"));
  const plain: Uint8Array[] = [];
  let pointer = headerStart + headerLength;
  let counter = 0;
  for (;;) {
    const length = view.getUint32(pointer, true);
    pointer += 4;
    if (length === 0) return concatBytes(plain);
    plain.push(
      new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: frameNonce(nonce, counter) as BufferSource,
            additionalData: headerBytes as BufferSource,
          },
          key,
          bundle.subarray(pointer, pointer + length) as BufferSource,
        ),
      ),
    );
    pointer += length;
    counter += 1;
  }
}

async function decryptBundleEntries(
  bundle: Uint8Array,
  passphrase: string,
): Promise<Array<{ name: string; data: Uint8Array }>> {
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const headerLength = view.getUint32(BUNDLE_MAGIC.length, true);
  const headerStart = BUNDLE_MAGIC.length + 4;
  const headerBytes = bundle.slice(headerStart, headerStart + headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as TestBundleHeader;
  const key = await testBundleKey(passphrase, new Uint8Array(Buffer.from(header.salt, "base64")));
  const nonce = new Uint8Array(Buffer.from(header.nonce, "base64"));
  const plain: Uint8Array[] = [];
  let pointer = headerStart + headerLength;
  let counter = 0;
  for (;;) {
    const length = view.getUint32(pointer, true);
    pointer += 4;
    if (length === 0) break;
    plain.push(
      new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: frameNonce(nonce, counter) as BufferSource,
            additionalData: headerBytes as BufferSource,
          },
          key,
          bundle.subarray(pointer, pointer + length) as BufferSource,
        ),
      ),
    );
    pointer += length;
    counter += 1;
  }
  const archive = concatBytes(plain);
  return header.v === 1
    ? [...zipEntries(archive)].map(([name, data]) => ({ name, data }))
    : framedEntries(archive);
}

async function rewriteBundleWithoutObject(
  bundle: Uint8Array,
  passphrase: string,
  objectHash: string,
): Promise<Uint8Array> {
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const headerLength = view.getUint32(BUNDLE_MAGIC.length, true);
  const headerStart = BUNDLE_MAGIC.length + 4;
  const headerBytes = bundle.slice(headerStart, headerStart + headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as TestBundleHeader;
  const salt = new Uint8Array(Buffer.from(header.salt, "base64"));
  const nonce = new Uint8Array(Buffer.from(header.nonce, "base64"));
  const key = await testBundleKey(passphrase, salt);
  const plain: Uint8Array[] = [];
  let pointer = headerStart + headerLength;
  let counter = 0;
  for (;;) {
    const length = view.getUint32(pointer, true);
    pointer += 4;
    if (length === 0) break;
    plain.push(
      new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: frameNonce(nonce, counter) as BufferSource,
            additionalData: headerBytes as BufferSource,
          },
          key,
          bundle.subarray(pointer, pointer + length) as BufferSource,
        ),
      ),
    );
    pointer += length;
    counter += 1;
  }

  const archive = concatBytes(plain);
  const entries =
    header.v === 1
      ? [...zipEntries(archive)].map(([name, data]) => ({ name, data }))
      : framedEntries(archive);
  const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
  if (manifestEntry === undefined) throw new Error("test bundle has no manifest");
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as {
    files: Record<string, string>;
  };
  delete manifest.files[`objects/${objectHash}`];
  manifestEntry.data = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const kept = entries.filter((entry) => entry.name !== `objects/${objectHash}`);
  const rewrittenArchive = header.v === 1 ? zip(kept) : frameEntries(kept);

  const output: Uint8Array[] = [
    new TextEncoder().encode(BUNDLE_MAGIC),
    bundle.slice(BUNDLE_MAGIC.length, headerStart),
    headerBytes,
  ];
  counter = 0;
  for (let offset = 0; offset < rewrittenArchive.byteLength; offset += 1024 * 1024) {
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: frameNonce(nonce, counter) as BufferSource,
          additionalData: headerBytes as BufferSource,
        },
        key,
        rewrittenArchive.subarray(
          offset,
          Math.min(offset + 1024 * 1024, rewrittenArchive.byteLength),
        ) as BufferSource,
      ),
    );
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, cipher.byteLength, true);
    output.push(length, cipher);
    counter += 1;
  }
  output.push(new Uint8Array(4));
  return concatBytes(output);
}

async function rewriteBundleJsonl(
  bundle: Uint8Array,
  passphrase: string,
  entryName:
    | "manifest.json"
    | "episodes.jsonl"
    | "atoms.jsonl"
    | "capsules.jsonl"
    | "loss.jsonl"
    | "packets.jsonl"
    | "tombstones.jsonl"
    | "address-routes.jsonl"
    | "address-aliases.jsonl"
    | "atomization-receipts.jsonl"
    | "capsule-ledger-entries.jsonl",
  rewrite: (
    row: Record<string, unknown>,
    rows: Record<string, unknown>[],
  ) => Record<string, unknown> | Record<string, unknown>[],
  replaceAll = false,
): Promise<Uint8Array> {
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const headerLength = view.getUint32(BUNDLE_MAGIC.length, true);
  const headerStart = BUNDLE_MAGIC.length + 4;
  const headerBytes = bundle.slice(headerStart, headerStart + headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as TestBundleHeader;
  const salt = new Uint8Array(Buffer.from(header.salt, "base64"));
  const nonce = new Uint8Array(Buffer.from(header.nonce, "base64"));
  const key = await testBundleKey(passphrase, salt);
  const plain: Uint8Array[] = [];
  let pointer = headerStart + headerLength;
  let counter = 0;
  for (;;) {
    const length = view.getUint32(pointer, true);
    pointer += 4;
    if (length === 0) break;
    plain.push(
      new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: frameNonce(nonce, counter) as BufferSource,
            additionalData: headerBytes as BufferSource,
          },
          key,
          bundle.subarray(pointer, pointer + length) as BufferSource,
        ),
      ),
    );
    pointer += length;
    counter += 1;
  }

  const archive = concatBytes(plain);
  const entries =
    header.v === 1
      ? [...zipEntries(archive)].map(([name, data]) => ({ name, data: data.slice() }))
      : framedEntries(archive);
  const target = entries.find((entry) => entry.name === entryName);
  const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
  if (target === undefined || manifestEntry === undefined) throw new Error("test bundle is incomplete");
  let rows: Record<string, unknown>[];
  if (entryName === "manifest.json") {
    const parsed = JSON.parse(new TextDecoder().decode(target.data)) as Record<string, unknown>;
    const replacement = rewrite(parsed, [parsed]);
    if (Array.isArray(replacement)) throw new Error("manifest rewrite returned multiple rows");
    rows = [replacement];
    target.data = new TextEncoder().encode(JSON.stringify(replacement, null, 2));
  } else {
    rows = new TextDecoder()
      .decode(target.data)
      .trimEnd()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const first = rows[0] ?? {};
    const replacement = rewrite(first, rows);
    if (replaceAll || rows.length === 0) rows = Array.isArray(replacement) ? replacement : [replacement];
    else rows.splice(0, 1, ...(Array.isArray(replacement) ? replacement : [replacement]));
    target.data = new TextEncoder().encode(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as {
    files: Record<string, string>;
    counts: { episodes: number; atoms: number; capsules: number; loss: number; packets: number };
    countsExtended?: {
      addressRoutes: number;
      addressAliases: number;
      tombstones?: number;
      atomizationReceipts?: number;
      capsuleLedgerEntries?: number;
    };
  };
  if (entryName !== "manifest.json") {
    manifest.files[entryName] = core.sha256(target.data);
    const countKey =
      entryName === "episodes.jsonl"
        ? "episodes"
        : entryName === "atoms.jsonl"
          ? "atoms"
          : entryName === "capsules.jsonl"
            ? "capsules"
            : entryName === "loss.jsonl"
              ? "loss"
              : entryName === "packets.jsonl"
                ? "packets"
                : null;
    if (countKey === null) {
      if (manifest.countsExtended === undefined) throw new Error("manifest has no extended counts");
      if (entryName === "address-routes.jsonl") manifest.countsExtended.addressRoutes = rows.length;
      else if (entryName === "address-aliases.jsonl") manifest.countsExtended.addressAliases = rows.length;
      else if (entryName === "tombstones.jsonl") manifest.countsExtended.tombstones = rows.length;
      else if (entryName === "atomization-receipts.jsonl")
        manifest.countsExtended.atomizationReceipts = rows.length;
      else if (entryName === "capsule-ledger-entries.jsonl")
        manifest.countsExtended.capsuleLedgerEntries = rows.length;
      else throw new Error(`no count field for ${entryName}`);
    } else {
      manifest.counts[countKey] = rows.length;
    }
    manifestEntry.data = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  }
  const rewrittenArchive = header.v === 1 ? zip(entries) : frameEntries(entries);

  const output: Uint8Array[] = [
    new TextEncoder().encode(BUNDLE_MAGIC),
    bundle.slice(BUNDLE_MAGIC.length, headerStart),
    headerBytes,
  ];
  counter = 0;
  for (let offset = 0; offset < rewrittenArchive.byteLength; offset += 1024 * 1024) {
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: frameNonce(nonce, counter) as BufferSource,
          additionalData: headerBytes as BufferSource,
        },
        key,
        rewrittenArchive.subarray(
          offset,
          Math.min(offset + 1024 * 1024, rewrittenArchive.byteLength),
        ) as BufferSource,
      ),
    );
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, cipher.byteLength, true);
    output.push(length, cipher);
    counter += 1;
  }
  output.push(new Uint8Array(4));
  return concatBytes(output);
}

function derivedRowFixture(): { vault: core.Vault; threadId: string } {
  const { vault, thread } = tempVault();
  const capsuleText = "Fixture Person lives in Lisbon.";
  const source = vault.episodes.append(thread.id, { role: "user", content: capsuleText });
  core.atomize(vault, thread.id, [source.seq]);
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 31 }, (_, index) => ({
      role: "assistant" as const,
      content: `filler ${index + 2}`,
    })),
  );
  core.compact(vault, thread.id);
  const capsule = vault.capsules.at(thread.id, 0, 1);
  if (capsule === null) throw new Error("derived row fixture did not seal its leaf");
  vault.losses.add(thread.id, capsule.id, 0, [{ name: "fixture-loss", kind: "entity", seq: source.seq }]);
  vault.db
    .query(
      "INSERT INTO address_alias (id, thread_id, alias, source_seq, byte_from, byte_to, source_hash, quote_hash, authority, status, created_at) " +
        "VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'model', 'proposed', 1)",
    )
    .run(
      "fixture-alias",
      thread.id,
      "fixture",
      source.seq,
      new TextEncoder().encode(capsuleText).byteLength,
      core.sha256(capsuleText),
      core.sha256(new TextEncoder().encode(capsuleText)),
    );
  return { vault, threadId: thread.id };
}

function expectNoImportedDerivedRows(vault: core.Vault, threadId: string): void {
  expect(vault.threads.get(threadId)).toBeNull();
  for (const table of ["atom", "atom_name", "capsule", "loss"] as const) {
    const row = vault.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    expect(row.count).toBe(0);
  }
}

function zipEntries(archive: Uint8Array): Map<string, Uint8Array> {
  return unzip(archive);
}

function framedEntries(archive: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let pointer = 7;
  for (;;) {
    const nameLength = view.getUint32(pointer, true);
    pointer += 4;
    if (nameLength === 0) return entries;
    const size = Number(view.getBigUint64(pointer, true));
    pointer += 8 + 64;
    const name = new TextDecoder().decode(archive.subarray(pointer, pointer + nameLength));
    pointer += nameLength;
    entries.push({ name, data: archive.slice(pointer, pointer + size) });
    pointer += size;
  }
}

function frameEntries(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [new TextEncoder().encode("PYLOS2\n")];
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const header = new Uint8Array(4 + 8 + 64);
    const view = new DataView(header.buffer);
    view.setUint32(0, name.byteLength, true);
    view.setBigUint64(4, BigInt(entry.data.byteLength), true);
    header.set(new TextEncoder().encode(core.sha256(entry.data)), 12);
    parts.push(header, name, entry.data);
  }
  parts.push(new Uint8Array(4));
  return concatBytes(parts);
}

/** Build the smallest authenticated v1 envelope whose ZIP entry decompresses
 * just over the 64 MiB legacy compatibility ceiling. The importer must reject
 * it from the declared ZIP size before asking zlib for a large output buffer. */
async function oversizedLegacyBundle(passphrase: string): Promise<Uint8Array> {
  const padding = new Uint8Array(64 * 1024 * 1024 + 1);
  const archive = zip([{ name: "padding.bin", data: padding }]);
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const nonce = Uint8Array.from({ length: 8 }, (_, index) => index + 17);
  const header = {
    v: 1,
    kdf: "pbkdf2-sha256",
    iters: 600_000,
    salt: Buffer.from(salt).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    threadId: "legacy-cap-oracle",
    headSeq: 0,
    headHash: core.genesisHash("legacy-cap-oracle"),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 600_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: frameNonce(nonce, 0) as BufferSource,
        additionalData: headerBytes as BufferSource,
      },
      key,
      archive as BufferSource,
    ),
  );
  const headerLength = new Uint8Array(4);
  new DataView(headerLength.buffer).setUint32(0, headerBytes.byteLength, true);
  const frameLength = new Uint8Array(4);
  new DataView(frameLength.buffer).setUint32(0, cipher.byteLength, true);
  return concatBytes([
    new TextEncoder().encode(BUNDLE_MAGIC),
    headerLength,
    headerBytes,
    frameLength,
    cipher,
    new Uint8Array(4),
  ]);
}

function requireExportStream(): StreamModule["exportBundleStream"] {
  expect(typeof kernel.exportBundleStream).toBe("function");
  return kernel.exportBundleStream;
}

function requireImportStream(): StreamModule["importBundleStream"] {
  expect(typeof kernel.importBundleStream).toBe("function");
  return kernel.importBundleStream;
}

function forgedWholeAttachment(): { vault: core.Vault; threadId: string } {
  const { vault, thread } = tempVault();
  const actual = Uint8Array.from({ length: 130_000 }, (_, index) => (index * 29 + 3) & 0xff);
  const valid = core.buildAttachmentManifest(actual, "application/octet-stream", "forged.bin", (span, mime) =>
    vault.blobs.put(span, mime),
  );
  const decoy = new TextEncoder().encode("authenticated decoy bytes, not the attachment spans");
  const decoyHash = vault.blobs.put(decoy, "application/octet-stream");
  const forged = { ...valid, hash: decoyHash };
  forged.digest = core.manifestDigestOf(forged);
  vault.episodes.append(thread.id, {
    role: "attachment",
    content: "forged.bin",
    meta: {
      blob: decoyHash,
      manifest: forged,
      mime: "application/octet-stream",
      name: "forged.bin",
      size: actual.byteLength,
    },
  });
  return { vault, threadId: thread.id };
}

async function expectForgedWholeRejected(format: "v2" | "v1"): Promise<void> {
  const { vault, threadId } = forgedWholeAttachment();
  const passphrase = `forged whole ${format}`;
  const bundle =
    format === "v2"
      ? await core.exportBundle(vault, threadId, { passphrase })
      : await core.exportBundleV1(vault, threadId, { passphrase });
  const target = freshVault();
  const sentinel = target.threads.create("sentinel");
  target.episodes.append(sentinel.id, { role: "user", content: "keep me" });
  const beforeThreads = target.threads.list();
  const beforeObjects = target.blobs.list();
  const beforeFiles = readdirSync(target.objectsDir).sort();

  await expect(core.importBundle(target, bundle, { passphrase })).rejects.toThrow(/whole-object hash/);
  expect(target.threads.list()).toEqual(beforeThreads);
  expect(target.blobs.list()).toEqual(beforeObjects);
  expect(readdirSync(target.objectsDir).sort()).toEqual(beforeFiles);
  expect(target.episodes.count(sentinel.id)).toBe(1);
}

async function expectMissingWholeRejected(format: "v2" | "v1"): Promise<void> {
  const { vault, thread } = tempVault();
  const actual = Uint8Array.from({ length: 130_000 }, (_, index) => (index * 31 + 11) & 0xff);
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "missing-whole.bin",
    blob: { bytes: actual, mime: "application/octet-stream", name: "missing-whole.bin" },
  });
  const wholeHash = attachment.meta.blob as string;
  expect(attachment.meta.manifest?.spans.length).toBeGreaterThan(1);
  const passphrase = `missing whole ${format}`;
  const complete =
    format === "v2"
      ? await core.exportBundle(vault, thread.id, { passphrase })
      : await core.exportBundleV1(vault, thread.id, { passphrase });
  const bundle = await rewriteBundleWithoutObject(complete, passphrase, wholeHash);
  const target = freshVault();
  const sentinel = target.threads.create("sentinel");
  target.episodes.append(sentinel.id, { role: "user", content: "keep me" });
  const beforeThreads = target.threads.list();
  const beforeObjects = target.blobs.list();
  const beforeFiles = readdirSync(target.objectsDir).sort();

  await expect(core.importBundle(target, bundle, { passphrase })).rejects.toThrow(/whole attachment object/);
  expect(target.threads.list()).toEqual(beforeThreads);
  expect(target.blobs.list()).toEqual(beforeObjects);
  expect(readdirSync(target.objectsDir).sort()).toEqual(beforeFiles);
  expect(target.episodes.count(sentinel.id)).toBe(1);
}

async function expectGroundedAttachmentRoundTrip(): Promise<void> {
  const { vault, thread } = tempVault();
  const marker = "BUNDLE_GROUNDED_ATTACHMENT_V2";
  const answer = `The final attachment marker is ${marker}.`;
  const content = `${"indexed attachment evidence row\n".repeat(3_000)}${answer}`;
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes: new TextEncoder().encode(content), mime: "text/plain", name: "grounded-v2.txt" },
  });
  const question = "What is the final marker in grounded-v2.txt?";
  const provider: core.Provider = async function* (request) {
    const capability = request.evidence?.find(
      (candidate) => candidate.authority === "attachment" && candidate.seq === attachment.seq,
    );
    if (capability === undefined) throw new Error("attachment evidence capability missing");
    yield { type: "delta", text: answer };
    yield {
      type: "tool_call",
      id: "bundle-grounded-v2",
      name: "submit_claim_map",
      arguments: JSON.stringify({
        claims: [{ outputSpan: [0, answer.length], capabilityTokens: [capability.token] }],
      }),
    };
    yield { type: "done" };
  };
  const grounded = await core.runTurn(vault, thread.id, {
    text: question,
    model: "bundle-grounded-oracle",
    provider,
    budget: 8_192,
  });
  const supported = grounded.assistantEpisode.meta.answerReceipt?.classifications.find(
    (entry) => entry.classification === "SUPPORTED" && entry.evidenceWitness?.source.startsWith("blob:"),
  );
  expect(supported?.evidenceWitness?.seq).toBe(attachment.seq);
  expect(vault.addresses.active(thread.id, question)).toHaveLength(1);

  const passphrase = "grounded attachment v2";
  const bundle = await core.exportBundle(vault, thread.id, { passphrase });
  const target = freshVault();
  const imported = await core.importBundle(target, bundle, { passphrase });
  expect(imported.verified).toBe(true);
  expect(core.verify(target, thread.id, { full: true }).ok).toBe(true);
  const routes = target.addresses.active(thread.id, question);
  expect(routes).toHaveLength(1);
  const reused = target.addresses.reuse(thread.id, question, routes[0]?.routerVersion ?? "");
  expect(reused.reused).toBe(true);
  expect(reused.route?.witnesses[0]?.source).toBe(supported?.evidenceWitness?.source);
  expect(
    target.episodes.get(thread.id, grounded.assistantEpisode.seq)?.meta.answerReceipt?.classifications[0]
      ?.evidenceWitness?.source,
  ).toBe(supported?.evidenceWitness?.source);
}

test("stream export/import stays chunked and restores a multi-megabyte object exactly", async () => {
  const { vault, thread } = tempVault();
  const bytes = Uint8Array.from({ length: 2_400_000 }, (_, i) => (i * 97 + 11) & 0xff);
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "archive.bin",
    blob: { bytes, mime: "application/octet-stream", name: "archive.bin" },
  });
  const before = vault.threads.get(thread.id);
  const exportStream = requireExportStream();
  const importStream = requireImportStream();
  expect(exportStream).toBeDefined();
  expect(importStream).toBeDefined();
  const stream = await streamValue(
    exportStream?.(vault, thread.id, { passphrase: "stream password" }) as
      | ReadableStream<Uint8Array>
      | Promise<ReadableStream<Uint8Array>>,
  );
  expect(stream).toBeInstanceOf(ReadableStream);
  const encoded = await readStream(stream);
  expect(encoded.chunks.length).toBeGreaterThan(1);
  expect(encoded.max).toBeLessThanOrEqual(1_100_000);

  const target = freshVault();
  const imported = await importStream?.(target, chunkStream(encoded.chunks), {
    passphrase: "stream password",
  });
  expect(imported?.verified).toBe(true);
  expect(imported?.headSeq).toBe(before?.headSeq);
  expect(imported?.headHash).toBe(before?.headHash);
  expect(target.episodes.count(imported?.threadId as string)).toBe(attachment.seq);
  const restored = target.episodes.get(imported?.threadId as string, attachment.seq);
  expect(restored?.meta.blob).toBe(core.sha256(bytes));
  expect(target.blobs.get(core.sha256(bytes))).toEqual(bytes);
});

test("a legacy whole-blob attachment imports as one verified opaque span", async () => {
  const { vault, thread } = tempVault();
  const bytes = Uint8Array.from([0x00, 0xff, 0x10, 0x80, 0xfe, 0x01, 0x00]);
  const hash = vault.blobs.put(bytes, "application/octet-stream");
  // This is the v1 shape: the attachment episode names a whole object through
  // meta.blob, with no A12 manifest or span partition.
  const legacy = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "legacy.bin",
    meta: { blob: hash, mime: "application/octet-stream", name: "legacy.bin", size: bytes.length },
  });
  const importedVault = freshVault();
  const bundle = await core.exportBundle(vault, thread.id, { passphrase: "legacy password" });
  const imported = await core.importBundle(importedVault, bundle, { passphrase: "legacy password" });
  const restored = importedVault.episodes.get(imported.threadId, legacy.seq);
  const metadata = restored?.meta as Record<string, unknown>;
  const manifest = metadata.manifest as Record<string, unknown>;
  expect(manifest.hash).toBe(hash);
  expect(manifest.size).toBe(bytes.length);
  const spans = manifest.spans as Array<Record<string, unknown>>;
  expect(spans).toHaveLength(1);
  expect(spans[0]).toMatchObject({ from: 0, to: bytes.length, hash, state: "opaque" });
  expect(importedVault.blobs.get(hash)).toEqual(bytes);
});

test("grounded attachment receipts and active routes survive the default v2 bundle import", async () => {
  await expectGroundedAttachmentRoundTrip();
});

test("legacy v1 refuses scoped address state before materializing an archive", async () => {
  for (const kind of ["route", "alias"] as const) {
    const { vault, thread } = tempVault();
    const source = vault.episodes.append(thread.id, {
      role: "user",
      content: `The ${kind} continuity marker is Alder.`,
    });
    expect(
      (
        vault.db.query("SELECT COUNT(*) AS count FROM packet WHERE thread_id = ?").get(thread.id) as {
          count: number;
        }
      ).count,
    ).toBe(0);

    if (kind === "route") {
      const question = vault.episodes.append(thread.id, {
        role: "user",
        content: "What is the continuity marker?",
      });
      const witness = core.witnessForEpisode(vault, thread.id, source.seq);
      if (witness === null) throw new Error("route refusal fixture witness was not resident");
      const canonical = core.canonicalAddressQuery(question.content);
      const routerVersion = "legacy-refusal-oracle";
      vault.db
        .query(
          "INSERT INTO address_route (id, thread_id, query_digest, normalized_query, router_version, question_seq, " +
            "answer_seq, packet_id, packet_digest, source_seqs, witnesses, route_digest, status, reason, invalidated_by, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 'active', NULL, NULL, ?)",
        )
        .run(
          `legacy-refusal-${kind}`,
          thread.id,
          canonical.digest,
          canonical.normalized,
          routerVersion,
          question.seq,
          JSON.stringify([source.seq]),
          JSON.stringify([witness]),
          core.addressRouteDigestOf(canonical.digest, routerVersion, [witness]),
          Date.now(),
        );
    } else {
      expect(
        vault.aliases.propose(thread.id, {
          alias: "alder continuity marker",
          sourceSeq: source.seq,
          span: [0, new TextEncoder().encode(source.content).byteLength],
          quote: source.content,
          sourceHash: core.sha256(source.content),
        }).accepted,
      ).toBe(true);
    }

    const episodes = vault.episodes as unknown as {
      range: typeof vault.episodes.range;
    };
    const originalRange = episodes.range;
    let materialized = false;
    episodes.range = (...args) => {
      materialized = true;
      return originalRange.apply(vault.episodes, args);
    };
    try {
      await expect(
        core.exportBundleV1(vault, thread.id, { passphrase: "legacy address refusal" }),
      ).rejects.toThrow(/use v2/i);
    } finally {
      episodes.range = originalRange;
    }
    expect(materialized).toBe(false);
  }
});

test("legacy v1 emits only historical packet columns and refuses newer receipts", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "legacy packet" });
  vault.db
    .query(
      "INSERT INTO packet (id, thread_id, turn_seq, model, budget, tokens, digest, status, compiler_version, " +
        "messages, resident, ledger, pages, rounds, created_at) VALUES (?, ?, 1, 'legacy-model', 8192, 1, ?, " +
        "'done', '1', NULL, '[]', '{\"count\":0,\"residentNames\":[],\"historical\":[]}', '[]', NULL, 1)",
    )
    .run("legacy-packet", thread.id, "a".repeat(64));
  const passphrase = "historical packet reader";
  const bundle = await core.exportBundleV1(vault, thread.id, { passphrase });
  const archive = unzip(await decryptLegacyArchive(bundle, passphrase));
  const row = JSON.parse(new TextDecoder().decode(archive.get("packets.jsonl")).trim()) as Record<
    string,
    unknown
  >;
  expect(row).not.toHaveProperty("reachability");
  expect(row).not.toHaveProperty("reachability_as_of_seq");
  expect(row).not.toHaveProperty("coverage");
  expect(row).not.toHaveProperty("evidence");
  expect(row).not.toHaveProperty("answer_receipt");
  expect(row).not.toHaveProperty("semantic");
  const historical = new Database(":memory:");
  try {
    historical.exec(
      "CREATE TABLE packet (id TEXT, thread_id TEXT, turn_seq INTEGER, model TEXT, budget INTEGER, " +
        "tokens INTEGER, digest TEXT, status TEXT, compiler_version TEXT, messages TEXT, resident TEXT, " +
        "ledger TEXT, pages TEXT, rounds TEXT, created_at INTEGER)",
    );
    historical
      .query(
        "INSERT INTO packet (id, thread_id, turn_seq, model, budget, tokens, digest, status, compiler_version, " +
          "messages, resident, ledger, pages, rounds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id as string,
        row.thread_id as string,
        row.turn_seq as number,
        row.model as string,
        row.budget as number,
        row.tokens as number,
        row.digest as string,
        row.status as string,
        row.compiler_version as string,
        (row.messages as string | null) ?? null,
        row.resident as string,
        row.ledger as string,
        row.pages as string,
        (row.rounds as string | null) ?? null,
        row.created_at as number,
      );
    expect((historical.query("SELECT COUNT(*) AS count FROM packet").get() as { count: number }).count).toBe(
      1,
    );
  } finally {
    historical.close();
  }

  const current = freshVault();
  const imported = await core.importBundle(current, bundle, { passphrase });
  const restored = current.packets.get(imported.threadId, 1);
  expect(restored?.status).toBe("done");
  expect(
    (
      current.db
        .query("SELECT compiler_version FROM packet WHERE thread_id = ? AND turn_seq = 1")
        .get(imported.threadId) as { compiler_version: string }
    ).compiler_version,
  ).toBe("1");
  expect(restored?.answerReceipt).toBeUndefined();
  expect(core.verify(current, imported.threadId, { full: true }).ok).toBe(true);

  for (const field of [
    "reachability",
    "reachability_as_of_seq",
    "coverage",
    "evidence",
    "answer_receipt",
    "semantic",
  ] as const) {
    vault.db
      .query(`UPDATE packet SET ${field} = ? WHERE id = ?`)
      .run(field === "reachability_as_of_seq" ? 1 : "{}", "legacy-packet");
    await expect(core.exportBundleV1(vault, thread.id, { passphrase })).rejects.toThrow(/use v2/);
    vault.db.query(`UPDATE packet SET ${field} = NULL WHERE id = ?`).run("legacy-packet");
  }
});

test("v1 and v2 writers reject ranges outside the authenticated head", async () => {
  for (const version of ["v2", "v1"] as const) {
    const { vault, thread } = tempVault();
    vault.episodes.append(thread.id, { role: "user", content: "one row" });
    const write = (range: [number, number]): Promise<Uint8Array> =>
      version === "v2"
        ? core.exportBundle(vault, thread.id, { passphrase: "range", range })
        : core.exportBundleV1(vault, thread.id, { passphrase: "range", range });
    for (const range of [
      [0, 1],
      [2, 1],
      [1, 2],
    ] as [number, number][]) {
      await expect(write(range)).rejects.toThrow(/range is outside the authenticated thread head/);
    }
    const empty = freshVault();
    const emptyThread = empty.threads.create("empty");
    const emptyWrite =
      version === "v2"
        ? core.exportBundle(empty, emptyThread.id, { passphrase: "range", range: [1, 1] })
        : core.exportBundleV1(empty, emptyThread.id, { passphrase: "range", range: [1, 1] });
    await expect(emptyWrite).rejects.toThrow(/range is outside the authenticated thread head/);
  }
});

test("a registered import promotion rolls back its rows and staged bytes together", () => {
  const target = freshVault();
  const bytes = new TextEncoder().encode("promotion rollback bytes");
  const hash = core.sha256(bytes);
  const promotion = createBlobPromotion(target.objectsDir);
  stageBlobBytesForPromotion(promotion, bytes, hash);
  expect(() =>
    target.txWithPendingBlobPromotion(promotion, () => {
      target.db
        .query("INSERT INTO blob (hash, mime, size, created_at) VALUES (?, ?, ?, ?)")
        .run(hash, "text/plain", bytes.byteLength, Date.now());
      target.threads.create("must roll back");
      throw new Error("late import verification failure");
    }),
  ).toThrow(/late import verification failure/);
  expect(target.db.query("SELECT 1 FROM blob WHERE hash = ?").get(hash)).toBeNull();
  expect(target.threads.list()).toHaveLength(0);
  expect(existsSync(join(target.objectsDir, hash))).toBe(false);
  expect(existsSync(join(target.objectsDir, ".pending"))).toBe(false);
});

test("a nested transaction cannot register an import promotion outside its rollback snapshot", () => {
  const target = freshVault();
  const promotion = createBlobPromotion(target.objectsDir);
  try {
    target.tx(() => {
      expect(() => target.txWithPendingBlobPromotion(promotion, () => undefined)).toThrow(
        /requires a root transaction/,
      );
    });
  } finally {
    discardBlobPromotion(promotion);
  }
  expect(existsSync(join(target.objectsDir, ".pending"))).toBe(false);
});

test("partial imports never synthesize capsules outside their authenticated fragment", async () => {
  for (const format of ["v2", "v1"] as const) {
    const { vault, thread } = tempVault();
    vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 4200 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `partial-${format}-${index}`,
      })),
    );
    const passphrase = `partial compact ${format}`;
    const bundle =
      format === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase, range: [4097, 4100] })
        : await core.exportBundleV1(vault, thread.id, { passphrase, range: [4097, 4100] });
    const target = freshVault();
    const imported = await core.importBundle(target, bundle, { passphrase });
    expect(imported.manifest.partial).toBe(true);
    expect(imported.fragmentVerified).toBe(true);
    expect(target.episodes.count(imported.threadId)).toBe(4);
    expect(
      (
        target.db
          .query("SELECT COUNT(*) AS count FROM capsule WHERE thread_id = ?")
          .get(imported.threadId) as {
          count: number;
        }
      ).count,
    ).toBe(0);
  }
});

test("partial v1 and v2 exports omit pre-fragment capsule and tombstone secrets", async () => {
  for (const format of ["v2", "v1"] as const) {
    const { vault, thread } = tempVault();
    const episodes = vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 64 }, (_, index) => ({
        role: "user" as const,
        content:
          index === 0
            ? "forget this early source"
            : index === 1
              ? "CAPSULE_SECRET_BEFORE_FRAGMENT"
              : `ordinary row ${index + 1}`,
      })),
    );
    core.compact(vault, thread.id);
    core.forget(vault, thread.id, {
      seqs: [episodes[0]?.seq ?? 1],
      reason: "TOMBSTONE_SECRET_BEFORE_FRAGMENT",
    });
    const passphrase = `partial privacy ${format}`;
    const bundle =
      format === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase, range: [33, 64] })
        : await core.exportBundleV1(vault, thread.id, { passphrase, range: [33, 64] });
    const entries = await decryptBundleEntries(bundle, passphrase);
    const decoded = entries.map((entry) => new TextDecoder().decode(entry.data)).join("\n");
    expect(decoded).not.toContain("CAPSULE_SECRET_BEFORE_FRAGMENT");
    expect(decoded).not.toContain("TOMBSTONE_SECRET_BEFORE_FRAGMENT");
    const capsules = entries.find((entry) => entry.name === "capsules.jsonl");
    const tombstones = entries.find((entry) => entry.name === "tombstones.jsonl");
    expect(new TextDecoder().decode(capsules?.data)).not.toContain('"fromSeq":1');
    expect(new TextDecoder().decode(tombstones?.data).trim()).toBe("");
  }
}, 60_000);

test("throwing progress observers never report failure with installed v2 or v1 state", async () => {
  for (const format of ["v2", "v1"] as const) {
    const { vault, thread } = tempVault();
    const attachment = vault.episodes.append(thread.id, {
      role: "attachment",
      content: `observer-${format}.txt`,
      blob: {
        bytes: new TextEncoder().encode(`observer payload ${format}`),
        mime: "text/plain",
        name: `observer-${format}.txt`,
      },
    });
    const passphrase = `observer ${format}`;
    const bundle =
      format === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase })
        : await core.exportBundleV1(vault, thread.id, { passphrase });
    const target = freshVault();
    let loadingCallbacks = 0;
    const importing = core.importBundle(target, bundle, {
      passphrase,
      onProgress(progress) {
        if (progress.phase === "loading") loadingCallbacks += 1;
        if (
          (format === "v2" && progress.phase === "loading" && loadingCallbacks === 2) ||
          (format === "v1" && progress.phase === "installing")
        ) {
          throw new Error(`observer boom ${format}`);
        }
      },
    });
    if (format === "v2") {
      const imported = await importing;
      expect(imported.headHash).toBe(attachment.hash);
      expect(target.blobs.get(attachment.meta.blob as string)).not.toBeNull();
    } else {
      await expect(importing).rejects.toThrow(/observer boom v1/);
      expect(target.threads.list()).toHaveLength(0);
      expect(target.blobs.list()).toHaveLength(0);
      expect(readdirSync(target.objectsDir)).toEqual([]);
      const retried = await core.importBundle(target, bundle, { passphrase });
      expect(retried.headHash).toBe(attachment.hash);
    }
  }
});

test("staged v2 import rejects a manifest whose whole hash does not match its ordered spans", async () => {
  await expectForgedWholeRejected("v2");
});

test("v1 compatibility import rejects a manifest whose whole hash does not match its ordered spans", async () => {
  await expectForgedWholeRejected("v1");
});

test("staged v2 import rejects a self-consistent manifest that omits its whole object", async () => {
  await expectMissingWholeRejected("v2");
});

test("v1 compatibility import rejects a self-consistent manifest that omits its whole object", async () => {
  await expectMissingWholeRejected("v1");
});

test("late stream corruption leaves the destination vault and object store unchanged", async () => {
  const { vault, thread } = tempVault();
  const bytes = Uint8Array.from({ length: 1_800_000 }, (_, i) => (i * 17 + 5) & 0xff);
  vault.episodes.append(thread.id, {
    role: "attachment",
    content: "late.bin",
    blob: { bytes, mime: "application/octet-stream", name: "late.bin" },
  });
  const exportStream = requireExportStream();
  expect(exportStream).toBeDefined();
  const stream = await streamValue(
    exportStream?.(vault, thread.id, { passphrase: "late password" }) as
      | ReadableStream<Uint8Array>
      | Promise<ReadableStream<Uint8Array>>,
  );
  const encoded = await readStream(stream);
  const corrupt = encoded.chunks.map((chunk) => chunk.slice());
  let index = -1;
  for (let i = corrupt.length - 1; i >= 0; i -= 1) {
    if ((corrupt[i] as Uint8Array).byteLength > 64) {
      index = i;
      break;
    }
  }
  expect(index).toBeGreaterThanOrEqual(0);
  const target = freshVault();
  const sentinel = target.threads.create("sentinel");
  target.episodes.append(sentinel.id, { role: "user", content: "keep me" });
  const beforeThreads = target.threads.list();
  const beforeObjects = target.blobs.list();
  const beforeFiles = readdirSync(target.objectsDir).sort();
  const chunk = corrupt[index as number] as Uint8Array;
  chunk[Math.floor(chunk.byteLength / 2)] = (chunk[Math.floor(chunk.byteLength / 2)] as number) ^ 0xff;

  const importStream = requireImportStream();
  expect(importStream).toBeDefined();
  await expect(
    importStream?.(target, chunkStream(corrupt), { passphrase: "late password" }),
  ).rejects.toThrow();
  expect(target.threads.list()).toEqual(beforeThreads);
  expect(target.blobs.list()).toEqual(beforeObjects);
  expect(readdirSync(target.objectsDir).sort()).toEqual(beforeFiles);
  expect(target.episodes.count(sentinel.id)).toBe(1);
});

test("reopen removes plaintext staged by a killed pre-commit import", async () => {
  const { vault, thread } = tempVault();
  const bytes = Uint8Array.from({ length: 180_000 }, (_, index) => (index * 37 + 19) & 0xff);
  const marker = new TextEncoder().encode("PYLOS_KILLED_IMPORT_PLAINTEXT_MARKER");
  bytes.set(marker, 100_000);
  vault.episodes.append(thread.id, {
    role: "attachment",
    content: "kill-window.bin",
    blob: { bytes, mime: "application/octet-stream", name: "kill-window.bin" },
  });
  const passphrase = "kill-window password";
  const bundlePath = join(vault.home, "kill-window.pylos");
  writeFileSync(bundlePath, await core.exportBundle(vault, thread.id, { passphrase }));

  const targetHome = mkdtempSync(join(tmpdir(), "pylos-kill-import-"));
  streamHomes.push(targetHome);
  const initial = core.openVault({ home: targetHome });
  const sentinel = initial.threads.create("sentinel");
  initial.episodes.append(sentinel.id, { role: "user", content: "survives the crash" });
  initial.close();

  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        import { readFileSync } from "node:fs";
        const core = await import(${JSON.stringify(CORE_URL)});
        const vault = core.openVault({ home: ${JSON.stringify(targetHome)} });
        await core.importBundle(vault, readFileSync(${JSON.stringify(bundlePath)}), {
          passphrase: ${JSON.stringify(passphrase)},
          onProgress(progress) {
            if (progress.phase === "installing") process.kill(process.pid, "SIGKILL");
          },
        });
        process.exit(86);
      `,
    ],
    { cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  const exit = await child.exited;
  expect(exit, stderr).not.toBe(0);
  expect(existsSync(join(targetHome, "objects", ".import-pending"))).toBe(true);
  expect(existsSync(join(targetHome, "objects", ".pending"))).toBe(true);
  expect(filesContaining(targetHome, marker).length).toBeGreaterThan(0);

  const reopened = core.openVault({ home: targetHome });
  expect(reopened.threads.list().map((candidate) => candidate.id)).toEqual([sentinel.id]);
  expect(reopened.episodes.count(sentinel.id)).toBe(1);
  expect(reopened.blobs.list()).toEqual([]);
  expect(readdirSync(reopened.objectsDir)).toEqual([]);
  reopened.close();
  expect(existsSync(join(targetHome, "objects", ".import-pending"))).toBe(false);
  expect(existsSync(join(targetHome, "objects", ".pending"))).toBe(false);
  expect(filesContaining(targetHome, marker)).toEqual([]);
});

test("legacy v1 reopen removes canonical plaintext staged by a killed pre-commit import", async () => {
  const { vault, thread } = tempVault();
  const bytes = Uint8Array.from({ length: 180_000 }, (_, index) => (index * 47 + 31) & 0xff);
  const marker = new TextEncoder().encode("PYLOS_KILLED_V1_IMPORT_PLAINTEXT_MARKER");
  bytes.set(marker, 100_000);
  vault.episodes.append(thread.id, {
    role: "attachment",
    content: "kill-window-v1.bin",
    blob: { bytes, mime: "application/octet-stream", name: "kill-window-v1.bin" },
  });
  const passphrase = "kill-window-v1 password";
  const bundlePath = join(vault.home, "kill-window-v1.pylos");
  writeFileSync(bundlePath, await core.exportBundleV1(vault, thread.id, { passphrase }));

  const targetHome = mkdtempSync(join(tmpdir(), "pylos-kill-v1-import-"));
  streamHomes.push(targetHome);
  const initial = core.openVault({ home: targetHome });
  const sentinel = initial.threads.create("sentinel");
  initial.episodes.append(sentinel.id, { role: "user", content: "survives the v1 crash" });
  initial.close();

  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        import { readFileSync } from "node:fs";
        const core = await import(${JSON.stringify(CORE_URL)});
        process.env.NODE_ENV = "test";
        process.env.PYLOS_TEST_BUNDLE_IMPORT_FAULT = "kill-after-v1-blob-stage-before-commit";
        const vault = core.openVault({ home: ${JSON.stringify(targetHome)} });
        await core.importBundle(vault, readFileSync(${JSON.stringify(bundlePath)}), {
          passphrase: ${JSON.stringify(passphrase)},
        });
        process.exit(86);
      `,
    ],
    { cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  const exit = await child.exited;
  expect(exit, stderr).toBe(137);
  expect(existsSync(join(targetHome, "objects", ".pending"))).toBe(true);
  expect(filesContaining(targetHome, marker).length).toBeGreaterThan(0);

  const reopened = core.openVault({ home: targetHome });
  expect(reopened.threads.list().map((candidate) => candidate.id)).toEqual([sentinel.id]);
  expect(reopened.episodes.count(sentinel.id)).toBe(1);
  expect(reopened.blobs.list()).toEqual([]);
  expect(readdirSync(reopened.objectsDir)).toEqual([]);
  reopened.close();
  expect(filesContaining(targetHome, marker)).toEqual([]);
});

test("reopen installs multiple verified pending objects whose rows committed before a kill", async () => {
  const { vault } = tempVault();
  const first = Uint8Array.from({ length: 90_000 }, (_, index) => (index * 41 + 23) & 0xff);
  const second = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 43 + 29) & 0xff);
  const firstHash = core.sha256(first);
  const secondHash = core.sha256(second);
  const firstPath = join(vault.home, "pending-first.bin");
  const secondPath = join(vault.home, "pending-second.bin");
  writeFileSync(firstPath, first);
  writeFileSync(secondPath, second);
  const targetHome = mkdtempSync(join(tmpdir(), "pylos-committed-import-"));
  streamHomes.push(targetHome);
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        const core = await import(${JSON.stringify(CORE_URL)});
        const pending = await import(${JSON.stringify(BLOB_PENDING_URL)});
        const vault = core.openVault({ home: ${JSON.stringify(targetHome)} });
        const promotion = pending.createBlobPromotion(vault.objectsDir);
        pending.stageBlobForPromotion(promotion, ${JSON.stringify(firstPath)}, ${JSON.stringify(firstHash)}, ${first.byteLength});
        pending.stageBlobForPromotion(promotion, ${JSON.stringify(secondPath)}, ${JSON.stringify(secondHash)}, ${second.byteLength});
        vault.tx(() => {
          vault.db.query("INSERT INTO blob (hash, mime, size, created_at) VALUES (?, NULL, ?, ?)")
            .run(${JSON.stringify(firstHash)}, ${first.byteLength}, Date.now());
          vault.db.query("INSERT INTO blob (hash, mime, size, created_at) VALUES (?, NULL, ?, ?)")
            .run(${JSON.stringify(secondHash)}, ${second.byteLength}, Date.now());
        });
        process.kill(process.pid, "SIGKILL");
      `,
    ],
    { cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  const exit = await child.exited;
  expect(exit, stderr).not.toBe(0);

  const reopened = core.openVault({ home: targetHome });
  expect(reopened.blobs.get(firstHash)).toEqual(first);
  expect(reopened.blobs.get(secondHash)).toEqual(second);
  expect(readdirSync(reopened.objectsDir).every((name) => /^[0-9a-f]{64}$/.test(name))).toBe(true);
  reopened.close();
  expect(existsSync(join(targetHome, "objects", ".import-pending"))).toBe(false);
  expect(existsSync(join(targetHome, "objects", ".pending"))).toBe(false);
});

test("a killed grounded v2 import recovers committed objects, receipts, and routes on reopen", async () => {
  const { vault, thread } = tempVault();
  const marker = "POST_COMMIT_IMPORT_ROUTE_MARKER";
  const answer = `The final attachment marker is ${marker}.`;
  const content = `${"committed import evidence row\n".repeat(3_000)}${answer}`;
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes: new TextEncoder().encode(content), mime: "text/plain", name: "committed-route.txt" },
  });
  const question = "What is the final marker in committed-route.txt?";
  const provider: core.Provider = async function* (request) {
    const capability = request.evidence?.find(
      (candidate) => candidate.authority === "attachment" && candidate.seq === attachment.seq,
    );
    if (capability === undefined) throw new Error("attachment evidence capability missing");
    yield { type: "delta", text: answer };
    yield {
      type: "tool_call",
      id: "post-commit-import-route",
      name: "submit_claim_map",
      arguments: JSON.stringify({
        claims: [{ outputSpan: [0, answer.length], capabilityTokens: [capability.token] }],
      }),
    };
    yield { type: "done" };
  };
  const grounded = await core.runTurn(vault, thread.id, {
    text: question,
    model: "post-commit-import-oracle",
    provider,
    budget: 8_192,
  });
  const sourceRoute = vault.addresses.active(thread.id, question)[0];
  expect(sourceRoute).toBeDefined();
  const wholeHash = attachment.meta.manifest?.hash as string;
  const passphrase = "post-commit import recovery";
  const bundlePath = join(vault.home, "post-commit-route.pylos");
  writeFileSync(bundlePath, await core.exportBundle(vault, thread.id, { passphrase }));

  const targetHome = mkdtempSync(join(tmpdir(), "pylos-post-commit-import-"));
  streamHomes.push(targetHome);
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        import { readFileSync } from "node:fs";
        process.env.NODE_ENV = "test";
        process.env.PYLOS_TEST_BLOB_PROMOTION_FAULT = "kill-after-commit-before-rename";
        const core = await import(${JSON.stringify(CORE_URL)});
        const target = core.openVault({ home: ${JSON.stringify(targetHome)} });
        await core.importBundle(target, readFileSync(${JSON.stringify(bundlePath)}), {
          passphrase: ${JSON.stringify(passphrase)},
        });
        process.exit(86);
      `,
    ],
    { cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  const exit = await child.exited;
  expect(exit, stderr).not.toBe(0);
  expect(existsSync(join(targetHome, "objects", ".pending"))).toBe(true);
  expect(existsSync(join(targetHome, "objects", wholeHash))).toBe(false);

  const reopened = core.openVault({ home: targetHome });
  expect(reopened.threads.get(thread.id)?.headHash).toBe(grounded.assistantEpisode.hash);
  expect(reopened.blobs.get(wholeHash)).toEqual(new TextEncoder().encode(content));
  expect(core.verify(reopened, thread.id, { full: true }).ok).toBe(true);
  const receipt = reopened.episodes.get(thread.id, grounded.assistantEpisode.seq)?.meta.answerReceipt;
  expect(
    receipt?.classifications.some((entry) => entry.evidenceWitness?.source === `blob:${wholeHash}`),
  ).toBe(true);
  const routes = reopened.addresses.active(thread.id, question);
  expect(routes).toHaveLength(1);
  expect(reopened.addresses.reuse(thread.id, question, sourceRoute?.routerVersion ?? "").reused).toBe(true);
  expect(existsSync(join(reopened.objectsDir, ".pending"))).toBe(false);
  expect(existsSync(join(reopened.objectsDir, ".import-pending"))).toBe(false);
  reopened.close();
});

test("export is one coherent pre-mutation SQLite snapshot", async () => {
  const { vault, thread } = tempVault();
  for (let index = 0; index < 2_048; index += 1) {
    vault.episodes.append(thread.id, {
      role: index % 2 === 0 ? "user" : "assistant",
      content: `before-mutation-${index}`,
    });
  }
  const before = vault.threads.get(thread.id);
  const beforeCount = vault.episodes.count(thread.id);
  if (before === null) throw new Error("test thread disappeared");

  // exportBundleStream enters its read transaction before its first await. The
  // mutations below therefore happen after the snapshot is fixed, while the
  // staged JSONL/object walk is still in flight.
  const pending = streamValue(
    requireExportStream()?.(vault, thread.id, { passphrase: "snapshot password" }) as
      | ReadableStream<Uint8Array>
      | Promise<ReadableStream<Uint8Array>>,
  );
  vault.episodes.append(thread.id, { role: "user", content: "after-mutation append" });
  core.forget(vault, thread.id, { seqs: [1], reason: "snapshot oracle mutation" });
  const after = vault.threads.get(thread.id);
  expect(after?.headSeq).toBeGreaterThan(before.headSeq);
  expect(after?.headHash).not.toBe(before.headHash);

  const encoded = await readStream(await pending);
  const target = freshVault();
  const imported = await requireImportStream()?.(target, chunkStream(encoded.chunks), {
    passphrase: "snapshot password",
  });
  expect(imported?.verified).toBe(true);
  expect(imported?.episodes).toBe(beforeCount);
  expect(imported?.headSeq).toBe(before.headSeq);
  expect(imported?.headHash).toBe(before.headHash);
  const restored = target.episodes.get(imported?.threadId as string, 1);
  expect(restored?.content).toBe("before-mutation-0");
  expect(restored?.meta.removed).not.toBe(true);
  expect(target.episodes.count(imported?.threadId as string)).toBe(beforeCount);
});

test("progress proves bounded transport memory across a 10x archive", async () => {
  const makeArchive = async (rows: number, passphrase: string) => {
    const { vault, thread } = tempVault();
    for (let index = 0; index < rows; index += 1) {
      vault.episodes.append(thread.id, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `row-${index}-${"x".repeat(512)}`,
      });
    }
    const exported = await exportWithProgress(vault, thread.id, passphrase);
    const target = freshVault();
    const importedProgress: core.BundleProgress[] = [];
    const imported = await requireImportStream()?.(target, chunkStream(exported.encoded.chunks), {
      passphrase,
      onProgress: (entry) => importedProgress.push(entry),
    });
    return { exported, imported, importedProgress };
  };

  const small = await makeArchive(200, "small progress password");
  const large = await makeArchive(2_000, "large progress password");
  const allProgress = [
    ...small.exported.progress,
    ...large.exported.progress,
    ...small.importedProgress,
    ...large.importedProgress,
  ];
  const peaks = new Set(allProgress.map((entry) => entry.peakBufferedBytes));
  const maxReportedPeak = Math.max(...peaks);
  const maxChunk = Math.max(small.exported.encoded.max, large.exported.encoded.max);
  const smallRows = Math.max(...small.exported.progress.map((entry) => entry.rows));
  const largeRows = Math.max(...large.exported.progress.map((entry) => entry.rows));
  const smallStaged = Math.max(...small.exported.progress.map((entry) => entry.stagedBytes));
  const largeStaged = Math.max(...large.exported.progress.map((entry) => entry.stagedBytes));
  const smallImportedRows = Math.max(...small.importedProgress.map((entry) => entry.rows));
  const largeImportedRows = Math.max(...large.importedProgress.map((entry) => entry.rows));

  expect(small.imported?.verified).toBe(true);
  expect(large.imported?.verified).toBe(true);
  expect(large.imported?.episodes).toBe(2_000);
  expect(largeRows).toBeGreaterThan(smallRows);
  expect(largeStaged).toBeGreaterThan(smallStaged);
  expect(largeImportedRows).toBeGreaterThan(smallImportedRows);
  expect(small.exported.encoded.chunks.length).toBeGreaterThan(0);
  expect(large.exported.encoded.chunks.length).toBeGreaterThan(small.exported.encoded.chunks.length);
  expect(maxChunk).toBeLessThanOrEqual(1_100_000);
  expect(peaks.size).toBe(1);
  // This is a transport-buffer bound, not a claim about total process RSS.
  expect(maxReportedPeak).toBeLessThanOrEqual(64 * 1024 * 1024);
  expect(allProgress.every((entry) => entry.bufferedBytes >= 0)).toBe(true);
});

test("a corrupt existing same-name object fails closed before destination mutation", async () => {
  const { vault, thread } = tempVault();
  const bytes = Uint8Array.from({ length: 96_000 }, (_, index) => (index * 13 + 7) & 0xff);
  const episode = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "collision.bin",
    blob: { bytes, mime: "application/octet-stream", name: "collision.bin" },
  });
  const hash = episode.meta.blob as string;
  const stream = await streamValue(
    requireExportStream()?.(vault, thread.id, { passphrase: "collision password" }) as
      | ReadableStream<Uint8Array>
      | Promise<ReadableStream<Uint8Array>>,
  );
  const encoded = await readStream(stream);
  const target = freshVault();
  const sentinel = target.threads.create("keep");
  target.episodes.append(sentinel.id, { role: "user", content: "untouched" });
  writeFileSync(join(target.objectsDir, hash), Uint8Array.from([1, 2, 3, 4]));
  const beforeThreads = target.threads.list();
  const beforeObjects = target.blobs.list();

  await expect(
    requireImportStream()?.(target, chunkStream(encoded.chunks), { passphrase: "collision password" }),
  ).rejects.toThrow(/existing object/);
  expect(target.threads.list()).toEqual(beforeThreads);
  expect(target.blobs.list()).toEqual(beforeObjects);
  expect(target.episodes.count(sentinel.id)).toBe(1);
  expect(target.blobs.get(hash)).toEqual(Uint8Array.from([1, 2, 3, 4]));
});

test("legacy streaming import applies the caller's decompressed-byte cap", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "legacy cap" });
  const bundle = await core.exportBundleV1(vault, thread.id, { passphrase: "legacy cap password" });
  const target = freshVault();
  await expect(
    requireImportStream()?.(target, chunkStream([bundle]), {
      passphrase: "legacy cap password",
      limits: { maxArchiveBytes: 1_024 },
    }),
  ).rejects.toThrow(/archive byte limit/);
  expect(target.threads.list()).toHaveLength(0);
});

test("legacy v1 export preflights reachable object bytes before materializing them", async () => {
  const { vault, thread } = tempVault();
  const size = 64 * 1024 * 1024 + 1;
  const digest = createHash("sha256");
  const zeros = Buffer.alloc(64 * 1024);
  for (let remaining = size; remaining > 0; remaining -= zeros.byteLength) {
    digest.update(zeros.subarray(0, Math.min(remaining, zeros.byteLength)));
  }
  const hash = digest.digest("hex");
  const objectPath = join(vault.objectsDir, hash);
  writeFileSync(objectPath, new Uint8Array());
  truncateSync(objectPath, size);
  vault.db
    .query("INSERT INTO blob (hash, mime, size, created_at) VALUES (?, ?, ?, ?)")
    .run(hash, "application/octet-stream", size, Date.now());
  vault.episodes.append(thread.id, {
    role: "attachment",
    content: "oversized-legacy.bin",
    meta: { blob: hash, mime: "application/octet-stream", name: "oversized-legacy.bin", size },
  });
  const blobs = vault.blobs as unknown as { get: (objectHash: string) => Uint8Array | null };
  const originalGet = blobs.get;
  let materialized = false;
  blobs.get = () => {
    materialized = true;
    throw new Error("legacy export materialized an oversized object");
  };
  try {
    await expect(core.exportBundleV1(vault, thread.id, { passphrase: "bounded legacy" })).rejects.toThrow(
      /legacy bundle compatibility preflight/,
    );
  } finally {
    blobs.get = originalGet;
  }
  expect(materialized).toBe(false);
});

test("legacy v1 export does not silently truncate capsules at the old list limit", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "capsule completeness" });
  const insert = vault.db.prepare(
    "INSERT INTO capsule (id, thread_id, level, from_seq, to_seq, text, tokens, dropped, carried_count, kept, hash, created_by, created_at) " +
      "VALUES (?, ?, ?, 1, 1, '', 0, '[]', 0, '[]', ?, 'test', 0)",
  );
  vault.tx(() => {
    for (let index = 0; index <= 100_000; index += 1) {
      insert.run(`legacy-cap-${index}`, thread.id, index, index.toString(16).padStart(64, "0"));
    }
  });

  const passphrase = "complete legacy capsules";
  const bundle = await core.exportBundleV1(vault, thread.id, { passphrase });
  const archive = unzip(await decryptLegacyArchive(bundle, passphrase));
  const capsules = archive.get("capsules.jsonl");
  expect(capsules).toBeDefined();
  const rows = new TextDecoder().decode(capsules).split("\n");
  expect(rows).toHaveLength(100_001);
  const manifest = JSON.parse(new TextDecoder().decode(archive.get("manifest.json"))) as {
    counts: { capsules: number };
  };
  expect(manifest.counts.capsules).toBe(100_001);
}, 15_000);

test("legacy streaming import caps ZIP decompression at the 64 MiB compatibility ceiling", async () => {
  const bundle = await oversizedLegacyBundle("legacy decompression password");
  const target = freshVault();
  await expect(
    requireImportStream()?.(target, chunkStream([bundle]), {
      passphrase: "legacy decompression password",
    }),
  ).rejects.toThrow(/zip entry exceeds its byte limit/);
  expect(target.threads.list()).toHaveLength(0);
});

test("encrypted v1 and v2 imports reject unbounded or malformed derived rows atomically", async () => {
  const { vault, threadId } = derivedRowFixture();
  const cases: Array<{
    entry: "atoms.jsonl" | "capsules.jsonl" | "loss.jsonl";
    rewrite: (row: Record<string, unknown>) => Record<string, unknown>;
    expected?: RegExp;
  }> = [
    {
      entry: "atoms.jsonl",
      rewrite: (row) => ({ ...row, created_by: "a".repeat(1024 * 1024 + 1) }),
    },
    {
      entry: "capsules.jsonl",
      rewrite: (row) => ({
        ...row,
        dropped: [{ name: [], kind: "entity", seq: 1 }],
      }),
    },
    {
      entry: "loss.jsonl",
      rewrite: (row) => ({
        ...row,
        kind: "not-a-loss-kind",
      }),
    },
    {
      entry: "atoms.jsonl",
      rewrite: (row) => ({ ...row, created_by: "p".repeat(2 * 1024 * 1024 + 1) }),
      expected: /bundle JSONL line exceeds the line byte limit/,
    },
  ];
  for (const version of ["v2", "v1"] as const) {
    const passphrase = `derived row bounds ${version}`;
    if (version === "v1") vault.db.query("DELETE FROM address_alias WHERE thread_id = ?").run(threadId);
    const base =
      version === "v2"
        ? await core.exportBundle(vault, threadId, { passphrase })
        : await core.exportBundleV1(vault, threadId, { passphrase });
    for (const candidate of cases) {
      const bundle = await rewriteBundleJsonl(base, passphrase, candidate.entry, candidate.rewrite);
      const target = freshVault();
      await expect(core.importBundle(target, bundle, { passphrase })).rejects.toThrow(
        candidate.expected ?? /invalid (atom|capsule|loss) bundle row/,
      );
      expectNoImportedDerivedRows(target, threadId);
    }
  }
}, 60_000);

test("encrypted v1 and v2 imports reject malformed manifests, episodes, and aliases atomically", async () => {
  const { vault, threadId } = derivedRowFixture();
  const aliasRow = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.keys(row).length > 0
      ? row
      : {
          id: "forged-v1-alias",
          thread_id: threadId,
          alias: "fixture",
          source_seq: 1,
          byte_from: 0,
          byte_to: 1,
          source_hash: core.sha256("Fixture Person lives in Lisbon."),
          quote_hash: core.sha256("f"),
          authority: "model",
          status: "proposed",
          created_at: 1,
        };
  const cases: Array<{
    entry: "manifest.json" | "episodes.jsonl" | "address-aliases.jsonl";
    rewrite: (row: Record<string, unknown>) => Record<string, unknown>;
    expected: RegExp;
  }> = [
    {
      entry: "manifest.json",
      rewrite: (row) => ({ ...row, title: "t".repeat(4 * 1024 + 1) }),
      expected: /bundle manifest has an unsupported shape/,
    },
    {
      entry: "manifest.json",
      rewrite: (row) => ({ ...row, settings: { budget: 1_000_001 } }),
      expected: /settings\.budget is outside its integer bounds/,
    },
    {
      entry: "manifest.json",
      rewrite: (row) => ({
        ...row,
        settings: { shares: { header: 1, frontier: 1, capsules: 0, paged: 0 } },
      }),
      expected: /settings\.shares total must be at most 1/,
    },
    {
      entry: "episodes.jsonl",
      rewrite: (row) => ({ ...row, role: "assistant", model: "m".repeat(513) }),
      expected: /invalid episode bundle row: model exceeds 512 UTF-8 bytes/,
    },
    {
      entry: "episodes.jsonl",
      rewrite: (row) => ({ ...row, model: "forged-speaker", provider: "forged-provider" }),
      expected: /only assistant episodes may declare model or provider/,
    },
    {
      entry: "episodes.jsonl",
      rewrite: (row) => ({ ...row, meta: { padding: "x".repeat(1024 * 1024) } }),
      expected: /invalid episode bundle row: meta exceeds 1048576 JSON bytes/,
    },
    {
      entry: "address-aliases.jsonl",
      rewrite: (row) => ({ ...aliasRow(row), alias: "a".repeat(161) }),
      expected: /invalid address alias on import: alias exceeds 160 UTF-8 bytes/,
    },
    {
      entry: "address-aliases.jsonl",
      rewrite: (row) => ({ ...aliasRow(row), source_hash: "not-a-hash" }),
      expected: /source_hash is not lowercase sha256/,
    },
  ];
  for (const version of ["v2", "v1"] as const) {
    const passphrase = `bundle boundary ${version}`;
    if (version === "v1") vault.db.query("DELETE FROM address_alias WHERE thread_id = ?").run(threadId);
    const base =
      version === "v2"
        ? await core.exportBundle(vault, threadId, { passphrase })
        : await core.exportBundleV1(vault, threadId, { passphrase });
    for (const candidate of cases) {
      const bundle = await rewriteBundleJsonl(base, passphrase, candidate.entry, candidate.rewrite);
      const target = freshVault();
      await expect(core.importBundle(target, bundle, { passphrase })).rejects.toThrow(candidate.expected);
      expect(target.threads.get(threadId)).toBeNull();
      expect(
        (target.db.query("SELECT COUNT(*) AS count FROM address_alias").get() as { count: number }).count,
      ).toBe(0);
    }
  }
}, 60_000);

test("v1 and v2 reject malformed or orphan packet receipts before installation", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "packet import authority boundary" });
  const forgedPacket = {
    id: "pk-forged-orphan",
    thread_id: thread.id,
    turn_seq: 1,
    model: "",
    budget: 8192,
    tokens: 0,
    digest: "0".repeat(64),
    status: "done",
    compiler_version: "test",
    messages: null,
    resident: "[]",
    ledger: JSON.stringify({ count: 0, residentNames: [], historical: [] }),
    pages: "[]",
    rounds: null,
    reachability: null,
    reachability_as_of_seq: null,
    coverage: null,
    evidence: null,
    answer_receipt: null,
    semantic: null,
    created_at: 1,
  };
  for (const version of ["v2", "v1"] as const) {
    const passphrase = `packet import ${version}`;
    const base =
      version === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase })
        : await core.exportBundleV1(vault, thread.id, { passphrase });
    const malformed = await rewriteBundleJsonl(
      base,
      passphrase,
      "packets.jsonl",
      () => ({ ...forgedPacket, resident: "{}" }),
      true,
    );
    const malformedTarget = freshVault();
    await expect(core.importBundle(malformedTarget, malformed, { passphrase })).rejects.toThrow(
      /invalid packet bundle row on import: resident has the wrong JSON shape/,
    );
    expect(malformedTarget.threads.get(thread.id)).toBeNull();

    const orphan = await rewriteBundleJsonl(base, passphrase, "packets.jsonl", () => forgedPacket, true);
    const orphanTarget = freshVault();
    await expect(core.importBundle(orphanTarget, orphan, { passphrase })).rejects.toThrow(
      /imported chain failed verification.*packet/,
    );
    expect(orphanTarget.threads.get(thread.id)).toBeNull();
    expect(
      (orphanTarget.db.query("SELECT COUNT(*) AS count FROM packet").get() as { count: number }).count,
    ).toBe(0);

    if (version === "v2") {
      const currentPending = {
        ...forgedPacket,
        id: "pk-current-pending",
        status: "pending",
        compiler_version: "2",
      };
      const oversizedField = await rewriteBundleJsonl(
        base,
        passphrase,
        "packets.jsonl",
        () => ({ ...currentPending, resident: JSON.stringify(["x".repeat(256 * 1024)]) }),
        true,
      );
      const oversizedTarget = freshVault();
      await expect(core.importBundle(oversizedTarget, oversizedField, { passphrase })).rejects.toThrow(
        /resident exceeds 262144 JSON bytes/,
      );
      expect(oversizedTarget.threads.get(thread.id)).toBeNull();
      expect(
        (oversizedTarget.db.query("SELECT COUNT(*) AS count FROM packet").get() as { count: number }).count,
      ).toBe(0);

      const padding = "x".repeat(150_000);
      const aggregate = await rewriteBundleJsonl(
        base,
        passphrase,
        "packets.jsonl",
        () => ({
          ...currentPending,
          messages: JSON.stringify([{ role: "user", content: "m".repeat(1_200_000) }]),
          resident: JSON.stringify([padding]),
          ledger: JSON.stringify({ count: 0, residentNames: [], historical: [], padding }),
          pages: JSON.stringify([padding]),
          rounds: JSON.stringify([padding]),
          reachability: JSON.stringify([padding]),
          reachability_as_of_seq: 1,
          semantic: JSON.stringify({ padding }),
        }),
        true,
      );
      const aggregateTarget = freshVault();
      await expect(core.importBundle(aggregateTarget, aggregate, { passphrase })).rejects.toThrow(
        /packet JSON fields exceed 2097152 aggregate bytes/,
      );
      expect(aggregateTarget.threads.get(thread.id)).toBeNull();
      expect(
        (aggregateTarget.db.query("SELECT COUNT(*) AS count FROM packet").get() as { count: number }).count,
      ).toBe(0);
    }
  }
});

test("v1 and v2 preserve validated thread settings", async () => {
  for (const version of ["v2", "v1"] as const) {
    const { vault, thread } = tempVault();
    const settings = { model: "proof-model", budget: 8192, demoVersion: "funeral-v2" };
    vault.db.query("UPDATE thread SET settings = ? WHERE id = ?").run(JSON.stringify(settings), thread.id);
    vault.episodes.append(thread.id, { role: "user", content: "settings survive export" });
    const passphrase = `settings ${version}`;
    const bundle =
      version === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase })
        : await core.exportBundleV1(vault, thread.id, { passphrase });
    const target = freshVault();
    await core.importBundle(target, bundle, { passphrase });
    expect(target.threads.get(thread.id)?.settings).toEqual(settings);
  }
});

test("v2 preserves incomplete atomization receipts and v1 refuses to erase them", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "A bounded extractor must leave its omission receipt behind.",
  });
  const receipt: core.AtomizationReceipt = {
    threadId: thread.id,
    sourceSeq: source.seq,
    sourceHash: source.hash,
    status: "incomplete",
    model: "receipt-oracle",
    candidateCount: 513,
    acceptedCount: 0,
    omittedCount: 1,
    reason: "candidate-cap",
    createdAt: 1234,
  };
  vault.atomization.record(receipt);

  const passphrase = "atomization receipt roundtrip";
  const bundle = await core.exportBundle(vault, thread.id, { passphrase });
  const target = freshVault();
  await core.importBundle(target, bundle, { passphrase });
  expect(target.atomization.get(thread.id, source.seq)).toEqual(receipt);
  expect(target.atomization.hasIncomplete(thread.id, source.seq)).toBe(true);

  const wrongCount = await rewriteBundleJsonl(bundle, passphrase, "manifest.json", (row) => {
    const countsExtended = row.countsExtended as Record<string, number>;
    return {
      ...row,
      countsExtended: {
        ...countsExtended,
        atomizationReceipts: (countsExtended.atomizationReceipts ?? 0) + 1,
      },
    };
  });
  const wrongCountTarget = freshVault();
  await expect(core.importBundle(wrongCountTarget, wrongCount, { passphrase })).rejects.toThrow(
    /declares 2 atomization receipts and carries 1/,
  );
  expect(wrongCountTarget.threads.get(thread.id)).toBeNull();

  await expect(core.exportBundleV1(vault, thread.id, { passphrase })).rejects.toThrow(
    /legacy v1 export cannot preserve atomization receipts; use v2/,
  );

  for (const candidate of [
    {
      rewrite: (row: Record<string, unknown>) => ({
        ...row,
        status: "complete",
        omitted_count: 1,
        reason: "candidate-cap",
      }),
      expected: /complete receipt carries an omission/,
    },
    {
      rewrite: (row: Record<string, unknown>) => ({ ...row, model: "m".repeat(513) }),
      expected: /model exceeds 512 UTF-8 bytes/,
    },
    {
      rewrite: (row: Record<string, unknown>) => ({ ...row, source_hash: "0".repeat(64) }),
      expected: /source revision is not retained/,
    },
  ]) {
    const forged = await rewriteBundleJsonl(
      bundle,
      passphrase,
      "atomization-receipts.jsonl",
      candidate.rewrite,
    );
    const forgedTarget = freshVault();
    await expect(core.importBundle(forgedTarget, forged, { passphrase })).rejects.toThrow(candidate.expected);
    expect(forgedTarget.threads.get(thread.id)).toBeNull();
    expect(
      (
        forgedTarget.db.query("SELECT COUNT(*) AS count FROM atomization_receipt").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  }
});

test("ordinary alias listing fails closed at its bounded page", () => {
  const { vault, thread } = tempVault();
  const insert = vault.db.prepare(
    "INSERT INTO address_alias (id, thread_id, alias, source_seq, byte_from, byte_to, source_hash, quote_hash, authority, status, created_at) " +
      "VALUES (?, ?, ?, 1, 0, 1, ?, ?, 'model', 'revoked', ?)",
  );
  for (let index = 0; index <= 512; index += 1) {
    insert.run(`alias-${index}`, thread.id, `alias-${index}`, "0".repeat(64), "1".repeat(64), index + 1);
  }
  expect(() => vault.aliases.list(thread.id)).toThrow(/address alias listing exceeds 512 rows/);
  vault.db.query("DELETE FROM address_alias WHERE thread_id = ?").run(thread.id);
  insert.run("oversized-direct", thread.id, "x".repeat(1024 * 1024), "0".repeat(64), "1".repeat(64), 1);
  expect(() => vault.aliases.list(thread.id)).toThrow(/alias row exceeds its bounded projection/);
});

test("v1 and v2 reject a 512-row oversized alias batch and partial import atomically", async () => {
  for (const version of ["v2", "v1"] as const) {
    const { vault, thread } = tempVault();
    vault.episodes.append(thread.id, { role: "user", content: "alias source" });
    vault.episodes.append(thread.id, { role: "assistant", content: "tail outside fragment" });
    const passphrase = `alias batch ${version}`;
    const base =
      version === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase, range: [1, 1] })
        : await core.exportBundleV1(vault, thread.id, { passphrase, range: [1, 1] });
    const oversized = await rewriteBundleJsonl(
      base,
      passphrase,
      "address-aliases.jsonl",
      () =>
        Array.from({ length: 512 }, (_, index) => ({
          id: `oversized-alias-${index}`,
          thread_id: thread.id,
          alias: `${index}-${"a".repeat(161)}`,
          source_seq: 1,
          byte_from: 0,
          byte_to: 1,
          source_hash: core.sha256("alias source"),
          quote_hash: core.sha256("a"),
          authority: "model",
          status: "proposed",
          created_at: index + 1,
        })),
      true,
    );
    const target = freshVault();
    await expect(core.importBundle(target, oversized, { passphrase })).rejects.toThrow(
      /invalid address alias on import: alias exceeds 160 UTF-8 bytes/,
    );
    expect(target.threads.get(thread.id)).toBeNull();
    expect(
      (target.db.query("SELECT COUNT(*) AS count FROM address_alias").get() as { count: number }).count,
    ).toBe(0);
  }
}, 60_000);

test("v1 and v2 enforce every manifest row count, including optional address files", async () => {
  for (const version of ["v2", "v1"] as const) {
    const { vault, threadId } = derivedRowFixture();
    if (version === "v1") vault.db.query("DELETE FROM address_alias WHERE thread_id = ?").run(threadId);
    const passphrase = `manifest cardinality ${version}`;
    const base =
      version === "v2"
        ? await core.exportBundle(vault, threadId, { passphrase })
        : await core.exportBundleV1(vault, threadId, { passphrase });
    for (const field of ["atoms", "capsules", "loss"] as const) {
      const forged = await rewriteBundleJsonl(base, passphrase, "manifest.json", (row) => {
        const counts = row.counts as Record<string, number>;
        return { ...row, counts: { ...counts, [field]: (counts[field] ?? 0) + 1 } };
      });
      const target = freshVault();
      await expect(core.importBundle(target, forged, { passphrase })).rejects.toThrow(
        new RegExp(`declares \\d+ ${field === "loss" ? "losses" : field} and carries`),
      );
      expect(target.threads.get(threadId)).toBeNull();
    }

    const sourceContent = "Fixture Person lives in Lisbon.";
    const withAlias = await rewriteBundleJsonl(
      base,
      passphrase,
      "address-aliases.jsonl",
      (row) =>
        Object.keys(row).length > 0
          ? row
          : {
              id: "counted-v1-alias",
              thread_id: threadId,
              alias: "fixture",
              source_seq: 1,
              byte_from: 0,
              byte_to: 7,
              source_hash: core.sha256(sourceContent),
              quote_hash: core.sha256("Fixture"),
              authority: "model",
              status: "proposed",
              created_at: 1,
            },
      true,
    );
    const missingExtended = await rewriteBundleJsonl(withAlias, passphrase, "manifest.json", (row) => {
      const { countsExtended: _countsExtended, ...withoutExtended } = row;
      return withoutExtended;
    });
    const aliasTarget = freshVault();
    await expect(core.importBundle(aliasTarget, missingExtended, { passphrase })).rejects.toThrow(
      /declares 0 (address aliases|capsule ledger entries) and carries \d+/,
    );
    expect(aliasTarget.threads.get(threadId)).toBeNull();
  }
}, 60_000);

test("v1 and v2 refuse an existing empty thread instead of retaining unauthenticated metadata", async () => {
  for (const version of ["v2", "v1"] as const) {
    const { vault, thread } = tempVault();
    vault.db
      .query("UPDATE thread SET settings = ? WHERE id = ?")
      .run(JSON.stringify({ model: "manifest-model", budget: 4096 }), thread.id);
    vault.episodes.append(thread.id, { role: "user", content: "authenticated source" });
    const passphrase = `empty collision ${version}`;
    const bundle =
      version === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase })
        : await core.exportBundleV1(vault, thread.id, { passphrase });
    const target = freshVault();
    const stub = target.threads.create("local stub", { model: "unsafe-local" });
    target.db.query("UPDATE thread SET id = ? WHERE id = ?").run(thread.id, stub.id);
    await expect(core.importBundle(target, bundle, { passphrase })).rejects.toThrow(/already exists/);
    const retained = target.threads.get(thread.id);
    expect(retained?.title).toBe("local stub");
    expect(retained?.settings).toEqual({ model: "unsafe-local" });
    expect(retained?.headSeq).toBe(0);
  }
});

test("full v1 and v2 imports retain their authenticated thread id and reject duplicate restores", async () => {
  for (const version of ["v2", "v1"] as const) {
    const { vault, thread } = tempVault();
    vault.episodes.appendMany(
      thread.id,
      Array.from({ length: 160 }, (_, index) => ({
        role: "user" as const,
        content: `root-bound row ${index + 1}`,
      })),
    );
    core.compact(vault, thread.id, { budget: 1024 });
    expect(vault.capsules.at(thread.id, 99, 1)?.id).toBe(`root:${thread.id}`);

    const passphrase = `full identity ${version}`;
    const bundle =
      version === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase })
        : await core.exportBundleV1(vault, thread.id, { passphrase });
    const target = freshVault();
    const destinationId = `copy-${version}`;
    await expect(core.importBundle(target, bundle, { passphrase, threadId: destinationId })).rejects.toThrow(
      /full bundle thread id cannot be overridden/,
    );
    expect(target.threads.get(destinationId)).toBeNull();
    expect(
      (
        target.db.query("SELECT COUNT(*) AS count FROM capsule").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);

    const imported = await core.importBundle(target, bundle, { passphrase });
    expect(imported.threadId).toBe(thread.id);
    expect(target.capsules.at(thread.id, 99, 1)?.id).toBe(`root:${thread.id}`);
    const before = target.threads.get(thread.id);
    await expect(core.importBundle(target, bundle, { passphrase })).rejects.toThrow(/already exists/);
    expect(target.threads.get(thread.id)).toEqual(before);
  }
}, 60_000);

test("stream import refuses a full thread-id override at header preflight before staging", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "authenticated stream identity" });
  const passphrase = "stream identity preflight";
  const bundle = await core.exportBundle(vault, thread.id, { passphrase });
  const target = freshVault();
  const progress: core.BundleProgress[] = [];
  await expect(
    requireImportStream()?.(target, chunkStream([bundle]), {
      passphrase,
      threadId: "stream-copy",
      onProgress: (entry) => progress.push(entry),
    }),
  ).rejects.toThrow(/full bundle thread id cannot be overridden/);
  expect(progress).toEqual([]);
  expect(target.threads.get("stream-copy")).toBeNull();
});

test("v1 and v2 validate partial fragments without promoting them to verified full chains", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 4200 }, (_, index) => ({
      role: "user" as const,
      content: `fragment row ${index + 1}`,
    })),
  );
  for (const version of ["v2", "v1"] as const) {
    for (const range of [
      [100, 160],
      [100, 4200],
    ] as const) {
      const passphrase = `fragment ${version} ${range.join("-")}`;
      const bundle =
        version === "v2"
          ? await core.exportBundle(vault, thread.id, { passphrase, range: [...range] })
          : await core.exportBundleV1(vault, thread.id, { passphrase, range: [...range] });
      const target = freshVault();
      const imported = await core.importBundle(target, bundle, { passphrase });
      expect(imported.verified).toBe(false);
      expect(imported.fragmentVerified).toBe(true);
      expect(imported.episodes).toBe(range[1] - range[0] + 1);
      expect(
        (
          target.db
            .query("SELECT COUNT(*) AS count FROM chain_checkpoint WHERE thread_id = ?")
            .get(imported.threadId) as { count: number }
        ).count,
      ).toBe(0);
    }
  }
}, 120_000);

test("imported fragments retain provenance and refuse every ordinary mutation or full export", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 5 }, (_, index) => ({
      role: "user" as const,
      content: `quarantine row ${index + 1}`,
    })),
  );
  const first = vault.episodes.get(thread.id, 2);
  if (first === null) throw new Error("fragment fixture is missing its first row");

  for (const version of ["v2", "v1"] as const) {
    const passphrase = `fragment quarantine ${version}`;
    const bundle =
      version === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase, range: [2, 4] })
        : await core.exportBundleV1(vault, thread.id, { passphrase, range: [2, 4] });
    const target = freshVault();
    const installedId = `fragment-${version}`;
    const imported = await core.importBundle(target, bundle, { passphrase, threadId: installedId });
    expect(imported).toMatchObject({ verified: false, fragmentVerified: true, episodes: 3 });
    expect(target.fragments.get(installedId)).toMatchObject({
      threadId: installedId,
      originalThreadId: thread.id,
      fromSeq: 2,
      toSeq: 4,
      prevHash: first.prevHash,
      headHash: imported.headHash,
    });
    const reopened = new core.Vault({ home: target.home, fast: true });
    expect(reopened.fragments.get(installedId)?.fromSeq).toBe(2);
    reopened.close();
    const fragmentVerification = core.verify(target, installedId, { full: true });
    expect(fragmentVerification).toMatchObject({
      ok: false,
      fragmentVerified: true,
      checkedFrom: 1,
      checkedTo: 4,
      fragment: { originalThreadId: thread.id, fromSeq: 2, toSeq: 4 },
    });
    target.db
      .query("UPDATE thread_fragment SET prev_hash = ? WHERE thread_id = ?")
      .run("0".repeat(64), installedId);
    expect(core.verify(target, installedId, { full: true }).fragmentVerified).not.toBe(true);
    target.db
      .query("UPDATE thread_fragment SET prev_hash = ? WHERE thread_id = ?")
      .run(first.prevHash, installedId);

    const before = target.threads.get(installedId);
    expect(() => target.episodes.append(installedId, { role: "user", content: "must not append" })).toThrow(
      /authenticated read-only fragment/,
    );
    expect(() => core.compact(target, installedId)).toThrow(/authenticated read-only fragment/);
    expect(() => core.forget(target, installedId, { seqs: [2], reason: "must not redact" })).toThrow(
      /authenticated read-only fragment/,
    );
    expect(() => target.threads.setSettings(installedId, { budget: 4096 })).toThrow(
      /authenticated fragment is read-only/,
    );
    expect(target.threads.get(installedId)).toEqual(before);
    expect(
      (
        target.db.query("SELECT COUNT(*) AS count FROM episode WHERE thread_id = ?").get(installedId) as {
          count: number;
        }
      ).count,
    ).toBe(3);

    const fullExport =
      version === "v2"
        ? core.exportBundle(target, installedId, { passphrase })
        : core.exportBundleV1(target, installedId, { passphrase });
    await expect(fullExport).rejects.toThrow(/authenticated fragments cannot be exported as full threads/);
    const fragmentExport =
      version === "v2"
        ? await core.exportBundle(target, installedId, { passphrase, range: [2, 4] })
        : await core.exportBundleV1(target, installedId, { passphrase, range: [2, 4] });
    expect(fragmentExport.byteLength).toBeGreaterThan(0);
    const restored = freshVault();
    const reimported = await core.importBundle(restored, fragmentExport, { passphrase });
    expect(reimported.threadId).toBe(thread.id);
    expect(restored.fragments.get(thread.id)?.originalThreadId).toBe(thread.id);
  }
});

test("v1 and v2 reject forged fragment links and incomplete full chains atomically", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 180 }, (_, index) => ({ role: "user" as const, content: `chain row ${index + 1}` })),
  );
  for (const version of ["v2", "v1"] as const) {
    const exportFor = async (passphrase: string, range?: [number, number]): Promise<Uint8Array> =>
      version === "v2"
        ? core.exportBundle(vault, thread.id, { passphrase, ...(range ? { range } : {}) })
        : core.exportBundleV1(vault, thread.id, { passphrase, ...(range ? { range } : {}) });

    const fragmentPassphrase = `forged fragment ${version}`;
    const fragment = await exportFor(fragmentPassphrase, [100, 160]);
    for (const rewrite of [
      (row: Record<string, unknown>) => ({ ...row, prevHash: "0".repeat(64) }),
      (row: Record<string, unknown>) => ({ ...row, hash: "f".repeat(64) }),
    ]) {
      const forged = await rewriteBundleJsonl(fragment, fragmentPassphrase, "episodes.jsonl", rewrite);
      const target = freshVault();
      await expect(core.importBundle(target, forged, { passphrase: fragmentPassphrase })).rejects.toThrow(
        /invalid previous hash|hash is invalid/,
      );
      expect(target.threads.get(thread.id)).toBeNull();
    }
    const forgedHead = await rewriteBundleJsonl(fragment, fragmentPassphrase, "manifest.json", (row) => ({
      ...row,
      headHash: "e".repeat(64),
    }));
    const headTarget = freshVault();
    await expect(
      core.importBundle(headTarget, forgedHead, { passphrase: fragmentPassphrase }),
    ).rejects.toThrow(/header and manifest bindings disagree/);
    expect(headTarget.threads.get(thread.id)).toBeNull();

    const fullPassphrase = `forged full ${version}`;
    const full = await exportFor(fullPassphrase);
    const gap = await rewriteBundleJsonl(full, fullPassphrase, "episodes.jsonl", (row) => ({
      ...row,
      seq: 2,
    }));
    const gapTarget = freshVault();
    await expect(core.importBundle(gapTarget, gap, { passphrase: fullPassphrase })).rejects.toThrow(
      /sequence is not contiguous/,
    );
    expect(gapTarget.threads.get(thread.id)).toBeNull();

    const missingTail = await rewriteBundleJsonl(
      full,
      fullPassphrase,
      "episodes.jsonl",
      (_row, rows) => rows.slice(0, -1),
      true,
    );
    const tailTarget = freshVault();
    await expect(core.importBundle(tailTarget, missingTail, { passphrase: fullPassphrase })).rejects.toThrow(
      /episode count does not match its declared range/,
    );
    expect(tailTarget.threads.get(thread.id)).toBeNull();
  }
}, 120_000);

test("encrypted imports reject overfull capsule parents and duplicate current atoms atomically", async () => {
  const { vault, threadId } = derivedRowFixture();
  for (const version of ["v2", "v1"] as const) {
    const passphrase = `derived topology ${version}`;
    if (version === "v1") vault.db.query("DELETE FROM address_alias WHERE thread_id = ?").run(threadId);
    const base =
      version === "v2"
        ? await core.exportBundle(vault, threadId, { passphrase })
        : await core.exportBundleV1(vault, threadId, { passphrase });
    const overfull = await rewriteBundleJsonl(base, passphrase, "capsules.jsonl", (source) => {
      const children = Array.from({ length: 9 }, (_, index) => {
        const from = index + 1;
        const text = index === 0 ? (source.text as string) : "";
        return {
          ...source,
          id: `bundle-derived-child-${from}`,
          level: 0,
          fromSeq: from,
          toSeq: from,
          text,
          tokens: text.length === 0 ? 0 : 2,
          dropped: [],
          kept: [],
          carriedCount: 0,
          ledgerReceipt: undefined,
          hash: core.canonicalHash({ level: 0, from, to: from, text }),
        };
      });
      return [
        {
          ...source,
          id: "bundle-derived-parent",
          level: 1,
          fromSeq: 1,
          toSeq: 9,
          text: "",
          tokens: 0,
          dropped: [],
          kept: [],
          carriedCount: 0,
          ledgerReceipt: undefined,
          hash: core.canonicalHash({ level: 1, from: 1, to: 9, text: "" }),
        },
        ...children,
      ];
    });
    const topologyTarget = freshVault();
    await expect(core.importBundle(topologyTarget, overfull, { passphrase })).rejects.toThrow(
      /invalid capsule bundle topology: parent exceeds 8 direct children/,
    );
    expectNoImportedDerivedRows(topologyTarget, threadId);

    const hugeLeaf = await rewriteBundleJsonl(base, passphrase, "capsules.jsonl", (source) => ({
      ...source,
      id: `cap:${threadId}:0:1`,
      level: 0,
      fromSeq: 1,
      toSeq: 16 * 1024 * 1024,
      hash: core.canonicalHash({
        level: 0,
        from: 1,
        to: 16 * 1024 * 1024,
        text: source.text,
      }),
    }));
    const hugeTarget = freshVault();
    const rangeReader = hugeTarget.episodes as unknown as { range: () => never };
    rangeReader.range = () => {
      throw new Error("forged capsule reached episode hydration");
    };
    await expect(core.importBundle(hugeTarget, hugeLeaf, { passphrase })).rejects.toThrow(
      /invalid capsule bundle topology: .* exceeds the thread head/,
    );
    expectNoImportedDerivedRows(hugeTarget, threadId);

    const duplicate = await rewriteBundleJsonl(base, passphrase, "atoms.jsonl", (source) => [
      source,
      { ...source, id: "bundle-derived-atom-duplicate", created_at: 1 },
    ]);
    const atomTarget = freshVault();
    await expect(core.importBundle(atomTarget, duplicate, { passphrase })).rejects.toThrow(
      /invalid atom bundle topology: multiple SUPPORTED rows for one current key/,
    );
    expectNoImportedDerivedRows(atomTarget, threadId);
  }
}, 60_000);

test("full and partial v1/v2 imports reject forged authoritative atoms", async () => {
  for (const version of ["v2", "v1"] as const) {
    const { vault, threadId } = derivedRowFixture();
    vault.db.query("DELETE FROM address_alias WHERE thread_id = ?").run(threadId);
    vault.episodes.append(threadId, { role: "assistant", content: "tail" });
    const source = vault.db.query("SELECT * FROM atom WHERE thread_id = ? LIMIT 1").get(threadId) as Record<
      string,
      unknown
    >;
    for (const range of [undefined, [1, 1] as [number, number]] as const) {
      const passphrase = `forged atom ${version} ${range === undefined ? "full" : "partial"}`;
      const base =
        version === "v2"
          ? await core.exportBundle(vault, threadId, { passphrase, ...(range ? { range } : {}) })
          : await core.exportBundleV1(vault, threadId, { passphrase, ...(range ? { range } : {}) });
      const forged = await rewriteBundleJsonl(
        base,
        passphrase,
        "atoms.jsonl",
        () => ({
          ...source,
          key: "person.forged.location",
          value: "Atlantis",
          text: "Fixture Person lives in Atlantis.",
        }),
        range !== undefined,
      );
      const target = freshVault();
      await expect(core.importBundle(target, forged, { passphrase })).rejects.toThrow(
        /(?:capsule .* receipt (?:omits source name|mismatches source locator)|invalid atom bundle authority: .* is not a kernel rule result)/,
      );
      expect(target.threads.get(threadId)).toBeNull();
      expect((target.db.query("SELECT COUNT(*) AS count FROM atom").get() as { count: number }).count).toBe(
        0,
      );
    }
  }
}, 60_000);

test("v2 exhaustively checks receipt-bearing leaves beyond the legacy eight-leaf sample", async () => {
  const { vault, thread } = tempVault({ budget: 8_192 });
  const episodes = vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 17 * 32 }, (_, index) => ({
      role: (index === 15 * 32 ? "user" : "assistant") as "user" | "assistant",
      content: index === 15 * 32 ? "My name is Unsampled Ada." : `leaf filler ${index + 1}`,
    })),
  );
  const unsampled = episodes[15 * 32];
  if (unsampled === undefined) throw new Error("unsampled leaf source missing");
  core.atomize(vault, thread.id, [unsampled.seq]);
  core.compact(vault, thread.id, { budget: 8_192, writer: () => "" });
  const leafCount = (
    vault.db.query("SELECT COUNT(*) AS n FROM capsule WHERE thread_id = ? AND level = 0").get(thread.id) as {
      n: number;
    }
  ).n;
  expect(leafCount).toBe(17);

  const passphrase = "unsampled capsule receipt omission";
  const base = await core.exportBundle(vault, thread.id, { passphrase });
  const forged = await rewriteBundleJsonl(base, passphrase, "atoms.jsonl", (row) => ({
    ...row,
    key: "person.forged.location",
    value: "Atlantis",
    text: "Unsampled Ada lives in Atlantis.",
  }));
  const target = freshVault();
  await expect(core.importBundle(target, forged, { passphrase })).rejects.toThrow(
    /capsule .* receipt mismatches source locator/,
  );
  expect(target.threads.get(thread.id)).toBeNull();
  expect((target.db.query("SELECT COUNT(*) AS n FROM capsule_ledger_entry").get() as { n: number }).n).toBe(
    0,
  );
}, 60_000);

test("full v1 and v2 imports preserve forgotten atoms only as revoked audit rows", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, { role: "user", content: "My name is Archive Ada." });
  core.atomize(vault, thread.id, [source.seq]);
  core.forget(vault, thread.id, { seqs: [source.seq], reason: "bundle revoked atom oracle" });
  const sourcePhases = (candidate: core.Vault): string[] =>
    (
      candidate.db
        .query("SELECT phase FROM atom WHERE thread_id = ? AND source_seq = ? ORDER BY rowid LIMIT 16")
        .all(thread.id, source.seq) as Array<{ phase: string }>
    ).map((row) => row.phase);
  expect(sourcePhases(vault)).toEqual(["REVOKED"]);

  for (const version of ["v2", "v1"] as const) {
    const passphrase = `revoked atom ${version}`;
    const bundle =
      version === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase })
        : await core.exportBundleV1(vault, thread.id, { passphrase });
    const target = freshVault();
    const imported = await core.importBundle(target, bundle, { passphrase });
    expect(imported.verified).toBe(true);
    expect(sourcePhases(target)).toEqual(["REVOKED"]);
    expect(target.episodes.get(thread.id, source.seq)?.meta.removed).toBe(true);
  }
});

test("encrypted imports stream a dense valid atom leaf without unbounded range hydration", async () => {
  const { vault, thread } = tempVault();
  const suffix = (index: number): string => {
    const a = Math.floor(index / (26 * 26));
    const b = Math.floor(index / 26) % 26;
    const c = index % 26;
    return String.fromCharCode(65 + a, 97 + b, 97 + c);
  };
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: Array.from(
      { length: 512 },
      (_, index) => `Person ${suffix(index)} lives in City ${suffix(index)}.`,
    ).join("\n"),
  });
  core.atomize(vault, thread.id, [source.seq]);
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 31 }, (_, index) => ({ role: "user" as const, content: `leaf ${index + 2}` })),
  );
  expect(
    (
      vault.db.query("SELECT COUNT(*) AS count FROM atom WHERE thread_id = ?").get(thread.id) as {
        count: number;
      }
    ).count,
  ).toBe(512);
  for (const version of ["v2", "v1"] as const) {
    const passphrase = `atom leaf ${version}`;
    const base =
      version === "v2"
        ? await core.exportBundle(vault, thread.id, { passphrase })
        : await core.exportBundleV1(vault, thread.id, { passphrase });
    const target = freshVault();
    const atoms = target.atoms as unknown as { inRange: () => never };
    atoms.inRange = () => {
      throw new Error("import called the unbounded atom range API");
    };
    let sourceReads = 0;
    let atomRowsWithSourceContent = 0;
    const db = target.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
    const originalQuery = db.query;
    db.query = ((sql: string, ...args: unknown[]) => {
      const statement = originalQuery.call(target.db, sql, ...args) as Record<string, unknown>;
      if (/SELECT content, role, meta FROM episode WHERE thread_id/iu.test(sql)) {
        return new Proxy(statement, {
          get(object, property) {
            if (property === "get") {
              return (...parameters: unknown[]) => {
                sourceReads += 1;
                const get = Reflect.get(object, property, object) as (...values: unknown[]) => unknown;
                return get.apply(object, parameters);
              };
            }
            const value = Reflect.get(object, property, object);
            return typeof value === "function" ? value.bind(object) : value;
          },
        });
      }
      if (/SELECT a\.\* FROM atom a WHERE a\.thread_id/iu.test(sql)) {
        return new Proxy(statement, {
          get(object, property) {
            if (property === "iterate") {
              return (...parameters: unknown[]) => {
                const iterate = Reflect.get(object, property, object) as (...values: unknown[]) => unknown;
                const rows = iterate.apply(object, parameters) as Iterable<Record<string, unknown>>;
                return (function* () {
                  for (const row of rows) {
                    if ("source_content" in row) atomRowsWithSourceContent += 1;
                    yield row;
                  }
                })();
              };
            }
            const value = Reflect.get(object, property, object);
            return typeof value === "function" ? value.bind(object) : value;
          },
        });
      }
      return statement;
    }) as typeof db.query;
    let imported: Awaited<ReturnType<typeof core.importBundle>>;
    try {
      imported = await core.importBundle(target, base, { passphrase });
    } finally {
      db.query = originalQuery;
    }
    expect(imported.verified).toBe(true);
    expect(sourceReads).toBe(1);
    expect(atomRowsWithSourceContent).toBe(0);
    expect(
      (
        target.db.query("SELECT COUNT(*) AS count FROM atom WHERE thread_id = ?").get(thread.id) as {
          count: number;
        }
      ).count,
    ).toBe(512);
  }
}, 60_000);

test("capsule child reads and changed-key compilation remain bounded under direct derived-row tamper", () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "bounded direct tamper" });
  const makeCapsule = (id: string, level: number, from: number, to: number): core.StoredCapsule => ({
    id,
    threadId: thread.id,
    level,
    fromSeq: from,
    toSeq: to,
    text: "",
    tokens: 0,
    dropped: [],
    carriedCount: 0,
    kept: [],
    hash: core.canonicalHash({ level, from, to, text: "" }),
    createdBy: "test:direct-derived-row",
    createdAt: 0,
  });
  vault.capsules.insert(makeCapsule("direct-parent", 1, 1, 9));
  for (let index = 1; index <= 9; index += 1) {
    vault.capsules.insert(makeCapsule(`direct-child-${index}`, 0, index, index));
  }
  expect(() => vault.capsules.children(thread.id, 1, 1, 9)).toThrow(
    /capsule child set exceeds bounded fanout \(8\)/,
  );

  const atomInsert = vault.db.prepare(
    "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
      "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
      "VALUES (?, ?, 'fact', 'direct.key', ?, ?, 1, NULL, ?, ?, NULL, ?, 'user', 'global', 0, 1, 'test', 0)",
  );
  atomInsert.run("direct-historical", thread.id, "before", "direct before", 1, 2, "HISTORICAL");
  atomInsert.run("direct-current", thread.id, "after", "direct after", 2, null, "SUPPORTED");
  const atoms = vault.atoms as unknown as { byKey: () => never };
  atoms.byKey = () => {
    throw new Error("compile used the unbounded current-key reader");
  };
  expect(() => core.compile(vault, thread.id, { query: "show changes" })).not.toThrow();
});

test("raw import rejects and removes its stage without awaiting a stalled stream cancel", async () => {
  const target = freshVault();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2]));
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => undefined);
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("stream cancellation held raw import cleanup open")), 250);
  });
  await expect(
    Promise.race([
      requireImportStream()?.(target, stream, {
        passphrase: "stalled cancel",
        limits: { maxBundleBytes: 1 },
      }) as Promise<unknown>,
      timeout,
    ]).finally(() => clearTimeout(timer)),
  ).rejects.toThrow(/stream byte limit/);
  expect(cancelled).toBe(true);
  expect(existsSync(join(target.objectsDir, ".import-pending"))).toBe(false);
  expect(target.threads.list()).toHaveLength(0);
});

test("raw import times out a mid-body stall and removes plaintext staging", async () => {
  const target = freshVault();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(BUNDLE_MAGIC));
    },
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => undefined);
    },
  });
  await expect(requireImportStream()?.(target, stream, { passphrase: "mid-body stall" })).rejects.toThrow(
    /stalled waiting for bytes/,
  );
  expect(cancelled).toBe(true);
  expect(existsSync(join(target.objectsDir, ".import-pending"))).toBe(false);
  expect(target.threads.list()).toHaveLength(0);
}, 8_000);

test("raw import rejects a slow-drip stream at its absolute deadline and removes staging", async () => {
  const target = freshVault();
  let interval: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(0x50));
      interval = setInterval(() => {
        try {
          controller.enqueue(Uint8Array.of(0x59));
        } catch {
          clearInterval(interval);
        }
      }, 10);
    },
    cancel() {
      cancelled = true;
      clearInterval(interval);
      return new Promise<void>(() => undefined);
    },
  });
  await expect(
    requireImportStream()?.(target, stream, {
      passphrase: "slow drip",
      transferDeadlineMs: 100,
    }),
  ).rejects.toThrow(/transfer deadline/);
  expect(cancelled).toBe(true);
  expect(existsSync(join(target.objectsDir, ".import-pending"))).toBe(false);
  expect(target.threads.list()).toHaveLength(0);
});

test("v2 capsule ledger sidecar rejects forged receipt and ordinal state atomically", async () => {
  const { vault, thread } = tempVault({ budget: 8_192 });
  vault.episodes.append(thread.id, { role: "user", content: "dense receipt authority" });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 31 }, (_, index) => ({ role: "user" as const, content: `pad ${index}` })),
  );
  const insert = vault.db.query(
    "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, " +
      "valid_from_seq, valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, " +
      "created_by, created_at) VALUES (?, ?, 'fact', ?, ?, '', 1, '[0,3]', 1, NULL, NULL, " +
      "'PROPOSED', 'model', 'global', 0, 1, 'model:bundle-oracle', 1)",
  );
  vault.db.transaction(() => {
    for (let index = 0; index < 300; index += 1) {
      const name = `bundle-dense-${index.toString().padStart(3, "0")}`;
      insert.run(`bundle-dense-atom-${index}`, thread.id, name, name);
    }
  })();
  core.compact(vault, thread.id, { writer: () => "bundle-dense-000", budget: 8_192 });
  const leaf = vault.capsules.at(thread.id, 0, 1);
  if (leaf === null) throw new Error("dense ledger leaf missing");
  const exactRows = vault.db
    .query(
      "SELECT part, name, kind, seq, span FROM capsule_ledger_entry " +
        "WHERE capsule_id = ? ORDER BY part ASC, ordinal ASC",
    )
    .all(leaf.id) as Array<{
    part: "dropped" | "kept";
    name: string;
    kind: "entity" | "number" | "quote" | "atom" | "date" | "code";
    seq: number;
    span: string | null;
  }>;
  const exactPart = (part: "dropped" | "kept") =>
    exactRows
      .filter((row) => row.part === part)
      .map((row) => ({
        name: row.name,
        kind: row.kind,
        seq: row.seq,
        ...(row.span === null ? {} : { span: JSON.parse(row.span) as [number, number] }),
      }));
  vault.db
    .query("UPDATE capsule SET dropped = ?, kept = ?, ledger_receipt = NULL WHERE id = ?")
    .run(JSON.stringify(exactPart("dropped")), JSON.stringify(exactPart("kept")), leaf.id);
  vault.db.query("DELETE FROM capsule_ledger_entry WHERE capsule_id = ?").run(leaf.id);
  expect(vault.capsules.get(leaf.id)?.ledgerReceipt).toBeUndefined();
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 224 }, (_, index) => ({
      role: "user" as const,
      content: `later parent pad ${index}`,
    })),
  );
  core.compact(vault, thread.id, { writer: () => "bundle-dense-000", budget: 8_192 });
  expect(vault.capsules.at(thread.id, 1, 1)?.ledgerReceipt).toBeDefined();

  const passphrase = "capsule ledger forged sidecar";
  const base = await core.exportBundle(vault, thread.id, { passphrase });
  const normalized = vault.capsules.get(leaf.id);
  expect(normalized?.ledgerReceipt?.dropped.count).toBe(exactPart("dropped").length);
  expect(normalized?.ledgerReceipt?.dropped.complete).toBe(false);
  expect(
    (
      vault.db.query("SELECT COUNT(*) AS n FROM capsule_ledger_entry WHERE capsule_id = ?").get(leaf.id) as {
        n: number;
      }
    ).n,
  ).toBe(exactRows.length);
  await expect(core.exportBundleV1(vault, thread.id, { passphrase })).rejects.toThrow(
    /legacy v1 export cannot preserve capsule ledger continuations; use v2/,
  );

  const candidates: Array<{
    entry: "capsules.jsonl" | "capsule-ledger-entries.jsonl" | "manifest.json";
    rewrite: (
      row: Record<string, unknown>,
      rows: Record<string, unknown>[],
    ) => Record<string, unknown>[] | Record<string, unknown>;
    replaceAll?: boolean;
    expected: RegExp;
  }> = [
    {
      entry: "capsules.jsonl",
      rewrite: (row) => {
        const receipt = row.ledgerReceipt as Record<string, Record<string, unknown> | number>;
        return {
          ...row,
          ledgerReceipt: {
            ...receipt,
            dropped: { ...(receipt.dropped as Record<string, unknown>), digest: "0".repeat(64) },
          },
        };
      },
      expected: /dropped receipt digest mismatch/,
    },
    {
      entry: "capsules.jsonl",
      rewrite: (row) => {
        const receipt = row.ledgerReceipt as Record<string, Record<string, unknown> | number>;
        const dropped = receipt.dropped as Record<string, unknown>;
        return {
          ...row,
          ledgerReceipt: {
            ...receipt,
            dropped: { ...dropped, count: Number(dropped.count) + 1 },
          },
        };
      },
      expected: /dropped receipt count mismatch/,
    },
    {
      entry: "capsules.jsonl",
      rewrite: (row) => {
        const receipt = row.ledgerReceipt as Record<string, Record<string, unknown> | number>;
        return {
          ...row,
          ledgerReceipt: {
            ...receipt,
            dropped: { ...(receipt.dropped as Record<string, unknown>), cursor: "not-a-cursor" },
          },
        };
      },
      expected: /receipt cursor (is invalid|mismatch)/,
    },
    {
      entry: "capsule-ledger-entries.jsonl",
      rewrite: (_row, rows) => rows.slice(1),
      replaceAll: true,
      expected: /ledger ordinal gap/,
    },
    {
      entry: "capsule-ledger-entries.jsonl",
      rewrite: () => [],
      replaceAll: true,
      expected: /receipt count mismatch/,
    },
    {
      entry: "manifest.json",
      rewrite: (row) => {
        const extended = row.countsExtended as Record<string, number>;
        return {
          ...row,
          countsExtended: {
            ...extended,
            capsuleLedgerEntries: Number(extended.capsuleLedgerEntries) + 1,
          },
        };
      },
      expected: /declares \d+ capsule ledger entries and carries \d+/,
    },
  ];
  for (const candidate of candidates) {
    const forged = await rewriteBundleJsonl(
      base,
      passphrase,
      candidate.entry,
      candidate.rewrite,
      candidate.replaceAll ?? false,
    );
    const target = freshVault();
    await expect(core.importBundle(target, forged, { passphrase })).rejects.toThrow(candidate.expected);
    expect(target.threads.get(thread.id)).toBeNull();
    expect((target.db.query("SELECT COUNT(*) AS n FROM capsule_ledger_entry").get() as { n: number }).n).toBe(
      0,
    );
  }

  let rootId = "";
  let rootPart: "dropped" | "kept" = "dropped";
  let rootRows: Record<string, unknown>[] = [];
  const missingRootEntry = await rewriteBundleJsonl(
    base,
    passphrase,
    "capsule-ledger-entries.jsonl",
    (_row, rows) => {
      const target = rows.find(
        (row) => typeof row.capsule_id === "string" && row.capsule_id.startsWith("root:"),
      );
      if (target === undefined) throw new Error("dense fixture has no root omission locator");
      rootId = String(target.capsule_id);
      rootPart = target.part as "dropped" | "kept";
      rootRows = rows
        .filter((row) => row !== target)
        .map((row) =>
          row.capsule_id === rootId && row.part === rootPart && Number(row.ordinal) > Number(target.ordinal)
            ? { ...row, ordinal: Number(row.ordinal) - 1 }
            : row,
        );
      return rootRows;
    },
    true,
  );
  const selfConsistentRootOmission = await rewriteBundleJsonl(
    missingRootEntry,
    passphrase,
    "capsules.jsonl",
    (_row, rows) =>
      rows.map((row) => {
        if (row.id !== rootId) return row;
        const receipt = row.ledgerReceipt as Record<string, Record<string, unknown> | number>;
        const partReceipt = receipt[rootPart] as Record<string, unknown>;
        const entries = rootRows
          .filter((entry) => entry.capsule_id === rootId && entry.part === rootPart)
          .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
          .map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            seq: entry.seq,
            ...(entry.span === null ? {} : { span: JSON.parse(String(entry.span)) }),
          }));
        const digest = createHash("sha256");
        for (const entry of entries) digest.update(`${canonicalJson(entry)}\n`, "utf8");
        const embeddedCount = Math.min(Number(partReceipt.embeddedCount), entries.length);
        const complete = embeddedCount === entries.length;
        return {
          ...row,
          [rootPart]: entries.slice(0, embeddedCount),
          ledgerReceipt: {
            ...receipt,
            [rootPart]: {
              count: entries.length,
              embeddedCount,
              digest: digest.digest("hex"),
              complete,
              ...(complete
                ? {}
                : {
                    cursor: Buffer.from(
                      JSON.stringify({
                        version: 1,
                        capsuleId: rootId,
                        capsuleHash: row.hash,
                        part: rootPart,
                        after: embeddedCount - 1,
                      }),
                    ).toString("base64url"),
                  }),
            },
          },
        };
      }),
    true,
  );
  const rootTarget = freshVault();
  await expect(core.importBundle(rootTarget, selfConsistentRootOmission, { passphrase })).rejects.toThrow(
    /receipt mismatches source locator/,
  );
  expect(rootTarget.threads.get(thread.id)).toBeNull();

  const forgeCanonicalLocator = async (
    mutate: (row: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Uint8Array> => {
    let forgedRows: Record<string, unknown>[] = [];
    let forgedLocator: Record<string, unknown> | undefined;
    const sidecar = await rewriteBundleJsonl(
      base,
      passphrase,
      "capsule-ledger-entries.jsonl",
      (_row, rows) => {
        const target = rows.find((row) => row.part === "dropped");
        if (target === undefined) throw new Error("dense ledger has no dropped locator");
        forgedLocator = mutate(target);
        forgedRows = rows.map((row) => (row === target ? (forgedLocator as Record<string, unknown>) : row));
        return forgedRows;
      },
      true,
    );
    const locator = forgedLocator;
    if (locator === undefined) throw new Error("forged locator missing");
    const matchingLoss = await rewriteBundleJsonl(
      sidecar,
      passphrase,
      "loss.jsonl",
      (_row, rows) =>
        rows.map((row) =>
          row.name === locator.name && row.seq === locator.seq
            ? { ...row, kind: locator.kind, span: locator.span }
            : row,
        ),
      true,
    );
    return rewriteBundleJsonl(
      matchingLoss,
      passphrase,
      "capsules.jsonl",
      (_row, rows) =>
        rows.map((row) => {
          if (row.id !== locator.capsule_id) return row;
          const receipt = row.ledgerReceipt as Record<string, Record<string, unknown> | number>;
          const droppedReceipt = receipt.dropped as Record<string, unknown>;
          const entries = forgedRows
            .filter((entry) => entry.capsule_id === row.id && entry.part === "dropped")
            .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
            .map((entry) => ({
              name: entry.name,
              kind: entry.kind,
              seq: entry.seq,
              ...(entry.span === null ? {} : { span: JSON.parse(String(entry.span)) }),
            }));
          const digest = createHash("sha256");
          for (const entry of entries) digest.update(`${canonicalJson(entry)}\n`, "utf8");
          return {
            ...row,
            dropped: entries.slice(0, Number(droppedReceipt.embeddedCount)),
            ledgerReceipt: {
              ...receipt,
              dropped: { ...droppedReceipt, digest: digest.digest("hex") },
            },
          };
        }),
      true,
    );
  };
  for (const mutate of [
    (row: Record<string, unknown>) => ({ ...row, kind: row.kind === "code" ? "date" : "code" }),
    (row: Record<string, unknown>) => ({
      ...row,
      span: row.span === "[0,1]" ? "[1,2]" : "[0,1]",
    }),
  ]) {
    const forged = await forgeCanonicalLocator(mutate);
    const target = freshVault();
    await expect(core.importBundle(target, forged, { passphrase })).rejects.toThrow(
      /receipt mismatches source locator/,
    );
    expect(target.threads.get(thread.id)).toBeNull();
    expect((target.db.query("SELECT COUNT(*) AS n FROM capsule_ledger_entry").get() as { n: number }).n).toBe(
      0,
    );
  }
}, 120_000);
