/**
 * Track definitions. Every track is a closed Catmull-Rom circuit; control-point Y
 * carries elevation, so the courses climb and dive for real.
 *
 * Layouts were designed as polar loops (guaranteed star-shaped, therefore
 * non-self-intersecting in XZ) and verified numerically: minimum XZ clearance
 * between any two points more than 30 m apart along the lap, minimum corner
 * radius, and C1 continuity of the control-point tangent chain. See the numbers
 * quoted in each track comment.
 */

/** Closed-centreline control points as [x, y, z] triples in metres. */
const SUNSET_PATH = [
  [171.7, 2.2, 154.6],
  [191.2, 1.7, 119.5],
  [211.4, 1.2, 77.0],
  [222.8, 0.7, 31.3],
  [225.0, 0.5, 0.0],
  [221.1, 0.8, -47.0],
  [210.1, 1.4, -93.5],
  [192.5, 2.8, -139.9],
  [149.0, 5.0, -190.7],
  [87.7, 7.0, -217.0],
  [22.6, 8.5, -214.8],
  [-28.7, 10.0, -204.0],
  [-77.9, 11.0, -192.9],
  [-130.5, 12.0, -179.6],
  [-183.9, 13.0, -154.3],
  [-213.9, 12.5, -104.3],
  [-217.1, 11.5, -46.2],
  [-205.9, 10.0, 7.2],
  [-192.3, 9.0, 55.1],
  [-178.4, 10.5, 103.0],
  [-159.7, 12.0, 154.2],
  [-130.4, 13.5, 208.6],
  [-88.2, 15.5, 242.4],
  [-36.7, 17.0, 261.4],
  [10.1, 15.5, 287.8],
  [58.6, 13.0, 275.8],
  [96.6, 10.0, 239.2],
  [141.1, 7.5, 194.2],
];

const SUNSET_BANK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.03, 0.08, 0.09, 0.07, 0.09, 0.11, 0.09, 0.02, -0.05, -0.06, 0.02, 0.07, 0.1, 0.12, 0.13, 0.13, 0.11, 0.05, -0.02];

const FROSTBITE_PATH = [
  [208.6, 4.0, 0.0],
  [199.8, 5.0, -24.5],
  [182.6, 5.9, -45.5],
  [164.3, 6.9, -63.1],
  [151.0, 7.8, -80.3],
  [144.0, 8.8, -100.8],
  [139.6, 9.7, -125.7],
  [131.9, 10.7, -151.7],
  [116.6, 11.6, -172.9],
  [93.8, 12.6, -184.0],
  [67.1, 13.5, -184.2],
  [41.0, 14.5, -177.8],
  [18.1, 15.4, -171.8],
  [-3.0, 16.4, -171.8],
  [-25.1, 17.3, -178.6],
  [-50.2, 18.3, -187.2],
  [-76.9, 19.2, -190.3],
  [-101.3, 20.2, -182.7],
  [-119.2, 21.1, -164.1],
  [-129.7, 22.1, -139.1],
  [-135.9, 23.0, -114.0],
  [-143.5, 24.0, -93.2],
  [-175.9, 25.0, -60.6],
  [-201.2, 26.5, 17.6],
  [-190.7, 28.0, 105.7],
  [-138.4, 29.0, 183.7],
  [-52.2, 28.0, 226.1],
  [43.1, 24.0, 221.8],
  [126.2, 19.0, 180.2],
  [186.0, 13.0, 111.8],
  [208.3, 7.0, 44.3],
];

const FROSTBITE_BANK = [
  0.12, 0.12, 0.12, 0.12, 0.009, -0.12, -0.12, -0.12, -0.12, 0.12, 0.12, 0.12, 0.12, -0.12, -0.12, -0.12, -0.12, 0.09, 0.12, 0.12, 0.12, 0.109, 0.05,
  0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05,
];

const HARBOUR_PATH = [
  [214.0, 0.6, 0.0],
  [209.6, 0.8, -76.3],
  [178.5, 1.6, -149.8],
  [126.9, 2.6, -188.2],
  [87.4, 3.0, -196.4],
  [56.8, 2.4, -198.0],
  [29.1, 1.8, -207.0],
  [0.0, 2.4, -214.0],
  [-28.9, 2.6, -206.0],
  [-55.1, 2.4, -192.3],
  [-83.0, 2.6, -186.4],
  [-111.8, 3.4, -178.9],
  [-140.8, 4.6, -167.8],
  [-168.7, 6.2, -151.9],
  [-199.3, 7.8, -124.5],
  [-225.5, 9.4, -82.1],
  [-235.7, 10.8, -33.1],
  [-229.4, 11.8, 16.0],
  [-210.5, 12.2, 60.4],
  [-184.5, 11.4, 98.1],
  [-156.3, 10.2, 131.1],
  [-126.8, 8.6, 162.3],
  [-92.9, 7.0, 190.5],
  [-53.2, 5.4, 213.5],
  [-7.9, 4.2, 226.9],
  [39.9, 3.4, 226.5],
  [85.4, 3.0, 211.4],
  [123.0, 3.0, 182.4],
  [151.1, 3.2, 145.9],
  [173.0, 3.2, 108.1],
  [189.8, 2.4, 69.1],
  [208.0, 1.5, 29.2],
];

