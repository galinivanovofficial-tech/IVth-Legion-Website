// Market data proxies (zero dependency): Fear & Greed, earnings calendar, economic calendar.
// All endpoints are public + cached in memory so external APIs are hit rarely.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const cache = new Map(); // key -> { exp, data }
let yahooCrumb = null;
let yahooCookie = null;
async function cached(key, ttlSec, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  const data = await fn();
  cache.set(key, { exp: Date.now() + ttlSec * 1000, data });
  return data;
}

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ---------- Fear & Greed ----------
async function getFearGreed() {
  const [crypto, stock] = await Promise.allSettled([
    cached('fng:crypto', 3600, async () => {
      const d = await fetchJSON('https://api.alternative.me/fng/?limit=90');
      const rows = (d.data || []).map(r => ({ t: Number(r.timestamp) * 1000, v: Number(r.value), label: r.value_classification }));
      return { value: rows[0]?.v ?? null, label: rows[0]?.label ?? '', history: rows.reverse() };
    }),
    cached('fng:stock', 3600, async () => {
      const d = await fetchJSON('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
        Origin: 'https://edition.cnn.com', Referer: 'https://edition.cnn.com/',
      });
      const f = d.fear_and_greed || {};
      const hist = (d.fear_and_greed_historical?.data || []).slice(-90).map(p => ({ t: p.x, v: Math.round(p.y * 10) / 10 }));
      return {
        value: Math.round(f.score * 10) / 10, label: f.rating || '',
        prevWeek: Math.round((f.previous_1_week ?? 0) * 10) / 10,
        prevMonth: Math.round((f.previous_1_month ?? 0) * 10) / 10,
        prevYear: Math.round((f.previous_1_year ?? 0) * 10) / 10,
        history: hist,
      };
    }),
  ]);
  return {
    crypto: crypto.status === 'fulfilled' ? crypto.value : null,
    stock: stock.status === 'fulfilled' ? stock.value : null,
  };
}

