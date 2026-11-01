'use strict';
// Round 115 (launchC): THE SERVER'S WORD FILTER - one list for everything other players can read: open-mic lines and chat
// (masked or dropped by the relay), usernames (players.js sign-up), room titles and notes (the Festivals list), the print on a
// shirt (the Open Festival's steps), saved-world names and board names (leaderboards.js / worlds.js call isRude, which asks here too).
//
//   check(text)  -> { level: 0 | 1 | 2, masked, hits }
//                   0 clean; 1 MILD (swearing) - shown with the word masked ("f***"); 2 SEVERE (slurs, sexual terms, telling
//                   someone to hurt themselves) - never shown: the relay drops the line and flags the sender on /admin/moderation.
//   nameBad(text) -> true for any hit at all (names, titles and prints are never masked - they're refused or replaced).
//   mask(text)   -> the text with mild words masked and severe ones fully starred (for places that must show something).
//
// How it reads a line: Unicode look-alikes folded (NFKC, accents dropped, Cyrillic / Greek letters that look Latin), leetspeak
// read as letters (0 o, 1 i, 3 e, 4 a, 5 s, 7 t, 8 b, @ a, $ s, ! i, | i, + t), letters repeated ("fuuuuck") still match,
// and letters spaced or dotted out ("f u c k", "f.u.c.k") are read together. A few everyday words that contain a listed word
// (scrape, cocktail, therapist, Scunthorpe, shiitake...) are let through.
//
// MORE WORDS WITHOUT GITHUB: the repository is public, so a word you'd rather not publish can go in a Render Secret File named
// wordfilter.json (or the WORDFILTER_EXTRA setting) - {"severe": ["word", ...], "mild": ["word", ...], "allow": ["word", ...]}.
// Read at start-up and again every 5 minutes. The game itself carries no list (only this server decides).

const fs = require('fs');
const path = require('path');

// Stems match INSIDE a word ("fuckface", "shitty"); exact entries only as a whole word ("ass" but not "class").
const SEVERE_STEMS = ['nigg', 'nigga', 'faggot', 'fagot', 'kike', 'chink', 'wetback', 'tranny', 'retard', 'beaner', 'gook', 'raghead', 'towelhead',
  'coon', 'paki', 'dyke', 'rape', 'rapist', 'molest', 'pedo', 'paedo', 'pedophil', 'paedophil', 'porn', 'blowjob', 'handjob', 'rimjob', 'dildo',
  'pussy', 'penis', 'vagina', 'masturb', 'jizz', 'cunt', 'whore', 'slut', 'hentai', 'nazi', 'hitler', 'heilhitler', 'siegheil', 'whitepower',
  'killyourself', 'killurself', 'gokillyourself', 'hangyourself', 'cock', 'boner', 'horny', 'nudes', 'sendnude', 'sexting', 'orgasm',
  'clit', 'cumshot', 'creampie', 'gangbang', 'incest', 'bestiality', 'zoophil', 'nonce', 'kkk'];
const SEVERE_EXACT = ['fag', 'fags', 'spic', 'spics', 'cum', 'anal', 'sex', 'sexy', 'tits', 'titties', 'boobs', 'nude', 'kys', 'kikes', 'milf'];
// Whole phrases (read with any spacing or punctuation between the words).
const SEVERE_PHRASES = ['kill yourself', 'kill urself', 'kill your self', 'kill ya self', 'hang yourself', 'go die', 'neck yourself', 'end yourself',
  'heil hitler', 'sieg heil', 'white power', 'gas the', 'send nudes', 'send pics', 'show me your body', 'how old are you send', 'suck my'];
