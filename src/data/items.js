/**
 * Item catalogue for Kart Rush.
 *
 * Every item carries a position-dependent `weight` table indexed by race rank
 * minus one, so index 0 is what the leader draws and the last index is what the
 * back-marker draws. The tables are hand-tuned in the spirit of the series this
 * game homages: the further back you are, the more likely you are to be handed
 * something that can actually close the gap. The weights are relative — the
 * roulette in src/items/ItemSystem.js normalises them per rank.
 *
 * `art` picks the silhouette drawn by src/items/ItemArt.js; `color` tints it.
 */

/** Weight tables are written for up to this many racers; ranks above clamp. */
export const RANKS = 8;

/** The "no item" sentinel used by the HUD and by the kart's item slot. */
export const NOTHING_ITEM = 'none';

export const ITEMS = [
  {
    id: 'banana',
    name: 'Banana',
    plural: 'Bananas',
    color: '#ffd60a',
    weight: [30, 22, 18, 14, 11, 9, 8, 7],
    holdable: false,
    count: 1,
    description: 'One ripe banana, dropped right behind your rear bumper.',
    art: 'banana',
  },
  {
    id: 'tripleBanana',
    name: 'Triple Bananas',
    plural: 'Triple Bananas',
    color: '#ffd60a',
    weight: [0, 4, 8, 12, 16, 19, 21, 22],
    holdable: true,
    count: 3,
    description: 'Three bananas dragged behind the kart as a spinning shield.',
    art: 'banana',
  },
  {
    id: 'greenShell',
    name: 'Green Shell',
    plural: 'Green Shells',
    color: '#3ecf5a',
    weight: [24, 26, 24, 20, 16, 13, 11, 9],
    holdable: false,
    count: 1,
    description: 'Fired dead straight, ricocheting off the walls for ages.',
    art: 'shell',
  },
  {
    id: 'tripleGreenShell',
    name: 'Triple Green Shells',
    plural: 'Triple Green Shells',
    color: '#3ecf5a',
    weight: [0, 0, 3, 6, 10, 13, 16, 18],
    holdable: true,
    count: 3,
    description: 'Three straight shells — a green wall down the whole straight.',
    art: 'shell',
  },
  {
    id: 'redShell',
    name: 'Red Shell',
    plural: 'Red Shells',
    color: '#ff3b30',
    weight: [4, 8, 12, 15, 17, 18, 18, 17],
    holdable: false,
    count: 1,
    description: 'Hunts down the kart one place ahead of you. Nothing personal.',
    art: 'shell',
  },
  {
    id: 'mushroom',
    name: 'Mushroom',
    plural: 'Mushrooms',
    color: '#ff4d5e',
    weight: [10, 14, 16, 18, 19, 20, 20, 19],
    holdable: true,
    count: 1,
    description: 'A burst of raw speed. Save it for the exit of a corner.',
    art: 'mushroom',
  },
  {
    id: 'tripleMushroom',
    name: 'Triple Mushrooms',
    plural: 'Triple Mushrooms',
    color: '#ff4d5e',
    weight: [0, 0, 2, 5, 8, 12, 15, 17],
    holdable: true,
    count: 3,
    description: 'Three speed bursts — the classic chain-boost kit.',
    art: 'mushroom',
  },
  {
    id: 'goldenMushroom',
    name: 'Golden Mushroom',
    plural: 'Golden Mushrooms',
    color: '#ffb02e',
    weight: [0, 0, 0, 0, 1, 3, 5, 8],
    holdable: true,
    count: 7,
    description: 'Boost on every tap for a few precious seconds. Never stop.',
    art: 'mushroom',
  },
  {
    id: 'star',
    name: 'Super Star',
    plural: 'Super Stars',
    color: '#ffe14d',
    weight: [0, 0, 0, 1, 2, 4, 6, 9],
    holdable: false,
    count: 1,
    description: 'Invincible, faster and roaring. Bulldoze the whole field.',
    art: 'star',
  },
  {
    id: 'lightning',
    name: 'Lightning',
    plural: 'Lightning',
    color: '#7ee8ff',
    weight: [0, 0, 0, 0, 0, 1, 3, 6],
    holdable: false,
    count: 1,
    description: 'Shrinks and slows every racer ahead of you, and takes their loot.',
    art: 'bolt',
  },
  {
    id: 'blooper',
    name: 'Ink Blast',
    plural: 'Ink Blasts',
    color: '#a06bff',
    weight: [0, 0, 1, 2, 4, 6, 8, 9],
    holdable: false,
    count: 1,
    description: 'Inks everyone ahead so they cannot see the road they are on.',
    art: 'ink',
  },
  {
    id: 'bulletBill',
    name: 'Rocket Bullet',
    plural: 'Rocket Bullets',
    color: '#59606f',
    weight: [0, 0, 0, 0, 0, 2, 5, 9],
    holdable: false,
    count: 1,
    description: 'The machine takes the wheel: full speed down the line, through traffic.',
    art: 'bullet',
  },
  {
    id: 'superHorn',
    name: 'Super Horn',
    plural: 'Super Horns',
    color: '#ff8a3d',
    weight: [2, 3, 4, 5, 6, 7, 8, 9],
    holdable: false,
    count: 1,
    description: 'One blast destroys every shell, banana and bad plan inbound.',
    art: 'horn',
  },
];

/** id -> ItemDef for O(1) lookups from the HUD, art and runtime. */
const byId = new Map();
for (const def of ITEMS) byId.set(def.id, def);

/** Returns the definition for an id, or null when the id is unknown. */
export function getItem(id) {
  if (id == null) return null;
  return byId.get(id) || null;
}

/** True when the id names a real, usable item (not the `none` sentinel). */
export function hasItem(id) {
  return byId.has(id);
}

/** Every id in catalogue order — handy for tooling and the item gallery. */
export const ITEM_IDS = ITEMS.map((d) => d.id);

/** The distinct art kinds, in catalogue order of first appearance. */
export const ITEM_ART_KINDS = ITEMS.map((d) => d.art).filter((k, i, a) => a.indexOf(k) === i);

/**
 * Relative weight of one item at a race rank. Ranks are clamped into the table.
 * @param {object} def ItemDef
 * @param {number} rank 1 = leading
 */
export function weightFor(def, rank) {
  if (!def) return 0;
  const table = def.weight;
  if (!Array.isArray(table) || table.length === 0) return 0;
  const r = Math.max(1, Math.min(RANKS, Math.floor(rank) || 1)) - 1;
  const w = table[Math.min(r, table.length - 1)];
  return typeof w === 'number' && w > 0 ? w : 0;
}

/**
 * Candidates for a rank, already normalised so the weights sum to 1.
 * @param {number} rank 1 = leading
 * @returns {Array<{def:object, weight:number}>}
 */
export function rollTable(rank) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < ITEMS.length; i++) {
    const w = weightFor(ITEMS[i], rank);
    if (w <= 0) continue;
    out.push({ def: ITEMS[i], weight: w });
    sum += w;
  }
  if (sum <= 0) {
    // Nobody should ever be left empty handed: fall back to a banana.
    const banana = byId.get('banana') || ITEMS[0];
    return [{ def: banana, weight: 1 }];
  }
  const inv = 1 / sum;
  for (const e of out) e.weight *= inv;
  return out;
}

export default ITEMS;
