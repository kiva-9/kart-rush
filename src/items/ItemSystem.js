/**
 * ItemSystem — the runtime for the whole item layer.
 *
 * Owns:
 *   - the roulette (`rollFor`) — rapid weighted cycling for CONFIG.items.rouletteTime
 *     seconds, then a lock-in that emits `item:picked`;
 *   - deployment of every item (bananas dropped behind, shells fired along the
 *     track, homing red shells, mushroom boosts, star, lightning, blooper ink,
 *     Bullet Bill auto-drive, super horn);
 *   - projectile / hazard entities that live in track space (progress +
 *     lateral), so they ride the banking and the hills; pooled meshes mean
 *     nothing allocates mid-race;
 *   - sphere-overlap collision against every kart, emitting `kart:hit` /
 *     `kart:spinout` and scaling the spin by the victim's character weight;
 *   - the item-box field, its pickups and its CONFIG.items.boxRespawn timers.
 *
 * Track coordinates: `progress` 0..1 along the closed centreline, `lateral`
 * signed metres from the centreline (positive to the driver's right). World
 * positions are produced by `track.positionAt(progress, lateral)`.
 */
import * as THREE from 'three';
import { clamp, lerp, damp, deltaAngle, wrapProgress, TAU } from '../core/MathUtils.js';
import { CONFIG } from '../data/config.js';
import { getItem, rollTable, RANKS } from '../data/items.js';
import {
  ItemBox,
  buildDefaultRowData,
  rowsToSlots,
  acquireItemBoxAssets,
  releaseItemBoxAssets,
} from './ItemBox.js';

/**
 * Boxes kept alive between races so a rematch reuses the meshes instead of
 * rebuilding and re-uploading a whole field of them. Module-level on purpose:
 * an instance-level pool dies with its ItemSystem, which is exactly why the
 * instance-level `_boxPool` never contained anything.
 */
const BOX_POOL = [];
/** Generous, but bounded: a pool must never become a leak of its own. */
const BOX_POOL_MAX = 96;

/** Non-config knobs, named and documented so the item feel stays readable. */
const TUNE = {
  /** How far behind the kart a banana lands (metres). */
  bananaDrop: 2.6,
  /** Bananas ignore their owner for this long after being dropped (s). */
  bananaGrace: 0.45,
  /** Shells ignore their owner for this long after being fired (s). */
  shellGrace: 0.6,
  /** Height above the road a projectile floats (metres). */
  shellHover: 0.62,
  bananaHover: 0.36,
  /** Red-shell pursuit: turn authority (rad/s) and lookahead (metres). */
  redTurn: 5.4,
  redLookahead: 3.4,
  /** Beyond this distance from its target the red shell gives up (metres). */
  redGiveUp: 95,
  /** Bounces before a green shell starts dying early. */
  maxBounces: 7,
  /** Collection radius for an item box (metres). */
  pickupRadius: 3.5,
  /** Scale a lightning-shrunk kart is drawn at. */
  shrinkScale: 0.46,
  /** Bullet Bill plow contact radius (metres). */
  plowRadius: 3.5,
  /** Golden mushroom: total seconds of unlimited boosts, and uses granted. */
  goldenWindow: 9.5,
  goldenUses: 7,
};

export class ItemSystem {
  /**
   * @param {object} ctx game context
   * @param {{track?:object, karts?:Array, race?:object, def?:object,
   *          itemBoxRows?:Array, rng?:Function}} [opts]
   */
  constructor(ctx, opts) {
    const o = opts || {};
    this.ctx = ctx || null;
    this.bus = (ctx && ctx.bus) || (ctx && ctx.game && ctx.game.bus) || null;
    this.game = ctx && ctx.game ? ctx.game : null;
    this.track = o.track || (ctx && ctx.track) || null;
    /** @type {Array<any>} live karts */
    this.karts = Array.isArray(o.karts) ? o.karts : [];
    this.race = o.race || null;
    this.def = o.def || null;
    this.rng = typeof o.rng === 'function' ? o.rng : Math.random;

    /** @type {Array<ItemBox>} the box field */
    this.boxes = [];
    /** @type {Array<any>} projectiles + hazards in flight */
    this.entities = [];

    this.time = 0;
    this.enabled = true;

    /** kart -> roulette state */
    this._rolls = new Map();
    /** kart -> {timer} lightning shrink */
    this._shrinks = new Map();
    /** kart -> seconds of blooper ink left */
    this._inks = new Map();
    /** kart -> time the golden mushroom stops working */
    this._golden = new Map();
    /** kart -> bullet-bill drive state */
    this._bills = new Map();

    this._pools = {};
    // Boxes live longer than the ItemSystem that made them: a rematch reuses
    // them from this module-level pool instead of allocating ~70 groups, 140
    // cloned materials and a second copy of the panel textures. (The old
    // instance-level `_boxPool` was popped from but never pushed to, so it was
    // always empty and the pooling documented in ItemBox.js never happened.)
    this._boxPool = [];
    this._billPool = [];
    this._lodT = 0;
    this._loc = { progress: 0, lateral: 0, index: 0, surface: 'road' };
    this._t0 = new THREE.Vector3();
    this._t1 = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._frame = {
      index: 0, position: new THREE.Vector3(), tangent: new THREE.Vector3(),
      right: new THREE.Vector3(), up: new THREE.Vector3(), normal: new THREE.Vector3(),
      bank: 0, width: 11, curvature: 0,
    };

    this._boxAssetRef = acquireItemBoxAssets();
    this.assets = this._buildAssets();
    this._buildBoxes(o);
  }

  /* --------------------------------------------------------- procedural art */

