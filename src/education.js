// Education: the IVth Legion Academy — several courses, each sourced from a Google Doc and
// served to members as modules → lessons. The admin edits a doc and hits "Sync"; this module
// pulls the doc's HTML export, converts it (clean HTML, callouts, figures, tables, glossary),
// stores images as files, and serves everything only to members with access.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, now } from './db.js';
import { requireAuth, publicUser } from './auth.js';

const COURSES = [
  { id: 'tech', docId: '1yLj0bF9J44-7NfLQgPMXSbuY73MUNUEW', icon: '📈', title: 'From Zero to God-Level Trader', subtitle: 'Technical mastery — structure, candles, patterns, indicators, confluence & risk' },
  { id: 'mind', docId: '112vbMMaQgVVyoj_jR-vwfy6evt4Bcpl6', icon: '🧠', title: "The Trader's Mind", subtitle: 'Psychology, discipline & mental mastery' },
  { id: 'exec', docId: '1hUUsOGB8o9JLQO4PB-x2ztUtuWH1pro3', icon: '🛡️', title: 'Risk, Psychology & Execution', subtitle: 'Risk management, trading psychology & trade execution' },
];
const DIR = path.join(config.dataDir, 'education');
const courseDir = id => path.join(DIR, id);
const VOID = new Set(['img', 'br', 'hr', 'col', 'meta', 'link', 'input']);
const CALLOUTS = [['IN PLAIN ENGLISH', 'plain'], ['KEY RULE', 'rule'], ['PRO TIP', 'tip'], ['WARNING', 'warn'], ['LIVE EXAMPLE', 'live']];
const MODULE_RE = /^(ORIENTATION|PART\s+[0-9IVXLC]+|CHAPTER\s+\d+|REFERENCE|INTRODUCTION|CONCLUSION)\b\s*[:\-—–]?\s*(.*)$/i;

db.exec(`
  CREATE TABLE IF NOT EXISTS edu_progress (
    user_id     TEXT NOT NULL,
    lesson_id   TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, lesson_id)
  );
  CREATE TABLE IF NOT EXISTS edu_last (
    user_id   TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL,
    at        INTEGER NOT NULL
  );
`);

const courses = new Map();   // id -> converted course
const syncing = new Map();   // id -> in-flight sync promise

// ---------- tiny HTML parsing (Google's export is flat and regular) ----------
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', times: '×', rarr: '→', larr: '←', uarr: '↑', darr: '↓', le: '≤', ge: '≥', asymp: '≈', plusmn: '±', minus: '−', middot: '·', bull: '•', deg: '°', ne: '≠', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', check: '✓', trade: '™', copy: '©', reg: '®', euro: '€', pound: '£' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1));
    return ENT[e.toLowerCase()] ?? m;
  });
}
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parse(html) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9]+)((?:\s+[^>]*?)?)\s*(\/)?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[5] != null) { stack[stack.length - 1].children.push(m[5]); continue; }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const attrs = {};
    for (const a of (m[3] || '').matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1].toLowerCase()] = a[2];
    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(tag) && !m[4]) stack.push(node);
  }
  return root;
}
const textOf = n => (typeof n === 'string' ? decode(n) : n.children.map(textOf).join(''));
const find = (n, tag) => { if (typeof n === 'string') return null; if (n.tag === tag) return n; for (const c of n.children) { const f = find(c, tag); if (f) return f; } return null; };
const findAll = (n, tag, out = []) => { if (typeof n !== 'string') { if (n.tag === tag) out.push(n); n.children.forEach(c => findAll(c, tag, out)); } return out; };
const clean = s => s.replace(/\s+/g, ' ').trim();
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
// ALL-CAPS headings read as shouting in a lesson UI; title-case them, keeping short acronyms.
const titleCase = s => (s !== s.toUpperCase() ? s : s.toLowerCase().split(' ').map((w, i, all) => {
  if (/^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|r:r|bmsb|fomo|rsi|macd)$/.test(w)) return w.toUpperCase();
  const startsPhrase = i === 0 || /^[—–-]$/.test(all[i - 1]) || /:$/.test(all[i - 1]);
  return !startsPhrase && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1);
}).join(' '));

// ---------- images ----------
function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const mk = buf[i + 1];
    if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
