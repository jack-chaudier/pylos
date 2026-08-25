import { attachmentMetadataFailure } from "@pylos/core";
import {
  type AtomPhase,
  DEFAULT_BUDGET,
  MAX_THREAD_LIST_ROWS,
  MAX_THREAD_SETTINGS_BYTES,
  MAX_THREAD_TITLE_BYTES,
  type Me,
  type ModelInfo,
  type ProviderId,
  PYLOS_VERSION,
  type Seq,
  type TurnRequest,
} from "@pylos/protocol";
import type { AuthService } from "./auth/xai.ts";
import { AuthError } from "./auth/xai.ts";
import { createContext, type ServerContext } from "./context.ts";
import { handleGatewayCompletions, handleGatewayModels } from "./gateway.ts";
import { pylosHome } from "./home.ts";
import { bearerToken, HostedRegistry, me } from "./hosted.ts";
import {
  corsHeaders,
  errorResponse,
  HttpError,
  isLoopbackHost,
  json,
  originAllowed,
  queryNumber,
  readBody,
  readJson,
  requireString,
  SseStream,
} from "./http.ts";
import type { Kernel } from "./kernel.ts";
import {
  clientKey,
  declaredLength,
  LOGINS_PER_MINUTE,
  MAX_REQUEST_BODY_BYTES,
  MAX_THREAD_CREATE_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  type RequestServer,
  TokenBucket,
  TURNS_PER_MINUTE,
} from "./limits.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import { DEFAULT_MODEL, HOSTED_PROVIDER_IDS } from "./providers/registry.ts";
import { ProviderError } from "./providers/types.ts";
import { defaultWebDir, type StaticSite, staticSite } from "./static.ts";
import {
  optionalBudget,
  optionalExportRange,
  optionalModel,
  optionalShares,
  requiredBudget,
  requiredModel,
} from "./validation.ts";

export interface ServeOptions {
  port?: number;
  home?: string;
  /** Multi-user: one vault per signed-in xAI subject, sessions instead of loopback trust. */
  hosted?: boolean;
  host?: string;
  /** Directory of the built single-page app, served under `/app/`. */
  web?: string;
  /** Browser origins allowed to make state-changing requests in hosted mode. */
  origins?: readonly string[];
  kernel?: Kernel;
  auth?: AuthService;
  registry?: ProviderRegistry;
}

export type Handler = (request: Request, server?: RequestServer) => Promise<Response>;

/** Full-scale desktop import: the bundle is the request body, and this header
 * carries its UTF-8 passphrase as unpadded base64url. The loopback/origin gate
 * above still authenticates the caller; the passphrase authenticates the bundle. */
export const RAW_IMPORT_CONTENT_TYPE = "application/octet-stream";
export const RAW_IMPORT_PASSPHRASE_HEADER = "X-Pylos-Passphrase";
/** Multipart attachments are bounded by count as well as the aggregate body. */
export const MAX_ATTACHMENT_FILES = 256;

export interface PylosServer {
  port: number;
  url: string;
  hosted: boolean;
  /** The built app being served at `/app/`, if one was given or found. */
  web?: string;
  /** Local mode only; hosted mode holds one context per signed-in user. */
  context?: ServerContext;
  fetch: Handler;
  stop(): Promise<void>;
}

interface HostedMode {
  kind: "hosted";
  registry: HostedRegistry;
  origins: readonly string[];
  turnRate: TokenBucket;
  logins: TokenBucket;
}

type Mode = { kind: "local"; context: ServerContext } | HostedMode;

interface Gate {
  mode: Mode;
  site: StaticSite | undefined;
}

export function createFetch(context: ServerContext, options: { site?: StaticSite } = {}): Handler {
  return makeHandler({ mode: { kind: "local", context }, site: options.site });
}

export function createHostedFetch(options: {
  registry: HostedRegistry;
  origins?: readonly string[];
  site?: StaticSite;
}): Handler {
  return makeHandler({
    mode: {
      kind: "hosted",
      registry: options.registry,
      origins: options.origins ?? [],
      turnRate: new TokenBucket(TURNS_PER_MINUTE),
      logins: new TokenBucket(LOGINS_PER_MINUTE),
    },
    site: options.site,
  });
}

function makeHandler(gate: Gate): Handler {
  const origins = gate.mode.kind === "hosted" ? gate.mode.origins : undefined;
  return async (request: Request, server?: RequestServer): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin, origins);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    // A browser Origin is an assertion about who initiated the request, not
    // merely a CORS response hint. Reject foreign origins before touching the
    // static site or any API route, including read-only routes that could be
    // used to make a local vault do expensive work cross-site.
    if (!originPermitted(origin, origins)) {
      return json({ error: "Origin is not allowed.", code: "origin_denied" }, { status: 403 });
    }
    // Hosted mode is reached through a proxy or a public address; only the local
    // server can insist the client is talking to a loopback name.
    if (
      gate.mode.kind === "local" &&
      (!isLoopbackHost(request.headers.get("host")) || !isLoopbackPeer(request, server))
    ) {
      return json({ error: "Pylos serves loopback clients only.", code: "not_loopback" }, { status: 403 });
    }

    try {
      if (gate.site !== undefined) {
        const asset = await gate.site.handle(url, request.method);
        if (asset !== undefined) return withHeaders(asset, cors);
      }
      const response =
        gate.mode.kind === "hosted"
          ? await hostedRoute(gate.mode, request, url, server)
          : await localRoute(gate.mode.context, request, url);
      return withHeaders(response, cors);
    } catch (error) {
      return withHeaders(errorResponse(normalizeError(error)), cors);
    }
  };
}

