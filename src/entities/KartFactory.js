/**
 * KartFactory — builds Karts and their physics definitions.
 *
 * `createPhysicsDef(character, cc)` folds four things into one flat tuning
 * object that `KartPhysics` reads without knowing about characters or classes:
 *
 *   CONFIG.physics  ->  the baseline
 *   character.tuning ->  per-racer multipliers (topSpeed, accel, turn, drift,
 *                        mass, offTrack)
 *   character.stats ->  the topSpeedBonus, granted at the character's speed stat
 *   cc class        ->  50 x0.88, 100 x0.94, 150 x1.0, 200 x1.08
 *
 * `src/data/characters.js` is owned by another agent, so nothing here imports
 * it: `character` is a plain object we accept if present and ignore if not.
 */
import { CONFIG } from '../data/config.js';
import { Kart } from './Kart.js';
import { KartModel } from './KartModel.js';
import { clamp } from '../core/MathUtils.js';

/** cc class -> multiplier. Anything unrecognised is treated as 150cc. */
const CC_FACTORS = { 50: 0.88, 100: 0.94, 150: 1.0, 200: 1.08 };

/** Fallback palette for karts whose character (or its palette) is missing. */
const FALLBACK_PALETTE = {
  primary: '#e8352f',
  secondary: '#f6f8fb',
  accent: '#ffd60a',
  cap: '#e8352f',
  skin: '#f2b98d',
  hair: '#4b2e1c',
  tire: '#191b21',
  engine: '#9ad9ff',
  glow: '#ffd166',
};

const DRIVER_BODIES = ['human', 'dino', 'ape', 'mushroom', 'koopaKing'];

const ROSTER = ['bolt', 'verdi', 'aurelia', 'tiko', 'fungi', 'kongo', 'bruto', 'gordo'];

const FALLBACK_COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffd60a', '#af52de', '#2ae0a8', '#ff9500', '#32d6ff'];

/**
 * @param {object|null} character CharacterDef (may be null / partial)
 * @param {number} [cc] engine class from the store
 * @returns {object} merged physics def
 */
export function createPhysicsDef(character, cc) {
  const base = CONFIG.physics;
  const ch = character || {};
  const tuning = ch.tuning || {};
  const stats = ch.stats || {};
  const ccClass = cc == null ? 150 : cc;
  const ccFactor = CC_FACTORS[ccClass] == null ? 1 : CC_FACTORS[ccClass];

  const tune = {
    topSpeed: num(tuning.topSpeed, 1),
    accel: num(tuning.accel, 1),
    turn: num(tuning.turn, 1),
    drift: num(tuning.drift, 1),
    mass: num(tuning.mass, 1),
    offTrack: num(tuning.offTrack, 1),
  };
  // A character's speed stat tops the base top speed with CONFIG's bonus.
  // With no character (or no stats) the class multiplier is the whole story.
  const hasStats = !!ch.stats && typeof ch.stats.speed === 'number';
  const stat = hasStats ? clamp01((num(ch.stats.speed, 3) - 1) / 4) : 0;

  const topSpeed = (base.topSpeed + base.topSpeedBonus * stat) * ccFactor * tune.topSpeed;
  const accel = base.accel * ccFactor * tune.accel;
  const turnMin = base.turn.min * tune.turn;
  const turnMax = base.turn.max * tune.turn;

  return {
    // longitudinal
    topSpeed,
    topSpeedBonus: base.topSpeedBonus * stat,
    accel,
    reverseSpeed: base.reverseSpeed,
    brakeForce: base.brakeForce * (0.85 + 0.15 * tune.mass),
    drag: base.drag,
    offTrackDrag: base.offTrackDrag * tune.offTrack,
    offTrackSpeedFactor: base.offTrackSpeedFactor,
    // grip / slip
    grip: base.grip * (0.9 + 0.2 * tune.turn),
    // A higher drift stat means a tighter, more controllable slide.
    driftSlide: clamp(base.driftSlide / tune.drift, 0.28, 0.95),
    driftTiers: base.driftTiers.slice(),
    turn: {
      min: turnMin,
      max: turnMax,
      driftMultiplier: base.turn.driftMultiplier * (1 + (tune.drift - 1) * 0.35),
      driftInward: base.turn.driftInward,
    },
    boost: base.boost,
    collision: base.collision,
    slipstream: base.slipstream,
    // status
    spinout: base.spinout * (0.85 + 0.15 * tune.mass),
    spinoutSpeedFactor: clamp(base.spinoutSpeedFactor * (0.75 + 0.25 * tune.mass), 0.12, 0.5),
    squash: base.squash,
    squashSpeedFactor: base.squashSpeedFactor,
    // world
    wallOffset: base.wallOffset,
    wallBounce: base.wallBounce,
    wallSpeedLoss: base.wallSpeedLoss,
    hopVelocity: base.hopVelocity,
    gravity: base.gravity,
    // identity
    mass: tune.mass,
    cc: ccClass,
    ccFactor,
    stats,
    tuning,
    characterId: ch.id || null,
  };
}

function num(v, fallback) {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * @param {object} ctx game context
 * @param {{id?:number, isPlayer?:boolean, characterId?:string, slot?:number,
 *          driverName?:string, rng?:Function, color?:string, track?:object,
 *          physicsDef?:object, character?:object}} [opts]
 * @returns {Kart}
 */
export function createKart(ctx, opts) {
  const o = opts || {};
  const character = o.character || null;
  const palette = character && character.palette ? character.palette : FALLBACK_PALETTE;
  const body = character && DRIVER_BODIES.indexOf(character.body) >= 0 ? character.body : 'human';
  const scale = character && typeof character.scale === 'number' ? character.scale : 1;

  const store = ctx && ctx.store ? ctx.store.state : null;
  const cc = store && typeof store.cc === 'number' ? store.cc : 150;
  const physicsDef = o.physicsDef || createPhysicsDef(character, cc);

  const characterId = o.characterId || (character && character.id) || null;
  const color = pickColor(o.color, character, characterId, o.id == null ? 0 : o.id);
  const driverName = o.driverName || (character && character.name) ||
    (characterId ? characterId : 'Kart ' + ((o.id == null ? 0 : o.id) + 1));

  const kart = new Kart(ctx, {
    id: o.id == null ? 0 : o.id,
    slot: o.slot,
    isPlayer: !!o.isPlayer,
    driverName,
    characterId,
    character,
    color,
    rng: o.rng,
    track: o.track,
    physicsDef,
  });
  // Kart built itself with a default palette before the character was known;
  // apply the real one now so a standalone kart still looks right.
  kart.model.setPalette(palette);
  kart.model.setBody(body);
  kart.model.setScale(scale);
  kart._appliedCharacter = character;
  return kart;
}

function pickColor(color, character, characterId, id) {
  if (typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (character && typeof character.color === 'string' && character.color) return character.color;
  const idx = characterId ? ROSTER.indexOf(characterId) : -1;
  if (idx >= 0) return FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
  return FALLBACK_COLORS[id % FALLBACK_COLORS.length];
}

export { FALLBACK_PALETTE, CC_FACTORS as CC_FACTOR, ROSTER as FALLBACK_ROSTER };
export default createKart;
