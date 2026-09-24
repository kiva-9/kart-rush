/**
 * Menu shell for Kart Rush: title screen, character select, track select,
 * race options, controls reference and the pause menu.
 *
 * Everything is built with plain DOM and procedurally painted canvases — no
 * image assets. The screens only talk back through the `api` object handed to
 * `createMenus`, so this module never has to know who owns the screen stack.
 */

import { CONFIG } from '../data/config.js';
import { GameStore, persist } from '../core/Store.js';
import { formatTime } from '../core/MathUtils.js';
// Namespace imports + runtime guards: the data modules are owned elsewhere and
// may be mid-change, so a missing export must degrade, never crash boot.
import * as CharsMod from '../data/characters.js';
import * as TracksMod from '../data/tracks.js';

const CHARACTERS = Array.isArray(CharsMod.CHARACTERS) ? CharsMod.CHARACTERS : [];
const TRACKS = Array.isArray(TracksMod.TRACKS) ? TracksMod.TRACKS : [];
const DEFAULT_CHARACTER_ID = CharsMod.DEFAULT_CHARACTER_ID || 'bolt';
const DEFAULT_TRACK_ID = TracksMod.DEFAULT_TRACK_ID || 'sunset-circuit';
const drawCharacterPortrait =
  typeof CharsMod.drawCharacterPortrait === 'function' ? CharsMod.drawCharacterPortrait : null;

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

const INK = 'rgba(10, 14, 26, 0.9)';

/* =========================================================== canvas art ==== */

