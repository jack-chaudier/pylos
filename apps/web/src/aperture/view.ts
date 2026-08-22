/**
 * The aperture — the one place on this page where Pylos is not described but
 * run.
 *
 * A synthetic thread of a million turns is streamed through the compiler in
 * this tab: episodes are appended, capsules seal every 32 turns and roll up
 * every 8 capsules, each seal writes its losses into the ledger, and the packet
 * is recompiled as it goes. The archive counter runs away; the view counter
 * does not. At the end the question from turn 1,000,000 routes through the
 * ledger and the exact span from turn 483,112 comes back.
 *
 * Deterministic, replayable, and nothing here is a video.
 */

import { createDriver, type Driver } from "./driver";
import type { RunState, StripEntry } from "./run";

const DURATION_MS = 10_000;
const SLOW_UPDATE_MS = 110;
const CANVAS_UPDATE_MS = 60;
const MAX_CHIPS = 16;
const CHIPS_PER_TICK = 3;
const REVISION_SEQ = 483_112;

const SLOTS = ["header", "frontier", "capsules", "paged", "recent"] as const;

const nf = new Intl.NumberFormat("en-US");

export function mountAperture(): void {
  const section = document.querySelector<HTMLElement>("#aperture");
  if (!section) return;

  const els = {
    archive: must(section, "[data-ap-archive]"),
    archiveSub: must(section, "[data-ap-archive-sub]"),
    rate: must(section, "[data-ap-rate]"),
    view: must(section, "[data-ap-view]"),
    budget: must(section, "[data-ap-budget]"),
    ledgerCount: must(section, "[data-ap-ledger-count]"),
    strip: must(section, "[data-ap-strip]"),
    canvas: must<HTMLCanvasElement>(section, "[data-ap-canvas]"),
    recovery: must(section, "[data-ap-recovery]"),
    recovLine: must(section, "[data-ap-recovered-line]"),
    recovQuote: must(section, "[data-ap-recovered-quote]"),
    recovMeta: must(section, "[data-ap-recovered-meta]"),
    status: must(section, "[data-ap-status]"),
    replay: must<HTMLButtonElement>(section, "[data-ap-replay]"),
    engine: must(section, "[data-ap-engine]"),
    levels: must(section, "[data-ap-levels]"),
    live: must(section, "[data-ap-live]"),
  };

  const meter: Record<string, HTMLElement> = {};
  for (const s of SLOTS) {
    const el = section.querySelector<HTMLElement>(`.meter__slot[data-slot="${s}"]`);
    if (el) meter[s] = el;
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let driver: Driver;
  try {
    driver = createDriver();
  } catch (err) {
    console.error("[pylos] aperture could not start", err);
    return;
  }

  els.engine.textContent = `engine · ${driver.info.label}`;
  els.budget.textContent = `budget ${nf.format(driver.info.budget)}`;

  let lastChipId = -1;
  let lastSlow = 0;
  let lastCanvas = 0;
  let playing = false;
  let hasRun = false;
  let latest = driver.initial();

  paint(latest, 0);
  fitCanvas(els.canvas);
  drawTimeline(els.canvas, latest);

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      fitCanvas(els.canvas);
      drawTimeline(els.canvas, latest);
    }, 140);
  });

  // ── painting ──────────────────────────────────────────────────────────────

  function paint(state: RunState, rate: number): void {
    els.archive.textContent = nf.format(state.turn);
    els.archiveSub.textContent = `${nf.format(state.capsules)} capsules · ≈${bytes(state.archiveBytes)} of archive text · ${Math.max(state.levelCounts.length, 1)} levels`;
    els.rate.textContent = rate > 0 ? `${nf.format(Math.round(rate))} turns/s` : " ";

    const p = state.packet;
    els.view.textContent = "";
    els.view.append(
      document.createTextNode(nf.format(p.tokens)),
      span("counter__of", ` / ${nf.format(p.budget)}`),
    );
    for (const s of SLOTS) {
      const el = meter[s];
      if (el) el.style.width = `${((p.slots[s] / p.budget) * 100).toFixed(3)}%`;
    }
    els.ledgerCount.textContent = `Ledger · ${nf.format(state.lossRows)} entries · 0 removed (conserved)`;

    const counts = state.levelCounts;
    els.levels.textContent =
      counts.length === 0
        ? "Compaction hierarchy · level 4 → level 0 · the ember mark is turn 483,112"
        : `Capsules · ${counts
            .map((n, i) => `L${i} ${nf.format(n)}`)
            .reverse()
            .join(" · ")} · the ember mark is turn 483,112`;
  }

  function pushChips(strip: readonly StripEntry[], limit: number): void {
    const fresh: StripEntry[] = [];
    for (let i = strip.length - 1; i >= 0; i--) {
      const e = strip[i];
      if (e && e.id > lastChipId) fresh.push(e);
    }
    if (fresh.length === 0) return;
    lastChipId = fresh[fresh.length - 1]?.id ?? lastChipId;
    for (const e of fresh.slice(-limit)) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.dataset.kind = e.kind;
      chip.textContent = e.name.length > 24 ? `${e.name.slice(0, 23)}…` : e.name;
      els.strip.append(chip);
    }
    while (els.strip.childElementCount > MAX_CHIPS) els.strip.firstElementChild?.remove();
  }

  function reveal(state: RunState): void {
    const r = state.recovered;
    if (!r) return;
    els.recovLine.textContent = `↺ recovered turn ${nf.format(r.seq)}`;
    els.recovQuote.textContent = "";
    for (const part of split(r.text, r.quote)) {
      if (part.hit) {
        const mark = document.createElement("mark");
        mark.textContent = part.text;
        els.recovQuote.append(mark);
      } else {
        els.recovQuote.append(document.createTextNode(part.text));
      }
    }
    els.recovMeta.textContent = `trigger ${r.trigger} · exact span · paged before the model answered · ${nf.format(state.lossRows)} ledger entries recorded, none removed`;
    els.recovery.dataset.on = "true";
  }

  // ── driving ───────────────────────────────────────────────────────────────

  driver.onState((state, elapsed, done) => {
    latest = state;
    const rate = elapsed > 250 ? (state.turn / elapsed) * 1000 : 0;

    els.archive.textContent = nf.format(state.turn);
    els.rate.textContent = rate > 0 ? `${nf.format(Math.round(rate))} turns/s` : " ";
    els.ledgerCount.textContent = `Ledger · ${nf.format(state.lossRows)} entries · 0 removed (conserved)`;
    pushChips(state.strip, done ? MAX_CHIPS : CHIPS_PER_TICK);

    const now = performance.now();
    if (done || now - lastSlow > SLOW_UPDATE_MS) {
      lastSlow = now;
      paint(state, rate);
    }
    if (done || now - lastCanvas > CANVAS_UPDATE_MS) {
      lastCanvas = now;
      drawTimeline(els.canvas, state);
    }
    if (done) finish(state, elapsed);
  });

  function finish(state: RunState, elapsed: number): void {
    playing = false;
    reveal(state);
    els.replay.disabled = false;
    els.replay.textContent = "Replay";
    els.status.textContent = `Measured in this browser · ${nf.format(state.turn)} turns in ${(elapsed / 1000).toFixed(1)}s · packet ${nf.format(state.packet.tokens)}/${nf.format(state.packet.budget)} · ledger ${nf.format(state.lossRows)} · seed 0x50594C4F`;
    els.live.textContent = `The run finished: ${nf.format(state.turn)} turns archived, the model's view held at ${nf.format(state.packet.tokens)} of ${nf.format(state.packet.budget)} tokens, and turn ${nf.format(state.recovered?.seq ?? 0)} was recovered from the loss ledger before answering.`;
  }

  function clear(): void {
    lastChipId = -1;
    lastSlow = 0;
    lastCanvas = 0;
    els.strip.replaceChildren();
    els.recovery.dataset.on = "false";
  }

  function play(): void {
    if (playing) return;
    hasRun = true;
    clear();
    if (reduced.matches) {
      els.status.textContent = "Motion reduced · showing the finished run";
      showEndState();
      return;
    }
    playing = true;
    els.replay.disabled = true;
    els.replay.textContent = "Running";
    els.status.textContent = "Streaming · 32-episode capsules, fan-out 8 · seed 0x50594C4F";
    els.live.textContent = "Streaming one million turns through the compiler.";
    driver.run(DURATION_MS);
  }

  /** Reduced motion: the finished run, computed at build time from the same seed. */
  function showEndState(): void {
    void loadSnapshot().then((snap) => {
      if (snap) {
        latest = snap;
        paint(snap, 0);
        drawTimeline(els.canvas, snap);
        pushChips(snap.strip, MAX_CHIPS);
        reveal(snap);
        els.status.textContent = `Finished run, precomputed from the same seed · ${nf.format(snap.turn)} turns · packet ${nf.format(snap.packet.tokens)}/${nf.format(snap.packet.budget)} · ledger ${nf.format(snap.lossRows)} · seed 0x50594C4F`;
      } else {
        driver.end();
      }
    });
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  els.replay.addEventListener("click", play);

  for (const btn of document.querySelectorAll<HTMLElement>("[data-play-aperture]")) {
    btn.addEventListener("click", () => {
      section.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
      section.focus({ preventScroll: true });
      window.setTimeout(play, reduced.matches ? 0 : 400);
    });
  }

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !hasRun) {
            io.disconnect();
            play();
          }
        }
      },
      { threshold: 0.4 },
    );
    io.observe(section);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && playing) {
      driver.stop();
      playing = false;
      els.replay.disabled = false;
      els.replay.textContent = "Replay";
      els.status.textContent = "Paused · the tab went to the background. Replay to run it again.";
    }
  });
}

