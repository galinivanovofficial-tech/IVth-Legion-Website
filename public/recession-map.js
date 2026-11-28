/* US Recession Map: every state classified each month as in recession / on the verge / not in recession,
   from two monthly signals:
     • Sahm gap  = 3-month average unemployment minus its lowest 3-month average of the prior 12 months
     • Coincident index (Philadelphia Fed) % change over 3 months
   State rules:  In recession  = Sahm gap ≥ 0.5 AND index falling, or index down ≥ 1% in 3 months
                 On the verge  = one signal fired (gap ≥ 0.5 or index falling), or gap ≥ 0.3 with index growth < 0.5%
   US rules:     In recession  = NBER-dated recession, or national Sahm ≥ 0.5 with 15+ states in recession, or 25+ states in recession
                 On the verge  = national Sahm ≥ 0.3, or 8+ states in recession, or 25+ states in recession or on the verge
   Data: /api/markets/state-recession -> { months, states: {AL: {name, ur, ci}}, us: {ur, sahm, usrec} } */
(function () {
  'use strict';

  // Hex tile grid (pointy-top): [state, column, row]; odd rows are offset by half a column
  const GRID = [['AK',0,0],['ME',11,0],['VT',9.5,1],['NH',10.5,1],
    ['WA',1,2],['MT',2,2],['ND',3,2],['MN',4,2],['WI',5,2],['MI',7,2],['NY',9,2],['MA',10,2],['RI',11,2],
    ['OR',1.5,3],['ID',2.5,3],['WY',3.5,3],['SD',4.5,3],['IA',5.5,3],['IL',6.5,3],['IN',7.5,3],['OH',8.5,3],['PA',9.5,3],['NJ',10.5,3],['CT',11.5,3],
    ['CA',1,4],['NV',2,4],['UT',3,4],['CO',4,4],['NE',5,4],['MO',6,4],['KY',7,4],['WV',8,4],['MD',9,4],['DE',10,4],
    ['AZ',2.5,5],['NM',3.5,5],['KS',4.5,5],['AR',5.5,5],['TN',6.5,5],['VA',7.5,5],['NC',8.5,5],
    ['OK',4,6],['LA',5,6],['MS',6,6],['AL',7,6],['SC',8,6],
    ['TX',4.5,7],['GA',7.5,7],['FL',8,8],['HI',0,8.6]];
  const COL = { R: '#d9452b', V: '#f0a030', N: '#2f6db3', X: '#555a6e' };
  const LABEL = { R: 'In recession', V: 'On the verge', N: 'Not in recession', X: 'Data unavailable' };
  const US_LABEL = { R: 'US IN RECESSION', V: 'US ON THE VERGE OF RECESSION', N: 'US NOT IN RECESSION' };
  const JUMPS = [['1980', '1980-07'], ['1982', '1982-06'], ['1991', '1991-02'], ['2001', '2001-09'], ['2009', '2009-03'], ['2016 oil', '2016-03'], ['2020', '2020-04']];
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  let root, D = null, loading = false, sel = 0, selState = null, playT = null, scrub = null;

  const fmtM = m => MON[+m.slice(5) - 1] + ' ' + m.slice(0, 4);
  const sgn = (v, dp) => (v >= 0 ? '+' : '') + v.toFixed(dp);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function css() {
    if (document.getElementById('rmap-css')) return;
    const st = document.createElement('style'); st.id = 'rmap-css';
    st.textContent = `
.rmap{padding:14px 16px 8px}
.rmap-us{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:12px 14px;border-radius:10px;border:1px solid var(--border2);margin-bottom:12px}
.rmap-us b{font-size:15px;letter-spacing:.04em}
.rmap-us span{font-size:12px;color:var(--text-muted)}
.rmap-ctl{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:8px}
.rmap-ctl button{background:var(--dark3);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:4px 9px;font-size:12px;cursor:pointer}
.rmap-ctl button:hover{border-color:var(--gold)}
.rmap-ctl button.on{border-color:var(--gold);color:var(--gold)}
.rmap-month{font-weight:600;font-size:15px;min-width:86px;text-align:center}
.rmap-jumps{margin-left:auto;display:flex;flex-wrap:wrap;gap:4px}
.rmap-jumps button{font-size:11px;padding:3px 7px;color:var(--text-muted)}
.rmap-scrub{width:100%;height:74px;display:block;cursor:ew-resize;touch-action:none;margin-bottom:4px}
.rmap-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--text-muted);margin:6px 0 2px}
.rmap-legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.rmap-body{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.rmap-map{flex:1 1 440px;min-width:0}
.rmap-stitle{font-size:11px;color:var(--text-muted);margin:2px 0 3px}
.rmap-map svg{width:100%;height:auto;display:block}
.rmap-map polygon{stroke:var(--dark2);stroke-width:2;cursor:pointer;transition:opacity .12s}
.rmap-map g:hover polygon{opacity:.8}
.rmap-map g.sel polygon{stroke:#fff;stroke-width:3}
.rmap-map text{fill:#fff;font-size:15px;font-weight:700;text-anchor:middle;dominant-baseline:central;pointer-events:none}
.rmap-side{flex:1 1 280px;background:var(--dark3);border:1px solid var(--border2);border-radius:10px;padding:14px}
.rmap-side h3{margin:0 0 6px;font-size:18px}
.rmap-badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;padding:3px 8px;border-radius:5px;color:#fff;text-transform:uppercase}
.rmap-side p{font-size:12.5px;line-height:1.5;margin:10px 0}
.rmap-stats{font-size:12.5px;line-height:1.75}
.rmap-stats b{color:var(--text)}
.rmap-stats div{color:var(--text-muted)}
.rmap-mini{margin-top:10px}
.rmap-mini .t{font-size:11px;color:var(--text-muted);margin-bottom:2px}
.rmap-mini svg{width:100%;height:auto;display:block;background:var(--dark2);border-radius:6px}
.rmap-strip{cursor:pointer}
.rmap-tip{position:fixed;pointer-events:none;background:#0d0d18ee;border:1px solid var(--border2);border-radius:6px;padding:5px 8px;font-size:12px;z-index:50;display:none}
`;
    document.head.appendChild(st);
  }

  async function load() {
    if (D || loading) return;
    loading = true;
    root.innerHTML = '<p class="ipo-note">Loading state data…</p>';
    try {
      const r = await fetch('/api/markets/state-recession');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      prepare(await r.json());
    } catch (e) {
      root.innerHTML = `<p class="ipo-note">State recession data is unavailable right now (${esc(e.message)}).</p>`;
      loading = false; return;
    }
    loading = false;
    build();
  }

  function prepare(j) {
    const n = j.months.length, codes = Object.keys(j.states);
    const st = {};
    for (const s of codes) {
      const { ur, ci, name } = j.states[s];
      const a3 = ur.map((_, i) => { if (i < 2) return null; const v = [ur[i], ur[i - 1], ur[i - 2]].filter(x => x != null); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null; });
      const gap = a3.map((v, i) => {
        if (v == null || i < 14) return null;
        let lo = Infinity; for (let k = i - 12; k < i; k++) if (a3[k] != null && a3[k] < lo) lo = a3[k];
        return lo === Infinity ? null : v - lo;
      });
      const c3 = ci.map((v, i) => (i >= 3 && v != null && ci[i - 3] != null ? (v / ci[i - 3] - 1) * 100 : null));
      const status = gap.map((g, i) => {
        const c = c3[i];
        if (g == null || c == null) return 'X';
        if ((g >= 0.5 && c < 0) || c <= -1) return 'R';
        if (g >= 0.5 || c < 0 || (g >= 0.3 && c < 0.5)) return 'V';
        return 'N';
      });
      st[s] = { name, ur, ci, gap, c3, status };
    }
    const cnt = Array.from({ length: n }, (_, i) => {
      const c = { R: 0, V: 0, N: 0, X: 0 };
      for (const s of codes) c[st[s].status[i]]++;
      return c;
    });
    const usStatus = cnt.map((c, i) => {
      if (c.X > 10) return null;
      const sahm = j.us.sahm[i], rec = j.us.usrec[i];
      if (rec === 1 || (sahm != null && sahm >= 0.5 && c.R >= 15) || c.R >= 25) return 'R';
      if ((sahm != null && sahm >= 0.3) || c.R >= 8 || c.R + c.V >= 25) return 'V';
      return 'N';
    });
    let first = usStatus.findIndex(x => x), last = n - 1;
    while (last > 0 && !usStatus[last]) last--;
    D = { months: j.months, st, codes, cnt, us: j.us, usStatus, first, last };
    sel = last;
    if (!selState) selState = codes.find(s => st[s].status[last] === 'R') || codes.find(s => st[s].status[last] === 'V') || 'CA';
  }

  function build() {
    root.innerHTML = `
      <div class="rmap">
        <div class="rmap-us" id="rmap-us"></div>
        <div class="rmap-ctl">
          <button data-a="prev" title="Previous month (←)">◀</button>
          <div class="rmap-month" id="rmap-month"></div>
          <button data-a="next" title="Next month (→)">▶</button>
          <button data-a="play" id="rmap-play">▶ Play</button>
          <button data-a="latest">Latest</button>
          <div class="rmap-jumps">${JUMPS.map(([l, m]) => `<button data-j="${m}">${l}</button>`).join('')}</div>
        </div>
        <div class="rmap-stitle">Timeline — states in recession (red) and on the verge (orange), out of 50. Drag or click to go back in time.</div>
        <canvas class="rmap-scrub" id="rmap-scrub"></canvas>
        <div class="rmap-legend">
          <span><i style="background:${COL.N}"></i>Not in recession</span>
          <span><i style="background:${COL.V}"></i>On the verge</span>
          <span><i style="background:${COL.R}"></i>In recession</span>
          <span><i style="background:${COL.X}"></i>Data unavailable</span>
          <span><i style="background:rgba(255,255,255,.18)"></i>NBER US recession (timeline)</span>
        </div>
        <div class="rmap-body">
          <div class="rmap-map" id="rmap-map"></div>
          <div class="rmap-side" id="rmap-side"></div>
        </div>
      </div>
      <div class="rmap-tip" id="rmap-tip"></div>`;
    buildMap();
    root.querySelector('.rmap-ctl').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.j) { stop(); setMonth(D.months.indexOf(b.dataset.j)); return; }
      const a = b.dataset.a;
      if (a === 'prev') { stop(); setMonth(sel - 1); }
      if (a === 'next') { stop(); setMonth(sel + 1); }
      if (a === 'latest') { stop(); setMonth(D.last); }
      if (a === 'play') playT ? stop() : play();
    });
    const cv = document.getElementById('rmap-scrub');
    const at = e => { const r = cv.getBoundingClientRect(); return Math.round(D.first + (e.clientX - r.left) / r.width * (D.last - D.first)); };
    cv.addEventListener('pointerdown', e => { stop(); scrub = true; cv.setPointerCapture(e.pointerId); setMonth(at(e)); });
    cv.addEventListener('pointermove', e => { if (scrub) setMonth(at(e)); });
    cv.addEventListener('pointerup', () => { scrub = false; });
    root.tabIndex = 0;
    root.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') { stop(); setMonth(sel - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { stop(); setMonth(sel + 1); e.preventDefault(); }
    });
    window.addEventListener('resize', () => { if (root.offsetParent) drawScrub(); });
    update();
  }

  function buildMap() {
    const W = 70, H = W * 2 / Math.sqrt(3), R = H / 2, ROW = H * 0.75, P = 6;
    const pts = (cx, cy) => [0, 60, 120, 180, 240, 300].map(a => { const t = (a - 90) * Math.PI / 180; return `${(cx + R * 0.97 * Math.cos(t)).toFixed(1)},${(cy + R * 0.97 * Math.sin(t)).toFixed(1)}`; }).join(' ');
    const vbW = 12.5 * W + 2 * P, vbH = 8.6 * ROW + H + 2 * P;
    const g = GRID.map(([s, c, r]) => {
      const cx = P + W / 2 + c * W, cy = P + R + r * ROW;
      return `<g data-s="${s}"><polygon points="${pts(cx, cy)}"></polygon><text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}">${s}</text></g>`;
    }).join('');
    const map = document.getElementById('rmap-map');
    map.innerHTML = `<svg viewBox="0 0 ${vbW.toFixed(0)} ${vbH.toFixed(0)}" role="img" aria-label="US states hex map">${g}</svg>`;
    const tip = document.getElementById('rmap-tip');
    map.addEventListener('click', e => { const el = e.target.closest('g[data-s]'); if (el) { selState = el.dataset.s; update(); } });
    map.addEventListener('mousemove', e => {
      const el = e.target.closest('g[data-s]');
      if (!el) { tip.style.display = 'none'; return; }
      const s = D.st[el.dataset.s], k = s.status[sel];
      tip.innerHTML = `<b>${esc(s.name)}</b> · <span style="color:${COL[k]}">${LABEL[k]}</span>`;
      tip.style.display = 'block'; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px';
    });
    map.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }

  function setMonth(i) {
    sel = Math.max(D.first, Math.min(D.last, i));
    update();
  }
  function play() {
    if (sel >= D.last) sel = D.first;
    document.getElementById('rmap-play').textContent = '⏸ Pause';
    document.getElementById('rmap-play').classList.add('on');
    playT = setInterval(() => { if (sel >= D.last) return stop(); setMonth(sel + 1); }, 120);
  }
  function stop() {
    if (!playT) return;
    clearInterval(playT); playT = null;
    const b = document.getElementById('rmap-play'); if (b) { b.textContent = '▶ Play'; b.classList.remove('on'); }
  }

  function update() {
    const m = D.months[sel], c = D.cnt[sel], us = D.usStatus[sel] || 'N';
    document.getElementById('rmap-month').textContent = fmtM(m);
    // national banner
    const sahm = D.us.sahm[sel], rec = D.us.usrec[sel];
    const why = [];
    if (rec === 1) why.push('NBER-dated US recession');
    if (sahm != null) why.push(`national Sahm rule ${sahm.toFixed(2)}${sahm >= 0.5 ? ' (triggered)' : ''}`);
    why.push(`${c.R} state${c.R === 1 ? '' : 's'} in recession, ${c.V} on the verge`);
    const ub = document.getElementById('rmap-us');
    ub.style.background = COL[us] + '22'; ub.style.borderColor = COL[us] + '88';
    ub.innerHTML = `<b style="color:${us === 'N' ? '#7fb2ee' : COL[us]}">🇺🇸 ${US_LABEL[us]}</b><span>${fmtM(m)} · ${why.join(' · ')}</span>`;
    // map colours
    document.querySelectorAll('#rmap-map g[data-s]').forEach(g => {
      const s = g.dataset.s;
      g.querySelector('polygon').style.fill = COL[D.st[s].status[sel]];
      g.classList.toggle('sel', s === selState);
    });
    drawScrub();
    side();
  }

  function drawScrub() {
    const cv = document.getElementById('rmap-scrub'); if (!cv) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = D.last - D.first, top = 6, bot = h - 16, x = i => (i - D.first) / n * w, y = v => bot - v / 50 * (bot - top);
    ctx.clearRect(0, 0, w, h);
    // NBER recession shading
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    for (let i = D.first; i <= D.last; i++) if (D.us.usrec[i] === 1) ctx.fillRect(x(i), top, Math.max(1, w / n), bot - top);
    // stacked: states in recession (red) + on the verge (orange)
    const area = (f, col) => {
      ctx.beginPath(); ctx.moveTo(x(D.first), bot);
      for (let i = D.first; i <= D.last; i++) ctx.lineTo(x(i), y(f(D.cnt[i])));
      ctx.lineTo(x(D.last), bot); ctx.closePath(); ctx.fillStyle = col; ctx.fill();
    };
    area(c => c.R + c.V, 'rgba(240,160,48,0.55)');
    area(c => c.R, 'rgba(217,69,43,0.9)');
    // year ticks
    ctx.fillStyle = '#7777aa'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    for (let i = D.first; i <= D.last; i++) {
      const m = D.months[i];
      if (m.endsWith('-01') && +m.slice(0, 4) % 5 === 0) {
        ctx.fillText(m.slice(0, 4), x(i), h - 3);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(x(i), top, 1, bot - top); ctx.fillStyle = '#7777aa';
      }
    }
    // cursor
    ctx.fillStyle = '#c9a84c'; ctx.fillRect(x(sel) - 1, 0, 2, bot + 2);
  }

  function side() {
    const s = D.st[selState], i = sel, k = s.status[i], m = D.months[i];
    const g = s.gap[i], c = s.c3[i], ur = s.ur[i], nur = D.us.ur[i];
    let run = 0; for (let j = i; j >= 0 && s.status[j] === k; j--) run++;
    let text;
    if (k === 'X') text = `${esc(s.name)} has no complete data for ${fmtM(m)}.`;
    else {
      const parts = [`unemployment is ${g >= 0 ? 'up ' + g.toFixed(2) : 'down ' + (-g).toFixed(2)} pts from its 12-month low`,
                     `the coincident index ${c < 0 ? 'fell' : 'grew'} ${Math.abs(c).toFixed(2)}% over 3 months`];
      text = `${esc(s.name)} is ${LABEL[k].toLowerCase()}: ${parts.join(' and ')}.`;
    }
    const fired = (b) => b ? ' — <span style="color:' + COL.R + '">fired</span>' : '';
    document.getElementById('rmap-side').innerHTML = `
      <h3>${esc(s.name)}</h3>
      <span class="rmap-badge" style="background:${COL[k]}">${LABEL[k]}</span>
      <p>${text}</p>
      <div class="rmap-stats">
        <div>Month: <b>${fmtM(m)}</b></div>
        <div>Unemployment rate: <b>${ur == null ? '—' : ur.toFixed(1) + '%'}</b> (national: ${nur == null ? '—' : nur.toFixed(1) + '%'})</div>
        <div>Sahm gap: <b>${g == null ? '—' : g.toFixed(2) + ' pts'}</b>${fired(g != null && g >= 0.5)}</div>
        <div>Coincident index, 3-mo: <b>${c == null ? '—' : sgn(c, 2) + '%'}</b>${fired(c != null && c < 0)}</div>
        <div>Months ${k === 'X' ? 'without data' : LABEL[k].toLowerCase()}: <b>${run}</b></div>
      </div>
      ${mini('Unemployment rate (%) — state vs national (dashed), 3 years', s.ur, D.us.ur, '#5b9bea', 1)}
      ${mini('Coincident index, 3 years', s.ci, null, '#f0a030', 1)}
      <div class="rmap-mini"><div class="t">Status history since ${D.months[D.first].slice(0, 4)} — click to jump</div>${strip(s)}</div>`;
    const sv = document.querySelector('#rmap-side .rmap-strip');
    sv.addEventListener('click', e => {
      const r = sv.getBoundingClientRect();
      stop(); setMonth(Math.round(D.first + (e.clientX - r.left) / r.width * (D.last - D.first)));
    });
  }

  function mini(title, a, b, color) {
    const W = 280, H = 96, L = 30, Rr = 6, T = 8, B = 16;
    const e = sel, s0 = Math.max(0, e - 35);
    const vals = [];
    for (let i = s0; i <= e; i++) { if (a[i] != null) vals.push(a[i]); if (b && b[i] != null) vals.push(b[i]); }
    if (vals.length < 2) return '';
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.1 || 0.5; lo -= pad; hi += pad;
    const x = i => L + (i - s0) / (e - s0) * (W - L - Rr), y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const path = arr => { let d = '', pen = false; for (let i = s0; i <= e; i++) { if (arr[i] == null) { pen = false; continue; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(arr[i]).toFixed(1); pen = true; } return d; };
    const fmt = v => (hi - lo > 20 ? v.toFixed(0) : v.toFixed(1));
    let ticks = '';
    for (let i = s0; i <= e; i++) if (D.months[i].endsWith('-01')) ticks += `<text x="${x(i).toFixed(1)}" y="${H - 4}" fill="#7777aa" font-size="9" text-anchor="middle">${D.months[i].slice(0, 4)}</text><line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${T}" y2="${H - B}" stroke="rgba(255,255,255,.06)"/>`;
    const last = a[e] != null ? `<circle cx="${x(e).toFixed(1)}" cy="${y(a[e]).toFixed(1)}" r="3.5" fill="${color}" stroke="#fff" stroke-width="1"/>` : '';
    return `<div class="rmap-mini"><div class="t">${title}</div><svg viewBox="0 0 ${W} ${H}">
      ${ticks}
      <text x="${L - 4}" y="${T + 4}" fill="#7777aa" font-size="9" text-anchor="end">${fmt(hi)}</text>
      <text x="${L - 4}" y="${H - B}" fill="#7777aa" font-size="9" text-anchor="end">${fmt(lo)}</text>
      ${b ? `<path d="${path(b)}" fill="none" stroke="#9aa0b8" stroke-width="1.2" stroke-dasharray="3 3"/>` : ''}
      <path d="${path(a)}" fill="none" stroke="${color}" stroke-width="1.8"/>${last}</svg></div>`;
  }

  function strip(s) {
    const W = 280, H = 22, n = D.last - D.first + 1, bw = W / n;
    let r = '', i = D.first;
    while (i <= D.last) { // merge runs of the same status into one rect
      let j = i; while (j + 1 <= D.last && s.status[j + 1] === s.status[i]) j++;
      r += `<rect x="${((i - D.first) * bw).toFixed(2)}" y="2" width="${((j - i + 1) * bw + 0.3).toFixed(2)}" height="${H - 4}" fill="${COL[s.status[i]]}"/>`;
      i = j + 1;
    }
    const cx = ((sel - D.first + 0.5) * bw).toFixed(1);
    return `<svg class="rmap-strip" viewBox="0 0 ${W} ${H}">${r}<rect x="${cx - 1}" y="0" width="2" height="${H}" fill="#fff"/></svg>`;
  }

  function draw() {
    root = document.getElementById('recession-root');
    if (!root) return;
    css();
    if (!D) return load();
    if (!root.querySelector('.rmap')) build(); else drawScrub();
  }

  window.LegionRecession = { draw };
})();
