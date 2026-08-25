import { useEffect, useRef } from "react";
import { groupedNumber } from "../format.ts";
import {
  ARRIVAL_MS,
  arrivalAlpha,
  breathScale,
  dotAlpha,
  dotAngle,
  dotFraction,
  dotScale,
  dotSize,
  dotWeight,
  haloWeight,
  pulseAlpha,
  RINGS,
  radialProfile,
  seqAngle,
  sliceCount,
} from "../ring.ts";

/** A span that came back: its turn's angular position lights for 1.2s. */
export interface Pulse {
  seq: number;
  at: number;
}

/** A turn that has just been written: its slot lights and spreads to the rim. */
export interface Arrival {
  seq: number;
  at: number;
}

export interface PresenceProps {
  /** Turns in the archive; the ring's angle and density are both this. */
  turns: number;
  state: "idle" | "building" | "streaming";
  /** How full the packet is, 0–1, while it is being built. */
  fill: number;
  pulses: Pulse[];
  /** Turns that have just entered the archive; the newest slot lights as each lands. */
  arrivals: Arrival[];
  /** KERNEL A11.1: turns whose fault nothing answered; one ash dot at the rim each. */
  faults: number[];
  /** When a handoff was appended; the ring flickers once. */
  flickerAt: number | undefined;
}

const FLICKER_MS = 260;
const IDLE_FRAME_MS = 33;

interface Palette {
  dot: string;
  ash: string;
}

/**
 * The archive as a presence. A halftone halo — dots on concentric rings, kiln on
 * bone in light, bone on kiln in dark, on no backing in either; angle is position
 * in the thread. The loop only runs while something is actually moving, and never
 * while the tab is hidden.
 */
