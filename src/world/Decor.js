/**
 * Decor - everything around the racing surface: sky, atmosphere, environment
 * reflections, instanced foliage, rocks, spectators, banners, landmarks, water
 * and the sun. Everything is positioned through the TrackPath so nothing ever
 * lands on the tarmac.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

import { clamp, lerp, mulberry32, TAU } from '../core/MathUtils.js';

/* -------------------------------------------------------------------- utils */

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d') };
}

function colorOf(hex, fallback = 0xffffff) {
  const v = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : hex;
  return new THREE.Color(Number.isFinite(v) ? v : fallback);
}

/** Flat vertex-color attribute so a geometry can be merged with the others. */
function tint(geo, color) {
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  const c = colorOf(color);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  if (!geo.getAttribute('uv')) {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  // mergeGeometries needs every part to agree on being indexed; PolyhedronGeometry
  // (icosahedra and friends) ships without an index.
  if (!geo.getIndex()) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
  }
  return geo;
}

function merge(parts) {
  const list = parts.filter(Boolean);
  if (!list.length) return null;
  const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (list.length > 1) for (const g of list) g.dispose();
  if (!geo) return null;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------- procedural */

function waterNormalTexture() {
  const S = 256;
  const { c, g } = canvas2d(S, S);
  const img = g.createImageData(S, S);
  const rng = mulberry32(0x77aa);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = 128 + Math.sin(x * 0.11 + Math.sin(y * 0.05) * 2) * 30 + Math.sin(y * 0.17 + Math.sin(x * 0.04) * 2) * 22 + (rng() - 0.5) * 14;
      img.data[i] = clamp(n, 0, 255);
      img.data[i + 1] = clamp(128 + Math.cos(x * 0.11 + Math.sin(y * 0.05) * 2) * 24, 0, 255);
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function bannerTexture(text, sub, bg, fg, accent) {
  const W = 512;
  const H = 128;
  const { c, g } = canvas2d(W, H);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.fillStyle = accent;
  g.fillRect(0, 0, W, 10);
  g.fillRect(0, H - 10, W, 10);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'italic 900 52px system-ui, sans-serif';
  g.fillText(text, W / 2, H * 0.42, W - 30);
  g.font = '700 26px system-ui, sans-serif';
  g.fillText(sub, W / 2, H * 0.76, W - 30);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------ tree shapes */

function pineGeometry(trunkColor, leafColor) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.18, 0.34, 2.4, 6);
  trunk.translate(0, 1.2, 0);
  parts.push(tint(trunk, trunkColor));
  const tiers = [
    [2.5, 4.6, 3.0],
    [2.0, 3.8, 5.3],
    [1.4, 3.0, 7.4],
    [0.8, 2.1, 9.1],
  ];
  for (const [r, h, y] of tiers) {
    const cone = new THREE.ConeGeometry(r, h, 7);
    cone.translate(0, y + h * 0.35, 0);
    parts.push(tint(cone, leafColor));
  }
  return merge(parts);
}

function mapleGeometry(trunkColor, leafColor, leafAlt) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.2, 0.36, 3.2, 6);
  trunk.translate(0, 1.6, 0);
  parts.push(tint(trunk, trunkColor));
  const blobs = [
    [0, 4.6, 0, 2.2],
    [1.5, 4.0, 0.4, 1.6],
    [-1.4, 4.2, -0.6, 1.5],
    [0.4, 5.9, -0.9, 1.5],
    [-0.5, 5.4, 1.2, 1.3],
  ];
  for (const [x, y, z, r] of blobs) {
    const b = new THREE.IcosahedronGeometry(r, 0);
    b.translate(x, y, z);
    parts.push(tint(b, leafColor));
    const hi = new THREE.IcosahedronGeometry(r * 0.6, 0);
    hi.translate(x + 0.4, y + r * 0.6, z - 0.4);
    parts.push(tint(hi, leafAlt));
  }
  return merge(parts);
}

