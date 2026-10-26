// New Moon, Same Dark - the Moon Shards store, player accounts and the curated vendor market (Round 55).
//
// WHAT IT IS (modelled on how GTA Online keeps things controlled):
//  - ONE premium currency, "Moon Shards", sold in packs through Stripe Checkout on the web/PC game.
//    Festival tokens earned by playing stay completely separate (they live in the game's own save);
//    shards only ever come from a real payment confirmed by Stripe, or from you (admin "grant").
//  - Lightweight accounts so purchases follow the player: a display name + email makes an account;
//    the server hands back an account id + a secret device token (the game keeps it) and a recovery
//    code shown ONCE, which links another device. Balances and owned items live HERE only - the game
//    just shows what the server says (and the last known numbers, read-only, when offline).
//  - Premium outfit pieces (the platform's own) and vendor designs are bought with shards here.
//  - Vendors are curated: they apply on /vendor, YOU approve them on /admin, they pay for a season
//    plan (3, 6 or 12 design slots), send designs, and every design waits in your review queue.
//    Nothing appears in the game until you approve it. Players can report a design from the game;
//    reports land on /admin, where you can unpublish a design or ban a vendor.
//  - Each vendor-design sale records the vendor's revenue share in the ledger; /admin shows what you
//    owe each vendor and a "mark as paid" button once you've paid them (by bank transfer, PayPal...).
//
// PHONE APPS AND STEAM: Apple, Google and Steam require their own payments for digital goods sold inside
// their builds. Round 69: those builds buy through Steam MicroTxn / Google Play / the App Store instead,
// checked here (storeverify.js) and granted once - see "Round 69: in-app purchases" below and
// STORE_PURCHASES_SETUP.txt. Stripe stays for the website/PC download only. Never add a Stripe link to
// a Steam, iPhone or Android build.
//
// FILES (in STORE_DATA_DIR - a persistent disk; a free Render server FORGETS files on every restart):
//   store-data.json      accounts, balances, owned items, orders, vendors, designs, reports
//                        (written whole to a temp file then renamed, so it's never half-written)
//   store-data.bak.json  the previous version (read if the main file is ever damaged)
//   store-ledger.jsonl   every shard movement, one line each, never rewritten (your audit trail)
//
// SETTINGS (Render > your service > Environment):
//   STORE_DATA_DIR         the persistent disk's folder (e.g. /var/data) - the store stays shut without it
//   STRIPE_SECRET_KEY      as for tickets
//   STRIPE_WEBHOOK_SECRET  whsec_... from Stripe > Developers > Webhooks (your /store/webhook endpoint)
//   PUBLIC_URL             your server's https:// address
//   ADMIN_KEY              your admin password (as before)
//   VENDOR_SHARE_PERCENT   optional, default 50 - the vendor's share of each design sale
//   STORE_ALLOW_LOCAL_FILES=1  only for testing on your own computer (keeps files next to this one)
// And in vendors.json:  "features": { ..., "store": true, "vendorPortal": true }
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const pay = () => require('./payments');   // (lazy: payments.js requires this file too)
const verify = require('./storeverify');      // Round 69: Steam / Google Play / App Store purchase checks

// ============================================================================ what's for sale
// Change prices here (cents are US cents). Packs: the bigger ones carry bonus shards.
const CURRENCY = 'Moon Shards';
const PACKS = [
  { id: 'handful', label: 'A handful of shards', shards: 500, bonus: 0, cents: 499 },
  { id: 'pouch', label: 'A pouch of shards', shards: 1000, bonus: 100, cents: 999 },
  { id: 'jar', label: 'A jar of shards', shards: 2000, bonus: 400, cents: 1999 },
  { id: 'crate', label: 'A crate of shards', shards: 5000, bonus: 1500, cents: 4999 }
];

// Round 109: the career's bonus site "Neon Speedway" - EARNED in the career, or unlocked early with shards. Its price in ONE
// place: 500 shards = the "handful" pack's $4.99 (packs are 100 shards a dollar before bonuses; SHARD_CENTS below says the
// same). Change this number to change the price everywhere (the game reads it from /store/catalog).
// The id must match Scripts/Net/PremiumItems.cs (SiteSpeedway).
const SITE_SPEEDWAY_ID = 'site_speedway';
const SITE_SPEEDWAY_SHARDS = 500;

// The platform's own premium pieces. The ids must match Scripts/Social/OutfitLook.cs (Premium = true).
// Round 109: + the Neon Speedway site (not a piece to wear - Scripts/Net/PremiumItems.cs).
const PREMIUM = [
  { id: SITE_SPEEDWAY_ID, name: 'Neon Speedway (bonus career site)', shards: SITE_SPEEDWAY_SHARDS },
  { id: 'moonjacket', name: 'Moonlight bomber', shards: 600 },
  { id: 'booth-dome', name: 'Geodesic dome booth', shards: 450 },     // Round 57: player booths
  { id: 'booth-moonkit', name: 'Moonlight booth colours', shards: 350 },
  { id: 'starpants', name: 'Starfield pants', shards: 450 },
  { id: 'mooncrown', name: 'New Moon crown', shards: 700 },
  { id: 'astrohelm', name: 'Astro helmet', shards: 900 },
  { id: 'eclipse', name: 'Eclipse visor', shards: 500 },
  { id: 'mothwings', name: 'Luna moth wings', shards: 1000 },
  { id: 'orbit', name: 'Orbiting moons', shards: 800 },
  { id: 'aura', name: 'Glow aura', shards: 650 },
  { id: 'pat-galaxy', name: 'Galaxy print', shards: 400 },
  { id: 'pat-aurora', name: 'Aurora print', shards: 400 }
];

// Vendor season plans: how many designs a vendor can have live or waiting at once.
const PLANS = [
  { id: 'starter', name: 'Starter stall', slots: 3, cents: 4900 },
  { id: 'market', name: 'Market stall', slots: 6, cents: 8900 },
  { id: 'flagship', name: 'Flagship booth', slots: 12, cents: 14900 }
];

const DESIGN_PRICES = [200, 300, 400, 600, 800];   // shards a vendor can ask for one design
const SHARD_CENTS = 1;                              // what one shard is worth when paying vendors (500 for $4.99)
const KINDS = ['tee', 'hoodie', 'cap', 'bucket', 'bandana', 'glasses', 'pendant', 'bracelet', 'backpack', 'totem'];
const KIND_NAMES = { tee: 'T-shirt', hoodie: 'Hoodie', cap: 'Cap', bucket: 'Bucket hat', bandana: 'Bandana', glasses: 'Sunglasses', pendant: 'Pendant', bracelet: 'Bracelet', backpack: 'Backpack', totem: 'Totem' };
const PATTERNS = ['plain', 'tiedye', 'stripes', 'spiral', 'checker', 'dots', 'split'];
const STUDIO_TO_VENDOR_PATTERN = ['plain', 'stripes', 'tiedye', 'checker', 'dots', 'spiral', 'dots', 'tiedye'];   // Outfit Studio patterns (look codes)

const MAX_ACCOUNTS = 200000;
const MAX_DEVICES = 5;           // devices signed in to one account at once (the oldest drops off)
const MAX_OWNED = 600;
const MAX_VENDORS = 500;
const MAX_PENDING_DESIGNS = 300;
const MAX_REPORTS = 600;
const MAX_EVENTS = 2000;         // Stripe event ids remembered (so a resent event never pays twice)
const DAY = 86400000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ============================================================================ files
const LOCAL_OK = process.env.STORE_ALLOW_LOCAL_FILES === '1';
const DATA_DIR = process.env.STORE_DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'store-data.json');
const BACKUP_FILE = path.join(DATA_DIR, 'store-data.bak.json');
const LEDGER_FILE = path.join(DATA_DIR, 'store-ledger.jsonl');

function blank() {
  // Round 58: + settings (the admin's Big Night pause switch). Passes live on each account (account.passes).
  // Round 69: + iap - every Steam / Google Play / App Store purchase, by "steam:<orderid>", "google:<token hash>",
  // "apple:<transaction id>" (so each one is granted exactly once, even if the game asks again).
  return { version: 1, accounts: {}, recovery: {}, orders: {}, events: [], vendors: {}, designs: {}, reports: [], payouts: [], settings: {}, iap: {} };
}

let state = blank();
let broken = '';     // set if the saved files couldn't be read: the store stays shut rather than start from zero
let recovered = '';  // set if the main file was damaged and the backup (one change older) was used

function load() {
  let problem = '';
  for (const file of [DATA_FILE, BACKUP_FILE]) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      problem = 'Could not read ' + path.basename(file) + ': ' + (err && err.message);
      continue;
    }
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || !data.accounts) throw new Error('not a store file');
      state = Object.assign(blank(), data);
      if (problem || file === BACKUP_FILE) {
        recovered = 'The main store file was missing or damaged, so the backup was loaded (it can be one change behind - check the newest lines of store-ledger.jsonl).';
        console.error('store: ' + recovered);
      }
      return;
    } catch (err) {
      console.error('store: ' + path.basename(file) + ' is damaged:', err && err.message);
      problem = path.basename(file) + ' is damaged (' + (err && err.message) + ')';
    }
  }
  // Nothing loaded. With no files at all, this is simply a new store; otherwise stay shut (never start from zero).
  if (problem) broken = problem + '. The store is shut until the file is fixed or restored from a backup.';
}
load();

/** Writes everything: a temp file, fsync, keep the old one as the backup, then rename into place. */
function saveNow() {
  const text = JSON.stringify(state);
  const tmp = DATA_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.copyFileSync(DATA_FILE, BACKUP_FILE); } catch { /* first save */ }
  fs.renameSync(tmp, DATA_FILE);
}

/**
 * Runs a change and saves it. If the save fails, the change is undone (nothing half-happens) and
 * the error is thrown, so the caller answers "try again" (and Stripe retries its webhook).
 * Ledger lines are written only after the save succeeded.
 */
function transact(change) {
  if (broken) throw new Error('store file problem');
  const before = JSON.stringify(state);
  const ledger = [];
  let result;
  try {
    result = change(entry => ledger.push(Object.assign({ at: new Date().toISOString() }, entry)));
    saveNow();
  } catch (err) {
    state = JSON.parse(before);
    throw err;
  }
  if (ledger.length) {
    try { fs.appendFileSync(LEDGER_FILE, ledger.map(l => JSON.stringify(l)).join('\n') + '\n'); } catch (err) { console.error('store ledger', err && err.message); }
  }
  return result;
}

// ============================================================================ small helpers
function features() {
  try { return pay().features(); } catch { return {}; }
}

/** Where the store's files are kept safely (a persistent disk), or allowed locally for testing. */
function persistent() { return !!process.env.STORE_DATA_DIR || LOCAL_OK; }

function isOpen() { return !!features().store && !broken && persistent(); }

function stripe() { return pay().stripe(); }

function checkoutReady() {
  return isOpen() && !!stripe() && !!pay().baseUrl() && (process.env.STRIPE_WEBHOOK_SECRET || '').length > 8;
}

function sharePercent() {
  const n = Number(process.env.VENDOR_SHARE_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 90 ? n : 50;
}

function toCode(bytes, length) {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function randomCode(length) { return toCode(crypto.randomBytes(length), length); }

function sha(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Round 55 review: ids in requests come from players/vendors - look up the store's OWN entries only
// ("constructor", "toString"... would otherwise return Object's built-ins, e.g. a report filed on nothing).
function own(map, key) {
  return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function flatCode(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function ipOf(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket && req.socket.remoteAddress) || '';
}

// ---- rate limits (in memory; a restart forgets them, which is fine)
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now);
  hits.set(key, list);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, list] of hits) if (!list.some(t => now - t < DAY)) hits.delete(key);
}, 600000).unref();

// ---- the word filter (a first line only: every design is still looked at by you before it goes live)
const BAD_EXACT = new Set(['ass', 'arse', 'tits', 'dick', 'cock', 'cum', 'sex', 'sexy', 'hoe', 'fag', 'kys', 'rape', 'rapist', 'meth', 'coke', 'crack',
  'lsd', 'dmt', 'ket', 'pcp', 'weed', 'molly', 'blunt', 'bong', 'acid', 'shrooms', '420', 'nsfw', 'xxx', 'kill', 'die']);
const BAD_STEMS = ['fuck', 'shit', 'cunt', 'bitch', 'whore', 'slut', 'nigg', 'fagg', 'retard', 'nazi', 'hitler', 'pussy', 'porn', 'penis', 'vagina',
  'cocaine', 'heroin', 'ketamin', 'fentanyl', 'xanax', 'mdma', 'ecstasy', 'marijuana', 'cannabis', 'masturb', 'blowjob', 'dildo', 'jizz', 'wank',
  'twat', 'bollock', 'terroris', 'suicide'];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

function rude(text) {
  const lower = String(text || '').toLowerCase().replace(/[013457@$!]/g, c => LEET[c]);
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const joined = words.join('');
  for (const w of words) {
    if (BAD_EXACT.has(w) || BAD_EXACT.has(w.replace(/(.)\1+/g, '$1'))) return true;
    if (BAD_STEMS.some(s => w.includes(s))) return true;
  }
  if (String(text).includes('420')) return true;
  // Spaced out ("f u c k") or split up ("bit ches"): look at the words run together too.
  const spaced = words.filter(w => w.length === 1).length >= 3;
  return BAD_STEMS.some(s => (spaced || s.length >= 5) && joined.includes(s));
}

