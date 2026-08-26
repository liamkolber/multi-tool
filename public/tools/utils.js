// Utilities — the small conversions you reach for constantly.
//
// Entirely client-side: this tool has no server half at all, so there is no
// lib/tools/utils.mjs. The regex logic lives in ../lib/regex.js because it is
// the part with real behaviour worth testing on its own.

import { $, esc, debounce } from '../lib/dom.js';
import { buildPattern, inferPattern, explainPattern } from '../lib/regex.js';

// A pathological pattern against a large input can hang the tab outright —
// JavaScript regexes cannot be interrupted once running. Capping the subject
// length keeps the worst case survivable; it is a mitigation, not a cure.
const MAX_TEST_LEN = 20_000;
const MAX_MATCHES = 500;

const TEMPLATE = `
  <div class="tool-head">
    <h1 class="tool-title"><span class="tool-title-icon">🧪</span> Utilities</h1>
    <p class="tool-sub">Regex, JSON, encoding, hashes, timestamps and text — all local, nothing leaves the machine.</p>
  </div>

  <!-- ---------------- Regex ---------------- -->
  <section class="ut-sec" data-sec="regex">
    <header class="ut-sec-head">
      <h2 class="ut-sec-title">Regex</h2>
      <p class="ut-sec-sub">Build a pattern, work one out from examples, understand one, or test it.</p>
    </header>
    <div class="ut-card">
      <div class="ut-row">
        <span class="ut-slash">/</span>
        <input id="rx-pattern" class="ut-mono" type="text" placeholder="\\d{3}-\\w+" autocomplete="off" spellcheck="false" />
        <span class="ut-slash">/</span>
        <label class="ut-flag"><input type="checkbox" id="rx-g" checked /> g</label>
        <label class="ut-flag"><input type="checkbox" id="rx-i" /> i</label>
        <label class="ut-flag"><input type="checkbox" id="rx-m" /> m</label>
        <label class="ut-flag"><input type="checkbox" id="rx-s" /> s</label>
        <button class="ut-btn" type="button" data-copy="rx-pattern">Copy</button>
      </div>
      <div id="rx-status" class="ut-status"></div>
    </div>

    <div class="rx-modes">
      <span class="rx-modes-q">I want to…</span>
      <div class="rx-modes-list" id="rx-modes">
        <button class="ut-chip active" type="button" data-mode="build">Build a pattern</button>
        <button class="ut-chip" type="button" data-mode="infer">Infer one from examples</button>
        <button class="ut-chip" type="button" data-mode="explain">Understand a pattern</button>
        <button class="ut-chip" type="button" data-mode="test">Test it on text</button>
      </div>
    </div>

    <div class="ut-card" data-mode="build">
      <p class="ut-hint">Stack the pieces you want; the pattern above is written for you.</p>
      <div id="rx-parts" class="rx-parts"></div>
      <div class="ut-row">
        <button class="ut-btn" type="button" id="rx-add">Add a piece</button>
        <button class="ut-btn" type="button" id="rx-clear">Clear</button>
      </div>
    </div>

    <div class="ut-card" data-mode="infer" hidden>
      <p class="ut-hint">Paste a few strings you want matched, one per line. More examples of the same shape give a better pattern.</p>
      <textarea id="rx-samples" class="ut-mono" rows="4" spellcheck="false" placeholder="AB-1234&#10;XY-5678&#10;QQ-0001"></textarea>
      <div class="ut-row ut-wrap">
        <button class="ut-btn primary" type="button" id="rx-infer">Infer pattern</button>
        <label class="ut-flag"><input type="checkbox" id="rx-anchor" checked /> anchor to whole line</label>
        <button class="ut-btn" type="button" id="rx-to-test" hidden>See it match →</button>
      </div>
      <div id="rx-infer-note" class="ut-status"></div>
    </div>

    <div class="ut-card" data-mode="explain" hidden>
      <p class="ut-hint">Every token in the pattern above, in the order it applies.</p>
      <ol id="rx-explain" class="rx-explain"></ol>
    </div>

    <div class="ut-card" data-mode="test" hidden>
      <p class="ut-hint">Matches are highlighted; capture groups are listed underneath.</p>
      <textarea id="rx-subject" class="ut-mono" rows="6" spellcheck="false" placeholder="Paste text to match against…"></textarea>
      <div id="rx-result" class="rx-result"></div>
    </div>
  </section>

  <!-- ---------------- JSON ---------------- -->
  <section class="ut-sec" data-sec="json">
    <header class="ut-sec-head">
      <h2 class="ut-sec-title">JSON</h2>
      <p class="ut-sec-sub">Format or minify, with parse errors pointed at a line and column.</p>
    </header>
    <div class="ut-card">
      <div class="ut-row">
        <button class="ut-btn primary" type="button" id="js-format">Format</button>
        <button class="ut-btn" type="button" id="js-min">Minify</button>
        <button class="ut-btn" type="button" data-copy="js-text">Copy</button>
        <select id="js-indent"><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="\t">Tabs</option></select>
      </div>
      <div id="js-status" class="ut-status"></div>
      <textarea id="js-text" class="ut-mono" rows="16" spellcheck="false" placeholder='{"paste":"json here"}'></textarea>
    </div>
  </section>

  <!-- ---------------- Encode ---------------- -->
  <section class="ut-sec" data-sec="encode">
    <header class="ut-sec-head">
      <h2 class="ut-sec-title">Encode</h2>
      <p class="ut-sec-sub">Base64, URL components and HTML entities, in both directions.</p>
    </header>
    <div class="ut-card">
      <div class="ut-row">
        <select id="en-mode">
          <option value="base64">Base64</option>
          <option value="base64url">Base64 (URL-safe)</option>
          <option value="url">URL component</option>
          <option value="html">HTML entities</option>
        </select>
        <button class="ut-btn primary" type="button" id="en-encode">Encode ↓</button>
        <button class="ut-btn" type="button" id="en-decode">Decode ↑</button>
        <button class="ut-btn" type="button" data-copy="en-out">Copy result</button>
      </div>
      <div id="en-status" class="ut-status"></div>
      <textarea id="en-in" class="ut-mono" rows="6" spellcheck="false" placeholder="Plain text"></textarea>
      <textarea id="en-out" class="ut-mono" rows="6" spellcheck="false" placeholder="Encoded"></textarea>
    </div>
  </section>

  <!-- ---------------- Hash ---------------- -->
  <section class="ut-sec" data-sec="hash">
    <header class="ut-sec-head">
      <h2 class="ut-sec-title">Hash</h2>
      <p class="ut-sec-sub">SHA-1, SHA-256, SHA-384 and SHA-512 of whatever you type.</p>
    </header>
    <div class="ut-card">
      <textarea id="hs-in" class="ut-mono" rows="6" spellcheck="false" placeholder="Text to hash"></textarea>
      <div id="hs-out" class="hs-out"></div>
    </div>
  </section>

  <!-- ---------------- Time ---------------- -->
  <section class="ut-sec" data-sec="time">
    <header class="ut-sec-head">
      <h2 class="ut-sec-title">Time</h2>
      <p class="ut-sec-sub">Unix seconds or milliseconds, ISO 8601, UTC and local — converted every way at once.</p>
    </header>
    <div class="ut-card">
      <div class="ut-row">
        <input id="tm-in" class="ut-mono" type="text" placeholder="1735689600, 1735689600000, or 2025-01-01T00:00:00Z" autocomplete="off" />
        <button class="ut-btn" type="button" id="tm-now">Now</button>
      </div>
      <div id="tm-out" class="hs-out"></div>
    </div>
  </section>

  <!-- ---------------- Text ---------------- -->
  <section class="ut-sec" data-sec="text">
    <header class="ut-sec-head">
      <h2 class="ut-sec-title">Text</h2>
      <p class="ut-sec-sub">Case, slugs, trimming, deduping, sorting and reversing lines.</p>
    </header>
    <div class="ut-card">
      <div class="ut-row ut-wrap">
        <button class="ut-btn" type="button" data-tx="upper">UPPER</button>
        <button class="ut-btn" type="button" data-tx="lower">lower</button>
        <button class="ut-btn" type="button" data-tx="title">Title Case</button>
        <button class="ut-btn" type="button" data-tx="slug">slug-case</button>
        <button class="ut-btn" type="button" data-tx="trim">Trim lines</button>
        <button class="ut-btn" type="button" data-tx="squeeze">Drop blank lines</button>
        <button class="ut-btn" type="button" data-tx="dedupe">Unique lines</button>
        <button class="ut-btn" type="button" data-tx="sort">Sort</button>
        <button class="ut-btn" type="button" data-tx="rsort">Sort ↓</button>
        <button class="ut-btn" type="button" data-tx="reverse">Reverse lines</button>
        <button class="ut-btn" type="button" data-copy="tx-text">Copy</button>
      </div>
      <div id="tx-status" class="ut-status"></div>
      <textarea id="tx-text" class="ut-mono" rows="16" spellcheck="false" placeholder="Paste text…"></textarea>
    </div>
  </section>`;

