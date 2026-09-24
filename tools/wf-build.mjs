/**
 * Kart Rush build workflow — runs a BATCH of subsystems (default: 3) in parallel.
 * Invoke once per batch with args: { batch: ['track','data','kart'] }
 * The full agent catalogue lives here so batches stay byte-identical on resume.
 */
export const meta = {
  name: 'kart-rush-batch',
  description: 'Build one batch of Kart Rush subsystems (3 at a time) against the fixed module contract',
  phases: [
    { title: 'Implement', detail: 'up to 3 subsystem agents in parallel' },
  ],
};

const ROOT = '/Users/kiva/Downloads/马里奥卡丁车';

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    filesWritten: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    deviations: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
  },
  required: ['filesWritten', 'summary', 'deviations', 'concerns'],
};

const PREAMBLE =
  'You are building one subsystem of "Kart Rush", an AAA-quality 3D kart racing game that homages Mario Kart, running in the browser with Three.js 0.170.\n' +
  'Project root: ' + ROOT + '\n\n' +
  'READ THESE FIRST, in this order:\n' +
  '  1. ' + ROOT + '/docs/CONTRACT.md  (the binding interface spec - obey it exactly)\n' +
  '  2. ' + ROOT + '/src/core/MathUtils.js, src/core/EventBus.js, src/core/Game.js, src/core/Input.js, src/core/Store.js\n' +
  '  3. ' + ROOT + '/src/data/config.js  (all tuning constants - import, never hardcode)\n' +
  '  4. ' + ROOT + '/src/styles/main.css  (existing design system)\n\n' +
  'ABSOLUTE RULES:\n' +
  '- Create/modify ONLY the files listed under YOUR FILES. Never touch any other file, including package.json, node_modules, docs/, or another subsystem module. Import them instead.\n' +
  '- Plain ESM JavaScript, 2-space indent, single quotes, semicolons. No TypeScript syntax.\n' +
  '- ZERO external assets: no fetch, no network, no image/font/audio files, no CDN. Every texture is a procedural canvas; every sound is WebAudio; every mesh is generated geometry. Only dependencies are three + vite (already installed).\n' +
  '- Three addons import as three/examples/jsm/<path>.js (confirmed present: utils/BufferGeometryUtils.js, objects/Sky.js, postprocessing/EffectComposer.js).\n' +
  '- Conventions: Y up, 1 unit = 1 metre, yaw 0 faces -Z, forward = (-sin(yaw),0,-cos(yaw)), track progress is 0..1 along a closed loop.\n' +
  '- Simulation runs at a FIXED 120 Hz; update(dt) must be stable and allocation-light (8 karts x 120/s). Reuse scratch Vector3s in hot loops.\n' +
  '- Quality bar is AAA: this must look and feel like a shipped 2003-GameCube-era kart racer with modern rendering. Rich materials, shadows, glow, particles, squash-and-stretch, polished feedback. Spend effort on visual and game-feel detail, not stubs.\n' +
  '- No placeholders, no TODO, no stub functions, no console.log spam. Every export listed in the contract must be implemented and working.\n' +
  '- Do NOT run npm install, npm run dev, or vite build. They will fail until every subsystem lands. Verify your own files parse with: cd ' + ROOT + ' && for f in <your files>; do node --check "$f" || echo "FAIL $f"; done\n' +
  '- Do not create extra README/docs files.\n\n' +
  'WHEN DONE: report via the structured output tool. Be specific and honest about deviations and anything in the contract that looks broken.\n';

