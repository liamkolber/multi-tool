// Downloader — pulls any URL yt-dlp supports, at the best quality available.
// The server owns the yt-dlp/ffmpeg processes and streams progress over SSE.

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, join, dirname } from 'node:path';
import { ROOT, sendJson, readBody, sameOrigin } from '../core.mjs';

const __dirname = ROOT;

// --- Downloader (yt-dlp) -----------------------------------------------------
// Wraps the yt-dlp binary so any supported URL can be pulled at full quality.
// The proxy above is a strict whitelist on purpose; this is the one place that
// takes an arbitrary URL, so it validates first and always spawns with an
// argument array (never a shell string) — a crafted URL can't become a command,
// and the private-address check keeps it off the local network.

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || join(__dirname, 'downloads');
const BIN_DIR = join(__dirname, 'bin');

// --- Where files land --------------------------------------------------------
// The Save-as dialog opens in whatever folder was used last, the way a browser
// download does. That folder is the only thing worth persisting, so it lives in
// a small JSON file beside the server rather than in memory.
const CONFIG_PATH = join(__dirname, '.dl-config.json');
const PS_EXE = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
let lastSaveDir = null;

const saveDir = () => lastSaveDir || DOWNLOAD_DIR;

async function loadDlConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    if (parsed && typeof parsed.lastDir === 'string') lastSaveDir = parsed.lastDir;
  } catch { /* first run — fall back to DOWNLOAD_DIR */ }
}

async function rememberSaveDir(dir) {
  if (!dir || dir === lastSaveDir) return;
  lastSaveDir = dir;
  try {
    await writeFile(CONFIG_PATH, `${JSON.stringify({ lastDir: dir }, null, 2)}\n`);
  } catch { /* not worth failing a download over */ }
}

// Strip what Windows won't accept in a file name, and leave headroom for the
// extension yt-dlp appends.
function safeFileName(name, ext) {
  const base = String(name || 'video')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'video';
  return ext ? `${base}.${ext}` : base;
}

// Opens a real OS dialog. Windows gets a full Save-as (name, folder and type);
// elsewhere it's a folder picker, because wrapping an arbitrary video title in
// an AppleScript or zenity prompt isn't worth the quoting risk.
function pickDestination(mode, suggestedName, onSpawn) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DL_PICK_MODE: mode,
      DL_PICK_DIR: saveDir(),
      DL_PICK_NAME: suggestedName || '',
    };
    let child;
    try {
      if (process.platform === 'win32') {
        child = spawn(
          PS_EXE,
          ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'pick-path.ps1')],
          { env, windowsHide: true }
        );
      } else if (process.platform === 'darwin') {
        child = spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose where to save")'], { env });
      } else {
        child = spawn('zenity', ['--file-selection', '--directory', '--title=Choose where to save', `--filename=${saveDir()}/`], { env });
      }
    } catch {
      return resolve({ error: 'Could not open the save dialog.' });
    }
    if (onSpawn) onSpawn(child);

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve({ error: 'Could not open the save dialog.' }));
    child.on('close', (code) => {
      const chosen = out.trim();
      if (code !== 0 || !chosen) return resolve({ cancelled: true });
      resolve(mode === 'folder' ? { dir: chosen } : { path: chosen });
    });
  });
}

// The container the merge should target. An extension typed into the Save-as
// dialog wins, so asking for ".mp4" actually gets you MP4.
function containerFor(dest, opts) {
  if (opts.audioOnly || opts.thumbnailOnly) return null;
  const ext = dest && dest.path ? extname(dest.path).slice(1).toLowerCase() : '';
  if (ext === 'mp4' || ext === 'mkv' || ext === 'webm') return ext;
  return opts.preferMp4 ? 'mp4' : 'mkv';
}

// Every download now goes through the save dialog, so `dest` always carries
// either a chosen file name or a chosen folder.
function outputTemplate(dest, opts) {
  // A chosen file name wins, but yt-dlp still supplies the extension so the
  // name and the real container can't disagree.
  if (dest.path) {
    const ext = extname(dest.path);
    return join(dirname(dest.path), `${basename(dest.path, ext)}.%(ext)s`);
  }
  // A chosen folder means "put them here" — no extra nesting.
  return opts.playlist
    ? join(dest.dir, '%(playlist_index)03d - %(title).150B [%(id)s].%(ext)s')
    : join(dest.dir, '%(title).180B [%(id)s].%(ext)s');
}

