// Macro Flash banner: shows a just-released CPI / PPI / jobs headline within seconds of 08:30 ET.
// Polls /api/flash every 2 s around a scheduled release, every 30 s otherwise.
(function () {
  const SHOW_MS = 30 * 60000;
  let lastSeen = 0, el = null, timer = null;
  try { lastSeen = +localStorage.getItem('flashDismissed') || 0; } catch {}
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = r => (r.actual == null ? '—' : r.unit === 'K' ? (r.actual > 0 ? '+' : '') + r.actual + 'K' : (+r.actual).toFixed(1) + '%');
  const fmtF = r => (r.forecast == null ? '' : ` <span class="fl-exp">exp ${r.unit === 'K' ? r.forecast + 'K' : (+r.forecast).toFixed(1) + '%'}</span>`);

  function show(it) {
    if (!el) {
      el = document.createElement('div');
      el.className = 'flash-bar';
      el.setAttribute('role', 'alert');
      document.body.prepend(el);
      el.addEventListener('click', e => {
        if (e.target.closest('.fl-x')) { try { localStorage.setItem('flashDismissed', String(it.at)); } catch {} lastSeen = it.at; el.remove(); el = null; }
      });
    }
    el.dataset.tone = it.tone;
    el.innerHTML = `<div class="fl-head"><span class="fl-dot"></span><b>${esc(it.name)} · ${esc(it.period)}</b><span class="fl-verdict">${esc(it.verdict)}</span>` +
      `<span class="fl-time">${new Date(it.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><button class="fl-x" aria-label="Dismiss">×</button></div>` +
      `<div class="fl-rows">${it.rows.filter(r => r.actual != null).map(r => `<span><i>${esc(r.label)}</i> ${fmt(r)}${fmtF(r)}${r.diff > 0 ? ' ▲' : r.diff < 0 ? ' ▼' : ''}</span>`).join('')}</div>`;
  }

  async function poll() {
    let next = 30000;
    try {
      const d = await (await fetch('/api/flash', { cache: 'no-store' })).json();
      const it = d.items && d.items[0];
      if (it && it.at > lastSeen && Date.now() - it.at < SHOW_MS) {
        const fresh = !el || el.dataset.at !== String(it.at);
        show(it); el.dataset.at = String(it.at);
        if (fresh) window.dispatchEvent(new CustomEvent('legion:flash', { detail: it }));
      }
      const soon = d.next && d.next.at - d.now < 60000 && d.next.at - d.now > -5 * 60000;
      if (d.live || soon) next = 2000;
      else if (d.next && d.next.at - d.now < 30000 + 60000) next = Math.max(1000, d.next.at - d.now - 55000);
    } catch {}
    clearTimeout(timer); timer = setTimeout(poll, next);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();
})();
