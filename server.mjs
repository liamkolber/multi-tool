// Liam's Multi-Tool — a tiny zero-dependency server that hosts a set of tools.
//
// The server itself knows almost nothing. It serves ./public, exposes the tool
// manifest at /api/tools, and hands every other /api/ request to whichever tool
// claims that path prefix. Adding a tool means dropping one file in lib/tools/
// and one in public/tools/, then listing it below — nothing here changes shape.

import { createServer } from 'node:http';
import { PORT, HOST, sendJson, handleStatic } from './lib/core.mjs';

import { tool as media } from './lib/tools/media.mjs';
import { tool as downloader } from './lib/tools/downloader.mjs';
import { tool as convert } from './lib/tools/convert.mjs';
import { tool as library } from './lib/tools/library.mjs';
import { tool as manga } from './lib/tools/manga.mjs';
import { tool as reddit } from './lib/tools/reddit.mjs';

export const APP_NAME = "Liam's Multi-Tool";

// Longest prefix first, so '/api/reddit/' wins over the media tool's '/api/'.
const TOOLS = [media, downloader, convert, library, manga, reddit].sort((a, b) => b.prefix.length - a.prefix.length);

// The tools that have a server half. A tool needs one only if it does something
// the browser cannot — Utilities is entirely client-side and so appears in the
// rail (from public/app.js) without appearing here.
function handleToolManifest(res) {
  sendJson(res, 200, {
    status: 'ok',
    data: {
      app: APP_NAME,
      tools: TOOLS.map(({ id, name, icon, blurb }) => ({ id, name, icon, blurb })),
    },
  });
}

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { status: 'error', status_message: 'Bad request URL' });
  }

  if (url.pathname === '/api/tools') return handleToolManifest(res);

  const owner = TOOLS.find((t) => url.pathname.startsWith(t.prefix));
  if (owner) return owner.handle(req, res, url);

  return handleStatic(res, url);
});

server.listen(PORT, HOST, async () => {
  await Promise.all(TOOLS.map((t) => t.init?.()));
  const lines = (await Promise.all(TOOLS.map((t) => t.banner?.() ?? []))).flat();
  const width = Math.max(...lines.map(([k]) => k.length), 0);
  console.log(`\n  ${APP_NAME}`);
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  tools:${' '.repeat(Math.max(0, width - 5))}  ${TOOLS.map((t) => t.name).join(', ')}`);
  lines.forEach(([k, v]) => console.log(`  ${k}:${' '.repeat(width - k.length)}  ${v}`));
  console.log('');
});
