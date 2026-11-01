'use strict';
// Round 115 (accounts115): ACCOUNT STORAGE THAT STAYS FAST AND SMALL AT 50,000+ ACCOUNTS (players.js uses this file).
//
// Before: every account WITH its saved game (identity, swag, progress - up to 128 KB each) lived in memory in one object, and
// the whole players.json was rewritten (JSON.stringify + writeFileSync) a few seconds after any change. The load test: 5,000
// accounts = an 88 MB file and a half-second freeze on every save (Node is single-threaded - every live player stalls);
// 10,000 accounts no longer fit in 512 MB.
//
// Now (STORE_DATA_DIR = the Render disk):
//   players.json          the INDEX: every account WITHOUT its saved game (username, email, password hash, sign-in key hashes and
//                         their issue times, terms, store link, device, moderation, blocks, and a tiny "pm" = the saved game's
//                         stamp / role / time for the admin page). About 0.5-1 KB an account. Still one JSON document (one account
//                         per line), read at start-up with a streaming scanner (never one big JSON.parse), written by
//                         COMPACTION: in small slices (a few ms each) to players.json.tmp, fsync, then renamed over players.json
//                         (atomic). The version before is kept as players.json.bak (a hard link - instant).
//   players.journal.<n>   every change since that compaction, one line each (appended within ~0.3 s, async + fdatasync). On
//                         start-up: players.json, then the journals from its generation on. Compaction runs when the journal
//                         gets big next to the index (or every 10 minutes, or straight away while the index is small).
//   players/<ab>/<uid>.json  each account's SAVED GAME in its own file (ab = the first 2 hex of sha256(uid): 256 folders), read
//                         when the game asks for it (GET /players/progress), written atomically (temp file, fdatasync, rename)
//                         when it sends one. A small LRU cache (ACCOUNT_CACHE_MB, 24 MB) keeps the recently used ones.
//   players.pre115.json   the ORIGINAL players.json from before this update (kept by the one-time migration - see players.js).
// No secrets in this file; nothing here ever runs on its own - players.js drives it.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const gzipP = promisify(zlib.gzip);
const gunzipP = promisify(zlib.gunzip);

const UID_RE = /^u[0-9a-f]{24}$/;
const nextTick = () => new Promise(r => setImmediate(r));

// ------------------------------------------------------------------ the streaming JSON scanner
//
// Reads a JSON document of the shape { ...top-level members..., "players": { "<key>": {...}, ... }, ... } piece by piece and
// hands over each top-level member and EACH ACCOUNT separately (each parsed on its own - small). Works for the old players.json
// (one long line, saved games inside), the new index (one account per line) and anything a person writes with JSON.stringify.
// Throws on a document that is damaged or cut short (so the caller falls back to the .bak copy).

