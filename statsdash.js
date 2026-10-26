'use strict';
// Round 110: THE PLAY-STATS DASHBOARD (/admin/stats) and its downloads (/admin/stats/export). analytics.js collects; this
// file only READS - the stats, the Moon Shards store's records (store.js) and the live accounts (players.js) - and
// draws one page: Right now, Growth, Retention, Engagement, Versions, Accounts, Features, Money, Health.
//
// PRIVACY: everything here is a count or a share. No player names, no emails, no install ids are shown or exported
// (one player's details stay on /admin/players). Device names and error messages are what games sent - always escaped,
// and a spreadsheet cell that could run as a formula gets a ' in front.
//
//   GET /admin/stats?days=30|90                         the page (signed-in admin session - adminauth.js)
//   GET /admin/stats/export?section=<id>&format=csv|json&days=30|90   one section's numbers as a file
//       sections: now, growth, retention, engagement, versions, accounts, features, money, health

const ui = require('./adminui');
const auth = require('./adminauth');
const A = () => require('./analytics');
const pay = () => require('./payments');

const DAY = 86400000;
const dayIndex = ms => Math.floor(ms / DAY);
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const { esc, fmt, fmt1, pct, money, minutesText, tile, hbars, lineChart, barChart, shareChart, SERIES, GRAY } = ui;

const SECTIONS = [
  ['now', 'Right now'], ['growth', 'Growth'], ['retention', 'Retention'], ['engagement', 'Engagement'], ['versions', 'Versions'],
  ['accounts', 'Accounts'], ['features', 'Features'], ['money', 'Money'], ['health', 'Health']
];
const GRACE_BUILD = 109;   // the first build with live accounts (the grace period lets older ones into rooms)
const RANK_NAMES = ['Renegade', 'Local', 'Regional', 'Major', 'Mega', 'Headliner Empire', 'Global', 'Legend'];

function safe(fn, fallback) { try { const v = fn(); return v == null ? fallback : v; } catch { return fallback; } }
function plat(p) {
  const w = String(p || '?');
  if (w === 'windows' || w === 'mac' || w === 'android') return w;
  if (w === 'web' || w === 'web-demo') return 'web';
  return 'other';
}
const PLAT_NAMES = { windows: 'Windows', mac: 'Mac', android: 'Android', web: 'Web', other: 'Other' };
const toMs = v => typeof v === 'number' ? v : Date.parse(v || '');
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const sortDesc = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);

// ============================================================================ the numbers (cached a few seconds)
let cache = { at: 0, range: 0, data: null };

