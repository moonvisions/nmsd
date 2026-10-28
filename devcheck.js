'use strict';
// Round 112 (devcheck112): DEVICE CHECK REPORTS - the game's one-tap "Run device check" (Settings) walks its own screens on the
// player's phone / PC, checks each one and sends what it found here, with a screenshot of every screen.
//
//   POST /devcheck              the game sends one report (JSON, screenshots as base64 JPGs). No account needed. Limits: 4 MB a
//                               report, 5 tries a day from one address, 20 a day in all, 2 at once (so a stranger can't push the real
//                               ones out). Only what the report format allows is kept: names / emails never come (the game
//                               blacks them out of the pictures and the words), and everything is cleaned and cut to size.
//   GET  /admin/devcheck        (signed in) every report, newest first
//   GET  /admin/devcheck?r=...  one report: the device, then each screen's screenshot with the problems boxed on it (an SVG
//                               drawn over the picture) and listed under it
//   GET  /admin/devcheck/img    (signed in) one screenshot
//   POST /admin/devcheck        (signed in + the page's CSRF token) delete one report
// FILES: DEVCHECK_DIR, else STORE_DATA_DIR/devcheck (the permanent disk), else ./devcheck - one folder per report
// (report.json + shot-NN.jpg). The newest 30 are kept. The folder is in .gitignore: the GitHub repository is PUBLIC.
// Everything a report says is escaped on the page (esc) or written as plain numbers - nothing from a phone becomes HTML.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ui = require('./adminui');
const auth = require('./adminauth');
const { esc, fmt } = ui;
const pay = () => require('./payments');

const DIR = process.env.DEVCHECK_DIR || path.join(process.env.STORE_DATA_DIR || __dirname, 'devcheck');
const KEEP = 40;   // Round 112 (sec112 M2): more than a day's worth (ALL_DAY) - strangers can't push the real reports out in a day
const MAX_BYTES = 4 * 1024 * 1024;   // Round 112 (sec112 H1): was 8 MB - two 8 MB JSON parses at once could exhaust a 512 MB server
const MAX_SHOT = 1536 * 1024;
const PER_IP_DAY = 5;
const ALL_DAY = 20;
const MAX_INFLIGHT = 2;   // Round 112 (sec112 H1): uploads being read / parsed at once (others: 503, try again)
let inflight = 0;
const DAY = 86400000;
const MAX_STEPS = 60, MAX_PROBLEMS = 60;
const KINDS = ['overlap', 'offscreen', 'clipped', 'glyph', 'tap', 'reach'];
const STATUSES = ['ok', 'problems', 'failed', 'skipped'];
const ID_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const KEY_RE = /^\d{8}-\d{6}-\d{3}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;   // (arrival to the millisecond, then the id)

const byIp = new Map();   // address -> [times]
let all = [];             // every accepted report's time (24 h)

// ------------------------------------------------------------------ cleaning what a phone sent

function str(v, max) {
  // eslint-disable-next-line no-control-regex
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}
function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(-100000, Math.min(100000, n)) * 10) / 10;
}
function rect(v) { return Array.isArray(v) && v.length === 4 ? v.map(num) : [0, 0, 0, 0]; }
function pair(v) { return Array.isArray(v) && v.length === 2 ? v.map(num) : [0, 0]; }

