/**
 * TrackBuilder — turns a TrackDef into the visible world: the tarmac ribbon,
 * kerbs, barriers, terrain skirt, start/finish gantry, checkpoints and the
 * resolved gameplay features (boost pads, jumps, hazards, item rows).
 *
 * Everything is merged into ~10 draw calls: one mesh per material batch plus
 * merged "structure" batches built with BufferGeometryUtils.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { CONFIG } from '../data/config.js';
import { TrackPath, CURB_WIDTH } from './TrackPath.js';
import { clamp, mulberry32, TAU } from '../core/MathUtils.js';

/** Lateral ring distances (metres past the tarmac edge) for the terrain skirt. */
const RINGS = [0, 2.6, 5, 8.5, 13, 19, 27, 37, 50, 66, 86, 112, 145, 185];
/** How far the barrier stands outside the tarmac. */
/**
 * How far past the tarmac edge the barrier geometry sits. It MUST match
 * CONFIG.physics.wallOffset, because that is where the physics clamps the kart:
 * a wall drawn inside the clamp lets a kart's body visibly drive through the
 * barrier before the invisible wall pushes it back.
 */
const WALL_OFFSET = CONFIG.physics.wallOffset;
/** Metres of track per tarmac texture tile. */
const TILE = 11;
/** Barrier height. */
const WALL_H = 1.6;

/* -------------------------------------------------------------------- utils */

function colorOf(hex, fallback = 0xffffff) {
  const v = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : hex;
  return new THREE.Color(Number.isFinite(v) ? v : fallback);
}

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d') };
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

/**
 * Accumulates an indexed mesh with position / uv / color. Every batch shares the
 * same attribute layout, so `mergeGeometries` can combine any of them.
 */
