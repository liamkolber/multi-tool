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
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, readdir, stat, open, mkdir } from 'node:fs/promises';
import { basename, extname, dirname, join, resolve } from 'node:path';
import { ROOT, sendJson, readBody, sameOrigin } from '../core.mjs';
import { probeMedia, getMediaTools, extOf, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT, SUB_EXT } from '../probe.mjs';

const PS_EXE = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const INDEX_PATH = join(ROOT, '.library-index.json');
const THUMB_DIR = join(ROOT, '.library-thumbs');

// Poster frames are generated on demand as rows scroll into view, so a library
// of thousands costs nothing until you actually look at it. More than a few
// ffmpeg processes at once just thrashes the disk.
const THUMB_CONCURRENCY = 3;
const THUMB_WIDTH = 320;

// Guard rails for a walk that could otherwise wander into a system drive.
const MAX_FILES = 20_000;      // files indexed individually
const MAX_SEEN = 200_000;      // files even looked at, so a wrong folder can't run away
const MAX_DEPTH = 12;
const PROBE_CONCURRENCY = 4;

// Archives are indexed but never probed — there is nothing for ffmpeg to read.
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'cab', 'zipx']);

// Folders never worth descending into.
const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'node_modules', '.git',
  'windows', 'program files', 'program files (x86)', 'appdata', '$windows.~bt',
]);

const state = {
  root: null,
  files: [],
  folders: [],
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
      state.folders = Array.isArray(saved.folders) ? saved.folders : [];
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
      folders: state.folders,
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
  if (beat.unref) beat.unref(); // never a reason on its own to keep the process busy
  req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
}

// --- Walking -----------------------------------------------------------------
// Two jobs at once. It collects the files worth indexing individually — media
// and archives — and alongside them every subtitle sitting in the same folder,
// since a sidecar .srt is how most of a library carries its subtitles and would
// be invisible to a probe of the video alone.
//
// It also sizes up EVERY file it passes, indexed or not, into per-directory
// totals. Folder sizes that counted only the media would be a different number
// from the one Explorer shows, which would make them worse than useless.
async function walk(dir, depth, ctx) {
  if (depth > MAX_DEPTH || state.cancelled || ctx.seen >= MAX_SEEN) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch { return; } // unreadable folder — skip rather than abort the scan

  let ownFiles = 0;
  let ownSize = 0;

  for (const entry of entries) {
    if (state.cancelled || ctx.seen >= MAX_SEEN) break;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      await walk(full, depth + 1, ctx);
      continue;
    }
    if (!entry.isFile()) continue;

    ctx.seen++;
    ownFiles++;

    // stat is cheap next to a probe, so every file gets one — that is what
    // makes the folder totals match reality.
    try {
      const st = await stat(full);
      ownSize += st.size;
      ctx.sizes.set(full, st);
    } catch { /* vanished or locked between readdir and stat */ }

    const ext = extOf(entry.name);
    if (SUB_EXT.has(ext)) {
      if (!ctx.subsByDir.has(dir)) ctx.subsByDir.set(dir, []);
      ctx.subsByDir.get(dir).push(entry.name);
      continue;
    }
    if (ctx.paths.length >= MAX_FILES) continue;
    if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext) || IMAGE_EXT.has(ext) || ARCHIVE_EXT.has(ext)) ctx.paths.push(full);
  }

  if (ownFiles) ctx.dirs.set(dir, { files: ownFiles, size: ownSize });
}

