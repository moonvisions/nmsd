'use strict';
// Round 71: PLAY STATS - who plays, for how long, what they do, and your private dashboard.
//
// WHAT IT IS
//  - The game (unless the player turned "Share play stats" off in Settings) tells this server three things:
//      POST /stats/start   when the game opens   (install id, version, platform, device, language, account / player name)
//      POST /stats/beat    every minute or so    (how long it's been played since the last one, map or on foot)
//      POST /stats/events  now and then          (festival started / finished, a mini-game, a photo, a purchase, a crash...)
//    Nothing here can change anyone's game; it's only counted.
//  - /admin/stats is your dashboard (the same ADMIN_KEY password as /admin): players online right now, daily /
//    weekly / monthly players, new players, how many come back (day 1 / 7 / 30), session length, the path from
//    first launch to a finished festival, platforms and versions, what people play, festivals, money, crashes,
//    every player and every account - and CSV downloads for a spreadsheet.
//
// KEPT WHERE
//  - analytics.json in STORE_DATA_DIR (the permanent disk) - with analytics.json.bak, the version before. Without a
//    disk it's kept next to the code and starts from zero whenever the free server restarts (the page says so).
//
// LIMITS: 32 KB a request, 600 requests a minute from one address (a venue's Wi-Fi shares one), 40 a minute per
// install; 200,000 installs; 400 active days remembered per install; 300 different errors; 200 different activity ids.
//
// Round 75: "activity" events aren't only mini-games any more - the game also sends level_up, mission_done, bag_open,
// role_goer / role_dj / role_vendor / role_medic / role_security / role_crew, stream_fail, voice_on, openmic, apply_sent,
// sync_pull, sync_push (plus unlock_* and legend_*). Each id is counted all-time (acts) AND per day (days[].a), so the
// dashboard's "Progress & live" panel can show the last 7 days. The server itself counts dj_live / dj_stop the same way
// (noteActivity - the patch bay calls it when a DJ goes live or stops).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pay = () => require('./payments');   // lazy (payments.js requires this file for its admin page)
const store = () => require('./store');

const DATA_DIR = process.env.PATCHBAY_DIR || process.env.STORE_DATA_DIR || __dirname;
const PERSISTENT = !!(process.env.PATCHBAY_DIR || process.env.STORE_DATA_DIR);
const FILE = path.join(DATA_DIR, 'analytics.json');
const DAY = 86400000;
const ONLINE_MS = 150000;           // a heartbeat within the last 2.5 minutes = playing now
const MAX_INSTALLS = 200000;
const MAX_DAYS_PER_INSTALL = 400;
const MAX_ERRORS = 300;
const MAX_ACTIVITIES = 200;
const KEEP_DAYS = 400;              // daily summaries kept this long

const EVENTS = new Set(['festival_start', 'festival_end', 'festival_leave', 'tier', 'walk', 'demo_start', 'demo_end',
  'open_join', 'open_leave', 'mp_host', 'mp_join', 'activity', 'photo', 'purchase', 'error', 'quit', 'signup', 'guide']);
const FUNNEL = [
  ['start', 'Opened the game'],
  ['demo', 'Played the demo festival'],
  ['career', 'Started a festival of their own'],
  ['finish', 'Finished a festival'],
  ['walk', 'Walked the festival on foot'],
  ['social', 'Played online (Open Festival or friends)'],
  ['back', 'Came back on another day'],
  ['buy', 'Bought something']
];

// ============================================================================ the data
/** A plain lookup with no built-in keys ("constructor", "__proto__" are just names here - players choose some of these keys). */
const dict = o => Object.assign(Object.create(null), o || {});

function blank() {
  return { v: 1, since: Date.now(), installs: dict(), days: dict(), errors: dict(), acts: dict(), fest: { n: 0, att: 0, profit: 0, sat: 0, grades: dict() } };
}

/** After loading: every lookup without built-in keys again, and anything that isn't what it should be dropped. */
function repair() {
  state.installs = dict(state.installs);
  state.days = dict(state.days);
  state.errors = dict(state.errors);
  state.acts = dict(state.acts);
  state.fest = Object.assign({ n: 0, att: 0, profit: 0, sat: 0 }, state.fest);
  state.fest.grades = dict(state.fest.grades);
  for (const k in state.acts) if (typeof state.acts[k] !== 'number') delete state.acts[k];
  for (const e of Object.values(state.errors)) e.v = dict(e.v);
  for (const d of Object.values(state.days)) {
    d.e = dict(d.e);
    d.a = dict(d.a);   // Round 75: that day's activity counts by id
    for (const k in d.a) if (typeof d.a[k] !== 'number') delete d.a[k];
  }
  for (const p of Object.values(state.installs)) { p.fl = dict(p.fl); if (p.ers) p.ers = dict(p.ers); if (!Array.isArray(p.ad)) p.ad = []; }
  installCount = Object.keys(state.installs).length;
}

let state = blank();
let loadNote = '';
let installCount = 0;

function load() {
  for (const file of [FILE, FILE + '.bak']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || !data.installs) throw new Error('not a stats file');
      state = Object.assign(blank(), data);
      repair();
      if (file !== FILE) loadNote = 'The main stats file was missing or damaged, so the backup was loaded.';
      return;
    } catch (err) {
      console.error('analytics: ' + path.basename(file) + ' is damaged:', err && err.message);
    }
  }
}
load();

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 15000);
  if (saveTimer.unref) saveTimer.unref();
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* first save */ }
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('analytics save', err && err.message);
  }
}

// ============================================================================ small helpers
const dayIndex = ms => Math.floor(ms / DAY);
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const word = (v, max) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, max);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const h = s => pay().escapeHtml(s);

function ipOf(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
}

