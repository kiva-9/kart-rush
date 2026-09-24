/**
 * Unified keyboard + gamepad input with analog smoothing and edge detection.
 *
 * Actions: 'accelerate' | 'brake' | 'steerLeft' | 'steerRight' | 'drift' |
 *          'item' | 'lookBack' | 'pause' | 'reset' | 'horn'
 */

export const Actions = {
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

const KEYMAP = {
  ArrowUp: Actions.ACCELERATE,
  KeyW: Actions.ACCELERATE,
  KeyZ: Actions.ACCELERATE,
  ArrowDown: Actions.BRAKE,
  KeyS: Actions.BRAKE,
  KeyX: Actions.BRAKE,
  ArrowLeft: Actions.STEER_LEFT,
  KeyA: Actions.STEER_LEFT,
  ArrowRight: Actions.STEER_RIGHT,
  KeyD: Actions.STEER_RIGHT,
  ShiftLeft: Actions.DRIFT,
  ShiftRight: Actions.DRIFT,
  Space: Actions.DRIFT,
  KeyC: Actions.DRIFT,
  ControlLeft: Actions.ITEM,
  ControlRight: Actions.ITEM,
  KeyE: Actions.ITEM,
  KeyF: Actions.ITEM,
  KeyB: Actions.LOOK_BACK,
  Escape: Actions.PAUSE,
  KeyP: Actions.PAUSE,
  KeyR: Actions.RESET,
  KeyH: Actions.HORN,
};

/** Keys the page swallows instead of scrolling / opening devtools. */
const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

const STEER_RISE = 6.5;
const STEER_FALL = 9.5;

export class InputManager {
  /** @param {Window} target */
  constructor(target = window) {
    this.target = target;
    /** @type {Set<string>} key codes currently held */
    this.keys = new Set();
    /** action -> true (gamepad edge tracking) */
    this.prevPad = Object.create(null);
    /** one-shot presses this frame */
    this.framePressed = new Set();
    /** one-shot releases this frame */
    this.frameReleased = new Set();
    /** raw steer axis this frame before smoothing */
    this.rawSteer = 0;
    /** smoothed steer axis, -1..1 */
    this.steer = 0;
    /** analog throttle 0..1 */
    this.throttleAxis = 0;
    /** analog brake 0..1 */
    this.brakeAxis = 0;
    this.gamepadIndex = null;
    this.gamepadConnected = false;
    this._keyToAction = new Map();
    for (const [code, action] of Object.entries(KEYMAP)) this._keyToAction.set(code, action);
    this._bind();
  }

  _bind() {
    const onKey = (down) => (e) => {
      // A focused slider or dropdown owns its own arrow keys. The game used to
      // preventDefault() them no matter what had focus, so with the Options
      // screen open the volume sliders could not be adjusted by keyboard at all.
      const t = e.target;
      const formField = t && t.tagName && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName);
      if (!formField && PREVENT.has(e.code)) e.preventDefault();
      const action = this._keyToAction.get(e.code);
      if (!action) {
        if (down && !e.repeat) this.framePressed.add(`key:${e.code}`);
        return;
      }
      if (down) {
        if (!this.keys.has(e.code)) {
          this.keys.add(e.code);
          this.framePressed.add(action);
        }
      } else {
        if (this.keys.delete(e.code)) this.frameReleased.add(action);
      }
    };
    window.addEventListener('keydown', onKey(true));
    window.addEventListener('keyup', onKey(false));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.gamepadConnected = true;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null;
      this.gamepadConnected = false;
    });
  }

  _readGamepad() {
    if (typeof navigator.getGamepads !== 'function') return;
    const pads = navigator.getGamepads();
    let pad = null;
    if (this.gamepadIndex != null && pads[this.gamepadIndex]) pad = pads[this.gamepadIndex];
    if (!pad) {
      for (const p of pads) {
        if (p && p.connected) {
          pad = p;
          break;
        }
      }
    }
    if (!pad) return;
    this.gamepadConnected = true;

    const ax = pad.axes[0] || 0;
    this.rawSteer += Math.abs(ax) > 0.09 ? ax : 0;

    const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const accel = btn(7) || btn(0);
    const brake = btn(6) || btn(1);
    const drift = btn(0) || btn(5);
    const item = btn(2) || btn(4) || btn(3);
    const look = btn(4) || btn(11);
    const pause = btn(9);
    const horn = btn(3) || btn(10);

    const edge = (action, isDown) => {
      const was = this.prevPad[action] === true;
      if (isDown && !was) this.framePressed.add(action);
      if (!isDown && was) this.frameReleased.add(action);
      this.prevPad[action] = isDown;
    };
    edge(Actions.ACCELERATE, accel);
    edge(Actions.BRAKE, brake);
    edge(Actions.DRIFT, drift);
    edge(Actions.ITEM, item);
    edge(Actions.LOOK_BACK, look);
    edge(Actions.PAUSE, pause);
    edge(Actions.HORN, horn);

    this.throttleAxis = accel ? 1 : 0;
    this.brakeAxis = brake ? 1 : 0;
  }

  /** True when a key bound to `action` is held. */
  keyDown(action) {
    for (const code of this.keys) if (this._keyToAction.get(code) === action) return true;
    return false;
  }

  /**
   * Call once per rendered frame before any system update.
   *
   * The one-shot queues are deliberately NOT drained here: a key or pad edge
   * that lands while the frame is being rendered arrives after `step()` returns
   * and before the next one begins, so clearing at the top of the frame would
   * throw the press away unread. They are drained in `endFrame()` instead,
   * which gives every press exactly one frame of life.
   */
  beginFrame(dt) {
    this.rawSteer = 0;
    // The axes must be rebuilt from scratch every frame. They are only ever set
    // to 1 here and cleared again in _readGamepad(), which returns early when no
    // pad is attached - so without this reset the first axis you touch latches
    // at 1 forever and brake cancels throttle out.
    this.throttleAxis = 0;
    this.brakeAxis = 0;

    if (this.keyDown(Actions.STEER_LEFT)) this.rawSteer -= 1;
    if (this.keyDown(Actions.STEER_RIGHT)) this.rawSteer += 1;
    if (this.keyDown(Actions.ACCELERATE)) this.throttleAxis = 1;
    if (this.keyDown(Actions.BRAKE)) this.brakeAxis = 1;

    this._readGamepad();

    const target = Math.max(-1, Math.min(1, this.rawSteer));
    const rate = Math.abs(target) > Math.abs(this.steer) ? STEER_RISE : STEER_FALL;
    this.steer += (target - this.steer) * Math.min(1, rate * (dt || 0.016));
  }

  justPressed(action) {
    return this.framePressed.has(action);
  }

  justReleased(action) {
    return this.frameReleased.has(action);
  }

  isDown(action) {
    return this.keyDown(action) || this.prevPad[action] === true;
  }

  justPressedKey(code) {
    return this.framePressed.has(`key:${code}`);
  }

  /** Analog snapshot consumed by the kart controllers. */
  readDrive() {
    return {
      throttle: Math.max(0, this.throttleAxis),
      brake: Math.max(0, this.brakeAxis),
      steer: this.steer,
      drift: this.isDown(Actions.DRIFT),
      driftPressed: this.justPressed(Actions.DRIFT),
      item: this.justPressed(Actions.ITEM),
    };
  }

  /** Drains the one-shot queues. Called after every system has read them. */
  endFrame() {
    this.framePressed.clear();
    this.frameReleased.clear();
  }
}

export const input = new InputManager();
