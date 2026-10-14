// Round 63: SAVED WORLDS - a room's festival kept on this server, so you and your friends come back to the same
// world later (like a Minecraft world).
//
// WHAT A WORLD IS: an id, a name, its owner, where it is (region / site), when it was made / last saved / last
// played, who may host it, who has played there, and its SECTIONS - small text blobs the game writes:
//   "layout"  the host's site (stages, booths, gate... exactly what friends are sent when they join)
//   "cobuild" "craft" "decor" "potty" ...  builds, materials, decorating, porta-potty art and stickers
// The server never reads a section; it only checks its name and size, strips control characters and keeps it.
//
// WHO IS WHO: each game makes its own secret world key (it never leaves that player's game except to this server).
// The server only ever keeps a one-way hash of it - the player's public "tag" - so nobody can act as someone else.
// The owner can let friends HOST the world too (by their tag, which friends' games send the host in the room).
//
//  POST /worlds/mine    {"key"}                                -> your worlds + worlds you may host + worlds you've played in
//                                                                 (with the room code when one is open right now)
//  POST /worlds/create  {"key","name","region","site","by"}    -> a new, empty world (at most WORLDS_PER_PLAYER each)
//  POST /worlds/rename  {"key","id","name"}                    (owner)
//  POST /worlds/delete  {"key","id"}                           (owner; not while it's open)
//  POST /worlds/grant   {"key","id","tag","name","on"}         (owner: let a friend host it, or stop that)
//  GET  /worlds/status                                         -> is saving switched on, how many worlds
// The game opens a world by hosting with /host?world=<id>&wkey=<key> (see relay.js); the host's game then sends
// {"wsave":{"s":"<section>","d":"<text>"}} as things change, and {"wpeople":[{"t":tag,"n":name},...]}.
//
// FILES: in WORLDS_DIR, else STORE_DATA_DIR/worlds (the persistent disk the store already uses), else next to this
// file (a free Render server forgets those on every restart - worlds then only last until the next restart).
//   worlds-index.json   every world's details (no sections) - written whole to a temp file, then renamed
//   <id>.json           one world: its details + sections (the index can be rebuilt from these if it's ever lost)
// LIMITS: 64 KB a section (256 KB for "layout"), 16 sections and 1 MB a world, WORLDS_PER_PLAYER (5) worlds each,
// WORLDS_MAX (3000) worlds in all, WORLDS_TOTAL_MB (800) on disk; a world nobody has played or saved for
// WORLDS_KEEP_DAYS (90) days is removed (an empty one after 14). All optional - the defaults are fine.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const boards = require('./leaderboards');   // the same rude-word check as names on the boards

const DIR = process.env.WORLDS_DIR || path.join(process.env.STORE_DATA_DIR || __dirname, 'worlds');
const INDEX_FILE = path.join(DIR, 'worlds-index.json');
const PERSISTENT = !!(process.env.WORLDS_DIR || process.env.STORE_DATA_DIR);

const MAX_WORLDS = Number(process.env.WORLDS_MAX) || 3000;
const PER_OWNER = Number(process.env.WORLDS_PER_PLAYER) || 5;
const MAX_TOTAL = (Number(process.env.WORLDS_TOTAL_MB) || 800) * 1024 * 1024;
const KEEP_DAYS = Number(process.env.WORLDS_KEEP_DAYS) || 90;
const EMPTY_KEEP_DAYS = 14;
const MAX_SECTION = 64 * 1024;
const MAX_LAYOUT = 256 * 1024;
const MAX_SECTIONS = 16;
const MAX_WORLD = 1024 * 1024;
const MAX_HOSTS = 8;
const MAX_PEOPLE = 24;
const CACHE = 40;                     // worlds' sections kept in memory besides the open ones
const SAVE_DELAY = 2000;              // writes are grouped (at most one every 2 s)
const MAX_BODY = 2048;
const DAY = 86400000;
const READS_PER_MINUTE = 30, WRITES_PER_MINUTE = 12, CREATES_PER_HOUR = 6, CREATES_PER_HOUR_ALL = 300;
const SAVES_PER_MINUTE = 60, SAVE_BYTES_PER_MINUTE = 3 * 1024 * 1024;   // per open world (a host saves every few seconds at most)
const PEOPLE_GAP = 5000;              // a host can update who's played there this often

