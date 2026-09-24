/**
 * Arcade kart physics — Mario Kart 64 / Double Dash flavour.
 *
 * Model: a scalar forward speed with an accel/top-speed curve, a signed
 * lateral-slip component that the surface's grip pulls back to zero, hop +
 * drift with charged mini-turbos, boosts (strongest wins), spinouts, squashes,
 * slipstream, wall clamping and a simple ballistic air state.
 *
 * The step is written to be allocation-light: every vector used per step is a
 * scratch instance owned by this object and all events are pushed into a reused
 * pool, so nothing in `update()` allocates. Runs at a fixed 120 Hz.
 *
 * Coordinates: Y up, yaw 0 faces -Z, forward = (-sin yaw, 0, -cos yaw),
 * right = forward x up = (cos yaw, 0, -sin yaw). Lateral is signed, positive
 * to the driver's right (same convention as TrackPath.locate()).
 */
import * as THREE from 'three';
import { clamp, lerp, damp, smoothstep, wrapAngle } from '../core/MathUtils.js';
import { CONFIG } from '../data/config.js';

/** Neutral DriveInput so update() is safe when a controller is missing. */
const EMPTY_DRIVE = {
  throttle: 0, brake: 0, steer: 0, drift: false, driftPressed: false, item: false,
};

/**
 * Arcade tuning that has no home in CONFIG.physics. Kept here, named and
 * documented, so the feel stays readable next to the config values it bends.
 */
const TUNE = {
  /** Forward speed needed before a drift can be started (m/s). */
  driftMinSpeed: 9.0,
  /** Hard cap on drift slide velocity so a long drift cannot become a donut. */
  driftSlideMax: 10.5,
  /** Drift hop height as a fraction of the hopVelocity parabolic height. */
  hopFactor: 0.55,
  /** Seconds the drift hop lockout lasts. */
  hopTime: 0.26,
  /** Yaw authority lost between standstill and top speed. */
  highSpeedAuthority: 0.28,
  /** How much of the drift's yaw bonus is traded away at top speed. */
  driftSpeedFalloff: 0.32,
  /** Extra deceleration while the tyres scrub sideways in a drift. */
  driftScrub: 0.05,
  /** Acceleration multiplier while a boost is running. */
  boostAccel: 1.9,
  /** How fast a spinout bleeds speed toward spinoutSpeedFactor * top. */
  spinoutDecay: 2.2,
  /** Slipstream charge needed before the top-speed gain starts. */
  slipstreamOnset: 0.35,
  /** Suspension travel used for the visual heightOffset (metres). */
  suspTravel: 0.075,
  /** Grace before the surface flips back from 'wall' (metres of lateral). */
  wallHysteresis: 0.18,
};

const SURFACE_SPEED = { road: 1, curb: 0.94, off: 0.92, wall: 0.9 };
const SURFACE_ACCEL = { road: 1, curb: 0.95, off: 0.78, wall: 0.9 };
const SURFACE_GRIP = { road: 1, curb: 0.82, off: 0.7, wall: 1 };

/** Gear boundaries as a fraction of top speed, for the engine-audio rpm. */
const GEARS = [0.0, 0.16, 0.34, 0.52, 0.7, 0.86];

function makeEvent() {
  return {
    name: '', kartId: 0,
    tier: 0, lastTier: 0, charge: 0, dir: 0, silent: false,
    impact: 0, duration: 0, multiplier: 1, kind: null, surface: 'road',
    sourceId: -1, load: 0, rpm: 0, gear: 1, airTime: 0, speed: 0,
    position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
  };
}