/**
 * Every browser Origin must identify this app before any route work begins.
 * Hosted mode also serves non-browser clients, which send no `Origin` at all;
 * their normal session checks remain responsible for authentication.
 */
function originPermitted(origin: string | null, origins: readonly string[] | undefined): boolean {
  // Native and CLI clients omit Origin entirely. The route's normal session or
  // loopback checks remain responsible for authenticating those callers.
  if (origin === null) return true;
  // The literal `null` is a present, opaque browser origin (sandboxed iframe,
  // data/file URL), never the missing header used by native/CLI clients. It is
  // rejected even with a bearer so it cannot drive a localhost or hosted route.
  if (origin === "null") return false;
  return origins === undefined ? originAllowed(origin) : originAllowed(origin, origins);
}

function withHeaders(response: Response, extra: Record<string, string>): Response {
  for (const [key, value] of Object.entries(extra)) response.headers.set(key, value);
  return response;
}

function normalizeError(error: unknown): unknown {
  if (error instanceof AuthError) return new HttpError(error.status, error.code, error.message);
  if (error instanceof ProviderError) return new HttpError(error.status, error.code, error.message);
  return error;
}

function isLoopbackPeer(request: Request, server: RequestServer | undefined): boolean {
  const address = server?.requestIP(request)?.address;
  if (address === undefined) return true;
  const bare =
    address
      .replace(/^\[|\]$/g, "")
      .replace(/^::ffff:/i, "")
      .split("%", 1)[0] ?? "";
  return /^127\./u.test(bare) || bare === "::1" || bare === "0:0:0:0:0:0:0:1";
}

// ---------- hosted ----------

async function hostedRoute(
  mode: HostedMode,
  request: Request,
  url: URL,
  server: RequestServer | undefined,
): Promise<Response> {
  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  const method = request.method;

  if (segments[0] === "api" && segments[1] === "health" && segments.length === 2 && method === "GET") {
    return json({ ok: true, version: PYLOS_VERSION, hosted: true });
  }
  if (segments[0] === "api" && segments[1] === "login") {
    return loginRoutes(mode, request, segments, method, server);
  }

  const token = bearerToken(request);
  if (token === undefined) {
    throw new HttpError(401, "no_session", "Sign in with your xAI account first.");
  }
  const user = mode.registry.resolve(token);
  if (user === undefined) {
    throw new HttpError(401, "invalid_session", "This session has expired. Sign in again.");
  }

  if (segments[0] === "api" && segments.length === 2 && segments[1] === "me" && method === "GET") {
    return json(me(user));
  }
  if (segments[0] === "api" && segments.length === 2 && segments[1] === "logout" && method === "POST") {
    mode.registry.revoke(token);
    return json({ ok: true });
  }

  const turn = isTurn(segments, method);
  if (turn && !mode.turnRate.take(user.sub)) {
    throw new HttpError(429, "rate_limited", "Too many turns in a minute. Try again shortly.");
  }
  const turnLease = turn ? mode.registry.turns.tryAcquire(user.sub) : undefined;
  if (turn && turnLease === undefined) {
    throw new HttpError(
      429,
      "turn_capacity",
      "This account or server is already handling too many active turns.",
    );
  }

  const heavyKind = heavyRoute(segments, method);
  const heavyLease = heavyKind === undefined ? undefined : mode.registry.heavy.tryAcquire(user.sub);
  if (heavyKind !== undefined && heavyLease === undefined) {
    throw new HttpError(429, "heavy_busy", "This account or server is already handling a heavy operation.");
  }

  let lease: Awaited<ReturnType<HostedRegistry["acquire"]>> | undefined;
  const release = (): void => {
    lease?.release();
    heavyLease?.release();
    turnLease?.release();
  };
  try {
    lease = await mode.registry.acquire(user);
    const response = await localRoute(lease.context, request, url, true);
    return retain(response, request, release, heavyKind === "export");
  } catch (error) {
    release();
    throw error;
  }
}

async function loginRoutes(
  mode: HostedMode,
  request: Request,
  segments: string[],
  method: string,
  server: RequestServer | undefined,
): Promise<Response> {
  if (segments[2] !== "xai" || method !== "POST") {
    throw new HttpError(404, "not_found", "No such login route.");
  }
  const spend = (): void => {
    if (!mode.logins.take(clientKey(request, server))) {
      throw new HttpError(429, "rate_limited", "Too many sign-in attempts. Try again shortly.");
    }
  };
  if (segments[3] === "start" && segments.length === 4) {
    spend();
    return json(await mode.registry.startLogin());
  }
  if (segments[3] === "poll" && segments.length === 4) {
    const body = await readJson<{ handle?: string }>(request);
    const handle = requireString(body.handle, "handle");
    // A poll of a grant this server started is already interval-gated by the
    // device flow; only starting a sign-in — or guessing at a handle — counts
    // against the address, so a patient browser is never locked out of its own.
    if (!mode.registry.knowsLogin(handle)) spend();
    return json(await mode.registry.pollLogin(handle));
  }
  throw new HttpError(404, "not_found", "No such login route.");
}

