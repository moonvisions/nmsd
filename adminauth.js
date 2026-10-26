'use strict';
// Round 110: ONE ADMIN SIGN-IN for every /admin page.
//
// HOW IT WORKS
//  - /admin shows a sign-in form. You type ADMIN_KEY once; it's checked (constant time) and the server gives your browser
//    a SESSION COOKIE: a random 256-bit id (the server keeps only its SHA-256), HttpOnly (page scripts can't read it),
//    Secure (https only), SameSite=Strict (another site can't make your browser use it), Path=/admin. It lasts 12 hours,
//    or until you press "Sign out" (or "Sign out everywhere", which ends every session - e.g. after losing a phone).
//    Sessions live in the server's memory only, so a redeploy / restart signs you out (sign in again - that's all).
//  - Every /admin/* page takes that session. A page that changes something (a form POST) must also carry the session's
//    CSRF token (a hidden field the page puts in its own forms) AND come from this server's own address (the browser's
//    Origin / Referer header). The ADMIN_KEY itself is never put in a page, a link or a log.
//  - Wrong keys are slowed down: 5 wrong tries from one address in 15 minutes locks that address for 15 minutes, and if
//    the whole server sees 25 wrong tries in 15 minutes (someone guessing from many addresses), sign-in pauses for
//    everyone for 30 s, then 60 s, 2 min ... up to 15 min (a session you already have keeps working).
//  - TRANSITION: the old way - each page's own password form posting key=ADMIN_KEY in the form body - still works (old
//    bookmarks, scripts): it counts as signing in (same limits), starts a session and the page then uses the session.
//    Pages never took ?key= in the address, so there is nothing to keep there (the DJs' own /dj?key= links are DJ keys,
//    not ADMIN_KEY, and are unchanged). TODO(after 2026-12-31): drop the form-key fallback in guard().
//
// Round 110 (security review sec110):
//  - KNOWN DEVICE (M3): after a good sign-in the browser also gets "nmsd_dev" - a signed id (HttpOnly, Secure, SameSite=Strict,
//    Path=/admin/login, 180 days; signed with a server key that is NOT ADMIN_KEY - secrets.js). A browser that shows it skips
//    the server-wide pause and the per-address limit and has its own limit instead (5 wrong in 15 minutes for that device),
//    so a stranger guessing from many addresses can't lock the owner out of signing in.
//  - THE CALLER'S ADDRESS (L1): TRUST_PROXY_HOPS = how many proxies in front of this server add themselves to
//    X-Forwarded-For (counted from the right). Default 1 on Render (RENDER is set there), else 0 = the connection's own
//    address (a forged X-Forwarded-For counts for nothing). IPv6 addresses count by their /64 (one home or phone network).
//  - OLD KEY FORM SESSIONS (L3): sessions started by the old key= form are kept apart (at most 1 per address, 10 in all), so a
//    script using it can never push the owner's browser session out.

const crypto = require('crypto');

const pay = () => require('./payments');   // lazy (payments.js requires this file)
const stats = () => require('./analytics');

const COOKIE = 'nmsd_admin';
const DEVICE_COOKIE = 'nmsd_dev';
const DEVICE_MS = 180 * 86400 * 1000;
const DEVICE_MAX_FAILS = 5;
const MAX_LEGACY_SESSIONS = 10;
const SESSION_MS = 12 * 3600 * 1000;
const MAX_SESSIONS = 50;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_FAILS = 5;
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAILS = 25;
const GLOBAL_LOCK_BASE_MS = 30 * 1000;
const GLOBAL_LOCK_MAX_MS = 15 * 60 * 1000;

const sessions = new Map();   // sha256(id) -> { csrf, created, expires, legacy?, ip? }
const legacyByIp = new Map();  // address -> sha256(id) of the one old-key-form session from there
const deviceFails = new Map(); // known device id -> [times]
const ipFails = new Map();    // ip -> [times]
let globalFails = [];
let globalLockUntil = 0;
let globalStrikes = 0;
let lastGlobalStrikeAt = 0;
const counters = { loginOk: 0, loginFail: 0, locked: 0, csrfRejected: 0 };

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/** How many proxies in front add themselves to X-Forwarded-For (L1). */
function proxyHops() {
  const n = Math.floor(Number(process.env.TRUST_PROXY_HOPS));
  if (Number.isFinite(n) && n >= 0 && n <= 5 && String(process.env.TRUST_PROXY_HOPS).trim() !== '') return n;
  return process.env.RENDER ? 1 : 0;
}