  /** Every texture/geometry the item layer needs, built once per race. */
  _buildAssets() {
    const a = {};

    const shellGeo = new THREE.SphereGeometry(0.62, 18, 12);
    shellGeo.scale(1, 0.9, 1);
    a.shellGeo = shellGeo;

    // Banana: a partial torus lying in the XZ plane with the arc swinging
    // forward — reads instantly as a banana at racing distance.
    const bananaGeo = new THREE.TorusGeometry(0.52, 0.16, 8, 20, Math.PI * 1.15);
    bananaGeo.rotateX(-Math.PI / 2);
    a.bananaGeo = bananaGeo;

    a.shellTex = {
      greenShell: makeShellTexture('#3ecf5a'),
      redShell: makeShellTexture('#ff3b30'),
    };
    a.shellMat = {
      greenShell: new THREE.MeshStandardMaterial({
        map: a.shellTex.greenShell, roughness: 0.42, metalness: 0.14,
        emissive: new THREE.Color('#0d5a24'), emissiveIntensity: 0.6,
      }),
      redShell: new THREE.MeshStandardMaterial({
        map: a.shellTex.redShell, roughness: 0.42, metalness: 0.14,
        emissive: new THREE.Color('#5a0d0d'), emissiveIntensity: 0.6,
      }),
    };
    a.bananaMat = new THREE.MeshStandardMaterial({
      color: 0xffd60a, roughness: 0.48, metalness: 0.05,
      emissive: new THREE.Color('#6b4c00'), emissiveIntensity: 0.4,
    });

    // Shell aura so a shell reads against the tarmac and catches the bloom.
    const auraGeo = new THREE.SphereGeometry(0.88, 12, 8);
    a.auraGeo = auraGeo;
    a.auraTex = makeRadialTexture([
      [0, 'rgba(255,255,255,0.5)'],
      [0.35, 'rgba(190,255,225,0.26)'],
      [1, 'rgba(120,255,190,0)'],
    ]);
    a.auraMat = new THREE.MeshBasicMaterial({
      map: a.auraTex, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });

    // ---- Bullet Bill ----
    a.bulletMat = new THREE.MeshStandardMaterial({
      map: makeBulletTexture(), roughness: 0.34, metalness: 0.72,
      emissive: new THREE.Color('#141821'), emissiveIntensity: 0.5,
    });
    a.bulletNoseMat = new THREE.MeshStandardMaterial({
      color: 0x1b1f28, roughness: 0.4, metalness: 0.8,
    });
    a.eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
    a.pupilMat = new THREE.MeshStandardMaterial({ color: 0x0a0e1a, roughness: 0.4 });
    a.flameTex = makeRadialTexture([
      [0, 'rgba(255,255,255,0.95)'],
      [0.3, 'rgba(255,206,92,0.7)'],
      [0.65, 'rgba(255,122,45,0.28)'],
      [1, 'rgba(255,80,40,0)'],
    ]);
    a.flameMat = new THREE.SpriteMaterial({
      map: a.flameTex, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    const eyeGeo = new THREE.SphereGeometry(0.19, 12, 8);
    eyeGeo.scale(1, 1.2, 0.55);
    const bodyGeo = new THREE.CapsuleGeometry(0.4, 1.0, 5, 14);
    bodyGeo.rotateX(Math.PI / 2);
    const noseGeo = new THREE.ConeGeometry(0.38, 0.44, 14);
    noseGeo.rotateX(-Math.PI / 2);
    a.bulletGeo = {
      body: bodyGeo,
      nose: noseGeo,
      eye: eyeGeo,
      pupil: new THREE.SphereGeometry(0.085, 8, 6),
    };
    return a;
  }

  _disposeAssets() {
    const a = this.assets;
    if (!a) return;
    a.shellGeo?.dispose?.();
    a.bananaGeo?.dispose?.();
    a.auraGeo?.dispose?.();
    a.shellTex?.greenShell?.dispose?.();
    a.shellTex?.redShell?.dispose?.();
    a.shellMat?.greenShell?.dispose?.();
    a.shellMat?.redShell?.dispose?.();
    a.bananaMat?.dispose?.();
    a.auraTex?.dispose?.();
    a.auraMat?.dispose?.();
    a.bulletMat?.map?.dispose?.();
    a.bulletMat?.dispose?.();
    a.bulletNoseMat?.dispose?.();
    a.eyeMat?.dispose?.();
    a.pupilMat?.dispose?.();
    a.flameTex?.dispose?.();
    a.flameMat?.dispose?.();
    if (a.bulletGeo) {
      a.bulletGeo.body?.dispose?.();
      a.bulletGeo.nose?.dispose?.();
      a.bulletGeo.eye?.dispose?.();
      a.bulletGeo.pupil?.dispose?.();
    }
    for (const key in this._pools) this._pools[key].length = 0;
    this._billPool.length = 0;
    this.assets = null;
  }

  /* -------------------------------------------------------------- item boxes */

  /** Places the box field from the track's own rows, or the default layout. */
  _buildBoxes(o) {
    const explicit = Array.isArray(o.itemBoxRows) && o.itemBoxRows.length
      ? o.itemBoxRows
      : (Array.isArray(o.rows) && o.rows.length ? o.rows : null);
    const fromDef = !explicit && this.def && Array.isArray(this.def.itemBoxRows) &&
      this.def.itemBoxRows.length ? this.def.itemBoxRows : null;
    const rows = explicit || fromDef || buildDefaultRowData(this.track, this.def, this.ctx);
    const slots = this.track && typeof this.track.positionAt === 'function'
      ? rowsToSlots(rows, this.track)
      : fallbackSlots(rows);
    for (let i = 0; i < slots.length; i++) this._spawnBox(slots[i], i);
  }

  _spawnBox(slot, index) {
    let box = this._boxPool.pop() || BOX_POOL.pop();
    if (!box) box = new ItemBox({ assets: this._boxAssetRef });
    else box.rebind(this._boxAssetRef);
    box.place(slot.position, slot.progress, slot.lateral);
    box.index = typeof slot.slot === 'number' ? slot.slot : index;
    box.baseY = box.position.y;
    box.group.visible = true;
    this._attach(box.group);
    this.boxes.push(box);
    return box;
  }

  _attach(obj) {
    const root = this.ctx && this.ctx.raceRoot;
    if (root && obj && obj.parent !== root) root.add(obj);
  }

  /** Item-box collection: the classic drive-through-the-cube pickup. */
  _pickup() {
    const r2 = TUNE.pickupRadius * TUNE.pickupRadius;
    const boxes = this.boxes;
    for (let i = 0; i < this.karts.length; i++) {
      const kart = this.karts[i];
      if (!kart || !kart.position) continue;
      const item = kart.item;
      if (item && (item.id || item.rolling)) continue;
      const p = kart.position;
      for (let b = 0; b < boxes.length; b++) {
        const box = boxes[b];
        if (!box.active || box.visible === false) continue;
        const bp = box.position;
        if (!bp) continue;
        const dx = bp.x - p.x;
        const dz = bp.z - p.z;
        if (dx * dx + dz * dz > r2) continue;
        const dy = bp.y - p.y;
        if (dy * dy > 9) continue;
        if (box.consume(kart) === false) continue;
        this.rollFor(kart);
        this.game?.effect?.('itemBoxPop', { position: this._t0.copy(bp) });
        this.game?.sfx?.('itemRoll', { volume: 0.55 });
        break;
      }
    }
  }

  /* -------------------------------------------------------------- the roulette */

  /**
   * Starts the roulette for a kart. The item is pre-rolled, then candidates
   * cycle fast and ease out before the winner is locked in.
   * @returns {string|null} the held id when the kart already holds one, else null
   */
  rollFor(kart) {
    if (!kart) return null;
    if (!kart.item) kart.item = { id: null, count: 0, rolling: false };
    const item = kart.item;
    if (item.id || item.rolling) return item.id || null;
    const table = rollTable(this._rankOf(kart));
    const st = {
      kart,
      table,
      chosen: this._weightedPick(table),
      elapsed: 0,
      next: 0,
      current: this._weightedPick(table),
    };
    this._rolls.set(kart, st);
    item.rolling = true;
    item.id = st.current;
    item.count = 0;
    return null;
  }

  _updateRolls(dt) {
    if (this._rolls.size === 0) return;
    const total = Math.max(0.05, CONFIG.items.rouletteTime || 1.15);
    for (const [kart, st] of this._rolls) {
      st.elapsed += dt;
      const t = clamp(st.elapsed / total, 0, 1);
      // Ease the cycling rate down so the last few frames tease the winner.
      st.next -= dt;
      if (st.next <= 0) {
        st.next = lerp(0.05, 0.155, Math.pow(t, 1.7));
        st.current = t > 0.78 ? st.chosen : this._weightedPick(st.table);
        if (kart.item) kart.item.id = st.current;
      }
      if (st.elapsed >= total) {
        this._rolls.delete(kart);
        const def = getItem(st.chosen) || (st.table.length ? st.table[0].def : null);
        if (def) this.give(kart, def.id);
        else if (kart.item) {
          kart.item.id = null;
          kart.item.count = 0;
          kart.item.rolling = false;
        }
      }
    }
  }

  _weightedPick(table) {
    if (!table || !table.length) return null;
    let r = this.rng();
    for (let i = 0; i < table.length; i++) {
      r -= table[i].weight;
      if (r <= 0) return table[i].def.id;
    }
    return table[table.length - 1].def.id;
  }

  /** The item id a kart currently holds, or null (null while rolling too). */
  activeItem(kart) {
    if (!kart || !kart.item || !kart.item.id) return null;
    return getItem(kart.item.id) ? kart.item.id : null;
  }

  /** The ItemDef a kart currently holds, or null. */
  activeItemDef(kart) {
    return getItem(this.activeItem(kart));
  }

  /** Drops whatever the roulette is doing. */
  cancelRoll(kart) {
    if (!kart) return;
    this._rolls.delete(kart);
    if (kart.item) kart.item.rolling = false;
  }

  /**
   * Grants an item outright, emitting `item:picked`.
   * @param {object} kart
   * @param {string} itemId
   * @param {number} [count]
   * @returns {string|null}
   */
  give(kart, itemId, count) {
    if (!kart) return null;
    const def = getItem(itemId);
    if (!def) return null;
    this._rolls.delete(kart);
    if (!kart.item) kart.item = { id: null, count: 0, rolling: false };
    kart.item.id = def.id;
    kart.item.count = count == null ? def.count : Math.max(1, count | 0);
    kart.item.rolling = false;
    this.bus?.emit?.('item:picked', { kartId: kart.id, itemId: def.id });
    if (kart.isPlayer) this.game?.sfx?.('itemGet', { volume: 0.7 });
    return def.id;
  }

  /**
   * Fires the item the kart holds.
   * @param {object} kart
   * @returns {boolean} true when something happened
   */
  useActive(kart) {
    if (!kart || !kart.item || !kart.item.id || kart.item.rolling) return false;
    const def = getItem(kart.item.id);
    if (!def) {
      kart.item.id = null;
      kart.item.count = 0;
      return false;
    }
    let used = true;
    switch (def.id) {
      case 'banana':
      case 'tripleBanana':
        this._dropBanana(kart);
        break;
      case 'greenShell':
      case 'tripleGreenShell':
        this._fireShell(kart, 'greenShell');
        break;
      case 'redShell':
        this._fireShell(kart, 'redShell');
        break;
      case 'mushroom':
      case 'tripleMushroom':
      case 'goldenMushroom':
        this._useMushroom(kart, def);
        break;
      case 'star':
        this._useStar(kart);
        break;
      case 'lightning':
        this._useLightning(kart);
        break;
      case 'blooper':
        this._useBlooper(kart);
        break;
      case 'bulletBill':
        this._startBulletBill(kart);
        break;
      case 'superHorn':
        this._useSuperHorn(kart);
        break;
      default:
        used = false;
        break;
    }
    if (!used) return false;

    const item = kart.item;
    if (def.holdable) {
      item.count = Math.max(0, (item.count || 1) - 1);
      if (item.count <= 0) {
        item.id = null;
        item.count = 0;
      }
    } else {
      item.id = null;
      item.count = 0;
    }
    this.bus?.emit?.('item:used', { kartId: kart.id, itemId: def.id });
    const c = kart.controller;
    if (c && typeof c.onItemUsed === 'function') {
      try {
        c.onItemUsed(kart, def.id);
      } catch (err) {
        /* a broken AI hook must never stop the item working */
      }
    }
    return true;
  }

  /* ------------------------------------------------------------- deployment */

  _dropBanana(kart) {
    const e = this._acquire('banana');
    e.velocity.set(0, 0, 0);
    e.speed = 0;
    e.rate = 0;
    e.drift = 0;
    e.hover = TUNE.bananaHover;
    e.ownerId = kart.id;
    e.lifetime = CONFIG.items.bananaLifetime || 60;
    // Seeded from the kart's own progress, so a banana lands exactly behind it.
    this._spawnTrackSpace(e, kart, -TUNE.bananaDrop);
    e._px = e.position.x;
    e._pz = e.position.z;
    e.yaw = typeof kart.yaw === 'number' ? kart.yaw : 0;
    this._placeMesh(e);
    this.game?.sfx?.('bananaDrop', { volume: 0.6 });
  }

  _fireShell(kart, kind) {
    const e = this._acquire(kind);
    const speed = kind === 'redShell'
      ? (CONFIG.items.shell.redSpeed || 47)
      : (CONFIG.items.shell.greenSpeed || 42);
    const yaw = typeof kart.yaw === 'number' ? kart.yaw : (kart.group ? kart.group.rotation.y : 0);
    e.speed = speed;
    e.hover = TUNE.shellHover;
    e.ownerId = kart.id;
    e.lifetime = kind === 'redShell'
      ? (CONFIG.items.shell.redLifetime || 12)
      : (CONFIG.items.shell.greenLifetime || 8);
    e.yaw = yaw;
    e.homing = false;
    e.targetId = -1;
    e.bounces = 0;
    this._spawnTrackSpace(e, kart, 1.8);
    e._px = e.position.x;
    e._pz = e.position.z;

    if (kind === 'redShell') {
      const target = this._kartAhead(kart);
      if (target) {
        e.homing = true;
        e.targetId = target.id;
      }
      e.rate = speed;
      e.drift = 0;
    } else {
      // Fire straight out of the kart: the angle against the centreline becomes
      // the shell's lateral rate, so it ends up ricocheting off the walls.
      const trackYaw = this._yawAt(e.progress);
      const d = trackYaw == null ? 0 : deltaAngle(trackYaw, yaw);
      e.rate = speed * Math.cos(d);
      e.drift = -speed * Math.sin(d);
    }

    this._placeMesh(e);
    // Direction of travel, straight out of the kart. This used to be derived
    // from a delta against `_px/_pz`, which `_spawnTrackSpace` had already used
    // to place the mesh — so the delta was always zero and the shell came into
    // existence with a zero velocity and a yaw of exactly -pi (drawn pointing
    // backwards for its first frame, and reported as stationary to the trail
    // and hit effects as well as to the AI's incoming-shell check).
    const sy = typeof kart.yaw === 'number' ? kart.yaw : yaw;
    e.velocity.set(-Math.sin(sy), 0, -Math.cos(sy)).multiplyScalar(e.speed);
    e.yaw = sy;
    this.game?.sfx?.('shellFire', { volume: 0.7, rate: kind === 'redShell' ? 1.08 : 1 });
  }

  _useMushroom(kart, def) {
    const b = CONFIG.physics.boost || {};
    if (def.id === 'goldenMushroom') {
      const until = this._golden.get(kart);
      if (until == null || this.time >= until) {
        this._golden.set(kart, this.time + TUNE.goldenWindow);
        if (kart.item && kart.item.id === 'goldenMushroom') kart.item.count = TUNE.goldenUses;
      }
      kart.applyBoost?.('goldenMushroom', b.goldenMushroom.duration, b.goldenMushroom.multiplier);
    } else {
      kart.applyBoost?.('mushroom', b.mushroom.duration, b.mushroom.multiplier);
    }
    this.game?.sfx?.('mushroom', { volume: 0.7 });
    this.game?.effect?.('mushroomPuff', { position: this._t0.copy(kart.position), kart });
  }

  _useStar(kart) {
    const boost = (CONFIG.physics.boost && CONFIG.physics.boost.star) || {};
    const seconds = CONFIG.items.starDuration || boost.duration || 7;
    // `starTimer` is the public knob the contract names; Kart forwards it to
    // physics, and every Kart has it, so the applyBoost() fallback below can
    // never be reached. Drop the dead branch. The speed gain itself comes from
    // KartPhysics.effectiveTopSpeed(), which already multiplies by the star
    // factor while `physics.star` is above zero — applying a boost on top would
    // only double it up.
    kart.starTimer = seconds;
    this.game?.sfx?.('star', { volume: 0.8 });
    this.game?.effect?.('starSparkle', { kart });
  }

  _useLightning(kart) {
    const duration = CONFIG.items.lightningDuration || 6;
    const victims = this._kartsAhead(kart);
    for (let i = 0; i < victims.length; i++) {
      const v = victims[i];
      if (!v || v === kart) continue;
      // Lightning cannot touch a kart that is star-powered, invincible or
      // holding a shield — the same immunity `_hit()` and `_plow()` respect.
      // Without this, a star run is simply deleted by the first lightning,
      // because squash() also force-clears `physics.star`.
      const vp = v.physics;
      if (vp && (vp.star > 0 || vp.invincible > 0 || vp.shielded > 0)) continue;
      v.squash?.(duration);
      this._setShrink(v, duration);
      const phys = v.physics;
      if (phys) {
        phys.speed *= 0.45;
        if (typeof phys.lateralSpeed === 'number') phys.lateralSpeed *= 0.2;
      }
      // Lightning strips whatever the victim was holding.
      if (v.item) {
        v.item.id = null;
        v.item.count = 0;
        v.item.rolling = false;
      }
      this._rolls.delete(v);
      this.bus?.emit?.('kart:hit', { kartId: v.id, sourceId: kart.id, kind: 'lightning' });
      this.game?.effect?.('squashPuff', { position: this._t0.copy(v.position), kart: v });
      if (v.isPlayer) {
        this.game?.bus?.emit?.('fx:shake', { strength: 0.5, duration: 0.45 });
        this.game?.bus?.emit?.('fx:flash', { color: '#eaf7ff', alpha: 0.4, duration: 0.3 });
      }
    }
    this.game?.sfx?.('lightning', { volume: 0.85 });
    if (kart.isPlayer) {
      this.game?.bus?.emit?.('fx:flash', { color: '#ffffff', alpha: 0.22, duration: 0.25 });
    }
  }

  _useBlooper(kart) {
    const duration = CONFIG.items.blooperDuration || 6;
    const victims = this._kartsAhead(kart);
    const done = {};
    for (let i = 0; i < victims.length; i++) {
      const v = victims[i];
      if (!v || v === kart || done[v.id]) continue;
      done[v.id] = true;
      v.blooperTimer = Math.max(v.blooperTimer || 0, duration);
      this._inks.set(v, duration);
      this.game?.effect?.('ink', { position: this._t0.copy(v.position), kart: v });
    }
    this.game?.sfx?.('blooper', { volume: 0.8 });
    this.game?.effect?.('ink', { position: this._t0.copy(kart.position), kart });
  }

  _startBulletBill(kart) {
    // One duration, read in one place. `CONFIG.items.bulletBill.duration` used
    // to be 6.2 s while the boost the physics applies is 6.0 s, so Bullet Bill
    // held on for a fifth of a second after the speed was already gone.
    const duration = CONFIG.physics?.boost?.bulletBill?.duration
      || (CONFIG.items.bulletBill && CONFIG.items.bulletBill.duration)
      || 6.2;
    const st = this._bills.get(kart);
    if (st) {
      st.timer = Math.max(st.timer, duration);
      return;
    }
    const fresh = {
      timer: duration,
      steer: 0,
      yaw: typeof kart.yaw === 'number' ? kart.yaw : 0,
      mesh: this._billPool.pop() || this._buildBulletMesh(),
    };
    this._bills.set(kart, fresh);
    kart.bulletBill = fresh.timer;
    if (kart.group && fresh.mesh) {
      fresh.mesh.visible = true;
      fresh.mesh.position.set(0, 0.62, -1.9);
      fresh.mesh.rotation.set(0, 0, 0);
      kart.group.add(fresh.mesh);
    }
    kart.applyBoost?.('bulletBill', duration, CONFIG.physics.boost.bulletBill.multiplier);
    this.game?.sfx?.('bulletBill', { volume: 0.85 });
    if (kart.isPlayer) this.game?.bus?.emit?.('fx:shake', { strength: 0.35, duration: 0.6 });
  }

  _endBulletBill(kart, st) {
    if (st && st.mesh) {
      if (st.mesh.parent) st.mesh.parent.remove(st.mesh);
      st.mesh.visible = false;
      if (this._billPool.length < 8) this._billPool.push(st.mesh);
      st.mesh = null;
    }
    this._bills.delete(kart);
    if (kart) kart.bulletBill = 0;
  }

  /** Blows away incoming projectiles. @returns {number} how many were destroyed */
  _useSuperHorn(kart) {
    const origin = kart.position;
    // Own scratch: the fx payloads below reuse _t0, which must not clobber `fwd`.
    const fwd = this._forwardOf(kart, this._t2);
    let destroyed = 0;
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      // The horn clears shells *and* bananas — its own catalogue text promises
      // "every shell, banana and bad plan inbound", and skipping hazards here
      // meant it could never actually destroy a banana.
      if (e.kind !== 'projectile' && e.kind !== 'hazard') continue;
      if (e.ownerId === kart.id && e.age < 1.2) continue;
      const dx = e.position.x - origin.x;
      const dz = e.position.z - origin.z;
      if (dx * dx + dz * dz > 100) continue;
      if (dx * fwd.x + dz * fwd.z < -2.5) continue;
      this.game?.effect?.('shellHit', { position: this._t0.copy(e.position) });
      this._kill(e, i);
      destroyed++;
    }
    this.game?.sfx?.('superHorn', { volume: 0.8 });
    this.game?.effect?.('mushroomPuff', { position: this._t0.copy(origin), kart, intensity: 0.6 });
    if (destroyed > 0) {
      this.game?.effect?.('shellHit', { position: this._t0.copy(origin), intensity: 1 });
      if (kart.isPlayer) this.game?.bus?.emit?.('fx:shake', { strength: 0.25, duration: 0.2 });
    }
    return destroyed;
  }

  /* ------------------------------------------------------------- bullet bill */

  /**
   * What a controller should read while Bullet Bill drives this kart, or null
   * when the kart is not being driven. The system also drives the kart itself,
   * so a controller that ignores this still gets the full behaviour.
   * @param {object} kart
   */
  bulletBillControllerFor(kart) {
    const st = kart ? this._bills.get(kart) : null;
    if (!st) return null;
    return {
      active: true,
      itemId: 'bulletBill',
      // One source of truth: the duration actually handed to applyBoost(), so
      // the boost cannot lapse while Bullet Bill is still driving. The two
      // config values disagreed by 0.2 s, which dropped the kart from 51 m/s
      // back to 34 m/s for the last fifth of a second.
      timer: st.timer,
      duration: CONFIG.physics?.boost?.bulletBill?.duration || CONFIG.items.bulletBill.duration || 6.2,
      throttle: 1,
      brake: 0,
      steer: st.steer,
      drift: false,
      item: false,
      lookBack: false,
      speed: CONFIG.items.bulletBill.speed || 56,
      boostKind: 'bulletBill',
      invincible: true,
    };
  }

  /** True while the kart is under Bullet Bill control. */
  bulletBillActive(kart) {
    return kart ? this._bills.has(kart) : false;
  }

  _updateBulletBills(dt) {
    if (this._bills.size === 0) return;
    const speed = CONFIG.items.bulletBill.speed || 56;
    for (const [kart, st] of this._bills) {
      st.timer -= dt;
      const phys = kart && kart.physics;
      if (!phys || st.timer <= 0 || !kart.position) {
        this._endBulletBill(kart, st);
        continue;
      }
      kart.bulletBill = st.timer;
      // Bullet Bill cannot be stopped.
      phys.setInvincible?.(Math.min(st.timer, 1.2));

      const progress = this._progressOf(kart);
      const targetProgress = this.track && typeof this.track.advance === 'function'
        ? this.track.advance(progress, 6 + speed * 0.3)
        : progress;
      const wantYaw = this._yawAt(targetProgress);
      if (wantYaw != null) {
        // How far off the wanted heading we are *before* we snap onto it. The
        // old line measured `phys.yaw` after it had just been assigned `st.yaw`,
        // so the delta was identically zero every frame and `st.steer` — the one
        // number a controller is supposed to read — was always 0.
        const err = deltaAngle(st.yaw, wantYaw);
        st.yaw = st.yaw + err * (1 - Math.exp(-5 * dt));
        phys.yaw = st.yaw;
        st.steer = clamp(err * 2, -1, 1);
      }
      phys.lateralSpeed = damp(phys.lateralSpeed || 0, 0, 8, dt);
      phys.speed = Math.max(phys.speed, speed);
      phys.bulletSpeed = speed;
      this._plow(kart);

      if (st.mesh) {
        st.mesh.rotation.z = Math.sin(this.time * 17) * 0.05;
        st.mesh.rotation.y = Math.sin(this.time * 9) * 0.06;
        const flame = st.mesh.userData.flame;
        if (flame) {
          const f = st.mesh.userData.flameBase || (st.mesh.userData.flameBase = flame.scale.x);
          flame.scale.setScalar(f * (1 + Math.sin(this.time * 31) * 0.16));
        }
      }
    }
  }

  /** Bullet Bill shoves, spins and removes anything it touches. */
  _plow(kart) {
    const p = kart.position;
    for (let i = 0; i < this.karts.length; i++) {
      const other = this.karts[i];
      if (!other || other === kart || !other.position) continue;
      const phys = other.physics;
      if (phys && (phys.invincible > 0 || phys.star > 0 || phys.shielded > 0)) continue;
      if (phys && phys.hitCooldown > 0) continue;
      const dx = other.position.x - p.x;
      const dz = other.position.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > TUNE.plowRadius * TUNE.plowRadius) continue;
      const dur = this._spinDuration(other, 'bulletBill');
      other.spinOut?.(dur, kart.id);
      this.bus?.emit?.('kart:hit', { kartId: other.id, sourceId: kart.id, kind: 'bulletBill' });
      this.bus?.emit?.('kart:spinout', { kartId: other.id, duration: dur });
      const d = Math.sqrt(d2) || 1;
      if (phys) {
        phys.position.x += (dx / d) * 1.4;
        phys.position.z += (dz / d) * 1.4;
        phys.speed *= 0.55;
      }
      this.game?.effect?.('shellHit', { position: this._t0.copy(other.position) });
      this.game?.sfx?.('crunch', { volume: 0.7 });
      if (other.isPlayer) {
        this.game?.bus?.emit?.('fx:shake', { strength: 0.6, duration: 0.4 });
        this.game?.bus?.emit?.('fx:flash', { color: '#ffffff', alpha: 0.2, duration: 0.2 });
      }
    }
  }

