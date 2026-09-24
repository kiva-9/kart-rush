/**
 * Kart Rush audio. Every sound in the game is synthesised at runtime with
 * WebAudio - there are no sample files, no fetches and no network access.
 *
 * Three layers live here:
 *   - a continuous kart engine (two detuned saws + a sub through a gear-driven
 *     lowpass, filtered noise load, a band-passed tyre-screech channel and a
 *     crossfaded boost layer);
 *   - one-shot SFX built from envelope-shaped oscillators and noise bursts;
 *   - music, delegated to the step sequencer in `data/music.js`.
 *
 * The AudioContext is created lazily on the first user gesture (`unlock()`).
 * Until then, and if WebAudio is missing entirely, every public method is a
 * safe no-op - nothing here may throw during boot.
 */
import { clamp, damp, lerp } from './MathUtils.js';
import { MusicSequencer, getMusicTrack } from '../data/music.js';

/** Hard cap on simultaneously live one-shot voices; extras get stolen. */
const MAX_VOICES = 18;
/** Engine gear split points, as a fraction of the kart's top speed. */
const GEAR_LO = [0.0, 0.12, 0.24, 0.38, 0.54, 0.72];
const GEAR_HI = [0.12, 0.24, 0.38, 0.54, 0.72, 1.0];
const GEAR_MUL = [1.0, 0.93, 0.87, 0.81, 0.75, 0.69];
const DEFAULT_BASE_FREQ = 68;

/* ---------------------------------------------------------------------- -- */
/* SFX library. Each entry is a list of tiny envelope events. `f0`/`f1` sweep  */
/* between two frequencies, `t` delays an event so one sound can arpeggiate,  */
/* and `f0`/`f1` may be functions of the call opts for per-hit tuning.         */
/* ---------------------------------------------------------------------- -- */