/** An IPv6 address -> its first 64 bits ("2001:db8:0:0::/64"); IPv4 (also "::ffff:1.2.3.4") as it is. */
function netOf(ip) {
  ip = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, null];
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = tail === null ? a : a.concat(new Array(Math.max(0, 8 - a.length - b.length)).fill('0'), b);
  if (groups.length < 4) return ip;
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

/** The caller's address for the wrong-password limits. */
function ipOf(req) {
  const hops = proxyHops();
  const socket = (req.socket && req.socket.remoteAddress) || '';
  if (!hops) return netOf(socket);
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  // the address the nearest trusted proxy saw: the hops-th entry from the right (none there: the connection itself)
  return netOf(forwarded.length >= hops ? forwarded[forwarded.length - hops] : socket);
}

function cookieNamed(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function cookieOf(req) { return cookieNamed(req, COOKIE); }

// ------------------------------------------------------------------ known devices (M3)
let deviceKey = null;
function devKey() { return deviceKey || (deviceKey = require('./secrets').secretFor('admin-known-device', 'ADMIN_DEVICE_SECRET').key); }
function deviceSig(id, exp) { return crypto.createHmac('sha256', devKey()).update('dev1|' + id + '|' + exp).digest('hex').slice(0, 40); }

/** The known-device id this sign-in comes with (a valid, unexpired signature), or ''. */
function deviceOf(req) {
  const m = /^v1\.([a-f0-9]{32})\.([0-9a-z]{1,12})\.([a-f0-9]{40})$/.exec(cookieNamed(req, DEVICE_COOKIE));
  if (!m || !(parseInt(m[2], 36) > Date.now())) return '';
  const want = deviceSig(m[1], m[2]);
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[3])) ? m[1] : '';
}

function setDevice(res, id) {
  id = id || crypto.randomBytes(16).toString('hex');
  const exp = (Date.now() + DEVICE_MS).toString(36);
  appendCookie(res, `${DEVICE_COOKIE}=v1.${id}.${exp}.${deviceSig(id, exp)}; Path=/admin/login; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(DEVICE_MS / 1000)}`);
}

function sweep(now) {
  for (const [k, s] of sessions) if (s.expires <= now) sessions.delete(k);
  for (const [ip, k] of legacyByIp) if (!sessions.has(k)) legacyByIp.delete(ip);
}

/** The signed-in session this request carries, or null. */
function sessionOf(req) {
  const id = cookieOf(req);
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  const now = Date.now();
  const s = sessions.get(sha(id));
  if (!s) return null;
  if (s.expires <= now) { sessions.delete(sha(id)); return null; }
  return s;
}

