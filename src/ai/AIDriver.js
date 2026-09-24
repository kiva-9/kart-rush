/**
 * AIDriver — a racing driver that plans a line, not a spline follower.
 *
 * Three layers, all of them precomputed once so the per-step cost stays tiny:
 *
 *   1. LINE (per track): a lateral offset per track sample that hugs the inside
 *      of corners in proportion to their curvature, smoothed into a smooth
 *      "in-out-in" shape so chicanes do not zig-zag.
 *   2. PROFILE (per kart): the cornering speed the kart can actually carry at
 *      every sample (sqrt(lateralAccel / curvature)), then made physically
 *      feasible with a forward pass (acceleration limits) and a backward pass
 *      (braking distance), so the driver brakes in time and accelerates out.
 *   3. RUNTIME: pure-pursuit steering toward a lookahead point on the line with
 *      a PD damp and per-driver reaction, throttle/brake against the profile,
 *      drift charging in sustained corners with a profitable exit, weighted
 *      avoidance of karts / hazards / dropped items, an item decision table,
 *      bounded rubber-banding, spinout + wrong-way recovery and a start boost.
 *
 * Allocation-light by construction: the returned DriveInput, every Frame and
 * every Vector3 is owned by the instance and reused, so 8 drivers stepping at
 * 120 Hz allocate nothing.
 */
import * as THREE from 'three';
import { CONFIG } from '../data/config.js';
import {
  clamp, damp, smoothstep, wrapProgress, progressDelta, deltaAngle, mulberry32,
} from '../core/MathUtils.js';

/** Fallback skill per store difficulty, when the integrator passes no skill. */
const DIFFICULTY_SKILL = { easy: 0.5, normal: 0.72, hard: 0.88, insane: 1 };

const STYLES = ['line', 'overtake', 'draft', 'reckless'];

/**
 * Internal tuning that has no home in CONFIG.ai. Named and documented so the
 * driving style stays readable next to the config it complements.
 */
const TUNE = {
  /** Curvature below which the road counts as straight again. */
  straightCurv: 0.005,
  /** Shortest same-direction corner that can still charge a mini-turbo, metres. */
  minDriftCorner: 22,
  /** Straight metres required after a corner before a drift pays off. */
  driftExitStraight: 16,
  /**
   * Radians of turning left in the corner when a slide may start. Lower bound
   * keeps the slide worth attempting; upper bound stops a slide that would
   * outlive the corner and rotate the kart off the road.
   */
  driftThetaMin: 0.42,
  driftThetaMax: 1.75,
  /** Hard ceiling on a single slide, seconds — enough for two tiers, no more. */
  driftMaxHold: 1.3,
  /** Travel-direction dot (vs the road) at which a slide is cut short. */
  driftSpinOut: -0.2,
  /** Hard cap on the forward search along the line, metres. */
  maxSearch: 170,
  /** Curvature that saturates the apex offset (1/46 ≈ a 46 m radius corner). */
  apexCurv: 1 / 46,
  /** Fraction of half width the racing line will use. */
  lineWidth: 0.6,
  /** Curvature smoothing window in samples (~1.2 m each). */
  curvWindow: 6,
  /** Moving-average passes that turn raw apex offsets into a smooth line. */
  lineSmoothPasses: 5,
  /** Deceleration assumed for the profile's backward pass, × brakeForce. */
  brakeFactor: 0.86,
  /** Acceleration assumed for the profile's forward pass, × accel. */
  accelFactor: 0.74,
  /** Lateral accel the driver dares in a corner: base + skill × slope. */
  latAccelBase: 14,
  latAccelSkill: 12,
  /** Avoidance: kart window, side window. */
  avoidKartRange: 34,
  avoidKartSide: 6,
  /** Avoidance: hazard window / side window. */
  avoidHazardSide: 5,
  /** How far below the road the kart must be to count as lost. */
  lostDepth: 8,
};

const EMPTY_DRIFT = { active: false, dir: 0, charge: 0, tier: 0, hop: false };

/** Scratch Frame shape TrackPath writes into when an `out` object is passed. */
function makeFrame() {
  return {
    index: 0,
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    bank: 0,
    width: 0,
    curvature: 0,
  };
}

