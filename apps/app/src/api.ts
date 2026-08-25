import type {
  Atom,
  AtomPage,
  AtomView,
  AuthStatus,
  CapsulePage,
  CapsuleView,
  DemoAnswerReceipt,
  DemoAttachmentSpanResource,
  DemoPacketCoverage,
  DemoPacketReceipt,
  DemoRemovalReceipt,
  DemoRouteResource,
  DemoSummary,
  Episode,
  EpisodePage,
  EpisodeView,
  LedgerPage,
  LossEntryView,
  Me,
  ModelInfo,
  Packet,
  Seq,
  ThreadListOptions,
  ThreadListPage,
  ThreadStats,
  TurnEvent,
  TurnRequest,
} from "@pylos/protocol";
import {
  MAX_DERIVED_RESPONSE_BYTES,
  MAX_THREAD_LIST_RESPONSE_BYTES,
  MAX_PACKET_RESPONSE_BYTES as PROTOCOL_MAX_PACKET_RESPONSE_BYTES,
  MAX_TRANSCRIPT_RESPONSE_BYTES as PROTOCOL_MAX_TRANSCRIPT_RESPONSE_BYTES,
} from "@pylos/protocol";
import {
  type BundleTransfer,
  inTauri,
  MAX_WEB_BUNDLE_BYTES,
  shellPort,
  streamBundleFromFile,
  streamBundleToFile,
} from "./tauri.ts";

const SESSION_KEY = "pylos.session";
const OVERRIDE: string | undefined = import.meta.env.VITE_PYLOS_API;

/**
 * Same origin by default: hosted, the app is served from the backend at /app/.
 * Inside the shell the server is a sidecar on loopback, so the port comes from
 * the shell itself. `VITE_PYLOS_API` wins over both, for dev against a server
 * running somewhere else.
 */
let base = OVERRIDE ?? "";

export async function resolveBase(): Promise<void> {
  if (OVERRIDE !== undefined && OVERRIDE.length > 0) return;
  const port = await shellPort();
  if (port !== undefined) base = `http://127.0.0.1:${port}`;
}

let sessionToken: string | null = read();
let expired: (() => void) | undefined;

function read(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function session(): string | null {
  return sessionToken;
}

export function setSession(token: string | null): void {
  sessionToken = token;
  try {
    if (token === null) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, token);
  } catch {
    // A browser with storage denied still works for the length of this tab.
  }
}

