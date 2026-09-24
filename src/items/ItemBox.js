/**
 * ItemBox — the floating reward cube.
 *
 * A translucent cube shell (fresnel gradient over a procedural panel texture),
 * a bright rotating gem inside it, a soft additive glow sprite, plus spin, bob,
 * a pop-out when taken and a respawn with a squash-and-stretch pop-in.
 *
 * Everything expensive is shared: one geometry set, one material set and one
 * canvas texture set for every box in the race (referenced through
 * `acquireItemBoxAssets()` / `releaseItemBoxAssets()`), and the box instances
 * themselves are pooled by ItemSystem so a new race reuses them instead of
 * allocating new meshes.
 */
import * as THREE from 'three';
import { CONFIG } from '../data/config.js';

/* ------------------------------------------------------------- shared assets */

const SHELL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const SHELL_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uTime;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  float fres = pow(1.0 - abs(dot(n, v)), 2.1);
  vec4 tex = texture2D(uMap, vUv);
  float pulse = 0.5 + 0.5 * sin(uTime * 2.6 + vUv.y * 7.0);
  vec3 col = mix(uColorA, uColorB, fres);
  col += tex.rgb * tex.a * (0.34 + 0.26 * pulse);
  col += vec3(0.42, 0.92, 1.0) * pulse * 0.07;
  float a = clamp(fres * 0.92 + tex.a * 0.52, 0.0, 1.0) * uOpacity;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SHARED = {
  ready: false,
  refs: 0,
  boxGeo: null,
  gemGeo: null,
  auraGeo: null,
  panelTex: null,
  gemTex: null,
  glowTex: null,
  shellMat: null,
  gemMat: null,
  auraMat: null,
  glowMat: null,
};

function makePanelTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);

  // Inner wash: bright at the top-left, fading out — sells a curved glass panel.
  const wash = g.createLinearGradient(0, 0, S, S);
  wash.addColorStop(0, 'rgba(226, 250, 255, 0.55)');
  wash.addColorStop(0.45, 'rgba(120, 220, 255, 0.18)');
  wash.addColorStop(1, 'rgba(60, 150, 220, 0.05)');
  g.fillStyle = wash;
  g.fillRect(0, 0, S, S);

  // Chunky frame + inner hairline.
  g.strokeStyle = 'rgba(240, 253, 255, 0.92)';
  g.lineWidth = 16;
  g.strokeRect(14, 14, S - 28, S - 28);
  g.strokeStyle = 'rgba(90, 200, 255, 0.5)';
  g.lineWidth = 3;
  g.strokeRect(34, 34, S - 68, S - 68);

  // Corner brackets.
  g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  g.lineWidth = 8;
  const b = 46;
  const cxy = [[26, 26, 1, 1], [S - 26, 26, -1, 1], [26, S - 26, 1, -1], [S - 26, S - 26, -1, -1]];
  for (const [x, y, sx, sy] of cxy) {
    g.beginPath();
    g.moveTo(x + sx * 4, y + sy * b);
    g.lineTo(x + sx * 4, y + sy * 4);
    g.lineTo(x + sx * b, y + sy * 4);
    g.stroke();
  }

  // Dot matrix, so the panel has something to catch the light on.
  g.fillStyle = 'rgba(210, 245, 255, 0.32)';
  for (let y = 74; y < S - 60; y += 26) {
    for (let x = 74; x < S - 60; x += 26) {
      g.beginPath();
      g.arc(x, y, 3.6, 0, Math.PI * 2);
      g.fill();
    }
  }

  // Diagonal sheen band.
  g.globalAlpha = 0.5;
  g.strokeStyle = 'rgba(255, 255, 255, 0.65)';
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(-20, S * 0.78);
  g.lineTo(S * 0.52, -20);
  g.stroke();
  g.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeGemTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, S);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.34, '#d6f6ff');
  grad.addColorStop(0.62, '#54d3ff');
  grad.addColorStop(1, '#1d7fe0');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const hot = g.createRadialGradient(S * 0.36, S * 0.28, 2, S * 0.36, S * 0.28, S * 0.5);
  hot.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  hot.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = hot;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGlowTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  grad.addColorStop(0.22, 'rgba(150, 232, 255, 0.6)');
  grad.addColorStop(0.55, 'rgba(60, 170, 255, 0.22)');
  grad.addColorStop(1, 'rgba(30, 120, 255, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Builds the shared geometry / texture / material prototypes. Textures, geometry
 * and compiled programs are shared by every box; each box clones only the two
 * materials whose uniforms animate independently (the shell's opacity during the
 * pop, the glow sprite's brightness), which is unavoidable without per-instance
 * attributes and costs nothing at draw time because the clones share a program.
 */
function buildShared() {
  if (SHARED.ready) return SHARED;
  SHARED.boxGeo = new THREE.BoxGeometry(1.72, 1.72, 1.72);
  SHARED.gemGeo = new THREE.OctahedronGeometry(0.46, 0);
  SHARED.auraGeo = new THREE.OctahedronGeometry(0.72, 0);
  SHARED.panelTex = makePanelTexture();
  SHARED.gemTex = makeGemTexture();
  SHARED.glowTex = makeGlowTexture();

  SHARED.shellMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: SHARED.panelTex },
      uColorA: { value: new THREE.Color('#0b3a63') },
      uColorB: { value: new THREE.Color('#bff0ff') },
      uTime: { value: 0 },
      uOpacity: { value: 1 },
    },
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  SHARED.gemMat = new THREE.MeshBasicMaterial({
    map: SHARED.gemTex,
    toneMapped: true,
  });
  SHARED.auraMat = new THREE.MeshBasicMaterial({
    map: SHARED.gemTex,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  SHARED.glowMat = new THREE.SpriteMaterial({
    map: SHARED.glowTex,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });

  SHARED.ready = true;
  return SHARED;
}

function disposeShared() {
  if (!SHARED.ready) return;
  SHARED.boxGeo?.dispose?.();
  SHARED.gemGeo?.dispose?.();
  SHARED.auraGeo?.dispose?.();
  SHARED.panelTex?.dispose?.();
  SHARED.gemTex?.dispose?.();
  SHARED.glowTex?.dispose?.();
  SHARED.shellMat?.dispose?.();
  SHARED.gemMat?.dispose?.();
  SHARED.auraMat?.dispose?.();
  SHARED.glowMat?.dispose?.();
  SHARED.ready = false;
  SHARED.boxGeo = null;
  SHARED.gemGeo = null;
  SHARED.auraGeo = null;
  SHARED.panelTex = null;
  SHARED.gemTex = null;
  SHARED.glowTex = null;
  SHARED.shellMat = null;
  SHARED.gemMat = null;
  SHARED.auraMat = null;
  SHARED.glowMat = null;
}

/** Takes a reference on the shared box assets, building them on first use. */
export function acquireItemBoxAssets() {
  if (!SHARED.ready) buildShared();
  SHARED.refs++;
  return SHARED;
}

/** Drops a reference; the GPU resources are freed once the last box is gone. */
export function releaseItemBoxAssets(force) {
  if (SHARED.refs > 0) SHARED.refs -= force ? SHARED.refs : 1;
  if (SHARED.refs === 0) disposeShared();
}

/* ------------------------------------------------------------- row fallback */

/**
 * Default item-box row layout, used when the track definition does not specify
 * its own. Rows are spread evenly around the lap, clear of the start line, and
 * `count` boxes are spread across `width` metres of tarmac.
 *
 * @param {object} path TrackPath
 * @param {object} def TrackDef
 * @param {object} [ctx] game context (unused, accepted for symmetry)
 * @returns {Array<{position:number, index:number, count:number, width:number, p:number}>}
 *   `position` is a 0..1 progress fraction along the centreline.
 */
export function buildDefaultRowData(path, def, ctx) {
  void ctx;
  const rows = [];
  const startLine = def && typeof def.startLine === 'number' ? def.startLine : 0;
  const width = (def && typeof def.width === 'number' ? def.width : 11) * 0.86;
  let count = CONFIG.items.autoRows || 14;
  const perRow = CONFIG.items.autoRowCount || 5;
  count = Math.max(3, Math.min(24, count | 0));
  for (let i = 0; i < count; i++) {
    const p = (startLine + 0.045 + (i + 0.5) / count) % 1;
    rows.push({
      position: p,
      p,
      index: i,
      count: perRow,
      width,
    });
  }
  return rows;
}

/** Expands `{position|p, count, width}` rows into world-space slot descriptors. */
export function rowsToSlots(rows, path) {
  const slots = [];
  const rowsIn = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < rowsIn.length; i++) {
    const r = rowsIn[i];
    const p = typeof r.position === 'number' ? r.position : (typeof r.p === 'number' ? r.p : 0);
    const count = Math.max(1, Math.floor(r.count || CONFIG.items.autoRowCount || 5));
    const width = +(r.width || CONFIG.items.autoRowWidth || 9.5);
    const half = width * 0.5;
    for (let k = 0; k < count; k++) {
      const t = count === 1 ? 0.5 : k / (count - 1);
      const lateral = -half + t * width;
      const progress = (p + 1) % 1;
      // Built once per race, so a fresh Vector3 here costs nothing.
      const position = path && typeof path.positionAt === 'function'
        ? path.positionAt(progress, lateral)
        : new THREE.Vector3();
      slots.push({ progress, lateral, position, row: i, slot: k });
    }
  }
  return slots;
}

/* ---------------------------------------------------------------- the box */

const POP_TIME = 0.36;
const APPEAR_TIME = 0.55;

/**
 * One item box. Driven by `update(dt)`; consumed with `consume(kart)`.
 */
export class ItemBox {
  /**
   * @param {object} o
   * @param {THREE.Vector3} o.position world position of the box centre
   * @param {number} [o.progress] 0..1 progress along the centreline
   * @param {number} [o.index] ordinal in the row, used as the bob phase
   * @param {object} [o.assets] shared asset set
   */
  constructor(o = {}) {
    // A box created without a shared set takes its own reference on it, so the
    // GPU resources are freed when the last box goes away. Pooled boxes pass the
    // owner's set and never acquire.
    this._ownsRef = !o.assets;
    this.assets = o.assets || acquireItemBoxAssets();
    const a = this.assets;
    // Per-instance clones of the two animated materials; everything else is shared.
    this.matShell = a.shellMat.clone();
    this.matShell.uniforms.uMap.value = a.panelTex;
    this.matGlow = a.glowMat.clone();
    this.matGlow.map = a.glowTex;

    this.group = new THREE.Group();
    this.group.name = 'itemBox';
    this.mesh = this.group;
    this.position = this.group.position;
    if (o.position) this.position.copy(o.position);
    this.progress = o.progress == null ? 0 : o.progress;
    this.lateral = o.lateral == null ? 0 : o.lateral;
    this.index = o.index == null ? 0 : o.index;

    this.shell = new THREE.Mesh(a.boxGeo, this.matShell);
    this.shell.frustumCulled = true;
    this.gem = new THREE.Mesh(a.gemGeo, a.gemMat);
    this.gem.scale.set(1, 1.36, 1);
    this.aura = new THREE.Mesh(a.auraGeo, a.auraMat);
    this.glow = new THREE.Sprite(this.matGlow);
    this.glow.scale.set(3.6, 3.6, 3.6);
    this.group.add(this.shell);
    this.group.add(this.aura);
    this.group.add(this.gem);
    this.group.add(this.glow);

    this.radius = CONFIG.items.boxRadius || 1.5;
    /** Distance from the centre at which a kart can collect. */
    this.pickupRadius = 3.5;
    this.active = true;
    this.visible = true;
    this.state = 'idle'; // idle | pop | wait | appear
    this.timer = 0;
    this.age = (this.index % 5) * 0.7;
    this.baseY = this.position.y;
    this._scale = 1;
    this.group.visible = true;
    this.group.scale.setScalar(1);
  }

  /** Places the box at a world position (or fresh off a track slot). */
  place(position, progress, lateral) {
    if (position) this.position.copy(position);
    if (progress != null) this.progress = progress;
    if (lateral != null) this.lateral = lateral;
    this.baseY = this.position.y;
    this.active = true;
    this.visible = true;
    this.state = 'idle';
    this.timer = 0;
    this.group.visible = true;
    this._scale = 1;
    this.group.scale.setScalar(1);
    this.matShell.uniforms.uOpacity.value = 1;
    this.matGlow.opacity = 0.85;
    return this;
  }

  /**
   * Points this box's per-instance material clones at a (possibly newly
   * created) shared asset set. A pooled box outlives the ItemSystem that made
   * it, so the shared textures may have been disposed and rebuilt in between;
   * without this the box would keep sampling a stale texture until it happened
   * to be re-uploaded.
   */
  rebind(assets) {
    const a = assets || SHARED;
    if (!a || a.refs <= 0) return this;
    this.assets = a;
    this.matShell.uniforms.uMap.value = a.panelTex;
    this.matGlow.map = a.glowTex;
    this.matShell.uniforms.uMap.needsUpdate = true;
    this.matGlow.needsUpdate = true;
    return this;
  }

  /** Detaches from the scene graph but keeps every mesh, for pooling. */
  release() {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.active = false;
    this.visible = false;
    return this;
  }

  /**
   * Called by whoever detects the pickup (ItemSystem or the race bootstrap).
   * @param {object} [_kart] the collector
   */
  consume(_kart) {
    if (!this.active) return false;
    this.active = false;
    this.state = 'pop';
    this.timer = POP_TIME;
    return true;
  }

  /** Immediately restarts the respawn timer (used by reset()). */
  reset(active) {
    this.active = active !== false;
    this.visible = this.active;
    this.state = this.active ? 'idle' : 'wait';
    this.timer = this.active ? 0 : CONFIG.items.boxRespawn;
    this.group.visible = this.active;
    this._scale = this.active ? 1 : 0.001;
    this.group.scale.setScalar(this._scale);
    this.matShell.uniforms.uOpacity.value = this.active ? 1 : 0;
    this.matGlow.opacity = this.active ? 0.85 : 0;
  }

  /** @param {number} dt seconds */
  update(dt) {
    if (!(dt > 0)) dt = 1 / 120;
    this.age += dt;
    const a = this.assets;
    this.matShell.uniforms.uTime.value = this.age;

    switch (this.state) {
      case 'pop': {
        this.timer -= dt;
        const t = 1 - Math.max(0, this.timer) / POP_TIME;
        // Fast squash, then a burst outward as the cube blows apart.
        const s = 1 + 0.85 * Math.sin(Math.min(1, t) * Math.PI * 0.5);
        this.group.scale.setScalar(s);
        this.matShell.uniforms.uOpacity.value = Math.max(0, 1 - t * 1.5);
        this.gem.scale.set(1 + t * 1.6, 1.36 + t * 2.2, 1 + t * 1.6);
        this.matGlow.opacity = 0.85 * (1 - t);
        if (this.timer <= 0) {
          this.state = 'wait';
          this.timer = CONFIG.items.boxRespawn;
          this.group.visible = false;
          this.matShell.uniforms.uOpacity.value = 1;
          this.gem.scale.set(1, 1.36, 1);
          this.matGlow.opacity = 0;
        }
        break;
      }
      case 'wait': {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.state = 'appear';
          this.timer = APPEAR_TIME;
          this.group.visible = true;
          this.group.scale.setScalar(0.02);
          this.matShell.uniforms.uOpacity.value = 0;
          this.matGlow.opacity = 0;
        }
        break;
      }
      case 'appear': {
        this.timer -= dt;
        const t = 1 - Math.max(0, this.timer) / APPEAR_TIME;
        const e = 1 - Math.pow(1 - t, 3);
        const overshoot = 1 + 0.24 * Math.sin(Math.min(1, t) * Math.PI) * (1 - t);
        this.group.scale.setScalar(Math.max(0.02, e * overshoot));
        this.matShell.uniforms.uOpacity.value = Math.min(1, t * 1.8);
        this.matGlow.opacity = 0.85 * Math.min(1, t * 2);
        if (this.timer <= 0) {
          this.state = 'idle';
          this.active = true;
          this.visible = true;
          this.group.scale.setScalar(1);
          this.matShell.uniforms.uOpacity.value = 1;
          this.matGlow.opacity = 0.85;
        }
        break;
      }
      default: {
        const bob = Math.sin(this.age * 2.1 + this.index * 0.9) * 0.3;
        this.position.y = this.baseY + bob;
        this.group.rotation.y += dt * 1.45;
        this.gem.rotation.y -= dt * 2.6;
        this.gem.rotation.x += dt * 1.1;
        const pulse = 1 + Math.sin(this.age * 4.2 + this.index) * 0.07;
        this.gem.scale.set(pulse, 1.36 * pulse, pulse);
        this.aura.rotation.y += dt * 1.7;
        this.aura.rotation.z -= dt * 0.9;
        this.aura.scale.setScalar(1 + Math.sin(this.age * 3.1) * 0.1);
        this.matGlow.opacity = 0.65 + 0.3 * (0.5 + 0.5 * Math.sin(this.age * 3.4 + this.index));
        break;
      }
    }
  }

  /** Spin-time animation used by the title scene (no pickups involved). */
  updateView(dt) {
    this.update(dt);
  }

  dispose() {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.clear();
    this.gem = null;
    this.shell = null;
    this.aura = null;
    this.glow = null;
    this.matShell?.dispose?.();
    this.matGlow?.dispose?.();
    this.matShell = null;
    this.matGlow = null;
    if (this._ownsRef) {
      this._ownsRef = false;
      releaseItemBoxAssets();
    }
    this.assets = null;
  }
}

export default ItemBox;
