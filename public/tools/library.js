// Library Scanner — what is actually in that folder.
//
// The server hands over one flat index; everything here works against it in
// memory, so search, sort and every filter are instant and cost no disk work.
// Same idea as the Reddit tool: fetch once, then never wait again.

import { $, esc, fmtNumber, debounce } from '../lib/dom.js';
import { idleStream } from '../lib/stream.js';

const TEMPLATE = `
  <div class="tool-head">
    <h1 class="tool-title"><span class="tool-title-icon">📚</span> Library</h1>
    <p class="tool-sub">Scan a folder and see what is really in it — sizes, quality, subtitles, duplicates.</p>
  </div>

  <div class="lb-bar">
    <button id="lb-pick" class="btn btn-primary" type="button">Choose a folder…</button>
    <input id="lb-root" type="text" placeholder="E:\\Movies" autocomplete="off" spellcheck="false" />
    <label class="lb-toggle"><input type="checkbox" id="lb-images" /> Include images</label>
    <button id="lb-scan" class="btn-ghost" type="button">Scan</button>
    <button id="lb-cancel" class="btn-ghost" type="button" hidden>Cancel</button>
  </div>

  <div id="lb-error" class="lb-notice error" hidden></div>
  <div id="lb-progress" class="lb-progress" hidden></div>

  <div id="lb-stats" class="lb-stats" hidden></div>

  <div id="lb-views" class="lb-views" hidden>
    <button class="lb-chip active" type="button" data-view="files">Files</button>
    <button class="lb-chip" type="button" data-view="folders">Folders</button>
  </div>

  <div id="lb-controls" class="lb-controls" hidden>
    <input id="lb-search" type="search" placeholder="Search name, folder, codec…" autocomplete="off" />
    <label class="lb-toggle"><input type="checkbox" id="lb-thumbs" checked /> Thumbnails</label>
    <select id="lb-sort">
      <option value="name">Name</option>
      <option value="size">Largest first</option>
      <option value="duration">Longest first</option>
      <option value="height">Highest resolution</option>
      <option value="mtime">Newest first</option>
    </select>
    <div id="lb-filters" class="lb-filters"></div>
  </div>

  <div id="lb-fd-controls" class="lb-controls" hidden>
    <input id="lb-fd-search" type="search" placeholder="Search folders…" autocomplete="off" />
    <select id="lb-fd-sort">
      <option value="size">Largest first</option>
      <option value="files">Most files</option>
      <option value="ownSize">Largest ignoring subfolders</option>
      <option value="name">Name</option>
      <option value="rel">Path</option>
      <option value="depth">Depth</option>
    </select>
    <label class="lb-toggle"><input type="checkbox" id="lb-fd-top" /> Top level only</label>
  </div>

  <div id="lb-list" class="lb-list"></div>
  <div id="lb-folders" class="lb-list" hidden></div>`;

const lb = {};
function cacheEls() {
  Object.assign(lb, {
    pick: $('lb-pick'),
    root: $('lb-root'),
    scan: $('lb-scan'),
    images: $('lb-images'),
    cancel: $('lb-cancel'),
    error: $('lb-error'),
    progress: $('lb-progress'),
    stats: $('lb-stats'),
    controls: $('lb-controls'),
    search: $('lb-search'),
    sort: $('lb-sort'),
    thumbs: $('lb-thumbs'),
    filters: $('lb-filters'),
    list: $('lb-list'),
    views: $('lb-views'),
    fdControls: $('lb-fd-controls'),
    fdSearch: $('lb-fd-search'),
    fdSort: $('lb-fd-sort'),
    fdTop: $('lb-fd-top'),
    folders: $('lb-folders'),
  });
}

let lbFiles = [];
let lbFolders = [];
let lbView = 'files';
let lbFdQuery = '';
let lbFdSort = 'size';
let lbFdTop = false;
let lbRoot = null;
let lbStream = null;
let lbFilter = 'all';
let lbQuery = '';
let lbSort = 'name';
let lbThumbs = true;
let lbImages = false;

