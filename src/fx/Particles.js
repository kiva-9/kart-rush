/**
 * Particles — the feel layer's voxel budget.
 *
 * One pooled, GPU-friendly system covering every effect type in contract section 3:
 * a handful of `THREE.Points` pools (one per texture/blend family) driven by a
 * custom `ShaderMaterial` (soft round sprite, size attenuation, per-particle
 * colour ramp, alpha fade, rotation, scene fog), plus a pooled instanced decal
 * mesh for skid marks - which is what actually makes a drift *read* on the road.
 *
 * Everything lives in typed arrays. The only geometry is a single interleaved
 * buffer per pool, allocated once here; per frame we upload just the live range
 * of each pool through `InterleavedBuffer.addUpdateRange()`, so a pool with 30
 * live particles costs 30 quads, not a capacity-sized re-upload.
 *
 * Ownership: src/fx/Particles.js (FX pass). See docs/CONTRACT.md section 10.
 */
import * as THREE from 'three';

import { CONFIG } from '../data/config.js';
import { clamp, lerp, mulberry32, TAU } from '../core/MathUtils.js';
import { MODES } from '../core/Store.js';

/* -------------------------------------------------------------------------- */
/* layout                                                                     */
/* -------------------------------------------------------------------------- */

/** floats per particle in the interleaved GPU buffer: pos(3) colour(3) size, alpha, rot. */
const STRIDE = 9;
/** floats per particle in the CPU-side simulation block. */
const PS = 24;

const S = {
  vx: 0, vy: 1, vz: 2,
  c0r: 3, c0g: 4, c0b: 5,
  c1r: 6, c1g: 7, c1b: 8,
  size0: 9, size1: 10,
  alpha: 11, rot: 12, rotV: 13,
  life: 14, lmax: 15,
  drag: 16, grav: 17, turb: 18, phase: 19, flutter: 20, ground: 21,
  fadeIn: 22, fadePow: 23,
};

/** Sentinel meaning "no ground clamp" (particles that may leave the road). */
const NO_GROUND = -1e9;

const QUALITY_SCALE = { low: 0.34, medium: 0.66, high: 1, ultra: 1.25 };

/** Design-system palette (src/styles/main.css), kept as numbers for the GPU. */
const COL = {
  white: 0xffffff,
  ember: 0xffb347,
  tier0: 0xffd60a,
  tier1: 0xff9500,
  tier2: 0x32d6ff,
  tier3: 0xaf52de,
  smoke: 0xdfe6f2,
  smokeDim: 0x8f9aae,
  dust: 0xd8b98a,
  dustOff: 0xa8854f,
  flame: 0x6fd0ff,
  flameCore: 0xeaf9ff,
  goldHot: 0xffe27a,
  coin: 0xffc531,
  banana: 0xe8d15a,
  ink: 0x272b48,
  rubber: 0x14161f,
  rainbow: [0xff3b30, 0xff9500, 0xffd60a, 0x34c759, 0x32d6ff, 0x0a84ff, 0xaf52de, 0xff2d95],
  bright: [0xffd60a, 0x32d6ff, 0xff2d95, 0x2ae0a8, 0xffffff, 0xff9500],
};

/* -------------------------------------------------------------------------- */
/* procedural canvas textures - zero external assets                          */
/* -------------------------------------------------------------------------- */

function ctx2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d') };
}

function finish(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/**
 * Irregular puff: a soft lobe blob masked by a radial falloff, so smoke is
 * never a suspiciously perfect circle.
 */
function smokeTexture(size = 128) {
  const { c, g } = ctx2d(size, size);
  const rng = mulberry32(1701);
  g.clearRect(0, 0, size, size);
  g.globalCompositeOperation = 'lighter';
  const base = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.5);
  base.addColorStop(0, 'rgba(255,255,255,0.85)');
  base.addColorStop(0.55, 'rgba(255,255,255,0.42)');
  base.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 11; i++) {
    const a = rng() * TAU;
    const r = rng() * size * 0.15;
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r;
    const rad = size * (0.14 + rng() * 0.2);
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(255,255,255,0.30)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, rad, 0, TAU);
    g.fill();
  }
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.5);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.6, 'rgba(255,255,255,0.78)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = mask;
  g.fillRect(0, 0, size, size);
  return finish(c);
}

/** Hot core plus four spikes - the classic arcade-racer spark flare. */
function sparkTexture(size = 128) {
  const { c, g } = ctx2d(size, size);
  const cx = size / 2;
  g.clearRect(0, 0, size, size);
  g.globalCompositeOperation = 'lighter';
  const core = g.createRadialGradient(cx, cx, 0, cx, cx, size * 0.34);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core;
  g.beginPath();
  g.arc(cx, cx, size * 0.34, 0, TAU);
  g.fill();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    const len = size * (0.46 + (i % 2) * 0.05);
    const wide = size * 0.045;
    const grd = g.createLinearGradient(cx, cx, cx + Math.cos(a) * len, cx + Math.sin(a) * len);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.32)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.save();
    g.translate(cx, cx);
    g.rotate(a);
    g.beginPath();
    g.moveTo(0, -wide);
    g.lineTo(len, 0);
    g.lineTo(0, wide);
    g.closePath();
    g.fill();
    g.restore();
  }
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(cx, cx, 0, cx, cx, size * 0.5);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.75, 'rgba(255,255,255,0.5)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = mask;
  g.fillRect(0, 0, size, size);
  return finish(c);
}

/** Wide, low-contrast falloff for exhaust flames, glows and flashes. */
function glowTexture(size = 128) {
  const { c, g } = ctx2d(size, size);
  const cx = size / 2;
  g.clearRect(0, 0, size, size);
  const gr = g.createRadialGradient(cx, cx, 0, cx, cx, size * 0.5);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.12, 'rgba(255,255,255,0.88)');
  gr.addColorStop(0.32, 'rgba(255,255,255,0.4)');
  gr.addColorStop(0.62, 'rgba(255,255,255,0.11)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  return finish(c);
}

/** Thin annulus, used as a billboarded shockwave. */
function ringTexture(size = 128) {
  const { c, g } = ctx2d(size, size);
  const cx = size / 2;
  g.clearRect(0, 0, size, size);
  const gr = g.createRadialGradient(cx, cx, 0, cx, cx, size * 0.5);
  gr.addColorStop(0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0)');
  gr.addColorStop(0.78, 'rgba(255,255,255,0.5)');
  gr.addColorStop(0.88, 'rgba(255,255,255,1)');
  gr.addColorStop(0.96, 'rgba(255,255,255,0.3)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  return finish(c);
}

/** Five-point star, for coins, star-power sparkles and finish-line flourishes. */
function starTexture(size = 128) {
  const { c, g } = ctx2d(size, size);
  const cx = size / 2;
  g.clearRect(0, 0, size, size);
  const spikes = 5;
  const outer = size * 0.46;
  const inner = size * 0.19;
  g.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (spikes * 2)) * TAU - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cx + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  const gr = g.createRadialGradient(cx, cx, 0, cx, cx, outer);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.45, 'rgba(255,255,255,0.9)');
  gr.addColorStop(1, 'rgba(255,255,255,0.5)');
  g.fillStyle = gr;
  g.fill();
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(cx, cx, 0, cx, cx, size * 0.5);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(0.72, 'rgba(255,255,255,0.66)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = mask;
  g.fillRect(0, 0, size, size);
  return finish(c);
}

