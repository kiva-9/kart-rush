/**
 * KartModel — the hero asset.
 *
 * Everything is generated at runtime from primitives, lathes and lofted rings;
 * no external meshes, textures or fonts exist anywhere in this project.
 *
 * Layout (kart local space, forward = -Z, y = 0 is the ground):
 *
 *   z -1.13  nose tip            z +0.99  tail
 *   y  0.00  wheel contact plane y  0.62  deck
 *
 * Graph:
 *   group                  added to Kart.group
 *   ├── blob               contact-shadow decal (flat, unlit, follows physics)
 *   ├── wheels[4]          pivot(steer+drift slip) -> spin(roll) -> tyre + rim
 *   └── body               squashes, rolls and pitches with the chassis
 *       ├── squash         scale group (lightning squash, boost stretch)
 *       │   ├── chassis    merged painted body: tub, nose, pods, wing, bumpers
 *       │   ├── shell      clear-coat shell (1.018x copy of the paint geometry)
 *       │   ├── chrome     merged trim: bumper hoop, exhausts, stays, wheel
 *       │   ├── dark       merged mechanical: engine, intakes, seat, floor
 *       │   ├── lights     emissive tail lamps
 *       │   └── driver     archetype model: arms, head, scarf/cape
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, damp, TAU } from '../core/MathUtils.js';

/** Fallback palette used when no character def is available. */
export const DEFAULT_PALETTE = {
  primary: '#e8352f',
  secondary: '#f6f8fb',
  accent: '#ffd60a',
  cap: '#e8352f',
  skin: '#f2b98d',
  hair: '#4b2e1c',
  tire: '#191b21',
  engine: '#9ad9ff',
  glow: '#ffd166',
};

const DRIVER_BODIES = ['human', 'dino', 'ape', 'mushroom', 'koopaKing'];

/** Loft tessellation / ribbon length per quality tier. */
const DETAIL = {
  high: { ring: 26, wheel: 26, scarf: 12, shell: true, spokes: 5 },
  medium: { ring: 18, wheel: 20, scarf: 9, shell: true, spokes: 5 },
  low: { ring: 12, wheel: 14, scarf: 6, shell: false, spokes: 4 },
};

const POD_X = 0.615;
const SPOILER_Z = 0.70;
const WHEEL_BASE_R = 0.35;

// ---------------------------------------------------------------------------
// Procedural canvas textures.
// The canvas is created once and cached CPU-side; every kart makes its own
// CanvasTexture, so a dispose() can never pull a GPU resource out from under
// another kart, and Game.teardownRace() cannot leave a stale cache behind.
// ---------------------------------------------------------------------------

let _tread = null;
let _blob = null;
let _flake = null;

function canCanvas() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function treadCanvas() {
  if (_tread) return _tread;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#16181d';
  g.fillRect(0, 0, 256, 128);
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 10; i++) {
      const w = 256 / 10;
      const x = i * w + 2;
      const y = row * 40 + 8;
      const skew = row % 2 === 0 ? 7 : -7;
      g.fillStyle = row === 1 ? '#22262e' : '#1c1f25';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + w - 6, y);
      g.lineTo(x + w - 6 + skew, y + 20);
      g.lineTo(x + skew, y + 20);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.055)';
      g.fillRect(x + 2, y + 1, w - 12, 3);
    }
  }
  g.fillStyle = '#0f1115';
  g.fillRect(0, 0, 256, 7);
  g.fillRect(0, 121, 256, 7);
  g.fillStyle = 'rgba(214,218,226,0.5)';
  g.font = 'bold 12px monospace';
  g.textAlign = 'center';
  for (let i = 0; i < 4; i++) g.fillText('RUSH', (i + 0.5) * 64, 68);
  _tread = c;
  return c;
}

function blobCanvas() {
  if (_blob) return _blob;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 3, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.9)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.5)');
  grad.addColorStop(0.76, 'rgba(0,0,0,0.14)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  _blob = c;
  return c;
}

/** Fine mottling used as a roughness map so the paint is never mirror-flat. */
function flakeCanvas() {
  if (_flake) return _flake;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c8c8c8';
  g.fillRect(0, 0, 256, 256);
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 2600; i++) {
    const v = Math.floor(150 + rnd() * 105);
    g.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',' + (0.05 + rnd() * 0.16).toFixed(3) + ')';
    g.beginPath();
    g.arc(rnd() * 256, rnd() * 256, 1 + rnd() * 3.4, 0, TAU);
    g.fill();
  }
  g.strokeStyle = 'rgba(120,120,120,0.45)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 44);
  g.lineTo(256, 44);
  g.moveTo(0, 208);
  g.lineTo(256, 208);
  g.stroke();
  _flake = c;
  return c;
}

function canvasTexture(draw, rx, ry) {
  if (!canCanvas()) return null;
  const tex = new THREE.CanvasTexture(draw());
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(rx, ry == null ? rx : ry);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Closed rounded-rectangle outline in the XY plane. */
function roundedRectPoints(hw, yb, yt, r, n) {
  const cy = (yb + yt) * 0.5;
  const hh = (yt - yb) * 0.5;
  const rr = Math.min(r, hw * 0.92, hh * 0.92);
  const per = Math.max(3, Math.round(n / 4));
  const corners = [
    [hw - rr, hh - rr, 0],
    [rr - hw, hh - rr, Math.PI / 2],
    [rr - hw, rr - hh, Math.PI],
    [hw - rr, rr - hh, Math.PI * 1.5],
  ];
  const pts = [];
  for (let c = 0; c < 4; c++) {
    const ox = corners[c][0];
    const oy = cy + corners[c][1];
    const a0 = corners[c][2];
    for (let i = 0; i < per; i++) {
      const a = a0 + (i / per) * (Math.PI / 2);
      pts.push([ox + Math.cos(a) * rr, oy + Math.sin(a) * rr]);
    }
  }
  return pts;
}

/** Cross-section of the tub: rounded rectangle in XY at height z. */
function ringTub(z, hw, yb, yt, r, n) {
  const pts = roundedRectPoints(hw, yb, yt, r, n);
  const out = [];
  for (let i = 0; i < pts.length; i++) out.push(new THREE.Vector3(pts[i][0], pts[i][1], z));
  return out;
}

/** Elliptical ring (nose bullet, engine cover, bumper). */
function ringEllipse(z, rx, ry, cy, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push(new THREE.Vector3(Math.cos(a) * rx, cy + Math.sin(a) * ry, z));
  }
  return out;
}

/**
 * Lofts equal-length rings into a smooth indexed surface.
 * @param {THREE.Vector3[][]} rings
 */
function loftRings(rings, capFront, capBack) {
  const n = rings[0].length;
  const m = rings.length;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let j = 0; j < m; j++) {
    const ring = rings[j];
    for (let i = 0; i < n; i++) {
      pos.push(ring[i].x, ring[i].y, ring[i].z);
      uv.push(i / n, j / (m - 1));
    }
  }
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * n + i;
      const b = j * n + ((i + 1) % n);
      const c = (j + 1) * n + ((i + 1) % n);
      const d = (j + 1) * n + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  if (capFront) capRing(rings[0], 0, pos, uv, idx, false);
  if (capBack) capRing(rings[m - 1], (m - 1) * n, pos, uv, idx, true);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Fans a ring into a flat cap; `ringStart` is the ring's first vertex index. */
function capRing(ring, ringStart, pos, uv, idx, flip) {
  const n = ring.length;
  const c = new THREE.Vector3();
  for (let i = 0; i < n; i++) c.add(ring[i]);
  c.multiplyScalar(1 / n);
  const base = pos.length / 3;
  pos.push(c.x, c.y, c.z);
  uv.push(0.5, flip ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const a = ringStart + i;
    const b = ringStart + ((i + 1) % n);
    if (flip) idx.push(base, b, a);
    else idx.push(base, a, b);
  }
}

function place(geo, x, y, z, rx, ry, rz, sx, sy, sz) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0));
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x || 0, y || 0, z || 0),
    q,
    new THREE.Vector3(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz)
  );
  geo.applyMatrix4(m);
  return geo;
}

