// Crypto derivatives & market structure data (CoinGlass-style).
// Sources: Binance Futures, Bybit, OKX, Deribit, CoinGecko, DefiLlama.
// All endpoints are public (no API keys) with in-memory caching.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const cache = new Map();
async function cached(key, ttlSec, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  const data = await fn();
  cache.set(key, { exp: Date.now() + ttlSec * 1000, data });
  return data;
}

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const OKX_MAP = { BTCUSDT: 'BTC-USDT-SWAP', ETHUSDT: 'ETH-USDT-SWAP' };

// ── Open Interest (Binance 4h historical + current from 3 exchanges) ──
async function getOI(symbol) {
  return cached('oi:' + symbol, 300, async () => {
    const [hist, binCur, bybitCur, okxCur] = await Promise.allSettled([
      fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=4h&limit=500`),
      fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`),
      fetchJSON(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=4h&limit=1`),
      fetchJSON(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${OKX_MAP[symbol] || 'BTC-USDT-SWAP'}`),
    ]);

    const history = (hist.status === 'fulfilled' ? hist.value : []).map(r => ({
      t: Number(r.timestamp), oi: parseFloat(r.sumOpenInterest), oiUsd: parseFloat(r.sumOpenInterestValue),
    }));

    const current = {};
    if (binCur.status === 'fulfilled') current.binance = parseFloat(binCur.value.openInterest);
    if (bybitCur.status === 'fulfilled') {
      const d = bybitCur.value?.result?.list?.[0];
      if (d) current.bybit = parseFloat(d.openInterest);
    }
    if (okxCur.status === 'fulfilled') {
      const d = okxCur.value?.data?.[0];
      if (d) current.okx = parseFloat(d.oi);
    }

    return { history, current, symbol };
  });
}

// ── Funding Rates (current top coins from Binance + BTC historical) ──
async function getFunding() {
  return cached('funding', 300, async () => {
    const [premIdx, btcHist] = await Promise.allSettled([
      fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex'),
      fetchJSON('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=500'),
    ]);

    const TOP = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT',
      'DOTUSDT', 'LTCUSDT', 'MATICUSDT', 'NEARUSDT', 'AAVEUSDT', 'TRXUSDT', 'UNIUSDT', 'PEPEUSDT', 'ARBUSDT', 'APTUSDT'];
    const all = premIdx.status === 'fulfilled' ? premIdx.value : [];
    const current = TOP.map(sym => {
      const b = all.find(r => r.symbol === sym);
      return b ? { symbol: sym, rate: parseFloat(b.lastFundingRate), mark: parseFloat(b.markPrice), next: Number(b.nextFundingTime) } : null;
    }).filter(Boolean);

    const history = (btcHist.status === 'fulfilled' ? btcHist.value : []).map(r => ({
      t: Number(r.fundingTime), rate: parseFloat(r.fundingRate),
    }));

    return { current, history };
  });
}

// ── Long/Short Ratio (Binance 4h, 500 points ≈ 83 days) ──
async function getLSRatio(symbol) {
  return cached('ls:' + symbol, 300, async () => {
    const [global, topAcct, topPos] = await Promise.allSettled([
      fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=4h&limit=500`),
      fetchJSON(`https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=4h&limit=500`),
      fetchJSON(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=4h&limit=500`),
    ]);

    const map = r => (r.status === 'fulfilled' ? r.value : []).map(d => ({
      t: Number(d.timestamp),
      long: parseFloat(d.longAccount || d.longPosition || 0),
      short: parseFloat(d.shortAccount || d.shortPosition || 0),
      ratio: parseFloat(d.longShortRatio),
    }));

    return { global: map(global), topAccount: map(topAcct), topPosition: map(topPos), symbol };
  });
}

// ── Taker Buy/Sell Volume (Binance 4h) ──
async function getTaker(symbol) {
  return cached('taker:' + symbol, 300, async () => {
    const data = await fetchJSON(
      `https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${symbol}&period=4h&limit=500`
    ).catch(() => []);

    return {
      history: data.map(r => ({
        t: Number(r.timestamp), buyVol: parseFloat(r.buyVol), sellVol: parseFloat(r.sellVol), ratio: parseFloat(r.buySellRatio),
      })),
      symbol,
    };
  });
}