const hits = new Map();          // the game's requests, per address / per install (one minute windows)
const adminFails = new Map();    // wrong admin passwords, per address - its own list, never cleared to make room
/** True while `key` has been seen fewer than `max` times in the window (and counts this time). */
function allow(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 100000) {
    // Full (lots of addresses at once): drop the oldest keys, never all of them.
    let n = 0;
    for (const k of hits.keys()) { hits.delete(k); if (++n >= 20000) break; }
  }
  return true;
}
function countFails(key) {
  const now = Date.now();
  return (adminFails.get(key) || []).filter(t => now - t < 600000).length;
}
function noteFail(key) {
  const list = (adminFails.get(key) || []).filter(t => Date.now() - t < 600000);
  list.push(Date.now());
  adminFails.set(key, list.slice(-60));
}
function forgiveFail(key) {
  const list = adminFails.get(key);
  if (list && list.length) list.pop();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.some(t => now - t < 120000)) hits.delete(k);
  for (const [k, list] of adminFails) if (!list.some(t => now - t < 600000)) adminFails.delete(k);
}, 60000).unref();

function day(ms) {
  const key = dayKey(ms);
  let d = state.days[key];
  if (!d) {
    d = state.days[key] = { n: 0, s: 0, m: 0, pk: 0, e: dict(), a: dict() };
    // Old summaries go (a day at a time, so this is cheap).
    const cutoff = dayKey(ms - KEEP_DAYS * DAY);
    for (const k of Object.keys(state.days)) if (k < cutoff) delete state.days[k];
  }
  return d;
}

// ============================================================================ live players (heartbeats in memory)
const live = new Map();   // session id -> { iid, at, view, p }
let relay = null;          // relay.js tells us about rooms and the Open Festival (attach)

function attach(hooks) { relay = hooks || null; }

function onlineNow() {
  const now = Date.now();
  let n = 0, foot = 0;
  const byPlatform = {};
  for (const [sid, s] of live) {
    if (now - s.at > ONLINE_MS) { live.delete(sid); continue; }
    n++;
    if (s.view === 'foot') foot++;
    byPlatform[s.p || '?'] = (byPlatform[s.p || '?'] || 0) + 1;
  }
  return { n, foot, byPlatform };
}

let lastPeakAt = 0;
function notePeak() {
  const now = Date.now();
  if (now - lastPeakAt < 5000) return;   // (it walks the whole online list - every few seconds is plenty)
  lastPeakAt = now;
  const n = onlineNow().n;
  const d = day(Date.now());
  if (n > d.pk) d.pk = n;
}

// ============================================================================ what the game sends
function install(iid, now) {
  let p = state.installs[iid];
  if (!p) {
    if (installCount >= MAX_INSTALLS) pruneInstalls(now);
    if (installCount >= MAX_INSTALLS) return null;
    p = state.installs[iid] = { f: now, l: now, s: 0, m: 0, ft: 0, ad: [], fl: dict({ start: 1 }), fs: 0, ff: 0 };
    installCount++;
    day(now).n++;
  }
  return p;
}

/** Full: forget one-visit installs not seen for 30 days (made-up ones fill the list that way too), oldest first. */
function pruneInstalls(now) {
  const old = Object.entries(state.installs).filter(([, p]) => p.s <= 1 && now - p.l > 30 * DAY).sort((a, b) => a[1].l - b[1].l);
  for (const [iid] of old.slice(0, Math.max(1000, Math.floor(MAX_INSTALLS * 0.05)))) { delete state.installs[iid]; installCount--; }
}

function active(p, now) {
  p.l = now;
  const d = dayIndex(now);
  if (!p.ad.length || p.ad[p.ad.length - 1] !== d) {
    p.ad.push(d);
    if (p.ad.length > MAX_DAYS_PER_INSTALL) p.ad.splice(0, p.ad.length - MAX_DAYS_PER_INSTALL);
    if (p.ad.length >= 2) p.fl.back = 1;
  }
}

function onStart(b, now) {
  const p = install(b.iid, now);
  if (!p) return;
  active(p, now);
  p.s++;
  p.p = word(b.plat, 16) || p.p || '?';
  p.v = str(b.v, 24) || p.v;
  p.o = str(b.os, 60) || p.o;
  p.d = str(b.dev, 60) || p.d;
  p.g = word(b.lang, 24) || p.g;
  p.st = word(b.store, 12) || p.st;
  if (b.acct) p.a = str(b.acct, 24);
  if (b.name) p.n = str(b.name, 40);
  if (b.gfx) p.gx = word(b.gfx, 10);
  if (b.touch != null) p.tc = b.touch ? 1 : 0;
  const d = day(now);
  d.s++;
  live.set(b.sid, { iid: b.iid, at: now, view: 'map', p: p.p });
  notePeak();
  save();
}

function onBeat(b, now) {
  const minutes = num(b.sec, 0, 180) / 60;
  if (minutes <= 0) return;   // the game sat in the background: not playing (not "online", not a day played)
  const p = install(b.iid, now);
  if (!p) return;
  active(p, now);
  p.m += minutes;
  const view = word(b.view, 8) === 'foot' ? 'foot' : 'map';
  if (view === 'foot') { p.ft += minutes; p.fl.walk = 1; }
  if (b.lvl) p.lv = num(b.lvl, 0, 9999);
  if (b.tier) p.t = str(b.tier, 30);
  if (b.acct) p.a = str(b.acct, 24);
  if (b.name) p.n = str(b.name, 40);
  day(now).m += minutes;
  live.set(b.sid, { iid: b.iid, at: now, view, p: p.p || '?' });
  notePeak();
  save();
}