  /* ------------------------------------------------------------ status timers */

  _setShrink(kart, duration) {
    this._shrinks.set(kart, { timer: duration });
    this._applyShrink(kart, TUNE.shrinkScale);
  }

  _applyShrink(kart, s) {
    const scale = kart && kart.group && kart.group.scale;
    // Kart.poseVisuals() never writes group.scale, so it is free for us to use;
    // guard anyway in case a stub kart has no Vector3 there.
    if (scale && typeof scale.setScalar === 'function') scale.setScalar(s);
  }

  _updateStatus(dt) {
    for (const [kart, st] of this._shrinks) {
      st.timer -= dt;
      let s = TUNE.shrinkScale;
      if (st.timer <= 0) {
        s = 1;
        this._shrinks.delete(kart);
      } else if (st.timer < 0.8) {
        // Grow back with a springy overshoot.
        const t = 1 - st.timer / 0.8;
        s = lerp(TUNE.shrinkScale, 1, t) * (1 + 0.16 * Math.sin(t * TAU) * (1 - t));
      }
      this._applyShrink(kart, s);
    }
    for (const [kart, t] of this._inks) {
      const next = t - dt;
      if (next <= 0) {
        this._inks.delete(kart);
        kart.blooperTimer = 0;
      } else {
        this._inks.set(kart, next);
        kart.blooperTimer = next;
      }
    }
    for (const [kart, until] of this._golden) {
      if (this.time >= until) {
        this._golden.delete(kart);
        if (kart.item && kart.item.id === 'goldenMushroom') {
          kart.item.id = null;
          kart.item.count = 0;
          kart.item.rolling = false;
        }
      }
    }
  }