const SEVERE_NUMBERS = /(^|[^0-9])14\s*[\/.-]?\s*88([^0-9]|$)/;   // a hate code written as a number
const MILD_STEMS = ['fuck', 'fuk', 'fck', 'shit', 'bitch', 'bastard', 'asshole', 'arsehole', 'motherf', 'wank', 'twat', 'bollock', 'bullshit', 'dumbass', 'jackass', 'douche', 'prick'];
const MILD_EXACT = ['ass', 'arse', 'piss', 'pissed', 'damnit', 'wtf', 'stfu', 'gtfo', 'crap', 'dick', 'dicks'];
const ALLOW = ['scunthorpe', 'cocktail', 'peacock', 'hancock', 'woodcock', 'shuttlecock', 'cockatoo', 'cockpit', 'cockle', 'cockney', 'hitchcock',
  'grape', 'drape', 'scrape', 'trapeze', 'therapist', 'skyscraper', 'shiitake', 'snigger', 'niggle', 'raccoon', 'cocoon', 'tycoon', 'pakistan',
  'penistone', 'classic', 'class', 'bass', 'pass', 'grass', 'glass', 'mass', 'assassin', 'assist', 'asset', 'assume', 'assemble', 'cumin',
  'cumulative', 'cucumber', 'document', 'circumstance', 'analysis', 'analog', 'canal', 'banal', 'sussex', 'essex', 'sextet', 'pricking',
  'spice', 'spicy', 'kitchen', 'hitchhike', 'shitzu', 'dickens', 'dickinson', 'scrapes', 'drapes', 'grapes', 'monocle', 'buttress', 'pedometer',
  'pedal', 'pedestrian', 'torpedo', 'encyclopedia', 'expedite', 'speedo', 'clitheroe', 'japanese', 'mishit', 'cockroach', 'retardant', 'rapeseed',
  'thorny', 'scrapbook', 'grapefruit', 'parapet', 'whoreads'];

// Look-alike letters (Cyrillic and Greek that draw like Latin) and leetspeak.
const FOLD = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b',
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'κ': 'k', 'ν': 'v', 'ι': 'i', 'υ': 'u', 'χ': 'x',
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '£': 'l' };

let extra = { severe: [], mild: [], allow: [] };
let compiled = null;

/** A stem as a pattern that also matches its letters repeated ("fuck" -> f+u+c+k+; "nigg" -> n+i+g{2,}). */
function stemPattern(stem) {
  let out = '';
  for (let i = 0; i < stem.length;) {
    let j = i;
    while (j < stem.length && stem[j] === stem[i]) j++;
    const c = stem[i].replace(/[^a-z0-9]/g, '\\$&');
    out += j - i > 1 ? `${c}{${j - i},}` : `${c}+`;
    i = j;
  }
  return out;
}

function words(list) { return (Array.isArray(list) ? list : []).map(w => fold(String(w)).replace(/[^a-z0-9]/g, '')).filter(w => w.length >= 2).slice(0, 2000); }

function compile() {
  const sevStems = SEVERE_STEMS.concat(words(extra.severe).filter(w => w.length >= 4));
  const sevExact = SEVERE_EXACT.concat(words(extra.severe).filter(w => w.length < 4));
  const mildStems = MILD_STEMS.concat(words(extra.mild).filter(w => w.length >= 4));
  const mildExact = MILD_EXACT.concat(words(extra.mild).filter(w => w.length < 4));
  const re = list => list.length ? new RegExp(list.map(stemPattern).join('|')) : null;
  // Long stems may be read across words run together ("bit ches", "f u c k"); short ones only inside one word.
  compiled = {
    sev: re(sevStems), sevLong: re(sevStems.filter(s => s.length >= 5)), sevExact: new Set(sevExact),
    mild: re(mildStems), mildLong: re(mildStems.filter(s => s.length >= 5)), mildExact: new Set(mildExact),
    allow: ALLOW.concat(words(extra.allow)).sort((a, b) => b.length - a.length),
    phrases: new RegExp(SEVERE_PHRASES.map(ph => ' ' + ph.split(' ').map(stemPattern).join(' +') + ' ').join('|'))
  };
}

/** NFKC, lower case, accents off, look-alikes and leetspeak folded to plain letters. */
function fold(text, lettersOnly) {
  let s = String(text == null ? '' : text).normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  let out = '';
  for (const ch of s) out += FOLD[ch] !== undefined && !(lettersOnly && /[^\p{L}]/u.test(ch)) ? FOLD[ch] : ch;
  return out;
}

/** The allowed everyday words taken out (so "cocktail" never matches "cock"). */
function unallow(flat) {
  for (const ok of compiled.allow) if (flat.includes(ok)) flat = flat.split(ok).join(' ');
  return flat;
}

