// New Moon, Same Dark - the DJ PATCH BAY (Round 60).
//
// WHAT IT IS: a password-protected page on your server (/admin/patch, the same ADMIN_KEY as /admin) where you
// keep a roster of real DJs and "patch" them onto the stages of online festivals - like a sound engineer
// plugging a cable into a mixing desk:
//   - DJ roster: name, genre, optional photo, their stream link(s) (HLS .m3u8 / .mp4 video, or Icecast-style
//     .mp3 / .aac / .ogg audio), a contact, and a private DJ link (/dj?key=...) for each DJ.
//   - Patching: for any live event (and any open room you choose), which DJ plays on which STAGE (main,
//     second, third, pop-up tent, artist venue) - right now, or at a set time with a running order - with a
//     "Test stream" button (the server checks the link answers and looks like video or audio) and big
//     GO LIVE / STOP buttons per stage, plus a now-playing overview of every room and stage.
//   - DJ portal (/dj?key=...): a DJ sees their sets, pastes/updates their own stream link, tests it, and
//     presses "I'm live" / "End set" inside their slot (you can lock that per DJ).
//   - Live events can be made right here too (they join the ones in vendors.json).
//
// HOW PLAYERS GET IT: the relay (relay.js) pushes each stage's patch straight to everyone in that room as one
// line {"relay":"patch","stage":"main","live":true,"dj":"...","url":"https://...","kind":"hls",...} - to the
// host AND every guest, so nobody has to pass it on - again to each player who joins, and whenever it changes.
// Older games ignore the line. A room's host can patch stages from inside the game too ({"patch":{...}}), except
// stages you have patched here (yours win).
//
// Round 75: TWITCH. A DJ can paste their Twitch channel link (https://twitch.tv/name). The game can't play a Twitch page,
// so when that DJ goes live the server asks Twitch for the channel's HLS playlist (the way streamlink does: a playback
// token from gql.twitch.tv, then usher.ttvnw.net) and sends PLAYERS the playlist as kind "hls" (plus "via":"twitch").
// The saved link stays the Twitch one; the token is renewed every 15 minutes while live (it expires) and the stage is
// pushed again when the playlist address changes. Best effort: if Twitch changes its ways, the test says so in words.
// Also: Opus (.opus) links are refused (the game can't play them), and the DJ page / admin page explain in plain words
// how to get a link (Twitch, Icecast audio, or OBS -> a video service that gives an .m3u8).
//
// FILES: patchbay-data.json (kept out of GitHub by .gitignore - it holds the DJs' private links). It lives in
// STORE_DATA_DIR (a persistent disk) when that is set, or PATCHBAY_DIR, else next to this file. A FREE Render
// server forgets files when it restarts, so the page has "Download backup"; paste that backup into a Render
// Secret File named patchbay.json and it's loaded whenever the server starts without its own file.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const https = require('https');

const pay = () => require('./payments');   // (lazy: payments.js requires this file too)
const analytics = () => require('./analytics');   // Round 75: DJ go-live / stop are counted on the stats page (lazy: it loads payments)

// ============================================================================ what there is
const STAGES = [
  { id: 'main', name: 'Main Stage' },
  { id: 'second', name: 'Second Stage' },
  { id: 'third', name: 'Third Stage' },
  { id: 'tent', name: 'Pop-up Tent' },
  { id: 'venue', name: 'Artist Venue' }
];
const STAGE_IDS = STAGES.map(s => s.id);
const KINDS = ['hls', 'video', 'mp3', 'aac', 'ogg', 'twitch'];
const KIND_NAMES = { hls: 'HLS video (.m3u8)', video: 'video (.mp4)', mp3: 'audio (MP3 / Icecast)', aac: 'audio (AAC)', ogg: 'audio (Ogg)', twitch: 'Twitch channel (players get its HLS stream)' };
const OPUS_TEXT = 'Opus isn\'t supported in the game - use MP3 or AAC (Icecast) or HLS';

// Round 75: Twitch
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';   // Twitch's own web player id (what streamlink uses)
const TWITCH_TOKEN_HASH = '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712';   // the PlaybackAccessToken query
const TWITCH_TIMEOUT = 12000;
const TWITCH_REFRESH = 15 * 60000;    // a playlist address is renewed this often while the DJ is live (tokens expire)
const TWITCH_RETRY = 60000;           // after a failed look-up, try again this much later
const TWITCH_OFFLINE = 'That Twitch channel isn\'t live right now (go live on Twitch first)';

const MAX_URL = 500;             // characters in a stream link
const MAX_DJS = 300;
const MAX_STREAMS = 2;           // a main link and a backup
const MAX_SLOTS = 3000;
const MAX_EVENTS = 40;           // live events made on this page
const MAX_HOST_SLOTS = 30;       // in-game patches kept per room
const DAY = 86400000;
const EARLY_GO = 10 * 60000;     // a DJ may press "I'm live" this early before their set time
const ROOM_GRACE = 30 * 60000;   // a closed room's patches are kept this long (its host may be reconnecting)

const DATA_DIR = process.env.PATCHBAY_DIR || process.env.STORE_DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'patchbay-data.json');
const SEED_FILE = process.env.PATCHBAY_SEED || '/etc/secrets/patchbay.json';
const PERSISTENT = !!(process.env.PATCHBAY_DIR || process.env.STORE_DATA_DIR);

// ============================================================================ small helpers
function h(s) { return pay().escapeHtml(s); }

function clip(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

// Round 60: the same clean-up as payments.js / relay.js (kept here: this file loads while payments.js is still loading).
function cleanId(id) {
  return String(id || '').replace(/,/g, ' ').replace(/\//g, '-').replace(/[\n<>]/g, '').trim().slice(0, 32).replace(/ /g, '-');
}

function randomCode(n) {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += letters[bytes[i] % letters.length];
  return out;
}

function same(a, b) {
  const x = crypto.createHash('sha256').update(String(a || '')).digest();
  const y = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(x, y);
}

function stageName(id) {
  const s = STAGES.find(x => x.id === id);
  return s ? s.name : 'Stage';
}

function ipOf(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : (req.socket.remoteAddress || '');
}

/** A brake: at most max hits per windowMs for key (true = allowed). */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20000) hits.clear();
  return true;
}

function fails(key, windowMs) {
  const now = Date.now();
  return (hits.get(key) || []).filter(t => now - t < windowMs).length;
}

function addFail(key) {
  const list = hits.get(key) || [];
  list.push(Date.now());
  hits.set(key, list.slice(-50));
}

setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.some(t => now - t < 3600000)) hits.delete(k);
}, 600000).unref();

// ============================================================================ stream links
/** True for an address that isn't on the public internet (this server, a home network, link-local...). */
function isPrivateIp(ip) {
  ip = String(ip || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19));
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase().replace(/%.*$/, '');
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isPrivateIp(mapped[1]);
    // Round 60: the same, written in hex (the URL parser turns [::ffff:127.0.0.1] into [::ffff:7f00:1]).
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low);
    if (hex) {
      const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
      return isPrivateIp([a >> 8, a & 255, b >> 8, b & 255].join('.'));
    }
    // Anything starting "::" (unspecified, loopback, old IPv4-compatible forms), unique-local, link-local,
    // multicast, NAT64, 6to4, Teredo and the documentation range: never a public stream.
    return low.startsWith('::') || /^f[cd]/.test(low) || /^fe[89ab]/.test(low) || /^ff/.test(low) ||
      low.startsWith('64:ff9b:') || low.startsWith('2002:') || low.startsWith('2001:0:') || low.startsWith('2001::') || low.startsWith('2001:db8:');
  }
  return true;   // not an address at all: treat as unsafe
}

let allowLocalForTests = false;

/**
 * A stream link, cleaned, or '' if it can't be used: https only, sensible length, no user:password@,
 * and never a local or private address (the game and this server only ever fetch public links).
 */
function cleanStreamUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > MAX_URL || /[\s\u0000-\u001f\u007f<>"'`\\]/.test(text)) return '';
  let u;
  try { u = new URL(text); } catch { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password) return '';
  if (isOpus(text)) return '';   // Round 75: the game can't play Opus (streamProblem says so in words)
  // Round 60 review: a trailing dot ("localhost.", "nas.local.") names the same host - check it without the dot.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return '';
  if (!allowLocalForTests) {
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) return '';
    if (net.isIP(host) ? isPrivateIp(host) : !host.includes('.')) return '';
  }
  return text;
}

/** The address part of a link before any ?query or #hash, lower-case. */
function pathOf(url) {
  const lower = String(url || '').toLowerCase();
  const cut = lower.search(/[?#]/);
  return cut >= 0 ? lower.slice(0, cut) : lower;
}

/** Round 75: an Opus link (.opus) - Unity's players can't decode it, so it's refused everywhere with OPUS_TEXT. */
function isOpus(url) {
  return pathOf(url).endsWith('.opus');
}

/**
 * Round 75: the channel name from a Twitch channel link (https://twitch.tv/name, www. or m. too, trailing slash fine),
 * lower-case - or '' if it isn't one (a VOD, a clip, a category page, a non-Twitch link).
 */
function twitchChannel(url) {
  const m = /^https:\/\/(?:www\.|m\.)?twitch\.tv\/([A-Za-z0-9_]{3,25})\/?(?:[?#]|$)/.exec(String(url || '').trim());
  if (!m) return '';
  const name = m[1].toLowerCase();
  // These are Twitch pages, never channels.
  if (['directory', 'videos', 'settings', 'downloads', 'jobs', 'p', 'search', 'login', 'signup', 'subscriptions', 'inventory', 'wallet', 'drops', 'turbo', 'store'].includes(name)) return '';
  return name;
}

/** What a link looks like from its address: hls, video, mp3, aac, ogg, twitch - or '' (the test can tell). */
function kindOf(url) {
  const lower = String(url || '').toLowerCase();
  const p = pathOf(url);
  if (twitchChannel(url)) return 'twitch';   // Round 75
  if (p.endsWith('.m3u8')) return 'hls';
  if (/\.(mp4|m4v|mov|webm)$/.test(p)) return 'video';
  if (p.endsWith('.mp3')) return 'mp3';
  if (/\.(aac|aacp|m4a)$/.test(p)) return 'aac';
  if (/\.(ogg|oga)$/.test(p)) return 'ogg';   // (.opus is refused by cleanStreamUrl - never labelled ogg)
  if (lower.includes('icecast') || lower.includes('shoutcast') || /:8000\//.test(lower) || /\/(stream|live|radio)(\.|$|\/)/.test(p)) return 'mp3';
  return '';
}

/** A DNS lookup that refuses private addresses (so a link can't point this server at your own network). */
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  dns.lookup(hostname, { all: true, family: (options && options.family) || 0 }, (err, addresses) => {
    if (err) { callback(err); return; }
    const list = (addresses || []).filter(a => allowLocalForTests || !isPrivateIp(a.address));
    if (!list.length || list.length !== (addresses || []).length) { callback(new Error('That link points at a private address.')); return; }
    if (options && options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

/** What a response's content type (and first bytes) say it is: a kind, or '' if it isn't video/audio. */
function kindFromResponse(type, head, headers) {
  const t = String(type || '').toLowerCase();
  if (t.includes('mpegurl') || head.startsWith('#EXTM3U')) return 'hls';
  if (t.startsWith('video/')) return 'video';
  if (t.includes('audio/mpeg') || t.includes('audio/mp3')) return 'mp3';
  if (t.includes('aac') || t.includes('audio/mp4') || t.includes('audio/x-m4a')) return 'aac';
  if (t.includes('opus')) return 'opus';   // Round 75: told apart so the test can say the game can't play it
  if (t.includes('ogg')) return 'ogg';
  if (headers && (headers['icy-name'] || headers['icy-br'] || headers['icy-metaint'])) return 'mp3';   // an Icecast/Shoutcast server
  return '';
}

// ---------------------------------------------------------------------------- Round 75: Twitch
const TWITCH_UNREACHABLE = 'Couldn\'t reach Twitch - try again in a minute';

/**
 * Round 75: asks Twitch for a channel's HLS playlist address, the way streamlink and the web player do: a playback
 * access token from gql.twitch.tv (with Twitch's own web player id), then the usher playlist link carrying that token.
 * Resolves the playlist URL (a string); rejects with an Error whose message is plain words for the DJ / organiser.
 * The token is good for roughly twenty minutes: whoever uses this must ask again (TWITCH_REFRESH). Both hosts are fixed
 * Twitch addresses, so the private-address checks for DJ links don't apply here.
 */
function resolveTwitch(channel) {
  channel = String(channel || '').toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(channel)) return Promise.reject(new Error('That isn\'t a Twitch channel link (it should look like https://twitch.tv/yourname).'));
  const body = JSON.stringify({
    operationName: 'PlaybackAccessToken',
    variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType: 'embed' },
    extensions: { persistedQuery: { version: 1, sha256Hash: TWITCH_TOKEN_HASH } }
  });
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = text => { if (finished) return; finished = true; reject(new Error(text)); };
    const done = url => { if (finished) return; finished = true; resolve(url); };
    let req;
    try {
      req = https.request('https://gql.twitch.tv/gql', {
        method: 'POST', timeout: TWITCH_TIMEOUT,
        headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'NewMoonSameDark-PatchBay/1.0', accept: '*/*' }
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => { if (text.length < 64 * 1024) text += c; });
        res.on('error', () => fail(TWITCH_UNREACHABLE));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) { fail(`Twitch answered ${res.statusCode} instead of a playback token - try again in a minute`); return; }
            let data;
            try { data = JSON.parse(text); } catch { fail('Twitch sent an answer this server couldn\'t read - try again in a minute'); return; }
            const tok = data && data.data && data.data.streamPlaybackAccessToken;
            if (!tok || typeof tok.value !== 'string' || typeof tok.signature !== 'string' || !tok.value || !tok.signature) { fail(TWITCH_OFFLINE); return; }
            const p = 1 + crypto.randomInt(9999999);
            done(`https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8?token=${encodeURIComponent(tok.value)}&sig=${encodeURIComponent(tok.signature)}&allow_source=true&allow_audio_only=true&player=twitchweb&fast_bread=true&p=${p}`);
          } catch (err) {
            fail(TWITCH_UNREACHABLE + ' (' + clip(err && err.message, 80) + ')');
          }
        });
      });
    } catch (err) {
      fail(TWITCH_UNREACHABLE + ' (' + clip(err && err.message, 80) + ')');
      return;
    }
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', err => {
      const m = String(err && err.message || '');
      fail(/timed out/.test(m) ? 'Twitch didn\'t answer in time - try again in a minute' : TWITCH_UNREACHABLE + (m ? ' (' + clip(m, 80) + ')' : ''));
    });
    try { req.end(body); } catch (err) { fail(TWITCH_UNREACHABLE); }
  });
}