/** The report as stored (shots separate), or a reason it was refused. */
function clean(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { why: 'not a report' };
  const id = String(r.id || '');
  if (!ID_RE.test(id)) return { why: 'no valid report id' };
  if (!Array.isArray(r.steps) || !r.steps.length) return { why: 'no steps' };
  const d = r.device && typeof r.device === 'object' ? r.device : {};
  const s = r.screen && typeof r.screen === 'object' ? r.screen : {};
  const out = {
    v: 1, id, received: new Date().toISOString(), made: str(r.made, 40), build: str(r.build, 40),
    device: { model: str(d.model, 80), os: str(d.os, 120), platform: str(d.platform, 40), type: str(d.type, 40), gpu: str(d.gpu, 120), memoryMB: num(d.memoryMB) },
    screen: { w: num(s.w), h: num(s.h), dpi: num(s.dpi), safe: rect(s.safe), view: pair(s.view), safeView: rect(s.safeView), uiScale: str(s.uiScale, 30), touch: s.touch === true },
    seconds: num(r.seconds), problems: 0, glyphs: str(r.glyphs, 400), steps: []
  };
  const shots = [];
  for (const st of r.steps.slice(0, MAX_STEPS)) {
    if (!st || typeof st !== 'object') continue;
    const step = {
      name: str(st.name, 60), title: str(st.title, 120), status: STATUSES.includes(st.status) ? st.status : 'failed',
      note: str(st.note, 600), seconds: num(st.seconds), view: pair(st.view), more: Math.max(0, Math.floor(num(st.more))), problems: [], shot: null
    };
    for (const p of (Array.isArray(st.problems) ? st.problems : []).slice(0, MAX_PROBLEMS)) {
      if (!p || typeof p !== 'object') continue;
      step.problems.push({ kind: KINDS.includes(p.kind) ? p.kind : 'other', path: str(p.path, 400), text: str(p.text, 120), detail: str(p.detail, 400), rect: rect(p.rect) });
    }
    out.problems += step.problems.length + step.more;
    const sh = st.shot;
    if (sh && typeof sh === 'object' && typeof sh.jpg === 'string' && sh.jpg.length <= MAX_SHOT * 4 / 3 + 4 && /^[A-Za-z0-9+/=]+$/.test(sh.jpg)) {
      const buf = Buffer.from(sh.jpg, 'base64');
      // Round 112 (sec112 L4): a JPEG start AND end marker (trailing zero padding allowed), nothing else
      let end = buf.length;
      while (end > 4 && buf[end - 1] === 0) end--;
      if (buf.length >= 4 && buf.length <= MAX_SHOT && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF && buf[end - 2] === 0xFF && buf[end - 1] === 0xD9) {
        step.shot = { w: num(sh.w), h: num(sh.h), file: `shot-${String(out.steps.length).padStart(2, '0')}.jpg` };
        shots.push([step.shot.file, buf]);
      }
    }
    out.steps.push(step);
  }
  return { report: out, shots };
}

// ------------------------------------------------------------------ storing

function keyFor(id) {
  const t = new Date().toISOString();
  return `${t.slice(0, 10).replace(/-/g, '')}-${t.slice(11, 19).replace(/:/g, '')}-${t.slice(20, 23)}-${id}`;
}

function store(report, shots) {
  fs.mkdirSync(DIR, { recursive: true });
  let key = keyFor(report.id);
  if (fs.existsSync(path.join(DIR, key))) return null;   // (the same report twice in one millisecond)
  const tmp = path.join(DIR, '.tmp-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(tmp);
  try {
    for (const [file, buf] of shots) fs.writeFileSync(path.join(tmp, file), buf);
    fs.writeFileSync(path.join(tmp, 'report.json'), JSON.stringify(report));
    fs.renameSync(tmp, path.join(DIR, key));
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  prune();
  return key;
}

/** Report folders, newest first. */
function keys() {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return []; }
  return names.filter(n => KEY_RE.test(n)).sort().reverse();
}

function prune() {
  for (const k of keys().slice(KEEP)) fs.rmSync(path.join(DIR, k), { recursive: true, force: true });
  try { for (const n of fs.readdirSync(DIR)) if (n.startsWith('.tmp-')) fs.rmSync(path.join(DIR, n), { recursive: true, force: true }); } catch { /* */ }
}

function load(key) {
  if (!KEY_RE.test(String(key || ''))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DIR, key, 'report.json'), 'utf8')); } catch { return null; }
}

// ------------------------------------------------------------------ POST /devcheck

function json(res, status, obj, extra) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra || {}));
  res.end(JSON.stringify(obj));
}

function recent(list, now) { return list.filter(t => now - t < DAY); }

