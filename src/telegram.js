// Telegram automation via Bot API REST calls (zero dependency).
// Handles: single-use invite links, join capture, leaked-link guard, member removal.
import { config } from './config.js';
import { Users, Audit, now } from './db.js';

const T = config.telegram;

async function api(method, params = {}) {
  if (!T.enabled) throw new Error('Telegram not configured');
  const res = await fetch(`https://api.telegram.org/bot${T.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  return data.result;
}

// Create a fresh single-use, short-lived invite link for a member.
export async function ensureInvite(user, force = false) {
  if (!T.enabled) return '';
  const valid = user.invite_link && user.invite_expires > now() + 60 && !force;
  if (valid) return user.invite_link;
  try {
    const link = await api('createChatInviteLink', {
      chat_id: T.groupId,
      name: `legion:${user.email}`.slice(0, 32),
      member_limit: 1,
      expire_date: now() + T.inviteHours * 3600,
    });
    Users.update(user.id, { invite_link: link.invite_link, invite_expires: link.expire_date || (now() + T.inviteHours * 3600) });
    Audit.log(user.id, 'telegram_invite_created');
    return link.invite_link;
  } catch (e) {
    console.error('[telegram] ensureInvite:', e.message);
    return T.groupLink || '';
  }
}

// Remove a member from the group but allow them to rejoin later (unban after ban).
export async function removeMember(user, reason = 'subscription_lapsed') {
  if (!T.enabled || !user.telegram_user_id) return;
  try {
    await api('banChatMember', { chat_id: T.groupId, user_id: Number(user.telegram_user_id) });
    await api('unbanChatMember', { chat_id: T.groupId, user_id: Number(user.telegram_user_id), only_if_banned: true });
    Users.update(user.id, { telegram_joined: 0, invite_link: '', invite_expires: 0 });
    Audit.log(user.id, 'telegram_removed', reason);
    console.log(`[telegram] removed ${user.email} (${reason})`);
  } catch (e) {
    console.error('[telegram] removeMember:', e.message);
  }
}

// Kick someone who is not an entitled member (leaked/shared link).
async function kickIntruder(userId) {
  try {
    await api('banChatMember', { chat_id: T.groupId, user_id: userId });
    await api('unbanChatMember', { chat_id: T.groupId, user_id: userId, only_if_banned: true });
    console.log(`[telegram] kicked intruder ${userId}`);
  } catch (e) { console.error('[telegram] kickIntruder:', e.message); }
}

function hasAccess(u) {
  if (!u) return false;
  if (['active', 'trialing'].includes(u.subscription_status)) return true;
  const graceCutoff = now() - config.graceDays * 86400;
  return u.subscription_status === 'past_due' && u.current_period_end > graceCutoff;
}

// Handle a chat_member update (someone joined/left the group).
async function onChatMember(upd) {
  const m = upd.new_chat_member;
  if (!m) return;
  const tgUser = m.user;
  if (tgUser?.is_bot) return;
  const status = m.status; // member | left | kicked | restricted | administrator | creator
  const joined = ['member', 'administrator', 'creator', 'restricted'].includes(status);

  if (joined) {
    // Match the invite link used to the member who owns it.
    const usedLink = upd.invite_link?.invite_link;
    let user = usedLink ? Users.byInviteLink(usedLink) : null;
    if (!user && tgUser.username) {
      const byHandle = Users.all().find(u => u.telegram_username && u.telegram_username.toLowerCase() === tgUser.username.toLowerCase());
      if (byHandle) user = byHandle;
    }
    if (user && hasAccess(user)) {
      Users.update(user.id, { telegram_user_id: String(tgUser.id), telegram_joined: 1 });
      Audit.log(user.id, 'telegram_joined');
      console.log(`[telegram] ${user.email} joined the group`);
    } else {
      // No matching entitled member => leaked/unauthorized link. Remove.
      await kickIntruder(tgUser.id);
    }
  } else {
    // Left / kicked — clear join flag.
    const user = Users.byTelegramUserId(tgUser.id);
    if (user) Users.update(user.id, { telegram_joined: 0 });
  }
}

// Long-poll getUpdates so no public webhook URL is required. Runs forever.
let polling = false;
export async function startPolling() {
  if (!T.enabled || polling) return;
  polling = true;
  // Verify bot + permissions once.
  try {
    const me = await api('getMe');
    console.log(`[telegram] bot @${me.username} online, watching group ${T.groupId}`);
  } catch (e) {
    console.error('[telegram] getMe failed — check TELEGRAM_BOT_TOKEN:', e.message);
    polling = false; return;
  }
  let offset = 0;
  const loop = async () => {
    while (polling) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['chat_member', 'message'] });
        for (const upd of updates) {
          offset = upd.update_id + 1;
          if (upd.chat_member) await onChatMember(upd.chat_member).catch(e => console.error('[telegram]', e.message));
          // A /start DM lets us greet members; extend here if desired.
        }
      } catch (e) {
        console.error('[telegram] poll error:', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  };
  loop();
}
export function stopPolling() { polling = false; }
