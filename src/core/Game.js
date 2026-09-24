import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { EventBus } from './EventBus.js';
import { GameStore, MODES } from './Store.js';
import { input } from './Input.js';
import { clamp } from './MathUtils.js';

const QUALITY = {
  low: { pixelRatio: 1.0, shadows: false, shadowSize: 512, bloom: false, smaa: false, fog: true },
  medium: { pixelRatio: 1.35, shadows: true, shadowSize: 1024, bloom: true, smaa: false, fog: true },
  high: { pixelRatio: 2.0, shadows: true, shadowSize: 2048, bloom: true, smaa: true, fog: true },
};

/**
 * Owns the renderer, scene graph, post chain and the fixed-step simulation loop.
 * Everything else in the game is a "system" plugged into this.
 */
export class Game {
  static instance = null;

  /** @param {{canvas: HTMLCanvasElement, uiRoot: HTMLElement}} opts */
  constructor({ canvas, uiRoot }) {
    Game.instance = this;
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.bus = new EventBus();
    this.store = GameStore;
    this.input = input;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor(0x0a0e1a, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.25, 4000);
    this.camera.position.set(0, 6, -12);

    /** Everything race-specific hangs off this so a race can be torn down cleanly. */
    this.raceRoot = new THREE.Group();
    this.raceRoot.name = 'raceRoot';
    this.scene.add(this.raceRoot);

    /** Container for scenery/terrain that survives across races on the same track. */
    this.worldRoot = new THREE.Group();
    this.worldRoot.name = 'worldRoot';
    this.scene.add(this.worldRoot);

    /** @type {Map<string, any>} */
    this.systems = new Map();
    /** @type {Array<{name: string, sys: any}>} */
    this.systemOrder = [];

    this.quality = QUALITY.high;
    this.running = false;
    this.paused = false;
    this.time = 0;
    this.frame = 0;
    this.stats = { fps: 60, frameMs: 16, drawCalls: 0, triangles: 0 };
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._accum = 0;
    this._last = 0;
    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();

    /** What the shadow camera + any attached helpers should orbit around. */
    this.focus = new THREE.Vector3(0, 0, 0);
    this.cameraMode = 'chase';
    this.lookBack = false;

    this._setupLights();
    this._setupComposer();
    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  _setupLights() {
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3b5a2a, 0.55);
    this.scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.12);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.1);
    this.sun.position.set(60, 90, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 320;
    const s = 46;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // A dim fill light from the opposite side keeps shadowed kart sides readable.
    this.fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    this.fill.position.set(-40, 30, -30);
    this.scene.add(this.fill);
    this._sunOffset = this.sun.position.clone();
  }

  _setupComposer() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.42, 0.75, 0.82);
    this.composer.addPass(this.bloom);
    this.smaa = new SMAAPass(size.x, size.y);
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());
  }

  applyQuality(level) {
    const q = QUALITY[level] || QUALITY.high;
    this.quality = { ...q };
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.bloom.enabled = q.bloom;
    this.smaa.enabled = q.smaa;
    this.resize();
  }

  /**
   * Registers a system. Systems expose init(ctx), update(dt, ctx), updateView(dt, ctx).
   * Set `persistent: true` to survive teardownRace() (used for audio + the UI shell).
   */
  addSystem(name, sys) {
    if (this.systems.has(name)) this.removeSystem(name);
    this.systems.set(name, sys);
    this.systemOrder.push({ name, sys });
    sys.init?.(this.ctx());
    return sys;
  }

  getSystem(name) {
    return this.systems.get(name);
  }

  removeSystem(name) {
    const sys = this.systems.get(name);
    if (!sys) return;
    this.systemOrder = this.systemOrder.filter((e) => e.name !== name);
    this.systems.delete(name);
    try {
      sys.dispose?.();
    } catch (err) {
      console.error(`[game] dispose of "${name}" failed`, err);
    }
  }

  clearSystems() {
    for (const name of [...this.systems.keys()]) {
      if (this.systems.get(name)?.persistent === true) continue;
      this.removeSystem(name);
    }
  }

  /** Wipes the race scene graph and every system. */
  teardownRace() {
    this.clearSystems();
    this.raceRoot.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh || o.isPoints || o.isLine) {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          for (const k in m) {
            const v = m[k];
            if (v && v.isTexture) v.dispose();
          }
          m.dispose?.();
        }
      }
    });
    this.raceRoot.clear();
  }

  setCameraMode(mode, opts = {}) {
    this.cameraMode = mode;
    this.cameraModeData = opts;
  }

  /** Shortcut for one-shot screen effects driven by the fx layer. */
  effect(type, opts = {}) {
    this.bus.emit('fx:spawn', { type, ...opts });
  }

  sfx(name, opts = {}) {
    this.bus.emit('audio:sfx', { name, ...opts });
  }

  ctx() {
    return {
      game: this,
      scene: this.scene,
      raceRoot: this.raceRoot,
      worldRoot: this.worldRoot,
      camera: this.camera,
      renderer: this.renderer,
      composer: this.composer,
      bus: this.bus,
      store: this.store,
      input: this.input,
      uiRoot: this.uiRoot,
      quality: this.quality,
      time: this.time,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      this.step(now);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  step(now) {
    const raw = (now - this._last) / 1000;
    this._last = now;
    const dt = clamp(raw, 0, 0.05);
    const t0 = performance.now();

    // One place, read by every system and every effect, so pausing is never
    // half-applied.
    this.paused = GameStore.state.mode === MODES.PAUSED;

    this.input.beginFrame(dt);
    this.time += dt;
    const ctx = this.ctx();

    // Fixed-step simulation keeps physics stable regardless of frame rate.
    const FIXED = 1 / 120;
    this._accum = Math.min(this._accum + dt, FIXED * 8);
    while (this._accum >= FIXED) {
      this._accum -= FIXED;
      for (let i = 0; i < this.systemOrder.length; i++) {
        const { sys } = this.systemOrder[i];
        if (sys.enabled === false) continue;
        // A `simOnly` system opts out of the fixed loop: it is driven entirely
        // from updateView() with the real frame delta, because a camera spring
        // or a particle system stepped at 1/120 s advances at half speed on a
        // 60 Hz display.
        if (sys.simOnly === true) continue;
        sys.update?.(FIXED, ctx, FIXED);
      }
    }
    // View layer runs once per rendered frame with the real delta.
    for (let i = 0; i < this.systemOrder.length; i++) {
      const { name, sys } = this.systemOrder[i];
      if (sys.enabled === false) continue;
      sys.updateView?.(dt, ctx, dt, name);
    }

    this._updateShadowFocus(ctx);
    this.render(dt);
    this.input.endFrame?.();

    const ms = performance.now() - t0;
    this._fpsAcc += raw;
    this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this.stats.fps = Math.round(this._fpsFrames / this._fpsAcc);
      this.stats.frameMs = +ms.toFixed(2);
      this.stats.drawCalls = this.renderer.info.render.calls;
      this.stats.triangles = this.renderer.info.render.triangles;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
      this.bus.emit('game:stats', this.stats);
    }
    this.frame++;
  }

  _updateShadowFocus(ctx) {
    // Follow the camera target so a tight shadow map stays crisp over a long track.
    if (this.cameraMode === 'race' || this.cameraMode === 'chase') {
      const cam = this.camera;
      ctx.camera.getWorldDirection(this._tmpVec);
      this._tmpVec2.copy(cam.position).addScaledVector(this._tmpVec, 26);
      this.focus.lerp(this._tmpVec2, 0.12);
    }
    this.sun.target.position.copy(this.focus);
    this.sun.position.copy(this.focus).add(this._sunOffset);
  }

  render(dt) {
    this.renderer.info.reset();
    if (this.quality.bloom || this.quality.smaa) {
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer?.setSize(size.x, size.y);
    this.smaa?.setSize?.(size.x, size.y);
    this.bloom?.setSize?.(size.x, size.y);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.bus.emit('game:resize', { width: w, height: h });
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.teardownRace();
    this.renderer.dispose();
    Game.instance = null;
  }
}

export { QUALITY, MODES };
