// IVth Legion Trade Tracker — a member's trade journal with confluence & timeframe analytics.
window.LegionTracker = (function () {
  'use strict';

  const MIN_CONF = 5;
  const CONFLUENCES = {
    'Structure': ['HTF trend aligned', 'Break of Structure (BOS)', 'Change of Character (ChoCH)', 'Support / resistance', 'Range edge'],
    'Levels & Zones': ['Key level (D/W/M open, high, low)', 'Volume POC / value area', 'Fibonacci 0.618–0.786', 'Order block / supply-demand zone', 'Liquidity sweep'],
    'Order Flow': ['CVD divergence', 'Absorption', 'Stacked imbalance zone', 'Delta divergence', 'OI confirms (L+ / S+)', 'OI exhaustion (SC / LQ)'],
    'Indicators': ['RSI divergence / extreme', 'MACD cross / divergence', 'EMA 21 / 50 / 200', 'Bull Market Support Band', 'Bollinger Band extreme', 'VWAP', 'Volume spike / climax'],
    'Price Action': ['Reversal candle', 'Chart pattern breakout', 'Breakout retest'],
    'Context': ['Session open (London / NY)', 'Macro / news aligned', 'Funding / sentiment extreme'],
  };
  const ASSETS = {
    'Crypto': [['BTCUSDT', 'Bitcoin'], ['ETHUSDT', 'Ethereum'], ['SOLUSDT', 'Solana'], ['XRPUSDT', 'XRP'], ['BNBUSDT', 'BNB'], ['DOGEUSDT', 'Dogecoin'],
      ['ADAUSDT', 'Cardano'], ['AVAXUSDT', 'Avalanche'], ['LINKUSDT', 'Chainlink'], ['DOTUSDT', 'Polkadot'], ['TONUSDT', 'Toncoin'], ['SUIUSDT', 'Sui'],
      ['TRXUSDT', 'Tron'], ['LTCUSDT', 'Litecoin'], ['BCHUSDT', 'Bitcoin Cash'], ['NEARUSDT', 'NEAR'], ['APTUSDT', 'Aptos'], ['ARBUSDT', 'Arbitrum'],
      ['OPUSDT', 'Optimism'], ['INJUSDT', 'Injective'], ['ATOMUSDT', 'Cosmos'], ['FETUSDT', 'Fetch.ai'], ['RENDERUSDT', 'Render'], ['TIAUSDT', 'Celestia'],
      ['SEIUSDT', 'Sei'], ['PEPEUSDT', 'Pepe'], ['WIFUSDT', 'dogwifhat'], ['ETHBTC', 'ETH / BTC']],
    'Indices': [['SPX', 'S&P 500'], ['NDX', 'Nasdaq 100'], ['DJI', 'Dow Jones'], ['RUT', 'Russell 2000'], ['DAX', 'DAX 40'], ['FTSE', 'FTSE 100'],
      ['NIKKEI', 'Nikkei 225'], ['DXY', 'US Dollar Index'], ['VIX', 'Volatility Index']],
    'Stocks': [['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['TSLA', 'Tesla'], ['AMZN', 'Amazon'], ['META', 'Meta'], ['GOOGL', 'Alphabet'],
      ['AMD', 'AMD'], ['NFLX', 'Netflix'], ['PLTR', 'Palantir'], ['COIN', 'Coinbase'], ['MSTR', 'MicroStrategy'], ['NBIS', 'Nebius']],
    'Forex': [['EURUSD', 'Euro / Dollar'], ['GBPUSD', 'Pound / Dollar'], ['USDJPY', 'Dollar / Yen'], ['AUDUSD', 'Aussie / Dollar'], ['USDCAD', 'Dollar / Loonie'],
      ['USDCHF', 'Dollar / Franc'], ['NZDUSD', 'Kiwi / Dollar'], ['EURJPY', 'Euro / Yen'], ['GBPJPY', 'Pound / Yen'], ['EURGBP', 'Euro / Pound']],
    'Commodities': [['XAUUSD', 'Gold'], ['XAGUSD', 'Silver'], ['USOIL', 'WTI Crude'], ['UKOIL', 'Brent Crude'], ['NATGAS', 'Natural Gas'], ['COPPER', 'Copper']],
  };
  const KNOWN_SYMBOLS = new Set(Object.values(ASSETS).flat().map(a => a[0]));

  let root, trades = [], timeframes = [], editing = null, filter = 'all', expanded = new Set(), live = {};
  let form = blankForm();

  const $ = (s, el = root) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtP = v => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 2 : v >= 1 ? 4 : 8 }));
  const fmtPct = v => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
  const fmtR = v => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + 'R');
  const cls = v => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const toLocalInput = ms => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const fromLocalInput = s => (s ? new Date(s).getTime() : null);
  const fmtDate = ms => new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  function blankForm() {
    return { symbol: 'BTCUSDT', customSymbol: false, direction: 'long', timeframe: '1H', entry: '', stop: '', target: '', entry_at: Date.now(), closed: false, close_price: '', closed_at: Date.now(), confluences: [], notes: '' };
  }

  async function api(url, body) {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: r.status });
    return data;
  }

  // ── Maths ────────────────────────────────────────────────────────
  const priceMove = (t, price) => (t.direction === 'long' ? price - t.entry : t.entry - price);
  const pnlPct = (t, price) => (price == null ? null : (priceMove(t, price) / t.entry) * 100);
  const rMult = (t, price) => (price == null || t.stop == null ? null : priceMove(t, price) / Math.abs(t.entry - t.stop));
  const isClosed = t => t.close_price != null;
  const outcome = t => { const p = pnlPct(t, t.close_price); return p > 0 ? 'win' : p < 0 ? 'loss' : 'be'; };

  function group(list, keyFn) {
    const m = new Map();
    for (const t of list) for (const k of [].concat(keyFn(t))) { if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    return [...m].map(([key, ts]) => stats(key, ts));
  }
  function stats(key, ts) {
    const wins = ts.filter(t => outcome(t) === 'win').length;
    const pnls = ts.map(t => pnlPct(t, t.close_price));
    const rs = ts.map(t => rMult(t, t.close_price)).filter(v => v != null);
    return {
      key, n: ts.length, wins, winRate: ts.length ? (wins / ts.length) * 100 : 0,
      avgPnl: pnls.reduce((a, b) => a + b, 0) / (pnls.length || 1),
      totalR: rs.length ? rs.reduce((a, b) => a + b, 0) : null,
    };
  }
  // Best first: win rate, then sample size, then average result.
  const rank = arr => arr.sort((a, b) => b.winRate - a.winRate || b.n - a.n || b.avgPnl - a.avgPnl);

  // ── Init / data ──────────────────────────────────────────────────
  async function init(id) {
    root = document.getElementById(id);
    if (!root) return;
    if (root.dataset.ready) { render(); return; }
    root.dataset.ready = '1';
    root.innerHTML = '<div class="edu-loading">Loading your trades…</div>';
    try {
      const d = await api('/api/trades');
      trades = d.trades; timeframes = d.timeframes;
      render();
      refreshLive();
      setInterval(refreshLive, 30000);
    } catch (e) {
      root.dataset.ready = '';
      root.innerHTML = `<div class="edu-empty"><h3>${e.status === 403 ? 'Members only' : 'Tracker unavailable'}</h3><p>${esc(e.message)}</p></div>`;
    }
  }

  // Live prices for open crypto trades (Binance USDT pairs) → unrealised P&L.
  async function refreshLive() {
    const syms = [...new Set(trades.filter(t => !isClosed(t) && /^[A-Z0-9]+USDT$/.test(t.symbol)).map(t => t.symbol))];
    if (!syms.length || !root.offsetParent) return;
    try {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(syms)));
      if (!r.ok) return;
      for (const p of await r.json()) live[p.symbol] = +p.price;
      renderList();
    } catch { /* offline — keep last prices */ }
  }

  // ── Render ───────────────────────────────────────────────────────
  function render() {
    root.innerHTML =
      '<div class="tt-kpis"></div>' +
      '<div class="tt-grid"><section class="tt-card tt-form-card"></section><section class="tt-card tt-list-card"></section></div>' +
      '<section class="tt-analytics"></section>';
    renderForm(); renderList(); renderKpis(); renderAnalytics();
  }
  function refreshAll() { renderList(); renderKpis(); renderAnalytics(); }

  function renderKpis() {
    const closed = trades.filter(isClosed), open = trades.length - closed.length;
    const s = stats('all', closed);
    const five = stats('5+', closed.filter(t => t.confluences.length >= MIN_CONF));
    const kpi = (lab, val, sub, c = '') => `<div class="tt-kpi"><span class="tt-kpi-label">${lab}</span><span class="tt-kpi-val ${c}">${val}</span><span class="tt-kpi-sub">${sub}</span></div>`;
    $('.tt-kpis').innerHTML =
      kpi('Trades', trades.length, `${open} open · ${closed.length} closed`) +
      kpi('Win rate', closed.length ? s.winRate.toFixed(0) + '%' : '—', `${s.wins} wins / ${closed.length}`) +
      kpi('Avg result', closed.length ? fmtPct(s.avgPnl) : '—', 'per closed trade', cls(closed.length ? s.avgPnl : null)) +
      kpi('Total R', s.totalR == null ? '—' : fmtR(s.totalR), 'trades with a stop', cls(s.totalR)) +
      kpi(`${MIN_CONF}+ confluences`, five.n ? five.winRate.toFixed(0) + '%' : '—', `win rate · ${five.n} trade${five.n === 1 ? '' : 's'}`, five.n && five.winRate >= s.winRate ? 'pos' : '');
  }

  function renderForm() {
    const f = form, n = f.confluences.length;
    const custom = f.customSymbol || !KNOWN_SYMBOLS.has(f.symbol);
    const known = new Set(Object.values(CONFLUENCES).flat());
    const customConf = f.confluences.filter(c => !known.has(c));
    const level = n >= MIN_CONF ? 'ok' : n >= 3 ? 'mid' : 'low';
    const rr = f.stop && f.target && f.entry ? Math.abs(f.target - f.entry) / Math.abs(f.entry - f.stop) : null;
    $('.tt-form-card').innerHTML =
      `<div class="tt-card-head"><h3>${editing ? 'Edit trade' : 'Log a trade'}</h3>${editing ? '<button class="tt-link" data-act="cancel">Cancel edit</button>' : ''}</div>` +
      '<form class="tt-form" novalidate>' +
        '<div class="tt-row">' +
          `<label class="tt-field"><span>Asset</span><select name="asset">` +
            Object.entries(ASSETS).map(([g, list]) => `<optgroup label="${g}">${list.map(([sym, nm]) => `<option value="${sym}"${!custom && sym === f.symbol ? ' selected' : ''}>${sym} — ${esc(nm)}</option>`).join('')}</optgroup>`).join('') +
            `<option value="__custom"${custom ? ' selected' : ''}>Other — type a symbol…</option></select></label>` +
          (custom ? `<label class="tt-field"><span>Symbol</span><input name="symbol" value="${esc(f.symbol === '__custom' ? '' : f.symbol)}" placeholder="e.g. HYPEUSDT" autocomplete="off" maxlength="20" required></label>` : '') +
          `<div class="tt-field"><span>Direction</span><div class="tt-seg">` +
            `<button type="button" class="tt-long${f.direction === 'long' ? ' on' : ''}" data-dir="long">▲ Long</button>` +
            `<button type="button" class="tt-short${f.direction === 'short' ? ' on' : ''}" data-dir="short">▼ Short</button></div></div>` +
          `<label class="tt-field"><span>Timeframe</span><select name="timeframe">${timeframes.map(t => `<option${t === f.timeframe ? ' selected' : ''}>${t}</option>`).join('')}</select></label>` +
        '</div>' +
        '<div class="tt-row">' +
          `<label class="tt-field"><span>Entry price *</span><input name="entry" type="number" step="any" min="0" value="${esc(f.entry)}" placeholder="e.g. 84500" required></label>` +
          `<label class="tt-field"><span>Stop loss</span><input name="stop" type="number" step="any" min="0" value="${esc(f.stop)}" placeholder="optional"></label>` +
          `<label class="tt-field"><span>Take profit</span><input name="target" type="number" step="any" min="0" value="${esc(f.target)}" placeholder="optional"></label>` +
        '</div>' +
        '<div class="tt-row">' +
          `<label class="tt-field"><span>Entry time</span><input name="entry_at" type="datetime-local" value="${toLocalInput(f.entry_at)}"></label>` +
          `<label class="tt-check"><input name="closed" type="checkbox"${f.closed ? ' checked' : ''}> Trade is closed</label>` +
        '</div>' +
        (f.closed ? '<div class="tt-row">' +
          `<label class="tt-field"><span>Close price *</span><input name="close_price" type="number" step="any" min="0" value="${esc(f.close_price)}" placeholder="exit price" required></label>` +
          `<label class="tt-field"><span>Close time</span><input name="closed_at" type="datetime-local" value="${toLocalInput(f.closed_at)}"></label></div>` : '') +
        `<div class="tt-preview">${rr ? `<span>Planned R:R <b>1 : ${rr.toFixed(2)}</b></span>` : ''}${f.closed && f.close_price && f.entry ? `<span>Result <b class="${cls(pnlPct(f, +f.close_price))}">${fmtPct(pnlPct({ ...f, entry: +f.entry }, +f.close_price))}</b></span>` : ''}</div>` +
        `<div class="tt-conf-head"><span>Confluences</span><span class="tt-meter tt-${level}"><b>${n}</b> selected</span></div>` +
        `<div class="tt-rule tt-${level}">${n >= MIN_CONF ? `✓ ${n} confluences — meets the ${MIN_CONF}+ rule.` : `Use at least <b>${MIN_CONF} confluences</b> for the best results${n ? ` — ${MIN_CONF - n} more to go.` : '.'}`}</div>` +
        Object.entries(CONFLUENCES).map(([g, items]) =>
          `<div class="tt-conf-group"><div class="tt-conf-title">${esc(g)}</div><div class="tt-chips">` +
          items.map(c => `<button type="button" class="tt-chip${f.confluences.includes(c) ? ' on' : ''}" data-conf="${esc(c)}">${esc(c)}</button>`).join('') +
          '</div></div>').join('') +
        `<div class="tt-conf-group"><div class="tt-conf-title">Custom</div><div class="tt-chips">${customConf.map(c => `<button type="button" class="tt-chip on" data-conf="${esc(c)}">${esc(c)} ✕</button>`).join('')}` +
          '<span class="tt-custom"><input class="tt-custom-input" maxlength="60" placeholder="Add your own…"><button type="button" class="tt-link" data-act="addconf">Add</button></span></div></div>' +
        `<label class="tt-field tt-notes"><span>Notes</span><textarea name="notes" rows="2" maxlength="2000" placeholder="Why you took it, what you learned…">${esc(f.notes)}</textarea></label>` +
        '<div class="tt-form-msg" role="alert"></div>' +
        `<button type="submit" class="edu-btn tt-submit">${editing ? 'Save changes' : '+ Add trade'}</button>` +
      '</form>';
    bindForm();
  }

  function readForm() {
    const fd = new FormData($('.tt-form'));
    const asset = fd.get('asset');
    form.customSymbol = asset === '__custom';
    form.symbol = form.customSymbol ? String(fd.get('symbol') || '').trim().toUpperCase() : asset;
    form.timeframe = fd.get('timeframe');
    form.entry = fd.get('entry'); form.stop = fd.get('stop'); form.target = fd.get('target');
    form.entry_at = fromLocalInput(fd.get('entry_at')) || Date.now();
    form.closed = !!fd.get('closed');
    if (form.closed) { form.close_price = fd.get('close_price') ?? form.close_price; form.closed_at = fromLocalInput(fd.get('closed_at')) || Date.now(); }
    form.notes = fd.get('notes');
  }

  function bindForm() {
    const fm = $('.tt-form');
    fm.querySelectorAll('[data-dir]').forEach(b => { b.onclick = () => { readForm(); form.direction = b.dataset.dir; renderForm(); }; });
    fm.querySelectorAll('[data-conf]').forEach(b => {
      b.onclick = () => {
        readForm();
        const c = b.dataset.conf, i = form.confluences.indexOf(c);
        if (i >= 0) form.confluences.splice(i, 1); else form.confluences.push(c);
        renderForm();
      };
    });
    const addConf = () => {
      const v = $('.tt-custom-input').value.trim();
      if (!v) return;
      readForm();
      if (!form.confluences.includes(v)) form.confluences.push(v);
      renderForm();
    };
    $('[data-act="addconf"]').onclick = addConf;
    $('.tt-custom-input').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addConf(); } };
    fm.querySelector('[name="closed"]').onchange = () => { readForm(); renderForm(); };
    fm.querySelector('[name="asset"]').onchange = () => { readForm(); renderForm(); const s = fm.ownerDocument.querySelector('.tt-form [name="symbol"]'); if (s) s.focus(); };
    ['entry', 'stop', 'target', 'close_price'].forEach(n => { const el = fm.querySelector(`[name="${n}"]`); if (el) el.onchange = () => { readForm(); renderForm(); }; });
    const cancel = $('[data-act="cancel"]');
    if (cancel) cancel.onclick = () => { editing = null; form = blankForm(); renderForm(); };
    fm.onsubmit = async e => {
      e.preventDefault();
      readForm();
      const msg = $('.tt-form-msg');
      if (!form.symbol) { msg.textContent = 'Type the symbol of the asset.'; return; }
      if (form.closed && !form.close_price) { msg.textContent = 'Enter the close price, or untick "Trade is closed".'; return; }
      const body = {
        symbol: form.symbol, direction: form.direction, timeframe: form.timeframe,
        entry: form.entry, stop: form.stop, target: form.target, entry_at: form.entry_at,
        close_price: form.closed ? form.close_price : '', closed_at: form.closed ? form.closed_at : null,
        confluences: form.confluences, notes: form.notes,
      };
      const btn = $('.tt-submit');
      btn.disabled = true;
      try {
        if (editing) {
          const { trade } = await api('/api/trades/update', { id: editing, ...body });
          trades = trades.map(t => (t.id === trade.id ? trade : t));
        } else {
          const { trade } = await api('/api/trades', body);
          trades.unshift(trade);
          trades.sort((a, b) => b.entry_at - a.entry_at);
        }
        editing = null; form = blankForm();
        renderForm(); refreshAll(); refreshLive();
      } catch (err) {
        msg.textContent = err.message; btn.disabled = false;
      }
    };
  }

  function renderList() {
    const list = trades.filter(t => filter === 'all' || (filter === 'open' ? !isClosed(t) : isClosed(t)));
    const row = t => {
      const closed = isClosed(t), px = closed ? t.close_price : live[t.symbol];
      const p = pnlPct(t, px), r = rMult(t, px);
      const open = expanded.has(t.id);
      return `<tr class="tt-tr${open ? ' open' : ''}" data-id="${t.id}">` +
        `<td>${fmtDate(t.entry_at)}</td><td class="tt-sym">${esc(t.symbol)}</td>` +
        `<td><span class="tt-side ${t.direction}">${t.direction === 'long' ? '▲ Long' : '▼ Short'}</span></td><td>${esc(t.timeframe)}</td>` +
        `<td>${fmtP(t.entry)}</td><td>${fmtP(t.stop)}</td>` +
        `<td>${closed ? fmtP(t.close_price) : px ? `<span class="tt-live" title="Live price">${fmtP(px)}</span>` : '<span class="tt-muted">open</span>'}</td>` +
        `<td class="${cls(p)}">${p == null ? '—' : (closed ? '' : '<i>') + fmtPct(p) + (closed ? '' : '</i>')}</td>` +
        `<td class="${cls(r)}">${fmtR(r)}</td>` +
        `<td><span class="tt-cc ${t.confluences.length >= MIN_CONF ? 'ok' : 'low'}" title="${esc(t.confluences.join(', '))}">${t.confluences.length}</span></td>` +
        `<td>${closed ? `<span class="tt-badge ${outcome(t)}">${{ win: 'Win', loss: 'Loss', be: 'B/E' }[outcome(t)]}</span>` : '<span class="tt-badge open">Open</span>'}</td>` +
        `<td class="tt-actions">${closed ? '' : '<button class="tt-link" data-act="close">Close</button>'}<button class="tt-link" data-act="edit">Edit</button><button class="tt-link danger" data-act="del">Delete</button></td></tr>` +
        (open ? `<tr class="tt-detail"><td colspan="12"><div class="tt-detail-chips">${t.confluences.map(c => `<span class="tt-chip on static">${esc(c)}</span>`).join('') || '<span class="tt-muted">No confluences logged</span>'}</div>${t.notes ? `<div class="tt-detail-notes">${esc(t.notes)}</div>` : ''}${t.target ? `<div class="tt-muted">Target ${fmtP(t.target)}${closed ? ` · closed ${fmtDate(t.closed_at)}` : ''}</div>` : closed ? `<div class="tt-muted">Closed ${fmtDate(t.closed_at)}</div>` : ''}</div></td></tr>` : '') +
        (t._closing ? `<tr class="tt-closing"><td colspan="12"><form class="tt-close-form"><span>Close ${esc(t.symbol)} at</span><input name="price" type="number" step="any" min="0" placeholder="exit price" value="${live[t.symbol] || ''}" required><input name="at" type="datetime-local" value="${toLocalInput(Date.now())}"><button class="edu-btn">Confirm close</button><button type="button" class="tt-link" data-act="cancelclose">Cancel</button><span class="tt-form-msg"></span></form></td></tr>` : '');
    };
    $('.tt-list-card').innerHTML =
      `<div class="tt-card-head"><h3>Your trades</h3><div class="tt-filters">${['all', 'open', 'closed'].map(k => `<button class="tt-filter${filter === k ? ' on' : ''}" data-filter="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div></div>` +
      (list.length
        ? '<div class="tt-table"><table><thead><tr><th>Entry time</th><th>Asset</th><th>Side</th><th>TF</th><th>Entry</th><th>Stop</th><th>Close</th><th>P&amp;L</th><th>R</th><th title="Confluences">Conf.</th><th>Status</th><th></th></tr></thead><tbody>' + list.map(row).join('') + '</tbody></table></div>'
        : `<div class="tt-empty">${trades.length ? 'No trades in this view.' : 'No trades yet — log your first one on the left. Pick at least 5 confluences.'}</div>`);
    bindList();
  }

  function bindList() {
    const card = $('.tt-list-card');
    card.querySelectorAll('[data-filter]').forEach(b => { b.onclick = () => { filter = b.dataset.filter; renderList(); }; });
    card.querySelectorAll('.tt-tr').forEach(tr => {
      const t = trades.find(x => x.id === tr.dataset.id);
      tr.onclick = e => {
        const act = e.target.closest('[data-act]');
        if (!act) { if (expanded.has(t.id)) expanded.delete(t.id); else expanded.add(t.id); renderList(); return; }
        if (act.dataset.act === 'close') { t._closing = true; renderList(); card.querySelector('.tt-close-form [name="price"]').focus(); }
        if (act.dataset.act === 'edit') {
          editing = t.id;
          form = { ...t, customSymbol: !KNOWN_SYMBOLS.has(t.symbol), entry: t.entry, stop: t.stop ?? '', target: t.target ?? '', closed: isClosed(t), close_price: t.close_price ?? '', closed_at: t.closed_at || Date.now(), confluences: [...t.confluences] };
          renderForm(); $('.tt-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        if (act.dataset.act === 'del' && confirm(`Delete this ${t.symbol} ${t.direction}? This can't be undone.`)) {
          api('/api/trades/delete', { id: t.id }).then(() => { trades = trades.filter(x => x.id !== t.id); refreshAll(); }).catch(err => alert(err.message));
        }
      };
    });
    const cf = card.querySelector('.tt-close-form');
    if (cf) {
      const t = trades.find(x => x._closing);
      cf.querySelector('[data-act="cancelclose"]').onclick = () => { delete t._closing; renderList(); };
      cf.onsubmit = async e => {
        e.preventDefault();
        const fd = new FormData(cf);
        try {
          const { trade } = await api('/api/trades/update', { id: t.id, close_price: fd.get('price'), closed_at: fromLocalInput(fd.get('at')) || Date.now() });
          trades = trades.map(x => (x.id === trade.id ? trade : x));
          refreshAll();
        } catch (err) { cf.querySelector('.tt-form-msg').textContent = err.message; }
      };
    }
  }

  function renderAnalytics() {
    const closed = trades.filter(isClosed);
    const el = $('.tt-analytics');
    if (!closed.length) {
      el.innerHTML = '<h3 class="edu-section-title">What\'s working</h3><div class="tt-card tt-empty">Close your first trade and this section will show which confluences and timeframes win most often.</div>';
      return;
    }
    const bar = s => `<span class="tt-bar"><span style="width:${s.winRate.toFixed(0)}%" class="${s.winRate >= 50 ? 'pos' : 'neg'}"></span></span>`;
    // Trophy only in ranked tables, on the best row with a real sample (3+ trades).
    const table = (title, rows, keyLabel, note, ranked = false) => {
      const best = ranked ? rows.findIndex(r => r.n >= 3 && r.winRate > 0) : -1;
      return (
      `<div class="tt-card tt-stat"><div class="tt-card-head"><h4>${title}</h4>${note ? `<span class="tt-muted">${note}</span>` : ''}</div>` +
      (rows.length ? `<div class="tt-table"><table><thead><tr><th>${keyLabel}</th><th>Trades</th><th>Win rate</th><th></th><th>Avg P&amp;L</th><th>Total R</th></tr></thead><tbody>` +
        rows.map((s, i) => `<tr${s.n < 3 ? ' class="tt-thin"' : ''}><td>${i === best ? '🏆 ' : ''}${esc(s.key)}</td><td>${s.n}</td><td class="${s.winRate >= 50 ? 'pos' : 'neg'}">${s.winRate.toFixed(0)}%</td><td class="tt-bar-cell">${bar(s)}</td><td class="${cls(s.avgPnl)}">${fmtPct(s.avgPnl)}</td><td class="${cls(s.totalR)}">${fmtR(s.totalR)}</td></tr>`).join('') +
        '</tbody></table></div>' : '<div class="tt-empty">Not enough data yet.</div>') + '</div>');
    };

    const conf = rank(group(closed, t => t.confluences));
    const tf = rank(group(closed, t => t.timeframe));
    const buckets = group(closed, t => (t.confluences.length >= MIN_CONF ? `${MIN_CONF}+ confluences` : `Under ${MIN_CONF}`)).sort((a, b) => a.key.localeCompare(b.key));
    const side = group(closed, t => (t.direction === 'long' ? 'Long' : 'Short'));
    const assets = rank(group(closed, t => t.symbol));
    const pairs = rank(group(closed, t => {
      const c = [...t.confluences].sort(), out = [];
      for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) out.push(`${c[i]} + ${c[j]}`);
      return out;
    }).filter(s => s.n >= 2)).slice(0, 8);
    const bestConf = conf.find(s => s.n >= 3), bestTf = tf.find(s => s.n >= 3);
    const five = buckets.find(b => b.key.startsWith(String(MIN_CONF))), under = buckets.find(b => b.key.startsWith('Under'));

    el.innerHTML =
      '<h3 class="edu-section-title">What\'s working</h3>' +
      '<div class="tt-insights">' +
        `<div class="tt-insight"><span class="tt-insight-label">Best confluence</span><span class="tt-insight-val">${bestConf ? esc(bestConf.key) : '—'}</span><span class="tt-muted">${bestConf ? `${bestConf.winRate.toFixed(0)}% win rate over ${bestConf.n} trades` : 'needs 3+ trades with the same confluence'}</span></div>` +
        `<div class="tt-insight"><span class="tt-insight-label">Best timeframe</span><span class="tt-insight-val">${bestTf ? esc(bestTf.key) : '—'}</span><span class="tt-muted">${bestTf ? `${bestTf.winRate.toFixed(0)}% win rate over ${bestTf.n} trades` : 'needs 3+ trades on one timeframe'}</span></div>` +
        `<div class="tt-insight"><span class="tt-insight-label">The ${MIN_CONF}-confluence rule</span><span class="tt-insight-val">${five ? five.winRate.toFixed(0) + '%' : '—'} <small>vs</small> ${under ? under.winRate.toFixed(0) + '%' : '—'}</span><span class="tt-muted">win rate with ${MIN_CONF}+ vs fewer confluences</span></div>` +
      '</div>' +
      (closed.length < 20 ? `<p class="tt-sample">Based on ${closed.length} closed trade${closed.length === 1 ? '' : 's'} — patterns become reliable after about 20. Faded rows have fewer than 3 trades.</p>` : '') +
      '<div class="tt-stats-grid">' +
        table('Confluences ranked by win rate', conf, 'Confluence', 'which ones actually work', true) +
        '<div class="tt-stack">' +
          table('Timeframes ranked by win rate', tf, 'Timeframe', '', true) +
          table('Confluence count', buckets, 'Setup') +
          table('Direction', side, 'Side') +
          table('Assets ranked by win rate', assets, 'Asset', '', true) +
        '</div>' +
      '</div>' +
      (pairs.length ? table('Strongest confluence pairs', pairs, 'Pair', 'used together in 2+ trades', true) : '');
  }

  return { init, state: () => ({ trades: trades.length, editing, filter, form: { ...form } }) };
})();