/** Called when the backend rejects the session; the UI returns to sign-in. */
export function onSessionExpired(handler: () => void): void {
  expired = handler;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The app-side evidence contract is intentionally smaller than the raw demo
 * endpoints. In particular, attachment bytesBase64 is decoded into a bounded
 * final raw-byte/text tail; the full encoded value is never retained in this union.
 */
export type EvidenceResource =
  | {
      kind: "episode";
      href: string;
      seq: number;
      role: Episode["role"];
      text: string;
      chainHash: string;
      byteLength: number;
      removed: boolean;
      textBytes: number;
      textTruncated: boolean;
      locator?: {
        source: string;
        byteRange: [number, number];
        contentHash: string;
        revision: string;
        authority?: string;
      };
      removalReceipt?: DemoRemovalReceipt;
    }
  | {
      kind: "packet-receipt";
      href: string;
      receipt: DemoPacketReceipt;
    }
  | {
      kind: "route";
      href: string;
      route: DemoRouteResource;
    }
  | {
      kind: "attachment-span";
      href: string;
      threadId: string;
      seq: number;
      ordinal: number;
      manifestId: string;
      manifest: DemoAttachmentSpanResource["manifest"];
      span: DemoAttachmentSpanResource["span"];
      byteLength: number;
      digest: string;
      excerpt: string;
      excerptBytes: number;
      excerptTruncated: boolean;
      /** Only the final bounded window is retained for exact sub-range checks. */
      tailBytes: Uint8Array;
      tailBytesFrom: number;
      tailBytesTo: number;
    }
  | {
      kind: "packet";
      href: string;
      id: string;
      threadId: string;
      turnSeq: number;
      digest: string;
      status: string;
      pageCount: number;
      coverage?: DemoPacketCoverage;
      answerReceipt?: DemoAnswerReceipt;
      preview: string;
    }
  | {
      kind: "json";
      href: string;
      preview: string;
      fields: string[];
    };

/** Hard ceiling for anything rendered as a generic JSON fallback. */
export const MAX_EVIDENCE_JSON_CHARS = 8_000;
/** Hard ceiling for one bounded evidence response before JSON parsing. */
export const MAX_EVIDENCE_RESPONSE_BYTES = 128 * 1024;
/** The attachment viewer retains only the final bounded bytes needed for exact sub-range checks. */
export const MAX_EVIDENCE_TAIL_BYTES = 2_048;
/** Aggregate cap for ordinary transcript/search JSON before response.json(). */
export const MAX_TRANSCRIPT_RESPONSE_BYTES = PROTOCOL_MAX_TRANSCRIPT_RESPONSE_BYTES;
/** Hard ceiling for one bounded thread-list response. */
export const MAX_THREAD_LIST_RESPONSE_BYTES_APP = MAX_THREAD_LIST_RESPONSE_BYTES;
/** Raw X-ray packets are admitted only through the capped streaming reader. */
export const MAX_PACKET_RESPONSE_BYTES = PROTOCOL_MAX_PACKET_RESPONSE_BYTES;

function authorized(init?: RequestInit): RequestInit {
  if (sessionToken === null) return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${sessionToken}`);
  return { ...init, headers };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, authorized(init));
  } catch {
    throw new ApiError("offline", "Pylos is unreachable.", 0);
  }
  if (!response.ok) throw await failure(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Read ordinary transcript/search JSON only after enforcing its aggregate byte cap. */
async function requestCappedJson<T>(path: string, maxBytes = MAX_TRANSCRIPT_RESPONSE_BYTES): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, authorized());
  } catch {
    throw new ApiError("offline", "Pylos is unreachable.", 0);
  }
  if (!response.ok) throw await failure(response);
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new ApiError("response_too_large", "The transcript response exceeded its safety bound.", 413);
    }
  }
  if (response.body === null) return undefined as T;
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ApiError("response_too_large", "The transcript response exceeded its safety bound.", 413);
      }
      bytes.set(value, total - value.byteLength);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, total))) as T;
  } catch {
    throw new ApiError("invalid_response", "The transcript response was not valid JSON.", 502);
  }
}

/** Read only the server-authorized evidence projection; raw proof hrefs never reach response.json(). */
async function requestEvidence(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, authorized());
  } catch {
    throw new ApiError("offline", "Pylos is unreachable.", 0);
  }
  if (!response.ok) throw await failure(response);
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_EVIDENCE_RESPONSE_BYTES) {
      throw new ApiError(
        "evidence_too_large",
        "This evidence projection exceeds the viewer safety bound.",
        413,
      );
    }
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_EVIDENCE_RESPONSE_BYTES);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EVIDENCE_RESPONSE_BYTES) {
        throw new ApiError(
          "evidence_too_large",
          "This evidence projection exceeds the viewer safety bound.",
          413,
        );
      }
      bytes.set(value, total - value.byteLength);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, total))) as unknown;
  } catch {
    throw new ApiError("invalid_evidence_response", "The evidence projection was not valid JSON.", 502);
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isByteRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isNumber(value[0]) &&
    isNumber(value[1]) &&
    value[0] >= 0 &&
    value[1] >= value[0]
  );
}

function isEpisodeResource(value: JsonRecord): boolean {
  return (
    isNumber(value.seq) &&
    isString(value.role) &&
    isString(value.content) &&
    isString(value.hash) &&
    isRecord(value.meta)
  );
}

function isBoundedEpisodeResource(value: JsonRecord): boolean {
  const locator = value.locator;
  const removalReceipt = value.removalReceipt;
  const hasLocator =
    isRecord(locator) &&
    isString(locator.source) &&
    isByteRange(locator.byteRange) &&
    isString(locator.contentHash) &&
    isString(locator.revision);
  const hasRemovalReceipt =
    isRecord(removalReceipt) &&
    removalReceipt.status === "tombstoned" &&
    removalReceipt.contentAvailable === false &&
    isString(removalReceipt.originalContentHash) &&
    removalReceipt.locatorOmittedReason === "removed" &&
    (removalReceipt.tombstoneId === undefined || isString(removalReceipt.tombstoneId));
  const removed = value.removed === true;
  return (
    value.kind === "episode" &&
    isNumber(value.seq) &&
    isString(value.role) &&
    isString(value.text) &&
    isNumber(value.textBytes) &&
    isNumber(value.byteLength) &&
    typeof value.textTruncated === "boolean" &&
    isString(value.chainHash) &&
    typeof value.removed === "boolean" &&
    (removed ? !hasLocator && hasRemovalReceipt : hasLocator && removalReceipt === undefined)
  );
}

function isPacketReceiptResource(value: JsonRecord): boolean {
  return (
    isString(value.id) &&
    isNumber(value.turnSeq) &&
    isString(value.digest) &&
    isRecord(value.question) &&
    isRecord(value.answer) &&
    isString(value.rawPacket)
  );
}

function isRouteResource(value: JsonRecord): boolean {
  return (
    isString(value.id) &&
    isString(value.routeDigest) &&
    isString(value.effectiveStatus) &&
    isString(value.storedStatus) &&
    Array.isArray(value.witnesses)
  );
}

function isAttachmentSpanResource(value: JsonRecord): boolean {
  return (
    isString(value.threadId) &&
    isNumber(value.seq) &&
    isNumber(value.ordinal) &&
    isString(value.manifestId) &&
    isRecord(value.manifest) &&
    isRecord(value.span) &&
    isString(value.bytesBase64) &&
    isNumber(value.byteLength) &&
    isString(value.digest)
  );
}

function isRawPacketResource(value: JsonRecord): boolean {
  return (
    isString(value.id) &&
    isString(value.threadId) &&
    isNumber(value.turnSeq) &&
    isString(value.digest) &&
    Array.isArray(value.messages) &&
    Array.isArray(value.pages)
  );
}

function safeBase64Tail(encoded: string, maxBytes: number): { text: string; bytes: Uint8Array } {
  // Base64 encodes three bytes per four characters. Start on a quartet
  // boundary so the decoder never needs the prefix, then retain only the
  // final bounded bytes. The full encoded value is deliberately not returned.
  const chars = Math.max(4, Math.ceil(maxBytes / 3) * 4);
  const requestedStart = Math.max(0, encoded.length - chars);
  const start = requestedStart - (requestedStart % 4);
  try {
    const binary = globalThis.atob(encoded.slice(start));
    const decoded = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
    const tail = decoded.length > maxBytes ? decoded.subarray(decoded.length - maxBytes) : decoded;
    return { text: new TextDecoder().decode(tail), bytes: new Uint8Array(tail) };
  } catch {
    return { text: "[binary span; UTF-8 tail unavailable]", bytes: new Uint8Array() };
  }
}

function boundedJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(
      value,
      function (this: unknown, key: string, nested: unknown) {
        if (key.toLowerCase().includes("base64")) {
          return `[redacted ${typeof nested === "string" ? nested.length : 0} encoded characters]`;
        }
        if (
          key === "content" &&
          isRecord(this) &&
          (this.removed === true || this.contentAvailable === false)
        ) {
          return "[redacted removed bytes]";
        }
        return nested;
      },
      2,
    );
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= MAX_EVIDENCE_JSON_CHARS) return serialized;
  return `${serialized.slice(0, MAX_EVIDENCE_JSON_CHARS)}\n… [bounded preview; response was capped before parsing]`;
}

/**
 * Converts one existing JSON API response into the small shape the proof
 * viewer needs. This is exported so the app oracle can prove that attachment
 * base64 and unbounded fallback JSON never cross the rendering boundary.
 */
export function normalizeEvidenceResource(href: string, value: unknown): EvidenceResource {
  if (!isRecord(value)) {
    return { kind: "json", href, preview: boundedJson(value), fields: [] };
  }
  if (isBoundedEpisodeResource(value)) {
    const locator = value.locator as JsonRecord | undefined;
    const removalReceipt = value.removalReceipt as JsonRecord | undefined;
    return {
      kind: "episode",
      href,
      seq: Math.floor(value.seq as number),
      role: value.role as Episode["role"],
      text: value.text as string,
      chainHash: value.chainHash as string,
      byteLength: Math.floor(value.byteLength as number),
      removed: value.removed === true,
      textBytes: Math.floor(value.textBytes as number),
      textTruncated: value.textTruncated === true,
      ...(locator === undefined
        ? {}
        : {
            locator: {
              source: locator.source as string,
              byteRange: locator.byteRange as [number, number],
              contentHash: locator.contentHash as string,
              revision: locator.revision as string,
              ...(isString(locator.authority) ? { authority: locator.authority } : {}),
            },
          }),
      ...(removalReceipt === undefined
        ? {}
        : {
            removalReceipt: {
              status: "tombstoned",
              contentAvailable: false,
              ...(isString(removalReceipt.tombstoneId) ? { tombstoneId: removalReceipt.tombstoneId } : {}),
              originalContentHash: removalReceipt.originalContentHash as string,
              locatorOmittedReason: "removed",
            },
          }),
    };
  }
  if (isAttachmentSpanResource(value)) {
    const spanRecord = value.span as JsonRecord;
    if (!isByteRange([spanRecord.from, spanRecord.to])) {
      return {
        kind: "json",
        href,
        preview: boundedJson(value),
        fields: Object.keys(value).slice(0, 32),
      };
    }
    const tail = safeBase64Tail(value.bytesBase64 as string, MAX_EVIDENCE_TAIL_BYTES);
    const byteLength = Math.max(0, Math.floor(value.byteLength as number));
    const manifest = value.manifest as DemoAttachmentSpanResource["manifest"];
    const span = value.span as DemoAttachmentSpanResource["span"];
    const tailBytes = tail.bytes;
    const tailBytesTo = Math.floor(span.to);
    const tailBytesFrom = Math.max(Math.floor(span.from), tailBytesTo - tailBytes.byteLength);
    return {
      kind: "attachment-span",
      href,
      threadId: value.threadId as string,
      seq: Math.floor(value.seq as number),
      ordinal: Math.floor(value.ordinal as number),
      manifestId: value.manifestId as string,
      manifest,
      span,
      byteLength,
      digest: value.digest as string,
      excerpt: tail.text,
      excerptBytes: tailBytes.byteLength,
      excerptTruncated: byteLength > tailBytes.byteLength,
      tailBytes,
      tailBytesFrom,
      tailBytesTo,
    };
  }
  if (isPacketReceiptResource(value)) {
    return { kind: "packet-receipt", href, receipt: value as unknown as DemoPacketReceipt };
  }
  if (isRouteResource(value)) {
    return { kind: "route", href, route: value as unknown as DemoRouteResource };
  }
  if (isEpisodeResource(value)) {
    const meta = value.meta as JsonRecord;
    const text = value.content as string;
    return {
      kind: "episode",
      href,
      seq: Math.floor(value.seq as number),
      role: value.role as Episode["role"],
      text,
      chainHash: value.hash as string,
      byteLength: new TextEncoder().encode(text).byteLength,
      removed: meta.removed === true,
      textBytes: new TextEncoder().encode(text).byteLength,
      textTruncated: false,
    };
  }
  if (isRawPacketResource(value)) {
    const messages = value.messages as unknown[];
    const pages = value.pages as unknown[];
    const coverage = isRecord(value.coverage) ? (value.coverage as unknown as DemoPacketCoverage) : undefined;
    const answerReceipt = isRecord(value.answerReceipt)
      ? (value.answerReceipt as unknown as DemoAnswerReceipt)
      : undefined;
    return {
      kind: "packet",
      href,
      id: value.id as string,
      threadId: value.threadId as string,
      turnSeq: Math.floor(value.turnSeq as number),
      digest: value.digest as string,
      status: isString(value.status) ? value.status : "done",
      pageCount: pages.length,
      ...(coverage === undefined ? {} : { coverage }),
      ...(answerReceipt === undefined ? {} : { answerReceipt }),
      preview: `Raw packet fields: ${Object.keys(value).slice(0, 24).join(", ")}\nMessages: ${messages.length}\nPages: ${pages.length}\nResident items: ${Array.isArray(value.resident) ? value.resident.length : 0}`,
    };
  }
  return {
    kind: "json",
    href,
    preview: boundedJson(value),
    fields: Object.keys(value).slice(0, 32),
  };
}

function evidencePath(href: string): string {
  if (!href.startsWith("/api/") || href.startsWith("//") || /[\r\n]/u.test(href)) {
    throw new ApiError("invalid_evidence_href", "Evidence links must be local API paths.", 400);
  }
  return href;
}

function evidenceProxyPath(href: string): string {
  const match = /^\/api\/threads\/([^/]+)\//u.exec(href);
  if (match === null) {
    throw new ApiError("invalid_evidence_href", "Evidence links must identify a thread.", 400);
  }
  return `/api/threads/${match[1]}/demo/evidence?href=${encodeURIComponent(href)}`;
}

/** The only href the proof viewer should open; the source locator stays query-bound. */
export function boundedEvidenceHref(href: string): string {
  return evidenceProxyPath(evidencePath(href));
}

/** Reads the browser compatibility response without allowing an accidental
 * full-vault allocation in the webview. Native desktop callers use the file
 * streaming commands below instead. */
async function readCapped(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_WEB_BUNDLE_BYTES) {
      throw new ApiError(
        "bundle_too_large",
        "This browser export is capped at 64 MiB; use the desktop shell for a full vault.",
        413,
      );
    }
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_WEB_BUNDLE_BYTES) {
      throw new ApiError(
        "bundle_too_large",
        "This browser export is capped at 64 MiB; use the desktop shell for a full vault.",
        413,
      );
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_WEB_BUNDLE_BYTES);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEB_BUNDLE_BYTES) {
        throw new ApiError(
          "bundle_too_large",
          "This browser export is capped at 64 MiB; use the desktop shell for a full vault.",
          413,
        );
      }
      bytes.set(value, total - value.byteLength);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, total);
}

/**
 * Codes the auth flows own. A 401 carrying one of these is a statement about a
 * provider or a sign-in attempt, not about the session the app is holding —
 * `no_provider` in particular answers 409 now but answered 401 before 1.3.
 */
const NOT_SESSION_END = new Set(["no_provider", "auth_denied", "auth_required", "invalid_grant"]);

/** Turns a failed response into an error, and ends the session when it was the session. */
async function failure(response: Response): Promise<ApiError> {
  const error = await toError(response);
  if (response.status !== 401 || NOT_SESSION_END.has(error.code)) return error;
  setSession(null);
  expired?.();
  return new ApiError("unauthorized", "This session has ended. Sign in again.", 401);
}

async function toError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    return new ApiError(
      body.code ?? "error",
      body.error ?? `Request failed (${response.status}).`,
      response.status,
    );
  } catch {
    return new ApiError("error", `Request failed (${response.status}).`, response.status);
  }
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  };
}

/** What a removal did, and the replies it deliberately left alone (KERNEL A10.6). */
export interface ForgetResult {
  tombstoneId: string;
  removalSeq: Seq;
  echoes: Seq[];
  capsules: number;
  packets: number;
  blobs: number;
  cleanupPending: boolean;
}

export interface LoginStart {
  handle: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  expiresIn: number;
  /** Seconds between polls, when the server says; hosted start does not. */
  interval?: number;
}

function threadListPath(options: ThreadListOptions = {}): string {
  const params = new URLSearchParams();
  if (options.after !== undefined) params.set("after", options.after);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  return query.length === 0 ? "/api/threads" : `/api/threads?${query}`;
}

async function listThreadPage(options: ThreadListOptions = {}): Promise<ThreadListPage> {
  const value = await requestCappedJson<ThreadStats[] | ThreadListPage>(
    threadListPath(options),
    MAX_THREAD_LIST_RESPONSE_BYTES_APP,
  );
  if (Array.isArray(value)) {
    return { threads: value, byteLength: 0, hasMore: false };
  }
  return value;
}

export const api = {
  me: (): Promise<Me> => request<Me>("/api/me"),
  loginStart: (): Promise<LoginStart> => request<LoginStart>("/api/login/xai/start", post({})),
  loginPoll: (handle: string): Promise<{ pending: true } | { session: string; me: Me }> =>
    request("/api/login/xai/poll", post({ handle })),
  signOut: (): Promise<{ ok: boolean }> => request("/api/logout", post({})),

  /** One bounded page; callers that render a list must expose its nextCursor. */
  listThreadsPage: (options: ThreadListOptions = {}): Promise<ThreadListPage> => listThreadPage(options),
  createThread: (title?: string): Promise<ThreadStats> =>
    request<ThreadStats>("/api/threads", post(title === undefined ? {} : { title })),
  thread: (id: string): Promise<ThreadStats> => request<ThreadStats>(`/api/threads/${id}`),
  /** Advance a fixed bounded capsule-index pass; callers may yield and retry. */
  maintenance: (id: string): Promise<ThreadStats> =>
    request<ThreadStats>(`/api/threads/${id}/maintenance`, post({})),
  demo: (id: string): Promise<DemoSummary> => request<DemoSummary>(`/api/threads/${id}/demo`, post({})),
  demoSummary: (id: string): Promise<DemoSummary> => request<DemoSummary>(`/api/threads/${id}/demo`),
  /** Fetches one existing proof href and projects it into a bounded viewer resource. */
  demoEvidence: async (href: string): Promise<EvidenceResource> => {
    const path = evidencePath(href);
    const projection = boundedEvidenceHref(path);
    const value = await requestEvidence(projection);
    return normalizeEvidenceResource(path, value);
  },
  /** Fetches the same bounded evidence projection for an in-panel JSON inspection. */
  demoEvidenceJson: async (href: string): Promise<string> => {
    const path = evidencePath(href);
    const projection = boundedEvidenceHref(path);
    const value = await requestEvidence(projection);
    return boundedJson(value);
  },

  episodes: async (
    id: string,
    opts: { before?: Seq; after?: Seq; limit?: number } = {},
  ): Promise<EpisodeView[]> => {
    const params = new URLSearchParams();
    if (opts.before !== undefined) params.set("before", String(opts.before));
    if (opts.after !== undefined) params.set("after", String(opts.after));
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const value = await requestCappedJson<Episode[] | EpisodePage>(
      `/api/threads/${id}/episodes?${params.toString()}`,
    );
    return Array.isArray(value) ? (value as EpisodeView[]) : value.episodes;
  },
  episode: (id: string, seq: Seq): Promise<EpisodeView> =>
    requestCappedJson<EpisodeView>(`/api/threads/${id}/episodes/${seq}`),
  packet: (id: string, turnSeq: Seq): Promise<Packet> =>
    requestCappedJson<Packet>(`/api/threads/${id}/packets/${turnSeq}`, MAX_PACKET_RESPONSE_BYTES),
  capsulesPage: async (
    id: string,
    opts: { level?: number; after?: string; limit?: number } = {},
  ): Promise<CapsulePage> => {
    const params = new URLSearchParams();
    if (opts.level !== undefined) params.set("level", String(opts.level));
    if (opts.after !== undefined) params.set("after", opts.after);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const value = await requestCappedJson<CapsuleView[] | CapsulePage>(
      `/api/threads/${id}/capsules?${params.toString()}`,
      MAX_DERIVED_RESPONSE_BYTES,
    );
    if (Array.isArray(value)) {
      return {
        capsules: value,
        byteLength: new TextEncoder().encode(JSON.stringify(value)).byteLength,
        truncated: false,
        hasMore: false,
      };
    }
    return value;
  },
  capsules: async (id: string): Promise<CapsuleView[]> => (await api.capsulesPage(id)).capsules,
  ledgerPage: async (
    id: string,
    opts: { name?: string; after?: string; limit?: number } = {},
  ): Promise<LedgerPage> => {
    const params = new URLSearchParams();
    if (opts.name !== undefined) params.set("name", opts.name);
    if (opts.after !== undefined) params.set("after", opts.after);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const value = await requestCappedJson<LossEntryView[] | LedgerPage>(
      `/api/threads/${id}/ledger?${params.toString()}`,
      MAX_DERIVED_RESPONSE_BYTES,
    );
    if (Array.isArray(value)) {
      return {
        entries: value,
        byteLength: new TextEncoder().encode(JSON.stringify(value)).byteLength,
        truncated: false,
        hasMore: false,
      };
    }
    return value;
  },
  atomsPage: async (
    id: string,
    opts: { phase?: string; after?: string; limit?: number } = {},
  ): Promise<AtomPage> => {
    const params = new URLSearchParams();
    if (opts.phase !== undefined) params.set("phase", opts.phase);
    if (opts.after !== undefined) params.set("after", opts.after);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const value = await requestCappedJson<Atom[] | AtomPage>(
      `/api/threads/${id}/atoms?${params.toString()}`,
      MAX_DERIVED_RESPONSE_BYTES,
    );
    if (Array.isArray(value)) {
      return {
        atoms: value as unknown as AtomView[],
        byteLength: new TextEncoder().encode(JSON.stringify(value)).byteLength,
        truncated: false,
        hasMore: false,
      };
    }
    return value;
  },
  verify: (id: string): Promise<{ ok: boolean; headHash: string; checkedTo: number }> =>
    request(`/api/threads/${id}/verify`, post({})),

  forget: (id: string, seqs: Seq[], reason?: string): Promise<ForgetResult> =>
    request<ForgetResult>(`/api/threads/${id}/forget`, post({ seqs, reason })),
  settings: (id: string, patch: { model?: string; budget?: number }): Promise<unknown> =>
    request(`/api/threads/${id}/settings`, post(patch)),

  attach: async (id: string, files: File[]): Promise<Episode[]> => {
    const form = new FormData();
    for (const file of files) form.append("file", file);
    return request<Episode[]>(`/api/threads/${id}/attach`, { method: "POST", body: form });
  },

  exportBundle: async (id: string, passphrase: string, range?: [Seq, Seq]): Promise<Uint8Array> => {
    const response = await fetch(
      `${base}/api/threads/${id}/export`,
      authorized(post({ passphrase, ...(range === undefined ? {} : { range }) })),
    );
    if (!response.ok) throw await failure(response);
    return readCapped(response);
  },

  importBundle: async (bytes: Uint8Array, name: string, passphrase: string): Promise<ThreadStats> => {
    if (bytes.byteLength > MAX_WEB_BUNDLE_BYTES) {
      throw new ApiError(
        "bundle_too_large",
        "This browser import is capped at 64 MiB; use the desktop shell for a full vault.",
        413,
      );
    }
    const form = new FormData();
    form.append("file", new File([bytes as BlobPart], name));
    form.append("passphrase", passphrase);
    return request<ThreadStats>("/api/import", { method: "POST", body: form });
  },

  /** Desktop-only full-scale export. The sidecar writes atomically to `path`. */
  exportBundleToFile: (id: string, passphrase: string, path: string): BundleTransfer<string> => {
    if (!inTauri) throw new ApiError("desktop_only", "Full-vault streaming requires the desktop shell.", 400);
    if (!base.startsWith("http://")) {
      throw new ApiError("sidecar_unresolved", "The desktop sidecar is not ready yet.", 503);
    }
    return streamBundleToFile(
      `${base}/api/threads/${id}/export`,
      path,
      passphrase,
      sessionToken === null ? null : `Bearer ${sessionToken}`,
    );
  },

  /** Desktop-only full-scale import. The sidecar streams the selected file as the raw request body. */
  importBundleFromFile: (path: string, _name: string, passphrase: string): BundleTransfer<ThreadStats> => {
    if (!inTauri) throw new ApiError("desktop_only", "Full-vault streaming requires the desktop shell.", 400);
    if (!base.startsWith("http://")) {
      throw new ApiError("sidecar_unresolved", "The desktop sidecar is not ready yet.", 503);
    }
    const transfer = streamBundleFromFile(
      `${base}/api/import`,
      path,
      passphrase,
      sessionToken === null ? null : `Bearer ${sessionToken}`,
    );
    return {
      abort: transfer.abort,
      done: transfer.done.then((body) => {
        try {
          return JSON.parse(body) as ThreadStats;
        } catch {
          throw new ApiError("invalid_response", "The server returned an invalid import response.", 502);
        }
      }),
    };
  },

  models: (refresh = false): Promise<ModelInfo[]> =>
    request<ModelInfo[]>(`/api/models${refresh ? "?refresh=1" : ""}`),
  auth: (): Promise<AuthStatus[]> => request<AuthStatus[]>("/api/auth"),
  setApiKey: (provider: string, apiKey: string, baseUrl?: string): Promise<AuthStatus> =>
    request<AuthStatus>(`/api/auth/${provider}/api-key`, post({ apiKey, baseUrl })),
  logout: (provider: string): Promise<AuthStatus> =>
    request<AuthStatus>(`/api/auth/${provider}/logout`, post({})),
  grokCliAvailable: (): Promise<{ available: boolean }> =>
    request<{ available: boolean }>("/api/auth/xai/grok-cli"),
  importGrokCli: (): Promise<AuthStatus> => request<AuthStatus>("/api/auth/xai/grok-cli", post({})),
  deviceStart: (): Promise<{
    handle: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
    interval: number;
  }> => request("/api/auth/xai/device/start", post({})),
  devicePoll: (handle: string): Promise<{ pending: true } | AuthStatus> =>
    request("/api/auth/xai/device/poll", post({ handle })),
};

/** Streams one turn. Returns an abort handle; every event is delivered in order. */
export function streamTurn(
  threadId: string,
  body: TurnRequest,
  onEvent: (event: TurnEvent) => void,
): { abort: () => void; done: Promise<void> } {
  const controller = new AbortController();
  const done = (async (): Promise<void> => {
    let response: Response;
    try {
      response = await fetch(
        `${base}/api/threads/${threadId}/turn`,
        authorized({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
      );
    } catch {
      if (controller.signal.aborted) return;
      onEvent({ type: "error", message: "Pylos is unreachable.", code: "offline" });
      return;
    }
    if (!response.ok || response.body === null) {
      const error = await failure(response);
      onEvent({ type: "error", message: error.message, code: error.code });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              onEvent(JSON.parse(line.slice(6)) as TurnEvent);
            } catch {
              // A malformed frame is not worth killing the turn over.
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        onEvent({ type: "error", message: "The stream ended unexpectedly.", code: "stream_broken" });
      }
    }
  })();
  return { abort: () => controller.abort(), done };
}
