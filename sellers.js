// Round 85: REAL SHOPS - crafters, painters, jewellery makers and other sellers pay for a listing, and their booth at the
// Open Festival (live mode) shows their REAL products: photos, names and prices. "Buy on their store" opens the seller's
// own shop page (Etsy, Shopify, Big Cartel, their own site) in the player's browser. No money, orders or shipping go
// through the game - the listing fee is the only payment, and it goes to you through Stripe.
//
//   POST /sellers/apply      Authorization: Bearer <live account token>
//                            {shopName, kind, storeUrl, about, products: [{title, price, imageUrl, productUrl}] (1-8)}
//                            -> {ok, mine}   (mine: the same shape as GET /sellers/mine)
//   GET  /sellers/mine       Bearer -> {ok, has, status, note, liveUntil, paidUntil, listing, fee, payOnline}
//   POST /sellers/checkout   Bearer -> {ok, url}  (Stripe's payment page)   or {ok:false, error, manual}
//   POST /sellers/remove     Bearer -> {ok}  (the seller takes their listing down for good)
//   GET  /sellers/listings   -> {ok, now, listings: [{id, seller, shopName, kind, about, storeUrl, products}]}  (live ones only)
//   GET  /sellers/paid       Stripe sends the seller back here after paying (marks the listing paid).
//   GET/POST /admin/sellers  your page (ADMIN_KEY): approve / decline / note, mark paid, set the end date, edit or
//                            remove products, delete.
//
// status: "payment" (waiting for payment), "review" (paid - waiting for you), "live" (approved + paid, until liveUntil),
//         "expired" (the paid time ran out), "declined" (with your note).
// A listing is public only when it's APPROVED and PAID and not past its end date. A seller who changes their listing
// goes back to "review" (so nobody can swap in different pictures after you approved them); the paid time is kept.
//
// SETTINGS (Render > Environment):
//   SELLER_LISTING_PRICE_ID  the Stripe Price for one listing period (price_..., a ONE-TIME price, e.g. $9.99).
//                            Not set (or Stripe not set up): listings wait for payment and you mark them paid by hand.
//   SELLER_LISTING_DAYS      how many days one payment buys (default 30).
//   (and the ones Stripe already uses: STRIPE_SECRET_KEY, PUBLIC_URL, ADMIN_KEY)
//
// Payments are confirmed by asking Stripe directly (on the thank-you page, and whenever the game checks the listing),
// so no extra webhook is needed. The Moon Shards webhook sees these payments too and ignores them.
//
// Brakes: 10 sends a day per account and 20 an hour per address, 60 status checks an hour, 10 payment pages an hour,
// /sellers/listings 60 a minute per address (and cached for 30 s), at most 300 waiting and 2000 listings.
// Privacy: the seller's account email is shown on the admin page only (for Stripe's receipt and for you to contact
// them) and is never written to the log or sent to the game.
//
// FILE: sellers.json (+ sellers.json.bak, the version before) in PATCHBAY_DIR, else STORE_DATA_DIR, else next to this
// file - the same place as artist applications. A FREE Render server forgets it on every restart (the admin page says so).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pay = () => require('./payments');      // (lazy: payments.js requires this file for the admin page)
const players = () => require('./players');
const patchbay = () => require('./patchbay');

const DATA_DIR = process.env.PATCHBAY_DIR || process.env.STORE_DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'sellers.json');
const PERSISTENT = !!(process.env.PATCHBAY_DIR || process.env.STORE_DATA_DIR);

const DAY = 86400000;
const HOUR = 3600000;
const MAX_LISTINGS = 2000;
const MAX_WAITING = 300;
const MAX_PRODUCTS = 8;
const MAX_IMAGES = 8;             // a listing's pictures (one a product) - the game downloads each one
const MAX_BODY = 24 * 1024;
const MAX_URL = 300;
const KINDS = ['crafts', 'art', 'jewelry', 'clothing', 'other'];
const KIND_NAMES = { crafts: 'Crafts', art: 'Art', jewelry: 'Jewelry', clothing: 'Clothing', other: 'Other' };
const STATES = ['waiting', 'approved', 'declined'];
const IMAGE_EXT = /\.(jpe?g|png)$/i;

function days() {
  const n = Number(process.env.SELLER_LISTING_DAYS);
  return Number.isFinite(n) && n >= 1 && n <= 400 ? Math.round(n) : 30;
}

// ============================================================================ small helpers
function h(s) { return pay().escapeHtml(s); }

/** Text, cleaned: no control characters, no < >, no hidden right-to-left tricks. multi keeps line breaks. */
function clean(value, max, multi) {
  let t = String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/[‎‏‪-‮⁦-⁩]/g, '');
  t = multi ? t.replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, '').replace(/\n{3,}/g, '\n\n')
    : t.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/ {2,}/g, ' ');
  return t.trim().slice(0, max);
}

/** A link: https only, a public web address (no local or private ones), at most MAX_URL characters - or ''. */
function cleanLink(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > MAX_URL) return '';
  return patchbay().cleanStreamUrl(text) || '';
}

/** A picture link: as cleanLink, and its address ends .jpg / .jpeg / .png (a ?query after it is fine). */
function cleanImage(value) {
  const link = cleanLink(value);
  if (!link) return '';
  let p = '';
  try { p = new URL(link).pathname; } catch { return ''; }
  return IMAGE_EXT.test(p) ? link : '';
}

