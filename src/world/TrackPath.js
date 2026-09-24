/**
 * TrackPath — the spatial query backbone every other system leans on.
 *
 * A closed Catmull-Rom spline is resampled to a fixed number of EQUAL-ARC-LENGTH
 * samples carrying smoothed Frenet frames (tangent / right / up / normal) and
 * banking, plus a uniform XZ spatial hash for nearest-sample lookup.
 *
 * Everything in here is allocation-light: `locate()` runs several times per frame
 * per kart (8 karts at a fixed 120 Hz), so it only writes into caller-owned
 * objects and reuses module-level scratch state.
 *
 * Units: metres, radians, progress 0..1 along the closed centreline.
 */
import * as THREE from 'three';
import { clamp, lerp, smootherstep, wrapProgress, progressDelta, TAU } from '../core/MathUtils.js';

/** Equal-arc samples along the lap. 1200 keeps the spacing near 1.1 m. */
const SAMPLE_COUNT = 1200;
/** Samples used to measure the spline before resampling. */
const DENSE = 4096;
/** Half-width of the raised curb, metres. */
const CURB_WIDTH = 1.3;
/** How many independent "return value" frame objects we hand out. */
const FRAME_POOL = 8;
/** Spatial-hash cell size, metres. */
const CELL = 12;

/* ------------------------------------------------------------------- noise */

