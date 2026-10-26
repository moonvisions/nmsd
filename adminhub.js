'use strict';
// Round 110: THE ADMIN HOME (/admin) - big tiles into every admin page, each with its headline number, and a short
// "needs you" list. Read only: it changes nothing. Signed-in only (payments.js runs adminauth.guard before render).
//
// The numbers are read straight from each part's own data (read-only views - nothing here writes):
//   Stats      analytics.headline()            Players       players.js accounts
//   Store      store.js sales (statsdash.js)   Applications  applications.waitingCount()
//   Sellers    sellers.js listings             Patch bay     patchbay.js DJs and set times

const ui = require('./adminui');
const auth = require('./adminauth');
const { esc, fmt, money } = ui;

const DAY = 86400000;
function safe(fn, fallback) { try { const v = fn(); return v == null ? fallback : v; } catch { return fallback; } }

const ICONS = {
  stats: '<path d="M4 19V10M10 19V5M16 19v-7M22 19H2" />',
  players: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 19c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14c2.4.2 4 1.6 4.6 4"/>',
  store: '<path d="M4 9h16l-1.2 10.2a1 1 0 0 1-1 .8H6.2a1 1 0 0 1-1-.8z"/><path d="M8.5 9V7a3.5 3.5 0 0 1 7 0v2"/>',
  apps: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>',
  sellers: '<path d="M3.5 9.5 5 4.5h14l1.5 5"/><path d="M4.5 9.5V20h15V9.5"/><path d="M3.5 9.5a2.8 2.8 0 0 0 5.6 0 2.9 2.9 0 0 0 5.8 0 2.8 2.8 0 0 0 5.6 0"/><path d="M10 20v-5h4v5"/>',
  patch: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3.5v3M20.5 12h-3"/>'
};
const icon = k => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;

const HUB_CSS = `<style>
.hello{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:8px;margin:6px 0 18px}
.hello h1{font-size:28px;margin:0;letter-spacing:-.01em}.hello p{margin:4px 0 0;color:var(--muted);font-size:13px}
.hub{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(330px,100%),1fr));gap:14px}
a.ht{display:flex;flex-direction:column;gap:6px;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px 18px 16px;color:var(--text);text-decoration:none;min-height:150px;transition:border-color .15s,transform .15s}
a.ht:hover,a.ht:focus-visible{border-color:#e8b14caa;transform:translateY(-1px)}
.ht .top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ht .ic{width:40px;height:40px;border-radius:12px;background:var(--gold-dim);color:var(--gold);display:grid;place-items:center}
.ht .name{font-weight:700;font-size:16px}
.ht .go{color:var(--muted);font-size:20px}
.ht .num{font-size:40px;font-weight:700;line-height:1;margin-top:8px;font-variant-numeric:tabular-nums;color:var(--gold)}
.ht .lbl{color:var(--text2);font-size:13px}
.ht .sub{color:var(--muted);font-size:12px;margin-top:auto}
.todo{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:14px 16px;margin:0 0 16px}
.todo h2{font-size:14px;margin:0 0 6px;color:var(--text2);text-transform:uppercase;letter-spacing:.05em}
.todo ul{margin:0;padding:0;list-style:none}.todo li{display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-top:1px solid var(--grid);font-size:14px;color:var(--text2)}
.todo li:first-child{border-top:0}.todo li a{margin-left:auto;white-space:nowrap;font-size:13px}
.sec{background:#2a1214;border:1px solid #d03b3b;border-radius:16px;padding:14px 16px;margin:0 0 16px;color:#ffd2cc;font-size:14px}
.sec h2{color:#ff8a80;font-size:16px;margin:0 0 6px}.sec ol{margin:8px 0 0 18px;padding:0}.sec li{margin:5px 0;color:#f3d9d6}
.sec code{background:#0f1115;border:1px solid #5a2a2a;border-radius:6px;padding:2px 6px;color:#ffe0a0;word-break:break-all;user-select:all;font-size:13px}
.sec b{color:#fff}
.dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:5px}.dot.ok{background:var(--good)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
@media (max-width:560px){.hello h1{font-size:23px}.hub{grid-template-columns:1fr 1fr;gap:10px}
a.ht{min-height:0;padding:13px 12px;border-radius:14px;gap:3px}.ht .ic{width:32px;height:32px;border-radius:10px}.ht .ic svg{width:18px;height:18px}
.ht .go{display:none}.ht .name{font-size:14px;margin-top:4px}.ht .num{font-size:28px;margin-top:2px}.ht .lbl{font-size:12px}.ht .sub{font-size:11px}
.todo li{font-size:13px}}
</style>`;