const LB_PREFS_KEY = 'multitool:library';

function lbSavePrefs() {
  try {
    localStorage.setItem(LB_PREFS_KEY, JSON.stringify({ thumbs: lbThumbs, images: lbImages }));
  } catch { /* ignore */ }
}

function lbLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(LB_PREFS_KEY));
    if (saved && typeof saved.thumbs === 'boolean') lbThumbs = saved.thumbs;
    if (saved && typeof saved.images === 'boolean') lbImages = saved.images;
  } catch { /* keep the default */ }
}

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
// Three independent signals, because "duplicate" means different things:
//
//   identical  same byte count AND the same head/tail hash from the server.
//              A straight copy under another name. Effectively certain.
//   length     same running time, to the second, for anything over 30s. Catches
//              the same video re-encoded, resized or remuxed — where the bytes
//              differ completely but the content does not.
//   name       the release name normalises to the same thing. On its own this
//              is the weakest of the three and the one that cries wolf, so it
//              only counts toward "possible duplicates" when the running times
//              agree too.
//
// Release names are noisy — "Movie.2019.1080p.BluRay.x264-GROUP.mkv" and
// "Movie (2019) [720p].mp4" are the same film — so the name signal strips
// everything that is metadata rather than title, keeping the year since remakes
// are genuinely different films.
const NOISE = /\b(2160p|1440p|1080p|720p|576p|480p|360p|4k|uhd|hdr10?|sdr|bluray|blu-ray|brrip|bdrip|bdremux|webrip|web-dl|webdl|hdtv|hdrip|dvdrip|dvd|remux|x\s?26[45]|h\s?26[45]|hevc|avc|xvid|divx|aac|ac3|eac3|dts(-hd)?|ddp?\s?5[. ]?1|atmos|truehd|10bit|8bit|proper|repack|extended|unrated|uncut|remastered|directors?\s?cut|imax|multi|dual|subbed|dubbed|complete)\b/gi;

// Below this a "title" is too generic to mean anything — "asmr", "clip", "1".
const MIN_KEY_LEN = 6;
// Two clips both 8 seconds long are not evidence of anything.
const MIN_DUP_DURATION = 30;

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

// Groups every file by a key, and returns the members of any group with more
// than one file in it.
function groupBy(files, keyOf) {
  const byKey = new Map();
  for (const f of files) {
    const key = keyOf(f);
    if (key == null) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  const out = new Map();
  for (const [, group] of byKey) {
    if (group.length > 1) for (const f of group) out.set(f.path, group);
  }
  return out;
}

// path -> { identical, length, name, group } where group is the largest set of
// files this one was matched with.
function lbDuplicates(files) {
  const videos = files.filter((f) => f.kind === 'video' || f.kind === 'audio' || f.kind === 'archive');

  const identical = groupBy(videos, (f) => (f.sig && f.size ? `${f.size}:${f.sig}` : null));
  const byLength = groupBy(videos, (f) =>
    (f.duration && f.duration >= MIN_DUP_DURATION ? Math.round(f.duration) : null));
  const byName = groupBy(videos, (f) => {
    const key = lbTitleKey(f.name);
    return key.length >= MIN_KEY_LEN ? key : null;
  });

  const out = new Map();
  for (const f of videos) {
    const flags = {
      identical: identical.has(f.path),
      length: byLength.has(f.path),
      name: byName.has(f.path),
    };
    if (!flags.identical && !flags.length && !flags.name) continue;
    flags.group = identical.get(f.path) || byLength.get(f.path) || byName.get(f.path);
    out.set(f.path, flags);
  }
  return out;
}

// What counts as worth showing under "possible duplicates": either of the two
// strong signals, or a name match corroborated by the running time.
function lbIsDuplicate(d) {
  return !!d && (d.identical || d.length || (d.name && d.length));
}

function lbDupeReason(d) {
  if (!d) return '';
  if (d.identical) return 'identical file';
  if (d.length && d.name) return 'same name and length';
  if (d.length) return 'same length';
  if (d.name) return 'same name only';
  return '';
}

// --- Filters ---
let lbDupes = new Map();

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'video', label: 'Video', test: (f) => f.kind === 'video' },
  { id: 'audio', label: 'Audio', test: (f) => f.kind === 'audio' },
  { id: 'image', label: 'Images', test: (f) => f.kind === 'image' },
  { id: 'archive', label: 'Archives', test: (f) => f.kind === 'archive' },
  { id: 'sd', label: 'Below 1080p', test: (f) => f.kind === 'video' && f.height && f.height < 1000 },
  { id: 'nosubs', label: 'No subtitles', test: (f) => f.kind === 'video' && !f.subTracks && !(f.sidecars || []).length },
  { id: 'dupes', label: 'Possible duplicates', test: (f) => lbIsDuplicate(lbDupes.get(f.path)) },
  { id: 'identical', label: 'Identical files', test: (f) => !!(lbDupes.get(f.path) || {}).identical },
  { id: 'samelen', label: 'Same length', test: (f) => !!(lbDupes.get(f.path) || {}).length },
  { id: 'samename', label: 'Same name only', test: (f) => {
    const d = lbDupes.get(f.path);
    return !!d && d.name && !d.identical && !d.length;
  } },
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

