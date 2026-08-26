// Converter — ffmpeg, driven from the browser.
//
// Pick a file, the server probes it, and only the operations that suit what it
// found are offered. Each operation declares its own fields below, so adding
// one means adding an entry here and an entry in lib/tools/convert.mjs —
// nothing else in this file changes shape.

import { $, esc, fmtNumber } from '../lib/dom.js';
import { idleStream } from '../lib/stream.js';

const TEMPLATE = `
  <div class="tool-head">
    <h1 class="tool-title"><span class="tool-title-icon">🎛️</span> Converter</h1>
    <p class="tool-sub">Convert, trim, resize and compress video, audio and images — powered by ffmpeg.</p>
  </div>

  <div id="cv-tools" class="cv-notice" hidden></div>

  <div class="cv-bar">
    <button id="cv-pick" class="btn btn-primary" type="button">Choose a file…</button>
    <span class="cv-or">or paste a path</span>
    <input id="cv-path" type="text" placeholder="C:\\Users\\you\\Videos\\clip.mp4" autocomplete="off" spellcheck="false" />
    <button id="cv-load" class="btn-ghost" type="button">Load</button>
  </div>

  <div id="cv-error" class="cv-notice error" hidden></div>
  <div id="cv-file" class="cv-file" hidden></div>
  <div id="cv-ops" class="cv-ops"></div>

  <div class="cv-jobs-head">
    <h2 id="cv-jobs-title" class="cv-h2" hidden>Conversions</h2>
    <button id="cv-open-folder" class="btn-ghost" type="button" hidden>Open folder</button>
  </div>
  <div id="cv-jobs" class="cv-jobs"></div>`;

const cv = {};
function cacheEls() {
  Object.assign(cv, {
    pick: $('cv-pick'),
    path: $('cv-path'),
    load: $('cv-load'),
    tools: $('cv-tools'),
    error: $('cv-error'),
    file: $('cv-file'),
    ops: $('cv-ops'),
    jobs: $('cv-jobs'),
    jobsTitle: $('cv-jobs-title'),
    openFolder: $('cv-open-folder'),
  });
}

let cvTools = null;
let cvFile = null;     // last successful probe
let cvStream = null;
const cvJobs = new Map();

const CV_LIVE = new Set(['picking', 'starting', 'running']);

// --- Operation fields -------------------------------------------------------
// type: select | number | text. `when` hides a field unless another field has
// one of the listed values — quality is meaningless when you're stream-copying.
const QUALITY = { name: 'quality', label: 'Quality', type: 'select', default: 'good',
  options: [['high', 'High (larger)'], ['good', 'Good'], ['small', 'Small (lower)']] };

const HEIGHTS = [['', 'Keep original'], ['2160', '2160p'], ['1440', '1440p'], ['1080', '1080p'],
  ['720', '720p'], ['480', '480p'], ['360', '360p']];

