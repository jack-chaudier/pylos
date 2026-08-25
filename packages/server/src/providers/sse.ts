import { ProviderError } from "./types.ts";

/** Minimal, allocation-light SSE reader shared by every HTTP provider. */
export interface SseFrame {
  event?: string;
  data: string;
}

/** Raw bytes permitted in one provider event before its blank-line delimiter. */
export const MAX_SSE_FRAME_BYTES = 1024 * 1024;
/** Total raw wire bytes, including SSE comments and framing overhead. */
export const MAX_SSE_STREAM_BYTES = 8 * 1024 * 1024;
/** Maximum silence after provider headers or between SSE chunks. */
export const PROVIDER_SSE_INACTIVITY_TIMEOUT_MS = 60_000;
/** Hard wall-clock ceiling for one provider response stream. */
export const PROVIDER_SSE_TOTAL_TIMEOUT_MS = 10 * 60_000;

export interface ReadSseOptions {
  inactivityTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxStreamBytes?: number;
  /** Cancels a post-header body read without waiting for the inactivity deadline. */
  signal?: AbortSignal;
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  options: ReadSseOptions = {},
): AsyncGenerator<SseFrame> {
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? PROVIDER_SSE_INACTIVITY_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? PROVIDER_SSE_TOTAL_TIMEOUT_MS;
  const maxStreamBytes = options.maxStreamBytes ?? MAX_SSE_STREAM_BYTES;
  if (!Number.isSafeInteger(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
    throw new RangeError("SSE inactivity timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new RangeError("SSE total timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes <= 0) {
    throw new RangeError("SSE stream byte limit must be a positive safe integer");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = performance.now() + totalTimeoutMs;
  // Four spare bytes admit a complete CRLF delimiter after an exactly-full
  // frame. The raw frame is decoded only after its delimiter is found, so a
  // huge single chunk cannot become a huge JavaScript string first.
  const frame = new Uint8Array(MAX_SSE_FRAME_BYTES + 4);
  let length = 0;
  let streamBytes = 0;
  try {
    for (;;) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw totalTimeout(totalTimeoutMs);
      const overallDeadlineWins = remainingMs <= inactivityTimeoutMs;
      const readTimeoutMs = Math.max(1, Math.ceil(Math.min(remainingMs, inactivityTimeoutMs)));
      const result = await readSseChunk(
        reader,
        readTimeoutMs,
        options.signal,
        overallDeadlineWins ? totalTimeout(totalTimeoutMs) : inactivityTimeout(inactivityTimeoutMs),
      );
      const { done, value } = result;
      if (done || value === undefined) break;
      if (performance.now() >= deadline) throw totalTimeout(totalTimeoutMs);
      if (value.byteLength > maxStreamBytes - streamBytes) {
        throw streamTooLarge(maxStreamBytes);
      }
      streamBytes += value.byteLength;
      for (const byte of value) {
        frame[length] = byte;
        length += 1;
        const delimiter = delimiterLength(frame, length);
        if (delimiter > 0) {
          const parsed = parseFrame(decoder.decode(frame.subarray(0, length - delimiter)));
          length = 0;
          if (parsed !== undefined) yield parsed;
          continue;
        }
        // A trailing delimiter prefix is not frame content yet. Everything
        // before it is, counted as raw bytes so a UTF-8 sequence split across
        // network chunks cannot evade the bound through code-unit accounting.
        if (length - delimiterPrefixLength(frame, length) > MAX_SSE_FRAME_BYTES) {
          throw oversizedFrame();
        }
      }
    }
    if (length > MAX_SSE_FRAME_BYTES) throw oversizedFrame();
    const tail = parseFrame(decoder.decode(frame.subarray(0, length)));
    if (tail !== undefined) yield tail;
  } finally {
    // Initiate cancellation without letting a broken upstream `cancel()` hold
    // the bounded refusal open indefinitely.
    void reader.cancel().catch(() => undefined);
  }
}

function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutError: ProviderError,
): Promise<{ done: boolean; value?: Uint8Array }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      finish(() => reject(abortReason(signal as AbortSignal)));
    };
    const timer = setTimeout(() => {
      finish(() => reject(timeoutError));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    void reader.read().then(
      (result) => {
        finish(() => resolve(result));
      },
      (error) => {
        finish(() => reject(error));
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The provider request was cancelled.", "AbortError");
}

function delimiterLength(bytes: Uint8Array, length: number): 0 | 2 | 4 {
  if (length >= 2 && bytes[length - 2] === 10 && bytes[length - 1] === 10) return 2;
  if (
    length >= 4 &&
    bytes[length - 4] === 13 &&
    bytes[length - 3] === 10 &&
    bytes[length - 2] === 13 &&
    bytes[length - 1] === 10
  ) {
    return 4;
  }
  return 0;
}

/** Longest trailing byte run that could still become a supported delimiter. */
function delimiterPrefixLength(bytes: Uint8Array, length: number): 0 | 1 | 2 | 3 {
  if (length >= 3 && bytes[length - 3] === 13 && bytes[length - 2] === 10 && bytes[length - 1] === 13) {
    return 3;
  }
  if (length >= 2 && bytes[length - 2] === 13 && bytes[length - 1] === 10) return 2;
  const last = bytes[length - 1];
  return last === 10 || last === 13 ? 1 : 0;
}

function oversizedFrame(): ProviderError {
  return new ProviderError(
    "provider_output_limit",
    `Provider stream frame exceeded the ${MAX_SSE_FRAME_BYTES}-byte limit.`,
    502,
  );
}

function streamTooLarge(limit: number): ProviderError {
  return new ProviderError(
    "provider_output_limit",
    `Provider stream exceeded the ${limit}-byte raw limit.`,
    502,
  );
}

function inactivityTimeout(timeoutMs: number): ProviderError {
  return new ProviderError("provider_timeout", `Provider stream was inactive for ${timeoutMs} ms.`, 504);
}

function totalTimeout(timeoutMs: number): ProviderError {
  return new ProviderError(
    "provider_timeout",
    `Provider stream exceeded the ${timeoutMs} ms overall deadline.`,
    504,
  );
}

function parseFrame(raw: string): SseFrame | undefined {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
  if (data.length === 0 && event === undefined) return undefined;
  return event === undefined ? { data: data.join("\n") } : { event, data: data.join("\n") };
}

export function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
