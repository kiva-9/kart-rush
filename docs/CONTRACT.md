# Kart Rush — Module Contract (v1)

This document is the **binding interface specification** between the modules of this
project. Nine implementation passes run in parallel against it. Do not invent
alternate names, shapes or units. If you believe something here is wrong, keep the
spec anyway and note the deviation in your final report — the integrator will fix it.

## 0. Hard rules

1. **Own only your files.** The *Ownership* column below is exclusive. Never edit,
   create or delete anything outside it. If you need something from another module,
   import it.
2. **Style**: plain ES modules, 2-space indent, single quotes, semicolons, no default
   exports except where stated. `import * as THREE from 'three'`.
3. **Three addons**: import from `three/examples/jsm/...` (e.g.
   `three/examples/jsm/postprocessing/EffectComposer.js`).
4. **No external assets.** Every mesh, texture, sound and font is generated at
   runtime (canvas textures, `THREE.*Geometry`, WebAudio). No `fetch`, no network,
   no CDN links.
5. **No top-level `await`, no `import.meta.url` asset loading.**
6. **No new dependencies.** Only `three` and the already-installed toolchain.
7. Every module must run under `node --check` after you set `"type": "module"`
   (already set in package.json).
8. Coordinate system: **Y up, right-handed**. 1 unit = 1 metre. A kart with
   `yaw = 0` faces **−Z** (`forward = (-sin(yaw), 0, -cos(yaw))`). A `Mesh`'s
   heading is driven by `mesh.rotation.y = yaw`, with `rotation.order = 'YXZ'`.
9. Dispose everything you allocate when `dispose()` is called. Reuse scratch
   `Vector3` instances in hot loops — the game runs at 8 karts × 120 Hz.
10. Write defensive code: other modules may be mid-change. Guard `?.` on optional
    cross-module calls.

## 1. Units and conventions

| Quantity | Unit | Notes |
| --- | --- | --- |
| Length | metres | track width ~22 m |
| Time | seconds | the sim runs at a fixed 120 Hz |
| Angle | radians | yaw of 0 faces −Z |
| Speed | m/s internally | HUD shows `m/s * 3.6` |
| Track progress | `0..1` fraction of the closed centreline | `wrapProgress()` in `core/MathUtils.js` |
| Lap | `1..totalLaps` | lap 1 starts the moment the countdown ends |

## 2. Already-written spine (read these first, they are the contract made concrete)

| File | What it gives you |
| --- | --- |
| `src/core/MathUtils.js` | `clamp, lerp, invLerp, damp, wrapAngle, deltaAngle, wrapProgress, progressDelta, mulberry32, TAU, formatTime, formatGap, ordinal, smoothstep` |
| `src/core/EventBus.js` | `EventBus` with `on/once/emit/clear` |
| `src/core/Store.js` | `GameStore`, `MODES`, `loadPersisted`, `persist`, `saveRecord` |
| `src/core/Input.js` | `input`, `Actions` |
| `src/core/Game.js` | `Game`, `QUALITY`, `MODES` |
| `src/data/config.js` | `CONFIG` — all gameplay tuning |

### 2.1 `core/Input.js`

```js
import { input } from './core/Input.js';
input.beginFrame(dt)                  // called by Game
input.justPressed(action)            // edge-triggered
input.isDown(action)                 // held
input.readDrive()                    // -> { throttle, brake, steer, drift, driftPressed, item }
```
Actions: `'accelerate' 'brake' 'steerLeft' 'steerRight' 'drift' 'item' 'lookBack'
'pause' 'reset' 'horn'`. `steer` is already smoothed into −1..1.

### 2.2 `core/Game.js`

`Game.instance` is the running game. A "system" is

```js
{
  name: string,
  /** called once when registered */
  init(ctx),
  /** fixed 120 Hz simulation step */
  update(dt, ctx),
  /** per rendered frame; omit if you have no view work */
  updateView(dt, ctx),
  /** stop being simulated */
  enabled: boolean,   // optional
  dispose(),
}
```

`ctx` passed to every hook:

```js
{
  game, scene, raceRoot, worldRoot, camera, renderer, composer, bus, store,
  input, uiRoot, quality, time
}
```

- `game.raceRoot` — Group for **karts, projectiles, item boxes** (torn down per race).
- `game.worldRoot` — Group for **track mesh, terrain, scenery, sky** (kept across races
  on the same track, so `dispose()` it only on teardown).
