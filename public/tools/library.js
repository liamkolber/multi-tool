// Library Scanner — what is actually in that folder.
//
// The server hands over one flat index; everything here works against it in
// memory, so search, sort and every filter are instant and cost no disk work.
// Same idea as the Reddit tool: fetch once, then never wait again.

import { $, esc, fmtNumber, debounce, showModal, closeModal } from '../lib/dom.js';
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

  <div id="lb-recent" class="lb-recent" hidden></div>

  <div id="lb-error" class="lb-notice error" hidden></div>
  <div id="lb-progress" class="lb-progress" hidden></div>

  <div id="lb-stats" class="lb-stats" hidden></div>

  <div id="lb-trash" class="lb-trash" hidden></div>

  <div id="lb-views" class="lb-views" hidden>
    <button class="lb-chip active" type="button" data-view="files">Files</button>
    <button class="lb-chip" type="button" data-view="folders">Folders</button>
    <button class="lb-chip" type="button" data-view="treemap">Treemap</button>
  </div>

  <div id="lb-controls" class="lb-controls" hidden>
    <input id="lb-search" type="search" placeholder="Search name, folder, codec…" autocomplete="off" />
    <label class="lb-toggle"><input type="checkbox" id="lb-thumbs" checked /> Thumbnails</label>
    <select id="lb-sort">
      <option value="name">Name</option>
      <option value="size">Largest first</option>
      <option value="duration">Longest first</option>
      <option value="height">Highest resolution</option>
      <option value="dupe">Duplicate sets</option>
      <option value="dir">Folder</option>
      <option value="mtime">Newest first</option>
    </select>
    <button id="lb-filters-toggle" class="lb-act lb-filters-toggle" type="button"></button>
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

  <div id="lb-blank" class="lb-blank" hidden>
    Nothing scanned yet. Choose a folder above and the whole tree gets read —
    sizes, running times, resolutions, subtitles and duplicates.
  </div>

  <div id="lb-bulk" class="lb-bulk" hidden></div>

  <div id="lb-sheet" class="lb-sheet" hidden></div>

  <div id="lb-list" class="lb-list"></div>
  <div id="lb-folders" class="lb-list" hidden></div>
  <div id="lb-treemap" class="lb-treemap" hidden></div>`;

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
    filtersToggle: $('lb-filters-toggle'),
    list: $('lb-list'),
    views: $('lb-views'),
    trash: $('lb-trash'),
    recent: $('lb-recent'),
    blank: $('lb-blank'),
    fdControls: $('lb-fd-controls'),
    fdSearch: $('lb-fd-search'),
    fdSort: $('lb-fd-sort'),
    fdTop: $('lb-fd-top'),
    folders: $('lb-folders'),
    sheet: $('lb-sheet'),
    treemap: $('lb-treemap'),
    bulk: $('lb-bulk'),
  });
}

let lbFiles = [];
let lbFolders = [];
let lbTrash = [];
let lbView = 'files';
let lbFdQuery = '';
let lbFdSort = 'size';
let lbFdTop = false;
let lbRoot = null;
let lbStream = null;
const lbFilters = new Set();
// Set when the sort was chosen on your behalf rather than by you, so it can be
// put back afterwards without overriding a deliberate choice.
let lbSortAuto = null;
// Whether a duplicate filter was on last time round, so the switch fires on the
// way in rather than on every toggle while already there.
let lbDupeFiltersOn = false;
let lbQuery = '';
let lbSort = 'name';
let lbThumbs = true;
let lbImages = false;
// Twenty-odd chips is a lot of screen to give up when you already know which
// filter you want. Collapsed by choice, and remembered.
let lbFiltersOpen = true;
let lbRecent = [];
// Paths ticked for a bulk action. Kept as paths rather than indices so it
// survives re-sorting and re-filtering, which is exactly when you build one up.
const lbSelected = new Set();

const LB_PREFS_KEY = 'multitool:library';

function lbSavePrefs() {
  try {
    localStorage.setItem(LB_PREFS_KEY, JSON.stringify({
      thumbs: lbThumbs, images: lbImages, recent: lbRecent, filtersOpen: lbFiltersOpen,
    }));
  } catch { /* ignore */ }
}

// Folders scanned before, most recent first. Kept here rather than on the
// server because the server only ever remembers the one index it is holding —
// switching between two libraries would otherwise mean retyping a path.
const RECENT_KEEP = 5;

function lbRememberRoot(root) {
  if (!root) return;
  lbRecent = [root, ...lbRecent.filter((r) => r.toLowerCase() !== root.toLowerCase())].slice(0, RECENT_KEEP);
  lbSavePrefs();
  lbRenderRecent();
}

function lbRenderRecent() {
  if (!lbRecent.length) { lb.recent.hidden = true; lb.recent.innerHTML = ''; return; }
  lb.recent.hidden = false;
  lb.recent.innerHTML = '<span class="lb-recent-label">Recent:</span>'
    + lbRecent.map((r) => `<button class="lb-chip" type="button" data-recent="${esc(r)}" title="${esc(r)}">${esc(r)}</button>`).join('');
}

function lbLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(LB_PREFS_KEY));
    if (saved && typeof saved.thumbs === 'boolean') lbThumbs = saved.thumbs;
    if (saved && typeof saved.images === 'boolean') lbImages = saved.images;
    if (saved && Array.isArray(saved.recent)) lbRecent = saved.recent.filter((r) => typeof r === 'string');
    if (saved && typeof saved.filtersOpen === 'boolean') lbFiltersOpen = saved.filtersOpen;
  } catch { /* keep the default */ }
}

// Rows are added a chunk at a time as you reach the end of the list, rather
// than all at once. A hard cap meant a thousand duplicates you could never get
// to; rendering all of them up front means thirty thousand DOM nodes before you
// have looked at one.
const RENDER_CHUNK = 300;
let lbShown = RENDER_CHUNK;
let lbMoreObserver = null;

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

function lbRelDir(f) {
  if (!lbRoot || !f.dir) return '';
  // Both come out of the same scan, so a length slice is safe — no need to
  // reconcile separators or drive-letter case between them.
  if (f.dir.length <= lbRoot.length) return '';
  return f.dir.slice(lbRoot.length).replace(/^[\\/]+/, '');
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
//   name       the same filename, exactly, in two different folders. Two files
//              cannot share a name in one folder, so this always means copies
//              in separate places.
//
// The name signal used to normalise release names — stripping resolutions,
// codecs, release groups — so that "Movie.2019.1080p.BluRay.x264-GROUP.mkv" and
// "Movie (2019) [720p].mp4" would match. On a real library that was a menace:
// the trailing-release-group rule ate the only distinguishing part of names
// like "CHANNEL - 13177.mov" and "CHANNEL - 13144.mp4", collapsing hundreds of
// unrelated files onto one key. It also contributed nothing that the length
// signal did not already cover, since a fuzzy name only counted as a duplicate
// when the running times agreed anyway. Exact is what is left, and it is the
// version that is actually true.

// Two clips both eight seconds long are not evidence of anything.
const MIN_DUP_DURATION = 30;

// Running times are compared to half a second rather than rounded to the
// nearest one. Rounding put every 33-minute video in the same bucket, which on
// a few thousand files is hundreds of unrelated collisions; a re-encode of the
// same source lands within a frame or two of the original, so the tolerance can
// be this tight without losing the case the signal exists for.
const LENGTH_TOLERANCE = 0.5;

// Two files of the same length whose sizes are within this of each other are
// almost certainly the same content. Wider than a re-encode at a different CRF,
// narrower than 1080p versus 480p.
const SIZE_TOLERANCE = 0.12;

// Windows filenames are case-insensitive, so "Clip.mp4" and "clip.mp4" in two
// folders are the same name.
function lbNameKey(name) {
  return String(name || '').trim().toLowerCase();
}

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

// Runs of files whose value stays within tolerance of the run's FIRST member.
// Anchoring on the first rather than the previous one matters: chaining lets a
// set drift arbitrarily far, so a thousand files each half a second apart would
// all end up in one group.
function clusterBy(files, valueOf, withinTolerance) {
  const sorted = [...files].sort((a, b) => valueOf(a) - valueOf(b));
  const sets = [];
  let run = [];
  for (const f of sorted) {
    if (run.length && !withinTolerance(valueOf(run[0]), valueOf(f))) {
      if (run.length > 1) sets.push(run);
      run = [];
    }
    run.push(f);
  }
  if (run.length > 1) sets.push(run);
  return sets;
}

// path -> the set it belongs to, for a list of sets.
function membersOf(sets) {
  const out = new Map();
  for (const set of sets) for (const f of set) out.set(f.path, set);
  return out;
}

// path -> { identical, close, shape, length, name, group } where group is the
// tightest set this file was matched with.
function lbDuplicates(files) {
  const videos = files.filter((f) => f.kind === 'video' || f.kind === 'audio' || f.kind === 'archive');

  const identical = groupBy(videos, (f) => (f.sig && f.size ? `${f.size}:${f.sig}` : null));
  const byName = groupBy(videos, (f) => lbNameKey(f.name) || null);

  // Length, then two tighter cuts through the same sets.
  const lengthSets = clusterBy(
    videos.filter((f) => f.duration && f.duration >= MIN_DUP_DURATION),
    (f) => f.duration,
    (anchor, v) => v - anchor <= LENGTH_TOLERANCE,
  );
  const byLength = membersOf(lengthSets);

  // Same length AND a size within a few percent: a re-encode at a similar
  // quality, or the same download twice. Much harder to hit by accident than
  // length alone.
  const bySize = membersOf(lengthSets.flatMap((set) => clusterBy(
    [...set].sort((a, b) => (a.size || 0) - (b.size || 0)),
    (f) => f.size || 0,
    (anchor, v) => anchor > 0 && (v - anchor) / anchor <= SIZE_TOLERANCE,
  )));

  // Same length AND the same frame size: the same thing remuxed or re-encoded
  // at the same resolution, where the byte count may differ a lot.
  const byShape = membersOf(lengthSets.flatMap((set) => {
    const byDims = new Map();
    for (const f of set) {
      if (!f.width || !f.height) continue;
      const key = `${f.width}x${f.height}`;
      if (!byDims.has(key)) byDims.set(key, []);
      byDims.get(key).push(f);
    }
    return [...byDims.values()].filter((g) => g.length > 1);
  }));

  const out = new Map();
  // groupBy hands every member of a set the same array, so the array itself is
  // the set's identity — no need to invent a key.
  const ids = new Map();
  let nextId = 0;

  for (const f of videos) {
    const flags = {
      identical: identical.has(f.path),
      close: bySize.has(f.path),
      shape: byShape.has(f.path),
      length: byLength.has(f.path),
      name: byName.has(f.path),
    };
    if (!flags.identical && !flags.length && !flags.name) continue;

    // Strongest signal wins, so a set is grouped by the best evidence it has —
    // and the tighter sets are what you want adjacent when combing through.
    const group = identical.get(f.path) || bySize.get(f.path) || byShape.get(f.path)
      || byLength.get(f.path) || byName.get(f.path);
    if (!ids.has(group)) ids.set(group, ++nextId);

    const sizes = group.map((x) => x.size || 0);
    flags.group = group;
    flags.groupId = ids.get(group);
    flags.groupCount = group.length;
    flags.groupMax = Math.max(...sizes);
    // Keeping the largest copy, this is what the rest of the set is costing.
    flags.groupWaste = sizes.reduce((n, s) => n + s, 0) - flags.groupMax;

    out.set(f.path, flags);
  }
  return out;
}

// Any of the three now qualifies. The name signal used to need the running time
// to corroborate it, which was a way of muzzling a heuristic that cried wolf —
// an exact filename match in two folders needs no such hedging, and the old
// condition was redundant anyway (a name match only counted when the length
// matched, and a length match already counted by itself).
function lbIsDuplicate(d) {
  return !!d && (d.identical || d.length || d.name);
}

function lbDupeReason(d) {
  if (!d) return '';
  const why = d.identical ? 'identical file'
    : d.close ? 'same length and size'
      : d.shape ? 'same length and resolution'
        : d.length && d.name ? 'same name and length'
          : d.length ? 'same length'
            : d.name ? 'same name' : '';
  if (!why) return '';
  // "1 of 3" is the part that tells you whether it is worth opening.
  const n = d.groupCount || 0;
  return n > 1 ? `${why} · 1 of ${n}` : why;
}

// --- Filters ---
let lbDupes = new Map();

// Grouped so the chips read as sets rather than one long row. Everything picked
// is ANDed: "Same length" plus "Below 1080p" means both, not either.
const dupeOf = (f) => lbDupes.get(f.path) || {};

const FILTERS = [
  { group: 'Kind', id: 'video', label: 'Video', test: (f) => f.kind === 'video' },
  { group: 'Kind', id: 'audio', label: 'Audio', test: (f) => f.kind === 'audio' },
  { group: 'Kind', id: 'image', label: 'Images', test: (f) => f.kind === 'image' },
  { group: 'Kind', id: 'archive', label: 'Archives', test: (f) => f.kind === 'archive' },

  { group: 'Duplicates', id: 'dupes', label: 'Any duplicate', test: (f) => lbIsDuplicate(lbDupes.get(f.path)) },
  { group: 'Duplicates', id: 'identical', label: 'Identical files', test: (f) => !!dupeOf(f).identical },
  { group: 'Duplicates', id: 'closesize', label: 'Same length & size', test: (f) => !!dupeOf(f).close },
  { group: 'Duplicates', id: 'sameshape', label: 'Same length & resolution', test: (f) => !!dupeOf(f).shape },
  { group: 'Duplicates', id: 'samelen', label: 'Same length', test: (f) => !!dupeOf(f).length },
  { group: 'Duplicates', id: 'samename', label: 'Same filename', test: (f) => !!dupeOf(f).name },

  { group: 'Quality', id: 'sd', label: 'Below 1080p', test: (f) => f.kind === 'video' && f.height && f.height < 1000 },
  { group: 'Quality', id: 'hd', label: '1080p or better', test: (f) => f.kind === 'video' && f.height && f.height >= 1000 },
  { group: 'Quality', id: 'vertical', label: 'Vertical', test: (f) => f.width && f.height && f.height > f.width },
  { group: 'Quality', id: 'nosubs', label: 'No subtitles', test: (f) => f.kind === 'video' && !f.subTracks && !(f.sidecars || []).length },
  { group: 'Quality', id: 'noaudio', label: 'No audio', test: (f) => f.kind === 'video' && !f.audioTracks },

  { group: 'Size', id: 'big', label: 'Over 4 GB', test: (f) => f.size > 4 * 1024 ** 3 },
  { group: 'Size', id: 'tiny', label: 'Under 20 MB', test: (f) => f.size > 0 && f.size < 20 * 1024 ** 2 },
  { group: 'Size', id: 'longone', label: 'Over an hour', test: (f) => f.duration >= 3600 },
  { group: 'Size', id: 'shortone', label: 'Under 5 min', test: (f) => f.duration > 0 && f.duration < 300 },
  { group: 'Size', id: 'bad', label: 'Unreadable', test: (f) => f.unreadable },
];

const FILTER_BY_ID = new Map(FILTERS.map((f) => [f.id, f]));
const DUPE_FILTERS = new Set(FILTERS.filter((f) => f.group === 'Duplicates').map((f) => f.id));

// A duplicate filter is close to useless under any other order — you get a list
// of files that each have a match somewhere, with no way to see what they match.
// So picking one switches to the grouping sort, and dropping the last one puts
// your previous choice back. Changing the sort by hand clears the arrangement,
// because from then on it is your call rather than ours.
function lbSyncDupeSort() {
  const wantsGrouping = [...lbFilters].some((id) => DUPE_FILTERS.has(id));

  // Only on the way in and the way out. Reacting to every toggle would grab the
  // sort back the moment you added a second duplicate filter, undoing a choice
  // you had just made by hand.
  if (wantsGrouping && !lbDupeFiltersOn && lbSort !== 'dupe') {
    lbSortAuto = lbSort;
    lbSort = 'dupe';
    lb.sort.value = 'dupe';
  } else if (!wantsGrouping && lbDupeFiltersOn && lbSortAuto !== null && lbSort === 'dupe') {
    lbSort = lbSortAuto;
    lb.sort.value = lbSortAuto;
    lbSortAuto = null;
  }

  lbDupeFiltersOn = wantsGrouping;
}

function lbVisible() {
  const active = [...lbFilters].map((id) => FILTER_BY_ID.get(id)).filter(Boolean);
  const q = lbQuery.toLowerCase();
  // Nothing picked means everything; otherwise a file has to satisfy them all.
  let out = active.length ? lbFiles.filter((f) => active.every((x) => x.test(f))) : lbFiles.slice();
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
    // Within a folder, by name — otherwise the grouping is there but unordered.
    if (lbSort === 'dir') return a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name);

    // Sets first by their biggest file, then together, then biggest copy first
    // inside the set — so the one worth keeping heads its own group and
    // everything under it is a candidate to delete.
    if (lbSort === 'dupe') {
      const da = lbDupes.get(a.path) || {};
      const db = lbDupes.get(b.path) || {};
      const ma = da.groupMax == null ? -1 : da.groupMax;
      const mb = db.groupMax == null ? -1 : db.groupMax;
      if (ma !== mb) return mb - ma;
      if (da.groupId !== db.groupId) return (da.groupId || 0) - (db.groupId || 0);
      return (b.size || 0) - (a.size || 0);
    }

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
  const shown = rows.slice(0, 500);
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
  lb.treemap.hidden = view !== 'treemap';
  if (view === 'folders') lbRenderFolders();
  else if (view === 'treemap') lbRenderTreemap();
  else lbRenderList();
}

// What deleting all but the largest copy in every set would free. Counted once
// per set, not once per file, or every set would be counted as many times as it
// has members.
function lbReclaimable() {
  const seen = new Set();
  let total = 0;
  for (const d of lbDupes.values()) {
    if (!lbIsDuplicate(d) || seen.has(d.groupId)) continue;
    seen.add(d.groupId);
    total += d.groupWaste || 0;
  }
  return total;
}

// --- Treemap -----------------------------------------------------------------
// Area is disk space. The scan already computed a recursive size for every
// folder, so this is a rendering of numbers we have rather than new work.

let lbMapAt = ''; // which folder is filling the frame, '' meaning the root

// Rebuilds the parent/child structure the flat folder list implies.
function lbTree() {
  const byRel = new Map();
  for (const f of lbFolders) byRel.set(f.rel, { ...f, children: [] });

  for (const node of byRel.values()) {
    if (!node.rel) continue;
    const cut = Math.max(node.rel.lastIndexOf('\\'), node.rel.lastIndexOf('/'));
    const parentRel = cut < 0 ? '' : node.rel.slice(0, cut);
    const parent = byRel.get(parentRel);
    if (parent) parent.children.push(node);
  }
  return byRel;
}

// A binary treemap: split the list where the running total passes half, then
// divide the rectangle along its LONGER side. Always splitting the long side is
// what keeps tiles from degenerating into slivers, which is the whole problem
// with the naive slice-and-dice version.
function lbLayout(items, x, y, w, h, out, depth) {
  if (!items.length || w <= 0 || h <= 0) return;
  if (items.length === 1) {
    out.push({ item: items[0], x, y, w, h, depth });
    return;
  }

  const total = items.reduce((n, i) => n + i.value, 0);
  if (total <= 0) return;

  let acc = 0;
  let split = 0;
  while (split < items.length - 1 && acc + items[split].value <= total / 2) {
    acc += items[split].value;
    split++;
  }

  // The first item alone can be more than half the total — a folder where one
  // child holds most of the space, which is the normal case rather than an edge
  // one. Without this the head is empty, the tail is the untouched input, and it
  // recurses until the stack goes.
  if (split === 0) split = 1;

  const head = items.slice(0, split);
  const tail = items.slice(split);
  const frac = head.reduce((n, i) => n + i.value, 0) / total;

  if (w >= h) {
    lbLayout(head, x, y, w * frac, h, out, depth);
    lbLayout(tail, x + w * frac, y, w * (1 - frac), h, out, depth);
  } else {
    lbLayout(head, x, y, w, h * frac, out, depth);
    lbLayout(tail, x, y + h * frac, w, h * (1 - frac), out, depth);
  }
}

// Children of a folder, plus whatever sits loose in it, as layout items.
function lbMapItems(node) {
  const items = node.children
    .filter((c) => c.size > 0)
    .map((c) => ({ value: c.size, node: c, label: c.name }))
    .sort((a, b) => b.value - a.value);

  if (node.ownSize > 0) {
    items.push({ value: node.ownSize, node: null, label: `${fmtNumber(node.ownFiles)} files here` });
  }
  return items.sort((a, b) => b.value - a.value);
}

function lbRenderTreemap() {
  const tree = lbTree();
  const node = tree.get(lbMapAt) || tree.get('');
  if (!node) {
    lb.treemap.innerHTML = '<div class="lb-empty">Scan a folder first.</div>';
    return;
  }

  const W = Math.max(320, lb.treemap.clientWidth || 900);
  const H = 520;
  const tiles = [];
  lbLayout(lbMapItems(node), 0, 0, W, H, tiles, 0);

  // One level of nesting inside each tile gives the map its texture — without
  // it a treemap is a bar chart with extra steps.
  const inner = [];
  for (const t of tiles) {
    if (!t.item.node || t.w < 40 || t.h < 40) continue;
    const kids = lbMapItems(t.item.node);
    if (kids.length < 2) continue;
    lbLayout(kids, t.x + 3, t.y + 3, t.w - 6, t.h - 6, inner, 1);
  }

  const esc2 = (s) => esc(String(s));
  const rects = tiles.map((t, i) => {
    const rel = t.item.node ? t.item.node.rel : '';
    const hue = 210 + ((i * 37) % 60);
    const label = t.w > 70 && t.h > 26
      ? `<text class="lb-map-label" x="${t.x + 7}" y="${t.y + 17}">${esc2(t.item.label)}</text>
         <text class="lb-map-sub" x="${t.x + 7}" y="${t.y + 32}">${esc2(lbBytes(t.item.value))}</text>`
      : '';
    return `<g class="lb-map-tile"${rel ? ` data-map="${esc2(rel)}"` : ''}>
      <title>${esc2(t.item.label)} — ${esc2(lbBytes(t.item.value))}</title>
      <rect x="${t.x}" y="${t.y}" width="${Math.max(0, t.w - 2)}" height="${Math.max(0, t.h - 2)}"
        fill="hsl(${hue} 45% 28%)" stroke="hsl(${hue} 45% 40%)" rx="4" />
      ${label}
    </g>`;
  }).join('');

  const nested = inner.map((t) => `<rect class="lb-map-inner" x="${t.x}" y="${t.y}"
    width="${Math.max(0, t.w - 1)}" height="${Math.max(0, t.h - 1)}" rx="2" />`).join('');

  // Breadcrumb, so drilling in is reversible.
  const crumbs = [''];
  if (node.rel) {
    const parts = node.rel.split(/[\\/]/);
    for (let i = 1; i <= parts.length; i++) crumbs.push(parts.slice(0, i).join('\\'));
  }
  const trail = crumbs.map((rel, i) => `<button class="lb-crumb${rel === node.rel ? ' active' : ''}"
      type="button" data-map="${esc2(rel)}">${esc2(rel ? rel.split(/[\\/]/).pop() : (lbRoot || 'root'))}</button>`)
    .join('<span class="lb-crumb-sep">›</span>');

  lb.treemap.innerHTML = `
    <div class="lb-map-head">
      <div class="lb-crumbs">${trail}</div>
      <span class="lb-map-total">${esc2(lbBytes(node.size))} · ${fmtNumber(node.files)} files</span>
    </div>
    <svg class="lb-map-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
      ${rects}${nested}
    </svg>
    <div class="lb-map-hint">Click a block to go into it. Blocks are sized by what they hold, including everything nested inside.</div>`;
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
    ['Reclaimable', lbBytes(lbReclaimable())],
  ];
  lb.stats.hidden = false;
  lb.stats.innerHTML = cells.map(([k, v]) =>
    `<div class="lb-stat"><span class="lb-stat-v">${esc(v)}</span><span class="lb-stat-k">${esc(k)}</span></div>`).join('');
}

function lbRenderFilters() {
  // Counts are for what each chip would leave given the OTHER chips already on,
  // so they say what clicking it does rather than what it would do alone.
  const others = (id) => [...lbFilters].filter((x) => x !== id)
    .map((x) => FILTER_BY_ID.get(x)).filter(Boolean);

  const countFor = (f) => {
    const rest = others(f.id);
    return lbFiles.filter((file) => f.test(file) && rest.every((x) => x.test(file))).length;
  };

  const groups = [];
  for (const f of FILTERS) {
    const last = groups[groups.length - 1];
    if (last && last.name === f.group) last.items.push(f);
    else groups.push({ name: f.group, items: [f] });
  }

  const allActive = lbFilters.size === 0;
  let html = `<div class="lb-filter-row">
    <span class="lb-filter-label">Show</span>
    <button class="lb-chip${allActive ? ' active' : ''}" type="button" data-filter="all">All <span class="lb-chip-n">${fmtNumber(lbFiles.length)}</span></button>
    ${lbFilters.size ? `<span class="lb-filter-note">${fmtNumber(lbVisible().length)} match all ${lbFilters.size} filter${lbFilters.size === 1 ? '' : 's'}</span>` : ''}
  </div>`;

  for (const g of groups) {
    const chips = g.items.map((f) => {
      const n = countFor(f);
      const on = lbFilters.has(f.id);
      if (!n && !on) return '';
      return `<button class="lb-chip${on ? ' active' : ''}" type="button" data-filter="${esc(f.id)}">${esc(f.label)} <span class="lb-chip-n">${fmtNumber(n)}</span></button>`;
    }).filter(Boolean).join('');
    if (!chips) continue;
    html += `<div class="lb-filter-row"><span class="lb-filter-label">${esc(g.name)}</span>${chips}</div>`;
  }

  lb.filters.innerHTML = html;
  lbSyncFiltersOpen();
}

// The label carries the state, because a collapsed panel that hides two active
// filters would make a short list look like a bug.
function lbSyncFiltersOpen() {
  lb.filters.hidden = !lbFiltersOpen;
  const on = lbFilters.size;
  lb.filtersToggle.textContent = lbFiltersOpen
    ? `Hide filters${on ? ` (${on} on)` : ''}`
    : `Filters${on ? ` · ${on} on` : ''}`;
  lb.filtersToggle.classList.toggle('has-filters', !lbFiltersOpen && on > 0);
}


function lbRowHtml(f, prev, next) {
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

  // Clicking the folder filters the list to it, which is the usual next move
  // after spotting a duplicate — you want to see what else lives there.
  const relDir = lbRelDir(f);
  const folder = relDir
    ? `<button class="lb-row-folder" type="button" data-folder="${esc(relDir)}"
        title="Show everything in ${esc(relDir)}">${esc(relDir)}</button><span class="lb-sep">·</span>`
    : '';

  // loading="lazy" is what makes this affordable on a library of thousands —
  // the browser only asks for the handful actually on screen, and each request
  // is what triggers the server to render that frame.
  const thumb = lbThumbs && (f.kind === 'video' || f.kind === 'image') && !f.unreadable
    ? `<img class="lb-thumb" loading="lazy" decoding="async" alt=""
         data-preview="${esc(f.path)}" title="Click to play · hover for a contact sheet"
         src="/api/library/thumb?path=${encodeURIComponent(f.path)}"
         onerror="this.classList.add('failed')" />`
    : '';

  // Only meaningful once the sets are actually adjacent, which is what the
  // "Duplicate sets" order guarantees.
  const grouped = lbSort === 'dupe' && dupe && lbIsDuplicate(dupe);
  const idOf = (x) => (x ? (lbDupes.get(x.path) || {}).groupId : undefined);
  const band = grouped && dupe.groupId % 2 === 0 ? ' band' : '';
  // Closing the gap between rows of one set makes it read as a single block
  // rather than as neighbours that happen to look alike.
  const joinUp = grouped && idOf(prev) === dupe.groupId ? ' set-cont' : '';
  const joinDown = grouped && idOf(next) === dupe.groupId ? ' set-open' : '';

  const ticked = lbSelected.has(f.path);

  return `<div class="lb-row${f.unreadable ? ' bad' : ''}${reason ? ' dupe' : ''}${band}${joinUp}${joinDown}${ticked ? ' picked' : ''}">
    <label class="lb-tick"><input type="checkbox" data-tick="${esc(f.path)}"${ticked ? ' checked' : ''} /></label>
    ${thumb}
    <div class="lb-row-main">
      <div class="lb-row-name" title="${esc(f.path)}">${esc(f.name)}</div>
      <div class="lb-row-meta">${folder}<span class="lb-row-facts">${bits.map(esc).join(' · ')}${
        reason ? ` · <span class="lb-dupe-why">${esc(reason)}</span>` : ''}</span></div>
    </div>
    <div class="lb-row-acts">
      <button class="lb-act" type="button" data-open="${esc(f.path)}" title="Open with the default app">Open</button>
      ${f.kind === 'video' || f.kind === 'audio' || f.kind === 'image'
        ? `<button class="lb-act" type="button" data-convert="${esc(f.path)}" title="Open in Converter">Convert</button>` : ''}
      <button class="lb-act" type="button" data-reveal="${esc(f.path)}" title="Show in Explorer">Reveal</button>
      <button class="lb-act lb-danger" type="button" data-delete="${esc(f.path)}"
        title="Move to the Recycle Bin">Delete</button>
    </div>
  </div>`;
}

function lbMoreHtml(shown, total) {
  if (shown >= total) {
    return `<div class="lb-empty">All ${fmtNumber(total)} shown.</div>`;
  }
  return `<div class="lb-more" id="lb-more">
    <button class="btn-ghost" type="button" data-more>Show ${fmtNumber(Math.min(RENDER_CHUNK, total - shown))} more</button>
    <span class="lb-more-note">${fmtNumber(shown)} of ${fmtNumber(total)}</span>
  </div>`;
}

// Loads the next chunk when the sentinel scrolls into view, so scrolling just
// keeps working. The button stays as the fallback and as a progress readout.
function lbWatchMore(total) {
  if (lbMoreObserver) { lbMoreObserver.disconnect(); lbMoreObserver = null; }
  const sentinel = lb.list.querySelector('#lb-more');
  if (!sentinel || typeof IntersectionObserver !== 'function') return;

  lbMoreObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && lbShown < total) lbShowMore();
  }, { rootMargin: '600px' });
  lbMoreObserver.observe(sentinel);
}

// Appends rather than re-rendering: replacing innerHTML on a list you are
// halfway down throws away the scroll position you were reading from.
// Rows need their neighbours to know whether they continue a set, and the
// neighbour of a chunk's first row lives in the previous chunk — so this always
// indexes into the whole list rather than into the slice.
function lbRowsHtml(rows, from, to) {
  let html = '';
  for (let i = from; i < to; i++) html += lbRowHtml(rows[i], rows[i - 1], rows[i + 1]);
  return html;
}

function lbShowMore() {
  const rows = lbVisible();
  const upto = Math.min(lbShown + RENDER_CHUNK, rows.length);
  if (upto <= lbShown) return;

  const sentinel = lb.list.querySelector('#lb-more');
  const html = lbRowsHtml(rows, lbShown, upto);
  const added = upto - lbShown;
  if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
  else lb.list.insertAdjacentHTML('beforeend', html);

  lbShown += added;
  const tail = lb.list.querySelector('#lb-more');
  if (tail) tail.outerHTML = lbMoreHtml(lbShown, rows.length);
  lbWatchMore(rows.length);
}

function lbRenderList() {
  const rows = lbVisible();
  if (!lbFiles.length) { lb.list.innerHTML = ''; return; }
  if (!rows.length) {
    lb.list.innerHTML = '<div class="lb-empty">Nothing matches that.</div>';
    return;
  }
  lbShown = Math.min(Math.max(RENDER_CHUNK, lbShown), rows.length);
  lb.list.innerHTML = lbRowsHtml(rows, 0, lbShown) + lbMoreHtml(lbShown, rows.length);
  lbWatchMore(rows.length);
}


// --- Bulk selection ----------------------------------------------------------
function lbRenderBulk() {
  if (!lbSelected.size) { lb.bulk.hidden = true; lb.bulk.innerHTML = ''; return; }

  const bytes = lbFiles.filter((f) => lbSelected.has(f.path)).reduce((n, f) => n + (f.size || 0), 0);
  lb.bulk.hidden = false;
  lb.bulk.innerHTML = `
    <span class="lb-bulk-count">${fmtNumber(lbSelected.size)} selected · ${esc(lbBytes(bytes))}</span>
    <button class="lb-act" type="button" data-bulk="convert">Convert these…</button>
    <button class="lb-act" type="button" data-bulk="all">Select all showing</button>
    <button class="lb-act" type="button" data-bulk="clear">Clear</button>`;
}

// Hands the selection to the Converter, the same way a single row does.
function lbConvertSelected() {
  const paths = lbFiles.filter((f) => lbSelected.has(f.path)).map((f) => f.path);
  if (!paths.length) return;
  try {
    sessionStorage.setItem('multitool:convert-batch', JSON.stringify(paths));
  } catch {
    lbShowError('Could not hand that many files over — try a smaller selection.');
    return;
  }
  location.hash = '#/convert';
}

// --- Preview -----------------------------------------------------------------
// Hovering a thumbnail shows a contact sheet: sixteen frames from across the
// whole file. One poster frame says almost nothing about a two-hour video, and
// almost nothing at all about a file named after its hash.
const SHEET_DELAY_MS = 350;

let lbSheetTimer = null;
let lbSheetFor = null;

function lbHideSheet() {
  clearTimeout(lbSheetTimer);
  lbSheetTimer = null;
  lbSheetFor = null;
  lb.sheet.hidden = true;
  lb.sheet.innerHTML = '';
}

function lbShowSheet(thumb, path) {
  if (lbSheetFor === path) return;
  lbSheetFor = path;

  lb.sheet.hidden = false;
  lb.sheet.innerHTML = '<div class="lb-sheet-wait">Building a contact sheet…</div>';

  // Positioned against the row rather than the pointer, so it does not skate
  // around while you move across the thumbnail.
  const box = thumb.getBoundingClientRect();
  const width = Math.min(560, window.innerWidth - 32);
  let left = box.right + 12;
  if (left + width > window.innerWidth - 16) left = Math.max(16, box.left - width - 12);
  lb.sheet.style.left = `${left}px`;
  lb.sheet.style.width = `${width}px`;
  // Clamped so a row near the bottom does not push it off screen.
  const top = Math.min(Math.max(12, box.top - 60), window.innerHeight - 380);
  lb.sheet.style.top = `${top}px`;

  const img = new Image();
  img.onload = () => {
    if (lbSheetFor !== path) return; // moved on while it was building
    lb.sheet.innerHTML = '';
    lb.sheet.appendChild(img);
  };
  img.onerror = () => {
    if (lbSheetFor !== path) return;
    lb.sheet.innerHTML = '<div class="lb-sheet-wait">No contact sheet for this one.</div>';
  };
  img.src = `/api/library/sheet?path=${encodeURIComponent(path)}`;
}

// Skips, in seconds. Back short and forward long is the shape you want for
// finding a moment: overshoot cheaply, creep back precisely.
const SEEK_BACK = 10;
const SEEK_FWD = 30;

// The file being previewed, its storyboard, and whether the timeline is being
// dragged. Held here rather than on the element because the player is rebuilt
// every time the modal opens.
let lbPlaying = null;
let lbBoard = null;
let lbBoardState = 'idle';   // idle | loading | ready | failed
let lbDragging = false;

const lbPlayer = () => document.querySelector('.lb-player');

function lbTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0')
    : m + ':' + String(r).padStart(2, '0');
}

// A frame is 1/fps of a second, so stepping needs the file's actual rate — a
// 24fps film and a 60fps capture are not the same nudge. The scan reads it;
// 25 is only the fallback for a file that would not say.
function lbFrameStep() {
  const fps = lbPlaying && lbPlaying.fps;
  return 1 / (fps && fps > 0 ? fps : 25);
}

function lbSeekTo(seconds) {
  const el = lbPlayer();
  if (!el || !Number.isFinite(el.duration)) return;
  el.currentTime = Math.max(0, Math.min(el.duration, seconds));
}

function lbSeekBy(seconds) {
  const el = lbPlayer();
  if (el) lbSeekTo(el.currentTime + seconds);
}

function lbStepFrames(direction) {
  const el = lbPlayer();
  if (!el) return;
  // Stepping while playing is immediately overwritten by the next decoded frame.
  el.pause();
  lbSeekTo(el.currentTime + direction * lbFrameStep());
}

function lbTogglePlay() {
  const el = lbPlayer();
  if (!el) return;
  if (el.paused) el.play().catch(() => {});
  else el.pause();
}

// Fullscreens the stage rather than the video, so the controls come along.
function lbToggleFullscreen() {
  const stage = $('lb-stage');
  if (!stage) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else stage.requestFullscreen().catch(() => {});
}

// --- Timeline ----------------------------------------------------------------
function lbSyncPlayer() {
  const el = lbPlayer();
  if (!el) return;

  const dur = Number.isFinite(el.duration) ? el.duration : 0;
  const pct = dur ? (el.currentTime / dur) * 100 : 0;

  const played = $('lb-played');
  if (played) played.style.width = pct + '%';

  const time = $('lb-time');
  if (time) time.textContent = lbTime(el.currentTime) + ' / ' + lbTime(dur);

  const play = $('lb-playpause');
  if (play) {
    play.textContent = el.paused ? '▶' : '⏸';
    play.title = (el.paused ? 'Play' : 'Pause') + ' (space)';
  }

  // Buffered is drawn from the range holding the playhead, which is the one
  // that means anything — a file seeked around in has several.
  const buf = $('lb-buffered');
  if (buf && dur) {
    let ahead = el.currentTime;
    for (let i = 0; i < el.buffered.length; i++) {
      if (el.buffered.start(i) <= el.currentTime && el.currentTime <= el.buffered.end(i)) {
        ahead = el.buffered.end(i);
        break;
      }
    }
    buf.style.width = Math.min(100, (ahead / dur) * 100) + '%';
  }
}

// Where along the timeline a pointer is, as a fraction.
function lbTimelineFraction(e) {
  const line = $('lb-timeline');
  if (!line) return 0;
  const box = line.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
}

// Puts the storyboard tile for a given time under the cursor. The sheet is one
// image; which frame shows is a background offset, so there is no request per
// hover.
function lbShowScrub(e) {
  const el = lbPlayer();
  const box = $('lb-scrub');
  if (!el || !box || !Number.isFinite(el.duration)) return;

  const frac = lbTimelineFraction(e);
  const at = frac * el.duration;

  const label = $('lb-scrub-t');
  if (label) label.textContent = lbTime(at);

  const img = $('lb-scrub-img');
  if (img && !lbBoard) {
    img.hidden = true;
    if (label) label.textContent = (lbBoardState === 'loading' ? '· · ·  ' : '') + lbTime(at);
  }
  if (img && lbBoard) {
    const i = Math.max(0, Math.min(lbBoard.count - 1, Math.floor(at / lbBoard.interval)));
    const col = i % lbBoard.cols;
    const row = Math.floor(i / lbBoard.cols);
    img.style.width = lbBoard.tileW + 'px';
    img.style.height = lbBoard.tileH + 'px';
    img.style.backgroundImage = 'url("' + lbBoard.src + '")';
    img.style.backgroundSize = (lbBoard.cols * lbBoard.tileW) + 'px ' + (lbBoard.rows * lbBoard.tileH) + 'px';
    img.style.backgroundPosition = '-' + (col * lbBoard.tileW) + 'px -' + (row * lbBoard.tileH) + 'px';
    img.hidden = false;
  }

  // Clamped to the stage so the preview never hangs off the edge.
  const stage = $('lb-stage');
  const line = $('lb-timeline');
  if (stage && line) {
    const sBox = stage.getBoundingClientRect();
    const lBox = line.getBoundingClientRect();
    const width = box.offsetWidth || (lbBoard ? lbBoard.tileW : 120);
    let left = (lBox.left - sBox.left) + frac * lBox.width - width / 2;
    left = Math.max(4, Math.min(sBox.width - width - 4, left));
    box.style.left = left + 'px';
    box.style.bottom = (sBox.bottom - lBox.top + 10) + 'px';
  }
  box.hidden = false;
}

function lbHideScrub() {
  const box = $('lb-scrub');
  if (box) box.hidden = true;
}

// Fetched once per preview, and only for video — the metadata comes back
// immediately, the image builds on first request and is cached after.
async function lbLoadBoard(path) {
  lbBoard = null;
  lbBoardState = 'loading';
  try {
    const res = await fetch('/api/library/board?path=' + encodeURIComponent(path));
    const json = await res.json();
    if (json.status !== 'ok') { lbBoardState = 'failed'; return; }

    // Fetch the sheet before announcing it. Setting background-image and
    // revealing the box in the same frame shows an empty rectangle until the
    // image lands, which is what "the preview does not work" looks like.
    const sheet = new Image();
    sheet.onload = () => {
      // Still the same file? The modal may have moved on while this loaded.
      if (!lbPlaying || lbPlaying.path !== path) return;
      lbBoard = json.data;
      lbBoardState = 'ready';
    };
    sheet.onerror = () => { lbBoardState = 'failed'; };
    sheet.src = json.data.src;
  } catch {
    lbBoardState = 'failed';
  }
}

// Handled at the document because the player is rebuilt each time the modal
// opens, and only while it is actually on screen.
function lbPlayerKeys(e) {
  if (!lbPlaying || !lbPlayer()) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

  const keys = {
    ArrowLeft: () => lbSeekBy(-SEEK_BACK),
    ArrowRight: () => lbSeekBy(SEEK_FWD),
    ',': () => lbStepFrames(-1),
    '.': () => lbStepFrames(1),
    ' ': lbTogglePlay,
    k: lbTogglePlay,
    j: () => lbSeekBy(-SEEK_BACK),
    l: () => lbSeekBy(SEEK_FWD),
    f: lbToggleFullscreen,
    m: () => { const el = lbPlayer(); if (el) el.muted = !el.muted; },
  };
  const act = keys[e.key] || keys[e.key.toLowerCase()];
  if (!act) return;
  // Space would scroll the list behind the modal; arrows would move the caret.
  e.preventDefault();
  act();
}

// Everything that has to be attached to the elements showModal just created.
function lbBindPlayer() {
  const el = lbPlayer();
  if (!el) return;

  for (const ev of ['timeupdate', 'play', 'pause', 'seeked', 'loadedmetadata', 'progress', 'durationchange']) {
    el.addEventListener(ev, lbSyncPlayer);
  }
  el.addEventListener('error', () => {
    const note = $('lb-preview-note');
    if (note) note.hidden = false;
  });

  const screen = $('lb-screen');
  if (screen) {
    screen.addEventListener('click', (e) => { if (e.target === el) lbTogglePlay(); });
    screen.addEventListener('dblclick', (e) => { if (e.target === el) lbToggleFullscreen(); });
  }

  const line = $('lb-timeline');
  if (line) {
    // Pointer events rather than mouse ones, so a drag that leaves the bar
    // keeps scrubbing until the button comes up.
    line.addEventListener('pointerdown', (e) => {
      lbDragging = true;
      line.setPointerCapture(e.pointerId);
      const dur = lbPlayer() ? lbPlayer().duration : 0;
      if (Number.isFinite(dur)) lbSeekTo(lbTimelineFraction(e) * dur);
      lbShowScrub(e);
    });
    line.addEventListener('pointermove', (e) => {
      lbShowScrub(e);
      if (!lbDragging) return;
      const dur = lbPlayer() ? lbPlayer().duration : 0;
      if (Number.isFinite(dur)) lbSeekTo(lbTimelineFraction(e) * dur);
    });
    line.addEventListener('pointerup', (e) => {
      lbDragging = false;
      try { line.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    });
    line.addEventListener('pointerleave', () => { if (!lbDragging) lbHideScrub(); });
  }

  const vol = $('lb-volume');
  if (vol) {
    vol.value = String(el.volume);
    vol.addEventListener('input', () => {
      el.volume = Number(vol.value);
      el.muted = el.volume === 0;
    });
  }

  lbSyncPlayer();
}

// Clicking a thumbnail plays the file in the shared modal. The server serves
// byte ranges, so seeking works without downloading the whole thing first.
function lbPreview(path) {
  const f = lbFiles.find((x) => x.path === path);
  if (!f) return;
  lbHideSheet();
  lbPlaying = f;
  lbBoard = null;

  const url = '/api/library/stream?path=' + encodeURIComponent(path);
  const isVideo = f.kind !== 'audio';

  // No "controls" attribute: the native set duplicates every button below it,
  // and its fullscreen takes the video alone. That duplication is the whole
  // reason for building a transport rather than decorating the browser's.
  const media = isVideo
    ? '<video class="lb-player" autoplay playsinline src="' + esc(url) + '"></video>'
    : '<audio class="lb-player" autoplay src="' + esc(url) + '"></audio>';

  const meta = [lbBytes(f.size), lbClock(f.duration), lbResLabel(f), f.vcodec]
    .filter(Boolean).join(' · ');

  // One wrapper. .modal-body is a flex row — built for the Media Library's
  // poster-beside-text card — so siblings become columns.
  showModal(
    '<div class="lb-preview">'
    + '<h2 class="lb-preview-title">' + esc(f.name) + '</h2>'
    + '<div class="lb-preview-meta">' + esc(meta) + '</div>'
    + '<div class="lb-stage" id="lb-stage">'
    + '<div class="lb-screen" id="lb-screen">'
    + media
    + '</div>'
    + '<div class="lb-scrub" id="lb-scrub" hidden>'
    + '<div class="lb-scrub-img" id="lb-scrub-img" hidden></div>'
    + '<span class="lb-scrub-t" id="lb-scrub-t"></span>'
    + '</div>'
    + '<div class="lb-timeline" id="lb-timeline" title="Click or drag to seek">'
    + '<div class="lb-track">'
    + '<div class="lb-buffered" id="lb-buffered"></div>'
    + '<div class="lb-played" id="lb-played"></div>'
    + '</div>'
    + '</div>'
    + '<div class="lb-transport">'
    + '<button class="lb-act lb-icon" type="button" id="lb-playpause" data-playpause title="Play (space)">▶</button>'
    + '<button class="lb-act" type="button" data-seek="' + (-SEEK_BACK) + '" title="Back ' + SEEK_BACK + 's (←)">−' + SEEK_BACK + 's</button>'
    + '<button class="lb-act" type="button" data-seek="' + SEEK_FWD + '" title="Forward ' + SEEK_FWD + 's (→)">+' + SEEK_FWD + 's</button>'
    + (isVideo
      ? '<button class="lb-act lb-icon" type="button" data-frame="-1" title="Previous frame (,)">◀|</button>'
        + '<button class="lb-act lb-icon" type="button" data-frame="1" title="Next frame (.)">|▶</button>'
      : '')
    + '<span class="lb-time" id="lb-time">0:00 / 0:00</span>'
    + '<input class="lb-volume" id="lb-volume" type="range" min="0" max="1" step="0.05" title="Volume (m to mute)" />'
    + (isVideo
      ? '<button class="lb-act lb-icon" type="button" data-fullscreen title="Fullscreen (f)">⛶</button>'
      : '')
    + '</div>'
    + '<div class="lb-keys">'
    + '<span><kbd>←</kbd> −' + SEEK_BACK + 's</span>'
    + '<span><kbd>→</kbd> +' + SEEK_FWD + 's</span>'
    + (isVideo
      ? '<span><kbd>,</kbd> <kbd>.</kbd> one frame'
        + (f.fps ? ' (' + f.fps + ' fps)' : ' (rate unknown — assuming 25)') + '</span>'
      : '')
    + '<span><kbd>space</kbd> play/pause</span>'
    + '<span><kbd>m</kbd> mute</span>'
    + (isVideo ? '<span><kbd>f</kbd> fullscreen</span>' : '')
    + '</div>'
    + '</div>'
    + '<div class="lb-preview-note" id="lb-preview-note" hidden>'
    + 'The browser will not play this one — Matroska and some codecs have no support in Chromium. '
    + '<button class="lb-act" type="button" data-open="' + esc(path) + '">Open it externally</button>'
    + '</div>'
    + '</div>',
  );

  lbBindPlayer();
  if (isVideo) lbLoadBoard(path);
}

// Deleted files stay listed until dismissed, so an accident is one click to
// undo rather than a trip through the Recycle Bin looking for the right name.
function lbRenderTrash() {
  if (!lbTrash.length) { lb.trash.hidden = true; lb.trash.innerHTML = ''; return; }
  lb.trash.hidden = false;

  const rows = [...lbTrash].reverse().slice(0, 20).map((f) => `
    <div class="lb-trash-row">
      <span class="lb-trash-name" title="${esc(f.path)}">${esc(f.name)}</span>
      <span class="lb-trash-meta">${esc(lbBytes(f.size))}</span>
      <button class="lb-act" type="button" data-restore="${esc(f.path)}">Restore</button>
    </div>`).join('');

  lb.trash.innerHTML = `
    <div class="lb-trash-head">
      <span>${fmtNumber(lbTrash.length)} file${lbTrash.length === 1 ? '' : 's'} moved to the Recycle Bin${
        lbTrash.length > 20 ? ' — showing the last 20' : ''}</span>
      <button class="lb-act" type="button" data-trash-dismiss>Dismiss</button>
    </div>
    ${rows}`;
}

async function lbRestore(path) {
  try {
    const res = await fetch(`/api/library/restore?path=${encodeURIComponent(path)}`, { method: 'POST' });
    const json = await res.json();
    if (json.status !== 'ok') { lbShowError(json.status_message || 'Could not restore that file.'); return; }
    lbClearError();
    await lbLoadIndex();
  } catch {
    lbShowError('Could not reach the server.');
  }
}

async function lbDismissTrash() {
  try {
    await fetch('/api/library/trash', { method: 'POST' });
    lbTrash = [];
    lbRenderTrash();
  } catch { /* ignore */ }
}

function lbRenderAll() {
  lbDupes = lbDuplicates(lbFiles);
  const empty = lbFiles.length === 0 && lbFolders.length === 0;
  lb.views.hidden = empty;
  lb.blank.hidden = !empty;
  lbRenderTrash();
  lbRenderBulk();
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
      lbTrash = json.data.trash || [];
      lbRoot = json.data.root;
      // The server index outranks whatever was remembered locally, and its root
      // is worth adding to the recents so the chip is there next time.
      if (lbRoot) { lb.root.value = lbRoot; lbRememberRoot(lbRoot); }
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
    lbRememberRoot(root);
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

// Two-step rather than a dialog: the second click within a few seconds is the
// confirmation. Deleting duplicates means working down a list, and a modal per
// row would make that miserable — but an unguarded button sitting next to a
// heuristic would be worse.
let lbArmed = null;
let lbArmTimer = null;

function lbDisarm() {
  clearTimeout(lbArmTimer);
  lbArmed = null;
  lb.list.querySelectorAll('[data-delete].armed').forEach((b) => {
    b.classList.remove('armed');
    b.textContent = 'Delete';
  });
}

function lbArmDelete(btn, path) {
  lbDisarm();
  lbArmed = path;
  btn.classList.add('armed');
  btn.textContent = 'Delete?';
  lbArmTimer = setTimeout(lbDisarm, 4000);
}

async function lbDelete(path) {
  lbDisarm();
  try {
    const res = await fetch(`/api/library/delete?path=${encodeURIComponent(path)}`, { method: 'POST' });
    const json = await res.json();
    if (json.status !== 'ok') {
      lbShowError(json.status_message || 'Could not delete that file.');
      return;
    }
    lbClearError();
    // The server has already dropped it from its index and adjusted the folder
    // totals, so refetching is both correct and cheaper than mirroring it here.
    await lbLoadIndex();
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
    lbShown = RENDER_CHUNK;
    lbRenderFilters();
    lbRenderList();
  }, 120));

  lb.sort.addEventListener('change', () => {
    lbSort = lb.sort.value;
    lbSortAuto = null; // an explicit choice stands until the next explicit one
    lbShown = RENDER_CHUNK;
    lbRenderList();
  });

  lb.images.addEventListener('change', () => { lbImages = lb.images.checked; lbSavePrefs(); });

  lb.filtersToggle.addEventListener('click', () => {
    lbFiltersOpen = !lbFiltersOpen;
    lbSavePrefs();
    lbSyncFiltersOpen();
  });

  lb.thumbs.addEventListener('change', () => {
    lbThumbs = lb.thumbs.checked;
    lbSavePrefs();
    lbRenderList();
  });

  lb.recent.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-recent]');
    if (!chip) return;
    lb.root.value = chip.dataset.recent;
    lbStartScan();
  });

  lb.trash.addEventListener('click', (e) => {
    if (e.target.closest('[data-trash-dismiss]')) { lbDismissTrash(); return; }
    const restore = e.target.closest('[data-restore]');
    if (restore) lbRestore(restore.dataset.restore);
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

  lb.bulk.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn) return;
    if (btn.dataset.bulk === 'clear') { lbSelected.clear(); lbRenderBulk(); lbRenderList(); return; }
    if (btn.dataset.bulk === 'all') {
      // Everything the current filters and search leave, not just the rows
      // rendered so far — the chunked list would otherwise select an arbitrary
      // prefix of what you are looking at.
      for (const f of lbVisible()) lbSelected.add(f.path);
      lbRenderBulk();
      lbRenderList();
      return;
    }
    if (btn.dataset.bulk === 'convert') lbConvertSelected();
  });

  lb.treemap.addEventListener('click', (e) => {
    const tile = e.target.closest('[data-map]');
    if (!tile) return;
    lbMapAt = tile.dataset.map;
    lbRenderTreemap();
  });
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
    lbFilters.clear();
    lbShown = RENDER_CHUNK;
    lbRenderFilters();
    lbShowView('files');
  });

  lb.filters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    const id = chip.dataset.filter;
    if (id === 'all') lbFilters.clear();
    else if (lbFilters.has(id)) lbFilters.delete(id);
    else lbFilters.add(id);
    lbSyncDupeSort();
    lbShown = RENDER_CHUNK;
    lbRenderFilters();
    lbRenderList();
  });

  // Delegated, because rows come and go as chunks load.
  lb.list.addEventListener('mouseover', (e) => {
    const thumb = e.target.closest('[data-preview]');
    if (!thumb) return;
    const path = thumb.dataset.preview;
    if (lbSheetFor === path) return;
    clearTimeout(lbSheetTimer);
    lbSheetTimer = setTimeout(() => lbShowSheet(thumb, path), SHEET_DELAY_MS);
  });

  lb.list.addEventListener('mouseout', (e) => {
    const thumb = e.target.closest('[data-preview]');
    if (!thumb) return;
    // Leaving for the sheet itself should not dismiss it.
    if (e.relatedTarget && lb.sheet.contains(e.relatedTarget)) return;
    lbHideSheet();
  });

  // Scrolling would leave it pinned to a row that has moved.
  lb.list.addEventListener('wheel', lbHideSheet, { passive: true });
  window.addEventListener('scroll', lbHideSheet, { passive: true });

  // The modal's own buttons: the Open fallback and the transport.
  document.addEventListener('click', (e) => {
    const modalOpen = e.target.closest('#modal-body [data-open]');
    if (modalOpen) { lbOpen(modalOpen.dataset.open); closeModal(); return; }

    const seek = e.target.closest('#modal-body [data-seek]');
    if (seek) { lbSeekBy(Number(seek.dataset.seek)); return; }

    const frame = e.target.closest('#modal-body [data-frame]');
    if (frame) { lbStepFrames(Number(frame.dataset.frame)); return; }

    if (e.target.closest('#modal-body [data-playpause]')) { lbTogglePlay(); return; }
    if (e.target.closest('#modal-body [data-fullscreen]')) lbToggleFullscreen();
  });

  document.addEventListener('keydown', lbPlayerKeys);

  // Closing the modal ends playback, so stop answering for a player that has
  // gone — otherwise the keys keep firing against a detached element.
  $('modal').addEventListener('click', (e) => {
    if (!e.target.closest('[data-close]')) return;
    lbPlaying = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  });
  document.addEventListener('keydown', (e) => {
    // The browser handles Escape out of fullscreen itself; the preview should
    // survive that and only close on a second press.
    if (e.key === 'Escape' && !document.fullscreenElement) lbPlaying = null;
  });

  lb.list.addEventListener('click', (e) => {
    const tick = e.target.closest('[data-tick]');
    if (tick) {
      const path = tick.dataset.tick;
      if (tick.checked) lbSelected.add(path);
      else lbSelected.delete(path);
      tick.closest('.lb-row').classList.toggle('picked', tick.checked);
      lbRenderBulk();
      return;
    }

    const preview = e.target.closest('[data-preview]');
    if (preview) { lbPreview(preview.dataset.preview); return; }

    if (e.target.closest('[data-more]')) { lbShowMore(); return; }

    const del = e.target.closest('[data-delete]');
    if (del) {
      const path = del.dataset.delete;
      if (lbArmed === path) lbDelete(path);
      else lbArmDelete(del, path);
      return;
    }
    // Any other click in the list cancels a pending confirmation.
    if (lbArmed) lbDisarm();

    const folder = e.target.closest('[data-folder]');
    if (folder) {
      lb.search.value = folder.dataset.folder;
      lbQuery = folder.dataset.folder;
      lbRenderList();
      return;
    }
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
    lbRenderRecent();
    if (lbRecent.length) lb.root.value = lbRecent[0];
    bindLibrary();
    lbLoadIndex();
    lbConnect();
  },
  show() {
    lb.search?.focus();
  },
};
