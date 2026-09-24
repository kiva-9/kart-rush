/**
 * In-race minimap for Kart Rush.
 *
 * The track outline is rasterised ONCE into an offscreen canvas from
 * `TrackPath.centerline2D()`. Every frame we blit that bitmap rotated about the
 * player so the kart always points up, then stamp kart dots, item boxes and the
 * start line on top. Total per-frame cost is one drawImage plus a handful of
 * arcs — well under a millisecond.
 *
 * Nothing here touches another subsystem at import time: the race director, the
 * kart entities and the item system are all reached through optional accessors.
 */

import { clamp } from '../core/MathUtils.js';

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

const OFF = 1024; // prerendered bitmap resolution
const FILL = 0.94; // fraction of the bitmap the track fills
const POOL = 12; // fixed slot pool, so the frame loop never allocates

export function createMinimap(ctx) {
  const canvas = h('canvas', { class: 'hud-minimap-canvas' });
  const listEl = h('div', { class: 'hud-standings' });
  const wrap = h(
    'div',
    { class: 'hud-mapwrap', 'data-screen': 'minimap' },
    h('div', { class: 'hud-minimap' }, canvas),
    listEl
  );

  const g = canvas.getContext('2d', { alpha: true });
  const off = document.createElement('canvas');
  off.width = OFF;
  off.height = OFF;
  const og = off.getContext('2d', { alpha: true });

  /** Prerendered track geometry, in "off-pixel" space. */
  const geo = {
    ready: false,
    k: 1, // pixels per metre inside the off canvas
    cx: 0, // world X mapped to the centre of the off canvas
    cz: 0, // world Z mapped to the centre of the off canvas
    p0x: 0,
    p0y: 0, // start line, in off pixels
    roadHalf: 5.5,
    sampleCount: 0,
    raw: null, // flat [x0, z0, ...] metres
    src: null, // live TrackPath, reused for kart -> pixel mapping
  };

  let source = null; // race director / session
  let raceView = null;
  let cssSize = 160;
  let dpr = 1;
  let sizeDirty = true;
  let listTimer = 0;
  let lastListKey = '';
  /** Reused entry buffer — the minimap must not allocate per frame. */
  const pool = [];
  for (let i = 0; i < POOL; i++) {
    pool.push({ x: 0, z: 0, yaw: 0, color: '#ffffff', isPlayer: false, name: '', rank: 1 });
  }
  let entryCount = 0;

  /* ------------------------------------------------------------------ sizing */

  function measure() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(80, Math.round(rect.width) || cssSize);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(w * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    cssSize = w;
    sizeDirty = false;
  }

  /* -------------------------------------------------------------- prerender */

  function buildFrom(pts, roadHalf, sampleCount, pathObj) {
    if (!pts || pts.length < 6) return false;
    geo.raw = pts;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i];
      const z = pts[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const ex = Math.max(1, maxX - minX);
    const ez = Math.max(1, maxZ - minZ);
    const k = (OFF * FILL) / Math.max(ex, ez);
    geo.k = k;
    geo.cx = (minX + maxX) * 0.5;
    geo.cz = (minZ + maxZ) * 0.5;
    geo.roadHalf = roadHalf;
    geo.sampleCount = sampleCount;
    geo.src = pathObj || null;
    geo.ready = true;

    const toX = (x) => (x - geo.cx) * k + OFF * 0.5;
    const toZ = (z) => (z - geo.cz) * k + OFF * 0.5;

    og.setTransform(1, 0, 0, 1, 0, 0);
    og.clearRect(0, 0, OFF, OFF);

    // --- ribbon ------------------------------------------------------------
    const trace = () => {
      og.beginPath();
      const n = pts.length / 2;
      for (let i = 0; i < n; i++) {
        const x = toX(pts[i * 2]);
        const y = toZ(pts[i * 2 + 1]);
        if (i === 0) og.moveTo(x, y);
        else og.lineTo(x, y);
      }
      og.closePath();
    };

    // kerb halo
    trace();
    og.lineJoin = 'round';
    og.lineCap = 'round';
    og.strokeStyle = 'rgba(224, 50, 42, 0.55)';
    og.lineWidth = (roadHalf * 2 + 3.4) * k;
    og.stroke();
    // tarmac
    trace();
    og.strokeStyle = 'rgba(16, 20, 36, 0.92)';
    og.lineWidth = roadHalf * 2 * k;
    og.stroke();
    // inner sheen
    trace();
    og.strokeStyle = 'rgba(120, 140, 190, 0.30)';
    og.lineWidth = roadHalf * 2 * k * 0.52;
    og.stroke();

    // centre dashes
    trace();
    og.setLineDash([k * 5.5, k * 7.5]);
    og.strokeStyle = 'rgba(255, 255, 255, 0.30)';
    og.lineWidth = Math.max(1.2, k * 0.55);
    og.stroke();
    og.setLineDash([]);

    // --- start / finish line ------------------------------------------------
    // Prefer the path's own startLine fraction; every shipped track uses 0.
    let sx = toX(pts[0]);
    let sy = toZ(pts[1]);
    let dxv = toX(pts[2]) - sx;
    let dyv = toZ(pts[3]) - sy;
    if (pathObj && typeof pathObj.frameAt === 'function') {
      try {
        const f = pathObj.frameAt(pathObj.startLine || 0);
        if (f && f.position) {
          sx = toX(f.position.x);
          sy = toZ(f.position.z);
          dxv = f.tangent.x * k;
          dyv = f.tangent.z * k;
        }
      } catch {
        /* fall back to sample 0 */
      }
    }
    geo.p0x = sx;
    geo.p0y = sy;
    const dl = Math.hypot(dxv, dyv) || 1;
    const nx = -dyv / dl;
    const ny = dxv / dl;
    const cells = 6;
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < 2; j++) {
        const t0 = (i / cells - 0.5) * roadHalf * 1.9;
        const t1 = ((i + 1) / cells - 0.5) * roadHalf * 1.9;
        og.fillStyle = (i + j) % 2 === 0 ? '#ffffff' : '#101426';
        og.beginPath();
        og.moveTo(sx + nx * t0 + dxv * 0.02, sy + ny * t0 + dyv * 0.02);
        og.lineTo(sx + nx * t1 + dxv * 0.02, sy + ny * t1 + dyv * 0.02);
        og.lineTo(sx + nx * t1 - dxv * 0.02, sy + ny * t1 - dyv * 0.02);
        og.lineTo(sx + nx * t0 - dxv * 0.02, sy + ny * t0 - dyv * 0.02);
        og.closePath();
        og.fill();
      }
    }
    return true;
  }

  /** Lazily build the outline from the live track, else from the track defs. */
  async function ensureGeometry() {
    if (geo.ready) return;
    const live = ctx.track || ctx.game?.track || null;
    if (live && typeof live.centerline2D === 'function') {
      const pts = live.centerline2D();
      const def = live.def || ctx.trackDef || {};
      const half = +(def.width ?? live.width ?? 11) || 11;
      if (buildFrom(pts, half, live.sampleCount || pts.length / 2, live)) return;
    }
    try {
      const [tracksMod, pathMod] = await Promise.all([
        import('../data/tracks.js'),
        import('../world/TrackPath.js'),
      ]);
      const getTrack = tracksMod.getTrack;
      const TrackPathCtor = pathMod.TrackPath;
      const def = getTrack ? getTrack(ctx.store?.state?.trackId) : null;
      if (def && typeof TrackPathCtor === 'function') {
        const path = new TrackPathCtor(def);
        if (buildFrom(path.centerline2D(), +(def.width || 11), path.sampleCount, path)) return;
      }
    } catch {
      /* track data unavailable — the minimap simply stays blank */
    }
  }

  /* ------------------------------------------------------------------ data */

  function worldOf(kart) {
    const p = kart?.physics?.position || kart?.position;
    return p || null;
  }

  function centrelinePos(progress) {
    const p = geo.src;
    if (p && typeof p.frameAt === 'function') {
      const f = p.frameAt(progress);
      if (f && f.position) return f.position;
    }
    const pts = geo.raw;
    if (!pts || geo.sampleCount < 2) return null;
    const i = clamp(Math.floor(progress * geo.sampleCount), 0, geo.sampleCount - 1) * 2;
    return { x: pts[i], z: pts[i + 1] };
  }

  function collect() {
    entryCount = 0;
    const karts = source && Array.isArray(source.karts) && source.karts.length ? source.karts : null;
    if (karts) {
      for (let i = 0; i < karts.length && entryCount < POOL; i++) {
        const k = karts[i];
        const w = worldOf(k);
        if (!w) continue;
        const e = pool[entryCount++];
        e.x = w.x;
        e.z = w.z;
        e.yaw = k?.physics?.yaw || 0;
        e.color = k?.color || k?.character?.color || '#ffffff';
        e.isPlayer = k?.isPlayer === true;
        e.name = k?.name || `Kart ${i + 1}`;
        e.rank = k?.rank || i + 1;
      }
      return;
    }
    // No kart objects (or the race layer changed shape): fall back to plotting
    // each standing on the centreline at its reported lap progress.
    const st = raceView && Array.isArray(raceView.standings) ? raceView.standings : null;
    if (!st) return;
    for (let i = 0; i < st.length && entryCount < POOL; i++) {
      const s = st[i];
      const prog = s.lapProgress != null && Number.isFinite(s.lapProgress) ? s.lapProgress : i / st.length;
      const p = centrelinePos(prog);
      if (!p) continue;
      const e = pool[entryCount++];
      e.x = p.x;
      e.z = p.z;
      e.yaw = 0;
      e.color = s.color || '#ffffff';
      e.isPlayer = s.isPlayer === true;
      e.name = s.name || `Kart ${i + 1}`;
      e.rank = s.position || i + 1;
    }
  }

  /* ------------------------------------------------------------------ draw */

  function draw() {
    if (!g || !geo.ready) return;
    const W = canvas.width;
    const H = canvas.height;
    const cxp = W * 0.5;
    const cyp = H * 0.5;

    // player
    let pwx = 0;
    let pwz = 0;
    let yaw = 0;
    const pk = source && source.player ? source.player : null;
    const pw = worldOf(pk);
    if (pw) {
      pwx = pw.x;
      pwz = pw.z;
      yaw = pk?.physics?.yaw || 0;
    } else if (entryCount) {
      let best = null;
      for (let i = 0; i < entryCount; i++) if (pool[i].isPlayer) best = pool[i];
      if (!best) best = pool[0];
      pwx = best.x;
      pwz = best.z;
      yaw = best.yaw;
    }
    const k = geo.k;
    const pOx = (pwx - geo.cx) * k + OFF * 0.5;
    const pOy = (pwz - geo.cz) * k + OFF * 0.5;
    const s = (W / OFF) * 1.0;
    const ca = Math.cos(yaw);
    const sa = Math.sin(yaw);

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);

    // track bitmap, rotated so the player faces up
    g.save();
    g.translate(cxp, cyp);
    g.rotate(yaw);
    g.scale(s, s);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(off, -pOx, -pOy, OFF, OFF);
    g.restore();

    const projX = (ox, oy) => cxp + s * ((ox - pOx) * ca - (oy - pOy) * sa);
    const projY = (ox, oy) => cyp + s * ((ox - pOx) * sa + (oy - pOy) * ca);

    // item boxes
    const boxes = source && source.items && Array.isArray(source.items.boxes) ? source.items.boxes : null;
    if (boxes) {
      const r = Math.max(2.2, W * 0.016);
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const bp = b?.position || b?.group?.position || b?.mesh?.position;
        if (!bp) continue;
        if (b.active === false || b.taken === true || (b.respawnTimer || 0) > 0) continue;
        const qx = projX((bp.x - geo.cx) * k + OFF * 0.5, (bp.z - geo.cz) * k + OFF * 0.5);
        const qy = projY((bp.x - geo.cx) * k + OFF * 0.5, (bp.z - geo.cz) * k + OFF * 0.5);
        g.fillStyle = 'rgba(120, 230, 255, 0.95)';
        g.strokeStyle = 'rgba(6, 10, 24, 0.9)';
        g.lineWidth = Math.max(1, W * 0.006);
        g.beginPath();
        g.arc(qx, qy, r, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }

    // start / finish line marker
    const sx0 = projX(geo.p0x, geo.p0y);
    const sy0 = projY(geo.p0x, geo.p0y);
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    g.beginPath();
    g.arc(sx0, sy0, Math.max(1.6, W * 0.012), 0, Math.PI * 2);
    g.fill();

    // kart dots
    const dotR = Math.max(2.6, W * 0.021);
    for (let i = 0; i < entryCount; i++) {
      const e = pool[i];
      if (e.isPlayer) continue;
      const ox = (e.x - geo.cx) * k + OFF * 0.5;
      const oy = (e.z - geo.cz) * k + OFF * 0.5;
      const qx = projX(ox, oy);
      const qy = projY(ox, oy);
      if (qx < -8 || qy < -8 || qx > W + 8 || qy > W + 8) continue;
      g.fillStyle = e.color;
      g.strokeStyle = 'rgba(6, 10, 24, 0.85)';
      g.lineWidth = Math.max(1, W * 0.007);
      g.beginPath();
      g.arc(qx, qy, dotR, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (e.yaw) {
        // a tiny heading tick, rotated into the player-relative map frame
        const d = yaw - e.yaw;
        const tx = Math.sin(d);
        const ty = -Math.cos(d);
        g.strokeStyle = e.color;
        g.lineWidth = Math.max(1, W * 0.006);
        g.beginPath();
        g.moveTo(qx + tx * dotR, qy + ty * dotR);
        g.lineTo(qx + tx * dotR * 2.2, qy + ty * dotR * 2.2);
        g.stroke();
      }
    }

    // player arrow, pinned to the centre, pointing up (heading is up by design)
    const ar = Math.max(4.5, W * 0.042);
    g.save();
    g.translate(cxp, cyp);
    g.fillStyle = '#ffffff';
    g.strokeStyle = 'rgba(6, 10, 24, 0.9)';
    g.lineWidth = Math.max(1.4, W * 0.009);
    g.beginPath();
    g.moveTo(0, -ar);
    g.lineTo(ar * 0.78, ar * 0.72);
    g.lineTo(0, ar * 0.34);
    g.lineTo(-ar * 0.78, ar * 0.72);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  /* ------------------------------------------------------------- stand list */

  function drawList() {
    const st = raceView && Array.isArray(raceView.standings) ? raceView.standings : null;
    if (!st) {
      if (listEl.childElementCount) listEl.textContent = '';
      return;
    }
    const key = st.map((s) => `${s.id}:${s.position}:${s.lap}`).join('|');
    if (key === lastListKey) return;
    lastListKey = key;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      frag.append(
        h(
          'div',
          { class: s.isPlayer ? 'st-row you' : 'st-row' },
          h('span', { class: 'st-pos', text: String(s.position || i + 1) }),
          h('span', { class: 'st-chip', style: { background: s.color || '#fff' } }),
          h('span', { class: 'st-name', text: s.name || '' })
        )
      );
    }
    listEl.textContent = '';
    listEl.append(frag);
  }

  /* ------------------------------------------------------------------ api */

  function setSource(race) {
    source = race || null;
    geo.ready = false;
    geo.raw = null;
    lastListKey = '';
    void ensureGeometry();
  }

  function update(dt, view) {
    raceView = view || raceView;
    if (sizeDirty) measure();
    void dt;
    if (!geo.ready) return;
    collect();
    draw();
    listTimer += dt || 0.016;
    if (listTimer > 0.12) {
      listTimer = 0;
      drawList();
    }
  }

  function onResize() {
    sizeDirty = true;
  }

  const offResize = ctx.bus ? ctx.bus.on('game:resize', onResize) : null;

  function dispose() {
    if (offResize) offResize();
    wrap.remove();
  }

  return { el: wrap, setSource, update, dispose };
}

export default createMinimap;
