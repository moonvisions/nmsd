'use strict';
// Round 115 (launchC): MODERATION - player reports with what happened, the admin's actions on an account, and the log.
//
// REPORTS. A player reports another from the game (their card, the People list, a chat line): the relay checks both are in
// that room right now, then files it here with the context it holds itself - the room and its title, the time, who reported
// (their username), the reason (harassment, hate, sexual content, cheating, under 13, other), what it's about (the player,
// their chat, their name, their spray paint, their booth, an open-mic line), the reporter's own note (up to 140 letters, run
// through the word filter) and the reported player's last chat / open-mic lines in that room (the relay keeps the last few).
// The word filter files one too when it drops a line (reason "filter", with the line itself).
// Older games (before 115) still send the old five reasons; they're read as the nearest new one.
//
// THE ADMIN PAGE: /admin/moderation (signed in; every form carries the session's CSRF token - adminauth.js). Reports are grouped
// by the reported account, newest first, with buttons:
//   Warn            a message the player sees at once (if online) and with their next connection
//   Mute N hours    the relay drops their chat, open-mic lines and voice (and the open mic itself) until then
//   Ban N hours / Ban for good   their connection tickets are refused (players.js) and they're taken out of every room now
//   Delete their content         their saved worlds go, and their live spray paint and booth are cleared for everyone online
//   Under 13: Clear / Confirm    lift the pause, or ban for good (then delete the account on the Players page)
//   Mark reviewed               closes the reports (they stay in the history)
// Every action is written to the action log (shown on the page) with the time and the admin session that did it.
//
// UNDER 13. An "under 13" report pauses that account's online play at once, pending your review (U13_REPORTS_TO_PAUSE
// different reporters - 1 unless changed). They can still play on their own. A reporter can send at most 3 of these a day.
//
// KEPT WHERE. The actions are kept on the account itself (players.js p.mod - backed up with the accounts, never lost to a
// restart). Reports, flags and the log: moderation.json in STORE_DATA_DIR (the permanent disk) - in .gitignore, the GitHub
// repository is public. At most MAX_REPORTS reports and MAX_LOG log lines; the oldest go first.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ui = require('./adminui');
const auth = require('./adminauth');
const { esc, fmt } = ui;
const pay = () => require('./payments');
const P = () => require('./players');
const WF = () => require('./wordfilter');

const DIR = process.env.STORE_DATA_DIR || __dirname;
const FILE = process.env.MODERATION_FILE || path.join(DIR, 'moderation.json');
const MAX_REPORTS = 1000, MAX_LOG = 2000, MAX_CHAT = 8, MAX_NOTE = 140;
const REPORTS_PER_HOUR = 12, U13_PER_DAY = 3;
const U13_TO_PAUSE = Math.max(1, Number(process.env.U13_REPORTS_TO_PAUSE) || 1);
const CONTACT = process.env.CONTACT_EMAIL || 'daniel@moonvisionmedia.com';
const HOUR = 3600000, DAY = 86400000;

/** The reasons, in the order the game lists them (Net/MultiplayerDirector.ReportReasons). */
const REASONS = ['harassment', 'hate', 'sexual', 'cheating', 'under13', 'other'];
const REASON_NAMES = { harassment: 'Harassment or bullying', hate: 'Hate speech', sexual: 'Sexual content', cheating: 'Cheating or griefing', under13: 'Under 13',
  other: 'Something else', filter: 'Word filter (automatic)' };
/** What a report is about. */
const KINDS = ['player', 'chat', 'name', 'spray', 'booth', 'openmic'];
const KIND_NAMES = { player: 'the player', chat: 'their chat', name: 'their name', spray: 'their spray paint', booth: 'their booth', openmic: 'an open-mic line' };
/** A game before 115 sends one of five reasons by number: Rude or hateful, Spamming, Griefing or cheating, Bad name or look, Something else. */
const OLD_REASONS = ['harassment', 'other', 'cheating', 'other', 'other'];
const OLD_KINDS = ['player', 'chat', 'player', 'name', 'player'];