  /* --------------------------------------------------------------- entities */

  _acquire(kind) {
    let pool = this._pools[kind];
    if (!pool) pool = this._pools[kind] = [];
    let e = pool.pop();
    if (!e) {
      const mesh = this._createMesh(kind);
      e = {
        kind: kind === 'banana' ? 'hazard' : 'projectile',
        itemId: kind,
        position: mesh.position,
        velocity: new THREE.Vector3(),
        ownerId: -1,
        lifetime: 0,
        age: 0,
        radius: kind === 'banana' ? 1.0 : 0.95,
        alive: true,
        progress: 0,
        lateral: 0,
        yaw: 0,
        speed: 0,
        rate: 0,
        drift: 0,
        hover: 0.55,
        targetId: -1,
        homing: false,
        bounces: 0,
        trailT: 0,
        roll: 0,
        spin: 0,
        squash: 0,
        lost: false,
        _px: 0,
        _pz: 0,
        mesh,
      };
    }
    e.kind = kind === 'banana' ? 'hazard' : 'projectile';
    e.itemId = kind;
    e.alive = true;
    e.age = 0;
    e.lifetime = 0;
    e.ownerId = -1;
    e.drift = 0;
    e.bounces = 0;
    e.homing = false;
    e.targetId = -1;
    e.trailT = 0;
    e.squash = 0;
    e.lost = false;
    this.entities.push(e);
    this._attach(e.mesh);
    e.mesh.visible = true;
    return e;
  }