/** Small rounded rectangle - the confetti paper flake. */
function flakeTexture(w = 64, h = 48) {
  const { c, g } = ctx2d(w, h);
  g.clearRect(0, 0, w, h);
  const r = Math.min(w, h) * 0.22;
  g.beginPath();
  g.moveTo(r, 0);
  g.lineTo(w - r, 0);
  g.quadraticCurveTo(w, 0, w, r);
  g.lineTo(w, h - r);
  g.quadraticCurveTo(w, h, w - r, h);
  g.lineTo(r, h);
  g.quadraticCurveTo(0, h, 0, h - r);
  g.lineTo(0, r);
  g.quadraticCurveTo(0, 0, r, 0);
  g.closePath();
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.86)');
  gr.addColorStop(1, 'rgba(255,255,255,0.68)');
  g.fillStyle = gr;
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.fillRect(w * 0.16, h * 0.2, w * 0.2, h * 0.16);
  return finish(c);
}

/** Two parallel soft streaks - a pair of tyre marks in one decal. */
function smudgeTexture(w = 256, h = 128) {
  const { c, g } = ctx2d(w, h);
  g.clearRect(0, 0, w, h);
  g.globalCompositeOperation = 'lighter';
  const tread = (cx, cy, rx, ry, alpha) => {
    g.save();
    g.translate(cx, cy);
    g.scale(1, ry / rx);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    gr.addColorStop(0, 'rgba(255,255,255,' + alpha + ')');
    gr.addColorStop(0.55, 'rgba(255,255,255,' + (alpha * 0.65).toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(0, 0, rx, 0, TAU);
    g.fill();
    g.restore();
  };
  tread(w * 0.5, h * 0.34, w * 0.44, h * 0.2, 0.85);
  tread(w * 0.5, h * 0.66, w * 0.44, h * 0.2, 0.85);
  const rng = mulberry32(97);
  for (let i = 0; i < 7; i++) {
    const x = rng() * w;
    const y = h * (rng() < 0.5 ? 0.34 : 0.66);
    tread(x, y, w * 0.05, h * 0.06, 0.45);
  }
  g.globalCompositeOperation = 'destination-in';
  const win = g.createLinearGradient(0, 0, w, 0);
  win.addColorStop(0, 'rgba(255,255,255,0)');
  win.addColorStop(0.12, 'rgba(255,255,255,0.9)');
  win.addColorStop(0.5, 'rgba(255,255,255,1)');
  win.addColorStop(0.88, 'rgba(255,255,255,0.9)');
  win.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = win;
  g.fillRect(0, 0, w, h);
  return finish(c);
}

/* -------------------------------------------------------------------------- */
/* shaders                                                                    */
/* -------------------------------------------------------------------------- */

const PARTICLE_VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec3 aParams;

uniform float uScale;
uniform float uMaxSize;

varying vec3 vColor;
varying float vAlpha;
varying float vRot;

#include <common>
#include <fog_pars_vertex>

void main() {
  vColor = aColor;
  vAlpha = aParams.y;
  vRot = aParams.z;

  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  float dist = max( 0.001, -mvPosition.z );
  // fade out just in front of the lens so no sprite ever slaps the screen
  vAlpha *= smoothstep( 0.30, 1.5, dist );
  gl_PointSize = clamp( aParams.x * uScale / dist, 0.7, uMaxSize );
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
`;

const PARTICLE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uGain;

varying vec3 vColor;
varying float vAlpha;
varying float vRot;

#include <common>
#include <fog_pars_fragment>

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float s = sin( vRot );
  float c = cos( vRot );
  uv = vec2( uv.x * c - uv.y * s, uv.x * s + uv.y * c ) + 0.5;

  vec4 tex = texture2D( uMap, uv );
  float a = tex.a * vAlpha;
  if ( a <= 0.004 ) discard;

  // a hot core keeps additive sparks from looking like flat stickers
  vec3 col = vColor * ( 0.80 + 0.45 * tex.a ) + vColor * pow( tex.a, 8.0 ) * 0.9;
  col *= uGain;

  gl_FragColor = vec4( col, a );

  #include <fog_fragment>
}
`;

/* -------------------------------------------------------------------------- */
/* pool                                                                       */
/* -------------------------------------------------------------------------- */

class Pool {
  constructor(spec, texture) {
    this.name = spec.name;
    this.max = spec.capacity;
    this.n = 0;

    this.data = new Float32Array(this.max * STRIDE);
    this.ib = new THREE.InterleavedBuffer(this.data, STRIDE);
    this.ib.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.InterleavedBufferAttribute(this.ib, 3, 0));
    geo.setAttribute('aColor', new THREE.InterleavedBufferAttribute(this.ib, 3, 3));
    geo.setAttribute('aParams', new THREE.InterleavedBufferAttribute(this.ib, 3, 6));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uScale: { value: 900 },
        uMaxSize: { value: 700 },
        uGain: { value: spec.gain != null ? spec.gain : 1 },
        fogColor: { value: new THREE.Color(0xffffff) },
        fogNear: { value: 1 },
        fogFar: { value: 2000 },
        fogDensity: { value: 0.00025 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: spec.blending,
      fog: true,
    });
    // The sprite lives in `uniforms.uMap`, which Game.teardownRace()'s material
    // sweep does not look inside. Mirroring it under a name three never reads
    // makes that sweep free the texture too, so a race teardown costs nothing.
    this.material.mapTexture = texture;

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.renderOrder = spec.renderOrder;
    this.points.name = 'fx-particles-' + spec.name;

    // CPU simulation state; one contiguous block so a slot swap is a memmove.
    this.st = new Float32Array(this.max * PS);
  }

  alloc() {
    if (this.n >= this.max) return -1;
    return this.n++;
  }

  kill(i) {
    const last = this.n - 1;
    if (i !== last) {
      this.st.copyWithin(i * PS, last * PS, (last + 1) * PS);
      this.data.copyWithin(i * STRIDE, last * STRIDE, (last + 1) * STRIDE);
    }
    this.n = last;
  }

  clear() {
    this.n = 0;
    this.geo.setDrawRange(0, 0);
  }

  /** Uploads just the live range - a mostly empty pool costs almost nothing. */
  flush() {
    if (this.n > 0) {
      this.ib.addUpdateRange(0, this.n * STRIDE);
      this.ib.needsUpdate = true;
      this.geo.setDrawRange(0, this.n);
    }
  }

  get geo() {
    return this.points.geometry;
  }

  dispose() {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.material.dispose();
    this.st = null;
    this.data = null;
  }
}

/* -------------------------------------------------------------------------- */
/* effect table                                                               */
/* -------------------------------------------------------------------------- */

/** Drift sparks escalate in colour with the mini-turbo tier. */
const TIER_COLOURS = [COL.tier0, COL.tier1, COL.tier2, COL.tier3];

