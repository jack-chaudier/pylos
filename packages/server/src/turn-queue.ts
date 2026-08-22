/**
 * Per-thread turn serialization.
 *
 * A turn commits in two transactions with a provider call between them, so two
 * turns on one thread — two tabs, or a client and the gateway — could interleave
 * and commit `user A, user B, assistant B, assistant A`: an order that never
 * happened. Turns on one thread therefore run strictly one after another;
 * different threads are untouched.
 *
 * Refusing the second turn would lose what the user typed, so it waits — at most
 * `MAX_PENDING` deep, and only while its request is alive. A waiter that is
 * abandoned lets go of the queue immediately, so a hosted lease is never held by
 * a client that has gone.
 */
import { HttpError } from "./http.ts";

/** Turns allowed to wait behind the one in flight, per thread. */
export const MAX_PENDING = 8;

interface Lane {
  /** Resolves when every turn admitted to this lane so far has finished. */
  tail: Promise<void>;
  /** Turns admitted and not yet released, including the one running. */
  depth: number;
}

export interface Ticket {
  /** Resolves when the turns ahead have finished, or when `signal` aborts. */
  ready(signal?: AbortSignal): Promise<void>;
  release(): void;
}

export class TurnQueue {
  private readonly lanes = new Map<string, Lane>();

  /**
   * Claims this thread's next slot synchronously, so a full queue is a `429`
   * before a response has begun rather than an error inside a live stream. The
   * ticket must be released — the caller owns it from here.
   */
  enter(threadId: string): Ticket {
    const lane = this.lanes.get(threadId) ?? { tail: Promise.resolve(), depth: 0 };
    if (lane.depth > MAX_PENDING) {
      throw new HttpError(429, "thread_busy", "This thread already has turns waiting. Try again shortly.");
    }
    lane.depth += 1;
    this.lanes.set(threadId, lane);

    const ahead = lane.tail;
    let finish = (): void => {};
    const mine = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // The next turn waits for us *and* for everything ahead of us: releasing
    // early must not let a queued turn overtake the one still running.
    lane.tail = ahead.then(() => mine);

    let released = false;
    return {
      ready: (signal) => untilSettled(ahead, signal),
      release: (): void => {
        if (released) return;
        released = true;
        finish();
        lane.depth -= 1;
        if (lane.depth === 0 && this.lanes.get(threadId) === lane) this.lanes.delete(threadId);
      },
    };
  }
}

/** `ahead` never rejects; an abort is the only other way out of the wait. */
function untilSettled(ahead: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return ahead;
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    void ahead.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