class Grid {
  constructor() {
    this.p = [];
    this.n = [];
    this.t = [];
    this.c = [];
    this.i = [];
  }
  vertex(x, y, z, u, v, r, g, b) {
    const k = this.p.length / 3;
    this.p.push(x, y, z);
    this.n.push(0, 1, 0);
    this.t.push(u, v);
    this.c.push(r, g, b);
    return k;
  }
  tri(a, b, c) {
    this.i.push(a, b, c);
  }
  /**
   * Quad between two contours. `a`,`b` sit on the near contour (b = a + cross
   * direction), `c`,`d` on the far one (d = a + forward). Un-flipped, the face
   * points along cross(crossDir, forward); pass `flip` to turn it around.
   */
  quad(a, b, c, d, flip) {
    if (flip) {
      this.tri(a, d, c);
      this.tri(a, c, b);
    } else {
      this.tri(a, c, d);
      this.tri(a, b, c);
    }
  }
  /** Quad strip between two contours that both run forward along the track. */
  strip(near, far, flip) {
    for (let k = 0; k < near.length - 1; k++) this.quad(near[k], near[k + 1], far[k + 1], far[k], flip);
  }
  /** Yawed box. Winding is auto-corrected against each face's outward normal. */
  box(cx, cy, cz, hx, hy, hz, yaw, col) {
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const corners = [];
    for (let i = 0; i < 8; i++) {
      const sx = i & 1 ? hx : -hx;
      const sy = i & 2 ? hy : -hy;
      const sz = i & 4 ? hz : -hz;
      corners.push([cx + sx * cs + sz * sn, cy + sy, cz - sx * sn + sz * cs]);
    }
    const faces = [
      [1, 0, 0, [1, 3, 7, 5]],
      [-1, 0, 0, [0, 4, 6, 2]],
      [0, 1, 0, [6, 7, 3, 2]],
      [0, -1, 0, [0, 1, 5, 4]],
      [0, 0, 1, [4, 5, 7, 6]],
      [0, 0, -1, [0, 2, 3, 1]],
    ];
    for (const [nx, ny, nz, f] of faces) {
      const v = f.map((k) => {
        const q = corners[k];
        return this.vertex(q[0], q[1], q[2], k & 1 ? 1 : 0, k & 2 ? 1 : 0, col.r, col.g, col.b);
      });
      const ax = this.p[v[1] * 3] - this.p[v[0] * 3];
      const ay = this.p[v[1] * 3 + 1] - this.p[v[0] * 3 + 1];
      const az = this.p[v[1] * 3 + 2] - this.p[v[0] * 3 + 2];
      const bx = this.p[v[2] * 3] - this.p[v[0] * 3];
      const by = this.p[v[2] * 3 + 1] - this.p[v[0] * 3 + 1];
      const bz = this.p[v[2] * 3 + 2] - this.p[v[0] * 3 + 2];
      const dot = (ay * bz - az * by) * nx + (az * bx - ax * bz) * ny + (ax * by - ay * bx) * nz;
      if (dot < 0) {
        this.tri(v[0], v[2], v[1]);
        this.tri(v[0], v[3], v[2]);
      } else {
        this.tri(v[0], v[1], v[2]);
        this.tri(v[0], v[2], v[3]);
      }
    }
  }
  get empty() {
    return this.i.length === 0;
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/* --------------------------------------------------------------- textures */

function asphaltTexture(theme) {
  const W = 1024;
  const H = 512;
  const { c, g } = canvas2d(W, H);
  const base = colorOf(theme.road, 0x3a3a40);
  const b = [base.r * 255, base.g * 255, base.b * 255];
  const rng = mulberry32(0x5eed1);
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 13000; i++) {
    const l = (rng() - 0.5) * 48;
    g.fillStyle = `rgba(${b[0] + l | 0},${b[1] + l | 0},${b[2] + l | 0},${0.2 + rng() * 0.5})`;
    g.fillRect(rng() * W, rng() * H, 1 + rng() * 2.4, 1 + rng() * 2.4);
  }
  for (let i = 0; i < 24; i++) {
    const l = (rng() - 0.45) * 26;
    g.fillStyle = `rgba(${b[0] + l | 0},${b[1] + l | 0},${b[2] + l | 0},0.15)`;
    g.beginPath();
    g.ellipse(rng() * W, rng() * H, 20 + rng() * 95, 30 + rng() * 130, rng() * TAU, 0, TAU);
    g.fill();
  }
  const wear = g.createLinearGradient(0, 0, W, 0);
  for (let s = 0; s <= 12; s++) {
    const t = s / 12;
    const l = Math.sin(t * Math.PI) * 11;
    wear.addColorStop(t, `rgba(${b[0] + l | 0},${b[1] + l | 0},${b[2] + l | 0},0.5)`);
  }
  g.fillStyle = wear;
  g.fillRect(W * 0.3, 0, W * 0.4, H);
  const edge = g.createLinearGradient(0, 0, W, 0);
  edge.addColorStop(0, 'rgba(0,0,0,0.45)');
  edge.addColorStop(0.1, 'rgba(0,0,0,0)');
  edge.addColorStop(0.9, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.fillStyle = edge;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(248,248,250,0.94)';
  g.fillRect(W * 0.017, 0, W * 0.013, H);
  g.fillRect(W * 0.97, 0, W * 0.013, H);
  for (const y of [0.06, 0.393, 0.726]) g.fillRect(W * 0.493, H * y, W * 0.014, H * 0.2);
  g.fillStyle = 'rgba(255,255,255,0.09)';
  g.fillRect(W * 0.262, 0, 3, H);
  g.fillRect(W * 0.733, 0, 3, H);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function roughnessTexture(theme) {
  const W = 512;
  const H = 256;
  const { c, g } = canvas2d(W, H);
  const rng = mulberry32(0x91a7);
  const r = ((theme.roadRough ?? 0.85) * 255) | 0;
  g.fillStyle = `rgb(${r},${r},${r})`;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) {
    const v = (0.6 + rng() * 0.4) * 255;
    g.fillStyle = `rgba(${v | 0},${v | 0},${v | 0},${0.1 + rng() * 0.25})`;
    g.fillRect(rng() * W, rng() * H, 1 + rng() * 3, 1 + rng() * 3);
  }
  const paint = 0.5 * 255;
  g.fillStyle = `rgba(${paint | 0},${paint | 0},${paint | 0},0.85)`;
  g.fillRect(W * 0.017, 0, W * 0.013, H);
  g.fillRect(W * 0.97, 0, W * 0.013, H);
  for (const y of [0.06, 0.393, 0.726]) g.fillRect(W * 0.493, H * y, W * 0.014, H * 0.2);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function checkerTexture() {
  const { c, g } = canvas2d(256, 64);
  const cw = 256 / 14;
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 14; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? '#f4f6fa' : '#101318';
      g.fillRect(x * cw, y * 32, cw + 1, 33);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function boostTexture(hue) {
  const { c, g } = canvas2d(256, 256);
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = 'rgba(8,10,20,0.8)';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3; i++) {
    const y = 20 + i * 78;
    g.beginPath();
    g.moveTo(18, y + 54);
    g.lineTo(128, y);
    g.lineTo(238, y);
    g.lineTo(238, y + 28);
    g.lineTo(128, y + 28);
    g.lineTo(18, y + 80);
    g.closePath();
    g.fillStyle = i % 2 === 0 ? hue : 'rgba(255,255,255,0.92)';
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function signTexture(text, sub, bg, fg) {
  const W = 1024;
  const H = 256;
  const { c, g } = canvas2d(W, H);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 8;
  g.strokeRect(6, 6, W - 12, H - 12);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'italic 900 104px system-ui, sans-serif';
  g.fillText(text, W / 2, H * 0.38, W - 70);
  g.font = '700 42px system-ui, sans-serif';
  g.fillText(sub, W / 2, H * 0.76, W - 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function groundTexture(theme) {
  const S = 256;
  const { c, g } = canvas2d(S, S);
  const a = colorOf(theme.terrain, 0x748a3c);
  const b = colorOf(theme.terrainAlt, 0x9aa04a);
  const rng = mulberry32(0x2f11);
  const tmp = new THREE.Color();
  g.fillStyle = `rgb(${a.r * 255 | 0},${a.g * 255 | 0},${a.b * 255 | 0})`;
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 2600; i++) {
    tmp.copy(a).lerp(b, rng());
    g.fillStyle = `rgba(${tmp.r * 255 | 0},${tmp.g * 255 | 0},${tmp.b * 255 | 0},${0.14 + rng() * 0.35})`;
    const w = 2 + rng() * 12;
    g.fillRect(rng() * S, rng() * S, w, w * (0.4 + rng()));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ----------------------------------------------------------- TrackBuilder */

export class TrackBuilder {
  /**
   * @param {object} ctx game context (worldRoot, scene, quality ...)
   * @param {object} def TrackDef
   * @param {TrackPath} [path] existing path instance
   */
  constructor(ctx, def, path) {
    this.ctx = ctx || {};
    this.def = def || {};
    this.path = path instanceof TrackPath ? path : new TrackPath(this.def);
    /** @type {TrackPath} the same instance other systems query */
    this.track = this.path;
    this.group = new THREE.Group();
    this.group.name = 'track';

    /** @type {number[]} ascending lap checkpoints in progress units */
    this.checkpoints = [];
    /** @type {{p:number,lateral:number,width:number,strength:number}[]} */
    this.boostPads = [];
    /** @type {{p:number,width:number,height:number}[]} */
    this.jumps = [];
    /** @type {{p:number,lateral:number,type:string}[]} */
    this.hazards = [];
    /** @type {{p:number,count:number,width:number}[]} */
    this.itemBoxRows = [];

    this._geos = [];
    this._mats = [];
    this._metal = new Grid();
    this._accent = new Grid();
    this._fr = makeFrame();
    this._fr2 = makeFrame();
    this._gap = new Set();
    this._ownPath = !(path instanceof TrackPath);
  }

  /** Builds the world and attaches it to ctx.worldRoot. */
  build() {
    const theme = this.def.theme || {};
    this._buildMaterials(theme);
    this._resolveFeatures();
    this._gap = this._gapSamples();

    this._buildRoad();
    this._buildCurbs();
    this._buildWalls();
    this._buildTerrain();
    this._buildStartLine();
    this._buildGantry();
    this._buildPads();
    this._buildRamps();
    this._buildBridges();
    this._flushStructures();

    const root = this.ctx.worldRoot || this.ctx.scene;
    if (root && root.add) root.add(this.group);
    this._measure();
    return this.group;
  }

  /* ---------------------------------------------------------- materials */

  _buildMaterials(theme) {
    const roadTex = asphaltTexture(theme);
    const roughTex = roughnessTexture(theme);
    this.roadMaterial = new THREE.MeshStandardMaterial({
      map: roadTex,
      roughnessMap: roughTex,
      roughness: 0.92,
      metalness: 0.05,
      envMapIntensity: 0.75,
    });
    this.curbMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.6,
      metalness: 0.03,
    });
    this.wallMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.06,
    });
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      map: groundTexture(theme),
      vertexColors: true,
      roughness: 0.97,
      metalness: 0,
    });
    this.accentMaterial = new THREE.MeshStandardMaterial({
      color: colorOf(theme.curbA, 0xe0322a),
      roughness: 0.5,
      metalness: 0.12,
    });
    this.metalMaterial = new THREE.MeshStandardMaterial({
      color: 0x9aa4b4,
      roughness: 0.33,
      metalness: 0.85,
    });
    this.lineMaterial = new THREE.MeshStandardMaterial({
      map: checkerTexture(),
      roughness: 0.55,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const neon = this.def.id === 'neon-harbour';
    const padTex = boostTexture(neon ? '#22e0ff' : '#ff9a1f');
    this.padMaterial = new THREE.MeshStandardMaterial({
      map: padTex,
      emissiveMap: padTex,
      emissive: new THREE.Color(neon ? 0x27c8ff : 0xff8c1a),
      emissiveIntensity: 1.4,
      transparent: true,
      roughness: 0.4,
      metalness: 0.1,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.rampMaterial = new THREE.MeshStandardMaterial({
      color: 0x4f5158,
      roughness: 0.78,
      metalness: 0.06,
    });
    this.bannerMaterial = new THREE.MeshStandardMaterial({
      map: signTexture(this.def.name || 'KART RUSH', (this.def.cup || 'STAR CUP').toUpperCase(), '#101830', '#ffd60a'),
      roughness: 0.72,
      metalness: 0.06,
      side: THREE.DoubleSide,
    });
    this._mats.push(
      this.roadMaterial,
      this.curbMaterial,
      this.wallMaterial,
      this.terrainMaterial,
      this.accentMaterial,
      this.metalMaterial,
      this.lineMaterial,
      this.padMaterial,
      this.rampMaterial,
      this.bannerMaterial
    );
  }

  /** One mesh per batch keeps the whole track at a handful of draw calls. */
  _mesh(grid, material, name) {
    if (!grid || grid.empty) return null;
    const geo = grid.geometry();
    this._geos.push(geo);
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    m.castShadow = name === 'walls' || name === 'curbs';
    m.receiveShadow = name !== 'pads';
    this.group.add(m);
    return m;
  }

  /** Merged structures (posts, beams, pylons) share two extra draw calls. */
  _flushStructures() {
    const batch = [];
    if (!this._metal.empty) batch.push([this._metal.geometry(), this.metalMaterial, 'structures']);
    if (!this._accent.empty) batch.push([this._accent.geometry(), this.accentMaterial, 'pylons']);
    if (batch.length > 1) {
      // Same attribute layout on every batch, so they can merge into one draw call.
      const merged = mergeGeometries(batch.map((b) => b[0]), false);
      if (merged) {
        merged.computeVertexNormals();
        merged.computeBoundingSphere();
        this._geos.push(merged);
        // Multi-material via groups keeps one geometry and two draws.
        merged.clearGroups();
        merged.addGroup(0, this._metal.i.length, 0);
        merged.addGroup(this._metal.i.length, this._accent.i.length, 1);
        const mats = [this.metalMaterial, this.accentMaterial];
        const m = new THREE.Mesh(merged, mats);
        m.name = 'structures';
        m.castShadow = true;
        this.group.add(m);
        this._metal = new Grid();
        this._accent = new Grid();
        return;
      }
    }
    for (const [geo, mat, name] of batch) {
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      this._geos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.castShadow = true;
      this.group.add(m);
    }
    this._metal = new Grid();
    this._accent = new Grid();
  }

  /* --------------------------------------------------------- road ribbon */

  _buildRoad() {
    const path = this.path;
    const N = path.sampleCount;
    const W = path.width;
    const grid = new Grid();
    const fr = this._fr;
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const s = i % N;
      if (this._gap.has(s)) {
        prev = null;
        continue;
      }
      path.sampleFrameAt(s, fr);
      const rl = Math.hypot(fr.right.x, fr.right.z) || 1;
      const rx = fr.right.x / rl;
      const rz = fr.right.z / rl;
      const v = (i * path.spacing) / TILE;
      const y = fr.position.y;
      const tb = Math.tan(fr.bank);
      const ring = [
        grid.vertex(fr.position.x - rx * W, y - W * tb, fr.position.z - rz * W, 0, v, 1, 1, 1),
        grid.vertex(fr.position.x + rx * W, y + W * tb, fr.position.z + rz * W, 1, v, 1, 1, 1),
      ];
      if (prev) grid.strip(prev, ring, false);
      prev = ring;
    }
    this._mesh(grid, this.roadMaterial, 'road');
  }

  /** Sample indices that fall inside a broken-bridge gap. */
  _gapSamples() {
    const set = new Set();
    const ravines = this.def.ravines;
    if (!Array.isArray(ravines)) return set;
    const N = this.path.sampleCount;
    for (const r of ravines) {
      if (!r || !r.gap) continue;
      const half = Math.max(1, +r.length || 1) * 0.5 / this.path.length;
      for (let i = 0; i < N; i++) {
        const d = i / N - (+r.p - half);
        if (d > 0 && d < half * 2) set.add(i);
      }
    }
    return set;
  }

  /* ---------------------------------------------------------------- kerbs */

  _buildCurbs() {
    const path = this.path;
    const N = path.sampleCount;
    const W = path.width;
    const A = colorOf(this.def.theme?.curbA, 0xe0322a);
    const B = colorOf(this.def.theme?.curbB, 0xf4f4f4);
    const prof = [
      [0, 0],
      [0.5, 0.055],
      [1.05, 0.1],
      [CURB_WIDTH, 0.12],
    ];
    const grid = new Grid();
    const fr = this._fr;
    for (const side of [-1, 1]) {
      let prev = null;
      for (let i = 0; i <= N; i++) {
        const s = i % N;
        if (this._gap.has(s)) {
          prev = null;
          continue;
        }
        path.sampleFrameAt(s, fr);
        const stripe = Math.floor((i * path.spacing) / 2.4) % 2 === 0 ? A : B;
        const rl = Math.hypot(fr.right.x, fr.right.z) || 1;
        const rx = fr.right.x / rl;
        const rz = fr.right.z / rl;
        const ring = [];
        for (let k = 0; k < prof.length; k++) {
          const lat = side * (W + prof[k][0]);
          ring.push(
            grid.vertex(
              fr.position.x + rx * lat,
              fr.position.y + lat * Math.tan(fr.bank) + prof[k][1],
              fr.position.z + rz * lat,
              k / (prof.length - 1),
              (i * path.spacing) / 2.4,
              stripe.r,
              stripe.g,
              stripe.b
            )
          );
        }
        if (prev) grid.strip(prev, ring, side < 0);
        prev = ring;
      }
    }
    this._mesh(grid, this.curbMaterial, 'curbs');
  }

  /* -------------------------------------------------------------- walls */

  _buildWalls() {
    const path = this.path;
    const N = path.sampleCount;
    const W = path.width;
    const A = colorOf(this.def.theme?.curbA, 0xe0322a);
    const B = new THREE.Color(0xf2f4f8);
    const base = W + WALL_OFFSET;
    const grid = new Grid();
    const fa = makeFrame();
    const fb = makeFrame();
    for (const side of [-1, 1]) {
      let run = -1;
      for (let i = 0; i <= N; i++) {
        const need = i < N && this._needsWall(i % N, side);
        if (need && run < 0) run = i;
        if (!need && run >= 0) {
          for (let k = run; k < i; k++) {
            path.sampleFrameAt(k % N, fa);
            path.sampleFrameAt((k + 1) % N, fb);
            const ra = Math.hypot(fa.right.x, fa.right.z) || 1;
            const rb = Math.hypot(fb.right.x, fb.right.z) || 1;
            const uax = (fa.right.x / ra) * side;
            const uaz = (fa.right.z / ra) * side;
            const ubx = (fb.right.x / rb) * side;
            const ubz = (fb.right.z / rb) * side;
            const ax = fa.position.x + uax * base;
            const az = fa.position.z + uaz * base;
            const ay = fa.position.y + base * side * Math.tan(fa.bank);
            const bx = fb.position.x + ubx * base;
            const bz = fb.position.z + ubz * base;
            const by = fb.position.y + base * side * Math.tan(fb.bank);
            const col = Math.floor((k * path.spacing) / 5) % 2 === 0 ? A : B;
            // vertical face: near contour runs upward, far contour runs forward
            grid.quad(
              grid.vertex(ax, ay, az, 0, 0, col.r, col.g, col.b),
              grid.vertex(ax, ay + WALL_H, az, 0, 1, col.r, col.g, col.b),
              grid.vertex(bx, by + WALL_H, bz, 1, 1, col.r, col.g, col.b),
              grid.vertex(bx, by, bz, 1, 0, col.r, col.g, col.b),
              side > 0
            );
            // cap along the top, running outward
            grid.quad(
              grid.vertex(ax, ay + WALL_H, az, 0, 0, B.r, B.g, B.b),
              grid.vertex(ax + uax * 0.5, ay + WALL_H + 0.02, az + uaz * 0.5, 1, 0, B.r, B.g, B.b),
              grid.vertex(bx + ubx * 0.5, by + WALL_H + 0.02, bz + ubz * 0.5, 1, 1, B.r, B.g, B.b),
              grid.vertex(bx, by + WALL_H, bz, 0, 1, B.r, B.g, B.b),
              side < 0
            );
          }
          run = -1;
        }
      }
    }
    this._mesh(grid, this.wallMaterial, 'walls');
  }

  /** Barriers where the ground falls away or another part of the track is close. */
  _needsWall(index, side) {
    const path = this.path;
    const W = path.width;
    const s = side === -1 ? -1 : 1;
    if (path.dropAt(index, 0, s) > 2.4) return true;
    if (path.dropAt(index, 4, s) > 5.5) return true;
    if (path.clearanceAt(index, W * 2 + 12)) return true;
    if (this._atRavine(index)) return true;
    return false;
  }

  _atRavine(index) {
    const ravines = this.def.ravines;
    if (!Array.isArray(ravines) || !ravines.length) return false;
    const p = index / this.path.sampleCount;
    for (const r of ravines) {
      if (!r || !r.depth) continue;
      const half = Math.max(1, +r.length || 1) * 0.5 / this.path.length;
      const d = ((p - (+r.p || 0) + 1.5) % 1) - 0.5;
      if (Math.abs(d) < half + 0.004) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ terrain */

  /**
   * Furthest ring (metres past the tarmac edge) whose point is still farther from
   * the centreline than its own lateral offset. As soon as some other part of the
   * circuit is closer than our own tarmac edge, the skirt stops, so it can never
   * swallow another section.
   */
  _extent(fr, dx, dz) {
    const path = this.path;
    const pos = path.samples.position;
    let best = 0;
    for (const d of RINGS) {
      if (d < 8) continue;
      // Past the local radius of curvature a lateral ring folds back on itself,
      // which would invert its faces, so stop well before that.
      if (d * Math.abs(fr.curvature) > 0.7) break;
      const x = fr.position.x + dx * d;
      const z = fr.position.z + dz * d;
      const j = path.nearestIndex(x, z);
      if (j < 0) continue; // far from everything; no other section to collide with
      const ddx = pos[j * 3] - x;
      const ddz = pos[j * 3 + 2] - z;
      if (Math.sqrt(ddx * ddx + ddz * ddz) < d - 4) break;
      best = d;
    }
    return best;
  }

  _buildTerrain() {
    const path = this.path;
    const N = path.sampleCount;
    const W = path.width;
    const prof = path._profile();
    const theme = this.def.theme || {};
    const grass = colorOf(theme.terrain, 0x748a3c);
    const rock = colorOf(theme.terrainAlt, 0x9aa04a);
    const detail = (x, z) => 0.86 + (Math.sin(x * 0.7) + Math.cos(z * 0.63)) * 0.06;
    const grid = new Grid();
    for (const side of [-1, 1]) {
      // ---- pass 1: frames and how far the skirt may reach -----------------
      const cx = new Float64Array(N + 1);
      const cz = new Float64Array(N + 1);
      const edge = new Float64Array(N + 1);
      const ext = new Float64Array(N + 1);
      const fr = this._fr;
      for (let i = 0; i <= N; i++) {
        const s = i % N;
        path.sampleFrameAt(s, fr);
        const rl = Math.hypot(fr.right.x, fr.right.z) || 1;
        cx[i] = (fr.right.x / rl) * side;
        cz[i] = (fr.right.z / rl) * side;
        edge[i] = fr.position.y + side * W * Math.tan(fr.bank);
        ext[i] = this._extent(fr, cx[i], cz[i]);
      }
      // min-filter so the reach can only change gradually around the lap
      for (let pass = 0; pass < 2; pass++) {
        const prev = Float64Array.from(ext);
        for (let i = 0; i <= N; i++) {
          const a = (i - 1 + N) % N;
          const b = (i + 1) % N;
          ext[i] = Math.min(prev[i], prev[a], prev[b]);
        }
      }
      // ---- pass 2: rings ------------------------------------------------
      const curtainBottom = [];
      const curtainTop = [];
      let prevRing = null;
      let prevLat = null;
      for (let i = 0; i <= N; i++) {
        const s = i % N;
        path.sampleFrameAt(s, fr);
        const dx = cx[i];
        const dz = cz[i];
        const edgeY = edge[i];
        const reach = ext[i];
        const ring = [];
        const lat = [];
        const lipLat = W - 0.6;
        const lipY = edgeY - 0.35;
        const lx = fr.position.x + dx * lipLat;
        const lz = fr.position.z + dz * lipLat;
        const dn = detail(lx, lz);
        ring.push(grid.vertex(lx, lipY, lz, lx / 12, lz / 12, grass.r * dn, grass.g * dn, grass.b * dn));
        lat.push(lipLat);
        const vLat = W + 0.2;
        const vx = fr.position.x + dx * vLat;
        const vz = fr.position.z + dz * vLat;
        ring.push(grid.vertex(vx, edgeY - 0.5, vz, vx / 12, vz / 12, grass.r, grass.g, grass.b));
        lat.push(vLat);
        const aLat = W + prof.apron;
        const aH = path.heightAtFrame(fr, side * aLat);
        const ax = fr.position.x + dx * aLat;
        const az2 = fr.position.z + dz * aLat;
        ring.push(grid.vertex(ax, aH, az2, ax / 12, az2 / 12, grass.r, grass.g, grass.b));
        lat.push(aLat);
        for (const d of RINGS) {
          // Clamp to this column's reach; rings past it collapse onto the lip
          // of the skirt and produce no faces (that edge is the cliff).
          const l = Math.min(W + prof.apron + d, W + prof.apron + reach);
          const x = fr.position.x + dx * l;
          const z = fr.position.z + dz * l;
          if (l === lat[lat.length - 1]) continue;
          const h = path.heightAtFrame(fr, side * l);
          if (l > W + prof.apron) {
            const slope = Math.abs(path.heightAtFrame(fr, side * (l + 7)) - h) / 7;
            const mix = clamp(slope * 0.5 + (Math.abs(h - prof.base) > 6 ? 0.2 : 0), 0, 1);
            const col = rock.clone().lerp(grass, 1 - mix);
            const dd = detail(x, z);
            ring.push(grid.vertex(x, h, z, x / 12, z / 12, col.r * dd, col.g * dd, col.b * dd));
          } else {
            ring.push(grid.vertex(x, h, z, x / 12, z / 12, grass.r, grass.g, grass.b));
          }
          lat.push(l);
        }
        if (prevRing) {
          const m = Math.min(prevRing.length, ring.length);
          for (let k = 0; k < m - 1; k++) {
            if (prevLat[k + 1] === prevLat[k] && lat[k + 1] === lat[k]) continue;
            grid.quad(prevRing[k], prevRing[k + 1], ring[k + 1], ring[k], side < 0);
          }
        }
        prevRing = ring;
        prevLat = lat;
        curtainBottom.push(grid.vertex(lx, lipY - 3.6, lz, 0, 1, grass.r * 0.7, grass.g * 0.7, grass.b * 0.7));
        curtainTop.push(grid.vertex(lx, lipY, lz, 0, 0, grass.r, grass.g, grass.b));
      }
      if (curtainBottom.length > 2) grid.strip(curtainBottom, curtainTop, side < 0);
    }
    this._buildFarGround(grid);
    this._mesh(grid, this.terrainMaterial, 'terrain');
  }

  /**
   * A low-resolution disc out to the horizon, driven by the same landscape
   * function as the skirt so the two match exactly where they meet, and dipped
   * below the road near the circuit so it never pokes through. Without it the
   * skirt's outer edge reads as a cliff against the sky.
   */
  _buildFarGround(grid) {
    const path = this.path;
    const b = path.bounds;
    const cx = (b.min[0] + b.max[0]) * 0.5;
    const cz = (b.min[2] + b.max[2]) * 0.5;
    const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]);
    const rings = [6, 26, 60, 110, 180, 280, 430, 640, 900, 1250, 1700];
    const segs = 72;
    const pos = path.samples.position;
    const dummy = new THREE.Vector3();
    let prev = null;
    for (const r of rings) {
      const ring = [];
      for (let a = 0; a <= segs; a++) {
        const th = (a / segs) * TAU;
        const x = cx + Math.cos(th) * r;
        const z = cz + Math.sin(th) * r;
        // how far is the nearest part of the circuit?
        const near = path.nearestIndex(x, z);
        // A -1 means "outside the hash reach", i.e. genuinely far from the
        // course. Taking pos[0] in that case put a constant 7 m below sample
        // 0's height into the far disc, so the horizon stopped following the
        // landscape and left a step at the terrain's outer edge.
        const known = near >= 0;
        const dx = known ? pos[near * 3] - x : 0;
        const dz = known ? pos[near * 3 + 2] - z : 0;
        const dist = known ? Math.sqrt(dx * dx + dz * dz) : Infinity;
        const bury = 3.4 * (1 - clamp(dist / Math.max(1, span * 0.9), 0, 1));
        // The disc has to sit below the ROAD as well as below the landscape.
        // The road is cut several metres down into the terrain, so burying a
        // fixed amount below landscapeHeight() alone left this disc lying on top
        // of the tarmac wherever the course descends — green over the circuit.
        // Taking the lower of the two and dropping below it makes that
        // geometrically impossible.
        const roadY = known ? pos[near * 3 + 1] - 7 : Infinity;
        const h = Math.min(path.landscapeHeight(x, z) - 0.45 - bury, roadY);
        dummy.set(x, h, z);
        ring.push(grid.vertex(x, h, z, x / 60, z / 60, 1, 1, 1));
      }
      if (prev) grid.strip(prev, ring, false);
      prev = ring;
    }
  }

  /* ------------------------------------------------------ start / finish */

  _buildStartLine() {
    const path = this.path;
    const W = path.width;
    path.frameAt(path.startLine, this._fr);
    path.frameAt(path.startLine + 2.6 / path.length, this._fr2);
    const grid = new Grid();
    const ring = (fr, uu) => {
      const rl = Math.hypot(fr.right.x, fr.right.z) || 1;
      const rx = fr.right.x / rl;
      const rz = fr.right.z / rl;
      return [
        grid.vertex(fr.position.x - rx * W, fr.position.y - W * Math.tan(fr.bank) + 0.03, fr.position.z - rz * W, 0, uu, 1, 1, 1),
        grid.vertex(fr.position.x + rx * W, fr.position.y + W * Math.tan(fr.bank) + 0.03, fr.position.z + rz * W, 1, uu, 1, 1, 1),
      ];
    };
    grid.strip(ring(this._fr, 0), ring(this._fr2, 1), false);
    this._mesh(grid, this.lineMaterial, 'startline');
  }

  _buildGantry() {
    const path = this.path;
    const W = path.width;
    const fr = path.frameAt(path.startLine, this._fr);
    const rl = Math.hypot(fr.right.x, fr.right.z) || 1;
    const rx = fr.right.x / rl;
    const rz = fr.right.z / rl;
    const yaw = Math.atan2(-fr.tangent.x, -fr.tangent.z);
    for (const side of [-1, 1]) {
      this._metal.box(fr.position.x + rx * side * (W + 2.3), fr.position.y + 3.1, fr.position.z + rz * side * (W + 2.3), 0.36, 3.1, 0.36, yaw, new THREE.Color(0x9aa4b4));
    }
    this._metal.box(fr.position.x, fr.position.y + 6.1, fr.position.z, (W + 2.5) * 2, 0.55, 0.3, yaw, new THREE.Color(0xd8dde6));
    const geo = new THREE.PlaneGeometry((W + 2.2) * 2, 2.1);
    this._geos.push(geo);
    const ban = new THREE.Mesh(geo, this.bannerMaterial);
    ban.position.set(fr.position.x, fr.position.y + 4.5, fr.position.z);
    ban.rotation.y = yaw;
    this.group.add(ban);
  }

  /* ------------------------------------------------------ features resolve */

  _resolveFeatures() {
    const def = this.def;
    const path = this.path;

    this.checkpoints = [];
    for (let i = 0; i < 12; i++) this.checkpoints.push((path.startLine + i / 12) % 1);
    this.checkpoints.sort((a, b) => a - b);

    this.boostPads = [];
    const pads = Array.isArray(def.boostPads) && def.boostPads.length ? def.boostPads : this._autoPads();
    for (const pad of pads) {
      this.boostPads.push({
        p: clamp(+pad.p || 0, 0, 0.999999),
        lateral: +pad.lateral || 0,
        width: +pad.width || 5.5,
        strength: +pad.strength || 1,
        key: 'pad' + this.boostPads.length,
      });
    }

    this.jumps = [];
    const jumps = Array.isArray(def.jumps) && def.jumps.length ? def.jumps : this._autoJumps();
    for (const j of jumps) {
      this.jumps.push({
        p: clamp(+j.p || 0, 0, 0.999999),
        width: +j.width || 8,
        height: +j.height || 5.6,
        key: 'jump' + this.jumps.length,
      });
    }

    this.hazards = [];
    const haz = Array.isArray(def.hazards) && def.hazards.length ? def.hazards : this._autoHazards();
    for (const h of haz) {
      this.hazards.push({
        p: clamp(+h.p || 0, 0, 0.999999),
        lateral: +h.lateral || 0,
        type: h.type === 'oil' || h.type === 'banana' ? h.type : 'cone',
      });
    }

    this.itemBoxRows = [];
    const rows = Array.isArray(def.itemBoxRows) && def.itemBoxRows.length ? def.itemBoxRows : this._autoRows();
    for (const r of rows) {
      this.itemBoxRows.push({
        p: clamp(+r.p || 0, 0, 0.999999),
        count: Math.max(1, +r.count || CONFIG.items.autoRowCount),
        width: +r.width || CONFIG.items.autoRowWidth,
      });
    }
  }

  /** Boost pads on the exits of the two slowest corners. */
  _autoPads() {
    const path = this.path;
    const N = path.sampleCount;
    const fr = makeFrame();
    const list = [];
    for (let i = 0; i < N; i += 4) {
      path.sampleFrameAt(i, fr);
      list.push([Math.abs(fr.curvature), (i + 30) % N]);
    }
    list.sort((a, b) => b[0] - a[0]);
    const out = [];
    for (const [, idx] of list) {
      const p = idx / N;
      if (out.length && Math.abs(out[out.length - 1].p - p) < 0.12) continue;
      out.push({ p, lateral: 0, width: 5.5, strength: 1 });
      if (out.length >= 2) break;
    }
    return out;
  }

  /** A crest jump just before the highest point of the lap. */
  _autoJumps() {
    const path = this.path;
    const fr = makeFrame();
    let hi = 0;
    let best = -Infinity;
    for (let i = 0; i < path.sampleCount; i += 3) {
      path.sampleFrameAt(i, fr);
      if (fr.position.y > best) {
        best = fr.position.y;
        hi = i;
      }
    }
    return [{ p: ((hi / path.sampleCount - 30 / path.length) + 1) % 1, width: 8, height: 5.6 }];
  }

  /** Cones and a banana scattered through the tightest corners. */
  _autoHazards() {
    const path = this.path;
    const fr = makeFrame();
    const cand = [];
    for (let i = 0; i < path.sampleCount; i += 2) {
      path.sampleFrameAt(i, fr);
      cand.push([Math.abs(fr.curvature), i / path.sampleCount]);
    }
    cand.sort((a, b) => b[0] - a[0]);
    const out = [];
    const used = [];
    for (const [c, p] of cand) {
      if (c < 1 / 110 || out.length >= 4) break;
      if (used.some((u) => Math.abs(u - p) < 0.1)) continue;
      used.push(p);
      const side = used.length % 2 === 0 ? 1 : -1;
      out.push({ p, lateral: side * (3.2 + used.length * 0.9), type: 'cone' });
    }
    if (used.length) out.push({ p: (used[0] + 0.005) % 1, lateral: used.length % 2 === 0 ? 4.6 : -4.6, type: 'banana' });
    return out;
  }

  /** Evenly spaced item rows, clear of the start line, pads and jumps. */
  _autoRows() {
    const path = this.path;
    const count = CONFIG.items.autoRows || 14;
    const rows = [];
    for (let i = 0; i < count; i++) {
      const p = (path.startLine + 0.04 + i / count) % 1;
      if (this._blocked(p)) continue;
      rows.push({ p, count: CONFIG.items.autoRowCount || 5, width: CONFIG.items.autoRowWidth || 9.5 });
    }
    return rows;
  }

  _blocked(p) {
    for (const x of this.boostPads) {
      const d = Math.abs(x.p - p);
      if (d < 0.022 || d > 0.978) return true;
    }
    for (const x of this.jumps) if (Math.abs(x.p - p) < 0.022) return true;
    for (const x of this.hazards) if (Math.abs(x.p - p) < 0.008) return true;
    return false;
  }

  /* ---------------------------------------------------------- boost pads */

  _buildPads() {
    if (!this.boostPads.length) return;
    const path = this.path;
    const grid = new Grid();
    const f0 = makeFrame();
    const f1 = makeFrame();
    for (const pad of this.boostPads) {
      const p0 = pad.p - 0.0015;
      const p1 = pad.p + pad.width / path.length;
      const half = Math.min(2.6, pad.width * 0.28);
      path.frameAt(p0, f0);
      path.frameAt(p1, f1);
      const ring = (fr, lat, u, uu) => {
        const rl = Math.hypot(fr.right.x, fr.right.z) || 1;
        return grid.vertex(
          fr.position.x + (fr.right.x / rl) * lat,
          fr.position.y + lat * Math.tan(fr.bank) + 0.055,
          fr.position.z + (fr.right.z / rl) * lat,
          u,
          uu,
          1,
          1,
          1
        );
      };
      grid.quad(
        ring(f0, pad.lateral - half, 0, 0),
        ring(f0, pad.lateral + half, 1, 0),
        ring(f1, pad.lateral + half, 1, 1),
        ring(f1, pad.lateral - half, 0, 1),
        false
      );
    }
    this._mesh(grid, this.padMaterial, 'pads');
  }

  /* ------------------------------------------------------ jump kickers */

  _buildRamps() {
    if (!this.jumps.length) return;
    const path = this.path;
    const W = path.width;
    const grid = new Grid();
    const fa = makeFrame();
    const fb = makeFrame();
    const ravines = Array.isArray(this.def.ravines) ? this.def.ravines : [];
    for (const j of this.jumps) {
      const rampLen = 7;
      const p0 = j.p - rampLen / path.length;
      const top = Math.min(1.05, j.height * 0.085);
      for (let i = 0; i < 6; i++) {
        const ha = (i / 6) ** 2 * top;
        const hb = ((i + 1) / 6) ** 2 * top;
        path.frameAt(p0 + (i / 6) * (rampLen / path.length), fa);
        path.frameAt(p0 + ((i + 1) / 6) * (rampLen / path.length), fb);
        const ring = (fr, lat, lift, u, uu) => {
          const rl = Math.hypot(fr.right.x, fr.right.z) || 1;
          return grid.vertex(
            fr.position.x + (fr.right.x / rl) * lat,
            fr.position.y + lat * Math.tan(fr.bank) + lift,
            fr.position.z + (fr.right.z / rl) * lat,
            u,
            uu,
            1,
            1,
            1
          );
        };
        grid.quad(
          ring(fa, -W, ha, 0, i / 6),
          ring(fa, W, ha, 1, i / 6),
          ring(fb, W, hb, 1, (i + 1) / 6),
          ring(fb, -W, hb, 0, (i + 1) / 6),
          false
        );
      }
      const ravine = ravines.find((r) => r && r.gap && Math.abs((+r.p || 0) - j.p) < 0.03);
      if (ravine) {
        const fr = path.frameAt(j.p - 0.0012, this._fr);
        for (const side of [-1, 1]) {
          const rl = Math.hypot(fr.right.x, fr.right.z) || 1;
          const lat = side * (W + 0.45);
          this._metal.box(
            fr.position.x + (fr.right.x / rl) * lat,
            fr.position.y + lat * Math.tan(fr.bank) + 0.75,
            fr.position.z + (fr.right.z / rl) * lat,
            0.16,
            0.75,
            0.16,
            0,
            new THREE.Color(0xd8dde6)
          );
        }
      }
    }
    this._mesh(grid, this.rampMaterial, 'ramps');
  }

  /* ---------------------------------------------------------- bridges */

  /** Railings and support pylons wherever a ravine cuts the causeway. */
  _buildBridges() {
    const ravines = Array.isArray(this.def.ravines) ? this.def.ravines : [];
    if (!ravines.length) return;
    const path = this.path;
    const W = path.width;
    const rail = new THREE.Color(0xd8dde6);
    const pylon = new THREE.Color(0x8a3a34);
    const fr = this._fr;
    for (const r of ravines) {
      const len = Math.max(2, +r.length || 2);
      const p0 = (+r.p || 0) - len * 0.5 / path.length;
      const p1 = (+r.p || 0) + len * 0.5 / path.length;
      const posts = Math.max(3, Math.round(len / 2.6));
      for (const side of [-1, 1]) {
        const lat = side * (W + WALL_OFFSET);
        for (let i = 0; i <= posts; i++) {
          path.frameAt(p0 + ((p1 - p0) * i) / posts, fr);
          const rl = Math.hypot(fr.right.x, fr.right.z) || 1;
          this._metal.box(
            fr.position.x + (fr.right.x / rl) * lat,
            fr.position.y + lat * Math.tan(fr.bank) + 0.5,
            fr.position.z + (fr.right.z / rl) * lat,
            0.09,
            0.5,
            0.09,
            0,
            rail
          );
        }
      }
      const pierLat = W + (path._profile().apron || 3) + 5;
      for (const side of [-1, 1]) {
        for (const f of [0.22, 0.78]) {
          path.frameAt(p0 + (p1 - p0) * f, fr);
          const rl = Math.hypot(fr.right.x, fr.right.z) || 1;
          const lat = side * pierLat;
          const x = fr.position.x + (fr.right.x / rl) * lat;
          const z = fr.position.z + (fr.right.z / rl) * lat;
          const y = fr.position.y + lat * Math.tan(fr.bank);
          const ground = path.surfaceHeight(x, z);
          const h = y + 0.4 - ground;
          if (h < 1.2) continue;
          this._accent.box(x, ground + h * 0.5, z, 0.8, h * 0.5, 0.7, 0, pylon);
        }
      }
    }
  }

  /* ------------------------------------------------------------ metrics */

  _measure() {
    let tris = 0;
    let meshes = 0;
    this.group.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const idx = o.geometry?.getIndex?.();
      tris += (idx ? idx.count : o.geometry?.getAttribute?.('position')?.count || 0) / 3;
    });
    this.drawCalls = meshes;
    this.triangles = tris;
  }

  dispose() {
    for (const g of this._geos) g.dispose?.();
    this._geos.length = 0;
    for (const m of this._mats) {
      for (const k in m) {
        const v = m[k];
        if (v && v.isTexture) v.dispose?.();
      }
      m.dispose?.();
    }
    this._mats.length = 0;
    if (this._ownPath) this.path.dispose?.();
    this.group.removeFromParent?.();
    this.group.clear();
  }
}

export default TrackBuilder;
