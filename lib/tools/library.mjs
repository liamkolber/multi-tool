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

// A contact sheet is a grid of frames spread across the whole running time —
// the fastest way to tell what a file called 0hmsc12ff47tph9f88ick_source.mp4
// actually is.
const SHEET_COLS = 4;
const SHEET_ROWS = 4;
const SHEET_TILE_W = 240;

// How many deletions stay undoable. An undo list, not a history.
const TRASH_KEEP = 50;

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
  truncated: false,
  includeImages: false,
  trash: [],
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
      state.trash = Array.isArray(saved.trash) ? saved.trash : [];
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
      trash: state.trash,
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
    truncated: state.truncated,
    limit: MAX_FILES,
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
    if (ctx.paths.length >= MAX_FILES) { ctx.truncated = true; continue; }
    const wanted = VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext) || ARCHIVE_EXT.has(ext)
      || (ctx.images && IMAGE_EXT.has(ext));
    if (wanted) ctx.paths.push(full);
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

  const ctx = {
    paths: [], subsByDir: new Map(), dirs: new Map(), sizes: new Map(),
    seen: 0, truncated: false, images: !!state.includeImages,
  };
  await walk(root, 0, ctx);

  const paths = ctx.paths;
  const subsByDir = ctx.subsByDir;
  state.folders = buildFolders(root, ctx.dirs);
  state.truncated = ctx.truncated;
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

// The scan knows about folders as well as files, and both are things you may
// reasonably ask to reveal or open. Returning which one it is matters: Explorer
// wants /select for a file, but a folder should simply be opened.
function indexedTarget(p) {
  if (!p) return null;
  const want = normPath(p);

  const asFile = state.files.find((f) => normPath(f.path) === want);
  if (asFile) return { path: asFile.path, isFile: true };

  const asFolder = state.folders.find((f) => normPath(f.path) === want);
  if (asFolder) return { path: asFolder.path, isFile: false };

  return null;
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

// --- Playback -----------------------------------------------------------------
// Enough of a byte-range server for a <video> element to seek in. Without range
// support the browser downloads the whole file before it will play anything,
// and the scrub bar does nothing.
const STREAM_TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', ts: 'video/mp2t',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', opus: 'audio/ogg', ogg: 'audio/ogg',
};

