/**
 * Chain verification (KERNEL §1, A5).
 *
 * `hash_i = sha256(hash_{i-1} ‖ cjson({v, seq, ts, role, model, provider,
 * content_hash, meta_hash}))`, `hash_0 = sha256("pylos:" + thread.id)`.
 *
 * Verification is incremental: a trusted checkpoint every 4,096 episodes means
 * the UI never waits on a full replay. Rows are consumed through SQLite's
 * row iterator, so a million-turn replay
 * never materializes even one fixed-size batch of episode bodies. `{full:
 * true}` replays from genesis and is what the tamper tests use.
 */

import type {
  AnswerReceipt,
  AttachmentManifest,
  ByteLocator,
  ClaimCandidate,
  ClaimClassification,
  ClaimScanOverflow,
  CoverageReceipt,
  EpisodeMeta,
  EvidenceLocator,
  PageRecord,
  Seq,
  Thread,
} from "@pylos/protocol";
import { CLAIM_CAPS, COVERAGE_CAPS, MAX_PACKET_JSON_BYTES, MAX_PACKET_RESPONSE_BYTES } from "@pylos/protocol";
import {
  type AddressRouteRow,
  type AddressSourceReplayCache,
  addressAliasFailure,
  addressInvalidationDigestOf,
  addressRouteDigestOf,
  addressWitnessFailure,
  canonicalAddressQuery,
  createAddressSourceReplayCache,
  parseAddressAliasRow,
  parseAddressRouteRow,
  parseAddressWitness,
} from "./address.ts";
import { ATTACHMENT_CHUNK_SIZE, manifestPartitionValid, readAttachmentRange } from "./attachment.ts";
import {
  answerReceiptDigestOf,
  CLAIM_GRAMMAR_VERSION,
  claimScanDigestOf,
  claimTextSupported,
  coverageBasisForCandidate,
  isMemoryQuestion,
  scanRememberedClaimsDetailed,
} from "./claim-gate.ts";
import { removalRecord } from "./forget.ts";
import { canonicalHash, chainHash, genesisHash, sha256 } from "./hash.ts";
import {
  collectionCue,
  collectionNameKeysDetailed,
  explicitCardinality,
  renderCoverage,
} from "./obligation.ts";
import { packetRoundsFailure, packetTokensFailure } from "./pure/budget.ts";
import { createReachabilityReplay } from "./reachability.ts";
import { ftsQuery } from "./rows.ts";
import { COUNTERS } from "./schema.ts";
import { CHECKPOINT_EVERY, chainRecord, metaHashOf, type Vault, VaultError } from "./vault.ts";

const ADDRESS_BATCH_SIZE = 512;
/** Route rows carry two bounded JSON payloads; keep their resident page below 4 MiB. */
const ADDRESS_ROUTE_BATCH_SIZE = 16;
const ADDRESS_ROUTE_CLOSURE_LIMIT = 256;
const PACKET_BATCH_SIZE = 64;

export interface VerifyResult {
  ok: boolean;
  headHash: string;
  /** The highest seq whose chain link was checked. */
  checkedTo: Seq;
  /** Where the replay started (a checkpoint, or 0 for a full replay). */
  checkedFrom: Seq;
  /** First seq that failed, if any. */
  failedAt?: Seq;
  reason?: string;
  /** True only when an authenticated partial bundle's internal chain verified. */
  fragmentVerified?: boolean;
  /** Authenticated boundary of a partial bundle; never a genesis-continuity claim. */
  fragment?: {
    originalThreadId: string;
    fromSeq: Seq;
    toSeq: Seq;
    prevHash: string;
    headHash: string;
  };
}

interface Row {
  seq: number;
  ts: number;
  role: string;
  model: string | null;
  provider: string | null;
  content: string;
  content_hash: string;
  prev_hash: string;
  hash: string;
  meta: string;
}

interface IntegrityIssue {
  seq?: Seq;
  reason: string;
}

interface RawEpisode {
  seq: number;
  role: string;
  content: string;
  content_hash: string;
  hash: string;
  meta: string;
}

interface ClaimCandidateRecord {
  span: [number, number];
  kind: string;
  text: string;
}

interface RawRoute extends Record<string, unknown> {
  rowid?: number;
}

interface RawAlias extends Record<string, unknown> {
  rowid?: number;
}

const CLAIM_CLASSES = new Set<ClaimClassification>([
  "SUPPORTED",
  "HISTORICAL",
  "PROPOSED",
  "INFERENCE",
  "UNKNOWN",
  "WORLD_KNOWLEDGE",
]);
const CURRENT_ADDRESS_AUTHORITIES = new Set(["user", "tool", "attachment"]);

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalHash(left) === canonicalHash(right);
  } catch {
    return false;
  }
}

function tableExists(vault: Vault, name: string): boolean {
  try {
    return (
      vault.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) !==
      null
    );
  } catch {
    // An imported pre-A14/A15 vault may not have sqlite_master rows for the
    // additive tables.  Chain verification remains useful in that case.
    return false;
  }
}

function roundsDigestOf(rounds: unknown, packetBudget: unknown): string | null {
  const list = Array.isArray(rounds) ? rounds : null;
  if (list === null) return null;
  for (const [index, round] of list.entries()) {
    const record = parseRecord(round);
    if (
      record === null ||
      record.ordinal !== index ||
      typeof record.messagesDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(record.messagesDigest) ||
      !Number.isSafeInteger(record.tokens) ||
      (record.tokens as number) < 0 ||
      !Number.isSafeInteger(record.budget) ||
      (record.budget as number) <= 0 ||
      packetTokensFailure(record.tokens, record.budget) !== null ||
      record.budget !== packetBudget ||
      !Array.isArray(record.pages) ||
      !Array.isArray(record.admittedPageSeqs) ||
      record.admittedPageSeqs.length > 4096 ||
      record.admittedPageSeqs.some(
        (seq, seqIndex, seqs) =>
          !Number.isSafeInteger(seq) || (seq as number) <= 0 || seqs.indexOf(seq) !== seqIndex,
      ) ||
      (record.status !== "done" && record.status !== "failed")
    ) {
      return null;
    }
  }
  try {
    return canonicalHash(list);
  } catch {
    return null;
  }
}

const RECOVERED_MARKER_RE = /⟦recovered #(\d+) ·/gu;

/**
 * Page sources named by a recovery marker in `text`, restricted to the sources
 * this round actually served. `matchAll` works on a copy of the pattern, so the
 * shared literal keeps no state between calls.
 */
function markedPageSeqs(text: string, served: ReadonlySet<number>): Set<number> {
  const marked = new Set<number>();
  for (const match of text.matchAll(RECOVERED_MARKER_RE)) {
    const seq = Number(match[1]);
    if (served.has(seq)) marked.add(seq);
  }
  return marked;
}

function roundPagesFailure(
  rounds: readonly unknown[],
  packet: { messages: readonly unknown[]; pages: readonly unknown[] },
  messagesRetained: boolean,
): string | null {
  const allPages: unknown[] = [];
  let firstPageSeqs: Set<number> | null = null;
  for (const rawRound of rounds) {
    const round = parseRecord(rawRound);
    if (round === null || !Array.isArray(round.pages) || !Array.isArray(round.admittedPageSeqs)) {
      return "request round pages are malformed";
    }
    const pageSeqs = new Set<number>();
    for (const rawPage of round.pages) {
      const page = parseRecord(rawPage);
      if (
        page === null ||
        typeof page.trigger !== "string" ||
        typeof page.resolved !== "boolean" ||
        !Array.isArray(page.seqs) ||
        page.seqs.some((seq) => !Number.isSafeInteger(seq) || (seq as number) <= 0)
      ) {
        return "request round page is malformed";
      }
      for (const seq of page.seqs as number[]) pageSeqs.add(seq);
      if (page.trigger === "sequence" && page.resolved === true && typeof page.query === "string") {
        const match = /^#(\d+)(?:[–-]#?(\d+))?$/u.exec(page.query);
        if (match === null) return "sequence page query is malformed";
        const from = Number(match[1]);
        const to = match[2] === undefined ? from : Number(match[2]);
        const firstSeq = (page.seqs as number[])[0];
        if (
          !Number.isSafeInteger(from) ||
          !Number.isSafeInteger(to) ||
          from <= 0 ||
          to < from ||
          firstSeq === undefined ||
          firstSeq < from ||
          firstSeq > to
        ) {
          return "sequence page source does not match its exact query input";
        }
      }
    }
    if ((round.admittedPageSeqs as unknown[]).some((seq) => !pageSeqs.has(seq as number))) {
      return "request round admitted page source is not in its page receipt";
    }
    firstPageSeqs ??= pageSeqs;
    allPages.push(...round.pages);
  }
  if (!sameCanonical(allPages, packet.pages)) {
    return "request round pages do not exactly match packet pages";
  }

  const first = parseRecord(rounds[0]);
  if (first === null || !Array.isArray(first.admittedPageSeqs) || firstPageSeqs === null) {
    return "initial request round page admission is malformed";
  }
  if (!messagesRetained || packet.messages.length === 0) return null;

  // A recovery marker belongs to the compiler only where the compiler writes
  // one. `assemble` puts every page insert of the initial request in a single
  // place — the packet's first message, the system header — and every other
  // retained message is episode text quoted verbatim, which may carry a marker
  // of its own: a tool result that quotes an earlier turn's recall, or a user
  // who typed `⟦recovered #7 ·` into the chat. Those are content, not
  // admissions. The writer admits a served source when its marker appears
  // anywhere in the request it sent, so the header is what this packet
  // certainly showed and the whole retained text is what it could have shown;
  // the receipt must lie between the two. Sources outside this round's own page
  // receipt count for neither bound — the check above already rejects those.
  const header = parseRecord(packet.messages[0]);
  if (header === null || header.role !== "system" || typeof header.content !== "string") {
    return "packet header message is malformed";
  }
  const admitted = new Set(first.admittedPageSeqs as number[]);
  for (const seq of markedPageSeqs(header.content, firstPageSeqs)) {
    if (!admitted.has(seq)) {
      return "initial request round page insert is missing from its admitted page sources";
    }
  }
  const retainedText = packet.messages
    .map((message) => parseRecord(message)?.content)
    .filter((content): content is string => typeof content === "string")
    .join("\n");
  const shown = markedPageSeqs(retainedText, firstPageSeqs);
  for (const seq of admitted) {
    if (!shown.has(seq)) {
      return "initial request round admitted page sources changed in retained provider messages";
    }
  }
  return null;
}

function coverageDigestOf(coverage: unknown): string | null {
  const record = parseRecord(coverage);
  if (record === null || typeof record.digest !== "string") return null;
  const { digest: _digest, ...body } = record;
  try {
    return canonicalHash(body);
  } catch {
    return null;
  }
}

const COVERAGE_ATOM_EVIDENCE_LIMIT = COVERAGE_CAPS.atomEvidence;
const COVERAGE_SEARCH_ROUTE_LIMIT = COVERAGE_CAPS.searchRoute;
const COVERAGE_NAME_ROUTE_LIMIT = COVERAGE_CAPS.nameRoute;
const COVERAGE_RETAINED_SOURCE_LIMIT = COVERAGE_CAPS.retainedSources;
const COVERAGE_ATTACHMENT_SPAN_LIMIT = COVERAGE_CAPS.attachmentSpans;
const COVERAGE_SOURCE_META_LIMIT = 64 * 1024;
const COVERAGE_REPLAY_WORK_BYTES = COVERAGE_CAPS.candidateWorkBytes;
const COVERAGE_ATOM_ROW_WORK_BYTES = 4 * 1024;
const COVERAGE_CUE_RE = /\b(all|every|compare|list|each)\b/giu;
const COVERAGE_CARDINAL_RE =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/giu;
const COVERAGE_LOCATOR_AUTHORITIES = new Set(["user", "tool", "attachment", "assistant", "model"]);
const COVERAGE_LOCATOR_STATUSES = new Set(["supported", "historical", "proposed", "unresolved"]);
const COVERAGE_LOCATOR_ROUTES = new Set([
  "sequence",
  "ledger",
  "historical",
  "search",
  "address",
  "invalidation",
  "semantic",
  "semantic-unavailable",
  "attachment-tail",
  "recent-overflow",
  "path",
  "model",
  "explicit",
  "check",
  "fault",
  "resident",
  "frontier",
]);
const COVERAGE_BASIS_MEMBER_LIMITS = {
  names: COVERAGE_RETAINED_SOURCE_LIMIT * (COVERAGE_NAME_ROUTE_LIMIT + 1) + 1,
  pages: COVERAGE_RETAINED_SOURCE_LIMIT + 1,
  search: COVERAGE_RETAINED_SOURCE_LIMIT + 1,
} as const;
const COVERAGE_BASIS_OUTCOMES = new Set(["supported", "historical", "proposed", "unresolved", "no-locator"]);
const COVERAGE_BASIS_MEMBER_KINDS = new Set(["candidate", "sentinel"]);
const COVERAGE_BASIS_MEMBER_LOCATOR_LIMIT = COVERAGE_ATOM_EVIDENCE_LIMIT + 1;
const COVERAGE_BASIS_TEXT_LIMIT = 256;

interface CoverageReplayAtomRow {
  id: string;
  key: string;
  value: string;
  source_span: string | null;
  valid_from_seq: number;
  valid_to_seq: number | null;
  phase: string;
  authority: string;
  key_bytes: number;
  value_bytes: number;
  source_span_bytes: number;
}

interface CoverageReplaySource {
  row: RawEpisode;
  meta: Record<string, unknown>;
  contentBytes: number;
  removalSeq: number | null;
  removedAfterQuery: boolean;
  atoms: CoverageReplayAtomRow[];
  atomOverflow: boolean;
  workOverflow: boolean;
  content?: string;
}

interface CoverageReplayContext {
  querySeq: Seq;
  workBytes: number;
  overflowed: boolean;
  sources: Map<number, CoverageReplaySource | string>;
}

function coverageBasisMemberFailure(value: unknown, limit: number): string | null {
  const member = parseRecord(value);
  if (member === null) return "coverage basis member is malformed";
  const allowed = new Set([
    "kind",
    "sourceSeq",
    "contentHash",
    "outcome",
    "locatorDigests",
    "atomId",
    "key",
    "ordinal",
  ]);
  if (Object.keys(member).some((key) => !allowed.has(key))) return "coverage basis member has unknown fields";
  if (
    typeof member.kind !== "string" ||
    !COVERAGE_BASIS_MEMBER_KINDS.has(member.kind) ||
    typeof member.sourceSeq !== "number" ||
    !Number.isSafeInteger(member.sourceSeq) ||
    member.sourceSeq < 0 ||
    typeof member.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(member.contentHash) ||
    typeof member.outcome !== "string" ||
    !COVERAGE_BASIS_OUTCOMES.has(member.outcome) ||
    !Array.isArray(member.locatorDigests) ||
    member.locatorDigests.length > Math.min(limit, COVERAGE_BASIS_MEMBER_LOCATOR_LIMIT)
  ) {
    return "coverage basis member shape is malformed";
  }
  const digests = member.locatorDigests;
  let previous = "";
  const seen = new Set<string>();
  for (const digest of digests) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
      return "coverage basis member locator digest is malformed";
    }
    if (seen.has(digest) || (previous.length > 0 && digest < previous)) {
      return "coverage basis member locator digests are not deterministic";
    }
    seen.add(digest);
    previous = digest;
  }
  if (
    member.atomId !== undefined &&
    (typeof member.atomId !== "string" ||
      member.atomId.length === 0 ||
      member.atomId.length > COVERAGE_BASIS_TEXT_LIMIT)
  ) {
    return "coverage basis member atom id is malformed";
  }
  if (
    member.key !== undefined &&
    (typeof member.key !== "string" ||
      member.key.length === 0 ||
      member.key.length > COVERAGE_BASIS_TEXT_LIMIT)
  ) {
    return "coverage basis member key is malformed";
  }
  if (
    member.ordinal !== undefined &&
    (typeof member.ordinal !== "number" || !Number.isSafeInteger(member.ordinal) || member.ordinal < 0)
  ) {
    return "coverage basis member ordinal is malformed";
  }
  return null;
}

function coverageBasisRouteFailure(
  value: unknown,
  route: string,
  expectedRun: Record<string, unknown>,
): string | null {
  const record = parseRecord(value);
  if (record === null) return "coverage basis route is malformed";
  const allowed = new Set(["members", "memberCount", "overflow", "outcome", "membersDigest"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return "coverage basis route has unknown fields";
  const limit = COVERAGE_BASIS_MEMBER_LIMITS[route as keyof typeof COVERAGE_BASIS_MEMBER_LIMITS];
  if (limit === undefined || !Array.isArray(record.members) || record.members.length > limit) {
    return "coverage basis route members are malformed";
  }
  if (
    typeof record.memberCount !== "number" ||
    !Number.isSafeInteger(record.memberCount) ||
    record.memberCount < record.members.length ||
    record.memberCount > limit + 1 ||
    typeof record.overflow !== "boolean" ||
    (record.overflow && record.members.length !== limit) ||
    (!record.overflow && record.memberCount !== record.members.length) ||
    typeof record.membersDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.membersDigest)
  ) {
    return "coverage basis route shape is malformed";
  }
  if (!sameCanonical(record.outcome, expectedRun)) return "coverage basis route outcome is not bound";
  const allLocatorDigests = new Set<string>();
  for (const member of record.members) {
    const failure = coverageBasisMemberFailure(member, limit);
    if (failure !== null) return failure;
    const memberRecord = parseRecord(member);
    if (memberRecord !== null && Array.isArray(memberRecord.locatorDigests)) {
      for (const digest of memberRecord.locatorDigests) allLocatorDigests.add(String(digest));
    }
  }
  if (allLocatorDigests.size > COVERAGE_RETAINED_SOURCE_LIMIT) {
    return "coverage basis route locator digests exceed the receipt bound";
  }
  const { membersDigest: _membersDigest, ...body } = record;
  if (canonicalHash(body) !== record.membersDigest) return "coverage basis route digest mismatch";
  return null;
}

function coverageBasisFailureShape(
  value: unknown,
  routesRun: readonly unknown[],
  routes: readonly unknown[],
  queryContentHash: string,
  initialPages: readonly PageRecord[],
): string | null {
  const record = parseRecord(value);
  if (record === null) return "coverage basis is malformed";
  const allowed = [
    "version",
    "queryContentHash",
    "initialPagesDigest",
    "locatorDigests",
    "routeMembers",
    "digest",
  ];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return "coverage basis has unknown fields";
  if (
    record.version !== 1 ||
    record.queryContentHash !== queryContentHash ||
    typeof record.initialPagesDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.initialPagesDigest) ||
    record.initialPagesDigest !== canonicalHash(initialPages) ||
    !Array.isArray(record.locatorDigests) ||
    record.locatorDigests.length > COVERAGE_RETAINED_SOURCE_LIMIT ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest)
  ) {
    return "coverage basis anchors are malformed";
  }
  const locatorDigests = record.locatorDigests;
  const sortedLocatorDigests = [...locatorDigests].sort();
  if (
    sortedLocatorDigests.some(
      (digest, index) =>
        typeof digest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(digest) ||
        (index > 0 && digest === sortedLocatorDigests[index - 1]),
    ) ||
    !sameCanonical(locatorDigests, sortedLocatorDigests) ||
    !sameCanonical(locatorDigests, (routes as unknown[]).map((route) => parseRecord(route)?.digest).sort())
  ) {
    return "coverage locator source or coverage route basis digests are not bound";
  }
  const routeMembers = parseRecord(record.routeMembers);
  if (
    routeMembers === null ||
    Object.keys(routeMembers).some((key) => !["names", "pages", "search"].includes(key))
  ) {
    return "coverage basis route members are malformed";
  }
  const expectedRuns = new Map<string, Record<string, unknown>>();
  for (const run of routesRun) {
    const item = parseRecord(run);
    if (item?.route !== undefined && typeof item.route === "string") expectedRuns.set(item.route, item);
  }
  for (const route of ["names", "pages", "search"] as const) {
    const expectedRun = expectedRuns.get(route);
    if (expectedRun === undefined) return "coverage basis route outcome is missing";
    const failure = coverageBasisRouteFailure(routeMembers[route], route, expectedRun);
    if (failure !== null) return failure;
  }
  const memberLocatorDigests = new Set<string>();
  for (const route of ["names", "pages", "search"] as const) {
    const routeRecord = parseRecord(routeMembers[route]);
    if (routeRecord === null || !Array.isArray(routeRecord.members)) {
      return "coverage basis route members are malformed";
    }
    for (const member of routeRecord.members) {
      const memberRecord = parseRecord(member);
      if (memberRecord === null || !Array.isArray(memberRecord.locatorDigests)) {
        return "coverage basis member locators are malformed";
      }
      for (const digest of memberRecord.locatorDigests) memberLocatorDigests.add(String(digest));
    }
  }
  const topLocatorDigests = new Set(locatorDigests.map(String));
  if (
    memberLocatorDigests.size !== topLocatorDigests.size ||
    [...memberLocatorDigests].some((digest) => !topLocatorDigests.has(digest))
  ) {
    return "coverage route locator set or basis membership is not exact";
  }
  const { digest: _digest, ...body } = record;
  if (canonicalHash(body) !== record.digest) return "coverage basis digest mismatch";
  return null;
}