// --- Folders -----------------------------------------------------------------
function lbFoldersVisible() {
  const q = lbFdQuery.toLowerCase();
  let out = lbFolders.filter((f) => f.depth > 0); // the root itself is the total, not a row
  if (lbFdTop) out = out.filter((f) => f.depth === 1);
  if (q) out = out.filter((f) => f.rel.toLowerCase().includes(q));

  const dir = ['name', 'rel'].includes(lbFdSort) ? 1 : -1;
  return out.sort((a, b) => {
    if (lbFdSort === 'name') return a.name.localeCompare(b.name);
    if (lbFdSort === 'rel') return a.rel.localeCompare(b.rel);
    return ((a[lbFdSort] || 0) - (b[lbFdSort] || 0)) * dir;
  });
}

function lbFolderRowHtml(f, widest) {
  // A bar against the biggest folder on screen makes the shape of the library
  // readable at a glance, which a column of numbers does not.
  const pct = widest ? Math.max(1, (f.size / widest) * 100) : 0;
  // "own" is what sits directly in the folder; the difference is what is nested
  // below it. Worth showing, because a folder can be huge while holding nothing.
  const own = f.ownSize && f.ownSize !== f.size
    ? `${lbBytes(f.ownSize)} here, rest in subfolders`
    : `${fmtNumber(f.ownFiles)} file${f.ownFiles === 1 ? '' : 's'} here`;

  return `<div class="lb-row lb-fd-row">
    <div class="lb-row-main">
      <div class="lb-row-name" title="${esc(f.path)}">${esc(f.rel)}</div>
      <div class="lb-fd-bar"><div class="lb-fd-fill" style="width:${pct}%"></div></div>
      <div class="lb-row-meta">${fmtNumber(f.files)} files · ${esc(own)}</div>
    </div>
    <div class="lb-fd-size">${lbBytes(f.size)}</div>
    <div class="lb-row-acts">
      <button class="lb-act" type="button" data-fd-open="${esc(f.rel)}" title="Show these files">Files</button>
      <button class="lb-act" type="button" data-reveal="${esc(f.path)}" title="Show in Explorer">Reveal</button>
    </div>
  </div>`;
}

function lbRenderFolders() {
  const rows = lbFoldersVisible();
  if (!rows.length) {
    lb.folders.innerHTML = `<div class="lb-empty">${lbFolders.length ? 'No folders match that.' : 'No subfolders found.'}</div>`;
    return;
  }
  const widest = Math.max(...rows.map((f) => f.size));
  const shown = rows.slice(0, RENDER_CAP);
  lb.folders.innerHTML = shown.map((f) => lbFolderRowHtml(f, widest)).join('')
    + (rows.length > shown.length
      ? `<div class="lb-empty">Showing ${fmtNumber(shown.length)} of ${fmtNumber(rows.length)} — narrow the search to see the rest.</div>`
      : '');
}

