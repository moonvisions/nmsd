'use strict';
// Round 115 (launchB): LIVE-OPS CONTROLS AND SERVER HEALTH - one page for the owner: /admin/liveops (the same admin sign-in
// and CSRF check as every admin page - adminauth.guard).
//
// WHAT THE OWNER CAN CHANGE (no redeploy, takes effect at once)
//  - ANNOUNCEMENT: a short line (160 characters) the game shows on the title screen (the Live door) and as a notice in the
//    Open Festival. "Important" shows it in the warning colour.
//  - MAINTENANCE MODE: nobody new gets into the Open Festival, friends' rooms or live events (they're told the message);
//    everyone already playing carries on until they leave. Players whose connection drops for a moment still get their
//    place back in the Open Festival.
//  - MINIMUM BUILD: games older than this build are told to update before they can play online (Build 112-114 read the
//    server's words; Build 115+ also know it from /config and offer the update straight away). 0 = off.
//  - FEATURE SWITCHES: voice chat, text chat, player-made content (spray paint, booth designs, community creations),
//    the Open Festival, rooms, live events, the device check. Off = the server stops passing it on / refuses it (so it
//    works for every build), and Build 115+ grey it out with a short message.
//  - OPEN FESTIVAL PLAYER CAP: how many can be in the Open Festival at once (2-500; see README "LAUNCH CAPACITY").
// WHERE IT IS KEPT: liveops.json in STORE_DATA_DIR (the permanent disk; .bak = the version before), and - when the GitHub
// backup is set up (BACKUP_GITHUB_REPO + BACKUP_GITHUB_TOKEN, the private nmsd-data repo) - liveops.backup.json there too, a
// few seconds after every change. On start the newer of the two is used. Nothing secret is in it.
//
// PUBLIC ENDPOINTS
//  GET /config[?b=<build>]  what the game obeys: {ok, rev, motd:{text,level}, maintenance:{on,text}, minBuild, updateText,
//                           switches:{voice,chat,ugc,openFestival,rooms,liveEvents,deviceCheck}, publicCap, update:{required}}
//                           (120 a minute per address; the game asks at launch and every 10 minutes).
//  GET /healthz             "ok" then one line of JSON: status (ok / busy / overloaded), players, rooms, memory, event-loop
//                           lag, CPU, uptime, errors. ALWAYS 200 while the server answers (the game's connection check and
//                           Render's health check read the "ok"). GET /healthz?alert=1 answers 503 when the server is
//                           overloaded or keeps hitting errors - point an uptime monitor (UptimeRobot) there.
//
// HEALTH: event-loop lag (perf_hooks, 5 s windows), memory against the instance's limit (MEMORY_LIMIT_MB, else the container's
// own limit, else 512 on Render), CPU. "busy" from 75% memory or 250 ms lag; "overloaded" from 88% memory or 1 s lag - then
// NEW players are told "the festival is very busy, try again in a few minutes" (nobody already in is touched).
// CRASHES: an uncaught exception is logged with its stack and counted (the admin page shows it); the server keeps going. More
// than 10 in a minute and it saves everything and exits, so Render starts a fresh copy (Render restarts a stopped service by
// itself; rooms reconnect, accounts / worlds / store / stats are on the disk).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const pay = () => require('./payments');
const auth = () => require('./adminauth');
const ui = () => require('./adminui');

const DIR = process.env.STORE_DATA_DIR || __dirname;
const FILE = path.join(DIR, 'liveops.json');
const BAK = FILE + '.bak';
const CAP_MIN = 2, CAP_MAX = 500;
const DEFAULT_CAP = Math.max(CAP_MIN, Math.min(CAP_MAX, Number(process.env.PUBLIC_CAPACITY) || 100));
const MOTD_MAX = 160, TEXT_MAX = 160;
const MAX_BUILD = 99999;

const SWITCHES = [
  ['voice', 'Voice chat', 'Talking to players nearby, and the open mic. Off: the server passes no voice on.'],
  ['chat', 'Text chat', 'Quick-chat lines between players. Off: the server passes no chat on.'],
  ['ugc', 'Player-made content', 'Spray paint, booth designs, showcases and community creations sent in. Off: none passed on or taken in.'],
  ['openFestival', 'The Open Festival', 'Joining the Open Festival. Off: nobody new gets in (players inside carry on).'],
  ['rooms', 'Friends\' rooms', 'Hosting and joining rooms with a code, and saved worlds. Off: no new rooms or joins.'],
  ['liveEvents', 'Live events', 'Opening and joining ticketed live events. Off: no new ones.'],
  ['deviceCheck', 'Device check', 'Players sending Settings > Device check reports. Off: reports are refused.'],
];
const SWITCH_IDS = SWITCHES.map(s => s[0]);