/** Own stylised racer icon, used only if the portrait painter is unavailable. */
function paintOwnIcon(g, ch, size) {
  const s = size;
  const p = ch.palette || {};
  const col = p.primary || ch.color || '#e8352f';
  const acc = p.accent || '#ffd60a';
  const skin = p.skin || '#f2b98d';
  g.clearRect(0, 0, s, s);
  g.save();
  const u = s / 100;
  const bg = g.createLinearGradient(0, 0, 0, s);
  bg.addColorStop(0, 'rgba(255,255,255,0.14)');
  bg.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = bg;
  g.fillRect(0, 0, s, s);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  // torso
  g.fillStyle = col;
  g.beginPath();
  g.moveTo(30 * u, 96 * u);
  g.quadraticCurveTo(22 * u, 70 * u, 50 * u, 62 * u);
  g.quadraticCurveTo(78 * u, 70 * u, 70 * u, 96 * u);
  g.closePath();
  g.fill();
  g.strokeStyle = INK;
  g.lineWidth = 2.4 * u;
  g.stroke();
  // collar
  g.fillStyle = acc;
  g.beginPath();
  g.ellipse(50 * u, 63 * u, 15 * u, 5 * u, 0, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // head
  g.fillStyle = skin;
  g.beginPath();
  g.arc(50 * u, 42 * u, 18 * u, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // cap
  g.fillStyle = p.cap || col;
  g.beginPath();
  g.arc(50 * u, 42 * u, 18.6 * u, Math.PI, 0);
  g.closePath();
  g.fill();
  g.stroke();
  g.beginPath();
  g.ellipse(30 * u, 42 * u, 11 * u, 4.6 * u, -0.16, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // eyes + smile
  g.fillStyle = INK;
  g.beginPath();
  g.arc(44 * u, 44 * u, 2.2 * u, 0, Math.PI * 2);
  g.arc(57 * u, 44 * u, 2.2 * u, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 1.8 * u;
  g.beginPath();
  g.arc(50 * u, 50 * u, 6 * u, 0.15 * Math.PI, 0.85 * Math.PI);
  g.stroke();
  g.restore();
}

function paintCharacter(g, ch, size) {
  if (drawCharacterPortrait) {
    drawCharacterPortrait(g, ch, size);
    return;
  }
  paintOwnIcon(g, ch, size);
}

/** Flatten a track def's control points into the [x, z, ...] minimap layout. */
function flattenPath(def) {
  const raw = Array.isArray(def.path) ? def.path : [];
  const out = [];
  for (const p of raw) {
    if (!p || p.length < 3) continue;
    out.push(+p[0], +p[2]);
  }
  return out;
}

export function hexToRgb(hex) {
  const raw = String(hex == null ? '#ffffff' : hex).replace('#', '');
  // tracks.js hands over *numbers* (0x3b3b42). Stringifying one and parsing the
  // decimal digits as hex produced a 28-bit value whose bytes are garbage, so
  // every track-select thumbnail and the big preview drew the road, kerb,
  // terrain and sky in colours nothing had ever asked for.
  const v = typeof hex === 'number' && Number.isFinite(hex)
    ? (hex >>> 0)
    : parseInt(raw.length === 3 ? raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2] : raw.padEnd(6, '0'), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgba(hex, a) {
  const c = hexToRgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** Top-down track outline painter used by the track-select cards + preview. */
function paintTrack(g, size, pts, def, opts) {
  const o = opts || {};
  g.clearRect(0, 0, size, size);
  if (!pts || pts.length < 4) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minZ) minZ = pts[i + 1];
    if (pts[i + 1] > maxZ) maxZ = pts[i + 1];
  }
  const pad = size * 0.09;
  const ex = Math.max(1, maxX - minX);
  const ez = Math.max(1, maxZ - minZ);
  const k = (size - pad * 2) / Math.max(ex, ez);
  const ox = size * 0.5 - ((minX + maxX) * 0.5) * k;
  const oz = size * 0.5 - ((minZ + maxZ) * 0.5) * k;
  const X = (x) => x * k + ox;
  const Z = (z) => z * k + oz;
  const half = Math.max(2.2, (+(def.width || 11) || 11) * k);
  const theme = def.theme || {};
  const road = theme.road != null ? theme.road : 0x3b3b42;
  const terrain = theme.terrain != null ? theme.terrain : 0x748a3c;

  // backdrop
  const bg = g.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, rgba(theme.sky ? theme.sky.top : 0x1e3a7a, 0.55));
  bg.addColorStop(0.55, rgba(theme.sky ? theme.sky.horizon : 0xff9d4d, 0.28));
  bg.addColorStop(1, rgba(terrain, 0.35));
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);

  const trace = () => {
    g.beginPath();
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const x = X(pts[i * 2]);
      const y = Z(pts[i * 2 + 1]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
  };
  g.lineJoin = 'round';
  g.lineCap = 'round';

  trace();
  g.strokeStyle = rgba(theme.curbA != null ? theme.curbA : 0xe0322a, 0.75);
  g.lineWidth = half * 2 + Math.max(2, size * 0.014);
  g.stroke();
  trace();
  g.strokeStyle = rgba(road, 0.98);
  g.lineWidth = half * 2;
  g.stroke();
  trace();
  g.strokeStyle = 'rgba(255,255,255,0.13)';
  g.lineWidth = half * 1.05;
  g.stroke();

  // direction chevrons
  const n = pts.length / 2;
  const step = Math.max(1, Math.floor(n / 26));
  g.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < n; i += step) {
    const j = (i + 1) % n;
    const ax = X(pts[i * 2]);
    const ay = Z(pts[i * 2 + 1]);
    const bx = X(pts[j * 2]);
    const by = Z(pts[j * 2 + 1]);
    const dl = Math.hypot(bx - ax, by - ay) || 1;
    const tx = (bx - ax) / dl;
    const ty = (by - ay) / dl;
    const cx = (ax + bx) * 0.5;
    const cy = (ay + by) * 0.5;
    const r = Math.max(1.6, size * 0.011);
    g.beginPath();
    g.moveTo(cx + tx * r * 1.9, cy + ty * r * 1.9);
    g.lineTo(cx - tx * r - ty * r * 1.2, cy - ty * r + tx * r * 1.2);
    g.lineTo(cx - tx * r + ty * r * 1.2, cy - ty * r - tx * r * 1.2);
    g.closePath();
    g.fill();
  }

  // start / finish
  const i0 = Math.round((+(def.startLine || 0)) * n) % n;
  const i1 = (i0 + 1) % n;
  const sx = X(pts[i0 * 2]);
  const sy = Z(pts[i0 * 2 + 1]);
  const sdx = X(pts[i1 * 2]) - sx;
  const sdy = Z(pts[i1 * 2 + 1]) - sy;
  const dl = Math.hypot(sdx, sdy) || 1;
  const nx = -sdy / dl;
  const ny = sdx / dl;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 2; j++) {
      const t0 = (i / 6 - 0.5) * half * 1.9;
      const t1 = ((i + 1) / 6 - 0.5) * half * 1.9;
      g.fillStyle = (i + j) % 2 === 0 ? '#ffffff' : 'rgba(12,16,34,0.95)';
      g.beginPath();
      g.moveTo(sx + nx * t0, sy + ny * t0);
      g.lineTo(sx + nx * t1, sy + ny * t1);
      g.lineTo(sx + nx * t1 + sdx * 0.12, sy + ny * t1 + sdy * 0.12);
      g.lineTo(sx + nx * t0 + sdx * 0.12, sy + ny * t0 + sdy * 0.12);
      g.closePath();
      g.fill();
    }
  }

  if (o.selected) {
    g.strokeStyle = 'rgba(255, 214, 10, 0.9)';
    g.lineWidth = Math.max(2, size * 0.014);
    trace();
    g.stroke();
  }
}