function cleanName(text, max) {
  return String(text || '').replace(/[^A-Za-z0-9 '._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanPrint(text) {
  return String(text || '').replace(/[^A-Za-z0-9 !?&+#'@-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
}

function cleanColour(hex, fallback) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  return m ? '#' + m[1].toLowerCase() : fallback;
}

function httpsLink(url) {
  const u = String(url || '').trim();
  return /^https:\/\/[^\s<>"']{3,380}$/.test(u) ? u : '';
}

function money(cents) { return '$' + (cents / 100).toFixed(2); }

// ---- seasons: a plan runs to the end of the current quarter (or the next, if this one ends in < 3 weeks)
function quarterEnd(ms) {
  const d = new Date(ms);
  const q = Math.floor(d.getUTCMonth() / 3);
  return Date.UTC(d.getUTCFullYear(), q * 3 + 3, 1) - 1;
}

function planEndFrom(start) {
  let end = quarterEnd(start);
  if (end - start < 21 * DAY) end = quarterEnd(end + 1);
  return end;
}

function seasonName(ms) {
  const d = new Date(ms);
  return ['Winter', 'Spring', 'Summer', 'Autumn'][Math.floor(d.getUTCMonth() / 3)] + ' ' + d.getUTCFullYear();
}

// ============================================================================ accounts
function publicAccount(a) {
  // Round 58: + the account's Big Night passes (how many are waiting, and the one running now).
  return { id: a.id, name: a.name, shards: a.shards, owned: a.owned.slice(), banned: !!a.banned, bigNight: bigNightSummary(a) };
}

function newToken(account) {
  const token = crypto.randomBytes(32).toString('hex');
  account.tokens.push({ h: sha('tok|' + token), at: Date.now() });
  while (account.tokens.length > MAX_DEVICES) account.tokens.shift();
  return token;
}

function newRecovery(account) {
  if (account.recoveryHash) delete state.recovery[account.recoveryHash];
  const code = randomCode(16);
  account.recoveryHash = sha('rec|' + code);
  state.recovery[account.recoveryHash] = account.id;
  return code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8, 12) + '-' + code.slice(12, 16);
}

/** The account a request speaks for ("Authorization: Bearer <id>.<token>"), or null. */
function authed(req) {
  const m = /^Bearer (A[A-Z2-9]{12})\.([a-f0-9]{64})$/.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const account = state.accounts[m[1]];
  if (!account) return null;
  const want = sha('tok|' + m[2]);
  return account.tokens.some(t => same(t.h, want)) ? account : null;
}

// ============================================================================ Round 109: one store account per LIVE account
// (Round 109 review: keyed on the live account's immutable uid - the store field "liveUid" - never on its username)
//
// The owner: Moon Shards and premium items should follow the player's live account (players.js - username, email, password)
// with nothing else to type. Each store account may carry "live": the live account (its lower-case username) it belongs to;
// players.js keeps the other half (p.store). linkLive runs at every sign-in (and once per launch) with what this device has:
//
//   the live account has NO store account yet:
//     - the device's store account belongs to nobody     -> it becomes this live account's (LINKED)
//     - the device's store account belongs to SOMEONE ELSE (another live account signed in on this device before)
//                                                         -> never handed over: "foreign" (the game puts it aside on the
//                                                            device - its owner gets it back by signing in), and a new
//                                                            empty one is made for this account if asked (create)
//     - the device has none                               -> a new one is made (create), named after the username
//   the live account HAS one:
//     - the device has the same one                       -> nothing to do
//     - the device has none (a new phone)                 -> a sign-in for it is handed to this device (token)
//     - the device has a DIFFERENT one, belonging to nobody:
//         * the account's own one is EMPTY (no shards, no items, no passes) -> the device's one takes its place (SWAPPED);
//           the empty one is simply let go (nothing is lost)
//         * otherwise BOTH STAY, nothing is merged: this device switches to the account's one (token) and the game keeps
//           the device's one aside ("parked" - its balance shown, one tap to use it here again). Moving shards between
//           two store accounts is for a human (the admin), never automatic: they could be two different people's.
//     - the device has one belonging to someone else       -> "foreign" (put aside) + the account's one (token)
// Nothing here touches a balance, an order or a purchase record: Stripe, Steam, Google Play and the App Store keep
// checking purchases against the store account id exactly as before (iap tokens are made from that id).

/** A store sign-in as the game keeps it ("<id>.<token>") -> that account, or null. */
function accountFromAuth(text) {
  const m = /^(A[A-Z2-9]{12})\.([a-f0-9]{64})$/.exec(String(text || '').trim());
  if (!m) return null;
  const account = own(state.accounts, m[1]);
  if (!account) return null;
  const want = sha('tok|' + m[2]);
  return account.tokens.some(t => same(t.h, want)) ? account : null;
}

/**
 * Holds anything worth keeping: shards, items, Big Night passes waiting or running - Round 109 (review M3): or a purchase
 * still on its way (a Stripe checkout not settled yet, a Steam / phone purchase being checked), so it's never let go.
 */
function hasValue(a) {
  if (!a) return false;
  if ((a.shards || 0) > 0 || (a.owned || []).length > 0) return true;
  const now = Date.now();
  if (Array.isArray(a.passes) && a.passes.some(p => { const s = passState(p, now); return s === 'ready' || s === 'active'; })) return true;
  return pendingFor(a.id) > 0;
}

/** Round 109: purchases for this account that haven't settled yet (open Stripe checkouts, IAP being checked). */
function pendingFor(id) {
  let n = 0;
  for (const o of Object.values(state.orders || {})) if (o && o.account === id && o.status === 'open') n++;
  for (const r of Object.values(state.iap || {})) if (r && r.account === id && (r.status === 'init' || r.status === 'waiting')) n++;
  return n;
}

/** For the admin page (players.js) and the game's "put aside" note: no secrets. */
function accountSummary(id) {
  const a = own(state.accounts, String(id || ''));
  return a ? { id: a.id, name: a.name, shards: a.shards || 0, owned: (a.owned || []).length, passes: readyPasses(a), pending: pendingFor(a.id), live: a.liveUid || '' } : null;
}

function liveLinkable() { return !broken && persistent(); }

const UID_RE = /^u[0-9a-f]{24}$/;

/**
 * The store account that belongs to the live account with uid <liveUid> (see the rules above). Round 109 (review H1): keyed
 * on the account's immutable uid (store field "liveUid"), never the username - a username signed up again after a delete
 * is someone else and never finds the old store account. <hintId>: the id players.js has on record ('' = none).
 * <deviceAuth>: this device's store sign-in ('' = none). opts: {create, adopt, name, email, ip}.
 * Round 109 (review L1): a store account from before accounts that HOLDS something (shards, items, passes, a purchase on its
 * way) is only ever added to a live account when the player said yes on that device (adopt) - else the answer is
 * {ask: {id, shards, owned, pending}} and nothing changes. An empty one is simply linked (nothing to mix up).
 * -> {ok, store (id or ''), token?, account?, parked?, foreign?, created?, swapped?, replaced?, linked?, ask?}
 */
function linkLive(liveUid, hintId, deviceAuth, opts) {
  opts = opts || {};
  liveUid = String(liveUid || '');
  if (!UID_RE.test(liveUid)) return { ok: false, message: 'No live account.' };
  if (!liveLinkable()) return { ok: true, store: '', off: true };   // (no store on this server: nothing to link)
  const dev = accountFromAuth(deviceAuth);
  // The account's own store account: the one on record if it's still theirs, else any that says it's theirs.
  let mine = hintId ? own(state.accounts, String(hintId)) : null;
  if (mine && mine.liveUid !== liveUid) mine = null;   // (on record, but not this person's there - someone else's, or let go: never re-taken)
  if (!mine) mine = Object.values(state.accounts).find(a => a && a.liveUid === liveUid) || null;
  const out = { ok: true, store: '' };
  const handTo = (a) => { out.token = transact(() => newToken(a)); out.account = publicAccount(a); };
  const ask = (a) => ({ id: a.id, shards: a.shards || 0, owned: (a.owned || []).length, pending: pendingFor(a.id) });

  if (!mine) {
    if (dev && !dev.liveUid) {
      if (hasValue(dev) && !opts.adopt) { out.ask = ask(dev); return out; }   // the player says yes (or "not mine") first
      transact(credit => { dev.liveUid = liveUid; credit({ type: 'live-link', account: dev.id, live: liveUid }); });
      out.store = dev.id;
      out.linked = true;
      return out;
    }
    if (dev) out.foreign = true;   // (someone else's: the game puts it aside on this device)
    if (opts.create && isOpen() && Object.keys(state.accounts).length < MAX_ACCOUNTS) {
      // Round 109 (review L5): the same limit as making one in the Store (/store/account/create).
      if (limited('create|' + String(opts.ip || ''), 5, 3600000)) return Object.assign(out, { ok: false, status: 429, message: 'Too many new accounts from here - try again later.' });
      const name = cleanName(opts.name, 20);
      const email = String(opts.email || '').trim().toLowerCase().slice(0, 120);
      const made = transact(credit => {
        let id;
        do { id = 'A' + randomCode(12); } while (state.accounts[id]);
        const account = { id, name: name.length >= 2 ? name : 'Player', email, created: new Date().toISOString(), shards: 0, owned: [], tokens: [], recoveryHash: '', liveUid };
        state.accounts[id] = account;
        const token = newToken(account);
        credit({ type: 'account', account: id, live: liveUid });
        return { account, token };
      });
      out.store = made.account.id;
      out.token = made.token;
      out.account = publicAccount(made.account);
      out.created = true;
    }
    return out;
  }

  out.store = mine.id;
  if (dev && (dev.id === mine.id || dev.liveUid === liveUid)) { out.store = dev.id; return out; }   // all set (the device's is theirs too)
  if (!dev) { handTo(mine); return out; }      // a new device: its sign-in for the account's store account
  if (!dev.liveUid) {
    if (hasValue(dev) && !hasValue(mine)) {
      // The account's one holds nothing, the device's does: with a yes on this device, the device's takes its place.
      if (!opts.adopt) { out.ask = ask(dev); return out; }
      transact(credit => {
        mine.liveUid = '';
        dev.liveUid = liveUid;
        credit({ type: 'live-link', account: dev.id, live: liveUid, replaced: mine.id });
      });
      out.store = dev.id;
      out.swapped = true;
      out.replaced = mine.id;   // (players.js keeps it with the account's "other store accounts" - never lost)
      return out;
    }
    if (hasValue(dev)) out.parked = { id: dev.id, shards: dev.shards || 0, owned: (dev.owned || []).length, pending: pendingFor(dev.id) };   // both stay - never merged
  } else {
    out.foreign = true;
  }
  handTo(mine);
  return out;
}

/** The live account (uid) is gone (deleted): its store account stays (it holds purchases) and is never re-linked by a hint. */
function unlinkLive(liveUid, id) {
  const a = own(state.accounts, String(id || ''));
  if (!a || a.liveUid !== String(liveUid || '') || !liveLinkable()) return false;
  transact(() => { a.liveUid = ''; });
  return true;
}

// ============================================================================ the catalog
function vendorActive(v, now) {
  return v && v.status === 'approved' && (v.planUntil || 0) > (now || Date.now());
}

function planOf(v) { return PLANS.find(p => p.id === v.plan) || null; }

function designKey(d) { return d.vendor + '/' + d.id; }

/** Designs players can buy right now (approved, and the vendor's plan is running). */
function liveDesigns() {
  const now = Date.now();
  const out = [];
  for (const d of Object.values(state.designs)) {
    if (d.status !== 'live') continue;
    const v = state.vendors[d.vendor];
    if (vendorActive(v, now)) out.push({ d, v });
  }
  out.sort((a, b) => (a.d.approvedAt || '').localeCompare(b.d.approvedAt || ''));
  return out;
}

function findItem(id) {
  const premium = PREMIUM.find(p => p.id === id);
  if (premium) return { id, name: premium.name, price: premium.shards, premium: true };
  const slash = String(id || '').indexOf('/');
  if (slash <= 0) return null;
  const d = own(state.designs, String(id).slice(slash + 1));   // Round 55 review: own entries only
  if (!d || d.vendor !== String(id).slice(0, slash) || d.status !== 'live') return null;
  const v = state.vendors[d.vendor];
  if (!vendorActive(v)) return null;
  return { id, name: d.name, price: d.price, design: d, vendor: v };
}

function catalog() {
  const open = isOpen();
  const base = pay().baseUrl() || '';
  return {
    ok: true,
    open,
    checkout: checkoutReady(),
    currency: CURRENCY,
    message: open ? '' : broken ? 'The store is resting for maintenance - your shards are safe.' : 'The Moon Shards store is closed right now.',
    packs: PACKS.map(p => ({ id: p.id, label: p.label, shards: p.shards + p.bonus, bonus: p.bonus, price: money(p.cents) })),
    premium: PREMIUM.map(p => ({ id: p.id, name: p.name, shards: p.shards })),
    designs: open ? liveDesigns().map(({ d, v }) => ({
      key: designKey(d), vendor: v.id, vendorName: v.name, name: d.name, kind: d.kind, colour: d.colour, accent: d.accent,
      pattern: d.pattern, print: d.print, shards: d.price
    })) : [],
    vendorUrl: base && features().vendorPortal ? base + '/vendor' : '',
    termsUrl: base ? base + '/store/terms' : '',
    bigNight: bigNightPublic(),  // Round 58: the Big Night pass (bigger, featured rooms for one night)
    products: IAP_PRODUCTS.map(iapPublic),   // Round 69: the same things, sold through Steam / Google Play / the App Store
    stores: iapStores()
  };
}

/** Adds the approved vendors' designs to vendors.json as it goes to the game (their own booths). */
function mergeIntoFeed(feed) {
  if (!feed || typeof feed !== 'object' || !isOpen()) return feed;
  const byVendor = new Map();
  for (const { d, v } of liveDesigns()) {
    if (!byVendor.has(v.id)) byVendor.set(v.id, { v, items: [] });
    const entry = byVendor.get(v.id);
    if (entry.items.length < 12) {
      entry.items.push({ id: d.id, name: d.name, kind: d.kind, colour: d.colour, accent: d.accent, pattern: d.pattern, print: d.print, price: 1, shards: d.price });
    }
  }
  if (!byVendor.size) return feed;
  const makers = [...byVendor.values()].map(({ v, items }) => ({
    id: v.id, name: v.name, tagline: v.tagline || '', store: v.link || '', colour: v.colour || '#7a3cff', maker: true, items
  }));
  const own = Array.isArray(feed.vendors) ? feed.vendors : [];
  const samples = own.filter(x => x && /\(sample\)/i.test(String(x.name || '')));
  const real = own.filter(x => !samples.includes(x));
  feed.vendors = real.concat(makers, samples);
  return feed;
}

// ============================================================================ money in: Stripe
function packById(id) { return PACKS.find(p => p.id === id) || null; }

/** Credits a paid shard order once, no matter how many times Stripe (or the thank-you page) reports it. */
function creditOrder(session, credit) {
  const id = session && session.id;
  const meta = (session && session.metadata) || {};
  if (!id || meta.kind !== 'shards') return 'skip';
  const existing = state.orders[id];
  if (existing && existing.status !== 'open') return 'already';
  const account = state.accounts[meta.account];
  const pack = packById(meta.pack);
  if (!account || !pack) { console.error('store: paid order for unknown account/pack', id); return 'skip'; }
  if (session.amount_total != null && Number(session.amount_total) !== pack.cents) {
    console.error('store: paid amount does not match the pack', id, session.amount_total, pack.cents);
    return 'skip';
  }
  if (session.currency && String(session.currency).toLowerCase() !== 'usd') return 'skip';
  const shards = pack.shards + pack.bonus;   // from our own table - never from the session's metadata
  account.shards += shards;
  state.orders[id] = Object.assign(existing || {}, {
    kind: 'shards', account: account.id, pack: pack.id, shards, cents: pack.cents, status: 'paid',
    paidAt: new Date().toISOString(), paymentIntent: String(session.payment_intent || '')
  });
  credit({ type: 'buy', account: account.id, shards, balance: account.shards, cents: pack.cents, order: id, pack: pack.id });
  return 'credited';
}

/** A vendor's season plan, once paid. Renewing adds the next season onto the end. */
function activatePlan(session, credit) {
  const id = session && session.id;
  const meta = (session && session.metadata) || {};
  if (!id || meta.kind !== 'plan') return 'skip';
  const existing = state.orders[id];
  if (existing && existing.status !== 'open') return 'already';
  const vendor = state.vendors[meta.vendor];
  const plan = PLANS.find(p => p.id === meta.plan);
  if (!vendor || !plan) return 'skip';
  if (session.amount_total != null && Number(session.amount_total) !== plan.cents) return 'skip';
  const now = Date.now();
  const from = Math.max(now, vendor.planUntil || 0);
  vendor.planUntil = planEndFrom(from);
  vendor.plan = plan.id;
  state.orders[id] = Object.assign(existing || {}, {
    kind: 'plan', vendor: vendor.id, plan: plan.id, cents: plan.cents, status: 'paid', paidAt: new Date().toISOString(),
    paymentIntent: String(session.payment_intent || ''), until: vendor.planUntil
  });
  credit({ type: 'plan', vendor: vendor.id, plan: plan.id, cents: plan.cents, order: id, until: new Date(vendor.planUntil).toISOString() });
  return 'activated';
}

function refundOrder(paymentIntent, credit) {
  if (!paymentIntent) return 'skip';
  const entry = Object.entries(state.orders).find(([, o]) => o.paymentIntent === paymentIntent);
  if (!entry) return 'skip';
  const [id, order] = entry;
  if (order.status !== 'paid') return 'already';
  order.status = 'refunded';
  order.refundedAt = new Date().toISOString();
  if (order.kind === 'shards') {
    const account = state.accounts[order.account];
    if (account) {
      const take = Math.min(account.shards, order.shards);
      account.shards -= take;
      if (take < order.shards) account.flag = 'refund of shards already spent (' + (order.shards - take) + ')';
      credit({ type: 'refund', account: account.id, shards: -take, balance: account.shards, order: id, unrecovered: order.shards - take });
    }
  } else if (order.kind === 'plan') {
    const vendor = state.vendors[order.vendor];
    if (vendor) vendor.planUntil = Date.now();
    credit({ type: 'plan-refund', vendor: order.vendor, order: id, cents: -order.cents });
  } else if (order.kind === 'bignight') {
    // Round 58: a refunded Big Night pass stops working (a room using it goes back to a normal room within 30 s).
    const account = own(state.accounts, order.account);
    const pass = account && Array.isArray(account.passes) ? account.passes.find(p => p.id === order.pass) : null;
    if (pass) {
      const was = passState(pass, Date.now());
      pass.status = 'refunded';
      pass.refundedAt = new Date().toISOString();
      if (pass.until > Date.now()) pass.until = Date.now();
      if (was === 'used') account.flag = 'refund of a Big Night pass that was already used';
      credit({ type: 'bignight-refund', account: account.id, pass: pass.id, order: id, cents: -order.cents, was });
    }
  }
  return 'refunded';
}

/** Stripe's signature check ("Stripe-Signature: t=...,v1=..."), with a 5 minute window. */
function verifySignature(raw, header, secret) {
  const parts = String(header || '').split(',').map(s => s.trim().split('='));
  const t = parts.find(p => p[0] === 't');
  const v1 = parts.filter(p => p[0] === 'v1').map(p => p[1] || '');
  if (!t || !v1.length || !secret) return false;
  const ts = Number(t[1]);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const want = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(t[1] + '.'), raw])).digest('hex');
  return v1.some(v => same(v, want));
}

function webhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  readRaw(req, 512 * 1024).then(raw => {
    if (!raw) { json(res, 413, { ok: false }); return; }
    if (!verifySignature(raw, req.headers['stripe-signature'], secret)) { json(res, 400, { ok: false, message: 'bad signature' }); return; }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { json(res, 400, { ok: false }); return; }
    if (!event || !event.id || !event.type) { json(res, 400, { ok: false }); return; }
    if (state.events.includes(event.id)) { json(res, 200, { received: true, duplicate: true }); return; }
    const obj = (event.data && event.data.object) || {};
    try {
      transact(credit => {
        let result = 'ignored';
        if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
          if (obj.payment_status === 'paid') {
            const kind = obj.metadata && obj.metadata.kind;
            result = kind === 'plan' ? activatePlan(obj, credit) : kind === 'bignight' ? grantBigNightOrder(obj, credit) : creditOrder(obj, credit);   // Round 58: + Big Night passes
          } else {
            result = 'waiting';   // a slower payment method: its async_payment_succeeded comes later
          }
        } else if (event.type === 'charge.refunded') {
          result = refundOrder(String(obj.payment_intent || ''), credit);
        } else if (event.type === 'checkout.session.expired') {
          const order = state.orders[obj.id];
          if (order && order.status === 'open') { order.status = 'expired'; result = 'expired'; }
        }
        state.events.push(event.id);
        if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
        return result;
      });
      json(res, 200, { received: true });
    } catch (err) {
      console.error('store webhook', err && err.message);
      json(res, 500, { ok: false });   // Stripe tries again later
    }
  }).catch(err => { console.error('store webhook read', err && err.message); json(res, 400, { ok: false }); });
}

// ============================================================================ Round 58: Big Night passes
// Small online rooms (the host + 16) are FREE, always. A "Big Night" pass lets its owner open ONE bigger room
// (BIGNIGHT_SIZE people, 100 unless changed) for BIGNIGHT_HOURS (6) from the moment they first use it, and
// that room is FEATURED: first in everyone's Festivals list, with a badge. The relay decides every room's size
// (relay.js asks bigNightStart below), so a game can't make its own room bigger.
//
// SETTINGS (Render > Environment):
//   BIGNIGHT_PRICE_ID     the Stripe Price for one pass (price_..., a ONE-TIME price, e.g. $3.99). Until it's set,
//                         passes aren't sold (the safe default).
//   BIGNIGHT_MODE         optional: "paid" (the normal way once the price id is set), "off" (no new sales; passes
//                         people already bought still work), or "free" (anyone may open a big room, no pass - a
//                         launch party, say). Left out: "paid" if BIGNIGHT_PRICE_ID is set, otherwise "off".
//   BIGNIGHT_SHARDS       optional: the pass's price in Moon Shards (400 unless changed; 0 = not for shards)
//   BIGNIGHT_PRICE_CENTS  optional: the price the game shows if Stripe can't be asked (399 = $3.99). The real
//                         price is always the one on your Stripe Price.
//   BIGNIGHT_SIZE, BIGNIGHT_HOURS  optional: people in a big room (100) and how long a pass lasts (6)
// The admin page can also PAUSE sales with one button (passes already bought keep working).
const MAX_READY_PASSES = 5;        // passes an account can have waiting at once
const MAX_KEPT_PASSES = 20;        // finished passes kept on an account (for its history)
const PRICE_ID_RE = /^price_[A-Za-z0-9]{6,80}$/;
let freeGuests = 16;               // the relay tells us its free room size (setRoomSizes)
let liveBigRooms = () => [];       // the relay tells us which rooms are big right now (for the admin page)
const bigPrice = { id: '', cents: 0, currency: '', ok: false, problem: '', checkedAt: 0, asking: false };

