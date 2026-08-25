/**
 * @pylos/protocol — shared types and the local API contract.
 * No runtime dependencies. Everything the kernel, server and UIs agree on lives here.
 */

// ---------- identities ----------
export type ThreadId = string;
export type Seq = number; // 1-based, monotonic per thread
export type Sha256 = string; // lowercase hex

// ---------- threads ----------
/** Maximum UTF-8 title payload accepted when a thread is created. */
export const MAX_THREAD_TITLE_BYTES = 4 * 1024;
/** Maximum UTF-8 thread id retained by a bounded list cursor. */
export const MAX_THREAD_ID_BYTES = 256;
/** Maximum UTF-8 model identifier retained in thread statistics. */
export const MAX_THREAD_MODEL_BYTES = 512;
/** Maximum positive token budget accepted by a thread request or setting. */
export const MAX_THREAD_BUDGET = 1_000_000;
/** Compaction admission work bounds for one exact source episode. */
export const CAPSULE_SOURCE_EPISODE_BYTES = 1024 * 1024;
export const CAPSULE_SOURCE_NAMES_PER_EPISODE = 4096;
export const CAPSULE_SOURCE_NAMES_PER_RANGE = 32 * CAPSULE_SOURCE_NAMES_PER_EPISODE;
/** Maximum serialized thread settings retained by runtime projections. */
export const MAX_THREAD_SETTINGS_BYTES = 16 * 1024;
/** Maximum rows materialized by one thread-list page. */
export const MAX_THREAD_LIST_ROWS = 64;
/** Maximum serialized size of one projected thread row. */
export const MAX_THREAD_LIST_ROW_BYTES = MAX_THREAD_TITLE_BYTES + 16 * 1024;
/** Maximum serialized size of a thread-list response envelope. */
export const MAX_THREAD_LIST_RESPONSE_BYTES = 256 * 1024;

export interface ThreadListOptions {
  /** Opaque keyset cursor returned by the previous page. */
  after?: string;
  /** Requested page size; the kernel clamps this to MAX_THREAD_LIST_ROWS. */
  limit?: number;
}

