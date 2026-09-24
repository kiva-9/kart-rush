/**
 * CameraRig — the chase camera, and the single most important element of
 * kart-racing feel.
 *
 * What it does, in order of how much the player notices:
 *  - lags its yaw behind the kart's heading (`CONFIG.camera.yawLag`) *and*
 *    biases toward the kart's velocity direction, so a drift reads as the kart
 *    sliding out from under the camera rather than as a spinning sprite;
 *  - shifts sideways opposite the drift, so you watch the corner from the
 *    outside where the angle is visible;
 *  - widens FOV from `CONFIG.camera.fov` to `CONFIG.camera.fovBoost` with speed
 *    and boost;
 *  - bobs, rises and pulls back with speed;
 *  - clamps itself above `TrackPath.surfaceHeight()` so it never dips through a
 *    hill (the track is optional — an absent path simply disables the clamp);
 *  - writes `ctx.game.focus` every frame so the shadow camera follows the
 *    action;
 *  - exposes `rigPos` / `rigQuat` (the *unshaken* pose) and a `shake` hook so
 *    CameraShake can compose on top without the two fighting over the camera.
 *
 * Transform ownership: the rig writes `ctx.camera.position` / `.quaternion` from
 * `this.rigPos` / `this.rigQuat`, then hands those two to
 * `this.shake.applyTo(rigPos, rigQuat, camera)` if a shake instance is
 * attached (`Bootstrap` does exactly that with `rig.shake = cameraShake`).
 *
 * Ownership: src/fx/CameraRig.js (FX pass). See docs/CONTRACT.md section 10.
 */
import * as THREE from 'three';

import { CONFIG } from '../data/config.js';
import { clamp, damp, deltaAngle, lerp, smoothstep, wrapAngle, TAU } from '../core/MathUtils.js';
import { MODES } from '../core/Store.js';

/** Game camera modes collapse onto the five rig modes. */
const MODE_MAP = {
  race: 'chase',
  chase: 'chase',
  intro: 'intro',
  title: 'title',
  fixed: 'fixed',
  lookBack: 'lookBack',
};

const UP = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _pA = new THREE.Vector3();
const _lA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _lB = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _fixedPos = new THREE.Vector3();
const _fixedLook = new THREE.Vector3();
const _anchor = new THREE.Vector3();

export class CameraRig {
  /**
   * @param {object} ctx the usual game context. `ctx.track` (a TrackPath) is
   *   optional; without it the ground clamp and the title anchor fall back to
   *   sane defaults.
   */
  constructor(ctx) {
    this.ctx = ctx || {};
    this.game = this.ctx.game || null;
    this.camera = this.ctx.camera || null;
    this.track = this.ctx.track || null;

    /** 'chase' | 'lookBack' | 'intro' | 'title' | 'fixed' */
    this.mode = 'chase';
    /** @type {object|null} the kart we follow */
    this.target = null;
    /** @type {{applyTo:(p:THREE.Vector3,q:THREE.Quaternion,c:any)=>void}|null} */
    this.shake = null;

    // spring state
    this.yaw = 0;
    this.dist = CONFIG.camera.distance;
    this.height = CONFIG.camera.height;
    this.fov = CONFIG.camera.fov;
    this.lat = 0;
    this.bob = 0;
    this.bobPhase = 0;
    this.lookBackT = 0;
    this.titleT = 0;
    this.introT = 0;
    this.fixedReady = false;

    /** the unshaken pose the rig just solved for */
    this.rigPos = new THREE.Vector3(0, 6, -12);
    /** the unshaken rotation the rig just solved for */
    this.rigQuat = new THREE.Quaternion();
    /** the point the camera is aimed at (also written to game.focus) */
    this.lookPos = new THREE.Vector3();

    this._steppedFrame = -1;
    this._disposed = false;
  }

  /* -------------------------------------------------------------- plumbing -- */