function coverageBindingFailure(
  vault: Vault,
  threadId: string,
  coverage: unknown,
  expected: string,
  turnSeq?: Seq,
  pages?: readonly PageRecord[],
): string | null {
  const record = parseRecord(coverage);
  if (record === null || typeof record.digest !== "string") return "coverage receipt is malformed";
  if (
    turnSeq !== undefined &&
    (record.querySeq !== turnSeq || record.asOfSeq !== turnSeq || !Array.isArray(record.routes))
  ) {
    return "coverage receipt turn binding mismatch";
  }
  const routeFailure = coverageRoutesFailure(vault, threadId, coverage, turnSeq, pages);
  if (routeFailure !== null) return routeFailure;
  const recomputed = coverageDigestOf(record);
  return recomputed === expected && record.digest === expected ? null : "coverage receipt digest mismatch";
}

function coverageAuthorityForRole(role: string): string | null {
  if (role === "user") return "user";
  if (role === "tool") return "tool";
  if (role === "attachment") return "attachment";
  if (role === "assistant") return "assistant";
  // System/removal/handoff rows are kernel narration, not evidence sources.
  // They must never inherit user authority through a default branch.
  return null;
}

function coverageStatusForRole(role: string): string {
  return role === "assistant" ? "proposed" : "supported";
}

function coverageAtomStatus(phase: string, authority: string): string | null {
  if (phase === "REVOKED") return null;
  if (phase === "HISTORICAL" && authority === "user") return "historical";
  if (phase === "SUPPORTED" && authority === "user") return "supported";
  return "proposed";
}

/** Status of an atom at the receipt's immutable query snapshot. */
function coverageAtomStatusAt(
  atom: { phase: string; authority: string; valid_from_seq: number; valid_to_seq: number | null },
  querySeq: Seq,
): string | null {
  if (!Number.isSafeInteger(atom.valid_from_seq) || atom.valid_from_seq > querySeq) return null;
  if (atom.valid_to_seq !== null && atom.valid_to_seq <= querySeq) {
    return atom.phase === "HISTORICAL" && atom.authority === "user" ? "historical" : "proposed";
  }
  // Supersession records the closing sequence but leaves the immutable row in
  // phase HISTORICAL.  Before that sequence the atom was still current.
  if (atom.phase === "HISTORICAL") return atom.authority === "user" ? "supported" : "proposed";
  // Forget revokes without a validity close.  If the source survived until the
  // asking snapshot, a revoked row is the last retained witness of its former
  // current state; later deletion is handled by the source as-of check.
  if (atom.phase === "REVOKED") return atom.authority === "user" ? "supported" : "proposed";
  return coverageAtomStatus(atom.phase, atom.authority);
}

