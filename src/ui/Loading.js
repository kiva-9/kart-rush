/**
 * Boot / loading screen for Kart Rush.
 *
 * Wordmark, a chunky progress bar, a rotating tip ticker and a small procedural
 * kart animation on a canvas. Fades out when signalled via `hide()`.
 * Everything is generated at runtime — no external assets.
 */

/** Small DOM builder shared by the loading screen. */
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

const TIPS = [
  'Hold the drift button through a corner to charge a mini-turbo — three tiers, three boosts.',
  'Tuck in behind a rival to build a slipstream, then slingshot past on the straight.',
  'The further back you are, the stronger the item you draw. Fight to the front.',
  'Hop before you drift: a bunny hop tightens your line and charges faster.',
  'Bananas are not just weapons — drag one behind you as a spinning shield.',
  'Steer into the slide. Counter-steering wastes the whole drift charge.',
  'Boost pads are free speed. Line them up before the corner, not after it.',
  'Hit the wall and you lose your momentum — the kerbs are faster than the grass.',
  'A start-boost is worth half a second. Watch the lights and hold accelerate.',
  'Heavy racers bump harder but slide wide. Light racers dart but get shoved.',
  'Red shells home in on the kart ahead. Green shells bounce off everything.',
  'The final lap is where races are won. Save your mushrooms for the last corner.',
];

const KART_W = 260;
const KART_H = 132;

