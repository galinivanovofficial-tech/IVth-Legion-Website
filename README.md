# IVth Legion — Membership Platform

A complete, self-hosted membership website for the IVth Legion Telegram community.
Members register on your site, subscribe (**€89/month or €799/year** via Stripe), and are
**automatically granted access** to your private Telegram group. When a subscription
lapses, access is **automatically revoked**. Your brand, your bot, zero platform fees.

Built as a **zero-dependency Node.js app** — nothing to `npm install`, no build step,
no native modules. It runs anywhere Node 22 is available.

---

## What it does

- **Cinematic marketing site** (`/`) — the animated portal front page.
- **Accounts** — register / sign in with email + password (scrypt-hashed, signed session cookies).
- **Subscriptions** — Stripe Checkout for €89/month or €799/year (member picks the plan), Stripe Customer Portal for card updates & cancellation.
- **Automated Telegram access**
  - On payment: a **single-use, 48-hour invite link** is generated for that member.
  - On join: the member is matched to their link; **leaked/shared links are auto-kicked**.
  - On cancel / failed payment (after a grace period): the member is **removed** from the group.
- **Member dashboard** (`/dashboard.html`) — gated to active subscribers: news, charts, signals, macro indicators, education, Telegram access, billing management.
- **Security** — session cookies (HttpOnly, SameSite, Secure in prod), rate-limited auth, signed & replay-protected Stripe webhooks, security headers, path-traversal-safe static serving.

## How it compares

| | Whop | InviteMember / bots | **This (IVth Legion)** |
|---|---|---|---|
| Platform fee on top of Stripe | ~3% | varies | **0%** |
| Your own brand + domain | partial | bot only | **full site + dashboard** |
| Full member website & dashboard | no | no | **yes** |
| Buyer stays on your domain | no | n/a | **yes** |
| You own the code & data | no | no | **yes** |

---

## Run it locally (2 minutes)

