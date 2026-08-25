/**
 * The presence claims to be the archive: turn 1 at twelve o'clock, the newest
 * turn just before it, and a dot brighter where more turns sit behind it. These
 * are the arithmetic behind that claim, checked without a canvas.
 */
import { describe, expect, test } from "bun:test";
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
  jitter,
  PULSE_MS,
  pulseAlpha,
  RING_COUNT,
  RING_GAP,
  RINGS,
  radialProfile,
  ringPhase,
  seqAngle,
  sliceCount,
  TOP,
  turnsInSlice,
} from "../src/ring.ts";

const TAU = Math.PI * 2;

describe("seqAngle", () => {
  test("turn 1 is at twelve o'clock, whatever the thread's length", () => {
    for (const total of [0, 1, 2, 61_234, 1_000_000]) {
      expect(seqAngle(1, total)).toBe(TOP);
    }
  });

  test("the newest turn stops just before twelve, going clockwise", () => {
    const angle = seqAngle(1_000_000, 1_000_000);
    expect(angle).toBeGreaterThan(TOP);
    expect(angle).toBeLessThan(TOP + TAU);
    expect(TOP + TAU - angle).toBeCloseTo(TAU / 1_000_000, 12);
  });

  test("the middle of the thread is at six o'clock", () => {
    expect(seqAngle(501, 1000)).toBeCloseTo(TOP + Math.PI, 12);
  });

  test("position rises with the turn number", () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (let seq = 1; seq <= 40; seq += 1) {
      const angle = seqAngle(seq, 40);
      expect(angle).toBeGreaterThan(previous);
      previous = angle;
    }
  });

  test("a seq outside the thread is clamped to its ends", () => {
    expect(seqAngle(0, 100)).toBe(seqAngle(1, 100));
    expect(seqAngle(-5, 100)).toBe(seqAngle(1, 100));
    expect(seqAngle(400, 100)).toBe(seqAngle(100, 100));
  });
});

describe("turnsInSlice", () => {
  test("every turn lands in exactly one slice", () => {
    for (const [slices, total] of [
      [60, 0],
      [60, 1],
      [60, 7],
      [60, 60],
      [141, 1_000_000],
      [17, 1000],
    ] as const) {
      let sum = 0;
      for (let index = 0; index < slices; index += 1) sum += turnsInSlice(index, slices, total);
      expect(sum).toBe(total);
    }
  });

  test("the slice a turn lands in is the one its angle points at", () => {
    const slices = 12;
    const total = 1000;
    for (const seq of [1, 2, 83, 84, 500, 999, 1000]) {
      const fraction = (seqAngle(seq, total) - TOP) / TAU;
      const index = Math.floor(fraction * slices);
      expect(turnsInSlice(index, slices, total)).toBeGreaterThan(0);
    }
  });

  test("one turn lights the slice at twelve o'clock and no other", () => {
    expect(turnsInSlice(0, 60, 1)).toBe(1);
    for (let index = 1; index < 60; index += 1) expect(turnsInSlice(index, 60, 1)).toBe(0);
  });

  test("an empty thread and an out-of-range slice hold nothing", () => {
    expect(turnsInSlice(0, 60, 0)).toBe(0);
    expect(turnsInSlice(-1, 60, 100)).toBe(0);
    expect(turnsInSlice(60, 60, 100)).toBe(0);
  });
});

describe("dotWeight", () => {
  test("a slice the thread has not reached is unlit", () => {
    expect(dotWeight(0, 60, 0)).toBe(0);
    expect(dotWeight(30, 60, 3)).toBe(0);
  });

  test("brightness never falls as the archive behind a dot grows", () => {
    let previous = 0;
    for (const total of [1, 12, 60, 600, 6000, 1_000_000]) {
      const weight = dotWeight(0, 60, total);
      expect(weight).toBeGreaterThanOrEqual(previous);
      expect(weight).toBeLessThanOrEqual(1);
      previous = weight;
    }
  });

  test("a dense archive lights the ring evenly", () => {
    for (let index = 0; index < 141; index += 1) expect(dotWeight(index, 141, 1_000_000)).toBe(1);
  });
});

