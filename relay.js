// Festival Tycoon online relay (Round 28).
//
// A host connects to /host and gets a five-letter room code. Friends connect to /join?code=XXXXX.
// Every line a guest sends goes to the host, wrapped as {"relay":"msg","g":<guest id>,"m":<line>}.
// The host sends {"to":<guest id or -1 for everyone>,"m":<line>} and the relay passes the line on.
// The relay never reads the game's messages; it only passes them along. Rooms end when the host leaves.
//
// Round 54: the Festivals list and proximity voice.
//  - A host can LIST their room: it sends {"meta":{...}} now and then (festival name, what's on, ...).
//    GET /rooms returns every listed room (and every open live event). Rooms stay private unless the
//    host says "listed":true, and drop off the list if the host stops updating them.
//  - Voice: a player sends a text line "v:<ids>:<audio>" (ids = who is near them, "" = everyone); the
//    relay passes it straight on as "v:<their id>:<audio>" to those players. It is never read, kept or
//    written anywhere - and it is size- and rate-limited per player.
//
// Round 55: world leaderboards (see leaderboards.js): POST /boards/join (the relay issues each game a
// signed player id), POST /scores, GET /leaderboard, GET /leaderboards - all time and this week, with a
// "friends here" filter. The "this festival" boards need nothing here: players at the same festival share
// their scores (and their public board tags) with each other through the room, like the golf-cart race times.
// Optional settings: BOARD_SECRET (keeps players' board tokens valid if leaderboards.json is ever lost),
// LEADERBOARD_FILE (where the boards are kept).
//
// Round 57: safer public rooms.
//  - A guest's messages are size- and rate-limited here, so one spammer can't flood the host (and a host
//    that falls behind has a guest's message dropped, never the whole room closed).
//  - One address can keep only a few rooms (ROOMS_PER_IP, 4) and connections (SOCKETS_PER_IP, 40) open,
//    and wrong room codes are braked (a code can't be guessed by trying them all).
//  - The host can remove a player for good ({"kick":id,"ban":true}): they can't come back into that room.
//  - Reports (see reports.js): a player sends "r:<their id>:<reason>:<name>" (the host sends
//    {"report":{"g":id,"reason":n,"name":"..."}}). When REPORTS_TO_ACT different people report the same
//    player in a room, a guest is removed from it; a host's room leaves the public list.
//  - Clearer goodbyes: "The host ended this festival." Everything older games send still works.
//
// Round 58: Big Night rooms.
//  - Rooms are free and hold the host + MAX_GUESTS (16), exactly as before.
//  - A host with a Big Night pass (store.js) sends {"bignight":{"auth":"<account id>.<device token>"}}. The
//    relay asks the store, and if the pass is good the room holds up to BIGNIGHT_SIZE people (100) until the
//    pass's 6 hours are up, and it's FEATURED: first in the Festivals list with a badge. The relay is the only
//    judge of a room's size - a game can't make its own room bigger. The host hears
//    {"relay":"bignight","state":"on"|"off"|"no","left":<seconds>,"size":<people>,"text":"..."}.
//  - When the time is up (or the pass is refunded) the room is a normal room again: nobody already inside is
//    removed, new people can join once it has room under the free size.
//  - Big rooms: the host may send {"to":[1,4,7],"m":...} to reach just some players (the ones near someone),
//    so a 100-person room doesn't send every step to everyone.
//
// Round 60: the DJ patch bay (patchbay.js, /admin/patch). The relay tells the patch bay which rooms are open, and
// sends each stage's patch straight to the host AND every guest as {"relay":"patch","stage":"main",...} - when a
// player joins (one line per patched stage) and whenever it changes. A room's host can patch stages from the game
// ({"patch":{"stage":"second","dj":"...","url":"https://...","live":true}}) and hears back
// {"relay":"patchack","ok":true|false,"text":"..."}; stages the organiser patched on the page can't be changed that way.
// Lines a host sends on to guests may never start with {"relay" (only this server speaks for itself).
//
// Round 61: the open mic. A player the host has given a stage's mic to is heard by EVERYONE in the room (not just the
// players near them). The host says who holds a mic: {"openmic":{"g":[4,7]}} (guest ids, at most 8; [] = nobody). A
// performer sends "m:<audio>"; the relay passes it on as "m:<their id>:<audio>" to the host and every other guest - only
// while they hold a mic, size- and rate-limited like voice, and skipped (never queued) for a listener who is behind. The
// host's own mic comes wrapped as {"to":-1,"m":"m:0:<audio>"} (so an older relay passes it on too). Never stored.
//
// Round 63: SAVED WORLDS (worlds.js). A host opens a saved world with /host?world=<id>&wkey=<their world key>; the
// relay checks they own it (or were allowed to host it), refuses a world that's already open somewhere, and sends the
// host {"relay":"world",...}, one {"relay":"wsec","s":<section>,"d":<text>} per saved part and {"relay":"wdone"}.
// The host then saves changes with {"wsave":{"s":..,"d":..}} (answered {"relay":"wsaved","s":..,"ok":..}) and says who
// has played there with {"wpeople":[{"t":tag,"n":name}]}. The Festivals list marks world rooms ("world":"<name>").
// Ordinary rooms are exactly as before.
//
// Round 66: THE PUBLIC FESTIVAL - one room that is always open (code "PUBLIC", never deleted, never on /join?code=).
// Players connect to /public?name=<name> and nobody is "the host": the relay keeps everyone in join order and the
// LEAD is whoever has been connected longest. The lead's game runs exactly like a host's (everyone sees it as player
// 0) - guests' lines go to it wrapped as {"relay":"msg",...} and its lines are passed on like a host's - so all the
// existing host-side rules keep working. When the lead leaves (or goes silent), the next-longest player is promoted
// at once:
//   to them:            {"relay":"lead","old":<their old guest id>}, then {"relay":"join","g":id,"name":".."} for everyone here
//   to everyone else:   {"relay":"newlead","old":<promoted player's old guest id>,"name":"<their name>","prev":"<old lead's name>"}
// Everyone in the room hears the clock and the head count from the relay itself:
//   on arrival:         {"relay":"pub","id":<my id, 0 = lead>,"name":"..","lead":bool,"players":n,"capacity":n,"now":ms,"epoch":ms,"dayLen":s,"seed":n}
//   joins and leaves:   {"relay":"count","players":n,"now":ms} (and every 10 s - Round 93); a guest leaving: {"relay":"left","g":id,"name":".."}
//   server restarting:  {"relay":"restart","text":".."} (the game reconnects by itself)
// A player says which role they're playing with {"relay":"role","id":"medic"} (goer, dj, vendor, medic, security, crew).
// Presence ("where I am") lines are passed straight from each player to the others by the relay (from/name stamped
// here, only to nearby players in a busy room) instead of through the lead's upload. GET /public = the head count,
// clock and roles; GET /schedule?target=event:public = the DJ set times from the patch bay (edit them on /admin/patch,
// target "The public festival"); GET /healthz = "ok" (for a free uptime pinger).
// Settings: PUBLIC_CAPACITY (60), PUBLIC_DAY_SECONDS (7200 = one festival day every two hours).
//
// Round 97: live mode, front to back (see the "Round 97" section below for the details).
//  - A game says what it can do: /public?...&cap=<bits> (1 = it reads several lines in one frame: "~b", then the lines, '\n' between them;
//    2 = live interactions and shared moments; 4 = keep my place a moment if my connection drops). "pub" answers with
//    "cap":<what this relay does> and "resumed":1 when you got your old place back. Games that don't say get exactly what
//    they always got.
//  - Lighter traffic: steps are rounded (centimetres, tenths of a degree), far players' steps are thinned (near 45 m:
//    every step, up to 110 m: about 3 a second, beyond: every 2 s) once more than 6 are in, and games that can read them
//    get their lines in small batches (every 40 ms) - far fewer frames for the free server to send.
//  - Interactions between real players on the custom channel "lx" ("<op>|<kind>|<nonce>[|<arg>]", "target" = who it's
//    for): high fives, hugs, dancing together, kandi trades, game invites, group photos, follows. The relay delivers each
//    to its one target only, holds every player to offer limits (no invite / high-five spam), drops lines to anyone who
//    blocked the sender ({"relay":"block","g":id,"on":true}) and keeps their voice from them too.
//  - Shared festival moments everyone in the Open Festival sees together, run by this server's clock: a crowd challenge
//    ("get N people dancing at the main stage", a shared progress bar, a reward for everyone who joined in), THE DROP, a
//    fireworks moment, and a crew call for the staff roles (medics / security / stage crew, together). Games check in
//    with {"relay":"lv","id":<moment>}; the relay counts and tells everyone {"relay":"live","k":"next|go|prog|done",...}.
//  - Tonight's live leaderboard: points for interactions that both sides confirmed and for taking part in moments, kept
//    for the festival day ({"relay":"live","k":"board","top":[...],"me":n,"rank":n} every 15 s when it changes).
//  - Smooth reconnects: a game with cap 4 whose connection drops (no goodbye) keeps its number, name and figure for 20 s
//    (RESUME_GRACE_MS); coming back in that time (or while its old connection has gone silent) it simply carries on.
//    Leaving on purpose says {"relay":"bye"} first, so nobody waits for a ghost.
//  - GET /metrics: uptime, memory, rooms, players and the last minute's traffic (no names, no addresses).
//  - Hosts that have gone silent for IDLE_HOST_MS (15 min) with nobody in their room are closed (a frozen game kept rooms open).
//  - RELAY_DEFLATE=1 switches on WebSocket compression for big messages (web browsers use it; off by default - it costs memory).
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_GUESTS = 16;
const MAX_MESSAGE = 8 * 1024 * 1024;
const MAX_ROOMS = 500;
const MAX_BUFFERED = 4 * 1024 * 1024;   // a guest this far behind is dropped rather than eating memory
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I or O (they look like 1 and 0)

const rooms = new Map();   // code -> { host, guests: Map<id, ws>, nextId }

// Round 54: the Festivals list (public rooms) and voice.
const META_TTL = Number(process.env.ROOM_META_TTL_MS) || 90000;       // a listing the host stopped updating drops off
const META_MIN_GAP = Number(process.env.ROOM_META_GAP_MS) || 3000;    // a host can update its listing this often
const SWEEP_EVERY = Number(process.env.ROOM_SWEEP_MS) || 30000;
const MAX_META = 4096;                  // bytes of one listing update
const MAX_LISTED = 100;                 // rooms in one answer
const LIST_PER_MINUTE = Number(process.env.ROOMS_PER_MINUTE) || 30;   // /rooms asks per player per minute
const listHits = new Map();             // ip -> recent /rooms times
// Round 57: guests' messages, and how much one address may open.
const MAX_GUEST_MESSAGE = 256 * 1024;   // a guest never needs to send more in one go (the host sends the big festival saves)
const GUEST_MSG_RATE = 80, GUEST_MSG_BURST = 160;                 // messages a second (a busy player sends ~30)
const GUEST_BYTE_RATE = 64 * 1024, GUEST_BYTE_BURST = 512 * 1024;   // a player normally sends a few KB a second
const GUEST_DROPS_TO_CLOSE = 600;       // this many refused in 10 s: the connection is closed
const MAX_ROOMS_PER_IP = Number(process.env.ROOMS_PER_IP) || 4;
const MAX_SOCKETS_PER_IP = Number(process.env.SOCKETS_PER_IP) || 40;
const JOIN_FAILS_PER_MINUTE = 10;       // wrong room codes from one address (Round 65: was 30)
const JOIN_LOCK_MS = 60000;             // Round 65: over that, every join from the address is refused for this long
const MAX_BANNED = 64;                  // players a host has removed from one room
const socketsByIp = new Map();          // address -> open connections
const joinFails = new Map();            // address -> recent wrong-code times
const joinLocks = new Map();            // Round 65: address -> time until which its joins are refused
const reports = require('./reports');
const store = require('./store');       // Round 58: Big Night passes live on players' store accounts
const MAX_TO_LIST = 200;                // ids in one {"to":[...]} message
const BIG_ASK_GAP = 3000;               // a host can ask for Big Night this often
const MAX_VOICE = 1600;                 // characters in one voice packet (about 60 ms of speech is ~660)
const VOICE_RATE = 30;                  // packets a second a player may send (a steady talker sends ~17)
const VOICE_BURST = 45;
const VOICE_BACKLOG = 256 * 1024;       // a listener this far behind skips voice instead of queueing it
const MAX_MIC_HOLDERS = 8;              // Round 61: open mics held at once in one room
const MIC_RATE = 30, MIC_BURST = 45;    // Round 61: open-mic packets a second (a performer sends ~17)
// Round 66: the public festival (see the notes at the top and the "public festival" section below).
const PUBLIC_CODE = 'PUBLIC';           // six letters: newCode() (five) can never make it, and /join?code= refuses it
const PUBLIC_TARGET = 'event:public';   // its patch-bay target ("event:" targets keep their DJ schedule over restarts)

function newCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

const fs = require('fs');
const path = require('path');
const VENDORS_FILE = path.join(__dirname, 'vendors.json');
// Ticket codes are secret: a Render "Secret File" named tickets.json (read from /etc/secrets), or the
// TICKETS_JSON setting, or (for testing on your own computer) a tickets.json next to this file.
const TICKET_SOURCES = ['/etc/secrets/tickets.json', path.join(__dirname, 'tickets.json')];
const USES_FILE = path.join(__dirname, 'ticket-uses.json');
const ticketHits = new Map();   // ip -> recent check times (a brake on guessing codes)
let globalHits = [];
let ticketUses = {};            // venue|code -> device ids it has opened
try { ticketUses = JSON.parse(fs.readFileSync(USES_FILE, 'utf8')) || {}; } catch { ticketUses = {}; }
let ticketsCache = null, ticketsLoadedAt = 0;

function cleanId(id) {
  // The same clean-up the game applies to venue ids.
  return String(id || '').replace(/,/g, ' ').replace(/\//g, '-').replace(/[\n<>]/g, '').trim().slice(0, 32).replace(/ /g, '-');
}

function loadTickets() {
  const now = Date.now();
  if (ticketsCache && now - ticketsLoadedAt < 30000) return ticketsCache;
  let found = {};
  if (process.env.TICKETS_JSON) {
    try { found = JSON.parse(process.env.TICKETS_JSON); } catch { found = {}; }
  } else {
    for (const file of TICKET_SOURCES) {
      try { found = JSON.parse(fs.readFileSync(file, 'utf8')); break; } catch { /* next */ }
    }
  }
  ticketsCache = found && typeof found === 'object' ? found : {};
  ticketsLoadedAt = now;
  return ticketsCache;
}

function saveUses() {
  fs.writeFile(USES_FILE, JSON.stringify(ticketUses), () => {});
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of ticketHits) if (!times.some(t => now - t < 60000)) ticketHits.delete(ip);
}, 60000).unref();

const payments = require('./payments');   // Round 43: real tickets through Stripe
const community = require('./community');
const leaderboards = require('./leaderboards');   // Round 55: world leaderboards (/scores, /leaderboard, /leaderboards)
const patchbay = require('./patchbay');           // Round 60: the DJ patch bay
const worlds = require('./worlds');               // Round 63: saved worlds
const applications = require('./applications');   // Round 67: artists applying to play the Open Festival (/apply)
const analytics = require('./analytics');   // Round 71: play stats (/stats/*, /admin/stats)
const players = require('./players');       // Round 74: live sign-up - a username and email for the Open Festival (/players/*, /admin/players)
const sellers = require('./sellers');       // Round 85: real shops - sellers' real products at their booths (/sellers/*, /admin/sellers)
const crypto = require('crypto');
const eventRooms = new Map();      // Round 50: live event id -> its room code
payments.setLiveEvents(eventRooms);
const MAX_EVENT_GUESTS = 32;
const hostTries = new Map();       // ip -> failed event-password tries (a brake on guessing)
let hostTriesAll = [];
const ticketSockets = new Map();   // event|ticket -> how many are in with it right now       // a live event's room (every player goes through the organiser's game)