let state = { v: 1, reports: [], log: [], seq: 0 };
try {
  const loaded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (loaded && typeof loaded === 'object') {
    state.reports = Array.isArray(loaded.reports) ? loaded.reports.filter(r => r && typeof r === 'object' && typeof r.id === 'string' && r.target).slice(-MAX_REPORTS) : [];
    state.log = Array.isArray(loaded.log) ? loaded.log.filter(l => l && typeof l === 'object' && typeof l.action === 'string').slice(-MAX_LOG) : [];
  }
} catch { /* first start */ }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 1500);
  if (saveTimer.unref) saveTimer.unref();
}
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, FILE); } catch (err) { console.error('moderation save', err && err.message); }
}

// eslint-disable-next-line no-control-regex
const clip = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const UID_RE = /^u[0-9a-f]{24}$/;
const validUid = u => typeof u === 'string' && UID_RE.test(u);

// ------------------------------------------------------------------ the relay's side (it tells us how to reach players)
let hooks = { kick: () => 0, notify: () => 0, wipe: () => 0 };
/** relay.js: { kick(uid, text), notify(uid, text), wipe(uid) } - each returns how many connections it reached. */
function attach(h) { hooks = Object.assign(hooks, h || {}); }
function hook(name, ...args) { try { return hooks[name](...args) || 0; } catch (err) { console.error('moderation ' + name, err && err.message); return 0; } }

// ------------------------------------------------------------------ an account's standing (players.js keeps it: p.mod)
function modOf(uid) { if (!validUid(uid)) return null; try { return P().modOf(uid); } catch { return null; } }
function setMod(uid, mod) { try { return P().setMod(uid, mod); } catch { return false; } }
const until = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** '' when this account may play online; else the words the game shows (banned, or paused for an "under 13" report). */
function refusal(uid) {
  const m = modOf(uid);
  if (!m) return '';
  const t = Date.now();
  if (m.perm) return `This account can't play online any more - it was banned for breaking the rules. If you think this is a mistake, email ${CONTACT}.`;
  if (m.banUntil && m.banUntil > t) return `This account is banned from online play until ${until(m.banUntil)} for breaking the rules. You can still play on your own.`;
  if (m.u13 === 'paused') return `Online play is paused on this account while we check a report that its player is under 13 (online play is for 13 and older). You can still play on your own. If you're 13 or older, email ${CONTACT}.`;
  return '';
}
function isBlocked(uid) { return refusal(uid) !== ''; }
/** The admin muted this account (until when, ms - 0 when not muted). */
function mutedUntil(uid) { const m = modOf(uid); return m && m.muteUntil && m.muteUntil > Date.now() ? m.muteUntil : 0; }
function isMuted(uid) { return mutedUntil(uid) > 0; }
/** A warning (or mute) the player hasn't seen yet - given out once (players.js puts it on their next ticket). */
function takeNotice(uid) {
  const m = modOf(uid);
  if (!m || !Array.isArray(m.notices) || !m.notices.length) return '';
  const text = m.notices.join(' ');
  m.notices = [];
  setMod(uid, m);
  return text.slice(0, 600);
}

// ------------------------------------------------------------------ reports
const byReporter = new Map();   // reporter uid (or address tag) -> recent report times
const u13ByReporter = new Map();
function rate(map, key, max, windowMs) {
  const t = Date.now();
  const list = (map.get(key) || []).filter(x => t - x < windowMs);
  if (list.length >= max) { map.set(key, list); return false; }
  list.push(t);
  map.set(key, list);
  if (map.size > 20000) map.clear();
  return true;
}
setInterval(() => { const t = Date.now(); for (const m of [byReporter, u13ByReporter]) for (const [k, l] of m) if (!l.some(x => t - x < DAY)) m.delete(k); }, 600000).unref();

function reasonOf(r) {
  if (typeof r === 'number' || /^\d$/.test(String(r))) return OLD_REASONS[Math.max(0, Math.min(4, Number(r) | 0))];
  const s = String(r || '').toLowerCase();
  return REASONS.includes(s) ? s : 'other';
}
function kindOf(k, oldReason) {
  const s = String(k || '').toLowerCase();
  if (KINDS.includes(s)) return s;
  return oldReason != null ? OLD_KINDS[Math.max(0, Math.min(4, Number(oldReason) | 0))] : 'player';
}
function targetKey(t) { return t.uid ? t.uid : 'n:' + String(t.name || '').toLowerCase(); }
function cleanChat(lines) {
  return (Array.isArray(lines) ? lines : []).slice(-MAX_CHAT).map(l => ({ at: Number(l.at) || 0, text: clip(l.text, 160), kind: clip(l.kind, 10) })).filter(l => l.text);
}