// ---------- Earnings calendar (Nasdaq) ----------
function mcapToNumber(s) {
  if (!s) return 0;
  return Number(String(s).replace(/[$,]/g, '')) || 0;
}
function fmtMcap(n) {
  if (!n) return '';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + 'M';
  return String(n);
}
async function earningsForDate(iso) {
  return cached('earn:' + iso, 6 * 3600, async () => {
    const d = await fetchJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${iso}`);
    const rows = d?.data?.rows || [];
    const mapped = rows.map(r => ({
      symbol: r.symbol,
      name: (r.name || '').replace(/\s+(Inc|Corp|Corporation|Ltd|plc|Co)\.?$/i, ''),
      when: r.time === 'time-pre-market' ? 'bmo' : r.time === 'time-after-hours' ? 'amc' : 'tbd',
      mcap: mcapToNumber(r.marketCap),
      mcapFmt: fmtMcap(mcapToNumber(r.marketCap)),
      epsForecast: r.epsForecast || '',
      quarter: r.fiscalQuarterEnding || '',
    }));
    mapped.sort((a, b) => b.mcap - a.mcap);
    return mapped.slice(0, 40);
  });
}
function isoDate(d) { return d.toISOString().slice(0, 10); }
function mondayOf(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Mon=0
  x.setUTCDate(x.getUTCDate() - dow);
  return x;
}
async function getEarnings() {
  const mon = mondayOf(new Date());
  const days = [];
  for (let w = 0; w < 2; w++) {
    for (let i = 0; i < 5; i++) {
      const d = new Date(mon); d.setUTCDate(mon.getUTCDate() + w * 7 + i);
      days.push({ date: isoDate(d), week: w === 0 ? 'this' : 'next' });
    }
  }
  const results = await Promise.allSettled(days.map(d => earningsForDate(d.date)));
  return days.map((d, i) => ({ ...d, rows: results[i].status === 'fulfilled' ? results[i].value : [] }));
}

// ---------- Economic calendar ----------
// Live: ForexFactory weekly feed. Plus a curated forward calendar of the dates that move markets.
async function getEconWeek() {
  return cached('econ:ff', 3600, async () => {
    const rows = await fetchJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    return rows
      .filter(r => ['High', 'Medium'].includes(r.impact))
      .map(r => ({ title: r.title, country: r.country, date: r.date, impact: r.impact, forecast: r.forecast || '', previous: r.previous || '' }));
  });
}

function nthFriday(year, month, n) { // month 0-based
  const d = new Date(Date.UTC(year, month, 1));
  const offset = (5 - d.getUTCDay() + 7) % 7; // to first Friday
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}
function buildKeyDates() {
  const now = new Date();
  const events = [];
  // FOMC 2026 (statement 14:00 ET on day 2; * = projections + dot plot) — federalreserve.gov schedule
  const fomc = [['2026-01-28'], ['2026-03-18', 1], ['2026-04-29'], ['2026-06-17', 1], ['2026-07-29'], ['2026-09-16', 1], ['2026-10-28'], ['2026-12-09', 1]];
  for (const [d, proj] of fomc) events.push({ date: d, title: 'FOMC Rate Decision' + (proj ? ' + Projections (dot plot)' : ''), cat: 'fed', impact: 'High' });
  // CPI 2026 (BLS schedule, 08:30 ET)
  const cpi = [['2026-01-13', 'Dec'], ['2026-02-13', 'Jan'], ['2026-03-11', 'Feb'], ['2026-04-10', 'Mar'], ['2026-05-12', 'Apr'], ['2026-06-10', 'May'], ['2026-07-14', 'Jun'], ['2026-08-12', 'Jul'], ['2026-09-11', 'Aug'], ['2026-10-14', 'Sep'], ['2026-11-10', 'Oct'], ['2026-12-10', 'Nov']];
  for (const [d, m] of cpi) events.push({ date: d, title: `US CPI (${m} data)`, cat: 'data', impact: 'High' });
  // Computed: NFP = first Friday, OPEX = third Friday (quad witching Mar/Jun/Sep/Dec)
  for (let i = 0; i < 8; i++) {
    const y = now.getUTCFullYear(), m = now.getUTCMonth() + i;
    const nfp = nthFriday(y, m, 1), opex = nthFriday(y, m, 3);
    const quad = [2, 5, 8, 11].includes(opex.getUTCMonth());
    events.push({ date: isoDate(nfp), title: 'US Jobs Report (NFP)', cat: 'data', impact: 'High' });
    events.push({ date: isoDate(opex), title: quad ? 'Quad Witching — options + futures expiry' : 'Monthly Options Expiry (OPEX)', cat: 'flows', impact: quad ? 'High' : 'Medium' });
  }
  // Elections
  events.push({ date: '2026-11-03', title: 'US Midterm Elections', cat: 'politics', impact: 'High' });
  // Dedupe + keep from 7 days ago forward, sorted
  const cutoff = isoDate(new Date(now.getTime() - 7 * 86400000));
  const seen = new Set();
  return events
    .filter(e => e.date >= cutoff)
    .filter(e => { const k = e.date + e.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Market News (Google News RSS — free, no key, aggregates Reuters/Bloomberg/Forbes/WSJ etc.) ----------
async function getNews() {
  return cached('news:gn', 300, async () => {
    const res = await fetch('https://news.google.com/rss/search?q=bitcoin+crypto+market+when:1d&hl=en-US&gl=US&ceid=US:en', {
      headers: { 'User-Agent': UA, Accept: 'application/xml, text/xml, */*' }
    });
    if (!res.ok) throw new Error('Google News RSS ' + res.status);
    const xml = await res.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < 30) {
      const block = m[1];
      const g = (tag) => { const r2 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`); const m2 = block.match(r2); return m2 ? (m2[1] || m2[2] || '').trim() : ''; };
      const title = g('title').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
      const source = g('source').replace(/&amp;/g,'&');
      const pubDate = g('pubDate');
      const link = g('link');
      const ts = pubDate ? new Date(pubDate).getTime() : Date.now();
      if (title) items.push({ id: String(ts) + title.slice(0,20), title, source, url: link, ts, body: '' });
    }
    return items;
  });
}

// ---------- TradFi prices (XAU, SPX, NASDAQ) via Yahoo Finance v8 chart ----------
async function fetchYahooPrice(symbol) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const d = await fetchJSON(url);
  const r = d.chart?.result?.[0];
  if (!r) return null;
  const m = r.meta;
  const price = m.regularMarketPrice ?? 0;
  const prevClose = m.chartPreviousClose ?? m.previousClose ?? price;
  const change = prevClose ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : 0;
  return { price, change };
}

