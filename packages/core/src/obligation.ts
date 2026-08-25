/** Deterministic collection obligations and route receipts (KERNEL A13). */

import { createHash } from "node:crypto";
import type {
  AttachmentManifest,
  CollectionCue,
  CoverageBasis,
  CoverageBasisMember,
  CoverageBasisMemberOutcome,
  CoverageBasisRoute,
  CoverageLocator,
  CoverageReceipt,
  CoverageRouteRun,
  CoverageRouteRunStatus,
  Episode,
  PageRecord,
  Seq,
} from "@pylos/protocol";
import { COVERAGE_CAPS } from "@pylos/protocol";
import { ATTACHMENT_CHUNK_SIZE, manifestPartitionValid, readAttachmentRange } from "./attachment.ts";
import { canonicalHash, sha256 } from "./hash.ts";
import { names } from "./pure/names.ts";
import { COMPILER_VERSION, type CoverageEpisodeRow, type Vault } from "./vault.ts";

const CUES: readonly CollectionCue[] = ["all", "every", "compare", "list", "each"];
const CUE_RE = /\b(all|every|compare|list|each)\b/giu;
/**
 * Coverage must not materialize every derived atom for one source.  Fetch one
 * extra row to distinguish a complete bounded read from an overflowing one;
 * overflow is represented as an unresolved locator below.
 */
const OBLIGATION_ATOM_EVIDENCE_LIMIT = COVERAGE_CAPS.atomEvidence;
const OBLIGATION_NAME_ROUTE_LIMIT = COVERAGE_CAPS.nameRoute;
const OBLIGATION_SEARCH_ROUTE_LIMIT = COVERAGE_CAPS.searchRoute;
const OBLIGATION_RETAINED_SOURCE_LIMIT = COVERAGE_CAPS.retainedSources;
/**
 * A collection locator authenticates one source, not every byte chunk in an
 * attachment.  Keep a hard per-manifest bound nevertheless: an imported or
 * adversarial manifest must not turn one query into unbounded span work.
 * The extra span is a sentinel; it is never emitted as evidence.
 */
const OBLIGATION_ATTACHMENT_SPAN_LIMIT = COVERAGE_CAPS.attachmentSpans;
/** Total distinct attachment source locators retained by one obligation. */
const OBLIGATION_ATTACHMENT_ROUTE_LIMIT = OBLIGATION_RETAINED_SOURCE_LIMIT;
/** Total distinct coverage locators retained by one obligation, across routes. */
const OBLIGATION_TOTAL_LOCATOR_LIMIT = OBLIGATION_RETAINED_SOURCE_LIMIT;
/** Aggregate bounded application work for one collection planner. */
/** Shared replay/issuance ceiling for one collection planner's byte work. */
export const OBLIGATION_CANDIDATE_WORK_BYTES = COVERAGE_CAPS.candidateWorkBytes;
const OBLIGATION_ATOM_ROW_WORK_BYTES = 4 * 1024;
const OBLIGATION_MANIFEST_ROW_WORK_BYTES = 256;
/** Metadata is parsed only when it fits this fixed projection. */
const OBLIGATION_SOURCE_META_LIMIT = 64 * 1024;
const OBLIGATION_CONTENT_HASH_CHUNK = 64 * 1024;
/**
 * The issuance basis is deliberately bounded independently of the locator map.
 * Names have at most 256 keys × (16 rows + one sentinel); the other routes are
 * bounded by the same one-extra-row convention. Any excess is represented by
 * `overflow` and makes that route unresolved rather than silently disappearing.
 */
const OBLIGATION_BASIS_MEMBER_LIMITS: Record<CoverageOrigin, number> = {
  // Reserve one bounded slot for the collection-name-key overflow sentinel.
  names: OBLIGATION_RETAINED_SOURCE_LIMIT * (OBLIGATION_NAME_ROUTE_LIMIT + 1) + 1,
  pages: OBLIGATION_TOTAL_LOCATOR_LIMIT + 1,
  search: OBLIGATION_RETAINED_SOURCE_LIMIT + 1,
};

// Revisions are persisted in receipts and later parsed by the verifier.  A
// malformed/imported manifest must never get to choose their grammar.  These
// are the only identifier forms emitted by the attachment writer (new IDs are
// `am_<timestamp><random-hex>`; legacy IDs are `legacy_<sha256>`).
const ATTACHMENT_MANIFEST_ID_RE = /^(?:am|legacy)_[A-Za-z0-9_-]{1,127}$/u;
const ATTACHMENT_MANIFEST_DIGEST_RE = /^[0-9a-f]{64}$/u;
const ATTACHMENT_UNRESOLVED_REASON_RE = /^(?:manifest|partition|opaque|bytes|inline|span-cap)$/u;

const SMALL_CARDINALS = new Map<string, number>([
  ["zero", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
]);
const SMALL_CARDINAL_PATTERN = [...SMALL_CARDINALS.keys()].join("|");

export function collectionCue(question: string): CollectionCue | null {
  CUE_RE.lastIndex = 0;
  const match = CUE_RE.exec(question.normalize("NFKC"));
  const cue = match?.[1]?.toLocaleLowerCase("en-US");
  return CUES.includes(cue as CollectionCue) ? (cue as CollectionCue) : null;
}

/** Only a number written by the user beside a collection cue is cardinality. */
export function explicitCardinality(question: string): number | undefined {
  const normalized = question.normalize("NFKC");
  const match =
    /\b(?:all|every|compare|list|each)\b(?:\s+\w+){0,3}\s+(\d{1,9})\b/iu.exec(normalized) ??
    /\b(\d{1,9})\s+(?:items?|notes?|records?|turns?|sources?|owners?|places?)\b/iu.exec(normalized);
  if (match?.[1] !== undefined) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }

  // Written small cardinalities are still user-authored evidence, but only in
  // the determiner slot next to the cue. This recognizes "all three" and
  // "every one of the three" without mistaking a later label such as
  // "phase two" for the requested collection size.
  const written = new RegExp(
    `\\b(?:all|every|compare|list|each)\\b(?:\\s+(?:all|every|each|one|of|the)){0,5}\\s+(${SMALL_CARDINAL_PATTERN})\\b(?=\\s+\\p{L})`,
    "iu",
  ).exec(normalized);
  return written?.[1] === undefined ? undefined : SMALL_CARDINALS.get(written[1].toLocaleLowerCase("en-US"));
}

