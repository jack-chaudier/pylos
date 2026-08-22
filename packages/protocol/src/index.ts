/**
 * @pylos/protocol — shared types and the local API contract.
 * No runtime dependencies. Everything the kernel, server and UIs agree on lives here.
 */

// ---------- identities ----------
export type ThreadId = string;
export type Seq = number; // 1-based, monotonic per thread
export type Sha256 = string; // lowercase hex

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
export type AtomPhase = "SUPPORTED" | "HISTORICAL" | "REVOKED";

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

export interface ResidentItem {
  type: ResidentType;
  ref?: string; // atom id | capsule id | "ep:<seq>"
  seq?: Seq;
  tokens: number;
}

export type PageTrigger = "ledger" | "historical" | "search" | "model" | "explicit";

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

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface Packet {
  id: string;
  threadId: ThreadId;
  turnSeq: Seq; // the user episode this packet answers
  model: string;
  budget: number;
  tokens: number;
  digest: Sha256;
  messages: ChatMessage[];
  resident: ResidentItem[];
  ledger: LedgerDigest;
  pages: PageRecord[];
  createdAt: number;
}

export interface ThreadStats {
  threadId: ThreadId;
  title: string;
  turns: number; // head seq
  episodes: { user: number; assistant: number; other: number };
  archiveBytes: number;
  capsules: number;
  losses: number; // unresolved ledger entries
  atoms: { supported: number; historical: number };
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
// POST /api/threads/:id/forget {seqs?|atomIds?|reason} → { tombstoneId }
// POST /api/threads/:id/export {passphrase, range?} → application/octet-stream (.pylos)
// POST /api/import (multipart file + passphrase) → ThreadStats
// GET  /api/models                          → ModelInfo[]
// GET  /api/auth                            → AuthStatus[]
// POST /api/auth/xai/api-key {apiKey}       → AuthStatus
// POST /api/auth/xai/device/start           → { handle, userCode, verificationUrl, expiresIn }
// POST /api/auth/xai/device/poll {handle}   → AuthStatus | { pending: true }
// POST /api/auth/:provider/api-key {apiKey} → AuthStatus   (anthropic | openai | openai-compatible {baseUrl})
// POST /api/auth/:provider/logout           → AuthStatus
// POST /v1/chat/completions                 → OpenAI-compatible gateway; header X-Pylos-Thread: <id>

export interface TurnRequest {
  text: string;
  model?: string; // defaults to thread setting
  budget?: number; // tokens; defaults to settings
  attachmentSeqs?: Seq[]; // attachments uploaded earlier in this turn
}

export type TurnEvent =
  | { type: "episode"; episode: Episode } // the user/attachment/handoff episode(s) as appended
  | { type: "packet"; packetId: string; tokens: number; budget: number; pages: PageRecord[]; ledger: LedgerDigest; digest: Sha256 }
  | { type: "page"; page: PageRecord } // model-requested recall served mid-turn
  | { type: "delta"; text: string }
  | { type: "done"; episode: Episode; usage?: Usage }
  | { type: "error"; message: string; code?: string };

export const PYLOS_VERSION = "1.0.0";
export const DEFAULT_BUDGET = 32_768;
export const DEMO_BUDGET = 8_192;
export const LEAF_CAPSULE_EPISODES = 32;
export const CAPSULE_FANOUT = 8;
