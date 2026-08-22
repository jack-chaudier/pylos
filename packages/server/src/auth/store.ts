import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderId } from "@pylos/protocol";
import { authPath } from "../home.ts";

const MAX_AUTH_BYTES = 256 * 1024;

export interface ApiKeyCredential {
  mode: "api-key";
  apiKey: string;
  baseUrl?: string; // openai-compatible
  obtainedAt: number;
}

export interface OauthCredential {
  mode: "oauth";
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  obtainedAt?: number;
  email?: string;
  source?: "device" | "grok-cli";
}

export type Credential = ApiKeyCredential | OauthCredential;

export interface CredentialFile {
  version: 1;
  providers: Partial<Record<ProviderId, Credential>>;
}

/**
 * Credential custody. One file, `0600`, atomic replace, never in the vault,
 * never in an export, never in an API response (PLAN.md "Decisions").
 */
export class CredentialStore {
  readonly path: string;
  private cache: CredentialFile | undefined;
  private writeFlight: Promise<void> = Promise.resolve();

  constructor(path = authPath()) {
    this.path = path;
  }

  async read(): Promise<CredentialFile> {
    if (this.cache !== undefined) return this.cache;
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(this.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        this.cache = { version: 1, providers: {} };
        return this.cache;
      }
      throw new Error("Unable to inspect the local credential store.");
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_AUTH_BYTES) {
        throw new Error("The local credential store is not a safe regular file.");
      }
      if ((info.mode & 0o077) !== 0) {
        await chmod(this.path, 0o600);
      }
      const text = await file.readFile("utf8");
      this.cache = parseFile(text);
      return this.cache;
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  async get(provider: ProviderId): Promise<Credential | undefined> {
    return (await this.read()).providers[provider];
  }

  async set(provider: ProviderId, credential: Credential): Promise<void> {
    const current = await this.read();
    const next: CredentialFile = {
      version: 1,
      providers: { ...current.providers, [provider]: credential },
    };
    await this.commit(next);
  }

  async clear(provider: ProviderId): Promise<void> {
    const current = await this.read();
    const providers = { ...current.providers };
    delete providers[provider];
    await this.commit({ version: 1, providers });
  }

  async destroy(): Promise<void> {
    this.cache = { version: 1, providers: {} };
    await rm(this.path, { force: true }).catch(() => undefined);
  }

  private commit(next: CredentialFile): Promise<void> {
    this.cache = next;
    this.writeFlight = this.writeFlight.then(() => writeAtomic(this.path, next));
    return this.writeFlight;
  }
}

async function writeAtomic(path: string, value: CredentialFile): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = join(directory, `.auth-${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error(`Unable to write the local credential store: ${errorName(error)}`);
  }
}

function parseFile(text: string): CredentialFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The local credential store is not valid JSON.");
  }
  if (!isRecord(value) || !isRecord(value.providers)) return { version: 1, providers: {} };
  const providers: Partial<Record<ProviderId, Credential>> = {};
  for (const [key, raw] of Object.entries(value.providers)) {
    const credential = parseCredential(raw);
    if (credential !== undefined) providers[key as ProviderId] = credential;
  }
  return { version: 1, providers };
}

function parseCredential(raw: unknown): Credential | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.mode === "api-key") {
    if (typeof raw.apiKey !== "string" || raw.apiKey.length === 0) return undefined;
    return {
      mode: "api-key",
      apiKey: raw.apiKey,
      ...(typeof raw.baseUrl === "string" ? { baseUrl: raw.baseUrl } : {}),
      obtainedAt: typeof raw.obtainedAt === "number" ? raw.obtainedAt : Date.now(),
    };
  }
  if (raw.mode === "oauth") {
    const accessToken = optionalString(raw.accessToken);
    const refreshToken = optionalString(raw.refreshToken);
    if (accessToken === undefined && refreshToken === undefined) return undefined;
    return {
      mode: "oauth",
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(typeof raw.expiresAt === "number" ? { expiresAt: raw.expiresAt } : {}),
      ...(typeof raw.obtainedAt === "number" ? { obtainedAt: raw.obtainedAt } : {}),
      ...(optionalString(raw.email) === undefined ? {} : { email: raw.email as string }),
      ...(raw.source === "device" || raw.source === "grok-cli"
        ? { source: raw.source as "device" | "grok-cli" }
        : {}),
    };
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === code;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "error";
}