/**
 * Files one report (the relay calls this once it has checked both players are in the room).
 *   { room, roomTitle, reporter: {uid, name, tag}, target: {uid, name}, reason (a REASONS word, or an old game's number),
 *     kind, note, chat: [{at, text, kind}] }
 * -> { ok, id, paused } (ok false: this reporter is sending too many).
 */
function fileReport(r) {
  r = r || {};
  const reporter = { uid: validUid(r.reporter && r.reporter.uid) ? r.reporter.uid : '', name: clip(r.reporter && r.reporter.name, 18) };
  const who = reporter.uid || 'ip:' + clip(r.reporter && r.reporter.tag, 24);
  const target = { uid: validUid(r.target && r.target.uid) ? r.target.uid : '', name: clip(r.target && r.target.name, 18) || '(no name)' };
  if (reporter.uid && reporter.uid === target.uid) return { ok: false };
  if (!rate(byReporter, who, REPORTS_PER_HOUR, HOUR)) return { ok: false };
  const old = typeof r.reason === 'number' || /^\d$/.test(String(r.reason)) ? Number(r.reason) : null;
  const reason = reasonOf(r.reason);
  const kind = kindOf(r.kind, old);
  let note = clip(r.note, MAX_NOTE);
  if (note) note = WF().mask(note);   // (the admin reads it, but nobody needs the worst words spelled out)
  const t = Date.now();
  // The same reporter about the same player within 10 minutes: one report (the newest note and chat win).
  let rec = state.reports.find(x => x.status === 'open' && x.reporter && (x.reporter.uid || x.reporter.tag) === (reporter.uid || who) && targetKey(x.target) === targetKey(target) && t - Date.parse(x.at) < 10 * 60000);
  if (!rec) {
    rec = { id: 'r' + crypto.randomBytes(6).toString('hex'), at: nowIso(), status: 'open', reporter: reporter.uid ? reporter : { uid: '', name: reporter.name || '(older game)', tag: who }, target };
    state.reports.push(rec);
    if (state.reports.length > MAX_REPORTS) {
      const closed = state.reports.findIndex(x => x.status !== 'open');
      state.reports.splice(closed >= 0 ? closed : 0, 1);
    }
  }
  Object.assign(rec, { last: nowIso(), reason, kind, room: clip(r.room, 8), roomTitle: clip(r.roomTitle, 40), note: note || rec.note || '', chat: cleanChat(r.chat).length ? cleanChat(r.chat) : (rec.chat || []) });
  let paused = false;
  if (reason === 'under13' && target.uid) {
    if (rate(u13ByReporter, who, U13_PER_DAY, DAY)) {
      const reporters = new Set(state.reports.filter(x => x.status === 'open' && x.reason === 'under13' && x.target.uid === target.uid).map(x => x.reporter.uid || x.reporter.tag));
      const m = modOf(target.uid);
      if (m && reporters.size >= U13_TO_PAUSE && m.u13 !== 'paused' && m.u13 !== 'cleared') {
        m.u13 = 'paused';
        m.u13At = t;
        setMod(target.uid, m);
        logAction('u13-pause', target, 'automatic: "under 13" report from ' + (reporter.name || 'a player'), 'server');
        hook('kick', target.uid, refusal(target.uid));
        paused = true;
      }
    }
  }
  save();
  return { ok: true, id: rec.id, paused };
}

