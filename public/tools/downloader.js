// Downloader — yt-dlp, driven from the browser.
//
// The server owns the yt-dlp process; this side probes a URL, starts a job, and
// renders whatever the /api/dl/events stream reports back.

import { $, esc, debounce, fmtNumber } from '../lib/dom.js';
import { idleStream } from '../lib/stream.js';

const TEMPLATE = `
  <div class="tool-head">
    <h1 class="tool-title"><span class="tool-title-icon">⬇️</span> Downloader</h1>
    <p class="tool-sub">Paste any URL yt-dlp supports and pull it at the highest quality available.</p>
  </div>

  <div id="dl-tools" class="dl-notice" hidden></div>

  <form id="dl-form" class="dl-bar">
    <input id="dl-url" type="url" placeholder="Paste a video URL…" autocomplete="off" spellcheck="false" />
    <label class="dl-cookies" title="Borrow the login session from a browser you are already signed in with. Needed for anything that only loads when logged in — Instagram stories among them.">
      <span>Signed in via</span>
      <select id="dl-cookies">
        <option value="">Nothing</option>
        <option value="session">This app's own sign-in</option>
        <option value="chrome">Chrome</option>
        <option value="edge">Edge</option>
        <option value="firefox">Firefox</option>
        <option value="brave">Brave</option>
        <option value="opera">Opera</option>
        <option value="vivaldi">Vivaldi</option>
        <option value="file">A cookies.txt file…</option>
      </select>
    </label>
    <input id="dl-cookie-file" class="dl-cookie-file" type="text" hidden
      placeholder="C:\\Users\\you\\cookies.txt" autocomplete="off" spellcheck="false"
      title="A Netscape-format cookies.txt exported from your browser" />
    <button id="dl-fetch" class="btn btn-primary" type="submit">Fetch</button>
  </form>

  <div id="dl-ig" class="dl-ig" hidden></div>
  <div id="dl-error" class="dl-notice error" hidden></div>
  <div id="dl-probe" class="dl-probe" hidden></div>

  <div class="dl-jobs-head">
    <h2 id="dl-jobs-title" class="dl-h2" hidden>Downloads</h2>
    <span id="dl-save-dir" class="dl-save-dir" hidden></span>
    <button id="dl-open-folder" class="btn-ghost" type="button" hidden>Open folder</button>
    <button id="dl-clear" class="btn-ghost" type="button" hidden>Clear history</button>
  </div>
  <div id="dl-jobs" class="dl-jobs"></div>`;

const dl = {};
function cacheEls() {
  Object.assign(dl, {
  form: $('dl-form'),
  url: $('dl-url'),
  cookies: $('dl-cookies'),
  cookieFile: $('dl-cookie-file'),
  ig: $('dl-ig'),
  fetchBtn: $('dl-fetch'),
  tools: $('dl-tools'),
  error: $('dl-error'),
  probe: $('dl-probe'),
  jobs: $('dl-jobs'),
  jobsTitle: $('dl-jobs-title'),
  openFolder: $('dl-open-folder'),
  clear: $('dl-clear'),
  saveDir: $('dl-save-dir'),
});
}

let dlTools = null;              // { ytdlp, ffmpeg, dir, platform, canSaveAs }
let dlInfo = null;               // last successful probe
let dlStream = null;             // EventSource
let dlPreferMp4 = false;
const dlJobs = new Map();

const DL_LIVE = new Set(['picking', 'starting', 'downloading', 'merging']);