function saveImage(cid, src, keep) {
  const m = /^data:image\/(png|jpe?g);base64,(.*)$/s.exec(src);
  if (!m) return null; // linked Google Drawings in these docs are only divider lines
  const buf = Buffer.from(m[2], 'base64');
  const size = imageSize(buf);
  if (size && size.h < 8) return null;
  const name = 'fig-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10) + (m[1] === 'png' ? '.png' : '.jpg');
  const file = path.join(courseDir(cid), 'img', name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  keep.add(name);
  return { name, size, url: `/api/education/img?c=${cid}&f=${name}` };
}
const figureHTML = (saved, alt, cap) =>
  `<figure class="edu-fig"><img src="${saved.url}" alt="${esc(alt)}" loading="lazy"${saved.size ? ` width="${saved.size.w}" height="${saved.size.h}"` : ''}><figcaption>${cap}</figcaption></figure>`;

// ---------- conversion ----------
function convert(def, html) {
  const style = (/<style[^>]*>([\s\S]*?)<\/style>/.exec(html) || [])[1] || '';
  const fmt = {};
  for (const [, c, body] of style.matchAll(/\.(c\d+)\{([^}]*)\}/g)) {
    const fs = /font-size:\s*([\d.]+)pt/.exec(body);
    fmt[c] = { b: /font-weight:\s*700/.test(body), i: /font-style:\s*italic/.test(body), fs: fs ? +fs[1] : 0 };
  }
  const body = find(parse(html), 'body');
  const keep = new Set();
  fs.mkdirSync(path.join(courseDir(def.id), 'img'), { recursive: true });

  const classFmt = n => (n.attrs.class || '').split(/\s+/).reduce((a, c) => ({ b: a.b || fmt[c]?.b, i: a.i || fmt[c]?.i, fs: Math.max(a.fs, fmt[c]?.fs || 0) }), { b: false, i: false, fs: 0 });
  const inline = (n, skipFirstSpan = false) => n.children.map((c, idx) => {
    if (typeof c === 'string') return c;
    if (skipFirstSpan && idx === 0) return '';
    if (c.tag === 'br') return '<br>';
    if (c.tag === 'img') return '';
    let inner = inline(c);
    if (!clean(decode(inner.replace(/<[^>]+>/g, '')))) return inner;
    const f = classFmt(c);
    if (f.i) inner = `<em>${inner}</em>`;
    if (f.b) inner = `<strong>${inner}</strong>`;
    return inner;
  }).join('').replace(/<\/strong><strong>/g, '').replace(/<\/em><em>/g, '');

  // Docs without real heading tags mark headings with bold, larger text instead.
  const hasHeadings = body.children.some(n => typeof n !== 'string' && /^h[12]$/.test(n.tag));
  const headingLevel = (n, text) => {
    if (/^h[1-3]$/.test(n.tag)) return +n.tag[1];
    if (hasHeadings || n.tag !== 'p' || text.length > 120) return 0;
    const first = n.children.find(c => typeof c !== 'string' && clean(textOf(c)));
    const f = first ? classFmt(first) : { b: false, fs: 0 };
    if (!f.b || f.fs < 12) return 0;
    if (/^\d+\.\d+\s+\S/.test(text)) return 2;
    return 1;
  };

  const slug = s => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const modules = [];
  const glossary = [];
  let cover = null;
  let mod = null, lesson = null, inGlossary = false;

  const newLesson = (number, title) => {
    lesson = { id: '', number, title, blocks: [], sections: [], keyRules: [], figures: 0, words: 0 };
    mod.lessons.push(lesson);
  };
  const emit = html => {
    if (!mod) return;
    if (!lesson) newLesson('', 'Overview');
    lesson.blocks.push(html);
  };
  const addWords = text => { if (lesson) lesson.words += text.split(' ').length; };

  for (const n of body.children) {
    if (typeof n === 'string') continue;
    const text = clean(textOf(n));
    const level = text ? headingLevel(n, text) : 0;

    if (level === 1) {
      const m = MODULE_RE.exec(text);
      let label, title;
      if (m) { label = titleCase(m[1]); title = titleCase(m[2] || ''); }
      else if (/^[^:]{3,30}:\s+\S/.test(text)) { [label, title] = text.split(/:\s+(.*)/s); title = titleCase(title); }
      else { label = ''; title = titleCase(text); }
      if (!title) { title = label; }
      inGlossary = /^reference$/i.test(label) && /glossary/i.test(title);
      if (inGlossary) { mod = null; lesson = null; continue; }
      if (/^orientation$/i.test(label)) {
        if (!mod || mod.kind !== 'orientation') { mod = { id: 'start', label: 'Start Here', title: 'Before You Begin', kind: 'orientation', lessons: [] }; modules.push(mod); }
        newLesson('', title);
      } else {
        mod = { id: slug(label || title), label: label || 'Module', title, kind: 'part', lessons: [] };
        modules.push(mod);
        lesson = null;
      }
      continue;
    }
    if (inGlossary) {
      if (n.tag === 'table') {
        for (const tr of findAll(n, 'tr').slice(1)) {
          const tds = findAll(tr, 'td');
          if (tds.length >= 2) glossary.push({ term: clean(textOf(tds[0])), def: clean(textOf(tds[1])) });
        }
      }
      continue;
    }
    if (!mod) {
      // Front matter (title page, static contents): keep only a cover image.
      if (!cover) { const img = find(n, 'img'); if (img) cover = saveImage(def.id, img.attrs.src || '', keep); }
      continue;
    }
    if (level === 2) {
      const m = /^(\d+\.\d+)\s+(.*)$/.exec(text);
      newLesson(m ? m[1] : '', titleCase(m ? m[2] : text));
      continue;
    }
    if (level === 3) {
      const t = titleCase(text), id = slug(t);
      if (!lesson) newLesson('', 'Overview');
      lesson.sections.push({ id, title: t });
      emit(`<h3 id="${id}">${esc(t)}</h3>`);
      continue;
    }
    if (n.tag === 'p') {
      const img = find(n, 'img');
      if (img) {
        const saved = saveImage(def.id, img.attrs.src || '', keep);
        if (saved) { emit(figureHTML(saved, decode(img.attrs.alt || ''), '')); lesson.figures++; }
        if (!text) continue;
      }
      if (!text) continue;
      const co = CALLOUTS.find(([label]) => text.replace(/^\W+/u, '').startsWith(label));
      if (co) {
        const inner = clean(inline(n, true));
        emit(`<aside class="edu-callout edu-${co[1]}"><div class="edu-callout-label">${co[0]}</div><p>${inner}</p></aside>`);
        if (co[1] === 'rule') lesson.keyRules.push(clean(decode(inner.replace(/<[^>]+>/g, ''))));
        addWords(text);
        continue;
      }
      emit(`<p>${inline(n).trim()}</p>`);
      addWords(text);
      continue;
    }
    if (n.tag === 'ul' || n.tag === 'ol') {
      emit(`<${n.tag}>${findAll(n, 'li').map(li => `<li>${inline(li).trim()}</li>`).join('')}</${n.tag}>`);
      addWords(text);
      continue;
    }
    if (n.tag === 'table') {
      const rows = findAll(n, 'tr').map(tr => findAll(tr, 'td'));
      const cellHTML = td => findAll(td, 'p').map(p => inline(p).trim()).filter(Boolean).join('<br>');
      if (rows.length === 1 && rows[0].length === 1 && /FIGURE\s+\d+/i.test(text)) {
        // A figure box: the chart image and its "FIGURE n" caption share one table cell.
        const m = /FIGURE\s+(\d+)\s+(.*)$/i.exec(text);
        const cap = `<span class="edu-fig-no">Figure ${m[1]}</span> ${esc(m[2])}`;
        const img = find(n, 'img');
        const saved = img && saveImage(def.id, img.attrs.src || '', keep);
        if (saved) { emit(figureHTML(saved, m[2], cap)); lesson.figures++; }
        else emit(`<p class="edu-caption">${cap}</p>`);
        continue;
      }
      if (rows.every(r => r.length === 1) && rows.length >= 2) {
        // Single-column tables are titled boxes: rules, checklists, frameworks.
        const items = rows.slice(1).map(r => cellHTML(r[0])).filter(Boolean);
        emit(`<aside class="edu-box"><div class="edu-box-title">${esc(clean(textOf(rows[0][0])))}</div>${items.map(i => `<div class="edu-box-row">${i}</div>`).join('')}</aside>`);
        addWords(text);
        continue;
      }
      // Google sometimes merges a figure box into the last row of the table above it — lift it out.
      const figRows = rows.filter(r => r.some(td => find(td, 'img')));
      const dataRows = rows.filter(r => !figRows.includes(r));
      const head = dataRows[0].map(td => `<th>${clean(inline(td.children.find(c => c.tag === 'p') || td))}</th>`).join('');
      const bodyRows = dataRows.slice(1).map(r => '<tr>' + r.map(td => `<td>${cellHTML(td)}</td>`).join('') + '</tr>').join('');
      emit(`<div class="edu-table"><table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table></div>`);
      for (const r of figRows) {
        const cell = r.find(td => find(td, 'img'));
        const saved = saveImage(def.id, find(cell, 'img').attrs.src || '', keep);
        const fm = /FIGURE\s+(\d+)\s+(.*)$/i.exec(clean(textOf(cell)));
        if (saved) { emit(figureHTML(saved, fm ? fm[2] : '', fm ? `<span class="edu-fig-no">Figure ${fm[1]}</span> ${esc(fm[2])}` : '')); lesson.figures++; }
      }
      addWords(text);
    }
  }

  // Finalise lessons: globally unique ids, html, reading time, searchable text.
  let figures = 0;
  for (const m of modules) {
    m.lessons = m.lessons.filter(l => l.blocks.length);
    m.lessons.forEach((l, i) => {
      l.id = `${def.id}.${m.id}-${l.number ? l.number.replace('.', '-') : i + 1}`;
      l.html = l.blocks.join('\n');
      l.text = clean(decode(l.html.replace(/<[^>]+>/g, ' ')));
      l.minutes = Math.max(2, Math.round(l.words / 200 + l.figures * 0.5));
      figures += l.figures;
      delete l.blocks; delete l.words;
    });
  }
  const used = modules.filter(m => m.lessons.length);
  const imgDir = path.join(courseDir(def.id), 'img');
  for (const f of fs.readdirSync(imgDir)) if (!keep.has(f)) fs.unlinkSync(path.join(imgDir, f));
  return {
    id: def.id, icon: def.icon, title: def.title, subtitle: def.subtitle,
    source: `https://docs.google.com/document/d/${def.docId}`,
    syncedAt: Date.now(),
    cover: cover ? cover.url : null,
    stats: {
      modules: used.length,
      lessons: used.reduce((a, m) => a + m.lessons.length, 0),
      figures,
      glossary: glossary.length,
      minutes: used.reduce((a, m) => a + m.lessons.reduce((b, l) => b + l.minutes, 0), 0),
    },
    modules: used,
    glossary,
  };
}