const MAINT_TEXT = 'The online festival is having a quick tune-up - back soon. Your career and offline play work as normal.';
const UPDATE_TEXT = 'Update New Moon to play online - this version is too old. The title screen offers the update.';
const OFF_TEXT = {
  openFestival: 'The Open Festival is closed for a little while - try again soon. Friends\' rooms and your career work as normal.',
  rooms: 'Friends\' rooms are switched off for a little while - try again soon.',
  liveEvents: 'Live events are switched off for a little while - try again soon.',
  deviceCheck: 'Device checks are switched off on the server right now - try again later.',
  ugc: 'Player-made content is switched off on the server right now.',
};
const BUSY_TEXT = 'The festival is very busy right now - try again in a few minutes.';

function fresh() {
  const switches = {};
  for (const id of SWITCH_IDS) switches[id] = true;
  return { v: 1, rev: 0, updatedAt: '', motd: { text: '', level: 'info' }, maintenance: { on: false, text: '' }, minBuild: 0, updateText: '',
    switches, publicCap: null, log: [] };
}

let state = fresh();
let saveNote = '';

// ------------------------------------------------------------------ text the game may show (its glyph rule)

// The general punctuation every game font draws (the client's tools/glyphcheck.py: what the shipped Nunito has).
const PUNCTUATION = new Set([0x2010, 0x2012, 0x2013, 0x2014, 0x2015, 0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E, 0x2020, 0x2021, 0x2022, 0x2026, 0x2039, 0x203A, 0x2122]);
/** Display text the game can draw: ASCII, Latin-1 and the general punctuation above only (the client's glyph check), one line, trimmed. */
function cleanText(value, max) {
  let s = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ');
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || PUNCTUATION.has(c)) out += ch;
  }
  out = out.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return out.length > max ? out.slice(0, max).trim() : out;
}

function sane(data) {
  const s = fresh();
  if (!data || typeof data !== 'object') return s;
  s.rev = Number.isInteger(data.rev) && data.rev >= 0 ? data.rev : 0;
  s.updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt.slice(0, 40) : '';
  if (data.motd && typeof data.motd === 'object') s.motd = { text: cleanText(data.motd.text, MOTD_MAX), level: data.motd.level === 'warn' ? 'warn' : 'info' };
  if (data.maintenance && typeof data.maintenance === 'object') s.maintenance = { on: data.maintenance.on === true, text: cleanText(data.maintenance.text, TEXT_MAX) };
  const mb = Number(data.minBuild);
  s.minBuild = Number.isInteger(mb) && mb >= 0 && mb <= MAX_BUILD ? mb : 0;
  s.updateText = cleanText(data.updateText, TEXT_MAX);
  if (data.switches && typeof data.switches === 'object') for (const id of SWITCH_IDS) s.switches[id] = data.switches[id] !== false;
  const cap = Number(data.publicCap);
  s.publicCap = Number.isInteger(cap) && cap >= CAP_MIN && cap <= CAP_MAX ? cap : null;
  s.log = Array.isArray(data.log) ? data.log.filter(e => e && typeof e.at === 'string' && typeof e.what === 'string').slice(-30).map(e => ({ at: e.at.slice(0, 40), what: cleanText(e.what, 300) })) : [];
  return s;
}

// ------------------------------------------------------------------ storage: the disk, then the GitHub backup

function readFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err && err.code !== 'ENOENT') console.error('liveops read', file, err.message); return null; }
}

function writeDisk() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BAK);
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
    saveNote = '';
  } catch (err) {
    saveNote = 'Could not save to the disk: ' + (err && err.message);
    console.error('liveops save', err && err.message);
  }
}

const VAULT_REPO = (process.env.BACKUP_GITHUB_REPO || '').trim();
const VAULT_TOKEN = (process.env.BACKUP_GITHUB_TOKEN || '').trim();
const VAULT_PATH = 'liveops.backup.json';
const vault = { on: !!(VAULT_REPO && VAULT_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(VAULT_REPO)), sha: null, pushedAt: '', error: '', timer: null, busy: false };

