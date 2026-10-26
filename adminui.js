'use strict';
// Round 110: the look of the admin home (/admin) and the play-stats dashboard (/admin/stats) - one dark theme in the
// game's colours (gold accent), a header with the admin pages, and small charts drawn as inline SVG right here (no
// libraries, no CDNs, nothing fetched: they draw with no network at all). Everything shown goes through esc().

const pay = () => require('./payments');
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);   // (the same as payments.escapeHtml)

// Chart colours (dark surface #171a21) - checked with the dataviz palette validator: lightness band, chroma, colour-blind
// separation of neighbours (worst adjacent deutan dE 16) and 3:1 contrast all pass in this order.
const SERIES = ['#bf8526', '#3987e5', '#199e70', '#9085e9', '#d55181'];
const GRAY = '#6b7280';

// (plain string work, not toLocaleString: a page draws thousands of numbers and Intl is slow)
const commas = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
function fmt(n) { n = Math.round(Number(n) || 0); return (n < 0 ? '-' : '') + commas(String(Math.abs(n))); }
function fmt1(n) {
  n = Number(n) || 0;
  const r = Math.round(n * 10) / 10;
  const whole = Math.trunc(Math.abs(r)), tenth = Math.round((Math.abs(r) - whole) * 10);
  return (r < 0 ? '-' : '') + commas(String(whole)) + (tenth ? '.' + tenth : '');
}
const pct = (v, digits) => v == null || !Number.isFinite(v) ? '–' : (v * 100).toFixed(digits == null ? 0 : digits) + '%';
function money(cents) {
  const c = Math.round(Number(cents) || 0), a = Math.abs(c);
  return (c < 0 ? '-' : '') + '$' + commas(String(Math.floor(a / 100))) + '.' + String(a % 100).padStart(2, '0');
}
const minutesText = m => !Number.isFinite(m) || m <= 0 ? '0 min' : m >= 90 ? (m / 60).toFixed(1) + ' h' : m >= 1 ? Math.round(m) + ' min' : Math.round(m * 60) + ' s';