function ipOf(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
}

/** Times something happened, per key (for the brakes). */
const hits = new Map();
function count(key, windowMs) {
  const t = Date.now();
  const list = (hits.get(key) || []).filter(x => t - x < windowMs);
  hits.set(key, list);
  return list.length;
}
function note(key) {
  const list = hits.get(key) || [];
  list.push(Date.now());
  hits.set(key, list.slice(-80));
  if (hits.size > 20000) hits.clear();
}
setInterval(() => {
  const t = Date.now();
  for (const [k, list] of hits) if (!list.some(x => t - x < DAY)) hits.delete(k);
}, 600000).unref();

function newId() {
  let id;
  do { id = crypto.randomBytes(6).toString('hex'); } while (state.listings.some(l => l.id === id));
  return id;
}

function ago(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} days ago`;
}

function dateText(ms) { return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '-'; }

// ============================================================================ the data
// open: payment pages this server made and hasn't seen paid yet - {id, account, cents, currency, at, url} (by account, so
//       taking a shop down and sending it again never loses a payment). paid: every Stripe session ever credited (never
//       trimmed - a session can't be credited twice). credit: days paid for by an account with no listing right now.
function blank() { return { version: 2, listings: [], open: [], paid: [], credit: {} }; }

const SESSION_RE = /^cs_[A-Za-z0-9_]{10,200}$/;
function cleanOpen(o) {
  if (!o || typeof o !== 'object' || !SESSION_RE.test(String(o.id || ''))) return null;
  const account = String(o.account || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 16);
  const cents = Math.round(Number(o.cents));
  if (!account || !(cents > 0)) return null;
  return { id: String(o.id), account, cents, currency: String(o.currency || 'usd').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3) || 'usd',
    at: Number(o.at) || Date.now(), url: /^https:\/\/checkout\.stripe\.com\//.test(String(o.url || '')) ? String(o.url).slice(0, 2048) : '' };
}
let state = blank();

function cleanProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const title = clean(p.title, 60);
  const imageUrl = cleanImage(p.imageUrl);
  const productUrl = cleanLink(p.productUrl);
  if (!title || !imageUrl || !productUrl) return null;
  return { title, price: clean(p.price, 16), imageUrl, productUrl };
}

function cleanListing(l) {
  if (!l || typeof l !== 'object') return null;
  const id = String(l.id || '').replace(/[^a-f0-9]/g, '').slice(0, 12);
  const account = String(l.account || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 16);
  const shopName = clean(l.shopName, 40);
  if (id.length !== 12 || !account || !shopName) return null;
  return {
    id, account,
    username: clean(l.username, 16).replace(/[^A-Za-z0-9_.-]/g, '') || account,
    acctCreated: clean(l.acctCreated, 40),
    email: clean(l.email, 120),
    shopName,
    kind: KINDS.includes(l.kind) ? l.kind : 'other',
    storeUrl: cleanLink(l.storeUrl),
    about: clean(l.about, 400, true),
    products: (Array.isArray(l.products) ? l.products : []).map(cleanProduct).filter(Boolean).slice(0, MAX_PRODUCTS),
    state: STATES.includes(l.state) ? l.state : 'waiting',
    note: clean(l.note, 300, true),
    paidUntil: Number(l.paidUntil) || 0,
    everPaid: !!l.everPaid,
    paidHow: clean(l.paidHow, 20),
    createdAt: Number(l.createdAt) || Date.now(),
    updatedAt: Number(l.updatedAt) || Number(l.createdAt) || Date.now(),
    decidedAt: Number(l.decidedAt) || 0
  };
}

function load() {
  for (const file of [DATA_FILE, DATA_FILE + '.bak']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    try {
      const data = JSON.parse(text);
      const out = blank();
      out.listings = (Array.isArray(data && data.listings) ? data.listings : []).map(cleanListing).filter(Boolean);
      out.open = (Array.isArray(data && data.open) ? data.open : []).map(cleanOpen).filter(Boolean);
      // (version 1 kept credited sessions on each listing)
      const paid = new Set((Array.isArray(data && data.paid) ? data.paid : []).filter(x => SESSION_RE.test(String(x))));
      for (const l of (Array.isArray(data && data.listings) ? data.listings : [])) for (const x of (l && Array.isArray(l.sessions) ? l.sessions : [])) if (SESSION_RE.test(String(x))) paid.add(String(x));
      out.paid = [...paid];
      const credit = data && data.credit && typeof data.credit === 'object' ? data.credit : {};
      for (const k of Object.keys(credit)) { const d = Math.round(Number(credit[k])); if (/^[a-z0-9_.-]{1,16}$/.test(k) && d > 0 && d < 4000) out.credit[k] = d; }
      state = out;
      return;
    } catch (err) {
      console.error('sellers: ' + path.basename(file) + ' is damaged:', err && err.message);
    }
  }
}
load();

let saveTimer = null;
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch { /* first save */ }
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('sellers save', err && err.message);
  }
  publicCache = null;
}
function save() { publicCache = null; if (!saveTimer) saveTimer = setTimeout(saveNow, 400); }
function flush() { if (saveTimer) saveNow(); }

function isLive(l, t) { return l.state === 'approved' && l.paidUntil > (t || Date.now()) && l.products.length > 0; }
function isPaid(l, t) { return l.paidUntil > (t || Date.now()); }
function waitingCount() { return state.listings.filter(l => l.state === 'waiting').length; }

/** The account's listing - only if it's still the same account (a deleted and re-made username isn't the old seller). */
function listingOf(p) {
  const key = String(p.username || '').toLowerCase();
  const l = state.listings.find(x => x.account === key);
  if (!l) return null;
  if (l.acctCreated && String(p.created || '') && l.acctCreated !== String(p.created)) return null;
  return l;
}

function statusOf(l, t) {
  t = t || Date.now();
  if (l.state === 'declined') return 'declined';
  if (!isPaid(l, t)) return l.everPaid ? 'expired' : 'payment';
  return l.state === 'approved' ? 'live' : 'review';
}

// ============================================================================ the fee (from Stripe's Price)
let priceCache = null, priceAt = 0, priceAsking = null;

/** {ok, cents, currency, text} for SELLER_LISTING_PRICE_ID, or {ok:false, why}. Asked of Stripe at most every 10 min. */
function price() {
  const id = String(process.env.SELLER_LISTING_PRICE_ID || '').trim();
  const s = pay().stripe();
  if (!/^price_[A-Za-z0-9]{6,80}$/.test(id) || !s || !pay().baseUrl()) return Promise.resolve({ ok: false, why: 'not set up' });
  if (priceCache && priceCache.id === id && Date.now() - priceAt < 600000) return Promise.resolve(priceCache);
  if (priceAsking) return priceAsking;
  priceAsking = s.prices.retrieve(id).then(p => {
    const cents = Number(p && p.unit_amount);
    const out = (!p || p.active === false || p.type !== 'one_time' || !(cents > 0))
      ? { ok: false, id, why: 'SELLER_LISTING_PRICE_ID must be an active ONE-TIME price' }
      : { ok: true, id, cents, currency: String(p.currency || 'usd').toLowerCase(), text: money(cents, p.currency) + ` for ${days()} days` };
    priceCache = out;
    priceAt = Date.now();
    return out;
  }).catch(err => {
    console.error('sellers price', err && err.message);
    return { ok: false, id, why: "couldn't reach Stripe" };
  }).finally(() => { priceAsking = null; });
  return priceAsking;
}

function money(cents, currency) {
  const c = String(currency || 'usd').toUpperCase();
  const n = (cents / 100).toFixed(2);
  return c === 'USD' ? '$' + n : c === 'EUR' ? '€' + n : c === 'GBP' ? '£' + n : n + ' ' + c;
}

/** Adds paid time to a listing: one more period on top of what's left. */
function markPaid(l, how, extraDays) {
  const t = Date.now();
  l.paidUntil = Math.max(t, l.paidUntil) + (extraDays || days()) * DAY;
  l.everPaid = true;
  l.paidHow = how;
  l.updatedAt = t;
  console.log(`sellers: a listing was paid (${how}) - ${waitingCount()} waiting for review`);
}

/** What Stripe charged in the price's own currency (Adaptive Pricing shows buyers their currency; the source amount is ours). */
function chargedOf(session) {
  const cc = session && session.currency_conversion;
  if (cc && cc.source_currency && cc.amount_total != null) return { cents: Number(cc.amount_total), currency: String(cc.source_currency).toLowerCase() };
  return { cents: Number(session && session.amount_total), currency: String((session && session.currency) || '').toLowerCase() };
}

/**
 * Asks Stripe about one payment page this server made (an entry of state.open) and credits it once if it's paid - to the
 * account's listing (or, with none right now, as days waiting for its next one). Resolves 'paid' | 'already' | 'open' |
 * 'gone' (expired / too old - dropped) | 'no' (couldn't ask - kept).
 */
const confirming = new Map();
function confirmOpen(entry) {
  if (confirming.has(entry.id)) return confirming.get(entry.id);
  const s = pay().stripe();
  if (!s) return Promise.resolve('no');
  const drop = () => { state.open = state.open.filter(o => o.id !== entry.id); save(); };
  const work = s.checkout.sessions.retrieve(entry.id).then(session => {
    const meta = (session && session.metadata) || {};
    if (meta.kind !== 'seller' || session.id !== entry.id) { drop(); return 'gone'; }
    if (state.paid.includes(session.id)) { drop(); return 'already'; }
    if (session.payment_status !== 'paid') {
      if (session.status === 'expired' || Date.now() - entry.at > 25 * HOUR) { drop(); return 'gone'; }
      return 'open';
    }
    // The amount Stripe took must be what this page was made for (never the session's own description of itself).
    const got = chargedOf(session);
    if (got.cents !== entry.cents || got.currency !== entry.currency) {
      console.error('sellers: paid amount does not match the payment page', session.id);
      drop();
      return 'gone';
    }
    state.paid.push(session.id);
    state.open = state.open.filter(o => o.id !== entry.id);
    const account = entry.account;
    const l = state.listings.find(x => x.account === account) || state.listings.find(x => x.id === meta.listing);
    if (l) markPaid(l, 'stripe');
    else { state.credit[account] = (state.credit[account] || 0) + days(); console.log('sellers: a payment is waiting for its shop'); }
    saveNow();   // money: on the disk now
    return 'paid';
  }).catch(err => {
    console.error('sellers confirm', err && err.message);
    if (Date.now() - entry.at > 72 * HOUR) drop();
    return 'no';
  }).finally(() => confirming.delete(entry.id));
  confirming.set(entry.id, work);
  return work;
}

/** Every open payment page of an account (or one session id this server made). */
function confirmAccount(account) {
  return Promise.all(state.open.filter(o => o.account === account).map(confirmOpen));
}

// ============================================================================ what the game sees
function productOut(p) { return { title: p.title, price: p.price, imageUrl: p.imageUrl, productUrl: p.productUrl }; }

function mineOut(l, fee) {
  const t = Date.now();
  const base = { ok: true, has: !!l, fee: fee && fee.ok ? fee.text : '', payOnline: !!(fee && fee.ok), days: days() };
  if (!l) return base;
  return Object.assign(base, {
    id: l.id,
    status: statusOf(l, t),
    note: l.note || '',
    paidUntil: l.paidUntil,
    liveUntil: isLive(l, t) ? l.paidUntil : 0,
    listing: { shopName: l.shopName, kind: l.kind, storeUrl: l.storeUrl, about: l.about, products: l.products.map(productOut) }
  });
}

let publicCache = null, publicAt = 0;
function publicListings() {
  const t = Date.now();
  if (publicCache && t - publicAt < 30000) return publicCache;
  const live = state.listings.filter(l => isLive(l, t)).sort((a, b) => a.decidedAt - b.decidedAt);
  publicCache = JSON.stringify({
    ok: true, now: t,
    listings: live.slice(0, 200).map(l => ({
      id: l.id, seller: l.username, shopName: l.shopName, kind: l.kind, about: l.about, storeUrl: l.storeUrl,
      products: l.products.slice(0, MAX_IMAGES).map(productOut)
    }))
  });
  publicAt = t;
  return publicCache;
}

// ============================================================================ a listing coming in
/** Reads {shopName, kind, storeUrl, about, products} into {ok, fields} or {ok:false, error}. */
function readFields(data) {
  const shopName = clean(data.shopName, 40);
  if (!shopName) return { ok: false, error: "Type your shop's name." };
  const kind = String(data.kind || '').toLowerCase();
  if (!KINDS.includes(kind)) return { ok: false, error: 'Pick what you sell: crafts, art, jewelry, clothing or other.' };
  const storeRaw = String(data.storeUrl || '').trim();
  const storeUrl = cleanLink(storeRaw);
  if (!storeUrl) return { ok: false, error: 'Your store link must start with https:// (like https://www.etsy.com/shop/YourShop) and be under 300 characters.' };
  const about = clean(data.about, 400, true);
  const raw = Array.isArray(data.products) ? data.products : [];
  if (raw.length > MAX_PRODUCTS) return { ok: false, error: `Up to ${MAX_PRODUCTS} products, please.` };
  const products = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] && typeof raw[i] === 'object' ? raw[i] : {};
    const title = clean(p.title, 60);
    const anything = title || String(p.imageUrl || '').trim() || String(p.productUrl || '').trim() || String(p.price || '').trim();
    if (!anything) continue;   // an empty row
    const n = i + 1;
    if (!title) return { ok: false, error: `Product ${n}: type its name.` };
    if (String(p.title || '').trim().length > 60) return { ok: false, error: `Product ${n}: the name is too long (60 letters at most).` };
    if (String(p.price || '').trim().length > 16) return { ok: false, error: `Product ${n}: keep the price short (like $24).` };
    const imageUrl = cleanImage(p.imageUrl);
    if (!imageUrl) return { ok: false, error: `Product ${n}: the picture link must start with https:// and end in .jpg or .png (right-click the photo on your shop > Copy image address).` };
    const productUrl = cleanLink(p.productUrl);
    if (!productUrl) return { ok: false, error: `Product ${n}: the product link must start with https:// (the page where people buy it).` };
    products.push({ title, price: clean(p.price, 16), imageUrl, productUrl });
  }
  if (!products.length) return { ok: false, error: 'Add at least one product (its name, a picture link and the link to buy it).' };
  return { ok: true, fields: { shopName, kind, storeUrl, about, products } };
}