// Round 109: EVERY ONLINE ROOM NEEDS A LIVE ACCOUNT (the owner: "In order to play online, you must make a username + password
// + email"). The Open Festival already did (publicConnect); now hosting a room (/host - a room, a saved world, a Big Night,
// a live event) and every way of joining one (/join?code=, /join?event=, and so a saved world's room) check the same
// sign-in key, the same way: ?pt=<the game's live sign-in token>. A game from before Round 109 never sends pt at all - it's
// told to update (it has the in-game updater, so one tap). A game that sends a key the server doesn't know (the password
// was changed, or it signed out elsewhere) gets "signup: ..." and asks the player to sign in again. A reconnect after a
// dropped connection goes through here again with the same key, so a signed-in player is never thrown out mid-session.
// LIVE_SIGNUP_REQUIRED=0 (players.required()) switches all of it off. Rate limits and every other check are unchanged.
const UPDATE_TO_PLAY = 'Update New Moon to play online - this version of the game is too old for live accounts.';

// Round 109 (security review):
//  - L4: the game sends a single-use TICKET (players.js /players/ticket, good for 60 s) as pt - not its long-lived sign-in key,
//    which would sit in proxy and server logs with the address. The long-lived key is only taken during the grace period.
//  - M5: LIVE_ACCOUNT_GRACE_UNTIL=<ISO date> - until then, a game too old for accounts (no pt at all) may still host and
//    join rooms, so the server can be deployed before every player has updated (/public is unchanged: it already needed one).
/** -> { ok, account (the live account's uid; '' when accounts are off or an old game in the grace period), text (why not) } */
function liveAccountFor(url) {
  if (!players.required()) return { ok: true, account: '' };
  if (!players.isReady()) return { ok: false, text: 'The server is just starting up - try again in a few seconds.' };
  if (!url.searchParams.has('pt')) return players.graceActive() ? { ok: true, account: '', grace: true } : { ok: false, text: UPDATE_TO_PLAY };
  const pt = url.searchParams.get('pt') || '';
  // Round 109 (final check): a ticket that's no good (used, out of date, from a server with another key) is NOT a reason to
  // sign anyone out - it's refused as "ticket: ...", and the game fetches a fresh one and tries again. Only a missing or
  // unknown sign-in is "signup: ...".
  if (players.isTicket(pt)) {
    const t = players.redeemTicket(pt);
    return t ? { ok: true, account: t.uid || '' } : { ok: false, text: TICKET_AGAIN };
  }
  const p = pt ? players.check(pt) : null;
  if (!p) return { ok: false, text: 'signup: Please sign in to your live account to play online.' };
  if (!players.graceActive()) return { ok: false, text: TICKET_AGAIN };   // a good sign-in key, but rooms take a ticket
  return { ok: true, account: p.uid || '' };
}

const TICKET_AGAIN = 'ticket: That connection ticket ran out - getting a fresh one.';

/** Turns a connection away for want of a live account: the words as a goodbye (games read them), then its own close code. */
function refuseForAccount(ws, text) {
  send(ws, JSON.stringify({ t: 'bye', from: 0, text }));
  ws.close(4003, text.slice(0, 120));
}

/** Round 50: the organiser's password for opening an event (EVENT_HOST_KEY - its own, never the admin one). */
function eventKeyOk(key) {
  const want = process.env.EVENT_HOST_KEY || '';
  if (want.length < 8) return false;
  const a = crypto.createHash('sha256').update(String(key || '')).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}   // Round 45: players' own creations

// ---------------------------------------------------------------- Round 54: listing

function hashSeed(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h | 0;
}

function clip(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}

function clipList(value, count, max) {
  return Array.isArray(value) ? value.slice(0, count).map(v => clip(v, max)).filter(Boolean) : [];
}

/** Round 57: the address that connected (the last hop our host's proxy added). */
function clientIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
}

/** Round 57: a guest may send GUEST_MSG_RATE messages / GUEST_BYTE_RATE bytes a second (with short bursts). */
function guestAllowed(ws, bytes) {
  const now = Date.now();
  if (ws.msgTokens === undefined) { ws.msgTokens = GUEST_MSG_BURST; ws.byteTokens = GUEST_BYTE_BURST; ws.tokensAt = now; ws.drops = 0; ws.dropsAt = now; }
  const dt = (now - ws.tokensAt) / 1000;
  ws.tokensAt = now;
  ws.msgTokens = Math.min(GUEST_MSG_BURST, ws.msgTokens + dt * GUEST_MSG_RATE);
  ws.byteTokens = Math.min(GUEST_BYTE_BURST, ws.byteTokens + dt * GUEST_BYTE_RATE);
  if (bytes <= MAX_GUEST_MESSAGE && ws.msgTokens >= 1 && ws.byteTokens >= bytes) {
    ws.msgTokens -= 1;
    ws.byteTokens -= bytes;
    return true;
  }

  if (now - ws.dropsAt > 10000) { ws.drops = 0; ws.dropsAt = now; }
  if (++ws.drops > GUEST_DROPS_TO_CLOSE) {
    send(ws, JSON.stringify({ t: 'bye', from: 0, ch: 'relay', text: 'Your game was sending far too many messages, so it was disconnected.' }));   // Round 66 (review): ch "relay" = said by the server itself
    ws.close(1008, 'flooding');
  }

  return false;
}

/** Round 57: a guest's line to the host. If the host has fallen far behind, the line is dropped - never the host. */
function sendToHost(room, text) {
  const host = room.host;
  if (!host || host.readyState !== 1 || host.bufferedAmount > MAX_BUFFERED) return;
  if (host.cap & CAP_BATCH) { queueLine(host, text); return; }   // Round 97: the public festival's lead reads batches
  if (host.outbox && host.outbox.length) flushOut(host);
  host.send(text);
  metrics.linesOut++; metrics.framesOut++; metrics.bytesOut += text.length;
}

/** Round 57: one player reports another in their room (from = the reporter's id, 0 = the host). */
function fileReport(code, room, from, reporter, target, reason, name) {
  if (room.isPublic) { publicReport(room, from, reporter, target, reason, name); return; }   // Round 66
  if (!Number.isInteger(target) || target === from || target < 0) return;
  const reported = target === 0 ? room.host : room.guests.get(target);
  if (!reported || reported.readyState !== 1) return;
  const title = room.meta ? room.meta.title : (room.event || '');
  const result = reports.file({ room: code, title, target, name, reason, ip: reporter.ip });
  if (!result.act) return;
  if (target === 0) {
    // A host many people report: their room leaves the public list (it stays open for its players).
    if (room.event) return;
    room.noList = true;
    if (room.meta) room.meta.listed = false;
    send(room.host, JSON.stringify({ relay: 'delisted' }));
    reports.note(code, target, 'taken off the public list');
    return;
  }

  // A guest many people report: removed from this room, and can't come back into it.
  // Round 57 review: live events often share one venue Wi-Fi, so an address ban there would lock out a whole crowd - removal only.
  if (!room.event && reported.ip && room.banned.size < MAX_BANNED) room.banned.add(reported.ip);
  send(reported, JSON.stringify({ t: 'bye', from: 0, text: 'You were removed from this festival after reports from other players.' }));
  room.guests.delete(target);   // nothing more from them from now on
  send(room.host, JSON.stringify({ relay: 'removed', g: target }));
  send(room.host, JSON.stringify({ relay: 'leave', g: target }));
  reported.close(1000, 'removed');
  reports.note(code, target, 'removed from the room');
}

/** Round 57: "r:<target>:<reason>:<name>" -> the parts (null if it isn't one). */
function parseReport(text) {
  const m = /^r:(\d{1,6}):(\d):([^\n]{0,40})$/.exec(text);
  return m ? { target: Number(m[1]), reason: Number(m[2]), name: m[3] } : null;
}

/** A host's listing, cleaned up: only the fields the Festivals list shows, each with a length limit. */
function cleanMeta(m) {
  const startsIn = Number(m.startsIn);
  return {
    listed: m.listed === true,
    title: clip(m.title, 40) || 'A festival',
    desc: clip(m.desc, 140),
    host: clip(m.host, 18),
    region: clip(m.region, 32),
    genre: clip(m.genre, 24),
    act: clip(m.act, 40),
    clock: clip(m.clock, 8),
    lineup: clipList(m.lineup, 10, 40),
    people: clipList(m.people, 40, 18),
    live: m.live === true,
    stream: m.stream === true,
    startsAt: Number.isFinite(startsIn) && startsIn >= 0 && startsIn <= 24 * 3600 ? Date.now() + Math.round(startsIn) * 1000 : 0,
    seed: Number.isFinite(Number(m.seed)) ? (Number(m.seed) | 0) : 0,
    v: Number.isFinite(Number(m.v)) ? (Number(m.v) | 0) : 0,
  };
}

/** Round 58: a room's Big Night, if it's running right now (else null). */
function bigOf(room, now) {
  return room.big && room.big.until > (now || Date.now()) ? room.big : null;
}

/** Round 58: how many guests a room takes right now (events 32; Big Night up to its size; otherwise 16). */
function guestCap(room, now) {
  if (room.event) return MAX_EVENT_GUESTS;
  const big = bigOf(room, now);
  return big ? Math.max(MAX_GUESTS, big.size - 1) : MAX_GUESTS;
}

/** Round 58: tells a host what happened to their Big Night. */
function bigNotice(room, state, text) {
  const big = bigOf(room);
  send(room.host, JSON.stringify({
    relay: 'bignight', state, text: String(text || '').slice(0, 300),
    left: big ? Math.max(0, Math.ceil((big.until - Date.now()) / 1000)) : 0,
    size: big ? big.size : MAX_GUESTS + 1
  }));
}

/** Round 58: a host asks for a Big Night (they have a pass, or big rooms are free right now). */
function askBigNight(code, room, ask) {
  const now = Date.now();
  if (room.event) { bigNotice(room, 'no', 'Live events have their own size.'); return; }
  if (bigOf(room, now)) { bigNotice(room, 'on', 'Your Big Night is on.'); return; }
  if (now - (room.bigAskedAt || 0) < BIG_ASK_GAP) return;   // asking again too soon: no answer
  room.bigAskedAt = now;
  const inUse = passId => { for (const [c, r] of rooms) if (c !== code && r.big && r.big.passId === passId && bigOf(r, now)) return true; return false; };
  let result;
  try {
    result = store.bigNightStart(clip(ask && ask.auth, 200), room.ip, inUse);
  } catch (err) {
    console.error('bignight', err && err.message);
    result = { ok: false, message: 'Couldn\'t start your Big Night just now - try again in a minute. Your pass is safe.' };
  }
  if (result && result.ok && result.free) {
    // Free-for-everyone mode: one big room per address at a time.
    for (const [c, r] of rooms) {
      if (c !== code && r.ip === room.ip && bigOf(r, now)) { result = { ok: false, message: 'You already have a Big Night room open - close it first.' }; break; }
    }
  }
  if (!result || !result.ok) { bigNotice(room, 'no', (result && result.message) || 'Big Night isn\'t available right now.'); return; }
  const size = Math.max(MAX_GUESTS + 1, Math.min(250, Number(result.size) || 100));
  room.big = { until: Number(result.until) || 0, passId: String(result.passId || ''), account: String(result.account || ''), free: !!result.free, size };
  bigNotice(room, 'on', result.resumed ? 'Welcome back - your Big Night carries on.' : 'Your Big Night has started!');
}

/** Round 58: a room whose Big Night is over (time up, refunded, or ended by the admin) becomes a normal room. */
function endBigNight(room, why) {
  if (!room.big) return;
  room.big = null;
  bigNotice(room, 'off', why);
}

/** Round 58: every open Big Night room (for the admin page). */
function bigRooms() {
  const now = Date.now();
  const out = [];
  for (const [code, room] of rooms) {
    const big = bigOf(room, now);
    if (big) out.push({ code, passId: big.passId, free: big.free, until: big.until, players: room.guests.size + 1, title: room.meta ? room.meta.title : '' });
  }
  return out;
}
store.setRoomSizes({ freeGuests: MAX_GUESTS });
store.setBigNightRooms(bigRooms);

// ---------------------------------------------------------------- Round 60: the DJ patch bay

const PATCH_GAP = 1500;                 // a host can patch a stage from the game this often
const MAX_PATCH = 2048;                 // bytes of one in-game patch

/** Which patch-bay target a room is: its live event, or its room code. Round 66: the public festival is "event:public". */
function targetOf(code, room) {
  if (room.isPublic) return PUBLIC_TARGET;
  return room.event ? 'event:' + room.event : 'room:' + code;
}

/** Every open room, for the patch bay page. */
function patchRooms() {
  const out = [];
  for (const [code, room] of rooms) {
    const meta = room.meta && Date.now() - room.metaAt < META_TTL ? room.meta : null;
    let title = meta ? meta.title : '';
    if (room.isPublic) title = 'The public festival';   // Round 66
    else if (room.event) {
      const ev = payments.findEvent(room.event);
      title = ev ? clip(ev.name, 40) : room.event;
    }
    out.push({ target: targetOf(code, room), code, title, players: room.guests.size + (room.host ? 1 : 0), listed: !!(meta && meta.listed && !room.noList), event: room.event || '' });
  }
  return out;
}

/** Sends one line to the host and every guest of the room this target is. */
function pushPatch(target, line) {
  let code = '';
  if (target === PUBLIC_TARGET) code = PUBLIC_CODE;   // Round 66
  else if (target.startsWith('event:')) code = eventRooms.get(target.slice(6)) || '';
  else if (target.startsWith('room:')) code = target.slice(5);
  const room = code ? rooms.get(code) : null;
  if (!room) return;
  send(room.host, line);
  for (const guest of room.guests.values()) send(guest, line);
}

patchbay.attach({ rooms: patchRooms, push: pushPatch });

// ---------------------------------------------------------------- Round 63: saved worlds

const MAX_WSAVE = 600 * 1024;           // one section save from the host, as sent (the server keeps 64 KB, 256 KB for the layout)
const WORLD_FAILS_PER_10_MIN = 20;      // refused world opens from one address
const worldFails = new Map();           // ip -> recent refused world opens

/** The open room holding this world (or null). */
function roomOfWorld(id) {
  for (const [code, room] of rooms) if (room.world === id) return { code, room };
  return null;
}

worlds.attach({
  openInfo: (id) => {
    const found = roomOfWorld(id);
    return found ? { code: found.code, players: found.room.guests.size + 1 } : null;
  }
});

/** Sends the host everything saved in its world: a header, one line per section, then "done". */
function sendWorld(ws, opened) {
  const m = opened.meta;
  send(ws, JSON.stringify({ relay: 'world', id: m.id, name: m.name, owner: !!opened.owner, region: m.region, site: m.site, sections: opened.sections.length }));
  for (const [name, text] of opened.sections) send(ws, JSON.stringify({ relay: 'wsec', s: name, d: text }));
  send(ws, JSON.stringify({ relay: 'wdone', id: m.id }));
}

/** The host saves one part of its world. */
function hostWorldSave(room, save) {
  let result;
  try {
    result = worlds.saveSection(room.world, save.s, save.d);
  } catch (err) {
    console.error('worlds save', err && err.message);
    result = { ok: false, text: 'Couldn\'t save that just now - it will be tried again.' };
  }
  send(room.host, JSON.stringify({ relay: 'wsaved', s: clip(save.s, 24), ok: !!(result && result.ok), busy: !!(result && result.busy), text: clip(result && result.text, 200) }));
}

/** The patch-bay lines for a room, to one player who just arrived. */
function sendPatches(ws, code, room) {
  try {
    for (const line of patchbay.linesFor(targetOf(code, room))) send(ws, line);
  } catch (err) {
    console.error('patchbay lines', err && err.message);
  }
}

/** A host patches one of their stages from the game. */
function hostPatch(code, room, patch) {
  const now = Date.now();
  if (now - (room.patchAt || 0) < PATCH_GAP) {
    send(room.host, JSON.stringify({ relay: 'patchack', ok: false, text: 'One change at a time - try again in a second.' }));
    return;
  }
  room.patchAt = now;
  let result;
  try {
    result = patchbay.hostPatch(targetOf(code, room), patch);
  } catch (err) {
    console.error('patchbay host', err && err.message);
    result = { ok: false, text: 'Couldn\'t change that stage just now - try again.' };
  }
  send(room.host, JSON.stringify({ relay: 'patchack', ok: !!(result && result.ok), text: clip(result && result.text, 200) }));
}