/** One activity id, all-time and for the day <d> (new ids are only taken in while there's room: MAX_ACTIVITIES of them). */
function countActivity(id, d) {
  if (!id) return;
  if (state.acts[id] == null && Object.keys(state.acts).length >= MAX_ACTIVITIES) return;
  state.acts[id] = (state.acts[id] || 0) + 1;
  if (!d.a) d.a = dict();
  if (d.a[id] == null && Object.keys(d.a).length >= MAX_ACTIVITIES) return;
  d.a[id] = (d.a[id] || 0) + 1;
}

/**
 * Round 75: the server counts something itself (the patch bay: "dj_live", "dj_stop") - exactly as if a game had sent
 * {n:"activity", a:{id}}, except there's no install behind it, so no player's record changes.
 */
function noteActivity(id) {
  id = word(id, 24);
  if (!id) return;
  const d = day(Date.now());
  d.e.activity = (d.e.activity || 0) + 1;
  countActivity(id, d);
  save();
}

function onEvents(b, now) {
  const p = install(b.iid, now);
  if (!p) return;
  active(p, now);
  const list = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
  const d = day(now);
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const name = EVENTS.has(e.n) ? e.n : 'other';
    const a = e.a && typeof e.a === 'object' ? e.a : {};
    d.e[name] = (d.e[name] || 0) + 1;
    switch (name) {
      case 'festival_start':
        if (a.demo) { p.fl.demo = 1; break; }
        if (a.visitor) { p.fl.social = 1; break; }
        p.fs++;
        p.fl.career = 1;
        break;
      case 'festival_end': {
        if (a.demo || a.visitor) break;
        p.ff++;
        p.fl.finish = 1;
        const f = state.fest;
        f.n++;
        f.att += num(a.att, 0, 1e7);
        f.profit += num(a.profit, -1e9, 1e9);
        f.sat += num(a.sat, 0, 100);
        const g = str(a.grade, 3) || '?';
        f.grades[g] = (f.grades[g] || 0) + 1;
        break;
      }
      case 'demo_start': p.fl.demo = 1; break;
      case 'walk': p.fl.walk = 1; break;
      case 'open_join': case 'mp_host': case 'mp_join': p.fl.social = 1; break;
      case 'tier': if (a.title) p.t = str(a.title, 30); break;
      case 'purchase': p.fl.buy = 1; p.buys = (p.buys || 0) + 1; break;
      case 'signup': if (a.acct) p.a = str(a.acct, 24); break;
      case 'activity': countActivity(word(a.id, 24), d); break;
      case 'error': {
        const msg = str(a.msg, 200);
        if (!msg) break;
        const stack = String(a.stack == null ? '' : a.stack).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, 600).trim();
        const key = crypto.createHash('sha1').update(msg + '|' + stack.split('\n')[0]).digest('hex').slice(0, 16);
        let err = state.errors[key];
        if (!err) {
          if (Object.keys(state.errors).length >= MAX_ERRORS) {
            // Make room: forget the one seen least recently.
            let oldest = null;
            for (const [k, v] of Object.entries(state.errors)) if (!oldest || v.l < state.errors[oldest].l) oldest = k;
            if (oldest) delete state.errors[oldest];
          }
          err = state.errors[key] = { msg, stack, c: 0, f: now, l: now, who: 0, v: dict() };
        }
        err.c++;
        err.l = now;
        const ver = str(p.v, 24) || '?';
        err.v[ver] = (err.v[ver] || 0) + 1;
        if (!p.ers) p.ers = dict();
        if (!p.ers[key] && Object.keys(p.ers).length < 64) { p.ers[key] = 1; err.who++; }
        p.er = (p.er || 0) + 1;
        break;
      }
      case 'quit': live.delete(b.sid); break;
      default: break;
    }
  }
  save();
}

// ============================================================================ requests
function readBody(req, limit) {
  return new Promise(resolve => {
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > limit) { tooBig = true; body = ''; resolve(null); }
    });
    req.on('end', () => resolve(tooBig ? null : body));
    req.on('error', () => resolve(null));
  });
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const ID = /^[a-f0-9]{32}$/;

function answer(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS));
  res.end(JSON.stringify(obj));
}

function gameCall(req, res, route) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, Object.assign({ 'access-control-max-age': '600' }, CORS));
    res.end();
    return;
  }
  if (req.method !== 'POST') { answer(res, 405, { ok: false }); return; }
  const ip = ipOf(req);
  if (!allow('ip|' + ip, 600, 60000)) { answer(res, 429, { ok: false }); return; }   // (a venue's Wi-Fi shares one address)
  readBody(req, 32 * 1024).then(text => {
    if (text == null) { answer(res, 413, { ok: false }); setImmediate(() => req.destroy()); return; }
    let b;
    try { b = JSON.parse(text); } catch { answer(res, 400, { ok: false }); return; }
    if (!b || typeof b !== 'object' || typeof b.iid !== 'string' || typeof b.sid !== 'string' || !ID.test(b.iid) || !ID.test(b.sid)) { answer(res, 400, { ok: false }); return; }
    if (!allow('iid|' + b.iid, 40, 60000)) { answer(res, 429, { ok: false }); return; }
    const now = Date.now();
    try {
      if (route === '/stats/start') onStart(b, now);
      else if (route === '/stats/beat') onBeat(b, now);
      else onEvents(b, now);
    } catch (err) {
      console.error('analytics', err && err.message);
    }
    answer(res, 200, { ok: true });
  });
}

/** Handles /stats/* and /admin/stats. Returns true if it answered. */
function handle(req, res) {
  let route;
  try { route = new URL(req.url, 'http://relay').pathname; } catch { return false; }
  if (route === '/stats/start' || route === '/stats/beat' || route === '/stats/events') { gameCall(req, res, route); return true; }
  if (route === '/admin/stats') { admin(req, res); return true; }
  return false;
}