function hash2i(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 2D value noise in 0..1. */
function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2i(xi, yi);
  const b = hash2i(xi + 1, yi);
  const c = hash2i(xi, yi + 1);
  const d = hash2i(xi + 1, yi + 1);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

function makeFrame() {
  return {
    index: 0,
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    bank: 0,
    width: 0,
    curvature: 0,
  };
}

/** Pre-made frames handed out when the caller does not supply one. */
const _frames = [];
for (let i = 0; i < FRAME_POOL; i++) _frames.push(makeFrame());
let _frameCursor = 0;
/** Internal scratch frames — never handed out. */
const _sf = makeFrame();
const _sf2 = makeFrame();

const _locOut = { progress: 0, lateral: 0, index: 0, surface: 'road' };
const _refOut = { index: 0, progress: 0, lateral: 0 };

/**
 * Scratch for the ribbon search. `_scratch2` is kept separate so the wide scan
 * result cannot clobber the windowed one mid-refine.
 */
const _scratch = { dist: Infinity, index: 0, t: 0, blat: 0, bseg: 1, bd: Infinity };
const _scratch2 = { dist: Infinity, index: 0, t: 0, blat: 0, bseg: 1, bd: Infinity };

export class TrackPath {
  /**
   * @param {object} def TrackDef from src/data/tracks.js
   */
  constructor(def) {
    this.def = def || {};
    this.width = Math.max(4, +(this.def.width ?? 11));
    this.startLine = clamp(+(this.def.startLine ?? 0), 0, 0.999999);
    /** @type {number[]} ascending progress fractions RaceDirector checks in order. */
    this.checkpoints = [];
    this._build();
  }

  /* -------------------------------------------------------------- building */

  _controlPoints() {
    const raw = Array.isArray(this.def.path) ? this.def.path : [];
    const pts = [];
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      if (!p || p.length < 3) continue;
      const x = +p[0];
      const y = +p[1];
      const z = +p[2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const prev = pts[pts.length - 1];
      // Drop duplicates: Catmull-Rom needs distinct points to stay C1.
      if (prev && Math.abs(prev[0] - x) < 1e-4 && Math.abs(prev[2] - z) < 1e-4 && Math.abs(prev[1] - y) < 1e-4) continue;
      pts.push([x, y, z]);
    }
    while (pts.length < 4) pts.push([pts.length * 30, 0, 0]);
    if (pts.length > 4) {
      const f = pts[0];
      const l = pts[pts.length - 1];
      if (Math.abs(f[0] - l[0]) < 1e-4 && Math.abs(f[1] - l[1]) < 1e-4 && Math.abs(f[2] - l[2]) < 1e-4) pts.pop();
    }
    return pts;
  }

  _build() {
    const pts = this._controlPoints();
    const n = pts.length;
    this.controlPointCount = n;

    const vectors = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    this.curve = new THREE.CatmullRomCurve3(vectors, true, 'catmullrom', 0.5);

    // ---- dense polyline -> equal arc length samples -----------------------
    const dense = new Float64Array(DENSE * 3);
    for (let i = 0; i < DENSE; i++) {
      const p = this.curve.getPoint(i / DENSE, _sf.position);
      dense[i * 3] = p.x;
      dense[i * 3 + 1] = p.y;
      dense[i * 3 + 2] = p.z;
    }
    const cum = new Float64Array(DENSE + 1);
    for (let i = 1; i <= DENSE; i++) {
      const a = (i - 1) * 3;
      const b = (i % DENSE) * 3;
      const dx = dense[b] - dense[a];
      const dy = dense[b + 1] - dense[a + 1];
      const dz = dense[b + 2] - dense[a + 2];
      cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const total = cum[DENSE];
    this.length = total;

    const N = SAMPLE_COUNT;
    this.sampleCount = N;
    this.spacing = total / N;
    const ds = this.spacing;

    const pos = new Float32Array(N * 3);
    const tan = new Float32Array(N * 3);
    const right = new Float32Array(N * 3);
    const up = new Float32Array(N * 3);
    const nor = new Float32Array(N * 3);
    const bank = new Float32Array(N);
    const wid = new Float32Array(N);
    const curv = new Float32Array(N);

    const bankTable = this._bankTable(n);

    let j = 0;
    for (let s = 0; s < N; s++) {
      const target = s * ds;
      while (j < DENSE - 1 && cum[j + 1] < target) j++;
      const segLen = cum[j + 1] - cum[j];
      const f = segLen > 1e-9 ? clamp((target - cum[j]) / segLen, 0, 1) : 0;
      const a = j * 3;
      const b = ((j + 1) % DENSE) * 3;
      pos[s * 3] = dense[a] + (dense[b] - dense[a]) * f;
      pos[s * 3 + 1] = dense[a + 1] + (dense[b + 1] - dense[a + 1]) * f;
      pos[s * 3 + 2] = dense[a + 2] + (dense[b + 2] - dense[a + 2]) * f;
      const ci = ((j + f) / DENSE) * n;
      const i0 = Math.floor(ci) % n;
      const cf = ci - Math.floor(ci);
      bank[s] = bankTable[i0] * (1 - cf) + bankTable[(i0 + 1) % n] * cf;
      wid[s] = this.width;
    }

    // ---- raw headings / slopes, then smoothed frames ----------------------
    const head = new Float64Array(N);
    const slope = new Float64Array(N);
    for (let s = 0; s < N; s++) {
      const p0 = ((s - 1 + N) % N) * 3;
      const p1 = ((s + 1) % N) * 3;
      head[s] = Math.atan2(-(pos[p1] - pos[p0]), -(pos[p1 + 2] - pos[p0 + 2]));
      slope[s] = (pos[p1 + 1] - pos[p0 + 1]) / (2 * ds);
    }

    const W = 2; // symmetric smoothing window (unbiased for constant curvature)
    const smHead = new Float64Array(N);
    const smSlope = new Float64Array(N);
    const smBank = new Float64Array(N);
    const win = 1 / (2 * W + 1);
    for (let s = 0; s < N; s++) {
      let sx = 0;
      let sy = 0;
      let ss = 0;
      let sb = 0;
      for (let k = -W; k <= W; k++) {
        const q = (s + k + N) % N;
        sx += Math.sin(head[q]);
        sy += Math.cos(head[q]);
        ss += slope[q];
        sb += bank[q];
      }
      smHead[s] = Math.atan2(sx, sy);
      smSlope[s] = ss * win;
      smBank[s] = sb * win;
    }

    for (let s = 0; s < N; s++) {
      const h = smHead[s];
      const m = smSlope[s];
      const inv = 1 / Math.sqrt(1 + m * m);
      const tx = -Math.sin(h) * inv;
      const ty = m * inv;
      const tz = -Math.cos(h) * inv;
      tan[s * 3] = tx;
      tan[s * 3 + 1] = ty;
      tan[s * 3 + 2] = tz;

      // Horizontal right vector (perpendicular to the tangent by construction)
      // and the flat up vector = cross(right, tangent), both already unit.
      const hz2 = Math.hypot(tx, tz) || 1e-9;
      const rx = -tz / hz2;
      const rz = tx / hz2;
      const nx = (-tx * ty) / hz2;
      const ny = hz2;
      const nz = (-tz * ty) / hz2;

      // Bank: roll the road plane about the tangent. Positive bank lifts the
      // right edge, i.e. it is banked for a left-hand turn.
      const b = smBank[s];
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      right[s * 3] = rx * cb + nx * sb;
      right[s * 3 + 1] = ny * sb;
      right[s * 3 + 2] = rz * cb + nz * sb;
      // surface normal == up; tilts toward the left for a positive bank
      up[s * 3] = nx * cb - rx * sb;
      up[s * 3 + 1] = ny * cb;
      up[s * 3 + 2] = nz * cb - rz * sb;
      nor[s * 3] = up[s * 3];
      nor[s * 3 + 1] = up[s * 3 + 1];
      nor[s * 3 + 2] = up[s * 3 + 2];
      bank[s] = b;
    }

    for (let s = 0; s < N; s++) {
      const a = smHead[(s - 1 + N) % N];
      const b = smHead[(s + 1) % N];
      let d = b - a;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      curv[s] = d / (2 * ds);
    }

    this._pos = pos;
    this._tan = tan;
    this._right = right;
    this._up = up;
    this._nor = nor;
    this._bank = bank;
    this._width = wid;
    this._curv = curv;

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let s = 0; s < N; s++) {
      for (let k = 0; k < 3; k++) {
        const v = pos[s * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    this.bounds = { min, max };
    this.meanY = (min[1] + max[1]) * 0.5;

    // Public accessor: interleaved xyz with named typed-array views alongside.
    const samples = new Float32Array(N * 3);
    samples.set(pos);
    samples.count = N;
    samples.total = total;
    samples.spacing = ds;
    samples.position = samples;
    samples.tangent = tan;
    samples.right = right;
    samples.up = up;
    samples.normal = nor;
    samples.bank = bank;
    samples.width = wid;
    samples.curvature = curv;
    this.samples = samples;

    const c2 = new Float32Array(N * 2);
    for (let s = 0; s < N; s++) {
      c2[s * 2] = pos[s * 3];
      c2[s * 2 + 1] = pos[s * 3 + 2];
    }
    this._center2D = c2;

    this._buildHash();
    this.checkpoints = this._defaultCheckpoints();
    this._gap = this._gapSamples();
    this._lastIdx = -1;
    this._lastX = 0;
    this._lastZ = 0;
  }

  /**
   * Sample indices inside a broken-bridge gap, i.e. the stretch of a ravine
   * where TrackBuilder stops emitting tarmac. The driving surface must know
   * about it too: otherwise `locate()` keeps reporting `surface: 'road'` with
   * full grip over a hole in the road, and a kart that misses the jump simply
   * drives across the crevasse on invisible tarmac.
   */
  _gapSamples() {
    const set = new Set();
    const ravines = this.def.ravines;
    if (!Array.isArray(ravines)) return set;
    const N = this.sampleCount;
    for (const r of ravines) {
      if (!r || !r.gap) continue;
      const half = Math.max(1, +r.length || 1) * 0.5 / this.length;
      for (let i = 0; i < N; i++) {
        const d = i / N - (+r.p - half);
        if (d > 0 && d < half * 2) set.add(i);
      }
    }
    return set;
  }

  /** True when sample `index` is inside a broken-bridge gap. */
  inGap(index) {
    return this._gap ? this._gap.has(((index | 0) % this.sampleCount + this.sampleCount) % this.sampleCount) : false;
  }

  _bankTable(n) {
    const b = this.def.bank;
    const arr = new Float64Array(n);
    if (typeof b === 'number' && Number.isFinite(b)) {
      arr.fill(b);
      return arr;
    }
    if (Array.isArray(b) && b.length) {
      for (let i = 0; i < n; i++) {
        const v = +b[i % b.length];
        arr[i] = Number.isFinite(v) ? v : 0;
      }
    }
    return arr;
  }

  _defaultCheckpoints() {
    const count = 12;
    const list = [];
    for (let i = 0; i < count; i++) list.push(wrapProgress(this.startLine + i / count));
    list.sort((a, b) => a - b);
    return list;
  }

  /* --------------------------------------------------------- spatial hash */

  _key(cx, cz) {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  _buildHash() {
    const pos = this._pos;
    const N = this.sampleCount;
    const cell = CELL;
    const lists = new Map();
    for (let i = 0; i < N; i++) {
      const k = this._key(Math.floor(pos[i * 3] / cell), Math.floor(pos[i * 3 + 2] / cell));
      let list = lists.get(k);
      if (!list) lists.set(k, (list = []));
      list.push(i);
    }
    const buckets = new Map();
    for (const [k, list] of lists) buckets.set(k, new Int32Array(list));
    this._buckets = buckets;
    this._cell = cell;
  }

  /**
   * Nearest sample index for an XZ position. O(1): a 3x3 hash block in the
   * common case, expanding outward when the query is far from the ribbon.
   *
   * Returns -1 when nothing is inside the hash reach. Callers must not treat a
   * default of 0 as "the nearest sample": a far-away point would then measure
   * as "just off the edge" of whatever sample 0 happens to be, which is exactly
   * the lie the TrackBuilder far-ground disc believed when it buried the
   * horizon 7 m below sample 0's height.
   */
  nearestIndex(x, z) {
    const pos = this._pos;
    const buckets = this._buckets;
    let R = 0;
    let found = false;
    while (R < 12) {
      if (this._ringHas(x, z, R)) {
        found = true;
        break;
      }
      R++;
    }
    const span = found ? R + 1 : 12;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = -1;
    let bestD = Infinity;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const b = buckets.get(this._key(cx + dx, cz + dz));
        if (!b) continue;
        for (let i = 0; i < b.length; i++) {
          const s = b[i];
          const ddx = pos[s * 3] - x;
          const ddz = pos[s * 3 + 2] - z;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < bestD) {
            bestD = d2;
            best = s;
          }
        }
      }
    }
    return best;
  }
  /**
   * Nearest sample index for an XZ position, or -1 when the point is further
   * from the ribbon than the hash reach. Callers must handle -1 rather than
   * silently falling back to sample 0: a default of 0 makes a far-away point
   * measure as "just off the edge", which is exactly the lie that lets a kart
   * escape the track.
   */
  _nearestSample(x, z) {
    const pos = this._pos;
    const buckets = this._buckets;
    const N = this.sampleCount;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = -1;
    let bestD = Infinity;
    outer:
    for (let R = 0; R < 12; R++) {
      const span = R + 1;
      for (let dz = -span; dz <= span; dz++) {
        for (let dx = -span; dx <= span; dx++) {
          if (R > 0 && Math.abs(dx) !== span && Math.abs(dz) !== span) continue;
          const b = buckets.get(this._key(cx + dx, cz + dz));
          if (!b) continue;
          for (let i = 0; i < b.length; i++) {
            const s = b[i];
            const ddx = pos[s * 3] - x;
            const ddz = pos[s * 3 + 2] - z;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 < bestD) {
              bestD = d2;
              best = s;
            }
          }
          if (R >= 1 && best >= 0 && bestD < CELL * CELL) break outer;
        }
      }
    }
    if (best >= 0) return best;

    // Beyond the hash reach: brute-force the whole ribbon once. This is the
    // only honest answer for a point that has genuinely left the course.
    for (let s = 0; s < N; s++) {
      const ddx = pos[s * 3] - x;
      const ddz = pos[s * 3 + 2] - z;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < bestD) {
        bestD = d2;
        best = s;
      }
    }
    return best;
  }

  _ringHas(x, z, r) {
    const buckets = this._buckets;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    if (r === 0) return buckets.has(this._key(cx, cz));
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (buckets.has(this._key(cx + dx, cz + dz))) return true;
      }
    }
    return false;
  }

  /* --------------------------------------------------------------- frames */

  /**
   * Interpolated frame at a progress fraction.
   * @returns Frame
   */
  frameAt(progress, out) {
    const N = this.sampleCount;
    const p = Number.isFinite(progress) ? wrapProgress(progress) : 0;
    const f = p * N;
    const i0 = Math.floor(f) % N;
    const t = f - Math.floor(f);
    return this._frameLerp(i0, t, out);
  }

  /** Frame stored at an exact sample index (no interpolation). */
  sampleFrameAt(index, out) {
    const N = this.sampleCount;
    const i = ((Math.round(index) % N) + N) % N;
    const f = out && out.position ? out : makeFrame();
    const p = this._pos;
    f.index = i;
    f.position.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    f.tangent.set(this._tan[i * 3], this._tan[i * 3 + 1], this._tan[i * 3 + 2]);
    f.right.set(this._right[i * 3], this._right[i * 3 + 1], this._right[i * 3 + 2]);
    f.up.set(this._up[i * 3], this._up[i * 3 + 1], this._up[i * 3 + 2]);
    f.normal.set(this._nor[i * 3], this._nor[i * 3 + 1], this._nor[i * 3 + 2]);
    f.bank = this._bank[i];
    f.width = this._width[i];
    f.curvature = this._curv[i];
    return f;
  }

  _frameLerp(i0, t, out) {
    const N = this.sampleCount;
    const i1 = (i0 + 1) % N;
    const f = out && out.position ? out : _frames[_frameCursor++ % FRAME_POOL];
    const p = this._pos;
    const tn = this._tan;
    f.index = i0;

    // Cubic Hermite through the two bracketing samples using their tangents.
    const ds = this.spacing;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    for (let k = 0; k < 3; k++) {
      const a = i0 * 3 + k;
      const b = i1 * 3 + k;
      f.position.setComponent(k, h00 * p[a] + h10 * tn[a] * ds + h01 * p[b] + h11 * tn[b] * ds);
      f.tangent.setComponent(k, lerp(tn[a], tn[b], t));
      f.right.setComponent(k, lerp(this._right[a], this._right[b], t));
      f.up.setComponent(k, lerp(this._up[a], this._up[b], t));
    }
    f.normal.copy(f.up);
    f.tangent.normalize();
    f.right.normalize();
    const rl = f.up.length();
    if (rl > 1e-6) f.up.multiplyScalar(1 / rl);
    f.normal.copy(f.up);
    f.bank = lerp(this._bank[i0], this._bank[i1], t);
    f.width = lerp(this._width[i0], this._width[i1], t);
    f.curvature = lerp(this._curv[i0], this._curv[i1], t);
    return f;
  }

  /**
   * World position for a progress + signed lateral offset (metres from the
   * centreline, measured horizontally so it is the exact inverse of `locate`).
   */
  positionAt(progress, lateral, out) {
    const f = this.frameAt(progress, _sf);
    const rl = Math.hypot(f.right.x, f.right.z);
    const hx = rl > 1e-6 ? f.right.x / rl : 1;
    const hz = rl > 1e-6 ? f.right.z / rl : 0;
    // The lateral offset is measured horizontally (so it is the exact inverse of
    // `locate`) but the height follows the banked road plane, so anything seated
    // by (progress, lateral) rests on the tarmac.
    const y = f.position.y + lateral * Math.tan(f.bank);
    if (!out) return new THREE.Vector3(f.position.x + hx * lateral, y, f.position.z + hz * lateral);
    return out.set(f.position.x + hx * lateral, y, f.position.z + hz * lateral);
  }

  /** Tangent angle in radians at a progress fraction. */
  yawAt(progress) {
    const f = this.frameAt(progress, _sf);
    return Math.atan2(-f.tangent.x, -f.tangent.z);
  }

  bankAt(progress) {
    return this.frameAt(progress, _sf).bank;
  }

  curvatureAt(progress) {
    return this.frameAt(progress, _sf).curvature;
  }

  widthAt(progress) {
    return this.frameAt(progress, _sf).width;
  }

  /* -------------------------------------------------------------- queries */

  /**
   * Full spatial query — the hot one. Writes into `out` (or a shared object)
   * and allocates nothing.
   * @returns {{progress:number, lateral:number, index:number, surface:string}}
   */
  locate(x, y, z, out) {
    const info = this._refine(x, z);
    const res = out || _locOut;
    res.index = info.index;
    res.progress = info.progress;
    res.lateral = info.lateral;
    const a = Math.abs(info.lateral);
    res.surface = a <= this.width ? 'road' : a <= this.width + CURB_WIDTH ? 'curb' : 'off';
    return res;
  }

  /** Signed progress delta accounting for the closed loop, in progress units. */
  distanceBetween(a, b) {
    return progressDelta(a, b);
  }

  /** Advance a progress fraction by a distance in metres. */
  advance(progress, metres) {
    return wrapProgress(progress + metres / this.length);
  }

  progressToMetres(p) {
    return p * this.length;
  }

  metresToProgress(m) {
    return m / this.length;
  }

  /** 2D centreline for the minimap: flat [x0, z0, x1, z1, ...] in metres. */
  centerline2D() {
    return this._center2D;
  }

  /** Local coordinates of a world point. `height` is the road-plane height. */
  toLocal(x, y, z) {
    const info = this._refine(x, z);
    const f = this.frameAt(info.progress, _sf);
    const height = f.position.y + info.lateral * Math.tan(f.bank);
    return { progress: info.progress, lateral: info.lateral, height };
  }

  /**
   * Best segment for an XZ position. Fills and returns a shared object, so read
   * it immediately. Accuracy is limited only by the sample spacing (~1.1 m)
   * and the piecewise-linear projection, i.e. a couple of centimetres.
   */
  /** Best ribbon match within a window of samples around `centre`. */
  _searchWindow(x, z, centre, K, out) {
    const N = this.sampleCount;
    const pos = this._pos;
    let bd = Infinity;
    for (let k = -K; k <= K; k++) {
      const i = ((centre + k) % N + N) % N;
      const j = (i + 1) % N;
      const ax = pos[i * 3];
      const az = pos[i * 3 + 2];
      const ex = pos[j * 3] - ax;
      const ez = pos[j * 3 + 2] - az;
      const px = x - ax;
      const pz = z - az;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 1e-12 ? (px * ex + pz * ez) / len2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const qx = px - ex * t;
      const qz = pz - ez * t;
      const d2 = qx * qx + qz * qz;
      if (d2 < bd) {
        bd = d2;
        out.dist = Math.sqrt(d2);
        out.index = i;
        out.t = t;
        out.blat = qz * ex - qx * ez;
        out.bseg = Math.sqrt(len2);
      }
    }
    out.bd = bd;
    return out;
  }

  _refine(x, z) {
    const N = this.sampleCount;
    const pos = this._pos;
    let centre = this._lastIdx;
    if (centre < 0 || Math.abs(x - this._lastX) + Math.abs(z - this._lastZ) > 26) {
      centre = this._nearestSample(x, z);
    }
    // Shared scratch: locate() is the hottest query in the game (8 karts at
    // 120 Hz, plus AI, items, minimap), so allocating one per call was costing
    // more than the search itself.
    const scratch = _scratch;
    const K = 12;
    let hit = centre >= 0 ? this._searchWindow(x, z, centre, K, scratch) : scratch;

    // The cached centre is only trustworthy while the point stays near the
    // ribbon. Anything clearly outside the whole drivable envelope — tarmac,
    // kerb, wall and a margin — re-seeds from the hash, and if even that misses
    // (the point has left the course entirely) the whole ribbon is scanned once
    // so the answer stays an honest distance rather than a small
    // lateral-perpendicular-to-the-wrong-segment fiction.
    //
    // The threshold used to be a plain 8 m, which is *inside* every tarmac: the
    // whole kerb and everything off-track took the expensive path, and a kart
    // two thirds of the way across the road paid 20-90x the centreline cost.
    const reseedD = this.width + CURB_WIDTH + 24;
    const reseedD2 = reseedD * reseedD;
    if (hit.bd > reseedD2) {
      const seed = this._nearestSample(x, z);
      if (seed >= 0 && seed !== centre) {
        hit = this._searchWindow(x, z, seed, K, scratch);
      }
      if (hit.bd > reseedD2) {
        const wide = _scratch2;
        let bd = Infinity;
        wide.dist = Infinity;
        for (let i = 0; i < N; i++) {
          const j = (i + 1) % N;
          const ax = pos[i * 3];
          const az = pos[i * 3 + 2];
          const ex = pos[j * 3] - ax;
          const ez = pos[j * 3 + 2] - az;
          const px = x - ax;
          const pz = z - az;
          const len2 = ex * ex + ez * ez;
          let t = len2 > 1e-12 ? (px * ex + pz * ez) / len2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const qx = px - ex * t;
          const qz = pz - ez * t;
          const d2 = qx * qx + qz * qz;
          if (d2 < bd) {
            bd = d2;
            wide.dist = Math.sqrt(d2);
            wide.index = i;
            wide.t = t;
            wide.blat = qz * ex - qx * ez;
            wide.bseg = Math.sqrt(len2);
          }
        }
        wide.bd = bd;
        if (wide.bd < hit.bd) hit = wide;
      }
    }

    const bi = hit.index;
    const lat = hit.blat / (hit.bseg > 1e-6 ? hit.bseg : 1);
    this._lastIdx = bi;
    this._lastX = x;
    this._lastZ = z;
    _refOut.index = bi;
    _refOut.progress = wrapProgress((bi + hit.t) / N);
    // A point further than a segment length from the ribbon is reported with its
    // true radial distance, signed outward, so callers can never mistake it for
    // "just past the kerb".
    _refOut.lateral = lat;
    _refOut.distance = hit.dist;
    return _refOut;
  }

  /* ------------------------------------------------------------- surface */

  /** Terrain shape knobs from the definition, with safe defaults. */
  _profile() {
    const p = this.def.terrainProfile || {};
    return {
      base: Number.isFinite(p.base) ? p.base : this.meanY,
      relief: Number.isFinite(p.relief) ? p.relief : 6,
      apron: Number.isFinite(p.apron) ? p.apron : 3,
      shelf: Number.isFinite(p.shelf) ? p.shelf : 45,
    };
  }

  /** Landscape height at an XZ position, ignoring the road. */
  landscapeHeight(x, z) {
    const prof = this._profile();
    const relief = prof.relief;
    if (relief <= 0.001) return prof.base;
    const n1 = vnoise(x * 0.0062, z * 0.0062) - 0.5;
    const n2 = vnoise(x * 0.022, z * 0.022) - 0.5;
    const n3 = vnoise(x * 0.075, z * 0.075) - 0.5;
    return prof.base + relief * (n1 + n2 * 0.22 + n3 * 0.06);
  }

  /** Height of the drivable / ground surface at an XZ position. */
  surfaceHeight(x, z) {
    const info = this._refine(x, z);
    const f = this.frameAt(info.progress, _sf);
    return this._surfaceFromFrame(f, info.lateral, info.progress, x, z);
  }

  /**
   * The shared height model — the terrain mesh is generated from exactly this
   * function, so karts always rest on the ground the player can see.
   */
  _surfaceFromFrame(frame, lateral, progress, x, z) {
    const w = frame.width;
    const prof = this._profile();
    const d = Math.abs(lateral);
    const sgn = lateral < 0 ? -1 : 1;
    const edgeY = frame.position.y + sgn * w * Math.tan(frame.bank);
    let h;
    if (d <= w) {
      h = frame.position.y + lateral * Math.tan(frame.bank);
    } else if (d <= w + prof.apron) {
      h = edgeY;
    } else {
      const t = clamp((d - w - prof.apron) / Math.max(1, prof.shelf), 0, 1);
      h = lerp(edgeY, this.landscapeHeight(x, z), smootherstep(t));
    }
    const ravines = this.def.ravines;
    if (Array.isArray(ravines) && ravines.length) {
      const len = this.length;
      for (let i = 0; i < ravines.length; i++) {
        const r = ravines[i];
        const depth = +r.depth;
        if (!Number.isFinite(depth) || depth <= 0) continue;
        const rLen = Math.max(1, +r.length || 1);
        const halfW = Number.isFinite(+r.halfWidth) ? +r.halfWidth : 8;
        const da = Math.abs(progressDelta(progress, +r.p || 0) * len);
        if (da > rLen * 0.5) continue;
        const aw = smootherstep(1 - clamp(da / (rLen * 0.5), 0, 1));
        // Only the ground *outside* the tarmac falls away, so the road surface
        // itself stays intact even across a broken bridge — except where the
        // ravine really is a broken bridge: there TrackBuilder stops drawing
        // tarmac, so the driving surface has to stop existing too, or the kart
        // crosses the crevasse on road that nobody can see.
        const broken = r.gap === true && this.inGap(Math.round(progress * this.sampleCount));
        const dl = broken ? halfW + 1 : Math.max(0, d - w - 1.4);
        const lw = smootherstep(clamp(dl / Math.max(0.5, halfW), 0, 1));
        const cut = aw * lw * depth;
        if (cut > 0) h -= cut;
      }
    }
    return h;
  }

  /** Ground height at a lateral offset from a frame; used to seat props. */
  heightAtFrame(frame, lateral, progress) {
    const rx = frame.right.x;
    const rz = frame.right.z;
    const rl = Math.hypot(rx, rz) || 1;
    const x = frame.position.x + (rx / rl) * lateral;
    const z = frame.position.z + (rz / rl) * lateral;
    // The progress must come along for the ride: _surfaceFromFrame() uses it to
    // cut ravines, and passing a constant here (it used to be a literal 0)
    // silently drops the cut, so the terrain mesh came out 11 m too high over
    // every crevasse while the physics surface fell away correctly.
    const p = Number.isFinite(progress) ? progress : (frame.index | 0) / Math.max(1, this.sampleCount);
    return this._surfaceFromFrame(frame, lateral, p, x, z);
  }

  /**
   * How far the ground falls away over 7 m of lateral travel starting at
   * `width + offset`. Positive means a drop — barrier territory. `side` is the
   * +1 (driver's right) or -1 (left) edge being measured: without it every
   * caller measures the same side, so a barrier can appear on one side of a
   * corner and not the other.
   */
  dropAt(index, offset, side) {
    const s = side === -1 ? -1 : 1;
    const f = this.sampleFrameAt(index, _sf2);
    const w = f.width + Math.max(0, offset);
    return this.heightAtFrame(f, s * w) - this.heightAtFrame(f, s * (w + 7));
  }

  /** True where another part of the track runs inside `clearance` metres. */
  clearanceAt(index, clearance) {
    const N = this.sampleCount;
    const pos = this._pos;
    const x = pos[index * 3];
    const z = pos[index * 3 + 2];
    const lim = clearance * clearance;
    const near = this.nearestIndex(x, z);
    if (near < 0) return false; // outside the hash reach: nothing else is close
    for (let s = -48; s <= 48; s++) {
      const i = ((near + s) % N + N) % N;
      if (i === index) continue;
      const d = Math.abs(i - index);
      if (Math.min(d, N - d) * this.spacing < clearance) continue;
      const ddx = pos[i * 3] - x;
      const ddz = pos[i * 3 + 2] - z;
      if (ddx * ddx + ddz * ddz < lim) return true;
    }
    return false;
  }

  dispose() {
    this._buckets?.clear?.();
    this._buckets = null;
  }
}

export { CURB_WIDTH };
export default TrackPath;
