/**
 * The presence, as numbers. The plate is a halftone halo: concentric rings of
 * dots, angle is position in the thread, weight is how much archive sits behind
 * a dot and how far out on the halo it lies. All of it is pure so the drawing
 * can be checked without a canvas.
 */

const TAU = Math.PI * 2;

/** Twelve o'clock in canvas radians: 0 is three o'clock and angles run clockwise. */
export const TOP = -Math.PI / 2;

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/** Rings of the halo, from the hole in the middle out to the rim. */
export const RING_COUNT = 18;
const INNERMOST = 0.11;
const OUTERMOST = 0.97;

/** The radial step between rings, as a fraction of the outer radius. */
export const RING_GAP = (OUTERMOST - INNERMOST) / (RING_COUNT - 1);

/** The concentric rings, as fractions of the outer radius. */
export const RINGS: readonly number[] = Array.from(
  { length: RING_COUNT },
  (_unused, ring) => INNERMOST + ring * RING_GAP,
);

/** Dots on a ring: one per `RING_GAP` of arc, so the spacing is even in both directions. */
export function sliceCount(fraction: number): number {
  return Math.max(8, Math.round((fraction * TAU) / RING_GAP));
}

/** Turn 1 sits at twelve o'clock; the newest turn stops just short of it, clockwise. */
export function seqAngle(seq: number, total: number): number {
  if (total <= 1) return TOP;
  const clamped = Math.min(Math.max(seq, 1), total);
  return TOP + (TAU * (clamped - 1)) / total;
}

/**
 * How many of a `total`-turn thread's turns fall in slice `index` of `slices`.
 * A turn belongs to the slice its `seqAngle` lands in, so the counts sum to
 * `total` exactly however the two numbers divide.
 */
export function turnsInSlice(index: number, slices: number, total: number): number {
  if (total <= 0 || slices <= 0 || index < 0 || index >= slices) return 0;
  const from = Math.ceil((index * total) / slices);
  const to = Math.ceil(((index + 1) * total) / slices);
  return Math.max(0, to - from);
}

/** Turns behind one dot at which it is fully lit; beyond this the ring is even. */
const SATURATION = 64;

/** 0 for a slice the thread has not reached, rising with the turns behind it. */
export function dotWeight(index: number, slices: number, total: number): number {
  const count = turnsInSlice(index, slices, total);
  if (count === 0) return 0;
  return 0.34 + 0.66 * Math.min(1, Math.log1p(count) / Math.log1p(SATURATION));
}

/** What a dot at the dimmest reach of the halo still shows. */
const PROFILE_FLOOR = 0.1;

/**
 * The halo across the radius: full through the middle third, easing to a floor
 * at the hole in the middle and again at the rim. This, not the ring index, is
 * what makes the plate a halo rather than a target.
 */
export function radialProfile(fraction: number): number {
  const f = clamp01(fraction);
  const shoulder = f < 1 / 3 ? f * 3 : f > 2 / 3 ? (1 - f) * 3 : 1;
  const eased = (1 - Math.cos(Math.PI * clamp01(shoulder))) / 2;
  return PROFILE_FLOOR + (1 - PROFILE_FLOOR) * eased;
}

/**
 * A fixed −1…1 for a dot, from its ring and slice. The plate must be engraved
 * once and redrawn identically every frame, so the scatter is a hash, not a
 * random number. `salt` separates the angular nudge from the radial one.
 */