/** The word filter dropped a line: an automatic report (one open one per account and place, counted up). */
function flag(target, text, where, room) {
  target = { uid: validUid(target && target.uid) ? target.uid : '', name: clip(target && target.name, 18) || '(no name)' };
  const t = Date.now();
  let rec = state.reports.find(x => x.status === 'open' && x.reason === 'filter' && targetKey(x.target) === targetKey(target) && x.kind === where);
  if (!rec) {
    rec = { id: 'r' + crypto.randomBytes(6).toString('hex'), at: nowIso(), status: 'open', reason: 'filter', kind: where, reporter: { uid: '', name: '(word filter)', tag: 'filter' }, target, chat: [], hits: 0 };
    state.reports.push(rec);
    if (state.reports.length > MAX_REPORTS) state.reports.shift();
  }
  rec.hits = (rec.hits || 0) + 1;
  rec.last = nowIso();
  rec.room = clip(room, 8);
  rec.chat = (rec.chat || []).concat([{ at: t, text: clip(text, 160), kind: where }]).slice(-MAX_CHAT);
  save();
}

// ------------------------------------------------------------------ the admin's actions
function logAction(action, target, detail, by) {
  state.log.push({ at: nowIso(), action, uid: target && target.uid || '', name: clip(target && target.name, 18), detail: clip(detail, 200), by: clip(by, 24) });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  save();
}
const HOURS = { mute: [1, 6, 24, 72, 168], ban: [24, 72, 168, 720] };

/**
 * One action on an account. -> { ok, text } (text: what the page says). by = who (the admin session's short tag).
 *   warn {text} | mute {hours} | unmute | ban {hours} | permban | unban | u13clear | u13confirm | wipe | resolve
 */
function act(action, uid, opts, by) {
  opts = opts || {};
  const info = (() => { try { return P().accountInfo(uid); } catch { return null; } })();
  if (!info) return { ok: false, text: 'That account is not here (deleted, or a typo).' };
  const target = { uid: info.uid, name: info.username };
  const m = modOf(uid) || {};
  const t = Date.now();
  const note = clip(opts.note, 200);
  let text;
  switch (action) {
    case 'warn': {
      const words = clip(opts.text, 240) || 'Please follow the rules: be kind, no hate, nothing sexual, no cheating.';
      m.warns = (Array.isArray(m.warns) ? m.warns : []).concat([{ at: t, text: words }]).slice(-20);
      const line = 'A warning from the game\'s team: ' + words;
      const reached = hook('notify', uid, line);
      if (!reached) m.notices = (Array.isArray(m.notices) ? m.notices : []).concat([line]).slice(-3);
      setMod(uid, m);
      logAction('warn', target, words, by);
      text = `${info.username} was warned${reached ? ' (they were online and saw it)' : ' (they\'ll see it next time they go online)'}.`;
      break;
    }
    case 'mute': {
      const h = HOURS.mute.includes(Number(opts.hours)) ? Number(opts.hours) : 24;
      m.muteUntil = t + h * HOUR;
      const line = `You're muted until ${until(m.muteUntil)}: other players can't hear your voice or see your chat. (Reports from other players.)`;
      const reached = hook('notify', uid, line);
      if (!reached) m.notices = (Array.isArray(m.notices) ? m.notices : []).concat([line]).slice(-3);
      setMod(uid, m);
      logAction('mute', target, h + ' h' + (note ? ' - ' + note : ''), by);
      text = `${info.username} is muted for ${h} hours.`;
      break;
    }
    case 'unmute':
      delete m.muteUntil;
      setMod(uid, m);
      logAction('unmute', target, note, by);
      text = `${info.username} can talk again.`;
      break;
    case 'ban': {
      const h = HOURS.ban.includes(Number(opts.hours)) ? Number(opts.hours) : 24;
      m.banUntil = Math.max(m.banUntil || 0, t + h * HOUR);
      setMod(uid, m);
      const n = hook('kick', uid, refusal(uid));
      logAction('ban', target, h + ' h' + (note ? ' - ' + note : ''), by);
      text = `${info.username} is banned from online play for ${h} hours${n ? ' (taken out of ' + n + ' connection' + (n === 1 ? '' : 's') + ' now)' : ''}.`;
      break;
    }
    case 'permban': {
      m.perm = true;
      m.permAt = t;
      setMod(uid, m);
      const n = hook('kick', uid, refusal(uid));
      logAction('permban', target, note, by);
      text = `${info.username} is banned for good${n ? ' (taken out now)' : ''}.`;
      break;
    }
    case 'unban':
      delete m.perm; delete m.permAt; delete m.banUntil;
      setMod(uid, m);
      logAction('unban', target, note, by);
      text = `${info.username} may play online again.`;
      break;
    case 'u13clear':
      m.u13 = 'cleared';
      m.u13At = t;
      setMod(uid, m);
      closeReports(uid, r => r.reason === 'under13');
      logAction('u13-clear', target, note || 'checked: 13 or older', by);
      text = `${info.username}'s online play is back on (the "under 13" reports are closed).`;
      break;
    case 'u13confirm':
      m.u13 = 'confirmed';
      m.perm = true;
      m.permAt = t;
      setMod(uid, m);
      hook('kick', uid, refusal(uid));
      closeReports(uid, r => r.reason === 'under13');
      logAction('u13-confirm', target, note || 'under 13: banned for good', by);
      text = `${info.username} is banned for good (under 13). Now delete the account on the Players page - that removes their email and saved game too.`;
      break;
    case 'wipe': {
      let worlds = 0;
      try { worlds = require('./worlds').removeOwnedBy(uid); } catch (err) { console.error('moderation wipe worlds', err && err.message); }
      const live = hook('wipe', uid);
      logAction('wipe', target, `${worlds} saved world${worlds === 1 ? '' : 's'} deleted; live paint and booth cleared in ${live} room${live === 1 ? '' : 's'}`, by);
      text = `${info.username}'s content is deleted: ${worlds} saved world${worlds === 1 ? '' : 's'}${live ? ', and their spray paint and booth are gone for everyone online' : ' (they weren\'t online, so there was no live paint or booth to clear)'}.`;
      break;
    }
    case 'resolve': {
      const n = closeReports(uid, () => true);
      logAction('resolve', target, `${n} report${n === 1 ? '' : 's'} marked reviewed` + (note ? ' - ' + note : ''), by);
      text = `${n} report${n === 1 ? '' : 's'} about ${info.username} marked reviewed.`;
      break;
    }
    default:
      return { ok: false, text: 'Unknown action.' };
  }
  return { ok: true, text };
}

