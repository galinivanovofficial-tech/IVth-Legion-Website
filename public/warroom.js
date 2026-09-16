/* IVth Legion — War Room: fear & greed gauges, earnings + economic calendars (zero deps). */
(function () {
  const $ = id => document.getElementById(id);
  if (!$('warroom')) return;

  // ---------- Fear & Greed gauge ----------
  const BANDS = [
    { to: 25, color: '#ff5a4a', label: 'Extreme Fear' },
    { to: 45, color: '#f0a020', label: 'Fear' },
    { to: 55, color: '#c9c9d8', label: 'Neutral' },
    { to: 75, color: '#8fd14f', label: 'Greed' },
    { to: 100, color: '#46c05a', label: 'Extreme Greed' },
  ];
  const bandFor = v => BANDS.find(b => v <= b.to) || BANDS[BANDS.length - 1];

  function drawGauge(canvasId, value) {
    const cv = $(canvasId); if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = 300, h = 170;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = w / 2, cy = h - 18, r = 108;
    const a = f => Math.PI + f * Math.PI; // 0..1 -> PI..2PI
    let from = 0;
    for (const b of BANDS) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, a(from / 100), a(b.to / 100));
      ctx.lineWidth = 18; ctx.strokeStyle = b.color; ctx.globalAlpha = 0.85; ctx.stroke();
      from = b.to;
    }
    ctx.globalAlpha = 1;
    // ticks
    ctx.fillStyle = '#7777aa'; ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'center';
    for (const t of [0, 25, 50, 75, 100]) {
      const ang = a(t / 100), tr = r + 16;
      ctx.fillText(String(t), cx + Math.cos(ang) * tr, cy + Math.sin(ang) * tr + 3);
    }
    if (value == null) return;
    // needle
    const ang = a(Math.max(0, Math.min(100, value)) / 100);
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(r - 26, 0); ctx.lineTo(-6, -5);
    ctx.closePath(); ctx.fillStyle = '#e8e8f0'; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, 2 * Math.PI); ctx.fillStyle = '#c9a84c'; ctx.fill();
  }

  function drawSpark(canvasId, hist) {
    const cv = $(canvasId); if (!cv || !hist || hist.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || cv.parentElement.clientWidth || 280, h = 46;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const xs = i => i / (hist.length - 1) * (w - 4) + 2;
    const ys = v => h - 4 - (v / 100) * (h - 8);
    // band shading at 25/75
    ctx.fillStyle = 'rgba(255,90,74,0.06)'; ctx.fillRect(0, ys(25), w, h - ys(25));
    ctx.fillStyle = 'rgba(70,192,90,0.06)'; ctx.fillRect(0, 0, w, ys(75));
    ctx.beginPath();
    hist.forEach((p, i) => { const x = xs(i), y = ys(p.v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = '#c9a84c'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
    const last = hist[hist.length - 1];
    ctx.beginPath(); ctx.arc(xs(hist.length - 1), ys(last.v), 2.6, 0, 2 * Math.PI);
    ctx.fillStyle = bandFor(last.v).color; ctx.fill();
  }

  function paintFng(kind, d) {
    if (!d || d.value == null) { const t = $('fng' + kind + 'Tag'); if (t) t.textContent = 'unavailable'; return; }
    const band = bandFor(d.value);
    drawGauge('fng' + kind + 'Gauge', d.value);
    const val = $('fng' + kind + 'Value'); if (val) { val.textContent = Math.round(d.value); val.style.color = band.color; }
    const tag = $('fng' + kind + 'Tag'); if (tag) { tag.textContent = band.label; tag.style.color = band.color; }
    drawSpark('fng' + kind + 'Spark', d.history);
  }

  // ---------- Earnings ----------
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const WHEN = { bmo: '☀', amc: '🌙', tbd: '·' };
  function paintEarnings(days) {
    const host = $('earnWeeks'); if (!host) return;
    if (!days || !days.length) { host.innerHTML = '<div class="wr-loading">Earnings calendar unavailable right now.</div>'; return; }
    const today = new Date().toISOString().slice(0, 10);
    const weeks = { this: [], next: [] };
    days.forEach(d => weeks[d.week].push(d));
    let html = '';
    for (const [wk, list] of [['this', weeks.this], ['next', weeks.next]]) {
      html += '<div><div class="earn-week-label">' + (wk === 'this' ? 'This Week' : 'Next Week') + '</div><div class="earn-days">';
      list.forEach((d, i) => {
        const nice = new Date(d.date + 'T12:00:00Z');
        const dateLab = nice.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const top = d.rows.slice(0, 6);
        html += '<div class="earn-day' + (d.date === today ? ' today' : '') + '" data-date="' + d.date + '">' +
          '<div class="earn-day-head"><span>' + DOW[i] + '</span><span>' + dateLab + '</span></div>';
        if (!top.length) html += '<div class="earn-more" style="cursor:default">no majors</div>';
        for (const r of top) {
          html += '<div class="earn-row" title="' + (r.name || '') + (r.epsForecast ? ' · est ' + r.epsForecast : '') + '">' +
            '<span>' + (WHEN[r.when] || '·') + '</span><span class="sym">' + r.symbol + '</span>' +
            '<span class="mcap">' + (r.mcapFmt || '') + '</span></div>';
        }
        if (d.rows.length > 6) html += '<div class="earn-more" data-more="' + d.date + '">+' + (d.rows.length - 6) + ' more…</div>';
        html += '</div>';
      });
      html += '</div></div>';
    }
    host.innerHTML = html;
    host.querySelectorAll('[data-more]').forEach(el => el.addEventListener('click', () => {
      const day = days.find(d => d.date === el.dataset.more); if (!day) return;
      const box = el.parentElement;
      el.remove();
      let extra = '';
      for (const r of day.rows.slice(6)) {
        extra += '<div class="earn-row" title="' + (r.name || '') + '"><span>' + (WHEN[r.when] || '·') + '</span><span class="sym">' + r.symbol + '</span><span class="mcap">' + (r.mcapFmt || '') + '</span></div>';
      }
      box.insertAdjacentHTML('beforeend', extra);
    }));
  }

  // ---------- Economic calendar ----------
  function paintEcon(data) {
    const wk = $('econWeek'), key = $('econKey');
    if (wk) {
      const rows = (data.week || []).slice(0, 40);
      wk.innerHTML = rows.length ? rows.map(r => {
        const d = new Date(r.date);
        const when = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return '<div class="econ-row"><span class="econ-imp ' + r.impact + '"></span><span class="econ-when">' + when + '</span>' +
          '<span class="econ-cc">' + r.country + '</span><span>' + r.title + '</span>' +
          (r.forecast ? '<span class="econ-fx">f: ' + r.forecast + '</span>' : '') + '</div>';
      }).join('') : '<div class="wr-loading">No medium/high-impact events found this week.</div>';
    }
    if (key) {
      const rows = (data.keyDates || []).slice(0, 24);
      const CAT = { fed: '🏛', data: '📊', flows: '🔄', politics: '🗳', crypto: '₿' };
      key.innerHTML = rows.length ? rows.map(r => {
        const d = new Date(r.date + 'T12:00:00Z');
        const when = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return '<div class="econ-row"><span class="econ-imp ' + r.impact + '"></span><span class="econ-when">' + when + '</span>' +
          '<span class="econ-cc">' + (CAT[r.cat] || '') + '</span><span>' + r.title + '</span></div>';
      }).join('') : '<div class="wr-loading">Calendar unavailable.</div>';
    }
  }

  // ---------- load ----------
  function getJSON(url) { return fetch(url).then(r => { if (!r.ok) throw new Error(url); return r.json(); }); }
  let painted = false;
  function load() {
    if (painted) return; painted = true;
    drawGauge('fngCryptoGauge', null); drawGauge('fngStockGauge', null);
    getJSON('/api/markets/fng').then(d => { paintFng('Crypto', d.crypto); paintFng('Stock', d.stock); })
      .catch(() => { paintFng('Crypto', null); paintFng('Stock', null); });
    getJSON('/api/markets/earnings').then(d => paintEarnings(d.days)).catch(() => paintEarnings(null));
    getJSON('/api/markets/econ').then(paintEcon).catch(() => paintEcon({}));
  }
  // Lazy-load when the section approaches the viewport (also fires immediately if already visible).
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { load(); io.disconnect(); } }, { rootMargin: '600px' });
    io.observe($('warroom'));
  } else load();
  window.addEventListener('load', () => setTimeout(() => { if (!painted) load(); }, 4000));
})();
