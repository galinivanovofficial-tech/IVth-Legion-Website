// SQLite persistence via Node's built-in node:sqlite (zero dependency).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(`${config.dataDir}/legion.db`);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    email               TEXT UNIQUE NOT NULL,
    password_hash       TEXT NOT NULL,
    name                TEXT DEFAULT '',
    telegram_username   TEXT DEFAULT '',
    role                TEXT DEFAULT 'member',
    stripe_customer_id  TEXT DEFAULT '',
    subscription_id     TEXT DEFAULT '',
    subscription_status TEXT DEFAULT 'none',   -- none | active | trialing | past_due | canceled | unpaid
    current_period_end  INTEGER DEFAULT 0,     -- unix seconds
    cancel_at_period_end INTEGER DEFAULT 0,
    telegram_user_id    TEXT DEFAULT '',
    telegram_joined     INTEGER DEFAULT 0,
    invite_link         TEXT DEFAULT '',
    invite_expires      INTEGER DEFAULT 0,     -- unix seconds
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_customer ON users(stripe_customer_id);
  CREATE INDEX IF NOT EXISTS idx_users_tg ON users(telegram_user_id);

  CREATE TABLE IF NOT EXISTS processed_events (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Access codes handed out by the owner. Only the sha256 of the code is stored.
  CREATE TABLE IF NOT EXISTS access_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash  TEXT UNIQUE NOT NULL,
    hint       TEXT NOT NULL DEFAULT '',      -- last 4 characters, to recognise a code in lists
    plan       TEXT NOT NULL,                 -- vip | legion
    days       INTEGER NOT NULL,
    max_uses   INTEGER NOT NULL DEFAULT 1,    -- always 1: one code = one account
    uses       INTEGER NOT NULL DEFAULT 0,
    redeem_by  INTEGER NOT NULL DEFAULT 0,    -- unix seconds, 0 = no deadline
    note       TEXT NOT NULL DEFAULT '',
    revoked_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- Time-limited access per user (from a code or given by the admin). Stripe access is read from the subscription.
  CREATE TABLE IF NOT EXISTS grants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan       TEXT NOT NULL,
    source     TEXT NOT NULL,                 -- code | admin
    code_id    INTEGER REFERENCES access_codes(id),
    starts_at  INTEGER NOT NULL,
    ends_at    INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_grants_user ON grants(user_id, ends_at);
  -- a code can be redeemed once, by one account
  CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_code ON grants(code_id) WHERE code_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT,
    action     TEXT,
    detail     TEXT,
    created_at INTEGER NOT NULL
  );