/* ============================================================ stat bars ==== */

const STAT_ROWS = [
  ['speed', 'SPD'],
  ['accel', 'ACC'],
  ['handling', 'HND'],
  ['weight', 'WGT'],
];

function statBars(stats, big) {
  const wrap = h('div', { class: big ? 'statbar big' : 'statbar' });
  for (const [key, label] of STAT_ROWS) {
    const v = Math.max(0, Math.min(5, +(stats && stats[key] != null ? stats[key] : 0)));
    wrap.append(
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'k', text: label }),
        h('span', { class: `track ${key}` }, h('i', { style: { width: `${(v / 5) * 100}%` } }))
      )
    );
  }
  return wrap;
}

/* ============================================================== controls ==== */

const CONTROLS = [
  ['Accelerate', ['W', '↑'], 'A / RT'],
  ['Brake / Reverse', ['S', '↓'], 'B / LT'],
  ['Steer', ['A', 'D', '←', '→'], 'Left stick'],
  ['Drift / Hop', ['Shift', 'Space', 'C'], 'A / RB'],
  ['Use item', ['E', 'F', 'Ctrl'], 'X / LB'],
  ['Look behind', ['B'], 'LB / ↓'],
  ['Horn', ['H'], 'Y / RB'],
  ['Rescue kart', ['R'], '—'],
  ['Pause', ['Esc', 'P'], 'Start'],
];

function controlsScreen() {
  const kb = h('div', { class: 'controls-grid' });
  const pad = h('div', { class: 'controls-grid' });
  for (const [label, keys, gamepad] of CONTROLS) {
    kb.append(
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'ctl-label', text: label }),
        h('span', { class: 'ctl-keys' }, keys.map((k) => h('span', { class: 'kbd', text: k })))
      )
    );
    pad.append(
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'ctl-label', text: label }),
        h('span', { class: 'ctl-keys' }, h('span', { class: 'kbd', text: gamepad }))
      )
    );
  }
  return h(
    'div',
    { class: 'ctl-cols' },
    h('div', { class: 'panel ctl-panel' }, h('div', { class: 'panel-head' }, h('span', { text: 'Keyboard' })), h('div', { class: 'panel-body' }, kb)),
    h('div', { class: 'panel ctl-panel' }, h('div', { class: 'panel-head' }, h('span', { text: 'Gamepad' })), h('div', { class: 'panel-body' }, pad))
  );
}

/* ============================================================== options ==== */

const CC_VALUES = [50, 100, 150, 200];
const LAP_VALUES = [2, 3, 4, 5];
const DIFF_VALUES = ['easy', 'normal', 'hard', 'insane'];
// 1 is included because a Time Trial parks `playerCount` at 1 while it runs;
// without it every segment showed aria-pressed="false" on the pause options.
export const KART_VALUES = [1, 2, 3, 4, 5, 6, 7, 8];
const QUALITY_VALUES = ['low', 'medium', 'high'];

