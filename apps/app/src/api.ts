import type {
  Atom,
  AuthStatus,
  Capsule,
  Episode,
  LossEntry,
  Me,
  ModelInfo,
  Packet,
  Seq,
  ThreadStats,
  TurnEvent,
  TurnRequest,
} from "@pylos/protocol";
import { shellPort } from "./tauri.ts";

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

export interface Health {
  ok: boolean;
  version: string;
  home: string;
  backend: "core" | "dev-stub";
}

/** What a removal did, and the replies it deliberately left alone (KERNEL A10.6). */
export interface ForgetResult {
  tombstoneId: string;
  removalSeq: Seq;
  echoes: Seq[];
  capsules: number;
  packets: number;
  blobs: number;
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

export const api = {
  health: (): Promise<Health> => request<Health>("/api/health"),
  me: (): Promise<Me> => request<Me>("/api/me"),
  loginStart: (): Promise<LoginStart> => request<LoginStart>("/api/login/xai/start", post({})),
  loginPoll: (handle: string): Promise<{ pending: true } | { session: string; me: Me }> =>
    request("/api/login/xai/poll", post({ handle })),
  signOut: (): Promise<{ ok: boolean }> => request("/api/logout", post({})),

  listThreads: (): Promise<ThreadStats[]> => request<ThreadStats[]>("/api/threads"),
  createThread: (title?: string): Promise<ThreadStats> =>
    request<ThreadStats>("/api/threads", post(title === undefined ? {} : { title })),
  thread: (id: string): Promise<ThreadStats> => request<ThreadStats>(`/api/threads/${id}`),

  episodes: (id: string, opts: { before?: Seq; after?: Seq; limit?: number } = {}): Promise<Episode[]> => {
    const params = new URLSearchParams();
    if (opts.before !== undefined) params.set("before", String(opts.before));
    if (opts.after !== undefined) params.set("after", String(opts.after));
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    return request<Episode[]>(`/api/threads/${id}/episodes?${params.toString()}`);
  },
  episode: (id: string, seq: Seq): Promise<Episode> => request<Episode>(`/api/threads/${id}/episodes/${seq}`),
  packet: (id: string, turnSeq: Seq): Promise<Packet> =>
    request<Packet>(`/api/threads/${id}/packets/${turnSeq}`),
  capsules: (id: string): Promise<Capsule[]> => request<Capsule[]>(`/api/threads/${id}/capsules`),
  ledger: (id: string, limit = 50): Promise<LossEntry[]> =>
    request<LossEntry[]>(`/api/threads/${id}/ledger?limit=${limit}`),
  atoms: (id: string): Promise<Atom[]> => request<Atom[]>(`/api/threads/${id}/atoms`),
  search: (id: string, q: string): Promise<{ episodes: Episode[]; atoms: Atom[] }> =>
    request(`/api/threads/${id}/search?q=${encodeURIComponent(q)}`),
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

  exportBundle: async (id: string, passphrase: string): Promise<Uint8Array> => {
    const response = await fetch(`${base}/api/threads/${id}/export`, authorized(post({ passphrase })));
    if (!response.ok) throw await failure(response);
    return new Uint8Array(await response.arrayBuffer());
  },

  importBundle: async (bytes: Uint8Array, name: string, passphrase: string): Promise<ThreadStats> => {
    const form = new FormData();
    form.append("file", new File([bytes as BlobPart], name));
    form.append("passphrase", passphrase);
    return request<ThreadStats>("/api/import", { method: "POST", body: form });
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