function dlBytes(n) {
  if (!n || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function dlClock(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

function dlShowError(msg) {
  dl.error.hidden = false;
  dl.error.innerHTML = esc(msg);
}

function dlClearError() {
  dl.error.hidden = true;
  dl.error.textContent = '';
}

// --- Tooling ---
async function dlLoadTools(refresh) {
  try {
    const res = await fetch(`/api/dl/tools${refresh ? '?refresh=1' : ''}`);
    const json = await res.json();
    if (json.status === 'ok') dlTools = json.data;
  } catch { /* leave the previous reading in place */ }
  dlRenderTools();
  dlRenderSaveDir();
}

function dlRenderTools() {
  if (!dlTools) { dl.tools.hidden = true; return; }
  const win = dlTools.platform === 'win32';
  let body = '';

  if (!dlTools.ytdlp.found) {
    body = `<strong>yt-dlp isn't installed.</strong> ${win
      ? 'Run <code>winget install yt-dlp.yt-dlp</code> (or <code>scoop install yt-dlp</code>), or drop <code>yt-dlp.exe</code> into a <code>bin\\</code> folder next to the server.'
      : 'Install it with <code>brew install yt-dlp</code> or <code>pipx install yt-dlp</code>.'}`;
  } else if (!dlTools.ffmpeg.found) {
    body = `<strong>ffmpeg isn't installed</strong>, so downloads are capped at 720p — anything higher arrives as
      separate video and audio streams that need merging. ${win
      ? 'Run <code>winget install Gyan.FFmpeg</code>'
      : 'Install it with <code>brew install ffmpeg</code>'} and re-check.`;
  } else if (dlTools.deno && !dlTools.deno.found) {
    // Not fatal, but it quietly costs you the formats this app exists to get.
    body = `<strong>No JavaScript runtime found.</strong> YouTube extraction without one is deprecated and
      <em>some formats may be missing</em> — including, sometimes, the highest one. Run
      <code>npm run get-tools</code> to add Deno, then re-check.`;
  }

  if (!body) { dl.tools.hidden = true; return; }
  dl.tools.hidden = false;
  dl.tools.className = `dl-notice ${dlTools.ytdlp.found ? 'warn' : 'error'}`;
  dl.tools.innerHTML = `${body} <button class="link-inline" type="button" data-dl-recheck>Re-check</button>`;
}

// --- Probe ---
async function dlDoProbe(e) {
  if (e) e.preventDefault();
  const url = dl.url.value.trim();
  if (!url) return;

  dlClearError();
  dl.probe.hidden = true;
  dl.fetchBtn.disabled = true;
  dl.fetchBtn.textContent = 'Reading…';

  try {
    if (dlIg && dlIg.fetchUrl && dlIg.fetchUrl !== url) url = dlIg.fetchUrl;
    const cookies = dlCookieChoice();
    const file = dlCookieFile();
    const res = await fetch(`/api/dl/probe?url=${encodeURIComponent(url)}${
      cookies ? `&cookies=${encodeURIComponent(cookies)}` : ''}${
      cookies === 'file' && file ? `&cookieFile=${encodeURIComponent(file)}` : ''}`);
    const json = await res.json();
    if (json.status !== 'ok') {
      dlShowError(json.status_message || 'Could not read that URL.');
      if (json.missing) dlLoadTools(true);
      return;
    }
    dlInfo = json.data;
    dlRenderProbe();
  } catch {
    dlShowError('Could not reach the server.');
  } finally {
    dl.fetchBtn.disabled = false;
    dl.fetchBtn.textContent = 'Fetch';
  }
}

function dlQualityRow(label, note, attrs, primary) {
  return `<button class="dl-q${primary ? ' primary' : ''}" type="button" ${attrs}>
    <span class="dl-q-label">${esc(label)}</span>
    <span class="dl-q-note">${esc(note || '')}</span>
    <span class="dl-q-go">Download</span>
  </button>`;
}

// The thumbnail row carries two actions, so it's a div with real buttons rather
// than one big button (which can't legally nest them).
function dlThumbRow(t) {
  const dims = t.width && t.height ? `${fmtNumber(t.width)}×${fmtNumber(t.height)}` : '';
  const note = [dims, t.ext].filter(Boolean).join(' · ');
  return `<div class="dl-q dl-q-multi">
    <span class="dl-q-label">Thumbnail</span>
    <span class="dl-q-note">${esc(note)}</span>
    <span class="dl-q-acts">
      <button class="dl-q-act" type="button" data-dl-thumb-view>View</button>
      <button class="dl-q-act primary" type="button" data-dl-thumb-get>Download</button>
    </span>
  </div>`;
}

function dlRenderProbe() {
  const d = dlInfo;
  if (!d) return;
  const noFfmpeg = dlTools && !dlTools.ffmpeg.found;

  const meta = [
    d.uploader,
    d.duration ? dlClock(d.duration) : null,
    d.extractor,
    d.isPlaylist ? `${fmtNumber(d.entryCount)} items` : null,
  ].filter(Boolean).map(esc).join(' · ');

  let rows;
  if (d.isPlaylist) {
    rows = dlQualityRow(
      `Download all ${fmtNumber(d.entryCount)} items`,
      'Best quality available for each',
      'data-dl-go data-playlist="1"', true
    );
  } else {
    // "Best" first, then one row per resolution, then audio.
    rows = dlQualityRow('Best available', 'Highest resolution + best audio', 'data-dl-go', true);
    rows += (d.rows || []).map((r) => {
      const blocked = noFfmpeg && r.needsMerge;
      const note = blocked ? `${r.note} — needs ffmpeg` : r.note;
      return dlQualityRow(r.label, note,
        `data-dl-go data-height="${r.height}"${blocked ? ' disabled' : ''}`);
    }).join('');
    if (d.audio) rows += dlQualityRow(d.audio.label, d.audio.note, 'data-dl-go data-audio="1"');
  }
  if (d.thumbBest) rows += dlThumbRow(d.thumbBest);

  dl.probe.hidden = false;
  dl.probe.innerHTML = `
    <div class="dl-card">
      ${d.thumbnail ? `<div class="dl-thumb"><img src="${esc(d.thumbnail)}" alt="" loading="lazy" /></div>` : ''}
      <div class="dl-card-main">
        <h2 class="dl-card-title">${esc(d.title)}</h2>
        ${meta ? `<div class="dl-card-meta">${meta}</div>` : ''}
        <label class="dl-check">
          <input type="checkbox" id="dl-mp4" ${dlPreferMp4 ? 'checked' : ''} />
          <span>Prefer MP4 (more compatible; MKV keeps the best streams untouched)</span>
        </label>
        <div class="dl-qualities">${rows}</div>
      </div>
    </div>`;

  const mp4 = $('dl-mp4');
  if (mp4) mp4.addEventListener('change', () => { dlPreferMp4 = mp4.checked; dlSavePrefs(); });
}

// The container preference is worth keeping across refreshes.
// --- Instagram ---
// Instagram answers almost nothing to a signed-out request, so a link to it
// gets its own strip: what the link is, whether there is a session, and the
// one action that link supports.
let dlIg = null;
// Whether a sign-in window is open and waiting to be confirmed.
let dlIgWaiting = false;

async function dlInspect(raw) {
  // The card below belongs to whatever was fetched last. Once the box holds a
  // different link it is stale, and leaving it there reads as though that is
  // what was found — a YouTube video sitting under an Instagram link.
  if (dlInfo && dlInfo.url !== raw) {
    dl.probe.hidden = true;
    dlInfo = null;
  }
  dlIgItems = null;
  if (!raw) { dl.ig.hidden = true; dlIg = null; return; }
  try {
    const res = await fetch(`/api/dl/inspect?url=${encodeURIComponent(raw)}`);
    const json = await res.json();
    dlIg = json.status === 'ok' && json.data.instagram ? json.data : null;
  } catch {
    dlIg = null;
  }
  dlRenderIg();
}

function dlRenderIg() {
  if (!dlIg) { dl.ig.hidden = true; return; }
  const ig = dlIg.instagram;

  const what = {
    post: 'A post — the photo, video or album behind this link.',
    story: 'A single story.',
    profile: `An account. Its current stories are what can be fetched — Instagram does not let this pull an account's whole history.`,
    home: 'The Instagram home page, which is not something to fetch.',
    unsupported: 'This part of Instagram is not something this can fetch.',
  }[ig.kind] || '';

  const canFetch = ig.kind === 'post' || ig.kind === 'story' || ig.kind === 'profile';

  dl.ig.hidden = false;
  // Rendered from state rather than appended to. Appending meant every click
  // of Sign in stacked another "I have signed in" row on top of the last.
  dl.ig.innerHTML = `
    <div class="dl-ig-row">
      <span class="dl-ig-tag">Instagram</span>
      <span class="dl-ig-what">${esc(what)}</span>
    </div>
    ${canFetch && !dlIgWaiting ? `<div class="dl-ig-row">
      ${dlIg.signedIn
    // "A session is saved", not "signed in": all the server can see is that a
    // cookie store exists, and merely opening the login page creates one.
    // Whether the login took is something only the fetch can prove.
    ? `<span class="dl-ig-ok">A session is saved — this link will use it.</span>
         <button class="btn-ghost" type="button" data-ig-signin>Sign in again</button>`
    : `<span class="dl-ig-warn">No session saved. Instagram will refuse this without one.</span>
         <button class="btn btn-primary" type="button" data-ig-signin>Sign in to Instagram</button>`}
    </div>` : ''}
    ${canFetch && dlIg.signedIn && !dlIgWaiting ? `<div class="dl-ig-row">
      <button class="btn btn-primary" type="button" data-ig-media>${
    ig.kind === 'profile' ? 'Find stories' : 'Find photos and video'}</button>
      <span class="dl-ig-what">Instagram's own API — the only way to reach photos and albums.</span>
    </div>` : ''}
    <div id="dl-ig-media"></div>
    ${dlIgWaiting ? `<div class="dl-ig-row dl-ig-waiting">
      <span>A separate Instagram window is open — sign in there, then come back.
        It has to be its own window: Windows locks a running browser's cookies,
        so this one gets closed to read them.</span>
      <button class="btn-ghost" type="button" data-ig-done>Close it for me</button>
    </div>` : ''}`;
}

// What Instagram's API said is behind the link. yt-dlp is left to the videos,
// where its quality options are worth having; everything else comes from here,
// because yt-dlp simply refuses it.
let dlIgItems = null;

async function dlIgFindMedia(btn) {
  btn.disabled = true;
  btn.textContent = 'Asking Instagram…';
  try {
    const res = await fetch(`/api/dl/ig/media?url=${encodeURIComponent(dl.url.value.trim())}`);
    const json = await res.json();
    if (json.status !== 'ok') {
      dlIgItems = null;
      dlRenderIgMedia();
      return dlShowError(json.status_message || 'Instagram would not answer.');
    }
    dlClearError();
    dlIgItems = json.data;
    dlRenderIgMedia();
  } catch {
    dlShowError('Could not reach the server.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find photos and video';
  }
}

function dlRenderIgMedia() {
  const box = document.getElementById('dl-ig-media');
  if (!box) return;
  if (!dlIgItems) { box.innerHTML = ''; return; }

  const d = dlIgItems;
  const rows = d.items.map((it) => `
    <div class="dl-ig-item">
      <span class="dl-ig-item-n">${it.index + 1}</span>
      <span class="dl-ig-item-kind">${esc(it.kind)}</span>
      <span class="dl-ig-item-dim">${it.width && it.height ? `${fmtNumber(it.width)}×${fmtNumber(it.height)}` : ''}</span>
      <button class="btn-ghost" type="button" data-ig-get="${it.index}">Download</button>
    </div>`).join('');

  box.innerHTML = `
    <div class="dl-ig-media">
      <div class="dl-ig-row">
        <strong>${esc(d.owner || 'instagram')}</strong>
        <span class="dl-ig-what">${d.items.length} ${d.kind === 'stories' ? 'story item' : 'item'}${
  d.items.length === 1 ? '' : 's'}${d.caption ? ` — ${esc(d.caption.slice(0, 60))}` : ''}</span>
        ${d.items.length > 1 ? '<button class="btn btn-primary" type="button" data-ig-get="all">Download all</button>' : ''}
      </div>
      ${rows}
    </div>`;
}

// Saved through the ordinary job list, so these land beside every other
// download with the same progress and history.
async function dlIgDownload(which) {
  if (!dlIgItems) return;
  const items = which === 'all' ? dlIgItems.items
    : dlIgItems.items.filter((i) => String(i.index) === String(which));
  if (!items.length) return;

  try {
    const res = await fetch('/api/dl/ig/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items,
        owner: dlIgItems.owner,
        label: dlIgItems.caption ? dlIgItems.caption.slice(0, 60) : dlIgItems.owner,
      }),
    });
    const json = await res.json();
    if (json.status !== 'ok') return dlShowError(json.status_message || 'Could not start that download.');
    dlClearError();
  } catch {
    dlShowError('Could not reach the server.');
  }
}

// Opens a browser window on the app's own profile. Signing in there leaves the
// session in that profile; closing it is what makes the cookies readable.
async function dlIgSignIn(btn) {
  btn.disabled = true;
  btn.textContent = 'Opening…';
  try {
    const res = await fetch('/api/dl/session/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: 'instagram' }),
    });
    const json = await res.json();
    if (json.status !== 'ok') return dlShowError(json.status_message || 'Could not open a browser.');

    dlIgWaiting = true;
    dlRenderIg();
    dlWatchSession();
  } catch {
    dlShowError('Could not reach the server.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in to Instagram';
  }
}

// Closing the window is the signal, because it is the only one available:
// while the browser runs it holds the cookie store and nothing can read it.
// The moment it lets go, the session becomes both readable and usable — so
// closing the window and being able to check it are the same event.
//
// Which means the button is a fallback, not the mechanism. Sign in, close the
// window the way you would any other, and this notices.
let dlSessionWatch = null;

function dlStopWatching() {
  clearInterval(dlSessionWatch);
  dlSessionWatch = null;
}

function dlWatchSession() {
  dlStopWatching();
  const started = Date.now();

  dlSessionWatch = setInterval(async () => {
    // Five minutes is long enough for a login with two-factor and a password
    // manager; past that, something else is going on.
    if (Date.now() - started > 300000) return dlStopWatching();

    let d;
    try {
      const res = await fetch('/api/dl/session');
      const json = await res.json();
      if (json.status !== 'ok') return;
      d = json.data;
    } catch {
      return;
    }

    // Still up, or shut but unreadable: nothing to conclude yet.
    if (d.windowOpen || !d.known) return;

    dlStopWatching();
    dlIgWaiting = false;

    if (d.signedIn) {
      if (dl.cookies) { dl.cookies.value = 'session'; dlSyncCookieUi(); dlSavePrefs(); }
    } else {
      dlShowError('That window closed without a signed-in session. Sign in fully, then close it.');
    }
    await dlInspect(dl.url.value.trim());
  }, 1500);
}

// The close is the point: a running browser keeps its cookie store locked.
async function dlIgDone(btn) {
  btn.disabled = true;
  btn.textContent = 'Closing the window…';
  try {
    const res = await fetch('/api/dl/session/close', { method: 'POST' });
    const json = await res.json();
    if (json.status === 'ok' && json.data.signedIn) {
      if (dl.cookies) { dl.cookies.value = 'session'; dlSyncCookieUi(); dlSavePrefs(); }
    } else {
      dlShowError('No session was saved. Sign in fully, then try again.');
    }
  } catch {
    dlShowError('Could not reach the server.');
  } finally {
    // Cleared whatever happened: the window is gone either way, so a row that
    // still says one is open would be lying.
    dlStopWatching();
    dlIgWaiting = false;
    await dlInspect(dl.url.value.trim());
  }
}

// Typing a URL is a stream of keystrokes; only the pause at the end is a
// question worth asking the server.
let dlInspectTimer = null;
function dlDebouncedInspect() {
  clearTimeout(dlInspectTimer);
  const raw = dl.url.value.trim();
  dlInspectTimer = setTimeout(() => dlInspect(raw), 300);
}

const dlCookieChoice = () => (dl.cookies ? dl.cookies.value : '');
const dlCookieFile = () => (dl.cookieFile ? dl.cookieFile.value.trim() : '');

// The path box only means anything for the file option.
function dlSyncCookieUi() {
  if (!dl.cookieFile) return;
  dl.cookieFile.hidden = dlCookieChoice() !== 'file';
}

const DL_PREFS_KEY = 'multitool:downloader-prefs';

function dlSavePrefs() {
  try {
    localStorage.setItem(DL_PREFS_KEY, JSON.stringify({
      preferMp4: dlPreferMp4,
      cookies: dlCookieChoice(),
      cookieFile: dlCookieFile(),
    }));
  } catch { /* ignore quota */ }
}

function dlLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DL_PREFS_KEY));
    if (!saved) return;
    if (typeof saved.preferMp4 === 'boolean') dlPreferMp4 = saved.preferMp4;
    // Only restore a value the select actually offers, so a stale pref cannot
    // leave it showing a browser that is no longer listed.
    if (dl.cookies && typeof saved.cookies === 'string'
      && [...dl.cookies.options].some((o) => o.value === saved.cookies)) {
      dl.cookies.value = saved.cookies;
    }
    if (dl.cookieFile && typeof saved.cookieFile === 'string') {
      dl.cookieFile.value = saved.cookieFile;
    }
    dlSyncCookieUi();
  } catch { /* keep the defaults */ }
}