  _kill(e, i) {
    if (!e) return;
    if (i == null) {
      i = this.entities.indexOf(e);
      if (i < 0) return;
    }
    this.entities.splice(i, 1);
    e.alive = false;
    if (e.mesh) {
      e.mesh.visible = false;
      if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
    }
    const pool = this._pools[e.itemId] || (this._pools[e.itemId] = []);
    if (pool.length < 32) pool.push(e);
  }

  _clearEntities() {
    for (let i = this.entities.length - 1; i >= 0; i--) this._kill(this.entities[i], i);
  }

  /** Builds the pooled mesh for one entity kind (once per kind per race). */
  _createMesh(kind) {
    const a = this.assets;
    if (kind === 'banana') {
      const m = new THREE.Mesh(a.bananaGeo, a.bananaMat);
      m.name = 'itemBanana';
      return m;
    }
    const g = new THREE.Group();
    g.name = 'itemShell';
    const shell = new THREE.Mesh(a.shellGeo, a.shellMat[kind]);
    const aura = new THREE.Mesh(a.auraGeo, a.auraMat);
    aura.scale.setScalar(1.05);
    g.add(shell);
    g.add(aura);
    g.userData.aura = aura;
    return g;
  }

  _buildBulletMesh() {
    const a = this.assets;
    const g = new THREE.Group();
    g.name = 'bulletBill';
    const body = new THREE.Mesh(a.bulletGeo.body, a.bulletMat);
    const nose = new THREE.Mesh(a.bulletGeo.nose, a.bulletNoseMat);
    nose.position.z = -0.72;
    const eyeL = new THREE.Mesh(a.bulletGeo.eye, a.eyeMat);
    eyeL.position.set(0.26, 0.13, -0.42);
    const eyeR = new THREE.Mesh(a.bulletGeo.eye, a.eyeMat);
    eyeR.position.set(-0.26, 0.13, -0.42);
    const pupL = new THREE.Mesh(a.bulletGeo.pupil, a.pupilMat);
    pupL.position.set(0.26, 0.13, -0.53);
    const pupR = new THREE.Mesh(a.bulletGeo.pupil, a.pupilMat);
    pupR.position.set(-0.26, 0.13, -0.53);
    const flame = new THREE.Sprite(a.flameMat);
    flame.scale.setScalar(1.4);
    flame.position.z = 0.92;
    g.add(body, nose, eyeL, eyeR, pupL, pupR, flame);
    g.visible = false;
    g.userData.flame = flame;
    return g;
  }

  /* ------------------------------------------------------------ track space */