export interface ThreadListPage {
  threads: ThreadStats[];
  byteLength: number;
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * Exact fractional caps used by the packet compiler. The four slots are
 * deliberately required together: a partial map cannot be interpreted as a
 * safe allocation (missing values would become `undefined`/`NaN`).
 */
export interface BudgetShares {
  header: number;
  frontier: number;
  capsules: number;
  paged: number;
}

/** Per-thread tunables. All optional; the kernel supplies defaults. */
export interface ThreadSettings {
  budget?: number; // packet token budget
  model?: string; // default model
  shares?: BudgetShares;
  capsuleTokens?: { leaf?: number; mid?: number; root?: number };
  [k: string]: unknown;
}

/** The one lifelong conversation (KERNEL §0). */
export interface Thread {
  id: ThreadId;
  title: string;
  createdAt: number;
  headSeq: Seq;
  headHash: Sha256;
  settings: ThreadSettings;
}

// ---------- episodes (exact archive) ----------
export type Role = "user" | "assistant" | "tool" | "system" | "attachment" | "handoff";

/** Maximum UTF-8 filename retained in a new attachment manifest/episode meta. */
export const MAX_ATTACHMENT_NAME_BYTES = 4 * 1024;
/** Maximum UTF-8 MIME label retained in a new attachment manifest/episode meta. */
export const MAX_ATTACHMENT_MIME_BYTES = 512;

export interface Episode {
  threadId: ThreadId;
  seq: Seq;
  ts: number; // unix ms
  role: Role;
  model?: string; // for assistant/handoff
  provider?: string;
  content: string; // exact text; large payloads summarized inline with meta.blob
  tokens: number;
  prevHash: Sha256;
  hash: Sha256;
  meta: EpisodeMeta;
}

/**
 * A server-authorized transcript projection. The archive remains exact in the
 * kernel; ordinary readers receive a UTF-8 prefix plus a receipt that names
 * the exact source bytes and chain revision behind it.
 */
export interface EpisodeView extends Episode {
  /** Full UTF-8 byte length in the archive, not the retained prefix length. */
  contentBytes: number;
  contentTruncated: boolean;
  locator?: {
    source: string;
    byteRange: [number, number];
    contentHash: Sha256;
    revision: Sha256;
  };
  /** Original immutable content hash retained for a tombstoned row; no locator is issued for redacted bytes. */
  originalContentHash?: Sha256;
  locatorOmittedReason?: "removed" | "metadata-truncated";
  continuation?: {
    source: string;
    from: number;
    to: number;
    fullBytes: number;
  };
  /** Metadata is independently bounded so an imported manifest cannot escape through `meta`. */
  metaBytes?: number;
  metaTruncated?: boolean;
}

export interface EpisodePage {
  episodes: EpisodeView[];
  byteLength: number;
  truncated: boolean;
  continuation?: {
    source: "episode-page" | "search";
    omittedLowerBound: number;
    omittedUnknown: boolean;
    before?: Seq;
    after?: Seq;
    reason: "response-byte-cap";
  };
}

export interface SearchPage {
  episodes: EpisodeView[];
  atoms: Atom[];
  byteLength: number;
  truncated: boolean;
  continuation?: EpisodePage["continuation"];
}

/** Aggregate JSON cap for ordinary transcript/search readers. */
export const MAX_TRANSCRIPT_RESPONSE_BYTES = 256 * 1024;

export interface EpisodeMeta {
  blob?: Sha256; // content-addressed attachment
  manifest?: AttachmentManifest; // A12: byte-exact attachment partition
  mime?: string;
  name?: string; // attachment file name
  size?: number;
  packetId?: string; // for assistant episodes: the packet they were produced from
  usage?: Usage;
  pages?: PageRecord[];
  from?: string; // handoff: previous model
  to?: string; // handoff: next model
  check?: { names: string[]; status: CheckStatus; draftSha256: Sha256 }; // assistant: the verification round
  roundsDigest?: Sha256; // assistant: canonical digest of all retained RequestRound evidence fields
  coverage?: CoverageReceipt; // A13: collection-route lower bound
  answerReceipt?: AnswerReceipt; // A14: classifications released with this answer
  answerReceiptDigest?: Sha256;
  removed?: boolean; // tombstoned content
  [k: string]: unknown;
}

// ---------- retained-byte closure and attachments (KERNEL A12) ----------
export type AttachmentSpanState = "indexed" | "opaque";

export interface AttachmentSpan {
  ordinal: number;
  from: number; // byte offset, inclusive
  to: number; // byte offset, exclusive
  hash: Sha256;
  state: AttachmentSpanState;
  objectHash: Sha256;
  encoding?: "utf-8";
}

export interface AttachmentManifest {
  id: string;
  hash: Sha256; // whole-object digest
  digest: Sha256; // canonical manifest digest
  size: number;
  mime: string;
  name: string;
  chunkSize: number;
  spans: AttachmentSpan[];
  legacy?: boolean;
}

export type ReachabilityState = "resident" | "capsule" | "pageable" | "opaque";

export interface ByteLocator {
  source: string; // episode:<seq> | blob:<sha256>
  from: number;
  to: number;
  hash: Sha256;
}

/**
 * Kernel bounds for the append-only A15 route payload.  These are protocol
 * constants because route rows cross the core, bundle, server, and verifier
 * boundaries.  A route that exceeds either bound is malformed and must be
 * rejected before its witness arrays are parsed.
 */
export const MAX_ADDRESS_ROUTE_ITEMS = 256;
export const MAX_ADDRESS_ROUTE_JSON_BYTES = 128 * 1024;
export const MAX_ADDRESS_ROUTE_ROW_BYTES = 256 * 1024;

/**
 * A receipt witness bound to the exact durable authority that supplied the
 * bytes.  `ByteLocator` remains the compact route shape; this additive type is
 * required for A14 evidence so two attachment episodes sharing one blob hash
 * cannot become interchangeable provenance.
 */
export interface EvidenceLocator extends ByteLocator {
  seq: Seq;
  revision: string;
  spanHash: Sha256;
  authority: EvidenceAuthority;
  manifestId?: string;
}

export interface ExplicitReachabilitySpan extends ByteLocator {
  kind?: "episode" | "attachment";
  state: ReachabilityState;
  locator?: ByteLocator;
  capsuleId?: string;
  manifest?: string;
}

export interface EpisodeRangeReachabilitySpan {
  kind: "episode-range";
  fromSeq: Seq;
  toSeq: Seq;
  state: "capsule" | "pageable";
  locatorTemplate?: "episode:{seq}";
  capsuleId?: string;
  digest?: Sha256;
}

/** Sparse range over attachment episodes; each locator opens its chain-bound manifest. */
export interface AttachmentRangeReachabilitySpan {
  kind: "attachment-range";
  /** Version 2 is an indexed first/last envelope; legacy rows omit this. */
  version?: 2;
  fromSeq: Seq;
  toSeq: Seq;
  state: "pageable";
  locatorTemplate: "attachment:{seq}";
  digest: Sha256;
}

export type ReachabilitySpan =
  | ExplicitReachabilitySpan
  | EpisodeRangeReachabilitySpan
  | AttachmentRangeReachabilitySpan;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
}

// ---------- atoms (derived memory IR) ----------
export type AtomKind =
  | "identity"
  | "fact"
  | "preference"
  | "decision"
  | "promise"
  | "task"
  | "correction"
  | "hypothesis";
/** PROPOSED: asserted by an assistant or a model extractor; visible, never a certificate (KERNEL A9.1). */
export type AtomPhase = "PROPOSED" | "SUPPORTED" | "HISTORICAL" | "REVOKED";
/** Who asserted an atom: the source episode's role, or a model extractor. Assistant/model atoms may propose, never authorize. */
export type AtomAuthority = "user" | "assistant" | "model";

export interface Atom {
  id: string;
  threadId: ThreadId;
  kind: AtomKind;
  key: string; // normalized slot e.g. "user.location"
  value: string;
  text: string; // human sentence
  sourceSeq: Seq;
  sourceSpan?: [number, number];
  validFromSeq: Seq;
  validToSeq?: Seq;
  supersededBy?: string;
  phase: AtomPhase;
  authority: AtomAuthority;
  scope: string;
  pinned: boolean;
  confidence: number;
  createdBy: string; // "rule:<name>" | "model:<id>" | "user"
  createdAt: number;
}

/** Kernel receipt for a bounded optional model-atomization pass. */
export interface AtomizationReceipt {
  threadId: ThreadId;
  sourceSeq: Seq;
  /** Chain-covered source episode revision used for the pass. */
  sourceHash: Sha256;
  status: "complete" | "incomplete";
  model?: string;
  candidateCount: number;
  acceptedCount: number;
  omittedCount: number;
  reason?: "candidate-cap" | "invalid-candidate" | "extractor-output";
  createdAt: number;
}

/**
 * Ordinary-reader atom projection.  The archive Atom remains exact; this
 * view deliberately carries only the fields the X-ray needs and reports the
 * byte lengths of fields whose values were capped in SQLite.
 */