export function Presence(props: PresenceProps): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const live = useRef(props);
  live.current = props;
  const wake = useRef<() => void>(() => undefined);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d") ?? null;
    if (canvas === null || context === null) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    let palette = readPalette(canvas, scheme.matches);
    let width = 0;
    let height = 0;
    let fill = 0;
    let timer = 0;
    let frame = 0;

    const resize = (): void => {
      const box = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
      width = Math.max(1, Math.round(box.width));
      height = Math.max(1, Math.round(box.height));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    /** Draws one frame and says whether anything is still moving. */
    const draw = (now: number): { animating: boolean; idleOnly: boolean } => {
      const { turns, state, pulses, arrivals, faults, flickerAt } = live.current;
      const still = motion.matches;
      const target = state === "building" ? Math.min(1, Math.max(0, live.current.fill)) : 0;
      fill = still ? target : fill + (target - fill) * 0.18;
      if (Math.abs(target - fill) < 0.004) fill = target;

      const flickerFor = flickerAt === undefined ? Number.POSITIVE_INFINITY : now - flickerAt;
      const flickering = flickerFor >= 0 && flickerFor < FLICKER_MS;
      const flicker = flickering ? (still ? 0.5 : 0.4 + (0.6 * flickerFor) / FLICKER_MS) : 1;

      context.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const outer = Math.min(width, height) / 2 - 3;
      if (outer <= 0) return { animating: false, idleOnly: false };

      const breathing = state === "idle" && !still;
      const scale = (breathing ? breathScale(now, false) : 1) * (state === "building" ? 0.972 : 1);

      context.fillStyle = palette.dot;
      const plate = dotScale(outer);
      for (let ring = 0; ring < RINGS.length; ring += 1) {
        const fraction = RINGS[ring] ?? 0;
        const slices = sliceCount(fraction);
        const profile = radialProfile(fraction);
        // The packet fills the ring from the inside as it is compiled.
        const poured = Math.min(1, Math.max(0, fill * RINGS.length - ring));
        for (let slice = 0; slice < slices; slice += 1) {
          // An empty thread is still a halo: the floor says the archive exists.
          const weight = haloWeight(dotWeight(slice, slices, turns), profile);
          const angle = dotAngle(ring, slice, slices);
          const radius = outer * dotFraction(ring, slice) * scale;
          context.globalAlpha = Math.min(1, dotAlpha(weight) + 0.35 * poured) * flicker;
          context.beginPath();
          context.arc(
            cx + radius * Math.cos(angle),
            cy + radius * Math.sin(angle),
            dotSize(weight) * plate * (1 + 0.5 * poured),
            0,
            Math.PI * 2,
          );
          context.fill();
        }
      }

      let lit = false;
      // A turn that has just been written lights its own slot and spreads out.
      for (const arrival of arrivals) {
        const elapsed = now - arrival.at;
        if (elapsed < 0 || elapsed >= ARRIVAL_MS) continue;
        lit = true;
        const angle = seqAngle(arrival.seq, Math.max(turns, arrival.seq));
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        for (let ring = 0; ring < RINGS.length; ring += 1) {
          const alpha = arrivalAlpha(elapsed, ring, still);
          if (alpha <= 0) continue;
          const radius = outer * (RINGS[ring] ?? 0) * scale;
          context.globalAlpha = alpha;
          context.beginPath();
          context.arc(cx + radius * cos, cy + radius * sin, (1.7 + 1.5 * alpha) * plate, 0, Math.PI * 2);
          context.fill();
        }
      }

      for (const pulse of pulses) {
        const alpha = pulseAlpha(now - pulse.at, still);
        if (alpha <= 0) continue;
        lit = true;
        const angle = seqAngle(pulse.seq, turns);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        for (const fraction of RINGS) {
          const radius = outer * fraction * scale;
          context.globalAlpha = alpha;
          context.beginPath();
          context.arc(cx + radius * cos, cy + radius * sin, 2.4, 0, Math.PI * 2);
          context.fill();
        }
        // The hairline ray runs from the recovered turn down to the exchange.
        context.globalAlpha = alpha * 0.5;
        context.strokeStyle = palette.dot;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(cx + outer * scale * cos, cy + outer * scale * sin);
        context.lineTo(cx, height);
        context.stroke();
        context.fillStyle = palette.dot;
      }

      if (faults.length > 0) {
        context.fillStyle = palette.ash;
        context.globalAlpha = 0.85 * flicker;
        for (const seq of faults) {
          const angle = seqAngle(seq, turns);
          context.beginPath();
          context.arc(cx + outer * Math.cos(angle), cy + outer * Math.sin(angle), 2.6, 0, Math.PI * 2);
          context.fill();
        }
        context.fillStyle = palette.dot;
      }
      context.globalAlpha = 1;

      const settling = fill !== target;
      const animating = lit || settling || breathing || flickering;
      return { animating, idleOnly: animating && !lit && !settling && !flickering };
    };

    const stop = (): void => {
      if (frame !== 0) cancelAnimationFrame(frame);
      if (timer !== 0) clearTimeout(timer);
      frame = 0;
      timer = 0;
    };

    const tick = (now: number): void => {
      frame = 0;
      const { animating, idleOnly } = draw(now);
      if (!animating || document.hidden) return;
      // Breathing alone does not deserve 60 frames a second.
      if (!idleOnly) {
        frame = requestAnimationFrame(tick);
        return;
      }
      timer = window.setTimeout(() => {
        timer = 0;
        frame = requestAnimationFrame(tick);
      }, IDLE_FRAME_MS);
    };

    const start = (): void => {
      if (frame !== 0 || timer !== 0 || document.hidden) return;
      frame = requestAnimationFrame(tick);
    };
    /** Repaint now rather than on the next frame: resizing a canvas erases it. */
    const paint = (): void => {
      draw(performance.now());
      start();
    };
    wake.current = paint;

    const onScheme = (): void => {
      palette = readPalette(canvas, scheme.matches);
      paint();
    };
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else paint();
    };
    const onResize = (): void => {
      resize();
      paint();
    };

    resize();
    paint();
    const observer = new ResizeObserver(onResize);
    observer.observe(canvas);
    scheme.addEventListener("change", onScheme);
    motion.addEventListener("change", paint);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      wake.current = () => undefined;
      observer.disconnect();
      scheme.removeEventListener("change", onScheme);
      motion.removeEventListener("change", paint);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Every render is a possible state change; repaint once and let the loop settle.
  useEffect(() => {
    wake.current();
  });

  return (
    <canvas
      ref={ref}
      className="presence"
      role="img"
      aria-label={
        props.turns === 0
          ? "An empty archive."
          : `${groupedNumber(props.turns)} turns, the first at the top of the ring.`
      }
    />
  );
}

function readPalette(element: HTMLElement, dark: boolean): Palette {
  const style = getComputedStyle(element);
  const value = (name: string): string => style.getPropertyValue(name).trim();
  return { dot: dark ? value("--ink") : value("--kiln"), ash: value("--ash") };
}
