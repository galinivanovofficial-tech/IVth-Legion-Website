/* Macro hub: economic + earnings calendars with trading-session context, and FRED macro charts.
   Everything is shown in the member's own timezone (auto-detected, can be changed and is remembered). */
(function () {
  'use strict';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = 86400000;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }

  // ───────────── time zones ─────────────
  const validTz = tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
  const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  let tz = (v => (v && validTz(v) ? v : browserTz))(store.get('legionTz', null));
  const tzListeners = new Set();
  function setTz(v) {
    if (!validTz(v)) return;
    tz = v; store.set('legionTz', v === browserTz ? null : v);
    windowCache.clear();
    tzListeners.forEach(fn => fn());
  }

  const fmtCache = new Map();
  function partsFmt(zone) {
    if (!fmtCache.has(zone)) fmtCache.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }));
    return fmtCache.get(zone);
  }
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  function parts(zone, t) {
    const o = {};
    for (const p of partsFmt(zone).formatToParts(new Date(t))) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: WD[o.weekday] };
  }
  const offset = (zone, t) => { const p = parts(zone, t); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000; };
  // wall-clock time in `zone` -> UTC ms (Date.UTC overflow handles day/month arithmetic)
  function zoned(zone, y, m, d, h = 0, mi = 0) {
    const guess = Date.UTC(y, m - 1, d, h, mi);
    let t = guess - offset(zone, guess);
    t = guess - offset(zone, t);
    return t;
  }
  const hhmm = (t, zone = tz) => { const p = parts(zone, t); return String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0'); };
  const dayKey = t => { const p = parts(tz, t); return p.y * 10000 + p.m * 100 + p.d; };
  const dayLabel = (t, opts = { weekday: 'long', day: 'numeric', month: 'short' }) => new Date(t).toLocaleDateString('en-GB', { timeZone: tz, ...opts });
  function utcLabel(zone = tz, t = Date.now()) {
    const off = Math.round(offset(zone, t) / 60000), sign = off < 0 ? '-' : '+', a = Math.abs(off);
    return 'UTC' + sign + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '');
  }
  // On Saturday/Sunday the finished week is history, so "this week" means the coming trading week.
  const isWeekend = () => { const wd = parts(tz, Date.now()).wd; return wd === 0 || wd === 6; };
  function weekRange(weekOffset) { // Monday 00:00 -> next Monday 00:00 in the member's timezone
    const p = parts(tz, Date.now()), dow = (p.wd + 6) % 7;
    const d0 = p.d - dow + (isWeekend() ? 7 : 0) + weekOffset * 7;
    return [zoned(tz, p.y, p.m, d0), zoned(tz, p.y, p.m, d0 + 7)];
  }
  function countdown(ms) {
    if (ms <= 0) return 'now';
    const m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    return Math.round(h / 24) + 'd';
  }

  // ───────────── trading sessions ─────────────
  // Hours are local to each financial centre, so DST shifts are handled automatically.
  const SESSIONS = [
    { id: 'AS', name: 'Asian session', city: 'Tokyo', zone: 'Asia/Tokyo', open: [9, 0], close: [18, 0], color: '#a78bfa' },
    { id: 'LS', name: 'London session', city: 'London', zone: 'Europe/London', open: [8, 0], close: [17, 0], color: '#5aa9e6' },
    { id: 'NYS', name: 'New York session', city: 'New York', zone: 'America/New_York', open: [8, 0], close: [17, 0], color: '#c9a84c' },
  ];
  const windowCache = new Map();
  function windowsFor(s, from, to) { // [open, close] UTC pairs covering [from, to]
    const key = s.id + ':' + Math.floor(from / DAY) + ':' + Math.ceil(to / DAY);
    if (windowCache.has(key)) return windowCache.get(key);
    const p = parts(s.zone, from), out = [];
    for (let k = -2; k <= Math.ceil((to - from) / DAY) + 2; k++) {
      const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + k)), wd = dt.getUTCDay();
      if (wd === 0 || wd === 6) continue;
      const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
      out.push([zoned(s.zone, y, m, d, ...s.open), zoned(s.zone, y, m, d, ...s.close)]);
    }
    if (windowCache.size > 60) windowCache.clear();
    windowCache.set(key, out);
    return out;
  }
  const sessionsAt = t => SESSIONS.filter(s => windowsFor(s, t - DAY, t + DAY).some(([a, b]) => t >= a && t < b));
  function badges(t) {
    const on = sessionsAt(t);
    if (!on.length) return '<span class="mh-ses off" title="Outside the Asian, London and New York sessions">OFF</span>';
    return on.map(s => `<span class="mh-ses" style="--c:${s.color}" title="${esc(s.name)} open (${s.city})">${s.id}</span>`).join('');
  }
  function sessionStatus(s, now) {
    const w = windowsFor(s, now - DAY, now + 6 * DAY);
    const cur = w.find(([a, b]) => now >= a && now < b);
    if (cur) return { open: true, at: cur[1], since: cur[0], pct: (now - cur[0]) / (cur[1] - cur[0]) };
    const nxt = w.find(([a]) => a > now);
    return { open: false, at: nxt ? nxt[0] : null };
  }

  // ───────────── shared bits ─────────────
  const FLAGS = { US: '🇺🇸', EU: '🇪🇺', GB: '🇬🇧', JP: '🇯🇵', CN: '🇨🇳', DE: '🇩🇪', FR: '🇫🇷', IT: '🇮🇹', CA: '🇨🇦', AU: '🇦🇺', NZ: '🇳🇿', CH: '🇨🇭' };
  const IMPACT = { 1: ['High', 'hi'], 0: ['Medium', 'md'], [-1]: ['Low', 'lo'] };
  const impactBars = imp => `<span class="mh-imp ${IMPACT[imp]?.[1] || 'lo'}" title="${IMPACT[imp]?.[0] || 'Low'} impact"><i></i><i></i><i></i></span>`;
  function num(v, max = 3) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 100 ? 1 : max }); }
  function val(v, e) {
    if (v == null || v === '') return '<span class="mh-dim">—</span>';
    const u = e.unit || '', pre = u && u !== '%' ? u : '';
    return esc(pre + num(v) + (e.scale || '') + (u === '%' ? '%' : ''));
  }
  const bigMoney = n => n == null ? '—' : (Math.abs(n) >= 1e12 ? '$' + (n / 1e12).toFixed(2) + 'T' : Math.abs(n) >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : '$' + (n / 1e6).toFixed(0) + 'M');
  const eps = n => n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  const surprise = (a, e) => (a == null || e == null || !e ? null : ((a - e) / Math.abs(e)) * 100);
  function tzOptions() {
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['UTC', 'Europe/London', 'Europe/Sofia', 'America/New_York', 'Asia/Tokyo']; }
    if (!zones.includes('UTC')) zones.unshift('UTC');
    if (!zones.includes(tz)) zones.unshift(tz);
    return zones.map(z => `<option value="${esc(z)}"${z === tz ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))}${z === browserTz ? ' (this device)' : ''}</option>`).join('');
  }

  // ═════════════ CALENDARS (economic + earnings) ═════════════
  const Cal = {
    root: null, tab: store.get('legionCalTab', 'econ'), week: 0, econ: null, earn: null, open: new Set(), timers: [],
    imp: new Set(store.get('legionCalImp', [1, 0])), countries: new Set(store.get('legionCalCountries', Object.keys(FLAGS))),
    idx: new Set(store.get('legionEarnIdx', ['ES', 'NQ', 'NYSE'])), q: '', eq: '', upcoming: null,

    init(id) {
      const root = document.getElementById(id);
      if (!root) return;
      if (this.root === root) { this.load(); this.side(); return; }
      this.root = root;
      root.innerHTML = `
        <div class="mh-cal">
          <div class="mh-main">
            <div class="mh-tabs">
              <button data-tab="econ">🗓 Economic calendar</button>
              <button data-tab="earn">💼 Earnings (ES · NQ · NYSE)</button>
              <span class="mh-tz-note" id="mh-tz-note"></span>
            </div>
            <div class="mh-toolbar" id="mh-toolbar"></div>
            <div id="mh-body" class="mh-body"></div>
          </div>
          <aside class="mh-side"><div id="mh-side" class="mh-side-live"></div><div id="mh-alert-card"></div></aside>
        </div>`;
      root.addEventListener('click', e => this.onClick(e));
      root.addEventListener('input', e => {
        if (e.target.id === 'mh-q') { this.q = e.target.value.trim().toLowerCase(); this.render(); }
        if (e.target.id === 'mh-eq') { this.eq = e.target.value.trim().toLowerCase(); this.render(); }
      });
      root.addEventListener('change', e => { if (e.target.id === 'mh-tz') setTz(e.target.value); });
      root.addEventListener('error', e => { if (e.target.classList?.contains('mh-logo')) e.target.replaceWith(Object.assign(document.createElement('span'), { className: 'mh-logo ph', textContent: e.target.alt.slice(0, 1) })); }, true);
      tzListeners.add(() => { if (this.root) { this.econ = this.earn = null; this.load(); this.side(); } });
      this.timers.push(setInterval(() => this.side(), 30000));
      this.timers.push(setInterval(() => { if (this.visible() && this.week === 0) this.load(true); }, 120000));
      this.load();
      this.side();
      Alerts.renderSettings();
    },
    visible() { return this.root && this.root.offsetParent !== null; },

    onClick(e) {
      const b = e.target.closest('button,[data-ev],[data-week]');
      if (!b) return;
      if (b.dataset.tab) { this.tab = b.dataset.tab; store.set('legionCalTab', this.tab); this.load(); }
      else if (b.dataset.week != null) { this.week = b.dataset.week === '0' ? 0 : this.week + Number(b.dataset.week); this.econ = this.earn = null; this.load(); }
      else if (b.dataset.imp != null) { this.toggle(this.imp, Number(b.dataset.imp)); store.set('legionCalImp', [...this.imp]); this.render(); }
      else if (b.dataset.cty) {
        if (b.dataset.cty === '*') this.countries = new Set(this.countries.size === Object.keys(FLAGS).length ? ['US'] : Object.keys(FLAGS));
        else this.toggle(this.countries, b.dataset.cty);
        store.set('legionCalCountries', [...this.countries]); this.render();
      } else if (b.dataset.idx) { this.toggle(this.idx, b.dataset.idx); store.set('legionEarnIdx', [...this.idx]); this.render(); }
      else if (b.dataset.ev) { this.open.has(b.dataset.ev) ? this.open.delete(b.dataset.ev) : this.open.add(b.dataset.ev); this.render(); }
    },
    toggle(set, v) { set.has(v) ? (set.size > 1 && set.delete(v)) : set.add(v); },

    async load(quiet) {
      const [from, to] = weekRange(this.week);
      const key = this.tab + ':' + from;
      this.root.querySelectorAll('.mh-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === this.tab));
      document.getElementById('mh-tz-note').innerHTML = `Times in <b>${esc(tz.replace(/_/g, ' '))}</b> (${utcLabel()})`;
      this.toolbar(from, to);
      const slot = this.tab === 'econ' ? 'econ' : 'earn';
      if (!quiet && (!this[slot] || this[slot].key !== key)) document.getElementById('mh-body').innerHTML = '<div class="mh-empty">Loading…</div>';
      try {
        const qs = `from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`;
        const d = await getJSON(this.tab === 'econ' ? '/api/macro/calendar?' + qs : '/api/macro/earnings?' + qs);
        this[slot] = { key, from, to, rows: this.tab === 'econ' ? d.events : d.rows };
      } catch (err) {
        if (!quiet) document.getElementById('mh-body').innerHTML = `<div class="mh-empty">${esc(err.message)} <button class="mh-btn" data-week="0">Retry</button></div>`;
        return;
      }
      this.render();
    },

    toolbar(from, to) {
      const label = `${dayLabel(from, { day: 'numeric', month: 'short' })} – ${dayLabel(to - 1, { day: 'numeric', month: 'short', year: 'numeric' })}`;
      const nav = `<div class="mh-nav"><button class="mh-btn" data-week="-1" aria-label="Previous week">‹</button>
        <span class="mh-week">${this.week === 0 ? (isWeekend() ? 'Coming week' : 'This week') : this.week === 1 ? 'Next week' : this.week === -1 ? 'Last week' : 'Week'} · ${esc(label)}</span>
        <button class="mh-btn" data-week="1" aria-label="Next week">›</button>${this.week ? '<button class="mh-btn" data-week="0">Today</button>' : ''}</div>`;
      const el = document.getElementById('mh-toolbar');
      if (this.tab === 'econ') {
        el.innerHTML = nav + `<div class="mh-filters">
          <div class="tt-chips">${[1, 0, -1].map(i => `<button class="tt-chip${this.imp.has(i) ? ' on' : ''}" data-imp="${i}">${impactBars(i)} ${IMPACT[i][0]}</button>`).join('')}</div>
          <div class="tt-chips"><button class="tt-chip${this.countries.size === Object.keys(FLAGS).length ? ' on' : ''}" data-cty="*">All</button>${Object.keys(FLAGS).map(c => `<button class="tt-chip${this.countries.has(c) ? ' on' : ''}" data-cty="${c}">${FLAGS[c]} ${c}</button>`).join('')}</div>
          <input id="mh-q" class="mh-search" placeholder="Search events (CPI, Fed, PMI…)" value="${esc(this.q)}">
        </div>`;
      } else {
        el.innerHTML = nav + `<div class="mh-filters">
          <div class="tt-chips">${[['ES', 'S&P 500 (ES)'], ['NQ', 'Nasdaq-100 (NQ)'], ['NYSE', 'NYSE large caps']].map(([k, l]) => `<button class="tt-chip${this.idx.has(k) ? ' on' : ''}" data-idx="${k}">${l}</button>`).join('')}</div>
          <input id="mh-eq" class="mh-search" placeholder="Search ticker or company" value="${esc(this.eq)}">
        </div>`;
      }
    },

    render() {
      if (this.tab === 'econ') this.renderEcon(); else this.renderEarn();
      this.root.querySelectorAll('[data-imp]').forEach(b => b.classList.toggle('on', this.imp.has(Number(b.dataset.imp))));
      this.root.querySelectorAll('[data-cty]').forEach(b => b.classList.toggle('on', b.dataset.cty === '*' ? this.countries.size === Object.keys(FLAGS).length : this.countries.has(b.dataset.cty)));
      this.root.querySelectorAll('[data-idx]').forEach(b => b.classList.toggle('on', this.idx.has(b.dataset.idx)));
    },

    renderEcon() {
      const body = document.getElementById('mh-body');
      if (!this.econ) return;
      const now = Date.now();
      const rows = this.econ.rows.filter(e => this.imp.has(e.importance) && this.countries.has(e.country) && (!this.q || (e.title + ' ' + e.country + ' ' + e.category).toLowerCase().includes(this.q)));
      if (!rows.length) { body.innerHTML = '<div class="mh-empty">No events match these filters this week.</div>'; return; }
      const nextId = (rows.find(e => Date.parse(e.date) > now) || {}).id;
      const days = new Map();
      for (const e of rows) { const t = Date.parse(e.date), k = dayKey(t); if (!days.has(k)) days.set(k, []); days.get(k).push(e); }
      const today = dayKey(now);
      let html = `<table class="mh-table"><thead><tr><th>Time</th><th title="Which trading sessions are open at release time">Session</th><th>Ctry</th><th>Event</th><th>Impact</th><th class="r">Actual</th><th class="r">Forecast</th><th class="r">Previous</th></tr></thead>`;
      for (const [k, list] of days) {
        const t0 = Date.parse(list[0].date);
        html += `<tbody><tr class="mh-day${k === today ? ' today' : ''}"><td colspan="8">${esc(dayLabel(t0))}${k === today ? ' <span class="mh-tag">Today</span>' : ''}<span class="mh-daycount">${list.length} event${list.length > 1 ? 's' : ''}</span></td></tr>`;
        let nowDrawn = k !== today;
        for (const e of list) {
          const t = Date.parse(e.date), past = t <= now;
          if (!nowDrawn && t > now) { nowDrawn = true; html += `<tr class="mh-now"><td colspan="8"><span>Now · ${hhmm(now)}</span></td></tr>`; }
          const cmp = e.actual != null && (e.forecast ?? e.previous) != null ? Math.sign(e.actual - (e.forecast ?? e.previous)) : 0;
          const live = Math.abs(t - now) < 15 * 60000;
          html += `<tr class="mh-ev${past ? ' past' : ''}${e.id === nextId ? ' next' : ''}${live ? ' live' : ''} imp${e.importance}" data-ev="${esc(e.id)}">
            <td class="mh-time">${hhmm(t)}${e.id === nextId ? `<small>in ${countdown(t - now)}</small>` : ''}</td>
            <td>${badges(t)}</td>
            <td class="mh-cty">${FLAGS[e.country] || ''} ${esc(e.country)}</td>
            <td class="mh-title">${esc(e.title)}${e.period ? ` <span class="mh-dim">(${esc(e.period)})</span>` : ''}</td>
            <td>${impactBars(e.importance)}</td>
            <td class="r mh-act ${cmp > 0 ? 'up' : cmp < 0 ? 'down' : ''}" title="${cmp ? (cmp > 0 ? 'Above' : 'Below') + ' forecast' : ''}">${val(e.actual, e)}${cmp ? (cmp > 0 ? ' ▲' : ' ▼') : ''}</td>
            <td class="r">${val(e.forecast, e)}</td><td class="r mh-dim">${val(e.previous, e)}</td></tr>`;
          if (this.open.has(e.id)) {
            html += `<tr class="mh-detail"><td colspan="8">${e.comment ? `<p>${esc(e.comment)}${e.comment.length >= 700 ? '…' : ''}</p>` : '<p class="mh-dim">No description for this release.</p>'}
              <div class="mh-meta">${e.source ? `Source: ${e.sourceUrl ? `<a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(e.source)}</a>` : esc(e.source)}` : ''}
              ${e.ticker ? ` · TradingView: <b>${esc(e.ticker)}</b>` : ''} · Released ${esc(dayLabel(t, { weekday: 'short', day: 'numeric', month: 'short' }))} ${hhmm(t)} your time · ${SESSIONS.map(s => `${s.city} ${hhmm(t, s.zone)}`).join(' · ')}</div></td></tr>`;
          }
        }
        if (!nowDrawn) html += `<tr class="mh-now"><td colspan="8"><span>Now · ${hhmm(now)}</span></td></tr>`;
        html += '</tbody>';
      }
      body.innerHTML = html + '</table><p class="mh-foot">▲/▼ = actual above/below forecast (or previous). Whether that is good or bad depends on the release — e.g. a higher unemployment rate is weaker data. Click any event for details. Data: TradingView economic calendar.</p>';
    },

    renderEarn() {
      const body = document.getElementById('mh-body');
      if (!this.earn) return;
      const now = Date.now();
      const rows = this.earn.rows.filter(r => r.idx.some(i => this.idx.has(i)) && (!this.eq || (r.sym + ' ' + r.name).toLowerCase().includes(this.eq)));
      const all = this.earn.rows;
      const summary = `<div class="mh-sum">
        <div><b>${all.length}</b><span>reports</span></div>
        <div><b>${all.filter(r => r.idx.includes('ES')).length}</b><span>in ES (S&amp;P 500)</span></div>
        <div><b>${all.filter(r => r.idx.includes('NQ')).length}</b><span>in NQ (Nasdaq-100)</span></div>
        <div><b>${all.filter(r => r.cap >= 200e9).length}</b><span>mega caps ($200B+)</span></div>
        <div class="mh-movers">${[...all].sort((a, b) => b.cap - a.cap).slice(0, 6).map(r => `<span title="${esc(r.name)} · ${bigMoney(r.cap)}">${esc(r.sym)}</span>`).join('') || '<span class="mh-dim">—</span>'}</div>
      </div>`;
      if (!rows.length) { body.innerHTML = summary + `<div class="mh-empty">No ${all.length ? 'matching ' : ''}ES / NQ / NYSE earnings this week.${all.length ? '' : ' Earnings season peaks mid-January, April, July and October — try next week.'}</div>`; return; }
      const days = new Map();
      for (const r of rows) { const k = dayKey(r.ts); if (!days.has(k)) days.set(k, []); days.get(k).push(r); }
      const today = dayKey(now);
      const WHEN = { bmo: ['Before the open', 'Pre-market'], amc: ['After the close', 'After hours'], dmh: ['During market hours', 'Intraday'] };
      let html = summary;
      for (const [k, list] of [...days].sort((a, b) => a[0] - b[0])) {
        html += `<div class="mh-eday${k === today ? ' today' : ''}"><div class="mh-eday-h">${esc(dayLabel(list[0].ts))}${k === today ? ' <span class="mh-tag">Today</span>' : ''}<span class="mh-daycount">${list.length} report${list.length > 1 ? 's' : ''}</span></div>`;
        for (const w of ['bmo', 'dmh', 'amc']) {
          const grp = list.filter(r => r.when === w).sort((a, b) => b.cap - a.cap);
          if (!grp.length) continue;
          html += `<div class="mh-egrp"><div class="mh-egrp-h">${WHEN[w][0]}</div><table class="mh-table mh-earn"><thead><tr><th>Company</th><th>Time · session</th><th class="r">Mkt cap</th><th class="r">EPS</th><th class="r">Revenue</th></tr></thead><tbody>`;
          for (const r of grp) {
            const fig = (act, est, f) => {
              if (!r.reported) return `${f(est)}<small class="mh-dim">estimate</small>`;
              const v = surprise(act, est);
              return `<b>${f(act)}</b>${v == null ? '' : ` <em class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</em>`}<small class="mh-dim">est. ${f(est)}</small>`;
            };
            html += `<tr class="${r.reported ? 'past' : ''}${r.cap >= 200e9 ? ' mega' : ''}">
              <td><div class="mh-co">${r.logo ? `<img class="mh-logo" src="https://s3-symbol-logo.tradingview.com/${esc(r.logo)}.svg" alt="${esc(r.sym)}" loading="lazy">` : `<span class="mh-logo ph">${esc(r.sym[0])}</span>`}<div><span class="mh-co-t"><b>${esc(r.sym)}</b>${r.cap >= 200e9 ? '<span class="mh-star" title="Mega cap: can move the whole index">★</span>' : ''}${r.idx.map(i => `<span class="mh-idx ${i}">${i}</span>`).join('')}</span><span class="mh-co-n">${esc(r.name)}</span></div></div></td>
              <td class="mh-time">${hhmm(r.ts)} <span class="mh-when">${WHEN[r.when][1]}</span><div>${badges(r.ts)}</div></td>
              <td class="r">${bigMoney(r.cap)}</td>
              <td class="r mh-fig">${fig(r.eps, r.epsEst, eps)}</td>
              <td class="r mh-fig">${fig(r.rev, r.revEst, bigMoney)}</td></tr>`;
          }
          html += '</tbody></table></div>';
        }
        html += '</div>';
      }
      body.innerHTML = html + '<p class="mh-foot">ES = S&amp;P 500 member, NQ = Nasdaq-100 member, NYSE = NYSE-listed company worth $10B+. Times are the scheduled release in your timezone; "Pre-market" reports land before the 09:30 New York open and "After hours" after the 16:00 close. Surprise % compares actual with the consensus estimate. Data: TradingView.</p>';
    },

    // ── side panel: clock, timezone, sessions, next high-impact releases ──
    async side() {
      const el = document.getElementById('mh-side');
      if (!el) return;
      const now = Date.now();
      const [d0] = [zoned(tz, ...(p => [p.y, p.m, p.d])(parts(tz, now)))];
      const pct = t => ((t - d0) / DAY) * 100;
      const sesRows = SESSIONS.map(s => {
        const st = sessionStatus(s, now);
        const segs = windowsFor(s, d0, d0 + DAY).map(([a, b]) => [Math.max(a, d0), Math.min(b, d0 + DAY)]).filter(([a, b]) => b > a);
        const hours = segs.length ? segs.map(([a, b]) => `${hhmm(a)}–${b >= d0 + DAY ? '24:00' : hhmm(b)}`).join(', ') : 'closed today';
        return { s, st, segs, hours };
      });
      const overlap = (() => { // London + New York overlap today (the most liquid window)
        const L = windowsFor(SESSIONS[1], d0, d0 + DAY), N = windowsFor(SESSIONS[2], d0, d0 + DAY);
        for (const [a, b] of L) for (const [c, d] of N) { const s = Math.max(a, c, d0), e = Math.min(b, d, d0 + DAY); if (e > s) return [s, e]; }
        return null;
      })();
      const hi = this.upcoming ? this.upcoming.filter(e => Date.parse(e.date) > now - 5 * 60000 && e.importance === 1).slice(0, 6) : null;
      el.innerHTML = `
        <div class="mh-card">
          <div class="mh-clock">${hhmm(now)}<span>${esc(dayLabel(now, { weekday: 'short', day: 'numeric', month: 'short' }))} · ${utcLabel()}</span></div>
          <label class="mh-lbl" for="mh-tz">Your timezone</label>
          <select id="mh-tz" class="mh-select">${tzOptions()}</select>
          ${tz !== browserTz ? `<button class="mh-link" onclick="LegionMacroHub.setTz('${esc(browserTz)}')">Use this device's timezone (${esc(browserTz)})</button>` : ''}
        </div>
        <div class="mh-card">
          <div class="mh-card-h">Trading sessions <span class="mh-dim">· your time</span></div>
          ${sesRows.map(({ s, st, hours }) => `
            <div class="mh-sess${st.open ? ' open' : ''}" style="--c:${s.color}">
              <div class="mh-sess-top"><span class="mh-ses" style="--c:${s.color}">${s.id}</span><b>${s.name}</b><span class="mh-sess-st">${st.open ? 'OPEN' : 'Closed'}</span></div>
              <div class="mh-sess-sub">${esc(hours)} <span class="mh-dim">(${s.city} ${String(s.open[0]).padStart(2, '0')}:00–${s.close[0]}:00)</span></div>
              <div class="mh-sess-sub">${st.open ? `Closes in <b>${countdown(st.at - now)}</b>` : st.at ? `Opens in <b>${countdown(st.at - now)}</b> · ${esc(dayLabel(st.at, { weekday: 'short' }))} ${hhmm(st.at)}` : ''}</div>
              ${st.open ? `<div class="mh-prog"><i style="width:${(st.pct * 100).toFixed(1)}%"></i></div>` : ''}
            </div>`).join('')}
          <div class="mh-tl">
            ${sesRows.map(({ s, segs }) => `<div class="mh-tl-row"><span>${s.id}</span><div>${segs.map(([a, b]) => `<i style="left:${pct(a)}%;width:${pct(b) - pct(a)}%;background:${s.color}"></i>`).join('')}</div></div>`).join('')}
            <div class="mh-tl-now" style="left:calc(34px + (100% - 34px) * ${(pct(now) / 100).toFixed(4)})"></div>
            <div class="mh-tl-ax"><span></span><div>${[0, 6, 12, 18, 24].map(h => `<em style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}</em>`).join('')}</div></div>
          </div>
          ${overlap ? `<p class="mh-note"><b>London + New York overlap:</b> ${hhmm(overlap[0])}–${hhmm(overlap[1])} your time. This is the most liquid window of the day, when US data hits during both sessions.</p>` : '<p class="mh-note">No London / New York overlap today (weekend).</p>'}
          <p class="mh-note mh-dim">Sessions follow local office hours in Tokyo, London and New York, so daylight-saving changes are handled automatically. The NYSE cash session is 09:30–16:00 New York (${hhmm(zoned('America/New_York', ...(p => [p.y, p.m, p.d, 9, 30])(parts('America/New_York', now))))}–${hhmm(zoned('America/New_York', ...(p => [p.y, p.m, p.d, 16, 0])(parts('America/New_York', now))))} your time).</p>
        </div>
        <div class="mh-card">
          <div class="mh-card-h">Next high-impact releases</div>
          ${hi == null ? '<div class="mh-dim">Loading…</div>' : hi.length ? hi.map(e => { const t = Date.parse(e.date); return `
            <div class="mh-nx"><div class="mh-nx-t">${hhmm(t)}<span>${esc(dayLabel(t, { weekday: 'short', day: 'numeric' }))}</span></div>
            <div class="mh-nx-b"><b>${FLAGS[e.country] || ''} ${esc(e.title)}</b><span>${badges(t)} <span class="mh-cd">${t > now ? 'in ' + countdown(t - now) : 'just released'}</span></span></div></div>`; }).join('') : '<div class="mh-dim">No high-impact releases in the next 8 days.</div>'}
        </div>`;
      const sel = el.querySelector('#mh-tz');
      if (sel && document.activeElement !== sel) sel.value = tz;
      if (!this.upcoming || now - (this.upcomingAt || 0) > 5 * 60000) {
        this.upcomingAt = now;
        getJSON(`/api/macro/calendar?from=${new Date(now - 3600000).toISOString()}&to=${new Date(now + 8 * DAY).toISOString()}`)
          .then(d => { this.upcoming = d.events; this.side(); }).catch(() => { this.upcoming = []; });
      }
    },
  };

  // ═════════════ MACRO CHARTS (FRED) ═════════════
  const WHY = {
    usintr: 'The Fed funds rate is the price of dollars. Hikes tighten liquidity, and cuts loosen it, which is usually a tailwind for BTC and the Nasdaq.',
    jpintr: 'BoJ hikes can unwind the yen carry trade. Aug-2024 showed how fast that hits global risk assets.',
    euintr: 'ECB policy drives EUR/USD and, through it, the dollar index.',
    us10y: 'The global discount rate: higher long yields pressure stock valuations and long-duration assets.',
    us02y: 'The bond market\'s forecast of Fed policy over the next 2 years.',
    t10y2y: 'Below zero = inverted curve, a classic recession warning. Re-steepening after an inversion has often come just before downturns.',
    real10: 'Yield after inflation, and the opportunity cost of holding gold and BTC. Falling real yields support hard assets.',
    jp10y: 'Rising JGB yields pull Japanese capital home and can drain global liquidity.',
    cpi: 'Headline inflation. Hotter prints mean a more hawkish Fed.',
    corecpi: 'Inflation excluding food and energy. The trend the Fed watches most closely in CPI.',
    ppi: 'Producer prices often lead consumer inflation by a few months.',
    corepce: 'The Fed\'s preferred inflation gauge. Its target is 2%.',
    unrate: 'A rising unemployment rate (Sahm rule: +0.5pt from the low) has marked the start of past recessions.',
    nfp: 'Jobs added each month. Big surprises move yields, the dollar and BTC within seconds of 08:30 New York.',
    claims: 'The fastest labour signal (weekly). A sustained rise above ~250K signals the job market is cracking.',
    gdp: 'Quarterly growth of the US economy (annualized).',
    retail: 'Consumer spending is about 70% of US GDP.',
    umcsent: 'How households feel, plus their inflation expectations.',
    m2: 'Money supply growth. Global liquidity is one of the strongest drivers of the BTC cycle.',
    walcl: 'Expanding = QE (adds liquidity), shrinking = QT (drains it).',
    dollar: 'A strong dollar tightens global financial conditions and is usually a headwind for crypto.',
    hy: 'The extra yield junk bonds pay. Spikes signal credit stress and risk-off.',
    baa: 'Long-history credit stress gauge: it spiked in 1987, 2001, 2008, 2020. Widening spreads usually lead equity and crypto drawdowns.',
    vix: 'Implied S&P 500 volatility. Above 20 = stressed markets; spikes above 30 mark panic and often tradable bottoms.',
    oil: 'Energy drives headline inflation. Oil spikes feed CPI a few months later.',
    breakeven: 'What the bond market expects inflation to average over 10 years. The Fed watches it for de-anchoring.',
    sahm: 'Triggers when the 3-month unemployment average rises 0.5pt above its 12-month low. It has flagged every US recession since 1970.',
    jolts: 'Unfilled jobs. Falling openings cool wage growth before unemployment rises.',
    wages: 'Wage growth above ~3.5% keeps services inflation sticky.',
    indpro: 'Factory, mining and utility output. Negative YoY often lines up with recessions (grey bands).',
    housing: 'New homes started. Housing turns before the wider economy and is very rate-sensitive.',
  };
  const TONE = { bull: 'bullish', bear: 'bearish', neutral: 'neutral' };
  const TONECLS = { bull: 'up', bear: 'down', neutral: 'mh-dim' };
  const RANGES = [['1Y', 365], ['3Y', 1095], ['5Y', 1826], ['10Y', 3652], ['20Y', 7305], ['MAX', 0]];
  let RECESSIONS = []; // NBER US recessions [start, end] ms, shaded on every chart

  const Macro = {
    root: null, data: null, range: (r => (RANGES.some(x => x[0] === r) ? r : '20Y'))(store.get('legionMacroRange2', '20Y')), group: 'All', modal: null, checked: 0,
    async init(id) {
      const root = document.getElementById(id);
      if (!root) return;
      if (this.root === root && this.data) { this.drawAll(); return; }
      this.root = root;
      root.innerHTML = '<div class="mh-empty">Loading macro data…</div>';
      root.addEventListener('click', e => {
        const cv = e.target.closest('canvas[data-series]');
        if (cv) return this.openModal(cv.dataset.series);
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.open) return this.openModal(b.dataset.open);
        if (b.dataset.range) { this.range = b.dataset.range; store.set('legionMacroRange2', this.range); this.render(); }
        if (b.dataset.group) { this.group = b.dataset.group; this.render(); }
        if (b.dataset.jump) {
          if (!document.getElementById('mh-c-' + b.dataset.jump)) { this.group = 'All'; this.render(); }
          document.getElementById('mh-c-' + b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      tzListeners.add(() => { if (this.data) this.render(); });
      root.addEventListener('pointermove', e => {
        const cv = e.target.closest('canvas[data-series]');
        if (!cv || e.pointerType === 'touch') return;
        cv._hover = e.clientX - cv.getBoundingClientRect().left;
        const s = this.byId(cv.dataset.series);
        plot(cv, s, ...this.windowFor(s, this.range), { fmt: this.fmt.bind(this), hover: cv._hover });
      });
      root.addEventListener('pointerout', e => {
        const cv = e.target.closest?.('canvas[data-series]');
        if (!cv || cv.contains(e.relatedTarget)) return;
        cv._hover = null;
        const s = this.byId(cv.dataset.series);
        plot(cv, s, ...this.windowFor(s, this.range), { fmt: this.fmt.bind(this) });
      });
      setInterval(() => { if (this.root?.offsetParent || this.modal?.open) this.refresh(); }, 10 * 60000);
      window.addEventListener('resize', () => { if (this.root && this.root.offsetParent) this.drawAll(); });
      try { this.data = await getJSON('/api/macro/series'); }
      catch (err) { root.innerHTML = `<div class="mh-empty">${esc(err.message)}</div>`; this.root = null; return; }
      for (const s of this.data.series) s.points = s.points.map(([d, v]) => [d * DAY, v]);
      RECESSIONS = (this.data.recessions || []).map(([a, b]) => [a * DAY, b * DAY]);
      this.checked = Date.now();
      this.render();
    },

    stats(s) {
      const p = s.points, last = p.at(-1);
      const dense = p.length > 2 && (last[0] - p.at(-2)[0]) < 10 * DAY; // daily / weekly data -> compare with 1 month ago
      let prev;
      if (s.kind === 'step') prev = [...p].reverse().find(x => x[1] !== last[1]) || p[0];
      else if (dense) prev = [...p].reverse().find(x => x[0] <= last[0] - 30 * DAY) || p[0];
      else prev = p.at(-2);
      const chg = last[1] - prev[1];
      let k = p.length - 1;
      while (k > 0 && p[k - 1][1] === last[1]) k--; // start of the current rate level
      const recent = s.kind !== 'step' || Date.now() - p[k][0] < 120 * DAY;
      const flat = Math.abs(chg) < (Math.abs(last[1]) > 50 ? 0.05 : 0.005) || !recent;
      const [upL, dnL, upT, dnT] = s.bias;
      return { last, prev, chg, dense, label: flat ? (s.flat || 'Stable') : chg > 0 ? upL : dnL, tone: flat ? 'neutral' : chg > 0 ? upT : dnT };
    },
    fmt(s, v, signed) {
      const dp = s.unit === 'K' ? 0 : s.unit === 'T' ? 2 : Math.abs(v) >= 100 ? 1 : 2;
      const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
      return (v < 0 ? '-' : signed ? '+' : '') + (s.prefix || '') + n + (s.unit === '%' ? '%' : s.unit ? s.unit : '');
    },

    render() {
      const d = this.data, root = this.root;
      const groups = ['All', ...new Set(d.series.map(s => s.group))];
      const shown = d.series.filter(s => this.group === 'All' || s.group === this.group);
      const now = Date.now();
      const nextTxt = n => n ? `${esc(dayLabel(Date.parse(n.date), { weekday: 'short', day: 'numeric', month: 'short' }))} ${hhmm(Date.parse(n.date))}${n.estimated ? ' <span class="mh-dim" title="Scheduled by rule (first Friday, 08:30 New York); not yet in the live calendar">(est.)</span>' : ''}` : '—';
      root.innerHTML = `
        ${d.banks?.length ? `<div class="panel mh-panel"><div class="panel-header"><span class="panel-title">🏦 Central bank rates</span><span class="panel-badge">Live</span></div>
          <div class="mh-banks">${d.banks.map(b => { const ch = b.prev == null ? 0 : +(b.rate - b.prev).toFixed(2); return `
            <div class="mh-bank"><div class="mh-bank-h">${FLAGS[b.country] || ''} <span>${esc(b.bank)}</span></div>
            <div class="mh-bank-r">${Number(b.rate).toFixed(2)}%<small class="${ch > 0 ? 'down' : ch < 0 ? 'up' : ''}">${ch > 0 ? '▲ hike +' + ch : ch < 0 ? '▼ cut ' + ch : 'hold'}</small></div>
            <div class="mh-bank-s">Last: ${esc(dayLabel(Date.parse(b.date), { day: 'numeric', month: 'short' }))}${b.next ? ` · Next: <b>${esc(dayLabel(Date.parse(b.next), { day: 'numeric', month: 'short' }))}</b> <span class="mh-dim">(${countdown(Date.parse(b.next) - now)})</span>` : ''}</div></div>`; }).join('')}</div></div>` : ''}
        <div class="panel mh-panel"><div class="panel-header"><span class="panel-title">📋 Macro snapshot</span><span class="panel-badge" title="Server pulls FRED every 3 hours and right after releases; this page re-checks every 10 minutes">Checked ${hhmm(this.checked || Date.now())}</span></div>
          <div class="mh-scroll"><table class="mh-table mh-snap"><thead><tr><th>Indicator</th><th class="r">Latest</th><th class="r">Change</th><th>Read</th><th>As of</th><th>Next release (your time)</th></tr></thead><tbody>
          ${d.series.map(s => { const st = this.stats(s); return `<tr><td><button class="mh-jump" data-jump="${s.id}"><b>${esc(s.code)}</b> <span>${esc(s.name)}</span></button></td>
            <td class="r mh-act">${this.fmt(s, st.last[1])}</td><td class="r ${TONECLS[st.tone]}">${this.fmt(s, st.chg, true)}<small class="mh-dim"> ${s.kind === 'step' ? 'last move' : st.dense ? '1M' : 'vs prior'}</small></td>
            <td><span class="macro-sentiment ${TONE[st.tone]}">${esc(st.label)}</span></td>
            <td class="mh-dim">${esc(new Date(st.last[0]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }))}</td>
            <td>${nextTxt(s.next)}</td></tr>`; }).join('')}
          </tbody></table></div>
          <p class="mh-foot">Read colour = the usual effect on risk assets (crypto and equities): green supportive, red headwind, gold neutral. Grey bands on the charts mark US recessions (NBER). Daily series compare with one month ago, rates with their last move, and monthly or quarterly data with the prior release.</p></div>
        <div class="mh-ctl">
          <div class="tt-chips">${groups.map(g => `<button class="tt-chip${g === this.group ? ' on' : ''}" data-group="${g}">${g}</button>`).join('')}</div>
          <div class="tt-chips">${RANGES.map(([r]) => `<button class="tt-chip${r === this.range ? ' on' : ''}" data-range="${r}">${r}</button>`).join('')}</div>
        </div>
        <div class="mh-grid">${shown.map(s => { const st = this.stats(s); return `
          <div class="mh-chart" id="mh-c-${s.id}">
            <div class="mh-chart-h"><div><b>${esc(s.code)}</b><span>${esc(s.name)}</span></div>
              <div class="mh-chart-v">${this.fmt(s, st.last[1])}<small class="${TONECLS[st.tone]}">${this.fmt(s, st.chg, true)}</small></div>
              <button class="mh-exp" data-open="${s.id}" title="Open full screen" aria-label="Open ${esc(s.code)} full screen">⤢</button></div>
            <div class="mh-cv"><canvas data-series="${s.id}" title="Click to open full screen"></canvas></div>
            <div class="mh-chart-f"><span class="macro-sentiment ${TONE[st.tone]}">${esc(st.label)}</span><span>Next: ${nextTxt(s.next)}</span></div>
            <p class="mh-why">${esc(WHY[s.id] || '')} <span class="mh-dim">${esc(s.note ? s.note + ' ' : '')}${esc(s.source)} · since ${new Date(s.points[0][0]).getUTCFullYear()}</span></p>
          </div>`; }).join('')}</div>`;
      this.drawAll();
    },

    byId(id) { return this.data.series.find(x => x.id === id); },
    // preset window: range start (or first print) -> today for rates, -> the latest print for releases
    windowFor(s, r) {
      const days = RANGES.find(x => x[0] === r)[1];
      const end = s.kind === 'step' ? Date.now() : s.points.at(-1)[0];
      return [days ? Math.max(s.points[0][0], Date.now() - days * DAY) : s.points[0][0], end]; // pre-1970 times are negative
    },
    drawAll() {
      this.root?.querySelectorAll('canvas[data-series]').forEach(cv => {
        const s = this.byId(cv.dataset.series);
        if (s) plot(cv, s, ...this.windowFor(s, this.range), { fmt: this.fmt.bind(this), hover: cv._hover });
      });
      if (this.modal?.open) this.drawModal();
    },

    async refresh() {
      try {
        const d = await getJSON('/api/macro/series');
        for (const s of d.series) s.points = s.points.map(([t, v]) => [t * DAY, v]);
        RECESSIONS = (d.recessions || []).map(([a, b]) => [a * DAY, b * DAY]);
        this.data = d; this.checked = Date.now();
        if (this.root?.offsetParent) this.render();
        if (this.modal?.open) this.renderModal(true);
      } catch { /* keep showing the last good data */ }
    },

    // ── full-screen chart ──
    openModal(id) {
      const s = this.byId(id);
      if (!s) return;
      if (!this.modal) {
        const el = document.createElement('div');
        el.className = 'mh-modal';
        el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
        document.body.appendChild(el);
        this.modal = { el };
        el.addEventListener('click', e => {
          if (e.target === el) return this.closeModal();
          const b = e.target.closest('button');
          if (!b) return;
          if (b.dataset.m === 'close') this.closeModal();
          if (b.dataset.m === 'prev' || b.dataset.m === 'next') this.stepModal(b.dataset.m === 'next' ? 1 : -1);
          if (b.dataset.m === 'reset') { this.setWindow(...this.windowFor(this.byId(this.modal.id), this.modal.range)); }
          if (b.dataset.mrange) { this.modal.range = b.dataset.mrange; this.setWindow(...this.windowFor(this.byId(this.modal.id), b.dataset.mrange)); this.renderModal(true); }
        });
        document.addEventListener('keydown', e => {
          if (!this.modal?.open || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
          if (e.key === 'Escape') this.closeModal();
          if (e.key === 'ArrowRight') this.stepModal(1);
          if (e.key === 'ArrowLeft') this.stepModal(-1);
        });
        window.addEventListener('resize', () => { if (this.modal?.open) this.drawModal(); });
      }
      this.modal.open = true;
      this.modal.id = id;
      this.modal.range = this.range;
      [this.modal.a, this.modal.b] = this.windowFor(s, this.range);
      this.modal.el.style.display = 'block';
      document.body.classList.add('mh-modal-open');
      this.renderModal();
    },
    closeModal() {
      if (!this.modal?.open) return;
      this.modal.open = false;
      this.modal.el.style.display = 'none';
      document.body.classList.remove('mh-modal-open');
    },
    stepModal(dir) {
      const list = this.data.series, i = list.findIndex(s => s.id === this.modal.id);
      this.openModal(list[(i + dir + list.length) % list.length].id);
    },
    setWindow(a, b) {
      const s = this.byId(this.modal.id), P = s.points;
      const minT = P[0][0], maxT = Math.max(Date.now(), P.at(-1)[0]);
      const minSpan = Math.max(21 * DAY, gapOf(s) * 6);
      let span = Math.min(maxT - minT, Math.max(minSpan, b - a));
      a = Math.max(minT, Math.min(a, maxT - span));
      this.modal.a = a; this.modal.b = a + span;
      this.drawModal();
    },
    renderModal(keepWindow) {
      const m = this.modal, s = this.byId(m.id), st = this.stats(s);
      const list = this.data.series, i = list.findIndex(x => x.id === m.id);
      m.el.innerHTML = `<div class="mh-mbox">
        <div class="mh-mhead">
          <div class="mh-mtitle"><b>${esc(s.code)}</b><span>${esc(s.name)}</span></div>
          <div class="mh-mval">${this.fmt(s, st.last[1])}<small class="${TONECLS[st.tone]}">${this.fmt(s, st.chg, true)}</small><span class="macro-sentiment ${TONE[st.tone]}">${esc(st.label)}</span></div>
          <div class="mh-mbtns"><button class="mh-btn" data-m="prev" title="Previous chart (←)">‹</button><span>${i + 1} / ${list.length}</span><button class="mh-btn" data-m="next" title="Next chart (→)">›</button><button class="mh-btn" data-m="close" title="Close (Esc)">✕</button></div>
        </div>
        <div class="mh-mbar">
          <div class="tt-chips">${RANGES.map(([r]) => `<button class="tt-chip${r === m.range ? ' on' : ''}" data-mrange="${r}">${r}</button>`).join('')}<button class="tt-chip" data-m="reset">Reset zoom</button></div>
          <span class="mh-dim">Scroll or pinch to zoom · drag to pan · double-click to reset · ← → next chart</span>
        </div>
        <div class="mh-mstats" id="mh-mstats"></div>
        <div class="mh-mcv"><canvas id="mh-mcanvas"></canvas></div>
        <p class="mh-why">${esc(WHY[s.id] || '')} <span class="mh-dim">${esc(s.note ? s.note + ' ' : '')}${esc(s.source)} · history since ${new Date(s.points[0][0]).getUTCFullYear()} · grey bands = US recessions (NBER)</span></p>
      </div>`;
      if (!keepWindow) [m.a, m.b] = this.windowFor(s, m.range);
      const cv = m.el.querySelector('#mh-mcanvas');
      const tAt = x => m.a + ((x - (cv._geo?.L || 0)) / (cv._geo?.pw || 1)) * (m.b - m.a);
      const ptrs = new Map();
      let drag = null, pinch = null;
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const r = cv.getBoundingClientRect(), t = tAt(e.clientX - r.left), k = e.deltaY > 0 ? 1.18 : 1 / 1.18;
        this.setWindow(t - (t - m.a) * k, t + (m.b - t) * k);
      }, { passive: false });
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId);
        ptrs.set(e.pointerId, e.clientX);
        if (ptrs.size === 1) drag = { x: e.clientX, a: m.a, b: m.b };
        if (ptrs.size === 2) { const xs = [...ptrs.values()]; pinch = { d: Math.abs(xs[0] - xs[1]) || 1, a: m.a, b: m.b, c: tAt((xs[0] + xs[1]) / 2 - cv.getBoundingClientRect().left) }; drag = null; }
      });
      cv.addEventListener('pointermove', e => {
        const r = cv.getBoundingClientRect();
        if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, e.clientX);
        if (pinch && ptrs.size === 2) {
          const xs = [...ptrs.values()], k = pinch.d / (Math.abs(xs[0] - xs[1]) || 1);
          this.setWindow(pinch.c - (pinch.c - pinch.a) * k, pinch.c + (pinch.b - pinch.c) * k);
        } else if (drag) {
          const dt = ((e.clientX - drag.x) / (cv._geo?.pw || 1)) * (drag.b - drag.a);
          m.hover = null;
          this.setWindow(drag.a - dt, drag.b - dt);
        } else { m.hover = e.clientX - r.left; this.drawModal(); }
      });
      const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) drag = null; };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('pointerleave', () => { if (!drag) { m.hover = null; this.drawModal(); } });
      cv.addEventListener('dblclick', () => this.setWindow(...this.windowFor(s, m.range)));
      requestAnimationFrame(() => this.drawModal());
    },
    drawModal() {
      const m = this.modal, cv = m.el.querySelector('#mh-mcanvas'), s = this.byId(m.id);
      if (!cv || !s) return;
      cv._geo = plot(cv, s, m.a, m.b, { fmt: this.fmt.bind(this), big: true, hover: m.hover });
      const key = m.id + ':' + m.a + ':' + m.b + ':' + (this.checked || 0);
      if (m.statsKey === key) return;
      m.statsKey = key;
      const inView = s.points.filter(p => p[0] >= m.a && p[0] <= m.b);
      const el = m.el.querySelector('#mh-mstats');
      if (!inView.length) { el.innerHTML = ''; return; }
      let hi = inView[0], lo = inView[0];
      for (const p of inView) { if (p[1] > hi[1]) hi = p; if (p[1] < lo[1]) lo = p; }
      const first = inView[0], last = inView.at(-1), d = t => fmtDate(s, t);
      const nx = s.next ? Date.parse(s.next.date) : null;
      el.innerHTML = [
        ['Window', `${d(m.a)} → ${d(m.b)}`],
        ['Change in window', `<span class="${last[1] - first[1] > 0 ? 'up' : last[1] - first[1] < 0 ? 'down' : ''}">${this.fmt(s, last[1] - first[1], true)}</span>`],
        ['High', `${this.fmt(s, hi[1])} <span class="mh-dim">${d(hi[0])}</span>`],
        ['Low', `${this.fmt(s, lo[1])} <span class="mh-dim">${d(lo[0])}</span>`],
        ['Latest print', `${this.fmt(s, s.points.at(-1)[1])} <span class="mh-dim">${d(s.points.at(-1)[0])}</span>`],
        ['Next release', nx ? `${esc(dayLabel(nx, { weekday: 'short', day: 'numeric', month: 'short' }))} ${hhmm(nx)}${s.next.estimated ? ' <span class="mh-dim">(est.)</span>' : ''} <span class="mh-dim">in ${countdown(nx - Date.now())}</span>` : '—'],
        ['Checked', `${hhmm(this.checked || Date.now())} <span class="mh-dim">· auto-refresh 10 min</span>`],
      ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    },
  };

  // typical spacing between prints (daily / weekly / monthly / quarterly)
  function gapOf(s) {
    if (s._gap) return s._gap;
    const P = s.points, d = [];
    for (let i = Math.max(1, P.length - 25); i < P.length - 1; i++) d.push(P[i][0] - P[i - 1][0]);
    d.sort((a, b) => a - b);
    return (s._gap = d[Math.floor(d.length / 2)] || DAY);
  }
  function fmtDate(s, t) {
    const g = gapOf(s), dt = new Date(t);
    if (s.kind !== 'step' && g > 80 * DAY) return `Q${Math.floor(dt.getUTCMonth() / 3) + 1} ${dt.getUTCFullYear()}`;
    if (s.kind !== 'step' && g > 25 * DAY) return dt.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  // Draws series `s` between times a..b. o: { fmt, big, hover (x px) }. Returns plot geometry.
  function plot(cv, s, a, b, o) {
    const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W || !H || !(b > a)) return null;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const big = !!o.big, fs = big ? 12 : 10, fmt = v => o.fmt(s, v);
    const L = big ? 12 : 6, R = big ? 70 : 48, T = big ? 16 : 8, B = big ? 28 : 20, pw = W - L - R, ph = H - T - B;
    const P = s.points;
    let i0 = 0; while (i0 < P.length && P[i0][0] < a) i0++;
    let i1 = P.length - 1; while (i1 >= 0 && P[i1][0] > b) i1--;
    const inView = P.slice(i0, i1 + 1), before = P[i0 - 1] || null, after = P[i1 + 1] || null;
    const scaleSet = [...inView];
    if (s.kind === 'step' && before) scaleSet.push(before);
    if (!scaleSet.length) [before, after].forEach(p => p && scaleSet.push(p));
    if (!scaleSet.length) return null;
    const vals = scaleSet.map(p => p[1]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (s.kind === 'bar' || s.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (s.target) { lo = Math.min(lo, s.target); hi = Math.max(hi, s.target); }
    if (s.kind === 'bar' && vals.length > 8) { // keep COVID-style outliers from flattening everything else
      const sorted = [...vals].sort((x, y) => x - y), q = f => sorted[Math.floor(f * (sorted.length - 1))];
      const iqr = q(0.95) - q(0.05);
      if (iqr > 0 && (hi - lo) > iqr * 4) { lo = Math.min(0, q(0.02) - iqr * 0.3); hi = Math.max(0, q(0.98) + iqr * 0.3); }
    }
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08; lo -= pad; hi += pad;
    const X = t => L + ((t - a) / (b - a)) * pw, Y = v => T + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * ph;
    g.font = `${fs}px Inter, sans-serif`;
    for (const [ra, rb] of RECESSIONS) {
      if (rb < a || ra > b) continue;
      const x0 = Math.max(L, X(ra)), x1 = Math.min(L + pw, X(rb));
      g.fillStyle = 'rgba(160,165,200,0.09)'; g.fillRect(x0, T, Math.max(1, x1 - x0), ph);
      if (big && x1 - x0 > 30) { g.fillStyle = 'rgba(160,165,200,0.45)'; g.textBaseline = 'top'; g.textAlign = 'center'; g.fillText('recession', (x0 + x1) / 2, T + ph - fs - 2); }
    }
    // y grid
    g.textBaseline = 'middle'; g.textAlign = 'left';
    const step = niceStep((hi - lo) / (big ? Math.min(10, Math.max(4, Math.round(ph / 70))) : 4));
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const y = Y(v);
      g.strokeStyle = 'rgba(255,255,255,0.05)'; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillStyle = '#6f7391'; g.fillText(fmt(+v.toFixed(6)).replace(/\.00(?=\D*$)/, ''), L + pw + 6, y);
    }
    // x ticks: years, quarters, months or weeks depending on the visible span
    g.textBaseline = 'alphabetic'; g.textAlign = 'center';
    const span = b - a, maxTicks = Math.max(3, Math.floor(pw / (big ? 90 : 70)));
    const ticks = [];
    const yrs = span / (365 * DAY);
    if (yrs > 2.5) {
      const st = [1, 2, 5, 10, 20].find(n => yrs / n <= maxTicks) || 20;
      for (let y = new Date(a).getUTCFullYear() + 1; y <= new Date(b).getUTCFullYear(); y++) if (!(y % st)) ticks.push([Date.UTC(y, 0, 1), String(y)]);
    } else if (span > 75 * DAY) {
      const st = [1, 2, 3, 6].find(n => (span / (30.4 * DAY)) / n <= maxTicks) || 6;
      const d = new Date(a); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
      while (d.getTime() <= b) { d.setUTCMonth(d.getUTCMonth() + 1); if (d.getTime() <= b && !(d.getUTCMonth() % st)) ticks.push([d.getTime(), d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) + (d.getUTCMonth() === 0 ? ' ' + d.getUTCFullYear() : '')]); }
    } else {
      const st = Math.max(1, Math.ceil((span / DAY) / maxTicks));
      for (let t = Math.ceil(a / DAY) * DAY; t <= b; t += st * DAY) ticks.push([t, new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })]);
    }
    for (const [t, label] of ticks) {
      const x = X(t);
      g.strokeStyle = 'rgba(255,255,255,0.04)'; g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
      g.fillStyle = '#6f7391'; g.fillText(label, Math.min(L + pw - 14, Math.max(L + 14, x)), H - (big ? 8 : 5));
    }
    g.textAlign = 'left';
    const ref = (v, color, label) => { const y = Y(v); g.setLineDash([4, 4]); g.strokeStyle = color; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.setLineDash([]); if (label) { g.fillStyle = color; g.fillText(label, L + 4, y - 4); } };
    if ((s.kind === 'bar' || s.zero) && lo < 0) ref(0, 'rgba(255,255,255,0.25)');
    if (s.target) ref(s.target, 'rgba(38,166,91,0.7)', s.target + '% target');
    if (s.ref) ref(s.ref[0], 'rgba(231,76,60,0.65)', s.ref[1]);
    // series (clipped to the plot so off-screen neighbours keep lines continuous)
    g.save(); g.beginPath(); g.rect(L, T - 4, pw + 4, ph + 8); g.clip();
    const pts = [before, ...inView, after].filter(Boolean);
    const gold = '#c9a84c';
    if (s.kind === 'bar') {
      const bw = Math.max(1, Math.min(big ? 18 : 10, (pw / Math.max(1, inView.length)) * 0.7));
      for (const [t, v] of pts) { g.fillStyle = v >= 0 ? 'rgba(38,166,91,0.85)' : 'rgba(231,76,60,0.85)'; const y = Y(v), y0 = Y(Math.max(lo, Math.min(hi, 0))); g.fillRect(X(t) - bw / 2, Math.min(y, y0), bw, Math.max(1, Math.abs(y0 - y))); }
    } else {
      const endX = s.kind === 'step' && !after ? X(Math.min(b, Date.now())) : null;
      const path = () => {
        g.beginPath();
        pts.forEach(([t, v], i) => {
          if (!i) g.moveTo(X(t), Y(v));
          else if (s.kind === 'step') { g.lineTo(X(t), Y(pts[i - 1][1])); g.lineTo(X(t), Y(v)); }
          else g.lineTo(X(t), Y(v));
        });
        if (endX != null) g.lineTo(endX, Y(pts.at(-1)[1]));
      };
      path(); g.strokeStyle = gold; g.lineWidth = big ? 2 : 1.6; g.stroke();
      const grad = g.createLinearGradient(0, T, 0, T + ph);
      grad.addColorStop(0, 'rgba(201,168,76,0.22)'); grad.addColorStop(1, 'rgba(201,168,76,0)');
      path(); g.lineTo(endX ?? X(pts.at(-1)[0]), T + ph); g.lineTo(X(pts[0][0]), T + ph); g.closePath(); g.fillStyle = grad; g.fill();
      if (!after && inView.length) { const lp = inView.at(-1); g.fillStyle = gold; g.beginPath(); g.arc(endX ?? X(lp[0]), Y(lp[1]), big ? 3.5 : 2.6, 0, 7); g.fill(); }
    }
    g.restore();
    // latest value tag on the axis
    if (big && inView.length) {
      const v = P.at(-1)[1], y = Y(v);
      if (!after) { g.fillStyle = gold; g.fillRect(L + pw + 2, y - 9, R - 4, 18); g.fillStyle = '#111'; g.font = `600 ${fs}px Inter, sans-serif`; g.textBaseline = 'middle'; g.fillText(fmt(v), L + pw + 6, y); }
    }
    // crosshair + readout
    if (o.hover != null && o.hover >= L && o.hover <= L + pw && pts.length) {
      const t = a + ((o.hover - L) / pw) * (b - a);
      let best = null;
      if (s.kind === 'step') { for (const p of pts) if (p[0] <= t) best = p; best = best || pts[0]; }
      else for (const p of pts) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      const hx = s.kind === 'step' ? o.hover : X(best[0]), hy = Y(best[1]);
      g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.beginPath(); g.moveTo(hx, T); g.lineTo(hx, T + ph); g.moveTo(L, hy); g.lineTo(L + pw, hy); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, big ? 4 : 3, 0, 7); g.fill();
      const label = `${fmt(best[1])}  ·  ${fmtDate(s, s.kind === 'step' ? t : best[0])}`;
      g.font = `600 ${fs + 1}px Inter, sans-serif`; g.textBaseline = 'middle';
      const tw = g.measureText(label).width + 16, bx = Math.min(L + pw - tw, Math.max(L, hx + 10 + tw > L + pw ? hx - tw - 10 : hx + 10));
      g.fillStyle = 'rgba(13,13,24,0.94)'; g.strokeStyle = 'rgba(201,168,76,0.5)';
      g.beginPath(); g.roundRect ? g.roundRect(bx, T + 2, tw, fs + 12, 6) : g.rect(bx, T + 2, tw, fs + 12); g.fill(); g.stroke();
      g.fillStyle = '#e8e8f0'; g.fillText(label, bx + 8, T + 2 + (fs + 12) / 2);
    }
    return { L, pw };
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / p;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  }

  // ═════════════ RELEASE ALERTS (pop-up + chime) ═════════════
  // Watches the calendar on every dashboard page: a heads-up before high-impact US / BoJ-Japan releases and
  // a pop-up with the actual vs forecast the moment the number prints.
  function readOf(e) {
    const ref = e.forecast ?? e.previous, t = e.title;
    if (/Interest Rate Decision|Loan Prime Rate/.test(t) && e.actual != null && e.previous != null) {
      const surprise = e.forecast != null && e.actual !== e.forecast ? ' (surprise vs forecast)' : ' (as expected)';
      if (e.actual > e.previous) return [(e.country === 'JP' ? 'BoJ hike: stronger yen, carry-trade unwind risk' : 'Rate hike: tighter liquidity') + surprise, 'bear'];
      if (e.actual < e.previous) return ['Rate cut: easier liquidity' + surprise, 'bull'];
      return ['Rates on hold' + surprise, 'neutral'];
    }
    if (e.actual == null || ref == null || e.actual === ref) return [e.actual == null ? '' : 'In line with expectations', 'neutral'];
    const up = e.actual > ref;
    if (/Inflation|CPI|PPI|PCE|Price Index|Earnings|Wage/i.test(t)) return up ? ['Hotter than expected: hawkish, usually risk-off', 'bear'] : ['Cooler than expected: dovish, usually risk-on', 'bull'];
    if (/Unemployment Rate|Jobless Claims/i.test(t)) return up ? ['Weaker labour market: more rate cuts get priced', 'neutral'] : ['Stronger labour market: fewer cuts priced', 'neutral'];
    return up ? ['Stronger than expected', 'neutral'] : ['Weaker than expected', 'neutral'];
  }

  const Alerts = {
    cfg: Object.assign({ on: true, sound: true, volume: 0.7, pre: 5, us: true, boj: true, other: false, desktop: false }, store.get('legionAlerts', {})),
    seen: new Set(store.get('legionAlertsSeen', [])),
    events: [], timer: null, ctx: null, started: false, lastBeep: null,
    save() { store.set('legionAlerts', this.cfg); this.renderSettings(); this.bell(); },
    markSeen(k) { this.seen.add(k); store.set('legionAlertsSeen', [...this.seen].slice(-400)); },
    matches(e) {
      if (e.country === 'US') return this.cfg.us && e.importance === 1;
      if (e.country === 'JP') return this.cfg.boj && (e.importance === 1 || /^BoJ /.test(e.title));
      return this.cfg.other && e.importance === 1;
    },
    start() {
      if (this.started) return;
      this.started = true;
      const unlock = () => { const c = this.audio(); if (c && c.state === 'suspended') c.resume().catch(() => {}); };
      ['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, unlock, { passive: true }));
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.poll(); });
      this.bell();
      this.poll();
    },
    async poll() {
      clearTimeout(this.timer);
      let wait = 60000;
      if (this.cfg.on) {
        try {
          const now = Date.now(), H = 3600000;
          const from = Math.floor((now - 3 * H) / H) * H, to = Math.ceil((now + 26 * H) / H) * H;
          this.events = (await getJSON(`/api/macro/calendar?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`)).events;
          this.check(Date.now());
          const lead = (this.cfg.pre + 2) * 60000;
          if (this.events.some(e => { const dt = Date.parse(e.date) - Date.now(); return this.matches(e) && dt > -15 * 60000 && dt < lead && !this.seen.has(e.id + ':rel'); })) wait = 10000;
        } catch { /* offline: try again next tick */ }
      }
      this.timer = setTimeout(() => this.poll(), wait);
    },
    check(now) {
      const due = { pre: new Map(), rel: new Map() };
      for (const e of this.events) {
        if (!this.matches(e)) continue;
        const t = Date.parse(e.date), dt = t - now;
        if (this.cfg.pre && dt > 0 && dt <= this.cfg.pre * 60000 && !this.seen.has(e.id + ':pre')) {
          this.markSeen(e.id + ':pre');
          (due.pre.get(t) || due.pre.set(t, []).get(t)).push(e);
        }
        const expectsNumber = e.forecast != null || e.previous != null;
        if (dt <= 0 && -dt < 15 * 60000 && !this.seen.has(e.id + ':rel') && (e.actual != null || !expectsNumber)) {
          this.markSeen(e.id + ':rel');
          (due.rel.get(t) || due.rel.set(t, []).get(t)).push(e);
        }
      }
      for (const kind of ['pre', 'rel']) for (const [t, list] of due[kind]) this.show(t, list, kind);
    },

    audio() {
      if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; } }
      return this.ctx;
    },
    beep(kind) {
      if (!this.cfg.sound) return;
      const ctx = this.audio();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const notes = kind === 'pre' ? [[659, 0], [880, 0.2]] : [[784, 0], [988, 0.15], [1319, 0.3], [1319, 0.62]];
      const t0 = ctx.currentTime + 0.03, peak = 0.4 * this.cfg.volume + 0.0001;
      for (const [f, at] of notes) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.55);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + at); o.stop(t0 + at + 0.6);
      }
      this.lastBeep = { kind, at: Date.now(), state: ctx.state };
    },

    show(t, list, kind, test) {
      let box = document.getElementById('mh-alerts');
      if (!box) { box = document.createElement('div'); box.id = 'mh-alerts'; box.setAttribute('aria-live', 'assertive'); document.body.appendChild(box); }
      const el = document.createElement('div');
      el.className = 'mh-al ' + kind;
      const head = kind === 'pre' ? `⏰ In ${countdown(t - Date.now())}` : list.some(e => e.actual != null) ? '🔴 Just released' : '🔴 Live now';
      el.innerHTML = `
        <div class="mh-al-h"><span class="mh-al-k">${head}</span><span class="mh-dim">${hhmm(t)} your time</span>${badges(t)}${test ? '<span class="mh-tag">Test</span>' : ''}<button class="mh-al-x" aria-label="Dismiss">✕</button></div>
        ${list.map(e => {
          const [read, tone] = readOf(e);
          const cmp = e.actual != null && (e.forecast ?? e.previous) != null ? Math.sign(e.actual - (e.forecast ?? e.previous)) : 0;
          return `<div class="mh-al-ev">
            <div class="mh-al-t">${FLAGS[e.country] || ''} <b>${esc(e.title)}</b>${e.period ? ` <span class="mh-dim">(${esc(e.period)})</span>` : ''}${impactBars(e.importance)}</div>
            ${e.forecast != null || e.previous != null || e.actual != null ? `<div class="mh-al-nums">
              ${kind === 'rel' ? `<div><span>Actual</span><b class="${cmp > 0 ? 'up' : cmp < 0 ? 'down' : ''}">${val(e.actual, e)}${cmp ? (cmp > 0 ? ' ▲' : ' ▼') : ''}</b></div>` : ''}
              <div><span>Forecast</span><b>${val(e.forecast, e)}</b></div><div><span>Previous</span><b>${val(e.previous, e)}</b></div></div>` : ''}
            ${kind === 'rel' && read ? `<div class="mh-al-read ${TONE[tone] || 'neutral'}">${esc(read)}</div>` : ''}
          </div>`; }).join('')}
        <div class="mh-al-f"><button class="mh-btn" data-al="cal">Open calendar</button></div>`;
      el.querySelector('.mh-al-x').onclick = () => el.remove();
      el.querySelector('[data-al="cal"]').onclick = () => { el.remove(); if (typeof showSection === 'function') showSection('calendar'); };
      box.prepend(el);
      while (box.children.length > 4) box.lastElementChild.remove();
      setTimeout(() => el.remove(), kind === 'pre' ? 30000 : 180000);
      this.beep(kind);
      if (this.cfg.desktop && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(`${head.replace(/^\S+\s/, '')}: ${list.map(e => e.country + ' ' + e.title).join(', ')}`, { body: list.map(e => e.actual != null ? `${e.title}: ${e.actual}${e.unit === '%' ? '%' : ''} (fcst ${e.forecast ?? '—'})` : `${hhmm(t)} your time`).join('\n'), tag: 'legion-' + list[0].id + kind }); } catch { /* not allowed */ }
      }
    },
    test() {
      const t = Date.now();
      this.show(t, [{ id: 'test', title: 'Inflation Rate YoY', country: 'US', period: 'Sep', importance: 1, actual: 3.5, forecast: 3.3, previous: 3.35, unit: '%' }], 'rel', true);
    },

    bell() {
      let b = document.getElementById('mh-bell');
      const host = document.querySelector('.topbar-right');
      if (!b && host) {
        b = document.createElement('button');
        b.id = 'mh-bell'; b.className = 'mh-bell';
        b.onclick = () => { this.cfg.on = !this.cfg.on; this.save(); if (this.cfg.on) this.poll(); };
        host.insertBefore(b, host.querySelector('.live-dot'));
      }
      if (!b) return;
      b.textContent = this.cfg.on ? '🔔' : '🔕';
      b.classList.toggle('off', !this.cfg.on);
      b.title = this.cfg.on ? 'Release alerts ON (US + BoJ/Japan high impact). Click to mute.' : 'Release alerts OFF. Click to turn on.';
    },
    renderSettings() {
      const el = document.getElementById('mh-alert-card');
      if (!el) return;
      const c = this.cfg, perm = 'Notification' in window ? Notification.permission : 'unsupported';
      el.innerHTML = `<div class="mh-card">
        <div class="mh-card-h">🔔 Release alerts</div>
        <label class="mh-sw"><input type="checkbox" data-ac="on"${c.on ? ' checked' : ''}> Pop-up when high-impact data drops</label>
        <label class="mh-sw"><input type="checkbox" data-ac="sound"${c.sound ? ' checked' : ''}> Sound</label>
        <input type="range" class="mh-vol" min="0.1" max="1" step="0.05" value="${c.volume}" data-ac="volume" aria-label="Alert volume"${c.sound ? '' : ' disabled'}>
        <div class="mh-lbl">Alert me for</div>
        <div class="tt-chips">${[['us', '🇺🇸 US high impact'], ['boj', '🇯🇵 BoJ & Japan'], ['other', '🌍 Other majors']].map(([k, l]) => `<button class="tt-chip${c[k] ? ' on' : ''}" data-acs="${k}">${l}</button>`).join('')}</div>
        <div class="mh-lbl">Heads-up before the release</div>
        <div class="tt-chips">${[[0, 'Off'], [1, '1 min'], [5, '5 min'], [15, '15 min']].map(([v, l]) => `<button class="tt-chip${c.pre === v ? ' on' : ''}" data-acp="${v}">${l}</button>`).join('')}</div>
        <div class="mh-al-btns"><button class="mh-btn" data-acx="test">▶ Test alert</button>
        ${perm === 'unsupported' ? '' : `<button class="mh-btn" data-acx="desktop">${c.desktop && perm === 'granted' ? '✓ Desktop notifications on' : perm === 'denied' ? 'Desktop notifications blocked' : 'Enable desktop notifications'}</button>`}</div>
        <p class="mh-note mh-dim">Pops up on any dashboard page with the actual vs forecast and a read, plus a chime. Desktop notifications reach you when this tab is in the background. Browsers only play sound after you have clicked the page once.</p>
      </div>`;
      if (el.dataset.bound) return;
      el.dataset.bound = '1';
      el.addEventListener('change', e => {
        const k = e.target.dataset.ac;
        if (!k) return;
        this.cfg[k] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
        this.save();
        if (k === 'on' && this.cfg.on) this.poll();
        if (k === 'volume') this.beep('pre');
      });
      el.addEventListener('click', async e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.acs) { this.cfg[b.dataset.acs] = !this.cfg[b.dataset.acs]; this.save(); this.poll(); }
        if (b.dataset.acp != null) { this.cfg.pre = Number(b.dataset.acp); this.save(); }
        if (b.dataset.acx === 'test') this.test();
        if (b.dataset.acx === 'desktop' && 'Notification' in window) {
          const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
          this.cfg.desktop = p === 'granted' ? !this.cfg.desktop || Notification.permission !== 'granted' : false;
          this.save();
        }
      });
    },
  };

  window.LegionMacroHub = {
    initCalendar: id => Cal.init(id),
    initMacro: id => Macro.init(id),
    setTz,
    sessionsAt: t => sessionsAt(t).map(s => s.id),
    get tz() { return tz; },
    startAlerts: () => Alerts.start(),
    _m: () => Macro, // used by the QA scripts
    _alerts: () => Alerts,
  };
})();