// --- Regex builder parts ----------------------------------------------------
const PART_KINDS = [
  ['digit', 'a digit'], ['letter', 'a letter'], ['word', 'a word character'],
  ['space', 'whitespace'], ['any', 'any character'],
  ['literal', 'this exact text'], ['set', 'any of these characters'],
  ['notset', 'anything except these'], ['oneof', 'one of these words'],
  ['notdigit', 'not a digit'], ['notspace', 'not whitespace'],
  ['start', 'start of line'], ['end', 'end of line'], ['boundary', 'a word boundary'],
];

const QUANTS = [
  ['one', 'once'], ['optional', 'optional'], ['many', 'one or more'], ['any', 'zero or more'],
  ['exactly', 'exactly…'], ['atleast', 'at least…'], ['between', 'between…'],
];

const NEEDS_VALUE = new Set(['literal', 'set', 'notset', 'oneof']);
const IS_ANCHOR = new Set(['start', 'end', 'boundary']);

let rxParts = [];
let rxMode = 'build';

// Coming back should leave the regex where you left it rather than resetting.
const UT_PREFS_KEY = 'multitool:utils';
const RX_MODES = ['build', 'infer', 'explain', 'test'];

function utSavePrefs() {
  try {
    localStorage.setItem(UT_PREFS_KEY, JSON.stringify({ rxMode }));
  } catch { /* ignore quota */ }
}

function utLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(UT_PREFS_KEY));
    if (saved && RX_MODES.includes(saved.rxMode)) rxMode = saved.rxMode;
  } catch { /* keep the default */ }
}

// --- Helpers ---
const el = (id) => $(id);

function status(id, msg, kind) {
  const node = el(id);
  if (!node) return;
  node.textContent = msg || '';
  node.className = `ut-status${kind ? ` ${kind}` : ''}`;
}

async function copyFrom(id) {
  const node = el(id);
  if (!node) return;
  try {
    await navigator.clipboard.writeText(node.value != null ? node.value : node.textContent);
  } catch { /* clipboard blocked — the text is on screen anyway */ }
}

// --- Regex section ----------------------------------------------------------
function rxFlags() {
  return ['g', 'i', 'm', 's'].filter((f) => el(`rx-${f}`).checked).join('');
}

function rxRenderParts() {
  el('rx-parts').innerHTML = rxParts.map((p, i) => {
    const anchor = IS_ANCHOR.has(p.kind);
    const needsValue = NEEDS_VALUE.has(p.kind);
    const showCount = !anchor && ['exactly', 'atleast', 'between'].includes(p.quant);
    return `<div class="rx-part" data-i="${i}">
      <select data-f="kind">${PART_KINDS.map(([v, l]) =>
        `<option value="${v}"${v === p.kind ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input data-f="value" class="ut-mono" type="text" value="${esc(p.value || '')}"
        placeholder="${p.kind === 'oneof' ? 'cat|dog|bird' : 'text'}"${needsValue ? '' : ' hidden'} />
      <select data-f="quant"${anchor ? ' hidden' : ''}>${QUANTS.map(([v, l]) =>
        `<option value="${v}"${v === p.quant ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input data-f="min" type="number" min="0" value="${esc(p.min ?? 1)}"${showCount ? '' : ' hidden'} />
      <input data-f="max" type="number" min="0" value="${esc(p.max ?? 3)}"${showCount && p.quant === 'between' ? '' : ' hidden'} />
      <select data-f="group"${anchor ? ' hidden' : ''}>
        <option value=""${!p.group ? ' selected' : ''}>no group</option>
        <option value="capture"${p.group === 'capture' ? ' selected' : ''}>capture</option>
        <option value="named"${p.group === 'named' ? ' selected' : ''}>name it…</option>
      </select>
      <input data-f="name" type="text" value="${esc(p.name || '')}" placeholder="name"${p.group === 'named' ? '' : ' hidden'} />
      <button class="ut-x" type="button" data-remove="${i}" title="Remove">✕</button>
    </div>`;
  }).join('');
}

function rxSyncFromParts() {
  el('rx-pattern').value = buildPattern(rxParts);
  rxRun();
}

function rxRun() {
  const src = el('rx-pattern').value;

  // Only the visible mode is worth rendering — explaining a pattern nobody is
  // looking at, or matching against a subject on a hidden card, is wasted work.
  if (rxMode === 'explain') {
    el('rx-explain').innerHTML = explainPattern(src).map((l) => `<li>${esc(l)}</li>`).join('');
  }

  if (!src) { status('rx-status', ''); el('rx-result').innerHTML = ''; return; }

  let re;
  try {
    re = new RegExp(src, rxFlags());
  } catch (err) {
    status('rx-status', err.message, 'error');
    el('rx-result').innerHTML = '';
    return;
  }
  status('rx-status', 'Valid pattern.', 'ok');

  if (rxMode !== 'test') return;

  const subject = el('rx-subject').value;
  if (!subject) { el('rx-result').innerHTML = ''; return; }
  if (subject.length > MAX_TEST_LEN) {
    el('rx-result').innerHTML = `<div class="ut-status error">Test text is capped at ${MAX_TEST_LEN.toLocaleString()} characters.</div>`;
    return;
  }

  const matches = [];
  if (re.global) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(subject)) !== null) {
      matches.push(m);
      if (m[0] === '') re.lastIndex++;          // a zero-width match would loop forever
      if (matches.length >= MAX_MATCHES) break;
    }
  } else {
    const m = re.exec(subject);
    if (m) matches.push(m);
  }

  if (!matches.length) {
    el('rx-result').innerHTML = '<div class="ut-status">No matches.</div>';
    return;
  }

  // Highlight by walking the matches in order and escaping everything between.
  let html = '';
  let at = 0;
  for (const m of matches) {
    html += esc(subject.slice(at, m.index));
    html += `<mark>${esc(m[0])}</mark>`;
    at = m.index + m[0].length;
  }
  html += esc(subject.slice(at));

  const withGroups = matches.filter((m) => m.length > 1 || m.groups);
  const groupTable = withGroups.length ? `
    <table class="rx-groups">
      <thead><tr><th>#</th><th>Match</th>${
        matches[0].groups
          ? Object.keys(matches[0].groups).map((g) => `<th>${esc(g)}</th>`).join('')
          : matches[0].slice(1).map((_, i) => `<th>$${i + 1}</th>`).join('')
      }</tr></thead>
      <tbody>${matches.slice(0, 50).map((m, i) => `<tr>
        <td>${i + 1}</td><td>${esc(m[0])}</td>${
          m.groups
            ? Object.values(m.groups).map((v) => `<td>${esc(v ?? '')}</td>`).join('')
            : m.slice(1).map((v) => `<td>${esc(v ?? '')}</td>`).join('')
        }</tr>`).join('')}</tbody>
    </table>` : '';

  el('rx-result').innerHTML = `
    <div class="ut-status ok">${matches.length}${matches.length >= MAX_MATCHES ? '+' : ''} match${matches.length === 1 ? '' : 'es'}.</div>
    <pre class="rx-preview">${html}</pre>
    ${groupTable}`;
}