function palmGeometry(trunkColor, leafColor) {
  const parts = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < 6; i++) {
    const seg = new THREE.CylinderGeometry(0.17, 0.22, 1.5, 5);
    seg.translate(x, y + 0.75, 0);
    seg.rotateX(0.09 * i);
    parts.push(tint(seg, trunkColor));
    x += 0.24;
    y += 1.44;
  }
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU;
    const frond = new THREE.ConeGeometry(0.55, 4.2, 4);
    frond.translate(0, 2.0, 0);
    frond.rotateZ(Math.PI * 0.42);
    frond.rotateY(a);
    frond.translate(x, y + 0.1, 0);
    parts.push(tint(frond, leafColor));
  }
  return merge(parts);
}

function cactusGeometry(body, dark) {
  const parts = [];
  const main = new THREE.CylinderGeometry(0.5, 0.62, 4.2, 8);
  main.translate(0, 2.1, 0);
  parts.push(tint(main, body));
  for (const side of [-1, 1]) {
    const arm = new THREE.CylinderGeometry(0.28, 0.28, 1.8, 6);
    arm.translate(side * 1.0, 2.5, 0);
    parts.push(tint(arm, dark));
    const up = new THREE.CylinderGeometry(0.26, 0.26, 1.6, 6);
    up.translate(side * 1.35, 3.4, 0);
    parts.push(tint(up, dark));
  }
  return merge(parts);
}

function bushGeometry(color, alt) {
  const parts = [];
  for (const [x, y, z, r] of [
    [0, 0.5, 0, 0.9],
    [0.7, 0.35, 0.2, 0.6],
    [-0.6, 0.4, -0.3, 0.65],
  ]) {
    const b = new THREE.IcosahedronGeometry(r, 0);
    b.translate(x, y, z);
    parts.push(tint(b, r > 0.8 ? color : alt));
  }
  return merge(parts);
}

function rockGeometry(color, alt) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.getAttribute('position');
  const rng = mulberry32(0x51ee);
  for (let i = 0; i < p.count; i++) {
    const s = 0.68 + rng() * 0.6;
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.75, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return tint(g, colorOf(color).lerp(colorOf(alt), 0.4));
}

function spectatorGeometry() {
  const parts = [];
  const body = new THREE.CapsuleGeometry(0.24, 0.72, 3, 7);
  body.translate(0, 0.92, 0);
  parts.push(tint(body, 0xf2f4f8));
  const head = new THREE.SphereGeometry(0.24, 8, 6);
  head.translate(0, 1.52, 0);
  parts.push(tint(head, 0xe8b98a));
  const legs = new THREE.CapsuleGeometry(0.19, 0.34, 2, 6);
  legs.translate(0, 0.3, 0);
  parts.push(tint(legs, 0x2b3242));
  return merge(parts);
}

/* ------------------------------------------------------------- landmarks */

function windmillParts(stone, roof, blade) {
  const parts = [];
  const tower = new THREE.CylinderGeometry(1.5, 2.6, 12, 8);
  tower.translate(0, 6, 0);
  parts.push(tint(tower, stone));
  const cap = new THREE.ConeGeometry(2.2, 2.4, 8);
  cap.translate(0, 13.2, 0);
  parts.push(tint(cap, roof));
  const hub = new THREE.CylinderGeometry(0.5, 0.5, 1.2, 6);
  hub.rotateZ(Math.PI / 2);
  hub.translate(0, 12.4, 2.2);
  parts.push(tint(hub, roof));
  const blades = [];
  for (let i = 0; i < 4; i++) {
    const b = new THREE.BoxGeometry(0.7, 7.4, 0.16);
    b.translate(0, 3.7, 0);
    blades.push(b);
  }
  return { body: merge(parts), blades: merge(blades.map((g) => tint(g, blade))) };
}

