// YTS Library Browser — a tiny zero-dependency server.
//
// It does two things:
//   1. Serves the static frontend from ./public
//   2. Proxies a small whitelist of YTS API endpoints (adding a short-lived
//      in-memory cache) so the browser never has to worry about CORS and we
//      stay polite to the upstream API.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const PORT = Number(process.env.PORT) || 8080;
const UPSTREAM = process.env.YTS_API || 'https://movies-api.accel.li/api/v2';

// Only these upstream endpoints may be reached through the proxy. This keeps it
// from becoming an open relay to arbitrary URLs.
const API_ENDPOINTS = {
  list_movies: 'list_movies.json',
  movie_details: 'movie_details.json',
  movie_suggestions: 'movie_suggestions.json',
  movie_parental_guides: 'movie_parental_guides.json',
};

// Cache upstream responses briefly so paging back and forth is instant and we
// don't hammer the API. Keyed by the full upstream URL (query params included).
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 300;
const cache = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': MIME['.json'], ...extraHeaders });
  res.end(body);
}

async function handleApi(res, url) {
  const name = url.pathname.replace(/^\/api\//, '');
  const endpoint = API_ENDPOINTS[name];
  if (!endpoint) {
    return sendJson(res, 404, {
      status: 'error',
      status_message: `Unknown endpoint "${name}". Allowed: ${Object.keys(API_ENDPOINTS).join(', ')}`,
    });
  }

  const upstreamUrl = `${UPSTREAM}/${endpoint}${url.search}`;

  const hit = cache.get(upstreamUrl);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'HIT' });
    return res.end(hit.body);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const upstream = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'yts-library-browser/1.0',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const body = await upstream.text();

    if (upstream.ok) {
      cache.set(upstreamUrl, { at: Date.now(), body });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }

    res.writeHead(upstream.status, { 'Content-Type': MIME['.json'], 'X-Cache': 'MISS' });
    res.end(body);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'Upstream request timed out' : err.message;
    sendJson(res, 502, { status: 'error', status_message: `Proxy error: ${reason}` });
  }
}

async function handleStatic(res, url) {
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

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { status: 'error', status_message: 'Bad request URL' });
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(res, url);
  } else {
    handleStatic(res, url);
  }
});

server.listen(PORT, () => {
  console.log(`\n  YTS Library Browser`);
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  upstream: ${UPSTREAM}\n`);
});
