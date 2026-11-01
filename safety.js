'use strict';
// Round 115 (launchC): THE RELAY'S SAFETY CHECKS - kept out of relay.js (which only calls in here at a few marked places).
//
//  - The word filter on what players can type for others: chat lines, open-mic lines ("omic" "t|spot|text"), a private room's
//    player names (hello), room titles and notes (the Festivals list), the print on a shirt (steps). Mild words are masked
//    ("f***"); a severe line is DROPPED and the sender flagged on /admin/moderation (wordfilter.js decides which is which).
//  - The admin's mute: an account muted on /admin/moderation has its chat, open-mic lines, voice and open-mic audio dropped here.
//  - Context for reports: each connection keeps its own last few chat / open-mic lines (only in memory, only for that room), so
//    a report says what the player actually said.
//  - Blocks across devices: the Open Festival loads a player's saved block list (players.js) when they arrive; a room's host who
//    blocked someone doesn't get them in their room; chat from a blocked player isn't passed to the player who blocked them.
//  - The admin's actions reach players online (moderation.attach): a ban takes them out of every room now, a warning or a
//    mute is shown to them at once, "delete their content" clears their live spray paint and booth for everyone.
// The relay's lines to games for this: {"relay":"mod","k":"notice","text":".."} and {"relay":"mod","k":"wipe","g":<their id>}.
// (Games before 115 ignore lines they don't know - those players simply don't see the notice.)

const moderation = require('./moderation');
const wordfilter = require('./wordfilter');
const players = require('./players');

const SAID_KEEP = 8;
const MUTE_RECHECK_MS = 5000;
const OMIC = 'omic';
let relay = null;   // { rooms, publicRoom, send, publicDrop, sendToHost, PUBLIC_CODE }

// ------------------------------------------------------------------ who a connection is
function uidOf(ws) { return ws ? ws.uid || ws.account || '' : ''; }
function nameOf(ws) { return ws ? ws.pname || ws.accountName || '' : ''; }

/** The admin muted this connection's account (checked at most every 5 s - voice comes 17 times a second). */
function muted(ws) {
  const uid = uidOf(ws);
  if (!uid) return false;
  const t = Date.now();
  if (ws.modMuteAt && t - ws.modMuteAt < MUTE_RECHECK_MS) return ws.modMuted;
  ws.modMuteAt = t;
  ws.modMuted = moderation.isMuted(uid);
  return ws.modMuted;
}
/** Voice, open-mic audio: false = drop it (the admin muted them). */
function voiceOk(ws) { return !muted(ws); }

/** One of this connection's own lines, kept for a report's context. */
function noteSaid(ws, kind, text) {
  if (!ws || !text) return;
  const list = ws.said || (ws.said = []);
  list.push({ at: Date.now(), kind, text: String(text).slice(0, 160) });
  if (list.length > SAID_KEEP) list.splice(0, list.length - SAID_KEEP);
}

// ------------------------------------------------------------------ the word filter on game lines
/**
 * A parsed game line FROM this connection (its own words): true to pass it on (possibly re-written: text masked, a bad name
 * replaced), false to drop it. roomCode is for the flag.
 */
function screenParsed(ws, p, roomCode) {
  if (!p || typeof p !== 'object') return true;
  if (p.t === 'chat') {
    if (muted(ws)) return false;
    const r = wordfilter.check(p.text);
    if (r.level === 2) { moderation.flag({ uid: uidOf(ws), name: nameOf(ws) }, p.text, 'chat', roomCode); return false; }
    if (r.level === 1) p.text = r.masked;
    noteSaid(ws, 'chat', p.text);
    return true;
  }
  if (p.t === 'custom' && p.ch === OMIC && typeof p.text === 'string' && p.text.startsWith('t|')) {
    if (muted(ws)) return false;
    const bar = p.text.indexOf('|', 2);
    if (bar < 0) return true;
    const words = p.text.slice(bar + 1);
    const r = wordfilter.check(words);
    if (r.level === 2) { moderation.flag({ uid: uidOf(ws), name: nameOf(ws) }, words, 'openmic', roomCode); return false; }
    if (r.level === 1) p.text = p.text.slice(0, bar + 1) + r.masked;
    noteSaid(ws, 'openmic', r.level === 1 ? r.masked : words);
    return true;
  }
  if (p.t === 'hello' && typeof p.name === 'string' && wordfilter.nameBad(p.name)) {
    moderation.flag({ uid: uidOf(ws), name: nameOf(ws) || p.name }, p.name, 'name', roomCode);
    p.name = 'Festival-goer';
    return true;
  }
  if (typeof p.gear === 'string' && p.gear.length) p.gear = gear(ws, p.gear);
  return true;
}