function receive(req, res) {
  const now = Date.now();
  const ip = auth.ipOf(req);
  all = recent(all, now);
  const mine = recent(byIp.get(ip) || [], now);
  if (mine.length >= PER_IP_DAY) return json(res, 429, { ok: false, message: 'Enough device checks from here for today - try again tomorrow.' }, { 'retry-after': String(Math.ceil((mine[0] + DAY - now) / 1000)) });
  if (all.length >= ALL_DAY) return json(res, 429, { ok: false, message: 'The server has had enough device checks for today.' }, { 'retry-after': '3600' });
  if (inflight >= MAX_INFLIGHT) { json(res, 503, { ok: false, message: 'Busy - try again in a minute.' }, { 'retry-after': '60', connection: 'close' }); res.once('finish', () => req.destroy()); return; }
  // Round 112 (sec112 H1/M2): every attempt counts from the moment it starts (refused, oversized or broken ones too), so the
  // limits can't be dodged by failing on purpose or by holding many uploads open at once.
  mine.push(now); byIp.set(ip, mine.slice(-20)); all.push(now);
  if (byIp.size > 5000) byIp.delete(byIp.keys().next().value);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BYTES) { json(res, 413, { ok: false, message: 'The report is too big (4 MB at most).' }, { connection: 'close' }); res.once('finish', () => req.destroy()); return; }
  inflight++;
  let released = false;
  const release = () => { if (!released) { released = true; inflight--; } };
  res.on('close', release);
  res.on('finish', release);
  const chunks = [];
  let size = 0, over = false;
  req.on('data', c => {
    if (over) return;
    size += c.length;
    if (size > MAX_BYTES) { over = true; chunks.length = 0; json(res, 413, { ok: false, message: 'The report is too big (4 MB at most).' }, { connection: 'close' }); res.once('finish', () => req.destroy()); return; }   // Round 112 (sec112 L5): destroy, not drain
    chunks.push(c);
  });
  req.on('error', () => { if (!res.headersSent) json(res, 400, { ok: false }); });
  req.on('end', () => {
    if (over || res.headersSent) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { ok: false, message: 'That isn\'t a report.' }); }
    const c = clean(body);
    if (c.why) return json(res, 400, { ok: false, message: 'That isn\'t a report: ' + c.why + '.' });
    let key;
    try { key = store(c.report, c.shots); } catch (e) { console.error('devcheck: store', e && e.message); return json(res, 500, { ok: false, message: 'Couldn\'t keep the report - try again.' }); }
    if (!key) return json(res, 409, { ok: false, message: 'That report is already here.' });
    console.log(`devcheck: report ${c.report.id} (${c.report.device.model}, ${c.report.problems} problems, ${c.shots.length} shots)`);
    json(res, 200, { ok: true, id: c.report.id });
  });
}

// ------------------------------------------------------------------ the admin pages

const PAGE_CSS = `<style>
.dc-table{width:100%;border-collapse:collapse;font-size:14px}.dc-table th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:8px;border-bottom:1px solid var(--line)}
.dc-table td{padding:10px 8px;border-bottom:1px solid var(--grid)}.dc-table td.n{font-variant-numeric:tabular-nums;text-align:right}
.dc-table a{font-weight:600}.dc-id{font:600 13px ui-monospace,Menlo,monospace;letter-spacing:.04em}
.badge{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700}.b-ok{background:#0ca30c33;color:var(--good-text)}.b-problems{background:#fab21933;color:var(--warn)}
.b-failed{background:#d03b3b33;color:var(--bad-text)}.b-skipped{background:#82899b33;color:var(--text2)}
.dc-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:0 0 14px}
.dc-meta div{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}.dc-meta b{display:block;font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.dc-meta span{display:block;overflow-wrap:anywhere}
.dc-kinds{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px}.dc-kinds span{border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:13px;color:var(--text2);background:var(--surface)}
.dc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(460px,100%),1fr));gap:14px}
.dc-step{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;min-width:0}
.dc-step h2{font-size:15px;margin:0;padding:11px 14px;display:flex;gap:8px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}
.dc-step h2 small{color:var(--muted);font-weight:500;font-size:12px}
.dc-shot{position:relative;background:#05070b;line-height:0}.dc-shot img{width:100%;height:auto;display:block}
.dc-shot svg{position:absolute;inset:0;width:100%;height:100%}.dc-none{padding:30px 14px;color:var(--muted);font-size:13px;text-align:center}
.dc-step ol{margin:0;padding:10px 14px 12px 36px;font-size:13px;color:var(--text2)}.dc-step li{margin:0 0 7px;overflow-wrap:anywhere}
.dc-step li .k{display:inline-block;min-width:64px;font-weight:700;color:var(--text)}.dc-step li .p{display:block;color:var(--muted);font-size:12px;font-family:ui-monospace,Menlo,monospace}
.dc-note{padding:8px 14px 0;font-size:13px;color:var(--text2)}.dc-empty{color:var(--muted)}
.dc-key{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--muted);margin:0 0 12px}.dc-key i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;margin-right:5px}
@media (max-width:640px){.dc-table .w{display:none}}
</style>`;

const COLOURS = { overlap: '#ff5a5f', offscreen: '#ff9f1c', clipped: '#f7d02c', glyph: '#c77dff', tap: '#3fb8ff', reach: '#ff4fa3', other: '#cfd3dc' };
const KIND_NAMES = { overlap: 'Overlap', offscreen: 'Off screen', clipped: 'Clipped text', glyph: 'Missing glyph', tap: 'Small tap target', reach: 'Not reachable', other: 'Other' };
const badge = s => `<span class="badge b-${esc(s)}">${esc(s)}</span>`;
const when = iso => esc(String(iso || '').slice(0, 16).replace('T', ' ')) + ' UTC';