function closeReports(uid, which) {
  let n = 0;
  for (const r of state.reports) if (r.status === 'open' && r.target.uid === uid && which(r)) { r.status = 'done'; r.closedAt = nowIso(); n++; }
  if (n) save();
  return n;
}
/** A report about a player with no account (an older game in a room): just closed. */
function resolveByName(name, by) {
  const k = 'n:' + String(name || '').toLowerCase();
  let n = 0;
  for (const r of state.reports) if (r.status === 'open' && targetKey(r.target) === k) { r.status = 'done'; r.closedAt = nowIso(); n++; }
  if (n) logAction('resolve', { uid: '', name }, `${n} report${n === 1 ? '' : 's'} (no account) marked reviewed`, by);
  return n;
}

// ------------------------------------------------------------------ the page
const PAGE_CSS = `<style>
.md-grid{display:grid;gap:14px}
.md-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;min-width:0}
.md-card h2{font-size:17px;margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.md-card h2 small{color:var(--muted);font-weight:500;font-size:12px;font-family:ui-monospace,Menlo,monospace}
.md-sub{color:var(--muted);font-size:13px;margin:4px 0 10px}
.md-rep{border-top:1px solid var(--grid);padding:10px 0 4px;font-size:14px;color:var(--text2)}
.md-rep b{color:var(--text)}
.md-chat{margin:6px 0 2px;padding:8px 10px;background:var(--surface2);border:1px solid var(--line);border-radius:8px;font-size:13px}
.md-chat div{overflow-wrap:anywhere}.md-chat span{color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:12px;margin-right:8px}
.md-acts{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 2px}
.md-acts form{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0}
.md-acts input[type=text]{width:220px;max-width:100%;min-height:40px;box-sizing:border-box}
.md-acts select{min-height:40px}
.md-acts button{min-height:40px}
button.danger{background:#d03b3b;color:#fff}
.md-tbl{width:100%;border-collapse:collapse;font-size:13px}.md-tbl td,.md-tbl th{padding:7px 8px;border-bottom:1px solid var(--grid);text-align:left;vertical-align:top}
.md-tbl th{color:var(--muted);font-weight:600}
.md-find{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.md-find input{min-height:40px;box-sizing:border-box}
.md-empty{color:var(--muted);font-size:14px}
@media (max-width:560px){.md-acts input[type=text]{width:100%}.md-card{padding:12px}}
</style>`;
const when = iso => esc(String(iso || '').slice(0, 16).replace('T', ' ')) + ' UTC';
const whenMs = ms => (ms ? when(new Date(ms).toISOString()) : '');