function sourceRemovalSeq(vault: Vault, threadId: string, meta: Record<string, unknown>): number | null {
  if (meta.removed !== true || typeof meta.tombstone !== "string") return null;
  const row = vault.db
    .query("SELECT removal_seq FROM tombstone WHERE id = ? AND thread_id = ?")
    .get(meta.tombstone, threadId) as { removal_seq: number | null } | null;
  if (
    row === null ||
    row.removal_seq === null ||
    !Number.isSafeInteger(row.removal_seq) ||
    row.removal_seq <= 0
  ) {
    return null;
  }
  return row.removal_seq;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Keep verifier replay byte-for-byte aligned with the collection router's lexical subject. */
function coverageCollectionSubject(question: string): string {
  const beforeList = question.split(":", 1)[0] ?? question;
  return beforeList
    .normalize("NFKC")
    .replace(COVERAGE_CUE_RE, " ")
    .replace(/\b\d{1,9}\b/gu, " ")
    .replace(COVERAGE_CARDINAL_RE, " ")
    .replace(/\b(?:in|of)\s+the\s+(?:archive|conversation|thread)\b/giu, " ")
    .replace(/\b(?:of|the|items?|notes?|records?|turns?|sources?|places?)\b/giu, " ")
    .replace(/[?!.,;]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

interface CoverageSearchReplay {
  subject: string;
  returned: number;
  /** Raw bounded FTS rows, including non-evidence rows that affect returned. */
  allSeqs: number[];
  evidenceSeqs: Set<number>;
}

/**
 * Re-run the exact bounded lexical route at the asking-turn snapshot.  The
 * stored locator is only an address; membership in the kernel's FTS result is
 * what binds it to this question.  A strict `seq < querySeq` predicate is
 * essential: later matching turns must not crowd an earlier receipt's LIMIT.
 */
function coverageSearchReplay(
  vault: Vault,
  threadId: string,
  querySeq: Seq,
): CoverageSearchReplay | { failure: string } {
  const question = vault.db
    .query("SELECT content FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, querySeq) as { content: string } | null;
  if (question === null) return { failure: "coverage asking episode is missing" };
  const subject = coverageCollectionSubject(question.content);
  const match = subject.length === 0 ? null : ftsQuery(subject, "and");
  if (match === null) return { subject, returned: 0, allSeqs: [], evidenceSeqs: new Set() };
  let rows: Array<{ seq: number; meta: string; role: string }>;
  try {
    rows = vault.db
      .query(
        "SELECT e.seq, e.meta, e.role FROM episode_fts f JOIN episode e ON e.rowid = f.rowid " +
          "WHERE episode_fts MATCH ? AND e.thread_id = ? AND e.seq < ? " +
          "ORDER BY bm25(episode_fts) ASC, e.seq DESC LIMIT ?",
      )
      .all(match, threadId, querySeq, COVERAGE_SEARCH_ROUTE_LIMIT + 1) as Array<{
      seq: number;
      meta: string;
      role: string;
    }>;
  } catch {
    return { failure: "coverage search route replay failed" };
  }
  const evidenceSeqs = new Set<number>();
  const allSeqs = rows.map((row) => row.seq);
  for (const row of rows.slice(0, COVERAGE_SEARCH_ROUTE_LIMIT)) {
    const meta = parseRecord(row.meta);
    if (meta?.removed === true) continue;
    if (coverageAuthorityForRole(row.role) !== null) evidenceSeqs.add(row.seq);
  }
  return { subject, returned: rows.length, allSeqs, evidenceSeqs };
}

function coverageSearchRouteFailure(
  vault: Vault,
  threadId: string,
  querySeq: Seq,
  locator: Record<string, unknown>,
  replay: CoverageSearchReplay | { failure: string },
): string | null {
  if (locator.route !== "search") return null;
  const sourceMatch = /^episode:(\d+)$/u.exec(String(locator.source));
  if (sourceMatch === null) return "coverage search route source is invalid";
  const sourceSeq = Number(sourceMatch[1]);
  const source = vault.db
    .query("SELECT meta FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, sourceSeq) as { meta: string } | null;
  if (source === null) return "coverage search route source is missing";
  const sourceMeta = parseRecord(source.meta);
  if (sourceMeta === null) return "coverage search route source metadata is malformed";
  const removalSeq = sourceRemovalSeq(vault, threadId, sourceMeta);
  // The original FTS bytes are intentionally removed after a user forget. A
  // receipt issued before that deletion is authenticated by the immutable
  // source/revision checks in coverageLocatorFailure; do not replay the
  // tombstone text as if it were the old search index.
  if (sourceMeta.removed === true && removalSeq !== null && removalSeq > querySeq) return null;
  if ("failure" in replay) return replay.failure;
  if (!replay.evidenceSeqs.has(sourceSeq)) {
    return "coverage search route source was not returned at query snapshot";
  }
  return null;
}

interface CoverageNameReplay {
  returned: number;
  /** Raw accepted atom rows in key/SQL order, before locator de-duplication. */
  atoms: Array<{ id: string; sourceSeq: number; key: string; ordinal: number }>;
  atomIds: Set<string>;
  sourceByAtomId: Map<string, number>;
  overflowed: boolean;
  keys: string[];
  keyOverflow: boolean;
}

function coverageNameReplay(
  vault: Vault,
  threadId: string,
  question: string,
  querySeq: Seq,
): CoverageNameReplay | { failure: string } {
  const atomIds = new Set<string>();
  const sourceByAtomId = new Map<string, number>();
  const atoms: Array<{ id: string; sourceSeq: number; key: string; ordinal: number }> = [];
  const keyResult = collectionNameKeysDetailed(question);
  const keys = keyResult.keys;
  let returned = 0;
  let overflowed = keyResult.overflow;
  for (const name of keys) {
    let rows: Array<{ id: string; source_seq: number; phase: string }>;
    try {
      rows = vault.db
        .query(
          "SELECT a.id, a.source_seq, a.phase FROM atom_name n JOIN atom a ON a.id = n.atom_id " +
            "WHERE n.thread_id = ? AND n.name = ? " +
            "AND a.valid_from_seq < ? AND a.source_seq < ? " +
            "ORDER BY (a.authority = 'user' AND a.valid_from_seq < ? AND " +
            "(a.valid_to_seq IS NULL OR a.valid_to_seq > ?)) DESC, a.valid_from_seq DESC LIMIT ?",
        )
        .all(threadId, name, querySeq, querySeq, querySeq, querySeq, 17) as Array<{
        id: string;
        source_seq: number;
        phase: string;
      }>;
    } catch {
      return { failure: "coverage name route replay failed" };
    }
    let acceptedRows = 0;
    for (const row of rows) {
      if (row.phase === "REVOKED") {
        const source = vault.db
          .query("SELECT meta FROM episode WHERE thread_id = ? AND seq = ?")
          .get(threadId, row.source_seq) as { meta: string } | null;
        const meta = source === null ? null : parseRecord(source.meta);
        if (meta?.removed !== true || (sourceRemovalSeq(vault, threadId, meta) ?? 0) <= querySeq) {
          continue;
        }
      }
      acceptedRows += 1;
      if (acceptedRows <= COVERAGE_NAME_ROUTE_LIMIT + 1) {
        atoms.push({ id: row.id, sourceSeq: row.source_seq, key: name, ordinal: acceptedRows - 1 });
      }
      if (acceptedRows <= COVERAGE_NAME_ROUTE_LIMIT) {
        atomIds.add(row.id);
        sourceByAtomId.set(row.id, row.source_seq);
      }
    }
    returned += acceptedRows;
    if (acceptedRows > COVERAGE_NAME_ROUTE_LIMIT) overflowed = true;
  }
  return { returned, atoms, atomIds, sourceByAtomId, overflowed, keys, keyOverflow: keyResult.overflow };
}

interface CoverageExpectedBinding {
  byteRange: [number, number];
  revision: string;
  status: string;
}

function reserveCoverageReplayWork(context: CoverageReplayContext, bytes: number): boolean {
  if (
    context.overflowed ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > COVERAGE_REPLAY_WORK_BYTES - context.workBytes
  ) {
    context.overflowed = true;
    return false;
  }
  context.workBytes += bytes;
  return true;
}

function coverageReplaySource(
  vault: Vault,
  threadId: string,
  sourceSeq: number,
  context: CoverageReplayContext,
): CoverageReplaySource | string {
  const cached = context.sources.get(sourceSeq);
  if (cached !== undefined) return cached;
  const scalar = vault.db
    .query(
      "SELECT seq, role, content_hash, hash, " +
        "length(CAST(content AS BLOB)) AS content_bytes, " +
        "length(CAST(meta AS BLOB)) AS meta_bytes, substr(meta, 1, ?) AS meta " +
        "FROM episode WHERE thread_id = ? AND seq = ?",
    )
    .get(COVERAGE_SOURCE_META_LIMIT + 1, threadId, sourceSeq) as {
    seq: number;
    role: string;
    content_hash: string;
    hash: string;
    content_bytes: number;
    meta_bytes: number;
    meta: string;
  } | null;
  if (scalar === null) {
    context.sources.set(sourceSeq, "coverage replay source is missing");
    return "coverage replay source is missing";
  }
  if (
    !Number.isSafeInteger(scalar.content_bytes) ||
    scalar.content_bytes < 0 ||
    !Number.isSafeInteger(scalar.meta_bytes) ||
    scalar.meta_bytes < 0 ||
    scalar.meta_bytes > COVERAGE_SOURCE_META_LIMIT
  ) {
    context.sources.set(sourceSeq, "coverage replay source scalar projection is malformed or oversized");
    return "coverage replay source scalar projection is malformed or oversized";
  }
  const meta = parseRecord(scalar.meta);
  if (meta === null) {
    context.sources.set(sourceSeq, "coverage replay source metadata is malformed");
    return "coverage replay source metadata is malformed";
  }
  let workOverflow = false;
  // Fetch one bounded extra row through the source index.  This replaces the
  // correlated COUNT(*) projection: a dense imported source is never counted
  // or materialized beyond the cap, and the extra row is the explicit overflow
  // receipt state.
  const projectedAtoms = vault.db
    .query(
      "SELECT id, substr(key, 1, 512) AS key, substr(value, 1, 2048) AS value, " +
        "substr(source_span, 1, 256) AS source_span, valid_from_seq, valid_to_seq, phase, authority, " +
        "length(CAST(key AS BLOB)) AS key_bytes, length(CAST(value AS BLOB)) AS value_bytes, " +
        "length(CAST(source_span AS BLOB)) AS source_span_bytes " +
        "FROM atom WHERE thread_id = ? AND source_seq = ? ORDER BY valid_from_seq, id LIMIT ?",
    )
    .all(threadId, sourceSeq, COVERAGE_ATOM_EVIDENCE_LIMIT + 1) as CoverageReplayAtomRow[];
  let atomOverflow = projectedAtoms.length > COVERAGE_ATOM_EVIDENCE_LIMIT;
  if (!reserveCoverageReplayWork(context, projectedAtoms.length * COVERAGE_ATOM_ROW_WORK_BYTES)) {
    workOverflow = true;
    atomOverflow = true;
  }
  const atoms = atomOverflow ? [] : projectedAtoms.slice(0, COVERAGE_ATOM_EVIDENCE_LIMIT);
  if (
    atoms.some(
      (atom) =>
        !Number.isSafeInteger(atom.key_bytes) ||
        !Number.isSafeInteger(atom.value_bytes) ||
        !Number.isSafeInteger(atom.source_span_bytes) ||
        atom.key_bytes > 512 ||
        atom.value_bytes > 2048 ||
        atom.source_span_bytes > 256,
    )
  ) {
    context.sources.set(sourceSeq, "coverage replay atom projection is malformed or oversized");
    return "coverage replay atom projection is malformed or oversized";
  }
  let content: string | undefined;
  if (scalar.role === "attachment") {
    const manifest = parseRecord(meta.manifest);
    const spanWork = Array.isArray(manifest?.spans)
      ? Math.min(COVERAGE_ATTACHMENT_SPAN_LIMIT + 1, manifest.spans.length) * 256
      : 0;
    if (!reserveCoverageReplayWork(context, scalar.content_bytes + spanWork)) {
      workOverflow = true;
    } else {
      const contentRow = vault.db
        .query("SELECT content FROM episode WHERE thread_id = ? AND seq = ?")
        .get(threadId, sourceSeq) as { content: string } | null;
      if (
        contentRow === null ||
        new TextEncoder().encode(contentRow.content).byteLength !== scalar.content_bytes
      ) {
        context.sources.set(sourceSeq, "coverage replay attachment content projection changed");
        return "coverage replay attachment content projection changed";
      }
      content = contentRow.content;
    }
  }
  const removalSeq = sourceRemovalSeq(vault, threadId, meta);
  const source: CoverageReplaySource = {
    row: {
      seq: scalar.seq,
      role: scalar.role,
      content: content ?? "",
      content_hash: scalar.content_hash,
      hash: scalar.hash,
      meta: scalar.meta,
    },
    meta,
    contentBytes: scalar.content_bytes,
    removalSeq,
    removedAfterQuery: meta.removed === true && removalSeq !== null && removalSeq > context.querySeq,
    atoms,
    atomOverflow,
    workOverflow,
    ...(content === undefined ? {} : { content }),
  };
  context.sources.set(sourceSeq, source);
  return source;
}

function coverageAtomByteRangeProjected(
  vault: Vault,
  threadId: string,
  sourceSeq: number,
  contentBytes: number,
  value: string,
  sourceSpan: [number, number] | undefined,
): [number, number] {
  const startChar = Math.max(0, sourceSpan?.[0] ?? 0);
  const endChar = Math.max(startChar, sourceSpan?.[1] ?? startChar + value.length);
  if (sourceSpan !== undefined && endChar > startChar) {
    const match = vault.db
      .query(
        "SELECT instr(substr(content, ?, ?), ?) AS position FROM episode WHERE thread_id = ? AND seq = ?",
      )
      .get(startChar + 1, endChar - startChar, value, threadId, sourceSeq) as {
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
        .get(fromChar, toChar, threadId, sourceSeq) as {
        from_bytes: number | null;
        to_bytes: number | null;
      } | null;
      if (
        Number.isSafeInteger(bytes?.from_bytes) &&
        Number.isSafeInteger(bytes?.to_bytes) &&
        (bytes?.to_bytes as number) > (bytes?.from_bytes as number)
      ) {
        return [bytes?.from_bytes as number, bytes?.to_bytes as number];
      }
    }
  }
  return [0, contentBytes];
}

function coverageAttachmentIsUnresolved(
  vault: Vault,
  threadId: string,
  source: CoverageReplaySource,
): boolean {
  const rawManifest = source.meta.manifest;
  if (
    rawManifest === null ||
    typeof rawManifest !== "object" ||
    Array.isArray(rawManifest) ||
    typeof source.meta.blob !== "string" ||
    source.content === undefined
  ) {
    return true;
  }
  const manifest = rawManifest as AttachmentManifest;
  if (manifest.hash !== source.meta.blob || !manifestPartitionValid(manifest)) return true;
  const indexed = manifest.spans.filter((span) => span.state === "indexed");
  if (indexed.length === 0 || indexed.length > COVERAGE_ATTACHMENT_SPAN_LIMIT) return true;
  const first = indexed[0];
  if (first === undefined) return true;
  let indexedPrefixEnd = 0;
  let indexedEnded = false;
  for (const span of manifest.spans) {
    if (span.state === "indexed") {
      if (indexedEnded || span.from !== indexedPrefixEnd) return true;
      indexedPrefixEnd = span.to;
    } else {
      indexedEnded = true;
    }
  }
  const read = readAttachmentRange(vault, threadId, source.row.seq, [first.from, first.to], {
    requireIndexed: true,
  });
  if (read === null || read.opaque) return true;
  const inlineBytes = new TextEncoder().encode(source.content);
  // The indexed episode text must be exactly the proven prefix.  A matching
  // first span followed by extra inline bytes is still an unbacked witness
  // (the prefix-only attachment oracle); do not let the suffix become a
  // remembered fact merely because it was appended to the FTS text.
  if (inlineBytes.byteLength !== indexedPrefixEnd) return true;
  if (!bytesEqual(read.bytes, inlineBytes.slice(first.from, first.to))) return true;
  for (const span of indexed.slice(1)) {
    const spanRead = readAttachmentRange(vault, threadId, source.row.seq, [span.from, span.to], {
      requireIndexed: true,
    });
    if (spanRead === null || spanRead.opaque) return true;
    if (!bytesEqual(spanRead.bytes, inlineBytes.slice(span.from, span.to))) return true;
  }
  return false;
}

/** Reconstruct the exact per-source binding set emitted by atomEvidenceForSource. */
function coverageExpectedBindingsForSource(
  vault: Vault,
  threadId: string,
  querySeq: Seq,
  source: CoverageReplaySource,
  restrictAtomIds?: ReadonlySet<string>,
): CoverageExpectedBinding[] | null {
  const row = source.row;
  const sourceSeq = row.seq;
  if (row.role === "attachment") return null;
  if (coverageAuthorityForRole(row.role) === null) return [];
  if (source.atomOverflow) {
    return [
      {
        byteRange: [0, source.contentBytes],
        revision: `atom-cap:${canonicalHash([sourceSeq, row.content_hash, COVERAGE_ATOM_EVIDENCE_LIMIT])}`,
        status: "unresolved",
      },
    ];
  }
  const active = source.atoms.filter((atom) => {
    if (restrictAtomIds !== undefined && !restrictAtomIds.has(atom.id)) return false;
    return coverageAtomStatusAt(atom, querySeq) !== null;
  });
  if (active.length === 0) {
    return [
      {
        byteRange: [0, source.contentBytes],
        revision: `episode:${sourceSeq}:${row.content_hash}`,
        status: coverageStatusForRole(row.role),
      },
    ];
  }
  return active.map((atom) => {
    const byteRange = coverageAtomByteRangeProjected(
      vault,
      threadId,
      sourceSeq,
      source.contentBytes,
      atom.value,
      coverageSourceSpan(atom.source_span),
    );
    return {
      byteRange,
      revision: canonicalHash({
        contentHash: row.content_hash,
        key: atom.key,
        value: atom.value,
        byteRange,
        validFromSeq: atom.valid_from_seq,
        validToSeq: atom.valid_to_seq !== null && atom.valid_to_seq > querySeq ? null : atom.valid_to_seq,
      }),
      status: coverageAtomStatusAt(atom, querySeq) as string,
    };
  });
}

/**
 * If the packet contains a page for a non-lexical route, the locator must
 * point into that page's kernel-selected sequence set.  Missing page records
 * are tolerated for imported pre-A13 packets; present records are never a
 * license to substitute an unrelated source.
 */
function coveragePageRouteFailure(
  querySeq: Seq,
  locator: Record<string, unknown>,
  pages: readonly PageRecord[] | undefined,
): string | null {
  if (
    pages === undefined ||
    locator.route === "search" ||
    locator.route === "frontier" ||
    locator.route === "resident"
  ) {
    return null;
  }
  const sourceMatch = /^episode:(\d+)$/u.exec(String(locator.source));
  if (sourceMatch === null) return "coverage page route source is invalid";
  const sourceSeq = Number(sourceMatch[1]);
  if (!Number.isSafeInteger(sourceSeq) || sourceSeq >= querySeq)
    return "coverage page route source is out of scope";
  const matchingPages = pages.filter((page) => page.trigger === locator.route);
  if (matchingPages.length === 0) return null;
  return matchingPages.some((page) => page.resolved && page.seqs.includes(sourceSeq))
    ? null
    : "coverage locator source was not returned by its packet page";
}

const COVERAGE_ATTACHMENT_UNRESOLVED_REASONS = new Set([
  "manifest",
  "partition",
  "opaque",
  "bytes",
  "inline",
  "span-cap",
]);

function coverageAttachmentUnresolvedFailure(
  vault: Vault,
  threadId: string,
  seq: Seq,
  row: RawEpisode,
  meta: Record<string, unknown>,
  locator: Record<string, unknown>,
  historical = false,
  workOverflow = false,
): string | null {
  if (locator.status !== "unresolved") return "coverage attachment unresolved status is malformed";
  const revision = String(locator.revision);
  const parts = revision.split(":");
  if (
    parts.length !== 4 ||
    parts[0] !== "attachment-unresolved" ||
    typeof parts[1] !== "string" ||
    typeof parts[2] !== "string" ||
    typeof parts[3] !== "string" ||
    (!/^[0-9a-f]{64}$/u.test(parts[2]) && parts[2] !== "missing") ||
    !COVERAGE_ATTACHMENT_UNRESOLVED_REASONS.has(parts[3])
  ) {
    return "coverage attachment unresolved revision is malformed";
  }
  const rawManifest = meta.manifest;
  const manifestObject =
    rawManifest !== null && typeof rawManifest === "object" && !Array.isArray(rawManifest)
      ? (rawManifest as Partial<AttachmentManifest>)
      : null;
  const manifestId = typeof manifestObject?.id === "string" ? manifestObject.id : "missing";
  const manifestDigest = typeof manifestObject?.digest === "string" ? manifestObject.digest : "missing";
  const manifestMatchesBlob =
    manifestObject !== null &&
    typeof manifestObject.hash === "string" &&
    typeof meta.blob === "string" &&
    manifestObject.hash === meta.blob;
  let structurallyValid = false;
  try {
    structurallyValid =
      manifestObject !== null && manifestPartitionValid(manifestObject as AttachmentManifest);
  } catch {
    structurallyValid = false;
  }
  const expectedReason =
    manifestObject === null || !manifestMatchesBlob
      ? "manifest"
      : !structurallyValid
        ? "partition"
        : parts[3];
  if (parts[1] !== manifestId || parts[2] !== manifestDigest || parts[3] !== expectedReason) {
    return "coverage attachment unresolved manifest binding changed";
  }
  const range = locator.byteRange as [number, number];
  const declaredSize =
    manifestObject !== null &&
    Number.isSafeInteger(manifestObject.size) &&
    (manifestObject.size as number) >= 0
      ? (manifestObject.size as number)
      : 0;
  const fallbackRange: [number, number] = [0, Math.min(declaredSize, ATTACHMENT_CHUNK_SIZE)];
  if (
    parts[3] === "manifest" ||
    parts[3] === "partition" ||
    parts[3] === "opaque" ||
    parts[3] === "span-cap"
  ) {
    if (range[0] !== fallbackRange[0] || range[1] !== fallbackRange[1]) {
      return "coverage attachment unresolved range changed";
    }
    if (parts[3] === "manifest" || parts[3] === "partition") {
      return historical ? null : "coverage attachment unresolved manifest is invalid";
    }
    if (!structurallyValid || manifestObject === null)
      return "coverage attachment unresolved manifest is invalid";
    const indexedCount = manifestObject.spans?.filter((span) => span.state === "indexed").length ?? 0;
    if (parts[3] === "opaque" && indexedCount !== 0) return "coverage attachment opaque state changed";
    if (parts[3] === "span-cap" && indexedCount <= COVERAGE_ATTACHMENT_SPAN_LIMIT && !workOverflow) {
      return "coverage attachment span cap changed";
    }
    return null;
  }
  if (!structurallyValid || manifestObject === null)
    return "coverage attachment unresolved manifest is invalid";
  const indexed = manifestObject.spans?.filter((span) => span.state === "indexed") ?? [];
  const span = indexed.find((candidate) => candidate.from === range[0] && candidate.to === range[1]);
  if (span === undefined) return "coverage attachment unresolved span changed";
  const read = readAttachmentRange(vault, threadId, seq, range, { requireIndexed: true });
  if (parts[3] === "bytes") {
    return historical || read === null || read.opaque ? null : "coverage attachment bytes became available";
  }
  if (historical) return null;
  if (read === null || read.opaque) return "coverage attachment inline witness is unavailable";
  const inlineBytes = new TextEncoder().encode(row.content);
  let indexedPrefixEnd = 0;
  for (const candidate of indexed) {
    if (candidate.from !== indexedPrefixEnd) return "coverage attachment unresolved partition changed";
    indexedPrefixEnd = candidate.to;
  }
  if (inlineBytes.byteLength !== indexedPrefixEnd) return null;
  for (const candidate of indexed) {
    const candidateRead = readAttachmentRange(vault, threadId, seq, [candidate.from, candidate.to], {
      requireIndexed: true,
    });
    if (candidateRead === null || candidateRead.opaque) {
      return "coverage attachment inline witness is unavailable";
    }
    if (!bytesEqual(candidateRead.bytes, inlineBytes.slice(candidate.from, candidate.to))) return null;
  }
  return "coverage attachment inline bytes now match";
}

function coverageSourceSpan(raw: string | null): [number, number] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isSafeInteger(parsed[0]) &&
      Number.isSafeInteger(parsed[1]) &&
      parsed[0] >= 0 &&
      parsed[1] > parsed[0]
    ) {
      return [parsed[0] as number, parsed[1] as number];
    }
  } catch {
    // A malformed atom span cannot authorize a narrower coverage locator.
  }
  return undefined;
}

function coverageLocatorShapeFailure(value: unknown): string | null {
  const record = parseRecord(value);
  if (record === null) return "coverage locator is malformed";
  const allowed = new Set(["route", "source", "byteRange", "revision", "authority", "status", "digest"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return "coverage locator has unknown fields";
  if (
    typeof record.route !== "string" ||
    !COVERAGE_LOCATOR_ROUTES.has(record.route) ||
    typeof record.source !== "string" ||
    typeof record.revision !== "string" ||
    record.revision.length === 0 ||
    typeof record.authority !== "string" ||
    !COVERAGE_LOCATOR_AUTHORITIES.has(record.authority) ||
    typeof record.status !== "string" ||
    !COVERAGE_LOCATOR_STATUSES.has(record.status) ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    !validByteRange(record.byteRange) ||
    record.byteRange[1] <= record.byteRange[0]
  ) {
    return "coverage locator shape is malformed";
  }
  const sourceMatch = /^episode:(\d+)$/u.exec(record.source);
  if (sourceMatch === null || Number(sourceMatch[1]) <= 0) {
    // A bare blob hash is not sufficient A13 provenance. Attachment/blob
    // evidence must use the typed A14 locator, which carries seq/manifest/
    // revision/spanHash bindings; coverage locators intentionally do not.
    return "coverage locator source is not a typed episode address";
  }
  return null;
}

function coverageLocatorOrder(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftSource = String(left.source);
  const rightSource = String(right.source);
  const leftSeq = Number(leftSource.slice("episode:".length));
  const rightSeq = Number(rightSource.slice("episode:".length));
  return (
    leftSeq - rightSeq ||
    (left.byteRange as [number, number])[0] - (right.byteRange as [number, number])[0] ||
    String(left.digest).localeCompare(String(right.digest))
  );
}

function coverageLocatorFailure(
  vault: Vault,
  threadId: string,
  querySeq: Seq,
  locator: Record<string, unknown>,
  source: CoverageReplaySource,
): string | null {
  const sourceMatch = /^episode:(\d+)$/u.exec(String(locator.source));
  if (sourceMatch === null) return "coverage locator source is invalid";
  const seq = Number(sourceMatch[1]);
  if (!Number.isSafeInteger(seq) || seq <= 0 || seq >= querySeq) {
    return "coverage locator source is outside the asking turn";
  }
  const row = source.row;
  if (row.seq !== seq) return "coverage locator source replay changed";
  const meta = source.meta;
  const range = locator.byteRange as [number, number];
  const authority = coverageAuthorityForRole(row.role);
  if (authority === null) return "coverage locator source role is not evidence-bearing";
  if (locator.authority !== authority) return "coverage locator authority changed";
  const baseStatus = coverageStatusForRole(row.role);
  const removalSeq = source.removalSeq;
  if (meta.removed === true && (removalSeq === null || removalSeq <= querySeq)) {
    return "coverage locator source is deleted before query snapshot";
  }
  const removedAfterQuery = meta.removed === true && removalSeq !== null && removalSeq > querySeq;
  const base = {
    route: locator.route,
    source: locator.source,
    byteRange: locator.byteRange,
    revision: locator.revision,
    authority: locator.authority,
    status: locator.status,
  };
  if (canonicalHash(base) !== locator.digest) return "coverage locator digest mismatch";

  const atomRows = source.atoms;
  if (source.atomOverflow) {
    const expectedRevision = `atom-cap:${canonicalHash([seq, row.content_hash, COVERAGE_ATOM_EVIDENCE_LIMIT])}`;
    const indexedLength = source.contentBytes;
    if (
      locator.revision !== expectedRevision ||
      locator.status !== "unresolved" ||
      range[0] !== 0 ||
      range[1] !== indexedLength
    ) {
      return "coverage locator atom overflow binding changed";
    }
    return null;
  }

  // A removed source can still authenticate a receipt that was issued before
  // the removal. Its original bytes are intentionally gone, so validate the
  // immutable content/revision and as-of atom interval, but do not pretend the
  // tombstone text is the historical witness bytes.
  if (removedAfterQuery) {
    if (row.role === "attachment") {
      if (locator.status === "unresolved") {
        return coverageAttachmentUnresolvedFailure(
          vault,
          threadId,
          seq,
          row,
          meta,
          locator,
          true,
          source.workOverflow,
        );
      }
      const manifest = meta.manifest;
      if (
        manifest === null ||
        typeof manifest !== "object" ||
        Array.isArray(manifest) ||
        !manifestPartitionValid(manifest as AttachmentManifest) ||
        meta.blob !== (manifest as AttachmentManifest).hash
      ) {
        return "coverage locator historical attachment manifest is invalid";
      }
      const span = (manifest as AttachmentManifest).spans.find(
        (candidate) =>
          candidate.state === "indexed" && candidate.from === range[0] && candidate.to === range[1],
      );
      const expectedRevision =
        span === undefined
          ? undefined
          : `attachment:${(manifest as AttachmentManifest).id}:${(manifest as AttachmentManifest).digest}:${span.ordinal}:${span.hash}`;
      if (
        expectedRevision === undefined ||
        locator.revision !== expectedRevision ||
        locator.status !== baseStatus
      ) {
        return "coverage locator historical attachment binding changed";
      }
      return null;
    }
    const atomsAtQuery = atomRows.filter((atom) => coverageAtomStatusAt(atom, querySeq) !== null);
    const wholeRevision = `episode:${seq}:${row.content_hash}`;
    if (atomsAtQuery.length === 0) {
      if (locator.revision !== wholeRevision || locator.status !== baseStatus) {
        return "coverage locator historical source binding changed";
      }
      return null;
    }
    for (const atom of atomsAtQuery) {
      const status = coverageAtomStatusAt(atom, querySeq);
      if (status === null) continue;
      const revision = canonicalHash({
        contentHash: row.content_hash,
        key: atom.key,
        value: atom.value,
        // The source text is deliberately redacted after deletion. The
        // locator's already-receipted bytes are therefore the only retained
        // byte range; bind that range into the immutable atom revision rather
        // than measuring the tombstone text.
        byteRange: range,
        validFromSeq: atom.valid_from_seq,
        validToSeq: atom.valid_to_seq !== null && atom.valid_to_seq > querySeq ? null : atom.valid_to_seq,
      });
      if (locator.revision === revision && locator.status === status) return null;
    }
    return "coverage locator historical source binding changed";
  }

  if (row.role === "attachment") {
    if (locator.status === "unresolved") {
      return coverageAttachmentUnresolvedFailure(
        vault,
        threadId,
        seq,
        row,
        meta,
        locator,
        false,
        source.workOverflow,
      );
    }
    const manifest = meta.manifest;
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      Array.isArray(manifest) ||
      !manifestPartitionValid(manifest as AttachmentManifest) ||
      meta.blob !== (manifest as AttachmentManifest).hash
    ) {
      return "coverage locator attachment manifest is invalid";
    }
    if (source.content === undefined) return "coverage locator attachment content is unavailable";
    const indexedBytes = new TextEncoder().encode(source.content);
    if (
      range[1] > indexedBytes.byteLength ||
      range[1] <= range[0] ||
      range[1] - range[0] > ATTACHMENT_CHUNK_SIZE
    ) {
      return "coverage locator attachment range is outside indexed bytes";
    }
    const read = readAttachmentRange(vault, threadId, seq, range, { requireIndexed: true });
    if (read === null || read.opaque) return "coverage locator attachment bytes are unavailable";
    if (!bytesEqual(read.bytes, indexedBytes.slice(range[0], range[1]))) {
      return "coverage locator attachment indexed bytes changed";
    }
    const span = (manifest as AttachmentManifest).spans.find(
      (candidate) =>
        candidate.state === "indexed" && candidate.from === range[0] && candidate.to === range[1],
    );
    const expectedRevision =
      span === undefined
        ? undefined
        : `attachment:${(manifest as AttachmentManifest).id}:${(manifest as AttachmentManifest).digest}:${span.ordinal}:${span.hash}`;
    if (
      expectedRevision === undefined ||
      locator.revision !== expectedRevision ||
      locator.status !== baseStatus
    ) {
      return "coverage locator attachment revision or status changed";
    }
    return null;
  }

  if (range[1] > source.contentBytes) return "coverage locator range is outside source";
  const atomsAtQuery = atomRows.filter((atom) => coverageAtomStatusAt(atom, querySeq) !== null);
  const wholeRevision = `episode:${seq}:${row.content_hash}`;
  if (locator.revision === wholeRevision) {
    if (
      atomsAtQuery.length > 0 ||
      locator.status !== baseStatus ||
      range[0] !== 0 ||
      range[1] !== source.contentBytes
    ) {
      return "coverage locator whole-source binding changed";
    }
    return null;
  }

  for (const atom of atomRows) {
    const status = coverageAtomStatusAt(atom, querySeq);
    if (status === null) continue;
    const byteRange = coverageAtomByteRangeProjected(
      vault,
      threadId,
      seq,
      source.contentBytes,
      atom.value,
      coverageSourceSpan(atom.source_span),
    );
    const revision = canonicalHash({
      contentHash: row.content_hash,
      key: atom.key,
      value: atom.value,
      byteRange,
      validFromSeq: atom.valid_from_seq,
      validToSeq: atom.valid_to_seq !== null && atom.valid_to_seq > querySeq ? null : atom.valid_to_seq,
    });
    if (
      locator.revision === revision &&
      locator.status === status &&
      range[0] === byteRange[0] &&
      range[1] === byteRange[1]
    ) {
      return null;
    }
  }
  return "coverage locator revision, range, or status binding changed";
}

interface CoverageBasisAtomRow {
  id: string;
  key: string;
  value: string;
  source_span: string | null;
  valid_from_seq: number;
  valid_to_seq: number | null;
  phase: string;
  authority: string;
  source_seq: number;
}

function coverageBasisOutcomeForLocators(locators: readonly Record<string, unknown>[]): string {
  if (locators.length === 0) return "no-locator";
  if (locators.some((locator) => locator.status === "unresolved")) return "unresolved";
  if (locators.some((locator) => locator.status === "supported")) return "supported";
  if (locators.some((locator) => locator.status === "historical")) return "historical";
  if (locators.some((locator) => locator.status === "proposed")) return "proposed";
  return "no-locator";
}

/**
 * Bind every issuance-basis member to the retained source/atom and to the
 * actual locator digests.  The basis is not trusted merely because its own
 * digest recomputes: its source hash, atom identity, status, and byte witness
 * still have to agree with kernel rows and the already-verified route list.
 */
function coverageBasisMemberBindingFailure(
  vault: Vault,
  threadId: string,
  querySeq: Seq,
  member: Record<string, unknown>,
  recordedByDigest: ReadonlyMap<string, Record<string, unknown>>,
  replayContext: CoverageReplayContext,
  atomCache: Map<string, CoverageBasisAtomRow | null>,
): string | null {
  const sourceSeq = member.sourceSeq;
  if (typeof sourceSeq !== "number" || !Number.isSafeInteger(sourceSeq) || sourceSeq < 0) {
    return "coverage basis member source is malformed";
  }
  const locatorDigests = Array.isArray(member.locatorDigests)
    ? (member.locatorDigests as unknown[]).map(String)
    : [];
  if (sourceSeq === 0) {
    if (member.atomId !== undefined || locatorDigests.length > 0) {
      return "coverage basis sentinel carries an evidence binding";
    }
    return null;
  }
  if (sourceSeq >= querySeq) return "coverage basis member source is outside the asking snapshot";
  const replaySource = coverageReplaySource(vault, threadId, sourceSeq, replayContext);
  if (typeof replaySource === "string") return replaySource;
  const source = replaySource.row;
  if (member.contentHash !== source.content_hash) return "coverage basis member source hash changed";

  const locators: Record<string, unknown>[] = [];
  for (const digest of locatorDigests) {
    const locator = recordedByDigest.get(digest);
    if (locator === undefined) return "coverage basis locator digest is not retained";
    if (locator.source !== `episode:${sourceSeq}`) return "coverage basis locator source changed";
    locators.push(locator);
  }
  if (coverageBasisOutcomeForLocators(locators) !== member.outcome) {
    return "coverage basis member outcome changed";
  }

  if (typeof member.atomId !== "string") return null;
  const atomId = member.atomId;
  if (!atomCache.has(atomId)) {
    const atom = vault.db
      .query(
        "SELECT id, key, value, source_span, valid_from_seq, valid_to_seq, phase, authority, source_seq " +
          "FROM atom WHERE thread_id = ? AND id = ?",
      )
      .get(threadId, atomId) as CoverageBasisAtomRow | null;
    atomCache.set(atomId, atom);
  }
  const atom = atomCache.get(atomId) ?? null;
  if (atom === null || atom.source_seq !== sourceSeq) return "coverage basis atom source changed";
  const removedAfterQuery = replaySource.removedAfterQuery;
  const status = coverageAtomStatusAt(atom, querySeq);
  if (status === null && locators.length > 0) return "coverage basis atom is not valid at query snapshot";
  for (const locator of locators) {
    const range = locator.byteRange as [number, number];
    const byteRange = removedAfterQuery
      ? range
      : coverageAtomByteRangeProjected(
          vault,
          threadId,
          sourceSeq,
          replaySource.contentBytes,
          atom.value,
          coverageSourceSpan(atom.source_span),
        );
    const revision = canonicalHash({
      contentHash: source.content_hash,
      key: atom.key,
      value: atom.value,
      byteRange,
      validFromSeq: atom.valid_from_seq,
      validToSeq: atom.valid_to_seq !== null && atom.valid_to_seq > querySeq ? null : atom.valid_to_seq,
    });
    if (
      locator.revision !== revision ||
      locator.status !== status ||
      range[0] !== byteRange[0] ||
      range[1] !== byteRange[1]
    ) {
      return "coverage basis atom locator binding changed";
    }
  }
  return null;
}

function coverageRoutesFailure(
  vault: Vault,
  threadId: string,
  coverage: unknown,
  turnSeq?: Seq,
  pages?: readonly PageRecord[],
): string | null {
  // Coverage replay is an authoritative consumer of both derived atom
  // projections.  A packet issued before a resumable startup repair must not
  // be re-certified against the deliberately partial atom table; callers can
  // retry after the durable global readiness markers reach `complete`.
  if (!vault.atomDerivedReady(threadId)) {
    return "atom routing migration is incomplete; retry after startup repair";
  }
  const record = parseRecord(coverage);
  const querySeq = record?.querySeq;
  if (
    record === null ||
    typeof record.routerVersion !== "string" ||
    record.routerVersion.length === 0 ||
    !Number.isSafeInteger(querySeq) ||
    (querySeq as number) <= 0 ||
    record.asOfSeq !== querySeq ||
    !Array.isArray(record.routesRun) ||
    !Array.isArray(record.routes)
  ) {
    return "coverage route provenance is malformed";
  }
  const boundQuerySeq = querySeq as Seq;
  const replayContext: CoverageReplayContext = {
    querySeq: boundQuerySeq,
    workBytes: 0,
    overflowed: false,
    sources: new Map(),
  };
  if (turnSeq !== undefined && boundQuerySeq !== turnSeq) return "coverage receipt turn binding mismatch";
  const question = vault.db
    .query("SELECT content, content_hash, meta FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, boundQuerySeq) as { content: string; content_hash: string; meta: string } | null;
  if (question === null) return "coverage asking episode is missing";
  const questionMeta = parseRecord((question as { meta?: string }).meta);
  const questionRemovalSeq = questionMeta === null ? null : sourceRemovalSeq(vault, threadId, questionMeta);
  const questionRemovedAfterQuery =
    questionMeta?.removed === true && questionRemovalSeq !== null && questionRemovalSeq > boundQuerySeq;
  // Forget deliberately replaces the question bytes with a tombstone while
  // retaining its original content_hash.  A receipt issued at that question's
  // sequence remains verifiable from its issuance basis; never derive a new
  // cue, subject, or cardinality from the replacement text.
  const questionContentHash = questionRemovedAfterQuery
    ? (question as { content_hash: string }).content_hash
    : sha256((question as { content: string }).content);
  if (!questionRemovedAfterQuery) {
    if (collectionCue((question as { content: string }).content) !== record.cue)
      return "coverage cue is not bound to the asking question";
    const expectedRequired = explicitCardinality((question as { content: string }).content);
    if (
      (expectedRequired === undefined && record.required !== undefined) ||
      (expectedRequired !== undefined && record.required !== expectedRequired)
    ) {
      return "coverage required cardinality is not bound to the asking question";
    }
  }
  // Current collection coverage has exactly these three deterministic routes.
  // Attachment failures are represented by the originating route's unresolved
  // outcome and its bounded basis member, never by a fabricated fourth route.
  const routeNames = ["names", "pages", "search"] as const;
  let blockedRoute = false;
  if (record.routesRun.length !== routeNames.length) return "coverage route set is malformed";
  for (const [index, run] of record.routesRun.entries()) {
    const item = parseRecord(run);
    if (
      item === null ||
      typeof item.route !== "string" ||
      item.route !== routeNames[index] ||
      typeof item.returned !== "number" ||
      !Number.isSafeInteger(item.returned) ||
      item.returned < 0 ||
      typeof item.status !== "string" ||
      !["complete", "empty", "capped", "ambiguous", "unresolved", "not-run"].includes(item.status)
    ) {
      return "coverage route run is malformed";
    }
    if (["not-run", "empty"].includes(item.status) && item.returned !== 0) {
      return "coverage route run count is inconsistent";
    }
    if (item.status === "complete" && item.returned <= 0) {
      return "coverage route run count is inconsistent";
    }
    if (["capped", "ambiguous", "unresolved"].includes(item.status)) blockedRoute = true;
  }
  const basisShapeFailure = coverageBasisFailureShape(
    record.basis,
    record.routesRun,
    record.routes,
    questionContentHash,
    pages ?? [],
  );
  if (basisShapeFailure !== null) return basisShapeFailure;
  const basisRecord = parseRecord(record.basis);
  const basisRouteMembersRecord = parseRecord(basisRecord?.routeMembers);
  const basisMembersFor = (route: "names" | "pages" | "search"): Record<string, unknown>[] => {
    const routeRecord = parseRecord(basisRouteMembersRecord?.[route]);
    if (routeRecord === null || !Array.isArray(routeRecord.members)) return [];
    return routeRecord.members
      .map(parseRecord)
      .filter((member): member is Record<string, unknown> => member !== null);
  };
  const basisNamesMembers = basisMembersFor("names");
  const basisPagesMembers = basisMembersFor("pages");
  const basisSearchMembers = basisMembersFor("search");
  const nameSyntheticMembers = basisNamesMembers.filter((member) => member.sourceSeq === 0);
  if (nameSyntheticMembers.length > 1) return "coverage name synthetic member is duplicated";
  for (const member of basisNamesMembers) {
    if (member.sourceSeq === 0) {
      if (
        member.kind !== "sentinel" ||
        member.key !== "__name-key-overflow__" ||
        member.atomId !== undefined ||
        (Array.isArray(member.locatorDigests) && member.locatorDigests.length !== 0)
      ) {
        return "coverage name synthetic member is malformed";
      }
    } else if (typeof member.sourceSeq !== "number" || typeof member.atomId !== "string") {
      return "coverage name member is missing its atom address";
    }
  }
  for (const member of basisSearchMembers) {
    if (typeof member.sourceSeq !== "number" || member.sourceSeq <= 0) {
      return "coverage search member source is malformed";
    }
  }
  for (const member of basisPagesMembers) {
    if (member.sourceSeq === 0) {
      const overflowSentinel = member.key === "__page-overflow__";
      if (
        (overflowSentinel &&
          (member.kind !== "sentinel" || member.ordinal !== COVERAGE_RETAINED_SOURCE_LIMIT)) ||
        (!overflowSentinel && member.kind !== "candidate") ||
        member.atomId !== undefined ||
        (Array.isArray(member.locatorDigests) && member.locatorDigests.length !== 0)
      ) {
        return "coverage page synthetic member is malformed";
      }
    } else if (typeof member.sourceSeq !== "number") {
      return "coverage page member source is malformed";
    }
  }
  const searchRouteReplay = questionRemovedAfterQuery
    ? {
        subject: "",
        returned: 0,
        allSeqs: [] as number[],
        evidenceSeqs: new Set(
          basisSearchMembers
            .filter(
              (member) =>
                typeof member.sourceSeq === "number" &&
                member.sourceSeq > 0 &&
                Array.isArray(member.locatorDigests) &&
                member.locatorDigests.length > 0,
            )
            .map((member) => member.sourceSeq as number),
        ),
      }
    : null;
  const searchReplay = questionRemovedAfterQuery
    ? {
        subject: "",
        returned: 0,
        allSeqs: [] as number[],
        evidenceSeqs: new Set<number>(),
      }
    : coverageSearchReplay(vault, threadId, boundQuerySeq);
  if ("failure" in searchReplay) return searchReplay.failure;
  const searchRun = parseRecord(record.routesRun[2]);
  if (searchRun === null) return "coverage search route run is malformed";
  const nameReplay = questionRemovedAfterQuery
    ? {
        returned: 0,
        atoms: [] as Array<{ id: string; sourceSeq: number; key: string; ordinal: number }>,
        atomIds: new Set<string>(),
        sourceByAtomId: new Map<string, number>(),
        overflowed: false,
        keys: [] as string[],
        keyOverflow: false,
      }
    : coverageNameReplay(vault, threadId, (question as { content: string }).content, boundQuerySeq);
  if ("failure" in nameReplay) return nameReplay.failure;
  const namesRun = parseRecord(record.routesRun[0]);
  if (namesRun === null) return "coverage name route run is malformed";
  let basisReplayFailure: string | null = null;
  const basisSourceRemovedAfterQuery = (sourceSeq: number): boolean => {
    const source = coverageReplaySource(vault, threadId, sourceSeq, replayContext);
    if (typeof source === "string") {
      basisReplayFailure = source;
      return false;
    }
    return source.removedAfterQuery;
  };
  const basisNamesHasRemoved = basisNamesMembers.some(
    (member) =>
      typeof member.sourceSeq === "number" &&
      member.sourceSeq > 0 &&
      basisSourceRemovedAfterQuery(member.sourceSeq),
  );
  const basisPagesHasRemoved = basisPagesMembers.some(
    (member) =>
      typeof member.sourceSeq === "number" &&
      member.sourceSeq > 0 &&
      basisSourceRemovedAfterQuery(member.sourceSeq),
  );
  const basisSearchHasRemoved = basisSearchMembers.some(
    (member) =>
      typeof member.sourceSeq === "number" &&
      member.sourceSeq > 0 &&
      basisSourceRemovedAfterQuery(member.sourceSeq),
  );
  if (basisReplayFailure !== null) return basisReplayFailure;
  const namesReturnedAtSnapshot = nameReplay.returned;
  const expectedNamesStatus =
    questionRemovedAfterQuery || basisNamesHasRemoved
      ? String(namesRun.status)
      : nameReplay.keys.length === 0 && !nameReplay.keyOverflow
        ? "not-run"
        : nameReplay.overflowed
          ? "unresolved"
          : namesReturnedAtSnapshot === 0
            ? "empty"
            : "complete";
  if (
    !questionRemovedAfterQuery &&
    (namesRun.returned !== namesReturnedAtSnapshot || namesRun.status !== expectedNamesStatus)
  ) {
    return "coverage name route result changed at query snapshot";
  }
  const sameNumberList = (left: readonly number[], right: readonly number[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  const basisSearchSeqs = basisSearchMembers
    .filter((member) => typeof member.sourceSeq === "number" && member.sourceSeq > 0)
    .filter((member) => !basisSourceRemovedAfterQuery(member.sourceSeq as number))
    .map((member) => member.sourceSeq as number);
  const basisSearchRoute = parseRecord(basisRouteMembersRecord?.search);
  const searchHasSentinel = basisSearchMembers.some((member) => member.kind === "sentinel");
  const searchReturned = searchRun.returned as number;
  const expectedSearchKey = questionRemovedAfterQuery ? null : sha256(searchReplay.subject);
  for (const [index, member] of basisSearchMembers.entries()) {
    if (member.ordinal !== index || (expectedSearchKey !== null && member.key !== expectedSearchKey)) {
      return "coverage search basis member order changed";
    }
  }
  if (searchReturned > COVERAGE_RETAINED_SOURCE_LIMIT) {
    const sentinel = basisSearchMembers[basisSearchMembers.length - 1];
    if (
      basisSearchMembers.length !== COVERAGE_RETAINED_SOURCE_LIMIT + 1 ||
      sentinel === undefined ||
      sentinel.kind !== "sentinel" ||
      sentinel.ordinal !== COVERAGE_RETAINED_SOURCE_LIMIT ||
      !Array.isArray(sentinel.locatorDigests) ||
      sentinel.locatorDigests.length !== 0 ||
      searchRun.status !== "unresolved"
    ) {
      return "coverage search overflow sentinel changed";
    }
    if (basisSearchMembers.slice(0, -1).some((member) => member.kind !== "candidate")) {
      return "coverage search overflow sentinel is misplaced";
    }
  } else if (searchHasSentinel) {
    return "coverage search overflow sentinel is unexpected";
  }
  if (searchReturned <= COVERAGE_RETAINED_SOURCE_LIMIT && searchReturned !== basisSearchMembers.length) {
    return "coverage search basis count changed";
  }
  const searchSaturated = basisSearchRoute?.overflow === true || searchHasSentinel;
  if (!questionRemovedAfterQuery) {
    if (searchSaturated) {
      const issuanceSeqs = new Set(basisSearchSeqs);
      const retainedReplaySeqs = searchReplay.allSeqs.filter(
        (sourceSeq) => issuanceSeqs.has(sourceSeq) && !basisSourceRemovedAfterQuery(sourceSeq),
      );
      if (!sameNumberList(basisSearchSeqs, retainedReplaySeqs)) {
        return "coverage search basis members changed at query snapshot";
      }
    } else if (!sameNumberList(basisSearchSeqs, searchReplay.allSeqs)) {
      return "coverage search basis members changed at query snapshot";
    }
  }
  const basisNameAtoms = basisNamesMembers.filter((member) => typeof member.atomId === "string");
  const basisNameAtomIdSet = new Set(basisNameAtoms.map((member) => String(member.atomId)));
  const basisNameKeyOverflow = basisNamesMembers.some(
    (member) => member.sourceSeq === 0 && member.key === "__name-key-overflow__",
  );
  if (!questionRemovedAfterQuery && basisNameKeyOverflow !== nameReplay.keyOverflow) {
    return "coverage name overflow sentinel changed at query snapshot";
  }
  if (!questionRemovedAfterQuery && basisNameKeyOverflow) {
    const overflowMember = basisNamesMembers.find(
      (member) => member.sourceSeq === 0 && member.key === "__name-key-overflow__",
    );
    if (overflowMember?.ordinal !== nameReplay.keys.length) {
      return "coverage name overflow sentinel ordinal changed";
    }
  }
  for (const member of basisNamesMembers) {
    if (member.atomId === undefined) continue;
    const expectedKind = member.ordinal === COVERAGE_NAME_ROUTE_LIMIT ? "sentinel" : "candidate";
    if (member.kind !== expectedKind) return "coverage name overflow sentinel kind changed";
  }
  if (namesRun.returned !== basisNameAtoms.length) return "coverage name basis count changed";
  if (!questionRemovedAfterQuery) {
    const basisNameByKey = new Map<string, Record<string, unknown>[]>();
    const replayNameByKey = new Map<string, typeof nameReplay.atoms>();
    for (const member of basisNameAtoms) {
      const key = String(member.key ?? "");
      const prior = basisNameByKey.get(key) ?? [];
      prior.push(member);
      basisNameByKey.set(key, prior);
    }
    for (const atom of nameReplay.atoms) {
      const key = atom.key;
      const prior = replayNameByKey.get(key) ?? [];
      prior.push(atom);
      replayNameByKey.set(key, prior);
    }
    const allNameKeys = new Set([...basisNameByKey.keys(), ...replayNameByKey.keys()]);
    for (const key of allNameKeys) {
      const expectedAtoms = basisNameByKey.get(key) ?? [];
      const actualAtoms = replayNameByKey.get(key) ?? [];
      if (expectedAtoms.length === 0 && actualAtoms.length > 0) {
        return "coverage name basis members changed at query snapshot";
      }
      const saturated = expectedAtoms.some((member) => member.ordinal === COVERAGE_NAME_ROUTE_LIMIT);
      const retainedActual = saturated
        ? actualAtoms.filter((atom) => expectedAtoms.some((member) => member.atomId === atom.id))
        : actualAtoms;
      if (retainedActual.length !== expectedAtoms.length) {
        return "coverage name basis members changed at query snapshot";
      }
      for (const [index, atom] of retainedActual.entries()) {
        const member = expectedAtoms[index];
        if (
          member === undefined ||
          member.atomId !== atom.id ||
          member.sourceSeq !== atom.sourceSeq ||
          member.key !== atom.key ||
          member.ordinal !== atom.ordinal
        ) {
          return "coverage name basis members changed at query snapshot";
        }
      }
    }
  }
  const expectedPageMembers: Array<{ sourceSeq: number; key?: string; ordinal?: number; kind: string }> = [];
  let pageReturnedAtSnapshot = 0;
  const pageReturnedTotal = (pages ?? []).reduce((total, page) => total + page.seqs.length, 0);
  let pageMembersObservedAtSnapshot = 0;
  let pagesOverflowedAtSnapshot = false;
  let pageHitOverflowedAtSnapshot = false;
  const replayPages: PageRecord[] = [];
  pagesLoop: for (const [pageIndex, page] of (pages ?? []).entries()) {
    if (page.seqs.length === 0) {
      if (pageMembersObservedAtSnapshot >= COVERAGE_RETAINED_SOURCE_LIMIT) {
        pagesOverflowedAtSnapshot = true;
        break;
      }
      pageMembersObservedAtSnapshot += 1;
      expectedPageMembers.push({ sourceSeq: 0, key: page.trigger, ordinal: pageIndex, kind: "candidate" });
      replayPages.push({ ...page, seqs: [] });
      continue;
    }
    const replaySeqs: number[] = [];
    for (const [seqIndex, sourceSeq] of page.seqs.entries()) {
      if (pageMembersObservedAtSnapshot >= COVERAGE_RETAINED_SOURCE_LIMIT) {
        pagesOverflowedAtSnapshot = true;
        pageHitOverflowedAtSnapshot = true;
        if (replaySeqs.length > 0) replayPages.push({ ...page, seqs: replaySeqs });
        break pagesLoop;
      }
      pageMembersObservedAtSnapshot += 1;
      pageReturnedAtSnapshot += 1;
      expectedPageMembers.push({ sourceSeq, key: page.trigger, ordinal: seqIndex, kind: "candidate" });
      replaySeqs.push(sourceSeq);
    }
    if (replaySeqs.length > 0) replayPages.push({ ...page, seqs: replaySeqs });
  }
  if (pagesOverflowedAtSnapshot) {
    if (pageHitOverflowedAtSnapshot) pageReturnedAtSnapshot = pageReturnedTotal;
    expectedPageMembers.push({
      sourceSeq: 0,
      key: "__page-overflow__",
      ordinal: COVERAGE_RETAINED_SOURCE_LIMIT,
      kind: "sentinel",
    });
  }
  if (basisPagesMembers.length !== expectedPageMembers.length) {
    return "coverage page basis members changed at packet snapshot";
  }
  for (const [index, expected] of expectedPageMembers.entries()) {
    const member = basisPagesMembers[index];
    if (
      member === undefined ||
      member.kind !== expected.kind ||
      member.sourceSeq !== expected.sourceSeq ||
      (expected.key !== undefined && member.key !== expected.key) ||
      (expected.ordinal !== undefined && member.ordinal !== expected.ordinal)
    ) {
      return "coverage page basis members changed at packet snapshot";
    }
  }
  const basisSearchSeqSet = new Set(
    basisSearchMembers
      .filter(
        (member) =>
          member.kind === "candidate" && typeof member.sourceSeq === "number" && member.sourceSeq > 0,
      )
      .map((member) => member.sourceSeq as number),
  );
  const searchEvidenceSeqs = questionRemovedAfterQuery
    ? (searchRouteReplay as { evidenceSeqs: Set<number> }).evidenceSeqs
    : new Set([...searchReplay.evidenceSeqs].filter((sourceSeq) => basisSearchSeqSet.has(sourceSeq)));
  const searchReturnedAtSnapshot = searchRun.returned as number;
  const expectedSearchStatus =
    questionRemovedAfterQuery || basisSearchHasRemoved
      ? String(searchRun.status)
      : searchReplay.subject.length === 0
        ? "not-run"
        : searchReturnedAtSnapshot > COVERAGE_RETAINED_SOURCE_LIMIT
          ? "unresolved"
          : searchReturnedAtSnapshot === 0
            ? "empty"
            : "complete";
  if (!questionRemovedAfterQuery && searchRun.returned !== searchReturnedAtSnapshot) {
    return "coverage search route result changed at query snapshot";
  }
  const expectedSources = new Map<number, ReadonlySet<string> | undefined>();
  const addExpectedSource = (sourceSeq: number, atomIds?: ReadonlySet<string>): void => {
    const prior = expectedSources.get(sourceSeq);
    if (prior === undefined && expectedSources.has(sourceSeq)) return;
    if (atomIds === undefined) {
      expectedSources.set(sourceSeq, undefined);
      return;
    }
    if (prior === undefined) {
      expectedSources.set(sourceSeq, new Set(atomIds));
      return;
    }
    const merged = new Set(prior);
    for (const atomId of atomIds) merged.add(atomId);
    expectedSources.set(sourceSeq, merged);
  };
  if (questionRemovedAfterQuery) {
    // The lexical question bytes are gone.  The retained basis still tells us
    // which actual locator bindings must be present; no tombstone text is used
    // to invent a new search/name result.
    for (const member of [...basisNamesMembers, ...basisPagesMembers, ...basisSearchMembers]) {
      if (
        typeof member.sourceSeq !== "number" ||
        member.sourceSeq <= 0 ||
        !Array.isArray(member.locatorDigests) ||
        member.locatorDigests.length === 0
      ) {
        continue;
      }
      if (typeof member.atomId === "string") {
        addExpectedSource(member.sourceSeq, new Set([member.atomId]));
      } else {
        addExpectedSource(member.sourceSeq);
      }
    }
  } else {
    for (const sourceSeq of searchEvidenceSeqs) addExpectedSource(sourceSeq);
    for (const atomId of nameReplay.atomIds) {
      if (!basisNameAtomIdSet.has(atomId)) continue;
      const sourceSeq = nameReplay.sourceByAtomId.get(atomId);
      if (sourceSeq !== undefined) addExpectedSource(sourceSeq, new Set([atomId]));
    }
    if (pages !== undefined) {
      for (const page of replayPages) {
        if (!page.resolved) continue;
        for (const sourceSeq of page.seqs) {
          if (sourceSeq < boundQuerySeq) addExpectedSource(sourceSeq);
        }
      }
    }
  }
  const expectedBindingSets = new Map<number, CoverageExpectedBinding[] | null>();
  const expectedUnresolvedSources = new Set<number>();
  for (const [sourceSeq, restrictAtomIds] of expectedSources.entries()) {
    const source = coverageReplaySource(vault, threadId, sourceSeq, replayContext);
    if (typeof source === "string") return source;
    if (source.removedAfterQuery) continue;
    if (source.row.role === "attachment" && coverageAttachmentIsUnresolved(vault, threadId, source)) {
      expectedUnresolvedSources.add(sourceSeq);
    }
    const expected = coverageExpectedBindingsForSource(
      vault,
      threadId,
      boundQuerySeq,
      source,
      restrictAtomIds,
    );
    expectedBindingSets.set(sourceSeq, expected);
    if (expected?.some((binding) => binding.status === "unresolved")) {
      expectedUnresolvedSources.add(sourceSeq);
    }
  }
  if (pages !== undefined) {
    const pageRun = parseRecord(record.routesRun[1]);
    if (pageRun === null) return "coverage page route run is malformed";
    const pageReturned = pageReturnedAtSnapshot;
    const pageHasSourceIssue = replayPages.some(
      (page) => page.resolved && page.seqs.some((sourceSeq) => expectedUnresolvedSources.has(sourceSeq)),
    );
    const expectedPageStatus =
      questionRemovedAfterQuery || basisPagesHasRemoved
        ? String(pageRun.status)
        : pageHasSourceIssue || pagesOverflowedAtSnapshot || replayPages.some((page) => !page.resolved)
          ? "unresolved"
          : replayPages.length === 0
            ? "not-run"
            : pageReturned === 0
              ? "empty"
              : "complete";
    if (
      (!questionRemovedAfterQuery && pageRun.returned !== pageReturned) ||
      pageRun.status !== expectedPageStatus
    ) {
      return "coverage page route result changed at packet snapshot";
    }
  }
  const expectedSearchHasIssue = [...expectedUnresolvedSources].some((sourceSeq) =>
    searchEvidenceSeqs.has(sourceSeq),
  );
  const expectedNamesHasIssue = [...expectedUnresolvedSources].some((sourceSeq) => {
    for (const atomId of nameReplay.atomIds) {
      if (!basisNameAtomIdSet.has(atomId)) continue;
      if (nameReplay.sourceByAtomId.get(atomId) === sourceSeq) return true;
    }
    return false;
  });
  const finalSearchStatus =
    questionRemovedAfterQuery || basisSearchHasRemoved
      ? expectedSearchStatus
      : expectedSearchHasIssue
        ? "unresolved"
        : expectedSearchStatus;
  const finalNamesStatus =
    questionRemovedAfterQuery || basisNamesHasRemoved
      ? expectedNamesStatus
      : expectedNamesHasIssue
        ? "unresolved"
        : expectedNamesStatus;
  if (searchRun.status !== finalSearchStatus || namesRun.status !== finalNamesStatus) {
    return "coverage route status changed at query snapshot";
  }
  let located = 0;
  let supported = 0;
  let historical = 0;
  let unresolved = 0;
  let previousLocator: Record<string, unknown> | undefined;
  const seenLocators = new Set<string>();
  const recordedBySource = new Map<number, Record<string, unknown>[]>();
  const recordedByDigest = new Map<string, Record<string, unknown>>();
  for (const route of record.routes) {
    const item = parseRecord(route);
    const shapeFailure = coverageLocatorShapeFailure(route);
    if (shapeFailure !== null || item === null) return shapeFailure ?? "coverage route is malformed";
    if (previousLocator !== undefined && coverageLocatorOrder(previousLocator, item) >= 0) {
      return "coverage locator ordering is not deterministic";
    }
    previousLocator = item;
    const sourceMatch = /^episode:(\d+)$/u.exec(String(item.source));
    if (sourceMatch === null) return "coverage route source is malformed";
    const sourceSeq = Number(sourceMatch[1]);
    const sourceLocators = recordedBySource.get(sourceSeq) ?? [];
    sourceLocators.push(item);
    recordedBySource.set(sourceSeq, sourceLocators);
    const key = canonicalHash([item.source, item.byteRange, item.revision]);
    if (seenLocators.has(key)) return "coverage locator is duplicated";
    seenLocators.add(key);
    if (recordedByDigest.has(String(item.digest))) return "coverage locator digest is duplicated";
    recordedByDigest.set(String(item.digest), item);
    const source = coverageReplaySource(vault, threadId, sourceSeq, replayContext);
    if (typeof source === "string") return source;
    const locatorFailure = coverageLocatorFailure(vault, threadId, boundQuerySeq, item, source);
    if (locatorFailure !== null) return locatorFailure;
    const routeBindingFailure = coverageSearchRouteFailure(
      vault,
      threadId,
      boundQuerySeq,
      item,
      searchRouteReplay ?? searchReplay,
    );
    if (routeBindingFailure !== null) return routeBindingFailure;
    const pageBindingFailure = coveragePageRouteFailure(boundQuerySeq, item, replayPages);
    if (pageBindingFailure !== null) return pageBindingFailure;
    if (item.status !== "unresolved") located += 1;
    if (item.status === "supported") supported += 1;
    if (item.status === "historical") historical += 1;
    if (item.status === "unresolved") unresolved += 1;
  }
  const basisAtomCache = new Map<string, CoverageBasisAtomRow | null>();
  for (const member of [...basisNamesMembers, ...basisPagesMembers, ...basisSearchMembers]) {
    const memberFailure = coverageBasisMemberBindingFailure(
      vault,
      threadId,
      boundQuerySeq,
      member,
      recordedByDigest,
      replayContext,
      basisAtomCache,
    );
    if (memberFailure !== null) return memberFailure;
  }
  const recordedSources = new Set(recordedBySource.keys());
  for (const expectedSource of searchEvidenceSeqs) {
    const source = coverageReplaySource(vault, threadId, expectedSource, replayContext);
    if (typeof source === "string") return source;
    // A malformed/empty attachment has no honest locator at all.  The
    // route-level unresolved status is its receipt; requiring a synthetic
    // per-span locator here would turn an explicit kernel omission into a
    // verifier failure (and invite forged metadata into the revision).
    const routeLevelUnresolvedAttachment =
      source.row.role === "attachment" && coverageAttachmentIsUnresolved(vault, threadId, source);
    if (
      !source.removedAfterQuery &&
      !recordedSources.has(expectedSource) &&
      !routeLevelUnresolvedAttachment
    ) {
      return "coverage route set omitted a deterministic search source";
    }
  }
  const bindingKey = (binding: { byteRange: unknown; revision: unknown; status: unknown }): string =>
    canonicalHash([binding.byteRange, binding.revision, binding.status]);
  for (const [sourceSeq] of expectedSources.entries()) {
    const source = coverageReplaySource(vault, threadId, sourceSeq, replayContext);
    if (typeof source === "string") return source;
    if (source.removedAfterQuery) continue;
    const expected = expectedBindingSets.get(sourceSeq);
    if (expected === undefined) return "coverage route replay binding is missing";
    const actual = recordedBySource.get(sourceSeq) ?? [];
    if (expected === null) {
      if (actual.length === 0 && coverageAttachmentIsUnresolved(vault, threadId, source)) {
        continue;
      }
      if (actual.length === 0) return "coverage route set omitted an attachment source";
      continue;
    }
    const expectedKeys = new Set(expected.map(bindingKey));
    const actualKeys = new Set(
      actual.map((binding) =>
        bindingKey(binding as { byteRange: unknown; revision: unknown; status: unknown }),
      ),
    );
    if (
      expectedKeys.size !== actualKeys.size ||
      [...expectedKeys].some((key) => !actualKeys.has(key)) ||
      [...actualKeys].some((key) => !expectedKeys.has(key))
    ) {
      return "coverage route locator set changed at query snapshot";
    }
  }
  for (const [sourceSeq, actual] of recordedBySource.entries()) {
    if (expectedSources.has(sourceSeq)) continue;
    const sourceRow = vault.db
      .query("SELECT meta FROM episode WHERE thread_id = ? AND seq = ?")
      .get(threadId, sourceSeq) as { meta: string } | null;
    const sourceMeta = sourceRow === null ? null : parseRecord(sourceRow.meta);
    const removalSeq = sourceMeta === null ? null : sourceRemovalSeq(vault, threadId, sourceMeta);
    if (sourceMeta?.removed === true && removalSeq !== null && removalSeq > boundQuerySeq) continue;
    if (actual.length > 0) return "coverage route set contains an unplanned source";
  }
  if (record.located !== located || record.supported !== supported || record.historical !== historical) {
    return "coverage route counts do not match receipt fields";
  }
  if (
    typeof record.unresolved !== "number" ||
    !Number.isSafeInteger(record.unresolved) ||
    record.unresolved < 0
  ) {
    return "coverage unresolved count is malformed";
  }
  if (record.required !== undefined) {
    if (
      typeof record.required !== "number" ||
      !Number.isSafeInteger(record.required) ||
      record.required < 0
    ) {
      return "coverage required count is malformed";
    }
    if (record.unresolved !== Math.max(unresolved, Math.max(0, record.required - supported))) {
      return "coverage unresolved count does not match required field";
    }
  } else if (record.unresolved !== unresolved) {
    return "coverage unresolved count does not match routes";
  }
  if (!["complete", "incomplete", "not-established"].includes(String(record.completeness))) {
    return "coverage completeness is malformed";
  }
  if (record.completeness === "complete") {
    if (
      record.required === undefined ||
      located !== supported ||
      supported !== record.required ||
      historical !== 0 ||
      record.unresolved !== 0 ||
      blockedRoute
    ) {
      return "coverage completeness is overstated";
    }
  }
  return null;
}

function coverageBasisFailure(
  vault: Vault,
  threadId: string,
  basis: unknown,
  candidate: ClaimCandidateRecord,
  answer: string,
  coverage: unknown,
  coverageDigest: string | undefined,
  pages?: readonly PageRecord[],
): string | null {
  const record = parseRecord(basis);
  if (
    record === null ||
    record.kind !== "coverage" ||
    typeof record.digest !== "string" ||
    typeof record.metric !== "string" ||
    typeof record.value !== "number" ||
    !Number.isSafeInteger(record.value) ||
    record.value < 0
  ) {
    return "coverage basis is malformed";
  }
  if (coverageDigest === undefined || record.digest !== coverageDigest) {
    return "coverage basis digest mismatch";
  }
  const coverageRecord = parseRecord(coverage);
  if (coverageRecord === null || !Number.isSafeInteger(coverageRecord.querySeq)) {
    return "coverage receipt is malformed";
  }
  const routeFailure = coverageRoutesFailure(
    vault,
    threadId,
    coverage,
    coverageRecord.querySeq as Seq,
    pages,
  );
  if (routeFailure !== null) return routeFailure;
  if (typeof coverageRecord.digest !== "string") {
    return "coverage receipt is malformed";
  }
  const expected = coverageBasisForCandidate(
    candidate as unknown as ClaimCandidate,
    answer,
    coverageRecord as unknown as CoverageReceipt,
  );
  if (expected === undefined || !sameCanonical(expected, record)) {
    return "coverage basis does not match candidate or receipt field";
  }
  return null;
}

function validByteRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    Number.isSafeInteger(value[1]) &&
    value[0] >= 0 &&
    value[1] >= value[0]
  );
}

function validateLocatorShape(locator: unknown): locator is ByteLocator {
  if (locator === null || typeof locator !== "object" || Array.isArray(locator)) return false;
  const value = locator as Record<string, unknown>;
  return (
    typeof value.source === "string" &&
    value.source.length > 0 &&
    validByteRange(value.byteRange ?? [value.from, value.to]) &&
    typeof value.hash === "string" &&
    value.hash.length > 0
  );
}

function validateEvidenceLocatorShape(locator: unknown): locator is EvidenceLocator {
  if (!validateLocatorShape(locator)) return false;
  const value = locator as unknown as Record<string, unknown>;
  return (
    Number.isSafeInteger(value.seq) &&
    (value.seq as number) > 0 &&
    typeof value.revision === "string" &&
    value.revision.length > 0 &&
    typeof value.spanHash === "string" &&
    value.spanHash.length > 0 &&
    typeof value.authority === "string" &&
    ["user", "tool", "attachment", "assistant", "model"].includes(value.authority) &&
    (value.manifestId === undefined || typeof value.manifestId === "string")
  );
}

function locatorRange(locator: ByteLocator): [number, number] {
  const value = locator as unknown as Record<string, unknown>;
  return value.byteRange !== undefined
    ? (value.byteRange as [number, number])
    : [value.from as number, value.to as number];
}

function locatorHash(locator: ByteLocator): string {
  return (locator as unknown as Record<string, unknown>).hash as string;
}

/**
 * Keep the verifier's witness test aligned with the claim gate's deterministic
 * string-presence oracle.  Identity candidates often contain framing prose
 * ("My name is …") while the source atom contains only the named entity; the
 * entity itself is still the exact remembered assertion the gate released.
 */
function claimPresentInText(candidate: ClaimCandidateRecord, sourceText: string): boolean {
  return claimTextSupported(candidate, sourceText);
}

function candidateForClassification(
  classification: Record<string, unknown>,
  candidates: ReadonlyMap<string, ClaimCandidateRecord>,
): ClaimCandidateRecord | null {
  if (!validByteRange(classification.span) || typeof classification.kind !== "string") return null;
  const span = classification.span as [number, number];
  return candidates.get(`${classification.kind}:${span[0]}:${span[1]}`) ?? null;
}

const WITNESS_ATOM_REPLAY_LIMIT = 256;

interface WitnessAtomScan {
  hasAnyAtom: boolean;
  overflow: boolean;
  rows: Array<{ rowid: number; source_span: string | null; phase: string }>;
}

interface WitnessReplayContext {
  sources: Map<number, RawEpisode | null>;
  atomScans: Map<number, WitnessAtomScan>;
  targetedAtomScans: Map<string, WitnessAtomScan | null>;
}

function normalizedWitnessAtomScan(
  rows: Array<{ __rowid: number; source_span: string | null; phase: string }>,
): WitnessAtomScan {
  let previous = 0;
  const normalized: WitnessAtomScan["rows"] = [];
  for (const row of rows.slice(0, WITNESS_ATOM_REPLAY_LIMIT)) {
    const rowid = Number(row.__rowid);
    if (!Number.isSafeInteger(rowid) || rowid <= previous) {
      return { hasAnyAtom: rows.length > 0, overflow: true, rows: [] };
    }
    previous = rowid;
    normalized.push({ rowid, source_span: row.source_span, phase: row.phase });
  }
  return {
    hasAnyAtom: rows.length > 0,
    overflow: rows.length > WITNESS_ATOM_REPLAY_LIMIT,
    rows: normalized,
  };
}

function targetedWitnessAtomScan(
  vault: Vault,
  threadId: string,
  seq: Seq,
  candidate: ClaimCandidateRecord,
  context: WitnessReplayContext,
): WitnessAtomScan | null {
  const cacheKey = canonicalHash([seq, candidate.kind, candidate.text]);
  const cached = context.targetedAtomScans.get(cacheKey);
  if (cached !== undefined || context.targetedAtomScans.has(cacheKey)) return cached ?? null;
  // Keep replay's directed probe identical to the live gate: exact indexed
  // values only, never an unbounded substring scan over value/text. A fact
  // candidate may own a numeric atom, so extract scalar numbers regardless of
  // candidate kind.
  const needles = new Set<string>();
  const addNeedle = (value: string): void => {
    const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (normalized.length > 0 && normalized.length <= 512) needles.add(normalized);
  };
  const text = candidate.text.normalize("NFKC").trim();
  addNeedle(text);
  const numberPattern = /(?<![\p{L}\p{N}])\d[\d,]*(?:\.\d+)?(?:\s+[A-Za-z%$]{1,16}){0,2}(?![\p{L}\p{N}])/gu;
  for (const match of text.matchAll(numberPattern)) {
    const number = match[0];
    addNeedle(number);
    addNeedle(number.replace(/,/gu, ""));
  }
  if (needles.size === 0) {
    context.targetedAtomScans.set(cacheKey, null);
    return null;
  }
  const values = [...needles].slice(0, 16);
  const placeholders = values.map(() => "?").join(", ");
  const rows = vault.db
    .query(
      "SELECT rowid AS __rowid, substr(source_span, 1, 256) AS source_span, phase FROM atom " +
        "WHERE thread_id = ? AND source_seq = ? AND value IN (" +
        placeholders +
        ") ORDER BY rowid ASC LIMIT ?",
    )
    .all(threadId, seq, ...values, WITNESS_ATOM_REPLAY_LIMIT + 1) as Array<{
    __rowid: number;
    source_span: string | null;
    phase: string;
  }>;
  const scan = rows.length === 0 ? null : normalizedWitnessAtomScan(rows);
  context.targetedAtomScans.set(cacheKey, scan);
  return scan;
}

/** Find only atoms whose own source span contains this candidate. */
function matchingAtomPhase(
  vault: Vault,
  threadId: string,
  seq: Seq,
  sourceText: string,
  candidate: ClaimCandidateRecord,
  context: WitnessReplayContext,
): string | null {
  let scan = targetedWitnessAtomScan(vault, threadId, seq, candidate, context);
  if (scan === null) {
    scan = context.atomScans.get(seq) ?? null;
    if (scan === null) {
      const rows = vault.db
        .query(
          "SELECT rowid AS __rowid, substr(source_span, 1, 256) AS source_span, phase FROM atom " +
            "WHERE thread_id = ? AND source_seq = ? ORDER BY rowid ASC LIMIT ?",
        )
        .all(threadId, seq, WITNESS_ATOM_REPLAY_LIMIT + 1) as Array<{
        __rowid: number;
        source_span: string | null;
        phase: string;
      }>;
      scan = normalizedWitnessAtomScan(rows);
      context.atomScans.set(seq, scan);
    }
  }
  if (scan.overflow) return "OVERFLOW";
  let matchedPhase: string | null = null;
  for (const atom of scan.rows) {
    if (atom.source_span === null) continue;
    let span: unknown;
    try {
      span = JSON.parse(atom.source_span);
    } catch {
      return "MALFORMED";
    }
    if (!validByteRange(span) || span[1] > sourceText.length) continue;
    const atomText = sourceText.slice(span[0], span[1]);
    if (claimPresentInText(candidate, atomText)) matchedPhase = atom.phase;
  }
  return matchedPhase;
}

/**
 * Re-read an attachment evidence range from the exact retained object and the
 * intersecting hash-addressed spans. The whole object is the durable custody
 * pointer; span objects are independently checked against both their hashes
 * and their corresponding whole-object slice. A malformed/imported range is
 * rejected before any range allocation, and opaque spans never authorize a
 * remembered claim.
 */
function verifiedAttachmentEvidenceRange(
  vault: Vault,
  threadId: string,
  row: RawEpisode,
  manifest: AttachmentManifest,
  range: [number, number],
): Uint8Array | null {
  if (row.role !== "attachment") return null;
  const read = readAttachmentRange(vault, threadId, row.seq, range, { requireIndexed: true });
  if (
    read === null ||
    read.manifest.id !== manifest.id ||
    read.manifest.digest !== manifest.digest ||
    read.manifest.hash !== manifest.hash
  ) {
    return null;
  }
  return read.bytes;
}

/** Re-read a claim locator from the exact source bytes. */
function witnessLocatorFailure(
  vault: Vault,
  threadId: string,
  locator: unknown,
  context: WitnessReplayContext,
  beforeSeq?: Seq,
  candidate?: ClaimCandidateRecord,
): string | null {
  if (!validateLocatorShape(locator)) return "supported witness is malformed";
  const rawLocator = locator as unknown as Record<string, unknown>;
  const evidenceBound =
    rawLocator.seq !== undefined ||
    rawLocator.revision !== undefined ||
    rawLocator.spanHash !== undefined ||
    rawLocator.authority !== undefined ||
    rawLocator.manifestId !== undefined;
  if (evidenceBound && !validateEvidenceLocatorShape(locator)) {
    return "supported evidence witness is malformed";
  }
  const source = locator.source;
  const range = locatorRange(locator);
  const expectedHash = locatorHash(locator);
  let row: RawEpisode | null = null;
  let bytes: Uint8Array | null = null;
  let witnessRangeBytes: Uint8Array | null = null;
  if (source.startsWith("episode:")) {
    const suffix = source.slice("episode:".length);
    const seq = Number(suffix);
    if (!Number.isSafeInteger(seq) || seq <= 0 || suffix !== String(seq)) {
      return "supported witness source is invalid";
    }
    if (beforeSeq !== undefined && seq >= beforeSeq) return "supported witness source is from a later turn";
    if (!context.sources.has(seq)) {
      context.sources.set(
        seq,
        vault.db
          .query(
            "SELECT seq, role, content, content_hash, hash, meta FROM episode WHERE thread_id = ? AND seq = ?",
          )
          .get(threadId, seq) as RawEpisode | null,
      );
    }
    row = context.sources.get(seq) ?? null;
    if (row === null) return "supported witness source is missing";
    const meta = parseRecord(row.meta);
    if (meta?.removed === true) return "supported witness source is tombstoned";
    if (!["user", "tool", "attachment"].includes(row.role)) {
      return "supported witness authority is not current";
    }
    if (row.role === "attachment") {
      return evidenceBound
        ? "supported attachment evidence witness source is invalid"
        : "supported attachment evidence witness is missing";
    }
    if (evidenceBound) {
      const expectedAuthority = row.role as "user" | "tool" | "attachment";
      if (
        rawLocator.seq !== row.seq ||
        rawLocator.revision !== row.hash ||
        rawLocator.authority !== expectedAuthority
      ) {
        return "supported evidence witness binding changed";
      }
      if (rawLocator.manifestId !== undefined) {
        const manifest = parseRecord(meta?.manifest);
        if (manifest?.id !== rawLocator.manifestId) return "supported evidence witness manifest changed";
      }
    }
    bytes = new TextEncoder().encode(row.content);
    if (sha256(bytes) !== row.content_hash) return "supported witness source hash changed";
  } else if (source.startsWith("blob:")) {
    const blobHash = source.slice("blob:".length);
    if (!/^[0-9a-f]{64}$/u.test(blobHash)) return "supported attachment witness source is invalid";
    if (
      !validateEvidenceLocatorShape(locator) ||
      rawLocator.authority !== "attachment" ||
      typeof rawLocator.manifestId !== "string"
    ) {
      return "supported attachment evidence witness is malformed";
    }
    const witnessSeq = rawLocator.seq as number;
    if (!context.sources.has(witnessSeq)) {
      context.sources.set(
        witnessSeq,
        vault.db
          .query(
            "SELECT seq, role, content, content_hash, hash, meta FROM episode " +
              "WHERE thread_id = ? AND seq = ? AND role = 'attachment'",
          )
          .get(threadId, witnessSeq) as RawEpisode | null,
      );
    }
    row = context.sources.get(witnessSeq) ?? null;
    if (row === null) return "supported attachment witness source is missing";
    if (beforeSeq !== undefined && row.seq >= beforeSeq)
      return "supported witness source is from a later turn";
    const meta = parseRecord(row.meta);
    if (meta?.removed === true) return "supported attachment witness source is tombstoned";
    if (row.role !== "attachment") return "supported attachment witness authority is not current";
    const manifest = parseRecord(meta?.manifest);
    if (
      manifest === null ||
      typeof manifest.id !== "string" ||
      typeof manifest.digest !== "string" ||
      typeof manifest.hash !== "string"
    ) {
      return "supported attachment witness manifest is missing";
    }
    if (manifest.hash !== blobHash) {
      return "supported attachment witness manifest hash changed";
    }
    if (expectedHash !== blobHash) {
      return "supported attachment witness hash changed";
    }
    if (manifest.id !== rawLocator.manifestId) {
      return "supported attachment witness manifest changed";
    }
    if (row.hash !== rawLocator.revision) {
      return "supported attachment witness revision changed";
    }
    witnessRangeBytes = verifiedAttachmentEvidenceRange(
      vault,
      threadId,
      row,
      manifest as unknown as AttachmentManifest,
      range,
    );
    if (witnessRangeBytes === null) return "supported attachment witness span is invalid";
  } else {
    return "supported witness source is invalid";
  }
  if (bytes !== null) {
    if (range[1] > bytes.byteLength) return "supported witness range is outside source";
    // A claim-gate ByteLocator binds the entire source digest, while the range
    // makes the exact bytes visible. Requiring both prevents a stale range from
    // being treated as a surviving witness after a source edit.
    if (expectedHash !== sha256(bytes)) return "supported witness source hash changed";
  } else if (witnessRangeBytes === null) {
    return "supported witness bytes are missing";
  }
  const exactBytes = witnessRangeBytes ?? bytes?.slice(range[0], range[1]);
  if (exactBytes === undefined) return "supported witness range is outside source";
  if (typeof rawLocator.spanHash === "string" && sha256(exactBytes) !== rawLocator.spanHash) {
    return "supported witness span hash changed";
  }
  if (candidate !== undefined) {
    let witnessText: string;
    try {
      witnessText = new TextDecoder("utf-8", { fatal: true }).decode(exactBytes);
    } catch {
      return "supported witness range is not valid UTF-8";
    }
    if (!claimPresentInText(candidate, witnessText)) {
      return "supported claim is outside its witness byte range";
    }
    if (row !== null && source.startsWith("episode:")) {
      const phase = matchingAtomPhase(vault, threadId, row.seq, row.content, candidate, context);
      if (phase === "OVERFLOW") return "supported witness atom replay exceeded its bounded source cap";
      if (phase === "MALFORMED") return "supported witness atom span is malformed";
      if (phase === "HISTORICAL") return "supported claim matches a historical atom";
      if (phase === "PROPOSED" || phase === "REVOKED") {
        return "supported claim matches a non-current atom";
      }
    }
  }
  return null;
}

function routeWitnessShapeFailure(witness: unknown): string | null {
  const parsed = parseAddressWitness(witness);
  if (parsed === null) return "address witness is malformed";
  const raw = witness as Record<string, unknown>;
  const allowed = new Set([
    "seq",
    "sourceSeq",
    "source_seq",
    "contentHash",
    "content_hash",
    "sourceHash",
    "source_hash",
    "byteRange",
    "byte_range",
    "span",
    "authority",
    "revision",
    "spanHash",
    "span_hash",
    "source",
    "manifestId",
    "manifest_id",
    "manifest",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return "address witness has unknown fields";
  for (const key of ["source", "revision", "spanHash", "manifestId"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      return "address witness optional binding is malformed";
    }
  }
  const [from, to] = parsed.byteRange;
  if (from < 0 || to < from || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    return "address witness range is malformed";
  }
  if (parsed.contentHash.length === 0 || parsed.authority.length === 0) {
    return "address witness hash or authority is missing";
  }
  if (!CURRENT_ADDRESS_AUTHORITIES.has(parsed.authority)) {
    return "address witness authority is not current";
  }
  return null;
}

function routePacketLinkFailure(vault: Vault, threadId: string, route: AddressRouteRow): string | null {
  if (route.packetId === undefined) {
    return route.packetDigest === undefined ? null : "address route has a packet digest without a packet";
  }
  if (route.packetDigest === undefined) return "address route packet digest is missing";
  const packet = vault.db
    .query("SELECT thread_id, digest FROM packet WHERE id = ? LIMIT 1")
    .get(route.packetId) as { thread_id?: unknown; digest?: unknown } | null;
  if (packet === null || packet.thread_id !== threadId) return "address route packet is missing";
  if (packet.digest !== route.packetDigest) return "address route packet digest mismatch";
  return null;
}

function routeEpisodeLinkFailure(vault: Vault, threadId: string, route: AddressRouteRow): string | null {
  const question = vault.db
    .query("SELECT role FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, route.questionSeq) as { role: string } | null;
  if (question === null || question.role !== "user") return "address route question link is missing";
  if (route.answerSeq !== undefined) {
    const answer = vault.db
      .query("SELECT role FROM episode WHERE thread_id = ? AND seq = ?")
      .get(threadId, route.answerSeq) as { role: string } | null;
    if (answer === null || answer.role !== "assistant") return "address route answer link is missing";
  }
  return null;
}

function routeCommonFailure(
  vault: Vault,
  threadId: string,
  raw: RawRoute,
  route: AddressRouteRow,
): string | null {
  if (route.threadId !== threadId) return "address route thread binding mismatch";
  if (route.id.length === 0 || route.routerVersion.length === 0) return "address route identity is malformed";
  if (!Number.isSafeInteger(route.questionSeq) || route.questionSeq <= 0) {
    return "address route question sequence is malformed";
  }
  if (!Number.isSafeInteger(route.createdAt) || route.createdAt <= 0)
    return "address route timestamp is malformed";
  let canonical: { normalized: string; digest: string };
  try {
    canonical = canonicalAddressQuery(route.normalizedQuery);
  } catch {
    return "address route query identity is malformed";
  }
  if (canonical.normalized !== route.normalizedQuery || canonical.digest !== route.queryDigest) {
    return "address route query digest mismatch";
  }
  const rawWitnesses = parseArray(raw.witnesses);
  const rawSourceSeqs = parseArray(raw.source_seqs);
  if (rawWitnesses === null || rawSourceSeqs === null) return "address route witness JSON is malformed";
  if (rawWitnesses.length !== route.witnesses.length || rawSourceSeqs.length !== route.sourceSeqs.length) {
    return "address route witness count mismatch";
  }
  for (const rawWitness of rawWitnesses) {
    const failure = routeWitnessShapeFailure(rawWitness);
    if (failure !== null) return failure;
  }
  if (!sameCanonical(rawSourceSeqs, route.sourceSeqs)) return "address route source sequence mismatch";
  if (
    !sameCanonical(
      route.sourceSeqs,
      route.witnesses.map((witness) => witness.seq),
    )
  ) {
    return "address route source sequence binding mismatch";
  }
  if (route.witnesses.length === 0) return "address route has no witnesses";
  if (
    route.status === "active" &&
    route.routeDigest !== addressRouteDigestOf(route.queryDigest, route.routerVersion, route.witnesses)
  ) {
    return "address route digest mismatch";
  }
  const packetFailure = routePacketLinkFailure(vault, threadId, route);
  if (packetFailure !== null) return packetFailure;
  const episodeFailure = routeEpisodeLinkFailure(vault, threadId, route);
  if (episodeFailure !== null) return episodeFailure;
  if (
    route.status === "active" &&
    (route.answerSeq === undefined || route.packetId === undefined || route.packetDigest === undefined)
  ) {
    return "active address route answer linkage is missing";
  }
  return null;
}

function receiptFailure(
  vault: Vault,
  threadId: string,
  row: RawEpisode,
  meta: Record<string, unknown>,
): string | null {
  const rawReceipt = parseRecord(meta.answerReceipt);
  const rawDigest = meta.answerReceiptDigest;
  if (rawReceipt === null) return "assistant answer receipt is malformed";
  const receipt = rawReceipt as unknown as AnswerReceipt;
  if (typeof rawDigest !== "string" || rawDigest.length === 0) {
    return "assistant answer receipt digest is missing";
  }
  if (typeof rawReceipt.digest !== "string" || rawReceipt.digest.length === 0) {
    return "answer receipt digest is missing";
  }
  if (rawReceipt.grammarVersion !== CLAIM_GRAMMAR_VERSION) return "answer receipt grammar mismatch";
  if (rawReceipt.status !== "released" && rawReceipt.status !== "qualified") {
    return "answer receipt status is malformed";
  }
  try {
    if (answerReceiptDigestOf(receipt) !== rawReceipt.digest) return "answer receipt digest mismatch";
  } catch {
    return "answer receipt body is not canonical";
  }
  if (rawDigest !== rawReceipt.digest) return "assistant answer receipt digest binding mismatch";
  const answerDigest = meta.removed === true ? row.content_hash : sha256(row.content);
  if (rawReceipt.answerDigest !== answerDigest) return "answer receipt answer digest mismatch";
  if (typeof rawReceipt.scanDigest !== "string") return "answer receipt scan digest is missing";
  const candidates = rawReceipt.candidates;
  if (!Array.isArray(candidates)) return "answer receipt candidates are malformed";
  if (candidates.length > CLAIM_CAPS.maxCandidates) {
    return "answer receipt candidate cap exceeded";
  }
  let candidateBytes = 0;
  try {
    candidateBytes = new TextEncoder().encode(JSON.stringify(candidates)).byteLength;
  } catch {
    return "answer receipt candidates are not canonical";
  }
  if (candidateBytes > CLAIM_CAPS.maxCandidateBytes) {
    return "answer receipt candidate byte cap exceeded";
  }
  const candidateOverflowRaw = rawReceipt.candidateOverflow;
  let candidateOverflow: ClaimScanOverflow | undefined;
  if (candidateOverflowRaw !== undefined) {
    const overflow = parseRecord(candidateOverflowRaw);
    const retainedBytes = overflow?.retainedBytes;
    const observedAtLeast = overflow?.observedAtLeast;
    if (
      overflow === null ||
      (overflow.reason !== "candidate-cap" && overflow.reason !== "candidate-bytes") ||
      overflow.maxCandidates !== CLAIM_CAPS.maxCandidates ||
      overflow.maxCandidateBytes !== CLAIM_CAPS.maxCandidateBytes ||
      overflow.retainedCandidates !== candidates.length ||
      typeof retainedBytes !== "number" ||
      !Number.isSafeInteger(retainedBytes) ||
      retainedBytes < 0 ||
      retainedBytes > CLAIM_CAPS.maxCandidateBytes ||
      typeof observedAtLeast !== "number" ||
      !Number.isSafeInteger(observedAtLeast) ||
      observedAtLeast <= candidates.length
    ) {
      return "answer receipt candidate overflow is malformed";
    }
    candidateOverflow = {
      reason: overflow.reason as ClaimScanOverflow["reason"],
      maxCandidates: overflow.maxCandidates as number,
      maxCandidateBytes: overflow.maxCandidateBytes as number,
      retainedCandidates: overflow.retainedCandidates as number,
      retainedBytes,
      observedAtLeast,
    };
  }
  const qualifications = rawReceipt.qualifications;
  if (!Array.isArray(qualifications) || qualifications.some((value) => typeof value !== "string")) {
    return "answer receipt qualifications are malformed";
  }
  // The qualification block is kernel-authored suffix material, not provider
  // prose. Recover the exact draft that was scanned and reject a receipt whose
  // answer bytes do not end in the receipt's canonical block. This lets the
  // verifier independently rescan a live answer instead of trusting an
  // attacker-edited candidate list/scan digest after re-chaining.
  let scannedAnswer = row.content;
  if (qualifications.length > 0) {
    const suffix = `\n\n${qualifications.join("\n")}`;
    if (!row.content.endsWith(suffix)) return "answer receipt qualification suffix mismatch";
    scannedAnswer = row.content.slice(0, -suffix.length);
  }
  try {
    if (claimScanDigestOf(candidates, candidateOverflow) !== rawReceipt.scanDigest) {
      return "answer receipt scan digest mismatch";
    }
  } catch {
    return "answer receipt candidates are not canonical";
  }
  if (typeof rawReceipt.packetDigest !== "string" || typeof rawReceipt.roundsDigest !== "string") {
    return "answer receipt packet binding is missing";
  }
  if (typeof meta.packetId !== "string" || meta.packetId.length === 0) {
    return "assistant packet binding is missing";
  }
  const packet = vault.packets.byId(meta.packetId);
  if (packet === null) return "assistant packet is missing";
  if (packet.threadId !== threadId || packet.digest !== rawReceipt.packetDigest) {
    return "answer receipt packet digest mismatch";
  }
  if (packet.status !== "done") return "answer receipt packet is not finished";
  if (!Number.isSafeInteger(packet.turnSeq) || packet.turnSeq >= row.seq) {
    return "answer receipt packet turn binding mismatch";
  }
  const question = vault.db
    .query("SELECT role, content, meta FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, packet.turnSeq) as { role: string; content: string; meta: string } | null;
  if (question === null || question.role !== "user") return "answer receipt question binding mismatch";
  // A later forget replaces the question/answer bytes with an authenticated
  // tombstone. Historical receipts remain valid through their immutable hash;
  // there is no plaintext left to rescan in that case. Live receipts, however,
  // must match the current scanner's candidate union exactly.
  let questionMeta: Record<string, unknown> | null = null;
  try {
    questionMeta = parseRecord(question.meta);
  } catch {
    return "answer receipt question metadata is malformed";
  }
  if (meta.removed !== true && questionMeta?.removed !== true) {
    let rescanned: ReturnType<typeof scanRememberedClaimsDetailed>;
    try {
      rescanned = scanRememberedClaimsDetailed(question.content, scannedAnswer);
    } catch {
      return "answer receipt candidate rescan failed";
    }
    if (
      !sameCanonical(rescanned.candidates, candidates) ||
      (candidateOverflow === undefined
        ? rescanned.overflow !== undefined
        : !sameCanonical(rescanned.overflow, candidateOverflow))
    ) {
      return "answer receipt candidates do not match kernel rescan";
    }
  }

  const packetRaw = vault.db
    .query("SELECT messages, rounds, coverage, answer_receipt FROM packet WHERE id = ?")
    .get(packet.id) as {
    messages: string | null;
    rounds: string | null;
    coverage: string | null;
    answer_receipt: string | null;
  } | null;
  if (packetRaw === null) return "answer receipt packet row is missing";
  const retainedPacketMessages = packetRaw.messages === null ? null : parseArray(packetRaw.messages);
  if (packetRaw.messages !== null) {
    if (retainedPacketMessages === null || canonicalHash(retainedPacketMessages) !== packet.digest) {
      return "packet digest mismatch";
    }
  }
  const rounds = packetRaw.rounds === null ? packet.rounds : parseArray(packetRaw.rounds);
  if (rounds === undefined || rounds === null) return "answer receipt rounds are missing";
  const initialPages = (() => {
    const firstRound = Array.isArray(rounds) ? parseRecord(rounds[0]) : null;
    if (firstRound?.pages === undefined) return packet.pages;
    return Array.isArray(firstRound.pages) ? (firstRound.pages as PageRecord[]) : null;
  })();
  if (initialPages === null) return "answer receipt initial pages are malformed";
  const computedRounds = roundsDigestOf(rounds, packet.budget);
  if (computedRounds === null || computedRounds !== rawReceipt.roundsDigest) {
    return "answer receipt rounds digest mismatch";
  }
  const pageFailure = roundPagesFailure(rounds, packet, retainedPacketMessages !== null);
  if (pageFailure !== null) return pageFailure;
  if (typeof meta.roundsDigest !== "string" || meta.roundsDigest !== rawReceipt.roundsDigest) {
    return "assistant rounds digest binding mismatch";
  }
  if (
    packetRaw.answer_receipt === null ||
    !sameCanonical(parseRecord(packetRaw.answer_receipt), rawReceipt)
  ) {
    return "packet answer receipt binding mismatch";
  }
  const packetCoverage = packetRaw.coverage === null ? packet.coverage : parseRecord(packetRaw.coverage);
  const metaCoverage = parseRecord(meta.coverage);
  if (meta.coverage !== undefined && metaCoverage === null) return "assistant coverage is malformed";
  if (metaCoverage !== null && !sameCanonical(metaCoverage, packetCoverage)) {
    return "assistant coverage binding mismatch";
  }
  const receiptCoverageDigest = rawReceipt.coverageDigest;
  if (receiptCoverageDigest !== undefined) {
    if (packetCoverage === null || packetCoverage === undefined) return "answer receipt coverage is missing";
    const packetCoverageRecord = parseRecord(packetCoverage);
    if (packetCoverageRecord === null) return "answer receipt coverage is malformed";
    if (
      rawReceipt.coverageRouterVersion !== packetCoverageRecord.routerVersion ||
      !sameCanonical(rawReceipt.coverageRoutesRun, packetCoverageRecord.routesRun)
    ) {
      return "answer receipt coverage route provenance mismatch";
    }
    const recomputed = coverageDigestOf(packetCoverage);
    if (recomputed === null || recomputed !== receiptCoverageDigest) {
      return "answer receipt coverage digest mismatch";
    }
    const coverageFailure = coverageBindingFailure(
      vault,
      threadId,
      packetCoverage,
      receiptCoverageDigest,
      packet.turnSeq,
      initialPages,
    );
    if (coverageFailure !== null) return coverageFailure;
    if (retainedPacketMessages !== null && retainedPacketMessages.length > 0) {
      let renderedCoverage: string;
      try {
        renderedCoverage = renderCoverage(packetCoverage as unknown as CoverageReceipt);
      } catch {
        return "packet coverage block is malformed";
      }
      const hasCoverageBlock = retainedPacketMessages.some((message) => {
        const item = parseRecord(message);
        return (
          item?.role === "system" &&
          typeof item.content === "string" &&
          item.content.includes(renderedCoverage)
        );
      });
      if (!hasCoverageBlock) return "packet coverage block is missing or changed";
    }
  } else if (packetCoverage !== null && packetCoverage !== undefined) {
    return "answer receipt coverage binding is missing";
  } else if (rawReceipt.coverageRouterVersion !== undefined || rawReceipt.coverageRoutesRun !== undefined) {
    return "answer receipt coverage route provenance is unexpected";
  }
  const classifications = rawReceipt.classifications;
  if (!Array.isArray(classifications)) return "answer receipt classifications are malformed";
  if (classifications.length !== candidates.length) {
    return "answer receipt classification count does not match candidates";
  }
  const candidateIndex = new Map<string, ClaimCandidateRecord>();
  for (const rawCandidate of candidates) {
    const candidate = parseRecord(rawCandidate);
    if (
      candidate === null ||
      !validByteRange(candidate.span) ||
      typeof candidate.kind !== "string" ||
      typeof candidate.text !== "string"
    ) {
      return "answer receipt candidate is malformed";
    }
    const span = candidate.span as [number, number];
    const key = `${candidate.kind}:${span[0]}:${span[1]}`;
    if (candidateIndex.has(key)) return "answer receipt candidate is duplicated";
    candidateIndex.set(key, { span, kind: candidate.kind, text: candidate.text });
  }
  const witnessReplayContext: WitnessReplayContext = {
    sources: new Map(),
    atomScans: new Map(),
    targetedAtomScans: new Map(),
  };
  const closureCache = new Map<string, Set<string> | null>();
  const seenClassifications = new Set<string>();
  for (const entry of classifications) {
    const classification = parseRecord(entry);
    if (
      classification === null ||
      !validByteRange(classification.span) ||
      typeof classification.kind !== "string" ||
      typeof classification.classification !== "string" ||
      !Array.isArray(classification.capabilityDigests) ||
      classification.capabilityDigests.length > CLAIM_CAPS.maxCapabilityDigestsPerClaim ||
      classification.capabilityDigests.some((digest) => typeof digest !== "string")
    ) {
      return "answer receipt classification is malformed";
    }
    if (!CLAIM_CLASSES.has(classification.classification as ClaimClassification)) {
      return "answer receipt classification is unknown";
    }
    if (classification.classification === "WORLD_KNOWLEDGE" && isMemoryQuestion(question.content)) {
      return "world-knowledge classification is invalid for a memory question";
    }
    const candidate = candidateForClassification(classification, candidateIndex);
    if (candidate === null) return "answer receipt classification candidate is missing";
    const classificationKey = canonicalHash([classification.span, classification.kind]);
    if (seenClassifications.has(classificationKey)) return "answer receipt classification is duplicated";
    seenClassifications.add(classificationKey);
    if (classification.basis !== undefined) {
      const basisFailure = coverageBasisFailure(
        vault,
        threadId,
        classification.basis,
        candidate,
        row.content,
        packetCoverage,
        receiptCoverageDigest,
        initialPages,
      );
      if (basisFailure !== null) return basisFailure;
      if (classification.classification !== "SUPPORTED") {
        return "coverage basis is attached to an unsupported classification";
      }
    }
    if (classification.classification === "SUPPORTED") {
      if (classification.basis !== undefined) continue;
      const evidenceWitness = classification.evidenceWitness;
      if (evidenceWitness === undefined) return "supported evidence witness is missing";
      if (!validateEvidenceLocatorShape(evidenceWitness)) return "supported evidence witness is malformed";
      const witness = evidenceWitness ?? classification.witness;
      if (witness === undefined) return "supported claim witness is missing";
      if (evidenceWitness !== undefined && classification.witness !== undefined) {
        if (!sameCanonical(evidenceWitness, classification.witness)) {
          return "supported evidence witness binding mismatch";
        }
      }
      const witnessRecord = parseRecord(witness);
      const witnessSource = (witness as unknown as Record<string, unknown>).source;
      if (
        evidenceWitness === undefined &&
        ((typeof witnessSource === "string" && witnessSource.startsWith("blob:")) ||
          witnessRecord?.authority === "attachment")
      ) {
        return "supported attachment evidence witness is missing";
      }
      const failure = witnessLocatorFailure(
        vault,
        threadId,
        witness,
        witnessReplayContext,
        packet.turnSeq,
        candidate,
      );
      if (
        failure !== null &&
        (!closureCanExplainWitnessFailure(failure) ||
          !hasExplicitRouteClosure(vault, threadId, row.seq, packet.id, packet.digest, witness, closureCache))
      ) {
        return failure;
      }
    }
  }
  if (seenClassifications.size !== candidates.length) {
    return "answer receipt classification set is incomplete";
  }
  const expectedQualifications: string[] = [];
  const seenQualificationClasses = new Set<string>();
  for (const entry of classifications) {
    const classification = parseRecord(entry)?.classification;
    if (
      typeof classification !== "string" ||
      classification === "SUPPORTED" ||
      classification === "WORLD_KNOWLEDGE" ||
      seenQualificationClasses.has(classification)
    ) {
      continue;
    }
    seenQualificationClasses.add(classification);
    const message =
      classification === "HISTORICAL"
        ? "the turn this cites has since been revised"
        : classification === "PROPOSED"
          ? "the turn this cites is an earlier model's words, not the user's"
          : classification === "INFERENCE"
            ? "the archive holds the text; the conclusion is the model's own"
            : "no turn in the archive backs this recollection";
    expectedQualifications.push(`⟨pylos ${classification} · ${message}⟩`);
  }
  if (candidateOverflow !== undefined) {
    expectedQualifications.push(
      "⟨pylos UNKNOWN · too many remembered claims to check inside the receipt budget⟩",
    );
  }
  if (!sameCanonical(expectedQualifications, qualifications)) {
    return "answer receipt qualifications do not match classifications";
  }
  if (rawReceipt.status !== (qualifications.length === 0 ? "released" : "qualified")) {
    return "answer receipt status does not match qualifications";
  }
  return null;
}

function routeClosedByEvent(vault: Vault, threadId: string, routeId: string): boolean {
  return (
    vault.db
      .query(
        "SELECT 1 FROM address_route WHERE thread_id = ? AND invalidated_by = ? " +
          "AND status IN ('invalidated', 'superseded', 'revoked') LIMIT 1",
      )
      .get(threadId, routeId) !== null
  );
}

/**
 * A receipt can outlive its source: forgetting appends a route invalidation
 * event and deliberately preserves the old answer receipt as history.  That
 * closure is the only exception to the current-witness check.  Match the
 * receipt locator to the immutable route payload so a changed receipt witness
 * cannot borrow an unrelated closure.
 */
function hasExplicitRouteClosure(
  vault: Vault,
  threadId: string,
  answerSeq: Seq,
  packetId: string,
  packetDigest: string,
  locator: unknown,
  cache: Map<string, Set<string> | null>,
): boolean {
  if (!tableExists(vault, "address_route") || !validateLocatorShape(locator)) return false;
  const rawLocator = locator as unknown as Record<string, unknown>;
  const range = locatorRange(locator as ByteLocator);
  const source = rawLocator.source;
  const hash = rawLocator.hash;
  if (typeof source !== "string" || typeof hash !== "string") return false;
  const cacheKey = `${threadId}:${answerSeq}:${packetId}:${packetDigest}`;
  const locatorKey = canonicalHash([source, hash, range[0], range[1]]);
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached?.has(locatorKey) ?? false;
  const closedLocators = new Set<string>();
  let cursor = 0;
  let visited = 0;
  const query = vault.db.query(
    "SELECT rowid AS __rowid, * FROM address_route " +
      "WHERE thread_id = ? AND answer_seq = ? AND packet_id = ? AND status = 'active' " +
      "AND rowid > ? ORDER BY rowid ASC LIMIT ?",
  );
  for (;;) {
    const rows = query.all(threadId, answerSeq, packetId, cursor, ADDRESS_ROUTE_BATCH_SIZE) as RawRoute[];
    if (rows.length === 0) {
      cache.set(cacheKey, closedLocators);
      return closedLocators.has(locatorKey);
    }
    for (const raw of rows) {
      visited += 1;
      if (visited > ADDRESS_ROUTE_CLOSURE_LIMIT) {
        cache.set(cacheKey, null);
        return false;
      }
      const rowid = Number(raw.__rowid);
      if (!Number.isSafeInteger(rowid) || rowid <= cursor) return false;
      cursor = rowid;
      const route = parseAddressRouteRow(raw);
      if (
        route === null ||
        route.status !== "active" ||
        route.answerSeq !== answerSeq ||
        route.packetId !== packetId ||
        route.packetDigest !== packetDigest
      ) {
        continue;
      }
      if (route.packetDigest !== packetDigest) continue;
      const closed = vault.db
        .query(
          "SELECT 1 FROM address_route WHERE thread_id = ? AND invalidated_by = ? " +
            "AND status IN ('invalidated', 'superseded', 'revoked') AND rowid > ? LIMIT 1",
        )
        .get(threadId, route.id, rowid);
      if (closed !== null) {
        for (const witness of route.witnesses) {
          const witnessSource = witness.source ?? `episode:${witness.seq}`;
          closedLocators.add(
            canonicalHash([witnessSource, witness.contentHash, witness.byteRange[0], witness.byteRange[1]]),
          );
        }
      }
    }
    if (rows.length < ADDRESS_ROUTE_BATCH_SIZE) {
      cache.set(cacheKey, closedLocators);
      return closedLocators.has(locatorKey);
    }
  }
}

function closureCanExplainWitnessFailure(failure: string): boolean {
  return /(?:source is missing|source is tombstoned|source hash changed|source authority changed|bytes are missing|range is outside source|matches a historical atom|matches a non-current atom)/u.test(
    failure,
  );
}

function sameRoutePayload(left: AddressRouteRow, right: AddressRouteRow): boolean {
  return (
    left.threadId === right.threadId &&
    left.queryDigest === right.queryDigest &&
    left.normalizedQuery === right.normalizedQuery &&
    left.questionSeq === right.questionSeq &&
    left.answerSeq === right.answerSeq &&
    left.packetId === right.packetId &&
    left.packetDigest === right.packetDigest &&
    sameCanonical(left.sourceSeqs, right.sourceSeqs) &&
    sameCanonical(left.witnesses, right.witnesses)
  );
}

function routeEventFailure(
  vault: Vault,
  threadId: string,
  route: AddressRouteRow,
  raw: RawRoute,
): string | null {
  if (route.status === "active") return null;
  if (route.invalidatedBy === undefined || route.reason === undefined || route.reason.length === 0) {
    return "address invalidation parent or reason is missing";
  }
  const rawParent = vault.db
    .query("SELECT rowid AS __rowid, * FROM address_route WHERE id = ? AND thread_id = ?")
    .get(route.invalidatedBy, threadId) as RawRoute | null;
  if (rawParent === null) return "address invalidation parent is missing";
  const parentRowid = Number(rawParent.__rowid);
  const eventRowid = Number(raw.__rowid);
  if (Number.isSafeInteger(parentRowid) && Number.isSafeInteger(eventRowid) && parentRowid >= eventRowid) {
    return "address invalidation parent is not earlier than event";
  }
  const parent = parseAddressRouteRow(rawParent);
  if (parent === null || parent.status !== "active") return "address invalidation parent is invalid";
  if (!sameRoutePayload(parent, route)) return "address invalidation payload mismatch";
  const baseDigest = addressInvalidationDigestOf({
    routeId: parent.id,
    routeDigest: parent.routeDigest,
    routerVersion: route.routerVersion,
    status: route.status,
    reason: route.reason,
  });
  // New events are parent-bound: `invalidated_by` already stores the exact
  // edge being closed, so a second, unstored context cannot be authoritative.
  // Older contextual digests are refused rather than re-derived by scanning
  // every route id (which made verification O(routes²) under duplicate churn).
  return route.routeDigest === baseDigest
    ? null
    : "address invalidation digest uses unsupported legacy context";
}

function verifyRoutes(
  vault: Vault,
  threadId: string,
  sourceCache: AddressSourceReplayCache,
): IntegrityIssue | null {
  if (!tableExists(vault, "address_route")) return null;
  vault.db
    .query(
      "CREATE TEMP TABLE IF NOT EXISTS pylos_verify_address_witness (" +
        "thread_id TEXT NOT NULL, source_seq INTEGER NOT NULL, route_id TEXT NOT NULL, " +
        "ordinal INTEGER NOT NULL, witness TEXT NOT NULL)",
    )
    .run();
  vault.db.query("DELETE FROM temp.pylos_verify_address_witness WHERE thread_id = ?").run(threadId);
  const stage = vault.db.query(
    "INSERT INTO temp.pylos_verify_address_witness (thread_id, source_seq, route_id, ordinal, witness) " +
      "VALUES (?, ?, ?, ?, ?)",
  );
  let cursor = 0;
  const query = vault.db.query(
    "SELECT rowid AS __rowid, * FROM address_route WHERE thread_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
  );
  try {
    for (;;) {
      const rows = query.all(threadId, cursor, ADDRESS_ROUTE_BATCH_SIZE) as RawRoute[];
      if (rows.length === 0) break;
      for (const raw of rows) {
        const rowid = Number(raw.__rowid);
        if (!Number.isSafeInteger(rowid) || rowid <= cursor)
          return { reason: "address route keyset is malformed" };
        cursor = rowid;
        const route = parseAddressRouteRow(raw);
        if (route === null) return { reason: "address route row is malformed" };
        const common = routeCommonFailure(vault, threadId, raw, route);
        if (common !== null) return { reason: common };
        const eventFailure = routeEventFailure(vault, threadId, route, raw);
        if (eventFailure !== null) return { reason: eventFailure };
        const closed = routeClosedByEvent(vault, threadId, route.id);
        if (route.status === "active" && !closed) {
          for (const [ordinal, witness] of route.witnesses.entries()) {
            stage.run(threadId, witness.seq, route.id, ordinal, JSON.stringify(witness));
          }
        }
      }
      if (rows.length < ADDRESS_ROUTE_BATCH_SIZE) break;
    }
    const replay = vault.db.query(
      "SELECT source_seq, witness FROM temp.pylos_verify_address_witness " +
        "WHERE thread_id = ? ORDER BY source_seq ASC, route_id ASC, ordinal ASC",
    );
    try {
      for (const raw of replay.iterate(threadId) as Iterable<{ source_seq: number; witness: string }>) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.witness);
        } catch {
          return { reason: "address witness staging row is malformed" };
        }
        const witness = parseAddressWitness(parsed);
        if (witness === null || witness.seq !== raw.source_seq) {
          return { reason: "address witness staging row is malformed" };
        }
        const failure = addressWitnessFailure(vault, threadId, witness, sourceCache);
        if (failure !== null) return { reason: `active address witness: ${failure}` };
      }
    } finally {
      replay.finalize();
    }
    return null;
  } finally {
    stage.finalize();
    vault.db.query("DELETE FROM temp.pylos_verify_address_witness WHERE thread_id = ?").run(threadId);
  }
}

function verifyAliases(
  vault: Vault,
  threadId: string,
  sourceCache: AddressSourceReplayCache,
): IntegrityIssue | null {
  if (!tableExists(vault, "address_alias")) return null;
  vault.db
    .query(
      "CREATE TEMP TABLE IF NOT EXISTS pylos_verify_address_alias (" +
        "thread_id TEXT NOT NULL, source_seq INTEGER NOT NULL, rowid_value INTEGER NOT NULL, alias TEXT NOT NULL)",
    )
    .run();
  vault.db.query("DELETE FROM temp.pylos_verify_address_alias WHERE thread_id = ?").run(threadId);
  const stage = vault.db.query(
    "INSERT INTO temp.pylos_verify_address_alias (thread_id, source_seq, rowid_value, alias) VALUES (?, ?, ?, ?)",
  );
  let cursor = 0;
  const query = vault.db.query(
    "SELECT rowid AS __rowid, * FROM address_alias WHERE thread_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
  );
  try {
    for (;;) {
      const rows = query.all(threadId, cursor, ADDRESS_BATCH_SIZE) as RawAlias[];
      if (rows.length === 0) break;
      for (const raw of rows) {
        const rowid = Number(raw.__rowid);
        if (!Number.isSafeInteger(rowid) || rowid <= cursor)
          return { reason: "address alias keyset is malformed" };
        cursor = rowid;
        const alias = parseAddressAliasRow(raw);
        if (alias === null) return { reason: "address alias row is malformed" };
        if (raw.thread_id !== threadId || raw.authority !== "model") {
          return { reason: "address alias authority or thread binding mismatch" };
        }
        if (!Number.isSafeInteger(alias.sourceSeq) || alias.sourceSeq <= 0) {
          return { reason: "address alias source sequence is malformed" };
        }
        if (alias.sourceHash.length === 0 || alias.quoteHash.length === 0) {
          return { reason: "address alias hash is missing" };
        }
        if (!Number.isSafeInteger(alias.createdAt) || alias.createdAt <= 0) {
          return { reason: "address alias timestamp is malformed" };
        }
        if (alias.alias !== alias.alias.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase()) {
          return { reason: "address alias normalization mismatch" };
        }
        stage.run(threadId, alias.sourceSeq, rowid, JSON.stringify(alias));
      }
      if (rows.length < ADDRESS_BATCH_SIZE) break;
    }
    const replay = vault.db.query(
      "SELECT alias FROM temp.pylos_verify_address_alias " +
        "WHERE thread_id = ? ORDER BY source_seq ASC, rowid_value ASC",
    );
    try {
      for (const raw of replay.iterate(threadId) as Iterable<{ alias: string }>) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.alias);
        } catch {
          return { reason: "address alias staging row is malformed" };
        }
        const alias = parseAddressAliasRow(parsed as Record<string, unknown>);
        if (alias === null) return { reason: "address alias staging row is malformed" };
        const failure = addressAliasFailure(vault, alias, sourceCache);
        if (failure !== null) return { reason: `address alias: ${failure}` };
      }
    } finally {
      replay.finalize();
    }
    return null;
  } finally {
    stage.finalize();
    vault.db.query("DELETE FROM temp.pylos_verify_address_alias WHERE thread_id = ?").run(threadId);
  }
}

function verifyContinuity(vault: Vault, threadId: string): IntegrityIssue | null {
  const query = vault.db.query(
    "SELECT seq, role, content, content_hash, hash, meta FROM episode " +
      "WHERE thread_id = ? AND role = 'assistant' ORDER BY seq ASC",
  );
  try {
    for (const row of query.iterate(threadId) as Iterable<RawEpisode>) {
      const meta = parseRecord(row.meta);
      if (meta === null) return { seq: row.seq, reason: "assistant metadata is malformed" };
      const hasReceipt = meta.answerReceipt !== undefined || meta.answerReceiptDigest !== undefined;
      if (!hasReceipt) continue;
      const failure = receiptFailure(vault, threadId, row, meta);
      if (failure !== null) return { seq: row.seq, reason: failure };
    }
  } finally {
    query.finalize();
  }
  const packetFailure = verifyStoredPackets(vault, threadId);
  if (packetFailure !== null) return packetFailure;
  // Routes and aliases are staged in source order below, so one source
  // snapshot is sufficient and no archive-sized LRU can accumulate.
  const sourceCache = createAddressSourceReplayCache({ maxEntries: 1 });
  const routeFailure = verifyRoutes(vault, threadId, sourceCache);
  if (routeFailure !== null) return routeFailure;
  return verifyAliases(vault, threadId, sourceCache);
}

/**
 * Verify packet scalar/round invariants for every stored packet, then inspect
 * retained reachability receipts without materializing the packet table or
 * parsing an unbounded imported JSON column. The scalar preflight runs before
 * any packet body read; each bounded keyset batch retains only ids.
 */
function verifyStoredPackets(vault: Vault, threadId: string): IntegrityIssue | null {
  const query = vault.db.query(
    "SELECT rowid AS packet_rowid, id, turn_seq, budget, tokens, status, compiler_version, " +
      "rounds IS NOT NULL AS has_rounds, " +
      "COALESCE(length(CAST(rounds AS BLOB)), 0) AS rounds_bytes, " +
      `CASE WHEN rounds IS NULL THEN 1 WHEN length(CAST(rounds AS BLOB)) <= ${MAX_PACKET_JSON_BYTES} ` +
      "THEN json_valid(rounds) ELSE 0 END AS rounds_valid, " +
      "reachability IS NOT NULL AS has_reachability, " +
      "reachability_as_of_seq IS NOT NULL AS has_reachability_as_of, " +
      "coverage IS NOT NULL AS has_coverage, evidence IS NOT NULL AS has_evidence, " +
      "answer_receipt IS NOT NULL AS has_answer_receipt FROM packet " +
      "WHERE thread_id = ? AND rowid > ? " +
      "ORDER BY rowid ASC LIMIT ?",
  );
  const shapeQuery = vault.db.query(
    "SELECT thread_id, " +
      "length(CAST(resident AS BLOB)) AS resident_bytes, json_valid(resident) AS resident_valid, " +
      "length(CAST(reachability AS BLOB)) AS reachability_bytes, " +
      "json_valid(reachability) AS reachability_valid, reachability_as_of_seq " +
      "FROM packet WHERE id = ? LIMIT 1",
  );
  const bodyQuery = vault.db.query(
    "SELECT resident, reachability, reachability_as_of_seq FROM packet WHERE id = ? LIMIT 1",
  );
  const roundsQuery = vault.db.query("SELECT rounds FROM packet WHERE id = ? LIMIT 1");
  const coverageQuery = vault.db.query(
    "SELECT length(CAST(coverage AS BLOB)) AS coverage_bytes, json_valid(coverage) AS coverage_valid, " +
      "json_extract(coverage, '$.completeness') AS completeness, " +
      "COALESCE(json_extract(coverage, '$.unresolved'), 0) AS unresolved, " +
      "EXISTS(SELECT 1 FROM json_each(json_extract(coverage, '$.routesRun')) " +
      "WHERE json_extract(value, '$.status') = 'unresolved') AS has_unresolved_route " +
      "FROM packet WHERE id = ? LIMIT 1",
  );
  const assistantBindingQuery = vault.db.query(
    "SELECT seq AS answer_seq, json_type(meta, '$.answerReceipt') AS receipt_type, " +
      "json_type(meta, '$.answerReceiptDigest') AS receipt_digest_type " +
      "FROM episode WHERE thread_id = ? AND role = 'assistant' " +
      "AND (CASE WHEN json_valid(meta) = 1 THEN json_extract(meta, '$.packetId') END) = ? " +
      "ORDER BY seq LIMIT 2",
  );
  let cursor = 0;
  let reachabilityReplay: ReturnType<typeof createReachabilityReplay> | null = null;
  try {
    for (;;) {
      const rows = query.all(threadId, cursor, PACKET_BATCH_SIZE) as Array<{
        packet_rowid: number;
        id: string;
        turn_seq: number;
        budget: unknown;
        tokens: unknown;
        has_rounds: number;
        rounds_bytes: unknown;
        rounds_valid: unknown;
        status: string;
        compiler_version: string;
        has_reachability: number;
        has_reachability_as_of: number;
        has_coverage: number;
        has_evidence: number;
        has_answer_receipt: number;
      }>;
      if (rows.length === 0) return null;
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row.packet_rowid) ||
          row.packet_rowid <= cursor ||
          typeof row.id !== "string" ||
          row.id.length === 0 ||
          !Number.isSafeInteger(row.turn_seq) ||
          row.turn_seq <= 0
        ) {
          return { reason: "stored packet keyset is malformed" };
        }
        cursor = row.packet_rowid;
        const tokenFailure = packetTokensFailure(row.tokens, row.budget);
        if (tokenFailure !== null) {
          return { seq: row.turn_seq, reason: `stored packet ${tokenFailure}` };
        }
        if (
          row.has_rounds !== 0 &&
          (!Number.isSafeInteger(row.rounds_bytes) ||
            (row.rounds_bytes as number) < 0 ||
            (row.rounds_bytes as number) > MAX_PACKET_JSON_BYTES ||
            row.rounds_valid !== 1)
        ) {
          return { seq: row.turn_seq, reason: "stored packet rounds failed preflight" };
        }
        if (row.has_rounds !== 0) {
          const rawRounds = roundsQuery.get(row.id) as { rounds: string | null } | null;
          const rounds = rawRounds?.rounds == null ? null : parseArray(rawRounds.rounds);
          if (rounds === null) return { seq: row.turn_seq, reason: "stored packet rounds are malformed" };
          const roundsFailure = packetRoundsFailure(rounds, row.budget);
          if (roundsFailure !== null) return { seq: row.turn_seq, reason: roundsFailure };
        }
        const supportBearing =
          row.has_coverage === 1 || row.has_evidence === 1 || row.has_answer_receipt === 1;
        // Compiler v1 predates answer receipts: a completed historical packet
        // was a request transcript, never claim authority.  Its authenticated
        // compiler marker is the only compatibility gate; adding any support
        // field opts the row into the current strict binding contract.
        const legacyReceiptless = row.compiler_version === "1" && !supportBearing;
        const requiresAnswerBinding = !legacyReceiptless && (row.status === "done" || supportBearing);
        if (requiresAnswerBinding) {
          if (row.status !== "done" || row.has_answer_receipt !== 1) {
            return { seq: row.turn_seq, reason: "done or support-bearing packet has no answer receipt" };
          }
          const bindings = assistantBindingQuery.all(threadId, row.id) as Array<{
            answer_seq: number;
            receipt_type: string | null;
            receipt_digest_type: string | null;
          }>;
          const binding = bindings[0];
          if (
            bindings.length !== 1 ||
            binding === undefined ||
            binding.receipt_type !== "object" ||
            binding.receipt_digest_type !== "text" ||
            !Number.isSafeInteger(binding.answer_seq) ||
            binding.answer_seq <= row.turn_seq
          ) {
            return {
              seq: row.turn_seq,
              reason: "support-bearing packet has no exact assistant answer binding",
            };
          }
        }
        if (row.has_reachability !== row.has_reachability_as_of) {
          return {
            seq: row.turn_seq,
            reason: "stored packet reachability fields are only partially present",
          };
        }
        if (row.has_reachability !== 1) continue;
        const shape = shapeQuery.get(row.id) as {
          thread_id: unknown;
          resident_bytes: unknown;
          resident_valid: unknown;
          reachability_bytes: unknown;
          reachability_valid: unknown;
          reachability_as_of_seq: unknown;
        } | null;
        if (
          shape === null ||
          shape.thread_id !== threadId ||
          !Number.isSafeInteger(shape.resident_bytes) ||
          (shape.resident_bytes as number) < 0 ||
          (shape.resident_bytes as number) > MAX_PACKET_JSON_BYTES ||
          shape.resident_valid !== 1 ||
          !Number.isSafeInteger(shape.reachability_bytes) ||
          (shape.reachability_bytes as number) < 0 ||
          (shape.reachability_bytes as number) > MAX_PACKET_JSON_BYTES ||
          shape.reachability_valid !== 1 ||
          !Number.isSafeInteger(shape.reachability_as_of_seq)
        ) {
          return { seq: row.turn_seq, reason: "stored packet reachability projection failed preflight" };
        }
        let packet: {
          turnSeq: number;
          resident: unknown;
          reachability: unknown;
          reachabilityAsOfSeq: unknown;
        };
        try {
          const body = bodyQuery.get(row.id) as {
            resident: string;
            reachability: string;
            reachability_as_of_seq: unknown;
          } | null;
          if (body === null) throw new Error("missing packet projection");
          packet = {
            turnSeq: row.turn_seq,
            resident: JSON.parse(body.resident) as unknown,
            reachability: JSON.parse(body.reachability) as unknown,
            reachabilityAsOfSeq: body.reachability_as_of_seq,
          };
        } catch {
          return { seq: row.turn_seq, reason: "stored packet reachability projection is malformed" };
        }
        reachabilityReplay ??= createReachabilityReplay(vault, threadId);
        const reachability = reachabilityReplay.verify(packet);
        if (!reachability.ok) {
          const unavailableAttachment = /(?:attachment|manifest)/iu.test(reachability.reason ?? "");
          let unresolvedCoverage = false;
          if (unavailableAttachment) {
            const coverage = coverageQuery.get(row.id) as {
              coverage_bytes: unknown;
              coverage_valid: unknown;
              completeness: unknown;
              unresolved: unknown;
              has_unresolved_route: unknown;
            } | null;
            unresolvedCoverage =
              coverage !== null &&
              Number.isSafeInteger(coverage.coverage_bytes) &&
              (coverage.coverage_bytes as number) >= 0 &&
              (coverage.coverage_bytes as number) <= MAX_PACKET_RESPONSE_BYTES &&
              coverage.coverage_valid === 1 &&
              coverage.completeness !== "complete" &&
              ((typeof coverage.unresolved === "number" && coverage.unresolved > 0) ||
                coverage.has_unresolved_route === 1);
          }
          // Attachment custody can already be explicitly unresolved at the
          // issuance snapshot (missing bytes, opaque data, or malformed imported
          // metadata).  That is a genuine incomplete coverage receipt, not a
          // false claim that the archive was closed. Structural reachability
          // failures and every episode-closure omission still fail closed.
          if (unresolvedCoverage && unavailableAttachment) continue;
          return {
            seq: row.turn_seq,
            reason: `stored packet reachability: ${reachability.reason ?? "verification failed"}`,
          };
        }
      }
      if (rows.length < PACKET_BATCH_SIZE) return null;
    }
  } finally {
    query.finalize();
    shapeQuery.finalize();
    bodyQuery.finalize();
    roundsQuery.finalize();
    coverageQuery.finalize();
    assistantBindingQuery.finalize();
  }
}

