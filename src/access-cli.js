// Owner tool for access codes. On the server (inside the running container):
//   sudo docker exec legion node src/access-cli.js create vip --note "Ivan"        one VIP code (90 days)
//   sudo docker exec legion node src/access-cli.js create legion --count 10        ten member codes (30 days)
//   sudo docker exec legion node src/access-cli.js list                            all codes (never the code itself)
//   sudo docker exec legion node src/access-cli.js revoke 12                       cancel code #12 if unused
//   sudo docker exec legion node src/access-cli.js status someone@example.com      what an account can use
// Options for create: --note "text", --count N (1-50), --redeem-days N (code must be used within N days).
// Every code works once, for one account. The plain code is printed only here; the database keeps its sha256.
import { Codes, Users } from './db.js';
import { PLANS, createCode, accessOf } from './access.js';

const [cmd, arg] = process.argv.slice(2);
const opt = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const day = s => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '—');
const fail = msg => { console.error(msg); process.exit(1); };

if (cmd === 'create') {
  if (!PLANS[arg]) fail(`Plan must be one of: ${Object.keys(PLANS).map(p => `${p} (${PLANS[p].rights.join('+')}, ${PLANS[p].days} days)`).join(', ')}`);
  const count = Number(opt('count', 1)), redeemDays = Number(opt('redeem-days', 0)), note = opt('note', '');
  if (!Number.isInteger(count) || count < 1 || count > 50) fail('--count must be 1-50');
  console.log(`${PLANS[arg].label}: ${PLANS[arg].rights.join(' + ')}, ${PLANS[arg].days} days from the moment it is redeemed. One use, one account.\n`);
  for (let i = 0; i < count; i++) {
    const { code, row } = createCode({ plan: arg, note, redeemDays });
    console.log(`#${row.id}  ${code}${redeemDays ? `  (redeem by ${day(row.redeem_by)})` : ''}`);
  }
  console.log('\nCopy the codes now: they cannot be shown again.');
} else if (cmd === 'list') {
  const rows = Codes.all();
  if (!rows.length) console.log('No codes yet.');
  for (const c of rows) {
    const state = c.revoked_at ? 'cancelled' : c.uses >= c.max_uses ? 'used' : c.redeem_by && c.redeem_by < Date.now() / 1000 ? 'expired' : 'unused';
    console.log(`#${String(c.id).padEnd(4)} ${c.plan.padEnd(7)} …${c.hint}  ${state.padEnd(9)} created ${day(c.created_at)}${c.note ? '  ' + c.note : ''}`);
  }
} else if (cmd === 'revoke') {
  const c = Codes.byId(Number(arg));
  if (!c) fail(`No code #${arg}`);
  if (c.uses >= c.max_uses) fail(`Code #${c.id} was already used; access already given stays until it ends.`);
  console.log(Codes.revoke(c.id) ? `Code #${c.id} cancelled.` : `Code #${c.id} was already cancelled.`);
} else if (cmd === 'status') {
  const u = Users.byEmail(arg || '');
  if (!u) fail(`No account for ${arg}`);
  const a = accessOf(u);
  console.log(`${u.email}`);
  for (const r of ['telegram', 'website', 'education']) console.log(`  ${r.padEnd(10)} ${a[r] ? 'until ' + day(a[r]) : 'no'}`);
  for (const s of a.sources) console.log(`  from ${s.source}: ${s.rights.join('+')} until ${day(s.until)}`);
} else {
  console.log('Usage: node src/access-cli.js create <vip|legion> [--note "text"] [--count N] [--redeem-days N] | list | revoke <id> | status <email>');
}
