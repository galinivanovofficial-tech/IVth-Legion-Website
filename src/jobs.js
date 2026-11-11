// Background jobs (zero dependency scheduler).
import { config } from './config.js';
import { Users } from './db.js';
import { hasRight } from './access.js';
import { removeMember } from './telegram.js';
import { refreshData } from './data-refresh.js';

// Remove from the Telegram group everyone whose telegram right has ended (code expired, Stripe lapsed past grace).
export async function syncAccess() {
  if (!config.telegram.enabled) return;
  const lapsed = Users.inGroup().filter(u => !hasRight(u, 'telegram'));
  for (const user of lapsed) {
    await removeMember(user, 'access_ended').catch(e => console.error('[jobs]', e.message));
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