const FX = {
  /* ---------------------------------------------------------------- drift -- */
  driftSpark: {
    pool: 'spark', count: 2,
    life: [0.16, 0.34], size: [0.15, 0.27], endSize: [0.1, 0.2],
    speed: [2.5, 6.5], drag: 3, grav: 11, turb: 3, spin: [-14, 14],
    alpha: 1, fadePow: 1.1,
    colors: (o) => TIER_COLOURS[clamp(o.tier | 0, 0, 3)],
    colEnd: COL.white,
    vel: 'inherit', inherit: 0.25, axis: 'back', spread: 1.15,
    jitter: 0.3, ground: 0.07,
  },
  driftSmoke: {
    pool: 'smoke', count: 3,
    life: [0.42, 0.78], size: [0.5, 0.85], endSize: [2, 2.8],
    speed: [0.6, 2], drag: 1.6, grav: -0.7, turb: 0.9,
    alpha: 0.4, fadeIn: 0.1, fadePow: 1.2,
    colors: (o) => (o.tier > 0 ? 0xf2ecff : COL.smoke),
    colEnd: 0x6f7893,
    vel: 'inherit', inherit: 0.08, axis: 'back', spread: 0.7,
    jitter: 0.34, ground: 0.05,
  },
  dust: {
    pool: 'smoke', count: 5,
    life: [0.5, 1.1], size: [0.34, 0.72], endSize: [2.2, 3.4],
    speed: [1.6, 4.2], drag: 2.2, grav: 2.4, turb: 3.6,
    alpha: 0.5, fadeIn: 0.06, fadePow: 1.3,
    colors: COL.dust, colEnd: COL.dustOff,
    vel: 'inherit', inherit: 0.12, axis: 'back', spread: 1,
    jitter: 0.4, ground: 0.05,
  },
  skid: { decal: true, count: 2 },

  /* ---------------------------------------------------------------- boost -- */
  boostFlame: {
    pool: 'glow', count: 4,
    life: [0.1, 0.22], size: [0.45, 0.9], endSize: [0.3, 0.6],
    speed: [1, 3], drag: 4.2, grav: 1, turb: 1.5,
    alpha: 0.9, fadePow: 1.4,
    colors: (o) => (o.kind === 'mushroom' || o.kind === 'star' ? COL.ember : COL.flame),
    colEnd: COL.flameCore,
    vel: 'inherit', inherit: 0.42, axis: 'back', spread: 0.35,
    jitter: 0.1, ground: 0.05,
    also: [{ type: 'boostEmber', scale: 0.45 }],
  },
  boostEmber: {
    pool: 'spark', count: 2,
    life: [0.28, 0.66], size: [0.1, 0.2], endSize: [0.04, 0.08],
    speed: [2, 6], drag: 1.6, grav: 10, turb: 4,
    alpha: 1, fadePow: 1.2,
    colors: (o) => (o.kind === 'mushroom' ? COL.ember : COL.flameCore),
    colEnd: COL.ember,
    vel: 'inherit', inherit: 0.3, axis: 'back', spread: 0.9,
    jitter: 0.12, ground: 0.05,
  },
  boostPadSpark: {
    pool: 'spark', count: 14,
    life: [0.2, 0.46], size: [0.24, 0.5], endSize: [0.05, 0.15],
    speed: [3, 9.5], drag: 2.6, grav: 6, turb: 3,
    alpha: 1, fadePow: 1.2, spin: [-16, 16],
    colors: [COL.flameCore, COL.flame, COL.tier2], colEnd: COL.white,
    vel: 'spawn', axis: 'up', spread: 0.45,
    jitter: 1.4, ground: 0.04,
    also: [{ type: 'shockWave', scale: 1 }],
  },

  /* ----------------------------------------------------------------- misc -- */
  starSparkle: {
    pool: 'spark', count: 4,
    life: [0.28, 0.62], size: [0.26, 0.56], endSize: [0.08, 0.18],
    speed: [1.2, 4], drag: 2.4, grav: -1.2, turb: 2,
    alpha: 1, fadePow: 1.3, spin: [-20, 20],
    colors: COL.rainbow, colEnd: COL.white,
    vel: 'radial',
    jitter: 1.5, ground: 0.1,
  },
  spinDust: {
    pool: 'smoke', count: 12,
    life: [0.5, 0.95], size: [0.45, 0.9], endSize: [2.4, 3.4],
    speed: [3, 6.5], drag: 1.4, grav: 1.6, turb: 2.6,
    alpha: 0.55, fadeIn: 0.08, fadePow: 1.4,
    colors: [COL.smoke, COL.dust], colEnd: COL.smokeDim,
    vel: 'swirl', inherit: 0.1,
    jitter: 0.9, ground: 0.06,
  },
  landPuff: {
    pool: 'smoke', count: 10,
    life: [0.4, 0.85], size: [0.4, 0.8], endSize: [2.4, 3.4],
    speed: [2.4, 5.6], drag: 2.4, grav: 1.4, turb: 1.4,
    alpha: 0.45, fadeIn: 0.08, fadePow: 1.3,
    colors: [COL.dust, COL.smoke], colEnd: COL.smokeDim,
    vel: 'flat',
    jitter: 0.5, ground: 0.05,
    also: [{ type: 'shockWave', scale: 0.8 }],
  },
  confetti: {
    pool: 'flake', count: 34,
    life: [2.2, 3.6], size: [0.22, 0.44], endSize: [1, 1],
    speed: [1.4, 4], drag: 0.9, grav: 5.4, flutter: 3.2, spin: [-9, 9],
    alpha: 0.95, fadeIn: 0.03, fadePow: 1,
    colors: COL.rainbow,
    vel: 'inherit', inherit: 0.2, axis: 'up', spread: 1.2,
    jitter: 7,
  },
  shellTrail: {
    pool: 'glow', count: 3,
    life: [0.16, 0.36], size: [0.28, 0.56], endSize: [0.1, 0.2],
    speed: [0.4, 1.6], drag: 3, grav: 0.4, turb: 1.2,
    alpha: 0.8, fadePow: 1.3,
    colors: (o) => (o.color != null ? o.color : COL.flame), colEnd: COL.white,
    vel: 'inherit', inherit: 0.3, axis: 'vel', spread: 0.5,
    jitter: 0.14, ground: 0.12,
    also: [{ type: 'shellTrailSpark', scale: 0.4 }],
  },
  shellTrailSpark: {
    pool: 'spark', count: 1,
    life: [0.14, 0.3], size: [0.12, 0.24], endSize: [0.05, 0.1],
    speed: [0.6, 2.4], drag: 3, grav: 3,
    alpha: 0.9, fadePow: 1.4, spin: [-12, 12],
    colors: (o) => (o.color != null ? o.color : COL.white), colEnd: COL.white,
    vel: 'inherit', inherit: 0.25, axis: 'vel', spread: 1,
    jitter: 0.2, ground: 0.12,
  },
  bananaTrail: {
    pool: 'smoke', count: 1,
    life: [0.4, 0.8], size: [0.2, 0.4], endSize: [1.6, 2.2],
    speed: [0.3, 1.2], drag: 2, grav: 0.6, turb: 0.6,
    alpha: 0.3, fadeIn: 0.15, fadePow: 1.2,
    colors: COL.banana, colEnd: 0x8a7a3a,
    vel: 'inherit', inherit: 0.18, axis: 'vel', spread: 0.6,
    jitter: 0.2, ground: 0.1,
  },
  shellHit: {
    pool: 'spark', count: 18,
    life: [0.24, 0.6], size: [0.18, 0.44], endSize: [0.04, 0.12],
    speed: [5, 13], drag: 2.2, grav: 12, turb: 5,
    alpha: 1, fadePow: 1.2, spin: [-18, 18],
    colors: (o) => (o.color != null ? o.color : COL.white), colEnd: COL.ember,
    vel: 'radial',
    jitter: 0.3, ground: 0.1,
    also: [{ type: 'shellHitPuff', scale: 1 }, { type: 'shockWave', scale: 1 }],
  },
  shellHitPuff: {
    pool: 'smoke', count: 8,
    life: [0.4, 0.8], size: [0.4, 0.8], endSize: [2.2, 3],
    speed: [1.6, 4], drag: 2, grav: 1.6, turb: 1.6,
    alpha: 0.42, fadeIn: 0.08, fadePow: 1.3,
    colors: COL.smoke, colEnd: COL.smokeDim,
    vel: 'radial',
    jitter: 0.4, ground: 0.08,
  },
  bananaHit: {
    pool: 'smoke', count: 16,
    life: [0.5, 1], size: [0.3, 0.7], endSize: [2, 3],
    speed: [2, 6], drag: 2, grav: 1.4, turb: 2,
    alpha: 0.6, fadeIn: 0.08, fadePow: 1.2,
    colors: [COL.banana, 0xfff0a0], colEnd: 0x8a7a3a,
    vel: 'swirl', inherit: 0.1,
    jitter: 0.6, ground: 0.06,
  },
  shockWave: {
    pool: 'shock', count: 1,
    life: [0.26, 0.34], size: [0.7, 1.1], endSize: [7, 9],
    speed: [0, 0.4], drag: 5, grav: 0,
    alpha: 0.85, fadePow: 1.6,
    colors: (o) => (o.color != null ? o.color : COL.white), colEnd: COL.white,
    vel: 'spawn', axis: 'vel', spread: 0.001,
    jitter: 0, ground: 0.03,
  },
  mushroomPuff: {
    pool: 'smoke', count: 10,
    life: [0.3, 0.72], size: [0.28, 0.6], endSize: [2, 3],
    speed: [1, 3.6], drag: 2, grav: 1.2, turb: 1.4, flutter: 1.6,
    alpha: 0.5, fadeIn: 0.1, fadePow: 1.3,
    colors: [0xd8c8a8, 0xbfa98a, 0xe8dcc0], colEnd: 0x8f7d63,
    vel: 'inherit', inherit: 0.12, axis: 'back', spread: 1,
    jitter: 0.5, ground: 0.05,
  },
  itemBoxPop: {
    pool: 'glow', count: 3,
    life: [0.16, 0.3], size: [0.5, 0.9], endSize: [2.2, 3.2],
    speed: [0.5, 1.6], drag: 3, grav: 0.8,
    alpha: 0.95, fadePow: 1.5,
    colors: COL.bright, colEnd: COL.white,
    vel: 'radial',
    jitter: 0.3, ground: 0.06,
    also: [{ type: 'itemBoxShards', scale: 1 }, { type: 'shockWave', scale: 1 }],
  },
  itemBoxShards: {
    pool: 'spark', count: 16,
    life: [0.3, 0.7], size: [0.2, 0.42], endSize: [0.05, 0.12],
    speed: [4, 11], drag: 1.8, grav: 8, turb: 3,
    alpha: 1, fadePow: 1.2, spin: [-20, 20],
    colors: COL.rainbow, colEnd: COL.white,
    vel: 'radial',
    jitter: 0.35, ground: 0.06,
  },
  coin: {
    pool: 'star', count: 1,
    life: [0.5, 0.95], size: [0.34, 0.46], endSize: [1, 1],
    speed: [1, 3], drag: 1.2, grav: 12, turb: 1.5, spin: [-8, 8],
    alpha: 1, fadeIn: 0.04, fadePow: 1.1,
    colors: [COL.coin, COL.goldHot], colEnd: 0xfff4c0,
    vel: 'spawn', axis: 'up', spread: 0.5,
    jitter: 0.3, ground: 0.04,
    also: [{ type: 'coinGlow', scale: 0.5 }],
  },
  coinGlow: {
    pool: 'glow', count: 1,
    life: [0.2, 0.4], size: [0.5, 0.8], endSize: [0.2, 0.4],
    speed: [0.5, 1.5], drag: 3, grav: 8,
    alpha: 0.6, fadePow: 1.5,
    colors: COL.goldHot, colEnd: COL.coin,
    vel: 'spawn', axis: 'up', spread: 0.6,
    jitter: 0.2, ground: 0.04,
  },
  squashPuff: {
    pool: 'smoke', count: 14,
    life: [0.6, 1.1], size: [0.55, 1.1], endSize: [2.6, 3.6],
    speed: [2, 5], drag: 2, grav: 0.6, turb: 1.8,
    alpha: 0.5, fadeIn: 0.1, fadePow: 1.3,
    colors: [0xcfd6e6, COL.smoke], colEnd: COL.smokeDim,
    vel: 'flat',
    jitter: 0.55, ground: 0.06,
    also: [{ type: 'shockWave', scale: 0.5 }],
  },
  draftTrail: {
    pool: 'smoke', count: 2,
    life: [0.24, 0.5], size: [0.2, 0.4], endSize: [1.8, 2.6],
    speed: [0.5, 1.6], drag: 2.6, grav: 0.2, turb: 0.6,
    alpha: 0.26, fadeIn: 0.2, fadePow: 1.4,
    colors: 0xdfeeff, colEnd: 0x8fa6c8,
    vel: 'inherit', inherit: 0.32, axis: 'vel', spread: 0.5,
    jitter: 0.5, ground: 0.08,
  },
  finishSparks: {
    pool: 'spark', count: 26,
    life: [0.6, 1.5], size: [0.22, 0.5], endSize: [0.05, 0.14],
    speed: [3, 10], drag: 1.2, grav: 9, turb: 4,
    alpha: 1, fadeIn: 0.05, fadePow: 1.2, spin: [-16, 16],
    colors: [COL.goldHot, COL.white, COL.tier2, 0xff2d95], colEnd: COL.white,
    vel: 'radial',
    jitter: 3,
    also: [{ type: 'confetti', scale: 0.45 }],
  },
  ink: {
    pool: 'smoke', count: 22,
    life: [0.8, 1.7], size: [0.45, 1.2], endSize: [2.2, 3.2],
    speed: [0.4, 2], drag: 1.5, grav: 0.9, turb: 1.6,
    alpha: 0.9, fadeIn: 0.08, fadePow: 1.4,
    colors: COL.ink, colEnd: 0x1a1d33,
    vel: 'swirl', inherit: 0.05,
    jitter: 2.4, ground: 0.02,
  },
};

