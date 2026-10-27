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
//   GET  /players/progress  Bearer                       -> {ok, stamp, social, progress, role}   (Round 75: the player's saved game,
//                                                           kept with their account so it follows them to any device; all 0 / "" until
//                                                           the game has sent one)
//   POST /players/progress  Bearer + {stamp (ms since epoch), social (JSON string), progress (JSON string), role (<=16 chars)}
//                                                        -> {ok, stamp}. The server never reads inside social / progress - they're the
//                                                           game's own text. If what's stored is NEWER than the stamp sent, nothing is
//                                                           written and the answer is {ok:false, stale:true, stamp, social, progress, role}
//                                                           (the game decides what to keep). At most 96 KB a body (413 "too big"), and one
//                                                           write every 15 s per account (429 "slow down"). No sign-in -> 401 "sign in".
//   GET  /terms, /privacy   the Terms of Service and the Privacy Policy (the game links to them)
//   GET/POST /admin/players (admin password): every account - username, email, joined, last seen, terms - search, reset a
//                           password, delete, download CSV, download / restore a full backup.
//
// PASSWORDS are never stored: only a salted scrypt hash (not even the admin can see one; the admin can set a new one).
// Device tokens are stored hashed too.
//
// Round 75: each account also carries the player's SAVED GAME (p.progress = {stamp, social, progress, role, at}) - it rides
// inside the same players.json / GitHub backup as the account, so every path below (disk, vault, merge, restore) keeps it.
// When two copies of an account meet (merge), the newer saved game wins by its stamp, whichever account copy is kept.
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
//
// Round 109 - THE ACCOUNT IS THE KEY TO EVERYTHING ONLINE (the owner: "In order to play online, you must make a username +
// password + email... make sure the server and game always tracks and maintains their account when they log in/open the
// game"). Every online room now needs a live account too (relay.js: /host, /join?code=, /join?event=, saved worlds;
// worlds.js: /worlds/*). LIVE_SIGNUP_REQUIRED=0 is still the one switch that turns all of it off.
//   GET  /players/status           -> {ok, ready, required}          (no sign-in needed: may this game skip the account?)
//   GET  /players/me?device=...    -> + required; "device" (platform and version, e.g. "Android 1.9.2") is kept as the
//                                     account's LAST DEVICE for the admin page (signup / signin take {device} too)
//   POST /players/progress         + identity (the character - the game's own JSON text, at most 16 KB) and swag (the
//                                     swag unlock ids). An older game that sends no identity never wipes the stored one,
//                                     and swag is a UNION on the server: an unlock, once sent, is never lost (it's even
//                                     taken in when the rest of the save is stale). Body limit 128 KB (was 96).
//   POST /players/store-link       Bearer + {store: "<store account id>.<its device token>" or "", create: true}
//                                  -> {ok, store, token?, account?, parked?, foreign?, created?, swapped?} - the Moon Shards
//                                     store account that belongs to this live account (store.js linkLive: one store account
//                                     per live account; two people's balances are never merged).
//
// Round 109 (security review):
//  - Every account has an immutable random UID (p.uid, made at sign-up; older accounts get one worked out the same way on
//    every server from their username + created time, and saved). Store accounts, saved worlds and backup merges are keyed
//    on the UID, never the username: a deleted username signed up again is a NEW person and inherits nothing - not the
//    store account, the character, the swag or the worlds. Deleted UIDs are tombstoned forever (state.deletedUids).
//  - Deleting an account (the player or the admin) also deletes their saved worlds (worlds.js removeOwnedBy).
//  - POST /players/ticket (Bearer) -> {ok, ticket, expires}: a single-use key, good for 60 s, for one connection - the
//    game puts that in the WebSocket address (?pt=) instead of its long-lived sign-in key (relay.js).
//  - LIVE_ACCOUNT_GRACE_UNTIL=<ISO date> (optional): until then, older games (no account at all) may still host and join
//    rooms and use worlds / the world boards, so the server can go out before every player has updated. /players/status
//    says {grace, graceUntil}. (The Open Festival needed accounts already and isn't affected.)
//
// Round 111 (acct111) - SIGN-INS LAST 3 DAYS (the owner chose "3 days logged in"). Build 110 let his phone straight into
// live play on a sign-in key from months before: keys never ran out, so the game never asked him to sign up or sign in.
//  - Every sign-in key now runs out SESSION_DAYS (3) days after the sign-in / sign-up / password change that made it. FIXED,
//    not sliding: playing every day doesn't stretch it - after 3 days the player signs in again. (Change SESSION_DAYS below
//    - the one place.) Each key's issue time is kept with the account (p.tokenAt: key hash -> ms), so it survives restarts,
//    the disk and the GitHub backup like everything else.
//  - A key that ran out is refused with 401 {ok:false, signin:true, expired:true} everywhere a key is read (/players/me,
//    /players/ticket - so no new connection tickets either -, progress, store-link, password, agree, delete, worlds, the
//    boards, the relay), and pruned from the account (on use, at start-up and every hour).
//  - Keys from before this update have no issue time, so they count as run out: EVERYONE signs in again once on Build 111
//    (older games get the same 401 and their own "sign in again" screen).
//  - Sign-up / sign-in / password replies and /players/me say when the key runs out: {expires (ms since 1970), expiresIn
//    (ms from now), sessionDays}. /players/status says sessionDays too.
//  - Tests only: NMSD_TEST_CLOCK_OFFSET_MS moves this file's session clock (never set it on the real server).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const P = () => require('./payments');
const LB = () => require('./leaderboards');

const DIR = process.env.STORE_DATA_DIR || __dirname;
const FILE = path.join(DIR, 'players.json');
const BAK = FILE + '.bak';
const MAX_PLAYERS = 500000;
const MAX_TOKENS = 8;                  // sign-in keys kept per account (one per device; the oldest goes first)
// Round 111 (acct111): HOW LONG A SIGN-IN LASTS, in days - the one number to change. Fixed from the sign-in (not sliding).
const SESSION_DAYS = 3;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const MAX_PROGRESS_BODY = 128 * 1024;  // Round 75: one progress sync (both blobs together). Round 109: 128 KB (+ identity, swag)
const MAX_ROLE = 16;
const MAX_IDENTITY = 16 * 1024;        // Round 109: the character (PlayerIdentity + the look) - a few KB in practice
const MAX_SWAG = 256;                  // Round 109: swag unlock ids kept per account
const SWAG_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
const MAX_STORE_OTHERS = 6;            // Round 109: other store accounts seen with this live account (for the admin)
const S = () => require('./store');    // Round 109 (lazy, like payments)
const PROGRESS_GAP = 15000;            // one progress write per account this often
const TERMS_VERSION = '2026-10-14';
const CONTACT = process.env.CONTACT_EMAIL || 'daniel@moonvisionmedia.com';
const COMPANY = 'Moon Vision Media LLC';

