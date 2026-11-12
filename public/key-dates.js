// Overview "Key Dates" panel: next FOMC, CPI, PPI, jobs, PCE, GDP and retail-sales release, with countdown,
// forecast / previous, and the last actual print. Data: /api/macro/keydates (TradingView economic calendar).
window.LegionKeyDates = (function () {
  'use strict';
  let data = null, loadedAt = 0, tick = null;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v, u, sc) => (v == null ? '—' : `${v}${sc || ''}${u === '%' ? '%' : u && u !== sc ? ' ' + u : ''}`);
  const short = t => t.replace('Inflation Rate', 'CPI').replace('Price Index ', '').replace('Non Farm Payrolls', 'NFP').replace('Average Hourly Earnings', 'Wages')
    .replace('Unemployment Rate', 'Unemployment').replace('Interest Rate', 'Fed funds').replace('Retail Sales', 'Retail').replace('GDP Growth Rate ', 'GDP ');

  function when(iso) {
    const t = Date.parse(iso), d = new Date(t), now = Date.now(), ms = t - now;
    const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    let left;
    if (ms <= 0) left = '<span class="kd-live">Releasing now</span>';
    else if (ms < 3600000) left = `in ${Math.ceil(ms / 60000)} min`;
    else if (ms < 86400000) left = `in ${Math.floor(ms / 3600000)}h ${Math.floor(ms % 3600000 / 60000)}m`;
    else left = `in ${Math.floor(ms / 86400000)}d ${Math.floor(ms % 86400000 / 3600000)}h`;
    return { day, time, left, soon: ms > 0 && ms < 86400000 };
  }

  function row(k) {
    if (!k.next) return '';
    const w = when(k.next), period = (k.nextItems.find(i => /MoM/.test(i.title)) || k.nextItems[0] || {}).period || '';
    const fp = i => [i.forecast != null ? `forecast ${num(i.forecast, i.unit, i.scale)}` : '', i.previous != null ? `prev ${num(i.previous, i.unit, i.scale)}` : ''].filter(Boolean).join(' · ');
    const next = k.nextItems.map(i => `<span class="kd-item"><b>${esc(short(i.title))}</b> ${esc(fp(i))}</span>`).join('');
    const last = k.lastItems.filter(i => i.actual != null).slice(0, 2).map(i => `${esc(short(i.title))} ${esc(num(i.actual, i.unit, i.scale))}`).join(' · ');
    return `<div class="kd-row${w.soon ? ' soon' : ''}">
      <div class="kd-when"><span class="kd-day">${esc(w.day)}</span><span class="kd-time">${esc(w.time)}</span></div>
      <div class="kd-main"><div class="kd-label">${esc(k.label)}${period ? ` <span class="kd-period">${esc(period)}</span>` : ''}</div>
        ${next ? `<div class="kd-items">${next}</div>` : ''}
        ${last ? `<div class="kd-last">Last: ${last}</div>` : ''}</div>
      <div class="kd-left">${w.left}</div></div>`;
  }

  function render() {
    const el = document.getElementById('keydates-root');
    if (!el || !data) return;
    const rows = data.filter(k => k.next).sort((a, b) => a.next.localeCompare(b.next));
    el.innerHTML = rows.length ? rows.map(row).join('') : '<div class="kd-empty">No scheduled releases found.</div>';
  }

  async function init() {
    const el = document.getElementById('keydates-root');
    if (!el) return;
    if (!data || Date.now() - loadedAt > 10 * 60000) {
      try {
        const r = await fetch('/api/macro/keydates');
        if (!r.ok) throw new Error();
        data = (await r.json()).dates; loadedAt = Date.now();
      } catch { if (!data) { el.innerHTML = '<div class="kd-empty">Key dates are unavailable right now.</div>'; return; } }
    }
    render();
    if (!tick) tick = setInterval(() => { if (Date.now() - loadedAt > 10 * 60000) init(); else render(); }, 60000);
  }
  return { init };
})();