- `game.focus` — Vector3 the shadow camera orbits; the CameraRig sets it.
- `game.cameraMode` — `'title' | 'chase' | 'race' | 'intro' | 'fixed'`.
- `game.setCameraMode(mode, data)`.
- `game.effect(type, opts)` → emits `fx:spawn`.
- `game.sfx(name, opts)` → emits `audio:sfx`.
- `game.stats` — `{ fps, frameMs, drawCalls, triangles }`.

### 2.3 `core/Store.js`

`GameStore.state` holds `mode, characterId, trackId, cc, difficulty, laps,
playerCount, quality, muted, masterVolume, musicVolume, sfxVolume, race, results,
records`. Set it with `store.set(patch)` and read `store.state.MODE_CHANGE`.
Call `store.notify()` after mutating `state.race` so UI re-renders.

`MODES`: `BOOT, TITLE, CHAR_SELECT, TRACK_SELECT, COUNTDOWN, RACING, PAUSED,
FINISHED`.

## 3. Event catalogue (`bus.emit` / `bus.on`)

| Event | Payload | Emitter |
| --- | --- | --- |
| `game:resize` | `{ width, height }` | Game |
| `game:stats` | `stats` | Game |
| `race:build` | `{ track, karts, config }` | Bootstrap |
| `race:countdown` | `{ remaining }` | RaceDirector |
| `race:go` | `{}` | RaceDirector |
| `race:update` | `raceView` (see §7) | RaceDirector, ~10 Hz |
| `race:lap` | `{ kartId, lap, lapTimeMs, bestLapMs, isPlayer }` | RaceDirector |
| `race:finish` | `{ kartId, isPlayer, position }` | RaceDirector |
| `race:end` | `{ results }` | RaceDirector |
| `kart:hit` | `{ kartId, sourceId, kind }` | ItemSystem |
| `kart:spinout` | `{ kartId, duration }` | ItemSystem |
| `kart:boost` | `{ kartId, kind, duration }` | KartPhysics |
| `kart:surface` | `{ kartId, surface }` | KartPhysics |
| `item:picked` | `{ kartId, itemId }` | ItemSystem |
| `item:used` | `{ kartId, itemId }` | ItemSystem |
| `fx:spawn` | `{ type, ...opts }` | anywhere |
| `fx:shake` | `{ strength, duration, decay }` | anywhere |
| `fx:flash` | `{ color, alpha, duration }` | anywhere |
| `audio:sfx` | `{ name, opts }` | anywhere |
| `audio:music` | `{ name, fade }` | anywhere |
| `audio:engine` | `{ load, rpm, kartId }` | KartPhysics (player only) |
| `ui:toast` | `{ text, kind, duration }` | anywhere |
| `input:any` | `{}` | Bootstrap |

Effect `type` values the Particles module must accept:
`'driftSpark' 'driftSmoke' 'dust' 'boostFlame' 'starSparkle' 'spinDust' 'landPuff'
'confetti' 'shellTrail' 'bananaTrail' 'shellHit' 'boostPadSpark' 'mushroomPuff'
'itemBoxPop' 'coin' 'squashPuff' 'skid' 'draftTrail' 'finishSparks'`.

## 4. `src/data/characters.js`  *(owner: DATA agent)*

```js
export const CHARACTERS = [ /* 8 entries */ ];
export const DEFAULT_CHARACTER_ID = 'bolt';
export function getCharacter(id) -> CharacterDef
```

```ts
CharacterDef = {
  id: string,                 // 'bolt'
  name: string,               // 'Bolt'
  epithet: string,            // 'All-Rounder'
  blurb: string,
  body: 'human' | 'dino' | 'ape' | 'mushroom' | 'koopaKing',
  color: string,              // hex, drives card + minimap dot
  // visual palette for KartModel/CharacterModel
  palette: { primary, secondary, accent, cap, skin, hair, tire, engine, glow },
  scale: number,              // 0.92..1.12 body scale
  stats: { speed, accel, handling, weight },  // 1..5 display stats
  tuning: {                   // multipliers over CONFIG.physics
    topSpeed, accel, turn, drift, mass, offTrack
  },
  engine: { baseFreq: number, timbre: number },  // Hz, 0..1
  voice: number,              // pitch offset in semitones for UI/voice blips
  unlock: 'free' | string,    // requirement text
}
```

The eight characters must cover four archetypes
(light / medium / heavy / speed) and four body shapes. Include at least one of each
`body` value.

## 5. `src/data/tracks.js`  *(owner: TRACK agent)*

