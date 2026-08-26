// Library Scanner — what is actually in that folder.
//
// The server hands over one flat index; everything here works against it in
// memory, so search, sort and every filter are instant and cost no disk work.
// Same idea as the Reddit tool: fetch once, then never wait again.

import { $, esc, fmtNumber, debounce } from '../lib/dom.js';

const TEMPLATE = `
  <div class="tool-head">
    <h1 class="tool-title"><span class="tool-title-icon">📚</span> Library</h1>
    <p class="tool-sub">Scan a folder and see what is really in it — sizes, quality, subtitles, duplicates.</p>
  </div>

  <div class="lb-bar">
    <button id="lb-pick" class="btn btn-primary" type="button">Choose a folder…</button>
    <input id="lb-root" type="text" placeholder="E:\\Movies" autocomplete="off" spellcheck="false" />
    <button id="lb-scan" class="btn-ghost" type="button">Scan</button>
    <button id="lb-cancel" class="btn-ghost" type="button" hidden>Cancel</button>
  </div>

  <div id="lb-error" class="lb-notice error" hidden></div>
  <div id="lb-progress" class="lb-progress" hidden></div>

  <div id="lb-stats" class="lb-stats" hidden></div>

  <div id="lb-controls" class="lb-controls" hidden>
    <input id="lb-search" type="search" placeholder="Search name, folder, codec…" autocomplete="off" />
    <select id="lb-sort">
      <option value="name">Name</option>
      <option value="size">Largest first</option>
      <option value="duration">Longest first</option>
      <option value="height">Highest resolution</option>
      <option value="mtime">Newest first</option>
    </select>
    <div id="lb-filters" class="lb-filters"></div>
  </div>

  <div id="lb-list" class="lb-list"></div>`;

const lb = {};
function cacheEls() {
  Object.assign(lb, {
    pick: $('lb-pick'),
    root: $('lb-root'),
    scan: $('lb-scan'),
    cancel: $('lb-cancel'),
    error: $('lb-error'),
    progress: $('lb-progress'),
    stats: $('lb-stats'),
    controls: $('lb-controls'),
    search: $('lb-search'),
    sort: $('lb-sort'),
    filters: $('lb-filters'),
    list: $('lb-list'),
  });
}

let lbFiles = [];
let lbRoot = null;
let lbStream = null;
let lbFilter = 'all';
let lbQuery = '';
let lbSort = 'name';

const RENDER_CAP = 400; // the DOM, not the data — filters still see everything