/** Stores the account's listing (new, or changed - a change goes back for review). {ok, listing} or {ok:false, error}. */
function submit(p, fields, ip) {
  const key = String(p.username || '').toLowerCase();
  if (count('sapply|' + key, DAY) >= 10) return { ok: false, error: "You've changed your listing 10 times today - try again tomorrow." };
  if (count('sapplyip|' + ip, HOUR) >= 20) return { ok: false, error: 'Too many tries from here - wait an hour.' };
  note('sapply|' + key);
  note('sapplyip|' + ip);
  const t = Date.now();
  let l = listingOf(p);
  if (!l) {
    // A listing under this name from a deleted account belongs to nobody now: it goes.
    state.listings = state.listings.filter(x => x.account !== key);
    if (waitingCount() >= MAX_WAITING || state.listings.length >= MAX_LISTINGS) return { ok: false, error: 'Lots of shops are waiting right now - please try again in a few days.' };
    l = cleanListing({ id: newId(), account: key, username: p.username, acctCreated: String(p.created || ''), shopName: fields.shopName, createdAt: t });
    state.listings.push(l);
    if (state.credit[key] > 0) { markPaid(l, 'stripe', state.credit[key]); delete state.credit[key]; }   // paid before, taken down, back again
  }
  const changed = l.shopName !== fields.shopName || l.kind !== fields.kind || l.storeUrl !== fields.storeUrl || l.about !== fields.about ||
    JSON.stringify(l.products) !== JSON.stringify(fields.products);
  Object.assign(l, fields, { username: p.username, email: clean(p.email, 120), updatedAt: t });
  if (changed && l.state !== 'waiting') { l.state = 'waiting'; l.decidedAt = 0; }
  save();
  return { ok: true, listing: l };
}