function listPage(res) {
  const rows = [];
  for (const k of keys()) {
    const r = load(k);
    if (!r) continue;
    rows.push(`<tr><td>${when(r.received)}</td><td><a class="dc-id" href="/admin/devcheck?r=${encodeURIComponent(k)}">${esc(r.id)}</a></td>
<td>${esc(r.device.model)}<br><small class="small">${esc(r.device.os)}</small></td><td class="w">${esc(r.build)}</td><td class="w n">${fmt(r.screen.w)} x ${fmt(r.screen.h)}</td>
<td class="n">${fmt(r.steps.length)}</td><td class="n">${r.problems ? `<b>${fmt(r.problems)}</b>` : '0'}</td></tr>`);
  }
  const html = [ui.CSS, PAGE_CSS,
    `<div class="pagehead"><div><h1>Device checks</h1><p>Reports from Settings &gt; Device check in the game, newest first. The newest ${KEEP} are kept.</p></div></div>`,
    rows.length ? `<section class="card"><table class="dc-table"><thead><tr><th>Received</th><th>Report ID</th><th>Device</th><th class="w">Build</th><th class="w">Screen</th><th>Screens</th><th>Problems</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>`
      : `<section class="card"><p class="dc-empty">No device checks yet. In the game: Settings &gt; Game &gt; Device check &gt; Run device check.</p></section>`];
  pay().page(res, 200, 'Device checks - New Moon admin', html.join('\n'));
}

