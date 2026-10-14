// New Moon, Same Dark - checking in-app purchases with Steam, Google Play and the App Store (Round 69).
//
// This file only TALKS to the stores and checks their answers. It never changes a balance: store.js
// asks it "is this purchase real?" and then grants the item once (by order id / purchase token /
// transaction id), saved in STORE_DATA_DIR like everything else.
//
// The game never decides prices or what a purchase was worth: Steam is told the item and price by
// THIS server, and Google/Apple purchases are looked up (Google) or signature-checked (Apple) here.
//
// SETTINGS (Render > your service > Environment) - see STORE_PURCHASES_SETUP.txt for the steps:
//   STEAM_WEB_API_KEY            your PUBLISHER Web API key (Steamworks > Users & Permissions > Manage Groups)
//   STEAM_APP_ID                 the game's Steam App ID (numbers)
//   STEAM_SANDBOX=1              test purchases (no real money) through ISteamMicroTxnSandbox
//   GOOGLE_SERVICE_ACCOUNT_JSON  the whole JSON key file of the Google Cloud service account
//   GOOGLE_PACKAGE_NAME          optional, default com.moonvisionmedia.newmoonsamedark
//   APPLE_BUNDLE_ID              optional, default com.moonvisionmedia.newmoonsamedark
//   APPLE_ALLOW_SANDBOX=1        accept App Store SANDBOX (test) purchases - for testing only
//   APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY   the App Store Connect "In-App Purchase" key
//                                (the game's Unity IAP 4.x sends a transaction id, which the server
//                                looks up with Apple using this key)
// Secrets are never logged.
'use strict';
const crypto = require('crypto');

const DEFAULT_APP_ID = 'com.moonvisionmedia.newmoonsamedark';

// Round 69: the fetch to use (tests swap in a fake one; Node 18+ has a global fetch).
let fetchImpl = (...args) => fetch(...args);

/**
 * A purchase check that failed. final = the purchase is definitely not good (the game can stop retrying).
 * Round 69 (review): alert = probably OUR set-up (wrong package name / bundle id / key / permissions): the
 * purchase is kept and retried, and the admin page shows a warning.
 */
class VerifyError extends Error {
  constructor(message, final, code, alert) {
    super(message);
    this.final = !!final;
    this.code = code || '';
    this.alert = !!alert;
  }
}

/** Round 69 (review): the live server (Render / server.newmoonsamedark.com / NODE_ENV=production). */
function isProduction() {
  return env('RENDER') === 'true' || env('NODE_ENV') === 'production' || /^https:\/\/server\.newmoonsamedark\.com\/?$/i.test(env('PUBLIC_URL'));
}

function env(name) { return String(process.env[name] || '').trim(); }

/** Steam sends 64-bit numbers as bare JSON numbers: keep the id fields as exact strings. */
function keepBigIds(text) {
  return String(text).replace(/"(orderid|transid|steamid|ownersteamid)"\s*:\s*(\d+)/g, '"$1":"$2"');
}

async function call(url, options, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
  try {
    const res = await fetchImpl(url, Object.assign({}, options || {}, { signal: ctl.signal }));
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(keepBigIds(text)) : {}; } catch { body = null; }
    return { status: res.status, body };
  } catch (err) {
    // (Never include the URL: some carry the key.)
    throw new VerifyError('could not reach the store (' + (err && err.name === 'AbortError' ? 'timed out' : 'network') + ')', false, 'network');
  } finally {
    clearTimeout(timer);
  }
}

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function fromB64url(text) { return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function form(params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));
  return body;
}

// ============================================================================ Steam (ISteamMicroTxn)
const STEAM_HOST = 'https://partner.steam-api.com';   // publisher keys use the partner host

function steamConfig() {
  const key = env('STEAM_WEB_API_KEY');
  const appId = env('STEAM_APP_ID');
  const sandbox = env('STEAM_SANDBOX') === '1';
  // Round 69 (review): test (sandbox) Steam purchases cost nothing, so the live server refuses them unless
  // ALLOW_STEAM_SANDBOX_IN_PROD=1 is also set - Steam purchases stay off instead.
  const sandboxBlocked = sandbox && isProduction() && env('ALLOW_STEAM_SANDBOX_IN_PROD') !== '1';
  return { ready: key.length >= 20 && /^\d{1,10}$/.test(appId) && !sandboxBlocked, appId: /^\d{1,10}$/.test(appId) ? appId : '', sandbox, sandboxBlocked,
    keySet: key.length > 0, appIdSet: appId.length > 0 };
}