// ============================================================================ state
const metas = new Map();     // id -> details (no sections)
const cache = new Map();     // id -> Map(section -> text)   (loaded on demand; open worlds stay in)
const dirtyWorlds = new Set();
let totalBytes = 0;
let ready = false;           // the folder could be made and read
let note = '';               // a problem worth showing on /worlds/status
let hooks = { openInfo: () => null };   // relay.js: id -> { code, players } while the world is open

function now() { return Date.now(); }

function clip(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

/** A section's text: control characters (but tabs and line breaks) removed. Never throws. */
function cleanText(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/g, '') : '';
}

function validId(id) { return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id); }
function validTag(t) { return typeof t === 'string' && /^[0-9a-f]{16}$/.test(t); }
function validSection(s) { return typeof s === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(s); }

/** The player's public tag from their secret world key ("" if it isn't a key). The game works it out the same way. */
function tagOf(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9]{24,64}$/.test(key)) return '';
  return crypto.createHash('sha256').update('mvm-world-tag:' + key).digest('hex').slice(0, 16);
}

function cleanWorldName(name) {
  let n = String(name == null ? '' : name).normalize('NFKC');
  n = n.replace(/[^\p{L}\p{N} _.,'!&()-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 32).trim();
  if (n.length < 2 || boards.isRude(n)) return '';
  return n;
}

function cleanPerson(p) {
  if (!p || typeof p !== 'object' || !validTag(p.t)) return null;
  return { t: p.t, n: boards.cleanName(p.n), at: Number.isFinite(Number(p.at)) ? Number(p.at) : now() };
}

/** One world's details, checked field by field (from a file or from memory). */
function cleanMeta(m) {
  if (!m || typeof m !== 'object' || !validId(m.id) || !validTag(m.owner)) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    id: m.id,
    name: cleanWorldName(m.name) || 'A saved world',
    owner: m.owner,
    ownerName: boards.cleanName(m.ownerName),
    region: clip(m.region, 32),
    site: clip(m.site, 40),
    created: num(m.created) || now(),
    updated: num(m.updated),
    played: num(m.played),
    hosts: (Array.isArray(m.hosts) ? m.hosts : []).map(cleanPerson).filter(Boolean).slice(0, MAX_HOSTS),
    people: (Array.isArray(m.people) ? m.people : []).map(cleanPerson).filter(Boolean).slice(0, MAX_PEOPLE),
    bytes: Math.max(0, num(m.bytes) | 0),
    sections: (Array.isArray(m.sections) ? m.sections : []).filter(validSection).slice(0, MAX_SECTIONS),
  };
}

// ============================================================================ files
function worldFile(id) { return path.join(DIR, id + '.json'); }   // id is always 16 hex characters (checked)

function writeAtomicSync(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  try { fs.copyFileSync(file, file + '.bak'); } catch { /* first save */ }
  fs.renameSync(tmp, file);
}

function readJson(file) {
  for (const f of [file, file + '.bak']) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* next */ }
  }
  return null;
}

function recount() {
  totalBytes = 0;
  for (const m of metas.values()) totalBytes += m.bytes;
}

function load() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    ready = true;
  } catch (err) {
    note = 'Could not make the worlds folder (' + (err && err.message) + ').';
    console.error('worlds: ' + note);
    return;
  }

  const index = readJson(INDEX_FILE);
  if (index && Array.isArray(index.worlds)) {
    for (const raw of index.worlds) {
      const m = cleanMeta(raw);
      if (m) metas.set(m.id, m);
    }
  } else {
    // No index (a new server) or it was damaged: rebuild it from the worlds' own files.
    let names = [];
    try { names = fs.readdirSync(DIR); } catch { names = []; }
    for (const name of names) {
      const match = /^([0-9a-f]{16})\.json$/.exec(name);
      if (!match) continue;
      const data = readJson(path.join(DIR, name));
      const m = data && cleanMeta(data.meta);
      if (m && m.id === match[1]) metas.set(m.id, m);
    }
    if (metas.size > 0) {
      note = 'The worlds list was rebuilt from the world files.';
      console.error('worlds: ' + note);
      saveIndexSoon();
    }
  }
  recount();
}

let indexTimer = null, indexSaving = false, indexAgain = false;

function indexText() {
  return JSON.stringify({ version: 1, worlds: Array.from(metas.values()) });
}

function saveIndexSoon() {
  if (!ready || indexTimer) return;
  indexTimer = setTimeout(() => { indexTimer = null; saveIndex(); }, SAVE_DELAY);
  if (indexTimer.unref) indexTimer.unref();
}

