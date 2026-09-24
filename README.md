# Kart Rush — Turbo Championship

**Play it: <https://kiva-9.github.io/kart-rush/>** — no install, no server, no
network after the first load.

An AAA-style 3D kart racer that runs entirely in the browser, built with **Three.js 0.170**
and Vite. It is an homage to the 1990s/2000s console kart-racing tradition: original
characters, original circuits, arcade physics, drifting with mini-turbos, a full item
system, and eight racers on the grid.

Every asset is generated at runtime — procedural canvas textures, generated geometry
and WebAudio synthesis. There are **no image, model, font or sound files** in this repo,
and no network requests after the initial page load.

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot module replacement |
| `npm run build` | Production build into `dist/` (three is split into its own chunk) |
| `npm run preview` | Serve the production build |
| `npm run check` | Parse-check every module in `src/` (0 external tools) |
| `npm run build:offline` | **One self-contained HTML file** (~1 MB) that runs from the filesystem |
| `npm run test:pages` | Drive the **live** GitHub Pages deployment in headless Chrome |
| `npm test` | All four suites below, in sequence |

Anything below is a "play the game in a real browser" check — see
[Verification](#verification) for what it does and what it caught:

| Script | What it does |
| --- | --- |
| `node scripts/test-logic.mjs` | Headless sim tests for `TrackPath`, `KartPhysics` and `AIDriver` — **96 checks** |
| `node scripts/test-integration.mjs` | Builds a real 8-kart race with stubbed view layers and simulates it to the flag — **41 checks** |
| `node scripts/test-ui.mjs` | UI-shell and race-plumbing invariants — **28 checks** |
| `npm run test:browser` | Boots the offline build in headless Chrome and **actually drives a race** |

The browser suite takes the same flags as its script: `--seconds`,
`--track <id>`, `--laps`, `--playerCount`, `--timetrial`, `--ui` (a keyboard
walkthrough of every menu screen), `--screenshot <file>`, `--quiet`.

Both test suites pass with zero failures, and `npm run build` produces a working
bundle (~1 MB, 320 kB gzipped) that has been verified end-to-end in a browser.

## Two builds

**`npm run build`** → `dist/`, for hosting on any static server.

**`npm run build:offline`** → `dist-offline/kart-rush-offline.html`, one file you can
double-click, mail, or drop on a USB stick. It runs with no server, no network and
no other files next to it.

The normal build cannot simply be double-clicked because it is ES modules, and
browsers refuse to load those over `file://` (CORS). The offline build therefore
compiles an IIFE bundle and splices the JS into the HTML as a classic inline
script. Since every asset is generated at runtime — procedural canvas textures,
generated geometry, synthesised audio, system fonts — one file really is the whole
game: no images, no models, no sound files, no font files, no `fetch`, no dynamic
`import`. The only thing that degrades is the saved lap records, because
`localStorage` is unavailable on `file://` in some browsers; every access is
guarded so the game just forgets instead of failing.

Verified by loading the single file in a browser and racing on it: 8 karts,
0 → 112 km/h, braking and reversing, item pickups, all three circuits, ~109 fps,
zero console errors.

## Verification

The game has been exercised in a real browser, not just unit-tested: boot to the
title screen, all three circuits, a full race from countdown to results with
8 karts, drifting and mini-turbos, item pickups and deployment, boost pads, the
AFK auto-pilot, pause/resume, the quality tiers and the production build. That
process turned up and fixed a number of integration bugs, which are worth
recording because they are the kind that only appear at runtime:

- `TrackPath.locate()` measured a point 7 km from the track as "1 m past the
  kerb", because the nearest-sample search fell back to sample 0 for far-away
  queries and then measured a perpendicular distance to the wrong segment. That
  let a kart drive off into the void while the wall clamp thought it was fine.
  It now brute-forces the ribbon when the hash misses, and reports true distance.
- The input layer drained its one-shot press queue at the *top* of each frame,
  but key events arrive after `step()` returns, so every keypress was thrown away
  unread. It now drains at the end of the frame.
- `InputManager.beginFrame` also meant a drift press was consumed before the
  smoothed steer axis had ramped past the engage threshold, so pressing drift and
  steer together usually did nothing. The press is now remembered for 200 ms.
- Karts were built without the track reference and without their character, so
  every kart had identical physics and none of them followed the road.
- The quality setting changed a value but never reached the renderer.

A second round, done by actually playing the game, found three more:
- **Throttle and brake latched forever.** `InputManager` set `throttleAxis` /
  `brakeAxis` to 1 when a key was held but never cleared them, and the only
  place that cleared them (`_readGamepad`) returns early when no pad is
  attached. The first axis you touched stuck at 1 — so pressing brake once made
  brake cancel throttle out for the rest of the session and the car could
  neither accelerate nor reverse. They are now rebuilt each frame.
- **No click anywhere reached the UI.** `#ui-root > * { pointer-events: auto }`
  (one id selector) outranked `.toast-layer` / `.flash` / `.count-layer`
  (one class), so the three invisible full-viewport layers were left
  click-enabled and swallowed every mouse press in the game. They now have
  explicit `pointer-events: none` rules.
- **Terrain covered the circuit.** The horizon disc in `TrackBuilder` buried
  itself a fixed 3.4 m below the *landscape* height, but the road is cut several
  metres down into that landscape — so wherever the course descended, the disc
  sat on top of the tarmac and the road vanished under green. It now takes the
  lower of the landscape and the road height and drops below that.

### A third round: the automated browser harness

`scripts/browser-test.mjs` boots the real game in headless Chrome over the
DevTools protocol, starts a race, and drives it for a requested number of
seconds — recording console output, page exceptions, `game.stats`, the live
standings and a screenshot. It also runs a keyboard walkthrough of every menu
screen (`--ui`) and counts which entry point the camera/particle systems are
actually stepped from. Every defect listed below was found by running that
harness (or by the audit passes it replaced) and is pinned by a regression check
in `scripts/test-logic.mjs` / `scripts/test-ui.mjs`.

**Simulation**

- **Every kart read the start-line frame for the whole lap.**
  `KartPhysics._sampleTrack()` called `track.frameAt(loc.index)`, but
  `frameAt()` takes a *progress fraction* — and `wrapProgress()` turns any
  integer into `0`. So bank, surface normal and `right` were frozen at the start
  line for the entire race, and `_clampWall()` pushed the kart back along the
  start line's axis, i.e. sideways into which-ever way happened to be "right"
  there. Measured: 0.13 rad of bank error on Sunset, 0.24 on Frostbite.
- **The camera and particles ran at half speed.** `Game.step()` called
  `sys.update(FIXED)` for every system and skipped `simOnly` systems in the
  *view* loop, so `cameraRig` / `cameraShake` / `particles` were driven at
  1/120 s per rendered frame instead of the real delta. On a 60 Hz display the
  chase camera moved at half rate; the harness now asserts the fx entry points
  accumulate exactly the wall-clock time.
- **Lightning could delete a star.** `_useLightning()` never checked
  star/invincibility (both `_hit()` and `_plow()` do), and squash force-clears
  `physics.star`, so one lightning in the leader's face ended a star run.
- **The Super Horn could not destroy a banana**, despite its own catalogue text,
  because it only considered `kind === 'projectile'` and bananas are hazards.
- **The AI fought its own furniture.** `AIDriver` read `e.owner || e.kart ||
  e.shooter`, but `ItemSystem` writes `ownerId` — so karts treated their own
  bananas and in-flight shells as obstacles and could burn a Super Horn on a
  shell they had fired themselves.
- **Ink Blast was always wasted.** The AI fired it when someone was *behind*,
  but the ink only lands on karts *ahead*.
- **A fired shell left the kart stationary and facing backwards.** Its velocity
  was derived from a position delta that `_spawnTrackSpace()` had already used.
- **A kart that missed the bridge jump drove across the crevasse** on road
  nobody could see: `TrackBuilder` cut the tarmac ribbon over a `gap:true`
  ravine, but `_surfaceFromFrame()` deliberately kept the road. The road now
  ends too, and `RaceSession._rescueProgress()` walks a rescued kart out of the
  hole instead of dropping it back in.
- **`_useStar()` had an unreachable fallback.** It tested
  `typeof kart.starTimer !== 'undefined'` on a `Kart`, which always has the
  getter — so the `applyBoost('star')` branch could never run, and the star was
  the one item that got no boost sfx and no flame.
**World & performance**

- **The terrain had no ravines.** `TrackPath.heightAtFrame()` passed a literal
  `0` as the progress to `_surfaceFromFrame()`, which is what reads the ravine
  list — the mesh the player sees was up to 11 m of solid rock over a crevasse
  the physics surface fell into.
- **Barriers were drawn through.** `TrackBuilder.WALL_OFFSET` was `0.55` while
  `CONFIG.physics.wallOffset` is `1.4`, so the invisible wall sat 0.85 m outside
  the drawn one.
- **`locate()` was up to 90× slower than it needed to be.** The re-seed
  threshold `bd > 64` fires at 8 m, which is *inside* every tarmac, so the whole
  kerb and everything off-track took a hash re-seed plus a brute-force scan. The
  threshold is now the drivable envelope; the same query is a flat ~0.1 µs.
- **`nearestIndex()` lied about far points**, returning sample 0 instead of
  "not found", which put a constant 7 m below sample 0's height into the horizon
  disc.
- **`dropAt()` only measured one side**, so a barrier appeared on one side of a
  corner and not the other.
- **The windmill rotor was 4.4 m from its hub** and spun about an axis 90° off
  it: it was a sibling of the tower with a pre-rotation local position.
- **Item boxes were rebuilt from scratch every race.** `ItemSystem._boxPool` was
  popped from but never pushed to. It is a real module-level pool now, capped so
  it cannot become a leak of its own.
- **~24 textures leaked per race.** `KartModel.dispose()` disposed its
  geometries and materials but not the *textures* on those materials, and
  `Game.teardownRace()` — which does — never saw them, because the kart's group
  had already been detached. Three canvas textures per kart per race.
- **`RaceSession.dispose()` released neither the item system nor the track
  builder**, so a whole world was stranded on every rematch, and the item box
  field kept its references forever.

**UI**

- **Escape in the pause options dumped you into the race.** The shell swallowed
  the key on the pause screen only, so a sub-screen navigated back *and* main.js
  resumed the race in the same frame.
- **The results screen was keyboard- and gamepad-dead** (all three buttons are
  `data-focusable`), because `isInteractiveMenu()` excluded it.
- **The Options screen could not be operated with a keyboard.** The segmented
  controls and the volume sliders were never `data-focusable`; worse,
  `InputManager` unconditionally `preventDefault()`ed the arrow keys, so a
  focused slider could not step at all.
- **Every track-select thumbnail was drawn in the wrong colours.**
  `hexToRgb()` stringified the *numeric* hex `tracks.js` uses and parsed the
  decimal digits as hex.
- **The speed readout never glowed during a boost** — the `boosting` class went
  on the `.hud` root, while the only CSS rule is `.hud-speed.boosting .val`.
- **The results table showed one row.** The panel was squeezed to ~90 px by the
  flex layout, so an 8-row table was pre-scrolled to the winner.
- **Time Trial started a 2-kart race**, because `clamp(1, 2, 8)` turned a field
  of one back into two.
- **The config the UI hands to `race:request` was ignored** — throwaway fields
  on a redispatched object.
- **The engine note droned on through the menus** after a race, because nothing
  ever called `audio.setEngine(null)`.
- **One-shot SFX leaked a `GainNode` each.** `src.onended` disconnected the
  sources and the envelope gains but never the voice's own gain, so every blip
  stayed wired into the sfx bus.
- **`store.notify()` had no subscribers**, and `ui.updateView()` was never
  called, so the UI ran a second `requestAnimationFrame` loop beside Game's.

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Accelerate | `↑` / `W` | RT / A |
| Brake & reverse | `↓` / `S` | LT / B |
| Steer | `←` `→` / `A` `D` | Left stick |
| Hop / drift (hold) | `Space` / `Shift` / `C` | A / RB |
| Use item | `Ctrl` / `E` / `F` | X / Square |
| Look behind | `B` | LB |
| Pause | `Esc` / `P` | Start |
| Respawn on track | `R` | — |

## Driving

The handling model is an arcade one in the spirit of *Mario Kart 64* / *Double Dash*:

- **Drift & mini-turbo.** Hold the drift button while steering into a corner. The kart
  hops, swings its tail out and builds charge for roughly a second per tier. Release at
  tier 1 (blue sparks), tier 2 (orange) or tier 3 (purple) for a progressively stronger
  boost. Sparks, tyre smoke and the HUD meter all read the tier.
- **Rocket start.** Hold accelerate just before the lights go out for a launch boost.
- **Slipstream.** Tuck in behind another kart to charge a small top-speed gain.
- **Off-track.** Grass and gravel cut your top speed badly and kick up dust. Barriers
  bounce you back and cost you far more.
- **Boosts stack by strength**, never by duration, so a mushroom never wastes a
  mini-turbo.

## Items

Thirteen items with position-dependent probabilities, so the leader gets defensive junk
and the back-marker gets the good stuff: banana, triple banana, green shell, triple green
shell, red shell (homing), mushroom, triple mushroom, golden mushroom, star, lightning,
ink blast, rocket bullet and the super horn. Item boxes respawn on a timer and give a
short roulette before the item locks in.

## Roster

Eight original characters across four archetypes (light / medium / heavy / speed) and
five body shapes, each with its own palette, silhouette and tuning multipliers. Top speed
and handling genuinely trade off — no character is strictly better.

## Circuits

Three courses that play differently:

- **Sunset Circuit** — 1497 m, fast and flowing, one hairpin, golden-hour light.
- **Frostbite Peaks** — 1338 m, a technical mountain switchback with 25 m of elevation
  and a jump across a broken bridge.
- **Neon Harbour** — 1393 m, night-time harbour city over water, with a chicane and
  boost pads.

## Architecture

```
src/
  core/       Game (renderer, post chain, fixed-step loop), EventBus, Input, Store, MathUtils
  data/       config.js (all tuning), characters.js, tracks.js, items.js, music.js
  world/      TrackPath (spatial queries), TrackBuilder (geometry), Decor (sky, foliage, props)
  entities/   Kart, KartModel (kart + articulated driver), KartFactory
  physics/    KartPhysics (arcade model, 120 Hz, allocation-free)
  ai/         AIDriver (racing line, speed profile, items), PlayerController
  items/      ItemSystem, ItemBox, ItemArt
  fx/         Particles (pooled GPU points), CameraRig, CameraShake
  audio/      core/Audio.js — engine, SFX and music, all WebAudio synthesis
  race/       RaceDirector (laps, standings, results), Bootstrap (integration seam)
  ui/         UI, Menus, HUD, Minimap, Results, Loading
```

The simulation runs at a **fixed 120 Hz** independent of the render rate; the view layer
(camera, particles, audio) runs once per frame. `docs/CONTRACT.md` is the interface
specification that keeps the modules decoupled — every module talks to the others only
through the shapes named there.

### Conventions

- Y up, right-handed; 1 unit = 1 metre; yaw 0 faces −Z.
- Track progress is a `0..1` fraction of the closed centreline.
- `TrackPath.locate()` is the single source of truth for "where am I on the track":
  the physics, the AI, the items, the race director and the minimap all ask it.
- Quality tiers (`low` / `medium` / `high`) change pixel ratio, shadow resolution, bloom,
  anti-aliasing and particle counts.

## Original work

All characters, tracks, names, code and audio in this project are original. It is a
homage to the kart-racing genre, not a use of any third party's characters, artwork or
trademarks.