/**
 * Round 75: fetches an HLS playlist address and checks it really is one (#EXTM3U). Resolves '' when it is, else the
 * problem in words. Used for Twitch (usher answers 404 when the channel isn't streaming, even with a good token).
 */
function playlistProblem(url) {
  return new Promise(resolve => {
    let finished = false;
    const done = text => { if (finished) return; finished = true; clearTimeout(overall); resolve(text); };
    const overall = setTimeout(() => done('The playlist didn\'t answer in time - try again in a minute'), TWITCH_TIMEOUT);
    let req;
    try {
      req = https.get(url, { timeout: TWITCH_TIMEOUT, headers: { 'user-agent': 'NewMoonSameDark-PatchBay/1.0', accept: '*/*' } }, res => {
        let head = '';
        res.setEncoding('utf8');
        res.on('data', c => { if (head.length < 4096) head += c; });
        res.on('error', () => done(TWITCH_UNREACHABLE));
        res.on('end', () => {
          const status = res.statusCode || 0;
          if (status === 404) { done(TWITCH_OFFLINE); return; }
          if (status === 403) { done('Twitch refused the playlist (403) - the channel may be subscriber-only, or Twitch has changed its ways'); return; }
          if (status !== 200) { done(`Twitch answered ${status} instead of the playlist - try again in a minute`); return; }
          done(head.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U') ? '' : 'Twitch answered, but not with an HLS playlist - try again in a minute');
        });
      });
    } catch (err) {
      done(TWITCH_UNREACHABLE);
      return;
    }
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', err => done(/timed out/.test(String(err && err.message)) ? 'The playlist didn\'t answer in time - try again in a minute' : TWITCH_UNREACHABLE));
  });
}

/** Round 75: a Twitch channel's working playlist address right now (resolved + checked), or an Error in words. */
async function twitchPlaylist(channel) {
  const url = await resolveTwitch(channel);
  const problem = await playlistProblem(url);
  if (problem) throw new Error(problem);
  return url;
}

/**
 * Round 60: checks a stream link from the server: it must answer (following up to three https redirects),
 * and look like HLS / video / audio. Resolves { ok, kind, text }. Never rejects.
 */
let testsRunning = 0;
const MAX_TESTS = 4;               // Round 60: stream tests running at once (each holds a connection for a few seconds)

function testStream(value) {
  if (isOpus(value)) return Promise.resolve({ ok: false, kind: '', text: OPUS_TEXT + '.' });   // Round 75 (before the link check: it says WHY)
  const url = cleanStreamUrl(value);
  if (!url) return Promise.resolve({ ok: false, kind: '', text: 'That link can\'t be used: it must start with https://, be under ' + MAX_URL + ' characters, and be a public web address (not a home or local one).' });
  if (testsRunning >= MAX_TESTS) return Promise.resolve({ ok: false, kind: '', text: 'Several tests are running already - try again in a few seconds.' });
  const channel = twitchChannel(url);
  if (channel) {
    // Round 75: a Twitch channel - ask Twitch for its playlist and make sure the playlist is really there.
    testsRunning++;
    return twitchPlaylist(channel)
      .then(() => ({ ok: true, kind: 'twitch', text: `Twitch is live - HLS playlist found for ${channel}. Players get the stream as HLS (some Windows PCs can't play it - add a backup link too).` }))
      .catch(err => ({ ok: false, kind: 'twitch', text: clip(err && err.message, 200) || TWITCH_UNREACHABLE }))
      .finally(() => { testsRunning--; });
  }
  testsRunning++;
  return new Promise(resolve => {
    let finished = false;
    let active = null;
    const done = (result) => {
      if (finished) return;
      finished = true;
      testsRunning--;
      clearTimeout(overall);
      if (active) { try { active.destroy(); } catch { /* already closed */ } }
      resolve(result);
    };
    const overall = setTimeout(() => done({ ok: false, kind: '', text: 'No answer within 12 seconds. Is the DJ streaming right now? Check the link opens in your web browser.' }), 12000);
    const go = (link, hops) => {
      let req;
      if (finished) return;
      try {
        req = active = https.get(link, {
          lookup: safeLookup, timeout: 8000, rejectUnauthorized: !allowLocalForTests,
          headers: { 'user-agent': 'NewMoonSameDark-PatchBay/1.0', accept: '*/*', 'icy-metadata': '0' }
        }, res => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location && hops < 3) {
            res.resume();
            let next = '';
            try { next = new URL(res.headers.location, link).toString(); } catch { next = ''; }
            if (!cleanStreamUrl(next)) { done({ ok: false, kind: '', text: 'The link redirects somewhere that isn\'t a public https:// address.' }); return; }
            go(next, hops + 1);
            return;
          }
          if (status !== 200 && status !== 206) {
            res.resume();
            done({ ok: false, kind: '', text: status === 404 ? 'The server says "not found" (404) - the stream may not have started yet, or the link is wrong.'
              : status === 401 || status === 403 ? `The server refused (${status}) - the link may be private or expired.`
                : `The server answered ${status} instead of a stream.` });
            return;
          }
          let head = '';
          let bytes = 0;
          const type = res.headers['content-type'] || '';
          const finish = () => {
            const kind = kindFromResponse(type, head, res.headers);
            res.destroy();
            if (!kind) { done({ ok: false, kind: '', text: `It answered, but it doesn't look like a video or audio stream (it sent "${clip(type, 60) || 'no type'}"). Use the stream link itself, not a web page.` }); return; }
            if (kind === 'opus') { done({ ok: false, kind: '', text: OPUS_TEXT + ' (this stream is Opus).' }); return; }   // Round 75
            if (kind === 'hls' && !head.startsWith('#EXTM3U')) { done({ ok: false, kind, text: 'It says it\'s an HLS playlist, but the playlist is empty or broken.' }); return; }
            if (kind !== 'hls' && bytes === 0) { done({ ok: false, kind, text: 'It answered but sent no sound or picture yet. Is the DJ streaming right now?' }); return; }
            done({ ok: true, kind, text: `Working: ${KIND_NAMES[kind]}${res.headers['icy-name'] ? ' - "' + clip(res.headers['icy-name'], 40) + '"' : ''}.` });
          };
          const wait = setTimeout(finish, 2500);   // a live audio stream never "ends": look at what arrived
          res.on('data', chunk => {
            bytes += chunk.length;
            if (head.length < 64) head += chunk.toString('latin1', 0, Math.min(chunk.length, 64)).replace(/^﻿/, '');
            if (bytes >= 32 * 1024) { clearTimeout(wait); finish(); }
          });
          res.on('end', () => { clearTimeout(wait); finish(); });
          res.on('error', () => { clearTimeout(wait); finish(); });
        });
      } catch (err) {
        done({ ok: false, kind: '', text: 'Couldn\'t open that link: ' + clip(err && err.message, 120) });
        return;
      }
      req.on('timeout', () => { req.destroy(new Error('timed out')); });
      req.on('error', err => {
        const m = String(err && err.message || '');
        done({ ok: false, kind: '', text: /private address/.test(m) ? 'That link points at a private (home or local) address, which players can\'t reach.'
          : /ENOTFOUND|EAI_AGAIN/.test(m) ? 'That web address doesn\'t exist (check the spelling).'
            : /timed out/.test(m) ? 'The stream didn\'t answer in time. Is the DJ streaming right now?'
              : /certificate|SSL|TLS/i.test(m) ? 'The stream\'s https certificate isn\'t valid, so games will refuse it.'
                : 'Couldn\'t reach the stream: ' + clip(m, 120) });
      });
    };
    go(url, 0);
  });
}

// ============================================================================ the data
function blank() {
  return { version: 1, djs: {}, slots: [], events: [], settings: { liveEvents: false }, seq: 1 };
}

let state = blank();
let loadNote = '';

function validTarget(t) {
  t = String(t || '');
  if (/^room:[A-Z]{5}$/.test(t)) return t;
  if (t.startsWith('event:')) {
    const id = cleanId(t.slice(6));
    return id ? 'event:' + id : '';
  }
  return '';
}

function cleanStream(s) {
  const url = cleanStreamUrl(s && s.url);
  if (!url) return null;
  const kind = KINDS.includes(s.kind) ? s.kind : kindOf(url);
  return { url, kind };
}