// --- JSON ---
function jsFormat(minify) {
  const node = el('js-text');
  try {
    const parsed = JSON.parse(node.value);
    const indent = el('js-indent').value === '\t' ? '\t' : Number(el('js-indent').value);
    node.value = minify ? JSON.stringify(parsed) : JSON.stringify(parsed, null, indent);
    status('js-status', minify ? 'Minified.' : 'Formatted.', 'ok');
  } catch (err) {
    // "position 42" on its own is useless in a long document; turn it into a
    // line and column you can actually navigate to.
    const pos = err.message.match(/position (\d+)/);
    let where = '';
    if (pos) {
      const upto = node.value.slice(0, Number(pos[1]));
      const line = upto.split('\n').length;
      const col = upto.length - upto.lastIndexOf('\n');
      where = ` (line ${line}, column ${col})`;
    }
    status('js-status', err.message + where, 'error');
  }
}

// --- Encode ---
const enc = new TextEncoder();
const dec = new TextDecoder();

// btoa only handles Latin-1, so anything non-ASCII has to go through bytes.
function toBase64(text, urlSafe) {
  const bytes = enc.encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return urlSafe ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
}

function fromBase64(text, urlSafe) {
  let s = text.trim();
  if (urlSafe) s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return dec.decode(bytes);
}