  /**
   * Seats a fresh entity `ahead` metres along the track from `kart`, on the same
   * lateral offset. Derived from the kart's progress rather than a fresh
   * `locate()`, which keeps items exactly where they belong and never fights the
   * physics module over TrackPath's nearest-sample cache.
   */
  _spawnTrackSpace(e, kart, aheadMetres) {
    const track = this.track;
    const lat = this._lateralOf(kart);
    if (track && typeof track.advance === 'function' && typeof track.positionAt === 'function') {
      e.progress = wrapProgress(track.advance(this._progressOf(kart), aheadMetres));
      e.lateral = lat;
      this._placeMesh(e);
      return;
    }
    // No track API: place straight off the kart and project onto it once.
    const fwd = this._forwardOf(kart, this._t2);
    e.position.set(
      kart.position.x + fwd.x * aheadMetres,
      kart.position.y,
      kart.position.z + fwd.z * aheadMetres,
    );
    this._trackSpaceOf(e);
    this._placeMesh(e);
  }

  /** Where a world point sits on the track: writes e.progress / e.lateral. */
  _trackSpaceOf(e) {
    if (!this.track) {
      e.progress = 0;
      e.lateral = 0;
      return;
    }
    if (typeof this.track.locate === 'function') {
      const loc = this.track.locate(e.position.x, e.position.y, e.position.z, this._loc);
      if (loc && typeof loc.progress === 'number') {
        e.progress = wrapProgress(loc.progress);
        e.lateral = typeof loc.lateral === 'number' ? loc.lateral : 0;
        return;
      }
    }
    if (typeof this.track.toLocal === 'function') {
      const local = this.track.toLocal(e.position.x, e.position.y, e.position.z);
      e.progress = wrapProgress(local.progress);
      e.lateral = local.lateral;
      return;
    }
    e.progress = 0;
    e.lateral = 0;
  }

  /** Writes the world transform of an entity from its progress/lateral. */
  _placeMesh(e) {
    if (this.track && typeof this.track.positionAt === 'function') {
      this.track.positionAt(e.progress, e.lateral, e.position);
    }
    e.position.y = this._heightAt(e) + e.hover;
    const m = e.mesh;
    if (m) {
      m.position.copy(e.position);
      m.rotation.order = 'YXZ';
      m.rotation.set(e.roll, e.yaw, 0);
    }
  }

  /** Height of the road plane at the entity's track position. */
  _heightAt(e) {
    if (this.track && typeof this.track.positionAt === 'function') {
      this.track.positionAt(e.progress, e.lateral, this._t1);
      return this._t1.y;
    }
    return 0;
  }

  _halfWidthAt(progress) {
    if (!this.track) return 11;
    if (typeof this.track.frameAt === 'function') {
      const f = this.track.frameAt(progress, this._frame);
      if (f && typeof f.width === 'number' && f.width > 0.5) return f.width;
    }
    if (typeof this.track.widthAt === 'function') {
      const w = this.track.widthAt(progress);
      if (typeof w === 'number' && w > 0.5) return w;
    }
    return this.def && typeof this.def.width === 'number' ? this.def.width : 11;
  }

  _yawAt(progress) {
    if (!this.track) return null;
    if (typeof this.track.yawAt === 'function') {
      try {
        return this.track.yawAt(progress);
      } catch (err) {
        /* fall through to frameAt */
      }
    }
    if (typeof this.track.frameAt === 'function') {
      const f = this.track.frameAt(progress, this._frame);
      if (f && f.tangent) return Math.atan2(-f.tangent.x, -f.tangent.z);
    }
    return null;
  }

  /* ---------------------------------------------------------- entity steps */

