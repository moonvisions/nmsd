// Festival Tycoon payments (Round 43): real tickets for artists' venues, through Stripe.
//
// How the money moves (Stripe Connect, "destination charges"):
//   - a fan buys a ticket on Stripe's own checkout page (card, Apple/Google Pay, and whatever else is
//     switched on for connected accounts in the Stripe dashboard);
//   - the artist is paid straight into their own Stripe account, and their name is on the statement;
//   - the platform keeps its fee: PLATFORM_FEE_PERCENT (10 unless changed) plus Stripe's own card fee
//     (2.9% + 30 cents), which Stripe takes from the platform with this kind of charge - so the platform
//     never loses money on a ticket and the artist sees one clear number;
//   - the ticket code is made before checkout, printed on Stripe's email receipt and shown on the
//     thank-you page, so a fan who closes the tab still has it. Codes check themselves (signed with
//     TICKET_SECRET), so there's no database to run.
//
// Settings (Render > your service > Environment):
//   STRIPE_SECRET_KEY     your Stripe secret key (sk_test_... to practise, sk_live_... for real)
//   TICKET_SECRET         any long random text - signs ticket codes; never share it or change it
//   ADMIN_KEY             a password for your admin page (at least 8 characters)
//   PLATFORM_FEE_PERCENT  optional, default 10
//   PUBLIC_URL            optional, your server's https:// address (Render's own address is used otherwise)
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const community = require('./community');
const store = require('./store');   // Round 55: Moon Shards, player accounts and the vendor market (store.js)
const reports = require('./reports');   // Round 57: players reported in online rooms (reports.js)
const patchbay = require('./patchbay');   // Round 60: the DJ patch bay (/admin/patch) and the DJs' own page (/dj)
const applications = require('./applications');   // Round 67: DJs / VJs / artists applying to play the Open Festival (/apply)
const analytics = () => require('./analytics');   // Round 71: play stats (/admin/stats) - lazy, it requires this file too
const auth = require('./adminauth');   // Round 110: one admin sign-in (a session cookie) for every /admin page
const hub = () => require('./adminhub');   // Round 110: the admin home (/admin)

const VENDORS_FILE = path.join(__dirname, 'vendors.json');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 32 letters: no 0/O or 1/I
const MIN_TICKET_CENTS = 200;

let stripeClient = null;
function stripe() {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const Stripe = require('stripe');
    stripeClient = new Stripe(key);
  } catch {
    stripeClient = null;
  }
  return stripeClient;
}

function feePercent() {
  const n = Number(process.env.PLATFORM_FEE_PERCENT);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 10;
}

/** The platform's share: its percentage plus Stripe's card fee (which Stripe charges the platform). */
function platformCents(cents) {
  return Math.min(cents - 1, Math.round(cents * feePercent() / 100 + cents * 0.029 + 30));
}