function envInt(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && String(process.env[name] || '').trim() !== '' ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function bigNightConfig() {
  const priceId = String(process.env.BIGNIGHT_PRICE_ID || '').trim();
  const asked = String(process.env.BIGNIGHT_MODE || '').trim().toLowerCase();
  const mode = asked === 'paid' || asked === 'off' || asked === 'free' ? asked : (priceId ? 'paid' : 'off');
  return {
    mode,
    priceId: PRICE_ID_RE.test(priceId) ? priceId : '',
    priceIdTyped: priceId,
    size: envInt('BIGNIGHT_SIZE', 100, 20, 200),
    hours: envInt('BIGNIGHT_HOURS', 6, 1, 24),
    cents: envInt('BIGNIGHT_PRICE_CENTS', 399, 50, 100000),
    shards: envInt('BIGNIGHT_SHARDS', 400, 0, 100000),
    paused: !!(state.settings && state.settings.bigNightPaused)
  };
}

/** Asks Stripe what the pass's Price really is (at most every 10 minutes), so the game shows the true price. */
function refreshBigPrice() {
  const cfg = bigNightConfig();
  const now = Date.now();
  if (!cfg.priceId) { Object.assign(bigPrice, { id: '', ok: false, problem: '' }); return; }
  if (bigPrice.asking || (bigPrice.id === cfg.priceId && now - bigPrice.checkedAt < 600000)) return;
  let s;
  try { s = stripe(); } catch { s = null; }
  if (!s || !s.prices || typeof s.prices.retrieve !== 'function') return;
  bigPrice.asking = true;
  s.prices.retrieve(cfg.priceId).then(price => {
    const oneTime = !price.recurring && price.type !== 'recurring';
    Object.assign(bigPrice, {
      id: cfg.priceId, cents: Number(price.unit_amount) || 0, currency: String(price.currency || '').toLowerCase(),
      ok: !!price.active && oneTime && Number(price.unit_amount) > 0,
      problem: !price.active ? 'that Price is archived in Stripe' : !oneTime ? 'that Price is a subscription - make a ONE-TIME price' : !(Number(price.unit_amount) > 0) ? 'that Price has no amount' : ''
    });
  }).catch(err => {
    Object.assign(bigPrice, { id: cfg.priceId, ok: false, problem: 'Stripe says: ' + String(err && err.message || 'not found').slice(0, 120) });
  }).then(() => { bigPrice.asking = false; bigPrice.checkedAt = Date.now(); });
}

function bigPriceText() {
  const cfg = bigNightConfig();
  const cents = bigPrice.ok && bigPrice.id === cfg.priceId ? bigPrice.cents : cfg.cents;
  const cur = bigPrice.ok && bigPrice.id === cfg.priceId ? bigPrice.currency : 'usd';
  return cur === 'usd' || !cur ? money(cents) : (cents / 100).toFixed(2) + ' ' + cur.toUpperCase();
}

/** Passes on sale for real money right now (paid mode, a good Price id, not paused, Stripe + webhook ready). */
function bigNightStripeSales() {
  const cfg = bigNightConfig();
  refreshBigPrice();
  return cfg.mode === 'paid' && !!cfg.priceId && !cfg.paused && checkoutReady() && !(bigPrice.id === cfg.priceId && bigPrice.checkedAt && !bigPrice.ok);
}

/** Passes on sale for Moon Shards (paid mode, a Price id set - the same "switched on" - not paused, store open). */
function bigNightShardSales() {
  const cfg = bigNightConfig();
  return cfg.mode === 'paid' && !!cfg.priceId && !cfg.paused && cfg.shards > 0 && isOpen();
}

function bigNightClosedWords() {
  const cfg = bigNightConfig();
  if (cfg.mode === 'free') return 'Big Night rooms are free right now - no pass needed. Just choose Big Night when you host!';
  if (cfg.paused) return 'Big Night passes are paused for a little while. Passes you already have still work.';
  return 'Big Night passes aren\'t on sale yet - check back soon! Free rooms (you + ' + freeGuests + ') are always open.';
}

/** What the game shows about Big Night (in /store/catalog). */
function bigNightPublic() {
  const cfg = bigNightConfig();
  const stripeOn = bigNightStripeSales();
  const shardsOn = bigNightShardSales();
  return {
    mode: cfg.mode,
    sales: stripeOn,
    shards: shardsOn ? cfg.shards : 0,
    price: bigPriceText(),
    size: cfg.size,
    hours: cfg.hours,
    freeSize: freeGuests + 1,
    message: cfg.mode === 'free' || (!stripeOn && !shardsOn) ? bigNightClosedWords() : ''
  };
}

function passState(p, now) {
  if (!p) return 'none';
  if (p.status === 'refunded' || p.status === 'revoked') return p.status;
  if (p.status === 'ready') return 'ready';
  return p.until > now ? 'active' : 'used';
}

function readyPasses(account) {
  return Array.isArray(account.passes) ? account.passes.filter(p => p.status === 'ready').length : 0;
}

/** For the game: passes waiting, the running one's seconds left, and how many were used. */
function bigNightSummary(a) {
  const now = Date.now();
  let ready = 0, used = 0, activeLeft = 0;
  for (const p of Array.isArray(a.passes) ? a.passes : []) {
    const st = passState(p, now);
    if (st === 'ready') ready++;
    else if (st === 'used') used++;
    else if (st === 'active') activeLeft = Math.max(activeLeft, Math.ceil((p.until - now) / 1000));
  }
  return { ready, activeLeft, used, hours: bigNightConfig().hours };
}

/** Adds a pass to an account (inside a transact). via: stripe / shards / gift. */
function addPass(account, via, extra, credit) {
  if (!Array.isArray(account.passes)) account.passes = [];
  let id;
  do { id = 'N' + randomCode(10); } while (account.passes.some(p => p.id === id));
  const pass = Object.assign({ id, via, bought: new Date().toISOString(), status: 'ready', started: 0, until: 0 }, extra || {});
  account.passes.push(pass);
  // Keep every pass that's waiting or running; only the newest finished ones are kept for history.
  const now = Date.now();
  const done = account.passes.filter(p => passState(p, now) !== 'ready' && passState(p, now) !== 'active');
  if (done.length > MAX_KEPT_PASSES) {
    const drop = new Set(done.slice(0, done.length - MAX_KEPT_PASSES));
    account.passes = account.passes.filter(p => !drop.has(p));
  }
  credit({ type: 'bignight-pass', account: account.id, pass: id, via, cents: pass.cents || 0, shards: pass.shards || 0 });
  return pass;
}

/** A paid Big Night checkout: one pass, once, however many times Stripe (or the thank-you page) reports it. */
function grantBigNightOrder(session, credit) {
  const id = session && session.id;
  const meta = (session && session.metadata) || {};
  if (!id || meta.kind !== 'bignight') return 'skip';
  const existing = state.orders[id];
  if (existing && existing.status !== 'open') return 'already';
  const account = own(state.accounts, meta.account);
  if (!account) { console.error('store: paid Big Night order for an unknown account', id); return 'skip'; }
  const cents = Number(session.amount_total);
  if (session.amount_total != null && !(cents > 0)) return 'skip';   // our own Price always costs something
  const pass = addPass(account, 'stripe', { order: id, cents: Number.isFinite(cents) ? cents : 0 }, credit);
  state.orders[id] = Object.assign(existing || {}, {
    kind: 'bignight', account: account.id, cents: Number.isFinite(cents) ? cents : 0, currency: String(session.currency || ''), status: 'paid',
    paidAt: new Date().toISOString(), paymentIntent: String(session.payment_intent || ''), pass: pass.id
  });
  return 'granted';
}

/** The account a "<id>.<token>" pair speaks for (the relay's version of authed), or null. */
function accountFromPair(pair) {
  const m = /^(A[A-Z2-9]{12})\.([a-f0-9]{64})$/.exec(String(pair || ''));
  if (!m) return null;
  const account = own(state.accounts, m[1]);
  if (!account) return null;
  const want = sha('tok|' + m[2]);
  return account.tokens.some(t => same(t.h, want)) ? account : null;
}

/**
 * Called by the relay when a host asks for a Big Night room. inUse(passId) says whether another open room
 * is already using that pass. Returns { ok, until, size, passId, account, resumed, free } or { ok: false, message }.
 */
function bigNightStart(pair, ip, inUse) {
  const cfg = bigNightConfig();
  const now = Date.now();
  if (cfg.mode === 'free') return { ok: true, free: true, until: now + cfg.hours * 3600000, size: cfg.size, passId: '', account: '' };
  if (limited('bnuse|' + ip, 30, 3600000)) return { ok: false, message: 'Too many tries - wait a while and try again.' };
  if (broken || !persistent() || !features().store) return { ok: false, message: 'Big Night rooms aren\'t available on this server right now. Your free room is open as normal.' };
  const account = accountFromPair(pair);
  if (!account) return { ok: false, message: 'Sign in to your free account first (Settings > Account & Store) - your Big Night passes are kept on it.' };
  if (account.banned) return { ok: false, message: 'This account can\'t use Big Night rooms right now. Contact support.' };
  const list = Array.isArray(account.passes) ? account.passes : [];
  // Already running (the host closed their room and opened a new one): carry on with the same pass and time.
  const running = list.filter(p => passState(p, now) === 'active');
  const free = running.find(p => !inUse(p.id));
  if (free) return { ok: true, until: free.until, size: cfg.size, passId: free.id, account: account.id, resumed: true };
  if (running.length) return { ok: false, message: 'Your Big Night is already running in another room. Close that room first, then open it again here.' };
  const ready = list.find(p => p.status === 'ready');
  if (!ready) return { ok: false, message: 'You don\'t have a Big Night pass right now. Get one in the Store (BIG NIGHT tab) - your room stays open as a free room meanwhile.' };
  try {
    transact(credit => {
      ready.status = 'active';
      ready.started = now;
      ready.until = now + cfg.hours * 3600000;
      credit({ type: 'bignight-start', account: account.id, pass: ready.id, until: new Date(ready.until).toISOString() });
    });
  } catch (err) {
    console.error('bignight start', err && err.message);
    return { ok: false, message: 'Couldn\'t start your Big Night just now - try again in a minute. Your pass is safe.' };
  }
  return { ok: true, until: ready.until, size: cfg.size, passId: ready.id, account: account.id, resumed: false };
}

/** The relay checks a running Big Night now and then: its end time, or 0 if the pass was refunded / taken back. */
function bigNightUntil(passId, accountId) {
  if (!passId) return 0;
  const account = own(state.accounts, accountId);
  const pass = account && Array.isArray(account.passes) ? account.passes.find(p => p.id === passId) : null;
  if (!pass || pass.status === 'refunded' || pass.status === 'revoked') return 0;
  return pass.until || 0;
}

function setRoomSizes(sizes) {
  if (sizes && Number.isInteger(sizes.freeGuests) && sizes.freeGuests > 0) freeGuests = sizes.freeGuests;
}

function setBigNightRooms(fn) {
  if (typeof fn === 'function') liveBigRooms = fn;
}

function bigNightAdminSection(hidden, button) {
  const esc = pay().escapeHtml;
  const cfg = bigNightConfig();
  refreshBigPrice();
  const now = Date.now();
  const orders = Object.values(state.orders).filter(o => o.kind === 'bignight');
  const paid = orders.filter(o => o.status === 'paid');
  const refunded = orders.filter(o => o.status === 'refunded');
  let byShards = 0, gifts = 0, waiting = 0;
  const activeRows = [];
  for (const a of Object.values(state.accounts)) {
    for (const p of Array.isArray(a.passes) ? a.passes : []) {
      const st = passState(p, now);
      if (p.via === 'shards') byShards++;
      if (p.via === 'gift') gifts++;
      if (st === 'ready') waiting++;
      if (st === 'active') activeRows.push({ a, p });
    }
  }
  let rooms = [];
  try { rooms = liveBigRooms() || []; } catch { rooms = []; }
  const roomOf = passId => rooms.find(r => r.passId === passId);
  const left = ms => { const m = Math.max(0, Math.round(ms / 60000)); return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  const active = activeRows.map(({ a, p }) => {
    const r = roomOf(p.id);
    return `<tr><td><b>${esc(a.name)}</b><br><span class="small">${esc(a.id)} &middot; pass ${esc(p.id)} (${esc(p.via)})</span></td>
<td>${r ? `<span class="on">room ${esc(r.code)} open</span><br><span class="small">${r.players} in &middot; "${esc(r.title || '')}"</span>` : '<span class="small">no room open right now</span>'}</td>
<td><span class="small">${left(p.until - now)} left</span></td></tr>`;
  }).join('');
  const freeRooms = rooms.filter(r => r.free).map(r => `<tr><td>room ${esc(r.code)}</td><td><span class="small">free Big Night (BIGNIGHT_MODE=free) &middot; ${r.players} in</span></td><td><span class="small">${left(r.until - now)} left</span></td></tr>`).join('');
  const recent = paid.concat(refunded).sort((x, y) => String(y.paidAt || '').localeCompare(String(x.paidAt || ''))).slice(0, 12).map(o => {
    const a = own(state.accounts, o.account);
    return `<tr><td><span class="small">${esc(String(o.paidAt || o.at || '').slice(0, 16).replace('T', ' '))}</span></td><td>${esc(a ? a.name : o.account)}<br><span class="small">${esc(o.account)}</span></td>
<td>${o.status === 'refunded' ? '<span class="off">refunded</span>' : '<span class="on">paid</span>'} <span class="small">${money(o.cents || 0)}</span></td></tr>`;
  }).join('');
  const priceLine = !cfg.priceIdTyped ? '<span class="off">not set - add BIGNIGHT_PRICE_ID (passes aren\'t sold until you do)</span>'
    : !cfg.priceId ? '<span class="off">that doesn\'t look like a Price id (it starts with price_)</span>'
      : bigPrice.id === cfg.priceId && bigPrice.checkedAt ? (bigPrice.ok ? `<span class="on">ready</span> <span class="small">${esc(bigPriceText())} one-time</span>` : `<span class="off">${esc(bigPrice.problem)}</span>`)
        : '<span class="small">checking with Stripe... (reload in a moment)</span>';
  const modeWords = { paid: 'PAID - passes on sale', off: 'OFF - no new passes (ones already bought still work)', free: 'FREE - anyone can open a big room, no pass needed' };
  const totalCents = paid.reduce((sum, o) => sum + (o.cents || 0), 0);
  return `<h2>Big Night passes</h2>
<p class="small">Free rooms: the host + ${freeGuests}. A pass opens one room for up to ${cfg.size} people for ${cfg.hours} hours from first use, featured at the top of the Festivals list.</p>
<table>
<tr><td>Mode (BIGNIGHT_MODE)</td><td>${cfg.mode === 'paid' ? '<span class="on">' : cfg.mode === 'free' ? '<span class="small">' : '<span class="off">'}${esc(modeWords[cfg.mode])}</span></td></tr>
<tr><td>Stripe Price (BIGNIGHT_PRICE_ID)</td><td>${priceLine}</td></tr>
<tr><td>Price in Moon Shards (BIGNIGHT_SHARDS)</td><td>${cfg.shards > 0 ? cfg.shards + ' shards' : '<span class="small">not sold for shards</span>'}</td></tr>
<tr><td>On sale in the game right now</td><td>${bigNightStripeSales() ? '<span class="on">yes (card)</span>' : '<span class="off">not for card payments</span>'} ${bigNightShardSales() ? '<span class="on">yes (shards)</span>' : '<span class="small">not for shards</span>'}</td></tr>
</table>
<form method="post" action="/admin" style="margin-top:6px">${hidden}<input type="hidden" name="action" value="bignight-pause"><button type="submit"${cfg.paused ? '' : ' style="background:#ff8a80"'}>${cfg.paused ? 'Sales are PAUSED - resume sales' : 'Pause sales'}</button> <span class="small">Pausing stops new sales only; passes people bought keep working.</span></form>
<p class="small">${paid.length} sold for money (${money(totalCents)} before Stripe's fees) &middot; ${refunded.length} refunded &middot; ${byShards} bought with shards &middot; ${gifts} given by you &middot; ${waiting} waiting to be used &middot; ${activeRows.length} running now</p>
<h2 style="font-size:15px">Running now (${activeRows.length + rooms.filter(r => r.free).length})</h2><table>${active + freeRooms || '<tr><td class="small">None right now.</td></tr>'}</table>
<h2 style="font-size:15px">Latest paid passes</h2><table>${recent || '<tr><td class="small">None yet.</td></tr>'}</table>
<form method="post" action="/admin" style="margin-top:6px">${hidden}<input type="hidden" name="action" value="bignight-gift"><input name="item" placeholder="account id (A...)" maxlength="13" style="width:150px"> <input name="note" placeholder="why" maxlength="100" style="width:160px"> <button type="submit">Give 1 Big Night pass</button></form>
<form method="post" action="/admin" style="margin-top:6px">${hidden}<input type="hidden" name="action" value="bignight-end"><input name="item" placeholder="account id (A...)" maxlength="13" style="width:150px"> <button type="submit" style="background:#ff8a80">End their running Big Night now</button> <span class="small">(for abuse; to give money back, refund in Stripe - that ends it too)</span></form>`;
}

function bigNightAdminAction(action, item, note, run) {
  const account = own(state.accounts, item.toUpperCase());
  switch (action) {
    case 'bignight-pause':
      return run(c => {
        if (!state.settings) state.settings = {};
        state.settings.bigNightPaused = !state.settings.bigNightPaused;
        c({ type: state.settings.bigNightPaused ? 'bignight-paused' : 'bignight-resumed' });
        return state.settings.bigNightPaused ? 'Big Night sales are paused. Passes people already have still work.' : 'Big Night sales are back on.';
      });
    case 'bignight-gift':
      if (!account) return 'Check the account id (it starts with A).';
      if (readyPasses(account) >= MAX_READY_PASSES) return `${account.name} already has ${MAX_READY_PASSES} passes waiting.`;
      return run(c => { addPass(account, 'gift', { note }, c); return `Gave ${account.name} (${account.id}) a Big Night pass.`; });
    case 'bignight-end': {
      if (!account) return 'Check the account id (it starts with A).';
      const now = Date.now();
      const running = (account.passes || []).filter(p => passState(p, now) === 'active');
      if (!running.length) return `${account.name} has no Big Night running.`;
      return run(c => {
        for (const p of running) { p.status = 'revoked'; p.until = now; c({ type: 'bignight-ended-by-admin', account: account.id, pass: p.id, note }); }
        return `${account.name}'s Big Night was ended (their room goes back to a normal room within 30 seconds).`;
      });
    }
    default: return null;
  }
}

// ============================================================================ Round 69: in-app purchases
// Steam (ISteamMicroTxn), Google Play and the App Store sell the SAME things as Stripe does on the web:
// shard packs and Big Night passes. Outfits and vendor designs are then bought with shards (above), so
// they work everywhere. (Vendor season plans are sold to real vendors on the /vendor web page only.)
// ONE catalog for every store, here. Amounts always come from PACKS / bigNightConfig() - never from the
// game. In Google Play Console and App Store Connect, make each product with the SAME id and price.
// Each purchase is granted exactly once: state.iap["steam:<orderid>" | "google:<token hash>" | "apple:<transaction id>"].
const IAP_ID_PREFIX = 'com.moonvisionmedia.newmoonsamedark.';
const IAP_PRODUCTS = [
  { id: 'credits_500', kind: 'shards', pack: 'handful', storeId: IAP_ID_PREFIX + 'credits500', steamItem: 1001 },
  { id: 'credits_1100', kind: 'shards', pack: 'pouch', storeId: IAP_ID_PREFIX + 'credits1100', steamItem: 1002 },
  { id: 'credits_2400', kind: 'shards', pack: 'jar', storeId: IAP_ID_PREFIX + 'credits2400', steamItem: 1003 },
  { id: 'credits_6500', kind: 'shards', pack: 'crate', storeId: IAP_ID_PREFIX + 'credits6500', steamItem: 1004 },
  { id: 'bignight_pass', kind: 'bignight', storeId: IAP_ID_PREFIX + 'bignightpass', steamItem: 2001 }
];
const IAP_KEEP_OPEN_MS = 7 * DAY;      // Steam orders never approved are forgotten after a week
const IAP_REFUND_LOOKBACK = 60 * DAY;  // how far back "check for refunds" looks
let iapCheck = { running: false, at: '', note: '' };

function iapById(id) {
  const s = String(id || '');
  return IAP_PRODUCTS.find(p => p.id === s || p.storeId === s) || null;
}

/** What one product gives and costs - always from the server's own tables. */
function iapTerms(p) {
  if (!p) return null;
  if (p.kind === 'shards') {
    const pack = packById(p.pack);
    return pack ? { shards: pack.shards + pack.bonus, bonus: pack.bonus, cents: pack.cents, label: pack.label } : null;
  }
  const cfg = bigNightConfig();
  return { shards: 0, bonus: 0, cents: cfg.cents, label: `Big Night pass (${cfg.hours} hours, up to ${cfg.size} people)` };
}

/** Big Night passes through the app stores: BIGNIGHT_MODE=paid, not paused, store open (no Stripe Price needed). */
function bigNightIapSales() {
  const cfg = bigNightConfig();
  return cfg.mode === 'paid' && !cfg.paused && isOpen();
}

function iapAvailable(p) { return isOpen() && !!iapTerms(p) && (p.kind !== 'bignight' || bigNightIapSales()); }

function iapPublic(p) {
  const t = iapTerms(p) || { shards: 0, bonus: 0, cents: 0, label: '' };
  return { id: p.id, kind: p.kind, pack: p.pack || '', label: t.label, shards: t.shards, bonus: t.bonus, cents: t.cents, price: money(t.cents),
    apple: p.storeId, google: p.storeId, steam: p.steamItem, available: iapAvailable(p) };
}

/** Which stores this server can check purchases for right now (the game hides a store's buttons until it's ready). */
function iapStores() {
  const open = isOpen();
  return { steam: open && verify.steamConfig().ready, google: open && verify.googleConfig().ready, apple: open && verify.appleConfig().lookup, appleJws: open };
}

function newSteamOrderId() {
  const b = crypto.randomBytes(7);
  b[0] &= 0x0f;   // 52 bits: an exact JavaScript number, and a valid Steam uint64
  let n = 0;
  for (const x of b) n = n * 256 + x;
  return String(n + 1000000000);
}

function pruneIap() {
  const now = Date.now();
  for (const [key, r] of Object.entries(state.iap)) {
    if ((r.status === 'init' || r.status === 'waiting' || r.status === 'failed') && now - Date.parse(r.at || 0) > IAP_KEEP_OPEN_MS) delete state.iap[key];
  }
}

/**
 * Grants one verified purchase (inside transact). Returns 'granted', 'already' (granted before, to this
 * account), 'other' (granted to a different account) or 'revoked' (refunded / taken back).
 */
function grantIap(key, info, p, account, credit) {
  if (!state.iap) state.iap = {};
  const existing = own(state.iap, key);
  if (existing && existing.status === 'granted') return existing.account === account.id ? 'already' : 'other';
  if (existing && existing.status === 'revoked') return 'revoked';
  if (existing && existing.account && existing.account !== account.id) return 'other';
  const t = iapTerms(p);
  if (!t) throw new Error('no terms for ' + p.id);
  const qty = Math.max(1, Math.min(10, Math.trunc(Number(info.qty) || 1)));
  const now = new Date().toISOString();
  const rec = Object.assign(existing || { at: now }, info, { key, account: account.id, product: p.id, kind: p.kind, qty, status: 'granted', grantedAt: now });
  delete rec.problem;
  if (!(Number(rec.cents) > 0)) rec.cents = t.cents * qty;
  if (p.kind === 'shards') {
    rec.shards = t.shards * qty;
    account.shards += rec.shards;
    credit({ type: 'buy', via: rec.platform, account: account.id, shards: rec.shards, balance: account.shards, cents: rec.cents, order: key, product: p.id, test: !!rec.sandbox || undefined });
  } else {
    rec.passes = [];
    for (let i = 0; i < qty; i++) rec.passes.push(addPass(account, rec.platform, { order: key, cents: t.cents }, credit).id);
  }
  state.iap[key] = rec;
  return 'granted';
}

/** Takes a store purchase back (a refund, or you on the admin page). Inside transact. */
function revokeIap(rec, why, credit) {
  if (!rec || rec.status !== 'granted') return 'already';
  const now = Date.now();
  rec.status = 'revoked';
  rec.revokedAt = new Date(now).toISOString();
  rec.revokeWhy = String(why || '').slice(0, 120);
  const account = own(state.accounts, rec.account);
  if (!account) return 'revoked';
  if (rec.kind === 'shards') {
    const want = rec.shards || 0;
    const take = Math.min(account.shards, want);
    account.shards -= take;
    if (take < want) account.flag = 'refund of shards already spent (' + (want - take) + ')';
    credit({ type: 'refund', via: rec.platform, account: account.id, shards: -take, balance: account.shards, order: rec.key, unrecovered: want - take, why: rec.revokeWhy });
  } else {
    for (const id of rec.passes || []) {
      const pass = Array.isArray(account.passes) ? account.passes.find(x => x.id === id) : null;
      if (!pass) continue;
      const was = passState(pass, now);
      pass.status = 'refunded';
      pass.refundedAt = rec.revokedAt;
      if (pass.until > now) pass.until = now;
      if (was === 'used') account.flag = 'refund of a Big Night pass that was already used';
      credit({ type: 'bignight-refund', via: rec.platform, account: account.id, pass: pass.id, order: rec.key, cents: -(rec.cents || 0), was });
    }
  }
  return 'revoked';
}

function iapWords(rec) {
  if (!rec) return 'Purchase verified.';
  if (rec.kind === 'bignight') return 'Purchase verified - your Big Night pass is ready.';
  return `Purchase verified - ${(rec.shards || 0).toLocaleString('en-US')} ${CURRENCY} added.`;
}

/** The answer for a grant result. */
function iapReply(res, out, key, accountId) {
  const rec = own(state.iap, key);
  const account = own(state.accounts, accountId);
  if (out === 'granted' || out === 'already') {
    return json(res, 200, { ok: true, already: out === 'already', product: rec ? rec.product : '', shards: rec && rec.kind === 'shards' ? rec.shards : 0,
      sandbox: !!(rec && rec.sandbox), message: iapWords(rec) + (rec && rec.sandbox ? ' (test purchase)' : ''), account: account ? publicAccount(account) : undefined });
  }
  if (out === 'other') return json(res, 409, { ok: false, final: true, message: 'This purchase was already added to a different account.' });
  return json(res, 409, { ok: false, final: true, message: 'This purchase was refunded, so it can\'t be added.' });
}

// ---- Round 69 (review): set-up problems are shown on the admin page (and logged), never silently swallowed.
const IAP_ALERTS_MAX = 20;
let iapAlerts = [];

function iapAlert(text) {
  const t = String(text || '').slice(0, 300);
  console.error('STORE ALERT: ' + t);
  const now = new Date().toISOString();
  const known = iapAlerts.find(a => a.text === t);
  if (known) { known.count++; known.last = now; return; }
  iapAlerts.push({ text: t, first: now, last: now, count: 1 });
  if (iapAlerts.length > IAP_ALERTS_MAX) iapAlerts.shift();
}

/** A purchase that must be KEPT (the game retries) - with an admin alert when it's our set-up. */
function iapRetry(res, message, alertText) {
  if (alertText) iapAlert(alertText);
  return json(res, 202, { ok: false, retry: true, message: message || 'We couldn\'t check your purchase just now. It\'s safe - it will be added automatically in a few minutes.' });
}

/** A failed store check: definitely-not-valid (final) or try-again-later (with an alert if it looks like our set-up). */
function iapProblem(res, err, what) {
  const final = err instanceof verify.VerifyError && err.final;
  console.error('store ' + what + ':', err && err.message);
  if (final) return json(res, 409, { ok: false, final: true, message: 'The store says this purchase isn\'t valid, so nothing was added.' });
  if (err instanceof verify.VerifyError && err.alert) iapAlert(what + ': ' + err.message);
  return json(res, 502, { ok: false, retry: true, message: 'We couldn\'t check your purchase with the store just now. It\'s safe - it will be added automatically in a few minutes.' });
}

/**
 * Round 69 (review): the id the game gives the store with each purchase (App Store applicationUsername ->
 * appAccountToken; Google obfuscatedExternalAccountId), made from the account id so it reveals nothing.
 * Platform/Purchases.cs AccountToken() makes the same: SHA-256("nmsd-account|" + id), first 16 bytes as a v4 UUID.
 */
function accountToken(accountId) {
  const b = crypto.createHash('sha256').update('nmsd-account|' + String(accountId)).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The store says which account a purchase was made for: it must be this one (else keep it for that account). */
function wrongAccount(res, tokenFromStore, accountId) {
  const t = String(tokenFromStore || '').toLowerCase();
  if (!t || t === accountToken(accountId)) return false;
  // Round 109 (review M3): + the token it was made for (not an account id), so the game can find that store account among
  // the ones it keeps aside on this device and offer to switch to it.
  if (/^[0-9a-f-]{36}$/.test(t)) {
    json(res, 202, { ok: false, retry: true, otherToken: t, message: 'This purchase was made while signed in to a different Moon Shards account on this device. Switch to that account to receive it.' });
    return true;
  }
  iapRetry(res, 'This purchase was made while signed in to a different account on this device. Sign in to that account to receive it.');
  return true;
}

// ---- Round 69 (review): Steam prices in the player's wallet currency. USD comes from PACKS / BIGNIGHT_PRICE_CENTS;
// the others are used only while the USD price is still the one in this table (change both together).
const STEAM_PRICES = {
  credits_500: { USD: 499, EUR: 499, GBP: 449, CAD: 699, AUD: 799 },
  credits_1100: { USD: 999, EUR: 999, GBP: 899, CAD: 1399, AUD: 1599 },
  credits_2400: { USD: 1999, EUR: 1999, GBP: 1799, CAD: 2799, AUD: 3199 },
  credits_6500: { USD: 4999, EUR: 4999, GBP: 4499, CAD: 6999, AUD: 7999 },
  bignight_pass: { USD: 399, EUR: 399, GBP: 349, CAD: 549, AUD: 599 }
};

function steamPrice(p, currency) {
  const usd = iapTerms(p).cents;
  const table = STEAM_PRICES[p.id];
  const cur = String(currency || '').toUpperCase();
  if (table && cur !== 'USD' && Number.isInteger(table[cur]) && table.USD === usd) return { currency: cur, amount: table[cur] };
  return { currency: 'USD', amount: usd };
}

/** POST /store/steam/init {steamId, productId, language, ticket} - starts a Steam purchase for the signed-in account. */
async function steamInit(req, res, body, ip) {
  if (req.method !== 'POST') return json(res, 405, { ok: false });
  if (!isOpen()) return json(res, 503, CLOSED);
  if (!verify.steamConfig().ready) return json(res, 503, { ok: false, message: 'Buying through Steam isn\'t switched on yet - check back soon!' });
  const signedIn = authed(req);
  if (!signedIn) return json(res, 401, { ok: false, message: 'Signed out - sign in again with your recovery code.' });
  if (signedIn.banned) return json(res, 403, { ok: false, message: 'This account can\'t shop right now. Contact support.' });
  if (limited('steam|' + signedIn.id, 10, 600000) || limited('steamip|' + ip, 40, 600000)) return json(res, 429, { ok: false, message: 'Slow down a little - try again in a few minutes.' });
  const p = iapById(body.productId);
  if (!p || !iapAvailable(p)) return json(res, 404, { ok: false, message: 'That isn\'t on sale right now.' });
  const steamId = String(body.steamId || '');
  const ticket = String(body.ticket || '');
  if (!/^\d{17}$/.test(steamId) || !/^[0-9a-fA-F]{16,5120}$/.test(ticket)) return json(res, 400, { ok: false, message: 'Steam isn\'t ready - restart the game from your Steam library and try again.' });
  if (p.kind === 'bignight' && readyPasses(signedIn) >= MAX_READY_PASSES) return json(res, 400, { ok: false, message: `You already have ${MAX_READY_PASSES} passes waiting - use one first.` });
  let who;
  try { who = await verify.steamAuthenticate(ticket, 'newmoon'); } catch (err) {
    console.error('store steam ticket:', err && err.message);
    return json(res, err instanceof verify.VerifyError && err.final ? 403 : 502, { ok: false, message: 'Steam couldn\'t confirm who you are just now - try again in a minute.' });
  }
  if (who.steamid !== steamId) return json(res, 403, { ok: false, message: 'That Steam sign-in doesn\'t match - restart the game from Steam.' });
  if (who.publisherBanned) return json(res, 403, { ok: false, message: 'This Steam account can\'t shop in this game. Contact support.' });   // Round 69 (review)
  // Round 69 (review): the wallet's currency (USD if Steam can't tell us, or if we have no price for it).
  let wallet = { currency: 'USD' };
  try { wallet = await verify.steamUserInfo(steamId); } catch (err) { console.error('store steam wallet:', err && err.message); }
  const account = own(state.accounts, signedIn.id);   // (fresh - the state may have been reloaded meanwhile)
  const t = iapTerms(p);
  if (!account || !t) return json(res, 500, { ok: false, message: 'Something went wrong - try again in a minute.' });
  const price = steamPrice(p, wallet.currency);
  let orderId;
  do { orderId = newSteamOrderId(); } while (own(state.iap, 'steam:' + orderId));
  const key = 'steam:' + orderId;
  const sandbox = verify.steamConfig().sandbox;
  transact(() => {
    pruneIap();
    state.iap[key] = { key, platform: 'steam', orderId, account: account.id, steamid: steamId, product: p.id, kind: p.kind, itemId: p.steamItem,
      cents: t.cents, currency: price.currency, amount: price.amount, wallet: wallet.currency || '', status: 'init', at: new Date().toISOString(),
      env: sandbox ? 'Sandbox' : 'Production', sandbox };
  });
  const description = p.kind === 'shards' ? `${t.shards.toLocaleString('en-US')} ${CURRENCY} (game credits)` : 'Big Night pass';
  try {
    const params = await verify.steamInitTxn({ orderId, steamId, itemId: p.steamItem, cents: price.amount, currency: price.currency, description, language: body.language });
    transact(() => { const r = own(state.iap, key); if (r && r.status === 'init') { r.status = 'waiting'; r.transId = String(params.transid || ''); } });
  } catch (err) {
    console.error('store steam init:', err && err.message);
    try { transact(() => { const r = own(state.iap, key); if (r && r.status === 'init') { r.status = 'failed'; r.problem = String(err && err.message || '').slice(0, 160); } }); } catch { /* it's pruned later anyway */ }
    const other = wallet.currency && wallet.currency !== price.currency;
    return json(res, 502, { ok: false, message: other
      ? `Steam couldn't start the purchase - your Steam wallet uses ${wallet.currency}, which this store can't charge yet. You weren't charged.`
      : 'Steam couldn\'t start the purchase just now - try again in a minute. You weren\'t charged.' });
  }
  json(res, 200, { ok: true, orderId, message: 'Approve the purchase in the Steam overlay.' });
}

/** POST /store/steam/finalize {orderId} - after Steam says the player approved: finalize, confirm and grant once. */
async function steamFinalize(req, res, body, ip) {
  if (req.method !== 'POST') return json(res, 405, { ok: false });
  if (broken) return json(res, 503, Object.assign({ retry: true }, CLOSED));
  const signedIn = authed(req);
  if (!signedIn) return json(res, 401, { ok: false, message: 'Signed out - sign in again with your recovery code.' });
  if (limited('steamfin|' + signedIn.id, 40, 600000) || limited('steamfinip|' + ip, 120, 600000)) return json(res, 429, { ok: false, retry: true, message: 'Slow down a little.' });
  const orderId = String(body.orderId || '');
  const key = 'steam:' + orderId;
  const rec = /^\d{6,19}$/.test(orderId) ? own(state.iap, key) : null;
  if (!rec || rec.platform !== 'steam' || rec.account !== signedIn.id) return json(res, 404, { ok: false, final: true, message: 'We couldn\'t find that Steam purchase on your account.' });
  if (rec.status === 'granted' || rec.status === 'revoked') return iapReply(res, rec.status === 'granted' ? 'already' : 'revoked', key, signedIn.id);
  if (!verify.steamConfig().ready) return iapRetry(res, 'Steam purchases are resting on the server - yours is safe and will be added later.', 'a Steam purchase is waiting but Steam purchases are switched off on the server (STEAM_WEB_API_KEY / STEAM_APP_ID / STEAM_SANDBOX)');
  try { await verify.steamFinalizeTxn(orderId); } catch (err) { console.error('store steam finalize:', err && err.message); /* maybe already finalized - ask Steam */ }
  let q;
  try { q = await verify.steamQueryTxn(orderId); } catch (err) { return iapProblem(res, err, 'steam query'); }
  const status = String(q.status || '');
  if (status === 'Init' || status === 'Approved') {
    return json(res, 202, { ok: false, retry: true, message: status === 'Init' ? 'Steam hasn\'t confirmed this purchase yet.' : 'Steam is still finishing your purchase - we\'ll try again shortly.' });
  }
  const item = Array.isArray(q.items) && q.items[0] ? q.items[0] : {};
  const matches = String(q.steamid || '') === rec.steamid && Number(item.itemid) === rec.itemId;
  if (status !== 'Succeeded' || !matches) {
    if (status === 'Succeeded') iapAlert(`Steam order ${orderId} succeeded but its item/steamid doesn't match what we started - nothing granted, check it`);
    try { transact(() => { const r = own(state.iap, key); if (r && r.status !== 'granted') { r.status = 'failed'; r.problem = 'Steam says ' + status + (matches ? '' : ' (item/steamid mismatch)'); } }); } catch { /* nothing granted either way */ }
    return json(res, 409, { ok: false, final: true, message: 'Steam says this purchase didn\'t go through, so nothing was added.' });
  }
  const account = own(state.accounts, signedIn.id);
  const p = iapById(rec.product);
  if (!account || !p) return json(res, 500, { ok: false, retry: true, message: 'Something went wrong - try again in a minute.' });
  const out = transact(credit => grantIap(key, { platform: 'steam', transId: String(q.transid || rec.transId || ''), currency: String(q.currency || rec.currency || ''),
    paid: Number(item.amount) || 0, sandbox: !!rec.sandbox }, p, account, credit));
  iapReply(res, out, key, account.id);
}

/** Google: acknowledge a purchase we granted if Google still says it isn't (Google refunds unacknowledged ones after 3 days). */
async function googleAckIfNeeded(p, token, purchase) {
  try {
    const pur = purchase || await verify.googleGetPurchase(p.storeId, token);
    if (Number(pur.purchaseState) === 0 && Number(pur.acknowledgementState) === 0 && Number(pur.consumptionState) === 0) await verify.googleAcknowledge(p.storeId, token);
  } catch (err) { console.error('store google acknowledge:', err && err.message); }
}

/** POST /store/iap/verify - a Google Play or App Store purchase: check it with the store, grant once, return the balance. */
async function iapVerify(req, res, body, ip) {
  if (req.method !== 'POST') return json(res, 405, { ok: false });
  if (!isOpen()) return json(res, 503, Object.assign({ retry: true }, CLOSED));
  const signedIn = authed(req);
  if (!signedIn) return json(res, 401, { ok: false, retry: true, message: 'Signed out - sign in again with your recovery code. Your purchase is safe.' });
  if (signedIn.banned) return json(res, 403, { ok: false, retry: true, message: 'This account can\'t shop right now. Contact support.' });
  if (limited('iapv|' + signedIn.id, 30, 60000) || limited('iapvip|' + ip, 60, 60000)) return json(res, 429, { ok: false, retry: true, message: 'Slow down a little.' });
  const platform = String(body.platform || '');

  if (platform === 'google') {
    if (!verify.googleConfig().ready) return iapRetry(res, 'Google Play purchases aren\'t switched on on the server yet. Yours is safe and will be added later.', 'a Google Play purchase is waiting but GOOGLE_SERVICE_ACCOUNT_JSON isn\'t set up');
    const p = iapById(body.productId);
    if (!p) return iapRetry(res, 'We don\'t know that product yet - it will be added once the game updates.', 'the game sent an unknown Google product id: ' + String(body.productId || '').slice(0, 80));
    const token = String(body.purchaseToken || '');
    if (!/^[A-Za-z0-9._:-]{20,700}$/.test(token)) return iapRetry(res, 'We couldn\'t read that purchase yet - it will be tried again.');
    const key = 'google:' + sha('gp|' + token);
    const known = own(state.iap, key);
    if (known && (known.status === 'granted' || known.status === 'revoked')) {
      const out = known.status === 'revoked' ? 'revoked' : known.account === signedIn.id ? 'already' : 'other';
      if (out === 'already') await googleAckIfNeeded(p, token);   // Round 69 (review): the first acknowledge may have failed
      return iapReply(res, out, key, signedIn.id);
    }
    let purchase;
    try { purchase = await verify.googleGetPurchase(p.storeId, token); } catch (err) { return iapProblem(res, err, 'google verify'); }
    const state0 = Number(purchase.purchaseState);
    if (state0 === 2) return json(res, 202, { ok: false, retry: true, message: 'Google Play is still waiting for the payment - it will be added once it goes through.' });
    if (state0 !== 0) return json(res, 409, { ok: false, final: true, message: 'Google Play says this purchase was cancelled, so nothing was added.' });
    if (purchase.productId && purchase.productId !== p.storeId) return iapRetry(res, '', 'Google says purchase is for ' + String(purchase.productId).slice(0, 80) + ' but the game said ' + p.storeId);
    if (wrongAccount(res, purchase.obfuscatedExternalAccountId, signedIn.id)) return;   // Round 69 (review)
    const account = own(state.accounts, signedIn.id);
    if (!account) return json(res, 500, { ok: false, retry: true, message: 'Something went wrong - try again in a minute.' });
    const test = Number(purchase.purchaseType) === 0;   // a license tester: free - marked as a test purchase
    const out = transact(credit => grantIap(key, { platform: 'google', token, orderId: String(purchase.orderId || '').slice(0, 80), test, sandbox: test,
      region: String(purchase.regionCode || '').slice(0, 4), qty: purchase.quantity }, p, account, credit));
    if (out === 'granted') await googleAckIfNeeded(p, token, purchase);
    return iapReply(res, out, key, account.id);
  }

  if (platform === 'apple') {
    const cfg = verify.appleConfig();
    let jws = String(body.jws || '');
    const tid = String(body.transactionId || '');
    // Round 69 (review): no transaction id yet (StoreKit can hand one over late) - keep it and try again.
    if (!/^\d{1,30}$/.test(tid) && !jws) return iapRetry(res, 'The App Store hasn\'t given us this purchase\'s details yet - it will be tried again.');
    if (jws.length > 16000) return json(res, 400, { ok: false, final: true, message: 'That purchase receipt is damaged.' });
    if (tid) {
      const known = own(state.iap, 'apple:' + tid);
      if (known && (known.status === 'granted' || known.status === 'revoked')) return iapReply(res, known.status === 'revoked' ? 'revoked' : known.account === signedIn.id ? 'already' : 'other', known.key, signedIn.id);
    }
    const fromApple = !jws;   // fetched from Apple's own API below: any failure to verify it is OUR problem, not a fake
    if (fromApple) {
      if (!cfg.lookup) return iapRetry(res, 'App Store purchases aren\'t switched on on the server yet. Yours is safe and will be added later.', 'an App Store purchase is waiting but APPLE_ISSUER_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY aren\'t set up');
      try { jws = await verify.appleLookup(tid); } catch (err) { return iapProblem(res, err, 'apple lookup'); }
    }
    let tx;
    try { tx = verify.verifyAppleJws(jws); } catch (err) {
      if (fromApple) return iapRetry(res, '', 'a transaction from Apple\'s own API failed our signature check (' + (err && err.message) + ') - check the server');
      return iapProblem(res, err, 'apple verify');
    }
    if (tid && String(tx.transactionId) !== tid) return iapRetry(res, '', `Apple returned transaction ${String(tx.transactionId).slice(0, 30)} for ${tid}`);
    if (tx.bundleId !== cfg.bundleId) return iapRetry(res, '', `App Store purchase for bundle "${String(tx.bundleId).slice(0, 80)}" but APPLE_BUNDLE_ID is "${cfg.bundleId}"`);
    const sandbox = tx.environment !== 'Production';
    if (sandbox && !(cfg.allowSandbox && tx.environment === 'Sandbox')) return json(res, 409, { ok: false, final: true, message: 'Test (sandbox) purchases aren\'t accepted by this server.' });
    if (tx.revocationDate) return json(res, 409, { ok: false, final: true, message: 'Apple says this purchase was refunded, so nothing was added.' });
    const p = iapById(tx.productId);
    if (!p) return iapRetry(res, 'We don\'t know that product yet - it will be added once the game updates.', 'unknown App Store product id: ' + String(tx.productId).slice(0, 80));
    if (wrongAccount(res, tx.appAccountToken, signedIn.id)) return;   // Round 69 (review)
    const nonConsumable = tx.type === 'Non-Consumable';
    const key = 'apple:' + String(nonConsumable ? tx.originalTransactionId : tx.transactionId);
    const account = own(state.accounts, signedIn.id);
    if (!account) return json(res, 500, { ok: false, retry: true, message: 'Something went wrong - try again in a minute.' });
    const out = transact(credit => grantIap(key, { platform: 'apple', transactionId: String(tx.transactionId), originalTransactionId: String(tx.originalTransactionId || ''),
      env: String(tx.environment || ''), sandbox, qty: tx.quantity }, p, account, credit));
    return iapReply(res, out, key, account.id);
  }

  return json(res, 400, { ok: false, final: true, message: 'Unknown store.' });
}

// ---- Round 69 (review): refunds arrive by themselves - Google Real-time Developer Notifications and App Store
// Server Notifications V2 - plus an automatic refund check every 6 hours.
/** POST /store/google/rtdn?secret=GOOGLE_RTDN_SECRET - a Pub/Sub push message from Google Play. */
async function googleRtdn(req, res, body) {
  if (req.method !== 'POST') return json(res, 405, { ok: false });
  const want = String(process.env.GOOGLE_RTDN_SECRET || '');
  if (want.length < 16) return json(res, 503, { ok: false, message: 'GOOGLE_RTDN_SECRET is not set' });
  const got = new URL(req.url, 'http://relay').searchParams.get('secret') || '';
  if (!same(got, want)) return json(res, 403, { ok: false });
  let data = null;
  try { data = JSON.parse(Buffer.from(String((body.message && body.message.data) || ''), 'base64').toString('utf8')); } catch { data = null; }
  if (!data || typeof data !== 'object') return json(res, 200, { ok: true, ignored: true });   // (a 2xx stops Pub/Sub re-sending junk)
  if (data.packageName && data.packageName !== verify.googleConfig().packageName) {
    iapAlert(`a Google notification for package "${String(data.packageName).slice(0, 80)}" arrived, but GOOGLE_PACKAGE_NAME is "${verify.googleConfig().packageName}"`);
    return json(res, 200, { ok: true, ignored: true });
  }
  const v = data.voidedPurchaseNotification;
  if (v && v.purchaseToken) {
    const key = 'google:' + sha('gp|' + String(v.purchaseToken));
    const rec = own(state.iap, key);
    if (rec && rec.status === 'granted') {
      try { transact(c => revokeIap(own(state.iap, key), 'Google Play: refunded (notification)', c)); } catch (err) {
        console.error('store google rtdn:', err && err.message);
        return json(res, 500, { ok: false });   // Pub/Sub tries again
      }
    }
  }
  json(res, 200, { ok: true });
}

/** POST /store/apple/notify - App Store Server Notifications V2 ({ signedPayload }), checked with Apple's certificate chain. */
async function appleNotify(req, res, body) {
  if (req.method !== 'POST') return json(res, 405, { ok: false });
  let n;
  try { n = verify.verifyAppleJws(String(body.signedPayload || '')); } catch (err) {
    console.error('store apple notify:', err && err.message);
    return json(res, 400, { ok: false });
  }
  const d = (n && n.data) || {};
  const cfg = verify.appleConfig();
  if (d.bundleId && d.bundleId !== cfg.bundleId) {
    iapAlert(`an App Store notification for bundle "${String(d.bundleId).slice(0, 80)}" arrived, but APPLE_BUNDLE_ID is "${cfg.bundleId}"`);
    return json(res, 200, { ok: true, ignored: true });
  }
  if ((n.notificationType === 'REFUND' || n.notificationType === 'REVOKE') && d.signedTransactionInfo) {
    let tx;
    try { tx = verify.verifyAppleJws(d.signedTransactionInfo); } catch (err) { console.error('store apple notify tx:', err && err.message); return json(res, 400, { ok: false }); }
    for (const key of ['apple:' + tx.transactionId, 'apple:' + tx.originalTransactionId]) {
      const rec = own(state.iap, key);
      if (!rec || rec.status !== 'granted') continue;
      try { transact(c => revokeIap(own(state.iap, key), 'App Store: ' + n.notificationType.toLowerCase() + ' (notification)', c)); } catch (err) {
        console.error('store apple notify:', err && err.message);
        return json(res, 500, { ok: false });   // Apple tries again
      }
    }
  }
  json(res, 200, { ok: true });
}

/** The admin's "check for refunds" (and every 6 hours by itself): Steam (QueryTxn), Google Play (voided purchases), Apple (if the key is set). */
async function iapRefundCheck() {
  if (iapCheck.running) return;
  iapCheck = { running: true, at: iapCheck.at, note: iapCheck.note };
  const notes = [];
  let taken = 0;
  const since = Date.now() - IAP_REFUND_LOOKBACK;
  const recent = platform => Object.values(state.iap || {}).filter(r => r.platform === platform && r.status === 'granted' && Date.parse(r.grantedAt || r.at || 0) > since);
  const takeBack = (key, why) => {
    try { if (transact(c => revokeIap(own(state.iap, key), why, c)) === 'revoked') taken++; } catch (err) { notes.push('could not save: ' + (err && err.message)); }
  };
  try {
    if (verify.steamConfig().ready) {
      let checked = 0, errors = 0;
      for (const r of recent('steam').slice(-150)) {
        try {
          const q = await verify.steamQueryTxn(r.orderId);
          checked++;
          if (verify.STEAM_REFUNDED.has(String(q.status))) takeBack(r.key, 'Steam: ' + q.status);
        } catch { if (++errors >= 5) break; }
      }
      notes.push(`Steam: ${checked} checked${errors ? ', ' + errors + ' errors' : ''}`);
    }
    if (verify.googleConfig().ready) {
      try {
        const voided = await verify.googleVoided(30);
        const keys = new Set(voided.map(v => 'google:' + sha('gp|' + v.purchaseToken)));
        for (const r of recent('google')) if (keys.has(r.key)) takeBack(r.key, 'Google Play: voided');
        notes.push(`Google Play: ${voided.length} refunds/cancellations listed`);
      } catch (err) { notes.push('Google Play: ' + (err && err.message)); }
    }
    if (verify.appleConfig().lookup) {
      let checked = 0, errors = 0;
      for (const r of recent('apple').slice(-60)) {
        try {
          const tx = verify.verifyAppleJws(await verify.appleLookup(r.transactionId));
          checked++;
          if (tx.revocationDate) takeBack(r.key, 'App Store: refunded');
        } catch { if (++errors >= 5) break; }
      }
      notes.push(`App Store: ${checked} checked${errors ? ', ' + errors + ' errors' : ''}`);
    }
  } catch (err) {
    notes.push('stopped: ' + (err && err.message));
  }
  iapCheck = { running: false, at: new Date().toISOString(), note: `${taken} purchase${taken === 1 ? '' : 's'} taken back. ` + (notes.join(' · ') || 'No store is set up yet.') };
}

// Round 69 (review): the refund check runs by itself - 10 minutes after starting, then every 6 hours.
const IAP_AUTO_CHECK_MS = 6 * 3600000;
function iapAutoCheck() {
  if (broken || !persistent() || !Object.keys(state.iap || {}).length) return;
  iapRefundCheck().catch(err => console.error('store refund check:', err && err.message));
}
setTimeout(() => { iapAutoCheck(); setInterval(iapAutoCheck, IAP_AUTO_CHECK_MS).unref(); }, 600000).unref();

function iapAdminSection(hidden, button) {
  const esc = pay().escapeHtml;
  const s = verify.steamConfig(), g = verify.googleConfig(), a = verify.appleConfig();
  const recs = Object.values(state.iap || {});
  const granted = recs.filter(r => r.status === 'granted');
  const real = granted.filter(r => !r.sandbox);
  const tests = granted.filter(r => r.sandbox);
  const sum = list => money(list.reduce((t, r) => t + (Number(r.cents) || 0), 0));
  const count = pl => { const l = real.filter(r => r.platform === pl); return `${l.length} (${sum(l)})`; };
  const yes = (ok, words) => ok ? `<span class="on">ready</span>${words ? ' <span class="small">' + words + '</span>' : ''}` : `<span class="off">${words || 'not set'}</span>`;
  const rtdn = String(process.env.GOOGLE_RTDN_SECRET || '').length >= 16;
  const base = pay().baseUrl() || 'https://YOUR-SERVER';
  const alerts = iapAlerts.length ? `<div style="border:2px solid #ff5252;border-radius:8px;padding:10px;margin:8px 0"><b class="off">Purchases need your attention</b>
<p class="small">These purchases are being KEPT (the game keeps retrying) until the problem is fixed:</p><ul>${iapAlerts.slice().reverse().map(x =>
    `<li class="small">${esc(x.text)} <i>(${x.count}x, last ${esc(x.last.slice(0, 16).replace('T', ' '))})</i></li>`).join('')}</ul>
<form method="post" action="/admin">${hidden}<input type="hidden" name="action" value="iap-clear-alerts"><button type="submit">Fixed - clear these</button></form></div>` : '';
  const setup = `<table>
<tr><td>Steam (STEAM_WEB_API_KEY + STEAM_APP_ID)</td><td>${s.sandboxBlocked ? '<span class="off">OFF: STEAM_SANDBOX=1 on the live server - remove it (or set ALLOW_STEAM_SANDBOX_IN_PROD=1 to test)</span>'
    : yes(s.ready, s.ready ? (s.sandbox ? 'SANDBOX - free test purchases (STEAM_SANDBOX=1)' : 'live') : !s.keySet ? 'add STEAM_WEB_API_KEY' : !s.appIdSet ? 'add STEAM_APP_ID' : 'check the key / App ID')}</td></tr>
<tr><td>Google Play (GOOGLE_SERVICE_ACCOUNT_JSON)</td><td>${yes(g.ready, g.ready ? 'package ' + esc(g.packageName) : g.set ? 'that JSON key doesn\'t look right - paste the whole file' : 'not set')}</td></tr>
<tr><td>Google refund notifications (GOOGLE_RTDN_SECRET)</td><td>${rtdn ? '<span class="on">ready</span> <span class="small">Pub/Sub push URL: ' + esc(base) + '/store/google/rtdn?secret=(your secret)</span>' : '<span class="small">not set (refunds are still found by the 6-hourly check)</span>'}</td></tr>
<tr><td>App Store (APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY)</td><td>${yes(a.lookup, a.lookup ? 'bundle ' + esc(a.bundleId) + (a.allowSandbox ? ' &middot; sandbox (test) purchases accepted' : '') : a.keySet ? 'the key doesn\'t look right' : 'not set')}</td></tr>
<tr><td>App Store refund notifications</td><td><span class="small">In App Store Connect set the Server Notifications URL (Version 2) to ${esc(base)}/store/apple/notify</span></td></tr>
<tr><td>Big Night passes in the app stores (BIGNIGHT_MODE=paid)</td><td>${bigNightIapSales() ? '<span class="on">on sale</span>' : '<span class="small">not on sale</span>'}</td></tr>
</table>`;
  const ids = IAP_PRODUCTS.map(p => { const v = iapPublic(p); return `<tr><td><b>${esc(v.label)}</b></td><td><span class="small">${esc(p.storeId)}<br>Steam item ${p.steamItem}</span></td><td>${v.price}</td></tr>`; }).join('');
  const latest = recs.filter(r => r.status === 'granted' || r.status === 'revoked')
    .sort((x, y) => String(y.grantedAt || y.at || '').localeCompare(String(x.grantedAt || x.at || ''))).slice(0, 40).map(r => {
      const acc = own(state.accounts, r.account);
      const where = esc(r.platform) + (r.sandbox ? ' <b>TEST</b>' : '') + (r.currency && r.currency !== 'USD' ? ' &middot; ' + esc(r.currency) + ' ' + ((Number(r.amount) || 0) / 100).toFixed(2) : '');
      return `<tr><td><span class="small">${esc(String(r.grantedAt || r.at || '').slice(0, 16).replace('T', ' '))}<br>${where}</span></td>
<td>${esc(acc ? acc.name : r.account)}<br><span class="small">${esc(r.account)}</span></td>
<td>${esc(r.product)}<br><span class="small">${money(Number(r.cents) || 0)}${r.kind === 'shards' ? ' &middot; ' + (r.shards || 0) + ' shards' : ''}</span></td>
<td>${r.status === 'granted' ? '<span class="on">granted</span><br>' + button('iap-revoke', r.key, 'Revoke', '#ff8a80') : '<span class="off">revoked</span><br><span class="small">' + esc(r.revokeWhy || '') + '</span>'}</td></tr>`;
    }).join('');
  return `<h2>App store purchases (Steam, Google Play, App Store)</h2>
${alerts}${setup}
<p class="small">Paid: Steam ${count('steam')} &middot; Google Play ${count('google')} &middot; App Store ${count('apple')} (list prices in USD, before each store's cut).
TEST purchases (free - sandbox / Google testers / Steam sandbox): ${tests.length}.</p>
${tests.length ? `<form method="post" action="/admin">${hidden}<input type="hidden" name="action" value="iap-revoke-tests"><button type="submit" style="background:#ff8a80">Take back all ${tests.length} TEST purchases</button>
<span class="small">Apple's reviewers and your testers buy for free - their shards are marked TEST.</span></form>` : ''}
<h2 style="font-size:15px">Product ids (make these in Play Console / App Store Connect, same prices)</h2><table>${ids}</table>
<form method="post" action="/admin" style="margin-top:6px">${hidden}<input type="hidden" name="action" value="iap-refund-check"><button type="submit">Check Steam, Google Play and the App Store for refunds now</button>
<span class="small">${iapCheck.running ? 'checking now - reload in a minute' : iapCheck.at ? 'last check ' + esc(iapCheck.at.slice(0, 16).replace('T', ' ')) + ': ' + esc(iapCheck.note) : 'This also runs by itself every 6 hours.'}</span></form>
<h2 style="font-size:15px">Latest store purchases</h2><table>${latest || '<tr><td class="small">None yet.</td></tr>'}</table>
<p class="small">"Revoke" takes a purchase back (shards are removed, a pass stops working).</p>`;
}

function iapAdminAction(action, item, note, run) {
  if (action === 'iap-refund-check') {
    if (iapCheck.running) return 'Already checking - reload in a minute.';
    iapRefundCheck().catch(err => { iapCheck = { running: false, at: new Date().toISOString(), note: 'stopped: ' + (err && err.message) }; });
    return 'Checking Steam, Google Play and the App Store for refunds - reload this page in a minute to see what was found.';
  }
  if (action === 'iap-revoke') {
    const rec = own(state.iap || {}, item);
    if (!rec || rec.status !== 'granted') return 'That purchase isn\'t granted (already revoked?).';
    return run(c => { revokeIap(rec, note || 'revoked by admin', c); return `Revoked ${rec.platform} purchase ${rec.product} for account ${rec.account}.`; });
  }
  if (action === 'iap-revoke-tests') {   // Round 69 (review)
    const list = Object.values(state.iap || {}).filter(r => r.status === 'granted' && r.sandbox);
    if (!list.length) return 'No test purchases to take back.';
    return run(c => { for (const r of list) revokeIap(r, 'test purchase taken back by admin', c); return `Took back ${list.length} TEST purchase${list.length === 1 ? '' : 's'}.`; });
  }
  if (action === 'iap-clear-alerts') { iapAlerts = []; return 'Alerts cleared.'; }   // Round 69 (review)
  return null;
}

// ============================================================================ request plumbing
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type'
};

function json(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS));
  res.end(JSON.stringify(obj));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooBig = false;
    req.on('data', chunk => {
      if (tooBig) return;
      size += chunk.length;
      if (size > limit) { tooBig = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req, limit) {
  return readRaw(req, limit || 8192).then(raw => {
    if (!raw) return null;
    try { const v = JSON.parse(raw.toString('utf8') || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  });
}

/** Runs an API call: parse the body, answer JSON, never crash the server. */
function api(req, res, work, limit) {
  const go = body => {
    try {
      const out = work(body || {});
      if (out && typeof out.then === 'function') {
        out.catch(err => { console.error('store api', err && err.message); json(res, 500, { ok: false, message: 'Something went wrong on the server - try again in a minute.' }); });
      }
    } catch (err) {
      console.error('store api', err && err.message);
      json(res, 500, { ok: false, message: 'Something went wrong on the server - try again in a minute.' });
    }
  };
  if (req.method === 'POST') readJson(req, limit).then(body => body === null ? json(res, 413, { ok: false, message: 'Too big.' }) : go(body)).catch(() => json(res, 400, { ok: false }));
  else go({});
}

const CLOSED = { ok: false, message: 'The Moon Shards store is closed right now.' };

// ============================================================================ the routes
/** Handles /store/... and /vendor... Returns true if it answered the request. */
function handle(req, res) {
  const route = String(req.url || '').split('?')[0];
  if (!route.startsWith('/store/') && route !== '/vendor' && !route.startsWith('/vendor/')) return false;

  if (req.method === 'OPTIONS' && route.startsWith('/store/')) {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  const ip = ipOf(req);
  switch (route) {
    case '/store/catalog':
      if (limited('cat|' + ip, 120, 60000)) { json(res, 429, { ok: false, message: 'Slow down a little.' }); return true; }
      json(res, 200, catalog());
      return true;

    case '/store/webhook':
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return true; }
      webhook(req, res);
      return true;

    case '/store/account/create':
      api(req, res, body => {
        if (req.method !== 'POST') return json(res, 405, { ok: false });
        if (!isOpen()) return json(res, 503, CLOSED);
        if (limited('create|' + ip, 5, 3600000)) return json(res, 429, { ok: false, message: 'Too many new accounts from here - try again later.' });
        const name = cleanName(body.name, 20);
        const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
        if (name.length < 2) return json(res, 400, { ok: false, message: 'Pick a display name (2 to 20 letters).' });
        if (rude(name)) return json(res, 400, { ok: false, message: "That name isn't allowed - try another." });
        if (!/^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/.test(email)) return json(res, 400, { ok: false, message: 'That email address doesn\'t look right.' });
        if (Object.keys(state.accounts).length >= MAX_ACCOUNTS) return json(res, 503, { ok: false, message: 'Sign-ups are full right now.' });
        const out = transact(credit => {
          let id;
          do { id = 'A' + randomCode(12); } while (state.accounts[id]);
          const account = { id, name, email, created: new Date().toISOString(), shards: 0, owned: [], tokens: [], recoveryHash: '' };
          state.accounts[id] = account;
          const token = newToken(account);
          const recovery = newRecovery(account);
          credit({ type: 'account', account: id });
          return { account, token, recovery };
        });
        json(res, 200, { ok: true, account: publicAccount(out.account), token: out.token, recovery: out.recovery });
      });
      return true;

    case '/store/account/link':
      api(req, res, body => {
        if (req.method !== 'POST') return json(res, 405, { ok: false });
        if (broken) return json(res, 503, CLOSED);
        if (limited('link|' + ip, 10, 3600000)) return json(res, 429, { ok: false, message: 'Too many tries - wait an hour and try again.' });
        const flat = flatCode(body.code);
        const id = flat.length === 16 ? state.recovery[sha('rec|' + flat)] : null;
        const account = id && state.accounts[id];
        if (!account) return json(res, 404, { ok: false, message: "That recovery code didn't work. Check it and try again." });
        const token = transact(() => newToken(account));
        json(res, 200, { ok: true, account: publicAccount(account), token });
      });
      return true;

    case '/store/me':
      api(req, res, () => {
        const account = authed(req);
        if (!account) return json(res, 401, { ok: false, message: 'Signed out - sign in again with your recovery code.' });
        json(res, 200, { ok: true, account: publicAccount(account) });
      });
      return true;

    case '/store/account/recovery':
      api(req, res, () => {
        if (req.method !== 'POST') return json(res, 405, { ok: false });
        const account = authed(req);
        if (!account) return json(res, 401, { ok: false, message: 'Signed out.' });
        if (limited('rec|' + account.id, 5, DAY)) return json(res, 429, { ok: false, message: 'Try again tomorrow.' });
        const recovery = transact(() => newRecovery(account));
        json(res, 200, { ok: true, account: publicAccount(account), recovery });
      });
      return true;

    case '/store/account/signout':
      api(req, res, () => {
        if (req.method !== 'POST') return json(res, 405, { ok: false });
        const account = authed(req);
        if (!account) return json(res, 200, { ok: true });
        const m = /\.([a-f0-9]{64})$/.exec(String(req.headers.authorization || ''));
        const h = m ? sha('tok|' + m[1]) : '';
        transact(() => { account.tokens = account.tokens.filter(t => t.h !== h); });
        json(res, 200, { ok: true });
      });
      return true;

    case '/store/buy':
      api(req, res, body => {
        if (req.method !== 'POST') return json(res, 405, { ok: false });
        if (!isOpen()) return json(res, 503, CLOSED);
        const account = authed(req);
        if (!account) return json(res, 401, { ok: false, message: 'Signed out - sign in again with your recovery code.' });
        if (account.banned) return json(res, 403, { ok: false, message: 'This account can\'t shop right now. Contact support.' });
        if (limited('buy|' + account.id, 30, 60000)) return json(res, 429, { ok: false, message: 'Slow down a little.' });
        const item = findItem(String(body.item || ''));
        if (!item) return json(res, 404, { ok: false, message: "That isn't for sale any more.", account: publicAccount(account) });
        if (account.owned.includes(item.id)) return json(res, 200, { ok: true, already: true, account: publicAccount(account) });
        if (body.price != null && Number(body.price) !== item.price) {
          return json(res, 409, { ok: false, message: `The price is now ${item.price} shards - have another look.`, price: item.price, account: publicAccount(account) });
        }
        if (account.shards < item.price) {
          return json(res, 402, { ok: false, message: `You need ${item.price - account.shards} more ${CURRENCY}.`, price: item.price, account: publicAccount(account) });
        }
        if (account.owned.length >= MAX_OWNED) return json(res, 400, { ok: false, message: 'Your wardrobe is full.' });
        transact(credit => {
          account.shards -= item.price;
          account.owned.push(item.id);
          const entry = { type: 'spend', account: account.id, shards: -item.price, balance: account.shards, item: item.id };
          if (item.design) {
            const share = Math.floor(item.price * sharePercent() / 100);
            item.vendor.earned = (item.vendor.earned || 0) + share;
            item.design.sales = (item.design.sales || 0) + 1;
            entry.vendor = item.vendor.id;
            entry.vendorShare = share;
          }
          credit(entry);
        });
        json(res, 200, { ok: true, account: publicAccount(account), price: item.price });
      });
      return true;

    case '/store/checkout':
      api(req, res, body => {
        if (req.method !== 'POST') return json(res, 405, { ok: false });
        if (!checkoutReady()) return json(res, 503, { ok: false, message: "Buying shards isn't switched on yet." });
        if (String(body.platform || '') === 'ios' || String(body.platform || '') === 'android' || String(body.platform || '') === 'steam') {   // Round 69: + steam
          return json(res, 403, { ok: false, message: 'In this version of the game, shards come through its own store (Steam, App Store or Google Play).' });
        }
        const account = authed(req);
        if (!account) return json(res, 401, { ok: false, message: 'Signed out - sign in again with your recovery code.' });
        if (account.banned) return json(res, 403, { ok: false, message: 'This account can\'t shop right now.' });
        const pack = packById(String(body.pack || ''));
        if (!pack) return json(res, 404, { ok: false, message: 'That pack isn\'t on sale.' });
        if (limited('co|' + account.id, 10, 3600000)) return json(res, 429, { ok: false, message: 'Too many checkouts started - try again in a while.' });
        const base = pay().baseUrl();
        const total = pack.shards + pack.bonus;
        const meta = { kind: 'shards', account: account.id, pack: pack.id };
        return stripe().checkout.sessions.create({
          mode: 'payment',
          line_items: [{
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: pack.cents,
              product_data: {
                name: `${total.toLocaleString('en-US')} ${CURRENCY}`,
                description: 'Game credits for New Moon, Same Dark (account ' + account.id + '). No cash value.'
              }
            }
          }],
          client_reference_id: account.id,
          metadata: meta,
          payment_intent_data: { metadata: meta, description: `New Moon, Same Dark - ${total} ${CURRENCY}` },
          success_url: `${base}/store/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/store/cancel`
        }).then(session => {
          transact(() => { state.orders[session.id] = { kind: 'shards', account: account.id, pack: pack.id, shards: total, cents: pack.cents, status: 'open', at: new Date().toISOString() }; });
          json(res, 200, { ok: true, url: session.url });
        });
      });
      return true;

    // Round 58: buying a Big Night pass - with real money (Stripe's checkout page) or with Moon Shards.
    case '/store/bignight/checkout':
      api(req, res, body => {
        if (req.method !== 'POST') return json(res, 405, { ok: false });
        if (!bigNightStripeSales()) return json(res, 503, { ok: false, message: bigNightClosedWords() });
        if (String(body.platform || '') === 'ios' || String(body.platform || '') === 'android') {
          return json(res, 403, { ok: false, message: 'Passes can\'t be bought inside the phone app. A pass bought on the PC or web game works here too.' });
        }
        const account = authed(req);
        if (!account) return json(res, 401, { ok: false, message: 'Signed out - sign in again with your recovery code.' });
        if (account.banned) return json(res, 403, { ok: false, message: 'This account can\'t shop right now.' });
        if (readyPasses(account) >= MAX_READY_PASSES) return json(res, 400, { ok: false, message: `You already have ${MAX_READY_PASSES} passes waiting - use one first.` });
        if (limited('co|' + account.id, 10, 3600000)) return json(res, 429, { ok: false, message: 'Too many checkouts started - try again in a while.' });
        const cfg = bigNightConfig();
        const base = pay().baseUrl();
        const meta = { kind: 'bignight', account: account.id };
        return stripe().checkout.sessions.create({
          mode: 'payment',
          line_items: [{ price: cfg.priceId, quantity: 1 }],
          client_reference_id: account.id,
          metadata: meta,
          payment_intent_data: { metadata: meta, description: 'New Moon, Same Dark - Big Night pass (account ' + account.id + ')' },
          success_url: `${base}/store/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/store/cancel`
        }).then(session => {
          try { transact(() => { state.orders[session.id] = { kind: 'bignight', account: account.id, status: 'open', cents: bigPrice.cents || cfg.cents, at: new Date().toISOString() }; }); } catch { /* the webhook still grants it */ }
          json(res, 200, { ok: true, url: session.url });
        });
      });
      return true;

    case '/store/bignight/shards':
      api(req, res, body => {
        if (req.method !== 'POST') return json(res, 405, { ok: false });
        if (!bigNightShardSales()) return json(res, 503, { ok: false, message: bigNightClosedWords() });
        const account = authed(req);
        if (!account) return json(res, 401, { ok: false, message: 'Signed out - sign in again with your recovery code.' });
        if (account.banned) return json(res, 403, { ok: false, message: 'This account can\'t shop right now.' });
        if (limited('buy|' + account.id, 30, 60000)) return json(res, 429, { ok: false, message: 'Slow down a little.' });
        const price = bigNightConfig().shards;
        if (body.price != null && Number(body.price) !== price) {
          return json(res, 409, { ok: false, message: `A Big Night pass is now ${price} shards - have another look.`, price, account: publicAccount(account) });
        }
        if (readyPasses(account) >= MAX_READY_PASSES) return json(res, 400, { ok: false, message: `You already have ${MAX_READY_PASSES} passes waiting - use one first.`, account: publicAccount(account) });
        if (account.shards < price) {
          return json(res, 402, { ok: false, message: `You need ${price - account.shards} more ${CURRENCY} for a Big Night pass.`, price, account: publicAccount(account) });
        }
        transact(credit => {
          account.shards -= price;
          credit({ type: 'spend', account: account.id, shards: -price, balance: account.shards, item: 'bignight-pass' });
          addPass(account, 'shards', { shards: price }, credit);
        });
        json(res, 200, { ok: true, account: publicAccount(account), price });
      });
      return true;

    // Round 69: Steam, Google Play and App Store purchases (checked with the store, granted once)
    case '/store/steam/init':
      api(req, res, body => steamInit(req, res, body, ip), 16384);
      return true;

    case '/store/steam/finalize':
      api(req, res, body => steamFinalize(req, res, body, ip));
      return true;

    case '/store/iap/verify':
      api(req, res, body => iapVerify(req, res, body, ip), 32768);
      return true;

    // Round 69 (review): refunds pushed by the stores
    case '/store/google/rtdn':
      api(req, res, body => googleRtdn(req, res, body), 65536);
      return true;

    case '/store/apple/notify':
      api(req, res, body => appleNotify(req, res, body), 65536);
      return true;

    case '/store/success': {
      const s = stripe();
      const id = new URL(req.url, 'http://relay').searchParams.get('session_id') || '';
      if (!s || !/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) { thanks(res, 'Thank you!', 'You can close this page and go back to the game.'); return true; }
      s.checkout.sessions.retrieve(id).then(session => {
        const kind = session.metadata && session.metadata.kind;
        if (session.payment_status !== 'paid') {
          thanks(res, 'Almost there', 'Your payment is still going through. It usually takes a minute - your shards appear in the game by themselves.');
          return;
        }
        // Stripe itself says it's paid, so credit now too (the webhook does the same; whichever is first wins, once).
        let result = 'skip';
        try { result = transact(credit => kind === 'plan' ? activatePlan(session, credit) : kind === 'bignight' ? grantBigNightOrder(session, credit) : creditOrder(session, credit)); } catch (err) { console.error('store success', err && err.message); }
        if (kind === 'bignight') {
          // Round 58
          thanks(res, 'Your Big Night pass is ready!', `It's on your account now${result === 'granted' || result === 'already' ? '' : ' (or will be in a moment)'}. ` +
            'Go back to the game and choose <b>Big Night</b> when you host online. The 6 hours start when you open the room. Unused passes never expire.');
        } else if (kind === 'plan') {
          const v = state.vendors[session.metadata.vendor];
          thanks(res, 'Your plan is on!', `Thanks! ${v ? pay().escapeHtml(v.name) + "'s" : 'Your'} plan runs until ${v ? new Date(v.planUntil).toDateString() : 'the end of the season'}. Go back to your vendor page to send your designs.`);
        } else {
          const pack = packById(session.metadata && session.metadata.pack);
          thanks(res, 'Shards on the way!', `${pack ? (pack.shards + pack.bonus).toLocaleString('en-US') + ' ' : ''}${CURRENCY} ${result === 'credited' || result === 'already' ? 'are in your account' : 'will be in your account in a moment'}. ` +
            'Go back to the game - they show up by themselves (or press Refresh in the Store).');
        }
      }).catch(err => { console.error('store success', err && err.message); thanks(res, 'Thank you!', 'Your shards appear in the game in a minute or two. You can close this page.'); });
      return true;
    }

    case '/store/cancel':
      thanks(res, 'No problem', "You weren't charged. You can close this page and go back to the game.");
      return true;

    case '/store/terms':
      pay().page(res, 200, 'Moon Shards - the rules', `<h1>${CURRENCY} - the rules</h1>
<p>${CURRENCY} are game credits for New Moon, Same Dark. You get them in the game and spend them on outfit pieces, vendor designs and Big Night passes.</p>
<p><b>Festival tokens</b>, which you earn by playing, are separate: they can't be bought and can't become shards.</p>
<ul><li>Shards have no cash value and can't be sold, swapped or turned back into money.</li>
<li>They belong to your account. Keep your recovery code safe - it is the only way to sign in on a new device.</li>
<li>Purchases are final unless the law where you live says otherwise. If something went wrong, contact us.</li>
<li>Vendor designs are made by independent vendors and checked by us before they appear. Report anything that shouldn't be there from the game.</li>
<li>We can remove items or accounts that break these rules (cheating, abuse, chargebacks).</li></ul>
<p class="small">Questions: Daniel@MoonVisionMedia.com</p>`);
      return true;

    case '/store/report':
      api(req, res, body => {
        if (req.method !== 'POST') return json(res, 405, { ok: false });
        if (broken) return json(res, 503, CLOSED);
        const account = authed(req);
        const who = account ? account.id : 'ip:' + sha(ip).slice(0, 12);
        if (limited('rep|' + who, 10, 3600000) || limited('repip|' + ip, 20, 3600000)) return json(res, 429, { ok: false, message: 'Thanks - we have your reports. Try again later.' });
        const key = String(body.design || '');
        const designId = key.slice(key.indexOf('/') + 1);
        const d = own(state.designs, designId);   // Round 55 review: own entries only
        if (!d) return json(res, 404, { ok: false, message: "We couldn't find that design." });
        const reason = String(body.reason || '').replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, 200) || 'No reason given';
        if (state.reports.some(r => r.design === d.id && r.who === who && r.status === 'open')) return json(res, 200, { ok: true, message: 'Already reported - thank you.' });
        if (state.reports.filter(r => r.status === 'open').length >= MAX_REPORTS) return json(res, 200, { ok: true, message: 'Thanks - we will look at it.' });
        transact(() => {
          state.reports.push({ id: crypto.randomBytes(6).toString('hex'), design: d.id, vendor: d.vendor, who, reason, at: new Date().toISOString(), status: 'open' });
          if (state.reports.length > MAX_REPORTS * 2) state.reports = state.reports.filter(r => r.status === 'open').concat(state.reports.filter(r => r.status !== 'open').slice(-MAX_REPORTS));
        });
        json(res, 200, { ok: true, message: 'Thanks for telling us - we will take a look.' });
      });
      return true;
  }

  if (route === '/vendor' || route.startsWith('/vendor/')) {
    vendorPortal(req, res, route, ip);
    return true;
  }

  json(res, 404, { ok: false, message: 'Not found.' });
  return true;
}

