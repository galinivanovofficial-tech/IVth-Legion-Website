// Authentication: scrypt password hashing + HMAC (JWT-style) session cookies. Zero dependency.
import crypto from 'node:crypto';
import { config } from './config.js';
import { Users, Audit } from './db.js';

const COOKIE = 'legion_session';

// ---- Password hashing (scrypt) ----
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, 32);
  return `scrypt:${salt.toString('hex')}:${dk.toString('hex')}`;
}
export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split(':');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const dk = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(dk, expected);
  } catch { return false; }
}

// ---- Token (compact HMAC-signed, JWT-like) ----
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uJson = (obj) => b64u(JSON.stringify(obj));

export function signToken(payload, days = config.sessionDays) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + days * 86400 };
  const data = `${b64uJson({ alg: 'HS256', typ: 'JWT' })}.${b64uJson(body)}`;
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
export function verifyToken(token) {
  try {
    const [h, p, sig] = String(token).split('.');
    if (!h || !p || !sig) return null;
    const expected = crypto.createHmac('sha256', config.sessionSecret).update(`${h}.${p}`).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch { return null; }
}

export function setSession(res, user) {
  const token = signToken({ uid: user.id });
  const attrs = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${config.sessionDays * 86400}`,
  ];
  if (config.isProd) attrs.push('Secure');
  res.appendCookie(attrs.join('; '));
}
export function clearSession(res) {
  const attrs = [`${COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (config.isProd) attrs.push('Secure');
  res.appendCookie(attrs.join('; '));
}

export function currentUser(req) {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  return Users.byId(payload.uid);
}

export function requireAuth(req, res) {
  const user = currentUser(req);
  if (!user) { res.json(401, { error: 'Not authenticated' }); return null; }
  return user;
}

// ---- Simple in-memory rate limiter (per IP + bucket) ----
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const nowMs = Date.now();
  const arr = (buckets.get(key) || []).filter(t => nowMs - t < windowMs);
  arr.push(nowMs);
  buckets.set(key, arr);
  return arr.length <= max;
}
setInterval(() => { // prune
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, arr] of buckets) { const f = arr.filter(t => t > cutoff); if (f.length) buckets.set(k, f); else buckets.delete(k); }
}, 10 * 60 * 1000).unref();

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Public shape of a user (never leak the hash) ----
export function publicUser(u) {
  if (!u) return null;
  const active = ['active', 'trialing'].includes(u.subscription_status);
  const graceCutoff = Math.floor(Date.now() / 1000) - config.graceDays * 86400;
  const inGrace = u.subscription_status === 'past_due' && u.current_period_end > graceCutoff;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    telegram_username: u.telegram_username,
    telegram_joined: !!u.telegram_joined,
    subscription_status: u.subscription_status,
    current_period_end: u.current_period_end,
    cancel_at_period_end: !!u.cancel_at_period_end,
    hasAccess: active || inGrace,
    invite_link: (active || inGrace) ? u.invite_link : '',
  };
}

// ---- Routes ----
export function registerAuthRoutes(router) {
  router.post('/api/auth/register', (req, res) => {
    if (!rateLimit(`reg:${req.ip}`, 8, 60 * 60 * 1000)) return res.json(429, { error: 'Too many attempts. Try again later.' });
    const { email, password, name, telegram_username } = req.body || {};
    if (!emailRe.test(String(email || ''))) return res.json(400, { error: 'Enter a valid email address.' });
    if (String(password || '').length < 8) return res.json(400, { error: 'Password must be at least 8 characters.' });
    if (Users.byEmail(email)) return res.json(409, { error: 'An account with that email already exists. Please sign in.' });

    const role = config.adminEmail && email.toLowerCase() === config.adminEmail ? 'admin' : 'member';
    const user = Users.create({
      email, password_hash: hashPassword(password),
      name: String(name || '').slice(0, 120),
      telegram_username: String(telegram_username || '').replace(/^@/, '').slice(0, 64),
      role,
    });
    Audit.log(user.id, 'register');
    setSession(res, user);
    res.json(200, { user: publicUser(user) });
  });

  router.post('/api/auth/login', (req, res) => {
    if (!rateLimit(`login:${req.ip}`, 12, 15 * 60 * 1000)) return res.json(429, { error: 'Too many attempts. Try again later.' });
    const { email, password } = req.body || {};
    const user = Users.byEmail(email || '');
    if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
      return res.json(401, { error: 'Incorrect email or password.' });
    }
    Audit.log(user.id, 'login');
    setSession(res, user);
    res.json(200, { user: publicUser(user) });
  });

  router.post('/api/auth/logout', (req, res) => { clearSession(res); res.json(200, { ok: true }); });

  router.get('/api/me', (req, res) => {
    const user = currentUser(req);
    res.json(200, { user: publicUser(user) });
  });

  // Update profile (name + telegram handle)
  router.post('/api/me', (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    const { name, telegram_username } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = String(name).slice(0, 120);
    if (telegram_username !== undefined) patch.telegram_username = String(telegram_username).replace(/^@/, '').slice(0, 64);
    const updated = Users.update(user.id, patch);
    res.json(200, { user: publicUser(updated) });
  });
}