// ============================================================================ the numbers
function compute() {
  const now = Date.now();
  const today = dayIndex(now);
  const all = Object.values(state.installs);
  const total = all.length;

  // Money (the Moon Shards store's records - Stripe and the app stores).
  let shop = { open: false, accounts: [], sales: [] };
  try { if (typeof store().stats === 'function') shop = store().stats(); } catch (err) { console.error('analytics store', err && err.message); }
  let revenue = 0, revenue30 = 0, playerRevenue = 0;
  const payers = new Set(), byVia = dict();
  for (const s of shop.sales) {
    revenue += s.cents;
    if (s.account) playerRevenue += s.cents;
    const at = typeof s.at === 'number' ? s.at : Date.parse(s.at);
    if (Number.isFinite(at) && at > now - 30 * DAY) revenue30 += s.cents;
    if (s.account) payers.add(s.account);
    byVia[s.via || '?'] = (byVia[s.via || '?'] || 0) + s.cents;
  }

  let dau = 0, wau = 0, mau = 0, sessions = 0, minutes = 0, foot = 0;
  const platforms = dict(), versions = dict(), langs = dict(), devices = dict(), stores = dict();
  const funnel = dict();
  for (const [k] of FUNNEL) funnel[k] = 0;
  const activeDays = new Map();   // day index -> active installs that day
  for (const p of all) {
    const last = p.ad.length ? p.ad[p.ad.length - 1] : dayIndex(p.l);
    if (last === today) dau++;
    if (last > today - 7) wau++;
    if (last > today - 30) mau++;
    sessions += p.s;
    minutes += p.m;
    foot += p.ft || 0;
    platforms[p.p || '?'] = (platforms[p.p || '?'] || 0) + 1;
    versions[p.v || '?'] = (versions[p.v || '?'] || 0) + 1;
    langs[p.g || '?'] = (langs[p.g || '?'] || 0) + 1;
    if (p.d) devices[p.d] = (devices[p.d] || 0) + 1;
    if (p.st) stores[p.st] = (stores[p.st] || 0) + 1;
    for (const [k] of FUNNEL) if ((p.fl && p.fl[k]) || (k === 'buy' && p.a && payers.has(p.a))) funnel[k]++;   // (bought = a real sale on their account)
    for (const d of p.ad) if (d > today - 31) activeDays.set(d, (activeDays.get(d) || 0) + 1);
  }

  // Retention: of the players who first played on a day, how many played again 1, 7 and 30 days later.
  const cohorts = new Map();   // first day -> {size, d1, d7, d30}
  for (const p of all) {
    const first = dayIndex(p.f);
    if (first < today - 60) continue;
    let c = cohorts.get(first);
    if (!c) cohorts.set(first, c = { size: 0, d1: 0, d7: 0, d30: 0 });
    c.size++;
    const set = new Set(p.ad);
    if (set.has(first + 1)) c.d1++;
    if (set.has(first + 7)) c.d7++;
    if (set.has(first + 30)) c.d30++;
  }
  const avg = (dayOffset, keyName) => {
    let size = 0, kept = 0;
    for (const [first, c] of cohorts) {
      if (first + dayOffset >= today) continue;   // not old enough to know yet
      size += c.size;
      kept += c[keyName];
    }
    return size ? kept / size : null;
  };

  const series = [];
  for (let d = today - 29; d <= today; d++) {
    const key = dayKey(d * DAY);
    const s = state.days[key] || { n: 0, s: 0, m: 0, pk: 0, e: {} };
    series.push({ key, active: activeDays.get(d) || 0, fresh: s.n, sessions: s.s, minutes: s.m, peak: s.pk });
  }

  const events30 = dict();
  const acts7 = dict();   // Round 75: activity ids in the last 7 days
  for (const s of series) {
    const d = state.days[s.key];
    if (!d) continue;
    for (const [k, v] of Object.entries(d.e || {})) events30[k] = (events30[k] || 0) + v;
    if (s.key >= dayKey(now - 6 * DAY)) for (const [k, v] of Object.entries(d.a || {})) acts7[k] = (acts7[k] || 0) + v;
  }

  return {
    now, total, dau, wau, mau, sessions, minutes, foot, platforms, versions, langs, devices, stores, funnel, series, events30, acts7,
    cohorts: [...cohorts.entries()].sort((a, b) => b[0] - a[0]).slice(0, 14),
    d1: avg(1, 'd1'), d7: avg(7, 'd7'), d30: avg(30, 'd30'),
    money: shop, revenue, revenue30, playerRevenue, payers: payers.size, byVia,
    online: onlineNow(),
    relay: relay && typeof relay.live === 'function' ? safe(relay.live) : null
  };
}

function safe(fn) { try { return fn(); } catch { return null; } }

// ============================================================================ the dashboard
const CSS = `<style>
main{max-width:1100px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr));gap:10px;margin:10px 0 18px}
.tile{background:#1a1d24;border:1px solid #2a2e38;border-radius:10px;padding:12px}
.tile b{display:block;font-size:26px;color:#fff;line-height:1.1}
.tile span{font-size:12px;color:#9aa3b2}
.tile.live b{color:#5be38a}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:16px}
table.list{display:block;overflow-x:auto;max-width:100%}
table.barrow{width:100%;table-layout:fixed}
table.barrow td{white-space:nowrap}
table.barrow td:first-child{width:40%;overflow:hidden;text-overflow:ellipsis}
table.barrow td:nth-child(n+3){width:64px;text-align:right}
pre{overflow-x:auto}
table.funnel td:first-child{white-space:normal}
.bar{height:8px;background:#e8b14c;border-radius:4px;min-width:2px}
.barrow td{padding:3px 6px}
.muted{color:#9aa3b2}
.warn{background:#3a2a10;border:1px solid #e8b14c;border-radius:8px;padding:10px;margin:10px 0}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
form.inline{display:inline}
button.ghost{background:transparent;color:#e8b14c;border:1px solid #e8b14c}
table.list td,table.list th{font-size:13px;padding:5px 6px;text-align:left;border-bottom:1px solid #2a2e38;vertical-align:top}
table.list th{color:#9aa3b2;font-weight:600}
.dot{display:inline-block;width:8px;height:8px;border-radius:4px;background:#5be38a;margin-right:5px}
pre{white-space:pre-wrap;font-size:11px;color:#9aa3b2;margin:4px 0 0}
svg text{fill:#9aa3b2;font-size:10px}
</style>`;