function thanks(res, title, text) {
  pay().page(res, 200, title, `<h1>${pay().escapeHtml(title)}</h1><p>${text}</p>`);
}

// ============================================================================ the vendor portal
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function vendorByEmail(email) {
  const want = String(email || '').trim().toLowerCase();
  return Object.values(state.vendors).find(v => v.email === want) || null;
}

function vendorPortal(req, res, route, ip) {
  const p = pay();
  const esc = p.escapeHtml;
  if (!features().vendorPortal || !persistent() || broken) {
    p.page(res, 200, 'Vendors', '<h1>Vendor market</h1><p>Vendor applications are closed right now. Check back soon!</p>');
    return;
  }

  if (req.method !== 'POST') {
    if (route !== '/vendor') { res.writeHead(303, { location: '/vendor' }); res.end(); return; }
    p.page(res, 200, 'Sell your designs at the festival', portalHome());
    return;
  }

  p.readForm(req, 16384).then(form => {
    if (route === '/vendor/apply') return vendorApply(res, form, ip);
    // Everything else needs the vendor's email + password (carried in each form, like the admin page).
    if (limited('vlogin|' + ip, 40, 3600000)) { p.page(res, 429, 'Vendors', '<h1>Too many tries</h1><p>Wait an hour and try again.</p>'); return; }
    const vendor = vendorByEmail(form.get('email'));
    const password = String(form.get('password') || '');
    if (!vendor || !same(vendor.pass, hashPassword(password, vendor.salt))) {
      p.page(res, 403, 'Vendors', '<h1>Vendor sign in</h1><p>That email and password don\'t match.</p><a class="btn" href="/vendor">Back</a>');
      return;
    }
    const creds = `<input type="hidden" name="email" value="${esc(vendor.email)}"><input type="hidden" name="password" value="${esc(password)}">`;
    const action = String(form.get('action') || '');
    let note = '';
    if (action === 'plan') return vendorPlan(res, vendor, String(form.get('plan') || ''));
    if (action === 'design') note = vendorDesign(vendor, form);
    if (action === 'retire') note = vendorRetire(vendor, String(form.get('design') || ''));
    p.page(res, 200, vendor.name, vendorDashboard(vendor, creds, note));
  }).catch(err => {
    console.error('vendor portal', err && err.message);
    p.page(res, 500, 'Vendors', '<h1>Something went wrong</h1><p>Please try again in a minute.</p>');
  });
}