const S = {
  countdown: [
    { type: 'osc', wave: 'square', f0: 740, f1: 780, dur: 0.17, gain: 0.5, attack: 0.004, filter: { type: 'lowpass', f0: 2800, f1: 2600, q: 0.8 } },
    { type: 'osc', wave: 'sine', f0: 1480, f1: 1560, dur: 0.13, gain: 0.16, attack: 0.003 },
    { type: 'noise', dur: 0.045, gain: 0.14, filter: { type: 'bandpass', f0: 3200, f1: 3200, q: 1.4 } },
  ],
  countdownGo: [
    { type: 'osc', wave: 'square', f0: 1174, f1: 1200, dur: 0.4, gain: 0.5, attack: 0.004, filter: { type: 'lowpass', f0: 4200, f1: 4200, q: 0.7 } },
    { type: 'osc', wave: 'square', f0: 1568, f1: 1600, dur: 0.36, gain: 0.3, attack: 0.005, filter: { type: 'lowpass', f0: 4200, f1: 4200, q: 0.7 } },
    { type: 'osc', wave: 'triangle', f0: 587, f1: 600, dur: 0.3, gain: 0.2, attack: 0.006 },
    { type: 'noise', dur: 0.3, gain: 0.16, filter: { type: 'bandpass', f0: 500, f1: 3600, q: 0.9 } },
  ],
  start: [
    { type: 'osc', wave: 'sawtooth', f0: 90, f1: 430, dur: 0.55, gain: 0.5, attack: 0.01, filter: { type: 'lowpass', f0: 420, f1: 3800, q: 3.5 } },
    { type: 'osc', wave: 'square', f0: 180, f1: 860, dur: 0.5, gain: 0.18, attack: 0.012, filter: { type: 'lowpass', f0: 700, f1: 3200, q: 2 } },
    { type: 'noise', dur: 0.55, gain: 0.24, filter: { type: 'bandpass', f0: 320, f1: 3200, q: 1.1 } },
    { type: 'noise', dur: 0.03, gain: 0.3, filter: { type: 'highpass', f0: 5000, f1: 5000, q: 0.7 } },
  ],
  boost: [
    { type: 'osc', wave: 'sawtooth', f0: 210, f1: 900, dur: 0.5, gain: 0.42, attack: 0.006, filter: { type: 'lowpass', f0: 500, f1: 5200, q: 4 } },
    { type: 'osc', wave: 'square', f0: 420, f1: 1800, dur: 0.34, gain: 0.16, attack: 0.004 },
    { type: 'noise', dur: 0.45, gain: 0.24, filter: { type: 'bandpass', f0: 700, f1: 4200, q: 0.8 } },
    { type: 'osc', wave: 'sine', f0: 70, f1: 190, dur: 0.45, gain: 0.3, attack: 0.008 },
  ],
  miniTurbo: [
    { type: 'osc', wave: 'square', f0: (o) => 820 + (o.tier || 0) * 260, f1: (o) => 1750 + (o.tier || 0) * 420, dur: 0.19, gain: 0.4, attack: 0.003, filter: { type: 'lowpass', f0: 5200, f1: 5200, q: 0.7 } },
    { type: 'osc', wave: 'triangle', f0: (o) => 1640 + (o.tier || 0) * 520, f1: (o) => 3400 + (o.tier || 0) * 800, dur: 0.15, gain: 0.16, attack: 0.002 },
    { type: 'noise', dur: 0.16, gain: 0.2, filter: { type: 'bandpass', f0: 1800, f1: 5200, q: 1.2 } },
  ],
  mushroom: [
    { type: 'osc', wave: 'triangle', f0: 360, f1: 1500, dur: 0.26, gain: 0.42, attack: 0.004 },
    { type: 'osc', wave: 'square', f0: 740, f1: 2900, dur: 0.18, gain: 0.14, attack: 0.003, filter: { type: 'lowpass', f0: 5000, f1: 5000, q: 0.7 } },
    { type: 'noise', dur: 0.06, gain: 0.12, filter: { type: 'highpass', f0: 3000, f1: 3000, q: 0.7 } },
  ],
  driftSpark: [
    { type: 'noise', dur: 0.075, gain: 0.3, filter: { type: 'bandpass', f0: (o) => 2400 + (o.tier || 0) * 700, f1: (o) => 5200 + (o.tier || 0) * 900, q: 3.5 } },
    { type: 'osc', wave: 'square', f0: (o) => 2600 + (o.tier || 0) * 500, f1: (o) => 4200 + (o.tier || 0) * 800, dur: 0.05, gain: 0.08, attack: 0.002 },
  ],
  driftCharge: [
    { type: 'osc', wave: 'triangle', f0: (o) => 210 + (o.tier || 0) * 130, f1: (o) => 660 + (o.tier || 0) * 330, dur: 0.34, gain: 0.34, attack: 0.03, vibrato: { rate: 26, depth: 40 } },
    { type: 'osc', wave: 'sine', f0: (o) => 840 + (o.tier || 0) * 300, f1: (o) => 1500 + (o.tier || 0) * 500, dur: 0.3, gain: 0.14, attack: 0.02 },
    { type: 'noise', dur: 0.3, gain: 0.08, filter: { type: 'bandpass', f0: 1400, f1: 4200, q: 2 } },
  ],
  itemGet: [
    { type: 'osc', wave: 'square', f0: 784, f1: 784, dur: 0.09, gain: 0.34, attack: 0.003, filter: { type: 'lowpass', f0: 4600, f1: 4600, q: 0.7 } },
    { type: 'osc', wave: 'square', f0: 1175, f1: 1175, dur: 0.16, gain: 0.3, attack: 0.003, t: 0.075, filter: { type: 'lowpass', f0: 4600, f1: 4600, q: 0.7 } },
    { type: 'osc', wave: 'triangle', f0: 1568, f1: 1568, dur: 0.14, gain: 0.16, attack: 0.004, t: 0.15 },
  ],
  itemRoll: [
    { type: 'osc', wave: 'square', f0: 1480, f1: 1520, dur: 0.06, gain: 0.24, attack: 0.002, filter: { type: 'lowpass', f0: 5200, f1: 5200, q: 0.8 } },
    { type: 'noise', dur: 0.035, gain: 0.16, filter: { type: 'bandpass', f0: 2600, f1: 2600, q: 1.6 } },
  ],
  shellFire: [
    { type: 'osc', wave: 'sine', f0: 1250, f1: 170, dur: 0.28, gain: 0.42, attack: 0.002 },
    { type: 'osc', wave: 'square', f0: 2500, f1: 340, dur: 0.2, gain: 0.1, attack: 0.002, filter: { type: 'lowpass', f0: 4000, f1: 1200, q: 1.4 } },
    { type: 'noise', dur: 0.2, gain: 0.14, filter: { type: 'bandpass', f0: 2400, f1: 500, q: 1.2 } },
  ],
  shellHit: [
    { type: 'noise', dur: 0.26, gain: 0.4, filter: { type: 'lowpass', f0: 2600, f1: 380, q: 1.1 } },
    { type: 'osc', wave: 'square', f0: 210, f1: 66, dur: 0.22, gain: 0.34, attack: 0.002, filter: { type: 'lowpass', f0: 1200, f1: 400, q: 1.6 } },
    { type: 'osc', wave: 'triangle', f0: 900, f1: 300, dur: 0.12, gain: 0.14, attack: 0.002 },
  ],
  bananaDrop: [
    { type: 'osc', wave: 'sine', f0: 340, f1: 145, dur: 0.17, gain: 0.4, attack: 0.003 },
    { type: 'osc', wave: 'triangle', f0: 700, f1: 260, dur: 0.09, gain: 0.12, attack: 0.002 },
    { type: 'noise', dur: 0.045, gain: 0.16, filter: { type: 'bandpass', f0: 900, f1: 900, q: 1.2 } },
  ],
  bananaHit: [
    { type: 'osc', wave: 'square', f0: 540, f1: 160, dur: 0.34, gain: 0.32, attack: 0.004, vibrato: { rate: 34, depth: 70 } },
    { type: 'noise', dur: 0.3, gain: 0.24, filter: { type: 'bandpass', f0: 900, f1: 2400, q: 2.2 } },
    { type: 'osc', wave: 'triangle', f0: 260, f1: 90, dur: 0.24, gain: 0.18, attack: 0.004 },
  ],
  star: [
    { type: 'osc', wave: 'square', f0: 1046, f1: 1046, dur: 0.13, gain: 0.3, attack: 0.003 },
    { type: 'osc', wave: 'square', f0: 1318, f1: 1318, dur: 0.13, gain: 0.3, attack: 0.003, t: 0.06 },
    { type: 'osc', wave: 'square', f0: 1568, f1: 1568, dur: 0.13, gain: 0.3, attack: 0.003, t: 0.12 },
    { type: 'osc', wave: 'square', f0: 2093, f1: 2093, dur: 0.26, gain: 0.32, attack: 0.003, t: 0.18 },
    { type: 'osc', wave: 'triangle', f0: 523, f1: 1046, dur: 0.4, gain: 0.16, attack: 0.01 },
    { type: 'noise', dur: 0.5, gain: 0.1, filter: { type: 'highpass', f0: 4200, f1: 4200, q: 0.7 }, t: 0.18 },
  ],
  lightning: [
    { type: 'noise', dur: 0.85, gain: 0.4, filter: { type: 'lowpass', f0: 4200, f1: 240, q: 1.2 } },
    { type: 'osc', wave: 'sawtooth', f0: 2000, f1: 110, dur: 0.6, gain: 0.24, attack: 0.004, filter: { type: 'lowpass', f0: 6000, f1: 500, q: 2 } },
    { type: 'osc', wave: 'square', f0: 120, f1: 55, dur: 0.5, gain: 0.3, attack: 0.01, t: 0.35 },
  ],
  blooper: [
    { type: 'osc', wave: 'square', f0: 430, f1: 185, dur: 0.46, gain: 0.3, attack: 0.01, vibrato: { rate: 14, depth: 95 }, filter: { type: 'lowpass', f0: 1800, f1: 900, q: 2.2 } },
    { type: 'noise', dur: 0.4, gain: 0.2, filter: { type: 'bandpass', f0: 620, f1: 1500, q: 1.6 }, vibrato: { rate: 9, depth: 260 } },
    { type: 'osc', wave: 'sine', f0: 90, f1: 60, dur: 0.4, gain: 0.2, attack: 0.02 },
  ],
  bulletBill: [
    { type: 'osc', wave: 'sawtooth', f0: 70, f1: 540, dur: 1.05, gain: 0.4, attack: 0.05, filter: { type: 'lowpass', f0: 400, f1: 3000, q: 3.5 } },
    { type: 'noise', dur: 1.0, gain: 0.3, filter: { type: 'bandpass', f0: 420, f1: 2800, q: 0.9 } },
    { type: 'osc', wave: 'square', f0: 140, f1: 1080, dur: 0.9, gain: 0.1, attack: 0.06 },
    { type: 'noise', dur: 0.06, gain: 0.24, filter: { type: 'highpass', f0: 4000, f1: 4000, q: 0.7 }, t: 0.95 },
  ],
  lap: [
    { type: 'osc', wave: 'triangle', f0: 1046, f1: 1046, dur: 0.16, gain: 0.34, attack: 0.004 },
    { type: 'osc', wave: 'triangle', f0: 1568, f1: 1568, dur: 0.3, gain: 0.34, attack: 0.005, t: 0.1 },
    { type: 'osc', wave: 'sine', f0: 523, f1: 523, dur: 0.3, gain: 0.14, attack: 0.01, t: 0.1 },
  ],
  finalLap: [
    { type: 'osc', wave: 'square', f0: 1318, f1: 1318, dur: 0.13, gain: 0.3, attack: 0.003, filter: { type: 'lowpass', f0: 5200, f1: 5200, q: 0.7 } },
    { type: 'osc', wave: 'square', f0: 1760, f1: 1760, dur: 0.13, gain: 0.3, attack: 0.003, t: 0.07, filter: { type: 'lowpass', f0: 5200, f1: 5200, q: 0.7 } },
    { type: 'osc', wave: 'square', f0: 2093, f1: 2093, dur: 0.4, gain: 0.32, attack: 0.003, t: 0.14, filter: { type: 'lowpass', f0: 5200, f1: 5200, q: 0.7 } },
    { type: 'osc', wave: 'triangle', f0: 659, f1: 987, dur: 0.45, gain: 0.18, attack: 0.008, t: 0.14 },
    { type: 'noise', dur: 0.45, gain: 0.12, filter: { type: 'bandpass', f0: 1400, f1: 5200, q: 0.9 }, t: 0.14 },
  ],
  finish: [
    { type: 'osc', wave: 'square', f0: 1046, f1: 1046, dur: 0.14, gain: 0.3, attack: 0.004 },
    { type: 'osc', wave: 'square', f0: 1318, f1: 1318, dur: 0.14, gain: 0.3, attack: 0.004, t: 0.1 },
    { type: 'osc', wave: 'square', f0: 1568, f1: 1568, dur: 0.14, gain: 0.3, attack: 0.004, t: 0.2 },
    { type: 'osc', wave: 'square', f0: 2093, f1: 2093, dur: 0.5, gain: 0.32, attack: 0.004, t: 0.3 },
    { type: 'osc', wave: 'triangle', f0: 523, f1: 523, dur: 0.8, gain: 0.2, attack: 0.01, t: 0.3 },
    { type: 'osc', wave: 'sawtooth', f0: 261, f1: 261, dur: 0.8, gain: 0.14, attack: 0.02, t: 0.3, filter: { type: 'lowpass', f0: 900, f1: 900, q: 1 } },
    { type: 'noise', dur: 0.7, gain: 0.1, filter: { type: 'highpass', f0: 3600, f1: 3600, q: 0.7 }, t: 0.3 },
  ],
  positionGain: [
    { type: 'osc', wave: 'square', f0: 880, f1: 880, dur: 0.09, gain: 0.28, attack: 0.003, filter: { type: 'lowpass', f0: 4600, f1: 4600, q: 0.7 } },
    { type: 'osc', wave: 'square', f0: 1320, f1: 1320, dur: 0.16, gain: 0.3, attack: 0.003, t: 0.06, filter: { type: 'lowpass', f0: 4600, f1: 4600, q: 0.7 } },
    { type: 'osc', wave: 'triangle', f0: 440, f1: 660, dur: 0.2, gain: 0.14, attack: 0.004, t: 0.06 },
  ],
  offTrack: [
    { type: 'noise', dur: 0.3, gain: 0.4, filter: { type: 'lowpass', f0: 900, f1: 420, q: 0.9 } },
    { type: 'osc', wave: 'sine', f0: 96, f1: 78, dur: 0.3, gain: 0.24, attack: 0.01 },
    { type: 'noise', dur: 0.12, gain: 0.16, filter: { type: 'bandpass', f0: 1500, f1: 700, q: 1.1 }, t: 0.02 },
  ],
  wallHit: [
    { type: 'osc', wave: 'sine', f0: 200, f1: 58, dur: 0.24, gain: 0.44, attack: 0.002 },
    { type: 'noise', dur: 0.22, gain: 0.36, filter: { type: 'bandpass', f0: 1400, f1: 380, q: 1.8 } },
    { type: 'osc', wave: 'square', f0: 300, f1: 90, dur: 0.1, gain: 0.14, attack: 0.002 },
    { type: 'noise', dur: 0.14, gain: 0.12, filter: { type: 'highpass', f0: 4200, f1: 4200, q: 0.7 }, t: 0.05 },
  ],
  hop: [
    { type: 'osc', wave: 'triangle', f0: 240, f1: 580, dur: 0.13, gain: 0.34, attack: 0.003 },
    { type: 'osc', wave: 'square', f0: 480, f1: 1160, dur: 0.08, gain: 0.1, attack: 0.002, filter: { type: 'lowpass', f0: 4200, f1: 4200, q: 0.7 } },
    { type: 'noise', dur: 0.05, gain: 0.1, filter: { type: 'bandpass', f0: 2200, f1: 2600, q: 1.2 } },
  ],
  land: [
    { type: 'osc', wave: 'sine', f0: 210, f1: 66, dur: 0.2, gain: 0.44, attack: 0.002 },
    { type: 'noise', dur: 0.16, gain: 0.26, filter: { type: 'lowpass', f0: 1400, f1: 320, q: 1 } },
    { type: 'osc', wave: 'triangle', f0: 420, f1: 140, dur: 0.1, gain: 0.12, attack: 0.002 },
  ],
  coin: [
    { type: 'osc', wave: 'square', f0: 988, f1: 988, dur: 0.07, gain: 0.3, attack: 0.002, filter: { type: 'lowpass', f0: 5200, f1: 5200, q: 0.7 } },
    { type: 'osc', wave: 'square', f0: 1319, f1: 1319, dur: 0.26, gain: 0.3, attack: 0.002, t: 0.06, filter: { type: 'lowpass', f0: 5200, f1: 5200, q: 0.7 } },
    { type: 'osc', wave: 'triangle', f0: 659, f1: 659, dur: 0.24, gain: 0.12, attack: 0.003, t: 0.06 },
  ],
  select: [
    { type: 'osc', wave: 'square', f0: 700, f1: 760, dur: 0.06, gain: 0.24, attack: 0.002, filter: { type: 'lowpass', f0: 4000, f1: 4000, q: 0.8 } },
    { type: 'noise', dur: 0.02, gain: 0.08, filter: { type: 'highpass', f0: 4000, f1: 4000, q: 0.7 } },
  ],
  confirm: [
    { type: 'osc', wave: 'square', f0: 784, f1: 784, dur: 0.08, gain: 0.26, attack: 0.002, filter: { type: 'lowpass', f0: 4600, f1: 4600, q: 0.8 } },
    { type: 'osc', wave: 'square', f0: 1046, f1: 1046, dur: 0.18, gain: 0.28, attack: 0.003, t: 0.07, filter: { type: 'lowpass', f0: 4600, f1: 4600, q: 0.8 } },
    { type: 'osc', wave: 'triangle', f0: 523, f1: 523, dur: 0.2, gain: 0.12, attack: 0.004, t: 0.07 },
  ],
  back: [
    { type: 'osc', wave: 'square', f0: 523, f1: 523, dur: 0.08, gain: 0.24, attack: 0.002, filter: { type: 'lowpass', f0: 3600, f1: 3600, q: 0.8 } },
    { type: 'osc', wave: 'square', f0: 392, f1: 380, dur: 0.18, gain: 0.26, attack: 0.003, t: 0.07, filter: { type: 'lowpass', f0: 3600, f1: 3600, q: 0.8 } },
  ],
  crunch: [
    { type: 'noise', dur: 0.3, gain: 0.44, filter: { type: 'lowpass', f0: 2600, f1: 300, q: 1.3 } },
    { type: 'osc', wave: 'square', f0: 165, f1: 52, dur: 0.26, gain: 0.34, attack: 0.002, filter: { type: 'lowpass', f0: 1000, f1: 300, q: 1.5 } },
    { type: 'noise', dur: 0.14, gain: 0.3, filter: { type: 'bandpass', f0: 1700, f1: 600, q: 1.1 }, t: 0.01 },
    { type: 'osc', wave: 'sawtooth', f0: 320, f1: 90, dur: 0.2, gain: 0.16, attack: 0.002, t: 0.02 },
  ],
  squash: [
    { type: 'osc', wave: 'square', f0: 720, f1: 290, dur: 0.5, gain: 0.3, attack: 0.01, vibrato: { rate: 19, depth: 130 }, filter: { type: 'lowpass', f0: 2200, f1: 700, q: 2 } },
    { type: 'osc', wave: 'triangle', f0: 360, f1: 140, dur: 0.44, gain: 0.2, attack: 0.012, vibrato: { rate: 9, depth: 45 } },
    { type: 'noise', dur: 0.14, gain: 0.2, filter: { type: 'bandpass', f0: 1200, f1: 380, q: 1.4 }, t: 0.42 },
  ],
  horn: [
    { type: 'osc', wave: 'square', f0: 392, f1: 392, dur: 0.42, gain: 0.28, attack: 0.012, filter: { type: 'lowpass', f0: 2400, f1: 2000, q: 1.2 } },
    { type: 'osc', wave: 'square', f0: 494, f1: 494, dur: 0.42, gain: 0.26, attack: 0.014, filter: { type: 'lowpass', f0: 2400, f1: 2000, q: 1.2 } },
    { type: 'noise', dur: 0.03, gain: 0.1, filter: { type: 'highpass', f0: 3000, f1: 3000, q: 0.7 } },
  ],
  // The super horn: a bright rising brass blast that reads as an emphatic
  // "get out of the way", distinguishable from the shell fire it responds to.
  superHorn: [
    { type: 'osc', wave: 'sawtooth', f0: 440, f1: 1320, dur: 0.3, gain: 0.34, attack: 0.006, filter: { type: 'lowpass', f0: 900, f1: 5200, q: 2.2 } },
    { type: 'osc', wave: 'square', f0: 660, f1: 1760, dur: 0.26, gain: 0.2, attack: 0.006, filter: { type: 'lowpass', f0: 1400, f1: 5600, q: 1.4 } },
    { type: 'noise', dur: 0.22, gain: 0.18, filter: { type: 'bandpass', f0: 900, f1: 5200, q: 0.9 } },
  ],
};