function makeScanner(accountsKey) {
  let depth = 0, inStr = false, esc = false, done = false, started = false;
  let exp1 = 'key', exp2 = 'key', inPlayers = false;
  let capOn = false, capKind = '', capDepth = 0, capFrom = 0, capParts = [];
  let k1 = null, k2 = null;
  const tops = [], accounts = [];

  const bad = (why) => { throw new Error('damaged JSON (' + why + ')'); };
  function startCap(kind, i, d) { capOn = true; capKind = kind; capDepth = d; capFrom = i; capParts = []; }
  function endCap(s, end) {
    capParts.push(s.slice(capFrom, end));
    const text = capParts.join('');
    capParts = []; capOn = false;
    const kind = capKind; capKind = '';
    if (kind === 'k1') { k1 = JSON.parse(text); exp1 = 'colon'; }
    else if (kind === 'k2') { k2 = JSON.parse(text); exp2 = 'colon'; }
    else if (kind === 'v1') { tops.push([k1, JSON.parse(text)]); exp1 = 'comma'; }
    else if (kind === 'v2') { accounts.push([k2, JSON.parse(text)]); exp2 = 'comma'; }
  }

  function feed(s) {
    capFrom = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true;
        else if (c === 34) {
          inStr = false;
          if (capOn && (capKind === 'k1' || capKind === 'k2' || depth === capDepth)) endCap(s, i + 1);
        }
        continue;
      }
      if (c === 32 || c === 10 || c === 13 || c === 9) continue;
      if (done) bad('text after the end');
      if (depth === 0) {
        if (c !== 123 || started) bad('not an object');
        started = true; depth = 1; exp1 = 'key';
        continue;
      }
      if (c === 34) {   // "
        inStr = true;
        if (capOn) continue;
        if (depth === 1 && !inPlayers && exp1 === 'key') startCap('k1', i, 1);
        else if (depth === 2 && inPlayers && exp2 === 'key') startCap('k2', i, 2);
        else if (depth === 1 && !inPlayers && exp1 === 'value') startCap('v1', i, 1);
        else if (depth === 2 && inPlayers && exp2 === 'value') startCap('v2', i, 2);
        else bad('unexpected string');
        continue;
      }
      if (c === 123 || c === 91) {   // { [
        if (capOn) { depth++; continue; }
        if (depth === 1 && !inPlayers && exp1 === 'value') {
          if (c === 123 && k1 === accountsKey) { inPlayers = true; depth = 2; exp2 = 'key'; exp1 = 'comma'; continue; }
          startCap('v1', i, 1); depth++; continue;
        }
        if (depth === 2 && inPlayers && exp2 === 'value') { startCap('v2', i, 2); depth++; continue; }
        bad('unexpected bracket');
      }
      if (c === 125 || c === 93) {   // } ]
        depth--;
        if (depth < 0) bad('too many closing brackets');
        if (capOn) {
          if (depth === capDepth) { endCap(s, i + 1); continue; }
          if (depth === capDepth - 1) endCap(s, i);   // (a number / true / false / null ended by its parent closing)
          else continue;
        }
        if (inPlayers && depth === 1) { inPlayers = false; exp1 = 'comma'; continue; }
        if (depth === 0) { done = true; continue; }
        continue;
      }
      if (c === 44) {   // ,
        if (capOn) { if (depth === capDepth) { endCap(s, i); if (capDepth === 1) exp1 = 'key'; else exp2 = 'key'; } continue; }
        if (depth === 1 && !inPlayers && exp1 === 'comma') { exp1 = 'key'; continue; }
        if (depth === 2 && inPlayers && exp2 === 'comma') { exp2 = 'key'; continue; }
        bad('unexpected comma');
      }
      if (c === 58) {   // :
        if (capOn) continue;
        if (depth === 1 && !inPlayers && exp1 === 'colon') { exp1 = 'value'; continue; }
        if (depth === 2 && inPlayers && exp2 === 'colon') { exp2 = 'value'; continue; }
        bad('unexpected colon');
      }
      // a number, true, false or null
      if (capOn) continue;
      if (depth === 1 && !inPlayers && exp1 === 'value') { startCap('v1', i, 1); continue; }
      if (depth === 2 && inPlayers && exp2 === 'value') { startCap('v2', i, 2); continue; }
      bad('unexpected character');
    }
    if (capOn) { capParts.push(s.slice(capFrom)); capFrom = 0; }
    const out = { tops: tops.splice(0), accounts: accounts.splice(0) };
    return out;
  }
  return { feed, finished: () => done };
}

/**
 * Scans a JSON file (or a string / Buffer) of the players shape. onTop(key, value) for each top-level member (in order);
 * onAccounts([[key, record], ...]) for each slice of accounts (may return a promise - it's waited for, so a slow consumer
 * slows the reading, never the server). Throws if the document is damaged or cut short. -> {accounts: n}
 */