// ============================================================================ requests
function readBody(req, limit) {
  return new Promise(resolve => {
    let body = '';
    let tooBig = false;
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > limit) { tooBig = true; body = ''; }
    });
    req.on('end', () => resolve(tooBig ? null : body));
    req.on('error', () => resolve(null));
  });
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };

function json(res, obj, status) {
  res.writeHead(status || 200, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS));
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function account(req) {
  const auth = String(req.headers.authorization || '');
  try { return players().check(auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''); } catch { return null; }
}

const checkedAt = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of checkedAt) if (t - v > HOUR) checkedAt.delete(k); }, 600000).unref();

const ROUTES = ['/sellers/apply', '/sellers/mine', '/sellers/checkout', '/sellers/remove', '/sellers/listings', '/sellers/paid', '/admin/sellers'];

/** Handles /sellers/* and /admin/sellers. Returns true if it answered. */
function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://relay'); } catch { return false; }
  const route = url.pathname;
  if (!ROUTES.includes(route)) return false;
  const ip = ipOf(req);

  if (req.method === 'OPTIONS' && route !== '/admin/sellers') {   // the web version of the game asks first
    res.writeHead(204, Object.assign({ 'access-control-max-age': '600' }, CORS));
    res.end();
    return true;
  }

  if (route === '/admin/sellers') { admin(req, res, ip); return true; }
  if (route === '/sellers/paid') { paidPage(res, url, ip); return true; }

  if (route === '/sellers/listings') {
    if (count('slist|' + ip, 60000) >= 60) { json(res, { ok: false, error: 'Slow down.' }, 429); return true; }
    note('slist|' + ip);
    json(res, publicListings());
    return true;
  }

  // ---- the seller's own routes: a live account (the same sign-in the Open Festival uses)
  let ready = true;
  try { ready = players().isReady(); } catch { ready = false; }
  if (!ready) { json(res, { ok: false, error: 'The server is starting up - try again in a few seconds.' }, 503); return true; }
  const p = account(req);
  if (!p) { json(res, { ok: false, error: 'Sign in to your live account first (join the Open Festival once).', signin: true }, 401); return true; }
  const key = String(p.username).toLowerCase();

  if (route === '/sellers/mine') {
    if (count('smine|' + key, HOUR) >= 60) { json(res, { ok: false, error: 'Too many checks - try again in a few minutes.' }, 429); return true; }
    note('smine|' + key);
    // Payment pages opened and not confirmed yet: ask Stripe (at most every 15 s), so closing the tab early is fine.
    const last = checkedAt.get(key) || 0;
    const ask = Date.now() - last > 15000 && state.open.some(o => o.account === key) ? (checkedAt.set(key, Date.now()), confirmAccount(key)) : Promise.resolve();
    ask.then(() => price()).then(fee => json(res, mineOut(listingOf(p), fee)))
      .catch(err => { console.error('sellers mine', err && err.message); if (!res.headersSent) json(res, { ok: false, error: 'Something went wrong - try again.' }, 500); });
    return true;
  }

  if (req.method !== 'POST') { json(res, { ok: false, error: 'POST, please.' }, 405); return true; }

  if (route === '/sellers/remove') {
    const l = listingOf(p);
    if (l) { state.listings = state.listings.filter(x => x !== l); save(); }
    json(res, { ok: true });
    return true;
  }

  if (route === '/sellers/checkout') {
    if (count('scheck|' + key, HOUR) >= 10) { json(res, { ok: false, error: 'Too many tries - wait an hour.' }, 429); return true; }
    note('scheck|' + key);
    const l = listingOf(p);
    if (!l) { json(res, { ok: false, error: 'Send your listing first.' }); return true; }
    if (l.state === 'declined') { json(res, { ok: false, error: 'This listing was declined - change it and send it again first.' }); return true; }
    price().then(fee => {
      const s = pay().stripe();
      const base = pay().baseUrl();
      if (!fee.ok || !s || !base) { json(res, { ok: false, manual: true, error: "Online payment isn't switched on yet - the organiser will email you about the fee." }); return; }
      // A page made in the last 20 hours that's still open is used again (one payment at a time, nothing lost).
      const recent = state.open.filter(o => o.account === key && o.url && Date.now() - o.at < 20 * HOUR && o.cents === fee.cents && o.currency === fee.currency)
        .sort((a, b) => b.at - a.at)[0];
      const reuse = recent ? confirmOpen(recent) : Promise.resolve('none');
      return reuse.then(r => {
        if (r === 'open') { json(res, { ok: true, url: recent.url }); return; }
        if (r === 'paid' || r === 'already') { json(res, { ok: false, paid: true, error: 'That payment went through - press Check again.' }); return; }
        const meta = { kind: 'seller', listing: l.id, account: key };
        return s.checkout.sessions.create({
          mode: 'payment',
          line_items: [{ price: fee.id, quantity: 1 }],
          customer_email: /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(p.email || '') ? p.email : undefined,
          metadata: meta,
          payment_intent_data: { metadata: meta, description: `New Moon, Same Dark - real shop listing (${days()} days) - ${l.shopName}`.slice(0, 900) },
          success_url: `${base}/sellers/paid?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/sellers/paid?cancel=1`
        }).then(session => {
          const entry = cleanOpen({ id: session.id, account: key, cents: fee.cents, currency: fee.currency, at: Date.now(), url: session.url });
          if (entry) {
            state.open.push(entry);
            if (state.open.length > 5000) state.open.splice(0, state.open.length - 5000);
            saveNow();
          }
          json(res, { ok: true, url: session.url });
        });
      });
    }).catch(err => {
      console.error('sellers checkout', err && err.message);
      if (!res.headersSent) json(res, { ok: false, error: "Couldn't open the payment page - try again in a minute." });
    });
    return true;
  }

  // ---- /sellers/apply
  readBody(req, MAX_BODY).then(body => {
    if (body === null) { json(res, { ok: false, error: 'That listing is too long.' }); return; }
    let data;
    try { data = JSON.parse(body); } catch { data = null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { json(res, { ok: false, error: "That didn't arrive properly - try again." }); return; }
    const r = readFields(data);
    const result = r.ok ? submit(p, r.fields, ip) : r;
    if (!result.ok) { json(res, { ok: false, error: result.error }); return; }
    return price().then(fee => json(res, mineOut(result.listing, fee)));
  }).catch(err => {
    console.error('sellers apply', err && err.message);
    if (!res.headersSent) json(res, { ok: false, error: 'Something went wrong - try again.' }, 500);
  });
  return true;
}

