'use strict';
// Round 74: LIVE ACCOUNTS. The owner: "if people are going to play the live mode, they have to sign up with a username and
// email" ... "make sure that i as admin have access to all sign up username accounts and emails... they will also need to
// make a password and we need to make sure that this info ALWAYS translates over to new updates so they dont loose
// accounts.. add generic terms and services".
//
// Everyone who joins the Open Festival (/public) needs a live account: a USERNAME (unique - the name everyone there sees),
// an EMAIL (one account per email) and a PASSWORD, and they must agree to the Terms of Service and Privacy Policy and
// confirm they're 13 or older. The game remembers the device (a token), so they only type it once; any other device signs
// in with the username (or email) and password.
//
//   POST /players/signup    {username, email, password, agree:true, age13:true, terms}  -> {ok, username, token}
//   POST /players/signin    {login (username or email), password}                       -> {ok, username, email, token}
//   GET  /players/me        Authorization: Bearer <token>                               -> {ok, username, email, termsOk}
//   POST /players/password  Bearer + {password, newPassword}                            -> {ok, token}
//   POST /players/agree     Bearer + {terms}                                            -> {ok}   (new terms accepted)
//   POST /players/delete    Bearer + {password}                                         -> {ok}   (the player deletes their account)
//   GET  /terms, /privacy   the Terms of Service and the Privacy Policy (the game links to them)
//   GET/POST /admin/players (admin password): every account - username, email, joined, last seen, terms - search, reset a
//                           password, delete, download CSV, download / restore a full backup.
//
// PASSWORDS are never stored: only a salted scrypt hash (not even the admin can see one; the admin can set a new one).
// Device tokens are stored hashed too.
//
// KEEPING ACCOUNTS FOREVER (through every server update / redeploy / restart):
//   1. players.json in STORE_DATA_DIR - the Render persistent disk (Render > nmsd > Disks; mount path e.g. /var/data and
//      STORE_DATA_DIR=/var/data). A disk survives every deploy. players.json.bak is the version before each save.
//   2. AND/OR an off-site backup to a PRIVATE GitHub repo (works on a free server with no disk): set
//        BACKUP_GITHUB_REPO   e.g. moonvisions/nmsd-data   (a PRIVATE repo - never the public nmsd one)
//        BACKUP_GITHUB_TOKEN  a fine-grained token with "Contents: read and write" on that repo only
//      The accounts are encrypted (AES-256-GCM, key from BACKUP_KEY, else ADMIN_KEY - don't change it later) and pushed
//      there a few seconds after every change; on start-up the newest copy (disk or GitHub) is loaded. Until that first
//      load finishes the server answers "starting up - try again", and it NEVER pushes an empty list over a backup.
//   3. The admin page's "Download full backup" - keep a copy somewhere safe now and then; "Restore" merges one back.
//
// LIVE_SIGNUP_REQUIRED=0 (Render > Environment) lets copies of the game without accounts into /public (default: required).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const P = () => require('./payments');
const LB = () => require('./leaderboards');

const DIR = process.env.STORE_DATA_DIR || __dirname;
const FILE = path.join(DIR, 'players.json');
const BAK = FILE + '.bak';
const MAX_PLAYERS = 500000;
const MAX_TOKENS = 8;
const TERMS_VERSION = '2026-10-14';
const CONTACT = process.env.CONTACT_EMAIL || 'daniel@moonvisionmedia.com';
const COMPANY = 'Moon Vision Media LLC';

let state = { version: 2, savedAt: '', players: {} };   // key: lower-case username
let byEmail = new Map();   // email -> key
let byToken = new Map();   // token hash -> key
let dirty = false;
let ready = false;         // the newest copy (disk / GitHub) has been loaded
let loadNote = '';

// ------------------------------------------------------------------ storage: the disk

function readFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.players && typeof data.players === 'object') return data;
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('players read', file, err.message);
  }
  return null;
}

function index() {
  byEmail = new Map();
  byToken = new Map();
  for (const [key, p] of Object.entries(state.players)) {
    if (p.email) byEmail.set(p.email, key);
    for (const t of p.tokens || []) byToken.set(t, key);
  }
}

function count(data) { return data && data.players ? Object.keys(data.players).length : 0; }

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a.savedAt || '') || 0, tb = Date.parse(b.savedAt || '') || 0;
  if (ta !== tb) return ta > tb ? a : b;
  return count(a) >= count(b) ? a : b;
}

/** Marks the accounts changed (written to disk within 3 s). <paramref important> (an account made, changed or deleted - not just
 *  "last seen") also sends the off-site backup soon. */
function save(important = true) {
  dirty = true;
  if (important) vaultSoon(4000);
  else vaultSoon(600000);   // (last-seen times ride along with the next backup, at most every 10 minutes)
}

function flush() {
  if (!dirty || !ready) return;
  dirty = false;
  state.savedAt = new Date().toISOString();
  try {
    if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BAK);
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('players save', err && err.message);
  }
}

setInterval(flush, 3000).unref();
process.on('SIGTERM', () => { flush(); });

// ------------------------------------------------------------------ storage: the off-site backup (a private GitHub repo)