export function syncCourse(id) {
  const def = COURSES.find(c => c.id === id);
  if (!def) return Promise.reject(new Error('Unknown course'));
  if (syncing.has(id)) return syncing.get(id);
  const p = (async () => {
    const res = await fetch(`https://docs.google.com/document/d/${def.docId}/export?format=html`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Google Doc export failed (HTTP ${res.status}) — is the doc shared as "Anyone with the link"?`);
    const html = await res.text();
    if (!/<body/i.test(html)) throw new Error('Google returned a sign-in page — share the doc as "Anyone with the link can view".');
    const next = convert(def, html);
    if (!next.stats.lessons) throw new Error('No lessons found in the doc — check its headings.');
    const file = path.join(courseDir(id), 'course.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(next));
    fs.renameSync(file + '.tmp', file);
    courses.set(id, next);
    console.log(`[education] ${id} synced: ${next.stats.lessons} lessons, ${next.stats.figures} figures, ${next.stats.glossary} glossary terms`);
    return next;
  })().finally(() => syncing.delete(id));
  syncing.set(id, p);
  return p;
}

export function initEducation() {
  // Pre-multi-course layout kept everything at the top level.
  fs.rmSync(path.join(DIR, 'course.json'), { force: true });
  fs.rmSync(path.join(DIR, 'img'), { recursive: true, force: true });
  for (const def of COURSES) {
    try { courses.set(def.id, JSON.parse(fs.readFileSync(path.join(courseDir(def.id), 'course.json'), 'utf8'))); }
    catch { syncCourse(def.id).catch(e => console.error(`[education] ${def.id} initial sync failed:`, e.message)); }
  }
}

async function getCourse(id) {
  if (courses.has(id)) return courses.get(id);
  return syncCourse(id);
}

// ---------- routes ----------
const isAdmin = u => u.role === 'admin' || (config.adminEmail && u.email.toLowerCase() === config.adminEmail);
function requireMember(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!publicUser(user).hasAccess && !isAdmin(user)) { res.json(403, { error: 'An active membership is required for the Academy.' }); return null; }
  return user;
}
function sendJSON(req, res, obj) {
  const body = JSON.stringify(obj);
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(gzip ? zlib.gzipSync(body) : body);
}
const query = req => new URL(req.url, 'http://x').searchParams;
const allLessonIds = () => new Set([...courses.values()].flatMap(c => c.modules.flatMap(m => m.lessons.map(l => l.id))));

export function registerEducationRoutes(router) {
  router.get('/api/education/courses', async (req, res) => {
    const user = requireMember(req, res); if (!user) return;
    const list = await Promise.all(COURSES.map(async def => {
      const c = await getCourse(def.id).catch(() => null);
      return c
        ? { id: c.id, icon: c.icon, title: c.title, subtitle: c.subtitle, cover: c.cover, stats: c.stats, syncedAt: c.syncedAt, lessonIds: c.modules.flatMap(m => m.lessons.map(l => l.id)) }
        : { id: def.id, icon: def.icon, title: def.title, subtitle: def.subtitle, unavailable: true };
    }));
    sendJSON(req, res, { courses: list, isAdmin: isAdmin(user) });
  });

  router.get('/api/education/course', async (req, res) => {
    const user = requireMember(req, res); if (!user) return;
    const id = query(req).get('c') || COURSES[0].id;
    if (!COURSES.some(c => c.id === id)) return res.json(404, { error: 'Unknown course' });
    try { sendJSON(req, res, { ...(await getCourse(id)), isAdmin: isAdmin(user) }); }
    catch { res.json(503, { error: 'Course is being prepared — try again shortly.' }); }
  });

  router.get('/api/education/img', (req, res) => {
    const user = requireMember(req, res); if (!user) return;
    const q = query(req), c = q.get('c') || '', f = q.get('f') || '';
    if (!COURSES.some(x => x.id === c) || !/^fig-[a-f0-9]{10}\.(png|jpg)$/.test(f)) return res.json(400, { error: 'Bad image name' });
    const file = path.join(courseDir(c), 'img', f);
    if (!fs.existsSync(file)) return res.json(404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': f.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    fs.createReadStream(file).pipe(res);
  });

  router.get('/api/education/progress', (req, res) => {
    const user = requireMember(req, res); if (!user) return;
    const done = db.prepare('SELECT lesson_id FROM edu_progress WHERE user_id = ?').all(user.id).map(r => r.lesson_id);
    const last = db.prepare('SELECT lesson_id FROM edu_last WHERE user_id = ?').get(user.id);
    res.json(200, { done, last: last ? last.lesson_id : null });
  });

  router.post('/api/education/progress', (req, res) => {
    const user = requireMember(req, res); if (!user) return;
    const { lesson, done, visit } = req.body || {};
    if (typeof lesson !== 'string' || !allLessonIds().has(lesson)) return res.json(400, { error: 'Unknown lesson' });
    if (visit) db.prepare('INSERT INTO edu_last (user_id, lesson_id, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET lesson_id = excluded.lesson_id, at = excluded.at').run(user.id, lesson, now());
    if (done === true) db.prepare('INSERT OR IGNORE INTO edu_progress (user_id, lesson_id, completed_at) VALUES (?, ?, ?)').run(user.id, lesson, now());
    if (done === false) db.prepare('DELETE FROM edu_progress WHERE user_id = ? AND lesson_id = ?').run(user.id, lesson);
    res.json(200, { ok: true });
  });

  router.post('/api/education/sync', async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!isAdmin(user)) return res.json(403, { error: 'Admins only' });
    const id = (req.body && req.body.course) || COURSES[0].id;
    try {
      const c = await syncCourse(id);
      res.json(200, { ok: true, syncedAt: c.syncedAt, stats: c.stats });
    } catch (e) {
      res.json(e.message === 'Unknown course' ? 404 : 502, { error: e.message });
    }
  });
}
