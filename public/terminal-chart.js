/* Bitcoin Terminal Price: BTC price against Terminal, Realized and Balanced Price (log scale).
   Data: window.LEGION_TERMINAL from onchain-terminal.js (daily arrays from `start`). */
(function () {
  'use strict';

  const DAY = 864e5;
  const SERIES = [
    { k: 'price', name: 'Bitcoin Price', color: '#4a9eff', w: 1.4 },
    { k: 'terminal', name: 'Terminal Price', color: '#ef5350', w: 1.6 },
    { k: 'realized', name: 'Realized Price', color: '#4caf50', w: 1.6 },
    { k: 'balanced', name: 'Balanced Price', color: '#ff9f43', w: 1.6 },
  ];
  const hidden = new Set();
  let root, canvas, tip, zoom = null, drag = null, D = null, t0 = 0;

  const fmt = v => v == null ? '—' : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(2) + 'K' : v >= 1 ? '$' + v.toFixed(2) : '$' + v.toPrecision(2);
  const tickLbl = v => v >= 1e6 ? (v / 1e6) + 'M' : v >= 1e3 ? (v / 1e3) + 'K' : String(v);
  const dateOf = i => new Date(t0 + i * DAY);
  const fmtDate = i => dateOf(i).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  function build() {
    root = document.getElementById('tp-root');
    if (!root || root.dataset.ready) return !!root;
    D = window.LEGION_TERMINAL;
    if (!D) { root.innerHTML = '<p class="ipo-note">Data not loaded.</p>'; return false; }
    t0 = Date.parse(D.start);
    const n = D.price.length - 1;
    root.dataset.ready = '1';
    root.innerHTML = `
      <div class="ipo-ctl"><div class="ipo-row" style="gap:6px 18px;">
        ${['terminal', 'balanced', 'realized', 'price'].map(k => `<span class="ipo-dim"><b style="color:var(--text);font-size:13px;">${SERIES.find(s => s.k === k).name}: ${fmt(D[k][n])}</b></span>`).join('')}
        <span class="ipo-dim">as of ${fmtDate(n)}</span></div>
        <div class="ipo-legend">${SERIES.map(s => `<button class="ipo-key" data-key="${s.k}"><i style="background:${s.color}"></i>${s.name}</button>`).join('')}</div></div>
      <div class="ipo-wrap" style="height:480px;"><canvas></canvas><div class="ipo-tip"></div></div>`;
    canvas = root.querySelector('canvas'); tip = root.querySelector('.ipo-tip');
    root.querySelectorAll('.ipo-key').forEach(b => b.onclick = () => {
      const k = b.dataset.key; hidden.has(k) ? hidden.delete(k) : hidden.add(k);
      b.classList.toggle('off', hidden.has(k)); draw();
    });
    canvas.addEventListener('mousedown', e => { drag = { x0: e.offsetX, x1: e.offsetX }; });
    canvas.addEventListener('mousemove', e => { if (drag) { drag.x1 = e.offsetX; draw(); } hover(e.offsetX); });
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; if (drag) { drag = null; draw(); } else draw(); });
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

  let geo = null;
  const idxAt = x => { const g = geo; return Math.max(g.i0, Math.min(g.i1, Math.round(g.i0 + (x - g.L) / g.pw * (g.i1 - g.i0)))); };

  function draw() {
    if (!build() || !canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const L = 8, R = 62, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    const n = D.price.length - 1, i0 = zoom ? zoom[0] : 0, i1 = zoom ? zoom[1] : n;
    const shown = SERIES.filter(s => !hidden.has(s.k));
    let lo = Infinity, hi = -Infinity;
    shown.forEach(s => { for (let i = i0; i <= i1; i++) { const v = D[s.k][i]; if (v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; } } });
    if (!isFinite(lo)) { lo = 1; hi = 10; }
    const l0 = Math.floor(Math.log10(lo) * 4) / 4, l1 = Math.ceil(Math.log10(hi) * 4) / 4 || l0 + 1;
    const X = i => L + (i - i0) / (i1 - i0) * pw, Y = v => T + (1 - (Math.log10(v) - l0) / (l1 - l0)) * ph;
    geo = { L, pw, i0, i1, X, Y, T, ph };
    g.font = '11px Inter, sans-serif'; g.textBaseline = 'middle';
    // price grid: powers of ten, plus 2 and 5 when the range is narrow
    const mult = l1 - l0 < 3 ? [1, 2, 5] : [1];
    for (let e = Math.floor(l0); e <= Math.ceil(l1); e++) mult.forEach(m => {
      const v = m * 10 ** e, lv = Math.log10(v); if (lv < l0 || lv > l1) return;
      const y = Y(v); g.strokeStyle = m === 1 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
      g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillStyle = '#8a8fa8'; g.fillText(tickLbl(v), L + pw + 6, y);
    });
    // time grid: years (or months when zoomed in)
    const y0 = dateOf(i0).getUTCFullYear(), y1 = dateOf(i1).getUTCFullYear(), months = y1 - y0 < 2;
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let y = y0; y <= y1 + 1; y++) for (let m = 0; m < 12; m += months ? 1 : 12) {
      const i = (Date.UTC(y, m, 1) - t0) / DAY; if (i < i0 || i > i1) continue;
      const x = X(i); g.strokeStyle = 'rgba(255,255,255,0.05)'; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
      g.fillStyle = '#8a8fa8'; g.fillText(months ? new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) + (m === 0 ? ' ' + y : '') : String(y), x, T + ph + 6);
    }
    g.textAlign = 'left';
    // lines (draw price first so the models sit on top)
    shown.forEach(s => {
      g.strokeStyle = s.color; g.lineWidth = s.w; g.beginPath(); let pen = false;
      const step = Math.max(1, Math.floor((i1 - i0) / (pw * 2)));
      for (let i = i0; i <= i1; i += step) {
        const v = D[s.k][i]; if (!(v > 0)) { pen = false; continue; }
        const x = X(i), y = Y(v); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true;
      }
      g.stroke();
    });
    // boundary between reconstructed (before) and measured (after) Terminal/Balanced history
    const cf = (Date.parse(D.reconTo || D.cddFrom) - t0) / DAY;
    if (cf > i0 && cf < i1 && (!hidden.has('terminal') || !hidden.has('balanced'))) {
      const x = X(cf); g.setLineDash([3, 4]); g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#8a8fa8'; g.textBaseline = 'top';
      if (D.reconTo) { g.textAlign = 'right'; g.fillText('← reconstructed', x - 6, T + 4); g.textAlign = 'left'; g.fillText('measured →', x + 6, T + 4); }
      else { g.textAlign = 'right'; g.fillText('Terminal & Balanced from ' + fmtDate(cf) + ' →', x - 6, T + 4); }
      g.textAlign = 'left';
    }
    if (drag) { g.fillStyle = 'rgba(201,168,76,0.12)'; g.fillRect(Math.min(drag.x0, drag.x1), T, Math.abs(drag.x1 - drag.x0), ph); }
  }

  function hover(x) {
    if (!geo || drag) return;
    const { L, pw, X, Y, T, ph } = geo;
    if (x < L || x > L + pw) { tip.style.display = 'none'; return; }
    const i = idxAt(x);
    draw();
    const g = canvas.getContext('2d'), cx = X(i);
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.beginPath(); g.moveTo(cx, T); g.lineTo(cx, T + ph); g.stroke();
    SERIES.forEach(s => { const v = D[s.k][i]; if (hidden.has(s.k) || !(v > 0)) return; g.fillStyle = s.color; g.beginPath(); g.arc(cx, Y(v), 3, 0, 7); g.fill(); });
    tip.innerHTML = `<b>${fmtDate(i)}</b>` + SERIES.map(s => `<div><i style="background:${s.color}"></i>${s.name} <span>${fmt(D[s.k][i])}</span></div>`).join('');
    tip.style.display = 'block';
    tip.style.left = (cx > canvas.clientWidth / 2 ? Math.max(4, cx - tip.offsetWidth - 14) : cx + 14) + 'px';
  }

  window.LegionTerminal = { draw };
})();