/** A bounded lexical subject for the exhaustive collection route. */
function collectionSubject(question: string): string {
  const beforeList = question.split(":", 1)[0] ?? question;
  return beforeList
    .normalize("NFKC")
    .replace(CUE_RE, " ")
    .replace(/\b\d{1,9}\b/gu, " ")
    .replace(
      /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/giu,
      " ",
    )
    .replace(/\b(?:in|of)\s+the\s+(?:archive|conversation|thread)\b/giu, " ")
    .replace(/\b(?:of|the|items?|notes?|records?|turns?|sources?|places?)\b/giu, " ")
    .replace(/[?!.,;]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

interface CoverageSource {
  episode: Episode;
  contentHash: string;
  contentBytes: number;
  metadataComplete: boolean;
}

function episodeRow(vault: Vault, threadId: string, seq: Seq): CoverageSource | null {
  // This is intentionally two bounded projections rather than episodes.get:
  // an imported source may carry GiBs of content and metadata.  The content
  // hash and byte length are scalar chain fields; only a bounded metadata
  // prefix is needed to decide whether an attachment manifest is usable.
  const scalar = vault.db
    .query(
      "SELECT content_hash, length(CAST(content AS BLOB)) AS content_bytes, " +
        "CASE WHEN json_valid(meta) = 1 THEN COALESCE(json_extract(meta, '$.removed'), 0) ELSE 0 END AS removed " +
        "FROM episode WHERE thread_id = ? AND seq = ?",
    )
    .get(threadId, seq) as { content_hash: string; content_bytes: number; removed: number } | null;
  if (
    scalar === null ||
    typeof scalar.content_hash !== "string" ||
    !Number.isSafeInteger(scalar.content_bytes) ||
    scalar.content_bytes < 0 ||
    scalar.removed === 1
  ) {
    return null;
  }
  const episode = vault.episodes.getBounded(threadId, seq, 0, OBLIGATION_SOURCE_META_LIMIT);
  if (episode === null || episode.meta.removed === true) return null;
  return {
    episode,
    contentHash: scalar.content_hash,
    contentBytes: scalar.content_bytes,
    metadataComplete: episode.metaTruncated !== true,
  };
}

function authorityOf(role: Episode["role"]): CoverageLocator["authority"] | null {
  if (role === "user") return "user";
  if (role === "tool") return "tool";
  if (role === "attachment") return "attachment";
  if (role === "assistant") return "assistant";
  // System and handoff rows are kernel narration, not evidence. Protocol has
  // intentionally no authority value for them, so they are excluded rather
  // than inheriting user authority.
  return null;
}

function statusOf(episode: Episode): CoverageLocator["status"] {
  return episode.role === "user" || episode.role === "attachment" ? "supported" : "proposed";
}

function locatorFor(
  source: CoverageSource,
  route: CoverageLocator["route"],
  status = statusOf(source.episode),
  revision = `episode:${source.episode.seq}:${source.contentHash}`,
  byteRange?: [number, number],
): CoverageLocator {
  const authority = authorityOf(source.episode.role);
  if (authority === null) throw new Error("kernel-authored episode cannot produce coverage evidence");
  const byteLength = source.contentBytes;
  const base = {
    route,
    source: `episode:${source.episode.seq}`,
    byteRange: byteRange ?? ([0, byteLength] as [number, number]),
    revision,
    authority,
    status,
  };
  return { ...base, digest: canonicalHash(base) };
}

interface AtomEvidenceRow {
  id: string;
  key: string;
  value: string;
  key_bytes: number;
  value_bytes: number;
  source_span: string | null;
  source_span_bytes: number;
  valid_from_seq: number;
  valid_to_seq: number | null;
  phase: string;
  authority: string;
  source_seq: number;
}

interface AtomEvidence {
  id: string;
  locator: CoverageLocator;
}

interface NameAtom {
  id: string;
  key: string;
  value: string;
  sourceSeq: Seq;
  phase: string;
  sourceSpan: string | null;
  validFromSeq: number;
  validToSeq: number | null;
  authority: string;
  projectionValid: boolean;
}

function atomStatus(row: Pick<AtomEvidenceRow, "phase" | "authority">): CoverageLocator["status"] | null {
  if (row.phase === "REVOKED") return null;
  if (row.phase === "HISTORICAL" && row.authority === "user") return "historical";
  if (row.phase === "SUPPORTED" && row.authority === "user") return "supported";
  return "proposed";
}

function parsedSourceSpan(raw: string | null): [number, number] | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number" &&
      Number.isInteger(value[0]) &&
      Number.isInteger(value[1]) &&
      value[0] >= 0 &&
      value[1] > value[0]
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // A malformed derived span is not authority. Fall back to the exact value
    // search, then to the whole source only when no narrower witness exists.
  }
  return undefined;
}

/** Convert an atom's character span to the byte range stored in a receipt. */
function atomByteRange(
  vault: Vault,
  threadId: string,
  source: CoverageSource,
  value: string,
  sourceSpan: [number, number] | undefined,
): [number, number] {
  const startChar = Math.max(0, sourceSpan?.[0] ?? 0);
  const endChar = Math.max(startChar, sourceSpan?.[1] ?? startChar + value.length);
  if (sourceSpan !== undefined && endChar > startChar) {
    const match = vault.db
      .query(
        "SELECT instr(substr(content, ?, ?), ?) AS position " +
          "FROM episode WHERE thread_id = ? AND seq = ?",
      )
      .get(startChar + 1, endChar - startChar, value, threadId, source.episode.seq) as {
      position: number | null;
    } | null;
    const position = match?.position ?? 0;
    if (position > 0) {
      const fromChar = startChar + position - 1;
      const toChar = Math.min(endChar, fromChar + value.length);
      const bytes = vault.db
        .query(
          "SELECT length(CAST(substr(content, 1, ?) AS BLOB)) AS from_bytes, " +
            "length(CAST(substr(content, 1, ?) AS BLOB)) AS to_bytes " +
            "FROM episode WHERE thread_id = ? AND seq = ?",
        )
        .get(fromChar, toChar, threadId, source.episode.seq) as {
        from_bytes: number | null;
        to_bytes: number | null;
      } | null;
      if (bytes !== null) {
        const fromBytes = bytes.from_bytes;
        const toBytes = bytes.to_bytes;
        if (
          Number.isSafeInteger(fromBytes) &&
          Number.isSafeInteger(toBytes) &&
          (toBytes as number) > (fromBytes as number)
        ) {
          return [fromBytes as number, toBytes as number];
        }
      }
    }
  }
  // A malformed/missing derived span is not allowed to mint a narrower
  // witness. The whole scalar source range remains bounded and is rechecked
  // against exact bytes by the claim gate before release.
  return [0, source.contentBytes];
}

