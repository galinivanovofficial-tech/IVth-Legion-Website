// Access model: three rights (telegram, website, education) that come from
//   - access codes (VIP 90 days, IVth Legion member 30 days), single use, one account per code
//   - Stripe: 89 EUR = telegram, +100 EUR add-on = website
//   - admins, and members created by legion-admin before codes existed (everything)
// Codes are stored only as sha256, the same idea as the customer tokens in Release Hub.
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, Users, Codes, Grants, Audit, now } from './db.js';
import { requireAuth, rateLimit, publicUser } from './auth.js';
import { ensureInvite } from './telegram.js';

export const RIGHTS = ['telegram', 'website', 'education'];
export const PLANS = {
  vip:    { label: 'VIP',                rights: ['telegram', 'website', 'education'], days: 90 },
  legion: { label: 'IVth Legion member', rights: ['telegram', 'website'],              days: 30 },
};
const STRIPE_RIGHTS = { base: ['telegram'], addon: ['website'] };
const FOREVER = 4102444800; // 2100-01-01, used for admins

const isAdmin = u => u.role === 'admin' || (config.adminEmail && u.email.toLowerCase() === config.adminEmail);

// What a user can use right now: { telegram: untilUnix|0, website, education, sources: [...], hadAccess }
export function accessOf(u) {
  const t = now(), out = { telegram: 0, website: 0, education: 0, sources: [], hadAccess: false };
  if (!u) return out;
  const give = (rights, until, source) => {
    if (until <= t) return;
    for (const r of rights) out[r] = Math.max(out[r], until);
    out.sources.push({ source, rights, until });
  };
  if (isAdmin(u)) give(RIGHTS, FOREVER, 'admin');

  const st = u.subscription_status;
  if (u.subscription_id) { // Stripe
    out.hadAccess = true;
    const rights = STRIPE_RIGHTS.base.concat(u.stripe_addon ? STRIPE_RIGHTS.addon : []);
    if (['active', 'trialing'].includes(st)) give(rights, Math.max(u.current_period_end, t + 3600), 'stripe');
    else if (st === 'past_due') give(rights, u.current_period_end + config.graceDays * 86400, 'stripe');
  } else if (['active', 'trialing'].includes(st)) { // set by hand (legion-admin --member, test accounts)
    out.hadAccess = true;
    give(RIGHTS, u.current_period_end || FOREVER, 'manual');
  }

  for (const g of Grants.forUser(u.id)) {
    out.hadAccess = true;
    if (g.starts_at <= t) give(PLANS[g.plan]?.rights || [], g.ends_at, g.plan);
  }
  return out;
}
export const hasRight = (u, right) => accessOf(u)[right] > now();

// Route guard: 401 when signed out, 403 when the account lacks the right.
const DENIED = {
  website: 'Your website access has ended. Enter a new code or upgrade to the website plan to continue.',
  education: 'The Academy is included in the VIP plan.',
  telegram: 'Telegram access is not active.',
};
export function requireRight(req, res, right) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!hasRight(user, right)) { res.json(403, { error: DENIED[right], right }); return null; }
  return user;
}

// ---- codes ----
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const hashCode = code => crypto.createHash('sha256').update(code).digest('hex');
const normalize = raw => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^LEGION/, '');
const pretty = body => 'LEGION-' + body.match(/.{4}/g).join('-');

export function createCode({ plan, note = '', redeemDays = 0 }) {
  if (!PLANS[plan]) throw new Error(`Unknown plan "${plan}". Use: ${Object.keys(PLANS).join(', ')}`);
  let body = '';
  for (const b of crypto.randomBytes(12)) body += ALPHABET[b % 32]; // 12 chars = 60 bits
  const code = pretty(body);
  const row = Codes.create({
    code_hash: hashCode(body), hint: body.slice(-4), plan, days: PLANS[plan].days,
    redeem_by: redeemDays ? now() + redeemDays * 86400 : 0, note: String(note).slice(0, 200),
  });
  Audit.log(null, 'code_created', `#${row.id} ${plan} ${note}`);
  return { code, row }; // the plain code is shown once and never stored
}

export function redeemCode(user, raw) {
  const body = normalize(raw);
  if (body.length !== 12) return { error: 'That code is not valid. Check it and try again.' };
  const c = Codes.byHash(hashCode(body));
  if (!c) return { error: 'That code is not valid. Check it and try again.' };
  if (c.revoked_at) return { error: 'This code has been cancelled.' };
  if (c.uses >= c.max_uses) return { error: 'This code has already been used.' };
  if (c.redeem_by && c.redeem_by < now()) return { error: 'This code has expired.' };

  // Redeeming the same plan again adds the days on top of what is left.
  const t = now();
  const current = Grants.forUser(user.id).filter(g => g.plan === c.plan && g.ends_at > t).reduce((m, g) => Math.max(m, g.ends_at), 0);
  const starts = Math.max(t, current), ends = starts + c.days * 86400;
  try {
    db.exec('BEGIN IMMEDIATE');
    if (!Codes.takeUse(c.id)) { db.exec('ROLLBACK'); return { error: 'This code has already been used.' }; }
    Grants.create({ user_id: user.id, plan: c.plan, source: 'code', code_id: c.id, starts_at: t, ends_at: ends });
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    if (/UNIQUE/.test(e.message)) return { error: 'This code has already been used.' };
    throw e;
  }
  Audit.log(user.id, 'code_redeemed', `#${c.id} ${c.plan} until ${new Date(ends * 1000).toISOString().slice(0, 10)}`);
  return { plan: c.plan, ends_at: ends };
}

export function registerAccessRoutes(router) {
  // The member's personal single-use Telegram invite. Reuses the stored link while it is valid and creates a new one
  // when it has expired or was never made (admins, hand-made members, links older than TELEGRAM_INVITE_HOURS).
  router.get('/api/telegram/invite', async (req, res) => {
    const user = requireRight(req, res, 'telegram'); if (!user) return;
    if (!rateLimit(`invite:${user.id}`, 20, 60 * 60 * 1000)) return res.json(429, { error: 'Too many requests. Try again later.' });
    const link = await ensureInvite(user).catch(e => { console.error('[access] invite:', e.message); return ''; });
    const fresh = Users.byId(user.id);
    res.json(200, { link, personal: !!link && link === fresh.invite_link, expires: fresh.invite_expires || 0 });
  });

  router.post('/api/access/redeem', async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!rateLimit(`redeem:${user.id}`, 5, 60 * 60 * 1000) || !rateLimit(`redeem-ip:${req.ip}`, 10, 60 * 60 * 1000)) {
      return res.json(429, { error: 'Too many attempts. Try again in an hour.' });
    }
    const r = redeemCode(user, req.body?.code);
    if (r.error) { Audit.log(user.id, 'code_rejected', r.error); return res.json(400, { error: r.error }); }
    const fresh = Users.byId(user.id);
    if (hasRight(fresh, 'telegram')) await ensureInvite(fresh).catch(e => console.error('[access] invite:', e.message));
    res.json(200, { plan: r.plan, label: PLANS[r.plan].label, ends_at: r.ends_at, user: publicUser(Users.byId(user.id)) });
  });
}