/** One room as the Festivals list shows it (live events route through tickets, so no room code). */
function listing(code, room, now) {
  const meta = room.meta && now - room.metaAt < META_TTL ? room.meta : null;
  if (room.noList && !room.event) return null;   // Round 57: taken off the list after reports
  let ev = null;
  if (room.event) {
    ev = payments.findEvent(room.event);
    if (!ev || !payments.features().liveEvents) return null;
  } else if (!meta || !meta.listed) {
    return null;   // private: invite only
  }
  const m = meta || {};
  return {
    code: room.event ? '' : code,
    eventId: room.event || '',
    title: room.event ? clip(ev.name, 40) : m.title,
    desc: m.desc || (room.event ? clip(ev.artist ? `${ev.artist} live${ev.when ? ' - ' + ev.when : ''}` : '', 140) : ''),
    host: m.host || (room.event ? clip(ev.artist, 18) : ''),
    region: m.region || '',
    genre: m.genre || '',
    act: m.act || (room.event ? clip(ev.artist, 40) : ''),
    clock: m.clock || '',
    lineup: m.lineup || (room.event && ev.artist ? [clip(ev.artist, 40)] : []),
    people: m.people || [],
    live: room.event ? true : !!m.live,
    stream: room.event ? !!ev.stream : !!m.stream,
    startsIn: m.startsAt && m.startsAt > now ? Math.ceil((m.startsAt - now) / 1000) : -1,
    ticketed: room.event ? !ev.free : false,
    players: room.guests.size + 1,
    capacity: guestCap(room, now) + 1,   // Round 58: a Big Night room holds more
    seed: meta ? m.seed : hashSeed(room.event),
    v: m.v || 0,
    // Round 58: Big Night rooms are featured (first in the list, with a badge). Older games ignore these.
    featured: !!bigOf(room, now),
    bigNight: !!bigOf(room, now),
    endsIn: bigOf(room, now) ? Math.ceil((room.big.until - now) / 1000) : -1,
    djs: patchbay.onStage(targetOf(code, room)),   // Round 60: real DJs live on its stages ("DJ A - Main Stage")
    ...worldListing(room),                          // Round 63: a saved world ("world": its name; older games ignore it)
  };
}

/** Round 63: what the Festivals list says about a room's saved world (nothing for an ordinary room). */
function worldListing(room) {
  if (!room.world) return {};
  let w = null;
  try { w = worlds.listingFor(room.world); } catch { w = null; }
  return w ? { world: w.name, worldId: w.id, builders: w.people } : {};
}

function listRooms(req, res) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  const ip = forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
  const now = Date.now();
  const hits = (listHits.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length <= LIST_PER_MINUTE) hits.push(now);   // Round 54 review: a hammering client can't grow this list without end
  listHits.set(ip, hits);
  if (listHits.size > 5000) listHits.clear();   // never grows without end
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (hits.length > LIST_PER_MINUTE) {
    res.writeHead(429, headers);
    res.end(JSON.stringify({ ok: false, message: 'Refreshing a lot - wait a moment.', rooms: [] }));
    return;
  }
  const out = [];
  for (const [code, room] of rooms) {
    const item = listing(code, room, now);
    if (item) out.push(item);
  }
  // Round 58: featured (Big Night) rooms first, then live, then the busiest.
  out.sort((a, b) => (b.featured - a.featured) || (b.live - a.live) || (b.players - a.players) || a.title.localeCompare(b.title));
  res.writeHead(200, headers);
  res.end(JSON.stringify({ ok: true, now, rooms: out.slice(0, MAX_LISTED) }));
}

// ---------------------------------------------------------------- Round 54: voice

/** A player may send VOICE_RATE packets a second (short bursts up to VOICE_BURST). */
function voiceAllowed(ws) {
  const now = Date.now();
  if (ws.voiceTokens === undefined) { ws.voiceTokens = VOICE_BURST; ws.voiceAt = now; }
  ws.voiceTokens = Math.min(VOICE_BURST, ws.voiceTokens + (now - ws.voiceAt) * VOICE_RATE / 1000);
  ws.voiceAt = now;
  if (ws.voiceTokens < 1) return false;
  ws.voiceTokens -= 1;
  return true;
}

/** True for a voice line ("v:..."). */
function isVoice(data) {
  return data.length > 2 && data[0] === 0x76 && data[1] === 0x3a;
}

/** Passes one voice packet on to the players it's for (never stored). from = the sender's id (0 = host). */
function relayVoice(room, from, sender, data) {
  if (data.length > MAX_VOICE || !voiceAllowed(sender)) return;
  const text = data.toString();
  const colon = text.indexOf(':', 2);
  if (colon < 0) return;
  const to = text.slice(2, colon);
  const audio = text.slice(colon + 1);
  if (!audio || !/^[A-Za-z0-9+/=]+$/.test(audio)) return;
  const line = 'v:' + from + ':' + audio;
  const senderKey = room.isPublic ? blockKey(sender) : '';   // Round 97: nobody hears someone they blocked
  const deliver = (ws) => {
    if (!ws || ws === sender || ws.readyState !== 1 || ws.bufferedAmount >= VOICE_BACKLOG || !voiceNear(room, sender, ws)) return;   // Round 93: + near the talker (public festival)
    if (senderKey && ws.blocks && ws.blocks.has(senderKey)) return;
    ws.send(line);
    metrics.voice++;
  };
  if (to === '') {
    if (from !== 0) deliver(room.host);
    for (const guest of room.guests.values()) deliver(guest);
    return;
  }
  const ids = to.split(',').slice(0, 40);
  for (const id of ids) {
    const n = Number(id);
    if (!Number.isInteger(n) || n === from) continue;
    deliver(n === 0 ? room.host : room.guests.get(n));
  }
}

// ---------------------------------------------------------------- Round 61: the open mic

/** A performer may send MIC_RATE packets a second (short bursts up to MIC_BURST) - its own bucket, apart from voice. */
function micAllowed(ws) {
  const now = Date.now();
  if (ws.micTokens === undefined) { ws.micTokens = MIC_BURST; ws.micAt = now; }
  ws.micTokens = Math.min(MIC_BURST, ws.micTokens + (now - ws.micAt) * MIC_RATE / 1000);
  ws.micAt = now;
  if (ws.micTokens < 1) return false;
  ws.micTokens -= 1;
  return true;
}

/** True for an open-mic line ("m:..."). */
function isMic(data) {
  return data.length > 2 && data[0] === 0x6d && data[1] === 0x3a;
}

/** The host says who holds a mic now ({"openmic":{"g":[ids]}}). */
function setMicHolders(room, list) {
  room.mic = new Set();
  if (!Array.isArray(list)) return;
  for (const id of list.slice(0, MAX_MIC_HOLDERS)) if (Number.isInteger(id) && id > 0 && room.guests.has(id)) room.mic.add(id);
}

/** Passes one open-mic line on to everyone in the room except the sender (never queued behind a slow listener). */
function deliverMic(room, sender, line) {
  const deliver = (ws) => { if (ws && ws !== sender && ws.readyState === 1 && ws.bufferedAmount < VOICE_BACKLOG) ws.send(line); };
  deliver(room.host);
  for (const guest of room.guests.values()) deliver(guest);
}

/** A guest's open-mic packet ("m:<audio>"): passed on as "m:<id>:<audio>" only while the host has given them a mic. */
function relayMic(room, from, sender, data) {
  if (data.length > MAX_VOICE || !room.mic || !room.mic.has(from) || !micAllowed(sender)) return;
  const text = data.toString();
  const audio = text.slice(text.lastIndexOf(':') + 1);
  if (audio.length < 8 || !/^[A-Za-z0-9+/=]+$/.test(audio)) return;
  deliverMic(room, sender, 'm:' + from + ':' + audio);
}

// ---------------------------------------------------------------- Round 66: the public festival

const PUBLIC_CAPACITY = Math.max(2, Math.min(250, Number(process.env.PUBLIC_CAPACITY) || 60));
const PUBLIC_DAY_SECONDS = Math.max(60, Math.min(86400, Number(process.env.PUBLIC_DAY_SECONDS) || 7200));
const PUBLIC_EPOCH = Date.UTC(2026, 0, 1);     // day 0 of the public festival's clock (never change it: everyone's seed follows it)
const PUBLIC_SEED_STEP = 7919, PUBLIC_SEED_BASE = 58058;   // seed = day index * step + base (the game does the same sum)
const PUBLIC_ROLES = ['goer', 'dj', 'vendor', 'medic', 'security', 'crew'];
const PUBLIC_COUNT_EVERY = 10000;       // the head count (and the clock) to everyone this often, and on every join and leave (Round 93: was 30 s - it doubles as the games' "still connected" signal)
const PUBLIC_LEAD_SILENT_MS = Number(process.env.PUBLIC_LEAD_SILENT_MS) || 8000;   // a lead this quiet (a live game sends 10 a second) is let go
const PUBLIC_KICK_GRACE = 30000;        // the lead may turn a newcomer away (a different game version) only this soon after they arrive
const PUBLIC_BAN_MS = 3600000;          // removed after reports: kept out of the public festival this long
const PUBLIC_NEAR = 45;                 // metres: players this close get each other's every step (the game's own big-room rule)
const PUBLIC_FAR_MS = 2000;             // everyone else gets a player's step this often
const PUBLIC_ROUTE_ABOVE = 20;          // players in the room above which steps go only to the people near each other
const MAX_PUBLIC_PRESENCE = 8192;       // characters in one step (an outfit can be up to 4000)
const PRESENCE_RATE = 14, PRESENCE_BURST = 24;   // steps a second a player may send (a game sends 7-10; Round 93: 2 standing still). Round 93: was 20 / 30
const PUBLIC_PER_IP = Math.max(1, Number(process.env.PUBLIC_PER_IP) || 3);   // Round 66 (review): players from one address
const PUBLIC_LEAD_GRACE = 30000;        // Round 66 (review): a new lead isn't let go for being quiet this soon (its game may still be loading)
const LEAD_MSG_RATE = 400, LEAD_MSG_BURST = 800;                    // Round 66 (review): the lead's lines a second (its own + the guests' it passes on)
const LEAD_BYTE_RATE = 512 * 1024, LEAD_BYTE_BURST = 2 * 1024 * 1024;
// Round 93: live multiplayer health.
//  - FAN-OUT: a guest's "custom" and "social" lines (the shared games' channels) go from here straight to everyone else, with
//    who sent them and their name stamped by the relay - not up to the lead and back down again. The lead still gets each one
//    (wrapped as before) to act on, but no longer passes it on, so its upload stays small however full the festival is, and
//    nobody (a modified lead included) can put words in another player's mouth on those channels. "pub" says "fan":1; a lead
//    whose game doesn't know yet passes them on as before and those copies are skipped here (nobody gets one twice).
//    The open mic's channels (omic, omicr) still go through the lead, which checks every one first.
//  - A player whose connection dropped and comes back (same live account) replaces their old, dead connection at once:
//    the same name, no ghost standing about for a minute. A guest silent this long (a game sends 7-10 steps a second) is let go.
//  - Different game versions: a newcomer whose game speaks another protocol version (?v=) than the lead's is turned away here,
//    before anyone sees them, with words that say which side needs updating. Games that don't say their version: as before.
//  - Voice in the public festival only reaches players within PUBLIC_VOICE_RANGE of the talker (by their last steps) - a
//    modified game can't talk into everyone's ears across the site.
//  - The lead's own lines may only speak for the lead: a "from" other than 0 (or -1) on a game line it sends is dropped,
//    except a line it passes on for that very guest ("except": that guest).
const PUBLIC_GUEST_SILENT_MS = Number(process.env.PUBLIC_GUEST_SILENT_MS) || 75000;   // (review: 75 s - a phone in a pocket or a hidden browser tab sends nothing for a while, and pings don't count)
const PUBLIC_VOICE_RANGE = 60;          // metres (the game's voice is silent beyond 25 m; steps can be a moment old)
const FAN_MAX = 4096;                   // characters in one fanned-out line (custom payloads are at most 1200)
const FAN_RATE = 40, FAN_BURST = 60;    // custom/social lines a second per player (the game sends at most 20 a channel, a few channels at once)
const FAN_SOCIAL_RATE = 5, FAN_SOCIAL_BURST = 10;   // social lines (records, dance-offs...) a second per player, within the above
const FAN_CUSTOM_TEXT = 1200, FAN_SOCIAL_TEXT = 64, FAN_CHANNEL = 24;
const FAN_LEAD_ONLY = new Set(['omic', 'omicr']);   // custom channels the lead still checks and passes on itself
// Round 66 (review): what the lead may never send in the public festival - it is just another player, not a host. (A "bye" is
// allowed only to one newcomer, straight after they arrive: the lead's game turns away a different version.)
const PUBLIC_LEAD_BLOCKED = new Set(['bye', 'leave', 'welcome', 'start', 'snapshot', 'state', 'liveset', 'world', 'wsec']);
const publicBans = new Map();           // ip -> until
let publicSerial = 0;                   // a number per connection, for reports (a player's id changes if they become the lead)

// Round 97 (see the notes at the top and the "Round 97" section below).
const CAP_BATCH = 1, CAP_LIVE = 2, CAP_RESUME = 4, RELAY_CAPS = 7;
const BATCH_MS = Math.max(5, Math.min(200, Number(process.env.RELAY_BATCH_MS) || 40));   // a batched line waits at most this long
const BATCH_MAX = 48 * 1024;            // characters in one batch (it goes at once past this)
const TIER_ABOVE = 6;                   // players in the room above which far players' steps are thinned
const MID_RANGE = 110, MID_MS = 350;    // metres: players this close get a step about 3 times a second (nearer: every one)
const RESUME_GRACE_MS = Math.max(0, Math.min(120000, Number(process.env.RESUME_GRACE_MS) || 20000));
const RESUME_SILENT_MS = 8000;          // an old connection this quiet (a live game sends 2+ steps a second) is a dead one
const LX_CHANNEL = 'lx';
const LX_RE = /^([oynxgjlp])\|([a-z]{2,3})\|(\d{1,9})(?:\|[^\n|]{0,60}){0,3}$/;   // op | kind | nonce [| up to 3 small args]
const LX_KINDS = new Set(['hf', 'hug', 'dn', 'kd', 'gm', 'ph', 'fl', 'wv']);
const LX_RANGE = { hf: 12, hug: 10, dn: 25, kd: 12, gm: 250, ph: 25, fl: 60, wv: 40 };   // metres an offer may reach
const LX_GROUP_RANGE = 40;              // a group line (a dance circle, a photo) reaches players this close
const LX_RATE = 6, LX_BURST = 12;       // interaction lines a second per player
const LX_OFFER_GAP = 900;               // ms between two offers from one player
const LX_PAIR_WINDOW = 30000, LX_PAIR_MAX = 4;   // offers to the same player in 30 s
const LX_POINTS = { hf: 2, hug: 2, wv: 1, dn: 3, kd: 3, gm: 3, ph: 3, fl: 0 };
const LX_PAIR_COOLDOWN = 4 * 60000;     // the same two players earn points for the same thing this often
const MAX_BLOCKS = 100;
const LIVE_FIRST_MS = Math.max(5000, Number(process.env.LIVE_FIRST_MS) || 90000);     // the first moment after someone arrives
const LIVE_GAP_MS = Math.max(10000, Number(process.env.LIVE_GAP_MS) || 6 * 60000);    // between moments
const LIVE_LEAD_IN_MS = Math.max(3000, Number(process.env.LIVE_LEAD_IN_MS) || 40000); // "in 40 s at the main stage"
const LIVE_CHECKIN_MS = 4500;           // a check-in counts for this long (games send one a second while they're in)
const LV_RATE = 3, LV_BURST = 6;
const BOARD_EVERY = Math.max(1000, Number(process.env.LIVE_BOARD_MS) || 15000), BOARD_TOP = 5, BOARD_MAX = 500;
const IDLE_HOST_MS = Math.max(5000, Number(process.env.IDLE_HOST_MS) || 15 * 60000);
// Round 97 (review): a batched frame starts with this line, so a game splits a frame only when the relay's batcher made it.
const BATCH_MARK = '~b';
const MIC_LINE_RE = /^m:\d{1,6}:[A-Za-z0-9+/=]{8,1700}$/;   // an open-mic line as the lead / host passes it on
const LX_GROUP_GAP = { p: 10000, j: 3000, l: 1000 };          // ms between group lines of one kind from one player
function hasLineBreak(text) { return text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0; }

const publicRoom = {
  host: null, guests: new Map(), nextId: 1, event: '', meta: null, metaAt: 0, metaSentAt: 0, ip: '(public)', banned: new Set(),
  noList: true, big: null, bigAskedAt: 0, mic: new Set(), world: '', peopleAt: 0, isPublic: true
};
rooms.set(PUBLIC_CODE, publicRoom);
patchbay.roomOpened(PUBLIC_TARGET);