function paidPage(res, url, ip) {
  const P = pay();
  if (url.searchParams.get('cancel')) { P.page(res, 200, 'No problem', "<h1>No problem</h1><p>You weren't charged. You can close this page and go back to the game.</p>"); return; }
  const thanks = () => P.page(res, 200, 'Thanks', '<h1>Thanks!</h1><p>You can close this page and go back to the game - it shows your listing\'s status.</p>');
  const id = String(url.searchParams.get('session_id') || '');
  // Only pages this server made are ever asked about (anything else costs Stripe nothing), and 20 an hour from one address.
  const entry = SESSION_RE.test(id) ? state.open.find(o => o.id === id) : null;
  if (!entry || count('spaid|' + ip, HOUR) >= 20) {
    if (entry || state.paid.includes(id)) note('spaid|' + ip);
    if (state.paid.includes(id)) { P.page(res, 200, 'Thank you!', '<h1>Thank you - your listing is paid!</h1><p>Go back to the game: <b>Menu &gt; More &gt; Sell your products</b> shows how it\'s going.</p>'); return; }
    thanks();
    return;
  }
  note('spaid|' + ip);
  confirmOpen(entry).then(r => {
    if (r === 'paid' || r === 'already') {
      P.page(res, 200, 'Thank you!', `<h1>Thank you - your listing is paid!</h1><p>The organiser looks at every shop before it goes live (usually within a day or two).
Go back to the game: <b>Menu &gt; More &gt; Sell your products</b> shows how it's going.</p>`);
    } else if (r === 'open') {
      P.page(res, 200, 'Almost there', '<h1>Payment still going through</h1><p>It usually takes a minute. The game shows it by itself - press "Check again" there.</p>');
    } else {
      thanks();
    }
  });
}