const VAULT_REPO = (process.env.BACKUP_GITHUB_REPO || '').trim();
const VAULT_TOKEN = (process.env.BACKUP_GITHUB_TOKEN || '').trim();
const VAULT_PATH = 'players.backup.json';
const vault = { on: !!(VAULT_REPO && VAULT_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(VAULT_REPO)), sha: null, pushedAt: '', error: '', loaded: false, timer: null, busy: false };

function vaultKey() {
  const secret = process.env.BACKUP_KEY || process.env.ADMIN_KEY || '';
  return secret.length >= 8 ? crypto.scryptSync(secret, 'nmsd-live-accounts-backup', 32) : null;
}

function seal(obj) {
  const key = vaultKey();
  if (!key) throw new Error('BACKUP_KEY / ADMIN_KEY not set');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: body.toString('base64'), players: count(obj), savedAt: obj.savedAt });
}

function unseal(text) {
  const box = JSON.parse(text);
  const key = vaultKey();
  if (!key) throw new Error('BACKUP_KEY / ADMIN_KEY not set');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  const json = Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
  return JSON.parse(json);
}

async function github(method, body, raw) {
  const res = await fetch(`https://api.github.com/repos/${VAULT_REPO}/contents/${VAULT_PATH}`, {
    method,
    headers: { authorization: `Bearer ${VAULT_TOKEN}`, accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'user-agent': 'nmsd-server', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  if (!raw) { try { json = JSON.parse(text); } catch { /* */ } }
  return { status: res.status, json, text };
}

/** The backup on GitHub: {status, data (unsealed), sha}. The file itself is read "raw" (works however big it gets). */
async function fetchRemote() {
  const meta = await github('GET');
  if (meta.status !== 200 || !meta.json) return { status: meta.status, message: meta.json && meta.json.message };
  const raw = await github('GET', null, true);
  if (raw.status !== 200) return { status: raw.status };
  return { status: 200, sha: meta.json.sha, data: unseal(raw.text) };
}

/** Start-up: the newest of the disk copy, its .bak and the GitHub copy. */
async function load() {
  const disk = readFile(FILE), bak = readFile(BAK);
  let best = newer(disk, bak);
  if (best && disk == null) loadNote = 'The main accounts file was missing or damaged, so its backup copy was loaded.';
  let remoteNewer = false;
  if (vault.on) {
    // Keep asking GitHub. With accounts on the disk, carry on after ~1 minute (and merge GitHub's later); with NO accounts
    // on the disk (a free server after a redeploy), stay "starting up" until GitHub answers - never come up empty and
    // send people to sign up again.
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetchRemote();
        if (r.status === 200) {
          vault.sha = r.sha;
          if (r.data && r.data.players) {
            const pick = newer(best, r.data);
            remoteNewer = pick === r.data && count(r.data) > 0;
            if (remoteNewer) loadNote = `Accounts loaded from the GitHub backup (${count(r.data)} accounts).`;
            // Start from the newer copy, and take in anything only the other one has.
            const other = pick === r.data ? best : r.data;
            state = pick;
            state.players = state.players || {};
            index();
            if (other) merge(other, true);
            best = state;
          }
          vault.loaded = true;
          vault.error = '';
          break;
        }
        if (r.status === 404) { vault.loaded = true; vault.error = ''; break; }   // (no backup yet - the first push makes it)
        vault.error = `GitHub answered ${r.status}${r.message ? ': ' + r.message : ''} - check BACKUP_GITHUB_REPO, BACKUP_GITHUB_TOKEN and BACKUP_KEY / ADMIN_KEY.`;
      } catch (err) {
        vault.error = 'Could not read the GitHub backup: ' + (err && err.message) + ' (if ADMIN_KEY was changed, set BACKUP_KEY to the old one).';
      }
      console.error('players vault', vault.error);
      if (attempt >= 4 && count(best) > 0) break;   // the disk has accounts: carry on with them; GitHub is merged in later
      await new Promise(r => setTimeout(r, Math.min(60000, 6000 + attempt * 6000)));
    }
  }

  if (best) state = best;
  state.players = state.players || {};
  state.deletedKeys = state.deletedKeys || {};
  state.version = 2;
  index();
  ready = true;
  console.log(`players: ${count(state)} live accounts loaded${persistent() ? ' (disk)' : ''}${vault.on ? (vault.loaded ? ' (GitHub backup on)' : ' (GitHub backup NOT reachable)') : ''}`);
  if (vault.on && vault.loaded && !remoteNewer && count(state) > 0) vaultSoon(3000);   // (the disk had something newer)
  if (vault.on && !vault.loaded) setTimeout(retryVault, 120000).unref();
}

async function retryVault() {
  try {
    const r = await fetchRemote();
    if (r.status === 200) {
      vault.sha = r.sha;
      merge(r.data, true);
      vault.loaded = true;
      vault.error = '';
      vaultSoon(1000);
      return;
    }
    if (r.status === 404) { vault.loaded = true; vault.error = ''; vaultSoon(1000); return; }
    vault.error = `GitHub answered ${r.status}`;
  } catch (err) {
    vault.error = 'Could not read the GitHub backup: ' + (err && err.message);
  }
  setTimeout(retryVault, 300000).unref();
}

let vaultDue = 0;
function vaultSoon(ms) {
  if (!vault.on || !vault.loaded || !ready) return;
  const due = Date.now() + (ms || 4000);
  if (vault.timer && vaultDue <= due) return;   // (one already due sooner)
  if (vault.timer) clearTimeout(vault.timer);
  vaultDue = due;
  vault.timer = setTimeout(() => { vault.timer = null; push(); }, due - Date.now());
  if (vault.timer.unref) vault.timer.unref();
}

/** Stopping (a redeploy): the accounts to disk and, if a backup is waiting, to GitHub now (the relay waits a few seconds). */
async function final() {
  flush();
  if (vault.timer) {
    clearTimeout(vault.timer);
    vault.timer = null;
    if (vaultDue - Date.now() < 300000) await push();   // (just last-seen times can wait for next time)
  }
}

async function push() {
  if (!vault.on || !vault.loaded || !ready || vault.busy) return;
  vault.busy = true;
  try {
    const snapshot = Object.assign({}, state, { savedAt: new Date().toISOString() });
    const content = Buffer.from(seal(snapshot), 'utf8').toString('base64');
    let r = await github('PUT', { message: `accounts backup (${count(snapshot)})`, content, sha: vault.sha || undefined });
    if (r.status === 409 || r.status === 422) {
      // Someone else saved since (the other server during a redeploy): take in their accounts first, then save both.
      const g = await fetchRemote();
      if (g.status === 200) {
        vault.sha = g.sha;
        merge(g.data, true);
        flush();
      }
      const both = Object.assign({}, state, { savedAt: new Date().toISOString() });
      r = await github('PUT', { message: `accounts backup (${count(both)})`, content: Buffer.from(seal(both), 'utf8').toString('base64'), sha: vault.sha || undefined });
    }
    if (r.status === 200 || r.status === 201) {
      vault.sha = r.json && r.json.content ? r.json.content.sha : vault.sha;
      vault.pushedAt = new Date().toISOString();
      vault.error = '';
    } else {
      vault.error = `Backup push failed: GitHub answered ${r.status}${r.json && r.json.message ? ' (' + r.json.message + ')' : ''}.`;
      console.error('players vault', vault.error);
      setTimeout(() => vaultSoon(), 60000).unref();
    }
  } catch (err) {
    vault.error = 'Backup push failed: ' + (err && err.message);
    console.error('players vault', vault.error);
    setTimeout(() => vaultSoon(), 60000).unref();
  } finally {
    vault.busy = false;
  }
}

/** Adds a backup's accounts (the newer copy of each), never removing any - and never bringing back one that was deleted
 *  here. <quiet>: don't schedule a backup just for this. Returns how many were added or updated. */
function merge(data, quiet) {
  if (!data || !data.players || typeof data.players !== 'object') return 0;
  state.deletedKeys = state.deletedKeys || {};
  for (const [k, at] of Object.entries(data.deletedKeys || {})) {
    if (!state.deletedKeys[k] || state.deletedKeys[k] < at) state.deletedKeys[k] = at;
  }
  let n = 0;
  for (const [key, p] of Object.entries(data.players)) {
    if (!p || typeof p !== 'object' || !p.username || !p.email) continue;
    const k = String(p.username).toLowerCase();
    if (k !== key.toLowerCase()) continue;
    const stamp = Date.parse(p.updated || p.created || '') || 0;
    const gone = Date.parse(state.deletedKeys[k] || '') || 0;
    if (gone && gone >= stamp) continue;   // deleted after this copy was made
    const mine = state.players[k];
    if (mine && (Date.parse(mine.updated || mine.created || '') || 0) >= stamp) continue;
    const other = byEmail.get(p.email);
    if (other && other !== k) continue;   // that email is someone else's here
    state.players[k] = p;
    n++;
  }
  // Accounts deleted elsewhere (the other server) go here too.
  for (const [k, at] of Object.entries(state.deletedKeys)) {
    const mine = state.players[k];
    if (mine && (Date.parse(mine.updated || mine.created || '') || 0) <= (Date.parse(at) || 0)) { delete state.players[k]; n++; }
  }
  index();
  if (n) { dirty = true; if (!quiet) vaultSoon(4000); }
  return n;
}

load();

// ------------------------------------------------------------------ helpers

function required() { return process.env.LIVE_SIGNUP_REQUIRED !== '0'; }
function persistent() { return !!process.env.STORE_DATA_DIR; }
function isReady() { return ready; }

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function cleanUsername(text) { return String(text || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 16); }
function cleanEmail(text) { return String(text || '').trim().toLowerCase().slice(0, 120); }
function validEmail(email) { return /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/.test(email); }
function rude(name) { try { return LB().isRude(name); } catch { return false; } }

function passwordProblem(pw, username) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Your password needs at least 8 characters.';
  if (pw.length > 72) return 'That password is too long (72 characters at most).';
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return "Your password can't be the same as your username.";
  if (/^(.)\1+$/.test(pw) || /^(12345678|password|qwertyui)/i.test(pw)) return 'That password is too easy to guess - try another.';
  return '';
}