function portalHome() {
  const rows = PLANS.map(pl => `<tr><td><b>${pl.name}</b></td><td>${pl.slots} designs</td><td>${money(pl.cents)} a season</td></tr>`).join('');
  return `<h1>Sell your designs at the festival</h1>
<p>New Moon, Same Dark is a festival game. Real festival vendors can put a small, hand-picked range of their designs into the game,
where players buy the in-game versions with ${CURRENCY} and wear them in front of everyone. It's curated on purpose: a few vendors,
a few great designs each, every one checked before it goes live.</p>
<h2>How it works</h2>
<p><b>1.</b> Apply below. We look at every application.<br><b>2.</b> Once approved, sign in and choose a season plan.<br>
<b>3.</b> Send your designs (made here, or pasted from the game's Outfit Studio). Each one is checked before it appears.<br>
<b>4.</b> You earn ${sharePercent()}% of every sale of your designs; we pay you out each season.</p>
<table>${rows}</table><p class="small">A season is three months. Plans started in the last three weeks of a season run to the end of the next one.</p>
<h2>Apply</h2>
<form method="post" action="/vendor/apply">
<p>Your shop or brand name<br><input name="name" maxlength="32" required></p>
<p>Email (we reply here)<br><input name="email" type="email" maxlength="120" required></p>
<p>Your shop / Instagram link (https://...)<br><input name="link" maxlength="300"></p>
<p>What you make (a sentence or two)<br><textarea name="about" maxlength="400" rows="3" style="width:100%;background:#1d212b;color:#fff;border:1px solid #444;border-radius:6px"></textarea></p>
<p>Choose a password for your vendor page (10+ characters)<br><input name="password" type="password" minlength="10" maxlength="100" required></p>
<button type="submit">Send my application</button></form>
<h2>Already a vendor?</h2>
<form method="post" action="/vendor/dashboard"><p>Email<br><input name="email" type="email"></p><p>Password<br><input name="password" type="password"></p><button type="submit">Sign in</button></form>
<p class="small">By applying you agree that your designs are your own work and fit a family-friendly festival (no drugs, hate, nudity or anyone else's brand).
<a href="/store/terms" style="color:#e8b14c">The ${CURRENCY} rules</a>.</p>`;
}