function numbers() {
  const stats = safe(() => require('./analytics').headline(), { online: 0, dau: 0, fresh: 0, total: 0 });
  const dash = safe(() => require('./statsdash').compute(30), null);
  const pstate = safe(() => require('./players')._test.state(), null);
  const accounts = pstate && pstate.players ? Object.values(pstate.players) : [];
  const weekAgo = Date.now() - 7 * DAY;
  const newAccounts = accounts.filter(p => Date.parse(p.created || '') > weekAgo).length;
  const appsWaiting = safe(() => require('./applications').waitingCount(), 0);
  const appsAll = safe(() => require('./applications')._test.state().apps.length, 0);
  const sellers = safe(() => require('./sellers')._test, null);
  let shopsWaiting = 0, shopsLive = 0;
  if (sellers) {
    const t = Date.now();
    for (const l of safe(() => sellers.state().listings, [])) {
      if (safe(() => sellers.statusOf(l, t), '') === 'review') shopsWaiting++;
      if (l.state === 'approved' && l.paidUntil > t && l.products && l.products.length) shopsLive++;
    }
  }
  const pb = safe(() => require('./patchbay')._test.state(), null);
  const djs = pb ? Object.keys(pb.djs || {}).length : 0;
  const sets = pb && Array.isArray(pb.slots) ? pb.slots.filter(s => s.state !== 'done').length : 0;
  return { stats, dash, accounts: accounts.length, newAccounts, appsWaiting, appsAll, shopsWaiting, shopsLive, djs, sets };
}

/**
 * Round 110 (sec110 H1): a red box when the admin password is short or BOARD_SECRET isn't set - with the steps, and fresh
 * random values to copy (made for this page view only; the server doesn't keep them and never shows ADMIN_KEY itself).
 */
function securityBox() {
  const crypto = require('crypto');
  const shortKey = (process.env.ADMIN_KEY || '').length < 20;
  const noBoard = !require('./secrets').boardSecretOk();
  if (!shortKey && !noBoard) return '';
  const fresh = () => crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, '').slice(0, 32);
  const vaultOld = safe(() => require('./players').vaultOn() && !require('./players').vaultKeyOk(), false);
  const steps = [];
  if (noBoard) {
    steps.push(`<b>First, BOARD_SECRET.</b> Open <b>render.com</b> &gt; your service <b>nmsd</b> &gt; <b>Environment</b>.`,
      `Press <b>Add Environment Variable</b>. Key: <code>BOARD_SECRET</code> &nbsp; Value: copy this random text: <code>${esc(fresh())}</code>`,
      `Press <b>Save Changes</b>. Render restarts the server (about 2 minutes). Sign in here again.`);
    if (vaultOld) steps.push(`Wait until the <b>Players</b> page says "GitHub backup: ON - last saved" with a time AFTER the restart (the backup is then locked with the new secret). Only then do the next step.`);
  }
  if (shortKey) {
    steps.push(`<b>${noBoard ? 'Then' : 'Now'}, a longer admin password.</b> In the same <b>Environment</b> page, find <b>ADMIN_KEY</b> &gt; <b>Edit</b>.`,
      `Replace it with 24 or more random characters, e.g. this one made just now: <code>${esc(fresh())}</code> - save it in your password manager (or write it down somewhere safe) FIRST.`,
      `Press <b>Save Changes</b>, wait for the restart, and sign in with the new password.`);
  }
  return `<div class="sec" role="alert"><h2>&#9888; Make your admin safer (5 minutes)</h2>
<p style="margin:0;color:#f3d9d6">${[shortKey ? 'Your admin password (ADMIN_KEY) is shorter than 20 characters - easier to guess.' : '', noBoard ? 'BOARD_SECRET isn\'t set, so some server signatures depend on a key kept only on this server.' : ''].filter(Boolean).join(' ')}</p>
<ol>${steps.map(x => `<li>${x}</li>`).join('')}</ol>
<p style="margin:8px 0 0;font-size:12px;color:#d9b3ae">The random values above are new every time you open this page and aren't stored anywhere. Never put them in a file on GitHub.</p></div>`;
}

