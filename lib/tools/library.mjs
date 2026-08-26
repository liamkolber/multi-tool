// Library Scanner — what is actually in that folder.
//
// Walks a directory, probes every media file it finds, and hands the browser
// one flat index. Everything after that — search, sort, duplicate detection,
// "show me what's still 720p" — happens client-side against that index, so it
// is instant and costs no further disk work.
//
// Probing is one process per file, which is the expensive part, so results are
// cached by path + size + mtime. A rescan after adding a few files only probes
// the few that changed.

import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, dirname, join } from 'node:path';
import { ROOT, sendJson, readBody, sameOrigin } from '../core.mjs';
import { probeMedia, getMediaTools, extOf, VIDEO_EXT, AUDIO_EXT, SUB_EXT } from '../probe.mjs';

const PS_EXE = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const INDEX_PATH = join(ROOT, '.library-index.json');

// Guard rails for a walk that could otherwise wander into a system drive.
const MAX_FILES = 20_000;
const MAX_DEPTH = 12;
const PROBE_CONCURRENCY = 4;

// Folders never worth descending into.
const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'node_modules', '.git',
  'windows', 'program files', 'program files (x86)', 'appdata', '$windows.~bt',
]);

const state = {
  root: null,
  files: [],
  scanning: false,
  cancelled: false,
  scanned: 0,
  found: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
};

// --- Persistence -------------------------------------------------------------
async function loadIndex() {
  try {
    const saved = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
    if (saved && Array.isArray(saved.files)) {
      state.root = saved.root || null;
      state.files = saved.files;
      state.found = saved.files.length;
      state.finishedAt = saved.finishedAt || null;
    }
  } catch { /* no scan yet */ }
}

async function saveIndex() {
  try {
    await writeFile(INDEX_PATH, `${JSON.stringify({
      root: state.root,
      finishedAt: state.finishedAt,
      files: state.files,
    })}\n`);
  } catch { /* the index is a cache, never fail a scan over it */ }
}

// --- SSE ---
const sseClients = new Set();

function progress() {
  return {
    scanning: state.scanning,
    root: state.root,
    scanned: state.scanned,
    found: state.found,
    error: state.error,
    finishedAt: state.finishedAt,
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(progress())}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { /* dropped on its own close */ }
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  if (res.socket) res.socket.setTimeout(0);
  res.write(`data: ${JSON.stringify(progress())}\n\n`);
  sseClients.add(res);
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25_000);
  req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
}

// --- Walking -----------------------------------------------------------------
// Collects media files and, alongside them, every subtitle sitting in the same
// folder — a sidecar .srt is how most of a library carries its subtitles, and
// it would be invisible to a probe of the video alone.
async function walk(dir, depth, out, subsByDir) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES || state.cancelled) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch { return; } // unreadable folder — skip rather than abort the scan

  for (const entry of entries) {
    if (state.cancelled || out.length >= MAX_FILES) return;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      await walk(full, depth + 1, out, subsByDir);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = extOf(entry.name);
    if (SUB_EXT.has(ext)) {
      if (!subsByDir.has(dir)) subsByDir.set(dir, []);
      subsByDir.get(dir).push(entry.name);
      continue;
    }
    if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) out.push(full);
  }
}

// "Movie.mkv" is matched by "Movie.srt" and "Movie.en.srt", but not by
// "Movie 2.srt" — the character after the stem has to be a separator.
function sidecarsFor(path, subsByDir) {
  const subs = subsByDir.get(dirname(path));
  if (!subs || !subs.length) return [];
  const stem = basename(path, extname(path)).toLowerCase();
  return subs.filter((s) => {
    const lower = s.toLowerCase();
    if (!lower.startsWith(stem)) return false;
    const rest = lower.slice(stem.length);
    return rest.startsWith('.');
  });
}

async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !state.cancelled) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

async function runScan(root) {
  state.scanning = true;
  state.cancelled = false;
  state.root = root;
  state.scanned = 0;
  state.found = 0;
  state.error = null;
  state.startedAt = Date.now();
  state.finishedAt = null;
  broadcast();

  // Anything already known, keyed so an unchanged file can skip its probe.
  const previous = new Map(state.files.map((f) => [f.path, f]));

  const paths = [];
  const subsByDir = new Map();
  await walk(root, 0, paths, subsByDir);

  state.found = paths.length;
  broadcast();

  const tools = await getMediaTools();
  const results = [];
  let sinceBroadcast = 0;

  await pool(paths, PROBE_CONCURRENCY, async (path) => {
    let st;
    try { st = await stat(path); } catch { state.scanned++; return; }

    const cached = previous.get(path);
    const unchanged = cached && cached.size === st.size && cached.mtime === st.mtimeMs;

    let info = unchanged ? cached : null;
    if (!info) {
      const probe = await probeMedia(path, tools);
      info = {
        path,
        name: basename(path),
        dir: dirname(path),
        ext: extOf(path),
        size: st.size,
        mtime: st.mtimeMs,
        kind: (probe && probe.kind) || 'other',
        duration: (probe && probe.duration) || 0,
        width: (probe && probe.width) || null,
        height: (probe && probe.height) || null,
        vcodec: (probe && probe.vcodec) || null,
        acodec: (probe && probe.acodec) || null,
        fps: (probe && probe.fps) || null,
        bitrate: (probe && probe.bitrate) || null,
        audioTracks: (probe && probe.audioTracks) || 0,
        subTracks: (probe && probe.subTracks) || 0,
        unreadable: !probe,
      };
    }

    // Sidecars are cheap and can change without the video changing, so they are
    // refreshed even for a cache hit.
    results.push({ ...info, sidecars: sidecarsFor(path, subsByDir) });

    state.scanned++;
    if (++sinceBroadcast >= 5) { sinceBroadcast = 0; broadcast(); }
  });

  results.sort((a, b) => a.path.localeCompare(b.path));
  state.files = results;
  state.found = results.length;
  state.scanning = false;
  state.finishedAt = Date.now();
  if (state.cancelled) state.error = 'Scan cancelled.';
  broadcast();
  await saveIndex();
}

