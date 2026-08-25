/**
 * The retained-byte closure receipt (KERNEL A12).
 *
 * Compilation only reads the resident episodes and the bounded capsule
 * frontier.  Everything else is described as a sequence range; the expensive
 * expansion of those ranges is deliberately reserved for the explicit
 * verifier.  Attachment manifests are already chunked at write time, so they
 * can be copied into a packet without reading the object bytes.
 */

import type {
  AttachmentManifest,
  AttachmentRangeReachabilitySpan,
  AttachmentSpan,
  Episode,
  EpisodeMeta,
  EpisodeRangeReachabilitySpan,
  ExplicitReachabilitySpan,
  ReachabilitySpan,
  ResidentItem,
  Seq,
} from "@pylos/protocol";
import { MAX_PACKET_JSON_BYTES } from "@pylos/protocol";
import { manifestPartitionValid, readAttachmentRange, verifyAttachmentSpan } from "./attachment.ts";
import { removalRecord } from "./forget.ts";
import { canonicalHash, sha256 } from "./hash.ts";
import { type StoredCapsule, type Vault, VaultError } from "./vault.ts";

const encoder = new TextEncoder();

export interface ReachabilityBuildOptions {
  /** Resident packet items after the final render trim. */
  resident: readonly ResidentItem[];
  /** The fixed capsule frontier that was rendered for this packet. */
  capsules: readonly StoredCapsule[];
  /** Immutable archive head observed while compiling this receipt. */
  asOfSeq?: Seq;
}

/**
 * Build a bounded receipt.  Sequence runs are intentionally arithmetic: a
 * million-turn archive must not be walked merely to compile a packet.  The
 * verifier below is the place that expands the receipt and checks every byte.
 */
export function buildReachability(
  vault: Vault,
  threadId: string,
  options: ReachabilityBuildOptions,
): ReachabilitySpan[] {
  const thread = vault.threads.get(threadId);
  if (thread === null) return [];
  const asOfSeq = options.asOfSeq ?? thread.headSeq;
  if (!Number.isInteger(asOfSeq) || asOfSeq < 0 || asOfSeq > thread.headSeq) return [];

  // This public kernel boundary must not silently discard an oversized caller
  // projection.  The compiler normally stays far below the cap; a direct
  // caller receives a fail-closed error instead of an unreceipted subset.
  let residentBytes: number;
  try {
    residentBytes = encoder.encode(JSON.stringify(options.resident)).byteLength;
  } catch {
    throw new VaultError("reachability resident projection is not JSON-serializable");
  }
  if (residentBytes > MAX_PACKET_JSON_BYTES) {
    throw new VaultError(`reachability resident projection exceeds ${MAX_PACKET_JSON_BYTES} JSON bytes`);
  }

  const residentSeqs = new Set<Seq>();
  for (const item of options.resident) {
    if ((item.type === "recent" || item.type === "query") && item.seq !== undefined) {
      residentSeqs.add(item.seq);
    }
  }

  const capsules = [...options.capsules].sort((a, b) => {
    if (a.fromSeq !== b.fromSeq) return a.fromSeq - b.fromSeq;
    return a.toSeq - b.toSeq;
  });
  const spans: ReachabilitySpan[] = [];

  // The only episode bodies read during compilation are the explicit resident
  // witnesses.  Historical/pageable material is represented by arithmetic
  // ranges below.
  for (const seq of [...residentSeqs].sort((a, b) => a - b)) {
    if (seq < 1 || seq > asOfSeq) continue;
    const episode = vault.episodes.get(threadId, seq);
    if (episode === null || episode.meta.removed === true) continue;
    const bytes = encoder.encode(episode.content);
    if (bytes.byteLength === 0) continue;
    spans.push({
      kind: "episode",
      source: `episode:${seq}`,
      from: 0,
      to: bytes.byteLength,
      hash: sha256(bytes),
      state: "resident",
    });
  }

  // Describe all non-resident sequence runs without touching their contents.
  // A capsule id is part of the state, so adjacent capsule ranges from
  // different capsules remain separate receipts.
  let runFrom: Seq | null = null;
  let runTo: Seq | null = null;
  let runState: "capsule" | "pageable" | null = null;
  let runCapsuleId: string | undefined;
  const flush = (): void => {
    if (runFrom === null || runTo === null || runState === null) return;
    const row: EpisodeRangeReachabilitySpan = {
      kind: "episode-range",
      fromSeq: runFrom,
      toSeq: runTo,
      state: runState,
      ...(runState === "pageable" ? { locatorTemplate: "episode:{seq}" as const } : {}),
      ...(runCapsuleId === undefined ? {} : { capsuleId: runCapsuleId }),
      digest: canonicalHash({
        threadId,
        fromSeq: runFrom,
        toSeq: runTo,
        state: runState,
        capsuleId: runCapsuleId,
        asOfSeq,
      }),
    };
    spans.push(row);
    runFrom = null;
    runTo = null;
    runState = null;
    runCapsuleId = undefined;
  };

  // Partition only at resident points and capsule boundaries.  This is the
  // important scale property: the receipt has one row for a million-turn
  // pageable run, not one row (or one database read) per turn.
  const cuts = new Set<number>([1, asOfSeq + 1]);
  for (const seq of residentSeqs) {
    if (seq >= 1 && seq <= asOfSeq) {
      cuts.add(seq);
      cuts.add(seq + 1);
    }
  }
  for (const capsule of capsules) {
    const from = Math.max(1, capsule.fromSeq);
    const to = Math.min(asOfSeq, capsule.toSeq);
    if (from <= to) {
      cuts.add(from);
      cuts.add(to + 1);
    }
  }
  const boundaries = [...cuts].sort((a, b) => a - b);
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const from = boundaries[index] as number;
    const to = (boundaries[index + 1] as number) - 1;
    if (from > to || residentSeqs.has(from)) {
      flush();
      continue;
    }
    const capsule = capsules.find((candidate) => candidate.fromSeq <= from && from <= candidate.toSeq);
    const state: "capsule" | "pageable" = capsule === undefined ? "pageable" : "capsule";
    const capsuleId = capsule?.id;
    const adjacent = runTo !== null && runTo + 1 === from && runState === state && runCapsuleId === capsuleId;
    if (!adjacent) {
      flush();
      runFrom = from;
      runTo = to;
      runState = state;
      runCapsuleId = capsuleId;
    } else {
      runTo = to;
    }
  }
  flush();

  // Attachment manifests are independent byte address spaces.  The common
  // compile path does not enumerate every attachment row (which would turn a
  // million-turn archive into a million-row receipt).  One bounded sequence
  // locator names the manifest set; the verifier expands it at check time.
  const attachmentBoundarySql =
    "SELECT seq FROM episode INDEXED BY episode_active_attachment_seq " +
    "WHERE thread_id = ? AND role = 'attachment' AND seq <= ? " +
    "AND COALESCE(json_extract(meta, '$.removed'), 0) != 1 ORDER BY seq ";
  const firstAttachment = vault.db.query(`${attachmentBoundarySql}ASC LIMIT 1`).get(threadId, asOfSeq) as {
    seq: number;
  } | null;
  const lastAttachment =
    firstAttachment === null
      ? null
      : (vault.db.query(`${attachmentBoundarySql}DESC LIMIT 1`).get(threadId, asOfSeq) as {
          seq: number;
        } | null);
  if (firstAttachment !== null && lastAttachment !== null) {
    const range: AttachmentRangeReachabilitySpan = {
      kind: "attachment-range" as const,
      version: 2,
      fromSeq: firstAttachment.seq,
      toSeq: lastAttachment.seq,
      state: "pageable" as const,
      locatorTemplate: "attachment:{seq}" as const,
      digest: canonicalHash({
        version: 2,
        threadId,
        fromSeq: firstAttachment.seq,
        toSeq: lastAttachment.seq,
        asOfSeq,
      }),
    };
    spans.push(range);
  }

  let receiptBytes: number;
  try {
    receiptBytes = encoder.encode(JSON.stringify(spans)).byteLength;
  } catch {
    throw new VaultError("reachability receipt is not JSON-serializable");
  }
  if (receiptBytes > MAX_PACKET_JSON_BYTES) {
    throw new VaultError(`reachability receipt exceeds ${MAX_PACKET_JSON_BYTES} JSON bytes`);
  }

  return spans;
}

