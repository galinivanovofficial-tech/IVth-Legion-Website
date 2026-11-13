// Dry test of Macro Flash against the latest published month. Never sends anything.
// Usage: node src/flash-test.js cpi|ppi|jobs
import { RELEASES, blsFetch, compute, buildFlash } from './flash.js';
import { getCalendar } from './macro.js';

const rel = RELEASES.find(r => r.id === (process.argv[2] || 'cpi'));
if (!rel) { console.log('usage: node src/flash-test.js cpi|ppi|jobs'); process.exit(1); }
const t0 = Date.now();
const data = await blsFetch([...new Set(rel.lines.map(l => l.s))], new Date().getUTCFullYear());
const ms = Date.now() - t0;
const { y, m } = data[rel.key][0];
const values = Object.fromEntries(rel.lines.map(l => [l.label, compute(l, data[l.s] || [], y, m)]));
// The release for data month m happens in the following month.
const start = Date.UTC(m === 12 ? y + 1 : y, m % 12, 1);
const evs = (await getCalendar(start, start + 31 * 86400000)).filter(e => e.country === 'US' && rel.lines.some(l => l.title === e.title));
const at = Math.min(...evs.map(e => Date.parse(e.date)));
const group = evs.filter(e => Date.parse(e.date) === at);
console.log(`BLS answered in ${ms} ms; release ${Number.isFinite(at) ? new Date(at).toISOString() : 'not found in calendar'}\n`);
console.log(buildFlash(rel, values, group, y, m).text);
console.log('\nCalendar says:', group.map(e => `${e.title}=${e.actual} (f ${e.forecast}, p ${e.previous})`).join(' | '));
process.exit(0);