```js
export const TRACKS = [ /* 3 entries */ ];
export function getTrack(id) -> TrackDef
export const DEFAULT_TRACK_ID = 'sunset-circuit';
```

```ts
TrackDef = {
  id: string,
  name: string,
  cup: string,             // e.g. 'Star Cup'
  blurb: string,
  /** Closed centreline control points, [x, y, z] in metres. 16..40 points. */
  path: number[][],
  /** Half-width of the tarmac in metres. ~11 */
  width: number,
  /** Banking in radians per control point, or a single number. Positive = banked for a left turn. */
  bank: number[] | number,
  theme: {
    sky: { top: hex, horizon: hex, sun: hex, sunIntensity, sunElevation, sunAzimuth },
    fog: { color: hex, near, far, density? },
    road: hex, roadRough: number,      // 0..1 procedural texture strength
    curbA: hex, curbB: hex,
    terrain: hex, terrainAlt: hex,
    water: hex | null,
  },
  decor: {
    treeType: 'pine' | 'palm' | 'maple' | 'cactus',
    treeDensity: number,   // per 100 m of track
    rockDensity: number,
    spectatorRows: number,
    banners: number,
    landmarks: string[],   // 'windmill' | 'castle' | 'volcano' | 'balloon' | 'lighthouse' | 'rainbow'
  },
  /** Optional overrides; everything omitted is auto-generated. */
  itemBoxRows?: { p: number, count: number, width?: number }[],
  hazards?: { p: number, lateral: number, type: 'banana' | 'cone' | 'oil' }[],
  jumps?: { p: number, width?: number, height?: number }[],
  boostPads?: { p: number, lateral: number, width?: number, strength?: number }[],
  /** Where the start/finish line sits, 0..1. */
  startLine: number,
  /** Grid spawn offsets in metres along the track. */
  grid?: number[][],
  timeOfDay?: 'day' | 'sunset' | 'night',
}
```

The three tracks must feel genuinely different: a fast flowing circuit, a technical
twisty course, and a destination with elevation + a jump. Control-point Y values
carry the elevation — use swings of 8–25 m between low and high points.

## 6. `src/world/TrackPath.js` + `src/world/TrackBuilder.js` + `src/world/Decor.js`  *(owner: TRACK agent)*

### 6.1 `TrackPath`

```js
import { TrackPath } from './world/TrackPath.js';
const path = new TrackPath(trackDef);   // TrackDef from §5
```

Flat, allocation-light, no THREE.Mesh inside. Keep it importable by physics, AI,
items, HUD and the minimap.

```js
path.def              // TrackDef
path.length           // metres
path.sampleCount      // number of samples (aim 900..1400)
path.curve            // THREE.CatmullRomCurve3 (closed)
path.samples          // Float32Array-ish accessor; prefer the methods below

path.frameAt(progress, out?) -> Frame
path.sampleFrameAt(index, out?) -> Frame
/** Nearest-sample index for an XZ position, using a spatial hash. */
path.nearestIndex(x, z) -> number
/** Full spatial query — this is the hot one. */
path.locate(x, y, z, out?) -> { progress, lateral, index, surface }
/** World position of a point given progress + signed lateral offset (metres from centreline). */
path.positionAt(progress, lateral, out) -> Vector3
/** Height of the drivable surface at an XZ position, for props and karts. */
path.surfaceHeight(x, z) -> number
/** Signed local coordinates of a world point. */
path.toLocal(x, y, z) -> { progress, lateral, height }
/** Advance a progress fraction by a distance in metres. */
path.advance(progress, metres) -> number
path.progressToMetres(p), path.metresToProgress(m)
/** Signed progress delta accounting for the closed loop. */
path.distanceBetween(progressA, progressB) -> number  // progress units, -0.5..0.5
/** 2D centreline for the minimap: flat [x0, z0, x1, z1, ...] in metres. */
path.centerline2D() -> Float32Array | number[]
/** Track bounding box. */
path.bounds -> { min:[x,y,z], max:[x,y,z] }
```

`Frame` (reused object, mutated in place when `out` is passed):

```ts
Frame = {
  index: number,
  position: Vector3,   // centreline point
  tangent: Vector3,    // unit, points forward along the lap
  right: Vector3,      // unit, points to the driver's right
  up: Vector3,         // unit, includes banking
  normal: Vector3,     // unit surface normal (banking applied)
  bank: number,        // radians
  width: number,       // half width at this index
  curvature: number,   // 1/radius, signed (positive = turns left)
}
```

