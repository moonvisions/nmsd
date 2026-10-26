// Round 67: ARTIST APPLICATIONS - DJs, VJs and live acts ask to perform at the Open Festival, and you say yes or no.
//
//   POST /apply                 an application, from the game (JSON) or from the web page (a normal form).
//                               Answers {ok, code} - code is the applicant's own private 8-letter status code.
//   GET  /apply/status?code=    {ok, state: "waiting" | "approved" | "declined", note, djLink?}
//                               (djLink - their private DJ page - only once approved, while they're on the roster)
//   GET  /apply                 the same form as a web page, for artists without the game, plus "check my application".
//   GET/POST /admin/applications   your review page (ADMIN_KEY, like /admin/patch): Approve / Decline / Delete,
//                               with an optional note the applicant sees. Approve puts them on the DJ Patch Bay's roster.
//
// Brakes: 3 applications a day and 30 status checks an hour from one address, at most 500 waiting at once, a hidden
// "leave this empty" box that only robots fill in, and the same name + contact while still waiting UPDATES the
// application instead of making a new one.
//
// Privacy: an applicant's contact is shown on the admin page and nowhere else, and it is never written to the log.
//
// FILE: applications.json, in the same folder as the patch bay's file (PATCHBAY_DIR, else STORE_DATA_DIR, else next to
// this file). A FREE Render server forgets it on every restart - the admin page says so. Add the $7 disk
// (PUBLIC_FESTIVAL_SETUP.txt, STEP 2 option B) to keep applications for good.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const pay = () => require('./payments');      // (lazy: payments.js requires this file)
const patchbay = () => require('./patchbay');

const DATA_DIR = process.env.PATCHBAY_DIR || process.env.STORE_DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'applications.json');
const PERSISTENT = !!(process.env.PATCHBAY_DIR || process.env.STORE_DATA_DIR);

const DAY = 86400000;
const HOUR = 3600000;
const MAX_WAITING = 500;
const MAX_DECIDED = 1000;          // older decided applications are let go after this many
const PER_IP_DAY = 3;              // applications (new or updated) from one address in a day
const STATUS_PER_HOUR = 30;        // status checks from one address in an hour
const MAX_BODY = 16 * 1024;
const MAX_LINKS = 3;
const KINDS = ['dj', 'vj', 'live', 'other'];
const KIND_NAMES = { dj: 'DJ', vj: 'VJ (visuals)', live: 'Live act', other: 'Other' };
const STATES = ['waiting', 'approved', 'declined'];
const AGREE_TEXT = "I'm 18 or older and have the rights to the music/visuals I'll play";

// ============================================================================ small helpers
function h(s) { return pay().escapeHtml(s); }

/** Text, cleaned: no control characters, no < >, no hidden right-to-left tricks. multi keeps line breaks. */
function clean(value, max, multi) {
  let t = String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/[‎‏‪-‮⁦-⁩]/g, '');
  t = multi ? t.replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, '').replace(/\n{3,}/g, '\n\n')
    : t.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/ {2,}/g, ' ');
  return t.trim().slice(0, max);
}

/** A link, cleaned: https only, a public web address, at most max characters - or '' if it can't be used. */
function cleanLink(value, max) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max) return '';
  return patchbay().cleanStreamUrl(text) || '';
}

function newCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    const bytes = crypto.randomBytes(8);
    code = '';
    for (let i = 0; i < 8; i++) code += letters[bytes[i] % letters.length];
  } while (state.apps.some(a => a.code === code));
  return code;
}

function cleanCode(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12); }

function ipOf(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
}

/** Times something happened, per key (for the brakes). */
const hits = new Map();
function count(key, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  hits.set(key, list);
  return list.length;
}
function note(key) {
  const list = hits.get(key) || [];
  list.push(Date.now());
  hits.set(key, list.slice(-60));
  if (hits.size > 20000) hits.clear();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.some(t => now - t < DAY)) hits.delete(k);
}, 600000).unref();

