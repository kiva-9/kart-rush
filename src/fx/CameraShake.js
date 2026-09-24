/**
 * CameraShake — trauma-driven camera shake.
 *
 * Design rules this file obeys:
 *  - **Additive, never multiplicative.** The rig solves a clean pose; we then
 *    add a small rotation (applied in the camera's local space) and a small
 *    local-space position offset. Nothing is scaled, so a shake can never
 *    permanently deform the camera transform.
 *  - **Trauma, not per-hit parameters.** Every impulse adds to a single 0..1
 *    `trauma` value; amplitude is `trauma^1.6`, which is what makes repeated
 *    small hits escalate instead of clipping.
 *  - **Clamped and non-nauseating.** Total rotation is hard-clamped to two
 *    degrees; position to ~0.25 m. A slow 5 Hz sway carries the weight, a 26 Hz
 *    jitter carries the crack.
 *  - **Inert when paused**: on pause it zeroes its offsets so the rig's clean
 *    pose is exactly what the renderer sees.
 *
 * Transform contract with CameraRig: the rig calls
 * `shake.applyTo(rigPos, rigQuat, camera)` after writing the clean pose, and
 * bounds its own work with the same per-frame guard this class uses, so a
 * frame never gets decayed twice.
 *
 * Ownership: src/fx/CameraShake.js (FX pass). See docs/CONTRACT.md section 10.
 */
import * as THREE from 'three';

import { clamp } from '../core/MathUtils.js';
import { MODES } from '../core/Store.js';

/** Hard clamp on total rotation offset, in radians (~2 degrees). */
const MAX_ROT = 0.032;
/** Hard clamp on total position offset, in metres. */
const MAX_POS = 0.24;

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();