function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(pw), salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err); else resolve(`s1$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}

function checkPassword(pw, stored) {
  return new Promise(resolve => {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 's1') return resolve(false);
    const salt = Buffer.from(parts[1], 'base64'), want = Buffer.from(parts[2], 'base64');
    crypto.scrypt(String(pw || ''), salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err || key.length !== want.length) return resolve(false);
      resolve(crypto.timingSafeEqual(key, want));
    });
  });
}

function newToken(p) {
  const token = crypto.randomBytes(24).toString('hex');
  const hash = sha('pt|' + token);
  p.tokens = (p.tokens || []).concat(hash);
  while (p.tokens.length > MAX_TOKENS) byToken.delete(p.tokens.shift());
  byToken.set(hash, p.username.toLowerCase());
  return token;
}

function dropTokens(p) {
  for (const t of p.tokens || []) byToken.delete(t);
  p.tokens = [];
}

/** The account a device token belongs to (or null). */
function check(token) {
  if (!ready || !token || typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const key = byToken.get(sha('pt|' + token));
  return key ? state.players[key] || null : null;
}

function byBearer(req) {
  const auth = String(req.headers.authorization || '');
  return check(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
}

const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < ms);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20000) hits.clear();
  return list.length > max;
}

/** Over the limit already (without counting this one). */
function peek(key, max, ms) {
  const now = Date.now();
  return (hits.get(key) || []).filter(t => now - t < ms).length >= max;
}

function ipOf(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { body = ''; req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const now = () => new Date().toISOString();

// ------------------------------------------------------------------ routes

function handle(req, res) {
  const route = String(req.url || '').split('?')[0];
  if (route === '/terms' || route === '/terms.html') { legal(res, 'terms'); return true; }
  if (route === '/privacy' || route === '/privacy.html') { legal(res, 'privacy'); return true; }
  if (route === '/admin/players') { admin(req, res); return true; }
  if (!route.startsWith('/players/')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, authorization' });
    res.end();
    return true;
  }

  if (!ready) { json(res, 503, { ok: false, message: 'The server is starting up - try again in a few seconds.' }); return true; }
  const ip = ipOf(req);

  if (route === '/players/me') {
    const p = byBearer(req);
    if (!p) { json(res, 401, { ok: false, message: 'Please sign in again.' }); return true; }
    p.seen = now();
    save(false);
    json(res, 200, { ok: true, username: p.username, email: p.email, termsOk: !!(p.terms && p.terms.version === TERMS_VERSION), terms: TERMS_VERSION });
    return true;
  }

  if (req.method !== 'POST') { json(res, 405, { ok: false }); return true; }
  readJson(req, 4096).then(body => route2(route, req, res, body, ip)).catch(err => {
    console.error('players', err && err.message);
    json(res, 500, { ok: false, message: 'Something went wrong - try again in a minute.' });
  });
  return true;
}

async function route2(route, req, res, body, ip) {
  switch (route) {
    case '/players/signup': {
      if (peek('up|' + ip, 20, 3600000)) return json(res, 429, { ok: false, message: 'Too many new accounts from this network - try again later.' });
      const username = cleanUsername(body.username);
      const email = cleanEmail(body.email);
      const key = username.toLowerCase();
      if (username.length < 3) return json(res, 400, { ok: false, field: 'username', message: 'Pick a username: 3 to 16 letters or numbers (_ . - are fine too).' });
      if (rude(username)) return json(res, 400, { ok: false, field: 'username', message: "That username isn't allowed - try another." });
      if (!validEmail(email)) return json(res, 400, { ok: false, field: 'email', message: "That email address doesn't look right." });
      const bad = passwordProblem(body.password, username);
      if (bad) return json(res, 400, { ok: false, field: 'password', message: bad });
      if (body.agree !== true) return json(res, 400, { ok: false, field: 'agree', message: 'Please agree to the Terms of Service and Privacy Policy to make an account.' });
      if (body.age13 !== true) return json(res, 400, { ok: false, field: 'agree', message: 'Live mode is for players 13 and older.' });
      if (state.players[key]) return json(res, 409, { ok: false, field: 'username', message: `"${username}" is taken - try another username (or sign in if it's yours).` });
      const other = byEmail.get(email);
      if (other && state.players[other]) return json(res, 409, { ok: false, field: 'email', message: 'That email already has an account - sign in instead.' });
      if (Object.keys(state.players).length >= MAX_PLAYERS) return json(res, 503, { ok: false, message: 'Sign-ups are full right now.' });
      const pass = await hashPassword(body.password);
      if (state.players[key] || byEmail.get(email)) return json(res, 409, { ok: false, field: 'username', message: 'That was just taken - try again.' });
      const p = { username, email, pass, created: now(), updated: now(), seen: now(), terms: { version: TERMS_VERSION, at: now(), age13: true }, tokens: [] };
      state.players[key] = p;
      byEmail.set(email, key);
      const token = newToken(p);
      limited('up|' + ip, 20, 3600000);   // (only accounts actually made count)
      if (state.deletedKeys) delete state.deletedKeys[key];
      save();
      return json(res, 200, { ok: true, username, email, token });
    }

    case '/players/signin': {
      if (peek('in|' + ip, 50, 3600000)) return json(res, 429, { ok: false, message: 'Too many wrong tries from this network - wait a while and try again.' });
      const login = String(body.login || body.username || '').trim();
      const key = login.includes('@') ? byEmail.get(cleanEmail(login)) : cleanUsername(login).toLowerCase();
      const p = key ? state.players[key] : null;
      if (p && peek('acct|' + key + '|' + ip, 10, 3600000)) return json(res, 429, { ok: false, message: `Too many wrong passwords - wait an hour, or email ${CONTACT} to reset it.` });
      const okPass = p ? await checkPassword(body.password, p.pass) : await checkPassword(body.password, 's1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');   // (same time either way)
      if (!p || !okPass) {
        limited('in|' + ip, 50, 3600000);   // (only wrong tries count)
        if (p) limited('acct|' + key + '|' + ip, 10, 3600000);
      }
      if (!p || !okPass) return json(res, 401, { ok: false, field: 'password', message: `That username / email and password don't match. Forgot your password? Email ${CONTACT} and we'll reset it.` });
      const token = newToken(p);
      p.seen = now();
      save(false);
      return json(res, 200, { ok: true, username: p.username, email: p.email, token, termsOk: !!(p.terms && p.terms.version === TERMS_VERSION) });
    }

    case '/players/password': {
      const p = byBearer(req);
      if (!p) return json(res, 401, { ok: false, message: 'Please sign in again.' });
      if (limited('pw|' + p.username.toLowerCase(), 10, 3600000)) return json(res, 429, { ok: false, message: 'Too many tries - wait a while.' });
      if (!(await checkPassword(body.password, p.pass))) return json(res, 401, { ok: false, field: 'password', message: "Your current password isn't right." });
      const bad = passwordProblem(body.newPassword, p.username);
      if (bad) return json(res, 400, { ok: false, field: 'newPassword', message: bad });
      p.pass = await hashPassword(body.newPassword);
      p.updated = now();
      dropTokens(p);   // signs out every other device
      const token = newToken(p);
      save();
      return json(res, 200, { ok: true, token });
    }

    case '/players/signout': {
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const p = check(token);
      if (p) {
        const hash = sha('pt|' + token);
        p.tokens = (p.tokens || []).filter(t => t !== hash);
        byToken.delete(hash);
        save(false);
      }
      return json(res, 200, { ok: true });
    }

    case '/players/agree': {
      const p = byBearer(req);
      if (!p) return json(res, 401, { ok: false, message: 'Please sign in again.' });
      p.terms = { version: TERMS_VERSION, at: now(), age13: true };
      p.updated = now();
      save();
      return json(res, 200, { ok: true });
    }

    case '/players/delete': {
      const p = byBearer(req);
      if (!p) return json(res, 401, { ok: false, message: 'Please sign in again.' });
      if (!(await checkPassword(body.password, p.pass))) return json(res, 401, { ok: false, field: 'password', message: "That password isn't right." });
      removeAccount(p.username.toLowerCase());
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { ok: false });
}

