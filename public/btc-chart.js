// ═══════════════════════════════════════════════════════════════════
//  IVth Legion — BTC Institutional Chart v4
//  EMAs, VWAP, Volume Profile, POC, Key Levels, Period Zones, SVP
// ═══════════════════════════════════════════════════════════════════

window.LegionChart = (function () {
  'use strict';

  var C = {
    bg:         '#131722',
    bgPanel:    '#1e222d',
    bgToolbar:  '#1c2030',
    grid:       'rgba(42,46,57,0.40)',
    gridFine:   'rgba(42,46,57,0.18)',
    border:     '#2a2e39',
    text:       '#787b86',
    textBright: '#d1d4dc',
    textWhite:  '#e0e3eb',
    bull:       '#26a69a',
    bear:       '#ef5350',
    bullVol:    'rgba(38,166,154,0.22)',
    bearVol:    'rgba(239,83,80,0.22)',
    gold:       '#c9a84c',
    goldDim:    'rgba(201,168,76,0.25)',
    lvlD:       '#2962ff',
    lvlW:       '#ab47bc',
    lvlM:       '#ff9800',
    zoneD:      'rgba(41,98,255,0.06)',
    zoneW:      'rgba(171,71,188,0.06)',
    zoneM:      'rgba(255,152,0,0.06)',
    zoneBD:     'rgba(41,98,255,0.20)',
    zoneBW:     'rgba(171,71,188,0.20)',
    zoneBM:     'rgba(255,152,0,0.20)',
    cross:      'rgba(120,123,134,0.5)',
    vpBuy:      'rgba(38,166,154,0.45)',
    vpSell:     'rgba(239,83,80,0.35)',
    vpVA:       'rgba(38,166,154,0.12)',
    activeTF:   '#2962ff',
    svpAsia:    'rgba(255,193,7,0.10)',
    svpEU:      'rgba(33,150,243,0.10)',
    svpUS:      'rgba(76,175,80,0.10)',
    svpAsiaBdr: 'rgba(255,193,7,0.28)',
    svpEUBdr:   'rgba(33,150,243,0.28)',
    svpUSBdr:   'rgba(76,175,80,0.28)',
    watermark:  'rgba(42,46,57,0.30)',
    ema21:      '#f7c948',
    ema50:      '#42a5f5',
    ema200:     '#ef5350',
    vwap:       '#ab47bc',
  };

  var TIMEFRAMES = [
    { label: '5m',  binance: '5m',  limit: 500 },
    { label: '15m', binance: '15m', limit: 500 },
    { label: '1H',  binance: '1h',  limit: 500 },
    { label: '4H',  binance: '4h',  limit: 500 },
    { label: '1D',  binance: '1d',  limit: 365 },
    { label: '1W',  binance: '1w',  limit: 200 },
  ];

  var SESSIONS = [
    { name:'Asia',   h0:0,  h1:8,  color:C.svpAsia,  border:C.svpAsiaBdr },
    { name:'London', h0:8,  h1:16, color:C.svpEU,    border:C.svpEUBdr   },
    { name:'NY',     h0:16, h1:24, color:C.svpUS,    border:C.svpUSBdr   },
  ];

  var candles = [];
  var dailyCandles = [];
  var weeklyCandles = [];
  var monthlyCandles = [];
  var currentTF = 2;

  var canvas, ctx, dpr, containerEl;
  var W, H;
  var chartLeft = 0, chartRight = 78, chartTop = 0, chartBottom = 24;
  var vpWidth = 92;
  var priceMin, priceMax;

  var overlays = {
    levels_daily: true,
    levels_weekly: true,
    levels_monthly: true,
    zones_daily: true,
    zones_weekly: false,
    zones_monthly: false,
    volume_profile: true,
    poc: true,
    svp: false,
    ema21: true,
    ema50: true,
    ema200: false,
    vwap: false,
  };

  var visibleBars = 150;
  var scrollOffset = 0;
  var isDragging = false;
  var dragStartX = 0;
  var dragStartOffset = 0;
  var mouseX = -1, mouseY = -1;
  var showCrosshair = false;
  var lastRefresh = 0;
  var pulsePhase = 0;
  var animFrame = 0;

  // ── Data ──
  function fetchKlines(interval, limit) {
    return fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval='+interval+'&limit='+limit)
      .then(function(r){ return r.json(); })
      .then(function(data){ return data.map(function(d){return{t:d[0],o:+d[1],h:+d[2],l:+d[3],c:+d[4],v:+d[5]};});});
  }

  function loadData() {
    var tf = TIMEFRAMES[currentTF];
    return Promise.all([fetchKlines(tf.binance, tf.limit), fetchKlines('1d', 90)])
      .then(function(res) {
        candles = res[0];
        dailyCandles = res[1];
        weeklyCandles = aggregate(res[1], 'week');
        monthlyCandles = aggregate(res[1], 'month');
        computeIndicators();
        visibleBars = Math.min(150, candles.length);
        scrollOffset = 0;
        lastRefresh = Date.now();
        render();
        updateOHLC(candles[candles.length - 1]);
      });
  }

  function aggregate(daily, period) {
    var g = {};
    daily.forEach(function(c) {
      var d = new Date(c.t);
      var k = period === 'week'
        ? d.getFullYear()+'-W'+Math.ceil(((d - new Date(d.getFullYear(),0,1))/864e5 + new Date(d.getFullYear(),0,1).getDay()+1)/7)
        : d.getFullYear()+'-'+d.getMonth();
      (g[k] = g[k] || []).push(c);
    });
    return Object.values(g).map(function(a) {
      return {
        t:a[0].t, o:a[0].o,
        h:Math.max.apply(null,a.map(function(c){return c.h;})),
        l:Math.min.apply(null,a.map(function(c){return c.l;})),
        c:a[a.length-1].c,
        v:a.reduce(function(s,c){return s+c.v;},0),
      };
    });
  }

  // ── Indicators ──
  function computeIndicators() {
    calcEMA(21); calcEMA(50); calcEMA(200);
    calcVWAP();
  }

  function calcEMA(len) {
    var k = 2 / (len + 1);
    var prev = candles.length > 0 ? candles[0].c : 0;
    candles.forEach(function(c) {
      prev = c.c * k + prev * (1 - k);
      c['ema' + len] = prev;
    });
  }

  function calcVWAP() {
    var cumVol = 0, cumTP = 0;
    var lastDay = -1;
    candles.forEach(function(c) {
      var d = new Date(c.t);
      var day = d.getUTCFullYear() * 1000 + d.getUTCMonth() * 32 + d.getUTCDate();
      if (day !== lastDay) { cumVol = 0; cumTP = 0; lastDay = day; }
      var tp = (c.h + c.l + c.c) / 3;
      cumVol += c.v;
      cumTP += tp * c.v;
      c.vwap = cumVol > 0 ? cumTP / cumVol : tp;
    });
  }

  // ── Volume Profile ──
  function calcVP(vis, bins) {
    if (!vis.length) return { levels:[], poc:0, maxVol:0, vaH:0, vaL:0 };
    var lo = Infinity, hi = -Infinity;
    vis.forEach(function(c){ if(c.l<lo)lo=c.l; if(c.h>hi)hi=c.h; });
    var step = (hi-lo)/bins;
    if (step <= 0) return { levels:[], poc:(hi+lo)/2, maxVol:0, vaH:0, vaL:0 };
    var levels = [];
    for (var i = 0; i < bins; i++) levels.push({price:lo+step*i+step/2, vol:0, buyVol:0});
    vis.forEach(function(c) {
      var bull = c.c >= c.o;
      var range = c.h - c.l || 1;
      for (var i = 0; i < bins; i++) {
        var overlap = Math.max(0, Math.min(c.h, lo+step*(i+1)) - Math.max(c.l, lo+step*i));
        var vol = c.v * (overlap/range);
        levels[i].vol += vol;
        if (bull) levels[i].buyVol += vol;
      }
    });
    var maxVol = 0, pocIdx = 0, totalVol = 0;
    levels.forEach(function(l,i){ if(l.vol>maxVol){maxVol=l.vol;pocIdx=i;} totalVol+=l.vol; });
    // Value Area (70%)
    var vaTarget = totalVol * 0.7;
    var vaVol = levels[pocIdx].vol;
    var vaLo = pocIdx, vaHi = pocIdx;
    while (vaVol < vaTarget && (vaLo > 0 || vaHi < bins - 1)) {
      var addLo = vaLo > 0 ? levels[vaLo - 1].vol : 0;
      var addHi = vaHi < bins - 1 ? levels[vaHi + 1].vol : 0;
      if (addLo >= addHi && vaLo > 0) { vaLo--; vaVol += levels[vaLo].vol; }
      else if (vaHi < bins - 1) { vaHi++; vaVol += levels[vaHi].vol; }
      else break;
    }
    return {
      levels: levels, poc: levels[pocIdx] ? levels[pocIdx].price : 0,
      maxVol: maxVol, vaH: levels[vaHi].price + step/2, vaL: levels[vaLo].price - step/2
    };
  }

  // ── SVP ──
  function calcSVPs(vis, startIdx) {
    var tf = TIMEFRAMES[currentTF];
    if (tf.label === '1D' || tf.label === '1W') return [];
    var sessions = [], cur = null;
    vis.forEach(function(c, i) {
      var d = new Date(c.t);
      var h = d.getUTCHours();
      var sess = h < 8 ? 0 : h < 16 ? 1 : 2;
      var dayKey = d.getUTCFullYear()+'-'+d.getUTCMonth()+'-'+d.getUTCDate()+'-'+sess;
      if (!cur || cur.key !== dayKey) {
        cur = { key:dayKey, sess:sess, candles:[], si:startIdx+i, ei:startIdx+i };
        sessions.push(cur);
      }
      cur.candles.push(c);
      cur.ei = startIdx + i;
    });
    return sessions.map(function(s) {
      var vp = calcVP(s.candles, 30);
      return { sess:s.sess, si:s.si, ei:s.ei, vp:vp, candles:s.candles };
    }).filter(function(s){ return s.vp.maxVol > 0 && s.candles.length >= 3; });
  }

  // ── Key Levels ──
  function getKeyLevels() {
    var levels = [];
    function add(arr, pref, color) {
      if (arr.length < 2) return;
      var prev = arr[arr.length-2], curr = arr[arr.length-1];
      levels.push({ price:prev.h, label:pref+' High', color:color, dash:[3,3], weight:0.7 });
      levels.push({ price:prev.l, label:pref+' Low',  color:color, dash:[3,3], weight:0.7 });
      levels.push({ price:prev.c, label:pref+' Close',color:color, dash:[6,3], weight:1 });
      levels.push({ price:curr.o, label:pref+' Open', color:color, dash:[2,4], weight:0.5 });
    }
    if (overlays.levels_daily)   add(dailyCandles,   'D', C.lvlD);
    if (overlays.levels_weekly)  add(weeklyCandles,  'W', C.lvlW);
    if (overlays.levels_monthly) add(monthlyCandles, 'M', C.lvlM);
    return levels;
  }

  function getPeriodZones() {
    var zones = [];
    function add(arr, label, fill, border) {
      if (arr.length<2) return;
      var p = arr[arr.length-2];
      zones.push({ high:p.h, low:p.l, label:label, fill:fill, border:border });
    }
    if (overlays.zones_daily)   add(dailyCandles,'Prev Day',C.zoneD,C.zoneBD);
    if (overlays.zones_weekly)  add(weeklyCandles,'Prev Week',C.zoneW,C.zoneBW);
    if (overlays.zones_monthly) add(monthlyCandles,'Prev Month',C.zoneM,C.zoneBM);
    return zones;
  }

  // ── Mapping ──
  function getPlotW() { return W - chartLeft - chartRight - (overlays.volume_profile ? vpWidth : 0); }
  function priceToY(p) { return chartTop + (H-chartTop-chartBottom) * (1 - (p-priceMin)/(priceMax-priceMin)); }
  function yToPrice(y) { return priceMin + (1 - (y-chartTop)/(H-chartTop-chartBottom)) * (priceMax-priceMin); }
  function barToX(i) {
    var plotW = getPlotW();
    var start = candles.length - visibleBars - scrollOffset;
    return chartLeft + ((i-start)+0.5) * (plotW/visibleBars);
  }

  // ── Render ──
  function render() {
    if (!canvas || !candles.length) return;
    var rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    W = rect.width; H = rect.height;
    canvas.width = W*dpr; canvas.height = H*dpr;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);

    var si = Math.max(0, candles.length-visibleBars-scrollOffset);
    var ei = Math.min(candles.length, si+visibleBars);
    var vis = candles.slice(si, ei);
    if (!vis.length) return;

    var rawMin = Infinity, rawMax = -Infinity;
    vis.forEach(function(c){ if(c.l<rawMin)rawMin=c.l; if(c.h>rawMax)rawMax=c.h; });
    var pad = (rawMax-rawMin)*0.08;
    priceMin = rawMin - pad;
    priceMax = rawMax + pad;

    var showVP = overlays.volume_profile;
    var plotW = getPlotW();
    var plotH = H - chartTop - chartBottom;
    var barW = plotW / visibleBars;
    var candleW = Math.max(1, barW*0.62);

    // BG + gradient vignette
    ctx.fillStyle = C.bg;
    ctx.fillRect(0,0,W,H);
    var grad = ctx.createRadialGradient(chartLeft+plotW/2, plotH/2, 0, chartLeft+plotW/2, plotH/2, plotW*0.7);
    grad.addColorStop(0, 'rgba(25,28,39,0.35)');
    grad.addColorStop(1, 'rgba(19,23,34,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0,0,W,H);

    drawWatermark(plotW);

    // Grid
    var range = priceMax-priceMin;
    var step = niceStep(range, 6);
    var gs = Math.ceil(priceMin/step)*step;
    for (var p = gs; p <= priceMax; p += step) {
      var y = Math.round(priceToY(p))+0.5;
      ctx.strokeStyle = C.grid; ctx.lineWidth = 0.5;
      ctx.setLineDash([1,3]);
      ctx.beginPath(); ctx.moveTo(chartLeft,y); ctx.lineTo(chartLeft+plotW+(showVP?vpWidth:0),y); ctx.stroke();
      ctx.setLineDash([]);
    }
    var tSkip = Math.max(1, Math.floor(80/barW));
    vis.forEach(function(c,i) {
      if (i%tSkip !== 0) return;
      var x = barToX(si+i);
      ctx.strokeStyle = C.gridFine; ctx.lineWidth = 0.5;
      ctx.setLineDash([1,3]);
      ctx.beginPath(); ctx.moveTo(Math.round(x)+0.5, chartTop); ctx.lineTo(Math.round(x)+0.5, H-chartBottom); ctx.stroke();
      ctx.setLineDash([]);
    });

    // Period Zones
    getPeriodZones().forEach(function(z) {
      var y1 = priceToY(z.high), y2 = priceToY(z.low);
      var zGrad = ctx.createLinearGradient(0, y1, 0, y2);
      zGrad.addColorStop(0, z.fill);
      zGrad.addColorStop(0.5, z.border.replace(/[\d.]+\)$/, '0.04)'));
      zGrad.addColorStop(1, z.fill);
      ctx.fillStyle = zGrad;
      ctx.fillRect(chartLeft, y1, plotW, y2-y1);
      ctx.strokeStyle = z.border; ctx.lineWidth = 0.5;
      ctx.setLineDash([4,4]);
      ctx.strokeRect(chartLeft, y1, plotW, y2-y1);
      ctx.setLineDash([]);
      ctx.fillStyle = z.border;
      ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(z.label, chartLeft+5, y1+13);
    });

    // Key Levels
    getKeyLevels().forEach(function(lv) {
      var y = priceToY(lv.price);
      if (y < chartTop || y > H-chartBottom) return;
      ctx.beginPath();
      ctx.setLineDash(lv.dash);
      ctx.strokeStyle = lv.color + (lv.weight > 0.8 ? 'bb' : '77');
      ctx.lineWidth = lv.weight;
      ctx.moveTo(chartLeft, Math.round(y)+0.5);
      ctx.lineTo(chartLeft+plotW, Math.round(y)+0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // SVP
    if (overlays.svp) drawSVPs(vis, si, barW, plotH);

    // Volume bars (gradient)
    var maxVol = 0;
    vis.forEach(function(c){ if(c.v>maxVol) maxVol=c.v; });
    var volH = plotH * 0.15;
    vis.forEach(function(c,i) {
      var x = barToX(si+i);
      var bull = c.c >= c.o;
      var vh = (c.v/maxVol)*volH;
      var vGrad = ctx.createLinearGradient(0, H-chartBottom-vh, 0, H-chartBottom);
      var baseCol = bull ? C.bull : C.bear;
      vGrad.addColorStop(0, baseCol.replace(')', ',0.28)').replace('rgb', 'rgba'));
      vGrad.addColorStop(1, baseCol.replace(')', ',0.04)').replace('rgb', 'rgba'));
      ctx.fillStyle = bull ? C.bullVol : C.bearVol;
      ctx.fillRect(x-candleW/2, H-chartBottom-vh, candleW, vh);
    });

    // EMA lines
    if (overlays.ema200) drawEMALine(vis, si, 'ema200', C.ema200, 1.2);
    if (overlays.ema50)  drawEMALine(vis, si, 'ema50',  C.ema50,  1);
    if (overlays.ema21)  drawEMALine(vis, si, 'ema21',  C.ema21,  0.8);

    // VWAP
    if (overlays.vwap) drawEMALine(vis, si, 'vwap', C.vwap, 1.2);

    // Candlesticks
    vis.forEach(function(c,i) {
      var x = barToX(si+i);
      var bull = c.c >= c.o;
      var hY = priceToY(c.h), lY = priceToY(c.l);
      var oY = priceToY(c.o), cY = priceToY(c.c);
      var bTop = Math.min(oY,cY), bH = Math.max(1, Math.abs(cY-oY));
      var col = bull ? C.bull : C.bear;
      // Wick
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x)+0.5, hY);
      ctx.lineTo(Math.round(x)+0.5, lY);
      ctx.stroke();
      // Body
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(x-candleW/2), bTop, Math.ceil(candleW), bH);
    });

    // Volume Profile + Value Area
    if (showVP || overlays.poc) {
      var vp = calcVP(vis, 80);
      var vpX = chartLeft+plotW;
      if (showVP && vp.maxVol > 0) {
        var vpBarH = plotH/80;
        // Value Area highlight
        var vaTop = priceToY(vp.vaH);
        var vaBot = priceToY(vp.vaL);
        ctx.fillStyle = C.vpVA;
        ctx.fillRect(chartLeft, vaTop, plotW, vaBot - vaTop);
        // VP bars
        vp.levels.forEach(function(lv) {
          var y = priceToY(lv.price);
          var w = (lv.vol/vp.maxVol)*vpWidth*0.92;
          var buyW = (lv.buyVol/vp.maxVol)*vpWidth*0.92;
          ctx.fillStyle = C.vpSell;
          ctx.fillRect(vpX+2, y-vpBarH/2, w, vpBarH-1);
          ctx.fillStyle = C.vpBuy;
          ctx.fillRect(vpX+2, y-vpBarH/2, buyW, vpBarH-1);
        });
      }
      if (overlays.poc && vp.poc) {
        var py = priceToY(vp.poc);
        ctx.beginPath(); ctx.setLineDash([8,4]);
        ctx.strokeStyle = C.gold; ctx.lineWidth = 1;
        ctx.moveTo(chartLeft, Math.round(py)+0.5);
        ctx.lineTo(chartLeft+plotW+(showVP?vpWidth:0), Math.round(py)+0.5);
        ctx.stroke(); ctx.setLineDash([]);
      }
    }

    // Axis panel
    ctx.fillStyle = C.bgPanel;
    ctx.fillRect(chartLeft+plotW+(showVP?vpWidth:0), 0, chartRight, H);
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartLeft+plotW+(showVP?vpWidth:0), 0);
    ctx.lineTo(chartLeft+plotW+(showVP?vpWidth:0), H);
    ctx.stroke();
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H-chartBottom); ctx.lineTo(W, H-chartBottom); ctx.stroke();

    // Price axis labels
    ctx.font = '11px Inter,sans-serif'; ctx.textAlign = 'right';
    var axisX = chartLeft+plotW+(showVP?vpWidth:0)+chartRight-6;
    for (var p = gs; p <= priceMax; p += step) {
      ctx.fillStyle = C.text;
      ctx.fillText(fmtP(p), axisX, priceToY(p)+4);
    }

    // Key level badges on axis
    getKeyLevels().forEach(function(lv) {
      var y = priceToY(lv.price);
      if (y < chartTop || y > H-chartBottom) return;
      var lbl = lv.label;
      ctx.font = '10px Inter,sans-serif';
      var tw = ctx.measureText(lbl).width + 8;
      var lx = chartLeft+plotW+(showVP?vpWidth:0)+2;
      ctx.fillStyle = lv.color+'18';
      rrect(ctx, lx, y-8, tw, 16, 2); ctx.fill();
      ctx.fillStyle = lv.color; ctx.textAlign = 'left';
      ctx.fillText(lbl, lx+4, y+4);
    });

    // POC badge
    if (overlays.poc) {
      var vp2 = calcVP(vis, 80);
      if (vp2.poc) {
        var py2 = priceToY(vp2.poc);
        var pl2 = 'POC '+fmtP(vp2.poc);
        ctx.font = 'bold 10px Inter,sans-serif';
        var ptw2 = ctx.measureText(pl2).width+10;
        var px2 = chartLeft+plotW+(showVP?vpWidth:0)+2;
        ctx.fillStyle = C.goldDim;
        rrect(ctx, px2, py2-9, ptw2, 18, 2); ctx.fill();
        ctx.fillStyle = C.gold; ctx.textAlign = 'left';
        ctx.fillText(pl2, px2+5, py2+4);
      }
    }

    // Time axis
    ctx.font = '11px Inter,sans-serif'; ctx.textAlign = 'center';
    var ts2 = Math.max(1, Math.floor(65/barW));
    vis.forEach(function(c,i) {
      if (i%ts2 !== 0) return;
      var x = barToX(si+i);
      var d = new Date(c.t);
      var tf = TIMEFRAMES[currentTF];
      var label;
      if (tf.label === '1D' || tf.label === '1W') {
        label = d.toLocaleDateString('en-US', {month:'short',day:'numeric'});
      } else if (d.getUTCHours() === 0 && tf.label !== '5m') {
        label = d.toLocaleDateString('en-US', {month:'short',day:'numeric'});
      } else {
        label = String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');
      }
      ctx.fillStyle = C.text;
      ctx.fillText(label, x, H-chartBottom+15);
      ctx.strokeStyle = C.border; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x)+0.5, H-chartBottom); ctx.lineTo(Math.round(x)+0.5, H-chartBottom+4); ctx.stroke();
    });

    // Current price + pulse
    var last = vis[vis.length-1];
    if (last) {
      var cpY = priceToY(last.c);
      var bull = last.c >= last.o;
      var col = bull ? C.bull : C.bear;
      ctx.beginPath(); ctx.setLineDash([4,3]);
      ctx.strokeStyle = col+'88'; ctx.lineWidth = 1;
      ctx.moveTo(chartLeft, Math.round(cpY)+0.5);
      ctx.lineTo(chartLeft+plotW+(showVP?vpWidth:0), Math.round(cpY)+0.5);
      ctx.stroke(); ctx.setLineDash([]);
      var tag = fmtP(last.c);
      ctx.font = 'bold 11px Inter,sans-serif';
      var tagW = ctx.measureText(tag).width+16;
      var tagX = chartLeft+plotW+(showVP?vpWidth:0);
      // Glow
      ctx.shadowColor = col; ctx.shadowBlur = 8;
      ctx.fillStyle = col;
      rrect(ctx, tagX, cpY-10, tagW+8, 20, 3); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.fillStyle = col;
      ctx.moveTo(tagX, cpY-5); ctx.lineTo(tagX-5, cpY); ctx.lineTo(tagX, cpY+5); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
      ctx.fillText(tag, tagX+8, cpY+4);
      // Pulse dot
      var pulse = 0.4 + 0.6 * Math.abs(Math.sin(pulsePhase));
      ctx.beginPath();
      ctx.arc(tagX + tagW + 14, cpY, 3, 0, Math.PI*2);
      ctx.fillStyle = col.replace(')', ','+pulse+')').replace('rgb','rgba').replace('#','');
      if (col.charAt(0) === '#') {
        var r = parseInt(col.slice(1,3),16), g = parseInt(col.slice(3,5),16), b = parseInt(col.slice(5,7),16);
        ctx.fillStyle = 'rgba('+r+','+g+','+b+','+pulse+')';
      }
      ctx.fill();
    }

    // Crosshair
    if (showCrosshair && mouseX > chartLeft && mouseX < chartLeft+plotW && mouseY > chartTop && mouseY < H-chartBottom) {
      drawCrosshair(vis, si, plotW, barW, candleW);
    }
  }

  function drawEMALine(vis, si, key, color, width) {
    if (vis.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    var started = false;
    vis.forEach(function(c, i) {
      var val = c[key];
      if (val === undefined || val === null) return;
      var x = barToX(si + i);
      var y = priceToY(val);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function drawWatermark(plotW) {
    ctx.save();
    ctx.font = 'bold 44px Cinzel,serif';
    ctx.fillStyle = C.watermark;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('IVth LEGION', chartLeft + plotW/2, (H-chartBottom)/2 - 12);
    ctx.font = '12px Inter,sans-serif';
    ctx.fillStyle = 'rgba(42,46,57,0.22)';
    ctx.fillText('BTCUSDT · Binance Perpetual · '+TIMEFRAMES[currentTF].label, chartLeft + plotW/2, (H-chartBottom)/2 + 16);
    ctx.restore();
  }

  function drawSVPs(vis, si, barW, plotH) {
    var svps = calcSVPs(vis, si);
    svps.forEach(function(s) {
      var sess = SESSIONS[s.sess];
      var x0 = barToX(s.si) - barW/2;
      var x1 = barToX(s.ei) + barW/2;
      var segW = x1 - x0;
      if (segW < 10 || !s.vp.levels.length) return;
      ctx.fillStyle = sess.color;
      ctx.fillRect(x0, chartTop, segW, H-chartTop-chartBottom);
      var vpBarH = plotH / 30;
      s.vp.levels.forEach(function(lv) {
        var y = priceToY(lv.price);
        var w = (lv.vol / s.vp.maxVol) * segW * 0.4;
        ctx.fillStyle = sess.border;
        ctx.fillRect(x0, y - vpBarH/2, w, vpBarH - 1);
      });
      ctx.font = '9px Inter,sans-serif';
      ctx.fillStyle = sess.border; ctx.textAlign = 'left';
      ctx.fillText(sess.name, x0 + 3, chartTop + 11);
    });
  }

  function drawCrosshair(vis, si, plotW, barW, candleW) {
    var showVP = overlays.volume_profile;
    ctx.strokeStyle = C.cross; ctx.lineWidth = 0.5; ctx.setLineDash([4,3]);
    ctx.beginPath();
    ctx.moveTo(chartLeft, mouseY); ctx.lineTo(chartLeft+plotW+(showVP?vpWidth:0), mouseY);
    ctx.moveTo(mouseX, chartTop); ctx.lineTo(mouseX, H-chartBottom);
    ctx.stroke(); ctx.setLineDash([]);

    // Price label
    var price = yToPrice(mouseY);
    var pStr = fmtP(price);
    ctx.font = '11px Inter,sans-serif';
    var plw = ctx.measureText(pStr).width+12;
    var axX = chartLeft+plotW+(showVP?vpWidth:0);
    ctx.fillStyle = '#363a45';
    rrect(ctx, axX, mouseY-10, plw+8, 20, 2); ctx.fill();
    ctx.fillStyle = C.textWhite; ctx.textAlign = 'left';
    ctx.fillText(pStr, axX+8, mouseY+4);

    // Candle highlight
    var ci = Math.round((mouseX-chartLeft)/barW-0.5)+Math.max(0, candles.length-visibleBars-scrollOffset);
    if (ci >= 0 && ci < candles.length) {
      var c = candles[ci];
      var cx = barToX(ci);
      // Highlight glow
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(cx - barW/2, chartTop, barW, H-chartTop-chartBottom);

      var d = new Date(c.t);
      var ts = d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');
      ctx.font = '11px Inter,sans-serif';
      var tlw = ctx.measureText(ts).width+12;
      var tx = barToX(ci);
      ctx.fillStyle = '#363a45';
      rrect(ctx, tx-tlw/2, H-chartBottom, tlw, 18, 2); ctx.fill();
      ctx.fillStyle = C.textWhite; ctx.textAlign = 'center';
      ctx.fillText(ts, tx, H-chartBottom+13);
      updateOHLC(c);
    }
  }

  function updateOHLC(c) {
    var ohlcEl = document.getElementById('legion-ohlc');
    if (!ohlcEl || !c) return;
    var bull = c.c >= c.o;
    var col = bull ? C.bull : C.bear;
    var chg = ((c.c - c.o)/c.o * 100).toFixed(2);
    var sign = chg >= 0 ? '+' : '';
    ohlcEl.innerHTML =
      '<span style="color:'+C.text+'">O</span> <span style="color:'+col+'">'+fmtP(c.o)+'</span>' +
      '<span style="color:'+C.text+';margin-left:8px">H</span> <span style="color:'+col+'">'+fmtP(c.h)+'</span>' +
      '<span style="color:'+C.text+';margin-left:8px">L</span> <span style="color:'+col+'">'+fmtP(c.l)+'</span>' +
      '<span style="color:'+C.text+';margin-left:8px">C</span> <span style="color:'+col+'">'+fmtP(c.c)+'</span>' +
      '<span style="color:'+C.text+';margin-left:8px">Vol</span> <span style="color:'+C.text+'">'+fmtVol(c.v)+'</span>' +
      '<span style="color:'+col+';margin-left:8px;font-weight:600">'+sign+chg+'%</span>';
  }

  // ── Helpers ──
  function fmtP(p) { return p >= 1000 ? p.toLocaleString('en-US',{maximumFractionDigits:0}) : p.toFixed(2); }
  function fmtVol(v) {
    if (v>=1e9) return (v/1e9).toFixed(2)+'B';
    if (v>=1e6) return (v/1e6).toFixed(2)+'M';
    if (v>=1e3) return (v/1e3).toFixed(1)+'K';
    return v.toFixed(0);
  }
  function niceStep(r,t) {
    var s=r/t, m=Math.pow(10,Math.floor(Math.log10(s))), n=s/m;
    return (n<=1.5?1:n<=3?2:n<=7?5:10)*m;
  }
  function rrect(ctx,x,y,w,h,r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
    ctx.arcTo(x+w,y,x+w,y+r,r); ctx.lineTo(x+w,y+h-r);
    ctx.arcTo(x+w,y+h,x+w-r,y+h,r); ctx.lineTo(x+r,y+h);
    ctx.arcTo(x,y+h,x,y+h-r,r); ctx.lineTo(x,y+r);
    ctx.arcTo(x,y,x+r,y,r); ctx.closePath();
  }

  // ── Events ──
  function setupEvents() {
    canvas.addEventListener('mousemove', function(e) {
      var r = canvas.getBoundingClientRect();
      mouseX = e.clientX-r.left; mouseY = e.clientY-r.top;
      showCrosshair = true;
      if (isDragging) {
        var plotW = getPlotW();
        var bw = plotW/visibleBars;
        scrollOffset = Math.max(0, Math.min(candles.length-visibleBars, dragStartOffset+Math.round((e.clientX-dragStartX)/bw)));
      }
      render();
    });
    canvas.addEventListener('mouseleave', function() {
      showCrosshair = false; isDragging = false;
      if (candles.length) updateOHLC(candles[candles.length-1]);
      render();
    });
    canvas.addEventListener('mousedown', function(e) { isDragging=true; dragStartX=e.clientX; dragStartOffset=scrollOffset; canvas.style.cursor='grabbing'; });
    canvas.addEventListener('mouseup', function() { isDragging=false; canvas.style.cursor='crosshair'; });
    canvas.addEventListener('wheel', function(e) {
      e.preventDefault();
      var z = Math.max(1, Math.round(visibleBars*0.06));
      visibleBars = e.deltaY > 0 ? Math.min(candles.length, visibleBars+z) : Math.max(20, visibleBars-z);
      scrollOffset = Math.max(0, Math.min(candles.length-visibleBars, scrollOffset));
      render();
    }, {passive:false});
    window.addEventListener('resize', function() { render(); });
  }

  function startPulseAnimation() {
    function tick() {
      pulsePhase += 0.04;
      animFrame = requestAnimationFrame(tick);
    }
    tick();
  }

  // ── Timeframe change ──
  function setTimeframe(idx) {
    currentTF = idx;
    updateTFButtons();
    if (canvas && W > 10) {
      ctx.fillStyle = C.bg; ctx.fillRect(0,0,W,H);
      ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.font = '12px Inter,sans-serif';
      ctx.fillText('Loading '+TIMEFRAMES[idx].label+' data…', W/2, H/2);
    }
    loadData();
  }

  function updateTFButtons() {
    var btns = containerEl ? containerEl.querySelectorAll('.tf-btn') : [];
    for (var i = 0; i < btns.length; i++) {
      if (i === currentTF) btns[i].classList.add('active');
      else btns[i].classList.remove('active');
    }
  }

  // ── Build DOM ──
  function buildToolbar(container) {
    var toolbar = document.createElement('div');
    toolbar.className = 'chart-toolbar';
    var html = '<div class="chart-toolbar-left">';
    html += '<div class="chart-live-dot"></div>';
    html += '<span class="chart-symbol">BTCUSDT</span>';
    html += '<span class="chart-exchange">Binance Perpetual</span>';
    html += '<span class="chart-tf-sep">·</span>';
    html += '<div class="chart-tf-group">';
    TIMEFRAMES.forEach(function(tf,i) {
      html += '<button class="tf-btn'+(i===currentTF?' active':'')+'" data-idx="'+i+'">'+tf.label+'</button>';
    });
    html += '</div>';
    html += '<span class="chart-tf-sep">·</span>';
    html += '<span id="legion-ohlc" class="chart-ohlc"></span>';
    html += '</div>';
    toolbar.innerHTML = html;
    toolbar.querySelectorAll('.tf-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { setTimeframe(+btn.dataset.idx); });
    });
    container.appendChild(toolbar);
  }

  function buildControls(container) {
    var div = document.createElement('div');
    div.className = 'chart-controls';
    var groups = [
      { title:'LEVELS', items:[
        {key:'levels_daily',  label:'Daily',  color:C.lvlD},
        {key:'levels_weekly', label:'Weekly', color:C.lvlW},
        {key:'levels_monthly',label:'Monthly',color:C.lvlM},
      ]},
      { title:'ZONES', items:[
        {key:'zones_daily',  label:'Daily',  color:C.lvlD},
        {key:'zones_weekly', label:'Weekly', color:C.lvlW},
        {key:'zones_monthly',label:'Monthly',color:C.lvlM},
      ]},
      { title:'VOLUME', items:[
        {key:'volume_profile',label:'Profile',color:C.bull},
        {key:'poc',           label:'POC',    color:C.gold},
        {key:'svp',           label:'SVP',    color:'#ffc107'},
      ]},
      { title:'OVERLAYS', items:[
        {key:'ema21',  label:'EMA 21', color:C.ema21},
        {key:'ema50',  label:'EMA 50', color:C.ema50},
        {key:'ema200', label:'EMA 200',color:C.ema200},
        {key:'vwap',   label:'VWAP',   color:C.vwap},
      ]},
    ];
    var html = '';
    groups.forEach(function(g) {
      html += '<div class="ctrl-group"><span class="ctrl-title">'+g.title+'</span>';
      g.items.forEach(function(it) {
        html += '<label class="ctrl-toggle">';
        html += '<input type="checkbox" data-key="'+it.key+'"'+(overlays[it.key]?' checked':'')+'>';
        html += '<span class="ctrl-dot" style="--dot-color:'+it.color+'"></span>';
        html += '<span>'+it.label+'</span></label>';
      });
      html += '</div>';
    });
    div.innerHTML = html;
    div.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
      cb.addEventListener('change', function() { overlays[cb.dataset.key]=cb.checked; render(); });
    });
    container.appendChild(div);
  }

  // ── Init ──
  function init(containerId) {
    containerEl = document.getElementById(containerId);
    if (!containerEl) return;
    containerEl.innerHTML = '';
    buildToolbar(containerEl);
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:100%;height:580px;';
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;cursor:crosshair;';
    wrap.appendChild(canvas);
    containerEl.appendChild(wrap);
    ctx = canvas.getContext('2d');
    dpr = window.devicePixelRatio || 1;
    buildControls(containerEl);
    setupEvents();
    startPulseAnimation();
    new ResizeObserver(function() { render(); }).observe(wrap);
    var r = wrap.getBoundingClientRect();
    if (r.width > 10) {
      canvas.width = r.width*dpr; canvas.height = r.height*dpr;
      canvas.style.width = r.width+'px'; canvas.style.height = r.height+'px';
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.fillStyle = C.bg; ctx.fillRect(0,0,r.width,r.height);
      ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.font = '12px Inter,sans-serif';
      ctx.fillText('Loading BTC data…', r.width/2, r.height/2);
    }
    loadData();
    setInterval(function() {
      if (Date.now() - lastRefresh > 55000) loadData();
    }, 60000);
  }

  return { init: init, render: render };
})();