let state = { version: 2, savedAt: '', players: {} };   // key: lower-case username
let byEmail = new Map();   // email -> key
let byToken = new Map();   // token hash -> key
let byUid = new Map();     // Round 109: uid -> key (connection tickets name the uid)
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
  byUid = new Map();
  const at = clock();
  for (const [key, p] of Object.entries(state.players)) {
    if (p.email) byEmail.set(p.email, key);
    if (pruneTokens(p, key, at)) dirty = true;   // Round 111: keys that ran out (or from before issue times) go
    for (const t of p.tokens || []) byToken.set(t, key);
    if (p.uid) byUid.set(p.uid, key);
  }
}

// ------------------------------------------------------------------ Round 111 (acct111): sign-ins last SESSION_DAYS days

/** Tests only: NMSD_TEST_CLOCK_OFFSET_MS moves the session clock (a 72 h test without waiting 72 h). */
const CLOCK_OFFSET = (() => { if (process.env.RENDER) return 0; const n = Number(process.env.NMSD_TEST_CLOCK_OFFSET_MS || 0); return Number.isFinite(n) ? n : 0; })();   // Round 111: never on Render
if (CLOCK_OFFSET) console.warn(`players: NMSD_TEST_CLOCK_OFFSET_MS=${CLOCK_OFFSET} - the session clock is moved (tests only - never on the real server)`);
function clock() { return Date.now() + CLOCK_OFFSET; }

/** When this key (its hash) was made - 0 for a key from before Round 111 (no issue time: it counts as run out). */
function tokenIssued(p, hash) {
  const t = p && p.tokenAt && typeof p.tokenAt === 'object' ? Number(p.tokenAt[hash]) : 0;
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/** Still good at <at>? (Fixed expiry: SESSION_MS after it was made.) */
function tokenLive(p, hash, at) {
  const t = tokenIssued(p, hash);
  return t > 0 && (at === undefined ? clock() : at) < t + SESSION_MS;
}

/** {expires, expiresIn, sessionDays} for a key - what the game keeps to know when to ask for a sign-in again. */
function sessionOf(p, hash) {
  const expires = tokenIssued(p, hash) + SESSION_MS;
  return { expires, expiresIn: Math.max(0, expires - clock()), sessionDays: SESSION_DAYS };
}

// Keys that ran out recently (hash -> ms), so their 401 can still say "expired" after they're pruned (in memory only; the
// oldest go first past MAX_EXPIRED - after that a refusal is a plain "sign in", which the game treats the same way).
const expiredKeys = new Map();
const MAX_EXPIRED = 50000;
function noteExpired(hash) {
  expiredKeys.delete(hash);
  expiredKeys.set(hash, Date.now());
  while (expiredKeys.size > MAX_EXPIRED) expiredKeys.delete(expiredKeys.keys().next().value);
}

/** Drops this account's keys that ran out (and stray issue times). True when something changed. */
function pruneTokens(p, key, at) {
  if (!p || typeof p !== 'object') return false;
  const list = Array.isArray(p.tokens) ? p.tokens : [];
  const keep = [], times = {};
  let changed = !Array.isArray(p.tokens) || (p.tokenAt !== undefined && (typeof p.tokenAt !== 'object' || p.tokenAt === null));
  for (const t of list) {
    if (typeof t === 'string' && tokenLive(p, t, at)) { keep.push(t); times[t] = tokenIssued(p, t); continue; }
    changed = true;
    if (typeof t === 'string') { noteExpired(t); if (byToken.get(t) === key) byToken.delete(t); }
  }
  const before = p.tokenAt && typeof p.tokenAt === 'object' ? Object.keys(p.tokenAt).length : 0;
  if (before !== keep.length) changed = true;
  if (changed) { p.tokens = keep; p.tokenAt = times; }
  return changed;
}

/** Every hour: keys that ran out leave the accounts (and the next save). */
setInterval(() => {
  if (!ready) return;
  const at = clock();
  let n = 0;
  for (const [key, p] of Object.entries(state.players)) if (pruneTokens(p, key, at)) n++;
  if (n) save(false);
}, 3600000).unref();

function count(data) { return data && data.players ? Object.keys(data.players).length : 0; }

// Round 109 (review H1): the account's own identity, separate from its (re-usable) username.
const UID_RE = /^u[0-9a-f]{24}$/;
function newUid() { return 'u' + crypto.randomBytes(12).toString('hex'); }
/** An account from before uids: the same uid on every server and every backup (username + when it was made). */
function legacyUid(key, p) { return 'u' + crypto.createHash('sha256').update('nmsd-legacy-uid|' + String(key).toLowerCase() + '|' + String((p && p.created) || '')).digest('hex').slice(0, 24); }
function uidOf(key, p) { return p && typeof p.uid === 'string' && UID_RE.test(p.uid) ? p.uid : legacyUid(key, p); }
/** Gives every account without one its uid (deterministic, so two servers agree). How many were given one. */
function backfillUids() {
  let n = 0;
  for (const [k, p] of Object.entries(state.players)) {
    if (p && p.uid !== uidOf(k, p)) { p.uid = uidOf(k, p); n++; }
  }
  return n;
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a.savedAt || '') || 0, tb = Date.parse(b.savedAt || '') || 0;
  if (ta !== tb) return ta > tb ? a : b;
  return count(a) >= count(b) ? a : b;
}

/** Marks the accounts changed (written to disk within 3 s). <paramref important> (an account made, changed or deleted - not just
 *  "last seen") also sends the off-site backup soon. A number instead: send the backup within that many ms (Round 75: a
 *  progress sync goes within 30 s - soon enough, without a GitHub commit for every player every 15 s). */