export class AIDriver {
  /**
   * @param {{skill?:number, difficulty?:string, style?:string, seed?:number}} [opts]
   */
  constructor(opts) {
    const o = opts || {};
    this.difficulty = typeof o.difficulty === 'string' ? o.difficulty : 'normal';
    let skill = DIFFICULTY_SKILL[this.difficulty];
    if (typeof o.skill === 'number' && isFinite(o.skill)) skill = o.skill;
    if (skill == null) skill = CONFIG.ai.skillBase;
    this.skill = clamp(skill, 0.05, 1);
    this.style = STYLES.indexOf(o.style) >= 0 ? o.style : STYLES[0];
    this.seed = Number.isFinite(o.seed) ? o.seed >>> 0 : 0x1f2e3d4c;
    const rng = mulberry32(this.seed);
    this.rng = rng;

    // ---- personality: seven bots must not drive identically ---------------
    const s = this.skill;
    /** How tightly the line is followed (steering authority). */
    this.precision = clamp(0.5 + s * 0.55 + (rng() - 0.5) * 0.24, 0.2, 1.2);
    /** How hard rivals and the inside kerb are leaned on. */
    this.aggression = clamp(0.22 + s * 0.55 + (rng() - 0.5) * 0.34, 0.05, 1);
    /** Preferred side of the road, -1 (left) .. 1 (right). */
    this.lineBias = (rng() - 0.5) * 1.7;
    /** Reaction lag, seconds. */
    this.reaction = clamp(0.22 - s * 0.16 + rng() * 0.09, 0.02, 0.32);
    /** Appetite for mini-turbos, multiplies CONFIG.ai.driftChance. */
    this.driftLove = clamp(0.4 + s * 0.55 + (rng() - 0.5) * 0.32, 0.12, 1.1);
    /** Cornering courage, multiplies the speed profile. */
    this.courage = clamp(0.9 + s * 0.16 + (rng() - 0.5) * 0.12, 0.86, 1.07);
    /** Seconds between deliberate little mistakes. */
    this.mistakeGap = 6 + rng() * 10;
    /** Magnitude of a mistake's steering wobble. */
    this.mistakeSize = clamp((1 - s) * (0.22 + rng() * 0.4), 0, 0.45);
    /** Steer damping (PD term on the aim angle error). */
    this.steerDamp = clamp(0.03 - s * 0.012 + rng() * 0.01, 0.006, 0.05);
    /** Style multipliers over the avoidance push. */
    this.stylePush = this.style === 'draft' ? 0.6 : this.style === 'overtake' ? 1.15
      : this.style === 'reckless' ? 1.3 : 1;

    // ---- world / race state ------------------------------------------------
    /** @type {any[]} injected by setField() */
    this.karts = [];
    /** @type {any} TrackPath */
    this.track = null;
    /** @type {any} KartPopulated by the integrator. */
    this.kart = null;
    /** @type {any} ItemSystemPopulated by the integrator; used when present. */
    this.items = null;
    /** Minimum seconds between item uses (CONFIG.ai.itemCooldown). */
    this.itemCooldown = CONFIG.ai.itemCooldown;

    this._time = 0;
    this._itemTimer = 0;

    // ---- reusable state ----------------------------------------------------
    this._out = { throttle: 0, brake: 0, steer: 0, drift: false, driftPressed: false, item: false };
    this._frameA = makeFrame();
    this._frameC = makeFrame();
    this._aim = new THREE.Vector3();
    this._respawnPos = new THREE.Vector3();
    this._locOut = { progress: 0, lateral: 0, index: 0, surface: 'road' };
    this._loc = { progress: 0, lateral: 0, index: 0, surface: 'road' };
    this._basisOut = { fx: 0, fz: -1, rx: 1, rz: 0 };
    this._driveOut = { throttle: 0, brake: 0, steer: 0 };
    this._fieldOut = { ahead: null, behind: null, near: 0, myRank: 1, leaderGap: 0, straight: 0 };

    this._lineBuilt = false;
    this._N = 0;
    this._ds = 1.2;
    this._len = 0;
    this._halfWidth = 11;
    this._curv = null;
    this._line = null;
    this._driftOk = null;
    this._driftRun = null;
    this._hazards = null;
    this._pads = null;
    this._profile = null;
    this._profileTop = -1;

    this._steer = 0;
    this._prevAlpha = 0;
    this._prevX = 0;
    this._prevZ = 0;
    this._hasPrev = false;
    this._tvx = 0;
    this._tvz = -1;
    this._hasTravel = false;
    this._backDot = 1;
    this._headDot = 1;
    this._driftLock = 0;
    this._driftSince = -100;
    this._driftEnd = -100;
    this._recoverSince = -1;
    this._wrongTime = 0;
    this._wantTier = 1;
    this._turning = false;
    this._driftAppetite = clamp(CONFIG.ai.driftChance * this.driftLove, 0.05, 1);
    // Per-driver drift taste: bolder drivers commit to tighter, longer slides.
    // The threshold is deliberately high — on a 22 m wide road a committed drift
    // has a ~17 m path radius, so it only pays in genuinely tight corners.
    this.driftCurv = clamp(0.017 - 0.005 * this.aggression, 0.0132, 0.02);
    this.driftInto = [0.3 + 0.18 * this.aggression, 0.68 + 0.12 * this.aggression];

    this._go = false;
    this._preTime = 0;
    this._cdSeen = false;
    this._boosted = false;
    this._busTried = false;
    this._off = null;
    this._disposed = false;

    this._mistakeTimer = 0;
    this._mistakeCd = 1 + rng() * 3;
    this._mistakeSign = 1;

    this._badTime = 0;
    this._stuckTime = 0;
  }

  // ------------------------------------------------------------------ field

  /**
   * Called once by the integrator (and guarded when it is not called at all).
   * @param {any[]} karts every kart in the race
   * @param {any} track TrackPath
   */
  setField(karts, track) {
    if (Array.isArray(karts)) this.karts = karts;
    else if (karts && Array.isArray(karts.karts)) this.karts = karts.karts;
    if (track && typeof track === 'object' && typeof track.locate === 'function') this.track = track;
    else if (track && typeof track === 'object' && typeof track.frameAt === 'function') this.track = track;
    this._invalidate();
    // The line, the drift map and the hazard list are one-shot precomputes, so
    // build them here rather than waiting for the first sample.
    this._ensure(null, null);
  }

  _invalidate() {
    this._lineBuilt = false;
    this._profile = null;
    this._profileTop = -1;
    this._hazards = null;
    this._pads = null;
  }

  /** Picks the track up from wherever it can be found, and builds the line. */
  _ensure(kart, ctx) {
    if (!this.track) {
      const t = (kart && kart.physics && kart.physics.track) ||
        (ctx && ctx.track) ||
        (ctx && ctx.race && ctx.race.track) ||
        (ctx && ctx.builder && ctx.builder.track) || null;
      if (t && typeof t.locate === 'function') {
        this.track = t;
        this._invalidate();
      }
    }
    if (this.track && !this._lineBuilt) this._buildLine();
    if (this.track && this._hazards === null) this._buildWorldFeatures();
  }

  /**
   * Listens for the countdown and the GO so the start-line timing comes from
   * the race layer instead of guesswork. The bus is the only reliable source:
   * `ctx.race` is not part of the game context the kart hands its controller.
   */
  _subscribeBus(ctx) {
    if (this._busTried) return;
    this._busTried = true;
    const bus = ctx && ctx.bus;
    if (!bus || typeof bus.on !== 'function') return;
    try {
      const a = bus.on('race:go', () => { this._go = true; });
      const b = bus.on('race:countdown', () => { this._cdSeen = true; this._preSeen = true; });
      const self = this;
      this._off = () => {
        if (typeof a === 'function') a();
        if (typeof b === 'function') b();
        self._off = null;
      };
    } catch (err) {
      this._off = null;
    }
  }

  // ------------------------------------------------------------------ build

  /** Scratch frame read through whichever track API is available. */
  _frameAt(i, out) {
    const track = this.track;
    if (!track) return out;
    if (typeof track.sampleFrameAt === 'function') {
      try {
        const f = track.sampleFrameAt(i, out);
        return f && f.position ? f : out;
      } catch (err) { /* fall through to frameAt */ }
    }
    if (typeof track.frameAt === 'function') {
      try {
        const N = this._N || 1;
        const f = track.frameAt(i / N, out);
        return f && f.position ? f : out;
      } catch (err) { /* ignore */ }
    }
    return out;
  }

  /** Precomputes the racing line, the drift map and the world feature lists. */
  _buildLine() {
    const track = this.track;
    if (!track) return;
    let N = Math.floor(track.sampleCount || 0);
    if (!(N >= 16)) N = Math.round((track.length || 1200) / 1.2);
    if (!(N >= 16)) N = 900;
    const len = Number.isFinite(track.length) && track.length > 20 ? track.length : N * 1.2;
    this._N = N;
    this._len = len;
    this._ds = len / N;

    const raw = new Float32Array(N);
    const wid = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const f = this._frameAt(i, this._frameA);
      const c = f.curvature;
      raw[i] = typeof c === 'number' && isFinite(c) ? c : 0;
      const w = f.width;
      wid[i] = typeof w === 'number' && isFinite(w) && w > 1 ? w : (track.width || 11);
    }
    let sum = 0;
    for (let i = 0; i < N; i++) sum += wid[i];
    // Frame.width is already the HALF width of the tarmac.
    this._halfWidth = clamp(sum / N, 3, 30);