function compute(range) {
  const now = Date.now();
  const v = A().view();
  if (cache.data && cache.range === range && cache.rev === v.rev && now - cache.at < 15000) return cache.data;
  const state = v.state;
  const today = dayIndex(now);
  const first = today - range + 1;
  const labels = [];
  for (let d = first; d <= today; d++) labels.push(dayKey(d * DAY));
  const idx = d => d - first;   // day index -> position in the range
  const zeros = () => labels.map(() => 0);

  // ---- installs: active per day, WAU / MAU per day, new per day, platforms, builds
  const dau = zeros(), wau = zeros(), mau = zeros(), fresh = zeros();
  let total = 0, a1 = 0, a7 = 0, a30 = 0, aRange = 0;
  const mauPlat = Object.create(null), mauStore = Object.create(null), mauDevice = Object.create(null), mauLang = Object.create(null);
  const build7 = Object.create(null);
  let acct30 = 0, anon30 = 0, crashed = 0, sessionsAll = 0, minutesAll = 0, footAll = 0;
  const careerRanks = new Array(RANK_NAMES.length).fill(0);
  let careerPlayers = 0, careerDone = 0, swEarned = 0, swBought = 0;
  const active7 = [];
  const cohorts = new Map();
  for (const p of Object.values(state.installs)) {
    total++;
    sessionsAll += p.s || 0; minutesAll += p.m || 0; footAll += p.ft || 0;
    if (p.er) crashed++;
    const f = dayIndex(p.f);
    if (f >= first && f <= today) fresh[idx(f)]++;
    const ad = p.ad;
    let nextW = first, nextM = first;
    for (let i = 0; i < ad.length; i++) {
      const a = ad[i];
      if (a > today) continue;
      if (a >= first) dau[idx(a)]++;
      // WAU: days a .. a+6 inside the range, each counted once per install (ad is in order)
      const wFrom = Math.max(a, nextW), wTo = Math.min(a + 6, today);
      for (let d = wFrom; d <= wTo; d++) wau[idx(d)]++;
      if (wTo >= wFrom) nextW = wTo + 1;
      const mFrom = Math.max(a, nextM), mTo = Math.min(a + 29, today);
      for (let d = mFrom; d <= mTo; d++) mau[idx(d)]++;
      if (mTo >= mFrom) nextM = mTo + 1;
    }
    const last = ad.length ? ad[ad.length - 1] : dayIndex(p.l);
    if (last >= first) aRange++;
    if (last === today) a1++;
    if (last > today - 7) { a7++; active7.push(p); build7[p.b ? String(p.b) : 'old'] = (build7[p.b ? String(p.b) : 'old'] || 0) + 1; }
    if (last > today - 30) {
      a30++;
      const pl = plat(p.p);
      mauPlat[pl] = (mauPlat[pl] || 0) + 1;
      if (p.st) mauStore[p.st] = (mauStore[p.st] || 0) + 1;
      if (p.d) mauDevice[p.d] = (mauDevice[p.d] || 0) + 1;
      if (p.g) mauLang[p.g] = (mauLang[p.g] || 0) + 1;
      if (p.a) acct30++; else anon30++;
    }
    if (p.ct != null && p.ct >= 1) { careerPlayers++; careerRanks[Math.min(p.ct, RANK_NAMES.length - 1)]++; if (p.cc) careerDone++; }
    if (p.sw & 1) swEarned++;
    if (p.sw & 2) swBought++;
    // retention cohorts: the last 60 days
    if (f >= today - 60 && f <= today) {
      let c = cohorts.get(f);
      if (!c) cohorts.set(f, c = { size: 0, d1: 0, d7: 0, d30: 0 });
      c.size++;
      // (ad is sorted: a binary search would do, but these are short lists)
      if (ad.includes(f + 1)) c.d1++;
      if (ad.includes(f + 7)) c.d7++;
      if (ad.includes(f + 30)) c.d30++;
    }
  }
  const retention = (off, key) => {
    let size = 0, kept = 0;
    for (const [day, c] of cohorts) { if (day + off >= today) continue; size += c.size; kept += c[key]; }
    return size ? kept / size : null;
  };

  // ---- day summaries in the range
  const dayRows = labels.map(k => state.days[k] || null);
  const daySum = (fn) => sum(dayRows.map(d => d ? fn(d) || 0 : 0));
  const sessions = dayRows.map(d => d ? d.s || 0 : 0);
  const minutes = dayRows.map(d => d ? d.m || 0 : 0);
  const peaks = dayRows.map(d => d ? d.pk || 0 : 0);
  const fxRange = Object.create(null);
  const healthRange = Object.create(null);
  const healthByDay = Object.create(null);
  const errorsByDay = zeros();
  let rmA = 0, rmG = 0, rmDays = 0;
  const rm7 = { a: 0, g: 0, days: 0 };
  dayRows.forEach((d, i) => {
    if (!d) return;
    for (const [k, n] of Object.entries(d.x || {})) fxRange[k] = (fxRange[k] || 0) + n;
    for (const [k, n] of Object.entries(d.h || {})) {
      healthRange[k] = (healthRange[k] || 0) + n;
      (healthByDay[k] = healthByDay[k] || zeros())[i] += n;
    }
    errorsByDay[i] = (d.e && d.e.error) || 0;
    if (d.rm && (d.rm.a || d.rm.g)) {
      rmA += d.rm.a; rmG += d.rm.g; rmDays++;
      if (i >= labels.length - 7) { rm7.a += d.rm.a; rm7.g += d.rm.g; rm7.days++; }
    }
  });
  const footMin = daySum(d => d.f), dayMinutes = sum(minutes), daySessions = sum(sessions);
  const footKnown = dayRows.some(d => d && d.f != null);

  // ---- versions: active players per build per day
  const buildKeys = new Set();
  for (const d of dayRows) if (d && d.v) for (const k of Object.keys(d.v)) buildKeys.add(k);
  const numericBuilds = [...buildKeys].filter(k => k !== 'old').sort((a, b) => Number(b) - Number(a));
  const shownBuilds = numericBuilds.slice(0, 4);
  const buildSeries = shownBuilds.map((k, i) => ({ key: k, name: 'Build ' + k, color: SERIES[i] }));
  if (numericBuilds.length > 4) buildSeries.push({ key: '__more', name: 'Older numbered builds', color: SERIES[4] });
  buildSeries.push({ key: 'old', name: 'Not reported (109 or older)', color: GRAY });
  const buildRows = dayRows.map(d => {
    const out = {};
    if (!d || !d.v) return out;
    for (const [k, n] of Object.entries(d.v)) {
      const key = k === 'old' ? 'old' : shownBuilds.includes(k) ? k : '__more';
      out[key] = (out[key] || 0) + n;
    }
    return out;
  });

  // ---- live accounts (players.js) - read only: their builds (LAST DEVICE "Windows 1.4.0.109") and sign-up days
  const pstate = safe(() => require('./players')._test.state(), null);
  const liveAccounts = pstate && pstate.players ? Object.values(pstate.players) : [];
  const storeBuild = new Map();   // store account id -> the newest build its live account was seen on
  const signups = zeros();
  let liveTotal = 0;
  for (const lp of liveAccounts) {
    liveTotal++;
    const c = dayIndex(toMs(lp.created));
    if (c >= first && c <= today) signups[idx(c)]++;
    const m = lp.device && /\.(\d{2,5})\s*$/.exec(String(lp.device.name || ''));
    // Round 110 (sec110 M6): the stats keep only a salted tag of the account (analytics.acctTag), so the lookup is by tag
    if (m && lp.store && lp.store.id) { const tag = A().acctTag(lp.store.id); if (tag) storeBuild.set(tag, Math.max(Number(m[1]), storeBuild.get(tag) || 0)); }
  }
  let confirmed = 0, estimated = 0;
  for (const p of active7) {
    if (p.b >= GRACE_BUILD) confirmed++;
    else if (!p.b && p.a && (storeBuild.get(String(p.a)) || 0) >= GRACE_BUILD) estimated++;
  }

  // ---- money (store.js records, read only)
  const money = moneyFrom(safe(() => require('./store')._test.state(), null), first, today, labels, idx, zeros);

  // ---- errors
  const errs = Object.values(state.errors);
  const errByVersion = Object.create(null), errByPlat = Object.create(null);
  for (const e of errs) {
    for (const [k, n] of Object.entries(e.v || {})) errByVersion[k] = (errByVersion[k] || 0) + n;
    for (const [k, n] of Object.entries(e.pl || {})) errByPlat[k] = (errByPlat[k] || 0) + n;
  }
  const topErrors = errs.slice().sort((a, b) => b.c - a.c).slice(0, 10);

  const data = {
    now, range, labels, total, a1, a7, a30, aRange, dau, wau, mau, fresh, sessions, minutes, peaks,
    mauPlat, mauStore, mauDevice, mauLang, build7, buildSeries, buildRows, confirmed, estimated, active7: active7.length,
    acct30, anon30, signups, liveTotal, storeAccounts: money.accounts,
    retention: { d1: retention(1, 'd1'), d7: retention(7, 'd7'), d30: retention(30, 'd30'), cohorts: [...cohorts.entries()].sort((a, b) => b[0] - a[0]) },
    engagement: { daySessions, dayMinutes, footMin, footKnown, sessionsAll, minutesAll, footAll },
    fx: state.fx, fxRange, careerRanks, careerPlayers, careerDone, swEarned, swBought,
    money, health: { healthRange, healthByDay, errorsByDay, errByVersion, errByPlat, topErrors, crashed, errorKinds: errs.length },
    rooms: { rmA, rmG, rmDays, rm7 },
    online: v.online, relay: v.relay, liveMap: v.live, ONLINE_MS: v.ONLINE_MS, persistent: v.PERSISTENT, loadNote: v.loadNote, since: state.since,
    funnel: funnelOf(state, v.FUNNEL)
  };
  cache = { at: now, range, rev: v.rev, data };
  return data;
}

