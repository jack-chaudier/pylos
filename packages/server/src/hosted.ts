/**
 * Hosted mode: one vault per signed-in xAI subject.
 *
 * A tiny registry database (`<home>/hosted.sqlite`) maps a subject to its
 * profile directory and holds opaque session tokens. Everything a user owns —
 * `vault.sqlite`, `objects/`, `auth.json` — lives under
 * `<home>/users/<sha256(sub)…>/`, so the per-user paths never come from
 * `PYLOS_HOME` or any other ambient state. Their own xAI credential is what
 * calls api.x.ai for their turns.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Me } from "@pylos/protocol";
import { CredentialStore } from "./auth/store.ts";
import { AuthError, AuthService, jwtClaims, type XaiProfile } from "./auth/xai.ts";
import { createContext, type ServerContext } from "./context.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60_000;
const MAX_OPEN_USERS = 64;
const IDLE_CLOSE_MS = 30 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user (
  sub        TEXT PRIMARY KEY,
  dir        TEXT NOT NULL,
  name       TEXT,
  email      TEXT,
  picture    TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_sub ON session(sub);
`;

export interface HostedUser {
  sub: string;
  dir: string;
  name?: string;
  email?: string;
  picture?: string;
}

export interface LoginStart {
  handle: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  expiresIn: number;
}

export type LoginPoll = { pending: true } | { session: string; me: Me };

/** A borrowed per-user context: released when the request (and any stream) is done. */
export interface Lease {
  context: ServerContext;
  release(): void;
}

export interface HostedOptions {
  home: string;
  now?: () => number;
  /** Injected for tests, and for anything that needs to reach auth.x.ai differently. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Per-user context factory; the default opens that user's vault and auth.json. */
  context?: (dir: string) => Promise<ServerContext>;
}

interface UserRow {
  sub: string;
  dir: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

interface SessionRow {
  sub: string;
  expires_at: number;
  last_seen: number;
}

interface OpenUser {
  context: Promise<ServerContext>;
  usedAt: number;
  busy: number;
}

export class HostedRegistry {
  readonly home: string;
  private readonly db: Database;
  private readonly now: () => number;
  private readonly makeContext: (dir: string) => Promise<ServerContext>;
  private readonly open = new Map<string, OpenUser>();
  /**
   * Device grant only. `pollDeviceCredential` hands the credential back, so this
   * service's own store is never read or written; each credential goes to the
   * signed-in user's own `auth.json`.
   */
  private readonly login: AuthService;