function cleanDj(d) {
  if (!d || typeof d !== 'object') return null;
  const id = String(d.id || '').replace(/[^a-z0-9-]/g, '').slice(0, 32);
  const name = clip(d.name, 40);
  const key = String(d.key || '').replace(/[^a-z0-9_]/g, '').slice(0, 40);
  if (!id || !name || key.length < 16) return null;
  const photo = cleanStreamUrl(d.photo);
  const streams = (Array.isArray(d.streams) ? d.streams : []).map(cleanStream).filter(Boolean).slice(0, MAX_STREAMS);
  const test = d.test && typeof d.test === 'object' ? { ok: !!d.test.ok, text: clip(d.test.text, 300), at: Number(d.test.at) || 0, kind: KINDS.includes(d.test.kind) ? d.test.kind : '' } : null;
  const out = { id, name, genre: clip(d.genre, 24), photo, contact: clip(d.contact, 80), streams, key, locked: !!d.locked, createdAt: Number(d.createdAt) || Date.now(), test };
  // Round 75: what an approved artist application said (extra fields - a DJ added by hand simply hasn't got them).
  if (APP_KINDS[d.kind]) out.kind = d.kind;
  if (d.about) out.about = clipLines(d.about, 600);
  if (Array.isArray(d.links)) {
    const links = d.links.map(l => cleanStreamUrl(l)).filter(Boolean).slice(0, 3);
    if (links.length) out.links = links;
  }
  if (d.when) out.when = clip(d.when, 200);
  if (d.timezone) out.timezone = clip(d.timezone, 40);
  return out;
}

// Round 75: what an applicant said they do (applications.js has the same list).
const APP_KINDS = { dj: 'DJ', vj: 'VJ (visuals)', live: 'Live act', other: 'Other' };

/** Like clip, but keeps line breaks (an application's "about you"). */
function clipLines(value, max) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function cleanSlot(s) {
  if (!s || typeof s !== 'object') return null;
  const target = validTarget(s.target);
  if (!target || !STAGE_IDS.includes(s.stage)) return null;
  const st = ['waiting', 'live', 'done'].includes(s.state) ? s.state : 'done';
  const url = s.url ? cleanStreamUrl(s.url) : '';
  return {
    id: String(s.id || randomCode(10)).replace(/[^a-z0-9]/g, '').slice(0, 16) || randomCode(10),
    target, stage: s.stage,
    djId: String(s.djId || '').replace(/[^a-z0-9-]/g, '').slice(0, 32),
    name: clip(s.name, 40), genre: clip(s.genre, 24),
    url, kind: KINDS.includes(s.kind) ? s.kind : (url ? kindOf(url) : ''),
    at: Math.max(0, Number(s.at) || 0),
    minutes: Math.max(0, Math.min(24 * 60, Math.round(Number(s.minutes) || 0))),
    state: st, by: s.by === 'host' ? 'host' : s.by === 'dj' ? 'dj' : 'admin',
    liveAt: Number(s.liveAt) || 0, endAt: Number(s.endAt) || 0,
    order: Number(s.order) || 0, createdAt: Number(s.createdAt) || Date.now()
  };
}

function cleanEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const id = String(e.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  const name = clip(e.name, 60);
  if (!id || !name) return null;
  const price = Number(e.ticketPrice);
  return {
    id, name, artist: clip(e.artist, 60), when: clip(e.when, 60),
    free: e.free === true || !(price >= 2), ticketPrice: price >= 2 ? Math.round(price * 100) / 100 : 0,
    stream: cleanStreamUrl(e.stream) || undefined
  };
}

/** Everything read from a file (or pasted as a backup) is cleaned the same way. Rooms from before a restart are gone. */
function cleanState(data) {
  const out = blank();
  if (!data || typeof data !== 'object') return out;
  for (const d of Object.values(data.djs || {}).slice(0, MAX_DJS)) {
    const dj = cleanDj(d);
    if (dj) out.djs[dj.id] = dj;
  }
  out.slots = (Array.isArray(data.slots) ? data.slots : []).map(cleanSlot).filter(s => s && !s.target.startsWith('room:')).slice(-MAX_SLOTS);
  out.events = (Array.isArray(data.events) ? data.events : []).map(cleanEvent).filter(Boolean).slice(0, MAX_EVENTS);
  out.settings = { liveEvents: !!(data.settings && data.settings.liveEvents) };
  out.seq = Math.max(1, Number(data.seq) || 1);
  return out;
}

function load() {
  for (const file of [DATA_FILE, DATA_FILE + '.bak', SEED_FILE]) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    try {
      state = cleanState(JSON.parse(text));
      loadNote = file === DATA_FILE ? '' : file === SEED_FILE ? 'Loaded from your Secret File backup (patchbay.json).' : 'The main file was damaged, so its backup was loaded.';
      return;
    } catch (err) {
      console.error('patchbay: ' + path.basename(file) + ' is damaged:', err && err.message);
    }
  }
}
load();

let saveTimer = null;
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch { /* first save */ }
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('patchbay save', err && err.message);
  }
}

function save() {
  state.seq = (state.seq + 1) % 1000000000;
  if (!saveTimer) saveTimer = setTimeout(saveNow, 400);
}

function flush() { if (saveTimer) saveNow(); }

// ============================================================================ the relay's side
// relay.js tells us which rooms are open and how to reach them (see attach).
let hooks = {
  rooms: () => [],                 // [{ target, code, title, players, listed, event }]
  push: (target, line) => { }      // send one line to everyone in the room(s) for this target
};
function attach(h2) { hooks = Object.assign({}, hooks, h2 || {}); }

const lastSent = new Map();        // target|stage -> what was last pushed (only changes are sent)
const roomGoneAt = new Map();      // target -> when its room closed

function streamOf(slot) {
  if (slot.url) return { url: slot.url, kind: slot.kind || kindOf(slot.url) };
  const dj = state.djs[slot.djId];
  const s = dj && dj.streams[0];
  return s ? { url: s.url, kind: s.kind || kindOf(s.url) } : { url: '', kind: '' };
}

/** Round 60: the DJ's other link, for the game to switch to if the one playing fails ({url:''} if none). */
function backupOf(slot, main) {
  const dj = state.djs[slot.djId];
  if (!dj) return { url: '', kind: '' };
  const other = dj.streams.find(s => s.url && s.url !== main);
  return other ? { url: other.url, kind: other.kind || kindOf(other.url) } : { url: '', kind: '' };
}

function djOf(slot) {
  const dj = state.djs[slot.djId];
  return { name: dj ? dj.name : (slot.name || 'Guest DJ'), genre: dj ? dj.genre : slot.genre, photo: dj ? dj.photo : '' };
}

/** A stage's running order: set times first (earliest first), then the queue in order. */
function runningOrder(target, stage) {
  return state.slots.filter(s => s.target === target && s.stage === stage && s.state === 'waiting')
    .sort((a, b) => ((a.at || Infinity) - (b.at || Infinity)) || (a.order - b.order) || (a.createdAt - b.createdAt));
}

function liveSlot(target, stage) {
  return state.slots.find(s => s.target === target && s.stage === stage && s.state === 'live') || null;
}

// ---------------------------------------------------------------------------- Round 75: Twitch links on a live stage
// The game can't play a Twitch page, so a Twitch link is turned into its HLS playlist address before it goes to players.
// Asking Twitch takes a moment (and stageView must answer at once), so the answers live in this cache and stageView only
// reads it: tendTwitch (called when a slot goes live and from every sweep) fills it, renews it every TWITCH_REFRESH while
// the DJ is live (the token expires), tries again TWITCH_RETRY after a failure, and pushes the stage when the address changes.
const twitchCache = new Map();   // target|stage|main or |backup -> { channel, url, at, failAt, error, pending }

function twitchEntry(target, stage, which, channel) {
  const key = target + '|' + stage + '|' + which;
  let e = twitchCache.get(key);
  if (!e || e.channel !== channel) { e = { channel, url: '', at: 0, failAt: 0, error: '', pending: false }; twitchCache.set(key, e); }
  return e;
}

/** The playlist address players should get for this stage's Twitch stream right now ('' while it's being looked up or failed). */
function twitchUrlFor(target, stage, which, channel) {
  const e = twitchCache.get(target + '|' + stage + '|' + which);
  return e && e.channel === channel ? e.url : '';
}

/** Looks up / renews the Twitch streams of one live stage (nothing to do if it has none). Safe to call often. */
function tendTwitch(target, stage) {
  const live = liveSlot(target, stage);
  const now = Date.now();
  const wanted = [];
  if (live) {
    const s = streamOf(live);
    const b = backupOf(live, s.url);
    if (s.kind === 'twitch') wanted.push(['main', twitchChannel(s.url)]);
    if (b.kind === 'twitch') wanted.push(['backup', twitchChannel(b.url)]);
  }
  for (const which of ['main', 'backup']) {
    const want = wanted.find(w => w[0] === which);
    if (!want || !want[1]) { twitchCache.delete(target + '|' + stage + '|' + which); continue; }
    const e = twitchEntry(target, stage, which, want[1]);
    if (e.pending) continue;
    const due = e.url ? now - e.at >= TWITCH_REFRESH : now - e.failAt >= TWITCH_RETRY;
    if (!due) continue;
    e.pending = true;
    twitchPlaylist(e.channel).then(url => {
      e.pending = false;
      const changed = e.url !== url;
      e.url = url; e.at = Date.now(); e.failAt = 0; e.error = '';
      if (changed) pushStage(target, stage);
    }).catch(err => {
      e.pending = false;
      const hadUrl = !!e.url;
      e.url = ''; e.at = 0; e.failAt = Date.now(); e.error = clip(err && err.message, 200);
      console.log(`patchbay: twitch ${e.channel} on ${target} ${stage}: ${e.error}`);
      if (hadUrl) pushStage(target, stage);   // the players fall back to the backup link (or "connecting") until it's back
    });
  }
}

/** Every live stage's Twitch streams, tended (from sweep). Cache rows of stages that are no longer live go. */
function tendAllTwitch() {
  const seen = new Set();
  for (const s of state.slots) {
    if (s.state !== 'live') continue;
    const key = s.target + '|' + s.stage;
    if (seen.has(key)) continue;
    seen.add(key);
    tendTwitch(s.target, s.stage);
  }
  for (const key of Array.from(twitchCache.keys())) {
    if (!seen.has(key.slice(0, key.lastIndexOf('|')))) twitchCache.delete(key);
  }
}

/** One stage as players see it. */
function stageView(target, stage, now) {
  const live = liveSlot(target, stage);
  const next = runningOrder(target, stage)[0] || null;
  const out = { relay: 'patch', stage, live: false, dj: '', genre: '', photo: '', url: '', kind: '', via: '', backup: '', backupKind: '', backupVia: '', liveFor: 0, next: '', nextIn: -1, by: '' };
  if (live) {
    const who = djOf(live);
    let s = streamOf(live);
    let b = backupOf(live, s.url);
    let via = '', backupVia = '';
    // Round 75: a Twitch link goes out as the HLS playlist Twitch gave us (via:"twitch"); the saved link stays the Twitch one.
    if (s.kind === 'twitch') {
      via = 'twitch';
      s = { url: twitchUrlFor(target, stage, 'main', twitchChannel(s.url)), kind: 'hls' };
    }
    if (b.kind === 'twitch') {
      backupVia = 'twitch';
      b = { url: twitchUrlFor(target, stage, 'backup', twitchChannel(b.url)), kind: 'hls' };
    }
    if (!s.url) {
      // Twitch is still being looked up (or isn't answering): the backup plays meanwhile; with no backup the game shows "connecting".
      if (b.url) { s = b; via = backupVia; b = { url: '', kind: '' }; backupVia = ''; } else s = { url: '', kind: '' };
    }
    if (!b.url) { b = { url: '', kind: '' }; backupVia = ''; }
    Object.assign(out, { live: true, dj: who.name, genre: who.genre || '', photo: who.photo || '', url: s.url, kind: s.kind, via, backup: b.url, backupKind: b.kind, backupVia, liveFor: Math.max(0, Math.round((now - live.liveAt) / 1000)), by: live.by });
    if (live.minutes > 0) out.endsIn = Math.max(0, Math.round((live.liveAt + live.minutes * 60000 - now) / 1000));
  }
  if (next) {
    out.next = djOf(next).name;
    out.nextIn = next.at > 0 ? Math.max(0, Math.round((next.at - now) / 1000)) : -1;
  }
  return out;
}