const pct = v => v == null ? '–' : Math.round(v * 100) + '%';
const fmt = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const money = cents => '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hours = minutes => minutes >= 90 ? (minutes / 60).toFixed(1) + ' h' : Math.round(minutes) + ' min';
function when(ms) {
  if (!ms) return '–';
  const d = Date.now() - ms;
  if (d < 120000) return 'just now';
  if (d < 3600000) return Math.round(d / 60000) + ' min ago';
  if (d < DAY) return Math.round(d / 3600000) + ' h ago';
  if (d < 30 * DAY) return Math.round(d / DAY) + ' days ago';
  return new Date(ms).toISOString().slice(0, 10);
}

const EVENT_NAMES = {
  festival_start: 'Festival started', festival_end: 'Festival finished', festival_leave: 'Left a friend\'s festival', tier: 'Promoted (career tier)',
  walk: 'Walked the festival', demo_start: 'Demo festival started', demo_end: 'Demo festival ended', open_join: 'Joined the Open Festival',
  open_leave: 'Left the Open Festival', mp_host: 'Hosted friends', mp_join: 'Joined friends', activity: 'Played a mini-game', photo: 'Took a photo',
  purchase: 'Bought something', error: 'Error / crash', quit: 'Closed the game', signup: 'Made an account', guide: 'Guide step', other: 'Other'
};

// Round 75: the "Progress & live" panel - what the game reports about progress, roles, streams and syncing (and the two the
// server counts itself). Shown in this order, with any other activity id that matches these families after them.
const PROGRESS_IDS = [
  ['level_up', 'Levelled up'], ['mission_done', 'Mission finished'], ['bag_open', 'Opened the bag'],
  ['role_goer', 'Role: festival goer'], ['role_dj', 'Role: DJ'], ['role_vendor', 'Role: vendor'], ['role_medic', 'Role: medic'],
  ['role_security', 'Role: security'], ['role_crew', 'Role: crew'],
  ['stream_fail', 'A DJ stream failed to play'], ['voice_on', 'Turned voice chat on'], ['openmic', 'Open mic'],
  ['apply_sent', 'Sent an artist application'], ['sync_pull', 'Saved game pulled from the server'], ['sync_push', 'Saved game pushed to the server'],
  ['dj_live', 'DJ went live (patch bay)'], ['dj_stop', 'DJ set ended (patch bay)']
];

function tile(value, label, cls) { return `<div class="tile${cls ? ' ' + cls : ''}"><b>${h(value)}</b><span>${h(label)}</span></div>`; }

function progressTable(acts7) {
  const known = new Set(PROGRESS_IDS.map(([id]) => id));
  const rows = PROGRESS_IDS.map(([id, label]) => [id, label]);
  for (const id of Object.keys(state.acts).sort()) {
    if (!known.has(id) && /^(unlock_|legend_|role_|sync_)/.test(id)) rows.push([id, id]);
  }
  const any = rows.some(([id]) => state.acts[id] || acts7[id]);
  if (!any) return '<p class="muted small">Nothing yet - these appear once players run a game version that reports them.</p>';
  return `<table class="list"><tr><th>What</th><th>Last 7 days</th><th>All time</th></tr>${rows.map(([id, label]) =>
    `<tr><td>${h(label)}<br><span class="small muted">${h(id)}</span></td><td>${fmt(acts7[id] || 0)}</td><td>${fmt(state.acts[id] || 0)}</td></tr>`).join('')}</table>
<p class="small muted">"Last 7 days" counts from the per-day tally kept since this update; "All time" is the total since counting began.</p>`;
}

function barTable(obj, limit, format) {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit || 12);
  if (!rows.length) return '<p class="muted small">Nothing yet.</p>';
  const max = Math.max(...rows.map(r => r[1]), 1);
  return `<table class="barrow">${rows.map(([k, v]) => `<tr><td>${h(k)}</td><td><div class="bar" style="width:${Math.round(v / max * 100)}%"></div></td><td class="muted">${format ? format(v) : fmt(v)}</td></tr>`).join('')}</table>`;
}