  constructor(options: HostedOptions) {
    this.home = options.home;
    this.now = options.now ?? Date.now;
    this.makeContext = options.context ?? defaultContext;
    this.login = new AuthService({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const file = join(this.home, "hosted.sqlite");
    this.db = new Database(file, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    chmodSync(file, 0o600);
    this.db.run("DELETE FROM session WHERE expires_at <= ?", [this.now()]);
  }

  // ---------- login ----------

  async startLogin(): Promise<LoginStart> {
    const started = await this.login.startDevice();
    return {
      handle: started.handle,
      userCode: started.userCode,
      verificationUrl: started.verificationUrl,
      ...(started.verificationUrlComplete === started.verificationUrl
        ? {}
        : { verificationUrlComplete: started.verificationUrlComplete }),
      expiresIn: started.expiresIn,
    };
  }

  async pollLogin(handle: string): Promise<LoginPoll> {
    const result = await this.login.pollDeviceCredential(handle);
    if ("pending" in result) return result;
    const accessToken = result.accessToken;
    if (accessToken === undefined) {
      throw new AuthError("auth_required", "xAI returned no access token.", 401);
    }
    // The token came straight from auth.x.ai's token endpoint over TLS, so its
    // claims are as trustworthy as the connection; no signature check is needed
    // to read the subject.
    const claims = jwtClaims(accessToken);
    const sub = typeof claims?.sub === "string" && claims.sub.length > 0 ? claims.sub : undefined;
    if (sub === undefined) {
      throw new AuthError("auth_unavailable", "xAI returned a token without a subject.", 502);
    }

    const profile = await this.login.userInfo(accessToken);
    const user = this.upsert(sub, {
      ...profile,
      ...(profile.email === undefined && result.email !== undefined ? { email: result.email } : {}),
    });
    // Through the user's own context, so a context already open for them sees
    // the new credential instead of holding the one it read at startup.
    const lease = await this.acquire(user);
    try {
      await lease.context.auth.store.set("xai", result);
    } finally {
      lease.release();
    }
    return { session: this.mintSession(sub), me: me(user) };
  }

  // ---------- users and sessions ----------

  upsert(sub: string, profile: XaiProfile): HostedUser {
    const at = this.now();
    const dir = join(this.home, "users", createHash("sha256").update(sub).digest("hex").slice(0, 24));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db.run(
      `INSERT INTO user (sub, dir, name, email, picture, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sub) DO UPDATE SET
         name = coalesce(excluded.name, user.name),
         email = coalesce(excluded.email, user.email),
         picture = coalesce(excluded.picture, user.picture),
         last_seen = excluded.last_seen`,
      [sub, dir, profile.name ?? null, profile.email ?? null, profile.picture ?? null, at, at],
    );
    const user = this.user(sub);
    if (user === undefined) throw new Error("The hosted registry lost a user it just wrote.");
    return user;
  }

  user(sub: string): HostedUser | undefined {
    const row = this.db
      .query<UserRow, [string]>("SELECT sub, dir, name, email, picture FROM user WHERE sub = ?")
      .get(sub);
    return row === null ? undefined : toUser(row);
  }

  mintSession(sub: string): string {
    const token = randomBytes(32).toString("base64url");
    const at = this.now();
    this.db.run(
      "INSERT INTO session (token_hash, sub, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)",
      [hash(token), sub, at, at + SESSION_TTL_MS, at],
    );
    return token;
  }

  /** Resolves a bearer token to its user, sliding `last_seen` at most once a minute. */
  resolve(token: string): HostedUser | undefined {
    const digest = hash(token);
    const row = this.db
      .query<SessionRow, [string]>("SELECT sub, expires_at, last_seen FROM session WHERE token_hash = ?")
      .get(digest);
    if (row === null) return undefined;
    const at = this.now();
    if (row.expires_at <= at) {
      this.db.run("DELETE FROM session WHERE token_hash = ?", [digest]);
      return undefined;
    }
    if (at - row.last_seen >= TOUCH_INTERVAL_MS) {
      this.db.run("UPDATE session SET last_seen = ? WHERE token_hash = ?", [at, digest]);
      this.db.run("UPDATE user SET last_seen = ? WHERE sub = ?", [at, row.sub]);
    }
    return this.user(row.sub);
  }

  revoke(token: string): void {
    this.db.run("DELETE FROM session WHERE token_hash = ?", [hash(token)]);
  }

  // ---------- per-user contexts ----------

  /**
   * Opens (or reuses) the user's kernel. Contexts are cached because opening a
   * vault is not free; `release` is what makes one evictable again, so a kernel
   * is never closed under a request or a live turn stream.
   */
  async acquire(user: HostedUser): Promise<Lease> {
    let entry = this.open.get(user.sub);
    if (entry === undefined) {
      entry = { context: this.makeContext(user.dir), usedAt: this.now(), busy: 0 };
      this.open.set(user.sub, entry);
    } else {
      this.open.delete(user.sub);
      this.open.set(user.sub, entry); // most recently used last
    }
    entry.busy += 1;
    entry.usedAt = this.now();

    const held = entry;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      held.busy -= 1;
      held.usedAt = this.now();
      this.sweep();
    };
    try {
      return { context: await held.context, release };
    } catch (error) {
      release();
      if (this.open.get(user.sub) === held) this.open.delete(user.sub);
      throw error;
    }
  }

  async close(): Promise<void> {
    const entries = [...this.open.values()];
    this.open.clear();
    for (const entry of entries) await closeEntry(entry);
    this.db.close();
  }

  /** Closes idle users, then the least recently used ones above the cap. */
  private sweep(): void {
    const at = this.now();
    const closing: OpenUser[] = [];
    for (const [sub, entry] of this.open) {
      if (entry.busy === 0 && at - entry.usedAt >= IDLE_CLOSE_MS) {
        this.open.delete(sub);
        closing.push(entry);
      }
    }
    let excess = this.open.size - MAX_OPEN_USERS;
    for (const [sub, entry] of this.open) {
      if (excess <= 0) break;
      if (entry.busy > 0) continue;
      this.open.delete(sub);
      closing.push(entry);
      excess -= 1;
    }
    for (const entry of closing) void closeEntry(entry);
  }
}

export function me(user: HostedUser): Me {
  return {
    hosted: true,
    sub: user.sub,
    ...(user.name === undefined ? {} : { name: user.name }),
    ...(user.email === undefined ? {} : { email: user.email }),
    ...(user.picture === undefined ? {} : { picture: user.picture }),
  };
}

/** `Authorization: Bearer <session>`; the same header is the gateway's API key. */
export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

async function defaultContext(dir: string): Promise<ServerContext> {
  return createContext({
    home: dir,
    auth: new AuthService({ store: new CredentialStore(join(dir, "auth.json")) }),
  });
}

async function closeEntry(entry: OpenUser): Promise<void> {
  try {
    await (await entry.context).kernel.close();
  } catch {
    // A context that failed to open, or a kernel already gone, needs no closing.
  }
}

function toUser(row: UserRow): HostedUser {
  return {
    sub: row.sub,
    dir: row.dir,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.email === null ? {} : { email: row.email }),
    ...(row.picture === null ? {} : { picture: row.picture }),
  };
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
