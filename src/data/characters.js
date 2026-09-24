/**
 * Character roster for Kart Rush.
 *
 * Eight original racers covering four archetypes (light / medium / speed / heavy)
 * and all five body shapes (human, dino, ape, mushroom, koopaKing).
 *
 * `tuning` holds plain multipliers over CONFIG.physics (src/data/config.js):
 *   topSpeed -> CONFIG.physics.topSpeed                 (base 34 m/s)
 *   accel    -> CONFIG.physics.accel                    (base 13.5 m/s^2)
 *   turn     -> CONFIG.physics.turn.{min,max}           (base 1.35 / 2.5 rad/s)
 *   drift    -> CONFIG.physics.turn.driftMultiplier + driftSlide authority
 *   mass     -> CONFIG.physics.mass ?? 1                (CONFIG has no explicit mass)
 *   offTrack -> CONFIG.physics.offTrackDrag (higher = harsher off-track penalty)
 *
 * Design rule: nobody is strictly better. Heavies buy top speed and bumping mass
 * with acceleration, cornering and off-track pace; lights invert that. Verified
 * extremes (base topSpeed 34 m/s, turn 1.35..2.5 rad/s):
 *   top speed  30.60 m/s (Fungi) .. 37.40 m/s (Bruto)   -> +22.2% for the heaviest
 *   turn       1.161..1.539 rad/s .. 2.150..2.850 rad/s -> +32.6% yaw for the lightest
 */

/** Flat ink outline used by the portrait painter. */
const INK = 'rgba(10, 14, 26, 0.9)';
const TAU = Math.PI * 2;

const rgbCache = new Map();

/** '#rrggbb' (or '#rgb') -> 'rgba(r,g,b,a)'. Palette colours are plain hex. */
function rgba(hex, a) {
  let v = rgbCache.get(hex);
  if (v === undefined) {
    const raw = String(hex || '#ffffff').replace('#', '');
    const full = raw.length === 3 ? raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2] : raw.padEnd(6, '0');
    v = [
      parseInt(full.slice(0, 2), 16) || 0,
      parseInt(full.slice(2, 4), 16) || 0,
      parseInt(full.slice(4, 6), 16) || 0,
    ];
    rgbCache.set(hex, v);
  }
  return 'rgba(' + v[0] + ',' + v[1] + ',' + v[2] + ',' + a + ')';
}