function saveIndex() {
  if (!ready) return;
  if (indexSaving) { indexAgain = true; return; }
  indexSaving = true;
  const text = indexText();
  const tmp = INDEX_FILE + '.' + process.pid + '.tmp';
  fs.writeFile(tmp, text, (err) => {
    if (err) { done(err); return; }
    fs.copyFile(INDEX_FILE, INDEX_FILE + '.bak', () => fs.rename(tmp, INDEX_FILE, done));
  });
  function done(err) {
    if (err) { console.error('worlds: could not save the list', err.message); fs.unlink(tmp, () => {}); }
    indexSaving = false;
    if (indexAgain) { indexAgain = false; saveIndex(); }
  }
}

let worldTimer = null;
const worldSaving = new Set();

function saveWorldSoon(id) {
  dirtyWorlds.add(id);
  if (!ready || worldTimer) return;
  worldTimer = setTimeout(() => { worldTimer = null; saveWorlds(); }, SAVE_DELAY);
  if (worldTimer.unref) worldTimer.unref();
}

function worldText(id) {
  const m = metas.get(id);
  const secs = cache.get(id);
  if (!m || !secs) return null;
  const sections = {};
  for (const [name, text] of secs) sections[name] = text;
  return JSON.stringify({ version: 1, meta: m, sections });
}

function saveWorlds() {
  for (const id of Array.from(dirtyWorlds)) {
    if (worldSaving.has(id)) continue;   // its turn comes after the write in progress
    dirtyWorlds.delete(id);
    const text = worldText(id);
    if (text === null) continue;
    worldSaving.add(id);
    const file = worldFile(id);
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFile(tmp, text, (err) => {
      if (err) { finish(err); return; }
      fs.copyFile(file, file + '.bak', () => fs.rename(tmp, file, finish));
    });
    function finish(err) {
      if (err) { console.error('worlds: could not save a world', err.message); fs.unlink(tmp, () => {}); dirtyWorlds.add(id); }
      worldSaving.delete(id);
      if (dirtyWorlds.size > 0) saveWorldSoon(Array.from(dirtyWorlds)[0]);
      trimCache();
    }
  }
  saveIndexSoon();
}

/** Writes everything now (the server is stopping). */
function flush() {
  if (!ready) return;
  if (worldTimer) { clearTimeout(worldTimer); worldTimer = null; }
  if (indexTimer) { clearTimeout(indexTimer); indexTimer = null; }
  for (const id of Array.from(dirtyWorlds)) {
    const text = worldText(id);
    if (text === null) continue;
    try { writeAtomicSync(worldFile(id), text); dirtyWorlds.delete(id); } catch (err) { console.error('worlds: could not save a world', err && err.message); }
  }
  try { writeAtomicSync(INDEX_FILE, indexText()); } catch (err) { console.error('worlds: could not save the list', err && err.message); }
}

/** A world's sections (read from its file the first time). Null if the file can't be read. */
function sectionsOf(id) {
  let secs = cache.get(id);
  if (secs) return secs;
  secs = new Map();
  const data = readJson(worldFile(id));
  if (data && data.sections && typeof data.sections === 'object') {
    for (const name of Object.keys(data.sections).slice(0, MAX_SECTIONS)) {
      if (!validSection(name)) continue;
      const text = cleanText(data.sections[name]);
      if (text.length > 0 && text.length <= (name === 'layout' ? MAX_LAYOUT : MAX_SECTION)) secs.set(name, text);
    }
  } else if (metas.get(id) && metas.get(id).bytes > 0) {
    return null;   // it had sections, but the file is missing or damaged: never hand out an empty world in its place
  }
  cache.set(id, secs);
  return secs;
}

function trimCache() {
  if (cache.size <= CACHE) return;
  for (const id of Array.from(cache.keys())) {
    if (cache.size <= CACHE) break;
    if (hooks.openInfo(id) || dirtyWorlds.has(id) || worldSaving.has(id)) continue;
    cache.delete(id);
  }
}

function removeWorld(id) {
  const m = metas.get(id);
  if (!m) return;
  metas.delete(id);
  cache.delete(id);
  dirtyWorlds.delete(id);
  totalBytes = Math.max(0, totalBytes - m.bytes);
  for (const f of [worldFile(id), worldFile(id) + '.bak']) fs.unlink(f, () => {});
  saveIndexSoon();
}