const HTML_ENTS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function enRun(decode) {
  const mode = el('en-mode').value;
  const from = decode ? el('en-out') : el('en-in');
  const to = decode ? el('en-in') : el('en-out');
  try {
    let out;
    if (mode === 'base64' || mode === 'base64url') {
      const urlSafe = mode === 'base64url';
      out = decode ? fromBase64(from.value, urlSafe) : toBase64(from.value, urlSafe);
    } else if (mode === 'url') {
      out = decode ? decodeURIComponent(from.value) : encodeURIComponent(from.value);
    } else {
      out = decode
        ? from.value.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m]))
        : from.value.replace(/[&<>"']/g, (c) => HTML_ENTS[c]);
    }
    to.value = out;
    status('en-status', decode ? 'Decoded.' : 'Encoded.', 'ok');
  } catch (err) {
    status('en-status', `Could not ${decode ? 'decode' : 'encode'}: ${err.message}`, 'error');
  }
}

// --- Hash ---
const HASHES = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];

async function hsRun() {
  const text = el('hs-in').value;
  if (!text) { el('hs-out').innerHTML = ''; return; }
  const bytes = enc.encode(text);
  const rows = [];
  for (const algo of HASHES) {
    try {
      const buf = await crypto.subtle.digest(algo, bytes);
      const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      rows.push([algo, hex]);
    } catch { rows.push([algo, 'unavailable']); }
  }
  el('hs-out').innerHTML = rows.map(([k, v]) =>
    `<div class="hs-row"><span class="hs-k">${esc(k)}</span><code class="hs-v">${esc(v)}</code></div>`).join('');
}

// --- Time ---
function tmRun() {
  const raw = el('tm-in').value.trim();
  if (!raw) { el('tm-out').innerHTML = ''; return; }

  let date = null;
  if (/^\d+$/.test(raw)) {
    // Ten digits is seconds, thirteen is milliseconds — the usual convention.
    const n = Number(raw);
    date = new Date(raw.length <= 10 ? n * 1000 : n);
  } else {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) date = new Date(parsed);
  }

  if (!date || Number.isNaN(date.getTime())) {
    el('tm-out').innerHTML = '<div class="ut-status error">Not a timestamp or a date this can read.</div>';
    return;
  }

  const rows = [
    ['Unix seconds', String(Math.floor(date.getTime() / 1000))],
    ['Unix millis', String(date.getTime())],
    ['ISO 8601 (UTC)', date.toISOString()],
    ['Local', date.toLocaleString()],
    ['UTC', date.toUTCString()],
  ];
  el('tm-out').innerHTML = rows.map(([k, v]) =>
    `<div class="hs-row"><span class="hs-k">${esc(k)}</span><code class="hs-v">${esc(v)}</code></div>`).join('');
}