const AGENTS = {
  track: {
    title: 'Track data, TrackPath, TrackBuilder, Decor',
    body:
      'YOUR FILES (create only these):\n' +
      '  src/data/tracks.js\n  src/world/TrackPath.js\n  src/world/TrackBuilder.js\n  src/world/Decor.js\n\n' +
      'Build the whole world layer per contract sections 5 and 6.\n\n' +
      'src/data/tracks.js: exactly THREE genuinely different tracks. Real racing circuits, not ovals:\n' +
      '  - "sunset-circuit" (default): fast flowing classic at golden hour. Width 11. One medium straight, two sweepers, one hairpin.\n' +
      '  - "frostbite-peaks": technical twisty mountain course with real elevation (18-26 m range), a jump over a ravine, narrow sections. Snow/pine theme.\n' +
      '  - "neon-harbour": night-time harbour city, night sky, water, bridges, a chicane, two boost pads. Neon/synthwave theme.\n' +
      'Control-point Y values carry elevation - use swings of 8-25 m so the course visibly climbs and dives. 18-32 control points each. The spline must be C1-smooth and must not self-intersect in the XZ plane; verify numerically and report it.\n\n' +
      'src/world/TrackPath.js: the spatial query backbone used by physics, AI, items, minimap and race director. Closed Catmull-Rom spline resampled to 1000-1400 EQUAL-ARC-LENGTH samples with smoothed Frenet frames and banking, plus a uniform XZ spatial hash for nearest-sample lookup. locate(x,y,z) must be accurate to ~1 cm and return progress, lateral (signed, + = driver right), index and surface in {road,curb,off}. It is called many times per frame, so it must not allocate. Export the Frame object shape exactly as the contract says and reuse a single out object when one is passed.\n' +
      'Also export yawAt(progress) -> number (metres-per-progress aware tangent angle) and expose a settable checkpoints: number[] property.\n\n' +
      'src/world/TrackBuilder.js: builds the tarmac ribbon with a procedural canvas texture (asphalt grain, lane dashes, solid edge lines, start-line checkers) with UVs running along the track; alternating red/white curbs both sides, banked with the road and slightly raised; a surrounding terrain skirt hiding the seam; walls/barriers where the road overhangs; a start/finish gantry with banners; checkpoints (at least 6 ascending progress fractions); and resolved boostPads / jumps / hazards arrays in world coordinates. Merge geometry aggressively with BufferGeometryUtils.mergeGeometries so the whole track is ~6-12 draw calls. Share materials. Export the class as a named export TrackBuilder.\n\n' +
      'src/world/Decor.js: THREE.Sky atmosphere when the theme allows, a procedural PMREM environment map for kart reflections, instanced foliage (one InstancedMesh per foliage type, <= 8 draw calls for all foliage), instanced rocks, animated spectators behind barriers, banners, distant landmark silhouettes (windmill/castle/volcano/lighthouse), scene.fog from theme.fog, and the directional sun from theme.sky. Everything positioned relative to the track via TrackPath so nothing sits on the road. Export buildDecor(ctx, def, path, group) as a named export.\n\n' +
      'Fill in every field listed in contract section 5 for every track. Auto-generate itemBoxRows/jumps/boostPads/hazards where omitted, and report what you generated.',
  },

  data: {
    title: 'Characters, palettes and stat tuning',
    body:
      'YOUR FILES (create only these):\n  src/data/characters.js\n\n' +
      'Build the roster per contract section 4: exactly 8 characters covering four archetypes (light/medium/heavy/speed) and all five body shapes (human x2, dino, ape, mushroom, koopaKing). Original characters that evoke classic kart-racer archetypes without copying any real franchise - no Nintendo names, no trademarked names.\n\n' +
      'Suggested roster (refine freely, keep exactly 8):\n' +
      '  1. Bolt - human, all-rounder, red cap, dependable hero\n' +
      '  2. Verdi - human, taller twin, green cap, higher top speed, lower handling\n' +
      '  3. Aurelia - human, pink dress, high accel, light, excellent handling\n' +
      '  4. Tiko - dino, green, great accel and handling, low weight\n' +
      '  5. Fungi - mushroom, white cap with red spots, high accel, very light\n' +
      '  6. Kongo - ape, brown, heavy, high top speed, poor handling\n' +
      '  7. Bruto - koopaKing, spiked shell, heaviest, highest top speed, worst handling\n' +
      '  8. Gordo - human, purple, greedy heavy archetype, high weight + top speed, mid handling\n\n' +
      'For each: id, name, epithet, blurb (one evocative sentence), body, color (hex used for minimap dot / HUD chip / UI accents), full palette {primary, secondary, accent, cap, skin, hair, tire, engine, glow} that reads well in 3D lighting, scale (0.92-1.12), stats {speed, accel, handling, weight} as 1-5 display integers, tuning multipliers over CONFIG.physics {topSpeed, accel, turn, drift, mass, offTrack} making the archetypes genuinely different (topSpeed multiplier ~0.90-1.10, turn ~0.86-1.14), engine {baseFreq, timbre}, voice, unlock.\n\n' +
      'Balance it properly: no character may be strictly better. Verify numerically that topSpeed x tuning.topSpeed and turn land in the intended ranges and that light characters have a real handling advantage while heavies have a real top-speed advantage. Report the final numbers.\n\n' +
      'Export CHARACTERS (array of 8), DEFAULT_CHARACTER_ID, getCharacter(id) (falls back to default), and CHARACTER_ARCHETYPES for UI. Also export drawCharacterPortrait(ctx2d, character, size) - a flat stylised illustration (head, cap, eyes, body drawn with paths and the palette), under 90 lines, looking charming.',
  },

  kart: {
    title: 'Kart physics, kart model and factory',
    body:
      'YOUR FILES (create only these):\n  src/physics/KartPhysics.js\n  src/entities/KartModel.js\n  src/entities/Kart.js\n  src/entities/KartFactory.js\n\n' +
      'Build the kart per contract section 7. This is the hero asset and the most important code in the project - the game FEEL lives here.\n\n' +
      'src/physics/KartPhysics.js: an arcade kart model in the spirit of Mario Kart 64 / Double Dash:\n' +
      '  - scalar forward speed with accel/decel curves and a top speed depending on surface, cc class and character tuning;\n' +
      '  - a lateral-slip component so the kart visibly slides, with grip pulling it back;\n' +
      '  - hop + drift: tapping drift while steering hops the kart, then it drifts with exaggerated yaw, outward slide and a charge timer producing mini-turbo tiers 1/2/3 at CONFIG.physics.driftTiers, each granting a boost on release. Emit driftStart / driftCharge (with tier) / driftRelease (with tier) / miniTurbo.\n' +
      '  - boosting (temporarily higher top speed + accel), strongest wins; spinouts (lose control, speed collapses, recover), squash (lightning), star;\n' +
      '  - slipstream reading phys.nearbyKarts (an array of {position: Vector3, forward: Vector3} set by the integrator each frame - read it if present, guard for undefined);\n' +
      '  - wall clamp: beyond halfWidth + wallOffset, snap back and kill outward velocity, emitting wallHit with impact;\n' +
      '  - air: gravity, landing detection, hopVelocity for drift hops, heightOffset for suspension/air pose;\n' +
      '  - kart-kart collision is done by the integrator; expose radius = CONFIG.physics.collision.radius;\n' +
      '  - emit every contract event through this.onEvent (no-op if unset), via a REUSED events array so nothing allocates.\n' +
      '  - expose yawAt-independent helpers the integrator needs: launch(height) or a settable verticalVelocity, forward (unit Vector3), and a lateral (signed metres) getter.\n\n' +
      'src/entities/KartModel.js: a genuinely detailed kart from primitives and lathe/extrude geometry - streamlined nose cone, side pods, rear spoiler, exhaust stacks, front bumper, engine block, seat, steering wheel, 4 wheels with rims and tread, plus a driver. Metallic paint (metalness 0.55, roughness 0.28) with a clear-coat sheen via a slightly scaled shell with a second material; rubber tyres; chrome trim; a soft contact-shadow decal plane under the kart with a radial-alpha canvas texture.\n' +
      '  Driver archetypes keyed off CharacterDef.body: human, dino, ape, mushroom, koopaKing - each with a distinct silhouette, head, cap/crest, eyes, arms, and a scarf/cape that flutters with speed. Animate: arms follow steering, head leans into the corner, body leans into drift, driver squashes when squashed, celebratory arm pump while boosting.\n\n' +
      'src/entities/Kart.js + KartFactory.js: the Kart object in contract section 7.2, including poseVisuals(dt) driving wheel spin (speed/radius), front-wheel steer, suspension compression, chassis roll and pitch, drift yaw/lean, squash-and-stretch. createPhysicsDef(character) merges CONFIG.physics with character.tuning and the cc class (50 -> x0.88, 100 -> x0.94, 150 -> x1.0, 200 -> x1.08). Named export createKart(ctx, opts).\n\n' +
      'src/data/characters.js is written by another agent in parallel, so do NOT import it. characterId arrives as a string; fall back to a built-in default palette for unknown ids so your code runs standalone. Expose Kart.character (may be null) and Kart.characterId.\n\n' +
      'You cannot run the browser, so keep the module free of browser-only globals at import time. Verify with node --check only.',
  },

  items: {
    title: 'Items, roulette, projectiles, item boxes, art',
    body:
      'YOUR FILES (create only these):\n  src/data/items.js\n  src/items/ItemSystem.js\n  src/items/ItemBox.js\n  src/items/ItemArt.js\n\n' +
      'Build the item layer per contract section 9 - the most loveable part of a kart racer.\n\n' +
      'src/data/items.js: define ALL of these with hand-tuned position-dependent weight tables (index 0 = 1st place) so the leader gets weak items and the back-marker gets strong ones: banana, tripleBanana, greenShell, tripleGreenShell, redShell, mushroom, tripleMushroom, goldenMushroom, star, lightning, blooper, bulletBill, superHorn. Each with name, plural, color, weight[], holdable, count, description, art. Keep the listed ids exact; you may add more.\n\n' +
      'src/items/ItemSystem.js: the runtime. Owns:\n' +
      '  - the roulette: rollFor(kart) runs CONFIG.items.rouletteTime seconds of rapid cycling through weighted candidates (real normalised weights) then locks in an item; emit item:picked on lock-in.\n' +
      '  - deployment per item: banana/tripleBanana dropped just behind the kart; greenShell and tripleGreenShell fired forward along the track bouncing off walls (CONFIG.items.shell.bounceDamping) and dying after their lifetime; redShell homing onto the kart one place ahead using a lookahead pursuit controller, giving up if it loses the target; mushroom/tripleMushroom via kart.applyBoost; goldenMushroom granting repeated boost uses; star setting kart.starTimer; lightning shrinking + slowing every kart ranked above the user; blooper emitting fx ink on everyone ahead; bulletBill auto-driving the kart along the racing line at CONFIG.items.bulletBill.speed while invincible and plowing through others; superHorn destroying incoming projectiles.\n' +
      '  - projectile/hazard entities with position, velocity, ownerId, lifetime, travelling along the track; pooled meshes so nothing allocates mid-race.\n' +
      '  - collision: sphere overlap against every kart (short owner grace period), emitting kart:hit and calling kart.spinOut(). Heavy characters are less affected than light ones - read kart.character.stats.weight if available, else default.\n' +
      '  - item box respawn timers at CONFIG.items.boxRespawn with a pop animation.\n' +
      '  - activeItem(kart) / useActive(kart) / rollFor(kart) / give(kart, itemId) named exports on the instance, plus .boxes and .entities arrays.\n' +
      '  - bulletBill must drive the kart while active: expose items.bulletBillControllerFor(kart) that a controller can consult, and make the kart effectively auto-accelerate along the line.\n\n' +
      'src/items/ItemBox.js: a translucent cube shell with a fresnel-ish gradient canvas texture, a bright rotating gem inside, a soft glow sprite, spin + bob, pop/fade when consumed. Pooled meshes, one shared material set. Must expose .position (Vector3), .active (bool), .group and/or .mesh, and .consume(kart).buildDefaultRowData(path, def, ctx) -> [{position, index}] used as a fallback.\n\n' +
      'src/items/ItemArt.js: itemIconSVG(itemId) returning inline SVG that looks genuinely good at 118 px, plus drawItemIcon(ctx2d, itemId, size). Each item must be instantly recognisable by silhouette and colour.\n\n' +
      'Guard every cross-module read: kart.applyBoost, kart.spinOut, kart.squash, kart.starTimer, kart.rank, kart.lapProgress, track.locate/advance/surfaceHeight/positionAt, KartFactory.createKart. Other subsystems are written in parallel, so use optional calls and fallbacks.',
  },

  ai: {
    title: 'AI drivers and player controller',
    body:
      'YOUR FILES (create only these):\n  src/ai/AIDriver.js\n  src/ai/PlayerController.js\n\n' +
      'Build the controllers per contract section 8. Both implement: sample(dt, kart, ctx) -> {throttle, brake, steer, drift, driftPressed, item}.\n\n' +
      'AIDriver: implement a real racing driver, not a spline-follower.\n' +
      '  1. Racing line: for each track sample compute a lateral offset that hugs the inside of corners (toward the apex, proportional to curvature) and uses full width on straights. Precompute once into an array indexed by sample index.\n' +
      '  2. Speed profile from curvature (target = sqrt(latAccelLimit / curvature)) smoothed forward and backward so the driver brakes in time and accelerates out.\n' +
      '  3. Steering: aim at a lookahead point CONFIG.ai.lookahead metres down the racing line (scaled by speed), convert to a steering value, drive it with a PD controller so it does not jitter.\n' +
      '  4. Throttle/brake: compare speed to the target profile; brake early (CONFIG.ai.cornerBraking metres before the corner), coast, or floor it.\n' +
      '  5. Drift: hold drift in corners whose exit is straight enough to profit from a mini-turbo; release when the charge tier is high enough or the corner ends. Tune so AI karts actually use mini-turbos.\n' +
      '  6. Avoidance: look ahead for karts, hazards and items; steer away with a weighted sum so it does not overshoot; include a force pulling back to the line when off track.\n' +
      '  7. Recovery: if kart.physics.spinout.timer > 0 or the kart faces backwards relative to the track, drive toward the track and straighten up.\n' +
      '  8. Items: implement the decision table in the contract - big lead -> mushrooms/bananas on straights; someone 15-45 m ahead -> green/red shell; someone close behind -> banana; surrounded -> star; losing with a tight field -> lightning. Respect CONFIG.ai.itemCooldown. Apply CONFIG.ai.rubberBand gently.\n' +
      '  9. Personality: constructor takes {skill, difficulty, style, seed}; per-driver variation in precision, aggression, line choice and reaction time so 7 bots do not drive identically. Use mulberry32 from core/MathUtils.js - never Math.random().\n' +
      '  setField(karts, track) is called once by the integrator; guard for it being absent. Also read an optional this.items reference (set by the integrator) so you can call this.items.useActive(kart); if absent, set item: true on the returned drive input so the integrator can fire it.\n\n' +
      'PlayerController: reads ctx.input (core/Input.js). Applies input.readDrive(); handles the start-boost window (hold accelerate inside CONFIG.race.startBoostWindow before GO, granting kart.applyBoost(kind,duration,multiplier) yourself, and also expose this.lastStartBoostReleased); fires items on Actions.ITEM edge (via this.items if present, else by setting item: true on the drive input); sets this.lookBack for the camera; and respawns the kart on the track when Actions.RESET is pressed or it is hopelessly off track.\n\n' +
      'src/world/TrackPath.js and src/entities/Kart.js are written by other agents in parallel: code strictly against the CONTRACT signatures and guard optional reads (kart.physics.surface, kart.lapProgress, kart.rank, kart.item, track.sampleFrameAt, track.locate, track.advance, track.positionAt, track.length). Never import data/characters.js or data/items.js.',
  },

  audio: {
    title: 'Synthesised audio: engine, sfx, music',
    body:
      'YOUR FILES (create only these):\n  src/core/Audio.js\n  src/data/music.js\n\n' +
      'Build the entire audio layer with WebAudio synthesis - ZERO sample files - per contract section 11. Lazily create the AudioContext on the first user gesture and call resume(); never throw before then; every public method is a no-op until ready. Wrap every node start in try/catch.\n\n' +
      'Engine: follow the player kart via setEngine(playerKart). Two detuned sawtooth oscillators plus a sub sine through a lowpass whose cutoff follows a 6-gear simulated RPM curve, filtered noise for engine load, and a separate band-passed noise channel for tyre screech whose gain follows the kart drift charge / slip. Crossfade a boost layer (brighter saw, higher cutoff) while boosting. Pitches must be per-character (CharacterDef.engine.baseFreq, timbre) - guard for character being null.\n\n' +
      'SFX: synthesise every name in the contract list (countdown, countdownGo, start, boost, miniTurbo, mushroom, driftSpark, driftCharge, itemGet, itemRoll, shellFire, shellHit, bananaDrop, bananaHit, star, lightning, blooper, bulletBill, lap, finalLap, finish, positionGain, offTrack, wallHit, hop, land, coin, select, confirm, back, crunch, squash). Short envelope-shaped oscillators plus noise bursts with filter sweeps; each must read as a distinct arcade sound. Support {volume, rate, pan}. Cap simultaneous voices with voice stealing so a busy race never clips.\n\n' +
      'Music (src/data/music.js): define three tracks as pure DATA (note names, step patterns, tempo, instrument assignments) and a tiny step sequencer playing them with square/triangle/noise voices plus synthesised kick/snare/hat. Tracks: menu (bright, laid-back loop), race (upbeat major-key loop with a driving bass), finalLap (a faster, tenser remix of race that crossfades in when the leader starts the last lap). Expose playMusic(name, fadeSeconds) and drive intensity layers by name. Must loop seamlessly and be genuinely listenable.\n\n' +
      'Also implement setMuted(bool), setVolumes({master, music, sfx}), a master compressor + soft limiter, setEngine(kart), update(dt), dispose(). Named exports: AudioSystem class (src/core/Audio.js) and the music data/sequencer (src/data/music.js).',
  },

  fx: {
    title: 'Particles, camera rig and shake',
    body:
      'YOUR FILES (create only these):\n  src/fx/Particles.js\n  src/fx/CameraRig.js\n  src/fx/CameraShake.js\n\n' +
      'Build the feel layer per contract section 10. This decides whether the game feels AAA or like a tech demo.\n\n' +
      'src/fx/Particles.js: one GPU-friendly system.\n' +
      '  - A few THREE.Points pools (one per blend mode / texture family: additive for sparks/flames/glows, normal-blended for smoke/dust/confetti) with a custom ShaderMaterial (size attenuation, per-particle colour, alpha fade, rotation, soft round sprite from a canvas texture). Up to ~4000 live particles across pools. CPU simulation in typed arrays; upload only what changed.\n' +
      '  - Accept every effect type in contract section 3 through spawn(type, opts) / burst(type, opts): driftSpark (colour per tier), driftSmoke, dust, boostFlame, starSparkle, spinDust, landPuff, confetti, shellTrail, bananaTrail, shellHit, boostPadSpark, mushroomPuff, itemBoxPop, coin, squashPuff, skid (short pooled decal planes - they matter a lot for road readability), draftTrail, finishSparks, ink.\n' +
      '  - opts are {position: Vector3, velocity, color, intensity, kart, count, normal}. Also provide convenience helpers driftSparks(kart, tier) etc. callable per frame.\n' +
      '  - setQuality(level) scales counts. dispose() frees everything.\n\n' +
      'src/fx/CameraRig.js: the chase camera - the single most important element of kart-racing feel.\n' +
      '  - Modes: title (slow orbit around the start line showing the track), intro (4-second pre-race cinematic: from above, sweep the grid, settle behind the player), chase (default), lookBack (flipped 180), fixed (scripted, for menus).\n' +
      '  - Chase: damp camera yaw toward the kart yaw (CONFIG.camera.yawLag) AND toward the velocity direction so the kart reads its own drift; add a lateral drift offset opposite the drift direction; FOV widens with speed and boost (CONFIG.camera.fov -> fovBoost); small vertical bob; raise height with speed; clamp the camera above the ground using the track height at the camera XZ (guard for an absent track).\n' +
      '  - Set ctx.game.focus each frame so the shadow camera follows the action.\n' +
      '  - Expose mode, setTarget(kart|null), snapTo(kart), update(dt), and updateView(dt).\n' +
      '  - Rig writes ctx.camera.position/quaternion; expose this.rigPos / this.rigQuat (or an applyShake(shake) hook) so CameraShake can compose on top. Document the shape you chose in your report.\n\n' +
      'src/fx/CameraShake.js: trauma-based shake (add, never multiply), noise-driven rotation + position offsets, exponential decay, clamped amplitude, plus impulse helpers shakeHit(), shakeLand(), shakeBoost(). Punchy but never nauseating (clamp to a couple of degrees) and inert when paused. update(dt) and updateView(dt).',
  },

  race: {
    title: 'Race director, laps, standings, results',
    body:
      'YOUR FILES (create only these):\n  src/race/RaceDirector.js\n\n' +
      'Build the race rules engine per contract section 12. Named export RaceDirector.\n\n' +
      'Implement:\n' +
      '  - A 3-2-1-GO countdown from CONFIG.race.countdown, emitting race:countdown each whole second and race:go at zero. Karts cannot move meaningfully before GO. The player start boost is granted here if the controller signals it (read playerController.lastStartBoostReleased, guarded).\n' +
      '  - Cheat-proof lap detection: each kart must pass an ordered set of at least 6 checkpoint progress fractions before a line crossing counts (use ~10 Hz progress updates with hysteresis so a kart sitting on the line cannot farm laps). Accept checkpoints from options.track.checkpoints, options.trackDef.checkpoints or options.builder.checkpoints; if none, generate 6 evenly spaced ones.\n' +
      '  - Standings on a closed loop: order by (lapsCompleted, lapProgress), unfinished karts after finished ones. Recompute at ~10 Hz and expose race.standings. A kart that crosses the line backwards must not lose a lap.\n' +
      '  - Gap-to-leader in ms from progress difference times an estimated pace (track length / speed), clamped to a sane range.\n' +
      '  - Per-lap timings, best lap, total time, race:lap and race:finish events (with isPlayer), and race:end with a full Results object once the player finishes plus a short tail (or everyone finishes).\n' +
      '  - Final-lap transition: when the leader starts the last lap, play the cue and bus.emit("audio:music", {name:"finalLap"}).\n' +
      '  - Store state: set GameStore state.race and call store.notify(); at the end set state.mode = MODES.FINISHED and state.results. Import MODES from core/Store.js.\n' +
      '  - race.view() returning exactly the RaceView shape (polled ~10 Hz by the HUD) and race.results() returning the Results shape.\n' +
      '  - Give each kart a points total per CONFIG.race.points for the results screen.\n\n' +
      'Read karts through kart.raceProgress, kart.lapProgress, kart.lap, kart.lapTimesMs, kart.finished, kart.finishTimeMs, kart.speedKmh, kart.isPlayer, kart.id, kart.name - guard every field with ?. since KartFactory is written by another agent. Implement update(dt), view(), results(), and dispose().',
  },

  ui: {
    title: 'UI: menus, HUD, minimap, results',
    body:
      'YOUR FILES (create only these):\n  src/ui/UI.js\n  src/ui/HUD.js\n  src/ui/Minimap.js\n  src/ui/Menus.js\n  src/ui/Results.js\n  src/ui/Loading.js\n\n' +
      'Build the entire front end per contract section 13, into ctx.uiRoot (the #ui-root div already in index.html, pointer-events: none by default - set pointer-events: auto on interactive overlays). ALL text in English.\n\n' +
      'Use and extend src/styles/main.css - it already has .screen, .panel, .btn, .seg, .card, .logo, .hud-*, .toast, .results-table, .settings-row, .kbd, .controls-grid. Keep that identity: chunky italic display type, thick borders, hard drop shadows, saturated accent gradients, glassy translucent panels. Append any extra CSS you need in that file in a clearly-commented section - it is yours to extend.\n\n' +
      'src/ui/UI.js: createUI(ctx) owns the root element and a screen stack: loading, title, charselect, trackselect, options, hud, pause, results. Full keyboard AND gamepad navigation (arrows/WASD to move focus, Enter/Space or gamepad A to confirm, Escape/B to back) with a visible focus ring via a data-focused attribute. Wire character/track/cc/difficulty/laps/karts/quality/volume into GameStore and call persist() from core/Store.js. Named export createUI(ctx). Also emit "race:request" on the bus with the chosen config when the player starts a race (and support a time-trial style start too). Provide ui.show(screen), ui.update(dt, raceView), ui.attachRace(race), ui.dispose().\n\n' +
      'src/ui/Loading.js: boot screen with a progress bar, rotating tips, and the game wordmark; fades out when signaled.\n\n' +
      'src/ui/Menus.js: the title screen (big Kart Rush wordmark, tagline, PLAY, controls, settings), character select (8 cards: stylised canvas portrait via drawCharacterPortrait from data/characters.js if present, else your own icon, plus name, epithet, 4 stat bars; click or arrows to pick; a live preview pane), track select (3 cards with a canvas-drawn top-down track outline built from TrackPath.centerline2D() - import TrackPath lazily and guard failure - plus theme swatches and a blurb), and an options screen (cc 50/100/150/200, laps 2-5, difficulty easy/normal/hard/insane, karts 2-8, quality low/medium/high, master/music/sfx sliders, mute toggle). Include a controls reference screen.\n\n' +
      'src/ui/HUD.js + src/ui/Minimap.js: the in-race HUD using the existing .hud-* classes. Lap counter (current/total), position ordinal, speed readout, item slot with a large icon + count badge + roulette shake animation, a drift charge meter coloured per tier, and a timer panel with current/last/best lap. The minimap: render the track outline once into an offscreen canvas from TrackPath.centerline2D(), then each frame draw it rotated so the player always points up, scaled down, with kart dots coloured per character, item-box dots, the start line, and a standing-order list beside it. Must cost under ~1 ms per frame.\n\n' +
      'src/ui/Results.js: standings table per the Results shape - position, name, colour chip, total time, best lap, per-lap splits. Highlight the player row. Show points, a new-record badge (compare with store.state.records and call saveRecord from core/Store.js), and buttons for Rematch / Change Track / Main Menu.\n\n' +
      'Also implement centre toasts on bus event ui:toast ({text, kind, duration}) with the .toast styles and a pop animation, flashes on fx:flash, and the countdown numerals.\n\n' +
      'Guard everything: the game, race and item modules are written in parallel. Do not import Kart.js, ItemSystem.js, RaceDirector.js, Particles.js at module top level; use lazy optional access and null checks.',
  },
};

const ALL = ['track', 'data', 'kart', 'items', 'ai', 'audio', 'fx', 'race', 'ui'];
const requested = Array.isArray(args && args.batch) ? args.batch : null;
const keys = (requested ? requested : ALL).filter((k) => AGENTS[k]);

phase('Implement');
log('Kart Rush batch [' + keys.join(', ') + '] - ' + keys.length + ' subsystem(s) in parallel');

const results = await parallel(
  keys.map((k) => () =>
    agent(PREAMBLE + '\n=== YOUR TASK: ' + AGENTS[k].title + ' ===\n\n' + AGENTS[k].body, {
      label: 'impl:' + k,
      phase: 'Implement',
      effort: 'high',
      schema: REPORT_SCHEMA,
    })
  )
);

const known = keys.reduce((m, k, i) => { m[k] = results[i]; return m; }, {});
return { known, batchDone: keys };
