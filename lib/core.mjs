// Shared plumbing every tool leans on.
//
// Nothing here knows about movies, yt-dlp or Reddit — it's the JSON reply
// helpers, the request-body reader, the same-origin guard, a small upstream
// response cache, and the static file server for ./public.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PUBLIC_DIR = join(ROOT, 'public');

export const PORT = Number(process.env.PORT) || 8080;
// Loopback by default: the downloader can spawn processes, so it must not be
// reachable from the rest of the network. Set HOST=0.0.0.0 to override.
export const HOST = process.env.HOST || '127.0.0.1';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': MIME['.json'], ...extraHeaders });
  res.end(body);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 100_000) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Cross-origin pages must not be able to drive the tools. Browsers always send
// Origin on POST (fetch and form alike), so checking it is enough here.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client, or a same-origin GET
  try {
    const host = new URL(origin).host;
    return host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}` || host === `[::1]:${PORT}`;
  } catch { return false; }
}

// --- Binary discovery: the project's own ./bin first, then PATH ---
// get-tools.ps1 drops yt-dlp, ffmpeg and deno into a gitignored bin/ so nothing
// has to be installed system-wide; falling through to PATH means a winget or
// brew install works just as well. ffmpeg and friends want '-version' with one
// dash, everything else wants two.
export const BIN_DIR = join(ROOT, 'bin');

function binaryVersion(cmd, versionFlag) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [versionFlag], { windowsHide: true });
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

export async function resolveBinary(name, versionFlag = '--version') {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const cmd of [join(BIN_DIR, exe), exe]) {
    const version = await binaryVersion(cmd, versionFlag);
    if (version) return { found: true, path: cmd, version };
  }
  return { found: false, path: null, version: null };
}

export function stripHtml(s) {
  if (!s) return '';
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Cache upstream responses briefly so paging back and forth is instant and we
// don't hammer the API. Keyed by the full upstream URL (query params included).
export const CACHE_TTL_MS = 60_000;
export const CACHE_MAX = 300;
export const cache = new Map();

export async function handleStatic(res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = normalize(join(PUBLIC_DIR, pathname));
  // Reject anything that escaped the public directory (path traversal).
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}
