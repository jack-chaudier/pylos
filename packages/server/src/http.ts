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
 * Cross-site request forgery gate for mutations. Browsers always send `Origin`
 * on a cross-origin POST; native and CLI clients send none, so a missing header
 * is allowed while a present-and-foreign one is refused.
 */
export function originAllowed(origin: string | null): boolean {
  if (origin === null || origin === "null") return true;
  return ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null || !originAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Pylos-Thread, Authorization",
    "Access-Control-Max-Age": "600",
  };
}

export async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (text.trim().length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
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

/** Server-Sent Events writer for `TurnEvent` streams. */
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
        "Cache-Control": "no-store, no-transform",
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
