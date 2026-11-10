/* Latest videos from the Galin IVNV YouTube channel on the Overview page: newest first, click opens YouTube,
   re-checked every 5 minutes so a new upload appears on its own (marked NEW). */
(function () {
  'use strict';
  const REFRESH_MS = 5 * 60 * 1000;
  const SHOW = 4; // only the 4 latest regular videos, no Shorts
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  let root = null, data = null, timer = null, checkedAt = 0;
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
    const vids = data.videos.filter(v => !v.short).slice(0, SHOW);
    root.querySelector('.yt-head-right').innerHTML =
      `<a class="panel-action" href="${esc(data.channel.url)}" target="_blank" rel="noopener noreferrer">Open channel ↗</a>`;
    root.querySelector('.yt-grid').innerHTML = vids.length ? vids.map(v => `
      <div class="yt-card${v.short ? ' short' : ''}" data-id="${esc(v.id)}">
        <a class="yt-thumb" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener noreferrer" data-open="${esc(v.id)}" aria-label="Watch ${esc(v.title)} on YouTube"><img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy"><span class="yt-btn">▶</span>${!firstVisit && !seen.has(v.id) ? '<span class="yt-new">NEW</span>' : ''}</a>
        <a class="yt-title" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener noreferrer" data-open="${esc(v.id)}">${esc(v.title)}</a>
        <div class="yt-meta">${ago(v.published)} · ${views(v.views)}</div>
      </div>`).join('') : '<div class="yt-empty">No videos yet.</div>';
    root.querySelector('.yt-foot').textContent = `The ${SHOW} latest videos of ${data.channel.name}, newest first · checked ${new Date(checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}, refreshes every 5 minutes`;
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
      const o = e.target.closest('[data-open]'); // opens on YouTube in a new tab; just stop calling it NEW
      if (o) { seen.add(o.dataset.open); setTimeout(render, 0); }
    });
    load();
    timer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - checkedAt > REFRESH_MS) load(); });
  }

  window.LegionYouTube = { init, reload: load, _state: () => ({ shown: root?.querySelectorAll('.yt-card').length }) };
  // start by itself once the page is ready (this script loads after the dashboard's inline code)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init('yt-root'));
  else init('yt-root');
})();
