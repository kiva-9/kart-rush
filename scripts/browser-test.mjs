#!/usr/bin/env node
/**
 * Headless-Chrome smoke driver (browser test harness).
 *
 * Boots the game in headless Chrome over the DevTools protocol, drives a full
 * race with the real render loop, and reports console output, page errors and
 * game state. Used by `npm run test:browser`.
 *
 *   node scripts/browser-test.mjs [--file dist-offline/kart-rush-offline.html]
 *                                  [--seconds 60] [--track frostbite-peaks]
 *                                  [--screenshot out.png] [--quiet]
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const flag = (name) => args.includes('--' + name);

const file = opt('file', '');
const seconds = Number(opt('seconds', '45'));
const trackId = opt('track', '');
const screenshot = opt('screenshot', '');
const quiet = flag('quiet');
const extraFlags = args.filter((a) => a.startsWith('--chrome.')).map((a) => a.slice(9));
/** Failures from the `--ui` menu walkthrough, folded into the exit status. */
let uiFail = 0;
/** Origin-root /favicon.ico 404s that no project Pages site can answer. */
let faviconNoise = 0;

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium-browser',
  'chromium',
];
const exe = CHROME.find((p) => !p.includes('/') || existsSync(p));
if (!exe) {
  console.error('[browser] no Chrome/Chromium found');
  process.exit(2);
}

// An absolute http(s) URL is used verbatim; anything else is resolved to a
// file:// path relative to the project root.
const target = /^https?:\/\//.test(file)
  ? file
  : file
    ? 'file://' + (file.startsWith('/') ? file : join(root, file))
    : '';

const port = 9333 + Math.floor(Math.random() * 500);
const proc = spawn(exe, [
  '--headless=new',
  '--no-sandbox',
  ...extraFlags,
  '--mute-audio',
  '--window-size=1280,720',
  '--no-first-run',
  '--user-data-dir=' + join(root, '.chrome-test-profile'),
  '--remote-debugging-port=' + port,
  '--remote-allow-origins=*',
  target || 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

proc.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up: ' + url);
}

let ws;
const pending = new Map();
let nextId = 1;
const consoleLines = [];
const errors = [];

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
    }, 60000);
  });
}

async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

function hookEvent(e) {
  if (!e || typeof e !== 'object') return;
  if (e.method === 'Runtime.consoleAPICalled') {
    const text = (e.params.args || []).map((a) => {
      if (a.value !== undefined) return String(a.value);
      if (a.preview) return JSON.stringify(a.preview).slice(0, 400);
      return a.type;
    }).join(' ');
    consoleLines.push({ type: e.params.type, text });
    return;
  }
  if (e.method === 'Runtime.exceptionThrown') {
    const d = e.params.exceptionDetails;
    errors.push(d?.exception?.description || d?.text || JSON.stringify(d));
    return;
  }
  if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
    const text = e.params.entry.text || '';
    const url = e.params.entry.url || '';
    // Chrome's favicon service asks the *origin root* for /favicon.ico
    // regardless of what the page declares, and a project Pages site
    // (https://<user>.github.io/<repo>/) can never serve that path — it belongs
    // to the user site. The page itself makes no such request, so it is
    // environment noise and not something the deployment can fix. Everything
    // else still counts.
    const originRootFavicon = /\/favicon\.ico$/.test(url) &&
      new URL(url).pathname === '/favicon.ico';
    if (text.includes('404') && originRootFavicon) {
      faviconNoise++;
      return;
    }
    errors.push('[log] ' + text + ' ' + url);
  }
}