    // Smoothed curvature: the line must not react to a single noisy sample.
    const K = TUNE.curvWindow;
    const curv = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let a = 0;
      for (let k = -K; k <= K; k++) a += raw[(i + k + N * 2) % N];
      curv[i] = a / (2 * K + 1);
    }
    this._curv = curv;

    // Apex offsets: inside of the corner, proportional to the curvature.
    const maxOff = this._halfWidth * (TUNE.lineWidth + 0.12 * this.aggression);
    const off = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const c = curv[i];
      const t = clamp(Math.abs(c) / TUNE.apexCurv, 0, 1);
      const mag = smoothstep(t) * maxOff;
      // curvature > 0 means the heading increases, i.e. a LEFT turn, and the
      // inside of a left turn is negative lateral (lateral is + to the right).
      let v = c > 0 ? -mag : c < 0 ? mag : 0;
      v += this.lineBias * maxOff * 0.2;
      off[i] = v;
    }
    const tmp = new Float32Array(N);
    for (let pass = 0; pass < TUNE.lineSmoothPasses; pass++) {
      for (let i = 0; i < N; i++) {
        tmp[i] = 0.25 * off[(i - 1 + N) % N] + 0.5 * off[i] + 0.25 * off[(i + 1) % N];
      }
      off.set(tmp);
    }
    const lim = this._halfWidth * 0.8;
    for (let i = 0; i < N; i++) off[i] = clamp(off[i], -lim, lim);
    this._line = off;

    this._buildDriftMap();
    this._buildThetaLeft();
    this._lineBuilt = true;
    this._profile = null;
    this._profileTop = -1;
  }

  /**
   * Marks every sample inside a corner that is worth sliding through. A corner
   * qualifies on its peak curvature (so a long sweeper still counts even where
   * its own curvature dips), its length, and the straight that follows it.
   */
  _buildDriftMap() {
    const N = this._N;
    const ds = this._ds;
    const curv = this._curv;
    const ok = new Uint8Array(N);
    const run = new Float32Array(N);
    const maxSteps = Math.max(8, Math.floor(TUNE.maxSearch / ds));
    let i = 0;
    while (i < N) {
      if (Math.abs(curv[i]) < TUNE.straightCurv) { i++; continue; }
      const dir = curv[i] > 0 ? 1 : -1;
      // Grow the corner: consistent direction, and it ends when the road
      // straightens out (or the search budget runs out).
      let k = 0;
      let peak = 0;
      while (k < maxSteps) {
        const v = curv[(i + k) % N];
        if (Math.abs(v) < TUNE.straightCurv || v * dir <= 0) break;
        if (Math.abs(v) > peak) peak = Math.abs(v);
        k++;
      }
      let after = 0;
      for (let m = 0; m < maxSteps; m++) {
        if (Math.abs(curv[(i + k + m) % N]) >= TUNE.straightCurv) break;
        after += ds;
      }
      if (peak >= this.driftCurv && k * ds >= TUNE.minDriftCorner &&
        after >= TUNE.driftExitStraight) {
        // One roll per corner: a driver either commits to it or it does not.
        const value = this.rng();
        for (let m = 0; m < k; m++) {
          ok[(i + m) % N] = 1;
          run[(i + m) % N] = value;
        }
      }
      i += Math.max(1, k);
    }
    this._driftOk = ok;
    this._driftRun = run;
  }

  /**
   * Heading still to be turned at every sample: the integral of curvature from
   * here to the end of the corner, in radians. This is what the drift logic
   * times a slide against — a slide rotates ~1.9 rad/s, so it only pays while
   * the road still has a comparable amount of turning left to give.
   */
  _buildThetaLeft() {
    const N = this._N;
    const curv = this._curv;
    const ds = this._ds;
    const out = new Float32Array(N);
    // Walked backwards so out[i+1] is already known when i is folded in.
    for (let k = 1; k <= N; k++) {
      const i = (N - k) % N;
      const c = curv[i];
      if (Math.abs(c) < TUNE.straightCurv) { out[i] = 0; continue; }
      const nxt = (i + 1) % N;
      const same = Math.abs(curv[nxt]) >= TUNE.straightCurv && curv[nxt] * c > 0;
      out[i] = Math.abs(c) * ds + (same ? out[nxt] : 0);
    }
    this._thetaLeft = out;
  }

  /** Feasible speed at every sample: corner limit + braking + accel passes. */
  _buildProfile(top) {
    const N = this._N;
    const ds = this._ds;
    const curv = this._curv;
    if (!curv || N < 16) return;
    const v = new Float32Array(N);
    const latAccel = TUNE.latAccelBase + TUNE.latAccelSkill * this.skill;
    for (let i = 0; i < N; i++) {
      const c = Math.abs(curv[i]);
      let t = top;
      if (c > 1e-5) t = Math.min(top, Math.sqrt(latAccel / c));
      v[i] = t;
    }
    const brake = CONFIG.physics.brakeForce * TUNE.brakeFactor;
    const accel = CONFIG.physics.accel * TUNE.accelFactor;
    // Two laps of passes so the closed loop converges across the seam.
    for (let lap = 0; lap < 2; lap++) {
      for (let k = 1; k <= N; k++) {
        const i = (N - k) % N;
        const prev = (i - 1 + N) % N;
        const maxv = Math.sqrt(v[prev] * v[prev] + 2 * brake * ds);
        if (v[i] > maxv) v[i] = maxv;
      }
      for (let k = 0; k < N; k++) {
        const next = (k + 1) % N;
        const maxv = Math.sqrt(v[next] * v[next] + 2 * accel * ds);
        if (v[k] > maxv) v[k] = maxv;
      }
    }
    this._profile = v;
    this._profileTop = top;
  }

  /** Converts def hazards / boost pads into world positions once. */
  _buildWorldFeatures() {
    const track = this.track;
    const def = (track && track.def) || {};
    const hazards = [];
    const pads = [];
    const push = (list, out, withWidth) => {
      if (!Array.isArray(list)) return;
      if (typeof track.positionAt !== 'function') return;
      for (let i = 0; i < list.length; i++) {
        const h = list[i];
        if (!h) continue;
        const p = +h.p;
        const lat = +h.lateral;
        if (!isFinite(p) || !isFinite(lat)) continue;
        const prog = wrapProgress(p);
        const v = track.positionAt(prog, lat, this._frameA.position);
        const entry = { p: prog, lat, x: v.x, z: v.z, type: h.type || 'banana' };
        if (withWidth) entry.width = +(h.width || 4) || 4;
        out.push(entry);
      }
    };
    push(def.hazards, hazards, false);
    if (Array.isArray(track.hazards)) push(track.hazards, hazards, false);
    push(def.boostPads, pads, true);
    if (Array.isArray(track.boostPads)) push(track.boostPads, pads, true);
    this._hazards = hazards;
    this._pads = pads;
  }

  // ------------------------------------------------------------------ sample

  /** @returns {{throttle:number,brake:number,steer:number,drift:boolean,driftPressed:boolean,item:boolean}} */
  sample(dt, kart, ctx) {
    const out = this._out;
    out.throttle = 0;
    out.brake = 0;
    out.steer = 0;
    out.drift = false;
    out.driftPressed = false;
    out.item = false;
    if (this._disposed || !kart) return out;
    if (!(dt > 0)) dt = 1 / 120;
    if (dt > 0.1) dt = 0.1;
    this._time += dt;
    this._itemTimer = Math.max(0, this._itemTimer - dt);
    this._driftLock = Math.max(0, this._driftLock - dt);
    this._mistakeTimer = Math.max(0, this._mistakeTimer - dt);
    this.kart = kart;
    this._subscribeBus(ctx);
    this._ensure(kart, ctx);

    const track = this.track;
    const phys = kart.physics || {};
    // _topSpeed() also (re)builds the speed profile on the first call.
    const top = this._topSpeed(phys);
    if (!track || !this._profile) {
      // No track to read: keep the engine lit so the kart is never a roadblock.
      out.throttle = 1;
      return out;
    }
    const loc = this._locate(kart, phys, track);
    const prog = loc.progress;
    const lateral = loc.lateral;
    const surface = loc.surface;
    const speed = typeof phys.speed === 'number' && isFinite(phys.speed) ? phys.speed : 0;
    const idx = this._index(prog);
    const speedFrac = clamp(Math.abs(speed) / Math.max(6, top), 0, 1);

    // ---- start line ---------------------------------------------------------
    this._phase(dt, kart, ctx, speed);

    // ---- where is this kart actually pointing? ------------------------------
    this._updateTravel(kart, phys, track, idx, dt);
    const stopped = Math.abs(speed) < 1.2;
    // A committed slide legitimately rotates the kart a long way, so only a kart
    // that is not drifting may count as "going backwards" — and one that has just
    // let a slide go gets a moment for the steering to square it back up instead
    // of being told to reverse, which reads as a spin-out of the AI's own making.
    const sliding = !!(phys.drift && phys.drift.active);
    const settling = this._time - this._driftEnd < 1.0;
    const backwards = !sliding && !settling &&
      (this._backDot < -0.12 || (stopped && this._headDot < -0.1));
    if (!backwards) this._recoverSince = -1;
    // A kart that has been travelling backwards for seconds is wedged, not
    // recovering: put it back on the road rather than let it grind along the
    // barrier for the rest of the lap.
    if (this._go) {
      // Decays rather than resets, so a kart that flickers in and out of facing
      // the wrong way (scraping a barrier, say) still adds up to a rescue.
      this._wrongTime = backwards ? this._wrongTime + dt : Math.max(0, this._wrongTime - dt * 0.7);
      if (this._wrongTime > 2.5) {
        this._wrongTime = 0;
        this._respawn(kart, phys, track, prog);
        this._backDot = 1;
        this._headDot = 1;
      }
    }
    const spinning = !!(phys.spinout && phys.spinout.timer > 0);
    const wasSliding = sliding;

    // ---- deliberate imperfection -------------------------------------------
    this._mistakeCd -= dt;
    if (this._mistakeCd <= 0) {
      this._mistakeCd = Math.max(2, this.mistakeGap) * (0.4 + this.rng() * 1.2);
      this._mistakeSign = this.rng() < 0.5 ? -1 : 1;
      this._mistakeTimer = 0.22 + this.rng() * 0.5;
    }
    const mistake = this._mistakeTimer > 0 ? this._mistakeSign * this.mistakeSize : 0;

    // ---- is the kart lost? --------------------------------------------------
    this._checkStranded(dt, kart, phys, track, loc, speed);

    let throttle;
    let brake;
    let steer;
    let wantDrift = false;

    if (spinning) {
      // Out of control: aim back at the line and wait it out.
      steer = this._steerToAim(kart, phys, track, prog, lateral, speed, top, 0);
      throttle = 0;
      brake = 0;
    } else if (backwards) {
      const r = this._recover(kart, phys, track, prog, lateral, speed, dt);
      throttle = r.throttle;
      brake = r.brake;
      steer = r.steer;
    } else {
      // ---- speed target ----------------------------------------------------
      let target = this._profile[idx] * this.courage;
      if (surface === 'off') target = Math.min(target, top * 0.5);
      else if (surface === 'curb') target = Math.min(target, top * 0.98);
      target *= 0.96 + 0.05 * this.precision;
      target += this._rubber(kart, top);
      target = Math.max(4, Math.min(target, top * 1.12));

      const diff = target - speed;
      if (surface === 'off') {
        // Off the tarmac: ease back on rather than stand on the anchors.
        throttle = clamp((top * 0.45 - speed) * 0.3 + 0.3, 0.2, 0.7);
        brake = 0;
      } else if (diff < -0.6) {
        const over = -diff;
        brake = clamp(over * 0.4, 0.16, 1);
        throttle = 0;
      } else if (diff > 0.8) {
        throttle = 1;
        brake = 0;
      } else {
        throttle = clamp(diff * 0.85 + 0.3, 0.25, 1);
        brake = 0;
      }

      // ---- steering --------------------------------------------------------
      steer = this._steerToAim(kart, phys, track, prog, lateral, speed, top, mistake);

      // ---- drift -----------------------------------------------------------
      wantDrift = this._driftDecision(kart, phys, prog, idx, lateral, speed, this._steer, dt);
    }

    out.throttle = clamp(throttle, 0, 1);
    out.brake = clamp(brake, 0, 1);
    out.steer = clamp(steer, -1, 1);
    out.drift = wantDrift;
    out.driftPressed = wantDrift && !(phys.drift && phys.drift.active) &&
      this._driftLock <= 0 && Math.abs(this._steer) > 0.2;
    if (wasSliding && !wantDrift) this._driftEnd = this._time;

    // ---- items --------------------------------------------------------------
    if (this._useItem(kart, phys, prog, speed, top, surface)) out.item = true;

    // ---- start line hold ----------------------------------------------------
    if (!this._go) {
      out.throttle = 0;
      out.brake = 0;
      out.drift = false;
      out.driftPressed = false;
      out.item = false;
    }
    return out;
  }

  /** Called by the ItemSystem when this driver's item finally goes off. */
  onItemUsed(kart, itemId) {
    this._itemTimer = this.itemCooldown;
  }

  dispose() {
    this._disposed = true;
    if (typeof this._off === 'function') { this._off(); }
    this._off = null;
    this.karts = [];
    this.kart = null;
    this.items = null;
    this.track = null;
    this._profile = null;
    this._line = null;
    this._curv = null;
    this._driftOk = null;
    this._hazards = null;
  }

  // ------------------------------------------------------------- internals

  _index(prog) {
    const N = this._N;
    let i = Math.floor(prog * N);
    i %= N;
    if (i < 0) i += N;
    return i;
  }

  _sampleLine(prog) {
    return this._line ? this._line[this._index(prog)] : 0;
  }

  /** Prefers the physics' own track sample, falling back to a live locate(). */
  _locate(kart, phys, track) {
    const o = this._loc;
    if (phys._hasTrack !== false &&
      typeof phys.progress === 'number' && isFinite(phys.progress) &&
      typeof phys.lateralValue === 'number' && isFinite(phys.lateralValue)) {
      o.progress = phys.progress;
      o.lateral = phys.lateralValue;
      o.index = typeof phys.index === 'number' ? phys.index : 0;
      o.surface = phys.surface || 'road';
      return o;
    }
    const p = kart.position;
    o.progress = 0;
    o.lateral = 0;
    o.index = 0;
    o.surface = 'road';
    if (!p || typeof p.x !== 'number') return o;
    const r = track.locate(p.x, p.y || 0, p.z, this._locOut);
    if (r && typeof r.progress === 'number' && isFinite(r.progress)) {
      o.progress = r.progress;
      o.lateral = typeof r.lateral === 'number' ? r.lateral : 0;
      o.index = typeof r.index === 'number' ? r.index : 0;
      o.surface = r.surface || 'road';
    }
    return o;
  }

  _yaw(kart, phys) {
    if (phys && typeof phys.yaw === 'number') return phys.yaw;
    if (typeof kart.yaw === 'number') return kart.yaw;
    const g = kart.group;
    if (g && g.rotation && typeof g.rotation.y === 'number') return g.rotation.y;
    return 0;
  }

  /** Baseline top speed of the kart (surface / boost excluded on purpose). */
  _baseTop(phys) {
    const d = phys && phys.def;
    if (d && typeof d.topSpeed === 'number' && isFinite(d.topSpeed) && d.topSpeed > 4) return d.topSpeed;
    if (phys && typeof phys.effectiveTopSpeed === 'function') {
      try {
        const v = phys.effectiveTopSpeed();
        if (typeof v === 'number' && isFinite(v) && v > 4) return v;
      } catch (err) { /* ignore */ }
    }
    return CONFIG.physics.topSpeed;
  }

  /** Live top speed, used for throttle/brake comparisons. */
  _topSpeed(phys) {
    let t = this._baseTop(phys);
    if (phys && typeof phys.effectiveTopSpeed === 'function') {
      try {
        const v = phys.effectiveTopSpeed();
        if (typeof v === 'number' && isFinite(v) && v > 4) t = v;
      } catch (err) { /* keep the baseline */ }
    }
    if (!this._profile || this._profileTop < 0 ||
      Math.abs(t - this._profileTop) > this._profileTop * 0.06) {
      this._buildProfile(t);
    }
    return t;
  }

  /**
   * Start-line phase. The grid is only held once something trustworthy says a
   * countdown is running (the race layer, the store, or the GO event); without
   * that the driver waits out one countdown's worth of time and then joins in,
   * so a missing signal costs a second instead of the whole race.
   */
  _phase(dt, kart, ctx, speed) {
    if (this._go) return true;
    if (!this._preSeen) {
      const p = ctx && ctx.race;
      const st = ctx && ctx.store ? ctx.store.state : null;
      this._preSeen = this._cdSeen ||
        (p && typeof p.phase === 'string' && p.phase === 'countdown') ||
        (st && typeof st.mode === 'string' && st.mode === 'countdown') ||
        (p && typeof p.countdownMs === 'number' && p.countdownMs > 0);
    }
    const started = (ctx && ctx.race && typeof ctx.race.phase === 'string' &&
      ctx.race.phase !== 'countdown') ||
      (typeof kart.lap === 'number' && kart.lap >= 1) ||
      Math.abs(speed) > 0.7;
    if (started) {
      this._go = true;
      this._launchBoost(kart);
      return true;
    }
    this._preTime += dt;
    if (this._preTime > CONFIG.race.countdown + 1.0) {
      this._go = true;
      this._launchBoost(kart);
      return true;
    }
    return false;
  }

  _launchBoost(kart) {
    if (this._boosted) return;
    this._boosted = true;
    // Skill decides the hit rate, not whether a boost exists at all.
    if (this.rng() > 0.3 + 0.65 * this.skill) return;
    const k = kart || this.kart;
    const b = CONFIG.physics.boost.startBoost;
    if (k && typeof k.applyBoost === 'function' && b) {
      try {
        k.applyBoost('startBoost', b.duration, b.multiplier);
      } catch (err) { /* a kart without a boost path simply starts clean */ }
    }
  }

  /** Travel direction, used to notice the kart is going backwards. */
  _updateTravel(kart, phys, track, idx, dt) {
    let x = 0;
    let z = 0;
    const v = phys.velocity;
    if (v && typeof v.x === 'number' && typeof v.z === 'number' &&
      v.x * v.x + v.z * v.z > 0.06) {
      x = v.x;
      z = v.z;
    } else {
      const p = kart.position;
      if (p && typeof p.x === 'number') {
        if (this._hasPrev) {
          const dx = p.x - this._prevX;
          const dz = p.z - this._prevZ;
          if (dx * dx + dz * dz > 4e-6) { x = dx; z = dz; }
        } else {
          this._hasPrev = true;
        }
      }
    }
    const p2 = kart.position;
    if (p2 && typeof p2.x === 'number') {
      this._prevX = p2.x;
      this._prevZ = p2.z;
    }
    const f = this._frameAt(idx, this._frameC);
    const tx = f.tangent.x;
    const tz = f.tangent.z;
    const tl = Math.hypot(tx, tz) || 1;
    if (x !== 0 || z !== 0) {
      const d = Math.hypot(x, z);
      const ux = x / d;
      const uz = z / d;
      this._tvx = ux;
      this._tvz = uz;
      this._hasTravel = true;
      const dot = ux * (tx / tl) + uz * (tz / tl);
      this._backDot = damp(this._backDot, dot, 7, dt);
    }
    // Where the nose points against the road, for the "stopped facing backwards"
    // case a parked kart can get itself into.
    const fx = -Math.sin(this._yaw(kart, phys));
    const fz = -Math.cos(this._yaw(kart, phys));
    this._headDot = fx * (tx / tl) + fz * (tz / tl);
  }

  /**
   * Forward / right basis for steering. Normally the kart's own heading, but
   * when the nose disagrees badly with where the kart is actually going (a
   * heavy slide, a wall scrape, a respawn) the direction of travel is the
   * honest basis — a driver steers where the kart is going, not where it points.
   */
  _basis(kart, phys) {
    const b = this._basisOut;
    const yaw = this._yaw(kart, phys);
    let fx = -Math.sin(yaw);
    let fz = -Math.cos(yaw);
    if (this._hasTravel) {
      const agree = fx * this._tvx + fz * this._tvz;
      if (agree < 0.5) {
        fx = this._tvx;
        fz = this._tvz;
      }
    }
    b.fx = fx;
    b.fz = fz;
    b.rx = -fz;
    b.rz = fx;
    return b;
  }

  /** Metres of corner (inside=true) or straight (inside=false) ahead. */
  _run(prog, inside) {
    const curv = this._curv;
    const N = this._N;
    const ds = this._ds;
    const i0 = this._index(prog);
    const dir = curv[i0] > 0 ? 1 : -1;
    const max = Math.min(N, Math.max(4, Math.floor(TUNE.maxSearch / ds)));
    let m = 0;
    for (let k = 1; k <= max; k++) {
      const v = curv[(i0 + k) % N];
      const corner = Math.abs(v) >= TUNE.straightCurv && (!inside || v * dir > 0);
      if (inside ? !corner : corner) break;
      m += ds;
    }
    return m;
  }

  /**
   * Weighted avoidance of karts, hazards and dropped items, plus a small pull
   * toward the boost pads. Everything is resolved into a *desired lateral*, then
   * returned as the offset that has to be added to the racing line to reach it —
   * so a big, close obstacle genuinely moves the aim instead of nibbling at it.
   */
  _avoidance(kart, phys, track, prog, speed, lateral) {
    const karts = this.karts;
    const p = kart.position;
    if (!p || typeof p.x !== 'number') return 0;
    const basis = this._basis(kart, phys);
    const fx = basis.fx;
    const fz = basis.fz;
    const rx = basis.rx;
    const rz = basis.rz;
    const lim = this._halfWidth * 0.82;

    let want = 0;
    let weight = 0;

    // ---- other karts: aim for the side with room, weighted by urgency --------
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (!o || o === kart) continue;
      const q = o.position;
      if (!q || typeof q.x !== 'number') continue;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < 0.5 || ahead > TUNE.avoidKartRange) continue;
      const side = dx * rx + dz * rz;
      if (side > TUNE.avoidKartSide || side < -TUNE.avoidKartSide) continue;
      const range = 1 - clamp(ahead / TUNE.avoidKartRange, 0, 1);
      const near = 1 - clamp(Math.abs(side) / TUNE.avoidKartSide, 0, 1);
      let w = range * near * (0.55 + 0.65 * this.aggression) * this.stylePush;
      const op = o.physics;
      const os = op && typeof op.speed === 'number' ? op.speed : 0;
      // A slower kart is worth the effort of going round.
      if (os < speed - 1.5) w *= 1.35;
      if (ahead < 8 && Math.abs(side) < 2.8) w *= 1.7;
      const dir = side >= 0 ? -1 : 1;   // pass on the side we are already nearer
      const clear = 1.5 + 2.4 * (0.5 + 0.5 * this.aggression);
      want += clamp(side + dir * clear, -lim, lim) * w;
      weight += w;
    }

    // ---- hazards on the track: go round them ---------------------------------
    const hazards = this._hazards;
    if (hazards && hazards.length) {
      const reach = Math.max(14, CONFIG.ai.lookahead * 1.7);
      for (let i = 0; i < hazards.length; i++) {
        const h = hazards[i];
        const metres = progressDelta(prog, h.p) * this._len;
        if (metres < 1 || metres > reach) continue;
        const dx = h.x - p.x;
        const dz = h.z - p.z;
        const ahead = dx * fx + dz * fz;
        if (ahead < 0.5) continue;
        const side = dx * rx + dz * rz;
        if (side > TUNE.avoidHazardSide || side < -TUNE.avoidHazardSide) continue;
        const w = (1 - clamp(ahead / reach, 0, 1)) *
          (1 - clamp(Math.abs(side) / TUNE.avoidHazardSide, 0, 1)) *
          (CONFIG.ai.avoidChance > 0.5 ? 1 : 0.4);
        // Step away from the hazard, but never into the wall to do it.
        const dir = (h.lat - lateral) >= 0 ? -1 : 1;
        want += clamp(h.lat + dir * 3.6, -lim, lim) * w;
        weight += w;
      }
    }

    // ---- dropped items and shells in flight ---------------------------------
    const items = this.items;
    if (items && Array.isArray(items.entities)) {
      const list = items.entities;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || e === kart) continue;
        const owner = e.ownerId === kart.id ? kart : null;
        if (owner === kart) continue;
        const q = e.position;
        if (!q || typeof q.x !== 'number') continue;
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const ahead = dx * fx + dz * fz;
        if (ahead < 0.5 || ahead > 22) continue;
        const side = dx * rx + dz * rz;
        if (side > 4 || side < -4) continue;
        const w = (1 - clamp(ahead / 22, 0, 1)) * (1 - clamp(Math.abs(side) / 4, 0, 1));
        const dir = side >= 0 ? -1 : 1;
        want += clamp(side + dir * 3.2, -lim, lim) * w;
        weight += w;
      }
    }

    // ---- boost pads are worth a small aim ----------------------------------
    const pads = this._pads;
    if (pads && pads.length) {
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        const metres = progressDelta(prog, pad.p) * this._len;
        if (metres < 2 || metres > 30) continue;
        const delta = clamp(pad.lat - this._sampleLine(prog), -pad.width, pad.width);
        if (Math.abs(delta) > 0.05) {
          const pull = 0.55 * (1 - clamp(metres / 30, 0, 1));
          want += clamp(pad.lat, -lim, lim) * pull;
          weight += pull;
        }
        break;
      }
    }

    if (weight <= 0.0001) return 0;
    const desired = want / weight;
    const strength = clamp(weight, 0, 1);
    return (desired - this._sampleLine(prog)) * strength;
  }

  /** Pure-pursuit steering toward a lookahead point on the racing line. */
  _steerToAim(kart, phys, track, prog, lateral, speed, top, mistake) {
    const p = kart.position;
    const b = this._basis(kart, phys);
    const speedFrac = clamp(Math.abs(speed) / Math.max(6, top), 0, 1);
    // Lookahead grows with speed so fast corners are smoothed, not chased.
    const look = CONFIG.ai.lookahead * (0.55 + 0.8 * speedFrac) * (0.55 + 0.45 * this.precision);
    const aimProg = track.advance ? track.advance(prog, look) : prog + look / Math.max(1, this._len);
    let aimLat = this._sampleLine(aimProg) + this._avoidance(kart, phys, track, prog, speed, lateral);
    // A pull back toward the line when the kart has wandered off into the scenery.
    const room = this._halfWidth * 0.55;
    if (Math.abs(lateral) > room) {
      const over = clamp((Math.abs(lateral) - room) / Math.max(1, this._halfWidth * 0.45), 0, 1);
      aimLat -= Math.sign(lateral) * over * this._halfWidth * 0.5;
    }
    const lim = this._halfWidth * 0.92;
    aimLat = clamp(aimLat, -lim, lim);
    track.positionAt(aimProg, aimLat, this._aim);

    if (!p || typeof p.x !== 'number') return 0;
    const dx = this._aim.x - p.x;
    const dz = this._aim.z - p.z;
    const fx = b.fx;
    const fz = b.fz;
    const side = -fz * dx + fx * dz;   // > 0: the aim is to our right
    const along = fx * dx + fz * dz;
    const alpha = Math.atan2(side, along);

    const dr = phys.drift || EMPTY_DRIFT;
    const cap = Math.max(0.5, CONFIG.physics.turn.max * (1 - 0.32 * speedFrac)) *
      (dr.active ? 1.25 : 1);
    // Pure pursuit toward the aim point...
    let s = (2 * Math.abs(speed) * Math.sin(alpha)) / Math.max(4, look) / cap;
    // ...plus a cross-track term on the lateral error, which is what keeps the
    // line honest when the heading basis is unreliable (slide, spin, spawn).
    const cross = clamp((lateral - aimLat) / Math.max(6, look), -1, 1);
    s -= cross * (0.8 + 0.5 * this.precision);
    if (dr.active && dr.dir !== 0) {
      // Committed drift: hold the corner with the stick, because the charge only
      // builds while the kart is steered into the slide. The window is wide
      // enough to counter-steer (which widens the arc) and capped so a long slide
      // cannot rotate the kart past the exit.
      const lo = this.driftInto[0];
      const hi = this.driftInto[1];
      if (dr.dir > 0) s = clamp(Math.max(s, lo), lo, Math.max(lo, hi));
      else s = clamp(Math.min(s, -lo), -Math.max(lo, hi), -lo);
    }
    s += clamp((alpha - this._prevAlpha) / Math.max(1e-3, 1 / 120) * this.steerDamp, -0.3, 0.3);
    this._prevAlpha = alpha;
    s += mistake * 0.4;
    s = clamp(s, -1, 1);
    // Reaction lag: slower drivers fire later, so they overshoot a touch more.
    const rate = clamp(CONFIG.ai.steerSmoothing * (1.3 - 0.35 * this.reaction), 4, 30);
    this._steer = damp(this._steer, s, rate, 1 / 120);
    return Math.abs(this._steer) < 0.012 ? 0 : this._steer;
  }

  /** Decides whether to hold a drift through the corner it is in. */
  _driftDecision(kart, phys, prog, idx, lateral, speed, steerNow, dt) {
    if (speed < 13) return false;
    if (Math.abs(lateral) > this._halfWidth * 0.74) return false;
    const dr = phys.drift || EMPTY_DRIFT;
    const theta = this._thetaLeft ? this._thetaLeft[idx] : 0;
    const metresLeft = this._run(prog, true);
    if (dr.active) {
      const charged = (dr.tier | 0) >= this._wantTier;
      const straying = Math.abs(lateral) > this._halfWidth * 0.82;
      // A slide that has turned the kart back down the track has outlived its
      // welcome, and so has one that has simply run too long: a committed slide
      // rotates ~1.9 rad/s, so every extra second is another 110 degrees of
      // heading the kart has no corner left to spend it on.
      const spun = this._backDot < TUNE.driftSpinOut;
      const held = this._time - this._driftSince > TUNE.driftMaxHold;
      if (spun || straying || held) return false;
      // Hold the slide until the corner runs out of turning — that is where a
      // release pays.
      return (theta > TUNE.driftThetaMin || metresLeft > 5) && !(charged && theta < 0.35);
    }
    if (!this._driftOk || !this._driftOk[idx]) return false;
    if (this._driftLock > 0) return false;
    if (this._driftRun[idx] > this._driftAppetite) return false;
    // KartPhysics refuses to start a drift below |steer| 0.22.
    if (Math.abs(steerNow) < 0.24) return false;
    // Time the slide to the corner: enough turning left that the slide has a
    // reason to exist, not so much that it outlives the exit and spins the kart
    // off the road. A committed slide rotates ~1.9 rad/s, so a corner that turns
    // less than ~30 degrees cannot carry one.
    if (theta < TUNE.driftThetaMin || theta > TUNE.driftThetaMax) return false;
    const chargeTime = theta / 1.9;
    this._wantTier = chargeTime > 1.5 && this.rng() < 0.45 ? 2 : 1;
    this._driftSince = this._time;
    return true;
  }

  /**
   * Wrong-way recovery: aim at the road a little way ahead and either drive at
   * it or, when the nose points the wrong side of 120 degrees, back up while
   * counter-steering until the kart is roughly lined up again.
   */
  _recover(kart, phys, track, prog, lateral, speed, dt) {
    const p = kart.position;
    const yaw = this._yaw(kart, phys);
    if (!(dt > 0) || dt > 0.1) dt = 1 / 120;
    if (this._recoverSince < 0) this._recoverSince = this._time;
    // Aim back at a safe spot on the road, biased away from the edge we are on.
    const pull = clamp(-lateral / Math.max(1, this._halfWidth), -0.6, 0.6) * this._halfWidth * 0.5;
    const ahead = track.advance ? track.advance(prog, 13) : prog;
    track.positionAt(ahead, clamp(pull, -this._halfWidth * 0.5, this._halfWidth * 0.5), this._aim);
    let aimYaw = yaw;
    if (p && typeof p.x === 'number') {
      aimYaw = Math.atan2(-(this._aim.x - p.x), -(this._aim.z - p.z));
    }
    const err = deltaAngle(yaw, aimYaw);   // > 0: we need to turn left
    const aligned = Math.cos(err) > 0.55;
    // A kart that cannot sort itself out in a couple of seconds must not sit
    // there reversing in circles: drive out of it and let the line pull it round.
    const desperate = this._time - this._recoverSince > 2.5;
    let throttle;
    let brake;
    let steer;
    if (!aligned && !desperate) {
      // Reverse is the only way to swing the nose around: steering is inverted
      // while backing up, so a positive error (need to turn left) takes a
      // positive steer here.
      this._turning = true;
      throttle = 0;
      brake = 1;
      steer = clamp(err * 2.2, -1, 1);
    } else {
      this._turning = false;
      throttle = 0.8;
      brake = 0;
      steer = clamp(-err * 2.6, -1, 1);
    }
    const rate = clamp(CONFIG.ai.steerSmoothing * 1.2, 4, 30);
    this._steer = damp(this._steer, steer, rate, dt);
    const d = this._driveOut;
    d.throttle = throttle;
    d.brake = brake;
    d.steer = this._steer;
    return d;
  }

  /** Monotonic race progress, used for rubber-banding and item decisions. */
  _progressOf(kart) {
    if (typeof kart.raceProgress === 'number' && isFinite(kart.raceProgress)) return kart.raceProgress;
    const lap = typeof kart.lap === 'number' ? kart.lap : 1;
    const lp = typeof kart.lapProgress === 'number' ? kart.lapProgress : 0;
    return lap + lp;
  }

  /** Gentle catch-up, bounded by CONFIG.ai.rubberBand. */
  _rubber(kart, top) {
    const karts = this.karts;
    if (!karts || karts.length < 2) return 0;
    const mine = this._progressOf(kart);
    let leader = -Infinity;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (!o || o === kart) continue;
      const d = this._progressOf(o);
      if (isFinite(d) && d > leader) leader = d;
    }
    if (!isFinite(leader)) return 0;
    const metres = (leader - mine) * this._len;
    const rb = CONFIG.ai.rubberBand;
    if (metres > 0) return rb.up * top * clamp(metres / 90, 0, 1);
    return -rb.down * top * clamp(-metres / 90, 0, 1);
  }

  /** Race picture the item table needs. */
  _field(kart, prog, speed) {
    const karts = this.karts;
    const p = kart.position;
    const mine = this._progressOf(kart);
    let ahead = null;
    let behind = null;
    let near = 0;
    let myRank = 1;
    let leaderGap = 0;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (!o || o === kart) continue;
      const d = this._progressOf(o);
      const metres = (d - mine) * this._len;
      if (metres > 0) {
        if (ahead == null || metres < ahead) ahead = metres;
        myRank++;
      } else if (metres < 0) {
        const b = -metres;
        if (behind == null || b < behind) behind = b;
      }
      if (metres > leaderGap) leaderGap = metres;
      const q = o.position;
      if (q && p && typeof q.x === 'number') {
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        if (dx * dx + dz * dz < 120) near++;
      }
    }
    if (typeof kart.rank === 'number' && kart.rank > 0) myRank = kart.rank;
    const f = this._fieldOut;
    f.ahead = ahead;
    f.behind = behind;
    f.near = near;
    f.myRank = myRank;
    f.leaderGap = leaderGap;
    f.straight = this._run(prog, false);
    return f;
  }

  /** The contract's item decision table. Returns true to signal the integrator. */
  _useItem(kart, phys, prog, speed, top, surface) {
    const slot = kart.item;
    const id = slot && typeof slot.id === 'string' ? slot.id : '';
    if (!id || id === 'none' || id === 'nothing') return false;
    if (slot.count != null && slot.count <= 0) return false;
    if (slot.rolling) return false;
    if (kart.finished) return false;
    if (this._itemTimer > 0) return false;

    const f = this._field(kart, prog, speed);
    const ahead = f.ahead;
    const behind = f.behind;
    let fire = false;
    switch (id) {
      case 'mushroom':
      case 'goldenMushroom':
        fire = (f.straight >= 26 && speed > top * 0.45) ||
          (surface === 'off' && speed < 9) ||
          (ahead != null && ahead < 14);
        break;
      case 'tripleMushroom':
        fire = (f.straight >= 55 && speed > top * 0.45 || (surface === 'off' && speed < 9));
        break;
      case 'banana':
      case 'tripleBanana':
        fire = (behind != null && behind <= 22) ||
          (f.myRank === 1 && speed < top * 0.35 && Math.abs(phys.lateralValue || 0) < this._halfWidth * 0.5);
        break;
      case 'greenShell':
        fire = ahead != null && ahead >= 6 && ahead <= 45;
        break;
      case 'redShell':
        fire = ahead != null && ahead >= 6 && ahead <= 70;
        break;
      case 'star':
        fire = f.near >= 2 || (ahead != null && ahead < 7);
        break;
      case 'lightning':
        fire = (f.myRank > 1 && f.leaderGap < top * 10) || f.near >= 3;
        break;
      case 'blooper':
        // The ink only lands on karts *ahead* (ItemSystem._kartsAhead), so the
        // old `behind <= 30` trigger spent the item whenever someone was
        // catching up and accomplished nothing at all.
        fire = ahead != null && ahead <= 30;
        break;
      case 'bulletBill':
        fire = f.straight >= 18 || f.myRank > 4;
        break;
      case 'superHorn':
        fire = this._shellIncoming(kart);
        break;
      default:
        fire = ahead != null && ahead >= 8 && ahead <= 40;
        break;
    }
    if (!fire) return false;
    this._itemTimer = this.itemCooldown;
    const items = this.items;
    if (items && typeof items.useActive === 'function') {
      try {
        items.useActive(kart);
      } catch (err) { /* the integrator's proxy still sees nothing */ }
      return false;
    }
    return true;
  }

  /** True when an enemy shell looks like it is about to ruin our day. */
  _shellIncoming(kart) {
    const items = this.items;
    if (!items || !Array.isArray(items.entities)) return false;
    const p = kart.position;
    if (!p) return false;
    const list = items.entities;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e) continue;
      const owner = e.ownerId === kart.id ? kart : null;
      if (owner === kart) continue;
      const q = e.position;
      if (!q || typeof q.x !== 'number') continue;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 42 * 42) continue;
      const vel = e.velocity || e.direction;
      if (vel && typeof vel.x === 'number') {
        const toward = dx * vel.x + dz * vel.z;
        if (toward > 0) continue;
      }
      return true;
    }
    return false;
  }

  /** Puts the kart back on the road when it is stranded for too long. */
  _checkStranded(dt, kart, phys, track, loc, speed) {
    const surface = loc.surface;
    const half = typeof phys.halfWidth === 'number' ? phys.halfWidth : this._halfWidth;
    let bad = false;
    if (surface === 'off' && Math.abs(speed) < 3.5) bad = true;
    else if (Math.abs(loc.lateral) > half && Math.abs(speed) < 2) bad = true;
    if (!bad) {
      const p = kart.position;
      if (p && typeof p.y === 'number' && typeof track.surfaceHeight === 'function') {
        try {
          const h = track.surfaceHeight(p.x, p.z);
          if (typeof h === 'number' && isFinite(h) && p.y < h - TUNE.lostDepth) bad = true;
        } catch (err) { /* keep driving */ }
      }
    }
    if (this._go) {
      this._badTime = bad ? this._badTime + dt : 0;
      this._stuckTime = (!bad && Math.abs(speed) < 0.8) ? this._stuckTime + dt : 0;
    } else {
      this._badTime = 0;
      this._stuckTime = 0;
    }
    if (this._badTime > 2.4 || this._stuckTime > 6) {
      this._badTime = 0;
      this._stuckTime = 0;
      this._respawn(kart, phys, track, loc.progress);
    }
  }

  _respawn(kart, phys, track, prog) {
    const ahead = track.advance ? track.advance(prog, 6) : prog;
    const pos = track.positionAt(ahead, 0, this._respawnPos);
    const yaw = typeof track.yawAt === 'function' ? track.yawAt(ahead) : this._yaw(kart, phys);
    if (phys && typeof phys.reset === 'function') {
      try {
        phys.reset({ position: pos, yaw });
      } catch (err) {
        if (kart.position) kart.position.copy(pos);
      }
    } else if (kart.position) {
      kart.position.copy(pos);
    }
    if (phys) phys.speed = 6;
    const g = kart.group;
    if (g) {
      g.position.copy(pos);
      g.rotation.y = yaw;
    }
    if (typeof kart.poseVisuals === 'function') {
      try { kart.poseVisuals(1 / 60); } catch (err) { /* view-only */ }
    }
    this._steer = 0;
    this._backDot = 1;
    this._headDot = 1;
    this._hasPrev = false;
    this._turning = false;
  }
}

export default AIDriver;
