// Converter — a local front end for ffmpeg.
//
// The Downloader already ships ffmpeg to merge DASH streams; this exposes the
// rest of what that binary can do. Pick a file, the server probes it, and the
// browser is offered only the operations that make sense for what it is — you
// can't ask a JPEG for an audio track.
//
// Same shape as the downloader: the server owns the ffmpeg process and streams
// progress over SSE. Every spawn takes an argument array, never a shell string,
// so a file name full of quotes and semicolons is just a file name.

import { spawn } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { basename, extname, dirname, join } from 'node:path';
import { ROOT, sendJson, readBody, sameOrigin } from '../core.mjs';
import { probeMedia, getMediaTools, extOf } from '../probe.mjs';

const PS_EXE = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// --- Tools ---
// Probing lives in ../probe.mjs; the Library Scanner needs exactly the same
// reading of a file, so it is shared plumbing rather than a copy in each tool.
const getTools = getMediaTools;

// --- Where files go ---------------------------------------------------------
let lastOpenDir = null;

function pickPath(mode, opts = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DL_PICK_MODE: mode,
      DL_PICK_DIR: opts.dir || lastOpenDir || '',
      DL_PICK_NAME: opts.name || '',
      DL_PICK_FILTER: opts.filter || '',
      DL_PICK_MULTI: opts.multi ? '1' : '',
    };
    let child;
    try {
      if (process.platform === 'win32') {
        child = spawn(PS_EXE, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'pick-path.ps1')], { env, windowsHide: true });
      } else if (process.platform === 'darwin') {
        const script = mode === 'open'
          ? 'POSIX path of (choose file with prompt "Choose a file")'
          : 'POSIX path of (choose folder with prompt "Choose where to save")';
        child = spawn('osascript', ['-e', script], { env });
      } else {
        const args = ['--file-selection', '--title=Choose a file'];
        if (mode !== 'open') args.push('--save', '--confirm-overwrite');
        child = spawn('zenity', args, { env });
      }
    } catch {
      return resolve({ error: 'Could not open the file dialog.' });
    }
    if (opts.onSpawn) opts.onSpawn(child);

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve({ error: 'Could not open the file dialog.' }));
    child.on('close', (code) => {
      const chosen = out.trim();
      if (code !== 0 || !chosen) return resolve({ cancelled: true });
      resolve({ paths: chosen.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) });
    });
  });
}

const OPEN_FILTER = [
  'Media files|*.mp4;*.mkv;*.webm;*.mov;*.avi;*.m4v;*.mpg;*.ts;*.mp3;*.m4a;*.wav;*.flac;*.opus;*.ogg;*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.tif;*.tiff',
  'Video|*.mp4;*.mkv;*.webm;*.mov;*.avi;*.m4v;*.mpg;*.mpeg;*.ts;*.flv;*.wmv',
  'Audio|*.mp3;*.m4a;*.aac;*.wav;*.flac;*.opus;*.ogg;*.wma',
  'Images|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.tif;*.tiff;*.avif',
  'All files|*.*',
].join('|');

// Windows won't accept these in a file name.
function safeFileName(name) {
  return String(name || 'output')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'output';
}

// --- Operations -------------------------------------------------------------
// Each entry knows which kinds of input it applies to, what extension the
// result gets, and how to turn the request into ffmpeg arguments. Adding an
// operation means adding one entry here and one card in the client.

const CRF = { high: 18, good: 22, small: 28 };

function videoEncodeArgs(ext, quality) {
  const crf = CRF[quality] || CRF.good;
  if (ext === 'webm') return ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k'];
  return ['-c:v', 'libx264', '-crf', String(crf), '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'];
}

const AUDIO_CODEC = {
  mp3: ['-c:a', 'libmp3lame'],
  m4a: ['-c:a', 'aac'],
  opus: ['-c:a', 'libopus'],
  flac: ['-c:a', 'flac'],
  wav: ['-c:a', 'pcm_s16le'],
  ogg: ['-c:a', 'libvorbis'],
};