function cleanId(id) {
  // The same clean-up the game applies to venue ids.
  return String(id || '').replace(/,/g, ' ').replace(/\//g, '-').replace(/[\n<>]/g, '').trim().slice(0, 32).replace(/ /g, '-');
}

// vendors.json, read at most every 30 seconds.
let feedCache = null, feedLoadedAt = 0;
function feed() {
  const now = Date.now();
  if (feedCache && now - feedLoadedAt < 30000) return feedCache;
  try {
    feedCache = JSON.parse(fs.readFileSync(VENDORS_FILE, 'utf8')) || {};
  } catch {
    feedCache = feedCache || {};
  }
  feedLoadedAt = now;
  return feedCache;
}

function venues() {
  const f = feed();
  return Array.isArray(f.venues) ? f.venues : [];
}

/** Round 60: the switches exactly as vendors.json has them. */
function vendorFeatures() {
  const f = feed().features || {};
  // Round 55: + the Moon Shards store and the vendor portal (see store.js)
  return { artistVenues: !!f.artistVenues, ticketSales: !!f.ticketSales, liveEvents: !!f.liveEvents, store: !!f.store, vendorPortal: !!f.vendorPortal };
}

/** The admin's switches in vendors.json (both off unless switched on). Round 60: the patch bay can switch live events on too. */
function features() {
  const on = vendorFeatures();
  if (!on.liveEvents && patchbay.liveEventsSwitch()) on.liveEvents = true;
  return on;
}

function events() {
  const f = feed();
  return Array.isArray(f.events) ? f.events : [];
}

/** Round 60: every live event - vendors.json's, then the ones made on the patch bay page (same id: vendors.json wins). */
function allEvents() {
  const list = events().slice();
  const have = new Set(list.map(e => cleanId(e && e.id)));
  for (const e of patchbay.events()) if (!have.has(cleanId(e.id))) list.push(e);
  return list;
}

/** Round 50: a live event from vendors.json, by id. */
function findEvent(id) {
  const want = cleanId(id);
  return allEvents().find(e => e && cleanId(e.id) === want) || null;   // Round 60: + the patch bay's events
}

/** Something that sells tickets: an artist's venue, or (Round 50) a live event. */
function findVenue(id) {
  // Event tickets are signed as "event:<id>", so an event and a venue can never share codes.
  if (String(id || '').startsWith('event:')) {
    const only = findEvent(String(id).slice(6));
    return only ? Object.assign({ isEvent: true }, only) : null;
  }
  const want = cleanId(id);
  const venue = venues().find(v => v && cleanId(v.id) === want);
  if (venue) return venue;
  const ev = findEvent(id);
  return ev ? Object.assign({ isEvent: true }, ev) : null;
}

function toCode(bytes, length) {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];   // 256 / 32: no bias
  return out;
}

function sign(venue, nonce) {
  return toCode(crypto.createHmac('sha256', process.env.TICKET_SECRET).update(cleanId(venue) + '|' + nonce).digest(), 8);
}

/** A ticket code: 8 characters from the purchase, 8 of signature, shown as XXXX-XXXX-XXXX-XXXX. */
function makeCode(venue, purchaseId) {
  if (!process.env.TICKET_SECRET) return null;
  const nonce = toCode(crypto.createHash('sha256').update('nonce|' + purchaseId).digest(), 8);
  const c = nonce + sign(venue, nonce);
  return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8, 12) + '-' + c.slice(12, 16);
}

/** True if a code was made by makeCode for this venue (dashes and case don't matter). */
function verifyCode(venue, code) {
  if (!process.env.TICKET_SECRET) return false;
  const flat = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z2-9]{16}$/.test(flat)) return false;
  const want = sign(venue, flat.slice(0, 8));
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(flat.slice(8)));
}

/** Where Stripe sends fans back to: never taken from the request (it could be faked). */
function baseUrl() {
  const u = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
  return /^https:\/\//.test(u) ? u.replace(/\/$/, '') : null;
}