function save(important = true) {
  dirty = true;
  if (typeof important === 'number') vaultSoon(important);
  else if (important) vaultSoon(4000);
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

// Round 110 (sec110 H1): the backup's key no longer comes from ADMIN_KEY when anything better is set. Sealing uses the
// first of: BACKUP_KEY, BOARD_SECRET (16+ characters, mixed with its own label), and ONLY when neither is set the old
// ADMIN_KEY way (the admin home page shows a red warning then - a random key on this server's disk would be lost with
// the disk, and this backup exists for exactly that day). Opening a backup tries each of them, so a backup made the old
// way still opens after BOARD_SECRET / BACKUP_KEY are set (the next save re-seals it with the new key).
const vaultKeys = (() => {
  const cache = new Map();
  const derive = (label, secret, salt) => {
    const k = label + '|' + secret;
    if (!cache.has(k)) cache.set(k, crypto.scryptSync(secret, salt, 32));
    return cache.get(k);
  };
  return () => {
    const out = [];
    if ((process.env.BACKUP_KEY || '').length >= 8) out.push(derive('backup', process.env.BACKUP_KEY, 'nmsd-live-accounts-backup'));
    if ((process.env.BOARD_SECRET || '').length >= 16) out.push(derive('board', process.env.BOARD_SECRET, 'nmsd-live-accounts-backup|board'));
    if ((process.env.ADMIN_KEY || '').length >= 8) out.push(derive('legacy', process.env.ADMIN_KEY, 'nmsd-live-accounts-backup'));   // (old backups; and the last resort - warned)
    return out;
  };
})();
function vaultKey() { return vaultKeys()[0] || null; }
let resealNeeded = false;
/** Round 110: is the backup sealed with a key that isn't worked out from ADMIN_KEY? (the admin home's warning) */
function vaultKeyOk() { return (process.env.BACKUP_KEY || '').length >= 8 || (process.env.BOARD_SECRET || '').length >= 16; }

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
  const keys = vaultKeys();
  if (!keys.length) throw new Error('BACKUP_KEY / ADMIN_KEY not set');
  let last = null;
  for (const [i, key] of keys.entries()) {   // Round 110: the current key first, then the older ways (a backup made before BOARD_SECRET was set)
    try {
      resealNeeded = i > 0;   // (opened with an older key: saved again with the current one straight after start-up)
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
      d.setAuthTag(Buffer.from(box.tag, 'base64'));
      const json = Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
      return JSON.parse(json);
    } catch (err) { last = err; }
  }
  throw last || new Error('could not open the backup');
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
  state.deletedUids = state.deletedUids || {};   // Round 109: deleted accounts, forever (a backup never brings one back)
  state.version = 2;
  if (backfillUids()) dirty = true;               // Round 109: (saved by the next flush)
  index();
  ready = true;
  console.log(`players: ${count(state)} live accounts loaded${persistent() ? ' (disk)' : ''}${vault.on ? (vault.loaded ? ' (GitHub backup on)' : ' (GitHub backup NOT reachable)') : ''}`);
  if (vault.on && vault.loaded && (!remoteNewer || resealNeeded) && count(state) > 0) vaultSoon(3000);   // (the disk had something newer; Round 110: or re-seal with the new key)
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
  state.deletedUids = state.deletedUids || {};
  for (const [k, at] of Object.entries(data.deletedKeys || {})) {
    if (!state.deletedKeys[k] || state.deletedKeys[k] < at) state.deletedKeys[k] = at;
  }
  for (const [u, at] of Object.entries(data.deletedUids || {})) {   // Round 109
    if (UID_RE.test(u) && (!state.deletedUids[u] || state.deletedUids[u] < at)) state.deletedUids[u] = at;
  }
  let n = 0;
  for (const [key, p] of Object.entries(data.players)) {
    if (!p || typeof p !== 'object' || !p.username || !p.email) continue;
    const k = String(p.username).toLowerCase();
    if (k !== key.toLowerCase()) continue;
    // Round 109 (review H1): the same PERSON, not just the same username. A record whose uid (or, for a record from before
    // uids, whose created time - it's part of the worked-out uid) differs is someone else and is never mixed in.
    const uid = uidOf(k, p);
    if (state.deletedUids[uid]) continue;   // that person deleted their account: never back
    const stamp = Date.parse(p.updated || p.created || '') || 0;
    const created = Date.parse(p.created || '') || 0;
    const gone = Date.parse(state.deletedKeys[k] || '') || 0;
    if (gone && gone >= stamp && created <= gone) continue;   // deleted after this copy was made (an older record of the name)
    const mine = state.players[k];
    if (mine && uidOf(k, mine) !== uid) continue;   // a different person has this username here now
    if (mine && (Date.parse(mine.updated || mine.created || '') || 0) >= stamp) {
      // Round 75: my copy of the account stays, but their saved game may still be newer (synced on the other server).
      // Round 109: the newer saved game, with both copies' swag (a union - never lost) and the store link if mine has none
      // (the same person - checked just above).
      const both = pickProgress(mine.progress, p.progress);
      if (both && JSON.stringify(both) !== JSON.stringify(mine.progress)) { mine.progress = both; n++; }
      if (!mine.store && p.store) { mine.store = p.store; n++; }
      continue;
    }
    const other = byEmail.get(p.email);
    if (other && other !== k) continue;   // that email is someone else's here
    if (mine) {
      const both = pickProgress(mine.progress, p.progress);   // (the same person: the newer saved game - Round 109: + both swags)
      if (both) p.progress = both;
      if (!p.store && mine.store) p.store = mine.store;
    }
    p.uid = uid;
    state.players[k] = p;
    n++;
  }
  // Accounts deleted elsewhere (the other server) go here too - by uid; for an old tombstone by name, only the account
  // that existed then (one made after it was deleted is a new person).
  for (const [k, mine] of Object.entries(state.players)) {
    const u = uidOf(k, mine);
    const at = Date.parse(state.deletedKeys[k] || '') || 0;
    const madeAt = Date.parse(mine.created || '') || 0;
    if (state.deletedUids[u] || (at && madeAt <= at && (Date.parse(mine.updated || mine.created || '') || 0) <= at)) { delete state.players[k]; n++; }
  }
  index();
  if (n) { dirty = true; if (!quiet) vaultSoon(4000); }
  return n;
}

load();

// ------------------------------------------------------------------ helpers

function required() { return process.env.LIVE_SIGNUP_REQUIRED !== '0'; }

