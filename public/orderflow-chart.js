// IVth Legion — BTCUSDT perpetual order-flow chart.
// Footprint (bid × ask per price), delta, CVD, open interest, footprint bar statistics,
// and flow signals: CVD divergences, OI regimes, absorption, delta divergence, stacked imbalances.
window.LegionOrderflow = (function () {
  'use strict';

  const FAPI = 'https://fapi.binance.com';
  const WS_URL = 'wss://fstream.binance.com/market/stream?streams=' +
    ['btcusdt@aggTrade', 'btcusdt@kline_1m', 'btcusdt@kline_5m', 'btcusdt@kline_15m', 'btcusdt@kline_1h', 'btcusdt@kline_4h', 'btcusdt@kline_1d'].join('/');
  const TFS = [
    { label: '1m',  api: '1m',  ms: 60e3,   limit: 300, oi: '5m',  bars: 40 },
    { label: '5m',  api: '5m',  ms: 300e3,  limit: 288, oi: '5m',  bars: 36 },
    { label: '15m', api: '15m', ms: 900e3,  limit: 300, oi: '15m', bars: 36 },
    { label: '1H',  api: '1h',  ms: 3600e3, limit: 300, oi: '1h',  bars: 36 },
  ];
  // Potential divergences are also tracked on 4H and 1D, which aren't chart timeframes.
  const PDIV_TFS = [...TFS, { label: '4H', api: '4h', ms: 4 * 3600e3 }, { label: '1D', api: '1d', ms: 864e5 }];
  const BASE_BIN = 5;
  const BINS = [5, 10, 20, 25, 40, 50, 100, 200, 250, 500, 1000];
  const IMB_RATIO = 3;
  const TIME_STEPS = [1, 5, 15, 30, 60, 120, 240, 360, 720, 1440, 2880, 10080].map(m => m * 60000);
  const C = {
    bg: '#10141f', axis: '#141926', grid: 'rgba(60,68,90,0.28)', border: '#232a3a',
    text: '#7d8497', textHi: '#c9cedb', white: '#eef0f5',
    bull: '#1fb886', bear: '#ef4f5a', price: '#2d8cf0',
    poc: '#8b5cf6', va: '#f5a623', imb: '#0a0d14',
    abs: '#f5b041', warn: '#f5a623', liq: '#b07cff',
  };
  const SIDE_COLOR = { bull: C.bull, bear: C.bear, warn: C.warn, liq: C.liq };

  let root, canvas, ctx, feedEl, statusEl, clockEl, dotEl;
  let dpr = 1, W = 0, H = 0;
  let tfIdx = 1;
  let bars = [];
  let oiHist = [];
  const fpMin = new Map();           // minuteStart -> Map(priceBin -> [bidQty, askQty])
  let fpGen = 0;
  let fpStart = Infinity;            // earliest recorded minute (status display)
  const partialMin = new Set();      // minutes without end-to-end trade coverage
  let lastAggId = 0;
  let lastTradeT = 0;
  let recent = [];                   // last few minutes of raw trades, for merging server history
  let ws = null, wsRetry = 0;
  let loadSeq = 0;
  let lastPrice = 0, liveOiUsd = null;
  const toggles = { fp: true, oi: true, cvd: false, poc: true, va: true, imb: true, sig: true, pdiv: true, fpbs: true };
  const opt = { tick: 0, cluster: 'delta', text: 'volume', candle: 'ohlc' };
  const defaultBars = () => 30;
  const view = { bars: 36, offset: 0 };
  let mouse = null, drag = null, axisDrag = null, flash = null;
  let yScale = null;                 // null = auto-fit price; otherwise { center, span } set by the user
  let rafPending = false, liveTimer = null;
  let signals = [];
  const geo = {};

  // ── Data ─────────────────────────────────────────────────────────
  async function getJSON(u) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(u + ' → ' + r.status);
    return r.json();
  }

  function mkBar(t, o, h, l, c, v, qv, tbq) {
    return { t, o, h, l, c, v, qv, delta: 2 * tbq - qv, oiO: null, oiC: null, cvdO: 0, cvdC: 0, _fp: null };
  }

  async function load() {
    const seq = ++loadSeq;
    const tf = TFS[tfIdx];
    bars = []; signals = []; renderFeed(); requestRender();
    try {
      const [kl, oi] = await Promise.all([
        getJSON(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=${tf.api}&limit=${tf.limit}`),
        getJSON(`${FAPI}/futures/data/openInterestHist?symbol=BTCUSDT&period=${tf.oi}&limit=500`).catch(() => []),
      ]);
      if (seq !== loadSeq) return;
      bars = kl.map(k => mkBar(+k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[7], +k[10]));
      oiHist = oi.map(r => [+r.timestamp, +r.sumOpenInterestValue]).sort((a, b) => a[0] - b[0]);
      applyOI();
      recomputeCVD(0);
      lastPrice = bars.length ? bars[bars.length - 1].c : 0;
      view.bars = defaultBars(); view.offset = 0; yScale = null;
      computeSignals();
      pollOI();
      requestRender();
    } catch (e) {
      console.error('[orderflow] load failed', e);
      setStatus('Data unavailable — retrying…', false);
      setTimeout(() => { if (seq === loadSeq) load(); }, 5000);
      return;
    }
    try {
      const snap = await getJSON('/api/orderflow/footprint?since=' + bars[0].t);
      if (seq === loadSeq) mergeServer(snap);
    } catch { /* no server history (static preview) — footprint builds live */ }
    updateStatus();
    requestRender();
  }

  // The server backfills missed minutes in the background; re-pull history for any candle still incomplete.
  function firstIncompleteBar() {
    const ms = TFS[tfIdx].ms, cutoff = Date.now() - 47 * 3600e3, recentMin = Date.now() - (Date.now() % 60000) - 60000;
    let first = null;
    for (let i = bars.length - 1; i >= 0 && bars[i].t >= cutoff; i--) {
      for (let m = bars[i].t; m < bars[i].t + ms && m < recentMin; m += 60000) {
        if (!fpMin.has(m) || partialMin.has(m)) { first = bars[i].t; break; }
      }
    }
    return first;
  }

  // The server recorded the trades our socket missed; pull those minutes back once it has them.
  let repairTimer = null, repairFrom = Infinity;
  function repairSoon(fromMinute) {
    repairFrom = Math.min(repairFrom, fromMinute);
    if (repairTimer) return;
    repairTimer = setTimeout(async () => {
      const since = repairFrom;
      repairTimer = null; repairFrom = Infinity;
      const seq = loadSeq;
      try {
        const snap = await getJSON('/api/orderflow/footprint?since=' + since);
        if (seq === loadSeq) { mergeServer(snap); requestRender(); }
      } catch { /* server unavailable — minute stays marked incomplete */ }
    }, 3000);
  }

  async function refreshGaps() {
    const since = bars.length ? firstIncompleteBar() : null;
    if (since == null) return;
    const seq = loadSeq;
    try {
      const snap = await getJSON('/api/orderflow/footprint?since=' + since);
      if (seq === loadSeq) { mergeServer(snap); requestRender(); }
    } catch { /* server unavailable */ }
  }

  function oiAt(t) {
    let lo = 0, hi = oiHist.length - 1, ans = null;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (oiHist[m][0] <= t) { ans = oiHist[m][1]; lo = m + 1; } else hi = m - 1;
    }
    return ans;
  }

  function applyOI() {
    const ms = TFS[tfIdx].ms;
    for (const b of bars) { b.oiO = oiAt(b.t); b.oiC = oiAt(b.t + ms); }
    const last = bars[bars.length - 1];
    if (last && liveOiUsd != null) last.oiC = liveOiUsd;
  }

  function recomputeCVD(from) {
    let cum = from > 0 ? bars[from - 1].cvdC : 0;
    for (let i = from; i < bars.length; i++) {
      bars[i].cvdO = cum;
      cum += bars[i].delta;
      bars[i].cvdC = cum;
    }
  }

  function addTrade(tr) {
    const t = tr.t - (tr.t % 60000);
    let lv = fpMin.get(t);
    if (!lv) fpMin.set(t, (lv = new Map()));
    const bin = Math.floor(tr.p / BASE_BIN) * BASE_BIN;
    let c = lv.get(bin);
    if (!c) lv.set(bin, (c = [0, 0]));
    c[tr.m ? 0 : 1] += tr.q;
  }

  function mergeServer(snap) {
    if (!snap || !snap.minutes || !snap.minutes.length) return;
    const mins = snap.minutes;
    const first = mins[0][0], lastMin = mins[mins.length - 1][0];
    for (const t of [...fpMin.keys()]) if (t >= first && t <= lastMin) fpMin.delete(t);
    for (const [t, rows] of mins) fpMin.set(t, new Map(rows.map(r => [r[0], [r[1], r[2]]])));
    for (const t of [...partialMin]) if (t >= first && t <= lastMin) partialMin.delete(t);
    for (const t of snap.partial || []) partialMin.add(t);
    // Trades our socket saw after the server's snapshot cut-off were wiped above; replay them.
    for (const tr of recent) if (tr.a > snap.lastId && tr.t < lastMin + 60000) addTrade(tr);
    lastAggId = Math.max(lastAggId, snap.lastId);
    fpStart = Math.min(fpStart, (snap.start || first) + 60000);
    fpGen++;
  }

  // ── Live stream ──────────────────────────────────────────────────
  function connectWS() {
    if (ws) return;
    const sock = new WebSocket(WS_URL);
    ws = sock;
    sock.onopen = () => {
      wsRetry = 0;
      if (fpStart === Infinity) fpStart = Math.ceil(Date.now() / 60000) * 60000;
      updateStatus();
    };
    sock.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      const d = m && m.data;
      if (!d) return;
      if (d.e === 'aggTrade') onTrade(d);
      else if (d.e === 'kline') onKline(d.k);
    };
    sock.onclose = () => {
      partialMin.add(Date.now() - (Date.now() % 60000));
      if (ws === sock) ws = null;
      updateStatus();
      setTimeout(connectWS, Math.min(20000, 1000 * 2 ** wsRetry++));
    };
    sock.onerror = () => { try { sock.close(); } catch { /* closed */ } };
  }

  function onTrade(d) {
    if (d.a <= lastAggId) return;
    // aggTrade ids are consecutive: a jump means trades were missed, so those minutes are incomplete.
    // The very first trade (before server history merges) starts mid-minute; a later merge clears it if covered.
    if (!lastAggId || d.a > lastAggId + 1) {
      const from = lastTradeT || d.T;
      for (let m = from - (from % 60000); m <= d.T; m += 60000) partialMin.add(m);
      repairSoon(from - (from % 60000));
    }
    lastAggId = d.a;
    lastTradeT = d.T;
    const tr = { a: d.a, t: d.T, p: +d.p, q: +d.q, m: d.m };
    addTrade(tr);
    recent.push(tr);
    if (recent.length % 500 === 0) {
      const cut = tr.t - 180000;
      let i = 0;
      while (i < recent.length && recent[i].t < cut) i++;
      if (i) recent = recent.slice(i);
    }
    lastPrice = tr.p;
    liveTick();
  }

  // ── Potential (forming) CVD divergences on every timeframe ──
  // A swing isn't confirmed until 3 candles close after it. Before that, if the newest extreme has already
  // beaten the last confirmed swing while CVD hasn't, flag it as a potential divergence ("DIV?").
  const mtf = PDIV_TFS.map(tf => ({ tf, bars: [] }));
  async function loadMTF() {
    await Promise.all(mtf.map(async m => {
      try {
        const kl = await getJSON(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=${m.tf.api}&limit=150`);
        let cum = 0;
        m.bars = kl.map(k => { const delta = 2 * +k[10] - +k[7]; cum += delta; return { t: +k[0], h: +k[2], l: +k[3], delta, cvd: cum }; });
      } catch { /* keep previous bars */ }
    }));
    requestRender();
  }
  function mtfKline(k) {
    const m = mtf.find(x => x.tf.api === k.i);
    if (!m || !m.bars.length) return;
    const last = m.bars[m.bars.length - 1], delta = 2 * +k.Q - +k.q;
    if (k.t === last.t) { last.h = +k.h; last.l = +k.l; last.cvd += delta - last.delta; last.delta = delta; }
    else if (k.t > last.t) { m.bars.push({ t: k.t, h: +k.h, l: +k.l, delta, cvd: last.cvd + delta }); if (m.bars.length > 200) m.bars.shift(); }
  }
  // Only the current timeframe and higher ones: a lower-timeframe divergence is noise on a bigger chart.
  function potentialDivs() {
    const out = [], k = 3;
    for (const m of mtf.slice(tfIdx)) {
      const B = m.bars, n = B.length;
      if (n < 20) continue;
      const confirmEnd = n - 2 - k;
      for (const side of ['bear', 'bull']) {
        const val = b => (side === 'bear' ? b.h : b.l);
        const beyond = (a, b) => (side === 'bear' ? a > b : a < b);
        let A = -1;
        for (let i = confirmEnd; i >= Math.max(k, n - 45) && A < 0; i--) {
          let piv = true;
          for (let j = i - k; j <= i + k && piv; j++) if (j !== i && !beyond(val(B[i]), val(B[j]))) piv = false;
          if (piv) A = i;
        }
        if (A < 0) continue;
        let Cx = A + 1;
        for (let i = A + 2; i < n; i++) if (beyond(val(B[i]), val(B[Cx]))) Cx = i;
        if (Cx <= confirmEnd || !beyond(val(B[Cx]), val(B[A]))) continue;
        const cvdDisagrees = side === 'bear' ? B[Cx].cvd < B[A].cvd : B[Cx].cvd > B[A].cvd;
        if (cvdDisagrees) out.push({ tf: m.tf.label, side, aT: B[A].t, aP: val(B[A]), bT: B[Cx].t, bP: val(B[Cx]) });
      }
    }
    return out;
  }
  // Chart candle where a (possibly higher-timeframe) candle's high/low actually printed.
  function extremeIndex(t0, ms, side) {
    let best = null;
    for (let i = Math.max(0, indexAt(t0) ?? 0); i < bars.length && bars[i].t < t0 + ms; i++) {
      if (bars[i].t + TFS[tfIdx].ms <= t0) continue;
      if (best == null || (side === 'bear' ? bars[i].h > bars[best].h : bars[i].l < bars[best].l)) best = i;
    }
    return best;
  }

  function indexAt(t) {
    if (!bars.length || t < bars[0].t) return null;
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m].t <= t) lo = m; else hi = m - 1; }
    return lo;
  }

  function onKline(k) {
    mtfKline(k);
    if (k.i !== TFS[tfIdx].api || !bars.length) return;
    const last = bars[bars.length - 1];
    if (k.t === last.t) {
      last.o = +k.o; last.h = +k.h; last.l = +k.l; last.c = +k.c;
      last.v = +k.v; last.qv = +k.q; last.delta = 2 * +k.Q - +k.q;
    } else if (k.t > last.t) {
      const b = mkBar(k.t, +k.o, +k.h, +k.l, +k.c, +k.v, +k.q, +k.Q);
      b.oiO = last.oiC;
      b.oiC = liveOiUsd != null ? liveOiUsd : last.oiC;
      bars.push(b);
      if (view.offset > 0) view.offset++;
      recomputeCVD(bars.length - 2);
      computeSignals();
    } else return;
    recomputeCVD(Math.max(0, bars.length - 2));
    lastPrice = +k.c;
    liveTick();
  }

  async function pollOI() {
    try {
      const r = await getJSON(FAPI + '/fapi/v1/openInterest?symbol=BTCUSDT');
      if (!lastPrice) return;
      liveOiUsd = +r.openInterest * lastPrice;
      const last = bars[bars.length - 1];
      if (last) {
        last.oiC = liveOiUsd;
        if (last.oiO == null) last.oiO = liveOiUsd;
      }
      requestRender();
    } catch { /* transient */ }
  }

  function liveTick() {
    if (liveTimer) return;
    liveTimer = setTimeout(() => { liveTimer = null; requestRender(); }, 250);
  }

  // ── Footprint ────────────────────────────────────────────────────
  function footprint(i, bin) {
    const b = bars[i];
    const ms = TFS[tfIdx].ms;
    const live = i >= bars.length - 2;
    if (!live && b._fp && b._fp.bin === bin && b._fp.gen === fpGen) return b._fp.data;
    const lv = new Map();
    const end = Math.min(b.t + ms, Date.now());
    const nowMin = Date.now() - (Date.now() % 60000);
    let complete = true;
    for (let m = b.t; m < end; m += 60000) {
      const mm = fpMin.get(m);
      if ((!mm && m < nowMin) || partialMin.has(m)) { complete = false; break; }
      if (!mm) continue;
      for (const [p, c] of mm) {
        const k = Math.floor(p / bin) * bin;
        const e = lv.get(k);
        if (e) { e[0] += c[0]; e[1] += c[1]; } else lv.set(k, [c[0], c[1]]);
      }
    }
    const data = complete && lv.size ? buildRows(lv, bin) : null;
    b._fp = { bin, gen: fpGen, data };
    return data;
  }

  function buildRows(lv, bin) {
    let lo = Infinity, hi = -Infinity;
    for (const k of lv.keys()) { if (k < lo) lo = k; if (k > hi) hi = k; }
    const rows = [];
    let total = 0, maxTot = 0, poc = 0;
    for (let p = lo; p <= hi; p += bin) {
      const e = lv.get(p) || [0, 0];
      const r = { p, bid: e[0], ask: e[1], tot: e[0] + e[1], buyImb: false, sellImb: false };
      rows.push(r);
      total += r.tot;
      if (r.tot > maxTot) { maxTot = r.tot; poc = rows.length - 1; }
    }
    let vaLo = poc, vaHi = poc, acc = rows[poc].tot;
    while (acc < total * 0.7 && (vaLo > 0 || vaHi < rows.length - 1)) {
      const dn = vaLo > 0 ? rows[vaLo - 1].tot : -1;
      const up = vaHi < rows.length - 1 ? rows[vaHi + 1].tot : -1;
      if (up >= dn) acc += rows[++vaHi].tot; else acc += rows[--vaLo].tot;
    }
    // Diagonal imbalances: ask at P vs bid one level below; bid at P vs ask one level above.
    const minQ = (total / rows.length) * 0.25;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (r > 0 && row.ask >= minQ) row.buyImb = row.ask >= IMB_RATIO * Math.max(rows[r - 1].bid, minQ * 0.2);
      if (r < rows.length - 1 && row.bid >= minQ) row.sellImb = row.bid >= IMB_RATIO * Math.max(rows[r + 1].ask, minQ * 0.2);
    }
    const zones = [];
    for (const side of ['buy', 'sell']) {
      let s = -1;
      for (let r = 0; r <= rows.length; r++) {
        const on = r < rows.length && rows[r][side + 'Imb'];
        if (on && s < 0) s = r;
        if (!on && s >= 0) {
          if (r - s >= 3) zones.push({ side, lo: rows[s].p, hi: rows[r - 1].p + bin });
          s = -1;
        }
      }
    }
    return { bin, rows, poc, vah: rows[vaHi].p + bin, val: rows[vaLo].p, maxTot, total, zones };
  }

  // ── Signals ──────────────────────────────────────────────────────
  function computeSignals() {
    signals = [];
    const n = bars.length - 1; // closed bars only
    if (n < 30) { renderFeed(); return; }
    const add = (i, kind, side, tag, title, text, from) =>
      signals.push({ i, t: bars[i].t, kind, side, tag, title, text, from });

    const deltas = bars.slice(0, n).map(b => b.delta);
    const dMean = mean(deltas), dSd = stdev(deltas, dMean);
    // OI regime units: one per candle on 5m+, but OI history is 5-minute data, so on 1m each
    // 5-minute block is judged as a unit and tagged on its last candle.
    const oiUnits = [];
    if (TFS[tfIdx].ms >= 300e3) {
      for (let i = 0; i < n; i++) {
        if (bars[i].oiO != null && bars[i].oiC != null) oiUnits.push({ i, body: bars[i].c - bars[i].o, d: bars[i].oiC - bars[i].oiO });
      }
    } else {
      let s0 = 0;
      for (let i = 1; i <= n; i++) {
        if (i < n && Math.floor(bars[i].t / 300e3) === Math.floor(bars[s0].t / 300e3)) continue;
        const e = i - 1;
        if (e - s0 >= 4 && bars[s0].oiO != null && bars[e].oiC != null) oiUnits.push({ i: e, body: bars[e].c - bars[s0].o, d: bars[e].oiC - bars[s0].oiO });
        s0 = i;
      }
    }
    const oiSd = stdev(oiUnits.map(u => u.d), mean(oiUnits.map(u => u.d)));
    if (oiSd > 0) {
      for (const u of oiUnits) {
        if (u.i < 14) continue;
        const z = u.d / oiSd;
        if (z > 1.8 && u.body > 0) add(u.i, 'oi', 'bull', 'L+', 'New longs', 'Price up with open interest surging — fresh long positions are driving the move.');
        else if (z > 1.8 && u.body < 0) add(u.i, 'oi', 'bear', 'S+', 'New shorts', 'Price down with open interest surging — aggressive new shorts are pressing.');
        else if (z < -1.8 && u.body > 0) add(u.i, 'oi', 'warn', 'SC', 'Short covering', 'Price up while open interest drops — the rally is shorts exiting, not new demand. Exhaustion risk.');
        else if (z < -1.8 && u.body < 0) add(u.i, 'oi', 'liq', 'LQ', 'Long liquidation', 'Price down while open interest drops — longs are being flushed, often near capitulation.');
      }
    }
    const atr = [];
    for (let i = 0, a = 0; i < n; i++) {
      const tr = bars[i].h - bars[i].l;
      a = i === 0 ? tr : (a * 13 + tr) / 14;
      atr.push(a);
    }

    for (let i = 14; i < n; i++) {
      const b = bars[i], body = b.c - b.o;
      const dz = dSd ? (b.delta - dMean) / dSd : 0;
      if (Math.abs(dz) > 2 && Math.abs(body) < 0.3 * atr[i]) {
        add(i, 'abs', dz > 0 ? 'bear' : 'bull', 'ABS', dz > 0 ? 'Buy absorption' : 'Sell absorption',
          dz > 0 ? 'Heavy market buying failed to lift price — passive sellers are absorbing. Bearish tell.'
                 : 'Heavy market selling failed to push price lower — passive buyers are absorbing. Bullish tell.');
      } else if (body > 0.4 * atr[i] && dz < -1) {
        add(i, 'dd', 'bear', 'Δ−', 'Delta divergence', 'Green candle closed on net market selling — the rally lacks aggressive buyers.');
      } else if (body < -0.4 * atr[i] && dz > 1) {
        add(i, 'dd', 'bull', 'Δ+', 'Delta divergence', 'Red candle closed on net market buying — sellers are running into demand.');
      }
    }

    const k = 3, hiP = [], loP = [];
    for (let i = k; i < n - k; i++) {
      let isH = true, isL = true;
      for (let j = i - k; j <= i + k && (isH || isL); j++) {
        if (j === i) continue;
        if (bars[j].h >= bars[i].h) isH = false;
        if (bars[j].l <= bars[i].l) isL = false;
      }
      if (isH) hiP.push(i);
      if (isL) loP.push(i);
    }
    for (let p = 1; p < hiP.length; p++) {
      const a = hiP[p - 1], b = hiP[p];
      if (b - a <= 40 && bars[b].h > bars[a].h && bars[b].cvdC < bars[a].cvdC)
        add(b, 'div', 'bear', 'DIV', 'Bearish CVD divergence', 'Higher high in price, lower high in CVD — buyers are exhausting; the push is not backed by aggressive flow.', a);
    }
    for (let p = 1; p < loP.length; p++) {
      const a = loP[p - 1], b = loP[p];
      if (b - a <= 40 && bars[b].l < bars[a].l && bars[b].cvdC > bars[a].cvdC)
        add(b, 'div', 'bull', 'DIV', 'Bullish CVD divergence', 'Lower low in price, higher low in CVD — sellers are exhausting; the flush is not backed by aggressive flow.', a);
    }
    signals.sort((x, y) => x.i - y.i);
    renderFeed();
  }

  function renderFeed() {
    if (!feedEl) return;
    const items = signals.slice(-16).reverse();
    feedEl.innerHTML = items.length
      ? items.map(s =>
          `<button class="of-sig of-sig-${s.side}" data-t="${s.t}">` +
          `<span class="of-sig-tag">${s.tag}</span>` +
          `<span class="of-sig-body"><span class="of-sig-title">${s.title}<em>${fmtDateTime(s.t)}</em></span>` +
          `<span class="of-sig-text">${s.text}</span></span></button>`).join('')
      : `<div class="of-feed-empty">${bars.length ? 'No signals in the loaded range yet.' : 'Loading…'}</div>`;
    feedEl.querySelectorAll('.of-sig').forEach(el => { el.onclick = () => focusTime(+el.dataset.t); });
  }

  function focusTime(t) {
    const i = bars.findIndex(b => b.t === t);
    if (i < 0) return;
    view.offset = Math.max(0, clampOffset(bars.length - 1 - i - Math.floor(view.bars / 2)));
    flash = { t, until: Date.now() + 1800 };
    setTimeout(requestRender, 1850);
    requestRender();
    canvas.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── Geometry ─────────────────────────────────────────────────────
  function layoutPanes() {
    const g = geo;
    g.axisW = 84; g.plotW = W - g.axisW; g.timeH = 24;
    g.tableHead = 20;
    g.tableH = toggles.fpbs ? 64 + g.tableHead : 0;
    g.oiH = toggles.oi ? Math.round(H * 0.17) : 0;
    g.cvdH = toggles.cvd ? Math.round(H * 0.13) : 0;
    g.mainH = H - g.timeH - g.tableH - g.oiH - g.cvdH;
    g.oiTop = g.mainH; g.cvdTop = g.oiTop + g.oiH; g.tableTop = g.cvdTop + g.cvdH; g.timeTop = g.tableTop + g.tableH;
  }
  // vEnd is the slot at the right edge; it can sit past the last candle (empty space on the right)
  // or the window can sit before the first candle (empty space on the left). Keep 3 candles in view.
  const X = i => (i - (geo.vEnd - geo.N + 1) + 0.5) * geo.barW;
  const clampOffset = o => Math.max(-(Math.max(8, Math.min(view.bars, bars.length)) - 3), Math.min(bars.length - 3, o));
  const barTime = i => (i < bars.length ? bars[i].t : bars[bars.length - 1].t + (i - bars.length + 1) * TFS[tfIdx].ms);
  const PY = p => geo.mainH * (1 - (p - geo.pMin) / (geo.pMax - geo.pMin));
  const YP = y => geo.pMin + (1 - y / geo.mainH) * (geo.pMax - geo.pMin);

  function pickBin() {
    if (opt.tick) return opt.tick;
    const pxPer = geo.mainH / (geo.pMax - geo.pMin);
    const minPx = ['volume', 'big'].includes(opt.text) ? 11 : ['bidask', 'delta'].includes(opt.text) ? 14 : 7;
    return BINS.find(b => b * pxPer >= minPx) || BINS[BINS.length - 1];
  }

  // ── Render ───────────────────────────────────────────────────────
  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  // Size the chart to whatever is left of the viewport below it, so it never needs scrolling to read.
  function fitHeight() {
    const wrap = canvas.parentElement;
    if (!root.offsetParent) return;
    const panel = root.closest('.of-panel') || root;
    let h;
    if (document.fullscreenElement === panel) {
      h = window.innerHeight - root.querySelector('.of-toolbar').offsetHeight;
    } else {
      const sc = document.getElementById('main');
      const contentTop = sc ? sc.getBoundingClientRect().top - sc.scrollTop : -window.scrollY;
      h = Math.max(480, window.innerHeight - (wrap.getBoundingClientRect().top - contentTop) - 16);
    }
    h = Math.round(h);
    if (Math.abs(wrap.offsetHeight - h) > 1) wrap.style.height = h + 'px';
  }

  function toggleFullscreen() {
    const panel = root.closest('.of-panel') || root;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (panel.requestFullscreen) panel.requestFullscreen();
  }

  function render() {
    if (!canvas) return;
    fitHeight();
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return;
    if (W !== rect.width || H !== rect.height) {
      W = rect.width; H = rect.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    if (!bars.length) {
      ctx.fillStyle = C.text; ctx.font = '12px Inter, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Loading order flow…', W / 2, H / 2);
      return;
    }
    layoutPanes();
    const g = geo;
    g.N = Math.max(8, Math.min(view.bars, bars.length));
    view.offset = clampOffset(view.offset);
    g.vEnd = bars.length - 1 - view.offset;
    g.endIdx = Math.min(bars.length - 1, g.vEnd);
    g.startIdx = Math.max(0, g.vEnd - g.N + 1);
    g.barW = g.plotW / (g.N + 3);
    let lo = Infinity, hi = -Infinity;
    for (let i = g.startIdx; i <= g.endIdx; i++) { lo = Math.min(lo, bars[i].l); hi = Math.max(hi, bars[i].h); }
    const pad = (hi - lo) * 0.07 || 20;
    if (yScale) { g.pMin = yScale.center - yScale.span / 2; g.pMax = yScale.center + yScale.span / 2; }
    else { g.pMin = lo - pad; g.pMax = hi + pad; }
    g.bin = pickBin();
    g.hover = hoverIndex();
    g.cellsDrawn = 0; g.cellsLabeled = 0; g.textHidden = false;
    volumeStats();

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, g.plotW, g.timeTop); ctx.clip();
    drawWatermark();
    drawGrid();
    if (flash && Date.now() < flash.until) {
      const fi = bars.findIndex(b => b.t === flash.t);
      if (fi >= 0) { ctx.fillStyle = 'rgba(201,168,76,0.10)'; ctx.fillRect(X(fi) - g.barW / 2, 0, g.barW, g.timeTop); }
    }
    if (g.hover != null) { ctx.fillStyle = 'rgba(255,255,255,0.025)'; ctx.fillRect(X(g.hover) - g.barW / 2, 0, g.barW, g.timeTop); }
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, g.plotW, g.mainH); ctx.clip();
    if (toggles.fp && toggles.imb && g.barW >= 12) drawStackedZones();
    for (let i = g.startIdx; i <= g.endIdx; i++) drawBar(i);
    if (toggles.sig) drawMainSignals();
    if (toggles.pdiv) drawPotentialDivs();
    drawPriceLine();
    ctx.restore();
    if (toggles.oi) drawOIPane();
    if (toggles.cvd) drawCVDPane();
    if (toggles.fpbs) drawTable();
    ctx.restore();

    drawAxis();
    drawTimeAxis();
    drawLegend(g.hover != null ? g.hover : bars.length - 1);
    if (mouse) drawCrosshair();
  }

  // Shades and "big volume" are judged against every footprint cell in view, so a heavy row
  // stands out across candles, not just within its own candle.
  function volumeStats() {
    const g = geo, cells = [], qv = [], dl = [];
    for (let i = g.startIdx; i <= g.endIdx; i++) {
      qv.push(bars[i].qv); dl.push(Math.abs(bars[i].delta));
      const fp = toggles.fp && g.barW >= 12 ? footprint(i, g.bin) : null;
      if (fp) for (const r of fp.rows) if (r.tot > 0) cells.push(r.tot);
    }
    g.cellNorm = pct(cells, 0.95) || 1;
    g.cellBig = pct(cells, 0.88) || Infinity;
    g.qvNorm = pct(qv, 0.9) || 1; g.qvBig = pct(qv, 0.85) || Infinity;
    g.dNorm = pct(dl, 0.9) || 1; g.dBig = pct(dl, 0.85) || Infinity;
  }
  function pct(a, q) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  }

  function hoverIndex() {
    if (!mouse || mouse.x > geo.plotW || mouse.y > geo.timeTop) return null;
    const i = Math.round(mouse.x / geo.barW - 0.5 + (geo.vEnd - geo.N + 1));
    return i >= geo.startIdx && i <= geo.endIdx ? i : null;
  }

  function drawWatermark() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(60,68,90,0.22)';
    ctx.font = '600 40px Cinzel, serif';
    ctx.fillText('IVth LEGION', geo.plotW / 2, geo.mainH / 2);
    ctx.font = '11px Inter, sans-serif';
    ctx.fillStyle = 'rgba(60,68,90,0.35)';
    ctx.fillText('ORDER FLOW · BTCUSDT PERP · ' + TFS[tfIdx].label, geo.plotW / 2, geo.mainH / 2 + 24);
    ctx.restore();
  }

  function timeStep() {
    const tf = TFS[tfIdx];
    return TIME_STEPS.find(s => s >= tf.ms && (s / tf.ms) * geo.barW >= 72) || TIME_STEPS[TIME_STEPS.length - 1];
  }
  const tzShift = () => -new Date().getTimezoneOffset() * 60000;

  function drawGrid() {
    const g = geo;
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    const step = niceStep(g.pMax - g.pMin, 8);
    for (let p = Math.ceil(g.pMin / step) * step; p <= g.pMax; p += step) {
      const y = Math.round(PY(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.plotW, y); ctx.stroke();
    }
    const ts = timeStep(), sh = tzShift();
    for (let i = g.startIdx; i <= g.vEnd + 3; i++) {
      if ((barTime(i) + sh) % ts !== 0) continue;
      const x = Math.round(X(i)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, g.timeTop); ctx.stroke();
    }
  }

  function mix(a, b, t) {
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
  }
  function clusterColor(row) {
    const vt = Math.min(1, row.tot / geo.cellNorm);
    if (opt.cluster === 'volume') {
      const t = 0.08 + 0.92 * vt;
      return [mix([222, 227, 240], [58, 84, 166], t), t > 0.58];
    }
    return cellColor((row.ask - row.bid) / row.tot, vt);
  }
  function cellText(row, mode, colW, big) {
    if (mode === 'big') return big ? fmtQ(row.tot) : '';
    if (mode === 'bidask') return `${fmtQ(row.bid)} × ${fmtQ(row.ask)}`;
    if (mode === 'delta') return fmtSignedQ(row.ask - row.bid);
    if (mode === 'volume') return fmtQ(row.tot);
    if (mode === 'auto') return colW >= 66 ? `${fmtQ(row.bid)} × ${fmtQ(row.ask)}` : colW >= 30 ? fmtSignedQ(row.ask - row.bid) : '';
    return '';
  }
  // Hue = who was aggressive (blue buyers / red sellers); depth = how much volume traded there.
  function cellColor(ratio, inten) {
    const t = Math.min(1, 0.06 + inten * 0.8 + Math.abs(ratio) * 0.22);
    return ratio >= 0
      ? [mix([206, 216, 242], [47, 94, 222], t), t > 0.55]
      : [mix([244, 212, 215], [214, 58, 72], t), t > 0.55];
  }

  function drawBar(i) {
    const b = bars[i], x = X(i), bw = geo.barW;
    const up = b.c >= b.o, col = up ? C.bull : C.bear;
    const fp = toggles.fp && bw >= 12 ? footprint(i, geo.bin) : null;
    const yO = PY(b.o), yC = PY(b.c), yH = PY(b.h), yL = PY(b.l);
    if (!fp) {
      const w = Math.max(1, bw * 0.62);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yH); ctx.lineTo(Math.round(x) + 0.5, yL); ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(x - w / 2), Math.min(yO, yC), Math.max(1, Math.round(w)), Math.max(1, Math.abs(yC - yO)));
      return;
    }
    const slotL = x - bw * 0.45;
    let colL = slotL;
    if (opt.candle === 'ohlc') {
      const cw = Math.max(2, Math.min(7, bw * 0.1));
      const cx = Math.round(slotL + cw / 2) + 0.5;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, yH); ctx.lineTo(cx, yL); ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(slotL), Math.min(yO, yC), Math.round(cw), Math.max(1, Math.abs(yC - yO)));
      colL = slotL + cw + Math.max(1, bw * 0.03);
    }
    const colW = x + bw * 0.45 - colL;
    const bin = fp.bin, rows = fp.rows;
    let maxSide = 0;
    if (opt.cluster === 'bidask') for (const row of rows) maxSide = Math.max(maxSide, row.bid, row.ask);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const yT = PY(row.p + bin), h = PY(row.p) - yT;
      const gap = h >= 5 ? 1 : 0;
      if (row.tot <= 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        ctx.fillRect(colL, yT + gap, colW, h - gap);
        continue;
      }
      const isPoc = toggles.poc && r === fp.poc;
      let dark;
      if (!isPoc && opt.cluster === 'bidask') {
        const half = colW / 2, tb = row.bid / maxSide, ta = row.ask / maxSide;
        ctx.fillStyle = mix([244, 212, 215], [214, 58, 72], tb);
        ctx.fillRect(colL, yT + gap, half - 0.5, h - gap);
        ctx.fillStyle = mix([206, 216, 242], [47, 94, 222], ta);
        ctx.fillRect(colL + half + 0.5, yT + gap, half - 0.5, h - gap);
        dark = Math.max(tb, ta) > 0.55;
      } else {
        let fill;
        [fill, dark] = isPoc ? [C.poc, true] : clusterColor(row);
        ctx.fillStyle = fill;
        ctx.fillRect(colL, yT + gap, colW, h - gap);
      }
      if (toggles.imb && (row.buyImb || row.sellImb)) {
        const mw = Math.max(2, Math.min(9, colW * 0.14)), mh = Math.max(1.5, Math.min(3, h * 0.3));
        ctx.fillStyle = C.imb;
        if (row.buyImb) ctx.fillRect(colL + colW - mw - 2, yT + gap + (h - gap) / 2 - mh / 2, mw, mh);
        if (row.sellImb) ctx.fillRect(colL + 2, yT + gap + (h - gap) / 2 - mh / 2, mw, mh);
      }
      const big = row.tot >= geo.cellBig;
      if (big && h >= 4) {
        ctx.strokeStyle = 'rgba(10,13,20,0.55)'; ctx.lineWidth = 1;
        ctx.strokeRect(colL + 0.5, yT + gap + 0.5, colW - 1, h - gap - 1);
      }
      geo.cellsDrawn++;
      // Below these widths not every number fits, so show none rather than a patchy subset.
      const wantText = opt.text !== 'none' && opt.text !== 'imbalance';
      const textFits = colW >= (opt.text === 'volume' || opt.text === 'big' ? 17 : 23) && h >= 8;
      if (wantText && !textFits) geo.textHidden = true;
      if (wantText && textFits) {
        const label = cellText(row, opt.text, colW, big);
        // Narrow columns: shrink the font, then drop bold, then fall back to a shorter number
        // (bid × ask → delta, 98.7 → 99) so every row keeps a value.
        const tries = [...new Set(label.includes('×')
          ? [label, fmtSignedQ(row.ask - row.bid), compactQ(row.ask - row.bid, true)]
          : [label, compactQ(opt.text === 'delta' ? row.ask - row.bid : row.tot, opt.text === 'delta')])];
        const weights = big || isPoc ? [800, 600] : [500];
        ctx.fillStyle = dark ? '#ffffff' : '#1b2030';
        ctx.textAlign = 'center';
        outer: for (const t of label ? tries : []) for (const wt of weights) {
          for (let fs = Math.min(big ? 11 : 10, Math.floor(h - 1)); fs >= 7; fs--) {
            ctx.font = `${wt} ${fs}px Inter, sans-serif`;
            if (ctx.measureText(t).width <= colW - 2) {
              ctx.fillText(t, colL + colW / 2, yT + gap + (h - gap) / 2 + fs * 0.36);
              geo.cellsLabeled++;
              break outer;
            }
          }
        }
      }
    }
    if (toggles.va && rows.length > 2) {
      ctx.strokeStyle = C.va; ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
      for (const p of [fp.vah, fp.val]) {
        const y = Math.round(PY(p)) + 0.5;
        ctx.beginPath(); ctx.moveTo(colL, y); ctx.lineTo(colL + colW, y); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  function drawStackedZones() {
    const g = geo;
    for (let i = Math.max(0, g.startIdx - 80); i <= g.endIdx; i++) {
      const fp = footprint(i, g.bin);
      if (!fp || !fp.zones.length) continue;
      for (const z of fp.zones) {
        let end = bars.length;
        for (let j = i + 1; j < bars.length; j++) {
          if (z.side === 'buy' ? bars[j].c < z.lo : bars[j].c > z.hi) { end = j; break; }
        }
        const x0 = X(i) + g.barW * 0.45;
        const x1 = end >= bars.length ? g.plotW : X(end);
        if (x1 < 0) continue;
        const rgb = z.side === 'buy' ? '31,184,134' : '239,79,90';
        const y0 = PY(z.hi), y1 = PY(z.lo);
        ctx.fillStyle = `rgba(${rgb},0.055)`;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeStyle = `rgba(${rgb},0.4)`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, Math.round(y0) + 0.5); ctx.lineTo(x1, Math.round(y0) + 0.5);
        ctx.moveTo(x0, Math.round(y1) + 0.5); ctx.lineTo(x1, Math.round(y1) + 0.5); ctx.stroke();
      }
    }
  }

  function drawMainSignals() {
    const g = geo, stackTop = new Map(), stackBot = new Map();
    const nextTop = i => { const v = stackTop.get(i) || 0; stackTop.set(i, v + 1); return v; };
    const nextBot = i => { const v = stackBot.get(i) || 0; stackBot.set(i, v + 1); return v; };
    for (const s of signals) {
      if (s.i < g.startIdx - 40 || s.i > g.endIdx) continue;
      const b = bars[s.i], x = X(s.i), color = SIDE_COLOR[s.side];
      const top = s.side === 'bear';
      if (s.kind === 'div') {
        const a = bars[s.from];
        const ya = top ? PY(a.h) - 10 : PY(a.l) + 10, yb = top ? PY(b.h) - 10 : PY(b.l) + 10;
        ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(X(s.from), ya); ctx.lineTo(x, yb); ctx.stroke();
        for (const [px, py] of [[X(s.from), ya], [x, yb]]) {
          ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
        }
        pill(top ? 'CVD DIV ▼' : 'CVD DIV ▲', x, Math.max(52, Math.min(geo.mainH - 10, top ? yb - 12 : yb + 12)), color);
        continue;
      }
      if (s.i < g.startIdx || s.kind === 'oi') continue;
      const k = top ? nextTop(s.i) : nextBot(s.i);
      const y = top ? PY(b.h) - 12 - k * 14 : PY(b.l) + 12 + k * 14;
      if (s.kind === 'abs') {
        ctx.fillStyle = C.abs;
        ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke();
      } else if (s.kind === 'dd') {
        ctx.fillStyle = color;
        ctx.beginPath();
        if (top) { ctx.moveTo(x - 4, y - 3); ctx.lineTo(x + 4, y - 3); ctx.lineTo(x, y + 3); }
        else { ctx.moveTo(x - 4, y + 3); ctx.lineTo(x + 4, y + 3); ctx.lineTo(x, y - 3); }
        ctx.closePath(); ctx.fill();
      }
    }
  }

  function drawPotentialDivs() {
    const list = potentialDivs();
    geo.pdivs = list;
    list.forEach(d => {
      const tf = PDIV_TFS.find(t => t.label === d.tf);
      const ib = extremeIndex(d.bT, tf.ms, d.side);
      if (ib == null) return;
      const ia = extremeIndex(d.aT, tf.ms, d.side);
      const top = d.side === 'bear', color = top ? C.bear : C.bull;
      const off = 16 + PDIV_TFS.indexOf(tf) * 14;
      const xa = ia == null ? Math.min(0, X(0)) : X(ia), xb = X(ib);
      const ya = PY(d.aP) + (top ? -off : off), yb = PY(d.bP) + (top ? -off : off);
      ctx.save();
      ctx.setLineDash([4, 3]); ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke();
      ctx.restore();
      const label = `DIV? ${d.tf} ${top ? '▼' : '▲'}`;
      ctx.font = '700 9px Inter, sans-serif';
      const w = ctx.measureText(label).width + 10, py = Math.max(52, Math.min(geo.mainH - 30, top ? yb - 10 : yb + 10));
      ctx.fillStyle = 'rgba(16,20,31,0.92)'; roundRect(xb - w / 2, py - 7, w, 14, 3); ctx.fill();
      ctx.setLineDash([2, 2]); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(label, xb, py + 3);
    });
    // Status strip: which timeframes have a divergence forming right now.
    ctx.font = '700 10px Inter, sans-serif'; ctx.textAlign = 'left';
    geo.pdivTfs = PDIV_TFS.slice(tfIdx).map(t => t.label);
    const parts = PDIV_TFS.slice(tfIdx).map(t => {
      const ds = list.filter(d => d.tf === t.label);
      const bear = ds.some(d => d.side === 'bear'), bull = ds.some(d => d.side === 'bull');
      return { text: `${t.label} ${bear && bull ? '▼▲' : bear ? '▼?' : bull ? '▲?' : '—'}`, color: bear ? C.bear : bull ? C.bull : C.text };
    });
    const head = 'POTENTIAL DIV';
    let w = ctx.measureText(head).width + 24;
    for (const p of parts) w += ctx.measureText(p.text).width + 12;
    const y = geo.mainH - 28;
    ctx.fillStyle = 'rgba(16,20,31,0.85)'; roundRect(8, y, w, 20, 4); ctx.fill();
    ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
    let x = 16;
    ctx.fillStyle = C.text; ctx.fillText(head, x, y + 14); x += ctx.measureText(head).width + 12;
    for (const p of parts) { ctx.fillStyle = p.color; ctx.fillText(p.text, x, y + 14); x += ctx.measureText(p.text).width + 12; }
  }

  function pill(text, x, y, color) {
    ctx.font = '600 9px Inter, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = color;
    roundRect(x - w / 2, y - 7, w, 14, 3); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
    ctx.fillText(text, x, y + 3);
  }

  function drawPriceLine() {
    if (!lastPrice) return;
    const y = Math.round(PY(lastPrice)) + 0.5;
    ctx.strokeStyle = 'rgba(45,140,240,0.7)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(geo.plotW, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  function subPaneScale(top, h, values) {
    let lo = Infinity, hi = -Infinity;
    for (const v of values) { if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo === Infinity) return null;
    const pad = (hi - lo) * 0.14 || Math.abs(hi) * 0.001 || 1;
    lo -= pad; hi += pad;
    return { lo, hi, y: v => top + 18 + (h - 24) * (1 - (v - lo) / (hi - lo)) };
  }

  function paneHeader(top, title, value, color) {
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(W, top + 0.5); ctx.stroke();
    ctx.font = '600 10px Inter, sans-serif'; ctx.textAlign = 'left';
    ctx.fillStyle = C.text; ctx.fillText(title, 10, top + 14);
    if (value != null) {
      const w = ctx.measureText(title).width;
      ctx.fillStyle = color; ctx.fillText(value, 16 + w, top + 14);
    }
  }

  function drawOIPane() {
    const g = geo, top = g.oiTop, h = g.oiH;
    const vals = [];
    for (let i = g.startIdx; i <= g.endIdx; i++) vals.push(bars[i].oiO, bars[i].oiC);
    const s = subPaneScale(top, h, vals);
    // Header follows the hovered candle; otherwise shows the latest OI and its 24h change.
    const hb = bars[g.hover != null ? g.hover : bars.length - 1];
    const barChg = hb.oiC != null && hb.oiO != null ? hb.oiC - hb.oiO : null;
    const dayAgo = oiAt(Date.now() - 864e5);
    const dayChg = g.hover == null && hb.oiC != null && dayAgo != null ? hb.oiC - dayAgo : null;
    paneHeader(top, 'OI · OPEN INTEREST',
      hb.oiC == null ? '—' : '$' + fmtAxisUsd(hb.oiC, 1e6) +
        (barChg != null ? '   candle ' + fmtSignedUsd(barChg) : '') +
        (dayChg != null ? '   24h ' + fmtSignedUsd(dayChg) : ''),
      (barChg ?? 0) >= 0 ? C.bull : C.bear);
    if (!s) return;
    g.oiScale = s;
    const w = Math.max(1, g.barW * 0.62);
    for (let i = g.startIdx; i <= g.endIdx; i++) {
      const b = bars[i];
      if (b.oiO == null || b.oiC == null) continue;
      const up = b.oiC >= b.oiO;
      const y0 = s.y(Math.max(b.oiO, b.oiC)), y1 = s.y(Math.min(b.oiO, b.oiC));
      ctx.fillStyle = up ? C.bull : C.bear;
      ctx.fillRect(Math.round(X(i) - w / 2), y0, Math.max(1, Math.round(w)), Math.max(1, y1 - y0));
    }
    if (toggles.sig) {
      ctx.font = '700 10px Inter, sans-serif'; ctx.textAlign = 'center';
      for (const sg of signals) {
        if (sg.kind !== 'oi' || sg.i < g.startIdx || sg.i > g.endIdx) continue;
        const b = bars[sg.i], color = SIDE_COLOR[sg.side];
        const y = Math.max(top + 30, s.y(Math.max(b.oiO ?? b.oiC, b.oiC ?? b.oiO)) - 11);
        const w = ctx.measureText(sg.tag).width + 8;
        ctx.fillStyle = color; roundRect(X(sg.i) - w / 2, y - 8, w, 14, 3); ctx.fill();
        ctx.fillStyle = sg.side === 'warn' ? '#1a1300' : '#fff';
        ctx.fillText(sg.tag, X(sg.i), y + 3);
      }
    }
  }

  function drawCVDPane() {
    const g = geo, top = g.cvdTop, h = g.cvdH;
    const vals = [];
    for (let i = g.startIdx; i <= g.endIdx; i++) vals.push(bars[i].cvdC);
    const s = subPaneScale(top, h, vals);
    const last = bars[g.endIdx];
    paneHeader(top, 'CVD', fmtSignedUsd(last.cvdC), last.cvdC >= last.cvdO ? C.bull : C.bear);
    if (!s) return;
    g.cvdScale = s;
    ctx.beginPath();
    for (let i = g.startIdx; i <= g.endIdx; i++) {
      const x = X(i), y = s.y(bars[i].cvdC);
      if (i === g.startIdx) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#4f8df7'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineTo(X(g.endIdx), top + h); ctx.lineTo(X(g.startIdx), top + h); ctx.closePath();
    const grad = ctx.createLinearGradient(0, top, 0, top + h);
    grad.addColorStop(0, 'rgba(79,141,247,0.22)'); grad.addColorStop(1, 'rgba(79,141,247,0)');
    ctx.fillStyle = grad; ctx.fill();
    if (s.lo < 0 && s.hi > 0) {
      ctx.strokeStyle = 'rgba(125,132,151,0.35)'; ctx.setLineDash([2, 3]);
      const y = Math.round(s.y(0)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.plotW, y); ctx.stroke(); ctx.setLineDash([]);
    }
    if (toggles.sig) {
      for (const sg of signals) {
        if (sg.kind !== 'div' || sg.i < g.startIdx || sg.from > g.endIdx) continue;
        const color = SIDE_COLOR[sg.side];
        const ya = s.y(bars[sg.from].cvdC), yb = s.y(bars[sg.i].cvdC);
        ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(X(sg.from), ya); ctx.lineTo(X(sg.i), yb); ctx.stroke();
        for (const [px, py] of [[X(sg.from), ya], [X(sg.i), yb]]) {
          ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
        }
      }
    }
  }

  function drawTable() {
    const g = geo, top = g.tableTop + g.tableHead, rh = (g.tableH - g.tableHead) / 2;
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, g.tableTop + 0.5); ctx.lineTo(W, g.tableTop + 0.5); ctx.stroke();
    {
      ctx.font = '600 10px Inter, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = C.text;
      ctx.fillText('FOOTPRINT BAR STATISTICS', 10, g.tableTop + 14);
    }
    const showText = g.barW >= 22;
    ctx.textAlign = 'center';
    for (let i = g.startIdx; i <= g.endIdx; i++) {
      const b = bars[i], x0 = X(i) - g.barW / 2 + 0.5, w = g.barW - 1;
      const tv = Math.min(1, b.qv / g.qvNorm);
      ctx.fillStyle = mix([229, 233, 244], [104, 130, 200], tv);
      ctx.fillRect(x0, top + 1, w, rh - 1);
      const td = Math.min(1, Math.abs(b.delta) / g.dNorm);
      ctx.fillStyle = b.delta >= 0 ? mix([226, 233, 251], [52, 98, 226], td) : mix([251, 226, 228], [222, 62, 76], td);
      ctx.fillRect(x0, top + rh + 1, w, rh - 1);
      if (showText) {
        fitText(fmtUsd(b.qv), X(i), top + rh / 2 + 4, w - 4, b.qv >= g.qvBig, tv > 0.62);
        fitText(fmtSignedUsd(b.delta), X(i), top + rh * 1.5 + 4, w - 4, Math.abs(b.delta) >= g.dBig, td > 0.55);
      }
    }
  }

  function fitText(text, x, y, maxW, bold, light) {
    for (const fs of bold ? [11, 10, 9] : [10, 9, 8]) {
      ctx.font = `${bold ? 800 : 500} ${fs}px Inter, sans-serif`;
      if (ctx.measureText(text).width <= maxW) {
        ctx.fillStyle = light ? '#fff' : '#1b2030';
        ctx.fillText(text, x, y);
        return;
      }
    }
  }

  function drawAxis() {
    const g = geo, ax = g.plotW;
    ctx.fillStyle = C.axis; ctx.fillRect(ax, 0, g.axisW, H);
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ax + 0.5, 0); ctx.lineTo(ax + 0.5, H); ctx.stroke();
    ctx.font = '11px Inter, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = C.text;
    const step = niceStep(g.pMax - g.pMin, 8);
    for (let p = Math.ceil(g.pMin / step) * step; p <= g.pMax; p += step) {
      const y = PY(p);
      if (y > 10 && y < g.mainH - 32) ctx.fillText(fmtPrice(p), ax + 8, y + 4);
    }
    const lb0 = bars[bars.length - 1];
    g.oiTicks = g.oiScale && toggles.oi ? axisTicks(g.oiScale, g.oiTop, g.oiH, fmtAxisUsd, lb0.oiC != null ? g.oiScale.y(lb0.oiC) : null) : 0;
    if (g.cvdScale && toggles.cvd) axisTicks(g.cvdScale, g.cvdTop, g.cvdH, (v, st) => (v > 0 ? '+' : '') + fmtAxisUsd(v, st), g.cvdScale.y(lb0.cvdC));
    if (toggles.fpbs) {
      const rt = g.tableTop + g.tableHead, rh = (g.tableH - g.tableHead) / 2;
      ctx.font = '600 10px Inter, sans-serif'; ctx.fillStyle = C.textHi;
      ctx.fillText('Perp vol', ax + 8, rt + rh * 0.5 + 4);
      ctx.fillText('Delta', ax + 8, rt + rh * 1.5 + 4);
    }
    const ab = autoBtnRect();
    ctx.fillStyle = yScale ? 'transparent' : 'rgba(45,140,240,0.18)';
    roundRect(ab.x, ab.y, ab.w, ab.h, 4); ctx.fill();
    ctx.strokeStyle = yScale ? '#3a445c' : 'rgba(45,140,240,0.7)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = '700 9px Inter, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = yScale ? '#8a91a5' : '#6f9bff';
    ctx.fillText('AUTO', ab.x + ab.w / 2, ab.y + 12);
    ctx.textAlign = 'left';
    if (lastPrice) {
      const y = PY(lastPrice);
      if (y > 0 && y < g.mainH) tag(fmtPrice(lastPrice, true), y, C.price);
    }
    const lb = bars[bars.length - 1];
    if (toggles.oi && g.oiScale && lb.oiC != null) tag(fmtAxisUsd(lb.oiC, (g.oiScale.hi - g.oiScale.lo) / 4), g.oiScale.y(lb.oiC), lb.oiC >= (lb.oiO ?? lb.oiC) ? C.bull : C.bear);
    if (toggles.cvd && g.cvdScale) tag(fmtSignedUsd(lb.cvdC), g.cvdScale.y(lb.cvdC), lb.cvdC >= lb.cvdO ? C.bull : C.bear);
  }

  // Evenly stepped labels at any zoom; precision follows the step so labels never repeat.
  function axisTicks(s, top, h, fmt, avoidY) {
    ctx.font = '10px Inter, sans-serif'; ctx.fillStyle = C.text; ctx.textAlign = 'left';
    const step = niceStep(s.hi - s.lo, Math.max(2, Math.floor((h - 24) / 26)));
    let drawn = 0;
    for (let v = Math.ceil(s.lo / step) * step; v <= s.hi; v += step) {
      const y = s.y(v);
      if (y < top + 14 || y > top + h - 4) continue;
      if (avoidY != null && Math.abs(y - avoidY) < 13) continue;
      ctx.fillText(fmt(v, step), geo.plotW + 8, y + 4);
      drawn++;
    }
    return drawn;
  }
  function fmtAxisUsd(v, step) {
    const a = Math.abs(v), s = v < 0 ? '-' : '';
    const dec = unit => Math.max(1, Math.min(4, Math.ceil(-Math.log10(step / unit) - 1e-9)));
    if (a >= 1e9) return s + (a / 1e9).toFixed(Math.max(2, dec(1e9))) + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(dec(1e6)) + 'M';
    return fmtUsd(v);
  }

  function tag(text, y, color) {
    ctx.font = '600 11px Inter, sans-serif';
    ctx.fillStyle = color;
    roundRect(geo.plotW + 1, y - 9, geo.axisW - 3, 18, 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText(text, geo.plotW + 7, y + 4);
  }

  function drawTimeAxis() {
    const g = geo, top = g.timeTop;
    ctx.fillStyle = C.axis; ctx.fillRect(0, top, g.plotW, g.timeH);
    ctx.strokeStyle = C.border; ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(W, top + 0.5); ctx.stroke();
    const ts = timeStep(), sh = tzShift();
    ctx.textAlign = 'center';
    for (let i = g.startIdx; i <= g.vEnd + 3; i++) {
      const lt = barTime(i) + sh;
      if (lt % ts !== 0) continue;
      const d = new Date(barTime(i));
      const midnight = lt % 86400000 === 0;
      const hour = lt % 3600000 === 0;
      ctx.font = (midnight || (hour && ts < 3600000) ? '600 ' : '') + '11px Inter, sans-serif';
      ctx.fillStyle = midnight || hour ? C.textHi : C.text;
      ctx.fillText(midnight ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : hhmm(d), X(i), top + 16);
    }
  }

  function drawLegend(i) {
    const b = bars[i];
    const up = b.c >= b.o, col = up ? C.bull : C.bear;
    const oiChg = b.oiO != null && b.oiC != null ? b.oiC - b.oiO : null;
    const chg = b.c - b.o;
    const segs = [
      [fmtDateTime(b.t) + (i === bars.length - 1 ? ' · LIVE' : ''), '', C.textHi],
      ['O', fmtPrice(b.o, true), col], ['H', fmtPrice(b.h, true), col], ['L', fmtPrice(b.l, true), col], ['C', fmtPrice(b.c, true), col],
      ['', (chg >= 0 ? '+' : '') + chg.toFixed(1) + ' (' + (chg >= 0 ? '+' : '') + ((chg / b.o) * 100).toFixed(2) + '%)', col],
      ['Vol', fmtUsd(b.qv), C.textHi],
      ['Δ', fmtSignedUsd(b.delta), b.delta >= 0 ? C.bull : C.bear],
      ['OI', oiChg == null ? '—' : fmtSignedUsd(oiChg), oiChg == null ? C.text : oiChg >= 0 ? C.bull : C.bear],
    ];
    if (toggles.cvd) segs.push(['CVD', fmtSignedUsd(b.cvdC), C.textHi]);
    if (toggles.fp && footprint(i, geo.bin)) segs.push(['Row', '$' + geo.bin, C.text]);
    if (geo.textHidden) segs.push(['', 'zoom in for numbers', C.text]);
    ctx.font = '11px Inter, sans-serif'; ctx.textAlign = 'left';
    let w = 20;
    for (const [l, v] of segs) w += ctx.measureText(l).width + (v ? ctx.measureText(v).width + 4 : 0) + 12;
    const sigs = toggles.sig ? signals.filter(s => s.i === i) : [];
    ctx.fillStyle = 'rgba(16,20,31,0.82)';
    roundRect(6, 6, Math.min(w, geo.plotW - 12), sigs.length ? 38 : 22, 4); ctx.fill();
    let x = 14;
    for (const [l, v, c] of segs) {
      ctx.fillStyle = v ? C.text : c; ctx.fillText(l, x, 21); x += ctx.measureText(l).width + 4;
      if (v) { ctx.fillStyle = c; ctx.fillText(v, x, 21); x += ctx.measureText(v).width; }
      x += 8;
    }
    if (sigs.length) {
      ctx.font = '600 10px Inter, sans-serif';
      x = 14;
      for (const s of sigs) {
        ctx.fillStyle = SIDE_COLOR[s.side];
        const t = s.tag + ' ' + s.title;
        ctx.fillText(t, x, 37); x += ctx.measureText(t).width + 14;
      }
    }
  }

  function drawCrosshair() {
    const g = geo, { x, y } = mouse;
    if (x > g.plotW || y > g.timeTop) return;
    ctx.strokeStyle = 'rgba(160,168,190,0.45)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    const cx = g.hover != null ? Math.round(X(g.hover)) + 0.5 : x;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, g.timeTop);
    if (y < g.tableTop) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(g.plotW, Math.round(y) + 0.5); }
    ctx.stroke(); ctx.setLineDash([]);
    let label = null;
    if (y < g.mainH) label = fmtPrice(YP(y), true);
    else if (toggles.oi && g.oiScale && y >= g.oiTop && y < g.oiTop + g.oiH) label = fmtUsd(g.oiScale.lo + (1 - (y - g.oiTop - 18) / (g.oiH - 24)) * (g.oiScale.hi - g.oiScale.lo));
    else if (toggles.cvd && g.cvdScale && y >= g.cvdTop && y < g.cvdTop + g.cvdH) label = fmtSignedUsd(g.cvdScale.lo + (1 - (y - g.cvdTop - 18) / (g.cvdH - 24)) * (g.cvdScale.hi - g.cvdScale.lo));
    if (label) tag(label, y, '#363c4e');
    if (g.hover != null) {
      const t = fmtDateTime(bars[g.hover].t);
      ctx.font = '11px Inter, sans-serif';
      const w = ctx.measureText(t).width + 14;
      ctx.fillStyle = '#363c4e'; roundRect(cx - w / 2, g.timeTop + 2, w, 20, 2); ctx.fill();
      ctx.fillStyle = C.white; ctx.textAlign = 'center'; ctx.fillText(t, cx, g.timeTop + 16);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────
  function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
  function stdev(a, m) { return a.length ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) : 0; }
  function niceStep(r, t) {
    const s = r / t, m = Math.pow(10, Math.floor(Math.log10(s))), n = s / m;
    return (n <= 1.5 ? 1 : n <= 3 ? 2 : n <= 7 ? 5 : 10) * m;
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function fmtPrice(p, precise) {
    return p.toLocaleString('en-US', { minimumFractionDigits: precise ? 1 : 0, maximumFractionDigits: precise ? 1 : 0 });
  }
  function fmtUsd(v) {
    const a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(a >= 1e10 ? 1 : 3) + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
    if (a >= 1e3) return s + (a / 1e3).toFixed(0) + 'K';
    return s + a.toFixed(0);
  }
  function fmtSignedUsd(v) { return (v > 0 ? '+' : '') + fmtUsd(v); }
  function fmtQ(q) {
    if (q >= 1000) return (q / 1000).toFixed(1) + 'K';
    if (q >= 100) return q.toFixed(0);
    if (q >= 10) return q.toFixed(1);
    return q ? q.toFixed(2) : '0';
  }
  function compactQ(q, signed) {
    const a = Math.abs(q);
    const body = a >= 1000 ? (a / 1000).toFixed(a >= 9950 ? 0 : 1) + 'K' : a >= 9.95 ? String(Math.round(a)) : a.toFixed(1);
    return (signed ? (q > 0 ? '+' : q < 0 ? '−' : '') : '') + body;
  }
  function fmtSignedQ(q) { return (q > 0 ? '+' : q < 0 ? '−' : '') + fmtQ(Math.abs(q)); }
  function hhmm(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function fmtDateTime(t) {
    const d = new Date(t);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + hhmm(d);
  }
  function fmtDur(ms) {
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
    return h ? `${h}h ${m % 60}m` : `${m}m`;
  }

  // ── Status / chrome ──────────────────────────────────────────────
  function setStatus(text, live, detail) {
    if (statusEl) statusEl.textContent = live ? '' : text;
    if (dotEl) { dotEl.classList.toggle('off', !live); dotEl.title = text + (detail ? ' · ' + detail : ''); }
  }
  function updateStatus() {
    const live = !!ws && ws.readyState === 1;
    const hist = fpStart === Infinity ? 0 : Date.now() - fpStart;
    setStatus(live ? 'LIVE' : 'RECONNECTING', live, 'Footprint history: ' + (hist > 60000 ? fmtDur(hist) : 'building'));
  }

  function setTF(idx) {
    if (idx === tfIdx) return;
    tfIdx = idx;
    const sel = root.querySelector('select[data-s="tf"]');
    if (sel) sel.value = String(idx);
    load();
  }

  function autoBtnRect() { return { x: geo.plotW + 8, y: geo.mainH - 24, w: geo.axisW - 16, h: 17 }; }
  const onPriceAxis = p => p.x > geo.plotW && p.y < geo.mainH;
  const onTimeAxis = p => p.x < geo.plotW && p.y > geo.timeTop;
  const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const clampSpan = s => Math.max(20, Math.min(60000, s));
  const clampBars = n => Math.max(8, Math.min(bars.length, Math.round(n)));
  const currentScale = () => yScale || { center: (geo.pMin + geo.pMax) / 2, span: geo.pMax - geo.pMin };

  function bindEvents() {
    const toCanvas = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const idleCursor = p => (inRect(p, autoBtnRect()) ? 'pointer' : onPriceAxis(p) ? 'ns-resize' : onTimeAxis(p) ? 'ew-resize' : 'crosshair');
    canvas.addEventListener('mousemove', e => {
      mouse = toCanvas(e);
      if (axisDrag && axisDrag.type === 'y') {
        // Drag down = squash (wider price range), drag up = stretch.
        yScale = { center: axisDrag.center, span: clampSpan(axisDrag.span * Math.exp((mouse.y - axisDrag.y) / 140)) };
      } else if (axisDrag && axisDrag.type === 'x') {
        view.bars = clampBars(axisDrag.bars * Math.exp(-(mouse.x - axisDrag.x) / 200));
      } else if (drag) {
        view.offset = clampOffset(drag.offset + Math.round((mouse.x - drag.x) / geo.barW));
        // A clear vertical drag switches price to manual so the chart can be moved up/down.
        if (!yScale && Math.abs(mouse.y - drag.y) > 30) { yScale = currentScale(); drag.center = yScale.center; drag.y = mouse.y; }
        if (yScale && drag.center != null) yScale = { center: drag.center + (mouse.y - drag.y) * (yScale.span / geo.mainH), span: yScale.span };
      } else canvas.style.cursor = idleCursor(mouse);
      requestRender();
    });
    canvas.addEventListener('mouseleave', () => { mouse = null; drag = null; axisDrag = null; canvas.style.cursor = 'crosshair'; requestRender(); });
    canvas.addEventListener('mousedown', e => {
      const p = toCanvas(e);
      if (inRect(p, autoBtnRect())) { yScale = null; requestRender(); return; }
      if (onPriceAxis(p)) { const sc = currentScale(); axisDrag = { type: 'y', y: p.y, center: sc.center, span: sc.span }; return; }
      if (onTimeAxis(p)) { axisDrag = { type: 'x', x: p.x, bars: view.bars }; return; }
      if (p.x > geo.plotW) return;
      drag = { x: p.x, y: p.y, offset: view.offset, center: yScale ? yScale.center : null };
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', () => {
      if (drag || axisDrag) { drag = null; axisDrag = null; canvas.style.cursor = mouse ? idleCursor(mouse) : 'crosshair'; }
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const p = toCanvas(e);
      if (onPriceAxis(p)) {
        const sc = currentScale();
        yScale = { center: sc.center, span: clampSpan(sc.span * (e.deltaY > 0 ? 1.1 : 0.9)) };
      } else {
        const step = Math.max(1, Math.round(view.bars * 0.1));
        view.bars = clampBars(view.bars + (e.deltaY > 0 ? step : -step));
      }
      requestRender();
    }, { passive: false });
    canvas.addEventListener('dblclick', e => {
      const p = toCanvas(e);
      if (onPriceAxis(p)) { yScale = null; requestRender(); }
      else if (onTimeAxis(p)) { view.bars = defaultBars(); requestRender(); }
      else resetView();
    });
    new ResizeObserver(requestRender).observe(canvas.parentElement);
    window.addEventListener('resize', requestRender);
    document.addEventListener('fullscreenchange', requestRender);
  }

  function resetView() { view.bars = defaultBars(); view.offset = 0; yScale = null; requestRender(); }

  function selectHTML(key, label, options, value) {
    return `<label class="of-sel"><span>${label}</span><select data-s="${key}">` +
      options.map(([v, t]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${t}</option>`).join('') +
      '</select></label>';
  }

  function buildToolbar() {
    const tz = -new Date().getTimezoneOffset() / 60;
    const tg = [['fpbs', 'FPBS', 'Footprint bar statistics'], ['oi', 'OI', 'Open interest'], ['cvd', 'CVD', 'Cumulative volume delta'], ['poc', 'POC', 'Point of control per candle'], ['va', 'VA', 'Value area (70% of volume) per candle'], ['sig', 'Signals', 'Confirmed CVD divergences, OI regimes, absorption'], ['pdiv', 'Div ?', 'Potential divergences forming now: this timeframe and every higher one up to 1D']];
    root.innerHTML =
      '<div class="of-toolbar">' +
        '<div class="of-tb-group">' +
          '<span class="of-dot"></span><span class="of-sym">BTCUSDT</span><span class="of-ex" title="Binance USDⓈ-M perpetual">PERP</span>' +
          selectHTML('tf', 'Time', TFS.map((t, i) => [i, t.label]), tfIdx) +
          selectHTML('tick', 'Tick', [[0, 'Auto'], [5, '5'], [10, '10'], [20, '20'], [25, '25'], [40, '40'], [50, '50'], [100, '100'], [250, '250']], opt.tick) +
          selectHTML('cluster', 'Cluster', [['delta', 'Delta'], ['volume', 'Volume'], ['bidask', 'Bid / Ask']], opt.cluster) +
          selectHTML('text', 'Text', [['volume', 'All Vol'], ['big', 'Big Vol'], ['bidask', 'Bid × Ask'], ['delta', 'Delta'], ['imbalance', 'Imbalance'], ['none', 'None']], opt.text) +
          selectHTML('candle', 'Candle', [['ohlc', 'OHLC'], ['hidden', 'Hidden']], opt.candle) +
        '</div>' +
        '<div class="of-tb-group of-toggles">' + tg.map(([k, l, t]) => `<button class="of-tg${toggles[k] ? ' active' : ''}" data-k="${k}" title="${t}">${l}</button>`).join('') + '</div>' +
        '<div class="of-tb-group of-tb-right">' +
          '<span class="of-status"></span>' +
          '<button class="of-reset of-latest" title="Scroll to latest candle (keeps zoom)" aria-label="Scroll to latest">→|</button>' +
          '<button class="of-reset" title="Reset view (double-click chart)" aria-label="Reset view">↺</button>' +
          '<button class="of-fs" title="Fullscreen (Esc to exit)" aria-label="Toggle fullscreen">⛶</button>' +
          `<span class="of-clock-wrap"><span class="of-clock"></span><span class="of-tz">UTC${tz >= 0 ? '+' : ''}${tz}</span></span>` +
        '</div>' +
      '</div>' +
      '<div class="of-canvas-wrap"><canvas></canvas></div>';
    root.querySelectorAll('select[data-s]').forEach(sel => {
      sel.onchange = () => {
        const k = sel.dataset.s;
        if (k === 'tf') return setTF(+sel.value);
        opt[k] = k === 'tick' ? +sel.value : sel.value;
        requestRender();
      };
    });
  }

  function buildDOM() {
    buildToolbar();
    canvas = root.querySelector('canvas');
    ctx = canvas.getContext('2d');
    statusEl = root.querySelector('.of-status');
    clockEl = root.querySelector('.of-clock');
    dotEl = root.querySelector('.of-dot');
    root.querySelectorAll('.of-tg').forEach(b => {
      b.onclick = () => { toggles[b.dataset.k] = !toggles[b.dataset.k]; b.classList.toggle('active', toggles[b.dataset.k]); requestRender(); };
    });
    root.querySelector('.of-reset:not(.of-latest)').onclick = resetView;
    root.querySelector('.of-latest').onclick = () => { view.offset = 0; requestRender(); };
    root.querySelector('.of-fs').onclick = toggleFullscreen;
  }

  function init(containerId, opts) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (root === el) { requestRender(); return; }
    root = el;
    feedEl = opts && opts.feed ? document.getElementById(opts.feed) : null;
    dpr = window.devicePixelRatio || 1;
    buildDOM();
    bindEvents();
    renderFeed();
    connectWS();
    load();
    pollOI();
    setInterval(pollOI, 10000);
    setInterval(refreshGaps, 60000);
    loadMTF();
    setInterval(loadMTF, 5 * 60e3);
    setInterval(() => { if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);
    setInterval(updateStatus, 15000);
    setInterval(() => {
      const cut = Date.now() - 26 * 3600e3;
      for (const t of fpMin.keys()) if (t < cut) fpMin.delete(t);
    }, 10 * 60e3);
  }

  function state() {
    let fpBars = 0;
    for (let i = geo.startIdx; i <= geo.endIdx; i++) if (toggles.fp && geo.barW >= 12 && footprint(i, geo.bin)) fpBars++;
    const oiSigs = signals.filter(x => x.kind === 'oi');
    return { textHidden: geo.textHidden, cellsDrawn: geo.cellsDrawn, cellsLabeled: geo.cellsLabeled, oiSigs: oiSigs.length, oiSigsVisible: oiSigs.filter(x => x.i >= geo.startIdx && x.i <= geo.endIdx).map(x => x.tag + '@' + new Date(x.t).toTimeString().slice(0, 5)), sigToggle: toggles.sig, text: opt.text, oiTicks: geo.oiTicks, pdivs: (geo.pdivs || []).map(d => d.tf + ' ' + d.side), pdivTfs: geo.pdivTfs, mainH: geo.mainH, plotW: geo.plotW, yAuto: !yScale, pSpan: Math.round(geo.pMax - geo.pMin), pMid: Math.round((geo.pMax + geo.pMin) / 2), tf: TFS[tfIdx].label, bars: bars.length, visible: geo.endIdx - geo.startIdx + 1, fpBars, bin: geo.bin, W, H, signals: signals.length, offset: view.offset };
  }

  return { init, render: requestRender, state };
})();