function asManifest(value: unknown): AttachmentManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<AttachmentManifest>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.hash !== "string" ||
    typeof candidate.digest !== "string" ||
    typeof candidate.size !== "number" ||
    !Array.isArray(candidate.spans)
  ) {
    return null;
  }
  return candidate as AttachmentManifest;
}

/** Render the minimum packet-visible receipt for non-resident bytes. */
export function reachabilityNotice(spans: readonly ReachabilitySpan[], limit = 24): string {
  const entries: string[] = [];
  for (const span of spans) {
    if (span.state === "resident" || span.state === "capsule") continue;
    if (isAttachmentRange(span)) {
      const attachment = span;
      entries.push(
        attachment.fromSeq === attachment.toSeq
          ? `attachment #${attachment.fromSeq}`
          : `attachments #${attachment.fromSeq}–#${attachment.toSeq}`,
      );
    } else if (span.kind === "episode-range") {
      entries.push(span.fromSeq === span.toSeq ? `#${span.fromSeq}` : `#${span.fromSeq}–#${span.toSeq}`);
    } else if (span.kind === "attachment") {
      // The manifest carries the exact full hash.  The visible line only needs
      // a bounded locator cue; printing sixteen 64-byte chunk hashes would
      // crowd the actual recovered tail out of a small packet.
      entries.push(`blob:${span.source.slice(5, 17)}…`);
    } else {
      const seq = span.source.startsWith("episode:") ? span.source.slice("episode:".length) : span.source;
      entries.push(`#${seq}`);
    }
    if (entries.length >= limit) break;
  }
  if (entries.length === 0) return "";
  const remaining =
    spans.filter((span) => span.state !== "resident" && span.state !== "capsule").length - entries.length;
  return `⟨recoverable · pageable/opaque receipts: ${entries.join(", ")}${remaining > 0 ? ` · +${remaining} more` : ""}⟩`;
}

export interface ReachabilityVerification {
  ok: boolean;
  /** `invalidated` means the receipt was historically valid but a later,
   * chain-bound forget removed one of its witnessed sources. */
  status?: "current" | "invalidated";
  reason?: string;
}

export interface ReachabilityReplay {
  verify(packet: unknown): ReachabilityVerification;
}

class StoredReachabilityReplay {
  readonly archiveFailure: string | undefined;