/** Per-layer peak levels keep a busy race from clipping before the limiter. */
const SFX_SCALE = 0.85;

export class AudioSystem {
  /** @param {{bus?: any, store?: any}} [ctx] */
  constructor(ctx) {
    this.name = 'audio';
    this.persistent = true;
    this.ctx = ctx || null;
    this.bus = (ctx && ctx.bus) || null;

    /** @type {AudioContext|null} */
    this._ac = null;
    this.ready = false;
    this.failed = false;
    this.paused = false;
    this.muted = false;

    this.volumes = { master: 0.8, music: 0.5, sfx: 0.9 };
    /** @type {MusicSequencer|null} */
    this.music = null;
    /** Music requested before the gesture that unlocks the context. */
    this._wantMusic = null;

    /** @type {any} */
    this._kart = null;
    this._engine = null;
    this._engineState = { rpm: 0, load: 0, gear: 1, speed: 0, t: -10 };
    this._baseFreq = DEFAULT_BASE_FREQ;
    this._timbre = 0.5;
    this._engineGain = 0;
    this._engineKart = null;
    this._engineRelease = 0;
    this._engineAcc = 0;
    this._boostMix = 0;
    this._noiseOffset = 0;

    this._voices = [];
    this._time = 0;
    this._finalLapTimer = 0;

    this._offBus = [];
    this._bindBus();
  }