async function scanJson(source, onTop, onAccounts, accountsKey = 'players') {
  const sc = makeScanner(accountsKey);
  let n = 0;
  const take = async (piece) => {
    const got = sc.feed(piece);
    for (const [k, v] of got.tops) onTop(k, v);
    if (got.accounts.length) { n += got.accounts.length; const r = onAccounts(got.accounts); if (r && r.then) await r; }
  };
  if (typeof source === 'string' && !source.trimStart().startsWith('{')) {
    const stream = fs.createReadStream(source, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    for await (const piece of stream) { await take(piece); await nextTick(); }
  } else {
    const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
    for (let i = 0; i < text.length; i += 256 * 1024) { await take(text.slice(i, i + 256 * 1024)); await nextTick(); }
  }
  if (!sc.finished()) throw new Error('damaged JSON (cut short)');
  return { accounts: n };
}

// ------------------------------------------------------------------ the index snapshot (players.json) - written in slices

/**
 * Writes header + every record (recOf(key) -> the record, or null to leave it out) as one JSON document, one account per line,
 * to <file>.tmp in slices of ~400 accounts (each a few ms), fsyncs it, keeps the current file as <file>.bak (when keepBak) and
 * renames the new one into place. -> {bytes, count}
 */
async function writeSnapshot(file, header, keys, recOf, keepBak) {
  const tmp = file + '.tmp';
  const fh = await fsp.open(tmp, 'w');
  let bytes = 0, count = 0;
  try {
    const head = JSON.stringify(header);
    const open = head.slice(0, -1) + (head.length > 2 ? ',' : '') + '"players":{\n';
    await fh.write(open); bytes += Buffer.byteLength(open);
    let first = true;
    for (let i = 0; i < keys.length; i += 400) {
      const parts = [];
      const end = Math.min(keys.length, i + 400);
      for (let j = i; j < end; j++) {
        const r = recOf(keys[j]);
        if (!r) continue;
        parts.push((first ? '' : ',\n') + JSON.stringify(keys[j]) + ':' + JSON.stringify(r));
        first = false; count++;
      }
      if (parts.length) { const s = parts.join(''); await fh.write(s); bytes += Buffer.byteLength(s); }
    }
    await fh.write('\n}}\n'); bytes += 4;
    await fh.datasync();
  } finally { await fh.close(); }
  if (keepBak) {
    try {
      await fsp.rm(file + '.bak', { force: true });
      await fsp.link(file, file + '.bak');
    } catch (err) {
      if (err && err.code !== 'ENOENT') { try { await fsp.copyFile(file, file + '.bak'); } catch { /* best effort */ } }
    }
  }
  await fsp.rename(tmp, file);
  return { bytes, count };
}

// ------------------------------------------------------------------ the journal (players.journal.<gen>)

class Journal {
  constructor(dir, base) { this.dir = dir; this.base = base; this.gen = 0; this.fh = null; this.bytes = 0; this.chain = Promise.resolve(); }
  file(gen) { return path.join(this.dir, `${this.base}.${gen}`); }
  /** The generations of journal files on the disk, oldest first. */
  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const re = new RegExp('^' + this.base.replace(/\./g, '\\.') + '\\.(\\d+)$');
    return names.map(n => re.exec(n)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);
  }
  /** Replays journal generations >= fromGen in order: onEntry(object) per line. A damaged LAST line (a crash mid-write) is
   *  skipped. -> lines applied. */
  async replay(fromGen, onEntry) {
    let n = 0;
    for (const g of this.list()) {
      if (g < fromGen) continue;
      const text = await fsp.readFile(this.file(g), 'utf8');
      const lines = text.split('\n');
      // Batches start with a {s, q} line; they're applied in q order (the batch written synchronously at exit may sit in the
      // file before one that was still on its way - q puts them back in the order they were made).
      const batches = [];
      let cur = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { console.error(`accounts: journal ${g} line ${i + 1} unreadable (skipped - a crash while it was being written)`); continue; }
        if (e && typeof e.s === 'string') { cur = { q: Number(e.q) || 0, at: batches.length, list: [] }; batches.push(cur); }
        else if (!cur) { cur = { q: -1, at: batches.length, list: [] }; batches.push(cur); }
        cur.list.push(e);
        if ((i & 4095) === 4095) await nextTick();
      }
      batches.sort((a, b) => (a.q - b.q) || (a.at - b.at));
      for (const b of batches) {
        for (const e of b.list) { onEntry(e); n++; if ((n & 1023) === 0) await nextTick(); }
      }
    }
    return n;
  }
  /** Starts writing generation <gen> (appends if it exists). */
  async open(gen) {
    await this.chain;
    if (this.fh) { const old = this.fh; this.fh = null; await old.close().catch(() => {}); }
    this.gen = gen;
    this.fh = await fsp.open(this.file(gen), 'a');
    try { this.bytes = (await this.fh.stat()).size; } catch { this.bytes = 0; }
  }
  /** Appends lines (strings without newlines) and fdatasyncs - one at a time, in order. */
  append(lines) {
    const text = lines.join('\n') + '\n';
    const run = this.chain.then(async () => {
      if (!this.fh) await this.open(this.gen);
      await this.fh.write(text);
      await this.fh.datasync();
      this.bytes += Buffer.byteLength(text);
    });
    this.chain = run.catch(() => {});
    return run;
  }
  /** At exit: the lines straight onto the disk, synchronously (tiny - only what hadn't gone out yet). */
  appendSync(lines) {
    if (!lines.length) return;
    const text = lines.join('\n') + '\n';
    fs.appendFileSync(this.file(this.gen), text);
    this.bytes += Buffer.byteLength(text);   // (so the compaction at exit knows there's something to fold in)
  }
  /** Removes journal generations < keepFrom. */
  async prune(keepFrom) {
    for (const g of this.list()) if (g < keepFrom) await fsp.rm(this.file(g), { force: true }).catch(() => {});
  }
  /** Moves every journal file aside (they belong to an older layout the current players.json replaced). */
  archiveAll(tag) {
    for (const g of this.list()) { try { fs.renameSync(this.file(g), this.file(g) + '.' + tag); } catch { /* */ } }
  }
}

