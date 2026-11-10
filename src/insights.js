// Channel Insights (admin only): which assets and indicators the IVth Legion channel talks about, and how that
// changes week by week. Posts come from a one-time Telegram Desktop export (history) plus a bot that is an admin of
// the channel and receives every new post live (env INSIGHTS_BOT_TOKEN, optional INSIGHTS_CHANNEL = @name or id).
import { db } from './db.js';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { ASSETS, TAG_ALIAS, THEMES, AMBIGUOUS, INDICATORS, MA_VARIANT, maVariant } from './insights-dict.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS channel_posts (
    msg_id     INTEGER PRIMARY KEY,          -- Telegram message id in the tracked channel
    date       INTEGER NOT NULL,             -- unix seconds
    text       TEXT NOT NULL DEFAULT '',
    has_photo  INTEGER NOT NULL DEFAULT 0,
    source     TEXT NOT NULL,                -- export | bot
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_channel_posts_date ON channel_posts(date);
  CREATE TABLE IF NOT EXISTS insights_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);
const meta = {
  get: k => db.prepare('SELECT v FROM insights_meta WHERE k = ?').get(k)?.v ?? null,
  set: (k, v) => db.prepare('INSERT INTO insights_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v)),
};
const upsert = db.prepare(`INSERT INTO channel_posts (msg_id, date, text, has_photo, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(msg_id) DO UPDATE SET text = excluded.text, has_photo = MAX(has_photo, excluded.has_photo), updated_at = excluded.updated_at`);
let analysisCache = null;
export function savePost(p) {
  upsert.run(p.msgId, p.date, p.text || '', p.hasPhoto ? 1 : 0, p.source, Math.floor(Date.now() / 1000));
  analysisCache = null;
}

// ---------- Telegram Desktop export (messages.html) ----------
const MONTHS = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5, July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 };
const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
export function parseExport(html) {
  const out = [];
  for (const b of html.split(/(?=<div class="message )/)) {
    const id = b.match(/id="message(\d+)"/), title = b.match(/class="pull_right date details" title="([^"]+)"/);
    if (!id || !title) continue;
    // "7 January 2026, 17:10:09" (+ optional " UTC+03:00"): the export's local time; stored as UTC-ish, fine for weekly buckets
    const d = title[1].match(/(\d{1,2}) (\w+) (\d{4}), (\d{2}):(\d{2}):(\d{2})(?: UTC([+-]\d{2}):(\d{2}))?/);
    if (!d || MONTHS[d[2]] == null) continue;
    let ts = Date.UTC(+d[3], MONTHS[d[2]], +d[1], +d[4], +d[5], +d[6]) / 1000;
    if (d[7]) ts -= (+d[7]) * 3600 + Math.sign(+d[7] || 1) * (+d[8]) * 60;
    const tx = b.match(/<div class="text">([\s\S]*?)<\/div>\s*(?:<div|<\/div>\s*<\/div>)/);
    const text = tx ? unescape(tx[1].replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).trim() : '';
    const hasPhoto = /href="photos\//.test(b);
    if (!text && !hasPhoto) continue;
    out.push({ msgId: +id[1], date: Math.round(ts), text, hasPhoto, source: 'export' });
  }
  return out;
}
export function importExport(html) {
  const posts = parseExport(html);
  db.exec('BEGIN');
  try { for (const p of posts) savePost(p); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  meta.set('last_import', Date.now());
  return posts.length;
}

// ---------- what a post talks about ----------
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const assetPatterns = Object.entries(ASSETS).map(([sym, a]) => ({
  sym,
  re: [
    new RegExp(`[#$]${esc(sym)}\\b`, 'gi'),                                     // #BTC, $btc
    new RegExp(`(?<![\\w#$])${esc(sym)}(?![\\w])`, AMBIGUOUS.has(sym) ? 'g' : 'gi'), // BTC (ambiguous words only in CAPITALS)
    ...a.alias.map(al => new RegExp(`(?<![\\w])${esc(al)}(?![\\w])`, 'gi')),
  ],
}));
export function analysePost(text) {
  const hits = []; // { sym, pos }
  for (const t of text.matchAll(/#(\w+)/g)) {
    const tag = t[1].toUpperCase(), sym = TAG_ALIAS[tag] || tag;
    if (!THEMES.has(tag) && ASSETS[sym]) hits.push({ sym, pos: t.index });
  }
  for (const { sym, re } of assetPatterns) for (const r of re) for (const m of text.matchAll(r)) hits.push({ sym, pos: m.index });
  const assets = [...new Set(hits.map(h => h.sym))];
  const nearest = pos => hits.reduce((best, h) => (!best || Math.abs(h.pos - pos) < Math.abs(best.pos - pos) ? h : best), null)?.sym;
  const indicators = [], pairs = new Set(), variants = [];
  for (const [name, res] of INDICATORS) {
    let first = null;
    for (const r of res) { const m = text.match(r); if (m && (first == null || m.index < first)) first = m.index; }
    if (first == null) continue;
    indicators.push(name);
    if (assets.length === 1) pairs.add(assets[0] + '|' + name);
    else if (assets.length > 1) pairs.add(nearest(first) + '|' + name); // several assets: the one written closest to the indicator
  }
  for (const m of text.matchAll(MA_VARIANT)) variants.push(maVariant(m));
  return { assets, indicators, pairs: [...pairs], variants: [...new Set(variants)] };
}

// ---------- aggregate ----------
const WEEK = 7 * 86400;
const weekStart = ts => { const d = new Date(ts * 1000); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) / 1000; };
function analyse() {
  if (analysisCache) return analysisCache;
  const rows = db.prepare("SELECT msg_id, date, text FROM channel_posts WHERE text != '' ORDER BY date").all();
  const posts = rows.map(r => ({ id: r.msg_id, date: r.date, week: weekStart(r.date), ...analysePost(r.text) }));
  analysisCache = { posts, rows: new Map(rows.map(r => [r.msg_id, r])) };
  return analysisCache;
}
const top = (counter, n) => [...counter].sort((a, b) => b[1] - a[1]).slice(0, n);
function summary(weeksBack) {
  const { posts } = analyse();
  const now = Math.floor(Date.now() / 1000);
  const from = weeksBack ? weekStart(now) - (weeksBack - 1) * WEEK : 0;
  const sel = posts.filter(p => p.date >= from);
  const assetN = new Map(), indN = new Map(), pairN = new Map(), varN = new Map(), first = new Map(), last = new Map();
  for (const p of sel) {
    for (const a of p.assets) { assetN.set(a, (assetN.get(a) || 0) + 1); if (!first.has(a)) first.set(a, p.date); last.set(a, p.date); }
    for (const i of p.indicators) indN.set(i, (indN.get(i) || 0) + 1);
    for (const k of p.pairs) pairN.set(k, (pairN.get(k) || 0) + 1);
    for (const v of p.variants) varN.set(v, (varN.get(v) || 0) + 1);
  }
  const weeks = [];
  if (sel.length) for (let w = weekStart(sel[0].date); w <= weekStart(now); w += WEEK) weeks.push(w);
  const series = (key, names) => Object.fromEntries(names.map(n => [n, weeks.map(w => sel.filter(p => p.week === w && p[key].includes(n)).length)]));
  const topAssets = top(assetN, 40), topInds = top(indN, 40);
  const thisWeek = weekStart(now), lastWeek = thisWeek - WEEK;
  const weekStats = w => { const ps = sel.filter(p => p.week === w); const a = new Map(), i = new Map();
    for (const p of ps) { p.assets.forEach(x => a.set(x, (a.get(x) || 0) + 1)); p.indicators.forEach(x => i.set(x, (i.get(x) || 0) + 1)); }
    return { posts: ps.length, assets: top(a, 5), indicators: top(i, 5) }; };
  return {
    totals: { posts: sel.length, assets: assetN.size, indicators: indN.size, firstPost: sel[0]?.date || null, lastPost: sel.at(-1)?.date || null, allPosts: posts.length },
    assets: topAssets.map(([sym, n]) => ({ sym, cls: ASSETS[sym]?.cls || 'other', n, first: first.get(sym), last: last.get(sym) })),
    indicators: topInds.map(([name, n]) => ({ name, n })),
    variants: top(varN, 15).map(([name, n]) => ({ name, n })),
    pairs: top(pairN, 400).map(([k, n]) => { const [sym, ind] = k.split('|'); return { sym, ind, n }; }),
    weeks, assetSeries: series('assets', topAssets.slice(0, 8).map(a => a[0])), indicatorSeries: series('indicators', topInds.slice(0, 8).map(a => a[0])),
    thisWeek: weekStats(thisWeek), lastWeek: weekStats(lastWeek),
    bot: botStatus(),
  };
}
function postsFor({ asset, indicator, week, limit = 500 }) {
  const { posts, rows } = analyse();
  const link = meta.get('channel_link_id'); // internal id of a private channel, learned from the bot
  return posts.filter(p => (!asset || p.assets.includes(asset)) && (!indicator || p.indicators.includes(indicator))
      && (!asset || !indicator || p.pairs.includes(asset + '|' + indicator)) && (!week || p.week === +week))
    .slice(-limit).reverse()
    .map(p => ({ id: p.id, date: p.date, text: rows.get(p.id).text.slice(0, 600), assets: p.assets, indicators: p.indicators,
      url: link ? `https://t.me/c/${link}/${p.id}` : null }));
}

// ---------- live: bot that is an admin of the channel ----------
const bot = { running: false, username: null, lastPoll: 0, lastPost: 0, error: null, channel: null };
function botStatus() { return { configured: !!process.env.INSIGHTS_BOT_TOKEN, ...bot, lastImport: +meta.get('last_import') || null }; }
async function tg(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.INSIGHTS_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}), signal: AbortSignal.timeout(65000),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(d.description || `HTTP ${r.status}`);
  return d.result;
}
function channelWanted(chat) {
  const want = (process.env.INSIGHTS_CHANNEL || '').trim();
  if (!want) return true;
  return want === String(chat.id) || want.replace(/^@/, '').toLowerCase() === String(chat.username || '').toLowerCase();
}
async function pollLoop() {
  try { bot.username = (await tg('getMe')).username; } catch (e) { bot.error = 'Bot token rejected: ' + e.message; return; }
  bot.running = true;
  let offset = +meta.get('bot_offset') || 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['channel_post', 'edited_channel_post'] });
      bot.lastPoll = Date.now(); bot.error = null;
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.channel_post || u.edited_channel_post;
        if (!m || !channelWanted(m.chat)) continue;
        bot.channel = m.chat.title || m.chat.username || String(m.chat.id);
        const id = String(m.chat.id);
        if (id.startsWith('-100')) meta.set('channel_link_id', id.slice(4));
        savePost({ msgId: m.message_id, date: m.date, text: m.text || m.caption || '', hasPhoto: !!m.photo, source: 'bot' });
        bot.lastPost = Date.now();
      }
      if (updates.length) meta.set('bot_offset', offset);
    } catch (e) {
      bot.error = e.message;
      if (/terminated by other getUpdates|Conflict/i.test(e.message)) bot.error = 'Another program is reading this bot\'s updates. Use a dedicated bot.';
      await new Promise(r => setTimeout(r, 15000));
    }
  }
}
export function startInsights() {
  if (process.env.INSIGHTS_BOT_TOKEN) pollLoop().catch(e => { bot.error = e.message; bot.running = false; });
}

// ---------- routes (admins only) ----------
const isAdmin = u => u.role === 'admin' || (config.adminEmail && u.email.toLowerCase() === config.adminEmail);
function requireAdmin(req, res) {
  const u = requireAuth(req, res);
  if (!u) return null;
  if (!isAdmin(u)) { res.json(403, { error: 'Admins only.' }); return null; }
  return u;
}
export function registerInsightsRoutes(router) {
  router.get('/api/insights/summary', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const w = Number(new URL(req.url, 'http://x').searchParams.get('weeks')) || 0;
    res.json(200, summary([4, 12, 26, 52].includes(w) ? w : 0));
  });
  router.get('/api/insights/posts', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const q = new URL(req.url, 'http://x').searchParams;
    res.json(200, { posts: postsFor({ asset: q.get('asset') || '', indicator: q.get('indicator') || '', week: q.get('week') || '' }) });
  });
}