/** The public festival's clock right now: {now, epoch, dayLen (seconds), seed}. */
function publicClock(now) {
  const day = Math.floor((now - PUBLIC_EPOCH) / (PUBLIC_DAY_SECONDS * 1000));
  return { now, epoch: PUBLIC_EPOCH, dayLen: PUBLIC_DAY_SECONDS, seed: (Math.imul(day, PUBLIC_SEED_STEP) + PUBLIC_SEED_BASE) | 0 };
}

function publicPlayers(room) {
  return room.guests.size + (room.host ? 1 : 0);
}

/** Every player in the public festival (the lead first), for sending one line to all of them. */
function publicEach(room, fn) {
  if (room.host) fn(room.host);
  for (const ws of room.guests.values()) fn(ws);
}

/** The head count (and the clock, so games stay in step) to everyone in the room. */
function publicCountAll(room) {
  const line = JSON.stringify({ relay: 'count', players: publicPlayers(room), now: Date.now() });
  publicEach(room, ws => send(ws, line));
}

/** A name nobody else in the room has ("Jade" -> "Jade 2"). */
function publicName(room, wanted) {
  const base = clip(wanted, 18) || 'Raver';
  const taken = new Set();
  publicEach(room, ws => taken.add(String(ws.pname || '').toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()) && n < 1000; n++) {
    const suffix = ' ' + n;
    name = base.slice(0, 18 - suffix.length) + suffix;
  }
  return name;
}

/** A guest id nobody here has (never 0 - that's always the lead - and kept small enough for every game's parser). */
function publicNewId(room) {
  for (let tries = 0; tries < 2000; tries++) {
    const id = room.nextId;
    room.nextId = room.nextId >= 900000 ? 1 : room.nextId + 1;
    if (!room.guests.has(id)) return id;
  }
  return 0;
}

/** Round 93 (review): would publicNewId find a free number right now (without taking one)? */
function publicHasFreeId(room) {
  let id = room.nextId;
  for (let tries = 0; tries < 2000; tries++) {
    if (!room.guests.has(id)) return true;
    id = id >= 900000 ? 1 : id + 1;
  }
  return false;
}

function publicRole(id) {
  const role = String(id || '');
  return PUBLIC_ROLES.includes(role) ? role : '';
}

/** A player may send PRESENCE_RATE steps a second (short bursts up to PRESENCE_BURST); the rest are skipped. */
function presenceAllowed(ws) {
  const now = Date.now();
  if (ws.presTokens === undefined) { ws.presTokens = PRESENCE_BURST; ws.presAt = now; }
  ws.presTokens = Math.min(PRESENCE_BURST, ws.presTokens + (now - ws.presAt) * PRESENCE_RATE / 1000);
  ws.presAt = now;
  if (ws.presTokens < 1) return false;
  ws.presTokens -= 1;
  return true;
}

/**
 * One player's step, straight to the others (not through the lead's upload). Who sent it and their name are stamped
 * here; a broken number drops it. In a busy room it goes only to the players near them, and to everyone every 2 s.
 * A listener who is behind skips it (a newer step is coming), like voice.
 */
function publicPresence(room, ws, id, text) {
  if (text.length > MAX_PUBLIC_PRESENCE || !presenceAllowed(ws)) return;
  let p;
  try { p = JSON.parse(text); } catch { return; }
  if (!p || typeof p !== 'object' || p.t !== 'presence') return;
  for (const k of ['x', 'y', 'z', 'yaw', 'speed']) {
    if (p[k] !== undefined && (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || Math.abs(p[k]) > 100000)) return;
  }
  p.from = id;
  p.name = ws.pname;
  const role = publicRole(p.role);
  if (role) ws.role = role; else p.role = ws.role || 'goer';
  if (typeof p.gear === 'string' && p.gear.length > 4000) p.gear = '';
  if (p.lvl !== undefined && (!Number.isInteger(p.lvl) || p.lvl < 0 || p.lvl > 9999)) delete p.lvl;   // Round 97: their level (newer games)
  ws.px = Number(p.x) || 0;
  ws.pz = Number(p.z) || 0;
  if (Number.isInteger(p.lvl)) ws.lvl = p.lvl;
  // Round 97: to the centimetre and a tenth of a degree - nobody can see more, and every step is shorter.
  for (const k of ['x', 'y', 'z', 'speed']) if (typeof p[k] === 'number') p[k] = Math.round(p[k] * 100) / 100;
  if (typeof p.yaw === 'number') p.yaw = Math.round(p.yaw * 10) / 10;
  // Round 93: a game writes every field of its message, most of them empty in a step ("save":"","relay":"",...). Those go:
  // a game reading the step gets the same (an empty field reads as its default), and every step is a third smaller.
  for (const k of Object.keys(p)) {
    if (k === 't' || k === 'from' || k === 'target') continue;
    const v = p[k];
    if (v === '' || v === 0 || v === false || v === null) delete p[k];
  }
  const line = JSON.stringify(p);
  const now = Date.now();
  // Round 97: interest - once more than TIER_ABOVE are in, each listener gets this player's steps by how far apart they are:
  // every step within PUBLIC_NEAR, about 3 a second within MID_RANGE, one every PUBLIC_FAR_MS beyond (or before we know
  // where the listener is). Was: everything below 21 players, then near-or-every-2-s. (PUBLIC_ROUTE_ABOVE is kept for reference.)
  const tiered = publicPlayers(room) > TIER_ABOVE;
  if (tiered && !ws.stepSentAt) ws.stepSentAt = new WeakMap();   // listener -> when they last got one of my steps
  const near2 = PUBLIC_NEAR * PUBLIC_NEAR, mid2 = MID_RANGE * MID_RANGE;
  publicEach(room, other => {
    if (other === ws || other.readyState !== 1 || other.pubGone || other.bufferedAmount > VOICE_BACKLOG) return;
    if (tiered) {
      let gap = PUBLIC_FAR_MS;
      if (other.px !== undefined) {
        const dx = other.px - ws.px, dz = other.pz - ws.pz, d2 = dx * dx + dz * dz;
        gap = d2 <= near2 ? 0 : d2 <= mid2 ? MID_MS : PUBLIC_FAR_MS;
      }
      if (gap > 0 && now - (ws.stepSentAt.get(other) || 0) < gap) { metrics.stepsThinned++; return; }
      ws.stepSentAt.set(other, now);
    }
    queueLine(other, line);
  });
}

/** Round 93: a player may fan out FAN_RATE custom/social lines a second (bursts up to FAN_BURST); the rest are skipped. */
function fanAllowed(ws, social) {
  const now = Date.now();
  if (social) {
    if (ws.socTokens === undefined) { ws.socTokens = FAN_SOCIAL_BURST; ws.socAt = now; }
    ws.socTokens = Math.min(FAN_SOCIAL_BURST, ws.socTokens + (now - ws.socAt) * FAN_SOCIAL_RATE / 1000);
    ws.socAt = now;
    if (ws.socTokens < 1) return false;
  }
  if (ws.fanTokens === undefined) { ws.fanTokens = FAN_BURST; ws.fanAt = now; }
  ws.fanTokens = Math.min(FAN_BURST, ws.fanTokens + (now - ws.fanAt) * FAN_RATE / 1000);
  ws.fanAt = now;
  if (ws.fanTokens < 1) return false;
  ws.fanTokens -= 1;
  if (social) ws.socTokens -= 1;
  return true;
}

/**
 * Round 93: a game line the relay fans out itself (a custom line on any channel but the open mic's, or a social line), checked
 * the way the lead's game checks it. Returns the parsed message, or null (not one of these, or not acceptable).
 */
function fanParse(text) {
  if (text.length > FAN_MAX) return null;
  let p;
  try { p = JSON.parse(text); } catch { return null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (p.t === 'custom') {
    if (typeof p.ch !== 'string' || p.ch.length < 1 || p.ch.length > FAN_CHANNEL || FAN_LEAD_ONLY.has(p.ch)) return null;
    if (p.text !== undefined && p.text !== null && (typeof p.text !== 'string' || p.text.length > FAN_CUSTOM_TEXT)) return null;
    return p;
  }
  if (p.t === 'social') {
    if (p.text !== undefined && p.text !== null && (typeof p.text !== 'string' || p.text.length > FAN_SOCIAL_TEXT)) return null;
    if (p.target !== undefined && !Number.isInteger(p.target)) return null;
    return p;
  }
  return null;
}

/** Round 93: is this a line the relay fans out (so the lead must not pass it on again)? ('' kind: not a game line.) */
function fanKind(kind, text) {
  if (kind === 'social') return true;
  if (kind !== 'custom') return false;
  const m = /"ch":"([^"\\]{0,24})"/.exec(text);
  return !!m && m[1].length > 0 && !FAN_LEAD_ONLY.has(m[1]);
}

/** Round 93: a guest's custom/social line - to the lead (to act on, as before) and straight to everyone else (stamped). */
function publicFanOut(room, ws, id, text) {
  const p = fanParse(text);
  if (!p) {
    // Not one the relay fans out: an open-mic line goes to the lead as before; anything malformed goes nowhere.
    if (lineKind(text) === 'custom' && !fanKind('custom', text)) { sendToHost(room, JSON.stringify({ relay: 'msg', g: id, m: text })); }
    return;
  }
  if (!fanAllowed(ws, p.t === 'social')) return;
  if (p.t === 'custom' && p.ch === LX_CHANNEL) { publicLx(room, ws, id, p, text); return; }   // Round 97: to its one target only
  sendToHost(room, JSON.stringify({ relay: 'msg', g: id, m: text }));
  p.from = id;
  p.name = ws.pname;
  const line = JSON.stringify(p);
  const key = p.t === 'social' ? blockKey(ws) : '';   // Round 97: a blocked player's social moments don't reach you
  for (const [gid, guest] of room.guests) {
    if (gid === id || guest === ws || guest.readyState !== 1 || guest.pubGone) continue;
    if (guest.bufferedAmount > MAX_BUFFERED) continue;   // far behind: skipped (never queued without end)
    if (key && guest.blocks && guest.blocks.has(key)) continue;
    queueLine(guest, line);   // Round 97: batched for games that read batches
  }
}

/**
 * Round 93 (review): a game line the lead sends, parsed: a plain object whose "t" is the kind it starts with (JSON keeps the
 * LAST of two "t"s - a line can't start as one kind and be read as another) and whose "from", if any, is a whole number.
 * null if it isn't one.
 */
function leadLine(text, kind) {
  let p;
  try { p = JSON.parse(text); } catch { return null; }
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.t !== kind) return null;
  if (p.from !== undefined && !Number.isInteger(p.from)) return null;
  return p;
}

/** Round 93: a parsed line of a kind the relay fans out itself (custom on any channel but the open mic's; social). */
function fanParsedKind(p) {
  if (p.t === 'social') return true;
  return p.t === 'custom' && typeof p.ch === 'string' && p.ch.length > 0 && !FAN_LEAD_ONLY.has(p.ch);
}

/** Round 93: may this listener hear a voice packet from this talker (public festival: within PUBLIC_VOICE_RANGE)? */
function voiceNear(room, sender, listener) {
  if (!room.isPublic) return true;
  if (sender.px === undefined || listener.px === undefined) return true;   // (positions not known yet: as before)
  const dx = sender.px - listener.px, dz = sender.pz - listener.pz;
  return dx * dx + dz * dz <= PUBLIC_VOICE_RANGE * PUBLIC_VOICE_RANGE;
}

/** Round 66: a report in the public festival (target = the id the reporter sees: 0 = the lead). */
function publicReport(room, from, reporter, target, reason, name) {
  if (!Number.isInteger(target) || target === from || target < 0) return;
  const reported = target === 0 ? room.host : room.guests.get(target);
  if (!reported || reported === reporter || reported.readyState !== 1) return;
  // Round 66 (review): a number can change hands (player 0 is whoever leads now) - the report counts only if the name the
  // reporter saw is this player's.
  if (sameName(name, reported.pname) === false) return;
  // Reports are counted per connection (the lead's id is 0 to everyone, whoever it is at the time).
  const result = reports.file({ room: PUBLIC_CODE, title: 'The public festival', target: reported.pubSerial, name, reason, ip: reporter.ip });
  if (!result.act) return;
  if (reported.ip) {
    publicBans.set(reported.ip, Date.now() + PUBLIC_BAN_MS);
    if (publicBans.size > 5000) publicBans.clear();
  }
  send(reported, JSON.stringify({ t: 'bye', from: 0, ch: 'relay', text: 'You were removed from the public festival after reports from other players.' }));
  publicDrop(room, reported);   // the goodbyes now (and a new lead at once if it was them), not when the socket finally closes
  reported.close(1000, 'removed');
  reports.note(PUBLIC_CODE, reported.pubSerial, 'removed from the public festival');
}

