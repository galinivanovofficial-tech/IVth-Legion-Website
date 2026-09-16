import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public');

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function fetchAllBitstamp() {
  const rows = [];
  let start = Math.floor(new Date('2011-01-01').getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  while (start < now) {
    const url = `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&start=${start}`;
    const d = await fetchJSON(url);
    const ohlc = d.data?.ohlc || [];
    if (!ohlc.length) break;
    for (const bar of ohlc) {
      const ts = Number(bar.timestamp);
      const close = parseFloat(bar.close);
      if (ts && close > 0 && ts >= 1293840000) rows.push({ ts, close });
    }
    start = Number(ohlc[ohlc.length - 1].timestamp) + 86400;
    await new Promise(r => setTimeout(r, 300));
  }
  const seen = new Set();
  return rows.filter(r => {
    const d = new Date(r.ts * 1000).toISOString().slice(0, 10);
    if (seen.has(d)) return false;
    seen.add(d); return true;
  }).sort((a, b) => a.ts - b.ts);
}

function dayOfYear(d) {
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

function buildRisk(rows) {
  const GENESIS = new Date('2009-01-03').getTime() / 1000;
  const SMA = 250, K = 0.5;
  const lnP = rows.map(r => Math.log(r.close));
  const sma = new Float64Array(rows.length);
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += lnP[i];
    if (i >= SMA) sum -= lnP[i - SMA];
    sma[i] = i >= SMA - 1 ? sum / SMA : NaN;
  }
  const raw = new Float64Array(rows.length);
  let rMin = Infinity, rMax = -Infinity;
  for (let i = SMA - 1; i < rows.length; i++) {
    const d = lnP[i] - sma[i];
    const ageDays = (rows[i].ts - GENESIS) / 86400;
    const r = (d >= 0 ? 1 : -1) * Math.pow(Math.abs(d), 1.0) * Math.pow(ageDays, K);
    raw[i] = r;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
  }
  const x = [], p = [], risk = [];
  for (let i = SMA - 1; i < rows.length; i++) {
    const dt = new Date(rows[i].ts * 1000);
    const yr = dt.getUTCFullYear() + (dt.getUTCMonth() + (dt.getUTCDate() - 1) / 30) / 12;
    x.push(Math.round(yr * 1000) / 1000);
    p.push(rows[i].close);
    risk.push(Math.round(((raw[i] - rMin) / (rMax - rMin)) * 10000) / 10000);
  }
  const latest = { price: p[p.length - 1], risk: risk[risk.length - 1], date: new Date(rows[rows.length - 1].ts * 1000).toISOString().slice(0, 10) };
  return { x, p, r: risk, latest };
}

function buildROI(rows) {
  const byYear = {};
  for (const r of rows) {
    const dt = new Date(r.ts * 1000);
    const yr = dt.getUTCFullYear();
    if (!byYear[yr]) byYear[yr] = [];
    byYear[yr].push({ doy: dayOfYear(dt), close: r.close });
  }
  const years = {};
  const currentYear = new Date().getUTCFullYear();
  for (const [yr, days] of Object.entries(byYear)) {
    if (days.length < 10) continue;
    const jan1 = days[0].close;
    const arr = new Array(366).fill(null);
    for (const d of days) arr[d.doy] = Math.round((d.close / jan1) * 10000) / 10000;
    years[yr] = arr;
  }
  const cycle = {
    election: [2012, 2016, 2020, 2024],
    postElection: [2013, 2017, 2021, 2025],
    midterm: [2014, 2018, 2022, 2026],
    preElection: [2011, 2015, 2019, 2023],
  };
  return { years, currentYear: String(currentYear), cycle };
}

async function buildFNG(priceRows) {
  const r = await fetchJSON('https://api.alternative.me/fng/?limit=0&format=json');
  const entries = (r.data || []).reverse();
  const priceMap = {};
  for (const row of priceRows) {
    const d = new Date(row.ts * 1000).toISOString().slice(0, 10);
    priceMap[d] = row.close;
  }
  const ts = [], values = [], prices = [];
  for (const e of entries) {
    const t = Number(e.timestamp);
    const d = new Date(t * 1000).toISOString().slice(0, 10);
    ts.push(t);
    values.push(Number(e.value));
    prices.push(priceMap[d] || null);
  }
  const last = entries[entries.length - 1];
  return {
    ts, values, prices,
    latest: { value: Number(last.value), cls: last.value_classification, date: new Date(Number(last.timestamp) * 1000).toISOString().slice(0, 10) }
  };
}

export async function refreshData() {
  console.log('[data] Fetching BTC daily data from Bitstamp...');
  const rows = await fetchAllBitstamp();
  console.log(`[data] Got ${rows.length} bars (${new Date(rows[0].ts * 1000).toISOString().slice(0, 10)} → ${new Date(rows[rows.length - 1].ts * 1000).toISOString().slice(0, 10)})`);

  const risk = buildRisk(rows);
  fs.writeFileSync(path.join(OUT, 'data-risk.js'),
    `window.LEGION_RISK=${JSON.stringify(risk)};\n`);
  console.log(`[data] data-risk.js updated — risk=${risk.latest.risk} @ ${risk.latest.date}`);

  const roi = buildROI(rows);
  fs.writeFileSync(path.join(OUT, 'data-roi.js'),
    `window.LEGION_ROI=${JSON.stringify(roi)};\n`);
  console.log(`[data] data-roi.js updated — years: ${Object.keys(roi.years).join(', ')}`);

  try {
    const fng = await buildFNG(rows);
    fs.writeFileSync(path.join(OUT, 'data-fng.js'),
      `window.LEGION_FNG=${JSON.stringify(fng)};\n`);
    console.log(`[data] data-fng.js updated — F&G=${fng.latest.value} (${fng.latest.cls})`);
  } catch (e) { console.log('[data] F&G fetch failed:', e.message); }

  console.log('[data] All data files refreshed');
}
