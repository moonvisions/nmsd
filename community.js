// Festival Tycoon community creations (Round 45). Round 55: the feed also carries the vendor market's designs (store.js).
//
// Players design their own attractions in the game's Creator Studio and can send them in. Nothing
// goes public by itself: each one waits on your admin page (with a little picture of it) until you
// press Approve. Approved creations are added to the online list, so they stand on the Community
// Plaza at everyone's festival.
//
// Files (next to this one):
//   creations-pending.json    what's waiting for you to look at
//   creations-approved.json   what you approved
// A free Render server forgets files when it restarts from GitHub, so the admin page also shows a
// "keep forever" line to paste into vendors.json - anything there stays for good.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VENDORS_FILE = path.join(__dirname, 'vendors.json');
const PENDING_FILE = path.join(__dirname, 'creations-pending.json');
const APPROVED_FILE = path.join(__dirname, 'creations-approved.json');
const MAX_PENDING = 200;
const MAX_APPROVED = 60;
const CODE_RE = /^FTC1-[A-Za-z0-9_-]{16,4200}$/;

const PALETTE = ['#F4F1EA', '#22242A', '#8A8F98', '#E84A5F', '#F28C28', '#F5D03B', '#9CD84A', '#2FA86A',
  '#3FD6D0', '#3A7BE8', '#6B4EE0', '#C05CF0', '#F06CB8', '#9A623C', '#D9B886', '#556B3A'];
const VIBES = ['Art piece', 'Games corner', 'Chill zone', 'Party spot'];
const SHAPES = ['Block', 'Pillar', 'Ball', 'Pyramid', 'Ring', 'Capsule', 'Screen'];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 1)); } catch (err) { console.error('community save', err && err.message); }
}

let pending = readJson(PENDING_FILE, []);
let approved = readJson(APPROVED_FILE, []);
if (!Array.isArray(pending)) pending = [];
if (!Array.isArray(approved)) approved = [];

