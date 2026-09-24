/**
 * Shared math helpers. All angles in radians, all track progress in 0..1.
 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Frame-rate independent exponential approach. `rate` = fraction closed per second @ 1x. */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export const TAU = Math.PI * 2;

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed delta from `from` to `to`. */
export function deltaAngle(from, to) {
  return wrapAngle(to - from);
}

/** Wrap track progress into [0,1). */
export function wrapProgress(p) {
  p = p % 1;
  if (p < 0) p += 1;
  return p;
}

/** Signed shortest distance along a closed track, in progress units. */
export function progressDelta(from, to) {
  let d = to - from;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

/** Deterministic 32-bit PRNG so races are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatTime(ms) {
  if (ms == null || !isFinite(ms)) return "--'--\"---";
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${m}'${String(s).padStart(2, '0')}"${String(cs).padStart(2, '0')}`;
}

export function formatGap(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.abs(ms);
  const s = abs / 1000;
  return `${sign}${s.toFixed(2)}s`;
}

export const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];
export const ordinal = (n) => ORDINALS[n - 1] || `${n}th`;