function verifyFragment(vault: Vault, threadId: string, thread: Thread): VerifyResult {
  const fragment = vault.fragments.get(threadId);
  if (fragment === null) throw new VaultError(`thread ${threadId} is not an authenticated fragment`);
  const boundary = {
    originalThreadId: fragment.originalThreadId,
    fromSeq: fragment.fromSeq,
    toSeq: fragment.toSeq,
    prevHash: fragment.prevHash,
    headHash: fragment.headHash,
  };
  const result = (
    fragmentVerified: boolean,
    checkedTo: Seq,
    reason: string,
    failedAt?: Seq,
  ): VerifyResult => ({
    ok: false,
    headHash: thread.headHash,
    checkedFrom: fragment.fromSeq - 1,
    checkedTo,
    ...(failedAt === undefined ? {} : { failedAt }),
    reason,
    fragmentVerified,
    fragment: boundary,
  });
  if (
    fragment.threadId !== threadId ||
    typeof fragment.originalThreadId !== "string" ||
    fragment.originalThreadId.length === 0 ||
    !Number.isSafeInteger(fragment.fromSeq) ||
    fragment.fromSeq <= 0 ||
    !Number.isSafeInteger(fragment.toSeq) ||
    fragment.toSeq < fragment.fromSeq ||
    !/^[0-9a-f]{64}$/u.test(fragment.prevHash) ||
    !/^[0-9a-f]{64}$/u.test(fragment.headHash) ||
    !Number.isSafeInteger(fragment.createdAt) ||
    fragment.createdAt <= 0
  ) {
    return result(false, Math.max(0, fragment.fromSeq - 1), "authenticated fragment boundary is malformed");
  }
  if (thread.headSeq !== fragment.toSeq || thread.headHash !== fragment.headHash) {
    return result(
      false,
      fragment.fromSeq - 1,
      "authenticated fragment thread head binding mismatch",
      fragment.toSeq,
    );
  }
  const extent = vault.db
    .query(
      "SELECT COUNT(*) AS count, MIN(seq) AS from_seq, MAX(seq) AS to_seq FROM episode WHERE thread_id = ?",
    )
    .get(threadId) as { count: number; from_seq: number | null; to_seq: number | null } | null;
  const expectedCount = fragment.toSeq - fragment.fromSeq + 1;
  if (
    extent === null ||
    extent.count !== expectedCount ||
    extent.from_seq !== fragment.fromSeq ||
    extent.to_seq !== fragment.toSeq
  ) {
    return result(
      false,
      fragment.fromSeq - 1,
      "authenticated fragment episode extent mismatch",
      fragment.fromSeq,
    );
  }

  let checkedTo = fragment.fromSeq - 1;
  let prevHash = fragment.prevHash;
  const rowsQuery = vault.db.query(
    "SELECT seq, ts, role, model, provider, content, content_hash, prev_hash, hash, meta FROM episode " +
      "WHERE thread_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC",
  );
  try {
    for (const row of rowsQuery.iterate(threadId, fragment.fromSeq, fragment.toSeq) as Iterable<Row>) {
      if (row.seq !== checkedTo + 1) {
        return result(false, checkedTo, "authenticated fragment episode sequence gap", row.seq);
      }
      if (row.prev_hash !== prevHash) {
        return result(false, checkedTo, "authenticated fragment prev_hash mismatch", row.seq);
      }
      let meta: EpisodeMeta;
      try {
        meta = JSON.parse(row.meta) as EpisodeMeta;
      } catch {
        return result(false, checkedTo, "authenticated fragment episode metadata is malformed", row.seq);
      }
      const expected = chainHash(
        prevHash,
        chainRecord({
          seq: row.seq,
          ts: row.ts,
          role: row.role,
          ...(row.model === null ? {} : { model: row.model }),
          ...(row.provider === null ? {} : { provider: row.provider }),
          contentHash: row.content_hash,
          metaHash: metaHashOf(meta),
        }),
      );
      if (expected !== row.hash) {
        return result(false, checkedTo, "authenticated fragment hash mismatch", row.seq);
      }
      if (meta.removed === true) {
        const problem = removalProblem(vault, threadId, row.seq, meta.tombstone);
        if (problem !== null) return result(false, checkedTo, problem, row.seq);
      } else if (sha256(row.content) !== row.content_hash) {
        return result(
          false,
          checkedTo,
          "authenticated fragment content does not match content_hash",
          row.seq,
        );
      }
      prevHash = row.hash;
      checkedTo = row.seq;
    }
  } finally {
    rowsQuery.finalize();
  }
  if (checkedTo !== fragment.toSeq || prevHash !== fragment.headHash) {
    return result(false, checkedTo, "authenticated fragment does not reach its declared head", checkedTo + 1);
  }
  return result(true, checkedTo, "authenticated fragment verified; full genesis continuity is unavailable");
}