  /** Fixed 120 Hz entry point (only used if registered as a sim system). */
  update(dt, ctx) {
    if (ctx) this._absorb(ctx);
    const frame = this._frame();
    if (frame >= 0 && this._steppedFrame === frame) return;
    this.step(dt);
  }

  /** Per rendered frame entry point — this is the real one. */
  updateView(dt, ctx) {
    if (ctx) this._absorb(ctx);
    const frame = this._frame();
    if (frame >= 0 && this._steppedFrame === frame) return;
    this.step(dt);
  }

  _frame() {
    return this.game && typeof this.game.frame === 'number' ? this.game.frame : -1;
  }

  _absorb(ctx) {
    // The per-frame ctx is rebuilt by Game, so only take what is present: the
    // constructor's ctx is the one Bootstrap enriched with `track`.
    if (ctx.game) this.game = ctx.game;
    if (ctx.camera) this.camera = ctx.camera;
    if (ctx.track) this.track = ctx.track;
  }

  setTarget(kart) {
    this.target = kart || null;
    if (!this.target) this.lat = 0;
  }

  /** Hard-places the camera behind `kart` with no spring travel. */
  snapTo(kart) {
    if (kart) this.target = kart;
    if (!this.target) return;
    this.lookBackT = 0;
    this.introT = 0;
    this.titleT = 0;
    this._chasePose(0.05, true);
  }

  /** Optional scripted placement, for menus and replays. */
  setFixed(position, lookAt) {
    if (position) _fixedPos.copy(position);
    if (lookAt) _fixedLook.copy(lookAt);
    this.fixedReady = false;
  }

  /* ---------------------------------------------------------------- update -- */

  step(dt) {
    if (this._disposed || !this.camera) return;
    const d = clamp(dt, 0, 0.1);
    const frame = this._frame();
    if (frame >= 0) this._steppedFrame = frame;

    const paused = this._paused();
    if (paused) {
      // Freeze the springs but drop any shake offset that was baked in.
      this.camera.position.copy(this.rigPos);
      this.camera.quaternion.copy(this.rigQuat);
      return;
    }

    // look-back blend drives both the mode switch and the 180-degree flip, so
    // the two can never disagree mid-transition.
    this.lookBackT = damp(this.lookBackT, this._lookBackHeld() ? 1 : 0, 11, d);

    const want = this._resolveMode();
    if (want !== this.mode) this._enterMode(want);

    switch (this.mode) {
      case 'intro':
        this._intro(d);
        break;
      case 'title':
        this._title(d);
        break;
      case 'fixed':
        this._fixed(d);
        break;
      default:
        this._chase(d);
        break;
    }

    this.camera.position.copy(this.rigPos);
    this.camera.quaternion.copy(this.rigQuat);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    const g = this.game;
    if (g && g.focus && g.focus.isVector3) g.focus.copy(this.lookPos);
    if (g) g.lookBack = this.lookBackT > 0.5;

    const sh = this.shake;
    if (sh) {
      if (typeof sh.update === 'function') sh.update(d);
      if (typeof sh.applyTo === 'function') sh.applyTo(this.rigPos, this.rigQuat, this.camera);
    }
  }

  _paused() {
    const g = this.game;
    if (g && g.paused === true) return true;
    const st = this.ctx.store ? this.ctx.store.state : null;
    return !!(st && st.mode === MODES.PAUSED);
  }

  _resolveMode() {
    const m = this.game ? this.game.cameraMode : null;
    let want = MODE_MAP[m] || 'chase';
    // Hysteresis, so the flip does not chatter at the threshold.
    if (want === 'chase' && this.lookBackT >= 0.5) want = 'lookBack';
    else if (want === 'lookBack' && this.lookBackT <= 0.15) want = 'chase';
    return want;
  }

  _lookBackHeld() {
    const inp = this.ctx.input;
    if (!inp) return false;
    if (typeof inp.isDown === 'function') return !!inp.isDown('lookBack');
    return false;
  }