function ago(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} days ago`;
}

// ============================================================================ the data
function blank() { return { version: 1, apps: [] }; }
let state = blank();

function cleanApp(a) {
  if (!a || typeof a !== 'object') return null;
  const code = cleanCode(a.code);
  const name = clean(a.name, 40);
  if (code.length !== 8 || !name) return null;
  return {
    code, name,
    kind: KINDS.includes(a.kind) ? a.kind : 'other',
    genre: clean(a.genre, 40),
    about: clean(a.about, 600, true),
    links: (Array.isArray(a.links) ? a.links : []).map(l => cleanLink(l, 200)).filter(Boolean).slice(0, MAX_LINKS),
    stream: cleanLink(a.stream, 200),
    when: clean(a.when, 200),
    timezone: clean(a.timezone, 40),
    contact: clean(a.contact, 120),
    state: STATES.includes(a.state) ? a.state : 'waiting',
    note: clean(a.note, 300, true),
    djId: String(a.djId || '').replace(/[^a-z0-9-]/g, '').slice(0, 32),
    createdAt: Number(a.createdAt) || Date.now(),
    updatedAt: Number(a.updatedAt) || Number(a.createdAt) || Date.now(),
    decidedAt: Number(a.decidedAt) || 0
  };
}

function load() {
  for (const file of [DATA_FILE, DATA_FILE + '.bak']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    try {
      const data = JSON.parse(text);
      const out = blank();
      out.apps = (Array.isArray(data && data.apps) ? data.apps : []).map(cleanApp).filter(Boolean);
      state = out;
      return;
    } catch (err) {
      console.error('applications: ' + path.basename(file) + ' is damaged:', err && err.message);
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
    console.error('applications save', err && err.message);
  }
}
function save() { if (!saveTimer) saveTimer = setTimeout(saveNow, 400); }
function flush() { if (saveTimer) saveNow(); }

function waitingCount() { return state.apps.filter(a => a.state === 'waiting').length; }

/** Keeps the file small: every waiting application, and the newest decided ones. */
function trim() {
  const decided = state.apps.filter(a => a.state !== 'waiting').sort((a, b) => b.decidedAt - a.decidedAt);
  if (decided.length <= MAX_DECIDED) return;
  const drop = new Set(decided.slice(MAX_DECIDED));
  state.apps = state.apps.filter(a => !drop.has(a));
}

// ============================================================================ an application coming in
function truthy(v) { return v === true || ['true', 'on', '1', 'yes'].includes(String(v == null ? '' : v).toLowerCase()); }

/** Reads the fields (from JSON or a form) into {ok, fields} or {ok:false, error}. */
function readFields(get) {
  const name = clean(get('name'), 40);
  if (!name) return { ok: false, error: 'Type your stage name.' };
  const kind = String(get('kind') || '').toLowerCase();
  if (!KINDS.includes(kind)) return { ok: false, error: 'Pick what you do: DJ, VJ (visuals), Live act or Other.' };
  const contact = clean(get('contact'), 120);
  if (!contact) return { ok: false, error: 'Add a way to reach you (an email or a social handle).' };
  if (!truthy(get('agree'))) return { ok: false, error: `Tick the box: "${AGREE_TEXT}".` };

  let rawLinks = get('links');
  if (!Array.isArray(rawLinks)) {
    rawLinks = typeof rawLinks === 'string' && rawLinks ? rawLinks.split(/[\n,]+/) : [];
    for (const k of ['link1', 'link2', 'link3']) if (get(k)) rawLinks.push(get(k));
  }
  rawLinks = rawLinks.map(l => String(l == null ? '' : l).trim()).filter(Boolean);
  if (rawLinks.length > MAX_LINKS) return { ok: false, error: `Up to ${MAX_LINKS} links, please.` };
  const links = [];
  for (const raw of rawLinks) {
    const link = cleanLink(raw, 200);
    if (!link) return { ok: false, error: `This link can't be used: "${clean(raw, 60)}". Links must start with https:// (like https://soundcloud.com/yourname) and be under 200 characters.` };
    if (!links.includes(link)) links.push(link);
  }
  const streamRaw = String(get('stream') || '').trim();
  const stream = streamRaw ? cleanLink(streamRaw, 200) : '';
  if (streamRaw && !stream) return { ok: false, error: 'Your stream link must start with https:// and be under 200 characters (or leave it empty).' };

  return {
    ok: true,
    fields: {
      name, kind, contact, links, stream,
      genre: clean(get('genre'), 40),
      about: clean(get('about'), 600, true),
      when: clean(get('when'), 200),
      timezone: clean(get('timezone'), 40)
    }
  };
}