export interface AtomView {
  id: string;
  threadId: ThreadId;
  kind: AtomKind;
  key: string;
  value: string;
  text: string;
  sourceSeq: Seq;
  validFromSeq: Seq;
  validToSeq?: Seq;
  phase: AtomPhase;
  authority: AtomAuthority;
  pinned: boolean;
  keyBytes: number;
  valueBytes: number;
  textBytes: number;
  keyTruncated?: boolean;
  valueTruncated?: boolean;
  textTruncated?: boolean;
}

export const MAX_ATOM_PAGE_ITEMS = 256;
export const MAX_ATOM_KEY_BYTES = 512;
export const MAX_ATOM_VALUE_BYTES = 2 * 1024;
export const MAX_ATOM_TEXT_BYTES = 2 * 1024;

// ---------- compaction ----------
export type LossKind = "entity" | "number" | "quote" | "atom" | "date" | "code";

export interface LossEntry {
  name: string; // normalized routing key
  kind: LossKind;
  seq: Seq; // exact locator
  span?: [number, number];
  capsuleId?: string;
  resolvedBy?: string; // tombstone id
}

/** Bounded loss-ledger projection; malformed or oversized spans are omitted. */
export interface LossEntryView extends Omit<LossEntry, "span"> {
  nameBytes: number;
  nameTruncated?: boolean;
  span?: [number, number];
  spanBytes?: number;
  spanTruncated?: boolean;
}

export const MAX_LEDGER_PAGE_ITEMS = 256;
export const MAX_LEDGER_NAME_BYTES = 512;
export const MAX_LEDGER_SPAN_BYTES = 256;

/** Maximum exact locator previews embedded in one capsule row. */
export const CAPSULE_LEDGER_PREVIEW_ITEMS = 256;

export interface CapsuleLedgerPartReceipt {
  /** Exact number of distinct routing names classified into this part. */
  count: number;
  /** Number of leading rows embedded in the capsule projection. */
  embeddedCount: number;
  /** sha256 over canonical locator rows in `(seq, name)` order. */
  digest: Sha256;
  /** True only when the embedded array contains every receipted row. */
  complete: boolean;
  /** Opaque loss-page cursor after the embedded preview. */
  cursor?: string;
}

/** Kernel-computed receipt for the bounded capsule ledger projection. */
export interface CapsuleLedgerReceipt {
  version: 1;
  dropped: CapsuleLedgerPartReceipt;
  kept: CapsuleLedgerPartReceipt;
}

export interface Capsule {
  id: string;
  threadId: ThreadId;
  level: number; // 0 = leaf over episodes
  fromSeq: Seq;
  toSeq: Seq;
  text: string;
  tokens: number;
  dropped: LossEntry[]; // created by this compaction
  carriedCount: number; // transported from children
  /** Absent only on capsules created before bounded ledger receipts existed. */
  ledgerReceipt?: CapsuleLedgerReceipt;
  hash: Sha256;
  createdBy: string; // "extractive" | "model:<id>"
  createdAt: number;
}

/**
 * Capsule metadata needed by ordinary readers.  Capsule prose and dropped /
 * carried arrays stay kernel-owned; counts preserve the loss accounting
 * without hydrating unbounded derived text.
 */
export interface CapsuleView {
  id: string;
  threadId: ThreadId;
  level: number;
  fromSeq: Seq;
  toSeq: Seq;
  /** -1 means the source array was malformed or too large to count safely. */
  droppedCount: number;
  /** -1 means the source array was malformed or too large to count safely. */
  keptCount: number;
  carriedCount: number;
  hash: Sha256;
  createdBy: string;
  createdAt: number;
  textBytes: number;
  droppedBytes: number;
  keptBytes: number;
  textTruncated?: boolean;
  droppedTruncated?: boolean;
  keptTruncated?: boolean;
}

export const MAX_CAPSULE_PAGE_ITEMS = 128;

export interface BoundedPageContinuation {
  /** Opaque cursor supplied verbatim to the next request. */
  cursor: string;
  reason: "page-cap" | "response-byte-cap";
}

export interface AtomPage {
  atoms: AtomView[];
  byteLength: number;
  truncated: boolean;
  hasMore: boolean;
  continuation?: BoundedPageContinuation;
}

export interface CapsulePage {
  capsules: CapsuleView[];
  byteLength: number;
  truncated: boolean;
  hasMore: boolean;
  continuation?: BoundedPageContinuation;
}

export interface LedgerPage {
  entries: LossEntryView[];
  byteLength: number;
  truncated: boolean;
  hasMore: boolean;
  continuation?: BoundedPageContinuation;
}

/** Aggregate cap shared by ordinary derived-state reader envelopes. */
export const MAX_DERIVED_RESPONSE_BYTES = 256 * 1024;

/** Raw packet reader policy: scalar preflight rejects these columns before JSON parse. */
export const MAX_PACKET_JSON_BYTES = 256 * 1024;
export const MAX_PACKET_MESSAGES_BYTES = 1_572_864;
/** Serialized raw packet envelope cap, including messages and every receipt column. */
export const MAX_PACKET_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Shared A14 scan/receipt bounds. A remembered-claim receipt is durable
 * packet state, so the scanner must stop before an archive-sized answer can
 * turn it into an unbounded JSON column. The +1 observation is represented by
 * ClaimScanOverflow rather than retained as a candidate.
 */
export const CLAIM_CAPS = {
  maxCandidates: 256,
  maxCandidateBytes: 64 * 1024,
  maxReceiptBytes: MAX_PACKET_JSON_BYTES,
  maxCapabilityDigests: 512,
  maxCapabilityDigestsPerClaim: 8,
} as const;