  _enterMode(mode) {
    this.mode = mode;
    if (mode === 'intro') this.introT = 0;
    else if (mode === 'title') this.titleT = 0;
    else if (mode === 'fixed') this.fixedReady = false;
  }

  /* ----------------------------------------------------------------- chase -- */

  _chase(dt) {
    const ok = this._chasePose(dt, false);
    if (!ok) this._title(dt);
  }

  /**
   * Solves the springs and writes `rigPos` / `rigQuat` / `lookPos` / `fov`.
   * @param {boolean} snap teleport instead of damping
   * @returns {boolean} false when there is nothing to follow
   */
  _chasePose(dt, snap) {
    const k = this.target;
    if (!k || !this.camera) return false;
    const phys = k.physics || k;
    const pos = phys.position || k.position;
    if (!pos) return false;

    const C = CONFIG.camera;
    const yaw = phys.yaw || 0;
    const speed = phys.speed || 0;
    const vel = phys.velocity;
    const drift = phys.drift || null;
    const top = typeof phys.effectiveTopSpeed === 'function' ? phys.effectiveTopSpeed() : CONFIG.physics.topSpeed;
    const sf = clamp(Math.abs(speed) / Math.max(6, top), 0, 1.3);

    // signed slide: positive = sliding to the driver's right
    const lateral = phys.lateralSpeed || 0;
    const slide = clamp(lateral / 8, -1, 1);
    const driftDir = drift && typeof drift.dir === 'number' ? drift.dir : 0;

    // ---- desired yaw -------------------------------------------------------
    let desired = yaw;
    const vxz = vel ? Math.hypot(vel.x, vel.z) : 0;
    if (vxz > 5) {
      // Bias toward where the kart is actually going: this is what makes a
      // drift "read" instead of looking like a texture slide.
      const vyaw = Math.atan2(-vel.x, -vel.z);
      const blend = clamp(vxz / Math.max(6, top), 0, 1) * 0.62;
      desired = wrapAngle(yaw + deltaAngle(yaw, vyaw) * blend);
    }
    desired = wrapAngle(desired + slide * 0.34 + driftDir * 0.05);
    desired = wrapAngle(desired + Math.PI * this.lookBackT);

    // look-back flips the whole rig, so give the yaw spring a nudge to keep up
    const rate = C.yawLag * (1 + this.lookBackT * 0.5);
    if (snap) this.yaw = desired;
    else this.yaw = wrapAngle(this.yaw + deltaAngle(this.yaw, desired) * (1 - Math.exp(-rate * dt)));

    // ---- distance / height / fov ------------------------------------------
    const distT = C.distance + sf * 0.85;
    const heightT = C.height + sf * 0.62;
    if (snap) {
      this.dist = distT;
      this.height = heightT;
    } else {
      this.dist = damp(this.dist, distT, 4, dt);
      this.height = damp(this.height, heightT, C.heightLag, dt);
    }

    const boosting = phys.boost && phys.boost.timer > 0 ? 1 : 0;
    const fovT = lerp(C.fov, C.fovBoost, clamp(sf * 0.85 + boosting * 0.55, 0, 1));
    if (snap) this.fov = fovT;
    else this.fov = damp(this.fov, fovT, 6, dt);

    // ---- lateral drift offset (opposite the slide) + bob -------------------
    const latT = -slide * 1.65 - driftDir * 0.35;
    if (snap) this.lat = latT;
    else this.lat = damp(this.lat, latT, 6, dt);

    const grounded = phys.onGround === false ? 0 : 1;
    this.bobPhase += dt * (5 + sf * 9);
    const bobT = grounded * Math.sin(this.bobPhase) * 0.045 * (0.25 + sf);
    this.bob = snap ? bobT : damp(this.bob, bobT, 8, dt);

    // ---- compose -----------------------------------------------------------
    const f = this.yaw;
    const fx = -Math.sin(f);
    const fz = -Math.cos(f);
    const rx = -fz;
    const rz = fx;

    const ex = pos.x - fx * this.dist + rx * this.lat;
    const ez = pos.z - fz * this.dist + rz * this.lat;
    let ey = pos.y + this.height + this.bob;

    const path = this.track;
    if (path && typeof path.surfaceHeight === 'function') {
      const g = path.surfaceHeight(ex, ez) + 0.7;
      if (ey < g) ey = g;
    }

    let ly = pos.y + 1.3;
    if (path && typeof path.surfaceHeight === 'function') {
      const gl = path.surfaceHeight(pos.x, pos.z) + 0.5;
      if (ly < gl) ly = gl;
    }
    const ahead = 9 * (1 - this.lookBackT);
    const lx = pos.x + fx * ahead;
    const lz = pos.z + fz * ahead;

    this.rigPos.set(ex, ey, ez);
    this.lookPos.set(lx, ly, lz);
    _v1.set(ex, ey, ez);
    _v2.set(lx, ly, lz);
    _m4.lookAt(_v1, _v2, UP);
    this.rigQuat.setFromRotationMatrix(_m4);
    // a couple of degrees of drift roll is worth a lot of speed sensation
    _q.setFromAxisAngle(AXIS_Z, clamp(slide * 0.035, -0.05, 0.05));
    this.rigQuat.multiply(_q);
    return true;
  }

