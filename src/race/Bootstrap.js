/**
 * Race bootstrap: the integration seam that wires track, karts, AI, items, race rules,
 * particles, camera and audio together, and translates low-level events into
 * fx/audio so no module has to know about another.
 *
 * Owned by the integrator. See docs/CONTRACT.md.
 */
import * as THREE from 'three';

import { CONFIG } from '../data/config.js';
import { GameStore, MODES } from '../core/Store.js';
import { clamp, mulberry32 } from '../core/MathUtils.js';

/**
 * Every subsystem is imported through a literal `import()` so the bundler can
 * see and chunk it; `safe()` then makes a failed load non-fatal, so a single
 * broken module can never stop the race from building.
 * @template T
 * @param {Promise<T>} p
 * @param {string} what
 * @returns {Promise<T|null>}
 */
async function safe(p, what) {
  try {
    return await p;
  } catch (err) {
    console.error('[bootstrap] failed to load ' + what, err);
    return null;
  }
}

function pick(m, ...names) {
  if (!m) return null;
  for (const n of names) if (n && typeof m[n] === 'function') return m[n];
  if (typeof m.default === 'function') return m.default;
  return null;
}

const ITEM_USE_COOLDOWN = 0.22;

export class RaceSession {
  constructor(ctx, config, audio) {
    this.ctx = ctx;
    this.config = config;
    this.audio = audio;
    this.karts = [];
    this.disposers = [];
    this.time = 0;
    this._nearby = [];
    this._prevProgress = new Map();
    this._padCooldown = new Set();
    this._ready = false;
    this._lastPlayerInput = 0;
    this._afkDriver = null;
    this._playerController = null;
    this._aiCtor = null;
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
  }