  constructor(
    private readonly vault: Vault,
    private readonly threadId: string,
  ) {
    const thread = vault.threads.get(threadId);
    const headSeq = thread?.headSeq ?? 0;
    let failure: string | undefined;
    let previousSeq = 0;
    const query = vault.db.query(
      "SELECT seq, role, length(CAST(content AS BLOB)) AS content_bytes, meta, content_hash " +
        "FROM episode WHERE thread_id = ? ORDER BY seq ASC",
    );
    try {
      for (const row of query.iterate(threadId) as Iterable<{
        seq: number;
        role: string;
        content_bytes: number;
        meta: string;
        content_hash: string;
      }>) {
        if (
          !Number.isSafeInteger(row.seq) ||
          row.seq !== previousSeq + 1 ||
          row.seq > headSeq ||
          !Number.isSafeInteger(row.content_bytes) ||
          row.content_bytes < 0 ||
          !/^[0-9a-f]{64}$/u.test(row.content_hash) ||
          !["user", "assistant", "tool", "system", "attachment", "handoff"].includes(row.role)
        ) {
          failure = "malformed episode metadata replay";
          break;
        }
        previousSeq = row.seq;
        let meta: unknown;
        try {
          meta = JSON.parse(row.meta) as unknown;
        } catch {
          failure = `episode ${row.seq} metadata is malformed`;
          break;
        }
        if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
          failure = `episode ${row.seq} metadata is malformed`;
          break;
        }
        const episodeMeta = meta as EpisodeMeta;
        if (episodeMeta.removed === true) {
          const closure = verifyRemovedEpisode(vault, threadId, { seq: row.seq, meta: episodeMeta });
          if (closure.error !== undefined) {
            failure = closure.error;
            break;
          }
        }

        if (row.role !== "attachment") continue;
        const blob = typeof episodeMeta.blob === "string" ? episodeMeta.blob : undefined;
        if (blob === undefined || !/^[0-9a-f]{64}$/u.test(blob)) {
          failure = `attachment ${row.seq} has no whole-object hash`;
          break;
        }
        const manifest = asManifest(episodeMeta.manifest);
        const expectedSize = manifest?.size ?? episodeMeta.size ?? 0;
        const expected = manifestSpansForEpisode({ meta: episodeMeta }, blob, expectedSize);
        if (episodeMeta.removed === true) {
          if (manifest === null || manifest.hash !== blob || !manifestPartitionValid(manifest)) {
            failure = `invalid historical attachment manifest ${row.seq}`;
            break;
          }
        } else {
          const attachmentError = verifyAttachmentObjectsStreaming(
            vault,
            threadId,
            row.seq,
            [],
            expected,
            blob,
            true,
          );
          if (attachmentError !== undefined) {
            failure = attachmentError;
            break;
          }
        }
      }
    } finally {
      query.finalize();
    }
    if (failure === undefined && previousSeq !== headSeq)
      failure = "episode metadata replay does not reach head";
    this.archiveFailure = failure;
  }

  hasRequiredEpisode(fromSeq: Seq, toSeq: Seq, snapshotSeq: Seq): boolean {
    if (fromSeq > toSeq) return false;
    const query = this.vault.db.query(
      "SELECT seq, meta, content_hash, length(CAST(content AS BLOB)) AS content_bytes FROM episode " +
        "WHERE thread_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC",
    );
    try {
      for (const row of query.iterate(this.threadId, fromSeq, toSeq) as Iterable<{
        seq: number;
        meta: string;
        content_hash: string;
        content_bytes: number;
      }>) {
        let meta: EpisodeMeta;
        try {
          meta = JSON.parse(row.meta) as EpisodeMeta;
        } catch {
          return true;
        }
        if (meta.removed !== true) {
          if (row.content_bytes > 0) return true;
          continue;
        }
        const closure = verifyRemovedEpisode(this.vault, this.threadId, { seq: row.seq, meta });
        if (
          closure.error !== undefined ||
          (closure.removalSeq > snapshotSeq && closure.contentHash !== sha256(""))
        ) {
          return true;
        }
      }
      return false;
    } finally {
      query.finalize();
    }
  }

  removed(seq: Seq): RemovedEpisodeClosure | undefined {
    const episode = this.vault.episodes.get(this.threadId, seq);
    if (episode === null || episode.meta.removed !== true) return undefined;
    return verifyRemovedEpisode(this.vault, this.threadId, episode);
  }

  verifyAttachments(
    snapshotSeq: Seq,
    ranges: readonly AttachmentRangeReachabilitySpan[],
    explicit: ReadonlyMap<string, readonly ExplicitReachabilitySpan[]>,
  ): string | undefined {
    if (ranges.length > 1) return "stored packet has multiple attachment envelopes";
    const range = ranges[0];
    if (range !== undefined) {
      if (explicit.size > 0) return "attachment source is double covered";
      const first = this.activeAttachmentBoundary(snapshotSeq, "ASC");
      const last = this.activeAttachmentBoundary(snapshotSeq, "DESC");
      if (first === null || last === null) return "attachment range covers no active manifest";
      if (range.fromSeq !== first || range.toSeq !== last) return "attachment range envelope mismatch";
      let count = 0;
      if (range.version !== 2) count = this.activeAttachmentCount(snapshotSeq);
      const digest =
        range.version === 2
          ? canonicalHash({
              version: 2,
              threadId: this.threadId,
              fromSeq: range.fromSeq,
              toSeq: range.toSeq,
              asOfSeq: snapshotSeq,
            })
          : canonicalHash({
              threadId: this.threadId,
              fromSeq: range.fromSeq,
              toSeq: range.toSeq,
              count,
              asOfSeq: snapshotSeq,
            });
      return digest === range.digest ? undefined : "attachment range digest mismatch";
    }
    if (explicit.size === 0) {
      return this.activeAttachmentBoundary(snapshotSeq, "ASC") === null
        ? undefined
        : "attachment manifest is not covered";
    }

    const unseen = new Set(explicit.keys());
    const query = this.vault.db.query(
      "SELECT seq, meta FROM episode WHERE thread_id = ? AND role = 'attachment' AND seq <= ? ORDER BY seq ASC",
    );
    try {
      for (const row of query.iterate(this.threadId, snapshotSeq) as Iterable<{
        seq: number;
        meta: string;
      }>) {
        const meta = JSON.parse(row.meta) as EpisodeMeta;
        if (!this.attachmentActiveAtSnapshot(row.seq, meta, snapshotSeq)) continue;
        const blob = typeof meta.blob === "string" ? meta.blob : "";
        const source = `blob:${blob}`;
        const rows = explicit.get(source);
        if (rows === undefined) return "attachment manifest is not covered";
        if (!unseen.delete(source)) continue;
        const manifest = asManifest(meta.manifest);
        const expected = manifestSpansForEpisode({ meta }, blob, manifest?.size ?? meta.size ?? 0);
        const witnessError = verifyAttachmentWitnessPartition(rows, expected, blob);
        if (witnessError !== undefined) return witnessError;
      }
    } finally {
      query.finalize();
    }
    const missing = unseen.values().next().value as string | undefined;
    return missing === undefined ? undefined : `unknown attachment ${missing.slice("blob:".length)}`;
  }

  private activeAttachmentBoundary(snapshotSeq: Seq, direction: "ASC" | "DESC"): Seq | null {
    const current = this.vault.db
      .query(
        `SELECT seq FROM episode INDEXED BY episode_active_attachment_seq ` +
          `WHERE thread_id = ? AND role = 'attachment' AND seq <= ? ` +
          `AND COALESCE(json_extract(meta, '$.removed'), 0) != 1 ORDER BY seq ${direction} LIMIT 1`,
      )
      .get(this.threadId, snapshotSeq) as { seq: number } | null;
    const historical = this.vault.db
      .query(
        `SELECT e.seq FROM tombstone t JOIN episode e ON e.thread_id = t.thread_id ` +
          `AND json_extract(e.meta, '$.tombstone') = t.id ` +
          `WHERE t.thread_id = ? AND t.removal_seq > ? AND e.role = 'attachment' AND e.seq <= ? ` +
          `AND json_extract(e.meta, '$.removed') = 1 ORDER BY e.seq ${direction} LIMIT 1`,
      )
      .get(this.threadId, snapshotSeq, snapshotSeq) as { seq: number } | null;
    if (current === null) return historical?.seq ?? null;
    if (historical === null) return current.seq;
    return direction === "ASC"
      ? Math.min(current.seq, historical.seq)
      : Math.max(current.seq, historical.seq);
  }

  private activeAttachmentCount(snapshotSeq: Seq): number {
    let count = 0;
    const query = this.vault.db.query(
      "SELECT seq, meta FROM episode WHERE thread_id = ? AND role = 'attachment' AND seq <= ? ORDER BY seq ASC",
    );
    try {
      for (const row of query.iterate(this.threadId, snapshotSeq) as Iterable<{
        seq: number;
        meta: string;
      }>) {
        const meta = JSON.parse(row.meta) as EpisodeMeta;
        if (this.attachmentActiveAtSnapshot(row.seq, meta, snapshotSeq)) count += 1;
      }
      return count;
    } finally {
      query.finalize();
    }
  }

  private attachmentActiveAtSnapshot(seq: Seq, meta: EpisodeMeta, snapshotSeq: Seq): boolean {
    if (meta.removed !== true) return true;
    const closure = verifyRemovedEpisode(this.vault, this.threadId, { seq, meta });
    return closure.error === undefined && closure.removalSeq > snapshotSeq;
  }
}

/**
 * Build one archive replay shared by every retained packet verification. The
 * archive metadata is visited once; individual numeric receipts are then
 * checked arithmetically while explicit byte witnesses stay exact.
 */
export function createReachabilityReplay(vault: Vault, threadId: string): ReachabilityReplay {
  const replay = new StoredReachabilityReplay(vault, threadId);
  return {
    verify: (packet) => verifyReachabilityInternal(vault, threadId, packet, replay),
  };
}

interface ReachabilityEpisodeMetadata {
  seq: Seq;
  role: Episode["role"];
  contentBytes: number;
  meta: EpisodeMeta;
}

/**
 * Read only scalar episode metadata while expanding a range. Reachability is
 * allowed to be O(archive) at check time, but it must not allocate the full
 * transcript for every row: only explicit resident spans and attachments are
 * hydrated below. A 512-row scalar page keeps SQL work bounded without
 * changing the verifier's exact enumeration semantics.
 */