`);

const now = () => Math.floor(Date.now() / 1000);

// Column added after launch: 1 when the Stripe subscription includes the website add-on.
if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'stripe_addon'").get()) {
  db.exec('ALTER TABLE users ADD COLUMN stripe_addon INTEGER DEFAULT 0');
}

// ---- Users ----
const cols = 'id,email,password_hash,name,telegram_username,role,stripe_customer_id,subscription_id,subscription_status,current_period_end,cancel_at_period_end,telegram_user_id,telegram_joined,invite_link,invite_expires,stripe_addon,created_at,updated_at';

export const Users = {
  create({ email, password_hash, name = '', telegram_username = '', role = 'member' }) {
    const id = crypto.randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO users (id,email,password_hash,name,telegram_username,role,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, email.toLowerCase(), password_hash, name, telegram_username, role, t, t);
    return this.byId(id);
  },
  byId(id) { return db.prepare(`SELECT ${cols} FROM users WHERE id = ?`).get(id) || null; },
  byEmail(email) { return db.prepare(`SELECT ${cols} FROM users WHERE email = ?`).get(String(email).toLowerCase()) || null; },
  // Sign-in accepts the email or the account name (only when exactly one account has that name).
  byLogin(login) {
    const v = String(login || '').trim();
    if (v.includes('@')) return this.byEmail(v);
    const rows = v ? db.prepare(`SELECT ${cols} FROM users WHERE lower(name) = lower(?)`).all(v) : [];
    return rows.length === 1 ? rows[0] : null;
  },
  byCustomer(cid) { return cid ? db.prepare(`SELECT ${cols} FROM users WHERE stripe_customer_id = ?`).get(cid) || null : null; },
  bySubscription(sid) { return sid ? db.prepare(`SELECT ${cols} FROM users WHERE subscription_id = ?`).get(sid) || null : null; },
  byTelegramUserId(tid) { return tid ? db.prepare(`SELECT ${cols} FROM users WHERE telegram_user_id = ?`).get(String(tid)) || null : null; },
  byInviteLink(link) { return link ? db.prepare(`SELECT ${cols} FROM users WHERE invite_link = ?`).get(link) || null : null; },
  all() { return db.prepare(`SELECT ${cols} FROM users ORDER BY created_at DESC`).all(); },
  count() { return db.prepare('SELECT COUNT(*) c FROM users').get().c; },
  update(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return this.byId(id);
    fields.updated_at = now();
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.keys(fields).map(k => fields[k]), id);
    return this.byId(id);
  },
  // Everyone currently in the Telegram group (the access job checks each one's rights).
  inGroup() { return db.prepare(`SELECT ${cols} FROM users WHERE telegram_joined = 1`).all(); },
};

// ---- Access codes ----
const codeCols = 'id,hint,plan,days,max_uses,uses,redeem_by,note,revoked_at,created_at';
export const Codes = {
  create({ code_hash, hint, plan, days, redeem_by = 0, note = '' }) {
    const r = db.prepare(`INSERT INTO access_codes (code_hash,hint,plan,days,max_uses,redeem_by,note,created_at) VALUES (?,?,?,?,1,?,?,?)`)
      .run(code_hash, hint, plan, days, redeem_by, note, now());
    return this.byId(Number(r.lastInsertRowid));
  },
  byId(id) { return db.prepare(`SELECT ${codeCols} FROM access_codes WHERE id = ?`).get(id) || null; },
  byHash(h) { return db.prepare(`SELECT ${codeCols} FROM access_codes WHERE code_hash = ?`).get(h) || null; },
  all() { return db.prepare(`SELECT ${codeCols} FROM access_codes ORDER BY id DESC`).all(); },
  // Atomic: only succeeds while uses < max_uses, so two people can't both take the last use.
  takeUse(id) { return db.prepare('UPDATE access_codes SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked_at = 0').run(id).changes === 1; },
  revoke(id) { return db.prepare('UPDATE access_codes SET revoked_at = ? WHERE id = ? AND revoked_at = 0').run(now(), id).changes === 1; },
};

// ---- Grants (time-limited access) ----
export const Grants = {
  create({ user_id, plan, source, code_id = null, starts_at, ends_at }) {
    db.prepare('INSERT INTO grants (user_id,plan,source,code_id,starts_at,ends_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(user_id, plan, source, code_id, starts_at, ends_at, now());
  },
  forUser(user_id) { return db.prepare('SELECT id,plan,source,code_id,starts_at,ends_at FROM grants WHERE user_id = ? ORDER BY ends_at DESC').all(user_id); },
};

// ---- Idempotency for webhooks ----
export const Events = {
  seen(id) { return Boolean(db.prepare('SELECT 1 FROM processed_events WHERE id = ?').get(id)); },
  mark(id) { try { db.prepare('INSERT INTO processed_events (id, created_at) VALUES (?, ?)').run(id, now()); } catch { /* dup */ } },
};

export const Audit = {
  log(user_id, action, detail = '') {
    db.prepare('INSERT INTO audit (user_id, action, detail, created_at) VALUES (?,?,?,?)').run(user_id || null, action, String(detail).slice(0, 500), now());
  },
};

export { db, now };