function vendorApply(res, form, ip) {
  const p = pay();
  const back = '<a class="btn" href="/vendor">Back</a>';
  if (limited('vapply|' + ip, 3, DAY)) { p.page(res, 429, 'Vendors', '<h1>Thanks!</h1><p>We already have applications from here today.</p>'); return; }
  const name = cleanName(form.get('name'), 32);
  const email = String(form.get('email') || '').trim().toLowerCase().slice(0, 120);
  const link = httpsLink(form.get('link'));
  const about = String(form.get('about') || '').replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, 400);
  const password = String(form.get('password') || '');
  if (name.length < 2 || rude(name) || rude(about)) { p.page(res, 400, 'Vendors', '<h1>Check your details</h1><p>Your shop name needs 2+ letters and family-friendly words.</p>' + back); return; }
  if (!/^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/.test(email)) { p.page(res, 400, 'Vendors', '<h1>Check your email</h1>' + back); return; }
  if (password.length < 10 || password.length > 100) { p.page(res, 400, 'Vendors', '<h1>Longer password please</h1><p>At least 10 characters.</p>' + back); return; }
  if (vendorByEmail(email)) { p.page(res, 200, 'Vendors', '<h1>You\'ve already applied</h1><p>Sign in on the vendor page to see where you are.</p>' + back); return; }
  if (Object.keys(state.vendors).length >= MAX_VENDORS) { p.page(res, 503, 'Vendors', '<h1>Applications are full</h1><p>Please try again next season.</p>'); return; }
  try {
    transact(credit => {
      let id;
      do { id = 'mk-' + crypto.randomBytes(3).toString('hex'); } while (state.vendors[id]);
      const salt = crypto.randomBytes(12).toString('hex');
      const hue = parseInt(sha(id).slice(0, 2), 16) / 255;
      state.vendors[id] = {
        id, name, email, link, about, tagline: about.slice(0, 90), colour: hslHex(hue), salt, pass: hashPassword(password, salt),
        status: 'pending', created: new Date().toISOString(), plan: '', planUntil: 0, earned: 0, paidCents: 0
      };
      credit({ type: 'vendor-apply', vendor: id });
    });
  } catch (err) {
    console.error('vendor apply', err && err.message);
    p.page(res, 500, 'Vendors', '<h1>Something went wrong</h1><p>Please try again in a minute.</p>');
    return;
  }
  p.page(res, 200, 'Thanks', '<h1>Application sent!</h1><p>Thanks - we look at every one ourselves. Sign in on the vendor page any time to see if you\'re approved.</p>' + back);
}