`locate()` must return `surface: 'road' | 'curb' | 'off'` and must be accurate to a
couple of centimetres. Accuracy here is more important than speed; a uniform grid of
XZ buckets is expected. `lateral` is signed, positive to the driver's right.

### 6.2 `TrackBuilder`

```js
import { TrackBuilder } from './world/TrackBuilder.js';
const builder = new TrackBuilder(ctx, trackDef);
builder.build()                     // -> THREE.Group added to ctx.worldRoot
builder.track                       // TrackPath instance
builder.group                       // the Group
builder.accentMaterial, …           // optional shared materials
```

Must produce, at minimum:
- tarmac ribbon mesh (width ± def.width), `MeshStandardMaterial` with a procedurally
  generated canvas texture (asphalt noise, centre dashes, edge lines), correct UVs so
  the texture runs along the track;
- edge curbs with alternating red/white stripes generated procedurally, on both sides,
  slightly raised and banked with the road;
- verge/terrain planes surrounding the track (a large ground mesh following the track's
  average height, plus a skirt that hides the seam under the road edge);
- walls or soft barriers along sections where the road leaves open space — use the
  same banking-aware ribbon approach, ~1.6 m tall;
- start/finish gantry with a checkered line and banner;
- lap checkpoints as invisible progress markers that `RaceDirector` can read, exposed as
  `builder.checkpoints: number[]` (progress fractions, ascending, at least 6);
- `builder.boostPads: { p, lateral, width, strength }[]`, `builder.jumps: [...]`,
  `builder.hazards: [...]` resolved from def + auto-generation, all in world terms.

Everything must be merged into as few draw calls as practical
(`BufferGeometryUtils.mergeGeometries` is available), and materials must be shared.

### 6.3 `Decor`

```js
import { buildDecor } from './world/Decor.js';
buildDecor(ctx, trackDef, path, group)   // populates `group` (added to worldRoot)
```
Trees, rocks, spectators (instanced, animated-bob), banners, distant landmarks and a
sky. Use `THREE.InstancedMesh` (≤ 12 draw calls total for foliage) and `THREE.Sky`
(`three/examples/jsm/objects/Sky.js`) for the atmosphere when the theme allows it,
with a procedural PMREM env map for kart reflections. Distant terrain silhouette meshes
around the bounds.

`Decor` also builds `ctx.scene.fog` from `theme.fog` and the sun direction from
`theme.sky`, and returns `{ dispose() }`.

## 7. `src/physics/KartPhysics.js` + `src/entities/*`  *(owner: KART agent)*

### 7.1 `KartPhysics`

```js
import { KartPhysics } from './physics/KartPhysics.js';
const phys = new KartPhysics(def, track, rng);
phys.reset(transform)                  // { position: Vector3, yaw: number }
phys.update(dt, drive)                 // drive = DriveInput below
```

`DriveInput = { throttle: 0..1, brake: 0..1, steer: -1..1, drift: bool,
driftPressed: bool, item: bool, lookBack?: bool }`
(values from `input.readDrive()` or from `AIDriver`).

Mutated public state (read freely by AI, race director, fx, HUD):

```ts
phys.position        // Vector3, world
phys.velocity        // Vector3, world
phys.yaw             // radians
phys.speed           // forward speed, m/s (signed)
phys.lateralSpeed    // sideways slide, m/s (signed)
phys.onGround, phys.airTime
phys.surface         // 'road' | 'curb' | 'off' | 'wall'
phys.drift           // { active, dir, charge, tier, hop }
phys.boost           // { timer, total, multiplier, kind }
phys.spinout         // { timer, total }
phys.squash          // { timer, total }
phys.slipstream      // 0..1 charge
phys.star            // seconds remaining
phys.invincible      // seconds remaining
phys.shielded        // seconds remaining
phys.speedKmh()      // number
phys.effectiveTopSpeed()  // number
phys.heightOffset    // visual suspension/air offset (metres)
```

`update()` must be stable at 120 Hz and must never let the kart escape the track:
once `|lateral| > halfWidth + wallOffset`, clamp it back and kill the outward velocity.
Emit `bus.emit('kart:hit', ...)`-style events through `this.onEvent?.(name, payload)`
(if set, called instead of the bus — the integrator wires it to the bus).

Emit at least: `driftStart`, `driftCharge`, `driftRelease`, `miniTurbo`, `boostStart`,
`boostEnd`, `land`, `wallHit`, `spinoutStart`, `spinoutEnd`, `surfaceChange`,
`hopStart`.

