// Configuration + tiny .env loader (zero dependency).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load .env (simple parser) if present. Real env vars always win.
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv();

const env = process.env;
const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(ROOT, 'data'),

  nodeEnv: env.NODE_ENV || 'development',
  isProd: (env.NODE_ENV || 'development') === 'production',
  port: parseInt(env.PORT || '3000', 10),
  // Public base URL of the site (used for Stripe redirects, invite emails). No trailing slash.
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),

  // Auth
  sessionSecret: env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  sessionDays: parseInt(env.SESSION_DAYS || '30', 10),

  // Stripe
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    priceId: env.STRIPE_PRICE_ID || '',                 // monthly price (price_...)
    priceIdYearly: env.STRIPE_PRICE_ID_YEARLY || '',    // yearly price (price_...)
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    get enabled() { return Boolean(this.secretKey && this.priceId); },
  },

  // Telegram
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    // Numeric chat id of the private group/supergroup, e.g. -1001234567890
    groupId: env.TELEGRAM_GROUP_ID || '',
    // Public @handle or t.me link shown as a fallback if invites can't be generated
    groupLink: env.TELEGRAM_GROUP_LINK || '',
    inviteHours: parseInt(env.TELEGRAM_INVITE_HOURS || '48', 10),
    get enabled() { return Boolean(this.botToken && this.groupId); },
  },

  // Membership
  price: {
    amount: env.PRICE_AMOUNT || '89',
    amountYearly: env.PRICE_AMOUNT_YEARLY || '799',
    currency: (env.PRICE_CURRENCY || 'EUR').toUpperCase(),
  },
  // Grace period (days) after a payment lapses before Telegram access is revoked.
  graceDays: parseInt(env.GRACE_DAYS || '3', 10),

  // First admin account (optional) — this email becomes role=admin on register/login.
  adminEmail: (env.ADMIN_EMAIL || '').toLowerCase(),

  seedTestUser: bool(env.SEED_TEST_USER, false),
};

export function configSummary() {
  return {
    nodeEnv: config.nodeEnv,
    baseUrl: config.baseUrl,
    stripe: config.stripe.enabled ? 'configured' : 'NOT configured (demo mode)',
    telegram: config.telegram.enabled ? 'configured' : 'NOT configured (demo mode)',
    price: `${config.price.amount} ${config.price.currency}/mo · ${config.price.amountYearly} ${config.price.currency}/yr`,
    graceDays: config.graceDays,
  };
}