function removeAccount(key) {
  const p = state.players[key];
  if (!p) return false;
  dropTokens(p);
  if (p.email && byEmail.get(p.email) === key) byEmail.delete(p.email);
  delete state.players[key];
  state.deletedKeys = state.deletedKeys || {};
  state.deletedKeys[key] = now();   // (so no backup ever brings it back)
  save();
  return true;
}

// ------------------------------------------------------------------ admin

function admin(req, res) {
  const pay = P();
  const esc = (s) => pay.escapeHtml(s);

  const show = (key, q, note) => {
    const all = Object.values(state.players).sort((a, b) => String(b.created).localeCompare(String(a.created)));
    const term = String(q || '').trim().toLowerCase();
    const list = term ? all.filter(p => p.username.toLowerCase().includes(term) || String(p.email).includes(term)) : all;
    const hidden = `<input type="hidden" name="key" value="${esc(key)}">`;
    const rows = list.slice(0, 500).map(p => {
      const k = esc(p.username.toLowerCase());
      return `<tr><td><b>${esc(p.username)}</b><br><span class="small">${esc(p.email)}</span></td>
<td class="small">joined ${esc(String(p.created).slice(0, 10))}<br>last seen ${esc(String(p.seen || '').slice(0, 10))}<br>terms ${esc(p.terms ? p.terms.version : 'not yet')}</td>
<td><form method="post" action="/admin/players" onsubmit="return confirm('Give ${k} a new password? (Tell them by email.)')">${hidden}<input type="hidden" name="action" value="reset"><input type="hidden" name="who" value="${k}"><button type="submit">New password</button></form>
<form method="post" action="/admin/players" onsubmit="return confirm('DELETE the account ${k}? This cannot be undone.')">${hidden}<input type="hidden" name="action" value="delete"><input type="hidden" name="who" value="${k}"><button type="submit" style="background:#ff8a80">Delete</button></form></td></tr>`;
    }).join('');

    const disk = persistent() ? '<span class="on">Safe disk: ON</span> (STORE_DATA_DIR)' : '<span class="off">Safe disk: OFF</span> - without a disk (or the GitHub backup below), a redeploy forgets every account.';
    const gh = vault.on
      ? (vault.loaded && !vault.error ? `<span class="on">GitHub backup: ON</span> (${esc(VAULT_REPO)})${vault.pushedAt ? ' - last saved ' + esc(vault.pushedAt.replace('T', ' ').slice(0, 16)) + ' UTC' : ''}` : `<span class="off">GitHub backup: PROBLEM</span> - ${esc(vault.error || 'not reachable yet')}`)
      : '<span class="off">GitHub backup: OFF</span> (set BACKUP_GITHUB_REPO and BACKUP_GITHUB_TOKEN - see README.txt "LIVE ACCOUNTS")';
    const safe = persistent() || (vault.on && vault.loaded && !vault.error);

    pay.page(res, 200, 'Live accounts', `<h1>Live accounts</h1>
${note ? `<p class="code" style="font-size:16px;letter-spacing:0">${note}</p>` : ''}
${loadNote ? `<p class="small">${esc(loadNote)}</p>` : ''}
<p><b>${all.length}</b> accounts (username + email + password) for the Open Festival.${required() ? '' : ' <span class="off">Accounts are switched OFF (LIVE_SIGNUP_REQUIRED=0).</span>'}</p>
<p class="small">${disk}<br>${gh}</p>
${safe ? '' : '<p class="off">Accounts are NOT safe from a redeploy yet. Turn on the disk or the GitHub backup (README.txt "LIVE ACCOUNTS"), and download a full backup now.</p>'}
<p class="small">Passwords are stored scrambled (salted scrypt) - nobody can read them, including you. If a player forgets theirs, press "New password" and email them the new one; they can change it in the game (Settings &gt; Game &gt; Live account).</p>
<form method="post" action="/admin/players">${hidden}<input name="q" value="${esc(q || '')}" placeholder="search username or email"> <button type="submit">Search</button></form>
<form method="post" action="/admin/players" style="display:inline">${hidden}<input type="hidden" name="action" value="csv"><button type="submit">Download usernames + emails (CSV)</button></form>
<form method="post" action="/admin/players" style="display:inline">${hidden}<input type="hidden" name="action" value="backup"><button type="submit">Download full backup</button></form>
<details><summary>Restore from a full backup</summary><form method="post" action="/admin/players" onsubmit="return confirm('Add the accounts from this backup? (Nothing here is removed.)')">${hidden}<input type="hidden" name="action" value="restore"><textarea name="data" rows="6" style="width:100%" placeholder="Paste the whole backup file here"></textarea><button type="submit">Restore (merge)</button></form></details>
<form method="post" action="/admin">${hidden}<button type="submit">Back to admin</button></form>
<table>${rows || '<tr><td class="small">Nobody yet.</td></tr>'}</table>
${list.length > 500 ? `<p class="small">Showing the newest 500 of ${list.length} - search, or download the CSV for everyone.</p>` : ''}`);
  };

  if (req.method !== 'POST') {
    pay.page(res, 200, 'Live accounts', `<h1>Live accounts</h1><form method="post" action="/admin/players"><p>Admin password:</p>
<input type="password" name="key" autofocus> <button type="submit">Open</button></form>`);
    return;
  }

  pay.readForm(req, 4 * 1024 * 1024).then(async form => {
    const key = form.get('key') || '';
    if (!pay.adminOk(key)) {
      pay.page(res, 403, 'Live accounts', '<h1>Live accounts</h1><p>Wrong password (or ADMIN_KEY isn\'t set on the server).</p><a class="btn" href="/admin/players">Try again</a>');
      return;
    }

    if (!ready) { pay.page(res, 503, 'Live accounts', '<h1>Live accounts</h1><p>The server is still loading the accounts - refresh in a few seconds.</p>'); return; }
    const action = form.get('action') || '';
    const stamp = new Date().toISOString().slice(0, 10);

    if (action === 'csv') {
      const q = (s) => '"' + String(s || '').replace(/"/g, '""') + '"';
      const lines = ['username,email,created,last_seen,terms_version,terms_agreed'].concat(Object.values(state.players).map(p =>
        [p.username, p.email, p.created, p.seen, p.terms && p.terms.version, p.terms && p.terms.at].map(q).join(',')));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="live-accounts-${stamp}.csv"`, 'cache-control': 'no-store' });
      res.end(lines.join('\n'));
      return;
    }

    if (action === 'backup') {
      flush();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="live-accounts-backup-${stamp}.json"`, 'cache-control': 'no-store' });
      res.end(JSON.stringify(Object.assign({ kind: 'nmsd-live-accounts' }, state)));
      return;
    }

    let note = '';
    if (action === 'restore') {
      let data = null;
      try { data = JSON.parse(String(form.get('data') || '')); } catch { /* */ }
      note = data && data.players ? `Restored: ${merge(data)} accounts added or updated (nothing removed).` : "That isn't a live accounts backup (paste the whole file).";
    } else if (action === 'reset') {
      const who = String(form.get('who') || '').toLowerCase();
      const p = state.players[who];
      if (p) {
        const words = ['moon', 'star', 'glow', 'tent', 'dune', 'wave', 'drum', 'fire', 'sky', 'rain'];
        const temp = words[crypto.randomInt(words.length)] + '-' + words[crypto.randomInt(words.length)] + '-' + crypto.randomInt(1000, 9999);
        p.pass = await hashPassword(temp);
        p.updated = now();
        dropTokens(p);
        save();
        note = `New password for <b>${esc(p.username)}</b> (${esc(p.email)}): <b>${esc(temp)}</b><br>Email it to them now - it isn't shown again. They can change it in the game.`;
      }
    } else if (action === 'delete') {
      const who = String(form.get('who') || '').toLowerCase();
      note = removeAccount(who) ? `Deleted the account ${esc(who)}.` : 'No such account.';
    }

    show(key, form.get('q') || '', note);
  });
}