function standingPills(m) {
  const out = [];
  const t = Date.now();
  if (!m) return '';
  if (m.perm) out.push('<span class="pill bad">Banned for good</span>');
  else if (m.banUntil > t) out.push(`<span class="pill bad">Banned until ${whenMs(m.banUntil)}</span>`);
  if (m.muteUntil > t) out.push(`<span class="pill warn">Muted until ${whenMs(m.muteUntil)}</span>`);
  if (m.u13 === 'paused') out.push('<span class="pill bad">Paused: under 13 report</span>');
  if (m.u13 === 'cleared') out.push('<span class="pill ok">Checked: 13+</span>');
  if (Array.isArray(m.warns) && m.warns.length) out.push(`<span class="pill warn">${fmt(m.warns.length)} warning${m.warns.length === 1 ? '' : 's'}</span>`);
  return out.join(' ');
}

function actions(uid, hidden, m) {
  const f = (action, inner, opts) => `<form method="post" action="/admin/moderation"${opts && opts.confirm ? ` onsubmit="return confirm('${esc(opts.confirm)}')"` : ''}>${hidden}<input type="hidden" name="action" value="${action}"><input type="hidden" name="uid" value="${esc(uid)}">${inner}</form>`;
  const sel = (name, list, unit) => `<select name="${name}" aria-label="How long">${list.map(h => `<option value="${h}">${h >= 24 && h % 24 === 0 ? h / 24 + ' day' + (h === 24 ? '' : 's') : h + ' hour' + (h === 1 ? '' : 's')}</option>`).join('')}</select>`;
  const t = Date.now();
  const parts = [
    f('warn', `<input type="text" name="text" maxlength="240" placeholder="Warning message (optional)" aria-label="Warning message"><button type="submit">Warn</button>`),
    m && m.muteUntil > t ? f('unmute', '<button type="submit" class="ghost">Unmute</button>') : f('mute', `${sel('hours', HOURS.mute)}<button type="submit">Mute</button>`),
    f('ban', `${sel('hours', HOURS.ban)}<button type="submit">Ban</button>`),
    m && (m.perm || m.banUntil > t) ? f('unban', '<button type="submit" class="ghost">Lift ban</button>', { confirm: 'Let this player play online again?' }) : f('permban', '<button type="submit" class="danger">Ban for good</button>', { confirm: 'Ban this account from online play for good?' }),
    f('wipe', '<button type="submit" class="ghost">Delete their content</button>', { confirm: 'Delete their saved worlds and clear their live spray paint and booth?' })
  ];
  if (m && m.u13 === 'paused') {
    parts.push(f('u13clear', '<button type="submit" class="ghost">Under 13: clear (they are 13+)</button>', { confirm: 'Lift the pause - you checked they are 13 or older?' }));
    parts.push(f('u13confirm', '<button type="submit" class="danger">Under 13: confirm</button>', { confirm: 'Ban for good as under 13? (Then delete the account on the Players page.)' }));
  }
  parts.push(f('resolve', '<button type="submit" class="ghost">Mark reviewed</button>'));
  return `<div class="md-acts">${parts.join('')}</div>`;
}

function reportHtml(r) {
  const chat = (r.chat || []).length ? `<div class="md-chat" aria-label="Their last lines">${r.chat.map(c => `<div><span>${c.at ? esc(new Date(c.at).toISOString().slice(11, 19)) : ''}${c.kind && c.kind !== 'chat' ? ' ' + esc(c.kind) : ''}</span>${esc(c.text)}</div>`).join('')}</div>` : '<div class="md-chat"><div class="md-empty">No chat or open-mic lines from them in that room (the relay keeps the last few).</div></div>';
  return `<div class="md-rep"><b>${esc(REASON_NAMES[r.reason] || r.reason)}</b> &middot; about ${esc(KIND_NAMES[r.kind] || r.kind || 'the player')}${r.hits > 1 ? ` &middot; ${fmt(r.hits)} lines dropped` : ''}<br>
<span class="small">${when(r.last || r.at)} &middot; ${r.room === 'PUBLIC' ? 'the Open Festival' : 'room ' + esc(r.room || '?')}${r.roomTitle ? ' (' + esc(r.roomTitle) + ')' : ''} &middot; reported by <b>${esc(r.reporter.name || '?')}</b>${r.status !== 'open' ? ' &middot; reviewed' : ''}</span>
${r.note ? `<div>Their note: &ldquo;${esc(r.note)}&rdquo;</div>` : ''}${chat}</div>`;
}