### 7.2 `KartModel` / `Kart` / `KartFactory`

```js
import { createKart } from './entities/KartFactory.js';
const kart = createKart(ctx, {
  id: 0, isPlayer: true, characterId: 'bolt', slot: 0,
  driverName: 'Bolt', rng: () => Math.random(),
});
```

`createKart` returns a `Kart`:

```ts
Kart = {
  id, name, isPlayer, characterId, slot,
  group: THREE.Object3D,          // add to ctx.raceRoot
  body: THREE.Object3D,           // the kart+driver, rolls/pitches
  controller: Controller | null,  // set by Bootstrap
  physics: KartPhysics,
  character: CharacterDef,
  physicsDef: PhysicsDef,         // derived from CONFIG + character tuning
  color: string,
  radius: number,                 // 1.15
  item: { id: string|null, count: number, rolling: boolean },

  // race state (RaceDirector owns the values, but they live on the kart)
  lap: number,
  raceProgress: number,           // 0..1 monotonic-ised, may exceed 1 across laps
  lapProgress: number,            // 0..1 within current lap
  rank: number,                   // 1 = leading
  finished: boolean,
  finishTimeMs: number|null,
  lapTimesMs: number[],
  bestLapMs: number|null,
  lastLapMs: number|null,
  startPosition: number,

  // transient state
  spinTimer, squashTimer, starTimer, hitCooldown,
  boostActive: boolean,

  // methods
  update(dt),                 // steps physics with controller input, then poses visuals
  poseVisuals(dt),            // wheels, suspension, roll/pitch, driver lean
  get position(): Vector3,
  get speedKmh(): number,
  applyItem(itemId),          // called by ItemSystem
  spinOut(duration, sourceId),
  applyBoost(kind, duration, multiplier),
  squash(duration),
  resetForRace(transform),
  dispose(),
}
```

**Visual quality bar for `KartModel`** (this is a hero asset — spend effort here):
- a streamlined kart body with a nose cone, side pods, a rear spoiler and an exhaust;
- 4 wheels with visible rims, spun by `speed / radius`, steered with the front wheels,
  and with suspension compression;
- a driver model built from the `body` archetype with a distinct head, cap, eyes,
  arms on the wheel, and a scarf/cape that flutters with speed;
- materials: metallic paint (`metalness 0.55, roughness 0.28`) plus a clear-coat-ish
  sheen via a second slightly scaled shell, rubber wheels, chrome trim;
- `castShadow` on the body, `receiveShadow` on wheels and ground;
- a soft contact-shadow blob under the kart (a decal plane with a radial-alpha canvas
  texture) for the low-quality path;
- driver animation: lean into the drift, head look toward the turn, arm pump on boost.

`Kart.poseVisuals()` must make the drift read clearly: yaw the body opposite the drift
direction, roll the chassis, and splay the front wheels.

### 7.3 `PhysicsDef`

`createPhysicsDef(character)` merges `CONFIG.physics` with `character.tuning` and the
`cc` class from the store (`50 → ×0.88`, `100 → ×0.94`, `150 → ×1.0`, `200 → ×1.08`).
Export it from `KartFactory.js`.

## 8. `src/ai/AIDriver.js` + `src/ai/PlayerController.js`  *(owner: AI agent)*

```ts
interface Controller {
  /** Called every sim step. Return the drive input. */
  sample(dt, kart, ctx): DriveInput
  onItemUsed?(kart, itemId)
  dispose?()
}
```

### 8.1 `AIDriver`
```js
import { AIDriver } from './ai/AIDriver.js';
const ai = new AIDriver({ skill, difficulty, style, seed });
ai.karts          // all karts, injected once by Bootstrap: ai.setField(karts, track)
ai.itemCooldown
```
Behaviour required:
- follows a racing line built from the track samples, offset toward the inside of
  corners, with a speed profile derived from curvature;
- brakes/throttles to hit that profile; uses drift in sustained corners;
- avoids karts, hazards and dropped items in its path by steering away;
- uses items when it has a target (shells forward when someone is ahead and in range,
  bananas when someone is close behind, mushrooms on straights, star when surrounded,
  lightning when it is *not* in first place with a small gap);
- rubber-bands gently by leader position (bounded by `CONFIG.ai.rubberBand`);
- recovers from spinouts/wrong-way without needing external help;
- respects the same wall clamp as the player (physics handles it);
- never perfectly identical between racers — vary `skill`, precision and aggression.