// Rolls the per-directory totals up so every folder reports itself plus
// everything beneath it — which is the number you actually want when deciding
// what is eating the disk.
function buildFolders(root, dirs) {
  const nodes = new Map();

  const ensure = (p) => {
    if (!nodes.has(p)) {
      const rel = p === root ? '' : p.slice(root.length).replace(/^[\\/]+/, '');
      nodes.set(p, {
        path: p,
        name: p === root ? (basename(root) || root) : basename(p),
        rel,
        depth: rel ? rel.split(/[\\/]/).length : 0,
        files: 0,
        size: 0,
        ownFiles: 0,
        ownSize: 0,
      });
    }
    return nodes.get(p);
  };

  ensure(root);

  for (const [dir, own] of dirs) {
    const self = ensure(dir);
    self.ownFiles = own.files;
    self.ownSize = own.size;

    // Add this folder's own contents to itself and to every ancestor.
    let cur = dir;
    for (let guard = 0; guard <= MAX_DEPTH + 2; guard++) {
      const node = ensure(cur);
      node.files += own.files;
      node.size += own.size;
      if (cur === root) break;
      const parent = dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
  }

  return [...nodes.values()].sort((a, b) => b.size - a.size);
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

// Two files of exactly the same size are usually the same file, but "usually"
// is not good enough to tell someone to delete one. Hashing the first and last
// 64 KB settles it: containers differ in their header and their index, so two
// genuinely different videos that happen to share a byte count will not match,
// while a plain copy under another name will. Reading 128 KB is cheap enough to
// do for every candidate; hashing whole multi-gigabyte files would not be.
const SIG_CHUNK = 64 * 1024;

async function fileSignature(path, size) {
  let fh;
  try {
    fh = await open(path, 'r');
    const headLen = Math.min(SIG_CHUNK, size);
    const head = Buffer.alloc(headLen);
    if (headLen) await fh.read(head, 0, headLen, 0);

    // Skip the tail when the file is small enough that it overlaps the head.
    const tailLen = Math.min(SIG_CHUNK, Math.max(0, size - headLen));
    const tail = Buffer.alloc(tailLen);
    if (tailLen) await fh.read(tail, 0, tailLen, size - tailLen);

    return createHash('sha1').update(head).update(tail).digest('hex').slice(0, 16);
  } catch {
    return null; // locked or unreadable — just means no signature for this one
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// Only files that collide on size can possibly be identical, so only those are
// ever read. In a typical library that is a small fraction of the whole.
async function signCandidates(files) {
  const bySize = new Map();
  for (const f of files) {
    if (!f.size) continue;
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }

  const candidates = [];
  for (const [, group] of bySize) {
    if (group.length > 1) candidates.push(...group.filter((f) => !f.sig));
  }
  if (!candidates.length) return;

  await pool(candidates, PROBE_CONCURRENCY, async (f) => {
    f.sig = await fileSignature(f.path, f.size);
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

  const ctx = { paths: [], subsByDir: new Map(), dirs: new Map(), sizes: new Map(), seen: 0 };
  await walk(root, 0, ctx);

  const paths = ctx.paths;
  const subsByDir = ctx.subsByDir;
  state.folders = buildFolders(root, ctx.dirs);
  state.found = paths.length;
  broadcast();

  const tools = await getMediaTools();
  const results = [];
  let sinceBroadcast = 0;

  await pool(paths, PROBE_CONCURRENCY, async (path) => {
    const st = ctx.sizes.get(path);
    if (!st) { state.scanned++; return; }

    const cached = previous.get(path);
    const unchanged = cached && cached.size === st.size && cached.mtime === st.mtimeMs;

    let info = unchanged ? cached : null;
    if (!info) {
      // An archive has nothing for ffmpeg to read; spawning one per zip would
      // be pure waste.
      const archive = ARCHIVE_EXT.has(extOf(path));
      const probe = archive ? null : await probeMedia(path, tools);
      info = {
        path,
        name: basename(path),
        dir: dirname(path),
        ext: extOf(path),
        size: st.size,
        mtime: st.mtimeMs,
        kind: archive ? 'archive' : (probe && probe.kind) || 'other',
        duration: (probe && probe.duration) || 0,
        width: (probe && probe.width) || null,
        height: (probe && probe.height) || null,
        vcodec: (probe && probe.vcodec) || null,
        acodec: (probe && probe.acodec) || null,
        fps: (probe && probe.fps) || null,
        bitrate: (probe && probe.bitrate) || null,
        audioTracks: (probe && probe.audioTracks) || 0,
        subTracks: (probe && probe.subTracks) || 0,
        sig: null, // filled in below, but only where a size collision makes it matter
        unreadable: !archive && !probe,
      };
    }

    // Sidecars are cheap and can change without the video changing, so they are
    // refreshed even for a cache hit.
    results.push({ ...info, sidecars: sidecarsFor(path, subsByDir) });

    state.scanned++;
    if (++sinceBroadcast >= 5) { sinceBroadcast = 0; broadcast(); }
  });

  // Now that every size is known, settle which same-size files are byte-alike.
  if (!state.cancelled) await signCandidates(results);

  results.sort((a, b) => a.path.localeCompare(b.path));
  state.files = results;
  state.found = results.length;
  state.scanning = false;
  state.finishedAt = Date.now();
  if (state.cancelled) state.error = 'Scan cancelled.';
  broadcast();
  await saveIndex();
}

// Only a file the current scan actually found may be named by a request. This
// is what stops /thumb and /reveal being pointed at anything on the disk.
//
// Windows paths reach us in whichever form the caller had — separators either
// way round, drive letter in either case — so both sides are normalised before
// comparing. That forgives the shape of the path without loosening which files
// are allowed.
function normPath(p) {
  const s = String(p || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function indexedFile(p) {
  if (!p) return null;
  const want = normPath(p);
  return state.files.find((f) => normPath(f.path) === want) || null;
}

// --- Thumbnails ---------------------------------------------------------------
// The cache key folds in size and mtime, so an edited file gets a new name
// rather than a stale picture, and the response can be cached hard.
function thumbKey(f) {
  return createHash('sha1').update(`${f.path}|${f.size}|${f.mtime}`).digest('hex').slice(0, 20);
}

let thumbActive = 0;
const thumbWaiting = [];

function thumbSlot() {
  if (thumbActive < THUMB_CONCURRENCY) {
    thumbActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => thumbWaiting.push(resolve));
}

function releaseThumbSlot() {
  const next = thumbWaiting.shift();
  if (next) next();
  else thumbActive--;
}

function generateThumb(f, out, tools) {
  return new Promise((resolve) => {
    // Ten percent in, capped at a minute: the opening frames of a video are
    // very often black or a title card, which makes for a useless poster.
    const seek = f.kind === 'image' ? null
      : Math.min(60, Math.max(1, (f.duration || 0) * 0.1));

    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (seek != null) args.push('-ss', String(seek));
    args.push('-i', f.path, '-frames:v', '1',
      '-vf', `scale=${THUMB_WIDTH}:-2:flags=bilinear`,
      '-q:v', '5', '--', out);

    let child;
    try {
      child = spawn(tools.ffmpeg.path, args, { windowsHide: true });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => child.kill(), 25_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function handleThumb(req, res, url) {
  const f = indexedFile(url.searchParams.get('path'));
  if (!f || (f.kind !== 'video' && f.kind !== 'image') || f.unreadable) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No thumbnail');
  }

  const out = join(THUMB_DIR, `${thumbKey(f)}.jpg`);
  const send = () => {
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      // The key changes whenever the file does, so this can never go stale.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    createReadStream(out).on('error', () => res.end()).pipe(res);
  };

  try {
    await stat(out);
    return send();
  } catch { /* not generated yet */ }

  const tools = await getMediaTools();
  if (!tools.ffmpeg.found) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ffmpeg not installed');
  }

  await thumbSlot();
  let ok = false;
  try {
    await mkdir(THUMB_DIR, { recursive: true });
    ok = await generateThumb(f, out, tools);
  } finally {
    releaseThumbSlot();
  }

  if (!ok) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Could not render a frame');
  }
  return send();
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

  // resolve() settles the separators and any trailing slash. buildFolders walks
  // from a file's directory up to the root by string comparison, so a root in a
  // different shape than the paths join() produces would never match it.
  const raw = String(payload.root || '').trim();
  if (!raw) return sendJson(res, 400, { status: 'error', status_message: 'A folder is required.' });
  const root = resolve(raw);
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
  const asked = url.searchParams.get('path');
  // No path means "open the folder I scanned"; a path must be one of its files.
  const found = asked ? indexedFile(asked) : null;
  const target = asked ? (found && found.path) : state.root;
  if (!target) return sendJson(res, 404, { status: 'error', status_message: 'That file is not in the current scan.' });
  try {
    if (process.platform === 'win32') {
      spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'reveal.ps1')], {
        env: { ...process.env, DL_REVEAL_PATH: target, DL_REVEAL_SELECT: asked ? '1' : '0' },
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

// Hands the file to whatever the OS opens it with. Same rule as everything else
// here: it has to be a file the current scan found, so this can never be talked
// into launching something arbitrary.
//
// On Windows this goes through the shell's file association rather than
// ShellExecute directly — Start-Process with -FilePath does exactly what a
// double-click in Explorer does, including for extensions with no console
// handler. The path travels as an environment variable so a name full of
// quotes and semicolons stays a name.
function handleOpen(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });

  const f = indexedFile(url.searchParams.get('path'));
  if (!f) return sendJson(res, 404, { status: 'error', status_message: 'That file is not in the current scan.' });

  try {
    if (process.platform === 'win32') {
      // Deliberately NOT detached. DETACHED_PROCESS denies the child the window
      // station it needs to put a window on screen, so the app launches and is
      // never seen — the same trap reveal.ps1 documents in the downloader.
      // unref() alone is enough to stop it holding the server open.
      spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'Start-Process -FilePath $env:MT_OPEN_PATH'], {
        env: { ...process.env, MT_OPEN_PATH: f.path },
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [f.path], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [f.path], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    return sendJson(res, 500, { status: 'error', status_message: 'Could not open that file.' });
  }
  return sendJson(res, 200, { status: 'ok' });
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/library\/?/, '');
  if (route === 'events') return handleEvents(req, res);
  if (route === 'status') return sendJson(res, 200, { status: 'ok', data: progress() });
  if (route === 'index') {
    return sendJson(res, 200, {
      status: 'ok',
      data: {
        root: state.root,
        finishedAt: state.finishedAt,
        files: state.files,
        folders: state.folders,
      },
    });
  }
  if (route === 'thumb') return handleThumb(req, res, url);
  if (route === 'pick' && req.method === 'POST') return handlePick(req, res);
  if (route === 'scan' && req.method === 'POST') return handleScan(req, res);
  if (route === 'cancel' && req.method === 'POST') return handleCancel(req, res);
  if (route === 'reveal' && req.method === 'POST') return handleReveal(req, res, url);
  if (route === 'open' && req.method === 'POST') return handleOpen(req, res, url);
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
