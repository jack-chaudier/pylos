import { randomBytes } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { AuthStatus, ProviderId } from "@pylos/protocol";
import { grokCliAuthPath } from "../home.ts";
import { fetchProvider, PROVIDER_HEADER_TIMEOUT_MS } from "../providers/fetch.ts";
import { readProviderJson } from "../providers/openai-chat.ts";
import { type Credential, CredentialStore, type OauthCredential } from "./store.ts";

export const XAI_AUTH_BASE = "https://auth.x.ai";
export const XAI_API_BASE = "https://api.x.ai/v1";
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPES = "openid profile email offline_access grok-cli:access api:access";
export const REFRESH_WINDOW_MS = 120_000;
export const MAX_GROK_CLI_AUTH_BYTES = 256 * 1024;
/** Public device grants retained in memory while the user visits x.ai. */
export const MAX_PENDING_DEVICES = 8_192;

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** The OpenID fields xAI returns for a signed-in account. All optional. */
export interface XaiProfile {
  name?: string;
  email?: string;
  picture?: string;
}

export interface DeviceStart {
  handle: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}

interface PendingDevice {
  deviceCode: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface AuthServiceOptions {
  store?: CredentialStore;
  fetch?: Fetcher;
  headerTimeoutMs?: number;
  now?: () => number;
}

const API_KEY_PROVIDERS: ProviderId[] = ["xai", "anthropic", "openai", "openai-compatible"];

/**
 * Credential custody for every provider. The device-code flow (RFC 8628) is the
 * public Grok-CLI client flow; the resulting OAuth access token authenticates
 * against https://api.x.ai/v1/chat/completions.
 */
export class AuthService {
  readonly store: CredentialStore;
  private readonly fetcher: Fetcher;
  private readonly headerTimeoutMs: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingDevice>();
  private nextPendingExpiry = Number.POSITIVE_INFINITY;
  private pendingStarts = 0;
  private refreshFlight: Promise<string> | undefined;