### 8.2 `PlayerController`
```js
import { PlayerController } from './ai/PlayerController.js';
const p = new PlayerController(ctx);   // reads ctx.input
```
Handles: drive input from `input.readDrive()`, start-boost timing window, item use
(`Actions.ITEM`), look-back camera, respawn-after-fall if the kart somehow leaves the
track (press `reset`).

## 9. `src/data/items.js` + `src/items/*`  *(owner: ITEMS agent)*

### 9.1 `src/data/items.js`
```js
export const ITEMS = [ ... ];
export function getItem(id) -> ItemDef
export const NOTHING_ITEM = 'none';
```
```ts
ItemDef = {
  id: string,            // 'banana' | 'greenShell' | 'redShell' | 'mushroom' |
                         // 'tripleMushroom' | 'tripleBanana' | 'star' | 'lightning' |
                         // 'blooper' | 'goldenMushroom' | 'bulletBill' | 'superHorn'
  name: string,
  plural?: string,
  color: hex,
  /** Position-dependent weight table: index = race rank - 1. */
  weight: number[],
  /** true for items that can be held and fired repeatedly (mushrooms, triple bananas) */
  holdable: boolean,
  count: number,         // uses granted (1 for most)
  description: string,
  /** kind drives the roulette art and the HUD */
  art: 'banana' | 'shell' | 'mushroom' | 'star' | 'bolt' | 'ink' | 'bullet' | 'horn',
}
```
Weights must make the front-runner get weaker items and the back-markers get strong
ones, exactly like the series it homages. Normalise internally; the table is relative.

### 9.2 `ItemSystem`
```js
import { ItemSystem } from './items/ItemSystem.js';
const items = new ItemSystem(ctx, { track, karts, race });
items.update(dt)                    // fixed step
items.rollFor(kart)                 // start the roulette
items.give(kart, itemId)
items.useActive(kart)               // fire whatever the kart holds
items.activeItem(kart)
/** spawned projectiles / hazards in flight */
items.entities: Array<Projectile | Hazard>
items.boxes: ItemBox[]
```

Handles: ownership of `ItemBox` respawn timers, deployment (bananas dropped behind,
shells fired forward along the track, homing red shells, mushroom boost applied via
`kart.applyBoost`), collision detection against karts, `blooper` screen ink
(emit `fx:spawn {type:'ink'}`), `lightning` shrinking everyone else, `bulletBill`
auto-drive, `superHorn` destroying an incoming projectile. Emits
`item:picked`, `item:used`, `kart:hit`, `kart:spinout`.

### 9.3 `ItemBox` — 3D box with a rotating translucent cube shell and a glowing gem
inside; spin, bob, and pop-out when taken. Reusable pooled meshes (one material set).

### 9.4 `ItemArt` — `itemIconSVG(itemId)` returning an inline SVG string for the HUD,
plus a small `<canvas>` painter used by the character/track cards. Must look crisp at
118 px.

## 10. `src/fx/*`  *(owner: FX agent)*

### 10.1 `Particles`
```js
import { Particles } from './fx/Particles.js';
const p = new Particles(ctx);
p.update(dt)                 // view-rate
p.spawn(type, opts)          // opts: { position: Vector3, velocity: Vector3,
                              //        color, intensity, kart, count, normal }
p.burst(type, opts)
p.setQuality(level)
p.dispose()                  // disposes all GPU resources
```
One shared `THREE.Points` per material family with a custom `ShaderMaterial`
(soft round sprite, size attenuation, colour ramp, alpha fade, additive for sparks/
flames and normal-blended for smoke/dust). Expect up to ~4000 live particles. Never
allocate geometry per particle. Types listed in §3.

### 10.2 `CameraRig`
```js
import { CameraRig } from './fx/CameraRig.js';
const rig = new CameraRig(ctx);
rig.update(dt)               // view-rate
rig.setTarget(kart | null)
rig.mode                    // 'chase' | 'lookBack' | 'intro' | 'title' | 'fixed'
rig.snapTo(kart)
```
Classic chase cam: lagged yaw follow, distance/height springs, FOV widening with
speed + boost, look-back flip, drift-offset lean, start-of-race intro orbit, and a
title-screen slow orbit around the start line. Sets `game.focus` for the shadow camera.
Handles `ctx.game.cameraMode` transitions.

