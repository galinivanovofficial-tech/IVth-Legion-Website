// Creates (or updates) an owner account with admin rights and an active membership.
// The password is typed at a hidden prompt, so it never appears on screen, in shell history or in the code.
// Usage on the server:  sudo legion-admin you@example.com
import crypto from 'node:crypto';
import { db } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Usage: legion-admin you@example.com'); process.exit(1); }

function askHidden(question) {
  return new Promise(resolve => {
    const input = process.stdin;
    process.stdout.write(question);
    if (!input.isTTY) { // piped input (scripts/tests): read one line
      let buf = '';
      input.setEncoding('utf8');
      input.on('data', c => (buf += c)).on('end', () => resolve(buf.split('\n')[0]));
      return;
    }
    let value = '';
    input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          input.setRawMode(false); input.pause(); input.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(1); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on('data', onData);
  });
}

const pass = await askHidden(`Password for ${email} (typing is hidden): `);
if (pass.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
if (process.stdin.isTTY && (await askHidden('Repeat password: ')) !== pass) { console.error('Passwords do not match.'); process.exit(1); }

const now = Math.floor(Date.now() / 1000), periodEnd = now + 10 * 365 * 86400;
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (existing) {
  db.prepare(`UPDATE users SET password_hash = ?, role = 'admin', subscription_status = 'active', current_period_end = ?, updated_at = ? WHERE id = ?`)
    .run(hashPassword(pass), periodEnd, now, existing.id);
  console.log(`Updated ${email}: admin, active membership, new password set.`);
} else {
  db.prepare(`INSERT INTO users (id, email, password_hash, name, role, subscription_status, current_period_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?, ?)`).run(crypto.randomUUID(), email, hashPassword(pass), email.split('@')[0], periodEnd, now, now);
  console.log(`Created ${email}: admin, active membership.`);
}