/**
 * Replay the chain and compare. Also checks, for every episode whose content has
 * not been redacted by `forget`, that `sha256(content) === content_hash` — so a
 * silent edit of the stored text is caught even though the chain covers the hash.
 *
 * A pass records how far it certified (`vault.verifiedFrontier`), so a later
 * reader can state the frontier without replaying; a failure withdraws that
 * record, since the run that just failed disproves it.
 */
export function verify(vault: Vault, threadId: string, options: { full?: boolean } = {}): VerifyResult {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);
  // A fragment is authenticated between its own bounds; it has no genesis
  // continuity to certify, so it never carries a frontier.
  if (vault.fragments.get(threadId) !== null) return verifyFragment(vault, threadId, thread);
  const result = replayChain(vault, threadId, thread, options);
  if (result.ok) vault.putVerifiedFrontier(threadId, result.checkedTo, result.headHash);
  else vault.clearVerifiedFrontier(threadId);
  return result;
}

function replayChain(
  vault: Vault,
  threadId: string,
  thread: Thread,
  options: { full?: boolean },
): VerifyResult {
  const checkpoint = options.full === true ? null : vault.checkpointBefore(threadId, thread.headSeq);
  const startSeq = checkpoint?.seq ?? 0;
  let prevHash = checkpoint?.hash ?? genesisHash(threadId);
  const fail = (reason: string, checkedTo: Seq, failedAt?: Seq): VerifyResult => ({
    ok: false,
    headHash: thread.headHash,
    checkedTo,
    checkedFrom: startSeq,
    ...(failedAt === undefined ? {} : { failedAt }),
    reason,
  });

  // `head_seq` and `head_hash` can be forged together after deleting the tail.
  // The maintained episode counter is an independent O(1) row count receipt;
  // require it before the empty-thread fast path or a missing entire archive
  // could be presented as a fresh thread.
  const episodeCount = vault.counter(threadId, COUNTERS.episodes);
  if (!Number.isSafeInteger(episodeCount) || episodeCount < 0 || episodeCount !== thread.headSeq) {
    return fail("episode count does not match thread head sequence", startSeq, thread.headSeq);
  }
  if (thread.headSeq === 0) {
    const packetFailure = verifyStoredPackets(vault, threadId);
    if (packetFailure !== null) {
      return {
        ok: false,
        headHash: thread.headHash,
        checkedTo: 0,
        checkedFrom: 0,
        ...(packetFailure.seq === undefined ? {} : { failedAt: packetFailure.seq }),
        reason: packetFailure.reason,
      };
    }
    return { ok: true, headHash: thread.headHash, checkedTo: 0, checkedFrom: 0 };
  }

  // A checkpoint skips replay of its certified prefix, but it must still be
  // anchored to the exact stored episode and its immediate predecessor. This
  // catches deletion of the anchor or the row directly before it without
  // turning incremental verification into an archive-length scan.
  if (checkpoint !== null) {
    if (
      !Number.isSafeInteger(checkpoint.seq) ||
      checkpoint.seq <= 0 ||
      checkpoint.seq > thread.headSeq ||
      checkpoint.seq % CHECKPOINT_EVERY !== 0
    ) {
      return fail("chain checkpoint sequence is invalid", startSeq, checkpoint.seq);
    }
    const anchor = vault.db
      .query(
        "SELECT seq, ts, role, model, provider, content, content_hash, prev_hash, hash, meta " +
          "FROM episode WHERE thread_id = ? AND seq = ?",
      )
      .get(threadId, checkpoint.seq) as Row | null;
    if (anchor === null || anchor.hash !== checkpoint.hash) {
      return fail("chain checkpoint anchor is missing or changed", startSeq, checkpoint.seq);
    }
    const predecessor = vault.db
      .query("SELECT seq, hash FROM episode WHERE thread_id = ? AND seq = ?")
      .get(threadId, checkpoint.seq - 1) as { seq: number; hash: string } | null;
    if (
      predecessor === null ||
      predecessor.seq !== checkpoint.seq - 1 ||
      anchor.prev_hash !== predecessor.hash
    ) {
      return fail("chain checkpoint predecessor is missing or changed", startSeq, checkpoint.seq - 1);
    }
    let anchorMeta: EpisodeMeta;
    try {
      anchorMeta = JSON.parse(anchor.meta) as EpisodeMeta;
    } catch {
      return fail("chain checkpoint metadata is malformed", startSeq, checkpoint.seq);
    }
    const expectedAnchor = chainHash(
      anchor.prev_hash,
      chainRecord({
        seq: anchor.seq,
        ts: anchor.ts,
        role: anchor.role,
        ...(anchor.model === null ? {} : { model: anchor.model }),
        ...(anchor.provider === null ? {} : { provider: anchor.provider }),
        contentHash: anchor.content_hash,
        metaHash: metaHashOf(anchorMeta),
      }),
    );
    if (expectedAnchor !== anchor.hash) {
      return fail("chain checkpoint hash mismatch", startSeq, checkpoint.seq);
    }
    if (anchorMeta.removed === true) {
      const problem = removalProblem(vault, threadId, anchor.seq, anchorMeta.tombstone);
      if (problem !== null) return fail(problem, startSeq, checkpoint.seq);
    } else if (sha256(anchor.content) !== anchor.content_hash) {
      return fail("chain checkpoint content does not match content_hash", startSeq, checkpoint.seq);
    }
  }

  let checkedTo = startSeq;
  const rowsQuery = vault.db.query(
    "SELECT seq, ts, role, model, provider, content, content_hash, prev_hash, hash, meta FROM episode " +
      "WHERE thread_id = ? AND seq > ? ORDER BY seq ASC",
  );
  try {
    for (const row of rowsQuery.iterate(threadId, startSeq) as Iterable<Row>) {
      if (row.seq !== checkedTo + 1) {
        return fail("episode sequence gap", checkedTo, row.seq);
      }
      if (row.prev_hash !== prevHash) {
        return {
          ok: false,
          headHash: thread.headHash,
          checkedTo,
          checkedFrom: startSeq,
          failedAt: row.seq,
          reason: "prev_hash mismatch",
        };
      }
      let meta: EpisodeMeta;
      try {
        meta = JSON.parse(row.meta) as EpisodeMeta;
      } catch {
        return {
          ok: false,
          headHash: thread.headHash,
          checkedTo,
          checkedFrom: startSeq,
          failedAt: row.seq,
          reason: "episode metadata is malformed",
        };
      }
      const expected = chainHash(
        prevHash,
        chainRecord({
          seq: row.seq,
          ts: row.ts,
          role: row.role,
          ...(row.model === null ? {} : { model: row.model }),
          ...(row.provider === null ? {} : { provider: row.provider }),
          contentHash: row.content_hash,
          metaHash: metaHashOf(meta),
        }),
      );
      if (expected !== row.hash) {
        return {
          ok: false,
          headHash: thread.headHash,
          checkedTo,
          checkedFrom: startSeq,
          failedAt: row.seq,
          reason: "hash mismatch",
        };
      }
      if (meta.removed === true) {
        const problem = removalProblem(vault, threadId, row.seq, meta.tombstone);
        if (problem !== null) {
          return {
            ok: false,
            headHash: thread.headHash,
            checkedTo,
            checkedFrom: startSeq,
            failedAt: row.seq,
            reason: problem,
          };
        }
      } else if (sha256(row.content) !== row.content_hash) {
        return {
          ok: false,
          headHash: thread.headHash,
          checkedTo,
          checkedFrom: startSeq,
          failedAt: row.seq,
          reason: "content does not match content_hash",
        };
      }
      prevHash = row.hash;
      checkedTo = row.seq;
      if (row.seq % CHECKPOINT_EVERY === 0) vault.putCheckpoint(threadId, row.seq, row.hash);
    }
  } finally {
    rowsQuery.finalize();
  }

  if (checkedTo !== thread.headSeq) {
    return fail("episode sequence does not reach thread head", checkedTo, checkedTo + 1);
  }

  if (prevHash !== thread.headHash) {
    return {
      ok: false,
      headHash: thread.headHash,
      checkedTo,
      checkedFrom: startSeq,
      failedAt: checkedTo,
      reason: "head hash mismatch",
    };
  }
  const continuity = verifyContinuity(vault, threadId);
  if (continuity !== null) {
    return {
      ok: false,
      headHash: thread.headHash,
      checkedTo,
      checkedFrom: startSeq,
      ...(continuity.seq === undefined ? {} : { failedAt: continuity.seq }),
      reason: continuity.reason,
    };
  }
  return { ok: true, headHash: thread.headHash, checkedTo, checkedFrom: startSeq };
}