const tradfiCache = { exp: 0, data: null };
async function getTradFi() {
  if (tradfiCache.data && tradfiCache.exp > Date.now()) return tradfiCache.data;
  const results = {};
  const symbols = [['GC=F','xau'], ['^GSPC','spx'], ['^IXIC','ndx']];
  for (const [sym, key] of symbols) {
    try {
      results[key] = await fetchYahooPrice(sym);
    } catch(e) {
      console.warn('[markets] tradfi', key, e.message);
      results[key] = null;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  const hasData = Object.values(results).some(v => v !== null);
  if (hasData) {
    tradfiCache.data = results;
    tradfiCache.exp = Date.now() + 300_000;
  }
  return results;
}

// ---------- YTD ROI for any asset ----------
const ASSET_MAP = {
  // Crypto — top 15 by market cap (Binance)
  BTC:  { type: 'crypto', category: 'crypto', label: 'Bitcoin',    binance: 'BTCUSDT' },
  ETH:  { type: 'crypto', category: 'crypto', label: 'Ethereum',   binance: 'ETHUSDT' },
  XRP:  { type: 'crypto', category: 'crypto', label: 'XRP',        binance: 'XRPUSDT' },
  BNB:  { type: 'crypto', category: 'crypto', label: 'BNB',        binance: 'BNBUSDT' },
  SOL:  { type: 'crypto', category: 'crypto', label: 'Solana',     binance: 'SOLUSDT' },
  ADA:  { type: 'crypto', category: 'crypto', label: 'Cardano',    binance: 'ADAUSDT' },
  DOGE: { type: 'crypto', category: 'crypto', label: 'Dogecoin',   binance: 'DOGEUSDT' },
  TRX:  { type: 'crypto', category: 'crypto', label: 'TRON',       binance: 'TRXUSDT' },
  AVAX: { type: 'crypto', category: 'crypto', label: 'Avalanche',  binance: 'AVAXUSDT' },
  LINK: { type: 'crypto', category: 'crypto', label: 'Chainlink',  binance: 'LINKUSDT' },
  DOT:  { type: 'crypto', category: 'crypto', label: 'Polkadot',   binance: 'DOTUSDT' },
  SUI:  { type: 'crypto', category: 'crypto', label: 'Sui',        binance: 'SUIUSDT' },
  SHIB: { type: 'crypto', category: 'crypto', label: 'Shiba Inu',  binance: 'SHIBUSDT' },
  LTC:  { type: 'crypto', category: 'crypto', label: 'Litecoin',   binance: 'LTCUSDT' },
  NEAR: { type: 'crypto', category: 'crypto', label: 'NEAR',       binance: 'NEARUSDT' },
  // Stocks — S&P 500 top 20
  AAPL:  { type: 'yahoo', category: 'stocks', symbol: 'AAPL',  label: 'Apple' },
  MSFT:  { type: 'yahoo', category: 'stocks', symbol: 'MSFT',  label: 'Microsoft' },
  NVDA:  { type: 'yahoo', category: 'stocks', symbol: 'NVDA',  label: 'NVIDIA' },
  AMZN:  { type: 'yahoo', category: 'stocks', symbol: 'AMZN',  label: 'Amazon' },
  GOOGL: { type: 'yahoo', category: 'stocks', symbol: 'GOOGL', label: 'Alphabet' },
  META:  { type: 'yahoo', category: 'stocks', symbol: 'META',  label: 'Meta' },
  'BRK-B': { type: 'yahoo', category: 'stocks', symbol: 'BRK-B', label: 'Berkshire Hathaway' },
  TSLA:  { type: 'yahoo', category: 'stocks', symbol: 'TSLA',  label: 'Tesla' },
  UNH:   { type: 'yahoo', category: 'stocks', symbol: 'UNH',   label: 'UnitedHealth' },
  JPM:   { type: 'yahoo', category: 'stocks', symbol: 'JPM',   label: 'JPMorgan Chase' },
  V:     { type: 'yahoo', category: 'stocks', symbol: 'V',     label: 'Visa' },
  JNJ:   { type: 'yahoo', category: 'stocks', symbol: 'JNJ',   label: 'Johnson & Johnson' },
  PG:    { type: 'yahoo', category: 'stocks', symbol: 'PG',    label: 'Procter & Gamble' },
  HD:    { type: 'yahoo', category: 'stocks', symbol: 'HD',    label: 'Home Depot' },
  MA:    { type: 'yahoo', category: 'stocks', symbol: 'MA',    label: 'Mastercard' },
  LLY:   { type: 'yahoo', category: 'stocks', symbol: 'LLY',   label: 'Eli Lilly' },
  ABBV:  { type: 'yahoo', category: 'stocks', symbol: 'ABBV',  label: 'AbbVie' },
  MRK:   { type: 'yahoo', category: 'stocks', symbol: 'MRK',   label: 'Merck' },
  AVGO:  { type: 'yahoo', category: 'stocks', symbol: 'AVGO',  label: 'Broadcom' },
  COST:  { type: 'yahoo', category: 'stocks', symbol: 'COST',  label: 'Costco' },
  // Stocks — NASDAQ top (unique additions)
  NFLX:  { type: 'yahoo', category: 'stocks', symbol: 'NFLX',  label: 'Netflix' },
  AMD:   { type: 'yahoo', category: 'stocks', symbol: 'AMD',   label: 'AMD' },
  ADBE:  { type: 'yahoo', category: 'stocks', symbol: 'ADBE',  label: 'Adobe' },
  CSCO:  { type: 'yahoo', category: 'stocks', symbol: 'CSCO',  label: 'Cisco' },
  PEP:   { type: 'yahoo', category: 'stocks', symbol: 'PEP',   label: 'PepsiCo' },
  INTC:  { type: 'yahoo', category: 'stocks', symbol: 'INTC',  label: 'Intel' },
  QCOM:  { type: 'yahoo', category: 'stocks', symbol: 'QCOM',  label: 'Qualcomm' },
  TXN:   { type: 'yahoo', category: 'stocks', symbol: 'TXN',   label: 'Texas Instruments' },
  ISRG:  { type: 'yahoo', category: 'stocks', symbol: 'ISRG',  label: 'Intuitive Surgical' },
  AMGN:  { type: 'yahoo', category: 'stocks', symbol: 'AMGN',  label: 'Amgen' },
  CMCSA: { type: 'yahoo', category: 'stocks', symbol: 'CMCSA', label: 'Comcast' },
  PLTR:  { type: 'yahoo', category: 'stocks', symbol: 'PLTR',  label: 'Palantir' },
  ARM:   { type: 'yahoo', category: 'stocks', symbol: 'ARM',   label: 'ARM Holdings' },
  TSM:   { type: 'yahoo', category: 'stocks', symbol: 'TSM',   label: 'TSMC' },
  COIN:  { type: 'yahoo', category: 'stocks', symbol: 'COIN',  label: 'Coinbase' },
  MSTR:  { type: 'yahoo', category: 'stocks', symbol: 'MSTR',  label: 'MicroStrategy' },
  // Energy / Oil stocks
  XOM:   { type: 'yahoo', category: 'energy', symbol: 'XOM',   label: 'Exxon Mobil' },
  CVX:   { type: 'yahoo', category: 'energy', symbol: 'CVX',   label: 'Chevron' },
  COP:   { type: 'yahoo', category: 'energy', symbol: 'COP',   label: 'ConocoPhillips' },
  SLB:   { type: 'yahoo', category: 'energy', symbol: 'SLB',   label: 'Schlumberger' },
  EOG:   { type: 'yahoo', category: 'energy', symbol: 'EOG',   label: 'EOG Resources' },
  OXY:   { type: 'yahoo', category: 'energy', symbol: 'OXY',   label: 'Occidental Petro' },
  DVN:   { type: 'yahoo', category: 'energy', symbol: 'DVN',   label: 'Devon Energy' },
  XLE:   { type: 'yahoo', category: 'energy', symbol: 'XLE',   label: 'Energy Select ETF' },
  // Indices
  SPX: { type: 'yahoo', category: 'indices', symbol: '^GSPC', label: 'S&P 500' },
  NDX: { type: 'yahoo', category: 'indices', symbol: '^IXIC', label: 'NASDAQ' },
  DJI: { type: 'yahoo', category: 'indices', symbol: '^DJI',  label: 'Dow Jones' },
  RUT: { type: 'yahoo', category: 'indices', symbol: '^RUT',  label: 'Russell 2000' },
  // Commodities
  OIL:    { type: 'yahoo', category: 'commodities', symbol: 'CL=F', label: 'Crude Oil' },
  NATGAS: { type: 'yahoo', category: 'commodities', symbol: 'NG=F', label: 'Natural Gas' },
  COPPER: { type: 'yahoo', category: 'commodities', symbol: 'HG=F', label: 'Copper' },
  CORN:   { type: 'yahoo', category: 'commodities', symbol: 'ZC=F', label: 'Corn' },
  // Metals
  GOLD:      { type: 'yahoo', category: 'metals', symbol: 'GC=F', label: 'Gold' },
  SILVER:    { type: 'yahoo', category: 'metals', symbol: 'SI=F', label: 'Silver' },
  PLATINUM:  { type: 'yahoo', category: 'metals', symbol: 'PL=F', label: 'Platinum' },
  PALLADIUM: { type: 'yahoo', category: 'metals', symbol: 'PA=F', label: 'Palladium' },
  // FX
  DXY:    { type: 'yahoo', category: 'fx', symbol: 'DX-Y.NYB',  label: 'US Dollar Index' },
  EURUSD: { type: 'yahoo', category: 'fx', symbol: 'EURUSD=X',  label: 'EUR/USD' },
  GBPUSD: { type: 'yahoo', category: 'fx', symbol: 'GBPUSD=X',  label: 'GBP/USD' },
  USDJPY: { type: 'yahoo', category: 'fx', symbol: 'USDJPY=X',  label: 'USD/JPY' },
};

async function fetchBinanceHistory(symbol) {
  const rows = [];
  let start = new Date('2017-01-01').getTime();
  const now = Date.now();
  let emptyStreak = 0;
  while (start < now) {
    const end = Math.min(start + 999 * 86400000, now);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${start}&endTime=${end}&limit=1000`;
    const data = await fetchJSON(url);
    if (!data.length) {
      emptyStreak++;
      if (emptyStreak > 3) break;
      start = end + 86400000;
      await new Promise(r => setTimeout(r, 200));
      continue;
    }
    emptyStreak = 0;
    for (const bar of data) rows.push({ ts: bar[0], close: parseFloat(bar[4]) });
    if (data.length < 1000) break;
    start = data[data.length - 1][0] + 86400000;
    await new Promise(r => setTimeout(r, 200));
  }
  return rows;
}

async function ensureYahooCrumb() {
  if (yahooCrumb && yahooCookie) return;
  const hdrs = { 'User-Agent': UA };
  const r1 = await fetch('https://fc.yahoo.com', { headers: hdrs, redirect: 'manual' });
  const sc = r1.headers.get('set-cookie') || '';
  yahooCookie = sc.split(';')[0];
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: yahooCookie },
  });
  if (!r2.ok) { yahooCrumb = null; yahooCookie = null; throw new Error('Yahoo crumb fetch failed: ' + r2.status); }
  yahooCrumb = await r2.text();
}

async function fetchYahooChart(symbol) {
  const hosts = ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'];
  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=max` + (yahooCrumb ? `&crumb=${encodeURIComponent(yahooCrumb)}` : '');
    const hd = { 'User-Agent': UA, Accept: 'application/json' };
    if (yahooCookie) hd.Cookie = yahooCookie;
    const res = await fetch(url, { headers: hd });
    if (res.ok) return res.json();
    if (res.status === 401 || res.status === 403) { yahooCrumb = null; yahooCookie = null; continue; }
    if (res.status === 429) continue;
  }
  return null;
}

async function fetchYahooHistory(symbol) {
  try { await ensureYahooCrumb(); } catch {}
  const d = await fetchYahooChart(symbol);
  if (!d) throw new Error(`Yahoo chart ${symbol}: all hosts failed`);
  const r = d.chart?.result?.[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] != null) rows.push({ ts: ts[i] * 1000, close: closes[i] });
  }
  return rows;
}

