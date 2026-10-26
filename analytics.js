'use strict';
// Round 71: PLAY STATS - who plays, for how long, what they do, and your private dashboard.
//
// WHAT IT IS
//  - The game (unless the player turned "Share play stats" off in Settings) tells this server three things:
//      POST /stats/start   when the game opens   (install id, version, platform, device, language, signed in or not - Round 110: never a name or account id)
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
//
// Round 110: THE NEW DASHBOARD (statsdash.js renders it; this file keeps collecting). New things counted:
//  - /stats/start takes "b" (the game's build number, e.g. 110) - kept per install (p.b), and every day counts its active
//    players per build (days[].v) for the version-adoption chart. Builds before 110 don't send it ("not reported").
//  - feature events from the game (Net/AnalyticsHooks.cs): career_tier, career_complete, land_plot, stage_upgrade,
//    module_fit, green_build, mx_race, pyro_show, emote, swag_unlock, speedway, update_download / update_install /
//    update_fail, signin_ok / signin_fail, build. Each is tallied as "<event>.<detail>" all-time (state.fx) and per day
//    (days[].x); a player's best career rank (p.ct), career complete (p.cc) and the Speedway (p.sw: 1 earned, 2 bought) are
//    kept per install, so those are counted once per player however often the game says so.
//  - health per day (days[].h): the game's requests turned away for speed (rate_limit), wrong admin passwords
//    (admin_fail), admin forms refused by the CSRF check (csrf_reject); errors also by platform (errors[].pl).
//  - every minute, the online rooms' players with / without a live account (days[].rm: player-minutes) - the ones without
//    are games too old for accounts, let in by the grace period (LIVE_ACCOUNT_GRACE_UNTIL).
//  The file's format only GAINS fields (v: 2); an analytics.json from before loads as it is.

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
const MAX_FX = 600;                 // Round 110: different feature tallies kept all-time ("event.detail")
const MAX_FX_DAY = 300;             // ... and per day
const MAX_BUILDS_DAY = 40;          // ... builds per day

const EVENTS = new Set(['festival_start', 'festival_end', 'festival_leave', 'tier', 'walk', 'demo_start', 'demo_end',
  'open_join', 'open_leave', 'mp_host', 'mp_join', 'activity', 'photo', 'purchase', 'error', 'quit', 'signup', 'guide',
  // Round 110: the feature events (Net/AnalyticsHooks.cs) - see the top of this file
  'career_tier', 'career_complete', 'land_plot', 'stage_upgrade', 'module_fit', 'green_build', 'mx_race', 'pyro_show', 'emote',
  'swag_unlock', 'speedway', 'update_download', 'update_install', 'update_fail', 'signin_ok', 'signin_fail', 'build']);
/** Round 110: the career's ranks, in order (CareerRank in Data/CareerExpansion.cs). */
const CAREER_RANKS = ['renegade', 'local', 'regional', 'major', 'mega', 'headlinerempire', 'global', 'legend'];
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
  return { v: 2, since: Date.now(), installs: dict(), days: dict(), errors: dict(), acts: dict(), fx: dict(), fest: { n: 0, att: 0, profit: 0, sat: 0, grades: dict() } };
}

let scrubbed = false;   // Round 110 (sec110 M6): repair() took names / account ids out (load() then rewrites the files)
/** Round 110 (sec110 M6): an account id as a salted tag ("h" + 20 hex) - the same id gives the same tag on this server. */
function acctTag(id) {
  const text = String(id == null ? '' : id).trim().slice(0, 64);
  if (!text) return '';
  return 'h' + crypto.createHmac('sha256', String(state.salt || '')).update('acct|' + text).digest('hex').slice(0, 20);
}
const isAcctTag = v => typeof v === 'string' && /^h[0-9a-f]{20}$/.test(v);
/**
 * Round 110 (sec110 M6): a crash message / stack made safe to keep - anything like an email, a sign-in key or ticket, a
 * password / token value, or a folder that could hold someone's user name is taken out (the game does the same before
 * sending; this is the second line for older games).
 */
