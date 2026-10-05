// Macro hub data (zero dependency, all cached server-side):
//  - economic calendar      TradingView economic-calendar feed (actual / forecast / previous, importance)
//  - central bank rates     latest + next rate decision per bank, from the same feed
//  - earnings calendar      TradingView screener, S&P 500 (ES) + Nasdaq-100 (NQ) + large-cap NYSE listings
//  - macro series           FRED CSV (no API key) + a BoJ policy-rate step series
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TV_HEADERS = { 'User-Agent': UA, Origin: 'https://www.tradingview.com', Referer: 'https://www.tradingview.com/' };
const CACHE_FILE = path.join(config.dataDir, 'macro-cache.json');
const DAY = 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const cache = new Map(); // key -> { exp, data }
async function cached(key, ttlMs, fn) { // ttlMs: number, or (data) => number
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  try {
    const data = await fn();
    cache.set(key, { exp: Date.now() + (typeof ttlMs === 'function' ? ttlMs(data) : ttlMs), data });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return data;
  } catch (e) {
    if (hit) return hit.data; // serve stale on upstream failure
    throw e;
  }
}

// ---------- Economic calendar ----------
export const CAL_COUNTRIES = ['US', 'EU', 'GB', 'JP', 'CN', 'DE', 'FR', 'IT', 'CA', 'AU', 'NZ', 'CH'];

