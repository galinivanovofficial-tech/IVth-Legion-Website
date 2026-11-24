/* Halving Progress: BTC price (log scale) with one band per halving epoch covering the same share of
   the epoch that the current one has completed (live from the block height), all-time-high dots,
   the last price line and the estimated next halving.
   Data: /api/markets/btc-halving -> { days: [[date, high, low, close]], tip: {height, avgBlockSec,
   nextHalvingHeight, nextHalvingEst}, halvings: [{n, height, date}] } */
(function () {
  'use strict';

  const DAY = 864e5, EPOCH = 210000, PRE_ATH = 31.91;   // Jun 2011 high (before Bitstamp data starts)
  const C = { price: '#e8e8f0', wick: 'rgba(232,232,240,0.28)', grid: 'rgba(255,255,255,0.06)', label: '#8a8fa8',
              band: 'rgba(242,153,74,0.13)', bandEdge: 'rgba(242,153,74,0.55)', bandText: '#f2c38a', ath: '#ffffff', last: '#ef5350' };
  const PRESETS = [['live', null], ['50%', 0.5], ['75%', 0.75], ['100%', 1]];
  const RANGES = [['All', null], ['4Y', 4 * 365], ['1Y', 365]];
  let root, canvas, tip, D = null, t0 = 0, geo = null, loading = false, wired = false;
  let frac = null, range = null, zoom = null, drag = null;

  const tOf = i => t0 + i * DAY;
  const idxOf = d => Math.round((Date.parse(d + 'T00:00:00Z') - t0) / DAY);
  const fmtUsd = v => v == null ? '—' : v >= 1e3 ? '$' + Math.round(v).toLocaleString('en-US') : '$' + (v >= 10 ? v.toFixed(0) : v.toFixed(2));
  const fmtDate = i => new Date(tOf(i)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const tickLbl = v => v >= 1e6 ? (v / 1e6) + 'M' : v >= 1e3 ? (v / 1e3) + 'K' : String(v);
  const pct = (a, b) => { const v = (a / b - 1) * 100; return (v >= 0 ? '+' : '') + v.toFixed(0) + '%'; };
  const live = () => (D.tip.height - D.halv[3].height) / EPOCH;          // share of the current epoch done
  const share = () => frac == null ? live() : frac;

  async function load() {
    if (D || loading) return;
    loading = true;
    try {
      const r = await fetch('/api/markets/btc-halving');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      t0 = Date.parse(j.days[0][0] + 'T00:00:00Z');
      const n = idxOf(j.days[j.days.length - 1][0]) + 1;
      D = { h: new Array(n).fill(null), l: new Array(n).fill(null), c: new Array(n).fill(null), n: n - 1, tip: j.tip, ath: [] };
      for (const [d, h, l, c] of j.days) { const i = idxOf(d); D.h[i] = h; D.l[i] = l; D.c[i] = c; }
      let top = PRE_ATH;
      for (let i = 0; i <= D.n; i++) if (D.h[i] > top) { top = D.h[i]; D.ath.push(i); }
      // epochs: [start, end) as day indexes; the last end is the estimated next halving
      D.halv = j.halvings.map(h => ({ ...h, i: idxOf(h.date) }));
      D.next = { n: D.halv.length + 1, height: j.tip.nextHalvingHeight, i: idxOf(j.tip.nextHalvingEst), date: j.tip.nextHalvingEst };
      D.ep = D.halv.map((h, k) => ({ n: h.n, s: h.i, e: k + 1 < D.halv.length ? D.halv[k + 1].i : D.next.i }));
    } catch (e) {
      root.innerHTML = `<p class="ipo-note">BTC halving data is unavailable right now (${e.message}).</p>`;
      loading = false; return;
    }
    loading = false;
    root.dataset.ready = '';
    draw();
  }

  // band end (day index) of an epoch for the current share
  // The live share comes from blocks, so in the current epoch the live band ends exactly today.
  const today = () => { let n = D.n; while (n > 0 && D.c[n] == null) n--; return n; };
  const bandEnd = ep => (frac == null && ep.n === D.halv[D.halv.length - 1].n) ? today() : ep.s + share() * (ep.e - ep.s);
  const inBand = i => D.ep.some(ep => i >= ep.s && i <= bandEnd(ep));

  // For each epoch: the highest price inside its band, and the close at the band's end (today's position in past cycles).
  function epochStats() {
    let n = D.n; while (n > 0 && D.c[n] == null) n--;
    return D.ep.map(ep => {
      const end = Math.min(Math.round(bandEnd(ep)), n);
      let pk = null;
      for (let i = ep.s; i <= end; i++) if (D.h[i] != null && (pk == null || D.h[i] > D.h[pk])) pk = i;
      let ci = end; while (ci > ep.s && D.c[ci] == null) ci--;
      return { ...ep, end, pk, peak: pk != null ? D.h[pk] : null, peakAt: pk != null ? (pk - ep.s) / (ep.e - ep.s) : null,
               halvPrice: D.c[ep.s], close: D.c[ci], closeI: ci, current: ep.n === D.halv[D.halv.length - 1].n };
    });
  }

  function build() {
    root = document.getElementById('halving-root');
    if (!root) return false;
    if (!D) { if (!root.innerHTML) root.innerHTML = '<p class="ipo-note">Loading BTC history…</p>'; load(); return false; }
    if (root.dataset.ready === '1') return true;
    root.dataset.ready = '1';
    let n = D.n; while (n > 0 && D.c[n] == null) n--;
    const p = live(), left = D.next.height - D.tip.height, days = Math.round((D.next.i - n));
    const inside = D.ath.filter(inBand).length, cur = epochStats();
    const now = cur[cur.length - 1];
    root.innerHTML = `
      <div class="ipo-ctl">
        <div class="ipo-row" style="gap:6px 18px;">
          <span class="ipo-dim"><b style="color:var(--text);font-size:13px;">Epoch ${now.n}: ${(p * 100).toFixed(1)}% done</b> · block ${D.tip.height.toLocaleString('en-US')} of ${D.next.height.toLocaleString('en-US')}</span>
          <span class="ipo-dim">next halving ≈ ${new Date(D.next.date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} (${left.toLocaleString('en-US')} blocks, ~${days} days)</span>
          <span class="ipo-dim">BTC ${fmtUsd(D.c[n])} · ${now.peak ? pct(D.c[n], now.peak) + ' from this cycle\'s peak' : ''}</span>
        </div>
        <div style="height:6px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden;"><div style="width:${(p * 100).toFixed(2)}%;height:100%;background:linear-gradient(90deg,#c9a84c,#f2994a);"></div></div>
        <div class="ipo-row"><span class="ipo-lbl" style="margin-left:0;">Band</span>
          ${PRESETS.map(([l, v]) => `<button type="button" class="ipo-key${v === frac ? '' : ' off'}" data-frac="${v == null ? 'live' : v}">${l === 'live' ? 'Live ' + (p * 100).toFixed(1) + '%' : l}</button>`).join('')}
          <span class="ipo-lbl">Range</span>
          ${RANGES.map(([l, v]) => `<button type="button" class="ipo-key${v === range ? '' : ' off'}" data-range="${v == null ? 'all' : v}">${l}</button>`).join('')}
        </div>
        <div class="ipo-legend">
          <span class="ipo-key" style="cursor:default"><i style="background:#f2994a"></i>Band: the first ${(share() * 100).toFixed(share() < 1 ? 1 : 0)}% of each halving epoch</span>
          <span class="ipo-key" style="cursor:default"><i style="background:#fff"></i>All-time highs: ${inside} of ${D.ath.length} days printed inside a band</span>
          <span class="ipo-key" style="cursor:default"><i style="background:${C.last}"></i>Last price</span>
        </div>
      </div>
      <div class="ipo-wrap" style="height:520px;"><canvas></canvas><div class="ipo-tip"></div></div>
      <div class="ipo-stats"><table class="ipo-table" style="margin-top:10px;"><thead><tr>
        <th>Epoch</th><th>Halving</th><th>BTC at halving</th><th>Peak inside band</th><th>Peak at</th><th>At ${(share() * 100).toFixed(1)}% of the epoch</th><th>From peak</th></tr></thead><tbody>
        ${cur.map(s => `<tr${s.current ? ' style="background:rgba(242,153,74,0.08)"' : ''}><td>${s.n}${s.current ? ' <span class="ipo-dim">(now)</span>' : ''}</td><td>${fmtDate(s.s)}</td><td>${fmtUsd(s.halvPrice)}</td>
          <td>${s.peak ? fmtUsd(s.peak) + ' <span class="ipo-dim">' + fmtDate(s.pk) + '</span>' : '—'}</td><td>${s.peakAt != null ? (s.peakAt * 100).toFixed(0) + '%' : '—'}</td>
          <td>${fmtUsd(s.close)} <span class="ipo-dim">${fmtDate(s.closeI)}</span></td><td>${s.peak ? pct(s.close, s.peak) : '—'}</td></tr>`).join('')}
      </tbody></table></div>`;
    canvas = root.querySelector('canvas'); tip = root.querySelector('.ipo-tip');
    root.querySelectorAll('[data-frac]').forEach(b => b.addEventListener('click', () => {
      frac = b.dataset.frac === 'live' ? null : Number(b.dataset.frac); root.dataset.ready = ''; draw();
    }));
    root.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
      range = b.dataset.range === 'all' ? null : Number(b.dataset.range); zoom = null; root.dataset.ready = ''; draw();
    }));
    explain(cur, inside);
    canvas.addEventListener('mousedown', e => { drag = { x0: e.offsetX, x1: e.offsetX }; });
    canvas.addEventListener('mousemove', e => { if (drag) { drag.x1 = e.offsetX; draw(); } hover(e.offsetX); });
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; drag = null; draw(); });
    canvas.addEventListener('touchmove', e => { const r = canvas.getBoundingClientRect(); hover(e.touches[0].clientX - r.left); }, { passive: true });
    const reset = e => { e.preventDefault(); zoom = null; draw(); };
    canvas.addEventListener('contextmenu', reset);
    canvas.addEventListener('dblclick', reset);
    if (wired) return true;
    wired = true;
    window.addEventListener('mouseup', () => {
      if (!drag || !geo) return;
      const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1); drag = null;
      if (b - a > 8) { const i0 = idxAt(a), i1 = idxAt(b); if (i1 - i0 > 5) zoom = [i0, i1]; }
      draw();
    });
    window.addEventListener('resize', () => { if (root && root.offsetParent) draw(); });
    return true;
  }

  function explain(cur, inside) {
    const box = document.getElementById('halving-explain');
    if (!box) return;
    const out = D.ath.filter(i => !inBand(i));
    const outTxt = out.length ? `${fmtDate(out[0])} – ${fmtDate(out[out.length - 1])}` : '';
    const past = cur.filter(s => !s.current && s.peak);
    box.innerHTML = `
      <h4>How it works</h4>
      <ul>
        <li>A <b>halving epoch</b> is the 210,000 blocks between two halvings, about 4 years. The current epoch started at block 840,000 on 20 Apr 2024 and ends at block 1,050,000.</li>
        <li><b>Progress</b> = blocks mined since the last halving ÷ 210,000, from the live block height (mempool.space). Today: ${(live() * 100).toFixed(1)}%.</li>
        <li>Each <b>band</b> covers the same share of every past epoch, measured in time from its halving. It shows where each past cycle was at the point we are at now. The next halving date is an estimate from the recent average block time (${D.tip.avgBlockSec} s).</li>
      </ul>
      <h4 style="margin-top:14px;">What the bands show</h4>
      <p>${inside} of the ${D.ath.length} days that set a new all-time high fell inside a band${out.length ? `. The exceptions are the ${out.length} days of ${outTxt}, when BTC set new highs in the last weeks before the 4th halving (spot ETF inflows), the first time a cycle broke its old high before the halving` : ''}.</p>
      <p>In every past cycle the peak came early: ${past.map(s => `epoch ${s.n} topped at ${(s.peakAt * 100).toFixed(0)}% of the epoch`).join(', ')}. By the ${(share() * 100).toFixed(1)}% point, BTC was ${past.map(s => pct(s.close, s.peak)).join(', ')} below those peaks.</p>
      <p class="ipo-dim">All-time highs use daily highs from Bitstamp (data from Jan 2012) and start above the June 2011 high of $31.91. A model of past cycles, not a forecast.</p>`;
  }

  const idxAt = x => { const g = geo; return Math.max(g.i0, Math.min(g.i1, Math.round(g.i0 + (x - g.L) / g.pw * (g.i1 - g.i0)))); };

  function draw() {
    if (!build() || !canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    let n = D.n; while (n > 0 && D.c[n] == null) n--;
    const end = Math.max(D.next.i + 60, n + 30);
    const i0 = zoom ? zoom[0] : range ? Math.max(0, n - range) : 0, i1 = zoom ? zoom[1] : range ? n + Math.round(range * 0.08) : end;
    const L = 8, R = 62, T = 10, Bm = 24, pw = W - L - R, ph = H - T - Bm;
    const X = i => L + (i - i0) / (i1 - i0) * pw;
    const step = Math.max(1, Math.floor((i1 - i0) / (pw * 2)));
    g.font = '11px Inter, sans-serif';

    // y range from the visible prices
    let lo = Infinity, hi = -Infinity;
    for (let i = Math.max(0, i0); i <= Math.min(i1, D.n); i++) { if (D.l[i] > 0 && D.l[i] < lo) lo = D.l[i]; if (D.h[i] > hi) hi = D.h[i]; }
    if (!isFinite(lo)) { lo = 1; hi = 10; }
    hi *= 1.6; lo /= 1.3;
    const l0 = Math.log10(lo), l1 = Math.log10(hi);
    const Y = v => T + (1 - (Math.log10(v) - l0) / (l1 - l0)) * ph;
    g.textBaseline = 'middle';
    const mult = l1 - l0 < 2.5 ? [1, 2, 5] : [1];
    for (let e = Math.floor(l0); e <= Math.ceil(l1); e++) mult.forEach(m => {
      const v = m * 10 ** e, lv = Math.log10(v); if (lv < l0 || lv > l1) return;
      const y = Y(v); g.strokeStyle = C.grid; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillStyle = C.label; g.textAlign = 'left'; g.fillText('$' + tickLbl(v), L + pw + 6, y);
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

    g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
    // bands
    const sh = share(), shTxt = (sh * 100).toFixed(sh < 1 ? 0 : 0) + '%';
    D.ep.forEach(ep => {
      const a = X(ep.s), b = X(bandEnd(ep)); if (b < L || a > L + pw) return;
      g.fillStyle = C.band; g.fillRect(a, T + 2, b - a, ph - 2);
      g.strokeStyle = C.bandEdge; g.lineWidth = 1; g.strokeRect(a + 0.5, T + 2.5, b - a - 1, ph - 3);
      if (b - a > 46) {
        // labels at the bottom of the band: on a log chart the price sits high, the bottom is empty
        g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillStyle = C.bandText;
        g.font = '600 16px Inter, sans-serif'; g.fillText(shTxt, (a + b) / 2, T + ph - 24);
        g.font = '11px Inter, sans-serif'; g.fillStyle = C.label; g.fillText('Halving ' + ep.n, (a + b) / 2, T + ph - 8);
      }
    });
    // next halving (estimate)
    if (D.next.i >= i0 && D.next.i <= i1) {
      const x = X(D.next.i); g.strokeStyle = 'rgba(242,153,74,0.7)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.setLineDash([]);
      g.save(); g.translate(x - 5, T + ph - 8); g.rotate(-Math.PI / 2); g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillStyle = C.bandText; g.font = '11px Inter, sans-serif';
      g.fillText('Halving ' + D.next.n + ' (est. ' + new Date(D.next.date + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) + ')', 0, 0); g.restore();
    }
    // today
    if (n >= i0 && n <= i1) { const x = X(n); g.strokeStyle = 'rgba(255,255,255,0.35)'; g.setLineDash([3, 4]); g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.setLineDash([]); }

    // price: high-low wick per bucket, then the close line
    g.strokeStyle = C.wick; g.lineWidth = 1;
    for (let i = Math.max(0, i0); i <= Math.min(i1, D.n); i += step) {
      let h = null, l = null;
      for (let j = i; j < i + step && j <= D.n; j++) { if (D.h[j] != null && (h == null || D.h[j] > h)) h = D.h[j]; if (D.l[j] > 0 && (l == null || D.l[j] < l)) l = D.l[j]; }
      if (h == null || l == null) continue;
      const x = X(i); g.beginPath(); g.moveTo(x, Y(h)); g.lineTo(x, Y(l)); g.stroke();
    }
    g.strokeStyle = C.price; g.lineWidth = 1.3; g.beginPath(); let pen = false;
    for (let i = Math.max(0, i0); i <= Math.min(i1, D.n); i += step) { const v = D.c[i]; if (!(v > 0)) { pen = false; continue; } pen ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); pen = true; }
    g.stroke();
    // all-time-high dots (one per 3 px)
    let lastX = -1e9;
    D.ath.forEach(i => {
      if (i < i0 || i > i1) return; const x = X(i); if (x - lastX < 3) return; lastX = x;
      g.fillStyle = inBand(i) ? C.ath : '#ff8a80'; g.beginPath(); g.arc(x, Y(D.h[i]), 2.2, 0, 7); g.fill();
    });
    // last price
    const lp = D.c[n], ly = Y(lp);
    g.strokeStyle = C.last; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(L, ly); g.lineTo(L + pw, ly); g.stroke(); g.setLineDash([]);
    g.restore();
    g.fillStyle = C.last; g.fillRect(L + pw + 2, ly - 9, R - 4, 18);
    g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = '600 11px Inter, sans-serif'; g.fillText(fmtUsd(lp), L + pw + 6, ly);

    g.font = '11px Inter, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = C.label;
    if (drag) { g.fillStyle = 'rgba(201,168,76,0.12)'; g.fillRect(Math.min(drag.x0, drag.x1), T, Math.abs(drag.x1 - drag.x0), ph); }
    geo = { L, pw, i0, i1, X, Y, T, ph };
  }

  function hover(x) {
    if (!geo || drag) return;
    const { L, pw, X, Y, T, ph } = geo;
    if (x < L || x > L + pw) { tip.style.display = 'none'; return; }
    const i = idxAt(x), past = i <= D.n && D.c[i] > 0;
    draw();
    const g = canvas.getContext('2d'), cx = X(i);
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.beginPath(); g.moveTo(cx, T); g.lineTo(cx, T + ph); g.stroke();
    if (past) { g.fillStyle = C.price; g.beginPath(); g.arc(cx, Y(D.c[i]), 3, 0, 7); g.fill(); }
    const ep = D.ep.find(e => i >= e.s && i < e.e);
    const prog = ep ? (i - ep.s) / (ep.e - ep.s) : null;
    tip.innerHTML = `<b>${fmtDate(i)}${past ? '' : ' (future)'}</b>` +
      (past ? `<div><i style="background:${C.price}"></i>BTC <span>${fmtUsd(D.c[i])} · low ${fmtUsd(D.l[i])} · high ${fmtUsd(D.h[i])}</span></div>` : '') +
      (ep ? `<div><i style="background:#f2994a"></i>Epoch ${ep.n} <span>${(prog * 100).toFixed(1)}% done${inBand(i) ? ' · inside band' : ''}</span></div>` : '<div>Before the first halving</div>') +
      (past && D.ath.includes(i) ? `<div><i style="background:#fff"></i>New all-time high</div>` : '');
    tip.style.display = 'block';
    tip.style.left = (cx > canvas.clientWidth / 2 ? Math.max(4, cx - tip.offsetWidth - 14) : cx + 14) + 'px';
  }

  window.LegionHalving = { draw };
})();