function signature(v) { return [v.live, v.dj, v.url, v.kind, v.via, v.backup, v.backupKind, v.next, v.by, v.genre, v.photo, v.next ? Math.round(v.nextIn / 60) : 0].join('|'); }

/** Lines for everyone joining a room: one per stage that has something on it. */
function linesFor(target) {
  const now = Date.now();
  const out = [];
  if (!target) return out;
  for (const stage of STAGE_IDS) {
    const v = stageView(target, stage, now);
    if (v.live || v.next) out.push(JSON.stringify(Object.assign(v, { v: state.seq })));
  }
  return out;
}

/** Pushes the stages that changed to the room (a stage with nothing left is sent as live:false, dj:"" to clear it). */
function pushStage(target, stage) {
  const now = Date.now();
  const v = stageView(target, stage, now);
  const key = target + '|' + stage;
  const sig = signature(v);
  if (lastSent.get(key) === sig) return;
  lastSent.set(key, sig);
  try { hooks.push(target, JSON.stringify(Object.assign(v, { v: state.seq }))); } catch (err) { console.error('patchbay push', err && err.message); }
}

function pushAll(target) { for (const stage of STAGE_IDS) pushStage(target, stage); }

/** Round 75: the stats page counts DJ sets starting and ending (analytics may not be loaded in tests - never let that matter). */
function noteActivity(id) {
  try { analytics().noteActivity(id); } catch { /* stats are a nicety */ }
}

function endSlot(slot, now) {
  slot.state = 'done';
  slot.endAt = now;
  noteActivity('dj_stop');
}

function goLive(slot, now) {
  for (const s of state.slots) if (s !== slot && s.target === slot.target && s.stage === slot.stage && s.state === 'live') endSlot(s, now);
  slot.state = 'live';
  slot.liveAt = now;
  noteActivity('dj_live');
  // Round 75: a Twitch link is looked up now; the caller's pushStage sends the stage again when the answer arrives.
  try { tendTwitch(slot.target, slot.stage); } catch (err) { console.error('patchbay twitch', err && err.message); }
}

function trimSlots(now) {
  // Finished sets are kept two days (so you can see what happened), then dropped. Never more than MAX_SLOTS.
  state.slots = state.slots.filter(s => s.state !== 'done' || now - (s.endAt || s.createdAt) < 2 * DAY);
  if (state.slots.length > MAX_SLOTS) state.slots = state.slots.slice(-MAX_SLOTS);
}

/** Every few seconds: set times arrive, sets reach their length, closed rooms are tidied away. */
function sweep() {
  const now = Date.now();
  const changed = new Set();
  for (const s of state.slots) {
    if (s.state === 'live' && s.minutes > 0 && now >= s.liveAt + s.minutes * 60000) {
      endSlot(s, now);
      changed.add(s.target + '|' + s.stage);
    }
  }
  const due = state.slots.filter(s => s.state === 'waiting' && s.at > 0 && s.at <= now).sort((a, b) => a.at - b.at);
  for (const s of due) {
    if (s.minutes > 0 && now >= s.at + s.minutes * 60000) {
      endSlot(s, now);   // its whole set time passed while the server was asleep
    } else {
      goLive(s, now);
      s.liveAt = Math.max(s.at, now - 60000);   // counts from its set time (a sweep can be a few seconds late)
    }
    changed.add(s.target + '|' + s.stage);
  }
  // Rooms (not events) that closed a while ago: their patches go.
  const open = new Set(hooks.rooms().map(r => r.target));
  for (const s of state.slots) {
    if (!s.target.startsWith('room:') || open.has(s.target)) continue;
    if (!roomGoneAt.has(s.target)) roomGoneAt.set(s.target, now);
  }
  for (const t of open) roomGoneAt.delete(t);
  let dropped = false;
  for (const [t, at] of roomGoneAt) {
    if (now - at < ROOM_GRACE) continue;
    roomGoneAt.delete(t);
    const before = state.slots.length;
    state.slots = state.slots.filter(s => s.target !== t);
    if (state.slots.length !== before) dropped = true;
    for (const stage of STAGE_IDS) lastSent.delete(t + '|' + stage);
  }
  trimSlots(now);
  if (changed.size || dropped) save();
  for (const key of changed) {
    const cut = key.lastIndexOf('|');
    pushStage(key.slice(0, cut), key.slice(cut + 1));
  }
  tendAllTwitch();   // Round 75: Twitch playlists renewed / retried while DJs are live
}
setInterval(() => { try { sweep(); } catch (err) { console.error('patchbay sweep', err && err.message); } }, 5000).unref();

/** A room opened: nothing to do but forget it ever closed. */
function roomOpened(target) {
  roomGoneAt.delete(target);
  // Round 60 review: the relay never gives a code back to a reconnecting host (newCode picks a fresh one), so a room
  // that opens with a code which still has patches is a DIFFERENT festival reusing a recently closed code - it must
  // not start on the old room's DJs (a stranger's host-pasted stream). Events keep theirs (that's the point).
  if (target && target.startsWith('room:') && state.slots.some(s => s.target === target)) {
    state.slots = state.slots.filter(s => s.target !== target);
    for (const stage of STAGE_IDS) lastSent.delete(target + '|' + stage);
    shownRooms.delete(target);
    save();
  }
}

/** A room closed (its host left): a room's own patches are kept a while in case the host comes straight back. */
function roomClosed(target) {
  if (target && target.startsWith('room:')) roomGoneAt.set(target, Date.now());
  for (const stage of STAGE_IDS) lastSent.delete(target + '|' + stage);
}

/**
 * A room's host patches a stage from inside the game: {stage, dj, url, kind, live}. The host can't touch a
 * stage the admin has patched (live or queued). Returns {ok, text}.
 */
function hostPatch(target, p) {
  if (!target || !p || typeof p !== 'object') return { ok: false, text: 'Nothing to patch.' };
  const stage = String(p.stage || '');
  if (!STAGE_IDS.includes(stage)) return { ok: false, text: 'Unknown stage.' };
  const now = Date.now();
  const live = liveSlot(target, stage);
  const adminHas = (live && live.by !== 'host') || runningOrder(target, stage).some(s => s.by !== 'host');
  if (adminHas) return { ok: false, text: `The organiser's patch bay has the ${stageName(stage)} right now, so it can't be changed from the game.` };
  if (p.live !== true) {
    if (live) { endSlot(live, now); save(); pushStage(target, stage); }
    return { ok: true, text: `${stageName(stage)}: back to its own music.` };
  }
  const url = cleanStreamUrl(p.url);
  if (!url) return { ok: false, text: 'That stream link can\'t be used: it must be a public https:// link (under 500 characters).' };
  const kind = KINDS.includes(p.kind) ? p.kind : kindOf(url);
  const hostSlots = state.slots.filter(s => s.target === target && s.by === 'host');
  if (hostSlots.length >= MAX_HOST_SLOTS) {
    // Oldest finished ones go first.
    const oldest = hostSlots.filter(s => s.state === 'done').sort((a, b) => a.endAt - b.endAt)[0];
    if (oldest) state.slots.splice(state.slots.indexOf(oldest), 1);
    else return { ok: false, text: 'Too many patches in this room.' };
  }
  const slot = cleanSlot({ id: randomCode(10), target, stage, name: clip(p.dj, 40) || 'Guest DJ', genre: clip(p.genre, 24), url, kind, state: 'waiting', by: 'host', createdAt: now });
  state.slots.push(slot);
  goLive(slot, now);
  save();
  pushStage(target, stage);
  return { ok: true, text: `LIVE: ${slot.name} on the ${stageName(stage)}.` };
}

/**
 * Round 66: a festival's DJ set times for the game's schedule board (GET /schedule): the sets live now and the ones with a
 * set time in the next <horizon> ms, earliest first - [{stage, dj, at, minutes, live}]. Queued sets with no time (the
 * organiser presses GO LIVE) aren't on it: they have no time to show. A LIVE set is always on it, with live:true and
 * at = when it actually went live (in the past - the horizon never drops it), so the board can say "on now".
 */
function scheduleFor(target, now, horizon) {
  target = validTarget(target);
  if (!target) return [];
  const out = [];
  for (const s of state.slots) {
    if (s.target !== target) continue;
    if (s.state === 'live') {
      out.push({ stage: s.stage, dj: clip(djOf(s).name, 40), at: s.liveAt, minutes: s.minutes, live: true });
    } else if (s.state === 'waiting' && s.at > 0 && s.at <= now + horizon && s.at + Math.max(1, s.minutes) * 60000 > now) {
      out.push({ stage: s.stage, dj: clip(djOf(s).name, 40), at: s.at, minutes: s.minutes, live: false });
    }
  }
  out.sort((a, b) => (a.at - b.at) || a.stage.localeCompare(b.stage));
  return out.slice(0, 200);
}

/** "DJ A - Main Stage" for each live stage of a room (for the Festivals list). */
function onStage(target) {
  const out = [];
  if (!target) return out;
  for (const stage of STAGE_IDS) {
    const live = liveSlot(target, stage);
    if (live && streamOf(live).url) out.push(clip(djOf(live).name, 30) + ' - ' + stageName(stage));
  }
  return out;
}

// ============================================================================ live events made here
function events() { return state.events.slice(); }
function liveEventsSwitch() { return !!state.settings.liveEvents; }

/** Adds this page's events (and its Live events switch) to the game's list (/vendors.json). */
function mergeIntoFeed(text) {
  if (!state.events.length && !state.settings.liveEvents) return text;
  let feed;
  try { feed = JSON.parse(text); } catch { return text; }
  if (!feed || typeof feed !== 'object') return text;
  const list = Array.isArray(feed.events) ? feed.events : [];
  const have = new Set(list.map(e => cleanId(e && e.id)));
  for (const e of state.events) if (!have.has(cleanId(e.id))) list.push(Object.assign({}, e));
  feed.events = list;
  if (state.settings.liveEvents) feed.features = Object.assign({}, feed.features || {}, { liveEvents: true });
  return JSON.stringify(feed);
}

// ============================================================================ pages
const CSS = `<style>
.card{background:#181c24;border:1px solid #2a2f3a;border-radius:10px;padding:12px 14px;margin:12px 0}
.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.grow{flex:1 1 180px}
.live{color:#111;background:#ff4d6a;border-radius:6px;padding:2px 8px;font-weight:800}
.next{color:#e8b14c;font-weight:700}.muted{color:#8a93a3}
button.go{background:#3ddc84;font-size:16px;padding:12px 18px}button.stop{background:#ff4d6a;font-size:16px;padding:12px 18px}
button.ghost{background:#2a2f3a;color:#e8eaf0}input,select,textarea{box-sizing:border-box;max-width:100%}
textarea{width:100%;min-height:90px;padding:9px;border-radius:6px;border:1px solid #444;background:#1d212b;color:#fff}
form.inline{display:inline}.link{font:13px ui-monospace,Menlo,monospace;word-break:break-all;background:#1d212b;border:1px dashed #e8b14c;border-radius:8px;padding:8px;user-select:all}
details summary{cursor:pointer;padding:6px 0;font-weight:700}.ok{color:#6fd49a}.bad{color:#ff8a80}
label{display:block;margin-top:8px;font-size:13px;color:#aab2c0}img.dj{width:48px;height:48px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px}
</style>`;