// ============================================================================ your page
const CSS = `<style>
.card{background:#181c24;border:1px solid #2a2f3a;border-radius:10px;padding:12px 14px;margin:12px 0}
.warn{background:#3a3110;border:1px solid #e8b14c;color:#ffd77a;border-radius:8px;padding:10px 12px;margin:12px 0}
.st{font-weight:800}.st.review{color:#e8b14c}.st.live{color:#6fd49a}.st.declined,.st.expired{color:#ff8a80}.st.payment{color:#8ab4ff}
.muted{color:#8a93a3}a{color:#e8b14c}.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}form.inline{display:inline}
button.ghost{background:#2a2f3a;color:#e8eaf0}button.no{background:#ff8a80}button.yes{background:#3ddc84}
.pre{white-space:pre-wrap;word-break:break-word;color:#e8eaf0}
.prods{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin:8px 0}
.prod{background:#1d212b;border:1px solid #2a2f3a;border-radius:8px;padding:6px;font-size:13px;word-break:break-word}
.prod img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;background:#111}
textarea{width:100%;box-sizing:border-box;min-height:56px;padding:8px;border-radius:6px;border:1px solid #444;background:#1d212b;color:#fff;font:inherit}
input.w{width:100%;box-sizing:border-box;margin:2px 0}
details summary{cursor:pointer;color:#aab2c0;font-size:13px}
</style>`;

function adminSection(hiddenKey) {
  const t = Date.now();
  const waiting = state.listings.filter(l => statusOf(l, t) === 'review').length;
  const live = state.listings.filter(l => isLive(l, t)).length;
  return `<h2>Real shops (sellers)</h2><p class="small">Crafters and artists pay to show their real products at their booth (Menu &gt; More &gt; Sell your products).
${waiting ? `<b class="on">${waiting} paid and waiting for you</b>` : 'None waiting'} &middot; ${live} live &middot; ${state.listings.length} in all.</p>
<form method="post" action="/admin/sellers">${hiddenKey}<button type="submit">Review shops${waiting ? ` (${waiting})` : ''}</button></form>
<form method="post" action="/admin/sellers">${hiddenKey}<input type="hidden" name="action" value="backup"><button type="submit">Download a backup (real shops)</button></form>`;
}