Requires **Node.js 22.5+** ([nodejs.org](https://nodejs.org)).

```bash
cd app
cp .env.example .env          # then edit .env (at minimum set SESSION_SECRET)
npm start                     # or: node --disable-warning=ExperimentalWarning src/index.js
```

Open <http://localhost:3000>. With no Stripe/Telegram keys it runs in **demo mode**:
you can register, sign in, and browse — the "Subscribe" button will report that payments
aren't configured yet. Add the keys below to make it fully live.

Generate a session secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Go live — full checklist

### 1. Stripe (payments)
1. Create an account at [stripe.com](https://stripe.com).
2. **Product** → add product "Legion Membership", price **€89 / month, recurring**. Copy the **price id** (`price_...`) → `STRIPE_PRICE_ID`. Add a second price **€799 / year, recurring** on the same product → `STRIPE_PRICE_ID_YEARLY`.
3. **Developers → API keys** → copy the **Secret key** (`sk_...`) → `STRIPE_SECRET_KEY`.
4. **Developers → Webhooks → Add endpoint**:
   - URL: `https://fourthlegion.com/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
   - Copy the **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.
5. In **Customer Portal settings**, enable "cancel subscription" and "update payment method".

Test with Stripe **test mode** first (test card `4242 4242 4242 4242`, any future date/CVC).

### 2. Telegram (automated access)
1. In Telegram, message **@BotFather** → `/newbot` → choose a name + username → copy the **token** → `TELEGRAM_BOT_TOKEN`.
2. Create your private **group** (make it a supergroup: enable "Chat history for new members" or add >1 member). Add your bot as an **admin** with **Invite Users via Link** and **Ban Users** permissions.
3. Get the group's **numeric id**: temporarily add **@RawDataBot** to the group (or call `https://api.telegram.org/bot<token>/getUpdates` and read `chat.id`). It looks like `-1001234567890` → `TELEGRAM_GROUP_ID`.
4. (Optional) A public fallback invite link → `TELEGRAM_GROUP_LINK`.

> The bot must have **"Manage / see members"** enabled so it receives join events (needed for the leaked-link guard). In BotFather: `/mybots → Bot Settings → Group Privacy → Turn OFF`, then re-add the bot as admin.

### 3. Domain + hosting
Buy **fourthlegion.com** at any registrar. Deploy the `app/` folder to any Node host:

**Render (recommended — `render.yaml` included):**
1. Push this project to GitHub.
2. Render → New → Blueprint → pick the repo (it reads `app/render.yaml`).
3. Set the secret env vars (Stripe + Telegram + `BASE_URL=https://fourthlegion.com`).
4. Point your domain's DNS at the Render service.

**Any other host (Railway, Fly.io, a VPS):** run `node src/index.js` from `app/` with the env vars set, put it behind HTTPS, and set `NODE_ENV=production` + `BASE_URL=https://fourthlegion.com`. Use a **persistent disk** for `DATA_DIR` so the member database survives restarts.

### 4. First admin
Set `ADMIN_EMAIL` to your email before you register — that account gets the `admin` role.

---

## Environment variables

See [`.env.example`](./.env.example) for the annotated list. The essentials:

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes | Signs login sessions (use a long random string) |
| `BASE_URL` | yes (prod) | Your public URL, e.g. `https://fourthlegion.com` |
| `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` / `STRIPE_PRICE_ID_YEARLY` / `STRIPE_WEBHOOK_SECRET` | for payments | Stripe subscription billing (monthly + yearly) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_GROUP_ID` | for auto-access | Telegram automation |
| `GRACE_DAYS` | no (default 3) | Days before revoking access after a lapse |
| `DATA_DIR` | no (default `./data`) | Where the SQLite database lives |

---

## Architecture

```
app/
├─ src/
│  ├─ index.js      HTTP server, router, static files, boot
│  ├─ config.js     env loading + feature flags
│  ├─ db.js         SQLite (node:sqlite) schema + data access
│  ├─ auth.js       scrypt hashing, signed-cookie sessions, /api/auth, rate limiting
│  ├─ stripe.js     Checkout, Customer Portal, signed webhook handler
│  ├─ telegram.js   invite links, join capture, leaked-link guard, removals
│  ├─ markets.js    war-room data proxies: fear & greed, earnings + economic calendars
│  └─ jobs.js       hourly access-sync (revoke lapsed members)
├─ public/          the website (index, dashboard, subscribe, 404, logo, app.js)
├─ data/            SQLite database (created at runtime; gitignored)
├─ .env.example     configuration template
└─ render.yaml      one-click Render deploy
```

**Payment → access flow**

```
Member subscribes → Stripe Checkout → webhook (checkout.session.completed)
  → mark member active → create single-use Telegram invite → shown on dashboard
Member joins group → bot matches invite → records their Telegram id
Payment fails / cancels → grace period → hourly job removes them from the group
```

## API reference (JSON)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | `{email,password,name,telegram_username}` |
| POST | `/api/auth/login` | `{email,password}` |
| POST | `/api/auth/logout` | clears session |
| GET  | `/api/me` | current member (or `null`) |
| POST | `/api/me` | update `{name,telegram_username}` |
| POST | `/api/billing/checkout` | → `{url}` Stripe Checkout (auth required) |
| POST | `/api/billing/portal` | → `{url}` Stripe Customer Portal (auth required) |
| POST | `/api/billing/webhook` | Stripe events (signature-verified) |
| GET  | `/api/health` | status + config summary |
| GET  | `/api/markets/fng` | crypto + stock Fear & Greed (cached 1 h) |
| GET  | `/api/markets/earnings` | earnings calendar, this week + next (cached 6 h) |
| GET  | `/api/markets/econ` | macro events this week + key dates ahead (cached 1 h) |

## Notes & good next steps
- **Password reset by email** and **transactional emails** (welcome, dunning) are the natural next additions — the audit log and hooks are already in place. They need an email provider (e.g. Resend/Postmark) which is the one external service not yet wired.
- Dashboard market data (signals, news) is sample content — wire it to your real sources or post via the Telegram bot.
- This software is provided for the IVth Legion community. Trading involves risk; nothing here is financial advice.
