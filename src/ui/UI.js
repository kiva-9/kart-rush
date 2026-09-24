/**
 * Kart Rush — UI shell.
 *
 * Owns `#ui-root` and the whole screen stack (loading, title, character select,
 * track select, options, controls, HUD, pause, results) plus the centre toasts,
 * screen flashes and the 3-2-1 countdown numerals.
 *
 * Navigation is fully keyboard + gamepad driven: arrows/WASD (or the dpad/left
 * stick) move focus, Enter/Space (or A) confirms, Escape (or B) goes back. The
 * focused element carries `data-focused`, which the stylesheet turns into a
 * chunky arcade focus ring.
 *
 * All settings are written straight into GameStore and persisted; starting a
 * race emits `race:request` with the full config.
 */

import { MODES } from '../core/Store.js';
import { clamp } from '../core/MathUtils.js';
import { createLoading } from './Loading.js';
import { createMenus } from './Menus.js';
import { createHUD } from './HUD.js';
import { createResults } from './Results.js';

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.length > 2 && k[0] === 'o' && k[1] === 'n' && typeof v === 'function') {
        n.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, String(v));
    }
  }
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) {
      for (const inner of kid) if (inner != null && inner !== false) n.append(inner);
    } else if (typeof kid === 'string' || typeof kid === 'number') {
      n.append(document.createTextNode(String(kid)));
    } else n.append(kid);
  }
  return n;
}

const NAV_KEYS = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
};

/** Screens this shell can show. */
const SCREENS = [
  'loading',
  'title',
  'charselect',
  'trackselect',
  'options',
  'controls',
  'hud',
  'pause',
  'results',
];

const MENU_KEYS = ['title', 'charselect', 'trackselect', 'options', 'controls', 'pause'];