function lbShowView(view) {
  lbView = view;
  lb.views.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  lb.controls.hidden = view !== 'files' || !lbFiles.length;
  lb.list.hidden = view !== 'files';
  lb.fdControls.hidden = view !== 'folders';
  lb.folders.hidden = view !== 'folders';
  if (view === 'folders') lbRenderFolders();
  else lbRenderList();
}

// --- Rendering ---
function lbRenderStats() {
  if (!lbFiles.length) { lb.stats.hidden = true; return; }
  const totalSize = lbFiles.reduce((n, f) => n + (f.size || 0), 0);
  const totalTime = lbFiles.reduce((n, f) => n + (f.duration || 0), 0);
  const cells = [
    ['Files', fmtNumber(lbFiles.length)],
    ['Folders', fmtNumber(Math.max(0, lbFolders.length - 1))],
    ['Total size', lbBytes(totalSize)],
    ['Runtime', `${Math.round(totalTime / 3600)} h`],
    ['Below 1080p', fmtNumber(lbFiles.filter(FILTERS.find((x) => x.id === 'sd').test).length)],
    ['No subtitles', fmtNumber(lbFiles.filter(FILTERS.find((x) => x.id === 'nosubs').test).length)],
    ['Possible dupes', fmtNumber(lbFiles.filter(FILTERS.find((x) => x.id === 'dupes').test).length)],
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
  const dupe = lbDupes.get(f.path);
  const reason = lbIsDuplicate(dupe) ? lbDupeReason(dupe) : '';
  const subs = f.subTracks
    ? `${f.subTracks} embedded`
    : (f.sidecars || []).length ? `${f.sidecars.length} sidecar` : '';
  const bits = [
    lbBytes(f.size),
    f.duration ? lbClock(f.duration) : '',
    lbResLabel(f),
    f.vcodec || '',
    subs ? `CC ${subs}` : '',
  ].filter(Boolean);

  // loading="lazy" is what makes this affordable on a library of thousands —
  // the browser only asks for the handful actually on screen, and each request
  // is what triggers the server to render that frame.
  const thumb = lbThumbs && (f.kind === 'video' || f.kind === 'image') && !f.unreadable
    ? `<img class="lb-thumb" loading="lazy" decoding="async" alt=""
         src="/api/library/thumb?path=${encodeURIComponent(f.path)}"
         onerror="this.classList.add('failed')" />`
    : '';

  return `<div class="lb-row${f.unreadable ? ' bad' : ''}${reason ? ' dupe' : ''}">
    ${thumb}
    <div class="lb-row-main">
      <div class="lb-row-name" title="${esc(f.path)}">${esc(f.name)}</div>
      <div class="lb-row-meta">${bits.map(esc).join(' · ')}${
        reason ? ` · <span class="lb-dupe-why">${esc(reason)}</span>` : ''}</div>
    </div>
    <div class="lb-row-acts">
      <button class="lb-act" type="button" data-open="${esc(f.path)}" title="Open with the default app">Open</button>
      ${f.kind === 'video' || f.kind === 'audio' || f.kind === 'image'
        ? `<button class="lb-act" type="button" data-convert="${esc(f.path)}" title="Open in Converter">Convert</button>` : ''}
      <button class="lb-act" type="button" data-reveal="${esc(f.path)}" title="Show in Explorer">Reveal</button>
    </div>
  </div>`;
}

function lbRenderList() {
  const rows = lbVisible();
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
  lbDupes = lbDuplicates(lbFiles);
  lb.views.hidden = lbFiles.length === 0 && lbFolders.length === 0;
  lbRenderStats();
  lbRenderFilters();
  lbShowView(lbView);
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
      lbFolders = json.data.folders || [];
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
      body: JSON.stringify({ root, includeImages: lb.images.checked }),
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

// Opens the file with whatever Windows (or the desktop) associates with it.
async function lbOpen(path) {
  try {
    const res = await fetch(`/api/library/open?path=${encodeURIComponent(path)}`, { method: 'POST' });
    const json = await res.json();
    if (json.status !== 'ok') lbShowError(json.status_message || 'Could not open that.');
    else lbClearError();
  } catch {
    lbShowError('Could not reach the server.');
  }
}

async function lbReveal(path) {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  try {
    const res = await fetch(`/api/library/reveal${qs}`, { method: 'POST' });
    const json = await res.json();
    if (json.status !== 'ok') lbShowError(json.status_message || 'Could not show that.');
    else lbClearError();
  } catch {
    lbShowError('Could not reach the server.');
  }
}

// Hand a file to the Converter. Going through sessionStorage rather than
// importing the other tool keeps them independent — the shell mounts panels
// lazily, so the Converter may not exist yet when this fires.
function lbOpenInConverter(path) {
  try { sessionStorage.setItem('multitool:convert-path', path); } catch { /* ignore */ }
  location.hash = '#/convert';
}

let lbScanning = false;

function lbConnect() {
  if (lbStream) return;
  lbStream = idleStream('/api/library/events', {
    // A scan in progress keeps the stream open on a hidden tab.
    isBusy: () => lbScanning,
    // Away long enough to miss the end of a scan? Pick up the new index.
    onWake: lbLoadIndex,
    onMessage: (p) => {
      lbRenderProgress(p);
      if (p.error) lbShowError(p.error);
      // Hitting the cap means files were left out, which makes every total on
      // screen an undercount. Saying so beats quietly being wrong.
      if (p.truncated) {
        lbShowError(`Stopped at the ${fmtNumber(p.limit)} file limit — some files were not indexed.${
          lbImages ? ' Turning off "Include images" will usually bring it back under.' : ''}`);
      }
      // A scan that just finished has a new index waiting.
      if (lbScanning && !p.scanning) lbLoadIndex();
      lbScanning = !!p.scanning;
    },
  });
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

  lb.images.addEventListener('change', () => { lbImages = lb.images.checked; lbSavePrefs(); });

  lb.thumbs.addEventListener('change', () => {
    lbThumbs = lb.thumbs.checked;
    lbSavePrefs();
    lbRenderList();
  });

  lb.views.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) lbShowView(btn.dataset.view);
  });

  lb.fdSearch.addEventListener('input', debounce(() => {
    lbFdQuery = lb.fdSearch.value.trim();
    lbRenderFolders();
  }, 120));

  lb.fdSort.addEventListener('change', () => { lbFdSort = lb.fdSort.value; lbRenderFolders(); });
  lb.fdTop.addEventListener('change', () => { lbFdTop = lb.fdTop.checked; lbRenderFolders(); });

  lb.folders.addEventListener('click', (e) => {
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) { lbReveal(reveal.dataset.reveal); return; }
    // Jumping to the file list filtered to this folder is what you almost
    // always want next after spotting a big one.
    const open = e.target.closest('[data-fd-open]');
    if (!open) return;
    lb.search.value = open.dataset.fdOpen;
    lbQuery = open.dataset.fdOpen;
    lbFilter = 'all';
    lbRenderFilters();
    lbShowView('files');
  });

  lb.filters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    lbFilter = chip.dataset.filter;
    lbRenderFilters();
    lbRenderList();
  });

  lb.list.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { lbOpen(open.dataset.open); return; }
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
    lbLoadPrefs();
    lb.thumbs.checked = lbThumbs;
    lb.images.checked = lbImages;
    bindLibrary();
    lbLoadIndex();
    lbConnect();
  },
  show() {
    lb.search?.focus();
  },
};
