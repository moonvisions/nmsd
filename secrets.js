'use strict';
// Round 110 (sec110 H1): SERVER SECRETS THAT ARE NEVER WORKED OUT FROM ADMIN_KEY.
//
// Anything a player can see (a connection ticket, a cookie) used to be signed with a key made from ADMIN_KEY when
// BOARD_SECRET wasn't set - so one ticket let anyone test ADMIN_KEY guesses offline, as fast as their computer goes.
// Now each use has its own key, from (first that exists):
//   1. its own environment variable (e.g. TICKET_HMAC_SECRET), 16+ characters;
//   2. BOARD_SECRET (16+ characters - already set on Render for the leaderboards), mixed with the use's name;
//   3. a random 32-byte key made once and kept in server-secrets.json in STORE_DATA_DIR (the permanent disk) - never in
//      git (.gitignore). Without a disk that file goes with each redeploy: tickets from the old copy are then refused once
//      and the game simply fetches a new one - set BOARD_SECRET to avoid even that.
// ADMIN_KEY is never read here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.STORE_DATA_DIR || __dirname;
const FILE = path.join(DIR, 'server-secrets.json');
let saved = null;

function readFile() {
  if (saved) return saved;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    saved = data && typeof data === 'object' ? data : {};
  } catch { saved = {}; }
  return saved;
}

/** The random key for <name> from server-secrets.json, made (and saved) the first time. */
function stored(name) {
  const all = readFile();
  if (typeof all[name] === 'string' && /^[a-f0-9]{64}$/.test(all[name])) return Buffer.from(all[name], 'hex');
  all[name] = crypto.randomBytes(32).toString('hex');
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('secrets: could not save ' + path.basename(FILE) + ' (' + (err && err.message) + ') - the ' + name + ' key lasts until a restart');
  }
  return Buffer.from(all[name], 'hex');
}

function strong(v) { return typeof v === 'string' && v.length >= 16; }

/**
 * A 32-byte key for one use. envName: that use's own variable (optional). Returns { key, from } where from is 'env',
 * 'board' or 'file' (for the admin page's warnings).
 */
function secretFor(name, envName) {
  const own = envName ? process.env[envName] : '';
  if (strong(own)) return { key: crypto.createHmac('sha256', 'nmsd|' + name).update(own).digest(), from: 'env' };
  if (strong(process.env.BOARD_SECRET)) return { key: crypto.createHmac('sha256', 'nmsd-board|' + name).update(process.env.BOARD_SECRET).digest(), from: 'board' };
  return { key: stored(name), from: 'file' };
}

/** Is BOARD_SECRET set well (16+ characters)? */
function boardSecretOk() { return strong(process.env.BOARD_SECRET); }

module.exports = { secretFor, boardSecretOk, FILE };
