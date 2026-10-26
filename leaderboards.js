// Round 55: world leaderboards - the longest crowd surf, slackline, half pipe run... from every player.
//
//  POST /boards/join   {}  -> {"ok":true,"player":"<id>","token":"<signature>","tag":"<public tag>"}
//                      The relay hands each game its own player id, signed with the server's secret, once.
//                      Scores are only taken with a matching id + token, so nobody can post as someone
//                      else, and making lots of new players is slow (a few per hour from one address).
//  POST /scores        {"board":"surf","name":"Raver-123","value":234,"week":2908,"weekValue":180,
//                       "player":"<id>","token":"<signature>","version":55}
//                      Keeps each player's best on each board, all time and this week (weeks start Monday
//                      00:00 UTC). Answers {"ok":true,"board":"surf","rank":3,"best":234,"total":57,
//                      "weekRank":1,"weekBest":180,"weekTotal":12,"name":"Raver-123"} (rank 0 = not ranked).
//  GET  /leaderboard?board=surf&period=all|week&limit=100&me=<tag>&tags=<tag>,<tag>
//                      One board (the top 100). With "tags": only those players (friends in your room),
//                      each with their real rank.
//  GET  /leaderboards?period=all|week&limit=10&me=<tag>     every board's top rows
//
// Only a hash of each player id is written down, and the public "tag" is a hash of that - neither can be
// used to post scores. Everything lives in leaderboards.json next to this file (or where LEADERBOARD_FILE
// says), written safely (a temporary file, then renamed over the old one), with a cap on every board.
// Set BOARD_SECRET on the server to keep players' tokens valid even if that file is lost.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.LEADERBOARD_FILE || path.join(__dirname, 'leaderboards.json');
const TOP = 100;                                                    // rows anyone can see on a board
const KEEP = Math.max(TOP, Number(process.env.BOARD_KEEP) || 1000); // players kept per board (so ranks go past 100)
const SAVE_DELAY = 2000;                                            // writes are grouped (at most one every 2 s)
const MAX_FILE = 16 * 1024 * 1024;                                  // never write a file bigger than this
const POSTS_PER_MINUTE_IP = Number(process.env.SCORES_PER_MINUTE_IP) || 40;
const POSTS_PER_MINUTE_PLAYER = Number(process.env.SCORES_PER_MINUTE_PLAYER) || 20;
const POSTS_PER_MINUTE_ALL = Number(process.env.SCORES_PER_MINUTE_ALL) || 3000;
const READS_PER_MINUTE_IP = Number(process.env.BOARD_READS_PER_MINUTE) || 60;
const JOINS_PER_HOUR_IP = Number(process.env.BOARD_JOINS_PER_HOUR_IP) || 6;
const JOINS_PER_HOUR_ALL = Number(process.env.BOARD_JOINS_PER_HOUR_ALL) || 2000;
const MAX_BODY = 2048;
const MAX_TAGS = 24;
const WEEK_MS = 7 * 24 * 3600 * 1000;