/** Procedural kart side-profile + spinning wheels, drawn every loading frame. */
function paintKart(g, t) {
  const w = KART_W;
  const hgt = KART_H;
  g.clearRect(0, 0, w, hgt);

  // --- motion blur streaks -------------------------------------------------
  g.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const p = ((t * (1.4 + i * 0.22) + i * 0.17) % 1);
    const x = w * (1.15 - p * 1.35);
    const y = 34 + i * 9.5;
    const len = 26 + 46 * ((i * 37) % 10) / 10;
    g.strokeStyle = `rgba(255,255,255,${0.05 + 0.05 * ((i % 3) / 2)})`;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - len, y);
    g.stroke();
  }

  // --- ground shadow -------------------------------------------------------
  g.save();
  g.translate(w / 2, hgt - 20);
  g.scale(1, 0.22);
  const sh = g.createRadialGradient(0, 0, 4, 0, 0, 96);
  sh.addColorStop(0, 'rgba(0,0,0,0.55)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = sh;
  g.beginPath();
  g.arc(0, 0, 96, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // --- exhaust puffs -------------------------------------------------------
  for (let i = 0; i < 4; i++) {
    const life = (t * 1.6 + i * 0.25) % 1;
    const r = 3 + life * 13;
    g.fillStyle = `rgba(190,205,235,${0.3 * (1 - life)})`;
    g.beginPath();
    g.arc(w * 0.2 - life * 70, hgt - 40 - life * 16, r, 0, Math.PI * 2);
    g.fill();
  }

  // --- chassis -------------------------------------------------------------
  const body = g.createLinearGradient(0, 24, 0, 96);
  body.addColorStop(0, '#ff6a58');
  body.addColorStop(0.55, '#e8352f');
  body.addColorStop(1, '#9c1015');
  g.fillStyle = body;
  g.beginPath();
  g.moveTo(28, 76);
  g.quadraticCurveTo(20, 56, 44, 50);
  g.lineTo(74, 46);
  g.quadraticCurveTo(104, 30, 140, 32);
  g.lineTo(186, 38);
  g.quadraticCurveTo(216, 44, 220, 62);
  g.quadraticCurveTo(224, 78, 206, 82);
  g.lineTo(44, 84);
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(10,14,26,0.9)';
  g.lineWidth = 4;
  g.stroke();

  // nose cone
  g.fillStyle = '#ffd60a';
  g.beginPath();
  g.moveTo(206, 58);
  g.lineTo(238, 62);
  g.lineTo(204, 80);
  g.closePath();
  g.fill();
  g.stroke();

  // side pod
  g.fillStyle = 'rgba(255,255,255,0.82)';
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(70, 60, 62, 22, 10);
  else g.rect(70, 60, 62, 22);
  g.fill();
  g.stroke();

  // seat + driver
  g.fillStyle = '#20264a';
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(96, 22, 42, 30, 8);
  else g.rect(96, 22, 42, 30);
  g.fill();
  g.stroke();
  g.fillStyle = '#f2b98d';
  g.beginPath();
  g.arc(122, 22, 13, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#e8352f';
  g.beginPath();
  g.arc(122, 20, 13.5, Math.PI, 0);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#0a0e1a';
  g.beginPath();
  g.arc(128, 24, 2.1, 0, Math.PI * 2);
  g.fill();

  // steering wheel
  g.strokeStyle = '#0a0e1a';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(108, 40, 11, 0, Math.PI * 2);
  g.stroke();

  // rear wing
  g.fillStyle = '#ffd60a';
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(24, 34, 30, 9, 4);
  else g.rect(24, 34, 30, 9);
  g.fill();
  g.stroke();
  g.fillStyle = '#0a0e1a';
  g.fillRect(36, 42, 6, 16);

  // --- wheels --------------------------------------------------------------
  const wheel = (cx, cy, r) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(t * 14);
    g.fillStyle = '#191b21';
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#0a0e1a';
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = '#dfe7f5';
    g.beginPath();
    g.arc(0, 0, r * 0.44, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#8f9bb3';
    g.lineWidth = 2;
    g.stroke();
    g.strokeStyle = '#b9c4d8';
    g.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.beginPath();
      g.moveTo(Math.cos(a) * r * 0.14, Math.sin(a) * r * 0.14);
      g.lineTo(Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4);
      g.stroke();
    }
    g.restore();
  };
  wheel(66, 82, 19);
  wheel(186, 80, 16);
}

export function createLoading(ctx) {
  const bar = h('i');
  const pct = h('span', { class: 'ldr-pct', text: '0%' });
  const tipEl = h('div', { class: 'loader-tip' });
  const kCanvas = h('canvas', { class: 'ldr-kart', width: String(KART_W), height: String(KART_H) });
  const kCtx = kCanvas.getContext('2d');

  const stageEl = h('div', { class: 'loader-stage', text: 'Warming up the engines' });

  // Starts hidden, and `visible` agrees with the DOM, so the first `hide()` is
  // not swallowed by the "nothing to hide" guard below.
  const el = h(
    'div',
    { class: 'loader kart-loader hidden', 'data-screen': 'loading' },
    h(
      'div',
      { class: 'loader-inner' },
      h(
        'h1',
        { class: 'logo loader-logo' },
        h('span', { class: 'word w1', text: 'KART' }),
        h('span', { class: 'word w2', text: 'RUSH' })
      ),
      h('div', { class: 'loader-tag', text: 'Turbo Championship' }),
      kCanvas,
      h(
        'div',
        { class: 'bar' },
        bar,
        h('span', { class: 'bar-sheen' })
      ),
      h('div', { class: 'loader-meta' }, pct, stageEl),
      tipEl
    )
  );

  let visible = false;
  let progress = 0;
  let target = 0;
  let time = 0;
  let tipIndex = Math.floor(Math.random() * TIPS.length);
  let tipTimer = 0;
  let fading = false;

  function setTip(i) {
    tipIndex = ((i | 0) + TIPS.length) % TIPS.length;
    tipEl.textContent = TIPS[tipIndex];
    tipEl.classList.remove('tip-in');
    // Force a reflow so the animation restarts on every new tip.
    void tipEl.offsetWidth;
    tipEl.classList.add('tip-in');
  }

  /** @param {number} v 0..1 @param {string} [stage] */
  function setProgress(v, stage) {
    target = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    if (stage) stageEl.textContent = stage;
  }

  function show() {
    fading = false;
    el.classList.remove('hidden', 'ldr-out');
    visible = true;
    setTip(tipIndex + 1);
    setProgress(0.06, 'Booting the kart engine');
  }

  function hide() {
    if (!visible) return;
    // `visible` drops immediately so the shell can take input again while the
    // fade-out animation still plays; `fading` keeps the canvas ticking.
    visible = false;
    if (fading) return;
    fading = true;
    el.classList.add('ldr-out');
    window.setTimeout(() => {
      if (!fading) return;
      fading = false;
      el.classList.add('hidden');
      el.classList.remove('ldr-out');
    }, 460);
  }

  function update(dt) {
    if (!visible && !fading) return;
    const step = Math.min(0.05, dt || 0.016);
    time += step;
    if (kCtx) paintKart(kCtx, time);
    progress += (target - progress) * Math.min(1, step * 6.5);
    if (target - progress < 0.002) progress = target;
    const p = Math.round(progress * 100);
    bar.style.width = `${(progress * 100).toFixed(1)}%`;
    if (pct.textContent !== `${p}%`) pct.textContent = `${p}%`;
    tipTimer += step;
    if (tipTimer > 4.2) {
      tipTimer = 0;
      setTip(tipIndex + 1);
    }
  }

  function dispose() {
    el.remove();
  }

  void ctx;
  return { el, show, hide, setProgress, setTip, update, dispose, get visible() { return visible; } };
}

export default createLoading;
