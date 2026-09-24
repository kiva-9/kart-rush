/**
 * Kart Rush music: three tracks written as *pure data* (tempo, bar count,
 * instrument assignment, 16th-note step patterns) plus the tiny step sequencer
 * that turns that data into sound.
 *
 * Everything is synthesised at runtime - square / triangle voices, filtered
 * noise drums and a pitch-swept kick. No samples, no files, no network.
 *
 * Track intent:
 *   menu      - bright, laid-back, major-key. Loops forever without tiring.
 *   race      - upbeat major loop with a driving bass and an `intensity` layer
 *               (harmony, octave bass, stabs) that fades in on the final lap.
 *   finalLap  - faster, tenser minor-key remix of `race` for the last lap.
 */

const STEPS_PER_BAR = 16;
/** Schedule this far ahead of the audio clock so timing never jitters. */
const LOOKAHEAD = 0.13;
/** Hard cap on simultaneous sequencer voices; extra notes are dropped. */
const MAX_VOICES = 32;

const SEMITONE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** 'c#4' | 'bb3' | 'r' -> Hz. Returns 0 for rests and unusable tokens. */
export function noteToFreq(token) {
  if (typeof token !== 'string') return 0;
  const t = token.trim();
  if (!t || t === 'r' || t === '-' || t === '.') return 0;
  const m = /^([a-g])(#|b)?(-?\d)$/.exec(t);
  if (!m) return 0;
  const semi = SEMITONE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const octave = parseInt(m[3], 10);
  const midi = (octave + 1) * 12 + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Melodic instruments: envelope, filter and send amount. `gate` is in steps. */
const VOICES = {
  lead: { wave: 'square', gain: 0.30, gate: 1.0, attack: 0.003, cutoff: 3600, q: 0.7, send: 0.30, detune: 0, glide: 0 },
  lead2: { wave: 'square', gain: 0.20, gate: 0.95, attack: 0.003, cutoff: 3000, q: 0.7, send: 0.34, detune: 7, glide: 0 },
  harm: { wave: 'triangle', gain: 0.22, gate: 1.35, attack: 0.006, cutoff: 2800, q: 0.6, send: 0.24, detune: 0, glide: 0 },
  pad: { wave: 'triangle', gain: 0.14, gate: 3.4, attack: 0.05, cutoff: 2000, q: 0.5, send: 0.4, detune: 0, glide: 0 },
  bassSq: { wave: 'square', gain: 0.34, gate: 0.82, attack: 0.002, cutoff: 820, q: 2.4, send: 0, detune: 0, glide: 0.05 },
  bassSaw: { wave: 'sawtooth', gain: 0.28, gate: 0.5, attack: 0.002, cutoff: 1000, q: 1.8, send: 0.06, detune: 0, glide: 0.04 },
  bassT: { wave: 'triangle', gain: 0.32, gate: 1.6, attack: 0.005, cutoff: 950, q: 1.1, send: 0, detune: 0, glide: 0.03 },
  stab: { wave: 'square', gain: 0.16, gate: 0.4, attack: 0.002, cutoff: 2600, q: 0.8, send: 0.3, detune: 4, glide: 0 },
};

/** Percussion instruments, all synthesised. */
const DRUMS = {
  kick: { gain: 0.95, f0: 168, f1: 44, dur: 0.28, body: 0.55 },
  tom: { gain: 0.55, f0: 340, f1: 130, dur: 0.22 },
  snare: { gain: 0.5, tone: 186, dur: 0.19, noiseFreq: 1900, noiseQ: 0.9, noiseDur: 0.17 },
  hat: { gain: 0.2, dur: 0.048, freq: 9200, type: 'highpass', q: 0.7 },
  open: { gain: 0.22, dur: 0.24, freq: 7200, type: 'highpass', q: 0.7 },
  ride: { gain: 0.17, dur: 0.13, freq: 6400, type: 'bandpass', q: 0.8 },
  crash: { gain: 0.3, dur: 1.1, freq: 4600, type: 'highpass', q: 0.6 },
};

/* ------------------------------------------------------------------ tracks -- */

const MENU = {
  name: 'menu',
  title: 'Sunset Circuit',
  bpm: 96,
  bars: 4,
  swing: 0.035,
  layers: [{ id: 'base', gain: 1 }],
  channels: [
    {
      voice: 'kick',
      bars: [
        'x . . . . . . . x . . . . . . .',
        '. . . . . . . . . . . . . . . .',
        'x . . . . . . . x . . . . . . .',
        '. . . . . . . . . . . . x . . .',
      ],
      gain: 0.9,
    },
    {
      voice: 'snare',
      bars: [
        '. . . . x . . . . . . . x . . .',
        '. . . . x . . . . . . . x . . .',
        '. . . . x . . . . . . . x . . .',
        '. . . . x . . . . . x . . . . .',
      ],
      gain: 0.8,
    },
    {
      voice: 'hat',
      bars: [
        'x . x . x . x . x . x . x . x .',
        'x . x . x . x . x . x . x . x .',
        'x . x . x . x . x . x . x . x .',
        'x . x . x . x . x . x . x . x .',
      ],
      gain: 0.8,
      pan: 0.22,
    },
    {
      voice: 'open',
      bars: [
        '. . . . . . . . . . . . . . x .',
        '. . . . . . . . . . . . . . x .',
        '. . . . . . . . . . . . . . x .',
        '. . . . . . . . . . . . . . . x',
      ],
      gain: 0.7,
      pan: -0.28,
    },
    {
      voice: 'bassT',
      bars: [
        'c2 . c2 . . . c3 . c2 . . . g2 . . .',
        'a1 . a1 . . . a2 . a1 . . . e2 . . .',
        'f2 . f2 . . . f3 . f2 . . . c3 . . .',
        'g2 . g2 . . . g3 . g2 . . . d3 . . .',
      ],
      gain: 0.95,
    },
    {
      voice: 'pad',
      bars: ['c3 . . . . . . . . . . . . . . .', 'a2 . . . . . . . . . . . . . . .', 'f2 . . . . . . . . . . . . . . .', 'g2 . . . . . . . . . . . . . . .'],
      gain: 0.9,
      pan: -0.12,
    },
    {
      voice: 'lead',
      bars: [
        'e4 . . . . . . . g4 . . . c5 . . .',
        'a4 . . . . . . . g4 . . . e4 . . .',
        'f4 . . . . . a4 . c5 . . . . . a4 .',
        'g4 . . . . . b4 . d5 . . . . . b4 .',
      ],
      gain: 1,
      gate: 2.4,
    },
    {
      voice: 'harm',
      bars: [
        'c4 . . . . . . . e4 . . . g4 . . .',
        'e4 . . . . . . . c4 . . . c4 . . .',
        'c4 . . . . . f4 . a4 . . . . . f4 .',
        'e4 . . . . . g4 . b4 . . . . . g4 .',
      ],
      gain: 0.95,
      gate: 2.4,
      pan: 0.3,
    },
  ],
};

const RACE = {
  name: 'race',
  title: 'Kart Rush',
  bpm: 152,
  bars: 4,
  swing: 0,
  layers: [
    { id: 'base', gain: 1 },
    { id: 'intensity', gain: 0 },
  ],
  channels: [
    {
      voice: 'kick',
      bars: [
        'x . . . x . . . x . . . x . . .',
        'x . . . x . . . x . . . x . . .',
        'x . . . x . . . x . . . x . . .',
        'x . . . x . . . x . . . x . x .',
      ],
      gain: 1,
    },
    {
      voice: 'snare',
      bars: [
        '. . . . x . . . . . . . x . . .',
        '. . . . x . . . . . . . x . . .',
        '. . . . x . . . . . . . x . . .',
        '. . . . x . . . . . . . x . x .',
      ],
      gain: 0.9,
    },
    {
      voice: 'hat',
      bars: [
        'x . x . x . x . x . x . x . x .',
        'x . x . x . x . x . x . x . x .',
        'x . x . x . x . x . x . x . x .',
        'x . x . x . x . x . x . x . x x',
      ],
      gain: 0.75,
      pan: 0.18,
    },
    {
      voice: 'ride',
      layer: 'intensity',
      bars: [
        '. . x . . . x . . . x . . . x .',
        '. . x . . . x . . . x . . . x .',
        '. . x . . . x . . . x . . . x .',
        '. . x . . . x . . . x . . . x x',
      ],
      gain: 0.7,
      pan: -0.24,
    },
    {
      voice: 'crash',
      bars: ['x . . . . . . . . . . . . . . .', '. . . . . . . . . . . . . . . .', '. . . . . . . . . . . . . . . .', '. . . . . . . . . . . . . . . .'],
      gain: 0.8,
    },
    {
      voice: 'bassSq',
      bars: [
        'c2 . . . c2 . c3 . c2 . . . c2 . c3 .',
        'g2 . . . g2 . g3 . g2 . . . g2 . g3 .',
        'a2 . . . a2 . a3 . a2 . . . a2 . a3 .',
        'f2 . . . f2 . f3 . f2 . . . g2 . c3 .',
      ],
      gain: 1,
    },
    {
      voice: 'bassSq',
      layer: 'intensity',
      bars: [
        '. . c3 . . . c3 . . . c3 . . . c3 .',
        '. . g3 . . . g3 . . . g3 . . . g3 .',
        '. . a3 . . . a3 . . . a3 . . . a3 .',
        '. . f3 . . . f3 . . . g3 . . . c3 .',
      ],
      gain: 0.42,
      pan: -0.35,
    },
    {
      voice: 'lead',
      bars: [
        'c5 . e4 . g4 . e4 . c5 . . . g4 . e4 .',
        'b4 . d4 . g4 . d4 . b4 . . . d5 . . .',
        'a4 . c4 . e4 . c4 . a4 . . . e4 . g4 .',
        'f4 . a4 . c5 . a4 . f4 . . . g4 . a4 .',
      ],
      gain: 1,
    },
    {
      voice: 'lead2',
      layer: 'intensity',
      bars: [
        'a4 . c4 . e4 . c4 . a4 . . . e4 . c4 .',
        'g4 . b3 . e4 . b3 . g4 . . . b4 . . .',
        'f4 . a3 . c4 . a3 . f4 . . . c4 . e4 .',
        'd4 . f4 . a4 . f4 . d4 . . . e4 . f4 .',
      ],
      gain: 0.85,
      pan: 0.3,
    },
    {
      voice: 'stab',
      layer: 'intensity',
      bars: [
        '. . . . c4 . . . . . . . g3 . . .',
        '. . . . b3 . . . . . . . g3 . . .',
        '. . . . a3 . . . . . . . e3 . . .',
        '. . . . f3 . . . . . . . g3 . c4 .',
      ],
      gain: 0.9,
      pan: 0.1,
    },
  ],
};

const FINAL_LAP = {
  name: 'finalLap',
  title: 'Final Lap',
  bpm: 168,
  bars: 4,
  swing: 0,
  layers: [
    { id: 'base', gain: 1 },
    { id: 'intensity', gain: 0.85 },
  ],
  channels: [
    {
      voice: 'kick',
      bars: [
        'x . . . x . . . x . . . x . x .',
        'x . . . x . . . x . . . x . x .',
        'x . . . x . . . x . . . x . x .',
        'x . . . x . . . x . . . x . x x',
      ],
      gain: 1,
    },
    {
      voice: 'snare',
      bars: [
        '. . . . x . . . . . x . x . . .',
        '. . . . x . . . . . x . x . . .',
        '. . . . x . . . . . x . x . . .',
        '. . . . x . . . . . x . x . . x',
      ],
      gain: 0.92,
    },
    {
      voice: 'hat',
      bars: [
        'x x x x x x x x x x x x x x x x',
        'x x x x x x x x x x x x x x x x',
        'x x x x x x x x x x x x x x x x',
        'x x x x x x x x x x x x x x x x',
      ],
      gain: 0.6,
      pan: 0.2,
    },
    {
      voice: 'tom',
      bars: [
        '. . . . . . . . . . . . . . . .',
        '. . . . . . . . . . . . . . . .',
        '. . . . . . . . . . . . . . . .',
        '. . . . x . . . x . . . x . . .',
      ],
      gain: 0.7,
    },
    {
      voice: 'bassSaw',
      bars: [
        'a1 a1 a1 a1 e1 a1 a1 a1 a1 a1 a1 a1 e2 a1 a2 a1',
        'f1 f1 f1 f1 c2 f1 f1 f1 f1 f1 f1 f1 c2 f1 f2 f1',
        'c2 c2 c2 c2 g1 c2 c2 c2 c2 c2 c2 c2 g2 c2 c3 c2',
        'g1 g1 g1 g1 d2 g1 g1 g1 g1 g1 g1 g1 d2 g1 g2 g1',
      ],
      gain: 1,
    },
    {
      voice: 'lead',
      bars: [
        'a4 . a4 . c5 . a4 . e4 . a4 . c5 . e5 .',
        'f4 . f4 . a4 . f4 . c5 . f4 . a4 . c5 .',
        'e4 . e4 . g4 . e4 . c5 . e4 . g4 . c5 .',
        'g4 . g4 . b4 . g4 . d5 . g4 . b4 . d5 .',
      ],
      gain: 1,
      gate: 0.62,
    },
    {
      voice: 'lead2',
      layer: 'intensity',
      bars: [
        'f4 . f4 . a4 . f4 . c4 . f4 . a4 . c5 .',
        'd4 . d4 . f4 . d4 . a3 . d4 . f4 . a4 .',
        'c4 . c4 . e4 . c4 . a3 . c4 . e4 . a4 .',
        'e4 . e4 . g4 . e4 . b3 . e4 . g4 . b4 .',
      ],
      gain: 0.8,
      gate: 0.62,
      pan: -0.3,
    },
    {
      voice: 'harm',
      layer: 'intensity',
      bars: [
        'e3 . e3 . a3 . e3 . c4 . e3 . a3 . c5 .',
        'c3 . c3 . f3 . c3 . a3 . c3 . f3 . a4 .',
        'g3 . g3 . c4 . g3 . e4 . g3 . c4 . e5 .',
        'd4 . d4 . g4 . d4 . b4 . d4 . g4 . b5 .',
      ],
      gain: 0.55,
      gate: 0.7,
      pan: 0.34,
    },
  ],
};

export const TRACKS = { menu: MENU, race: RACE, finalLap: FINAL_LAP };

export function getMusicTrack(name) {
  if (typeof name !== 'string') return null;
  return TRACKS[name] || null;
}

export const MUSIC_TRACK_NAMES = Object.keys(TRACKS);

/* --------------------------------------------------------------- sequencer -- */

/** Splits a bar string into exactly STEPS_PER_BAR tokens, ignoring '|'. */
function barTokens(bar) {
  const raw = String(bar).split('|').join(' ').split(/\s+/).filter((s) => s.length > 0);
  const out = new Array(STEPS_PER_BAR).fill(null);
  for (let i = 0; i < STEPS_PER_BAR; i++) {
    const t = raw[i];
    if (!t || t === '.' || t === '-') continue;
    out[i] = t;
  }
  return out;
}

function compileChannel(spec, bars) {
  const stepBars = [];
  for (let b = 0; b < bars; b++) {
    const tokens = barTokens(spec.bars[b] != null ? spec.bars[b] : spec.bars[spec.bars.length - 1]);
    for (let i = 0; i < STEPS_PER_BAR; i++) stepBars.push(tokens[i]);
  }
  return {
    voice: spec.voice,
    layer: spec.layer || 'base',
    gain: spec.gain != null ? spec.gain : 1,
    pan: spec.pan || 0,
    gate: spec.gate,
    transpose: spec.transpose || 0,
    steps: stepBars,
  };
}

/**
 * Plays one compiled track. Owns its own gain/layer/delay nodes so the caller
 * can crossfade it against another sequencer by ramping `out.gain`.
 */
export class MusicSequencer {
  /**
   * @param {AudioContext} ac
   * @param {AudioNode} dest node the music bus is plugged into
   * @param {object} track entry from TRACKS
   * @param {{noise?: AudioBuffer}} [opts]
   */
  constructor(ac, dest, track, opts = {}) {
    this.ac = ac;
    this.track = track;
    this.name = track.name;
    this.bpm = track.bpm;
    this.noise = opts.noise || null;
    this.playing = false;
    this.disposed = false;
    this.volume = 1;
    this._live = [];

    this.out = ac.createGain();
    this.out.gain.value = 0.0001;
    this.out.connect(dest);

    // Short stereo-ish feedback delay used as a send by the melodic voices.
    const send = ac.createGain();
    send.gain.value = 1;
    const delay = ac.createDelay(1.0);
    delay.delayTime.value = 0.185;
    const fb = ac.createGain();
    fb.gain.value = 0.28;
    const damp = ac.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2100;
    send.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(this.out);
    this._sendBus = send;
    this._delayNodes = [send, delay, damp, fb];

    this.layers = new Map();
    for (const layer of track.layers || [{ id: 'base', gain: 1 }]) {
      const g = ac.createGain();
      g.gain.value = layer.gain != null ? layer.gain : 1;
      g.connect(this.out);
      this.layers.set(layer.id, g);
    }

    this._channels = track.channels.map((c) => compileChannel(c, track.bars));
    this._totalSteps = track.bars * STEPS_PER_BAR;
    this._stepDur = 60 / track.bpm / 4;
    this._swing = track.swing || 0;
    this._step = 0;
    this._nextTime = 0;
    this._stopTimer = 0;
  }

  /** Starts (or restarts) playback, fading in over `fade` seconds. */
  start(fade = 0.8) {
    if (this.disposed) return;
    const now = this.ac.currentTime;
    this._nextTime = now + 0.05;
    this._step = 0;
    this.playing = true;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(1, now + Math.max(0.02, fade));
  }

  /** Ramps a mix layer (e.g. 'intensity') towards `gain`. */
  setLayer(id, gain, seconds = 0.6) {
    const g = this.layers.get(id);
    if (!g) return;
    const now = this.ac.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(Math.max(0, gain), now + Math.max(0.02, seconds));
  }

  getLayer(id) {
    const g = this.layers.get(id);
    return g ? g.gain.value : 0;
  }

  /** Called every frame with any dt; only the audio clock matters. */
  update() {
    if (!this.playing || this.disposed) return;
    const ac = this.ac;
    const now = ac.currentTime;
    this._prune(now);
    if (this._nextTime < now - 0.3) this._nextTime = now + 0.02;
    const horizon = now + LOOKAHEAD;
    let guard = 0;
    while (this._nextTime < horizon && guard++ < 96) {
      this._scheduleStep(this._step, this._nextTime);
      this._step++;
      if (this._step >= this._totalSteps) this._step = 0;
      this._nextTime += this._stepDur;
    }
  }

  /** Re-anchors the schedule to the audio clock (after a suspend/resume). */
  resync() {
    if (!this.playing || this.disposed) return;
    this._nextTime = this.ac.currentTime + 0.05;
    this._live.length = 0;
  }

  _prune(now) {
    const live = this._live;
    let w = 0;
    for (let i = 0; i < live.length; i++) {
      if (live[i] > now) live[w++] = live[i];
    }
    live.length = w;
  }

  /**
   * Marks a voice as live until `endTime` (audio-clock seconds). The cap in
   * `_scheduleStep` reads this list, so the value must be the real end of the
   * note - a padded value would permanently exhaust the voice budget.
   */
  _reserve(endTime) {
    this._live.push(endTime);
  }

  _scheduleStep(step, time) {
    const swing = step % 2 === 1 ? this._swing * this._stepDur : 0;
    const when = time + swing;
    for (let i = 0; i < this._channels.length; i++) {
      const ch = this._channels[i];
      const token = ch.steps[step];
      if (!token) continue;
      if (this._live.length >= MAX_VOICES) return;
      if (VOICES[ch.voice]) this._playNote(ch, token, when);
      else if (DRUMS[ch.voice]) this._playDrum(ch, token, when);
    }
  }

  _playNote(ch, token, when) {
    const ac = this.ac;
    const inst = VOICES[ch.voice];
    const freq = noteToFreq(token);
    if (freq <= 0) return;
    const f = freq * Math.pow(2, ch.transpose / 12);
    const gate = (ch.gate != null ? ch.gate : inst.gate) * this._stepDur;
    const layer = this.layers.get(ch.layer);
    if (!layer) return;
    const peak = inst.gain * ch.gain;

    const amp = ac.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.linearRampToValueAtTime(peak, when + inst.attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + gate + 0.02);

    let node = amp;
    if (ch.pan !== 0 && ac.createStereoPanner) {
      const pan = ac.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, ch.pan));
      amp.connect(pan);
      node = pan;
    }
    node.connect(layer);
    if (inst.send > 0) {
      const s = ac.createGain();
      s.gain.value = inst.send;
      node.connect(s);
      s.connect(this._sendBus);
    }

    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = inst.q;
    lp.frequency.setValueAtTime(inst.cutoff, when);
    lp.frequency.exponentialRampToValueAtTime(Math.max(120, inst.cutoff * 0.55), when + gate + 0.02);
    lp.connect(amp);

    const osc = ac.createOscillator();
    osc.type = inst.wave;
    osc.detune.value = inst.detune;
    if (inst.glide > 0) osc.frequency.setValueAtTime(f * (1 + inst.glide), when);
    else osc.frequency.setValueAtTime(f, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f), when + 0.05);
    osc.connect(lp);

    const stopAt = when + gate + 0.06;
    try {
      osc.start(when);
      osc.stop(stopAt);
    } catch (err) {
      return;
    }
    osc.onended = () => {
      try {
        osc.disconnect();
        lp.disconnect();
        amp.disconnect();
        if (node !== amp) node.disconnect();
      } catch (e) {
        /* already torn down */
      }
    };
    this._reserve(when + gate + 0.08);
  }

  _playDrum(ch, token, when) {
    const ac = this.ac;
    const name = ch.voice;
    const d = DRUMS[name];
    if (!d) return;
    const layer = this.layers.get(ch.layer);
    if (!layer) return;
    const peak = d.gain * ch.gain;

    const amp = ac.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.linearRampToValueAtTime(peak, when + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + d.dur + 0.02);
    amp.connect(layer);

    const sources = [];
    let dur = d.dur;

    if (d.f0) {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(d.f0, when);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, d.f1), when + d.dur * 0.8);
      const shape = ac.createBiquadFilter();
      shape.type = 'lowpass';
      shape.frequency.value = 900;
      osc.connect(shape);
      shape.connect(amp);
      sources.push(osc);
      dur = Math.max(dur, d.dur);
    }
    if (d.tone) {
      const body = ac.createOscillator();
      body.type = 'triangle';
      body.frequency.setValueAtTime(d.tone, when);
      body.frequency.exponentialRampToValueAtTime(Math.max(60, d.tone * 0.6), when + d.dur * 0.7);
      const bg = ac.createGain();
      bg.gain.value = 0.5;
      body.connect(bg);
      bg.connect(amp);
      sources.push(body);
    }
    if (this.noise) {
      const src = ac.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const bp = ac.createBiquadFilter();
      if (d.freq) {
        bp.type = d.type;
        bp.frequency.value = d.freq;
        bp.Q.value = d.q || 0.8;
      } else {
        bp.type = 'bandpass';
        bp.frequency.value = d.noiseFreq;
        bp.Q.value = d.noiseQ;
      }
      const ng = ac.createGain();
      ng.gain.setValueAtTime(1, when);
      ng.gain.exponentialRampToValueAtTime(0.0001, when + (d.noiseDur || d.dur) + 0.02);
      src.connect(bp);
      bp.connect(ng);
      ng.connect(amp);
      sources.push(src);
      dur = Math.max(dur, d.noiseDur || d.dur);
    }
    if (!sources.length) return;

    const stopAt = when + dur + 0.06;
    for (const s of sources) {
      try {
        s.start(when);
        s.stop(stopAt);
      } catch (err) {
        /* an unscheduled start must never break the mix */
      }
    }
    const last = sources[sources.length - 1];
    last.onended = () => {
      try {
        for (const s of sources) s.disconnect();
        amp.disconnect();
      } catch (e) {
        /* already torn down */
      }
    };
    this._reserve(when + dur + 0.08);
  }

  /** Fades out over `fade` seconds and then tears itself down. */
  stop(fade = 0.8) {
    if (this.disposed) return;
    const now = this.ac.currentTime;
    this.playing = false;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0.0001, now + Math.max(0.02, fade));
    const self = this;
    clearTimeout(this._stopTimer);
    this._stopTimer = setTimeout(() => {
      self.dispose();
    }, Math.max(0.02, fade) * 1000 + 250);
  }

  dispose() {
    clearTimeout(this._stopTimer);
    this.playing = false;
    this.disposed = true;
    this._live.length = 0;
    try {
      this.out.disconnect();
      for (const g of this.layers.values()) g.disconnect();
      for (const n of this._delayNodes) n.disconnect();
    } catch (err) {
      /* context may already be closed */
    }
    this.layers.clear();
  }
}

export default MusicSequencer;
