/* BTC around mega IPOs: BTC's path in the days before (and after) the biggest listings, aligned on IPO day,
   so we can see whether the money raised in a mega IPO coincides with BTC weakness (a liquidity drain). */
(function () {
  'use strict';

  const DAY = 864e5;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  const ANT_DATES = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'];
  const IPOS = [
    { id: 'spcx', name: 'SpaceX', ticker: 'SPCX', date: '2026-06-12', color: '#c9a84c', note: 'Largest IPO ever: about $75B raised at $135 per share.' },
    { id: 'ant', name: 'Anthropic', ticker: 'ANT', color: '#e07a5f', expected: true, note: 'Expected the week of Nov 16, 2026. Not confirmed: pick the day you expect.' },
    { id: 'oai', name: 'OpenAI', ticker: '—', color: '#2ec4b6', expected: true, note: 'No date yet; reports point to 2027. Set an assumed date to track it.' },
    { id: 'coin', name: 'Coinbase (direct listing)', ticker: 'COIN', date: '2021-04-14', color: '#5aa9e6', ref: true, note: 'BTC set its cycle high the same day.' },
    { id: 'aramco', name: 'Saudi Aramco', ticker: '2222.SR', date: '2019-12-11', color: '#9b8cff', ref: true, note: 'Largest IPO before SpaceX.' },
    { id: 'arm', name: 'Arm', ticker: 'ARM', date: '2023-09-14', color: '#8a8fa8', ref: true },
  ];

  const opt = Object.assign({ before: 300, after: 30, base: 'start', ant: '2026-11-18', oai: '', refs: false, hidden: [] }, store.get('legionIpo', {}));
  if (!ANT_DATES.includes(opt.ant)) opt.ant = '2026-11-18';
  const save = () => store.set('legionIpo', opt);

  let root = null, canvas = null, tip = null, data = null, close = null, lastDay = null, plotted = [], geo = null, hoverK = null;
  let zoom = null; // [fromDay, toDay] relative to IPO day while zoomed in

  const toDay = s => Date.parse(s + 'T00:00:00Z');
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const dateOf = ipo => (ipo.id === 'ant' ? opt.ant : ipo.id === 'oai' ? opt.oai : ipo.date);
  const fmtPct = v => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
  const fmtUsd = v => (v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US'));
  const fmtDate = s => new Date(toDay(s)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  // close on that day, or the last close before it (weekend gaps never happen for BTC, but the feed can skip a day)
  function closeAt(t) {
    for (let k = 0; k < 5; k++) { const v = close.get(iso(t - k * DAY)); if (v != null) return v; }
    return null;
  }

  function series(ipo) {
    const d = dateOf(ipo);
    if (!d) return null;
    const D = toDay(d), first = D - opt.before * DAY, last = Math.min(D + opt.after * DAY, lastDay);
    if (first > lastDay) return { ipo, D, pts: [], futureStart: true };
    let baseT = first, baseNote = 'window start';
    if (opt.base === 'd30') { baseT = D - 30 * DAY; baseNote = 'D−30'; }
    if (opt.base === 'ipo') { baseT = D; baseNote = 'IPO day'; }
    if (baseT > lastDay) { baseT = lastDay; baseNote = 'today (not reached yet)'; }
    const base = closeAt(baseT);
    const pts = [];
    for (let t = first; t <= last; t += DAY) {
      const v = closeAt(t);
      if (v != null && base) pts.push({ k: Math.round((t - D) / DAY), t, v, pct: (v / base - 1) * 100 });
    }
    return { ipo, D, pts, base, baseNote, upcoming: D > lastDay };
  }

  function stats(s) {
    const { D } = s, get = t => (t <= lastDay ? closeAt(t) : null);
    const p300 = get(D - opt.before * DAY), p30 = get(D - 30 * DAY), p0 = get(D), now = closeAt(lastDay), p30a = get(D + 30 * DAY);
    const endPre = D <= lastDay ? p0 : now;
    let peak = -Infinity, dd = 0;
    for (let t = D - 30 * DAY; t <= Math.min(D, lastDay); t += DAY) {
      const v = closeAt(t); if (v == null) continue;
      peak = Math.max(peak, v); dd = Math.min(dd, (v / peak - 1) * 100);
    }
    return {
      pre: p300 && p30 ? (p30 / p300 - 1) * 100 : null,
      last30: p30 && endPre ? (endPre / p30 - 1) * 100 : null,
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
      <div class="ipo-row"><span class="ipo-lbl">Days before IPO</span>${[300, 90, 30].map(v => chip('before', v, v + 'd', opt.before === v)).join('')}
        <span class="ipo-lbl">After</span>${[0, 30, 90].map(v => chip('after', v, v ? '+' + v + 'd' : 'none', opt.after === v)).join('')}
        <span class="ipo-lbl">0% line at</span>${[['start', 'Window start'], ['d30', 'D−30'], ['ipo', 'IPO day']].map(([v, l]) => chip('base', v, l, opt.base === v)).join('')}</div>
      <div class="ipo-row">
        <label class="ipo-lbl" for="ipoAnt">Anthropic IPO day</label>
        <select id="ipoAnt" class="ipo-input">${ANT_DATES.map(d => `<option value="${d}"${d === opt.ant ? ' selected' : ''}>${new Date(toDay(d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}${d === '2026-11-18' ? ' (default)' : ''}</option>`).join('')}</select>
        <label class="ipo-lbl" for="ipoOai">OpenAI IPO day (assumed)</label>
        <input id="ipoOai" class="ipo-input" type="date" value="${esc(opt.oai)}" min="2026-11-01" max="2028-12-31">
        ${opt.oai ? '<button class="chart-tab" data-clear="oai">Clear</button>' : ''}
        <label class="ipo-check"><input type="checkbox" id="ipoRefs"${opt.refs ? ' checked' : ''}> Past mega listings (Coinbase, Aramco, Arm)</label>
      </div>
      <div class="ipo-legend">${IPOS.filter(i => !i.ref || opt.refs).map(i => {
        const d = dateOf(i), off = opt.hidden.includes(i.id);
        return `<button class="ipo-key${off ? ' off' : ''}" data-key="${i.id}" title="${esc(i.note || '')}"><i style="background:${i.color}"></i>${esc(i.name)} <span>${d ? fmtDate(d) + (i.expected ? ' (expected)' : '') : 'date TBA'}</span></button>`;
      }).join('')}</div>`;
  }

  function renderStats() {
    const rows = plotted.filter(s => s.pts.length || s.futureStart).map(s => {
      const st = stats(s), i = s.ipo;
      const when = st.daysTo > 0 ? `in ${st.daysTo} days` : st.daysTo === 0 ? 'today' : `${-st.daysTo} days ago`;
      const cls = v => (v == null ? '' : v >= 0 ? 'up' : 'down');
      return `<tr><td><i class="ipo-dot" style="background:${i.color}"></i><b>${esc(i.name)}</b> <span class="ipo-dim">${esc(i.ticker)}</span></td>
        <td>${fmtDate(dateOf(i))}${i.expected ? ' <span class="ipo-dim">(exp.)</span>' : ''}<br><span class="ipo-dim">${when}</span></td>
        <td class="r ${cls(st.pre)}">${s.futureStart ? '—' : fmtPct(st.pre)}</td>
        <td class="r ${cls(st.last30)}">${fmtPct(st.last30)}${st.daysTo > 0 && st.last30 != null ? '<br><span class="ipo-dim">so far</span>' : ''}</td>
        <td class="r ${cls(st.dd)}">${fmtPct(st.dd)}</td>
        <td class="r ${cls(st.after30)}">${fmtPct(st.after30)}</td></tr>`;
    }).join('');
    root.querySelector('.ipo-stats').innerHTML = rows ? `<table class="ipo-table"><thead><tr><th>Listing</th><th>IPO day</th>
      <th class="r" title="BTC change from the window start to 30 days before the IPO">D−${opt.before} → D−30</th>
      <th class="r" title="BTC change over the final 30 days into the IPO">D−30 → IPO</th>
      <th class="r" title="Deepest fall from a high within the final 30 days">Max drawdown, last 30d</th>
      <th class="r" title="BTC change in the 30 days after listing">IPO → D+30</th></tr></thead><tbody>${rows}</tbody></table>` : '';
  }

  function draw() {
    if (!canvas || !data) return;
    plotted = IPOS.filter(i => (!i.ref || opt.refs)).map(series).filter(Boolean);
    const shown = plotted.filter(s => s.pts.length && !opt.hidden.includes(s.ipo.id));
    const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const L = 8, R = 58, T = 14, B = 28, pw = W - L - R, ph = H - T - B;
    const k0 = zoom ? zoom[0] : -opt.before, k1 = zoom ? zoom[1] : opt.after;
    let lo = zoom ? Infinity : 0, hi = zoom ? -Infinity : 0;
    for (const s of shown) for (const p of s.pts) if (p.k >= k0 && p.k <= k1) { lo = Math.min(lo, p.pct); hi = Math.max(hi, p.pct); }
    if (lo === Infinity) { lo = -1; hi = 1; }
    const pad = (hi - lo || 10) * 0.08; lo -= pad; hi += pad;
    const X = k => L + ((k - k0) / (k1 - k0 || 1)) * pw, Y = v => T + (1 - (v - lo) / (hi - lo)) * ph;
    geo = { L, pw, k0, k1, X, Y, T, ph };
    g.font = '10px Inter, sans-serif';
    // final 30 days before the IPO
    g.fillStyle = 'rgba(201,168,76,0.06)'; g.fillRect(X(Math.max(k0, -30)), T, X(0) - X(Math.max(k0, -30)), ph);
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
    const span = k1 - k0, xs = span >= 250 ? 50 : span >= 90 ? 15 : span >= 30 ? 5 : span >= 12 ? 2 : 1;
    for (let k = Math.ceil(k0 / xs) * xs; k <= k1; k += xs) {
      g.fillStyle = k === 0 ? '#e8c96a' : '#6f7391';
      g.fillText(k === 0 ? 'IPO' : (k > 0 ? 'D+' : 'D') + k, Math.max(L + 18, Math.min(L + pw - 18, X(k))), H - 8); // keep edge labels inside
    }
    // markers
    const vline = (k, color, label, dash) => {
      g.setLineDash(dash || []); g.strokeStyle = color; g.beginPath(); g.moveTo(X(k), T); g.lineTo(X(k), T + ph); g.stroke(); g.setLineDash([]);
      g.fillStyle = color; g.textAlign = 'left'; g.fillText(label, X(k) + 4, T + 10);
    };
    if (k0 <= -30) vline(-30, 'rgba(201,168,76,0.45)', 'D−30', [4, 4]);
    vline(0, '#c9a84c', 'IPO day');
    // lines (clipped to the plot so a zoomed view doesn't spill into the axes)
    g.save(); g.beginPath(); g.rect(L, T - 6, pw, ph + 12); g.clip();
    for (const s of shown) {
      g.strokeStyle = s.ipo.color; g.lineWidth = s.ipo.ref ? 1.3 : 2.2; g.globalAlpha = s.ipo.ref ? 0.75 : 1;
      if (s.ipo.ref) g.setLineDash([5, 3]);
      g.beginPath();
      s.pts.forEach((p, n) => (n ? g.lineTo(X(p.k), Y(p.pct)) : g.moveTo(X(p.k), Y(p.pct))));
      g.stroke(); g.setLineDash([]); g.globalAlpha = 1; g.lineWidth = 1;
      if (s.upcoming && s.pts.length) { // where we are today on an upcoming IPO
        const p = s.pts[s.pts.length - 1];
        g.fillStyle = s.ipo.color; g.beginPath(); g.arc(X(p.k), Y(p.pct), 4, 0, 7); g.fill();
        g.font = '600 10px Inter, sans-serif'; g.textAlign = 'left';
        g.fillText(`today D${p.k}`, Math.min(X(p.k) + 7, L + pw - 60), Y(p.pct) - 8); g.font = '10px Inter, sans-serif';
      }
    }
    g.restore();
    if (zoom) { g.fillStyle = '#e8c96a'; g.textAlign = 'right'; g.font = '600 10px Inter, sans-serif'; g.fillText('Zoomed: right-click to reset', L + pw - 4, T + 10); g.font = '10px Inter, sans-serif'; }
    if (!shown.length) { g.fillStyle = '#7777aa'; g.textAlign = 'center'; g.fillText('No listing in view: OpenAI needs an assumed date, or its window starts in the future.', L + pw / 2, T + ph / 2); }
    // crosshair
    if (hoverK != null && hoverK >= k0 && hoverK <= k1) {
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(X(hoverK), T); g.lineTo(X(hoverK), T + ph); g.stroke(); g.setLineDash([]);
      const lines = shown.map(s => ({ s, p: s.pts.find(p => p.k === hoverK) })).filter(x => x.p);
      for (const { s, p } of lines) { g.fillStyle = s.ipo.color; g.beginPath(); g.arc(X(p.k), Y(p.pct), 3, 0, 7); g.fill(); }
      tip.style.display = lines.length ? 'block' : 'none';
      tip.innerHTML = `<b>${hoverK === 0 ? 'IPO day' : (hoverK > 0 ? 'D+' : 'D') + hoverK}</b>` + lines.map(({ s, p }) =>
        `<div><i style="background:${s.ipo.color}"></i>${esc(s.ipo.name)}: <b>${fmtPct(p.pct)}</b> <span>${fmtUsd(p.v)} · ${fmtDate(iso(p.t))}</span></div>`).join('');
      const x = X(hoverK);
      tip.style.left = Math.max(4, Math.min(W - tip.offsetWidth - 4, x + 12)) + 'px';
    } else tip.style.display = 'none';
  }

  function render() { renderControls(); draw(); renderStats(); }

  async function init() {
    root = document.getElementById('ipo-root');
    if (!root) return;
    if (canvas) { render(); return; }
    root.innerHTML = `<div class="ipo-ctl"></div><div class="ipo-wrap"><canvas></canvas><div class="ipo-tip"></div></div>
      <div class="ipo-stats"></div>
      <p class="ipo-note">Each line is BTC's price path aligned on that company's IPO day (D0); D−30 means 30 days before listing. The shaded area is the final 30 days into the IPO. The idea being tested: a mega IPO pulls tens of billions out of other risk assets in the weeks before it lists. With only a handful of listings this is context, not a signal. Hover the chart for prices; click and drag across it to zoom in, right-click to reset; click a name in the legend to hide it. BTC data: Bitstamp daily closes.</p>`;
    canvas = root.querySelector('canvas'); tip = root.querySelector('.ipo-tip');
    root.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.before) opt.before = +b.dataset.before;
      else if (b.dataset.after) opt.after = +b.dataset.after;
      else if (b.dataset.base) opt.base = b.dataset.base;
      else if (b.dataset.key) opt.hidden = opt.hidden.includes(b.dataset.key) ? opt.hidden.filter(x => x !== b.dataset.key) : [...opt.hidden, b.dataset.key];
      else if (b.dataset.clear) opt.oai = '';
      else return;
      zoom = null; save(); render();
    });
    root.addEventListener('change', e => {
      if (e.target.id === 'ipoAnt') opt.ant = e.target.value;
      else if (e.target.id === 'ipoOai') opt.oai = /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) ? e.target.value : '';
      else if (e.target.id === 'ipoRefs') opt.refs = e.target.checked;
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
        if (z1 - z0 < 4) { const m = Math.round((z0 + z1) / 2); z0 = m - 2; z1 = m + 2; } // at least a few days
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

  window.LegionIPO = { init, draw: () => (canvas ? draw() : init()), _opt: opt, _zoom: () => zoom, _series: () => plotted.map(s => ({ id: s.ipo.id, n: s.pts.length, first: s.pts[0], last: s.pts[s.pts.length - 1], upcoming: s.upcoming, baseNote: s.baseNote, stats: s.pts.length || s.futureStart ? stats(s) : null })) };
})();