function targetDirFor(dest) {
  return dest.path ? dirname(dest.path) : dest.dir;
}

// Hosts yt-dlp must never be pointed at (SSRF guard).
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|\[?f[cd])/i;

function parseTargetUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { error: 'That is not a valid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http and https URLs are supported.' };
  if (PRIVATE_HOST.test(u.hostname) || u.hostname.endsWith('.local')) {
    return { error: 'Local and private addresses are not allowed.' };
  }
  return { url: u.toString() };
}

// Cross-origin pages must not be able to drive the downloader. Browsers always
// send Origin on POST (fetch and form alike), so checking it is enough here.


// --- Tool discovery: project ./bin first, then PATH ---
let toolCache = null;

function toolVersion(cmd, isFfmpeg) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [isFfmpeg ? '-version' : '--version'], { windowsHide: true });
    } catch { return resolve(null); }
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 8000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? (out.trim().split('\n')[0] || 'installed') : null);
    });
  });
}

async function resolveTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const cmd of [join(BIN_DIR, exe), exe]) {
    const version = await toolVersion(cmd, name === 'ffmpeg');
    if (version) return { found: true, path: cmd, version };
  }
  return { found: false, path: null, version: null };
}

async function getTools(refresh) {
  if (!toolCache || refresh) {
    const [ytdlp, ffmpeg, deno] = await Promise.all([
      resolveTool('yt-dlp'), resolveTool('ffmpeg'), resolveTool('deno'),
    ]);
    toolCache = { ytdlp, ffmpeg, deno };
  }
  return toolCache;
}

// YouTube extraction without a JavaScript runtime is deprecated, and yt-dlp
// warns that "some formats may be missing" — which for a tool whose whole point
// is max quality means the best stream can silently vanish from the list. Deno
// is the runtime yt-dlp enables by default; point it at ours when it's in bin/.
function jsRuntimeArgs(tools) {
  return tools.deno.found ? ['--js-runtimes', `deno:${tools.deno.path}`] : [];
}

// --- Format selection ---
// Height-based selectors rather than the exact format_ids from the probe: ids
// can rotate between probing and downloading, heights don't.
function buildFormat(height, audioOnly, preferMp4) {
  if (audioOnly) return 'ba/b';
  const cap = height ? `[height<=${height}]` : '';
  if (preferMp4) return `bv*${cap}[ext=mp4]+ba[ext=m4a]/bv*${cap}+ba/b${cap}`;
  return `bv*${cap}+ba/b${cap}`;
}