async function tvEvents(from, to, countries = CAL_COUNTRIES) {
  const url = `https://economic-calendar.tradingview.com/events?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}&countries=${countries.join(',')}`;
  const res = await fetch(url, { headers: TV_HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`calendar HTTP ${res.status}`);
  const rows = (await res.json()).result || [];
  if (rows.length >= 2000 && to - from > 2 * 3600000) { // feed caps at 2000 rows: split the window
    const mid = from + Math.floor((to - from) / 2);
    const [a, b] = await Promise.all([tvEvents(from, mid, countries), tvEvents(mid, to, countries)]);
    const seen = new Set();
    return [...a, ...b].filter(e => !seen.has(e.id) && seen.add(e.id));
  }
  return rows;
}

function slimEvents(rows) {
  const units = {};
  for (const e of rows) if (e.unit) units[e.country + e.title] = e.unit;
  return rows.map(e => ({
    id: e.id, title: e.title, country: e.country, ticker: e.ticker || '', category: e.category || '', period: e.period || '',
    actual: e.actual ?? null, forecast: e.forecast ?? null, previous: e.previous ?? null,
    unit: e.unit || units[e.country + e.title] || '', scale: e.scale || '', currency: e.currency || '',
    importance: e.importance, date: e.date, source: e.source || '', sourceUrl: /^https?:\/\//.test(e.source_url || '') ? e.source_url : '',
    comment: (e.comment || '').slice(0, 700),
  })).sort((a, b) => a.date.localeCompare(b.date) || b.importance - a.importance);
}

async function getCalendar(from, to) {
  const f = Math.floor(from / 3600000) * 3600000, t = Math.ceil(to / 3600000) * 3600000;
  // Around a scheduled release, re-poll every 10 s so the actual number reaches members quickly.
  const awaiting = rows => rows.some(e => {
    const d = Date.parse(e.date) - Date.now();
    return d > -12 * 60000 && d < 2 * 60000 && e.actual == null && (e.forecast != null || e.previous != null);
  });
  const ttl = t < Date.now() - 2 * DAY ? 6 * 3600000 : rows => (awaiting(rows) ? 10000 : 120000);
  return cached(`cal:${f}:${t}`, ttl, async () => slimEvents(await tvEvents(f, t)));
}

// ---------- Central bank rates (latest decision + next meeting) ----------
const BANKS = {
  US: 'Federal Reserve', EU: 'European Central Bank', GB: 'Bank of England', JP: 'Bank of Japan', CA: 'Bank of Canada',
  AU: 'Reserve Bank of Australia', CH: 'Swiss National Bank', NZ: 'Reserve Bank of NZ', CN: 'People\'s Bank of China',
};
const isRateDecision = e => /INTR$/.test(e.ticker || '') && /Interest Rate Decision|Loan Prime Rate 1Y/.test(e.title);

async function getRateEvents() {
  return cached('rates:events', 3600000, async () => {
    const out = [];
    const start = Date.now() - 150 * DAY, end = Date.now() + 120 * DAY;
    for (let f = start; f < end; f += 45 * DAY) {
      out.push(...(await tvEvents(f, Math.min(end, f + 45 * DAY), Object.keys(BANKS))).filter(e => isRateDecision(e) || /^(Inflation Rate YoY|Core Inflation Rate YoY|PPI YoY|PPI MoM|Core PCE Price Index YoY|Unemployment Rate|Non Farm Payrolls|Initial Jobless Claims|GDP Growth Rate QoQ.*|Retail Sales YoY|Retail Sales MoM|Michigan Consumer Sentiment.*)$/.test(e.title)));
      await sleep(250);
    }
    return out;
  });
}

function centralBanks(events) {
  const now = Date.now();
  return Object.entries(BANKS).map(([country, bank]) => {
    const ev = events.filter(e => e.country === country && isRateDecision(e)).sort((a, b) => a.date.localeCompare(b.date));
    const done = ev.filter(e => e.actual != null && Date.parse(e.date) <= now);
    const last = done.at(-1);
    const next = ev.find(e => Date.parse(e.date) > now);
    if (!last) return null;
    return { country, bank, title: last.title, rate: last.actual, prev: last.previous, date: last.date, next: next ? next.date : null, nextForecast: next ? next.forecast : null };
  }).filter(Boolean);
}

// ---------- Earnings (S&P 500 = ES, Nasdaq-100 = NQ, NYSE large caps) ----------
const SCAN = 'https://scanner.tradingview.com/america/scan';
async function scan(body) {
  const res = await fetch(SCAN, { method: 'POST', headers: { ...TV_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ options: { lang: 'en' }, ...body }), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`scanner HTTP ${res.status}`);
  return (await res.json()).data || [];
}
async function members() {
  return cached('earn:members', 24 * 3600000, async () => {
    const [es, nq] = await Promise.all(['SYML:SP;SPX', 'SYML:NASDAQ;NDX'].map(set => scan({ columns: ['name'], symbols: { symbolset: [set] }, range: [0, 800] })));
    if (es.length < 400 || nq.length < 90) throw new Error(`index lists look incomplete (${es.length}/${nq.length})`);
    return { es: new Set(es.map(r => r.s)), nq: new Set(nq.map(r => r.s)) };
  });
}
const EARN_COLS = ['name', 'description', 'exchange', 'market_cap_basic', 'logoid', 'sector',
  'earnings_release_next_date', 'earnings_release_next_time', 'earnings_per_share_forecast_next_fq', 'revenue_forecast_next_fq',
  'earnings_release_date', 'earnings_release_time', 'earnings_per_share_fq', 'earnings_per_share_forecast_fq', 'revenue_fq', 'revenue_forecast_fq'];
const NYSE_MIN_CAP = 10e9;

function whenOf(code, ts) {
  if (code === -1) return 'bmo';
  if (code === 1) return 'amc';
  const et = new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
  const [h, m] = et.split(':').map(Number), mins = (h % 24) * 60 + m;
  return mins < 570 ? 'bmo' : mins >= 960 ? 'amc' : 'dmh';
}

async function getEarnings(from, to) {
  const f = Math.floor(from / 3600000) * 3600, t = Math.ceil(to / 3600000) * 3600; // unix seconds
  return cached(`earn:${f}:${t}`, 15 * 60000, async () => {
    const { es, nq } = await members();
    const base = { columns: EARN_COLS, range: [0, 1500], sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' } };
    const cap = [ // common shares / ADRs only: preferreds inherit the parent's market cap and would duplicate it
      { left: 'market_cap_basic', operation: 'egreater', right: 1e9 }, { left: 'is_primary', operation: 'equal', right: true },
      { left: 'type', operation: 'in_range', right: ['stock', 'dr'] }, { left: 'typespecs', operation: 'has_none_of', right: ['preferred'] }];
    const [upcoming, reported] = await Promise.all([
      scan({ ...base, filter: [...cap, { left: 'earnings_release_next_date', operation: 'in_range', right: [f, t] }] }),
      scan({ ...base, filter: [...cap, { left: 'earnings_release_date', operation: 'in_range', right: [f, t] }] }),
    ]);
    const rows = new Map();
    const add = (r, done) => {
      const d = Object.fromEntries(EARN_COLS.map((c, i) => [c, r.d[i]]));
      const idx = [es.has(r.s) && 'ES', nq.has(r.s) && 'NQ', d.exchange === 'NYSE' && 'NYSE'].filter(Boolean);
      if (!es.has(r.s) && !nq.has(r.s) && !(d.exchange === 'NYSE' && d.market_cap_basic >= NYSE_MIN_CAP)) return;
      const ts = done ? d.earnings_release_date : d.earnings_release_next_date;
      if (!ts) return;
      rows.set(r.s, {
        sym: d.name, tvSym: r.s, name: d.description, exchange: d.exchange, cap: d.market_cap_basic || 0, sector: d.sector || '',
        logo: /^[a-z0-9-]+$/.test(d.logoid || '') ? d.logoid : '', idx, ts: ts * 1000,
        when: whenOf(done ? d.earnings_release_time : d.earnings_release_next_time, ts), reported: done,
        epsEst: done ? d.earnings_per_share_forecast_fq : d.earnings_per_share_forecast_next_fq,
        revEst: done ? d.revenue_forecast_fq : d.revenue_forecast_next_fq,
        eps: done ? d.earnings_per_share_fq : null, rev: done ? d.revenue_fq : null,
      });
    };
    for (const r of reported) add(r, true);
    for (const r of upcoming) add(r, false); // a scheduled next report wins over an older one in the same window
    return [...rows.values()].sort((a, b) => a.ts - b.ts || b.cap - a.cap);
  });
}

// ---------- Macro series (FRED) ----------
// kind: line | step | bar. tf: transform. bias: [label when rising, label when falling, tone when rising (risk), tone when falling]
// fred: one id, or a list of ids oldest -> newest that are stitched together (each newer source wins from its first print).
// rescale: older sources are level-adjusted to match at the join (index series with different base years).
export const SERIES = [
  { id: 'usintr', code: 'USINTR', name: 'US Interest Rate (Fed funds, upper)', group: 'Rates', fred: ['FEDFUNDS', 'DFEDTAR', 'DFEDTARU'], unit: '%', kind: 'step', bias: ['Tightening', 'Easing', 'bear', 'bull'], flat: 'On hold', match: ['US', /^Fed Interest Rate Decision$/], note: 'Effective rate before 1982, target rate 1982–2008, upper bound since.' },
  { id: 'jpintr', code: 'JPINTR', name: 'Japan Interest Rate (BoJ)', group: 'Rates', fred: ['IRSTCB01JPM156N'], unit: '%', kind: 'step', bias: ['Tightening', 'Easing', 'bear', 'bull'], flat: 'On hold', match: ['JP', /^BoJ Interest Rate Decision$/] },
  { id: 'euintr', code: 'EUDIR', name: 'ECB Deposit Rate', group: 'Rates', fred: 'ECBDFR', unit: '%', kind: 'step', bias: ['Tightening', 'Easing', 'bear', 'bull'], flat: 'On hold', match: ['EU', /^ECB Interest Rate Decision$/] },
  { id: 'us10y', code: 'US10Y', name: 'US 10-Year Treasury Yield', group: 'Rates', fred: 'DGS10', unit: '%', kind: 'line', bias: ['Yields up', 'Yields down', 'bear', 'bull'] },
  { id: 'us02y', code: 'US02Y', name: 'US 2-Year Treasury Yield', group: 'Rates', fred: 'DGS2', unit: '%', kind: 'line', bias: ['Yields up', 'Yields down', 'bear', 'bull'] },
  { id: 't10y2y', code: 'US10Y-2Y', name: 'Yield Curve (10Y minus 2Y)', group: 'Rates', fred: 'T10Y2Y', unit: '%', kind: 'line', zero: true, bias: ['Steepening', 'Flattening', 'neutral', 'neutral'] },
  { id: 'real10', code: 'US10Y REAL', name: '10-Year Real Yield (TIPS)', group: 'Rates', fred: 'DFII10', unit: '%', kind: 'line', bias: ['Real yields up', 'Real yields down', 'bear', 'bull'] },
  { id: 'jp10y', code: 'JP10Y', name: 'Japan 10-Year Government Bond Yield', group: 'Rates', fred: 'IRLTLT01JPM156N', unit: '%', kind: 'line', bias: ['Yields up', 'Yields down', 'bear', 'bull'] },
  { id: 'cpi', code: 'USIRYY', name: 'US CPI (YoY)', group: 'Inflation', fred: 'CPIAUCSL', tf: 'yoy', unit: '%', kind: 'line', target: 2, bias: ['Hotter', 'Cooling', 'bear', 'bull'], match: ['US', /^Inflation Rate YoY$/] },
  { id: 'corecpi', code: 'USCIR', name: 'US Core CPI (YoY)', group: 'Inflation', fred: 'CPILFESL', tf: 'yoy', unit: '%', kind: 'line', target: 2, bias: ['Hotter', 'Cooling', 'bear', 'bull'], match: ['US', /^Core Inflation Rate YoY$/] },
  { id: 'ppi', code: 'USPPI', name: 'US PPI (YoY)', group: 'Inflation', fred: ['WPSFD49207', 'PPIFIS'], tf: 'yoy', unit: '%', kind: 'line', bias: ['Pipeline pressure up', 'Pipeline easing', 'bear', 'bull'], match: ['US', /^PPI (YoY|MoM)$/], note: 'Finished-goods PPI before 2010, final-demand PPI since.' },
  { id: 'corepce', code: 'USCPCEPI', name: 'US Core PCE (YoY) — Fed target gauge', group: 'Inflation', fred: 'PCEPILFE', tf: 'yoy', unit: '%', kind: 'line', target: 2, bias: ['Hotter', 'Cooling', 'bear', 'bull'], match: ['US', /^Core PCE Price Index (YoY|MoM)$/] },
  { id: 'breakeven', code: 'US10Y BE', name: '10-Year Breakeven Inflation (market expectation)', group: 'Inflation', fred: 'T10YIE', unit: '%', kind: 'line', target: 2, bias: ['Expectations rising', 'Expectations falling', 'bear', 'bull'] },
  { id: 'unrate', code: 'UNRATE', name: 'US Unemployment Rate', group: 'Labor', fred: 'UNRATE', unit: '%', kind: 'line', bias: ['Labor weakening', 'Labor tightening', 'bear', 'bull'], match: ['US', /^Unemployment Rate$/] },
  { id: 'nfp', code: 'USNFP', name: 'Non-Farm Payrolls (monthly change)', group: 'Labor', fred: 'PAYEMS', tf: 'diff', unit: 'K', kind: 'bar', bias: ['More jobs', 'Fewer jobs', 'bull', 'bear'], match: ['US', /^Non Farm Payrolls$/] },
  { id: 'claims', code: 'USIJC', name: 'Initial Jobless Claims (weekly)', group: 'Labor', fred: 'ICSA', tf: 'k', unit: 'K', kind: 'line', bias: ['Claims rising', 'Claims falling', 'bear', 'bull'], match: ['US', /^Initial Jobless Claims$/] },
  { id: 'sahm', code: 'SAHM', name: 'Sahm Rule Recession Indicator', group: 'Labor', fred: 'SAHMREALTIME', unit: '', kind: 'line', ref: [0.5, 'recession trigger 0.50'], bias: ['Recession risk up', 'Recession risk down', 'bear', 'bull'] },
  { id: 'jolts', code: 'USJO', name: 'JOLTS Job Openings', group: 'Labor', fred: 'JTSJOL', tf: 'm', unit: 'M', kind: 'line', bias: ['More openings', 'Fewer openings', 'neutral', 'neutral'], match: ['US', /^JOLTs Job Openings$/] },
  { id: 'wages', code: 'USAHEYY', name: 'Average Hourly Earnings (YoY)', group: 'Labor', fred: ['AHETPI', 'CES0500000003'], tf: 'yoy', unit: '%', kind: 'line', bias: ['Wage pressure up', 'Wage pressure easing', 'bear', 'bull'], match: ['US', /^Average Hourly Earnings YoY$/], note: 'Production & non-supervisory workers before 2007, all private employees since.' },
  { id: 'gdp', code: 'USGDPQQ', name: 'US Real GDP Growth (annualized QoQ)', group: 'Growth', fred: 'A191RL1Q225SBEA', unit: '%', kind: 'bar', bias: ['Accelerating', 'Slowing', 'bull', 'bear'], match: ['US', /^GDP Growth Rate QoQ/] },
  { id: 'indpro', code: 'USIPYY', name: 'US Industrial Production (YoY)', group: 'Growth', fred: 'INDPRO', tf: 'yoy', unit: '%', kind: 'line', zero: true, bias: ['Output rising', 'Output falling', 'bull', 'bear'], match: ['US', /^Industrial Production YoY$/] },
  { id: 'retail', code: 'USRSYY', name: 'US Retail Sales (YoY)', group: 'Growth', fred: 'RSAFS', tf: 'yoy', unit: '%', kind: 'line', bias: ['Spending up', 'Spending down', 'bull', 'bear'], match: ['US', /^Retail Sales (YoY|MoM)$/] },
  { id: 'housing', code: 'USHST', name: 'US Housing Starts (annual rate)', group: 'Growth', fred: 'HOUST', unit: 'K', kind: 'line', bias: ['Building more', 'Building less', 'bull', 'bear'], match: ['US', /^Housing Starts$/] },
  { id: 'umcsent', code: 'USCCI', name: 'UMich Consumer Sentiment', group: 'Growth', fred: 'UMCSENT', unit: '', kind: 'line', bias: ['Improving', 'Deteriorating', 'bull', 'bear'], match: ['US', /^Michigan Consumer Sentiment/] },
  { id: 'm2', code: 'USM2', name: 'US M2 Money Supply (YoY)', group: 'Liquidity', fred: 'M2SL', tf: 'yoy', unit: '%', kind: 'line', zero: true, bias: ['Liquidity up', 'Liquidity down', 'bull', 'bear'] },
  { id: 'walcl', code: 'FED BS', name: 'Fed Balance Sheet (total assets)', group: 'Liquidity', fred: 'WALCL', tf: 'tn', unit: 'T', prefix: '$', kind: 'line', bias: ['Expanding (QE)', 'Shrinking (QT)', 'bull', 'bear'] },
  { id: 'dollar', code: 'USD BROAD', name: 'Broad US Dollar Index (trade-weighted)', group: 'Liquidity', fred: ['TWEXBMTH', 'DTWEXBGS'], rescale: true, unit: '', kind: 'line', bias: ['Stronger USD', 'Weaker USD', 'bear', 'bull'], note: 'Pre-2006 history is the older broad index, re-based to join the current one.' },
  { id: 'hy', code: 'HY OAS', name: 'High-Yield Credit Spread', group: 'Markets', fred: 'BAMLH0A0HYM2', unit: '%', kind: 'line', bias: ['Credit stress up', 'Credit stress easing', 'bear', 'bull'], note: 'ICE licensing limits FRED to the last 3 years; see the Baa spread for long history.' },
  { id: 'baa', code: 'BAA10Y', name: 'Corporate Credit Spread (Baa minus 10Y)', group: 'Markets', fred: 'BAA10Y', unit: '%', kind: 'line', bias: ['Credit stress up', 'Credit stress easing', 'bear', 'bull'] },
  { id: 'vix', code: 'VIX', name: 'VIX Volatility Index (S&P 500 fear gauge)', group: 'Markets', fred: 'VIXCLS', unit: '', kind: 'line', ref: [20, 'calm / stressed 20'], bias: ['Fear rising', 'Fear easing', 'bear', 'bull'] },
  { id: 'oil', code: 'USOIL', name: 'WTI Crude Oil', group: 'Markets', fred: 'DCOILWTICO', unit: '', prefix: '$', kind: 'line', bias: ['Oil up', 'Oil down', 'bear', 'bull'] },
];

// BoJ policy rate decisions before the live feed window (effective dates). Newer decisions come from the calendar.
const BOJ_SEED = [['2001-03-19', 0.0], ['2006-07-14', 0.25], ['2007-02-21', 0.5], ['2008-10-31', 0.3], ['2008-12-19', 0.1], ['2016-02-16', -0.1], ['2024-03-19', 0.1], ['2024-07-31', 0.25], ['2025-01-24', 0.5]];
const BOJ_FEED_FROM = Date.parse('2025-02-01');

let store = { updated: 0, fred: {}, boj: [] };
try { store = { ...store, ...JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) }; } catch { /* first run */ }
const save = () => { try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(store)); } catch (e) { console.error('[macro] save:', e.message); } };