// Every board the game has, with the values that make sense on it. "lower" = smaller is better (a lap time).
// "total" = a running count (wins, pins...): it can only grow so fast ("perHour", with "burst" to spare,
// and "first" is the most a brand-new player can arrive with). These match Records.cs in the game.
const BOARDS = {
  surf:           { min: 1,     max: 600,      lower: false },   // longest crowd surf, tenths of a metre
  flow:           { min: 1,     max: 100,      lower: false },   // best Flow rating (0-100)
  slackline:      { min: 1,     max: 50000,    lower: false },   // slackline distance back and forth in one go, tenths of a metre
  halfpipe:       { min: 1,     max: 10000000, lower: false },   // best half pipe run (points)
  combo:          { min: 1,     max: 10000000, lower: false },   // biggest skate combo (points)
  hacky:          { min: 1,     max: 5000,     lower: false },   // hacky sack kicks in a row
  cornhole:       { min: 1,     max: 100000,   lower: false, total: true, perHour: 40,  burst: 20,  first: 400 },    // cornhole matches won
  cornholestreak: { min: 1,     max: 10000,    lower: false },   // best cornhole win streak
  dance:          { min: 1,     max: 100000,   lower: false, total: true, perHour: 80,  burst: 30,  first: 800 },    // dance battles won
  cartlap:        { min: 10000, max: 1800000,  lower: true  },   // fastest golf-cart lap, milliseconds
  shuttles:       { min: 1,     max: 100000,   lower: false, total: true, perHour: 20,  burst: 10,  first: 300 },    // artists delivered by golf cart
  pins:           { min: 1,     max: 5000,     lower: false, total: true, perHour: 60,  burst: 30,  first: 600 },    // hidden pins found
  friends:        { min: 1,     max: 100000,   lower: false, total: true, perHour: 150, burst: 50,  first: 2000 },   // festival friends made
};

// Round 55 review: board names come from players, so only the boards' OWN names count ("constructor" or
// "__proto__" used to reach Object's built-ins and crash the whole relay on a list.find / list[0].p).
function boardSpec(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BOARDS, id) ? BOARDS[id] : null;
}

// A short list of words a public name can't contain (checked with spaces, dots and look-alike digits removed).
// (Words that hide inside ordinary names - "grape", "swanky", "Dickens" - are left off on purpose.)
const BLOCKED = ['fuck', 'shit', 'cunt', 'nigg', 'fagg', 'bitch', 'whore', 'slut', 'nazi', 'hitler', 'penis',
  'vagina', 'pussy', 'porn', 'retard', 'twat', 'dildo', 'jizz', 'kkk', 'rape', 'cock', 'wank', 'nonce', 'isis'];
const ALLOWED_INSIDE = ['grape', 'drape', 'scrape', 'trapeze', 'cocktail', 'peacock', 'hancock', 'woodcock', 'shuttlecock', 'cockatoo', 'cockpit', 'cockle'];

/** The week number (weeks since 1970, starting Monday 00:00 UTC) - the game works it out the same way. */
function weekOf(ms) {
  return Math.floor((Math.floor(ms / 86400000) + 3) / 7);
}

/** When this week's boards start again (ms). */
function weekEnds(week) {
  return ((week + 1) * 7 - 3) * 86400000;
}

// ---------------------------------------------------------------- the file

let data = { version: 2, all: {}, weeks: {} };   // board -> [{ p: player hash, n: name, v: value, t: time, g: game version }]
let secret = '';
try {
  const loaded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (loaded && typeof loaded === 'object') {
    if (loaded.all && typeof loaded.all === 'object') data.all = loaded.all;
    else if (loaded.boards && typeof loaded.boards === 'object') data.all = loaded.boards;   // the first (Round 55 WIP) file
    if (loaded.weeks && typeof loaded.weeks === 'object') data.weeks = loaded.weeks;
    if (typeof loaded.secret === 'string' && loaded.secret.length >= 32) secret = loaded.secret;
  }
} catch { /* first run, or the disk was wiped: start empty */ }

function tidyBoards(boards) {
  for (const id of Object.keys(boards)) {
    const list = boards[id];
    if (!boardSpec(id) || !Array.isArray(list)) { delete boards[id]; continue; }   // Round 55 review: own boards only
    boards[id] = list.filter(e => e && typeof e.p === 'string' && Number.isInteger(e.v) && e.v >= BOARDS[id].min && e.v <= BOARDS[id].max).slice(0, KEEP);
  }
}
tidyBoards(data.all);
for (const w of Object.keys(data.weeks)) {
  if (!/^\d+$/.test(w) || !data.weeks[w] || typeof data.weeks[w] !== 'object') delete data.weeks[w];
  else tidyBoards(data.weeks[w]);
}
dropOldWeeks(weekOf(Date.now()));