async function github(method, body) {
  const res = await fetch(`https://api.github.com/repos/${VAULT_REPO}/contents/${VAULT_PATH}`, {
    method,
    headers: { authorization: `Bearer ${VAULT_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'nmsd-server', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* */ }
  return { status: res.status, json };
}

async function vaultLoad() {
  if (!vault.on) return;
  try {
    const r = await github('GET');
    if (r.status === 404) { vault.error = ''; return; }
    if (r.status !== 200 || !r.json || typeof r.json.content !== 'string') { vault.error = `GitHub answered ${r.status}`; return; }
    vault.sha = r.json.sha;
    const remote = sane(JSON.parse(Buffer.from(r.json.content, 'base64').toString('utf8')));
    const newer = (Date.parse(remote.updatedAt || '') || 0) > (Date.parse(state.updatedAt || '') || 0);
    if (newer) {
      state = remote;
      writeDisk();
      console.log('liveops: settings loaded from the GitHub backup');
      if (hooks.onChange) { try { hooks.onChange(state); } catch (e) { console.error('liveops change', e && e.message); } }
    }
    vault.error = '';
  } catch (err) {
    vault.error = 'Could not read the GitHub backup: ' + (err && err.message);
    console.error('liveops vault', vault.error);
  }
}

function vaultSoon() {
  if (!vault.on) return;
  if (vault.timer) clearTimeout(vault.timer);
  vault.timer = setTimeout(() => { vault.timer = null; vaultPush(); }, 3000);
  if (vault.timer.unref) vault.timer.unref();
}

async function vaultPush() {
  if (!vault.on || vault.busy) { if (vault.busy) vaultSoon(); return; }
  vault.busy = true;
  try {
    const content = Buffer.from(JSON.stringify(state, null, 1), 'utf8').toString('base64');
    let r = await github('PUT', { message: `live-ops settings (rev ${state.rev})`, content, sha: vault.sha || undefined });
    if (r.status === 409 || r.status === 422) {
      const g = await github('GET');
      if (g.status === 200 && g.json) vault.sha = g.json.sha;
      r = await github('PUT', { message: `live-ops settings (rev ${state.rev})`, content, sha: vault.sha || undefined });
    }
    if (r.status === 200 || r.status === 201) { vault.sha = r.json && r.json.content ? r.json.content.sha : vault.sha; vault.pushedAt = new Date().toISOString(); vault.error = ''; }
    else { vault.error = `Backup push failed: GitHub answered ${r.status}`; console.error('liveops vault', vault.error); }
  } catch (err) {
    vault.error = 'Backup push failed: ' + (err && err.message);
    console.error('liveops vault', vault.error);
  } finally {
    vault.busy = false;
  }
}

function load() {
  const disk = readFile(FILE) || readFile(BAK);
  state = sane(disk);
  vaultLoad();
}

function change(mutate, what) {
  const before = JSON.stringify(Object.assign({}, state, { log: [], rev: 0, updatedAt: '' }));
  mutate(state);
  state = sane(state);
  const after = JSON.stringify(Object.assign({}, state, { log: [], rev: 0, updatedAt: '' }));
  if (before === after) return false;
  state.rev++;
  state.updatedAt = new Date().toISOString();
  state.log.push({ at: state.updatedAt, what: cleanText(typeof what === 'function' ? what() : what, 300) || 'Settings changed' });
  if (state.log.length > 30) state.log = state.log.slice(-30);
  writeDisk();
  vaultSoon();
  if (hooks.onChange) { try { hooks.onChange(state); } catch (e) { console.error('liveops change', e && e.message); } }
  return true;
}

// ------------------------------------------------------------------ what the relay asks

const hooks = { stats: null, onChange: null, shutdown: null };
/** relay.js: stats() -> the live numbers; onChange(state) -> the settings changed; shutdown(code) -> save everything and exit. */
function attach(h) { Object.assign(hooks, h || {}); }

function on(id) { return state.switches[id] !== false; }
function maintenance() { return state.maintenance.on === true; }
function publicCap() { return state.publicCap || DEFAULT_CAP; }
function minBuild() { return state.minBuild; }
function tooOld(build) { return state.minBuild > 0 && !(Number(build) >= state.minBuild); }   // (no build sent = a game before 110: too old)

const refusals = new Map();   // reason -> times (the last hour), for the admin page
function noteRefusal(reason) {
  const now = Date.now();
  const list = (refusals.get(reason) || []).filter(t => now - t < 3600000);
  if (list.length < 5000) list.push(now);
  refusals.set(reason, list);
}

/**
 * May a NEW connection of this kind come in? '' = yes, else the words to send back (short: they're also a close reason).
 * kind: 'public' | 'host' | 'join' | 'eventHost' | 'eventJoin' | 'world'. build: ?b= (0 = not said). resuming: an Open Festival
 * player getting their kept place back (maintenance and the busy brake let them in).
 */
function admit(kind, build, resuming) {
  if (tooOld(build)) { noteRefusal('update'); return state.updateText || UPDATE_TEXT; }
  if (resuming) return '';
  if (maintenance()) { noteRefusal('maintenance'); return state.maintenance.text || MAINT_TEXT; }
  if (kind === 'public' && !on('openFestival')) { noteRefusal('switch'); return OFF_TEXT.openFestival; }
  if ((kind === 'host' || kind === 'join' || kind === 'world') && !on('rooms')) { noteRefusal('switch'); return OFF_TEXT.rooms; }
  if ((kind === 'eventHost' || kind === 'eventJoin') && !on('liveEvents')) { noteRefusal('switch'); return OFF_TEXT.liveEvents; }
  if (health.status().level === 'overloaded') { noteRefusal('busy'); return BUSY_TEXT; }
  return '';
}

/** What /config answers (the game reads it at launch and every 10 minutes). */
function configFor(build) {
  const out = {
    ok: true, v: 1, rev: state.rev,
    motd: { text: state.motd.text, level: state.motd.level },
    maintenance: { on: maintenance(), text: maintenance() ? (state.maintenance.text || MAINT_TEXT) : '' },
    minBuild: state.minBuild, updateText: state.updateText || UPDATE_TEXT,
    switches: Object.assign({}, state.switches),
    publicCap: publicCap(),
  };
  if (build > 0) out.update = { required: tooOld(build) };
  return out;
}

// ------------------------------------------------------------------ health: event loop, memory, CPU, errors

function memoryLimitMB() {
  const set = Number(process.env.MEMORY_LIMIT_MB);
  if (set >= 64) return set;
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const t = fs.readFileSync(f, 'utf8').trim();
      const n = Number(t);
      if (Number.isFinite(n) && n > 0 && n < os.totalmem()) return Math.round(n / 1048576);
    } catch { /* not there */ }
  }
  return process.env.RENDER ? 512 : Math.round(os.totalmem() / 1048576);
}
const MEM_LIMIT = memoryLimitMB();

const health = (() => {
  const RES = 20;
  const loop = monitorEventLoopDelay({ resolution: RES });
  loop.enable();
  const windows = [];   // {t, p99, max, cpu}
  let lastCpu = process.cpuUsage(), lastAt = Date.now();
  const errors = [];    // times of uncaught errors (last hour)
  let errorsTotal = 0, lastError = '';
  const startedAt = Date.now();
  const tick = () => {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const used = (cpu.user - lastCpu.user) + (cpu.system - lastCpu.system);
    const cpuPct = Math.round(used / Math.max(1, (now - lastAt) * 1000) * 1000) / 10;
    lastCpu = cpu; lastAt = now;
    const ms = v => Math.max(0, Math.round((v / 1e6 - RES) * 10) / 10);
    windows.push({ t: now, p99: ms(loop.percentile(99)), max: ms(loop.max), cpu: cpuPct });
    loop.reset();
    while (windows.length > 24) windows.shift();
  };
  setInterval(tick, 5000).unref();
  let cached = null, cachedAt = 0;
  function status() {
    const now = Date.now();
    if (cached && now - cachedAt < 1000) return cached;
    const m = process.memoryUsage();
    const rssMB = Math.round(m.rss / 1048576);
    const recent = windows.slice(-2);
    const lagP99 = recent.length ? Math.max(...recent.map(w => w.p99)) : 0;
    const lagMax = windows.length ? Math.max(...windows.map(w => w.max)) : 0;
    const cpuPct = recent.length ? Math.round(recent.reduce((s, w) => s + w.cpu, 0) / recent.length * 10) / 10 : 0;
    const memPct = rssMB / MEM_LIMIT;
    while (errors.length && now - errors[0] > 3600000) errors.shift();
    const errors5 = errors.filter(t => now - t < 300000).length;
    const level = memPct >= 0.88 || lagP99 >= 1000 ? 'overloaded' : memPct >= 0.75 || lagP99 >= 250 ? 'busy' : 'ok';
    cached = { level, rssMB, heapMB: Math.round(m.heapUsed / 1048576), memLimitMB: MEM_LIMIT, memPct: Math.round(memPct * 100), lagP99Ms: lagP99, lagMaxMs: lagMax,
      cpuPct, uptimeS: Math.round((now - startedAt) / 1000), errorsHour: errors.length, errors5, errorsTotal, lastError };
    cachedAt = now;
    return cached;
  }
  function noteError(err, where) {
    const now = Date.now();
    errors.push(now);
    errorsTotal++;
    lastError = `${new Date(now).toISOString().slice(0, 19)}Z ${where}: ${String(err && err.message || err).slice(0, 160)}`;
    cached = null;
    return errors.filter(t => now - t < 60000).length;
  }
  return { status, noteError, windows };
})();

/** relay.js calls this once: uncaught errors are logged and counted, never a silent crash; a storm restarts cleanly. */
function guardProcess() {
  let leaving = false;
  const onError = (where) => (err) => {
    console.error(`[${where}]`, err && err.stack ? err.stack : err);
    const inMinute = health.noteError(err, where);
    if (inMinute > 10 && !leaving) {
      leaving = true;
      console.error('liveops: more than 10 uncaught errors in a minute - saving everything and restarting (Render starts a fresh copy)');
      try { if (hooks.shutdown) hooks.shutdown(1); else process.exit(1); } catch { process.exit(1); }
      setTimeout(() => process.exit(1), 10000).unref();
    }
  };
  process.on('uncaughtException', onError('uncaught'));
  process.on('unhandledRejection', onError('unhandled rejection'));
}

// ------------------------------------------------------------------ HTTP

const hits = new Map();
function allowed(ip, max) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= max) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 20000) { for (const [k, l] of hits) if (!l.length || now - l[l.length - 1] > 60000) hits.delete(k); if (hits.size > 20000) hits.clear(); }
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, l] of hits) if (!l.some(t => now - t < 60000)) hits.delete(k); }, 60000).unref();

function ipOf(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
}

function stats() {
  try { return (hooks.stats && hooks.stats()) || {}; } catch (e) { console.error('liveops stats', e && e.message); return {}; }
}

/** The /healthz line (built at most once a second). */
let hzText = '', hzAt = 0, hzLevel = 'ok';
function healthzBody() {
  const now = Date.now();
  if (hzText && now - hzAt < 1000) return { text: hzText, level: hzLevel };
  const h = health.status();
  const s = stats();
  const body = { status: h.level, players: (s.publicPlayers || 0) + (s.roomPlayers || 0), publicPlayers: s.publicPlayers || 0, publicCap: publicCap(),
    rooms: s.rooms || 0, roomPlayers: s.roomPlayers || 0, sockets: s.sockets || 0, rssMB: h.rssMB, memLimitMB: h.memLimitMB, heapMB: h.heapMB,
    lagP99Ms: h.lagP99Ms, lagMaxMs: h.lagMaxMs, cpuPct: h.cpuPct, uptimeS: h.uptimeS, errors5m: h.errors5, maintenance: maintenance() };
  hzText = JSON.stringify(body);
  hzLevel = h.level === 'overloaded' || h.errors5 >= 20 ? 'bad' : 'ok';
  hzAt = now;
  return { text: hzText, level: hzLevel };
}

function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://relay'); } catch { return false; }
  const route = url.pathname;
  if (route === '/healthz') {
    const b = healthzBody();
    const alert = url.searchParams.get('alert') === '1';
    const bad = alert && b.level === 'bad';
    res.writeHead(bad ? 503 : 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end((bad ? 'overloaded' : 'ok') + '\n' + b.text + '\n');   // (the game and Render read the "ok" at the start)
    return true;
  }
  if (route === '/config') {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' };
    if (!allowed('cfg|' + ipOf(req), 120)) { res.writeHead(429, headers); res.end('{"ok":false,"message":"Slow down a little."}'); return true; }
    const raw = String(url.searchParams.get('b') || '');
    const build = /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
    res.writeHead(200, headers);
    res.end(JSON.stringify(configFor(build)));
    return true;
  }
  if (route === '/admin/liveops/health') {
    auth().guard(req, res, { path: '/admin/liveops' }).then(g => {
      if (!g) return;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(liveNumbers()));
    }).catch(e => { console.error('liveops health', e && e.message); if (!res.headersSent) { res.writeHead(500); res.end(); } });
    return true;
  }
  if (route !== '/admin/liveops') return false;
  auth().guard(req, res, { path: '/admin/liveops', limit: 8192 }).then(g => {
    if (!g) return;
    if (g.get) { adminPage(res, g.token, url.searchParams.get('saved') === '1' ? 'Saved.' : ''); return; }
    const note = adminAction(g.form);
    res.writeHead(303, { location: '/admin/liveops' + (note === 'saved' ? '?saved=1' : ''), 'cache-control': 'no-store' });
    res.end();
  }).catch(e => { console.error('liveops admin', e && e.message); if (!res.headersSent) { res.writeHead(500); res.end(); } });
  return true;
}

function adminAction(form) {
  const action = String(form.get('action') || '');
  if (action === 'maint-on') return change(s => { s.maintenance.on = true; }, 'Maintenance mode ON') ? 'saved' : '';
  if (action === 'maint-off') return change(s => { s.maintenance.on = false; }, 'Maintenance mode OFF') ? 'saved' : '';
  if (action === 'motd-clear') return change(s => { s.motd.text = ''; }, 'Announcement cleared') ? 'saved' : '';
  if (action !== 'save') return '';
  const words = [];
  const done = change(s => {
    const motd = cleanText(form.get('motd'), MOTD_MAX), level = form.get('motdLevel') === 'warn' ? 'warn' : 'info';
    if (motd !== s.motd.text || level !== s.motd.level) words.push(motd ? `Announcement: "${motd}"${level === 'warn' ? ' (important)' : ''}` : 'Announcement cleared');
    s.motd = { text: motd, level };
    const mOn = form.get('maint') === 'on', mText = cleanText(form.get('maintText'), TEXT_MAX);
    if (mOn !== s.maintenance.on) words.push('Maintenance mode ' + (mOn ? 'ON' : 'OFF'));
    s.maintenance = { on: mOn, text: mText };
    const mb = Number(form.get('minBuild'));
    const minB = Number.isInteger(mb) && mb >= 0 && mb <= MAX_BUILD ? mb : s.minBuild;
    if (minB !== s.minBuild) words.push(minB ? `Minimum build ${minB}` : 'Minimum build off');
    s.minBuild = minB;
    s.updateText = cleanText(form.get('updateText'), TEXT_MAX);
    for (const id of SWITCH_IDS) {
      const v = form.get('sw_' + id) === 'on';
      if (v !== s.switches[id]) words.push(`${SWITCHES.find(x => x[0] === id)[1]} ${v ? 'ON' : 'OFF'}`);
      s.switches[id] = v;
    }
    const cap = Number(form.get('publicCap'));
    if (Number.isInteger(cap) && cap >= CAP_MIN && cap <= CAP_MAX && cap !== publicCap()) { words.push(`Open Festival cap ${cap}`); s.publicCap = cap; }
  }, () => words.join('; '));
  return done ? 'saved' : '';
}

/** The live numbers (the admin tile, the page's health card, /admin/liveops/health). */
function liveNumbers() {
  const h = health.status();
  const s = stats();
  const now = Date.now();
  const refused = {};
  for (const [k, list] of refusals) { const n = list.filter(t => now - t < 3600000).length; if (n) refused[k] = n; }
  return Object.assign({ publicCap: publicCap(), maintenance: maintenance(), refusedHour: refused, rev: state.rev }, s, h, { lagWindows: health.windows.slice(-12).map(w => w.p99) });
}

/** For the admin home's tile (adminhub.js). */
function tile() {
  const n = liveNumbers();
  return { players: (n.publicPlayers || 0) + (n.roomPlayers || 0), rooms: n.rooms || 0, rssMB: n.rssMB, memLimitMB: n.memLimitMB, lagP99Ms: n.lagP99Ms, level: n.level, maintenance: n.maintenance, publicPlayers: n.publicPlayers || 0, publicCap: n.publicCap };
}

// ------------------------------------------------------------------ the admin page

const PAGE_CSS = `<style>
.lo h1{font-size:26px;margin:4px 0 4px}.lo .lead{color:var(--text2);margin:0 0 16px}
.lo .card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px;margin:0 0 14px}
.lo .card h2{font-size:17px;margin:0 0 4px}.lo .card p.h{color:var(--muted);font-size:13px;margin:0 0 10px}
.lo .nums{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.lo .num{background:var(--surface2);border-radius:12px;padding:10px 12px}.lo .num b{display:block;font-size:24px;color:var(--gold);font-variant-numeric:tabular-nums}
.lo .num span{color:var(--text2);font-size:12px}
.lo .pill{display:inline-block;border-radius:999px;padding:3px 10px;font-weight:700;font-size:13px}
.lo .ok{background:#0ca30c33;color:var(--good-text)}.lo .busy{background:#fab21933;color:var(--warn)}.lo .overloaded,.lo .bad{background:#d03b3b33;color:var(--bad-text)}
.lo label{display:block;color:var(--text2);font-size:13px;margin:10px 0 4px}
.lo input[type=text],.lo input[type=number],.lo textarea,.lo select{width:100%;box-sizing:border-box;font-size:16px;padding:10px;border-radius:8px;border:1px solid #444;background:#1d212b;color:#fff}
.lo textarea{min-height:64px;resize:vertical;font-family:inherit}
.lo .sw{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--grid)}.lo .sw:first-of-type{border-top:0}
.lo .sw input{width:24px;height:24px;flex:none;margin-top:2px}.lo .sw b{display:block}.lo .sw span{color:var(--muted);font-size:13px}
.lo .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.lo form.inline{display:inline;margin:0}
.lo button.big{font-size:16px;padding:12px 18px;min-height:44px}.lo button.red{background:#ff8a80}.lo button.ghost{background:transparent;color:var(--gold);border:1px solid #e8b14c66}
.lo .note{background:#0ca30c22;border:1px solid #0ca30c;border-radius:10px;padding:10px;margin:0 0 12px}
.lo .warnbox{background:#3a1c1c;border:1px solid #ff8a80;color:#ffd2cc;border-radius:10px;padding:10px;margin:0 0 12px}
.lo .log{font-size:13px;color:var(--text2)}.lo .log li{margin:3px 0}
.lo .maint-on{border-color:#fab219}
</style>`;

function adminPage(res, token, note) {
  const U = ui();
  const esc = U.esc;
  const n = liveNumbers();
  const hidden = auth().hidden(token);
  const s = state;
  const refused = Object.entries(n.refusedHour || {}).map(([k, v]) => `${esc({ update: 'too old', maintenance: 'maintenance', switch: 'switched off', busy: 'server busy', full: 'Open Festival full' }[k] || k)}: ${v}`).join(' · ') || 'none';
  const builds = Object.entries(n.builds || {}).sort((a, b) => Number(b[0]) - Number(a[0])).map(([b, c]) => `${b === '0' ? 'before 110' : 'Build ' + esc(b)}: ${c}`).join(' · ') || 'nobody online';
  const sw = SWITCHES.map(([id, name, words]) => `<label class="sw"><input type="checkbox" name="sw_${id}"${s.switches[id] ? ' checked' : ''}><span><b>${esc(name)}</b><span>${esc(words)}</span></span></label>`).join('');
  const html = [U.CSS, PAGE_CSS, `<div class="lo">
<h1>Live ops</h1><p class="lead">Switches for the live game - they work straight away, no redeploy. Saved on the server's disk${vault.on ? ' and in the GitHub backup' : ''}.</p>
${note ? `<div class="note" role="status">${esc(note)}</div>` : ''}${saveNote ? `<div class="warnbox" role="alert">${esc(saveNote)}</div>` : ''}${vault.error ? `<div class="warnbox" role="alert">GitHub backup: ${esc(vault.error)}</div>` : ''}
${s.maintenance.on ? `<div class="warnbox" role="alert"><b>Maintenance mode is ON.</b> Nobody new can get into the Open Festival, rooms or live events.</div>` : ''}
<section class="card" id="health"><h2>Server right now <span id="lvl" class="pill ${esc(n.level)}">${esc(n.level)}</span></h2><p class="h">Updates every 10 seconds. Memory and lag are what to watch - see README "LAUNCH CAPACITY".</p>
<div class="nums">
<div class="num"><b id="n-pub">${U.fmt(n.publicPlayers || 0)} / ${U.fmt(n.publicCap)}</b><span>in the Open Festival / cap</span></div>
<div class="num"><b id="n-rooms">${U.fmt(n.rooms || 0)}</b><span>rooms open (<span id="n-roomp">${U.fmt(n.roomPlayers || 0)}</span> players)</span></div>
<div class="num"><b id="n-mem">${U.fmt(n.rssMB)} MB</b><span>memory of ${U.fmt(n.memLimitMB)} MB (<span id="n-memp">${U.fmt(n.memPct)}</span>%)</span></div>
<div class="num"><b id="n-lag">${esc(n.lagP99Ms)} ms</b><span>event-loop lag (p99, 10 s)</span></div>
<div class="num"><b id="n-cpu">${esc(n.cpuPct)}%</b><span>CPU (of one core)</span></div>
<div class="num"><b id="n-err">${U.fmt(n.errorsHour)}</b><span>errors in the last hour</span></div>
</div>
<p class="h" style="margin-top:10px">Turned away in the last hour: <span id="n-ref">${refused}</span><br>Games online: ${builds}<br>Up for ${U.fmt(Math.round(n.uptimeS / 60))} min${n.lastError ? `<br>Last error: ${esc(n.lastError)}` : ''}</p>
</section>
<section class="card${s.maintenance.on ? ' maint-on' : ''}"><h2>Maintenance mode: ${s.maintenance.on ? '<span class="pill busy">ON</span>' : '<span class="pill ok">off</span>'}</h2><p class="h">Stops NEW joins with a friendly message. Players already in the Open Festival and rooms carry on until they leave.</p>
<form method="post" action="/admin/liveops" class="inline">${hidden}<input type="hidden" name="action" value="${s.maintenance.on ? 'maint-off' : 'maint-on'}"><button type="submit" class="big${s.maintenance.on ? '' : ' red'}"${s.maintenance.on ? '' : ' onclick="return confirm(\'Turn maintenance mode on? Nobody new will be able to join.\')"'}>${s.maintenance.on ? 'Turn maintenance OFF' : 'Turn maintenance ON'}</button></form>
</section>
<form method="post" action="/admin/liveops">${hidden}<input type="hidden" name="action" value="save">
<section class="card"><h2>Announcement</h2><p class="h">One short line on the title screen and in the Open Festival (160 characters). Empty = none.</p>
<label for="motd">Words</label><textarea id="motd" name="motd" maxlength="${MOTD_MAX}">${esc(s.motd.text)}</textarea>
<label for="motdLevel">Look</label><select id="motdLevel" name="motdLevel"><option value="info"${s.motd.level !== 'warn' ? ' selected' : ''}>Normal</option><option value="warn"${s.motd.level === 'warn' ? ' selected' : ''}>Important (warning colour)</option></select>
</section>
<section class="card"><h2>Maintenance message</h2><p class="h">What players are told while maintenance mode is on. Empty = "${esc(MAINT_TEXT)}"</p>
<label class="sw"><input type="checkbox" name="maint"${s.maintenance.on ? ' checked' : ''}><span><b>Maintenance mode on</b><span>(the same as the big button above)</span></span></label>
<label for="maintText">Message</label><input type="text" id="maintText" name="maintText" maxlength="${TEXT_MAX}" value="${esc(s.maintenance.text)}">
</section>
<section class="card"><h2>Minimum supported build</h2><p class="h">Games older than this are told to update before playing online. 0 = off. Games online right now: ${builds}. Check the Stats page's versions first - don't set it above the newest build you've published.</p>
<label for="minBuild">Minimum build</label><input type="number" id="minBuild" name="minBuild" min="0" max="${MAX_BUILD}" value="${esc(s.minBuild)}">
<label for="updateText">Message (empty = "${esc(UPDATE_TEXT)}")</label><input type="text" id="updateText" name="updateText" maxlength="${TEXT_MAX}" value="${esc(s.updateText)}">
</section>
<section class="card"><h2>Feature switches</h2><p class="h">Untick to switch a feature off for everyone, straight away. The server enforces it for every build.</p>${sw}</section>
<section class="card"><h2>Open Festival player cap</h2><p class="h">How many players fit in the Open Festival at once (${CAP_MIN}-${CAP_MAX}). Over it, players are told "it's full - try again in a few minutes". On the 512 MB Starter plan keep it at ${DEFAULT_CAP} or below (README "LAUNCH CAPACITY").</p>
<label for="publicCap">Cap</label><input type="number" id="publicCap" name="publicCap" min="${CAP_MIN}" max="${CAP_MAX}" value="${esc(publicCap())}">
</section>
<button type="submit" class="big">Save changes</button>
</form>
<section class="card" style="margin-top:14px"><h2>Recent changes</h2><ul class="log">${s.log.slice().reverse().map(e => `<li>${esc(e.at.slice(0, 16).replace('T', ' '))} UTC - ${esc(e.what)}</li>`).join('') || '<li>None yet.</li>'}</ul></section>
</div>
<script>
(function(){var f=function(n){return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',')};
setInterval(function(){fetch('/admin/liveops/health',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(n){if(!n)return;
var s=function(id,t){var e=document.getElementById(id);if(e)e.textContent=t};
s('n-pub',f(n.publicPlayers||0)+' / '+f(n.publicCap));s('n-rooms',f(n.rooms||0));s('n-roomp',f(n.roomPlayers||0));s('n-mem',f(n.rssMB)+' MB');s('n-memp',f(n.memPct));
s('n-lag',n.lagP99Ms+' ms');s('n-cpu',n.cpuPct+'%');s('n-err',f(n.errorsHour));var l=document.getElementById('lvl');if(l){l.textContent=n.level;l.className='pill '+n.level}
}).catch(function(){})},10000)})();
</script>`];
  pay().page(res, 200, 'Live ops - New Moon admin', html.join('\n'));
}

load();

module.exports = { handle, attach, on, maintenance, publicCap, minBuild, tooOld, admit, configFor, guardProcess, noteRefusal, health, tile, liveNumbers, cleanText,
  SWITCH_IDS, DEFAULT_CAP, CAP_MAX, OFF_TEXT, BUSY_TEXT,
  _test: { state: () => state, sane, change, reset: () => { state = fresh(); refusals.clear(); hits.clear(); }, vault } };
