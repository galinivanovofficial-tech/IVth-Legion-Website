// Background jobs (zero dependency scheduler).
import { config } from './config.js';
import { Users, now } from './db.js';
import { removeMember } from './telegram.js';
import { refreshData } from './data-refresh.js';

// Revoke Telegram access for members whose subscription lapsed beyond the grace period.
export async function syncAccess() {
  if (!config.telegram.enabled) return;
  const graceCutoff = now() - config.graceDays * 86400;
  const lapsed = Users.lapsedInGroup(graceCutoff);
  for (const user of lapsed) {
    await removeMember(user, 'grace_period_ended').catch(e => console.error('[jobs]', e.message));
  }
  if (lapsed.length) console.log(`[jobs] revoked ${lapsed.length} lapsed member(s)`);
}

export function startJobs() {
  // Access sync: shortly after boot, then hourly.
  setTimeout(() => syncAccess().catch(() => {}), 30 * 1000).unref();
  setInterval(() => syncAccess().catch(() => {}), 60 * 60 * 1000).unref();
  console.log('[jobs] access-sync scheduled (hourly)');

  // Chart data refresh: on boot, then every 12 hours.
  setTimeout(() => refreshData().catch(e => console.error('[data]', e.message)), 5 * 1000).unref();
  setInterval(() => refreshData().catch(e => console.error('[data]', e.message)), 12 * 60 * 60 * 1000).unref();
  console.log('[jobs] data-refresh scheduled (every 12h)');
}