const CSS = `<style>
:root{color-scheme:dark;--bg:#0f1115;--surface:#171a21;--surface2:#1d212a;--line:#2a2f3a;--grid:#262b35;--text:#eceef3;--text2:#aab2c0;--muted:#828b9b;
--gold:#e8b14c;--gold-dim:#e8b14c22;--good:#0ca30c;--good-text:#6fd49a;--warn:#fab219;--bad:#d03b3b;--bad-text:#ff8a80;
--s1:${SERIES[0]};--s2:${SERIES[1]};--s3:${SERIES[2]};--s4:${SERIES[3]};--s5:${SERIES[4]}}
body{background:var(--bg);color:var(--text)}
main{max-width:1180px}
a{color:var(--gold)}
button,.btn,a.btn{font:600 13px system-ui,sans-serif;border-radius:8px;padding:8px 12px;margin:0}
button.ghost,a.ghost{background:transparent;color:var(--gold);border:1px solid #e8b14c66}
.pagehead{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px;margin:4px 0 14px}
.pagehead h1{font-size:26px;margin:0;letter-spacing:-.01em}
.pagehead p{margin:4px 0 0;color:var(--muted);font-size:13px}
.seg{display:inline-flex;background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:3px}
.seg a{color:var(--text2);text-decoration:none;font-size:13px;padding:5px 12px;border-radius:999px}
.seg a.on{background:var(--gold);color:#16130a;font-weight:700}
.jump{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px}
.jump a{flex:none;font-size:12px;color:var(--text2);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:5px 11px;background:var(--surface)}
.jump a:hover{border-color:#e8b14c88;color:var(--text)}
section.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 18px 14px;margin:0 0 16px;scroll-margin-top:70px}
.card h2{font-size:17px;margin:0;display:flex;align-items:center;gap:8px}
.card h2 .num{color:var(--muted);font-weight:500;font-size:13px}
.card .why{color:var(--muted);font-size:13px;margin:4px 0 14px;max-width:760px}
.card h3{font-size:13px;color:var(--text2);font-weight:600;margin:16px 0 8px;text-transform:uppercase;letter-spacing:.05em}
.cardhead{display:flex;justify-content:space-between;align-items:center;gap:10px}
.exp{display:flex;gap:6px}
.exp a{font-size:12px;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:6px;padding:3px 8px}
.exp a:hover{color:var(--gold);border-color:#e8b14c88}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin:0 0 6px}
.tile{background:var(--surface2);border:1px solid var(--line);border-radius:10px;padding:11px 12px;min-width:0}
.tile b{display:block;font-size:24px;line-height:1.15;font-variant-numeric:tabular-nums;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile span{display:block;font-size:12px;color:var(--text2);margin-top:2px}
.tile small{display:block;font-size:11px;color:var(--muted);margin-top:3px}
.tile.live b{color:var(--good-text)}
.tile.big{grid-column:span 2}
.tile.big b{font-size:34px;color:var(--gold)}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));gap:14px;margin-top:10px}
.chart{background:var(--surface2);border:1px solid var(--line);border-radius:10px;padding:12px 12px 8px;min-width:0}
.chart .ct{font-size:13px;font-weight:600;color:var(--text);margin:0 0 2px}
.chart .cs{font-size:12px;color:var(--muted);margin:0 0 6px}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--text2);margin:2px 0 4px}
.legend i{display:inline-block;width:10px;height:3px;border-radius:2px;margin:0 5px 3px 0;vertical-align:middle}
.legend i.sq{height:10px;width:10px;border-radius:3px;margin-bottom:1px}
svg.viz{display:block;width:100%;height:auto;overflow:visible}
svg.viz text{fill:var(--muted);font:11px system-ui,sans-serif}
svg.viz text.lab{fill:var(--text2);font-weight:600}
svg.viz .hit{fill:transparent}
svg.viz .hit:hover{fill:#ffffff0d}
.hb{display:grid;grid-template-columns:minmax(80px,38%) 1fr auto;gap:6px 10px;align-items:center;font-size:13px}
.hb .l{color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hb .t{height:8px;background:var(--grid);border-radius:4px;overflow:hidden}
.hb .t i{display:block;height:100%;border-radius:4px;min-width:2px}
.hb .v{color:var(--text);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.hb .v small{color:var(--muted);margin-left:6px}
.empty{color:var(--muted);font-size:13px;padding:10px 0}
.note{border-radius:10px;padding:11px 13px;font-size:13px;margin:10px 0;border:1px solid var(--line);background:var(--surface2);color:var(--text2)}
.note b{color:var(--text)}
.note.ok{border-color:#0ca30c88;background:#0ca30c14}
.note.warn{border-color:#fab21988;background:#fab21914}
.note.bad{border-color:#d03b3b99;background:#d03b3b18}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;border-radius:999px;padding:3px 9px;white-space:nowrap}
.pill.ok{background:#0ca30c26;color:var(--good-text)}.pill.warn{background:#fab21926;color:var(--warn)}.pill.bad{background:#d03b3b2e;color:var(--bad-text)}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{color:var(--muted);font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:7px 8px;border-bottom:1px solid var(--grid);vertical-align:top}
.tbl td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.scroll{overflow-x:auto;max-width:100%}
.heat{max-width:640px}
.heat td.c{text-align:center;font-variant-numeric:tabular-nums;border:2px solid var(--surface);border-radius:6px;min-width:52px;color:var(--text)}
.err{font-size:13px;word-break:break-word}
.err code{display:block;color:var(--muted);font-size:11px;white-space:pre-wrap;margin-top:3px}
.foot{color:var(--muted);font-size:12px;margin:20px 0 0}
@media (max-width:560px){
  .pagehead h1{font-size:22px}
  section.card{padding:14px 12px 10px;border-radius:12px}
  .tiles{grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px}
  .tile{padding:9px 10px}.tile b{font-size:20px}.tile.big{grid-column:1/-1}.tile.big b{font-size:28px}.tile span{font-size:11.5px}
  .card .why{font-size:12.5px}
  .hb{grid-template-columns:minmax(70px,40%) 1fr auto}
}
</style>`;

