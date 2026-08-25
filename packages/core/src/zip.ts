/**
 * A minimal ZIP writer/reader (deflate + store) for the legacy v1 container.
 * Current `.pylos` streams use the framed v2 container in `bundle.ts`; this
 * module remains deliberately unaware of bundle contents.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Limits applied while reading an untrusted bundle container. */
export interface ZipLimits {
  /** Maximum number of central-directory entries. */
  maxEntries: number;
  /** Maximum uncompressed bytes in one entry. */
  maxEntryBytes: number;
  /** Maximum total uncompressed bytes. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 100_000,
  maxEntryBytes: 1_024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i += 1) {
    crc = ((CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

/** Build a zip archive. Entries are deflated unless deflation does not help. */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data);
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, payload);

    const dir = Buffer.alloc(46 + name.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    name.copy(dir, 46);
    central.push(dir);

    offset += local.length + payload.length;
  }
  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...locals, centralBuffer, eocd]));
}

/** Read a zip archive produced by {@link zip} (or any store/deflate zip). */
export function unzip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): Map<string, Uint8Array> {
  const bound = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const buffer = Buffer.from(bytes);
  if (buffer.length > bound.maxTotalBytes) throw new Error("zip exceeds the archive byte limit");
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65_535); i -= 1) {
    if (i < 0 || i + 4 > buffer.length) continue;
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  if (eocd + 22 > buffer.length) throw new Error("truncated zip end record");
  const count = buffer.readUInt16LE(eocd + 10);
  if (count > bound.maxEntries) throw new Error("zip has too many entries");
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset > buffer.length || centralSize > buffer.length - centralOffset) {
    throw new Error("truncated zip central directory");
  }
  let pointer = centralOffset;
  const out = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (let i = 0; i < count; i += 1) {
    if (pointer + 46 > buffer.length || pointer + 46 > centralOffset + centralSize) {
      throw new Error("truncated central directory entry");
    }
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buffer.readUInt16LE(pointer + 10);
    if (method !== 0 && method !== 8) throw new Error("unsupported zip compression method");
    const crc = buffer.readUInt32LE(pointer + 16);
    const compSize = buffer.readUInt32LE(pointer + 20);
    const rawSize = buffer.readUInt32LE(pointer + 24);
    if (rawSize > bound.maxEntryBytes) throw new Error("zip entry exceeds the entry byte limit");
    if (rawSize > bound.maxTotalBytes - totalBytes) throw new Error("zip exceeds the total byte limit");
    const nameLen = buffer.readUInt16LE(pointer + 28);
    const extraLen = buffer.readUInt16LE(pointer + 30);
    const commentLen = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    if (pointer + 46 + nameLen + extraLen + commentLen > centralOffset + centralSize) {
      throw new Error("truncated central directory name");
    }
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLen);
    if (
      name.length === 0 ||
      name.includes("\0") ||
      name.startsWith("/") ||
      name.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new Error(`unsafe zip entry name ${name}`);
    }
    if (out.has(name)) throw new Error(`duplicate zip entry ${name}`);

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`truncated local header for ${name}`);
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart > buffer.length || compSize > buffer.length - dataStart) {
      throw new Error(`truncated zip entry ${name}`);
    }

    const payload = buffer.subarray(dataStart, dataStart + compSize);
    const raw =
      method === 8 ? inflateRawSync(payload, { maxOutputLength: bound.maxEntryBytes }) : Buffer.from(payload);
    if (raw.length !== rawSize) throw new Error(`zip size mismatch for ${name}`);
    if (crc32(raw) !== crc) throw new Error(`crc mismatch for ${name}`);
    out.set(name, new Uint8Array(raw));
    totalBytes += raw.length;
    pointer += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
