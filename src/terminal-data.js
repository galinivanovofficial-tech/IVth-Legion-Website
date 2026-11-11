// Bitcoin Terminal / Realized / Balanced Price, rebuilt by the data-refresh job.
//   Realized    = price / MVRV                       (Coin Metrics community API, no key)
//   Transferred = Σ(CDD × price) / (supply × days since genesis)
//   Terminal    = 21 × Transferred,  Balanced = Realized − Transferred
// CDD: src/cdd-history.json (committed: daily CDD since Nov 2022 + x0, the calibrated sum before it) + the last 4 years from
// BGeometrics (free, 10 requests/hour; the job runs every 8h), cached in data/cdd-cache.json so a failed fetch keeps the last good copy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'onchain-terminal.js');
const HISTORY = path.join(__dirname, 'cdd-history.json');
const CACHE = path.join(__dirname, '..', 'data', 'cdd-cache.json');
const GENESIS = Date.UTC(2009, 0, 3), DAY = 864e5;

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function coinMetrics() {
  const rows = [];
  let url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD,CapMVRVCur,SplyCur&frequency=1d&page_size=10000&start_time=2010-07-01';
  while (url) {
    const d = await getJSON(url);
    rows.push(...d.data);
    url = d.next_page_url || null;
  }
  return rows.filter(r => r.PriceUSD && r.CapMVRVCur)
    .map(r => ({ d: r.time.slice(0, 10), p: +r.PriceUSD, mv: +r.CapMVRVCur, s: +r.SplyCur }));
}

function readJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }

async function cddSeries() {
  const hist = readJSON(HISTORY, {});
  const cache = readJSON(CACHE, {});
  const cdd = { ...(hist.cdd || {}), ...cache };
  try {
    const recent = await getJSON('https://bitcoin-data.com/v1/cdd');
    if (Array.isArray(recent) && recent.length) {
      // the free window only covers the last 4 years, so keep every day we have ever seen
      for (const r of recent) if (r.cdd != null) cache[r.d] = cdd[r.d] = +r.cdd;
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify(cache));
    }
  } catch (e) { console.log('[data] CDD fetch failed, using cached copy:', e.message); }
  return { cdd, x0: hist.x0 || null };
}

export async function buildTerminal() {
  const [rows, { cdd, x0 }] = await Promise.all([coinMetrics(), cddSeries()]);
  if (!rows.length) throw new Error('no Coin Metrics rows');
  const r5 = v => (v == null || !isFinite(v) ? null : +v.toPrecision(5));
  const o = { start: rows[0].d, end: rows[rows.length - 1].d, cddFrom: null, price: [], realized: [], terminal: [], balanced: [] };
  // x0 = value-days destroyed before the CDD history starts (calibrated), so the sum is anchored correctly
  let X = x0 ? x0.value : 0, gap = 0;
  for (const r of rows) {
    const realized = r.p / r.mv;
    if (x0 && r.d <= x0.through) { o.price.push(r5(r.p)); o.realized.push(r5(realized)); o.terminal.push(null); o.balanced.push(null); continue; }
    const c = cdd[r.d];
    if (c == null) gap++;
    else if (!o.cddFrom) o.cddFrom = r.d;
    X += (c || 0) * r.p;
    const tr = o.cddFrom ? X / (r.s * ((Date.parse(r.d) - GENESIS) / DAY + 1)) : null;
    o.price.push(r5(r.p)); o.realized.push(r5(realized));
    o.terminal.push(tr == null ? null : r5(tr * 21)); o.balanced.push(tr == null ? null : r5(realized - tr));
  }
  fs.writeFileSync(OUT, `window.LEGION_TERMINAL=${JSON.stringify(o)};\n`);
  const n = o.price.length - 1;
  console.log(`[data] onchain-terminal.js updated — ${o.end}: terminal ${o.terminal[n]}, realized ${o.realized[n]}, balanced ${o.balanced[n]} (days without CDD: ${gap})`);
  return o;
}