export function createUI(ctx) {
  const root = ctx.uiRoot;
  const bus = ctx.bus;
  const store = ctx.store;

  root.classList.add('kart-ui');

  /* ----------------------------------------------------------- overlays --- */

  const flashEl = h('div', { class: 'flash' });
  const toastEl = h('div', { class: 'toast-layer' });
  const countEl = h('div', { class: 'count-layer' });
  const countNum = h('div', { class: 'count-num hidden' });
  const countRing = h('div', { class: 'count-ring hidden' });
  countEl.append(countRing, countNum);

  root.append(flashEl, countEl, toastEl);

  /* -------------------------------------------------------------- modules -- */

  const loading = createLoading(ctx);
  const hud = createHUD(ctx);
  const results = createResults(ctx, {
    rematch: () => {
      bus.emit('ui:rematch');
    },
    changeTrack: () => {
      // Straight to the track select. This used to emit `ui:back`, which
      // main.js maps onto goToTitle() — so the title scene was rebuilt, the
      // camera flew back to the attract view and the menu music restarted
      // before the track select finally appeared one macrotask later.
      show('trackselect');
    },
    mainMenu: () => {
      bus.emit('ui:quitToTitle');
    },
  });

  const menus = createMenus(ctx, {
    go: (name) => show(name),
    back: () => back(),
    resume: () => resumeRace(),
    restart: () => {
      bus.emit('ui:restart');
    },
    quit: () => {
      bus.emit('ui:quitToTitle');
    },
    startRace: (opts) => requestRace(opts),
    toast: (text, kind, dur) => toast(text, kind, dur),
    focus: (el) => setFocus(el),
  });

  root.append(loading.el, hud.el, results.el);
  for (const key of MENU_KEYS) {
    const sc = menus.screens[key];
    if (sc) root.append(sc.el);
  }

  /* --------------------------------------------------------------- state --- */

  let active = null; // active screen record
  const stack = [];
  let raceRef = null;
  let raceView = null;
  let recordsAtStart = null;
  let restoredPlayerCount = null;
  let lastCountdown = -1;
  let toastTimer = 0;
  let countTimer = 0;
  let flashTimer = 0;
  let focused = null;
  let alive = true;

  /* --------------------------------------------------------------- toasts -- */

  let toastNode = null;

  function toast(text, kind, duration) {
    // An explicit kind wins; `info` used to fall through to 't-good', which made
    // `.toast.t-info` unreachable and rendered info messages as "good" ones.
    const cls = kind ? `t-${kind}` : 't-good';
    if (!toastNode) {
      toastNode = h('div', { class: 'toast' });
      toastEl.append(toastNode);
    }
    toastNode.classList.remove('out');
    // Drop the animation class, flush, then re-add it so the pop restarts.
    toastNode.className = 'toast';
    void toastNode.offsetWidth;
    toastNode.className = `toast ${cls}`;
    toastNode.textContent = String(text == null ? '' : text);
    toastTimer = Math.max(0.35, (duration || 1400) / 1000);
  }

  function flash(color, alpha, duration) {
    const col = color || '#ffffff';
    flashEl.style.background = typeof col === 'string' ? col : '#ffffff';
    flashEl.classList.remove('hit');
    void flashEl.offsetWidth;
    flashEl.style.setProperty('--flash-peak', String(clamp(alpha == null ? 0.6 : alpha, 0, 1)));
    flashEl.classList.add('hit');
    flashTimer = Math.max(0.1, (duration || 380) / 1000);
  }

  function countdown(n) {
    const v = Math.max(0, Math.round(n));
    if (v === lastCountdown) return;
    lastCountdown = v;
    if (v <= 0) {
      countNum.classList.add('hidden');
      countRing.classList.add('hidden');
      return;
    }
    countNum.textContent = String(v);
    countNum.classList.remove('hidden');
    countRing.classList.remove('hidden');
    countNum.classList.remove('pop');
    countRing.classList.remove('pop');
    void countNum.offsetWidth;
    countNum.classList.add('pop');
    countRing.classList.add('pop');
    countTimer = 1.4;
  }
  function goCountdown() {
    lastCountdown = 0;
    countRing.classList.add('hidden');
    countNum.textContent = 'GO!';
    countNum.classList.remove('hidden', 'pop');
    void countNum.offsetWidth;
    countNum.classList.add('pop');
    countTimer = 0.8;
  }

  /* ------------------------------------------------------------- focusing -- */

  function focusables() {
    if (!active) return [];
    const el = active.el;
    if (!el) return [];
    return Array.prototype.slice.call(el.querySelectorAll('[data-focusable]'));
  }

  function setFocus(el) {
    if (focused && focused !== el) focused.removeAttribute('data-focused');
    focused = el || null;
    if (focused) {
      focused.setAttribute('data-focused', '1');
      try {
        focused.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch {
        /* older browsers without options support */
      }
    }
  }

  function focusFirst() {
    const list = focusables();
    if (!list.length) {
      setFocus(null);
      return;
    }
    const want = menus.focusTarget(active.key);
    setFocus(want && list.indexOf(want) >= 0 ? want : list[0]);
  }

  function navigate(dir) {
    const list = focusables();
    if (!list.length) return;
    const from = focused && list.indexOf(focused) >= 0 ? focused : list[0];
    let dx = 0;
    let dy = 0;
    if (dir === 'left') dx = -1;
    else if (dir === 'right') dx = 1;
    else if (dir === 'up') dy = -1;
    else dy = 1;
    const fr = from.getBoundingClientRect();
    const fx = fr.left + fr.width * 0.5;
    const fy = fr.top + fr.height * 0.5;
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it === from) continue;
      const r = it.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cx = r.left + r.width * 0.5 - fx;
      const cy = r.top + r.height * 0.5 - fy;
      const along = cx * dx + cy * dy;
      if (along <= 2) continue;
      const across = Math.abs(cy * dx - cx * dy);
      const score = along + across * 2.6;
      if (score < bestScore) {
        bestScore = score;
        best = it;
      }
    }
    if (!best) best = list[(list.indexOf(from) + 1) % list.length];
    setFocus(best);
  }

  function confirm() {
    if (!focused) {
      focusFirst();
      return;
    }
    focused.click();
  }

  /* ------------------------------------------------------------- screens --- */

  function hideAllMenus() {
    for (const key of MENU_KEYS) {
      const sc = menus.screens[key];
      if (sc) sc.el.classList.add('hidden');
    }
  }

  function show(name) {
    const key = String(name || '');
    if (SCREENS.indexOf(key) < 0) return;
    if (key === 'loading') {
      loading.show();
      return;
    }
    loading.hide();
    hud.el.classList.toggle('hidden', key !== 'hud');
    results.el.classList.toggle('hidden', key !== 'results');
    hideAllMenus();

    if (key === 'hud' || key === 'results') {
      active = { key, el: key === 'hud' ? hud.el : results.el };
      stack.length = 0;
      setFocus(null);
      return;
    }
    const sc = menus.screens[key];
    if (!sc) return;
    sc.el.classList.remove('hidden');
    active = sc;
    const idx = stack.indexOf(key);
    if (idx >= 0) stack.splice(idx);
    stack.push(key);
    if (sc.onEnter) sc.onEnter();
    focusFirst();
  }

  function back() {
    if (!active) return;
    if (stack.length > 1) {
      stack.pop();
      const prev = stack[stack.length - 1];
      show(prev);
      return;
    }
    if (active.key === 'title' || active.key === 'pause') return;
    show('title');
  }

  function resumeRace() {
    const s = store.state;
    if (s.mode === MODES.PAUSED) {
      store.set({ mode: MODES.RACING });
      store.notify();
      show('hud');
      const a = ctx.game && ctx.game.getSystem ? ctx.game.getSystem('audio') : null;
      if (a && typeof a.resumeAll === 'function') a.resumeAll();
    } else {
      show('hud');
    }
  }

  /* ------------------------------------------------------------ race flow -- */

  function requestRace(opts) {
    const o = opts || {};
    const s = store.state;
    const timeTrial = o.timeTrial === true;
    if (timeTrial) {
      restoredPlayerCount = s.playerCount;
      store.set({ playerCount: 1 });
    } else if (restoredPlayerCount != null) {
      store.set({ playerCount: restoredPlayerCount });
      restoredPlayerCount = null;
    }
    store.notify();

    const cfg = {
      trackId: s.trackId,
      characterId: s.characterId,
      cc: s.cc,
      difficulty: s.difficulty,
      laps: s.laps,
      playerCount: store.state.playerCount,
      quality: s.quality,
      mode: timeTrial ? 'timetrial' : 'grandprix',
      timeTrial,
      rematch: o.rematch === true,
    };
    bus.emit('race:request', cfg);
    show('loading');
    loading.setProgress(0.3, 'Building the circuit');
    window.setTimeout(() => {
      if (loading.visible) loading.setProgress(0.55, 'Planting the scenery');
    }, 260);
    window.setTimeout(() => {
      if (loading.visible) loading.setProgress(0.72, 'Firing up the item boxes');
    }, 620);
  }

  function attachRace(race) {
    raceRef = race || null;
    recordsAtStart = store.state.records ? { ...store.state.records } : {};
    hud.attachRace(raceRef);
    show('hud');
    loading.setProgress(1, 'Green light');
    window.setTimeout(() => loading.hide(), 120);
  }

  /* ---------------------------------------------------------------- input -- */

  const held = Object.create(null);
  const pressedAt = Object.create(null);
  const repeatAt = Object.create(null);
  /**
   * Bumped every time the shell handles a Back (Escape / gamepad-B) press.
   * main.js diffs this across frames so it can tell the difference between
   * "the player pressed Escape to unpause" and "the player pressed Escape to
   * close the options screen that was open on top of the pause menu".
   */
  let backSeq = 0;

  function onKey(down, e) {
    const dir = NAV_KEYS[e.code];
    const isConfirm = e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space';
    const isBack = e.code === 'Escape' || e.code === 'Backspace';
    // A range input steps itself: swallowing the arrow keys here would leave
    // the Options screen's three volume sliders adjustable by mouse only.
    const isRange = e.target && e.target.tagName === 'INPUT' && e.target.type === 'range';
    if ((dir || isConfirm || isBack) && !isRange) e.preventDefault();
    if (e.repeat) return;
    if (!down) {
      delete held[e.code];
      delete pressedAt[e.code];
      return;
    }
    if (e.code === 'Tab') {
      const list = focusables();
      if (list.length) {
        e.preventDefault();
        const i = focused ? list.indexOf(focused) : -1;
        setFocus(list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length]);
      }
      return;
    }
    if (!isInteractiveMenu()) return;
    if (dir) {
      held[e.code] = dir;
      pressedAt[e.code] = performance.now();
      repeatAt[e.code] = performance.now();
      doNav(dir);
      return;
    }
    if (isConfirm) {
      confirm();
      return;
    }
    if (isBack) {
      // While the race is paused main.js owns Escape on the pause screen itself
      // and resumes. Any screen opened *from* the pause menu (options, controls)
      // must swallow it and pop back instead: the old check only matched
      // `active.key === 'pause'`, so Escape in the pause options navigated back
      // *and* resumed the race in the same frame, dumping the player straight
      // into the live HUD.
      if (store.state.mode === MODES.PAUSED) {
        if (active.key === 'pause') return; // handed straight to main.js, which resumes
        goBack();                            // pop back to the pause screen
        return;
      }
      goBack();
    }
  }

  /**
   * Pops the screen stack and records that the UI consumed a Back press.
   * main.js reads `backSeq` to tell whether it should act on the same key.
   */
  function goBack() {
    backSeq++;
    back();
  }

  function isInteractiveMenu() {
    if (!active) return false;
    if (active.key === 'hud') return false;
    if (active.key === 'loading') return false;
    // The results screen is a real menu: its three buttons are data-focusable,
    // so arrow keys, Enter and the gamepad must work there too.
    if (loading.visible) return false; // the boot overlay owns input
    return true;
  }

  function doNav(dir) {
    if (active.key === 'charselect') menus.moveChar(dir === 'left' || dir === 'up' ? -1 : 1);
    else if (active.key === 'trackselect') menus.moveTrack(dir === 'left' || dir === 'up' ? -1 : 1);
    else navigate(dir);
  }

  const onKeyDown = (e) => onKey(true, e);
  const onKeyUp = (e) => onKey(false, e);
  const onPointerOver = (e) => {
    if (!active) return;
    const t = e.target;
    if (t && typeof t.closest === 'function') {
      const f = t.closest('[data-focusable]');
      if (f && active.el && active.el.contains(f)) setFocus(f);
    }
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  root.addEventListener('pointerover', onPointerOver);

  /* ------------------------------------------------------------- gamepad --- */

  const PAD_BTN = {
    A: 0,
    B: 1,
    START: 9,
    UP: 12,
    DOWN: 13,
    LEFT: 14,
    RIGHT: 15,
  };
  const padPrev = Object.create(null);
  let padDir = null;
  let padDirAt = 0;
  let padDirRepeat = 0;

  function padEdge(btn, isDown) {
    const was = padPrev[btn] === true;
    if (isDown && !was) {
      padPrev[btn] = true;
      return true;
    }
    if (!isDown && was) padPrev[btn] = false;
    return false;
  }

  function pollGamepad() {
    if (typeof navigator.getGamepads !== 'function') return;
    const pads = navigator.getGamepads();
    let pad = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
    if (!pad) return;
    const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const AX = 0.55;
    const dir =
      b(PAD_BTN.LEFT) || ax < -AX
        ? 'left'
        : b(PAD_BTN.RIGHT) || ax > AX
          ? 'right'
          : b(PAD_BTN.UP) || ay < -AX
            ? 'up'
            : b(PAD_BTN.DOWN) || ay > AX
              ? 'down'
              : null;

    if (isInteractiveMenu()) {
      if (dir && dir !== padDir) {
        padDir = dir;
        padDirAt = performance.now();
        padDirRepeat = performance.now();
        doNav(dir);
      } else if (!dir) {
        padDir = null;
      } else {
        const now = performance.now();
        if (now - padDirAt > 380 && now - padDirRepeat > 95) {
          padDirRepeat = now;
          doNav(dir);
        }
      }
      if (padEdge(PAD_BTN.A, b(PAD_BTN.A))) confirm();
      if (padEdge(PAD_BTN.B, b(PAD_BTN.B))) {
        if (active && active.key === 'pause') resumeRace();
        else goBack();
      }
      if (padEdge(PAD_BTN.START, b(PAD_BTN.START))) {
        if (active.key === 'pause') resumeRace();
        else if (active.key === 'hud') show('pause');
      }
    } else {
      padDir = null;
      padPrev[PAD_BTN.A] = b(PAD_BTN.A);
      padPrev[PAD_BTN.B] = b(PAD_BTN.B);
      padPrev[PAD_BTN.START] = b(PAD_BTN.START);
    }
  }

  function pollKeyRepeat(now) {
    for (const code in held) {
      const started = pressedAt[code];
      const last = repeatAt[code];
      if (started == null || last == null) continue;
      if (now - started > 340 && now - last > 90) {
        repeatAt[code] = now;
        doNav(held[code]);
      }
    }
  }

  /* ------------------------------------------------------------ bus wiring -- */

  const offs = [];
  if (bus) {
    offs.push(
      bus.on('race:update', (v) => {
        // Cache the director's view so the HUD works no matter who drives us.
        if (v) raceView = v;
      })
    );
    offs.push(
      bus.on('ui:toast', (p) => {
        if (!p) return;
        toast(p.text, p.kind, p.duration);
      })
    );
    offs.push(
      bus.on('fx:flash', (p) => {
        if (!p) return;
        flash(p.color, p.alpha, p.duration);
      })
    );
    offs.push(
      bus.on('race:countdown', (p) => {
        let n = null;
        if (typeof p === 'number') n = p;
        else if (p && typeof p === 'object') n = p.remaining != null ? p.remaining : p.count;
        if (typeof n === 'number') countdown(n);
      })
    );
    offs.push(
      bus.on('race:go', () => {
        goCountdown();
      })
    );
    offs.push(
      bus.on('race:lap', (p) => {
        if (p && p.isPlayer) hud.onLap(p);
      })
    );
    offs.push(
      bus.on('race:end', (p) => {
        const res = p && p.results ? p.results : store.state.results;
        if (res) results.show(res, recordsAtStart);
        lastCountdown = -1;
        // main.js also calls show('results'); doing it here keeps the shell
        // working even if that wiring ever changes.
        show('results');
      })
    );
  }

  /* ------------------------------------------------------------- main loop -- */

  let lastFrame = performance.now();
  let lastExternal = -1e9;
  let raf = 0;

  function advance(dt) {
    const step = clamp(dt || 0, 0, 0.1);
    loading.update(step);
    if (active && active.key === 'hud') hud.update(step, raceView);

    if (toastTimer > 0) {
      toastTimer -= step;
      if (toastTimer <= 0 && toastNode) toastNode.classList.add('out');
    }
    if (countTimer > 0) {
      countTimer -= step;
      if (countTimer <= 0) {
        countNum.classList.add('hidden');
        countRing.classList.add('hidden');
      }
    }
    if (flashTimer > 0) {
      flashTimer -= step;
      if (flashTimer <= 0) flashEl.classList.remove('hit');
    }

    const now = performance.now();
    pollGamepad();
    pollKeyRepeat(now);
  }

  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    // If a system loop is already driving us, skip this tick entirely.
    if (now - lastExternal < 24) {
      lastFrame = now;
      return;
    }
    const dt = (now - lastFrame) / 1000;
    lastFrame = now;
    advance(dt);
  }
  raf = requestAnimationFrame(frame);

  /* --------------------------------------------------------------- public -- */

  /**
   * Simulation-rate hook. Only caches the latest `RaceView` — DOM work happens
   * once per rendered frame in `updateView()` / the internal rAF loop, so this
   * stays cheap even when a system loop calls it at the fixed 120 Hz step.
   */
  function update(dt, view) {
    if (view) raceView = view;
    void dt;
  }

  function updateView(dt, view) {
    if (view) raceView = view;
    const now = performance.now();
    lastExternal = now;
    lastFrame = now;
    advance(clamp(dt || 0, 0, 0.1));
  }

  function dispose() {
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    root.removeEventListener('pointerover', onPointerOver);
    if (bus) for (const off of offs) off();
    loading.dispose();
    hud.dispose();
    results.dispose();
    menus.dispose();
    toastEl.remove();
    countEl.remove();
    flashEl.remove();
    root.classList.remove('kart-ui');
  }

  show('title');

  return {
    name: 'ui',
    persistent: true,
    show,
    update,
    updateView,
    attachRace,
    dispose,
    back,
    toast,
    flash,
    get active() {
      return active ? active.key : null;
    },
    get race() {
      return raceRef;
    },
    /** Counter of Back presses the shell handled. See `goBack()`. */
    get backSeq() {
      return backSeq;
    },
  };
}

export default createUI;