// --- Text ---
const TX = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  title: (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  slug: (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  trim: (s) => s.split('\n').map((l) => l.trim()).join('\n'),
  squeeze: (s) => s.split('\n').filter((l) => l.trim()).join('\n'),
  dedupe: (s) => [...new Set(s.split('\n'))].join('\n'),
  sort: (s) => s.split('\n').sort((a, b) => a.localeCompare(b)).join('\n'),
  rsort: (s) => s.split('\n').sort((a, b) => b.localeCompare(a)).join('\n'),
  reverse: (s) => s.split('\n').reverse().join('\n'),
};

function txCount() {
  const s = el('tx-text').value;
  const words = s.trim() ? s.trim().split(/\s+/).length : 0;
  status('tx-status', `${s.length.toLocaleString()} characters · ${words.toLocaleString()} words · ${s.split('\n').length.toLocaleString()} lines`);
}

// --- Wiring ---
function showRxMode(mode) {
  rxMode = mode;
  document.querySelectorAll('.ut-sec[data-sec="regex"] .ut-card[data-mode]')
    .forEach((c) => { c.hidden = c.dataset.mode !== mode; });
  document.querySelectorAll('#rx-modes .ut-chip')
    .forEach((c) => c.classList.toggle('active', c.dataset.mode === mode));
  utSavePrefs();
  rxRun();
}

function bindUtils(panel) {
  panel.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) copyFrom(copy.dataset.copy);
  });

  panel.querySelector('#rx-modes').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-mode]');
    if (chip) showRxMode(chip.dataset.mode);
  });

  // Regex
  const rerun = debounce(rxRun, 150);
  el('rx-pattern').addEventListener('input', rerun);
  el('rx-subject').addEventListener('input', rerun);
  ['g', 'i', 'm', 's'].forEach((f) => el(`rx-${f}`).addEventListener('change', rxRun));

  el('rx-add').addEventListener('click', () => {
    rxParts.push({ kind: 'digit', quant: 'one', min: 1, max: 3, group: '' });
    rxRenderParts();
    rxSyncFromParts();
  });
  el('rx-clear').addEventListener('click', () => {
    rxParts = [];
    rxRenderParts();
    rxSyncFromParts();
  });

  const parts = el('rx-parts');
  parts.addEventListener('change', (e) => {
    const row = e.target.closest('.rx-part');
    if (!row) return;
    rxParts[Number(row.dataset.i)][e.target.dataset.f] = e.target.value;
    rxRenderParts();
    rxSyncFromParts();
  });
  parts.addEventListener('input', (e) => {
    const row = e.target.closest('.rx-part');
    if (!row || e.target.tagName !== 'INPUT') return;
    rxParts[Number(row.dataset.i)][e.target.dataset.f] = e.target.value;
    el('rx-pattern').value = buildPattern(rxParts);
    rerun();
  });
  parts.addEventListener('click', (e) => {
    const x = e.target.closest('[data-remove]');
    if (!x) return;
    rxParts.splice(Number(x.dataset.remove), 1);
    rxRenderParts();
    rxSyncFromParts();
  });

  el('rx-infer').addEventListener('click', () => {
    const { pattern, note } = inferPattern(el('rx-samples').value.split('\n'), { anchor: el('rx-anchor').checked });
    el('rx-pattern').value = pattern;
    status('rx-infer-note', note || '');
    // Whatever was assembled by hand no longer describes what is in the box.
    rxParts = [];
    rxRenderParts();
    // Offering the examples as the subject saves pasting them twice.
    if (!el('rx-subject').value.trim()) el('rx-subject').value = el('rx-samples').value;
    // Don't yank the view away mid-thought — offer the jump instead.
    el('rx-to-test').hidden = !pattern;
    rxRun();
  });

  el('rx-to-test').addEventListener('click', () => showRxMode('test'));

  // JSON
  el('js-format').addEventListener('click', () => jsFormat(false));
  el('js-min').addEventListener('click', () => jsFormat(true));

  // Encode
  el('en-encode').addEventListener('click', () => enRun(false));
  el('en-decode').addEventListener('click', () => enRun(true));

  // Hash
  el('hs-in').addEventListener('input', debounce(hsRun, 200));

  // Time
  el('tm-in').addEventListener('input', debounce(tmRun, 150));
  el('tm-now').addEventListener('click', () => {
    el('tm-in').value = String(Math.floor(Date.now() / 1000));
    tmRun();
  });

  // Text
  panel.querySelector('[data-tx]').parentElement.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tx]');
    if (!btn) return;
    const node = el('tx-text');
    node.value = TX[btn.dataset.tx](node.value);
    txCount();
  });
  el('tx-text').addEventListener('input', debounce(txCount, 150));
}

export const tool = {
  id: 'utils',
  name: 'Utilities',
  icon: '🧪',
  blurb: 'Regex, JSON, encoding, hashes, timestamps and text.',
  mount(panel) {
    panel.innerHTML = TEMPLATE;
    utLoadPrefs();
    bindUtils(panel);
    showRxMode(rxMode);
  },
  show() {
    el('rx-pattern')?.focus();
  },
};