const PAGES = [
  ['/admin', 'Home'], ['/admin/stats', 'Stats'], ['/admin/players', 'Players'], ['/admin/store', 'Store & payments'],
  ['/admin/applications', 'Applications'], ['/admin/sellers', 'Sellers'], ['/admin/patch', 'Patch bay']
];

// Round 110: THE ADMIN TOP BAR - on every signed-in admin page (payments.page() puts it in front of the page when
// adminauth.guard let the request through). Wide screens: the page links in a row + Sign out. Below 720 px: the moon, the
// page's name and a "Menu" button (a <details>, so it opens with no script) that drops down every page, Sign out and
// Sign out everywhere - nothing squeezed, nothing scrolled out of reach.
const NAV_CSS = `<style>
body{padding-top:0!important;padding-left:0!important;padding-right:0!important;background:#0f1115}
main{padding-left:16px;padding-right:16px;box-sizing:border-box}
.ah{position:sticky;top:0;z-index:20;background:#0f1115f2;backdrop-filter:blur(8px);border-bottom:1px solid #2a2f3a;margin:0 0 18px;font-family:system-ui,-apple-system,sans-serif}
.ah-in{max-width:1180px;margin:0 auto;padding:8px 16px;display:flex;align-items:center;gap:14px;box-sizing:border-box;min-height:56px}
.ah .brand{display:flex;align-items:center;gap:9px;color:#eceef3;text-decoration:none;font-weight:600;white-space:nowrap;font-size:15px;min-height:44px}
.ah .brand b{color:#e8b14c;font-weight:700}
.moon{width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 34% 34%,#ffe0a0,#e8b14c 55%,#8a6420);box-shadow:0 0 14px #e8b14c55;flex:none}
.ah-links{display:flex;gap:2px;flex:1;flex-wrap:wrap}
.ah-links a{color:#aab2c0;text-decoration:none;font-size:13px;padding:7px 10px;border-radius:999px;white-space:nowrap}
.ah-links a:hover{background:#1d212a;color:#eceef3}
.ah a.on{background:#e8b14c22;color:#e8b14c}
.ah form{margin:0}
.ah .out{font:600 13px system-ui,sans-serif;border-radius:8px;padding:8px 12px;margin:0;background:transparent;color:#e8b14c;border:1px solid #e8b14c66;cursor:pointer;min-height:36px}
.ah-title{display:none;flex:1;min-width:0;color:#eceef3;font-weight:700;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-menu{display:none;margin-left:auto}
.ah-menu summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;min-height:44px;min-width:44px;padding:0 14px;box-sizing:border-box;border:1px solid #e8b14c66;border-radius:10px;color:#e8b14c;font:600 15px system-ui,sans-serif;user-select:none}
.ah-menu summary::-webkit-details-marker{display:none}
.ah-menu summary .x{display:none}
.ah-menu[open] summary{background:#e8b14c;color:#16130a;border-color:#e8b14c}
.ah-menu[open] summary .x{display:inline}.ah-menu[open] summary .bars{display:none}
.ah-drop{position:absolute;left:0;right:0;top:100%;background:#13161c;border-bottom:1px solid #2a2f3a;box-shadow:0 18px 40px #000a;padding:6px 16px 14px;max-height:calc(100vh - 64px);overflow-y:auto}
.ah-drop a,.ah-drop button{display:flex;align-items:center;width:100%;box-sizing:border-box;min-height:48px;padding:0 12px;margin:2px 0;border-radius:10px;color:#eceef3;text-decoration:none;font:500 16px system-ui,sans-serif;background:transparent;border:0;text-align:left;cursor:pointer}
.ah-drop a:hover,.ah-drop button:hover{background:#1d212a}
.ah-drop a.on{background:#e8b14c22;color:#e8b14c;font-weight:700}
.ah-drop hr{border:0;border-top:1px solid #2a2f3a;margin:8px 0}
.ah-drop button{color:#e8b14c;font-weight:600}
.ah-drop button.all{color:#ff8a80}
@media (max-width:720px){
  .ah-links,.ah-wide{display:none}
  .ah-title{display:block}
  .ah-menu{display:block}
  .ah .brand span:last-child{display:none}
  .ah-in{gap:10px}
  main>table{display:block;overflow-x:auto;max-width:100%}   /* the older admin pages' wide tables scroll inside the page, not off it */
}
</style>`;