if (steamConfig().sandboxBlocked) {
  console.error('!!!!! STORE: STEAM_SANDBOX=1 on the LIVE server - Steam purchases are SWITCHED OFF. Remove STEAM_SANDBOX ' +
    '(or also set ALLOW_STEAM_SANDBOX_IN_PROD=1 for a short test). !!!!!');
} else if (steamConfig().sandbox && isProduction()) {
  console.error('!!!!! STORE: Steam purchases are in SANDBOX mode on the LIVE server (free test purchases). Remove STEAM_SANDBOX after testing. !!!!!');
}

function steamTxnApi() { return steamConfig().sandbox ? 'ISteamMicroTxnSandbox' : 'ISteamMicroTxn'; }

function steamParams(res, what) {
  const r = res.body && res.body.response;
  if (r && r.result === 'OK') return r.params || {};
  const e = (r && (r.error || (r.params && r.params.error))) || null;
  const words = e ? String(e.errordesc || 'error').slice(0, 160) + ' (' + e.errorcode + ')' : 'HTTP ' + res.status;
  throw new VerifyError('Steam ' + what + ': ' + words, false, e ? String(e.errorcode) : 'http' + res.status);
}

// Steam's language names -> the two-letter codes InitTxn wants.
const STEAM_LANGS = { english: 'en', german: 'de', french: 'fr', spanish: 'es', latam: 'es', italian: 'it', portuguese: 'pt', brazilian: 'pt', russian: 'ru',
  japanese: 'ja', koreana: 'ko', schinese: 'zh', tchinese: 'zh', polish: 'pl', dutch: 'nl', swedish: 'sv', danish: 'da', finnish: 'fi', norwegian: 'no',
  turkish: 'tr', czech: 'cs', hungarian: 'hu', romanian: 'ro', thai: 'th', ukrainian: 'uk', greek: 'el', bulgarian: 'bg', vietnamese: 'vi', indonesian: 'id' };

function steamLanguage(name) {
  const n = String(name || '').toLowerCase().trim();
  if (STEAM_LANGS[n]) return STEAM_LANGS[n];
  return /^[a-z]{2}$/.test(n) ? n : 'en';
}

/** Checks a GetAuthTicketForWebApi("newmoon") ticket; returns the Steam id it belongs to. */
async function steamAuthenticate(ticketHex, identity) {
  const cfg = steamConfig();
  if (!cfg.ready) throw new VerifyError('Steam purchases are not set up on the server', false, 'config');
  const q = new URLSearchParams({ key: env('STEAM_WEB_API_KEY'), appid: cfg.appId, ticket: ticketHex, identity: identity || 'newmoon' });
  const res = await call(STEAM_HOST + '/ISteamUserAuth/AuthenticateUserTicket/v1/?' + q.toString(), { method: 'GET' });
  const r = res.body && res.body.response;
  if (r && r.params && r.params.result === 'OK' && /^\d{17}$/.test(String(r.params.steamid || ''))) {
    return { steamid: String(r.params.steamid), owner: String(r.params.ownersteamid || ''), publisherBanned: !!r.params.publisherbanned };
  }
  const e = r && r.error;
  throw new VerifyError('Steam did not accept the sign-in ticket' + (e ? ' (' + e.errorcode + ')' : ''), res.status < 500, 'ticket');
}

/** Round 69 (review): the player's Steam wallet: { currency: "EUR", country, state, status }. */
async function steamUserInfo(steamId) {
  const cfg = steamConfig();
  const q = new URLSearchParams({ key: env('STEAM_WEB_API_KEY'), appid: cfg.appId, steamid: steamId });
  const res = await call(`${STEAM_HOST}/${steamTxnApi()}/GetUserInfo/v2/?` + q.toString(), { method: 'GET' });
  const p = steamParams(res, 'GetUserInfo');
  return { currency: String(p.currency || '').toUpperCase(), country: String(p.country || ''), state: String(p.state || ''), status: String(p.status || '') };
}