export function jitter(ring: number, slice: number, salt: number): number {
  let h =
    Math.imul(ring + 1, 0x27d4eb2d) ^ Math.imul(slice + 1, 0x165667b1) ^ Math.imul(salt + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x80000000 - 1;
}

/**
 * How far a dot may sit from its place in the lattice, as a fraction of the cell.
 * Sideways a nudge is enough; outward it has to be most of the gap, or eighteen
 * rings read as eighteen circles instead of one field of tone.
 */
const ANGLE_JITTER = 0.35;
const RADIUS_JITTER = 0.45;

/**
 * A ring's own rotation, up to half a slice. Without it every ring has a dot at
 * twelve o'clock and the eye reads spokes and spirals out of the near-alignment.
 */
export function ringPhase(ring: number): number {
  return 0.5 * jitter(ring, 0, 2);
}

/** Where a dot sits on its ring: its slice, nudged by up to 35% of the slice angle. */
export function dotAngle(ring: number, slice: number, slices: number): number {
  const step = TAU / slices;
  return TOP + step * (slice + ringPhase(ring) + ANGLE_JITTER * jitter(ring, slice, 0));
}

/** How far out a dot sits: anywhere in its own band, never in the next ring's. */
export function dotFraction(ring: number, slice: number): number {
  return (RINGS[ring] ?? 0) + RING_GAP * RADIUS_JITTER * jitter(ring, slice, 1);
}

/** What a dot shows with no archive behind it at all — the halo is there first. */
const DENSITY_FLOOR = 0.4;

/** One number for a dot: how dense the thread is there, shaped by where on the halo it lies. */
export function haloWeight(density: number, profile: number): number {
  return clamp01(profile) * (DENSITY_FLOOR + (1 - DENSITY_FLOOR) * clamp01(density));
}

const ALPHA_MIN = 0.35;
const ALPHA_MAX = 1;
const SIZE_MIN = 0.45;
const SIZE_MAX = 1.8;

export function dotAlpha(weight: number): number {
  return ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * clamp01(weight);
}

/** Dot radius in CSS pixels, before the plate is scaled to the ring it is drawn on. */
export function dotSize(weight: number): number {
  return SIZE_MIN + (SIZE_MAX - SIZE_MIN) * clamp01(weight);
}

/** The outer radius the dot sizes are drawn for: 38vmin of a 900px-tall window. */
const REFERENCE_RADIUS = 168;

/** A smaller ring holds the same lattice, so its dots shrink with it or they merge. */
export function dotScale(outer: number): number {
  return Math.min(Math.max(outer / REFERENCE_RADIUS, 0.5), 1.15);
}

const BREATH_PERIOD = 9000;
const BREATH_DEPTH = 0.02;

/** ±2% of the radius over 9s; the sine is the ease. Reduced motion holds still. */
export function breathScale(ms: number, reduced = false): number {
  if (reduced) return 1;
  return 1 + BREATH_DEPTH * Math.sin((TAU * ms) / BREATH_PERIOD);
}

/** How long a turn entering the archive takes to spread across the rings and settle. */
export const ARRIVAL_MS = 900;

/** The share of that window the light spends travelling from the hole to the rim. */
const TRAVEL = 0.55;

/** How long one ring takes to reach full light once the wave has reached it. */
const ATTACK_MS = 90;

/**
 * A turn arriving in the archive, ring by ring: the light appears at its
 * angular position in the middle of the halo and spreads outward, each ring
 * flaring as the wave reaches it and settling back into the plate by
 * `ARRIVAL_MS`. Reduced motion holds every ring at full and then cuts, so the
 * arrival is stated without anything moving.
 */
export function arrivalAlpha(elapsed: number, ring: number, reduced = false): number {
  if (elapsed < 0 || elapsed >= ARRIVAL_MS) return 0;
  if (reduced) return 1;
  const last = Math.max(1, RING_COUNT - 1);
  const reach = (Math.min(Math.max(ring, 0), last) / last) * TRAVEL * ARRIVAL_MS;
  const since = elapsed - reach;
  if (since < 0) return 0;
  if (since < ATTACK_MS) return since / ATTACK_MS;
  const settle = ARRIVAL_MS - reach - ATTACK_MS;
  const remaining = 1 - (since - ATTACK_MS) / settle;
  return remaining * remaining;
}

/** How long a served page lights its angular position. */
export const PULSE_MS = 1200;

/** The decay of that light; reduced motion cuts to full and back instead of fading. */
export function pulseAlpha(elapsed: number, reduced = false): number {
  if (elapsed < 0 || elapsed >= PULSE_MS) return 0;
  if (reduced) return 1;
  const remaining = 1 - elapsed / PULSE_MS;
  return remaining * remaining;
}