/** Hash one source's inline bytes in fixed-size SQL projections. */
function episodeContentHash(vault: Vault, threadId: string, source: CoverageSource): string | null {
  if (source.contentBytes > OBLIGATION_CANDIDATE_WORK_BYTES) return null;
  const digest = createHash("sha256");
  let offset = 0;
  while (offset < source.contentBytes) {
    const count = Math.min(OBLIGATION_CONTENT_HASH_CHUNK, source.contentBytes - offset);
    const row = vault.db
      .query(
        "SELECT substr(CAST(content AS BLOB), ?, ?) AS bytes " +
          "FROM episode WHERE thread_id = ? AND seq = ?",
      )
      .get(offset + 1, count, threadId, source.episode.seq) as { bytes: Uint8Array | string | null } | null;
    if (row?.bytes === null || row?.bytes === undefined) return null;
    const bytes = typeof row.bytes === "string" ? Buffer.from(row.bytes, "utf8") : Buffer.from(row.bytes);
    if (bytes.byteLength !== count) return null;
    digest.update(bytes);
    offset += count;
  }
  return digest.digest("hex");
}

function atomRowsForSource(vault: Vault, threadId: string, sourceSeq: Seq): AtomEvidenceRow[] {
  return vault.db
    .query(
      "SELECT id, substr(key, 1, 512) AS key, substr(value, 1, 2048) AS value, " +
        "length(CAST(key AS BLOB)) AS key_bytes, length(CAST(value AS BLOB)) AS value_bytes, " +
        "substr(source_span, 1, 256) AS source_span, length(CAST(source_span AS BLOB)) AS source_span_bytes, " +
        "valid_from_seq, valid_to_seq, phase, authority, source_seq " +
        `FROM atom WHERE thread_id = ? AND source_seq = ? ORDER BY valid_from_seq, id LIMIT ${OBLIGATION_ATOM_EVIDENCE_LIMIT + 1}`,
    )
    .all(threadId, sourceSeq) as AtomEvidenceRow[];
}

/** All atom-backed witnesses for one source episode, each with its own status. */
function atomEvidenceForSource(
  vault: Vault,
  threadId: string,
  row: CoverageSource,
  projectedRows?: AtomEvidenceRow[],
): AtomEvidence[] | null {
  if (authorityOf(row.episode.role) === null) return [];
  const atoms = projectedRows ?? atomRowsForSource(vault, threadId, row.episode.seq);
  if (atoms.length > OBLIGATION_ATOM_EVIDENCE_LIMIT) return null;
  // A truncated derived value/span cannot be a byte-exact witness. Fail the
  // source closed rather than silently dropping one atom from a collection.
  if (
    atoms.some(
      (atom) =>
        !Number.isSafeInteger(atom.key_bytes) ||
        !Number.isSafeInteger(atom.value_bytes) ||
        atom.key_bytes > 512 ||
        atom.value_bytes > 2048 ||
        atom.source_span_bytes > 256,
    )
  ) {
    return null;
  }
  const out: AtomEvidence[] = [];
  for (const atom of atoms) {
    const status =
      row.episode.role === "user" || row.episode.role === "attachment"
        ? atomStatus(atom)
        : atom.phase === "REVOKED"
          ? null
          : "proposed";
    if (status === null) continue;
    const byteRange = atomByteRange(vault, threadId, row, atom.value, parsedSourceSpan(atom.source_span));
    const revision = canonicalHash({
      contentHash: row.contentHash,
      key: atom.key,
      value: atom.value,
      byteRange,
      validFromSeq: atom.valid_from_seq,
      validToSeq: atom.valid_to_seq,
    });
    out.push({
      id: atom.id,
      locator: locatorFor(row, "frontier", status, revision, byteRange),
    });
  }
  return out;
}

/** Keep an overflow visible without presenting a whole source as supported. */
function unresolvedAtomOverflow(row: CoverageSource, route: CoverageLocator["route"]): CoverageLocator {
  return locatorFor(
    row,
    route,
    "unresolved",
    `atom-cap:${canonicalHash([row.episode.seq, row.contentHash, OBLIGATION_ATOM_EVIDENCE_LIMIT])}`,
  );
}

function unresolvedAttachment(
  row: CoverageSource,
  route: CoverageLocator["route"],
  manifestId: string,
  manifestDigest: string,
  reason: string,
  byteRange: [number, number],
): CoverageLocator | null {
  // CoverageLocator requires a non-empty bounded byte range.  An empty
  // attachment has no honest byte witness; its route-level unresolved status
  // is emitted by coverageFor instead of fabricating [0, 0].
  if (byteRange[1] <= byteRange[0]) return null;
  // Never interpolate imported metadata into a verifier-facing revision.  A
  // malformed ID/digest is represented by the route-level unresolved bit;
  // there is deliberately no fallback locator whose grammar could be forged.
  if (
    !ATTACHMENT_MANIFEST_ID_RE.test(manifestId) ||
    !ATTACHMENT_MANIFEST_DIGEST_RE.test(manifestDigest) ||
    !ATTACHMENT_UNRESOLVED_REASON_RE.test(reason)
  ) {
    return null;
  }
  return locatorFor(
    row,
    route,
    "unresolved",
    `attachment-unresolved:${manifestId}:${manifestDigest}:${reason}`,
    byteRange,
  );
}

/**
 * Attachment FTS text is only an address. Before it enters a coverage receipt,
 * stream-verify the whole manifest and prove each indexed span is exactly the
 * corresponding UTF-8 slice of the episode text. Missing, corrupt, opaque, or
 * non-prefix indexed spans remain unresolved.
 */