function optionsScreen(store, apply) {
  const groups = [];

  const seg = (label, desc, key, values, current, fmt, onPick) => {
    const btns = values.map((v) =>
      h('button', {
        type: 'button',
        // Without data-focusable these never entered the shell's focus list, so
        // the whole Options row was unreachable by keyboard and gamepad while
        // the arrow keys were being swallowed.
        'data-focusable': '1',
        text: fmt(v),
        'aria-pressed': String(v === current),
        onClick: () => onPick(v),
      })
    );
    const wrap = h('div', { class: 'seg' }, btns);
    const row = h(
      'div',
      { class: 'settings-row' },
      h('div', {}, h('div', { class: 'label', text: label }), h('div', { class: 'desc', text: desc })),
      wrap
    );
    groups.push({ wrap, key, values });
    return row;
  };

  const s = store.state;
  const toggle = (key, value) => {
    store.set({ [key]: value });
    persist();
    apply();
    refresh();
  };

  const cc = seg('Engine class', 'Faster classes mean higher top speed and twitchier karts.', 'cc', CC_VALUES, s.cc, (v) => `${v}cc`, (v) => toggle('cc', v));
  const laps = seg('Laps', 'Short races are punchy; long races reward consistency.', 'laps', LAP_VALUES, s.laps, (v) => `${v}`, (v) => toggle('laps', v));
  const diff = seg('Difficulty', 'How hard the AI racers push.', 'difficulty', DIFF_VALUES, s.difficulty, (v) => v.toUpperCase(), (v) => toggle('difficulty', v));
  const karts = seg('Field size', 'How many karts line up on the grid.', 'playerCount', KART_VALUES, s.playerCount, (v) => `${v}`, (v) => toggle('playerCount', v));
  const quality = seg('Quality', 'Shadows, bloom and internal resolution.', 'quality', QUALITY_VALUES, s.quality, (v) => v.toUpperCase(), (v) => toggle('quality', v));

  const sliders = [];

  const slider = (label, desc, key) => {
    const val = h('span', { class: 'seg-val', text: `${Math.round(store.state[key] * 100)}` });
    const input = h('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(store.state[key]),
      'aria-label': label,
      'data-focusable': '1',
      onInput: () => {
        const v = +input.value;
        store.set({ [key]: v });
        val.textContent = `${Math.round(v * 100)}`;
        persist();
        apply();
      },
    });
    sliders.push({ input, val, key });
    return h(
      'div',
      { class: 'settings-row' },
      h('div', {}, h('div', { class: 'label', text: label }), h('div', { class: 'desc', text: desc })),
      h('div', { class: 'seg-field' }, input, val)
    );
  };

  const master = slider('Master volume', 'Everything.', 'masterVolume');
  const music = slider('Music', 'The soundtrack.', 'musicVolume');
  const sfx = slider('Sound effects', 'Engines, items and UI blips.', 'sfxVolume');

  const muteBtn = h('button', {
    class: 'btn sm',
    type: 'button',
    'data-focusable': '1',
    text: store.state.muted ? 'Unmute' : 'Mute',
    onClick: () => {
      store.set({ muted: !store.state.muted });
      persist();
      apply();
      refresh();
    },
  });
  const muteRow = h(
    'div',
    { class: 'settings-row' },
    h('div', {}, h('div', { class: 'label', text: 'Mute all audio' }), h('div', { class: 'desc', text: 'Silence music and effects without touching the sliders.' })),
    muteBtn
  );

  function refresh() {
    for (const grp of groups) {
      const cur = store.state[grp.key];
      const btns = grp.wrap.querySelectorAll('button');
      for (let i = 0; i < btns.length && i < grp.values.length; i++) {
        btns[i].setAttribute('aria-pressed', String(grp.values[i] === cur));
      }
    }
    for (const sl of sliders) {
      sl.input.value = String(store.state[sl.key]);
      sl.val.textContent = `${Math.round(store.state[sl.key] * 100)}`;
    }
    muteBtn.textContent = store.state.muted ? 'Unmute' : 'Mute';
  }

  const back = h('button', { class: 'btn', type: 'button', 'data-focusable': '1', text: 'Back' });
  const body = h('div', { class: 'panel-body options-body' }, cc, laps, diff, karts, quality, master, music, sfx, muteRow);

  return {
    el: h(
      'div',
      { class: 'screen options-screen', 'data-screen': 'options' },
      h(
        'div',
        { class: 'menu-head' },
        h('div', { class: 'eyebrow', text: 'Setup' }),
        h('h2', { class: 'display screen-title', text: 'Race Options' })
      ),
      h('div', { class: 'panel options-panel' }, h('div', { class: 'panel-head' }, h('span', { text: 'Tuning' }), back), body)
    ),
    back,
    refresh,
  };
}

/* ================================================================ menus ==== */