function computeYtdRoi(rows) {
  const byYear = {};
  for (const r of rows) {
    const dt = new Date(r.ts);
    const yr = dt.getUTCFullYear();
    if (!byYear[yr]) byYear[yr] = [];
    const start = new Date(Date.UTC(yr, 0, 1)).getTime();
    const doy = Math.floor((r.ts - start) / 86400000);
    byYear[yr].push({ doy: Math.min(doy, 365), close: r.close });
  }
  const years = {};
  for (const [yr, days] of Object.entries(byYear)) {
    if (days.length < 10) continue;
    const jan1 = days[0].close;
    const arr = new Array(366).fill(null);
    for (const d of days) arr[d.doy] = Math.round(((d.close / jan1) - 1) * 10000) / 10000;
    years[yr] = arr;
  }
  const currentYear = String(new Date().getUTCFullYear());
  const cycle = {
    election: [2012, 2016, 2020, 2024],
    postElection: [2013, 2017, 2021, 2025],
    midterm: [2014, 2018, 2022, 2026],
    preElection: [2011, 2015, 2019, 2023],
  };
  return { years, currentYear, cycle };
}

async function getYtdRoi(asset) {
  const key = 'ytd:' + asset;
  return cached(key, 3600, async () => {
    const cfg = ASSET_MAP[asset];
    if (!cfg) return null;
    let rows;
    if (cfg.binance) rows = await fetchBinanceHistory(cfg.binance);
    else if (cfg.yahoo) rows = await fetchYahooHistory(cfg.yahoo);
    else if (cfg.symbol) rows = await fetchYahooHistory(cfg.symbol);
    else return null;
    if (!rows.length) return null;
    return computeYtdRoi(rows);
  });
}

