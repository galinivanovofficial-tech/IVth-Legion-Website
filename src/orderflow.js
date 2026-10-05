// BTCUSDT perpetual order-flow recorder.
// Binance has no public historical footprint endpoint, so we keep a live aggTrade
// stream open and bucket every trade into 1-minute × $5 cells (bid = market sells,
// ask = market buys). Minutes the stream missed (downtime, sleep, reconnects) are
// backfilled from the aggTrades REST endpoint. Clients fetch this history, then
// continue live from their own socket.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';

const STREAM = 'wss://fstream.binance.com/market/ws/btcusdt@aggTrade';
const BASE_BIN = 5;
const RETENTION_MS = 48 * 3600e3;
const REST = 'https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&limit=1000';
const WEIGHT_BUDGET = 1000; // of Binance's 2400/min per-IP request weight
const SNAPSHOT_FILE = path.join(config.dataDir, 'orderflow-btcusdt.json');

const minutes = new Map(); // minuteStart -> Map(priceBin -> [bidQty, askQty])
const partial = new Set(); // minutes the stream didn't cover end-to-end (connect/disconnect/restart)
const minuteOf = ms => ms - (ms % 60000);
let lastId = 0;
let lastTime = 0;
let lastMsgAt = 0;
let ws = null;
let retry = 0;
let openedAt = 0;
let backfilling = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ingest(tr) {
  if (tr.a <= lastId) return;
  if (lastId && tr.a > lastId + 1) {
    for (let m = minuteOf(lastTime || tr.T); m <= tr.T; m += 60000) partial.add(m);
  }
  lastId = tr.a;
  lastTime = tr.T;
  const t = tr.T - (tr.T % 60000);
  let lv = minutes.get(t);
  if (!lv) minutes.set(t, (lv = new Map()));
  const bin = Math.floor(Number(tr.p) / BASE_BIN) * BASE_BIN;
  let cell = lv.get(bin);
  if (!cell) lv.set(bin, (cell = [0, 0]));
  cell[tr.m ? 0 : 1] += Number(tr.q);
}

function connect() {
  if (typeof WebSocket === 'undefined') {
    console.warn('[orderflow] global WebSocket unavailable — footprint history disabled');
    return;
  }
  const sock = new WebSocket(STREAM);
  ws = sock;
  sock.onopen = () => {
    retry = 0; lastMsgAt = Date.now(); openedAt = Date.now();
    partial.add(minuteOf(Date.now()));
    console.log('[orderflow] aggTrade stream connected');
  };
  sock.onmessage = ev => {
    lastMsgAt = Date.now();
    try { ingest(JSON.parse(ev.data)); } catch { /* malformed frame */ }
  };
  sock.onclose = ev => {
    console.warn(`[orderflow] stream closed (code ${ev.code}${ev.reason ? ', ' + ev.reason : ''}) after ${Math.round((Date.now() - openedAt) / 1000)}s`);
    partial.add(minuteOf(Date.now()));
    if (lastMsgAt) partial.add(minuteOf(lastMsgAt));
    if (ws === sock) ws = null;
    setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
  };
  sock.onerror = ev => {
    console.warn('[orderflow] stream error:', ev.message || ev.error?.message || 'unknown'); try { sock.close(); } catch { /* already closed */ } };
}

async function fetchTrades(url) {
  const res = await fetch(url);
  if (res.status === 429 || res.status === 418) throw new Error('rate limited (HTTP ' + res.status + ')');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return { rows: await res.json(), used: Number(res.headers.get('x-mbx-used-weight-1m')) || 0 };
}

async function backfillMinute(t) {
  const lv = new Map();
  let url = `${REST}&startTime=${t}&endTime=${t + 59999}`;
  let used = 0;
  for (;;) {
    const r = await fetchTrades(url);
    used = r.used;
    let done = r.rows.length < 1000;
    for (const tr of r.rows) {
      if (tr.T >= t + 60000) { done = true; break; }
      const bin = Math.floor(Number(tr.p) / BASE_BIN) * BASE_BIN;
      let cell = lv.get(bin);
      if (!cell) lv.set(bin, (cell = [0, 0]));
      cell[tr.m ? 0 : 1] += Number(tr.q);
    }
    if (done) break;
    url = `${REST}&fromId=${r.rows[r.rows.length - 1].a + 1}`;
    if (used > WEIGHT_BUDGET) await sleep(61000 - (Date.now() % 60000));
  }
  minutes.set(t, lv);
  partial.delete(t);
  return used;
}

// Re-scanned every step so a fresh gap (reconnect, restart) jumps ahead of older ones.
function newestGap() {
  const oldest = minuteOf(Date.now() - RETENTION_MS) + 60000;
  for (let t = minuteOf(Date.now()) - 120000; t >= oldest; t -= 60000) {
    if (!minutes.has(t) || partial.has(t)) return t;
  }
  return null;
}