/** Round 66 (review): the same name as shown in a game (spaces tidied, any case)? */
function sameName(a, b) {
  const tidy = (v) => String(v || '').replace(/[\u200b-\u200f\ufeff<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 18);
  return tidy(a) === tidy(b);
}

/** Round 66 (review): the lead may send LEAD_MSG_RATE lines / LEAD_BYTE_RATE bytes a second (bursts allowed); a flood is cut off. */
function leadAllowed(ws, bytes) {
  const now = Date.now();
  if (ws.leadTokens === undefined) { ws.leadTokens = LEAD_MSG_BURST; ws.leadBytes = LEAD_BYTE_BURST; ws.leadAt = now; ws.leadDrops = 0; ws.leadDropsAt = now; }
  const dt = (now - ws.leadAt) / 1000;
  ws.leadAt = now;
  ws.leadTokens = Math.min(LEAD_MSG_BURST, ws.leadTokens + dt * LEAD_MSG_RATE);
  ws.leadBytes = Math.min(LEAD_BYTE_BURST, ws.leadBytes + dt * LEAD_BYTE_RATE);
  if (bytes <= MAX_GUEST_MESSAGE && ws.leadTokens >= 1 && ws.leadBytes >= bytes) {
    ws.leadTokens -= 1;
    ws.leadBytes -= bytes;
    return true;
  }
  if (now - ws.leadDropsAt > 10000) { ws.leadDrops = 0; ws.leadDropsAt = now; }
  if (++ws.leadDrops > GUEST_DROPS_TO_CLOSE) {
    send(ws, JSON.stringify({ t: 'bye', from: 0, ch: 'relay', text: 'Your game was sending far too many messages, so it was disconnected.' }));
    publicDrop(publicRoom, ws);
    ws.close(1008, 'flooding');
  }
  return false;
}

/** Round 66 (review): the kind ("t") of a game line, read without parsing it ('' if it isn't a game message). */
function lineKind(text) {
  const m = /^\{"t":"([A-Za-z]{1,16})"/.exec(text);
  return m ? m[1] : '';
}

/** The longest-connected player still here becomes the lead (the old one left). Nobody left: the room just waits. */
function publicPromote(room, prevName) {
  room.host = null;
  room.mic = new Set();   // the new lead hands out the open mic afresh
  for (const [gid, ws] of room.guests) {
    if (ws.readyState !== 1 || ws.pubGone) continue;
    room.guests.delete(gid);
    room.host = ws;
    ws.pubId = 0;
    ws.leadSince = Date.now();
    ws.lastMsgAt = Date.now();
    const notice = JSON.stringify({ relay: 'newlead', old: gid, name: ws.pname, prev: clip(prevName, 18) });
    for (const other of room.guests.values()) send(other, notice);
    send(ws, JSON.stringify({ relay: 'lead', old: gid }));
    for (const [id, other] of room.guests) send(ws, JSON.stringify({ relay: 'join', g: id, name: other.pname }));
    return;
  }
}

/**
 * Someone left the public festival (or was let go): tell the others at once, and pick a new lead if it was the lead.
 * Safe to call twice (a removed player's socket closes a moment later).
 */
function publicDrop(room, ws) {
  if (ws.pubLeft) return;
  ws.pubLeft = true;
  ws.pubGone = true;   // nothing more from them
  if (room.host === ws) {
    publicPromote(room, ws.pname);
  } else {
    const id = ws.pubId;
    if (!id || room.guests.get(id) !== ws) return;   // never in (refused), or already gone
    room.guests.delete(id);
    room.mic.delete(id);
    send(room.host, JSON.stringify({ relay: 'leave', g: id }));
    const left = JSON.stringify({ relay: 'left', g: id, name: ws.pname });
    for (const other of room.guests.values()) send(other, left);
  }
  publicCountAll(room);
}

/** The lead's own lines: passed on like a host's (the lead's game runs exactly as a host). */
function publicLeadMessage(room, ws, data) {
  if (!leadAllowed(ws, data.length)) return;   // Round 66 (review): the lead is size- and rate-limited too
  let packet;
  try { packet = JSON.parse(data.toString()); } catch { return; }
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;
  if (packet.relay === 'role') { const role = publicRole(packet.id); if (role) ws.role = role; return; }
  if (typeof packet.relay === 'string') { publicControl(room, ws, packet); return; }   // Round 97: bye, block, lv, alive (for the relay only)
  if (typeof packet.kick === 'number') {
    // Only a newcomer, straight after arriving (the lead's game turns away a different version). Nobody is banned here:
    // the lead is just another player.
    const guest = room.guests.get(packet.kick);
    if (guest && Date.now() - (guest.joinedAt || 0) < PUBLIC_KICK_GRACE) { publicDrop(room, guest); guest.close(1000, 'turned away'); }
    return;
  }
  if (typeof packet.report === 'object' && packet.report !== null) {
    publicReport(room, 0, ws, Number(packet.report.g), Number(packet.report.reason) | 0, clip(packet.report.name, 18));
    return;
  }
  if (typeof packet.openmic === 'object' && packet.openmic !== null) {
    if (data.length <= 512) setMicHolders(room, packet.openmic.g);
    return;
  }
  if (typeof packet.patch === 'object' && packet.patch !== null) {
    send(ws, JSON.stringify({ relay: 'patchack', ok: false, text: 'The public festival\'s stages are run by the organiser.' }));
    return;
  }
  if (typeof packet.m !== 'string') return;   // (listings, Big Night, world saves: not in the public festival)
  if (packet.m.startsWith('{"relay"')) return;
  // Round 97 (review): one line is one line - a line break would let a lead slip a second, made-up line (a server notice,
  // someone else's step) into a game that reads batches. And an open-mic line is exactly "m:<id>:<audio>", nothing else.
  if (hasLineBreak(packet.m)) return;
  if (packet.m.startsWith('m:') && !MIC_LINE_RE.test(packet.m)) return;
  const toAll = packet.to === -1 || packet.to === undefined;
  // Round 66 (review): only game messages and open-mic lines - and none that only a host may send (a lead that turned
  // out to be a modified game can't send everyone home, or anyone a festival). A goodbye may go to one newcomer only.
  const kind = lineKind(packet.m);
  if (!kind && !packet.m.startsWith('m:')) return;
  if (kind) {
    // Round 93 (review): a game line is read in full - its real kind and sender, not just how it starts (a second "t" or a
    // "from" further along can't slip past) - and passed on as re-written here, so every game reads exactly what was checked.
    const p = leadLine(packet.m, kind);
    if (!p) return;
    // The relay already gave everyone a guest's custom/social line - a lead passing it on again is skipped.
    if (Number.isInteger(packet.except) && fanParsedKind(p)) return;
    // Round 97: the lead's own interaction line goes to its one target (or the players near it), checked like anyone's.
    if (kind === 'custom' && p.ch === LX_CHANNEL) {
      if ((p.from === undefined || p.from === -1 || p.from === 0) && (p.text === undefined || (typeof p.text === 'string' && p.text.length <= FAN_CUSTOM_TEXT))) publicLx(room, ws, 0, p, packet.m);
      return;
    }
    // The lead speaks only for itself (0; -1 = not set), or passes a line on for the one guest it came from.
    const from = p.from === undefined ? -1 : p.from;
    if (from !== 0 && from !== -1 && !(Number.isInteger(packet.except) && from === packet.except && room.guests.has(from))) return;
    packet.m = JSON.stringify(p);
  }
  if (PUBLIC_LEAD_BLOCKED.has(kind)) {
    const newcomer = Number.isInteger(packet.to) ? room.guests.get(packet.to) : null;
    if (kind !== 'bye' || !newcomer || Date.now() - (newcomer.joinedAt || 0) >= PUBLIC_KICK_GRACE) return;
  }
  if (toAll && kind === 'presence') { publicPresence(room, ws, 0, packet.m); return; }
  if (packet.m.startsWith('m:') && toAll) {
    if (packet.m.length > MAX_VOICE + 16 || !micAllowed(ws)) return;
    for (const [gid, guest] of room.guests) {
      if (gid !== packet.except && guest.readyState === 1 && guest.bufferedAmount < VOICE_BACKLOG) guest.send(packet.m);
    }
    return;
  }
  if (Array.isArray(packet.to)) {
    const seen = new Set();
    for (const id of packet.to.slice(0, MAX_TO_LIST)) {
      if (!Number.isInteger(id) || seen.has(id)) continue;
      seen.add(id);
      queueLine(room.guests.get(id), packet.m);   // Round 97: batched
    }
  } else if (toAll) {
    for (const [gid, guest] of room.guests) if (gid !== packet.except) queueLine(guest, packet.m);   // Round 97: batched
  } else {
    send(room.guests.get(packet.to), packet.m);
  }
}

/** One line from a player in the public festival. */
function publicMessage(room, ws, data) {
  if (ws.pubGone) return;
  ws.lastMsgAt = Date.now();
  metrics.msgsIn++;   // Round 97
  const isLead = room.host === ws;
  const id = isLead ? 0 : ws.pubId;
  if (!isLead && room.guests.get(id) !== ws) return;
  if (isVoice(data)) { relayVoice(room, id, ws, data); return; }
  if (isLead) { publicLeadMessage(room, ws, data); return; }
  if (isMic(data)) { relayMic(room, id, ws, data); return; }
  if (!guestAllowed(ws, data.length)) return;
  if (data.length < 160 && data[0] === 0x72 && data[1] === 0x3a) {
    const r = parseReport(data.toString());
    if (r) publicReport(room, id, ws, r.target, r.reason, clip(r.name, 18));
    return;
  }
  const head = data.toString('utf8', 0, Math.min(data.length, 16));
  if (head.startsWith('{"relay"')) {
    // For the relay itself (never passed on): which role this player is playing.
    if (data.length > 200) return;
    let packet;
    try { packet = JSON.parse(data.toString()); } catch { return; }
    if (packet && packet.relay === 'role') { const role = publicRole(packet.id); if (role) ws.role = role; }
    else if (packet && typeof packet === 'object' && typeof packet.relay === 'string') publicControl(room, ws, packet);   // Round 97
    return;
  }
  if (head.startsWith('{"t":"presence"')) { publicPresence(room, ws, id, data.toString()); return; }
  if (head.startsWith('{"t":"custom"') || head.startsWith('{"t":"social"')) { publicFanOut(room, ws, id, data.toString()); return; }   // Round 93
  sendToHost(room, JSON.stringify({ relay: 'msg', g: id, m: data.toString() }));
}

/** A player arrives at /public?name=... */
function publicConnect(ws, url, ip) {
  const room = publicRoom;
  const now = Date.now();
  const refuse = (text) => { send(ws, JSON.stringify({ t: 'bye', from: 0, ch: 'relay', text })); ws.close(1000, 'refused'); };
  if ((publicBans.get(ip) || 0) > now) { refuse('You were removed from the public festival after reports from other players. Try again later.'); return; }
  // Round 74: live mode needs a sign-up (a username and email) - and everyone there sees that username.
  if (players.required() && !players.isReady()) { refuse('The server is just starting up - try again in a few seconds.'); return; }
  // Round 109: a ticket (or, from older games, the sign-in key). A ticket that's no good: "ticket:" (the game simply tries again).
  const ptText = url.searchParams.get('pt') || '';
  const signedUp = players.isTicket(ptText) ? players.redeemTicket(ptText) : players.check(ptText);
  if (players.required() && players.isTicket(ptText) && !signedUp) { refuse(TICKET_AGAIN); return; }
  if (!signedUp && players.required()) { refuse('signup: Make a live account (username, email and password) to join the Open Festival. (Update the game if it doesn\'t ask you.)'); return; }
  // Round 93: the game's protocol version (?v=; 0 = an older game that doesn't say). A different one than the lead's can't
  // play together - turned away here, before anyone sees them, saying which side needs updating.
  const pv = /^\d{1,4}$/.test(String(url.searchParams.get('v') || '')) ? Number(url.searchParams.get('v')) : 0;
  const leadPv = room.host && !room.host.pubGone ? (room.host.pv || 0) : 0;
  if (pv > 0 && leadPv > 0 && pv !== leadPv) {
    refuse(pv < leadPv
      ? 'The Open Festival is on a newer version of the game. Please update your game, then join again.'
      : 'The current host of the Open Festival is on an older version of the game. Try again in a little while (they update too).');
    return;
  }
  // Round 93: the same live account coming back (a dropped connection, or another device): the old connection goes now,
  // so they keep their name and nobody sees a frozen ghost of them. (Before the name is picked, so it isn't "Jade 2".)
  const account = signedUp ? String(signedUp.username || '').toLowerCase() : '';
  // Round 97: what this game can do (?cap=; 0 = an older game that doesn't say).
  const capText = String(url.searchParams.get('cap') || '');
  ws.cap = /^\d{1,3}$/.test(capText) ? (Number(capText) & RELAY_CAPS) : 0;
  let resumeFrom = null;   // Round 97: their old place, kept for them (dropped without a goodbye, or gone silent)
  if (account) {
    // (Round 93 review: only if the festival can take them - the old connection isn't let go for nothing.)
    if (!publicHasFreeId(room)) { refuse('The public festival is busy - try again in a minute.'); return; }
    const old = [];
    publicEach(room, other => { if (other.pubAccount === account && !other.pubGone) old.push(other); });
    for (const other of old) {
      // Round 97: a guest whose connection has dropped (held for them) or gone silent gets its own number, name and figure
      // back - nobody sees them leave and come back. A live connection elsewhere (another device) is replaced as before.
      const held = other !== room.host && other.pubId > 0 && room.guests.get(other.pubId) === other &&
        (other.readyState !== 1 || now - (other.lastMsgAt || 0) >= RESUME_SILENT_MS);
      if (held && !resumeFrom && (ws.cap & CAP_RESUME)) { resumeFrom = other; continue; }   // (review: only a game that says it can resume)
      send(other, JSON.stringify({ t: 'bye', from: 0, ch: 'relay', text: 'You joined the Open Festival from another device.' }));
      publicDrop(room, other);
      // Round 93 (review): its own close code - the game there (lead or not) takes it as final and doesn't reconnect.
      try { other.close(4001, 'replaced'); } catch { /* gone already */ }
    }
  }
  // (Round 93: counted after a returning player's old connection has gone - it mustn't keep them out. Round 97: nor their
  // own kept place.)
  if (!resumeFrom && publicPlayers(room) >= PUBLIC_CAPACITY) { refuse(`The public festival is full right now (${PUBLIC_CAPACITY} people) - try again in a few minutes.`); return; }
  // Round 66 (review): a few players per address at most - one or two computers can't fill the whole festival.
  let fromHere = 0;
  publicEach(room, other => { if (other.ip === ip && !other.pubGone && other !== resumeFrom) fromHere++; });
  if (fromHere >= PUBLIC_PER_IP) { refuse(`Only ${PUBLIC_PER_IP} players from one network can be in the public festival at once.`); return; }
  ws.pubAccount = account;
  ws.pv = pv;
  ws.joinedAt = now;
  ws.lastMsgAt = now;
  let lead = false;
  let id = 0;
  if (resumeFrom) {
    id = publicResume(room, resumeFrom, ws);
  } else {
    ws.pname = publicName(room, signedUp ? signedUp.username : url.searchParams.get('name'));
    ws.role = 'goer';
    ws.pubSerial = ++publicSerial;
    lead = !room.host;
    if (lead) {
      room.host = ws;
      ws.leadSince = now;
    } else {
      id = publicNewId(room);
      if (!id) { refuse('The public festival is busy - try again in a minute.'); return; }
      room.guests.set(id, ws);
    }
  }
  ws.pubId = id;
  // Round 93: fan = the relay passes guests' custom/social lines on itself. Round 97: + cap (what this relay does), resumed.
  send(ws, JSON.stringify(Object.assign({ relay: 'pub', id, name: ws.pname, lead, players: publicPlayers(room), capacity: PUBLIC_CAPACITY }, publicClock(now), { fan: 1, cap: RELAY_CAPS, resumed: resumeFrom ? 1 : 0 })));
  if (lead) {
    send(ws, JSON.stringify({ relay: 'lead', old: -1 }));
    // Round 97: places kept for players whose connection dropped (everyone else had gone too) - the new lead knows them.
    for (const [gid, other] of room.guests) send(ws, JSON.stringify({ relay: 'join', g: gid, name: other.pname }));
  } else if (!resumeFrom) send(room.host, JSON.stringify({ relay: 'join', g: id, name: ws.pname }));   // (a resumed player never left the lead's list)
  if (!room.host) publicPromote(room, '');   // Round 97: came back to a festival whose lead had gone: someone leads at once
  sendPatches(ws, PUBLIC_CODE, room);   // the stages' live DJs straight away
  ws.on('message', (data) => publicMessage(room, ws, data));
  ws.on('close', (code) => publicClosed(room, ws, code));   // Round 97: a drop without a goodbye may keep their place a moment
  if (ws.cap & CAP_LIVE) liveWelcome(room, ws);              // Round 97: the moment that's on (or next) and tonight's board
  publicCountAll(room);
}

// ---------------------------------------------------------------- Round 97: live mode - a lighter relay
//
// Batches: a game that reads them (cap 1) gets its lines joined with '\n' into one frame, at most BATCH_MS after the first
// one waits (or at once past BATCH_MAX characters). A line sent straight away (send) first sends what was waiting, so the
// order of lines never changes. Voice and the open mic never wait.

const metrics = {
  startedAt: Date.now(), msgsIn: 0, linesOut: 0, framesOut: 0, bytesOut: 0, batched: 0, stepsThinned: 0, voice: 0,
  limited: 0, lxRouted: 0, lxBlocked: 0, resumes: 0, held: 0, moments: 0, idleClosed: 0
};
let metricsLast = null;                 // the last full minute's counts (GET /metrics)
let metricsMark = Object.assign({}, metrics);
const outPending = new Set();
let outTimer = null;

/** One line to one player: batched for a game that reads batches, else sent at once. */
function queueLine(ws, line) {
  if (!ws || ws.readyState !== 1) return;
  if (!(ws.cap & CAP_BATCH)) { send(ws, line); return; }
  if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }   // (as send: far behind is let go, never queued without end)
  if (!ws.outbox) { ws.outbox = []; ws.outBytes = 0; }
  ws.outbox.push(line);
  ws.outBytes += line.length;
  metrics.linesOut++;
  if (ws.outBytes >= BATCH_MAX) { flushOut(ws); return; }
  outPending.add(ws);
  if (!outTimer) outTimer = setTimeout(flushAllOut, BATCH_MS);
}

function flushOut(ws) {
  outPending.delete(ws);
  const box = ws.outbox;
  if (!box || box.length === 0) return;
  ws.outbox = [];
  ws.outBytes = 0;
  if (ws.readyState !== 1) return;
  const text = box.length === 1 ? box[0] : BATCH_MARK + '\n' + box.join('\n');   // (review: marked, so only these are split)
  metrics.batched += box.length - 1;
  metrics.framesOut++;
  metrics.bytesOut += text.length;
  ws.send(text);
}

function flushAllOut() {
  outTimer = null;
  for (const ws of Array.from(outPending)) flushOut(ws);
}

// ---------------------------------------------------------------- Round 97: players' own lines to the relay

/** Who a player is for blocks and the board: their live account (or, without one, their name). */
function blockKey(ws) {
  return ws && ws.pubAccount ? 'a:' + ws.pubAccount : 'n:' + String((ws && ws.pname) || '').toLowerCase();
}

/** A token bucket on the socket: rate a second, bursts up to burst. */
function bucket(ws, field, rate, burst) {
  const now = Date.now();
  const at = field + 'At';
  if (ws[field] === undefined) { ws[field] = burst; ws[at] = now; }
  ws[field] = Math.min(burst, ws[field] + (now - ws[at]) * rate / 1000);
  ws[at] = now;
  if (ws[field] < 1) return false;
  ws[field] -= 1;
  return true;
}

/** {"relay":...} from a player (lead or guest) that's for the relay itself. */
function publicControl(room, ws, packet) {
  switch (packet.relay) {
    case 'bye':
      // Leaving on purpose: gone at once (no kept place, no waiting for the socket to close).
      publicDrop(room, ws);
      try { ws.close(1000, 'left'); } catch { /* gone already */ }
      return;
    case 'block':
      publicBlock(room, ws, Number(packet.g), packet.on !== false);
      return;
    case 'lv':
      if (bucket(ws, 'lvTokens', LV_RATE, LV_BURST)) liveCheckIn(room, ws, Number(packet.id));
      else metrics.limited++;
      return;
    default:
      return;   // "alive" (a phone going into the background) and anything newer: it already counted as hearing from them
  }
}

/** A player blocks (or unblocks) another: nothing of theirs reaches them - interactions, social moments, voice. */
function publicBlock(room, ws, g, on) {
  if (!Number.isInteger(g) || g < 0) return;
  const target = g === 0 ? room.host : room.guests.get(g);
  if (!target || target === ws) return;
  if (!ws.blocks) ws.blocks = new Set();
  const key = blockKey(target);
  if (!on) ws.blocks.delete(key);
  else if (ws.blocks.size < MAX_BLOCKS) ws.blocks.add(key);
}

/** Are two players within this many metres (by their last steps)? Not known yet: yes. */
function nearEachOther(a, b, metres) {
  if (a.px === undefined || b.px === undefined) return true;
  const dx = a.px - b.px, dz = a.pz - b.pz;
  return dx * dx + dz * dz <= metres * metres;
}

/**
 * An interaction line ("lx": "<op>|<kind>|<nonce>[|args]", target = who it's for). To its target only - never to anyone
 * who blocked the sender - or, for a group line (join / leave a dance circle, a group photo: target -1), to the players
 * near the sender. Offers are held to a gap, a range and a few per person; when an offer is answered yes, both players
 * earn tonight's points (once per pair and kind every few minutes).
 */
function publicLx(room, ws, id, p, raw) {
  const m = LX_RE.exec(typeof p.text === 'string' ? p.text : '');
  if (!m || !LX_KINDS.has(m[2])) return;
  if (!bucket(ws, 'lxTokens', LX_RATE, LX_BURST)) { metrics.limited++; return; }
  const op = m[1], kind = m[2], nonce = m[3];
  const now = Date.now();
  const target = Number.isInteger(p.target) ? p.target : -1;
  p.from = id;
  p.name = ws.pname;
  const line = JSON.stringify(p);
  const myKey = blockKey(ws);
  if (target < 0) {
    if (op !== 'j' && op !== 'l' && op !== 'p') return;
    // Round 97 (review): group lines have their own cooldown per player (a photo call every 10 s, a dance beacon every 3 s).
    if (!ws.lxGroupAt) ws.lxGroupAt = {};
    if (now - (ws.lxGroupAt[op] || 0) < LX_GROUP_GAP[op]) { metrics.limited++; return; }
    ws.lxGroupAt[op] = now;
    publicEach(room, other => {
      if (other === ws || other.readyState !== 1 || other.pubGone || !nearEachOther(ws, other, LX_GROUP_RANGE)) return;
      if (other.blocks && other.blocks.has(myKey)) return;
      lxDeliver(room, other, id, raw, line);
    });
    return;
  }
  if (target === id) return;
  const to = target === 0 ? room.host : room.guests.get(target);
  if (!to || to === ws || to.readyState !== 1 || to.pubGone) return;
  if (to.blocks && to.blocks.has(myKey)) { metrics.lxBlocked++; return; }   // silently: they never hear from you
  if (op === 'o') {
    if (now - (ws.lxOfferAt || 0) < LX_OFFER_GAP) { metrics.limited++; return; }
    if (!nearEachOther(ws, to, (LX_RANGE[kind] || 15) + 6)) return;   // (+6: steps can be a moment old)
    if (!ws.lxPer) ws.lxPer = new Map();
    const per = (ws.lxPer.get(to.pubSerial) || []).filter(t => now - t < LX_PAIR_WINDOW);
    if (per.length >= LX_PAIR_MAX) { metrics.limited++; return; }
    per.push(now);
    ws.lxPer.set(to.pubSerial, per);
    if (ws.lxPer.size > 64) ws.lxPer.delete(ws.lxPer.keys().next().value);
    ws.lxOfferAt = now;
    if (!ws.lxOffers) ws.lxOffers = new Map();
    ws.lxOffers.set(to.pubSerial + ':' + kind + ':' + nonce, now);
    if (ws.lxOffers.size > 32) ws.lxOffers.delete(ws.lxOffers.keys().next().value);
  } else if (op === 'y' && to.lxOffers) {
    const okey = ws.pubSerial + ':' + kind + ':' + nonce;
    const offered = to.lxOffers.get(okey);
    if (offered && now - offered < 30000) {
      to.lxOffers.delete(okey);
      liveCredit(room, ws, to, kind, now);
    }
  }
  lxDeliver(room, to, id, raw, line);
  metrics.lxRouted++;
}

/** The lead's game reads a guest's line wrapped, like every guest line; everyone else gets it stamped. */
function lxDeliver(room, to, id, raw, line) {
  if (to === room.host) { if (id !== 0) sendToHost(room, JSON.stringify({ relay: 'msg', g: id, m: raw })); }
  else queueLine(to, line);
}

/** Both players of an answered interaction earn tonight's points (the same pair and kind once every few minutes). */
function liveCredit(room, a, b, kind, now) {
  const pts = LX_POINTS[kind] || 0;
  if (pts <= 0) return;
  if (!room.lxPairs) room.lxPairs = new Map();
  const pair = Math.min(a.pubSerial, b.pubSerial) + '-' + Math.max(a.pubSerial, b.pubSerial) + ':' + kind;
  if (now - (room.lxPairs.get(pair) || 0) < LX_PAIR_COOLDOWN) return;
  room.lxPairs.set(pair, now);
  const why = { hf: 'High five', hug: 'Hug', wv: 'Wave', dn: 'Danced together', kd: 'Kandi trade', gm: 'Played together', ph: 'Group photo' }[kind] || 'Live';
  addPoints(a, pts, why);
  addPoints(b, pts, why);
}

// ---------------------------------------------------------------- Round 97: smooth reconnects

/** A public player's socket closed. A game that can resume (cap 4) and dropped without a goodbye keeps its place a moment. */
function publicClosed(room, ws, code) {
  if (ws.pubLeft) return;
  if ((ws.cap & CAP_RESUME) && ws.pubAccount && code === 1006 && !stopping && RESUME_GRACE_MS > 0 && room.host !== ws && ws.pubId > 0 && room.guests.get(ws.pubId) === ws) {
    ws.pubHeldUntil = Date.now() + RESUME_GRACE_MS;   // the sweep lets it go after that (everyone else just sees them stand still)
    flushOut(ws);   // (drops what was waiting: nobody to send it to)
    metrics.held++;
    return;
  }
  publicDrop(room, ws);
}

/** The same account is back: it takes over its old number, name, role and figure (nobody saw it leave). Returns the id. */
function publicResume(room, old, ws) {
  const id = old.pubId;
  old.pubLeft = true;   // its own close now does nothing
  old.pubGone = true;
  if (old.readyState === 1) {
    // Silent but open (a phone that lost its signal, or the game that's now back on another device): that one stops for good.
    send(old, JSON.stringify({ t: 'bye', from: 0, ch: 'relay', text: 'You joined the Open Festival from another device.' }));
    try { old.close(4001, 'replaced'); } catch { /* gone already */ }
  }
  room.guests.set(id, ws);
  ws.pname = old.pname;
  ws.role = old.role || 'goer';
  ws.pubSerial = old.pubSerial;
  ws.px = old.px;
  ws.pz = old.pz;
  ws.lvl = old.lvl;
  ws.blocks = old.blocks;
  ws.lxOffers = old.lxOffers;
  metrics.resumes++;
  return id;
}

// ---------------------------------------------------------------- Round 97: shared festival moments and tonight's board
//
// One moment at a time, run by this server's clock, for everyone in the Open Festival (games with cap 2):
//   next  {"relay":"live","k":"next","id":7,"kind":"crowd","role":"","spot":"stage","at":<ms>,"dur":90,"goal":5,"n":0,"now":<ms>}
//   go    the same, when it starts ("ends": <ms>)
//   prog  {"relay":"live","k":"prog","id":7,"n":3,"goal":5,...} (when the count changes, at most twice a second, and every 3 s)
//   done  {"relay":"live","k":"done","id":7,"ok":true,"n":5,...}
// kinds: crowd (N people dancing at the main stage), drop (THE DROP at the main stage - be there), fireworks (look up),
// crew (a job for the staff roles together: "role" medic / security / crew; spot medic / gate / stage).
// A game checks in with {"relay":"lv","id":7} about once a second while its player is taking part (it decides that: dancing
// at the stage, there for the drop, a staff role at the spot). The relay counts check-ins of the last LIVE_CHECKIN_MS.
// Points (tonight's board, reset each festival day): taking part 4, a moment won 10, answered interactions (see LX_POINTS).

// (LIVE_KINDS can change the order, e.g. "drop,crowd" - only these four are known.)
const MOMENT_KINDS = (() => {
  const known = ['crowd', 'drop', 'crew', 'fireworks'];
  const wanted = String(process.env.LIVE_KINDS || '').split(',').map(k => k.trim()).filter(k => known.includes(k));
  return wanted.length ? wanted : known;
})();
const MOMENT_SECONDS = { crowd: 90, drop: 30, crew: 90, fireworks: 40 };
const live = { id: 0, seq: 0, cur: null, next: null, planAt: 0, board: new Map(), boardDay: -1, boardVer: 0, boardSentVer: -1, boardSentAt: 0 };

function publicDay(now) {
  return Math.floor((now - PUBLIC_EPOCH) / (PUBLIC_DAY_SECONDS * 1000));
}

function liveLine(k, mo, extra) {
  return JSON.stringify(Object.assign({ relay: 'live', k, id: mo.id, kind: mo.kind, role: mo.role, spot: mo.spot, at: mo.at, ends: mo.ends || 0, dur: mo.dur, goal: mo.goal, n: mo.n, now: Date.now() }, extra || {}));
}

function liveAll(room, line) {
  publicEach(room, ws => { if ((ws.cap & CAP_LIVE) && !ws.pubGone) queueLine(ws, line); });
}

/** A newcomer (cap 2): the moment that's on or coming, and tonight's board. */
function liveWelcome(room, ws) {
  if (live.cur) queueLine(ws, liveLine('go', live.cur));
  else if (live.next) queueLine(ws, liveLine('next', live.next));
  queueLine(ws, boardLine(boardTop(), ws));
}

/** The staff role most players here are playing (medic, security, crew), or null. */
function busiestStaffRole(room) {
  const counts = { medic: 0, security: 0, crew: 0 };
  publicEach(room, ws => { if (!ws.pubGone && counts[ws.role] !== undefined) counts[ws.role]++; });
  let best = null;
  for (const role of Object.keys(counts)) if (counts[role] > 0 && (!best || counts[role] > best.count)) best = { role, count: counts[role] };
  return best;
}

function planMoment(room, now) {
  const players = publicPlayers(room);
  let kind = MOMENT_KINDS[live.seq++ % MOMENT_KINDS.length];
  let role = '', spot = 'stage', goal = 0;
  if (kind === 'crew') {
    const staff = busiestStaffRole(room);
    if (staff) {
      role = staff.role;
      spot = role === 'medic' ? 'medic' : role === 'security' ? 'gate' : 'stage';
      goal = Math.min(2, staff.count);   // two together when there are two (one on their own can still do it)
    } else {
      kind = 'crowd';   // no staff here: a crowd challenge instead
    }
  }
  if (kind === 'crowd') goal = Math.max(1, Math.min(10, Math.ceil(players * 0.5)));
  live.next = { id: ++live.id, kind, role, spot, at: now + LIVE_LEAD_IN_MS, ends: 0, dur: MOMENT_SECONDS[kind], goal, n: 0, ins: new Map(), progAt: 0 };
  liveAll(room, liveLine('next', live.next));
}

function startMoment(room, now) {
  live.cur = live.next;
  live.next = null;
  live.cur.ends = now + live.cur.dur * 1000;
  metrics.moments++;
  liveAll(room, liveLine('go', live.cur));
}

function finishMoment(room, mo, ok, now) {
  const show = mo.kind === 'drop' || mo.kind === 'fireworks';
  publicEach(room, ws => {
    if (ws.pubGone) return;
    const t = mo.ins.get(ws.pubSerial);
    if (t === undefined) return;
    // A show: everyone who was there for it. A challenge: everyone still in it at the end (a win pays more).
    if (show) addPoints(ws, 4, momentWord(mo));
    else if (now - t <= LIVE_CHECKIN_MS + 1500) addPoints(ws, ok ? 10 : 4, ok ? momentWord(mo) : 'Took part');
  });
  liveAll(room, liveLine('done', mo, { ok }));
  live.cur = null;
  live.planAt = now + LIVE_GAP_MS;
}

function momentWord(mo) {
  return mo.kind === 'crowd' ? 'Crowd challenge' : mo.kind === 'crew' ? 'Crew call' : mo.kind === 'drop' ? 'The drop' : 'Fireworks';
}

/** A game says its player is taking part in moment id right now. */
function liveCheckIn(room, ws, id) {
  const mo = live.cur;
  if (!mo || mo.id !== id || ws.pubGone) return;
  if (mo.kind === 'crew' && ws.role !== mo.role) return;   // the crew call is for that role
  mo.ins.set(ws.pubSerial, Date.now());
}

function liveTick(now) {
  const room = publicRoom;
  if (publicPlayers(room) === 0) {
    live.cur = null;
    live.next = null;
    live.planAt = 0;
    live.seq = 0;   // the first moment anyone sees is the crowd challenge
    if (room.lxPairs) room.lxPairs.clear();
    return;
  }
  if (!live.planAt) live.planAt = now + LIVE_FIRST_MS;
  if (!live.cur && !live.next && now >= live.planAt) planMoment(room, now);
  if (live.next && now >= live.next.at) startMoment(room, now);
  const mo = live.cur;
  if (mo) {
    let n = 0;
    for (const [serial, t] of mo.ins) { if (now - t <= LIVE_CHECKIN_MS) n++; else if (now - t > 60000) mo.ins.delete(serial); }
    const challenge = mo.kind === 'crowd' || mo.kind === 'crew';
    if (n !== mo.n || now - mo.progAt >= 3000) {
      if (n !== mo.n || challenge) { mo.n = n; mo.progAt = now; liveAll(room, liveLine('prog', mo)); }
    }
    if (challenge && mo.goal > 0 && n >= mo.goal) finishMoment(room, mo, true, now);
    else if (now >= mo.ends) finishMoment(room, mo, !challenge && mo.ins.size > 0, now);
  }
  boardTick(room, now);
  if (room.lxPairs && room.lxPairs.size > 2000) {
    for (const [pair, t] of room.lxPairs) if (now - t >= LX_PAIR_COOLDOWN) room.lxPairs.delete(pair);
  }
}

/** Tonight's points for a player (and a "+2 High five" back to them). */
function addPoints(ws, pts, why) {
  if (!ws || pts <= 0) return;
  const now = Date.now();
  const day = publicDay(now);
  if (day !== live.boardDay) { live.board.clear(); live.boardDay = day; }
  const key = blockKey(ws);
  const entry = live.board.get(key) || { n: ws.pname, r: ws.role || 'goer', p: 0 };
  entry.p += pts;
  entry.n = ws.pname;
  entry.r = ws.role || 'goer';
  live.board.set(key, entry);
  if (live.board.size > BOARD_MAX) {
    let lowKey = null, low = Infinity;
    for (const [k, e] of live.board) if (e.p < low && k !== key) { low = e.p; lowKey = k; }
    if (lowKey) live.board.delete(lowKey);
  }
  live.boardVer++;
  if (ws.cap & CAP_LIVE) queueLine(ws, JSON.stringify({ relay: 'live', k: 'pts', p: entry.p, add: pts, why: clip(why, 24) }));
}

function boardTop() {
  return Array.from(live.board.entries()).sort((a, b) => b[1].p - a[1].p);
}

function boardLine(sorted, ws) {
  const key = blockKey(ws);
  let rank = 0, me = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i][0] === key) { rank = i + 1; me = sorted[i][1].p; break; }
  const top = sorted.slice(0, BOARD_TOP).map(([, e]) => ({ n: e.n, p: e.p, r: e.r }));
  return JSON.stringify({ relay: 'live', k: 'board', top, me, rank, of: sorted.length, day: live.boardDay });
}