/** Worlds nobody has played or saved for a long time are removed (never one that's open). */
function sweep() {
  const t = now();
  for (const m of Array.from(metas.values())) {
    if (hooks.openInfo(m.id)) continue;
    const last = Math.max(m.created, m.updated, m.played);
    const keep = (m.bytes > 0 ? KEEP_DAYS : EMPTY_KEEP_DAYS) * DAY;
    if (t - last > keep) removeWorld(m.id);
  }
}

// ============================================================================ who may do what
function isOwner(m, tag) { return !!tag && m.owner === tag; }
function canHost(m, tag) { return !!tag && (m.owner === tag || m.hosts.some(h => h.t === tag)); }
function hasPlayed(m, tag) { return !!tag && m.people.some(p => p.t === tag); }

/** One world as a player sees it in their list. */
function view(m, tag) {
  const owner = isOwner(m, tag);
  const open = hooks.openInfo(m.id);
  const out = {
    id: m.id, name: m.name, region: m.region, site: m.site,
    created: m.created, updated: m.updated, played: m.played,
    mine: owner, canHost: canHost(m, tag), open: !!open,
    code: open ? open.code : '', players: open ? open.players : 0,
    by: m.ownerName,
    people: m.people.slice(0, 12).map(p => p.n),
    bytes: owner ? m.bytes : 0,
  };
  if (owner) {
    out.hosts = m.hosts.map(h => ({ t: h.t, n: h.n }));
    out.visitors = m.people.filter(p => p.t !== m.owner).map(p => ({ t: p.t, n: p.n }));
  }
  return out;
}

// ============================================================================ HTTP
const readHits = new Map(), writeHits = new Map(), createHits = new Map();
let createAll = [];

function allow(map, key, limit, windowMs) {
  const t = now();
  const hits = (map.get(key) || []).filter(x => t - x < windowMs);
  const ok = hits.length < limit;
  if (ok) hits.push(t);
  map.set(key, hits);
  if (map.size > 20000) map.clear();
  return ok;
}

setInterval(() => {
  const t = now();
  for (const [map, win] of [[readHits, 60000], [writeHits, 60000], [createHits, 3600000]]) {
    for (const [key, times] of map) if (!times.some(x => t - x < win)) map.delete(key);
  }
  createAll = createAll.filter(x => t - x < 3600000);
  for (const [id, b] of saveBuckets) if (t - b.at > 120000) saveBuckets.delete(id);
}, 60000).unref();

setInterval(sweep, 6 * 3600000).unref();
setTimeout(sweep, 60000).unref();

function reply(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}

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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { reply(res, 400, { ok: false, message: "That didn't arrive properly." }); return; }
    // A throw in an 'end' listener would be uncaught and take the whole relay down - never let it out.
    try { then(parsed); } catch (err) { console.error('worlds', err && err.message); if (!res.headersSent) reply(res, 500, { ok: false, message: 'Try again in a minute.' }); }
  });
}

function mine(body) {
  const tag = tagOf(body.key);
  if (!tag) return [400, { ok: false, message: 'Your game sent a bad world key.' }];
  const out = [];
  for (const m of metas.values()) {
    if (canHost(m, tag) || hasPlayed(m, tag)) out.push(view(m, tag));
  }
  // Open ones first, then yours, then the most recently played.
  out.sort((a, b) => (b.open - a.open) || (b.mine - a.mine) || (Math.max(b.played, b.updated) - Math.max(a.played, a.updated)));
  return [200, { ok: true, me: tag, saving: PERSISTENT, perPlayer: PER_OWNER, worlds: out.slice(0, 40) }];
}

function create(body, ip) {
  const tag = tagOf(body.key);
  if (!tag) return [400, { ok: false, message: 'Your game sent a bad world key.' }];
  if (!ready) return [503, { ok: false, message: 'Saved worlds aren\'t available on this server right now.' }];
  const name = cleanWorldName(body.name);
  if (!name) return [400, { ok: false, message: 'Pick a different name for your world (2-32 letters, nothing rude).' }];
  let owned = 0;
  for (const m of metas.values()) if (m.owner === tag) owned++;
  if (owned >= PER_OWNER) return [409, { ok: false, message: `You have ${PER_OWNER} saved worlds already - delete one first.` }];
  if (metas.size >= MAX_WORLDS) sweep();
  if (metas.size >= MAX_WORLDS || totalBytes >= MAX_TOTAL) return [503, { ok: false, message: 'The server has no room for new worlds right now - try again another day.' }];
  createAll = createAll.filter(x => now() - x < 3600000);
  if (createAll.length >= CREATES_PER_HOUR_ALL || !allow(createHits, ip, CREATES_PER_HOUR, 3600000)) return [429, { ok: false, message: 'Lots of new worlds just now - try again in a while.' }];
  createAll.push(now());
  let id;
  do { id = crypto.randomBytes(8).toString('hex'); } while (metas.has(id));
  const m = cleanMeta({ id, name, owner: tag, ownerName: body.by, region: body.region, site: body.site, created: now(), hosts: [], people: [], bytes: 0 });
  metas.set(id, m);
  cache.set(id, new Map());
  saveWorldSoon(id);
  saveIndexSoon();
  return [200, { ok: true, world: view(m, tag) }];
}