function castleParts(stone, roof) {
  const parts = [];
  const wall = new THREE.BoxGeometry(16, 7, 3);
  wall.translate(0, 3.5, 0);
  parts.push(tint(wall, stone));
  for (const x of [-7, 7]) {
    const t = new THREE.CylinderGeometry(2.2, 2.4, 12, 8);
    t.translate(x, 6, 0);
    parts.push(tint(t, stone));
    const c = new THREE.ConeGeometry(2.6, 3.4, 8);
    c.translate(x, 13.4, 0);
    parts.push(tint(c, roof));
  }
  const keep = new THREE.CylinderGeometry(3.2, 3.4, 17, 8);
  keep.translate(0, 8.5, -1);
  parts.push(tint(keep, stone));
  const kc = new THREE.ConeGeometry(3.8, 4.4, 8);
  kc.translate(0, 19.4, -1);
  parts.push(tint(kc, roof));
  return merge(parts);
}

function volcanoParts(rockCol, lava) {
  const parts = [];
  const cone = new THREE.ConeGeometry(26, 30, 9);
  cone.translate(0, 15, 0);
  parts.push(tint(cone, rockCol));
  const rim = new THREE.ConeGeometry(9, 5, 9);
  rim.translate(0, 27.4, 0);
  parts.push(tint(rim, lava));
  return { body: merge(parts), glow: tint(new THREE.SphereGeometry(5.6, 12, 8).translate(0, 25.5, 0), 0xff5a1e) };
}

function lighthouseParts(white, red) {
  const parts = [];
  const tower = new THREE.CylinderGeometry(1.5, 2.8, 16, 10);
  tower.translate(0, 8, 0);
  parts.push(tint(tower, white));
  for (let i = 0; i < 3; i++) {
    const band = new THREE.CylinderGeometry(lerp(2.4, 1.7, i / 2), lerp(2.6, 1.8, i / 2), 1.6, 10);
    band.translate(0, 3 + i * 5, 0);
    parts.push(tint(band, red));
  }
  const room = new THREE.CylinderGeometry(1.8, 1.8, 2.4, 8);
  room.translate(0, 17.4, 0);
  parts.push(tint(room, 0x14203a));
  const lamp = new THREE.SphereGeometry(1.5, 10, 8);
  lamp.translate(0, 17.4, 0);
  parts.push(tint(lamp, 0xffe9a8));
  const roof = new THREE.ConeGeometry(2.2, 2.2, 8);
  roof.translate(0, 19.4, 0);
  parts.push(tint(roof, red));
  return merge(parts);
}

function balloonParts(canopy, basket) {
  const parts = [];
  const env = new THREE.SphereGeometry(6, 12, 10);
  env.scale(1, 1.25, 1);
  env.translate(0, 8, 0);
  parts.push(tint(env, canopy));
  const ropes = new THREE.CylinderGeometry(0.16, 0.16, 3, 4);
  ropes.translate(0, 3.2, 0);
  parts.push(tint(ropes, 0x3a3f4a));
  const b = new THREE.BoxGeometry(2.4, 2, 2.4);
  b.translate(0, 1.2, 0);
  parts.push(tint(b, basket));
  return merge(parts);
}

function rainbowGeometry() {
  const parts = [];
  const cols = [0xff4d4d, 0xffa24d, 0xffe14d, 0x5cff6a, 0x4dd2ff, 0x6a7bff, 0xc46aff];
  for (let i = 0; i < cols.length; i++) {
    parts.push(tint(new THREE.TorusGeometry(44 - i * 4.4, 2.0, 6, 40, Math.PI), cols[i]));
  }
  return merge(parts);
}

/* ----------------------------------------------------------- buildDecor */

/**
 * @param {object} ctx game ctx
 * @param {object} def TrackDef
 * @param {TrackPath} path
 * @param {THREE.Object3D} group container (already inside worldRoot)
 * @returns {{dispose():void, animate:()=>void, group:THREE.Group}}
 */