/**
 * Why this episode's `removed` flag is not backed by a removal (KERNEL A10.6),
 * or `null` if it is.
 *
 * `meta.removed` is outside `meta_hash` — it has to be, since the chain is
 * immutable — so on its own it is a way to skip the `content_hash` check by
 * editing the database. It is backed instead by two records the chain does
 * cover: a tombstone, and a later `system` episode whose content names both this
 * seq and that tombstone.
 */
function removalProblem(vault: Vault, threadId: string, seq: Seq, tombstoneId: unknown): string | null {
  if (typeof tombstoneId !== "string" || tombstoneId.length === 0) return "removed without a tombstone";
  const tombstone = vault.db
    .query("SELECT removal_seq FROM tombstone WHERE id = ? AND thread_id = ?")
    .get(tombstoneId, threadId) as { removal_seq: number | null } | undefined;
  if (tombstone == null) return "removed without a tombstone";
  // Removals from before the amendment have no chain event and cannot be given
  // one retroactively; the migration marks them, and nothing else may be 0.
  if (tombstone.removal_seq === 0) return null;
  if (tombstone.removal_seq === null || tombstone.removal_seq <= seq) {
    return "removed without a chain-bound removal record";
  }
  const record = vault.db
    .query("SELECT role, content FROM episode WHERE thread_id = ? AND seq = ?")
    .get(threadId, tombstone.removal_seq) as { role: string; content: string } | undefined;
  if (record == null || record.role !== "system" || !removalRecord(record.content, tombstoneId).has(seq)) {
    return "removed without a chain-bound removal record";
  }
  return null;
}