function scrubText(text) {
  return String(text == null ? '' : text)
    .replace(/[^\s@<>"'()\[\]]+@[^\s@<>"'()\[\]]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(Bearer\s+)[^\s"&,;]+/gi, '$1<hidden>')
    .replace(/\b(pt|token|key|wkey|password|pass|secret|ticket)(\s*[=:]\s*"?)[^\s"&,;]+/gi, '$1$2<hidden>')
    .replace(/\btk1-[A-Za-z0-9-]+/g, '<ticket>')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, '<token>')
    .replace(/(Users[\\/])[^\\/\s]+/gi, '$1~')
    .replace(/(\/home\/)[^/\s]+/g, '$1~');
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
  state.fx = numbers(state.fx);   // Round 110 (a v1 file has none: it starts empty)
  state.v = 2;
  for (const e of Object.values(state.errors)) { e.v = dict(e.v); e.pl = dict(e.pl); }
  for (const d of Object.values(state.days)) {
    d.e = dict(d.e);
    d.a = dict(d.a);   // Round 75: that day's activity counts by id
    for (const k in d.a) if (typeof d.a[k] !== 'number') delete d.a[k];
    d.x = numbers(d.x);   // Round 110: feature tallies, active players per build, health, room-minutes
    d.v = numbers(d.v);
    d.h = numbers(d.h);
    d.rm = Object.assign({ a: 0, g: 0 }, d.rm && typeof d.rm === 'object' ? d.rm : {});
  }
  // Round 110 (sec110 M6): a random salt for account tags (made once, kept in this file - never an account id itself).
  if (typeof state.salt !== 'string' || !/^[0-9a-f]{32}$/.test(state.salt)) state.salt = crypto.randomBytes(16).toString('hex');
  for (const p of Object.values(state.installs)) {
    p.fl = dict(p.fl); if (p.ers) p.ers = dict(p.ers); if (!Array.isArray(p.ad)) p.ad = [];
    // Round 110 (sec110 M6): no player names and no account ids in the stats - names from older files are dropped, ids
    // become the salted tag (the dashboard only needs "signed in", and to recognise a build-109 account).
    if (p.n !== undefined) { delete p.n; scrubbed = true; }
    if (p.a !== undefined && p.a !== 1 && !isAcctTag(p.a)) { p.a = p.a ? acctTag(p.a) : undefined; if (p.a === undefined) delete p.a; scrubbed = true; }
  }
  installCount = Object.keys(state.installs).length;
}

/** A lookup of numbers only (anything else dropped). */
function numbers(o) {
  const out = dict(o && typeof o === 'object' ? o : {});
  for (const k in out) if (typeof out[k] !== 'number' || !Number.isFinite(out[k])) delete out[k];
  return out;
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
      scrubbed = false;
      repair();
      if (scrubbed) rewriteClean();   // Round 110 (sec110 M6): the old names / ids leave the files (and the backup) now
      if (file !== FILE) loadNote = 'The main stats file was missing or damaged, so the backup was loaded.';
      return;
    } catch (err) {
      console.error('analytics: ' + path.basename(file) + ' is damaged:', err && err.message);
    }
  }
}
load();

/** Round 110 (sec110 M6): writes the cleaned stats over BOTH the file and its backup (the backup kept the names too). */
function rewriteClean() {
  try {
    const text = JSON.stringify(state);
    for (const file of [FILE, FILE + '.bak']) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    }
  } catch (err) {
    console.error('analytics clean', err && err.message);
  }
}

let saveTimer = null;
let rev = 0;   // Round 110: bumped on every change (the dashboard's few-second cache is only reused while nothing changed)
function save() {
  rev++;
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

function ipOf(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
}

const hits = new Map();          // the game's requests, per address / per install (one minute windows)
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
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.some(t => now - t < 120000)) hits.delete(k);
}, 60000).unref();

function day(ms) {
  const key = dayKey(ms);
  let d = state.days[key];
  if (!d) {
    d = state.days[key] = { n: 0, s: 0, m: 0, pk: 0, e: dict(), a: dict(), x: dict(), v: dict(), h: dict(), rm: { a: 0, g: 0 } };
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
    tally(day(now).v, buildLabel(p), MAX_BUILDS_DAY);   // Round 110: active players that day, by build
    if (p.ad.length > MAX_DAYS_PER_INSTALL) p.ad.splice(0, p.ad.length - MAX_DAYS_PER_INSTALL);
    if (p.ad.length >= 2) p.fl.back = 1;
  }
}

/** Round 110: "110" for a game that says its build, "old" for one that doesn't (109 and before). */
function buildLabel(p) { return p.b ? String(p.b) : 'old'; }

/** Round 110: one more in a tally (a new key only while there's room). */
function tally(obj, key, max) {
  if (!key || !obj) return;
  if (obj[key] == null && Object.keys(obj).length >= max) return;
  obj[key] = (obj[key] || 0) + 1;
}

function parseBuild(v) { const n = Math.floor(Number(v)); return n >= 1 && n <= 99999 ? n : 0; }

