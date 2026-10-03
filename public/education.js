// IVth Legion Academy — multi-course reader for the dashboard Education section.
// Courses + images come from /api/education/* (members only); progress is saved per user.
window.LegionEducation = (function () {
  'use strict';

  const CALLOUT_ICON = { plain: '💡', rule: '🔑', tip: '🎯', warn: '⚠️', live: '📈' };
  let root, catalog = [], isAdmin = false;
  const cache = new Map();                 // course id -> full course
  let course = null, lessons = [], glossaryRe = null;
  let done = new Set(), lastId = null, view = { kind: 'academy' };

  const $ = (sel, el = root) => el.querySelector(sel);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtMin = m => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + 'm' : ''}` : `${m} min`).trim();
  const lessonById = id => lessons.find(l => l.id === id);
  const moduleOf = l => course.modules.find(m => m.lessons.includes(l));
  const label = l => (l.number ? `${l.number} · ` : '') + l.title;
  const courseIdOf = lessonId => String(lessonId).split('.')[0];

  async function api(url, body) {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: r.status });
    return data;
  }

  async function init(containerId) {
    root = document.getElementById(containerId);
    if (!root) return;
    if (catalog.length) { render(); return; }
    root.innerHTML = '<div class="edu-loading">Loading the Academy…</div>';
    try {
      const [cat, p] = await Promise.all([api('/api/education/courses'), api('/api/education/progress')]);
      catalog = cat.courses; isAdmin = cat.isAdmin;
      done = new Set(p.done); lastId = p.last;
      const h = /^#education\/(.+)$/.exec(location.hash);
      const target = h ? decodeURIComponent(h[1]) : '';
      if (target.includes('.')) { await useCourse(courseIdOf(target)); view = lessonById(target) ? { kind: 'lesson', id: target } : { kind: 'home' }; }
      else if (catalog.some(c => c.id === target)) { await useCourse(target); view = { kind: 'home' }; }
      render();
    } catch (e) {
      root.innerHTML = `<div class="edu-empty"><h3>${e.status === 403 ? 'Members only' : 'Academy unavailable'}</h3><p>${esc(e.message)}</p></div>`;
    }
  }

  async function useCourse(id) {
    if (course && course.id === id) return;
    if (!cache.has(id)) cache.set(id, await api('/api/education/course?c=' + encodeURIComponent(id)));
    course = cache.get(id);
    lessons = course.modules.flatMap(m => m.lessons);
    // Longest terms first so "Volume Profile" wins over "Volume".
    const terms = course.glossary.map(g => g.term).filter(t => t.length >= 2).sort((a, b) => b.length - a.length);
    glossaryRe = terms.length ? new RegExp('\\b(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'gi') : null;
  }

  // ── Layout ───────────────────────────────────────────────────────
  function render() {
    root.innerHTML =
      '<div class="edu-wrap">' +
        '<aside class="edu-side">' + sidebarHTML() + '</aside>' +
        '<div class="edu-main"><div class="edu-readbar"><span></span></div><div class="edu-view"></div></div>' +
      '</div>';
    bindSidebar();
    renderView();
  }

  function progressNums(ids) {
    const d = ids.filter(id => done.has(id)).length;
    return { d, t: ids.length, pct: ids.length ? Math.round((d / ids.length) * 100) : 0 };
  }
  const allIds = () => catalog.flatMap(c => c.lessonIds || []);
  const progressBar = (p, text) => `<div class="edu-progress"><div class="edu-progress-bar"><span style="width:${p.pct}%"></span></div><div class="edu-progress-text">${text}</div></div>`;

  function sidebarHTML() {
    if (view.kind === 'academy' || !course) {
      const all = progressNums(allIds());
      return '<button class="edu-side-toggle" type="button">☰ Academy menu</button><div class="edu-side-body">' +
        '<a class="edu-side-title" data-go="academy">IVth Legion Academy</a>' +
        progressBar(all, `${all.d} / ${all.t} lessons · ${all.pct}%`) +
        '<nav class="edu-toc edu-course-list">' +
        catalog.map(c => {
          const p = progressNums(c.lessonIds || []);
          return `<a class="edu-course-link" data-course="${c.id}"><span class="edu-course-ico">${c.icon}</span><span class="edu-course-name">${esc(c.title)}</span><span class="edu-mod-count${p.t && p.d === p.t ? ' full' : ''}">${p.d}/${p.t}</span></a>`;
        }).join('') +
        '</nav></div>';
    }
    const ids = lessons.map(l => l.id), all = progressNums(ids);
    const synced = new Date(course.syncedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return (
      '<button class="edu-side-toggle" type="button">☰ Course menu</button>' +
      '<div class="edu-side-body">' +
        '<a class="edu-back" data-go="academy">← All courses</a>' +
        `<a class="edu-side-title" data-go="home">${course.icon} ${esc(course.title)}</a>` +
        progressBar(all, `${all.d} / ${all.t} lessons · ${all.pct}%`) +
        `<input class="edu-search" type="search" placeholder="Search this course${course.glossary.length ? ' & glossary' : ''}…" aria-label="Search this course">` +
        '<nav class="edu-toc">' +
        course.modules.map(m => {
          const p = progressNums(m.lessons.map(l => l.id));
          const open = view.kind === 'lesson' && moduleOf(lessonById(view.id)) === m;
          return `<details class="edu-mod"${open ? ' open' : ''}><summary>` +
            `<span class="edu-mod-label">${esc(m.label)}</span><span class="edu-mod-title">${esc(m.title)}</span>` +
            `<span class="edu-mod-count${p.d === p.t ? ' full' : ''}">${p.d}/${p.t}</span></summary>` +
            m.lessons.map(l => `<a class="edu-toc-lesson${done.has(l.id) ? ' done' : ''}${view.id === l.id ? ' current' : ''}" data-lesson="${l.id}">` +
              `<span class="edu-check">${done.has(l.id) ? '✓' : ''}</span><span class="edu-toc-name">${esc(label(l))}</span><span class="edu-toc-min">${l.minutes}m</span></a>`).join('') +
            '</details>';
        }).join('') +
        (course.glossary.length ? `<a class="edu-toc-extra" data-go="glossary">📖 Glossary <span>${course.glossary.length} terms</span></a>` : '') +
        '</nav>' +
        (isAdmin
          ? `<div class="edu-admin"><div class="edu-admin-head">ADMIN</div><div class="edu-admin-meta">Synced from Google Doc<br>${esc(synced)}</div>` +
            `<button class="edu-sync" type="button">⟳ Sync from Google Doc</button><a class="edu-doc-link" href="${esc(course.source)}" target="_blank" rel="noopener">Open the doc ↗</a><div class="edu-sync-msg" role="status"></div></div>`
          : '') +
      '</div>'
    );
  }

  function bindSidebar() {
    root.querySelectorAll('.edu-side [data-lesson]').forEach(a => { a.onclick = () => openLesson(a.dataset.lesson); });
    root.querySelectorAll('.edu-side [data-go]').forEach(a => { a.onclick = () => go(a.dataset.go); });
    root.querySelectorAll('.edu-side [data-course]').forEach(a => { a.onclick = () => openCourse(a.dataset.course); });
    $('.edu-side-toggle').onclick = () => root.querySelector('.edu-side').classList.toggle('open');
    const search = $('.edu-search');
    if (search) search.oninput = () => { if (search.value.trim().length >= 2) { view = { kind: 'search', q: search.value.trim() }; renderView(); } else if (view.kind === 'search') go('home'); };
    const sync = $('.edu-sync');
    if (sync) sync.onclick = runSync;
  }

  function refreshSidebar() {
    const side = root.querySelector('.edu-side');
    const q = $('.edu-search') ? $('.edu-search').value : '';
    const wasOpen = side.classList.contains('open');
    side.innerHTML = sidebarHTML();
    if ($('.edu-search')) $('.edu-search').value = q;
    side.classList.toggle('open', wasOpen);
    bindSidebar();
  }

  function setHash(h) { history.replaceState(null, '', '#education' + (h ? '/' + h : '')); }

  function go(kind) {
    view = { kind };
    setHash(kind === 'academy' ? '' : kind === 'home' ? course.id : course.id);
    renderView(); refreshSidebar();
  }

  async function openCourse(id) {
    await useCourse(id);
    view = { kind: 'home' };
    setHash(id);
    root.querySelector('.edu-side').classList.remove('open');
    renderView(); refreshSidebar();
  }

  async function openLesson(id) {
    await useCourse(courseIdOf(id));
    view = { kind: 'lesson', id };
    setHash(encodeURIComponent(id));
    lastId = id;
    api('/api/education/progress', { lesson: id, visit: true }).catch(() => {});
    root.querySelector('.edu-side').classList.remove('open');
    renderView(); refreshSidebar();
  }

  function scrollTop() {
    const sc = document.getElementById('main');
    const top = root.getBoundingClientRect().top + (sc ? sc.scrollTop : window.scrollY) - 80;
    (sc || window).scrollTo({ top: Math.max(0, top) });
  }

  function renderView() {
    const el = $('.edu-view');
    if (view.kind === 'lesson') el.innerHTML = lessonHTML(lessonById(view.id));
    else if (view.kind === 'glossary') el.innerHTML = glossaryHTML('');
    else if (view.kind === 'search') el.innerHTML = searchHTML(view.q);
    else if (view.kind === 'home') el.innerHTML = homeHTML();
    else el.innerHTML = academyHTML();
    bindView();
    if (view.kind !== 'search') scrollTop();
    updateReadBar();
  }

  // ── Views ────────────────────────────────────────────────────────
  function academyHTML() {
    const all = progressNums(allIds());
    const resumeCourse = lastId && catalog.find(c => (c.lessonIds || []).includes(lastId));
    return (
      '<section class="edu-hero edu-hero-academy"><div class="edu-hero-text">' +
        '<div class="edu-kicker">IVth Legion</div><h2>The Academy</h2>' +
        `<p>${catalog.length} courses that take you from your first candle to a disciplined, risk-first trading process — technical skill, the trader's mind, and flawless execution.</p>` +
        `<div class="edu-stats"><span><b>${catalog.length}</b> courses</span><span><b>${catalog.reduce((a, c) => a + (c.stats ? c.stats.lessons : 0), 0)}</b> lessons</span><span><b>${fmtMin(catalog.reduce((a, c) => a + (c.stats ? c.stats.minutes : 0), 0))}</b> reading</span></div>` +
        (resumeCourse ? `<div class="edu-hero-cta"><button class="edu-btn" data-open="${lastId}">Continue where you left off →</button><span class="edu-hero-next">${esc(resumeCourse.title)}</span></div>` : '') +
        (all.d ? `<div class="edu-progress big"><div class="edu-progress-bar"><span style="width:${all.pct}%"></span></div><div class="edu-progress-text">${all.d} of ${all.t} lessons complete across the Academy · ${all.pct}%</div></div>` : '') +
      '</div></section>' +
      '<h3 class="edu-section-title">Courses</h3><div class="edu-courses">' +
      catalog.map((c, i) => {
        if (c.unavailable) return `<div class="edu-ccard unavailable"><span class="edu-ccard-ico">${c.icon}</span><span class="edu-ccard-title">${esc(c.title)}</span><span class="edu-ccard-sub">Being prepared — check back shortly.</span></div>`;
        const p = progressNums(c.lessonIds);
        return `<button class="edu-ccard" data-course="${c.id}">` +
          (c.cover ? `<img class="edu-ccard-cover" src="${c.cover}" alt="">` : `<span class="edu-ccard-art"><span>${c.icon}</span></span>`) +
          `<span class="edu-ccard-body"><span class="edu-ccard-no">Course ${i + 1}</span><span class="edu-ccard-title">${esc(c.title)}</span><span class="edu-ccard-sub">${esc(c.subtitle)}</span>` +
          `<span class="edu-ccard-meta">${c.stats.modules} modules · ${c.stats.lessons} lessons · ${fmtMin(c.stats.minutes)}</span>` +
          `<span class="edu-mcard-bar"><span style="width:${p.pct}%"></span></span>` +
          `<span class="edu-ccard-cta">${p.d === p.t ? '✓ Completed — review' : p.d ? `Continue · ${p.pct}%` : 'Start course →'}</span></span></button>`;
      }).join('') +
      '</div>'
    );
  }

  function homeHTML() {
    const s = course.stats, all = progressNums(lessons.map(l => l.id));
    const last = lastId && lessonById(lastId);
    const resume = last || lessons.find(l => !done.has(l.id)) || lessons[0];
    const started = all.d > 0 || !!last;
    return (
      '<section class="edu-hero">' +
        (course.cover ? `<img class="edu-hero-cover" src="${course.cover}" alt="">` : `<div class="edu-hero-art"><span>${course.icon}</span></div>`) +
        '<div class="edu-hero-text">' +
          '<div class="edu-kicker"><a data-go="academy">IVth Legion Academy</a></div>' +
          `<h2>${esc(course.title)}</h2>` +
          `<p>${esc(course.subtitle)}.</p>` +
          `<div class="edu-stats"><span><b>${s.modules}</b> modules</span><span><b>${s.lessons}</b> lessons</span>${s.figures ? `<span><b>${s.figures}</b> annotated chart${s.figures > 1 ? 's' : ''}</span>` : ''}<span><b>${fmtMin(s.minutes)}</b> reading</span></div>` +
          `<div class="edu-hero-cta"><button class="edu-btn" data-open="${resume.id}">${started ? 'Continue' : 'Start the course'} →</button>` +
          `<span class="edu-hero-next">${started ? 'Next up: ' : ''}${esc(label(resume))}</span></div>` +
          (started ? `<div class="edu-progress big"><div class="edu-progress-bar"><span style="width:${all.pct}%"></span></div><div class="edu-progress-text">${all.d} of ${all.t} lessons complete · ${all.pct}%</div></div>` : '') +
        '</div>' +
      '</section>' +
      '<h3 class="edu-section-title">The curriculum</h3>' +
      '<div class="edu-modules">' +
      course.modules.map(m => {
        const p = progressNums(m.lessons.map(l => l.id)), mins = m.lessons.reduce((a, l) => a + l.minutes, 0);
        const first = m.lessons.find(l => !done.has(l.id)) || m.lessons[0];
        return `<button class="edu-mcard${p.d === p.t ? ' complete' : ''}" data-open="${first.id}">` +
          `<span class="edu-mcard-label">${esc(m.label)}</span><span class="edu-mcard-title">${esc(m.title)}</span>` +
          `<span class="edu-mcard-meta">${m.lessons.length} lesson${m.lessons.length > 1 ? 's' : ''} · ${fmtMin(mins)}</span>` +
          `<span class="edu-mcard-bar"><span style="width:${p.pct}%"></span></span>` +
          `<span class="edu-mcard-state">${p.d === p.t ? '✓ Complete' : p.d ? `${p.d}/${p.t} done` : 'Not started'}</span></button>`;
      }).join('') +
      '</div>'
    );
  }

  function lessonHTML(l) {
    const m = moduleOf(l), idx = lessons.indexOf(l), inMod = m.lessons.indexOf(l);
    const prev = lessons[idx - 1], next = lessons[idx + 1];
    const isDone = done.has(l.id);
    const outline = l.sections.length
      ? `<div class="edu-outline"><div class="edu-outline-head">In this lesson</div><ol>${l.sections.map(s => `<li><a data-anchor="${s.id}">${esc(s.title)}</a></li>`).join('')}</ol></div>`
      : '';
    const rules = l.keyRules.length
      ? `<div class="edu-recap"><div class="edu-recap-head">🔑 Key rules from this lesson</div><ul>${l.keyRules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`
      : '';
    const navCard = (x, dir) => x
      ? `<button class="edu-navcard ${dir}" data-open="${x.id}"><span class="edu-navcard-dir">${dir === 'prev' ? '← Previous' : 'Next →'}</span><span class="edu-navcard-title">${esc(label(x))}</span><span class="edu-navcard-mod">${esc(moduleOf(x).label)}</span></button>`
      : '<span></span>';
    return (
      '<article class="edu-lesson">' +
        `<div class="edu-crumb"><a data-go="academy">Academy</a> › <a data-go="home">${esc(course.title)}</a> › <span>${esc(m.label)}${m.title !== m.label ? ' — ' + esc(m.title) : ''}</span> › <span>Lesson ${inMod + 1} of ${m.lessons.length}</span></div>` +
        `<h2 class="edu-lesson-title">${l.number ? `<span class="edu-lesson-no">${esc(l.number)}</span>` : ''}${esc(l.title === 'Overview' ? m.title : l.title)}</h2>` +
        `<div class="edu-lesson-meta"><span>⏱ ${l.minutes} min read</span>${l.figures ? `<span>📊 ${l.figures} chart${l.figures > 1 ? 's' : ''}</span>` : ''}${isDone ? '<span class="edu-done-badge">✓ Completed</span>' : ''}</div>` +
        outline +
        `<div class="edu-content">${l.html}</div>` +
        rules +
        '<div class="edu-finish">' +
          (isDone
            ? `<button class="edu-btn ghost" data-undone="${l.id}">✓ Completed — mark as not done</button>`
            : `<button class="edu-btn" data-complete="${l.id}">${next ? 'Mark complete & continue →' : 'Mark complete ✓'}</button>`) +
        '</div>' +
        `<div class="edu-pager">${navCard(prev, 'prev')}${navCard(next, 'next')}</div>` +
      '</article>'
    );
  }

  function glossaryHTML(q) {
    const items = course.glossary.filter(g => !q || (g.term + ' ' + g.def).toLowerCase().includes(q.toLowerCase()));
    let letter = '';
    return (
      '<article class="edu-lesson">' +
        `<div class="edu-crumb"><a data-go="academy">Academy</a> › <a data-go="home">${esc(course.title)}</a> › <span>Reference</span></div>` +
        '<h2 class="edu-lesson-title">Glossary <span class="edu-sub">— every term, in plain English</span></h2>' +
        '<input class="edu-gloss-filter" type="search" placeholder="Filter terms…" aria-label="Filter glossary">' +
        '<dl class="edu-gloss">' +
        items.sort((a, b) => a.term.localeCompare(b.term)).map(g => {
          const L = g.term[0].toUpperCase();
          const head = L !== letter ? `<div class="edu-gloss-letter">${esc((letter = L))}</div>` : '';
          return `${head}<div class="edu-gloss-item"><dt>${esc(g.term)}</dt><dd>${esc(g.def)}</dd></div>`;
        }).join('') +
        '</dl></article>'
    );
  }

  function searchHTML(q) {
    const ql = q.toLowerCase();
    const hits = lessons.map(l => {
      const inTitle = l.title.toLowerCase().includes(ql);
      const pos = l.text.toLowerCase().indexOf(ql);
      if (!inTitle && pos < 0) return null;
      const snip = pos >= 0 ? l.text.slice(Math.max(0, pos - 70), pos + 110) : l.text.slice(0, 160);
      return { l, inTitle, snip };
    }).filter(Boolean).sort((a, b) => b.inTitle - a.inTitle);
    const gl = course.glossary.filter(g => (g.term + ' ' + g.def).toLowerCase().includes(ql));
    const mark = s => esc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '&amp;'), 'gi'), x => `<mark>${x}</mark>`);
    return (
      '<article class="edu-lesson">' +
        `<h2 class="edu-lesson-title">Search <span class="edu-sub">“${esc(q)}” in ${esc(course.title)}</span></h2>` +
        (hits.length || gl.length ? '' : '<p class="edu-muted">No matches — try a shorter word.</p>') +
        hits.map(h => `<button class="edu-hit" data-open="${h.l.id}"><span class="edu-hit-mod">${esc(moduleOf(h.l).label)}</span><span class="edu-hit-title">${mark(label(h.l))}</span><span class="edu-hit-snip">…${mark(h.snip)}…</span></button>`).join('') +
        (gl.length ? '<h3 class="edu-section-title">Glossary</h3><dl class="edu-gloss">' + gl.map(g => `<div class="edu-gloss-item"><dt>${mark(g.term)}</dt><dd>${mark(g.def)}</dd></div>`).join('') + '</dl>' : '') +
      '</article>'
    );
  }

  // ── Behaviour ────────────────────────────────────────────────────
  function bindView() {
    const v = $('.edu-view');
    v.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => openLesson(b.dataset.open); });
    v.querySelectorAll('[data-go]').forEach(a => { a.onclick = () => go(a.dataset.go); });
    v.querySelectorAll('[data-course]').forEach(a => { a.onclick = () => openCourse(a.dataset.course); });
    v.querySelectorAll('[data-anchor]').forEach(a => {
      a.onclick = () => { const t = v.querySelector('#' + CSS.escape(a.dataset.anchor)); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    });
    v.querySelectorAll('[data-complete]').forEach(b => { b.onclick = () => setDone(b.dataset.complete, true); });
    v.querySelectorAll('[data-undone]').forEach(b => { b.onclick = () => setDone(b.dataset.undone, false); });
    v.querySelectorAll('.edu-fig img').forEach(img => { img.onclick = () => lightbox(img); });
    v.querySelectorAll('.edu-callout').forEach(c => {
      const t = [...c.classList].find(x => x.startsWith('edu-') && x !== 'edu-callout');
      const lab = c.querySelector('.edu-callout-label');
      if (lab && t) lab.textContent = `${CALLOUT_ICON[t.slice(4)] || ''} ${lab.textContent}`;
    });
    const gf = v.querySelector('.edu-gloss-filter');
    if (gf) gf.oninput = () => { const val = gf.value; v.innerHTML = glossaryHTML(val); bindView(); const n = v.querySelector('.edu-gloss-filter'); n.value = val; n.focus(); };
    if (view.kind === 'lesson') linkGlossary(v.querySelector('.edu-content'));
  }

  async function setDone(id, val) {
    try {
      await api('/api/education/progress', { lesson: id, done: val });
      if (val) done.add(id); else done.delete(id);
      const next = lessons[lessons.indexOf(lessonById(id)) + 1];
      if (val && next) openLesson(next.id);
      else { renderView(); refreshSidebar(); }
    } catch (e) { alert('Could not save progress: ' + e.message); }
  }

  // Underline the first mention of each glossary term in a lesson; hover/tap shows the definition.
  function linkGlossary(el) {
    if (!el || !glossaryRe) return;
    const defs = new Map(course.glossary.map(g => [g.term.toLowerCase(), g.def]));
    const seen = new Set();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement.closest('h3, figcaption, th, .edu-callout-label, .edu-box-title, abbr') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      glossaryRe.lastIndex = 0;
      let m, last = 0;
      const frag = document.createDocumentFragment();
      while ((m = glossaryRe.exec(text))) {
        const key = m[1].toLowerCase();
        // Short abbreviations (ATR, RSI) must match exactly; longer terms match any case.
        if (m[1].length <= 3 && !course.glossary.some(g => g.term === m[1])) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        frag.append(text.slice(last, m.index));
        const ab = document.createElement('abbr');
        ab.className = 'edu-term'; ab.tabIndex = 0; ab.textContent = m[1];
        ab.dataset.def = defs.get(key) || '';
        frag.append(ab);
        last = m.index + m[1].length;
      }
      if (last) { frag.append(text.slice(last)); node.replaceWith(frag); }
    }
  }

  function lightbox(img) {
    const fig = img.closest('figure');
    const box = document.createElement('div');
    box.className = 'edu-lightbox';
    box.innerHTML = `<button class="edu-lb-close" aria-label="Close">✕</button><img src="${img.src}" alt="${esc(img.alt)}"><div class="edu-lb-cap">${fig.querySelector('figcaption').innerHTML}</div>`;
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    box.onclick = e => { if (e.target === box || e.target.classList.contains('edu-lb-close')) close(); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
  }

  function updateReadBar() {
    const bar = root && root.querySelector('.edu-readbar span');
    if (!bar) return;
    const art = root.querySelector('.edu-lesson');
    if (view.kind !== 'lesson' || !art) { bar.style.width = '0'; return; }
    const r = art.getBoundingClientRect();
    const top = 64; // sticky topbar height
    bar.style.width = Math.max(0, Math.min(100, ((top - r.top) / Math.max(1, r.height - (window.innerHeight - top))) * 100)) + '%';
  }

  async function runSync() {
    const btn = $('.edu-sync'), msg = $('.edu-sync-msg');
    btn.disabled = true; btn.textContent = 'Syncing…'; msg.textContent = '';
    try {
      const id = course.id;
      const r = await api('/api/education/sync', { course: id });
      const [cat] = await Promise.all([api('/api/education/courses')]);
      catalog = cat.courses;
      cache.delete(id); course = null;
      await useCourse(id);
      if (view.kind === 'lesson' && !lessonById(view.id)) view = { kind: 'home' };
      render();
      $('.edu-sync-msg').textContent = `✓ Updated — ${r.stats.lessons} lessons, ${r.stats.figures} charts`;
    } catch (e) {
      btn.disabled = false; btn.textContent = '⟳ Sync from Google Doc';
      msg.textContent = '✕ ' + e.message;
    }
  }

  document.addEventListener('scroll', updateReadBar, true);
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (!root || view.kind !== 'lesson' || !root.offsetParent || (t && t.closest && t.closest('input, textarea, select'))) return;
    const idx = lessons.indexOf(lessonById(view.id));
    if (e.key === 'ArrowRight' && lessons[idx + 1]) openLesson(lessons[idx + 1].id);
    if (e.key === 'ArrowLeft' && lessons[idx - 1]) openLesson(lessons[idx - 1].id);
  });

  return { init, state: () => ({ view, course: course && course.id, courses: catalog.length, lessons: lessons.length, done: done.size, isAdmin }) };
})();
