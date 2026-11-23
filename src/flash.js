// Macro Flash: read US CPI / PPI / jobs numbers straight from the BLS API the second they are published,
// compare them with the consensus forecast from the economic calendar, and push a ready-made headline to
// the website (and optionally a Telegram channel) within seconds.
//
// Why: the calendar feed is a second-hand copy that lands a minute or more after 08:30:00 ET.
// The BLS public API v2 is the primary source. With a free key it allows 500 queries/day; one release
// costs ~200 (1/s for two minutes, then every 10 s), so there is room for two releases a day.
//
// Env: BLS_API_KEY (required), FLASH_TG_CHAT (channel id/@name, optional),
//      FLASH_TG_BOT (bot token, defaults to TELEGRAM_BOT_TOKEN), FLASH_DRY_RUN=1 to log instead of sending.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const env = process.env;
const KEY = env.BLS_API_KEY || '';
const TG_CHAT = env.FLASH_TG_CHAT || '';
const TG_BOT = env.FLASH_TG_BOT || env.TELEGRAM_BOT_TOKEN || '';
const DRY = ['1', 'true', 'yes'].includes(String(env.FLASH_DRY_RUN || '').toLowerCase());
const STATE_FILE = path.join(config.dataDir, 'flash-state.json');
const BLS_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const DAILY_LIMIT = 450; // BLS allows 500 with a key; keep headroom
const DAYMS = 86400000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// One entry per scheduled release. Each line: calendar title it answers, BLS series, and how to compute it.
// mom/yoy = % change vs 1 / 12 months back (1 decimal, as BLS publishes); chg = net change; lvl = the value itself.
export const RELEASES = [
  {
    id: 'cpi', name: 'US CPI', kind: 'inflation', key: 'CUSR0000SA0',
    lines: [
      { label: 'CPI MoM', title: 'Inflation Rate MoM', s: 'CUSR0000SA0', calc: 'mom' },
      { label: 'CPI YoY', title: 'Inflation Rate YoY', s: 'CUUR0000SA0', calc: 'yoy' },
      { label: 'Core CPI MoM', title: 'Core Inflation Rate MoM', s: 'CUSR0000SA0L1E', calc: 'mom' },
      { label: 'Core CPI YoY', title: 'Core Inflation Rate YoY', s: 'CUUR0000SA0L1E', calc: 'yoy' },
    ],
  },
  {
    id: 'ppi', name: 'US PPI', kind: 'inflation', key: 'WPSFD4',
    lines: [
      { label: 'PPI MoM', title: 'PPI MoM', s: 'WPSFD4', calc: 'mom' },
      { label: 'PPI YoY', title: 'PPI YoY', s: 'WPUFD4', calc: 'yoy' },
      { label: 'Core PPI MoM', title: 'Core PPI MoM', s: 'WPSFD49104', calc: 'mom' },
      { label: 'Core PPI YoY', title: 'Core PPI YoY', s: 'WPUFD49104', calc: 'yoy' },
    ],
  },
  {
    id: 'jobs', name: 'US Jobs Report', kind: 'jobs', key: 'CES0000000001',
    lines: [
      { label: 'Nonfarm Payrolls', title: 'Non Farm Payrolls', s: 'CES0000000001', calc: 'chg', unit: 'K', sign: 1 },
      { label: 'Unemployment Rate', title: 'Unemployment Rate', s: 'LNS14000000', calc: 'lvl', sign: -1 },
      { label: 'Avg Hourly Earnings MoM', title: 'Average Hourly Earnings MoM', s: 'CES0500000003', calc: 'mom', sign: 0 },
      { label: 'Avg Hourly Earnings YoY', title: 'Average Hourly Earnings YoY', s: 'CES0500000003', calc: 'yoy', sign: 0 },
    ],
  },
];

// ---------- state ----------
let state = { sent: {}, items: [], quota: { day: '', used: 0 } };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
const save = () => {
  try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); }
  catch (e) { console.error('[flash] save:', e.message); }
};
const active = new Map(); // releaseKey -> true while a poller runs
let nextRelease = null; // { id, name, at }
const actuals = new Map(); // calendar event id -> { actual, at }

