/**
 * Boot: creates the Game, the persistent audio + UI systems, the title scene,
 * and owns the top-level mode transitions (pause, race start, race end).
 */
// Imported from JS rather than only linked from index.html, because Vite does
// not extract an HTML <link> into an asset when building an IIFE bundle, which
// the offline single-file build needs.
import './styles/main.css';
import { Game } from './core/Game.js';
import { GameStore, MODES, loadPersisted, persist, saveRecord } from './core/Store.js';
import { input, Actions } from './core/Input.js';
import { startRace, endRace } from './race/Bootstrap.js';
import { buildTitleScene, disposeTitleScene } from './world/TitleScene.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('scene'));
const uiRoot = /** @type {HTMLElement} */ (document.getElementById('ui-root'));

loadPersisted();
window.addEventListener('error', (e) => {
  const stack = (e.error && e.error.stack) || e.message;
  console.error('[kart-rush] ' + stack);
});
window.addEventListener('unhandledrejection', (e) => console.error('[kart-rush] ' + (e.reason && e.reason.stack ? e.reason.stack : e.reason)));

const game = new Game({ canvas, uiRoot });
game.applyQuality(GameStore.state.quality);

/* ------------------------------------------------------------------ audio ---- */
let audio = null;

function bootAudio() {
  return import('./core/Audio.js')
    .then((m) => {
      const Ctor = m.AudioSystem || m.default;
      if (typeof Ctor !== 'function') return null;
      const a = new Ctor(game.ctx());
      a.persistent = true;
      game.addSystem('audio', a);
      a.setVolumes?.({ master: GameStore.state.masterVolume, music: GameStore.state.musicVolume, sfx: GameStore.state.sfxVolume });
      a.setMuted?.(GameStore.state.muted);
      return a;
    })
    .catch((err) => {
      console.error('[audio] unavailable', err);
      return null;
    });
}

function unlockAudio() {
  if (!audio) return;
  audio.unlock?.() ?? audio.resume?.();
  audio.playMusic?.('menu', 1.4);
  window.removeEventListener('pointerdown', unlockAudio);
  window.removeEventListener('keydown', unlockAudio);
}
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

/* --------------------------------------------------------------------- UI ---- */
/** The shell is loaded lazily so a UI problem can never stop the game booting. */
let ui = null;

async function bootUI() {
  try {
    const m = await import(/* @vite-ignore */ './ui/UI.js');
    const make = m.createUI || m.default;
    if (typeof make !== 'function') throw new Error('ui/UI.js exports no createUI()');
    ui = make(game.ctx());
    ui.persistent = true;
    if (!ui) return null;
    game.addSystem('uiShell', {
      updateView(dt) {
        // updateView, not update: `update()` only caches the RaceView, whereas
        // updateView() actually advances the UI. Calling the former meant the
        // UI ran its own second requestAnimationFrame loop beside Game's and
        // the "an external loop is driving us" guard never fired.
        if (typeof ui.updateView === 'function') ui.updateView(dt, raceView);
        else if (typeof ui.update === 'function') ui.update(dt, raceView);
      },
      dispose() {
        try {
          ui.dispose?.();
        } catch (e) {
          console.error('[ui] dispose failed', e);
        }
      },
      persistent: true,
    });
    return ui;
  } catch (err) {
    console.error('[ui] failed to load, continuing without the menu shell', err);
    ui = null;
    return null;
  }
}

let raceView = null;
game.bus.on('race:update', (v) => {
  raceView = v;
});

/* ---------------------------------------------------------------- quality ---- */
// The options screen owns the setting and calls game.applyQuality() itself; the
// renderer only needs seeding here at boot, and again at each race start so a
// kart built for the previous tier is rebuilt at the right detail level.
let appliedQuality = GameStore.state.quality;
game.applyQuality(appliedQuality);

/* --------------------------------------------------------------- race flow --- */

let starting = false;
let titleScene = null;

async function goToTitle() {
  endRace();
  game.setCameraMode('title');
  GameStore.set({ mode: MODES.TITLE, race: null, results: null });
  GameStore.notify();
  // The overlay stays up for the whole world build, then swaps straight to the
  // title, so the menu never appears over an empty scene.
  ui?.show?.('loading');
  titleScene = await buildTitleScene(game.ctx());
  ui?.show?.('title');
  audio?.playMusic?.('menu', 1.2);
}