// --- Routes ------------------------------------------------------------------
function pickFolder() {
  return new Promise((resolve) => {
    const env = { ...process.env, DL_PICK_MODE: 'folder', DL_PICK_DIR: state.root || '' };
    let child;
    try {
      if (process.platform === 'win32') {
        child = spawn(PS_EXE, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'pick-path.ps1')], { env, windowsHide: true });
      } else if (process.platform === 'darwin') {
        child = spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder to scan")'], { env });
      } else {
        child = spawn('zenity', ['--file-selection', '--directory', '--title=Choose a folder to scan'], { env });
      }
    } catch {
      return resolve({ error: 'Could not open the folder dialog.' });
    }
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve({ error: 'Could not open the folder dialog.' }));
    child.on('close', (code) => {
      const chosen = out.trim();
      if (code !== 0 || !chosen) return resolve({ cancelled: true });
      resolve({ dir: chosen });
    });
  });
}

async function handlePick(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  const picked = await pickFolder();
  if (picked.error) return sendJson(res, 500, { status: 'error', status_message: picked.error });
  if (picked.cancelled) return sendJson(res, 200, { status: 'ok', data: { cancelled: true } });
  return sendJson(res, 200, { status: 'ok', data: { dir: picked.dir } });
}

async function handleScan(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  if (state.scanning) return sendJson(res, 409, { status: 'error', status_message: 'A scan is already running.' });

  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch {
    return sendJson(res, 400, { status: 'error', status_message: 'Bad request body.' });
  }

  const root = String(payload.root || '').trim();
  if (!root) return sendJson(res, 400, { status: 'error', status_message: 'A folder is required.' });
  try {
    const st = await stat(root);
    if (!st.isDirectory()) return sendJson(res, 400, { status: 'error', status_message: 'That is a file, not a folder.' });
  } catch {
    return sendJson(res, 400, { status: 'error', status_message: 'That folder does not exist.' });
  }

  // A fresh root invalidates the cache; rescanning the same one reuses it.
  if (payload.rescan === false || state.root !== root) state.files = state.root === root ? state.files : [];

  sendJson(res, 200, { status: 'ok', data: progress() });
  runScan(root).catch((err) => {
    state.scanning = false;
    state.error = err && err.message ? err.message : 'Scan failed.';
    state.finishedAt = Date.now();
    broadcast();
  });
}

function handleCancel(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  state.cancelled = true;
  return sendJson(res, 200, { status: 'ok', data: progress() });
}

function handleReveal(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  const target = url.searchParams.get('path') || state.root;
  if (!target) return sendJson(res, 200, { status: 'ok' });
  try {
    if (process.platform === 'win32') {
      spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'reveal.ps1')], {
        env: { ...process.env, DL_REVEAL_PATH: target, DL_REVEAL_SELECT: target === state.root ? '0' : '1' },
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['-R', target], { detached: true }).unref();
    } else {
      spawn('xdg-open', [dirname(target)], { detached: true }).unref();
    }
  } catch { /* best effort */ }
  sendJson(res, 200, { status: 'ok' });
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/library\/?/, '');
  if (route === 'events') return handleEvents(req, res);
  if (route === 'status') return sendJson(res, 200, { status: 'ok', data: progress() });
  if (route === 'index') {
    return sendJson(res, 200, {
      status: 'ok',
      data: { root: state.root, finishedAt: state.finishedAt, files: state.files },
    });
  }
  if (route === 'pick' && req.method === 'POST') return handlePick(req, res);
  if (route === 'scan' && req.method === 'POST') return handleScan(req, res);
  if (route === 'cancel' && req.method === 'POST') return handleCancel(req, res);
  if (route === 'reveal' && req.method === 'POST') return handleReveal(req, res, url);
  return sendJson(res, 404, { status: 'error', status_message: 'Unknown library endpoint.' });
}

export const tool = {
  id: 'library',
  name: 'Library',
  icon: '📚',
  blurb: 'Scan a folder and see what is really in it — sizes, quality, duplicates.',
  prefix: '/api/library/',
  handle: handleApi,
  init: () => loadIndex(),
  async banner() {
    return [['library', state.root ? `${state.files.length} files indexed in ${state.root}` : 'no folder scanned yet']];
  },
};