/** Starts a Steam purchase: Steam shows the player an approve/cancel box in its overlay. */
async function steamInitTxn(o) {
  const cfg = steamConfig();
  if (!cfg.ready) throw new VerifyError('Steam purchases are not set up on the server', false, 'config');
  const res = await call(`${STEAM_HOST}/${steamTxnApi()}/InitTxn/v3/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      key: env('STEAM_WEB_API_KEY'), orderid: o.orderId, steamid: o.steamId, appid: cfg.appId, itemcount: 1,
      language: steamLanguage(o.language), currency: o.currency || 'USD', usersession: 'client',   // Round 69 (review): the wallet's currency
      'itemid[0]': o.itemId, 'qty[0]': 1, 'amount[0]': o.cents, 'description[0]': String(o.description || '').slice(0, 120)
    })
  });
  return steamParams(res, 'InitTxn');
}

async function steamFinalizeTxn(orderId) {
  const cfg = steamConfig();
  const res = await call(`${STEAM_HOST}/${steamTxnApi()}/FinalizeTxn/v2/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ key: env('STEAM_WEB_API_KEY'), orderid: orderId, appid: cfg.appId })
  });
  return steamParams(res, 'FinalizeTxn');
}

/** What Steam says about an order now: { status: "Init"|"Approved"|"Succeeded"|"Failed"|"Refunded"|..., items, steamid, ... } */
async function steamQueryTxn(orderId) {
  const cfg = steamConfig();
  const q = new URLSearchParams({ key: env('STEAM_WEB_API_KEY'), appid: cfg.appId, orderid: orderId });
  const res = await call(`${STEAM_HOST}/${steamTxnApi()}/QueryTxn/v3/?` + q.toString(), { method: 'GET' });
  return steamParams(res, 'QueryTxn');
}

const STEAM_REFUNDED = new Set(['Refunded', 'PartialRefund', 'Chargedback', 'RefundedSuspectedFraud', 'RefundedFriendlyFraud']);

// ============================================================================ Google Play
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
let googleAccount = { raw: null, parsed: null };
const googleToken = { value: '', expires: 0, pending: null };

function googleServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (googleAccount.raw === raw) return googleAccount.parsed;
  let parsed = null;
  for (const text of [raw, (() => { try { return Buffer.from(raw.trim(), 'base64').toString('utf8'); } catch { return ''; } })()]) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j.client_email === 'string' && typeof j.private_key === 'string' && j.private_key.includes('PRIVATE KEY')) {
        crypto.createPrivateKey(j.private_key);   // throws if it isn't a usable key
        parsed = { email: j.client_email, key: j.private_key };
        break;
      }
    } catch { /* try the next form */ }
  }
  googleAccount = { raw, parsed };
  googleToken.value = '';
  googleToken.expires = 0;
  return parsed;
}

function googleConfig() {
  const pkg = env('GOOGLE_PACKAGE_NAME') || DEFAULT_APP_ID;
  return { ready: !!googleServiceAccount() && /^[a-zA-Z][\w.]{2,150}$/.test(pkg), packageName: pkg, set: (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').length > 0 };
}

function signRs256(claims, privateKey) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), privateKey);
  return head + '.' + body + '.' + b64url(sig);
}

/** An OAuth access token for the Play Developer API (kept until a minute before it runs out). */
async function googleAccessToken() {
  const sa = googleServiceAccount();
  if (!sa) throw new VerifyError('Google Play checking is not set up on the server', false, 'config');
  if (googleToken.value && Date.now() < googleToken.expires - 60000) return googleToken.value;
  if (googleToken.pending) return googleToken.pending;
  googleToken.pending = (async () => {
    const now = Math.floor(Date.now() / 1000);
    const assertion = signRs256({ iss: sa.email, scope: GOOGLE_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 }, sa.key);
    const res = await call(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    });
    if (res.status !== 200 || !res.body || typeof res.body.access_token !== 'string') {
      throw new VerifyError('Google did not accept the service account (' + res.status + (res.body && res.body.error ? ' ' + String(res.body.error).slice(0, 60) : '') + ')', false, 'auth', true);   // Round 69 (review): alert
    }
    googleToken.value = res.body.access_token;
    googleToken.expires = Date.now() + (Number(res.body.expires_in) || 3600) * 1000;
    return googleToken.value;
  })();
  try { return await googleToken.pending; } finally { googleToken.pending = null; }
}

