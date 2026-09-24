/** Minimal reactive store. No framework, no diffing. */

export const MODES = {
  BOOT: 'boot',
  TITLE: 'title',
  CHAR_SELECT: 'charselect',
  TRACK_SELECT: 'trackselect',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  PAUSED: 'paused',
  FINISHED: 'finished',
};

function create(initial) {
  const state = { ...initial };
  const listeners = new Set();
  let dirty = false;
  return {
    get state() {
      return state;
    },
    set(patch) {
      Object.assign(state, patch);
      dirty = true;
    },
    /** Replaces a nested object reference (shallow) then notifies. */
    notify() {
      if (!dirty) return;
      dirty = false;
      for (const fn of [...listeners]) fn(state);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const GameStore = create({
  mode: MODES.BOOT,
  /** @type {string|null} */
  characterId: 'bolt',
  /** @type {string} */
  trackId: 'sunset-circuit',
  /** 50 / 100 / 150 / 200 */
  cc: 150,
  /** 'easy' | 'normal' | 'hard' | 'insane' */
  difficulty: 'normal',
  laps: 3,
  playerCount: 8,
  muted: false,
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  /** 'low' | 'medium' | 'high' */
  quality: 'high',
  /** Filled in by the race director once a race exists. */
  race: null,
  /** Filled in when a race finishes. */
  results: null,
  /** Best lap times per track, persisted to localStorage. */
  records: {},
});

const KEY = 'kart-rush/settings-v1';

export function loadPersisted() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const { state } = GameStore;
    for (const k of ['characterId', 'trackId', 'cc', 'difficulty', 'laps', 'muted', 'masterVolume', 'musicVolume', 'sfxVolume', 'quality', 'playerCount']) {
      if (k in parsed) state[k] = parsed[k];
    }
  } catch {
    /* ignore corrupt storage */
  }
  try {
    const rec = localStorage.getItem('kart-rush/records-v1');
    if (rec) state.records = JSON.parse(rec);
  } catch {
    /* ignore */
  }
}

export function persist() {
  try {
    const s = GameStore.state;
    const pick = {
      characterId: s.characterId,
      trackId: s.trackId,
      cc: s.cc,
      difficulty: s.difficulty,
      laps: s.laps,
      playerCount: s.playerCount,
      muted: s.muted,
      masterVolume: s.masterVolume,
      musicVolume: s.musicVolume,
      sfxVolume: s.sfxVolume,
      quality: s.quality,
    };
    localStorage.setItem(KEY, JSON.stringify(pick));
    localStorage.setItem('kart-rush/records-v1', JSON.stringify(s.records));
  } catch {
    /* storage may be unavailable */
  }
}

export function saveRecord(trackId, bestLapMs, totalMs) {
  const s = GameStore.state;
  const prev = s.records[trackId];
  const next = {
    bestLapMs: prev ? Math.min(prev.bestLapMs, bestLapMs) : bestLapMs,
    totalMs: prev ? Math.min(prev.totalMs, totalMs) : totalMs,
  };
  s.records = { ...s.records, [trackId]: next };
  persist();
}

export { create as createStore };