function reachabilityEpisodeMetadata(
  vault: Vault,
  threadId: string,
  from: Seq,
  to: Seq,
): { rows: ReachabilityEpisodeMetadata[]; error?: string } {
  const raw = vault.db
    .query(
      "SELECT seq, role, length(CAST(content AS BLOB)) AS content_bytes, meta " +
        "FROM episode WHERE thread_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC",
    )
    .all(threadId, from, to) as Array<{
    seq: number;
    role: string;
    content_bytes: number;
    meta: string;
  }>;
  const rows: ReachabilityEpisodeMetadata[] = [];
  for (const row of raw) {
    if (
      !Number.isSafeInteger(row.seq) ||
      row.seq < from ||
      row.seq > to ||
      !Number.isSafeInteger(row.content_bytes) ||
      row.content_bytes < 0 ||
      !["user", "assistant", "tool", "system", "attachment", "handoff"].includes(row.role)
    ) {
      return { rows: [], error: "malformed episode metadata" };
    }
    let meta: unknown;
    try {
      meta = JSON.parse(row.meta) as unknown;
    } catch {
      return { rows: [], error: `episode ${row.seq} metadata is malformed` };
    }
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
      return { rows: [], error: `episode ${row.seq} metadata is malformed` };
    }
    rows.push({
      seq: row.seq,
      role: row.role as Episode["role"],
      contentBytes: row.content_bytes,
      meta: meta as EpisodeMeta,
    });
  }
  return { rows };
}

/**
 * Expand and independently verify a packet receipt.  This is intentionally a
 * check-time O(archive) operation; compile-time remains bounded by the packet
 * frontier and attachment manifest rows.
 */
export function verifyReachability(
  vault: Vault,
  threadId: string,
  packet: unknown,
): ReachabilityVerification {
  return verifyReachabilityInternal(vault, threadId, packet);
}

