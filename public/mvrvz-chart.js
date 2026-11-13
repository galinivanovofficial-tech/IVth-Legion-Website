/* MVRV Z-Score: BTC price (log, top pane) above the Z-score (bottom pane) with the historical top and bottom zones.
   Data: window.LEGION_TERMINAL from onchain-terminal.js (daily arrays from `start`: price, mvrv, mvrvz). */
(function () {
  'use strict';

  const DAY = 864e5, TOP = 7, BOTTOM = 0;
  const C = { price: '#4a9eff', z: '#e3c96b', top: '#ef5350', bottom: '#26a69a', grid: 'rgba(255,255,255,0.06)', label: '#8a8fa8' };
  let root, canvas, tip, zoom = null, drag = null, D = null, t0 = 0, geo = null;

  const fmtUsd = v => v == null ? '—' : v >= 1e3 ? '$' + Math.round(v).toLocaleString('en-US') : v >= 1 ? '$' + v.toFixed(2) : '$' + v.toPrecision(2);
  const fmtZ = v => v == null ? '—' : v.toFixed(2);
  const tickLbl = v => v >= 1e6 ? (v / 1e6) + 'M' : v >= 1e3 ? (v / 1e3) + 'K' : String(v);
  const dateOf = i => new Date(t0 + i * DAY);
  const fmtDate = i => dateOf(i).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const zone = z => z == null ? '' : z >= TOP ? 'Top zone' : z <= BOTTOM ? 'Bottom zone' : z >= 3 ? 'Overheated' : z <= 1 ? 'Undervalued' : 'Neutral';
  const zoneColor = z => z >= 3 ? C.top : z <= 1 ? C.bottom : C.z;

  function build() {
    root = document.getElementById('mvz-root');
    if (!root || root.dataset.ready) return !!root;
    D = window.LEGION_TERMINAL;
    if (!D || !D.mvrvz) { root.innerHTML = '<p class="ipo-note">Data not loaded.</p>'; return false; }
    t0 = Date.parse(D.start);
    const n = D.price.length - 1, z = D.mvrvz[n];
    root.dataset.ready = '1';
    root.innerHTML = `
      <div class="ipo-ctl"><div class="ipo-row" style="gap:6px 18px;">
        <span class="ipo-dim"><b style="color:var(--text);font-size:13px;">MVRV Z-Score: <span style="color:${zoneColor(z)}">${fmtZ(z)}</span></b> · ${zone(z)}</span>
        <span class="ipo-dim"><b style="color:var(--text);font-size:13px;">MVRV: ${D.mvrv[n].toFixed(2)}</b></span>
        <span class="ipo-dim"><b style="color:var(--text);font-size:13px;">BTC: ${fmtUsd(D.price[n])}</b></span>
        <span class="ipo-dim">as of ${fmtDate(n)}</span></div>
        <div class="ipo-legend">
          <span class="ipo-key"><i style="background:${C.price}"></i>Bitcoin Price (log)</span>
          <span class="ipo-key"><i style="background:${C.z}"></i>MVRV Z-Score</span>
          <span class="ipo-key"><i style="background:${C.top}"></i>Top zone (Z ≥ ${TOP})</span>
          <span class="ipo-key"><i style="background:${C.bottom}"></i>Bottom zone (Z ≤ ${BOTTOM})</span>
        </div></div>
      <div class="ipo-wrap" style="height:520px;"><canvas></canvas><div class="ipo-tip"></div></div>`;
    canvas = root.querySelector('canvas'); tip = root.querySelector('.ipo-tip');
    canvas.addEventListener('mousedown', e => { drag = { x0: e.offsetX, x1: e.offsetX }; });
    canvas.addEventListener('mousemove', e => { if (drag) { drag.x1 = e.offsetX; draw(); } hover(e.offsetX); });
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; drag = null; draw(); });
    canvas.addEventListener('touchmove', e => { const r = canvas.getBoundingClientRect(); hover(e.touches[0].clientX - r.left); }, { passive: true });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
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

  // When several days share a pixel, draw each bucket's low and high so peaks and lows are never skipped.
  function line(g, arr, i0, i1, X, Y, step, ok) {
    g.beginPath(); let pen = false;
    for (let i = i0; i <= i1; i += step) {
      let lo = null, hi = null;
      for (let j = i; j < i + step && j <= i1; j++) { const v = arr[j]; if (v == null || !ok(v)) continue; if (lo == null || v < lo) lo = v; if (hi == null || v > hi) hi = v; }
      if (lo == null) { pen = false; continue; }
      const x = X(i);
      pen ? g.lineTo(x, Y(arr[i] ?? lo)) : g.moveTo(x, Y(arr[i] ?? lo)); pen = true;
      if (hi !== lo) { g.lineTo(x, Y(hi)); g.lineTo(x, Y(lo)); }
    }
    g.stroke();
  }

  function draw() {
    if (!build() || !canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const n = D.price.length - 1;
    let i0 = zoom ? zoom[0] : 0, i1 = zoom ? zoom[1] : n;
    if (!zoom) while (i0 < n && D.mvrvz[i0] == null) i0++; // start where the Z-score starts
    const L = 8, R = 56, T = 10, B = 24, gap = 14, ph1 = Math.round((H - T - B - gap) * 0.55), ph2 = H - T - B - gap - ph1;
    const T2 = T + ph1 + gap, pw = W - L - R;
    const X = i => L + (i - i0) / (i1 - i0) * pw;
    const step = Math.max(1, Math.floor((i1 - i0) / (pw * 2)));
    g.font = '11px Inter, sans-serif'; g.textBaseline = 'middle';

    // --- top pane: price, log scale
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { const v = D.price[i]; if (v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    const l0 = Math.floor(Math.log10(lo) * 4) / 4, l1 = Math.ceil(Math.log10(hi) * 4) / 4 || l0 + 1;
    const Yp = v => T + (1 - (Math.log10(v) - l0) / (l1 - l0)) * ph1;
    const mult = l1 - l0 < 3 ? [1, 2, 5] : [1];
    for (let e = Math.floor(l0); e <= Math.ceil(l1); e++) mult.forEach(m => {
      const v = m * 10 ** e, lv = Math.log10(v); if (lv < l0 || lv > l1) return;
      const y = Yp(v); g.strokeStyle = C.grid; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillStyle = C.label; g.fillText(tickLbl(v), L + pw + 6, y);
    });

    // --- bottom pane: Z-score, linear
    let zlo = BOTTOM - 0.5, zhi = TOP + 0.5;
    for (let i = i0; i <= i1; i++) { const v = D.mvrvz[i]; if (v != null) { if (v < zlo) zlo = v; if (v > zhi) zhi = v; } }
    zlo = Math.floor(zlo); zhi = Math.ceil(zhi);
    const Yz = v => T2 + (1 - (v - zlo) / (zhi - zlo)) * ph2;
    // zones
    g.fillStyle = 'rgba(239,83,80,0.12)'; g.fillRect(L, Yz(zhi), pw, Yz(TOP) - Yz(zhi));
    g.fillStyle = 'rgba(38,166,154,0.14)'; g.fillRect(L, Yz(BOTTOM), pw, Yz(zlo) - Yz(BOTTOM));
    const zStep = zhi - zlo > 8 ? 2 : 1;
    for (let v = zlo; v <= zhi; v += zStep) {
      const y = Yz(v); g.strokeStyle = v === 0 ? 'rgba(255,255,255,0.18)' : C.grid; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillStyle = C.label; g.fillText(String(v), L + pw + 6, y);
    }
    g.setLineDash([4, 4]); g.lineWidth = 1;
    [[TOP, C.top], [BOTTOM, C.bottom]].forEach(([v, c]) => { g.strokeStyle = c; g.beginPath(); g.moveTo(L, Yz(v)); g.lineTo(L + pw, Yz(v)); g.stroke(); });
    g.setLineDash([]);

    // price backdrop: tint the top pane where the Z-score sat in a zone, so the cycle tops/bottoms line up with price
    for (let i = i0; i <= i1; i += step) {
      let v = D.mvrvz[i];
      for (let j = i; j < i + step && j <= i1; j++) { const w = D.mvrvz[j]; if (w != null && (w >= TOP || w <= BOTTOM)) { v = w; break; } }
      if (v == null || (v < TOP && v > BOTTOM)) continue;
      g.fillStyle = v >= TOP ? 'rgba(239,83,80,0.10)' : 'rgba(38,166,154,0.10)';
      g.fillRect(X(i), T, Math.max(1, X(i + step) - X(i)), ph1);
    }

    // time grid
    const y0 = dateOf(i0).getUTCFullYear(), y1 = dateOf(i1).getUTCFullYear(), months = y1 - y0 < 2;
    const every = !months && pw / (y1 - y0 + 1) < 34 ? 2 : 1;
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let y = y0; y <= y1 + 1; y++) for (let m = 0; m < 12; m += months ? 1 : 12) {
      if (!months && y % every) continue;
      const i = (Date.UTC(y, m, 1) - t0) / DAY; if (i < i0 || i > i1) continue;
      const x = X(i); g.strokeStyle = C.grid; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T2 + ph2); g.stroke();
      g.fillStyle = C.label; g.fillText(months ? new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) + (m === 0 ? ' ' + y : '') : String(y), x, T2 + ph2 + 6);
    }
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillStyle = C.label; g.fillText('BTC price', L + 4, T + 2); g.fillText('MVRV Z-Score', L + 4, T2 + 2);

    // lines
    g.lineWidth = 1.4; g.strokeStyle = C.price; line(g, D.price, i0, i1, X, Yp, step, v => v > 0);
    g.lineWidth = 1.5; g.strokeStyle = C.z; line(g, D.mvrvz, i0, i1, X, Yz, step, () => true);

    if (drag) { g.fillStyle = 'rgba(201,168,76,0.12)'; g.fillRect(Math.min(drag.x0, drag.x1), T, Math.abs(drag.x1 - drag.x0), T2 + ph2 - T); }
    geo = { L, pw, i0, i1, X, Yp, Yz, T, T2, ph2 };
  }

  function hover(x) {
    if (!geo || drag) return;
    const { L, pw, X, Yp, Yz, T, T2, ph2 } = geo;
    if (x < L || x > L + pw) { tip.style.display = 'none'; return; }
    const i = idxAt(x);
    draw();
    const g = canvas.getContext('2d'), cx = X(i), z = D.mvrvz[i];
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.beginPath(); g.moveTo(cx, T); g.lineTo(cx, T2 + ph2); g.stroke();
    if (D.price[i] > 0) { g.fillStyle = C.price; g.beginPath(); g.arc(cx, Yp(D.price[i]), 3, 0, 7); g.fill(); }
    if (z != null) { g.fillStyle = C.z; g.beginPath(); g.arc(cx, Yz(z), 3, 0, 7); g.fill(); }
    tip.innerHTML = `<b>${fmtDate(i)}</b>` +
      `<div><i style="background:${C.price}"></i>BTC <span>${fmtUsd(D.price[i])}</span></div>` +
      `<div><i style="background:${C.z}"></i>MVRV Z <span>${fmtZ(z)}</span></div>` +
      `<div><i style="background:transparent"></i>MVRV <span>${D.mvrv[i] != null ? D.mvrv[i].toFixed(2) : '—'}</span></div>` +
      (z != null ? `<div><i style="background:${zoneColor(z)}"></i>${zone(z)}</div>` : '');
    tip.style.display = 'block';
    tip.style.left = (cx > canvas.clientWidth / 2 ? Math.max(4, cx - tip.offsetWidth - 14) : cx + 14) + 'px';
  }

  window.LegionMVRVZ = { draw };
})();
