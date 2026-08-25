import { declaredLength, MAX_JSON_BYTES } from "./limits.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Loopback JSON should never be idle this long between chunks. The server's
 * socket idle timeout is disabled for SSE, so body reads enforce their own
 * per-read deadline instead. */
export const BODY_READ_INACTIVITY_MS = 1_000;
export const JSON_BODY_TRANSFER_DEADLINE_MS = 10_000;
export const UPLOAD_BODY_TRANSFER_DEADLINE_MS = 120_000;

export type BodyReadProfile = "json" | "upload";

function transferDeadline(profile: BodyReadProfile): number {
  const fallback = profile === "upload" ? UPLOAD_BODY_TRANSFER_DEADLINE_MS : JSON_BODY_TRANSFER_DEADLINE_MS;
  const override =
    process.env.NODE_ENV === "test"
      ? Number(
          process.env[
            profile === "upload"
              ? "PYLOS_TEST_UPLOAD_TRANSFER_DEADLINE_MS"
              : "PYLOS_TEST_JSON_TRANSFER_DEADLINE_MS"
          ],
        )
      : Number.NaN;
  return Number.isSafeInteger(override) && override > 0 ? override : fallback;
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { ...JSON_HEADERS, ...init.headers },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.message, code: error.code }, { status: error.status });
  }
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status =
    typeof candidate?.status === "number" && candidate.status >= 400 && candidate.status < 600
      ? candidate.status
      : 500;
  const code = typeof candidate?.code === "string" ? candidate.code : "internal_error";
  const message = typeof candidate?.message === "string" ? candidate.message : "Unexpected error.";
  return json({ error: message, code }, { status });
}

/** Loopback-only: the socket address must be a local one and Host must agree. */
export function isLoopbackHost(host: string | null): boolean {
  if (host === null) return true;
  const bare = host.replace(/^\[|\]$/g, "").split("]")[0] ?? host;
  const name = (bare.includes(":") && !bare.includes("::") ? bare.split(":")[0] : bare) ?? bare;
  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name === "::1" ||
    name === "0:0:0:0:0:0:0:1" ||
    name.endsWith(".localhost")
  );
}

const ORIGIN_PATTERNS = [
  /^tauri:\/\/localhost$/,
  /^https?:\/\/tauri\.localhost$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^http:\/\/\[::1\](:\d+)?$/,
];

/**
 * Cross-site request forgery gate for mutations. Locally (`allowed` omitted)
 * browsers always send `Origin` on a cross-origin POST while native and CLI
 * clients send none, so a missing header is allowed and a foreign one refused;
 * the literal `null` is an opaque browser origin, not a missing header.
 * Hosted, only the configured origins pass.
 */
export function originAllowed(origin: string | null, allowed?: readonly string[]): boolean {
  if (allowed !== undefined) {
    return origin !== null && origin !== "null" && allowed.includes(origin);
  }
  if (origin === null) return true;
  return ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

/** Never carries credentials: a session lives in the `Authorization` header, not a cookie. */
export function corsHeaders(origin: string | null, allowed?: readonly string[]): Record<string, string> {
  if (origin === null || !originAllowed(origin, allowed)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Pylos-Thread, Authorization, X-Pylos-Passphrase",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export async function readJson<T>(request: Request, limit = MAX_JSON_BYTES): Promise<T> {
  const bytes = await readBody(request, limit);
  const text = new TextDecoder().decode(bytes);
  if (text.trim().length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

/**
 * Read a request body with a hard byte ceiling, including when the transport
 * is chunked and has no Content-Length. The previous `request.text()` path
 * could allocate an entire untrusted body before checking its size.
 */
export async function readBody(
  request: Request,
  limit: number,
  tooLargeMessage = "The request body is too large.",
  profile: BodyReadProfile = "json",
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("body limit must be a non-negative safe integer");
  }
  if (declaredLength(request) > limit) {
    throw new HttpError(413, "payload_too_large", tooLargeMessage);
  }
  const body = request.body;
  if (body === null) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const absoluteDeadline = Date.now() + transferDeadline(profile);
  try {
    for (;;) {
      const remaining = absoluteDeadline - Date.now();
      if (remaining <= 0) {
        throw new HttpError(408, "request_timeout", "The request body exceeded its transfer deadline.");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Date.now() >= absoluteDeadline
                ? new HttpError(408, "request_timeout", "The request body exceeded its transfer deadline.")
                : new HttpError(408, "request_timeout", "The request body stopped sending bytes."),
            ),
          Math.min(BODY_READ_INACTIVITY_MS, remaining),
        );
      });
      const item = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      if (item.done) break;
      const chunk = item.value;
      if (chunk.byteLength > limit - total) {
        throw new HttpError(413, "payload_too_large", tooLargeMessage);
      }
      if (chunk.byteLength === 0) continue;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return new Uint8Array();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "invalid_request", `\`${field}\` is required.`);
  }
  return value;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function queryNumber(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Server-Sent Events writer for `TurnEvent` streams. The cache and buffering
 * headers are what keep a reverse proxy from holding the deltas back.
 */
export class SseStream {
  readonly response: Response;
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private closed = false;
  private readonly encoder = new TextEncoder();

  constructor(extraHeaders: Record<string, string> = {}) {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closed = true;
      },
    });
    this.response = new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...extraHeaders,
      },
    });
  }

  send(event: unknown): void {
    if (this.closed || this.controller === undefined) return;
    try {
      this.controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      this.closed = true;
    }
  }

  /** Emits a `data:` line verbatim (the OpenAI gateway's `[DONE]` sentinel). */
  raw(data: string): void {
    if (this.closed || this.controller === undefined) return;
    try {
      this.controller.enqueue(this.encoder.encode(`data: ${data}\n\n`));
    } catch {
      this.closed = true;
    }
  }

  comment(text: string): void {
    if (this.closed || this.controller === undefined) return;
    try {
      this.controller.enqueue(this.encoder.encode(`: ${text}\n\n`));
    } catch {
      this.closed = true;
    }
  }

  close(): void {
    if (this.closed || this.controller === undefined) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // already closed
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