function verifyReachabilityInternal(
  vault: Vault,
  threadId: string,
  packet: unknown,
  replay?: StoredReachabilityReplay,
): ReachabilityVerification {
  if (typeof packet !== "object" || packet === null) return { ok: false, reason: "packet is not an object" };
  const packetRecord = packet as {
    turnSeq?: unknown;
    reachability?: unknown;
    reachabilityAsOfSeq?: unknown;
    resident?: unknown;
  };
  const raw = packetRecord.reachability;
  if (!Array.isArray(raw)) return { ok: false, reason: "reachability receipt is missing" };
  const spans = raw as ReachabilitySpan[];
  const thread = vault.threads.get(threadId);
  if (thread === null) return { ok: false, reason: "unknown thread" };
  const asOfSeq = packetRecord.reachabilityAsOfSeq;
  if (!Number.isInteger(asOfSeq) || (asOfSeq as number) < 0 || (asOfSeq as number) > thread.headSeq) {
    return { ok: false, reason: "invalid reachability snapshot bound" };
  }
  const turnSeq = packetRecord.turnSeq;
  if (turnSeq !== undefined) {
    if (!Number.isSafeInteger(turnSeq) || (turnSeq as number) <= 0) {
      return { ok: false, reason: "invalid reachability turn binding" };
    }
    const hasQueryResident =
      Array.isArray(packetRecord.resident) &&
      packetRecord.resident.some((item) => {
        if (typeof item !== "object" || item === null) return false;
        const resident = item as { type?: unknown; seq?: unknown };
        return resident.type === "query" && resident.seq === turnSeq;
      });
    const expectedSnapshot = hasQueryResident ? (turnSeq as number) : (turnSeq as number) - 1;
    if ((turnSeq as number) > thread.headSeq + 1 || asOfSeq !== expectedSnapshot) {
      return { ok: false, reason: "reachability snapshot is not bound to packet turn" };
    }
  }
  const snapshotSeq = asOfSeq as Seq;

  // A capsule range is a claim about the capsule that was actually resident
  // in this packet.  A DB row with the same id is not enough: an old or tampered
  // capsule must never silently stand in for the packet's loss-bearing view.
  const residentCapsules = new Set<string>();
  if (Array.isArray(packetRecord.resident)) {
    for (const item of packetRecord.resident) {
      if (
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "capsule" &&
        typeof (item as { ref?: unknown }).ref === "string"
      ) {
        residentCapsules.add((item as { ref: string }).ref);
      }
    }
  }

  const episodeExplicit = new Map<Seq, ExplicitReachabilitySpan[]>();
  const episodeRanges: EpisodeRangeReachabilitySpan[] = [];
  const attachmentRanges: AttachmentRangeReachabilitySpan[] = [];
  const attachmentExplicit = new Map<string, ExplicitReachabilitySpan[]>();
  for (const span of spans) {
    if (isAttachmentRange(span)) {
      const range = span;
      if (!validAttachmentRange(range, snapshotSeq)) {
        return { ok: false, reason: "invalid attachment range" };
      }
      attachmentRanges.push(range);
      continue;
    }
    if (span.kind === "episode-range") {
      if (!validRange(span, snapshotSeq)) return { ok: false, reason: "invalid episode range" };
      if (
        span.digest !== undefined &&
        span.digest !==
          canonicalHash({
            threadId,
            fromSeq: span.fromSeq,
            toSeq: span.toSeq,
            state: span.state,
            capsuleId: span.capsuleId,
            asOfSeq: snapshotSeq,
          })
      ) {
        return { ok: false, reason: "episode range digest mismatch" };
      }
      if (span.state === "capsule") {
        if (span.capsuleId === undefined) return { ok: false, reason: "capsule range has no capsule" };
        if (!residentCapsules.has(span.capsuleId)) {
          return { ok: false, reason: "capsule range is not resident in packet" };
        }
        const capsule = vault.capsules.get(span.capsuleId);
        if (
          capsule === null ||
          capsule.threadId !== threadId ||
          capsule.fromSeq > span.fromSeq ||
          capsule.toSeq < span.toSeq
        ) {
          return { ok: false, reason: "capsule range is not backed by its capsule" };
        }
        const capsuleError = verifyResidentCapsule(vault, threadId, capsule);
        if (capsuleError !== undefined) return { ok: false, reason: capsuleError };
      }
      episodeRanges.push(span);
      continue;
    }
    if (!validExplicit(span)) return { ok: false, reason: "invalid explicit span" };
    if (span.state === "capsule") {
      if (span.capsuleId === undefined) return { ok: false, reason: "capsule span has no capsule" };
      if (!residentCapsules.has(span.capsuleId)) {
        return { ok: false, reason: "capsule span is not resident in packet" };
      }
      const capsule = vault.capsules.get(span.capsuleId);
      if (capsule === null || capsule.threadId !== threadId) {
        return { ok: false, reason: "capsule span is not backed by its capsule" };
      }
      const capsuleError = verifyResidentCapsule(vault, threadId, capsule);
      if (capsuleError !== undefined) return { ok: false, reason: capsuleError };
    }
    if (span.source.startsWith("episode:")) {
      const seq = Number(span.source.slice("episode:".length));
      if (!Number.isInteger(seq) || seq <= 0) return { ok: false, reason: "invalid episode source" };
      const rows = episodeExplicit.get(seq) ?? [];
      rows.push(span);
      episodeExplicit.set(seq, rows);
      if (span.state === "capsule" && span.capsuleId !== undefined) {
        const capsule = vault.capsules.get(span.capsuleId);
        if (capsule === null || seq < capsule.fromSeq || seq > capsule.toSeq) {
          return { ok: false, reason: "capsule span is outside its capsule" };
        }
      }
    } else if (span.source.startsWith("blob:")) {
      const rows = attachmentExplicit.get(span.source) ?? [];
      rows.push(span);
      attachmentExplicit.set(span.source, rows);
    } else {
      return { ok: false, reason: "unknown reachability source" };
    }
  }

  const sortedEpisodeRanges = [...episodeRanges].sort((a, b) => a.fromSeq - b.fromSeq);
  if (hasOverlappingRanges(sortedEpisodeRanges)) {
    return { ok: false, reason: "overlapping episode ranges" };
  }
  const sortedAttachmentRanges = [...attachmentRanges].sort((a, b) => a.fromSeq - b.fromSeq);
  if (hasOverlappingAttachmentRanges(sortedAttachmentRanges)) {
    return { ok: false, reason: "overlapping attachment ranges" };
  }
  if (replay !== undefined) {
    return verifyReachabilityFromReplay(
      vault,
      threadId,
      snapshotSeq,
      replay,
      episodeExplicit,
      sortedEpisodeRanges,
      sortedAttachmentRanges,
      attachmentExplicit,
    );
  }
  const attachmentRangeCounts = sortedAttachmentRanges.map(() => 0);
  let episodeRangeIndex = 0;
  let attachmentRangeIndex = 0;
  const explicitEpisodeSeqs = new Set(episodeExplicit.keys());
  // Imported metadata may itself approach the per-line bundle limit. Inspect
  // one scalar row at a time so 512 legal large metadata rows cannot become a
  // single half-gigabyte JS allocation.
  const batchSize = 1;

  let invalidated = false;
  for (let from = 1; from <= snapshotSeq; from += batchSize) {
    const metadata = reachabilityEpisodeMetadata(
      vault,
      threadId,
      from,
      Math.min(snapshotSeq, from + batchSize - 1),
    );
    if (metadata.error !== undefined) return { ok: false, reason: metadata.error };
    for (const row of metadata.rows) {
      const explicit = episodeExplicit.get(row.seq) ?? [];
      explicitEpisodeSeqs.delete(row.seq);
      const hydrated = explicit.length === 0 ? null : vault.episodes.get(threadId, row.seq);
      if (explicit.length > 0 && hydrated === null) {
        return { ok: false, reason: `unknown episode ${row.seq}` };
      }
      // Range validation needs only the scalar byte length. Use a one-byte
      // placeholder for a non-empty non-explicit row so the existing closure
      // checks retain their exact empty/non-empty distinction without reading
      // the archive body.
      const episode: Pick<Episode, "seq" | "role" | "meta" | "content"> = hydrated ?? {
        seq: row.seq,
        role: row.role,
        meta: row.meta,
        content: row.contentBytes > 0 ? "\u0000" : "",
      };
      const bytes = hydrated === null ? null : encoder.encode(hydrated.content);
      const contentBytes = bytes?.byteLength ?? row.contentBytes;
      while (
        episodeRangeIndex < sortedEpisodeRanges.length &&
        row.seq > (sortedEpisodeRanges[episodeRangeIndex] as EpisodeRangeReachabilitySpan).toSeq
      ) {
        episodeRangeIndex += 1;
      }
      const range = sortedEpisodeRanges[episodeRangeIndex];
      const episodeRange = range !== undefined && range.fromSeq <= row.seq ? range : undefined;
      if (episode.meta.removed === true) {
        const closure = verifyRemovedEpisode(vault, threadId, episode);
        if (closure.error !== undefined) return { ok: false, reason: closure.error };
        const removedAtSnapshot = closure.removalSeq <= snapshotSeq;
        if (removedAtSnapshot) {
          // A packet compiled after forget must omit this source entirely. A
          // numeric episode range may straddle a valid tombstoned hole; the
          // row itself has no closure state, while an explicit span would
          // claim bytes the user has already authorized us to destroy.
          if (explicit.length > 0) {
            return { ok: false, reason: `removed episode ${episode.seq} is covered after forget` };
          }
          if (episode.role === "attachment") {
            const blob = typeof episode.meta.blob === "string" ? episode.meta.blob : undefined;
            const explicitAttachment =
              blob !== undefined && (attachmentExplicit.get(`blob:${blob}`)?.length ?? 0) > 0;
            // An attachment-range is an envelope over surviving attachment
            // rows, not a claim that every sequence in [fromSeq,toSeq] is an
            // attachment. A current range may numerically straddle a source
            // removed before this packet's snapshot; only explicit bytes
            // would be an invalid post-forget claim.
            if (explicitAttachment) {
              return { ok: false, reason: `removed attachment ${episode.seq} is covered after forget` };
            }
          }
          continue;
        }
        invalidated = true;
        if (explicit.length > 0) {
          const error = verifyRemovedExplicit(explicit, episode.seq, closure.contentHash);
          if (error !== undefined) return { ok: false, reason: error };
        } else if (episodeRange === undefined) {
          return { ok: false, reason: `removed episode ${episode.seq} is not covered` };
        }
        // The source bytes are intentionally gone.  A tombstone can authorize
        // historical validation, but it cannot turn the placeholder back into
        // a current resident/pageable witness.
        if (episode.role === "attachment") {
          const blob = typeof episode.meta.blob === "string" ? episode.meta.blob : undefined;
          if (blob === undefined) {
            return { ok: false, reason: `removed attachment ${episode.seq} has no historical object hash` };
          }
          while (
            attachmentRangeIndex < sortedAttachmentRanges.length &&
            episode.seq >
              (sortedAttachmentRanges[attachmentRangeIndex] as AttachmentRangeReachabilitySpan).toSeq
          ) {
            attachmentRangeIndex += 1;
          }
          const attachmentRange = sortedAttachmentRanges[attachmentRangeIndex];
          const rangeIndex =
            attachmentRange !== undefined && attachmentRange.fromSeq <= episode.seq
              ? attachmentRangeIndex
              : -1;
          const ranged = rangeIndex >= 0;
          if (ranged) attachmentRangeCounts[rangeIndex] = (attachmentRangeCounts[rangeIndex] as number) + 1;
          const rows = attachmentExplicit.get(`blob:${blob}`) ?? [];
          const explicitAttachment = rows.length > 0;
          if (ranged === explicitAttachment) {
            return {
              ok: false,
              reason: ranged
                ? `attachment ${episode.seq} is double covered`
                : `removed attachment ${episode.seq} is not covered`,
            };
          }
          const manifest = asManifest(episode.meta.manifest);
          if (manifest === null || manifest.hash !== blob || !manifestPartitionValid(manifest)) {
            return { ok: false, reason: `invalid historical attachment manifest ${episode.seq}` };
          }
          if (explicitAttachment) {
            const error = verifyRemovedAttachmentWitnesses(rows, manifest, blob);
            if (error !== undefined) return { ok: false, reason: error };
          }
        }
        continue;
      }
      if (contentBytes > 0) {
        if (explicit.length > 0 && episodeRange !== undefined) {
          return { ok: false, reason: `episode ${episode.seq} is double covered` };
        }
        if (explicit.length > 0) {
          if (bytes === null) return { ok: false, reason: `episode ${episode.seq} content is unavailable` };
          const error = verifyPartition(explicit, bytes, `episode:${episode.seq}`);
          if (error !== undefined) return { ok: false, reason: error };
        } else if (episodeRange === undefined) {
          return { ok: false, reason: `episode ${episode.seq} is not covered` };
        } else if (episodeRange.state === "pageable" && episodeRange.locatorTemplate !== "episode:{seq}") {
          return { ok: false, reason: `episode ${episode.seq} has no pageable locator` };
        }
      }

      if (episode.role !== "attachment") continue;
      const blob = typeof episode.meta.blob === "string" ? episode.meta.blob : undefined;
      if (blob === undefined)
        return { ok: false, reason: `attachment ${episode.seq} has no whole-object hash` };
      while (
        attachmentRangeIndex < sortedAttachmentRanges.length &&
        episode.seq > (sortedAttachmentRanges[attachmentRangeIndex] as AttachmentRangeReachabilitySpan).toSeq
      ) {
        attachmentRangeIndex += 1;
      }
      const attachmentRange = sortedAttachmentRanges[attachmentRangeIndex];
      const rangeIndex =
        attachmentRange !== undefined && attachmentRange.fromSeq <= episode.seq ? attachmentRangeIndex : -1;
      const ranged = rangeIndex >= 0;
      if (ranged) attachmentRangeCounts[rangeIndex] = (attachmentRangeCounts[rangeIndex] as number) + 1;
      const rows = attachmentExplicit.get(`blob:${blob}`) ?? [];
      const explicitAttachment = rows.length > 0;
      if (ranged === explicitAttachment) {
        return {
          ok: false,
          reason: ranged
            ? `attachment ${episode.seq} is double covered`
            : `attachment ${episode.seq} is not covered`,
        };
      }
      const expectedSize = asManifest(episode.meta.manifest)?.size ?? episode.meta.size ?? 0;
      const expected = manifestSpansForEpisode(episode, blob, expectedSize);
      const error = verifyAttachmentObjectsStreaming(
        vault,
        threadId,
        episode.seq,
        rows,
        expected,
        blob,
        ranged,
      );
      if (error !== undefined) return { ok: false, reason: error };
    }
  }

  if (explicitEpisodeSeqs.size > 0) {
    return { ok: false, reason: `unknown episode ${[...explicitEpisodeSeqs][0] as number}` };
  }
  for (let index = 0; index < sortedAttachmentRanges.length; index += 1) {
    const range = sortedAttachmentRanges[index] as AttachmentRangeReachabilitySpan;
    const count = attachmentRangeCounts[index] as number;
    if (count === 0) return { ok: false, reason: "attachment range covers no active manifest" };
    const digest =
      range.version === 2
        ? canonicalHash({
            version: 2,
            threadId,
            fromSeq: range.fromSeq,
            toSeq: range.toSeq,
            asOfSeq: snapshotSeq,
          })
        : canonicalHash({
            threadId,
            fromSeq: range.fromSeq,
            toSeq: range.toSeq,
            count,
            asOfSeq: snapshotSeq,
          });
    if (digest !== range.digest) return { ok: false, reason: "attachment range digest mismatch" };
  }
  for (const source of attachmentExplicit.keys()) {
    const blob = source.slice("blob:".length);
    if (!attachmentSourceKnownAtSnapshot(vault, threadId, blob, snapshotSeq)) {
      return { ok: false, reason: `unknown attachment ${blob}` };
    }
  }

  return invalidated
    ? {
        ok: true,
        status: "invalidated",
        reason: "historical receipt remains valid; a later authorized forget removed source bytes",
      }
    : { ok: true, status: "current" };
}