async function beginRace(cfg) {
  if (starting) return;
  starting = true;
  try {
    disposeTitleScene();
    endRace();
    appliedQuality = GameStore.state.quality;
    game.applyQuality(appliedQuality);
    GameStore.set({ mode: MODES.COUNTDOWN, race: null, results: null });
    GameStore.notify();
    ui?.show?.('loading');
    const session = await startRace(game.ctx(), cfg || {});
    if (!session) {
      console.error('[race] session failed to build');
      await goToTitle();
      return;
    }
    GameStore.set({ mode: MODES.RACING });
    GameStore.notify();
    ui?.show?.('hud');
    ui?.attachRace?.(session.race || session);
  } catch (err) {
    console.error('[race] failed to start', err);
    await goToTitle();
  } finally {
    starting = false;
  }
}

game.bus.on('race:request', (cfg) => beginRace(cfg));
game.bus.on('ui:quitToTitle', () => goToTitle());
game.bus.on('ui:rematch', () => beginRace({ rematch: true }));
game.bus.on('ui:restart', () => beginRace({ rematch: true }));
game.bus.on('ui:back', () => goToTitle());

game.bus.on('race:go', () => {
  game.setCameraMode('chase');
});

game.bus.on('race:countdown', (p) => {
  const n = p?.remaining ?? p?.count ?? p;
  if (typeof n === 'number' && n > 0) game.sfx('countdown');
  else game.sfx('countdownGo');
});

game.bus.on('race:end', (payload) => {
  const results = payload?.results || GameStore.state.results;
  audio?.stopMusic?.(0.8);
  if (results) {
    GameStore.set({ mode: MODES.FINISHED, results });
    GameStore.notify();
    const trackId = results.trackId || GameStore.state.trackId;
    const player = (results.entries || []).find((e) => e.isPlayer);
    if (player && player.bestLapMs) saveRecord(trackId, player.bestLapMs, player.totalMs || Infinity);
    ui?.show?.('results');
  }
});

game.bus.on('kart:finish', (p) => {
  if (p?.isPlayer) game.sfx('finish');
});

game.bus.on('race:lap', (p) => {
  if (p?.isPlayer) game.sfx(p.lap === GameStore.state.laps ? 'finalLap' : 'lap');
});

/* --------------------------------------------------------------- pause etc. --- */
/**
 * The shell handles a Back press in the same keydown event this system sees on
 * the following frame, so the pause system diffs the shell's counter rather than
 * inspecting which screen is up — the screen has already been popped by then.
 */
let lastBackSeq = -1;
const pauseSystem = {
  persistent: true,
  updateView(dt) {
    const mode = GameStore.state.mode;
    const backSeq = ui && typeof ui.backSeq === 'number' ? ui.backSeq : 0;
    const uiHandledBack = backSeq !== lastBackSeq;
    lastBackSeq = backSeq;
    if (input.justPressed(Actions.PAUSE)) {
      if (mode === MODES.RACING || mode === MODES.COUNTDOWN) {
        GameStore.set({ mode: MODES.PAUSED });
        GameStore.notify();
        ui?.show?.('pause');
        audio?.pauseAll?.();
      } else if (mode === MODES.PAUSED && !uiHandledBack) {
        GameStore.set({ mode: MODES.RACING });
        GameStore.notify();
        ui?.show?.('hud');
        audio?.resumeAll?.();
      }
    }
    if (input.justPressed(Actions.HORN)) game.sfx('star', { volume: 0.25, rate: 1.6 });
  },
  dispose() {},
};
game.addSystem('flow', pauseSystem);

/* ------------------------------------------------------------------ start ---- */
game.start();

bootAudio().then((a) => {
  audio = a;
});
bootUI().then(() => {
  goToTitle();
});

/* Expose a tiny handle for debugging in the console. */
import { activeRace } from './race/Bootstrap.js';
window.kartRush = {
  game,
  store: GameStore,
  get ui() { return ui; },
  goToTitle,
  beginRace,
  persist,
  get modes() { return MODES; },
  get race() { return activeRace(); },
};