describe("the two animations", () => {
  test("breathing is ±2% of the radius on a 9s period", () => {
    expect(breathScale(0)).toBeCloseTo(1, 12);
    expect(breathScale(2250)).toBeCloseTo(1.02, 12);
    expect(breathScale(6750)).toBeCloseTo(0.98, 12);
    expect(breathScale(9000)).toBeCloseTo(1, 12);
    for (let ms = 0; ms < 9000; ms += 37) {
      expect(Math.abs(breathScale(ms) - 1)).toBeLessThanOrEqual(0.02 + 1e-12);
    }
  });

  test("reduced motion holds the ring still", () => {
    expect(breathScale(2250, true)).toBe(1);
  });

  test("a page lights for 1.2s and then not at all", () => {
    expect(pulseAlpha(0)).toBe(1);
    expect(pulseAlpha(PULSE_MS)).toBe(0);
    expect(pulseAlpha(PULSE_MS + 500)).toBe(0);
    expect(pulseAlpha(-1)).toBe(0);
    expect(pulseAlpha(600)).toBeLessThan(pulseAlpha(300));
  });

  test("reduced motion cuts the pulse instead of fading it", () => {
    expect(pulseAlpha(0, true)).toBe(1);
    expect(pulseAlpha(1199, true)).toBe(1);
    expect(pulseAlpha(PULSE_MS, true)).toBe(0);
  });
});

describe("a turn arriving in the archive", () => {
  const rings = [...Array(RING_COUNT).keys()];

  test("nothing is lit before it lands or after it has settled", () => {
    for (const ring of rings) {
      expect(arrivalAlpha(-1, ring)).toBe(0);
      expect(arrivalAlpha(ARRIVAL_MS, ring)).toBe(0);
      expect(arrivalAlpha(ARRIVAL_MS + 400, ring)).toBe(0);
    }
  });

  test("the light spreads outward: the inner rings answer before the rim", () => {
    expect(arrivalAlpha(60, 0)).toBeGreaterThan(0);
    expect(arrivalAlpha(60, RING_COUNT - 1)).toBe(0);
    let previous = -1;
    for (const ring of rings) {
      // The moment a ring first shows light never falls as you go outward.
      let onset = ARRIVAL_MS;
      for (let ms = 0; ms < ARRIVAL_MS; ms += 1) {
        if (arrivalAlpha(ms, ring) > 0) {
          onset = ms;
          break;
        }
      }
      expect(onset).toBeGreaterThan(previous);
      previous = onset;
    }
  });

  test("every ring flares to full and then decays to nothing", () => {
    for (const ring of rings) {
      const samples = Array.from({ length: ARRIVAL_MS }, (_unused, ms) => arrivalAlpha(ms, ring));
      // Sampled every millisecond, so the exact crest may fall between samples.
      expect(Math.max(...samples)).toBeCloseTo(1, 2);
      for (const value of samples) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      const peak = samples.indexOf(Math.max(...samples));
      for (let ms = peak + 1; ms < ARRIVAL_MS; ms += 1) {
        expect(samples[ms] ?? 1).toBeLessThanOrEqual(samples[ms - 1] ?? 0);
      }
    }
  });

  test("reduced motion cuts the arrival to its final state", () => {
    for (const ring of rings) {
      expect(arrivalAlpha(0, ring, true)).toBe(1);
      expect(arrivalAlpha(ARRIVAL_MS - 1, ring, true)).toBe(1);
      expect(arrivalAlpha(ARRIVAL_MS, ring, true)).toBe(0);
    }
  });

  test("a ring outside the plate is treated as the one at the rim", () => {
    expect(arrivalAlpha(400, RING_COUNT + 6)).toBe(arrivalAlpha(400, RING_COUNT - 1));
    expect(arrivalAlpha(400, -3)).toBe(arrivalAlpha(400, 0));
  });
});