function isTurn(segments: string[], method: string): boolean {
  if (method !== "POST") return false;
  if (segments[0] === "v1" && segments[1] === "chat" && segments[2] === "completions") return true;
  return (
    segments[0] === "api" && segments[1] === "threads" && segments.length === 4 && segments[3] === "turn"
  );
}

type HeavyRoute = "import" | "export" | "verify" | "forget" | "demo" | "maintenance";

function heavyRoute(segments: string[], method: string): HeavyRoute | undefined {
  if (segments[0] !== "api") return undefined;
  if (segments[1] === "import" && segments.length === 2 && method === "POST") return "import";
  if (segments[1] !== "threads" || segments.length !== 4) return undefined;
  if (segments[3] === "export" && method === "POST") return "export";
  if (segments[3] === "verify" && (method === "GET" || method === "POST")) return "verify";
  if (segments[3] === "forget" && method === "POST") return "forget";
  if (segments[3] === "demo" && method === "POST") return "demo";
  if (segments[3] === "maintenance" && method === "POST") return "maintenance";
  return undefined;
}

/**
 * A turn stream outlives the handler that returned it, so the user's kernel has
 * to stay open until the last byte (or until the client goes away).
 */
function retain(response: Response, request: Request, release: () => void, holdBody = false): Response {
  const body = response.body;
  const streaming = (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
  if (body === null || (!streaming && !holdBody)) {
    release();
    return response;
  }
  if (request.signal.aborted) {
    release();
    void body.cancel(request.signal.reason).catch(() => undefined);
    return response;
  }
  const reader = body.getReader();
  let released = false;
  const finish = (): void => {
    if (released) return;
    released = true;
    request.signal.removeEventListener("abort", onAbort);
    release();
  };
  const onAbort = (): void => {
    finish();
    void reader.cancel(request.signal.reason).catch(() => undefined);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const held = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(item.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      void reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(held, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ---------- routes ----------

async function localRoute(
  context: ServerContext,
  request: Request,
  url: URL,
  hosted = false,
): Promise<Response> {
  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  const method = request.method;
  const allowedProviders = hosted ? HOSTED_PROVIDER_IDS : undefined;

  if (segments[0] === "v1") {
    if (segments[1] === "chat" && segments[2] === "completions" && method === "POST") {
      return handleGatewayCompletions(context, request, allowedProviders);
    }
    if (segments[1] === "models" && method === "GET") {
      return handleGatewayModels(context, allowedProviders);
    }
    throw new HttpError(404, "not_found", "No such gateway route.");
  }

  if (segments[0] !== "api") throw new HttpError(404, "not_found", "No such route.");

  // ---------- health ----------
  if (segments[1] === "health" && segments.length === 2 && method === "GET") {
    return json({
      ok: true,
      version: PYLOS_VERSION,
      home: context.kernel.home,
      backend: context.kernel.backend,
    });
  }

  // ---------- identity ----------
  if (segments[1] === "me" && segments.length === 2 && method === "GET") {
    const identity: Me = { hosted: false };
    return json(identity);
  }

  // ---------- models ----------
  if (segments[1] === "models" && segments.length === 2 && method === "GET") {
    const force = url.searchParams.get("refresh") === "1";
    const models = await context.registry.models(force, allowedProviders);
    return json(sortModels(models));
  }

  // ---------- auth ----------
  if (segments[1] === "auth") return authRoutes(context, request, segments, method, hosted);

  // ---------- import ----------
  if (segments[1] === "import" && segments.length === 2 && method === "POST") {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType === RAW_IMPORT_CONTENT_TYPE) {
      return rawImportRoute(context, request);
    }
    if (contentType !== undefined && contentType !== "multipart/form-data") {
      throw new HttpError(
        415,
        "unsupported_media_type",
        "Import expects application/octet-stream or multipart/form-data.",
      );
    }
    checkUpload(request);
    const form = await boundedMultipartForm(request);
    const file = asFile(form.get("file"));
    const passphrase = form.get("passphrase");
    if (file === undefined || typeof passphrase !== "string") {
      throw new HttpError(400, "invalid_request", "`file` and `passphrase` are required.");
    }
    checkLegacyFile(file);
    validateImportPassphrase(passphrase);
    const stats = await context.kernel.importBundleStream(file.stream(), passphrase);
    return json(stats);
  }

  // ---------- threads ----------
  if (segments[1] !== "threads") throw new HttpError(404, "not_found", "No such route.");

  if (segments.length === 2) {
    if (method === "GET") {
      const after = url.searchParams.get("after") ?? undefined;
      const rawLimit = url.searchParams.get("limit");
      let limit: number | undefined;
      if (rawLimit !== null) {
        const parsed = Number(rawLimit);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          throw new HttpError(
            400,
            "invalid_thread_limit",
            "The thread-list limit must be a positive integer.",
          );
        }
        limit = Math.min(parsed, MAX_THREAD_LIST_ROWS);
      }
      const page = await context.kernel.listThreads({
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      });
      // Preserve the original array response for small, unfiltered callers;
      // bounded/continued pages carry their cursor envelope explicitly.
      return json(after === undefined && rawLimit === null && !page.hasMore ? page.threads : page);
    }
    if (method === "POST") {
      const body = await readJson<{ title?: unknown }>(request, MAX_THREAD_CREATE_BODY_BYTES);
      if (body.title !== undefined && typeof body.title !== "string") {
        throw new HttpError(400, "invalid_title", "`title` must be a string.");
      }
      const title = typeof body.title === "string" && body.title.length > 0 ? body.title : undefined;
      if (title !== undefined && Buffer.byteLength(title, "utf8") > MAX_THREAD_TITLE_BYTES) {
        throw new HttpError(413, "title_too_large", "The thread title exceeds its UTF-8 byte limit.");
      }
      return json(await context.kernel.createThread(title));
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  }

  const threadId = segments[2];
  if (threadId === undefined) throw new HttpError(404, "not_found", "No such thread.");

  if (segments.length === 3 && method === "GET") {
    const stats = await context.kernel.getThread(threadId);
    if (stats === undefined) throw new HttpError(404, "thread_not_found", "No such thread.");
    return json(stats);
  }

  const action = segments[3];

  if (action === "maintenance" && method === "POST") {
    // Maintenance is the remediation/progress path itself, so it checks the
    // fragment/source boundary but deliberately does not reject an existing
    // compaction backlog before advancing it.
    await assertMutableThread(context.kernel, threadId);
    return json(await context.kernel.maintenance(threadId));
  }

  if (action === "episodes" && method === "GET") {
    if (segments.length === 5) {
      const seq = Number(segments[4]);
      const episode = await context.kernel.episode(threadId, seq);
      if (episode === undefined) throw new HttpError(404, "episode_not_found", "No such episode.");
      return json(episode);
    }
    const before = queryNumber(url, "before");
    const after = queryNumber(url, "after");
    const limit = queryNumber(url, "limit");
    const page = await context.kernel.episodesPage(threadId, {
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
    });
    // Keep the long-standing array response for ordinary pages. A page that
    // hits the aggregate byte bound carries its truncation/continuation
    // receipt as an object, so clients cannot mistake omission for completion.
    return json(page.truncated ? page : page.episodes);
  }

  if (action === "search" && method === "GET") {
    return json(await context.kernel.search(threadId, url.searchParams.get("q") ?? ""));
  }

  if (action === "packets" && method === "GET" && segments.length === 5) {
    const key = segments[4] ?? "";
    const packet = /^[1-9]\d*$/u.test(key)
      ? await context.kernel.packet(threadId, Number(key))
      : await context.kernel.packetById(threadId, key);
    if (packet === undefined) throw new HttpError(404, "packet_not_found", "No such packet.");
    return json(packet);
  }

  if (action === "demo" && method === "GET") {
    if (segments.length === 4) {
      const summary = await context.kernel.demoSummary(threadId);
      if (summary === undefined) {
        throw new HttpError(404, "demo_not_found", "No persisted proof demo exists for this thread.");
      }
      return json(summary);
    }
    if (segments.length === 5 && segments[4] === "evidence") {
      const href = url.searchParams.get("href");
      if (href === null || href.length === 0) {
        throw new HttpError(400, "invalid_demo_evidence", "A proof evidence href is required.");
      }
      const resource = await boundedDemoEvidence(context.kernel, threadId, href);
      if (resource === undefined) {
        throw new HttpError(
          404,
          "demo_evidence_not_found",
          "No bounded proof evidence exists for that locator.",
        );
      }
      return json(resource);
    }
    if (segments.length === 6 && segments[4] === "packets") {
      const packet = await context.kernel.demoPacket(threadId, segments[5] ?? "");
      if (packet === undefined) throw new HttpError(404, "demo_packet_not_found", "No such demo packet.");
      return json(packet);
    }
    if (segments.length === 6 && segments[4] === "routes") {
      const route = await context.kernel.demoRoute(threadId, segments[5] ?? "");
      if (route === undefined) throw new HttpError(404, "demo_route_not_found", "No such demo route.");
      return json(route);
    }
    if (segments.length === 8 && segments[4] === "attachments" && segments[6] === "spans") {
      const seq = Number(segments[5]);
      const ordinal = Number(segments[7]);
      if (!Number.isSafeInteger(seq) || seq <= 0 || !Number.isSafeInteger(ordinal) || ordinal < 0) {
        throw new HttpError(
          400,
          "invalid_demo_span",
          "The attachment sequence and span ordinal are invalid.",
        );
      }
      const span = await context.kernel.demoAttachmentSpan(threadId, seq, ordinal);
      if (span === undefined) throw new HttpError(404, "demo_span_not_found", "No such attachment span.");
      return json(span);
    }
    throw new HttpError(404, "not_found", "No such demo resource.");
  }

  /**
   * Resolve a proof link to a kernel-owned bounded projection. The generic
   * episode/packet endpoints are intentionally not called here: they are X-ray
   * APIs and may contain imported provider text of arbitrary size.
   */
  async function boundedDemoEvidence(
    kernel: Kernel,
    threadId: string,
    href: string,
  ): Promise<unknown | undefined> {
    let parsed: URL;
    try {
      parsed = new URL(href, "http://pylos.local");
    } catch {
      throw new HttpError(400, "invalid_demo_evidence", "The proof evidence href is invalid.");
    }
    if (parsed.origin !== "http://pylos.local" || parsed.search.length > 0 || parsed.hash.length > 0) {
      throw new HttpError(400, "invalid_demo_evidence", "The proof evidence href must be a local path.");
    }
    const source = parsed.pathname.split("/").filter((part) => part.length > 0);
    if (source[0] !== "api" || source[1] !== "threads" || decodeEvidenceSegment(source[2]) !== threadId) {
      throw new HttpError(403, "invalid_demo_evidence", "The proof evidence locator is outside this thread.");
    }
    const action = source[3];
    if (action === "episodes" && source.length === 5) {
      const seq = Number(source[4]);
      if (!Number.isSafeInteger(seq) || seq <= 0) {
        throw new HttpError(400, "invalid_demo_evidence", "The episode locator is invalid.");
      }
      return kernel.demoEpisode(threadId, seq);
    }
    if (action === "packets" && source.length === 5) {
      return kernel.demoPacket(threadId, decodeEvidenceSegment(source[4]));
    }
    if (action !== "demo") return undefined;
    if (source.length === 6 && source[4] === "packets") {
      return kernel.demoPacket(threadId, decodeEvidenceSegment(source[5]));
    }
    if (source.length === 6 && source[4] === "routes") {
      return kernel.demoRoute(threadId, decodeEvidenceSegment(source[5]));
    }
    if (source.length === 8 && source[4] === "attachments" && source[6] === "spans") {
      const seq = Number(source[5]);
      const ordinal = Number(source[7]);
      if (!Number.isSafeInteger(seq) || seq <= 0 || !Number.isSafeInteger(ordinal) || ordinal < 0) {
        throw new HttpError(400, "invalid_demo_evidence", "The attachment locator is invalid.");
      }
      return kernel.demoAttachmentSpan(threadId, seq, ordinal);
    }
    return undefined;
  }

  function decodeEvidenceSegment(value: string | undefined): string {
    try {
      return decodeURIComponent(value ?? "");
    } catch {
      throw new HttpError(400, "invalid_demo_evidence", "The proof evidence locator is invalid.");
    }
  }

  if (action === "atoms") {
    if (method === "GET" && segments.length === 4) {
      const phase = url.searchParams.get("phase");
      const after = url.searchParams.get("after") ?? undefined;
      const limit = queryNumber(url, "limit");
      const page = await context.kernel.atomsPage(threadId, {
        ...(phase === null ? {} : { phase: phase as AtomPhase }),
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      });
      return json(after === undefined && !page.hasMore ? page.atoms : page);
    }
    if (method === "POST" && segments.length === 6 && segments[5] === "pin") {
      await assertMutableThread(context.kernel, threadId);
      const body = await readJson<{ pinned?: boolean }>(request);
      const atom = await context.kernel.pinAtom(threadId, segments[4] ?? "", body.pinned !== false);
      if (atom === undefined) throw new HttpError(404, "atom_not_found", "No such atom.");
      return json(atom);
    }
  }

  if (action === "capsules" && method === "GET") {
    const level = queryNumber(url, "level");
    const after = url.searchParams.get("after") ?? undefined;
    const limit = queryNumber(url, "limit");
    const page = await context.kernel.capsulesPage(threadId, {
      ...(level === undefined ? {} : { level }),
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
    });
    return json(after === undefined && !page.hasMore ? page.capsules : page);
  }

  if (action === "ledger" && method === "GET") {
    const name = url.searchParams.get("name");
    const after = url.searchParams.get("after") ?? undefined;
    const limit = queryNumber(url, "limit");
    const page = await context.kernel.ledgerPage(threadId, {
      ...(name === null ? {} : { name }),
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
    });
    return json(after === undefined && !page.hasMore ? page.entries : page);
  }

  if (action === "verify" && (method === "POST" || method === "GET")) {
    return json(await context.kernel.verify(threadId));
  }

  if (action === "settings" && method === "POST") {
    await assertMutableThread(context.kernel, threadId);
    const body = await readJson<{ model?: string; budget?: number; shares?: unknown }>(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "invalid_settings", "Thread settings must be a JSON object.");
    }
    const model = optionalModel(body.model);
    const budget = optionalBudget(body.budget);
    const shares = optionalShares(body.shares);
    const current = await context.kernel.settings(threadId);
    const merged = {
      ...current,
      ...(model === undefined ? {} : { model }),
      ...(budget === undefined ? {} : { budget }),
      ...(shares === undefined ? {} : { shares }),
    };
    if (Buffer.byteLength(JSON.stringify(merged), "utf8") > MAX_THREAD_SETTINGS_BYTES) {
      throw new HttpError(413, "settings_too_large", "Thread settings exceed their UTF-8 byte limit.");
    }
    await context.kernel.setSettings(threadId, {
      ...(model === undefined ? {} : { model }),
      ...(budget === undefined ? {} : { budget }),
      ...(shares === undefined ? {} : { shares }),
    });
    return json(await context.kernel.settings(threadId));
  }

  if (action === "demo" && method === "POST") {
    await assertMutableThread(context.kernel, threadId);
    return json(await context.kernel.demo(threadId));
  }

  if (action === "attach" && method === "POST") {
    await assertMutableThread(context.kernel, threadId);
    checkUpload(request);
    const form = await boundedMultipartForm(request);
    const uploads: UploadedFile[] = [];
    for (const [, value] of form.entries()) {
      const file = asFile(value);
      if (file === undefined) continue;
      if (uploads.length >= MAX_ATTACHMENT_FILES) {
        throw new HttpError(
          413,
          "too_many_files",
          `An attachment upload may contain at most ${MAX_ATTACHMENT_FILES} files.`,
        );
      }
      checkAttachmentMetadata(file);
      uploads.push(file);
    }
    checkAttachmentAggregate(uploads);
    const files: Array<{ name: string; mime: string; bytes: Uint8Array }> = [];
    for (const file of uploads) {
      files.push({
        name: file.name,
        mime: file.type.length > 0 ? file.type : "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    }
    if (files.length === 0) throw new HttpError(400, "no_files", "No files were uploaded.");
    return json(await context.kernel.attach(threadId, files));
  }

  // The divider is written by the next turn, once a model has actually spoken
  // (KERNEL §6). The route stays for API clients: it switches the thread's model
  // and writes the divider only when the model that last spoke is a different one.
  if (action === "handoff" && method === "POST") {
    const body = await readJson<{ model?: string }>(request);
    const model = requiredModel(body.model);
    await assertMutableThread(context.kernel, threadId);
    const resolved = await context.registry.resolve(model, allowedProviders);
    const episode = await context.kernel.handoff(threadId, resolved.model, resolved.provider);
    return episode === undefined ? json({ ok: true, changed: false }) : json(episode);
  }

  if (action === "forget" && method === "POST") {
    // Forget is the explicit remediation path for a quarantined source. A
    // partial fragment remains immutable, but a complete legacy chain must
    // retain this escape hatch so it cannot be silently bricked.
    await assertFragmentMutableThread(context.kernel, threadId);
    const body = await readJson<{ seqs?: Seq[]; atomIds?: string[]; reason?: string }>(request);
    return json(
      await context.kernel.forget(threadId, {
        ...(Array.isArray(body.seqs) ? { seqs: body.seqs } : {}),
        ...(Array.isArray(body.atomIds) ? { atomIds: body.atomIds } : {}),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      }),
    );
  }

  if (action === "export" && method === "POST") {
    const body = await readJson<{ passphrase?: string; range?: [Seq, Seq] }>(request);
    const passphrase = requireString(body.passphrase, "passphrase");
    if (passphrase.length < 8) {
      throw new HttpError(400, "weak_passphrase", "Use a passphrase of at least 8 characters.");
    }
    const stats = await context.kernel.stats(threadId);
    const range = optionalExportRange(body.range, stats.turns);
    const bundle = await context.kernel.exportBundleStream(threadId, {
      passphrase,
      ...(range === undefined ? {} : { range }),
    });
    return new Response(bundle, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="pylos-${threadId.slice(0, 8)}-${stats.turns}.pylos"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (action === "turn" && method === "POST") {
    return turnRoute(context, request, threadId, allowedProviders);
  }

  throw new HttpError(404, "not_found", "No such route.");
}

function checkUpload(request: Request): void {
  if (declaredLength(request) > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "payload_too_large", "That upload is too large.");
  }
}

async function boundedMultipartForm(request: Request): Promise<FormData> {
  const bytes = await readBody(request, MAX_UPLOAD_BYTES, "That upload is too large.", "upload");
  // FormData parsing is intentionally downstream of the bounded collector.
  // Replaying at most MAX_UPLOAD_BYTES keeps Bun's multipart parser from
  // buffering an unbounded chunked request.
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: Buffer.from(bytes),
  }).formData();
}

export function checkAttachmentAggregate(files: ReadonlyArray<{ size?: number }>): void {
  if (files.length > MAX_ATTACHMENT_FILES) {
    throw new HttpError(
      413,
      "too_many_files",
      `An attachment upload may contain at most ${MAX_ATTACHMENT_FILES} files.`,
    );
  }
  let total = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0) {
      throw new HttpError(400, "invalid_file", "Uploaded files must declare a valid size.");
    }
    const size = file.size as number;
    if (size > MAX_UPLOAD_BYTES - total) {
      throw new HttpError(413, "payload_too_large", "The uploaded files are too large together.");
    }
    total += size;
  }
}

/** Reject unrepresentable attachment metadata before any bytes reach the kernel. */
export function checkAttachmentMetadata(file: Pick<UploadedFile, "name" | "type">): void {
  const mime = typeof file.type === "string" && file.type.length > 0 ? file.type : "application/octet-stream";
  const metadataFailure = attachmentMetadataFailure(mime, file.name);
  if (metadataFailure !== null) {
    throw new HttpError(413, "attachment_metadata_too_large", metadataFailure);
  }
}

async function rawImportRoute(context: ServerContext, request: Request): Promise<Response> {
  const passphrase = decodeImportPassphrase(request.headers.get(RAW_IMPORT_PASSPHRASE_HEADER));
  const body = request.body;
  if (body === null) throw new HttpError(400, "empty_bundle", "The import body is required.");
  // Keep this body unwrapped: the kernel stages and bounds the stream itself,
  // so a multi-gigabyte desktop bundle never enters Request.formData() or an
  // intermediate arrayBuffer().
  const stats = await context.kernel.importBundleStream(body, passphrase);
  return json(stats);
}

function checkLegacyFile(file: UploadedFile): void {
  if (file.size !== undefined && file.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "payload_too_large", "Legacy multipart imports are capped at 32 MiB.");
  }
}

function validateImportPassphrase(passphrase: string): void {
  if (passphrase.length < 8)
    throw new HttpError(400, "weak_passphrase", "Use a passphrase of at least 8 characters.");
}

function decodeImportPassphrase(encoded: string | null): string {
  if (
    encoded === null ||
    encoded.length === 0 ||
    encoded.length > 16_384 ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    throw new HttpError(
      400,
      "invalid_passphrase_header",
      "The import passphrase header is not valid base64url.",
    );
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    throw new HttpError(
      400,
      "invalid_passphrase_header",
      "The import passphrase header is not valid base64url.",
    );
  }
  if (bytes.length === 0 || bytes.toString("base64url") !== encoded) {
    throw new HttpError(
      400,
      "invalid_passphrase_header",
      "The import passphrase header is not valid base64url.",
    );
  }
  let passphrase: string;
  try {
    passphrase = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "invalid_passphrase_header", "The import passphrase header is not valid UTF-8.");
  }
  validateImportPassphrase(passphrase);
  return passphrase;
}

/**
 * Partial bundle imports are authenticated fragments, not mutable threads.
 * Check the durable marker before any route can claim a lane, resolve a
 * provider, or hand the request to a mutation-capable kernel operation.
 */
async function assertFragmentMutableThread(kernel: Kernel, threadId: string): Promise<void> {
  const fragment = await kernel.fragmentStatus(threadId);
  if (fragment === undefined) return;
  throw new HttpError(
    409,
    "fragment_read_only",
    `Thread ${threadId} is an authenticated read-only fragment (#${fragment.fromSeq}-#${fragment.toSeq}).`,
  );
}

async function assertMutableThread(kernel: Kernel, threadId: string): Promise<void> {
  await assertFragmentMutableThread(kernel, threadId);
  const readiness = await kernel.sourceReadiness(threadId);
  if (readiness === undefined) return;
  throw new HttpError(
    409,
    "source_not_ready",
    `Thread ${threadId} is quarantined at episode #${readiness.seq ?? "?"}: ${readiness.reason}. ` +
      "Forget the offending episode before starting a new turn.",
  );
}

// ---------- the turn ----------

async function turnRoute(
  context: ServerContext,
  request: Request,
  threadId: string,
  allowedProviders?: readonly ProviderId[],
): Promise<Response> {
  // Cheap body validation happens before the lane so malformed overrides cannot
  // consume queue capacity. Once accepted, the lane is claimed at arrival:
  // resolving the model and checking the provider happen while it is held, so
  // turns commit in arrival order rather than preparation-completion order.
  const body = await readJson<TurnRequest>(request);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "The turn body must be a JSON object.");
  }
  const text = requireString(body.text, "text");
  // Request overrides are rejected before claiming the lane. This keeps an
  // invalid budget/model from spending queue capacity or creating any rows.
  const requestedModel = optionalModel(body.model);
  const requestedBudget = optionalBudget(body.budget);
  await assertMutableThread(context.kernel, threadId);
  const ticket = context.kernel.enterTurn(threadId);
  try {
    const settings = await context.kernel.settings(threadId);
    const model =
      requestedModel ?? (settings.model === undefined ? DEFAULT_MODEL : requiredModel(settings.model));
    const budget =
      requestedBudget ?? (settings.budget === undefined ? DEFAULT_BUDGET : requiredBudget(settings.budget));

    const resolved = await context.registry.resolve(model, allowedProviders);
    if (resolved.provider !== "ollama" && !(await context.auth.configured(resolved.provider))) {
      // Not 401: the session is fine, the thread is not ready to run a turn.
      throw new HttpError(409, "no_provider", `Connect ${resolved.provider} before sending a turn.`);
    }
    const bound = await context.registry.providerFn(model, allowedProviders);
    const catalogue = await context.registry.models(false, allowedProviders);
    const supportsTools = catalogue.find((entry) => entry.id === bound.model)?.supportsTools !== false;

    // From here the turn owns the ticket and releases it when it ends.
    const turn = context.kernel.runTurn(
      threadId,
      {
        text,
        model: bound.model,
        provider: bound.provider,
        budget,
        supportsTools,
        signal: request.signal,
      },
      bound.fn,
      ticket,
    );

    const stream = new SseStream();
    const heartbeat = setInterval(() => stream.comment("keep-alive"), 15_000);

    void (async () => {
      try {
        for await (const event of turn) {
          if (request.signal.aborted || stream.isClosed) break;
          stream.send(event);
        }
      } catch (error) {
        const normalized = normalizeError(error) as { message?: string; code?: string };
        stream.send({
          type: "error",
          message: normalized.message ?? "The turn failed.",
          ...(normalized.code === undefined ? {} : { code: normalized.code }),
        });
      } finally {
        clearInterval(heartbeat);
        stream.close();
      }
    })();

    return stream.response;
  } catch (error) {
    // Nothing was streamed, so nothing will release the lane: a bad body or an
    // unconfigured provider must not leave the thread blocked. Releasing twice
    // is a no-op, so a throw after the handoff is safe here too.
    ticket.release();
    throw error;
  }
}