/** Round 109 (review M5): LIVE_ACCOUNT_GRACE_UNTIL=<ISO date> - until then older games without accounts may still play rooms. */
function graceUntil() {
  const t = Date.parse(String(process.env.LIVE_ACCOUNT_GRACE_UNTIL || '').trim());
  return Number.isFinite(t) ? t : 0;
}
function graceActive() { return graceUntil() > Date.now(); }
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

/** A new sign-in key for this account (Round 111: stamped now - it runs out SESSION_DAYS days from now). Returns the key;
 *  sessionOf(p, sha('pt|' + key)) says when it runs out. */
function newToken(p) {
  const key = p.username.toLowerCase();
  pruneTokens(p, key, clock());   // Round 111: (keys that ran out don't take a device's place)
  const token = crypto.randomBytes(24).toString('hex');
  const hash = sha('pt|' + token);
  p.tokens = (p.tokens || []).concat(hash);
  p.tokenAt = Object.assign({}, p.tokenAt || {}, { [hash]: clock() });
  while (p.tokens.length > MAX_TOKENS) {
    const old = p.tokens.shift();
    byToken.delete(old);
    delete p.tokenAt[old];
  }
  byToken.set(hash, key);
  return token;
}

/** The reply fields for a key just made: Round 111 - {token, expires, expiresIn, sessionDays}. */
function issued(p, token) { return Object.assign({ token }, sessionOf(p, sha('pt|' + token))); }

function dropTokens(p) {
  for (const t of p.tokens || []) byToken.delete(t);
  p.tokens = [];
  p.tokenAt = {};   // Round 111
}

/**
 * Round 111: a device key -> {p (the account, or null), hash, expired}. A key that ran out (SESSION_DAYS after it was made,
 * or from before Round 111 with no issue time) is pruned right here and answers {p: null, expired: true}.
 */
function checkWhy(token) {
  if (!ready || !token || typeof token !== 'string' || token.length < 20 || token.length > 100) return { p: null, expired: false };
  const hash = sha('pt|' + token);
  const key = byToken.get(hash);
  const p = key ? state.players[key] || null : null;
  if (p) {
    if (tokenLive(p, hash)) return { p, hash, expired: false };
    if (pruneTokens(p, key, clock())) save(false);
    noteExpired(hash);
    return { p: null, hash, expired: true };
  }
  return { p: null, hash, expired: expiredKeys.has(hash) };
}

/** The account a device token belongs to (or null - unknown, signed out, or Round 111: run out). */
function check(token) { return checkWhy(token).p; }

function bearerOf(req) {
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

function byBearer(req) { return check(bearerOf(req)); }

/** Round 111: the account behind "Authorization: Bearer", with why not ({p, hash, expired}). */
function byBearerWhy(req) { return checkWhy(bearerOf(req)); }

/** Round 111: the one 401 for a key that isn't good: {ok:false, signin:true, required, message} (+ expired:true when it ran out). */
function signinReply(why, extra) {
  const expired = !!(why && why.expired);
  return Object.assign({
    ok: false, signin: true, required: required(),
    message: expired ? `Your sign-in ran out (they last ${SESSION_DAYS} days) - please sign in again.` : 'Please sign in again.'
  }, expired ? { expired: true } : {}, extra || {});
}

const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < ms);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20000) trimHits(now);   // Round 111 (sec111): trimmed, never wiped - a flood of keys can't reset everyone's limits
  return list.length > max;
}