function admin(req, res, ip) {   // eslint-disable-line no-unused-vars
  const P = pay();
  // Round 110: the admin session (adminauth.js) - sign-in, wrong-key limits, CSRF and the old key form all live there.
  require('./adminauth').guard(req, res, { path: '/admin/sellers', limit: 64 * 1024 }).then(g => {
    if (!g) return;
    const form = g.form, key = g.token;
    if (form.get('action') === 'backup') {   // the whole file (it has sellers' emails - keep it private)
      flush();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="sellers-backup-${new Date().toISOString().slice(0, 10)}.json"` });
      res.end(JSON.stringify(state, null, 1));
      return;
    }
    let msg = '';
    try { msg = adminAction(String(form.get('action') || ''), form); } catch (err) { console.error('sellers admin', err && err.message); msg = 'Something went wrong - try again.'; }
    return price().then(fee => P.page(res, 200, 'Real shops', adminHtml(key, msg, fee)));
  }).catch(err => { console.error('sellers', err && err.message); if (!res.headersSent) P.page(res, 500, 'Try again', '<h1>Something went wrong</h1>'); });
}

function adminAction(action, form) {
  if (!action || action === 'refresh') return '';
  const l = state.listings.find(x => x.id === String(form.get('id') || ''));
  if (!l) return 'That listing isn\'t here any more.';
  const t = Date.now();
  const newNote = clean(form.get('note'), 300, true);
  switch (action) {
    case 'approve':
      if (!l.products.length) return 'It has no products left - it can\'t go live.';
      l.state = 'approved'; l.note = newNote; l.decidedAt = t; save();
      return `Approved ${l.shopName}.` + (isPaid(l, t) ? ` It's live until ${dateText(l.paidUntil)}.` : ' It goes live once it\'s paid (or press Mark paid).');
    case 'decline':
      l.state = 'declined'; l.note = newNote; l.decidedAt = t; save();
      return `Declined ${l.shopName}.` + (isPaid(l, t) ? ' It was paid - refund it in your Stripe dashboard (Payments) if you need to.' : '');
    case 'note':
      l.note = newNote; save();
      return `Saved the note for ${l.shopName}.`;
    case 'markpaid': {
      const n = Math.round(Number(form.get('days')) || days());
      if (!(n >= 1 && n <= 400)) return 'Days must be 1 to 400.';
      markPaid(l, 'manual', n); save();
      return `Marked ${l.shopName} paid for ${n} more days (until ${dateText(l.paidUntil)}).`;
    }
    case 'until': {
      const d = String(form.get('until') || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'Pick a date.';
      const ms = Date.parse(d + 'T23:59:59Z');
      if (!Number.isFinite(ms)) return 'Pick a date.';
      l.paidUntil = ms; if (ms > t) l.everPaid = true; l.updatedAt = t; save();
      return `${l.shopName} now ends on ${d}${ms <= t ? ' (that\'s past, so it\'s hidden)' : ''}.`;
    }
    case 'unpay':
      l.paidUntil = 0; save();
      return `${l.shopName} is no longer paid (hidden until it's paid again).`;
    case 'editproduct': case 'removeproduct': {
      const i = Number(form.get('index'));
      if (!(i >= 0 && i < l.products.length)) return 'That product isn\'t there any more.';
      if (action === 'removeproduct') { l.products.splice(i, 1); save(); return `Removed a product from ${l.shopName}.`; }
      const p = cleanProduct({ title: form.get('title'), price: form.get('price'), imageUrl: form.get('imageUrl'), productUrl: form.get('productUrl') });
      if (!p) return 'Each product needs a name, a picture link (https, .jpg or .png) and a product link (https).';
      l.products[i] = p; save();
      return `Saved ${l.shopName}'s product.`;
    }
    case 'delete':
      state.listings = state.listings.filter(x => x !== l); save();
      return `Deleted ${l.shopName}.`;
    default:
      return '';
  }
}

function linkTag(url) { return `<a href="${h(url)}" target="_blank" rel="noopener noreferrer nofollow">${h(url)}</a>`; }

function adminHtml(key, msg, fee) {
  const t = Date.now();
  const hiddenKey = require('./adminauth').hidden(key);   // Round 110: the session's CSRF token (key = that token now)
  const parts = [CSS, '<h1>Real shops</h1>'];
  if (msg) parts.push(`<div class="code" style="font-size:15px;letter-spacing:0;text-align:left;white-space:pre-wrap">${h(msg)}</div>`);
  if (!PERSISTENT) parts.push('<div class="warn">Listings are forgotten when the free server restarts - add the $7 disk (STORE_DATA_DIR, see README.txt) before taking real money.</div>');
  parts.push(`<p class="small">Online payment: ${fee.ok ? `<span class="on">ON</span> - ${h(fee.text)}` : `<span class="off">OFF</span> (${h(fee.why || 'not set up')}) - sellers wait for payment; press "Mark paid" when they've paid you another way`}.
A shop shows in the game only when it's <b>approved</b> and <b>paid</b>. A seller who changes their listing comes back here for review.</p>`);
  parts.push(`<div class="row"><form class="inline" method="post" action="/admin/sellers">${hiddenKey}<button type="submit" class="ghost">Refresh</button></form>
<form class="inline" method="post" action="/admin/sellers">${hiddenKey}<input type="hidden" name="action" value="backup"><button type="submit" class="ghost">Download a backup (sellers.json)</button></form>
<form class="inline" method="post" action="/admin">${hiddenKey}<button type="submit" class="ghost">Back to admin</button></form></div>`);
  const groups = [
    ['Paid - waiting for you', l => statusOf(l, t) === 'review'],
    ['Live now', l => statusOf(l, t) === 'live'],
    ['Waiting for payment', l => statusOf(l, t) === 'payment'],
    ['Expired', l => statusOf(l, t) === 'expired'],
    ['Declined', l => statusOf(l, t) === 'declined']
  ];
  for (const [title, test] of groups) {
    const list = state.listings.filter(test).sort((a, b) => b.updatedAt - a.updatedAt);
    parts.push(`<h2>${h(title)} (${list.length})</h2>`);
    if (!list.length) parts.push('<p class="muted">None.</p>');
    for (const l of list) parts.push(card(l, hiddenKey, t));
  }
  return parts.join('\n');
}

const STATUS_WORDS = { payment: 'WAITING FOR PAYMENT', review: 'PAID - WAITING FOR REVIEW', live: 'LIVE', expired: 'EXPIRED', declined: 'DECLINED' };

function card(l, hiddenKey, t) {
  const st = statusOf(l, t);
  const idField = `<input type="hidden" name="id" value="${h(l.id)}">`;
  const form = (inner, confirm) => `<form class="inline" method="post" action="/admin/sellers"${confirm ? ` onsubmit="return confirm('${confirm}')"` : ''}>${hiddenKey}${idField}${inner}</form>`;
  const prods = l.products.map((p, i) => `<div class="prod"><img src="${h(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"><b>${h(p.title)}</b> ${h(p.price)}<br>${linkTag(p.productUrl)}
<details><summary>Edit / remove</summary><form method="post" action="/admin/sellers">${hiddenKey}${idField}<input type="hidden" name="index" value="${i}">
<input class="w" name="title" maxlength="60" value="${h(p.title)}"><input class="w" name="price" maxlength="16" value="${h(p.price)}">
<input class="w" name="imageUrl" maxlength="300" value="${h(p.imageUrl)}"><input class="w" name="productUrl" maxlength="300" value="${h(p.productUrl)}">
<button type="submit" name="action" value="editproduct">Save</button> <button type="submit" name="action" value="removeproduct" class="no">Remove</button></form></details></div>`).join('');
  return `<div class="card"><b style="font-size:18px">${h(l.shopName)}</b> <span class="small">${h(KIND_NAMES[l.kind])} &middot; by <b>${h(l.username)}</b> (${h(l.email || 'no email')}) &middot; sent ${h(ago(t - l.createdAt))}${l.updatedAt > l.createdAt + 60000 ? ', changed ' + h(ago(t - l.updatedAt)) : ''}</span><br>
<span class="st ${st}">${STATUS_WORDS[st]}</span> <span class="small">&middot; paid until ${h(dateText(l.paidUntil))}${l.paidHow ? ' (' + h(l.paidHow) + ')' : ''}</span>
<p>Store: ${l.storeUrl ? linkTag(l.storeUrl) : '-'}</p>${l.about ? `<p class="pre">${h(l.about)}</p>` : ''}
<div class="prods">${prods || '<span class="muted">No products.</span>'}</div>
<form method="post" action="/admin/sellers">${hiddenKey}${idField}<label class="small">Note to the seller (they see it in the game)</label><textarea name="note" maxlength="300">${h(l.note)}</textarea>
<div class="row" style="margin-top:6px">${l.state !== 'approved' ? '<button type="submit" name="action" value="approve" class="yes">Approve</button>' : ''}${l.state !== 'declined' ? '<button type="submit" name="action" value="decline" class="no">Decline</button>' : ''}<button type="submit" name="action" value="note" class="ghost">Save note</button></div></form>
<div class="row" style="margin-top:6px">${form(`<input type="hidden" name="action" value="markpaid"><input name="days" value="${days()}" style="width:60px" inputmode="numeric"> <button type="submit" class="ghost">Mark paid (days)</button>`)}
${form(`<input type="hidden" name="action" value="until"><input type="date" name="until" value="${l.paidUntil > 0 ? dateText(l.paidUntil) : ''}" style="width:150px"> <button type="submit" class="ghost">Set end date</button>`)}
${isPaid(l, t) ? form('<input type="hidden" name="action" value="unpay"><button type="submit" class="ghost">Not paid</button>', 'Hide this shop until it is paid again?') : ''}
${form('<input type="hidden" name="action" value="delete"><button type="submit" class="ghost">Delete</button>', 'Delete this listing for good?')}</div></div>`;
}

module.exports = {
  handle, adminSection, flush, KINDS,
  _test: { state: () => state, reset: () => { state = blank(); hits.clear(); publicCache = null; }, readFields, submit, statusOf, adminAction, cleanImage, cleanLink, markPaid, publicListings }
};