const OP_FIELDS = {
  convert: [
    { name: 'format', label: 'Format', type: 'select', default: 'mp4',
      options: [['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WebM'], ['mov', 'MOV'], ['avi', 'AVI']] },
    { name: 'mode', label: 'Method', type: 'select', default: 'copy',
      options: [['copy', 'Remux — instant, lossless'], ['encode', 'Re-encode']] },
    { ...QUALITY, when: { mode: ['encode'] } },
    { name: 'height', label: 'Resolution', type: 'select', default: '', options: HEIGHTS, when: { mode: ['encode'] } },
  ],
  audio: [
    { name: 'format', label: 'Format', type: 'select', default: 'mp3',
      options: [['mp3', 'MP3'], ['m4a', 'M4A / AAC'], ['opus', 'Opus'], ['flac', 'FLAC (lossless)'], ['wav', 'WAV (lossless)'], ['ogg', 'OGG Vorbis']] },
    { name: 'bitrate', label: 'Bitrate', type: 'select', default: '192',
      options: [['128', '128 kbps'], ['192', '192 kbps'], ['256', '256 kbps'], ['320', '320 kbps']],
      when: { format: ['mp3', 'm4a', 'opus', 'ogg'] } },
  ],
  trim: [
    { name: 'start', label: 'Start', type: 'text', default: '0:00', placeholder: '0:00' },
    { name: 'end', label: 'End', type: 'text', default: '', placeholder: 'end of file' },
    { name: 'mode', label: 'Method', type: 'select', default: 'copy',
      options: [['copy', 'Fast — cuts on keyframes'], ['encode', 'Exact — re-encodes']] },
    { ...QUALITY, when: { mode: ['encode'] } },
  ],
  compress: [
    { name: 'targetMb', label: 'Target size', type: 'number', default: '10', min: 1, max: 20000, suffix: 'MB' },
  ],
  scale: [
    { name: 'height', label: 'Resolution', type: 'select', default: '720', options: HEIGHTS.slice(1) },
    QUALITY,
  ],
  gif: [
    { name: 'start', label: 'Start', type: 'text', default: '0:00', placeholder: '0:00' },
    { name: 'duration', label: 'Length', type: 'number', default: '5', min: 1, max: 60, suffix: 'sec' },
    { name: 'fps', label: 'Frame rate', type: 'number', default: '15', min: 5, max: 50, suffix: 'fps' },
    { name: 'width', label: 'Width', type: 'number', default: '480', min: 80, max: 1920, suffix: 'px' },
  ],
  mute: [],
  image: [
    { name: 'format', label: 'Format', type: 'select', default: 'png',
      options: [['png', 'PNG'], ['jpg', 'JPEG'], ['webp', 'WebP'], ['avif', 'AVIF'], ['bmp', 'BMP'], ['tiff', 'TIFF']] },
    { name: 'quality', label: 'Quality', type: 'number', default: '90', min: 1, max: 100, suffix: '%',
      when: { format: ['jpg', 'webp', 'avif'] } },
    { name: 'width', label: 'Max width', type: 'number', default: '', min: 16, max: 10000, suffix: 'px', placeholder: 'keep' },
  ],
};