function onStart(b, now) {
  const p = install(b.iid, now);
  if (!p) return;
  const build = parseBuild(b.b);   // Round 110: before active(), so today's build tally has it
  if (build) p.b = build;
  active(p, now);
  p.s++;
  p.p = word(b.plat, 16) || p.p || '?';
  p.v = str(b.v, 24) || p.v;
  p.o = str(b.os, 60) || p.o;
  p.d = str(b.dev, 60) || p.d;
  p.g = word(b.lang, 24) || p.g;
  p.st = word(b.store, 12) || p.st;
  signedIn(p, b);   // Round 110 (sec110 M6): no name kept, the account only as a flag / salted tag
  if (b.gfx) p.gx = word(b.gfx, 10);
  if (b.touch != null) p.tc = b.touch ? 1 : 0;
  const d = day(now);
  d.s++;
  live.set(b.sid, { iid: b.iid, at: now, view: 'map', p: p.p });
  notePeak();
  save();
}

/**
 * Round 110 (sec110 M6): "signed in" without who. A game from 110 on sends si=1; an older one still sends its store
 * account id (acct), kept only as the salted tag (so the dashboard can still recognise a build-109 account). A player
 * name ("name", from older games) is never kept.
 */
function signedIn(p, b) {
  if (b.acct) { const tag = acctTag(str(b.acct, 24)); if (tag) p.a = tag; }
  else if (b.si === 1 || b.si === '1' || b.si === true) { if (!p.a) p.a = 1; }
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
  signedIn(p, b);   // Round 110 (sec110 M6): no name kept, the account only as a flag / salted tag
  const today = day(now);
  today.m += minutes;
  if (view === 'foot') today.f = (today.f || 0) + minutes;   // Round 110: minutes on foot that day (map = m - f)
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
      case 'signup': p.a = a.acct ? acctTag(str(a.acct, 24)) || 1 : (p.a || 1); break;   // Round 110 (sec110 M6)
      case 'activity': countActivity(word(a.id, 24), d); break;
      case 'error': {
        const msg = str(scrubText(a.msg), 200);   // Round 110 (sec110 M6): scrubbed here too (older games don't)
        if (!msg) break;
        const stack = scrubText(String(a.stack == null ? '' : a.stack).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')).slice(0, 600).trim();
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
        if (!err.pl) err.pl = dict();   // Round 110: + by platform
        tally(err.pl, p.p || '?', 12);
        if (!p.ers) p.ers = dict();
        if (!p.ers[key] && Object.keys(p.ers).length < 64) { p.ers[key] = 1; err.who++; }
        p.er = (p.er || 0) + 1;
        break;
      }
      case 'quit': live.delete(b.sid); break;
      default:
        if (name !== 'other') feature(name, a, p, d);   // Round 110
        break;
    }
  }
  save();
}

/**
 * Round 110: a feature event -> "<event>.<detail>" tallies (all-time and that day) and the per-player facts. Details are
 * reduced to plain words here (a-z 0-9 _ . -), so nothing a game sends can be more than a short label.
 */
function feature(name, a, p, d) {
  const count = key => { tally(state.fx, key, MAX_FX); tally(d.x, key, MAX_FX_DAY); };
  const w = (v, n) => word(v, n || 24);
  count(name);
  switch (name) {
    case 'career_tier': {
      const rank = w(a.tier).replace(/[^a-z]/g, '');
      const i = CAREER_RANKS.indexOf(rank);
      if (i < 0) break;
      count(name + '.' + rank);
      if (!(p.ct >= i)) p.ct = i;
      break;
    }
    case 'career_complete': p.cc = 1; p.ct = CAREER_RANKS.length - 1; break;
    case 'land_plot': if (a.site != null) count(name + '.site' + num(a.site, 0, 99)); break;
    case 'stage_upgrade': if (w(a.to)) count(name + '.' + w(a.to)); break;
    case 'module_fit': if (w(a.mod)) count(name + '.' + w(a.mod)); break;
    case 'green_build': {
      const r = Math.round(num(a.r, 0, 100));
      count(name + '.r' + Math.min(80, Math.floor(r / 20) * 20));   // r0 r20 r40 r60 r80 (80 = 80-100)
      const sumKey = name + '.sum';   // (the sum of ratings, for the average)
      if (state.fx[sumKey] != null || Object.keys(state.fx).length < MAX_FX) state.fx[sumKey] = (state.fx[sumKey] || 0) + r;
      break;
    }
    case 'mx_race': {
      const mode = w(a.mode) === 'live' ? 'live' : 'solo';
      count(name + '.' + mode);
      const place = Math.floor(num(a.place, 0, 99));
      if (place >= 1) count(name + '.' + mode + '.p' + Math.min(place, 4));   // p4 = 4th or later
      break;
    }
    case 'pyro_show': if (w(a.kind)) count(name + '.' + w(a.kind)); break;
    case 'emote': if (w(a.id)) count(name + '.' + w(a.id)); break;
    case 'swag_unlock': {
      const r = w(a.rarity);
      if (['common', 'rare', 'epic', 'legendary'].includes(r)) count(name + '.' + r);
      break;
    }
    case 'speedway': {
      const how = w(a.how) === 'bought' ? 'bought' : 'earned';
      const bit = how === 'bought' ? 2 : 1;
      if (!((p.sw || 0) & bit)) { p.sw = (p.sw || 0) | bit; count(name + '.' + how + '_players'); }
      count(name + '.' + how);
      break;
    }
    case 'update_download': case 'update_install': case 'update_fail':
      count(name + '.' + (p.p || '?'));
      if (name === 'update_fail' && w(a.why)) count(name + '.why.' + w(a.why));
      break;
    case 'signin_ok': case 'signin_fail':
      tally(d.h, name, 40);
      break;
    case 'build': { const n = parseBuild(a.b); if (n) p.b = n; break; }
    default: break;
  }
}

