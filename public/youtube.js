/* Latest videos from the Galin IVNV YouTube channel on the Overview page: newest first, click to play in place,
   re-checked every 5 minutes so a new upload appears on its own (marked NEW). */
(function () {
  'use strict';
  const REFRESH_MS = 5 * 60 * 1000;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  let root = null, data = null, filter = store.get('legionYtFilter', 'all'), playing = null, timer = null, checkedAt = 0;
  // videos seen on an earlier visit; anything else is NEW (first visit: nothing is marked)
  let seen = new Set(store.get('legionYtSeen', []));
  const firstVisit = !store.get('legionYtSeen', null);

  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 30 * 86400) { const d = Math.round(s / 86400); return d + (d === 1 ? ' day ago' : ' days ago'); }
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const views = n => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K' : String(n)) + ' views';

  function render() {
    if (!root || !data) return;
    const vids = data.videos.filter(v => filter === 'all' || (filter === 'shorts' ? v.short : !v.short));
    const count = k => data.videos.filter(v => (k === 'all' ? true : k === 'shorts' ? v.short : !v.short)).length;
    root.querySelector('.yt-head-right').innerHTML =
      [['all', 'All'], ['videos', 'Videos'], ['shorts', 'Shorts']].map(([k, l]) => `<button class="chart-tab${filter === k ? ' active' : ''}" data-yt="${k}">${l} <span>${count(k)}</span></button>`).join('') +
      `<a class="panel-action" href="${esc(data.channel.url)}" target="_blank" rel="noopener noreferrer">Open channel ↗</a>`;
    root.querySelector('.yt-grid').innerHTML = vids.length ? vids.map(v => `
      <div class="yt-card${v.short ? ' short' : ''}" data-id="${esc(v.id)}">
        <div class="yt-thumb">${playing === v.id
          ? `<iframe src="https://www.youtube-nocookie.com/embed/${esc(v.id)}?autoplay=1&rel=0" title="${esc(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`
          : `<button class="yt-play" data-play="${esc(v.id)}" aria-label="Play ${esc(v.title)}"><img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy"><span class="yt-btn">▶</span>${v.short ? '<span class="yt-tag">SHORT</span>' : ''}${!firstVisit && !seen.has(v.id) ? '<span class="yt-new">NEW</span>' : ''}</button>`}</div>
        <a class="yt-title" href="https://www.youtube.com/${v.short ? 'shorts/' : 'watch?v='}${esc(v.id)}" target="_blank" rel="noopener noreferrer">${esc(v.title)}</a>
        <div class="yt-meta">${ago(v.published)} · ${views(v.views)}</div>
      </div>`).join('') : '<div class="yt-empty">No videos yet.</div>';
    root.querySelector('.yt-foot').textContent = `Newest first · the ${data.videos.length} latest uploads of ${data.channel.name} · checked ${new Date(checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}, refreshes every 5 minutes`;
  }

  async function load() {
    try {
      const r = await fetch('/api/markets/youtube');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      data = d; checkedAt = Date.now();
      render();
      // remember what this visitor has now seen, so only later uploads get the NEW badge next time
      store.set('legionYtSeen', [...new Set([...seen, ...d.videos.map(v => v.id)])].slice(-200));
    } catch (e) {
      if (!data) root.querySelector('.yt-grid').innerHTML = `<div class="yt-empty">${esc(e.message)}</div>`;
    }
  }

  function init(id) {
    root = document.getElementById(id);
    if (!root || root.dataset.ready) return;
    root.dataset.ready = '1';
    root.innerHTML = `<div class="panel-header"><span class="panel-title">▶ Latest Videos — Galin IVNV</span><div class="yt-head-right"></div></div>
      <div class="yt-grid"><div class="yt-empty">Loading videos…</div></div><div class="yt-foot"></div>`;
    root.addEventListener('click', e => {
      const f = e.target.closest('[data-yt]');
      if (f) { filter = f.dataset.yt; store.set('legionYtFilter', filter); render(); return; }
      const p = e.target.closest('[data-play]');
      if (p) { playing = p.dataset.play; seen.add(playing); render(); }
    });
    load();
    timer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - checkedAt > REFRESH_MS) load(); });
  }

  window.LegionYouTube = { init, reload: load, _state: () => ({ filter, count: data?.videos.length, playing }) };
  // start by itself once the page is ready (this script loads after the dashboard's inline code)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init('yt-root'));
  else init('yt-root');
})();