function verifyReachabilityFromReplay(
  vault: Vault,
  threadId: string,
  snapshotSeq: Seq,
  replay: StoredReachabilityReplay,
  episodeExplicit: ReadonlyMap<Seq, readonly ExplicitReachabilitySpan[]>,
  episodeRanges: readonly EpisodeRangeReachabilitySpan[],
  attachmentRanges: readonly AttachmentRangeReachabilitySpan[],
  attachmentExplicit: ReadonlyMap<string, readonly ExplicitReachabilitySpan[]>,
): ReachabilityVerification {
  if (replay.archiveFailure !== undefined) return { ok: false, reason: replay.archiveFailure };
  const intervals: Array<{ from: Seq; to: Seq }> = episodeRanges.map((range) => ({
    from: range.fromSeq,
    to: range.toSeq,
  }));
  let invalidated = false;

  for (const [seq, rows] of episodeExplicit) {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > snapshotSeq) {
      return { ok: false, reason: `unknown episode ${seq}` };
    }
    if (episodeRanges.some((range) => range.fromSeq <= seq && seq <= range.toSeq)) {
      return { ok: false, reason: `episode ${seq} is double covered` };
    }
    const episode = vault.episodes.get(threadId, seq);
    if (episode === null) return { ok: false, reason: `unknown episode ${seq}` };
    const removed = replay.removed(seq);
    if (removed !== undefined) {
      if (removed.removalSeq <= snapshotSeq) {
        return { ok: false, reason: `removed episode ${seq} is covered after forget` };
      }
      const error = verifyRemovedExplicit(rows, seq, removed.contentHash);
      if (error !== undefined) return { ok: false, reason: error };
      invalidated = true;
    } else {
      const error = verifyPartition(rows, encoder.encode(episode.content), `episode:${seq}`);
      if (error !== undefined) return { ok: false, reason: error };
    }
    intervals.push({ from: seq, to: seq });
  }

  intervals.sort((left, right) => left.from - right.from || left.to - right.to);
  let cursor = 1;
  for (const interval of intervals) {
    if (interval.from < cursor) return { ok: false, reason: `episode ${interval.from} is double covered` };
    if (interval.from > cursor && replay.hasRequiredEpisode(cursor, interval.from - 1, snapshotSeq)) {
      return { ok: false, reason: `episode range ${cursor}-${interval.from - 1} is not covered` };
    }
    cursor = interval.to + 1;
  }
  if (cursor <= snapshotSeq && replay.hasRequiredEpisode(cursor, snapshotSeq, snapshotSeq)) {
    return { ok: false, reason: `episode range ${cursor}-${snapshotSeq} is not covered` };
  }

  const attachmentError = replay.verifyAttachments(snapshotSeq, attachmentRanges, attachmentExplicit);
  if (attachmentError !== undefined) return { ok: false, reason: attachmentError };
  return invalidated
    ? {
        ok: true,
        status: "invalidated",
        reason: "historical receipt remains valid; a later authorized forget removed source bytes",
      }
    : { ok: true };
}

function isAttachmentRange(span: ReachabilitySpan): span is AttachmentRangeReachabilitySpan {
  return span.kind === "attachment-range";
}

function hasOverlappingRanges(ranges: readonly EpisodeRangeReachabilitySpan[]): boolean {
  let previousTo = 0;
  for (const range of ranges) {
    if (range.fromSeq <= previousTo) return true;
    previousTo = range.toSeq;
  }
  return false;
}

function hasOverlappingAttachmentRanges(ranges: readonly AttachmentRangeReachabilitySpan[]): boolean {
  let previousTo = 0;
  for (const range of ranges) {
    if (range.fromSeq <= previousTo) return true;
    previousTo = range.toSeq;
  }
  return false;
}

