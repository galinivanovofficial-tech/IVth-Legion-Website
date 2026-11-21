/* ETH Logarithmic Regression Bands: ETH price (log scale) with the 3 classic regression bands
   plus two extreme bands fitted to the most extreme low (13 Mar 2020) and the current-cycle top.
   Formula: price = 10^(a·ln(x) − b), x = days since 21 Jan 2015, b = 7.847387532.
   Data: /api/markets/eth-daily → [date, high, low, close]. */
(function () {
  'use strict';

  const DAY = 864e5, B = 7.847387532, ORIGIN = Date.UTC(2015, 0, 21), FUTURE = 730;
  const BANDS = [
    { id: 'xhi', name: 'Extreme high', a: 1.4125, color: '#ef5350', note: 'through the current-cycle top (12 Mar 2024, $4,095)' },
    { id: 'hi', name: 'Upper band', a: 1.364138846, color: '#2ecc71' },
    { id: 'mid', name: 'Middle band', a: 1.344138846, color: '#2ecc71' },
    { id: 'lo', name: 'Lower band', a: 1.324138846, color: '#2ecc71' },
    { id: 'xlo', name: 'Extreme low', a: 1.2994, color: '#00c2ff', note: 'through the deepest low ever (13 Mar 2020, $88.20)' },
  ];
  const C = { price: '#e8e8f0', wick: 'rgba(232,232,240,0.28)', grid: 'rgba(255,255,255,0.06)', label: '#8a8fa8' };
  let root, canvas, tip, zoom = null, drag = null, D = null, t0 = 0, geo = null, loading = false;

  const band = (a, t) => { const x = (t - ORIGIN) / DAY; return x > 1 ? 10 ** (a * Math.log(x) - B) : null; };
  const fmtUsd = v => v == null ? '—' : v >= 1e3 ? '$' + Math.round(v).toLocaleString('en-US') : v >= 1 ? '$' + v.toFixed(2) : '$' + v.toPrecision(2);
  const tickLbl = v => v >= 1e6 ? (v / 1e6) + 'M' : v >= 1e3 ? (v / 1e3) + 'K' : String(v);
  const tOf = i => t0 + i * DAY;
  const fmtDate = i => new Date(tOf(i)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const pct = (p, b) => { const v = (p / b - 1) * 100; return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; };

  // Where a price sits between the five bands.
  function zoneOf(p, t) {
    const v = BANDS.map(b => band(b.a, t));
    if (p >= v[0]) return { txt: 'Above the extreme high band (cycle-top territory)', c: '#ef5350' };
    if (p >= v[1]) return { txt: 'Above the channel (where ETH spent most of 2017–2025)', c: '#e3c96b' };
    if (p >= v[3]) return { txt: 'Inside the channel (long-term floor)', c: '#2ecc71' };
    if (p >= v[4]) return { txt: 'Below the channel (only Mar 2020 and Nov 2026)', c: '#00c2ff' };
    return { txt: 'Below the extreme low band (never happened before)', c: '#00c2ff' };
  }

  async function load() {
    if (D || loading) return;
    loading = true;
    try {
      const r = await fetch('/api/markets/eth-daily');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const rows = (await r.json()).days;
      t0 = Date.parse(rows[0][0] + 'T00:00:00Z');
      const n = Math.round((Date.parse(rows[rows.length - 1][0] + 'T00:00:00Z') - t0) / DAY) + 1;
      D = { h: new Array(n).fill(null), l: new Array(n).fill(null), c: new Array(n).fill(null), n: n - 1 };
      for (const [d, h, l, c] of rows) { const i = Math.round((Date.parse(d + 'T00:00:00Z') - t0) / DAY); D.h[i] = h; D.l[i] = l; D.c[i] = c; }
    } catch (e) {
      root.innerHTML = `<p class="ipo-note">ETH history is unavailable right now (${e.message}).</p>`;
      loading = false; return;
    }
    loading = false;
    root.dataset.ready = '';
    draw();
  }

  function build() {
    root = document.getElementById('ethreg-root');
    if (!root) return false;
    if (!D) { if (!root.innerHTML) root.innerHTML = '<p class="ipo-note">Loading ETH history…</p>'; load(); return false; }
    if (root.dataset.ready === '1') return true;
    let n = D.n; while (n > 0 && D.c[n] == null) n--;
    const p = D.c[n], z = zoneOf(p, tOf(n));
    const vals = BANDS.map(b => band(b.a, tOf(n)));
    root.dataset.ready = '1';
    root.innerHTML = `
      <div class="ipo-ctl"><div class="ipo-row" style="gap:6px 18px;">
        <span class="ipo-dim"><b style="color:var(--text);font-size:13px;">ETH: ${fmtUsd(p)}</b> · <span style="color:${z.c}">${z.txt}</span></span>
        <span class="ipo-dim">${pct(p, vals[3])} vs lower band · ${pct(p, vals[4])} vs extreme low</span>
        <span class="ipo-dim">as of ${fmtDate(n)}</span></div>
        <div class="ipo-legend">
          <span class="ipo-key"><i style="background:${C.price}"></i>ETH price (log)</span>
          <span class="ipo-key"><i style="background:#2ecc71"></i>Regression channel (lower / middle / upper)</span>
          <span class="ipo-key"><i style="background:#00c2ff"></i>Extreme low</span>
          <span class="ipo-key"><i style="background:#ef5350"></i>Extreme high</span>
        </div></div>
      <div class="ipo-wrap" style="height:520px;"><canvas></canvas><div class="ipo-tip"></div></div>
      <table class="ipo-table" style="margin-top:10px;"><thead><tr><th>Band</th><th>Slope a</th><th>Today</th><th>ETH vs band</th></tr></thead><tbody>
        ${BANDS.map((b, k) => `<tr><td><i class="ipo-dot" style="background:${b.color}"></i>${b.name}${b.note ? ` <span class="ipo-dim">${b.note}</span>` : ''}</td><td>${b.a.toFixed(4)}</td><td>${fmtUsd(vals[k])}</td><td>${pct(p, vals[k])}</td></tr>`).join('')}
      </tbody></table>`;
    canvas = root.querySelector('canvas'); tip = root.querySelector('.ipo-tip');
    explain(n);
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

  // Formula, how the two extreme bands were fitted, and a worked example for today.
  function explain(n) {
    const box = document.getElementById('ethreg-explain');
    if (!box) return;
    const x = Math.round((tOf(n) - ORIGIN) / DAY), lnx = Math.log(x), lo = BANDS[3], xl = BANDS[4];
    box.innerHTML = `
      <h4>The formula</h4>
      <div class="mvz-eq">ETH price = 10<sup>(a × ln(x) − b)</sup></div>
      <ul>
        <li><b>x</b> = days since 21 Jan 2015. Time is on a log scale, so each year moves the bands less than the one before: growth slows as ETH matures.</li>
        <li><b>b</b> = 7.8474, the same for every band.</li>
        <li><b>a</b> = the slope. A bigger <b>a</b> = a higher band. The classic channel uses 1.3241 (lower), 1.3441 (middle) and 1.3641 (upper).</li>
      </ul>
      <h4 style="margin-top:14px;">The two extreme bands</h4>
      <p><b style="color:#00c2ff">Extreme low (a = 1.2994):</b> on 13 Mar 2020 ETH wicked to $88.20, about 35% under the lower band ($135 that day). We solved for the slope that puts a band exactly through that low, the deepest point in ETH's history relative to the channel. No other day has gone below it.</p>
      <p><b style="color:#ef5350">Extreme high (a = 1.4125):</b> ETH's tops reach a lower slope every cycle (1.573 in Jan 2018, 1.484 in May 2021, 1.412 in Mar 2024), so one band cannot touch them all: a band through the 2018 top would sit near $200,000 today. This band goes through the current cycle's top; the 2018 and 2021 tops are above it.</p>
      <h4 style="margin-top:14px;">Worked example: ${fmtDate(n)}</h4>
      <table class="mvz-steps">
        <tr><td>1. Days since 21 Jan 2015</td><td>x</td><td>${x.toLocaleString('en-US')}</td></tr>
        <tr><td>2. Natural log</td><td>ln(${x.toLocaleString('en-US')})</td><td>${lnx.toFixed(4)}</td></tr>
        <tr><td>3. Lower band</td><td>10<sup>(${lo.a.toFixed(4)} × ${lnx.toFixed(4)} − 7.8474)</sup></td><td>${fmtUsd(band(lo.a, tOf(n)))}</td></tr>
        <tr class="res"><td>4. Extreme low band</td><td>10<sup>(${xl.a.toFixed(4)} × ${lnx.toFixed(4)} − 7.8474)</sup></td><td>${fmtUsd(band(xl.a, tOf(n)))}</td></tr>
      </table>`;
  }

  const idxAt = x => { const g = geo; return Math.max(g.i0, Math.min(g.i1, Math.round(g.i0 + (x - g.L) / g.pw * (g.i1 - g.i0)))); };

  function draw() {
    if (!build() || !canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const n = D.n, i0 = zoom ? zoom[0] : 0, i1 = zoom ? zoom[1] : n + FUTURE;
    const L = 8, R = 58, T = 10, Bm = 24, pw = W - L - R, ph = H - T - Bm;
    const X = i => L + (i - i0) / (i1 - i0) * pw;
    const step = Math.max(1, Math.floor((i1 - i0) / (pw * 2)));
    g.font = '11px Inter, sans-serif'; g.textBaseline = 'middle';

    // y range: price wicks in view plus the channel; extreme bands only where they stay close
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= Math.min(i1, n); i++) { if (D.l[i] > 0 && D.l[i] < lo) lo = D.l[i]; if (D.h[i] > hi) hi = D.h[i]; }
    for (const i of [i0, i1]) { const b = band(BANDS[0].a, tOf(i)), c = band(BANDS[4].a, tOf(i)); if (b) hi = Math.max(hi, b); if (c) lo = Math.min(lo, c); }
    if (!isFinite(lo)) { lo = 1; hi = 10; }
    const l0 = Math.floor(Math.log10(lo) * 4) / 4, l1 = Math.ceil(Math.log10(hi) * 4) / 4 || l0 + 1;
    const Y = v => T + (1 - (Math.log10(v) - l0) / (l1 - l0)) * ph;
    const mult = l1 - l0 < 3 ? [1, 2, 5] : [1];
    for (let e = Math.floor(l0); e <= Math.ceil(l1); e++) mult.forEach(m => {
      const v = m * 10 ** e, lv = Math.log10(v); if (lv < l0 || lv > l1) return;
      const y = Y(v); g.strokeStyle = C.grid; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillStyle = C.label; g.textAlign = 'left'; g.fillText(tickLbl(v), L + pw + 6, y);
    });

    // time grid
    const y0 = new Date(tOf(i0)).getUTCFullYear(), y1 = new Date(tOf(i1)).getUTCFullYear(), months = y1 - y0 < 2;
    const every = !months && pw / (y1 - y0 + 1) < 34 ? 2 : 1;
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let y = y0; y <= y1 + 1; y++) for (let m = 0; m < 12; m += months ? 1 : 12) {
      if (!months && y % every) continue;
      const i = (Date.UTC(y, m, 1) - t0) / DAY; if (i < i0 || i > i1) continue;
      const x = X(i); g.strokeStyle = C.grid; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
      g.fillStyle = C.label; g.fillText(months ? new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) + (m === 0 ? ' ' + y : '') : String(y), x, T + ph + 6);
    }

    // future area (bands projected 2 years ahead)
    if (i1 > n) { g.fillStyle = 'rgba(255,255,255,0.025)'; g.fillRect(X(n), T, X(i1) - X(n), ph); }

    // bands: sample every few pixels
    g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
    const pts = []; for (let px = 0; px <= pw; px += 3) { const i = i0 + px / pw * (i1 - i0); pts.push([L + px, BANDS.map(b => band(b.a, tOf(i)))]); }
    const fillBetween = (k1, k2, col) => {
      g.fillStyle = col; g.beginPath(); let started = false;
      pts.forEach(([x, v]) => { if (v[k1] == null) return; started ? g.lineTo(x, Y(v[k1])) : g.moveTo(x, Y(v[k1])); started = true; });
      for (let j = pts.length - 1; j >= 0; j--) { const [x, v] = pts[j]; if (v[k2] != null) g.lineTo(x, Y(v[k2])); }
      g.fill();
    };
    fillBetween(1, 3, 'rgba(46,204,113,0.10)');
    fillBetween(0, 1, 'rgba(239,83,80,0.06)');
    fillBetween(3, 4, 'rgba(0,194,255,0.08)');
    BANDS.forEach((b, k) => {
      g.strokeStyle = b.color; g.lineWidth = k === 0 || k === 4 ? 1.8 : 1.2; g.setLineDash(k === 2 ? [5, 4] : []);
      g.beginPath(); let started = false;
      pts.forEach(([x, v]) => { if (v[k] == null) return; started ? g.lineTo(x, Y(v[k])) : g.moveTo(x, Y(v[k])); started = true; });
      g.stroke();
    });
    g.setLineDash([]);

    // price: high-low range per pixel bucket, then the close line
    g.strokeStyle = C.wick; g.lineWidth = 1;
    for (let i = i0; i <= Math.min(i1, n); i += step) {
      let h = null, l = null;
      for (let j = i; j < i + step && j <= n; j++) { if (D.h[j] != null && (h == null || D.h[j] > h)) h = D.h[j]; if (D.l[j] > 0 && (l == null || D.l[j] < l)) l = D.l[j]; }
      if (h == null || l == null) continue;
      const x = X(i); g.beginPath(); g.moveTo(x, Y(h)); g.lineTo(x, Y(l)); g.stroke();
    }
    g.strokeStyle = C.price; g.lineWidth = 1.3; g.beginPath(); let pen = false;
    for (let i = i0; i <= Math.min(i1, n); i += step) { const v = D.c[i]; if (!(v > 0)) { pen = false; continue; } pen ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); pen = true; }
    g.stroke();
    g.restore();

    // today's band values on the right edge of history
    if (n >= i0 && n <= i1 && pw > 520) {
      g.textAlign = 'right'; g.textBaseline = 'bottom'; g.font = '10px Inter, sans-serif';
      BANDS.forEach(b => { if (b.id === 'mid') return; const v = band(b.a, tOf(n)), y = Y(v); if (y < T + 10 || y > T + ph) return; g.fillStyle = b.color; g.fillText(fmtUsd(v), X(n) - 4, y - 2); });
    }
    g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = C.label; g.font = '11px Inter, sans-serif';
    g.fillText('ETH price (log scale)', L + 4, T + 2);
    if (i1 > n && X(i1) - X(n) > 90) g.fillText('Projection', X(n) + 6, T + 2);

    if (drag) { g.fillStyle = 'rgba(201,168,76,0.12)'; g.fillRect(Math.min(drag.x0, drag.x1), T, Math.abs(drag.x1 - drag.x0), ph); }
    geo = { L, pw, i0, i1, X, Y, T, ph };
  }

  function hover(x) {
    if (!geo || drag) return;
    const { L, pw, X, Y, T, ph } = geo;
    if (x < L || x > L + pw) { tip.style.display = 'none'; return; }
    const i = idxAt(x), t = tOf(i), past = i <= D.n && D.c[i] > 0;
    draw();
    const g = canvas.getContext('2d'), cx = X(i);
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.beginPath(); g.moveTo(cx, T); g.lineTo(cx, T + ph); g.stroke();
    if (past) { g.fillStyle = C.price; g.beginPath(); g.arc(cx, Y(D.c[i]), 3, 0, 7); g.fill(); }
    const z = past ? zoneOf(D.c[i], t) : null;
    tip.innerHTML = `<b>${fmtDate(i)}${past ? '' : ' (projection)'}</b>` +
      (past ? `<div><i style="background:${C.price}"></i>ETH <span>${fmtUsd(D.c[i])}${D.l[i] !== D.h[i] ? ` · low ${fmtUsd(D.l[i])} · high ${fmtUsd(D.h[i])}` : ''}</span></div>` : '') +
      BANDS.map(b => { const v = band(b.a, t); return `<div><i style="background:${b.color}"></i>${b.name} <span>${fmtUsd(v)}${past ? ' · ETH ' + pct(D.c[i], v) : ''}</span></div>`; }).join('') +
      (z ? `<div><i style="background:${z.c}"></i>${z.txt}</div>` : '');
    tip.style.display = 'block';
    tip.style.left = (cx > canvas.clientWidth / 2 ? Math.max(4, cx - tip.offsetWidth - 14) : cx + 14) + 'px';
  }

  window.LegionETHReg = { draw };
})();
