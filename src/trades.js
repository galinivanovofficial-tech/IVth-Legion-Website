// Trade Result Tracker: each member's own trade journal (entries, closes, confluences).
// Analytics are computed client-side from the member's trades.
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, now } from './db.js';
import { requireAuth, publicUser } from './auth.js';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W'];
const MAX_TRADES = 5000;

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    direction   TEXT NOT NULL,            -- long | short
    timeframe   TEXT NOT NULL,
    entry       REAL NOT NULL,
    stop        REAL,
    target      REAL,
    entry_at    INTEGER NOT NULL,         -- unix ms
    close_price REAL,
    closed_at   INTEGER,                  -- unix ms
    confluences TEXT NOT NULL DEFAULT '[]',
    notes       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, entry_at);
`);

const isAdmin = u => u.role === 'admin' || (config.adminEmail && u.email.toLowerCase() === config.adminEmail);
function requireMember(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!publicUser(user).hasAccess && !isAdmin(user)) { res.json(403, { error: 'An active membership is required.' }); return null; }
  return user;
}

const num = v => (v === '' || v == null ? null : Number(v));
const positive = v => v != null && Number.isFinite(v) && v > 0;

// Returns [row, error]. Optional fields may be blank; a close price makes the trade closed.
function validate(b) {
  const symbol = String(b.symbol || '').trim().toUpperCase().slice(0, 20);
  if (!/^[A-Z0-9.:/_-]{1,20}$/.test(symbol)) return [null, 'Enter a valid symbol, e.g. BTCUSDT'];
  if (!['long', 'short'].includes(b.direction)) return [null, 'Choose Long or Short'];
  if (!TIMEFRAMES.includes(b.timeframe)) return [null, 'Choose a timeframe'];
  const entry = num(b.entry), stop = num(b.stop), target = num(b.target), close = num(b.close_price);
  if (!positive(entry)) return [null, 'Entry price must be a positive number'];
  for (const [v, name] of [[stop, 'Stop loss'], [target, 'Take profit'], [close, 'Close price']]) {
    if (v != null && !positive(v)) return [null, `${name} must be a positive number`];
  }
  if (stop != null && (b.direction === 'long' ? stop >= entry : stop <= entry)) return [null, `Stop loss must be ${b.direction === 'long' ? 'below' : 'above'} entry for a ${b.direction}`];
  const entryAt = Number(b.entry_at) || Date.now();
  const closedAt = close != null ? Number(b.closed_at) || Date.now() : null;
  if (closedAt != null && closedAt < entryAt) return [null, 'Close time cannot be before entry time'];
  const conf = Array.isArray(b.confluences) ? [...new Set(b.confluences.map(c => String(c).trim().slice(0, 60)).filter(Boolean))].slice(0, 40) : [];
  return [{
    symbol, direction: b.direction, timeframe: b.timeframe, entry, stop, target,
    entry_at: entryAt, close_price: close, closed_at: closedAt,
    confluences: JSON.stringify(conf), notes: String(b.notes || '').slice(0, 2000),
  }, null];
}

const out = r => ({ ...r, confluences: JSON.parse(r.confluences) });

export function registerTradeRoutes(router) {
  router.get('/api/trades', (req, res) => {
    const user = requireMember(req, res); if (!user) return;
    const rows = db.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY entry_at DESC').all(user.id);
    res.json(200, { trades: rows.map(out), timeframes: TIMEFRAMES });
  });

  router.post('/api/trades', (req, res) => {
    const user = requireMember(req, res); if (!user) return;
    const count = db.prepare('SELECT COUNT(*) AS n FROM trades WHERE user_id = ?').get(user.id).n;
    if (count >= MAX_TRADES) return res.json(400, { error: 'Trade limit reached' });
    const [row, err] = validate(req.body || {});
    if (err) return res.json(400, { error: err });
    const id = crypto.randomUUID(), t = now();
    db.prepare(`INSERT INTO trades (id, user_id, symbol, direction, timeframe, entry, stop, target, entry_at, close_price, closed_at, confluences, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, user.id, row.symbol, row.direction, row.timeframe, row.entry, row.stop, row.target, row.entry_at, row.close_price, row.closed_at, row.confluences, row.notes, t, t);
    res.json(200, { trade: out(db.prepare('SELECT * FROM trades WHERE id = ?').get(id)) });
  });

  router.post('/api/trades/update', (req, res) => {
    const user = requireMember(req, res); if (!user) return;
    const b = req.body || {};
    const existing = db.prepare('SELECT * FROM trades WHERE id = ? AND user_id = ?').get(String(b.id || ''), user.id);
    if (!existing) return res.json(404, { error: 'Trade not found' });
    const [row, err] = validate({ ...out(existing), ...b });
    if (err) return res.json(400, { error: err });
    db.prepare(`UPDATE trades SET symbol = ?, direction = ?, timeframe = ?, entry = ?, stop = ?, target = ?, entry_at = ?, close_price = ?, closed_at = ?, confluences = ?, notes = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`).run(row.symbol, row.direction, row.timeframe, row.entry, row.stop, row.target, row.entry_at, row.close_price, row.closed_at, row.confluences, row.notes, now(), existing.id, user.id);
    res.json(200, { trade: out(db.prepare('SELECT * FROM trades WHERE id = ?').get(existing.id)) });
  });

  router.post('/api/trades/delete', (req, res) => {
    const user = requireMember(req, res); if (!user) return;
    const r = db.prepare('DELETE FROM trades WHERE id = ? AND user_id = ?').run(String((req.body || {}).id || ''), user.id);
    if (!r.changes) return res.json(404, { error: 'Trade not found' });
    res.json(200, { ok: true });
  });
}