const TZ_SCRIPT = `<script>
document.querySelectorAll('input.tz').forEach(e=>{e.value=new Date().getTimezoneOffset()});
document.querySelectorAll('[data-ms]').forEach(e=>{const d=new Date(Number(e.dataset.ms));if(!isNaN(d))e.textContent=d.toLocaleString([], {weekday:'short',hour:'2-digit',minute:'2-digit'})+' ('+e.textContent+')'});
</script>`;

// Round 75: the same plain-words guide on the DJ's own page, the admin's DJ form and the quick test (see also README.txt).
const HOW_TO_LINK = `<h3 style="margin-bottom:4px">How to get a stream link</h3><ol class="small" style="margin-top:4px;padding-left:20px">
<li><b>Twitch (easiest):</b> paste your channel link, e.g. <span class="link" style="display:inline;padding:1px 4px">https://twitch.tv/yourname</span> - go live in OBS or your DJ software to Twitch as usual.
Works best on phones and Macs; some Windows PCs can't play Twitch's HLS, so add a backup link too.</li>
<li><b>Audio only, most reliable everywhere:</b> stream MP3 or AAC to an Icecast server with BUTT (free) or Mixxx - your host gives you a link like
<span class="link" style="display:inline;padding:1px 4px">https://host:8000/live</span>. Paste that.</li>
<li><b>Your own RTMP (OBS &rarr; a video service):</b> services like AWS IVS or Cloudflare Stream give you an RTMP address for OBS and a playback .m3u8 link - paste the .m3u8 link here.
(Our game server can't take RTMP directly: Render only passes web traffic.)</li></ol>
<p class="small muted">Not supported: Opus (.opus) links - the game can't play them - and web pages with a player on them (YouTube, SoundCloud, Mixcloud...).</p>`;

/** Round 75: a live stage's Twitch look-up, in words, for the admin page. */
function twitchNote(target, stage) {
  const e = twitchCache.get(target + '|' + stage + '|main');
  if (!e) return 'Twitch: looking up the playlist...';
  if (e.url) return 'Twitch: playlist found' + (e.at ? ' (' + ago(e.at - Date.now()) + ')' : '');
  if (e.pending && !e.failAt) return 'Twitch: looking up the playlist...';
  return 'Twitch: ' + (e.error || 'not answering') + ' - trying again every minute';
}

function ago(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  const words = m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  return ms >= 0 ? 'in ' + words : words + ' ago';
}

function when(at, now) { return at > 0 ? `<span data-ms="${at}">${h(ago(at - now))}</span>` : 'when you press GO LIVE'; }

function targetTitle(target, rooms) {
  const r = rooms.find(x => x.target === target);
  if (target === 'event:public') return 'The public festival (always open, 24/7)';   // Round 66
  if (target.startsWith('event:')) {
    const ev = pay().findEvent(target.slice(6));
    return (ev ? ev.name : target.slice(6)) + ' (live event)';
  }
  return r && r.title ? `${r.title} (room ${target.slice(5)})` : 'Room ' + target.slice(5);
}

function targetStatus(target, rooms) {
  const r = rooms.find(x => x.target === target);
  if (r) return `<span class="ok">OPEN</span> &middot; ${r.players} ${r.players === 1 ? 'person' : 'people'} in it${r.listed ? ' &middot; public' : ''}`;
  if (target.startsWith('event:')) return '<span class="muted">not open yet - the organiser opens it from the game (Settings &gt; Live events)</span>';
  return '<span class="muted">this room is closed</span>';
}

/** Which rooms/events the page shows: every event, every open public room, anything with patches. */
function targetsShown(rooms) {
  const out = [];
  const add = t => { if (t && !out.includes(t)) out.push(t); };
  for (const r of rooms) if (r.target.startsWith('event:')) add(r.target);
  try { for (const e of pay().allEvents()) add('event:' + cleanId(e.id)); } catch { /* payments not ready */ }
  for (const r of rooms) if (!r.target.startsWith('event:') && r.listed) add(r.target);
  // Round 60: private rooms you asked to see (by their code), while they're open.
  for (const t of Array.from(shownRooms)) {
    if (rooms.some(r => r.target === t)) add(t);
    else shownRooms.delete(t);
  }
  for (const s of state.slots) if (s.state !== 'done') add(s.target);
  return out;
}

/** Round 67: "Artist applications (3 waiting)" - into /admin/applications. */
function appsButton(key) {
  let waiting = 0;
  try { waiting = require('./applications').waitingCount(); } catch { waiting = 0; }
  return `<form class="inline" method="post" action="/admin/applications">${hidden(key)}<button type="submit"${waiting ? '' : ' class="ghost"'}>Artist applications${waiting ? ` (${waiting} waiting)` : ''}</button></form>`;
}

function hidden(key) { return require('./adminauth').hidden(key); }   // Round 110: the session's CSRF token (key = that token now)

function button(key, action, fields, text, cls, confirmText) {
  const inputs = Object.entries(fields || {}).map(([k, v]) => `<input type="hidden" name="${h(k)}" value="${h(v)}">`).join('');
  return `<form class="inline" method="post" action="/admin/patch"${confirmText ? ` onsubmit="return confirm(${h(JSON.stringify(String(confirmText)))})"` : ''}>${hidden(key)}<input type="hidden" name="action" value="${h(action)}">${inputs}<button type="submit"${cls ? ` class="${cls}"` : ''}>${h(text)}</button></form>`;
}

function djOptions(selected) {
  const list = Object.values(state.djs).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) return '<option value="">(add a DJ below first)</option>';
  return list.map(d => `<option value="${h(d.id)}"${d.id === selected ? ' selected' : ''}>${h(d.name)}${d.genre ? ' - ' + h(d.genre) : ''}${d.streams.length ? '' : ' (no stream link yet)'}</option>`).join('');
}

function stageOptions(selected) {
  return STAGES.map(s => `<option value="${s.id}"${s.id === selected ? ' selected' : ''}>${h(s.name)}</option>`).join('');
}