### 10.3 `CameraShake`
```js
import { CameraShake } from './fx/CameraShake.js';
const shake = new CameraShake(ctx);
shake.update(dt)
shake.shake(strength, duration)
shake.trauma   // 0..1
```
Applies rotation+position noise to `ctx.camera` **after** the CameraRig runs, so the
Rig must not own the camera transform exclusively — the rig writes `ctx.camera.position`
and `quaternion` and shake adds a small offset. Coordinate: expose `rig.shake = shakeInstance`
so the shake can hook in.

## 11. `src/core/Audio.js` + `src/data/music.js`  *(owner: AUDIO agent)*

All synthesis — zero sample files. WebAudio only, created lazily on the first user
gesture (`AudioContext.resume()`).

```js
import { AudioSystem } from './core/Audio.js';
const audio = new AudioSystem(ctx);
audio.update(dt)                       // view-rate
audio.playSfx(name, opts)              // opts: { volume, rate, pan }
audio.playMusic(name, fadeSeconds)
audio.stopMusic(fadeSeconds)
audio.setMuted(bool), audio.setVolumes({ master, music, sfx })
audio.setEngine(playerKart)            // start/stop following one kart
audio.dispose()
```

Required SFX names (others may be added):
`'countdown' 'countdownGo' 'start' 'boost' 'miniTurbo' 'mushroom' 'driftSpark'
'driftCharge' 'itemGet' 'itemRoll' 'shellFire' 'shellHit' 'bananaDrop' 'bananaHit'
'star' 'lightning' 'blooper' 'bulletBill' 'lap' 'finalLap' 'finish' 'positionGain'
'offTrack' 'wallHit' 'hop' 'land' 'coin' 'select' 'confirm' 'back' 'crunch' 'squash'`.

Engine: two detuned sawtooth oscillators + a sub sine through a lowpass whose cutoff
and pitch follow a simulated gear curve (6 gears), plus filtered noise for load and a
screech band for tyre slip. Crossfade a second "boost" layer in while boosting.

Music (`src/data/music.js`): 3 tracks — `'menu'`, `'race'`, `'finalLap'` — each defined
as data (bar/pitch/pattern) and played by a small step sequencer (square/triangle/noise
voices + kick/snare/hat). `'race'` must layer an intensity track that fades in on the
final lap.

## 12. `src/race/RaceDirector.js`  *(owner: RACE agent)*

```js
import { RaceDirector } from './race/RaceDirector.js';
const race = new RaceDirector(ctx, { track, karts, laps, playerKart, grid });
race.phase                // 'countdown' | 'racing' | 'finished'
race.timeMs, race.countdownMs
race.standings            // Kart[] sorted best-first, recomputed ~10 Hz
race.player
race.update(dt)
race.view()               // -> RaceView (below)
race.results()            // -> Results (below)
```

```ts
RaceView = {
  phase, timeMs, countdownMs, laps, totalLaps,
  standings: [{ id, name, position, lap, isPlayer, color, gapMs, lapProgress, finished, finishTimeMs, isBot }],
  player: { position, lap, lapProgress, speedKmh, driftTier, driftCharge, itemId,
            itemCount, itemRolling, finishing, placeChange, lastLapMs, bestLapMs },
}
```
```ts
Results = {
  trackId, trackName, cc, laps, totalMs,
  entries: [{ position, id, name, isPlayer, color, totalMs, bestLapMs, lapTimesMs }],
  playerPosition: number,
  newRecord: boolean,
}
```

Must implement: the 3-2-1 countdown with a start-boost window, lap detection that is
cheat-proof (progress must pass 6 ordered checkpoints), rank computation that handles
the closed loop, live gap-to-leader, `race:lap`/`race:finish`/`race:end` events, a
final-lap transition, and a results table including per-lap times and DNF-free ordering
(anything unfinished sorts by progress).

## 13. `src/ui/*`  *(owner: UI agent)*

```js
import { createUI } from './ui/UI.js';
const ui = createUI(ctx);       // owns #ui-root, shows the boot/title flow
ui.show(screen)                 // 'title' | 'charselect' | 'trackselect' | 'hud' |
                                // 'results' | 'pause' | 'loading'
ui.update(dt, raceView)
ui.dispose()
```
Screens required: boot/loading with a progress bar and rotating tips; **title** with the
wordmark and a drivable-feeling attract-mode camera; **character select** (grid of 8
cards with a live 3D preview if feasible, else a stylised 2D icon + stat bars);
**track select** (3 cards with a canvas-drawn track outline preview + theme swatches);
**race options** (cc, laps, difficulty, karts, quality, volume) reachable from both
select screens; **HUD** (`src/ui/HUD.js`, `src/ui/Minimap.js`); **results**
(`src/ui/Results.js`); **pause** with resume / restart / quit / settings / controls.