// ---------- packets (the bounded view) ----------
export type ResidentType = "header" | "frontier" | "capsule" | "paged" | "recent" | "query";

/**
 * What a resident span is allowed to support (KERNEL A10). Presence is not support:
 * only SUPPORTED spans count as evidence for paging decisions and the check round.
 * SUPPORTED — a user/tool episode or a current user-authority certificate;
 * PROPOSED — assistant/model prose or an unconfirmed proposal; HISTORICAL — a superseded
 * value with its interval; NON_AUTHORITATIVE — capsule gist, the header, the current query.
 */
export type Epistemic = "SUPPORTED" | "PROPOSED" | "HISTORICAL" | "NON_AUTHORITATIVE";

/**
 * A bounded, non-authoritative locator for a source span already resident in
 * the frontier.  Locators deliberately live below `ResidentItem`: they tell
 * the evidence gate where to re-read bytes without making the atom itself a
 * reachability edge or a new resident sequence.
 */
export interface ResidentLocator {
  source: string; // episode:<seq> | blob:<sha256>
  seq?: Seq;
  byteRange: [number, number];
  contentHash: Sha256;
  spanHash?: Sha256;
  revision?: string;
  authority: "user" | "tool" | "attachment" | "assistant" | "model";
  atomId?: string;
  atomKey?: string;
}

export interface ResidentItem {
  type: ResidentType;
  ref?: string; // atom id | capsule id | "ep:<seq>"
  seq?: Seq;
  tokens: number;
  epistemic: Epistemic;
  /** At most the bounded frontier set; never counted as resident sequences. */
  locators?: ResidentLocator[];
}

/** One provider request inside a turn (KERNEL A10.3): bounded by the same budget, receipted. */
export interface RequestRound {
  ordinal: number; // 0 = the compiled packet
  messagesDigest: Sha256; // sha256(canonical(messages)) exactly as sent
  tokens: number; // kernel count of the rendered request
  budget: number;
  pages: PageRecord[]; // pages served to build this round (recall, check)
  /** Page sources whose exact recovered blocks survived into this request. */
  admittedPageSeqs: Seq[];
  responseDigest?: Sha256; // sha256 of the text the provider returned
  usage?: Usage;
  status: "done" | "failed";
}

/** Outcome of the verification round (KERNEL A9.5 / A10.4). */
export type CheckStatus =
  | "revised" // the reissued answer differed from the draft
  | "confirmed" // the check round ran and the draft stood
  | "none" // nothing to check: every named value in the draft was supported
  | "check-failed"; // the provider failed during the check round; the draft was kept, qualified

export type PageTrigger =
  | "sequence"
  | "ledger"
  | "historical"
  | "search"
  | "address"
  | "invalidation"
  | "semantic"
  | "semantic-unavailable"
  | "attachment-tail"
  | "recent-overflow"
  | "path" // an earlier turn's receipt led back to the turns it was answered from (KERNEL A11.2)
  | "model"
  | "explicit"
  | "check"
  | "fault"; // no route reached the archive for this question (KERNEL A11.1)

export interface PageRecord {
  trigger: PageTrigger;
  name?: string; // ledger name or atom key
  query?: string;
  seqs: Seq[];
  tokens: number;
  latencyMs: number;
  resolved: boolean; // false ⇒ UNKNOWN
  routeId?: string;
  source?: string;
  sourceHash?: Sha256;
  contentHash?: Sha256;
  spanHash?: Sha256;
  byteRange?: [number, number];
  revision?: string;
  authority?: "user" | "tool" | "attachment" | "assistant" | "model";
  manifest?: string;
  encoding?: string;
  opaque?: boolean;
  semantic?: SemanticReceipt;
}

// ---------- collection obligations (KERNEL A13) ----------
export type CollectionCue = "all" | "every" | "compare" | "list" | "each";
export type CoverageCompleteness = "complete" | "incomplete" | "not-established";

/**
 * Shared A13 issuance/replay bounds.  These are protocol limits rather than
 * implementation tuning: issuance and full verification must retain the same
 * bounded prefix, then expose a +1 sentinel or route-level unresolved outcome
 * whenever a route has more candidates. Keeping the values here prevents the
 * planner, verifier, and packet-size preflight from silently drifting apart.
 */
export const COVERAGE_CAPS = {
  atomEvidence: 256,
  nameRoute: 16,
  searchRoute: 1024,
  retainedSources: 256,
  attachmentSpans: 256,
  candidateWorkBytes: 4 * 1024 * 1024,
} as const;

/** Kernel-owned outcome of one deterministic collection route. */
export type CoverageRouteRunStatus = "complete" | "empty" | "capped" | "ambiguous" | "unresolved" | "not-run";

/** A route execution receipt; it never contains provider/model assertions. */
export interface CoverageRouteRun {
  route: string;
  returned: number;
  status: CoverageRouteRunStatus;
}

/** A bounded, kernel-owned member of one collection route's issuance basis. */
export type CoverageBasisMemberKind = "candidate" | "sentinel";
export type CoverageBasisMemberOutcome =
  | "supported"
  | "historical"
  | "proposed"
  | "unresolved"
  | "no-locator";

export interface CoverageBasisMember {
  kind: CoverageBasisMemberKind;
  sourceSeq: Seq;
  contentHash: Sha256;
  outcome: CoverageBasisMemberOutcome;
  locatorDigests: Sha256[];
  atomId?: string;
  /** The normalized name key or page/search ordinal that produced this member. */
  key?: string;
  ordinal?: number;
}