/** Stores an application (or updates the same artist's waiting one). Answers {ok, code, updated} or {ok:false, error}. */
function submit(fields, ip) {
  if (count('apply|' + ip, DAY) >= PER_IP_DAY) return { ok: false, error: 'You have sent 3 applications today - please wait until tomorrow.' };
  const now = Date.now();
  const same = state.apps.find(a => a.state === 'waiting' && a.contact.toLowerCase() === fields.contact.toLowerCase() && a.name.toLowerCase() === fields.name.toLowerCase());
  note('apply|' + ip);
  if (same) {
    Object.assign(same, fields, { updatedAt: now });
    save();
    return { ok: true, code: same.code, updated: true };
  }
  if (waitingCount() >= MAX_WAITING) return { ok: false, error: 'Lots of applications are waiting right now - please try again in a few days.' };
  const app = Object.assign({ code: newCode(), state: 'waiting', note: '', djId: '', createdAt: now, updatedAt: now, decidedAt: 0 }, fields);
  state.apps.push(app);
  trim();
  save();
  console.log(`applications: a new ${KIND_NAMES[app.kind]} application - ${waitingCount()} waiting`);   // (never their name or contact)
  return { ok: true, code: app.code, updated: false };
}

/** What the applicant may see about their application (never anyone's contact). */
function statusOf(code) {
  const app = state.apps.find(a => a.code === cleanCode(code));
  if (!app) return { ok: false, error: "We couldn't find that code. Check it, or send a new application." };
  const out = { ok: true, state: app.state, note: app.note || '' };
  if (app.state === 'approved' && app.djId) {
    const link = patchbay().djLinkFor(app.djId);
    if (link) out.djLink = link;
  }
  return out;
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

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };

function json(res, obj) {
  res.writeHead(200, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, CORS));
  res.end(JSON.stringify(obj));
}

/** Handles /apply, /apply/status and /admin/applications. Returns true if it answered. */
function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://relay'); } catch { return false; }
  const route = url.pathname;
  if (route !== '/apply' && route !== '/apply/status' && route !== '/admin/applications') return false;
  const ip = ipOf(req);
  const P = pay();

  if (req.method === 'OPTIONS' && route !== '/admin/applications') {   // the web version of the game asks first
    res.writeHead(204, Object.assign({ 'access-control-max-age': '600' }, CORS));
    res.end();
    return true;
  }

  if (route === '/apply/status') {
    if (count('status|' + ip, HOUR) >= STATUS_PER_HOUR) { json(res, { ok: false, error: 'Too many checks - try again in an hour.' }); return true; }
    note('status|' + ip);
    json(res, statusOf(url.searchParams.get('code')));
    return true;
  }

  if (route === '/admin/applications') { admin(req, res, ip); return true; }

  // ---- /apply
  if (req.method !== 'POST') {
    let status = null;
    if (url.searchParams.get('code')) {
      if (count('status|' + ip, HOUR) >= STATUS_PER_HOUR) status = { ok: false, error: 'Too many checks - try again in an hour.' };
      else { note('status|' + ip); status = statusOf(url.searchParams.get('code')); }
    }
    P.page(res, 200, 'Perform at the Open Festival', applyHtml(null, '', status, url.searchParams.get('code')));
    return true;
  }

  readBody(req, MAX_BODY).then(body => {
    const isJson = /application\/json/i.test(String(req.headers['content-type'] || '')) || /^\s*\{/.test(body || '');
    if (body === null) {
      if (isJson) json(res, { ok: false, error: 'That application is too long.' });
      else P.page(res, 413, 'Too long', '<h1>That was too long</h1><p>Please shorten your application.</p><a class="btn" href="/apply">Back</a>');
      return;
    }
    // A general brake on sending (typos included), before anything else.
    if (count('applypost|' + ip, HOUR) >= 30) {
      if (isJson) json(res, { ok: false, error: 'Too many tries - wait an hour.' });
      else P.page(res, 429, 'Wait', '<h1>Too many tries</h1><p>Wait an hour and try again.</p>');
      return;
    }
    note('applypost|' + ip);

    let get;
    let form = null;
    if (isJson) {
      let data;
      try { data = JSON.parse(body); } catch { data = null; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { json(res, { ok: false, error: "That didn't arrive properly - try again." }); return; }
      get = k => data[k];
    } else {
      form = new URLSearchParams(body);
      get = k => form.get(k);
    }

    // The hidden box only robots fill in: they're told "thanks" and nothing is kept.
    if (String(get('website') || '').trim()) {
      const fake = 'X' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 7);
      if (isJson) json(res, { ok: true, code: fake });
      else P.page(res, 200, 'Thanks', sentHtml(fake, false));
      return;
    }

    const r = readFields(get);
    const result = r.ok ? submit(r.fields, ip) : r;
    if (isJson) { json(res, result.ok ? { ok: true, code: result.code, updated: !!result.updated } : { ok: false, error: result.error }); return; }
    if (!result.ok) { P.page(res, 200, 'Perform at the Open Festival', applyHtml(form, result.error, null, '')); return; }
    P.page(res, 200, 'Thanks', sentHtml(result.code, result.updated));
  }).catch(err => {
    console.error('applications', err && err.message);
    if (!res.headersSent) json(res, { ok: false, error: 'Something went wrong - try again.' });
  });
  return true;
}