/** One word (or a run of words squashed together): 2 severe, 1 mild, 0 clean. */
function levelOfWord(w, squashed) {
  if (!w) return 0;
  const c = compiled;
  const plain = unallow(w);
  const dedup = plain.replace(/(.)\1+/g, '$1');
  if (!squashed && (c.sevExact.has(plain) || c.sevExact.has(dedup))) return 2;
  if ((squashed ? c.sevLong : c.sev) && (squashed ? c.sevLong : c.sev).test(plain)) return 2;
  if (!squashed && (c.mildExact.has(plain) || c.mildExact.has(dedup))) return 1;
  if ((squashed ? c.mildLong : c.mild) && (squashed ? c.mildLong : c.mild).test(plain)) return 1;
  return 0;
}

/** -> { level, masked, hits } (see the top of this file). */
function check(text) {
  if (!compiled) compile();
  const original = String(text == null ? '' : text);
  if (!original.trim()) return { level: 0, masked: original, hits: 0 };
  let level = 0, hits = 0;
  // Word by word, on the words as written (so a masked word keeps its place). Dots, dashes and leetspeak inside a word are
  // read through ("s.h.1.t" is one word).
  const tokens = original.split(/(\s+)/);
  const flat = tokens.map(tok => (/^\s*$/.test(tok) ? null : fold(tok).replace(/[^a-z]/g, '')));
  const lv = flat.map(w => (w ? levelOfWord(w, false) : 0));
  // Letters spaced out ("f u c k", "n i g g a"): every run of 3+ one-letter words is read as one word too.
  for (let i = 0; i < tokens.length;) {
    if (!flat[i] || flat[i].length !== 1) { i++; continue; }
    const run = [];
    let j = i;
    while (j < tokens.length && (flat[j] === null || flat[j].length === 1)) { if (flat[j]) run.push(j); j++; }
    if (run.length >= 3) {
      const joined = run.map(k => flat[k]).join('');
      const l = Math.max(levelOfWord(joined, false), levelOfWord(joined, true));
      if (l) for (const k of run) lv[k] = Math.max(lv[k], l);
    }
    i = j;
  }
  if (SEVERE_NUMBERS.test(original)) { level = 2; hits++; }
  const spaced = ' ' + fold(original).replace(/[^a-z]+/g, ' ').trim() + ' ';
  const spacedPlain = ' ' + fold(original, true).replace(/[^a-z]+/g, ' ').trim() + ' ';   // ("yourself!!" is not "yourselfii")
  if (compiled.phrases.test(spaced) || compiled.phrases.test(spacedPlain)) return { level: 2, masked: original.replace(/[\p{L}\p{N}]/gu, '*'), hits: hits + 1 };
  const out = tokens.map((tok, k) => {
    if (!lv[k]) return tok;
    hits++;
    level = Math.max(level, lv[k]);
    return maskWord(tok, flat[k] && flat[k].length === 1 ? 2 : lv[k]);
  });
  const masked = level === 2 && SEVERE_NUMBERS.test(original) ? original.replace(/[0-9]/g, '*') : out.join('');
  return { level, masked, hits };
}

function maskWord(tok, lv) {
  let seen = 0;
  return tok.replace(/[\p{L}\p{N}@$!|+]/gu, ch => (lv === 1 && seen++ === 0 ? ch : '*'));
}

/** Any listed word at all (names, titles, prints - refused or replaced, never masked). */
function nameBad(text) { return check(text).level > 0; }

/** The text as it may be shown: mild words masked, a severe line fully starred. */
function mask(text) {
  const r = check(text);
  return r.level === 2 ? String(text).replace(/[\p{L}\p{N}]/gu, '*') : r.masked;
}

// ------------------------------------------------------------------ the private extra list (never on GitHub)
const EXTRA_SOURCES = ['/etc/secrets/wordfilter.json', path.join(__dirname, 'wordfilter.json')];
function loadExtra() {
  let found = null;
  if (process.env.WORDFILTER_EXTRA) { try { found = JSON.parse(process.env.WORDFILTER_EXTRA); } catch { found = null; } }
  if (!found) for (const f of EXTRA_SOURCES) { try { found = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch { /* next */ } }
  extra = { severe: [], mild: [], allow: [] };
  if (found && typeof found === 'object') for (const k of ['severe', 'mild', 'allow']) if (Array.isArray(found[k])) extra[k] = found[k];
  compile();
}
loadExtra();
setInterval(loadExtra, 5 * 60000).unref();

module.exports = { check, nameBad, mask, fold, _test: { reload: loadExtra, stemPattern } };