const SCREEN_HEADS = ['{"t":"chat"', '{"t":"custom"', '{"t":"hello"'];
/** A raw line a guest sends up: the line to pass on (re-written if it had to be), or null to drop it. Cheap for everything else. */
function screenRaw(ws, text, roomCode) {
  if (typeof text !== 'string' || text.length > 20000) return text;
  if (!SCREEN_HEADS.some(h => text.startsWith(h))) return text;
  if (text.startsWith('{"t":"custom"') && text.indexOf('"ch":"' + OMIC + '"') < 0) return text;
  let p;
  try { p = JSON.parse(text); } catch { return text; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return text;
  const before = JSON.stringify(p);
  if (!screenParsed(ws, p, roomCode)) return null;
  const after = JSON.stringify(p);
  return after === before ? text : after;
}

// The print on a shirt rides in the step's gear list: one entry is the outfit code ("<prefix>1|top|...|print|..."), the print
// its 12th field. Remembered per connection, so a step whose gear didn't change costs nothing.
const OUTFIT_PRINT_FIELD = 11;
function gear(ws, g) {
  if (typeof g !== 'string' || g.indexOf('|') < 0) return g;
  if (ws && ws.gearIn === g) return ws.gearOut;
  const out = g.split(',').map(entry => {
    const f = entry.split('|');
    if (f.length <= OUTFIT_PRINT_FIELD || !f[OUTFIT_PRINT_FIELD]) return entry;
    if (!wordfilter.nameBad(f[OUTFIT_PRINT_FIELD])) return entry;
    f[OUTFIT_PRINT_FIELD] = '';
    return f.join('|');
  }).join(',');
  if (ws) { ws.gearIn = g; ws.gearOut = out; }
  return out;
}

/** A room's listing for the Festivals list (relay's cleanMeta output), filtered in place. ws = the host (for a flag). */
function meta(m, ws, roomCode) {
  if (!m) return m;
  const bad = [];
  if (wordfilter.nameBad(m.title)) { bad.push(m.title); m.title = 'A festival'; }
  if (m.host && wordfilter.nameBad(m.host)) { bad.push(m.host); m.host = ''; }
  for (const k of ['desc', 'act', 'genre', 'region']) {
    if (!m[k]) continue;
    const r = wordfilter.check(m[k]);
    if (r.level === 2) { bad.push(m[k]); m[k] = ''; } else if (r.level === 1) m[k] = r.masked;
  }
  if (Array.isArray(m.lineup)) m.lineup = m.lineup.map(x => (wordfilter.check(x).level === 2 ? '' : wordfilter.mask(x))).filter(Boolean);
  if (Array.isArray(m.people)) m.people = m.people.filter(x => !wordfilter.nameBad(x));
  if (bad.length && ws && !ws.metaFlagged) { ws.metaFlagged = true; moderation.flag({ uid: uidOf(ws), name: nameOf(ws) }, bad.join(' / '), 'name', roomCode); }
  return m;
}

// ------------------------------------------------------------------ blocks
/** The Open Festival's block keys ("a:<username>") for an account's saved block list. */
function savedBlocks(uid) {
  try { return players.blocksOf(uid).map(n => 'a:' + n); } catch { return []; }
}
/** '' when this player may join this room; else the words that turn them away (the host blocked them). */
function joinRefusal(room, ws) {
  const host = room && room.host;
  const hostUid = uidOf(host);
  const name = String(ws && ws.accountName || '').toLowerCase();
  if (!hostUid || !name) return '';
  try { if (players.blocksOf(hostUid).includes(name)) return "You can't join this festival. Find another one under Festivals!"; } catch { /* */ }
  return '';
}

// ------------------------------------------------------------------ reports (relay.js has checked the two are in the room)
const NEW_TO_OLD = { harassment: 0, hate: 0, sexual: 0, cheating: 2, under13: 4, other: 4 };
/** A {"relay":"report",...} line, read: { target, reason (a word), kind, note, name } or null. */
function readReport(packet) {
  if (!packet || typeof packet !== 'object') return null;
  const target = Number(packet.g);
  if (!Number.isInteger(target) || target < 0) return null;
  const reason = moderation.REASONS.includes(String(packet.reason)) ? String(packet.reason) : 'other';
  return { target, reason, oldReason: NEW_TO_OLD[reason], kind: moderation.KINDS.includes(String(packet.kind)) ? String(packet.kind) : 'player',
    note: String(packet.note == null ? '' : packet.note).slice(0, 200), name: String(packet.name == null ? '' : packet.name).slice(0, 40) };
}
/** Files the report with its context (moderation.js). v2 = readReport's result, or null for an older game's "r:" line. */
function fileReport(roomCode, roomTitle, reporter, reported, reason, v2) {
  return moderation.fileReport({
    room: roomCode, roomTitle,
    reporter: { uid: uidOf(reporter), name: nameOf(reporter), tag: reporter && reporter.ip ? require('crypto').createHash('sha256').update('mod|' + reporter.ip).digest('hex').slice(0, 12) : '' },
    target: { uid: uidOf(reported), name: nameOf(reported) || (v2 && v2.name) || '' },
    reason: v2 ? v2.reason : reason, kind: v2 ? v2.kind : null, note: v2 ? v2.note : '',
    chat: reported && reported.said ? reported.said.slice() : []
  });
}

// ------------------------------------------------------------------ the admin's actions, to players online
/** Every connection of this account: [{ ws, room, code, id }] (id: their number in that room, 0 = host / lead). */
function connectionsOf(uid) {
  const out = [];
  if (!relay || !uid) return out;
  for (const [code, room] of relay.rooms) {
    if (room.host && uidOf(room.host) === uid && room.host.readyState === 1) out.push({ ws: room.host, room, code, id: 0 });
    for (const [id, g] of room.guests) if (uidOf(g) === uid && g.readyState === 1 && !g.pubGone) out.push({ ws: g, room, code, id });
  }
  return out;
}
function everyoneIn(room, fn) { if (room.host) fn(room.host); for (const g of room.guests.values()) fn(g); }

function init(r) {
  relay = r;
  moderation.attach({
    kick(uid, text) {
      const list = connectionsOf(uid);
      const bye = JSON.stringify({ t: 'bye', from: 0, ch: 'relay', text: text || 'You were removed by the game\'s team.' });
      for (const c of list) {
        relay.send(c.ws, bye);
        if (c.room.isPublic) relay.publicDrop(c.room, c.ws);
        else if (c.id > 0) { c.room.guests.delete(c.id); relay.send(c.room.host, JSON.stringify({ relay: 'leave', g: c.id })); }
        try { c.ws.close(1000, 'removed'); } catch { /* gone */ }
      }
      return list.length;
    },
    notify(uid, text) {
      const list = connectionsOf(uid);
      const line = JSON.stringify({ relay: 'mod', k: 'notice', text: String(text || '').slice(0, 600) });
      for (const c of list) relay.send(c.ws, line);
      return list.length;
    },
    wipe(uid) {
      const list = connectionsOf(uid);
      const done = new Set();
      for (const c of list) {
        if (done.has(c.room)) continue;
        done.add(c.room);
        const line = JSON.stringify({ relay: 'mod', k: 'wipe', g: c.id });
        everyoneIn(c.room, ws => { if (ws !== c.ws) relay.send(ws, line); });
      }
      return done.size;
    }
  });
}

module.exports = { init, screenRaw, screenParsed, voiceOk, muted, noteSaid, gear, meta, savedBlocks, joinRefusal, readReport, fileReport, uidOf };
