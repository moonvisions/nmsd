'use strict';
// Round 115 (launchA): THE PUBLIC "DELETE MY ACCOUNT" PAGE - Google Play's account-deletion rule: an app that lets people make an
// account must let them delete it in the app (the game: Settings > Online > Account > Delete account) AND from a web link that
// works without the game. This is that link:
//
//   GET  /account/delete      the page: what is deleted, what is kept, and a form (username or email + password + a tick box)
//   POST /account/delete      deletes the account (players.js deleteByLogin - the same password check and the same limits as
//                             signing in from the game), then says so. A normal form post (application/x-www-form-urlencoded);
//                             a JSON body {login, password, confirm:true} gets a JSON answer {ok, message} instead.
//   /delete-account           the same page (an easy address to type)
//
// The page never shows or keeps the password, works without JavaScript, can't be put inside another site's frame, and is never
// cached. The address to give Google Play: https://nmsd.onrender.com/account/delete (or your own domain + /account/delete).

const ROUTES = ['/account/delete', '/account/delete/', '/delete-account'];
const MAX_BODY = 4096;

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};

function readBody(req) {
  return new Promise(resolve => {
    if (Number(req.headers['content-length']) > MAX_BODY) { resolve(null); return; }
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY) { tooBig = true; resolve(null); }
    });
    req.on('end', () => { if (!tooBig) resolve(body); });
    req.on('error', () => { if (!tooBig) resolve(''); });
  });
}

/** {login, password, confirm, json} from a form post or a JSON body. */
function fields(req, raw) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (type.includes('application/json')) {
    let b = {};
    try { b = JSON.parse(raw || '{}') || {}; } catch { b = {}; }
    return { login: String(b.login || b.username || ''), password: typeof b.password === 'string' ? b.password : '', confirm: b.confirm === true || b.confirm === 'yes', json: true };
  }
  const f = new URLSearchParams(raw || '');
  return { login: String(f.get('login') || ''), password: String(f.get('password') || ''), confirm: f.get('confirm') === 'yes', json: false };
}

function page(res, status, api, title, inner) {
  res.writeHead(status, HEADERS);
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${api.esc(title)}</title><style>${api.style()}
form p{margin:12px 0}label{display:block;color:#e6eaf0;font-weight:600;margin-bottom:4px}
input[type=text],input[type=password]{box-sizing:border-box;width:100%;min-height:48px;padding:10px 12px;font-size:16px;border-radius:8px;border:1px solid #2e3742;background:#0f1216;color:#e6eaf0}
.tick{display:flex;gap:10px;align-items:flex-start}.tick input{width:24px;height:24px;margin-top:2px;flex:0 0 auto}.tick label{font-weight:400;color:#a9b4c2}
button{min-height:48px;padding:10px 20px;font-size:16px;font-weight:700;border:0;border-radius:8px;background:#ff8a80;color:#1a0d0c;cursor:pointer}
.err{background:#3a1d1d;border:1px solid #ff8a80;color:#ffd6d2;border-radius:8px;padding:10px 14px}.ok{background:#16301f;border:1px solid #5fd38d;color:#c9f5d8;border-radius:8px;padding:10px 14px}</style></head>
<body><main>${inner}</main></body></html>`);
}

function form(api, login, error) {
  const mail = api.esc(api.contact);
  return `<h1>Delete your account</h1>
<p>New Moon, Same Dark &middot; ${api.esc(api.company)}</p>
<div class="card"><strong>This deletes your live account</strong> - the account you use to play online - from our server, straight away. It can't be undone.</div>
<h2>What is deleted</h2>
<ul><li>Your username, email address and password.</li>
<li>Everything kept with the account: your character, outfit and swag unlocks, your cloud save (level, tokens, bag, stars and rides), and your blocked-players list.</li>
<li>Your saved online worlds and your real-shop listing, if you have them.</li>
<li>Your sign-ins on every device (each device is signed out).</li></ul>
<h2>What is kept</h2>
<ul><li>Moon Shards and items you bought stay on an anonymous store record (your name and email are taken off it), because records of purchases have to be kept.</li>
<li>Play stats are never linked to your account (they use a random number made for your copy of the game). To have them deleted too, email us.</li>
<li>Reports other players made about the account, and our safety notes about them, may be kept for as long as they're needed to keep players safe.</li>
<li>Encrypted backup copies of the account list are replaced over time and are never used to bring a deleted account back.</li></ul>
<p>Your career and anything saved on your own devices aren't touched - they live on the device, not on our server. In the game you can also delete your account: <strong>Settings &gt; Online &gt; Account &gt; Delete account</strong>.</p>
<h2>Delete it now</h2>
${error ? `<p class="err">${api.esc(error)}</p>` : ''}
<form method="post" action="/account/delete" autocomplete="on">
<p><label for="login">Username or email</label><input id="login" name="login" type="text" maxlength="120" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${api.esc(login || '')}"></p>
<p><label for="password">Password</label><input id="password" name="password" type="password" maxlength="200" autocomplete="current-password" required></p>
<p class="tick"><input id="confirm" name="confirm" type="checkbox" value="yes" required><label for="confirm">I understand my account will be deleted for good and can't be brought back.</label></p>
<p><button type="submit">Delete my account</button></p>
</form>
<h2>Can't sign in?</h2>
<p>Email <a href="mailto:${mail}?subject=Delete%20my%20account">${mail}</a> from the email address on your account, with the subject "Delete my account" and your username. We'll delete it and reply when it's done.</p>
<p><a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms of Service</a></p>`;
}

function done(api, username) {
  return `<h1>Your account was deleted</h1>
<p class="ok">The account <strong>${api.esc(username)}</strong> and everything kept with it were deleted from our server.</p>
<p>Your career and anything saved on your own devices are still there. If you play online again, the game will ask you to make a new account.</p>
<p>Questions? Email <a href="mailto:${api.esc(api.contact)}">${api.esc(api.contact)}</a>.</p>
<p><a href="/privacy">Privacy Policy</a></p>`;
}

/** The page and the form (players.js calls this for ROUTES, with its deleteApi). */
function handle(req, res, api) {
  if (req.method === 'GET' || req.method === 'HEAD') { page(res, 200, api, 'Delete your account - New Moon, Same Dark', form(api, '', '')); return; }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST', 'content-type': 'text/plain' }); res.end('Use GET or POST.'); return; }
  readBody(req).then(async raw => {
    if (raw === null) { res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' }); res.end('Too big.'); setImmediate(() => req.destroy()); return; }
    const f = fields(req, raw);
    const answer = (status, ok, message, username) => {
      if (f.json) {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(ok ? { ok: true, username, message } : { ok: false, message }));
      } else if (ok) {
        page(res, 200, api, 'Account deleted - New Moon, Same Dark', done(api, username));
      } else {
        page(res, status, api, 'Delete your account - New Moon, Same Dark', form(api, f.login.slice(0, 120), message));
      }
    };
    if (!f.confirm) return answer(400, false, "Tick the box to say you understand the account can't be brought back.");
    const out = await api.deleteByLogin(f.login, f.password, api.ipOf(req));
    answer(out.status || (out.ok ? 200 : 400), !!out.ok, out.ok ? 'The account was deleted.' : out.message, out.username || '');
  }).catch(err => {
    console.error('account delete page', err && err.message);
    try { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Something went wrong - try again in a minute.'); } catch { /* */ }
  });
}

module.exports = { ROUTES, handle };
