/**
 * Kart — the race entity that ties physics, model and race state together.
 *
 * A Kart owns:
 *   - a `KartPhysics` instance (the only writer of motion),
 *   - a `KartModel` (group + body + driver, purely visual),
 *   - the race bookkeeping the RaceDirector reads (lap, rank, progress, times),
 *   - the transient status flags the ItemSystem pokes at.
 *
 * `update(dt)` samples the controller and steps physics + visuals; the
 * integrator calls it once per fixed 120 Hz step.
 */
import * as THREE from 'three';
import { KartPhysics } from '../physics/KartPhysics.js';
import { KartModel } from './KartModel.js';
import { CONFIG } from '../data/config.js';

/** Neutral DriveInput used when no controller is attached. */
const IDLE_DRIVE = {
  throttle: 0, brake: 0, steer: 0, drift: false, driftPressed: false, item: false,
};

export class Kart {
  /**
   * @param {object} ctx game context (may be a partial stub when standalone)
   * @param {object} opts see createKart()
   */
  constructor(ctx, opts) {
    const o = opts || {};
    this.ctx = ctx;
    this.id = o.id == null ? 0 : o.id;
    this.slot = o.slot == null ? this.id : o.slot;
    this.isPlayer = !!o.isPlayer;
    this.name = o.driverName || ('Kart ' + (this.id + 1));
    /** @type {string|null} */
    this.characterId = o.characterId || null;
    /** @type {any} CharacterDef — set by Bootstrap once characters.js lands */
    this.character = o.character || null;
    this.rng = typeof o.rng === 'function' ? o.rng : Math.random;
    this.color = o.color || '#e8352f';

    const quality = ctx && ctx.quality ? ctx.quality : null;
    // Tessellation tier follows the renderer's budget, not just the shadow flag:
    // 8 karts are on screen at once, so 'medium' trims ~30k triangles.
    let detail = 'high';
    if (quality) {
      if (quality.shadows === false) detail = 'low';
      else if (quality.pixelRatio != null && quality.pixelRatio <= 1.5) detail = 'medium';
    }
    this.detail = detail;

    // ---- physics ----
    this.physicsDef = o.physicsDef || null;
    const track = (ctx && ctx.track) || (o.track) || null;
    this.physics = new KartPhysics(this.physicsDef || CONFIG.physics, track, this.rng);
    this.physics.kart = this;
    this.physics.kartId = this.id;

    // ---- scene graph ----
    this.group = new THREE.Group();
    this.group.name = 'kart' + this.id;
    this.group.rotation.order = 'YXZ';
    this.model = new KartModel({
      color: this.color,
      palette: this.character ? this.character.palette : null,
      body: this.character ? this.character.body : null,
      detail: this.detail,
      scale: this.character && this.character.scale ? this.character.scale : 1,
      rng: this.rng,
    });
    this.group.add(this.model.group);
    /** The kart + driver as one object: what rolls, pitches and squashes. */
    this.body = this.model.body;

    // ---- controller ----
    /** @type {any} set by Bootstrap (AIDriver | PlayerController | null) */
    this.controller = null;
    this._drive = { ...IDLE_DRIVE };

    // ---- race state (RaceDirector owns the values, they live here) ----
    this.lap = 0;
    this.raceProgress = 0;
    this.lapProgress = 0;
    this.rank = this.id + 1;
    this.finished = false;
    this.finishTimeMs = null;
    this.startPosition = this.slot + 1;
    this.lapTimesMs = [];
    this.bestLapMs = null;
    this.lastLapMs = null;

    // ---- item slot ----
    this.item = { id: null, count: 0, rolling: false };

    // ---- transient state ----
    this.hitCooldown = 0;
    this.boostActive = false;
    this._lastItemUse = 0;
    this._sceneTime = 0;
    this._appliedCharacter = this.character;
    this._appliedColor = this.color;
    this._stopped = false;

    this.radius = this.physics.radius;
  }

  // ------------------------------------------------------------------ accessors

  get position() {
    return this.physics.position;
  }

  get velocity() {
    return this.physics.velocity;
  }

  get yaw() {
    return this.physics.yaw;
  }

  set yaw(v) {
    this.physics.yaw = v;
  }

  get speed() {
    return this.physics.speed;
  }

  set speed(v) {
    this.physics.speed = v;
  }

  get speedKmh() {
    return this.physics.speedKmh();
  }

  get forward() {
    return this.physics.forward;
  }

  get surface() {
    return this.physics.surface;
  }

  get spinTimer() {
    return this.physics.spinout.timer;
  }

  set spinTimer(v) {
    this.physics.spinout.timer = v;
    if (v > 0 && this.physics.spinout.total < v) this.physics.spinout.total = v;
    if (v <= 0) this.physics.spinout.timer = 0;
  }

  get squashTimer() {
    return this.physics.squash.timer;
  }

  set squashTimer(v) {
    this.physics.squash.timer = v;
    if (v > 0 && this.physics.squash.total < v) this.physics.squash.total = v;
    if (v <= 0) this.physics.squash.timer = 0;
  }

