/**
 * Attachment byte manifests (KERNEL A12.3).
 *
 * The archive keeps the original object for v1 compatibility, but every new
 * attachment is also partitioned into independently addressed spans.  This
 * module deliberately has no Vault dependency: the caller supplies the object
 * writer, which keeps the byte partition deterministic and easy to verify.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import {
  type AttachmentManifest,
  type AttachmentSpan,
  type Episode,
  MAX_ATTACHMENT_MIME_BYTES,
  MAX_ATTACHMENT_NAME_BYTES,
  type Seq,
} from "@pylos/protocol";
import { canonicalHash, newId, sha256 } from "./hash.ts";
import type { Vault } from "./vault.ts";

export { MAX_ATTACHMENT_MIME_BYTES, MAX_ATTACHMENT_NAME_BYTES };

/** Maximum object size for one indexed or opaque attachment span. */
export const ATTACHMENT_CHUNK_SIZE = 64 * 1024;

const UTF8_ENCODER = new TextEncoder();

/** Validate the two caller-controlled strings copied into every new manifest. */
export function attachmentMetadataFailure(mime: unknown, name: unknown): string | null {
  if (typeof name !== "string") return "attachment filename must be a string";
  // A JavaScript code unit is at least one UTF-8 byte.  Rejecting by length
  // first prevents an attacker-controlled multi-megabyte string from forcing
  // a second equally large encoder allocation just to discover it is over cap.
  if (name.length > MAX_ATTACHMENT_NAME_BYTES) {
    return `attachment filename exceeds ${MAX_ATTACHMENT_NAME_BYTES} UTF-8 bytes`;
  }
  if (UTF8_ENCODER.encode(name).byteLength > MAX_ATTACHMENT_NAME_BYTES) {
    return `attachment filename exceeds ${MAX_ATTACHMENT_NAME_BYTES} UTF-8 bytes`;
  }
  if (typeof mime !== "string") return "attachment MIME type must be a string";
  if (mime.length > MAX_ATTACHMENT_MIME_BYTES) {
    return `attachment MIME type exceeds ${MAX_ATTACHMENT_MIME_BYTES} UTF-8 bytes`;
  }
  if (UTF8_ENCODER.encode(mime).byteLength > MAX_ATTACHMENT_MIME_BYTES) {
    return `attachment MIME type exceeds ${MAX_ATTACHMENT_MIME_BYTES} UTF-8 bytes`;
  }
  return null;
}

/**
 * Normalize a filename for the write-time address index.  This is an address
 * projection only: callers must still compare the returned row with the
 * episode's chain-covered metadata before serving bytes.
 */
export function normalizeAttachmentName(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > MAX_ATTACHMENT_NAME_BYTES) return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  if (normalized.length === 0 || UTF8_ENCODER.encode(normalized).byteLength > MAX_ATTACHMENT_NAME_BYTES)
    return null;
  return normalized;
}

/** Return the manifest/name field that is safe to place in the derived index. */
export function attachmentNameFromMeta(meta: unknown): string | null {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  if ("name" in record && record.name !== undefined && typeof record.name !== "string") return null;
  const manifest = record.manifest;
  const manifestName =
    manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>).name
      : manifest === undefined
        ? undefined
        : null;
  if (manifestName !== undefined && typeof manifestName !== "string") return null;
  if (
    typeof record.name === "string" &&
    record.name.length > 0 &&
    typeof manifestName === "string" &&
    manifestName.length > 0 &&
    normalizeAttachmentName(record.name) !== normalizeAttachmentName(manifestName)
  ) {
    return null;
  }
  if (typeof record.name === "string" && record.name.length > 0) return record.name;
  return typeof manifestName === "string" && manifestName.length > 0 ? manifestName : null;
}

/**
 * Extract a bounded set of exact normalized name probes from a question.  The
 * SQL lookup is equality-only; these probes are addresses, never fuzzy search.
 */