function funnelOf(state, FUNNEL) {
  const out = FUNNEL.map(([k, label]) => [k, label, 0]);
  for (const p of Object.values(state.installs)) for (const row of out) if (p.fl && p.fl[row[0]]) row[2]++;
  return out;
}

/** Real-money sales, refunds and shard-store items from the store's own records (never changed here). */
function moneyFrom(s, first, today, labels, idx, zeros) {
  const out = { open: false, accounts: 0, byPlatform: Object.create(null), byPlatformRange: Object.create(null), perDay: zeros(), sales: 0, salesRange: 0,
    cents: 0, centsRange: 0, refunds: 0, refundCents: 0, refundsByPlatform: Object.create(null), products: Object.create(null), shardsBought: 0,
    payers: new Set(), items: Object.create(null), speedwayOwners: 0 };
  if (!s) return out;
  out.open = safe(() => !!require('./payments').features().store, false);
  const accounts = Object.values(s.accounts || {}).filter(a => a && a.id);
  out.accounts = accounts.length;
  const add = (platform, cents, at, product, account, shards) => {
    out.sales++; out.cents += cents;
    out.byPlatform[platform] = (out.byPlatform[platform] || 0) + cents;
    out.products[product] = (out.products[product] || 0) + cents;
    if (account) out.payers.add(account);
    out.shardsBought += shards || 0;
    const d = dayIndex(at);
    if (d >= first && d <= today) {
      out.salesRange++; out.centsRange += cents; out.perDay[idx(d)] += cents;
      out.byPlatformRange[platform] = (out.byPlatformRange[platform] || 0) + cents;
    }
  };
  const refund = (platform, cents) => { out.refunds++; out.refundCents += cents; out.refundsByPlatform[platform] = (out.refundsByPlatform[platform] || 0) + 1; };
  for (const o of Object.values(s.orders || {})) {
    if (!o) continue;
    const cents = Number(o.cents) || 0;
    const product = o.kind === 'shards' ? 'Shards: ' + (o.pack || 'pack') : o.kind === 'bignight' ? 'Big Night pass' : o.kind === 'plan' ? 'Vendor plan' : String(o.kind || 'other');
    if (o.status === 'paid') add('Stripe (web)', cents, toMs(o.paidAt || o.at), product, o.account, o.kind === 'shards' ? Number(o.shards) || 0 : 0);
    else if (o.status === 'refunded') refund('Stripe (web)', cents);
  }
  const names = { steam: 'Steam', google: 'Google Play', apple: 'App Store' };
  for (const r of Object.values(s.iap || {})) {
    if (!r || r.sandbox) continue;
    const platform = names[r.platform] || String(r.platform || 'app store');
    const cents = Number(r.cents) || 0;
    const product = r.kind === 'shards' ? 'Shards: ' + String(r.product || 'pack') : r.product === 'site_speedway' ? 'Neon Speedway' : r.kind === 'bignight' ? 'Big Night pass' : String(r.product || r.kind || 'item');
    if (r.status === 'granted') add(platform, cents, toMs(r.grantedAt || r.at), product, r.account, Number(r.shards) || 0);
    else if (r.status === 'revoked') refund(platform, cents);
  }
  for (const a of accounts) for (const id of Array.isArray(a.owned) ? a.owned : []) {
    out.items[id] = (out.items[id] || 0) + 1;
    if (id === 'site_speedway') out.speedwayOwners++;
  }
  return out;
}

// ============================================================================ the page
function card(id, title, why, body, days) {
  return `<section class="card" id="${id}"><div class="cardhead"><h2>${esc(title)}</h2>
<div class="exp" aria-label="Download ${esc(title)}"><a href="/admin/stats/export?section=${id}&amp;format=csv&amp;days=${days}" download>CSV</a><a href="/admin/stats/export?section=${id}&amp;format=json&amp;days=${days}" download>JSON</a></div></div><p class="why">${why}</p>${body}</section>`;
}

function graceInfo(c) {
  const until = Date.parse(String(process.env.LIVE_ACCOUNT_GRACE_UNTIL || '').trim());
  const on = Number.isFinite(until) && until > c.now;
  const daysLeft = on ? Math.ceil((until - c.now) / DAY) : 0;
  const share = c.active7 ? (c.confirmed + c.estimated) / c.active7 : null;
  const r = c.rooms.rm7;
  const oldRooms = r.a + r.g > 0 ? r.g / (r.a + r.g) : null;
  let level = 'warn', verdict = 'Not enough data yet';
  if (oldRooms != null && r.days >= 5) {
    if (oldRooms < 0.02) { level = 'ok'; verdict = 'Safe to end the grace period'; }
    else if (oldRooms < 0.10) { level = 'warn'; verdict = 'Almost - a few old builds still play online'; }
    else { level = 'bad'; verdict = 'Not yet - many old builds still play online'; }
  }
  return { until: Number.isFinite(until) ? until : 0, on, daysLeft, share, oldRooms, level, verdict, roomDays: r.days };
}

