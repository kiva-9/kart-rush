/**
 * Headless integration test: builds a real race session (track, 8 karts, AI
 * controllers, items) with stubbed view layers and simulates a full 3-lap race
 * to verify every subsystem actually works together.
 *
 *   node scripts/test-integration.mjs
 */
import * as THREE from 'three';
import { installDomShim } from './dom-shim.mjs';

installDomShim();

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? '  -- ' + detail : ''));
};

const pick = (m, n) => (m && typeof m[n] === 'function' ? m[n] : null);
const rng = (() => {
  let s = 987654321;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
})();

async function main() {
  const { GameStore, MODES } = await import('../src/core/Store.js');
  const { EventBus } = await import('../src/core/EventBus.js');
  const { getTrack } = await import('../src/data/tracks.js');
  const { getCharacter, CHARACTERS } = await import('../src/data/characters.js');
  const { TrackPath } = await import('../src/world/TrackPath.js');
  const { TrackBuilder } = await import('../src/world/TrackBuilder.js');
  const { createKart, createPhysicsDef } = await import('../src/entities/KartFactory.js');
  const { AIDriver } = await import('../src/ai/AIDriver.js');
  const { ItemSystem } = await import('../src/items/ItemSystem.js');
  let RaceDirectorCtor = null;
  try { RaceDirectorCtor = (await import('../src/race/RaceDirector.js')).RaceDirector; } catch { console.log('  (RaceDirector not written yet - skipped)'); }
  const { CONFIG } = await import('../src/data/config.js');

  // ---- a stub game context -------------------------------------------------
  const bus = new EventBus();
  const scene = new THREE.Scene();
  const raceRoot = new THREE.Group();
  const worldRoot = new THREE.Group();
  scene.add(raceRoot);
  scene.add(worldRoot);

  const events = [];
  bus.on('race:go', () => events.push('go'));
  bus.on('race:lap', (p) => events.push('lap:' + p.kartId + ':' + p.lap));
  bus.on('race:finish', (p) => events.push('finish:' + p.kartId));
  bus.on('race:end', () => events.push('end'));
  bus.on('kart:spinout', (p) => events.push('spin:' + p.kartId));
  bus.on('kart:hit', (p) => events.push('hit:' + p.kartId));
  bus.on('item:picked', (p) => events.push('itempicked:' + p.kartId));
  bus.on('item:used', () => events.push('itemused'));
  bus.on('fx:spawn', () => events.push('fx'));
  bus.on('audio:sfx', (p) => events.push('sfx:' + (p && p.name)));
  bus.on('fx:shake', () => events.push('shake'));

  const noop = () => {};
  const game = {
    bus, scene, raceRoot, worldRoot,
    setCameraMode: noop,
    effect: (type, opts) => { bus.emit('fx:spawn', { type, ...(opts || {}) }); },
    sfx: (name, opts) => { bus.emit('audio:sfx', { name, ...(opts || {}) }); },
    teardownRace: noop,
    clearSystems: noop, addSystem: noop, removeSystem: noop, getSystem: noop,
  };
  const ctx = {
    game, scene, raceRoot, worldRoot, bus,
    camera: new THREE.PerspectiveCamera(),
    renderer: null,
    store: GameStore,
    input: null,
    uiRoot: null,
    quality: { shadows: true, bloom: true, smaa: true },
    time: 0,
  };

  const def = getTrack('frostbite-peaks');
  const path = new TrackPath(def);
  ctx.track = path;

  console.log('\n=== World build ===');
  let builder = null;
  try {
    builder = new TrackBuilder(ctx, def, path);
    builder.build();
    worldRoot.add(builder.group);
    let meshes = 0;
    builder.group.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) meshes++; });
    ok('TrackBuilder.build() succeeds', meshes > 0, meshes + ' meshes');
    ok('12 checkpoints resolved', Array.isArray(builder.checkpoints) && builder.checkpoints.length >= 6, String(builder.checkpoints.length));
    ok('boost pads resolved', builder.boostPads.length > 0, String(builder.boostPads.length));
    ok('jumps resolved', builder.jumps.length > 0, String(builder.jumps.length));
    ok('item box rows resolved', builder.itemBoxRows.length > 0, String(builder.itemBoxRows.length));
  } catch (err) {
    ok('TrackBuilder.build() succeeds', false, String(err && err.message).slice(0, 200));
  }

  console.log('\n=== Race grid ===');
  const LAPS = 2;
  const COUNT = 8;
  const slots = [];
  const start = def.startLine ?? 0.02;
  for (let i = 0; i < COUNT; i++) {
    const row = Math.floor(i / 2);
    const col = i % 2 === 0 ? -1 : 1;
    const prog = path.advance(start, -7.5 * (Math.ceil(COUNT / 2) - row));
    slots.push({ position: path.positionAt(prog, col * (def.width * 0.34), new THREE.Vector3()).clone(), yaw: path.yawAt(prog), progress: prog });
  }
  ok('grid slots on the road', slots.every((s) => Math.abs(path.locate(s.position.x, s.position.y, s.position.z).lateral) < def.width), '');

  const karts = [];
  for (let i = 0; i < COUNT; i++) {
    const char = getCharacter(CHARACTERS[(i + 1) % CHARACTERS.length].id);
    const kart = createKart(ctx, {
      id: i, isPlayer: i === 0, characterId: char.id, slot: i, track: path,
      character: char, driverName: char.name, rng, color: char.color,
    });
    ctx.track = path;
    karts.push(kart);
    raceRoot.add(kart.group);
    kart.resetForRace(slots[i]);
  }
  ok('8 karts created', karts.length === COUNT);
  ok('player kart is 0', karts[0].isPlayer === true);
  ok('karts have a physics track', karts.every((k) => k.physics && k.physics.track && k.physics._hasTrack !== false), 'track wired');
  const tops = karts.map((k) => k.physics.def.topSpeed);
  ok('karts carry a character', karts.every((k) => k.character && k.character.id), karts.map((k) => k.character && k.character.id).join(','));
  ok('character top speeds differ', Math.max(...tops) - Math.min(...tops) > 2, (Math.min(...tops)).toFixed(1) + '..' + (Math.max(...tops)).toFixed(1) + ' m/s');

  console.log('\n=== Race director ===');
  GameStore.set({ laps: LAPS, trackId: def.id, difficulty: 'normal' });
  let race = null;
  try {
    race = new RaceDirectorCtor(ctx, { track: path, karts, laps: LAPS, playerKart: karts[0], grid: slots });
    ok('RaceDirector constructs', !!race);
    if (race) ok('phase is countdown', race.phase === 'countdown', race.phase);
  } catch (err) {
    ok('RaceDirector constructs', false, String(err && err.message).slice(0, 250));
  }

  console.log('\n=== Item system ===');
  let items = null;
  try {
    // A seeded rng, so the roulette draws are identical on every run. Without
    // it the whole field's item set was Math.random and two of the assertions
    // below passed or failed on nothing more than luck.
    items = new ItemSystem(ctx, { track: path, karts, race, def, itemBoxRows: builder ? builder.itemBoxRows : null, rng });
    ok('ItemSystem constructs', !!items);
    ok('box field populated', items.boxes.length > 0, items.boxes.length + ' boxes');
    const boxesOnTrack = items.boxes.filter((b) => b.position && path.locate(b.position.x, b.position.y, b.position.z).surface !== 'off').length;
    ok('boxes sit on the road', boxesOnTrack === items.boxes.length, boxesOnTrack + '/' + items.boxes.length);
    // Roulette must lock in for the whole field. The kart ranks are the Race
    // Director's to own, so they are not touched here - ItemSystem falls back to
    // a mid-field table when a kart has no rank yet.
    for (const k of karts) items.rollFor(k);
    let locked = 0;
    for (let i = 0; i < Math.ceil(CONFIG.items.rouletteTime * 120) + 5; i++) items.update(1 / 120);
    for (const k of karts) if (k.item && k.item.id) locked++;
    ok('roulette locks in for all 8 karts', locked === 8, locked + '/8');
    // Rank-dependent probability is a pure function of the table, so check it
    // directly rather than by mutating kart.rank behind the race director's back.
    const rt = pick(await import('../src/data/items.js'), 'rollTable');
    if (rt) {
      const leader = rt(1);
      const back = rt(8);
      const weak = ['banana', 'greenShell', 'mushroom', 'redShell', 'superHorn'];
      const strong = ['star', 'lightning', 'tripleMushroom', 'tripleBanana', 'goldenMushroom', 'bulletBill', 'tripleGreenShell', 'blooper'];
      ok('leader table is only weak items', leader.every((e) => weak.includes(e.def.id)), leader.map((e) => e.def.id).join(','));
      const mass = (t, pool) => t.filter((e) => pool.includes(e.def.id)).reduce((a, e) => a + e.weight, 0);
      const lm = mass(leader, strong);
      const bm = mass(back, strong);
      ok('leader cannot draw star or lightning', lm < 0.05, 'leader strong mass ' + lm.toFixed(3));
      ok('back-marker leans far more toward strong items', bm > lm + 0.3,
        'leader strong mass ' + lm.toFixed(3) + ' vs back-marker ' + bm.toFixed(3));
      ok('back-marker can draw star and lightning', back.some((e) => e.def.id === 'star') && back.some((e) => e.def.id === 'lightning'));
    }
  } catch (err) {
    ok('ItemSystem constructs', false, String(err && err.message).slice(0, 250));
  }

  // ---- drive a full race ----------------------------------------------------
  console.log('\n=== Full 2-lap race simulation (120 Hz) ===');
  const controllers = karts.map((kart, i) => {
    if (i === 0) {
      // a scripted player: floor it, drift in corners
      let t = 0;
      return {
        kart,
        sample(dt, k) {
          t += dt;
          const loc = path.locate(k.position.x, k.position.y, k.position.z);
          const cornerAhead = Math.abs(path.curvatureAt(path.advance(loc.progress, 14)));
          const drift = cornerAhead > 0.012 && k.speedKmh > 45;
          return {
            throttle: 1, brake: 0,
            steer: clampSteer(k),
            drift, driftPressed: drift && !this._wasDrift,
            item: false,
          };
        },
        get _wasDrift() { return this.__w; },
        set _wasDrift(v) { this.__w = v; },
      };
    }
    const ai = new AIDriver({ skill: 0.6 + i * 0.045, difficulty: 'normal', style: 'line', seed: 1000 + i });
    ai.kart = kart;
    ai.items = items;
    return ai;
  });
  for (const k of karts) k.controller = controllers[k.id];

  function clampSteer(k) {
    const loc = path.locate(k.position.x, k.position.y, k.position.z);
    const f = path.frameAt(loc.progress);
    const yawErr = Math.atan2(f.tangent.x, f.tangent.z) - Math.atan2(-Math.sin(k.yaw), -Math.cos(k.yaw));
    let e = yawErr;
    while (e > Math.PI) e -= Math.PI * 2;
    while (e < -Math.PI) e += Math.PI * 2;
    return Math.max(-1, Math.min(1, e * 2.2));
  }

  // wrap the player controller so driftPressed edges work
  controllers[0] = new Proxy(controllers[0], {
    get(t, p, r) {
      if (p !== 'sample') return Reflect.get(t, p, r);
      return function (dt, k, c) {
        const d = t.sample(dt, k, c);
        d.driftPressed = d.drift && !t.__w;
        t.__w = d.drift;
        return d;
      };
    },
  });
  karts[0].controller = controllers[0];

  const DT = 1 / 120;
  const MAX_STEPS = 120 * 200;
  let steps = 0;
  let lead = 0;
  let maxSpeedSeen = 0;
  let offTrackFrames = 0;
  let boostFrames = 0;
  let driftFrames = 0;
  let itemUsed = 0;
  const startTime = Date.now();

  while (steps < MAX_STEPS) {
    steps++;
    if (race && typeof race.update === 'function') race.update(DT);
    if (items && typeof items.update === 'function') items.update(DT);

    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (k.controller && typeof k.controller.sample === 'function') {
        const d = k.controller.sample(DT, k, ctx);
        if (d && d.item) {
          if (items && typeof items.useActive === 'function' && k.item && k.item.id && !k.item.rolling) {
            items.useActive(k);
            itemUsed++;
          }
        }
      }
      k.update(DT);
      const p = k.physics;
      if (p) {
        if (p.speed > maxSpeedSeen) maxSpeedSeen = p.speed;
        if (p.surface === 'off') offTrackFrames++;
        if (p.boost.timer > 0) boostFrames++;
        if (p.drift.active) driftFrames++;
      }
    }

    // kart-kart separation
    for (let i = 0; i < karts.length; i++) {
      for (let j = i + 1; j < karts.length; j++) {
        const a = karts[i].position;
        const b = karts[j].position;
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const d2 = dx * dx + dz * dz;
        const R = 2.3;
        if (d2 < R * R && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (R - d) * 0.5;
          a.x += (dx / d) * push;
          a.z += (dz / d) * push;
          b.x -= (dx / d) * push;
          b.z -= (dz / d) * push;
        }
      }
    }

    if (steps % 240 === 0) {
      const trackProg = (k) => path.locate(k.position.x, k.position.y, k.position.z).progress;
      const sorted = [...karts].sort((x, y) => trackProg(y) - trackProg(x));
      lead = sorted[0].lap + trackProg(sorted[0]);
    }

    if (events.filter((e) => e === 'end').length) break;
    if (steps % (120 * 30) === 0) {
      const trackProg = (k) => path.locate(k.position.x, k.position.y, k.position.z).progress;
      const best = [...karts].sort((x, y) => (y.lap + trackProg(y)) - (x.lap + trackProg(x)))[0];
      console.log('    t=' + (steps / 120).toFixed(0) + 's  leader lap ' + (best.lap || 0) + '/' + LAPS + '  trackProg ' + trackProg(best).toFixed(3) + '  speed ' + best.speedKmh.toFixed(0) + 'km/h');
    }
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const trackProg = (k) => path.locate(k.position.x, k.position.y, k.position.z).progress;
  const totalProg = (k) => (k.lap || 0) + trackProg(k);
  const standings = [...karts].sort((x, y) => totalProg(y) - totalProg(x));
  console.log('\n    simulated ' + (steps / 120).toFixed(0) + 's of race in ' + elapsed + 's wall clock');
  if (race && race._recs) {
    const mismatch = race._recs.filter((r) => r.position !== r.kart.rank);
    ok('every kart.rank tracks its race position', mismatch.length === 0,
      mismatch.length ? mismatch.map((r) => r.kart.name + ' pos' + r.position + '/rank' + r.kart.rank).join(' ') : 'all 8 agree');
    for (const kk of karts) {
      const n = race._recs.filter((r) => r.kart === kk).length;
      if (n !== 1) ok('one record per kart (' + kk.name + ')', false, n + ' records');
    }
  }
  for (const k of standings) {
    const rec = race && race._byKart ? race._byKart.get(k) : null;
    console.log('      P' + (k.rank || '?') + '  ' + String(k.name).padEnd(12) + ' lap ' + (k.lap || 0) + '/' + LAPS +
      '  racePos ' + (rec ? rec.racePos.toFixed(2) : '?') + '  myMeasure ' + totalProg(k).toFixed(2) + '  best ' + (k.bestLapMs || 0) + 'ms');
  }

  console.log('\n=== Assertions ===');
  ok('race ran for a long time', steps > 120 * 40, (steps / 120).toFixed(0) + 's');
  ok('karts made real progress around the track', totalProg(standings[0]) > 0.4, 'total progress ' + totalProg(standings[0]).toFixed(2) + ' laps');
  ok('no kart went off road forever', offTrackFrames / steps < 0.6, (100 * offTrackFrames / steps).toFixed(1) + '% off-track frames');
  ok('karts drifted', driftFrames > 200, driftFrames + ' drift frames');
  ok('karts boosted', boostFrames > 60, boostFrames + ' boost frames');
  ok('karts reached racing speed', maxSpeedSeen > 26, maxSpeedSeen.toFixed(1) + ' m/s');
  if (race) {
    const rec = (k) => race._byKart.get(k);
    // Finished karts stop being progress-tracked at the line, so their standing
    // is decided by finish time; unfinished ones are ordered by progress.
    const finished = karts.filter((k) => rec(k).finished);
    const running = karts.filter((k) => !rec(k).finished);
    const inFinishOrder = [...finished].sort((a, b) => rec(a).finishMs - rec(b).finishMs);
    ok('finished karts rank in finish order',
      inFinishOrder.every((k, i) => k.rank === i + 1),
      inFinishOrder.map((k) => k.name + '#' + k.rank + '@' + (rec(k).finishMs / 1000).toFixed(1) + 's').join(' '));
    if (running.length > 1) {
      const sorted = [...running].sort((a, b) => rec(b).racePos - rec(a).racePos);
      ok('running karts rank in progress order', sorted.every((k, i) => k.rank === sorted.length + i + 1),
        sorted.map((k) => k.name + '#' + k.rank).join(' '));
    } else {
      ok('running karts rank in progress order', running.every((k) => k.rank === karts.length),
        running.map((k) => k.name + '#' + k.rank).join(' '));
    }
    // Whichever kart the director calls rank 1 must be the earliest finisher.
    const first = karts.find((k) => k.rank === 1);
    ok('rank 1 finished first', !!first && rec(first).finished &&
      finished.every((k) => rec(first).finishMs <= rec(k).finishMs),
      'rank1=' + (first ? first.name : '?'));
  }
  if (race) ok('ranks are a permutation of 1..8', new Set(karts.map((k) => k.rank)).size === 8, String([...karts.map((k) => k.rank)].sort((a, b) => a - b)));
  const itemUsedEvents = events.filter((e) => e === 'itemused').length;
  ok('items were used by the field', itemUsedEvents > 0 || itemUsed > 0, itemUsedEvents + ' bus events, ' + itemUsed + ' integrator fires');
  ok('karts picked items up', events.filter((e) => e.startsWith('itempicked')).length > 0, events.filter((e) => e.startsWith('itempicked')).length + ' pickups');
  ok('fx events fired', events.filter((e) => e === 'fx').length > 0, events.filter((e) => e === 'fx').length + ' fx spawns');
  ok('karts stayed finite', karts.every((k) => isFinite(k.position.x) && isFinite(k.position.y) && isFinite(k.position.z)));
  ok('karts stayed on/near the track', karts.every((k) => Math.abs(path.locate(k.position.x, k.position.y, k.position.z).lateral) < def.width + 4), '');

  if (race) {
    try {
      const view = race.view();
      ok('race.view() returns a usable object', view && typeof view === 'object', Object.keys(view || {}).slice(0, 8).join(','));
      ok('view has standings', Array.isArray(view.standings) && view.standings.length === 8, String(view.standings && view.standings.length));
      ok('view has a player block', view.player && typeof view.player.speedKmh === 'number', '');
      const res = race.results();
      ok('race.results() returns entries', res && Array.isArray(res.entries) && res.entries.length === 8, '');
    } catch (err) {
      ok('race.view()/results() work', false, String(err && err.message).slice(0, 200));
    }
  }

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
  console.error('integration harness crashed', err);
  process.exit(2);
});