function adminHtml(key, note) {
  const now = Date.now();
  let rooms = [];
  try { rooms = hooks.rooms(); } catch { rooms = []; }
  const targets = targetsShown(rooms);
  const parts = [];
  parts.push(CSS);
  parts.push('<h1>DJ Patch Bay</h1>');
  if (note) parts.push(`<div class="code" style="font-size:15px;letter-spacing:0;text-align:left;white-space:pre-wrap">${h(note)}</div>`);
  if (loadNote) parts.push(`<p class="small">${h(loadNote)}</p>`);
  parts.push(`<p class="small">1. Add your DJs (bottom of this page). 2. Pick a room or live event, choose a stage and a DJ, then GO LIVE now or give a set time.
3. Everyone in that festival sees and hears the DJ on that stage. Players who arrive later get it too.</p>`);
  parts.push(`<div class="row">${button(key, 'refresh', {}, 'Refresh', 'ghost')}<form class="inline" method="post" action="/admin">${hidden(key)}<button type="submit" class="ghost">Back to admin</button></form>${appsButton(key)}</div>`);   // Round 67: + artist applications
  if (!PERSISTENT) {
    parts.push(`<p class="small bad">Heads-up: this server keeps the patch bay in a file it FORGETS when it restarts (a free Render server restarts after
15 idle minutes and on every update). After changing your DJs, press "Download backup" at the bottom and follow README.txt "KEEPING THE PATCH BAY".</p>`);
  }

  // ---- now playing
  parts.push('<h2>Now playing</h2>');
  const rowsNow = [];
  for (const t of targets) {
    for (const st of STAGES) {
      const v = stageView(t, st.id, now);
      if (!v.live && !v.next) continue;
      rowsNow.push(`<tr><td><b>${h(st.name)}</b><br><span class="small">${h(targetTitle(t, rooms))}</span></td><td>${v.live
        ? `<span class="live">LIVE</span> ${h(v.dj)} <span class="small">for ${h(ago(-v.liveFor * 1000).replace(' ago', ''))}${v.url ? (v.via === 'twitch' ? ' - via Twitch' : '') : v.via === 'twitch' ? ' - ' + h(twitchNote(t, st.id)) : ' - NO STREAM LINK'}</span><br>${button(key, 'stage-stop', { target: t, stage: st.id }, 'STOP', 'stop')}`
        : '<span class="muted">own music</span>'}${v.next ? `<br><span class="next">Next: ${h(v.next)}</span> <span class="small">${v.nextIn >= 0 ? h(ago(v.nextIn * 1000)) : 'queued'}</span> ${button(key, 'stage-golive', { target: t, stage: st.id }, 'GO LIVE', 'go')}` : ''}</td></tr>`);
    }
  }
  parts.push(rowsNow.length ? `<table>${rowsNow.join('')}</table>` : '<p class="muted">Nothing is patched yet. Every stage plays the festival\'s own music.</p>');

  // ---- each room / event
  parts.push('<h2>Rooms and live events</h2>');
  if (!targets.length) parts.push('<p class="muted">No live events and no open public rooms right now. Make a live event below, or type a room code.</p>');
  for (const t of targets) {
    const card = [`<div class="card"><b>${h(targetTitle(t, rooms))}</b><br><span class="small">${targetStatus(t, rooms)}</span>`];
    for (const st of STAGES) {
      const v = stageView(t, st.id, now);
      const order = runningOrder(t, st.id);
      const live = liveSlot(t, st.id);
      const summary = v.live ? `<span class="live">LIVE</span> ${h(v.dj)}` : order.length ? `<span class="next">next: ${h(v.next)}</span>` : '<span class="muted">own music</span>';
      const lines = [];
      if (live) {
        lines.push(`<div class="row"><span class="grow"><span class="live">LIVE</span> ${h(djOf(live).name)} <span class="small">${h(streamOf(live).url || 'no stream link')}${streamOf(live).kind === 'twitch' ? ' &middot; ' + h(twitchNote(t, st.id)) : ''}${live.minutes ? ' &middot; ends ' + h(ago(live.liveAt + live.minutes * 60000 - now)) : ''}${live.by === 'host' ? ' &middot; patched from the game' : ''}</span></span>${button(key, 'stage-stop', { target: t, stage: st.id }, 'STOP', 'stop')}</div>`);
      }
      order.forEach((s, i) => {
        lines.push(`<div class="row"><span class="grow">${i + 1}. <b>${h(djOf(s).name)}</b> <span class="small">${when(s.at, now)}${s.minutes ? ', ' + s.minutes + ' min' : ''} &middot; ${h(streamOf(s).url || 'no stream link')}</span></span>
${button(key, 'slot-live', { slot: s.id }, 'GO LIVE now', 'go')}${s.at ? '' : button(key, 'slot-up', { slot: s.id }, 'Up', 'ghost')}${button(key, 'slot-remove', { slot: s.id }, 'Remove', 'ghost')}</div>`);
      });
      if (!live && !order.length) lines.push('<p class="small">Nothing patched: this stage plays the festival\'s own music.</p>');
      card.push(`<details${v.live || order.length ? ' open' : ''}><summary>${h(st.name)} - ${summary}</summary>${lines.join('')}</details>`);
    }
    card.push(`<details><summary>+ Patch a DJ into this ${t.startsWith('event:') ? 'event' : 'room'}</summary>
<form method="post" action="/admin/patch">${hidden(key)}<input type="hidden" name="action" value="slot-add"><input type="hidden" name="target" value="${h(t)}"><input type="hidden" class="tz" name="tz" value="">
<label>Stage</label><select name="stage">${stageOptions('main')}</select>
<label>DJ</label><select name="dj">${djOptions('')}</select>
<label>Which stream</label><select name="which"><option value="0">the DJ's main link</option><option value="1">the DJ's backup link</option><option value="custom">this link instead:</option></select>
<input name="url" placeholder="https://... (only for 'this link instead')" style="width:100%;margin-top:4px">
<label>When</label><select name="when"><option value="now">LIVE NOW</option><option value="queue">Next in the running order (I'll press GO LIVE)</option><option value="at">At a set time:</option></select>
<input type="datetime-local" name="at" style="margin-top:4px">
<label>Set length in minutes (optional - it stops by itself)</label><input name="minutes" inputmode="numeric" placeholder="e.g. 60" style="width:120px">
<div><button type="submit" class="go">Patch DJ</button></div></form></details>`);
    card.push('</div>');
    parts.push(card.join(''));
  }
  parts.push(`<form method="post" action="/admin/patch" class="row">${hidden(key)}<input type="hidden" name="action" value="room-add">
<input name="code" placeholder="Room code, e.g. ABCDE" maxlength="5" style="width:170px;text-transform:uppercase"><button type="submit" class="ghost">Show a private room</button></form>`);

  // ---- DJ roster
  parts.push('<h2>DJ roster</h2>');
  const djs = Object.values(state.djs).sort((a, b) => a.name.localeCompare(b.name));
  if (!djs.length) parts.push('<p class="muted">No DJs yet - add the first one below.</p>');
  for (const d of djs) {
    const link = (pay().baseUrl() || 'https://YOUR-SERVER.onrender.com') + '/dj?key=' + d.key;
    const sets = state.slots.filter(s => s.djId === d.id && s.state !== 'done').length;
    parts.push(`<div class="card">${d.photo ? `<img class="dj" src="${h(d.photo)}" alt="" referrerpolicy="no-referrer">` : ''}<b>${h(d.name)}</b> <span class="small">${d.kind ? h(APP_KINDS[d.kind]) + ' &middot; ' : ''}${h(d.genre || '')}${d.contact ? ' &middot; ' + h(d.contact) : ''} &middot; ${sets} set${sets === 1 ? '' : 's'} coming up${d.locked ? ' &middot; LOCKED' : ''}</span>
${d.about ? `<p class="small" style="white-space:pre-wrap">${h(d.about)}</p>` : ''}${d.when || d.timezone ? `<p class="small muted">Can play: ${h(d.when || '-')}${d.timezone ? ' (' + h(d.timezone) + ')' : ''}</p>` : ''}${d.links && d.links.length ? `<p class="small muted">Links: ${d.links.map(l => `<a href="${h(l)}" rel="noopener noreferrer nofollow" target="_blank">${h(l)}</a>`).join(' &middot; ')}</p>` : ''}
${d.streams.map((s, i) => `<div class="row"><span class="grow small">${i === 0 ? 'Main' : 'Backup'}: ${h(s.url)} <span class="muted">(${h(KIND_NAMES[s.kind] || 'type found by the test')})</span></span>${button(key, 'dj-test', { dj: d.id, i }, 'Test stream', 'ghost')}</div>`).join('') || '<p class="small bad">No stream link yet - add one (Edit), or send the DJ their link so they can.</p>'}
${d.test ? `<p class="small ${d.test.ok ? 'ok' : 'bad'}">Last test (${h(ago(d.test.at - now))}): ${h(d.test.text)}</p>` : ''}
<p class="small">Their private DJ link (send it only to them):</p><div class="link">${h(link)}</div>
<div class="row" style="margin-top:6px">${button(key, 'dj-lock', { dj: d.id }, d.locked ? 'Unlock (let them press I\'m live)' : 'Lock (only you start/stop their sets)', 'ghost')}${button(key, 'dj-newkey', { dj: d.id }, 'Make a new link', 'ghost', 'Their old link stops working. Continue?')}${button(key, 'dj-remove', { dj: d.id }, 'Remove DJ', 'ghost', 'Remove this DJ and their upcoming sets?')}</div>
<details><summary>Edit</summary>${djForm(key, 'dj-edit', d)}</details></div>`);
  }
  parts.push(`<details${djs.length ? '' : ' open'}><summary>+ Add a DJ</summary>${djForm(key, 'dj-add', null)}</details>`);

  // ---- a quick stream test
  parts.push(`<h2>Test any stream link</h2><form method="post" action="/admin/patch" class="row">${hidden(key)}<input type="hidden" name="action" value="test">
<input name="url" placeholder="https://..." class="grow"><button type="submit">Test stream</button></form>${HOW_TO_LINK}`);

  // ---- live events made here
  const vendorOn = !!(pay().vendorFeatures().liveEvents);
  parts.push(`<h2>Live events</h2><p class="small">Live events are ${vendorOn || state.settings.liveEvents ? '<span class="on">ON</span>' : '<span class="off">OFF</span>'}
${vendorOn ? '(switched on in vendors.json)' : ''}. Events made here show in the game's Settings &gt; Live events within about 10 minutes (or when players restart the game).
The organiser opens one from the game with the event password (EVENT_HOST_KEY${process.env.EVENT_HOST_KEY && process.env.EVENT_HOST_KEY.length >= 8 ? ' - set' : ' - NOT SET on Render yet'}).</p>
${vendorOn ? '' : button(key, 'events-switch', {}, state.settings.liveEvents ? 'Switch live events OFF' : 'Switch live events ON', state.settings.liveEvents ? 'ghost' : 'go')}`);
  for (const e of state.events) {
    parts.push(`<div class="card row"><span class="grow"><b>${h(e.name)}</b> <span class="small">${h(e.artist || '')} &middot; id ${h(e.id)} &middot; ${h(e.when || 'time TBA')} &middot; ${e.free ? 'free' : '$' + e.ticketPrice.toFixed(2) + ' tickets'}</span></span>${button(key, 'event-remove', { id: e.id }, 'Remove', 'ghost', 'Remove this event? Tickets already sold for it stop working.')}</div>`);
  }
  parts.push(`<details><summary>+ Make a live event</summary><form method="post" action="/admin/patch">${hidden(key)}<input type="hidden" name="action" value="event-add">
<label>Short id (letters, numbers and -, never change it once tickets are sold)</label><input name="id" placeholder="moonrise" maxlength="30">
<label>Name</label><input name="name" placeholder="Moonrise Live" maxlength="60">
<label>Headline artist</label><input name="artist" placeholder="DJ Example" maxlength="60">
<label>When (in words)</label><input name="when" placeholder="Saturday 9pm ET" maxlength="60">
<label>Ticket price in US dollars (leave empty for a FREE event)</label><input name="price" inputmode="decimal" placeholder="10.00" style="width:120px">
<div><button type="submit" class="go">Make event</button></div></form></details>`);

  // ---- backup
  parts.push(`<h2>Backup</h2><p class="small">Everything on this page (DJs, their private links, set times, events) in one file.</p>
${button(key, 'backup', {}, 'Download backup', 'ghost')}
<details><summary>Restore from a backup</summary><form method="post" action="/admin/patch" onsubmit="return confirm('Replace everything on this page with the backup?')">${hidden(key)}<input type="hidden" name="action" value="restore">
<textarea name="data" placeholder="Paste the whole backup file here"></textarea><button type="submit">Restore</button></form></details>`);
  parts.push(TZ_SCRIPT);
  return parts.join('\n');
}

function djForm(key, action, d) {
  const s0 = d && d.streams[0] ? d.streams[0].url : '';
  const s1 = d && d.streams[1] ? d.streams[1].url : '';
  return `<form method="post" action="/admin/patch">${hidden(key)}<input type="hidden" name="action" value="${action}">${d ? `<input type="hidden" name="dj" value="${h(d.id)}">` : ''}
<label>DJ name</label><input name="name" maxlength="40" value="${h(d ? d.name : '')}" style="width:100%">
<label>Genre</label><input name="genre" maxlength="24" value="${h(d ? d.genre : '')}" placeholder="house, techno, drum &amp; bass...">
<label>Main stream link (https:// - a Twitch channel link, an HLS .m3u8 or .mp4 video link, or an Icecast .mp3/.aac/.ogg audio link - not .opus)</label><input name="stream0" value="${h(s0)}" style="width:100%" placeholder="https://twitch.tv/theirname or https://...">
<label>Backup stream link (optional - for Twitch DJs, an audio link here means Windows players hear them too)</label><input name="stream1" value="${h(s1)}" style="width:100%" placeholder="https://...">
<details><summary>How to get a stream link</summary>${HOW_TO_LINK}</details>
<label>Photo link (optional, https://)</label><input name="photo" value="${h(d ? d.photo : '')}" style="width:100%">
<label>Contact (optional - email or phone, only you see it)</label><input name="contact" maxlength="80" value="${h(d ? d.contact : '')}" style="width:100%">
<div><button type="submit">${d ? 'Save' : 'Add DJ'}</button></div></form>`;
}

function newDjId(name) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'dj';
  let id;
  do { id = base + '-' + randomCode(4); } while (state.djs[id]);
  return id;
}

function newKey() { return 'dj_' + randomCode(24); }

/** Reads the DJ form: {ok, text, fields}. */
function djFields(form) {
  const name = clip(form.get('name'), 40);
  if (!name) return { ok: false, text: 'Type the DJ\'s name.' };
  const streams = [];
  for (const k of ['stream0', 'stream1']) {
    const raw = String(form.get(k) || '').trim();
    if (!raw) continue;
    const url = cleanStreamUrl(raw);
    if (!url) return { ok: false, text: `That stream link can't be used: "${clip(raw, 80)}". It must start with https://, be a public web address and be under ${MAX_URL} characters.` };
    streams.push({ url, kind: kindOf(url) });
  }
  const photoRaw = String(form.get('photo') || '').trim();
  const photo = photoRaw ? cleanStreamUrl(photoRaw) : '';
  if (photoRaw && !photo) return { ok: false, text: 'The photo link must be a public https:// link.' };
  return { ok: true, fields: { name, genre: clip(form.get('genre'), 24), contact: clip(form.get('contact'), 80), photo, streams } };
}

function parseLocalTime(at, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(at || ''));
  if (!m) return 0;
  const offset = Number(tz);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + (Number.isFinite(offset) && Math.abs(offset) <= 840 ? offset : 0) * 60000;
  return Number.isFinite(ms) ? ms : 0;
}

function findSlot(id) { return state.slots.find(s => s.id === String(id || '')) || null; }

