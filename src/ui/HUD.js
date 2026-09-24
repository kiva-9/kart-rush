/**
 * In-race HUD for Kart Rush.
 *
 * Lap counter, position ordinal, speed readout, item slot (large icon + count
 * badge + roulette shake), drift charge meter coloured per mini-turbo tier, and
 * a timer panel with current / last / best lap. The minimap lives in its own
 * module and is mounted here.
 *
 * All values arrive through the `RaceView` object the race director publishes
 * (`race:update`, ~10 Hz) — the HUD never assumes the shape of another module
 * and degrades to "no data" quietly if it is missing.
 */

import { clamp, formatTime, ordinal } from '../core/MathUtils.js';
import { CONFIG } from '../data/config.js';
import { createMinimap } from './Minimap.js';

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
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

function setTxt(node, s) {
  if (node.__v !== s) {
    node.__v = s;
    node.textContent = s;
  }
}

const ART_COLORS = {
  banana: '#ffd60a',
  shell: '#3ecf5a',
  mushroom: '#ff4d4d',
  star: '#ffe27a',
  bolt: '#7fd8ff',
  ink: '#8f7bff',
  bullet: '#c9d4e6',
  horn: '#ffb45c',
};

/** Fallback icon painter, used if the items module cannot be imported. */
function paintFallbackIcon(c, artKind, size) {
  const g = c.getContext('2d');
  const s = size;
  g.clearRect(0, 0, s, s);
  g.save();
  g.translate(s / 2, s / 2);
  const u = s / 100;
  const col = ART_COLORS[artKind] || '#ffffff';
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(10,14,26,0.9)';
  g.lineWidth = 5 * u;
  switch (artKind) {
    case 'banana': {
      g.fillStyle = col;
      g.beginPath();
      g.arc(0, 0, 34 * u, 0.35 * Math.PI, 1.75 * Math.PI);
      g.arc(0, 10 * u, 26 * u, 1.75 * Math.PI, 0.35 * Math.PI, true);
      g.closePath();
      g.fill();
      g.stroke();
      break;
    }
    case 'shell': {
      g.fillStyle = col;
      g.beginPath();
      g.arc(0, 0, 36 * u, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath();
      g.arc(0, 0, 22 * u, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(10,14,26,0.75)';
      g.lineWidth = 3 * u;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        g.beginPath();
        g.moveTo(Math.cos(a) * 8 * u, Math.sin(a) * 8 * u);
        g.lineTo(Math.cos(a) * 20 * u, Math.sin(a) * 20 * u);
        g.stroke();
      }
      break;
    }
    case 'mushroom': {
      g.fillStyle = col;
      g.beginPath();
      g.arc(0, -4 * u, 36 * u, Math.PI, 0);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = '#fff6e8';
      g.beginPath();
      if (typeof g.roundRect === 'function') g.roundRect(-13 * u, -4 * u, 26 * u, 40 * u, 10 * u);
      else g.rect(-13 * u, -4 * u, 26 * u, 40 * u);
      g.fill();
      g.stroke();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(-14 * u, -14 * u, 6 * u, 0, Math.PI * 2);
      g.arc(12 * u, -20 * u, 8 * u, 0, Math.PI * 2);
      g.arc(2 * u, -32 * u, 5 * u, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'star': {
      g.fillStyle = col;
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const r = (i % 2 === 0 ? 38 : 16) * u;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = '#0a0e1a';
      g.beginPath();
      g.arc(-6 * u, -4 * u, 3 * u, 0, Math.PI * 2);
      g.arc(7 * u, -4 * u, 3 * u, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'bolt': {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(6 * u, -38 * u);
      g.lineTo(-22 * u, 6 * u);
      g.lineTo(-2 * u, 6 * u);
      g.lineTo(-10 * u, 38 * u);
      g.lineTo(22 * u, -8 * u);
      g.lineTo(2 * u, -8 * u);
      g.closePath();
      g.fill();
      g.stroke();
      break;
    }
    case 'ink': {
      g.fillStyle = col;
      g.beginPath();
      g.arc(0, 0, 34 * u, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = 'rgba(10,14,26,0.85)';
      g.beginPath();
      g.arc(-8 * u, -6 * u, 4 * u, 0, Math.PI * 2);
      g.arc(9 * u, -6 * u, 4 * u, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'bullet': {
      g.fillStyle = col;
      g.beginPath();
      if (typeof g.roundRect === 'function') g.roundRect(-20 * u, -32 * u, 40 * u, 64 * u, 18 * u);
      else g.rect(-20 * u, -32 * u, 40 * u, 64 * u);
      g.fill();
      g.stroke();
      g.fillStyle = '#0a0e1a';
      g.beginPath();
      g.arc(-7 * u, -8 * u, 3.4 * u, 0, Math.PI * 2);
      g.arc(7 * u, -8 * u, 3.4 * u, 0, Math.PI * 2);
      g.fill();
      break;
    }
    default: {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(-30 * u, 10 * u);
      g.quadraticCurveTo(-10 * u, -34 * u, 16 * u, -30 * u);
      g.quadraticCurveTo(34 * u, -28 * u, 30 * u, -6 * u);
      g.quadraticCurveTo(26 * u, 30 * u, 4 * u, 34 * u);
      g.quadraticCurveTo(-16 * u, 36 * u, -28 * u, 22 * u);
      g.closePath();
      g.fill();
      g.stroke();
      break;
    }
  }
  g.restore();
}

export function createHUD(ctx) {
  const lapNum = h('span', { class: 'num', text: '1' });
  const lapTot = h('span', { class: 'tot', text: '3' });
  const ordEl = h('span', { class: 'ord', text: '1st' });
  const ofEl = h('span', { class: 'of', text: 'OF 8' });
  const speedVal = h('span', { class: 'val', text: '0' });
  const driftFill = h('div', { class: 'fill' });
  const driftEl = h('div', { class: 'hud-drift', 'data-tier': '0' }, driftFill);
  const itemSlot = h('div', { class: 'hud-item empty' });
  const itemCount = h('span', { class: 'count', text: 'x1' });
  itemSlot.append(itemCount);

  const curLap = h('span', { class: 'v', text: "--'--\"---" });
  const lastLap = h('span', { class: 'v', text: "--'--\"---" });
  const bestLap = h('span', { class: 'v best', text: "--'--\"---" });
  const gapEl = h('span', { class: 'v', text: '' });
  const gapRow = h('div', { class: 'row' }, h('span', { class: 'k', text: 'Gap' }), gapEl);

  const flagsEl = h('div', { class: 'hud-flags' });
  const boostChip = h('span', { class: 'flag-chip boost', text: 'BOOST' });
  const starChip = h('span', { class: 'flag-chip star', text: 'STAR' });
  const offChip = h('span', { class: 'flag-chip off', text: 'OFF TRACK' });
  const slipChip = h('span', { class: 'flag-chip slip', text: 'SLIPSTREAM' });
  flagsEl.append(boostChip, starChip, offChip, slipChip);

  const banner = h('div', { class: 'hud-banner', text: 'FINAL LAP' });
  const place = h('div', { class: 'hud-place' });

  const minimap = createMinimap(ctx);

  // Held by name so the boost glow can be toggled on the element it belongs to.
  // It used to be applied to `el` (the .hud root) while the only CSS rule for
  // `boosting` is `.hud-speed.boosting .val`, so the speed readout never lit up
  // during a mini-turbo, mushroom, boost pad or star.
  const speedBlock = h('div', { class: 'hud-speed' }, speedVal, h('span', { class: 'unit', text: 'km/h' }));

  const el = h(
    'div',
    { class: 'hud', 'data-screen': 'hud' },
    h('div', { class: 'hud-lap' }, lapNum, h('span', { class: 'sl', text: '/' }), lapTot),
    h('div', { class: 'hud-pos' }, ordEl, ofEl, place),
    h(
      'div',
      { class: 'hud-times' },
      h('div', { class: 'row' }, h('span', { class: 'k', text: 'Lap' }), curLap),
      h('div', { class: 'row' }, h('span', { class: 'k', text: 'Last' }), lastLap),
      h('div', { class: 'row' }, h('span', { class: 'k', text: 'Best' }), bestLap),
      gapRow
    ),
    speedBlock,
    itemSlot,
    driftEl,
    flagsEl,
    banner,
    minimap.el
  );

  /* --------------------------------------------------------------- state */

  let view = null;
  let raceRef = null;
  let lapStartMs = 0;
  let lastPlace = 0;
  let placeTimer = 0;
  let bannerTimer = 0;
  let iconCache = new Map(); // itemId -> html string
  let iconsReady = false;
  let artMod = null;
  let rouletteIds = [];
  /** itemId -> `art` kind, used only by the fallback icon painter. */
  let artById = new Map();
  let rouletteTimer = 0;
  let lastItemKey = '';
  let lastIcon = '';
  let boostLevel = 0;
  let minimapTimer = 0;

  /* -------------------------------------------------------- item icons */

  function ensureIconModule() {
    if (iconsReady) return;
    iconsReady = true;
    import('../data/items.js')
      .then((m) => {
        const list = Array.isArray(m.ITEMS) ? m.ITEMS : [];
        rouletteIds = [];
        artById = new Map();
        for (const d of list) {
          if (d && d.id) {
            rouletteIds.push(d.id);
            artById.set(d.id, d.art || 'shell');
          }
        }
        iconCache.clear();
      })
      .catch(() => {
        rouletteIds = [];
      });
    import('../items/ItemArt.js')
      .then((m) => {
        artMod = m;
        // A cached icon may have been painted by the fallback path before the
        // module resolved — drop the caches so the real art wins.
        iconCache.clear();
        lastIcon = '';
        lastItemKey = '';
      })
      .catch(() => {
        artMod = null;
      });
  }

  function iconFor(itemId, artKind) {
    const key = itemId || artKind || 'none';
    const kind = artById.get(key) || artKind || 'shell';
    const hit = iconCache.get(key);
    if (hit !== undefined) return hit;
    let out = '';
    if (artMod && typeof artMod.itemIconSVG === 'function') {
      try {
        out = artMod.itemIconSVG(itemId, { size: 128, title: false });
      } catch {
        out = '';
      }
    }
    if (!out) {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 128;
      paintFallbackIcon(c, kind, 128);
      out = `<img src="${c.toDataURL('image/png')}" alt="" />`;
    }
    iconCache.set(key, out);
    return out;
  }

  /* ------------------------------------------------------------- events */

  function onLap(p) {
    if (!p || p.isPlayer === false) return;
    if (Number.isFinite(p.lapTimeMs)) lapStartMs += p.lapTimeMs;
  }

  /* -------------------------------------------------------------- update */

  function update(dt, nextView) {
    const step = Math.min(0.1, dt || 0.016);
    if (nextView) view = nextView;
    if (!view) return;
    ensureIconModule();

    const p = view.player || {};
    const total = view.totalLaps || view.laps || +lapTot.textContent || 3;
    if (lapTot.textContent !== String(total)) lapTot.textContent = String(total);

    const lap = clamp(Math.round(p.lap || 1), 1, Math.max(1, total));
    setTxt(lapNum, String(lap));

    const pos = clamp(Math.round(p.position || 1), 1, 99);
    const ordStr = ordinal(pos);
    if (ordEl.__v !== ordStr) {
      ordEl.__v = ordStr;
      ordEl.textContent = ordStr;
      ordEl.classList.remove('pop');
      void ordEl.offsetWidth;
      ordEl.classList.add('pop');
    }
    const field = (view.standings && view.standings.length) || 8;
    setTxt(ofEl, `OF ${field}`);

    // place change delta
    if (lastPlace && pos !== lastPlace) {
      place.textContent = pos < lastPlace ? `▲ ${lastPlace - pos}` : `▼ ${pos - lastPlace}`;
      place.className = `hud-place ${pos < lastPlace ? 'up' : 'down'}`;
      placeTimer = 1.5;
    }
    if (pos !== lastPlace) lastPlace = pos;
    if (placeTimer > 0) {
      placeTimer -= step;
      if (placeTimer <= 0) place.className = 'hud-place';
    }

    // speed — the director hands us km/h directly (m/s * 3.6)
    const kmh = Math.max(0, Math.round(p.speedKmh != null && Number.isFinite(p.speedKmh) ? p.speedKmh : 0));
    setTxt(speedVal, String(kmh));

    // timers
    if (view.phase === 'racing') {
      const now = Number.isFinite(view.timeMs) ? view.timeMs : 0;
      setTxt(curLap, formatTime(Math.max(0, now - lapStartMs)));
    } else {
      setTxt(curLap, formatTime(view.timeMs || 0));
    }
    const lastMs = p.lastLapMs != null ? p.lastLapMs : null;
    setTxt(lastLap, lastMs != null ? formatTime(lastMs) : "--'--\"---");
    const bestMs = p.bestLapMs != null ? p.bestLapMs : null;
    setTxt(bestLap, bestMs != null ? formatTime(bestMs) : "--'--\"---");
    if (p.gapMs != null && Number.isFinite(p.gapMs) && !(pos === 1 && Math.abs(p.gapMs) < 1)) {
      const gap = p.gapMs >= 0 ? `+${(p.gapMs / 1000).toFixed(2)}s` : `-${(-p.gapMs / 1000).toFixed(2)}s`;
      setTxt(gapEl, gap);
      gapRow.classList.toggle('has-gap', true);
    } else if (view.standings && view.standings.length) {
      const lead = view.standings[0];
      const me = view.standings.find((s) => s.isPlayer);
      if (lead && me && lead !== me && Number.isFinite(lead.gapMs) && Number.isFinite(me.gapMs)) {
        const d = me.gapMs - lead.gapMs;
        setTxt(gapEl, `${d >= 0 ? '+' : '-'}${(Math.abs(d) / 1000).toFixed(2)}s`);
      } else {
        setTxt(gapEl, 'LEADER');
      }
      gapRow.classList.toggle('has-gap', true);
    } else {
      setTxt(gapEl, '');
      gapRow.classList.remove('has-gap');
    }

    // --- drift charge meter ------------------------------------------------
    const tier = clamp(Math.round(p.driftTier || 0), 0, 3);
    let charge = Number.isFinite(p.driftCharge) ? p.driftCharge : 0;
    // The director reports either a 0..1 fraction or seconds of charge.
    if (charge > 1.25) {
      const ref = CONFIG.physics.driftTiers[tier] || CONFIG.physics.driftTiers[CONFIG.physics.driftTiers.length - 1];
      charge = ref > 0 ? charge / ref : 0;
    }
    charge = clamp(charge, 0, 1);
    if (driftEl.dataset.tier !== String(tier)) driftEl.dataset.tier = String(tier);
    const w = `${(charge * 100).toFixed(1)}%`;
    if (driftFill.style.width !== w) driftFill.style.width = w;
    const drifting = charge > 0.001 || tier > 0;
    driftEl.classList.toggle('on', drifting);

    // --- item slot ---------------------------------------------------------
    const rolling = p.itemRolling === true;
    const itemId = p.itemId;
    const count = Math.max(1, Math.round(p.itemCount || 1));
    if (rolling) {
      itemSlot.classList.add('rolling');
      itemSlot.classList.remove('empty');
      rouletteTimer -= step;
      if (rouletteTimer <= 0) {
        rouletteTimer = 0.07;
        const ids = rouletteIds.length ? rouletteIds : [itemId || 'banana'];
        const pick = ids[(Math.random() * ids.length) | 0];
        const html = iconFor(pick, pick);
        if (html !== lastIcon) {
          lastIcon = html;
          itemSlot.innerHTML = html;
          itemSlot.append(itemCount);
        }
      }
    } else {
      itemSlot.classList.remove('rolling');
      if (itemId && itemId !== 'none' && itemId !== 'nothing') {
        itemSlot.classList.remove('empty');
        const key = `${itemId}|${count}`;
        if (key !== lastItemKey) {
          lastItemKey = key;
          const html = iconFor(itemId, itemId);
          if (html !== lastIcon) {
            lastIcon = html;
            itemSlot.innerHTML = html;
            itemSlot.append(itemCount);
          }
        }
        const c = count > 1 ? `x${count}` : '';
        if (itemCount.textContent !== c) itemCount.textContent = c;
        itemCount.style.display = c ? '' : 'none';
      } else {
        itemSlot.classList.add('empty');
        lastItemKey = '';
      }
    }

    // --- status flags ------------------------------------------------------
    const pk = raceRef && raceRef.player ? raceRef.player : null;
    const phys = pk ? pk.physics : null;
    let boosting = false;
    let starred = false;
    let off = false;
    let slip = 0;
    if (phys) {
      boosting = (phys.boost && phys.boost.timer > 0) === true;
      starred = (phys.star || 0) > 0;
      off = phys.surface === 'off';
      slip = phys.slipstream || 0;
    } else if (pk) {
      boosting = pk.boostActive === true;
      starred = (pk.starTimer || 0) > 0;
    }
    boostChip.classList.toggle('on', boosting);
    starChip.classList.toggle('on', starred);
    offChip.classList.toggle('on', off);
    slipChip.classList.toggle('on', slip > 0.35);
    const bl = boosting ? 1 : 0;
    if (bl !== boostLevel) {
      boostLevel = bl;
      speedBlock.classList.toggle('boosting', boosting);
    }

    // --- final lap banner ---------------------------------------------------
    const finalLap = total > 0 && lap >= total && p.finishing !== true && view.phase === 'racing';
    if (finalLap && bannerTimer <= 0) bannerTimer = 2.4;
    if (bannerTimer > 0) {
      bannerTimer -= step;
      banner.classList.add('on');
      if (bannerTimer <= 0) banner.classList.remove('on');
    }

    // --- minimap (throttled: the bitmap blit is cheap but needless at 120 Hz)
    minimapTimer -= step;
    if (minimapTimer <= 0) {
      minimapTimer = 1 / 60;
      minimap.update(step, view);
    }
  }

  function showFinalLap() {
    bannerTimer = 2.4;
    banner.classList.add('on');
  }

  function attachRace(race) {
    raceRef = race || null;
    minimap.setSource(raceRef);
    lapStartMs = 0;
    lastPlace = 0;
    placeTimer = 0;
  }

  function dispose() {
    minimap.dispose();
    el.remove();
  }

  return {
    el,
    update,
    attachRace,
    onLap,
    showFinalLap,
    dispose,
    setLapStart(ms) {
      lapStartMs = ms || 0;
    },
  };
}

export default createHUD;