/** The top bar for one admin page (current = its address; token = the session's CSRF token for the sign-out forms). */
function chrome(current, token) {
  const hidden = require('./adminauth').hidden(token);
  const page = PAGES.find(([href]) => href === current);
  const title = page ? page[1] : 'Admin';
  const links = cls => PAGES.map(([href, name]) => `<a href="${href}"${href === current ? ' class="on" aria-current="page"' : ''}>${esc(name)}</a>`).join('');
  return `${NAV_CSS}<header class="ah"><div class="ah-in"><a class="brand" href="/admin" aria-label="Admin home"><span class="moon" aria-hidden="true"></span><span>New Moon <b>admin</b></span></a>
<span class="ah-title">${esc(title)}</span>
<nav class="ah-links" aria-label="Admin pages">${links()}</nav>
<form class="ah-wide" method="post" action="/admin/logout">${hidden}<button type="submit" class="out">Sign out</button></form>
<details class="ah-menu"><summary aria-label="Menu"><span class="bars" aria-hidden="true">&#9776;</span><span class="x" aria-hidden="true">&#10005;</span> Menu</summary>
<div class="ah-drop"><nav aria-label="Admin pages (menu)">${links()}</nav><hr>
<form method="post" action="/admin/logout">${hidden}<button type="submit">Sign out</button></form>
<form method="post" action="/admin/logout" onsubmit="return confirm('Sign out on every device (phone, computer)?')">${hidden}<input type="hidden" name="all" value="1"><button type="submit" class="all">Sign out everywhere</button></form>
</div></details></div></header>`;
}

/** Kept for anything that still asks for the old header: the bar is added by payments.page() now. */
function header() { return ''; }