function boardTick(room, now) {
  if (live.boardVer === live.boardSentVer || now - live.boardSentAt < BOARD_EVERY) return;
  live.boardSentVer = live.boardVer;
  live.boardSentAt = now;
  const sorted = boardTop();
  publicEach(room, ws => { if ((ws.cap & CAP_LIVE) && !ws.pubGone) queueLine(ws, boardLine(sorted, ws)); });
}

setInterval(() => {
  try { liveTick(Date.now()); } catch (err) { console.error('live', err && err.message); }
}, 1000).unref();

// ---------------------------------------------------------------- Round 97: health

/** GET /metrics: how the server is doing (no names, no addresses). */
function metricsInfo(req, res) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (!publicAskAllowed(req)) { res.writeHead(429, headers); res.end('{"ok":false}'); return; }
  const mem = process.memoryUsage();
  let roomCount = 0, roomPlayers = 0, held = 0;
  for (const room of rooms.values()) {
    if (room === publicRoom) continue;
    roomCount++;
    roomPlayers += room.guests.size + (room.host ? 1 : 0);
  }
  for (const ws of publicRoom.guests.values()) if (ws.pubHeldUntil && !ws.pubLeft) held++;
  res.writeHead(200, headers);
  res.end(JSON.stringify({
    ok: true,
    uptimeS: Math.round(process.uptime()),
    memoryMB: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
    rooms: roomCount, roomPlayers,
    public: { players: publicPlayers(publicRoom), capacity: PUBLIC_CAPACITY, held, moment: live.cur ? live.cur.kind : '', next: live.next ? live.next.kind : '', board: live.board.size },
    sockets: wss.clients.size,
    lastMinute: metricsLast,
    total: Object.assign({}, metrics, { startedAt: undefined }),
  }));
}

