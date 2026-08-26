// Reading what a media file actually is.
//
// Shared by the Converter (which offers operations based on it) and the Library
// Scanner (which inventories a folder of them). ffprobe returns clean JSON, but
// it only landed in bin/ once get-tools.ps1 started fetching it — and ffmpeg
// alone can still say everything we need, it just says it on stderr in prose.
// Both paths are supported so neither tool depends on a re-run.

import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { resolveBinary } from './core.mjs';

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif', 'heic']);
export const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'opus', 'flac', 'wav', 'ogg', 'wma', 'aiff']);
export const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts']);
export const SUB_EXT = new Set(['srt', 'ass', 'ssa', 'sub', 'vtt', 'idx', 'smi']);

export const extOf = (p) => extname(p || '').slice(1).toLowerCase();

export function kindFromExt(path) {
  const e = extOf(path);
  if (IMAGE_EXT.has(e)) return 'image';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (VIDEO_EXT.has(e)) return 'video';
  return 'other';
}

// --- Tools ---
let toolCache = null;

export async function getMediaTools(refresh) {
  if (!toolCache || refresh) {
    const [ffmpeg, ffprobe] = await Promise.all([
      resolveBinary('ffmpeg', '-version'),
      resolveBinary('ffprobe', '-version'),
    ]);
    toolCache = { ffmpeg, ffprobe };
  }
  return toolCache;
}

export function runCapture(cmd, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch { return resolve({ code: -1, out: '', err: '' }); }
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out, err }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function parseFfprobeJson(raw) {
  let json;
  try { json = JSON.parse(raw); } catch { return null; }
  const streams = json.streams || [];
  if (!streams.length) return null; // nothing ffprobe could identify
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const fmt = json.format || {};

  // A still image probes as a video stream with one frame and no real duration,
  // which is how an extension-less JPEG gets classified correctly.
  const duration = Number(fmt.duration) || Number(v && v.duration) || 0;
  const isStill = !!v && !a && (!duration || duration < 0.05);

  let fps = null;
  if (v && v.r_frame_rate && v.r_frame_rate.includes('/')) {
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    if (d) fps = Math.round((n / d) * 100) / 100;
  }

  return {
    duration,
    width: v ? v.width || null : null,
    height: v ? v.height || null : null,
    vcodec: v ? v.codec_name || null : null,
    acodec: a ? a.codec_name || null : null,
    fps,
    bitrate: Number(fmt.bit_rate) || null,
    audioTracks: streams.filter((s) => s.codec_type === 'audio').length,
    subTracks: streams.filter((s) => s.codec_type === 'subtitle').length,
    hasVideo: !!v && !isStill,
    hasAudio: !!a,
    isStill,
  };
}

// ffmpeg -i writes what it found to stderr and then exits non-zero because no
// output file was given. That non-zero exit is expected, not a failure.
function parseFfmpegStderr(err) {
  const dur = err.match(/Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;

  const vLine = err.match(/Stream #\d+:\d+.*: Video: ([a-zA-Z0-9_]+).*/);
  const aLine = err.match(/Stream #\d+:\d+.*: Audio: ([a-zA-Z0-9_]+).*/);
  const dims = vLine ? vLine[0].match(/,\s(\d{2,5})x(\d{2,5})/) : null;
  const fpsM = vLine ? vLine[0].match(/,\s*([\d.]+)\s*fps/) : null;
  const brM = err.match(/bitrate:\s*(\d+)\s*kb\/s/);

  // No streams at all means ffmpeg could not make sense of the file — a text
  // file named .mp4, a truncated download. Saying "video, 0x0" about it would
  // be worse than admitting it is unreadable.
  if (!vLine && !aLine) return null;

  const isStill = !!vLine && !aLine && (!duration || duration < 0.05);

  return {
    duration,
    width: dims ? Number(dims[1]) : null,
    height: dims ? Number(dims[2]) : null,
    vcodec: vLine ? vLine[1] : null,
    acodec: aLine ? aLine[1] : null,
    fps: fpsM ? Number(fpsM[1]) : null,
    bitrate: brM ? Number(brM[1]) * 1000 : null,
    audioTracks: (err.match(/: Audio: /g) || []).length,
    subTracks: (err.match(/: Subtitle: /g) || []).length,
    hasVideo: !!vLine && !isStill,
    hasAudio: !!aLine,
    isStill,
  };
}

// Everything a media file will admit to. Returns null when neither binary is
// available or the file is unreadable.
export async function probeMedia(path, tools) {
  const t = tools || await getMediaTools();
  let info = null;

  if (t.ffprobe.found) {
    const { out } = await runCapture(t.ffprobe.path, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', '--', path,
    ]);
    info = parseFfprobeJson(out);
  }
  if (!info && t.ffmpeg.found) {
    const { err } = await runCapture(t.ffmpeg.path, ['-hide_banner', '-i', path]);
    info = parseFfmpegStderr(err);
  }
  if (!info) return null;

  // The probe overrules the extension: a .mp4 holding only audio is audio.
  let kind = kindFromExt(path);
  if (info.isStill) kind = 'image';
  else if (info.hasVideo) kind = 'video';
  else if (info.hasAudio) kind = 'audio';

  return { ...info, kind };
}
