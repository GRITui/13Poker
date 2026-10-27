// Game configuration (RULES.md C6). Pure logic.

export const SCORING_MODES = ['wsgc', '1-6', '2-4'];

/** Example royalty table from RULES.md B4 [OPTIONAL VARIANT]. */
export const DEFAULT_ROYALTIES = Object.freeze({
  front: { trips: 3 },
  middle: { fullHouse: 2, quads: 8, straightFlush: 10 },
  back: { quads: 4, straightFlush: 5 },
});

/** Example naturals table from RULES.md B5 [OPTIONAL VARIANT], highest first. */
export const DEFAULT_NATURALS = Object.freeze({
  dragon: 13,
  sixPairs: 3,
  threeFlushes: 3,
  threeStraights: 3,
});

export const DEFAULT_CONFIG = Object.freeze({
  mode: '1-6', // scoop (win all three rows vs a player) pays double: 3 x 2 = 6
  unitValue: 1,
  allowEqualRows: false,
  royalties: null, // null = off, or a table like DEFAULT_ROYALTIES
  royaltyRequiresRowWin: false,
  naturals: null, // null = off, or a table like DEFAULT_NATURALS
  wheelRank: 'lowest',
  // House rule (1-6 mode only, 3+ players): a player who scoops EVERY opponent gets x4 row points
  // (3 x 4 = 12) from each of them instead of the usual scoop x2 (6). Royalties are not multiplied.
  scoopAll: true,
});

/** Merge with defaults and validate. Throws on invalid settings. */
export function makeConfig(overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  if (!SCORING_MODES.includes(cfg.mode)) throw new Error(`Unknown scoring mode: ${cfg.mode}`);
  if (typeof cfg.unitValue !== 'number' || !(cfg.unitValue > 0)) throw new Error('unitValue must be a positive number');
  if (cfg.unitValue > 10) throw new Error('unitValue may not exceed $10 per unit [WSGC A9]');
  if (!['lowest', 'second'].includes(cfg.wheelRank)) throw new Error(`Unknown wheelRank: ${cfg.wheelRank}`);
  if (cfg.royalties === true) cfg.royalties = DEFAULT_ROYALTIES;
  if (cfg.naturals === true) cfg.naturals = DEFAULT_NATURALS;
  if (cfg.royalties === false) cfg.royalties = null;
  if (cfg.naturals === false) cfg.naturals = null;
  return cfg;
}

export function scoopBonus(mode) {
  return mode === '1-6' ? 3 : mode === '2-4' ? 1 : 0;
}