function tile(value, label, sub, cls) {
  return `<div class="tile${cls ? ' ' + cls : ''}"><b>${esc(value)}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
}

/** Horizontal bars (names may be anything players' games sent - all escaped). entries: [[label, value, extraText]]. */
function hbars(entries, opts) {
  opts = opts || {};
  const rows = entries.filter(e => e && e[1] > 0).slice(0, opts.limit || 10);
  if (!rows.length) return `<p class="empty">${esc(opts.empty || 'Nothing yet.')}</p>`;
  const max = opts.max || Math.max(...rows.map(r => r[1]), 1);
  const f = opts.format || fmt;
  return `<div class="hb">${rows.map(([label, v, extra, color]) => `<div class="l" title="${esc(label)}">${esc(label)}</div><div class="t"><i style="width:${Math.max(1, Math.round(v / max * 100))}%;background:${esc(color || opts.color || 'var(--s1)')}"></i></div><div class="v">${esc(f(v))}${extra ? `<small>${esc(extra)}</small>` : ''}</div>`).join('')}</div>`;
}

function legend(series, square) {
  if (series.length < 2) return '';
  return `<div class="legend">${series.map(s => `<span><i class="${square ? 'sq' : ''}" style="background:${esc(s.color)}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}

/** A tidy axis: a step of 1, 2, 2.5 or 5 x 10^n and at most 5 intervals, so the gridlines read 0 / 10 / 20 ... */
function niceScale(v) {
  if (!(v > 0)) return { max: 4, n: 4 };
  const p = Math.pow(10, Math.floor(Math.log10(v / 5)));
  for (const k of [1, 2, 2.5, 5, 10, 20, 25, 50]) {
    const step = k * p;
    if (step < 1 && v >= 4) continue;   // (whole numbers for counts)
    const n = Math.ceil(v / step - 1e-9);
    if (n <= 5) return { max: step * Math.max(n, 2), n: Math.max(n, 2) };
  }
  return { max: v, n: 4 };
}

const W = 460, H = 190, PL = 36, PR = 12, PT = 10, PB = 22;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = key => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(key)); return m ? MONTHS[Number(m[1]) - 1] + ' ' + Number(m[2]) : String(key); };

function axes(labels, max, yFormat, plotW, ticks) {
  const f = yFormat || (v => fmt(v));
  const t = ticks || 4;
  let out = '';
  for (let i = 0; i <= t; i++) {
    const y = PT + (H - PT - PB) * (1 - i / t);
    out += `<line x1="${PL}" x2="${PL + plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#262b35" stroke-width="1"/>`;
    out += `<text x="${PL - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(f(max * i / t))}</text>`;
  }
  const n = labels.length;
  const picks = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  for (const i of picks) {
    const x = PL + (n <= 1 ? plotW / 2 : plotW * i / (n - 1));
    out += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(short(labels[i]))}</text>`;
  }
  return out;
}

/**
 * A line chart. series: [{name, color, values}] over labels (YYYY-MM-DD). Hover a day for its numbers (the <title>);
 * the last value of each line is written at its end.
 */
function lineChart(opts) {
  const { labels, series } = opts;
  const yFormat = opts.yFormat;
  const n = labels.length;
  if (!n || !series.some(s => s.values.some(v => v > 0))) return chartBox(opts, '<p class="empty">No data in this range yet.</p>');
  const endLabels = series.length <= 4;
  const plotW = W - PL - PR - (endLabels ? 34 : 0);
  const sc = niceScale(Math.max(...series.map(s => Math.max(...s.values))));
  const max = sc.max;
  const X = i => PL + (n <= 1 ? plotW / 2 : plotW * i / (n - 1));
  const Y = v => PT + (H - PT - PB) * (1 - v / max);
  let svg = axes(labels, max, yFormat, plotW, sc.n);
  const ends = [];
  for (const s of series) {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
    svg += `<path d="${d}" fill="none" stroke="${esc(s.color)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = s.values[n - 1];
    svg += `<circle cx="${X(n - 1).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="3.5" fill="${esc(s.color)}" stroke="#1d212a" stroke-width="2"/>`;
    ends.push({ y: Y(last), text: (yFormat || fmt)(last), color: s.color });
  }
  if (endLabels) {
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;   // never on top of each other
    for (const e of ends) svg += `<text class="lab" x="${(X(n - 1) + 7).toFixed(1)}" y="${(e.y + 4).toFixed(1)}">${esc(e.text)}</text>`;
  }
  const step = n <= 1 ? plotW : plotW / (n - 1);
  for (let i = 0; i < n; i++) {
    const tip = short(labels[i]) + ': ' + series.map(s => `${s.name} ${(yFormat || fmt)(s.values[i])}`).join(' · ');
    svg += `<rect class="hit" x="${(X(i) - step / 2).toFixed(1)}" y="${PT}" width="${step.toFixed(1)}" height="${H - PT - PB}"><title>${esc(tip)}</title></rect>`;
  }
  return chartBox(opts, legend(series) + `<svg class="viz" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || 'chart')}">${svg}</svg>`);
}