function render(c, token, days) {
  const parts = [ui.CSS];
  parts.push(`<div class="pagehead"><div><h1>Play stats</h1><p>Updated ${esc(new Date(c.now).toISOString().slice(0, 16).replace('T', ' '))} UTC · counting since ${esc(new Date(c.since).toISOString().slice(0, 10))}</p></div>
<div class="seg" role="group" aria-label="Range">${[30, 90].map(n => `<a href="/admin/stats?days=${n}"${n === days ? ' class="on" aria-current="true"' : ''}>${n} days</a>`).join('')}</div></div>`);
  parts.push(`<nav class="jump" aria-label="Sections">${SECTIONS.map(([id, name]) => `<a href="#${id}">${esc(name)}</a>`).join('')}</nav>`);
  if (!c.persistent) parts.push('<div class="note warn"><b>Heads-up:</b> these numbers start again from zero whenever the free server restarts. To keep them, add the permanent disk (STORE_DATA_DIR - see README.txt).</div>');
  if (c.loadNote) parts.push(`<div class="note warn">${esc(c.loadNote)}</div>`);

  // ---------------------------------------------------------------- Right now
  {
    const r = c.relay || {};
    const byPlat = { windows: 0, mac: 0, android: 0, web: 0, other: 0 };
    for (const [k, n] of Object.entries(c.online.byPlatform || {})) byPlat[plat(k)] += n;
    let b = `<div class="tiles">${tile(fmt(c.online.n), 'playing right now', `${fmt(c.online.foot)} walking the festival`, 'live')}`;
    for (const k of ['windows', 'mac', 'android', 'web']) b += tile(fmt(byPlat[k]), PLAT_NAMES[k] + ' now');
    if (byPlat.other) b += tile(fmt(byPlat.other), 'other platforms now');
    b += tile(r.publicPlayers != null ? `${fmt(r.publicPlayers)} / ${fmt(r.publicCapacity)}` : '–', 'Open Festival attendance');
    b += tile(r.rooms != null ? fmt(r.rooms) : '–', 'live rooms', r.roomPlayers != null ? `${fmt(r.roomPlayers)} players in them` : '');
    b += tile(fmt(c.peaks[c.peaks.length - 1]), 'most at once today');
    b += '</div>';
    if (r.roomOld) b += `<p class="why">${fmt(r.roomOld)} of the players in rooms right now are on a game too old for accounts (let in by the grace period).</p>`;
    parts.push(card('now', 'Right now', 'Games open in the last 2&frac12; minutes (their once-a-minute heartbeat), and what the relay sees live.', b, days));
  }

  // ---------------------------------------------------------------- Growth
  {
    const stick = c.a30 ? c.a1 / c.a30 : null;
    const newInRange = sum(c.fresh), signupsInRange = sum(c.signups);
    let b = `<div class="tiles">${tile(fmt(c.a1), 'played today (DAU)')}${tile(fmt(c.a7), 'last 7 days (WAU)')}${tile(fmt(c.a30), 'last 30 days (MAU)')}
${tile(pct(stick), 'stickiness (DAU ÷ MAU)', 'how many monthly players come daily')}${tile(fmt(newInRange), `new players (${c.range} days)`)}${tile(fmt(c.total), 'players ever (installs)')}</div>`;
    b += '<div class="charts">';
    b += lineChart({ title: 'Active players', sub: 'per day: played that day, in the 7 days, in the 30 days up to it', labels: c.labels,
      series: [{ name: 'DAU', color: SERIES[0], values: c.dau }, { name: 'WAU', color: SERIES[1], values: c.wau }, { name: 'MAU', color: SERIES[2], values: c.mau }] });
    b += barChart({ title: 'New players per day', sub: `${fmt(newInRange)} first opened the game in ${c.range} days`, labels: c.labels, values: c.fresh });
    b += lineChart({ title: 'Installs vs accounts made', sub: `new installs ${fmt(newInRange)} · new live accounts ${fmt(signupsInRange)} (${newInRange ? pct(signupsInRange / newInRange) : '–'})`, labels: c.labels,
      series: [{ name: 'New installs', color: SERIES[0], values: c.fresh }, { name: 'New accounts', color: SERIES[1], values: c.signups }] });
    b += '</div>';
    parts.push(card('growth', 'Growth', 'A "player" is one copy of the game on one device. DAU / WAU / MAU = players who played on the day / in the last 7 / in the last 30 days.', b, days));
  }

  // ---------------------------------------------------------------- Retention
  {
    const R = c.retention;
    let b = `<div class="tiles">${tile(pct(R.d1), 'come back next day (D1)', 'games aim for ~40%')}${tile(pct(R.d7), 'a week later (D7)', 'aim ~15%')}${tile(pct(R.d30), 'a month later (D30)', 'aim ~5%')}</div>`;
    const today = dayIndex(c.now);
    const rows = R.cohorts.slice(0, c.range >= 90 ? 30 : 14);
    if (rows.length) {
      const cell = (first, off, kept, size) => {
        if (first + off >= today) return '<td class="c" style="color:var(--muted)">…</td>';
        const v = size ? kept / size : null;
        return `<td class="c" style="background:${ui.heat(v)};color:${ui.heatText(v)}" title="${fmt(kept)} of ${fmt(size)}">${pct(v)}</td>`;
      };
      b += `<div class="scroll"><table class="tbl heat"><tr><th>First played</th><th class="n">Players</th><th>D1</th><th>D7</th><th>D30</th></tr>${rows.map(([first, k]) =>
        `<tr><td>${esc(ui.short(dayKey(first * DAY)))}</td><td class="n">${fmt(k.size)}</td>${cell(first, 1, k.d1, k.size)}${cell(first, 7, k.d7, k.size)}${cell(first, 30, k.d30, k.size)}</tr>`).join('')}</table></div>
<p class="why" style="margin-top:8px">Each row: the players who first played that day, and how many played again exactly 1, 7 and 30 days later. Brighter gold = more came back. "…" = too soon to know.</p>`;
    } else b += '<p class="empty">No new players in the last 60 days yet.</p>';
    parts.push(card('retention', 'Retention', 'Do new players come back?', b, days));
  }

  // ---------------------------------------------------------------- Engagement
  {
    const e = c.engagement;
    const avgSession = e.daySessions ? e.dayMinutes / e.daySessions : null;
    // (sessions per player in the range: the range's sessions / the players who played in it)
    const perPlayer = c.aRange ? e.daySessions / c.aRange : null;
    const footShare = e.footKnown && e.dayMinutes ? e.footMin / e.dayMinutes : (e.minutesAll ? e.footAll / e.minutesAll : null);
    let b = `<div class="tiles">${tile(avgSession == null ? '–' : minutesText(avgSession), 'average session')}${tile(perPlayer == null ? '–' : fmt1(perPlayer), 'sessions per player', `last ${c.range} days`)}
${tile(fmt(e.dayMinutes / 60), `hours played (${c.range} days)`)}${tile(pct(footShare == null ? null : 1 - footShare), 'time on the map')}${tile(pct(footShare), 'time on foot')}</div>`;
    const avgByDay = c.sessions.map((s, i) => s ? c.minutes[i] / s : 0);
    b += '<div class="charts">';
    b += barChart({ title: 'Hours played per day', labels: c.labels, values: c.minutes.map(m => m / 60), yFormat: v => fmt1(v) });
    b += lineChart({ title: 'Average session length (minutes)', labels: c.labels, series: [{ name: 'Minutes', color: SERIES[1], values: avgByDay }], yFormat: v => fmt1(v) });
    b += '</div>';
    const fn = c.funnel, base = fn[0] ? fn[0][2] : 0;
    b += `<h3>From first launch to hooked (all time)</h3>${hbars(fn.map(([, label, n]) => [label, n, base ? pct(n / base) : '']), { max: Math.max(base, 1), color: 'var(--s2)', limit: 12 })}`;
    parts.push(card('engagement', 'Engagement', 'How long and how often they play, and where: building on the map, or walking the festival on foot.', b, days));
  }

  // ---------------------------------------------------------------- Versions & platforms
  {
    const g = graceInfo(c);
    const sharePct = g.share == null ? '–' : pct(g.share);
    let b = `<div class="tiles">${tile(sharePct, `of active players on build ${GRACE_BUILD} or newer`, `last 7 days · ${fmt(c.confirmed)} confirmed + ${fmt(c.estimated)} from their accounts, of ${fmt(c.active7)}`, 'big')}
${tile(g.oldRooms == null ? '–' : pct(g.oldRooms, 1), 'of online-room play on old builds', `last 7 days (${fmt(g.roomDays)} days measured)`)}
${tile(g.until ? ui.short(new Date(g.until).toISOString().slice(0, 10)) : 'not set', 'grace period ends', g.on ? `${new Date(g.until).getUTCFullYear()} · ${g.daysLeft} day${g.daysLeft === 1 ? '' : 's'} left` : g.until ? 'ended - old builds can\'t join rooms' : 'LIVE_ACCOUNT_GRACE_UNTIL')}</div>`;
    b += `<div class="note ${g.level}"><span class="pill ${g.level}">${g.level === 'ok' ? '✓' : g.level === 'bad' ? '✕' : '!'} ${esc(g.verdict)}</span>
<p style="margin:8px 0 0">The grace period lets games older than build ${GRACE_BUILD} (no live accounts) keep joining online rooms. <b>It ends by itself on the date above - you don't have to do anything.</b>
It's safe to let it end once "online-room play on old builds" stays under 2% for a week. If it's still high a few days before, you can move the date later: Render &gt; nmsd &gt; Environment &gt; LIVE_ACCOUNT_GRACE_UNTIL.
Builds before 110 don't report their build number, so "${GRACE_BUILD} or newer" counts build 110+ for sure, plus 109 players recognised through their signed-in account; the rest are counted as old (the safe side).</p></div>`;
    b += '<div class="charts">';
    b += shareChart({ title: 'Version adoption', sub: 'share of each day\'s players, by build', labels: c.labels, keys: c.buildSeries, rows: c.buildRows });
    b += ui.chartBox({ title: 'Builds in the last 7 days', sub: `${fmt(c.active7)} players` }, hbars(sortDesc(c.build7).map(([k, n]) => [k === 'old' ? 'Not reported (109 or older)' : 'Build ' + k, n, c.active7 ? pct(n / c.active7) : '', (c.buildSeries.find(b => b.key === k) || { color: k === 'old' ? GRAY : SERIES[4] }).color]), { limit: 8 }));
    b += ui.chartBox({ title: 'Platforms (last 30 days)', sub: `${fmt(c.a30)} players` }, hbars(['windows', 'mac', 'android', 'web', 'other'].map(k => [PLAT_NAMES[k], c.mauPlat[k] || 0, c.a30 ? pct((c.mauPlat[k] || 0) / c.a30) : '']), {}));
    b += ui.chartBox({ title: 'Where they got it (last 30 days)' }, hbars(sortDesc(c.mauStore).map(([k, n]) => [k, n, c.a30 ? pct(n / c.a30) : '']), { color: 'var(--s2)' }));
    b += ui.chartBox({ title: 'Top devices (last 30 days)' }, hbars(sortDesc(c.mauDevice).map(([k, n]) => [k, n]), { color: 'var(--s3)', limit: 8 }));
    b += ui.chartBox({ title: 'Languages (last 30 days)' }, hbars(sortDesc(c.mauLang).map(([k, n]) => [k, n]), { color: 'var(--s4)', limit: 8 }));
    b += '</div>';
    parts.push(card('versions', 'Platforms & versions', 'Which builds and devices people play on - and whether it\'s safe to stop letting old builds online.', b, days));
  }

  // ---------------------------------------------------------------- Accounts
  {
    const signed = c.acct30 + c.anon30 ? c.acct30 / (c.acct30 + c.anon30) : null;
    let b = `<div class="tiles">${tile(fmt(c.liveTotal), 'live accounts', 'username + email + password')}${tile(fmt(sum(c.signups)), `new accounts (${c.range} days)`)}
${tile(pct(signed), 'signed-in share', 'of last-30-day players')}${tile(fmt(c.storeAccounts), 'Moon Shards store accounts')}</div>`;
    b += '<div class="charts">';
    b += barChart({ title: 'Accounts made per day', labels: c.labels, values: c.signups, color: SERIES[1] });
    b += ui.chartBox({ title: 'Players by account (last 30 days)', sub: `${fmt(c.a30)} players` }, hbars([['Signed in to an account', c.acct30, pct(signed)], ['Anonymous', c.anon30, signed == null ? '' : pct(1 - signed), GRAY]], { max: Math.max(c.a30, 1) }));
    b += '</div><p class="why" style="margin-top:10px">Only counts here - to look up one player, use <a href="/admin/players">Players</a>.</p>';
    parts.push(card('accounts', 'Accounts', 'Sign-ups, and how many players use an account.', b, days));
  }

  // ---------------------------------------------------------------- Features
  {
    const fx = c.fx, fr = c.fxRange;
    const n = k => fx[k] || 0, nr = k => fr[k] || 0;
    const greenN = n('green_build'), greenAvg = greenN ? (fx['green_build.sum'] || 0) / greenN : null;
    const mxLive = n('mx_race.live'), mxSolo = n('mx_race.solo');
    const wins = n('mx_race.live.p1') + n('mx_race.solo.p1');
    let b = `<div class="tiles">${tile(fmt(c.careerPlayers), 'players with a career', 'reached Local or higher')}${tile(pct(c.careerPlayers ? c.careerDone / c.careerPlayers : null), 'career complete', `${fmt(c.careerDone)} reached Legend`)}
${tile(fmt(n('land_plot')), 'land plots bought', `${fmt(nr('land_plot'))} in ${c.range} days`)}${tile(fmt(n('stage_upgrade')), 'stage upgrades', `${fmt(nr('stage_upgrade'))} in ${c.range} days`)}
${tile(fmt(n('module_fit')), 'stage modules fitted')}${tile(greenAvg == null ? '–' : Math.round(greenAvg) + ' / 100', 'average green rating', `${fmt(greenN)} green festivals`)}
${tile(fmt(mxLive + mxSolo), 'MX races finished', `${fmt(mxLive)} live · ${fmt(mxSolo)} solo · ${pct(mxLive + mxSolo ? wins / (mxLive + mxSolo) : null)} wins`)}${tile(fmt(n('pyro_show')), 'pyro shows')}
${tile(fmt(n('emote')), 'emotes')}${tile(fmt(n('swag_unlock')), 'swag unlocked')}${tile(fmt(c.swEarned), 'Speedway earned', 'players')}${tile(fmt(Math.max(c.swBought, c.money.speedwayOwners)), 'Speedway bought', 'players (store records)')}</div>`;
    const prefixed = (pre, names) => Object.entries(fx).filter(([k]) => k.startsWith(pre + '.') && k.split('.').length === 2 && k !== pre + '.sum').map(([k, v]) => [names ? names(k.slice(pre.length + 1)) : k.slice(pre.length + 1), v]).sort((a, b) => b[1] - a[1]);
    b += '<div class="charts">';
    b += ui.chartBox({ title: 'Career rank reached', sub: 'each player counted once, at their best rank' }, hbars(RANK_NAMES.slice(1).map((name, i) => [name, c.careerRanks[i + 1], c.careerPlayers ? pct(c.careerRanks[i + 1] / c.careerPlayers) : '']), { max: Math.max(1, ...c.careerRanks), empty: 'No career ranks reported yet (build 110+).' }));
    b += ui.chartBox({ title: 'Swag unlocked by rarity' }, hbars(['common', 'rare', 'epic', 'legendary'].map((r, i) => [r[0].toUpperCase() + r.slice(1), n('swag_unlock.' + r), '', SERIES[i]]), { empty: 'No swag unlocks reported yet.' }));
    b += ui.chartBox({ title: 'MX races', sub: 'finished races by mode and place' }, hbars([['Live - won', n('mx_race.live.p1')], ['Live - 2nd/3rd', n('mx_race.live.p2') + n('mx_race.live.p3')], ['Live - 4th or later', n('mx_race.live.p4')],
      ['Solo - won', n('mx_race.solo.p1'), '', 'var(--s2)'], ['Solo - other places', n('mx_race.solo.p2') + n('mx_race.solo.p3') + n('mx_race.solo.p4'), '', 'var(--s2)']], { empty: 'No MX races reported yet.' }));
    b += ui.chartBox({ title: 'Green rating of green festivals' }, hbars(['r0', 'r20', 'r40', 'r60', 'r80'].map((k, i) => [['0-19', '20-39', '40-59', '60-79', '80-100'][i], n('green_build.' + k)]), { color: 'var(--s3)', empty: 'No green festivals reported yet.' }));
    b += ui.chartBox({ title: 'Stage modules fitted' }, hbars(prefixed('module_fit'), { color: 'var(--s4)', empty: 'None reported yet.' }));
    b += ui.chartBox({ title: 'Stage upgrades (to)' }, hbars(prefixed('stage_upgrade'), { color: 'var(--s2)', empty: 'None reported yet.' }));
    b += ui.chartBox({ title: 'Pyro shows by cue' }, hbars(prefixed('pyro_show'), { color: 'var(--s5)', empty: 'None reported yet.' }));
    b += ui.chartBox({ title: 'Top emotes' }, hbars(prefixed('emote'), { color: 'var(--s3)', limit: 8, empty: 'None reported yet.' }));
    b += '</div>';
    parts.push(card('features', 'Features (Round 109/110)', 'How far players get in the career and what they use. All time, from games on build 110 or newer.', b, days));
  }

  // ---------------------------------------------------------------- Money
  {
    const m = c.money;
    const payers = m.payers.size;
    let b = m.open ? '' : '<div class="note">The Moon Shards store is switched off (vendors.json), so no new sales come in.</div>';
    b += `<div class="tiles">${tile(money(m.centsRange), `sales (${c.range} days)`, `${fmt(m.salesRange)} purchases`)}${tile(money(m.cents), 'all-time sales', 'before store fees')}
${tile(fmt(payers), 'paying accounts')}${tile(payers ? money(m.cents / payers) : '–', 'per paying account')}${tile(fmt(m.shardsBought), 'Moon Shards bought')}
${tile(fmt(m.refunds), 'refunds', m.refunds ? money(m.refundCents) : '')}</div>`;
    b += '<div class="charts">';
    b += barChart({ title: 'Sales per day', labels: c.labels, values: m.perDay.map(x => x / 100), yFormat: v => '$' + fmt(v) });
    b += ui.chartBox({ title: 'By platform', sub: `last ${c.range} days (all time after the dot)` }, hbars(['Stripe (web)', 'Google Play', 'Steam', 'App Store'].concat(Object.keys(m.byPlatform).filter(k => !['Stripe (web)', 'Google Play', 'Steam', 'App Store'].includes(k)))
      .map((k, i) => [k, (m.byPlatformRange[k] || 0) || 0, 'all ' + money(m.byPlatform[k] || 0), SERIES[i % SERIES.length]]), { format: money, empty: 'No sales in this range.' }));
    b += ui.chartBox({ title: 'Top products (all time, real money)' }, hbars(sortDesc(m.products), { format: money, limit: 8, color: 'var(--s2)', empty: 'No sales yet.' }));
    b += ui.chartBox({ title: 'Top shard-store items (owners)' }, hbars(sortDesc(m.items), { limit: 8, color: 'var(--s3)', empty: 'Nothing bought with shards yet.' }));
    b += ui.chartBox({ title: 'Refunds by platform', sub: 'Stripe refunds and app-store take-backs' }, hbars(sortDesc(m.refundsByPlatform), { color: 'var(--s5)', empty: 'No refunds.' }));
    b += '</div>';
    parts.push(card('money', 'Money', 'Real-money purchases from the store\'s own records (read only - change things on <a href="/admin/store">Store &amp; payments</a>). Test purchases are left out.', b, days));
  }

  // ---------------------------------------------------------------- Health
  {
    const hl = c.health;
    const hr = k => hl.healthRange[k] || 0;
    const fr = c.fxRange;
    const dl = Object.entries(fr).filter(([k]) => k.startsWith('update_download.')).reduce((a, [, v]) => a + v, 0);
    const ins = Object.entries(fr).filter(([k]) => k.startsWith('update_install.')).reduce((a, [, v]) => a + v, 0);
    const failRows = Object.entries(fr).filter(([k]) => k.startsWith('update_fail.') && !k.startsWith('update_fail.why.')).map(([k, v]) => [PLAT_NAMES[plat(k.slice(12))] || k.slice(12), v]);
    const failN = sum(failRows.map(r => r[1]));
    const auth0 = safe(() => auth.status(), {});
    let b = `<div class="tiles">${tile(pct(c.total ? 1 - hl.crashed / c.total : null, 1), 'crash-free players', `${fmt(hl.crashed)} of ${fmt(c.total)} had an error`)}${tile(fmt(sum(hl.errorsByDay)), `errors (${c.range} days)`)}
${tile(fmt(hr('signin_fail')), 'failed sign-ins', `${fmt(hr('signin_ok'))} worked`)}${tile(fmt(hr('rate_limit')), 'rate-limit hits', 'game requests slowed down')}
${tile(fmt(failN), 'update failures', `${fmt(dl)} downloads · ${fmt(ins)} installs`)}${tile(fmt(hr('admin_fail')), 'wrong admin passwords', `${fmt(auth0.sessions || 0)} admin session${auth0.sessions === 1 ? '' : 's'} open`)}</div>`;
    b += '<div class="charts">';
    b += barChart({ title: 'Errors per day', labels: c.labels, values: hl.errorsByDay, color: '#d03b3b' });
    b += lineChart({ title: 'Sign-ins', labels: c.labels, series: [{ name: 'Worked', color: SERIES[2], values: (hl.healthByDay.signin_ok || c.labels.map(() => 0)) }, { name: 'Failed', color: SERIES[4], values: (hl.healthByDay.signin_fail || c.labels.map(() => 0)) }] });
    b += ui.chartBox({ title: 'Errors by version (all time)' }, hbars(sortDesc(hl.errByVersion), { color: '#d03b3b', limit: 8, empty: 'No errors reported.' }));
    b += ui.chartBox({ title: 'Errors by platform (all time)' }, hbars(sortDesc(hl.errByPlat).map(([k, v]) => [PLAT_NAMES[plat(k)] === 'Other' ? k : PLAT_NAMES[plat(k)], v]), { color: '#d03b3b', empty: 'No errors reported.' }));
    b += ui.chartBox({ title: 'Update failures', sub: `last ${c.range} days, by platform and reason` }, hbars(failRows.concat(Object.entries(fr).filter(([k]) => k.startsWith('update_fail.why.')).map(([k, v]) => ['why: ' + k.slice(16), v, '', 'var(--s4)'])), { color: '#d03b3b', empty: 'No update failures reported.' }));
    b += '</div>';
    b += `<h3>Top errors</h3>${hl.topErrors.length ? `<div class="scroll"><table class="tbl"><tr><th>Error</th><th class="n">Times</th><th class="n">Players</th><th>Last seen</th></tr>${hl.topErrors.map(e =>
      `<tr><td class="err">${esc(e.msg)}<code>${esc(String(e.stack || '').split('\n').slice(0, 2).join('\n'))}</code><span class="small" style="color:var(--muted)">versions ${esc(Object.keys(e.v || {}).slice(0, 6).join(', '))}${e.pl && Object.keys(e.pl).length ? ' · ' + esc(Object.keys(e.pl).join(', ')) : ''}</span></td><td class="n">${fmt(e.c)}</td><td class="n">${fmt(e.who)}</td><td>${esc(ui.short(new Date(e.l).toISOString().slice(0, 10)))}</td></tr>`).join('')}</table></div>` : '<p class="empty">No errors reported - nice.</p>'}`;
    parts.push(card('health', 'Health', 'Crashes and errors the games reported, sign-in problems, requests slowed down for speed, and automatic-update problems.', b, days));
  }

  parts.push(`<p class="foot">Players who switched "Share play stats" off in Settings aren't counted. Totals are for all time unless a range is shown. Hover (or tap) a chart for exact numbers; every section downloads as CSV (spreadsheet) or JSON.</p>`);
  return parts.join('\n');
}