function attachmentEvidenceForSource(
  vault: Vault,
  threadId: string,
  row: CoverageSource,
  route: CoverageLocator["route"],
  reserveWork?: (bytes: number) => boolean,
): Array<CoverageLocator | null> {
  const rawManifest: unknown = row.metadataComplete ? row.episode.meta.manifest : undefined;
  const manifest =
    rawManifest !== null && typeof rawManifest === "object" && !Array.isArray(rawManifest)
      ? (rawManifest as AttachmentManifest)
      : undefined;
  const blob = row.episode.meta.blob;
  const manifestSize =
    manifest !== undefined && Number.isSafeInteger(manifest.size) && manifest.size >= 0 ? manifest.size : 0;
  const fallbackRange: [number, number] = [0, Math.min(manifestSize, ATTACHMENT_CHUNK_SIZE)];
  let partitionValid = false;
  if (manifest !== undefined) {
    try {
      partitionValid = manifestPartitionValid(manifest);
    } catch {
      // Imported metadata is data, not code. A malformed span/object shape is
      // an unresolved route and must not make coverage generation throw.
      partitionValid = false;
    }
  }
  if (manifest === undefined || typeof blob !== "string" || manifest.hash !== blob || !partitionValid) {
    return [
      unresolvedAttachment(
        row,
        route,
        manifest?.id ?? "missing",
        manifest?.digest ?? "missing",
        "manifest",
        fallbackRange,
      ),
    ];
  }

  const indexed: Array<(typeof manifest.spans)[number]> = [];
  let indexedCount = 0;
  let prefixEnd = 0;
  let indexedEnded = false;
  for (const span of manifest.spans) {
    if (span.state === "indexed") {
      if (indexedEnded || span.from !== prefixEnd) {
        return [
          unresolvedAttachment(row, route, manifest.id, manifest.digest, "partition", [
            0,
            Math.min(manifest.size, ATTACHMENT_CHUNK_SIZE),
          ]),
        ];
      }
      indexedCount += 1;
      if (indexed.length <= OBLIGATION_ATTACHMENT_SPAN_LIMIT) indexed.push(span);
      prefixEnd = span.to;
    } else {
      indexedEnded = true;
    }
  }
  if (indexedCount > OBLIGATION_ATTACHMENT_SPAN_LIMIT) {
    return [
      unresolvedAttachment(row, route, manifest.id, manifest.digest, "span-cap", [
        0,
        Math.min(manifest.size, ATTACHMENT_CHUNK_SIZE),
      ]),
    ];
  }
  if (
    reserveWork !== undefined &&
    !reserveWork(
      Math.min(OBLIGATION_CANDIDATE_WORK_BYTES + 1, row.contentBytes) +
        indexed.length * OBLIGATION_MANIFEST_ROW_WORK_BYTES,
    )
  ) {
    // The indexed span count is still within its contract bound; this is an
    // aggregate source-work refusal, not a span-cap refusal.  Do not mint a
    // span-cap locator whose revision would be disproved by replay.  The
    // caller records the route-level unresolved outcome explicitly.
    return [null];
  }
  if (indexed.length === 0) {
    return [
      unresolvedAttachment(row, route, manifest.id, manifest.digest, "opaque", [
        0,
        Math.min(manifest.size, ATTACHMENT_CHUNK_SIZE),
      ]),
    ];
  }

  // One bounded selected range causes readAttachmentRange to stream and hash
  // every manifest span, while retaining at most one indexed chunk.
  const first = indexed[0] as (typeof indexed)[number];
  const verified = readAttachmentRange(vault, threadId, row.episode.seq, [first.from, first.to], {
    requireIndexed: true,
  });
  if (verified === null || verified.opaque) {
    return [unresolvedAttachment(row, route, manifest.id, manifest.digest, "bytes", [first.from, first.to])];
  }

  // FTS text is only an address. If the retained episode text extends beyond
  // the contiguous indexed prefix, the suffix has no indexed byte witness;
  // supporting the source from the prefix would let a planted inline suffix
  // inherit attachment authority.
  if (row.contentBytes !== prefixEnd) {
    return [unresolvedAttachment(row, route, manifest.id, manifest.digest, "inline", [first.from, first.to])];
  }
  const inlineHash = episodeContentHash(vault, threadId, row);
  if (inlineHash === null || inlineHash !== manifest.hash || inlineHash !== row.contentHash) {
    return [unresolvedAttachment(row, route, manifest.id, manifest.digest, "inline", [first.from, first.to])];
  }

  // A collection count is a count of source episodes.  Returning one locator
  // per indexed chunk would make a single attachment look like hundreds of
  // records.  The first indexed span is a bounded, exact witness after the
  // complete manifest/object verification above; the route remains tied to
  // the source/manifest and the span hash in its revision.
  const span = indexed[0] as (typeof indexed)[number];
  return [
    locatorFor(
      row,
      route,
      "supported",
      `attachment:${manifest.id}:${manifest.digest}:${span.ordinal}:${span.hash}`,
      [span.from, span.to],
    ),
  ];
}

function addLocator(target: Map<string, CoverageLocator>, locator: CoverageLocator): void {
  const key = coverageLocatorBindingKey(locator);
  const prior = target.get(key);
  // Current authoritative support wins; history remains visible when it is the
  // only classification for this exact revision.
  const rank = { supported: 3, historical: 2, proposed: 1, unresolved: 0 } as const;
  if (prior === undefined || rank[locator.status] > rank[prior.status]) target.set(key, locator);
}

function coverageLocatorBindingKey(
  locator: Pick<CoverageLocator, "source" | "byteRange" | "revision">,
): string {
  return canonicalHash([locator.source, locator.byteRange, locator.revision]);
}

/**
 * `names()` intentionally ignores a single capitalized token at sentence
 * start, which is correct for loss routing but too conservative for an
 * explicit collection list after a colon (`...: Lisbon and Porto`).  The
 * obligation route may add those address-only tokens; they still have to
 * resolve through the atom-name index before they count as evidence.
 */
/** Kernel-derived names used by the collection frontier route and its replay. */
const COLLECTION_NAME_KEY_LIMIT = OBLIGATION_RETAINED_SOURCE_LIMIT;
export interface CollectionNameKeyResult {
  keys: string[];
  overflow: boolean;
}