  /* ------------------------------------------------------------ lifecycle -- */

  /** Creates the AudioContext on the first user gesture. Safe to call often. */
  unlock() {
    if (this.ready) {
      try {
        if (this._ac && this._ac.state !== 'running') {
          const p = this._ac.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (err) {
        /* a rejected resume must not break input handling */
      }
      return true;
    }
    if (this.failed) return false;
    try {
      if (typeof window === 'undefined') {
        this.failed = true;
        return false;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        this.failed = true;
        return false;
      }
      this._ac = new AC({ latencyHint: 'interactive' });
      this._build();
      const p = this._ac.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      this.ready = true;
      this.paused = false;
      // A kart may have been attached before the first gesture.
      if (this._kart) this.setEngine(this._kart);
      if (this._wantMusic) {
        const want = this._wantMusic;
        this._wantMusic = null;
        this.playMusic(want.name, want.fade);
      }
      return true;
    } catch (err) {
      this.failed = true;
      return false;
    }
  }

  /** Alias used by the boot module. */
  resume() {
    return this.unlock();
  }

  _build() {
    const ac = this._ac;

    this._noise = this._makeNoise();

    this._master = ac.createGain();
    this._master.gain.value = this.muted ? 0 : this.volumes.master;

    // Gentle bus glue plus a soft-clipping safety net after it: the engine,
    // the music and several SFX can peak at the same moment in a busy race.
    this._comp = ac.createDynamicsCompressor();
    this._comp.threshold.value = -12;
    this._comp.knee.value = 30;
    this._comp.ratio.value = 3.5;
    this._comp.attack.value = 0.005;
    this._comp.release.value = 0.2;

    this._limiter = ac.createWaveShaper();
    this._limiter.curve = this._softClipCurve(2.4);
    this._limiter.oversample = '2x';

    this._out = ac.createGain();
    this._out.gain.value = 0.92;

    this._master.connect(this._comp);
    this._comp.connect(this._limiter);
    this._limiter.connect(this._out);
    this._out.connect(ac.destination);

    this._sfxBus = ac.createGain();
    this._sfxBus.gain.value = this.volumes.sfx;
    this._sfxBus.connect(this._master);

    this._musicBus = ac.createGain();
    this._musicBus.gain.value = this.volumes.music;
    this._musicBus.connect(this._master);

    this._engineBus = ac.createGain();
    this._engineBus.gain.value = 0.85;
    this._engineBus.connect(this._master);
  }

  _makeNoise() {
    const ac = this._ac;
    const len = Math.floor(ac.sampleRate * 2);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      // Slightly brown-ish noise reads warmer than pure white for engines.
      last = (last + 0.02 * white) / 1.02;
      data[i] = white * 0.72 + last * 3.2;
    }
    return buf;
  }

  _softClipCurve(drive) {
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
    }
    return curve;
  }