  /* ----------------------------------------------------------------- intro -- */

  /**
   * The four-second pre-race cinematic: from above, sweeping across the grid,
   * settling behind the player. The chase springs stay live the whole time so
   * the hand-off to `chase` has zero discontinuity.
   */
  _intro(dt) {
    const C = CONFIG.camera;
    this.introT += dt;
    const DUR = C.introDuration || 4.2;
    const t = clamp(this.introT / DUR, 0, 1);

    if (!this._chasePose(dt, false)) {
      this._title(dt);
      return;
    }
    _pB.copy(this.rigPos);
    _lB.copy(this.lookPos);
    const fovB = this.fov;

    const phys = (this.target && (this.target.physics || this.target)) || null;
    const pos = phys ? phys.position || this.target.position : null;
    if (!pos) return;
    const yaw = phys.yaw || 0;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);

    // Phase A sweeps from above across the grid; phase B eases into the solved
    // chase pose. The countdown is ~3.3 s (CONFIG.race.countdown) while the
    // intro runs CONFIG.camera.introDuration, so the settle is front-loaded to
    // finish just as the lights go green instead of dragging on.
    const easeA = smoothstep(clamp(t / 0.34, 0, 1));
    const ang = yaw + lerp(-1.6, 1.4, easeA);
    const rad = lerp(27, 16.5, easeA);
    const hgt = lerp(16.5, 9.5, easeA);
    _pA.set(pos.x + Math.sin(ang) * rad, pos.y + hgt, pos.z + Math.cos(ang) * rad);
    // glance down the grid toward the front row and back again
    const glance = Math.sin(Math.PI * easeA) * 16;
    _lA.set(pos.x + fx * glance, pos.y + 1.7, pos.z + fz * glance);
    const fovA = lerp(72, C.fov, easeA);

    // phase B: ease into the solved chase pose, with a gentle arc upward
    const easeB = smoothstep(clamp((t - 0.3) / 0.48, 0, 1));
    const arc = Math.sin(Math.PI * easeB) * 2.4;
    const ex = lerp(_pA.x, _pB.x, easeB);
    const ey = lerp(_pA.y, _pB.y, easeB) + arc;
    const ez = lerp(_pA.z, _pB.z, easeB);