setInterval(() => {
  const now = Object.assign({}, metrics);
  const out = {};
  for (const k of Object.keys(now)) if (k !== 'startedAt') out[k] = now[k] - (metricsMark[k] || 0);
  metricsLast = out;
  metricsMark = now;
}, 60000).unref();

/** GET /public: the head count, the clock and who plays which role (for the "join" screen). */
const publicHits = new Map();           // ip -> recent /public and /schedule asks
function publicInfo(req, res) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (!publicAskAllowed(req)) { res.writeHead(429, headers); res.end('{"ok":false}'); return; }
  const counts = PUBLIC_ROLES.map(() => 0);
  publicEach(publicRoom, ws => { const i = PUBLIC_ROLES.indexOf(ws.role); counts[i >= 0 ? i : 0]++; });
  res.writeHead(200, headers);
  res.end(JSON.stringify(Object.assign({ players: publicPlayers(publicRoom), capacity: PUBLIC_CAPACITY }, publicClock(Date.now()), { roleIds: PUBLIC_ROLES, roleCounts: counts })));
}

/** GET /schedule?target=event:public: the DJ set times for the next 24 hours (from the patch bay). */
function publicSchedule(req, res) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (!publicAskAllowed(req)) { res.writeHead(429, headers); res.end('{"ok":false}'); return; }
  const url = new URL(req.url, 'http://relay');
  const target = String(url.searchParams.get('target') || PUBLIC_TARGET);
  const now = Date.now();
  let slots = [];
  // Only events' schedules are public (a private room's isn't anybody else's business).
  if (target.startsWith('event:')) {
    try { slots = patchbay.scheduleFor(target, now, 24 * 3600000); } catch (err) { console.error('schedule', err && err.message); slots = []; }
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify({ now, slots }));
}

function publicAskAllowed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (publicHits.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= 60) { publicHits.set(ip, hits); return false; }
  hits.push(now);
  publicHits.set(ip, hits);
  if (publicHits.size > 5000) publicHits.clear();
  return true;
}

// The head count and the clock now and then; a lead that has gone silent (a frozen game, a phone put away, a dead
// connection the pings haven't caught yet) or is far behind is let go, so the next player takes over within seconds.
setInterval(() => {
  const now = Date.now();
  const lead = publicRoom.host;
  if (lead && publicRoom.guests.size > 0 && now - (lead.leadSince || 0) >= PUBLIC_LEAD_GRACE &&   // Round 66 (review): not while it's still settling in
      (now - (lead.lastMsgAt || 0) > PUBLIC_LEAD_SILENT_MS || lead.bufferedAmount > MAX_BUFFERED / 2)) {
    publicDrop(publicRoom, lead);   // the next lead takes over now
    lead.terminate();
  }
  // Round 93: a guest gone quiet (a dropped phone signal the pings haven't caught) is let go, so their figure, seat and
  // holds free up for everyone in seconds rather than a minute. A game coming back reconnects by itself.
  for (const guest of Array.from(publicRoom.guests.values())) {
    // Round 97: a place kept for a dropped connection that didn't come back in time goes now.
    if (guest.pubHeldUntil && !guest.pubLeft && now >= guest.pubHeldUntil) { publicDrop(publicRoom, guest); continue; }
    if (now - (guest.joinedAt || 0) < PUBLIC_LEAD_GRACE || now - (guest.lastMsgAt || 0) <= PUBLIC_GUEST_SILENT_MS) continue;
    publicDrop(publicRoom, guest);
    try { guest.terminate(); } catch { /* gone already */ }
  }
}, 2000).unref();
setInterval(() => {
  publicCountAll(publicRoom);
  const now = Date.now();
  for (const [ip, until] of publicBans) if (until <= now) publicBans.delete(ip);
  for (const [ip, times] of publicHits) if (!times.some(t => now - t < 60000)) publicHits.delete(ip);
}, PUBLIC_COUNT_EVERY).unref();

// A listing the host stopped updating drops off (the room itself stays open for its players).
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) if (room.meta && now - room.metaAt >= META_TTL) room.meta = null;
  for (const [ip, times] of listHits) if (!times.some(t => now - t < 60000)) listHits.delete(ip);
  // Round 57: these never grow without end either.
  for (const [ip, times] of joinFails) if (!times.some(t => now - t < 60000)) joinFails.delete(ip);
  for (const [ip, until] of joinLocks) if (until <= now) joinLocks.delete(ip);   // Round 65
  for (const [ip, times] of hostTries) if (!times.some(t => now - t < 600000)) hostTries.delete(ip);
  hostTriesAll = hostTriesAll.filter(t => now - t < 600000);
  for (const [ip, times] of worldFails) if (!times.some(t => now - t < 600000)) worldFails.delete(ip);   // Round 63
  // Round 97: a room whose host has gone silent (a frozen game still answers the pings) with nobody in it is closed.
  for (const room of rooms.values()) {
    if (room.isPublic || room.guests.size > 0 || !room.host || now - (room.lastAt || now) < IDLE_HOST_MS) continue;
    metrics.idleClosed++;
    send(room.host, JSON.stringify({ t: 'bye', from: 0, text: 'Your online room closed after a long time with no one in it. Host again any time.' }));
    try { room.host.close(1000, 'idle'); } catch { /* its close handler tidies the room */ }
  }
  // Round 58: Big Nights that are over (their time is up, or the pass was refunded or ended by the admin).
  for (const room of rooms.values()) {
    if (!room.big) continue;
    let until = room.big.until;
    if (!room.big.free) {
      try { until = Math.min(until, store.bigNightUntil(room.big.passId, room.big.account)); } catch { /* keep the time we had */ }
    }
    if (until <= now) {
      endBigNight(room, until < room.big.until - 60000
        ? 'Your Big Night was ended (the pass was refunded or stopped). The room carries on as a normal room - nobody was removed.'
        : 'Your Big Night\'s time is up - thanks for hosting! The room carries on as a normal room: everyone inside can stay, and new people can join when there\'s space.');
    } else if (until < room.big.until) {
      room.big.until = until;
    }
  }
}, SWEEP_EVERY).unref();

process.on('unhandledRejection', err => console.error('unhandled', err && err.message));

const server = http.createServer((req, res) => {
  try {
    handleHttp(req, res);
  } catch (err) {
    console.error('http', err && err.message);
    if (!res.headersSent) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('Bad request\n'); }
  }
});

function handleHttp(req, res) {
  if (req.url && payments.handle(req, res)) return;
  if (req.url && leaderboards.handle(req, res)) return;   // Round 55
  if (req.url && worlds.handle(req, res)) return;         // Round 63: saved worlds (/worlds/...)
  if (req.url && applications.handle(req, res)) return;   // Round 67: artist applications (/apply, /apply/status, /admin/applications)
  if (req.url && sellers.handle(req, res)) return;        // Round 85: real shops (/sellers/apply, /sellers/mine, /sellers/checkout, /sellers/listings, /admin/sellers)
  if (req.url && analytics.handle(req, res)) return;      // Round 71: play stats (/stats/start, /stats/beat, /stats/events, /admin/stats)
  if (req.url && players.handle(req, res)) return;        // Round 74: live sign-up (/players/signup, /players/signin, /players/me, /admin/players)
  // Round 33: the Vendor Village list. Edit vendors.json (on GitHub) and the game picks it up.
  if (req.url && req.url.split('?')[0] === '/vendors.json') {
    fs.readFile(VENDORS_FILE, 'utf8', (err, text) => {
      if (err || text.length > 512 * 1024) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"version":1,"vendors":[]}');
        return;
      }
      try { JSON.parse(text); } catch {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('vendors.json has a typo - paste it into jsonlint.com to find it.');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=300', 'access-control-allow-origin': '*' });
      res.end(patchbay.mergeIntoFeed(community.mergeIntoFeed(text)));   // plus the players' creations you approved. Round 60: + the patch bay's live events
    });
    return;
  }
  // Round 45: a player sending in their own creation (it waits for you on the admin page).
  if (req.url && req.url.split('?')[0] === '/creations/submit') {
    const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    community.submit(req, res, forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || ''));
    return;
  }
  // Round 66: the public festival - a cheap "I'm alive" for an uptime pinger, its head count and clock, its DJ times.
  const pathOnly = req.url ? req.url.split('?')[0] : '';
  if (pathOnly === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('ok');
    return;
  }
  if (pathOnly === '/public') {
    publicInfo(req, res);
    return;
  }
  if (pathOnly === '/schedule') {
    publicSchedule(req, res);
    return;
  }
  if (pathOnly === '/metrics') {
    metricsInfo(req, res);   // Round 97: health
    return;
  }
  // Round 54: the Festivals list - every listed room and open live event.
  if (req.url && req.url.split('?')[0] === '/rooms') {
    listRooms(req, res);
    return;
  }
  // Round 50: which live events are on right now (the game shows LIVE NOW).
  if (req.url && req.url.split('?')[0] === '/events/status') {
    const live = payments.features().liveEvents ? Array.from(eventRooms.keys()) : [];
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ live }));
    return;
  }
  // Round 42: ticket codes for artists' venues (kept secret - see README).
  if (req.url && req.url.startsWith('/ticket/check')) {
    const url = new URL(req.url, 'http://relay');
    const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    const ip = forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');   // the hop our host's proxy added
    const now = Date.now();
    const hits = (ticketHits.get(ip) || []).filter(t => now - t < 60000);
    hits.push(now);
    ticketHits.set(ip, hits);
    globalHits = globalHits.filter(t => now - t < 60000);   // failed tries only, across everyone
    const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
    if (hits.length > 20 || globalHits.length > 600) { reply({ ok: false, message: 'Too many tries - wait a minute and try again.' }); return; }
    const on = payments.features();
    if (!on.artistVenues) { reply({ ok: false, message: "Artists' venues aren't switched on." }); return; }
    const venue = cleanId(url.searchParams.get('venue'));
    const code = (url.searchParams.get('code') || '').trim().toUpperCase().slice(0, 40);
    const device = (url.searchParams.get('device') || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || ip;
    const tickets = loadTickets();
    const list = Array.isArray(tickets[venue]) ? tickets[venue].map(c => String(c).trim().toUpperCase()) : [];
    // A code you listed by hand, or one the ticket shop made (it checks its own signature).
    const valid = code && (list.includes(code) || (on.ticketSales && payments.verifyCode(venue, code)));
    if (!valid) { globalHits.push(now); reply({ ok: false, message: "That code isn't valid for this venue." }); return; }
    // Each code opens the door on up to 2 devices (say a phone and a computer); the same device can come back any time.
    const key = venue + '|' + code;
    const devices = ticketUses[key] || [];
    if (!devices.includes(device)) {
      if (devices.length >= 2) { reply({ ok: false, message: 'This ticket is already in use on two devices.' }); return; }
      devices.push(device);
      ticketUses[key] = devices;
      saveUses();
    }
    reply({ ok: true });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`Festival Tycoon relay is running. Rooms open: ${rooms.size}\n`);
}

// Round 97: RELAY_DEFLATE=1 compresses big messages for games that ask (web browsers do) - off unless set (it costs memory).
const wss = new WebSocketServer({
  server, maxPayload: MAX_MESSAGE,
  perMessageDeflate: process.env.RELAY_DEFLATE === '1'
    ? { threshold: 1024, zlibDeflateOptions: { level: 3, memLevel: 6 }, serverMaxWindowBits: 12, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 4 }
    : false
});

// Round 71: the play-stats dashboard shows who's online in the relay right now.
analytics.attach({
  live: () => {
    let roomCount = 0, roomPlayers = 0;
    for (const room of rooms.values()) {
      if (room === publicRoom) continue;
      roomCount++;
      roomPlayers += room.guests.size + (room.host ? 1 : 0);
    }
    return { rooms: roomCount, roomPlayers, publicPlayers: publicPlayers(publicRoom), publicCapacity: PUBLIC_CAPACITY, sockets: wss.clients.size };
  }
});

function send(ws, text) {
  if (!ws || ws.readyState !== 1) return;
  if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }
  if (ws.outbox && ws.outbox.length) flushOut(ws);   // Round 97: what was batched for them goes first (lines keep their order)
  ws.send(text);
  metrics.linesOut++; metrics.framesOut++; metrics.bytesOut += text.length;
}

