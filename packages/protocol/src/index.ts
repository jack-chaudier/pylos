/**
 * @pylos/protocol — shared types and the local API contract.
 * No runtime dependencies. Everything the kernel, server and UIs agree on lives here.
 */

// ---------- identities ----------
export type ThreadId = string;
export type Seq = number; // 1-based, monotonic per thread
export type Sha256 = string; // lowercase hex

// ---------- threads ----------
/** Per-thread tunables. All optional; the kernel supplies defaults. */
export interface ThreadSettings {
  budget?: number; // packet token budget
  model?: string; // default model
  shares?: { header?: number; frontier?: number; capsules?: number; paged?: number };
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

export interface EpisodeMeta {
  blob?: Sha256; // content-addressed attachment
  mime?: string;
  name?: string; // attachment file name
  size?: number;
  packetId?: string; // for assistant episodes: the packet they were produced from
  usage?: Usage;
  pages?: PageRecord[];
  from?: string; // handoff: previous model
  to?: string; // handoff: next model
  check?: { names: string[]; status: CheckStatus; draftSha256: Sha256 }; // assistant: the verification round
  roundsDigest?: Sha256; // assistant: sha256 over the turn's RequestRound digests (what the model saw, all rounds)
  removed?: boolean; // tombstoned content
  [k: string]: unknown;
}

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
  hash: Sha256;
  createdBy: string; // "extractive" | "model:<id>"
  createdAt: number;
}

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

export interface ResidentItem {
  type: ResidentType;
  ref?: string; // atom id | capsule id | "ep:<seq>"
  seq?: Seq;
  tokens: number;
  epistemic: Epistemic;
}

/** One provider request inside a turn (KERNEL A10.3): bounded by the same budget, receipted. */
export interface RequestRound {
  ordinal: number; // 0 = the compiled packet
  messagesDigest: Sha256; // sha256(canonical(messages)) exactly as sent
  tokens: number; // kernel count of the rendered request
  budget: number;
  pages: PageRecord[]; // pages served to build this round (recall, check)
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

export type PageTrigger = "sequence" | "ledger" | "historical" | "search" | "model" | "explicit" | "check";

export interface PageRecord {
  trigger: PageTrigger;
  name?: string; // ledger name or atom key
  query?: string;
  seqs: Seq[];
  tokens: number;
  latencyMs: number;
  resolved: boolean; // false ⇒ UNKNOWN
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
  models: string[]; // distinct models that have spoken in the thread
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
// GET  /api/threads                        → ThreadStats[]
// POST /api/threads  {title?}              → ThreadStats
// GET  /api/threads/:id                    → ThreadStats
// GET  /api/threads/:id/episodes?before&limit&after → Episode[]   (virtualized scroll; newest last)
// GET  /api/threads/:id/episodes/:seq      → Episode
// GET  /api/threads/:id/search?q           → { episodes: Episode[], atoms: Atom[] }
// GET  /api/threads/:id/packets/:turnSeq   → Packet            (X-ray)
// GET  /api/threads/:id/atoms?phase        → Atom[]
// POST /api/threads/:id/atoms/:atomId/pin  {pinned}
// GET  /api/threads/:id/capsules?level     → Capsule[]
// GET  /api/threads/:id/ledger?name&limit  → LossEntry[]
// POST /api/threads/:id/turn  TurnRequest  → text/event-stream of TurnEvent
// POST /api/threads/:id/attach (multipart) → Episode[]   (attachment episodes; text extracted when possible)
// POST /api/threads/:id/handoff {model}    → Episode      (writes the handoff divider)
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
// POST /api/threads/:id/demo                → ThreadStats   (seeds "The proof thread": a deterministic synthetic archive the user can interrogate at once)

export interface TurnRequest {
  text: string;
  model?: string; // defaults to thread setting
  budget?: number; // tokens; defaults to settings
  attachmentSeqs?: Seq[]; // attachments uploaded earlier in this turn
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
      digest: Sha256;
    }
  | { type: "page"; page: PageRecord } // model-requested recall served mid-turn
  | { type: "delta"; text: string }
  | { type: "check"; names: string[]; pages: PageRecord[] } // the draft named lost values; the text so far is provisional and the deltas that follow replace it (KERNEL A9.5)
  | { type: "done"; episode: Episode; usage?: Usage }
  | { type: "error"; message: string; code?: string };

export const PYLOS_VERSION = "1.2.0";
export const DEFAULT_BUDGET = 32_768;
export const DEMO_BUDGET = 8_192;
export const LEAF_CAPSULE_EPISODES = 32;
export const CAPSULE_FANOUT = 8;