async function handleStreamFile(req, res, url) {
  const f = indexedFile(url.searchParams.get('path'));
  if (!f || (f.kind !== 'video' && f.kind !== 'audio')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not playable');
  }

  let size;
  try {
    size = (await stat(f.path)).size;
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Gone');
  }

  const type = STREAM_TYPES[extOf(f.path)] || 'application/octet-stream';
  const range = req.headers.range;

  // No Range header: hand over the whole thing, but advertise that ranges work
  // so the browser asks for them next time.
  if (!range) {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    return createReadStream(f.path).on('error', () => res.end()).pipe(res);
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  // "bytes=-500" means the LAST 500 bytes, not the first 500 — players use it
  // to read a trailing index.
  let start;
  let end;
  if (m[1] === '') {
    const tail = Number(m[2]);
    if (!tail) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  return createReadStream(f.path, { start, end }).on('error', () => res.end()).pipe(res);
}

// --- Contact sheets -----------------------------------------------------------
// Sixteen frames spread evenly across the file, tiled into one image.
//
// Built from sixteen fast seeks rather than one pass with an fps filter: the
// filter has to decode the entire file, which on a two-hour video is minutes,
// while "-ss T" before "-i" jumps straight to a keyframe near T. Sixteen inputs
// in one process, so it stays one spawn.
function sheetArgs(f, out) {
  const frames = SHEET_COLS * SHEET_ROWS;
  const duration = f.duration || 0;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];

  for (let i = 0; i < frames; i++) {
    // Sample inside the file rather than at 0 and at the very end, where a fade
    // to black is likely and tells you nothing.
    const at = duration ? ((i + 0.5) / frames) * duration : 0;
    args.push('-ss', at.toFixed(3), '-i', f.path);
  }

  const parts = [];
  for (let i = 0; i < frames; i++) {
    parts.push(`[${i}:v]scale=${SHEET_TILE_W}:-2,trim=end_frame=1,setpts=PTS-STARTPTS[t${i}]`);
  }
  const chain = Array.from({ length: frames }, (_, i) => `[t${i}]`).join('');
  parts.push(`${chain}concat=n=${frames}:v=1:a=0,tile=${SHEET_COLS}x${SHEET_ROWS}[sheet]`);

  args.push('-filter_complex', parts.join(';'), '-map', '[sheet]', '-frames:v', '1', '-q:v', '4', '--', out);
  return args;
}

function runSheet(f, out, tools) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(tools.ffmpeg.path, sheetArgs(f, out), { windowsHide: true });
    } catch {
      return resolve(false);
    }
    // Sixteen seeks into a large file is still work; a minute is generous.
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function handleSheet(req, res, url) {
  const f = indexedFile(url.searchParams.get('path'));
  if (!f || f.kind !== 'video' || f.unreadable || !f.duration) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No sheet');
  }

  const out = join(THUMB_DIR, `${thumbKey(f)}-sheet.jpg`);
  const send = () => {
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    createReadStream(out).on('error', () => res.end()).pipe(res);
  };

  try {
    await stat(out);
    return send();
  } catch { /* not built yet */ }

  const tools = await getMediaTools();
  if (!tools.ffmpeg.found) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ffmpeg not installed');
  }

  await thumbSlot();
  let ok = false;
  try {
    await mkdir(THUMB_DIR, { recursive: true });
    ok = await runSheet(f, out, tools);
  } finally {
    releaseThumbSlot();
  }

  if (!ok) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Could not build a sheet');
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
  state.includeImages = !!payload.includeImages;
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
  // No path means "open the folder I scanned"; a path must be one of the files
  // or folders the scan found.
  const found = asked ? indexedTarget(asked) : null;
  if (asked && !found) {
    return sendJson(res, 404, { status: 'error', status_message: 'That path is not in the current scan.' });
  }
  const target = asked ? found.path : state.root;
  if (!target) return sendJson(res, 404, { status: 'error', status_message: 'Nothing has been scanned yet.' });
  try {
    if (process.platform === 'win32') {
      spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'reveal.ps1')], {
        // Selecting only makes sense for a file — a folder should just open.
        env: { ...process.env, DL_REVEAL_PATH: target, DL_REVEAL_SELECT: found && found.isFile ? '1' : '0' },
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', found && found.isFile ? ['-R', target] : [target], { detached: true }).unref();
    } else {
      spawn('xdg-open', [found && found.isFile ? dirname(target) : target], { detached: true }).unref();
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

  const f = indexedTarget(url.searchParams.get('path'));
  if (!f) return sendJson(res, 404, { status: 'error', status_message: 'That path is not in the current scan.' });

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

// --- Deleting ----------------------------------------------------------------
// To the Recycle Bin, never straight off the disk. This button sits next to
// duplicate detection that is explicitly heuristic — "same length" is a strong
// hint, not proof — so getting it wrong has to be survivable. On Windows that
// means VisualBasic's FileSystem.DeleteFile, which is the only route that
// actually recycles rather than unlinking.
//
// Folders are deliberately not deletable. Removing one file at a time is a
// mistake you can undo; removing a tree is a different kind of afternoon.
function recycle(path) {
  return new Promise((resolve) => {
    let child;
    const env = { ...process.env, MT_DELETE_PATH: path };
    try {
      if (process.platform === 'win32') {
        child = spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          "Add-Type -AssemblyName Microsoft.VisualBasic; "
          + "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile("
          + "$env:MT_DELETE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')"],
        { env, windowsHide: true });
      } else if (process.platform === 'darwin') {
        child = spawn('osascript', ['-e',
          'tell application "Finder" to delete POSIX file (system attribute "MT_DELETE_PATH")'], { env });
      } else {
        child = spawn('gio', ['trash', path], { env });
      }
    } catch {
      return resolve({ ok: false, message: 'Could not run the delete.' });
    }
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ ok: false, message: 'Could not run the delete.' }));
    child.on('close', (code) => resolve(code === 0
      ? { ok: true }
      : { ok: false, message: (err.trim().split('\n').pop() || 'The file could not be moved to the Recycle Bin.') }));
  });
}

// Keeps the totals honest without forcing a rescan. Deleting and restoring are
// the same arithmetic with the sign flipped, so they share one function.
function adjustFolders(f, sign) {
  const dir = normPath(f.dir);
  const rootN = normPath(state.root || '');
  for (const folder of state.folders) {
    const fp = normPath(folder.path);
    const isSelf = fp === dir;
    // An ancestor is a prefix of the file's directory on a path boundary.
    const isAncestor = dir.startsWith(`${fp}\\`) || fp === rootN;
    if (!isSelf && !isAncestor) continue;
    folder.files = Math.max(0, folder.files + sign);
    folder.size = Math.max(0, folder.size + sign * (f.size || 0));
    if (isSelf) {
      folder.ownFiles = Math.max(0, folder.ownFiles + sign);
      folder.ownSize = Math.max(0, folder.ownSize + sign * (f.size || 0));
    }
  }
}

function forgetFile(f) {
  const want = normPath(f.path);
  state.files = state.files.filter((x) => normPath(x.path) !== want);
  adjustFolders(f, -1);
}