    this.rigPos.set(ex, ey, ez);
    _v2.lerpVectors(_lA, _lB, easeB);
    this.lookPos.copy(_v2);
    _v1.set(ex, ey, ez);
    _m4.lookAt(_v1, _v2, UP);
    this.rigQuat.setFromRotationMatrix(_m4);
    this.fov = lerp(fovA, fovB, easeB);
  }

  /* ----------------------------------------------------------------- title -- */

  /** Slow attract-mode orbit: the start line, or the kart when one is set. */
  _title(dt) {
    const C = CONFIG.camera;
    this.titleT += dt * 0.045;
    let lookY = 4;
    const centre = _anchor.set(0, 0, 0);
    if (this.target) {
      const phys = this.target.physics || this.target;
      const pos = phys.position || this.target.position;
      if (pos) {
        centre.set(pos.x, pos.y, pos.z);
        lookY = 1.6;
      }
    } else {
      centre.copy(this._anchorPos());
    }

    const a = this.titleT * TAU;
    const radius = 34;
    const height = 12.5 + Math.sin(this.titleT * 1.7) * 1.8;
    const ex = centre.x + Math.sin(a) * radius;
    const ez = centre.z + Math.cos(a) * radius;
    let ey = centre.y + height;
    const path = this.track;
    if (path && typeof path.surfaceHeight === 'function') {
      const g = path.surfaceHeight(ex, ez) + 1.5;
      if (ey < g) ey = g;
    }
    this.rigPos.set(ex, ey, ez);
    this.lookPos.set(centre.x, centre.y + lookY, centre.z);
    _v1.set(ex, ey, ez);
    _v2.copy(this.lookPos);
    _m4.lookAt(_v1, _v2, UP);
    this.rigQuat.setFromRotationMatrix(_m4);
    this.fov = C.fov;
    this.yaw = Math.atan2(-(centre.x - ex), -(centre.z - ez));
  }

  /** Lazily resolves the start-line anchor from the track, when there is one. */
  _anchorPos() {
    if (this._anchorV) return this._anchorV;
    const v = new THREE.Vector3(0, 0, 0);
    const path = this.track || (this.ctx && this.ctx.track);
    const def = (this.ctx && this.ctx.trackDef) || (path && path.def);
    if (path && typeof path.positionAt === 'function') {
      const p = def && typeof def.startLine === 'number' ? def.startLine : 0.02;
      path.positionAt(p, 0, v);
    }
    this._anchorV = v;
    return v;
  }

  /* ----------------------------------------------------------------- fixed -- */

  _fixed(dt) {
    const data = this.game ? this.game.cameraModeData : null;
    const k = this.target;
    if (data && data.position) {
      _fixedPos.set(data.position.x, data.position.y, data.position.z);
      if (data.lookAt) _fixedLook.set(data.lookAt.x, data.lookAt.y, data.lookAt.z);
      else if (k) _fixedLook.copy(k.position || this.rigPos);
      this.fixedReady = true;
    } else if (!this.fixedReady) {
      if (k) {
        const phys = k.physics || k;
        const pos = phys.position || k.position;
        if (pos) _fixedLook.copy(pos);
      } else {
        _fixedLook.copy(this.rigPos);
      }
      _fixedPos.set(this.rigPos.x, this.rigPos.y, this.rigPos.z - CONFIG.camera.distance);
      this.fixedReady = true;
    }

    const rate = 4.5;
    this.rigPos.set(
      damp(this.rigPos.x, _fixedPos.x, rate, dt),
      damp(this.rigPos.y, _fixedPos.y, rate, dt),
      damp(this.rigPos.z, _fixedPos.z, rate, dt)
    );
    this.lookPos.set(
      damp(this.lookPos.x, _fixedLook.x, rate, dt),
      damp(this.lookPos.y, _fixedLook.y, rate, dt),
      damp(this.lookPos.z, _fixedLook.z, rate, dt)
    );
    _v1.copy(this.rigPos);
    _v2.copy(this.lookPos);
    _m4.lookAt(_v1, _v2, UP);
    this.rigQuat.setFromRotationMatrix(_m4);
    this.fov = damp(this.fov, CONFIG.camera.fov, 5, dt);
  }

  /* --------------------------------------------------------------- dispose -- */

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.target = null;
    this.shake = null;
    this.camera = null;
    this.game = null;
  }
}

export default CameraRig;