// The secret that signs player tokens: BOARD_SECRET if set, else one made on first run and kept in the file.
let secretIsNew = false;
if (process.env.BOARD_SECRET && process.env.BOARD_SECRET.length >= 16) secret = process.env.BOARD_SECRET;
else if (!secret) { secret = crypto.randomBytes(32).toString('hex'); secretIsNew = true; }
// Round 93: without BOARD_SECRET the secret lives only in this server's runtime file (never in git) - say so clearly.
if (!(process.env.BOARD_SECRET && process.env.BOARD_SECRET.length >= 16)) {
  console.warn('leaderboards: WARNING - BOARD_SECRET is not set. A random secret is being kept in ' + path.basename(FILE) + ' on this server only; ' +
    'if that file is lost, everyone\'s leaderboard tokens stop working. Set BOARD_SECRET (32+ random characters) in Render > Environment.');
}

function dropOldWeeks(now) {
  for (const w of Object.keys(data.weeks)) if (Number(w) < now - 1) delete data.weeks[w];   // this week and last week only
}

// ---------------------------------------------------------------- saving

let saveTimer = null;
let saving = false;
let saveAgain = false;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, SAVE_DELAY);
  if (saveTimer.unref) saveTimer.unref();
}

function serialise() {
  const out = { version: 2, all: data.all, weeks: data.weeks };
  if (!process.env.BOARD_SECRET) out.secret = secret;
  const text = JSON.stringify(out);
  return text.length <= MAX_FILE ? text : null;
}

/** Atomic: the new file is written next to the old one, then renamed over it (a crash never leaves half a file). */
function save() {
  if (saving) { saveAgain = true; return; }
  const text = serialise();
  if (text === null) { console.error('leaderboards: too big to save (lower BOARD_KEEP)'); return; }
  saving = true;
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFile(tmp, text, (err) => {
    if (err) { done(err); return; }
    fs.rename(tmp, FILE, done);
  });
  function done(err) {
    if (err) { console.error('leaderboards: could not save', err.message); fs.unlink(tmp, () => {}); }
    saving = false;
    if (saveAgain) { saveAgain = false; save(); }
  }
}

if (secretIsNew) scheduleSave();   // (kept in the file, so players' tokens still work after a restart)

/** Write now (the tests, and when the server is stopped). */
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const text = serialise();
  if (text === null) return;
  const tmp = FILE + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, FILE); } catch (err) { console.error('leaderboards: could not save', err.message); }
}

// ---------------------------------------------------------------- who's who

function hashPlayer(id) {
  return crypto.createHash('sha256').update('mvm-boards:' + id).digest('hex').slice(0, 20);
}

/** The public tag for a player hash (shared with friends in a room for the "friends here" boards). */
const tagCache = new Map();
function tagOf(hash) {
  let tag = tagCache.get(hash);
  if (!tag) {
    tag = crypto.createHash('sha256').update('mvm-tag:' + hash).digest('hex').slice(0, 12);
    if (tagCache.size > 200000) tagCache.clear();
    tagCache.set(hash, tag);
  }
  return tag;
}

function tokenFor(id) {
  return crypto.createHmac('sha256', secret).update('player:' + id).digest('hex').slice(0, 40);
}

function validPlayerId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id);
}

