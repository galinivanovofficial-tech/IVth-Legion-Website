/* Channel Insights (admins): what the IVth Legion channel talks about, by asset and indicator, week by week.
   Data from /api/insights/*; refreshes every 5 minutes so new channel posts show up on their own. */
(function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLORS = ['#c9a84c', '#4f8df7', '#e07a5f', '#2ec4b6', '#a78bfa', '#f5a623', '#ef4f5a', '#8a8fa8'];
  const CLS = { crypto: '#f5a623', stock: '#4f8df7', etf: '#5aa9e6', index: '#a78bfa', commodity: '#c9a84c', macro: '#2ec4b6', other: '#8a8fa8' };
  const fmtDay = ts => (ts ? new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const fmtWeek = ts => new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  let root, data, weeks = 0, mode = 'assets', zoom = null, geo = null, hover = null, drill = null, timer = null;

  async function get(url) { const r = await fetch(url); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status); return d; }

  async function load() {
    try { data = await get('/api/insights/summary' + (weeks ? '?weeks=' + weeks : '')); render(); }
    catch (e) { root.innerHTML = `<div class="ins-empty">${esc(e.message)}</div>`; }
  }

  function render() {
    const t = data.totals, b = data.bot;
    const live = b.configured && b.running && !b.error;
    root.innerHTML = `
      <div class="ins-top">
        <div class="ins-kpis">
          <div><b>${t.posts}</b><span>posts with text${weeks ? ` (last ${weeks} weeks)` : ''}</span></div>
          <div><b>${t.assets}</b><span>assets mentioned</span></div>
          <div><b>${t.indicators}</b><span>indicators used</span></div>
          <div><b>${fmtDay(t.lastPost)}</b><span>latest post</span></div>
          <div class="ins-live ${live ? 'on' : 'off'}"><b>${live ? '● Live' : b.configured ? '● Bot error' : '○ Not connected'}</b>
            <span>${live ? `@${esc(b.username)} receives new posts` : b.configured ? esc(b.error || 'starting…') : 'add the bot to read new posts'}</span></div>
        </div>
        <div class="tt-chips">${[[4, '4w'], [12, '12w'], [26, '6m'], [52, '1y'], [0, 'All']].map(([v, l]) => `<button class="tt-chip${weeks === v ? ' on' : ''}" data-weeks="${v}">${l}</button>`).join('')}</div>
      </div>
      ${weekCard()}
      <div class="panel ins-panel"><div class="panel-header"><span class="panel-title">📅 Mentions per week</span>
        <div class="tt-chips">${[['assets', 'Assets'], ['indicators', 'Indicators']].map(([k, l]) => `<button class="tt-chip${mode === k ? ' on' : ''}" data-mode="${k}">${l}</button>`).join('')}</div></div>
        <div class="ins-legend">${Object.keys(series()).map((n, i) => `<span><i style="background:${COLORS[i]}"></i>${esc(n)}</span>`).join('')}</div>
        <div class="ins-chart"><canvas></canvas><div class="ins-tip"></div></div>
        <p class="ins-note">Each bar is one week (Mon–Sun), stacked by the top ${mode}. Drag across the chart to zoom into weeks, right-click to reset; click a bar segment to see those posts.</p></div>
      <div class="ins-grid">
        <div class="panel ins-panel"><div class="panel-header"><span class="panel-title">🏷 Most-mentioned assets</span></div>${bars(data.assets.slice(0, 15), a => a.sym, a => CLS[a.cls], 'asset', a => `${a.cls} · last ${fmtDay(a.last)}`)}</div>
        <div class="panel ins-panel"><div class="panel-header"><span class="panel-title">📐 Most-used indicators</span></div>${bars(data.indicators.slice(0, 15), i => i.name, () => '#c9a84c', 'indicator')}
          ${data.variants.length ? `<div class="ins-variants"><span>Moving averages:</span>${data.variants.slice(0, 8).map(v => `<em>${esc(v.name)} <b>${v.n}</b></em>`).join('')}</div>` : ''}</div>
      </div>
      <div class="panel ins-panel"><div class="panel-header"><span class="panel-title">🔗 Which indicator for which asset</span><span class="panel-badge">click a number</span></div>${matrix()}</div>
      <div class="panel ins-panel" id="ins-drill">${drillHtml()}</div>`;
    drawChart();
  }

  function weekCard() {
    const tw = data.thisWeek, lw = data.lastWeek;
    const list = (arr) => arr.length ? arr.map(([n, c]) => `<em>${esc(n)} <b>${c}</b></em>`).join('') : '<span class="ins-dim">—</span>';
    return `<div class="ins-week">
      <div><h4>This week <span>${tw.posts} posts</span></h4><div class="ins-tags">${list(tw.assets)}</div><div class="ins-tags">${list(tw.indicators)}</div></div>
      <div><h4>Last week <span>${lw.posts} posts</span></h4><div class="ins-tags">${list(lw.assets)}</div><div class="ins-tags">${list(lw.indicators)}</div></div></div>`;
  }

  function bars(items, label, color, kind, sub) {
    if (!items.length) return '<div class="ins-empty">Nothing in this period.</div>';
    const max = items[0].n;
    return `<div class="ins-bars">${items.map(it => `<button class="ins-bar" data-${kind}="${esc(label(it))}" title="${sub ? esc(sub(it)) : ''}">
      <span class="ins-bar-l">${esc(label(it))}</span><span class="ins-bar-t"><i style="width:${(it.n / max * 100).toFixed(1)}%;background:${color(it)}"></i></span><b>${it.n}</b></button>`).join('')}</div>`;
  }

  function matrix() {
    const rows = data.assets.slice(0, 12).map(a => a.sym), cols = data.indicators.slice(0, 10).map(i => i.name);
    if (!rows.length || !cols.length) return '<div class="ins-empty">Nothing in this period.</div>';
    const n = new Map(data.pairs.map(p => [p.sym + '|' + p.ind, p.n]));
    const max = Math.max(1, ...data.pairs.map(p => p.n));
    return `<div class="ins-mx-wrap"><table class="ins-mx"><thead><tr><th></th>${cols.map(c => `<th><span>${esc(c)}</span></th>`).join('')}</tr></thead><tbody>
      ${rows.map(r => `<tr><th>${esc(r)}</th>${cols.map(c => { const v = n.get(r + '|' + c) || 0;
        const a = 0.12 + 0.8 * v / max;
        return `<td>${v ? `<button data-asset="${esc(r)}" data-indicator="${esc(c)}" style="background:rgba(201,168,76,${a.toFixed(2)});color:${a < 0.45 ? '#e8e8f0' : '#111'}">${v}</button>` : ''}</td>`; }).join('')}</tr>`).join('')}
      </tbody></table></div>`;
  }

  function drillHtml() {
    if (!drill) return '<div class="panel-header"><span class="panel-title">📝 Posts</span></div><div class="ins-empty">Click an asset, an indicator, a number in the table or a bar in the weekly chart to see the posts behind it.</div>';
    const title = [drill.asset, drill.indicator, drill.week ? 'week of ' + fmtWeek(drill.week) : ''].filter(Boolean).join(' · ');
    const hl = s => { let h = esc(s); for (const w of [drill.asset, drill.indicator].filter(Boolean)) h = h.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>'); return h; };
    return `<div class="panel-header"><span class="panel-title">📝 ${esc(title)}</span><span class="panel-badge">${drill.posts ? drill.posts.length + ' posts' : 'loading…'}</span></div>
      <div class="ins-posts">${(drill.posts || []).map(p => `<div class="ins-post"><div class="ins-post-h">${fmtDay(p.date)}
        ${p.assets.map(a => `<em>${esc(a)}</em>`).join('')}${p.url ? ` <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">open in Telegram ↗</a>` : ''}</div>
        <div class="ins-post-t">${hl(p.text)}</div></div>`).join('') || '<div class="ins-empty">No posts.</div>'}</div>`;
  }

  async function openDrill(q) {
    drill = { ...q, posts: null };
    const el = root.querySelector('#ins-drill'); el.innerHTML = drillHtml(); el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v));
    try { drill.posts = (await get('/api/insights/posts?' + params)).posts; } catch { drill.posts = []; }
    root.querySelector('#ins-drill').innerHTML = drillHtml();
  }

  const series = () => (mode === 'assets' ? data.assetSeries : data.indicatorSeries);

  function drawChart() {
    const cv = root.querySelector('.ins-chart canvas'), W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const S = series(), names = Object.keys(S), all = data.weeks;
    const i0 = zoom ? zoom[0] : 0, i1 = zoom ? zoom[1] : all.length - 1;
    const L = 36, R = 10, T = 10, B = 26, pw = W - L - R, ph = H - T - B, n = Math.max(1, i1 - i0 + 1), bw = pw / n;
    let max = 1;
    for (let i = i0; i <= i1; i++) max = Math.max(max, names.reduce((s, k) => s + S[k][i], 0));
    const Y = v => T + ph - (v / max) * ph;
    geo = { L, pw, i0, i1, bw, T, ph };
    g.font = '10px Inter, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'right';
    const step = Math.max(1, Math.ceil(max / 5));
    for (let v = 0; v <= max; v += step) { g.strokeStyle = 'rgba(255,255,255,0.05)'; g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + pw, Y(v)); g.stroke(); g.fillStyle = '#6f7391'; g.fillText(v, L - 6, Y(v)); }
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const every = Math.max(1, Math.ceil(n / Math.floor(pw / 60)));
    for (let i = i0; i <= i1; i++) {
      const x = L + (i - i0) * bw; let acc = 0;
      names.forEach((k, j) => { const v = S[k][i]; if (!v) return; g.fillStyle = COLORS[j]; g.fillRect(x + bw * 0.12, Y(acc + v), bw * 0.76, Y(acc) - Y(acc + v) - 1); acc += v; });
      if (hover === i) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(x, T, bw, ph); }
      if ((i - i0) % every === 0) { g.fillStyle = '#6f7391'; g.fillText(fmtWeek(all[i]), Math.max(L + 20, Math.min(L + pw - 20, x + bw / 2)), H - 8); }
    }
    if (zoom) { g.fillStyle = '#e8c96a'; g.textAlign = 'right'; g.font = '600 10px Inter, sans-serif'; g.fillText('Zoomed: right-click to reset', L + pw, T + 10); }
    const tip = root.querySelector('.ins-tip');
    if (hover != null && hover >= i0 && hover <= i1) {
      const rows = names.map((k, j) => [k, S[k][hover], COLORS[j]]).filter(r => r[1]);
      tip.innerHTML = `<b>Week of ${fmtWeek(all[hover])}</b>` + (rows.length ? rows.map(([k, v, c]) => `<div><i style="background:${c}"></i>${esc(k)} <b>${v}</b></div>`).join('') : '<div>no mentions</div>');
      tip.style.display = 'block';
      tip.style.left = Math.min(W - tip.offsetWidth - 4, L + (hover - i0 + 1) * bw + 8) + 'px';
    } else tip.style.display = 'none';
  }

  function attachChart() {
    const cv = root.querySelector('.ins-chart canvas');
    const idx = e => { const x = e.clientX - cv.getBoundingClientRect().left; return geo ? Math.floor((x - geo.L) / geo.bw) + geo.i0 : null; };
    cv.onmousemove = e => { const i = idx(e); hover = geo && i >= geo.i0 && i <= geo.i1 ? i : null; drawChart(); };
    cv.onmouseleave = () => { hover = null; drawChart(); };
    cv.onclick = e => { const i = idx(e); if (geo && i >= geo.i0 && i <= geo.i1) openDrill({ week: data.weeks[i] }); };
    if (window.LegionZoom) LegionZoom.attach(cv, {
      plot: () => (geo ? { l: geo.L, r: geo.L + geo.pw } : { l: 0, r: 0 }),
      onZoom: (a, b) => { const f = x => Math.floor((x - geo.L) / geo.bw) + geo.i0; zoom = [Math.max(0, f(a)), Math.min(data.weeks.length - 1, Math.max(f(a) + 1, f(b)))]; drawChart(); },
      onReset: () => { zoom = null; drawChart(); },
    });
  }

  function init(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (root === el) { load(); return; }
    root = el;
    root.innerHTML = '<div class="ins-empty">Loading channel insights…</div>';
    root.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.weeks != null) { weeks = +b.dataset.weeks; zoom = null; load(); }
      else if (b.dataset.mode) { mode = b.dataset.mode; zoom = null; render(); attachChart(); }
      else if (b.dataset.asset || b.dataset.indicator) openDrill({ asset: b.dataset.asset || '', indicator: b.dataset.indicator || '' });
    });
    const origRender = render;
    render = function () { origRender(); attachChart(); }; // eslint-disable-line no-func-assign
    window.addEventListener('resize', () => { if (root.offsetParent && data) drawChart(); });
    load();
    timer = setInterval(() => { if (root.offsetParent && !document.hidden) load(); }, 5 * 60 * 1000);
  }

  window.LegionInsights = { init, _data: () => data };
})();