export const CHARACTERS = [
  {
    id: 'bolt',
    name: 'Bolt',
    epithet: 'All-Rounder',
    blurb: 'The dependable hero who never wins a sprint but is always there at the flag.',
    body: 'human',
    color: '#ff3b30',
    palette: {
      primary: '#e8352f',
      secondary: '#f6f8fb',
      accent: '#ffd60a',
      cap: '#e8352f',
      skin: '#f2b98d',
      hair: '#4b2e1c',
      tire: '#191b21',
      engine: '#9ad9ff',
      glow: '#ffd166',
    },
    scale: 1.0,
    stats: { speed: 3, accel: 3, handling: 3, weight: 3 },
    tuning: { topSpeed: 1.0, accel: 1.02, turn: 1.02, drift: 1.02, mass: 1.0, offTrack: 1.0 },
    engine: { baseFreq: 68, timbre: 0.45 },
    voice: 0,
    unlock: 'free',
    archetype: 'medium',
  },
  {
    id: 'verdi',
    name: 'Verdi',
    epithet: 'Top-Speed Specialist',
    blurb: 'Taller twin of Bolt, built for the long straight where nobody can follow.',
    body: 'human',
    color: '#34c759',
    palette: {
      primary: '#1f9c4d',
      secondary: '#eefaf1',
      accent: '#b6ff5c',
      cap: '#1f9c4d',
      skin: '#eab487',
      hair: '#2f2318',
      tire: '#191b21',
      engine: '#b9ff7a',
      glow: '#7dffa8',
    },
    scale: 1.06,
    stats: { speed: 5, accel: 2, handling: 2, weight: 3 },
    tuning: { topSpeed: 1.09, accel: 0.9, turn: 0.92, drift: 0.94, mass: 1.03, offTrack: 1.04 },
    engine: { baseFreq: 76, timbre: 0.55 },
    voice: 2,
    unlock: 'free',
    archetype: 'speed',
  },
  {
    id: 'aurelia',
    name: 'Aurelia',
    epithet: 'Featherweight',
    blurb: 'A pink-dressed dancer who treats every chicane like a waltz step.',
    body: 'human',
    color: '#ff2d95',
    palette: {
      primary: '#ff5aa8',
      secondary: '#fff3f8',
      accent: '#7ef0ff',
      cap: '#ffd0e4',
      skin: '#ffd8b6',
      hair: '#6b3a2a',
      tire: '#241d28',
      engine: '#ffa8dc',
      glow: '#ff86d2',
    },
    scale: 0.94,
    stats: { speed: 2, accel: 5, handling: 5, weight: 2 },
    tuning: { topSpeed: 0.93, accel: 1.14, turn: 1.14, drift: 1.07, mass: 0.8, offTrack: 0.85 },
    engine: { baseFreq: 88, timbre: 0.3 },
    voice: 5,
    unlock: 'free',
    archetype: 'light',
  },
  {
    id: 'tiko',
    name: 'Tiko',
    epithet: 'Pocket Rocket',
    blurb: 'A green hatchling with a helmet two sizes too big and no concept of fear.',
    body: 'dino',
    color: '#a8e05f',
    palette: {
      primary: '#2fb457',
      secondary: '#f6f0da',
      accent: '#ff8a3d',
      cap: '#ff6b4a',
      skin: '#8ada63',
      hair: '#1d7a3c',
      tire: '#1e2419',
      engine: '#a6ff5e',
      glow: '#63ffb8',
    },
    scale: 0.92,
    stats: { speed: 3, accel: 4, handling: 4, weight: 2 },
    tuning: { topSpeed: 0.96, accel: 1.11, turn: 1.12, drift: 1.12, mass: 0.88, offTrack: 0.89 },
    engine: { baseFreq: 96, timbre: 0.35 },
    voice: 7,
    unlock: 'Win 1 race',
    archetype: 'light',
  },
  {
    id: 'fungi',
    name: 'Fungi',
    epithet: 'Spore Sprinter',
    blurb: 'Barely there, absurdly quick off the line, and gone before the dust settles.',
    body: 'mushroom',
    color: '#ffd60a',
    palette: {
      primary: '#fff6e8',
      secondary: '#e5453c',
      accent: '#ffd166',
      cap: '#fffaf2',
      skin: '#f3e3cb',
      hair: '#c94d3f',
      tire: '#2b2422',
      engine: '#ffc08a',
      glow: '#ffb26b',
    },
    scale: 0.92,
    stats: { speed: 1, accel: 5, handling: 4, weight: 1 },
    tuning: { topSpeed: 0.9, accel: 1.17, turn: 1.11, drift: 1.14, mass: 0.76, offTrack: 0.82 },
    engine: { baseFreq: 104, timbre: 0.28 },
    voice: 9,
    unlock: 'Win 5 races',
    archetype: 'light',
  },
  {
    id: 'kongo',
    name: 'Kongo',
    epithet: 'The Bruiser',
    blurb: 'An amber-fisted battering ram who moves traffic first and asks questions later.',
    body: 'ape',
    color: '#c9762f',
    palette: {
      primary: '#8d5a2b',
      secondary: '#e2bd8c',
      accent: '#ffc23d',
      cap: '#e0483a',
      skin: '#a3743f',
      hair: '#5a371d',
      tire: '#221b14',
      engine: '#ffb45c',
      glow: '#ffa53d',
    },
    scale: 1.1,
    stats: { speed: 4, accel: 2, handling: 2, weight: 5 },
    tuning: { topSpeed: 1.07, accel: 0.93, turn: 0.9, drift: 0.95, mass: 1.24, offTrack: 1.1 },
    engine: { baseFreq: 58, timbre: 0.68 },
    voice: -3,
    unlock: 'Win the Star Cup',
    archetype: 'heavy',
  },
  {
    id: 'gordo',
    name: 'Gordo',
    epithet: 'Greed Machine',
    blurb: 'A purple-suited tycoon who bought the biggest engine and still wants yours.',
    body: 'human',
    color: '#af52de',
    palette: {
      primary: '#7a45c9',
      secondary: '#ffe9a8',
      accent: '#ffd60a',
      cap: '#4d2a80',
      skin: '#e9b489',
      hair: '#241a2e',
      tire: '#1f1a26',
      engine: '#c79bff',
      glow: '#c98cff',
    },
    scale: 1.08,
    stats: { speed: 4, accel: 3, handling: 3, weight: 4 },
    tuning: { topSpeed: 1.06, accel: 0.96, turn: 0.99, drift: 1.0, mass: 1.14, offTrack: 1.06 },
    engine: { baseFreq: 62, timbre: 0.6 },
    voice: -5,
    unlock: 'Win 10 races',
    archetype: 'heavy',
  },
  {
    id: 'bruto',
    name: 'Bruto',
    epithet: 'Juggernaut',
    blurb: 'A spiked-shelled monarch who has never once had to brake for anyone.',
    body: 'koopaKing',
    color: '#32d6ff',
    palette: {
      primary: '#146a86',
      secondary: '#dff2fa',
      accent: '#ff7a4d',
      cap: '#0e4c60',
      skin: '#5fc9e8',
      hair: '#0b3d4f',
      tire: '#16232a',
      engine: '#7fe6ff',
      glow: '#4fd8ff',
    },
    scale: 1.12,
    stats: { speed: 5, accel: 1, handling: 1, weight: 5 },
    tuning: { topSpeed: 1.1, accel: 0.86, turn: 0.86, drift: 0.89, mass: 1.3, offTrack: 1.18 },
    engine: { baseFreq: 48, timbre: 0.85 },
    voice: -7,
    unlock: 'Win every cup on 150cc',
    archetype: 'heavy',
  },
];