export function registerMarketRoutes(router) {
  router.get('/api/markets/fng', async (req, res) => {
    try { res.json(200, await getFearGreed()); }
    catch (e) { console.error('[markets] fng:', e.message); res.json(502, { error: 'fear & greed unavailable' }); }
  });
  router.get('/api/markets/earnings', async (req, res) => {
    try { res.json(200, { days: await getEarnings() }); }
    catch (e) { console.error('[markets] earnings:', e.message); res.json(502, { error: 'earnings unavailable' }); }
  });
  router.get('/api/markets/news', async (req, res) => {
    try { res.json(200, { articles: await getNews() }); }
    catch (e) { console.error('[markets] news:', e.message); res.json(502, { error: 'news unavailable' }); }
  });
  router.get('/api/markets/tradfi', async (req, res) => {
    try { res.json(200, await getTradFi()); }
    catch (e) { console.error('[markets] tradfi:', e.message); res.json(502, { error: 'tradfi unavailable' }); }
  });
  router.get('/api/markets/econ', async (req, res) => {
    try {
      const [week, key] = await Promise.allSettled([getEconWeek(), Promise.resolve(buildKeyDates())]);
      res.json(200, {
        week: week.status === 'fulfilled' ? week.value : [],
        keyDates: key.status === 'fulfilled' ? key.value : [],
      });
    } catch (e) { console.error('[markets] econ:', e.message); res.json(502, { error: 'calendar unavailable' }); }
  });

  router.get('/api/markets/ytd-roi', async (req, res) => {
    try {
      const qs = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      const asset = (qs.asset || 'BTC').toUpperCase();
      if (!ASSET_MAP[asset]) return res.json(400, { error: 'unknown asset', available: Object.keys(ASSET_MAP) });
      const data = await getYtdRoi(asset);
      if (!data) return res.json(502, { error: 'no data' });
      res.json(200, data);
    } catch (e) { console.error('[markets] ytd-roi:', e.message); res.json(502, { error: 'roi unavailable' }); }
  });

  router.get('/api/markets/supply-pl', async (req, res) => {
    try {
      const data = await cached('supply-pl', 86400, async () => {
        const url = 'https://chartinspect.com/api/onchain/profit-loss?timeframe=all&dataRange=all&fields=btc_price,btc_in_profit,btc_in_loss,percent_btc_in_profit,percent_btc_in_loss&isProUser=false';
        const r = await fetchJSON(url, { Referer: 'https://chartinspect.com/', Origin: 'https://chartinspect.com' });
        if (!r.success || !r.data) throw new Error('bad response');
        const ts = [], price = [], profit = [], loss = [], absProfit = [], absLoss = [];
        for (const d of r.data) {
          ts.push(d.timestamp);
          price.push(d.btc_price);
          profit.push(d.percent_btc_in_profit);
          loss.push(d.percent_btc_in_loss);
          absProfit.push(d.btc_in_profit);
          absLoss.push(d.btc_in_loss);
        }
        return { ts, price, profit, loss, absProfit, absLoss };
      });
      res.json(200, data);
    } catch (e) { console.error('[markets] supply-pl:', e.message); res.json(502, { error: 'supply data unavailable' }); }
  });

  router.get('/api/markets/assets', (req, res) => {
    const list = Object.entries(ASSET_MAP).map(([k, v]) => ({
      id: k, label: v.label || k, category: v.category || v.type,
      source: v.binance ? 'Binance' : 'Yahoo',
    }));
    res.json(200, { assets: list });
  });
}
