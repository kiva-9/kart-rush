/**
 * RaceDirector — the race rules engine.
 *
 * Owns: the 3-2-1 countdown (with the start-boost window), cheat-proof lap
 * detection over an ordered checkpoint set, standings on a closed loop, live
 * gap-to-leader, per-lap timing, the final-lap transition and the results table.
 *
 * The per-step path allocates nothing: progress is read straight off the physics
 * layer's own `locate()` result (zero extra track queries), while the expensive
 * work — standings, gaps, points and the published HUD snapshot — is refreshed
 * at 10 Hz exactly as the contract asks.
 *
 * Units: metres, seconds internally, milliseconds on every clock that leaves
 * this module. Progress is a 0..1 fraction of the closed centreline; within-lap
 * progress is measured from `trackDef.startLine` per CONTRACT §14.1.
 */
import { CONFIG } from '../data/config.js';
import { GameStore, MODES } from '../core/Store.js';
import { clamp, wrapProgress } from '../core/MathUtils.js';

/** Standings / gap / published-snapshot cadence. */
const REFRESH_INTERVAL = 0.1;
/** On-demand view() rebuild throttle, so a per-frame poll stays cheap. */
const VIEW_INTERVAL = 0.04;

const MIN_CHECKPOINTS = 6;
const MAX_CHECKPOINTS = 24;
const FALLBACK_TRACK_LENGTH = 1200;
const FALLBACK_POINTS = [15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
/** A checkpoint this close to the line is the line, not a checkpoint. */
const LINE_CHECKPOINT_EPS = 0.005;
/** Two checkpoints closer together than this are the same checkpoint. */
const DUPLICATE_EPS = 0.01;
/** Gap readout clamp, in ms. */
const MAX_GAP_MS = 120000;
/** Absolute safety valve so a wedged race always produces a results screen. */
const MAX_RACE_SECONDS = 900;
/** Places-gained indicator lifetime. */
const PLACE_CHANGE_WINDOW = 3.0;
/**
 * Net forward travel, in laps, that must separate two line crossings before the
 * second one may complete a lap. A kart that credits a lap, reverses a few metres
 * back over the line and drives forward again has only covered ~0.01 of a lap,
 * so this — on top of the checkpoint rule — is what makes the lap unstealable.
 */
const LAP_TRAVEL_MIN = 0.9;

const POINTS = Array.isArray(CONFIG.race.points) && CONFIG.race.points.length
  ? CONFIG.race.points
  : FALLBACK_POINTS;

export class RaceDirector {
  /**
   * @param {object} ctx game context (bus, store, game, input)
   * @param {object} [options] { track, trackDef, builder, karts, laps, playerKart, grid, rng }
   */
  constructor(ctx, options) {
    const o = options || {};
    this.ctx = ctx || {};
    this.bus = this.ctx.bus || null;
    this.store = this.ctx.store || GameStore;
    this.game = this.ctx.game || null;

    this.track = o.track || this.ctx.track || null;
    this.trackDef = o.trackDef || this.ctx.trackDef || null;
    this.builder = o.builder || null;
    this.grid = Array.isArray(o.grid) ? o.grid : null;
    // Optional seam: the minimap plots item boxes off `race.items.boxes`. The
    // ItemSystem owns them and is constructed after the director, so the
    // integrator can hand it over either through the options or by assigning
    // `race.items` afterwards. Purely read-only for this module.
    this.items = o.items || null;
    this.karts = Array.isArray(o.karts) ? o.karts.slice() : [];
    this.player = o.playerKart || this.karts.find((k) => k && k.isPlayer) || this.karts[0] || null;

    const state = (this.store && this.store.state) || {};
    const lapCount = Number.isFinite(o.laps) ? o.laps : state.laps;
    this.totalLaps = clamp(Math.round(lapCount || 3), 1, 30);

    const len = this.track && Number.isFinite(this.track.length) && this.track.length > 40
      ? this.track.length
      : FALLBACK_TRACK_LENGTH;
    this.trackLength = len;

    const sl = this.trackDef && Number.isFinite(this.trackDef.startLine)
      ? this.trackDef.startLine
      : (this.track && Number.isFinite(this.track.startLine) ? this.track.startLine : 0);
    this.startLine = wrapProgress(sl);

    // --- progress-space hysteresis thresholds, derived from the track length ---
    this._cpEps = clamp(4 / len, 0.0015, 0.01);
    this._lineBand = clamp(60 / len, 0.02, 0.12);
    this._lineExit = clamp(20 / len, 0.008, 0.06);

    this.checkpoints = this._resolveCheckpoints(o);

    // --- clocks -------------------------------------------------------------
    this.phase = 'countdown';
    this.timeMs = 0;
    this.countdownMs = Math.max(0.3, +CONFIG.race.countdown || 3.3) * 1000;
    this._lastBeep = -1;

    // --- records ------------------------------------------------------------
    /** @type {Array<object>} */
    this._recs = [];
    this._byKart = new Map();
    this._order = [];
    this.standings = [];
    this._finishedOrder = [];

    for (let i = 0; i < this.karts.length; i++) {
      const kart = this.karts[i];
      if (!kart) continue;
      const rec = this._makeRecord(kart, i);
      this._recs.push(rec);
      this._order.push(rec);
      this._byKart.set(kart, rec);
    }
    // If nothing is flagged as the player, the first kart stands in for it so the
    // HUD, the results table and the store all agree on who "the player" is.
    let anyPlayer = false;
    for (let i = 0; i < this._recs.length; i++) if (this._recs[i].isPlayer) anyPlayer = true;
    if (!anyPlayer && this.player) {
      const rec = this._byKart.get(this.player);
      if (rec) {
        rec.isPlayer = true;
        rec.isBot = false;
      }
    }

    this._results = null;
    this._view = null;
    this._viewDirty = true;
    this._acc = 0;
    this._viewAcc = VIEW_INTERVAL;
    this._endTimer = 0;
    this._endStarted = false;
    this._finalLapCued = false;
    this._disposed = false;
    this._locOut = { progress: 0, lateral: 0, index: 0, surface: 'road' };

    // Publish ourselves on the context: the controllers read `ctx.race.phase` /
    // `ctx.race.countdownMs` to hold the grid before GO, and nothing else owns
    // that slot. Purely a runtime hand-off — no other module is touched.
    if (this.ctx && typeof this.ctx === 'object') this.ctx.race = this;

    this._initialiseRecords();
    this._recomputeStandings();
    this._publish();
    // Lights on: the first beep fires with the race rather than on the first
    // simulation step, so the countdown and the audio are in lockstep.
    const first = Math.floor(this.countdownMs / 1000);
    this._lastBeep = first;
    this._emit('race:countdown', { remaining: first });
  }

  // ------------------------------------------------------------------ records

  /**
   * Grid position for a kart that does not carry one: the slot closest to the
   * start line is pole. Grid slots are index-aligned with the kart array.
   */
  _gridRank(i) {
    const grid = this.grid;
    if (!grid || !grid.length || i >= grid.length) return i + 1;
    const slot = grid[i];
    const p = slot && Number.isFinite(slot.progress) ? slot.progress : null;
    if (p == null) return i + 1;
    let rank = 1;
    for (let j = 0; j < grid.length; j++) {
      if (j === i) continue;
      const s = grid[j];
      if (!s || !Number.isFinite(s.progress)) continue;
      if (s.progress > p + 1e-6 || (Math.abs(s.progress - p) <= 1e-6 && j < i)) rank++;
    }
    return rank;
  }

  _makeRecord(kart, i) {
    const sp = Number.isFinite(kart.startPosition) ? kart.startPosition : this._gridRank(i);
    const rec = {
      kart,
      id: Number.isFinite(kart.id) ? kart.id : i,
      name: typeof kart.name === 'string' && kart.name ? kart.name : `Kart ${i + 1}`,
      isPlayer: !!kart.isPlayer,
      color: typeof kart.color === 'string' && kart.color ? kart.color : '#ffffff',
      isBot: !kart.isPlayer,
      startPosition: sp,
      lap: 1,
      lp: 0,
      unwrapped: 0,
      racePos: 0,
      creditRef: 0,
      cpIndex: 0,
      armed: false,
      exitOk: false,
      lapStartMs: null,
      lapTimes: [],
      best: null,
      last: null,
      finished: false,
      finishMs: null,
      position: sp,
      gapMs: 0,
      points: 0,
      placeChange: 0,
      placeTimer: 0,
      finalLapCued: false,
      locP: null,
      locBudget: 0,
    };
    return rec;
  }

  /**
   * Checkpoints in lap-relative progress units, ascending, none of them the line.
   * Any source (TrackPath, TrackDef or TrackBuilder) is accepted and normalised
   * into that one shape, so the order is identical whichever module produced it.
   */
  _resolveCheckpoints(o) {
    const sources = [
      o.track && o.track.checkpoints,
      this.track && this.track.checkpoints,
      o.trackDef && o.trackDef.checkpoints,
      this.trackDef && this.trackDef.checkpoints,
      o.builder && o.builder.checkpoints,
      this.builder && this.builder.checkpoints,
    ];
    let raw = null;
    for (const src of sources) {
      if (!Array.isArray(src) || src.length < MIN_CHECKPOINTS) continue;
      const vals = [];
      for (const v of src) {
        const n = +v;
        if (Number.isFinite(n)) vals.push(n);
      }
      if (vals.length >= MIN_CHECKPOINTS) {
        raw = vals;
        break;
      }
    }

    const out = [];
    if (raw) {
      const rel = [];
      for (const v of raw) {
        const r = wrapProgress(v - this.startLine);
        if (r < LINE_CHECKPOINT_EPS) continue;
        rel.push(r);
      }
      rel.sort((a, b) => a - b);
      for (const r of rel) {
        if (out.length && r - out[out.length - 1] < DUPLICATE_EPS) continue;
        out.push(r);
      }
    }
    if (out.length < MIN_CHECKPOINTS) {
      out.length = 0;
      const n = Math.max(MIN_CHECKPOINTS, Math.min(MAX_CHECKPOINTS, this.karts.length || MIN_CHECKPOINTS));
      for (let i = 0; i < n; i++) out.push((i + 0.5) / n);
    }
    if (out.length > MAX_CHECKPOINTS) {
      const keep = [];
      const stride = out.length / MAX_CHECKPOINTS;
      for (let i = 0; i < MAX_CHECKPOINTS; i++) keep.push(out[Math.floor(i * stride)]);
      return keep;
    }
    return out;
  }

  /** Seeds every kart's progress reference from its grid slot. */
  _initialiseRecords() {
    for (let i = 0; i < this._recs.length; i++) {
      const rec = this._recs[i];
      const lp = wrapProgress(this._sampleProgress(rec, 0) - this.startLine);
      rec.lp = lp;
      rec.unwrapped = lp;
      rec.racePos = lp;
      rec.creditRef = lp;
      const n = this.checkpoints.length;
      let ahead = 0;
      while (ahead < n && this.checkpoints[ahead] <= lp + this._cpEps) ahead++;
      // Karts line up behind the line: their first crossing *starts* lap 1 rather
      // than completing it. A kart that already sits past the line is armed.
      rec.armed = lp <= 0.5;
      rec.cpIndex = rec.armed ? ahead : 0;
      rec.exitOk = rec.armed;
      rec.lapStartMs = rec.armed ? 0 : null;
      const kart = rec.kart;
      kart.lap = 1;
      kart.lapProgress = lp;
      kart.raceProgress = lp;
      kart.lapTimesMs = rec.lapTimes;
      kart.bestLapMs = null;
      kart.lastLapMs = null;
      kart.finished = false;
      kart.finishTimeMs = null;
      kart.rank = rec.position;
    }
  }

  // -------------------------------------------------------------------- clock

  _stepCountdown(dt) {
    this.countdownMs -= dt * 1000;
    const sec = Math.floor(Math.max(0, this.countdownMs) / 1000);
    if (sec !== this._lastBeep) {
      this._lastBeep = sec;
      this._emit('race:countdown', { remaining: sec });
    }
    if (this.countdownMs <= 0) {
      this.countdownMs = 0;
      this._go();
    }
  }

  _go() {
    this.phase = 'racing';
    this.timeMs = 0;
    for (let i = 0; i < this._recs.length; i++) {
      const rec = this._recs[i];
      rec.lap = 1;
      rec.kart.lap = 1;
    }
    this._grantStartBoost();
    const st = this.store && this.store.state;
    if (st && st.mode !== MODES.PAUSED && st.mode !== MODES.FINISHED) {
      this.store.set({ mode: MODES.RACING });
      this.store.notify();
    }
    this._emit('race:go', {});
  }

  /**
   * Backstop for the start boost: PlayerController decides it on its own clock,
   * so this only fires when the controller has not already made the call.
   */
  _grantStartBoost() {
    const kart = this.player;
    if (!kart) return;
    const boost = CONFIG.physics.boost && CONFIG.physics.boost.startBoost;
    if (!boost || typeof kart.applyBoost !== 'function') return;
    const c = kart.controller;
    if (c && c.startBoostGranted === true) return;

    const win = +CONFIG.race.startBoostWindow || 0.85;
    const released = c && Number.isFinite(c.lastStartBoostReleased) ? c.lastStartBoostReleased : null;
    let earned = false;
    if (released != null) earned = released <= win + 0.25;
    else {
      const inp = this.ctx.input;
      earned = !!(inp && typeof inp.isDown === 'function' && inp.isDown('accelerate'));
    }
    if (c && typeof c.startBoostGranted === 'boolean') c.startBoostGranted = true;
    if (!earned) return;
    try {
      kart.applyBoost('startBoost', boost.duration, boost.multiplier);
    } catch (err) {
      return;
    }
    this._emit('kart:boost', { kartId: Number.isFinite(kart.id) ? kart.id : 0, kind: 'startBoost' });
    const g = this.game;
    if (g && typeof g.sfx === 'function') g.sfx('boost', { kind: 'startBoost' });
  }

  // ------------------------------------------------------------------- update

  /** Fixed simulation step. */
  update(dt, ctx) {
    if (this._disposed) return;
    if (ctx) {
      this.ctx = ctx;
      if (!this.bus && ctx.bus) this.bus = ctx.bus;
      if (!this.game && ctx.game) this.game = ctx.game;
    }
    const step = clamp(dt > 0 ? dt : 1 / 120, 1e-5, 0.1);
    this._acc += step;
    this._viewAcc += step;

    if (this.phase === 'countdown') {
      this._stepCountdown(step);
      this._trackKarts(step, false);
    } else if (this.phase === 'racing') {
      this._stepRacing(step);
    }

    if (this._acc >= REFRESH_INTERVAL) {
      this._acc -= REFRESH_INTERVAL;
      if (this._acc > REFRESH_INTERVAL) this._acc = 0;
      this._recomputeStandings();
      this._publish();
    }
    if (this._viewAcc >= VIEW_INTERVAL) {
      this._viewAcc = 0;
      this._viewDirty = true;
    }
  }

  /** System hook: the director has no per-frame view work of its own. */
  updateView() {}

  /** System hook. */
  init(ctx) {
    if (!ctx) return;
    this.ctx = ctx;
    if (ctx.bus) this.bus = ctx.bus;
    if (ctx.game) this.game = ctx.game;
    if (ctx.store) this.store = ctx.store;
  }

  _stepRacing(dt) {
    this.timeMs += dt * 1000;
    this._trackKarts(dt, true);

    if (!this._endStarted) {
      const racing = this._recs.length - this._finishedOrder.length;
      if (this.player && this._recKart(this.player) && this._recKart(this.player).finished) {
        this._beginEndSequence();
      } else if (racing <= 0 && this._recs.length > 0) {
        this._beginEndSequence();
      } else if (this.timeMs > MAX_RACE_SECONDS * 1000) {
        this._beginEndSequence();
      }
    } else {
      this._endTimer -= dt;
      const racing = this._recs.length - this._finishedOrder.length;
      if (this._endTimer <= 0 || racing <= 0) this._finalise();
    }
  }

  _recKart(kart) {
    return kart ? this._byKart.get(kart) : null;
  }

  _beginEndSequence() {
    if (this._endStarted) return;
    this._endStarted = true;
    // A short tail so the player's kart rolls to a stop and the field can cross.
    this._endTimer = Math.max(0.4, (+CONFIG.race.finishLineHoldTime || 1) * 2);
  }

  // ------------------------------------------------------------- progress

  /**
   * Absolute centreline progress (0..1) for a kart. Prefers the physics layer's
   * own locate() result — it already ran this step, so this costs nothing — and
   * only falls back to querying the track at 20 Hz for karts without physics.
   */
  _sampleProgress(rec, dt) {
    const kart = rec.kart;
    const phys = kart.physics;
    if (phys && Number.isFinite(phys.progress)) return phys.progress;

    const track = this.track;
    const pos = kart.position;
    if (track && typeof track.locate === 'function' && pos) {
      rec.locBudget -= dt > 0 ? dt : 0.008;
      if (rec.locBudget <= 0) {
        rec.locBudget = 0.05;
        try {
          const r = track.locate(pos.x, pos.y, pos.z, this._locOut);
          if (r && Number.isFinite(r.progress)) rec.locP = r.progress;
        } catch (err) {
          rec.locBudget = 0.5;
        }
      }
      if (rec.locP != null) return rec.locP;
    }
    // Nothing to measure with (headless, or a kart still off the grid).
    const last = wrapProgress(rec.lp + this.startLine);
    return Number.isFinite(last) ? last : this.startLine;
  }

  /**
   * One pass of progress sampling and lap accounting. Allocation free.
   * @param {number} dt
   * @param {boolean} allowLaps false during the countdown: nothing may be credited
   */
  _trackKarts(dt, allowLaps) {
    const recs = this._recs;
    const n = this.checkpoints.length;
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      if (rec.finished) continue;
      const kart = rec.kart;

      const lp = wrapProgress(this._sampleProgress(rec, dt) - this.startLine);
      const prev = rec.lp;
      rec.lp = lp;
      kart.lapProgress = lp;

      // Raw delta first: a jump of more than half a lap is a wrap, and the raw
      // sign is the only honest evidence of which way the kart crossed the line.
      const raw = lp - prev;
      let d = raw;
      if (d < -0.5) d += 1;
      else if (d > 0.5) d -= 1;
      rec.unwrapped += d;
      // A single non-finite delta must not poison this kart's progress forever:
      // it would silently corrupt the standings sort for everyone.
      if (!Number.isFinite(rec.unwrapped)) rec.unwrapped = prev > 0 ? prev : 0;
      if (rec.unwrapped > rec.racePos) rec.racePos = rec.unwrapped;
      if (!Number.isFinite(rec.racePos)) rec.racePos = rec.unwrapped;
      kart.raceProgress = rec.racePos;

      // Checkpoint credit and the "has left the line" latch always track, even
      // before GO, so a kart that creeps over the line during the countdown is
      // already armed when the lights go out. Only the lap *credit* is gated.
      if (d > 0) {
        while (rec.cpIndex < n && lp >= this.checkpoints[rec.cpIndex] + this._cpEps) rec.cpIndex++;
        if (lp > this._lineExit) rec.exitOk = true;
      } else if (d < 0) {
        while (rec.cpIndex > 0 && lp + this._cpEps < this.checkpoints[rec.cpIndex - 1]) rec.cpIndex--;
      }

      // --- start line ---
      if (raw < -0.5) {
        // Forward crossing: only the slice just past the line counts, and only
        // from the far side of the lap.
        if (lp <= this._lineBand && prev >= 0.5) {
          if (!rec.armed) {
            rec.armed = true;
            rec.cpIndex = 0;
            rec.exitOk = false;
            rec.creditRef = rec.unwrapped;
            if (rec.lapStartMs == null) rec.lapStartMs = this.timeMs;
          } else if (allowLaps && rec.exitOk && rec.cpIndex >= n &&
            rec.unwrapped - rec.creditRef >= LAP_TRAVEL_MIN) {
            this._creditLap(rec);
          }
        }
      } else if (raw > 0.5) {
        // Backward crossing: no lap may be lost, and the checkpoint credit is
        // wiped so a full lap has to be driven again before the next one counts.
        rec.cpIndex = 0;
        rec.exitOk = false;
      }
    }
  }

  _creditLap(rec) {
    const now = this.timeMs;
    const start = rec.lapStartMs == null ? now : rec.lapStartMs;
    const lapTime = Math.max(0, now - start);
    rec.lapTimes.push(lapTime);
    rec.last = lapTime;
    if (rec.best == null || lapTime < rec.best) rec.best = lapTime;
    rec.lapStartMs = now;
    rec.cpIndex = 0;
    rec.exitOk = false;
    rec.creditRef = rec.unwrapped;

    const kart = rec.kart;
    kart.lastLapMs = lapTime;
    kart.bestLapMs = rec.best;

    const completed = rec.lap;
    if (completed >= this.totalLaps) {
      this._finishKart(rec, now);
    } else {
      rec.lap = completed + 1;
      kart.lap = rec.lap;
    }
    this._emit('race:lap', {
      kartId: rec.id,
      lap: completed,
      lapTimeMs: Math.round(lapTime),
      bestLapMs: rec.best == null ? null : Math.round(rec.best),
      isPlayer: rec.isPlayer,
    });
  }

  _finishKart(rec, now) {
    rec.finished = true;
    rec.finishMs = now;
    const kart = rec.kart;
    kart.finished = true;
    kart.finishTimeMs = Math.round(now);
    this._finishedOrder.push(rec);
    this._emit('race:finish', {
      kartId: rec.id,
      isPlayer: rec.isPlayer,
      position: this._finishedOrder.length,
    });
  }

  // -------------------------------------------------------------- standings

  _compareRecs(a, b) {
    // A non-finite progress would make this comparator return NaN, which is
    // undefined behaviour for Array.sort and can silently duplicate positions,
    // so it is flattened to a deterministic tie-break instead.
    const ap = Number.isFinite(a.racePos) ? a.racePos : -Infinity;
    const bp = Number.isFinite(b.racePos) ? b.racePos : -Infinity;
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) {
      const af = Number.isFinite(a.finishMs) ? a.finishMs : Infinity;
      const bf = Number.isFinite(b.finishMs) ? b.finishMs : Infinity;
      if (af !== bf) return af - bf;
      return a.startPosition - b.startPosition;
    }
    if (bp !== ap) return bp - ap;
    return a.startPosition - b.startPosition;
  }

  /** Rank, gap-to-leader, points and the final-lap cue, all at 10 Hz. */
  _recomputeStandings() {
    const order = this._order;
    order.sort(this._compareRecs.bind(this));

    const total = order.length;
    let speedSum = 0;
    let speedCount = 0;
    for (let i = 0; i < total; i++) {
      const s = order[i].kart ? order[i].kart.speedKmh : 0;
      if (Number.isFinite(s) && s > 1) {
        speedSum += s / 3.6;
        speedCount++;
      }
    }
    const avgSpeed = speedCount > 0 ? speedSum / speedCount : 22;
    const lapSeconds = this.trackLength / clamp(avgSpeed, 6, 90);
    const leader = order[0] || null;

    for (let i = 0; i < total; i++) {
      const rec = order[i];
      const pos = i + 1;
      if (rec.position !== pos) {
        if (rec.isPlayer) {
          if (Number.isFinite(rec.position) && rec.position > 0) rec.placeChange += rec.position - pos;
          rec.placeTimer = PLACE_CHANGE_WINDOW;
        }
        rec.position = pos;
        rec.kart.rank = pos;
      }
      rec.points = i < POINTS.length ? POINTS[i] : 0;
      rec.kart.points = rec.points;

      if (i === 0) {
        rec.gapMs = 0;
      } else if (rec.finished && leader && leader.finished) {
        rec.gapMs = clamp(rec.finishMs - leader.finishMs, 0, MAX_GAP_MS);
      } else if (leader) {
        rec.gapMs = clamp((leader.racePos - rec.racePos) * lapSeconds * 1000, 0, MAX_GAP_MS);
      }

      if (rec.placeTimer > 0) {
        rec.placeTimer -= REFRESH_INTERVAL;
        if (rec.placeTimer <= 0) rec.placeChange = 0;
      }

      if (rec.isPlayer && !rec.finalLapCued && this.phase !== 'countdown' &&
        rec.lap >= this.totalLaps && this.timeMs > 500) {
        rec.finalLapCued = true;
        this._emit('ui:toast', { text: 'FINAL LAP', kind: 'warn', duration: 1.8 });
      }
    }

    if (!this._finalLapCued && this.totalLaps > 0 && leader && this.phase !== 'countdown' &&
      leader.lap >= this.totalLaps && this.timeMs > 250) {
      this._finalLapCued = true;
      this._emit('audio:music', { name: 'finalLap', fade: 0.6 });
      if (this.game && typeof this.game.sfx === 'function') this.game.sfx('finalLap', { volume: 0.7 });
    }

    this.standings = [];
    for (let i = 0; i < total; i++) this.standings.push(order[i].kart);
  }

  // -------------------------------------------------------------------- views

  /** Latest snapshot, rebuilt on demand at ~25 Hz so per-frame polls stay cheap. */
  view() {
    if (this._viewDirty || !this._view) {
      this._view = this._buildView();
      this._viewDirty = false;
    }
    return this._view;
  }

  _buildView() {
    const order = this._order;
    const standings = [];
    for (let i = 0; i < order.length; i++) {
      const rec = order[i];
      standings.push({
        id: rec.id,
        name: rec.name,
        position: rec.position,
        lap: rec.lap,
        isPlayer: rec.isPlayer,
        color: rec.color,
        gapMs: Math.round(rec.gapMs),
        lapProgress: rec.lp,
        finished: rec.finished,
        finishTimeMs: rec.finishMs == null ? null : Math.round(rec.finishMs),
        isBot: !rec.isPlayer,
      });
    }

    let player = null;
    const prec = this._recKart(this.player);
    if (prec) {
      const kart = prec.kart;
      const phys = kart.physics;
      const drift = phys && phys.drift ? phys.drift : null;
      const item = kart.item;
      const kmh = Number.isFinite(kart.speedKmh) ? kart.speedKmh : 0;
      player = {
        position: prec.position,
        lap: clamp(prec.lap, 1, this.totalLaps),
        lapProgress: prec.lp,
        speedKmh: Math.round(kmh * 10) / 10,
        driftTier: drift && Number.isFinite(drift.tier) ? drift.tier : 0,
        driftCharge: drift && Number.isFinite(drift.charge) ? drift.charge : 0,
        itemId: item && item.id ? item.id : null,
        itemCount: item && Number.isFinite(item.count) ? item.count : 0,
        itemRolling: !!(item && item.rolling),
        finishing: prec.finished,
        placeChange: prec.placeChange,
        lastLapMs: prec.last == null ? null : Math.round(prec.last),
        bestLapMs: prec.best == null ? null : Math.round(prec.best),
      };
    }

    return {
      phase: this.phase,
      timeMs: Math.round(this.timeMs),
      countdownMs: Math.round(this.countdownMs),
      laps: player ? player.lap : 1,
      totalLaps: this.totalLaps,
      standings,
      player,
    };
  }

  /** Publishes the 10 Hz snapshot to the bus and the store. */
  _publish() {
    const view = this._buildView();
    this._view = view;
    this._viewDirty = false;
    const store = this.store;
    if (store && store.set) {
      store.set({ race: view });
      store.notify();
    }
    this._emit('race:update', view);
  }

  /** Full results table. Safe to call at any time; frozen once the race is over. */
  results() {
    if (!this._results) this._results = this._buildResults();
    return this._results;
  }

  _buildResults() {
    const order = this._order;
    const entries = [];
    for (let i = 0; i < order.length; i++) {
      const rec = order[i];
      entries.push({
        position: rec.position,
        id: rec.id,
        name: rec.name,
        isPlayer: rec.isPlayer,
        color: rec.color,
        // A kart that never crossed the line still gets a time: how long it had
        // been racing, so the standings table never shows a bare zero.
        totalMs: rec.finishMs == null ? Math.round(this.timeMs) : Math.round(rec.finishMs),
        bestLapMs: rec.best == null ? null : Math.round(rec.best),
        lapTimesMs: rec.lapTimes.map((t) => Math.round(t)),
        points: rec.points,
        finished: rec.finished,
      });
    }

    const st = (this.store && this.store.state) || {};
    const trackId = (this.trackDef && this.trackDef.id) || st.trackId || '';
    const trackName = (this.trackDef && this.trackDef.name) || trackId || 'Sunset Circuit';
    let me = null;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].isPlayer) {
        me = entries[i];
        break;
      }
    }
    const prev = st.records ? st.records[trackId] : null;
    let newRecord = false;
    if (me) {
      if (me.bestLapMs != null && (!prev || me.bestLapMs < prev.bestLapMs)) newRecord = true;
      if (me.totalMs != null && (!prev || me.totalMs < prev.totalMs)) newRecord = true;
    }

    return {
      trackId,
      trackName,
      cc: Number.isFinite(st.cc) ? st.cc : 150,
      laps: this.totalLaps,
      totalMs: me && me.totalMs != null ? me.totalMs : Math.round(this.timeMs),
      entries,
      playerPosition: me ? me.position : 0,
      newRecord,
    };
  }

  _finalise() {
    if (this._disposed || this.phase === 'finished') return;
    this.phase = 'finished';
    this._recomputeStandings();
    const results = this._buildResults();
    this._results = results;
    const store = this.store;
    const st = (store && store.state) || {};
    st.results = results;
    st.race = this.view();
    st.mode = MODES.FINISHED;
    if (store && store.set) {
      store.set({ results, race: st.race, mode: MODES.FINISHED });
      store.notify();
    }
    this._emit('race:end', { results });
  }

  // -------------------------------------------------------------------- utils

  _emit(type, payload) {
    const bus = this.bus || (this.ctx && this.ctx.bus);
    if (!bus || typeof bus.emit !== 'function') return;
    try {
      bus.emit(type, payload);
    } catch (err) {
      /* a broken listener must never stop the race */
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._recs.length = 0;
    this._order.length = 0;
    this._finishedOrder.length = 0;
    this.standings = [];
    this.karts = [];
    this._byKart.clear();
    this.player = null;
    this.track = null;
    this.trackDef = null;
    this.builder = null;
    this.grid = null;
    this.items = null;
    this._view = null;
    this._results = null;
    this._locOut = null;
    this.ctx = null;
    this.bus = null;
    this.game = null;
    this.store = null;
  }
}

export default RaceDirector;