/** Reads a share code the same way the game does. Returns null if it isn't a real creation. */
function decode(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) return null;
  let bytes;
  try { bytes = Buffer.from(code.slice(5).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch { return null; }
  let at = 0;
  const byte = () => { if (at >= bytes.length) throw new Error('short'); return bytes[at++]; };
  const i16 = () => { if (at + 2 > bytes.length) throw new Error('short'); const v = bytes.readInt16LE(at); at += 2; return v; };
  const text = () => {
    let length = 0, shift = 0, b;
    do { b = byte(); length |= (b & 0x7f) << shift; shift += 7; } while ((b & 0x80) && shift < 21);
    if (length > 200 || at + length > bytes.length) throw new Error('long');
    const s = bytes.slice(at, at + length).toString('utf8');
    at += length;
    return s;
  };
  try {
    if (byte() !== 1) return null;
    const c = { vibe: Math.min(3, byte()), w: Math.max(2, Math.min(5, byte())), d: Math.max(2, Math.min(5, byte())) };
    c.id = text().replace(/[^a-z0-9]/g, '').slice(0, 16);
    c.name = text().replace(/[<>{}"\\\u0000-\u001f]/g, '').slice(0, 28);
    c.author = text().replace(/[<>{}"\\\u0000-\u001f]/g, '').slice(0, 20);
    const count = byte();
    if (count < 1 || count > 24) return null;
    c.parts = [];
    for (let i = 0; i < count; i++) {
      const p = { shape: byte(), x: i16() / 20, y: i16() / 20, z: i16() / 20, sx: i16() / 20, sy: i16() / 20, sz: i16() / 20, yaw: i16() };
      p.colour = byte(); p.accent = byte(); p.pattern = byte(); p.flags = byte();
      c.parts.push(p);
    }
    return c;
  } catch {
    return null;
  }
}

function tag(code) {
  return crypto.createHash('sha1').update(code).digest('hex').slice(0, 12);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** A small front view and top view of a creation, so you can see what you're approving. */
function picture(c) {
  const W = c.w * 2, D = c.d * 2;
  let top = 1;
  for (const p of c.parts) top = Math.max(top, p.y + p.sy / 2);
  const H = Math.min(14, top);
  const scale = 150 / Math.max(W, H, D);
  const colour = p => PALETTE[Math.max(0, Math.min(15, p.colour))] || '#888';
  const shape = (p, x, y, w, h) => {
    const fill = colour(p);
    const glow = (p.flags & 1) || p.shape === 6 ? ' style="filter:drop-shadow(0 0 3px ' + fill + ')"' : '';
    if (p.shape === 2 || p.shape === 5) return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="#000" stroke-opacity=".3"${glow}/>`;
    if (p.shape === 4) return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2 * 0.88}" ry="${h / 2 * 0.88}" fill="none" stroke="${fill}" stroke-width="${Math.max(2, w * 0.1)}"${glow}/>`;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#000" stroke-opacity=".3"${glow}/>`;
  };
  const front = c.parts.slice().sort((a, b) => b.z - a.z).map(p => {   // farthest first
    const w = p.sx * scale, h = p.sy * scale, x = 80 + (p.x - p.sx / 2) * scale, y = 170 - (p.y + p.sy / 2) * scale;
    return p.shape === 3 ? `<polygon points="${x},${y + h} ${x + w / 2},${y} ${x + w},${y + h}" fill="${colour(p)}"/>` : shape(p, x, y, w, h);
  }).join('');
  const topView = c.parts.slice().sort((a, b) => (a.y + a.sy / 2) - (b.y + b.sy / 2)).map(p => {   // lowest first
    const w = p.sx * scale, h = (p.shape === 4 ? Math.max(0.2, p.sz) : p.sz) * scale;
    const x = 80 + (p.x - p.sx / 2) * scale, y = 90 + (p.z - p.sz / 2) * scale;
    return `<g transform="rotate(${-p.yaw} ${80 + p.x * scale} ${90 + p.z * scale})">${shape(p.shape === 4 ? { ...p, shape: 0 } : p, x, y, w, h)}</g>`;
  }).join('');
  const ground = `<rect x="${80 - W / 2 * scale}" y="170" width="${W * scale}" height="3" fill="#6b8f4e"/>`;
  const plot = `<rect x="${80 - W / 2 * scale}" y="${90 - D / 2 * scale}" width="${W * scale}" height="${D * scale}" fill="#2c3a28" stroke="#e8b14c" stroke-dasharray="3"/>`;
  return `<svg width="160" height="180" viewBox="0 0 160 180" style="background:#1a1d24;border-radius:6px;margin-right:6px">${ground}${front}<text x="4" y="12" fill="#8a93a3" font-size="10">front</text></svg>` +
    `<svg width="160" height="180" viewBox="0 0 160 180" style="background:#1a1d24;border-radius:6px">${plot}${topView}<text x="4" y="12" fill="#8a93a3" font-size="10">from above</text></svg>`;
}

// ---- sending one in (from the game) ----
const hits = new Map();
function submit(req, res, ip) {
  const reply = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' });
    res.end();
    return;
  }
  if (req.method !== 'POST') { reply(405, { ok: false, message: 'Send it from the game.' }); return; }
  const now = Date.now();
  const mine = (hits.get(ip) || []).filter(t => now - t < 3600000);
  if (mine.length >= 6) { reply(429, { ok: false, message: 'You have sent a lot this hour - try again later.' }); return; }
  mine.push(now);   // counted straight away, so many at once can't slip past the limit
  hits.set(ip, mine);
  if (hits.size > 5000) hits.clear();   // never grows without end
  let body = '';
  let tooBig = false;
  req.on('data', chunk => {
    if (tooBig) return;
    body += chunk;
    if (body.length > 8192) {
      tooBig = true;
      res.writeHead(413, { 'content-type': 'application/json', 'access-control-allow-origin': '*', connection: 'close' });
      res.end(JSON.stringify({ ok: false, message: 'That creation is too big to send.' }), () => req.destroy());
    }
  });
  req.on('error', () => {});
  req.on('end', () => {
    if (tooBig) return;
    let data;
    try { data = JSON.parse(body); } catch { reply(400, { ok: false, message: "That didn't arrive properly - try again." }); return; }
    const code = String(data && data.code || '').trim();
    const c = decode(code);
    if (!c) { reply(400, { ok: false, message: "That creation code doesn't work." }); return; }
    if (c.parts.length < 3) { reply(400, { ok: false, message: 'Give it at least 3 pieces first.' }); return; }
    if (pending.some(p => p.code === code) || approved.includes(code)) { reply(200, { ok: true, message: 'Already sent - it is waiting to be looked at.' }); return; }
    if (pending.length >= MAX_PENDING) { reply(503, { ok: false, message: 'The review queue is full right now - try again in a few days.' }); return; }
    pending.push({ id: crypto.randomBytes(6).toString('hex'), code, name: c.name, author: c.author, at: new Date().toISOString() });
    writeJson(PENDING_FILE, pending);
    reply(200, { ok: true, message: 'Sent! It will appear once it is approved.' });
  });
}

// ---- your admin page ----
function adminSection(hidden) {
  const cards = pending.map(p => {
    const c = decode(p.code);
    if (!c) return '';
    const shapes = {};
    for (const part of c.parts) shapes[SHAPES[part.shape] || 'Piece'] = (shapes[SHAPES[part.shape] || 'Piece'] || 0) + 1;
    return `<div style="border:1px solid #2a2f3a;border-radius:8px;padding:10px;margin:10px 0">
<b>${escapeHtml(c.name)}</b> <span class="small">by ${escapeHtml(c.author || 'someone')} &middot; ${VIBES[c.vibe]} &middot; ${c.w}x${c.d} squares &middot;
${Object.entries(shapes).map(([k, v]) => v + ' ' + k.toLowerCase()).join(', ')} &middot; sent ${escapeHtml(String(p.at).slice(0, 10))}</span>
<div style="margin:8px 0">${picture(c)}</div>
<form method="post" action="/admin" style="display:inline">${hidden}<input type="hidden" name="action" value="approve"><input type="hidden" name="item" value="${escapeHtml(p.id)}"><button type="submit">Approve</button></form>
<form method="post" action="/admin" style="display:inline">${hidden}<input type="hidden" name="action" value="reject"><input type="hidden" name="item" value="${escapeHtml(p.id)}"><button type="submit" style="background:#ff8a80">Reject</button></form>
</div>`;
  }).join('');
  const live = approved.map(code => {
    const c = decode(code);
    return c ? `<tr><td><b>${escapeHtml(c.name)}</b> <span class="small">by ${escapeHtml(c.author || 'someone')} &middot; ${VIBES[c.vibe]}</span></td>
<td><form method="post" action="/admin">${hidden}<input type="hidden" name="action" value="unpublish"><input type="hidden" name="item" value="${tag(code)}"><button type="submit">Take down</button></form></td></tr>` : '';
  }).join('');
  const forever = approved.length ? `<p class="small">To keep these for good (a restart from GitHub forgets them), copy this line into vendors.json, just after the opening <code>{</code>, then commit:</p>
<div class="code" style="font-size:11px;letter-spacing:0;text-align:left">"creations": ${escapeHtml(JSON.stringify(allCodes()))},</div>` : '';
  return `<h2>Community creations</h2>
<p>Players' own designs, sent from the game. Nothing goes public until you approve it. Approved ones stand on the Community Plaza at everyone's festival (the newest 12).</p>
<h2 style="font-size:15px">Waiting for you (${pending.length})</h2>${cards || '<p class="small">Nothing waiting.</p>'}
<h2 style="font-size:15px">Approved (${approved.length})</h2><table>${live || '<tr><td class="small">None yet.</td></tr>'}</table>${forever}`;
}

/** Handles an admin button. Returns true if it was one of ours. */
function adminAction(action, item) {
  if (action === 'approve' || action === 'reject') {
    const at = pending.findIndex(p => p.id === item);
    if (at < 0) return true;
    const [p] = pending.splice(at, 1);
    if (action === 'approve' && !approved.includes(p.code)) {
      approved.unshift(p.code);
      if (approved.length > MAX_APPROVED) approved.length = MAX_APPROVED;
      writeJson(APPROVED_FILE, approved);
    }
    writeJson(PENDING_FILE, pending);
    return true;
  }
  if (action === 'unpublish') {
    const i = approved.findIndex(code => tag(code) === item);
    if (i >= 0) {
      approved.splice(i, 1);
      writeJson(APPROVED_FILE, approved);
    }
    return true;
  }
  return false;
}

/** Everything approved: the newest from the admin page first, then any kept in vendors.json. */
function allCodes(fileCodes) {
  if (!fileCodes) {
    const feed = readJson(VENDORS_FILE, {});
    fileCodes = feed && Array.isArray(feed.creations) ? feed.creations : [];
  }
  const out = [];
  for (const c of approved.concat(fileCodes)) if (typeof c === 'string' && CODE_RE.test(c) && !out.includes(c)) out.push(c);
  return out;
}

/**
 * Adds the approved creations to vendors.json as it's sent to the game.
 * Round 55: and the approved vendors' designs from the Moon Shards market (store.js), as their own booths.
 */
function mergeIntoFeed(text) {
  let feed;
  try { feed = JSON.parse(text); } catch { return text; }
  let changed = false;
  if (approved.length) {
    feed.creations = allCodes(Array.isArray(feed.creations) ? feed.creations : []).slice(0, 12);
    changed = true;
  }
  try {
    const before = Array.isArray(feed.vendors) ? feed.vendors.length : 0;
    require('./store').mergeIntoFeed(feed);   // (required here: store.js is loaded by payments.js)
    if ((Array.isArray(feed.vendors) ? feed.vendors.length : 0) !== before) changed = true;
  } catch (err) {
    console.error('store feed', err && err.message);
  }
  return changed ? JSON.stringify(feed) : text;
}

module.exports = { submit, adminSection, adminAction, mergeIntoFeed, decode };