function ownedWorld(body) {
  const tag = tagOf(body.key);
  if (!tag) return { error: [400, { ok: false, message: 'Your game sent a bad world key.' }] };
  const m = validId(body.id) ? metas.get(body.id) : null;
  if (!m) return { error: [404, { ok: false, message: 'That world isn\'t on this server any more.' }] };
  if (!isOwner(m, tag)) return { error: [403, { ok: false, message: 'Only the world\'s owner can do that.' }] };
  return { m, tag };
}

function rename(body) {
  const { m, tag, error } = ownedWorld(body);
  if (error) return error;
  const name = cleanWorldName(body.name);
  if (!name) return [400, { ok: false, message: 'Pick a different name (2-32 letters, nothing rude).' }];
  m.name = name;
  saveIndexSoon();
  if (cache.has(m.id)) saveWorldSoon(m.id);   // the world's own file keeps its details too (the list can be rebuilt from it)
  return [200, { ok: true, world: view(m, tag) }];
}

function remove(body) {
  const { m, error } = ownedWorld(body);
  if (error) return error;
  if (hooks.openInfo(m.id)) return [409, { ok: false, message: 'Close the world first (it\'s open right now).' }];
  removeWorld(m.id);
  return [200, { ok: true }];
}

function grant(body) {
  const { m, tag, error } = ownedWorld(body);
  if (error) return error;
  if (!validTag(body.tag) || body.tag === m.owner) return [400, { ok: false, message: 'Pick a friend who has played in this world.' }];
  const on = body.on === true;
  m.hosts = m.hosts.filter(h => h.t !== body.tag);
  if (on) {
    if (m.hosts.length >= MAX_HOSTS) return [409, { ok: false, message: `At most ${MAX_HOSTS} friends can host one world.` }];
    m.hosts.push({ t: body.tag, n: boards.cleanName(body.name), at: now() });
  }
  saveIndexSoon();
  if (cache.has(m.id)) saveWorldSoon(m.id);
  return [200, { ok: true, world: view(m, tag) }];
}

const ROUTES = { '/worlds/mine': mine, '/worlds/create': create, '/worlds/rename': rename, '/worlds/delete': remove, '/worlds/grant': grant };

function ipOf(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
}

/** Handles /worlds/...; false for anything else. */
function handle(req, res) {
  const route = String(req.url || '').split('?')[0];
  if (!route.startsWith('/worlds/')) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' });
    res.end();
    return true;
  }
  if (route === '/worlds/status') {
    reply(res, 200, { ok: true, ready, saving: PERSISTENT, worlds: metas.size, note });
    return true;
  }
  const fn = Object.prototype.hasOwnProperty.call(ROUTES, route) ? ROUTES[route] : null;
  if (!fn) { reply(res, 404, { ok: false, message: 'Unknown.' }); return true; }
  if (req.method !== 'POST') { reply(res, 405, { ok: false, message: 'Worlds are looked after from the game.' }); return true; }
  const ip = ipOf(req);
  const limited = fn === mine ? !allow(readHits, ip, READS_PER_MINUTE, 60000) : !allow(writeHits, ip, WRITES_PER_MINUTE, 60000);
  if (limited) { reply(res, 429, { ok: false, message: 'Lots of requests - wait a moment.' }); return true; }
  readBody(req, res, (body) => {
    const [status, obj] = fn(body, ip);
    reply(res, status, obj);
  });
  return true;
}

// ============================================================================ the relay's side
/** relay.js: how to tell whether a world is open right now ({ code, players } or null). */
function attach(h) {
  if (h && typeof h.openInfo === 'function') hooks.openInfo = (id) => { try { return h.openInfo(id); } catch { return null; } };
}

/**
 * A host opens a world: may they, and what's in it? -> { ok, text, meta, owner, sections: [[name, text], ...] }.
 * text is short (it may become a WebSocket close reason, which holds 123 bytes).
 */