function render(req, res, token) {
  const n = numbers();
  const d = n.dash;
  const m = d ? d.money : null;
  const grace = d ? safe(() => require('./statsdash')._test.graceInfo(d), null) : null;
  const tiles = [
    ['/admin/stats', 'stats', 'Play stats', fmt(n.stats.online), 'playing right now', `${fmt(n.stats.dau)} today · ${fmt(n.stats.fresh)} new today · ${fmt(n.stats.total)} ever`],
    ['/admin/players', 'players', 'Players', fmt(n.accounts), 'live accounts', `${fmt(n.newAccounts)} new this week · look up, reset or delete one`],
    ['/admin/store', 'store', 'Store & payments', m ? money(m.centsRange) : '$0.00', 'sales in the last 30 days', m ? `${fmt(m.salesRange)} purchases · store ${m.open ? 'ON' : 'OFF'}${m.refunds ? ` · ${fmt(m.refunds)} refunds` : ''}` : ''],
    ['/admin/applications', 'apps', 'Applications', fmt(n.appsWaiting), 'artists waiting for you', `${fmt(n.appsAll)} applications in all`],
    ['/admin/sellers', 'sellers', 'Sellers', fmt(n.shopsWaiting), 'shops waiting for review', `${fmt(n.shopsLive)} live shops`],
    ['/admin/patch', 'patch', 'Patch bay', fmt(n.djs), 'DJs on the roster', `${fmt(n.sets)} set${n.sets === 1 ? '' : 's'} scheduled`]
  ];
  const todo = [];
  if (n.appsWaiting) todo.push(['warn', `${fmt(n.appsWaiting)} artist application${n.appsWaiting === 1 ? '' : 's'} waiting`, '/admin/applications', 'Review']);
  if (n.shopsWaiting) todo.push(['warn', `${fmt(n.shopsWaiting)} shop${n.shopsWaiting === 1 ? '' : 's'} waiting for review`, '/admin/sellers', 'Review']);
  if (grace && grace.until) todo.push([grace.on ? grace.level : 'ok', grace.on ? `Old-build grace period: ${grace.verdict.toLowerCase()} (ends ${new Date(grace.until).toISOString().slice(0, 10)}, ${grace.daysLeft} day${grace.daysLeft === 1 ? '' : 's'} left)` : 'Old-build grace period has ended', '/admin/stats#versions', 'Details']);
  if (d && d.health.errorsByDay[d.health.errorsByDay.length - 1]) todo.push(['warn', `${fmt(d.health.errorsByDay[d.health.errorsByDay.length - 1])} game errors reported today`, '/admin/stats#health', 'See']);
  if (d && !d.persistent) todo.push(['bad', 'Stats aren\'t on the permanent disk - they reset when the server restarts', '/admin/stats', 'Why']);
  if (!todo.length) todo.push(['ok', 'Nothing needs you right now.', '', '']);
  const until = auth.expiresOf(req);
  const html = [ui.CSS, HUB_CSS,
    `<div class="hello"><div><h1>Admin home</h1><p>New Moon, Same Dark · ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</p></div>
<p>${until ? `Signed in until ${esc(new Date(until).toISOString().slice(11, 16))} UTC` : ''}</p></div>`,
    securityBox(),
    `<div class="todo"><h2>Needs you</h2><ul>${todo.map(([lvl, text, href, act]) => `<li><span class="dot ${lvl}" aria-hidden="true"></span><span>${esc(text)}</span>${href ? `<a href="${esc(href)}">${esc(act)} &rarr;</a>` : ''}</li>`).join('')}</ul></div>`,
    `<div class="hub">${tiles.map(([href, ic, name, num, lbl, sub]) => `<a class="ht" href="${href}"><div class="top"><span class="ic">${icon(ic)}</span><span class="go" aria-hidden="true">&rsaquo;</span></div>
<span class="name">${esc(name)}</span><span class="num">${esc(num)}</span><span class="lbl">${esc(lbl)}</span><span class="sub">${esc(sub)}</span></a>`).join('')}</div>`,
    `<form method="post" action="/admin/logout" style="margin-top:22px">${auth.hidden(token)}<input type="hidden" name="all" value="1"><button type="submit" class="ghost" onclick="return confirm('Sign out on every device (phone, computer)?')">Sign out everywhere</button></form>
<p class="foot">Lost a phone or shared a computer? "Sign out everywhere" ends every admin session. Changing ADMIN_KEY on Render (then redeploying) does too.</p>`];
  require('./payments').page(res, 200, 'Admin home - New Moon', html.join('\n'));
}

module.exports = { render, _test: { numbers } };