export function buildDecor(ctx, def, path, group) {
  const scene = ctx.scene;
  const theme = def.theme || {};
  const decor = def.decor || {};
  const skyTheme = theme.sky || {};
  const quality = ctx.quality || {};
  const root = new THREE.Group();
  root.name = 'decor';
  if (group && group.add) group.add(root);

  const assets = [];
  const keep = (o) => {
    if (o) assets.push(o);
    return o;
  };
  const rng = mulberry32(0x9e37 + (def.id ? def.id.length * 7919 : 0));

  /* --------------------------------------------------------------- sky */

  const elevation = Number.isFinite(skyTheme.sunElevation) ? skyTheme.sunElevation : 0.4;
  const azimuth = Number.isFinite(skyTheme.sunAzimuth) ? skyTheme.sunAzimuth : 1.0;
  const sunPos = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elevation, azimuth);

  const skyMesh = new Sky();
  skyMesh.scale.setScalar(400000);
  const u = skyMesh.material.uniforms;
  const night = def.timeOfDay === 'night';
  u.turbidity.value = night ? 6 : 3.2;
  u.rayleigh.value = night ? 0.6 : 2.4;
  u.mieCoefficient.value = 0.006;
  u.mieDirectionalG.value = 0.85;
  u.sunPosition.value.copy(sunPos);
  u.up.value.set(0, 1, 0);
  root.add(skyMesh);

  /* --------------------------------------------------------------- fog */

  const fogDef = theme.fog || {};
  const prevFog = scene.fog;
  if (Number.isFinite(fogDef.near) && Number.isFinite(fogDef.far)) {
    scene.fog = new THREE.Fog(colorOf(fogDef.color, 0xffffff).getHex(), fogDef.near, fogDef.far);
  } else {
    scene.fog = new THREE.FogExp2(colorOf(fogDef.color, 0xffffff).getHex(), Number.isFinite(fogDef.density) ? fogDef.density : 0.002);
  }

  /* ------------------------------------------------------ environment */

  let envTarget = null;
  const prevEnv = scene.environment;
  try {
    if (ctx.renderer) {
      const pmrem = new THREE.PMREMGenerator(ctx.renderer);
      const envScene = new THREE.Scene();
      envScene.add(skyMesh);
      envTarget = pmrem.fromScene(envScene, 0, 1, 100000);
      scene.environment = envTarget.texture;
      pmrem.dispose();
    }
  } catch (err) {
    /* the env map is cosmetic */
  }

  /* -------------------------------------------------------------- sun */

  const game = ctx.game;
  const sunColor = colorOf(skyTheme.sun, 0xffffff);
  const sunIntensity = Number.isFinite(skyTheme.sunIntensity) ? skyTheme.sunIntensity : 2.2;
  if (game && game.sun) {
    game.sun.color.copy(sunColor);
    game.sun.intensity = sunIntensity;
    if (game._sunOffset) game._sunOffset.copy(sunPos).multiplyScalar(120);
  } else {
    const sun = new THREE.DirectionalLight(sunColor.getHex(), sunIntensity);
    sun.position.copy(sunPos).multiplyScalar(120);
    sun.castShadow = quality.shadows === true;
    root.add(sun);
    root.add(sun.target);
  }
  if (game && game.hemi) {
    game.hemi.color.copy(colorOf(skyTheme.horizon, 0xbfd8ff));
    game.hemi.groundColor.copy(colorOf(theme.terrain, 0x3b5a2a));
    game.hemi.intensity = night ? 0.55 : 0.72;
  }
  if (game && game.ambient) game.ambient.intensity = night ? 0.24 : 0.14;
  if (game && game.fill) {
    game.fill.color.copy(colorOf(skyTheme.horizon, 0x88aaff));
    game.fill.intensity = night ? 0.6 : 0.35;
  }

  /* ------------------------------------------------ placement helpers */

  const fr = {
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
  const vec = new THREE.Vector3();
  const loc = { progress: 0, lateral: 0, index: 0, surface: 'road' };
  const W = path.width;

  function groundAt(x, z) {
    return path.surfaceHeight(x, z);
  }

  /** Off the tarmac, and on ground gentle enough to stand on. */
  function isPlantable(x, z, minLateral) {
    const h = groundAt(x, z);
    const r = path.locate(x, h, z, loc);
    if (Math.abs(r.lateral) < minLateral) return false;
    if (Math.abs(groundAt(x + 2.5, z) - h) > 1.1) return false;
    if (Math.abs(groundAt(x, z + 2.5) - h) > 1.1) return false;
    return true;
  }

  const dummy = new THREE.Object3D();
  const tintCol = new THREE.Color();

  /** Deterministically fill an InstancedMesh inside a lateral band. */
  function fill(mesh, count, minLat, maxLat, ok, cb) {
    let n = 0;
    let guard = 0;
    const limit = count * 40 + 600;
    while (n < count && guard++ < limit) {
      const p = rng();
      const side = rng() < 0.5 ? -1 : 1;
      const lat = side * (minLat + rng() * (maxLat - minLat));
      const f = path.frameAt(p, fr);
      path.positionAt(p, lat, vec);
      if (!ok(vec.x, vec.z, lat)) continue;
      const y = groundAt(vec.x, vec.z);
      cb(vec.x, y, vec.z, f, p, lat, n);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return n;
  }

  /* ----------------------------------------------------------- foliage */

  const treeType = decor.treeType || 'pine';
  const treeCount = Math.round((path.length / 100) * (Number.isFinite(decor.treeDensity) ? decor.treeDensity : 22));
  if (treeCount > 0) {
    const trunkCol = 0x5b4632;
    let geo = null;
    if (treeType === 'pine') geo = pineGeometry(trunkCol, 0x2f6b3c);
    else if (treeType === 'maple') geo = mapleGeometry(trunkCol, 0x8a4a22, 0xc4702a);
    else if (treeType === 'palm') geo = palmGeometry(0x8a7a5a, 0x3f9a56);
    else geo = cactusGeometry(0x4b7a4a, 0x356b3a);
    if (geo) {
      keep(geo);
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.02, flatShading: true });
      keep(mat);
      const mesh = new THREE.InstancedMesh(geo, mat, treeCount);
      mesh.name = 'trees';
      mesh.castShadow = quality.shadows !== false;
      mesh.receiveShadow = true;
      fill(
        mesh,
        treeCount,
        W + 4.5,
        W + 120,
        (x, z) => isPlantable(x, z, W + 3.5),
        (x, y, z, f, p, lat, n) => {
          dummy.position.set(x, y - 0.15, z);
          dummy.rotation.set(0, rng() * TAU, 0);
          const s = lerp(0.72, 1.5, rng());
          dummy.scale.set(s * (0.85 + rng() * 0.3), s, s * (0.85 + rng() * 0.3));
          dummy.updateMatrix();
          mesh.setMatrixAt(n, dummy.matrix);
          tintCol.setHSL(0.24 + rng() * 0.1, 0.42 + rng() * 0.2, 0.5 + rng() * 0.16);
          mesh.setColorAt(n, tintCol);
        }
      );
      root.add(mesh);
    }
  }

  /* ------------------------------------------------------------- rocks */

  const rockCount = Math.round((path.length / 100) * (Number.isFinite(decor.rockDensity) ? decor.rockDensity : 8));
  if (rockCount > 0) {
    const geo = rockGeometry(0x7a7f8a, 0x9aa0aa);
    keep(geo);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02, flatShading: true });
    keep(mat);
    const mesh = new THREE.InstancedMesh(geo, mat, rockCount);
    mesh.name = 'rocks';
    mesh.castShadow = quality.shadows !== false;
    mesh.receiveShadow = true;
    fill(
      mesh,
      rockCount,
      W + 2.2,
      W + 70,
      (x, z) => isPlantable(x, z, W + 1.8),
      (x, y, z, f, p, lat, n) => {
        const s = 0.5 + rng() * 1.7;
        dummy.position.set(x, y + s * 0.3, z);
        dummy.rotation.set(rng() * 0.4, rng() * TAU, rng() * 0.4);
        dummy.scale.set(s * (0.8 + rng() * 0.5), s * (0.6 + rng() * 0.5), s * (0.8 + rng() * 0.5));
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        tintCol.setHSL(0.6, 0.05, 0.4 + rng() * 0.3);
        mesh.setColorAt(n, tintCol);
      }
    );
    root.add(mesh);
  }

  /* ------------------------------------------------------------ bushes */

  {
    const bushCount = Math.round(path.length * 0.5);
    const geo = bushGeometry(0x4a7a3a, 0x6d8a3a);
    keep(geo);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true });
    keep(mat);
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, bushCount));
    mesh.name = 'bushes';
    mesh.receiveShadow = true;
    fill(
      mesh,
      bushCount,
      W + 1.8,
      W + 26,
      (x, z) => isPlantable(x, z, W + 1.6),
      (x, y, z, f, p, lat, n) => {
        const s = 0.7 + rng() * 1.1;
        dummy.position.set(x, y - 0.1, z);
        dummy.rotation.set(0, rng() * TAU, 0);
        dummy.scale.set(s, s * (0.7 + rng() * 0.5), s);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        tintCol.setHSL(0.26 + rng() * 0.08, 0.4, 0.45 + rng() * 0.2);
        mesh.setColorAt(n, tintCol);
      }
    );
    root.add(mesh);
  }

  /* -------------------------------------------------------- spectators */

  const rows = Number.isFinite(decor.spectatorRows) ? decor.spectatorRows : 4;
  const specCount = Math.round(rows * 26);
  let specUniform = null;
  if (specCount > 0) {
    const geo = spectatorGeometry();
    keep(geo);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.02 });
    keep(mat);
    const mesh = new THREE.InstancedMesh(geo, mat, specCount);
    mesh.name = 'spectators';
    mesh.frustumCulled = false;
    const phases = new Float32Array(specCount);
    fill(
      mesh,
      specCount,
      W + 2.4,
      W + 5.5,
      () => true,
      (x, y, z, f, p, lat, n) => {
        dummy.position.set(x, y, z);
        dummy.rotation.set(0, Math.atan2(-f.tangent.x, -f.tangent.z) + Math.PI, 0);
        const s = 0.92 + rng() * 0.2;
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        tintCol.setHSL(rng(), 0.62, 0.55);
        mesh.setColorAt(n, tintCol);
        phases[n] = rng() * TAU;
      }
    );
    // crowd bob driven entirely on the GPU
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    specUniform = { value: 0 };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = specUniform;
      shader.vertexShader =
        'attribute float aPhase;\nuniform float uTime;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n transformed.y += sin(uTime * 2.3 + aPhase) * 0.13;\n transformed.x += cos(uTime * 1.7 + aPhase) * 0.045;'
        );
    };
    mat.customProgramCacheKey = () => 'kr-spectator-bob';
    mesh.onBeforeRender = () => {
      specUniform.value = (game && Number.isFinite(game.time) && game.time) || performance.now() * 0.001;
    };
    root.add(mesh);
  }

  /* ---------------------------------------------------------- banners */

  const bannerCount = Math.max(0, Math.min(40, Math.round(decor.banners || 8)));
  if (bannerCount > 0) {
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.11, 6.4, 5);
    poleGeo.translate(0, 3.2, 0);
    keep(poleGeo);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, roughness: 0.5, metalness: 0.6 });
    keep(poleMat);
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, bannerCount * 2);
    poles.name = 'banner-poles';
    poles.castShadow = quality.shadows !== false;

    const flagGeo = new THREE.PlaneGeometry(3.6, 0.95);
    keep(flagGeo);
    const flagTex = bannerTexture(def.name || 'KART RUSH', (def.cup || 'STAR CUP').toUpperCase(), '#131a38', '#ffd60a', '#ff3b30');
    keep(flagTex);
    const flagMat = new THREE.MeshStandardMaterial({ map: flagTex, roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide });
    keep(flagMat);
    const flags = new THREE.InstancedMesh(flagGeo, flagMat, bannerCount);
    flags.name = 'banners';

    let pi = 0;
    for (let i = 0; i < bannerCount; i++) {
      const p = (i + 0.5) / bannerCount;
      const f = path.frameAt(p, fr);
      const yaw = Math.atan2(-f.tangent.x, -f.tangent.z);
      const rl = Math.hypot(f.right.x, f.right.z) || 1;
      const lat = (i % 2 === 0 ? -1 : 1) * (W + 3.4);
      path.positionAt(p, lat, vec);
      const y = Math.max(groundAt(vec.x, vec.z), f.position.y - 0.5);
      for (const s of [-1, 1]) {
        dummy.position.set(vec.x + (f.right.x / rl) * s * 0.35, y, vec.z + (f.right.z / rl) * s * 0.35);
        dummy.rotation.set(0, yaw, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        poles.setMatrixAt(pi++, dummy.matrix);
      }
      dummy.position.set(vec.x, y + 5.5, vec.z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      flags.setMatrixAt(i, dummy.matrix);
    }
    poles.count = pi;
    flags.count = bannerCount;
    poles.instanceMatrix.needsUpdate = true;
    flags.instanceMatrix.needsUpdate = true;
    poles.computeBoundingSphere();
    flags.computeBoundingSphere();
    root.add(poles);
    root.add(flags);
  }

  /* -------------------------------------------------------- landmarks */

  const bd = path.bounds;
  const cx = (bd.min[0] + bd.max[0]) * 0.5;
  const cz = (bd.min[2] + bd.max[2]) * 0.5;
  const span = Math.max(bd.max[0] - bd.min[0], bd.max[2] - bd.min[2]);
  const names = Array.isArray(decor.landmarks) && decor.landmarks.length ? decor.landmarks : ['castle'];
  let windBlades = null;
  let spin = 0;
  for (let li = 0; li < names.length; li++) {
    const name = names[li];
    const angle = (li / names.length) * TAU + 0.6;
    const dist = span * 0.62 + 130 + rng() * 120;
    const x = cx + Math.cos(angle) * dist;
    const z = cz + Math.sin(angle) * dist;
    const y = Math.min(groundAt(x, z), path.meanY);
    const yaw = rng() * TAU;
    let geo = null;
    let mat = null;
    let mesh = null;
    if (name === 'windmill') {
      const p = windmillParts(0xe8dfd0, 0x8a4a3a, 0x3a2f28);
      geo = keep(p.body);
      mat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02 }));
      const bladeMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 }));
      keep(p.blades);
      mesh = new THREE.Mesh(geo, mat);
      // The rotor has to be a CHILD of the tower: its hub sits at local
      // (0, 12.4, 2.2), which only becomes the right world position once the
      // body's own rotation is applied. As a sibling it landed 4.4 m away from
      // the hub and spun about an axis 90 degrees off it, so the blades stood
      // edge-on to the windmill and visibly detached.
      windBlades = new THREE.Mesh(p.blades, bladeMat);
      windBlades.position.set(0, 12.4, 2.2);
      windBlades.name = 'windmill-blades';
      mesh.add(windBlades);
    } else if (name === 'volcano') {
      const p = volcanoParts(0x4a3a3a, 0x7a3030);
      geo = keep(p.body);
      mat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 }));
      const glowMat = keep(new THREE.MeshStandardMaterial({ color: 0xff5a1e, emissive: 0xff4a10, emissiveIntensity: 2.2, roughness: 0.5 }));
      keep(p.glow);
      const glow = new THREE.Mesh(p.glow, glowMat);
      glow.position.set(x, y, z);
      glow.rotation.y = yaw;
      root.add(glow);
    } else if (name === 'lighthouse') {
      geo = keep(lighthouseParts(0xf0f2f6, 0xd8322a));
      mat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.04 }));
    } else if (name === 'balloon') {
      geo = keep(balloonParts(0xff5a7a, 0x8a5a2a));
      mat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.02 }));
      const s = 1 + rng() * 0.6;
      geo.scale(s, s, s);
    } else if (name === 'rainbow') {
      geo = keep(rainbowGeometry());
      mat = keep(
        new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide })
      );
    } else {
      geo = keep(castleParts(0xb9b2a6, 0x6a4a8a));
      mat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.02 }));
    }
    if (geo) {
      const instance = mesh || new THREE.Mesh(geo, mat);
      instance.position.set(x, y, z);
      instance.rotation.y = yaw;
      instance.name = 'landmark-' + name;
      root.add(instance);
    }
  }

  /* ------------------------------------------------------------ water */

  if (theme.water != null) {
    const level = Number.isFinite(def.waterLevel) ? def.waterLevel : path.meanY - 8;
    const normal = waterNormalTexture();
    normal.repeat.set(140, 140);
    keep(normal);
    const mat = new THREE.MeshStandardMaterial({
      color: colorOf(theme.water, 0x0b1c3e),
      roughness: 0.14,
      metalness: 0.72,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.8, 0.8),
      envMapIntensity: 1.4,
      transparent: true,
      opacity: 0.94,
    });
    keep(mat);
    const geo = new THREE.CircleGeometry(2200, 48);
    geo.rotateX(-Math.PI / 2);
    keep(geo);
    const water = new THREE.Mesh(geo, mat);
    water.position.set(cx, level, cz);
    water.name = 'water';
    water.renderOrder = -1;
    root.add(water);
    let wt = 0;
    water.onBeforeRender = () => {
      wt += 0.0004;
      normal.offset.set(wt, wt * 0.6);
    };
  }

  /* ------------------------------------------------------------ stars */

  if (night) {
    const count = 900;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const th = rng() * TAU;
      const ph = Math.acos(rng() * 0.95);
      const r = 1600;
      pos[i * 3] = cx + Math.sin(ph) * Math.cos(th) * r;
      pos[i * 3 + 1] = Math.cos(ph) * r * 0.9 + 120;
      pos[i * 3 + 2] = cz + Math.sin(ph) * Math.sin(th) * r;
      const bb = 0.55 + rng() * 0.45;
      col[i * 3] = bb;
      col[i * 3 + 1] = bb * 0.92;
      col[i * 3 + 2] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    keep(g);
    const m = new THREE.PointsMaterial({
      size: 8,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      fog: false,
    });
    keep(m);
    const stars = new THREE.Points(g, m);
    stars.name = 'stars';
    stars.frustumCulled = false;
    root.add(stars);
  }

  /* -------------------------------------------------------- animation */

  // Driven from onBeforeRender so the world animates even when nobody calls
  // animate() (Bootstrap ignores the return value of buildDecor).
  if (windBlades) {
    const blades = windBlades;
    blades.onBeforeRender = () => {
      spin += 0.006;
      // The hub axis is local X (it is a cylinder rotated onto its side), so the
      // rotor turns about X. It used to turn about Z, which is the plane the four
      // blades lie in — the whole rotor wobbled edge-on instead of spinning.
      blades.rotation.x = spin;
    };
  }
  const animate = () => {
    if (specUniform) specUniform.value = (game && Number.isFinite(game.time) && game.time) || performance.now() * 0.001;
  };

  /* ---------------------------------------------------------- dispose */

  const dispose = () => {
    for (const d of assets) d?.dispose?.();
    if (envTarget) envTarget.dispose?.();
    scene.environment = prevEnv;
    scene.fog = prevFog;
    root.removeFromParent?.();
    root.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh || o.isPoints) {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) m?.dispose?.();
      }
    });
    root.clear();
  };

  return { dispose, animate, group: root };
}

export default buildDecor;