// ---------- auth ----------

const PROVIDERS: ProviderId[] = ["xai", "anthropic", "openai", "ollama", "openai-compatible"];

async function authRoutes(
  context: ServerContext,
  request: Request,
  segments: string[],
  method: string,
  hosted = false,
): Promise<Response> {
  if (segments.length === 2 && method === "GET") {
    return json(await context.auth.statuses());
  }
  const provider = segments[2] as ProviderId | undefined;
  if (provider === undefined || !PROVIDERS.includes(provider)) {
    throw new HttpError(404, "unknown_provider", "No such provider.");
  }

  if (provider === "xai" && segments[3] === "device") {
    if (segments[4] === "start" && method === "POST") {
      const started = await context.auth.startDevice();
      return json({
        handle: started.handle,
        userCode: started.userCode,
        verificationUrl: started.verificationUrlComplete,
        expiresIn: started.expiresIn,
        interval: started.interval,
      });
    }
    if (segments[4] === "poll" && method === "POST") {
      const body = await readJson<{ handle?: string }>(request);
      return json(await context.auth.pollDevice(requireString(body.handle, "handle")));
    }
  }

  if (provider === "xai" && segments[3] === "grok-cli" && method === "POST") {
    return json(await context.auth.importGrokCli());
  }
  if (provider === "xai" && segments[3] === "grok-cli" && method === "GET") {
    return json({ available: await context.auth.grokCliAvailable() });
  }

  if (segments[3] === "api-key" && method === "POST") {
    if (hosted && provider === "openai-compatible") {
      throw new HttpError(
        403,
        "hosted_provider_forbidden",
        "Hosted accounts may use only server-managed provider endpoints.",
      );
    }
    const body = await readJson<{ apiKey?: string; baseUrl?: string }>(request);
    return json(
      await context.auth.setApiKey(
        provider,
        requireString(body.apiKey, "apiKey"),
        typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      ),
    );
  }

  if (segments[3] === "logout" && method === "POST") {
    const status = await context.auth.logout(provider);
    await context.registry.models(true, hosted ? HOSTED_PROVIDER_IDS : undefined).catch(() => undefined);
    return json(status);
  }

  throw new HttpError(404, "not_found", "No such auth route.");
}