async function googleCall(method, pathPart, body) {
  const token = await googleAccessToken();
  const res = await call(GOOGLE_API + encodeURIComponent(googleConfig().packageName) + pathPart, {
    method,
    headers: Object.assign({ authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { googleToken.value = ''; googleToken.expires = 0; }
  return res;
}

// Round 69 (review): only these answers mean "this token is definitely not a purchase". Anything else (404 =
// wrong GOOGLE_PACKAGE_NAME or product id, 401/403 = permissions, 5xx...) keeps the purchase and retries.
const GOOGLE_INVALID_TOKEN = new Set(['purchaseTokenInvalid', 'purchaseTokenNoLongerValid', 'invalidPurchaseToken']);

/** purchases.products.get - the Play Store's own record of one purchase. */
async function googleGetPurchase(productId, purchaseToken) {
  const res = await googleCall('GET', '/purchases/products/' + encodeURIComponent(productId) + '/tokens/' + encodeURIComponent(purchaseToken));
  if (res.status === 200 && res.body) return res.body;
  const e = (res.body && res.body.error) || {};
  const msg = e.message ? String(e.message).slice(0, 140) : 'HTTP ' + res.status;
  const reasons = (Array.isArray(e.errors) ? e.errors : []).map(x => String((x && x.reason) || ''));
  const final = res.status === 410 || (res.status === 400 && reasons.some(r => GOOGLE_INVALID_TOKEN.has(r)));
  const setup = res.status === 401 || res.status === 403 || res.status === 404;
  throw new VerifyError('Google Play: ' + msg + (setup ? ` (HTTP ${res.status} - check GOOGLE_PACKAGE_NAME, the product ids and the service account's Play Console permissions)` : ''),
    final, 'http' + res.status, setup);
}

async function googleAcknowledge(productId, purchaseToken) {
  const res = await googleCall('POST', '/purchases/products/' + encodeURIComponent(productId) + '/tokens/' + encodeURIComponent(purchaseToken) + ':acknowledge', {});
  return res.status >= 200 && res.status < 300;
}

/** Purchases refunded / charged back / cancelled in the last `days` days (purchases.voidedpurchases.list). */
async function googleVoided(days) {
  const out = [];
  let page = '';
  const start = Date.now() - Math.min(30, Math.max(1, days || 30)) * 86400000;
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({ startTime: String(start), maxResults: '1000' });
    if (page) q.set('token', page);
    const res = await googleCall('GET', '/purchases/voidedpurchases?' + q.toString());
    if (res.status !== 200 || !res.body) throw new VerifyError('Google Play voided purchases: HTTP ' + res.status, false);
    for (const v of res.body.voidedPurchases || []) if (v && v.purchaseToken) out.push(v);
    page = res.body.tokenPagination && res.body.tokenPagination.nextPageToken;
    if (!page) break;
  }
  return out;
}

// ============================================================================ Apple (StoreKit signed transactions)
// Apple Root CA - G3 (https://www.apple.com/certificateauthority/), pinned by its SHA-256 fingerprint too.
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;
const APPLE_ROOT_CA_G3_SHA256 = '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';
// Apple's marker extensions: the App Store signing certificate and the WWDR intermediate.
const OID_LEAF = Buffer.from('060a2a864886f76364060b01', 'hex');   // 1.2.840.113635.100.6.11.1
const OID_INTERMEDIATE = Buffer.from('060a2a864886f76364060201', 'hex');   // 1.2.840.113635.100.6.2.1

function loadAppleRoot() {
  const cert = new crypto.X509Certificate(APPLE_ROOT_CA_G3_PEM);
  if (cert.fingerprint256 !== APPLE_ROOT_CA_G3_SHA256) throw new Error('Apple root certificate does not match its pinned fingerprint');
  return cert;
}
let appleRoots = [loadAppleRoot()];

function appleConfig() {
  const bundleId = env('APPLE_BUNDLE_ID') || DEFAULT_APP_ID;
  const issuer = env('APPLE_ISSUER_ID'), keyId = env('APPLE_KEY_ID');
  const pem = String(process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  let keyOk = false;
  if (pem) { try { crypto.createPrivateKey(pem); keyOk = true; } catch { keyOk = false; } }
  return { bundleId, allowSandbox: env('APPLE_ALLOW_SANDBOX') === '1', lookup: !!issuer && /^[A-Z0-9]{10}$/.test(keyId) && keyOk, issuer, keyId, pem, keySet: pem.length > 0 };
}

function certTime(text) { const t = Date.parse(text); return Number.isFinite(t) ? t : NaN; }

/**
 * Checks a StoreKit signed transaction (a JWS): the certificate chain up to Apple Root CA - G3, Apple's
 * marker extensions, each certificate's dates (at the time Apple signed it), and the ES256 signature.
 * Returns the transaction's fields. Throws VerifyError(final) if anything doesn't hold.
 */
function verifyAppleJws(jws) {
  const parts = String(jws || '').split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new VerifyError('not a signed transaction', true, 'format');
  let header, payload;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch { throw new VerifyError('signed transaction is damaged', true, 'format'); }
  if (!header || header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length !== 3) throw new VerifyError('signed transaction has the wrong header', true, 'header');
  let certs;
  try { certs = header.x5c.map(b => new crypto.X509Certificate(Buffer.from(String(b), 'base64'))); } catch { throw new VerifyError('signed transaction certificates are damaged', true, 'cert'); }
  const [leaf, inter, root] = certs;
  if (!appleRoots.some(r => r.raw.equals(root.raw))) throw new VerifyError('not signed by Apple (unknown root)', true, 'root');
  const trusted = appleRoots.find(r => r.raw.equals(root.raw));
  if (!inter.ca || !inter.checkIssued(trusted) || !inter.verify(trusted.publicKey) || !inter.raw.includes(OID_INTERMEDIATE)) throw new VerifyError('not signed by Apple (intermediate)', true, 'chain');
  if (!leaf.checkIssued(inter) || !leaf.verify(inter.publicKey) || !leaf.raw.includes(OID_LEAF)) throw new VerifyError('not signed by Apple (leaf)', true, 'chain');
  const signed = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, fromB64url(parts[2]));
  if (!signed) throw new VerifyError('signature does not match', true, 'signature');
  const when = Number(payload && payload.signedDate);
  if (!Number.isFinite(when) || when > Date.now() + 300000) throw new VerifyError('signed transaction has a bad date', true, 'date');
  for (const c of [leaf, inter, trusted]) {
    if (!(certTime(c.validFrom) <= when && when <= certTime(c.validTo))) throw new VerifyError('a certificate was not valid when this was signed', true, 'expired');
  }
  return payload;
}

// ---- App Store Server API: "Get Transaction Info" (used when the game sends only a transaction id)
const appleToken = { value: '', expires: 0, keyId: '' };

function appleApiToken(cfg) {
  if (appleToken.value && appleToken.keyId === cfg.keyId && Date.now() < appleToken.expires - 60000) return appleToken.value;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: cfg.issuer, iat: now, exp: now + 1800, aud: 'appstoreconnect-v1', bid: cfg.bundleId }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: cfg.pem, dsaEncoding: 'ieee-p1363' });
  appleToken.value = head + '.' + body + '.' + b64url(sig);
  appleToken.expires = (now + 1800) * 1000;
  appleToken.keyId = cfg.keyId;
  return appleToken.value;
}