// ============================================================================ downloads
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // a spreadsheet never runs what a game sent as a formula
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** One section as rows (the first is the header). */
function rowsFor(section, c) {
  const daily = (cols) => [['date'].concat(cols.map(x => x[0]))].concat(c.labels.map((k, i) => [k].concat(cols.map(x => x[1][i]))));
  switch (section) {
    case 'now': {
      const r = c.relay || {};
      const rows = [['measure', 'value'], ['playing_now', c.online.n], ['walking_now', c.online.foot]];
      for (const [k, n] of Object.entries(c.online.byPlatform || {})) rows.push(['playing_now_' + k, n]);
      rows.push(['open_festival_players', r.publicPlayers == null ? '' : r.publicPlayers], ['open_festival_capacity', r.publicCapacity == null ? '' : r.publicCapacity],
        ['live_rooms', r.rooms == null ? '' : r.rooms], ['room_players', r.roomPlayers == null ? '' : r.roomPlayers], ['room_players_old_builds', r.roomOld == null ? '' : r.roomOld]);
      return rows;
    }
    case 'growth': return daily([['dau', c.dau], ['wau', c.wau], ['mau', c.mau], ['new_installs', c.fresh], ['new_accounts', c.signups]]);
    case 'retention': {
      const today = dayIndex(c.now);
      const v = (first, off, kept, size) => first + off >= today || !size ? '' : (kept / size).toFixed(4);
      return [['first_played', 'players', 'd1', 'd7', 'd30']].concat(c.retention.cohorts.map(([first, k]) => [dayKey(first * DAY), k.size, v(first, 1, k.d1, k.size), v(first, 7, k.d7, k.size), v(first, 30, k.d30, k.size)]));
    }
    case 'engagement': return daily([['sessions', c.sessions], ['minutes_played', c.minutes.map(Math.round)], ['most_at_once', c.peaks]]);
    case 'versions': {
      const keys = c.buildSeries.map(k => k.key);
      return [['date'].concat(c.buildSeries.map(k => k.name))].concat(c.labels.map((d, i) => [d].concat(keys.map(k => c.buildRows[i][k] || 0))))
        .concat([[], ['platform_last_30_days', 'players']], Object.entries(c.mauPlat).map(([k, n]) => [k, n]),
          [[], ['device_last_30_days', 'players']], sortDesc(c.mauDevice).slice(0, 50).map(([k, n]) => [k, n]));
    }
    case 'accounts': return daily([['new_accounts', c.signups]]).concat([[], ['measure', 'value'], ['live_accounts', c.liveTotal], ['signed_in_last_30_days', c.acct30], ['anonymous_last_30_days', c.anon30], ['store_accounts', c.storeAccounts]]);
    case 'features': {
      const rows = [['tally', 'all_time', 'in_range']];
      const keys = new Set(Object.keys(c.fx).concat(Object.keys(c.fxRange)));
      for (const k of [...keys].sort()) rows.push([k, c.fx[k] || 0, c.fxRange[k] || 0]);
      RANK_NAMES.forEach((n, i) => rows.push(['players_at_rank.' + n, c.careerRanks[i], '']));
      rows.push(['career_complete_players', c.careerDone, ''], ['speedway_earned_players', c.swEarned, ''], ['speedway_bought_players', Math.max(c.swBought, c.money.speedwayOwners), '']);
      return rows;
    }
    case 'money': {
      const m = c.money;
      return daily([['sales_usd', m.perDay.map(x => (x / 100).toFixed(2))]]).concat([[], ['platform', 'all_time_usd', 'in_range_usd']],
        Object.keys(m.byPlatform).map(k => [k, (m.byPlatform[k] / 100).toFixed(2), ((m.byPlatformRange[k] || 0) / 100).toFixed(2)]),
        [[], ['product', 'all_time_usd']], sortDesc(m.products).map(([k, v]) => [k, (v / 100).toFixed(2)]),
        [[], ['shard_item', 'owners']], sortDesc(m.items).map(([k, v]) => [k, v]),
        [[], ['refunds_platform', 'count']], Object.entries(m.refundsByPlatform));
    }
    case 'health': {
      const h = c.health;
      const kinds = Object.keys(h.healthByDay).sort();
      return daily([['errors', h.errorsByDay]].concat(kinds.map(k => [k, h.healthByDay[k]])))
        .concat([[], ['error', 'first_line', 'times', 'players', 'last_seen', 'versions', 'platforms']],
          h.topErrors.map(e => [e.msg, String(e.stack || '').split('\n')[0], e.c, e.who, new Date(e.l).toISOString(), Object.keys(e.v || {}).join(' '), Object.keys(e.pl || {}).join(' ')]));
    }
    default: return null;
  }
}