  async build() {
    const { ctx } = this;
    const { bus, game, state } = { bus: ctx.bus, game: ctx.game, state: GameStore.state };
    // The config the UI hands to `race:request` is authoritative for anything it
    // names; the store is the fallback. Without this the whole block was dead
    // — `startRace(ctx, cfg)` re-emitted the config on `race:build` and then
    // ignored it, so a caller that asked for a track, lap count, field size or
    // character got whatever the store happened to hold.
    const cfg = this.config || {};
    const overrides = {};
    if (cfg.trackId) overrides.trackId = cfg.trackId;
    if (Number.isFinite(cfg.laps)) overrides.laps = Math.max(1, Math.floor(cfg.laps));
    if (Number.isFinite(cfg.playerCount)) overrides.playerCount = Math.max(1, Math.floor(cfg.playerCount));
    if (cfg.characterId) overrides.characterId = cfg.characterId;
    if (cfg.quality) overrides.quality = cfg.quality;
    if (cfg.difficulty) overrides.difficulty = cfg.difficulty;
    if (cfg.cc) overrides.cc = cfg.cc;
    if (Object.keys(overrides).length) GameStore.set(overrides);
    const state2 = GameStore.state;
    void state2;

    const tracksMod = await safe(import('../data/tracks.js'), 'data/tracks.js');
    const charsMod = await safe(import('../data/characters.js'), 'data/characters.js');
    const pathMod = await safe(import('../world/TrackPath.js'), 'world/TrackPath.js');
    const buildMod = await safe(import('../world/TrackBuilder.js'), 'world/TrackBuilder.js');
    const decorMod = await safe(import('../world/Decor.js'), 'world/Decor.js');
    const kartFactMod = await safe(import('../entities/KartFactory.js'), 'entities/KartFactory.js');
    const aiMod = await safe(import('../ai/AIDriver.js'), 'ai/AIDriver.js');
    const playerMod = await safe(import('../ai/PlayerController.js'), 'ai/PlayerController.js');
    const itemsMod = await safe(import('../items/ItemSystem.js'), 'items/ItemSystem.js');
    const raceMod = await safe(import('../race/RaceDirector.js'), 'race/RaceDirector.js');
    const fxMod = await safe(import('../fx/Particles.js'), 'fx/Particles.js');
    const rigMod = await safe(import('../fx/CameraRig.js'), 'fx/CameraRig.js');
    const shakeMod = await safe(import('../fx/CameraShake.js'), 'fx/CameraShake.js');

    const getTrackFn = pick(tracksMod, 'getTrack') || (() => null);
    const getCharacterFn = pick(charsMod, 'getCharacter') || (() => null);
    const TrackPathCtor = pick(pathMod, 'TrackPath');
    const TrackBuilderCtor = pick(buildMod, 'TrackBuilder');
    const buildDecorFn = pick(decorMod, 'buildDecor');
    const createKartFn = pick(kartFactMod, 'createKart');
    const AIDriverCtor = pick(aiMod, 'AIDriver');
    const PlayerControllerCtor = pick(playerMod, 'PlayerController');
    const ItemSystemCtor = pick(itemsMod, 'ItemSystem');
    const RaceDirectorCtor = pick(raceMod, 'RaceDirector');
    const ParticlesCtor = pick(fxMod, 'Particles');
    const CameraRigCtor = pick(rigMod, 'CameraRig');
    const CameraShakeCtor = pick(shakeMod, 'CameraShake');

    if (!TrackPathCtor || !TrackBuilderCtor || !createKartFn) {
      console.error('[bootstrap] critical modules missing', {
        TrackPathCtor: !!TrackPathCtor,
        TrackBuilderCtor: !!TrackBuilderCtor,
        createKartFn: !!createKartFn,
      });
      return false;
    }

    const def = getTrackFn(state2.trackId) || (tracksMod && tracksMod.TRACKS && tracksMod.TRACKS[0]);
    if (!def) {
      console.error('[bootstrap] no track definition found');
      return false;
    }
    this.trackDef = def;

    // ---- world ----------------------------------------------------------------
    this.path = new TrackPathCtor(def);
    // Publish the track on the context too, so anything that builds a kart (or a
    // projectile) without being handed one explicitly still gets the real ribbon.
    ctx.track = this.path;
    ctx.trackDef = def;
    this.builder = new TrackBuilderCtor(ctx, def, this.path);
    this.builder.build?.();
    this.world = this.builder.group || new THREE.Group();
    ctx.worldRoot.add(this.world);
    if (this.builder.checkpoints) this.path.checkpoints = this.builder.checkpoints;
    else if (def.checkpoints) this.path.checkpoints = def.checkpoints;

    if (typeof buildDecorFn === 'function') {
      try {
        this.decor = buildDecorFn(ctx, def, this.path, ctx.worldRoot);
      } catch (err) {
        console.error('[bootstrap] decor failed', err);
      }
    }

    // ---- racers ---------------------------------------------------------------
    // A Time Trial is a solo run. The UI asks for it by parking
    // `store.state2.playerCount` at 1, which `clamp(1, 2, 8)` used to turn
    // straight back into 2 — so "Time Trial" started an ordinary 2-kart race
    // with an AI rival, and there was no way to ask for a field of one.
    const timeTrial = this.config && this.config.timeTrial === true;
    const count = timeTrial ? 1 : clamp(state2.playerCount | 0, 2, 8);
    const driverNames = ['Bolt', 'Verdi', 'Aurelia', 'Tiko', 'Fungi', 'Kongo', 'Bruto', 'Gordo'];
    const seed = 0x9e3779b9;
    const rng = mulberry32(seed);

    const grid = this._computeGrid(def, count);
    this.grid = grid;

    const playerCharacter = state2.characterId || 'bolt';

    // The field is the roster read in order starting just after the player's own
    // pick, so no two karts share a character unless there are more karts than
    // racers on the roster.
    const roster = (charsMod && charsMod.CHARACTERS && charsMod.CHARACTERS.length)
      ? charsMod.CHARACTERS.map((c) => c.id)
      : driverNames;
    const playerIdx = Math.max(0, roster.indexOf(playerCharacter));

    for (let i = 0; i < count; i++) {
      const isPlayer = i === 0;
      const characterId = isPlayer ? playerCharacter : roster[(playerIdx + i) % roster.length];
      const character = getCharacterFn ? getCharacterFn(characterId) : null;
      const slot = grid[i];
      const kart = createKartFn(ctx, {
        id: i,
        isPlayer,
        characterId,
        slot: i,
        track: this.path,
        // The character must be handed to the factory itself, not attached
        // afterwards: createPhysicsDef() bakes the per-racer tuning (top speed,
        // accel, turn, mass) into the kart's physics at construction time.
        character,
        driverName: (character && character.name) || driverNames[i % driverNames.length],
        rng,
        color: character ? character.color : '#ffffff',
      });
      kart.character = character;
      kart.startPosition = i + 1;
      ctx.raceRoot.add(kart.group);
      kart.resetForRace?.(slot);
      this.karts.push(kart);
    }
    this.player = this.karts[0];

    // ---- controllers ----------------------------------------------------------
    const difficultySkill = { easy: 0.52, normal: 0.72, hard: 0.88, insane: 1.0 }[state2.difficulty] ?? 0.72;
    this.controllers = this.karts.map((kart, i) => {
      if (i === 0 && PlayerControllerCtor) {
        const c = new PlayerControllerCtor(ctx);
        c.kart = kart;
        c.items = null;
        return c;
      }
      if (!AIDriverCtor) return null;
      const c = new AIDriverCtor({
        skill: clamp(difficultySkill + (rng() - 0.5) * 0.14, 0.3, 1.0),
        difficulty: state2.difficulty,
        style: ['line', 'overtake', 'draft', 'reckless'][i % 4],
        seed: Math.floor(rng() * 0xffffffff),
      });
      c.kart = kart;
      return c;
    });
    for (let i = 0; i < this.karts.length; i++) this.karts[i].controller = this._wrapItemUse(this.controllers[i]);
    this._aiCtor = AIDriverCtor;
    this._lastPlayerInput = this.time;

    // ---- race rules -----------------------------------------------------------
    const rngForRace = mulberry32(0x1234 + count);
    for (const ai of this.controllers) {
      if (ai && typeof ai.setField === 'function') ai.setField(this.karts, this.path);
    }
    this.race = RaceDirectorCtor
      ? new RaceDirectorCtor(ctx, {
          track: this.path,
          trackDef: def,
          builder: this.builder,
          karts: this.karts,
          laps: state2.laps,
          playerKart: this.player,
          grid,
          rng: rngForRace,
        })
      : null;

    // ---- items ----------------------------------------------------------------
    // A fresh seed per race: every race has to draw a different set of items or
    // the roulette stops being fun, but the seed is recorded so a race can be
    // replayed exactly (which is also what makes the integration test stable).
    this.itemRng = mulberry32((Math.random() * 0xffffffff) >>> 0);
    this.items = ItemSystemCtor
      ? new ItemSystemCtor(ctx, {
          track: this.path,
          karts: this.karts,
          race: this.race,
          def,
          itemBoxRows: this.builder?.itemBoxRows || def.itemBoxRows || null,
          boxes: this.builder?.boxes || null,
          rng: this.itemRng,
        })
      : null;
    for (const c of this.controllers) {
      if (c) c.items = this.items;
    }

    // ---- fx -------------------------------------------------------------------
    // Registered as real systems so they run at the view rate in the right order
    // (shake decays before the rig reads it) and are disposed by teardownRace().
    this.cameraShake = CameraShakeCtor ? new CameraShakeCtor(ctx) : null;
    this.cameraRig = CameraRigCtor ? new CameraRigCtor(ctx) : null;
    this.particles = ParticlesCtor ? new ParticlesCtor(ctx) : null;
    if (this.particles?.setQuality) {
      this.particles.setQuality(ctx.quality.bloom ? 'high' : 'medium');
    }
    if (this.cameraRig) {
      this.cameraRig.shake = this.cameraShake;
      this.cameraRig.setTarget?.(this.player);
      this.cameraRig.snapTo?.(this.player);
    }
    for (const [name, obj] of [['cameraShake', this.cameraShake], ['cameraRig', this.cameraRig], ['particles', this.particles]]) {
      if (!obj) continue;
      // The camera and particles want real frame delta, not the 120 Hz sim step,
      // so they are opted out of the fixed loop and driven from updateView only.
      obj.simOnly = true;
      game.addSystem(name, obj);
    }

    // ---- wire karts to fx/audio ----------------------------------------------
    this._wireKarts();

    // ---- register systems -----------------------------------------------------
    this._register(bus, game);
    this._ready = true;

    // ---- announce -------------------------------------------------------------
    if (this.audio) {
      this.audio.setVolumes?.({
        master: state2.masterVolume,
        music: state2.musicVolume,
        sfx: state2.sfxVolume,
      });
      this.audio.setMuted?.(state2.muted);
      this.audio.setEngine?.(this.player);
      this.audio.playMusic?.('race', 0.6);
    }
    bus.emit('race:build', { track: def, karts: this.karts, config: this.config });
    game.setCameraMode('intro');
    ctx.game.effect('confetti', {});
    return true;
  }

