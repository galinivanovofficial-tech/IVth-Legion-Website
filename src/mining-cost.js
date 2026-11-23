// MARA average mining cost per BTC, one value per quarter, straight from MARA's SEC filings:
//   (purchased energy + third-party hosting and other energy + operating and maintenance costs) / BTC produced.
// Before 2025 MARA reported those costs as one line ("energy, hosting and other", 2024: "Mining"); same scope.
// Q4 comes from the 10-K (full year) minus Q1-Q3. Same method CryptoQuant uses for its MARA chart.
//
// The SEC is only asked once a quarter's reporting window is open (20 days after the quarter ends) and only
// until that quarter is found, so outside the ~4 reporting weeks a year this makes no requests at all.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SEED = new URL('./mining-cost-seed.json', import.meta.url);
const STORE = path.join(config.dataDir, 'mining-cost.json');
const OUT = path.join(config.dataDir, 'charts', 'mining-cost.js');
const CIK = '1507605'; // MARA Holdings
const UA = process.env.SEC_USER_AGENT || `IVthLegion Charts ${config.baseUrl}`; // the SEC asks for an identifying UA
const DAY = 86400000;

const qEnd = q => { const [y, n] = [+q.slice(0, 4), +q[5]]; return Date.UTC(y, n * 3, 0); }; // last day of the quarter
const qStart = q => `${q.slice(0, 4)}-${String((+q[5] - 1) * 3 + 1).padStart(2, '0')}-01`;
const nextQ = q => (+q[5] === 4 ? `${+q.slice(0, 4) + 1}Q1` : `${q.slice(0, 4)}Q${+q[5] + 1}`);

function load() {
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8')).quarters;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(STORE, 'utf8')).quarters || {}; } catch { /* first run */ }
  return { ...seed, ...saved };
}

function write(quarters) {
  const rows = Object.keys(quarters).sort().map(q => [qStart(q), Math.round(quarters[q].cost * 1000 / quarters[q].btc)]);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `// MARA average mining cost per BTC by quarter (start date, USD). Generated ${new Date().toISOString()}\nwindow.LEGION_MINING = ${JSON.stringify(rows)};\n`);
}

export const text = html => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
  .replace(/\s+/g, ' ');
const num = (t, re) => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };

// First figure after each label = the period of the report (3 months in a 10-Q, the full year in a 10-K), in $ thousands.
export function parse(t) {
  const energy = num(t, /Purchased energy costs \$ ?([\d,]+)/);
  const host = num(t, /Third[- ]party hosting and other energy costs \$? ?([\d,]+)/);
  const om = num(t, /Operating and maintenance costs \$? ?([\d,]+)/);
  const btc = num(t, /BTC produced during the period, in whole BTC(?: \(\d\))? ([\d,]+)/);
  if ([energy, host, om, btc].some(v => !v)) throw new Error(`could not read the filing (energy ${energy}, hosting ${host}, O&M ${om}, BTC ${btc})`);
  return { cost: energy + host + om, btc };
}

async function sec(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`SEC ${r.status} ${url}`);
  return r;
}

// Called by the 12-hour data refresh. Returns the quarter added, or null.
export async function updateMiningCost() {
  const quarters = load();
  if (!fs.existsSync(OUT)) write(quarters);
  const q = nextQ(Object.keys(quarters).sort().pop());
  if (Date.now() < qEnd(q) + 20 * DAY) return null; // reporting window not open yet: nothing to ask

  const sub = await (await sec(`https://data.sec.gov/submissions/CIK${CIK.padStart(10, '0')}.json`)).json();
  const r = sub.filings.recent, want = new Date(qEnd(q)).toISOString().slice(0, 10);
  const i = r.form.findIndex((f, k) => (f === '10-Q' || f === '10-K') && r.reportDate[k] === want);
  if (i < 0) { console.log(`[mining] ${q}: MARA has not filed yet`); return null; }

  const doc = await (await sec(`https://www.sec.gov/Archives/edgar/data/${CIK}/${r.accessionNumber[i].replace(/-/g, '')}/${r.primaryDocument[i]}`)).text();
  let { cost, btc } = parse(text(doc));
  if (r.form[i] === '10-K') { // full year: take away Q1-Q3 to get Q4
    const y = q.slice(0, 4), prev = [1, 2, 3].map(n => quarters[`${y}Q${n}`]);
    if (prev.some(p => !p)) throw new Error(`${q}: Q1-Q3 ${y} missing, cannot derive Q4 from the 10-K`);
    cost -= prev.reduce((s, p) => s + p.cost, 0); btc -= prev.reduce((s, p) => s + p.btc, 0);
  }
  const perBtc = cost * 1000 / btc;
  if (!(perBtc > 5000 && perBtc < 500000)) throw new Error(`${q}: ${Math.round(perBtc)} per BTC looks wrong, not saved`);

  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(STORE, 'utf8')).quarters || {}; } catch { /* first one */ }
  saved[q] = { cost, btc, form: r.form[i], filed: r.filingDate[i] };
  fs.writeFileSync(STORE, JSON.stringify({ quarters: saved }, null, 1));
  write({ ...quarters, [q]: saved[q] });
  console.log(`[mining] ${q} added from MARA ${r.form[i]} filed ${r.filingDate[i]}: $${Math.round(perBtc)} per BTC`);
  return q;
}