export function collectionNameKeysDetailed(question: string): CollectionNameKeyResult {
  const keys = new Set<string>();
  let overflow = false;
  const add = (key: string): void => {
    if (keys.has(key)) return;
    if (keys.size >= COLLECTION_NAME_KEY_LIMIT) {
      overflow = true;
      return;
    }
    keys.add(key);
  };
  const lexicalNames = names(question, { max: COLLECTION_NAME_KEY_LIMIT + 1 });
  if (lexicalNames.length > COLLECTION_NAME_KEY_LIMIT) overflow = true;
  for (const hit of lexicalNames) add(hit.name);
  const suffix = question.split(":").slice(1).join(":");
  for (const match of suffix.matchAll(/\b\p{Lu}[\p{L}\p{N}'’-]{2,63}\b/gu)) {
    const key = (match[0] as string).normalize("NFKC").toLowerCase();
    if (key.length >= 3) add(key);
  }
  return { keys: [...keys], overflow };
}

export function collectionNameKeys(question: string): string[] {
  return collectionNameKeysDetailed(question).keys;
}

export interface CoverageInput {
  question: string;
  querySeq: Seq;
  pages?: readonly PageRecord[];
  /** Kernel-selected collection router version; never supplied by provider prose. */
  routerVersion?: string;
}

function routeRun(route: string, returned: number, status: CoverageRouteRunStatus): CoverageRouteRun {
  return { route, returned, status };
}

type CoverageOrigin = "names" | "pages" | "search";

interface MutableCoverageBasisRoute {
  members: CoverageBasisMember[];
  memberCount: number;
  overflow: boolean;
}

function coverageBasisOutcome(locators: readonly CoverageLocator[]): CoverageBasisMemberOutcome {
  if (locators.length === 0) return "no-locator";
  if (locators.some((locator) => locator.status === "unresolved")) return "unresolved";
  if (locators.some((locator) => locator.status === "supported")) return "supported";
  if (locators.some((locator) => locator.status === "historical")) return "historical";
  if (locators.some((locator) => locator.status === "proposed")) return "proposed";
  return "no-locator";
}

/**
 * Run and receipt only deterministic routes. Top-level counts are deduplicated
 * source locators—not model items—while `routesRun.returned` records the raw,
 * bounded rows/hits observed by each route for deterministic replay. Unknown
 * cardinality remains a lower bound.
 */
export function coverageFor(
  vault: Vault,
  threadId: string,
  input: CoverageInput,
): CoverageReceipt | undefined {
  const cue = collectionCue(input.question);
  if (cue === null) return undefined;
  const routes = new Map<string, CoverageLocator>();
  const basisLocatorBindings = new Map<string, string>();
  const routesRun: CoverageRouteRun[] = [];
  const routeIssues: Record<CoverageOrigin, boolean> = { names: false, pages: false, search: false };
  let evidenceOverflowed = false;
  let candidateWorkBytes = 0;
  let candidateWorkOverflowed = false;
  const reserveCandidateWork = (bytes: number): boolean => {
    if (candidateWorkOverflowed) return false;
    const bounded = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : OBLIGATION_CANDIDATE_WORK_BYTES + 1;
    if (bounded > OBLIGATION_CANDIDATE_WORK_BYTES - candidateWorkBytes) {
      candidateWorkOverflowed = true;
      return false;
    }
    candidateWorkBytes += bounded;
    return true;
  };

  // A source can be reached through several deterministic routes (for example
  // the FTS pass and the atom/name index). The route receipt is about exact
  // source locators, not the number of indexes that happened to find one. Keep
  // the atom witnesses by source so page/FTS fallback cannot add a whole-source
  // row that double-counts or relabels a neighboring fact.
  const sourceAtoms = new Map<Seq, AtomEvidence[] | null>();
  const attachmentWorkSources = new Set<Seq>();
  const atomsFor = (row: CoverageSource): AtomEvidence[] | null => {
    const cached = sourceAtoms.get(row.episode.seq);
    if (cached !== undefined) return cached;
    if (authorityOf(row.episode.role) === null) {
      sourceAtoms.set(row.episode.seq, []);
      return [];
    }
    // Read one bounded extra row instead of COUNT(*).  The source index makes
    // this a keyset-sized existence/overflow probe even for dense imports.
    const projectedRows = atomRowsForSource(vault, threadId, row.episode.seq);
    const atomCount = projectedRows.length;
    const atomCountOverflow = atomCount > OBLIGATION_ATOM_EVIDENCE_LIMIT;
    const atomWorkAvailable = reserveCandidateWork(atomCount * OBLIGATION_ATOM_ROW_WORK_BYTES);
    if (atomCountOverflow || !atomWorkAvailable) {
      sourceAtoms.set(row.episode.seq, null);
      return null;
    }
    const evidence = atomEvidenceForSource(vault, threadId, row, projectedRows);
    sourceAtoms.set(row.episode.seq, evidence);
    return evidence;
  };
  const noteRouteIssue = (origin: CoverageOrigin): void => {
    routeIssues[origin] = true;
  };
  const basisRoutes: Record<CoverageOrigin, MutableCoverageBasisRoute> = {
    names: { members: [], memberCount: 0, overflow: false },
    pages: { members: [], memberCount: 0, overflow: false },
    search: { members: [], memberCount: 0, overflow: false },
  };
  const addBasisMember = (origin: CoverageOrigin, member: CoverageBasisMember): void => {
    const basis = basisRoutes[origin];
    basis.memberCount += 1;
    if (basis.members.length >= OBLIGATION_BASIS_MEMBER_LIMITS[origin]) {
      basis.overflow = true;
      noteRouteIssue(origin);
      return;
    }
    basis.members.push(member);
  };
  const basisMember = (
    sourceSeq: Seq,
    contentHash: string,
    locators: readonly CoverageLocator[],
    extras?: Partial<CoverageBasisMember>,
  ): CoverageBasisMember => ({
    kind: "candidate",
    sourceSeq,
    contentHash,
    outcome: coverageBasisOutcome(locators),
    locatorDigests: locators.map((locator) => locator.digest).sort(),
    ...extras,
  });
  // Do not retain source rows across the route planner. Each lookup is a
  // scalar/bounded projection and is discarded after the source's evidence is
  // issued; this prevents a 1024-hit route from pinning imported episode
  // content or metadata in a JS map.
  const sourceForSeq = (seq: Seq): CoverageSource | null => episodeRow(vault, threadId, seq);
  const addBoundedLocator = (locator: CoverageLocator, origin: CoverageOrigin): boolean => {
    if (locator.status === "unresolved") noteRouteIssue(origin);
    const key = coverageLocatorBindingKey(locator);
    if (!routes.has(key) && routes.size >= OBLIGATION_TOTAL_LOCATOR_LIMIT) {
      // The current candidate is the +1 sentinel. Keep the map bounded and
      // make the originating route unresolved so no exact collection can be
      // certified from silently dropped evidence.
      evidenceOverflowed = true;
      noteRouteIssue(origin);
      return false;
    }
    basisLocatorBindings.set(locator.digest, key);
    addLocator(routes, locator);
    return true;
  };
  // Count distinct attachment source locators, not route/index hits. The set
  // also makes repeated page/search/name hits for one source free, while the
  // fixed cap prevents a high-hit query from silently materializing an
  // unbounded receipt.
  const attachmentLocatorKeys = new Set<string>();
  const addAttachmentEvidence = (locator: CoverageLocator | null, origin: CoverageOrigin): boolean => {
    if (locator === null) {
      noteRouteIssue(origin);
      return false;
    }
    const key = coverageLocatorBindingKey(locator);
    if (!attachmentLocatorKeys.has(key) && attachmentLocatorKeys.size >= OBLIGATION_ATTACHMENT_ROUTE_LIMIT) {
      evidenceOverflowed = true;
      noteRouteIssue(origin);
      return false;
    }
    attachmentLocatorKeys.add(key);
    return addBoundedLocator(locator, origin);
  };
  const addSourceEvidence = (
    row: CoverageSource,
    route: CoverageLocator["route"],
    origin: CoverageOrigin,
  ): CoverageLocator[] => {
    if (authorityOf(row.episode.role) === null) {
      noteRouteIssue(origin);
      return [];
    }
    // A later route that returns an evidence-bearing source after the cap has
    // filled cannot be treated as complete: its candidate was not mechanically
    // checked for duplication. Mark that route unresolved as well.
    if (evidenceOverflowed) {
      noteRouteIssue(origin);
      return [];
    }
    if (row.episode.role === "attachment") {
      const accepted: CoverageLocator[] = [];
      const reserveAttachmentWork = (bytes: number): boolean => {
        if (attachmentWorkSources.has(row.episode.seq)) return true;
        if (!reserveCandidateWork(bytes)) return false;
        attachmentWorkSources.add(row.episode.seq);
        return true;
      };
      for (const locator of attachmentEvidenceForSource(vault, threadId, row, route, reserveAttachmentWork)) {
        if (locator === null) {
          noteRouteIssue(origin);
          continue;
        }
        if (addAttachmentEvidence(locator, origin)) accepted.push(locator);
        if (evidenceOverflowed) break;
      }
      return accepted;
    }
    const evidence = atomsFor(row);
    if (evidence === null) {
      const locator = unresolvedAtomOverflow(row, route);
      return addBoundedLocator(locator, origin) ? [locator] : [];
    }
    if (evidence.length === 0) {
      const locator = locatorFor(row, route);
      return addBoundedLocator(locator, origin) ? [locator] : [];
    }
    const accepted: CoverageLocator[] = [];
    for (const atom of evidence) {
      if (addBoundedLocator(atom.locator, origin)) accepted.push(atom.locator);
      if (evidenceOverflowed) break;
    }
    return accepted;
  };

  const seenAtoms = new Set<string>();
  const nameKeyResult = collectionNameKeysDetailed(input.question);
  const nameKeys = nameKeyResult.keys;
  let namesReturned = 0;
  let namesOverflowed = false;
  let nameProjectionOverflow = false;
  const nameAtomsBeforeQuery = (name: string): NameAtom[] => {
    const rows = vault.db
      .query(
        "SELECT a.id, substr(a.key, 1, 512) AS key, substr(a.value, 1, 2048) AS value, a.source_seq, a.phase, " +
          "substr(a.source_span, 1, 256) AS source_span, a.valid_from_seq, a.valid_to_seq, a.authority, " +
          "length(CAST(a.key AS BLOB)) AS key_bytes, length(CAST(a.value AS BLOB)) AS value_bytes, " +
          "length(CAST(a.source_span AS BLOB)) AS source_span_bytes " +
          "FROM atom_name n JOIN atom a ON a.id = n.atom_id " +
          "WHERE n.thread_id = ? AND n.name = ? AND a.phase != 'REVOKED' AND a.source_seq < ? " +
          "ORDER BY (a.phase = 'SUPPORTED') DESC, a.valid_from_seq DESC LIMIT ?",
      )
      .all(threadId, name, input.querySeq, OBLIGATION_NAME_ROUTE_LIMIT + 1) as Array<{
      id: string;
      key: string;
      value: string;
      source_seq: number;
      phase: string;
      source_span: string | null;
      valid_from_seq: number;
      valid_to_seq: number | null;
      authority: string;
      key_bytes: number;
      value_bytes: number;
      source_span_bytes: number;
    }>;
    if (
      rows.some(
        (row) =>
          !Number.isSafeInteger(row.key_bytes) ||
          !Number.isSafeInteger(row.value_bytes) ||
          row.key_bytes > 512 ||
          row.value_bytes > 2048 ||
          row.source_span_bytes > 256,
      )
    ) {
      nameProjectionOverflow = true;
    }
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      value: row.value,
      sourceSeq: row.source_seq,
      phase: row.phase,
      sourceSpan: row.source_span,
      validFromSeq: row.valid_from_seq,
      validToSeq: row.valid_to_seq,
      authority: row.authority,
      projectionValid:
        Number.isSafeInteger(row.key_bytes) &&
        Number.isSafeInteger(row.value_bytes) &&
        Number.isSafeInteger(row.source_span_bytes) &&
        row.key_bytes <= 512 &&
        row.value_bytes <= 2048 &&
        row.source_span_bytes <= 256,
    }));
  };
  for (const name of nameKeys) {
    // Fetch one sentinel row. The sentinel is never used as evidence; it only
    // proves that a bounded name route did not silently truncate its result.
    // Filtering by the asking sequence in SQL is important: tx A atomizes the
    // question before this snapshot is compiled, so fetching then discarding a
    // self-hit would consume the sentinel and falsify the route count.
    const nameAtoms = nameAtomsBeforeQuery(name);
    namesReturned += nameAtoms.length;
    if (nameAtoms.length > OBLIGATION_NAME_ROUTE_LIMIT) namesOverflowed = true;
    if (!reserveCandidateWork(nameAtoms.length * OBLIGATION_ATOM_ROW_WORK_BYTES)) {
      namesOverflowed = true;
      noteRouteIssue("names");
      addBasisMember(
        "names",
        basisMember(0, canonicalHash(["name-work-overflow", name]), [], {
          kind: "sentinel",
          key: "__name-work-overflow__",
          ordinal: namesReturned,
        }),
      );
      break;
    }
    for (const [atomIndex, atom] of nameAtoms.slice(0, OBLIGATION_NAME_ROUTE_LIMIT).entries()) {
      const row = sourceForSeq(atom.sourceSeq);
      let memberLocators: CoverageLocator[] = [];
      if (row !== null && authorityOf(row.episode.role) === null) {
        namesOverflowed = true;
        noteRouteIssue("names");
      }
      if (
        row !== null &&
        authorityOf(row.episode.role) !== null &&
        atom.projectionValid &&
        atom.sourceSeq < input.querySeq &&
        atom.phase !== "REVOKED"
      ) {
        const status = atomStatus(atom);
        if (status !== null && !seenAtoms.has(atom.id) && !evidenceOverflowed) {
          const byteRange = atomByteRange(
            vault,
            threadId,
            row,
            atom.value,
            parsedSourceSpan(atom.sourceSpan),
          );
          const revision = canonicalHash({
            contentHash: row.contentHash,
            key: atom.key,
            value: atom.value,
            byteRange,
            validFromSeq: atom.validFromSeq,
            validToSeq: atom.validToSeq,
          });
          const locator = locatorFor(row, "frontier", status, revision, byteRange);
          memberLocators = [locator];
          addBoundedLocator(locator, "names");
        }
      }
      addBasisMember(
        "names",
        basisMember(
          atom.sourceSeq,
          row?.contentHash ?? canonicalHash(["missing", atom.sourceSeq]),
          memberLocators,
          {
            atomId: atom.id,
            key: name,
            ordinal: atomIndex,
          },
        ),
      );
      seenAtoms.add(atom.id);
    }
    const sentinel = nameAtoms[OBLIGATION_NAME_ROUTE_LIMIT];
    if (sentinel !== undefined) {
      const row = sourceForSeq(sentinel.sourceSeq);
      addBasisMember(
        "names",
        basisMember(
          sentinel.sourceSeq,
          row?.contentHash ?? canonicalHash(["sentinel", name, sentinel.sourceSeq]),
          [],
          { kind: "sentinel", atomId: sentinel.id, key: name, ordinal: OBLIGATION_NAME_ROUTE_LIMIT },
        ),
      );
    }
  }
  if (nameKeyResult.overflow) {
    namesOverflowed = true;
    noteRouteIssue("names");
    addBasisMember(
      "names",
      basisMember(0, canonicalHash(["name-key-overflow", nameKeys.length, COLLECTION_NAME_KEY_LIMIT]), [], {
        kind: "sentinel",
        key: "__name-key-overflow__",
        ordinal: nameKeys.length,
      }),
    );
  }
  if (nameProjectionOverflow) {
    namesOverflowed = true;
    noteRouteIssue("names");
  }
  routesRun.push(
    routeRun(
      "names",
      namesReturned,
      routeIssues.names
        ? "unresolved"
        : nameKeys.length === 0
          ? "not-run"
          : namesOverflowed
            ? "unresolved"
            : namesReturned === 0
              ? "empty"
              : "complete",
    ),
  );

  const pages = input.pages ?? [];
  const pageCandidateLimit = OBLIGATION_TOTAL_LOCATOR_LIMIT;
  const pageMemberLimit = OBLIGATION_TOTAL_LOCATOR_LIMIT;
  const pageReturnedTotal = pages.reduce((total, page) => total + page.seqs.length, 0);
  let pageReturned = 0;
  let pageMembersObserved = 0;
  let pagesOverflowed = false;
  let pageHitOverflowed = false;
  pagesLoop: for (const [pageIndex, page] of pages.entries()) {
    if (page.seqs.length === 0) {
      if (pageMembersObserved >= pageMemberLimit) {
        pagesOverflowed = true;
        break;
      }
      pageMembersObserved += 1;
      addBasisMember(
        "pages",
        basisMember(0, canonicalHash(["page-unresolved", pageIndex, page]), [], {
          key: page.trigger,
          ordinal: pageIndex,
        }),
      );
    }
    for (const [seqIndex, seq] of page.seqs.entries()) {
      if (pageMembersObserved >= pageMemberLimit) {
        pagesOverflowed = true;
        pageHitOverflowed = true;
        break pagesLoop;
      }
      pageMembersObserved += 1;
      pageReturned += 1;
      const row = sourceForSeq(seq);
      let memberLocators: CoverageLocator[] = [];
      if (page.resolved && seq < input.querySeq && row !== null) {
        memberLocators = addSourceEvidence(row, page.trigger, "pages");
      }
      addBasisMember(
        "pages",
        basisMember(seq, row?.contentHash ?? canonicalHash(["page", pageIndex, seq]), memberLocators, {
          key: page.trigger,
          ordinal: seqIndex,
        }),
      );
    }
  }
  if (pagesOverflowed) {
    noteRouteIssue("pages");
    if (pageHitOverflowed) pageReturned = pageReturnedTotal;
    addBasisMember(
      "pages",
      basisMember(0, canonicalHash(["page-overflow", pageReturned, pageCandidateLimit]), [], {
        kind: "sentinel",
        key: "__page-overflow__",
        ordinal: pageCandidateLimit,
      }),
    );
  }
  routesRun.push(
    routeRun(
      "pages",
      pageReturned,
      routeIssues.pages
        ? "unresolved"
        : pages.length === 0
          ? "not-run"
          : pages.some((page) => !page.resolved)
            ? "unresolved"
            : pageReturned === 0
              ? "empty"
              : "complete",
    ),
  );

  // Collection routing is allowed a larger result set than an answer page. It
  // still runs one indexed query and excludes the asking turn.
  const subject = collectionSubject(input.question);
  let searchReturned = 0;
  let searchEpisodes: CoverageEpisodeRow[] = [];
  if (subject.length > 0) {
    // Fetch one sentinel row so an explicit collection can never be certified
    // from a silently truncated FTS result set.
    searchEpisodes = vault.episodes.searchCoverage(threadId, subject, OBLIGATION_SEARCH_ROUTE_LIMIT + 1, {
      mode: "strict",
      exclude: input.querySeq,
      before: input.querySeq,
    });
    searchReturned = searchEpisodes.length;
    for (const [episodeIndex, episode] of searchEpisodes
      .slice(0, OBLIGATION_RETAINED_SOURCE_LIMIT)
      .entries()) {
      const row = sourceForSeq(episode.seq);
      let memberLocators: CoverageLocator[] = [];
      if (episode.seq < input.querySeq && !episode.removed && row !== null) {
        memberLocators = addSourceEvidence(row, "search", "search");
      }
      addBasisMember(
        "search",
        basisMember(episode.seq, row?.contentHash ?? canonicalHash(["search", episode.seq]), memberLocators, {
          key: sha256(subject),
          ordinal: episodeIndex,
        }),
      );
    }
    const searchSentinel = searchEpisodes[OBLIGATION_RETAINED_SOURCE_LIMIT];
    if (searchSentinel !== undefined) {
      const row = sourceForSeq(searchSentinel.seq);
      addBasisMember(
        "search",
        basisMember(
          searchSentinel.seq,
          row?.contentHash ?? canonicalHash(["search-sentinel", searchSentinel.seq]),
          [],
          {
            kind: "sentinel",
            key: sha256(subject),
            ordinal: OBLIGATION_RETAINED_SOURCE_LIMIT,
          },
        ),
      );
    }
  }
  routesRun.push(
    routeRun(
      "search",
      searchReturned,
      routeIssues.search
        ? "unresolved"
        : subject.length === 0
          ? "not-run"
          : searchReturned > OBLIGATION_SEARCH_ROUTE_LIMIT
            ? "unresolved"
            : searchReturned === 0
              ? "empty"
              : "complete",
    ),
  );

  const ordered = [...routes.values()].sort((a, b) => {
    const as = Number(a.source.slice(a.source.indexOf(":") + 1));
    const bs = Number(b.source.slice(b.source.indexOf(":") + 1));
    return as - bs || a.byteRange[0] - b.byteRange[0] || a.digest.localeCompare(b.digest);
  });
  const supported = ordered.filter((route) => route.status === "supported").length;
  const historical = ordered.filter((route) => route.status === "historical").length;
  const located = ordered.filter((route) => route.status !== "unresolved").length;
  const required = explicitCardinality(input.question);
  const unresolvedLocators = ordered.filter((route) => route.status === "unresolved").length;
  // An unresolved locator is already the receipt for one missing source; do
  // not count that same gap a second time as `required - supported`.
  const unresolved = Math.max(
    unresolvedLocators,
    required === undefined ? 0 : Math.max(0, required - supported),
  );
  const blockedRoute = routesRun.some((run) => ["unresolved", "ambiguous", "capped"].includes(run.status));
  const completeness =
    required === undefined
      ? "not-established"
      : located === supported &&
          supported === required &&
          historical === 0 &&
          unresolved === 0 &&
          !blockedRoute
        ? "complete"
        : "incomplete";
  const basisRoute = (origin: CoverageOrigin, outcome: CoverageRouteRun): CoverageBasisRoute => {
    const state = basisRoutes[origin];
    const finalDigestByBinding = new Map(
      ordered.map((locator) => [coverageLocatorBindingKey(locator), locator.digest]),
    );
    const members = state.members.map((member) => ({
      ...member,
      // A source can be found by names and search with different route labels,
      // while the top-level receipt deduplicates that binding. Re-point each
      // member at the digest of the retained locator, never an evicted route
      // variant.
      locatorDigests: member.locatorDigests
        .map((digest) => {
          const binding = basisLocatorBindings.get(digest);
          return binding === undefined ? digest : (finalDigestByBinding.get(binding) ?? digest);
        })
        .sort(),
    }));
    const body = {
      members,
      memberCount: state.memberCount,
      overflow: state.overflow,
      outcome,
    };
    return { ...body, membersDigest: canonicalHash(body) };
  };
  const namesRun = routesRun.find((run) => run.route === "names") as CoverageRouteRun;
  const pagesRun = routesRun.find((run) => run.route === "pages") as CoverageRouteRun;
  const searchRun = routesRun.find((run) => run.route === "search") as CoverageRouteRun;
  const basisBody = {
    version: 1 as const,
    queryContentHash: sha256(input.question),
    initialPagesDigest: canonicalHash(pages),
    locatorDigests: ordered.map((locator) => locator.digest).sort(),
    routeMembers: {
      names: basisRoute("names", namesRun),
      pages: basisRoute("pages", pagesRun),
      search: basisRoute("search", searchRun),
    },
  };
  const basis: CoverageBasis = { ...basisBody, digest: canonicalHash(basisBody) };
  const base = {
    cue,
    querySeq: input.querySeq,
    // `querySeq` is the archive snapshot at which this obligation was issued.
    // The asking turn itself is excluded from routes, but the receipt remains
    // bound to that turn so replay can distinguish two identical questions.
    asOfSeq: input.querySeq,
    routerVersion: input.routerVersion ?? COMPILER_VERSION,
    routesRun,
    ...(required === undefined ? {} : { required }),
    located,
    supported,
    historical,
    unresolved,
    completeness,
    routes: ordered,
    basis,
  } satisfies Omit<CoverageReceipt, "digest">;
  return { ...base, digest: canonicalHash(base) };
}

export function renderCoverage(receipt: CoverageReceipt): string {
  const ending =
    receipt.completeness === "not-established"
      ? "completeness not established"
      : receipt.completeness === "complete"
        ? "complete"
        : `incomplete · unresolved ${receipt.unresolved ?? 0}`;
  // Keep the receipt digest in the model-visible block. Counts are useful
  // prose, but this full digest is the packet anchor for the exact locator and
  // route set that produced them.
  return `⟨pylos coverage · located ${receipt.located} sources · supported ${receipt.supported} · historical ${receipt.historical} · ${ending} · digest ${receipt.digest}⟩`;
}
