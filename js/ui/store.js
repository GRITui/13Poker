// Settings and scoreboard persistence (per-browser convenience; everything works without it).

const SETTINGS_KEY = '13poker.settings.v2'; // v2: default mode became 1-6 (scoop x2)
const SCORES_KEY = '13poker.scores.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  opponents: 3,
  mode: '1-6',
  unitValue: 1,
  cardBack: 'back',
  royalties: false,
  royaltyRequiresRowWin: false,
  naturals: false,
  allowEqualRows: false,
  wheelSecond: false,
  animations: true,
  randomDeal: true,
});

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(read(SETTINGS_KEY) || {}) };
  s.opponents = Math.min(3, Math.max(1, Number(s.opponents) || 3));
  if (!['wsgc', '1-6', '2-4'].includes(s.mode)) s.mode = '1-6';
  s.unitValue = Math.min(10, Math.max(1, Math.round(Number(s.unitValue) || 1)));
  if (!['back', 'back-alt'].includes(s.cardBack)) s.cardBack = 'back';
  return s;
}
export function saveSettings(s) { write(SETTINGS_KEY, s); }

/** Scoreboard: { names: string[], rounds: [{ round, net: number[] }] } */
export function loadScores(names) {
  const s = read(SCORES_KEY);
  if (s && Array.isArray(s.names) && s.names.join('|') === names.join('|') && Array.isArray(s.rounds)) return s;
  return { names: names.slice(), rounds: [] };
}
export function saveScores(s) { write(SCORES_KEY, s); }

export function totals(scores) {
  const t = scores.names.map(() => 0);
  for (const r of scores.rounds) r.net.forEach((n, i) => { t[i] += n; });
  return t;
}