function pick(block, key, fallback) {
  const v = block ? block[key] : undefined;
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

/**
 * Fills any hole in a caller-supplied physics def out of CONFIG.physics so the
 * integrator can hand us either a fully merged def or a bare config slice.
 */
function mergeDef(def) {
  const base = CONFIG.physics;
  const d = def || {};
  const t = d.turn || base.turn;
  const turn = {
    min: pick(t, 'min', base.turn.min),
    max: pick(t, 'max', base.turn.max),
    driftMultiplier: pick(t, 'driftMultiplier', base.turn.driftMultiplier),
    driftInward: pick(t, 'driftInward', base.turn.driftInward),
  };
  const col = d.collision || base.collision;
  const slip = d.slipstream || base.slipstream;
  const boost = d.boost || base.boost;
  const mini = Array.isArray(boost.miniTurbo) && boost.miniTurbo.length
    ? boost.miniTurbo.slice()
    : base.boost.miniTurbo.slice();
  return {
    topSpeed: pick(d, 'topSpeed', base.topSpeed),
    topSpeedBonus: pick(d, 'topSpeedBonus', base.topSpeedBonus),
    accel: pick(d, 'accel', base.accel),
    reverseSpeed: pick(d, 'reverseSpeed', base.reverseSpeed),
    brakeForce: pick(d, 'brakeForce', base.brakeForce),
    drag: pick(d, 'drag', base.drag),
    offTrackDrag: pick(d, 'offTrackDrag', base.offTrackDrag),
    offTrackSpeedFactor: pick(d, 'offTrackSpeedFactor', base.offTrackSpeedFactor),
    grip: pick(d, 'grip', base.grip),
    driftSlide: pick(d, 'driftSlide', base.driftSlide),
    driftTiers: Array.isArray(d.driftTiers) && d.driftTiers.length
      ? d.driftTiers.slice()
      : base.driftTiers.slice(),
    spinout: pick(d, 'spinout', base.spinout),
    spinoutSpeedFactor: pick(d, 'spinoutSpeedFactor', base.spinoutSpeedFactor),
    squash: pick(d, 'squash', base.squash),
    squashSpeedFactor: pick(d, 'squashSpeedFactor', base.squashSpeedFactor),
    wallOffset: pick(d, 'wallOffset', base.wallOffset),
    wallBounce: pick(d, 'wallBounce', base.wallBounce),
    wallSpeedLoss: pick(d, 'wallSpeedLoss', base.wallSpeedLoss),
    hopVelocity: pick(d, 'hopVelocity', base.hopVelocity),
    gravity: pick(d, 'gravity', base.gravity),
    mass: pick(d, 'mass', 1),
    turn,
    collision: {
      radius: pick(col, 'radius', base.collision.radius),
      push: pick(col, 'push', base.collision.push),
      speedLoss: pick(col, 'speedLoss', base.collision.speedLoss),
    },
    slipstream: {
      distance: pick(slip, 'distance', base.slipstream.distance),
      lateral: pick(slip, 'lateral', base.slipstream.lateral),
      speedGain: pick(slip, 'speedGain', base.slipstream.speedGain),
      rampTime: pick(slip, 'rampTime', base.slipstream.rampTime),
    },
    boost: { ...boost, miniTurbo: mini },
    driftMinSpeed: pick(d, 'driftMinSpeed', TUNE.driftMinSpeed),
    driftSlideMax: pick(d, 'driftSlideMax', TUNE.driftSlideMax),
    cc: pick(d, 'cc', 150),
    ccFactor: pick(d, 'ccFactor', 1),
    stats: d.stats || null,
    tuning: d.tuning || null,
    characterId: d.characterId || null,
  };
}

export class KartPhysics {
  /**
   * @param {object} def merged physics def (see KartFactory.createPhysicsDef)
   * @param {object} [track] TrackPath — surface, banking and walls
   * @param {Function} [rng] deterministic random source
   */
  constructor(def, track, rng) {
    this.def = mergeDef(def);
    this.track = track || null;
    this.rng = typeof rng === 'function' ? rng : Math.random;
    /** @type {any} set by KartFactory so events can name their owner */
    this.kart = null;
    this.kartId = 0;
    /** Array of {position, forward, kart} maintained by the integrator. */
    this.nearbyKarts = null;
    /** @type {((name: string, payload: object) => void)|null} */
    this.onEvent = null;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);

    this.radius = this.def.collision.radius;

    /** @type {{active:boolean,dir:number,charge:number,tier:number,hop:boolean}} */
    this.drift = { active: false, dir: 0, charge: 0, tier: 0, hop: false };
    /** @type {{timer:number,total:number,multiplier:number,kind:(string|null)}} */
    this.boost = { timer: 0, total: 0, multiplier: 1, kind: null };
    /** @type {{timer:number,total:number}} */
    this.spinout = { timer: 0, total: 0 };
    /** @type {{timer:number,total:number}} */
    this.squash = { timer: 0, total: 0 };

    this._loc = { progress: 0, lateral: 0, index: 0, surface: 'road' };
    this._frame = {
      index: 0, position: new THREE.Vector3(), tangent: new THREE.Vector3(),
      right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
      normal: new THREE.Vector3(0, 1, 0), bank: 0, width: 11, curvature: 0,
    };

    /** @type {Array<ReturnType<typeof makeEvent>>} reused event pool */
    this.events = [];
    this._evPool = [];
    this._evUsed = 0;
    for (let i = 0; i < 24; i++) this._evPool.push(makeEvent());

    this._resetState();
  }

  // ---------------------------------------------------------------- lifecycle

  _resetState() {
    this.position.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.speed = 0;
    this.lateralSpeed = 0;
    this.height = 0;
    this.verticalVelocity = 0;
    this.onGround = true;
    this.airTime = 0;
    this.surface = 'road';
    this.progress = 0;
    this.lateralValue = 0;
    this.index = 0;
    this.halfWidth = 11;
    this.bank = 0;
    this.curvature = 0;
    this.groundY = 0;
    this.heightOffset = 0;
    this.slipstream = 0;
    this.star = 0;
    this.invincible = 0;
    this.shielded = 0;
    this.hitCooldown = 0;
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.driftHeld = false;
    this.rpm = 0.12;
    this.load = 0;
    this.gear = 1;
    this.accel = 0;
    this.landImpact = 0;
    this.touchingWall = false;
    this._hasTrack = false;
    this._trackSurface = 'road';
    this._wallCooldown = 0;
    this._surfaceEmitted = 'road';
    this._spinDir = 1;
    this._spinSource = -1;
    this._yawRate = 0;
    this._susp = 0;
    this._prevSpeed = 0;
    this._slipActive = false;
    this._engineTick = 0;
    this._hopTimer = 0;
    /** Age of the last drift press, in seconds. See the drift gate below. */
    this._driftPressAge = Infinity;
    this.drift.active = false;
    this.drift.dir = 0;
    this.drift.charge = 0;
    this.drift.tier = 0;
    this.drift.hop = false;
    this.boost.timer = 0;
    this.boost.total = 0;
    this.boost.multiplier = 1;
    this.boost.kind = null;
    this.spinout.timer = 0;
    this.spinout.total = 0;
    this.squash.timer = 0;
    this.squash.total = 0;
    this.events.length = 0;
    this._evUsed = 0;
    this._updateBasis();
  }

  /**
   * @param {{position?:{x:number,y:number,z:number}, yaw?:number,
   *          x?:number, y?:number, z?:number}} [transform]
   */
  reset(transform) {
    this._resetState();
    const t = transform || {};
    const p = t.position;
    if (p && typeof p.x === 'number') this.position.set(p.x, p.y || 0, p.z || 0);
    else if (typeof t.x === 'number') this.position.set(t.x, t.y || 0, t.z || 0);
    this.yaw = typeof t.yaw === 'number' ? t.yaw : 0;
    this._sampleTrack();
    this.position.y = this.groundY;
    this.height = 0;
    this._updateBasis();
  }

  dispose() {
    this.onEvent = null;
    this.nearbyKarts = null;
    this.track = null;
    this.kart = null;
    this.events.length = 0;
    this._evPool.length = 0;
  }

  // ------------------------------------------------------------------- events

  /** Takes a pooled event object; the payload is reused by the next emit. */
  _emit(name) {
    let ev;
    if (this._evUsed < this._evPool.length) ev = this._evPool[this._evUsed];
    else {
      ev = makeEvent();
      this._evPool.push(ev);
    }
    this._evUsed++;
    ev.name = name;
    ev.kartId = this.kartId;
    ev.tier = 0;
    ev.lastTier = 0;
    ev.charge = 0;
    ev.dir = 0;
    ev.silent = false;
    ev.impact = 0;
    ev.duration = 0;
    ev.multiplier = 1;
    ev.kind = null;
    ev.sourceId = -1;
    ev.load = 0;
    ev.rpm = 0;
    ev.gear = 1;
    ev.airTime = 0;
    ev.surface = this.surface;
    ev.speed = this.speed;
    ev.position.copy(this.position);
    ev.normal.set(0, 1, 0);
    this.events.push(ev);
    return ev;
  }

  // -------------------------------------------------------------------- update

  /** @param {number} dt seconds (fixed 120 Hz) @param {object} [drive] DriveInput */
  update(dt, drive) {
    if (!(dt > 0)) dt = 1 / 120;
    if (dt > 0.1) dt = 0.1;
    const d = drive || EMPTY_DRIVE;

    // Anything queued by a command (launch/applyBoost/spinOut...) since the last
    // step is delivered first, then this frame's events start from a clean list.
    this._flush();
    this.events.length = 0;
    this._evUsed = 0;

    this._updateTimers(dt);
    // The steering axis is smoothed, so a drift press that arrives in the same
    // instant as the steer input can be consumed before the axis has ramped
    // past the engage threshold. The press is therefore remembered for a short
    // grace window, which is what makes pressing drift+steer together work.
    this._driftPressAge = d.driftPressed ? 0 : this._driftPressAge + dt;
    this._sampleTrack();
    this._updateSlipstream(dt);
    this._updateDrive(dt, d);
    this._integrate(dt);
    this._updateAir(dt);
    this._clampWall();
    this._updateBasis();
    this._updateEngine(dt);
    this._flush();
  }

  /** Drains the event pool through `onEvent` (a no-op when nobody listens). */
  _flush() {
    const list = this.events;
    const on = this.onEvent;
    if (!on) return;
    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      try {
        on(ev.name, ev);
      } catch (err) {
        /* a broken listener must never kill the sim */
      }
    }
  }

  _updateTimers(dt) {
    const b = this.boost;
    if (b.timer > 0) {
      b.timer -= dt;
      if (b.timer <= 0) {
        b.timer = 0;
        const ev = this._emit('boostEnd');
        ev.kind = b.kind;
        ev.duration = b.total;
        ev.multiplier = b.multiplier;
      }
    }
    const s = this.spinout;
    if (s.timer > 0) {
      s.timer -= dt;
      if (s.timer <= 0) {
        s.timer = 0;
        const ev = this._emit('spinoutEnd');
        ev.duration = s.total;
      }
    }
    const q = this.squash;
    if (q.timer > 0) {
      q.timer -= dt;
      if (q.timer <= 0) {
        q.timer = 0;
        this._emit('squashEnd');
      }
    }
    if (this.star > 0) {
      this.star -= dt;
      if (this.star <= 0) {
        this.star = 0;
        this._emit('starEnd');
      }
    }
    if (this.invincible > 0) {
      this.invincible -= dt;
      if (this.invincible <= 0) {
        this.invincible = 0;
        this._emit('invincibleEnd');
      }
    }
    if (this.shielded > 0) {
      this.shielded -= dt;
      if (this.shielded <= 0) {
        this.shielded = 0;
        this._emit('shieldEnd');
      }
    }
    if (this.hitCooldown > 0) this.hitCooldown = Math.max(0, this.hitCooldown - dt);
    if (this._wallCooldown > 0) this._wallCooldown -= dt;
    if (this.landImpact > 0) this.landImpact = Math.max(0, this.landImpact - dt * 6);
    if (this.drift.hop) {
      this._hopTimer -= dt;
      if (this._hopTimer <= 0) this.drift.hop = false;
    }
  }

  // -------------------------------------------------------------- track query

  /** Samples the track for progress, lateral, surface, banking and half width. */
  _sampleTrack() {
    const track = this.track;
    if (!track || typeof track.locate !== 'function') {
      this._fallbackSample();
      return;
    }
    const loc = this._loc;
    let r = null;
    try {
      r = track.locate(this.position.x, this.position.y, this.position.z, loc);
    } catch (err) {
      r = null;
    }
    if (!r || typeof r.progress !== 'number') {
      this._fallbackSample();
      return;
    }
    if (r !== loc) {
      loc.progress = r.progress;
      loc.lateral = typeof r.lateral === 'number' ? r.lateral : 0;
      loc.index = typeof r.index === 'number' ? r.index : 0;
      loc.surface = r.surface || 'road';
    }
    this._hasTrack = true;
    this.progress = loc.progress;
    this.lateralValue = loc.lateral;
    this.index = loc.index;
    let surface = loc.surface || 'road';
    if (surface !== 'road' && surface !== 'curb' && surface !== 'off' && surface !== 'wall') {
      surface = 'road';
    }
    this._trackSurface = surface;

    const frame = this._frame;
    if (typeof track.frameAt === 'function') {
      let f = null;
      try {
        // frameAt() takes a *progress fraction*, not a sample index: passing
        // loc.index would wrapProgress() back to 0 and hand us the start-line
        // frame for the whole lap, so banking, the surface normal and — much
        // worse — _clampWall()'s push direction would all point at the wrong
        // corner of the circuit.
        f = track.frameAt(loc.progress, frame);
      } catch (err) {
        f = null;
      }
      if (f && f !== frame) {
        if (f.right && typeof f.right.x === 'number') frame.right.copy(f.right);
        if (f.up && typeof f.up.x === 'number') frame.up.copy(f.up);
        if (f.normal && typeof f.normal.x === 'number') frame.normal.copy(f.normal);
        if (f.position && typeof f.position.x === 'number') frame.position.copy(f.position);
        frame.bank = typeof f.bank === 'number' ? f.bank : 0;
        frame.width = typeof f.width === 'number' ? f.width : 11;
        frame.curvature = typeof f.curvature === 'number' ? f.curvature : 0;
      }
    }
    if (!(frame.width > 0.5)) {
      frame.width = track.def && typeof track.def.width === 'number' ? track.def.width : 11;
    }
    this.halfWidth = frame.width;
    this.bank = frame.bank;
    this.curvature = frame.curvature;

    let gy = null;
    if (typeof track.surfaceHeight === 'function') {
      try {
        const h = track.surfaceHeight(this.position.x, this.position.z);
        if (typeof h === 'number' && isFinite(h)) gy = h;
      } catch (err) {
        gy = null;
      }
    }
    if (gy === null && frame.position && typeof frame.position.y === 'number') gy = frame.position.y;
    if (gy === null) gy = 0;
    this.groundY = gy;

    this._setSurface(surface);
  }

  /** Standalone/no-track fallback: a flat 120 m arena with soft walls. */
  _fallbackSample() {
    this._hasTrack = false;
    this.halfWidth = 58.6;
    this.groundY = 0;
    this.bank = 0;
    this.curvature = 0;
    this.index = 0;
    this.progress = 0;
    this.lateralValue = Math.hypot(this.position.x, this.position.z);
    this._frame.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this._frame.up.set(0, 1, 0);
    this._trackSurface = 'road';
    this._setSurface('road');
  }

  _setSurface(trackSurface) {
    const limit = this.halfWidth + this.def.wallOffset;
    const abs = Math.abs(this.lateralValue);
    let next = abs >= limit - 0.05 ? 'wall' : trackSurface;
    if (this.surface === 'wall' && next !== 'wall' && abs < limit - TUNE.wallHysteresis) {
      next = trackSurface;
    }
    if (next === this.surface) return;
    if ((next === 'wall' || this.surface === 'wall') && this._wallCooldown > 0) return;
    this.surface = next;
    this._emit('surfaceChange');
    this._wallCooldown = 0.2;
  }

  // --------------------------------------------------------------- slipstream

  _updateSlipstream(dt) {
    const list = this.nearbyKarts;
    const cfg = this.def.slipstream;
    let active = false;
    if (list && list.length > 1) {
      const maxD = cfg.distance;
      const maxLat = cfg.lateral;
      const fx = this.forward.x;
      const fz = this.forward.z;
      const rx = this.right.x;
      const rz = this.right.z;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (!o || !o.position) continue;
        if (o.kart === this.kart) continue;
        const dx = o.position.x - this.position.x;
        const dz = o.position.z - this.position.z;
        const ahead = dx * fx + dz * fz;
        if (ahead < 1.4 || ahead > maxD) continue;
        const side = dx * rx + dz * rz;
        if (side < -maxLat || side > maxLat) continue;
        const of = o.forward;
        if (of && (of.x * fx + of.z * fz) < 0.9) continue;
        const other = o.kart ? o.kart.physics : null;
        if (other && other.speed < this.speed * 0.9) continue;
        active = true;
        break;
      }
    }
    const ramp = cfg.rampTime > 0 ? cfg.rampTime : 1.1;
    if (active) this.slipstream = clamp(this.slipstream + dt / ramp, 0, 1);
    else this.slipstream = clamp(this.slipstream - dt / (ramp * 0.75), 0, 1);
    if (active && !this._slipActive && this.slipstream >= 0.999) this._emit('slipstream');
    this._slipActive = active;
  }

  // -------------------------------------------------------------------- drive

  _updateDrive(dt, d) {
    const def = this.def;
    const spinning = this.spinout.timer > 0;
    const squashing = this.squash.timer > 0;
    const throttle = clamp(d.throttle, 0, 1);
    const brake = clamp(d.brake, 0, 1);
    const steer = clamp(d.steer, -1, 1);
    this.throttle = throttle;
    this.brake = brake;
    this.steer = steer;
    this.driftHeld = !!d.drift;

    const top = this.effectiveTopSpeed();
    const surf = this.surface;
    const surfFactor = SURFACE_ACCEL[surf] == null ? 1 : SURFACE_ACCEL[surf];

    // ---- drift state machine --------------------------------------------
    if (this.drift.active) {
      if (spinning) this._endDrift(true);
      else if (!d.drift) this._endDrift(false);
      else if (steer * this.drift.dir < -0.5) this._endDrift(false);
      else if (!this.onGround) {
        // Airborne: hold the drift, freeze the charge.
      } else if (Math.abs(this.speed) < def.driftMinSpeed * 0.5) this._endDrift(true);
    } else if (!spinning && this.onGround && this._driftPressAge < 0.2 && Math.abs(steer) > 0.22 &&
      Math.abs(this.speed) > def.driftMinSpeed) {
      this._startDrift(steer > 0 ? 1 : -1);
    }

    if (this.drift.active && this.onGround && !spinning) {
      const into = clamp(steer * this.drift.dir, 0, 1);
      if (into > 0.12 && Math.abs(this.speed) > def.driftMinSpeed * 0.75) {
        const prevTier = this.drift.tier;
        this.drift.charge += dt * (0.85 + 0.4 * into);
        this.drift.tier = this._tierFor(this.drift.charge);
        if (this.drift.tier !== prevTier) {
          const ev = this._emit('driftCharge');
          ev.tier = this.drift.tier;
          ev.lastTier = prevTier;
          ev.charge = this.drift.charge;
        }
      } else {
        this.drift.charge = Math.max(0, this.drift.charge - dt * 1.6);
        this.drift.tier = this._tierFor(this.drift.charge);
      }
    }

    // ---- yaw -------------------------------------------------------------
    const r = clamp(Math.abs(this.speed) / Math.max(6, top), 0, 1);
    if (!this.onGround || spinning) {
      this._yawRate = damp(this._yawRate, 0, 10, dt);
    } else {
      let rate = lerp(def.turn.min, def.turn.max, smoothstep(r)) *
        (1 - TUNE.highSpeedAuthority * r);
      let target;
      if (this.drift.active) {
        const s = clamp(steer * this.drift.dir, -1, 1);
        const mult = 1 + (def.turn.driftMultiplier - 1) * (1 - TUNE.driftSpeedFalloff * r);
        rate *= mult * (0.55 + 0.45 * s);
        target = -this.drift.dir * rate;
      } else {
        const dirSign = this.speed < -0.35 ? -1 : 1;
        target = -steer * rate * dirSign;
      }
      this._yawRate = damp(this._yawRate, target, 15, dt);
    }
    if (spinning) {
      const spin = 10.5 - 4.5 * (1 - this.spinout.timer / Math.max(0.1, this.spinout.total));
      this.yaw = wrapAngle(this.yaw + this._spinDir * spin * dt);
    } else {
      this.yaw = wrapAngle(this.yaw + this._yawRate * dt);
    }

    // ---- longitudinal ----------------------------------------------------
    let a = 0;
    if (spinning) {
      // No control: the kart slides on, shedding speed toward a crawl.
      const crawl = Math.sign(this.speed || 1) * def.spinoutSpeedFactor * def.topSpeed;
      this.speed = damp(this.speed, crawl, TUNE.spinoutDecay, dt);
      this.lateralSpeed *= Math.exp(-4 * dt);
    } else {
      const denom = this.speed >= 0 ? Math.max(6, top) : Math.max(3, def.reverseSpeed);
      const rr = clamp(Math.abs(this.speed) / denom, 0, 1);
      // Rolling resistance + the surface's inability to carry this speed.
      const resist = def.drag * (0.55 + 0.45 * rr);
      const A = def.accel * surfFactor * (squashing ? 0.7 : 1) *
        (this.boost.timer > 0 ? TUNE.boostAccel : 1);
      // Fraction of engine pull that survives at full speed, so that full
      // throttle converges on `top` instead of sagging under it.
      const k = clamp(resist / Math.max(1, A), 0, 0.42);
      if (throttle > 0.01) a += A * throttle * (1 - (1 - k) * rr * rr * rr);
      if (brake > 0.01) {
        if (this.speed > 0.4) a -= def.brakeForce * brake * surfFactor;
        else a -= def.accel * 0.55 * brake * surfFactor;
      }
      a -= Math.sign(this.speed) * resist;
      if (surf === 'off') {
        // Grass scrubs the speed the surface cannot carry, then the engine holds
        // the reduced cap — the classic "brake hard off-road, then trundle on".
        const offCap = def.topSpeed * def.offTrackSpeedFactor;
        const over = Math.abs(this.speed) - offCap;
        if (over > 0) {
          a -= Math.sign(this.speed) *
            Math.min(def.offTrackDrag * (0.35 + 0.65 * rr), over * 9 + 1.5);
        }
      }
      if (this.drift.active) {
        a -= Math.sign(this.speed) * TUNE.driftScrub * Math.abs(this.lateralSpeed) * Math.abs(this.speed) * 0.02;
      }
    }
    this.accel = a;
    this.speed += a * dt;
    if (Math.abs(this.speed) < 0.015 && throttle < 0.01 && brake < 0.01) this.speed = 0;

    // Top speed clamp. The forward limit bleeds (so coasting never accelerates),
    // the reverse limit is hard — otherwise the reverse accel term keeps pushing
    // the kart a couple of m/s past `reverseSpeed` at the equilibrium.
    const revLim = def.reverseSpeed * (surf === 'off' ? def.offTrackSpeedFactor : 1);
    if (this.speed > top) this.speed = damp(this.speed, top, 5, dt);
    if (this.speed < -revLim) this.speed = -revLim;

    // ---- lateral slip ----------------------------------------------------
    const gripRate = def.grip *
      (SURFACE_GRIP[surf] == null ? 1 : SURFACE_GRIP[surf]) *
      (this.drift.active ? 1 - def.driftSlide : 1);
    if (this.onGround) {
      this.lateralSpeed *= Math.exp(-gripRate * dt);
      if (this.drift.active && !spinning) {
        const target = -this.drift.dir *
          Math.min(Math.abs(this.speed) * def.driftSlide * 0.55, def.driftSlideMax);
        this.lateralSpeed = damp(this.lateralSpeed, target, 7, dt);
      }
    } else {
      this.lateralSpeed *= Math.exp(-1.5 * dt);
    }

    // ---- suspension offset (visual only) ---------------------------------
    const longAccel = (this.speed - this._prevSpeed) / dt;
    this._prevSpeed = this.speed;
    const suspTarget = clamp(-longAccel * 0.0022, -TUNE.suspTravel, TUNE.suspTravel * 0.7);
    this._susp = damp(this._susp, this.onGround ? suspTarget : -TUNE.suspTravel * 0.55, 14, dt);
  }

  _tierFor(charge) {
    const tiers = this.def.driftTiers;
    let tier = 0;
    for (let i = 0; i < tiers.length; i++) if (charge >= tiers[i]) tier = i + 1;
    return tier;
  }

  _startDrift(dir) {
    const d = this.drift;
    d.active = true;
    d.dir = dir;
    d.charge = 0;
    d.tier = 0;
    d.hop = true;
    this._hopTimer = TUNE.hopTime;
    if (this.onGround) {
      this.onGround = false;
      this.height = Math.max(this.height, 0.02);
      this.verticalVelocity = this.def.hopVelocity * TUNE.hopFactor;
      this.airTime = 0;
    }
    const ev = this._emit('hopStart');
    ev.dir = dir;
    const ev2 = this._emit('driftStart');
    ev2.dir = dir;
  }

  /**
   * @param {boolean} silent true when the drift is dropped (hit, squash, too
   *   slow) — no release boost is granted and no driftRelease is emitted.
   */
  _endDrift(silent) {
    const d = this.drift;
    if (!d.active) return;
    const tier = d.tier;
    const charge = d.charge;
    const dir = d.dir;
    d.active = false;
    d.hop = false;
    d.dir = 0;
    d.charge = 0;
    d.tier = 0;
    if (silent) {
      const ev = this._emit('driftEnd');
      ev.tier = tier;
      ev.dir = dir;
      ev.silent = true;
      return;
    }
    const ev = this._emit('driftRelease');
    ev.tier = tier;
    ev.charge = charge;
    ev.dir = dir;
    if (tier <= 0) return;
    const b = this._boostFor('miniTurbo', tier);
    const applied = this.applyBoost('miniTurbo', b.duration, b.multiplier);
    const ev2 = this._emit('miniTurbo');
    ev2.tier = tier;
    ev2.duration = b.duration;
    ev2.multiplier = b.multiplier;
    ev2.silent = !applied;
  }

  _boostFor(kind, tier) {
    const b = this.def.boost || {};
    if (kind === 'miniTurbo') {
      const list = b.miniTurbo || [];
      const i = clamp((tier || 1) - 1, 0, Math.max(0, list.length - 1));
      const entry = list[i];
      if (entry) return { duration: entry.duration, multiplier: entry.multiplier };
      return { duration: 0.8, multiplier: 1.22 };
    }
    const entry = b[kind];
    if (entry && typeof entry.multiplier === 'number') {
      return { duration: entry.duration, multiplier: entry.multiplier };
    }
    return { duration: 1, multiplier: 1.2 };
  }

  // ------------------------------------------------------------------ integrate

  _integrate(dt) {
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.velocity.set(0, 0, 0);
    this.velocity.addScaledVector(this.forward, this.speed);
    this.velocity.addScaledVector(this.right, this.lateralSpeed);
    if (!this.onGround) this.velocity.y = this.verticalVelocity;
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = this.groundY + this.height;
  }

  _updateAir(dt) {
    const def = this.def;
    if (this.onGround) {
      this.height = 0;
      this.verticalVelocity = 0;
      this.airTime = 0;
      return;
    }
    this.verticalVelocity -= def.gravity * dt;
    this.height += this.verticalVelocity * dt;
    this.airTime += dt;
    if (this.height <= 0) {
      const impact = Math.max(0, -this.verticalVelocity);
      this.height = 0;
      this.verticalVelocity = 0;
      this.onGround = true;
      this.drift.hop = false;
      const at = this.airTime;
      this.airTime = 0;
      this.landImpact = Math.min(1, impact / 9);
      const ev = this._emit('land');
      ev.impact = impact;
      ev.airTime = at;
      if (impact > 7) this.speed *= 0.95;
    }
  }

  /** Snaps the kart back inside the tarmac and kills the outward velocity. */
  _clampWall() {
    const def = this.def;
    const limit = this.halfWidth + def.wallOffset;
    const lateral = this.lateralValue;
    if (Math.abs(lateral) <= limit) {
      this.touchingWall = false;
      this._setSurface(this._trackSurface);
      return;
    }
    const sign = lateral > 0 ? 1 : -1;
    const over = Math.abs(lateral) - limit;
    const nx = this._hasTrack ? -sign * this._frame.right.x : -Math.cos(this.yaw + Math.PI);
    const nz = this._hasTrack ? -sign * this._frame.right.z : -Math.sin(this.yaw + Math.PI);
    this.position.x += nx * over;
    this.position.z += nz * over;
    this.lateralValue = sign * limit;
    this.touchingWall = true;

    const outward = this.lateralSpeed * sign;
    if (outward > 0.4) {
      const impact = clamp(outward / 10, 0.05, 1);
      this.speed *= 1 - def.wallSpeedLoss * (0.45 + 0.55 * impact);
      this.lateralSpeed = -this.lateralSpeed * def.wallBounce;
      const ev = this._emit('wallHit');
      ev.impact = impact;
      ev.normal.set(nx, 0, nz);
      ev.position.copy(this.position);
      this._wallCooldown = 0.2;
    } else if (outward > 0) {
      this.lateralSpeed *= 0.2;
    }
    // Re-read the ground under the corrected position.
    if (this.track && typeof this.track.surfaceHeight === 'function') {
      try {
        const h = this.track.surfaceHeight(this.position.x, this.position.z);
        if (typeof h === 'number' && isFinite(h)) this.groundY = h;
      } catch (err) {
        /* keep the last ground height */
      }
    }
    this._setSurface('wall');
  }

  _updateBasis() {
    this.up.set(0, 1, 0);
    if (this._hasTrack) {
      this.up.copy(this._frame.up);
      if (this.up.lengthSq() < 0.5) this.up.set(0, 1, 0);
    }
    this.heightOffset = this.height + this._susp;
  }

  _updateEngine(dt) {
    const top = Math.max(6, this.effectiveTopSpeed());
    const frac = clamp(Math.abs(this.speed) / top, 0, 1);
    let gear = 0;
    for (let i = 0; i < GEARS.length; i++) if (frac >= GEARS[i] - 0.02) gear = i;
    this.gear = gear + 1;
    const bandLow = GEARS[gear];
    const bandHigh = GEARS[Math.min(GEARS.length - 1, gear + 1)];
    const span = Math.max(0.08, bandHigh - bandLow);
    const local = clamp((frac - bandLow) / span, 0, 1);
    this.rpm = clamp(0.18 + local * 0.82, 0, 1);
    this.load = clamp(this.throttle * 0.7 + Math.abs(this.steer) * 0.12 +
      (this.boost.timer > 0 ? 0.18 : 0), 0, 1);
    this._engineTick += dt;
    if (this._engineTick >= 1 / 20) {
      this._engineTick = 0;
      const ev = this._emit('engine');
      ev.load = this.load;
      ev.rpm = this.rpm;
      ev.gear = this.gear;
      ev.speed = this.speed;
    }
  }

  // ------------------------------------------------------------------ commands

  /** Sends the kart into the air with exactly enough speed to reach `height`. */
  launch(height) {
    const h = Math.max(0.15, height);
    this.onGround = false;
    this.height = Math.max(this.height, 0.02);
    this.verticalVelocity = Math.sqrt(2 * this.def.gravity * h);
    this.airTime = 0;
    this.drift.hop = false;
    const ev = this._emit('launch');
    ev.impact = h;
    return this.verticalVelocity;
  }

  /** Small drift-hop style jump using CONFIG.physics.hopVelocity. */
  hop() {
    const h = (this.def.hopVelocity * this.def.hopVelocity) / (2 * this.def.gravity);
    this.launch(h);
  }

  /**
   * Starts or upgrades a boost. The strongest multiplier always wins; a weaker
   * request can only top up a little time on an existing weaker boost.
   * @returns {boolean} true when this call took effect
   */
  applyBoost(kind, duration, multiplier) {
    const b = this.boost;
    const k = kind || 'boost';
    const dur = duration > 0 ? duration : 1;
    const mult = multiplier > 1 ? multiplier : 1.2;
    if (k === 'star') this.star = Math.max(this.star, dur);
    const cur = b.timer > 0 ? b.multiplier : 0;
    if (mult < cur - 1e-4) {
      b.timer = Math.max(b.timer, Math.min(b.total, dur * 0.3));
      return false;
    }
    const same = b.timer > 0 && Math.abs(mult - cur) < 1e-4;
    b.multiplier = mult;
    b.total = dur;
    b.timer = same ? Math.max(b.timer, dur) : dur;
    b.kind = k;
    const ev = this._emit('boostStart');
    ev.kind = k;
    ev.duration = dur;
    ev.multiplier = mult;
    return true;
  }

  /** Loses control: the kart pirouettes and its speed collapses. */
  spinOut(duration, sourceId) {
    const dur = duration > 0 ? duration : this.def.spinout;
    this.spinout.total = dur;
    this.spinout.timer = dur;
    this._spinDir = this.rng() < 0.5 ? -1 : 1;
    this._spinSource = sourceId == null ? -1 : sourceId;
    this._endDrift(true);
    this._yawRate = 0;
    this.hitCooldown = Math.max(this.hitCooldown, dur * 0.5);
    const ev = this._emit('spinoutStart');
    ev.duration = dur;
    ev.sourceId = this._spinSource;
  }

  /**
   * Lightning: shrunk, slowed and squashed flat.
   * Named `applySquash` because `squash` is the public {timer,total} state.
   */
  applySquash(duration) {
    const dur = duration > 0 ? duration : this.def.squash;
    this.squash.total = dur;
    this.squash.timer = dur;
    this.star = 0;
    this._endDrift(true);
    const ev = this._emit('squashStart');
    ev.duration = dur;
  }

  setStar(seconds) {
    const s = seconds > 0 ? seconds : 0;
    if (s > this.star) {
      this.star = s;
      const ev = this._emit('starStart');
      ev.duration = s;
    }
  }

  setInvincible(seconds) {
    if (seconds > this.invincible) this.invincible = seconds;
  }

  setShielded(seconds) {
    if (seconds > this.shielded) this.shielded = seconds;
  }

  /** Shoves the kart along its own forward axis without touching yaw. */
  nudge(metres) {
    this.position.addScaledVector(this.forward, metres);
  }

  // ------------------------------------------------------------------ getters

  /** Signed metres from the track centreline, positive to the driver's right. */
  get lateral() {
    return this.lateralValue;
  }

  get driftTier() {
    return this.drift.tier;
  }

  get boostActive() {
    return this.boost.timer > 0;
  }

  get spinoutActive() {
    return this.spinout.timer > 0;
  }

  get squashActive() {
    return this.squash.timer > 0;
  }

  get heightAboveGround() {
    return this.height;
  }

  get airborne() {
    return !this.onGround;
  }

  speedKmh() {
    return this.speed * 3.6;
  }

  _surfaceSpeedFactor() {
    const f = SURFACE_SPEED[this.surface];
    return f == null ? 1 : f;
  }

  /** Top speed right now: surface, slipstream, boost, star and status effects. */
  effectiveTopSpeed() {
    const def = this.def;
    let top = def.topSpeed * this._surfaceSpeedFactor();
    if (this.slipstream > TUNE.slipstreamOnset) {
      top *= 1 + (this.slipstream - TUNE.slipstreamOnset) * def.slipstream.speedGain;
    }
    if (this.boost.timer > 0) top *= this.boost.multiplier;
    // A star boost and the star timer must never stack (ItemSystem may use either).
    const starBoost = this.boost.timer > 0 && this.boost.kind === 'star';
    const starMult = def.boost && def.boost.star ? def.boost.star.multiplier : 1.26;
    if (this.star > 0 && !starBoost) top *= starMult;
    if (this.spinout.timer > 0) top *= def.spinoutSpeedFactor;
    if (this.squash.timer > 0) top *= def.squashSpeedFactor;
    if (this.surface === 'off') top = Math.min(top, def.topSpeed * def.offTrackSpeedFactor);
    return top;
  }

  /** Signed yaw rate in rad/s (negative = turning right). */
  get yawRate() {
    return this._yawRate;
  }

  /** Visual suspension travel in metres (compression is negative). */
  get suspensionOffset() {
    return this._susp;
  }

  /** Signed drift slide velocity in the kart's own right direction (m/s). */
  get lateralSpeedSigned() {
    return this.lateralSpeed;
  }

  /** Helper for the AI: forward speed after `t` seconds of full throttle. */
  speedAfter(t) {
    const top = this.effectiveTopSpeed();
    const k = this.def.accel / Math.max(1, top);
    return top * (1 - Math.exp(-k * t));
  }
}

export { TUNE as KART_TUNE, mergeDef as mergePhysicsDef };
export default KartPhysics;