// ------------------------------------------------------------------ the saved games (players/<ab>/<uid>.json) + LRU cache

class Saves {
  constructor(dir, capBytes) {
    this.dir = dir;
    this.cap = capBytes;
    this.cache = new Map();   // uid -> {v, n}
    this.cached = 0;
    this.inflight = new Map();
    this.locks = new Map();
    this.dirs = new Set();
    this.reads = 0; this.writes = 0; this.hits = 0;
  }
  shardOf(uid) { return crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 2); }
  file(uid) {
    if (!UID_RE.test(String(uid))) throw new Error('bad uid');
    return path.join(this.dir, this.shardOf(uid), uid + '.json');
  }
  _remember(uid, v, n) {
    const had = this.cache.get(uid);
    if (had) { this.cached -= had.n; this.cache.delete(uid); }
    if (v === undefined) return;
    const size = (n || 0) + 300;
    if (size > this.cap / 4) return;   // (one huge save never pushes everyone else out)
    this.cache.set(uid, { v, n: size });
    this.cached += size;
    while (this.cached > this.cap && this.cache.size) {
      const [oldUid, old] = this.cache.entries().next().value;
      this.cache.delete(oldUid); this.cached -= old.n;
    }
  }
  /** The saved game (an object) or null when there's none. Cached; one disk read at a time per account. */
  read(uid) {
    const hit = this.cache.get(uid);
    if (hit) { this.cache.delete(uid); this.cache.set(uid, hit); this.hits++; return Promise.resolve(hit.v); }
    if (this.inflight.has(uid)) return this.inflight.get(uid);
    const job = (async () => {
      let text = null;
      try { text = await fsp.readFile(this.file(uid), 'utf8'); } catch (err) { if (err && err.code !== 'ENOENT') throw err; }
      this.reads++;
      let v = null;
      if (text !== null) {
        try { v = JSON.parse(text); } catch {
          console.error('accounts: a saved game file was unreadable - kept aside as .damaged', uid);
          await fsp.rename(this.file(uid), this.file(uid) + '.damaged').catch(() => {});
          v = null;
        }
      }
      if (this.inflight.get(uid) === job) this._remember(uid, v, text ? text.length : 0);
      return v;
    })();
    this.inflight.set(uid, job);
    job.then(() => { if (this.inflight.get(uid) === job) this.inflight.delete(uid); }, () => { if (this.inflight.get(uid) === job) this.inflight.delete(uid); });
    return job;
  }
  /** Writes the saved game atomically (temp file, fdatasync, rename). */
  async write(uid, v) {
    const file = this.file(uid);
    const text = JSON.stringify(v);
    const folder = path.dirname(file);
    if (!this.dirs.has(folder)) { await fsp.mkdir(folder, { recursive: true }); this.dirs.add(folder); }
    const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    const fh = await fsp.open(tmp, 'w');
    try { await fh.write(text); await fh.datasync(); } finally { await fh.close(); }
    await fsp.rename(tmp, file);
    this.inflight.delete(uid);
    this._remember(uid, v, text.length);
    this.writes++;
  }
  /** Deletes the saved game's file (and its cached copy). */
  async remove(uid) {
    this.inflight.delete(uid);
    this._remember(uid, undefined);
    try { await fsp.rm(this.file(uid), { force: true }); } catch { /* */ }
  }
  /** Drops the cached copy only (the file is removed later, once the deletion is safely in the journal). */
  forget(uid) { this.inflight.delete(uid); this._remember(uid, undefined); }
  /** For exports and backups: the cached copy, else the file - WITHOUT filling the cache (players playing keep theirs). */
  async peek(uid) {
    const hit = this.cache.get(uid);
    if (hit) return hit.v;
    try { return JSON.parse(await fsp.readFile(this.file(uid), 'utf8')); } catch { return null; }
  }
  /** The file's text as it is on the disk (or null). */
  async raw(uid) { try { return await fsp.readFile(this.file(uid), 'utf8'); } catch { return null; } }
  exists(uid) { try { return fs.existsSync(this.file(uid)); } catch { return false; } }
  /** Runs fn() for this account only after its earlier jobs (a read-change-write never interleaves with another). */
  lock(uid, fn) {
    const prev = this.locks.get(uid) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    this.locks.set(uid, tail);
    tail.then(() => { if (this.locks.get(uid) === tail) this.locks.delete(uid); });
    return run;
  }
  /** The uids that have a file in shard <ab> (and stray temp files to clear). */
  async listShard(ab) {
    let names = [];
    try { names = await fsp.readdir(path.join(this.dir, ab)); } catch { return { uids: [], tmp: [] }; }
    const uids = [], tmp = [];
    for (const n of names) {
      if (n.endsWith('.tmp')) tmp.push(n);
      else if (n.endsWith('.json') && UID_RE.test(n.slice(0, -5))) uids.push(n.slice(0, -5));
    }
    return { uids, tmp };
  }
  async shards() {
    try { return (await fsp.readdir(this.dir)).filter(n => /^[0-9a-f]{2}$/.test(n)).sort(); } catch { return []; }
  }
  stats() { return { cached: this.cache.size, cachedMB: Math.round(this.cached / 104857.6) / 10, capMB: Math.round(this.cap / 1048576), reads: this.reads, writes: this.writes, hits: this.hits }; }
}

