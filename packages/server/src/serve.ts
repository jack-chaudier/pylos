import {
  type AtomPhase,
  DEFAULT_BUDGET,
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
  optionalNumber,
  originAllowed,
  queryNumber,
  readJson,
  requireString,
  SseStream,
} from "./http.ts";
import type { Kernel } from "./kernel.ts";
import {
  clientKey,
  declaredLength,
  LOGINS_PER_MINUTE,
  MAX_UPLOAD_BYTES,
  type RequestServer,
  TokenBucket,
  TURNS_PER_MINUTE,
} from "./limits.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import { DEFAULT_MODEL } from "./providers/registry.ts";
import { ProviderError } from "./providers/types.ts";
import { defaultWebDir, type StaticSite, staticSite } from "./static.ts";

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

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface HostedMode {
  kind: "hosted";
  registry: HostedRegistry;
  origins: readonly string[];
  turns: TokenBucket;
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
      turns: new TokenBucket(TURNS_PER_MINUTE),
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
    // Hosted mode is reached through a proxy or a public address; only the local
    // server can insist the client is talking to a loopback name.
    if (gate.mode.kind === "local" && !isLoopbackHost(request.headers.get("host"))) {
      return json({ error: "Pylos serves loopback clients only.", code: "not_loopback" }, { status: 403 });
    }
    if (!originPermitted(request, origin, origins)) {
      return json({ error: "Origin is not allowed.", code: "origin_denied" }, { status: 403 });
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
 * Mutations must prove they were not forged by another site. Hosted mode also
 * serves non-browser clients, which send no `Origin` at all; those must carry a
 * session bearer instead.
 */
function originPermitted(
  request: Request,
  origin: string | null,
  origins: readonly string[] | undefined,
): boolean {
  if (!MUTATING.has(request.method)) return true;
  if (origins === undefined) return originAllowed(origin);
  if (origin === null || origin === "null") return bearerToken(request) !== undefined;
  return origins.includes(origin);
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

  if (isTurn(segments, method) && !mode.turns.take(user.sub)) {
    throw new HttpError(429, "rate_limited", "Too many turns in a minute. Try again shortly.");
  }

  const lease = await mode.registry.acquire(user);
  let response: Response;
  try {
    response = await localRoute(lease.context, request, url);
  } catch (error) {
    lease.release();
    throw error;
  }
  return retain(response, request, lease.release);
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
  if (!mode.logins.take(clientKey(request, server))) {
    throw new HttpError(429, "rate_limited", "Too many sign-in attempts. Try again shortly.");
  }
  if (segments[3] === "start" && segments.length === 4) {
    return json(await mode.registry.startLogin());
  }
  if (segments[3] === "poll" && segments.length === 4) {
    const body = await readJson<{ handle?: string }>(request);
    return json(await mode.registry.pollLogin(requireString(body.handle, "handle")));
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

/**
 * A turn stream outlives the handler that returned it, so the user's kernel has
 * to stay open until the last byte (or until the client goes away).
 */
function retain(response: Response, request: Request, release: () => void): Response {
  const body = response.body;
  if (body === null || !(response.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    release();
    return response;
  }
  request.signal.addEventListener("abort", release, { once: true });
  const held = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: release }));
  return new Response(held, { status: response.status, headers: response.headers });
}

// ---------- routes ----------

async function localRoute(context: ServerContext, request: Request, url: URL): Promise<Response> {
  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  const method = request.method;

  if (segments[0] === "v1") {
    if (segments[1] === "chat" && segments[2] === "completions" && method === "POST") {
      return handleGatewayCompletions(context, request);
    }
    if (segments[1] === "models" && method === "GET") return handleGatewayModels(context);
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
    const models = await context.registry.models(force);
    return json(sortModels(models));
  }

  // ---------- auth ----------
  if (segments[1] === "auth") return authRoutes(context, request, segments, method);

  // ---------- import ----------
  if (segments[1] === "import" && segments.length === 2 && method === "POST") {
    checkUpload(request);
    const form = await request.formData();
    const file = asFile(form.get("file"));
    const passphrase = form.get("passphrase");
    if (file === undefined || typeof passphrase !== "string") {
      throw new HttpError(400, "invalid_request", "`file` and `passphrase` are required.");
    }
    const stats = await context.kernel.importBundle(new Uint8Array(await file.arrayBuffer()), passphrase);
    return json(stats);
  }

  // ---------- threads ----------
  if (segments[1] !== "threads") throw new HttpError(404, "not_found", "No such route.");

  if (segments.length === 2) {
    if (method === "GET") return json(await context.kernel.listThreads());
    if (method === "POST") {
      const body = await readJson<{ title?: string }>(request);
      return json(
        await context.kernel.createThread(
          typeof body.title === "string" && body.title.length > 0 ? body.title : undefined,
        ),
      );
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
    return json(
      await context.kernel.episodes(threadId, {
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
  }

  if (action === "search" && method === "GET") {
    return json(await context.kernel.search(threadId, url.searchParams.get("q") ?? ""));
  }

  if (action === "packets" && method === "GET" && segments.length === 5) {
    const packet = await context.kernel.packet(threadId, Number(segments[4]));
    if (packet === undefined) throw new HttpError(404, "packet_not_found", "No such packet.");
    return json(packet);
  }

  if (action === "atoms") {
    if (method === "GET" && segments.length === 4) {
      const phase = url.searchParams.get("phase");
      return json(await context.kernel.atoms(threadId, phase === null ? undefined : (phase as AtomPhase)));
    }
    if (method === "POST" && segments.length === 6 && segments[5] === "pin") {
      const body = await readJson<{ pinned?: boolean }>(request);
      const atom = await context.kernel.pinAtom(threadId, segments[4] ?? "", body.pinned !== false);
      if (atom === undefined) throw new HttpError(404, "atom_not_found", "No such atom.");
      return json(atom);
    }
  }

  if (action === "capsules" && method === "GET") {
    const level = queryNumber(url, "level");
    return json(await context.kernel.capsules(threadId, level));
  }

  if (action === "ledger" && method === "GET") {
    const name = url.searchParams.get("name");
    const limit = queryNumber(url, "limit");
    return json(
      await context.kernel.ledger(threadId, {
        ...(name === null ? {} : { name }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
  }

  if (action === "verify" && (method === "POST" || method === "GET")) {
    return json(await context.kernel.verify(threadId));
  }

  if (action === "settings" && method === "POST") {
    const body = await readJson<{ model?: string; budget?: number }>(request);
    await context.kernel.setSettings(threadId, {
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(optionalNumber(body.budget) === undefined ? {} : { budget: body.budget as number }),
    });
    return json(await context.kernel.settings(threadId));
  }

  if (action === "attach" && method === "POST") {
    checkUpload(request);
    const form = await request.formData();
    const files: Array<{ name: string; mime: string; bytes: Uint8Array }> = [];
    for (const [, value] of form.entries()) {
      const file = asFile(value);
      if (file === undefined) continue;
      files.push({
        name: file.name,
        mime: file.type.length > 0 ? file.type : "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    }
    if (files.length === 0) throw new HttpError(400, "no_files", "No files were uploaded.");
    return json(await context.kernel.attach(threadId, files));
  }

  if (action === "handoff" && method === "POST") {
    const body = await readJson<{ model?: string }>(request);
    const model = requireString(body.model, "model");
    const resolved = await context.registry.resolve(model);
    const episode = await context.kernel.handoff(threadId, resolved.model, resolved.provider);
    return json(episode);
  }

  if (action === "forget" && method === "POST") {
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
    const bundle = await context.kernel.exportBundle(threadId, {
      passphrase,
      ...(Array.isArray(body.range) && body.range.length === 2 ? { range: body.range } : {}),
    });
    return new Response(bundle as BodyInit, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="pylos-${threadId.slice(0, 8)}-${stats.turns}.pylos"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (action === "turn" && method === "POST") {
    return turnRoute(context, request, threadId);
  }

  throw new HttpError(404, "not_found", "No such route.");
}

function checkUpload(request: Request): void {
  if (declaredLength(request) > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "payload_too_large", "That upload is too large.");
  }
}

// ---------- the turn ----------

async function turnRoute(context: ServerContext, request: Request, threadId: string): Promise<Response> {
  const body = await readJson<TurnRequest>(request);
  const text = requireString(body.text, "text");
  const settings = await context.kernel.settings(threadId);
  const model = body.model ?? settings.model ?? DEFAULT_MODEL;
  const budget = optionalNumber(body.budget) ?? settings.budget ?? DEFAULT_BUDGET;

  const resolved = await context.registry.resolve(model);
  if (resolved.provider !== "ollama" && !(await context.auth.configured(resolved.provider))) {
    throw new HttpError(401, "no_provider", `Connect ${resolved.provider} before sending a turn.`);
  }
  const bound = await context.registry.providerFn(model);
  const catalogue = await context.registry.models();
  const supportsTools = catalogue.find((entry) => entry.id === bound.model)?.supportsTools !== false;
  await context.kernel.setSettings(threadId, { model: bound.model, budget });

  // Claimed before the stream opens, so a thread with eight turns already
  // waiting answers `429 thread_busy` instead of a stream that says so.
  const turn = context.kernel.runTurn(
    threadId,
    {
      text,
      model: bound.model,
      provider: bound.provider,
      budget,
      supportsTools,
      signal: request.signal,
      ...(body.attachmentSeqs === undefined ? {} : { attachmentSeqs: body.attachmentSeqs }),
    },
    bound.fn,
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
}

// ---------- auth ----------

const PROVIDERS: ProviderId[] = ["xai", "anthropic", "openai", "ollama", "openai-compatible"];

async function authRoutes(
  context: ServerContext,
  request: Request,
  segments: string[],
  method: string,
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
    await context.registry.models(true).catch(() => undefined);
    return json(status);
  }

  throw new HttpError(404, "not_found", "No such auth route.");
}

interface UploadedFile {
  name: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** `File` is not a value in every runtime's lib; duck-type the upload instead. */
function asFile(value: unknown): UploadedFile | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<UploadedFile>;
  if (typeof candidate.arrayBuffer !== "function" || typeof candidate.name !== "string") {
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

  const server = Bun.serve({ hostname, port, idleTimeout: 0, fetch: handler });
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
