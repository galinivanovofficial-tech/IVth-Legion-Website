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

  CREATE TABLE IF NOT EXISTS audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT,
    action     TEXT,
    detail     TEXT,
    created_at INTEGER NOT NULL
  );
`);

const now = () => Math.floor(Date.now() / 1000);

// ---- Users ----
const cols = 'id,email,password_hash,name,telegram_username,role,stripe_customer_id,subscription_id,subscription_status,current_period_end,cancel_at_period_end,telegram_user_id,telegram_joined,invite_link,invite_expires,created_at,updated_at';

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
  // Members whose access has lapsed beyond the grace period but are still in the group.
  lapsedInGroup(graceCutoff) {
    return db.prepare(
      `SELECT ${cols} FROM users
       WHERE telegram_joined = 1
         AND subscription_status IN ('canceled','unpaid','past_due','none')
         AND (current_period_end = 0 OR current_period_end < ?)`
    ).all(graceCutoff);
  },
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