// ── Liquidations (OKX recent, Binance WebSocket summary) ──
async function getLiquidations() {
  return cached('liqs', 600, async () => {
    const [btc, eth] = await Promise.allSettled([
      fetchJSON('https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=BTC-USDT&state=filled&limit=100'),
      fetchJSON('https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=ETH-USDT&state=filled&limit=100'),
    ]);

    function extract(resp, label) {
      if (resp.status !== 'fulfilled' || !resp.value?.data) return [];
      return resp.value.data.flatMap(batch =>
        (batch.details || []).map(d => ({
          t: Number(d.ts), side: d.side, price: parseFloat(d.bkPx), sz: parseFloat(d.sz),
          usd: parseFloat(d.bkPx) * parseFloat(d.sz), inst: label,
        }))
      );
    }

    const all = [...extract(btc, 'BTC'), ...extract(eth, 'ETH')].sort((a, b) => b.t - a.t);
    const cutoff = Date.now() - 24 * 3600000;
    let longUsd = 0, shortUsd = 0;
    for (const l of all) {
      if (l.t < cutoff) continue;
      if (l.side === 'sell') longUsd += l.usd; else shortUsd += l.usd;
    }

    return { h24: { longUsd: Math.round(longUsd), shortUsd: Math.round(shortUsd), total: Math.round(longUsd + shortUsd) }, recent: all.slice(0, 50), source: 'OKX (BTC+ETH perps only)' };
  });
}

// ── Market Overview (CoinGecko global + DefiLlama stablecoins) ──
async function getOverview() {
  return cached('overview', 600, async () => {
    const [global, stables] = await Promise.allSettled([
      fetchJSON('https://api.coingecko.com/api/v3/global'),
      fetchJSON('https://stablecoins.llama.fi/stablecoins?includePrices=false'),
    ]);

    const g = global.status === 'fulfilled' ? (global.value.data || {}) : {};
    const dom = g.market_cap_percentage || {};
    let stableMcap = 0;
    if (stables.status === 'fulfilled') {
      for (const s of (stables.value?.peggedAssets || [])) {
        const v = s.circulating?.peggedUSD;
        if (v) stableMcap += v;
      }
    }

    return {
      btcDom: Math.round((dom.btc || 0) * 100) / 100,
      ethDom: Math.round((dom.eth || 0) * 100) / 100,
      totalMcap: Math.round(g.total_market_cap?.usd || 0),
      totalVol: Math.round(g.total_volume?.usd || 0),
      stableMcap: Math.round(stableMcap),
      activeCryptos: g.active_cryptocurrencies || 0,
      mcapChange24h: Math.round((g.market_cap_change_percentage_24h_usd || 0) * 100) / 100,
    };
  });
}