  _bindBus() {
    const bus = this.bus;
    if (!bus || typeof bus.on !== 'function') return;
    this._offBus.push(bus.on('audio:sfx', (p) => {
      if (!p || !p.name) return;
      this.playSfx(p.name, p.opts || p);
    }));
    this._offBus.push(bus.on('audio:music', (p) => {
      if (!p || !p.name) return;
      this.playMusic(p.name, p.fade);
    }));
  }

  /* --------------------------------------------------------------- volume -- */

  setMuted(muted) {
    this.muted = !!muted;
    if (!this.ready) return;
    const now = this._ac.currentTime;
    this._master.gain.cancelScheduledValues(now);
    this._master.gain.setValueAtTime(this._master.gain.value, now);
    this._master.gain.linearRampToValueAtTime(this.muted ? 0.0001 : this.volumes.master, now + 0.12);
  }

  setVolumes(v) {
    if (!v) return;
    if (typeof v.master === 'number') this.volumes.master = clamp(v.master, 0, 2);
    if (typeof v.music === 'number') this.volumes.music = clamp(v.music, 0, 2);
    if (typeof v.sfx === 'number') this.volumes.sfx = clamp(v.sfx, 0, 2);
    if (!this.ready) return;
    const now = this._ac.currentTime;
    this._ramp(this._master.gain, this.muted ? 0.0001 : this.volumes.master, now, 0.08);
    this._ramp(this._musicBus.gain, this.volumes.music, now, 0.08);
    this._ramp(this._sfxBus.gain, this.volumes.sfx, now, 0.08);
  }

  _ramp(param, value, now, seconds) {
    try {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(Math.max(0.0001, value), now + Math.max(0.005, seconds));
    } catch (err) {
      param.value = value;
    }
  }

  /* ------------------------------------------------------------------ sfx -- */

  /** Plays a named one-shot sound. opts: { volume, rate, pan, tier, kind }. */
  playSfx(name, opts) {
    if (!this.ready || this.failed || this.paused) return;
    const spec = S[name];
    if (!spec) return;
    const ac = this._ac;
    let volume = 1;
    let rate = 1;
    let pan = 0;
    if (opts) {
      if (typeof opts.volume === 'number') volume = clamp(opts.volume, 0, 4);
      if (typeof opts.rate === 'number') rate = clamp(opts.rate, 0.25, 4);
      if (typeof opts.pan === 'number') pan = clamp(opts.pan, -1, 1);
    }

    if (name === 'finalLap') this._finalLap();

    // Silent or muted requests still cost a handful of nodes, so bail early -
    // but only after the final-lap hook above has had its chance.
    if (volume <= 0 || this.muted) return;

    this._pruneVoices();
    while (this._voices.length >= MAX_VOICES) this._stealVoice();

    const now = ac.currentTime;
    const gain = ac.createGain();
    gain.gain.value = SFX_SCALE * volume;

    // A panner is the only path to the bus when the caller asked for one, so
    // the dry connection below must be skipped or the sound would double up.
    let out = gain;
    if (pan !== 0 && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = pan;
      gain.connect(p);
      p.connect(this._sfxBus);
      out = p;
    } else {
      gain.connect(this._sfxBus);
    }

    // The outermost node, kept so teardown can cut the whole voice off in one
    // go. It used to be only `gain`, which nothing ever disconnected: the
    // sources, filters and envelope gains were released on `onended` but the
    // voice's own gain stayed wired into the sfx bus forever, so every one-shot
    // sound left a live GainNode pulling on the audio graph.
    const rec = { end: now, gain, out, sources: [] };
    this._voices.push(rec);
    for (let i = 0; i < spec.length; i++) {
      try {
        this._playLayer(spec[i], rate, out, rec, opts || {}, now);
      } catch (err) {
        /* one broken layer must never take the rest of the mix down */
      }
    }
    if (rec.end <= now) {
      const idx = this._voices.indexOf(rec);
      if (idx >= 0) this._voices.splice(idx, 1);
    }
  }

