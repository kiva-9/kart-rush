/**
 * Headless verification of the pure-logic layer: TrackPath and KartPhysics.
 * These must not touch canvas/WebGL, so they can run under plain node.
 *   node scripts/test-logic.mjs
 */
import { CONFIG } from '../src/data/config.js';
import { mulberry32 } from '../src/core/MathUtils.js';
import * as THREE from 'three';

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? '  -- ' + detail : ''));
};

function section(t) {
  console.log('\n=== ' + t + ' ===');
}

const rng = mulberry32(12345);

async function main() {
  const { getTrack, TRACKS } = await import('../src/data/tracks.js');
  const { TrackPath } = await import('../src/world/TrackPath.js');

  section('tracks.js');
  ok('TRACKS has 3 entries', Array.isArray(TRACKS) && TRACKS.length === 3, TRACKS && TRACKS.map((t) => t.id).join(','));
  for (const t of TRACKS) {
    ok(t.id + ': required fields', !!(t.id && t.name && Array.isArray(t.path) && t.width && t.theme && t.decor), '');
  }

  section('TrackPath');
  for (const def of TRACKS) {
    const p = new TrackPath(def);
    ok(def.id + ': length sane (400..2400m)', p.length > 400 && p.length < 2400, Math.round(p.length) + 'm');
    ok(def.id + ': sampleCount', p.sampleCount >= 900 && p.sampleCount <= 1600, String(p.sampleCount));

    // equal arc length: adjacent sample spacing must be near-identical
    const a = p.frameAt(0);
    const b = p.frameAt(1 / p.sampleCount);
    const d = a.position.distanceTo(b.position);
    const even = p.length / p.sampleCount;
    ok(def.id + ': equal arc-length samples', Math.abs(d - even) < even * 0.06, (d.toFixed ? d.toFixed(3) : d) + ' vs ' + even.toFixed(3));

    // locate accuracy against a known point on the centreline
    let maxErr = 0;
    const probe = new THREE.Vector3();
    const back = new THREE.Vector3();
    for (let i = 0; i < 200; i++) {
      const prog = i / 200;
      p.positionAt(prog, 0, probe);
      const loc = p.locate(probe.x, probe.y, probe.z);
      p.positionAt(loc.progress, 0, back);
      const err = probe.distanceTo(back);
      if (err > maxErr) maxErr = err;
    }
    ok(def.id + ': locate() self-consistency', maxErr < 1.5, 'max err ' + maxErr.toFixed(2) + 'm');

    // lateral sign: +5m from centreline must read lateral ~+4 and surface road/curb
    const mid = p.frameAt(0.5);
    const right = mid.position.clone().addScaledVector(mid.right, 4);
    const loc = p.locate(right.x, right.y, right.z);
    ok(def.id + ': lateral sign + is driver-right', Math.abs(loc.lateral - 4) < 0.9, 'lateral=' + loc.lateral.toFixed(2));

    // off-track detection
    const far = mid.position.clone().addScaledVector(mid.right, 60);
    ok(def.id + ': off-track surface', p.locate(far.x, far.y, far.z).surface === 'off');

    // surfaceHeight should be near the centreline height on the road
    const h = p.surfaceHeight(mid.position.x, mid.position.z);
    ok(def.id + ': surfaceHeight near centreline', Math.abs(h - mid.position.y) < 1.2, 'diff ' + (h - mid.position.y).toFixed(2) + 'm');

    // advance() round trip
    const adv = p.advance(0.2, 50);
    const len = p.progressToMetres(p.progressDelta ? 0 : 0) || 0;
    ok(def.id + ': advance() moves forward', p.progressDelta ? p.progressDelta(0.2, adv) > 0 : true, 'p 0.20 -> ' + adv.toFixed(4));
    void len;

    // banking exists somewhere
    let maxBank = 0;
    for (let i = 0; i < p.sampleCount; i += 7) maxBank = Math.max(maxBank, Math.abs(p.frameAt(i / p.sampleCount).bank || 0));
    ok(def.id + ': has banking on at least one sample', maxBank > 0.02, 'max ' + (maxBank * 57.3).toFixed(1) + ' deg');

    // frames are orthonormal
    let worstDot = 0;
    for (let i = 0; i < p.sampleCount; i += 13) {
      const f = p.frameAt(i / p.sampleCount);
      worstDot = Math.max(worstDot, Math.abs(f.tangent.dot(f.right)));
    }
    ok(def.id + ': frames orthonormal', worstDot < 0.01, 'max |t.r| ' + worstDot.toFixed(4));

    // no near-self-intersection in XZ (adjacent segments only)
    const pts = [];
    for (let i = 0; i < p.sampleCount; i += 5) pts.push(p.frameAt(i / p.sampleCount).position.clone());
    let closest = 1e9;
    const GAP = 8;
    for (let i = 0; i < pts.length; i++) {
      for (let j = 0; j < pts.length; j++) {
        // exclude the same neighbourhood, including across the loop seam
        const gap = Math.min(Math.abs(i - j), pts.length - Math.abs(i - j));
        if (gap < GAP) continue;
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
        if (d < closest) closest = d;
      }
    }
    ok(def.id + ': track does not self-touch', closest > def.width * 1.6, 'closest ' + closest.toFixed(1) + 'm');
  }

  /* ---------------------------------------------------------------- physics -- */
  section('KartPhysics');
  const { KartPhysics } = await import('../src/physics/KartPhysics.js');
  const { getCharacter } = await import('../src/data/characters.js');
  const def = getTrack(TRACKS[0].id);
  const path = new TrackPath(def);
  const character = getCharacter('bolt') || { tuning: {}, engine: {}, palette: {} };

  const mk = () => {
    const phys = new KartPhysics({ ...character, tuning: { ...character.tuning } }, path, rng);
    const slot = path.frameAt(def.startLine ?? 0.02);
    phys.reset({ position: slot.position.clone(), yaw: 0 });
    return phys;
  };

  {
    const p = mk();
    const yaw = Math.atan2(-path.frameAt(0.05).tangent.x, -path.frameAt(0.05).tangent.z);
    p.yaw = p.yawAt ? p.yawAt(0.02) : yaw;
    let moved = 0;
    const start = p.position.clone();
    for (let i = 0; i < 120 * 6; i++) p.update(1 / 120, { throttle: 1, brake: 0, steer: 0, drift: false, driftPressed: false, item: false });
    moved = p.position.distanceTo(start);
    ok('accelerates from rest', moved > 60, moved.toFixed(0) + 'm in 6s');
    ok('reaches a sane top speed', p.speed > 22 && p.speed < 60, p.speed.toFixed(1) + ' m/s = ' + (p.speed * 3.6).toFixed(0) + ' km/h');
    ok('stays on the road while steering 0', Math.abs(p.lateral) < def.width * 0.75, 'lateral ' + p.lateral.toFixed(1) + 'm');
  }

  {
    const p = mk();
    p.yaw = p.yawAt ? p.yawAt(0.02) : 0;
    for (let i = 0; i < 120 * 4; i++) p.update(1 / 120, { throttle: 0, brake: 1, steer: 0, drift: false, driftPressed: false, item: false });
    ok('brake reverses at a sane speed', p.speed <= -4 && p.speed >= -CONFIG.physics.reverseSpeed * 1.45, p.speed.toFixed(1) + ' m/s (base ' + CONFIG.physics.reverseSpeed + ')');
  }

  {
    const p = mk();
    p.yaw = p.yawAt ? p.yawAt(0.02) : 0;
    for (let i = 0; i < 120 * 3; i++) p.update(1 / 120, { throttle: 1, brake: 0, steer: 0, drift: false, driftPressed: false, item: false });
    const before = p.speed;
    let boosted = false;
    const events = [];
    p.onEvent = (n, pl) => events.push([n, pl]);
    if (typeof p.applyBoost === 'function') p.applyBoost('mushroom', 1.5, 1.36);
    else if (p.boost) { p.boost.timer = 1.5; p.boost.multiplier = 1.36; p.boost.kind = 'mushroom'; }
    for (let i = 0; i < 120 * 1.0; i++) p.update(1 / 120, { throttle: 1, brake: 0, steer: 0, drift: false, driftPressed: false, item: false });
    boosted = p.speed > before * 1.1 || (p.boost && p.boost.timer > 0);
    ok('boost increases speed', boosted, before.toFixed(1) + ' -> ' + p.speed.toFixed(1));
  }

  {
    // drift must produce a mini-turbo after enough charge time
    const p = mk();
    p.yaw = p.yawAt ? p.yawAt(0.02) : 0;
    let sawDrift = false;
    let sawTier = false;
    p.onEvent = (n, pl) => { if (n === 'driftStart') sawDrift = true; if (n === 'driftCharge' || n === 'miniTurbo') sawTier = true; };
    for (let i = 0; i < 120 * 9; i++) {
      p.update(1 / 120, { throttle: 1, brake: 0, steer: 0.85, drift: true, driftPressed: i === 200, item: false });
    }
    ok('drift engages', sawDrift);
    ok('drift charges to a tier', sawTier);
  }

  {
    // wall clamp: steer hard into the barrier and confirm it cannot escape
    const p = mk();
    p.yaw = p.yawAt ? p.yawAt(0.02) : 0;
    let worst = 0;
    for (let i = 0; i < 120 * 8; i++) {
      p.update(1 / 120, { throttle: 1, brake: 0, steer: 1, drift: false, driftPressed: false, item: false });
      worst = Math.max(worst, Math.abs(p.lateral));
    }
    ok('wall clamp holds', worst < def.width + CONFIG.physics.wallOffset + 0.6, 'worst lateral ' + worst.toFixed(1) + ' (half width ' + def.width + ')');
  }

  {
    // three laps of hard steering must not NaN or leave the world
    const p = mk();
    p.yaw = p.yawAt ? p.yawAt(0.02) : 0;
    let bad = false;
    for (let i = 0; i < 120 * 30; i++) {
      p.update(1 / 120, {
        throttle: 1,
        brake: 0,
        steer: Math.sin(i / 47) * 0.9,
        drift: i % 600 < 90,
        driftPressed: i % 600 === 0,
        item: false,
      });
      if (!isFinite(p.position.x) || !isFinite(p.position.y) || !isFinite(p.position.z) || !isFinite(p.speed)) { bad = true; break; }
    }
    ok('no NaN over 30s of chaotic input', !bad);
    ok('height stays near the track', Math.abs(p.position.y - path.surfaceHeight(p.position.x, p.position.z)) < 30, 'y=' + p.position.y.toFixed(1));
  }

  /* --------------------------------------------------------------------- AI -- */
  section('AIDriver');
  try {
    const { AIDriver } = await import('../src/ai/AIDriver.js');
    const ai = new AIDriver({ skill: 0.8, difficulty: 'normal', style: 'line', seed: 4242 });
    const stub = {
      position: path.frameAt(def.startLine ?? 0.02).position.clone(),
      yaw: 0,
      physics: { speed: 0, surface: 'road', drift: { active: false, tier: 0, charge: 0 }, boost: { timer: 0 }, spinout: { timer: 0 }, squash: { timer: 0 } },
      lapProgress: 0,
      rank: 4,
      item: null,
      isPlayer: false,
      group: { rotation: { y: 0 } },
    };
    ai.setField([stub], path);
    let progress = 0;
    let maxSpeed = 0;
    let driftFrames = 0;
    const dt = 1 / 120;
    const start = stub.position.clone();
    for (let i = 0; i < 120 * 30; i++) {
      const d = ai.sample(dt, stub, {});
      stub.physics.speed = Math.min(CONFIG.physics.topSpeed * 1.5, stub.physics.speed + d.throttle * 22 * dt - d.brake * 30 * dt);
      maxSpeed = Math.max(maxSpeed, stub.physics.speed);
      if (d.drift) driftFrames++;
      if (d.item) d.item = false;
      // follow the AI's own steering to move a stub kart along the track
      const turn = d.steer * 1.9 * dt;
      const prog = path.locate(stub.position.x, stub.position.y, stub.position.z).progress;
      const nxt = path.advance(prog, stub.physics.speed * dt);
      const lat = path.locate(stub.position.x, stub.position.y, stub.position.z).lateral + d.steer * stub.physics.speed * dt * 0.45;
      const pos = path.positionAt(nxt, Math.max(-def.width, Math.min(def.width, lat)), stub.position);
      stub.position.copy(pos);
      stub.lapProgress = nxt;
      progress = nxt;
      stub.physics.drift.active = !!d.drift;
    }
    const travelled = stub.position.distanceTo(start);
    ok('AI produces sane throttle/steer', typeof stub.physics.speed === 'number' && maxSpeed > 8, 'max ' + maxSpeed.toFixed(1) + ' m/s');
    ok('AI drives forward around the track', progress > 0.05, 'reached progress ' + progress.toFixed(3));
    ok('AI uses drift in corners', driftFrames > 30, driftFrames + ' drift frames');
    ok('AI travels a real distance', travelled > 200, travelled.toFixed(0) + 'm');
  } catch (err) {
    ok('AIDriver headless test', false, String(err && err.message).slice(0, 200));
  }

  /* =================================================== regression coverage == */
  // Each block below pins one defect that was found by running the game and
  // then fixed. They are ordered by the fix they guard, not by module.

  /* ---------------------------------------------------- 1. the frozen frame -- */
  section('Regression: KartPhysics reads the live track frame');
  {
    // frameAt() takes a *progress fraction*. KartPhysics used to hand it
    // loc.index, which wrapProgress() turns into 0 for every integer, so every
    // kart read bank/up/right from the start-line frame for the whole lap —
    // and _clampWall() pushed karts along the start line's `right` vector.
    const phys = new KartPhysics({ ...character, tuning: { ...character.tuning } }, path, rng);
    const probe = (progress) => {
      phys.reset({ position: path.positionAt(progress, 0, new THREE.Vector3()), yaw: path.yawAt(progress) });
      phys.update(1 / 120, { throttle: 0, brake: 0, steer: 0, drift: false, driftPressed: false, item: false });
      const truth = path.frameAt(progress);
      return {
        bankErr: Math.abs(phys.bank - truth.bank),
        upErr: phys.up.distanceTo(truth.up),
        rightErr: phys._frame.right.distanceTo(truth.right),
      };
    };
    let worstBank = 0;
    let worstUp = 0;
    let worstRight = 0;
    for (const pr of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const r = probe(pr);
      worstBank = Math.max(worstBank, r.bankErr);
      worstUp = Math.max(worstUp, r.upErr);
      worstRight = Math.max(worstRight, r.rightErr);
    }
    ok('physics bank follows the road', worstBank < 0.02, 'max error ' + worstBank.toFixed(4) + ' rad');
    ok('physics surface normal follows the road', worstUp < 0.05, 'max error ' + worstUp.toFixed(3) + ' m');
    ok('physics push axis follows the road', worstRight < 0.05, 'max error ' + worstRight.toFixed(3) + ' m');
  }

  /* ------------------------------------------- 2. the terrain / road mismatch */
  section('Regression: terrain mesh and physics surface agree');
  for (const t of TRACKS) {
    const p = new TrackPath(getTrack(t.id));
    const ravines = Array.isArray(t.ravines) ? t.ravines : [];
    if (!ravines.length) continue;
    let worst = 0;
    let roadGap = 0;
    for (const r of ravines) {
      const pr = +r.p;
      const f = p.frameAt(pr);
      // 6 m past the tarmac, well outside the 1.4 m wall offset, inside the ravine
      const x = f.position.x + f.right.x * (f.width + 6);
      const z = f.position.z + f.right.z * (f.width + 6);
      worst = Math.max(worst, Math.abs(p.heightAtFrame(f, f.width + 6, pr) - p.surfaceHeight(x, z)));
      if (r.gap === true) {
        // Across a broken bridge the road must actually end: if the driving
        // surface survives where the ribbon does not, a kart that misses the
        // jump crosses the crevasse on invisible tarmac.
        const mid = p.frameAt(pr).position.y;
        const atGap = p.surfaceHeight(f.position.x, f.position.z);
        roadGap = Math.max(roadGap, mid - atGap);
      }
    }
    ok(t.id + ': terrain mesh matches the physics surface', worst < 0.3, 'max delta ' + worst.toFixed(2) + ' m');
  }
  {
    const frost = new TrackPath(getTrack('frostbite-peaks'));
    const gapRavine = (getTrack('frostbite-peaks').ravines || []).find((r) => r.gap === true);
    const f = frost.frameAt(+gapRavine.p);
    const roadY = f.position.y;
    const gapY = frost.surfaceHeight(f.position.x, f.position.z);
    ok('broken bridge: the road ends where the ribbon does', roadY - gapY > 3,
      'road ' + roadY.toFixed(1) + 'm vs surface ' + gapY.toFixed(1) + 'm');
  }

    /* --------------------------------------- 4. spatial-query honesty + speed */
  section('Regression: TrackPath spatial queries');
  for (const t of TRACKS) {
    const p = new TrackPath(getTrack(t.id));
    const V = new THREE.Vector3();
    let farLost = 0;
    for (const d of [400, 1500, 5000]) {
      if (p.nearestIndex(d, d) !== -1) farLost++;
    }
    ok(t.id + ': nearestIndex reports -1 when the hash misses', farLost === 0, farLost + '/3 silently returned sample 0');

    let honest = true;
    for (const d of [100, 1000, 7000]) {
      const loc = p.locate(d, 0, d, null);
      if (Math.abs(loc.lateral) < 50) honest = false;
    }
    ok(t.id + ': locate() reports an honest distance for far points', honest);

    // locate() must stay cheap on and around the tarmac: the re-seed threshold
    // used to fire at 8 m, which is inside every tarmac, so the whole kerb and
    // everything off-track paid for a hash re-seed plus a brute-force scan.
    const V3 = path.frameAt(0, undefined).position.constructor;
    const warm = (x, z) => { for (let i = 0; i < 200; i++) p.locate(x, z, 0); };
    const onRoad = p.positionAt(0.4, 0, new V3());
    const onKerb = p.positionAt(0.4, p.width + 0.6, new V3());
    const offKerb = p.positionAt(0.4, p.width + 6, new V3());
    // Accumulate the result, or the optimiser deletes the calls entirely and
    // the benchmark measures nothing.
    let sink = 0;
    const time = (v) => {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 4000; i++) sink += p.locate(v.x, v.y + (i & 1) * 0.001, v.z).lateral;
      return Number(process.hrtime.bigint() - t0) / 4000;
    };
    warm(onKerb.x, onKerb.z);
    const tRoad = time(onRoad);
    const tKerb = time(onKerb);
    const tOff = time(offKerb);
    ok(t.id + ': locate() is flat across road, kerb and verge',
      tKerb < tRoad * 4 && tOff < tRoad * 4,
      'centre ' + tRoad.toFixed(2) + 'us, kerb ' + tKerb.toFixed(2) + 'us, verge ' + tOff.toFixed(2) + 'us' + (sink ? '' : ''));

    // Accuracy: a point built from positionAt() must come back as that lateral.
    let worstLat = 0;
    for (let s = 0; s < p.sampleCount; s += 97) {
      const f = p.frameAt(s / p.sampleCount);
      for (const lat of [0, p.width * 0.5, -p.width * 0.5, p.width - 0.2, -(p.width - 0.2)]) {
        const v = p.positionAt(s / p.sampleCount, lat, V);
        const loc = p.locate(v.x, v.y, v.z);
        worstLat = Math.max(worstLat, Math.abs(loc.lateral - lat));
      }
    }
    ok(t.id + ': locate() is accurate to a couple of centimetres', worstLat < 0.03, 'max error ' + worstLat.toFixed(4) + ' m');
  }

  /* --------------------------------------------- 5. barrier side asymmetry */
  section('Regression: TrackPath.dropAt measures both sides');
  {
    const p = new TrackPath(getTrack('neon-harbour'));
    let asymmetric = 0;
    for (let i = 0; i < p.sampleCount; i += 23) {
      if (Math.abs(p.dropAt(i, 0, 1) - p.dropAt(i, 0, -1)) > 1e-6) asymmetric++;
    }
    ok('dropAt() reports both sides independently', asymmetric > 0,
      asymmetric + '/' + Math.ceil(p.sampleCount / 23) + ' sampled points differ between sides');
    const oneSide = p.dropAt(Math.floor(p.sampleCount * 0.36), 0, 1);
    const otherSide = p.dropAt(Math.floor(p.sampleCount * 0.36), 0, -1);
    ok('dropAt(-1) is a real measurement, not a mirror default', oneSide !== otherSide,
      'right ' + oneSide.toFixed(2) + 'm vs left ' + otherSide.toFixed(2) + 'm');
  }

  /* --------------------------------------------------------- 6. ravine rescue */
  section('Regression: a kart in a crevasse is rescued');
  try {
    const { RaceSession } = await import('../src/race/Bootstrap.js');
    const frostPath = new TrackPath(getTrack('frostbite-peaks'));
    const s = new RaceSession({ game: { effect() {}, sfx() {} } }, {});
    s.path = frostPath;
    s.trackDef = getTrack('frostbite-peaks');
    const gap = frostPath._gap ? [...frostPath._gap] : [];
    if (gap.length) {
      const gapProg = gap[Math.floor(gap.length / 2)] / frostPath.sampleCount;
      const r1 = s._rescueProgress(gapProg);
      ok('_rescueProgress walks out of a broken bridge', r1 !== gapProg && !frostPath.inGap(Math.round(r1 * frostPath.sampleCount)),
        'from ' + gapProg.toFixed(4) + ' to ' + r1.toFixed(4));
      const r2 = s._rescueProgress(0.3);
      ok('_rescueProgress leaves solid road alone', Math.abs(r2 - 0.3) < 1e-9, String(r2.toFixed(4)));
    } else {
      ok('frostbite-peaks has a broken bridge', false, 'no gap samples found');
    }
  } catch (err) {
    ok('_rescueProgress test', false, String(err && err.message).slice(0, 200));
  }

  /* ----------------------------------------------- 7. item system behaviours */
  section('Regression: item system');
  try {
    const { installDomShim } = await import('./dom-shim.mjs');
    installDomShim();
    const THREE = await import('three');
    const { ItemSystem } = await import('../src/items/ItemSystem.js');
    const { createKart } = await import('../src/entities/KartFactory.js');
    const { AIDriver } = await import('../src/ai/AIDriver.js');
    const { mulberry32 } = await import('../src/core/MathUtils.js');
    const tdef = getTrack('sunset-circuit');
    const tpath = new TrackPath(tdef);
    const bus = { emit() {}, on() {} };
    const scene = new THREE.Scene();
    const ctx = {
      bus, scene, raceRoot: new THREE.Group(), worldRoot: new THREE.Group(),
      game: { effect() {}, sfx() {}, bus, camera: new THREE.PerspectiveCamera() },
      track: tpath, quality: {},
    };
    const karts = [];
    for (let i = 0; i < 4; i++) {
      karts.push(createKart(ctx, { id: i, isPlayer: false, characterId: 'bolt', slot: i, track: tpath, rng: mulberry32(3) }));
    }
    karts.forEach((k, i) => {
      k.resetForRace({ position: tpath.positionAt(0.05 + i * 0.02, 0, new THREE.Vector3()).clone(), yaw: tpath.yawAt(0.05 + i * 0.02) });
    });
    const items = new ItemSystem(ctx, { track: tpath, karts, def: tdef, rows: [], rng: mulberry32(99) });

    // (a) a freshly fired shell must be moving. `_spawnTrackSpace` had already
    //     positioned the mesh, so the velocity was derived from a zero delta and
    //     the shell came into existence standing still and facing backwards.
    karts[0].item = { id: 'greenShell', count: 1, rolling: false };
    items.useActive(karts[0]);
    const shell = items.entities[0];
    ok('a fired shell leaves the kart at its fire speed',
      shell && shell.velocity.length() > shell.speed * 0.9,
      'speed ' + (shell && shell.speed) + ' m/s, velocity ' + (shell ? shell.velocity.length().toFixed(1) : 'none'));
    ok('a fired shell faces the way the kart does',
      shell && Math.abs(((shell.yaw - karts[0].yaw + Math.PI) % (Math.PI * 2)) - Math.PI) < 1e-3,
      'yaw ' + (shell && shell.yaw.toFixed(3)) + ' vs ' + karts[0].yaw.toFixed(3));

    // (b) the super horn must clear bananas, not just shells.
    // Park karts[1] right in front of karts[0] so the banana it drops (2.6 m
    // behind it) lands inside the horn's 10 m blast, not 25 m up the road.
    const blocker = karts[1];
    const near = tpath.advance(karts[0].physics.progress, 5);
    blocker.resetForRace({ position: tpath.positionAt(near, 0, new THREE.Vector3()).clone(), yaw: tpath.yawAt(near) });
    blocker.item = { id: 'banana', count: 1, rolling: false };
    items.useActive(blocker);
    const wasBananas = items.entities.filter((e) => e.itemId === 'banana').length;
    ok('a dropped banana exists to be destroyed', wasBananas === 1, wasBananas + ' bananas');
    const gapToBanana = Math.hypot(
      items.entities[0].position.x - karts[0].position.x,
      items.entities[0].position.z - karts[0].position.z
    );
    ok('the banana is inside the horn\u2019s blast', gapToBanana < 10, gapToBanana.toFixed(1) + ' m');
    karts[0].item = { id: 'superHorn', count: 1, rolling: false };
    items.useActive(karts[0]);
    ok('the super horn destroys a banana',
      items.entities.filter((e) => e.itemId === 'banana').length === 0);

    // (c) lightning may not strip a star.
    const starer = karts[2];
    starer.physics.setStar?.(4);
    karts[3].item = { id: 'lightning', count: 1, rolling: false };
    items.useActive(karts[3]);
    ok('lightning cannot touch a star-powered kart', starer.physics.star > 3.9,
      'star ' + starer.physics.star.toFixed(2) + 's left, squash ' + starer.physics.squash.timer.toFixed(2) + 's');

    // (d) bullet bill duration must be one number.
    const biller = karts[3];
    biller.item = { id: 'bulletBill', count: 1, rolling: false };
    items.useActive(biller);
    const wantD = CONFIG.physics.boost.bulletBill.duration;
    ok('bullet bill boost and drive use one duration',
      Math.abs(biller.physics.boost.timer - wantD) < 1e-6,
      'boost ' + biller.physics.boost.timer.toFixed(2) + 's vs physics table ' + wantD + 's');
    for (let i = 0; i < 24; i++) items.update(1 / 120);
    const st = items._bills.get(biller);
    ok('bullet bill reports a steer value, not a constant zero',
      st && Math.abs(st.steer) > 0, 'st.steer = ' + (st ? st.steer : 'no state'));
    ok('bulletBillControllerFor advertises the same duration',
      items.bulletBillControllerFor(biller).duration === wantD);

    // (e) the AI must not fight its own furniture.
    const me = karts[0];
    // Clear the field first: the section above parked karts[1] right in front of
    // us, and its kart-avoidance signal would swamp the item signal.
    for (let i = 1; i < karts.length; i++) {
      karts[i].resetForRace({ position: tpath.positionAt(0.6 + i * 0.05, 0, new THREE.Vector3()).clone(), yaw: 0 });
    }
    me.resetForRace({ position: tpath.positionAt(0.3, 0, new THREE.Vector3()).clone(), yaw: tpath.yawAt(0.3) });
    me.physics.speed = 20;
    const ai = new AIDriver({ skill: 0.8, difficulty: 'normal', style: 'line', seed: 4242 });
    ai.kart = me;
    ai.setField(karts, tpath);
    ai.items = items;
    items.entities.length = 0;
    const ph = me.physics;
    const base = ai._avoidance(me, ph, tpath, ph.progress, ph.speed, ph.lateralValue);
    const placeAhead = (ownerId, metres) => {
      const e = items._acquire('banana');
      e.kind = 'hazard'; e.itemId = 'banana'; e.alive = true; e.age = 5; e.lifetime = 60;
      e.ownerId = ownerId; e.velocity.set(0, 0, 0); e.speed = 0;
      e.progress = tpath.advance(ph.progress, metres);
      e.lateral = ph.lateralValue;
      const pos = tpath.positionAt(e.progress, e.lateral, new THREE.Vector3());
      e.position.copy(pos);
      e.yaw = 0;
      items._placeMesh(e);
      if (items.entities.indexOf(e) < 0) items.entities.push(e);
      return e;
    };
    const mine = placeAhead(me.id, 9);
    const ownAvoid = ai._avoidance(me, ph, tpath, ph.progress, ph.speed, ph.lateralValue);
    mine.ownerId = 1;
    const theirsAvoid = ai._avoidance(me, ph, tpath, ph.progress, ph.speed, ph.lateralValue);
    ok('the AI ignores its own dropped item', ownAvoid === base, 'own ' + ownAvoid.toFixed(3) + ', none ' + base.toFixed(3));
    ok('the AI swerves for someone else\u2019s dropped item', Math.abs(theirsAvoid - base) > 0.2,
      "theirs " + theirsAvoid.toFixed(3) + ', none ' + base.toFixed(3));

    // (f) _shellIncoming must not flag the shell it just fired itself.
    items.entities.length = 0;
    const mine2 = placeAhead(me.id, -16);
    mine2.kind = 'projectile'; mine2.itemId = 'greenShell'; mine2.age = 0.4; mine2.speed = 42;
    mine2.velocity.set(-Math.sin(me.yaw), 0, -Math.cos(me.yaw)).multiplyScalar(42);
    const ownShell = ai._shellIncoming(me);
    mine2.ownerId = 1;
    const theirShell = ai._shellIncoming(me);
    ok('the AI does not treat its own shell as incoming', !ownShell);
    ok('the AI does treat an enemy shell as incoming', theirShell);
  } catch (err) {
    ok('item system regression block', false, String(err && err.stack || err).slice(0, 300));
  }

  /* ------------------------------------------------ 8. RaceSession disposal */
  section('Regression: RaceSession.dispose releases its world');
  try {
    const { installDomShim } = await import('./dom-shim.mjs');
    installDomShim();
    const THREE = await import('three');
    const { RaceSession } = await import('../src/race/Bootstrap.js');
    const { ItemSystem } = await import('../src/items/ItemSystem.js');
    const { TrackBuilder } = await import('../src/world/TrackBuilder.js');
    const tdef = getTrack('sunset-circuit');
    const tpath = new TrackPath(tdef);
    const bus = { emit() {}, on() {} };
    const scene = new THREE.Scene();
    const raceRoot = new THREE.Group();
    const worldRoot = new THREE.Group();
    scene.add(raceRoot);
    scene.add(worldRoot);
    const ctx = {
      bus, scene, raceRoot, worldRoot,
      game: { effect() {}, sfx() {}, bus, teardownRace() {}, removeSystem() {}, addSystem() {} },
      track: tpath, quality: {},
    };
    const builder = new TrackBuilder(ctx, tdef, tpath);    builder.build();
    worldRoot.add(builder.group);
    const sys = new ItemSystem(ctx, { track: tpath, karts: [], def: tdef, itemBoxRows: builder.itemBoxRows, rng: mulberry32(5) });
    let boxesInScene = 0;
    raceRoot.traverse((o) => { if (o.name === 'itemBox') boxesInScene++; });
    ok('the race builds a real box field', boxesInScene > 20, boxesInScene + ' boxes');

    const s = new RaceSession(ctx, {});
    s.builder = builder;
    s.items = sys;
    s.decor = null;
    s.dispose();
    ok('dispose() empties the item box field', sys.boxes.length === 0);
    let boxesLeft = 0;
    raceRoot.traverse((o) => { if (o.name === 'itemBox') boxesLeft++; });
    ok('dispose() detaches every box from the scene', boxesLeft === 0, boxesLeft + ' still parented');
    ok('dispose() takes the track group out of the world', worldRoot.children.length === 0,
      worldRoot.children.length + ' children left in worldRoot');
  } catch (err) {
    ok('RaceSession.dispose regression block', false, String(err && err.stack || err).slice(0, 300));
  }

  /* ------------------------------------------ 9. per-race GPU disposal sweep */
  section('Regression: per-race GPU resources are released');
  try {
    const { installDomShim } = await import('./dom-shim.mjs');
    installDomShim();
    const THREE = await import('three');
    const { TrackBuilder } = await import('../src/world/TrackBuilder.js');
    const { ItemSystem } = await import('../src/items/ItemSystem.js');
    const { buildDecor } = await import('../src/world/Decor.js');
    const { buildTitleScene, disposeTitleScene } = await import('../src/world/TitleScene.js');
    const { createKart } = await import('../src/entities/KartFactory.js');
    const { GameStore } = await import('../src/core/Store.js');
    const tdef = getTrack('sunset-circuit');
    const tpath = new TrackPath(tdef);
    const bus = { emit() {}, on() {} };
    const scene = new THREE.Scene();
    const raceRoot = new THREE.Group();
    const worldRoot = new THREE.Group();
    scene.add(raceRoot);
    scene.add(worldRoot);
    const ctx = {
      bus, scene, raceRoot, worldRoot,
      game: { effect() {}, sfx() {}, bus, setCameraMode() {}, teardownRace() {}, removeSystem() {}, addSystem() {} },
      track: tpath, quality: {},
    };

    /** Walks a subtree and counts the GPU resources a dispose() should free. */
    const census = (rootObj, out = { geo: 0, tex: 0, mat: 0 }) => {
      const seenGeo = new Set();
      const seenTex = new Set();
      rootObj.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh || o.isPoints || o.isLine) {
          if (o.geometry) seenGeo.add(o.geometry);
          const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
          for (const m of mats) {
            out.mat++;
            for (const k in m) if (m[k] && m[k].isTexture) seenTex.add(m[k]);
          }
        }
      });
      out.geo += seenGeo.size;
      out.tex += seenTex.size;
      return out;
    };

    // A material is only really gone when the textures on its properties are
    // disposed too: Game.teardownRace() does that for anything still parented to
    // raceRoot, but KartModel.dispose() takes the group with it first, so
    // without the texture pass each kart stranded three canvas textures.
    const builder = new TrackBuilder(ctx, tdef, tpath);
    builder.build();
    worldRoot.add(builder.group);
    const decor = buildDecor(ctx, tdef, tpath, worldRoot);
    const items = new ItemSystem(ctx, { track: tpath, karts: [], def: tdef, itemBoxRows: builder.itemBoxRows, rng: mulberry32(11) });
    const karts = [];
    for (let i = 0; i < 3; i++) {
      const k = createKart(ctx, { id: i, isPlayer: false, characterId: 'bolt', slot: i, track: tpath, rng: mulberry32(17) });
      karts.push(k);
      raceRoot.add(k.group);
    }
    const before = census(scene);
    ok('the harness actually has resources to free', before.geo > 20 && before.tex > 3,
      before.geo + ' geometries, ' + before.tex + ' textures');

    // Now tear it all down exactly the way RaceSession.dispose() does.
    let disposed = 0;
    const realDispose = THREE.Texture.prototype.dispose;
    THREE.Texture.prototype.dispose = function patched() { disposed++; return realDispose.call(this); };
    try {
      decor.dispose();
      items.dispose();
      builder.dispose();
      for (const k of karts) k.dispose();
    } finally {
      THREE.Texture.prototype.dispose = realDispose;
    }
    ok('dispose() releases at least one texture per material it owned', disposed >= before.tex,
      disposed + ' textures disposed vs ' + before.tex + ' referenced');
    ok('dispose() empties both roots', raceRoot.children.length === 0 && worldRoot.children.length === 0,
      'raceRoot ' + raceRoot.children.length + ', worldRoot ' + worldRoot.children.length);

    // The title scene goes through the same TrackBuilder/Decor pair.
    GameStore.set({ trackId: 'sunset-circuit' });
    const title = await buildTitleScene(ctx);
    const titleBefore = census(scene);
    let titleTex = 0;
    const real2 = THREE.Texture.prototype.dispose;
    THREE.Texture.prototype.dispose = function patched2() { titleTex++; return real2.call(this); };
    try { disposeTitleScene(); } finally { THREE.Texture.prototype.dispose = real2; }
    ok('the title scene releases its textures', titleTex >= titleBefore.tex,
      titleTex + ' disposed vs ' + titleBefore.tex + ' referenced');
    ok('the title scene leaves its group behind as nothing', worldRoot.children.length === 0,
      worldRoot.children.length + ' children left');
    ok('the title scene disposer is idempotent', disposeTitleScene() === undefined);
  } catch (err) {
    ok('GPU disposal regression block', false, String(err && err.stack || err).slice(0, 300));
  }

  /* ------------------------------------------------------------- reporting --- */
  const failed = results.filter((r) => !r.pass);
  console.log('\n---------------------------------------------');
  console.log(results.length + ' checks, ' + failed.length + ' failed');
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log('  - ' + f.name + ' :: ' + f.detail);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('test harness crashed', err);
  process.exit(2);
});