export const DEFAULT_CHARACTER_ID = 'bolt';

/** id -> CharacterDef, built once so lookups stay O(1) in hot UI paths. */
const byId = new Map();
for (const c of CHARACTERS) byId.set(c.id, c);

/** Archetype groupings for the character-select screen and AI flavour text. */
export const CHARACTER_ARCHETYPES = [
  {
    id: 'light',
    name: 'Light',
    blurb: 'Featherweight flyers: instant acceleration, razor cornering, easily shoved.',
    color: '#a8e05f',
    ids: ['aurelia', 'tiko', 'fungi'],
  },
  {
    id: 'medium',
    name: 'Medium',
    blurb: 'Balanced all-rounders with no weakness to exploit and no strength to fear.',
    color: '#ff3b30',
    ids: ['bolt'],
  },
  {
    id: 'speed',
    name: 'Speed',
    blurb: 'Straight-line hunters that trade acceleration and cornering for terminal pace.',
    color: '#34c759',
    ids: ['verdi'],
  },
  {
    id: 'heavy',
    name: 'Heavy',
    blurb: 'Road-blocking bruisers: highest top speed, heaviest bump, worst off-track.',
    color: '#32d6ff',
    ids: ['kongo', 'gordo', 'bruto'],
  },
];

/** Returns the character, falling back to the default when the id is unknown. */
export function getCharacter(id) {
  return byId.get(id) || byId.get(DEFAULT_CHARACTER_ID) || CHARACTERS[0];
}

/**
 * Flat stylised portrait painter for the character cards.
 * Works in a 0..100 design space and scales to `size`, so it stays crisp from
 * 40 px minimap chips up to 260 px select-screen thumbs.
 */