function hslHex(h) {
  const f = n => { const k = (n + h * 12) % 12; const c = 0.55 - 0.45 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}

function vendorPlan(res, vendor, planId) {
  const p = pay();
  const plan = PLANS.find(x => x.id === planId);
  const s = stripe();
  const base = p.baseUrl();
  if (vendor.status !== 'approved' || !plan || !s || !base) {
    p.page(res, 400, 'Plans', '<h1>Can\'t start a plan yet</h1><p>Plans open once you\'re approved (and online payments are set up).</p><a class="btn" href="/vendor">Back</a>');
    return;
  }
  const meta = { kind: 'plan', vendor: vendor.id, plan: plan.id };
  s.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: plan.cents, product_data: { name: `${plan.name} - ${plan.slots} design slots (vendor season plan)` } } }],
    customer_email: vendor.email,
    metadata: meta,
    payment_intent_data: { metadata: meta, description: `New Moon, Same Dark vendor plan - ${vendor.name}` },
    success_url: `${base}/store/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/store/cancel`
  }).then(session => {
    try { transact(() => { state.orders[session.id] = { kind: 'plan', vendor: vendor.id, plan: plan.id, cents: plan.cents, status: 'open', at: new Date().toISOString() }; }); } catch { /* the webhook still activates it */ }
    res.writeHead(303, { location: session.url });
    res.end();
  }).catch(err => {
    console.error('vendor plan', err && err.message);
    p.page(res, 502, 'Plans', '<h1>Try again</h1><p>We couldn\'t reach the payment page. Try again in a minute.</p>');
  });
}

/** Turns an Outfit Studio look code ("~fit:1|top|...") into a design: the shirt, its colours, pattern and print. */
function fromLookCode(code) {
  const text = String(code || '').trim();
  if (!text.startsWith('~fit:')) return null;
  const f = text.slice(5).split('|');
  if (f.length < 11) return null;
  const hex = h => /^[0-9a-fA-F]{6}$/.test(h || '') ? '#' + h.toLowerCase() : null;
  const pattern = Math.max(0, Math.min(STUDIO_TO_VENDOR_PATTERN.length - 1, parseInt(f[10], 10) || 0));
  return { kind: f[1] === 'hood' ? 'hoodie' : 'tee', colour: hex(f[6]), accent: hex(f[9]), pattern: STUDIO_TO_VENDOR_PATTERN[pattern], print: cleanPrint(f[11] || '') };
}

function slotsUsed(vendor) {
  return Object.values(state.designs).filter(d => d.vendor === vendor.id && (d.status === 'live' || d.status === 'pending')).length;
}

function vendorDesign(vendor, form) {
  if (vendor.status !== 'approved') return 'You can send designs once you\'re approved.';
  if (!vendorActive(vendor)) return 'Choose a season plan first - then your design slots open.';
  const plan = planOf(vendor);
  if (!plan || slotsUsed(vendor) >= plan.slots) return `All ${plan ? plan.slots : 0} of your design slots are in use. Retire a design (or move up a plan) to free one.`;
  if (limited('vdesign|' + vendor.id, 10, DAY)) return 'That\'s 10 designs sent today - send more tomorrow.';
  if (Object.values(state.designs).filter(d => d.status === 'pending').length >= MAX_PENDING_DESIGNS) return 'Our review queue is full right now - try again in a few days.';

  const look = fromLookCode(form.get('look'));
  const name = cleanName(form.get('name'), 32);
  const kind = look ? look.kind : String(form.get('kind') || '');
  const colour = (look && look.colour) || cleanColour(form.get('colour'), null);
  const accent = (look && look.accent) || cleanColour(form.get('accent'), null);
  const pattern = look ? look.pattern : String(form.get('pattern') || 'plain');
  const print = look ? look.print : cleanPrint(form.get('print'));
  const price = Number(form.get('price'));
  if (String(form.get('look') || '').trim() && !look) return 'That look code didn\'t work. In the game: Outfit Studio > Saved > "Copy look code", then paste it here.';
  if (name.length < 2) return 'Give your design a name (2 to 32 letters).';
  if (!KINDS.includes(kind) || !PATTERNS.includes(pattern) || !colour || !accent) return 'Pick what it is, its two colours and a pattern.';
  if (!DESIGN_PRICES.includes(price)) return 'Pick one of the prices.';
  if (rude(name) || rude(print)) return 'Something in the name or print isn\'t allowed. Keep it festival-friendly (no drugs, swearing or hate).';
  const dupe = Object.values(state.designs).some(d => d.vendor === vendor.id && d.status !== 'rejected' && d.status !== 'retired' && d.name.toLowerCase() === name.toLowerCase());
  if (dupe) return 'You already have a design with that name.';
  try {
    transact(credit => {
      let id;
      do { id = 'd' + crypto.randomBytes(4).toString('hex'); } while (state.designs[id]);
      state.designs[id] = { id, vendor: vendor.id, name, kind, colour, accent, pattern, print, price, status: 'pending', created: new Date().toISOString(), sales: 0 };
      credit({ type: 'design-sent', vendor: vendor.id, design: id });
    });
  } catch (err) {
    console.error('vendor design', err && err.message);
    return 'Something went wrong saving it - please try again.';
  }
  return `"${name}" is in the review queue. You'll see it go live here once it's approved.`;
}

function vendorRetire(vendor, id) {
  const d = own(state.designs, id);   // Round 55 review: own entries only
  if (!d || d.vendor !== vendor.id || (d.status !== 'live' && d.status !== 'pending')) return '';
  transact(() => { d.status = 'retired'; d.retiredAt = new Date().toISOString(); });
  return `"${d.name}" is retired - it's off sale (players who bought it keep it) and its slot is free.`;
}

const STATUS_WORDS = { pending: 'waiting for review', live: 'LIVE in the game', rejected: 'not approved', retired: 'retired', unpublished: 'taken down' };

function vendorDashboard(vendor, creds, note) {
  const esc = pay().escapeHtml;
  const plan = planOf(vendor);
  const active = vendorActive(vendor);
  const owed = Math.max(0, (vendor.earned || 0) * SHARD_CENTS - (vendor.paidCents || 0));
  let status;
  if (vendor.status === 'pending') status = '<p>Your application is <b>waiting for review</b>. We\'ll email you - or check back here.</p>';
  else if (vendor.status === 'rejected') status = '<p>Sorry - your application wasn\'t approved this time.</p>';
  else if (vendor.status === 'banned') status = '<p class="off">This vendor account is suspended. Contact us if you think this is a mistake.</p>';
  else status = `<p>Approved. Plan: <b>${plan ? plan.name + ' (' + plan.slots + ' designs)' : 'none yet'}</b>${active ? ' &middot; runs until ' + new Date(vendor.planUntil).toDateString() : vendor.planUntil ? ' &middot; <span class="off">ended - renew to put your designs back on sale</span>' : ''}</p>`;

  const plans = vendor.status === 'approved' ? `<h2>${active ? 'Renew or move up' : 'Choose a season plan'}</h2><table>${PLANS.map(pl => `<tr><td><b>${pl.name}</b><br><span class="small">${pl.slots} design slots</span></td><td>${money(pl.cents)}</td>
<td><form method="post" action="/vendor/dashboard">${creds}<input type="hidden" name="action" value="plan"><input type="hidden" name="plan" value="${pl.id}"><button type="submit">${active ? 'Add a season' : 'Choose'}</button></form></td></tr>`).join('')}</table>
<p class="small">${active ? 'Paying again adds another season on the end, with the plan you pick.' : 'You pay on Stripe\'s secure page. Plans started in the last three weeks of a season run to the end of the next one.'}</p>` : '';

  const mine = Object.values(state.designs).filter(d => d.vendor === vendor.id).sort((a, b) => b.created.localeCompare(a.created));
  const list = mine.map(d => `<tr><td>${swatch(d)}</td><td><b>${esc(d.name)}</b><br><span class="small">${KIND_NAMES[d.kind] || d.kind} &middot; ${d.pattern}${d.print ? ' &middot; "' + esc(d.print) + '"' : ''} &middot; ${d.price} shards</span></td>
<td>${d.status === 'live' ? '<span class="on">' + STATUS_WORDS.live + '</span>' : esc(STATUS_WORDS[d.status] || d.status)}${d.note ? '<br><span class="small">' + esc(d.note) + '</span>' : ''}<br><span class="small">${d.sales || 0} sold</span></td>
<td>${d.status === 'live' || d.status === 'pending' ? `<form method="post" action="/vendor/dashboard">${creds}<input type="hidden" name="action" value="retire"><input type="hidden" name="design" value="${d.id}"><button type="submit" style="background:#8a93a3">Retire</button></form>` : ''}</td></tr>`).join('');

  const canSend = vendor.status === 'approved' && active && plan && slotsUsed(vendor) < plan.slots;
  const opt = (list, pick) => list.map(x => `<option value="${x}"${x === pick ? ' selected' : ''}>${KIND_NAMES[x] || x}</option>`).join('');
  const send = canSend ? `<h2>Send a design (${slotsUsed(vendor)} of ${plan.slots} slots used)</h2>
<form method="post" action="/vendor/dashboard">${creds}<input type="hidden" name="action" value="design">
<p>Name<br><input name="name" maxlength="32" required></p>
<p>What is it?<br><select name="kind">${opt(KINDS, 'tee')}</select></p>
<p>Main colour <input type="color" name="colour" value="#7a3cff" style="width:60px;padding:0"> &nbsp; Second colour <input type="color" name="accent" value="#ffd23f" style="width:60px;padding:0"></p>
<p>Pattern<br><select name="pattern">${PATTERNS.map(x => `<option>${x}</option>`).join('')}</select></p>
<p>Words printed on it (tees and hoodies, up to 14 letters, optional)<br><input name="print" maxlength="14"></p>
<p>OR paste a look code from the game (Outfit Studio &gt; Saved &gt; Copy look code) - it uses that shirt, its colours, pattern and print:<br><input name="look" maxlength="400" style="width:100%"></p>
<p>Price<br><select name="price">${DESIGN_PRICES.map(x => `<option value="${x}"${x === 400 ? ' selected' : ''}>${x} shards (you earn about ${money(Math.floor(x * sharePercent() / 100) * SHARD_CENTS)} each)</option>`).join('')}</select></p>
<button type="submit">Send for review</button></form>` : '';

  return `<h1>${esc(vendor.name)}</h1>${note ? `<div class="code" style="font-size:15px;letter-spacing:0;text-align:left">${esc(note)}</div>` : ''}${status}
<p class="small">Earned so far: ${(vendor.earned || 0).toLocaleString('en-US')} shards (${money((vendor.earned || 0) * SHARD_CENTS)}) &middot; paid to you: ${money(vendor.paidCents || 0)} &middot; still to come: ${money(owed)}</p>
${plans}${send}<h2>Your designs</h2><table>${list || '<tr><td class="small">None yet.</td></tr>'}</table>
<p class="small">Every design is checked by us before it goes live. Players can report designs; we may take down anything that breaks the rules.</p>`;
}