/** The boxes over one screenshot: the safe area (dashed) and each problem's box, numbered as in the list under it. */
function overlay(step, report) {
  const [vw, vh] = step.view[0] > 0 ? step.view : report.screen.view;
  if (!(vw > 0 && vh > 0)) return '';
  const sv = report.screen.safeView;
  const parts = [];
  if (sv && sv[2] > 0 && (sv[0] > 0.5 || sv[1] > 0.5 || sv[2] < vw - 0.5 || sv[3] < vh - 0.5))
    parts.push(`<rect x="${num(sv[0])}" y="${num(sv[1])}" width="${num(sv[2])}" height="${num(sv[3])}" fill="none" stroke="#7cc4f2" stroke-width="1.5" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>`);
  step.problems.forEach((p, i) => {
    const [x, y, w, h] = p.rect.map(num);
    const c = COLOURS[p.kind] || COLOURS.other;
    parts.push(`<rect x="${x}" y="${y}" width="${Math.max(2, w)}" height="${Math.max(2, h)}" fill="${c}22" stroke="${c}" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
    const lx = Math.max(0, Math.min(vw - 22, x)), ly = Math.max(0, y - 16 < 0 ? y + 1 : y - 16);
    parts.push(`<rect x="${lx}" y="${ly}" width="${i + 1 >= 10 ? 22 : 15}" height="15" rx="3" fill="${c}"/><text x="${lx + 3.5}" y="${ly + 11.5}" font-size="11" font-weight="700" font-family="system-ui,sans-serif" fill="#111">${i + 1}</text>`);
  });
  return `<svg viewBox="0 0 ${num(vw)} ${num(vh)}" preserveAspectRatio="none" aria-hidden="true">${parts.join('')}</svg>`;
}

function reportPage(res, key, token) {
  const r = load(key);
  if (!r) { pay().page(res, 404, 'Not found', '<h1>That report isn\'t here</h1><p>Only the newest 30 are kept.</p><a class="btn" href="/admin/devcheck">All device checks</a>'); return; }
  const counts = {};
  for (const s of r.steps) for (const p of s.problems) counts[p.kind] = (counts[p.kind] || 0) + 1;
  const d = r.device, s = r.screen;
  const meta = [['Device', d.model], ['System', d.os], ['Build', r.build], ['Screen', `${fmt(s.w)} x ${fmt(s.h)} px, ${fmt(s.dpi)} dpi`],
    ['Safe area', s.safe.join(', ')], ['Interface', `${s.view.join(' x ')} (${s.uiScale}${s.touch ? ', touch' : ''})`], ['Graphics', d.gpu], ['Took', `${fmt(r.seconds)} s on ${when(r.made)}`]];
  const steps = r.steps.map((st, i) => {
    const pic = st.shot ? `<div class="dc-shot"><img src="/admin/devcheck/img?r=${encodeURIComponent(key)}&amp;s=${i}" width="${num(st.shot.w)}" height="${num(st.shot.h)}" alt="${esc(st.title)}" loading="lazy">${overlay(st, r)}</div>`
      : `<div class="dc-none">No screenshot for this step.</div>`;
    const list = st.problems.map(p => `<li><span class="k" style="color:${COLOURS[p.kind] || COLOURS.other}">${esc(KIND_NAMES[p.kind] || p.kind)}</span> ${esc(p.detail)}<span class="p">${esc(p.path)}</span></li>`).join('');
    return `<article class="dc-step" id="s${i}"><h2><span>${esc(st.title || st.name)} <small>${esc(st.name)}</small></span>${badge(st.status)}</h2>${pic}
${st.note ? `<p class="dc-note">${esc(st.note)}</p>` : ''}${list ? `<ol>${list}</ol>` : ''}${st.more ? `<p class="dc-note">...and ${fmt(st.more)} more not listed.</p>` : ''}</article>`;
  });
  const html = [ui.CSS, PAGE_CSS,
    `<div class="pagehead"><div><h1>Device check <span class="dc-id">${esc(r.id)}</span></h1><p>Received ${when(r.received)} &middot; ${fmt(r.steps.length)} screens &middot; ${fmt(r.problems)} problems &middot; <a href="/admin/devcheck">all device checks</a></p></div>
<form method="post" action="/admin/devcheck" onsubmit="return confirm('Delete this report?')">${auth.hidden(token)}<input type="hidden" name="action" value="delete"><input type="hidden" name="r" value="${esc(key)}"><button type="submit" class="ghost">Delete report</button></form></div>`,
    `<div class="dc-meta">${meta.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>`,
    `<div class="dc-kinds">${Object.keys(counts).length ? Object.entries(counts).map(([k, n]) => `<span style="border-color:${COLOURS[k] || COLOURS.other}88">${esc(KIND_NAMES[k] || k)}: <b>${fmt(n)}</b></span>`).join('') : '<span>No problems found</span>'}</div>`,
    r.glyphs ? `<p class="small">Glyph check: ${esc(r.glyphs)}</p>` : '',
    `<div class="dc-key">${Object.keys(KIND_NAMES).filter(k => k !== 'other').map(k => `<span><i style="background:${COLOURS[k]}"></i>${esc(KIND_NAMES[k])}</span>`).join('')}<span><i style="border:1.5px dashed #7cc4f2"></i>Safe area</span></div>`,
    `<div class="dc-grid">${steps.join('\n')}</div>`];
  pay().page(res, 200, `Device check ${r.id} - New Moon admin`, html.join('\n'));
}

function image(req, res, url) {
  const key = url.searchParams.get('r'), i = Number(url.searchParams.get('s'));
  const r = load(key);
  const st = r && Number.isInteger(i) && i >= 0 ? r.steps[i] : null;
  if (!st || !st.shot || !/^shot-\d{2}\.jpg$/.test(st.shot.file)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  fs.readFile(path.join(DIR, key, st.shot.file), (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
    res.end(buf);
  });
}

/** Returns true if it answered the request. */
function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://relay'); } catch { return false; }
  const route = url.pathname;
  if (route === '/devcheck') {
    if (req.method !== 'POST') { json(res, 405, { ok: false }, { allow: 'POST' }); return true; }
    receive(req, res);
    return true;
  }
  if (route === '/admin/devcheck/img') {
    auth.guard(req, res, { path: '/admin/devcheck' }).then(g => { if (g) image(req, res, url); });
    return true;
  }
  if (route !== '/admin/devcheck') return false;
  auth.guard(req, res, { path: '/admin/devcheck', limit: 4096 }).then(g => {
    if (!g) return;
    if (!g.get) {
      const k = String(g.form.get('r') || '');
      if (g.form.get('action') === 'delete' && KEY_RE.test(k)) fs.rmSync(path.join(DIR, k), { recursive: true, force: true });
      res.writeHead(303, { location: '/admin/devcheck', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const k = url.searchParams.get('r');
    if (k) reportPage(res, k, g.token);
    else listPage(res);
  }).catch(e => { console.error('devcheck admin', e && e.message); if (!res.headersSent) { res.writeHead(500); res.end(); } });
  return true;
}

/** For the admin home: how many reports are kept, and the newest one's time. */
function summary() {
  const k = keys();
  const newest = k.length ? load(k[0]) : null;
  return { count: k.length, newest: newest ? newest.received : '', problems: newest ? newest.problems : 0 };
}

module.exports = { handle, summary, _test: { clean, reset: () => { byIp.clear(); all = []; inflight = 0; }, DIR, KEEP } };