/** Verify the resident capsule contract before allowing a range to stand in. */
function verifyResidentCapsule(vault: Vault, threadId: string, capsule: StoredCapsule): string | undefined {
  if (capsule.threadId !== threadId) return "capsule belongs to another thread";
  if (
    capsule.hash !==
    canonicalHash({ level: capsule.level, from: capsule.fromSeq, to: capsule.toSeq, text: capsule.text })
  ) {
    return `capsule ${capsule.id} hash mismatch`;
  }
  for (const entry of [...capsule.dropped, ...capsule.kept]) {
    if (
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      !Number.isInteger(entry.seq) ||
      entry.seq < capsule.fromSeq ||
      entry.seq > capsule.toSeq ||
      !["entity", "number", "quote", "atom", "date", "code"].includes(entry.kind)
    ) {
      return `capsule ${capsule.id} has an invalid locator`;
    }
    if (entry.span !== undefined) {
      if (
        !Array.isArray(entry.span) ||
        entry.span.length !== 2 ||
        !Number.isInteger(entry.span[0]) ||
        !Number.isInteger(entry.span[1]) ||
        (entry.span[0] as number) < 0 ||
        (entry.span[1] as number) < (entry.span[0] as number)
      ) {
        return `capsule ${capsule.id} has an invalid locator span`;
      }
    }
    if (vault.episodes.get(threadId, entry.seq) === null) {
      return `capsule ${capsule.id} points to a missing episode`;
    }
  }
  return undefined;
}

function validRange(span: EpisodeRangeReachabilitySpan, headSeq: Seq): boolean {
  return (
    Number.isInteger(span.fromSeq) &&
    Number.isInteger(span.toSeq) &&
    span.fromSeq >= 1 &&
    span.toSeq >= span.fromSeq &&
    span.toSeq <= headSeq &&
    (span.state === "capsule" || span.state === "pageable") &&
    (span.state !== "pageable" || span.locatorTemplate === "episode:{seq}")
  );
}

function validAttachmentRange(span: AttachmentRangeReachabilitySpan, headSeq: Seq): boolean {
  return (
    (span.version === undefined || span.version === 2) &&
    Number.isInteger(span.fromSeq) &&
    Number.isInteger(span.toSeq) &&
    span.fromSeq >= 1 &&
    span.toSeq >= span.fromSeq &&
    span.toSeq <= headSeq &&
    span.state === "pageable" &&
    span.locatorTemplate === "attachment:{seq}"
  );
}

interface RemovedEpisodeClosure {
  contentHash: string;
  removalSeq: Seq;
  error?: string;
}

/**
 * A removed row carries only its chain-covered content hash and tombstone
 * marker.  The removal event must be a later system episode in this same
 * thread; a hand-edited `removed` flag or a legacy unbound tombstone cannot
 * authorize a historical receipt.  The event may be newer than the packet's
 * snapshot: that is precisely the post-forget invalidation case.
 */