Use the existing `src/styles/main.css` classes (`.screen .panel .btn .seg .card
.hud-* .toast`) — extend the stylesheet if you need more, but keep the identity.
Keyboard + gamepad navigation (up/down/left/right/confirm/back) with visible focus
states and a `data-` attribute on the focused card. All text in English.

Minimap: `<canvas>` 2D, draws the prerendered track outline once into an offscreen
canvas, then each frame scales/rotates it so the player's arrow stays centred, and
blits kart dots, item-box positions and the start line. Also list the standing order
beside it.

## 14. Resolved questions (integrator addendum — read this)

These were ambiguous in v1 and are now settled. Later passes must follow them.

1. **`trackDef.startLine`** is a progress fraction `0..1`; the lap's progress origin is
   that fraction, so within-lap progress is `wrapProgress(locateProgress - startLine)`.
   `Bootstrap._lapProgress()` computes it straight off `TrackPath.locate()` and never
   trusts the race layer, so `RaceDirector` is free to expose `lapProgress` however it
   likes — but **do** make `kart.lapProgress` the within-lap `0..1` value, because the
   HUD scales the minimap arrow with it.
2. **Boost pads / jumps / hazards** are matched in within-lap progress units via the
   integrator, not by the race layer. `TrackBuilder` resolves `def.boostPads /
   def.jumps / def.hazards` and auto-generates them when the track omits them, exposing
   `{p, lateral, width, strength, key}` / `{p, width, height, key}` / `{p, lateral, type}`.
   All three are already populated for all three tracks.
3. **`character.tuning` semantics** (resolved in `KartFactory.createPhysicsDef`):
   - `topSpeed`, `accel` — plain multipliers on `CONFIG.physics`;
   - `turn` — multiplier on `CONFIG.physics.turn.min/max`;
   - `drift` — higher means a *tighter, more controllable* slide: it scales
     `driftMultiplier` up and `driftSlide` down;
   - `mass` — base `1`, range `0.76..1.30`; scales brake force, spinout duration and the
     kart-kart collision impulse;
   - `offTrack` — higher means a *harsher* off-road penalty, applied to `offTrackDrag`.
4. **`ItemSystem` options** now include `itemBoxRows` (rows resolved by `TrackBuilder`)
   and `boxes` (pre-built boxes if the builder makes them). Accept and prefer them; fall
   back to auto-generating rows every `CONFIG.items.autoRows` of progress.
5. **`KartPhysics` emits through `onEvent(name, payload)`**, never the bus — names are
   `driftStart, driftEnd, driftCharge, driftRelease, miniTurbo, boostStart, boostEnd,
   land, wallHit, spinoutStart, spinoutEnd, surfaceChange, hopStart, engine`. The
   integrator translates these into `fx:spawn` / `audio:sfx`, so **`Particles` and
   `AudioSystem` must read the bus / direct calls, not the physics events**.
6. **`AudioSystem`** is created once by `main.js` and registered as a *persistent* system
   (it survives race teardown). `main.js` calls `setEngine(playerKart)`,
   `playMusic(name, fade)`, `stopMusic(fade)`, `setVolumes`, `setMuted`, `playSfx`.
   Optional `pauseAll()` / `resumeAll()` / `unlock()` / `resume()` / `setEngineState()`.
7. **The night track** (`neon-harbour`) leans on emissive materials + UnrealBloom for its
   look, and `Decor` steers `ctx.game.hemi/.ambient/.fill` from `theme.sky`. The
   `CameraRig`/`Particles` passes must not reset those.
8. **`Bootstrap` guarantees nothing falls out of the world**: any kart more than 12 m
   below the track surface is reset onto the ribbon. `CameraRig` should also clamp the
   camera above `TrackPath.surfaceHeight(camera.x, camera.z)`.
9. **`TRACKS` are polar loops**, so self-intersection is structurally impossible and the
   three courses do not overlap in XZ (min clearance 29–31 m at equal-arc sampling).

## 15. Integrator-owned (do not write these)

`src/main.js`, `src/race/Bootstrap.js`, `src/world/TitleScene.js`,
`scripts/check.mjs`, `docs/CONTRACT.md`.