// ── snapshot ────────────────────────────────────────────────────────────────

async function loadSnapshot(): Promise<RunState | null> {
  try {
    const res = await fetch("/aperture/final.json", { cache: "force-cache" });
    if (!res.ok) return null;
    return (await res.json()) as RunState;
  } catch {
    return null;
  }
}

// ── timeline ────────────────────────────────────────────────────────────────

/**
 * The compaction hierarchy, drawn small: one lane per level over the whole
 * archive. Coarse levels show individual capsule boundaries; fine levels
 * collapse into a solid rule, which is what "denser marks = more compacted"
 * looks like from a million turns away.
 */
function drawTimeline(canvas: HTMLCanvasElement, state: RunState): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(canvas);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const ash = read("--ash", "#7C786E");
  const verdigris = read("--verdigris", "#1F6F5C");
  const ember = read("--ember", "#C98A2E");
  const hairline = read("--hairline", "rgba(23,22,15,0.12)");

  const levels = Math.max(state.levelCounts.length, 5);
  const lane = h / levels;
  const progress = state.total > 0 ? state.turn / state.total : 0;

  for (let lvl = levels - 1; lvl >= 0; lvl--) {
    const y = Math.round((levels - 1 - lvl) * lane + lane / 2) + 0.5;
    const count = state.levelCounts[lvl] ?? 0;

    ctx.strokeStyle = hairline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    if (count === 0) continue;

    const filled = w * progress;
    const spacing = filled / count;
    ctx.strokeStyle = lvl >= 2 ? verdigris : ash;
    ctx.globalAlpha = lvl >= 2 ? 0.8 : 0.45;

    if (spacing < 1.4) {
      ctx.lineWidth = lvl === 0 ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(filled, y);
      ctx.stroke();
    } else {
      ctx.lineWidth = 1;
      const tick = Math.min(lane * 0.4, 7);
      ctx.beginPath();
      for (let i = 1; i <= count; i++) {
        const x = Math.round(i * spacing) + 0.5;
        ctx.moveTo(x, y - tick);
        ctx.lineTo(x, y + tick);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  if (state.turn >= REVISION_SEQ) {
    const x = Math.round(w * (REVISION_SEQ / state.total)) + 0.5;
    ctx.strokeStyle = ember;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 1);
    ctx.lineTo(x, h - 1);
    ctx.stroke();
  }

  ctx.fillStyle = verdigris;
  ctx.fillRect(Math.max(0, w * progress - 1.5), 0, 2, h);
}

function fitCanvas(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(46 * dpr));
}

// ── helpers ─────────────────────────────────────────────────────────────────

function must<T extends HTMLElement>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`aperture: missing ${sel}`);
  return el;
}

function span(cls: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

function bytes(n: number): string {
  if (n < 1e6) return `${(n / 1e3).toFixed(0)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

function split(text: string, needle: string): { text: string; hit: boolean }[] {
  if (!needle) return [{ text, hit: false }];
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i === -1) return [{ text, hit: false }];
  return [
    { text: text.slice(0, i), hit: false },
    { text: text.slice(i, i + needle.length), hit: true },
    { text: text.slice(i + needle.length), hit: false },
  ].filter((p) => p.text.length > 0);
}