function fmtBytes(n) {
  if (!n || !Number.isFinite(n)) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// YouTube's DASH formats usually carry no filesize at all, so falling back to
// bitrate x duration is what keeps the picker from showing every resolution at
// the same size. Anything not measured exactly is marked with a '~'.
function formatSize(f, duration) {
  if (f.filesize) return { bytes: f.filesize, exact: true };
  if (f.filesize_approx) return { bytes: f.filesize_approx, exact: false };
  if (f.tbr && duration) return { bytes: (f.tbr * 1000 * duration) / 8, exact: false };
  return { bytes: 0, exact: false };
}

function sizeNote(bytes, exact) {
  if (!bytes) return null;
  return `${exact ? '' : '~'}${fmtBytes(bytes)}`;
}

// Biggest thumbnail on offer. yt-dlp orders `thumbnails` worst-to-best, but it
// reports real pixel dimensions for most of them, so pick by area and only fall
// back to that ordering when nothing is measured.
function bestThumbnail(info) {
  const all = info.thumbnails || [];
  const measured = all.filter((t) => t && t.url && t.width && t.height);
  const pick = measured.length
    ? measured.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
    : all.filter((t) => t && t.url).pop();

  const url = (pick && pick.url) || info.thumbnail;
  if (!url) return null;

  // Extension lives in the path, not the query string (…/maxresdefault.webp?sqp=…).
  let ext = '';
  try {
    ext = (extname(new URL(url).pathname).slice(1) || '').toLowerCase();
  } catch { /* leave blank */ }
  if (!/^[a-z0-9]{2,5}$/.test(ext)) ext = 'jpg';

  return {
    url,
    width: (pick && pick.width) || null,
    height: (pick && pick.height) || null,
    ext,
  };
}

// Collapse yt-dlp's format list into one pickable row per resolution.
function summarizeFormats(info) {
  const all = info.formats || [];
  const duration = info.duration || 0;
  const byHeight = new Map();
  for (const f of all) {
    if (!f.height || f.vcodec === 'none') continue;
    const prev = byHeight.get(f.height);
    if (!prev || (f.tbr || 0) > (prev.tbr || 0)) byHeight.set(f.height, f);
  }
  const audio = all.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
  const bestAudio = audio.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
  const audioSize = bestAudio ? formatSize(bestAudio, duration) : { bytes: 0, exact: false };

  const rows = [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .map((f) => {
      // Progressive formats already carry audio; split ones need the audio track added.
      const needsMerge = !f.acodec || f.acodec === 'none';
      const video = formatSize(f, duration);
      const bytes = video.bytes ? video.bytes + (needsMerge ? audioSize.bytes : 0) : 0;
      const exact = video.exact && (!needsMerge || audioSize.exact);
      const codec = (f.vcodec || '').split('.')[0].replace('none', '');
      return {
        height: f.height,
        label: `${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ''}`,
        note: [codec, sizeNote(bytes, exact)].filter(Boolean).join(' · '),
        needsMerge,
      };
    });

  return {
    rows,
    audio: bestAudio
      ? {
        label: 'Audio only',
        note: [(bestAudio.acodec || '').split('.')[0], sizeNote(audioSize.bytes, audioSize.exact)]
          .filter(Boolean).join(' · '),
      }
      : null,
  };
}

async function handleDlProbe(res, url) {
  const target = parseTargetUrl(url.searchParams.get('url'));
  if (target.error) return sendJson(res, 400, { status: 'error', status_message: target.error });

  const tools = await getTools();
  if (!tools.ytdlp.found) {
    return sendJson(res, 503, { status: 'error', status_message: 'yt-dlp is not installed.', missing: 'yt-dlp' });
  }

  const probeArgs = ['-J', '--no-warnings', '--flat-playlist', ...jsRuntimeArgs(tools), '--', target.url];
  const child = spawn(tools.ytdlp.path, probeArgs, {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  let out = '';
  let err = '';
  const timer = setTimeout(() => child.kill(), 45_000);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', () => {
    clearTimeout(timer);
    sendJson(res, 500, { status: 'error', status_message: 'Could not run yt-dlp.' });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      const line = err.split('\n').find((l) => l.includes('ERROR:'));
      const msg = (line || 'yt-dlp could not read that URL.').replace(/^\s*ERROR:\s*/, '').trim();
      return sendJson(res, 502, { status: 'error', status_message: msg });
    }
    let info;
    try {
      info = JSON.parse(out);
    } catch {
      return sendJson(res, 502, { status: 'error', status_message: 'Unreadable response from yt-dlp.' });
    }

    const isPlaylist = info._type === 'playlist' || Array.isArray(info.entries);
    const thumbs = info.thumbnails || [];
    sendJson(res, 200, {
      status: 'ok',
      data: {
        url: target.url,
        title: info.title || info.id || target.url,
        uploader: info.uploader || info.channel || info.playlist_uploader || null,
        thumbnail: info.thumbnail || (thumbs.length ? thumbs[thumbs.length - 1].url : null),
        duration: info.duration || null,
        extractor: info.extractor_key || info.extractor || null,
        isPlaylist,
        entryCount: isPlaylist ? (info.playlist_count || (info.entries || []).length) : 0,
        thumbBest: bestThumbnail(info),
        ...(isPlaylist ? { rows: [], audio: null } : summarizeFormats(info)),
      },
    });
  });
}

// --- Jobs ---
let jobSeq = 0;
const jobs = new Map();
const JOBS_KEEP = 60;
const sseClients = new Set();

// A job is "live" from the moment the save dialog opens until yt-dlp exits.
const JOB_LIVE = new Set(['picking', 'starting', 'downloading', 'merging']);

// `child` and `picker` are process handles — never serialise them.
function publicJob(job) {
  const { child, picker, ...rest } = job;
  return rest;
}

// Finished downloads outlive the server so a restart doesn't wipe the list —
// losing the history (and the Show-in-folder buttons with it) every time the
// server bounces is worse than the cost of one small JSON file.
const JOBS_PATH = join(__dirname, '.dl-jobs.json');
let jobSaveTimer = null;

async function loadJobHistory() {
  try {
    const saved = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
    if (!Array.isArray(saved)) return;
    for (const j of saved.slice(-JOBS_KEEP)) {
      if (!j || !j.id || JOB_LIVE.has(j.status)) continue; // a live job can't survive a restart
      jobs.set(String(j.id), { ...j, child: null, picker: null });
      jobSeq = Math.max(jobSeq, Number(j.id) || 0); // keep new ids from colliding
    }
  } catch { /* first run, or the file was hand-edited — start clean */ }
}

function saveJobHistory() {
  clearTimeout(jobSaveTimer);
  jobSaveTimer = setTimeout(async () => {
    const finished = [...jobs.values()].filter((j) => !JOB_LIVE.has(j.status)).map(publicJob);
    try {
      await writeFile(JOBS_PATH, `${JSON.stringify(finished.slice(-JOBS_KEEP), null, 2)}\n`);
    } catch { /* history is a convenience, never fail a download over it */ }
  }, 400);
  if (jobSaveTimer.unref) jobSaveTimer.unref();
}

function broadcast(job) {
  const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { /* dropped on its own close */ }
  }
}

function handleDlEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  if (res.socket) res.socket.setTimeout(0);
  res.write(`data: ${JSON.stringify({ hello: true })}\n\n`);
  sseClients.add(res);
  // Comment frames keep idle-socket reapers from closing the stream.
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25_000);
  if (beat.unref) beat.unref(); // never a reason on its own to keep the process busy
  req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
}



// yt-dlp writes 'NA' into the progress template for fields it doesn't have yet.
const num = (s) => {
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v : null;
};

function createJob(target, opts) {
  const id = String(++jobSeq);
  const job = {
    id,
    url: target,
    title: opts.title || target,
    thumbnail: opts.thumbnail || null,
    // Everything needed to run this download again. A job that fails or is
    // cancelled keeps its place in the history behind a Retry button, and this
    // is what that button replays.
    opts: {
      height: opts.height || null,
      audioOnly: !!opts.audioOnly,
      thumbnailOnly: !!opts.thumbnailOnly,
      thumbExt: opts.thumbExt || null,
      preferMp4: !!opts.preferMp4,
      playlist: !!opts.playlist,
    },
    status: 'starting',
    pct: 0,
    downloaded: null,
    total: null,
    speed: null,
    eta: null,
    item: 0,
    itemCount: opts.playlist ? 0 : 1,
    files: [],
    current: null,
    folder: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}

// `dest` is whatever the save dialog returned — { path } for a chosen file
// name, { dir } for a chosen folder, or null to fall back to the last-used one.
async function runJob(job, opts, tools, dest) {
  // Cancelled in the gap between the save dialog closing and the spawn below.
  if (job.status === 'cancelled') return;

  const outTemplate = outputTemplate(dest, opts);
  const container = containerFor(dest, opts);
  job.folder = targetDirFor(dest);

  try {
    await mkdir(job.folder, { recursive: true });
  } catch {
    job.status = 'error';
    job.error = 'Could not create that folder.';
    job.finishedAt = Date.now();
    return broadcast(job);
  }

  const args = [
    '--newline',
    '--progress',
    '--no-simulate',
    '--no-warnings',
    '--progress-template',
    'download:@P@%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '-o', outTemplate,
    opts.playlist ? '--yes-playlist' : '--no-playlist',
  ];

  if (opts.thumbnailOnly) {
    // --write-thumbnail takes yt-dlp's best thumbnail, which is the largest one
    // it can actually fetch — it falls back when maxresdefault 404s, which a
    // hand-picked URL wouldn't. Left in its native format: re-encoding a webp
    // to jpg would only lose quality.
    //
    // Deliberately no --print here. It implies --quiet, which swallows the
    // "[info] Writing video thumbnail … to:" line — and with --skip-download
    // that line is the only place the written path ever appears, since
    // after_move never fires. Tested: with --print the file lands but the job
    // reports no file at all.
    args.push('--skip-download', '--write-thumbnail');
  } else {
    args.push('--print', 'after_move:@F@%(filepath)s');
    args.push('-f', buildFormat(opts.height, opts.audioOnly, container === 'mp4'));
    if (container) args.push('--merge-output-format', container);
  }
  if (tools.ffmpeg.found) args.push('--ffmpeg-location', tools.ffmpeg.path);
  args.push(...jsRuntimeArgs(tools));
  args.push('--', job.url); // '--' so a URL starting with '-' can't be read as a flag

  // Without this yt-dlp writes its log in the Windows console codepage, so a
  // Japanese (or any non-Latin) title comes back as a row of '#' — and the file
  // path we record from that line is then wrong, breaking "Show in folder".
  const child = spawn(tools.ytdlp.path, args, {
    cwd: job.folder,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  job.child = child;
  job.status = 'starting';
  broadcast(job);

  let stdoutBuf = '';
  let lastErr = '';

  const onLine = (line) => {
    if (line.startsWith('@P@')) {
      const [st, done, total, est, speed, eta] = line.slice(3).split('|');
      job.downloaded = num(done);
      job.total = num(total) || num(est);
      job.speed = num(speed);
      job.eta = num(eta);
      if (job.total && job.downloaded) job.pct = Math.min(100, (job.downloaded / job.total) * 100);
      if (st === 'downloading') job.status = 'downloading';
      return;
    }
    if (line.startsWith('@F@')) {
      const f = line.slice(3).trim();
      if (f && !job.files.includes(f)) job.files.push(f);
      return;
    }
    if (line.startsWith('[Merger]') || line.startsWith('[ExtractAudio]')) { job.status = 'merging'; return; }
    const item = line.match(/Downloading item (\d+) of (\d+)/);
    if (item) { job.item = Number(item[1]); job.itemCount = Number(item[2]); job.pct = 0; return; }
    // --skip-download means --print after_move never fires, so the written
    // thumbnail path has to come from yt-dlp's own log line.
    const thumb = line.match(/Writing .*?thumbnail.*? to:\s*(.+)$/i);
    if (thumb) {
      const f = thumb[1].trim();
      if (f && !job.files.includes(f)) job.files.push(f);
      return;
    }
    // Fallbacks for builds where --print after_move isn't honoured.
    const dest = line.match(/^\[download\] Destination: (.+)$/) || line.match(/^\[Merger\] Merging formats into "(.+)"$/);
    if (dest) job.current = dest[1];
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop();
    let changed = false;
    for (const line of lines) {
      if (line.trim()) { onLine(line.trim()); changed = true; }
    }
    if (changed) broadcast(job);
  });

  child.stderr.on('data', (chunk) => {
    const line = String(chunk).split('\n').find((l) => l.includes('ERROR:'));
    if (line) lastErr = line.replace(/^\s*ERROR:\s*/, '').trim();
  });

  child.on('error', () => {
    job.child = null;
    job.status = 'error';
    job.error = 'Could not run yt-dlp.';
    job.finishedAt = Date.now();
    broadcast(job);
  });

  child.on('close', (code, signal) => {
    job.child = null;
    job.finishedAt = Date.now();
    if (job.status === 'cancelled' || signal) {
      job.status = 'cancelled';
    } else if (code === 0) {
      job.status = 'done';
      job.pct = 100;
      if (!job.files.length && job.current) job.files.push(job.current);
    } else {
      job.status = 'error';
      job.error = lastErr || `yt-dlp exited with code ${code}.`;
    }
    broadcast(job);

    // Trim finished jobs, oldest first. Live ones are never evicted.
    if (jobs.size > JOBS_KEEP) {
      for (const [key, j] of jobs) {
        if (jobs.size <= JOBS_KEEP) break;
        if (!JOB_LIVE.has(j.status)) jobs.delete(key);
      }
    }
    saveJobHistory();
  });
}

async function handleDlStart(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    return sendJson(res, 415, { status: 'error', status_message: 'Expected application/json.' });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { status: 'error', status_message: 'Bad request body.' });
  }

  const target = parseTargetUrl(payload.url);
  if (target.error) return sendJson(res, 400, { status: 'error', status_message: target.error });

  const tools = await getTools();
  if (!tools.ytdlp.found) {
    return sendJson(res, 503, { status: 'error', status_message: 'yt-dlp is not installed.', missing: 'yt-dlp' });
  }
  const audioOnly = !!payload.audioOnly;
  const thumbnailOnly = !!payload.thumbnailOnly;
  // Above 720p YouTube serves video and audio as separate streams, so a merge
  // — and therefore ffmpeg — is unavoidable there. A thumbnail is one file and
  // is never re-encoded, so it needs neither.
  const needsMerge = !audioOnly && !thumbnailOnly && (!payload.height || payload.height > 720);
  if (needsMerge && !tools.ffmpeg.found) {
    return sendJson(res, 503, {
      status: 'error',
      status_message: 'ffmpeg is required to merge video and audio above 720p.',
      missing: 'ffmpeg',
    });
  }

  const opts = {
    height: Number(payload.height) || null,
    audioOnly,
    thumbnailOnly,
    // The thumbnail keeps whatever format the host serves, so the extension
    // travels with the job rather than being re-derived on a retry.
    thumbExt: thumbnailOnly && /^[a-z0-9]{2,5}$/i.test(payload.thumbExt || '')
      ? String(payload.thumbExt).toLowerCase()
      : null,
    preferMp4: !!payload.preferMp4,
    playlist: !!payload.playlist && !thumbnailOnly,
    title: payload.title,
    thumbnail: payload.thumbnail,
  };
  const job = createJob(target.url, opts);

  // A retry stands in for the attempt it replays, so the history keeps one row
  // per download rather than growing one per attempt. Only a finished job is
  // ever displaced — a live one is left alone.
  const retryOf = payload.retryOf == null ? null : String(payload.retryOf);
  const replaced = retryOf && retryOf !== job.id ? jobs.get(retryOf) : null;
  if (replaced && !JOB_LIVE.has(replaced.status)) {
    jobs.delete(retryOf);
    broadcast({ id: retryOf, removed: true });
    saveJobHistory(); // or a restart mid-retry brings the old row back
  }

  // Answer now rather than after the dialog: it can sit open indefinitely, and
  // everything from here on reaches the browser over the event stream anyway.
  sendJson(res, 200, { status: 'ok', data: publicJob(job) });
  broadcast(job);

  job.status = 'picking';
  broadcast(job);

  // Save-as needs a file name; a playlist writes many files, so it needs a folder.
  const mode = opts.playlist || process.platform !== 'win32' ? 'folder' : 'file';
  const suggestedExt = thumbnailOnly ? (opts.thumbExt || 'jpg') : containerFor(null, opts);
  const suggested = mode === 'file' ? safeFileName(payload.title, suggestedExt) : '';
  const picked = await pickDestination(mode, suggested, (child) => { job.picker = child; });
  job.picker = null;

  // Cancelled from the UI while the dialog was open. No child ever spawns, so
  // this has to record and persist the job itself.
  if (job.status === 'cancelled') {
    job.finishedAt = job.finishedAt || Date.now();
    broadcast(job);
    return saveJobHistory();
  }
  if (picked.cancelled || picked.error) {
    // No child is ever spawned here, so the close handler that normally
    // persists a job never runs — save it explicitly.
    job.status = picked.error ? 'error' : 'cancelled';
    job.error = picked.error || null;
    job.finishedAt = Date.now();
    broadcast(job);
    return saveJobHistory();
  }

  await rememberSaveDir(picked.dir || dirname(picked.path));
  return runJob(job, opts, tools, picked);
}