// --- Jobs ---
// `from` is whatever describes this download: the current probe for a fresh
// one, or the job being replayed for a retry.
async function dlStart(opts, from) {
  const src = from || dlInfo;
  dlClearError();
  try {
    const res = await fetch('/api/dl/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: src ? src.url : dl.url.value.trim(),
        title: src ? src.title : null,
        thumbnail: src ? src.thumbnail : null,
        preferMp4: dlPreferMp4,
        cookies: dlCookieChoice(),
        cookieFile: dlCookieFile(),
        ...opts,
      }),
    });
    const json = await res.json();
    if (json.status !== 'ok') {
      dlShowError(json.status_message || 'Could not start the download.');
      if (json.missing) dlLoadTools(true);
      return;
    }
    dlJobs.set(json.data.id, json.data);
    dlRenderJobs();
  } catch {
    dlShowError('Could not reach the server.');
  }
}

async function dlCancel(id) {
  try { await fetch(`/api/dl/cancel?job=${encodeURIComponent(id)}`, { method: 'POST' }); } catch { /* ignore */ }
}

// Runs a failed or cancelled job again with the exact options it started with.
// The server retires the old entry as the new one takes its place.
function dlRetry(id) {
  const job = dlJobs.get(id);
  if (!job) return;
  // History written before jobs recorded their options falls back to "best
  // available", which is what the probe's own default row does.
  dlStart({ ...(job.opts || {}), retryOf: job.id }, job);
}