/** Deterministic 1D hash noise in -1..1 — no allocation, no Math.random. */
function hash1(i, seed) {
  let h = Math.imul(i ^ seed, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return ((h & 0xffffff) / 0x800000) - 1;
}

/** Smooth value noise, sampled with wraparound so the ring never restarts hard. */
function noise1(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(i, seed);
  const b = hash1(i + 1, seed);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

export class CameraShake {
  /** @param {object} ctx the usual game context (game/bus/store/camera). */
  constructor(ctx) {
    this.ctx = ctx || {};
    this.game = this.ctx.game || null;
    this.camera = this.ctx.camera || null;
    this.bus = this.ctx.bus || null;

    /** 0..1 trauma accumulator; amplitude is trauma^1.6. */
    this.trauma = 0;
    this.enabled = true;

    // current offsets, exposed for anything that wants to read them
    /** @type {THREE.Euler} local-space rotation offset (radians) */
    this.rotOffset = new THREE.Euler(0, 0, 0, 'YXZ');
    /** @type {THREE.Vector3} local-space position offset (metres) */
    this.posOffset = new THREE.Vector3(0, 0, 0);

    this._decay = 3.2;
    this._hold = 0;
    this._t = 0;
    this._steppedFrame = -1;
    this._offShake = null;
    this._disposed = false;

    if (this.bus && typeof this.bus.on === 'function') {
      this._offShake = this.bus.on('fx:shake', (p) => {
        if (!p) return;
        this.shake(p.strength, p.duration, p.decay);
      });
    }
  }

  /* ------------------------------------------------------------------ api -- */

  /**
   * @param {number} strength 0..1 trauma to add (additive, clamped at 1)
   * @param {number} [duration] seconds of hold before the decay starts
   * @param {number} [decay] exponential decay rate, 1/s
   */
  shake(strength, duration, decay) {
    if (!this.enabled) return;
    const s = clamp(strength != null ? strength : 0.5, 0, 1);
    if (s <= 0) return;
    this.trauma = clamp(this.trauma + s, 0, 1);
    if (duration != null) this._hold = Math.max(this._hold, duration);
    if (decay != null) this._decay = clamp(decay, 0.15, 12);
    return this.trauma;
  }

  /** Adds raw trauma without touching the decay envelope. */
  add(amount) {
    if (!this.enabled) return;
    this.trauma = clamp(this.trauma + (amount || 0), 0, 1);
  }

  /** A shell/banana connection. */
  shakeHit(strength) {
    return this.shake(strength != null ? strength : 0.55, 0.3, 3.6);
  }

  /** Landing after a jump or a hard suspension bottom-out. */
  shakeLand(strength) {
    return this.shake(strength != null ? strength : 0.38, 0.2, 4.4);
  }

  /** Boost ignition — a heavy, low kick rather than a buzz. */
  shakeBoost(strength) {
    return this.shake(strength != null ? strength : 0.22, 0.5, 2.6);
  }

  /** Wall scrape: fast, thin, and immediately gone. */
  shakeScrape(strength) {
    return this.shake(strength != null ? strength : 0.16, 0.12, 6.5);
  }

  /** Returns the current amplitude 0..1 (trauma with the punch curve applied). */
  get amplitude() {
    return this.trauma <= 0 ? 0 : Math.pow(this.trauma, 1.6);
  }

  reset() {
    this.trauma = 0;
    this._hold = 0;
    this.posOffset.set(0, 0, 0);
    this.rotOffset.set(0, 0, 0);
  }

  /* --------------------------------------------------------------- update -- */

  /** Fixed 120 Hz entry point. */
  update(dt, ctx) {
    if (ctx && ctx.game) this.game = ctx.game;
    if (ctx && ctx.camera) this.camera = ctx.camera;
    const frame = this._frame();
    if (frame >= 0 && this._steppedFrame === frame) return;
    this.step(dt, ctx);
  }

  /** Per rendered frame entry point. */
  updateView(dt, ctx) {
    if (ctx && ctx.game) this.game = ctx.game;
    if (ctx && ctx.camera) this.camera = ctx.camera;
    const frame = this._frame();
    if (frame >= 0 && this._steppedFrame === frame) return;
    this.step(dt, ctx);
  }

  _frame() {
    return this.game && typeof this.game.frame === 'number' ? this.game.frame : -1;
  }

  step(dt, ctx) {
    if (this._disposed) return;
    const frame = this._frame();
    if (frame >= 0) this._steppedFrame = frame;

    if (this._paused(ctx)) {
      // Fully inert while paused: no decay, no offsets, no surprise on resume.
      this.reset();
      return;
    }
    const d = clamp(dt, 0, 0.1);
    this._t += d;

    if (this._hold > 0) this._hold = Math.max(0, this._hold - d);
    else if (this.trauma > 0) {
      this.trauma *= Math.exp(-this._decay * d);
      if (this.trauma < 1e-4) this.trauma = 0;
    }

    if (this.trauma <= 0) {
      this.posOffset.set(0, 0, 0);
      this.rotOffset.set(0, 0, 0);
      return;
    }

    const amp = Math.pow(this.trauma, 1.6);

    // --- rotation: heavy roll, medium pitch, light yaw
    const roll = noise1(this._t * 27, 0x51) * 1.35 + noise1(this._t * 6.5, 0x11) * 0.55;
    const pitch = noise1(this._t * 23, 0x7a) * 0.85 + noise1(this._t * 5.1, 0x33) * 0.4;
    const yaw = noise1(this._t * 31, 0xa9) * 0.6 + noise1(this._t * 4.3, 0x5d) * 0.3;

    let rx = pitch * amp;
    let ry = yaw * amp;
    let rz = roll * amp;
    const mag = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (mag > MAX_ROT) {
      const k = MAX_ROT / mag;
      rx *= k; ry *= k; rz *= k;
    }
    this.rotOffset.set(rx, ry, rz, 'YXZ');

    // --- position: mostly vertical + a little lateral push, almost none along
    // the view axis (that reads as a speed hack)
    const px = (noise1(this._t * 19, 0x1f) * 0.7 + noise1(this._t * 4.7, 0x77) * 0.5) * amp;
    const py = (noise1(this._t * 21, 0x2d) * 1.0 + noise1(this._t * 5.6, 0x91) * 0.6) * amp;
    const pz = noise1(this._t * 13, 0x43) * 0.12 * amp;
    let lx = px, ly = py, lz = pz;
    const pm = Math.sqrt(lx * lx + ly * ly + lz * lz);
    if (pm > MAX_POS) {
      const k = MAX_POS / pm;
      lx *= k; ly *= k; lz *= k;
    }
    this.posOffset.set(lx, ly, lz);
  }

  /**
   * Composes the shake on top of a solved rig pose and writes the camera.
   * @param {THREE.Vector3} basePos the rig's clean position
   * @param {THREE.Quaternion} baseQuat the rig's clean rotation
   * @param {THREE.Camera} [camera] defaults to the ctx camera
   */
  applyTo(basePos, baseQuat, camera) {
    const cam = camera || this.camera;
    if (!cam) return;
    if (!this.enabled || this.trauma <= 0) {
      // nothing to add: hand back the clean pose untouched
      cam.position.copy(basePos);
      cam.quaternion.copy(baseQuat);
      return;
    }
    // rotation: local-space offset multiplied on top (never scaled)
    _euler.copy(this.rotOffset);
    _q.setFromEuler(_euler);
    cam.quaternion.copy(baseQuat).multiply(_q);
    // position: offset rotated into world space by the clean base rotation
    _p.copy(this.posOffset).applyQuaternion(baseQuat);
    cam.position.copy(basePos).add(_p);
  }

  _paused(ctx) {
    const g = (ctx && ctx.game) || this.game;
    if (g && g.paused === true) return true;
    const st = (ctx && ctx.store ? ctx.store.state : null) || (this.ctx.store ? this.ctx.store.state : null);
    return !!(st && st.mode === MODES.PAUSED);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._offShake) {
      this._offShake();
      this._offShake = null;
    }
    this.reset();
    this.enabled = false;
    this.camera = null;
    this.game = null;
    this.bus = null;
  }
}

export default CameraShake;