/** A small picture of a design (colours, pattern and shape) for the review queue. */
function swatch(d) {
  const id = 'p' + d.id;
  const c = d.colour, a = d.accent;
  const defs = {
    stripes: `<pattern id="${id}" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="5" fill="${c}"/><rect y="5" width="10" height="5" fill="${a}"/></pattern>`,
    checker: `<pattern id="${id}" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="${c}"/><rect width="6" height="6" fill="${a}"/><rect x="6" y="6" width="6" height="6" fill="${a}"/></pattern>`,
    dots: `<pattern id="${id}" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="${c}"/><circle cx="5" cy="5" r="2.2" fill="${a}"/></pattern>`,
    tiedye: `<radialGradient id="${id}" spreadMethod="reflect" r="0.25"><stop offset="0" stop-color="${c}"/><stop offset="0.5" stop-color="${a}"/><stop offset="1" stop-color="${c}"/></radialGradient>`,
    spiral: `<radialGradient id="${id}" spreadMethod="repeat" r="0.18"><stop offset="0.5" stop-color="${c}"/><stop offset="0.5" stop-color="${a}"/></radialGradient>`,
    split: `<linearGradient id="${id}"><stop offset="0.5" stop-color="${c}"/><stop offset="0.5" stop-color="${a}"/></linearGradient>`
  };
  const fill = defs[d.pattern] ? `url(#${id})` : c;
  const shapes = {
    tee: '<path d="M20 10 L32 4 L48 4 L60 10 L72 22 L62 30 L56 24 L56 70 L24 70 L24 24 L18 30 L8 22 Z"/>',
    hoodie: '<path d="M20 12 L30 4 L50 4 L60 12 L72 26 L62 32 L56 26 L56 72 L24 72 L24 26 L18 32 L8 26 Z"/>',
    cap: '<path d="M14 44 A26 22 0 0 1 66 44 Z"/><rect x="40" y="42" width="34" height="6" rx="3"/>',
    bucket: '<path d="M22 40 L28 18 L52 18 L58 40 Z"/><rect x="10" y="38" width="60" height="8" rx="4"/>',
    bandana: '<path d="M8 20 L72 20 L40 62 Z"/>',
    glasses: '<circle cx="24" cy="38" r="13"/><circle cx="56" cy="38" r="13"/><rect x="34" y="34" width="12" height="4"/>',
    pendant: '<path d="M20 8 Q40 36 60 8" fill="none" stroke="#666" stroke-width="2"/><ellipse cx="40" cy="44" rx="11" ry="16"/>',
    bracelet: '<circle cx="40" cy="40" r="24" fill="none" stroke-width="10" stroke="' + c + '"/><circle cx="40" cy="16" r="6" fill="' + a + '"/>',
    backpack: '<rect x="18" y="12" width="44" height="56" rx="10"/><rect x="26" y="44" width="28" height="16" rx="4" fill="' + a + '"/>',
    totem: '<rect x="37" y="30" width="6" height="46" fill="#aaa"/><ellipse cx="40" cy="22" rx="20" ry="14"/>'
  };
  const text = d.print && (d.kind === 'tee' || d.kind === 'hoodie') ? `<text x="40" y="44" font-size="8" text-anchor="middle" fill="${a}" font-family="sans-serif" font-weight="700">${pay().escapeHtml(d.print)}</text>` : '';
  return `<svg width="80" height="80" viewBox="0 0 80 80" style="background:#1a1d24;border-radius:6px"><defs>${defs[d.pattern] || ''}</defs><g fill="${fill}" stroke="#000" stroke-opacity=".35">${shapes[d.kind] || shapes.tee}</g>${text}</svg>`;
}

// ============================================================================ your admin page
function adminSection(hidden) {
  const esc = pay().escapeHtml;
  const f = features();
  const button = (action, item, label, colour, extra) => `<form method="post" action="/admin" style="display:inline">${hidden}<input type="hidden" name="action" value="${action}"><input type="hidden" name="item" value="${esc(item)}">${extra || ''}<button type="submit"${colour ? ` style="background:${colour}"` : ''}>${label}</button></form> `;
  const accounts = Object.values(state.accounts);
  const orders = Object.values(state.orders);
  const paidShards = orders.filter(o => o.kind === 'shards' && o.status === 'paid');
  const plansPaid = orders.filter(o => o.kind === 'plan' && o.status === 'paid');
  const vendors = Object.values(state.vendors);
  const designs = Object.values(state.designs);

  const setup = [
    ['Store switch (vendors.json "store": true)', f.store],
    ['Vendor portal switch ("vendorPortal": true)', f.vendorPortal],
    ['Safe storage (STORE_DATA_DIR on a persistent disk)', !!process.env.STORE_DATA_DIR || (LOCAL_OK ? 'local test only' : false)],
    ['Stripe (STRIPE_SECRET_KEY)', !!stripe()],
    ['Payment confirmations (STRIPE_WEBHOOK_SECRET)', (process.env.STRIPE_WEBHOOK_SECRET || '').length > 8],
    ['Server address (PUBLIC_URL)', !!pay().baseUrl()]
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v === true ? '<span class="on">ready</span>' : v ? '<span class="small">' + v + '</span>' : '<span class="off">not set</span>'}</td></tr>`).join('');

  const applications = vendors.filter(v => v.status === 'pending').map(v => `<div style="border:1px solid #2a2f3a;border-radius:8px;padding:10px;margin:8px 0">
<b>${esc(v.name)}</b> <span class="small">${esc(v.email)} &middot; applied ${esc(String(v.created).slice(0, 10))}</span><br>
${v.link ? `<a href="${esc(v.link)}" target="_blank" rel="noopener" style="color:#e8b14c">${esc(v.link)}</a><br>` : ''}<span class="small">${esc(v.about)}</span><br>
${button('vendor-approve', v.id, 'Approve')}${button('vendor-reject', v.id, 'Reject', '#ff8a80')}</div>`).join('');

  const queue = designs.filter(d => d.status === 'pending').map(d => {
    const v = state.vendors[d.vendor] || { name: '?' };
    return `<div style="border:1px solid #2a2f3a;border-radius:8px;padding:10px;margin:8px 0;display:flex;gap:10px;align-items:center">${swatch(d)}<div>
<b>${esc(d.name)}</b> <span class="small">by ${esc(v.name)} &middot; ${KIND_NAMES[d.kind] || d.kind} &middot; ${d.pattern}${d.print ? ' &middot; "' + esc(d.print) + '"' : ''} &middot; ${d.price} shards</span><br>
${button('design-approve', d.id, 'Approve')}${button('design-reject', d.id, 'Reject', '#ff8a80', '<input name="note" placeholder="why (the vendor sees this)" maxlength="120" style="width:180px">')}</div></div>`;
  }).join('');

  const live = liveDesigns().map(({ d, v }) => `<tr><td>${swatch(d)}</td><td><b>${esc(d.name)}</b><br><span class="small">${esc(v.name)} &middot; ${d.price} shards &middot; ${d.sales || 0} sold</span></td>
<td>${button('design-unpublish', d.id, 'Take down', '#ff8a80')}</td></tr>`).join('');

  const open = state.reports.filter(r => r.status === 'open');
  const byDesign = new Map();
  for (const r of open) { if (!byDesign.has(r.design)) byDesign.set(r.design, []); byDesign.get(r.design).push(r); }
  const reports = [...byDesign.entries()].map(([id, list]) => {
    const d = state.designs[id] || { name: '?', vendor: '' };
    const v = state.vendors[d.vendor] || { name: '?' };
    return `<div style="border:1px solid #5a2f2f;border-radius:8px;padding:10px;margin:8px 0;display:flex;gap:10px;align-items:center">${state.designs[id] ? swatch(d) : ''}<div>
<b>${esc(d.name)}</b> <span class="small">by ${esc(v.name)} &middot; ${list.length} report${list.length > 1 ? 's' : ''} &middot; now ${esc(STATUS_WORDS[d.status] || d.status)}</span><br>
<span class="small">${list.slice(0, 5).map(r => '"' + esc(r.reason) + '"').join(' &middot; ')}</span><br>
${button('report-dismiss', id, 'It\'s fine - dismiss')}${button('report-unpublish', id, 'Take the design down', '#ff8a80')}${button('report-ban', id, 'Ban the vendor', '#ff5252')}</div></div>`;
  }).join('');

  const vendorRows = vendors.filter(v => v.status === 'approved' || v.status === 'banned').map(v => {
    const plan = planOf(v);
    const owed = Math.max(0, (v.earned || 0) * SHARD_CENTS - (v.paidCents || 0));
    return `<tr><td><b>${esc(v.name)}</b><br><span class="small">${esc(v.email)} &middot; ${esc(v.id)}</span></td>
<td>${v.status === 'banned' ? '<span class="off">banned</span>' : vendorActive(v) ? `<span class="on">${plan ? plan.name : ''}</span><br><span class="small">to ${new Date(v.planUntil).toDateString()} &middot; ${slotsUsed(v)}/${plan ? plan.slots : 0} slots</span>` : '<span class="small">no plan running</span>'}</td>
<td><span class="small">owed ${money(owed)}<br>paid ${money(v.paidCents || 0)}</span></td>
<td>${owed > 0 ? button('vendor-paid', v.id, 'I paid ' + money(owed)) : ''}${v.status === 'banned' ? button('vendor-unban', v.id, 'Unban') : button('vendor-ban', v.id, 'Ban', '#ff5252')}</td></tr>`;
  }).join('');

  const totalCents = paidShards.reduce((s, o) => s + o.cents, 0) + plansPaid.reduce((s, o) => s + o.cents, 0);
  const owedAll = vendors.reduce((s, v) => s + Math.max(0, (v.earned || 0) * SHARD_CENTS - (v.paidCents || 0)), 0);
  const inWallets = accounts.reduce((s, a) => s + a.shards, 0);

  return `${bigNightAdminSection(hidden, button)}
${iapAdminSection(hidden, button)}
<h2>${CURRENCY} store &amp; vendor market</h2>
${broken ? `<p class="off">${esc(broken)}</p>` : ''}${recovered ? `<p class="off">${esc(recovered)}</p>` : ''}
<table>${setup}</table>
<p class="small">${accounts.length} accounts &middot; ${paidShards.length} shard packs sold + ${plansPaid.length} vendor plans = ${money(totalCents)} before Stripe's fees &middot;
${inWallets.toLocaleString('en-US')} shards unspent in players' accounts &middot; you owe vendors ${money(owedAll)} (their ${sharePercent()}% share)</p>
<h2 style="font-size:15px">Reports from players (${byDesign.size})</h2>${reports || '<p class="small">No reports.</p>'}
<h2 style="font-size:15px">Designs waiting for you (${designs.filter(d => d.status === 'pending').length})</h2>${queue || '<p class="small">Nothing waiting.</p>'}
<h2 style="font-size:15px">Vendor applications (${vendors.filter(v => v.status === 'pending').length})</h2>${applications || '<p class="small">None waiting.</p>'}
<h2 style="font-size:15px">Live designs (${live ? liveDesigns().length : 0})</h2><table>${live || '<tr><td class="small">None yet.</td></tr>'}</table>
<h2 style="font-size:15px">Vendors</h2><table>${vendorRows || '<tr><td class="small">None approved yet.</td></tr>'}</table>
<h2 style="font-size:15px">Help a player</h2>
<form method="post" action="/admin">${hidden}<input type="hidden" name="action" value="grant">
<p class="small">Give (or with a minus, take back) shards - e.g. to fix a problem. The player's account id is in their game: Settings &gt; Account &amp; Store.</p>
<input name="item" placeholder="account id (A...)" maxlength="13" style="width:150px"> <input name="amount" placeholder="shards, e.g. 500" maxlength="7" style="width:120px">
<input name="note" placeholder="why" maxlength="100" style="width:160px"> <button type="submit">Give shards</button></form>
<form method="post" action="/admin" style="margin-top:6px">${hidden}<input type="hidden" name="action" value="account-ban"><input name="item" placeholder="account id to suspend / restore" maxlength="13" style="width:230px"> <button type="submit" style="background:#ff8a80">Suspend / restore account</button></form>
<h2 style="font-size:15px">Backup</h2>
<p class="small">Download everything (accounts, balances, vendors, designs) now and then and keep it somewhere safe.</p>
<form method="post" action="/admin">${hidden}<input type="hidden" name="action" value="store-backup"><button type="submit">Download a backup</button></form>`;
}

/** Handles one of the store's admin buttons. Returns a note to show, or null if it wasn't ours. */
function adminAction(action, form) {
  const item = String(form.get('item') || '').trim();
  const note = String(form.get('note') || '').replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, 120);
  const now = new Date().toISOString();
  const d = own(state.designs, item);   // Round 55 review: own entries only
  const v = own(state.vendors, item);
  const run = fn => { try { return transact(fn); } catch (err) { console.error('store admin', err && err.message); return 'That didn\'t save - try again.'; } };
  if (String(action || '').startsWith('bignight-')) return bigNightAdminAction(action, item, note, run);   // Round 58
  if (String(action || '').startsWith('iap-')) return iapAdminAction(action, item, note, run);              // Round 69
  switch (action) {
    case 'vendor-approve': return v && v.status === 'pending' ? run(c => { v.status = 'approved'; v.approvedAt = now; c({ type: 'vendor-approved', vendor: v.id }); return `${v.name} approved. Email them (${v.email}) so they can choose a plan.`; }) : '';
    case 'vendor-reject': return v && v.status === 'pending' ? run(c => { v.status = 'rejected'; c({ type: 'vendor-rejected', vendor: v.id }); return `${v.name} rejected.`; }) : '';
    case 'vendor-ban': return v ? run(c => { v.status = 'banned'; c({ type: 'vendor-banned', vendor: v.id }); return `${v.name} is banned - their designs are off sale.`; }) : '';
    case 'vendor-unban': return v && v.status === 'banned' ? run(c => { v.status = 'approved'; c({ type: 'vendor-unbanned', vendor: v.id }); return `${v.name} is back.`; }) : '';
    case 'vendor-paid': {
      if (!v) return '';
      const owed = Math.max(0, (v.earned || 0) * SHARD_CENTS - (v.paidCents || 0));
      if (!owed) return '';
      return run(c => { v.paidCents = (v.paidCents || 0) + owed; state.payouts.push({ vendor: v.id, cents: owed, at: now }); c({ type: 'vendor-payout', vendor: v.id, cents: owed }); return `Recorded: you paid ${v.name} ${money(owed)}.`; });
    }
    case 'design-approve': return d && d.status === 'pending' ? run(c => { d.status = 'live'; d.approvedAt = now; c({ type: 'design-approved', design: d.id, vendor: d.vendor }); return `"${d.name}" is live (players see it within about 10 minutes).`; }) : '';
    case 'design-reject': return d && d.status === 'pending' ? run(c => { d.status = 'rejected'; d.note = note; c({ type: 'design-rejected', design: d.id, vendor: d.vendor }); return `"${d.name}" rejected.`; }) : '';
    case 'design-unpublish': return d && d.status === 'live' ? run(c => { d.status = 'unpublished'; c({ type: 'design-unpublished', design: d.id, vendor: d.vendor }); return `"${d.name}" taken down.`; }) : '';
    case 'report-dismiss':
    case 'report-unpublish':
    case 'report-ban': {
      const design = own(state.designs, item);   // Round 55 review: own entries only
      return run(c => {
        for (const r of state.reports) if (r.design === item && r.status === 'open') { r.status = action === 'report-dismiss' ? 'dismissed' : 'actioned'; r.closedAt = now; }
        if (action !== 'report-dismiss' && design && (design.status === 'live' || design.status === 'pending')) design.status = 'unpublished';
        if (action === 'report-ban' && design && state.vendors[design.vendor]) state.vendors[design.vendor].status = 'banned';
        c({ type: action, design: item });
        return action === 'report-dismiss' ? 'Reports dismissed.' : action === 'report-ban' ? 'Design taken down and the vendor banned.' : 'Design taken down.';
      });
    }
    case 'grant': {
      const account = own(state.accounts, item.toUpperCase());   // Round 55 review: own entries only
      const amount = Math.trunc(Number(form.get('amount')));
      if (!account || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) return 'Check the account id and the amount.';
      return run(c => {
        const change = amount < 0 ? -Math.min(account.shards, -amount) : amount;
        account.shards += change;
        c({ type: 'grant', account: account.id, shards: change, balance: account.shards, note });
        return `${account.name} (${account.id}) now has ${account.shards} shards.`;
      });
    }
    case 'account-ban': {
      const account = own(state.accounts, item.toUpperCase());   // Round 55 review: own entries only
      if (!account) return 'No account with that id.';
      return run(c => { account.banned = !account.banned; c({ type: account.banned ? 'account-banned' : 'account-restored', account: account.id }); return `${account.name} (${account.id}) is ${account.banned ? 'suspended' : 'restored'}.`; });
    }
    default: return null;
  }
}

/** Everything, for the admin's "Download a backup" (passwords and tokens are stored only as hashes). */
function backup() { return JSON.stringify(state, null, 1); }

/**
 * Round 71: read-only numbers for the play-stats dashboard (analytics.js): every account (no secrets) and every real
 * sale - Stripe orders that were paid (shards, vendor plans, Big Night) and app-store purchases that were granted
 * (not test / sandbox ones). Cents are the list price before Stripe's or the store's cut.
 */
function stats() {
  const accounts = Object.values(state.accounts || {}).filter(a => a && a.id).map(a => ({
    id: a.id, name: a.name || '', email: a.email || '', created: a.created || '', shards: Number(a.shards) || 0,
    passes: Array.isArray(a.passes) ? a.passes.length : 0, banned: !!a.banned
  }));
  const sales = [];
  for (const o of Object.values(state.orders || {})) {
    if (!o || o.status !== 'paid') continue;
    sales.push({ at: o.paidAt || o.at || '', cents: Number(o.cents) || 0, account: o.account || '', via: o.kind === 'plan' ? 'vendor plans' : 'web (Stripe)', kind: o.kind || '' });
  }
  for (const p of Object.values(state.iap || {})) {
    if (!p || p.status !== 'granted' || p.sandbox) continue;
    sales.push({ at: p.grantedAt || p.at || '', cents: Number(p.cents) || 0, account: p.account || '', via: p.platform || 'app store', kind: p.kind || '' });
  }
  return { open: isOpen(), accounts, sales };
}

module.exports = {
  handle, adminSection, adminAction, mergeIntoFeed, backup, catalog, CURRENCY,
  linkLive, unlinkLive, accountSummary,   // Round 109: the live account's store account (players.js)
  stats,   // Round 71: for the play-stats dashboard
  // Round 58: Big Night rooms (relay.js)
  bigNightStart, bigNightUntil, bigNightConfig, setRoomSizes, setBigNightRooms,
  _test: { rude, verifySignature, fromLookCode, planEndFrom, quarterEnd, state: () => state, PACKS, PLANS, PREMIUM, DATA_FILE, LEDGER_FILE,
    grantBigNightOrder, refundOrder, bigNightPublic, bigNightSummary, transact,
    // Round 69
    IAP_PRODUCTS, grantIap, revokeIap, iapRefundCheck, iapCheck: () => iapCheck, iapAdminAction, iapAdminSection: () => iapAdminSection('', () => ''),
    accountToken, steamPrice, iapAlerts: () => iapAlerts }
};