  _updateEntities(dt) {
    const list = this.entities;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e.alive) continue;
      e.age += dt;
      e.lifetime -= dt;
      if (e.lifetime <= 0) {
        this._kill(e, i);
        continue;
      }
      if (e.kind === 'projectile') this._stepShell(e, dt);
      else this._stepHazard(e, dt);
      const victim = this._collide(e);
      if (victim) {
        this._hit(victim, e);
        this._kill(e, i);
      } else {
        this._trail(e, dt);
      }
    }
  }

  /**
   * Shells live in track space: `rate` metres/second along the centreline and
   * `drift` metres/second across it. Walls are then an exact lateral clamp plus
   * a damped reflection, so a shell can never leave the road.
   */
  _stepShell(e, dt) {
    const track = this.track;
    const red = e.itemId === 'redShell';

    if (red) {
      const target = this._kartById(e.targetId);
      if (!e.homing) {
        // No target when fired (e.g. fired by the leader): fly straight for its
        // whole life like a green shell.
      } else if (!target) {
        e.homing = false;
        e.lost = true;
        e.lifetime = Math.min(e.lifetime, 0.9);
      } else {
        const metres = this._metresBetween(e, target);
        if (metres > TUNE.redGiveUp) {
          e.homing = false;
          e.lost = true;
          e.lifetime = Math.min(e.lifetime, 0.9);
        } else if (track && typeof track.advance === 'function') {
          // Lookahead pursuit: aim where the target is about to be.
          const ahead = track.advance(this._progressOf(target),
            TUNE.redLookahead + Math.abs(this._speedOf(target)) * 0.22);
          const dp = signedProgressDelta(e.progress, ahead);
          const rate = dp * track.length;
          const drift = this._lateralOf(target) - e.lateral;
          const len = Math.hypot(rate, drift) || 1;
          e.rate = damp(e.rate, (rate / len) * e.speed, TUNE.redTurn, dt);
          e.drift = damp(e.drift, (drift / len) * e.speed, TUNE.redTurn, dt);
        } else {
          const dx = target.position.x - e.position.x;
          const dz = target.position.z - e.position.z;
          const len = Math.hypot(dx, dz) || 1;
          e.rate = damp(e.rate, (dx / len) * e.speed, TUNE.redTurn, dt);
          e.drift = damp(e.drift, (dz / len) * e.speed, TUNE.redTurn, dt);
        }
      }
    }

    if (!track || typeof track.advance !== 'function' || typeof track.positionAt !== 'function') {
      e.position.addScaledVector(e.velocity, dt);
      e.yaw = Math.atan2(-e.velocity.x, -e.velocity.z);
      this._placeMesh(e);
      e._px = e.position.x;
      e._pz = e.position.z;
      return;
    }

    e.progress = wrapProgress(e.progress + (e.rate * dt) / track.length);
    e.lateral += e.drift * dt;

    const limit = this._halfWidthAt(e.progress) - 0.45;
    if (Math.abs(e.lateral) > limit) {
      const sign = e.lateral > 0 ? 1 : -1;
      e.lateral = sign * limit;
      if (Math.abs(e.drift) > 0.4) {
        e.drift = -e.drift * CONFIG.items.shell.bounceDamping;
        e.rate *= CONFIG.items.shell.bounceDamping;
        e.bounces++;
        e.squash = 1;
        if (e.bounces > TUNE.maxBounces) e.lifetime = Math.min(e.lifetime, 0.5);
      } else {
        e.drift = 0;
      }
    }

    const px = e._px;
    const pz = e._pz;
    this._placeMesh(e);
    const dx = e.position.x - px;
    const dz = e.position.z - pz;
    if (dx !== 0 || dz !== 0) {
      if (dt > 0) e.velocity.set(dx / dt, 0, dz / dt);
      e.yaw = Math.atan2(-dx, -dz);
    }
    e._px = e.position.x;
    e._pz = e.position.z;

    e.squash = Math.max(0, e.squash - dt * 6);
    e.roll += (Math.abs(e.speed) * dt) / 0.62;
    const m = e.mesh;
    if (m) {
      m.rotation.order = 'YXZ';
      m.rotation.set(e.roll, e.yaw, 0);
      m.scale.setScalar(1 + e.squash * 0.22);
      const aura = m.userData && m.userData.aura;
      if (aura) aura.scale.setScalar(1.05 * (1 + e.squash * 0.5));
    }
  }

  _stepHazard(e, dt) {
    e.spin += dt;
    e.position.y = this._heightAt(e) + e.hover + Math.sin(e.spin * 2.2) * 0.04;
    const m = e.mesh;
    if (m) {
      m.position.copy(e.position);
      m.rotation.order = 'YXZ';
      m.rotation.y = e.yaw + Math.sin(e.spin * 1.6) * 0.12;
      m.rotation.z = Math.sin(e.spin * 2.4) * 0.16;
    }
    e.velocity.set(0, 0, 0);
  }

  _trail(e, dt) {
    if (e.kind !== 'projectile' || e.speed <= 0) return;
    e.trailT -= dt;
    if (e.trailT > 0) return;
    e.trailT = 0.07;
    this.game?.effect?.('shellTrail', {
      position: e.position,
      velocity: e.velocity,
      intensity: clamp(e.speed / 47, 0.4, 1),
    });
  }

  /* ------------------------------------------------------------ collisions */

  /** @returns {object|null} the kart this entity touched this step */
  _collide(e) {
    const karts = this.karts;
    const grace = e.kind === 'hazard' ? TUNE.bananaGrace : TUNE.shellGrace;
    for (let i = 0; i < karts.length; i++) {
      const kart = karts[i];
      if (!kart || !kart.position) continue;
      if (kart.finished) continue;
      if (e.age < grace && kart.id === e.ownerId) continue;
      const scale = kart.group && kart.group.scale ? (kart.group.scale.x || 1) : 1;
      const r = e.radius + (kart.radius || 1.15) * scale;
      const dx = e.position.x - kart.position.x;
      const dz = e.position.z - kart.position.z;
      if (dx * dx + dz * dz > r * r) continue;
      // Generous Y window: a shell flies over a kart mid-jump, but a kart on a
      // hill must not be able to drive through one.
      if (Math.abs(e.position.y - kart.position.y) > 3.2) continue;
      return kart;
    }
    return null;
  }

  _hit(kart, e) {
    const phys = kart.physics;
    const immune = !!phys && (phys.invincible > 0 || phys.star > 0 || phys.shielded > 0);
    const kind = e.itemId === 'banana' ? 'banana' : e.itemId;
    if (immune) {
      // A star or invincibility smashes the shell without a hiccup.
      this.game?.effect?.('shellHit', { position: this._t0.copy(e.position) });
      this.game?.sfx?.('shellHit', { volume: 0.6 });
      return;
    }
    const dur = this._spinDuration(kart, kind);
    kart.spinOut?.(dur, e.ownerId);
    this.bus?.emit?.('kart:hit', { kartId: kart.id, sourceId: e.ownerId, kind });
    this.bus?.emit?.('kart:spinout', { kartId: kart.id, duration: dur });
    this.game?.effect?.(kind === 'banana' ? 'bananaHit' : 'shellHit', {
      position: this._t0.copy(e.position),
      velocity: e.velocity,
    });
    this.game?.sfx?.(kind === 'banana' ? 'bananaHit' : 'shellHit', { volume: 0.8 });
    if (kart.isPlayer) {
      this.game?.bus?.emit?.('fx:shake', { strength: 0.5, duration: 0.32 });
      this.game?.bus?.emit?.('fx:flash', { color: '#ffffff', alpha: 0.18, duration: 0.18 });
    }
  }

  /**
   * Heavy characters shrug hits off: the spin duration follows the character's
   * weight stat (1..5), falling back to the middle of the range.
   */
  _spinDuration(kart, kind) {
    const stats = kart && kart.character && kart.character.stats ? kart.character.stats : null;
    let w = stats && typeof stats.weight === 'number' ? stats.weight : 3;
    w = clamp(w, 1, 5);
    const factor = 1.16 - 0.4 * ((w - 1) / 4);
    let dur = (CONFIG.physics.spinout || 1.35) * factor;
    if (kind === 'redShell' || kind === 'bulletBill') dur *= 1.08;
    return dur;
  }

  /* ---------------------------------------------------------------- queries */

  _rankOf(kart) {
    if (!kart) return 1;
    const r = kart.rank;
    if (typeof r === 'number' && isFinite(r) && r >= 1) return Math.min(RANKS, Math.floor(r));
    if (this.race && Array.isArray(this.race.standings)) {
      const i = this.race.standings.indexOf(kart);
      if (i >= 0) return i + 1;
    }
    return clamp(Math.ceil((this.karts.length + 1) / 2), 1, RANKS);
  }

  _progressOf(kart) {
    if (!kart) return 0;
    // 1. RaceDirector's own notion of progress (authoritative, once the race runs).
    const lp = kart.lapProgress;
    if (typeof lp === 'number' && isFinite(lp) && lp > 0) return wrapProgress(lp);
    const rp = kart.raceProgress;
    if (typeof rp === 'number' && isFinite(rp) && rp > 0) return wrapProgress(rp);
    // 2. The kart's own last locate() result — accurate and free, but only while
    //    the physics actually has a track (otherwise it reports the flat-arena
    //    fallback). Skipped deliberately when it would be meaningless.
    const phys = kart.physics;
    if (phys && phys.track && typeof phys.progress === 'number' && isFinite(phys.progress) && phys.progress > 0) {
      return wrapProgress(phys.progress);
    }
    // 3. Ask the track ourselves. Only reached at spawn time, so it cannot fight
    //    the physics module over TrackPath's nearest-sample cache.
    if (kart.position && this.track && typeof this.track.locate === 'function') {
      const loc = this.track.locate(kart.position.x, kart.position.y, kart.position.z, this._loc);
      if (loc && typeof loc.progress === 'number' && isFinite(loc.progress)) {
        return wrapProgress(loc.progress);
      }
    }
    return 0;
  }

  _lateralOf(kart) {
    const phys = kart && kart.physics;
    if (phys && phys.track) {
      if (typeof phys.lateral === 'number' && isFinite(phys.lateral)) return phys.lateral;
      if (typeof phys.lateralValue === 'number' && isFinite(phys.lateralValue)) return phys.lateralValue;
    }
    if (kart && kart.position && this.track && typeof this.track.locate === 'function') {
      const loc = this.track.locate(kart.position.x, kart.position.y, kart.position.z, this._loc);
      if (loc && typeof loc.lateral === 'number' && isFinite(loc.lateral)) return clamp(loc.lateral, -40, 40);
    }
    return 0;
  }

  _speedOf(kart) {
    const phys = kart && kart.physics;
    return phys && typeof phys.speed === 'number' ? phys.speed : 0;
  }

  /** Fresh forward vector (yaw derived, so a kart that has not stepped yet still works). */
  _forwardOf(kart, out) {
    const yaw = kart && typeof kart.yaw === 'number'
      ? kart.yaw
      : (kart && kart.group ? kart.group.rotation.y : 0);
    return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  }

  _kartById(id) {
    if (id == null || id < 0) return null;
    for (let i = 0; i < this.karts.length; i++) {
      if (this.karts[i] && this.karts[i].id === id) return this.karts[i];
    }
    return null;
  }

  /** The kart one place ahead: rank ordering, else the nearest by progress. */
  _kartAhead(kart) {
    if (!kart) return null;
    const rank = this._rankOf(kart);
    const karts = this.karts;
    const mine = this._progressOf(kart);
    let best = null;
    let bestScore = -Infinity;
    let fallback = null;
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (!k || k === kart) continue;
      const r = this._rankOf(k);
      const d = signedProgressDelta(mine, this._progressOf(k));
      if (r === rank - 1) return k;
      if (r > rank) continue;
      // Same rank (no race data yet): fall back to whoever is physically ahead.
      if (d > 0.002) {
        const score = -d - r * 0.001;
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      } else if (fallback == null && d > -0.2) {
        fallback = k;
      }
    }
    return best || fallback;
  }

  /** Every kart ranked ahead of this one, with a progress-based fallback. */
  _kartsAhead(kart) {
    const out = [];
    if (!kart) return out;
    const rank = this._rankOf(kart);
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (!k || k === kart) continue;
      if (this._rankOf(k) < rank) out.push(k);
    }
    if (out.length) return out;
    const mine = this._progressOf(kart);
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (!k || k === kart) continue;
      const dp = signedProgressDelta(mine, this._progressOf(k));
      if (dp > 0.002 && dp < 0.5) out.push(k);
    }
    return out;
  }

  /** Signed metres along the track between an entity and a kart. */
  _metresBetween(e, kart) {
    const dp = signedProgressDelta(e.progress, this._progressOf(kart));
    const length = this.track && this.track.length ? this.track.length : 1000;
    const byTrack = Math.abs(dp) * length;
    const byWorld = e.position.distanceTo(kart.position);
    // The kart may be far along the road but geometrically close (track folds);
    // use whichever is larger so a shell never gives up on a live target.
    return Math.max(byTrack, byWorld * 0.35);
  }

  /* -------------------------------------------------------------- main loop */

  /** Fixed 120 Hz step. */
  update(dt) {
    let step = dt;
    if (!(step > 0)) step = 1 / 120;
    if (step > 0.1) step = 0.1;
    if (!this.enabled) return;
    this.time += step;

    this._updateRolls(step);
    this._updateStatus(step);
    this._updateBulletBills(step);
    for (let i = 0; i < this.boxes.length; i++) this.boxes[i].update(step);
    this._updateBoxLod(step);
    this._pickup();
    this._updateEntities(step);
  }

  /** View-rate hook: keeps the additive auras breathing. */
  updateView(dt) {
    const step = dt > 0 ? dt : 1 / 60;
    void step;
    for (let i = 0; i < this.entities.length; i++) {
      const aura = this.entities[i].mesh && this.entities[i].mesh.userData
        ? this.entities[i].mesh.userData.aura
        : null;
      if (aura) aura.scale.setScalar(1.05 * (1 + 0.07 * Math.sin(this.time * 14 + i)));
    }
    for (const [, st] of this._bills) {
      if (st && st.mesh) st.mesh.rotation.x = Math.sin(this.time * 7) * 0.04;
    }
  }

  /**
   * Cheap distance LOD for the box field: the additive auras are the prettiest
   * part of a box but the most expensive, so distant boxes drop them. Runs a
   * few times a second, never per frame.
   */
  _updateBoxLod(dt) {
    this._lodT -= dt;
    if (this._lodT > 0) return;
    this._lodT = 0.25;
    const cam = this.ctx && this.ctx.camera;
    const boxes = this.boxes;
    if (!cam || !boxes.length) return;
    const cx = cam.position.x;
    const cy = cam.position.y;
    const cz = cam.position.z;
    for (let i = 0; i < boxes.length; i++) {
      const aura = boxes[i].aura;
      if (!aura) continue;
      const p = boxes[i].position;
      const dx = p.x - cx;
      const dy = p.y - cy;
      const dz = p.z - cz;
      aura.visible = boxes[i].active && (dx * dx + dy * dy + dz * dz) < 4200;
    }
  }

  /** Clears the race state without tearing the meshes down. */
  reset() {
    this._clearEntities();
    for (const kart of this._shrinks.keys()) this._applyShrink(kart, 1);
    this._shrinks.clear();
    this._inks.clear();
    this._golden.clear();
    for (const [kart, st] of this._bills) this._endBulletBill(kart, st);
    this._rolls.clear();
    for (let i = 0; i < this.boxes.length; i++) this.boxes[i].reset(true);
  }

  dispose() {
    this.enabled = false;
    this._clearEntities();
    for (const [kart, st] of this._bills) this._endBulletBill(kart, st);
    for (const kart of this._shrinks.keys()) this._applyShrink(kart, 1);
    // Pooled boxes keep their meshes and their shared-asset reference, so the
    // next race gets them straight back out of BOX_POOL. Anything past the cap
    // would be a genuine leak, so those are torn down instead.
    for (const box of this.boxes) {
      if (BOX_POOL.length < BOX_POOL_MAX) {
        box.release();
        BOX_POOL.push(box);
      } else {
        box.dispose();
      }
    }
    this.boxes.length = 0;
    for (const box of this._boxPool) box.dispose();
    this._boxPool.length = 0;
    if (this._boxAssetRef) {
      releaseItemBoxAssets();
      this._boxAssetRef = null;
    }
    this._golden.clear();
    this._rolls.clear();
    this._shrinks.clear();
    this._inks.clear();
    this._disposeAssets();
    this.karts = [];
    this.track = null;
    this.race = null;
  }
}