/** For the main /admin page: one line and the way in. */
function adminSection(hiddenKey) {
  const n = Object.keys(state.players).length;
  const safe = persistent() || (vault.on && vault.loaded && !vault.error);
  return `<h2>Live accounts</h2><p class="small">${n} player accounts for the Open Festival${required() ? '' : ' (switched OFF - LIVE_SIGNUP_REQUIRED=0)'}${safe ? '' : ' · <span class="off">NOT backed up - see the accounts page</span>'}</p>
<form method="post" action="/admin/players">${hiddenKey}<button type="submit">Open live accounts</button></form>`;
}

// ------------------------------------------------------------------ the Terms of Service and the Privacy Policy

const LEGAL_STYLE = `body{margin:0;background:#0f1216;color:#e6eaf0;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}h1{color:#e8b14c;font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}
p,li{color:#a9b4c2}strong{color:#e6eaf0}a{color:#e8b14c}.card{background:#181d24;border:1px solid #2e3742;border-radius:8px;padding:14px 16px;margin:18px 0}`;

function legal(res, which) {
  const body = which === 'terms' ? termsHtml() : privacyHtml();
  const title = which === 'terms' ? 'New Moon, Same Dark: Terms of Service' : 'New Moon, Same Dark: Privacy Policy';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600', 'x-content-type-options': 'nosniff' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${LEGAL_STYLE}</style></head><body><main>${body}</main></body></html>`);
}