/** Asks Apple for a transaction's signed record (production first, then the sandbox if allowed). */
async function appleLookup(transactionId) {
  const cfg = appleConfig();
  if (!cfg.lookup) throw new VerifyError('App Store checking is not set up on the server (APPLE_ISSUER_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY)', false, 'config');
  const hosts = ['https://api.storekit.itunes.apple.com'];
  if (cfg.allowSandbox) hosts.push('https://api.storekit-sandbox.itunes.apple.com');
  let last = 0;
  for (const host of hosts) {
    const res = await call(host + '/inApps/v1/transactions/' + encodeURIComponent(transactionId), { method: 'GET', headers: { authorization: 'Bearer ' + appleApiToken(cfg) } });
    last = res.status;
    if (res.status === 200 && res.body && typeof res.body.signedTransactionInfo === 'string') return res.body.signedTransactionInfo;
    if (res.status === 401) { appleToken.value = ''; throw new VerifyError('Apple did not accept the server\'s In-App Purchase key (check APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_BUNDLE_ID)', false, 'auth', true); }   // Round 69 (review): alert
    if (res.status !== 404 && res.status !== 400) throw new VerifyError('App Store: HTTP ' + res.status, false, 'http' + res.status);
  }
  throw new VerifyError('App Store does not know this purchase' + (cfg.allowSandbox ? '' : ' (a sandbox test purchase needs APPLE_ALLOW_SANDBOX=1)'), true, 'http' + last);
}

module.exports = {
  VerifyError, DEFAULT_APP_ID,
  isProduction, steamConfig, steamAuthenticate, steamUserInfo, steamInitTxn, steamFinalizeTxn, steamQueryTxn, steamLanguage, STEAM_REFUNDED,
  googleConfig, googleGetPurchase, googleAcknowledge, googleVoided,
  appleConfig, verifyAppleJws, appleLookup,
  _test: {
    setFetch: f => { fetchImpl = f; },
    setAppleRoots: list => { appleRoots = list; },
    resetAppleRoots: () => { appleRoots = [loadAppleRoot()]; },
    resetTokens: () => { googleToken.value = ''; googleToken.expires = 0; appleToken.value = ''; googleAccount = { raw: null, parsed: null }; },
    keepBigIds, signRs256, APPLE_ROOT_CA_G3_SHA256
  }
};
