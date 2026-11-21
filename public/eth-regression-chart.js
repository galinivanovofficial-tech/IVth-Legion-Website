/* ETH Logarithmic Regression Bands: ETH price (log scale) under two models built on the same formula.
   'ext' = the 3 classic regression bands plus extreme bands through the deepest low (13 Mar 2020)
           and the current-cycle top.
   'cyc' = cycle bands: the narrowest red band holding every cycle top and the narrowest green band
           holding every cycle low. Each band = two parallel lines 10^(a·ln(x) + c) with its own slope a.
   Formula: price = 10^(a·ln(x) + c), x = days since 21 Jan 2015 ('ext' uses c = −7.847387532 for every band).
   Data: /api/markets/eth-daily → [date, high, low, close]. */
(function () {
  'use strict';

  const DAY = 864e5, B = 7.847387532, ORIGIN = Date.UTC(2015, 0, 21), FUTURE = 730;
  const MODELS = {
    ext: {
      label: 'Channel + extremes',
      bands: [
        { id: 'xhi', name: 'Extreme high', a: 1.4125, color: '#ef5350', note: 'through the current-cycle top (12 Mar 2024, $4,095)' },
        { id: 'hi', name: 'Upper band', a: 1.364138846, color: '#2ecc71' },
        { id: 'mid', name: 'Middle band', a: 1.344138846, color: '#2ecc71', dash: true, noLabel: true },
        { id: 'lo', name: 'Lower band', a: 1.324138846, color: '#2ecc71' },
        { id: 'xlo', name: 'Extreme low', a: 1.2991, color: '#00c2ff', note: 'through the deepest low ever (13 Mar 2020, $88.20)' },
      ],
      fills: [[1, 3, 'rgba(46,204,113,0.10)'], [0, 1, 'rgba(239,83,80,0.06)'], [3, 4, 'rgba(0,194,255,0.08)']],
      thick: [0, 4],
      zones: [
        ['Above the extreme high band (cycle-top territory)', '#ef5350'],
        ['Above the channel (where ETH spent most of 2017–2025)', '#e3c96b'],
        ['Inside the channel (long-term floor)', '#2ecc71'],
        ['Below the channel (only Mar 2020 and Nov 2026)', '#00c2ff'],
        ['Below the extreme low band (never happened before)', '#00c2ff'],
      ],
      zoneEdges: [0, 1, 3, 4],
      vs: [[3, 'lower band'], [4, 'extreme low']],
      legend: [['#2ecc71', 'Regression channel (lower / middle / upper)'], ['#00c2ff', 'Extreme low'], ['#ef5350', 'Extreme high']],
      note: `<strong style="color:var(--text);">What it shows:</strong> Ethereum's long-term growth curve. Price is on a log scale and the bands rise more slowly each year, because ETH's growth slows as it matures. The bands are drawn two years ahead.<br>
        <strong style="color:var(--text);">How to read it:</strong>
        <strong style="color:#2ecc71;">green channel</strong> = ETH's long-term floor: price has spent most of 2017–2025 above it, and closed below it only in March 2020 and November 2026;
        <strong style="color:#00c2ff;">blue band</strong> = the extreme low, drawn through the deepest drop in ETH's history (13 Mar 2020 wick, $88.20); price has never closed below it;
        <strong style="color:#ef5350;">red band</strong> = the extreme high, drawn through the current cycle's top. Past tops reached higher bands each earlier cycle.
        Drag to zoom, double-click to reset. A model of past behaviour, not a forecast.`,
    },
    cyc: {
      label: 'Cycle bands',
      bands: [
        { id: 'rt', name: 'Top band, upper', a: 0.428, c: 0.3413, color: '#ef5350', note: 'through the Nov 2021 top ($4,869)' },
        { id: 'rb', name: 'Top band, lower', a: 0.428, c: 0.1596, color: '#ef5350', note: 'through the Jan 2018 and Aug 2025 tops' },
        { id: 'gt', name: 'Bottom band, upper', a: 1.448, c: -8.4989, color: '#2ecc71', note: 'through the 2015 and Jun 2022 lows' },
        { id: 'gb', name: 'Bottom band, lower', a: 1.448, c: -8.9695, color: '#2ecc71', note: 'through the Mar 2020 low ($88.20)' },
      ],
      fills: [[0, 1, 'rgba(239,83,80,0.16)'], [2, 3, 'rgba(46,204,113,0.13)']],
      thick: [],
      meet: [1, 2], // the bands converge: stop the projection where these two lines cross
      zones: [
        ['Above the top band (never happened since 2016)', '#ef5350'],
        ['Inside the top band (cycle-top zone)', '#ef5350'],
        ['Between the bands', '#e3c96b'],
        ['Inside the bottom band (cycle-low zone)', '#2ecc71'],
        ['Below the bottom band (never happened before)', '#00c2ff'],
      ],
      zoneEdges: [0, 1, 2, 3],
      vs: [[1, 'top band'], [3, 'bottom band floor']],
      legend: [['#ef5350', 'Top band (cycle tops)'], ['#2ecc71', 'Bottom band (cycle lows)']],
      note: `<strong style="color:var(--text);">What it shows:</strong> two regression bands fitted to ETH's real cycle extremes: each band is the narrowest one that holds every top (red) or every low (green), and keeps the same width over time.<br>
        <strong style="color:var(--text);">How to read it:</strong>
        <strong style="color:#ef5350;">red top band</strong> = every cycle top is inside it: the lower edge runs through the Jan 2018 and Aug 2025 tops, the upper edge through the Nov 2021 top. ETH has never traded above it since 2016;
        <strong style="color:#2ecc71;">green bottom band</strong> = every cycle low is inside it: the lower edge runs through the 13 Mar 2020 wick ($88.20) and no day in ETH's history has traded below it; the upper edge runs through the 2015 and Jun 2022 lows.
        Tops have flattened since 2021 while the lows keep rising, so the two bands squeeze together; the projection stops where they meet.
        Drag to zoom, double-click to reset. A model of past behaviour, not a forecast.`,
    },
  };
  MODELS.ext.bands.forEach(b => { b.c = -B; });
  // Cycle extremes shown in the 'cyc' explainer, measured from the data so the 2026 row stays current.
  const EVENTS = [
    ['Top', 'Jan 2018 top', '2017-12-01', '2018-03-01'], ['Top', 'May 2021 top', '2021-04-01', '2021-07-01'],
    ['Top', 'Nov 2021 top', '2021-10-01', '2021-12-31'], ['Top', 'Mar 2024 top', '2024-02-01', '2024-06-01'],
    ['Top', 'Aug 2025 top', '2025-07-01', '2025-12-31'],
    ['Low', '2015 low', '2015-08-01', '2016-01-31'], ['Low', 'Dec 2016 low', '2016-10-01', '2017-01-31'],
    ['Low', 'Dec 2018 low', '2018-06-01', '2019-06-01'], ['Low', 'Mar 2020 low', '2020-01-01', '2020-06-01'],
    ['Low', 'Jun 2022 low', '2022-05-01', '2023-01-01'], ['Low', 'Apr 2025 low', '2025-01-01', '2025-07-01'],
    ['Low', '2026 low so far', '2026-01-01', '2026-12-31'],
  ];
  let model = 'ext';
  try { if (MODELS[localStorage.getItem('ethreg-model')]) model = localStorage.getItem('ethreg-model'); } catch (e) { /* storage blocked */ }
  let M = MODELS[model], BANDS = M.bands;
  const C = { price: '#e8e8f0', wick: 'rgba(232,232,240,0.28)', grid: 'rgba(255,255,255,0.06)', label: '#8a8fa8' };
  let root, canvas, tip, zoom = null, drag = null, D = null, t0 = 0, geo = null, loading = false, wired = false;

  const band = (bd, t) => { const x = (t - ORIGIN) / DAY; return x > 1 ? 10 ** (bd.a * Math.log(x) + bd.c) : null; };
  const fmtUsd = v => v == null ? '—' : v >= 1e3 ? '$' + Math.round(v).toLocaleString('en-US') : v >= 1 ? '$' + v.toFixed(2) : '$' + v.toPrecision(2);
  const sgn = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(4);
  const tickLbl = v => v >= 1e6 ? (v / 1e6) + 'M' : v >= 1e3 ? (v / 1e3) + 'K' : String(v);
  const tOf = i => t0 + i * DAY;
  const fmtDate = i => new Date(tOf(i)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const pct = (p, b) => { const v = (p / b - 1) * 100; return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; };

  // Where a price sits between the bands of the active model.
  function zoneOf(p, t) {
    const k = M.zoneEdges.findIndex(e => p >= band(BANDS[e], t)), z = M.zones[k < 0 ? M.zones.length - 1 : k];
    return { txt: z[0], c: z[1] };
  }

  function setModel(id) {
    if (id === model || !MODELS[id]) return;
    model = id; M = MODELS[id]; BANDS = M.bands;
    try { localStorage.setItem('ethreg-model', id); } catch (e) { /* storage blocked */ }
    root.dataset.ready = ''; draw();
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
    const vals = BANDS.map(b => band(b, tOf(n)));
    root.dataset.ready = '1';
    root.innerHTML = `
      <div class="ipo-ctl"><div class="ipo-row" style="gap:6px 18px;">
        <span class="ipo-dim"><b style="color:var(--text);font-size:13px;">ETH: ${fmtUsd(p)}</b> · <span style="color:${z.c}">${z.txt}</span></span>
        <span class="ipo-dim">${M.vs.map(([k, t]) => `${pct(p, vals[k])} vs ${t}`).join(' · ')}</span>
        <span class="ipo-dim">as of ${fmtDate(n)}</span></div>
        <div class="ipo-row"><span class="ipo-lbl" style="margin-left:0;">Model</span>
          ${Object.entries(MODELS).map(([id, m]) => `<button type="button" class="ipo-key${id === model ? '' : ' off'}" data-model="${id}" aria-pressed="${id === model}">${m.label}</button>`).join('')}</div>
        <div class="ipo-legend">
          <span class="ipo-key" style="cursor:default"><i style="background:${C.price}"></i>ETH price (log)</span>
          ${M.legend.map(([c, t]) => `<span class="ipo-key" style="cursor:default"><i style="background:${c}"></i>${t}</span>`).join('')}
        </div></div>
      <div class="ipo-wrap" style="height:520px;"><canvas></canvas><div class="ipo-tip"></div></div>
      <table class="ipo-table" style="margin-top:10px;"><thead><tr><th>Band</th><th>a / c</th><th>Today</th><th>ETH vs band</th></tr></thead><tbody>
        ${BANDS.map((b, k) => `<tr><td><i class="ipo-dot" style="background:${b.color}"></i>${b.name}${b.note ? ` <span class="ipo-dim">${b.note}</span>` : ''}</td><td>${b.a.toFixed(4)} / ${sgn(b.c)}</td><td>${fmtUsd(vals[k])}</td><td>${pct(p, vals[k])}</td></tr>`).join('')}
      </tbody></table>`;
    canvas = root.querySelector('canvas'); tip = root.querySelector('.ipo-tip');
    root.querySelectorAll('[data-model]').forEach(b => b.addEventListener('click', () => setModel(b.dataset.model)));
    const note = document.getElementById('ethreg-note'); if (note) note.innerHTML = M.note;
    explain(n);
    canvas.addEventListener('mousedown', e => { drag = { x0: e.offsetX, x1: e.offsetX }; });
    canvas.addEventListener('mousemove', e => { if (drag) { drag.x1 = e.offsetX; draw(); } hover(e.offsetX); });
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; drag = null; draw(); });
    canvas.addEventListener('touchmove', e => { const r = canvas.getBoundingClientRect(); hover(e.touches[0].clientX - r.left); }, { passive: true });
    const reset = e => { e.preventDefault(); zoom = null; draw(); };
    canvas.addEventListener('contextmenu', reset);
    canvas.addEventListener('dblclick', reset);
    if (wired) return true; // window listeners survive a model switch, add them once
    wired = true;
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1); drag = null;
      if (b - a > 8) { const i0 = idxAt(a), i1 = idxAt(b); if (i1 - i0 > 5) zoom = [i0, i1]; }
      draw();
    });
    window.addEventListener('resize', () => { if (root.offsetParent) draw(); });
    return true;
  }

  // Formula, how the two extreme bands were fitted, and a worked example for today.
  function explain(n) {
    const box = document.getElementById('ethreg-explain');
    if (!box) return;
    const x = Math.round((tOf(n) - ORIGIN) / DAY), lnx = Math.log(x);
    const lo = BANDS[model === 'ext' ? 3 : 1], xl = BANDS[model === 'ext' ? 4 : 3];
    const step = (k, b) => `<tr${k === 4 ? ' class="res"' : ''}><td>${k}. ${b.name}</td><td>10<sup>(${b.a.toFixed(4)} × ${lnx.toFixed(4)} ${sgn(b.c).replace(/^([+−])/, '$1 ')})</sup></td><td>${fmtUsd(band(b, tOf(n)))}</td></tr>`;
    box.innerHTML = `
      <h4>The formula</h4>
      <div class="mvz-eq">ETH price = 10<sup>(a × ln(x) + c)</sup></div>
      <ul>
        <li><b>x</b> = days since 21 Jan 2015. Time is on a log scale, so each year moves the bands less than the one before: growth slows as ETH matures.</li>
        ${model === 'ext'
          ? `<li><b>c</b> = −7.8474, the same for every band.</li>
        <li><b>a</b> = the slope. A bigger <b>a</b> = a higher band. The classic channel uses 1.3241 (lower), 1.3441 (middle) and 1.3641 (upper).</li>`
          : `<li><b>a</b> = how fast the band rises. The two lines of a band share the same <b>a</b>, so the band keeps the same width.</li>
        <li><b>c</b> = the height of each line.</li>`}
      </ul>
      ${model === 'ext' ? extExplain() : cycExplain()}
      <h4 style="margin-top:14px;">Worked example: ${fmtDate(n)}</h4>
      <table class="mvz-steps">
        <tr><td>1. Days since 21 Jan 2015</td><td>x</td><td>${x.toLocaleString('en-US')}</td></tr>
        <tr><td>2. Natural log</td><td>ln(${x.toLocaleString('en-US')})</td><td>${lnx.toFixed(4)}</td></tr>
        ${step(3, lo)}${step(4, xl)}
      </table>`;
  }

  const extExplain = () => `
      <h4 style="margin-top:14px;">The two extreme bands</h4>
      <p><b style="color:#00c2ff">Extreme low (a = 1.2991):</b> on 13 Mar 2020 ETH wicked to $88.20, about 35% under the lower band ($135 that day). We solved for the slope that puts a band exactly through that low, the deepest point in ETH's history relative to the channel. No other day has gone below it.</p>
      <p><b style="color:#ef5350">Extreme high (a = 1.4125):</b> ETH's tops reach a lower slope every cycle (1.573 in Jan 2018, 1.484 in May 2021, 1.412 in Mar 2024), so one band cannot touch them all: a band through the 2018 top would sit near $200,000 today. This band goes through the current cycle's top; the 2018 and 2021 tops are above it.</p>`;

  // Each cycle top / low and where it sits relative to its band (0% = lower edge, 100% = upper edge).
  function cycExplain() {
    const rows = EVENTS.map(([kind, name, s, e]) => {
      const [hiB, loB] = kind === 'Top' ? [BANDS[0], BANDS[1]] : [BANDS[2], BANDS[3]];
      let best = null;
      for (let i = Math.max(0, Math.round((Date.parse(s) - t0) / DAY)); i <= Math.min(D.n, Math.round((Date.parse(e) - t0) / DAY)); i++) {
        const p = kind === 'Top' ? D.h[i] : D.l[i]; if (!(p > 0)) continue;
        const r = p / band(loB, tOf(i)); if (!best || (kind === 'Top' ? r > best.r : r < best.r)) best = { i, p, r };
      }
      if (!best) return '';
      const lo = band(loB, tOf(best.i)), hi = band(hiB, tOf(best.i)), pos = Math.log(best.p / lo) / Math.log(hi / lo) * 100;
      const col = kind === 'Top' ? '#ef5350' : '#2ecc71', what = kind === 'Top' ? 'top band' : 'bottom band';
      const where = pos > 100.5 ? `${pct(best.p, hi)} above ${what}` : pos < -0.5 ? `${pct(best.p, lo).replace('-', '')} below ${what}`
        : `<span style="color:${col}">inside ${what}</span> <span class="ipo-dim">(${Math.round(Math.max(0, Math.min(100, pos)))}% up)</span>`;
      return `<tr><td>${name}</td><td>${fmtDate(best.i)}</td><td>${fmtUsd(best.p)}</td><td>${where}</td></tr>`;
    }).join('');
    const mt = meetT();
    return `
      <h4 style="margin-top:14px;">How the cycle bands were fitted</h4>
      <p>Each band is two parallel lines. For every possible slope <b>a</b> we pushed the two lines as close together as they can go while still holding every cycle top (red) or every cycle low (green), and kept the slope that gives the narrowest band.</p>
      <p><b style="color:#ef5350">Top band</b> (a = ${BANDS[0].a}, ${(band(BANDS[0], tOf(D.n)) / band(BANDS[1], tOf(D.n))).toFixed(2)}× wide): the lower edge touches the Jan 2018 and Aug 2025 tops, the upper edge the Nov 2021 top. The Mar 2024 high sits just under it because it was not the cycle top.<br>
      <b style="color:#2ecc71">Bottom band</b> (a = ${BANDS[2].a}, ${(band(BANDS[2], tOf(D.n)) / band(BANDS[3], tOf(D.n))).toFixed(2)}× wide): the lower edge touches the 13 Mar 2020 wick, and no day has ever traded below it; the upper edge touches the 2015 and Jun 2022 lows.</p>
      <p><b>The squeeze:</b> ETH's tops have barely risen since 2021 while its lows keep climbing, so the bottom band rises faster than the top band. ${mt ? `The top of the green band meets the bottom of the red band around <b>${new Date(mt).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</b>, at about ${fmtUsd(band(BANDS[M.meet[0]], mt))}.` : ''} Read it as ETH's cycle range getting tighter, not as a date.</p>
      <table class="ipo-table"><thead><tr><th>Event</th><th>Date</th><th>Price</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // Time (ms) where the two 'meet' lines of the active model cross, or null.
  function meetT() {
    if (!M.meet) return null;
    const [p, q] = M.meet.map(k => BANDS[k]);
    if (p.a === q.a) return null;
    return ORIGIN + Math.exp((p.c - q.c) / (q.a - p.a)) * DAY;
  }

  const idxAt = x => { const g = geo; return Math.max(g.i0, Math.min(g.i1, Math.round(g.i0 + (x - g.L) / g.pw * (g.i1 - g.i0)))); };

  function draw() {
    if (!build() || !canvas) return;
    const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const mt = meetT(), mIdx = mt ? Math.round((mt - t0) / DAY) : null;
    const n = D.n, i0 = zoom ? zoom[0] : 0, i1 = zoom ? zoom[1] : (mIdx && mIdx > n + 60 ? Math.min(n + FUTURE, mIdx) : n + FUTURE);
    const L = 8, R = 58, T = 10, Bm = 24, pw = W - L - R, ph = H - T - Bm;
    const X = i => L + (i - i0) / (i1 - i0) * pw;
    const step = Math.max(1, Math.floor((i1 - i0) / (pw * 2)));
    g.font = '11px Inter, sans-serif'; g.textBaseline = 'middle';

    // y range: price wicks in view plus the channel; extreme bands only where they stay close
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= Math.min(i1, n); i++) { if (D.l[i] > 0 && D.l[i] < lo) lo = D.l[i]; if (D.h[i] > hi) hi = D.h[i]; }
    for (const i of [i0, i1]) { const b = band(BANDS[0], tOf(i)), c = band(BANDS[BANDS.length - 1], tOf(i)); if (b) hi = Math.max(hi, b); if (c) lo = Math.min(lo, c); }
    if (!isFinite(lo)) { lo = 1; hi = 10; }
    hi *= 1.5; // headroom so the top band's price label fits
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
    const pts = []; for (let px = 0; px <= pw; px += 3) { const i = i0 + px / pw * (i1 - i0); pts.push([L + px, BANDS.map(b => band(b, tOf(i)))]); }
    const fillBetween = (k1, k2, col) => {
      g.fillStyle = col; g.beginPath(); let started = false;
      pts.forEach(([x, v]) => { if (v[k1] == null) return; started ? g.lineTo(x, Y(v[k1])) : g.moveTo(x, Y(v[k1])); started = true; });
      for (let j = pts.length - 1; j >= 0; j--) { const [x, v] = pts[j]; if (v[k2] != null) g.lineTo(x, Y(v[k2])); }
      g.fill();
    };
    M.fills.forEach(([k1, k2, col]) => fillBetween(k1, k2, col));
    BANDS.forEach((b, k) => {
      g.strokeStyle = b.color; g.lineWidth = M.thick.includes(k) ? 1.8 : 1.3; g.setLineDash(b.dash ? [5, 4] : []);
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
      let lastY = -1e9; // push a label down when it would overlap the one above
      BANDS.forEach(b => { if (b.noLabel) return; const v = band(b, tOf(n)), y = Y(v); if (y < T + 10 || y > T + ph) return; const ly = Math.max(y - 2, lastY + 12); lastY = ly; g.fillStyle = b.color; g.fillText(fmtUsd(v), X(n) - 4, ly); });
    }
    g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = C.label; g.font = '11px Inter, sans-serif';
    g.fillText('ETH price (log scale)', L + 4, T + 2);
    if (i1 > n && X(i1) - X(n) > 90) g.fillText('Projection', X(n) + 6, T + 2);
    if (mIdx && mIdx >= i0 && mIdx <= i1) {
      const mx = X(mIdx); g.strokeStyle = 'rgba(227,201,107,0.6)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(mx, T); g.lineTo(mx, T + ph); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#e3c96b'; g.textAlign = 'right'; g.fillText('Bands meet ' + new Date(mt).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }), mx - 4, T + ph - 16);
    }

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
      BANDS.map(b => { const v = band(b, t); return `<div><i style="background:${b.color}"></i>${b.name} <span>${fmtUsd(v)}${past ? ' · ETH ' + pct(D.c[i], v) : ''}</span></div>`; }).join('') +
      (z ? `<div><i style="background:${z.c}"></i>${z.txt}</div>` : '');
    tip.style.display = 'block';
    tip.style.left = (cx > canvas.clientWidth / 2 ? Math.max(4, cx - tip.offsetWidth - 14) : cx + 14) + 'px';
  }

  window.LegionETHReg = { draw };
})();