/** A bar chart (one series): 2px gaps, rounded tops, hover for the number. */
function barChart(opts) {
  const { labels, values } = opts;
  const n = labels.length;
  if (!n || !values.some(v => v > 0)) return chartBox(opts, '<p class="empty">No data in this range yet.</p>');
  const plotW = W - PL - PR;
  const sc = niceScale(Math.max(...values));
  const max = sc.max;
  const bw = plotW / n;
  const gap = bw > 8 ? 2 : bw > 4 ? 1 : 0.5;
  const f = opts.yFormat || fmt;
  let svg = axes(labels, max, f, plotW - bw, sc.n);
  const color = opts.color || SERIES[0];
  values.forEach((v, i) => {
    const x = PL + i * bw;
    const h = (H - PT - PB) * (v / max);
    const w = Math.max(0.5, bw - gap);
    const x0 = x + gap / 2;
    if (h > 0) {
      const r = Math.min(3, w / 2, h);
      const y = H - PB - h;
      svg += `<path d="M${x0.toFixed(1)},${(H - PB).toFixed(1)}V${(y + r).toFixed(1)}Q${x0.toFixed(1)},${y.toFixed(1)} ${(x0 + r).toFixed(1)},${y.toFixed(1)}H${(x0 + w - r).toFixed(1)}Q${(x0 + w).toFixed(1)},${y.toFixed(1)} ${(x0 + w).toFixed(1)},${(y + r).toFixed(1)}V${(H - PB).toFixed(1)}Z" fill="${esc(color)}"/>`;
    }
    svg += `<rect class="hit" x="${x.toFixed(1)}" y="${PT}" width="${bw.toFixed(1)}" height="${H - PT - PB}"><title>${esc(short(labels[i]) + ': ' + f(v))}</title></rect>`;
  });
  return chartBox(opts, `<svg class="viz" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || 'chart')}">${svg}</svg>`);
}

/** 100% stacked bars per day. keys: [{key, name, color}], rows: [{key: count}] per label. */
function shareChart(opts) {
  const { labels, keys, rows } = opts;
  const n = labels.length;
  const totals = rows.map(r => keys.reduce((a, k) => a + (r[k.key] || 0), 0));
  if (!n || !totals.some(t => t > 0)) return chartBox(opts, '<p class="empty">No data in this range yet.</p>');
  const plotW = W - PL - PR;
  const bw = plotW / n;
  let svg = axes(labels, 1, v => Math.round(v * 100) + '%', plotW - bw);
  rows.forEach((r, i) => {
    const t = totals[i];
    const gap = bw > 8 ? 2 : bw > 4 ? 1 : 0.4;
    const x = PL + i * bw + gap / 2;
    const w = Math.max(0.5, bw - gap);
    if (!t) return;
    let y = H - PB;
    const parts = [];
    for (const k of keys) {
      const v = r[k.key] || 0;
      if (!v) continue;
      const h = (H - PT - PB) * v / t;
      y -= h;
      svg += `<rect x="${x.toFixed(2)}" y="${y.toFixed(1)}" width="${w.toFixed(2)}" height="${Math.max(0, h - (h > 3 ? 1 : 0)).toFixed(1)}" fill="${esc(k.color)}"/>`;
      parts.push(`${k.name} ${Math.round(v / t * 100)}%`);
    }
    svg += `<rect class="hit" x="${(PL + i * bw).toFixed(1)}" y="${PT}" width="${bw.toFixed(1)}" height="${H - PT - PB}"><title>${esc(short(labels[i]) + ' (' + fmt(t) + ' players): ' + parts.join(' · '))}</title></rect>`;
  });
  return chartBox(opts, legend(keys, true) + `<svg class="viz" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || 'chart')}">${svg}</svg>`);
}

function chartBox(opts, inner) {
  return `<div class="chart">${opts.title ? `<p class="ct">${esc(opts.title)}</p>` : ''}${opts.sub ? `<p class="cs">${esc(opts.sub)}</p>` : ''}${inner}</div>`;
}

/** A gold heat colour for 0..1 (the retention table) - one hue, darker = fewer. */
function heat(v) {
  if (v == null || !Number.isFinite(v)) return 'transparent';
  const a = Math.max(0.06, Math.min(1, v * 1.6));
  return `rgba(232,177,76,${a.toFixed(2)})`;
}
function heatText(v) { return v != null && v * 1.6 > 0.55 ? '#16130a' : 'var(--text)'; }

module.exports = { CSS, NAV_CSS, SERIES, GRAY, esc, fmt, fmt1, pct, money, minutesText, header, chrome, tile, hbars, lineChart, barChart, shareChart, chartBox, heat, heatText, short, PAGES };
