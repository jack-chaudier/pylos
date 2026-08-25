import { ProviderError } from "./types.ts";

export const PROVIDER_HEADER_TIMEOUT_MS = 15_000;

export type ProviderFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  label?: string;
}

/**
 * Bounds the wait for response headers even when an injected fetcher ignores
 * AbortSignal. The caller's cancellation remains distinct from the internal
 * deadline, and the combined signal is still passed to real `fetch()`.
 */
export async function fetchProvider(
  fetcher: ProviderFetcher,
  input: string,
  init: RequestInit = {},
  options: ProviderFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_HEADER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("provider header timeout must be a positive safe integer");
  }
  const caller = options.signal ?? init.signal ?? undefined;
  if (caller !== undefined && wasAborted(caller)) throw callerAbort(caller);

  const controller = new AbortController();
  // Keep the caller bound to the native fetch body after the header-only
  // deadline and its explicit listener are cleaned up. This is what makes a
  // post-header client abort tear down the upstream socket as well.
  const forwardedSignal =
    caller === undefined ? controller.signal : AbortSignal.any([controller.signal, caller]);
  let rejectAbort: (reason: unknown) => void = () => {};
  const abort = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onCallerAbort = (): void => {
    if (caller === undefined) return;
    const reason = callerAbort(caller);
    controller.abort(reason);
    rejectAbort(reason);
  };
  caller?.addEventListener("abort", onCallerAbort, { once: true });
  if (wasAborted(caller)) onCallerAbort();

  const label = options.label ?? "Provider";
  const timer = setTimeout(() => {
    const error = new ProviderError(
      "provider_timeout",
      `${label} did not return response headers within ${timeoutMs} ms.`,
      504,
    );
    controller.abort(error);
    rejectAbort(error);
  }, timeoutMs);
  const request = Promise.resolve().then(() =>
    fetcher(input, {
      ...init,
      signal: forwardedSignal,
    }),
  );
  try {
    return await Promise.race([request, abort]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  }
}

function callerAbort(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The provider request was cancelled.", "AbortError");
}

function wasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
