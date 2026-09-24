/**
 * Global gameplay tuning. Physics base values are multiplied by the per-character
 * `tuning` block in src/data/characters.js.
 *
 * Units: metres, seconds, radians. Displayed speed = m/s * 3.6.
 */

export const CONFIG = {
  physics: {
    /** Base top speed on tarmac (m/s). ~122 km/h shown in the HUD. */
    topSpeed: 34,
    /** Top speed while a character's speed stat is maxed. */
    topSpeedBonus: 3.4,
    /** Forward acceleration (m/s^2). */
    accel: 13.5,
    /** Reverse top speed. */
    reverseSpeed: 8.5,
    /** Full brake deceleration. */
    brakeForce: 34,
    /** Coasting deceleration. */
    drag: 2.4,
    /** Extra drag while off-track, plus the top-speed penalty below. */
    offTrackDrag: 11,
    offTrackSpeedFactor: 0.56,
    /** Longitudinal grip used to kill sideways slide (higher = less slide). */
    grip: 7.5,
    /** How much of the lateral velocity survives a drift (lower = tighter drift). */
    driftSlide: 0.72,

    turn: {
      /** Yaw rate at standstill and at top speed (rad/s). */
      min: 1.35,
      max: 2.5,
      /** Extra yaw while drifting. */
      driftMultiplier: 1.62,
      /** Visual/counter-steer bias applied while drifting, rad. */
      driftInward: 0.42,
    },

    /** Mini-turbo thresholds, measured in seconds of drift charge. */
    driftTiers: [1.05, 2.05, 3.05],
    /** Boost duration and speed multiplier per tier. */
    boost: {
      miniTurbo: [
        { duration: 0.8, multiplier: 1.22 },
        { duration: 1.15, multiplier: 1.32 },
        { duration: 1.65, multiplier: 1.44 },
      ],
      mushroom: { duration: 1.7, multiplier: 1.36 },
      goldenMushroom: { duration: 1.6, multiplier: 1.42 },
      boostPad: { duration: 0.95, multiplier: 1.32 },
      startBoost: { duration: 1.5, multiplier: 1.38 },
      slipstream: { duration: 0.001, multiplier: 1.08 },
      star: { duration: 7.0, multiplier: 1.26 },
      bulletBill: { duration: 6.0, multiplier: 1.5 },
    },

    /** Seconds the kart is out of control after a hit. */
    spinout: 1.35,
    spinoutSpeedFactor: 0.22,
    squash: 6,
    squashSpeedFactor: 0.62,

    /** Slipstream detection window. */
    slipstream: { distance: 12.5, lateral: 1.9, speedGain: 0.08, rampTime: 1.1 },

    /** Kart collision. */
    collision: { radius: 1.15, push: 8.5, speedLoss: 0.12 },

    /** How far past the tarmac edge the invisible wall sits. */
    wallOffset: 1.4,
    /** Restitution when hitting the wall. */
    wallBounce: 0.32,
    wallSpeedLoss: 0.55,

    /** Airborne hops (drift hop / ramps). */
    hopVelocity: 4.2,
    gravity: 22,
  },

  race: {
    countdown: 3.3,
    /** Holding accelerate inside this window before GO grants a start boost. */
    startBoostWindow: 0.85,
    finishLineHoldTime: 1.0,
    /** Points awarded per finishing position in the running tally. */
    points: [15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  },

  items: {
    /** Seconds before a used item box comes back. */
    boxRespawn: 4.5,
    /** Autoplaced box rows per track. */
    autoRows: 14,
    autoRowCount: 5,
    autoRowWidth: 9.5,
    boxRadius: 1.5,
    /** Roulette duration (seconds of random item cycling before lock-in). */
    rouletteTime: 1.15,
    shell: {
      greenSpeed: 42,
      redSpeed: 47,
      greenLifetime: 8,
      redLifetime: 12,
      bounceDamping: 0.78,
    },
    bananaLifetime: 60,
    starDuration: 7,
    lightningDuration: 6,
    blooperDuration: 6,
    /**
     * Bullet Bill duration. This is a *display/debug* copy: the value that is
     * actually applied to the kart lives in `physics.boost.bulletBill.duration`,
     * and both must stay in step or the speed lapses before the drive ends.
     */
    bulletBill: { duration: 6.0, speed: 56 },
  },

  ai: {
    /** Baseline skill 0..1 before difficulty scaling. */
    skillBase: 0.72,
    /** Lookahead distance in metres for the steering target. */
    lookahead: 15,
    /** Distance at which the AI begins slowing for a corner, in metres. */
    cornerBraking: 26,
    /** Rubber-band: catch-up bonus and leader penalty, as a fraction of top speed. */
    rubberBand: { up: 0.055, down: 0.035 },
    /** Minimum seconds between item uses. */
    itemCooldown: 2.4,
    /** Chance per second the AI tries a drift in a corner. */
    driftChance: 0.9,
    /** Chance the AI deliberately swerves around a hazard. */
    avoidChance: 0.9,
    /** Steering smoothing — lower is smoother/slower to react. */
    steerSmoothing: 13,
  },

  camera: {
    fov: 58,
    fovBoost: 66,
    distance: 8.6,
    height: 3.5,
    /** Camera lags the kart's yaw, giving the classic racing feel. */
    yawLag: 9.5,
    lookLag: 14,
    positionLag: 15,
    /** Vertical spring rates around the kart's ground position. */
    heightLag: 9,
    introDuration: 4.2,
  },

  display: {
    /** Multiplier for the HUD speed readout. */
    speedScale: 3.6,
  },
};

export default CONFIG;
