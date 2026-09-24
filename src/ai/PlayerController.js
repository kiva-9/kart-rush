/**
 * PlayerController — turns the player's keyboard / gamepad into a DriveInput,
 * and owns the small pieces of race craft the physics layer deliberately does
 * not: the countdown start-boost window, firing the held item, the look-back
 * camera flag and getting the kart back onto the road when it strands itself.
 *
 * The action names below mirror `core/Input.js`'s `Actions` map exactly. They
 * are inlined rather than imported so this module never pulls in the input
 * singleton (which binds to `window` at module scope and therefore cannot be
 * loaded headlessly).
 */
import * as THREE from 'three';
import { CONFIG } from '../data/config.js';
import { clamp } from '../core/MathUtils.js';

const ACT = {
  ACCELERATE: 'accelerate',
  BRAKE: 'brake',
  STEER_LEFT: 'steerLeft',
  STEER_RIGHT: 'steerRight',
  DRIFT: 'drift',
  ITEM: 'item',
  LOOK_BACK: 'lookBack',
  PAUSE: 'pause',
  RESET: 'reset',
  HORN: 'horn',
};

export class PlayerController {
  /** @param {object} [ctx] game context; `ctx.input` is the input source. */
  constructor(ctx) {
    this.ctx = ctx || null;
    this.input = (ctx && ctx.input) || (ctx && ctx.game && ctx.game.input) || null;
    /** @type {any} the kart this controller drives */
    this.kart = null;
    /** @type {any} ItemSystem, injected by the integrator when it exists */
    this.items = null;
    /** Read by the camera rig: true while the look-back key is held. */
    this.lookBack = false;
    /**
     * Seconds before GO that the accelerate key was last released during the
     * countdown — small values are the sweet spot for a start boost. Null until
     * the player releases accelerate before the race starts.
     */
    this.lastStartBoostReleased = null;
    /** True once the start boost has been handed out (or the window missed). */
    this.startBoostGranted = false;

    this._out = {
      throttle: 0, brake: 0, steer: 0, drift: false, driftPressed: false, item: false,
    };
    this._tmp = new THREE.Vector3();

    this._time = 0;
    this._go = false;
    this._preSeen = false;
    this._preTime = 0;
    this._cdLeft = null;
    this._cdAt = -100;
    this._cdForced = false;
    this._releaseTogo = null;
    this._pressedTogo = null;
    // -99 so the very first item press is never swallowed by the de-dup window.
    this._itemFired = -99;
    this._badTime = 0;
    this._busTried = false;
    this._off = null;
    this._disposed = false;
  }

  // ------------------------------------------------------------------ sample

  /** @returns {{throttle:number,brake:number,steer:number,drift:boolean,driftPressed:boolean,item:boolean}} */
  sample(dt, kart, ctx) {
    const out = this._out;
    if (this._disposed) return out;
    if (dt > 0) this._time += dt;
    else dt = 1 / 120;
    if (dt > 0.1) dt = 0.1;
    if (kart) this.kart = kart;
    const k = this.kart;
    const inp = (ctx && ctx.input) || this.input;
    if (ctx) this.ctx = ctx;

    out.throttle = 0;
    out.brake = 0;
    out.steer = 0;
    out.drift = false;
    out.driftPressed = false;
    out.item = false;

    if (inp) this.lookBack = this._down(inp, ACT.LOOK_BACK);
    else this.lookBack = false;

    // The countdown window runs first: it decides whether the kart is allowed
    // to move at all, and whether the start boost has been earned.
    const pre = this._phase(dt, k, ctx, inp);

    if (inp) {
      const drive = typeof inp.readDrive === 'function' ? inp.readDrive() : null;
      if (drive) {
        out.throttle = clamp(+drive.throttle || 0, 0, 1);
        out.brake = clamp(+drive.brake || 0, 0, 1);
        out.steer = clamp(+drive.steer || 0, -1, 1);
        out.drift = !!drive.drift;
        out.driftPressed = !!drive.driftPressed;
        out.item = !!drive.item;
      }
      this._handleItem(k, inp, out);
      if (this._pressed(inp, ACT.RESET)) this.respawn(k);
      else this._autoRespawn(dt, k, ctx);
    }

    if (pre) {
      // Wheels may turn, the engine stays off until the lights go out.
      out.throttle = 0;
      out.brake = 0;
      out.drift = false;
      out.driftPressed = false;
      out.item = false;
    }
    return out;
  }