// ============================================================================ the public page
const CSS = `<style>
.card{background:#181c24;border:1px solid #2a2f3a;border-radius:10px;padding:12px 14px;margin:12px 0}
form.apply input,form.apply textarea,form.apply select,form.check input{width:100%;box-sizing:border-box;font-size:16px}
textarea{width:100%;box-sizing:border-box;min-height:110px;padding:9px;border-radius:6px;border:1px solid #444;background:#1d212b;color:#fff;font:inherit;font-size:16px}
label.f{display:block;margin:12px 0 4px;font-size:14px;color:#aab2c0}
.kinds{display:flex;flex-wrap:wrap;gap:8px}.kinds label{flex:1 1 120px;display:block;cursor:pointer}
.kinds input{position:absolute;opacity:0;width:1px;height:1px}
.kinds span{display:block;text-align:center;padding:14px 8px;border:2px solid #2a2f3a;border-radius:10px;background:#1d212b;font-weight:700;color:#e8eaf0}
.kinds input:checked+span{border-color:#e8b14c;color:#e8b14c}.kinds input:focus-visible+span{outline:2px solid #fff}
.agree{display:flex;gap:10px;align-items:flex-start;margin-top:14px;color:#e8eaf0}.agree input{width:24px!important;height:24px;flex:0 0 auto;margin:2px 0}
button.big{font-size:17px;padding:14px 22px;margin-top:16px;width:100%}
.err{background:#3a1717;border:1px solid #ff8a80;color:#ffb4ab;border-radius:8px;padding:10px;margin:12px 0}
.warn{background:#3a3110;border:1px solid #e8b14c;color:#ffd77a;border-radius:8px;padding:10px 12px;margin:12px 0}
.hp{position:absolute;left:-5000px;top:auto;width:1px;height:1px;overflow:hidden}
.st{font-weight:800}.st.waiting{color:#e8b14c}.st.approved{color:#6fd49a}.st.declined{color:#ff8a80}
.muted{color:#8a93a3}a{color:#e8b14c}.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}form.inline{display:inline}
button.ghost{background:#2a2f3a;color:#e8eaf0}button.no{background:#ff8a80}button.yes{background:#3ddc84}
.pre{white-space:pre-wrap;word-break:break-word;color:#e8eaf0}.bad{color:#ff8a80}
</style>`;