// ------------------------------------------------------------------ sealed boxes for the GitHub backup (gzip + AES-256-GCM)

/** -> the box text (JSON): {v:2, z:"gzip", iv, tag, data, ...meta}. */
async function packBox(plain, key, meta) {
  const zipped = await gzipP(Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8'));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const parts = [];
  for (let i = 0; i < zipped.length; i += 1 << 20) { parts.push(c.update(zipped.subarray(i, i + (1 << 20)))); if (i) await nextTick(); }
  parts.push(c.final());
  return JSON.stringify(Object.assign({ v: 2, z: 'gzip', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: Buffer.concat(parts).toString('base64') }, meta || {}));
}

/** Opens a box (v:1 - the old single-file backup - or v:2) with the first key that fits. -> {buf, keyIndex}. */
async function openBox(text, keys) {
  const box = typeof text === 'string' ? JSON.parse(text) : text;
  if (!keys.length) throw new Error('BACKUP_KEY / ADMIN_KEY not set');
  const data = Buffer.from(box.data, 'base64');
  let last = null;
  for (const [i, key] of keys.entries()) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
      d.setAuthTag(Buffer.from(box.tag, 'base64'));
      const parts = [];
      for (let j = 0; j < data.length; j += 1 << 20) { parts.push(d.update(data.subarray(j, j + (1 << 20)))); if (j) await nextTick(); }
      parts.push(d.final());
      let buf = Buffer.concat(parts);
      if (box.z === 'gzip') buf = await gunzipP(buf);
      return { buf, keyIndex: i, box };
    } catch (err) { last = err; }
  }
  throw last || new Error('could not open the backup');
}

// ------------------------------------------------------------------ the GitHub backup's transport (git data API, one branch)

/**
 * A tiny client for one branch of one repository: blobs, trees, commits and the branch's ref. Every call -> {status, json}.
 * (The base address can only be changed for the automated tests - never on Render.)
 */
function gitClient(repo, token) {
  const base = (!process.env.RENDER && process.env.NMSD_TEST_GITHUB_API) || 'https://api.github.com';
  async function call(method, rel, body) {
    const res = await fetch(`${base}/repos/${repo}/${rel}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'nmsd-server', 'content-type': 'application/json' },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  }
  return {
    base,
    getRef: (branch) => call('GET', `git/ref/heads/${encodeURIComponent(branch)}`),
    getCommit: (sha) => call('GET', `git/commits/${sha}`),
    getTree: (sha) => call('GET', `git/trees/${sha}?recursive=1`),
    async getBlob(sha) {
      const r = await call('GET', `git/blobs/${sha}`);
      if (r.status !== 200 || !r.json) return { status: r.status };
      return { status: 200, buf: Buffer.from(String(r.json.content || ''), r.json.encoding === 'base64' ? 'base64' : 'utf8') };
    },
    // (the body is put together by hand: a 20 MB string isn't copied again by JSON.stringify)
    createBlob: (buf) => call('POST', 'git/blobs', '{"encoding":"base64","content":"' + buf.toString('base64') + '"}'),
    createTree: (baseTree, entries) => call('POST', 'git/trees', Object.assign(baseTree ? { base_tree: baseTree } : {}, { tree: entries })),
    createCommit: (message, tree, parents) => call('POST', 'git/commits', { message, tree, parents }),
    updateRef: (branch, sha, force) => call('PATCH', `git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: !!force }),
    createRef: (branch, sha) => call('POST', 'git/refs', { ref: `refs/heads/${branch}`, sha }),
  };
}

module.exports = { scanJson, writeSnapshot, Journal, Saves, packBox, openBox, gitClient, UID_RE, nextTick };