function handleDlCancel(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  const job = jobs.get(url.searchParams.get('job'));
  if (!job) return sendJson(res, 404, { status: 'error', status_message: 'No such job.' });
  // Cancelling while the dialog is up closes the dialog instead.
  const proc = job.child || job.picker;
  if (proc) {
    job.status = 'cancelled';
    proc.kill();
  } else if (JOB_LIVE.has(job.status)) {
    // No process to kill yet — the job is in the gap between the dialog
    // closing and yt-dlp spawning. Nothing else will ever close this one out,
    // so record it here or it sits in the list as permanently "Starting…".
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    broadcast(job);
    saveJobHistory();
  }
  sendJson(res, 200, { status: 'ok', data: publicJob(job) });
}

// Reveal a finished file in the OS file manager.
function handleDlReveal(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  const job = jobs.get(url.searchParams.get('job'));
  const file = job && job.files.length ? job.files[0] : null;
  const folder = (job && job.folder) || saveDir();
  try {
    if (process.platform === 'win32') {
      // Delegated to a helper because two separate things go wrong otherwise:
      // explorer.exe needs /select,"path" quoted just so, and when a window is
      // already showing that folder it reuses it without raising it, so the
      // click appears to do nothing. reveal.ps1 handles both.
      // Deliberately NOT detached: DETACHED_PROCESS leaves the child without
      // the window-station access it needs to raise a window, so the reveal
      // runs but nothing ever comes to the front. unref() alone is enough to
      // keep it from holding the server open.
      spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'reveal.ps1')], {
        env: { ...process.env, DL_REVEAL_PATH: file || folder, DL_REVEAL_SELECT: file ? '1' : '0' },
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', file ? ['-R', file] : [folder], { detached: true }).unref();
    } else {
      spawn('xdg-open', [file ? dirname(file) : folder], { detached: true }).unref();
    }
  } catch { /* best effort — the path is shown in the UI regardless */ }
  sendJson(res, 200, { status: 'ok' });
}

