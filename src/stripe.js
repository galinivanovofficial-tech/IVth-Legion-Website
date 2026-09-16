// Stripe billing via REST (zero dependency): Checkout, Customer Portal, signed webhooks.
import crypto from 'node:crypto';
import { config } from './config.js';
import { Users, Events, Audit, now } from './db.js';
import { requireAuth, publicUser } from './auth.js';
import { ensureInvite, removeMember } from './telegram.js';

const S = config.stripe;

// Form-encode nested params the way Stripe expects (a[b]=c).
function encode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) encode(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? encode(item, `${key}[${i}]`, out) : out.push(`${key}[${i}]=${encodeURIComponent(item)}`)));
    else out.push(`${key}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function api(method, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${S.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? encode(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe ${path} ${res.status}`);
  return data;
}

async function ensureCustomer(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const cust = await api('POST', 'customers', { email: user.email, name: user.name || undefined, metadata: { uid: user.id } });
  Users.update(user.id, { stripe_customer_id: cust.id });
  return cust.id;
}

// Map Stripe subscription -> our user record.
async function applySubscription(sub) {
  let user = Users.bySubscription(sub.id) || Users.byCustomer(sub.customer);
  if (!user && sub.metadata?.uid) user = Users.byId(sub.metadata.uid);
  if (!user) { console.warn('[stripe] no user for subscription', sub.id); return; }

  const patch = {
    stripe_customer_id: sub.customer,
    subscription_id: sub.id,
    subscription_status: sub.status,
    current_period_end: sub.current_period_end || 0,
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
  };
  const updated = Users.update(user.id, patch);
  Audit.log(user.id, 'subscription_' + sub.status);

  const active = ['active', 'trialing'].includes(sub.status);
  if (active) {
    await ensureInvite(updated).catch(e => console.error(e.message));
  } else if (['canceled', 'unpaid'].includes(sub.status)) {
    await removeMember(updated, 'subscription_' + sub.status).catch(e => console.error(e.message));
  }
}

// ---- Webhook signature verification (Stripe scheme) ----
export function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(v1), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  // 5-minute tolerance against replay.
  return Math.abs(now() - parseInt(t, 10)) < 300;
}

export function registerBillingRoutes(router) {
  // Start a subscription checkout.
  router.post('/api/billing/checkout', async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!S.enabled) return res.json(503, { error: 'Payments are not configured yet.' });
    if (['active', 'trialing'].includes(user.subscription_status)) return res.json(400, { error: 'You already have an active membership.' });
    const plan = req.body?.plan === 'yearly' ? 'yearly' : 'monthly';
    const priceId = plan === 'yearly' ? (S.priceIdYearly || S.priceId) : S.priceId;
    try {
      const customer = await ensureCustomer(user);
      const session = await api('POST', 'checkout/sessions', {
        mode: 'subscription',
        customer,
        line_items: [{ price: priceId, quantity: 1 }],
        allow_promotion_codes: true,
        client_reference_id: user.id,
        subscription_data: { metadata: { uid: user.id } },
        success_url: `${config.baseUrl}/dashboard.html?checkout=success`,
        cancel_url: `${config.baseUrl}/subscribe.html?checkout=cancelled`,
      });
      res.json(200, { url: session.url });
    } catch (e) {
      console.error('[stripe] checkout:', e.message);
      res.json(500, { error: 'Could not start checkout. Please try again.' });
    }
  });

  // Open the Stripe Customer Portal (update card, cancel, invoices).
  router.post('/api/billing/portal', async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!S.enabled || !user.stripe_customer_id) return res.json(400, { error: 'No billing account found.' });
    try {
      const session = await api('POST', 'billing_portal/sessions', {
        customer: user.stripe_customer_id,
        return_url: `${config.baseUrl}/dashboard.html`,
      });
      res.json(200, { url: session.url });
    } catch (e) {
      console.error('[stripe] portal:', e.message);
      res.json(500, { error: 'Could not open the billing portal.' });
    }
  });

  // Stripe webhook — receives raw body (see index.js).
  router.post('/api/billing/webhook', async (req, res) => {
    if (!S.webhookSecret) return res.json(503, { error: 'Webhook not configured' });
    if (!verifySignature(req.rawBody, req.headers['stripe-signature'], S.webhookSecret)) {
      return res.json(400, { error: 'Invalid signature' });
    }
    let event;
    try { event = JSON.parse(req.rawBody); } catch { return res.json(400, { error: 'Bad payload' }); }
    if (Events.seen(event.id)) return res.json(200, { received: true, duplicate: true });
    Events.mark(event.id);

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const s = event.data.object;
          if (s.subscription) {
            const sub = await api('GET', `subscriptions/${s.subscription}`);
            await applySubscription(sub);
          }
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          await applySubscription(event.data.object);
          break;
        case 'invoice.paid': {
          const inv = event.data.object;
          if (inv.subscription) { const sub = await api('GET', `subscriptions/${inv.subscription}`); await applySubscription(sub); }
          break;
        }
        case 'invoice.payment_failed': {
          const inv = event.data.object;
          const user = Users.byCustomer(inv.customer);
          if (user) { Users.update(user.id, { subscription_status: 'past_due' }); Audit.log(user.id, 'payment_failed'); }
          break;
        }
        default: break;
      }
    } catch (e) {
      console.error('[stripe] webhook handler:', e.message);
      return res.json(500, { error: 'handler error' });
    }
    res.json(200, { received: true });
  });
}

export { api as stripeApi };