describe("the layout", () => {
  test("the plate is a halftone, not a handful of circles", () => {
    expect(RINGS.length).toBe(RING_COUNT);
    expect(RING_COUNT).toBeGreaterThanOrEqual(14);
    expect(RING_COUNT).toBeLessThanOrEqual(18);
  });

  test("the rings run outward and stay inside the canvas", () => {
    let previous = 0;
    for (const fraction of RINGS) {
      expect(fraction).toBeGreaterThan(previous);
      expect(fraction).toBeLessThanOrEqual(1);
      previous = fraction;
    }
  });

  test("an outer ring carries more dots than an inner one", () => {
    const counts = RINGS.map(sliceCount);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i] ?? 0).toBeGreaterThan(counts[i - 1] ?? 0);
    }
  });

  test("dot spacing is even in both directions", () => {
    // One slice of arc should be about one gap between rings, everywhere.
    for (const fraction of RINGS) {
      const arc = (TAU * fraction) / sliceCount(fraction);
      expect(arc / RING_GAP).toBeGreaterThan(0.9);
      expect(arc / RING_GAP).toBeLessThan(1.1);
    }
  });

  test("a smaller ring draws smaller dots so the lattice does not merge", () => {
    expect(dotScale(168)).toBeCloseTo(1, 12);
    expect(dotScale(60)).toBeLessThan(1);
    expect(dotScale(4)).toBeGreaterThan(0);
    expect(dotScale(4000)).toBeLessThanOrEqual(1.15);
  });
});