export function drawCharacterPortrait(ctx, character, size) {
  const c = character && character.palette ? character : getCharacter(DEFAULT_CHARACTER_ID);
  const p = c.palette;
  const s = Math.max(16, size | 0);
  const u = s / 100;
  const disc = (x, y, r, fill, lw) => {
    ctx.beginPath();
    ctx.arc(x * u, y * u, r * u, 0, TAU);
    ctx.fillStyle = fill;
    ctx.fill();
    if (lw) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = lw * u;
      ctx.stroke();
    }
  };
  const oval = (x, y, rx, ry, fill, lw, rot) => {
    ctx.beginPath();
    ctx.ellipse(x * u, y * u, rx * u, ry * u, rot || 0, 0, TAU);
    ctx.fillStyle = fill;
    ctx.fill();
    if (lw) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = lw * u;
      ctx.stroke();
    }
  };
  const tri = (pts, fill, lw) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] * u;
      const y = pts[i + 1] * u;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (lw) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = lw * u;
      ctx.stroke();
    }
  };

  ctx.save();
  ctx.clearRect(0, 0, s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // --- backdrop: glow wash, speed streaks, contact shadow -------------------
  const bg = ctx.createLinearGradient(0, 0, 0, s);
  bg.addColorStop(0, rgba(p.glow, 0.36));
  bg.addColorStop(0.6, rgba(p.primary, 0.2));
  bg.addColorStop(1, 'rgba(5, 8, 18, 0.46)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = rgba(p.accent, 0.13);
  for (let i = 0; i < 4; i++) ctx.fillRect(0, s * (0.09 + i * 0.13), s, s * 0.013);
  oval(50, 105, 31, 7, 'rgba(4, 7, 16, 0.34)', 0);

  // --- torso, scarf and collar ---------------------------------------------
  ctx.beginPath();
  ctx.moveTo(32 * u, 99 * u);
  ctx.quadraticCurveTo(24 * u, 79 * u, 35 * u, 68 * u);
  ctx.quadraticCurveTo(50 * u, 61 * u, 65 * u, 68 * u);
  ctx.quadraticCurveTo(76 * u, 79 * u, 68 * u, 99 * u);
  ctx.quadraticCurveTo(50 * u, 104 * u, 32 * u, 99 * u);
  ctx.closePath();
  ctx.fillStyle = p.primary;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.4 * u;
  ctx.stroke();
  oval(50, 82, 13, 11, p.secondary, 2);
  tri([27, 105, 45, 100, 31, 86], p.accent, 2);
  oval(50, 68, 17, 5, p.accent, 2);

  // --- head, body-shape garnish --------------------------------------------
  let ex = 43.5;
  let ey = 42;
  const er = 3.4;
  switch (c.body) {
    case 'dino':
      disc(50, 42, 17, p.skin, 2.4);
      tri([36, 30, 29, 13, 47, 25], p.hair, 1.8);
      tri([50, 23, 43, 6, 57, 6], p.hair, 1.8);
      tri([64, 30, 71, 13, 53, 25], p.hair, 1.8);
      oval(32, 45, 9, 6.5, p.skin, 2);
      disc(27, 43, 1.5, INK, 0);
      disc(50, 20, 3, p.cap, 1.6);
      break;
    case 'mushroom':
      disc(50, 47, 15, p.skin, 2.4);
      ctx.beginPath();
      ctx.arc(50 * u, 41 * u, 22 * u, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = p.cap;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.4 * u;
      ctx.stroke();
      disc(39, 35, 3.4, p.secondary, 1.6);
      disc(59, 33, 4.4, p.secondary, 1.6);
      disc(51, 24, 3, p.secondary, 1.6);
      ey = 47;
      break;
    case 'ape':
      disc(50, 42, 16.5, p.skin, 2.4);
      disc(33, 43, 5, p.skin, 2.2);
      disc(67, 43, 5, p.skin, 2.2);
      oval(50, 30, 17, 5.5, p.primary, 2);
      oval(50, 47, 12, 8.5, p.secondary, 2.2);
      disc(45, 45, 1.5, INK, 0);
      disc(55, 45, 1.5, INK, 0);
      disc(50, 24, 3.4, p.cap, 1.8);
      ey = 40;
      break;
    case 'koopaKing':
      disc(63, 54, 21, p.primary, 2.4);
      for (let i = 0; i < 5; i++) {
        const a = Math.PI + i * (Math.PI / 4);
        tri([
          63 + Math.cos(a) * 21,
          54 + Math.sin(a) * 21,
          63 + Math.cos(a - 0.17) * 29,
          54 + Math.sin(a - 0.17) * 29,
          63 + Math.cos(a + 0.17) * 29,
          54 + Math.sin(a + 0.17) * 29,
        ], p.hair, 1.6);
      }
      disc(44, 43, 16, p.skin, 2.4);
      tri([31, 50, 19, 44, 32, 55], p.accent, 1.8);
      oval(45, 32, 15, 5, p.cap, 2);
      ex = 37.5;
      ey = 42;
      break;
    default:
      disc(50, 42, 17, p.skin, 2.4);
      disc(32, 47, 4.6, p.hair, 1.6);
      disc(68, 47, 4.6, p.hair, 1.6);
      ctx.beginPath();
      ctx.arc(50 * u, 42 * u, 17.6 * u, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = p.cap;
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.4 * u;
      ctx.stroke();
      oval(31, 41.5, 10, 4.4, p.cap, 2.2, -0.14);
      disc(50, 25, 3.2, p.accent, 1.6);
      break;
  }

  // --- shared face ---------------------------------------------------------
  oval(ex - 6.5, ey, er, er * 1.3, '#ffffff', 1.8);
  oval(ex + 6.5, ey, er, er * 1.3, '#ffffff', 1.8);
  disc(ex - 6.9, ey + 0.9, er * 0.5, INK, 0);
  disc(ex + 5.9, ey + 0.9, er * 0.5, INK, 0);
  disc(ex - 7.7, ey - 0.9, er * 0.18, '#ffffff', 0);
  disc(ex + 5.1, ey - 0.9, er * 0.18, '#ffffff', 0);
  oval(ex - 10.5, ey + 5.5, 3, 2, rgba(p.accent, 0.5), 0);
  oval(ex + 10.5, ey + 5.5, 3, 2, rgba(p.accent, 0.5), 0);
  ctx.beginPath();
  ctx.arc(ex * u, (ey + 3.5) * u, 5.5 * u, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6 * u;
  ctx.stroke();

  // --- gloves on the wheel -------------------------------------------------
  oval(24, 83, 4, 8, p.skin, 1.8, 0.3);
  oval(76, 83, 4, 8, p.skin, 1.8, -0.3);
  ctx.beginPath();
  ctx.arc(50 * u, 88 * u, 11 * u, 0, TAU);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3 * u;
  ctx.stroke();
  ctx.restore();
}