interface UploadedFile {
  name: string;
  type: string;
  size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  stream(): ReadableStream<Uint8Array>;
}

/** `File` is not a value in every runtime's lib; duck-type the upload instead. */
function asFile(value: unknown): UploadedFile | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<UploadedFile>;
  if (
    typeof candidate.arrayBuffer !== "function" ||
    typeof candidate.name !== "string" ||
    typeof candidate.stream !== "function"
  ) {
    return undefined;
  }
  return candidate as UploadedFile;
}

function sortModels(models: ModelInfo[]): ModelInfo[] {
  const order: Record<string, number> = {
    xai: 0,
    anthropic: 1,
    openai: 2,
    ollama: 3,
    "openai-compatible": 4,
  };
  return [...models].sort(
    (a, b) =>
      (order[a.provider] ?? 9) - (order[b.provider] ?? 9) ||
      Number(b.available) - Number(a.available) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
}

// ---------- entry ----------

export async function serve(options: ServeOptions = {}): Promise<PylosServer> {
  const hosted = options.hosted ?? process.env.PYLOS_HOSTED === "1";
  const home = options.home ?? pylosHome();
  const web = options.web ?? nonEmpty(process.env.PYLOS_WEB) ?? defaultWebDir();
  const site = web === undefined ? undefined : staticSite(web);
  const port = options.port ?? Number(process.env.PYLOS_PORT ?? 7334);
  const hostname = options.host ?? nonEmpty(process.env.PYLOS_HOST) ?? (hosted ? "0.0.0.0" : "127.0.0.1");

  let handler: Handler;
  let context: ServerContext | undefined;
  let shutdown: () => Promise<void>;

  if (hosted) {
    const registry = new HostedRegistry({ home });
    handler = createHostedFetch({
      registry,
      origins: options.origins ?? splitOrigins(process.env.PYLOS_ORIGIN),
      ...(site === undefined ? {} : { site }),
    });
    shutdown = () => registry.close();
  } else {
    context = await createContext({
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.kernel === undefined ? {} : { kernel: options.kernel }),
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.registry === undefined ? {} : { registry: options.registry }),
    });
    const single = context;
    handler = createFetch(single, site === undefined ? {} : { site });
    shutdown = () => single.kernel.close();
  }

  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: handler,
  });
  const bound = server.port ?? port;
  return {
    port: bound,
    url: `http://${hostname}:${bound}`,
    hosted,
    ...(web === undefined ? {} : { web }),
    ...(context === undefined ? {} : { context }),
    fetch: handler,
    stop: async () => {
      server.stop(true);
      await shutdown();
    },
  };
}

export function splitOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter((entry) => entry.length > 0);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

export { pylosHome };