/** Runs one admin action. Resolves the note to show (or a {download}). */
async function adminAction(action, form) {
  const now = Date.now();
  switch (action) {
    case 'refresh':
    case null:
    case undefined:
    case '':
      return '';
    case 'dj-add': {
      if (Object.keys(state.djs).length >= MAX_DJS) return `The roster is full (${MAX_DJS} DJs). Remove one first.`;
      const r = djFields(form);
      if (!r.ok) return r.text;
      const id = newDjId(r.fields.name);
      state.djs[id] = Object.assign({ id, key: newKey(), locked: false, createdAt: now, test: null }, r.fields);
      save();
      return `${r.fields.name} is on the roster. Send them their private DJ link (in their card below) - they can paste their own stream link and press "I'm live" in their set.`;
    }
    case 'dj-edit': {
      const d = state.djs[String(form.get('dj') || '')];
      if (!d) return 'That DJ isn\'t on the roster any more.';
      const r = djFields(form);
      if (!r.ok) return r.text;
      Object.assign(d, r.fields);
      save();
      pushDj(d.id);   // a new link, name, genre or photo reaches the players on every stage they're on
      return `Saved ${d.name}.`;
    }
    case 'dj-remove': {
      const d = state.djs[String(form.get('dj') || '')];
      if (!d) return '';
      const touched = new Set();
      for (const s of state.slots) {
        if (s.djId !== d.id || s.state === 'done') continue;
        endSlot(s, now);
        touched.add(s.target + '|' + s.stage);
      }
      delete state.djs[d.id];
      save();
      for (const k of touched) { const c = k.lastIndexOf('|'); pushStage(k.slice(0, c), k.slice(c + 1)); }
      return `${d.name} was removed (and their sets stopped).`;
    }
    case 'dj-newkey': {
      const d = state.djs[String(form.get('dj') || '')];
      if (!d) return '';
      d.key = newKey();
      save();
      return `${d.name} has a new private link (their old one no longer works).`;
    }
    case 'dj-lock': {
      const d = state.djs[String(form.get('dj') || '')];
      if (!d) return '';
      d.locked = !d.locked;
      save();
      return d.locked ? `${d.name} is locked: only you start and stop their sets.` : `${d.name} can press "I'm live" and "End set" during their own sets again.`;
    }
    case 'dj-test': {
      const d = state.djs[String(form.get('dj') || '')];
      const s = d && d.streams[Number(form.get('i')) || 0];
      if (!s) return 'That DJ has no stream link to test.';
      const r = await testStream(s.url);
      d.test = { ok: r.ok, text: r.text, at: Date.now(), kind: r.kind };
      if (r.ok && r.kind && s.kind !== r.kind) { s.kind = r.kind; pushDj(d.id); }
      save();
      return `${d.name}: ${r.ok ? 'WORKING' : 'NOT WORKING'} - ${r.text}`;
    }
    case 'test': {
      const r = await testStream(form.get('url'));
      return (r.ok ? 'WORKING - ' : 'NOT WORKING - ') + r.text;
    }
    case 'room-add': {
      const code = String(form.get('code') || '').toUpperCase().replace(/[^A-Z]/g, '');
      const target = validTarget('room:' + code);
      if (!target) return 'Type the room\'s 5-letter code.';
      const open = hooks.rooms().find(r => r.target === target);
      if (!open) return `No open room with the code ${code} right now (an event's room is listed by the event's name instead).`;
      // Shown until it closes: a waiting marker isn't needed - we add a tiny "shown" note by keeping it in the list.
      shownRooms.add(target);
      return `Room ${code} is shown below. Patch a DJ into it.`;
    }
    case 'slot-add': {
      const target = validTarget(form.get('target'));
      const stage = String(form.get('stage') || '');
      if (!target || !STAGE_IDS.includes(stage)) return 'Pick a room and a stage.';
      const d = state.djs[String(form.get('dj') || '')];
      if (!d) return 'Pick a DJ (add them to the roster first).';
      const which = String(form.get('which') || '0');
      let url = '';
      if (which === 'custom') {
        url = cleanStreamUrl(form.get('url'));
        if (!url) return 'That stream link can\'t be used: it must be a public https:// link under 500 characters.';
      } else if (which === '1') {
        if (!d.streams[1]) return `${d.name} has no backup link. Choose their main link, or paste one.`;
        url = d.streams[1].url;
      } else if (!d.streams[0]) {
        return `${d.name} has no stream link yet. Add one (Edit on their card), or send them their DJ link so they can.`;
      }
      const mode = String(form.get('when') || 'now');
      let at = 0;
      if (mode === 'at') {
        at = parseLocalTime(form.get('at'), form.get('tz'));
        if (!at) return 'Pick the date and time for the set.';
        if (at < now - 5 * 60000) return 'That time has already passed.';
        if (at > now + 90 * DAY) return 'That\'s more than 90 days away.';
      }
      const minutes = Math.max(0, Math.min(24 * 60, Math.round(Number(form.get('minutes')) || 0)));
      if (state.slots.length >= MAX_SLOTS) trimSlots(now);
      const order = Math.max(0, ...state.slots.filter(s => s.target === target && s.stage === stage).map(s => s.order)) + 1;
      const slot = cleanSlot({ id: randomCode(10), target, stage, djId: d.id, url: which === '0' ? '' : url, kind: url ? kindOf(url) : '', at, minutes, state: 'waiting', by: 'admin', order, createdAt: now });
      state.slots.push(slot);
      if (mode === 'now') goLive(slot, now);
      save();
      pushStage(target, stage);
      return mode === 'now' ? `LIVE: ${d.name} on the ${stageName(stage)}. Players there see and hear them within a few seconds.`
        : mode === 'at' ? `${d.name} goes live on the ${stageName(stage)} ${ago(at - now)} (by itself).`
          : `${d.name} is next on the ${stageName(stage)} - press GO LIVE when it's time.`;
    }
    case 'slot-live': {
      const s = findSlot(form.get('slot'));
      if (!s || s.state !== 'waiting') return 'That set isn\'t waiting any more.';
      if (!streamOf(s).url) return `${djOf(s).name} has no stream link yet.`;
      goLive(s, now);
      save();
      pushStage(s.target, s.stage);
      return `LIVE: ${djOf(s).name} on the ${stageName(s.stage)}.`;
    }
    case 'slot-remove': {
      const s = findSlot(form.get('slot'));
      if (!s) return '';
      state.slots.splice(state.slots.indexOf(s), 1);
      save();
      pushStage(s.target, s.stage);
      return `Removed ${djOf(s).name} from the ${stageName(s.stage)}.`;
    }
    case 'slot-up': {
      const s = findSlot(form.get('slot'));
      if (!s || s.state !== 'waiting' || s.at) return '';
      const queue = runningOrder(s.target, s.stage).filter(x => !x.at);
      const i = queue.indexOf(s);
      if (i > 0) {
        // Round 60: swap places with the set in front (if they had the same number, go just ahead of it).
        const ahead = queue[i - 1];
        const o = ahead.order;
        ahead.order = s.order;
        s.order = o === ahead.order ? o - 1 : o;
        save();
        pushStage(s.target, s.stage);
      }
      return '';
    }
    case 'stage-stop': {
      const target = validTarget(form.get('target'));
      const stage = String(form.get('stage') || '');
      const live = target && liveSlot(target, stage);
      if (!live) return 'Nothing was live there.';
      endSlot(live, now);
      save();
      pushStage(target, stage);
      return `Stopped ${djOf(live).name}. The ${stageName(stage)} plays its own music again.`;
    }
    case 'stage-golive': {
      const target = validTarget(form.get('target'));
      const stage = String(form.get('stage') || '');
      const next = target && STAGE_IDS.includes(stage) ? runningOrder(target, stage)[0] : null;
      if (!next) return 'Nothing is queued on that stage - patch a DJ first.';
      if (!streamOf(next).url) return `${djOf(next).name} has no stream link yet.`;
      goLive(next, now);
      save();
      pushStage(target, stage);
      return `LIVE: ${djOf(next).name} on the ${stageName(stage)}.`;
    }
    case 'events-switch':
      state.settings.liveEvents = !state.settings.liveEvents;
      save();
      return state.settings.liveEvents ? 'Live events are ON. Players see them within about 10 minutes.' : 'Live events are OFF (unless vendors.json switches them on).';
    case 'event-add': {
      if (state.events.length >= MAX_EVENTS) return 'That\'s a lot of events - remove an old one first.';
      const id = String(form.get('id') || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(id)) return 'The id must be 2-30 letters, numbers or dashes (like moonrise-live).';
      if (pay().allEvents().some(e => cleanId(e.id) === id)) return 'There is already an event with that id.';
      const price = String(form.get('price') || '').trim();
      const dollars = price ? Number(price.replace(/[$,]/g, '')) : 0;
      if (price && !(dollars >= 2 && dollars <= 500)) return 'The ticket price must be between $2 and $500 (or leave it empty for a free event).';
      const ev = cleanEvent({ id, name: form.get('name'), artist: form.get('artist'), when: form.get('when'), ticketPrice: dollars, free: !price });
      if (!ev) return 'Give the event a name.';
      state.events.push(ev);
      if (!state.settings.liveEvents && !pay().vendorFeatures().liveEvents) state.settings.liveEvents = true;
      save();
      return `Made "${ev.name}". It shows in the game within about 10 minutes. On the night: open the game, Settings > Live events > "I'm the organiser", type the event password, press "Open this event". Then patch your DJs onto its stages here.`;
    }
    case 'event-remove': {
      const id = String(form.get('id') || '');
      const i = state.events.findIndex(e => e.id === id);
      if (i < 0) return '';
      const [gone] = state.events.splice(i, 1);
      save();
      return `Removed "${gone.name}".`;
    }
    case 'backup':
      flush();
      return { download: JSON.stringify(state, null, 1) };
    case 'restore': {
      let data;
      try { data = JSON.parse(String(form.get('data') || '')); } catch { return 'That isn\'t a backup file (paste the whole file).'; }
      if (!data || typeof data !== 'object' || !data.djs) return 'That isn\'t a patch bay backup.';
      const targets = new Set(state.slots.map(s => s.target));
      const openRooms = state.slots.filter(s => s.target.startsWith('room:'));   // Round 60: rooms open right now keep their patches
      state = cleanState(data);
      state.slots = state.slots.concat(openRooms).slice(-MAX_SLOTS);
      save();
      for (const s of state.slots) targets.add(s.target);
      for (const t of targets) pushAll(t);
      return `Restored: ${Object.keys(state.djs).length} DJs, ${state.slots.filter(s => s.state !== 'done').length} sets, ${state.events.length} events.`;
    }
    default:
      return '';
  }
}

const shownRooms = new Set();   // private rooms the admin asked to see (until they close)

/** A DJ's details changed: every stage they're live on (or next on) updates. */
function pushDj(djId) {
  const touched = new Set();
  for (const s of state.slots) if (s.djId === djId && s.state !== 'done') touched.add(s.target + '|' + s.stage);
  for (const k of touched) { const c = k.lastIndexOf('|'); pushStage(k.slice(0, c), k.slice(c + 1)); }
}

// ============================================================================ the DJ's own page
function findDjByKey(key) {
  key = String(key || '');
  if (!/^dj_[a-z0-9]{16,40}$/.test(key)) return null;
  for (const d of Object.values(state.djs)) if (same(d.key, key)) return d;
  return null;
}

/** Can this DJ press "I'm live" for this set right now? '' = yes, else why not. */
function whyNotLive(d, s, now) {
  if (d.locked) return 'The organiser starts and stops your sets.';
  if (s.state !== 'waiting') return 'This set isn\'t waiting.';
  if (runningOrder(s.target, s.stage)[0] !== s) return 'Another DJ is ahead of you on this stage.';
  if (s.at > 0 && now < s.at - EARLY_GO) return `Your set starts ${ago(s.at - now)} - you can go live from 10 minutes before.`;
  if (s.at > 0 && s.minutes > 0 && now >= s.at + s.minutes * 60000) return 'Your set time has passed.';
  const live = liveSlot(s.target, s.stage);
  if (live && live.djId !== d.id && !(s.at > 0 && now >= s.at)) return `${djOf(live).name} is still playing - wait for them to finish.`;
  if (!streamOf(s).url) return 'Add your stream link first (below).';
  return '';
}