function termsHtml() {
  return `<h1>Terms of Service</h1>
<p>New Moon, Same Dark · ${COMPANY} · Effective ${TERMS_VERSION}</p>
<div class="card"><strong>In short:</strong> be decent to other players, don't cheat or break things, the game and its online features are provided "as is", virtual items have no cash value, and we can suspend accounts that break these rules. Using the game or making an account means you agree to these terms and our <a href="/privacy">Privacy Policy</a>.</div>

<h2>1. Who we are and agreeing to these terms</h2>
<p>New Moon, Same Dark (the "Game"), its online features (the Open Festival / "live mode", friends' festivals, accounts, leaderboards, chat and voice, the store) and our websites (together, the "Services") are provided by ${COMPANY} ("we", "us"). By downloading, installing, playing or making an account, you agree to these Terms. If you don't agree, don't use the Services.</p>

<h2>2. Who can play</h2>
<p>You must be at least 13 years old to make a live account or play online. If you are under the age of majority where you live, you may only use the Services with the permission of a parent or legal guardian, who agrees to these Terms for you. We don't knowingly collect information from children under 13; if we learn an account belongs to one, we'll delete it.</p>

<h2>3. Your account</h2>
<ul><li>Give a real email address you control, pick a username that isn't offensive, misleading or someone else's name or trademark, and keep your password secret. One account per person, and you may not sell, share or transfer it.</li>
<li>You're responsible for everything done with your account. Tell us straight away at ${esc0(CONTACT)} if you think someone else is using it.</li>
<li>We may change a username that breaks these Terms, and we may suspend or close accounts as described in section 7.</li>
<li>You can delete your account at any time in the game (Settings &gt; Game &gt; Live account) or by emailing us.</li></ul>

<h2>4. Rules for playing with others</h2>
<p>You agree not to: harass, threaten, bully, stalk or impersonate anyone; post or say anything hateful, sexually explicit, violent, illegal or that shares someone's private information; cheat, use bots, exploits, mods or hacks that give an unfair advantage or disrupt others; attack, overload, reverse-engineer or try to get unauthorized access to our servers or other players' accounts; spam, advertise or scam; or use the Services for anything illegal. Players can report others in the game; we review reports and may act on them.</p>

<h2>5. What you create and share</h2>
<p>Things you make or share through the Services (names, chat, voice, festival designs, booths, photos, artist applications and other content) stay yours, but you give us a worldwide, non-exclusive, royalty-free licence to host, store, copy, show, share with other players and adapt them as needed to run, improve and promote the Game. You promise you have the right to share them and that they don't break these Terms or anyone else's rights. We may remove any content at any time. Voice and chat are passed between players live and are not recorded by us.</p>

<h2>6. Virtual items and purchases</h2>
<p>Moon Shards, tokens, Festival Pass levels, unlocks, legendary items and other virtual items are a limited, personal, revocable licence to use them in the Game. They have no real-world or cash value, can't be exchanged for money, and can't be sold or transferred outside the Game. Purchases are handled by Stripe, Steam, Google Play or the App Store under their terms; all sales are final except where the law (or that store's own refund policy) says otherwise. We may change, rebalance or retire virtual items and features.</p>

<h2>7. Suspending or ending access</h2>
<p>We may warn, mute, remove from a festival, suspend or close any account, or block access to the Services, at any time if we reasonably believe someone broke these Terms, put other players or the Services at risk, or if the law requires it. You can stop using the Services at any time. Sections 5, 6 and 8 to 12 keep applying after an account ends.</p>

<h2>8. The Game is provided "as is"</h2>
<p>The Services are provided "as is" and "as available". To the fullest extent the law allows, we make no promises or warranties of any kind, express or implied, including that the Services will be uninterrupted, error-free, secure, or that saves, progress, accounts or online features will always be available. Online features, servers and features may change or be discontinued at any time. Some places don't allow these exclusions, so some of them may not apply to you.</p>

<h2>9. Limit on our responsibility</h2>
<p>To the fullest extent the law allows, ${COMPANY} and its owners, employees, contractors and partners are not liable for any indirect, incidental, special, consequential or punitive damages, or for lost profits, data, progress, virtual items or goodwill, arising from or related to the Services, even if we were told they could happen. Our total liability for any claim related to the Services is limited to the greater of the amount you paid us in the 6 months before the claim, or US $50. Nothing in these Terms limits liability that can't be limited by law.</p>

<h2>10. Your responsibility to us</h2>
<p>To the extent the law allows, you agree to defend and hold ${COMPANY} harmless from claims, losses and costs (including reasonable legal fees) that come from your breaking these Terms, your content, or your misuse of the Services.</p>

<h2>11. Disputes</h2>
<p>Please contact us first at ${esc0(CONTACT)} - most problems can be solved quickly. If we can't resolve it within 60 days, and unless the law where you live says otherwise, any dispute will be settled by binding individual arbitration (or in small-claims court if it qualifies), not as a class action or class arbitration, and you and we each give up the right to a jury trial. These Terms are governed by the laws of the State in which ${COMPANY} is organized and the federal laws of the United States, without regard to conflict-of-law rules. If you live in the EU, the UK or another place whose consumer laws give you rights that can't be waived, those rights still apply and you may bring claims in your local courts.</p>

<h2>12. Everything else</h2>
<p>We may update these Terms; if the change is important we'll tell you in the game (and may ask you to agree again), and continuing to use the Services means you accept the new Terms. If part of these Terms can't be enforced, the rest still applies. Not enforcing something isn't a waiver. You may not transfer these Terms; we may transfer them with the Game. These Terms and the Privacy Policy are the whole agreement between you and us about the Services. Third-party stores, platforms and services (Steam, Google Play, the App Store, Stripe, Unity, Render) have their own terms.</p>

<h2>Contact</h2>
<p>${COMPANY} · ${esc0(CONTACT)}</p>`;
}