/** Round 110: something for the Health section (rate_limit, admin_fail, csrf_reject) - today's tally. */
function noteHealth(kind) {
  kind = word(kind, 24);
  if (!kind) return;
  tally(day(Date.now()).h, kind, 40);
  save();
}

// Round 110: once a minute, the online rooms' players with and without a live account (player-minutes per day).
setInterval(() => {
  if (!relay || typeof relay.live !== 'function') return;
  const r = safe(relay.live);
  if (!r || !r.accounts || !(r.roomPlayers > 0)) return;
  const d = day(Date.now());
  const old = Math.max(0, Math.min(r.roomPlayers, r.roomOld || 0));
  d.rm.a += r.roomPlayers - old;
  d.rm.g += old;
  save();
}, 60000).unref();

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
  if (!allow('ip|' + ip, 600, 60000)) { noteHealth('rate_limit'); answer(res, 429, { ok: false }); return; }   // (a venue's Wi-Fi shares one address)
  readBody(req, 32 * 1024).then(text => {
    if (text == null) { answer(res, 413, { ok: false }); setImmediate(() => req.destroy()); return; }
    let b;
    try { b = JSON.parse(text); } catch { answer(res, 400, { ok: false }); return; }
    if (!b || typeof b !== 'object' || typeof b.iid !== 'string' || typeof b.sid !== 'string' || !ID.test(b.iid) || !ID.test(b.sid)) { answer(res, 400, { ok: false }); return; }
    if (!allow('iid|' + b.iid, 40, 60000)) { noteHealth('rate_limit'); answer(res, 429, { ok: false }); return; }
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

/** Handles /stats/* and /admin/stats (Round 110: + /admin/stats/export). Returns true if it answered. */
function handle(req, res) {
  let route;
  try { route = new URL(req.url, 'http://relay').pathname; } catch { return false; }
  if (route === '/stats/start' || route === '/stats/beat' || route === '/stats/events') { gameCall(req, res, route); return true; }
  if (route === '/admin/stats' || route === '/admin/stats/export') { require('./statsdash').handle(req, res, route); return true; }
  return false;
}

function safe(fn) { try { return fn(); } catch { return null; } }

/** Round 110: what the dashboard reads (statsdash.js) - read-only views of the state above. */
function view() {
  return { state, live, rev, ONLINE_MS, PERSISTENT, loadNote, relay: relay && typeof relay.live === 'function' ? safe(relay.live) : null, online: onlineNow(), CAREER_RANKS, FUNNEL };
}

/** For the admin home (adminhub.js): the headline numbers. */
function headline() {
  const o = onlineNow();
  const t = dayIndex(Date.now());
  let dau = 0;
  for (const p of Object.values(state.installs)) if (p.ad.length && p.ad[p.ad.length - 1] === t) dau++;
  const today = state.days[dayKey(Date.now())] || { n: 0 };
  return { online: o.n, dau, fresh: today.n || 0, total: installCount };
}

/** For the old main admin page sections (kept for anything that still calls it): one line and the way in. */
function adminSection() {
  const x = headline();
  return `<h2>Play stats</h2><p class="small">${x.online} playing now · ${x.dau} today · ${x.fresh} new today · ${x.total} players ever</p>
<p><a class="btn" href="/admin/stats">Open play stats</a></p>`;
}

module.exports = { handle, attach, flush, adminSection, noteActivity, noteHealth, view, headline, acctTag,
  _test: { state: () => state, scrubText, onStart, onBeat, onEvents, live, reset: () => { state = blank(); repair(); live.clear(); }, load: data => { state = Object.assign(blank(), data); repair(); }, dayKey, dayIndex } };