  /** @returns {boolean} true when the kart was moved back onto the road. */
  respawn(kart) {
    const k = kart || this.kart;
    if (!k) return false;
    const phys = k.physics || null;
    const track = this._track(k);
    const game = this.ctx && this.ctx.game;
    if (track && typeof track.positionAt === 'function') {
      const p = k.position;
      let prog = 0;
      if (p && typeof track.locate === 'function') {
        try {
          const r = track.locate(p.x, p.y || 0, p.z);
          if (r && typeof r.progress === 'number' && isFinite(r.progress)) prog = r.progress;
        } catch (err) { /* fall back to lap progress */ }
      }
      if (!prog && typeof k.lapProgress === 'number' && isFinite(k.lapProgress)) {
        prog = k.lapProgress;
      }
      const ahead = typeof track.advance === 'function' ? track.advance(prog, 7) : prog;
      const pos = track.positionAt(ahead, 0, this._tmp).clone();
      const yaw = typeof track.yawAt === 'function' ? track.yawAt(ahead) : (phys ? phys.yaw : 0);
      if (phys && typeof phys.reset === 'function') {
        try {
          phys.reset({ position: pos, yaw });
        } catch (err) {
          if (p) p.copy(pos);
        }
      } else if (p) {
        p.copy(pos);
      }
      if (phys) phys.speed = 6;
      if (k.group) {
        k.group.position.copy(pos);
        k.group.rotation.y = yaw;
      }
      try {
        if (game && typeof game.effect === 'function') game.effect('landPuff', { position: pos.clone(), intensity: 1 });
        if (game && typeof game.sfx === 'function') game.sfx('land', { volume: 0.8 });
      } catch (err) { /* fx are best-effort */ }
    } else if (phys) {
      // No track to place us on: at least face the way we were going.
      phys.speed = Math.max(0, phys.speed || 0);
    }
    if (typeof k.poseVisuals === 'function') {
      try { k.poseVisuals(1 / 60); } catch (err) { /* view-only */ }
    }
    this._badTime = 0;
    return true;
  }

  dispose() {
    this._disposed = true;
    if (typeof this._off === 'function') this._off();
    this._off = null;
    this.kart = null;
    this.items = null;
    this.input = null;
  }

  // ------------------------------------------------------------ start boost

  /**
   * Countdown bookkeeping. Returns true while the race is still pre-GO, in
   * which case the drive output is frozen so the kart holds the grid.
   */
  _phase(dt, kart, ctx, inp) {
    if (this._go) return false;
    this._subscribeBus(ctx);

    const p = ctx && ctx.race;
    const st = ctx && ctx.store ? ctx.store.state : null;
    const lap = kart && typeof kart.lap === 'number' ? kart.lap : -1;
    // NOTE: the store flips to 'racing' as soon as the session is built, which
    // is *before* the countdown starts, so only the race layer / the kart's own
    // lap counter may be trusted for "the race has begun".
    const started = (p && typeof p.phase === 'string' && p.phase !== 'countdown') ||
      lap >= 1;

    const phys = kart && kart.physics;
    const speed = phys && typeof phys.speed === 'number' ? Math.abs(phys.speed) : 0;
    if (!this._preSeen) {
      this._preSeen = this._cdLeft != null ||
        (p && typeof p.phase === 'string' && p.phase === 'countdown') ||
        (st && typeof st.mode === 'string' && st.mode === 'countdown') ||
        (p && typeof p.countdownMs === 'number' && p.countdownMs > 0);
    }

    // Accelerate presses and releases are tracked whatever the phase says, so
    // the window verdict survives a dropped countdown event.
    if (inp) this._trackAccelerate(inp);

    if (!this._preSeen) {
      if (started || speed > 0.7) {
        // Not a countdown at all: drive normally, no start boost.
        this._go = true;
        this.startBoostGranted = true;
        return false;
      }
      return false;
    }
    this._preTime += dt;
    const togo = this._togo();
    const overrun = togo != null ? togo <= 0 : this._preTime > CONFIG.race.countdown + 1.2;
    if (started || overrun || this._cdForced || speed > 0.7) {
      this._go = true;
      this._grantStartBoost(inp);
      return false;
    }
    return true;
  }

  /** Remembers when the accelerate key went down / up during the countdown. */
  _trackAccelerate(inp) {
    if (this._go) return;
    if (this._pressed(inp, ACT.ACCELERATE)) {
      const press = this._togo();
      if (press != null) this._pressedTogo = press;
    }
    if (this._released(inp, ACT.ACCELERATE)) {
      const letgo = this._togo();
      if (letgo != null) {
        this._releaseTogo = letgo;
        this.lastStartBoostReleased = letgo;
      }
    }
  }

  /** Seconds until GO, reconstructed from the bus or the countdown clock. */
  _togo() {
    if (this._go) return null;
    if (this._cdLeft != null) {
      return Math.max(0, this._cdLeft - (this._time - this._cdAt));
    }
    if (!this._preSeen) return null;
    return clamp(CONFIG.race.countdown - this._preTime, 0, CONFIG.race.countdown + 2);
  }

