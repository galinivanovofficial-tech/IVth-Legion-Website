// ═══════════════════════════════════════════════════════════════════
//  IVth Legion — BTC Institutional Chart
//  Candlestick chart with Volume Profile, POC, Key Levels, Period Zones
//  Zero dependencies — Binance public API + Canvas
// ═══════════════════════════════════════════════════════════════════

window.LegionChart = (function () {
  'use strict';

  const GOLD   = '#c9a84c';
  const GOLD2  = '#e8c96a';
  const GREEN  = '#26a65b';
  const RED    = '#e74c3c';
  const BG     = '#07070d';
  const BG2    = '#0d0d18';
  const GRID   = 'rgba(255,255,255,0.04)';
  const TEXT   = 'rgba(255,255,255,0.35)';
  const TEXT_BR = 'rgba(255,255,255,0.7)';

  // ── State ──
  let candles = [];       // {t, o, h, l, c, v}
  let dailyCandles = [];  // for levels/zones
  let weeklyCandles = []; // computed from daily
  let monthlyCandles = [];

  let canvas, ctx, dpr;
  let W, H;
  let chartLeft = 70, chartRight = 60, chartTop = 10, chartBottom = 30;
  let vpWidth = 80; // volume profile width
  let priceMin, priceMax, timeMin, timeMax;

  // Overlays toggle state
  let overlays = {
    levels_daily: true,
    levels_weekly: true,
    levels_monthly: false,
    zones_daily: true,
    zones_weekly: false,
    zones_monthly: false,
    volume_profile: true,
    poc: true,
  };

  // Scroll/zoom
  let visibleBars = 200;
  let scrollOffset = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartOffset = 0;

  // Crosshair
  let mouseX = -1, mouseY = -1;
  let showCrosshair = false;

  // ── Data Fetch ──
  async function fetchCandles(interval, limit) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.map(d => ({
      t: d[0],
      o: parseFloat(d[1]),
      h: parseFloat(d[2]),
      l: parseFloat(d[3]),
      c: parseFloat(d[4]),
      v: parseFloat(d[5]),
    }));
  }

  async function loadData() {
    const [h1, d1] = await Promise.all([
      fetchCandles('1h', 500),
      fetchCandles('1d', 90),
    ]);
    candles = h1;
    dailyCandles = d1;
    weeklyCandles = aggregateCandles(d1, 'week');
    monthlyCandles = aggregateCandles(d1, 'month');
    visibleBars = Math.min(200, candles.length);
    scrollOffset = 0;
    render();
  }

  function aggregateCandles(daily, period) {
    const groups = {};
    daily.forEach(c => {
      const d = new Date(c.t);
      let key;
      if (period === 'week') {
        const jan1 = new Date(d.getFullYear(), 0, 1);
        const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
        key = d.getFullYear() + '-W' + week;
      } else {
        key = d.getFullYear() + '-' + (d.getMonth() + 1);
      }
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    });
    return Object.values(groups).map(arr => ({
      t: arr[0].t,
      o: arr[0].o,
      h: Math.max(...arr.map(c => c.h)),
      l: Math.min(...arr.map(c => c.l)),
      c: arr[arr.length - 1].c,
      v: arr.reduce((s, c) => s + c.v, 0),
    }));
  }

  // ── Volume Profile ──
  function calcVolumeProfile(visCandles, bins) {
    if (!visCandles.length) return { levels: [], poc: 0 };
    const lo = Math.min(...visCandles.map(c => c.l));
    const hi = Math.max(...visCandles.map(c => c.h));
    const step = (hi - lo) / bins;
    if (step <= 0) return { levels: [], poc: (hi + lo) / 2 };

    const levels = Array.from({ length: bins }, (_, i) => ({
      price: lo + step * i + step / 2,
      vol: 0,
      buyVol: 0,
    }));

    visCandles.forEach(c => {
      const bull = c.c >= c.o;
      const range = c.h - c.l || 1;
      for (let i = 0; i < bins; i++) {
        const pLo = lo + step * i;
        const pHi = pLo + step;
        const overlap = Math.max(0, Math.min(c.h, pHi) - Math.max(c.l, pLo));
        const share = overlap / range;
        const vol = c.v * share;
        levels[i].vol += vol;
        if (bull) levels[i].buyVol += vol;
      }
    });

    let maxVol = 0, pocIdx = 0;
    levels.forEach((l, i) => { if (l.vol > maxVol) { maxVol = l.vol; pocIdx = i; } });

    return { levels, poc: levels[pocIdx]?.price || 0, maxVol };
  }

  // ── Key Levels (previous period close/high/low) ──
  function getKeyLevels() {
    const levels = [];
    const now = Date.now();

    // Find previous completed period
    function prevPeriod(arr, label, colors) {
      if (arr.length < 2) return;
      const prev = arr[arr.length - 2]; // second to last = previous completed
      levels.push({ price: prev.c, label: label + ' Close', color: colors[0], dash: [6, 4] });
      levels.push({ price: prev.h, label: label + ' High', color: colors[1], dash: [3, 3] });
      levels.push({ price: prev.l, label: label + ' Low', color: colors[2], dash: [3, 3] });
    }

    if (overlays.levels_daily) prevPeriod(dailyCandles, 'D', ['#5b9bd5', '#5b9bd5', '#5b9bd5']);
    if (overlays.levels_weekly) prevPeriod(weeklyCandles, 'W', ['#c678dd', '#c678dd', '#c678dd']);
    if (overlays.levels_monthly) prevPeriod(monthlyCandles, 'M', ['#e5c07b', '#e5c07b', '#e5c07b']);

    return levels;
  }

  // ── Period Zones (previous period range as shaded rectangle) ──
  function getPeriodZones() {
    const zones = [];

    function addZone(arr, label, color) {
      if (arr.length < 2) return;
      const prev = arr[arr.length - 2];
      zones.push({ high: prev.h, low: prev.l, label: 'Prev ' + label, color });
    }

    if (overlays.zones_daily) addZone(dailyCandles, 'Day', 'rgba(91,155,213,0.06)');
    if (overlays.zones_weekly) addZone(weeklyCandles, 'Week', 'rgba(198,120,221,0.06)');
    if (overlays.zones_monthly) addZone(monthlyCandles, 'Month', 'rgba(229,192,123,0.06)');

    return zones;
  }

  // ── Coordinate Mapping ──
  function priceToY(p) {
    const plotH = H - chartTop - chartBottom;
    return chartTop + plotH * (1 - (p - priceMin) / (priceMax - priceMin));
  }
  function yToPrice(y) {
    const plotH = H - chartTop - chartBottom;
    return priceMin + (1 - (y - chartTop) / plotH) * (priceMax - priceMin);
  }
  function barToX(i) {
    const plotW = W - chartLeft - chartRight - (overlays.volume_profile ? vpWidth : 0);
    const startIdx = candles.length - visibleBars - scrollOffset;
    return chartLeft + ((i - startIdx) + 0.5) * (plotW / visibleBars);
  }

  // ── Render ──
  function render() {
    if (!canvas || !candles.length) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    W = rect.width;
    H = rect.height;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const startIdx = Math.max(0, candles.length - visibleBars - scrollOffset);
    const endIdx = Math.min(candles.length, startIdx + visibleBars);
    const vis = candles.slice(startIdx, endIdx);

    if (!vis.length) return;

    // Price range with padding
    const rawMin = Math.min(...vis.map(c => c.l));
    const rawMax = Math.max(...vis.map(c => c.h));
    const pad = (rawMax - rawMin) * 0.06;
    priceMin = rawMin - pad;
    priceMax = rawMax + pad;
    timeMin = vis[0].t;
    timeMax = vis[vis.length - 1].t;

    // Clear
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const plotW = W - chartLeft - chartRight - (overlays.volume_profile ? vpWidth : 0);
    const plotH = H - chartTop - chartBottom;
    const barW = plotW / visibleBars;
    const candleW = Math.max(1, barW * 0.6);

    // Grid
    drawGrid(plotW, plotH);

    // Period zones (behind candles)
    getPeriodZones().forEach(z => {
      const y1 = priceToY(z.high);
      const y2 = priceToY(z.low);
      ctx.fillStyle = z.color;
      ctx.fillRect(chartLeft, y1, plotW, y2 - y1);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.font = '9px Inter, sans-serif';
      ctx.fillText(z.label, chartLeft + 6, y1 + 12);
    });

    // Key Levels
    getKeyLevels().forEach(lv => {
      const y = priceToY(lv.price);
      if (y < chartTop || y > H - chartBottom) return;
      ctx.beginPath();
      ctx.setLineDash(lv.dash);
      ctx.strokeStyle = lv.color;
      ctx.lineWidth = 0.8;
      ctx.moveTo(chartLeft, y);
      ctx.lineTo(chartLeft + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label on right
      ctx.fillStyle = lv.color;
      ctx.font = '9px Inter, sans-serif';
      ctx.textAlign = 'left';
      const labelX = chartLeft + plotW + (overlays.volume_profile ? vpWidth : 0) + 4;
      ctx.fillText(lv.label, labelX, y + 3);

      // Price on left axis
      ctx.textAlign = 'right';
      ctx.fillText(fmtPrice(lv.price), chartLeft - 6, y + 3);
    });

    // Candlesticks + volume bars
    const maxVol = Math.max(...vis.map(c => c.v));
    const volH = plotH * 0.12;

    vis.forEach((c, i) => {
      const gi = startIdx + i; // global index
      const x = barToX(gi);
      const bull = c.c >= c.o;
      const color = bull ? GREEN : RED;

      // Volume bar (bottom)
      const vh = (c.v / maxVol) * volH;
      ctx.fillStyle = bull ? 'rgba(38,166,91,0.15)' : 'rgba(231,76,60,0.15)';
      ctx.fillRect(x - candleW / 2, H - chartBottom - vh, candleW, vh);

      // Wick
      const highY = priceToY(c.h);
      const lowY = priceToY(c.l);
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.moveTo(x, highY);
      ctx.lineTo(x, lowY);
      ctx.stroke();

      // Body
      const openY = priceToY(c.o);
      const closeY = priceToY(c.c);
      const bodyH = Math.max(1, Math.abs(closeY - openY));
      ctx.fillStyle = color;
      if (bull) {
        ctx.fillRect(x - candleW / 2, closeY, candleW, bodyH);
      } else {
        ctx.fillRect(x - candleW / 2, openY, candleW, bodyH);
      }
    });

    // Volume Profile
    if (overlays.volume_profile || overlays.poc) {
      const vp = calcVolumeProfile(vis, 60);
      const vpX = chartLeft + plotW;

      if (overlays.volume_profile && vp.maxVol > 0) {
        vp.levels.forEach(lv => {
          const y = priceToY(lv.price);
          const w = (lv.vol / vp.maxVol) * vpWidth * 0.9;
          const buyW = (lv.buyVol / vp.maxVol) * vpWidth * 0.9;
          // Sell volume
          ctx.fillStyle = 'rgba(231,76,60,0.25)';
          ctx.fillRect(vpX, y - plotH / 120, w, plotH / 60);
          // Buy volume on top
          ctx.fillStyle = 'rgba(38,166,91,0.35)';
          ctx.fillRect(vpX, y - plotH / 120, buyW, plotH / 60);
        });
      }

      // POC line
      if (overlays.poc && vp.poc) {
        const pocY = priceToY(vp.poc);
        ctx.beginPath();
        ctx.setLineDash([8, 4]);
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 1.2;
        ctx.moveTo(chartLeft, pocY);
        ctx.lineTo(chartLeft + plotW + (overlays.volume_profile ? vpWidth : 0), pocY);
        ctx.stroke();
        ctx.setLineDash([]);

        // POC label
        ctx.fillStyle = BG2;
        const pocLabel = 'POC ' + fmtPrice(vp.poc);
        const tw = ctx.measureText(pocLabel).width + 12;
        ctx.fillRect(chartLeft + plotW + (overlays.volume_profile ? vpWidth : 0) + 2, pocY - 8, tw, 16);
        ctx.fillStyle = GOLD;
        ctx.font = 'bold 9px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(pocLabel, chartLeft + plotW + (overlays.volume_profile ? vpWidth : 0) + 8, pocY + 3);
      }
    }

    // Right price axis
    drawPriceAxis(plotW);

    // Time axis
    drawTimeAxis(vis, startIdx, plotW, barW);

    // Crosshair
    if (showCrosshair && mouseX > chartLeft && mouseX < chartLeft + plotW && mouseY > chartTop && mouseY < H - chartBottom) {
      drawCrosshair(vis, startIdx, plotW, barW);
    }

    // Current price line
    const lastC = vis[vis.length - 1];
    if (lastC) {
      const cpY = priceToY(lastC.c);
      const cpColor = lastC.c >= lastC.o ? GREEN : RED;
      ctx.beginPath();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = cpColor;
      ctx.lineWidth = 0.8;
      ctx.moveTo(chartLeft, cpY);
      ctx.lineTo(chartLeft + plotW + (overlays.volume_profile ? vpWidth : 0), cpY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Price tag
      ctx.fillStyle = cpColor;
      const pTag = fmtPrice(lastC.c);
      const ptw = ctx.measureText(pTag).width + 14;
      ctx.fillRect(W - chartRight - ptw + (overlays.volume_profile ? 0 : vpWidth), cpY - 9, ptw, 18);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(pTag, W - chartRight + (overlays.volume_profile ? 0 : vpWidth) - 4, cpY + 4);
    }
  }

  function drawGrid(plotW, plotH) {
    const range = priceMax - priceMin;
    const step = niceStep(range, 8);
    const start = Math.ceil(priceMin / step) * step;

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 0.5;
    ctx.font = '10px Inter, sans-serif';
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'right';

    for (let p = start; p <= priceMax; p += step) {
      const y = priceToY(p);
      ctx.beginPath();
      ctx.moveTo(chartLeft, y);
      ctx.lineTo(chartLeft + plotW + (overlays.volume_profile ? vpWidth : 0), y);
      ctx.stroke();
    }
  }

  function drawPriceAxis(plotW) {
    const range = priceMax - priceMin;
    const step = niceStep(range, 8);
    const start = Math.ceil(priceMin / step) * step;

    ctx.font = '10px Inter, sans-serif';
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'right';

    for (let p = start; p <= priceMax; p += step) {
      const y = priceToY(p);
      ctx.fillText(fmtPrice(p), chartLeft - 8, y + 3);
    }
  }

  function drawTimeAxis(vis, startIdx, plotW, barW) {
    ctx.font = '9px Inter, sans-serif';
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'center';

    const skip = Math.max(1, Math.floor(40 / barW));
    vis.forEach((c, i) => {
      if (i % skip !== 0) return;
      const x = barToX(startIdx + i);
      const d = new Date(c.t);
      const h = d.getUTCHours();
      let label;
      if (h === 0) {
        label = (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
      } else {
        label = String(h).padStart(2, '0') + ':00';
      }
      ctx.fillText(label, x, H - chartBottom + 16);
    });
  }

  function drawCrosshair(vis, startIdx, plotW, barW) {
    const price = yToPrice(mouseY);

    // Horizontal line
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 0.5;
    ctx.moveTo(chartLeft, mouseY);
    ctx.lineTo(chartLeft + plotW + (overlays.volume_profile ? vpWidth : 0), mouseY);
    ctx.stroke();

    // Vertical line
    ctx.moveTo(mouseX, chartTop);
    ctx.lineTo(mouseX, H - chartBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // Price label
    ctx.fillStyle = '#1a1a2e';
    const priceStr = fmtPrice(price);
    const tw = ctx.measureText(priceStr).width + 10;
    ctx.fillRect(2, mouseY - 8, chartLeft - 6, 16);
    ctx.fillStyle = TEXT_BR;
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(priceStr, chartLeft - 8, mouseY + 3);

    // Find closest candle
    const closestIdx = Math.round((mouseX - chartLeft) / barW - 0.5) + startIdx;
    if (closestIdx >= 0 && closestIdx < candles.length) {
      const c = candles[closestIdx];
      drawOHLCTooltip(c);
    }
  }

  function drawOHLCTooltip(c) {
    const d = new Date(c.t);
    const dateStr = d.toUTCString().slice(0, 16);
    const bull = c.c >= c.o;

    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'left';
    const x = chartLeft + 8;
    const y = chartTop + 14;

    const items = [
      { l: dateStr, c: TEXT },
      { l: 'O ' + fmtPrice(c.o), c: TEXT_BR },
      { l: 'H ' + fmtPrice(c.h), c: TEXT_BR },
      { l: 'L ' + fmtPrice(c.l), c: TEXT_BR },
      { l: 'C ' + fmtPrice(c.c), c: bull ? GREEN : RED },
      { l: 'Vol ' + fmtVol(c.v), c: TEXT },
    ];

    let xOff = x;
    items.forEach(item => {
      ctx.fillStyle = item.c;
      ctx.fillText(item.l, xOff, y);
      xOff += ctx.measureText(item.l).width + 14;
    });
  }

  // ── Helpers ──
  function fmtPrice(p) {
    return p >= 1000 ? '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '$' + p.toFixed(2);
  }
  function fmtVol(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(0);
  }
  function niceStep(range, maxTicks) {
    const rough = range / maxTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if (norm <= 1.5) step = 1;
    else if (norm <= 3) step = 2;
    else if (norm <= 7) step = 5;
    else step = 10;
    return step * mag;
  }

  // ── Interaction ──
  function setupEvents() {
    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
      showCrosshair = true;

      if (isDragging) {
        const dx = e.clientX - dragStartX;
        const plotW = W - chartLeft - chartRight - (overlays.volume_profile ? vpWidth : 0);
        const barW = plotW / visibleBars;
        const barDelta = Math.round(dx / barW);
        scrollOffset = Math.max(0, Math.min(candles.length - visibleBars, dragStartOffset + barDelta));
      }

      render();
    });

    canvas.addEventListener('mouseleave', () => {
      showCrosshair = false;
      isDragging = false;
      render();
    });

    canvas.addEventListener('mousedown', e => {
      isDragging = true;
      dragStartX = e.clientX;
      dragStartOffset = scrollOffset;
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('mouseup', () => {
      isDragging = false;
      canvas.style.cursor = 'crosshair';
    });

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const zoomSpeed = Math.max(1, Math.round(visibleBars * 0.05));
      if (e.deltaY > 0) {
        visibleBars = Math.min(candles.length, visibleBars + zoomSpeed);
      } else {
        visibleBars = Math.max(20, visibleBars - zoomSpeed);
      }
      scrollOffset = Math.max(0, Math.min(candles.length - visibleBars, scrollOffset));
      render();
    }, { passive: false });

    window.addEventListener('resize', () => render());
  }

  // ── Toggle Panel ──
  function buildControls(container) {
    const panel = document.createElement('div');
    panel.className = 'chart-controls';
    panel.innerHTML = `
      <div class="ctrl-group">
        <div class="ctrl-title">LEVELS</div>
        <label class="ctrl-toggle"><input type="checkbox" data-key="levels_daily" ${overlays.levels_daily ? 'checked' : ''}><span class="ctrl-dot" style="background:#5b9bd5"></span> Daily Levels</label>
        <label class="ctrl-toggle"><input type="checkbox" data-key="levels_weekly" ${overlays.levels_weekly ? 'checked' : ''}><span class="ctrl-dot" style="background:#c678dd"></span> Weekly Levels</label>
        <label class="ctrl-toggle"><input type="checkbox" data-key="levels_monthly" ${overlays.levels_monthly ? 'checked' : ''}><span class="ctrl-dot" style="background:#e5c07b"></span> Monthly Levels</label>
      </div>
      <div class="ctrl-group">
        <div class="ctrl-title">PERIOD ZONES</div>
        <label class="ctrl-toggle"><input type="checkbox" data-key="zones_daily" ${overlays.zones_daily ? 'checked' : ''}><span class="ctrl-dot" style="background:#5b9bd5"></span> Daily Range</label>
        <label class="ctrl-toggle"><input type="checkbox" data-key="zones_weekly" ${overlays.zones_weekly ? 'checked' : ''}><span class="ctrl-dot" style="background:#c678dd"></span> Weekly Range</label>
        <label class="ctrl-toggle"><input type="checkbox" data-key="zones_monthly" ${overlays.zones_monthly ? 'checked' : ''}><span class="ctrl-dot" style="background:#e5c07b"></span> Monthly Range</label>
      </div>
      <div class="ctrl-group">
        <div class="ctrl-title">VOLUME</div>
        <label class="ctrl-toggle"><input type="checkbox" data-key="volume_profile" ${overlays.volume_profile ? 'checked' : ''}><span class="ctrl-dot" style="background:${GREEN}"></span> Volume Profile</label>
        <label class="ctrl-toggle"><input type="checkbox" data-key="poc" ${overlays.poc ? 'checked' : ''}><span class="ctrl-dot" style="background:${GOLD}"></span> Point of Control</label>
      </div>
    `;

    panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        overlays[cb.dataset.key] = cb.checked;
        render();
      });
    });

    container.appendChild(panel);
  }

  // ── Public Init ──
  function init(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    // Chart wrapper
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:100%;height:500px;';

    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;cursor:crosshair;';
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    ctx = canvas.getContext('2d');
    dpr = window.devicePixelRatio || 1;

    // Controls panel
    buildControls(container);

    setupEvents();

    // Loading state
    ctx.font = '13px Inter, sans-serif';
    ctx.fillStyle = TEXT;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = GOLD;
    ctx.textAlign = 'center';
    ctx.fillText('Loading BTC data…', rect.width / 2, rect.height / 2);

    // Re-render when container becomes visible or resizes
    new ResizeObserver(() => render()).observe(wrap);

    loadData();
  }

  return { init, render };
})();