// Newest gaps first, so the candles people are looking at fill in quickest.
async function backfill() {
  if (backfilling) return;
  backfilling = true;
  let filled = 0;
  try {
    for (;;) {
      const t = newestGap();
      if (t == null) break;
      const used = await backfillMinute(t);
      filled++;
      await sleep(used > WEIGHT_BUDGET ? 61000 - (Date.now() % 60000) : 200);
    }
  } catch (e) {
    console.warn('[orderflow] backfill paused:', e.message);
  } finally {
    backfilling = false;
    if (filled) console.log(`[orderflow] backfilled ${filled} minutes from REST`);
  }
}

function serializeMinute(lv) {
  const out = [];
  for (const [p, c] of lv) out.push([p, Math.round(c[0] * 1000) / 1000, Math.round(c[1] * 1000) / 1000]);
  return out;
}

function prune() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const t of minutes.keys()) if (t < cutoff) minutes.delete(t);
  for (const t of partial) if (t < cutoff) partial.delete(t);
}

function saveSnapshot() {
  try {
    const data = JSON.stringify({ lastId, lastTime, partial: [...partial], minutes: [...minutes].map(([t, lv]) => [t, serializeMinute(lv)]) });
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE + '.tmp', data);
    fs.renameSync(SNAPSHOT_FILE + '.tmp', SNAPSHOT_FILE);
  } catch (e) {
    console.error('[orderflow] snapshot save failed:', e.message);
  }
}

function loadSnapshot() {
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    const cutoff = Date.now() - RETENTION_MS;
    for (const [t, rows] of snap.minutes || []) {
      if (t < cutoff) continue;
      minutes.set(t, new Map(rows.map(([p, b, a]) => [p, [b, a]])));
    }
    for (const t of snap.partial || []) if (t >= cutoff) partial.add(t);
    // The snapshot was taken mid-minute, so its final minute is incomplete.
    if (snap.lastTime) partial.add(minuteOf(snap.lastTime));
    lastId = snap.lastId || 0;
    lastTime = snap.lastTime || 0;
    console.log(`[orderflow] restored ${minutes.size} minutes of footprint history`);
  } catch { /* no snapshot yet */ }
}

export function startOrderflow() {
  loadSnapshot();
  connect();
  setInterval(() => {
    // Binance occasionally leaves a socket open but silent; force a reconnect.
    if (ws && ws.readyState === 1 && Date.now() - lastMsgAt > 60000) ws.close();
  }, 15000);
  setTimeout(backfill, 5000);
  setInterval(backfill, 60000);
  setInterval(prune, 10 * 60e3);
  setInterval(saveSnapshot, 5 * 60e3);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => { saveSnapshot(); process.exit(0); });
  }
}

// OKX taker buy/sell volume (USD) for the multi-venue CVD. OKX doesn't send CORS headers on this
// endpoint, so the browser reads it through here. Cached briefly; rows are [ts, sellUsd, buyUsd].
const OKX_PERIODS = { '5m': 4, '15m': 4, '1H': 1 }; // pages of 100 the feed will serve per period
const okxCache = new Map();
async function okxTaker(period, recent) {
  const key = period + (recent ? ':r' : '');
  const hit = okxCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.rows;
  const rows = [];
  let end = '';
  for (let p = 0; p < (recent ? 1 : OKX_PERIODS[period]); p++) {
    const r = await fetch(`https://www.okx.com/api/v5/rubik/stat/taker-volume-contract?instId=BTC-USDT-SWAP&period=${period}&unit=2&limit=${recent ? 3 : 100}${end ? '&end=' + end : ''}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('OKX HTTP ' + r.status);
    const d = (await r.json()).data || [];
    if (!d.length) break;
    rows.push(...d.map(x => [+x[0], +x[1], +x[2]]));
    end = d[d.length - 1][0];
  }
  okxCache.set(key, { exp: Date.now() + (recent ? 15000 : 60000), rows });
  return rows;
}

export function registerOrderflowRoutes(router) {
  router.get('/api/orderflow/okx-taker', async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const period = u.searchParams.get('period');
    if (!OKX_PERIODS[period]) return res.json(400, { error: 'period must be 5m, 15m or 1H' });
    try { res.json(200, { rows: await okxTaker(period, u.searchParams.get('recent') === '1') }); }
    catch (e) { res.json(502, { error: 'OKX unavailable: ' + e.message }); }
  });
  router.get('/api/orderflow/footprint', (req, res) => {
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
    const out = [];
    let start = 0;
    for (const [t, lv] of minutes) {
      if (!start || t < start) start = t;
      if (t >= since) out.push([t, serializeMinute(lv)]);
    }
    out.sort((a, b) => a[0] - b[0]);
    const body = JSON.stringify({
      symbol: 'BTCUSDT', baseBin: BASE_BIN, start, lastId, lastTime,
      partial: [...partial].filter(t => t >= since),
      live: !!ws && ws.readyState === 1, minutes: out,
    });
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(gzip ? zlib.gzipSync(body) : body);
  });
}
