/* IVth Legion — Derivatives & Market Structure Charts (CoinGlass-style, zero deps). */
(function () {
  const $ = id => document.getElementById(id);
  const dataCache = {};

  async function load(url) {
    if (dataCache[url] && dataCache[url].exp > Date.now()) return dataCache[url].d;
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    dataCache[url] = { d, exp: Date.now() + 300000 };
    return d;
  }

  function setup(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function fmtB(n) { if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T'; if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(Math.round(n)); }
  function fmtK(n) { if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(Math.round(n)); }
  function fmtPct(n) { return (n * 100).toFixed(4) + '%'; }
  function fmtPrice(n) { return n >= 1000 ? '$' + Math.round(n).toLocaleString() : '$' + n.toFixed(2); }
  function shortDate(ms) { const d = new Date(ms); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  function shortDT(ms) { const d = new Date(ms); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }

  function niceTicks(mn, mx, n) {
    const s = mx - mn; if (s <= 0) return [mn];
    const s0 = s / n, mag = Math.pow(10, Math.floor(Math.log10(s0))), nm = s0 / mag;
    let st = nm < 1.5 ? 1 : nm < 3 ? 2 : nm < 7 ? 5 : 10; st *= mag;
    const o = []; for (let v = Math.ceil(mn / st) * st; v <= mx + 1e-9; v += st) o.push(Math.round(v / st) * st); return o;
  }

  // ════════════════════════════════════════
  // 1. OPEN INTEREST — line chart
  // ════════════════════════════════════════
  async function drawOI() {
    const badge = $('oiBadge'); if (badge) badge.textContent = 'Loading...';
    try {
      const sym = $('oiSymbol')?.value || 'BTCUSDT';
      const d = await load('/api/markets/oi?symbol=' + sym);
      const pts = d.history; if (!pts.length) throw new Error('no data');
      const cv = $('oiCanvas'); if (!cv) return;
      const s = setup(cv); if (!s) return;
      const { ctx, w, h } = s;
      const pad = { l: 70, r: 16, t: 14, b: 28 }, pW = w - pad.l - pad.r, pH = h - pad.t - pad.b;

      const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
      let vMin = Infinity, vMax = -Infinity;
      for (const p of pts) { if (p.oiUsd < vMin) vMin = p.oiUsd; if (p.oiUsd > vMax) vMax = p.oiUsd; }
      const vPad = (vMax - vMin) * 0.08; vMin -= vPad; vMax += vPad;
      const mapX = t => pad.l + (t - tMin) / (tMax - tMin) * pW;
      const mapY = v => pad.t + (vMax - v) / (vMax - vMin) * pH;

      // grid
      ctx.font = '10px Inter,sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
      for (const v of niceTicks(vMin, vMax, 5)) {
        const y = mapY(v); ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
        ctx.fillStyle = '#63637f'; ctx.fillText('$' + fmtB(v), pad.l - 6, y);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const daySpan = (tMax - tMin) / 86400000;
      const tickStep = daySpan > 60 ? 14 : daySpan > 20 ? 7 : 2;
      for (let t = tMin; t <= tMax; t += tickStep * 86400000) {
        const x = mapX(t); ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
        ctx.fillStyle = '#63637f'; ctx.fillText(shortDate(t), x, h - pad.b + 6);
      }

      // area fill
      ctx.beginPath(); ctx.moveTo(mapX(pts[0].t), mapY(pts[0].oiUsd));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(mapX(pts[i].t), mapY(pts[i].oiUsd));
      ctx.lineTo(mapX(pts[pts.length - 1].t), h - pad.b); ctx.lineTo(mapX(pts[0].t), h - pad.b); ctx.closePath();
      ctx.fillStyle = 'rgba(90,134,230,0.12)'; ctx.fill();

      // line
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) { const x = mapX(pts[i].t), y = mapY(pts[i].oiUsd); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = '#5a86e6'; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();

      const last = pts[pts.length - 1];
      if (badge) badge.textContent = sym.replace('USDT', '') + ' OI: $' + fmtB(last.oiUsd) + ' (' + fmtK(last.oi) + ' ' + sym.replace('USDT', '') + ')';
      const ex = $('oiExchanges');
      if (ex && d.current) {
        const p = []; if (d.current.binance) p.push('Binance: ' + fmtK(d.current.binance));
        if (d.current.bybit) p.push('Bybit: ' + fmtK(d.current.bybit)); if (d.current.okx) p.push('OKX: ' + fmtK(d.current.okx));
        ex.innerHTML = '<strong>Live OI by exchange</strong><br>' + p.join(' · ');
      }
    } catch (e) { if (badge) badge.textContent = 'Open interest data unavailable'; }
  }

  // ════════════════════════════════════════
  // 2. FUNDING RATES — bar chart (current) + line (history)
  // ════════════════════════════════════════
  async function drawFunding() {
    const badge = $('fundingBadge'); if (badge) badge.textContent = 'Loading...';
    try {
      const d = await load('/api/markets/funding');

      // Current rates bar chart
      const cv1 = $('fundingBarsCanvas'), cv2 = $('fundingHistCanvas');

      // ── current funding bars ──
      if (cv1 && d.current.length) {
        const s = setup(cv1); if (s) {
          const { ctx, w, h } = s;
          const pad = { l: 76, r: 66, t: 8, b: 8 }, bH = Math.min(22, (h - pad.t - pad.b) / d.current.length - 2);
          const maxRate = Math.max(...d.current.map(c => Math.abs(c.rate)), 0.001);
          const midX = pad.l + (w - pad.l - pad.r) / 2;
          ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.moveTo(midX, pad.t); ctx.lineTo(midX, h - pad.b); ctx.stroke();
          ctx.font = '11px Inter,sans-serif';
          d.current.forEach((c, i) => {
            const y = pad.t + i * (bH + 2);
            const barW = (c.rate / maxRate) * ((w - pad.l - pad.r) / 2 - 4);
            const pos = c.rate >= 0;
            ctx.fillStyle = pos ? 'rgba(70,192,90,0.7)' : 'rgba(255,90,74,0.7)';
            if (pos) ctx.fillRect(midX, y, barW, bH);
            else ctx.fillRect(midX + barW, y, -barW, bH);
            ctx.textBaseline = 'middle'; ctx.textAlign = 'right'; ctx.fillStyle = '#8a8ab0';
            ctx.fillText(c.symbol.replace('USDT', ''), pad.l - 4, y + bH / 2);
            ctx.textAlign = 'left'; ctx.fillStyle = pos ? '#46c05a' : '#ff5a4a';
            ctx.fillText((c.rate * 100).toFixed(4) + '%', w - pad.r + 4, y + bH / 2);
          });
        }
      }

      // ── BTC historical funding bars ──
      if (cv2 && d.history.length) {
        const s = setup(cv2); if (s) {
          const { ctx, w, h } = s;
          const pts = d.history;
          const pad = { l: 56, r: 14, t: 10, b: 28 }, pW = w - pad.l - pad.r, pH = h - pad.t - pad.b;
          const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
          let maxAbs = 0; for (const p of pts) { const a = Math.abs(p.rate); if (a > maxAbs) maxAbs = a; }
          maxAbs *= 1.1;
          const mapX = t => pad.l + (t - tMin) / (tMax - tMin) * pW;
          const mapY = r => pad.t + pH / 2 - (r / maxAbs) * (pH / 2);
          const barW = Math.max(1, pW / pts.length * 0.7);

          // zero line
          const z = mapY(0); ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.moveTo(pad.l, z); ctx.lineTo(w - pad.r, z); ctx.stroke();

          // bars
          for (const p of pts) {
            const x = mapX(p.t) - barW / 2, y = mapY(p.rate);
            ctx.fillStyle = p.rate >= 0 ? 'rgba(70,192,90,0.65)' : 'rgba(255,90,74,0.65)';
            ctx.fillRect(x, Math.min(y, z), barW, Math.abs(y - z));
          }

          // time labels
          ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#63637f';
          const daySpan2 = (tMax - tMin) / 86400000, step2 = daySpan2 > 100 ? 30 : daySpan2 > 40 ? 14 : 7;
          for (let t = tMin; t <= tMax; t += step2 * 86400000) ctx.fillText(shortDate(t), mapX(t), h - pad.b + 6);

          // y labels
          ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
          for (const v of [maxAbs * 0.5, 0, -maxAbs * 0.5]) {
            ctx.fillText((v * 100).toFixed(3) + '%', pad.l - 6, mapY(v));
          }
        }
      }

      if (badge) {
        const btc = d.current.find(c => c.symbol === 'BTCUSDT');
        badge.textContent = btc ? 'BTC Funding: ' + (btc.rate * 100).toFixed(4) + '% (8h) · ' + fmtPrice(btc.mark) : 'Funding rates loaded';
      }
    } catch (e) { if (badge) badge.textContent = 'Funding rate data unavailable'; }
  }

  // ════════════════════════════════════════
  // 3. LONG/SHORT RATIO — stacked area
  // ════════════════════════════════════════
  async function drawLSRatio() {
    const badge = $('lsBadge'); if (badge) badge.textContent = 'Loading...';
    try {
      const sym = $('lsSymbol')?.value || 'BTCUSDT';
      const view = $('lsView')?.value || 'global';
      const d = await load('/api/markets/lsratio?symbol=' + sym);
      const pts = d[view] || d.global || []; if (!pts.length) throw new Error('no data');
      const cv = $('lsCanvas'); if (!cv) return;
      const s = setup(cv); if (!s) return;
      const { ctx, w, h } = s;
      const pad = { l: 50, r: 14, t: 14, b: 28 }, pW = w - pad.l - pad.r, pH = h - pad.t - pad.b;
      const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
      const mapX = t => pad.l + (t - tMin) / (tMax - tMin) * pW;
      const mapY = v => pad.t + (1 - v) * pH;

      // long area (green, top)
      ctx.beginPath(); ctx.moveTo(mapX(pts[0].t), mapY(pts[0].long));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(mapX(pts[i].t), mapY(pts[i].long));
      ctx.lineTo(mapX(pts[pts.length - 1].t), mapY(1)); ctx.lineTo(mapX(pts[0].t), mapY(1)); ctx.closePath();
      ctx.fillStyle = 'rgba(70,192,90,0.25)'; ctx.fill();

      // short area (red, bottom)
      ctx.beginPath(); ctx.moveTo(mapX(pts[0].t), mapY(pts[0].long));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(mapX(pts[i].t), mapY(pts[i].long));
      ctx.lineTo(mapX(pts[pts.length - 1].t), mapY(0)); ctx.lineTo(mapX(pts[0].t), mapY(0)); ctx.closePath();
      ctx.fillStyle = 'rgba(255,90,74,0.25)'; ctx.fill();

      // divider line
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) { const x = mapX(pts[i].t), y = mapY(pts[i].long); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.2; ctx.lineJoin = 'round'; ctx.stroke();

      // y axis labels
      ctx.font = '10px Inter,sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right'; ctx.fillStyle = '#63637f';
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        const y = mapY(v); ctx.fillText(Math.round(v * 100) + '%', pad.l - 6, y);
        ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      }

      // time labels
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const daySpan = (tMax - tMin) / 86400000, step = daySpan > 60 ? 14 : daySpan > 20 ? 7 : 2;
      for (let t = tMin; t <= tMax; t += step * 86400000) { ctx.fillText(shortDate(t), mapX(t), h - pad.b + 6); }

      // "Long" / "Short" labels
      const last = pts[pts.length - 1];
      ctx.font = '12px Inter,sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = '#46c05a'; ctx.fillText('Long ' + (last.long * 100).toFixed(1) + '%', w / 2, pad.t + pH * (1 - last.long) / 2);
      ctx.fillStyle = '#ff5a4a'; ctx.fillText('Short ' + (last.short * 100).toFixed(1) + '%', w / 2, pad.t + pH * (1 - last.long / 2));

      if (badge) badge.textContent = sym.replace('USDT', '') + ' L/S Ratio: ' + last.ratio.toFixed(2) + ' · Long ' + (last.long * 100).toFixed(1) + '% · Short ' + (last.short * 100).toFixed(1) + '%';
    } catch (e) { if (badge) badge.textContent = 'Long/Short ratio data unavailable'; }
  }

  // ════════════════════════════════════════
  // 4. TAKER BUY/SELL VOLUME — bar chart
  // ════════════════════════════════════════
  async function drawTaker() {
    const badge = $('takerBadge'); if (badge) badge.textContent = 'Loading...';
    try {
      const sym = $('takerSymbol')?.value || 'BTCUSDT';
      const d = await load('/api/markets/taker?symbol=' + sym);
      const pts = d.history; if (!pts.length) throw new Error('no data');
      const cv = $('takerCanvas'); if (!cv) return;
      const s = setup(cv); if (!s) return;
      const { ctx, w, h } = s;
      const pad = { l: 56, r: 14, t: 14, b: 28 }, pW = w - pad.l - pad.r, pH = h - pad.t - pad.b;
      const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
      let vMax = 0; for (const p of pts) { const m = Math.max(p.buyVol, p.sellVol); if (m > vMax) vMax = m; }
      vMax *= 1.08;
      const mapX = t => pad.l + (t - tMin) / (tMax - tMin) * pW;
      const mapY = v => pad.t + (vMax - v) / vMax * pH;
      const barW = Math.max(1.2, pW / pts.length * 0.4);

      for (const p of pts) {
        const x = mapX(p.t);
        ctx.fillStyle = 'rgba(70,192,90,0.5)'; ctx.fillRect(x - barW, mapY(p.buyVol), barW, mapY(0) - mapY(p.buyVol));
        ctx.fillStyle = 'rgba(255,90,74,0.5)'; ctx.fillRect(x, mapY(p.sellVol), barW, mapY(0) - mapY(p.sellVol));
      }

      // grid + labels
      ctx.font = '10px Inter,sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right'; ctx.fillStyle = '#63637f';
      for (const v of niceTicks(0, vMax, 4)) {
        const y = mapY(v); ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
        ctx.fillText('$' + fmtB(v), pad.l - 6, y);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const daySpan = (tMax - tMin) / 86400000, step = daySpan > 60 ? 14 : daySpan > 20 ? 7 : 2;
      for (let t = tMin; t <= tMax; t += step * 86400000) { ctx.fillText(shortDate(t), mapX(t), h - pad.b + 6); }

      const last = pts[pts.length - 1];
      if (badge) badge.textContent = sym.replace('USDT', '') + ' Buy/Sell Ratio: ' + last.ratio.toFixed(3) + ' · Buy: $' + fmtB(last.buyVol) + ' · Sell: $' + fmtB(last.sellVol);
      const lg = $('takerLegend');
      if (lg && !lg.dataset.built) {
        lg.innerHTML = '<span class="lg"><span class="sw" style="background:rgba(70,192,90,0.7)"></span>Taker Buy</span><span class="lg"><span class="sw" style="background:rgba(255,90,74,0.7)"></span>Taker Sell</span>';
        lg.dataset.built = '1';
      }
    } catch (e) { if (badge) badge.textContent = 'Taker volume data unavailable'; }
  }

  // ════════════════════════════════════════
  // 5. LIQUIDATIONS — summary + recent list
  // ════════════════════════════════════════
  async function drawLiquidations() {
    const badge = $('liqBadge'); if (badge) badge.textContent = 'Loading...';
    try {
      const d = await load('/api/markets/liquidations');
      const cv = $('liqCanvas');

      // Summary bar
      if (cv) {
        const s = setup(cv); if (s) {
          const { ctx, w, h } = s;
          const total = d.h24.total || 1;
          const longPct = d.h24.longUsd / total, shortPct = d.h24.shortUsd / total;
          const pad = 20, barH = 40, barY = h / 2 - barH / 2;
          const barW = w - pad * 2;

          ctx.fillStyle = 'rgba(70,192,90,0.55)'; ctx.fillRect(pad, barY, barW * longPct, barH);
          ctx.fillStyle = 'rgba(255,90,74,0.55)'; ctx.fillRect(pad + barW * longPct, barY, barW * shortPct, barH);

          ctx.font = '13px Inter,sans-serif'; ctx.textBaseline = 'middle';
          ctx.fillStyle = '#46c05a'; ctx.textAlign = 'left';
          ctx.fillText('Longs: $' + fmtB(d.h24.longUsd) + ' (' + (longPct * 100).toFixed(1) + '%)', pad + 8, barY + barH / 2);
          ctx.fillStyle = '#ff5a4a'; ctx.textAlign = 'right';
          ctx.fillText('Shorts: $' + fmtB(d.h24.shortUsd) + ' (' + (shortPct * 100).toFixed(1) + '%)', w - pad - 8, barY + barH / 2);

          ctx.font = '11px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#8a8ab0';
          ctx.fillText('24h Total Liquidations: $' + fmtB(d.h24.total), w / 2, barY - 16);
          ctx.fillText('Source: ' + (d.source || 'OKX'), w / 2, barY + barH + 18);
        }
      }

      // Recent liquidations list
      const list = $('liqRecent');
      if (list && d.recent.length) {
        list.innerHTML = d.recent.slice(0, 20).map(l => {
          const isLong = l.side === 'sell';
          return '<div class="liq-row"><span class="liq-time">' + shortDT(l.t) + '</span>' +
            '<span class="liq-inst">' + l.inst.replace('-USDT-SWAP', '') + '</span>' +
            '<span class="liq-side ' + (isLong ? 'long' : 'short') + '">' + (isLong ? 'LONG' : 'SHORT') + '</span>' +
            '<span class="liq-val">$' + fmtK(l.usd) + '</span>' +
            '<span class="liq-price">' + fmtPrice(l.price) + '</span></div>';
        }).join('');
      }

      if (badge) badge.textContent = '24h Liquidations: $' + fmtB(d.h24.total) + ' (Longs $' + fmtB(d.h24.longUsd) + ' / Shorts $' + fmtB(d.h24.shortUsd) + ')';
    } catch (e) { if (badge) badge.textContent = 'Liquidation data unavailable'; }
  }

  // ════════════════════════════════════════
  // 6. MARKET OVERVIEW — dominance + stablecoins
  // ════════════════════════════════════════
  async function drawOverview() {
    const badge = $('overviewBadge'); if (badge) badge.textContent = 'Loading...';
    try {
      const d = await load('/api/markets/overview');
      const grid = $('overviewGrid');
      if (grid) {
        const change = d.mcapChange24h;
        const changeColor = change >= 0 ? '#46c05a' : '#ff5a4a';
        const changeIcon = change >= 0 ? '▲' : '▼';
        grid.innerHTML =
          '<div class="ov-card"><div class="ov-val">' + d.btcDom.toFixed(1) + '%</div><div class="ov-label">BTC Dominance</div></div>' +
          '<div class="ov-card"><div class="ov-val">' + d.ethDom.toFixed(1) + '%</div><div class="ov-label">ETH Dominance</div></div>' +
          '<div class="ov-card"><div class="ov-val">$' + fmtB(d.totalMcap) + '</div><div class="ov-label">Total Market Cap</div>' +
            '<div class="ov-change" style="color:' + changeColor + '">' + changeIcon + ' ' + Math.abs(change).toFixed(2) + '% (24h)</div></div>' +
          '<div class="ov-card"><div class="ov-val">$' + fmtB(d.totalVol) + '</div><div class="ov-label">24h Volume</div></div>' +
          '<div class="ov-card"><div class="ov-val">$' + fmtB(d.stableMcap) + '</div><div class="ov-label">Stablecoin Supply</div></div>' +
          '<div class="ov-card"><div class="ov-val">' + (d.activeCryptos || 0).toLocaleString() + '</div><div class="ov-label">Active Cryptocurrencies</div></div>';
      }
      if (badge) badge.textContent = 'BTC Dominance: ' + d.btcDom.toFixed(1) + '% · Total Mcap: $' + fmtB(d.totalMcap) + ' · Stablecoin Supply: $' + fmtB(d.stableMcap);
    } catch (e) { if (badge) badge.textContent = 'Market overview data unavailable'; }
  }

  // ════════════════════════════════════════
  // 7. OPTIONS MAX PAIN + OI BY STRIKE (Deribit)
  // ════════════════════════════════════════
  async function drawOptions() {
    const badge = $('optionsBadge'); if (badge) badge.textContent = 'Loading...';
    try {
      const d = await load('/api/markets/options');
      if (!d.strikes || !d.strikes.length) throw new Error('no data');

      // OI by strike chart
      const cv = $('optionsCanvas');
      if (cv) {
        const s = setup(cv); if (s) {
          const { ctx, w, h } = s;
          const strikes = d.strikes;
          const pad = { l: 56, r: 14, t: 14, b: 40 }, pW = w - pad.l - pad.r, pH = h - pad.t - pad.b;
          const midY = pad.t + pH / 2;

          let maxOI = 0; for (const s2 of strikes) { if (s2.callOI > maxOI) maxOI = s2.callOI; if (s2.putOI > maxOI) maxOI = s2.putOI; }
          maxOI *= 1.1;

          const barW = Math.max(2, Math.min(16, pW / strikes.length * 0.7));
          const mapX = i => pad.l + (i + 0.5) / strikes.length * pW;
          const mapCallY = oi => midY - (oi / maxOI) * (pH / 2 - 4);
          const mapPutY = oi => midY + (oi / maxOI) * (pH / 2 - 4);

          // zero line
          ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.moveTo(pad.l, midY); ctx.lineTo(w - pad.r, midY); ctx.stroke();

          // bars
          strikes.forEach((st, i) => {
            const x = mapX(i) - barW / 2;
            if (st.callOI) { ctx.fillStyle = 'rgba(70,192,90,0.6)'; ctx.fillRect(x, mapCallY(st.callOI), barW, midY - mapCallY(st.callOI)); }
            if (st.putOI) { ctx.fillStyle = 'rgba(255,90,74,0.6)'; ctx.fillRect(x, midY, barW, mapPutY(st.putOI) - midY); }
          });

          // current price line
          if (d.currentPrice) {
            const cpIdx = strikes.findIndex(s2 => s2.strike >= d.currentPrice);
            if (cpIdx >= 0) {
              const x = mapX(Math.max(0, cpIdx - 0.5));
              ctx.setLineDash([4, 3]); ctx.strokeStyle = '#c9a84c'; ctx.lineWidth = 1.4;
              ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
              ctx.setLineDash([]); ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#c9a84c';
              ctx.fillText('Spot: ' + fmtPrice(d.currentPrice), x, pad.t - 2);
            }
          }

          // max pain line
          if (d.maxPain) {
            const mpIdx = strikes.findIndex(s2 => s2.strike >= d.maxPain);
            if (mpIdx >= 0) {
              const x = mapX(Math.max(0, mpIdx - 0.5));
              ctx.setLineDash([6, 4]); ctx.strokeStyle = '#e8552b'; ctx.lineWidth = 1.4;
              ctx.beginPath(); ctx.moveTo(x, pad.t + 12); ctx.lineTo(x, h - pad.b); ctx.stroke();
              ctx.setLineDash([]); ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#e8552b';
              ctx.fillText('Max Pain: ' + fmtPrice(d.maxPain), x, pad.t + 10);
            }
          }

          // strike labels (show every Nth)
          ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#63637f';
          const skip = Math.max(1, Math.ceil(strikes.length / 20));
          strikes.forEach((st, i) => { if (i % skip === 0) { ctx.save(); ctx.translate(mapX(i), h - pad.b + 4); ctx.rotate(Math.PI / 4); ctx.fillText('$' + fmtK(st.strike), 0, 0); ctx.restore(); } });

          // y-axis labels
          ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
          ctx.fillStyle = '#46c05a'; ctx.fillText('Calls ▲', pad.l - 6, pad.t + pH / 4);
          ctx.fillStyle = '#ff5a4a'; ctx.fillText('Puts ▼', pad.l - 6, pad.t + pH * 3 / 4);
        }
      }

      // Expiry summary
      const expList = $('optionsExpiries');
      if (expList && d.expiries.length) {
        expList.innerHTML = d.expiries.map(e => {
          const pcr = e.callOI > 0 ? (e.putOI / e.callOI).toFixed(2) : '—';
          return '<div class="opt-exp-row"><span class="opt-exp-date">' + e.expiry + '</span>' +
            '<span class="opt-exp-oi">' + fmtK(e.totalOI) + ' OI</span>' +
            '<span style="color:#46c05a">' + fmtK(e.callOI) + ' C</span>' +
            '<span style="color:#ff5a4a">' + fmtK(e.putOI) + ' P</span>' +
            '<span class="opt-exp-pcr">P/C ' + pcr + '</span></div>';
        }).join('');
      }

      if (badge) badge.textContent = 'Max Pain: ' + fmtPrice(d.maxPain) + ' · P/C Ratio: ' + (d.pcRatio || '—') +
        ' · Calls: ' + fmtK(d.callOI) + ' · Puts: ' + fmtK(d.putOI) + ' · Expiry: ' + d.nearestExpiry;
    } catch (e) { if (badge) badge.textContent = 'Options data unavailable'; }
  }

  // ════════════════════════════════════════
  // Hook into chart picker (runs after main charts IIFE)
  // ════════════════════════════════════════
  const drawFns = { oi: drawOI, funding: drawFunding, lsratio: drawLSRatio, taker: drawTaker, liquidations: drawLiquidations, overview: drawOverview, options: drawOptions };

  document.querySelectorAll('.chart-pick').forEach(p => {
    if (drawFns[p.dataset.chart]) {
      p.addEventListener('click', () => drawFns[p.dataset.chart]());
    }
  });

  // Symbol/view selectors
  const symChange = { oiSymbol: drawOI, lsSymbol: drawLSRatio, takerSymbol: drawTaker };
  for (const [id, fn] of Object.entries(symChange)) { const el = $(id); if (el) el.onchange = fn; }
  const lsView = $('lsView'); if (lsView) lsView.onchange = drawLSRatio;

  // Resize
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const active = document.querySelector('.chart-pick.active');
      if (active && drawFns[active.dataset.chart]) drawFns[active.dataset.chart]();
    }, 200);
  });

  window.LegionDerivatives = drawFns;
})();
