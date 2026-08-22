/**
 * The aperture's engine, off the main thread.
 *
 * Compiling a million turns is real work — the tokenizer, `names()`, the
 * extractive writer and the ledger algebra all run for every episode. Doing it
 * here means the page keeps painting at sixty frames a second while it happens,
 * and the numbers on screen are measurements rather than an easing curve.
 */

import { ENGINE, ENGINE_LABEL } from "./kernel";
import { ApertureRun, type RunState } from "./run";

export type ToWorker =
  | { type: "hello" }
  | { type: "run"; durationMs: number }
  | { type: "end" }
  | { type: "stop" };

export type FromWorker =
  | { type: "hello"; engine: "core" | "sim"; label: string; total: number; budget: number }
  | { type: "state"; state: RunState; elapsedMs: number }
  | { type: "done"; state: RunState; elapsedMs: number }
  | { type: "error"; message: string };

const POST_EVERY_MS = 28;

let run: ApertureRun | null = null;
let token = 0;

/** A yield with no timer clamp, so the loop keeps ~95% duty cycle. */
const channel = new MessageChannel();
let pending: (() => void) | null = null;
channel.port1.onmessage = () => {
  const fn = pending;
  pending = null;
  fn?.();
};
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    pending = resolve;
    channel.port2.postMessage(0);
  });
}

function ensure(): ApertureRun {
  if (!run) run = new ApertureRun();
  return run;
}

function post(msg: FromWorker): void {
  (self as unknown as Worker).postMessage(msg);
}

async function drive(durationMs: number, mine: number): Promise<void> {
  const r = ensure();
  r.reset();
  const started = performance.now();
  let lastPost = 0;

  while (token === mine && !r.finished) {
    const elapsed = performance.now() - started;
    const p = Math.min(1, elapsed / durationMs);
    const target = Math.round(smoothstep(p) * r.total);
    // If the machine cannot keep the pace, run flat out rather than stalling:
    // the counter slows down, the claim does not change.
    r.advanceTo(Math.max(target, r.turn + 1), 24);

    const now = performance.now();
    if (now - lastPost >= POST_EVERY_MS) {
      lastPost = now;
      post({ type: "state", state: r.state(), elapsedMs: now - started });
    }
    await yieldToLoop();
  }

  if (token !== mine) return;
  post({ type: "done", state: r.state(), elapsedMs: performance.now() - started });
}

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "hello": {
        const r = ensure();
        post({ type: "hello", engine: ENGINE, label: ENGINE_LABEL, total: r.total, budget: r.budget });
        post({ type: "state", state: r.state(), elapsedMs: 0 });
        break;
      }
      case "run": {
        token += 1;
        void drive(msg.durationMs, token);
        break;
      }
      case "end": {
        token += 1;
        const r = ensure();
        r.reset();
        const started = performance.now();
        const state = r.runToEnd();
        post({ type: "done", state, elapsedMs: performance.now() - started });
        break;
      }
      case "stop": {
        token += 1;
        break;
      }
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
});

function smoothstep(p: number): number {
  return p * p * (3 - 2 * p);
}