  get starTimer() {
    return this.physics.star;
  }

  set starTimer(v) {
    this.physics.setStar(v || 0);
  }

  get boostTimer() {
    return this.physics.boost.timer;
  }

  get driftTier() {
    return this.physics.drift.tier;
  }

  // -------------------------------------------------------------------- loop

  /** Steps physics from the controller then poses every visual. */
  update(dt) {
    this._syncCharacter();
    const c = this.controller;
    let drive = this._drive;
    if (c && typeof c.sample === 'function') {
      const d = c.sample(dt, this, this.ctx);
      if (d) drive = d;
    } else {
      drive.throttle = 0;
      drive.brake = 0;
      drive.steer = 0;
      drive.drift = false;
      drive.driftPressed = false;
    }
    this.physics.update(dt, drive);
    this.boostActive = this.physics.boost.timer > 0;
    this.hitCooldown = this.physics.hitCooldown;
    this.poseVisuals(dt);
  }

  /** Mirrors physics state onto the meshes. Safe to call every frame. */
  poseVisuals(dt) {
    const p = this.physics;
    this.group.position.copy(p.position);
    this.group.rotation.y = p.yaw;
    this.model.update(dt, {
      speed: p.speed,
      steer: p.steer,
      throttle: p.throttle,
      brake: p.brake,
      yawRate: p.yawRate,
      driftActive: p.drift.active,
      driftDir: p.drift.dir,
      driftTier: p.drift.tier,
      boosting: p.boost.timer > 0,
      boostKind: p.boost.kind,
      squash: p.squash.timer > 0 ? 1 : 0,
      star: p.star,
      onGround: p.onGround,
      height: p.height,
      susp: p.suspensionOffset,
      bank: p.bank,
      landImpact: p.landImpact,
      shadow: true,
    });
  }

  /** Cheap view-only pose used by menus (no physics step). */
  updateView(dt) {
    this.poseVisuals(dt);
  }

  _syncCharacter() {
    if (this.character !== this._appliedCharacter) {
      this._appliedCharacter = this.character;
      if (this.character) {
        if (this.character.body) this.model.setBody(this.character.body);
        if (this.character.palette) this.model.setPalette(this.character.palette);
        if (this.character.scale) this.model.driver.root.scale.setScalar(this.character.scale);
      }
    }
    if (this.color !== this._appliedColor && /^#[0-9a-f]{3,8}$/i.test(this.color)) {
      this._appliedColor = this.color;
      this.model.setColor(this.color);
    }
  }

  // ------------------------------------------------------------------ commands

  /** @param {string} itemId @param {number} [count] */
  applyItem(itemId, count) {
    this.item.id = itemId || null;
    this.item.count = count == null ? 1 : count;
    this.item.rolling = false;
  }

  clearItem() {
    this.item.id = null;
    this.item.count = 0;
    this.item.rolling = false;
  }

  giveBoost(kind, duration, multiplier) {
    this.applyBoost(kind, duration, multiplier);
  }

  applyBoost(kind, duration, multiplier) {
    const d = duration > 0 ? duration : 1;
    const m = multiplier > 1 ? multiplier : 1.2;
    this.physics.applyBoost(kind, d, m);
    this.boostActive = this.physics.boost.timer > 0;
  }

  spinOut(duration, sourceId) {
    const d = duration > 0 ? duration : CONFIG.physics.spinout;
    this.physics.spinOut(d, sourceId);
    this.hitCooldown = this.physics.hitCooldown;
  }

  squash(duration) {
    const d = duration > 0 ? duration : CONFIG.physics.squash;
    this.physics.applySquash(d);
  }

  setStar(seconds) {
    this.physics.setStar(seconds);
  }

  setInvincible(seconds) {
    this.physics.setInvincible(seconds);
  }

  /** Pythagorean nudge along a world direction (shell hits, explosions). */
  knock(dirX, dirZ, force) {
    this.physics.position.x += dirX * force;
    this.physics.position.z += dirZ * force;
  }

  /** Places the kart on the grid and clears every transient state. */
  resetForRace(transform) {
    this.physics.reset(transform);
    this.item.id = null;
    this.item.count = 0;
    this.item.rolling = false;
    this.finished = false;
    this.finishTimeMs = null;
    this.lapTimesMs.length = 0;
    this.bestLapMs = null;
    this.lastLapMs = null;
    this.hitCooldown = 0;
    this.boostActive = false;
    this._drive.throttle = 0;
    this._drive.brake = 0;
    this._drive.steer = 0;
    this._drive.drift = false;
    this._drive.driftPressed = false;
    this._drive.item = false;
    this.group.position.copy(this.physics.position);
    this.group.rotation.y = this.physics.yaw;
    this.model.update(1 / 60, {
      speed: 0, steer: 0, throttle: 0, brake: 0, onGround: true, height: 0, susp: 0,
    });
  }

  // ------------------------------------------------------------------ teardown

  dispose() {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.model.dispose();
    this.physics.dispose();
    this.controller = null;
    this.ctx = null;
  }
}

export default Kart;
