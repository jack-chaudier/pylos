import { useEffect, useRef, useState } from "react";
import type { ApiError } from "./api.ts";

const FALLBACK_MS = 2500;
const MAX_BACKOFF_MS = 10_000;

export interface DeviceFlow<T> {
  handle: string;
  /** Seconds the code stays valid, from the start response. */
  expiresIn: number;
  /** Seconds between polls the server asked for, when it said. */
  interval: number | undefined;
  poll: (handle: string) => Promise<{ pending: true } | T>;
  onDone: (result: T) => void;
}

/**
 * Waiting for a browser somewhere else. A refused network, a rate limit or a
 * five-hundred says nothing about the sign-in, so the flow keeps asking on a
 * backoff until the code itself expires; only a refusal from the auth route
 * ends it.
 */
export function useDeviceFlow<T extends object>(flow: DeviceFlow<T>): { error: string | undefined } {
  const [error, setError] = useState<string | undefined>(undefined);
  const latest = useRef(flow);
  latest.current = flow;
  const { handle, expiresIn } = flow;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const base = Math.max(1000, (latest.current.interval ?? 0) * 1000 || FALLBACK_MS);
    let wait = base;
    const deadline = Date.now() + Math.max(1, expiresIn) * 1000;
    setError(undefined);

    const again = (): void => {
      if (stopped) return;
      if (Date.now() >= deadline) {
        stopped = true;
        setError("That code expired. Start again.");
        return;
      }
      timer = setTimeout(() => void run(), wait);
    };

    const run = async (): Promise<void> => {
      if (stopped) return;
      try {
        const result = await latest.current.poll(handle);
        if ("pending" in result) {
          wait = base;
          setError(undefined);
          again();
          return;
        }
        stopped = true;
        latest.current.onDone(result);
      } catch (cause) {
        const failure = cause as ApiError;
        if (terminal(failure)) {
          stopped = true;
          setError(failure.message);
          return;
        }
        setError(failure.message);
        wait = Math.min(MAX_BACKOFF_MS, Math.round(wait * 1.6));
        again();
      }
    };

    timer = setTimeout(() => void run(), Math.min(base, FALLBACK_MS));
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [handle, expiresIn]);

  return { error };
}

/** A refusal, as opposed to a bad minute on the network. */
function terminal(error: ApiError): boolean {
  if (error.code === "auth_denied" || error.code === "auth_expired") return true;
  if (error.status === 429) return false;
  return error.status >= 400 && error.status < 500;
}
