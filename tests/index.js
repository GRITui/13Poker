// Entry point so that `node --test tests/` works on Node versions that treat the
// argument as a module path (Node 22 resolves a directory to its index.js).
// Plain `node --test` also finds the *.test.mjs files directly.
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

for (const f of readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(join(__dirname, f)).href);
}