// Bundled snapshot (seed/macro-fred.json.gz, rebuilt with `node tools/macro-seed.mjs`): charts work immediately on a
// fresh server and keep working if FRED's website refuses the host (it stalls some cloud IPs). Live data replaces it.
const SEED_FILE = new URL('../seed/macro-fred.json.gz', import.meta.url);
try {
  const seed = JSON.parse(zlib.gunzipSync(fs.readFileSync(SEED_FILE)).toString());
  let used = 0;
  for (const [id, pts] of Object.entries(seed.fred)) if (!store.fred[id]) { store.fred[id] = pts; used++; }
  if (!store.boj.length) store.boj = seed.boj || [];
  if (used && !store.updated) store.updated = seed.updated;
  if (used) console.log(`[macro] loaded ${used} series from the bundled snapshot (${new Date(seed.updated).toISOString().slice(0, 10)})`);
} catch (e) { console.error('[macro] seed:', e.message); }

// FRED's official API (free key, env FRED_API_KEY) is the reliable route from servers; the public CSV needs no key.
const fredStatus = { via: process.env.FRED_API_KEY ? 'api' : 'csv', lastAttempt: 0, lastOk: store.updated, lastError: null };
async function fredSeries(id) {
  const key = process.env.FRED_API_KEY;
  const url = key
    ? `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${encodeURIComponent(key)}&file_type=json`
    : `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`FRED ${id} HTTP ${res.status}`);
  const pts = [];
  const push = (d, v) => { const t = Date.parse(d), n = parseFloat(v); if (Number.isFinite(t) && Number.isFinite(n)) pts.push([t, n]); };
  if (key) for (const o of (await res.json()).observations || []) push(o.date, o.value);
  else for (const line of (await res.text()).trim().split('\n').slice(1)) push(...line.split(','));
  if (pts.length < 10) throw new Error(`FRED ${id}: no data`);
  return pts;
}

async function bojDecisions() {
  const out = [];
  for (let f = BOJ_FEED_FROM; f < Date.now(); f += 90 * DAY) {
    const rows = await tvEvents(f, Math.min(Date.now(), f + 90 * DAY), ['JP']);
    for (const e of rows) if (e.title === 'BoJ Interest Rate Decision' && e.actual != null) out.push([Date.parse(e.date), e.actual]);
    await sleep(250);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

let refreshing = null;
async function refreshSeries() {
  if (refreshing) return refreshing;
  fredStatus.lastAttempt = Date.now();
  refreshing = (async () => {
    const ids = [...new Set([...SERIES.flatMap(s => [].concat(s.fred || [])), 'USREC'])];
    let ok = 0, lastErr = null;
    for (let i = 0; i < ids.length; i += 4) {
      const batch = ids.slice(i, i + 4);
      const res = await Promise.allSettled(batch.map(fredSeries));
      res.forEach((r, j) => {
        if (r.status === 'fulfilled') { store.fred[batch[j]] = r.value; ok++; }
        else { lastErr = r.reason.name === 'TimeoutError' ? `FRED ${batch[j]}: timed out` : r.reason.message; console.error('[macro]', lastErr); }
      });
      if (!ok && i >= 4) break; // first two batches all failed: FRED is unreachable from here, don't wait out the rest
    }
    try { store.boj = await bojDecisions(); } catch (e) { console.error('[macro] boj:', e.message); }
    if (ok) { store.updated = Date.now(); fredStatus.lastOk = store.updated; save(); }
    fredStatus.lastError = ok === ids.length ? null : `${ids.length - ok}/${ids.length} series failed. Last: ${lastErr}`;
    console.log(`[macro] refreshed ${ok}/${ids.length} FRED series via ${fredStatus.via}, ${store.boj.length} BoJ decisions`);
  })().finally(() => { refreshing = null; });
  return refreshing;
}
// Background refresh, never on a member's request path, and at most every 30 minutes when FRED keeps failing.
function refreshInBackground() {
  if (refreshing || Date.now() - fredStatus.lastAttempt < 30 * 60000) return;
  refreshSeries().catch(e => console.error('[macro] refresh:', e.message));
}

function applyTf(s, raw) {
  if (s.tf === 'yoy') {
    const byMonth = new Map(raw.map(([t, v]) => [new Date(t).toISOString().slice(0, 7), v]));
    return raw.map(([t, v]) => {
      const d = new Date(t); d.setUTCFullYear(d.getUTCFullYear() - 1);
      const p = byMonth.get(d.toISOString().slice(0, 7));
      return p ? [t, +((v / p - 1) * 100).toFixed(2)] : null;
    }).filter(Boolean);
  }
  if (s.tf === 'diff') return raw.slice(1).map(([t, v], i) => [t, Math.round(v - raw[i][1])]);
  if (s.tf === 'k') return raw.map(([t, v]) => [t, Math.round(v / 1000)]);
  if (s.tf === 'm') return raw.map(([t, v]) => [t, +(v / 1000).toFixed(3)]);
  if (s.tf === 'tn') return raw.map(([t, v]) => [t, +(v / 1e6).toFixed(3)]);
  return raw;
}

// Stitch the sources (newest wins from its first print), then thin daily data.
function buildSeries(s) {
  if (s.id === 'jpintr') return bojSeries();
  const ids = [].concat(s.fred);
  let out = null;
  for (let i = ids.length - 1; i >= 0; i--) {
    const raw = store.fred[ids[i]];
    if (!raw) continue;
    const pts = applyTf(s, raw);
    if (!out || !out.length) { out = pts; continue; }
    const join = out[0][0];
    let older = pts.filter(p => p[0] < join);
    if (s.rescale) {
      const ref = pts.filter(p => p[0] <= join).at(-1);
      if (ref && join - ref[0] < 62 * DAY) older = older.map(([t, v]) => [t, +(v * out[0][1] / ref[1]).toFixed(4)]);
    }
    out = [...older, ...out];
  }
  if (!out) return null;
  let pts = out.filter(([t]) => t >= Date.parse('1945-01-01'));
  // daily data: full detail for the last 3 years, one point per week before that
  if (pts.length > 1500) {
    const cut = Date.now() - 3 * 365 * DAY, thin = [];
    for (const p of pts) {
      if (p[0] < cut && thin.length && Math.floor(thin.at(-1)[0] / (7 * DAY)) === Math.floor(p[0] / (7 * DAY))) thin[thin.length - 1] = p;
      else thin.push(p);
    }
    pts = thin;
  }
  return pts;
}

// NBER recession months -> [start, end] periods
function recessions() {
  const out = [];
  for (const [t, v] of store.fred.USREC || []) {
    if (v === 1 && (!out.length || out.at(-1)[2])) out.push([t, t, false]);
    else if (v === 1) out.at(-1)[1] = t + 31 * DAY;
    else if (out.length && !out.at(-1)[2]) out.at(-1)[2] = true;
  }
  return out.filter(r => r[0] >= Date.parse('1945-01-01')).map(([a, b]) => [Math.floor(a / DAY), Math.floor(b / DAY)]);
}

function bojSeries() {
  const seedFrom = Date.parse(BOJ_SEED[0][0]);
  const oecd = (store.fred.IRSTCB01JPM156N || []).filter(([t]) => t < seedFrom); // BoJ discount / policy rate history before 2001
  const steps = [...oecd, ...BOJ_SEED.map(([d, v]) => [Date.parse(d), v]), ...store.boj.filter(([t]) => t >= BOJ_FEED_FROM)];
  const pts = [];
  for (const [t, v] of steps) if (!pts.length || pts.at(-1)[1] !== v) pts.push([t, v]);
  pts.push([Date.now(), pts.at(-1)[1]]); // extend the current rate to today
  return pts;
}

// The feed lists releases only a few weeks ahead; the jobs report follows a fixed rule (first Friday, 08:30 New York).
function nyWallTime(y, m, d, h, mi) {
  const guess = Date.UTC(y, m, d, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess)).map(x => [x.type, +x.value]));
  return guess - (Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - guess);
}
function estimatedNext(id) {
  if (id !== 'nfp' && id !== 'unrate') return null;
  const now = new Date();
  for (let k = 0; k < 3; k++) {
    const y = now.getUTCFullYear(), m = now.getUTCMonth() + k;
    const first = new Date(Date.UTC(y, m, 1)), d = 1 + ((5 - first.getUTCDay() + 7) % 7);
    const t = nyWallTime(first.getUTCFullYear(), first.getUTCMonth(), d, 8, 30);
    if (t > Date.now()) return { date: new Date(t).toISOString(), title: 'US Jobs Report', forecast: null, estimated: true };
  }
  return null;
}

// FRED posts new prints shortly after each release; re-pull (at most every 30 min) once a tracked release has passed.
let lastReleaseCheck = 0;
function refreshAfterRelease(events, now) {
  if (now - lastReleaseCheck < 30 * 60000 || refreshing) return;
  const released = events.some(e => {
    const t = Date.parse(e.date);
    return t > store.updated && t < now - 15 * 60000 && SERIES.some(s => s.match && s.match[0] === e.country && s.match[1].test(e.title));
  });
  if (!released) return;
  lastReleaseCheck = now;
  fredStatus.lastAttempt = 0;
  refreshInBackground();
}

async function getSeries() {
  if (!Object.keys(store.fred).length) await refreshSeries(); // no snapshot at all: first fill must wait
  else if (Date.now() - store.updated > 3 * 3600000) refreshInBackground();
  const events = await getRateEvents().catch(() => []);
  const now = Date.now();
  refreshAfterRelease(events, now);
  const series = SERIES.map(s => {
    const pts = buildSeries(s);
    if (!pts || !pts.length) return null;
    const next = s.match && events.filter(e => e.country === s.match[0] && s.match[1].test(e.title) && Date.parse(e.date) > now).sort((a, b) => a.date.localeCompare(b.date))[0];
    const { fred, match, tf, rescale, ...meta } = s;
    // point times are sent as days since epoch to keep the payload small
    return { ...meta, source: s.id === 'jpintr' ? 'OECD (BoJ rate) to 2001, BoJ decisions since' : 'FRED: ' + [].concat(fred).join(' + '), points: pts.map(([t, v]) => [Math.floor(t / DAY), v]), next: next ? { date: next.date, title: next.title, forecast: next.forecast } : estimatedNext(s.id) };
  }).filter(Boolean);
  return { updated: store.updated, series, banks: centralBanks(events), recessions: recessions(), fred: { ...fredStatus } };
}

// ---------- routes ----------
function sendGz(req, res, obj, maxAge = 60) {
  const body = Buffer.from(JSON.stringify(obj));
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `private, max-age=${maxAge}`, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(gzip ? zlib.gzipSync(body) : body);
}
function range(req, maxDays) {
  const u = new URL(req.url, 'http://x');
  const from = Date.parse(u.searchParams.get('from') || ''), to = Date.parse(u.searchParams.get('to') || '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [null, 'from/to must be ISO dates with to > from'];
  if (to - from > maxDays * DAY) return [null, `range is limited to ${maxDays} days`];
  if (from < Date.now() - 400 * DAY || to > Date.now() + 200 * DAY) return [null, 'range is outside the supported window'];
  return [[from, to], null];
}

export function registerMacroRoutes(router) {
  router.get('/api/macro/calendar', async (req, res) => {
    const [r, err] = range(req, 16);
    if (err) return res.json(400, { error: err });
    try { sendGz(req, res, { events: await getCalendar(...r), countries: CAL_COUNTRIES, fetched: Date.now() }, 60); }
    catch (e) { console.error('[macro] calendar:', e.message); res.json(502, { error: 'Economic calendar is unavailable right now.' }); }
  });
  router.get('/api/macro/earnings', async (req, res) => {
    const [r, err] = range(req, 16);
    if (err) return res.json(400, { error: err });
    try { sendGz(req, res, { rows: await getEarnings(...r), fetched: Date.now() }, 300); }
    catch (e) { console.error('[macro] earnings:', e.message); res.json(502, { error: 'Earnings calendar is unavailable right now.' }); }
  });
  router.get('/api/macro/series', async (req, res) => {
    try { sendGz(req, res, await getSeries(), 600); }
    catch (e) { console.error('[macro] series:', e.message); res.json(502, { error: 'Macro data is unavailable right now.' }); }
  });
}

export function startMacro() {
  if (Date.now() - store.updated > 3 * 3600000) setTimeout(refreshInBackground, 8000);
  setInterval(() => { fredStatus.lastAttempt = 0; refreshInBackground(); }, 3 * 3600000).unref();
}