function cookieLine(id, maxAgeSeconds) {
  return `${COOKIE}=${id}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function startSession(res, legacyIp) {
  const now = Date.now();
  sweep(now);
  if (legacyIp != null) {
    // L3: the old key form - one session per address (the newest), at most MAX_LEGACY_SESSIONS of them, in their own pool
    const had = legacyByIp.get(legacyIp);
    if (had) sessions.delete(had);
    const legacy = [...sessions.entries()].filter(([, x]) => x.legacy);
    for (let i = 0; i <= legacy.length - MAX_LEGACY_SESSIONS; i++) sessions.delete(legacy[i][0]);
  } else {
    const browser = [...sessions.entries()].filter(([, x]) => !x.legacy);
    for (let i = 0; i <= browser.length - MAX_SESSIONS; i++) sessions.delete(browser[i][0]);   // the oldest browser session goes
  }
  const id = crypto.randomBytes(32).toString('hex');
  const s = { csrf: crypto.randomBytes(32).toString('hex'), created: now, expires: now + SESSION_MS };
  if (legacyIp != null) { s.legacy = true; s.ip = legacyIp; legacyByIp.set(legacyIp, sha(id)); }
  sessions.set(sha(id), s);
  appendCookie(res, cookieLine(id, Math.floor(SESSION_MS / 1000)));
  return s;
}

function appendCookie(res, line) {
  const had = res.getHeader('set-cookie');
  res.setHeader('set-cookie', had ? [].concat(had, line) : line);
}

function endSession(req, res, everywhere) {
  if (everywhere) sessions.clear();
  else {
    const id = cookieOf(req);
    if (/^[a-f0-9]{64}$/.test(id)) sessions.delete(sha(id));
  }
  appendCookie(res, cookieLine('', 0));
}

// ------------------------------------------------------------------ wrong keys

function recent(list, windowMs, now) { return list.filter(t => now - t < windowMs); }

/** 0 if this address (or known device) may try a key now, else how many seconds to wait. */
function waitFor(ip, device) {
  const now = Date.now();
  if (device) {   // M3: a known device has its own limit only - never the server-wide pause, never its network's
    const mine = recent(deviceFails.get(device) || [], IP_WINDOW_MS, now);
    return mine.length >= DEVICE_MAX_FAILS ? Math.ceil((mine[0] + IP_WINDOW_MS - now) / 1000) : 0;
  }
  if (globalLockUntil > now) return Math.ceil((globalLockUntil - now) / 1000);
  const mine = recent(ipFails.get(ip) || [], IP_WINDOW_MS, now);
  if (mine.length >= IP_MAX_FAILS) return Math.ceil((mine[0] + IP_WINDOW_MS - now) / 1000);
  return 0;
}

function noteFail(ip, device) {
  const now = Date.now();
  counters.loginFail++;
  try { stats().noteHealth('admin_fail'); } catch { /* the stats module may be loading */ }
  if (device) {
    deviceFails.set(device, recent(deviceFails.get(device) || [], IP_WINDOW_MS, now).concat(now).slice(-20));
    if (deviceFails.size > 1000) deviceFails.delete(deviceFails.keys().next().value);
    return;
  }
  const mine = recent(ipFails.get(ip) || [], IP_WINDOW_MS, now);
  mine.push(now);
  ipFails.set(ip, mine.slice(-20));
  if (ipFails.size > 10000) { let n = 0; for (const k of ipFails.keys()) { ipFails.delete(k); if (++n >= 2000) break; } }
  globalFails = recent(globalFails, GLOBAL_WINDOW_MS, now);
  globalFails.push(now);
  if (globalFails.length >= GLOBAL_MAX_FAILS) {
    if (now - lastGlobalStrikeAt > 2 * GLOBAL_LOCK_MAX_MS) globalStrikes = 0;   // a quiet half hour: start again from 30 s
    globalStrikes++;
    lastGlobalStrikeAt = now;
    globalLockUntil = now + Math.min(GLOBAL_LOCK_MAX_MS, GLOBAL_LOCK_BASE_MS * Math.pow(2, globalStrikes - 1));
    globalFails = [];
    counters.locked++;
    console.error('admin sign-in: too many wrong keys server-wide - sign-in paused for ' + Math.round((globalLockUntil - now) / 1000) + ' s');
  }
}

function noteOk(ip, device) { if (device) deviceFails.delete(device); else ipFails.delete(ip); counters.loginOk++; }

setInterval(() => {
  const now = Date.now();
  sweep(now);
  for (const [ip, list] of ipFails) if (!list.some(t => now - t < IP_WINDOW_MS)) ipFails.delete(ip);
  for (const [d, list] of deviceFails) if (!list.some(t => now - t < IP_WINDOW_MS)) deviceFails.delete(d);
}, 60000).unref();

// ------------------------------------------------------------------ where a request came from

function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch { return ''; } }

/**
 * true: the browser says this came from one of our own pages; false: it says it came from somewhere else (or hides it:
 * "null"); null: it didn't say (not a browser - e.g. a script with the key).
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  let from = '';
  if (origin != null) {
    if (String(origin) === 'null') return false;
    from = hostOf(String(origin));
    if (!from) return false;
  } else if (referer) {
    from = hostOf(String(referer));
    if (!from) return false;
  } else return null;
  const ours = new Set([String(req.headers.host || '').toLowerCase(), hostOf(process.env.PUBLIC_URL || ''), hostOf(process.env.RENDER_EXTERNAL_URL || '')].filter(Boolean));
  return ours.has(from);
}

function sameToken(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== 64 || b.length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ------------------------------------------------------------------ pages

const esc = s => pay().escapeHtml(s);

/** Only our own admin pages are places to go back to after signing in. */
function safeNext(next) {
  next = String(next || '');
  return /^\/admin(\/[a-z0-9\-/]*)?$/.test(next) && !next.includes('//') ? next : '/admin';
}

function signInHtml(next, note) {
  return `<style>
.signin{max-width:380px;margin:9vh auto 0;background:#171a21;border:1px solid #2a2f3a;border-radius:16px;padding:26px 22px}
.signin .moon{width:44px;height:44px;border-radius:50%;background:radial-gradient(circle at 34% 34%,#ffe0a0,#e8b14c 55%,#8a6420);box-shadow:0 0 28px #e8b14c55;margin-bottom:14px}
.signin h1{font-size:22px;margin:0 0 4px}.signin p{margin:0 0 16px;font-size:14px}
.signin input{width:100%;box-sizing:border-box;font-size:16px;padding:12px;margin:0 0 12px}
.signin button{width:100%;font-size:16px;padding:12px}
.signin .note{background:#3a1c1c;border:1px solid #ff8a80;color:#ffd2cc;border-radius:8px;padding:10px;font-size:14px;margin-bottom:14px}
</style><div class="signin"><div class="moon" aria-hidden="true"></div><h1>New Moon admin</h1>
<p>Sign in with your admin password (ADMIN_KEY on Render). You stay signed in on this device for 12 hours.</p>
${note ? `<div class="note" role="alert">${esc(note)}</div>` : ''}
<form method="post" action="/admin/login"><input type="hidden" name="next" value="${esc(safeNext(next))}">
<label for="k" class="small">Admin password</label><input id="k" type="password" name="password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button></form></div>`;
}

function signInPage(res, status, next, note) {
  pay().page(res, status, 'Sign in - New Moon admin', signInHtml(next, note));
}

/** A hidden form field with the session's CSRF token (every admin form carries it). */
function hidden(token) { return `<input type="hidden" name="csrf" value="${esc(token)}">`; }

// ------------------------------------------------------------------ the two routes this file answers

/** POST /admin/login, POST /admin/logout. Returns true if it answered. */
function handle(req, res) {
  let route;
  try { route = new URL(req.url, 'http://relay').pathname; } catch { return false; }
  if (route !== '/admin/login' && route !== '/admin/logout') return false;
  const P = pay();
  if (route === '/admin/login') {
    if (req.method !== 'POST') { signInPage(res, 200, '/admin'); return true; }
    const ip = ipOf(req);
    P.readForm(req, 4096).then(form => {
      const next = safeNext(form.get('next'));
      if (sameOrigin(req) === false) { signInPage(res, 403, next, 'That sign-in didn\'t come from this page. Open /admin and try again.'); return; }
      const device = deviceOf(req);
      const wait = waitFor(ip, device);
      if (wait) { res.setHeader('retry-after', String(wait)); signInPage(res, 429, next, `Too many wrong passwords - wait ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''} and try again.`); return; }
      const key = form.get('password') || form.get('key') || '';
      if (!P.adminOk(key)) { noteFail(ip, device); signInPage(res, 403, next, 'Wrong password (or ADMIN_KEY isn\'t set on the server).'); return; }
      noteOk(ip, device);
      startSession(res);
      setDevice(res, device);   // M3: this browser is a known device from now on (renewed for 180 days at every sign-in)
      res.writeHead(303, { location: next, 'cache-control': 'no-store' });
      res.end();
    }).catch(() => { if (!res.headersSent) signInPage(res, 400, '/admin', 'Something went wrong - try again.'); });
    return true;
  }
  // /admin/logout
  if (req.method !== 'POST') { res.writeHead(303, { location: '/admin' }); res.end(); return true; }
  P.readForm(req, 4096).then(form => {
    const s = sessionOf(req);
    if (s && (sameOrigin(req) !== true || !sameToken(form.get('csrf'), s.csrf))) { counters.csrfRejected++; signInPage(res, 403, '/admin', 'That sign-out didn\'t come from your admin page.'); return; }
    if (s) endSession(req, res, form.get('all') === '1');
    else appendCookie(res, cookieLine('', 0));
    res.writeHead(303, { location: '/admin', 'cache-control': 'no-store' });
    res.end();
  }).catch(() => { if (!res.headersSent) { res.writeHead(303, { location: '/admin' }); res.end(); } });
  return true;
}

/**
 * Every admin page calls this first. Resolves to { form, token } when the request may go ahead (token = the CSRF token
 * to put in the page's forms - use hidden(token)), or null when it has already answered (the sign-in page, 403, 429).
 *   opts.path   the page's own address (where to come back to after signing in)
 *   opts.limit  the most bytes its form may have
 */
function guard(req, res, opts) {
  opts = opts || {};
  const path = safeNext(opts.path);
  const s = sessionOf(req);
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (s) { res.adminPage = { path, token: s.csrf }; return Promise.resolve({ form: new URLSearchParams(), token: s.csrf, get: true }); }
    signInPage(res, 401, path);
    return Promise.resolve(null);
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
    res.end();
    return Promise.resolve(null);
  }
  const P = pay();
  const ip = ipOf(req);
  return P.readForm(req, opts.limit || 64 * 1024).then(form => {
    const origin = sameOrigin(req);
    if (form.has('key')) {
      // The transition: a page's old password form (key=ADMIN_KEY in the form body). Counts as signing in.
      if (origin === false) { counters.csrfRejected++; signInPage(res, 403, path, 'That request didn\'t come from your admin page.'); return null; }
      const wait = waitFor(ip);
      if (wait) { res.setHeader('retry-after', String(wait)); signInPage(res, 429, path, `Too many wrong passwords - wait ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''} and try again.`); return null; }
      if (!P.adminOk(form.get('key'))) { noteFail(ip); signInPage(res, 403, path, 'Wrong password (or ADMIN_KEY isn\'t set on the server).'); return null; }
      noteOk(ip);
      form.delete('key');
      const live = s || startSession(res, ip);   // L3: its own pool, one per address
      res.adminPage = { path, token: live.csrf };
      return { form, token: live.csrf };
    }
    if (!s) { signInPage(res, 401, path, 'Please sign in (your session ended).'); return null; }
    if (origin !== true || !sameToken(form.get('csrf'), s.csrf)) {
      counters.csrfRejected++;
      try { stats().noteHealth('csrf_reject'); } catch { /* */ }
      P.page(res, 403, 'Not allowed', `<h1>That didn't come from your admin page</h1><p>For your safety, changes are only taken from the admin pages themselves.</p><a class="btn" href="${esc(path)}">Open the page again</a>`);
      return null;
    }
    form.delete('csrf');
    res.adminPage = { path, token: s.csrf };   // payments.page() puts the admin top bar on the page
    return { form, token: s.csrf };
  });
}

/** A short status for the hub and the stats page's Health section. */
function status() {
  const now = Date.now();
  sweep(now);
  return { sessions: sessions.size, loginOk: counters.loginOk, loginFail: counters.loginFail, locks: counters.locked, csrfRejected: counters.csrfRejected,
    pausedFor: globalLockUntil > now ? Math.ceil((globalLockUntil - now) / 1000) : 0 };
}

/** When the session on this request ends (ms), or 0. */
function expiresOf(req) { const s = sessionOf(req); return s ? s.expires : 0; }

module.exports = { handle, guard, hidden, sessionOf, expiresOf, status, signInPage, COOKIE, ipOf,
  _test: { sessions, reset: () => { sessions.clear(); ipFails.clear(); deviceFails.clear(); legacyByIp.clear(); globalFails = []; globalLockUntil = 0; globalStrikes = 0; }, sameOrigin, safeNext, netOf, proxyHops } };