// Seconds from "90", "1:30" or "00:01:30.5".
function parseTime(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const OPS = {
  // Container / codec change, optionally without re-encoding.
  convert: {
    kinds: ['video'],
    label: 'Convert',
    ext: (o) => (['mp4', 'mkv', 'webm', 'mov', 'avi'].includes(o.format) ? o.format : 'mp4'),
    build(o, probe) {
      const ext = OPS.convert.ext(o);
      // Stream copy is instant and lossless, but only works when the existing
      // codecs are legal in the target container — WebM takes neither H.264
      // nor AAC, so asking for it always means a re-encode.
      const canCopy = o.mode === 'copy' && ext !== 'webm';
      if (canCopy) return ['-c', 'copy'];
      const args = videoEncodeArgs(ext, o.quality);
      if (o.height) args.unshift('-vf', `scale=-2:${clampInt(o.height, 120, 4320, 720)}`);
      return args;
    },
  },

  // Pull the audio track out, or transcode an audio file.
  audio: {
    kinds: ['video', 'audio'],
    label: 'Extract audio',
    ext: (o) => (AUDIO_CODEC[o.format] ? o.format : 'mp3'),
    build(o) {
      const ext = OPS.audio.ext(o);
      const args = ['-vn', ...AUDIO_CODEC[ext]];
      // FLAC and WAV are lossless; a bitrate flag is meaningless for them.
      if (ext !== 'flac' && ext !== 'wav') args.push('-b:a', `${clampInt(o.bitrate, 32, 512, 192)}k`);
      return args;
    },
  },

  // Keep a slice. Copy mode can only cut on keyframes, which is why the start
  // may land up to a second early — encoding is exact but slow.
  trim: {
    kinds: ['video', 'audio'],
    label: 'Trim',
    ext: (o, probe, input) => extOf(input) || 'mp4',
    build(o, probe) {
      const args = [];
      if (o.mode === 'copy') args.push('-c', 'copy');
      else if (probe.kind === 'audio') args.push('-c:a', 'aac', '-b:a', '192k');
      else args.push(...videoEncodeArgs('mp4', o.quality));
      return args;
    },
    // -ss and -to go before the input for a fast seek.
    pre(o) {
      const args = [];
      const start = parseTime(o.start);
      const end = parseTime(o.end);
      if (start != null) args.push('-ss', String(start));
      if (end != null) args.push('-to', String(end));
      return args;
    },
  },

  // Aim at a file size. One pass at a computed bitrate — two-pass would be
  // more accurate but twice as slow, and this lands close enough.
  compress: {
    kinds: ['video'],
    label: 'Compress to size',
    ext: (o, probe, input) => extOf(input) === 'webm' ? 'webm' : 'mp4',
    build(o, probe) {
      const targetMb = clampInt(o.targetMb, 1, 20_000, 10);
      const duration = probe.duration || 0;
      if (!duration) return videoEncodeArgs('mp4', 'small'); // no duration to divide by
      const audioKbps = 128;
      // 2% headroom for container overhead, then whatever is left is video.
      const totalKbps = (targetMb * 8192 * 0.98) / duration;
      const videoKbps = Math.max(64, Math.round(totalKbps - audioKbps));
      return [
        '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p',
        '-b:v', `${videoKbps}k`, '-maxrate', `${Math.round(videoKbps * 1.5)}k`,
        '-bufsize', `${videoKbps * 2}k`,
        '-c:a', 'aac', '-b:a', `${audioKbps}k`,
      ];
    },
  },

  // Resize, keeping the aspect ratio. -2 rounds to an even number, which H.264
  // requires; -1 can produce an odd height and fail the encode.
  scale: {
    kinds: ['video'],
    label: 'Resize',
    ext: (o, probe, input) => extOf(input) || 'mp4',
    build(o) {
      return ['-vf', `scale=-2:${clampInt(o.height, 120, 4320, 720)}`, ...videoEncodeArgs('mp4', o.quality), '-c:a', 'copy'];
    },
  },

  // Animated GIF from a slice. palettegen/paletteuse in one graph — the default
  // 216-colour web palette looks far worse than one built from the actual clip.
  gif: {
    kinds: ['video'],
    label: 'Make GIF',
    ext: () => 'gif',
    build(o) {
      const fps = clampInt(o.fps, 5, 50, 15);
      const width = clampInt(o.width, 80, 1920, 480);
      return [
        '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`,
        '-loop', '0', '-an',
      ];
    },
    pre(o) {
      const args = [];
      const start = parseTime(o.start);
      if (start != null) args.push('-ss', String(start));
      const dur = Number(o.duration);
      args.push('-t', String(Number.isFinite(dur) && dur > 0 ? Math.min(dur, 60) : 5));
      return args;
    },
  },

  // Drop the audio track without touching the video.
  mute: {
    kinds: ['video'],
    label: 'Remove audio',
    ext: (o, probe, input) => extOf(input) || 'mp4',
    build: () => ['-an', '-c:v', 'copy'],
  },

  // Stills. Quality means different things per encoder, so each gets its own.
  image: {
    kinds: ['image'],
    label: 'Convert image',
    ext: (o) => (['png', 'jpg', 'webp', 'bmp', 'tiff', 'avif'].includes(o.format) ? o.format : 'png'),
    build(o) {
      const ext = OPS.image.ext(o);
      const args = [];
      if (o.width) args.push('-vf', `scale=${clampInt(o.width, 16, 10_000, 1920)}:-1:flags=lanczos`);
      const q = clampInt(o.quality, 1, 100, 90);
      if (ext === 'jpg') {
        // ffmpeg's MJPEG scale is 2 (best) to 31 (worst) — invert the percentage.
        args.push('-q:v', String(Math.max(2, Math.round(31 - (q / 100) * 29))));
      } else if (ext === 'webp') {
        args.push('-quality', String(q));
      } else if (ext === 'avif') {
        args.push('-c:v', 'libaom-av1', '-crf', String(Math.round(63 - (q / 100) * 63)));
      } else if (ext === 'png') {
        args.push('-compression_level', '6');
      }
      args.push('-frames:v', '1');
      return args;
    },
  },
};

export function opsFor(kind) {
  return Object.entries(OPS)
    .filter(([, op]) => op.kinds.includes(kind))
    .map(([id, op]) => ({ id, label: op.label }));
}

// Two paths naming the same file, allowing for separator and drive-letter case.
function normPath(p) {
  const s = String(p || '').replace(/[\\/]+/g, '\\');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

// --- Jobs -------------------------------------------------------------------
let jobSeq = 0;
const jobs = new Map();
const JOBS_KEEP = 60;
const sseClients = new Set();
const JOB_LIVE = new Set(['picking', 'queued', 'starting', 'running']);

// Converting a folder full of files means asking for hundreds of jobs at once.
// Running them all would thrash the disk and leave every one of them crawling;
// two at a time finishes the batch sooner and keeps the machine usable.
const MAX_ACTIVE = 2;

let convActive = 0;
const convQueue = [];

function convSchedule(job, run) {
  if (convActive < MAX_ACTIVE) {
    convActive++;
    return run();
  }
  job.status = 'queued';
  broadcast(job);
  convQueue.push({ job, run });
  return undefined;
}

// Called on every path out of a job, however it ended, or the queue stalls with
// slots it thinks are still busy.
function convRelease() {
  for (;;) {
    const next = convQueue.shift();
    if (!next) { convActive = Math.max(0, convActive - 1); return; }
    // Cancelled while it sat in the queue: drop it and take the one behind.
    if (next.job.status === 'cancelled') continue;
    next.run();
    return;
  }
}

function publicJob(job) {
  const { child, picker, ...rest } = job;
  return rest;
}

const JOBS_PATH = join(ROOT, '.convert-jobs.json');
let jobSaveTimer = null;

async function loadJobHistory() {
  try {
    const saved = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
    if (!Array.isArray(saved)) return;
    for (const j of saved.slice(-JOBS_KEEP)) {
      if (!j || !j.id || JOB_LIVE.has(j.status)) continue;
      jobs.set(String(j.id), { ...j, child: null, picker: null });
      jobSeq = Math.max(jobSeq, Number(j.id) || 0);
    }
  } catch { /* first run — start clean */ }
}

function saveJobHistory() {
  clearTimeout(jobSaveTimer);
  jobSaveTimer = setTimeout(async () => {
    const finished = [...jobs.values()].filter((j) => !JOB_LIVE.has(j.status)).map(publicJob);
    try {
      await writeFile(JOBS_PATH, `${JSON.stringify(finished.slice(-JOBS_KEEP), null, 2)}\n`);
    } catch { /* history is a convenience */ }
  }, 400);
  if (jobSaveTimer.unref) jobSaveTimer.unref();
}

function broadcast(job) {
  const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`;
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
  res.write(`data: ${JSON.stringify({ hello: true })}\n\n`);
  sseClients.add(res);
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25_000);
  if (beat.unref) beat.unref(); // never a reason on its own to keep the process busy
  req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
}

function createJob(input, opId, opts, probe) {
  const id = String(++jobSeq);
  const job = {
    id,
    input,
    name: basename(input),
    op: opId,
    opLabel: (OPS[opId] && OPS[opId].label) || opId,
    // Kept so a failed or cancelled job can be replayed from the history list,
    // the same way the downloader's Retry works.
    opts,
    kind: probe.kind,
    duration: probe.duration || 0,
    status: 'starting',
    pct: 0,
    speed: null,
    outSize: null,
    output: null,
    folder: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}

function runJob(job, opId, opts, probe, tools, outPath) {
  if (job.status === 'cancelled') return convRelease();

  const op = OPS[opId];
  job.output = outPath;
  job.folder = dirname(outPath);

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-progress', 'pipe:1',
    '-nostats',
    '-y',
    ...(op.pre ? op.pre(opts, probe) : []),
    '-i', job.input,
    ...op.build(opts, probe, job.input),
    '--',
    outPath,
  ];

  const child = spawn(tools.ffmpeg.path, args, { windowsHide: true });
  job.child = child;
  job.status = 'running';
  broadcast(job);

  let stdoutBuf = '';
  let lastErr = '';

  // -progress emits key=value lines; how far into the source ffmpeg has reached,
  // measured against the probed duration, is the only percentage available —
  // ffmpeg never reports a total.
  //
  // Deliberately NOT out_time_ms: despite the name ffmpeg writes MICROseconds
  // into it, identical to out_time_us. Treating it as milliseconds overstates
  // progress by 1000x, and since it arrives immediately after out_time_us in
  // every block it silently overwrites the correct value — every job pinned at
  // 100% a second in. out_time is the unambiguous fallback.
  const onLine = (line) => {
    const eq = line.indexOf('=');
    if (eq < 0) return false;
    const key = line.slice(0, eq);
    const val = line.slice(eq + 1);
    if (key === 'out_time_us') {
      const secs = Number(val) / 1e6;
      if (Number.isFinite(secs) && job.duration) {
        job.pct = Math.min(100, Math.max(0, (secs / job.duration) * 100));
        return true;
      }
    } else if (key === 'out_time') {
      const m = val.match(/^(\d+):(\d\d):(\d\d(?:\.\d+)?)$/);
      if (m && job.duration) {
        const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        job.pct = Math.min(100, Math.max(0, (secs / job.duration) * 100));
        return true;
      }
    } else if (key === 'total_size') {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) { job.outSize = n; return true; }
    } else if (key === 'speed') {
      const n = parseFloat(val);
      if (Number.isFinite(n) && n > 0) { job.speed = n; return true; }
    }
    return false;
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop();
    let changed = false;
    for (const line of lines) if (line.trim() && onLine(line.trim())) changed = true;
    if (changed) broadcast(job);
  });

  // -loglevel error means anything on stderr is a real problem worth keeping.
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) lastErr = text.split('\n').pop().trim();
  });

  child.on('error', () => {
    job.child = null;
    job.status = 'error';
    job.error = 'Could not run ffmpeg.';
    job.finishedAt = Date.now();
    broadcast(job);
    saveJobHistory();
    convRelease();
  });

  child.on('close', async (code, signal) => {
    job.child = null;
    job.finishedAt = Date.now();
    if (job.status === 'cancelled' || signal) {
      job.status = 'cancelled';
    } else if (code === 0) {
      job.status = 'done';
      job.pct = 100;
      try { job.outSize = (await stat(outPath)).size; } catch { /* keep the streamed estimate */ }
    } else {
      job.status = 'error';
      job.error = lastErr || `ffmpeg exited with code ${code}.`;
    }
    broadcast(job);

    if (jobs.size > JOBS_KEEP) {
      for (const [key, j] of jobs) {
        if (jobs.size <= JOBS_KEEP) break;
        if (!JOB_LIVE.has(j.status)) jobs.delete(key);
      }
    }
    saveJobHistory();
    convRelease();
  });
}

// --- Routes -----------------------------------------------------------------

async function handlePickDir(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  const picked = await pickPath('folder', {});
  if (picked.error) return sendJson(res, 500, { status: 'error', status_message: picked.error });
  if (picked.cancelled) return sendJson(res, 200, { status: 'ok', data: { cancelled: true } });
  return sendJson(res, 200, { status: 'ok', data: { dir: picked.paths[0] } });
}

async function handlePick(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  const picked = await pickPath('open', { filter: OPEN_FILTER, multi: false });
  if (picked.error) return sendJson(res, 500, { status: 'error', status_message: picked.error });
  if (picked.cancelled) return sendJson(res, 200, { status: 'ok', data: { cancelled: true } });

  lastOpenDir = dirname(picked.paths[0]);
  return sendJson(res, 200, { status: 'ok', data: await describe(picked.paths[0]) });
}

async function describe(path) {
  const tools = await getTools();
  let size = null;
  try {
    const st = await stat(path);
    if (!st.isFile()) return { error: 'That is a folder, not a file.' };
    size = st.size;
  } catch {
    return { error: 'That file does not exist.' };
  }
  const probe = await probeMedia(path, tools);
  if (!probe) return { error: 'ffmpeg could not read that file.' };
  return {
    path,
    name: basename(path),
    dir: dirname(path),
    ext: extOf(path),
    size,
    ...probe,
    ops: opsFor(probe.kind),
  };
}

async function handleProbe(req, res, url) {
  const path = url.searchParams.get('path');
  if (!path) return sendJson(res, 400, { status: 'error', status_message: 'A path is required.' });
  const tools = await getTools();
  if (!tools.ffmpeg.found) {
    return sendJson(res, 503, { status: 'error', status_message: 'ffmpeg is not installed.', missing: 'ffmpeg' });
  }
  const data = await describe(path);
  if (data.error) return sendJson(res, 400, { status: 'error', status_message: data.error });
  return sendJson(res, 200, { status: 'ok', data });
}

async function handleStart(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    return sendJson(res, 415, { status: 'error', status_message: 'Expected application/json.' });
  }

  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch {
    return sendJson(res, 400, { status: 'error', status_message: 'Bad request body.' });
  }

  const tools = await getTools();
  if (!tools.ffmpeg.found) {
    return sendJson(res, 503, { status: 'error', status_message: 'ffmpeg is not installed.', missing: 'ffmpeg' });
  }

  const input = String(payload.input || '');
  const opId = String(payload.op || '');
  const op = OPS[opId];
  if (!op) return sendJson(res, 400, { status: 'error', status_message: 'Unknown operation.' });

  const described = await describe(input);
  if (described.error) return sendJson(res, 400, { status: 'error', status_message: described.error });
  if (!op.kinds.includes(described.kind)) {
    return sendJson(res, 400, { status: 'error', status_message: `${op.label} does not apply to ${described.kind} files.` });
  }

  const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : {};
  const job = createJob(input, opId, opts, described);

  // A retry replaces the row it was started from, so the history keeps one
  // entry per conversion rather than one per attempt.
  const retryOf = payload.retryOf == null ? null : String(payload.retryOf);
  const replaced = retryOf && retryOf !== job.id ? jobs.get(retryOf) : null;
  if (replaced && !JOB_LIVE.has(replaced.status)) {
    jobs.delete(retryOf);
    broadcast({ id: retryOf, removed: true });
    saveJobHistory();
  }

  // Answer before the dialog opens — it can sit there indefinitely, and
  // everything past this point reaches the browser over the event stream.
  sendJson(res, 200, { status: 'ok', data: publicJob(job) });
  broadcast(job);

  const outExt = op.ext(opts, described, input);

  // A caller that already knows where the result goes says so and skips the
  // dialog — that's how a batch ("convert this whole folder") stays one click
  // rather than one dialog per file. The interactive path is the default.
  let outPath = typeof payload.output === 'string' ? payload.output.trim() : '';

  // A batch names a destination folder once, or asks for each result to land
  // beside the file it came from, and the server works out the names.
  if (!outPath) {
    const dir = payload.sameFolder ? described.dir
      : (typeof payload.outDir === 'string' && payload.outDir.trim()) || '';
    if (dir) {
      const stem = safeFileName(basename(input, extname(input)));
      outPath = join(dir, `${stem}.${outExt}`);
      // Converting an mp4 to an mp4 beside itself would land on the input. Do
      // not make a batch of four hundred fail one file at a time over it.
      if (normPath(outPath) === normPath(input)) outPath = join(dir, `${stem} (converted).${outExt}`);
    }
  }

  if (!outPath) {
    job.status = 'picking';
    broadcast(job);

    const suggested = `${safeFileName(basename(input, extname(input)))}.${outExt}`;
    const picked = await pickPath('file', {
      dir: described.dir,
      name: suggested,
      onSpawn: (child) => { job.picker = child; },
    });
    job.picker = null;

    if (job.status === 'cancelled') {
      job.finishedAt = job.finishedAt || Date.now();
      broadcast(job);
      return saveJobHistory();
    }
    if (picked.cancelled || picked.error) {
      job.status = picked.error ? 'error' : 'cancelled';
      job.error = picked.error || null;
      job.finishedAt = Date.now();
      broadcast(job);
      return saveJobHistory();
    }
    outPath = picked.paths[0];
  }
  // The Save dialog lets you type any name; ffmpeg picks its encoder from the
  // extension, so a missing or wrong one has to be corrected or the run fails
  // with a muxer error that means nothing to the user.
  if (extOf(outPath) !== outExt) outPath = `${outPath.replace(/\.[^.\\/]*$/, '')}.${outExt}`;
  if (outPath === input) {
    job.status = 'error';
    job.error = 'The output would overwrite the input. Choose a different name.';
    job.finishedAt = Date.now();
    broadcast(job);
    return saveJobHistory();
  }

  return convSchedule(job, () => runJob(job, opId, opts, described, tools, outPath));
}

function handleCancel(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  const job = jobs.get(url.searchParams.get('job'));
  if (!job) return sendJson(res, 404, { status: 'error', status_message: 'No such job.' });
  const proc = job.child || job.picker;
  if (proc) {
    job.status = 'cancelled';
    proc.kill();
  } else if (JOB_LIVE.has(job.status)) {
    // Cancelled in the gap between the dialog closing and ffmpeg spawning —
    // nothing else will ever close this one out.
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    broadcast(job);
    saveJobHistory();
  }
  sendJson(res, 200, { status: 'ok', data: publicJob(job) });
}

function handleReveal(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  const job = jobs.get(url.searchParams.get('job'));
  const file = job && job.output;
  const folder = (job && job.folder) || lastOpenDir;
  if (!file && !folder) return sendJson(res, 200, { status: 'ok' });
  try {
    if (process.platform === 'win32') {
      spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'reveal.ps1')], {
        env: { ...process.env, DL_REVEAL_PATH: file || folder, DL_REVEAL_SELECT: file ? '1' : '0' },
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', file ? ['-R', file] : [folder], { detached: true }).unref();
    } else {
      spawn('xdg-open', [file ? dirname(file) : folder], { detached: true }).unref();
    }
  } catch { /* best effort */ }
  sendJson(res, 200, { status: 'ok' });
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/convert\/?/, '');
  if (route === 'tools') {
    const tools = await getTools(url.searchParams.get('refresh') === '1');
    return sendJson(res, 200, { status: 'ok', data: { ...tools, platform: process.platform } });
  }
  if (route === 'events') return handleEvents(req, res);
  if (route === 'jobs') {
    return sendJson(res, 200, { status: 'ok', data: { jobs: [...jobs.values()].map(publicJob).reverse() } });
  }
  if (route === 'probe') return handleProbe(req, res, url);
  if (route === 'pick' && req.method === 'POST') return handlePick(req, res);
  if (route === 'pickdir' && req.method === 'POST') return handlePickDir(req, res);
  if (route === 'start' && req.method === 'POST') return handleStart(req, res);
  if (route === 'cancel' && req.method === 'POST') return handleCancel(req, res, url);
  if (route === 'reveal' && req.method === 'POST') return handleReveal(req, res, url);
  return sendJson(res, 404, { status: 'error', status_message: 'Unknown converter endpoint.' });
}

export const tool = {
  id: 'convert',
  name: 'Converter',
  icon: '🎛️',
  blurb: 'Convert, trim, resize and compress video, audio and images.',
  prefix: '/api/convert/',
  handle: handleApi,
  init: () => loadJobHistory(),
  async banner() {
    const t = await getTools();
    return [
      ['ffprobe', t.ffprobe.found ? 'found' : 'not found — falling back to ffmpeg -i'],
    ];
  },
};