const HARBOUR_BANK = [
  0, 0, 0, 0.04, 0.07, 0.09, 0.07, 0.09, 0.08, 0.05, 0.07, 0.08, 0.07, 0.05, 0.02, -0.04, -0.07, -0.05, 0, 0.05, 0.07, 0.06, 0.04, 0.03, 0.02, 0.02,
  0.02, 0.02, 0, 0, 0, 0,
];

/**
 * Terrain shape around the ribbon. All values are metres.
 * `base` is the landscape height far from the road, `relief` the noise amplitude,
 * `apron` the flat shoulder outside the tarmac, `shelf` the lateral distance over
 * which the ground falls from road level down to the landscape.
 */
const SUNSET_TERRAIN = { base: 8, relief: 7.5, apron: 3.2, shelf: 46 };
const FROSTBITE_TERRAIN = { base: 16, relief: 11, apron: 2.4, shelf: 58 };
const HARBOUR_TERRAIN = { base: -3.6, relief: 0.6, apron: 3.0, shelf: 14 };

export const TRACKS = [
  {
    id: 'sunset-circuit',
    name: 'Sunset Circuit',
    cup: 'Star Cup',
    blurb:
      'Golden-hour classic. One long main straight, two fast sweepers and a tight hairpin through the vineyard hills.',
    path: SUNSET_PATH,
    width: 11,
    bank: SUNSET_BANK,
    theme: {
      sky: {
        top: 0x1e3a7a,
        horizon: 0xff9d4d,
        sun: 0xffd9a0,
        sunIntensity: 2.45,
        sunElevation: 0.135,
        sunAzimuth: 2.15,
      },
      fog: { color: 0xff9a52, near: 150, far: 820, density: 0.0011 },
      road: 0x3b3b42,
      roadRough: 0.86,
      curbA: 0xe0322a,
      curbB: 0xf4f4f4,
      terrain: 0x748a3c,
      terrainAlt: 0x9aa04a,
      water: null,
    },
    decor: {
      treeType: 'maple',
      treeDensity: 26,
      rockDensity: 6,
      spectatorRows: 5,
      banners: 16,
      landmarks: ['windmill', 'balloon', 'castle'],
    },
    startLine: 0,
    timeOfDay: 'sunset',
    terrainProfile: SUNSET_TERRAIN,
    // 28 control points, 1497 m, min XZ clearance 30.5 m, corner radius 30 m (hairpin) .. 104 km,
    // median 279 m, elevation swing 16.5 m.
    boostPads: [
      { p: 0.312, lateral: 0, width: 6.5, strength: 1 },
      { p: 0.906, lateral: 0, width: 6.5, strength: 1 },
    ],
    hazards: [
      { p: 0.845, lateral: -4.6, type: 'cone' },
      { p: 0.852, lateral: 4.2, type: 'cone' },
      { p: 0.316, lateral: 5.4, type: 'banana' },
    ],
    jumps: [{ p: 0.7915, width: 9, height: 6.4 }],
    grid: [
      [-6, -3.8],
      [-6, 3.8],
      [-13.5, -3.8],
      [-13.5, 3.8],
      [-21, -3.8],
      [-21, 3.8],
      [-28.5, -3.8],
      [-28.5, 3.8],
    ],
  },
  {
    id: 'frostbite-peaks',
    name: 'Frostbite Peaks',
    cup: 'Comet Cup',
    blurb:
      'A narrow mountain pass of endless switchbacks, 25 m of elevation and a broken bridge over the crevasse.',
    path: FROSTBITE_PATH,
    width: 10.5,
    bank: FROSTBITE_BANK,
    theme: {
      sky: {
        top: 0x14306e,
        horizon: 0xcadff5,
        sun: 0xfff6e6,
        sunIntensity: 2.1,
        sunElevation: 0.46,
        sunAzimuth: 0.95,
      },
      fog: { color: 0xd2e4f6, near: 105, far: 720, density: 0.0018 },
      road: 0x3f3f49,
      roadRough: 0.82,
      curbA: 0xd8281e,
      curbB: 0xf6faff,
      terrain: 0xe6eef7,
      terrainAlt: 0x9fb0c4,
      water: null,
    },
    decor: {
      treeType: 'pine',
      treeDensity: 34,
      rockDensity: 18,
      spectatorRows: 3,
      banners: 10,
      landmarks: ['castle', 'rainbow'],
    },
    startLine: 0,
    timeOfDay: 'day',
    terrainProfile: FROSTBITE_TERRAIN,
    ravines: [
      { p: 0.7025, length: 16, halfWidth: 9, depth: 11, gap: true },
      { p: 0.1825, length: 18, halfWidth: 8, depth: 6 },
      { p: 0.2575, length: 14, halfWidth: 7, depth: 5 },
    ],
    jumps: [{ p: 0.6985, width: 12, height: 11.2 }],
    boostPads: [
      { p: 0.61, lateral: 0, width: 6, strength: 1 },
      { p: 0.795, lateral: 0, width: 6, strength: 1 },
    ],
    hazards: [
      { p: 0.06, lateral: -4.2, type: 'cone' },
      { p: 0.075, lateral: 4.4, type: 'cone' },
      { p: 0.215, lateral: 4.6, type: 'banana' },
      { p: 0.335, lateral: -5.2, type: 'cone' },
    ],
    // 31 control points, 1338 m, min XZ clearance 29.1 m, corner radius 23 m .. 28 km,
    // median 189 m, elevation swing 25.1 m, most corners in the 23..70 m band.
    grid: [
      [-6, -3.6],
      [-6, 3.6],
      [-13.5, -3.6],
      [-13.5, 3.6],
      [-21, -3.6],
      [-21, 3.6],
      [-28.5, -3.6],
      [-28.5, 3.6],
    ],
  },
  {
    id: 'neon-harbour',
    name: 'Neon Harbour',
    cup: 'Nova Cup',
    blurb:
      'Night race on the waterfront causeway. Synthwave lights, four bridge decks and a chicane between the cargo cranes.',
    path: HARBOUR_PATH,
    width: 11.5,
    bank: HARBOUR_BANK,
    theme: {
      sky: {
        top: 0x04030e,
        horizon: 0x33115c,
        sun: 0xa77cff,
        sunIntensity: 0.85,
        sunElevation: 0.62,
        sunAzimuth: 3.7,
      },
      fog: { color: 0x190c3a, near: 60, far: 560, density: 0.0028 },
      road: 0x2f2f3a,
      roadRough: 0.72,
      curbA: 0xff2d95,
      curbB: 0x1fe3ff,
      terrain: 0x1d2338,
      terrainAlt: 0x2b3554,
      water: 0x0b1c3e,
    },
    decor: {
      treeType: 'palm',
      treeDensity: 15,
      rockDensity: 3,
      spectatorRows: 6,
      banners: 22,
      landmarks: ['lighthouse', 'volcano', 'rainbow'],
    },
    startLine: 0,
    timeOfDay: 'night',
    waterLevel: -2.6,
    terrainProfile: HARBOUR_TERRAIN,
    ravines: [
      { p: 0.055, length: 26, halfWidth: 13, depth: 7.5 },
      { p: 0.36, length: 30, halfWidth: 15, depth: 9 },
      { p: 0.6875, length: 28, halfWidth: 14, depth: 8 },
      { p: 0.945, length: 24, halfWidth: 12, depth: 7 },
    ],
    boostPads: [
      { p: 0.2715, lateral: -3.2, width: 5.5, strength: 1.05 },
      { p: 0.9415, lateral: 3.2, width: 5.5, strength: 1.05 },
    ],
    hazards: [
      { p: 0.726, lateral: -4.8, type: 'oil' },
      { p: 0.742, lateral: 4.6, type: 'cone' },
      { p: 0.303, lateral: -4.4, type: 'banana' },
    ],
    // 32 control points, 1394 m, min XZ clearance 29.6 m, corner radius 32 m (chicane) .. 38 km,
    // median 197 m, elevation swing 12.3 m over water at y = -2.6.
    grid: [
      [-6, -4],
      [-6, 4],
      [-13.5, -4],
      [-13.5, 4],
      [-21, -4],
      [-21, 4],
      [-28.5, -4],
      [-28.5, 4],
    ],
  },
];

export const DEFAULT_TRACK_ID = 'sunset-circuit';

/** @returns {TrackDef} the track with this id, or the default track. */
export function getTrack(id) {
  return TRACKS.find((t) => t.id === id) || TRACKS.find((t) => t.id === DEFAULT_TRACK_ID) || TRACKS[0];
}

export default TRACKS;