function openFor(id, key) {
  if (!ready) return { ok: false, text: 'Saved worlds are not available on this server.' };
  const tag = tagOf(key);
  const m = validId(id) ? metas.get(id) : null;
  if (!m) return { ok: false, text: 'That saved world is not on this server any more.' };
  if (!canHost(m, tag)) return { ok: false, text: 'Only its owner (or friends they allow) can host that world.' };
  const secs = sectionsOf(id);
  if (!secs) return { ok: false, text: 'That world could not be read just now - try again later.' };
  m.played = now();
  saveIndexSoon();
  return { ok: true, meta: m, owner: isOwner(m, tag), tag, sections: Array.from(secs.entries()) };
}

const saveBuckets = new Map();   // id -> { at, count, bytes } this minute

/** The host's game saves one section of the open world. Empty text removes the section. -> { ok, text } */
function saveSection(id, name, data) {
  const m = validId(id) ? metas.get(id) : null;
  if (!m) return { ok: false, text: 'This world is no longer on the server.' };
  if (!validSection(name)) return { ok: false, text: 'Bad section name.' };
  if (typeof data !== 'string') return { ok: false, text: 'Bad section.' };
  const text = cleanText(data);
  const cap = name === 'layout' ? MAX_LAYOUT : MAX_SECTION;
  if (text.length > cap) return { ok: false, text: `"${name}" is too big to save (${Math.round(text.length / 1024)} KB).` };
  const t = now();
  let b = saveBuckets.get(id);
  if (!b || t - b.at > 60000) { b = { at: t, count: 0, bytes: 0 }; saveBuckets.set(id, b); }
  if (b.count >= SAVES_PER_MINUTE || b.bytes + text.length > SAVE_BYTES_PER_MINUTE) return { ok: false, text: 'Saving a lot - this change will be saved in a moment.', busy: true };
  const secs = sectionsOf(id);
  if (!secs) return { ok: false, text: 'This world could not be read, so it was not changed.' };
  const before = secs.has(name) ? secs.get(name).length : 0;
  if (!secs.has(name) && text.length > 0 && secs.size >= MAX_SECTIONS) return { ok: false, text: 'This world has too many parts to add another.' };
  const after = m.bytes - before + text.length;
  if (after > MAX_WORLD) return { ok: false, text: 'This world is full (1 MB) - clear some things out to save more.' };
  if (text.length > before && totalBytes - m.bytes + after > MAX_TOTAL) return { ok: false, text: 'The server is out of space for worlds right now.' };
  b.count++;
  b.bytes += text.length;
  if (text.length === 0) secs.delete(name); else secs.set(name, text);
  totalBytes += after - m.bytes;
  m.bytes = after;
  m.sections = Array.from(secs.keys());
  m.updated = t;
  saveWorldSoon(id);
  return { ok: true, text: '' };
}

/** The host's game says who has played in the world (newest first is kept). */
function notePeople(id, list) {
  const m = validId(id) ? metas.get(id) : null;
  if (!m || !Array.isArray(list)) return;
  const t = now();
  if (t - (m.peopleAt || 0) < PEOPLE_GAP) return;
  m.peopleAt = t;
  let changed = false;
  for (const raw of list.slice(0, 40)) {
    const p = cleanPerson({ t: raw && raw.t, n: raw && raw.n, at: t });
    if (!p) continue;
    const old = m.people.findIndex(x => x.t === p.t);
    if (old >= 0) m.people.splice(old, 1);
    m.people.unshift(p);
    // A friend who can host keeps their newest name too.
    for (const h of m.hosts) if (h.t === p.t) h.n = p.n;
    changed = true;
  }
  if (!changed) return;
  m.people = m.people.slice(0, MAX_PEOPLE);
  saveIndexSoon();
}

/** The world's room closed. */
function closed(id) {
  const m = validId(id) ? metas.get(id) : null;
  if (!m) return;
  m.played = now();
  saveIndexSoon();
  trimCache();
}

/** What the Festivals list shows about a room's world (or null). */
function listingFor(id) {
  const m = validId(id) ? metas.get(id) : null;
  return m ? { id: m.id, name: m.name, people: m.people.slice(0, 8).map(p => p.n) } : null;
}

load();

module.exports = {
  handle, attach, openFor, saveSection, notePeople, closed, listingFor, flush, tagOf,
  _test: { metas, cache, sweep, cleanText, cleanWorldName, DIR, PERSISTENT }
};