/** Two series (active players, new players) as a small bar chart, last 30 days. */
function chart(series) {
  const W = 1000, H = 160, pad = 18;
  const max = Math.max(1, ...series.map(s => Math.max(s.active, s.fresh)));
  const bw = (W - pad * 2) / series.length;
  let bars = '';
  series.forEach((s, i) => {
    const x = pad + i * bw;
    const ha = (s.active / max) * (H - 36);
    const hn = (s.fresh / max) * (H - 36);
    bars += `<rect x="${(x + 2).toFixed(1)}" y="${(H - 18 - ha).toFixed(1)}" width="${(bw * 0.55).toFixed(1)}" height="${ha.toFixed(1)}" fill="#e8b14c"><title>${s.key}: ${s.active} played</title></rect>`;
    bars += `<rect x="${(x + 2 + bw * 0.55).toFixed(1)}" y="${(H - 18 - hn).toFixed(1)}" width="${(bw * 0.3).toFixed(1)}" height="${hn.toFixed(1)}" fill="#5bb8e3"><title>${s.key}: ${s.fresh} new</title></rect>`;
    if (i % 5 === 0 || i === series.length - 1) bars += `<text x="${(x + 2).toFixed(1)}" y="${H - 4}">${s.key.slice(5)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Players per day">${bars}<text x="${pad}" y="12">most: ${max}</text></svg>
<p class="small muted"><span style="color:#e8b14c">&#9632;</span> played that day &nbsp; <span style="color:#5bb8e3">&#9632;</span> new players</p>`;
}

function hidden(key) { return `<input type="hidden" name="key" value="${h(key)}">`; }

function dashboard(key, q) {
  const c = compute();
  const parts = [CSS];
  parts.push('<h1>Play stats</h1>');
  parts.push(`<div class="row"><form class="inline" method="post" action="/admin/stats">${hidden(key)}<button type="submit">Refresh</button></form>
<form class="inline" method="post" action="/admin/stats">${hidden(key)}<input type="hidden" name="action" value="csv"><button type="submit" class="ghost">Download players (CSV)</button></form>
<form class="inline" method="post" action="/admin/stats">${hidden(key)}<input type="hidden" name="action" value="daily"><button type="submit" class="ghost">Download daily numbers (CSV)</button></form>
<form class="inline" method="post" action="/admin">${hidden(key)}<button type="submit" class="ghost">Back to admin</button></form></div>`);
  if (!PERSISTENT) parts.push('<div class="warn">These numbers start again from zero whenever the free server restarts. To keep them, add the permanent disk (STORE_DATA_DIR - see README.txt, "Moon Shards", step B).</div>');
  if (loadNote) parts.push(`<div class="warn">${h(loadNote)}</div>`);

  // Right now
  const r = c.relay || {};
  parts.push('<h2>Right now</h2><div class="grid">');
  parts.push(tile(fmt(c.online.n), 'playing now', 'live'));
  parts.push(tile(fmt(c.online.foot), 'walking the festival'));
  if (r.publicPlayers != null) parts.push(tile(`${fmt(r.publicPlayers)} / ${fmt(r.publicCapacity)}`, 'in the Open Festival'));
  if (r.rooms != null) parts.push(tile(fmt(r.rooms), 'friends\' rooms open'));
  if (r.roomPlayers != null) parts.push(tile(fmt(r.roomPlayers), 'players in friends\' rooms'));
  parts.push(tile(fmt(day(c.now).pk), 'most at once today'));
  parts.push('</div>');

  // Players
  const avgSession = c.sessions ? c.minutes / c.sessions : 0;
  parts.push('<h2>Players</h2><div class="grid">');
  parts.push(tile(fmt(c.total), 'players ever (installs)'));
  parts.push(tile(fmt(c.money.accounts.length), 'accounts made'));
  parts.push(tile(fmt(c.dau), 'played today (DAU)'));
  parts.push(tile(fmt(c.wau), 'last 7 days (WAU)'));
  parts.push(tile(fmt(c.mau), 'last 30 days (MAU)'));
  parts.push(tile(c.mau ? pct(c.dau / c.mau) : '–', 'stickiness (DAU / MAU)'));
  parts.push(tile(fmt(c.series[c.series.length - 1].fresh), 'new today'));
  parts.push(tile(fmt(c.series.reduce((a, s) => a + s.fresh, 0)), 'new in 30 days'));
  parts.push('</div>');
  parts.push(chart(c.series));

  // Engagement
  parts.push('<h2>How long they play</h2><div class="grid">');
  parts.push(tile(hours(avgSession), 'average session'));
  parts.push(tile(c.total ? (c.sessions / c.total).toFixed(1) : '–', 'sessions per player'));
  parts.push(tile(hours(c.total ? c.minutes / c.total : 0), 'play time per player'));
  parts.push(tile(fmt(c.minutes / 60), 'hours played in total'));
  parts.push(tile(c.minutes ? pct(c.foot / c.minutes) : '–', 'of play time on foot'));
  parts.push('</div>');

  // Retention
  parts.push('<h2>Do they come back?</h2><div class="grid">');
  parts.push(tile(pct(c.d1), 'next day (D1)'));
  parts.push(tile(pct(c.d7), 'a week later (D7)'));
  parts.push(tile(pct(c.d30), 'a month later (D30)'));
  parts.push('</div>');
  parts.push('<p class="small muted">Out of the players who first played on a day, how many played again exactly 1, 7 and 30 days later. Games usually aim for about 40% / 15% / 5%. "–" = not enough days yet.</p>');
  if (c.cohorts.length) {
    const today = dayIndex(c.now);
    const cell = (first, off, kept, size) => first + off >= today ? '<td class="muted">…</td>' : `<td>${pct(size ? kept / size : null)}</td>`;
    parts.push(`<table class="list"><tr><th>First played</th><th>Players</th><th>D1</th><th>D7</th><th>D30</th></tr>${c.cohorts.map(([first, k]) =>
      `<tr><td>${dayKey(first * DAY)}</td><td>${k.size}</td>${cell(first, 1, k.d1, k.size)}${cell(first, 7, k.d7, k.size)}${cell(first, 30, k.d30, k.size)}</tr>`).join('')}</table>`);
  }

  // Funnel
  parts.push('<h2>From first launch to hooked</h2>');
  const base = c.funnel.start || 0;
  parts.push(`<table class="barrow funnel">${FUNNEL.map(([k, label]) => {
    const n = c.funnel[k] || 0;
    return `<tr><td>${h(label)}</td><td><div class="bar" style="width:${base ? Math.round(n / base * 100) : 0}%"></div></td><td>${fmt(n)}</td><td class="muted">${base ? pct(n / base) : '–'}</td></tr>`;
  }).join('')}</table>`);

  // Where
  parts.push('<div class="cols">');
  parts.push(`<div><h2>Platforms</h2>${barTable(c.platforms)}</div>`);
  parts.push(`<div><h2>Game versions</h2>${barTable(c.versions, 8)}</div>`);
  parts.push(`<div><h2>Where they got it</h2>${barTable(c.stores)}</div>`);
  parts.push(`<div><h2>Languages</h2>${barTable(c.langs, 8)}</div>`);
  parts.push(`<div><h2>Devices</h2>${barTable(c.devices, 10)}</div>`);
  parts.push('</div>');

  // What they do
  const f = state.fest;
  parts.push('<div class="cols">');
  parts.push(`<div><h2>What they play (all time)</h2>${barTable(state.acts, 15)}</div>`);
  const named = dict();
  for (const [k, v] of Object.entries(c.events30)) named[EVENT_NAMES[k] || k] = v;
  parts.push(`<div><h2>What happened (last 30 days)</h2>${barTable(named, 15)}</div>`);
  parts.push(`<div><h2>Festivals finished</h2><div class="grid">${tile(fmt(f.n), 'festivals finished')}${tile(f.n ? fmt(f.att / f.n) : '–', 'average crowd')}${tile(f.n ? money(f.profit / f.n * 100) : '–', 'average profit (game $)')}${tile(f.n ? Math.round(f.sat / f.n) + '%' : '–', 'average happiness')}</div>${barTable(f.grades)}</div>`);
  parts.push('</div>');

  // Round 75: progress, roles, streams, syncing - and the patch bay's DJ sets
  parts.push(`<h2>Progress &amp; live</h2>${progressTable(c.acts7)}`);

  // Money
  parts.push('<h2>Money</h2>');
  if (!c.money.open) parts.push('<p class="small muted">The Moon Shards store is shut, so there are no sales yet (see README.txt, "Moon Shards").</p>');
  parts.push('<div class="grid">');
  parts.push(tile(money(c.revenue), 'all sales (before store fees)'));
  parts.push(tile(money(c.revenue30), 'last 30 days'));
  parts.push(tile(fmt(c.payers), 'accounts that paid'));
  parts.push(tile(c.mau ? money(c.revenue30 / c.mau) : '–', 'per monthly player (ARPU)'));
  parts.push(tile(c.payers ? money(c.playerRevenue / c.payers) : '–', 'per paying player (ARPPU)'));
  parts.push(tile(c.money.accounts.length ? pct(c.payers / c.money.accounts.length) : '–', 'of accounts have paid'));
  parts.push('</div>');
  if (Object.keys(c.byVia).length) parts.push(barTable(c.byVia, 8, money));

  // Crashes
  const errors = Object.values(state.errors).sort((a, b) => b.l - a.l).slice(0, 25);
  const crashed = Object.values(state.installs).filter(p => p.er).length;
  parts.push(`<h2>Crashes and errors</h2><p class="small muted">${fmt(crashed)} of ${fmt(c.total)} players (${c.total ? pct(crashed / c.total) : '–'}) have had at least one. Newest first.</p>`);
  parts.push(errors.length ? `<table class="list"><tr><th>What</th><th>Times</th><th>Players</th><th>Last</th></tr>${errors.map(e =>
    `<tr><td>${h(e.msg)}<pre>${h(e.stack.split('\n').slice(0, 4).join('\n'))}</pre><span class="small muted">versions: ${h(Object.keys(e.v).join(', '))}</span></td><td>${fmt(e.c)}</td><td>${fmt(e.who)}</td><td>${when(e.l)}</td></tr>`).join('')}</table>` : '<p class="muted small">None reported. </p>');

  // Players list
  const online = new Set([...live.values()].filter(s => Date.now() - s.at <= ONLINE_MS).map(s => s.iid));
  const accountsById = new Map(c.money.accounts.map(a => [a.id, a]));
  const query = String(q || '').toLowerCase().trim();
  let players = Object.entries(state.installs);
  if (query) players = players.filter(([iid, p]) => [iid, p.n, p.a, p.p, p.v, p.d, (accountsById.get(p.a) || {}).name].some(v => String(v || '').toLowerCase().includes(query)));
  players.sort((a, b) => b[1].l - a[1].l);
  const shown = players.slice(0, 300);
  parts.push(`<h2>Players (${fmt(players.length)}${query ? ' found' : ''})</h2>
<form method="post" action="/admin/stats" class="row">${hidden(key)}<input type="text" name="q" value="${h(q || '')}" placeholder="Search name, account, platform, device..." style="flex:1;min-width:200px"><button type="submit">Search</button></form>
<table class="list"><tr><th>Player</th><th>Platform</th><th>First played</th><th>Last played</th><th>Sessions</th><th>Play time</th><th>Festivals</th><th>Pass</th></tr>${shown.map(([iid, p]) => {
    const acct = p.a ? accountsById.get(p.a) : null;
    const name = p.n || (acct && acct.name) || 'Player ' + iid.slice(0, 6);
    return `<tr><td>${online.has(iid) ? '<span class="dot" title="playing now"></span>' : ''}<b>${h(name)}</b>${p.a ? `<br><span class="small muted">account ${h(p.a)}${acct ? ' · ' + h(acct.name) : ''}</span>` : ''}${p.t ? `<br><span class="small muted">${h(p.t)}</span>` : ''}</td>
<td>${h(p.p || '?')}<br><span class="small muted">${h(p.v || '')}${p.d ? ' · ' + h(p.d) : ''}</span></td><td>${new Date(p.f).toISOString().slice(0, 10)}</td><td>${when(p.l)}</td><td>${fmt(p.s)}</td><td>${hours(p.m)}</td><td>${fmt(p.ff)} / ${fmt(p.fs)}</td><td>${p.lv ? 'L' + fmt(p.lv) : '–'}${p.buys ? '<br><span class="on small">paid</span>' : ''}</td></tr>`;
  }).join('')}</table>${players.length > shown.length ? `<p class="small muted">Showing the ${shown.length} most recent - search, or download the CSV for everyone.</p>` : ''}`);

  // Accounts
  const accounts = c.money.accounts.slice().sort((a, b) => String(b.created).localeCompare(String(a.created)));
  if (accounts.length) {
    const lastByAccount = new Map();
    for (const p of Object.values(state.installs)) if (p.a && (!lastByAccount.has(p.a) || lastByAccount.get(p.a) < p.l)) lastByAccount.set(p.a, p.l);
    parts.push(`<h2>Accounts (${fmt(accounts.length)})</h2><table class="list"><tr><th>Name</th><th>Email</th><th>Made</th><th>Last played</th><th>Shards</th><th>Passes</th></tr>${accounts.slice(0, 500).map(a =>
      `<tr><td><b>${h(a.name)}</b>${a.banned ? ' <span class="off small">suspended</span>' : ''}<br><span class="small muted">${h(a.id)}</span></td><td>${h(a.email || '–')}</td><td>${h(String(a.created || '').slice(0, 10))}</td><td>${when(lastByAccount.get(a.id))}</td><td>${fmt(a.shards)}</td><td>${fmt(a.passes)}</td></tr>`).join('')}</table>`);
  }

  parts.push(`<p class="small muted">Counting since ${new Date(state.since).toISOString().slice(0, 10)}. Players who turned "Share play stats" off in Settings aren't counted. A "player" is one copy of the game on one device.</p>`);
  return parts.join('\n');
}

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // a spreadsheet never runs a player's name as a formula
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function sendCsv(res, name, rows) {
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
  res.end(rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n');
}

function playersCsv(res) {
  const rows = [['install', 'name', 'account', 'platform', 'store', 'version', 'device', 'os', 'language', 'first_played', 'last_played', 'days_played',
    'sessions', 'minutes', 'minutes_on_foot', 'festivals_started', 'festivals_finished', 'tier', 'pass_level', 'purchases', 'errors']];
  for (const [iid, p] of Object.entries(state.installs)) {
    rows.push([iid, p.n || '', p.a || '', p.p || '', p.st || '', p.v || '', p.d || '', p.o || '', p.g || '', new Date(p.f).toISOString(), new Date(p.l).toISOString(),
      p.ad.length, p.s, Math.round(p.m), Math.round(p.ft || 0), p.fs, p.ff, p.t || '', p.lv || '', p.buys || 0, p.er || 0]);
  }
  sendCsv(res, 'new-moon-players.csv', rows);
}

function dailyCsv(res) {
  const activeByDay = new Map();
  for (const p of Object.values(state.installs)) for (const d of p.ad) activeByDay.set(d, (activeByDay.get(d) || 0) + 1);
  const rows = [['date', 'players', 'new_players', 'sessions', 'minutes_played', 'most_at_once']];
  for (const key of Object.keys(state.days).sort()) {
    const d = state.days[key];
    rows.push([key, activeByDay.get(dayIndex(Date.parse(key + 'T00:00:00Z'))) || 0, d.n, d.s, Math.round(d.m), d.pk]);
  }
  sendCsv(res, 'new-moon-daily.csv', rows);
}

function admin(req, res) {
  const P = pay();
  const ip = ipOf(req);
  if (req.method !== 'POST') {
    P.page(res, 200, 'Play stats', `<h1>Play stats</h1><form method="post" action="/admin/stats"><p>Admin password:</p>
<input type="password" name="key" autocomplete="current-password"> <button type="submit">Open</button></form>`);
    return;
  }
  const failKey = 'adminkey|' + ip;
  if (countFails(failKey) >= 10) { P.page(res, 429, 'Wait', '<h1>Too many wrong passwords</h1><p>Wait ten minutes and try again.</p>'); return; }
  noteFail(failKey);   // counted before the form is read (many tries at once can't slip past), forgiven if it's right
  P.readForm(req, 8 * 1024).then(form => {
    const key = form.get('key');
    if (P.adminOk(key)) forgiveFail(failKey);
    else {
      P.page(res, 403, 'Play stats', '<h1>Play stats</h1><p>Wrong password (or ADMIN_KEY isn\'t set on the server).</p><a class="btn" href="/admin/stats">Try again</a>');
      return;
    }
    const action = form.get('action') || '';
    if (action === 'csv') { playersCsv(res); return; }
    if (action === 'daily') { dailyCsv(res); return; }
    P.page(res, 200, 'Play stats', dashboard(key, form.get('q')));
  }).catch(err => {
    console.error('analytics admin', err && err.message);
    if (!res.headersSent) P.page(res, 500, 'Try again', '<h1>Something went wrong</h1><p>Try again in a moment.</p>');
  });
}

/** For the main /admin page: one line and the way in. */
function adminSection(hiddenKey) {
  const o = onlineNow();
  const today = state.days[dayKey(Date.now())] || { n: 0 };
  let dau = 0;
  const t = dayIndex(Date.now());
  for (const p of Object.values(state.installs)) if (p.ad.length && p.ad[p.ad.length - 1] === t) dau++;
  return `<h2>Play stats</h2><p class="small">${fmt(o.n)} playing now · ${fmt(dau)} today · ${fmt(today.n)} new today · ${fmt(Object.keys(state.installs).length)} players ever</p>
<form method="post" action="/admin/stats">${hiddenKey}<button type="submit">Open play stats</button></form>`;
}

module.exports = { handle, attach, flush, adminSection, noteActivity, _test: { state: () => state, compute, dashboard, onStart, onBeat, onEvents, live } };