// Drops the row and nothing else — the downloaded file stays where it is.
async function dlForget(id) {
  try {
    await fetch(`/api/dl/forget?job=${encodeURIComponent(id)}`, { method: 'POST' });
  } catch { /* the row stays; the event stream will correct it if it went */ }
}

// Two-step, because there is no undo for a list you have thrown away — even
// though the files themselves are untouched.
let dlClearArmed = false;
let dlClearTimer = null;

function dlDisarmClear() {
  clearTimeout(dlClearTimer);
  dlClearArmed = false;
  dl.clear.textContent = 'Clear history';
  dl.clear.classList.remove('armed');
}

async function dlClearHistory() {
  if (!dlClearArmed) {
    dlClearArmed = true;
    dl.clear.textContent = 'Clear all? Files stay';
    dl.clear.classList.add('armed');
    dlClearTimer = setTimeout(dlDisarmClear, 4000);
    return;
  }
  dlDisarmClear();
  try {
    await fetch('/api/dl/clear', { method: 'POST' });
  } catch { /* ignore */ }
}

async function dlReveal(id) {
  const qs = id ? `?job=${encodeURIComponent(id)}` : '';
  try { await fetch(`/api/dl/reveal${qs}`, { method: 'POST' }); } catch { /* ignore */ }
}