describe("the radial profile", () => {
  test("the middle third of the radius is the brightest part of the halo", () => {
    for (const fraction of [1 / 3, 0.4, 0.5, 0.6, 2 / 3]) {
      expect(radialProfile(fraction)).toBeCloseTo(1, 12);
    }
  });

  test("it fades toward the middle and toward the rim", () => {
    expect(radialProfile(0)).toBeLessThan(0.2);
    expect(radialProfile(1)).toBeLessThan(0.2);
    expect(radialProfile(0.16)).toBeLessThan(radialProfile(0.31));
    expect(radialProfile(0.99)).toBeLessThan(radialProfile(0.75));
  });

  test("it rises to the plateau and falls from it, never jumping", () => {
    let previous = radialProfile(0);
    for (let f = 0; f <= 1 / 3; f += 0.01) {
      const value = radialProfile(f);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
    previous = radialProfile(2 / 3);
    for (let f = 2 / 3; f <= 1; f += 0.01) {
      const value = radialProfile(f);
      expect(value).toBeLessThanOrEqual(previous + 1e-12);
      previous = value;
    }
  });

  test("it stays between the floor and full brightness", () => {
    for (let f = -0.5; f <= 1.5; f += 0.017) {
      expect(radialProfile(f)).toBeGreaterThan(0);
      expect(radialProfile(f)).toBeLessThanOrEqual(1);
    }
  });
});

describe("the engraved scatter", () => {
  test("the same dot is nudged the same way every frame", () => {
    for (const [ring, slice, salt] of [
      [0, 0, 0],
      [7, 61, 1],
      [17, 126, 0],
    ] as const) {
      expect(jitter(ring, slice, salt)).toBe(jitter(ring, slice, salt));
    }
    expect(dotAngle(3, 9, 40)).toBe(dotAngle(3, 9, 40));
    expect(dotFraction(3, 9)).toBe(dotFraction(3, 9));
  });

  test("the nudge is bounded, spread and not the same everywhere", () => {
    const values: number[] = [];
    for (let ring = 0; ring < RING_COUNT; ring += 1) {
      for (let slice = 0; slice < sliceCount(RINGS[ring] ?? 0); slice += 1) {
        values.push(jitter(ring, slice, 0));
      }
    }
    expect(values.length).toBeGreaterThan(1000);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(new Set(values).size).toBeGreaterThan(values.length * 0.9);
  });

  test("the angular and radial nudges of one dot are independent", () => {
    expect(jitter(4, 12, 0)).not.toBe(jitter(4, 12, 1));
  });

  test("a dot never leaves its own cell in its ring", () => {
    for (let ring = 0; ring < RING_COUNT; ring += 1) {
      const fraction = RINGS[ring] ?? 0;
      const slices = sliceCount(fraction);
      const step = TAU / slices;
      for (let slice = 0; slice < slices; slice += 1) {
        const lattice = TOP + step * (slice + ringPhase(ring));
        expect(Math.abs(dotAngle(ring, slice, slices) - lattice)).toBeLessThanOrEqual(0.35 * step);
        expect(Math.abs(dotFraction(ring, slice) - fraction)).toBeLessThanOrEqual(0.45 * RING_GAP);
        expect(dotFraction(ring, slice)).toBeLessThan(1);
      }
    }
  });

  test("the rings are rotated against each other by under half a slice", () => {
    const phases = Array.from({ length: RING_COUNT }, (_unused, ring) => ringPhase(ring));
    for (const phase of phases) expect(Math.abs(phase)).toBeLessThanOrEqual(0.5);
    expect(new Set(phases).size).toBe(RING_COUNT);
    // Half a slice of the outermost ring is a rounding error against the thread.
    expect(0.5 / sliceCount(RINGS[RING_COUNT - 1] ?? 1)).toBeLessThan(0.005);
  });
});

describe("the weight of a dot", () => {
  const weightsAt = (turns: number): number[] =>
    RINGS.map((fraction) => haloWeight(dotWeight(0, sliceCount(fraction), turns), radialProfile(fraction)));

  test("an empty thread is a faint halo, even all the way round", () => {
    const first = RINGS.map((fraction) => haloWeight(dotWeight(0, sliceCount(fraction), 0), 1));
    for (const [ring, fraction] of RINGS.entries()) {
      const slices = sliceCount(fraction);
      for (let slice = 0; slice < slices; slice += 1) {
        expect(haloWeight(dotWeight(slice, slices, 0), 1)).toBe(first[ring] ?? -1);
      }
    }
    for (const weight of weightsAt(0)) {
      expect(dotAlpha(weight)).toBeGreaterThanOrEqual(0.35);
      expect(dotAlpha(weight)).toBeLessThan(0.7);
    }
  });

  test("more archive behind a dot makes it brighter and heavier", () => {
    let alpha = 0;
    let size = 0;
    for (const turns of [0, 60, 1200, 1_000_000]) {
      const weight = haloWeight(dotWeight(0, 64, turns), 1);
      expect(dotAlpha(weight)).toBeGreaterThan(alpha);
      expect(dotSize(weight)).toBeGreaterThan(size);
      alpha = dotAlpha(weight);
      size = dotSize(weight);
    }
  });

  test("alpha runs 0.35 to 1 and the dot 0.45px to 1.8px", () => {
    expect(dotAlpha(0)).toBeCloseTo(0.35, 12);
    expect(dotAlpha(1)).toBeCloseTo(1, 12);
    expect(dotSize(0)).toBeCloseTo(0.45, 12);
    expect(dotSize(1)).toBeCloseTo(1.8, 12);
    for (const turns of [0, 1, 900, 1_000_000]) {
      for (const weight of weightsAt(turns)) {
        expect(dotAlpha(weight)).toBeGreaterThanOrEqual(0.35);
        expect(dotAlpha(weight)).toBeLessThanOrEqual(1);
        expect(dotSize(weight)).toBeGreaterThanOrEqual(0.45);
        expect(dotSize(weight)).toBeLessThanOrEqual(1.8);
      }
    }
  });

  test("a million turns light the middle third and still fade at both edges", () => {
    const weights = weightsAt(1_000_000);
    const peak = Math.max(...weights);
    expect(dotSize(peak)).toBeCloseTo(1.8, 6);
    expect(weights[0] ?? 1).toBeLessThan(peak * 0.85);
    expect(weights[weights.length - 1] ?? 1).toBeLessThan(peak * 0.5);
  });
});
