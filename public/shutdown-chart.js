/* BTC around US government shutdowns: BTC's path in the days before (and during / after) each federal funding
   lapse, aligned on the first day of the shutdown, plus the next possible one (funding deadline).
   Same mechanics as the mega-IPO chart: windows, 0% line, legend toggles, zoom, hover, stats table. */
(function () {
  'use strict';

  const DAY = 864e5;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  const NEXT_DEFAULT = '2026-12-12'; // funding runs through Dec 11, 2026 (CR signed Sep 2, 2026)
  // start = first day without funding; days = official length (Wikipedia, government shutdowns in the US), so
  // start + days is the first day the government was funded again (the ring on each line).
  const EVENTS = [
    { id: 'next', name: 'Next possible shutdown', color: '#c9a84c', upcoming: true, note: 'Funding runs through Dec 11, 2026. If Congress does not pass a bill, the shutdown starts Dec 12. Pick another date if the deadline moves.' },
    { id: 's2025', name: 'Oct–Nov 2025', start: '2025-10-01', days: 43, color: '#e07a5f', kind: 'Full', note: '43 days, the longest full shutdown. ~900,000 workers furloughed; October CPI was never collected.' },
    { id: 's2018', name: 'Dec 2018–Jan 2019', start: '2018-12-22', days: 35, color: '#2ec4b6', kind: 'Partial', note: '35 days, partial: about a quarter of the government unfunded.' },
    { id: 's2013', name: 'Oct 2013', start: '2013-10-01', days: 16, color: '#5aa9e6', kind: 'Full', note: '16 days, full shutdown; ~800,000 furloughed.' },
    { id: 's2018a', name: 'Jan 2018', start: '2018-01-20', days: 3, color: '#9b8cff', kind: 'Full', short: true, note: '3 days over a weekend.' },
    { id: 's2026a', name: 'Jan–Feb 2026', start: '2026-01-31', days: 4, color: '#8a8fa8', kind: 'Partial', short: true, note: '4 days, about half of federal departments.' },
    { id: 's2026b', name: 'DHS 2026', start: '2026-02-14', days: 76, color: '#b56576', kind: 'DHS only', short: true, note: '76 days, Homeland Security only (ICE and Border Patrol kept running).' },
  ];

  const opt = Object.assign({ before: 30, after: 30, base: 'start', next: NEXT_DEFAULT, short: false, hidden: [] }, store.get('legionShutdown', {}));
  opt.base = 'start'; // every visit starts with 0% at the start of the chart
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opt.next || '')) opt.next = NEXT_DEFAULT;
  const save = () => store.set('legionShutdown', opt);

  let root = null, canvas = null, tip = null, data = null, close = null, lastDay = null, plotted = [], geo = null, hoverK = null;
  let zoom = null; // [fromDay, toDay] relative to shutdown day while zoomed in

  const toDay = s => Date.parse(s + 'T00:00:00Z');
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const startOf = ev => (ev.id === 'next' ? opt.next : ev.start);
  const lenOf = ev => ev.days ?? null;
  const fmtPct = v => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
  const fmtUsd = v => (v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US'));
  const fmtDate = s => new Date(toDay(s)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const kLabel = k => (k === 0 ? 'Start' : (k > 0 ? 'D+' : 'D') + k);

  function closeAt(t) {
    for (let k = 0; k < 5; k++) { const v = close.get(iso(t - k * DAY)); if (v != null) return v; }
    return null;
  }

  function series(ev) {
    const d = startOf(ev);
    if (!d) return null;
    const D = toDay(d), first = D - opt.before * DAY, last = Math.min(D + opt.after * DAY, lastDay);
    if (first > lastDay) return { ev, D, pts: [], futureStart: true };
    let baseT = first, baseNote = 'window start';
    if (opt.base === 'd30') { baseT = D - 30 * DAY; baseNote = 'D−30'; }
    if (opt.base === 'start0') { baseT = D; baseNote = 'shutdown day'; }
    if (baseT > lastDay) { baseT = lastDay; baseNote = 'today (not reached yet)'; }
    const base = closeAt(baseT);
    const pts = [];
    for (let t = first; t <= last; t += DAY) {
      const v = closeAt(t);
      if (v != null && base) pts.push({ k: Math.round((t - D) / DAY), t, v, pct: (v / base - 1) * 100 });
    }
    return { ev, D, pts, base, baseNote, upcoming: D > lastDay, len: lenOf(ev) };
  }

  function stats(s) {
    const { D } = s, get = t => (t <= lastDay ? closeAt(t) : null);
    const pB = get(D - opt.before * DAY), p30 = get(D - 30 * DAY), p0 = get(D), now = closeAt(lastDay), p30a = get(D + 30 * DAY);
    const pEnd = s.len != null ? get(D + s.len * DAY) : null;
    const endPre = D <= lastDay ? p0 : now;
    let peak = -Infinity, dd = 0;
    for (let t = D - 30 * DAY; t <= Math.min(D, lastDay); t += DAY) {
      const v = closeAt(t); if (v == null) continue;
      peak = Math.max(peak, v); dd = Math.min(dd, (v / peak - 1) * 100);
    }
    return {
      pre: opt.before > 30 && pB && p30 ? (p30 / pB - 1) * 100 : null,
      last30: p30 && endPre ? (endPre / p30 - 1) * 100 : null,
      during: p0 && pEnd ? (pEnd / p0 - 1) * 100 : null,
      after30: p0 && p30a ? (p30a / p0 - 1) * 100 : null,
      dd: p30 ? dd : null,
      daysTo: Math.round((D - lastDay) / DAY),
    };
  }

  function chip(group, value, label, on) {
    return `<button class="chart-tab${on ? ' active' : ''}" data-${group}="${value}">${label}</button>`;
  }

  function renderControls() {
    root.querySelector('.ipo-ctl').innerHTML = `
      <div class="ipo-row"><span class="ipo-lbl">Days before</span>${[90, 60, 30].map(v => chip('before', v, v + 'd', opt.before === v)).join('')}
        <span class="ipo-lbl">After</span>${[0, 30, 90].map(v => chip('after', v, v ? '+' + v + 'd' : 'none', opt.after === v)).join('')}
        <span class="ipo-lbl">0% line at</span>${[['start', 'Start of chart'], ['d30', 'D−30'], ['start0', 'Shutdown day']].map(([v, l]) => chip('base', v, l, opt.base === v)).join('')}</div>
      <div class="ipo-row">
        <label class="ipo-lbl" for="sdNext">Next shutdown day</label>
        <input id="sdNext" class="ipo-input" type="date" value="${esc(opt.next)}" min="2026-11-01" max="2028-12-31">
        ${opt.next !== NEXT_DEFAULT ? '<button class="chart-tab" data-reset="next">Reset to Dec 12</button>' : ''}
        <label class="ipo-check"><input type="checkbox" id="sdShort"${opt.short ? ' checked' : ''}> Short / partial lapses (Jan 2018, Jan–Feb 2026, DHS 2026)</label>
      </div>
      <div class="ipo-legend">${EVENTS.filter(e => !e.short || opt.short).map(e => {
        const off = opt.hidden.includes(e.id), len = lenOf(e);
        const sub = e.upcoming ? fmtDate(opt.next) + ' (possible)' : fmtDate(e.start) + ' · ' + len + 'd';
        return `<button class="ipo-key${off ? ' off' : ''}" data-key="${e.id}" title="${esc(e.note || '')}"><i style="background:${e.color}"></i>${esc(e.name)} <span>${sub}</span></button>`;
      }).join('')}</div>`;
  }

  function renderStats() {
    const rows = plotted.filter(s => s.pts.length || s.futureStart).map(s => {
      const st = stats(s), e = s.ev;
      const when = st.daysTo > 0 ? `in ${st.daysTo} days` : st.daysTo === 0 ? 'today' : `${-st.daysTo} days ago`;
      const cls = v => (v == null ? '' : v >= 0 ? 'up' : 'down');
      return `<tr><td><i class="ipo-dot" style="background:${e.color}"></i><b>${esc(e.name)}</b> <span class="ipo-dim">${esc(e.upcoming ? 'possible' : e.kind + ' · ' + s.len + 'd')}</span></td>
        <td>${fmtDate(startOf(e))}<br><span class="ipo-dim">${when}</span></td>
        ${opt.before > 30 ? `<td class="r ${cls(st.pre)}">${s.futureStart ? '—' : fmtPct(st.pre)}</td>` : ''}
        <td class="r ${cls(st.last30)}">${fmtPct(st.last30)}${st.daysTo > 0 && st.last30 != null ? '<br><span class="ipo-dim">so far</span>' : ''}</td>
        <td class="r ${cls(st.dd)}">${fmtPct(st.dd)}</td>
        <td class="r ${cls(st.during)}">${fmtPct(st.during)}</td>
        <td class="r ${cls(st.after30)}">${fmtPct(st.after30)}</td></tr>`;
    }).join('');
    root.querySelector('.ipo-stats').innerHTML = rows ? `<table class="ipo-table"><thead><tr><th>Shutdown</th><th>First day</th>
      ${opt.before > 30 ? `<th class="r" title="BTC change from the window start to 30 days before the shutdown">D−${opt.before} → D−30</th>` : ''}
      <th class="r" title="BTC change over the final 30 days into the shutdown">D−30 → Start</th>
      <th class="r" title="Deepest fall from a high within the final 30 days">Max drawdown, last 30d</th>
      <th class="r" title="BTC change from the first day of the shutdown to the day the government reopened">During shutdown</th>
      <th class="r" title="BTC change in the 30 days after the shutdown began">Start → D+30</th></tr></thead><tbody>${rows}</tbody></table>` : '';
  }

  function draw() {
    if (!canvas || !data) return;
    plotted = EVENTS.filter(e => !e.short || opt.short).map(series).filter(Boolean);
    let shown = plotted.filter(s => s.pts.length && !opt.hidden.includes(s.ev.id));
    const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const L = 8, R = 58, T = 14, B = 28, pw = W - L - R, ph = H - T - B;
    const k0 = zoom ? zoom[0] : -opt.before, k1 = zoom ? zoom[1] : opt.after;
    if (opt.base === 'start' && zoom) shown = shown.map(s => { const f = s.pts.find(p => p.k >= k0);
      return f ? { ...s, pts: s.pts.map(p => ({ ...p, pct: (p.v / f.v - 1) * 100 })) } : s; });
    let lo = zoom ? Infinity : 0, hi = zoom ? -Infinity : 0;
    for (const s of shown) for (const p of s.pts) if (p.k >= k0 && p.k <= k1) { lo = Math.min(lo, p.pct); hi = Math.max(hi, p.pct); }
    if (lo === Infinity) { lo = -1; hi = 1; }
    const pad = (hi - lo || 10) * 0.08; lo -= pad; hi += pad;
    const X = k => L + ((k - k0) / (k1 - k0 || 1)) * pw, Y = v => T + (1 - (v - lo) / (hi - lo)) * ph;
    geo = { L, pw, k0, k1, X, Y, T, ph };
    g.font = '10px Inter, sans-serif';
    // final 30 days before the shutdown
    if (k0 < 0) { g.fillStyle = 'rgba(201,168,76,0.06)'; g.fillRect(X(Math.max(k0, -30)), T, X(Math.min(0, k1)) - X(Math.max(k0, -30)), ph); }
    // grid + y labels
    const step = [1, 2, 5, 10, 20, 25, 50, 100].find(s => (hi - lo) / s <= 8) || 100;
    g.textBaseline = 'middle'; g.textAlign = 'left';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      g.strokeStyle = v === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.05)';
      g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + pw, Y(v)); g.stroke();
      g.fillStyle = '#6f7391'; g.fillText((v > 0 ? '+' : '') + v + '%', L + pw + 6, Y(v));
    }
    // x labels
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const span = k1 - k0 || 1, xs = [1, 2, 5, 10, 15, 30, 60].find(v => (pw / span) * v >= 44) || 60; // labels at least 44px apart
    for (let k = Math.ceil(k0 / xs) * xs; k <= k1; k += xs) {
      g.fillStyle = k === 0 ? '#e8c96a' : '#6f7391';
      g.fillText(kLabel(k), Math.max(L + 18, Math.min(L + pw - 18, X(k))), H - 8);
    }
    const vline = (k, color, label, dash) => {
      if (k < k0 || k > k1) return;
      g.setLineDash(dash || []); g.strokeStyle = color; g.beginPath(); g.moveTo(X(k), T); g.lineTo(X(k), T + ph); g.stroke(); g.setLineDash([]);
      g.fillStyle = color; g.textAlign = 'left'; g.fillText(label, X(k) + 4, T + 10);
    };
    if (k0 < -30) vline(-30, 'rgba(201,168,76,0.45)', 'D−30', [4, 4]);
    vline(0, '#c9a84c', 'Shutdown starts');
    // lines
    g.save(); g.beginPath(); g.rect(L, T - 6, pw, ph + 12); g.clip();
    for (const s of shown) {
      const short = s.ev.short;
      g.strokeStyle = s.ev.color; g.lineWidth = short ? 1.3 : 2.2; g.globalAlpha = short ? 0.75 : 1;
      if (short) g.setLineDash([5, 3]);
      g.beginPath();
      s.pts.forEach((p, n) => (n ? g.lineTo(X(p.k), Y(p.pct)) : g.moveTo(X(p.k), Y(p.pct))));
      g.stroke(); g.setLineDash([]); g.globalAlpha = 1; g.lineWidth = 1;
      // the day the government reopened: hollow ring on the line
      const e = s.len != null ? s.pts.find(p => p.k === s.len) : null;
      if (e) { g.strokeStyle = s.ev.color; g.fillStyle = '#0d0d18'; g.lineWidth = 2; g.beginPath(); g.arc(X(e.k), Y(e.pct), 4, 0, 7); g.fill(); g.stroke(); g.lineWidth = 1; }
      if (s.upcoming && s.pts.length) { // where we are today before the possible shutdown
        const p = s.pts[s.pts.length - 1];
        g.fillStyle = s.ev.color; g.beginPath(); g.arc(X(p.k), Y(p.pct), 4, 0, 7); g.fill();
        g.font = '600 10px Inter, sans-serif'; g.textAlign = 'left';
        g.fillText(`today D${p.k}`, Math.min(X(p.k) + 7, L + pw - 60), Y(p.pct) - 8); g.font = '10px Inter, sans-serif';
      }
    }
    g.restore();
    if (zoom) { g.fillStyle = '#e8c96a'; g.textAlign = 'right'; g.font = '600 10px Inter, sans-serif'; g.fillText('Zoomed: right-click to reset', L + pw - 4, T + 10); g.font = '10px Inter, sans-serif'; }
    if (!shown.length) { g.fillStyle = '#7777aa'; g.textAlign = 'center'; g.fillText('No shutdown in view: turn one on in the legend.', L + pw / 2, T + ph / 2); }
    // crosshair
    if (hoverK != null && hoverK >= k0 && hoverK <= k1) {
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(X(hoverK), T); g.lineTo(X(hoverK), T + ph); g.stroke(); g.setLineDash([]);
      const lines = shown.map(s => ({ s, p: s.pts.find(p => p.k === hoverK) })).filter(x => x.p);
      for (const { s, p } of lines) { g.fillStyle = s.ev.color; g.beginPath(); g.arc(X(p.k), Y(p.pct), 3, 0, 7); g.fill(); }
      const state = s => (hoverK < 0 ? '' : s.len == null ? '' : hoverK < s.len ? ' · shut' : hoverK === s.len ? ' · reopened' : ' · reopened ' + (hoverK - s.len) + 'd ago');
      tip.style.display = lines.length ? 'block' : 'none';
      tip.innerHTML = `<b>${hoverK === 0 ? 'Shutdown day' : kLabel(hoverK)}</b>` + lines.map(({ s, p }) =>
        `<div><i style="background:${s.ev.color}"></i>${esc(s.ev.name)}: <b>${fmtPct(p.pct)}</b> <span>${fmtUsd(p.v)} · ${fmtDate(iso(p.t))}${state(s)}</span></div>`).join('');
      const x = X(hoverK);
      tip.style.left = Math.max(4, Math.min(W - tip.offsetWidth - 4, x + 12)) + 'px';
    } else tip.style.display = 'none';
  }

  function render() { renderControls(); draw(); renderStats(); }

  async function init() {
    root = document.getElementById('sd-root');
    if (!root) return;
    if (canvas) { render(); return; }
    root.innerHTML = `<div class="ipo-ctl"></div><div class="ipo-wrap"><canvas></canvas><div class="ipo-tip"></div></div>
      <div class="ipo-stats"></div>
      <p class="ipo-note">Each line is BTC's price path aligned on the first day of a US government shutdown (Start); D−30 means 30 days before funding ran out. The shaded area is the final 30 days into the shutdown, and the ring on each line marks the day the government reopened. The gold line is the next possible shutdown: funding runs through Dec 11, 2026, so a lapse would start Dec 12 (change the date if the deadline moves). With only a handful of shutdowns this is context, not a signal. Hover the chart for prices; click and drag across it to zoom in, right-click to reset; click a name in the legend to hide it. BTC data: Bitstamp daily closes. Shutdown dates: Wikipedia.</p>`;
    canvas = root.querySelector('canvas'); tip = root.querySelector('.ipo-tip');
    root.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.before) opt.before = +b.dataset.before;
      else if (b.dataset.after) opt.after = +b.dataset.after;
      else if (b.dataset.base) opt.base = b.dataset.base;
      else if (b.dataset.key) opt.hidden = opt.hidden.includes(b.dataset.key) ? opt.hidden.filter(x => x !== b.dataset.key) : [...opt.hidden, b.dataset.key];
      else if (b.dataset.reset) opt.next = NEXT_DEFAULT;
      else return;
      zoom = null; save(); render();
    });
    root.addEventListener('change', e => {
      if (e.target.id === 'sdNext') opt.next = /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) ? e.target.value : NEXT_DEFAULT;
      else if (e.target.id === 'sdShort') opt.short = e.target.checked;
      else return;
      zoom = null; save(); render();
    });
    canvas.addEventListener('mousemove', e => {
      if (!geo) return;
      const r = canvas.getBoundingClientRect();
      hoverK = Math.round(geo.k0 + ((e.clientX - r.left - geo.L) / geo.pw) * (geo.k1 - geo.k0));
      draw();
    });
    canvas.addEventListener('mouseleave', () => { hoverK = null; draw(); });
    if (window.LegionZoom) LegionZoom.attach(canvas, {
      plot: () => (geo ? { l: geo.L, r: geo.L + geo.pw } : { l: 0, r: 0 }),
      onZoom: (a, b) => {
        const day = x => geo.k0 + ((x - geo.L) / geo.pw) * (geo.k1 - geo.k0);
        let z0 = Math.floor(day(a)), z1 = Math.ceil(day(b));
        if (z1 - z0 < 4) { const m = Math.round((z0 + z1) / 2); z0 = m - 2; z1 = m + 2; }
        zoom = [z0, z1]; draw();
      },
      onReset: () => { zoom = null; draw(); },
    });
    window.addEventListener('resize', () => { if (root.offsetParent) draw(); });
    root.querySelector('.ipo-ctl').innerHTML = '<span class="ipo-dim">Loading BTC history…</span>';
    try {
      const r = await fetch('/api/markets/btc-daily');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = (await r.json()).days;
      close = new Map(data);
      lastDay = toDay(data[data.length - 1][0]);
    } catch (err) {
      root.querySelector('.ipo-ctl').innerHTML = `<span class="ipo-dim">BTC history is unavailable right now (${esc(err.message)}).</span>`;
      canvas = null; return;
    }
    render();
  }

  window.LegionShutdown = { init, draw: () => (canvas ? draw() : init()), _series: () => plotted.map(s => ({ id: s.ev.id, n: s.pts.length, upcoming: s.upcoming, stats: s.pts.length || s.futureStart ? stats(s) : null })) };
})();