function dlJobState(j) {
  if (j.status === 'downloading') {
    const of = j.itemCount > 1 ? ` · ${j.item}/${j.itemCount}` : '';
    return `${j.pct.toFixed(1)}%${of}`;
  }
  if (j.status === 'picking') return 'Choose a location…';
  if (j.status === 'starting') return 'Starting…';
  if (j.status === 'merging') return 'Merging…';
  if (j.status === 'done') return 'Done';
  if (j.status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function dlJobHtml(j) {
  const live = DL_LIVE.has(j.status);
  const meta = j.status === 'downloading'
    ? [
      j.total ? `${dlBytes(j.downloaded)} / ${dlBytes(j.total)}` : dlBytes(j.downloaded),
      j.speed ? `${dlBytes(j.speed)}/s` : '',
      j.eta ? `${dlClock(j.eta)} left` : '',
    ].filter(Boolean).join(' · ')
    : j.status === 'error'
      ? esc(j.error || 'Failed')
      : j.files.length
        ? esc(j.files[j.files.length - 1].split(/[\\/]/).pop())
        : '';

  // Anything that didn't finish keeps its row and offers to run again; a
  // partial file left behind is still worth being able to open.
  const actions = [];
  if (live) {
    actions.push(`<button class="btn-ghost" type="button" data-dl-cancel="${esc(j.id)}">Cancel</button>`);
  } else {
    if (j.status !== 'done') {
      actions.push(`<button class="btn-ghost dl-retry" type="button" data-dl-retry="${esc(j.id)}">Retry</button>`);
    }
    if (j.files.length) {
      actions.push(`<button class="btn-ghost" type="button" data-dl-reveal="${esc(j.id)}">Show in folder</button>`);
    }
    actions.push(`<button class="btn-ghost dl-forget" type="button" data-dl-forget="${esc(j.id)}"
      title="Remove from this list — the file is not deleted">Remove</button>`);
  }

  return `<div class="dl-job ${esc(j.status)}">
    ${j.thumbnail ? `<div class="dl-job-thumb"><img src="${esc(j.thumbnail)}" alt="" loading="lazy" /></div>` : ''}
    <div class="dl-job-main">
      <div class="dl-job-top">
        <span class="dl-job-title" title="${esc(j.title)}">${esc(j.title)}</span>
        <span class="dl-job-state">${esc(dlJobState(j))}</span>
      </div>
      <div class="dl-track"><div class="dl-fill" style="width:${j.status === 'done' ? 100 : j.pct || 0}%"></div></div>
      <div class="dl-job-foot">
        <span class="dl-job-meta">${meta}</span>
        <span class="dl-job-acts">${actions.join('')}</span>
      </div>
    </div>
  </div>`;
}

function dlRenderJobs() {
  const list = [...dlJobs.values()].sort((a, b) => Number(b.id) - Number(a.id));
  dl.jobsTitle.hidden = list.length === 0;
  dl.openFolder.hidden = list.length === 0;
  // Only offered when something is actually finished — a list of one running
  // download has nothing clearable in it.
  const finished = list.filter((j) => !DL_LIVE.has(j.status)).length;
  dl.clear.hidden = finished === 0;
  if (!finished) dlDisarmClear();
  dl.jobs.innerHTML = list.map(dlJobHtml).join('');
}

// The folder the next download defaults to — the last one actually saved into.
function dlRenderSaveDir() {
  if (!dlTools || !dlTools.dir) { dl.saveDir.hidden = true; return; }
  dl.saveDir.hidden = false;
  dl.saveDir.textContent = dlTools.dir;
  dl.saveDir.title = `Last used: ${dlTools.dir}`;
}

async function dlLoadJobs() {
  try {
    const res = await fetch('/api/dl/jobs');
    const json = await res.json();
    if (json.status === 'ok') {
      json.data.jobs.forEach((j) => dlJobs.set(j.id, j));
      dlRenderJobs();
    }
  } catch { /* the event stream will fill this in as jobs move */ }
}

function dlConnect() {
  if (dlStream) return;
  dlStream = idleStream('/api/dl/events', {
    // Downloads in flight keep the stream open even on a hidden tab — their
    // progress is the whole reason it is there.
    isBusy: () => [...dlJobs.values()].some((j) => DL_LIVE.has(j.status)),
    onWake: dlLoadJobs,
    onMessage: (job) => {
      if (!job || !job.id) return; // the opening hello frame
      // A retry supersedes the attempt it replayed; the server says so here.
      if (job.removed) {
        dlJobs.delete(job.id);
        dlRenderJobs();
        return;
      }
      dlJobs.set(job.id, job);
      dlRenderJobs();
      // A job that picked a new folder is the server's record of "last used".
      if (job.folder && dlTools && job.folder !== dlTools.dir) {
        dlTools.dir = job.folder;
        dlRenderSaveDir();
      }
    },
  });
}

// Called every time the tab is shown; the heavy lifting only runs once.

function bindDownloader() {
  dl.form.addEventListener('submit', dlDoProbe);

  dl.probe.addEventListener('click', (e) => {
    const thumb = dlInfo && dlInfo.thumbBest;
    // Viewing is a plain navigation to the image host — no server round trip.
    if (e.target.closest('[data-dl-thumb-view]')) {
      if (thumb) window.open(thumb.url, '_blank', 'noopener');
      return;
    }
    if (e.target.closest('[data-dl-thumb-get]')) {
      if (thumb) dlStart({ thumbnailOnly: true, thumbExt: thumb.ext });
      return;
    }
    const go = e.target.closest('[data-dl-go]');
    if (!go || go.hasAttribute('disabled')) return;
    dlStart({
      height: go.dataset.height ? Number(go.dataset.height) : null,
      audioOnly: go.dataset.audio === '1',
      playlist: go.dataset.playlist === '1',
    });
  });

  dl.jobs.addEventListener('click', (e) => {
    const cancel = e.target.closest('[data-dl-cancel]');
    if (cancel) { dlCancel(cancel.dataset.dlCancel); return; }
    const retry = e.target.closest('[data-dl-retry]');
    if (retry) { dlRetry(retry.dataset.dlRetry); return; }
    const reveal = e.target.closest('[data-dl-reveal]');
    if (reveal) { dlReveal(reveal.dataset.dlReveal); return; }
    const forget = e.target.closest('[data-dl-forget]');
    if (forget) dlForget(forget.dataset.dlForget);
  });

  dl.tools.addEventListener('click', (e) => {
    if (e.target.closest('[data-dl-recheck]')) dlLoadTools(true);
  });

  dl.openFolder.addEventListener('click', () => dlReveal(null));
  dl.clear.addEventListener('click', dlClearHistory);
}
export const tool = {
  id: 'downloader',
  name: 'Downloader',
  icon: '⬇️',
  blurb: 'Paste any video URL and pull it at the highest quality.',
  mount(panel) {
    panel.innerHTML = TEMPLATE;
    cacheEls();
    bindDownloader();
    dl.url.addEventListener('input', dlDebouncedInspect);
    dl.ig.addEventListener('click', (e) => {
      const media = e.target.closest('[data-ig-media]');
      if (media) return dlIgFindMedia(media);

      const get = e.target.closest('[data-ig-get]');
      if (get) return dlIgDownload(get.dataset.igGet);

      const signin = e.target.closest('[data-ig-signin]');
      if (signin) return dlIgSignIn(signin);
      const done = e.target.closest('[data-ig-done]');
      if (done) return dlIgDone(done);
    });

    dlLoadPrefs();
    if (dl.cookies) {
      dl.cookies.addEventListener('change', () => { dlSyncCookieUi(); dlSavePrefs(); });
    }
    if (dl.cookieFile) dl.cookieFile.addEventListener('change', dlSavePrefs);
    dlLoadTools();
    dlLoadJobs();
    dlConnect();
  },
  show() {
    // Coming back to the tool should put the cursor where you'd type next.
    dl.url?.focus();
  },
};
