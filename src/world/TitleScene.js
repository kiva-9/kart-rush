/**
 * The title-screen backdrop: the default track built once into worldRoot with a slow
 * cinematic orbit around the start line, so the menu always has live 3D behind it.
 */
import * as THREE from 'three';
import { GameStore } from '../core/Store.js';

let active = null;

async function safe(p, what) {
  try {
    return await p;
  } catch (err) {
    console.warn('[title] ' + what + ' unavailable', err);
    return null;
  }
}

function pick(m, ...names) {
  if (!m) return null;
  for (const n of names) if (typeof m[n] === 'function') return m[n];
  if (typeof m.default === 'function') return m.default;
  return null;
}

export async function buildTitleScene(ctx) {
  disposeTitleScene();
  const { game, worldRoot, camera } = ctx;

  const tracksMod = await safe(import('../data/tracks.js'), 'data/tracks.js');
  const TrackPathCtor = pick(await safe(import('../world/TrackPath.js'), 'world/TrackPath.js'), 'TrackPath');
  const TrackBuilderCtor = pick(await safe(import('../world/TrackBuilder.js'), 'world/TrackBuilder.js'), 'TrackBuilder');
  const buildDecor = pick(await safe(import('../world/Decor.js'), 'world/Decor.js'), 'buildDecor');

  const def = pick(tracksMod, 'getTrack') ? pick(tracksMod, 'getTrack')(GameStore.state.trackId) : tracksMod?.TRACKS?.[0];
  if (!def || !TrackPathCtor || !TrackBuilderCtor) {
    // Minimal fallback: a gradient dome so the menu is never empty.
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(600, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(0x1b2f6b) },
          bottom: { value: new THREE.Color(0xffb27a) },
        },
        vertexShader: 'varying float vH; void main(){ vH = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying float vH; void main(){ gl_FragColor = vec4(mix(bottom, top, clamp(vH*0.5+0.5,0.0,1.0)), 1.0); }',
      })
    );
    sky.name = 'titleSkyFallback';
    worldRoot.add(sky);
    camera.position.set(0, 20, 40);
    camera.lookAt(0, 0, 0);
    active = { disconnect() { worldRoot.remove(sky); sky.geometry.dispose(); sky.material.dispose(); } };
    return active;
  }

  const path = new TrackPathCtor(def);
  const builder = new TrackBuilderCtor(ctx, def, path);
  builder.build?.();
  worldRoot.add(builder.group);
  let decor = null;
  try {
    if (buildDecor) decor = buildDecor(ctx, def, path, worldRoot);
  } catch (err) {
    console.error('[title] decor failed', err);
  }

  game.setCameraMode('title');

  const cam = ctx.camera;
  const focus = new THREE.Vector3();
  path.positionAt(def.startLine ?? 0.02, 0, focus).add(new THREE.Vector3(0, 4, 0));
  const radius = 46;
  const height = 17;
  let t = 0;

  const system = {
    persistent: false,
    updateView(dt) {
      t += dt * 0.055;
      if (game.paused) return;
      if (decor && typeof decor.animate === 'function') decor.animate(dt);
      const a = t * Math.PI * 2;
      cam.position.set(
        focus.x + Math.sin(a) * radius,
        focus.y + height + Math.sin(t * 1.7) * 1.6,
        focus.z + Math.cos(a) * radius
      );
      cam.lookAt(focus);
    },
    disconnect() {},
  };
  game.addSystem('titleScene', system);
  active = {
    disconnect() {
      game.removeSystem('titleScene');
      try {
        decor?.dispose?.();
      } catch (err) {
        console.error('[title] decor dispose failed', err);
      }
      if (ctx.scene) ctx.scene.environment = null;
      worldRoot.remove(builder.group);
      // Use the builder's own teardown: it tracks `_geos`/`_mats` rather than
      // only what is still parented to the group, so nothing is skipped.
      builder.dispose?.();
      worldRoot.clear();
    },
  };
  return active;
}

export function disposeTitleScene() {
  if (!active) return;
  try {
    active.disconnect();
  } catch (err) {
    console.error('[title] dispose failed', err);
  }
  active = null;
}