function statusBlock(status) {
  if (!status) return '';
  if (!status.ok) return `<div class="err">${h(status.error)}</div>`;
  const words = { waiting: 'Waiting - the organiser hasn\'t looked at it yet.', approved: 'Approved! Welcome aboard.', declined: 'Not this time.' }[status.state] || '';
  return `<div class="card"><p class="st ${h(status.state)}">${h(words)}</p>${status.note ? `<p class="pre">${h(status.note)}</p>` : ''}
${status.djLink ? `<p>Your private DJ page (add your stream link and see your set times there - don't share it):</p><a class="btn" href="${h(status.djLink)}">Open my DJ page</a>` : ''}</div>`;
}

function applyHtml(form, error, status, code) {
  const v = k => h(form ? form.get(k) || '' : '');
  const kind = form ? String(form.get('kind') || '') : '';
  const kinds = KINDS.map(k => `<label><input type="radio" name="kind" value="${k}"${kind === k ? ' checked' : ''} required><span>${h(KIND_NAMES[k])}</span></label>`).join('');
  return `${CSS}<h1>Perform at the Open Festival</h1>
<p>DJs, VJs and live acts: play live for the people at the Open Festival - the always-open festival inside New Moon, Same Dark.
Send this once. The organiser reads every application and gets back to you.</p>
${error ? `<div class="err">${h(error)}</div>` : ''}
<form class="apply" method="post" action="/apply">
<label class="f">What do you do?</label><div class="kinds">${kinds}</div>
<label class="f" for="name">Stage name</label><input id="name" name="name" maxlength="40" required value="${v('name')}">
<label class="f" for="genre">Genre / style</label><input id="genre" name="genre" maxlength="40" value="${v('genre')}" placeholder="house, techno, ambient visuals...">
<label class="f" for="about">About you (a few lines)</label><textarea id="about" name="about" maxlength="600">${v('about')}</textarea>
<label class="f">Where can we see or hear you? (up to 3 links, https://)</label>
<input name="link1" maxlength="200" value="${v('link1')}" placeholder="https://soundcloud.com/yourname" inputmode="url">
<input name="link2" maxlength="200" value="${v('link2')}" placeholder="https://instagram.com/yourname" inputmode="url" style="margin-top:6px">
<input name="link3" maxlength="200" value="${v('link3')}" placeholder="https://youtube.com/... or your website" inputmode="url" style="margin-top:6px">
<label class="f" for="stream">Stream link you'd perform from (optional, https://)</label><input id="stream" name="stream" maxlength="200" value="${v('stream')}" placeholder="https://... (.m3u8 or Icecast .mp3 link)" inputmode="url">
<label class="f" for="when">When can you play?</label><input id="when" name="when" maxlength="200" value="${v('when')}" placeholder="Friday and Saturday nights, 2 hours">
<label class="f" for="timezone">Your time zone</label><input id="timezone" name="timezone" maxlength="40" value="${v('timezone')}" placeholder="e.g. New York, or GMT+1">
<label class="f" for="contact">How to reach you (email or social handle - only the organiser sees it)</label><input id="contact" name="contact" maxlength="120" required value="${v('contact')}">
<div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
<label class="agree"><input type="checkbox" name="agree" value="yes" required${form && truthy(form.get('agree')) ? ' checked' : ''}><span>${h(AGREE_TEXT)}</span></label>
<button type="submit" class="big">Send my application</button>
</form>
<h2>Check my application</h2>
<form class="check" method="get" action="/apply"><input name="code" maxlength="12" placeholder="Your 8-letter code" value="${h(cleanCode(code))}" style="text-transform:uppercase"><button type="submit">Check</button></form>
${statusBlock(status)}
<script>try{var t=document.getElementById('timezone');if(t&&!t.value)t.value=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}</script>`;
}

function sentHtml(code, updated) {
  return `${CSS}<h1>${updated ? 'Updated!' : 'Sent!'}</h1>
<p>${updated ? 'We already had your application, so it was updated with what you just sent.' : 'Thanks - your application is on its way to the organiser.'}</p>
<p>Your application code - keep it to check on your application:</p><div class="code">${h(code)}</div>
<a class="btn" href="/apply?code=${h(encodeURIComponent(code))}">Check it now</a>`;
}

// ============================================================================ your review page
function adminSection(hiddenKey) {
  const waiting = waitingCount();
  return `<h2>Artist applications</h2><p class="small">DJs, VJs and live acts asking to play the Open Festival (they apply in the game or at /apply).
${waiting ? `<b class="on">${waiting} waiting</b>` : 'None waiting'} &middot; ${state.apps.length - waiting} decided.</p>
<form method="post" action="/admin/applications">${hiddenKey}<button type="submit">Review applications${waiting ? ` (${waiting})` : ''}</button></form>`;
}

function admin(req, res, ip) {   // eslint-disable-line no-unused-vars
  const P = pay();
  // Round 110: the admin session (adminauth.js) - sign-in, wrong-key limits, CSRF and the old key form all live there.
  require('./adminauth').guard(req, res, { path: '/admin/applications', limit: 32 * 1024 }).then(g => {
    if (!g) return;
    const form = g.form, key = g.token;
    let msg = '';
    try { msg = adminAction(String(form.get('action') || ''), form); } catch (err) { console.error('applications admin', err && err.message); msg = 'Something went wrong - try again.'; }
    P.page(res, 200, 'Artist applications', adminHtml(key, msg));
  }).catch(err => { console.error('applications', err && err.message); if (!res.headersSent) P.page(res, 500, 'Try again', '<h1>Something went wrong</h1>'); });
}

function adminAction(action, form) {
  if (!action || action === 'refresh') return '';
  const app = state.apps.find(a => a.code === cleanCode(form.get('code')));
  if (!app) return 'That application isn\'t here any more.';
  const now = Date.now();
  const newNote = clean(form.get('note'), 300, true);
  switch (action) {
    case 'approve': {
      let onRoster = app.djId && patchbay().djLinkFor(app.djId);
      if (!onRoster) {
        const r = patchbay().addDjFromApplication({ name: app.name, genre: app.genre, contact: app.contact, stream: app.stream,
          kind: app.kind, about: app.about, links: app.links, when: app.when, timezone: app.timezone });   // Round 75: shown on their DJ card
        if (!r.ok) return r.text;
        app.djId = r.id;
      }
      app.state = 'approved';
      app.note = newNote;
      app.decidedAt = now;
      save();
      return `Approved ${app.name}. They're on the DJ roster now (DJ Patch Bay) - give them a set time there. When they check their code, they get their private DJ page link.`;
    }
    case 'decline': {
      const wasOnRoster = app.state === 'approved' && app.djId && patchbay().djLinkFor(app.djId);
      app.state = 'declined';
      app.note = newNote;
      app.decidedAt = now;
      save();
      return `Declined ${app.name}.${wasOnRoster ? ' They are still on the DJ roster - remove them on the DJ Patch Bay page if you want.' : ''}`;
    }
    case 'note': {
      app.note = newNote;
      save();
      return `Saved the note for ${app.name}.`;
    }
    case 'delete': {
      state.apps = state.apps.filter(a => a !== app);
      save();
      return `Deleted ${app.name}'s application.`;
    }
    default:
      return '';
  }
}

function adminHtml(key, msg) {
  const now = Date.now();
  const hiddenKey = require('./adminauth').hidden(key);   // Round 110: the session's CSRF token (key = that token now)
  const parts = [CSS, '<h1>Artist applications</h1>'];
  if (msg) parts.push(`<div class="code" style="font-size:15px;letter-spacing:0;text-align:left;white-space:pre-wrap">${h(msg)}</div>`);
  if (!PERSISTENT) {
    parts.push('<div class="warn">Applications are forgotten when the free server restarts - check them often, or add the $7 disk (see PUBLIC_FESTIVAL_SETUP.txt)</div>');
  }
  parts.push(`<p class="small">Artists apply in the game (Menu &gt; Perform here) or at ${h((P_base() || 'https://YOUR-SERVER.onrender.com') + '/apply')}.
Approve puts them on the DJ roster and gives them their private DJ page. Then give them a set time on the DJ Patch Bay page.</p>`);
  parts.push(`<div class="row"><form class="inline" method="post" action="/admin/applications">${hiddenKey}<button type="submit" class="ghost">Refresh</button></form>
<form class="inline" method="post" action="/admin/patch">${hiddenKey}<button type="submit" class="ghost">DJ Patch Bay</button></form>
<form class="inline" method="post" action="/admin">${hiddenKey}<button type="submit" class="ghost">Back to admin</button></form></div>`);

  const waiting = state.apps.filter(a => a.state === 'waiting').sort((a, b) => b.updatedAt - a.updatedAt);
  const decided = state.apps.filter(a => a.state !== 'waiting').sort((a, b) => b.decidedAt - a.decidedAt);
  parts.push(`<h2>Waiting (${waiting.length})</h2>`);
  if (!waiting.length) parts.push('<p class="muted">Nothing waiting. New applications show up here.</p>');
  for (const a of waiting) parts.push(card(a, hiddenKey, now));
  parts.push(`<h2>Decided (${decided.length})</h2>`);
  if (!decided.length) parts.push('<p class="muted">None yet.</p>');
  for (const a of decided) parts.push(card(a, hiddenKey, now));
  return parts.join('\n');
}

function P_base() { try { return pay().baseUrl(); } catch { return null; } }

function linkTag(url) { return `<a href="${h(url)}" target="_blank" rel="noopener noreferrer nofollow">${h(url)}</a>`; }

function card(a, hiddenKey, now) {
  const onRoster = a.djId ? patchbay().djLinkFor(a.djId) : '';
  const stateLine = a.state === 'waiting' ? '<span class="st waiting">WAITING</span>'
    : a.state === 'approved' ? `<span class="st approved">APPROVED</span>${onRoster ? ' &middot; on the DJ roster' : ' &middot; <span class="bad">no longer on the DJ roster</span>'}`
      : '<span class="st declined">DECLINED</span>';
  const rows = [
    ['Genre', h(a.genre || '-')],
    ['About', a.about ? `<span class="pre">${h(a.about)}</span>` : '-'],
    ['Links', a.links.length ? a.links.map(linkTag).join('<br>') : '-'],
    ['Stream link', a.stream ? linkTag(a.stream) : '-'],
    ['When', h(a.when || '-')],
    ['Time zone', h(a.timezone || '-')],
    ['Contact', `<b>${h(a.contact)}</b>`]
  ].map(([k, v]) => `<tr><td class="small" style="width:90px">${k}</td><td style="word-break:break-word">${v}</td></tr>`).join('');
  return `<div class="card"><b style="font-size:18px">${h(a.name)}</b> <span class="small">${h(KIND_NAMES[a.kind])} &middot; sent ${h(ago(now - a.createdAt))}${a.updatedAt > a.createdAt + 60000 ? ' (updated ' + h(ago(now - a.updatedAt)) + ')' : ''} &middot; code ${h(a.code)}</span><br>${stateLine}
<table>${rows}</table>
<form method="post" action="/admin/applications">${hiddenKey}<input type="hidden" name="code" value="${h(a.code)}">
<label class="f">Note to the applicant (optional - they see it when they check their code)</label><textarea name="note" maxlength="300" style="min-height:60px">${h(a.note)}</textarea>
<div class="row" style="margin-top:6px">${a.state !== 'approved' ? '<button type="submit" name="action" value="approve" class="yes">Approve</button>' : ''}${a.state !== 'declined' ? '<button type="submit" name="action" value="decline" class="no">Decline</button>' : ''}${a.state !== 'waiting' ? '<button type="submit" name="action" value="note" class="ghost">Save note</button>' : ''}</div></form>
<form method="post" action="/admin/applications" onsubmit="return confirm('Delete this application for good?')">${hiddenKey}<input type="hidden" name="code" value="${h(a.code)}"><input type="hidden" name="action" value="delete"><button type="submit" class="ghost">Delete</button></form></div>`;
}

module.exports = {
  handle, adminSection, waitingCount, flush, KINDS, AGREE_TEXT,
  _test: { state: () => state, reset: () => { state = blank(); hits.clear(); }, readFields, submit, statusOf, adminAction, clean, cleanLink }
};