function accountCard(key, reports, hidden, info, m) {
  const name = info ? info.username : (reports[0] && reports[0].target.name) || '?';
  const reporters = new Set(reports.map(r => r.reporter.uid || r.reporter.tag || r.reporter.name)).size;
  const sub = info ? `account ${esc(info.uid)} &middot; made ${when(info.created)}${info.seen ? ' &middot; last seen ' + when(info.seen) : ''}` : 'no live account (an older game in a friend\'s room) - nothing to act on, mark it reviewed';
  const acts = info ? actions(info.uid, hidden, m) : `<div class="md-acts"><form method="post" action="/admin/moderation">${hidden}<input type="hidden" name="action" value="resolve-name"><input type="hidden" name="name" value="${esc(name)}"><button type="submit" class="ghost">Mark reviewed</button></form></div>`;
  const recent = m && Array.isArray(m.warns) && m.warns.length ? `<p class="small">Last warning ${whenMs(m.warns[m.warns.length - 1].at)}: ${esc(m.warns[m.warns.length - 1].text)}</p>` : '';
  return `<article class="md-card" id="a-${esc(key)}"><h2>${esc(name)} ${standingPills(m)}</h2>
<p class="md-sub">${sub}${reports.length ? ` &middot; ${fmt(reports.length)} open report${reports.length === 1 ? '' : 's'} from ${fmt(reporters)} ${reporters === 1 ? 'person' : 'people'}` : ''}</p>
${recent}${reports.slice(0, 12).map(reportHtml).join('')}${reports.length > 12 ? `<p class="small">...and ${fmt(reports.length - 12)} older.</p>` : ''}${acts}</article>`;
}