/** Mirrors a geometry on X and reverses winding so faces stay outward. */
function mirrorX(geo) {
  geo.scale(-1, 1, 1);
  const index = geo.index;
  if (index) {
    const arr = index.array;
    for (let i = 0; i < arr.length; i += 3) {
      const t = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = t;
    }
    index.needsUpdate = true;
  }
  return geo;
}

/** Merges geometries into one, tolerating indexed/non-indexed mixes. */
function mergeAll(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    let g = list[i];
    if (!g) continue;
    if (g.index) g = g.toNonIndexed();
    if (!g.attributes.uv) {
      const count = g.attributes.position.count;
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    }
    for (const key in g.attributes) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
    }
    out.push(g);
  }
  if (!out.length) return new THREE.BufferGeometry();
  const merged = mergeGeometries(out, false);
  return merged || new THREE.BufferGeometry();
}

function disposeList(list) {
  for (let i = 0; i < list.length; i++) list[i] && list[i].dispose && list[i].dispose();
}

/**
 * Releases a material *and* every GPU texture hanging off it. The values that
 * are textures are only known by walking the keys, which is what
 * `Game.teardownRace()` does for anything left in the scene; a material disposed
 * on its own leaves its maps allocated.
 */
function disposeMaterial(m) {
  if (!m || typeof m.dispose !== 'function') return;
  for (const k in m) {
    const v = m[k];
    if (v && v.isTexture) v.dispose?.();
  }
  m.dispose();
}

// ---------------------------------------------------------------------------
// Chassis pieces
// ---------------------------------------------------------------------------

/** The streamlined tub: eleven lofted sections from the nose to the tail. */
function tubGeometry(n) {
  const spec = [
    // z,     halfW, yBottom, yTop,   cornerR
    [-1.04, 0.085, 0.250, 0.385, 0.035],
    [-0.94, 0.190, 0.200, 0.425, 0.060],
    [-0.79, 0.320, 0.180, 0.480, 0.095],
    [-0.60, 0.445, 0.170, 0.520, 0.120],
    [-0.34, 0.535, 0.160, 0.470, 0.135],
    [-0.02, 0.588, 0.155, 0.420, 0.145],
    [0.30, 0.595, 0.155, 0.440, 0.145],
    [0.56, 0.575, 0.160, 0.495, 0.140],
    [0.76, 0.520, 0.170, 0.535, 0.125],
    [0.90, 0.420, 0.185, 0.470, 0.100],
    [0.975, 0.240, 0.205, 0.365, 0.060],
  ];
  const rings = [];
  for (let i = 0; i < spec.length; i++) {
    rings.push(ringTub(spec[i][0], spec[i][1], spec[i][2], spec[i][3], spec[i][4], n));
  }
  return loftRings(rings, true, true);
}

/** Nose bullet: an elliptical stack, wide and flat. */
function noseGeometry(n) {
  const spec = [
    [-0.56, 0.455, 0.250],
    [-0.66, 0.470, 0.262],
    [-0.76, 0.462, 0.258],
    [-0.86, 0.430, 0.238],
    [-0.95, 0.372, 0.203],
    [-1.03, 0.288, 0.155],
    [-1.09, 0.180, 0.096],
    [-1.13, 0.075, 0.040],
  ];
  const rings = [];
  for (let i = 0; i < spec.length; i++) {
    rings.push(ringEllipse(spec[i][0], spec[i][1], spec[i][2], 0.330, n));
  }
  return loftRings(rings, true, true);
}

/** Side pod: a lofted wing on the flank, chunkiest at mid-length. */
function podGeometry(n, cx) {
  const spec = [
    [-0.50, 0.062, 0.245, 0.335],
    [-0.40, 0.078, 0.205, 0.430],
    [-0.18, 0.088, 0.192, 0.478],
    [0.06, 0.090, 0.192, 0.482],
    [0.28, 0.086, 0.198, 0.462],
    [0.46, 0.070, 0.222, 0.398],
    [0.54, 0.044, 0.258, 0.352],
  ];
  const rings = [];
  for (let i = 0; i < spec.length; i++) {
    const pts = roundedRectPoints(spec[i][1], spec[i][2], spec[i][3],
      Math.min(spec[i][1] * 0.6, (spec[i][3] - spec[i][2]) * 0.3), n);
    const ring = [];
    for (let k = 0; k < pts.length; k++) ring.push(new THREE.Vector3(cx + pts[k][0], pts[k][1], spec[i][0]));
    rings.push(ring);
  }
  return loftRings(rings, true, true);
}

/** Rear wing: a thin cambered plate. */
function spoilerPlateGeometry(n) {
  const spec = [-0.19, -0.10, 0.02, 0.13, 0.20];
  const rings = [];
  for (let i = 0; i < spec.length; i++) {
    const lift = spec[i] * 0.16;
    const pts = roundedRectPoints(0.575, lift, 0.052 + lift, 0.03, n);
    const ring = [];
    for (let k = 0; k < pts.length; k++) {
      ring.push(new THREE.Vector3(pts[k][0], pts[k][1] + 0.745, SPOILER_Z + spec[i]));
    }
    rings.push(ring);
  }
  return loftRings(rings, true, true);
}

/** Engine bay cover between the seat and the wing. */
function engineCoverGeometry(n) {
  const spec = [
    [0.34, 0.40, 0.030],
    [0.42, 0.44, 0.032],
    [0.55, 0.46, 0.030],
    [0.68, 0.42, 0.026],
    [0.78, 0.34, 0.020],
  ];
  const rings = [];
  for (let i = 0; i < spec.length; i++) {
    rings.push(ringEllipse(spec[i][0], spec[i][1], spec[i][2], 0.520, n));
  }
  return loftRings(rings, true, true);
}

/** Front splitter / bumper bar. */
function bumperGeometry(n) {
  const spec = [
    [-0.98, 0.30, 0.055],
    [-0.92, 0.40, 0.075],
    [-0.84, 0.46, 0.085],
    [-0.74, 0.50, 0.090],
    [-0.62, 0.50, 0.090],
  ];
  const rings = [];
  for (let i = 0; i < spec.length; i++) {
    rings.push(ringEllipse(spec[i][0], spec[i][1], spec[i][2], 0.285, n));
  }
  return loftRings(rings, true, false);
}

// ---------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------

/** Tyre + rim + spokes + brake disc, merged into a single wheel mesh. */
function wheelGeometry(radius, width, n, spokes) {
  const tyre = new THREE.CylinderGeometry(radius, radius, width, n, 1, false);
  tyre.rotateZ(Math.PI / 2);
  {
    const pos = tyre.attributes.position;
    const half = width * 0.5;
    for (let i = 0; i < pos.count; i++) {
      const f = Math.abs(pos.getX(i)) / half;
      const k = 1 - 0.05 * f * f;
      pos.setY(i, pos.getY(i) * k);
      pos.setZ(i, pos.getZ(i) * k);
    }
    tyre.computeVertexNormals();
  }
  const parts = [tyre];
  const rimR = radius * 0.66;
  const outer = new THREE.TorusGeometry(rimR, radius * 0.10, 6, n);
  outer.rotateY(Math.PI / 2);
  parts.push(outer);
  const hub = new THREE.CylinderGeometry(radius * 0.24, radius * 0.26, width * 0.42, 10);
  hub.rotateZ(Math.PI / 2);
  parts.push(hub);
  for (let s = -1; s <= 1; s += 2) {
    const face = new THREE.CircleGeometry(radius * 0.30, 12);
    face.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
    face.translate(s * width * 0.52, 0, 0);
    parts.push(face);
  }
  for (let s = 0; s < spokes; s++) {
    const spoke = new THREE.BoxGeometry(width * 0.2, rimR * 0.98, radius * 0.085);
    spoke.rotateX((s / spokes) * TAU);
    spoke.translate(0, rimR * 0.5, 0);
    parts.push(spoke);
  }
  const disc = new THREE.CylinderGeometry(radius * 0.46, radius * 0.46, width * 0.12, 12);
  disc.rotateZ(Math.PI / 2);
  parts.push(disc);
  return mergeAll(parts);
}

// ---------------------------------------------------------------------------
// Fluttering scarf / cape
// ---------------------------------------------------------------------------

/**
 * A single-mesh ribbon: a chain of points that springs to a travelling wave,
 * written straight into one buffer geometry. One draw call, no per-frame alloc.
 */