// The record is kept whole, so restoring puts back exactly what was indexed —
// the file on disk has not changed, so there is nothing worth re-probing.
function rememberFile(f) {
  const want = normPath(f.path);
  if (state.files.some((x) => normPath(x.path) === want)) return;
  state.files.push(f);
  state.files.sort((a, b) => a.path.localeCompare(b.path));
  adjustFolders(f, 1);
}

// Asks the shell to put a specific item back where it came from. Matching on
// both the name and the original folder matters: the bin can easily hold
// several files of the same name from different places.
function restoreFromBin(target) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ ok: false, message: 'Restoring from the trash is only wired up on Windows.' });
    }
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      '$target = $env:MT_RESTORE_PATH',
      '$leaf   = Split-Path $target -Leaf',
      '$parent = Split-Path $target -Parent',
      '$bin = (New-Object -ComObject Shell.Application).Namespace(0xA)',
      'if (-not $bin) { exit 5 }',
      '$item = $bin.Items() | Where-Object { $_.Name -eq $leaf -and $bin.GetDetailsOf($_, 1) -eq $parent } | Select-Object -First 1',
      'if (-not $item) { exit 2 }',
      '$verb = $item.Verbs() | Where-Object { ($_.Name -replace "&","") -eq "Restore" } | Select-Object -First 1',
      'if (-not $verb) { exit 3 }',
      '$verb.DoIt()',
      // DoIt() returns before the shell has finished moving the file.
      'for ($i = 0; $i -lt 50; $i++) { if (Test-Path -LiteralPath $target) { exit 0 }; Start-Sleep -Milliseconds 100 }',
      'exit 4',
    ].join('; ');

    let child;
    try {
      child = spawn(PS_EXE, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        env: { ...process.env, MT_RESTORE_PATH: target },
        windowsHide: true,
      });
    } catch {
      return resolve({ ok: false, message: 'Could not run the restore.' });
    }
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, message: 'Could not run the restore.' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const why = {
        2: 'It is no longer in the Recycle Bin — it may have been emptied or restored already.',
        3: 'Windows would not offer a restore for that item.',
        4: 'Windows accepted the restore but the file has not reappeared.',
        5: 'Could not read the Recycle Bin.',
      };
      resolve(code === 0 ? { ok: true } : { ok: false, message: why[code] || 'The restore failed.' });
    });
  });
}

async function handleDelete(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });

  const asked = url.searchParams.get('path');
  const f = asked ? state.files.find((x) => normPath(x.path) === normPath(asked)) : null;
  if (!f) {
    return sendJson(res, 404, { status: 'error', status_message: 'That file is not in the current scan.' });
  }

  const result = await recycle(f.path);
  if (!result.ok) return sendJson(res, 500, { status: 'error', status_message: result.message });

  forgetFile(f);
  // Held whole so a restore can put the exact record back. Bounded, because
  // this is an undo list rather than a history.
  state.trash.push({ ...f, deletedAt: Date.now() });
  if (state.trash.length > TRASH_KEEP) state.trash = state.trash.slice(-TRASH_KEEP);
  await saveIndex();
  return sendJson(res, 200, { status: 'ok', data: { path: f.path, size: f.size } });
}

async function handleRestore(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });

  const asked = url.searchParams.get('path');
  const want = normPath(asked || '');
  const entry = state.trash.find((x) => normPath(x.path) === want);
  if (!entry) return sendJson(res, 404, { status: 'error', status_message: 'Nothing deleted here matches that.' });

  const result = await restoreFromBin(entry.path);
  if (!result.ok) return sendJson(res, 500, { status: 'error', status_message: result.message });

  const { deletedAt, ...record } = entry;
  rememberFile(record);
  state.trash = state.trash.filter((x) => normPath(x.path) !== want);
  await saveIndex();
  return sendJson(res, 200, { status: 'ok', data: { path: entry.path } });
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
        trash: state.trash,
      },
    });
  }
  if (route === 'thumb') return handleThumb(req, res, url);
  if (route === 'sheet') return handleSheet(req, res, url);
  if (route === 'stream') return handleStreamFile(req, res, url);
  if (route === 'pick' && req.method === 'POST') return handlePick(req, res);
  if (route === 'scan' && req.method === 'POST') return handleScan(req, res);
  if (route === 'cancel' && req.method === 'POST') return handleCancel(req, res);
  if (route === 'reveal' && req.method === 'POST') return handleReveal(req, res, url);
  if (route === 'open' && req.method === 'POST') return handleOpen(req, res, url);
  if (route === 'delete' && req.method === 'POST') return handleDelete(req, res, url);
  if (route === 'restore' && req.method === 'POST') return handleRestore(req, res, url);
  if (route === 'trash' && req.method === 'POST') { state.trash = []; saveIndex(); return sendJson(res, 200, { status: 'ok' }); }
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