  /**
   * The rule: the accelerate key must be *pressed* inside the last
   * `startBoostWindow` seconds and then released at the lights (or kept held
   * through them). Press it any earlier and the launch bogs — no boost.
   */
  _grantStartBoost(inp) {
    if (this.startBoostGranted) return;
    this.startBoostGranted = true;
    const window = CONFIG.race.startBoostWindow;
    if (this._pressedTogo == null || this._pressedTogo > window) return;
    let earned = false;
    if (this._releaseTogo != null) earned = this._releaseTogo <= window + 0.25;
    else earned = this._down(inp, ACT.ACCELERATE);
    if (!earned) return;
    const kart = this.kart;
    const b = CONFIG.physics.boost.startBoost;
    if (kart && typeof kart.applyBoost === 'function' && b) {
      try {
        kart.applyBoost('startBoost', b.duration, b.multiplier);
      } catch (err) { /* a kart without a boost path simply starts clean */ }
    }
  }

  // ------------------------------------------------------------------- items

  /** Fires the held item on the ITEM edge, through the ItemSystem if we have it. */
  _handleItem(kart, inp, out) {
    if (this._time - this._itemFired < 0.25) return;
    let edge = !!out.item;
    if (!edge && typeof inp.justPressed === 'function') edge = inp.justPressed(ACT.ITEM) === true;
    if (!edge) return;
    const slot = kart ? kart.item : null;
    if (!slot || !slot.id || slot.rolling) {
      // Nothing to fire: clear the edge so the integrator does not double-take it.
      out.item = false;
      return;
    }
    this._itemFired = this._time;
    const items = this.items;
    if (items && typeof items.useActive === 'function') {
      try {
        items.useActive(kart);
      } catch (err) { /* fall back to signalling the intent */ }
      out.item = false;
    }
  }

  // ---------------------------------------------------------------- respawn

  /** Sends the kart back to the road when it is badly stranded. */
  _autoRespawn(dt, kart, ctx) {
    const phys = kart && kart.physics;
    if (!phys) return;
    const track = this._track(kart);
    if (!track) return;
    const surface = phys.surface;
    const speed = typeof phys.speed === 'number' ? Math.abs(phys.speed) : 0;
    const p = kart.position;
    let bad = false;
    if (surface === 'off' && speed < 3.5) bad = true;
    if (!bad && p && typeof p.y === 'number' && typeof track.surfaceHeight === 'function') {
      try {
        const h = track.surfaceHeight(p.x, p.z);
        if (typeof h === 'number' && isFinite(h) && p.y < h - 8) bad = true;
      } catch (err) { /* keep driving */ }
    }
    this._badTime = bad ? this._badTime + dt : 0;
    if (this._badTime > 2.2) this.respawn(kart);
  }

  _track(kart) {
    const c = this.ctx;
    const t = (c && c.track) || (c && c.race && c.race.track) ||
      (kart && kart.physics && kart.physics.track) || null;
    return t && typeof t.positionAt === 'function' ? t : null;
  }

  // ------------------------------------------------------------------ events

  /** Hears about GO directly when the bus is willing to tell us. */
  _subscribeBus(ctx) {
    if (this._busTried) return;
    this._busTried = true;
    const bus = ctx && ctx.bus;
    if (!bus || typeof bus.on !== 'function') return;
    const self = this;
    try {
      const a = bus.on('race:go', () => { self._cdForced = true; });
      const b = bus.on('race:countdown', (payload) => {
        const p = payload || {};
        const r = typeof p.remaining === 'number' ? p.remaining
          : typeof payload === 'number' ? payload : null;
        if (r != null) {
          // Guard against a director that counts in milliseconds.
          self._cdLeft = r > 30 ? r / 1000 : r;
          self._cdAt = self._time;
          self._preSeen = true;
        }
      });
      self._off = () => {
        if (typeof a === 'function') a();
        if (typeof b === 'function') b();
        self._off = null;
      };
    } catch (err) {
      self._off = null;
    }
  }

  // ----------------------------------------------------------- input shims

  _down(inp, action) {
    if (!inp) return false;
    if (typeof inp.isDown === 'function') return inp.isDown(action) === true;
    return false;
  }

  _pressed(inp, action) {
    if (!inp) return false;
    if (typeof inp.justPressed === 'function') return inp.justPressed(action) === true;
    return false;
  }

  _released(inp, action) {
    if (!inp) return false;
    if (typeof inp.justReleased === 'function') return inp.justReleased(action) === true;
    return false;
  }
}

export default PlayerController;