/** Round 111 (sec111): drops entries with no hit in the last 2 hours, then (still too many) the oldest-made keys. */
function trimHits(now) {
  for (const [k, list] of hits) if (!list.length || now - list[list.length - 1] > 7200000) hits.delete(k);
  if (hits.size <= 15000) return;
  let drop = hits.size - 15000;
  for (const k of hits.keys()) { if (drop-- <= 0) break; hits.delete(k); }
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

// ------------------------------------------------------------------ Round 75: the player's saved game (progress sync)

/** A stored saved game, or null if it isn't one ({stamp, social, progress, role} - the blobs are the game's own text). */
function cleanProgress(v) {
  if (!v || typeof v !== 'object') return null;
  const stamp = Number(v.stamp);
  if (!Number.isFinite(stamp) || stamp < 0) return null;
  return {
    stamp: Math.floor(stamp), social: typeof v.social === 'string' ? v.social : '', progress: typeof v.progress === 'string' ? v.progress : '', role: String(v.role || '').slice(0, MAX_ROLE),
    identity: typeof v.identity === 'string' && v.identity.length <= MAX_IDENTITY ? v.identity : '',   // Round 109
    swag: cleanSwag(v.swag),                                                                          // Round 109
    at: v.at || now()
  };
}

/** Round 109: swag unlock ids - short lower-case ids, no repeats, at most MAX_SWAG. Anything else is dropped. */
function cleanSwag(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const id of list) {
    if (out.length >= MAX_SWAG) break;
    if (typeof id === 'string' && SWAG_ID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Round 109: the union of two swag lists (an unlock is never lost, whichever copy wins). */
function unionSwag(a, b) { return cleanSwag(cleanSwag(a).concat(cleanSwag(b))); }

/** Round 109: two stored saved games -> the newer one (by stamp), carrying both swags and, if it has none, the other's identity. */
function pickProgress(a, b) {
  const pa = cleanProgress(a), pb = cleanProgress(b);
  if (!pa && !pb) return null;
  const win = !pb || (pa && pa.stamp >= pb.stamp) ? pa : pb;
  const lose = win === pa ? pb : pa;
  const out = Object.assign({}, win);
  if (lose) {
    out.swag = unionSwag(win.swag, lose.swag);
    if (!out.identity && lose.identity) out.identity = lose.identity;
  }
  return out;
}

function progressOf(p) {
  const s = cleanProgress(p && p.progress);
  return s ? { stamp: s.stamp, social: s.social, progress: s.progress, role: s.role, identity: s.identity, swag: s.swag }
    : { stamp: 0, social: '', progress: '', role: '', identity: '', swag: [] };
}

/** Round 109: what a game says it is ("Android 1.9.2", "Windows 1.9.2") - letters, numbers and a few signs, 48 at most. */
function cleanDevice(text) { return String(text || '').replace(/[^A-Za-z0-9 ._()\/+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 48); }

function noteDevice(p, device) {
  const d = cleanDevice(device);
  if (!d) return false;
  const changed = !p.device || p.device.name !== d;
  p.device = { name: d, at: now() };
  return changed;
}

/** Reads a JSON body up to <limit> bytes: the parsed object, {} if it isn't JSON, or null when it's too big (so the caller can say 413). */
function readJsonOrTooBig(req, limit) {
  return new Promise(resolve => {
    if (Number(req.headers['content-length']) > limit) { resolve(null); return; }
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > limit) { tooBig = true; body = ''; resolve(null); }
    });
    req.on('end', () => { if (tooBig) return; try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve(tooBig ? null : {}));
  });
}

function progressRoute(req, res) {
  const why = byBearerWhy(req);   // Round 111
  const p = why.p;
  if (!p) { json(res, 401, signinReply(why, { error: 'sign in' })); return; }
  if (req.method === 'GET') { json(res, 200, Object.assign({ ok: true }, progressOf(p))); return; }
  if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'use GET or POST' }); return; }
  const key = p.username.toLowerCase();
  readJsonOrTooBig(req, MAX_PROGRESS_BODY).then(body => {
    if (body === null) { json(res, 413, { ok: false, error: 'too big' }); setImmediate(() => req.destroy()); return; }
    const incoming = cleanProgress(body);
    if (!incoming || !incoming.stamp) { json(res, 400, { ok: false, error: 'stamp (ms since epoch), social, progress and role are needed' }); return; }
    if (typeof body.social !== 'string' || typeof body.progress !== 'string') { json(res, 400, { ok: false, error: 'social and progress must be strings' }); return; }
    if (String(body.role || '').length > MAX_ROLE) { json(res, 400, { ok: false, error: 'role is too long' }); return; }
    // Round 109: the character rides along (optional - an older game sends none, and then the stored one is kept).
    if (body.identity !== undefined && typeof body.identity !== 'string') { json(res, 400, { ok: false, error: 'identity must be a string' }); return; }
    if (typeof body.identity === 'string' && body.identity.length > MAX_IDENTITY) { json(res, 413, { ok: false, error: 'identity is too big' }); return; }
    if (body.swag !== undefined && !Array.isArray(body.swag)) { json(res, 400, { ok: false, error: 'swag must be a list' }); return; }
    const stored = cleanProgress(p.progress);
    const swag = unionSwag(stored ? stored.swag : [], body.swag);
    if (stored && stored.stamp > incoming.stamp) {
      // (the game decides) - Round 109: but a new swag unlock is never turned away: it joins the stored copy now.
      if (swag.length > stored.swag.length) { p.progress.swag = swag; save(30000); }
      json(res, 200, Object.assign({ ok: false, stale: true }, progressOf(p)));
      return;
    }
    if (peek('prog|' + key, 1, PROGRESS_GAP)) { json(res, 429, { ok: false, error: 'slow down' }); return; }
    limited('prog|' + key, 1, PROGRESS_GAP);
    // Round 109 (review L6): an empty identity never replaces a stored one (only a real character does).
    const identity = typeof body.identity === 'string' && body.identity.length > 0 ? body.identity : (stored ? stored.identity : '');
    p.progress = { stamp: incoming.stamp, social: incoming.social, progress: incoming.progress, role: incoming.role, identity, swag, at: now() };
    p.seen = now();
    save(30000);
    json(res, 200, { ok: true, stamp: incoming.stamp, swag });   // Round 109: + the account's swag (the union)
  }).catch(err => {
    console.error('players progress', err && err.message);
    json(res, 500, { ok: false, error: 'try again' });
  });
}