// --- Formatting ---
function cvBytes(n) {
  if (!n || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function cvClock(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

function cvShowError(msg) {
  cv.error.hidden = false;
  cv.error.textContent = msg;
}

function cvClearError() {
  cv.error.hidden = true;
  cv.error.textContent = '';
}

// --- Tooling ---
async function cvLoadTools(refresh) {
  try {
    const res = await fetch(`/api/convert/tools${refresh ? '?refresh=1' : ''}`);
    const json = await res.json();
    if (json.status === 'ok') cvTools = json.data;
  } catch { /* keep the previous reading */ }
  cvRenderTools();
}

function cvRenderTools() {
  if (!cvTools) { cv.tools.hidden = true; return; }
  let body = '';
  if (!cvTools.ffmpeg.found) {
    body = `<strong>ffmpeg isn't installed</strong>, so there's nothing to convert with. Run
      <code>npm run get-tools</code> to fetch it into <code>bin\\</code>, or
      <code>winget install Gyan.FFmpeg</code>.`;
  } else if (!cvTools.ffprobe.found) {
    // Not fatal — the server falls back to parsing `ffmpeg -i` — but the JSON
    // ffprobe returns is more reliable than scraping prose out of stderr.
    body = `<strong>ffprobe isn't installed.</strong> Files are still read via <code>ffmpeg -i</code>, which is
      less reliable for unusual formats. Run <code>npm run get-tools</code> to add it.`;
  }
  if (!body) { cv.tools.hidden = true; return; }
  cv.tools.hidden = false;
  cv.tools.className = `cv-notice ${cvTools.ffmpeg.found ? 'warn' : 'error'}`;
  cv.tools.innerHTML = `${body} <button class="link-inline" type="button" data-cv-recheck>Re-check</button>`;
}

// --- Loading a file ---
async function cvPickFile() {
  cvClearError();
  cv.pick.disabled = true;
  cv.pick.textContent = 'Choosing…';
  try {
    const res = await fetch('/api/convert/pick', { method: 'POST' });
    const json = await res.json();
    if (json.status !== 'ok') return cvShowError(json.status_message || 'Could not open the file dialog.');
    if (json.data.cancelled) return;
    cvFile = json.data;
    cv.path.value = cvFile.path;
    cvRenderFile();
  } catch {
    cvShowError('Could not reach the server.');
  } finally {
    cv.pick.disabled = false;
    cv.pick.textContent = 'Choose a file…';
  }
}

async function cvLoadPath() {
  const path = cv.path.value.trim();
  if (!path) return;
  cvClearError();
  cv.load.disabled = true;
  try {
    const res = await fetch(`/api/convert/probe?path=${encodeURIComponent(path)}`);
    const json = await res.json();
    if (json.status !== 'ok') {
      cv.file.hidden = true;
      cv.ops.innerHTML = '';
      if (json.missing) cvLoadTools(true);
      return cvShowError(json.status_message || 'Could not read that file.');
    }
    cvFile = json.data;
    cvRenderFile();
  } catch {
    cvShowError('Could not reach the server.');
  } finally {
    cv.load.disabled = false;
  }
}

const KIND_ICON = { video: '🎬', audio: '🎵', image: '🖼️', other: '📄' };

function cvRenderFile() {
  const f = cvFile;
  if (!f) return;

  const meta = [
    f.kind,
    cvBytes(f.size),
    f.duration ? cvClock(f.duration) : null,
    f.width && f.height ? `${fmtNumber(f.width)}×${fmtNumber(f.height)}` : null,
    f.fps ? `${f.fps} fps` : null,
    f.vcodec,
    f.acodec,
  ].filter(Boolean).map(esc).join(' · ');

  cv.file.hidden = false;
  cv.file.innerHTML = `
    <span class="cv-file-icon">${KIND_ICON[f.kind] || KIND_ICON.other}</span>
    <div class="cv-file-main">
      <div class="cv-file-name" title="${esc(f.path)}">${esc(f.name)}</div>
      <div class="cv-file-meta">${meta}</div>
    </div>`;

  cvRenderOps();
}

function cvFieldHtml(op, f) {
  const id = `cv-${op}-${f.name}`;
  const hidden = f.when ? ' hidden' : '';
  let control;
  if (f.type === 'select') {
    control = `<select id="${id}" data-field="${esc(f.name)}">${f.options.map(([v, l]) =>
      `<option value="${esc(v)}"${v === f.default ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  } else {
    control = `<input id="${id}" data-field="${esc(f.name)}" type="${f.type === 'number' ? 'number' : 'text'}"
      value="${esc(f.default ?? '')}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}
      ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} autocomplete="off" />`;
  }
  return `<label class="cv-field" data-field-row="${esc(f.name)}"${hidden}>
    <span class="cv-field-label">${esc(f.label)}</span>
    <span class="cv-field-control">${control}${f.suffix ? `<span class="cv-suffix">${esc(f.suffix)}</span>` : ''}</span>
  </label>`;
}

function cvRenderOps() {
  const f = cvFile;
  if (!f || !f.ops || !f.ops.length) { cv.ops.innerHTML = ''; return; }

  cv.ops.innerHTML = f.ops.map((op) => {
    const fields = OP_FIELDS[op.id] || [];
    return `<div class="cv-op" data-op="${esc(op.id)}">
      <div class="cv-op-head">
        <span class="cv-op-label">${esc(op.label)}</span>
        <button class="btn btn-primary cv-run" type="button" data-cv-run="${esc(op.id)}">Run</button>
      </div>
      ${fields.length ? `<div class="cv-fields">${fields.map((x) => cvFieldHtml(op.id, x)).join('')}</div>` : ''}
    </div>`;
  }).join('');

  // Apply every `when` rule once up front, then again whenever a field changes.
  cv.ops.querySelectorAll('.cv-op').forEach(cvApplyConditions);
}

function cvApplyConditions(card) {
  const op = card.dataset.op;
  const values = cvCollect(card);
  for (const f of OP_FIELDS[op] || []) {
    if (!f.when) continue;
    const row = card.querySelector(`[data-field-row="${f.name}"]`);
    if (!row) continue;
    const ok = Object.entries(f.when).every(([k, allowed]) => allowed.includes(String(values[k])));
    row.hidden = !ok;
  }
}

function cvCollect(card) {
  const out = {};
  card.querySelectorAll('[data-field]').forEach((el) => {
    const row = el.closest('[data-field-row]');
    // A hidden field isn't part of the request — sending quality alongside a
    // stream copy would just be noise the server has to ignore.
    if (row && row.hidden) return;
    const v = el.value.trim();
    if (v !== '') out[el.dataset.field] = v;
  });
  return out;
}

// --- Jobs ---
async function cvStart(opId, opts, input, retryOf) {
  cvClearError();
  try {
    const res = await fetch('/api/convert/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, op: opId, opts, ...(retryOf ? { retryOf } : {}) }),
    });
    const json = await res.json();
    if (json.status !== 'ok') {
      cvShowError(json.status_message || 'Could not start that conversion.');
      if (json.missing) cvLoadTools(true);
      return;
    }
    cvJobs.set(json.data.id, json.data);
    cvRenderJobs();
  } catch {
    cvShowError('Could not reach the server.');
  }
}

async function cvCancel(id) {
  try { await fetch(`/api/convert/cancel?job=${encodeURIComponent(id)}`, { method: 'POST' }); } catch { /* ignore */ }
}

async function cvReveal(id) {
  const qs = id ? `?job=${encodeURIComponent(id)}` : '';
  try { await fetch(`/api/convert/reveal${qs}`, { method: 'POST' }); } catch { /* ignore */ }
}

// Replays a failed or cancelled job with the settings it was started with.
function cvRetry(id) {
  const job = cvJobs.get(id);
  if (!job) return;
  cvStart(job.op, job.opts || {}, job.input, job.id);
}

function cvJobState(j) {
  if (j.status === 'running') return j.duration ? `${j.pct.toFixed(1)}%` : 'Working…';
  if (j.status === 'picking') return 'Choose a location…';
  if (j.status === 'starting') return 'Starting…';
  if (j.status === 'done') return 'Done';
  if (j.status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function cvJobHtml(j) {
  const live = CV_LIVE.has(j.status);
  const meta = j.status === 'error'
    ? esc(j.error || 'Failed')
    : [
      j.opLabel,
      j.outSize ? cvBytes(j.outSize) : '',
      j.status === 'running' && j.speed ? `${j.speed}×` : '',
      j.output ? j.output.split(/[\\/]/).pop() : '',
    ].filter(Boolean).map(esc).join(' · ');

  const actions = [];
  if (live) {
    actions.push(`<button class="btn-ghost" type="button" data-cv-cancel="${esc(j.id)}">Cancel</button>`);
  } else {
    if (j.status !== 'done') {
      actions.push(`<button class="btn-ghost cv-retry" type="button" data-cv-retry="${esc(j.id)}">Retry</button>`);
    }
    if (j.output && j.status === 'done') {
      actions.push(`<button class="btn-ghost" type="button" data-cv-reveal="${esc(j.id)}">Show in folder</button>`);
    }
  }

  // A job with no known duration (an image) has no meaningful percentage, so
  // the bar sits full while it runs rather than pretending to measure.
  const width = j.status === 'done' ? 100 : (j.duration ? j.pct || 0 : (live ? 100 : 0));

  return `<div class="cv-job ${esc(j.status)}">
    <div class="cv-job-main">
      <div class="cv-job-top">
        <span class="cv-job-title" title="${esc(j.name)}">${esc(j.name)}</span>
        <span class="cv-job-state">${esc(cvJobState(j))}</span>
      </div>
      <div class="cv-track"><div class="cv-fill" style="width:${width}%"></div></div>
      <div class="cv-job-foot">
        <span class="cv-job-meta">${meta}</span>
        <span class="cv-job-acts">${actions.join('')}</span>
      </div>
    </div>
  </div>`;
}

function cvRenderJobs() {
  const list = [...cvJobs.values()].sort((a, b) => Number(b.id) - Number(a.id));
  cv.jobsTitle.hidden = list.length === 0;
  cv.openFolder.hidden = list.length === 0;
  cv.jobs.innerHTML = list.map(cvJobHtml).join('');
}

async function cvLoadJobs() {
  try {
    const res = await fetch('/api/convert/jobs');
    const json = await res.json();
    if (json.status === 'ok') {
      json.data.jobs.forEach((j) => cvJobs.set(j.id, j));
      cvRenderJobs();
    }
  } catch { /* the event stream fills this in */ }
}

function cvConnect() {
  if (cvStream) return;
  cvStream = idleStream('/api/convert/events', {
    // A conversion in flight keeps the stream open on a hidden tab.
    isBusy: () => [...cvJobs.values()].some((j) => CV_LIVE.has(j.status)),
    onWake: cvLoadJobs,
    onMessage: (job) => {
      if (!job || !job.id) return;
      if (job.removed) { cvJobs.delete(job.id); cvRenderJobs(); return; }
      cvJobs.set(job.id, job);
      cvRenderJobs();
    },
  });
}

function bindConverter() {
  cv.pick.addEventListener('click', cvPickFile);
  cv.load.addEventListener('click', cvLoadPath);
  cv.path.addEventListener('keydown', (e) => { if (e.key === 'Enter') cvLoadPath(); });

  cv.ops.addEventListener('change', (e) => {
    const card = e.target.closest('.cv-op');
    if (card) cvApplyConditions(card);
  });

  cv.ops.addEventListener('click', (e) => {
    const run = e.target.closest('[data-cv-run]');
    if (!run || !cvFile) return;
    const card = run.closest('.cv-op');
    cvStart(run.dataset.cvRun, cvCollect(card), cvFile.path);
  });

  cv.jobs.addEventListener('click', (e) => {
    const cancel = e.target.closest('[data-cv-cancel]');
    if (cancel) { cvCancel(cancel.dataset.cvCancel); return; }
    const retry = e.target.closest('[data-cv-retry]');
    if (retry) { cvRetry(retry.dataset.cvRetry); return; }
    const reveal = e.target.closest('[data-cv-reveal]');
    if (reveal) cvReveal(reveal.dataset.cvReveal);
  });

  cv.tools.addEventListener('click', (e) => {
    if (e.target.closest('[data-cv-recheck]')) cvLoadTools(true);
  });

  cv.openFolder.addEventListener('click', () => cvReveal(null));
}

export const tool = {
  id: 'convert',
  name: 'Converter',
  icon: '🎛️',
  blurb: 'Convert, trim, resize and compress video, audio and images.',
  mount(panel) {
    panel.innerHTML = TEMPLATE;
    cacheEls();
    bindConverter();
    cvLoadTools();
    cvLoadJobs();
    cvConnect();
  },
  show() {
    // The Library hands a file over through sessionStorage rather than by
    // importing this module: panels mount lazily, so it may well fire before
    // this tool exists. Reading it here — after mount, on every show — catches
    // it either way.
    let handed = null;
    try {
      handed = sessionStorage.getItem('multitool:convert-path');
      if (handed) sessionStorage.removeItem('multitool:convert-path');
    } catch { /* private mode, or storage disabled */ }

    if (handed) {
      cv.path.value = handed;
      cvLoadPath();
      return;
    }
    cv.path?.focus();
  },
};