// ── Options Max Pain + OI by Strike (Deribit BTC) ──
async function getOptions() {
  return cached('options', 300, async () => {
    const books = await fetchJSON(
      'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option'
    ).catch(() => ({ result: [] }));

    const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    function parseExpiry(s) {
      const m = s.match(/^(\d+)([A-Z]+)(\d+)$/);
      if (!m) return Infinity;
      return new Date(2000 + parseInt(m[3]), MONTHS[m[2]] || 0, parseInt(m[1])).getTime();
    }

    const opts = (books.result || []).map(o => {
      const parts = o.instrument_name.split('-');
      if (parts.length < 4) return null;
      return {
        expiry: parts[1], strike: parseFloat(parts[2]), type: parts[3],
        oi: o.open_interest || 0, vol: o.volume || 0, underlying: o.underlying_price || 0,
      };
    }).filter(Boolean);

    if (!opts.length) return { maxPain: null, pcRatio: null, strikes: [], expiry: null, currentPrice: 0, expiries: [] };

    const byExpiry = {};
    for (const o of opts) {
      if (!byExpiry[o.expiry]) byExpiry[o.expiry] = { totalOI: 0, list: [] };
      byExpiry[o.expiry].totalOI += o.oi;
      byExpiry[o.expiry].list.push(o);
    }

    const sorted = Object.entries(byExpiry).filter(([, v]) => v.totalOI > 50).sort((a, b) => parseExpiry(a[0]) - parseExpiry(b[0]));
    if (!sorted.length) return { maxPain: null, pcRatio: null, strikes: [], expiry: null, currentPrice: opts[0]?.underlying || 0, expiries: [] };

    const [nearestExp, nearestData] = sorted[0];
    const list = nearestData.list;
    const allStrikes = [...new Set(list.map(o => o.strike))].sort((a, b) => a - b);

    let minPain = Infinity, maxPainStrike = 0;
    for (const cand of allStrikes) {
      let pain = 0;
      for (const o of list) pain += (o.type === 'C' ? Math.max(0, cand - o.strike) : Math.max(0, o.strike - cand)) * o.oi;
      if (pain < minPain) { minPain = pain; maxPainStrike = cand; }
    }

    let callOI = 0, putOI = 0;
    for (const o of list) { if (o.type === 'C') callOI += o.oi; else putOI += o.oi; }

    const curPrice = opts[0]?.underlying || 0;
    const lo = curPrice * 0.5, hi = curPrice * 2;
    const strikeMap = {};
    for (const o of list) {
      if (o.strike < lo || o.strike > hi) continue;
      if (!strikeMap[o.strike]) strikeMap[o.strike] = { strike: o.strike, callOI: 0, putOI: 0 };
      if (o.type === 'C') strikeMap[o.strike].callOI += o.oi; else strikeMap[o.strike].putOI += o.oi;
    }

    const expiries = sorted.slice(0, 12).map(([exp, data]) => ({
      expiry: exp, totalOI: Math.round(data.totalOI),
      callOI: Math.round(data.list.filter(o => o.type === 'C').reduce((s, o) => s + o.oi, 0)),
      putOI: Math.round(data.list.filter(o => o.type === 'P').reduce((s, o) => s + o.oi, 0)),
    }));

    return {
      maxPain: maxPainStrike, pcRatio: callOI > 0 ? Math.round(putOI / callOI * 100) / 100 : null,
      callOI: Math.round(callOI), putOI: Math.round(putOI), currentPrice: curPrice,
      nearestExpiry: nearestExp, strikes: Object.values(strikeMap).sort((a, b) => a.strike - b.strike), expiries,
    };
  });
}

export function registerDerivativeRoutes(router) {
  const qs = url => new URLSearchParams((url || '').split('?')[1] || '');
  const sym = url => { const s = qs(url).get('symbol'); return (s && /^[A-Z]{4,12}$/.test(s)) ? s : 'BTCUSDT'; };

  router.get('/api/markets/oi', async (req, res) => {
    try { res.json(200, await getOI(sym(req.url))); }
    catch (e) { console.error('[deriv] oi:', e.message); res.json(502, { error: 'OI unavailable' }); }
  });
  router.get('/api/markets/funding', async (req, res) => {
    try { res.json(200, await getFunding()); }
    catch (e) { console.error('[deriv] funding:', e.message); res.json(502, { error: 'funding unavailable' }); }
  });
  router.get('/api/markets/lsratio', async (req, res) => {
    try { res.json(200, await getLSRatio(sym(req.url))); }
    catch (e) { console.error('[deriv] ls:', e.message); res.json(502, { error: 'L/S ratio unavailable' }); }
  });
  router.get('/api/markets/taker', async (req, res) => {
    try { res.json(200, await getTaker(sym(req.url))); }
    catch (e) { console.error('[deriv] taker:', e.message); res.json(502, { error: 'taker unavailable' }); }
  });
  router.get('/api/markets/liquidations', async (req, res) => {
    try { res.json(200, await getLiquidations()); }
    catch (e) { console.error('[deriv] liqs:', e.message); res.json(502, { error: 'liquidation data unavailable' }); }
  });
  router.get('/api/markets/overview', async (req, res) => {
    try { res.json(200, await getOverview()); }
    catch (e) { console.error('[deriv] overview:', e.message); res.json(502, { error: 'overview unavailable' }); }
  });
  router.get('/api/markets/options', async (req, res) => {
    try { res.json(200, await getOptions()); }
    catch (e) { console.error('[deriv] options:', e.message); res.json(502, { error: 'options unavailable' }); }
  });
}
