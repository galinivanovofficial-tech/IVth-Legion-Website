// Legion Heartbeat: services report "I'm alive" (HB-202) and events (HB-203).
// Machine-to-machine auth: one shared Bearer token from HB_TOKEN, compared in constant time.
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, now } from './db.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;   // 'web', 'autodeploy', 'weex-bot'

function authorized(req) {
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.replace(/^Bearer /, ''));
  const expected = Buffer.from(config.hbToken);
  if (!config.hbToken || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

export function registerHeartbeatRoutes(router) {
  router.post('/api/hb', (req, res) => {
    if (!authorized(req)) return res.json(401, { error: 'Unauthorized' });

    const { service, version = '', intervalSec = 120 } = req.body || {};
    if (!NAME_RE.test(String(service || ''))) return res.json(400, { error: 'Invalid service name' });

    const interval = Math.min(Math.max(parseInt(intervalSec, 10) || 120, 10), 86400);
    const t = now();

    db.prepare(`
      INSERT INTO hb_services (name, status, version, interval_sec, last_seen_at, created_at)
      VALUES (?, 'up', ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        status       = 'up',
        version      = excluded.version,
        interval_sec = excluded.interval_sec,
        last_seen_at = excluded.last_seen_at
    `).run(service, String(version).slice(0, 40), interval, t, t);

    res.json(200, { ok: true });
  });
}