async function main() {
  const version = await fetchJson('http://127.0.0.1:' + port + '/json/version');
  const targets = await fetchJson('http://127.0.0.1:' + port + '/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target; got ' + JSON.stringify(targets.map((t) => t.type)));

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.id && pending.has(e.id)) {
      const p = pending.get(e.id);
      pending.delete(e.id);
      e.error ? p.reject(new Error(e.error.message)) : p.resolve(e.result);
      return;
    }
    hookEvent(e);
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  // wait for the game handle to exist
  let ready = null;
  for (let i = 0; i < 80; i++) {
    try {
      ready = await evaluate('typeof window.kartRush === "object" ? (window.kartRush.store.state.mode) : "missing"');
      if (ready === 'missing') await sleep(500);
      else break;
    } catch { await sleep(500); }
  }
  if (ready === 'missing') {
    console.error('[browser] FAIL: window.kartRush never appeared');
    console.error(consoleLines.map((l) => l.type + ': ' + l.text).join('\n'));
    console.error(errors.join('\n'));
    shutdown(1);
  }
  if (!quiet) console.log('[browser] booted, mode=' + ready);

  // Menu / keyboard walkthrough. This is the only place the shell's input
  // handling is exercised for real: the DOM shim has no element tree, so the
  // pause-escape, results-keyboard and options-navigation fixes can only be
  // verified by actually dispatching keys.
  if (flag('ui')) {
    const uiReport = await evaluate(`(async function () {
      const ui = window.kartRush.ui;
      const store = window.kartRush.store;
      if (!ui) return { error: 'no ui' };
      const out = [];
      const expect = (label, got, want) => out.push({ label, got, want, pass: got === want });
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const focused = () => document.querySelector('[data-focused]');
      // Dispatch on the focused element: the shell asks e.target to tell a range
      // input from a menu screen.
      const tap = async (code) => {
        const host = focused() || document.body;
        for (const type of ['keydown', 'keyup']) {
          host.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
        }
        await frame();
      };

      for (const s of ['title', 'charselect', 'trackselect', 'options', 'controls', 'pause']) {
        ui.show(s);
        expect('show(' + s + ')', ui.active, s);
      }

      ui.show('options');
      expect('the options screen has focusable controls',
        document.querySelectorAll('.screen:not(.hidden) [data-focusable]').length > 2, true);
      await tap('Tab');
      expect('Tab moves the focus', focused() != null, true);
      const count = () => document.querySelectorAll('.screen:not(.hidden) [data-focusable]').length;
      const seen = new Set();
      for (let i = 0; i < count(); i++) { await tap('Tab'); const f = focused(); if (f) seen.add(f.textContent); }
      expect('every options control can be reached by Tab', seen.size >= 6, true);

      ui.show('title');
      ui.show('pause');
      store.set({ mode: 'paused' });
      await tap('Escape');
      expect('Escape on the pause screen resumes', store.state.mode, 'racing');
      expect('...and lands on the HUD', ui.active, 'hud');

      ui.show('title');
      ui.show('pause');
      store.set({ mode: 'paused' });
      ui.show('options');
      await tap('Escape');
      expect('Escape in the pause options pops the stack instead', ui.active, 'pause');
      expect('...and leaves the race paused', store.state.mode, 'paused');
      store.set({ mode: 'finished', results: null });
      ui.show('results');
      expect('the results screen offers keyboard focusables',
        document.querySelectorAll('.results-screen [data-focusable]').length >= 3, true);
      await tap('Tab');
      expect('Tab focuses a results button', focused() && focused().tagName, 'BUTTON');
      const beforeActivate = ui.active;
      await tap('Enter');
      expect('Enter activates the focused results button', ui.active !== beforeActivate, true);

      ui.show('options');
      const slider = document.querySelector('input[type="range"]');
      if (slider) {
        // The shell tracks its own data-focused attribute; give the input a real
        // focus too, so the dispatched event really targets the range. (This is
        // what the shell's own navigation does when it lands on one.)
        for (const el of document.querySelectorAll('[data-focused]')) el.removeAttribute('data-focused');
        slider.setAttribute('data-focused', '1');
        slider.focus();
        const host = document.querySelector('[data-focused]') || slider;
        const ev = new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true, cancelable: true });
        // A synthetic event never triggers the UA's native range-stepping, so
        // measure the thing the fix actually changed: whether the shell swallows
        // the key at all.
        const notSwallowed = host.dispatchEvent(ev);
        expect('a focused slider keeps its arrow keys', notSwallowed, true);
      } else {
        expect('the options screen has a slider', false, 'no input[type=range] found');
      }
      try { return JSON.stringify({ out }); } catch (e) { return JSON.stringify({ fatal: String(e && e.stack || e) }); }
    })()`, true);
    let parse = null;
    try { parse = JSON.parse(uiReport); } catch (e) { parse = { fatal: String(e.message) + ' raw=' + String(uiReport).slice(0, 200) }; }
    if (parse && parse.fatal) { console.log('   FATAL ' + parse.fatal); uiFail++; }
    const uiReport2 = parse && parse.out ? parse.out : [];
    if (uiReport2.length) {
      let bad = 0;
      for (const r of uiReport2) {
        if (!r.pass) bad++;
        console.log('   ' + (r.pass ? 'ok   ' : 'FAIL ') + r.label +
          ' (got ' + JSON.stringify(r.got) + ', want ' + JSON.stringify(r.want) + ')');
      }
      uiFail += bad;
      console.log('[browser] UI walkthrough: ' + (uiReport2.length - bad) + '/' + uiReport2.length + ' ok');
    } else {
      console.log('[browser] UI walkthrough failed: ' + JSON.stringify(uiReport) + ' :: ' + (uiReport && uiReport.error));
      uiFail++;
    }
    // Put things back the way the race flow expects.
    await evaluate('window.kartRush.goToTitle()');
    await sleep(400);
  }

  // start a race
  await evaluate('window.__raceStart = Date.now(); window.__errors = 0;');
  const start = await evaluate(`(function () {
    try {
      const cfg = { laps: ${Number(opt('laps', '2'))}${trackId ? ', trackId: "' + trackId + '"' : ''}${opt('playerCount', '') ? ', playerCount: ' + Number(opt('playerCount')) : ''}${flag('timetrial') ? ', timeTrial: true' : ''} };
      window.kartRush.beginRace(cfg);
      return 'ok';
    } catch (e) { return 'ERR ' + (e && e.stack || e); }
  })()`);
  if (String(start).startsWith('ERR')) {
    console.error('[browser] FAIL: beginRace threw: ' + start);
    shutdown(1);
  }

  // let it run for the requested wall-clock seconds
  const samples = [];
  const t0 = Date.now();
  let lastCount = -1;

  // Count the fixed-loop update() calls against the view-loop updateView()
  // calls for the simOnly systems (cameraRig / particles / cameraShake). They
  // are supposed to run once per rendered frame, from updateView only; the
  // inverted guard in Game.step() used to drive them from update() at 1/120 s
  // instead, which halved the camera's motion on a 60 Hz display.
  //
  // The race builds asynchronously, so the systems may not exist yet — poll for
  // them rather than silently recording an empty set.
  let fxInstalled = false;
  for (let i = 0; i < 40 && !fxInstalled; i++) {
    const n = await evaluate(`(function () {
      const g = window.kartRush.game;
      window.__fx = {};
      for (const name of ['cameraRig', 'particles', 'cameraShake']) {
        const sys = g.getSystem(name);
        if (!sys) continue;
        const counts = { updateCalls: 0, updateDt: 0, viewCalls: 0, viewDt: 0 };
        window.__fx[name] = counts;
        const u = sys.update.bind(sys);
        const v = sys.updateView.bind(sys);
        sys.update = function (dt) { counts.updateCalls++; counts.updateDt += dt; return u(dt); };
        sys.updateView = function (dt) { counts.viewCalls++; counts.viewDt += dt; return v(dt); };
      }
      return Object.keys(window.__fx).length;
    })()`);
    fxInstalled = n >= 3;
    if (!fxInstalled) await sleep(500);
  }

  while (Date.now() - t0 < seconds * 1000) {
    await sleep(1000);
    try {
      const s = await evaluate(`(function () {
        const race = window.kartRush.race;
        const g = window.kartRush.game;
        if (!race) return { phase: 'none', mode: window.kartRush.store.state.mode };
        const rd = race.race || race;
        const v = rd && typeof rd.view === 'function' ? rd.view() : null;
        return {
          phase: rd && rd.phase ? rd.phase : '?',
          mode: window.kartRush.store.state.mode,
          karts: race.karts ? race.karts.length : 0,
          frames: g.frame,
          fps: g.stats.fps,
          drawCalls: g.stats.drawCalls,
          tris: g.stats.triangles,
          timeMs: v ? v.timeMs : -1,
          standings: v ? v.standings.map((s) => s.name + ':' + s.lap + ':' + Math.round(s.speedKmh || 0)).join(' ') : '',
          player: v && v.player ? Math.round(v.player.speedKmh * 100) / 100 : null,
          ys: race.karts ? race.karts.map((k) => Math.round(k.position.y * 10) / 10).join(',') : '',
        };
      })()`);
      samples.push(s);
      if (!quiet) {
        const n = Math.round((Date.now() - t0) / 1000);
        if (n !== lastCount) {
          lastCount = n;
          console.log('[browser] t=' + n + 's ' + JSON.stringify(s).slice(0, 500));
        }
      }
    } catch (err) {
      console.error('[browser] evaluate failed: ' + err.message);
      errors.push('evaluate: ' + err.message);
    }
  }

  // Results snapshot: the table must list the whole field, not just whoever
  // happened to have crossed the line when the end sequence started.
  try {
    const res = await evaluate(`(function () {
      const st = window.kartRush.store.state;
      const r = st.results;
      if (!r) return 'no results';
      const rows = document.querySelectorAll('.res-tbody tr').length;
      return JSON.stringify({
        entries: (r.entries || []).length,
        rowsInDom: rows,
        names: (r.entries || []).map((e) => e.position + ':' + e.name + (e.finished ? '' : '*')).join(' '),
        playerPosition: r.playerPosition,
        layout: (function () {
          const panel = document.querySelector('.results-panel');
          const body = document.querySelector('.results-body');
          const screen = document.querySelector('.results-screen');
          if (!panel || !body || !screen) return null;
          const first = document.querySelector('.res-tbody tr');
          return {
            screenH: Math.round(screen.getBoundingClientRect().height),
            panelH: Math.round(panel.getBoundingClientRect().height),
            bodyH: Math.round(body.getBoundingClientRect().height),
            bodyScrollH: Math.round(body.scrollHeight),
            rowH: first ? Math.round(first.getBoundingClientRect().height) : null,
          };
        })(),
      });
    })()`);
    console.log('[browser] results: ' + res);
  } catch (err) {
    console.error('[browser] results probe failed: ' + err.message);
  }

  if (screenshot) {
    try {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const dir = dirname(screenshot);
      if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
      writeFileSync(screenshot, Buffer.from(r.data, 'base64'));
      if (!quiet) console.log('[browser] screenshot -> ' + screenshot);
    } catch (err) {
      console.error('[browser] screenshot failed: ' + err.message);
    }
  }

  const summary = consoleLines.filter((l) => /error|warn/i.test(l.type));
  const fxCounts = await evaluate('window.__fx ? JSON.stringify(window.__fx) : null').catch(() => null);
  if (fxCounts) {
    let bad = false;
    const parsed = JSON.parse(fxCounts);
    const lines = [];
    for (const k of Object.keys(parsed)) {
      const c = parsed[k];
      lines.push(k + ': update ' + c.updateCalls + 'x ' + c.updateDt.toFixed(2) + 's | updateView ' + c.viewCalls + 'x ' + c.viewDt.toFixed(2) + 's');
      // cameraShake is legitimately driven by CameraRig.step() too, so only the
      // two systems the integrator registers are checked for "updateView only".
      // What matters is that their total advanced time matches the wall clock:
      // a simOnly system driven from the fixed loop accumulates exactly
      // 1/120 s per rendered frame instead of the real delta.
      if (k !== 'cameraShake' && (c.updateCalls !== 0 || c.viewCalls === 0)) bad = true;
      if (k === 'cameraShake' && c.viewCalls === 0) bad = true;
    }
    console.log('[browser] fx entry points: ' + lines.join(' ; '));
    if (bad) console.log('[browser] FAIL: a simOnly system was still driven from the fixed 120 Hz loop');
  }
  console.log('\n[browser] console lines: ' + consoleLines.length +
    ' (' + consoleLines.filter((l) => l.type === 'error').length + ' error, ' +
    consoleLines.filter((l) => l.type === 'warning').length + ' warning)');
  for (const l of consoleLines.slice(0, 60)) console.log('   ' + l.type + ': ' + l.text.slice(0, 300));
  if (errors.length) {
    console.log('[browser] PAGE ERRORS (' + errors.length + '):');
    for (const e of errors.slice(0, 40)) console.log('   ' + String(e).split('\n').slice(0, 4).join('\n     '));
  }
  if (faviconNoise) {
    console.log('[browser] note: ' + faviconNoise +
      ' origin-root /favicon.ico 404(s) ignored — no project Pages site can serve that path');
  }
  const fail = errors.length > 0 || consoleLines.some((l) => l.type === 'error') || uiFail > 0;
  console.log('[browser] ' + (fail ? 'FAIL' : 'PASS'));
  shutdown(fail ? 1 : 0);
}

function shutdown(code) {
  try { ws && ws.close(); } catch {}
  try { proc.kill('SIGKILL'); } catch {}
  process.exit(code);
}

process.on('uncaughtException', (e) => { console.error('[browser] driver crashed', e); shutdown(1); });
main().then(() => shutdown(0)).catch((e) => { console.error('[browser] driver error', e); shutdown(1); });