function ago(iso) {
  const ms = Date.now() - (Date.parse(iso || '') || 0);
  if (!iso || !Number.isFinite(ms)) return 'never';
  const m = Math.round(ms / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} days ago`;
}

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

  // Round 109: may a game play online without an account here? (LIVE_SIGNUP_REQUIRED=0 - the one switch.) Answered while
  // the accounts are still loading too, so a game never waits on it.
  if (route === '/players/status') {
    if (peek('status|' + ipOf(req), 60, 60000)) { json(res, 429, { ok: false, message: 'Slow down a little.' }); return true; }
    limited('status|' + ipOf(req), 60, 60000);
    json(res, 200, { ok: true, ready, required: required(), grace: required() && graceActive(), graceUntil: graceUntil() ? new Date(graceUntil()).toISOString() : '', sessionDays: SESSION_DAYS });   // Round 109: + the grace switch. Round 111: + how long a sign-in lasts
    return true;
  }

  if (!ready) { json(res, 503, { ok: false, message: 'The server is starting up - try again in a few seconds.' }); return true; }
  const ip = ipOf(req);

  if (route === '/players/progress') { progressRoute(req, res); return true; }   // Round 75 (its own body limit and GET + POST)

  if (route === '/players/ticket') { ticketRoute(req, res, ip); return true; }   // Round 109 (review L4)

  if (route === '/players/me') {
    const why = byBearerWhy(req);   // Round 111: a key that ran out -> 401 {signin, expired}
    const p = why.p;
    if (!p) { json(res, 401, signinReply(why)); return true; }
    p.seen = now();
    // Round 109: the game says what it is (the admin page's "last device"); a new device is worth an off-site backup soon.
    let device = '';
    try { device = new URL(req.url, 'http://x').searchParams.get('device') || ''; } catch { /* */ }
    save(noteDevice(p, device) ? 60000 : false);
    json(res, 200, Object.assign({ ok: true, username: p.username, email: p.email, uid: p.uid, termsOk: !!(p.terms && p.terms.version === TERMS_VERSION), terms: TERMS_VERSION, required: required(), store: p.store ? p.store.id : '' }, sessionOf(p, why.hash)));   // Round 111: + when this key runs out
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
      // Round 111 (sec111 L3): every sign-up try counts here too, so "is this email / username taken?" can't be asked endlessly.
      if (limited('uptry|' + ip, 60, 3600000)) return json(res, 429, { ok: false, message: 'Too many tries from this network - wait a while and try again.' });
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
      // Round 109: + an immutable uid - this person, not this username (store accounts, worlds and merges go by it).
      const p = { uid: newUid(), username, email, pass, created: now(), updated: now(), seen: now(), terms: { version: TERMS_VERSION, at: now(), age13: true }, tokens: [] };
      noteDevice(p, body.device);   // Round 109
      state.players[key] = p;
      byEmail.set(email, key);
      byUid.set(p.uid, key);   // Round 109
      const token = newToken(p);
      limited('up|' + ip, 20, 3600000);   // (only accounts actually made count)
      // Round 109 (review H1): the old tombstone for this name STAYS - it only ever matches the deleted person's records
      // (made before it), so nothing of theirs can come back into this new account from a backup.
      save();
      return json(res, 200, Object.assign({ ok: true, username, email, uid: p.uid }, issued(p, token)));   // Round 111: + expires, expiresIn, sessionDays
    }

    case '/players/signin': {
      if (peek('in|' + ip, 50, 3600000)) return json(res, 429, { ok: false, message: 'Too many wrong tries from this network - wait a while and try again.' });
      const login = String(body.login || body.username || '').trim();
      const key = login.includes('@') ? byEmail.get(cleanEmail(login)) : cleanUsername(login).toLowerCase();
      const p = key ? state.players[key] : null;
      // Round 111 (sec111 L3): the per-login limit goes by the words typed, whether or not that account exists - the same
      // reply either way, so it can't be used to find out which usernames / emails have accounts.
      const tried = login.toLowerCase().slice(0, 120);
      if (peek('acct|' + tried + '|' + ip, 10, 3600000)) return json(res, 429, { ok: false, message: `Too many wrong passwords - wait an hour, or email ${CONTACT} to reset it.` });
      const okPass = p ? await checkPassword(body.password, p.pass) : await checkPassword(body.password, 's1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');   // (same time either way)
      if (!p || !okPass) {
        limited('in|' + ip, 50, 3600000);   // (only wrong tries count)
        limited('acct|' + tried + '|' + ip, 10, 3600000);   // Round 111 (sec111 L3)
      }
      if (!p || !okPass) return json(res, 401, { ok: false, field: 'password', message: `That username / email and password don't match. Forgot your password? Email ${CONTACT} and we'll reset it.` });
      const token = newToken(p);
      p.seen = now();
      save(noteDevice(p, body.device) ? 60000 : false);   // Round 109: + the last device
      return json(res, 200, Object.assign({ ok: true, username: p.username, email: p.email, uid: p.uid, termsOk: !!(p.terms && p.terms.version === TERMS_VERSION) }, issued(p, token)));   // Round 111: + expires, expiresIn, sessionDays
    }

    case '/players/password': {
      const why = byBearerWhy(req);   // Round 111
      const p = why.p;
      if (!p) return json(res, 401, signinReply(why));
      if (limited('pw|' + p.username.toLowerCase(), 10, 3600000)) return json(res, 429, { ok: false, message: 'Too many tries - wait a while.' });
      if (!(await checkPassword(body.password, p.pass))) return json(res, 401, { ok: false, field: 'password', message: "Your current password isn't right." });
      const bad = passwordProblem(body.newPassword, p.username);
      if (bad) return json(res, 400, { ok: false, field: 'newPassword', message: bad });
      p.pass = await hashPassword(body.newPassword);
      p.updated = now();
      dropTokens(p);   // signs out every other device
      const token = newToken(p);
      save();
      return json(res, 200, Object.assign({ ok: true }, issued(p, token)));   // Round 111: a fresh SESSION_DAYS from now
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
      const why = byBearerWhy(req);   // Round 111
      const p = why.p;
      if (!p) return json(res, 401, signinReply(why));
      p.terms = { version: TERMS_VERSION, at: now(), age13: true };
      p.updated = now();
      save();
      return json(res, 200, { ok: true });
    }

    case '/players/store-link': return storeLink(req, res, body, ip);   // Round 109

    case '/players/delete': {
      const why = byBearerWhy(req);   // Round 111
      const p = why.p;
      if (!p) return json(res, 401, signinReply(why));
      if (!(await checkPassword(body.password, p.pass))) return json(res, 401, { ok: false, field: 'password', message: "That password isn't right." });
      removeAccount(p.username.toLowerCase());
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { ok: false });
}

// ------------------------------------------------------------------ Round 109: the Moon Shards store account that belongs to a live account
//
// Moon Shards and premium items live on a STORE account (store.js), which used to be a thing of its own (a display name and
// a recovery code). Now each live account has at most ONE store account, linked here (p.store) and on the store account
// itself (its "live" owner), and the game asks for it at every sign-in - so the shards follow the username to any device
// with nothing to type. The rules are in store.js linkLive; in short: link a device's store account only when it belongs
// to nobody yet; a store account linked to someone else is never handed to this account; two different store accounts are
// NEVER merged here (a human - the admin - can move shards if one person really has two).
const MAX_STORE_BODY = 1024;

function storeLink(req, res, body, ip) {
  const why = byBearerWhy(req);   // Round 111
  const p = why.p;
  if (!p) return json(res, 401, signinReply(why));
  // Round 109 (review L5): per account AND per network, like /store/account/create - and making a NEW store account this
  // way counts against the very same limit as making one in the Store (5 an hour from one network).
  if (peek('slink|' + p.uid, 10, 3600000) || peek('slinkip|' + ip, 30, 3600000)) return json(res, 429, { ok: false, message: 'Slow down a little.' });
  limited('slink|' + p.uid, 10, 3600000);
  limited('slinkip|' + ip, 30, 3600000);
  const device = typeof body.store === 'string' && body.store.length <= MAX_STORE_BODY ? body.store : '';
  let out;
  try {
    out = S().linkLive(p.uid, p.store ? p.store.id : '', device, { create: body.create === true, adopt: body.adopt === true, name: p.username, email: p.email, ip });
  } catch (err) {
    console.error('players store-link', err && err.message);
    return json(res, 500, { ok: false, message: 'Something went wrong - try again in a minute.' });
  }
  if (!out || !out.ok) return json(res, out && out.status === 429 ? 429 : 200, Object.assign({ ok: false }, out || {}));
  let changed = false;
  const was = p.store ? p.store.id : '';
  if (out.store && out.store !== was) { p.store = { id: out.store, at: now() }; changed = true; }
  else if (!out.store && was && out.unlinked) { delete p.store; changed = true; }
  // (for the admin: other store accounts seen with this person - kept apart, never merged. Round 109 (review M3): + the one
  // let go in a swap, so it can always be found again.)
  for (const other of [out.parked && out.parked.id, out.replaced]) {
    if (!other) continue;
    const others = Array.isArray(p.storeOthers) ? p.storeOthers.filter(o => o && o.id !== other) : [];
    others.unshift({ id: other, at: now() });
    p.storeOthers = others.slice(0, MAX_STORE_OTHERS);
    changed = true;
  }
  if (changed) { p.updated = now(); save(); }
  const reply = Object.assign({}, out);
  delete reply.status;
  return json(res, 200, reply);
}

// ------------------------------------------------------------------ Round 109 (review L4): single-use connection tickets
//
// The game used to put its long-lived sign-in key in the WebSocket address (?pt=), where proxies and logs can see it. Now it
// asks for a TICKET first: good for 60 seconds (LIVE_TICKET_SECONDS), for this account only, used once. A ticket is SIGNED
// (HMAC). Round 110 (sec110 H1): its key is NEVER worked out from ADMIN_KEY (a player could test ADMIN_KEY guesses offline
// against their own ticket) - it's TICKET_HMAC_SECRET, else BOARD_SECRET, else a random key kept in server-secrets.json on the
// disk (secrets.js), so any copy of this server with the same setting accepts it - e.g. the new one during a redeploy overlap. Each copy remembers the tickets
// it has seen used. A ticket that's unknown, used or out of date is refused as "ticket: ..." (the game fetches a new one
// and tries again - it never signs anyone out over it).
const TICKET_MS = Math.max(1000, Math.min(600000, (Number(process.env.LIVE_TICKET_SECONDS) || 60) * 1000));
const TICKET_RE = /^tk1-(u[0-9a-f]{24})-([0-9a-z]{1,12})-([0-9a-f]{16})-([0-9a-f]{32})$/;
const usedTickets = new Map();   // nonce -> expiry (used here)
const MAX_USED = 50000;
const ticketKey = require('./secrets').secretFor('connection-tickets', 'TICKET_HMAC_SECRET').key;   // Round 110 (sec110 H1)

function ticketSig(uid, exp, nonce) { return crypto.createHmac('sha256', ticketKey).update('tk1|' + uid + '|' + exp + '|' + nonce).digest('hex').slice(0, 32); }

/** It has the shape of a connection ticket (whether or not it's still good). */
function isTicket(text) { return typeof text === 'string' && TICKET_RE.test(text); }

function ticketRoute(req, res, ip) {
  if (req.method !== 'POST') { json(res, 405, { ok: false }); return; }
  const why = byBearerWhy(req);   // Round 111: a key that ran out gets no ticket (401 {signin, expired})
  const p = why.p;
  if (!p) { json(res, 401, signinReply(why)); return; }
  if (peek('ticket|' + p.uid, 60, 600000) || peek('ticketip|' + ip, 200, 600000)) { json(res, 429, { ok: false, message: 'Slow down a little.' }); return; }
  limited('ticket|' + p.uid, 60, 600000);
  limited('ticketip|' + ip, 200, 600000);
  const exp = (Date.now() + TICKET_MS).toString(36);
  const nonce = crypto.randomBytes(8).toString('hex');
  const ticket = `tk1-${p.uid}-${exp}-${nonce}-${ticketSig(p.uid, exp, nonce)}`;
  json(res, 200, { ok: true, ticket, expires: Date.now() + TICKET_MS });
}

/** A connection ticket -> its account (used up here), or null (bad, used, expired, or the account is gone). */
function redeemTicket(ticket) {
  if (!ready || !isTicket(ticket)) return null;
  const [, uid, exp, nonce, sig] = TICKET_RE.exec(ticket);
  const want = Buffer.from(ticketSig(uid, exp, nonce)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const until = parseInt(exp, 36);
  const t = Date.now();
  if (!Number.isFinite(until) || until < t || until > t + TICKET_MS + 5000) return null;
  if (usedTickets.has(nonce)) return null;
  if (usedTickets.size >= MAX_USED) for (const [n, e] of usedTickets) if (e < t) usedTickets.delete(n);
  usedTickets.set(nonce, until);
  const key = byUid.get(uid);
  const p = key ? state.players[key] : null;
  return p && p.uid === uid && !(state.deletedUids && state.deletedUids[uid]) ? p : null;
}

setInterval(() => { const t = Date.now(); for (const [n, e] of usedTickets) if (e < t) usedTickets.delete(n); }, 60000).unref();

function removeAccount(key) {
  const p = state.players[key];
  if (!p) return false;
  const uid = uidOf(key, p);
  // Round 109: the store account stays (it holds purchases) - it just isn't this live account's any more.
  if (p.store && p.store.id) { try { S().unlinkLive(uid, p.store.id); } catch (err) { console.error('players unlink', err && err.message); } }
  // Round 109 (review M1): their saved worlds are deleted with the account ("removed from our server straight away").
  try { require('./worlds').removeOwnedBy(uid); } catch (err) { console.error('players worlds', err && err.message); }
  dropTokens(p);
  byUid.delete(uid);   // (its tickets stop working at once)
  if (p.email && byEmail.get(p.email) === key) byEmail.delete(p.email);
  delete state.players[key];
  state.deletedKeys = state.deletedKeys || {};
  state.deletedKeys[key] = now();   // (so no backup ever brings it back)
  state.deletedUids = state.deletedUids || {};
  state.deletedUids[uid] = now();   // Round 109: this person, forever (a new sign-up with the same name is someone else)
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
    const list = term ? all.filter(p => p.username.toLowerCase().includes(term) || String(p.email).includes(term) || (p.store && String(p.store.id).toLowerCase() === term)) : all;   // Round 109: + a store account id
    const hidden = require('./adminauth').hidden(key);   // Round 110: the session's CSRF token (key = that token now)
    const rows = list.slice(0, 500).map(p => {
      const k = esc(p.username.toLowerCase());
      return `<tr><td><b>${esc(p.username)}</b><br><span class="small">${esc(p.email)}</span></td>
<td class="small">joined ${esc(String(p.created).slice(0, 10))}<br>last seen ${esc(String(p.seen || '').slice(0, 10))}<br>terms ${esc(p.terms ? p.terms.version : 'not yet')}<br>${p.progress && p.progress.stamp ? `synced ${esc(ago(p.progress.at))}${p.progress.role ? ' &middot; ' + esc(p.progress.role) : ''}` : 'no saved game yet'}</td>
<td class="small">${storeCell(p, esc)}<br>${p.device && p.device.name ? `last device: ${esc(p.device.name)} &middot; ${esc(ago(p.device.at))}` : 'last device: not known yet'}</td>
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
<form method="post" action="/admin/players">${hidden}<input name="q" value="${esc(q || '')}" placeholder="search username, email or store id"> <button type="submit">Search</button></form>
<form method="post" action="/admin/players" style="display:inline">${hidden}<input type="hidden" name="action" value="csv"><button type="submit">Download usernames + emails (CSV)</button></form>
<form method="post" action="/admin/players" style="display:inline">${hidden}<input type="hidden" name="action" value="backup"><button type="submit">Download full backup</button></form>
<details><summary>Restore from a full backup</summary><form method="post" action="/admin/players" onsubmit="return confirm('Add the accounts from this backup? (Nothing here is removed.)')">${hidden}<input type="hidden" name="action" value="restore"><textarea name="data" rows="6" style="width:100%" placeholder="Paste the whole backup file here"></textarea><button type="submit">Restore (merge)</button></form></details>
<form method="post" action="/admin">${hidden}<button type="submit">Back to admin</button></form>
<table>${rows || '<tr><td class="small">Nobody yet.</td></tr>'}</table>
${list.length > 500 ? `<p class="small">Showing the newest 500 of ${list.length} - search, or download the CSV for everyone.</p>` : ''}`);
  };

  // Round 110: the admin session (adminauth.js) - sign-in, wrong-key limits, CSRF and the old key form all live there.
  require('./adminauth').guard(req, res, { path: '/admin/players', limit: 4 * 1024 * 1024 }).then(async g => {
    if (!g) return;
    const form = g.form, key = g.token;

    if (!ready) { pay.page(res, 503, 'Live accounts', '<h1>Live accounts</h1><p>The server is still loading the accounts - refresh in a few seconds.</p>'); return; }
    const action = form.get('action') || '';
    const stamp = new Date().toISOString().slice(0, 10);

    if (action === 'csv') {
      // Round 109 (review L3): a cell a spreadsheet could read as a formula (= + - @, tab, CR) gets a ' in front.
      const q = (s) => { let v = String(s || ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
      // Round 109: + the linked store account and the last device
      const lines = ['username,email,created,last_seen,terms_version,terms_agreed,last_sync,role,store_account,last_device,last_device_at'].concat(Object.values(state.players).map(p =>
        [p.username, p.email, p.created, p.seen, p.terms && p.terms.version, p.terms && p.terms.at, p.progress && p.progress.stamp ? p.progress.at : '', p.progress ? p.progress.role : '',
          p.store ? p.store.id : '', p.device ? p.device.name : '', p.device ? p.device.at : ''].map(q).join(',')));
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

/** Round 109: the admin row's store cell - the linked Moon Shards account (its balance), and any others seen with it. */
function storeCell(p, esc) {
  let line = 'store: none linked';
  if (p.store && p.store.id) {
    let sum = null;
    try { sum = S().accountSummary(p.store.id); } catch { /* */ }
    line = sum ? `store: <b>${esc(sum.id)}</b> &middot; ${esc(String(sum.shards))} shards &middot; ${esc(String(sum.owned))} items${sum.live && sum.live !== uidOf(p.username.toLowerCase(), p) ? ' <span class="off">(linked to another account there!)</span>' : ''}`
      : `store: ${esc(p.store.id)} <span class="off">(not on this server)</span>`;
  }
  const others = Array.isArray(p.storeOthers) ? p.storeOthers.filter(o => o && o.id && (!p.store || o.id !== p.store.id)) : [];
  if (others.length) line += `<br>also seen: ${others.map(o => esc(o.id)).join(', ')} (kept apart - never merged)`;
  return line;
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
  <p>To play live you make a live account: a <strong>username</strong> (shown to other players), your <strong>email address</strong> (never shown to other players; used to identify your account, to help you if you lose access, and for important notices about the Game or these policies) and a <strong>password</strong> (we only keep a scrambled one-way version - nobody, including us, can read it). We also keep when you made the account, when you last played, the kind of device you last played on (just the platform and the game's version, like "Android 1.4"), your character and what you've unlocked (so they follow you to any device), and that you agreed to the Terms of Service and confirmed you're 13 or older. Your device keeps a sign-in key so you don't have to type your password each time. We keep backups of accounts (encrypted where they're stored off our server) so an update never loses them. You can delete your account in the game (Settings &gt; Game &gt; Live account) or by emailing us; it's removed from our server straight away; older encrypted backup copies are kept only to protect everyone's accounts, are never used to bring a deleted account back, and are replaced over time.</p>
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

/**
 * Round 109: the one HTTP gate for online writes (worlds.js, leaderboards.js): null = go on, else [status, reply].
 * The game's sign-in comes as "Authorization: Bearer <token>" or "pt" in the JSON body. No sign-in at all (neither): a game
 * from before Round 109 -> 426 "update". An unknown key -> 401 {signin:true}. LIVE_SIGNUP_REQUIRED=0: always go on.
 * ok.account: the live account's key (lower-case username; '' when accounts are off).
 */
function gate(req, body, what) {
  if (!required()) return { ok: true, account: '' };
  if (!ready) return { ok: false, status: 503, reply: { ok: false, message: 'The server is just starting up - try again in a few seconds.' } };
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const hasPt = !!body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'pt');
  if (!bearer && !hasPt) {
    if (graceActive()) return { ok: true, account: '', grace: true };   // Round 109 (review M5): an older game, in the grace period
    return { ok: false, status: 426, reply: { ok: false, update: true, message: 'Update New Moon to play online - this version of the game is too old for live accounts.' } };
  }
  const why = checkWhy(bearer || String(body.pt || ''));   // Round 111: + expired
  const p = why.p;
  if (!p) return { ok: false, status: 401, reply: Object.assign({ ok: false, signin: true, required: true, message: why.expired ? `Your sign-in ran out (they last ${SESSION_DAYS} days) - sign in again to ${what || 'play online'}.` : `Sign in to your live account to ${what || 'play online'}.` }, why.expired ? { expired: true } : {}) };
  return { ok: true, account: p.uid, username: p.username.toLowerCase() };   // Round 109: the account's uid (worlds go by it)
}

module.exports = { handle, check, checkWhy, required, isReady, gate, redeemTicket, isTicket, graceActive, uidOf, flush, final, adminSection, TERMS_VERSION, SESSION_DAYS, vaultKeyOk, vaultOn: () => vault.on, _test: { state: () => state, cleanUsername, validEmail, passwordProblem, seal, unseal, merge, cleanSwag, unionSwag, pickProgress, cleanDevice, legacyUid, pruneTokens, tokenLive, SESSION_MS } };
