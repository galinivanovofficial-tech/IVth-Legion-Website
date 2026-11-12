/* BTC average mining cost per BTC (MARA, quarterly) against the daily BTC price.
   Price: window.LEGION_TERMINAL (onchain-terminal.js, refreshed every 12h).
   Cost: window.LEGION_MINING from mining-cost.js, built by src/mining-cost.js from MARA's SEC filings
   (energy + hosting + operating and maintenance costs / BTC produced); a new quarter appears when MARA files. */
(function () {
  'use strict';

  // [quarter start, cost per BTC] from mining-cost.js (served by the server, updated when MARA files)
  let COST = [];
  const FROM = '2022-01-01', DAY = 864e5;
  const C_PRICE = '#e8e8ef', C_COST = '#8b7cf6';
  const hidden = new Set();
  let root, canvas, tip, geo = null, zoom = null, drag = null, S = null;

  const k = v => '$' + (v / 1e3).toFixed(1) + 'K';
  const usd = v => '$' + Math.round(v).toLocaleString('en-US');
  const qLabel = d => `Q${Math.floor(new Date(d).getUTCMonth() / 3) + 1} ${new Date(d).getUTCFullYear()}`;
  const fmtDate = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const quarterEnd = d => { const x = new Date(d); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 3, 1); };

  // daily series from FROM: { t[], price[], cost[] (null after the last reported quarter) }
  function series() {
    const D = window.LEGION_TERMINAL; if (!D) return null;
    const t0 = Date.parse(D.start), from = Date.parse(FROM), off = Math.round((from - t0) / DAY);
    const t = [], price = [], cost = [];
    for (let i = off; i < D.price.length; i++) {
      const ti = t0 + i * DAY; t.push(ti); price.push(D.price[i]);
      const q = COST.filter(c => Date.parse(c[0]) <= ti && ti < quarterEnd(c[0])).pop();
      cost.push(q ? q[1] : null);
    }
    return { t, price, cost };
  }

  // One row per quarter, newest first: cost, change vs the quarter before, average BTC price, price vs cost.
  // The running quarter (not reported yet) shows its average price so far.
  function quarterTable() {
    const avg = (a, b) => { let s = 0, c = 0; S.t.forEach((t, i) => { if (t >= a && t < b && S.price[i] > 0) { s += S.price[i]; c++; } }); return c ? s / c : null; };
    const pct = v => v == null ? '—' : `<span style="color:${v >= 0 ? '#4caf50' : '#ef5350'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
    const rows = COST.map((c, i) => {
      const a = Date.parse(c[0]), b = quarterEnd(c[0]), ap = avg(a, b), prev = COST[i - 1];
      return `<tr><td>${qLabel(c[0])}</td><td>${usd(c[1])}</td><td>${prev ? pct((c[1] / prev[1] - 1) * 100) : '—'}</td><td>${ap ? usd(ap) : '—'}</td><td>${ap ? pct((ap / c[1] - 1) * 100) : '—'}</td></tr>`;
    });
    const nextStart = quarterEnd(COST[COST.length - 1][0]), nowAvg = avg(nextStart, Infinity);
    if (nowAvg) rows.push(`<tr style="opacity:.75"><td>${qLabel(nextStart)} <span class="ipo-dim">(running)</span></td><td colspan="2" class="ipo-dim">not reported yet: MARA reports after the quarter ends</td><td>${usd(nowAvg)} <span class="ipo-dim">so far</span></td><td>${pct((nowAvg / COST[COST.length - 1][1] - 1) * 100)} <span class="ipo-dim">vs last cost</span></td></tr>`);
    const th = 'text-align:left;padding:6px 10px;color:var(--text-muted);font-weight:600;font-size:11px;border-bottom:1px solid rgba(255,255,255,.08);';
    return `<div style="overflow-x:auto;margin:14px 0 4px;"><table class="mc-table" style="width:100%;border-collapse:collapse;font-size:12.5px;">
      <thead><tr><th style="${th}">Quarter</th><th style="${th}">Mining cost per BTC</th><th style="${th}">Change vs previous quarter</th><th style="${th}">Avg. BTC price in quarter</th><th style="${th}">Price vs cost</th></tr></thead>
      <tbody>${rows.reverse().join('')}</tbody></table></div>
      <style>.mc-table td{padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.04);white-space:nowrap}.mc-table tbody tr:hover{background:rgba(255,255,255,.03)}</style>`;
  }

  function build() {
    root = document.getElementById('mc-root');
    if (!root || root.dataset.ready) return !!root;
    COST = window.LEGION_MINING || [];
    S = series();
    if (!S || !COST.length) { root.innerHTML = '<p class="ipo-note">Data not loaded.</p>'; return false; }
    root.dataset.ready = '1';
    const last = COST[COST.length - 1], n = S.price.length - 1, p = S.price[n], m = (p / last[1] - 1) * 100;
    root.innerHTML = `
      <div class="ipo-ctl"><div class="ipo-row" style="gap:6px 18px;">
        <span class="ipo-dim"><b style="color:var(--text);font-size:13px;">BTC Price: ${usd(p)}</b></span>
        <span class="ipo-dim"><b style="color:var(--text);font-size:13px;">${qLabel(last[0])} Mining Cost: ${usd(last[1])}</b></span>
        <span class="ipo-dim"><b style="font-size:13px;color:${m >= 0 ? '#4caf50' : '#ef5350'};">Price vs cost: ${m >= 0 ? '+' : ''}${m.toFixed(1)}%</b></span>
        <span class="ipo-dim">as of ${fmtDate(S.t[n])}</span></div>
        <div class="ipo-legend">
          <button class="ipo-key" data-key="price"><i style="background:${C_PRICE}"></i>BTC Price</button>
          <button class="ipo-key" data-key="cost"><i style="background:${C_COST}"></i>Avg. Mining Cost per BTC</button></div></div>
      <div class="ipo-wrap" style="height:440px;"><canvas></canvas><div class="ipo-tip"></div></div>${quarterTable()}`;
    canvas = root.querySelector('canvas'); tip = root.querySelector('.ipo-tip');
    root.querySelectorAll('.ipo-key').forEach(b => b.onclick = () => {
      const key = b.dataset.key; hidden.has(key) ? hidden.delete(key) : hidden.add(key);
      b.classList.toggle('off', hidden.has(key)); draw();
    });
    // x inside the plot: dragging past the left/right edge (or off the canvas) selects up to that edge
    const plotX = e => { const x = e.clientX - canvas.getBoundingClientRect().left; return geo ? Math.max(geo.L, Math.min(geo.L + geo.pw, x)) : x; };
    canvas.addEventListener('mousedown', e => { if (e.button === 0) { const x = plotX(e); drag = { x0: x, x1: x }; e.preventDefault(); } });
    canvas.addEventListener('mousemove', e => { if (!drag) hover(e.offsetX); });
    window.addEventListener('mousemove', e => { if (drag) { drag.x1 = plotX(e); draw(); } });
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; if (!drag) draw(); });
    window.addEventListener('mouseup', () => {
      if (!drag || !geo) return;
      const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1); drag = null;
      if (b - a > 8) { const i0 = idxAt(a), i1 = idxAt(b); if (i1 - i0 > 5) zoom = [i0, i1]; }
      draw();
    });
    const reset = e => { e.preventDefault(); zoom = null; draw(); };
    canvas.addEventListener('contextmenu', reset);
    canvas.addEventListener('dblclick', reset);
    window.addEventListener('resize', () => { if (root.offsetParent) draw(); });
    return true;
  }

  const idxAt = x => { const g = geo; return Math.max(g.i0, Math.min(g.i1, Math.round(g.i0 + (x - g.L) / g.pw * (g.i1 - g.i0)))); };

  function draw() {
    if (!build() || !canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const L = 8, R = 58, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    const n = S.price.length - 1, i0 = zoom ? zoom[0] : 0, i1 = zoom ? zoom[1] : n;
    let hi = 0, lo = Infinity;
    for (let i = i0; i <= i1; i++) {
      if (!hidden.has('price') && S.price[i] > 0) { hi = Math.max(hi, S.price[i]); lo = Math.min(lo, S.price[i]); }
      if (!hidden.has('cost') && S.cost[i] > 0) { hi = Math.max(hi, S.cost[i]); lo = Math.min(lo, S.cost[i]); }
    }
    if (!hi) { hi = 100000; lo = 0; }
    const step = hi - (zoom ? lo : 0) > 60000 ? 30000 : hi - (zoom ? lo : 0) > 20000 ? 10000 : 5000;
    const y0 = zoom ? Math.floor(lo * 0.95 / step) * step : 0, y1 = Math.ceil(hi * 1.04 / step) * step;
    const X = i => L + (i - i0) / Math.max(1, i1 - i0) * pw, Y = v => T + (1 - (v - y0) / (y1 - y0)) * ph;
    geo = { L, pw, i0, i1, X, Y, T, ph };
    g.font = '11px Inter, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
    for (let v = y0; v <= y1; v += step) {
      const y = Y(v); g.strokeStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillStyle = '#8a8fa8'; g.fillText(v ? '$' + v / 1e3 + 'K' : '$0', L + pw + 6, y);
    }
    // time grid: Jan/May/Sep, or every month when zoomed in
    const months = (S.t[i1] - S.t[i0]) / DAY < 500;
    g.textAlign = 'center'; g.textBaseline = 'top'; let lastRight = -1e9;
    for (let y = new Date(S.t[i0]).getUTCFullYear(); y <= new Date(S.t[i1]).getUTCFullYear(); y++) for (let m = 0; m < 12; m += months ? 1 : 4) {
      const i = (Date.UTC(y, m, 1) - S.t[0]) / DAY; if (i < i0 || i > i1) continue;
      const x = X(i); g.strokeStyle = 'rgba(255,255,255,0.04)'; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
      const lbl = new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) + ' ' + y, half = g.measureText(lbl).width / 2;
      const lx = Math.max(half, Math.min(L + pw - half, x)); if (lx - half < lastRight + 8) continue; lastRight = lx + half;
      g.fillStyle = '#8a8fa8'; g.fillText(lbl, lx, T + ph + 6);
    }
    g.textAlign = 'left';
    // latest reported cost as a dashed level across the chart
    const last = COST[COST.length - 1];
    if (!hidden.has('cost') && last[1] > y0 && last[1] < y1) {
      const y = Y(last[1]); g.setLineDash([4, 4]); g.strokeStyle = 'rgba(200,200,220,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#a0a4b8'; g.textBaseline = 'bottom'; g.fillText(`${qLabel(last[0])} Avg. Mining Cost per BTC: ${usd(last[1])}`, L + 8, y - 3);
    }
    if (!hidden.has('cost')) { // step line
      g.strokeStyle = C_COST; g.lineWidth = 2; g.beginPath(); let pen = false;
      for (let i = i0; i <= i1; i++) {
        const v = S.cost[i]; if (v == null) { pen = false; continue; }
        const x = X(i), y = Y(v);
        if (!pen) g.moveTo(x, y); else if (v !== S.cost[i - 1]) { g.lineTo(x, Y(S.cost[i - 1])); g.lineTo(x, y); } else if (i === i1 || S.cost[i + 1] !== v) g.lineTo(x, y);
        pen = true;
      }
      g.stroke();
    }
    if (!hidden.has('price')) {
      g.strokeStyle = C_PRICE; g.lineWidth = 1.3; g.beginPath(); let pen = false;
      for (let i = i0; i <= i1; i++) { const v = S.price[i]; if (!(v > 0)) { pen = false; continue; } pen ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); pen = true; }
      g.stroke();
    }
    if (drag) { g.fillStyle = 'rgba(201,168,76,0.12)'; g.fillRect(Math.min(drag.x0, drag.x1), T, Math.abs(drag.x1 - drag.x0), ph); }
  }

  function hover(x) {
    if (!geo || drag) return;
    const { L, pw, X, Y, T, ph } = geo;
    if (x < L || x > L + pw) { tip.style.display = 'none'; return; }
    const i = idxAt(x); draw();
    const g = canvas.getContext('2d'), cx = X(i), p = S.price[i], c = S.cost[i];
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.beginPath(); g.moveTo(cx, T); g.lineTo(cx, T + ph); g.stroke();
    [['price', p, C_PRICE], ['cost', c, C_COST]].forEach(([key, v, col]) => { if (!hidden.has(key) && v > 0) { g.fillStyle = col; g.beginPath(); g.arc(cx, Y(v), 3, 0, 7); g.fill(); } });
    const q = COST.filter(r => Date.parse(r[0]) <= S.t[i]).pop();
    const m = c ? (p / c - 1) * 100 : null;
    tip.innerHTML = `<b>${fmtDate(S.t[i])}</b>`
      + `<div><i style="background:${C_PRICE}"></i>BTC Price <span>${usd(p)}</span></div>`
      + `<div><i style="background:${C_COST}"></i>Mining Cost${c ? ' (' + qLabel(q[0]) + ')' : ''} <span>${c ? usd(c) : 'not reported yet'}</span></div>`
      + (m == null ? '' : `<div>Price vs cost <span style="color:${m >= 0 ? '#4caf50' : '#ef5350'}">${m >= 0 ? '+' : ''}${m.toFixed(1)}%</span></div>`);
    tip.style.display = 'block';
    tip.style.left = (cx > canvas.clientWidth / 2 ? Math.max(4, cx - tip.offsetWidth - 14) : cx + 14) + 'px';
  }

  window.LegionMiningCost = { draw, reset: () => { if (root) root.removeAttribute('data-ready'); } };
})();