// ---------- BLS ----------
function quotaOk() {
  const day = new Date().toISOString().slice(0, 10);
  if (state.quota.day !== day) state.quota = { day, used: 0 };
  return state.quota.used < DAILY_LIMIT;
}
export async function blsFetch(seriesIds, year) {
  if (!quotaOk()) throw new Error('daily BLS quota reached');
  state.quota.used++;
  const res = await fetch(BLS_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(4000),
    body: JSON.stringify({ seriesid: seriesIds, startyear: String(year - 2), endyear: String(year), registrationkey: KEY }),
  });
  const d = await res.json();
  if (d.status !== 'REQUEST_SUCCEEDED') throw new Error('BLS: ' + (d.message || []).join('; '));
  const out = {};
  for (const s of d.Results.series) {
    out[s.seriesID] = s.data.filter(r => /^M(0[1-9]|1[0-2])$/.test(r.period) && r.value !== '-')
      .map(r => ({ y: +r.year, m: +r.period.slice(1), v: parseFloat(r.value) }))
      .sort((a, b) => b.y - a.y || b.m - a.m); // newest first
  }
  return out;
}
const round1 = x => Math.round(x * 10) / 10;
const back = (rows, y, m, n) => rows.find(r => r.y * 12 + r.m === y * 12 + m - n);
export function compute(line, rows, y, m) {
  const cur = back(rows, y, m, 0);
  if (!cur) return null;
  const ago = n => back(rows, y, m, n);
  if (line.calc === 'lvl') return cur.v;
  if (line.calc === 'chg') return ago(1) ? Math.round(cur.v - ago(1).v) : null;
  const base = ago(line.calc === 'mom' ? 1 : 12);
  return base ? round1((cur.v / base.v - 1) * 100) : null;
}

// ---------- headline ----------
const num = v => (v == null || v === '' || Number.isNaN(+v) ? null : +v);
function fmt(line, v) {
  if (v == null) return '—';
  if (line.unit === 'K') return (v > 0 ? '+' : '') + Math.round(v) + 'K';
  return (+v).toFixed(1) + '%';
}
// Calendar forecasts for payrolls come as raw counts or in thousands depending on the feed; normalise to thousands.
const toK = (line, v) => (line.unit === 'K' && v != null && Math.abs(v) >= 10000 ? v / 1000 : v);

export function buildFlash(rel, values, events, y, m) {
  const rows = rel.lines.map(line => {
    const ev = events.find(e => e.title === line.title);
    const actual = values[line.label];
    const forecast = toK(line, num(ev?.forecast)), previous = toK(line, num(ev?.previous));
    const diff = actual != null && forecast != null ? round1(actual - forecast) : null;
    return { ...line, actual, forecast, previous, diff, eventId: ev?.id || null };
  });
  // Overall verdict: inflation lines vote hotter/cooler; jobs lines vote stronger/weaker via their sign.
  let score = 0;
  for (const r of rows) if (r.diff) score += Math.sign(r.diff) * (rel.kind === 'jobs' ? (r.sign ?? 0) : 1);
  const verdict = rel.kind === 'jobs'
    ? (score > 0 ? 'STRONGER THAN EXPECTED' : score < 0 ? 'WEAKER THAN EXPECTED' : 'MIXED / IN LINE')
    : (score > 0 ? 'HOTTER THAN EXPECTED' : score < 0 ? 'COOLER THAN EXPECTED' : 'IN LINE WITH EXPECTATIONS');
  const tone = score === 0 ? 'neutral' : (rel.kind === 'jobs' ? (score > 0 ? 'hot' : 'cool') : (score > 0 ? 'hot' : 'cool'));
  const impact = rel.kind === 'jobs'
    ? { hot: 'Strong labour market = less room for rate cuts, usually a headwind for BTC and stocks.', cool: 'Weak labour data = more rate cuts priced in, usually supportive for BTC and stocks.', neutral: 'No surprise in the headline; watch the details and the first market reaction.' }[tone]
    : { hot: 'Hotter inflation = fewer rate cuts priced in, usually bearish for BTC and stocks.', cool: 'Cooler inflation = more rate cuts priced in, usually bullish for BTC and stocks.', neutral: 'No surprise in the headline; watch the details and the first market reaction.' }[tone];
  const mark = r => (r.diff == null ? '' : r.diff > 0 ? ' 🔺' : r.diff < 0 ? ' 🔻' : ' ＝');
  const text = [
    `🚨 ${rel.name} (${MONTHS[m - 1]} ${y}): ${verdict}`,
    '',
    ...rows.filter(r => r.actual != null).map(r => `${r.label}: ${fmt(r, r.actual)}` +
      (r.forecast != null ? ` (exp ${fmt(r, r.forecast)}` + (r.previous != null ? `, prev ${fmt(r, r.previous)})` : ')') : '') + mark(r)),
    '',
    (tone === 'hot' ? '🔴 ' : tone === 'cool' ? '🟢 ' : '⚪ ') + impact,
    'Source: U.S. Bureau of Labor Statistics',
  ].join('\n');
  return { id: rel.id, name: rel.name, period: `${MONTHS[m - 1]} ${y}`, verdict, tone, text, rows: rows.map(({ s, calc, sign, ...r }) => r) };
}

