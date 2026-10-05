// Rebuilds seed/macro-fred.json.gz (the bundled FRED snapshot) from this machine's data/macro-cache.json.
// Run after the local server has refreshed macro data:  node tools/macro-seed.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';

const DAY = 86400000;
const src = JSON.parse(fs.readFileSync(new URL('../data/macro-cache.json', import.meta.url)));
const cut = Date.now() - 3 * 365 * DAY;
const fred = {};
for (const [id, pts] of Object.entries(src.fred)) {
  // keep daily detail for the last 3 years, one point per week before that (the charts thin the same way)
  if (pts.length <= 1500) { fred[id] = pts; continue; }
  const out = [];
  for (const p of pts) {
    if (p[0] < cut && out.length && Math.floor(out.at(-1)[0] / (7 * DAY)) === Math.floor(p[0] / (7 * DAY))) out[out.length - 1] = p;
    else out.push(p);
  }
  fred[id] = out;
}
const gz = zlib.gzipSync(JSON.stringify({ updated: src.updated, fred, boj: src.boj }), { level: 9 });
fs.mkdirSync(new URL('../seed/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../seed/macro-fred.json.gz', import.meta.url), gz);
console.log(`seed: ${Object.keys(fred).length} series, ${(gz.length / 1024).toFixed(0)} KB, data as of ${new Date(src.updated).toISOString().slice(0, 10)}`);