  constructor(options: AuthServiceOptions = {}) {
    this.store = options.store ?? new CredentialStore();
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.headerTimeoutMs = options.headerTimeoutMs ?? PROVIDER_HEADER_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  // ---------- status ----------

  async statuses(): Promise<AuthStatus[]> {
    const file = await this.store.read();
    const out: AuthStatus[] = [];
    for (const provider of API_KEY_PROVIDERS) {
      out.push(describe(provider, file.providers[provider]));
    }
    out.push({ provider: "ollama", mode: "local", ok: true, identity: "127.0.0.1:11434" });
    return out;
  }

  async status(provider: ProviderId): Promise<AuthStatus> {
    if (provider === "ollama") {
      return { provider, mode: "local", ok: true, identity: "127.0.0.1:11434" };
    }
    return describe(provider, await this.store.get(provider));
  }

  async configured(provider: ProviderId): Promise<boolean> {
    if (provider === "ollama") return true;
    const credential = await this.store.get(provider);
    if (credential === undefined) return false;
    if (credential.mode === "api-key") return credential.apiKey.length > 0;
    return credential.accessToken !== undefined || credential.refreshToken !== undefined;
  }

  async anyConfigured(): Promise<boolean> {
    const file = await this.store.read();
    return API_KEY_PROVIDERS.some((provider) => file.providers[provider] !== undefined);
  }

  async baseUrl(provider: ProviderId): Promise<string | undefined> {
    const credential = await this.store.get(provider);
    return credential?.mode === "api-key" ? credential.baseUrl : undefined;
  }

  // ---------- token resolution ----------

  /** Returns a usable bearer token, refreshing an xAI OAuth token when stale. */
  async token(provider: ProviderId): Promise<string | undefined> {
    if (provider === "ollama") return undefined;
    const credential = await this.store.get(provider);
    if (credential === undefined) {
      throw new AuthError("auth_required", `No credential configured for ${provider}.`, 401);
    }
    if (credential.mode === "api-key") return credential.apiKey;
    if (provider !== "xai") {
      throw new AuthError("auth_required", `No credential configured for ${provider}.`, 401);
    }
    if (
      credential.accessToken !== undefined &&
      credential.expiresAt !== undefined &&
      credential.expiresAt > this.now() + REFRESH_WINDOW_MS
    ) {
      return credential.accessToken;
    }
    if (credential.accessToken !== undefined && credential.expiresAt === undefined) {
      return credential.accessToken;
    }
    if (this.refreshFlight !== undefined) return this.refreshFlight;
    this.refreshFlight = this.refresh(credential).finally(() => {
      this.refreshFlight = undefined;
    });
    return this.refreshFlight;
  }

  // ---------- api keys ----------

  async setApiKey(provider: ProviderId, apiKey: string, baseUrl?: string): Promise<AuthStatus> {
    const normalized = apiKey.trim();
    if (normalized.length < 8) {
      throw new AuthError("invalid_api_key", "Enter a valid API key.", 400);
    }
    if (provider === "xai" && !normalized.startsWith("xai-")) {
      throw new AuthError("invalid_api_key", "An xAI API key starts with `xai-`.", 400);
    }
    if (provider === "openai-compatible" && (baseUrl === undefined || baseUrl.length === 0)) {
      throw new AuthError("invalid_base_url", "A base URL is required.", 400);
    }
    await this.store.set(provider, {
      mode: "api-key",
      apiKey: normalized,
      ...(baseUrl === undefined ? {} : { baseUrl: baseUrl.replace(/\/+$/, "") }),
      obtainedAt: this.now(),
    });
    return this.status(provider);
  }

  async logout(provider: ProviderId): Promise<AuthStatus> {
    if (provider === "xai") {
      this.pending.clear();
      this.nextPendingExpiry = Number.POSITIVE_INFINITY;
    }
    await this.store.clear(provider);
    return this.status(provider);
  }

  // ---------- device flow ----------

  async startDevice(): Promise<DeviceStart> {
    this.prunePending(this.now());
    // Count in-flight upstream requests as reservations. Without this, 8,193
    // concurrent starts could all pass the synchronous size check before any
    // response inserts its grant.
    if (this.pending.size + this.pendingStarts >= MAX_PENDING_DEVICES) {
      throw new AuthError("auth_busy", "Too many sign-in requests are already pending.", 429);
    }
    this.pendingStarts += 1;
    try {
      const response = await this.request(`${XAI_AUTH_BASE}/oauth2/device/code`, {
        client_id: XAI_CLIENT_ID,
        scope: XAI_SCOPES,
      });
      if (!response.ok) {
        throw new AuthError("auth_unavailable", "xAI device sign-in is unavailable.", 502);
      }
      const value = await json(response);
      const deviceCode = requiredString(value, "device_code");
      const userCode = requiredString(value, "user_code");
      const verificationUrl = requiredString(value, "verification_uri");
      const expiresIn = numberOr(value.expires_in, 600);
      const interval = numberOr(value.interval, 5);
      const complete = optionalString(value.verification_uri_complete) ?? verificationUrl;
      const handle = randomBytes(24).toString("base64url");
      const now = this.now();
      this.pending.set(handle, {
        deviceCode,
        expiresAt: now + expiresIn * 1000,
        interval,
        nextPollAt: now,
      });
      this.nextPendingExpiry = Math.min(this.nextPendingExpiry, now + expiresIn * 1000);
      return {
        handle,
        userCode,
        verificationUrl,
        verificationUrlComplete: complete,
        expiresIn,
        interval,
      };
    } finally {
      this.pendingStarts -= 1;
    }
  }

  /** Whether this handle is a device grant this service started and still holds. */
  knowsDevice(handle: string): boolean {
    const entry = this.pending.get(handle);
    if (entry === undefined) return false;
    if (this.now() < entry.expiresAt) return true;
    this.pending.delete(handle);
    return false;
  }

  private prunePending(at: number): void {
    if (at < this.nextPendingExpiry) return;
    let next = Number.POSITIVE_INFINITY;
    for (const [handle, entry] of this.pending) {
      if (at >= entry.expiresAt) this.pending.delete(handle);
      else next = Math.min(next, entry.expiresAt);
    }
    this.nextPendingExpiry = next;
  }

  /** Never returns a token; the caller sees only `pending` or the masked status. */
  async pollDevice(handle: string): Promise<{ pending: true } | AuthStatus> {
    const result = await this.pollDeviceCredential(handle);
    if ("pending" in result) return result;
    await this.store.set("xai", result);
    return this.status("xai");
  }

  /**
   * The device grant without custody: the credential is handed back so the
   * caller can put it in the right store. Hosted mode has one auth.json per
   * signed-in subject, so the login flow cannot use this service's own store.
   */
  async pollDeviceCredential(handle: string): Promise<{ pending: true } | OauthCredential> {
    const entry = this.pending.get(handle);
    if (entry === undefined) {
      throw new AuthError("auth_expired", "This sign-in request expired.", 410);
    }
    const now = this.now();
    if (now >= entry.expiresAt) {
      this.pending.delete(handle);
      throw new AuthError("auth_expired", "The sign-in code expired.", 410);
    }
    if (now < entry.nextPollAt) return { pending: true };
    const response = await this.request(`${XAI_AUTH_BASE}/oauth2/token`, {
      client_id: XAI_CLIENT_ID,
      device_code: entry.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const value = await json(response);
    if (response.ok) {
      this.pending.delete(handle);
      return this.oauthFrom(value, undefined, "device");
    }
    const error = optionalString(value.error);
    if (error === "authorization_pending") {
      entry.nextPollAt = now + entry.interval * 1000;
      return { pending: true };
    }
    if (error === "slow_down") {
      entry.interval += 5;
      entry.nextPollAt = now + entry.interval * 1000;
      return { pending: true };
    }
    this.pending.delete(handle);
    if (error === "access_denied") {
      throw new AuthError("auth_denied", "The sign-in request was denied.", 401);
    }
    throw new AuthError("auth_expired", "The sign-in code expired.", 410);
  }

  /**
   * The OpenID profile behind an xAI access token. Best effort: a 401, a body
   * that is not a profile, or a network failure all mean "fewer fields", never
   * a failed sign-in.
   */
  async userInfo(accessToken: string): Promise<XaiProfile> {
    let value: unknown;
    try {
      const response = await fetchProvider(
        this.fetcher,
        `${XAI_AUTH_BASE}/oauth2/userinfo`,
        {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        },
        { label: "xAI authentication", timeoutMs: this.headerTimeoutMs },
      );
      if (!response.ok) return {};
      value = await readProviderJson(response);
    } catch {
      return {};
    }
    if (!isRecord(value)) return {};
    const name = optionalString(value.name) ?? optionalString(value.preferred_username);
    const email = optionalString(value.email);
    const picture = optionalString(value.picture);
    return {
      ...(name === undefined ? {} : { name }),
      ...(email === undefined ? {} : { email }),
      ...(picture === undefined ? {} : { picture }),
    };
  }

  // ---------- Grok CLI import ----------

  /** Adopts an existing `grok login` session. Tokens are never echoed back. */
  async importGrokCli(path = grokCliAuthPath()): Promise<AuthStatus> {
    const text = await readGrokCliAuth(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AuthError("grok_cli_invalid", "The Grok CLI login file is not valid JSON.", 422);
    }
    const entry = findGrokEntry(parsed);
    if (entry === undefined) {
      throw new AuthError("grok_cli_invalid", "The Grok CLI login file has no xAI session.", 422);
    }
    const accessToken = optionalString(entry.key) ?? optionalString(entry.access_token);
    const refreshToken = optionalString(entry.refresh_token);
    if (accessToken === undefined && refreshToken === undefined) {
      throw new AuthError("grok_cli_invalid", "The Grok CLI login has no usable token.", 422);
    }
    const expiresAt = parseTimestamp(entry.expires_at);
    const credential: OauthCredential = {
      mode: "oauth",
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      obtainedAt: this.now(),
      ...(optionalString(entry.email) === undefined ? {} : { email: entry.email as string }),
      source: "grok-cli",
    };
    await this.store.set("xai", credential);
    return this.status("xai");
  }

  async grokCliAvailable(path = grokCliAuthPath()): Promise<boolean> {
    try {
      const parsed: unknown = JSON.parse(await readGrokCliAuth(path));
      return findGrokEntry(parsed) !== undefined;
    } catch {
      return false;
    }
  }

  // ---------- internals ----------

  private async refresh(credential: OauthCredential): Promise<string> {
    if (credential.refreshToken === undefined) {
      await this.store.clear("xai");
      throw new AuthError("auth_required", "The xAI session expired. Sign in again.", 401);
    }
    const response = await this.request(`${XAI_AUTH_BASE}/oauth2/token`, {
      client_id: XAI_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
    });
    const value = await json(response);
    if (response.ok) {
      const refreshed = this.oauthFrom(value, credential.refreshToken, credential.source);
      await this.store.set("xai", refreshed);
      if (refreshed.accessToken === undefined) {
        throw new AuthError("auth_required", "xAI returned no access token.", 401);
      }
      return refreshed.accessToken;
    }
    if (optionalString(value.error) === "invalid_grant") {
      await this.store.clear("xai");
      throw new AuthError("invalid_grant", "The xAI session is no longer valid.", 401);
    }
    if (credential.accessToken !== undefined) return credential.accessToken;
    throw new AuthError("auth_unavailable", "xAI token refresh is unavailable.", 502);
  }

  private oauthFrom(
    value: Record<string, unknown>,
    fallbackRefresh: string | undefined,
    source: OauthCredential["source"],
  ): OauthCredential {
    const accessToken = requiredString(value, "access_token");
    const refreshToken = optionalString(value.refresh_token) ?? fallbackRefresh;
    const expiresIn = numberOr(value.expires_in, 3600);
    const claims = jwtClaims(accessToken);
    const email = typeof claims?.email === "string" ? claims.email : undefined;
    return {
      mode: "oauth",
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      expiresAt: this.now() + expiresIn * 1000,
      obtainedAt: this.now(),
      ...(email === undefined ? {} : { email }),
      ...(source === undefined ? {} : { source }),
    };
  }

  private async request(url: string, form: Record<string, string>): Promise<Response> {
    try {
      return await fetchProvider(
        this.fetcher,
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form),
        },
        { label: "xAI authentication", timeoutMs: this.headerTimeoutMs },
      );
    } catch {
      throw new AuthError("auth_unavailable", "Unable to reach xAI authentication.", 502);
    }
  }
}

async function readGrokCliAuth(path: string): Promise<string> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    throw new AuthError("grok_cli_missing", "No Grok CLI login found on this machine.", 404);
  }
  if (!info.isFile()) {
    throw new AuthError("grok_cli_invalid", "The Grok CLI login is not a regular file.", 422);
  }
  if (info.size > MAX_GROK_CLI_AUTH_BYTES) throw oversizedGrokCliAuth();

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    throw new AuthError("grok_cli_missing", "No Grok CLI login found on this machine.", 404);
  }
  try {
    // The extra byte closes the stat/open race: a file that grows after the
    // early stat is still refused without ever allocating its full contents.
    const bytes = Buffer.alloc(MAX_GROK_CLI_AUTH_BYTES + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const read = await handle.read(bytes, length, bytes.byteLength - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_GROK_CLI_AUTH_BYTES) throw oversizedGrokCliAuth();
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}

function oversizedGrokCliAuth(): AuthError {
  return new AuthError(
    "grok_cli_invalid",
    `The Grok CLI login exceeds the ${MAX_GROK_CLI_AUTH_BYTES}-byte limit.`,
    422,
  );
}

// ---------- masking ----------

function describe(provider: ProviderId, credential: Credential | undefined): AuthStatus {
  if (credential === undefined) return { provider, mode: "none", ok: false };
  if (credential.mode === "api-key") {
    return {
      provider,
      mode: "api-key",
      identity: maskKey(credential.apiKey),
      ok: true,
    };
  }
  const identity =
    credential.email !== undefined ? maskEmail(credential.email) : identityFromToken(credential.accessToken);
  return {
    provider,
    mode: "device",
    identity,
    ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    ok: credential.accessToken !== undefined || credential.refreshToken !== undefined,
  };
}

function maskKey(key: string): string {
  const prefix = key.startsWith("sk-ant-") ? "sk-ant" : (key.split("-")[0] ?? "key");
  return `${prefix}-••••${key.slice(-4)}`;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return "xAI account";
  const local = email.slice(0, at);
  return `${local[0] ?? ""}${local.length > 1 ? "•••" : ""}@${email.slice(at + 1)}`;
}

function identityFromToken(token: string | undefined): string {
  if (token === undefined) return "xAI account";
  const claims = jwtClaims(token);
  if (typeof claims?.email === "string") return maskEmail(claims.email);
  if (typeof claims?.sub === "string") return `xAI …${claims.sub.slice(-6)}`;
  return "xAI account";
}

/** The payload of a JWT, unverified — only ever read from a token we just fetched over TLS. */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// ---------- parsing ----------

function findGrokEntry(parsed: unknown): Record<string, unknown> | undefined {
  if (!isRecord(parsed)) return undefined;
  const direct = parsed[`${XAI_AUTH_BASE}::${XAI_CLIENT_ID}`];
  if (isRecord(direct)) return direct;
  for (const [key, value] of Object.entries(parsed)) {
    if (key.includes("auth.x.ai") && isRecord(value)) return value;
  }
  if (isRecord(parsed.oauth)) return parsed.oauth;
  if (typeof parsed.key === "string" || typeof parsed.access_token === "string") return parsed;
  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await readProviderJson(response);
    if (isRecord(value)) return value;
  } catch {
    // fall through
  }
  throw new AuthError("invalid_response", "xAI returned an invalid response.", 502);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value[key]);
  if (result === undefined) {
    throw new AuthError("invalid_response", "xAI returned an invalid response.", 502);
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