// ---------- delivery ----------
async function sendTelegram(text) {
  if (!TG_CHAT || !TG_BOT) return 'telegram off';
  if (DRY) { console.log('[flash] DRY RUN, would send to Telegram:\n' + text); return 'dry run'; }
  const res = await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.ok) throw new Error('Telegram: ' + (d.description || res.status));
  return 'sent';
}
async function publish(flash, releaseAt, sim = false) {
  const item = { ...flash, releaseAt, at: Date.now(), lagMs: Date.now() - releaseAt, ...(sim ? { test: true, verdict: 'TEST · ' + flash.verdict } : {}) };
  state.items = [item, ...state.items.filter(i => !(i.id === item.id && i.period === item.period))].slice(0, 20);
  if (!sim) state.sent[`${flash.id}:${flash.period}`] = item.at;
  if (!sim) for (const r of flash.rows) if (r.eventId && r.actual != null) actuals.set(r.eventId, { actual: r.actual, at: item.at });
  if (!sim) save(); // test items stay in memory only
  console.log(`[flash] ${flash.name} ${flash.period} detected ${(item.lagMs / 1000).toFixed(1)}s after release: ${flash.verdict}`);
  if (sim) { console.log('[flash] simulation: Telegram skipped'); return; }
  try { console.log('[flash] telegram:', await sendTelegram(flash.text)); } catch (e) { console.error('[flash]', e.message); }
}

// ---------- poller ----------
// The data month is always the month before the release month (CPI for October comes out in November).
function dataMonth(releaseAt) {
  const d = new Date(releaseAt);
  const m = d.getUTCMonth(); // 0-based release month == 1-based previous month
  return m === 0 ? { y: d.getUTCFullYear() - 1, m: 12 } : { y: d.getUTCFullYear(), m };
}
async function readRelease(rel, y, m) {
  const ids = [...new Set(rel.lines.map(l => l.s))];
  const data = await blsFetch(ids, y);
  const keyRows = data[rel.key] || [];
  if (!keyRows.length || keyRows[0].y !== y || keyRows[0].m !== m) return null; // not published yet
  const values = {};
  for (const line of rel.lines) values[line.label] = compute(line, data[line.s] || [], y, m);
  return values;
}
async function runPoller(rel, releaseAt, events, getEvents, sim = false) {
  const { y, m } = dataMonth(releaseAt);
  const tag = (sim ? 'sim:' : '') + `${rel.id}:${MONTHS[m - 1]} ${y}`;
  if (state.sent[tag] || active.has(tag)) return;
  active.set(tag, true);
  console.log(`[flash] armed ${rel.name} for ${MONTHS[m - 1]} ${y}, release ${new Date(releaseAt).toISOString()}`);
  try {
    while (Date.now() < releaseAt + 15 * 60000) {
      const wait = releaseAt - 2000 - Date.now();
      if (wait > 0) { await new Promise(r => setTimeout(r, Math.min(wait, 5000))); continue; }
      try {
        const values = await readRelease(rel, y, m);
        if (values) {
          // Refresh forecasts once more; they rarely change, but the cached copy may be minutes old.
          const evs = await getEvents().catch(() => events);
          return await publish(buildFlash(rel, values, evs.length ? evs : events, y, m), releaseAt, sim);
        }
      } catch (e) { console.error('[flash] poll:', e.message); if (/quota/.test(e.message)) return; }
      await new Promise(r => setTimeout(r, Date.now() < releaseAt + 120000 ? 1000 : 10000));
    }
    console.error(`[flash] ${tag}: no new data within 15 minutes, giving up`);
  } finally { active.delete(tag); }
}