class Ribbon {
  constructor(opts) {
    const seg = Math.max(3, opts.segments | 0);
    this.seg = seg;
    this.width = opts.width;
    this.taper = opts.taper == null ? 0.4 : opts.taper;
    this.twist = opts.twist == null ? 2.2 : opts.twist;
    this.points = [];
    this.vel = [];
    for (let i = 0; i <= seg; i++) {
      this.points.push(new THREE.Vector3(0, 0, -i * 0.115));
      this.vel.push(new THREE.Vector3());
    }
    this.rest = [];
    for (let i = 0; i <= seg; i++) this.rest.push(new THREE.Vector3());
    const verts = (seg + 1) * 2;
    const pos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    for (let i = 0; i <= seg; i++) {
      uv[i * 4 + 0] = 0;
      uv[i * 4 + 1] = i / seg;
      uv[i * 4 + 2] = 1;
      uv[i * 4 + 3] = i / seg;
    }
    const idx = [];
    for (let i = 0; i < seg; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.geometry = geo;
    this.material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(opts.color == null ? '#ffffff' : opts.color),
      roughness: 0.74,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.phase = opts.phase || 0;
  }

  /**
   * Spring-damper per point toward an animated rest pose: stable, never runs
   * away, and the lag gives the fabric its whip.
   * @param {number} dt @param {number} speed m/s @param {number} time @param {number} drift signed drift dir
   */
  update(dt, speed, time, drift) {
    const seg = this.seg;
    const segLen = 0.115;
    const sp = clamp(Math.abs(speed) / 34, 0, 1.5);
    const flutter = 6 + sp * 26;
    const lift = 0.025 + sp * 0.26;
    const back = 0.8 + sp * 0.5;
    const outward = drift * (0.4 + sp * 0.35);
    // Rest pose: an absolute, stable shape (never relative to the last frame).
    let z = 0;
    for (let i = 1; i <= seg; i++) {
      const t = i / seg;
      z -= back * segLen * (0.3 + t * 0.7);
      const wave = Math.sin(time * flutter * 0.06 - this.phase - t * 4.2) * (0.025 + sp * 0.22) * t;
      const wob = Math.sin(time * flutter * 0.04 + t * 2.3) * (0.012 + sp * 0.1) * t;
      const r = this.rest[i];
      r.set(wave + outward * t * t, lift * t * t + wob, z);
    }
    const stiffness = 460;
    const dragK = 1 - Math.exp(-13 * dt);
    for (let i = 1; i <= seg; i++) {
      const p = this.points[i];
      const v = this.vel[i];
      const r = this.rest[i];
      v.x += (r.x - p.x) * stiffness * dt;
      v.y += (r.y - p.y) * stiffness * dt;
      v.z += (r.z - p.z) * stiffness * dt;
      v.multiplyScalar(dragK);
      p.addScaledVector(v, dt);
    }
    const arr = this.geometry.attributes.position.array;
    for (let i = 0; i <= seg; i++) {
      const p = this.points[i];
      const t = i / seg;
      const tw = t * this.twist;
      const rx = Math.cos(tw);
      const ry = Math.sin(tw);
      const w = this.width * (1 - this.taper * t) * 0.5;
      const base = i * 6;
      arr[base + 0] = p.x - rx * w;
      arr[base + 1] = p.y - ry * w;
      arr[base + 2] = p.z;
      arr[base + 3] = p.x + rx * w;
      arr[base + 4] = p.y + ry * w;
      arr[base + 5] = p.z;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Driver archetypes
// ---------------------------------------------------------------------------

function mkMat(color, rough, metal, extra) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color), roughness: rough, metalness: metal, ...(extra || {}),
  });
}

function sphere(r, seg) {
  const s = seg || 14;
  return new THREE.SphereGeometry(r, s, Math.max(6, s - 4));
}

function cap(r, len, seg) {
  return new THREE.CapsuleGeometry(r, len, seg == null ? 4 : seg, 9);
}

/** Eye pair parented to a head group. */
function addEyes(group, x, y, z, scale) {
  const white = mkMat(0xfdfdfd, 0.32, 0);
  const dark = mkMat(0x0d1015, 0.28, 0);
  for (let s = -1; s <= 1; s += 2) {
    const e = sphere(0.036 * scale, 10);
    place(e, s * x, y, z);
    const pupil = sphere(0.016 * scale, 8);
    place(pupil, s * x, y, z - 0.018 * scale);
    const w = new THREE.Mesh(e, white);
    w.add(new THREE.Mesh(pupil, dark));
    group.add(w);
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);
const _ikA = new THREE.Vector3();
const _ikB = new THREE.Vector3();
const _ikC = new THREE.Vector3();
const _ikD = new THREE.Vector3();
const _ikE = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();
const _ikQ2 = new THREE.Quaternion();
const _ikAxis = new THREE.Vector3();
const _ikEuler = new THREE.Euler();

/**
 * Analytic two-bone IK: rotates `shoulder` / `elbow` so the hand lands on
 * `target` (expressed in the shoulder's parent frame). The elbows splay toward
 * `pole`, which is what makes a driving pose read as a driving pose.
 */
function aimArm(shoulder, elbow, target, L1, L2, pole, rest) {
  _ikA.subVectors(target, shoulder.position);
  const reach = L1 + L2;
  const dist = clamp(_ikA.length(), Math.abs(L1 - L2) + 1e-3, reach - 1e-3);
  _ikA.normalize();
  const cosA = clamp((dist * dist + L1 * L1 - L2 * L2) / (2 * dist * L1), -1, 1);
  const A = Math.acos(cosA);
  _ikAxis.crossVectors(pole, _ikA);
  if (_ikAxis.lengthSq() < 1e-8) _ikAxis.set(0, 0, 1);
  _ikAxis.normalize();
  // Rotating the chain direction by -A about (pole x dir) tilts the upper bone
  // toward the pole, i.e. the elbow bulges the way a driving pose wants.
  _ikB.copy(_ikA).applyAxisAngle(_ikAxis, -A).normalize();
  shoulder.quaternion.setFromUnitVectors(DOWN, _ikB);
  _ikC.copy(shoulder.position).addScaledVector(_ikB, L1);
  _ikD.subVectors(target, _ikC).normalize();
  _ikQ2.setFromUnitVectors(DOWN, _ikD);
  elbow.quaternion.copy(_ikQ.copy(shoulder.quaternion).invert()).multiply(_ikQ2);
  // Cache the rest pose as Euler XYZ so the animator can damp toward it.
  _ikEuler.setFromQuaternion(shoulder.quaternion, 'XYZ');
  shoulder.rotation.set(_ikEuler.x, _ikEuler.y, _ikEuler.z);
  _ikEuler.setFromQuaternion(elbow.quaternion, 'XYZ');
  elbow.rotation.set(_ikEuler.x, _ikEuler.y, _ikEuler.z);
  rest.x = shoulder.rotation.x;
  rest.y = shoulder.rotation.y;
  rest.z = shoulder.rotation.z;
  rest.ex = elbow.rotation.x;
  rest.ey = elbow.rotation.y;
  rest.ez = elbow.rotation.z;
}

/** Upper + forearm + hand bone chain with an exact, IK-solved rest pose. */
function buildArm(parent, shoulderPos, thickness, mat, handMat, target, pole) {
  const L1 = 0.27;
  const L2 = 0.235;
  const shoulder = new THREE.Object3D();
  shoulder.position.copy(shoulderPos);
  parent.add(shoulder);
  const elbow = new THREE.Object3D();
  elbow.position.set(0, -L1, 0);
  shoulder.add(elbow);
  const r = thickness;
  const upper = cap(r, Math.max(0.04, L1 - 2 * r), 3);
  place(upper, 0, -L1 * 0.5, 0);
  shoulder.add(new THREE.Mesh(upper, mat));
  const cuff = new THREE.TorusGeometry(r * 1.05, r * 0.3, 5, 12);
  cuff.rotateX(Math.PI / 2);
  elbow.add(new THREE.Mesh(cuff, handMat));
  const fore = cap(r * 0.92, Math.max(0.04, L2 - 2 * r * 0.92), 3);
  place(fore, 0, -L2 * 0.5, 0);
  elbow.add(new THREE.Mesh(fore, mat));
  const hand = sphere(r * 1.5, 10);
  place(hand, 0, -L2, 0);
  const handMesh = new THREE.Mesh(hand, handMat);
  // Kept as its own mesh: it is an animation handle (koopaKing claws hang off it)
  // and must survive the per-material merge pass.
  handMesh.userData.noMerge = true;
  elbow.add(handMesh);
  const rest = { x: 0, y: 0, z: 0, ex: 0, ey: 0, ez: 0 };
  aimArm(shoulder, elbow, target, L1, L2, pole, rest);
  return { shoulder, elbow, hand: handMesh, rest };
}
/**
 * Merges the direct mesh children of every group below `root` by material.
 * The archetypes are written as readable stacks of primitives; this collapses
 * each stack into one mesh per material, which roughly halves the kart's draw
 * calls (8 karts x 60 meshes is a lot of state changes for nothing).
 */
function mergeDriverTree(root) {
  const groups = [];
  root.traverse((o) => { if (o !== root && o.isObject3D) groups.push(o); });
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const buckets = new Map();
    const order = [];
    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i];
      if (!child.isMesh || child.children.length || child.userData.noMerge) continue;
      const mat = child.material;
      let b = buckets.get(mat);
      if (!b) {
        buckets.set(mat, b = { mat, geos: [], first: child, spare: [] });
        order.push(b);
      }
      if (b.geos.length) b.spare.push(child.geometry);
      b.geos.push(child.geometry);
      group.remove(child);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const b = order[i];
      if (b.geos.length === 1) {
        // Nothing to merge: put the original mesh straight back.
        group.add(b.first);
        continue;
      }
      const mesh = new THREE.Mesh(mergeAll(b.geos), b.mat);
      mesh.castShadow = b.first.castShadow;
      mesh.receiveShadow = b.first.receiveShadow;
      mesh.name = b.first.name;
      group.add(mesh);
      for (let s = 0; s < b.spare.length; s++) b.spare[s].dispose();
    }
  }
}