function adminOk(key) {
  const want = process.env.ADMIN_KEY || '';
  if (want.length < 8) return false;
  const a = crypto.createHash('sha256').update(String(key || '')).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

/** A signature for an artist's own "finish signing up" link (so they never need the admin key). */
function accountSig(account) {
  return crypto.createHmac('sha256', process.env.TICKET_SECRET || 'unset').update('acct|' + account).digest('hex').slice(0, 24);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(res, status, title, body) {
  // Round 60: + never shown inside someone else's page (no clickjacking the admin buttons).
  // Round 110: referrer-policy same-origin (was no-referrer): with no-referrer browsers send "Origin: null" on a form post,
  // and the admin pages' forms must show their own origin (the CSRF check). Other sites still get no referrer at all.
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#111318;color:#e8eaf0;margin:0;padding:24px 16px;line-height:1.5}
main{max-width:620px;margin:0 auto}h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:22px 0 6px}p{color:#aab2c0}
.code{font:700 28px ui-monospace,Menlo,monospace;letter-spacing:2px;background:#1d212b;border:2px dashed #e8b14c;border-radius:10px;padding:18px;text-align:center;color:#e8b14c;margin:18px 0;user-select:all;word-break:break-all}
a.btn,button{color:#111;background:#e8b14c;border:0;border-radius:6px;padding:9px 14px;font-weight:700;text-decoration:none;display:inline-block;cursor:pointer;margin:4px 0;font-size:14px}
table{width:100%;border-collapse:collapse}td{padding:8px;border-bottom:1px solid #2a2f3a;vertical-align:top}.small{font-size:13px;color:#8a93a3}
.on{color:#6fd49a;font-weight:700}.off{color:#ff8a80;font-weight:700}input{padding:9px;border-radius:6px;border:1px solid #444;background:#1d212b;color:#fff;width:220px}
select{padding:9px;border-radius:6px;border:1px solid #444;background:#1d212b;color:#fff}</style></head>
<body>${res.adminPage ? require('./adminui').chrome(res.adminPage.path, res.adminPage.token) : ''}<main>${body}</main></body></html>`);   // Round 110: + the admin top bar on signed-in admin pages
}

function readForm(req, limit) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { body = ''; req.destroy(); }
    });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

function fail(res, err, what) {
  console.error(what, err && err.message);
  page(res, 502, 'Try again', '<h1>Something went wrong</h1><p>Please try again in a minute.</p>');
}

/** Handles the payment pages. Returns true if it answered the request. */
function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://relay');
  } catch {
    return false;
  }

  const route = url.pathname;

  // Round 110: /admin/login and /admin/logout (adminauth.js) - before anything else.
  if (auth.handle(req, res)) return true;

  // Round 55: the Moon Shards store, accounts and the vendor portal (/store/..., /vendor).
  if (store.handle(req, res)) return true;

  // Round 60: the DJ patch bay (/admin/patch) and each DJ's own page (/dj?key=...).
  if (patchbay.handle(req, res)) return true;

  // ---- A fan buys a ticket: straight to Stripe's checkout page. ----
  if (route.startsWith('/buy/')) {
    let id = '';
    try { id = decodeURIComponent(route.slice(5)); } catch { id = ''; }
    const venue = findVenue(id);
    const s = stripe();
    const base = baseUrl();
    const on = features();
    if (!venue) { page(res, 404, 'Not found', "<h1>No such venue</h1><p>This venue isn't on the list.</p>"); return true; }
    const cents = Math.round(Number(venue.ticketPrice) * 100);
    // A venue pays its artist (Connect); a live event can too, or be the platform's own show (no account).
    const switchedOn = venue.isEvent ? on.liveEvents : on.artistVenues;
    if (!switchedOn || !on.ticketSales || !s || !base || !process.env.TICKET_SECRET || (!venue.isEvent && !venue.stripeAccount) || !(cents >= MIN_TICKET_CENTS)) {
      page(res, 503, 'Tickets not on sale', "<h1>Tickets aren't on sale yet</h1><p>This venue hasn't switched on ticket sales. Check back soon!</p>");
      return true;
    }

    const purchase = crypto.randomBytes(12).toString('hex');
    const ticketId = venue.isEvent ? 'event:' + cleanId(venue.id) : venue.id;
    const code = makeCode(ticketId, purchase);
    s.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: { name: `${venue.name} - ${venue.artist}`.slice(0, 120), description: 'Entry to the live set in Festival Tycoon' }
        }
      }],
      payment_intent_data: Object.assign(venue.stripeAccount ? {
        application_fee_amount: platformCents(cents),
        on_behalf_of: venue.stripeAccount,
        transfer_data: { destination: venue.stripeAccount }
      } : {}, {
        description: `Festival Tycoon ticket - ${venue.name}. Your ticket code: ${code}`.slice(0, 900),
        metadata: { venue: cleanId(ticketId), purchase }
      }),
      metadata: { venue: cleanId(ticketId), purchase },
      success_url: `${base}/ticket/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/ticket/cancel`
    }).then(session => {
      res.writeHead(303, { location: session.url });
      res.end();
    }).catch(err => fail(res, err, 'checkout'));
    return true;
  }

  // ---- After paying: show the ticket code (also on the emailed receipt). ----
  if (route === '/ticket/success') {
    const s = stripe();
    const id = url.searchParams.get('session_id') || '';
    if (!s || !/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) { page(res, 400, 'Ticket', '<h1>Ticket not found</h1>'); return true; }
    s.checkout.sessions.retrieve(id).then(session => {
      const venueId = session.metadata && session.metadata.venue;
      const purchase = session.metadata && session.metadata.purchase;
      if (session.payment_status !== 'paid' || !venueId || !purchase) {
        page(res, 200, 'Almost there', "<h1>Payment still processing</h1><p>Refresh this page in a minute. Your code will also be on Stripe's emailed receipt.</p>");
        return;
      }
      const venue = findVenue(venueId);
      const code = makeCode(venueId, purchase);
      page(res, 200, 'Your ticket', `<h1>You're in!</h1>
<p>Your ticket for <b>${escapeHtml(venue ? venue.name : venueId)}</b>${venue ? ' - ' + escapeHtml(venue.artist) : ''}.</p>
<div class="code">${escapeHtml(code)}</div>
<p><b>Keep this code</b> - it's also on your emailed receipt. ${venue && venue.isEvent
  ? 'In the game, open Settings, find <b>Live events</b>, type the code and press "Join" when the event is live.'
  : 'In the game, walk up to the venue\'s gate, press E, type the code and press "Use my ticket code".'}
It works on up to 2 of your devices.</p>`);
    }).catch(err => fail(res, err, 'success'));
    return true;
  }

  if (route === '/ticket/cancel') {
    page(res, 200, 'Cancelled', "<h1>No problem</h1><p>You weren't charged. You can close this page.</p>");
    return true;
  }

  // ---- An artist's own "finish signing up" link (no admin key involved). ----
  if (route === '/onboard/continue') {
    const s = stripe();
    const base = baseUrl();
    const account = String(url.searchParams.get('acct') || '');
    const sig = String(url.searchParams.get('sig') || '');
    if (!s || !base || !/^acct_[A-Za-z0-9]{6,40}$/.test(account) || sig.length !== 24 ||
        !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(accountSig(account)))) {
      page(res, 400, 'Sign-up', '<h1>This link isn\'t valid</h1><p>Ask the festival for a new sign-up link.</p>');
      return true;
    }
    const again = `${base}/onboard/continue?acct=${encodeURIComponent(account)}&sig=${sig}`;
    s.accountLinks.create({ account, refresh_url: again, return_url: `${base}/onboard/done`, type: 'account_onboarding' })
      .then(link => { res.writeHead(303, { location: link.url }); res.end(); })
      .catch(err => fail(res, err, 'onboard-continue'));
    return true;
  }

  if (route === '/onboard/done') {
    page(res, 200, 'Thanks', "<h1>Thanks - you're set up!</h1><p>Your ticket money will be paid into the bank account you gave Stripe. You can close this page.</p>");
    return true;
  }

  // ---- Your admin pages. Round 110: /admin is the admin home (adminhub.js) behind one sign-in (adminauth.js); this
  // store & payments page moved to /admin/store. The store's own buttons still post to /admin with an "action" (store.js,
  // community.js, reports.js and the patch bay's sections build those forms) - those land here and show this page again.
  if (route === '/admin' || route === '/admin/store') {
    auth.guard(req, res, { path: route, limit: 8192 }).then(g => {
      if (!g) return;
      const form = g.form;
      const action = form.get('action');
      if (!action) {
        if (route === '/admin') return hub().render(req, res, g.token);
        return adminPage(res, g.token, '');
      }
      res.adminPage = { path: '/admin/store', token: g.token };   // (a store action: shown as the store page)
      if (action === 'onboard') return onboard(res, form.get('venue'), g.token);
      if (action === 'store-backup') {   // Round 55: the store's backup, as a file download
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store',
          'content-disposition': `attachment; filename="store-backup-${new Date().toISOString().slice(0, 10)}.json"` });
        res.end(store.backup());
        return;
      }
      let note = reports.adminAction(action, form);   // Round 57: player reports from online rooms
      if (note === null) note = store.adminAction(action, form);   // Round 55: vendors, designs, reports, shards
      if (note === null) community.adminAction(action, String(form.get('item') || ''));   // Round 45: approve / reject players' creations
      return adminPage(res, g.token, note);
    }).catch(err => fail(res, err, 'admin'));
    return true;
  }

  return false;
}

let liveEvents = null;   // the relay tells us which events have their room open (Round 50)
function setLiveEvents(set) { liveEvents = set; }

function adminPage(res, token, note) {
  const s = stripe();
  const on = features();
  const list = venues();
  const checks = list.map(v => (s && v && v.stripeAccount)
    ? s.accounts.retrieve(String(v.stripeAccount)).then(a => a.charges_enabled).catch(() => null)
    : Promise.resolve(null));
  Promise.all(checks).then(ready => {
    const hidden = auth.hidden(token);   // Round 110: the session's CSRF token (was the admin key itself)
    const rows = list.map((v, i) => {
      const id = cleanId(v.id);
      const price = Number(v.ticketPrice);
      const state = !v.stripeAccount ? '<span class="small">no payout account yet</span>'
        : ready[i] === true ? '<span class="on">payouts ready</span>'
          : ready[i] === false ? '<span class="off">artist hasn\'t finished signing up</span>' : '<span class="small">couldn\'t check</span>';
      return `<tr><td><b>${escapeHtml(v.name)}</b><br><span class="small">${escapeHtml(v.artist)} &middot; id ${escapeHtml(id)}</span></td>
<td>${state}<br><span class="small">${price >= MIN_TICKET_CENTS / 100 ? '$' + price.toFixed(2) + ' tickets' : 'no ticketPrice (min $' + (MIN_TICKET_CENTS / 100).toFixed(2) + ')'}</span></td>
<td><form method="post" action="/admin">${hidden}<input type="hidden" name="action" value="onboard"><input type="hidden" name="venue" value="${escapeHtml(id)}">
<button type="submit">${v.stripeAccount ? 'New sign-up link' : 'Set up payouts'}</button></form></td></tr>`;
    }).join('');
    const example = 500;
    page(res, 200, 'Store & payments', `<p class="small"><a href="/admin/store" style="color:#e8b14c">Refresh</a></p><h1>Store &amp; payments</h1>
${note ? `<div class="code" style="font-size:15px;letter-spacing:0;text-align:left">${escapeHtml(note)}</div>` : ''}
<h2>Special features</h2>
<p>These are OFF unless you switch them on, so the game stays the festival tycoon career plus the multiplayer festival.</p>
<table>
<tr><td><b>Artists' venues</b><br><span class="small">Fenced venues where artists stream live sets</span></td><td>${on.artistVenues ? '<span class="on">ON</span>' : '<span class="off">OFF</span>'}</td></tr>
<tr><td><b>Real ticket sales</b><br><span class="small">Fans buy tickets through Stripe; your fee is kept automatically</span></td><td>${on.ticketSales ? '<span class="on">ON</span>' : '<span class="off">OFF</span>'}</td></tr>
<tr><td><b>Live events</b><br><span class="small">Ticketed online festivals with a real artist live on the main stage</span></td><td>${on.liveEvents ? '<span class="on">ON</span>' : '<span class="off">OFF</span>'}</td></tr>
<tr><td><b>Moon Shards store</b><br><span class="small">Player accounts, premium outfit pieces and vendor designs bought with shards</span></td><td>${on.store ? '<span class="on">ON</span>' : '<span class="off">OFF</span>'}</td></tr>
<tr><td><b>Vendor portal</b><br><span class="small">Vendors apply, pay for a season plan and send designs for your review</span></td><td>${on.vendorPortal ? '<span class="on">ON</span>' : '<span class="off">OFF</span>'}</td></tr>
</table>
${patchbay.adminSection(hidden)}
${applications.adminSection(hidden)}
${require('./sellers').adminSection(hidden)}
${analytics().adminSection(hidden)}
${require('./players').adminSection(hidden)}
<h2>Live events</h2>
<p class="small">Event password for opening an event from the game: ${process.env.EVENT_HOST_KEY && process.env.EVENT_HOST_KEY.length >= 8 ? 'ready (EVENT_HOST_KEY)' : 'NOT SET - add EVENT_HOST_KEY on Render or events can\'t open'}</p>
<table>${allEvents().map(e => `<tr><td><b>${escapeHtml(e.name)}</b><br><span class="small">${escapeHtml(e.artist)} &middot; id ${escapeHtml(cleanId(e.id))} &middot; ${escapeHtml(e.when || '')}</span></td>
<td>${liveEvents && liveEvents.has(cleanId(e.id)) ? '<span class="on">LIVE NOW</span>' : '<span class="small">not live</span>'}<br><span class="small">${e.free ? 'free' : Number(e.ticketPrice) >= MIN_TICKET_CENTS / 100 ? '$' + Number(e.ticketPrice).toFixed(2) + ' tickets' : 'no ticketPrice'}</span></td></tr>`).join('') || '<tr><td>No events yet (add them to vendors.json, or make one on the DJ Patch Bay page).</td></tr>'}</table>
<p class="small">To switch one on or off: edit vendors.json on GitHub and change the line near the top, e.g.
<code>"features": { "artistVenues": true, "ticketSales": false }</code>, then commit. It takes effect in a minute or two.</p>
<h2>Artists' venues</h2>
<p class="small">Stripe: ${s ? 'connected' : 'NOT SET (add STRIPE_SECRET_KEY)'} &middot; ticket codes: ${process.env.TICKET_SECRET ? 'ready' : 'NOT SET (add TICKET_SECRET)'} &middot;
server address: ${baseUrl() ? 'ready' : 'NOT SET (add PUBLIC_URL)'} &middot; your fee: ${feePercent()}% + card fee
(on a $${(example / 100).toFixed(2)} ticket you keep $${(platformCents(example) / 100).toFixed(2)}, the artist gets $${((example - platformCents(example)) / 100).toFixed(2)} before Stripe's payout fees)</p>
<table>${rows || '<tr><td>No venues in vendors.json yet.</td></tr>'}</table>
${reports.adminSection(hidden)}
${store.adminSection(hidden)}
${community.adminSection(hidden)}`);
  }).catch(err => fail(res, err, 'admin-page'));
}

function onboard(res, venueId, token) {
  const s = stripe();
  const base = baseUrl();
  const venue = findVenue(venueId);
  if (!s || !base || !venue || !process.env.TICKET_SECRET) {
    page(res, 400, 'Admin', "<h1>Can't do that yet</h1><p>Check STRIPE_SECRET_KEY, TICKET_SECRET and PUBLIC_URL are set and the venue is in vendors.json.</p>");
    return;
  }

  const ready = venue.stripeAccount
    ? Promise.resolve(String(venue.stripeAccount))
    : s.accounts.create({
      type: 'express',
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_profile: { name: String(venue.artist || venue.name).slice(0, 100), product_description: 'Live music sets in Festival Tycoon' },
      metadata: { venue: cleanId(venue.id) }
    }).then(a => a.id);
  ready.then(account => {
    const link = `${base}/onboard/continue?acct=${encodeURIComponent(account)}&sig=${accountSig(account)}`;
    page(res, 200, 'Artist sign-up', `<h1>Sign-up for ${escapeHtml(venue.artist)}</h1>
<p><b>1.</b> Send this link to the artist. They fill in their details and bank account with Stripe (about 5 minutes).
The link keeps working, so they can come back to it:</p>
<div class="code" style="font-size:14px;letter-spacing:0">${escapeHtml(link)}</div>
<p><b>2.</b> In vendors.json, add this to the ${escapeHtml(venue.name)} venue (inside its { }), set the ticket price, then commit:</p>
<div class="code" style="font-size:15px;letter-spacing:0">"stripeAccount": "${escapeHtml(account)}", "ticketPrice": 5.00</div>
<p><a class="btn" href="/admin/store">Back to store &amp; payments</a></p>`);
  }).catch(err => {
    console.error('onboard', err && err.message);
    page(res, 502, 'Admin', `<h1>Stripe said no</h1><p>${escapeHtml(err && err.message)}</p><p class="small">Is Connect switched on in your Stripe dashboard?</p>`);
  });
}

// Round 55: stripe, baseUrl, page, escapeHtml and readForm are shared with store.js.
// Round 60: + allEvents and vendorFeatures (for patchbay.js).
module.exports = { handle, verifyCode, makeCode, cleanId, features, vendorFeatures, findEvent, allEvents, adminOk, setLiveEvents, stripe, baseUrl, page, escapeHtml, readForm, _test: { toCode, feePercent, platformCents } };