function verifyRemovedEpisode(
  vault: Vault,
  threadId: string,
  episode: Pick<Episode, "seq" | "meta">,
): RemovedEpisodeClosure {
  const tombstoneId = episode.meta.tombstone;
  if (typeof tombstoneId !== "string" || tombstoneId.length === 0) {
    return { contentHash: "", removalSeq: 0, error: `removed episode ${episode.seq} has no tombstone` };
  }
  const row = vault.db
    .query("SELECT content_hash FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, episode.seq) as { content_hash?: unknown } | undefined;
  if (row === undefined || typeof row.content_hash !== "string" || !/^[0-9a-f]{64}$/.test(row.content_hash)) {
    return { contentHash: "", removalSeq: 0, error: `removed episode ${episode.seq} has no historical hash` };
  }
  const tombstone = vault.db
    .query("SELECT removal_seq FROM tombstone WHERE id = ? AND thread_id = ?")
    .get(tombstoneId, threadId) as { removal_seq?: unknown } | undefined;
  const removalSeq = tombstone?.removal_seq;
  if (!Number.isInteger(removalSeq) || (removalSeq as number) <= episode.seq) {
    return {
      contentHash: row.content_hash,
      removalSeq: 0,
      error: `removed episode ${episode.seq} is not chain-bound`,
    };
  }
  const removal = vault.db
    .query("SELECT role, content FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, removalSeq as number) as { role?: unknown; content?: unknown } | undefined;
  if (
    removal?.role !== "system" ||
    typeof removal.content !== "string" ||
    !removalRecord(removal.content, tombstoneId).has(episode.seq)
  ) {
    return {
      contentHash: row.content_hash,
      removalSeq: removalSeq as number,
      error: `removed episode ${episode.seq} has no matching removal record`,
    };
  }
  return { contentHash: row.content_hash, removalSeq: removalSeq as number };
}

/** A resident episode span can survive forget only as a hash-bound historical
 * witness for the complete original byte string. */
function verifyRemovedExplicit(
  rows: readonly ExplicitReachabilitySpan[],
  seq: Seq,
  contentHash: string,
): string | undefined {
  if (rows.length !== 1) return `removed episode ${seq} has a partial historical span`;
  const row = rows[0] as ExplicitReachabilitySpan;
  if (row.source !== `episode:${seq}` || row.from !== 0 || row.to <= row.from || row.hash !== contentHash) {
    return `removed episode ${seq} historical span hash mismatch`;
  }
  return undefined;
}

/** Validate explicit attachment locators against the immutable manifest after
 * the object bytes have been deliberately deleted by forget. */
function verifyRemovedAttachmentWitnesses(
  rows: readonly ExplicitReachabilitySpan[],
  manifest: AttachmentManifest,
  blob: string,
): string | undefined {
  const expected = [...manifest.spans].sort((a, b) => a.from - b.from);
  const byRange = new Map(expected.map((span) => [`${span.from}:${span.to}`, span]));
  for (const row of rows) {
    if (row.source !== `blob:${blob}` || row.from < 0 || row.to <= row.from) {
      return `invalid historical attachment witness ${blob}`;
    }
    const expectedSpan = byRange.get(`${row.from}:${row.to}`);
    if (expectedSpan === undefined || row.hash !== expectedSpan.hash) {
      return `historical attachment witness hash mismatch ${blob}`;
    }
  }
  return undefined;
}

function verifyAttachmentWitnessPartition(
  rows: readonly ExplicitReachabilitySpan[],
  expected: readonly AttachmentSpan[],
  blob: string,
): string | undefined {
  const expectedRanges = [...expected].sort((left, right) => left.from - right.from);
  const witnesses = [...rows].sort((left, right) => left.from - right.from);
  if (expectedRanges.length === 0 || witnesses.length === 0) return `incomplete attachment ${blob}`;
  let cursor = 0;
  for (const witness of witnesses) {
    if (witness.source !== `blob:${blob}` || witness.from !== cursor || witness.to <= witness.from) {
      return `non-contiguous attachment ${blob}`;
    }
    const expectedRange = expectedRanges.find(
      (range) => range.from === witness.from && range.to === witness.to,
    );
    if (expectedRange === undefined || expectedRange.hash !== witness.hash) {
      return `hash mismatch in attachment ${blob}`;
    }
    cursor = witness.to;
  }
  const expectedTo = (expectedRanges.at(-1) as AttachmentSpan).to;
  return cursor === expectedTo ? undefined : `incomplete attachment ${blob}`;
}

function attachmentSourceKnownAtSnapshot(
  vault: Vault,
  threadId: string,
  blob: string,
  asOfSeq: Seq,
): boolean {
  // The common case is one live duplicate.  Let SQLite prove existence
  // without returning every same-hash row or hydrating any episode body.
  const active = vault.db
    .query(
      "SELECT 1 FROM episode WHERE thread_id = ? AND seq <= ? AND role = 'attachment' AND " +
        "CASE WHEN json_valid(meta) = 1 THEN json_extract(meta, '$.blob') ELSE NULL END = ? AND " +
        "CASE WHEN json_valid(meta) = 1 THEN COALESCE(json_extract(meta, '$.removed'), 0) ELSE 0 END != 1 " +
        "LIMIT 1",
    )
    .get(threadId, asOfSeq, blob);
  if (active !== null && active !== undefined) return true;

  // If all rows are tombstoned, walk them in sequence order one at a time and
  // stop at the first chain-valid historical closure.  This preserves the
  // pre-existing snapshot semantics while bounding retained row allocation.
  const removed = vault.db.query(
    "SELECT seq FROM episode WHERE thread_id = ? AND seq <= ? AND role = 'attachment' AND " +
      "CASE WHEN json_valid(meta) = 1 THEN json_extract(meta, '$.blob') ELSE NULL END = ? AND " +
      "CASE WHEN json_valid(meta) = 1 THEN COALESCE(json_extract(meta, '$.removed'), 0) ELSE 0 END = 1 AND " +
      "seq > ? ORDER BY seq ASC LIMIT 1",
  );
  let cursor = 0;
  for (;;) {
    const row = removed.get(threadId, asOfSeq, blob, cursor) as { seq: number } | null | undefined;
    if (row === null || row === undefined || !Number.isSafeInteger(row.seq) || row.seq <= cursor)
      return false;
    cursor = row.seq;
    const episode = vault.episodes.get(threadId, row.seq);
    if (episode === null) continue;
    const closure = verifyRemovedEpisode(vault, threadId, episode);
    if (closure.error === undefined) return true;
  }
}

function validExplicit(span: ExplicitReachabilitySpan): boolean {
  return (
    Number.isInteger(span.from) &&
    Number.isInteger(span.to) &&
    span.from >= 0 &&
    span.to > span.from &&
    /^[0-9a-f]{64}$/.test(span.hash) &&
    ["resident", "capsule", "pageable", "opaque"].includes(span.state) &&
    (span.state !== "pageable" ||
      (span.locator !== undefined &&
        span.locator.source === span.source &&
        span.locator.from === span.from &&
        span.locator.to === span.to &&
        span.locator.hash === span.hash))
  );
}

function verifyPartition(
  rows: readonly ExplicitReachabilitySpan[],
  bytes: Uint8Array,
  source: string,
): string | undefined {
  const sorted = [...rows].sort((a, b) => a.from - b.from);
  let cursor = 0;
  for (const row of sorted) {
    if (row.source !== source) return `wrong source in ${source}`;
    if (row.from !== cursor || row.to > bytes.byteLength) return `non-contiguous ${source}`;
    if (sha256(bytes.subarray(row.from, row.to)) !== row.hash) return `hash mismatch in ${source}`;
    cursor = row.to;
  }
  return cursor === bytes.byteLength ? undefined : `incomplete ${source}`;
}

function manifestSpansForEpisode(
  episode: Pick<Episode, "meta">,
  blob: string,
  size: number,
): AttachmentSpan[] {
  const manifest = asManifest(episode.meta.manifest);
  if (manifest === null) {
    return [
      { ordinal: 0, from: 0, to: episode.meta.size ?? size, hash: blob, state: "opaque", objectHash: blob },
    ];
  }
  if (manifest.hash !== blob || manifest.size !== size || !manifestPartitionValid(manifest)) {
    // A sentinel keeps the invalid-manifest path distinct from a legacy row,
    // which legitimately has one opaque whole-object span.
    return [{ ordinal: -1, from: -1, to: -1, hash: "", state: "opaque", objectHash: "" }];
  }
  return [...manifest.spans].sort((a, b) => a.from - b.from);
}

/**
 * Verify an attachment's whole-object closure by streaming every manifest
 * object through the kernel hash helper.  Only a partial explicit witness
 * needs bytes retained, and that path is capped at one 64 KiB range.
 */
function verifyAttachmentObjectsStreaming(
  vault: Vault,
  threadId: string,
  seq: Seq,
  rows: readonly ExplicitReachabilitySpan[],
  expected: readonly AttachmentSpan[],
  blob: string,
  ranged: boolean,
): string | undefined {
  const expectedRanges = [...expected].sort((a, b) => a.from - b.from);
  if (
    expectedRanges.length === 0 ||
    expectedRanges.some(
      (range, index) =>
        range.ordinal !== index ||
        range.from < 0 ||
        range.to < range.from ||
        range.from !== (index === 0 ? 0 : (expectedRanges[index - 1] as AttachmentSpan).to) ||
        !/^[0-9a-f]{64}$/.test(range.hash) ||
        !/^[0-9a-f]{64}$/.test(range.objectHash),
    )
  ) {
    return `invalid manifest ${blob}`;
  }
  const streamed = verifyAttachmentSpan(vault, threadId, seq, 0);
  if (streamed === null || streamed.manifest.hash !== blob) {
    return `missing or corrupt attachment ${blob}`;
  }

  if (!ranged) {
    const sorted = [...rows].sort((a, b) => a.from - b.from);
    let cursor = 0;
    for (const row of sorted) {
      if (row.source !== `blob:${blob}` || row.from !== cursor || row.to > streamed.manifest.size) {
        return `non-contiguous attachment ${blob}`;
      }
      const matching = expectedRanges.find((range) => range.from === row.from && range.to === row.to);
      if (matching === undefined || matching.hash !== row.hash) {
        return `hash mismatch in attachment ${blob}`;
      }
      cursor = row.to;
    }
    return cursor === streamed.manifest.size ? undefined : `incomplete attachment ${blob}`;
  }

  if (rows.length === 0) return undefined;
  const sorted = [...rows].sort((a, b) => a.from - b.from);
  let previousTo = -1;
  let from = Number.MAX_SAFE_INTEGER;
  let to = 0;
  for (const row of sorted) {
    if (
      row.source !== `blob:${blob}` ||
      row.from < 0 ||
      row.to <= row.from ||
      row.to > streamed.manifest.size
    ) {
      return `invalid attachment witness ${blob}`;
    }
    if (row.from < previousTo) return `overlapping attachment witness ${blob}`;
    previousTo = row.to;
    from = Math.min(from, row.from);
    to = Math.max(to, row.to);
  }
  if (to - from > 64 * 1024) return `attachment witness exceeds bounded range ${blob}`;
  const selected = readAttachmentRange(vault, threadId, seq, [from, to]);
  if (selected === null) return `attachment witness bytes are unavailable ${blob}`;
  for (const row of sorted) {
    if (sha256(selected.bytes.subarray(row.from - from, row.to - from)) !== row.hash) {
      return `hash mismatch in attachment ${blob}`;
    }
  }
  return undefined;
}
