// Festival Tycoon player reports (Round 57).
//
// In an online room a player can report another player (Settings > People here > Report). The relay
// checks that both are really in that room, then files it here. Reports about the same player in the
// same room are gathered into one line on your admin page (/admin), with how many different people
// reported them. When REPORTS_TO_ACT different people (3 unless changed) report the same player, the
// relay acts at once: a guest is removed from that room (and can't come back into it); a host's room is
// taken off the public Festivals list.
//
// What is kept: the room code and title, the reported player's name, the reason, when - and a scrambled
// fingerprint of each reporter's connection (never their address), so one person can't count twice.
// At most MAX_KEPT lines; the oldest go first. Kept in player-reports.json next to this file (a free Render
// server forgets it when it restarts - that's fine, it's only a to-do list for you).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.PLAYER_REPORTS_FILE || path.join(__dirname, 'player-reports.json');
const MAX_KEPT = 300;
const PER_HOUR = 12;                       // reports one connection may send an hour
const TO_ACT = Math.max(2, Number(process.env.REPORTS_TO_ACT) || 3);
const REASONS = ['Rude or hateful', 'Spamming', 'Griefing or cheating', 'Bad name or look', 'Something else'];

let list = [];
try {
  const loaded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  // Round 57 review: only well-formed entries (a hand-edited or half-written file must not make file() or the
  // admin page throw - file() runs inside the relay's message handler).
  if (Array.isArray(loaded)) {
    list = loaded.filter(e => e && typeof e === 'object' && typeof e.key === 'string' && Array.isArray(e.by) && Array.isArray(e.reasons))
      .slice(-MAX_KEPT);
  }
} catch { list = []; }

const hits = new Map();   // reporter fingerprint -> recent report times
let saveTimer = null;

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(FILE, JSON.stringify(list), () => {});
  }, 2000);
  saveTimer.unref();
}

function fingerprint(ip) {
  return crypto.createHash('sha256').update('ft-report|' + String(ip || '')).digest('hex').slice(0, 16);
}

function clip(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

setInterval(() => {
  const now = Date.now();
  for (const [who, times] of hits) if (!times.some(t => now - t < 3600000)) hits.delete(who);
}, 600000).unref();

/**
 * Files one report. Returns { ok, count, act }: count = how many different people have reported this
 * player in this room (open reports), act = true the moment it reaches REPORTS_TO_ACT.
 * ok = false when this reporter is sending too many.
 */
function file({ room, title, target, name, reason, ip }) {
  const who = fingerprint(ip);
  const now = Date.now();
  const times = (hits.get(who) || []).filter(t => now - t < 3600000);
  if (times.length >= PER_HOUR) return { ok: false, count: 0, act: false };
  times.push(now);
  hits.set(who, times);
  if (hits.size > 20000) hits.clear();   // never grows without end

  const r = Math.max(0, Math.min(REASONS.length - 1, Number(reason) | 0));
  const key = String(room) + '|' + String(target);
  let entry = list.find(e => e.key === key && e.status === 'open');
  if (!entry) {
    entry = { id: crypto.randomBytes(6).toString('hex'), key, room: clip(room, 8), title: clip(title, 40), target: Number(target) | 0,
      name: clip(name, 18) || '(no name)', reasons: [], by: [], at: new Date(now).toISOString(), status: 'open' };
    list.push(entry);
    if (list.length > MAX_KEPT) {
      const closed = list.findIndex(e => e.status !== 'open');
      list.splice(closed >= 0 ? closed : 0, 1);
    }
  }

  const before = entry.by.length;
  if (!entry.by.includes(who)) entry.by.push(who);
  if (!entry.reasons.includes(REASONS[r])) entry.reasons.push(REASONS[r]);
  if (title && !entry.title) entry.title = clip(title, 40);
  entry.last = new Date(now).toISOString();
  save();
  return { ok: true, count: entry.by.length, act: before < TO_ACT && entry.by.length >= TO_ACT };
}

/** Marks what the relay did about a player (shown on the admin page). */
function note(room, target, text) {
  const entry = list.find(e => e.key === String(room) + '|' + String(target) && e.status === 'open');
  if (entry) { entry.done = clip(text, 80); save(); }
}

function adminSection(hidden) {
  const open = list.filter(e => e.status === 'open').slice(-60).reverse();
  const rows = open.map(e => `<tr><td><b>${esc(e.name)}</b> <span class="small">in room ${esc(e.room)}${e.title ? ' &middot; ' + esc(e.title) : ''}${e.target === 0 ? ' &middot; the host' : ''}</span><br>
<span class="small">${esc(e.reasons.join(', '))} &middot; ${e.by.length} ${e.by.length === 1 ? 'person' : 'people'} &middot; ${esc((e.last || e.at).replace('T', ' ').slice(0, 16))} UTC${e.done ? ' &middot; <b>' + esc(e.done) + '</b>' : ''}</span></td>
<td><form method="post" action="/admin">${hidden}<input type="hidden" name="action" value="player-report-done"><input type="hidden" name="item" value="${esc(e.id)}"><button type="submit">Seen - clear</button></form></td></tr>`).join('');
  return `<h2 style="font-size:15px">Player reports from online rooms (${open.length})</h2>
<p class="small">When ${TO_ACT} different people report the same player in a room, the server removes them from that room by itself
(or takes a host's room off the public list). Rooms end when the host leaves, so there's usually nothing more to do.</p>
<table>${rows || '<tr><td class="small">No reports.</td></tr>'}</table>
${open.length ? `<form method="post" action="/admin">${hidden}<input type="hidden" name="action" value="player-report-clear"><button type="submit">Clear them all</button></form>` : ''}`;
}

/** An admin button. Returns a note for the page, or null if it wasn't one of ours. */
function adminAction(action, form) {
  if (action === 'player-report-done') {
    const item = String(form.get('item') || '');
    const entry = list.find(e => e.id === item);
    if (entry) { entry.status = 'seen'; save(); }
    return 'Report cleared.';
  }

  if (action === 'player-report-clear') {
    for (const e of list) if (e.status === 'open') e.status = 'seen';
    save();
    return 'All player reports cleared.';
  }

  return null;
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { fs.writeFileSync(FILE, JSON.stringify(list)); } catch { /* best effort */ }
}

module.exports = { file, note, adminSection, adminAction, flush, REASONS, TO_ACT };
