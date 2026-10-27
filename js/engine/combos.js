// Combination helpers. Pure logic.
const cache = new Map();

/** All k-element index combinations of [0, n), as arrays (cached). */
export function combinations(n, k) {
  const id = n * 100 + k;
  if (cache.has(id)) return cache.get(id);
  const out = [];
  const cur = [];
  (function rec(start) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i <= n - (k - cur.length); i++) { cur.push(i); rec(i + 1); cur.pop(); }
  })(0);
  cache.set(id, out);
  return out;
}