function privacyHtml() {
  // The privacy policy from privacy.html (kept next to this file), with a section for live accounts. If the file is missing,
  // a short version.
  let main = '';
  try {
    const html = fs.readFileSync(path.join(__dirname, 'privacy.html'), 'utf8');
    const m = html.match(/<main>([\s\S]*)<\/main>/);
    if (m) main = m[1];
  } catch { /* */ }
  const live = `<h2>Live accounts (the Open Festival)</h2>
  <p>To play live you make a live account: a <strong>username</strong> (shown to other players), your <strong>email address</strong> (never shown to other players; used to identify your account, to help you if you lose access, and for important notices about the Game or these policies) and a <strong>password</strong> (we only keep a scrambled one-way version - nobody, including us, can read it). We also keep when you made the account, when you last played, and that you agreed to the Terms of Service and confirmed you're 13 or older. Your device keeps a sign-in key so you don't have to type your password each time. We keep backups of accounts (encrypted where they're stored off our server) so an update never loses them. You can delete your account in the game (Settings &gt; Game &gt; Live account) or by emailing us; it's removed from our server straight away; older encrypted backup copies are kept only to protect everyone's accounts, are never used to bring a deleted account back, and are replaced over time.</p>
  <p>We never sell your information or use your email for advertising. We may email you about your account or important changes; we'll only send newsletters if you ask for them.</p>`;
  if (!main) {
    return `<h1>Privacy Policy</h1><p>${COMPANY}</p>${live}<h2>Contact</h2><p>${COMPANY} · ${esc0(CONTACT)}</p>`;
  }
  const at = main.indexOf('<h2>Who sees it</h2>');
  return at > 0 ? main.slice(0, at) + live + '\n  ' + main.slice(at) : main + live;
}

function esc0(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { handle, check, required, isReady, flush, final, adminSection, TERMS_VERSION, _test: { state: () => state, cleanUsername, validEmail, passwordProblem, seal, unseal, merge } };
