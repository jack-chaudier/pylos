/**
 * One interface over two ways of running the aperture: in a worker (the normal
 * case) or on the main thread (if a module worker cannot be created). The view
 * does not care which; it receives states and paints them.
 */

import { ENGINE, ENGINE_LABEL } from "./kernel";
import { ApertureRun, type RunState } from "./run";
import type { FromWorker, ToWorker } from "./worker";

export interface DriverInfo {
  engine: "core" | "sim";
  label: string;
  total: number;
  budget: number;
}

export interface Driver {
  readonly info: DriverInfo;
  readonly inWorker: boolean;
  onState(cb: (state: RunState, elapsedMs: number, done: boolean) => void): void;
  run(durationMs: number): void;
  end(): void;
  stop(): void;
  initial(): RunState;
}

export function createDriver(): Driver {
  try {
    return workerDriver();
  } catch {
    return mainThreadDriver();
  }
}

// ── worker ──────────────────────────────────────────────────────────────────

function workerDriver(): Driver {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "pylos-aperture",
  });

  const local = new ApertureRun();
  const info: DriverInfo = {
    engine: ENGINE,
    label: ENGINE_LABEL,
    total: local.total,
    budget: local.budget,
  };
  const zero = local.state();
  let listener: ((s: RunState, ms: number, done: boolean) => void) | null = null;

  worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    if (msg.type === "state") listener?.(msg.state, msg.elapsedMs, false);
    else if (msg.type === "done") listener?.(msg.state, msg.elapsedMs, true);
    else if (msg.type === "error") console.error("[pylos] aperture worker:", msg.message);
  });

  const send = (msg: ToWorker) => worker.postMessage(msg);

  return {
    info,
    inWorker: true,
    onState(cb) {
      listener = cb;
    },
    run(durationMs) {
      send({ type: "run", durationMs });
    },
    end() {
      send({ type: "end" });
    },
    stop() {
      send({ type: "stop" });
    },
    initial: () => zero,
  };
}

// ── main thread ─────────────────────────────────────────────────────────────

function mainThreadDriver(): Driver {
  const run = new ApertureRun();
  const info: DriverInfo = {
    engine: ENGINE,
    label: ENGINE_LABEL,
    total: run.total,
    budget: run.budget,
  };
  const zero = run.state();
  let listener: ((s: RunState, ms: number, done: boolean) => void) | null = null;
  let raf = 0;
  let started = 0;

  const frame = () => {
    const elapsed = performance.now() - started;
    const p = Math.min(1, elapsed / DURATION_FALLBACK);
    run.advanceTo(Math.max(Math.round(smoothstep(p) * run.total), run.turn + 1), 11);
    const state = run.state();
    listener?.(state, elapsed, state.done);
    if (!state.done) raf = requestAnimationFrame(frame);
  };

  return {
    info,
    inWorker: false,
    onState(cb) {
      listener = cb;
    },
    run(durationMs) {
      cancelAnimationFrame(raf);
      run.reset();
      DURATION_FALLBACK = durationMs;
      started = performance.now();
      raf = requestAnimationFrame(frame);
    },
    end() {
      cancelAnimationFrame(raf);
      run.reset();
      const t = performance.now();
      const state = run.runToEnd();
      listener?.(state, performance.now() - t, true);
    },
    stop() {
      cancelAnimationFrame(raf);
    },
    initial: () => zero,
  };
}

let DURATION_FALLBACK = 10_000;

function smoothstep(p: number): number {
  return p * p * (3 - 2 * p);
}