/** Exact bounded member issuance for one deterministic collection route. */
export interface CoverageBasisRoute {
  /** Raw ordered members, including a +1 sentinel when a route overflowed. */
  members: CoverageBasisMember[];
  /** Number of bounded member records observed, including any sentinel. */
  memberCount: number;
  /** True when members omitted candidates and the route must remain unresolved. */
  overflow: boolean;
  /** The route outcome is included in membersDigest and replayed independently. */
  outcome: CoverageRouteRun;
  membersDigest: Sha256;
}

/** Immutable issuance basis for an A13 coverage receipt. */
export interface CoverageBasis {
  version: 1;
  queryContentHash: Sha256;
  initialPagesDigest: Sha256;
  /** Exact sorted locator digests; capped at the receipt locator bound. */
  locatorDigests: Sha256[];
  routeMembers: {
    names: CoverageBasisRoute;
    pages: CoverageBasisRoute;
    search: CoverageBasisRoute;
  };
  digest: Sha256;
}

export interface CoverageLocator {
  route: PageTrigger | "resident" | "frontier";
  source: string;
  byteRange: [number, number];
  revision: string;
  authority: "user" | "tool" | "attachment" | "assistant" | "model";
  status: "supported" | "historical" | "proposed" | "unresolved";
  digest: Sha256;
}

export interface CoverageReceipt {
  cue: CollectionCue;
  querySeq: Seq;
  asOfSeq: Seq;
  /** Version of the kernel collection router that produced this receipt. */
  routerVersion: string;
  /** Deterministic route executions and their kernel-observed outcomes. */
  routesRun: CoverageRouteRun[];
  required?: number;
  located: number;
  supported: number;
  historical: number;
  unresolved?: number;
  completeness: CoverageCompleteness;
  routes: CoverageLocator[];
  /** Required issuance witness for deterministic replay after later edits. */
  basis: CoverageBasis;
  digest: Sha256;
}

// ---------- remembered-claim gate (KERNEL A14) ----------
export type EvidenceAuthority = "user" | "tool" | "attachment" | "assistant" | "model";

export interface EvidenceCapability {
  token: string;
  threadId: ThreadId;
  turnSeq: Seq;
  roundOrdinal: number;
  messagesDigest: Sha256;
  packetDigest: Sha256;
  seq?: Seq;
  manifestId?: string;
  byteRange: [number, number];
  sourceDigest: Sha256;
  /** Exact hash of the byte range; sourceDigest remains the whole source hash. */
  spanDigest?: Sha256;
  revision?: string;
  authority: EvidenceAuthority;
}

export type RememberedClaimKind = "number" | "identity" | "quote" | "fact" | "collection";
export type ClaimClassification =
  | "SUPPORTED"
  | "HISTORICAL"
  | "PROPOSED"
  | "INFERENCE"
  | "UNKNOWN"
  | "WORLD_KNOWLEDGE";

export interface ClaimCandidate {
  span: [number, number];
  kind: RememberedClaimKind;
  text: string;
  classification?: ClaimClassification;
}

export type ClaimScanOverflowReason = "candidate-cap" | "candidate-bytes";

/** A compact kernel receipt for a bounded remembered-claim scan. */
export interface ClaimScanOverflow {
  reason: ClaimScanOverflowReason;
  maxCandidates: number;
  maxCandidateBytes: number;
  retainedCandidates: number;
  retainedBytes: number;
  observedAtLeast: number;
}

export type CoverageMetric = "located" | "supported" | "historical" | "unresolved";

/** A digest-bound aggregate basis for collection-derived counts. */
export interface ClaimCoverageBasis {
  kind: "coverage";
  digest: Sha256;
  metric: CoverageMetric;
  value: number;
}

export interface ClaimClassificationReceipt {
  span: [number, number];
  kind: RememberedClaimKind;
  classification: ClaimClassification;
  witness?: ByteLocator;
  evidenceWitness?: EvidenceLocator;
  basis?: ClaimCoverageBasis;
  capabilityDigests: Sha256[];
}

export interface AnswerReceipt {
  answerDigest: Sha256;
  scanDigest: Sha256;
  packetDigest: Sha256;
  roundsDigest: Sha256;
  coverageDigest?: Sha256;
  /** Additive A13 provenance copied from the packet coverage receipt. */
  coverageRouterVersion?: string;
  coverageRoutesRun?: CoverageRouteRun[];
  grammarVersion: string;
  candidates: ClaimCandidate[];
  /** Present when the bounded scanner found more claims than the receipt can retain. */
  candidateOverflow?: ClaimScanOverflow;
  classifications: ClaimClassificationReceipt[];
  qualifications: string[];
  status: "released" | "qualified";
  digest: Sha256;
}

// ---------- address-only semantic capability (KERNEL A15.2) ----------
export interface SemanticReceipt {
  status: "ready" | "unavailable" | "incomplete" | "incompatible";
  model?: string;
  modelDigest?: Sha256;
  indexed?: number;
  eligible?: number;
  reason?: string;
}