// ---------- scheduler ----------
// getCalendar(from, to) comes from macro.js (cached TradingView economic calendar).
export function startFlash(getCalendar) {
  if (!KEY) { console.log('[flash] BLS_API_KEY not set, macro flash disabled'); return; }
  console.log(`[flash] enabled; telegram ${TG_CHAT && TG_BOT ? (DRY ? 'dry run' : 'on') : 'off'}`);
  const usEvents = async (from, to) => (await getCalendar(from, to)).filter(e => e.country === 'US');
  const tick = async () => {
    try {
      const now = Date.now();
      const evs = await usEvents(now - 20 * 60000, now + 8 * DAYMS);
      let next = null;
      for (const rel of RELEASES) {
        const mine = evs.filter(e => rel.lines.some(l => l.title === e.title));
        const times = [...new Set(mine.map(e => Date.parse(e.date)))].sort((a, b) => a - b);
        for (const at of times) {
          if (at > now && (!next || at < next.at)) next = { id: rel.id, name: rel.name, at };
          if (now >= at - 60000 && now <= at + 10 * 60000) {
            const group = mine.filter(e => Date.parse(e.date) === at);
            runPoller(rel, at, group, async () => (await usEvents(at - 3600000, at + 3600000)).filter(e => Date.parse(e.date) === at));
          }
        }
      }
      nextRelease = next;
    } catch (e) { console.error('[flash] schedule:', e.message); }
  };
  setTimeout(tick, 5000);
  // FLASH_SIMULATE=cpi|ppi|jobs: pretend that release happens 20 s after start, using the latest published
  // month and its real calendar forecasts. Shows a TEST banner on the site; never sends to Telegram.
  const sim = RELEASES.find(r => r.id === env.FLASH_SIMULATE);
  if (sim) {
    const at = Date.now() + 20000, { y, m } = dataMonth(at);
    const start = Date.UTC(m === 12 ? y + 1 : y, m % 12, 1);
    usEvents(start, start + 31 * DAYMS).then(evs => {
      const mine = evs.filter(e => sim.lines.some(l => l.title === e.title));
      const first = Math.min(...mine.map(e => Date.parse(e.date)));
      console.log(`[flash] SIMULATION of ${sim.name} at ${new Date(at).toISOString()}`);
      nextRelease = { id: sim.id, name: sim.name, at };
      runPoller(sim, at, mine.filter(e => Date.parse(e.date) === first), async () => mine.filter(e => Date.parse(e.date) === first), true);
    }).catch(e => console.error('[flash] simulate:', e.message));
  }
  setInterval(tick, 20000).unref();
}

// ---------- website ----------
// Fill calendar rows whose actual is still empty with the number we already read from BLS.
export function overlayActuals(events) {
  if (!actuals.size) return events;
  return events.map(e => (e.actual == null && actuals.has(e.id) ? { ...e, actual: actuals.get(e.id).actual, actualSource: 'BLS' } : e));
}
export function registerFlashRoutes(router) {
  router.get('/api/flash', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ next: nextRelease, live: active.size > 0, items: state.items.slice(0, 5), now: Date.now() }));
  });
}