// --- Formatting ---
function lbBytes(n) {
  if (!n || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function lbClock(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// 1080p rather than 1920x1080, because anamorphic and cropped widescreen files
// are not 1920 wide and would otherwise all read as "other".
function lbResLabel(f) {
  if (!f.height) return '';
  const h = f.height;
  if (h >= 2000) return '4K';
  if (h >= 1400) return '1440p';
  if (h >= 1000) return '1080p';
  if (h >= 700) return '720p';
  if (h >= 500) return '576p';
  return `${h}p`;
}

function lbShowError(msg) {
  lb.error.hidden = false;
  lb.error.textContent = msg;
}

function lbClearError() {
  lb.error.hidden = true;
  lb.error.textContent = '';
}

// --- Duplicate detection ----------------------------------------------------
// Release names are noisy — "Movie.2019.1080p.BluRay.x264-GROUP.mkv" and
// "Movie (2019) [720p].mp4" are the same film. Strip everything that is
// metadata rather than title and compare what is left, keeping the year since
// remakes are genuinely different films.
const NOISE = /\b(2160p|1440p|1080p|720p|576p|480p|360p|4k|uhd|hdr10?|sdr|bluray|blu-ray|brrip|bdrip|bdremux|webrip|web-dl|webdl|hdtv|hdrip|dvdrip|dvd|remux|x\s?26[45]|h\s?26[45]|hevc|avc|xvid|divx|aac|ac3|eac3|dts(-hd)?|ddp?\s?5[. ]?1|atmos|truehd|10bit|8bit|proper|repack|extended|unrated|uncut|remastered|directors?\s?cut|imax|multi|dual|subbed|dubbed|complete)\b/gi;

function lbTitleKey(name) {
  let s = name.replace(/\.[^.]+$/, '');           // extension
  s = s.replace(/[._]+/g, ' ');                   // dots and underscores are separators

  // The year is read BEFORE bracketed tags are stripped, because "(2019)" is
  // both a bracketed tag and the year — stripping first loses it, and then
  // "Movie (2019) [720p]" and "Movie.2019.720p" no longer match.
  //
  // Where several years appear the last one wins: a title carrying a year of
  // its own reads as "Blade Runner 2049 2017", release year last. It is not
  // always the right year, but it is consistently the same year for every
  // naming style of the same film, which is what matching needs.
  const years = s.match(/\b(19\d\d|20\d\d)\b/g);
  const year = years ? years[years.length - 1] : null;

  s = s.replace(/[[({].*?[\])}]/g, ' ');          // bracketed tags
  s = s.replace(NOISE, ' ');
  s = s.replace(/\b(19\d\d|20\d\d)\b/g, ' '); // every year, wherever it sat
  s = s.replace(/-\s*[a-z0-9]+\s*$/i, ' ');      // trailing release group
  s = s.replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return year ? `${s} ${year}` : s;
}

function lbDuplicateKeys(files) {
  const byKey = new Map();
  for (const f of files) {
    if (f.kind !== 'video') continue;
    const key = lbTitleKey(f.name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  const dupes = new Set();
  for (const [, group] of byKey) {
    if (group.length > 1) group.forEach((f) => dupes.add(f.path));
  }
  return dupes;
}

// --- Filters ---
let lbDupes = new Set();

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'video', label: 'Video', test: (f) => f.kind === 'video' },
  { id: 'audio', label: 'Audio', test: (f) => f.kind === 'audio' },
  { id: 'sd', label: 'Below 1080p', test: (f) => f.kind === 'video' && f.height && f.height < 1000 },
  { id: 'nosubs', label: 'No subtitles', test: (f) => f.kind === 'video' && !f.subTracks && !(f.sidecars || []).length },
  { id: 'dupes', label: 'Possible duplicates', test: (f) => lbDupes.has(f.path) },
  { id: 'big', label: 'Over 4 GB', test: (f) => f.size > 4 * 1024 ** 3 },
  { id: 'bad', label: 'Unreadable', test: (f) => f.unreadable },
];

function lbVisible() {
  const filter = FILTERS.find((x) => x.id === lbFilter) || FILTERS[0];
  const q = lbQuery.toLowerCase();
  let out = lbFiles.filter((f) => filter.test(f));
  if (q) {
    out = out.filter((f) =>
      f.name.toLowerCase().includes(q)
      || f.dir.toLowerCase().includes(q)
      || (f.vcodec || '').toLowerCase().includes(q)
      || (f.acodec || '').toLowerCase().includes(q));
  }
  const dir = lbSort === 'name' ? 1 : -1;
  return out.sort((a, b) => {
    if (lbSort === 'name') return a.name.localeCompare(b.name);
    return ((a[lbSort] || 0) - (b[lbSort] || 0)) * dir;
  });
}

// --- Rendering ---
function lbRenderStats() {
  if (!lbFiles.length) { lb.stats.hidden = true; return; }
  const totalSize = lbFiles.reduce((n, f) => n + (f.size || 0), 0);
  const totalTime = lbFiles.reduce((n, f) => n + (f.duration || 0), 0);
  const cells = [
    ['Files', fmtNumber(lbFiles.length)],
    ['Total size', lbBytes(totalSize)],
    ['Runtime', `${Math.round(totalTime / 3600)} h`],
    ['Below 1080p', fmtNumber(lbFiles.filter(FILTERS.find((x) => x.id === 'sd').test).length)],
    ['No subtitles', fmtNumber(lbFiles.filter(FILTERS.find((x) => x.id === 'nosubs').test).length)],
    ['Possible dupes', fmtNumber(lbDupes.size)],
  ];
  lb.stats.hidden = false;
  lb.stats.innerHTML = cells.map(([k, v]) =>
    `<div class="lb-stat"><span class="lb-stat-v">${esc(v)}</span><span class="lb-stat-k">${esc(k)}</span></div>`).join('');
}

function lbRenderFilters() {
  lb.filters.innerHTML = FILTERS.map((f) => {
    const n = lbFiles.filter(f.test).length;
    if (!n && f.id !== 'all') return '';
    return `<button class="lb-chip${f.id === lbFilter ? ' active' : ''}" type="button" data-filter="${esc(f.id)}">
      ${esc(f.label)} <span class="lb-chip-n">${fmtNumber(n)}</span></button>`;
  }).join('');
}

function lbRowHtml(f) {
  const res = lbResLabel(f);
  const subs = f.subTracks
    ? `${f.subTracks} embedded`
    : (f.sidecars || []).length ? `${f.sidecars.length} sidecar` : '';
  const bits = [
    lbBytes(f.size),
    f.duration ? lbClock(f.duration) : '',
    res,
    f.vcodec || '',
    subs ? `CC ${subs}` : '',
  ].filter(Boolean);

  return `<div class="lb-row${f.unreadable ? ' bad' : ''}${lbDupes.has(f.path) ? ' dupe' : ''}">
    <div class="lb-row-main">
      <div class="lb-row-name" title="${esc(f.path)}">${esc(f.name)}</div>
      <div class="lb-row-meta">${bits.map(esc).join(' · ')}</div>
    </div>
    <div class="lb-row-acts">
      ${f.kind !== 'other' ? `<button class="lb-act" type="button" data-convert="${esc(f.path)}" title="Open in Converter">Convert</button>` : ''}
      <button class="lb-act" type="button" data-reveal="${esc(f.path)}" title="Show in folder">Reveal</button>
    </div>
  </div>`;
}

function lbRenderList() {
  const rows = lbVisible();
  lb.controls.hidden = lbFiles.length === 0;
  if (!lbFiles.length) { lb.list.innerHTML = ''; return; }
  if (!rows.length) {
    lb.list.innerHTML = '<div class="lb-empty">Nothing matches that.</div>';
    return;
  }
  const shown = rows.slice(0, RENDER_CAP);
  lb.list.innerHTML = shown.map(lbRowHtml).join('')
    + (rows.length > shown.length
      ? `<div class="lb-empty">Showing ${fmtNumber(shown.length)} of ${fmtNumber(rows.length)} — narrow the search to see the rest.</div>`
      : '');
}

function lbRenderAll() {
  lbDupes = lbDuplicateKeys(lbFiles);
  lbRenderStats();
  lbRenderFilters();
  lbRenderList();
}

function lbRenderProgress(p) {
  const running = p && p.scanning;
  lb.cancel.hidden = !running;
  lb.scan.disabled = !!running;
  lb.pick.disabled = !!running;

  if (!running) {
    // Leave the last message up briefly rather than blanking the moment it ends.
    lb.progress.hidden = !p || !p.finishedAt || !!lbFiles.length === false;
    if (p && p.finishedAt && lbFiles.length) {
      lb.progress.hidden = true;
    }
    return;
  }
  lb.progress.hidden = false;
  const pct = p.found ? Math.round((p.scanned / p.found) * 100) : 0;
  lb.progress.innerHTML = `
    <div class="lb-progress-text">Scanning ${esc(p.root || '')} — ${fmtNumber(p.scanned)} of ${fmtNumber(p.found)} probed</div>
    <div class="lb-track"><div class="lb-fill" style="width:${pct}%"></div></div>`;
}

// --- Server ---
async function lbLoadIndex() {
  try {
    const res = await fetch('/api/library/index');
    const json = await res.json();
    if (json.status === 'ok') {
      lbFiles = json.data.files || [];
      lbRoot = json.data.root;
      if (lbRoot) lb.root.value = lbRoot;
      lbRenderAll();
    }
  } catch { /* the event stream will catch us up */ }
}

async function lbPickFolder() {
  lbClearError();
  try {
    const res = await fetch('/api/library/pick', { method: 'POST' });
    const json = await res.json();
    if (json.status !== 'ok') return lbShowError(json.status_message || 'Could not open the folder dialog.');
    if (json.data.cancelled) return;
    lb.root.value = json.data.dir;
    lbStartScan();
  } catch {
    lbShowError('Could not reach the server.');
  }
}

async function lbStartScan() {
  const root = lb.root.value.trim();
  if (!root) return lbShowError('Choose a folder first.');
  lbClearError();
  try {
    const res = await fetch('/api/library/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    });
    const json = await res.json();
    if (json.status !== 'ok') return lbShowError(json.status_message || 'Could not start the scan.');
    lbRenderProgress(json.data);
  } catch {
    lbShowError('Could not reach the server.');
  }
}

async function lbCancelScan() {
  try { await fetch('/api/library/cancel', { method: 'POST' }); } catch { /* ignore */ }
}

async function lbReveal(path) {
  try {
    await fetch(`/api/library/reveal?path=${encodeURIComponent(path)}`, { method: 'POST' });
  } catch { /* ignore */ }
}

// Hand a file to the Converter. Going through sessionStorage rather than
// importing the other tool keeps them independent — the shell mounts panels
// lazily, so the Converter may not exist yet when this fires.
function lbOpenInConverter(path) {
  try { sessionStorage.setItem('multitool:convert-path', path); } catch { /* ignore */ }
  location.hash = '#/convert';
}

function lbConnect() {
  if (lbStream) return;
  try { lbStream = new EventSource('/api/library/events'); } catch { return; }
  let wasScanning = false;
  lbStream.onmessage = (e) => {
    let p;
    try { p = JSON.parse(e.data); } catch { return; }
    lbRenderProgress(p);
    if (p.error) lbShowError(p.error);
    // A scan that just finished has a new index waiting.
    if (wasScanning && !p.scanning) lbLoadIndex();
    wasScanning = p.scanning;
  };
  lbStream.onerror = () => { /* EventSource reconnects on its own */ };
}

function bindLibrary() {
  lb.pick.addEventListener('click', lbPickFolder);
  lb.scan.addEventListener('click', lbStartScan);
  lb.cancel.addEventListener('click', lbCancelScan);
  lb.root.addEventListener('keydown', (e) => { if (e.key === 'Enter') lbStartScan(); });

  lb.search.addEventListener('input', debounce(() => {
    lbQuery = lb.search.value.trim();
    lbRenderList();
  }, 120));

  lb.sort.addEventListener('change', () => { lbSort = lb.sort.value; lbRenderList(); });

  lb.filters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    lbFilter = chip.dataset.filter;
    lbRenderFilters();
    lbRenderList();
  });

  lb.list.addEventListener('click', (e) => {
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) { lbReveal(reveal.dataset.reveal); return; }
    const convert = e.target.closest('[data-convert]');
    if (convert) lbOpenInConverter(convert.dataset.convert);
  });
}

export const tool = {
  id: 'library',
  name: 'Library',
  icon: '📚',
  blurb: 'Scan a folder and see what is really in it — sizes, quality, duplicates.',
  mount(panel) {
    panel.innerHTML = TEMPLATE;
    cacheEls();
    bindLibrary();
    lbLoadIndex();
    lbConnect();
  },
  show() {
    lb.search?.focus();
  },
};
