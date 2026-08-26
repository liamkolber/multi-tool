// Downloader — yt-dlp, driven from the browser.
//
// The server owns the yt-dlp process; this side probes a URL, starts a job, and
// renders whatever the /api/dl/events stream reports back.

import { $, esc, debounce } from '../lib/dom.js';

const TEMPLATE = `
  <div class="tool-head">
    <h1 class="tool-title"><span class="tool-title-icon">⬇️</span> Downloader</h1>
    <p class="tool-sub">Paste any URL yt-dlp supports and pull it at the highest quality available.</p>
  </div>

  <div id="dl-tools" class="dl-notice" hidden></div>

  <form id="dl-form" class="dl-bar">
    <input id="dl-url" type="url" placeholder="Paste a video URL…" autocomplete="off" spellcheck="false" />
    <button id="dl-fetch" class="btn btn-primary" type="submit">Fetch</button>
  </form>

  <div id="dl-error" class="dl-notice error" hidden></div>
  <div id="dl-probe" class="dl-probe" hidden></div>

  <div class="dl-jobs-head">
    <h2 id="dl-jobs-title" class="dl-h2" hidden>Downloads</h2>
    <span id="dl-save-dir" class="dl-save-dir" hidden></span>
    <button id="dl-open-folder" class="btn-ghost" type="button" hidden>Open folder</button>
  </div>
  <div id="dl-jobs" class="dl-jobs"></div>`;

const dl = {};
function cacheEls() {
  Object.assign(dl, {
  form: $('dl-form'),
  url: $('dl-url'),
  fetchBtn: $('dl-fetch'),
  tools: $('dl-tools'),
  error: $('dl-error'),
  probe: $('dl-probe'),
  jobs: $('dl-jobs'),
  jobsTitle: $('dl-jobs-title'),
  openFolder: $('dl-open-folder'),
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
    const res = await fetch(`/api/dl/probe?url=${encodeURIComponent(url)}`);
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
const DL_PREFS_KEY = 'multitool:downloader-prefs';

function dlSavePrefs() {
  try {
    localStorage.setItem(DL_PREFS_KEY, JSON.stringify({ preferMp4: dlPreferMp4 }));
  } catch { /* ignore quota */ }
}

function dlLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DL_PREFS_KEY));
    if (saved && typeof saved.preferMp4 === 'boolean') dlPreferMp4 = saved.preferMp4;
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
  try {
    dlStream = new EventSource('/api/dl/events');
  } catch {
    return;
  }
  dlStream.onmessage = (e) => {
    let job;
    try { job = JSON.parse(e.data); } catch { return; }
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
  };
  // EventSource reconnects on its own; a refetch resyncs anything missed.
  dlStream.onerror = () => { /* handled by the browser */ };
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
    if (reveal) dlReveal(reveal.dataset.dlReveal);
  });

  dl.tools.addEventListener('click', (e) => {
    if (e.target.closest('[data-dl-recheck]')) dlLoadTools(true);
  });

  dl.openFolder.addEventListener('click', () => dlReveal(null));
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
    dlLoadPrefs();
    dlLoadTools();
    dlLoadJobs();
    dlConnect();
  },
  show() {
    // Coming back to the tool should put the cursor where you'd type next.
    dl.url?.focus();
  },
};