export function attachmentNameProbes(query: string, limit = 64): string[] {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 64));
  const probes = new Set<string>();
  const add = (value: string): void => {
    const normalized = normalizeAttachmentName(value);
    if (normalized !== null) probes.add(normalized);
  };
  const addToken = (value: string): void => {
    // Sentence punctuation is outside an unquoted filename. Probe the
    // punctuation-free form first so the bounded set cannot fill before the
    // exact address is considered; retain the raw form for legitimate names
    // that really end in punctuation.
    const withoutTerminalPunctuation = value.replace(/[.,;:!?…)\]}]+$/gu, "");
    if (withoutTerminalPunctuation !== value) add(withoutTerminalPunctuation);
    add(value);
  };
  for (const match of query.matchAll(/["'`]([^"'`\n]{1,4096})["'`]/gu)) add(match[1] as string);
  for (const match of query.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._/\\-]{0,255}/gu)) addToken(match[0]);
  const words = [...query.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._-]{0,255}/gu)].map(
    (match) => match[0] as string,
  );
  // Quoted names and file-like tokens are the common address forms.  A small
  // n-gram tail keeps unpunctuated names such as "project notes" routable
  // without turning the route into a scan of every stored name.
  for (let start = 0; start < words.length && probes.size < boundedLimit; start += 1) {
    for (
      let end = start + 2;
      end <= Math.min(words.length, start + 8) && probes.size < boundedLimit;
      end += 1
    ) {
      addToken(words.slice(start, end).join(" "));
    }
  }
  return [...probes].slice(0, boundedLimit);
}

/** MIME types for which a valid UTF-8 object may be placed in the text index. */
export function isIndexableAttachment(mime: string): boolean {
  const normalized = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/ld+json" ||
    normalized === "application/xml" ||
    normalized === "application/xhtml+xml" ||
    normalized === "application/javascript" ||
    normalized === "application/typescript" ||
    normalized === "application/x-ndjson"
  );
}

/**
 * Move a byte boundary back over UTF-8 continuation bytes.  A boundary that
 * starts at a continuation byte is never emitted; the next span starts at the
 * boundary returned here.
 */
function utf8Boundary(bytes: Uint8Array, candidate: number): number {
  let boundary = Math.min(bytes.byteLength, Math.max(0, candidate));
  while (
    boundary > 0 &&
    boundary < bytes.byteLength &&
    (((bytes[boundary] as number | undefined) ?? 0) & 0xc0) === 0x80
  ) {
    boundary -= 1;
  }
  return boundary;
}

function canonicalManifestBase(input: {
  id: string;
  hash: string;
  size: number;
  mime: string;
  name: string;
  chunkSize: number;
  spans: readonly AttachmentSpan[];
}): Record<string, unknown> {
  return {
    id: input.id,
    hash: input.hash,
    size: input.size,
    mime: input.mime,
    name: input.name,
    chunkSize: input.chunkSize,
    spans: input.spans,
  };
}

/** Canonical digest input for a manifest, excluding its self-referential digest. */
export function manifestDigestOf(manifest: AttachmentManifest): string {
  return canonicalHash(
    canonicalManifestBase({
      id: manifest.id,
      hash: manifest.hash,
      size: manifest.size,
      mime: manifest.mime,
      name: manifest.name,
      chunkSize: manifest.chunkSize,
      spans: manifest.spans,
    }),
  );
}

/**
 * Build and hash an attachment manifest, writing each span through `put`.
 * `put` must return the content-addressed object hash (the Vault's blob store
 * does exactly that).  The whole object is intentionally not written here;
 * the caller writes it separately so the legacy `meta.blob` pointer survives.
 */
export function buildAttachmentManifest(
  bytes: Uint8Array,
  mime = "application/octet-stream",
  name = "",
  put: (span: Uint8Array, mime: string) => string,
  /**
   * The exact attachment text inserted into the episode FTS row.  This is
   * supplied by the kernel from the episode content, never accepted from
   * attachment metadata.  Only the byte prefix equal to this text can be
   * labelled `indexed`; the remainder is an explicit opaque span.
   */
  indexedContent?: string,
): AttachmentManifest {
  const metadataFailure = attachmentMetadataFailure(mime, name);
  if (metadataFailure !== null) throw new Error(metadataFailure);
  const normalizedMime = mime.length > 0 ? mime : "application/octet-stream";
  const normalizedName = name;
  const wholeHash = sha256(bytes);
  // The episode's FTS row contains `indexedContent`, not necessarily the
  // entire attachment object (the server intentionally caps extracted text).
  // Compare encoded episode bytes with the object itself.  A common prefix is
  // the only index coverage the kernel can prove; metadata cannot extend it.
  let indexedLimit = 0;
  if (isIndexableAttachment(normalizedMime) && indexedContent !== undefined) {
    const indexedBytes = UTF8_ENCODER.encode(indexedContent);
    const commonLength = Math.min(bytes.byteLength, indexedBytes.byteLength);
    let common = 0;
    while (common < commonLength && bytes[common] === indexedBytes[common]) common += 1;
    // Never split a code point at the indexed/opaque boundary.  Invalid bytes
    // after the proven prefix simply remain opaque, which preserves custody.
    indexedLimit = utf8Boundary(bytes, common);
  }

  const spans: AttachmentSpan[] = [];
  if (bytes.byteLength === 0) {
    const objectHash = put(bytes, normalizedMime);
    const indexedEmpty =
      indexedContent !== undefined && isIndexableAttachment(normalizedMime) && indexedContent.length === 0;
    spans.push({
      ordinal: 0,
      from: 0,
      to: 0,
      hash: objectHash,
      state: indexedEmpty ? "indexed" : "opaque",
      objectHash,
      ...(indexedEmpty ? { encoding: "utf-8" as const } : {}),
    });
  } else {
    let from = 0;
    let ordinal = 0;
    while (from < bytes.byteLength) {
      let to = Math.min(bytes.byteLength, from + ATTACHMENT_CHUNK_SIZE);
      // If the proven FTS prefix ends inside this chunk, split at that exact
      // UTF-8 boundary.  The suffix starts an opaque span and is never
      // presented as decoded/indexed merely because it is valid text.
      if (from < indexedLimit && indexedLimit < to) to = indexedLimit;
      if (to <= from) to = Math.min(bytes.byteLength, from + ATTACHMENT_CHUNK_SIZE);
      if (to < bytes.byteLength && to <= indexedLimit) {
        to = utf8Boundary(bytes, to);
        // A single UTF-8 code point is at most four bytes, so this only occurs
        // for an unusually tiny/invalid boundary.  Advance conservatively to
        // ensure progress while keeping the next boundary valid.
        if (to <= from) to = Math.min(bytes.byteLength, from + ATTACHMENT_CHUNK_SIZE);
      }
      const indexed = to <= indexedLimit;
      const spanBytes = bytes.subarray(from, to);
      const objectHash = put(spanBytes, normalizedMime);
      spans.push({
        ordinal,
        from,
        to,
        hash: objectHash,
        state: indexed ? "indexed" : "opaque",
        objectHash,
        ...(indexed ? { encoding: "utf-8" as const } : {}),
      });
      from = to;
      ordinal += 1;
    }
  }

  const id = newId("am");
  const base = canonicalManifestBase({
    id,
    hash: wholeHash,
    size: bytes.byteLength,
    mime: normalizedMime,
    name: normalizedName,
    chunkSize: ATTACHMENT_CHUNK_SIZE,
    spans,
  });
  return {
    ...base,
    digest: canonicalHash(base),
  } as AttachmentManifest;
}

/** A legacy whole-blob object has one explicit opaque span. */
export function legacyAttachmentManifest(
  hash: string,
  size: number,
  mime = "application/octet-stream",
  name = "",
): AttachmentManifest {
  const id = `legacy_${hash}`;
  const span: AttachmentSpan = {
    ordinal: 0,
    from: 0,
    to: Math.max(0, size),
    hash,
    state: "opaque",
    objectHash: hash,
  };
  const base = canonicalManifestBase({
    id,
    hash,
    size: Math.max(0, size),
    mime: mime || "application/octet-stream",
    name,
    // Legacy archives have one whole-object opaque span.  Its declared chunk
    // size must describe that span so structural verification can still
    // authenticate bounded sub-ranges without pretending the object was
    // partitioned at A12.3's 64 KiB boundary.
    chunkSize: Math.max(1, size),
    spans: [span],
  });
  return { ...base, digest: canonicalHash(base), legacy: true } as AttachmentManifest;
}

export interface AttachmentSpanRead {
  episode: Episode;
  manifest: AttachmentManifest;
  span: AttachmentSpan;
  bytes: Uint8Array;
}

export interface AttachmentRangeRead {
  episode: Episode;
  manifest: AttachmentManifest;
  byteRange: [number, number];
  bytes: Uint8Array;
  opaque: boolean;
}

export interface AttachmentRangeReadOptions {
  /** Reject a range that intersects any opaque manifest span. */
  requireIndexed?: boolean;
}

/** Structural/hash verification for a manifest span without retaining bytes. */
export interface AttachmentSpanVerification {
  episode: Episode;
  manifest: AttachmentManifest;
  span: AttachmentSpan;
}

/**
 * Read one object through a fixed-size buffer.  `select` is deliberately
 * bounded by the caller; all other bytes are hashed and discarded.  Reading
 * the object file directly matters for legacy manifests, whose one opaque
 * span can be much larger than the evidence/page budget.
 */
function streamObject(
  vault: Vault,
  objectHash: string,
  expectedSize: number,
  select: [number, number] | undefined,
  onChunk: (chunk: Uint8Array) => void,
): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(objectHash) || !Number.isSafeInteger(expectedSize) || expectedSize < 0)
    return null;
  if (select !== undefined) {
    const [from, to] = select;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) return null;
    if (to > expectedSize || to - from > ATTACHMENT_CHUNK_SIZE) return null;
  }
  // New A12 manifests store each span as a bounded content-addressed object.
  // Use the indexed size guard before the convenience read so a forged DB row
  // cannot turn this fast path into an unbounded allocation. Legacy whole
  // objects (and rows without size metadata) fall through to the fixed-buffer
  // file reader below.
  if (expectedSize <= ATTACHMENT_CHUNK_SIZE && vault.blobs.size(objectHash) === expectedSize) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = vault.blobs.get(objectHash);
    } catch {
      // A caller may deliberately deny whole-object reads; the bounded file
      // path remains authoritative and will verify the same hash.
    }
    if (bytes !== null) {
      if (bytes.byteLength !== expectedSize || sha256(bytes) !== objectHash) return null;
      onChunk(bytes);
      return select === undefined ? new Uint8Array(0) : bytes.slice(select[0], select[1]);
    }
  }
  const selected = select === undefined ? new Uint8Array(0) : new Uint8Array(select[1] - select[0]);
  const digest = createHash("sha256");
  let offset = 0;
  let handle: number;
  const objectPath = vault.blobObjectPath(objectHash, expectedSize);
  if (objectPath === null) return null;
  try {
    handle = openSync(objectPath, "r");
  } catch {
    return null;
  }
  const buffer = new Uint8Array(ATTACHMENT_CHUNK_SIZE);
  try {
    while (offset < expectedSize) {
      const count = readSync(handle, buffer, 0, buffer.byteLength, offset);
      if (count <= 0) return null;
      const chunk = buffer.subarray(0, count);
      digest.update(chunk);
      onChunk(chunk);
      if (select !== undefined) {
        const intersectionFrom = Math.max(select[0], offset);
        const intersectionTo = Math.min(select[1], offset + count);
        if (intersectionFrom < intersectionTo) {
          selected.set(
            chunk.subarray(intersectionFrom - offset, intersectionTo - offset),
            intersectionFrom - select[0],
          );
        }
      }
      offset += count;
    }
    // A file longer than its chain-covered manifest size is not a valid
    // object either.  Read one byte only to distinguish exact EOF from a
    // truncated read without allocating based on untrusted size metadata.
    const extra = new Uint8Array(1);
    if (readSync(handle, extra, 0, 1, offset) !== 0) return null;
  } catch {
    return null;
  } finally {
    closeSync(handle);
  }
  if (digest.digest("hex") !== objectHash) return null;
  return selected;
}

function manifestForEpisode(
  vault: Vault,
  threadId: string,
  seq: Seq,
): {
  episode: Episode;
  manifest: AttachmentManifest;
} | null {
  // Attachment range verification never needs the episode's prose. Keep the
  // metadata projection bounded so an imported multi-gigabyte source cannot
  // escape through a page/coverage read merely because its manifest is valid.
  const episode = vault.episodes.getBounded(threadId, seq, 0, 64 * 1024);
  if (episode === null || episode.role !== "attachment" || episode.meta.removed === true) return null;
  const blob = typeof episode.meta.blob === "string" ? episode.meta.blob : null;
  if (blob === null) return null;
  const manifest =
    episode.meta.manifest ??
    legacyAttachmentManifest(
      blob,
      episode.meta.size ?? vault.blobs.size(blob) ?? 0,
      episode.meta.mime ?? "application/octet-stream",
      episode.meta.name ?? episode.content,
    );
  if (!manifestPartitionValid(manifest) || manifest.hash !== blob) return null;
  return { episode, manifest };
}

/**
 * Read one exact byte range without materializing a whole attachment object.
 * Every span is streamed through a fixed-size hash accumulator so the whole
 * object digest remains authoritative; only bytes intersecting `byteRange`
 * are retained for the caller.  A missing or corrupt span fails closed.
 */
export function readAttachmentRange(
  vault: Vault,
  threadId: string,
  seq: Seq,
  byteRange: [number, number],
  options: AttachmentRangeReadOptions = {},
): AttachmentRangeRead | null {
  const source = manifestForEpisode(vault, threadId, seq);
  if (source === null) return null;
  const { episode, manifest } = source;
  const [from, to] = byteRange;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to <= from ||
    to > manifest.size ||
    to - from > ATTACHMENT_CHUNK_SIZE
  ) {
    return null;
  }
  if (
    options.requireIndexed === true &&
    manifest.spans.some((span) => span.from < to && span.to > from && span.state !== "indexed")
  ) {
    return null;
  }
  const selected = new Uint8Array(to - from);
  const whole = createHash("sha256");
  let covered = false;
  let opaque = false;
  for (const span of manifest.spans) {
    const intersectionFrom = Math.max(from, span.from);
    const intersectionTo = Math.min(to, span.to);
    const selectedSpan =
      intersectionFrom < intersectionTo
        ? ([intersectionFrom - span.from, intersectionTo - span.from] as [number, number])
        : undefined;
    const bytes = streamObject(vault, span.objectHash, span.to - span.from, selectedSpan, (chunk) => {
      whole.update(chunk);
    });
    if (bytes === null) return null;
    if (selectedSpan !== undefined) {
      if (span.state === "opaque") opaque = true;
      selected.set(bytes, intersectionFrom - from);
      covered = true;
    }
  }
  if (!covered || whole.digest("hex") !== manifest.hash) return null;
  return { episode, manifest, byteRange: [from, to], bytes: selected, opaque };
}

/**
 * Verify every manifest object and the whole-object digest while retaining no
 * attachment bytes.  This is used by custody-only tail receipts, including
 * imported legacy manifests whose opaque span may exceed the read budget.
 */
export function verifyAttachmentSpan(
  vault: Vault,
  threadId: string,
  seq: Seq,
  ordinal: number,
): AttachmentSpanVerification | null {
  if (!Number.isInteger(ordinal) || ordinal < 0) return null;
  const source = manifestForEpisode(vault, threadId, seq);
  if (source === null) return null;
  const { episode, manifest } = source;
  const span = manifest.spans[ordinal];
  if (span === undefined || span.to < span.from) return null;
  const whole = createHash("sha256");
  for (const candidate of manifest.spans) {
    const bytes = streamObject(
      vault,
      candidate.objectHash,
      candidate.to - candidate.from,
      undefined,
      (chunk) => {
        whole.update(chunk);
      },
    );
    if (bytes === null) return null;
  }
  return whole.digest("hex") === manifest.hash ? { episode, manifest, span } : null;
}

/**
 * Read one exact, hash-verified content-addressed attachment span.
 *
 * The `attachment:{seq}` locator in a reachability receipt is intentionally
 * not authority: callers still receive bytes only after the kernel verifies
 * the span object, its declared range, and its equality with the corresponding
 * slice of the retained whole object.  A missing or corrupt chunk returns
 * `null`, even when the whole object remains available.
 */
export function readAttachmentSpan(
  vault: Vault,
  threadId: string,
  seq: Seq,
  ordinal: number,
): AttachmentSpanRead | null {
  if (!Number.isInteger(ordinal) || ordinal < 0) return null;
  const source = manifestForEpisode(vault, threadId, seq);
  if (source === null) return null;
  const { episode, manifest } = source;
  const span = manifest.spans[ordinal];
  if (span === undefined || span.to <= span.from) return null;
  const range = readAttachmentRange(vault, threadId, seq, [span.from, span.to]);
  if (range === null) return null;
  return { episode, manifest, span, bytes: range.bytes };
}

/**
 * Verify a manifest's structural partition without reading any object bytes.
 * The page route performs the stronger span-hash check before rendering.
 */
export function manifestPartitionValid(manifest: AttachmentManifest): boolean {
  if (!Number.isInteger(manifest.size) || manifest.size < 0) return false;
  if (!Number.isInteger(manifest.chunkSize) || manifest.chunkSize <= 0) return false;
  if (!Array.isArray(manifest.spans)) return false;
  if (manifest.digest !== manifestDigestOf(manifest)) return false;
  let cursor = 0;
  for (const [index, span] of manifest.spans.entries()) {
    if (span.ordinal !== index) return false;
    if (!Number.isInteger(span.from) || !Number.isInteger(span.to)) return false;
    if (span.from !== cursor || span.from < 0 || span.to < span.from || span.to > manifest.size) return false;
    if (span.to - span.from > manifest.chunkSize) return false;
    if (span.hash !== span.objectHash || !/^[0-9a-f]{64}$/.test(span.hash)) return false;
    if (span.state !== "indexed" && span.state !== "opaque") return false;
    if (span.state === "indexed" && span.encoding !== "utf-8") return false;
    cursor = span.to;
  }
  // Empty objects have one explicit empty span; non-empty objects must have a
  // positive partition.  This avoids treating a missing manifest as coverage.
  return (
    cursor === manifest.size &&
    (manifest.size === 0 ? manifest.spans.length === 1 : manifest.spans.length > 0)
  );
}