function exportSection(res, section, format, c) {
  const rows = rowsFor(section, c);
  if (!rows) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('No such section.'); return; }
  const name = `new-moon-${section}-${c.range}d-${dayKey(c.now)}`;
  const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (format === 'json') {
    // (a section can hold several small tables, separated by an empty row - each starts with its own header)
    const items = [];
    let head = null;
    for (const r of rows) {
      if (!r.length) { head = null; continue; }
      if (!head) { head = r; continue; }
      items.push(Object.fromEntries(head.map((k, i) => [k, r[i] == null ? '' : r[i]])));
    }
    res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}.json"` }, common));
    res.end(JSON.stringify({ section, range: c.range, generated: new Date(c.now).toISOString(), rows: items }, null, 1));
    return;
  }
  res.writeHead(200, Object.assign({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"` }, common));
  res.end(rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n');
}

// ============================================================================ requests
function handle(req, res, route) {
  const url = new URL(req.url, 'http://relay');
  const days = url.searchParams.get('days') === '90' ? 90 : 30;
  auth.guard(req, res, { path: '/admin/stats', limit: 8 * 1024 }).then(g => {
    if (!g) return;
    const c = compute(days);
    if (route === '/admin/stats/export') {
      exportSection(res, String(url.searchParams.get('section') || ''), url.searchParams.get('format') === 'json' ? 'json' : 'csv', c);
      return;
    }
    pay().page(res, 200, 'Play stats - New Moon admin', render(c, g.token, days));
  }).catch(err => {
    console.error('stats page', err && err.message);
    if (!res.headersSent) pay().page(res, 500, 'Try again', '<h1>Something went wrong</h1><p>Try again in a moment.</p>');
  });
}

module.exports = { handle, compute, render, rowsFor, csvCell, _test: { clearCache: () => { cache = { at: 0, range: 0, data: null }; }, graceInfo } };