  /** Cuts a finished voice off the graph entirely. */
  _releaseVoice(rec) {
    if (!rec || rec._released) return;
    rec._released = true;
    const nodes = [rec.out, rec.gain];
    for (let i = 0; i < rec.sources.length; i++) {
      const s = rec.sources[i];
      nodes.push(s);
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || typeof n.disconnect !== 'function') continue;
      try {
        n.disconnect();
      } catch (e) {
        /* already gone */
      }
    }
  }

  /** Alias matching the `audio:sfx` bus payload. */
  sfx(name, opts) {
    this.playSfx(name, opts);
  }

  _playLayer(layer, rate, dest, rec, opts, now) {
    const ac = this._ac;
    const t0 = now + (layer.t || 0) / rate;
    const dur = Math.max(0.015, (layer.dur || 0.2) / rate);
    const attack = Math.max(0.001, (layer.attack || 0.004) / rate);
    const pick = (v) => (typeof v === 'function' ? v(opts) : v);

    const amp = ac.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(Math.max(0.0002, layer.gain || 0.3), t0 + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    amp.connect(dest);

    let tail = amp;
    if (layer.filter) {
      const f = ac.createBiquadFilter();
      f.type = layer.filter.type || 'lowpass';
      const f0 = Math.max(20, pick(layer.filter.f0) || layer.filter.f0 || 1000);
      const f1 = Math.max(20, pick(layer.filter.f1) || layer.filter.f1 || f0);
      f.frequency.setValueAtTime(f0 * Math.min(rate, 2.2), t0);
      if (Math.abs(f1 - f0) > 1) {
        f.frequency.exponentialRampToValueAtTime(Math.max(21, f1 * Math.min(rate, 2.2)), t0 + dur * 0.92);
      }
      f.Q.value = layer.filter.q != null ? layer.filter.q : 1;
      f.connect(amp);
      tail = f;
    }

    let src;
    if (layer.type === 'noise') {
      src = ac.createBufferSource();
      src.buffer = this._noise;
      src.loop = true;
      src.playbackRate.value = clamp(rate, 0.25, 4);
      const off = this._noiseOffset;
      this._noiseOffset = (this._noiseOffset + 0.371) % 1.5;
      try {
        src.start(t0, off);
      } catch (err) {
        src.start(t0);
      }
    } else {
      src = ac.createOscillator();
      src.type = layer.wave || 'square';
      const f0 = Math.max(12, (pick(layer.f0) || 60) * rate);
      const f1 = Math.max(12, (pick(layer.f1) || f0) * rate);
      src.frequency.setValueAtTime(f0, t0);
      if (Math.abs(f1 - f0) > 0.5) {
        if (layer.linear) src.frequency.linearRampToValueAtTime(f1, t0 + dur * 0.94);
        else src.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.94);
      }
      try {
        src.start(t0);
      } catch (err) {
        return;
      }
    }
    // Vibrato wobbles the oscillator for tones and the filter for noise, which
    // is what gives the blooper its bubbling.
    if (layer.vibrato) {
      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = (layer.vibrato.rate || 12) * rate;
      const depth = ac.createGain();
      depth.gain.value = layer.vibrato.depth || 40;
      lfo.connect(depth);
      depth.connect(layer.type === 'noise' ? tail.frequency : src.frequency);
      try {
        lfo.start(t0);
        lfo.stop(t0 + dur + 0.03);
      } catch (err) {
        /* ignore */
      }
      rec.sources.push(lfo);
    }
    try {
      src.stop(t0 + dur + 0.02);
    } catch (err) {
      /* ignore */
    }
    src.connect(tail);
    rec.sources.push(src);
    if (t0 + dur > rec.end) rec.end = t0 + dur;

    const self = this;
    src.onended = () => {
      const i = self._voices.indexOf(rec);
      if (i >= 0 && self._voices[i].end <= ac.currentTime) self._voices.splice(i, 1);
      try {
        src.disconnect();
        tail.disconnect();
        amp.disconnect();
      } catch (e) {
        /* already gone */
      }
      self._releaseVoice(rec);
    };
  }

  _pruneVoices() {
    const now = this._ac.currentTime;
    const v = this._voices;
    let w = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i].end > now) v[w++] = v[i];
      else this._releaseVoice(v[i]);
    }
    v.length = w;
  }

  _stealVoice() {
    if (!this._voices.length) return;
    let best = 0;
    for (let i = 1; i < this._voices.length; i++) {
      if (this._voices[i].end < this._voices[best].end) best = i;
    }
    const rec = this._voices[best];
    this._voices.splice(best, 1);
    const now = this._ac.currentTime;
    try {
      rec.gain.gain.cancelScheduledValues(now);
      rec.gain.gain.setValueAtTime(rec.gain.gain.value, now);
      rec.gain.gain.linearRampToValueAtTime(0.0001, now + 0.02);
    } catch (err) {
      /* ignore */
    }
    // The fade-out takes 20 ms; release the nodes once it has faded out rather
    // than cutting the sound off mid-decay.
    const self = this;
    this._ac.setTimeout ? this._ac.setTimeout(() => self._releaseVoice(rec), 60) : setTimeout(() => self._releaseVoice(rec), 60);    for (const s of rec.sources) {      try {
        s.stop(now + 0.03);
      } catch (err) {
        /* ignore */
      }
    }
  }

  /* --------------------------------------------------------------- music -- */

  playMusic(name, fadeSeconds) {
    if (!this.ready) {
      this._wantMusic = { name, fade: fadeSeconds == null ? 1 : fadeSeconds };
      return;
    }
    const track = getMusicTrack(name);
    if (!track) return;
    const fade = clamp(fadeSeconds == null ? 1 : fadeSeconds, 0.01, 8);

    const cur = this.music;
    if (cur && cur.name === name) {
      if (name === 'race') cur.setLayer('intensity', 0, fade);
      return;
    }

    if (cur) {
      if (name === 'finalLap' && cur.name === 'race') cur.setLayer('intensity', 1, fade);
      cur.stop(fade);
    }

    const seq = new MusicSequencer(this._ac, this._musicBus, track, { noise: this._noise });
    seq.start(fade);
    this.music = seq;
  }

  stopMusic(fadeSeconds) {
    const fade = clamp(fadeSeconds == null ? 0.8 : fadeSeconds, 0.01, 8);
    if (this.music) {
      this.music.stop(fade);
      this.music = null;
    }
    this._wantMusic = null;
  }

  /** Fades a named mix layer of the current track ('base' | 'intensity'). */
  setMusicLayer(layer, value, seconds) {
    if (this.music) this.music.setLayer(layer, value, seconds);
  }

  /** Drives the final-lap intensity layer of the race track. */
  setMusicIntensity(value, seconds) {
    this.setMusicLayer('intensity', value, seconds);
  }

  _finalLap() {
    if (this._finalLapTimer > 0) return;
    // Only ever follow the race bed with its remix - never the menu music -
    // and only once, so a duplicated event cannot restart the crossfade.
    if (this.music && this.music.name === 'race') {
      this._finalLapTimer = 4;
      this.playMusic('finalLap', 2.4);
    }
  }

  /* --------------------------------------------------------------- engine -- */

  /** Start following one kart's engine (pass null to stop). */
  setEngine(kart) {
    this._kart = kart || null;
    if (!this.ready) return;
    if (!kart) {
      this._stopEngine();
      return;
    }
    const e = this._ensureEngine();
    if (!e) return;
    // Fade in through the JS-side level ramp so nothing clicks on attach.
    this._engineGain = 0.0005;
    const ch = kart.character;
    if (ch && ch.engine) {
      if (typeof ch.engine.baseFreq === 'number') this._baseFreq = clamp(ch.engine.baseFreq, 30, 220);
      if (typeof ch.engine.timbre === 'number') this._timbre = clamp(ch.engine.timbre, 0, 1);
    }
  }

  /** Direct engine telemetry from KartPhysics (called ~20 Hz). */
  setEngineState(rpm, load, gear, speed) {
    const st = this._engineState;
    st.rpm = clamp(typeof rpm === 'number' ? rpm : 0, 0, 1);
    st.load = clamp(typeof load === 'number' ? load : 0, 0, 1);
    st.gear = clamp(Math.round(typeof gear === 'number' ? gear : 1), 1, 6);
    st.speed = typeof speed === 'number' ? speed : 0;
    st.t = this._time;
  }

  _ensureEngine() {
    if (this._engine) return this._engine;
    const ac = this._ac;
    try {
      const out = ac.createGain();
      out.gain.value = 0.0001;
      out.connect(this._engineBus);

      // Trim after the resonant lowpass: two saws + a sub can otherwise push
      // the engine bus past the master compressor's comfort zone.
      const trim = ac.createGain();
      trim.gain.value = 0.8;
      trim.connect(out);

      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      lp.Q.value = 1.4;
      lp.connect(trim);

      const g1 = ac.createGain();
      g1.gain.value = 0.34;
      g1.connect(lp);
      const g2 = ac.createGain();
      g2.gain.value = 0.24;
      g2.connect(lp);
      const gsub = ac.createGain();
      gsub.gain.value = 0.42;
      gsub.connect(lp);

      const osc1 = ac.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = this._baseFreq;
      osc1.connect(g1);

      const osc2 = ac.createOscillator();
      osc2.type = 'sawtooth';
      osc2.detune.value = 9;
      osc2.frequency.value = this._baseFreq * 1.004;
      osc2.connect(g2);

      const sub = ac.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = this._baseFreq * 0.5;
      sub.connect(gsub);

      // Load: filtered noise that opens with throttle.
      const loadSrc = ac.createBufferSource();
      loadSrc.buffer = this._noise;
      loadSrc.loop = true;
      const loadBp = ac.createBiquadFilter();
      loadBp.type = 'bandpass';
      loadBp.frequency.value = 700;
      loadBp.Q.value = 0.85;
      const loadGain = ac.createGain();
      loadGain.gain.value = 0.0001;
      loadSrc.connect(loadBp);
      loadBp.connect(loadGain);
      loadGain.connect(out);

      // Tyre screech: a separate band-passed noise channel driven by slip.
      const screechSrc = ac.createBufferSource();
      screechSrc.buffer = this._noise;
      screechSrc.loop = true;
      const screechBp = ac.createBiquadFilter();
      screechBp.type = 'bandpass';
      screechBp.frequency.value = 1900;
      screechBp.Q.value = 2.4;
      const screechGain = ac.createGain();
      screechGain.gain.value = 0.0001;
      const screechPan = ac.createStereoPanner ? ac.createStereoPanner() : null;
      screechSrc.connect(screechBp);
      screechBp.connect(screechGain);
      if (screechPan) {
        screechPan.pan.value = 0;
        screechGain.connect(screechPan);
        screechPan.connect(out);
      } else {
        screechGain.connect(out);
      }

      // Boost layer: brighter saws and a higher cutoff, crossfaded in.
      const bmix = ac.createGain();
      bmix.gain.value = 0.42;
      const blp = ac.createBiquadFilter();
      blp.type = 'lowpass';
      blp.frequency.value = 1200;
      blp.Q.value = 1.2;
      bmix.connect(blp);
      const bg = ac.createGain();
      bg.gain.value = 0.0001;
      blp.connect(bg);
      bg.connect(out);
      const bo1 = ac.createOscillator();
      bo1.type = 'sawtooth';
      const bo2 = ac.createOscillator();
      bo2.type = 'sawtooth';
      bo2.detune.value = 14;
      const boSub = ac.createOscillator();
      boSub.type = 'triangle';
      bo1.connect(bmix);
      bo2.connect(bmix);
      boSub.connect(bmix);

      const all = [osc1, osc2, sub, loadSrc, screechSrc, bo1, bo2, boSub];
      for (const s of all) {
        try {
          s.start();
        } catch (err) {
          /* ignore */
        }
      }

      this._engine = {
        out, trim, lp, g1, g2, gsub, osc1, osc2, sub,
        loadSrc, loadBp, loadGain,
        screechSrc, screechBp, screechGain, screechPan,
        bmix, blp, bg, bo1, bo2, boSub,
        sources: all,
      };
    } catch (err) {
      this._engine = null;
    }
    return this._engine;
  }

  /**
   * Detaches from the kart. The engine fades out inside `_updateEngine` and
   * only tears its nodes down once it is inaudible, so there is never a click.
   */
  _stopEngine() {
    this._kart = null;
    this._engineKart = null;
    this._engineRelease = 0;
  }

  /** Kills the engine nodes (already faded to silence) and releases them. */
  _teardownEngine() {
    const e = this._engine;
    this._engine = null;
    this._engineGain = 0;
    this._engineKart = null;
    this._engineRelease = 0;
    if (!e) return;
    for (const s of e.sources) {
      try {
        s.stop();
      } catch (err) {
        /* already stopped */
      }
    }
    try {
      e.out.disconnect();
    } catch (err) {
      /* already gone */
    }
  }

  _updateEngine(dt) {
    const e = this._engine;
    if (!e || !this._ac) return;
    const ac = this._ac;
    const now = ac.currentTime;
    const set = (param, v) => {
      try {
        param.setTargetAtTime(v, now, 0.035);
      } catch (err) {
        param.value = v;
      }
    };
    const kart = this._kart;
    if (!kart) {
      this._engineRelease += dt;
      this._engineGain = damp(this._engineGain, 0, 4, dt);
      set(e.out.gain, Math.max(0.0001, this._engineGain));
      set(e.loadGain.gain, 0.0001);
      set(e.screechGain.gain, 0.0001);
      set(e.bg.gain, 0.0001);
      // ~1 s at a 4/s approach is below -34 dB, so it is safe to release.
      if (this._engineRelease > 1) this._teardownEngine();
      return;
    }

    const phys = kart.physics || null;
    const st = this._engineState;
    const fresh = st && this._time - st.t < 0.5;

    const ch = kart.character || null;
    const wantBase = ch && ch.engine && typeof ch.engine.baseFreq === 'number' ? clamp(ch.engine.baseFreq, 30, 220) : DEFAULT_BASE_FREQ;
    const wantTimbre = ch && ch.engine && typeof ch.engine.timbre === 'number' ? clamp(ch.engine.timbre, 0, 1) : 0.5;
    if (kart !== this._engineKart) {
      this._engineKart = kart;
      this._baseFreq = lerp(this._baseFreq, wantBase, 0.75);
      this._timbre = lerp(this._timbre, wantTimbre, 0.75);
    } else {
      this._baseFreq = damp(this._baseFreq, wantBase, 2.5, dt);
      this._timbre = damp(this._timbre, wantTimbre, 2.5, dt);
    }

    let top = 34;
    if (phys && typeof phys.effectiveTopSpeed === 'function') {
      const t = phys.effectiveTopSpeed();
      if (t > 4) top = t;
    }
    const speed = phys && typeof phys.speed === 'number' ? phys.speed : fresh ? st.speed : 0;
    const frac = clamp(Math.abs(speed) / top, 0, 1);

    // ---- 6-gear simulated rpm -------------------------------------------
    let gear = 0;
    for (let i = 0; i < GEAR_LO.length; i++) if (frac >= GEAR_HI[i] - 0.001) gear = i;
    let rpm = 0.2 + 0.8 * clamp((frac - GEAR_LO[gear]) / Math.max(0.06, GEAR_HI[gear] - GEAR_LO[gear]), 0, 1);
    let gearNo = gear + 1;
    let load = 0;
    let throttle = 0;
    if (phys) {
      if (typeof phys.gear === 'number') gearNo = clamp(Math.round(phys.gear), 1, 6);
      if (typeof phys.rpm === 'number') rpm = clamp(phys.rpm, 0.06, 1);
      load = clamp(phys.load || 0, 0, 1);
      throttle = clamp(phys.throttle || 0, 0, 1);
    } else if (fresh) {
      rpm = clamp(st.rpm, 0.06, 1);
      gearNo = clamp(st.gear, 1, 6);
      load = clamp(st.load, 0, 1);
    }

    const mul = GEAR_MUL[gearNo - 1];
    const pitch = this._baseFreq * (0.8 + 1.75 * frac) * mul * (0.95 + 0.1 * rpm);
    const cutoff = clamp(240 + 3400 * rpm + 900 * load + 800 * frac, 180, 8600);
    const q = 1 + 2.6 * this._timbre;

    // ---- drift / slip ----------------------------------------------------
    let charge = 0;
    let lat = 0;
    let surface = 'road';
    if (phys) {
      const d = phys.drift;
      if (d && d.active) charge = clamp((d.charge || 0) / 1.6, 0, 1);
      lat = Math.abs(phys.lateralSpeed || 0);
      surface = phys.surface || 'road';
    }
    const slip = clamp(lat / 7 + charge * 0.55, 0, 1) * (surface === 'off' ? 0.6 : 1);
    const screech = slip * slip;

    // ---- boost crossfade -------------------------------------------------
    const boosting = !!(phys && phys.boost && phys.boost.timer > 0);
    this._boostMix = damp(this._boostMix, boosting ? 1 : 0, boosting ? 7 : 4, dt);
    const bm = this._boostMix;

    set(e.osc1.frequency, pitch);
    set(e.osc2.frequency, pitch * 1.0045);
    set(e.sub.frequency, pitch * 0.5);
    set(e.osc2.detune, 7 + this._timbre * 12);
    set(e.lp.frequency, cutoff);
    set(e.lp.Q, q);
    set(e.g1.gain, 0.34 * (1 - 0.4 * bm));
    set(e.g2.gain, 0.24 * (1 - 0.4 * bm));
    set(e.gsub.gain, 0.42 + 0.2 * load);

    set(e.loadBp.frequency, clamp(420 + 2300 * rpm + 500 * load, 200, 6000));
    set(e.loadGain.gain, 0.03 + 0.22 * load + 0.06 * frac);

    set(e.screechBp.frequency, clamp(1450 + 1500 * slip, 900, 4200));
    set(e.screechGain.gain, 0.34 * screech * (1 - 0.4 * bm));
    if (e.screechPan) {
      const dir = phys && phys.drift && phys.drift.active ? Math.sign(phys.drift.dir || 0) : 0;
      set(e.screechPan.pan, clamp(dir * 0.45, -1, 1));
    }

    set(e.blp.frequency, clamp(cutoff * 1.8 + 900, 600, 9000));
    set(e.bg.gain, 0.5 * bm);
    set(e.bo1.frequency, pitch * 1.5);
    set(e.bo2.frequency, pitch * 1.505);
    set(e.boSub.frequency, pitch * 0.75);

    const level = 0.1 + 0.3 * frac + 0.22 * throttle + 0.1 * bm;
    this._engineGain = damp(this._engineGain, clamp(level, 0.05, 0.85), 6, dt);
    set(e.out.gain, Math.max(0.0001, this._engineGain));
  }

  /* --------------------------------------------------------------- update -- */

  /** Called by the game loop. `dt` is ignored in favour of the audio clock. */
  update(dt) {
    const step = typeof dt === 'number' && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
    this._time += step;
    if (this._finalLapTimer > 0) this._finalLapTimer -= step;
    if (!this.ready || this.paused) return;
    try {
      if (this.music) this.music.update(dt);
      if (this._voices.length) this._pruneVoices();
      // The engine owns ~20 automated params; ~80 Hz is plenty and keeps the
      // automation timeline short on a 120 Hz simulation.
      this._engineAcc += step;
      if (this._engineAcc >= 0.0125) {
        this._updateEngine(this._engineAcc);
        this._engineAcc = 0;
      }
    } catch (err) {
      /* audio must never break the frame */
    }
  }

  init(ctx) {
    if (!this.ctx && ctx) {
      this.ctx = ctx;
      if (!this.bus && ctx.bus) this.bus = ctx.bus;
    }
  }

  pauseAll() {
    if (!this.ready) return;
    this.paused = true;
    const now = this._ac.currentTime;
    try {
      this._ramp(this._master.gain, 0.0001, now, 0.05);
    } catch (err) {
      /* ignore */
    }
    const p = this._ac.suspend();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  resumeAll() {
    if (!this.ready) return;
    this.paused = false;
    const p = this._ac.resume();
    const self = this;
    const restore = () => {
      try {
        self._ramp(self._master.gain, self.muted ? 0.0001 : self.volumes.master, self._ac.currentTime, 0.1);
      } catch (err) {
        /* ignore */
      }
      if (self.music) self.music.resync();
    };
    if (p && typeof p.then === 'function') p.then(restore, restore);
    else restore();
  }

  dispose() {
    for (const off of this._offBus) {
      try {
        off();
      } catch (err) {
        /* ignore */
      }
    }
    this._offBus.length = 0;
    this._voices.length = 0;
    this._kart = null;
    this._teardownEngine();
    if (this.music) {
      this.music.dispose();
      this.music = null;
    }
    if (this._ac) {
      try {
        this._ac.close();
      } catch (err) {
        /* ignore */
      }
      this._ac = null;
    }
    this.ready = false;
  }
}

export default AudioSystem;