function tokenOk(id, token) {
  if (!validPlayerId(id) || typeof token !== 'string' || token.length !== 40) return false;
  const a = Buffer.from(tokenFor(id));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A tidy public name: letters, digits and a little punctuation, 2-18 characters, nothing rude. */
function cleanName(name) {
  let n = String(name == null ? '' : name).normalize('NFKC');
  n = n.replace(/[^\p{L}\p{N} _.'!-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 18).trim();
  if (n.length < 2) return 'Festival-goer';
  return isRude(n) ? 'Festival-goer' : n;
}

/** True if a bit of text has a blocked word in it (look-alike digits and spacing don't hide one). */
function isRude(text) {
  let flat = String(text).toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/\$/g, 's').replace(/@/g, 'a')
    .replace(/[^\p{L}]/gu, '');
  for (const ok of ALLOWED_INSIDE) flat = flat.split(ok).join('');
  return BLOCKED.some(w => flat.includes(w));
}

function ipOf(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');   // the hop our host's proxy added
}

// ---------------------------------------------------------------- rate limits

const postHitsIp = new Map();
const postHitsPlayer = new Map();
const readHits = new Map();
const joinHits = new Map();
let postHitsAll = [];
let joinHitsAll = [];

/** Counts one hit in the last "windowMs"; true while under the limit. */
function allow(map, key, limit, now, windowMs = 60000) {
  const hits = (map.get(key) || []).filter(t => now - t < windowMs);
  const ok = hits.length < limit;
  if (ok) hits.push(now);
  map.set(key, hits);
  if (map.size > 20000) map.clear();   // never grows without end
  return ok;
}

setInterval(() => {
  const now = Date.now();
  for (const map of [postHitsIp, postHitsPlayer, readHits]) {
    for (const [key, times] of map) if (!times.some(t => now - t < 60000)) map.delete(key);
  }
  for (const [key, times] of joinHits) if (!times.some(t => now - t < 3600000)) joinHits.delete(key);
  postHitsAll = postHitsAll.filter(t => now - t < 60000);
  joinHitsAll = joinHitsAll.filter(t => now - t < 3600000);
  const week = weekOf(now);
  const before = Object.keys(data.weeks).length;
  dropOldWeeks(week);
  if (Object.keys(data.weeks).length !== before) scheduleSave();
}, 60000).unref();

// ---------------------------------------------------------------- the boards

function better(board, a, b) {
  return BOARDS[board].lower ? a < b : a > b;
}

function sortBoard(board, list) {
  const lower = BOARDS[board].lower;
  list.sort((a, b) => (lower ? a.v - b.v : b.v - a.v) || (a.t - b.t));   // ties: whoever got there first
}

/** A new player id and its token (a handful per hour from one address). */
function join(ip, now = Date.now()) {
  if (!allow(joinHits, ip, JOINS_PER_HOUR_IP, now, 3600000)) return [429, { ok: false, message: 'Lots of new players from here - try again later.' }];
  joinHitsAll = joinHitsAll.filter(t => now - t < 3600000);
  if (joinHitsAll.length >= JOINS_PER_HOUR_ALL) return [429, { ok: false, message: 'The boards are busy - try again later.' }];
  joinHitsAll.push(now);
  const player = crypto.randomBytes(18).toString('base64url');
  return [200, { ok: true, player, token: tokenFor(player), tag: tagOf(hashPlayer(player)) }];
}

/** Puts one value on one list (keeps the player's best). Returns the changed flag and the player's row index. */
function place(board, list, player, name, value, now, version) {
  let changed = false;
  const mine = list.find(e => e.p === player);
  if (mine) {
    if (better(board, value, mine.v)) { mine.v = value; mine.t = now; mine.g = version; changed = true; }
    if (mine.n !== name) { mine.n = name; changed = true; }   // a new name shows on every board you resend
  } else if (list.length < KEEP || better(board, value, list[list.length - 1].v)) {
    list.push({ p: player, n: name, v: value, t: now, g: version });
    changed = true;
  }
  if (changed) {
    sortBoard(board, list);
    if (list.length > KEEP) list.length = KEEP;
  }
  return { changed, at: list.findIndex(e => e.p === player) };
}

/** For running totals: how high this player's value can be by now (it can only grow so fast). */
function totalCap(spec, mine, now) {
  if (!mine) return Math.min(spec.max, spec.first);
  const hours = Math.max(0, (now - mine.t) / 3600000);
  return Math.min(spec.max, mine.v + spec.burst + Math.floor(spec.perHour * hours));
}

/** Records one score. Returns [HTTP status, reply]. */
function submitScore(body, ip, now = Date.now()) {
  if (!body || typeof body !== 'object') return [400, { ok: false, message: 'Send a score.' }];
  const board = String(body.board || '');
  const spec = boardSpec(board);   // Round 55 review: own boards only
  if (!spec) return [400, { ok: false, message: 'Unknown board.' }];
  let value = Number(body.value);
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) return [400, { ok: false, message: 'That score is out of range.' }];
  const id = body.player;
  if (!validPlayerId(id)) return [401, { ok: false, message: 'Join the boards first.' }];
  if (!tokenOk(id, body.token)) return [401, { ok: false, message: 'Join the boards again.' }];
  const version = Number.isInteger(Number(body.version)) ? Math.max(0, Math.min(1000000, Number(body.version))) : 0;

  if (!allow(postHitsIp, ip, POSTS_PER_MINUTE_IP, now) || !allow(postHitsPlayer, id, POSTS_PER_MINUTE_PLAYER, now)) {
    return [429, { ok: false, message: 'Lots of scores at once - wait a minute.' }];
  }
  postHitsAll = postHitsAll.filter(t => now - t < 60000);
  if (postHitsAll.length >= POSTS_PER_MINUTE_ALL) return [429, { ok: false, message: 'The boards are busy - try again in a minute.' }];
  postHitsAll.push(now);

  // This week's value: only for this week, and never better than the all-time one it's part of.
  const week = weekOf(now);
  let weekValue = Number(body.weekValue);
  const weekOk = Number(body.week) === week && Number.isInteger(weekValue) && weekValue >= spec.min && weekValue <= spec.max &&
    !better(board, weekValue, value);

  const player = hashPlayer(id);
  const name = cleanName(body.name);
  const all = data.all[board] || (data.all[board] = []);
  if (spec.total) {
    // A running total can't jump: more than it could have grown since the last one is held back (not refused).
    value = Math.min(value, totalCap(spec, all.find(e => e.p === player), now));
  }
  const allPlace = place(board, all, player, name, value, now, version);
  let changed = allPlace.changed;

  const weekBoards = data.weeks[week] || (data.weeks[week] = {});
  const weekList = weekBoards[board] || (weekBoards[board] = []);
  if (weekOk) {
    if (spec.total) weekValue = Math.min(weekValue, value, totalCap(spec, weekList.find(e => e.p === player), now));
    changed = place(board, weekList, player, name, weekValue, now, version).changed || changed;
  } else {
    const row = weekList.find(e => e.p === player);
    if (row && row.n !== name) { row.n = name; changed = true; }
  }
  if (changed) scheduleSave();

  const at = allPlace.at;
  const wAt = weekList.findIndex(e => e.p === player);
  return [200, {
    ok: true, board, name, tag: tagOf(player),
    rank: at + 1, best: at >= 0 ? all[at].v : 0, total: all.length,
    week, weekEnds: weekEnds(week), weekRank: wAt + 1, weekBest: wAt >= 0 ? weekList[wAt].v : 0, weekTotal: weekList.length,
  }];
}

/** One board as the game shows it. "tags" (a Set) = only those players, with their real ranks. */
function boardView(board, period, limit, meTag, tags) {
  const week = weekOf(Date.now());
  const list = (period === 'week' ? (data.weeks[week] || {})[board] : data.all[board]) || [];
  const me = meTag ? list.findIndex(e => tagOf(e.p) === meTag) : -1;
  const rows = [];
  for (let i = 0; i < list.length && rows.length < limit; i++) {
    if (!tags && i >= limit) break;
    const e = list[i];
    const tag = tagOf(e.p);
    if (tags && i !== me && !tags.has(tag)) continue;
    rows.push({ rank: i + 1, name: e.n, value: e.v, me: i === me, tag });
  }
  return {
    board, period: period === 'week' ? 'week' : 'all', total: list.length,
    rank: me + 1, best: me >= 0 ? list[me].v : 0,
    week, weekEnds: weekEnds(week),
    entries: rows,
  };
}

// ---------------------------------------------------------------- HTTP

function reply(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}

/** Reads a small JSON body, then calls back with it (or answers 400/413 itself). */
function readBody(req, res, then) {
  let body = '';
  let tooBig = false;
  req.on('data', chunk => {
    if (tooBig) return;
    body += chunk;
    if (body.length > MAX_BODY) {
      tooBig = true;
      res.writeHead(413, { 'content-type': 'application/json', 'access-control-allow-origin': '*', connection: 'close' });
      res.end(JSON.stringify({ ok: false, message: 'Too big.' }), () => req.destroy());
    }
  });
  req.on('error', () => {});
  req.on('end', () => {
    if (tooBig) return;
    let parsed;
    try { parsed = body.length ? JSON.parse(body) : {}; } catch { reply(res, 400, { ok: false, message: "That didn't arrive properly." }); return; }
    // Round 55 review: a throw here is in an 'end' listener - uncaught, it would take the whole relay down.
    try { then(parsed); } catch (err) { console.error('leaderboards', err && err.message); if (!res.headersSent) reply(res, 500, { ok: false, message: 'Try again in a minute.' }); }
  });
}

function cleanTag(t) {
  return typeof t === 'string' && /^[0-9a-f]{12}$/.test(t) ? t : '';
}

const ROUTES = ['/scores', '/leaderboard', '/leaderboards', '/boards/join'];

/** Handles /scores, /leaderboard, /leaderboards and /boards/join. False for anything else. */
function handle(req, res) {
  const url = new URL(req.url, 'http://relay');
  const route = url.pathname;
  if (!ROUTES.includes(route)) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, authorization' });   // Round 109: + the sign-in
    res.end();
    return true;
  }

  const ip = ipOf(req);
  if (route === '/scores' || route === '/boards/join') {
    if (req.method !== 'POST') { reply(res, 405, { ok: false, message: 'Scores are sent from the game.' }); return true; }
    readBody(req, res, (parsed) => {
      // Round 109: putting scores on the world boards needs the live account (like everything online); looking stays open.
      const gate = require('./players').gate(req, parsed, 'put your scores on the world boards');
      if (!gate.ok) { reply(res, gate.status, gate.reply); return; }
      const [status, obj] = route === '/scores' ? submitScore(parsed, ip) : join(ip);
      reply(res, status, obj);
    });
    return true;
  }

  if (req.method !== 'GET') { reply(res, 405, { ok: false, message: 'Look, but post from the game.' }); return true; }
  if (!allow(readHits, ip, READS_PER_MINUTE_IP, Date.now())) { reply(res, 429, { ok: false, message: 'Refreshing a lot - wait a moment.' }); return true; }
  const meTag = cleanTag(url.searchParams.get('me') || '');
  const period = url.searchParams.get('period') === 'week' ? 'week' : 'all';
  const limitParam = Number(url.searchParams.get('limit'));
  if (route === '/leaderboard') {
    const board = url.searchParams.get('board') || '';
    if (!boardSpec(board)) { reply(res, 404, { ok: false, message: 'Unknown board.' }); return true; }
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, TOP) : 20;
    const tagParam = url.searchParams.get('tags');
    const tags = tagParam != null ? new Set(tagParam.split(',').slice(0, MAX_TAGS).map(cleanTag).filter(Boolean)) : null;
    reply(res, 200, Object.assign({ ok: true }, boardView(board, period, limit, meTag, tags)));
    return true;
  }

  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 20) : 10;
  reply(res, 200, { ok: true, boards: Object.keys(BOARDS).map(b => boardView(b, period, limit, meTag, null)) });
  return true;
}

module.exports = { handle, submitScore, join, cleanName, isRude, flush, weekOf, tokenFor, BOARDS, FILE };