/**
 * Legs that reach forward onto the pedal deck. The hips sit on the seat; each
 * leg is a hip group rotated so the foot lands on the nose deck at z ~ -0.44.
 */
function buildLegs(legs, x, r, reach, mat, bootMat, bootW) {
  for (let s = -1; s <= 1; s += 2) {
    const hip = new THREE.Object3D();
    hip.position.set(s * x, 0, 0);
    hip.rotation.x = 1.62;
    legs.add(hip);
    const len = Math.max(0.12, reach * 0.6 - r);
    const leg = cap(r, len, 3);
    place(leg, 0, -reach * 0.5, 0);
    hip.add(new THREE.Mesh(leg, mat));
    const knee = sphere(r * 1.15, 8);
    place(knee, 0, -reach * 0.5, 0);
    hip.add(new THREE.Mesh(knee, mat));
    const boot = new THREE.BoxGeometry(bootW, 0.1, 0.21);
    place(boot, 0, -reach + 0.03, -0.02);
    boot.rotateX(-0.35);
    hip.add(new THREE.Mesh(boot, bootMat));
  }
}

/**
 * Builds a driver of the requested archetype. Returns animated handles.
 */
function buildDriver(body, palette, detail, rng) {
  const root = new THREE.Object3D();
  const suit = mkMat(palette.primary, 0.62, 0.05);
  const suit2 = mkMat(palette.secondary, 0.66, 0.05);
  const skin = mkMat(palette.skin, 0.78, 0.02);
  const capM = mkMat(palette.cap, 0.7, 0.03);
  const accent = mkMat(palette.accent, 0.4, 0.25);
  const dark = mkMat(0x1b1f27, 0.85, 0.05);
  const hair = mkMat(palette.hair, 0.9, 0.02);
  const bone = mkMat(0xf5f0e6, 0.55, 0.06);

  const legs = new THREE.Object3D();
  root.add(legs);
  const torso = new THREE.Object3D();
  torso.position.set(0, 0.02, 0.01);
  root.add(torso);
  const head = new THREE.Object3D();
  head.position.set(0, 0.30, 0);
  torso.add(head);

  const P = { root, legs, torso, head, suit, suit2, skin, capM, accent, dark, hair, bone, shoulderY: 0.24, cape: false };

  if (body === 'human') {
    buildLegs(legs, 0.185, 0.085, 0.42, suit, capM, 0.145);
    const chest = sphere(0.215, 16);
    chest.scale(1, 1.06, 0.82);
    place(chest, 0, 0.10, 0);
    torso.add(new THREE.Mesh(chest, suit));
    const bib = new THREE.SphereGeometry(0.232, 16, 10, -1.0, 2.0, 0.6, 1.3);
    bib.scale(1.02, 1.05, 0.9);
    place(bib, 0, 0.10, 0);
    torso.add(new THREE.Mesh(bib, suit2));
    const belt = new THREE.TorusGeometry(0.185, 0.035, 6, 16);
    belt.rotateX(Math.PI / 2);
    place(belt, 0, -0.03, 0);
    torso.add(new THREE.Mesh(belt, dark));
    const buckle = new THREE.BoxGeometry(0.06, 0.05, 0.03);
    place(buckle, 0, -0.03, -0.185);
    torso.add(new THREE.Mesh(buckle, accent));

    const skull = sphere(0.155, 16);
    place(skull, 0, 0, 0);
    head.add(new THREE.Mesh(skull, skin));
    const nose = new THREE.ConeGeometry(0.032, 0.085, 8);
    place(nose, 0, -0.01, -0.145, Math.PI * 0.5, 0, 0);
    head.add(new THREE.Mesh(nose, skin));
    for (let s = -1; s <= 1; s += 2) {
      const ear = sphere(0.038, 8);
      place(ear, s * 0.148, 0.01, 0.01);
      head.add(new THREE.Mesh(ear, skin));
    }
    addEyes(head, 0.062, 0.03, -0.128, 1.0);
    const dome = new THREE.SphereGeometry(0.168, 16, 10, 0, TAU, 0, Math.PI * 0.52);
    place(dome, 0, 0.015, 0.005);
    head.add(new THREE.Mesh(dome, capM));
    const brim = new THREE.CylinderGeometry(0.17, 0.17, 0.022, 16, 1, false, -0.9, 1.8);
    place(brim, 0, 0.035, -0.10, -0.22, 0, 0);
    head.add(new THREE.Mesh(brim, capM));
    const back = sphere(0.15, 10);
    back.scale(1, 0.85, 1);
    place(back, 0, -0.02, 0.07);
    head.add(new THREE.Mesh(back, hair));
    P.shoulderY = 0.235;
  } else if (body === 'dino') {
    const hide = mkMat(palette.primary, 0.68, 0.04);
    const foot = mkMat(palette.accent, 0.7, 0.03);
    buildLegs(legs, 0.17, 0.08, 0.40, foot, foot, 0.155);
    const bodyM = sphere(0.225, 16);
    bodyM.scale(1, 1.05, 0.86);
    place(bodyM, 0, 0.09, 0.02);
    torso.add(new THREE.Mesh(bodyM, hide));
    const tummy = sphere(0.17, 12);
    tummy.scale(1, 1.15, 0.7);
    place(tummy, 0, 0.05, -0.12);
    torso.add(new THREE.Mesh(tummy, suit2));
    let tz = 0.16;
    for (let i = 0; i < 3; i++) {
      const seg = new THREE.ConeGeometry(0.115 - i * 0.032, 0.24 - i * 0.04, 10);
      place(seg, 0, 0.02 + i * 0.05, tz + 0.08, Math.PI * 0.5, 0, 0);
      torso.add(new THREE.Mesh(seg, hide));
      tz += 0.19;
    }
    const skull = sphere(0.175, 16);
    place(skull, 0, 0.02, -0.02);
    head.add(new THREE.Mesh(skull, hide));
    const snout = new THREE.BoxGeometry(0.17, 0.12, 0.20);
    place(snout, 0, -0.045, -0.19);
    head.add(new THREE.Mesh(snout, hide));
    const jaw = new THREE.BoxGeometry(0.15, 0.05, 0.19);
    place(jaw, 0, -0.115, -0.185);
    head.add(new THREE.Mesh(jaw, suit2));
    for (let s = -1; s <= 1; s += 2) {
      const nostril = sphere(0.02, 8);
      place(nostril, s * 0.05, -0.015, -0.288);
      head.add(new THREE.Mesh(nostril, dark));
      const horn = new THREE.ConeGeometry(0.028, 0.10, 8);
      place(horn, s * 0.09, 0.14, -0.05, -0.35, 0, 0);
      head.add(new THREE.Mesh(horn, suit2));
    }
    addEyes(head, 0.085, 0.055, -0.115, 1.25);
    for (let i = 0; i < 3; i++) {
      const spike = new THREE.ConeGeometry(0.03 - i * 0.006, 0.11 - i * 0.02, 7);
      place(spike, 0, 0.15, 0.02 - i * 0.055, -0.2, 0, 0);
      head.add(new THREE.Mesh(spike, mkMat(palette.cap, 0.6, 0.05)));
    }
    for (let s = -1; s <= 1; s += 2) {
      const arm = cap(0.055, 0.1, 3);
      place(arm, s * 0.21, 0.12, -0.03);
      arm.rotateX(-0.9);
      torso.add(new THREE.Mesh(arm, hide));
    }
    P.shoulderY = 0.245;
  } else if (body === 'ape') {
    const fur = mkMat(palette.primary, 0.92, 0.02);
    const muzzle = mkMat(palette.secondary, 0.85, 0.02);
    buildLegs(legs, 0.19, 0.115, 0.44, fur, muzzle, 0.175);
    const chest = sphere(0.265, 16);
    chest.scale(1, 0.98, 0.86);
    place(chest, 0, 0.11, 0.01);
    torso.add(new THREE.Mesh(chest, fur));
    const pec = sphere(0.245, 12);
    pec.scale(1.01, 0.96, 0.72);
    place(pec, 0, 0.10, -0.10);
    torso.add(new THREE.Mesh(pec, muzzle));
    const tie = new THREE.BoxGeometry(0.07, 0.20, 0.03);
    place(tie, 0, 0.02, -0.215, 0.12, 0, 0);
    torso.add(new THREE.Mesh(tie, accent));
    const knot = new THREE.BoxGeometry(0.075, 0.05, 0.035);
    place(knot, 0, 0.135, -0.212, 0.12, 0, 0);
    torso.add(new THREE.Mesh(knot, accent));
    const skull = sphere(0.185, 16);
    place(skull, 0, 0, 0);
    head.add(new THREE.Mesh(skull, fur));
    const snout = new THREE.BoxGeometry(0.19, 0.13, 0.14);
    place(snout, 0, -0.05, -0.175);
    head.add(new THREE.Mesh(snout, muzzle));
    for (let s = -1; s <= 1; s += 2) {
      const ear = sphere(0.055, 10);
      place(ear, s * 0.175, 0.015, 0.01);
      ear.scale(1, 1, 0.55);
      head.add(new THREE.Mesh(ear, fur));
      const nostril = sphere(0.022, 8);
      place(nostril, s * 0.05, -0.045, -0.248);
      head.add(new THREE.Mesh(nostril, dark));
    }
    const brow = new THREE.BoxGeometry(0.26, 0.045, 0.10);
    place(brow, 0, 0.075, -0.135);
    head.add(new THREE.Mesh(brow, fur));
    addEyes(head, 0.075, 0.025, -0.145, 0.95);
    for (let i = 0; i < 4; i++) {
      const tuft = new THREE.ConeGeometry(0.028, 0.12, 6);
      place(tuft, (i - 1.5) * 0.075, 0.15, 0.02 - Math.abs(i - 1.5) * 0.02, -0.15, 0, 0);
      head.add(new THREE.Mesh(tuft, hair));
    }
    P.shoulderY = 0.26;
  } else if (body === 'mushroom') {
    const robe = mkMat(palette.primary, 0.7, 0.04);
    const spot = mkMat(palette.secondary, 0.66, 0.04);
    buildLegs(legs, 0.10, 0.062, 0.34, robe, spot, 0.115);
    const skirt = new THREE.ConeGeometry(0.235, 0.30, 16, 1, true);
    place(skirt, 0, -0.16, 0.02);
    torso.add(new THREE.Mesh(skirt, robe));
    const waist = new THREE.CylinderGeometry(0.115, 0.135, 0.10, 12);
    place(waist, 0, -0.02, 0.01);
    torso.add(new THREE.Mesh(waist, spot));
    const vest = new THREE.CylinderGeometry(0.135, 0.15, 0.16, 12);
    place(vest, 0, 0.08, 0);
    torso.add(new THREE.Mesh(vest, spot));
    const dome = new THREE.SphereGeometry(0.285, 18, 12, 0, TAU, 0, Math.PI * 0.55);
    place(dome, 0, 0.195, 0);
    dome.scale(1, 1.05, 1);
    head.add(new THREE.Mesh(dome, robe));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.4;
      const s = sphere(0.062, 10);
      place(s, Math.cos(a) * 0.17, 0.30 + Math.sin(a) * 0.06, Math.sin(a) * 0.17);
      s.scale(1, 0.55, 1);
      head.add(new THREE.Mesh(s, spot));
    }
    const face = sphere(0.145, 14);
    place(face, 0, -0.06, -0.01);
    head.add(new THREE.Mesh(face, skin));
    for (let s = -1; s <= 1; s += 2) {
      const cheek = sphere(0.045, 8);
      place(cheek, s * 0.085, -0.045, -0.075);
      head.add(new THREE.Mesh(cheek, mkMat(palette.cap, 0.7, 0.03)));
    }
    addEyes(head, 0.062, 0.0, -0.115, 1.15);
    const mouth = new THREE.BoxGeometry(0.06, 0.022, 0.02);
    place(mouth, 0, -0.10, -0.135);
    head.add(new THREE.Mesh(mouth, dark));
    P.shoulderY = 0.19;
  } else {
    // koopaKing
    const shellM = mkMat(palette.secondary, 0.55, 0.12);
    const skinK = mkMat(palette.primary, 0.62, 0.05);
    const belly = mkMat(palette.accent, 0.7, 0.05);
    buildLegs(legs, 0.185, 0.10, 0.42, skinK, belly, 0.16);
    const shell = sphere(0.265, 16);
    shell.scale(1, 1, 0.78);
    place(shell, 0, 0.11, 0.075);
    torso.add(new THREE.Mesh(shell, shellM));
    const chest = sphere(0.175, 14);
    chest.scale(0.95, 1, 0.7);
    place(chest, 0, 0.10, -0.055);
    torso.add(new THREE.Mesh(chest, skinK));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const spike = new THREE.ConeGeometry(0.045, 0.13, 7);
      place(spike, Math.cos(a) * 0.24, 0.11 + Math.sin(a) * 0.24, 0.075,
        Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
      torso.add(new THREE.Mesh(spike, bone));
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      const spike = new THREE.ConeGeometry(0.05, 0.12, 7);
      place(spike, Math.cos(a) * 0.2, 0.235, 0.02 + Math.sin(a) * 0.05, -0.4, 0, 0);
      torso.add(new THREE.Mesh(spike, bone));
    }
    const skull = sphere(0.185, 16);
    place(skull, 0, 0.01, 0);
    head.add(new THREE.Mesh(skull, skinK));
    const snout = new THREE.BoxGeometry(0.19, 0.14, 0.17);
    place(snout, 0, -0.045, -0.19);
    head.add(new THREE.Mesh(snout, skinK));
    for (let s = -1; s <= 1; s += 2) {
      const nostril = sphere(0.022, 8);
      place(nostril, s * 0.055, -0.035, -0.275);
      head.add(new THREE.Mesh(nostril, dark));
      const horn = new THREE.ConeGeometry(0.038, 0.17, 8);
      place(horn, s * 0.14, 0.14, 0, -0.35, 0, s * 0.28);
      head.add(new THREE.Mesh(horn, bone));
      const brow = new THREE.BoxGeometry(0.10, 0.035, 0.06);
      place(brow, s * 0.075, 0.075, -0.155, 0.2, 0, s * 0.25);
      head.add(new THREE.Mesh(brow, hair));
      const fang = new THREE.ConeGeometry(0.016, 0.05, 6);
      place(fang, s * 0.045, -0.105, -0.265, Math.PI, 0, 0);
      head.add(new THREE.Mesh(fang, mkMat(0xfdfdfd, 0.4, 0)));
    }
    addEyes(head, 0.082, 0.03, -0.135, 1.05);
    for (let i = 0; i < 7; i++) {
      const a = 0.5 + (i / 6) * 2.4;
      const spike = new THREE.ConeGeometry(0.032, 0.14, 6);
      place(spike, Math.cos(a) * 0.17, 0.16, -0.02 + Math.sin(a) * 0.05,
        -0.5 + Math.cos(a) * 0.3, 0, 0);
      head.add(new THREE.Mesh(spike, hair));
    }
    const crown = new THREE.ConeGeometry(0.045, 0.10, 6);
    place(crown, 0, 0.215, -0.01, -0.1, 0, 0);
    head.add(new THREE.Mesh(crown, mkMat(0xffd60a, 0.25, 0.85)));
    P.shoulderY = 0.245;
    P.cape = true;
  }

  // ---- arms reaching the wheel ----
  const th = body === 'mushroom' ? 0.052 : body === 'ape' ? 0.074 : 0.062;
  const armMat = body === 'human' ? suit : body === 'ape' ? mkMat(palette.primary, 0.92, 0.02) : suit;
  const handMat = body === 'human' ? mkMat(0xf2f4f8, 0.6, 0.02)
    : body === 'mushroom' ? mkMat(0xffffff, 0.6, 0.02) : skin;
  // Hands rest on the wheel rim; the IK chain solves the elbow automatically.
  const armL = buildArm(torso, new THREE.Vector3(-0.235, P.shoulderY, 0.0), th, armMat, handMat,
    new THREE.Vector3(-0.105, 0.145, -0.425), new THREE.Vector3(-0.85, -0.35, 0).normalize());
  const armR = buildArm(torso, new THREE.Vector3(0.235, P.shoulderY, 0.0), th, armMat, handMat,
    new THREE.Vector3(0.105, 0.145, -0.425), new THREE.Vector3(0.85, -0.35, 0).normalize());
  if (body === 'koopaKing') {
    for (let s = -1; s <= 1; s += 2) {
      for (let c = -1; c <= 1; c++) {
        const claw = new THREE.ConeGeometry(0.016, 0.055, 5);
        place(claw, c * 0.032, -0.075, -0.02, Math.PI * 0.55, 0, 0);
        (s < 0 ? armL : armR).hand.add(new THREE.Mesh(claw, bone));
      }
    }
  }
  P.armL = armL;
  P.armR = armR;

  // ---- scarf / cape ----
  const scarf = new Ribbon({
    segments: detail.scarf,
    width: P.cape ? 0.34 : 0.16,
    taper: P.cape ? 0.22 : 0.4,
    twist: P.cape ? 3.4 : 2.2,
    color: palette.accent,
    phase: rng ? rng() * 6.283 : 0,
  });
  scarf.mesh.position.set(0, 0.235, 0.075);
  torso.add(scarf.mesh);
  P.scarf = scarf;
  return P;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export class KartModel {
  /**
   * @param {{color?:string, palette?:object, body?:string, detail?:string,
   *          scale?:number, rng?:Function}} [opts]
   */
  constructor(opts) {
    const o = opts || {};
    this.detail = DETAIL[o.detail] || DETAIL.high;
    this.scale = o.scale == null ? 1 : o.scale;
    this.rng = o.rng || Math.random;
    this.palette = { ...DEFAULT_PALETTE, ...(o.palette || {}) };
    this.color = new THREE.Color(o.color || this.palette.primary);
    /** Driver archetype: 'human' | 'dino' | 'ape' | 'mushroom' | 'koopaKing'. */
    this.bodyType = DRIVER_BODIES.indexOf(o.body) >= 0 ? o.body : 'human';
    this.group = new THREE.Group();
    this.group.name = 'kartModel';
    this.time = 0;
    this._spin = 0;
    this._steerVis = 0;
    this._squash = 0;
    this._pump = 0;
    this._lean = 0;
    this._roll = 0;
    this._pitch = 0;
    this._yawOff = 0;
    this._build();
  }

  _build() {
    const d = this.detail;
    const n = d.ring;
    const P = this.palette;
    const flake = canvasTexture(flakeCanvas, 3, 3);

    // ---- materials ----
    const paint = new THREE.MeshStandardMaterial({
      color: this.color.clone(), metalness: 0.55, roughness: 0.28,
      roughnessMap: flake || null,
    });
    const shellMat = new THREE.MeshPhysicalMaterial({
      color: this.color.clone().lerp(new THREE.Color(0xffffff), 0.07),
      metalness: 0.55, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.05,
      transparent: true, opacity: 0.5, depthWrite: false,
    });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xdfe6f0, metalness: 0.92, roughness: 0.16 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x22262e, metalness: 0.7, roughness: 0.42 });
    const rubber = new THREE.MeshStandardMaterial({
      color: new THREE.Color(P.tire || DEFAULT_PALETTE.tire), metalness: 0.02, roughness: 0.88,
      map: canvasTexture(treadCanvas, 3, 1) || null,
    });
    const lightMat = new THREE.MeshStandardMaterial({
      color: 0x3a0a08, roughness: 0.3, metalness: 0.1,
      emissive: new THREE.Color(0xff2d16), emissiveIntensity: 1.6,
    });
    const needleMat = new THREE.MeshStandardMaterial({
      color: 0xff3b30, roughness: 0.35, metalness: 0.2,
      emissive: new THREE.Color(0xff3b30), emissiveIntensity: 1.4,
    });
    this.materials = [paint, shellMat, chrome, dark, rubber, lightMat, needleMat];

    // ---- painted body (one merged geometry, one draw call) ----
    const paintSrc = [
      tubGeometry(n), noseGeometry(n), podGeometry(n, POD_X),
      spoilerPlateGeometry(n), engineCoverGeometry(n), bumperGeometry(n),
    ];
    paintSrc.push(mirrorX(podGeometry(n, POD_X)));
    const paintGeo = mergeAll(paintSrc);
    disposeList(paintSrc);
    this.chassis = new THREE.Mesh(paintGeo, paint);
    this.chassis.castShadow = true;
    this.chassis.name = 'chassis';

    this.shell = new THREE.Mesh(paintGeo.clone(), shellMat);
    this.shell.scale.setScalar(1.018);
    this.shell.castShadow = false;
    this.shell.renderOrder = 2;
    this.shell.name = 'clearcoat';

    // ---- chrome trim ----
    const chromeSrc = [];
    const hoop = new THREE.TorusGeometry(0.34, 0.036, 8, 18, Math.PI);
    place(hoop, 0, 0.30, -0.80);
    chromeSrc.push(hoop);
    const column = new THREE.CylinderGeometry(0.022, 0.026, 0.30, 8);
    place(column, 0, 0.49, -0.39, 1.05, 0, 0);
    chromeSrc.push(column);
    const wheelRing = new THREE.TorusGeometry(0.145, 0.020, 6, 18);
    place(wheelRing, 0, 0.605, -0.435, 1.02, 0, 0);
    chromeSrc.push(wheelRing);
    const gauge = new THREE.CylinderGeometry(0.072, 0.072, 0.03, 14);
    place(gauge, 0, 0.535, -0.435, 1.15, 0, 0);
    chromeSrc.push(gauge);
    for (let s = -1; s <= 1; s += 2) {
      const stack = new THREE.CylinderGeometry(0.055, 0.062, 0.30, 12);
      place(stack, s * 0.225, 0.40, 0.80, -0.30, 0, 0);
      chromeSrc.push(stack);
      const strip = new THREE.BoxGeometry(0.16, 0.022, 0.66);
      place(strip, s * POD_X, 0.492, -0.02, 0.02, 0, 0);
      chromeSrc.push(strip);
      const stay = new THREE.BoxGeometry(0.045, 0.26, 0.055);
      place(stay, s * 0.42, 0.70, 0.735, -0.16, 0, 0);
      chromeSrc.push(stay);
      const bezel = new THREE.BoxGeometry(0.20, 0.10, 0.05);
      place(bezel, s * 0.325, 0.44, 0.955);
      chromeSrc.push(bezel);
      const grip = new THREE.BoxGeometry(0.035, 0.05, 0.05);
      place(grip, s * 0.145, 0.615, -0.455, 1.02, 0, 0);
      chromeSrc.push(grip);
    }
    const chromeGeo = mergeAll(chromeSrc);
    disposeList(chromeSrc);
    this.chrome = new THREE.Mesh(chromeGeo, chrome);
    this.chrome.castShadow = true;

    // ---- dark mechanical ----
    const darkSrc = [];
    for (let s = -1; s <= 1; s += 2) {
      const cyl = new THREE.CylinderGeometry(0.082, 0.082, 0.24, 12);
      place(cyl, s * 0.115, 0.50, 0.50, Math.PI / 2, 0, 0);
      darkSrc.push(cyl);
      for (let f = 0; f < 4; f++) {
        const fin = new THREE.BoxGeometry(0.02, 0.16, 0.03);
        place(fin, s * 0.115, 0.50, 0.40 + f * 0.06);
        darkSrc.push(fin);
      }
      const trumpet = new THREE.CylinderGeometry(0.032, 0.042, 0.17, 8);
      place(trumpet, s * 0.115, 0.65, 0.42, -0.45, 0, 0);
      darkSrc.push(trumpet);
    }
    const intake = new THREE.BoxGeometry(0.30, 0.10, 0.22);
    place(intake, 0, 0.62, 0.40);
    darkSrc.push(intake);
    const pan = new THREE.BoxGeometry(0.92, 0.05, 1.50);
    place(pan, 0, 0.145, 0.02);
    darkSrc.push(pan);
    const frame = new THREE.BoxGeometry(0.40, 0.06, 0.40);
    place(frame, 0, 0.345, 0.26);
    darkSrc.push(frame);
    const cushion = new THREE.BoxGeometry(0.42, 0.10, 0.44);
    place(cushion, 0, 0.425, 0.19);
    darkSrc.push(cushion);
    const backFrame = new THREE.BoxGeometry(0.40, 0.06, 0.42);
    place(backFrame, 0, 0.70, 0.26, -0.20, 0, 0);
    darkSrc.push(backFrame);
    const dash = new THREE.BoxGeometry(0.62, 0.09, 0.20);
    place(dash, 0, 0.525, -0.43, 0.35, 0, 0);
    darkSrc.push(dash);
    for (let s = -1; s <= 1; s += 2) {
      const endPlate = new THREE.BoxGeometry(0.03, 0.11, 0.36);
      place(endPlate, s * 0.565, 0.755, 0.70, -0.14, 0, 0);
      darkSrc.push(endPlate);
    }
    const darkGeo = mergeAll(darkSrc);
    disposeList(darkSrc);
    this.darkMesh = new THREE.Mesh(darkGeo, dark);
    this.darkMesh.castShadow = true;

    // ---- tail lights ----
    const lightSrc = [];
    for (let s = -1; s <= 1; s += 2) {
      const lamp = new THREE.BoxGeometry(0.13, 0.055, 0.04);
      place(lamp, s * 0.325, 0.44, 0.965);
      lightSrc.push(lamp);
    }
    const lightGeo = mergeAll(lightSrc);
    disposeList(lightSrc);
    this.lights = new THREE.Mesh(lightGeo, lightMat);
    this.lights.castShadow = false;

    // ---- rev counter needle ----
    this.needle = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.055, 0.012), needleMat);
    this.needle.position.set(0, 0.575, -0.442);
    this.needle.rotation.set(1.15, 0, 0);

    // ---- wheels ----
    this.wheels = [];
    const layout = [
      { x: -0.545, r: 0.325, w: 0.235, z: -0.545, front: true },
      { x: 0.545, r: 0.325, w: 0.235, z: -0.545, front: true },
      { x: -0.605, r: 0.375, w: 0.285, z: 0.560, front: false },
      { x: 0.605, r: 0.375, w: 0.285, z: 0.560, front: false },
    ];
    for (let i = 0; i < layout.length; i++) {
      const L = layout[i];
      const pivot = new THREE.Object3D();
      pivot.position.set(L.x, L.r, L.z);
      const spin = new THREE.Object3D();
      pivot.add(spin);
      const tyreGeo = new THREE.CylinderGeometry(L.r, L.r, L.w, d.wheel, 1, false);
      tyreGeo.rotateZ(Math.PI / 2);
      const tyre = new THREE.Mesh(tyreGeo, rubber);
      tyre.castShadow = true;
      tyre.receiveShadow = true;
      spin.add(tyre);
      const rimGeo = wheelGeometry(L.r, L.w, d.wheel, d.spokes);
      const rim = new THREE.Mesh(rimGeo, chrome);
      rim.castShadow = true;
      rim.receiveShadow = true;
      spin.add(rim);
      this.group.add(pivot);
      this.wheels.push({
        pivot, spin, isFront: L.front, radius: L.r, width: L.w,
        baseY: L.r, baseX: L.x, tyre, rim,
      });
    }

    // ---- contact shadow decal ----
    const blobTex = canvasTexture(blobCanvas, 1, 1);
    if (blobTex) {
      blobTex.wrapS = THREE.ClampToEdgeWrapping;
      blobTex.wrapT = THREE.ClampToEdgeWrapping;
      blobTex.repeat.set(1, 1);
    }
    this.blobMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false,
      map: blobTex || null,
    });
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.5), this.blobMat);
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.set(0, 0.014, 0.04);
    this.blob.renderOrder = 1;
    this.group.add(this.blob);

    // ---- body / squash hierarchy ----
    this.body = new THREE.Group();
    this.body.name = 'kartBody';
    this.body.rotation.order = 'YXZ';
    this.squash = new THREE.Group();
    this.squash.name = 'kartSquash';
    this.body.add(this.squash);
    this.squash.add(this.chassis);
    this.squash.add(this.darkMesh);
    this.squash.add(this.chrome);
    this.squash.add(this.lights);
    this.squash.add(this.needle);
    if (d.shell) this.squash.add(this.shell);
    this.driverRoot = new THREE.Group();
    this.driverRoot.position.set(0, 0.44, -0.02);
    this.squash.add(this.driverRoot);
    this.group.add(this.body);
    this._buildDriver();
  }

  _buildDriver() {
    if (this.driver) {
      this.driverRoot.remove(this.driver.root);
      this.driver.scarf.dispose();
      this.driver.root.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
          for (const m of mats) m.dispose();
        }
      });
    }
    this.driver = buildDriver(this.bodyType, this.palette, this.detail, this.rng);
    this.driver.root.scale.setScalar(this.scale);
    mergeDriverTree(this.driver.root);
    this.driverRoot.add(this.driver.root);
    this.driver.root.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
  }

  // ------------------------------------------------------------------ queries

  setColor(hex) {
    this.color.set(hex);
    this.materials[0].color.set(hex);
    this.shell.material.color.set(hex).lerp(new THREE.Color(0xffffff), 0.07);
  }

  setPalette(palette) {
    const prev = this.palette;
    const next = { ...prev, ...(palette || {}) };
    let changed = false;
    for (const k in next) if (next[k] !== prev[k]) changed = true;
    this.palette = next;
    this.setColor(next.primary || DEFAULT_PALETTE.primary);
    this.materials[4].color.set(next.tire || DEFAULT_PALETTE.tire);
    if (!changed) return;
    // Same silhouette, new colours: recolour in place. Rebuilding ~50 primitives
    // per kart mid-race-build is a visible hitch, and merged meshes share the
    // driver's materials, so one pass repaints the whole driver.
    this._recolorDriver(prev);
  }

  /** Swaps every driver material colour that matches the old palette. */
  _recolorDriver(prev) {
    const D = this.driver;
    if (!D || !D.root) return;
    const map = new Map();
    const tmp = new THREE.Color();
    for (const k of ['primary', 'secondary', 'accent', 'cap', 'skin', 'hair']) {
      if (!prev[k] || prev[k] === this.palette[k]) continue;
      map.set(tmp.set(prev[k]).getHex(), tmp.set(this.palette[k]).getHex());
    }
    if (!map.size) return;
    D.root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (!m || !m.color) continue;
        const hex = m.color.getHex();
        if (map.has(hex)) m.color.setHex(map.get(hex));
      }
    });
  }

  setBody(body) {
    if (DRIVER_BODIES.indexOf(body) < 0 || body === this.bodyType) return;
    this.bodyType = body;
    this._buildDriver();
  }

  /** Rescales the driver (CharacterDef.scale) without rebuilding anything. */
  setScale(scale) {
    const s = typeof scale === 'number' && scale > 0 ? scale : 1;
    this.scale = s;
    if (this.driver) this.driver.root.scale.setScalar(s);
  }

  // -------------------------------------------------------------------- pose

  /**
   * @param {number} dt
   * @param {{speed:number, steer:number, throttle:number, brake:number,
   *          yawRate:number, driftActive:boolean, driftDir:number,
   *          driftTier:number, boosting:boolean, squash:number, star:number,
   *          onGround:boolean, height:number, susp:number, bank:number,
   *          landImpact:number}} s
   */
  update(dt, s) {
    this.time += dt;
    const speed = s.speed || 0;
    const absSpeed = Math.abs(speed);
    const steer = s.steer || 0;
    const driftActive = !!s.driftActive;
    const driftDir = s.driftDir || 0;
    const onGround = s.onGround !== false;
    const wheels = this.wheels;

    // ---- wheels: roll, steer, drift slip, suspension ----
    this._spin += (speed / WHEEL_BASE_R) * dt;
    if (this._spin > TAU || this._spin < -TAU) this._spin %= TAU;
    this._steerVis = damp(this._steerVis, steer, 22, dt);
    const long = clamp(s.throttle - s.brake, -1, 1);
    const slipYaw = driftActive ? driftDir * 0.22 : 0;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      w.spin.rotation.x = this._spin * (WHEEL_BASE_R / w.radius);
      const steerAngle = w.isFront ? -this._steerVis * 0.42 : 0;
      w.pivot.rotation.y = steerAngle + slipYaw;
      // Outer wheels compress in a corner; the front under brakes, the rear on power.
      const outer = (i === 0 || i === 2 ? -1 : 1) * this._steerVis;
      const susp = (w.isFront ? long * 0.035 : -long * 0.045) +
        outer * 0.014 + (onGround ? 0 : -0.075);
      w.pivot.position.y = w.baseY + susp;
      w.pivot.rotation.z = w.isFront ? steerAngle * 0.18 : 0.06;
    }

    // ---- chassis: cornering roll, drift lean, squat, air pitch, banking ----
    const targetLean = driftActive ? driftDir * 0.16 : -steer * 0.06;
    const targetRoll = driftActive ? -driftDir * 0.19 : steer * 0.13;
    const targetYaw = driftActive ? -driftDir * 0.16 : 0;
    this._lean = damp(this._lean, targetLean, 10, dt);
    this._roll = damp(this._roll, targetRoll, 10, dt);
    this._yawOff = damp(this._yawOff, targetYaw, 10, dt);
    const squatPose = -long * 0.055;
    const airPitch = onGround ? 0 : clamp(-0.09 - speed * 0.0015, -0.24, -0.03);
    this._pitch = damp(this._pitch, squatPose + airPitch, 9, dt);
    this.body.rotation.set(this._pitch, this._yawOff, this._roll + (s.bank || 0) * 0.9);
    this.body.position.y = (s.susp || 0) * 0.9;

    // ---- squash & stretch ----
    const squashed = s.squash || 0;
    this._squash = damp(this._squash, squashed, 9, dt);
    const stretch = s.boosting ? 0.10 : 0;
    const land = (s.landImpact || 0) * 0.32;
    const sy = 1 - this._squash * 0.45 - land + stretch;
    const sxz = 1 + this._squash * 0.32 + land * 0.8 - stretch * 0.55;
    const starPulse = s.star > 0 ? Math.sin(this.time * 24) * 0.035 : 0;
    this.squash.scale.set(sxz * (1 + starPulse), sy * (1 - starPulse), sxz * (1 + starPulse));
    this.shell.scale.set(1.018 * sxz * (1 + starPulse), 1.018 * sy * (1 - starPulse), 1.018 * sxz * (1 + starPulse));

    // ---- gauge needle ----
    this.needle.rotation.z = -1.15 + clamp(absSpeed / 34, 0, 1.25) * 2.2;

    // ---- contact shadow: shrink + fade with height ----
    const h = Math.max(0, s.height || 0);
    this.blob.position.y = 0.014 - h;
    this.blob.scale.setScalar(1 + h * 0.16);
    this.blobMat.opacity = clamp(0.55 - h * 0.24, 0.03, 0.55);
    this.blob.visible = s.shadow !== false;

    // ---- driver ----
    const D = this.driver;
    this._pump = damp(this._pump, s.boosting ? 1 : 0, 7, dt);
    const pump = Math.sin(this.time * 15) * this._pump;
    const driftLean = driftActive ? -driftDir * 0.22 : 0;
    D.head.rotation.y = damp(D.head.rotation.y, -steer * 0.40 + driftDir * 0.20, 14, dt);
    D.head.rotation.z = damp(D.head.rotation.z, steer * 0.17 + driftLean, 14, dt);
    D.head.rotation.x = damp(D.head.rotation.x, -0.04 + (onGround ? 0 : -0.16), 12, dt);
    D.torso.rotation.z = damp(D.torso.rotation.z, this._lean + driftLean * 0.4, 11, dt);
    D.torso.rotation.x = damp(D.torso.rotation.x,
      this._pitch * 1.05 - 0.03 + (onGround ? 0 : -0.11), 11, dt);
    D.legs.rotation.x = damp(D.legs.rotation.x,
      (onGround ? 0 : -0.32) + long * 0.10, 11, dt);
    const wheelTurn = this._steerVis * 0.42;
    // Rest pose comes from the IK solve; steering swings the hands around the
    // rim and a boost pumps both fists.
    const rl = D.armL.rest;
    const rr = D.armR.rest;
    D.armL.shoulder.rotation.x = damp(D.armL.shoulder.rotation.x, rl.x - pump * 1.45, 14, dt);
    D.armR.shoulder.rotation.x = damp(D.armR.shoulder.rotation.x, rr.x + pump * 1.45, 14, dt);
    D.armL.shoulder.rotation.y = damp(D.armL.shoulder.rotation.y, rl.y, 14, dt);
    D.armR.shoulder.rotation.y = damp(D.armR.shoulder.rotation.y, rr.y, 14, dt);
    D.armL.shoulder.rotation.z = damp(D.armL.shoulder.rotation.z, rl.z - wheelTurn * 0.55, 14, dt);
    D.armR.shoulder.rotation.z = damp(D.armR.shoulder.rotation.z, rr.z - wheelTurn * 0.55, 14, dt);
    D.armL.elbow.rotation.x = damp(D.armL.elbow.rotation.x, rl.ex + pump * 1.1, 14, dt);
    D.armR.elbow.rotation.x = damp(D.armR.elbow.rotation.x, rr.ex + pump * 1.1, 14, dt);
    D.armL.elbow.rotation.y = damp(D.armL.elbow.rotation.y, rl.ey, 14, dt);
    D.armR.elbow.rotation.y = damp(D.armR.elbow.rotation.y, rr.ey, 14, dt);
    D.armL.elbow.rotation.z = damp(D.armL.elbow.rotation.z, rl.ez, 14, dt);
    D.armR.elbow.rotation.z = damp(D.armR.elbow.rotation.z, rr.ez, 14, dt);
    D.scarf.update(dt, speed, this.time, driftActive ? -driftDir : 0);
  }

  // ----------------------------------------------------------------- dispose

  dispose() {
    // Game.teardownRace() would normally clean material textures for anything
    // still hanging off raceRoot, but this runs first and takes the group with
    // it — so without the texture pass below every kart leaked its flake,
    // tread and contact-shadow canvas textures, three per kart, on every race.
    this.group.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh || o.isPoints || o.isLine) {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) disposeMaterial(m);
      }
    });
    disposeMaterial(this.blobMat);
    this.group.clear();
  }
}

export function createKartModel(opts) {
  return new KartModel(opts);
}

export { DETAIL as MODEL_DETAIL };
export default KartModel;