export interface LedgerDigest {
  count: number; // total unresolved loss entries in the archive
  residentNames: string[]; // names carried by capsules in the view (truncated)
  historical: Array<{ key: string; current: string; previous: string; changedAtSeq: Seq }>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: string; // raw JSON arguments exactly as the model emitted them
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[]; // assistant messages that requested `recall`; replayed to the provider
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export type PacketStatus = "pending" | "done";

export interface Packet {
  id: string;
  threadId: ThreadId;
  turnSeq: Seq; // the user episode this packet answers
  model: string;
  budget: number;
  tokens: number;
  digest: Sha256;
  messages: ChatMessage[]; // KERNEL A7: empty for packets older than the last 1,000
  resident: ResidentItem[];
  ledger: LedgerDigest;
  pages: PageRecord[];
  reachability?: ReachabilitySpan[]; // required on packets compiled by v1.4; optional for v1.3 bundle readers
  /** Kernel snapshot head for the reachability receipt (A12). */
  reachabilityAsOfSeq?: Seq;
  coverage?: CoverageReceipt;
  evidence?: EvidenceCapability[];
  answerReceipt?: AnswerReceipt;
  semantic?: SemanticReceipt;
  rounds?: RequestRound[]; // KERNEL A10.3: every provider request of the turn, in order
  createdAt: number;
  status?: PacketStatus; // KERNEL A6: `pending` until the assistant episode commits
  compilerVersion?: string;
  reconstructed?: boolean; // KERNEL A7: messages re-rendered from resident[], digest unverified
}

export interface ThreadStats {
  threadId: ThreadId;
  title: string;
  turns: number; // head seq
  episodes: { user: number; assistant: number; other: number };
  archiveBytes: number;
  capsules: number;
  losses: number; // unresolved ledger entries
  atoms: { supported: number; historical: number; proposed: number };
  lastPacket?: { tokens: number; budget: number; pages: number; digest: Sha256 };
  headHash: Sha256;
  verifiedTo?: Seq;
  /** First-seen distinct assistant models; the list is capped and may truncate. */
  models: string[];
  /** True when the assistant model history has more than the returned cap. */
  modelsTruncated: boolean;
  /** False while a bounded legacy assistant-model backfill is still catching up. */
  modelsComplete: boolean;
  /** Durable model selection, independent of the most recent packet. */
  selectedModel?: string;
  /** Durable token-budget selection, independent of the most recent packet. */
  selectedBudget: number;
  /**
   * Present when this thread came from a partial bundle. Such a fragment is
   * readable and addressable, but it is not a mutable genesis chain.
   */
  fragment?: ThreadFragmentStatus;
  /** Exact archive retained, but new turns are quarantined until this legacy leaf is remediated. */
  sourceReadiness?: ThreadSourceReadiness;
  /** Bounded derived-index progress; callers may request another maintenance pass while pending. */
  compaction?: ThreadCompactionStatus;
  /** Another bounded derived-index pass is required before provider work is safe. */
  compactionPending?: boolean;
}

/** Durable quarantine marker for a legacy source that cannot be compacted safely. */
export interface ThreadSourceReadiness {
  status: "pending" | "noncompactable";
  readOnly: true;
  seq?: Seq;
  reason: string;
}

/** Fixed-size progress receipt for bounded capsule backfill. */
export interface ThreadCompactionStatus {
  pending: boolean;
  sealedThrough: Seq;
  headSeq: Seq;
}

/** Provenance and authenticated range for a read-only partial import. */
export interface ThreadFragmentStatus {
  readOnly: true;
  threadId: ThreadId;
  originalThreadId: ThreadId;
  fromSeq: Seq;
  toSeq: Seq;
  prevHash: Sha256;
  headHash: Sha256;
  createdAt: number;
}

/** Real server endpoints derived from the durable sequence bindings. */
export interface DemoApiLinks {
  /** The packet compiled for the asking turn. */
  packet: string;
  /** Bounded receipt for the packet, without the raw provider view. */
  packetReceipt?: string;
  /** Exact question and answer episode endpoints for this exchange. */
  questionEpisode: string;
  answerEpisode: string;
  /** Reserved for a route endpoint when the server exposes one. */
  route?: string;
  /** Attachment manifest endpoint, when this exchange carries one. */
  attachment?: string;
  /** Byte-exact span/packet endpoint, when one was paged. */
  span?: string;
}

/** A human-readable source text recovered by a collection receipt. */
export interface DemoSourceText {
  seq: Seq;
  text: string;
  href: string;
}

/** A bounded episode exhibit used by the proof viewer, never the raw episode API. */
export interface DemoRemovalReceipt {
  /** The source row remains in the chain, but its witness bytes were redacted. */
  status: "tombstoned";
  contentAvailable: false;
  tombstoneId?: string;
  originalContentHash: Sha256;
  locatorOmittedReason: "removed";
}

export interface DemoEpisodeResource {
  kind: "episode";
  threadId: ThreadId;
  seq: Seq;
  role: Episode["role"];
  /** UTF-8 prefix retained for display; never the full imported content by default. */
  text: string;
  textBytes: number;
  byteLength: number;
  textTruncated: boolean;
  chainHash: Sha256;
  removed: boolean;
  /** Exact source locator for the retained prefix, including its chain revision. */
  locator?: {
    source: string;
    byteRange: [number, number];
    contentHash: Sha256;
    revision: Sha256;
    authority?: EvidenceAuthority;
  };
  /** Present when the row is removed; it is the bounded replacement for a source locator. */
  removalReceipt?: DemoRemovalReceipt;
}

/** A persisted proof-thread turn returned by the deterministic demo seed. */
export interface DemoTurnRef {
  query: string;
  questionSeq: Seq;
  answerSeq: Seq;
  packetId: string;
  answer: string;
  pages: PageRecord[];
  coverage?: CoverageReceipt;
  answerReceipt?: Pick<AnswerReceipt, "status" | "digest">;
  links: DemoApiLinks;
}

/** Exact current source binding surfaced by the deterministic proof tour. */
export interface DemoWitness {
  seq: Seq;
  source: string;
  byteRange: [number, number];
  contentHash: Sha256;
  spanHash?: Sha256;
  /** Attachment manifest id when the witness names a manifest-backed span. */
  manifestId?: string;
  revision?: string;
  authority: EvidenceAuthority;
  /** The exact episode endpoint for this witness. */
  href?: string;
}

/** A read-only exhibit of one persisted question-to-evidence address edge. */
export interface DemoRouteResource {
  id: string;
  threadId: ThreadId;
  queryDigest: Sha256;
  normalizedQuery: string;
  routerVersion: string;
  questionSeq: Seq;
  answerSeq?: Seq;
  packetId?: string;
  packetDigest?: Sha256;
  sourceSeqs: Seq[];
  witnesses: DemoWitness[];
  routeDigest: Sha256;
  /** Effective status computed by the kernel at `asOfSeq`. */
  status: "active" | "invalidated" | "superseded" | "revoked";
  /** Immutable SQL status retained for append-only audit history. */
  storedStatus: "active" | "invalidated" | "superseded" | "revoked";
  effectiveStatus: "active" | "invalidated" | "superseded" | "revoked";
  asOfSeq: Seq;
  reason?: string;
  /**
   * For an append-only closure event, the immutable route id that this event
   * closes.  This is deliberately action-oriented: it cannot be confused
   * with a route that caused the event.
   */
  closesRouteId?: string;
  /** Reverse lineage: the later append-only event that closed this route. */
  closedByRouteId?: string;
  createdAt: number;
}

/** A hash-verified, exact attachment span exposed as a JSON-safe exhibit. */
export interface DemoAttachmentSpanResource {
  threadId: ThreadId;
  seq: Seq;
  ordinal: number;
  manifestId: string;
  manifest: AttachmentManifest;
  span: AttachmentSpan;
  bytesBase64: string;
  byteLength: number;
  digest: Sha256;
}

/** A coverage locator in the compact packet exhibit, with a source link when one exists. */
export interface DemoCoverageLocator extends CoverageLocator {
  href?: string;
}

/** The bounded A13 portion of a demo packet exhibit. */
export interface DemoPacketCoverage extends Omit<CoverageReceipt, "routes"> {
  routes: DemoCoverageLocator[];
  routeCount: number;
  routesTruncated: boolean;
}

/** A bounded answer-gate projection; raw capability token digests are counted, not copied. */
export interface DemoAnswerReceipt
  extends Pick<
    AnswerReceipt,
    | "answerDigest"
    | "scanDigest"
    | "packetDigest"
    | "roundsDigest"
    | "coverageDigest"
    | "coverageRouterVersion"
    | "coverageRoutesRun"
    | "grammarVersion"
    | "qualifications"
    | "status"
    | "digest"
  > {
  candidates: ClaimCandidate[];
  candidateOverflow?: ClaimScanOverflow;
  candidateCount: number;
  candidatesTruncated: boolean;
  classifications: Array<
    Omit<ClaimClassificationReceipt, "capabilityDigests"> & { capabilityDigestCount: number }
  >;
  classificationCount: number;
  classificationsTruncated: boolean;
}

/**
 * A human-readable packet receipt for the proof tour. It deliberately omits
 * messages, resident items, evidence capabilities and rounds; `rawPacket` is
 * the explicit escape hatch for X-ray clients that need the full packet.
 */
export interface DemoPacketReceipt {
  id: string;
  threadId: ThreadId;
  turnSeq: Seq;
  digest: Sha256;
  status: PacketStatus;
  question: { seq: Seq; text: string; href: string };
  answer: { seq: Seq; text: string; href: string };
  pages: PageRecord[];
  pageCount: number;
  pagesTruncated: boolean;
  coverage?: DemoPacketCoverage;
  answerReceipt?: DemoAnswerReceipt;
  rawPacket: string;
}

/**
 * The kernel-derived receipt for `/api/threads/:id/demo`.
 *
 * This is deliberately a summary, not a second source of truth: every
 * sequence, packet, page, route and attachment field points at durable rows
 * the caller can inspect through the ordinary thread APIs.
 */
export interface DemoSummary {
  version: string;
  seeded: boolean;
  thread: ThreadStats;
  proof: {
    correctedFact: {
      originalSeq: Seq;
      correctionSeq: Seq;
      historicalValue: string;
      currentValue: string;
      originalText: string;
      currentText: string;
      /** The released turn that proves the corrected current value. */
      grounded: DemoTurnRef;
      /** The persisted address edge's current witness, not a reconstructed page. */
      routeId: string;
      currentWitness: DemoWitness;
    };
    collection: DemoTurnRef & {
      required: number;
      located: number;
      supported: number;
      completeness: CoverageCompleteness;
      /** The exact user episodes represented by the located source routes. */
      sources: DemoSourceText[];
    };
    invalidation: {
      grounded: DemoTurnRef;
      repeated: DemoTurnRef;
      sourceSeq: Seq;
      sourceText: string;
      sourceReceipt: DemoRemovalReceipt;
      sourceHref: string;
      routeId: string;
      page: PageRecord;
    };
    attachment: {
      seq: Seq;
      name: string;
      manifestId: string;
      spans: number;
      tail: {
        from: number;
        to: number;
        hash: Sha256;
        marker: string;
      };
      page: PageRecord;
      links: DemoApiLinks;
    };
  };
  /** The last exchange shown by the demo, normally the incomplete collection. */
  final: DemoTurnRef;
}

// ---------- providers ----------
export type ProviderId = "xai" | "anthropic" | "openai" | "ollama" | "openai-compatible";

export interface ModelInfo {
  id: string; // e.g. "grok-4.6"
  provider: ProviderId;
  label: string; // "Grok 4.6"
  contextLength?: number;
  available: boolean; // credentials present / reachable
  supportsTools: boolean;
}

/** Who is signed in. `hosted: false` means the local single-user server (no login). */
export interface Me {
  hosted: boolean;
  sub?: string; // xAI subject; the vault is keyed by it
  name?: string;
  email?: string;
  picture?: string;
}

export interface AuthStatus {
  provider: ProviderId;
  mode: "none" | "api-key" | "device" | "local";
  identity?: string; // masked
  expiresAt?: number;
  ok: boolean;
}

// ---------- local API contract (packages/server) ----------
// Base: http://127.0.0.1:<port>  (loopback only; mutations require Origin in allowlist)
//
// GET  /api/health                         → { ok, version, home }
// GET  /api/threads                        → ThreadStats[] or bounded ThreadListPage
// POST /api/threads  {title?}              → ThreadStats
// GET  /api/threads/:id                    → ThreadStats
// GET  /api/threads/:id/episodes?before&limit&after → Episode[] for small pages,
//       or EpisodePage when the aggregate byte cap is reached (virtualized scroll; newest last)
// GET  /api/threads/:id/episodes/:seq      → bounded EpisodeView
// GET  /api/threads/:id/search?q           → SearchPage (episodes are always bounded)
// GET  /api/threads/:id/packets/:turnSeqOrPacketId → Packet    (X-ray)
// GET  /api/threads/:id/atoms?phase        → Atom[]
// POST /api/threads/:id/atoms/:atomId/pin  {pinned}
// GET  /api/threads/:id/capsules?level     → Capsule[]
// GET  /api/threads/:id/ledger?name&limit  → LossEntry[]
// POST /api/threads/:id/turn  TurnRequest  → text/event-stream of TurnEvent
// POST /api/threads/:id/attach (multipart) → Episode[]   (attachment episodes; text extracted when possible)
// POST /api/threads/:id/handoff {model}    → Episode | { ok, changed: false }   (the divider, when the
//                                            model that last spoke is a different one; 409 no_speaker
//                                            before any model has spoken. A turn writes it by itself.)
// POST /api/threads/:id/forget {seqs?|atomIds?|reason} → { tombstoneId, removalSeq, echoes: Seq[], capsules, packets, blobs }  (KERNEL A10.6; echoes = assistant turns that quoted it)
// POST /api/threads/:id/export {passphrase, range?} → application/octet-stream (.pylos)
// POST /api/import (multipart file + passphrase) → ThreadStats
// GET  /api/models                          → ModelInfo[]
// GET  /api/auth                            → AuthStatus[]
// POST /api/auth/xai/api-key {apiKey}       → AuthStatus
// POST /api/auth/xai/device/start           → { handle, userCode, verificationUrl, expiresIn }
// POST /api/auth/xai/device/poll {handle}   → AuthStatus | { pending: true }
// POST /api/auth/:provider/api-key {apiKey} → AuthStatus   (anthropic | openai | openai-compatible {baseUrl})
// POST /api/auth/:provider/logout           → AuthStatus
//
// Hosted mode (pylos serve --hosted): every /api and /v1 request except /api/health and the login
// routes carries `Authorization: Bearer <session>`; each signed-in xAI subject gets its own vault.
// GET  /api/health                          → { ok, version, hosted: true }   (no home path)
// GET  /api/me                              → Me
// POST /api/login/xai/start                 → { handle, userCode, verificationUrl, verificationUrlComplete?, expiresIn }
// POST /api/login/xai/poll {handle}         → { pending: true } | { session, me: Me }
// POST /api/logout                          → { ok }
// POST /v1/chat/completions                 → OpenAI-compatible gateway; header X-Pylos-Thread: <id>
//   A check round that replaces the draft is signalled in the stream as a chunk carrying
//   `x_pylos: { event: "check", names, retract: true }` before the replacement deltas; the
//   non-streaming response carries only the final text. Clients that ignore `x_pylos` must
//   not treat the stream as append-only when that chunk appears.
// POST /api/threads/:id/demo                → DemoSummary  (seeds "The proof thread": a deterministic, receipt-backed archive)
// GET  /api/threads/:id/demo                → DemoSummary  (read-only; only an existing proof-v1 state)
// GET  /api/threads/:id/demo/routes/:routeId → DemoRouteResource
// GET  /api/threads/:id/demo/attachments/:seq/spans/:ordinal → DemoAttachmentSpanResource
// GET  /api/threads/:id/demo/packets/:packetIdOrTurnSeq → DemoPacketReceipt
// GET  /api/threads/:id/demo/evidence?href=/api/threads/:id/... → bounded exhibit projection

export interface TurnRequest {
  text: string;
  model?: string; // defaults to thread setting
  budget?: number; // tokens; defaults to settings
}

export type TurnEvent =
  | { type: "episode"; episode: Episode } // the user/attachment/handoff episode(s) as appended
  | {
      type: "packet";
      packetId: string;
      tokens: number;
      budget: number;
      pages: PageRecord[];
      ledger: LedgerDigest;
      reachability?: ReachabilitySpan[];
      reachabilityAsOfSeq?: Seq;
      coverage?: CoverageReceipt;
      digest: Sha256;
    }
  | { type: "page"; page: PageRecord } // model-requested recall served mid-turn
  | { type: "delta"; text: string }
  | { type: "check"; names: string[]; pages: PageRecord[] } // the draft named lost values; the text so far is provisional and the deltas that follow replace it (KERNEL A9.5)
  | { type: "gate"; receipt: AnswerReceipt }
  | { type: "done"; episode: Episode; usage?: Usage }
  | { type: "error"; message: string; code?: string };

export const PYLOS_VERSION = "2.0.0";
export const DEFAULT_BUDGET = 32_768;
export const DEMO_BUDGET = 8_192;
export const LEAF_CAPSULE_EPISODES = 32;
export const CAPSULE_FANOUT = 8;