function djHtml(d, note) {
  const now = Date.now();
  const rooms = hooks.rooms();
  const mine = state.slots.filter(s => s.djId === d.id && (s.state !== 'done' || now - s.endAt < 12 * 3600000))
    .sort((a, b) => (a.state === 'live' ? -1 : 0) - (b.state === 'live' ? -1 : 0) || ((a.at || Infinity) - (b.at || Infinity)));
  const k = `<input type="hidden" name="key" value="${h(d.key)}">`;
  const parts = [CSS, `<h1>Hi ${h(d.name)}</h1>`];
  if (note) parts.push(`<div class="code" style="font-size:15px;letter-spacing:0;text-align:left;white-space:pre-wrap">${h(note)}</div>`);
  parts.push('<p class="small">This is your private DJ page - don\'t share the link. Keep it open during your set.</p>');
  parts.push(`<form method="get" action="/dj"><input type="hidden" name="key" value="${h(d.key)}"><button type="submit" class="ghost">Refresh</button></form>`);
  parts.push('<h2>Your sets</h2>');
  if (!mine.length) parts.push('<p class="muted">No sets yet. The organiser puts you on a stage - check back here.</p>');
  for (const s of mine) {
    const title = targetTitle(s.target, rooms).replace(/ \(room [A-Z]+\)$/, '');
    const head = `<b>${h(stageName(s.stage))}</b> at ${h(title)}<br><span class="small">${s.state === 'live' ? '<span class="live">YOU\'RE LIVE</span>' : s.state === 'done' ? 'finished' : 'starts ' + when(s.at, now)}${s.minutes ? ' &middot; ' + s.minutes + ' min' : ''} &middot; ${targetStatus(s.target, rooms)}</span>`;
    let act = '';
    if (s.state === 'live') {
      act = d.locked ? '<p class="small">The organiser will end your set.</p>' : `<form method="post" action="/dj">${k}<input type="hidden" name="action" value="end"><input type="hidden" name="slot" value="${h(s.id)}"><button type="submit" class="stop">End set</button></form>`;
    } else if (s.state === 'waiting') {
      const why = whyNotLive(d, s, now);
      act = why ? `<p class="small">${h(why)}</p>` : `<form method="post" action="/dj">${k}<input type="hidden" name="action" value="live"><input type="hidden" name="slot" value="${h(s.id)}"><button type="submit" class="go">I'm live</button></form>`;
    }
    parts.push(`<div class="card">${head}${act}</div>`);
  }
  parts.push(`<h2>Your stream link</h2><form method="post" action="/dj">${k}<input type="hidden" name="action" value="streams">
<label>Main link (https:// - your Twitch channel link, an HLS .m3u8 or .mp4 video link, or an Icecast .mp3 / .aac / .ogg audio link - not .opus)</label><input name="stream0" value="${h(d.streams[0] ? d.streams[0].url : '')}" style="width:100%">
<label>Backup link (optional - if your main link is Twitch, an audio link here means Windows players hear you too)</label><input name="stream1" value="${h(d.streams[1] ? d.streams[1].url : '')}" style="width:100%">
<div class="row" style="margin-top:8px"><button type="submit">Save my links</button></div></form>
<form method="post" action="/dj">${k}<input type="hidden" name="action" value="test"><button type="submit" class="ghost">Test my main link</button></form>
${d.test ? `<p class="small ${d.test.ok ? 'ok' : 'bad'}">Last test (${h(ago(d.test.at - now))}): ${h(d.test.text)}</p>` : ''}
${HOW_TO_LINK}
<p class="small">Paste your link above, press "Test my main link" once you're streaming, then press "I'm live" when your set starts. Players hear you on your stage a few seconds later.</p>`);
  parts.push(TZ_SCRIPT);
  return parts.join('\n');
}

async function djAction(d, action, form) {
  const now = Date.now();
  switch (action) {
    case 'streams': {
      const streams = [];
      for (const k of ['stream0', 'stream1']) {
        const raw = String(form.get(k) || '').trim();
        if (!raw) continue;
        const url = cleanStreamUrl(raw);
        if (!url) return `That link can't be used: "${clip(raw, 80)}". It must start with https://, be a public web address and be under ${MAX_URL} characters.`;
        streams.push({ url, kind: kindOf(url) });
      }
      d.streams = streams;
      save();
      pushDj(d.id);
      return streams.length ? 'Saved. Press "Test my main link" while you\'re streaming to check it works.' : 'Your links were cleared.';
    }
    case 'test': {
      if (!d.streams[0]) return 'Add your main link first.';
      if (!limited('djtest|' + d.id, 6, 60000)) return 'Testing a lot - wait a minute.';
      const r = await testStream(d.streams[0].url);
      d.test = { ok: r.ok, text: r.text, at: Date.now(), kind: r.kind };
      if (r.ok && r.kind && d.streams[0].kind !== r.kind) { d.streams[0].kind = r.kind; pushDj(d.id); }
      save();
      return (r.ok ? 'WORKING - ' : 'NOT WORKING - ') + r.text;
    }
    case 'live': {
      const s = findSlot(form.get('slot'));
      if (!s || s.djId !== d.id) return 'That isn\'t one of your sets.';
      const why = whyNotLive(d, s, now);
      if (why) return why;
      goLive(s, now);
      s.by = s.by === 'host' ? 'host' : 'admin';
      save();
      pushStage(s.target, s.stage);
      return `You're LIVE on the ${stageName(s.stage)}. Enjoy your set!`;
    }
    case 'end': {
      const s = findSlot(form.get('slot'));
      if (!s || s.djId !== d.id || s.state !== 'live') return 'That set isn\'t live.';
      if (d.locked) return 'The organiser will end your set.';
      endSlot(s, now);
      save();
      pushStage(s.target, s.stage);
      return 'Set ended - thank you! The stage plays its own music again.';
    }
    default:
      return '';
  }
}

// ============================================================================ Round 67: artist applications
/** Round 67: a DJ's private page link (or '' if they're no longer on the roster). */
function djLinkFor(djId) {
  const d = state.djs[String(djId || '')];
  return d ? (pay().baseUrl() || 'https://YOUR-SERVER.onrender.com') + '/dj?key=' + d.key : '';
}

/**
 * Round 67: an approved application (applications.js) joins the DJ roster - through the same checks as "+ Add a DJ".
 * A stream link that can't be used is simply left out (they can add one on their DJ page). Resolves {ok, text, id, link}.
 */
function addDjFromApplication(app) {
  app = app || {};
  if (Object.keys(state.djs).length >= MAX_DJS) return { ok: false, text: `The DJ roster is full (${MAX_DJS} DJs). Remove one on the DJ Patch Bay page first, then press Approve again.` };
  const form = new URLSearchParams();
  form.set('name', String(app.name || ''));
  form.set('genre', String(app.genre || ''));
  form.set('contact', String(app.contact || ''));
  if (app.stream && cleanStreamUrl(app.stream)) form.set('stream0', String(app.stream));
  const r = djFields(form);
  if (!r.ok) return { ok: false, text: r.text };
  const id = newDjId(r.fields.name);
  // Round 75: what they told us in the application rides along (cleanDj keeps only what's sensible), shown on their card.
  const extra = cleanDj(Object.assign({ id, name: r.fields.name, key: 'x'.repeat(16), kind: app.kind, about: app.about, links: app.links, when: app.when, timezone: app.timezone }));
  const kept = {};
  for (const k of ['kind', 'about', 'links', 'when', 'timezone']) if (extra && extra[k] != null) kept[k] = extra[k];
  state.djs[id] = Object.assign({ id, key: newKey(), locked: false, createdAt: Date.now(), test: null }, r.fields, kept);
  save();
  return { ok: true, text: `${r.fields.name} is on the DJ roster.`, id, link: djLinkFor(id) };
}

// ============================================================================ requests
/** Handles /admin/patch and /dj. Returns true if it answered. */
function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://relay'); } catch { return false; }
  const route = url.pathname;
  if (route !== '/admin/patch' && route !== '/dj') return false;
  const ip = ipOf(req);
  const P = pay();

  if (route === '/admin/patch') {
    // Round 110: the admin session (adminauth.js) - sign-in, wrong-key limits, CSRF and the old key form all live there.
    require('./adminauth').guard(req, res, { path: '/admin/patch', limit: 600 * 1024 }).then(async g => {
      if (!g) return;
      const form = g.form, key = g.token;
      if (!limited('admin|' + ip, 120, 60000)) { P.page(res, 429, 'Wait', '<h1>Slow down</h1><p>Too many clicks - wait a moment.</p>'); return; }
      let note;
      try { note = await adminAction(form.get('action'), form); } catch (err) { console.error('patchbay admin', err && err.message); note = 'Something went wrong - try again.'; }
      if (note && typeof note === 'object' && note.download) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store',
          'content-disposition': `attachment; filename="patchbay-backup-${new Date().toISOString().slice(0, 10)}.json"` });
        res.end(note.download);
        return;
      }
      P.page(res, 200, 'DJ Patch Bay', adminHtml(key, note));
    }).catch(err => { console.error('patchbay', err && err.message); if (!res.headersSent) P.page(res, 500, 'Try again', '<h1>Something went wrong</h1>'); });
    return true;
  }

  // ---- /dj
  if (!limited('dj|' + ip, 60, 60000) || fails('djkey|' + ip, 600000) >= 12) {
    P.page(res, 429, 'Wait', '<h1>Too many tries</h1><p>Wait a few minutes and try again.</p>');
    return true;
  }
  const refuse = () => { addFail('djkey|' + ip); P.page(res, 403, 'DJ page', '<h1>This DJ link isn\'t valid</h1><p>Ask the organiser for your current link.</p>'); };
  if (req.method !== 'POST') {
    const d = findDjByKey(url.searchParams.get('key'));
    if (!d) { refuse(); return true; }
    P.page(res, 200, 'Your DJ page', djHtml(d, ''));
    return true;
  }
  P.readForm(req, 8 * 1024).then(async form => {
    const d = findDjByKey(form.get('key'));
    if (!d) { refuse(); return; }
    let note;
    try { note = await djAction(d, String(form.get('action') || ''), form); } catch (err) { console.error('patchbay dj', err && err.message); note = 'Something went wrong - try again.'; }
    P.page(res, 200, 'Your DJ page', djHtml(d, note));
  }).catch(err => { console.error('patchbay dj', err && err.message); if (!res.headersSent) P.page(res, 500, 'Try again', '<h1>Something went wrong</h1>'); });
  return true;
}

/** For the main admin page: a short summary and the button into the patch bay. */
function adminSection(hiddenKey) {
  let rooms = [];
  try { rooms = hooks.rooms(); } catch { rooms = []; }
  const now = Date.now();
  let live = 0;
  for (const t of targetsShown(rooms)) for (const st of STAGE_IDS) if (stageView(t, st, now).live) live++;
  return `<h2>DJ Patch Bay</h2><p class="small">Put real DJs' live streams on any stage of a live event or an open room - now or at set times.
${Object.keys(state.djs).length} DJs on the roster &middot; ${live} stage${live === 1 ? '' : 's'} live right now.</p>
<form method="post" action="/admin/patch">${hiddenKey}<button type="submit">Open the DJ Patch Bay</button></form>`;
}

module.exports = {
  STAGES, handle, attach, linesFor, pushAll, hostPatch, roomOpened, roomClosed, onStage, events, liveEventsSwitch,
  scheduleFor,   // Round 66: the public festival's schedule board
  addDjFromApplication, djLinkFor,   // Round 67: approved artist applications join the roster (applications.js)
  mergeIntoFeed, adminSection, flush, cleanStreamUrl, kindOf, testStream,
  isOpus, twitchChannel, resolveTwitch,   // Round 75
  shownRooms,
  _test: { isPrivateIp, sweep, tendTwitch, twitchCache, playlistProblem, state: () => state, setAllowLocal: v => { allowLocalForTests = !!v; }, parseLocalTime, stageView, adminAction, djAction, findDjByKey, reset: () => { state = blank(); lastSent.clear(); roomGoneAt.clear(); } }
};