/* -------------------------------------------------------------------------- */
/* skid decals                                                                */
/* -------------------------------------------------------------------------- */

const DEC_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iQuat;
attribute vec2 iScale;
attribute vec3 iColor;
attribute float iAlpha;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

#include <common>
#include <fog_pars_vertex>

vec3 rotateByQuat( vec3 v, vec4 q ) {
  return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v );
}

void main() {
  vUv = uv;
  vColor = iColor;
  vAlpha = iAlpha;

  // spelled out rather than a swizzle compound assignment so it is valid on
  // every GLSL ES 1.00 driver three will hand this shader to
  vec3 p = vec3( position.x * iScale.x, position.y, position.z * iScale.y );
  p = rotateByQuat( p, iQuat ) + iPos;

  vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
`;

const DEC_FRAG = /* glsl */ `
uniform sampler2D uMap;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

#include <common>
#include <fog_pars_fragment>

void main() {
  vec4 tex = texture2D( uMap, vUv );
  float a = tex.a * vAlpha;
  if ( a <= 0.004 ) discard;
  gl_FragColor = vec4( vColor, a );
  #include <fog_fragment>
}
`;

const DEC_STRIDE = 13;
const MAX_DECALS = 300;

class SkidDecals {
  constructor(texture) {
    this.max = MAX_DECALS;
    this.n = 0;
    this.head = 0;

    const quad = new THREE.PlaneGeometry(1, 1, 1, 1);
    quad.rotateX(-Math.PI / 2);

    this.data = new Float32Array(this.max * DEC_STRIDE);
    this.ib = new THREE.InterleavedBuffer(this.data, DEC_STRIDE);
    this.ib.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.setIndex(quad.getIndex());
    geo.setAttribute('iPos', new THREE.InterleavedBufferAttribute(this.ib, 3, 0));
    geo.setAttribute('iQuat', new THREE.InterleavedBufferAttribute(this.ib, 4, 3));
    geo.setAttribute('iScale', new THREE.InterleavedBufferAttribute(this.ib, 2, 7));
    geo.setAttribute('iColor', new THREE.InterleavedBufferAttribute(this.ib, 3, 9));
    geo.setAttribute('iAlpha', new THREE.InterleavedBufferAttribute(this.ib, 1, 12));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    quad.dispose();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        fogColor: { value: new THREE.Color(0xffffff) },
        fogNear: { value: 1 },
        fogFar: { value: 2000 },
        fogDensity: { value: 0.00025 },
      },
      vertexShader: DEC_VERT,
      fragmentShader: DEC_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });
    // See Pool: mirrors the sprite so a race teardown frees it.
    this.material.mapTexture = texture;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'fx-skid-decals';

    this.life = new Float32Array(this.max);
    this.lmax = new Float32Array(this.max);
    this.grow = new Float32Array(this.max);
  }

  spawn(pos, quat, scaleX, scaleY, r, g, b, life, grow) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    if (this.n < this.max) this.n++;
    const o = i * DEC_STRIDE;
    const d = this.data;
    d[o] = pos.x; d[o + 1] = pos.y; d[o + 2] = pos.z;
    d[o + 3] = quat.x; d[o + 4] = quat.y; d[o + 5] = quat.z; d[o + 6] = quat.w;
    d[o + 7] = scaleX; d[o + 8] = scaleY;
    d[o + 9] = r; d[o + 10] = g; d[o + 11] = b;
    d[o + 12] = 1;
    this.life[i] = life;
    this.lmax[i] = life;
    this.grow[i] = grow;
  }

  update(dt) {
    if (this.n === 0) return;
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      alive++;
      const t = this.life[i] / this.lmax[i];
      this.data[i * DEC_STRIDE + 12] = t * t;
      // marks spread very slightly as they age, like real rubber
      this.data[i * DEC_STRIDE + 7] *= 1 + (this.grow[i] - 1) * dt;
    }
    this.ib.addUpdateRange(0, this.n * DEC_STRIDE);
    this.ib.needsUpdate = true;
    // Only live instances should be submitted. `n` is the ring position, not the
    // number alive — dead slots were skipped with `continue` but never compacted,
    // so up to MAX_DECALS invisible quads kept being drawn until either the ring
    // wrapped or every single member expired at once.
    this.geo.instanceCount = alive;
    if (alive === 0) {
      this.n = 0;
      this.head = 0;
    }
  }

  clear() {
    this.n = 0;
    this.head = 0;
    this.geo.instanceCount = 0;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.material.dispose();
    this.data = null;
  }

  get geo() {
    return this.mesh.geometry;
  }
}

/* -------------------------------------------------------------------------- */
/* scratch (module-level: the game is single threaded and spawn is not         */
/* re-entrant, so these never alias mid-use)                                   */
/* -------------------------------------------------------------------------- */

const _v1 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _upv = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _col = new THREE.Color();
const _cA = [0, 0, 0];
const _cB = [0, 0, 0];
const _size = { x: 1, y: 1 };
// getDrawingBufferSize() writes into a real Vector2 (it calls target.set()), and
// three 0.170 made the optional argument mandatory, so a fresh one is used here.
let _bufSize = null;
function bufferSizeOf(renderer) {
  if (!_bufSize) _bufSize = new THREE.Vector2();
  return renderer.getDrawingBufferSize(_bufSize);
}
const _dir = { x: 0, y: 0, z: 0 };
const _B = {
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  ax: 0, ay: 0, az: -1,
  hasVel: false, hasDir: false,
  tier: 0, intensity: 1, color: null, kind: null, count: null, ground: NO_GROUND,
};

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Normalises any accepted colour spec (hex, css string, linear triplet). */
function colourOf(v, out) {
  if (typeof v === 'number') {
    _col.setHex(v);
  } else if (typeof v === 'string') {
    _col.set(v);
  } else if (Array.isArray(v) && v.length >= 3) {
    out[0] = v[0]; out[1] = v[1]; out[2] = v[2];
    return out;
  } else {
    out[0] = 1; out[1] = 1; out[2] = 1;
    return out;
  }
  out[0] = _col.r; out[1] = _col.g; out[2] = _col.b;
  return out;
}

/** Uniform pick from a [min,max] range. */
function rr(rng, range) {
  if (!range) return 1;
  return range[0] + rng() * (range[1] - range[0]);
}

/** Uniform sampling inside a cone around a unit axis. */
function coneDir(rng, ax, ay, az, spread, out) {
  let hx, hy, hz;
  if (Math.abs(ay) < 0.9) {
    hx = 0; hy = 1; hz = 0;
  } else {
    hx = 1; hy = 0; hz = 0;
  }
  // right = helper x axis
  let rx = hy * az - hz * ay;
  let ry = hz * ax - hx * az;
  let rz = hx * ay - hy * ax;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // up2 = axis x right
  const ux = ay * rz - az * ry;
  const uy = az * rx - ax * rz;
  const uz = ax * ry - ay * rx;

  const ang = rng() * TAU;
  const rad = spread > 0 ? Math.tan(spread) * Math.sqrt(rng()) : 0;
  const ca = Math.cos(ang) * rad;
  const sa = Math.sin(ang) * rad;
  let x = ax + rx * ca + ux * sa;
  let y = ay + ry * ca + uy * sa;
  let z = az + rz * ca + uz * sa;
  const l = Math.hypot(x, y, z) || 1;
  x /= l; y /= l; z /= l;
  out.x = x; out.y = y; out.z = z;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Particles                                                                  */
/* -------------------------------------------------------------------------- */

export class Particles {
  /** @param {object} ctx the usual game context (scene/raceRoot/bus/camera/...) */
  constructor(ctx) {
    this.ctx = ctx || {};
    this.bus = this.ctx.bus || null;
    this.camera = this.ctx.camera || null;
    this.renderer = this.ctx.renderer || null;
    this.track = this.ctx.track || null;

    this.quality = 'high';
    this.qualityScale = 1;
    this.time = 0;
    this._rng = mulberry32(0x9e3d71);
    this._offFx = null;
    this._steppedFrame = -1;
    this._disposed = false;

    // ~4.2k particle slots in total; live counts are budgeted by quality.
    const tex = {
      smoke: smokeTexture(),
      spark: sparkTexture(),
      glow: glowTexture(),
      ring: ringTexture(),
      star: starTexture(),
      flake: flakeTexture(),
      smudge: smudgeTexture(),
    };
    this._textures = tex;

    const mk = (name, capacity, texture, blending, renderOrder, gain) =>
      new Pool({ name, capacity, blending, renderOrder, gain }, texture);

    this.pools = {
      spark: mk('spark', 1400, tex.spark, THREE.AdditiveBlending, 3),
      glow: mk('glow', 560, tex.glow, THREE.AdditiveBlending, 3, 1.05),
      shock: mk('shock', 120, tex.ring, THREE.AdditiveBlending, 3),
      star: mk('star', 280, tex.star, THREE.AdditiveBlending, 3),
      smoke: mk('smoke', 1150, tex.smoke, THREE.NormalBlending, 5),
      flake: mk('flake', 640, tex.flake, THREE.NormalBlending, 5),
    };

    this.decals = new SkidDecals(tex.smudge);

    // raceRoot is torn down (and disposed) by Game.teardownRace(), which keeps
    // the pools from surviving into the next race.
    const root = this.ctx.raceRoot || this.ctx.scene;
    this._root = root || null;
    if (root) {
      for (const k in this.pools) root.add(this.pools[k].points);
      root.add(this.decals.mesh);
      // a cheap "were we torn down?" witness: raceRoot.clear() nulls parent
      this._probe = this.pools.spark.points;
    }

    if (this.bus && typeof this.bus.on === 'function') {
      this._offFx = this.bus.on('fx:spawn', (p) => {
        // Game.teardownRace() empties raceRoot instead of calling dispose(), so
        // an instance left behind by the integrator would otherwise keep
        // simulating (and keep its bus listener) forever.
        if (this._detached()) {
          this.dispose();
          return;
        }
        this.spawn(p && p.type, p);
      });
    }
  }

  /** True when the scene graph was cleared around us. */
  _detached() {
    const root = this._root;
    if (!root || !this._probe) return false;
    return this._probe.parent !== root;
  }

  /* -------------------------------------------------------------- quality -- */

  setQuality(level) {
    this.quality = level;
    this.qualityScale =
      typeof level === 'number'
        ? clamp(level, 0.05, 2)
        : QUALITY_SCALE[level] != null ? QUALITY_SCALE[level] : 1;
    return this.qualityScale;
  }

  /* -------------------------------------------------------------- getters -- */

  get liveCount() {
    let n = 0;
    for (const k in this.pools) n += this.pools[k].n;
    return n + this.decals.n;
  }

  clear() {
    for (const k in this.pools) this.pools[k].clear();
    this.decals.clear();
  }

  /* ---------------------------------------------------------------- spawn -- */

  spawn(type, opts) {
    return this._emit(type, opts || {}, 1, false);
  }

  burst(type, opts) {
    return this._emit(type, opts || {}, 1.6, true);
  }

  /* ---------------------------------------------- per-frame convenience ----- */

  /** Wheel sparks while drifting; colour escalates with the mini-turbo tier. */
  driftSparks(kart, tier) {
    return this._emit('driftSpark', { kart, tier: tier || 0 }, 1, false);
  }

  /** Tyre smoke while drifting. */
  driftSmoke(kart, tier) {
    return this._emit('driftSmoke', { kart, tier: tier || 0 }, 1, false);
  }

  /** Exhaust flame + embers while boosting. */
  boostFlame(kart, kind) {
    return this._emit('boostFlame', { kart, kind }, 1, false);
  }

  /** Off-road dust kicked up behind the kart. */
  dust(kart) {
    return this._emit('dust', { kart }, 1, false);
  }

  starSparkle(kart) {
    return this._emit('starSparkle', { kart }, 1, false);
  }

  spinDust(kart) {
    return this._emit('spinDust', { kart }, 1, false);
  }

  squashPuff(kart) {
    return this._emit('squashPuff', { kart }, 1, false);
  }

  draftTrail(kart, charge) {
    return this._emit('draftTrail', { kart, intensity: charge != null ? charge : 1 }, 1, false);
  }

  shellTrail(position, velocity, color) {
    return this._emit('shellTrail', { position, velocity, color }, 1, false);
  }

  bananaTrail(position, velocity) {
    return this._emit('bananaTrail', { position, velocity }, 1, false);
  }

  shellHit(position, velocity, color) {
    return this._emit('shellHit', { position, velocity, color }, 1, false);
  }

  boostPadSpark(position, forward, color) {
    return this._emit('boostPadSpark', { position, forward, color }, 1, false);
  }

  mushroomPuff(position, kart) {
    return this._emit('mushroomPuff', { position, kart }, 1, false);
  }

  itemBoxPop(position, color) {
    return this._emit('itemBoxPop', { position, color }, 1, false);
  }

  coin(position, color) {
    return this._emit('coin', { position, color }, 1, false);
  }

  landPuff(position, intensity) {
    return this._emit('landPuff', { position, intensity }, 1, false);
  }

  confetti(position, count) {
    return this._emit('confetti', { position, count }, 1, false);
  }

  finishSparks(position, count) {
    return this._emit('finishSparks', { position, count }, 1, false);
  }

  ink(kart, position) {
    return this._emit('ink', { kart, position }, 1, false);
  }

  /**
   * A pair of rubber marks. `opts.driftDir` orients the mark along the slide so
   * repeated calls chain into a readable ribbon; it defaults to the track
   * tangent when no direction is supplied.
   */
  skid(position, normal, opts) {
    if (!position) return 0;
    const o = opts || {};
    const len = o.length != null ? o.length : 1.9;
    const width = o.width != null ? o.width : 2.15;
    colourOf(o.color != null ? o.color : COL.rubber, _cA);

    _upv.set(normal ? normal.x : 0, normal ? normal.y : 1, normal ? normal.z : 0);
    if (_upv.lengthSq() < 1e-6) _upv.set(0, 1, 0);
    _upv.normalize();

    _v1.set(o.driftDir ? o.driftDir.x : 0, 0, o.driftDir ? o.driftDir.z : 0);
    if (_v1.lengthSq() < 1e-6) {
      const t = this.track;
      if (t && typeof t.locate === 'function' && typeof t.yawAt === 'function') {
        const yaw = t.yawAt(t.locate(position.x, position.y, position.z).progress);
        _v1.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      }
    }
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, 1);
    _v1.normalize();

    // Basis for the decal: local X runs along the tyre tread (the mark's
    // length), local Z is the surface direction across it (its width, i.e. the
    // wheel track), local Y is the surface normal. Built so that
    // X x Y == Z, which keeps it a proper rotation instead of a mirror.
    _rgt.crossVectors(_v1, _upv);
    if (_rgt.lengthSq() < 1e-6) {
      _rgt.set(Math.abs(_upv.y) > 0.9 ? 1 : 0, 0, 0);
    }
    _rgt.normalize();
    _m4.makeBasis(_v1, _upv, _rgt);
    _q.setFromRotationMatrix(_m4);

    const n = Math.max(1, Math.round((o.count != null ? o.count : 1) * this.qualityScale));
    const lift = o.lift != null ? o.lift : 0.03;
    for (let i = 0; i < n; i++) {
      _v3.copy(position);
      _v3.y += lift;
      if (i > 0) _v3.addScaledVector(_rgt, (i % 2 === 0 ? 1 : -1) * len * 0.13);
      this.decals.spawn(
        _v3,
        _q,
        len * (0.9 + this._rng() * 0.2),
        width,
        _cA[0], _cA[1], _cA[2],
        o.life != null ? o.life : 6.5,
        o.grow != null ? o.grow : 1.05
      );
    }
    return n;
  }

  /* --------------------------------------------------------------- update -- */

  /** Fixed 120 Hz entry point (the integrator may register this as a system). */
  update(dt, ctx) {
    if (this._disposed) return;
    const frame = ctx && ctx.game ? ctx.game.frame : -1;
    if (frame >= 0 && this._steppedFrame === frame) return;
    this.step(dt, ctx);
  }

  /** Per rendered frame entry point. */
  updateView(dt, ctx) {
    if (this._disposed) return;
    const frame = ctx && ctx.game ? ctx.game.frame : -1;
    if (frame >= 0 && this._steppedFrame === frame) return;
    this.step(dt, ctx);
  }

  step(dt, ctx) {
    if (this._disposed) return;
    if (this._detached()) {
      this.dispose();
      return;
    }
    if (ctx) {
      if (ctx.game) this._steppedFrame = ctx.game.frame;
      this.camera = ctx.camera || this.camera;
      this.renderer = ctx.renderer || this.renderer;
      this.track = ctx.track || this.track;
    }
    // Freeze while paused so the world hangs perfectly still.
    if (ctx && ctx.game && ctx.game.paused === true) return;
    if (ctx && ctx.store && ctx.store.state && ctx.store.state.mode === MODES.PAUSED) return;

    const d = clamp(dt, 0, 0.1);
    this.time += d;
    this._updateSizeScale();
    for (const k in this.pools) {
      this._simulate(this.pools[k], d);
      this.pools[k].flush();
    }
    this.decals.update(d);
  }

  /** Point size is in device pixels, so the scale depends on buffer + FOV. */
  _updateSizeScale() {
    const cam = this.camera;
    if (!cam) return;
    let h = 900;
    if (this.renderer && typeof this.renderer.getDrawingBufferSize === 'function') {
      const s = bufferSizeOf(this.renderer);
      h = s.y || 900;
    }
    const fov = (cam.fov || CONFIG.camera.fov) * Math.PI / 360;
    const scale = h / (2 * Math.tan(fov));
    const maxSize = Math.max(160, h * 0.8);
    for (const k in this.pools) {
      const u = this.pools[k].material.uniforms;
      u.uScale.value = scale;
      u.uMaxSize.value = maxSize;
    }
  }

  _simulate(pool, dt) {
    let n = pool.n;
    if (n === 0) return;
    const st = pool.st;
    const d = pool.data;
    const t = this.time;
    let i = 0;
    while (i < n) {
      const o = i * STRIDE;
      const b = i * PS;
      let life = st[b + S.life] - dt;
      if (life <= 0) {
        pool.kill(i);
        n = pool.n;
        continue;
      }
      st[b + S.life] = life;
      const age = 1 - life / st[b + S.lmax];

      // ---- integration
      let vx = st[b + S.vx];
      let vy = st[b + S.vy];
      let vz = st[b + S.vz];
      const drag = st[b + S.drag];
      if (drag > 0) {
        const f = Math.exp(-drag * dt);
        vx *= f; vy *= f; vz *= f;
      }
      vy -= st[b + S.grav] * dt;
      const turb = st[b + S.turb];
      if (turb > 0) {
        const ph = st[b + S.phase] + t * 2.6;
        vx += Math.sin(ph) * turb * dt;
        vz += Math.cos(ph * 0.83) * turb * dt;
      }
      const flut = st[b + S.flutter];
      st[b + S.vx] = vx;
      st[b + S.vy] = vy;
      st[b + S.vz] = vz;

      let px = d[o] + vx * dt;
      let py = d[o + 1] + vy * dt;
      let pz = d[o + 2] + vz * dt;
      if (flut > 0) {
        const ph = st[b + S.phase];
        px += Math.sin(t * 5.5 + ph) * flut * dt;
        py += Math.cos(t * 3.1 + ph) * flut * 0.35 * dt;
      }
      const gnd = st[b + S.ground];
      if (gnd > NO_GROUND && py < gnd) {
        py = gnd;
        vy = Math.abs(vy) * 0.25;
        st[b + S.vy] = vy;
      }
      d[o] = px;
      d[o + 1] = py;
      d[o + 2] = pz;

      // ---- colour ramp, size, alpha, rotation
      const w = age * age * (3 - 2 * age);
      d[o + 3] = lerp(st[b + S.c0r], st[b + S.c1r], w);
      d[o + 4] = lerp(st[b + S.c0g], st[b + S.c1g], w);
      d[o + 5] = lerp(st[b + S.c0b], st[b + S.c1b], w);
      d[o + 6] = lerp(st[b + S.size0], st[b + S.size1], w);

      const fin = st[b + S.fadeIn];
      const pw = st[b + S.fadePow];
      let u;
      if (age < fin) {
        u = age / (fin > 1e-3 ? fin : 1e-3);
      } else {
        u = 1 - (age - fin) / ((1 - fin) > 1e-3 ? (1 - fin) : 1e-3);
      }
      if (u < 0) u = 0; else if (u > 1) u = 1;
      if (pw !== 1) u = Math.pow(u, pw);
      d[o + 7] = st[b + S.alpha] * u;

      const rotV = st[b + S.rotV];
      d[o + 8] = rotV !== 0 ? st[b + S.rot] + rotV * age * st[b + S.lmax] : st[b + S.rot];

      i++;
    }
  }

  _emit(type, opts, countMul, radial) {
    if (this._disposed) return 0;
    const def = FX[type];
    if (!def) return 0;
    if (def.decal) return this._skidEffect(opts);
    const base = this._base(opts, def);
    let total = this._emitDef(def, base, countMul, radial);
    if (def.also) {
      for (let i = 0; i < def.also.length; i++) {
        const a = def.also[i];
        const d2 = FX[a.type];
        if (d2) total += this._emitDef(d2, base, a.scale != null ? a.scale : 1, a.radial != null ? a.radial : radial);
      }
    }
    return total;
  }

  /** Resolves the emitter bones (position / velocity / facing) once per call. */
  _base(o, def) {
    const B = _B;
    B.intensity = o.intensity != null ? o.intensity : 1;
    B.tier = o.tier || 0;
    B.color = o.color != null ? o.color : null;
    B.kind = o.kind || null;
    B.count = o.count != null ? o.count : null;
    B.hasVel = false;
    B.hasDir = false;
    B.ax = 0; B.ay = 0; B.az = -1;

    let hasPos = false;
    const k = o.kart;
    if (k && k.physics && k.physics.position) {
      const p = k.physics.position;
      B.x = p.x; B.y = p.y; B.z = p.z;
      hasPos = true;
      const v = k.physics.velocity;
      if (v) {
        B.vx = v.x; B.vy = v.y; B.vz = v.z;
        B.hasVel = true;
      }
      const yaw = k.physics.yaw;
      if (typeof yaw === 'number') {
        B.ax = -Math.sin(yaw); B.ay = 0; B.az = -Math.cos(yaw);
        B.hasDir = true;
      }
    }
    if (o.position) {
      const p = o.position;
      B.x = p.x; B.y = p.y; B.z = p.z;
      hasPos = true;
    }
    if (o.velocity) {
      const v = o.velocity;
      B.vx = v.x; B.vy = v.y; B.vz = v.z;
      B.hasVel = true;
    }
    if (o.forward) {
      const f = o.forward;
      B.ax = f.x; B.ay = f.y; B.az = f.z;
      B.hasDir = true;
    }
    if (!hasPos) {
      // No emitter at all (e.g. `effect('confetti', {})`): hang it off the
      // camera so a menu-attract burst still lands somewhere sensible.
      const cam = this.camera;
      if (cam && typeof cam.getWorldPosition === 'function') {
        cam.getWorldPosition(_v1);
        B.x = _v1.x; B.y = _v1.y; B.z = _v1.z;
        if (typeof cam.getWorldDirection === 'function') {
          cam.getWorldDirection(_v1);
          B.ax = _v1.x; B.ay = _v1.y; B.az = _v1.z;
          B.hasDir = true;
        }
      } else {
        B.x = 0; B.y = 0; B.z = 0;
      }
    }
    if (!B.hasDir && B.hasVel) {
      const l2 = B.vx * B.vx + B.vz * B.vz;
      if (l2 > 1e-4) {
        const inv = 1 / Math.sqrt(l2);
        B.ax = B.vx * inv; B.az = B.vz * inv;
        B.hasDir = true;
      }
    }
    const al = Math.hypot(B.ax, B.ay, B.az);
    if (al < 1e-5) {
      B.ax = 0; B.ay = 0; B.az = -1;
    } else {
      B.ax /= al; B.ay /= al; B.az /= al;
    }
    B.ground = def.ground != null ? B.y + def.ground : NO_GROUND;
    return B;
  }

  _emitDef(def, B, countMul, radial) {
    const pool = this.pools[def.pool];
    if (!pool || this._disposed) return 0;
    const rng = this._rng;
    const inten = clamp(B.intensity != null ? B.intensity : 1, 0.12, 3);
    let count;
    if (B.count != null) {
      // an explicit count wins, so callers can dial an effect up or down
      count = Math.round(B.count * this.qualityScale);
    } else {
      count = Math.round((def.count != null ? def.count : 1) * countMul * this.qualityScale * inten);
    }
    if (count <= 0) return 0;
    if (count > 110) count = 110;

    // spawn axis
    const axisMode = def.axis || 'up';
    let axx = B.ax, axy = B.ay, axz = B.az;
    if (axisMode === 'back') {
      axx = -B.ax; axy = -B.ay; axz = -B.az;
    } else if (axisMode === 'up') {
      axx = 0; axy = 1; axz = 0;
    } else if (axisMode === 'vel' && B.hasVel) {
      const l = Math.hypot(B.vx, B.vy, B.vz);
      if (l > 1e-4) {
        axx = B.vx / l; axy = B.vy / l; axz = B.vz / l;
      }
    }

    const spread = def.spread != null ? def.spread : 0.5;
    const velMode = radial ? 'radial' : def.vel || 'spawn';
    const inherit = def.inherit != null ? def.inherit : 0;
    const jitter = def.jitter != null ? def.jitter : 0;

    const st = pool.st;
    const d = pool.data;
    let spawned = 0;

    for (let k = 0; k < count; k++) {
      const i = pool.alloc();
      if (i < 0) break;
      const o = i * STRIDE;
      const b = i * PS;

      // ---- lifetime + size
      const lmax = rr(rng, def.life);
      st[b + S.lmax] = lmax;
      st[b + S.life] = lmax;
      const size0 = rr(rng, def.size);
      st[b + S.size0] = size0;
      st[b + S.size1] = rr(rng, def.endSize);

      // ---- position
      d[o] = B.x + (rng() * 2 - 1) * jitter;
      d[o + 1] = B.y + (rng() * 2 - 1) * jitter;
      d[o + 2] = B.z + (rng() * 2 - 1) * jitter;

      // ---- colour
      this._pickColor(def.colors, B, _cA);
      st[b + S.c0r] = _cA[0];
      st[b + S.c0g] = _cA[1];
      st[b + S.c0b] = _cA[2];
      if (def.colEnd != null) {
        colourOf(def.colEnd, _cB);
      } else {
        _cB[0] = _cA[0]; _cB[1] = _cA[1]; _cB[2] = _cA[2];
      }
      st[b + S.c1r] = _cB[0];
      st[b + S.c1g] = _cB[1];
      st[b + S.c1b] = _cB[2];

      // ---- spawn direction
      let dx, dy, dz;
      if (velMode === 'radial') {
        const z = rng() * 2 - 1;
        const a = rng() * TAU;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        dx = Math.cos(a) * r; dy = z; dz = Math.sin(a) * r;
      } else if (velMode === 'flat') {
        // ground-hugging ring, like a dust wave rolling outward
        const a = rng() * TAU;
        dx = Math.cos(a); dy = 0; dz = Math.sin(a);
      } else if (velMode === 'swirl') {
        // radial direction with a tangential bias, so rings actually spin
        const a = rng() * TAU;
        const rx = Math.cos(a);
        const rz = Math.sin(a);
        dx = rx * 0.35 + (-rz) * 0.9;
        dz = rz * 0.35 + rx * 0.9;
        dy = (rng() * 2 - 1) * 0.25;
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l; dy /= l; dz /= l;
      } else {
        const dir = coneDir(rng, axx, axy, axz, spread, _dir);
        dx = dir.x; dy = dir.y; dz = dir.z;
      }

      const sp = rr(rng, def.speed);
      st[b + S.vx] = B.vx * inherit + dx * sp;
      st[b + S.vy] = B.vy * inherit + dy * sp;
      st[b + S.vz] = B.vz * inherit + dz * sp;

      // ---- misc
      st[b + S.alpha] = def.alpha != null ? def.alpha : 1;
      const rot0 = def.spin ? rng() * TAU : 0;
      st[b + S.rot] = rot0;
      st[b + S.rotV] = def.spin ? rr(rng, def.spin) : 0;
      st[b + S.drag] = def.drag != null ? def.drag : 0;
      st[b + S.grav] = def.grav != null ? def.grav : 0;
      st[b + S.turb] = def.turb != null ? def.turb : 0;
      st[b + S.phase] = rng() * TAU;
      st[b + S.flutter] = def.flutter != null ? def.flutter : 0;
      st[b + S.ground] = B.ground;
      st[b + S.fadeIn] = def.fadeIn != null ? def.fadeIn : 0;
      st[b + S.fadePow] = def.fadePow != null ? def.fadePow : 1;

      // ---- the interleaved buffer, so the very first draw is correct
      d[o + 3] = _cA[0]; d[o + 4] = _cA[1]; d[o + 5] = _cA[2];
      d[o + 6] = size0;
      d[o + 7] = st[b + S.alpha] * (st[b + S.fadeIn] > 0 ? 0 : 1);
      d[o + 8] = rot0;

      spawned++;
    }
    return spawned;
  }

  _pickColor(colors, B, out) {
    let v = colors;
    if (typeof v === 'function') v = v(B);
    if (Array.isArray(v)) v = v[(this._rng() * v.length) | 0];
    if (v == null && B.color != null) v = B.color;
    return colourOf(v, out);
  }

  _skidEffect(o) {
    const k = o.kart;
    const pos = o.position || (k && k.physics ? k.physics.position : null);
    if (!pos) return 0;
    let dir = null;
    if (k && k.physics) {
      const p = k.physics;
      const v = p.velocity;
      const speed = v ? Math.hypot(v.x, v.z) : 0;
      if (speed > 2.5) {
        dir = { x: v.x / speed, z: v.z / speed };
      } else if (typeof p.yaw === 'number') {
        dir = { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
      }
    }
    const intensify = o.intensity != null ? clamp(o.intensity, 0.2, 1) : 1;
    return this.skid(pos, o.normal || null, {
      driftDir: dir,
      length: 1.7 + intensify * 0.9,
      width: 2.05,
      count: o.count != null ? o.count : 1,
      life: 6.5 + intensify * 3,
      color: o.color != null ? o.color : COL.rubber,
    });
  }

  /* -------------------------------------------------------------- dispose -- */

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._offFx) {
      this._offFx();
      this._offFx = null;
    }
    for (const k of Object.keys(this.pools)) {
      this.pools[k].dispose();
      delete this.pools[k];
    }
    this.decals.dispose();
    for (const k of Object.keys(this._textures)) this._textures[k].dispose();
    this._textures = {};
  }
}

export default Particles;