export function createMenus(ctx, api) {
  const store = ctx.store || GameStore;

  function applySettings() {
    const a = ctx.game && typeof ctx.game.getSystem === 'function' ? ctx.game.getSystem('audio') : null;
    const s = store.state;
    if (a) {
      if (typeof a.setVolumes === 'function') {
        a.setVolumes({ master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume });
      }
      if (typeof a.setMuted === 'function') a.setMuted(s.muted);
    }
    if (ctx.game && typeof ctx.game.applyQuality === 'function') ctx.game.applyQuality(s.quality);
  }

  /* ------------------------------------------------------------- title ---- */

  const flag = h('canvas', { class: 'logo-flag', width: '120', height: '90' });
  (function paintFlag() {
    const g = flag.getContext('2d');
    if (!g) return;
    const w = 120;
    const hgt = 90;
    g.clearRect(0, 0, w, hgt);
    g.fillStyle = '#0a0e1a';
    g.fillRect(10, 4, 6, hgt - 8);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 6; j++) {
        g.fillStyle = (i + j) % 2 === 0 ? '#ffffff' : '#101426';
        g.fillRect(16 + j * (w - 20) / 6, 6 + i * (hgt - 12) / 8, (w - 20) / 6, (hgt - 12) / 8);
      }
    }
    g.strokeStyle = 'rgba(10,14,26,0.8)';
    g.lineWidth = 3;
    g.strokeRect(16, 6, w - 20, hgt - 12);
  })();

  const btnPlay = h('button', { class: 'btn primary', type: 'button', 'data-focusable': '1', text: 'Play' });
  const btnTimeTrial = h('button', { class: 'btn blue', type: 'button', 'data-focusable': '1', text: 'Time Trial' });
  const btnControls = h('button', { class: 'btn', type: 'button', 'data-focusable': '1', text: 'Controls' });
  const btnSettings = h('button', { class: 'btn', type: 'button', 'data-focusable': '1', text: 'Settings' });
  btnPlay.addEventListener('click', () => api.go('charselect'));
  btnTimeTrial.addEventListener('click', () => api.startRace({ timeTrial: true }));
  btnControls.addEventListener('click', () => api.go('controls'));
  btnSettings.addEventListener('click', () => api.go('options'));

  const titleEl = h(
    'div',
    { class: 'screen title-screen', 'data-screen': 'title' },
    h(
      'div',
      { class: 'title-top' },
      h('h1', { class: 'logo' }, h('span', { class: 'word w1', text: 'KART' }), h('span', { class: 'word w2', text: 'RUSH' }), flag),
      h('p', { class: 'tagline', text: 'Eight racers. Three circuits. One turbocharged championship.' })
    ),
    h('div', { class: 'title-menu' }, btnPlay, btnTimeTrial, btnControls, btnSettings),
    h(
      'div',
      { class: 'title-foot' },
      h('span', { text: 'Turbo Championship' }),
      h('span', { class: 'dot', text: '·' }),
      h('span', { text: 'v1.0' })
    )
  );

  /* ----------------------------------------------------- character select --- */

  let charIndex = CHARACTERS.findIndex((c) => c.id === store.state.characterId);
  if (charIndex < 0) charIndex = CHARACTERS.findIndex((c) => c.id === DEFAULT_CHARACTER_ID);
  if (charIndex < 0) charIndex = 0;

  const previewCanvas = h('canvas', { class: 'cs-portrait', width: '320', height: '320' });
  const pvName = h('h3', { class: 'display pv-name' });
  const pvEpi = h('div', { class: 'pv-epithet' });
  const pvBlurb = h('p', { class: 'pv-blurb' });
  const pvStats = h('div', {});
  const pvChips = h('div', { class: 'pv-chips' });

  function paintPreview() {
    const ch = CHARACTERS[charIndex] || CHARACTERS[0];
    if (!ch) {
      pvName.textContent = 'NO RACERS';
      pvEpi.textContent = '';
      pvBlurb.textContent = 'The roster could not be loaded.';
      pvStats.textContent = '';
      pvChips.textContent = '';
      return;
    }
    const g = previewCanvas.getContext('2d');
    if (g) paintCharacter(g, ch, 320);
    pvName.textContent = ch.name;
    pvEpi.textContent = ch.epithet;
    pvBlurb.textContent = ch.blurb;
    pvStats.textContent = '';
    pvStats.append(statBars(ch.stats, true));
    pvChips.textContent = '';
    const t = ch.tuning || {};
    const chips = [
      `TOP ${Math.round(CONFIG.physics.topSpeed * (t.topSpeed || 1) * 3.6)} km/h`,
      `ACC ${(CONFIG.physics.accel * (t.accel || 1)).toFixed(1)} m/s²`,
      `MASS ${(t.mass || 1).toFixed(2)}`,
    ];
    for (const c of chips) pvChips.append(h('span', { class: 'pv-chip', text: c }));
  }

  const cardButtons = [];
  for (let i = 0; i < CHARACTERS.length; i++) {
    const ch = CHARACTERS[i];
    const cv = h('canvas', { class: 'cs-thumb', width: '256', height: '256' });
    const btn = h(
      'button',
      {
        class: 'card cs-card',
        type: 'button',
        'data-focusable': '1',
        'data-char': ch.id,
        'aria-pressed': 'false',
        onClick: () => selectChar(i),
        onPointerenter: () => api.focus(btn),
      },
      h('span', { class: 'thumb' }, cv),
      h('span', { class: 'name', text: ch.name }),
      h('span', { class: 'meta', text: ch.epithet }),
      statBars(ch.stats, false)
    );
    const g = cv.getContext('2d');
    if (g) paintCharacter(g, ch, 192);
    cardButtons.push(btn);
  }

  const csBack = h('button', { class: 'btn ghost sm', type: 'button', 'data-focusable': '1', text: 'Back' });
  const csOptions = h('button', { class: 'btn sm', type: 'button', 'data-focusable': '1', text: 'Options' });
  const csNext = h('button', { class: 'btn primary', type: 'button', 'data-focusable': '1', text: 'Next: Track' });
  csBack.addEventListener('click', () => api.back());
  csOptions.addEventListener('click', () => api.go('options'));
  csNext.addEventListener('click', () => api.go('trackselect'));

  const charEl = h(
    'div',
    { class: 'screen select-screen', 'data-screen': 'charselect' },
    h(
      'div',
      { class: 'menu-head' },
      h('div', { class: 'eyebrow', text: 'Step 1 of 2' }),
      h('h2', { class: 'display screen-title', text: 'Choose Your Racer' })
    ),
    h(
      'div',
      { class: 'cs-layout' },
      h('div', { class: 'grid-cards cs-grid' }, cardButtons),
      h('aside', { class: 'panel cs-preview' }, previewCanvas, pvName, pvEpi, pvStats, pvChips)
    ),
    h('div', { class: 'menu-actions' }, csBack, csOptions, csNext)
  );

  function selectChar(i) {
    charIndex = ((i % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length;
    const ch = CHARACTERS[charIndex];
    store.set({ characterId: ch.id });
    persist();
    for (let j = 0; j < cardButtons.length; j++) {
      cardButtons[j].setAttribute('aria-pressed', String(j === charIndex));
    }
    if (cardButtons[charIndex] && api.focus) api.focus(cardButtons[charIndex]);
    paintPreview();
    if (api.toast) api.toast(ch.name.toUpperCase(), 'good', 900);
  }

  function onEnterChar() {
    const idx = CHARACTERS.findIndex((c) => c.id === store.state.characterId);
    selectChar(idx >= 0 ? idx : 0);
  }

  /* -------------------------------------------------------- track select --- */

  let trackIndex = TRACKS.findIndex((t) => t.id === store.state.trackId);
  if (trackIndex < 0) trackIndex = TRACKS.findIndex((t) => t.id === DEFAULT_TRACK_ID);
  if (trackIndex < 0) trackIndex = 0;

  const tsCanvas = h('canvas', { class: 'ts-outline', width: '360', height: '360' });
  const tsName = h('h3', { class: 'display ts-name' });
  const tsCup = h('div', { class: 'ts-cup' });
  const tsBlurb = h('p', { class: 'ts-blurb' });
  const tsFacts = h('div', { class: 'ts-facts' });
  const tsSwatches = h('div', { class: 'ts-swatches' });
  const tsRecord = h('div', { class: 'ts-record' });

  /** Cached smooth centreline per track id, built lazily from TrackPath. */
  const smooth = new Map();
  let pathPromise = null;
  function loadPaths() {
    if (pathPromise) return pathPromise;
    pathPromise = import('../world/TrackPath.js')
      .then((m) => {
        const Ctor = m && (m.TrackPath || (typeof m.default === 'function' ? m.default : null));
        if (typeof Ctor !== 'function') return null;
        return Ctor;
      })
      .catch(() => null);
    return pathPromise;
  }

  function outlineFor(def) {
    if (smooth.has(def.id)) return smooth.get(def.id);
    let pts = flattenPath(def);
    loadPaths().then((Ctor) => {
      if (!Ctor) return;
      try {
        const p = new Ctor(def);
        const c = p.centerline2D();
        if (c && c.length >= 4) {
          smooth.set(def.id, c);
          paintTrackArt();
        }
      } catch {
        /* keep the control-point fallback */
      }
    });
    smooth.set(def.id, pts);
    return pts;
  }

  const trackButtons = [];
  const trackCanvases = [];
  for (let i = 0; i < TRACKS.length; i++) {
    const def = TRACKS[i];
    const cv = h('canvas', { class: 'ts-thumb', width: '300', height: '210' });
    const btn = h(
      'button',
      {
        class: 'card ts-card',
        type: 'button',
        'data-focusable': '1',
        'data-track': def.id,
        'aria-pressed': 'false',
        onClick: () => selectTrack(i),
        onPointerenter: () => api.focus(btn),
      },
      h('span', { class: 'thumb ts-thumbwrap' }, cv),
      h('span', { class: 'name', text: def.name }),
      h('span', { class: 'meta', text: `${def.cup} · ${(def.timeOfDay || 'day').toUpperCase()}` }),
      h('span', { class: 'ts-chiprow' }, trackChips(def))
    );
    trackButtons.push(btn);
    trackCanvases.push({ cv, def, size: 210 });
    const g = cv.getContext('2d');
    if (g) paintTrack(g, 230, outlineFor(def), def, { selected: false });
  }

  function trackChips(def) {
    const out = [];
    const q = def.boostPads ? def.boostPads.length : 0;
    const j = def.jumps ? def.jumps.length : 0;
    const hz = def.hazards ? def.hazards.length : 0;
    if (j) out.push(h('span', { class: 'mini-chip', text: `${j} JUMP${j > 1 ? 'S' : ''}` }));
    if (q) out.push(h('span', { class: 'mini-chip', text: `${q} PAD${q > 1 ? 'S' : ''}` }));
    if (hz) out.push(h('span', { class: 'mini-chip', text: `${hz} HAZARD${hz > 1 ? 'S' : ''}` }));
    return out;
  }

  function paintTrackArt() {
    for (let i = 0; i < trackCanvases.length; i++) {
      const t = trackCanvases[i];
      if (!t.def) continue;
      const g = t.cv.getContext('2d');
      if (!g) continue;
      paintTrack(g, t.size, smooth.get(t.def.id) || flattenPath(t.def), t.def, { selected: i === trackIndex });
    }
    const def = TRACKS[trackIndex];
    if (!def) return;
    const g = tsCanvas.getContext('2d');
    if (g) paintTrack(g, 360, smooth.get(def.id) || flattenPath(def), def, { selected: true });
  }

  function selectTrack(i) {
    trackIndex = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
    const def = TRACKS[trackIndex];
    store.set({ trackId: def.id });
    persist();
    for (let j = 0; j < trackButtons.length; j++) {
      trackButtons[j].setAttribute('aria-pressed', String(j === trackIndex));
    }
    if (trackButtons[trackIndex] && api.focus) api.focus(trackButtons[trackIndex]);
    paintTrackArt();
    updateTrackPreview();
    if (api.toast) api.toast(def.name.toUpperCase(), 'good', 900);
  }

  function updateTrackPreview() {
    const def = TRACKS[trackIndex];
    if (!def) {
      tsName.textContent = 'NO CIRCUITS';
      tsCup.textContent = '';
      tsBlurb.textContent = 'The track list could not be loaded.';
      tsFacts.textContent = '';
      tsSwatches.textContent = '';
      tsRecord.textContent = '';
      return;
    }
    tsName.textContent = def.name;
    tsCup.textContent = `${def.cup} · ${(def.timeOfDay || 'day').toUpperCase()}`;
    tsBlurb.textContent = def.blurb;
    const pts = def.path ? def.path.length : 0;
    const th = def.theme || {};
    tsFacts.textContent = '';
    tsFacts.append(
      h('span', { class: 'ts-fact', text: `${pts} control points` }),
      h('span', { class: 'ts-fact', text: `${(def.width * 2) | 0} m wide` }),
      h('span', { class: 'ts-fact', text: `${(def.jumps || []).length} jumps` }),
      h('span', { class: 'ts-fact', text: `${(def.decor ? def.decor.banners : 0) || 0} banners` })
    );
    tsSwatches.textContent = '';
    const sw = [
      ['Sky', th.sky ? th.sky.top : 0x1e3a7a],
      ['Horizon', th.sky ? th.sky.horizon : 0xff9d4d],
      ['Road', th.road != null ? th.road : 0x3b3b42],
      ['Terrain', th.terrain != null ? th.terrain : 0x748a3c],
      ['Kerb', th.curbA != null ? th.curbA : 0xe0322a],
    ];
    if (th.water) sw.push(['Water', th.water]);
    for (const [label, hex] of sw) {
      tsSwatches.append(
        h('span', { class: 'swatch' }, h('i', { style: { background: `#${hex.toString(16).padStart(6, '0')}` } }), h('span', { text: label }))
      );
    }
    const rec = store.state.records && store.state.records[def.id];
    tsRecord.textContent = '';
    if (rec) {
      tsRecord.append(
        h('span', { class: 'rec-line', text: `BEST LAP ${formatTime(rec.bestLapMs)}` }),
        h('span', { class: 'rec-line', text: `BEST RACE ${formatTime(rec.totalMs)}` })
      );
    } else {
      tsRecord.append(h('span', { class: 'rec-line none', text: 'NO RECORD YET' }));
    }
  }

  const tsBack = h('button', { class: 'btn ghost sm', type: 'button', 'data-focusable': '1', text: 'Back' });
  const tsOptions = h('button', { class: 'btn sm', type: 'button', 'data-focusable': '1', text: 'Options' });
  const tsStart = h('button', { class: 'btn primary', type: 'button', 'data-focusable': '1', text: 'Start Race' });
  const tsTrial = h('button', { class: 'btn blue', type: 'button', 'data-focusable': '1', text: 'Time Trial' });
  tsBack.addEventListener('click', () => api.back());
  tsOptions.addEventListener('click', () => api.go('options'));
  tsStart.addEventListener('click', () => api.startRace());
  tsTrial.addEventListener('click', () => api.startRace({ timeTrial: true }));

  const trackEl = h(
    'div',
    { class: 'screen select-screen', 'data-screen': 'trackselect' },
    h(
      'div',
      { class: 'menu-head' },
      h('div', { class: 'eyebrow', text: 'Step 2 of 2' }),
      h('h2', { class: 'display screen-title', text: 'Pick a Circuit' })
    ),
    h(
      'div',
      { class: 'ts-layout' },
      h('div', { class: 'ts-cards' }, trackButtons),
      h('aside', { class: 'panel ts-preview' }, tsCanvas, tsName, tsCup, tsBlurb, tsFacts, tsSwatches, tsRecord)
    ),
    h('div', { class: 'menu-actions' }, tsBack, tsOptions, tsStart, tsTrial)
  );

  /* -------------------------------------------------------------- options -- */

  const options = optionsScreen(store, applySettings);
  options.back.addEventListener('click', () => api.back());

  /* ------------------------------------------------------------ controls -- */

  const ctlBack = h('button', { class: 'btn', type: 'button', 'data-focusable': '1', text: 'Back' });
  ctlBack.addEventListener('click', () => api.back());
  const controlsEl = h(
    'div',
    { class: 'screen controls-screen', 'data-screen': 'controls' },
    h(
      'div',
      { class: 'menu-head' },
      h('div', { class: 'eyebrow', text: 'Reference' }),
      h('h2', { class: 'display screen-title', text: 'Controls' })
    ),
    h('div', { class: 'panel controls-panel' }, h('div', { class: 'panel-head' }, h('span', { text: 'Input map' }), ctlBack), h('div', { class: 'panel-body' }, controlsScreen()))
  );

  /* ---------------------------------------------------------------- pause -- */

  const pResume = h('button', { class: 'btn primary', type: 'button', 'data-focusable': '1', text: 'Resume' });
  const pRestart = h('button', { class: 'btn blue', type: 'button', 'data-focusable': '1', text: 'Restart' });
  const pOptions = h('button', { class: 'btn', type: 'button', 'data-focusable': '1', text: 'Options' });
  const pControls = h('button', { class: 'btn', type: 'button', 'data-focusable': '1', text: 'Controls' });
  const pQuit = h('button', { class: 'btn ghost', type: 'button', 'data-focusable': '1', text: 'Quit to Title' });
  pResume.addEventListener('click', () => api.resume());
  pRestart.addEventListener('click', () => api.restart());
  pOptions.addEventListener('click', () => api.go('options'));
  pControls.addEventListener('click', () => api.go('controls'));
  pQuit.addEventListener('click', () => api.quit());

  const pauseEl = h(
    'div',
    { class: 'screen pause-screen', 'data-screen': 'pause' },
    h('div', { class: 'eyebrow', text: 'Paused' }),
    h('h2', { class: 'display screen-title', text: 'Take a Breath' }),
    h('div', { class: 'pause-menu' }, pResume, pRestart, pOptions, pControls, pQuit)
  );

  /* -------------------------------------------------------------- screens -- */

  const screens = {
    title: { key: 'title', el: titleEl, onEnter: null },
    charselect: { key: 'charselect', el: charEl, onEnter: onEnterChar },
    trackselect: { key: 'trackselect', el: trackEl, onEnter: () => { paintTrackArt(); updateTrackPreview(); } },
    options: { key: 'options', el: options.el, onEnter: () => options.refresh() },
    controls: { key: 'controls', el: controlsEl, onEnter: null },
    pause: { key: 'pause', el: pauseEl, onEnter: null },
  };

  function dispose() {
    for (const k in screens) screens[k].el.remove();
  }

  function moveChar(delta) {
    selectChar(charIndex + delta);
  }

  function moveTrack(delta) {
    selectTrack(trackIndex + delta);
  }

  function currentChar() {
    return CHARACTERS[charIndex] || CHARACTERS[0] || null;
  }

  function currentTrack() {
    return TRACKS[trackIndex] || TRACKS[0] || null;
  }

  return {
    screens,
    dispose,
    moveChar,
    moveTrack,
    currentChar,
    currentTrack,
    /** Elements that should take focus when a screen opens. */
    focusTarget(name) {
      if (name === 'title') return btnPlay;
      if (name === 'charselect') return cardButtons[charIndex] || csNext;
      if (name === 'trackselect') return trackButtons[trackIndex] || tsStart;
      if (name === 'options') return options.el.querySelector('[data-focusable]');
      if (name === 'controls') return ctlBack;
      if (name === 'pause') return pResume;
      return null;
    },
  };
}

export default createMenus;