function render(res, token, note, find) {
  const hidden = auth.hidden(token);
  const open = state.reports.filter(r => r.status === 'open');
  const groups = new Map();
  for (const r of open.slice().reverse()) { const k = targetKey(r.target); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const cards = [];
  for (const [k, list] of groups) {
    const info = list[0].target.uid ? (() => { try { return P().accountInfo(list[0].target.uid); } catch { return null; } })() : null;
    cards.push(accountCard(k, list, hidden, info, info ? modOf(info.uid) : null));
  }
  let found = '';
  if (find) {
    let info = null;
    try { info = validUid(find) ? P().accountInfo(find) : P().accountByName(find); } catch { info = null; }
    found = info ? accountCard(info.uid, state.reports.filter(r => r.target.uid === info.uid).reverse(), hidden, info, modOf(info.uid))
      : `<p class="md-empty">No account called &ldquo;${esc(find)}&rdquo;.</p>`;
  }
  let inForce = [];
  try { inForce = P().moderated(); } catch { inForce = []; }
  const t = Date.now();
  inForce = inForce.filter(a => a.mod.perm || a.mod.banUntil > t || a.mod.muteUntil > t || a.mod.u13 === 'paused');
  const forceRows = inForce.map(a => `<tr><td><a href="/admin/moderation?find=${encodeURIComponent(a.username)}">${esc(a.username)}</a></td><td>${standingPills(a.mod)}</td></tr>`).join('');
  const logRows = state.log.slice(-100).reverse().map(l => `<tr><td>${when(l.at)}</td><td><b>${esc(l.action)}</b></td><td>${l.name ? `<a href="/admin/moderation?find=${encodeURIComponent(l.name)}">${esc(l.name)}</a>` : ''}</td><td>${esc(l.detail)}</td><td class="small">${esc(l.by)}</td></tr>`).join('');
  const html = [ui.CSS, PAGE_CSS,
    `<div class="pagehead"><div><h1>Moderation</h1><p>Reports from players, newest first, grouped by who was reported. ${fmt(open.length)} open &middot; ${fmt(inForce.length)} account${inForce.length === 1 ? '' : 's'} muted, banned or paused.</p></div></div>`,
    note ? `<div class="note ok" role="status">${esc(note)}</div>` : '',
    `<section class="card"><h2>Look up a player</h2><p class="why">Act on any account by username, with or without a report.</p>
<form class="md-find" method="get" action="/admin/moderation"><input type="text" name="find" maxlength="40" placeholder="username" aria-label="Username" value="${esc(find || '')}"><button type="submit">Find</button></form>${found ? '<div style="margin-top:12px">' + found + '</div>' : ''}</section>`,
    `<section class="card"><h2>Needs review <span class="num">${fmt(groups.size)}</span></h2><p class="why">Mute stops their chat and voice; a ban refuses their connection tickets and takes them out of every room at once. An &ldquo;under 13&rdquo; report pauses their online play until you clear or confirm it. Every action goes in the log below.</p>
<div class="md-grid">${cards.join('') || '<p class="md-empty">No open reports. Nothing needs you.</p>'}</div></section>`,
    `<section class="card"><h2>In force <span class="num">${fmt(inForce.length)}</span></h2>${forceRows ? `<div class="scroll"><table class="md-tbl"><tbody>${forceRows}</tbody></table></div>` : '<p class="md-empty">Nobody is muted, banned or paused.</p>'}</section>`,
    `<section class="card"><h2>Action log <span class="num">${fmt(state.log.length)}</span></h2>${logRows ? `<div class="scroll"><table class="md-tbl"><thead><tr><th>When</th><th>Action</th><th>Player</th><th>Detail</th><th>By</th></tr></thead><tbody>${logRows}</tbody></table></div>` : '<p class="md-empty">Nothing yet.</p>'}</section>`];
  pay().page(res, 200, 'Moderation - New Moon admin', html.join('\n'));
}

/** GET /admin/moderation (+ ?find=), POST /admin/moderation (an action). Returns true if it answered. */
function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://relay'); } catch { return false; }
  if (url.pathname !== '/admin/moderation') return false;
  auth.guard(req, res, { path: '/admin/moderation', limit: 8192 }).then(g => {
    if (!g) return;
    if (g.get) { render(res, g.token, '', clip(url.searchParams.get('find'), 40)); return; }
    const by = 'admin ' + crypto.createHash('sha256').update(String(g.token)).digest('hex').slice(0, 6);
    const action = String(g.form.get('action') || '');
    let result;
    if (action === 'resolve-name') { const n = resolveByName(clip(g.form.get('name'), 18), by); result = { text: `${n} report${n === 1 ? '' : 's'} marked reviewed.` }; }
    else result = act(action, String(g.form.get('uid') || ''), { text: g.form.get('text'), hours: g.form.get('hours'), note: g.form.get('note') }, by);
    let name = '';
    try { const i = P().accountInfo(String(g.form.get('uid') || '')); name = i ? i.username : ''; } catch { /* */ }
    render(res, g.token, result.text, action === 'resolve' || action === 'resolve-name' ? '' : name);
  }).catch(e => { console.error('moderation admin', e && e.message); if (!res.headersSent) { res.writeHead(500); res.end(); } });
  return true;
}

/** For the admin home: open reports, and accounts paused for an "under 13" report. */
function summary() {
  const open = state.reports.filter(r => r.status === 'open');
  const targets = new Set(open.map(targetKey));
  let paused = 0;
  try { paused = P().moderated().filter(a => a.mod.u13 === 'paused').length; } catch { /* */ }
  return { open: open.length, players: targets.size, u13: paused, newest: open.length ? open[open.length - 1].last || open[open.length - 1].at : '' };
}

module.exports = { attach, refusal, isBlocked, isMuted, mutedUntil, takeNotice, fileReport, flag, act, handle, summary, flush, REASONS, KINDS,
  _test: { state: () => state, reset: () => { state = { v: 1, reports: [], log: [], seq: 0 }; byReporter.clear(); u13ByReporter.clear(); }, reasonOf, kindOf } };