  /**
   * Wraps a controller in a Proxy that intercepts `item: true` on the returned
   * drive input and fires it through the ItemSystem (which self-dedupes with a
   * short cooldown), so an item is used whether the controller fires it itself
   * or just signals the intent. A Proxy keeps private class fields working.
   */
  _wrapItemUse(controller) {
    if (!controller || typeof controller.sample !== 'function') return controller;
    const session = this;
    const inner = controller;
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop !== 'sample') return Reflect.get(target, prop, receiver);
        return function sample(dt, kart, ctx) {
          const drive = target.sample(dt, kart, ctx);
          try {
            if (drive && drive.item) session._tryUseItem(kart || inner.kart);
          } catch (err) {
            /* a broken item must never stop a kart driving */
          }
          return drive;
        };
      },
    });
  }

  _computeGrid(def, count) {
    const width = def.width ?? 11;
    const path = this.path;
    const start = def.startLine ?? 0.02;
    const slots = [];
    const rows = Math.ceil(count / 2);
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -1 : 1;
      const lateral = col * (width * 0.34);
      const back = 7.5 * (rows - row);
      const p = path.advance ? path.advance(start, -back) : start;
      const yaw = path.yawAt ? path.yawAt(p) : 0;
      const pos = path.positionAt ? path.positionAt(p, lateral, this._tmpA).clone() : this._tmpA.set(0, 0, 0).clone();
      slots.push({ position: pos, yaw, progress: p });
    }
    return slots;
  }

  _wireKarts() {
    const { bus } = this.ctx;
    for (const kart of this.karts) {
      const phys = kart.physics;
      if (!phys) continue;
      const forward = kart._tmpForward || (kart._tmpForward = new THREE.Vector3());
      const holder = { position: phys.position, forward, kart };
      this._nearby.push(holder);
      phys.nearbyKarts = this._nearby;
      phys.onEvent = (name, payload) => this._onPhysEvent(kart, name, payload);
    }
  }

  _onPhysEvent(kart, name, payload) {
    const bus = this.ctx.bus;
    const game = this.ctx.game;
    const p = payload || {};
    switch (name) {
      case 'driftStart':
        game.sfx('hop', { volume: 0.5 });
        game.effect('landPuff', { position: p.position || kart.position, intensity: 0.5 });
        break;
      case 'driftCharge':
        if (p.tier !== p.lastTier) game.sfx('driftCharge', { tier: p.tier });
        break;
      case 'driftRelease':
        if (p.tier > 0) game.sfx('miniTurbo', { tier: p.tier });
        break;
      case 'miniTurbo':
        bus.emit('kart:boost', { kartId: kart.id, kind: 'miniTurbo' });
        break;
      case 'boostStart':
        game.sfx('boost', { kind: p.kind });
        if (kart.isPlayer) game.bus.emit('fx:shake', { strength: 0.25, duration: 0.4 });
        break;
      case 'land':
        game.sfx('land', { volume: 0.6 });
        game.effect('landPuff', { position: p.position || kart.position, intensity: 1 });
        if (kart.isPlayer) game.bus.emit('fx:shake', { strength: 0.35, duration: 0.22 });
        break;
      case 'wallHit':
        game.sfx('wallHit', { volume: 0.7, rate: p.impact ? 0.9 + p.impact * 0.4 : 1 });
        game.effect('skid', { position: p.position || kart.position, normal: p.normal || null });
        if (kart.isPlayer) game.bus.emit('fx:shake', { strength: 0.4, duration: 0.3 });
        break;
      case 'spinoutStart':
        game.sfx('crunch');
        game.effect('spinDust', { position: kart.position, kart });
        if (kart.isPlayer) game.bus.emit('fx:flash', { color: '#ffffff', alpha: 0.22, duration: 0.2 });
        break;
      case 'surfaceChange':
        bus.emit('kart:surface', { kartId: kart.id, surface: p.surface });
        if (p.surface === 'off') game.sfx('offTrack', { volume: 0.35 });
        break;
      case 'engine':
        this.audio?.setEngineState?.(p.rpm, p.load, p.gear, p.speed);
        break;
      case 'itemBox':
        break;
      default:
        break;
    }
  }

  _register(bus, game) {
    const self = this;
    game.addSystem('raceGlue', {
      update(dt) {
        if (!self._ready) return;
        self._simulate(dt);
      },
      updateView(dt) {
        if (!self._ready) return;
        self._view(dt);
      },      dispose() {
        self._ready = false;
      },
    });
  }

  _simulate(dt) {
    const { ctx } = this;
    const { game } = ctx;
    this.time += dt;

    // ---- domain simulators ---------------------------------------------------
    // Race rules step first so `kart.rank` / `kart.lapProgress` are truthful for
    // everything that reads them this tick (item roulette, AI decisions).
    if (this.race && typeof this.race.update === 'function') this.race.update(dt);
    if (this.items && typeof this.items.update === 'function') this.items.update(dt);

    // ---- item box pickup -----------------------------------------------------
    // Handled inside ItemSystem._pickup() (it owns the box lifetime and the
    // respawn timer), so the integrator deliberately does not duplicate it here.

    // ---- boost pads ----------------------------------------------------------
    // Progress is derived from the track itself rather than the RaceDirector's
    // conventions, so a pad fires whichever field the race layer happens to fill.
    const pads = this.builder?.boostPads || [];
    if (pads.length) {
      for (const kart of this.karts) {
        const prog = this._lapProgress(kart);
        const lat = kart.physics?.lateral ?? 0;
        for (const pad of pads) {
          const key = pad.key != null ? pad.key : String(pad.p) + ':' + String(pad.lateral || 0);
          if (this._padCooldown.has(key)) continue;
          if (Math.abs(prog - pad.p) > 0.0035) continue;
          if (Math.abs(lat - (pad.lateral || 0)) > (pad.width || 3.6) * 0.5) continue;
          this._padCooldown.add(key);
          setTimeout(() => this._padCooldown.delete(key), 1000);
          kart.applyBoost?.('boostPad', CONFIG.physics.boost.boostPad.duration, CONFIG.physics.boost.boostPad.multiplier);
          game.sfx('boost');
          game.effect('boostPadSpark', { position: kart.position.clone(), forward: kart.physics?.forward || null });
        }
      }
    }

    // ---- jump ramps ----------------------------------------------------------
    const jumps = this.builder?.jumps || [];
    if (jumps.length && this.path?.length) {
      const lapLen = this.path.length;
      for (const kart of this.karts) {
        const phys = kart.physics;
        if (!phys) continue;
        const prev = this._prevProgress.get(kart.id);
        const prog = this._lapProgress(kart);
        this._prevProgress.set(kart.id, prog);
        if (prev == null || prog < prev - 0.5) continue;
        for (const j of jumps) {
          const span = (j.width || 6) / lapLen;
          const inZone = prog > j.p - 0.002 && prog < j.p + span;
          const wasOutside = prev < j.p - 0.002 || prev > j.p + span;
          if (inZone && wasOutside && phys.onGround) {
            const h = j.height ?? 5.5;
            if (typeof phys.launch === 'function') phys.launch(h);
            else if (phys.verticalVelocity !== undefined) phys.verticalVelocity = h;
            game.sfx('hop');
          }
        }
      }
    }

    // ---- safety net: nothing may fall out of the world ------------------------
    // Measured three ways: below the visible ground, more than a couple of
    // kart-lengths off the ribbon, and below the *road* at this point on the
    // circuit. The third one is what catches a kart that missed a broken-bridge
    // jump and is now sitting in the ravine: it is nowhere near "off track" and
    // not below the ground, so only the road height gives it away.
    if (this.path) {
      const PIT_DEPTH = 3.5;
      const roadFrame = this._roadFrame || (this._roadFrame = {
        index: 0, position: new THREE.Vector3(), tangent: new THREE.Vector3(),
        right: new THREE.Vector3(), up: new THREE.Vector3(), normal: new THREE.Vector3(),
        bank: 0, width: 11, curvature: 0,
      });
      for (const kart of this.karts) {
        const pos = kart.position;
        const ground = this.path.surfaceHeight(pos.x, pos.z);
        const below = ground - pos.y;
        const loc = this.path.locate ? this.path.locate(pos.x, pos.y, pos.z) : null;
        const offTrack = loc ? Math.abs(loc.lateral) - (this.trackDef && this.trackDef.width ? this.trackDef.width : 11) : 0;
        let pit = 0;
        if (loc && typeof this.path.frameAt === 'function') {
          const f = this.path.frameAt(loc.progress, roadFrame);
          // Height of the tarmac under this kart, banking included.
          const roadY = f.position.y + loc.lateral * Math.tan(f.bank || 0);
          pit = roadY - (pos.y - (kart.physics ? kart.physics.height || 0 : 0));
        }
        if (below > 12 || offTrack > 6 || pit > PIT_DEPTH) {
          const prog = kart.lapProgress ?? kart.raceProgress ?? this._lapProgress(kart);
          const p = this._rescueProgress(prog);
          const safe = this.path.positionAt(p, 0, this._tmpB);
          const phys = kart.physics;
          if (phys && typeof phys.reset === 'function') {
            phys.reset({ position: safe, yaw: this.path.yawAt(p) });
          } else {
            pos.copy(safe);
          }
          if (phys) phys.speed = Math.max(phys.speed, 8);
          game.effect('landPuff', { position: safe.clone(), intensity: 1 });
          game.sfx('land', { volume: 0.8 });
        }
      }
    }

    // ---- item trigger --------------------------------------------------------
    if (ctx.input.justPressed('item') && this.player && this.player.item && this.player.item.id && !this.player.item.rolling) {
      this._tryUseItem(this.player);
    }

    // ---- slipstream field ----------------------------------------------------
    for (const h of this._nearby) {
      const yaw = (h.kart && h.kart.group && h.kart.group.rotation && h.kart.group.rotation.y) || 0;
      h.forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    }

    // ---- kart-kart collision -------------------------------------------------
    this._collide();

    // ---- AFK auto-pilot -------------------------------------------------------
    this._afkCheck(dt);

    // ---- karts ---------------------------------------------------------------
    for (const kart of this.karts) {
      if (typeof kart.update === 'function') kart.update(dt);
    }
  }

  /**
   * Hands the player's kart to a careful AI after a few seconds without input,
   * the way a real kart racer keeps the race moving when someone walks away.
   * Control returns the moment the player touches anything again.
   */
  _afkCheck(dt) {
    const { ctx } = this;
    const player = this.player;
    if (!player || !ctx.input) return;
    const drive = typeof ctx.input.readDrive === 'function' ? ctx.input.readDrive() : null;
    const active = !!drive && (drive.throttle > 0.02 || drive.brake > 0.02 || Math.abs(drive.steer) > 0.05 ||
      ctx.input.justPressed('item') || ctx.input.justPressed('drift'));
    if (active) {
      this._lastPlayerInput = this.time;
      if (this._afkDriver) {
        player.controller = this._playerController;
        this._afkDriver = null;
        ctx.game.sfx('select', { volume: 0.4 });
      }
      return;
    }
    if (this._afkDriver) return;
    if (this.time - this._lastPlayerInput < 8) return;
    const Ctor = this._aiCtor;
    if (!Ctor) return;
    try {
      const ai = new Ctor({ skill: 0.5, difficulty: 'normal', style: 'line', seed: 777 });
      ai.kart = player;
      ai.setField?.(this.karts, this.path);
      ai.items = this.items;
      this._playerController = player.controller;
      player.controller = this._wrapItemUse(ai);
      this._afkDriver = ai;
      ctx.bus.emit('ui:toast', { text: 'AUTO-PILOT ENGAGED', kind: 'good', duration: 2.2 });
    } catch (err) {
      /* never let the safety net break the race */
    }
  }

  _tryUseItem(kart) {
    if (!this.items) return;
    const now = this.time;
    if (kart._lastItemUse != null && now - kart._lastItemUse < ITEM_USE_COOLDOWN) return;
    kart._lastItemUse = now;
    if (typeof this.items.useActive === 'function') this.items.useActive(kart);
    else if (typeof this.items.use === 'function') this.items.use(kart);
  }

  /**
   * A progress fraction to put a rescued kart back on, always on solid road.
   * Plain "6 m behind" is not good enough next to a broken bridge: it can drop
   * the kart straight back into the crevasse it just fell out of, which
   * respawns it again, and again, a few metres further back each time. So walk
   * backwards out of the hole until the centreline is actually there.
   */
  _rescueProgress(prog) {
    let p = prog;
    const N = this.path.sampleCount;
    for (let i = 0; i < 16; i++) {
      if (!this.path.inGap || !this.path.inGap(Math.round(p * N))) break;
      p = this.path.advance(p, -6);
    }
    return p;
  }

  /**
   * Within-lap progress in 0..1, measured on the track so pad/jump zones and
   * the kart's own notion of the lap can never drift apart.
   * @param {{position: {x:number,y:number,z:number}}} kart
   */
  _lapProgress(kart) {
    const pos = kart && kart.position;
    if (!pos || !this.path || !this.path.locate) return 0;
    const loc = this.path.locate(pos.x, pos.y, pos.z);
    const start = this.trackDef && typeof this.trackDef.startLine === 'number' ? this.trackDef.startLine : 0;
    let d = loc.progress - start;
    d %= 1;
    if (d < 0) d += 1;
    return d;
  }

  _collide() {
    const karts = this.karts;
    const r = CONFIG.physics.collision.radius * 2;
    for (let i = 0; i < karts.length; i++) {
      const a = karts[i];
      const pa = a.position;
      const sa = a.physics?.speed ?? 0;
      for (let j = i + 1; j < karts.length; j++) {
        const b = karts[j];
        const pb = b.position;
        this._tmpA.subVectors(pa, pb);
        this._tmpA.y = 0;
        const d2 = this._tmpA.lengthSq();
        if (d2 > r * r || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        this._tmpA.multiplyScalar(1 / d);
        const push = (r - d) * 0.5 * CONFIG.physics.collision.push * 0.16;
        pa.addScaledVector(this._tmpA, push);
        pb.addScaledVector(this._tmpA, -push);
        const sb = b.physics?.speed ?? 0;
        const heavyA = a.physicsDef?.mass ?? 1;
        const heavyB = b.physicsDef?.mass ?? 1;
        const total = heavyA + heavyB;
        const loss = CONFIG.physics.collision.speedLoss;
        if (a.physics) a.physics.speed *= 1 - loss * (heavyB / total);
        if (b.physics) b.physics.speed *= 1 - loss * (heavyA / total);
        if (sa > 12 && (a.physics?.star > 0 || a.physics?.invincible > 0)) {
          b.spinOut?.(CONFIG.physics.spinout * 0.7, a.id);
        } else if (sb > 12 && (b.physics?.star > 0 || b.physics?.invincible > 0)) {
          a.spinOut?.(CONFIG.physics.spinout * 0.7, b.id);
        }
        this.ctx.game.effect('skid', { position: this._tmpB.addVectors(pa, pb).multiplyScalar(0.5), intensity: Math.min(1, Math.abs(sa - sb) * 0.06) });
      }
    }
  }

  _view(dt) {
    const { ctx } = this;
    const { game } = ctx;
    if (this.decor && typeof this.decor.animate === 'function') this.decor.animate(dt);

    // continuous effects derived from physics state
    for (const kart of this.karts) {
      const phys = kart.physics;
      if (!phys) continue;
      const drift = phys.drift;
      if (drift && drift.active) {
        game.effect('driftSpark', { kart, tier: drift.tier || 0, charge: drift.charge || 0 });
        game.effect('driftSmoke', { kart, tier: drift.tier || 0 });
      }
      if (phys.boost && phys.boost.timer > 0) {
        game.effect('boostFlame', { kart, kind: phys.boost.kind });
      }
      if (phys.star > 0) game.effect('starSparkle', { kart });
      if (phys.surface === 'off' && phys.speed > 4) {
        game.effect('dust', { kart });
      }
      if (phys.squash && phys.squash.timer > 0) {
        game.effect('squashPuff', { kart });
      }
    }
  }

  dispose() {
    this._ready = false;
    const { ctx } = this;
    // The engine voice is a persistent audio system that outlives the race;
    // without this it keeps droning its last frozen state through the results
    // screen and the whole menu until the next race reassigns it.
    this.audio?.setEngine?.(null);
    for (const name of ['cameraShake', 'cameraRig', 'particles']) ctx.game.removeSystem(name);
    this.cameraShake = null;
    this.cameraRig = null;
    this.particles = null;
    try {
      this.decor?.dispose?.();
    } catch (err) {
      console.error('[bootstrap] decor dispose failed', err);
    }
    this.decor = null;
    if (ctx.scene) ctx.scene.environment = null;
    // The item system owns its own asset set (per-box sprite materials, shells,
    // the bullet-bill flame) and the track builder owns the road/terrain
    // geometry. Neither is a child of raceRoot, so Game.teardownRace() — which
    // only walks raceRoot — can never see them: without these two calls every
    // rematch leaks a whole world, and the shared item-box assets keep piling
    // up references so they are re-uploaded from scratch on the next race.
    try {
      this.items?.dispose?.();
    } catch (err) {
      console.error('[bootstrap] item system dispose failed', err);
    }
    this.items = null;
    try {
      this.builder?.dispose?.();
    } catch (err) {
      console.error('[bootstrap] track builder dispose failed', err);
    }
    this.builder = null;
    for (const kart of this.karts) {
      if (kart.physics) kart.physics.onEvent = null;
      kart.dispose?.();
    }
    this.karts.length = 0;
    ctx.game.teardownRace();
    // teardownRace clears raceRoot AND every system, so rebuild the roots.
    ctx.scene.add(ctx.raceRoot);
    ctx.scene.add(ctx.worldRoot);
    ctx.worldRoot.clear();
    this.particles = null;
    this.items = null;
    this.race = null;
    this.cameraRig = null;
    this.cameraShake = null;
    this.controllers = null;
  }
}

let active = null;

export async function startRace(ctx, config) {
  const { game, bus, store } = ctx;
  game.teardownRace();
  ctx.scene.add(ctx.raceRoot);
  ctx.scene.add(ctx.worldRoot);
  ctx.worldRoot.clear();

  const audio = game.getSystem('audio');
  const session = new RaceSession(ctx, config, audio);
  const ok = await session.build();
  if (!ok) {
    session.dispose();
    store.set({ mode: MODES.TITLE });
    store.notify();
    return null;
  }
  active = session;
  return session;
}

export function endRace() {
  if (!active) return;
  active.dispose();
  active = null;
}

export function activeRace() {
  return active;
}