/* ------------------------------------------------------------ local helpers */

/** Signed shortest progress delta, -0.5..0.5. */
function signedProgressDelta(from, to) {
  let d = to - from;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

/** Boxes on a circle, used when no track is available (standalone / tests). */
function fallbackSlots(rows) {
  const slots = [];
  const list = Array.isArray(rows) ? rows : [];
  let i = 0;
  for (const r of list) {
    const p = typeof r.position === 'number' ? r.position : (typeof r.p === 'number' ? r.p : 0);
    const count = Math.max(1, Math.floor(r.count || 5));
    for (let k = 0; k < count; k++) {
      const t = count === 1 ? 0.5 : k / (count - 1);
      const a = p * TAU;
      const radius = 46 + t * 12;
      slots.push({
        progress: p,
        lateral: 0,
        position: new THREE.Vector3(Math.cos(a) * radius, 1.2, Math.sin(a) * radius),
        row: i,
        slot: k,
      });
    }
    i++;
  }
  return slots;
}

/** 128px shell texture: dome gradient, white spots, dark rim, top highlight. */
function makeShellTexture(base) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, S);
  grad.addColorStop(0, mixHex('#ffffff', base, 0.45));
  grad.addColorStop(0.42, base);
  grad.addColorStop(1, mixHex('#000000', base, 0.45));
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);

  g.fillStyle = 'rgba(255,255,255,0.94)';
  const spots = [[30, 30, 13], [86, 26, 10], [58, 54, 9], [104, 62, 7], [14, 68, 8]];
  for (let i = 0; i < spots.length; i++) {
    g.beginPath();
    g.arc(spots[i][0], spots[i][1], spots[i][2], 0, TAU);
    g.fill();
  }
  // Dark rim at the equator.
  g.strokeStyle = 'rgba(0,0,0,0.28)';
  g.lineWidth = 9;
  g.beginPath();
  g.moveTo(0, S * 0.78);
  g.bezierCurveTo(S * 0.3, S * 0.62, S * 0.7, S * 0.62, S, S * 0.78);
  g.stroke();
  // Top-left sheen.
  g.globalAlpha = 0.5;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.ellipse(S * 0.34, S * 0.2, 20, 10, -0.5, 0, TAU);
  g.fill();
  g.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Bullet Bill body: dark metal plating with panel lines and rivets. */
function makeBulletTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, S);
  grad.addColorStop(0, '#8d97a8');
  grad.addColorStop(0.35, '#4a5160');
  grad.addColorStop(0.72, '#252a35');
  grad.addColorStop(1, '#12161e');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.lineWidth = 3;
  for (let i = 1; i < 4; i++) {
    const x = (i / 4) * S;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, S);
    g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.22)';
  for (let y = 18; y < S; y += 34) {
    for (let x = 14; x < S; x += 34) {
      g.beginPath();
      g.arc(x, y, 2.4, 0, TAU);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft radial sprite texture (shell auras, bullet flames). */
function makeRadialTexture(stops) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
  for (let i = 0; i < stops.length; i++) grad.addColorStop(stops[i][0], stops[i][1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function mixHex(a, b, t) {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const k = clamp(t, 0, 1);
  const out = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return 'rgb(' + out[0] + ',' + out[1] + ',' + out[2] + ')';
}

function hexToRgb(hex) {
  const raw = String(hex || '#ffffff').replace('#', '');
  const full = raw.length === 3 ? raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2] : raw.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export default ItemSystem;