// Forgetting a download and deleting one are different things, and this is
// firmly the first: the record leaves the list, the file on disk is not touched.
// Only a finished job can be forgotten — dropping a live one would leave its
// yt-dlp process running with nothing watching it.
function handleDlForget(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });

  const id = url.searchParams.get('job');
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { status: 'error', status_message: 'No such download.' });
  if (JOB_LIVE.has(job.status)) {
    return sendJson(res, 409, { status: 'error', status_message: 'That download is still running — cancel it first.' });
  }

  jobs.delete(id);
  broadcast({ id, removed: true });
  saveJobHistory();
  return sendJson(res, 200, { status: 'ok' });
}

function handleDlClear(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });

  // Anything still running stays, for the same reason as above.
  let cleared = 0;
  for (const [id, job] of [...jobs]) {
    if (JOB_LIVE.has(job.status)) continue;
    jobs.delete(id);
    broadcast({ id, removed: true });
    cleared++;
  }
  saveJobHistory();
  return sendJson(res, 200, { status: 'ok', data: { cleared } });
}

async function handleDlApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/dl\/?/, '');
  if (route === 'tools') {
    const tools = await getTools(url.searchParams.get('refresh') === '1');
    return sendJson(res, 200, {
      status: 'ok',
      data: { ...tools, dir: saveDir(), platform: process.platform },
    });
  }
  if (route === 'probe') return handleDlProbe(res, url);
  if (route === 'events') return handleDlEvents(req, res);
  if (route === 'jobs') {
    return sendJson(res, 200, { status: 'ok', data: { jobs: [...jobs.values()].map(publicJob).reverse() } });
  }
  if (route === 'start' && req.method === 'POST') return handleDlStart(req, res);
  if (route === 'cancel' && req.method === 'POST') return handleDlCancel(req, res, url);
  if (route === 'reveal' && req.method === 'POST') return handleDlReveal(req, res, url);
  if (route === 'forget' && req.method === 'POST') return handleDlForget(req, res, url);
  if (route === 'clear' && req.method === 'POST') return handleDlClear(req, res);
  return sendJson(res, 404, { status: 'error', status_message: 'Unknown downloader endpoint.' });
}

export const tool = {
  id: 'downloader',
  name: 'Downloader',
  icon: '⬇️',
  blurb: 'Paste any video URL and pull it at the highest quality.',
  prefix: '/api/dl/',
  handle: handleDlApi,
  init: () => Promise.all([loadDlConfig(), loadJobHistory()]),
  async banner() {
    const t = await getTools();
    const missing = (what) => `not found — ${what}`;
    return [
      ['downloads', saveDir()],
      ['yt-dlp', t.ytdlp.found ? t.ytdlp.version : missing('open the Downloader tool')],
      ['ffmpeg', t.ffmpeg.found ? 'found' : missing('needed above 720p')],
      ['deno', t.deno.found ? 'found' : missing('some YouTube formats may be missing')],
    ];
  },
};