wss.on('connection', (ws, req) => {
  ws.on('error', err => console.error('ws', err && err.message));   // a bad frame closes that socket, never the server
  let url;
  try { url = new URL(req.url, 'http://relay'); } catch { ws.close(1008, 'bad address'); return; }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Round 57: how many connections this address has open (a brake on one computer opening hundreds).
  const ip = clientIp(req);
  ws.ip = ip;
  const open = (socketsByIp.get(ip) || 0) + 1;
  socketsByIp.set(ip, open);
  ws.on('close', () => {
    const left = (socketsByIp.get(ip) || 1) - 1;
    if (left <= 0) socketsByIp.delete(ip); else socketsByIp.set(ip, left);
  });
  if (open > MAX_SOCKETS_PER_IP) {
    send(ws, JSON.stringify({ t: 'bye', from: 0, text: 'Too many connections from your network right now - try again in a minute.' }));
    ws.close(1013, 'Too many connections from your network - try again in a minute.');
    return;
  }

  if (url.pathname === '/host') {
    // Round 109: a live account first (see liveAccountFor).
    const live = liveAccountFor(url);
    if (!live.ok) { refuseForAccount(ws, live.text); return; }
    ws.account = live.account;
    // Round 50: opening a live event needs the organiser's password, the switch on, and the event listed.
    const eventId = url.searchParams.has('event') ? cleanId(url.searchParams.get('event')) : '';
    if (eventId) {
      const refuse = (text) => { send(ws, JSON.stringify({ t: 'bye', from: 0, text })); ws.close(1008, text.slice(0, 100)); };
      if (!payments.features().liveEvents) { refuse('Live events are switched off in vendors.json.'); return; }
      if (!payments.findEvent(eventId)) { refuse('That event is not in vendors.json.'); return; }
      const ip = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean).pop() || (req.socket.remoteAddress || '');
      const now = Date.now();
      const tries = (hostTries.get(ip) || []).filter(t => now - t < 600000);
      hostTriesAll = hostTriesAll.filter(t => now - t < 600000);
      if (tries.length >= 5 || hostTriesAll.length >= 50) { refuse('Too many wrong passwords - wait ten minutes.'); return; }
      if (!eventKeyOk(url.searchParams.get('key'))) {
        tries.push(now);
        hostTries.set(ip, tries);
        hostTriesAll.push(now);
        refuse(process.env.EVENT_HOST_KEY ? 'Wrong event password.' : 'Set EVENT_HOST_KEY on the server first (see README).');
        return;
      }
      if (eventRooms.has(eventId)) { refuse('That event is already open (close the other game first).'); return; }
    }
    // Round 63: opening a saved world - only its owner (or a friend they allowed), and only one room per world.
    let opened = null;
    if (!eventId && url.searchParams.has('world')) {
      const refuse = (text) => { send(ws, JSON.stringify({ t: 'bye', from: 0, text })); ws.close(1008, text.slice(0, 100)); };
      const now = Date.now();
      const fails = (worldFails.get(ip) || []).filter(t => now - t < 600000);
      if (fails.length >= WORLD_FAILS_PER_10_MIN) { refuse('Too many tries - wait ten minutes.'); return; }
      const worldId = String(url.searchParams.get('world') || '').slice(0, 32);
      try {
        opened = worlds.openFor(worldId, String(url.searchParams.get('wkey') || '').slice(0, 80), ws.account || '');   // Round 109: + the live account
      } catch (err) {
        console.error('worlds open', err && err.message);
        opened = { ok: false, text: 'That world could not be opened just now - try again.' };
      }
      if (!opened || !opened.ok) {
        fails.push(now);
        worldFails.set(ip, fails);
        if (worldFails.size > 5000) worldFails.clear();
        refuse((opened && opened.text) || 'That world could not be opened.');
        return;
      }
      if (roomOfWorld(opened.meta.id)) { refuse('That world is already open - join it from Festivals.'); return; }
    }
    // Round 57: a few rooms per address at most.
    let mine = 0;
    for (const r of rooms.values()) if (r.ip === ip) mine++;
    if (mine >= MAX_ROOMS_PER_IP) { ws.close(1013, 'You already have several rooms open - close one first.'); return; }
    const code = rooms.size < MAX_ROOMS ? newCode() : null;
    if (!code) { ws.close(1013, 'The online server is full right now - try again in a few minutes.'); return; }
    const room = { host: ws, guests: new Map(), nextId: 1, event: eventId, meta: null, metaAt: 0, metaSentAt: 0, ip, banned: new Set(), noList: false, big: null, bigAskedAt: 0, mic: new Set(),
      world: opened ? opened.meta.id : '', peopleAt: 0 };   // Round 63: the saved world this room is ('' = an ordinary room)
    rooms.set(code, room);
    if (eventId) eventRooms.set(eventId, code);
    send(ws, JSON.stringify({ relay: 'room', code }));
    if (opened) sendWorld(ws, opened);   // Round 63: everything saved in the world, straight to its host
    patchbay.roomOpened(targetOf(code, room));   // Round 60: stages already patched for this event play straight away
    sendPatches(ws, code, room);

    room.lastAt = Date.now();   // Round 97: when the host last said anything (a silent host with nobody in is closed)
    ws.on('message', (data) => {
      room.lastAt = Date.now();
      metrics.msgsIn++;
      if (isVoice(data)) { relayVoice(room, 0, ws, data); return; }   // Round 54
      let packet;
      try { packet = JSON.parse(data.toString()); } catch { return; }
      if (!packet || typeof packet !== 'object') return;   // Round 54 review: "null" would throw below and take the whole server down
      if (typeof packet.meta === 'object' && packet.meta !== null) {
        // Round 54: the host's listing for the Festivals list ("listed": false takes it off at once).
        if (data.length > MAX_META) return;
        const now = Date.now();
        const unlisting = packet.meta.listed !== true && !!(room.meta && room.meta.listed);   // going private always works at once
        if (!unlisting && now - room.metaSentAt < META_MIN_GAP) return;   // too often: skip this one
        room.metaSentAt = now;
        room.meta = cleanMeta(packet.meta);
        if (room.noList) room.meta.listed = false;   // Round 57: taken off the list after reports
        room.metaAt = now;
        return;
      }
      if (typeof packet.kick === 'number') {
        // The host turned a guest away (e.g. a different game version): close them.
        // Round 57: "ban": true - the host removed them, so they can't come back into this room.
        const guest = room.guests.get(packet.kick);
        if (guest) {
          if (packet.ban === true && !room.event && guest.ip && room.banned.size < MAX_BANNED) room.banned.add(guest.ip);
          room.guests.delete(packet.kick);
          guest.close(1000, 'turned away');
        }
        return;
      }
      if (typeof packet.report === 'object' && packet.report !== null) {
        // Round 57: the host reports a guest.
        fileReport(code, room, 0, ws, Number(packet.report.g), Number(packet.report.reason) | 0, clip(packet.report.name, 18));
        return;
      }
      if (typeof packet.bignight === 'object' && packet.bignight !== null) {
        // Round 58: the host asks for a Big Night room.
        askBigNight(code, room, packet.bignight);
        return;
      }
      if (typeof packet.openmic === 'object' && packet.openmic !== null) {
        // Round 61: who holds an open mic in this room now.
        if (data.length <= 512) setMicHolders(room, packet.openmic.g);
        return;
      }
      if (typeof packet.wsave === 'object' && packet.wsave !== null && !Array.isArray(packet.wsave)) {
        // Round 63: the host saves one part of its saved world (nothing happens in an ordinary room).
        if (room.world && data.length <= MAX_WSAVE) hostWorldSave(room, packet.wsave);
        else if (room.world) send(ws, JSON.stringify({ relay: 'wsaved', s: clip(packet.wsave.s, 24), ok: false, text: 'That part of the world is too big to save.' }));
        return;
      }
      if (Array.isArray(packet.wpeople)) {
        // Round 63: who has played in this world (the host's game knows each player's public world tag).
        const now = Date.now();
        if (room.world && data.length <= 8192 && now - room.peopleAt >= 5000) {
          room.peopleAt = now;
          try { worlds.notePeople(room.world, packet.wpeople); } catch (err) { console.error('worlds people', err && err.message); }
        }
        return;
      }
      if (typeof packet.patch === 'object' && packet.patch !== null && !Array.isArray(packet.patch)) {
        // Round 60: the host patches a DJ's stream onto one of their stages (the patch bay's own patches win).
        if (data.length <= MAX_PATCH) hostPatch(code, room, packet.patch);
        return;
      }
      if (typeof packet.m !== 'string') return;
      if (packet.m.startsWith('{"relay"')) return;   // Round 60: only the server speaks as the server
      if (hasLineBreak(packet.m)) return;            // Round 97 (review): never two lines in one (see the public lead's rule)
      if (packet.m.startsWith('m:') && !MIC_LINE_RE.test(packet.m)) return;
      if (packet.m.startsWith('m:') && (packet.to === -1 || packet.to === undefined)) {
        // Round 61: an open-mic line from the host (its own mic, or a guest's it passed on): like voice, a listener
        // who is behind skips it rather than queueing it up.
        if (packet.m.length > MAX_VOICE + 16 || !micAllowed(ws)) return;
        for (const [gid, guest] of room.guests) {
          if (gid !== packet.except && guest.readyState === 1 && guest.bufferedAmount < VOICE_BACKLOG) guest.send(packet.m);
        }
        return;
      }
      if (Array.isArray(packet.to)) {
        // Round 58: to just some players (a big room sends each step only to the people near it).
        const seen = new Set();
        for (const id of packet.to.slice(0, MAX_TO_LIST)) {
          if (!Number.isInteger(id) || seen.has(id)) continue;
          seen.add(id);
          send(room.guests.get(id), packet.m);
        }
      } else if (packet.to === -1 || packet.to === undefined) {
        // Round 51: "except" - one guest's news to everyone else (the host sends it up once).
        for (const [gid, guest] of room.guests) if (gid !== packet.except) send(guest, packet.m);
      } else {
        send(room.guests.get(packet.to), packet.m);
      }
    });

    ws.on('close', () => {
      rooms.delete(code);
      if (room.event && eventRooms.get(room.event) === code) eventRooms.delete(room.event);
      patchbay.roomClosed(targetOf(code, room));   // Round 60
      if (room.world) { try { worlds.closed(room.world); } catch (err) { console.error('worlds close', err && err.message); } }   // Round 63
      const bye = JSON.stringify({ t: 'bye', from: 0, text: 'The host ended this festival (or lost their connection).' });   // Round 57: rooms are public now
      for (const guest of room.guests.values()) { send(guest, bye); guest.close(1000, 'room closed'); }
      room.guests.clear();
    });
    return;
  }

  if (url.pathname === '/join') {
    // Round 109: a live account first - before any code or ticket is looked at (see liveAccountFor).
    const live = liveAccountFor(url);
    if (!live.ok) { refuseForAccount(ws, live.text); return; }
    ws.account = live.account;
    let code = (url.searchParams.get('code') || '').toUpperCase().trim();
    let ticketKey = null;
    // Round 50: a fan joining a live event: find its room, and check their ticket.
    const eventId = url.searchParams.has('event') ? cleanId(url.searchParams.get('event')) : '';
    if (eventId) {
      const refuse = (text) => { send(ws, JSON.stringify({ t: 'bye', from: 0, text })); ws.close(1000, 'refused'); };
      const on = payments.features();
      const ev = payments.findEvent(eventId);
      if (!on.liveEvents || !ev) { refuse('That event is not on.'); return; }
      if (!eventRooms.has(eventId)) { refuse(`${ev.name} isn't live yet${ev.when ? ' - it starts ' + ev.when : ''}. Check back then!`); return; }
      if (!ev.free) {
        const ip = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean).pop() || (req.socket.remoteAddress || '');
        const now = Date.now();
        const hits = (ticketHits.get(ip) || []).filter(t => now - t < 60000);
        if (hits.length > 20) { refuse('Too many tries - wait a minute and try again.'); return; }
        const ticket = (url.searchParams.get('ticket') || '').trim().toUpperCase().slice(0, 40);
        const listed = loadTickets()[eventId];
        const list = Array.isArray(listed) ? listed.map(c => String(c).trim().toUpperCase()) : [];
        const valid = ticket && (list.includes(ticket) || (on.ticketSales && payments.verifyCode('event:' + eventId, ticket)));
        if (!valid) {
          hits.push(now);   // only wrong codes count towards the limit
          ticketHits.set(ip, hits);
          refuse("That ticket code isn't valid for this event.");
          return;
        }
        const inWith = ticketSockets.get('event|' + eventId + '|' + ticket) || 0;
        if (inWith >= 2) { refuse('Two people are already in with this ticket.'); return; }
        ticketKey = 'event|' + eventId + '|' + ticket;
        const device = (url.searchParams.get('device') || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || ip;
        const key = 'event|' + eventId + '|' + ticket;
        const devices = ticketUses[key] || [];
        if (!devices.includes(device)) {
          if (devices.length >= 2) { refuse('This ticket is already in use on two devices.'); return; }
          devices.push(device);
          ticketUses[key] = devices;
          saveUses();
        }
      }
      code = eventRooms.get(eventId);
    }
    if (!eventId) {
      // Round 57 review: the brake must also refuse the next tries - right code or not - while an address is over
      // the limit. Otherwise it only changed the wording, and trying every code still found rooms.
      // Round 65: a plain lock - JOIN_FAILS_PER_MINUTE wrong codes and the address gets nothing for JOIN_LOCK_MS.
      const now = Date.now();
      const lockedUntil = joinLocks.get(ip) || 0;
      if (lockedUntil > now) {
        send(ws, JSON.stringify({ t: 'bye', from: 0, text: 'Too many wrong codes - wait a minute and try again.' }));
        ws.close(1008, 'too many tries');
        return;
      }
    }
    const room = rooms.get(code);
    // Round 65: a code that doesn't open a room (none, or a live event's room - those are reached with a ticket, never
    // by code) gets the same answer either way, so trying codes finds nothing out; and it counts towards the lock.
    if (!room || (room.event && !eventId) || room.isPublic) {   // Round 66: the public festival is reached at /public only
      const now = Date.now();
      const fails = (joinFails.get(ip) || []).filter(t => now - t < 60000);
      fails.push(now);
      let text = `No festival with the code ${clip(code, 8)} right now - it may have ended. Check the code with your friend.`;
      if (fails.length >= JOIN_FAILS_PER_MINUTE) {
        joinLocks.set(ip, now + JOIN_LOCK_MS);
        joinFails.delete(ip);
        if (joinLocks.size > 20000) joinLocks.clear();
        text = 'Too many wrong codes - wait a minute and try again.';
      } else {
        joinFails.set(ip, fails);
        if (joinFails.size > 20000) joinFails.clear();
      }
      send(ws, JSON.stringify({ t: 'bye', from: 0, text }));
      ws.close(1000, 'no such room');
      return;
    }
    if (room.banned.has(ip)) {
      // Round 57: the host (or reports) removed this player from this room.
      send(ws, JSON.stringify({ t: 'bye', from: 0, text: "You were removed from this festival, so you can't rejoin it. Find another one under Festivals!" }));
      ws.close(1000, 'removed');
      return;
    }
    if (room.guests.size >= guestCap(room)) {   // Round 58: Big Night rooms hold more
      send(ws, JSON.stringify({ t: 'bye', from: 0, text: 'That festival is full right now - try again in a bit, or pick another one.' }));
      ws.close(1000, 'full');
      return;
    }

    const id = room.nextId++;
    room.guests.set(id, ws);
    if (ticketKey) ticketSockets.set(ticketKey, (ticketSockets.get(ticketKey) || 0) + 1);
    send(room.host, JSON.stringify({ relay: 'join', g: id }));
    sendPatches(ws, code, room);   // Round 60: late joiners get every patched stage straight away (the same live streams)

    ws.on('message', (data) => {
      if (room.guests.get(id) !== ws) return;   // Round 57: removed (or the room ended) - nothing more from them
      if (isVoice(data)) { relayVoice(room, id, ws, data); return; }   // Round 54: straight to the players near them
      if (isMic(data)) { relayMic(room, id, ws, data); return; }       // Round 61: the open mic - to everyone, if they hold a mic
      if (!guestAllowed(ws, data.length)) return;   // Round 57: size and rate limits
      if (data.length < 160 && data[0] === 0x72 && data[1] === 0x3a) {
        // Round 57: "r:..." - a report, for the relay (never passed on).
        const r = parseReport(data.toString());
        if (r) fileReport(code, room, id, ws, r.target, r.reason, clip(r.name, 18));
        return;
      }
      sendToHost(room, JSON.stringify({ relay: 'msg', g: id, m: data.toString() }));
    });

    ws.on('close', () => {
      if (ticketKey) {
        const left = (ticketSockets.get(ticketKey) || 1) - 1;
        if (left <= 0) ticketSockets.delete(ticketKey); else ticketSockets.set(ticketKey, left);
      }
      if (room.mic) room.mic.delete(id);   // Round 61
      if (room.guests.delete(id)) send(room.host, JSON.stringify({ relay: 'leave', g: id }));
    });
    return;
  }

  if (url.pathname === '/public') {
    publicConnect(ws, url, ip);   // Round 66: the always-open public festival
    return;
  }

  ws.close(1008, 'unknown path');
});

// Keep connections alive through hosting providers' idle timeouts, and drop dead ones.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

// Round 55: the leaderboards are written a couple of seconds after each change; stopping the server writes them now.
// (The exit waits a moment, so any other module's own SIGTERM listener gets to save too.)
// Round 66: the public festival's players are told first, so their games reconnect by themselves once the server is back
// (a redeploy, or Render restarting it); the exit waits a moment so that line actually goes out.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const restart = JSON.stringify({ relay: 'restart', text: 'The online server is restarting - you\'ll be back in a moment.' });
    try { publicEach(publicRoom, ws => send(ws, restart)); } catch (err) { console.error('restart notice', err && err.message); }
    leaderboards.flush(); reports.flush(); patchbay.flush(); worlds.flush();   // Round 60: + the patch bay. Round 63: + saved worlds
    applications.flush();   // Round 67: + artist applications
    sellers.flush();        // Round 85: + real shops
    analytics.flush();      // Round 71: + play stats
    // Round 74: + the live accounts (to disk, and the off-site backup if one is waiting - up to 6 s).
    const accounts = Promise.race([players.final().catch(err => console.error('players final', err && err.message)), new Promise(r => setTimeout(r, 6000))]);
    const quiet = new Promise(r => setTimeout(r, 300));
    Promise.all([accounts, quiet]).then(() => {
      try { publicEach(publicRoom, ws => ws.close(1012, 'server restarting')); } catch { /* exiting anyway */ }
      setTimeout(() => process.exit(0), 150);
    });
  });
}

server.listen(PORT, () => console.log(`Festival Tycoon relay listening on ${PORT}`));
