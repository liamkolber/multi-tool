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

// --- AniList (anime) integration --------------------------------------------
// Public GraphQL API, no key required. We call it server-side and normalise the
// result into the same shape the frontend uses for movies.
const ANILIST_URL = 'https://graphql.anilist.co';

const ANIME_SORTS = {
  match: 'SEARCH_MATCH',
  trending: 'TRENDING_DESC',
  popularity: 'POPULARITY_DESC',
  score: 'SCORE_DESC',
  newest: 'START_DATE_DESC',
  title: 'TITLE_ROMAJI',
};

const ANIME_FIELDS = `
      id
      idMal
      title { romaji english }
      seasonYear
      averageScore
      genres
      format
      episodes
      status
      description(asHtml: false)
      coverImage { extraLarge large color }
      siteUrl
      trailer { id site }
      studios(isMain: true) { nodes { name } }
      externalLinks { site url type }`;

// AniList treats an explicit `null` for a filter arg (search, genre, format,
// averageScore_greater) as a real constraint that returns almost nothing — it
// does NOT ignore it. So include each argument only when it has a value.
function buildAnimeQuery(use) {
  const varDecls = ['$page: Int', '$perPage: Int', '$sort: [MediaSort]'];
  const mediaArgs = ['type: ANIME', 'sort: $sort'];
  if (use.adult === 'adult') mediaArgs.push('isAdult: true');       // 18+ only
  else if (use.adult !== 'all') mediaArgs.push('isAdult: false');   // default: SFW
  if (use.search) { varDecls.push('$search: String'); mediaArgs.push('search: $search'); }
  if (use.genre) { varDecls.push('$genre: String'); mediaArgs.push('genre: $genre'); }
  if (use.tag) { varDecls.push('$tag: String'); mediaArgs.push('tag: $tag'); }
  if (use.format) { varDecls.push('$format: MediaFormat'); mediaArgs.push('format: $format'); }
  if (use.score) { varDecls.push('$scoreGreater: Int'); mediaArgs.push('averageScore_greater: $scoreGreater'); }
  if (use.status) { varDecls.push('$status: MediaStatus'); mediaArgs.push('status: $status'); }
  return `
query (${varDecls.join(', ')}) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage hasNextPage }
    media(${mediaArgs.join(', ')}) {${ANIME_FIELDS}
    }
  }
}`;
}

function stripHtml(s) {
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

function normalizeAnime(m) {
  const en = m.title && m.title.english;
  const ro = m.title && m.title.romaji;
  const links = m.externalLinks || [];
  return {
    source: 'anime',
    id: m.id,
    malId: m.idMal || null,
    title: en || ro || 'Untitled',
    title_secondary: en && ro && en !== ro ? ro : null,
    year: m.seasonYear || null,
    rating: typeof m.averageScore === 'number' ? Math.round(m.averageScore) / 10 : null,
    poster: (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || null,
    color: (m.coverImage && m.coverImage.color) || null,
    genres: m.genres || [],
    format: m.format || null,
    episodes: m.episodes || null,
    status: m.status || null,
    summary: stripHtml(m.description),
    siteUrl: m.siteUrl || null,
    trailer: m.trailer && m.trailer.id ? { site: m.trailer.site, id: m.trailer.id } : null,
    studio: (m.studios && m.studios.nodes && m.studios.nodes[0] && m.studios.nodes[0].name) || null,
    streaming: links.filter((l) => l.type === 'STREAMING').map((l) => ({ site: l.site, url: l.url })),
    info: links.filter((l) => l.type === 'INFO').map((l) => ({ site: l.site, url: l.url })),
  };
}

// Full detail for a single anime (characters, relations, tags, extra stats) —
// fetched lazily when the modal opens so search payloads stay small.
const ANIME_DETAILS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {${ANIME_FIELDS}
    season
    duration
    source
    bannerImage
    tags { name isMediaSpoiler isGeneralSpoiler }
    characters(sort: [ROLE, RELEVANCE], perPage: 12) {
      edges {
        role
        node { name { full } image { medium } }
        voiceActors(language: JAPANESE) { name { full } image { medium } }
      }
    }
    relations {
      edges {
        relationType(version: 2)
        node {
          id type idMal format seasonYear
          title { romaji english }
          coverImage { large medium }
        }
      }
    }
  }
}`;

const TITLE_CASE = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);
const SOURCE_LABELS = {
  MANGA: 'Manga', LIGHT_NOVEL: 'Light novel', WEB_NOVEL: 'Web novel', NOVEL: 'Novel',
  ORIGINAL: 'Original', VISUAL_NOVEL: 'Visual novel', VIDEO_GAME: 'Video game',
  DOUJINSHI: 'Doujinshi', ANIME: 'Anime', LIVE_ACTION: 'Live action', GAME: 'Game',
  MULTIMEDIA_PROJECT: 'Multimedia', PICTURE_BOOK: 'Picture book', OTHER: null,
};
const RELATION_LABELS = {
  PREQUEL: 'Prequel', SEQUEL: 'Sequel', SIDE_STORY: 'Side story', PARENT: 'Parent story',
  SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternative', SUMMARY: 'Summary', CHARACTER: 'Character',
  ADAPTATION: 'Adaptation', CONTAINS: 'Contains', SOURCE: 'Source', OTHER: 'Related',
};

function normalizeAnimeDetails(m) {
  const base = normalizeAnime(m);
  return {
    ...base,
    season: m.season && m.seasonYear ? `${TITLE_CASE(m.season)} ${m.seasonYear}` : (base.year ? String(base.year) : null),
    source: SOURCE_LABELS[m.source] ?? (m.source ? TITLE_CASE(m.source) : null),
    duration: m.duration || null,
    banner: m.bannerImage || null,
    tags: (m.tags || []).filter((t) => !t.isMediaSpoiler && !t.isGeneralSpoiler).slice(0, 8).map((t) => t.name),
    characters: ((m.characters && m.characters.edges) || []).map((e) => ({
      name: (e.node && e.node.name && e.node.name.full) || '',
      image: (e.node && e.node.image && e.node.image.medium) || null,
      role: e.role ? TITLE_CASE(e.role) : null,
      va: e.voiceActors && e.voiceActors[0]
        ? { name: e.voiceActors[0].name && e.voiceActors[0].name.full, image: e.voiceActors[0].image && e.voiceActors[0].image.medium }
        : null,
    })),
    relations: ((m.relations && m.relations.edges) || [])
      .filter((e) => e.node && e.node.type === 'ANIME')
      .map((e) => ({
        id: e.node.id,
        title: (e.node.title && (e.node.title.english || e.node.title.romaji)) || 'Untitled',
        poster: (e.node.coverImage && (e.node.coverImage.large || e.node.coverImage.medium)) || null,
        format: e.node.format || null,
        year: e.node.seasonYear || null,
        relationType: RELATION_LABELS[e.relationType] || (e.relationType ? TITLE_CASE(e.relationType) : 'Related'),
      })),
  };
}

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

async function handleAnimeSearch(res, url) {
  const q = url.searchParams;
  const searchVal = q.get('q') || null;
  const genreVal = q.get('genre') || null;
  const tagVal = q.get('tag') || null;
  const formatVal = q.get('format') || null;
  const statusVal = q.get('status') || null;
  const scoreGreater = q.get('min_score') ? Number(q.get('min_score')) : null;

  const variables = {
    page: Number(q.get('page')) || 1,
    perPage: Math.min(Number(q.get('perPage')) || 24, 50),
    sort: [ANIME_SORTS[q.get('sort')] || (searchVal ? 'SEARCH_MATCH' : 'POPULARITY_DESC')],
  };
  if (searchVal != null) variables.search = searchVal;
  if (genreVal != null) variables.genre = genreVal;
  if (tagVal != null) variables.tag = tagVal;
  if (formatVal != null) variables.format = formatVal;
  if (statusVal != null) variables.status = statusVal;
  if (scoreGreater != null) variables.scoreGreater = scoreGreater;

  const audience = q.get('audience'); // 'sfw' (default) | 'adult' | 'all'
  const query = buildAnimeQuery({
    search: searchVal != null,
    genre: genreVal != null,
    tag: tagVal != null,
    format: formatVal != null,
    status: statusVal != null,
    score: scoreGreater != null,
    adult: audience === 'adult' ? 'adult' : (audience === 'all' ? 'all' : 'sfw'),
  });

  // audience changes the query (isAdult) but not `variables`, so key on it too.
  const cacheKey = 'anime:' + (audience || 'sfw') + ':' + JSON.stringify(variables);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'HIT' });
    return res.end(hit.body);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const upstream = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'yts-library-browser/1.0',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const raw = await upstream.json();
    if (raw.errors) {
      return sendJson(res, 502, {
        status: 'error',
        status_message: raw.errors.map((e) => e.message).join('; '),
      });
    }

    const pg = raw.data.Page;
    const payload = {
      status: 'ok',
      data: {
        page: pg.pageInfo.currentPage,
        hasNextPage: pg.pageInfo.hasNextPage,
        total: pg.pageInfo.total,
        items: pg.media.map(normalizeAnime),
      },
    };
    const body = JSON.stringify(payload);
    cache.set(cacheKey, { at: Date.now(), body });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);

    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'MISS' });
    res.end(body);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'AniList request timed out' : err.message;
    sendJson(res, 502, { status: 'error', status_message: `AniList proxy error: ${reason}` });
  }
}

const malScoreCache = new Map();

// Optional MAL supplement: fetch a title's MyAnimeList score via the Jikan API
// (AniList gives us the MAL id). Cached per id for the process lifetime.
async function handleMalScore(res, url) {
  const id = url.searchParams.get('id');
  if (!id) return sendJson(res, 400, { status: 'error', status_message: 'missing id' });
  if (malScoreCache.has(id)) {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'HIT' });
    return res.end(malScoreCache.get(id));
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const upstream = await fetch(`https://api.jikan.moe/v4/anime/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'yts-library-browser/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      return sendJson(res, 502, { status: 'error', status_message: `Jikan HTTP ${upstream.status}` });
    }
    const raw = await upstream.json();
    const d = raw.data || {};
    // MAL's content rating, e.g. "PG-13 - Teens 13 or older" -> "PG-13".
    const rating = d.rating ? String(d.rating).split(' - ')[0] : null;
    const body = JSON.stringify({
      status: 'ok',
      data: { score: d.score ?? null, rating, url: d.url || `https://myanimelist.net/anime/${id}` },
    });
    malScoreCache.set(id, body);
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'MISS' });
    res.end(body);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'Jikan request timed out' : err.message;
    sendJson(res, 502, { status: 'error', status_message: `Jikan proxy error: ${reason}` });
  }
}

async function handleAnimeDetails(res, url) {
  const id = Number(url.searchParams.get('id'));
  if (!id) return sendJson(res, 400, { status: 'error', status_message: 'missing id' });

  const cacheKey = `anime_details:${id}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'HIT' });
    return res.end(hit.body);
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const upstream = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'yts-library-browser/1.0' },
      body: JSON.stringify({ query: ANIME_DETAILS_QUERY, variables: { id } }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const raw = await upstream.json();
    if (raw.errors) {
      return sendJson(res, 502, { status: 'error', status_message: raw.errors.map((e) => e.message).join('; ') });
    }
    if (!raw.data || !raw.data.Media) {
      return sendJson(res, 404, { status: 'error', status_message: 'Anime not found' });
    }
    const body = JSON.stringify({ status: 'ok', data: { anime: normalizeAnimeDetails(raw.data.Media) } });
    cache.set(cacheKey, { at: Date.now(), body });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);

    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'MISS' });
    res.end(body);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'AniList request timed out' : err.message;
    sendJson(res, 502, { status: 'error', status_message: `AniList proxy error: ${reason}` });
  }
}

let animeGenresCache = null;

// Returns AniList's own genre list (their GenreCollection) so the Anime tab's
// genre filter matches AniList exactly. Cached for the process lifetime.
async function handleAnimeGenres(res) {
  if (animeGenresCache) {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'HIT' });
    return res.end(animeGenresCache);
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const upstream = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'yts-library-browser/1.0',
      },
      body: JSON.stringify({ query: '{ GenreCollection }' }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const raw = await upstream.json();
    if (raw.errors) {
      return sendJson(res, 502, { status: 'error', status_message: raw.errors.map((e) => e.message).join('; ') });
    }
    // We always query media with isAdult:false, so drop the adult-only genre.
    const genres = (raw.data.GenreCollection || []).filter((g) => g !== 'Hentai');
    animeGenresCache = JSON.stringify({ status: 'ok', data: { genres } });

    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'MISS' });
    res.end(animeGenresCache);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'AniList request timed out' : err.message;
    sendJson(res, 502, { status: 'error', status_message: `AniList proxy error: ${reason}` });
  }
}

let animeTagsCache = null;

// AniList's tag collection (grouped by category) for the Anime "Tag" filter.
async function handleAnimeTags(res) {
  if (animeTagsCache) {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'HIT' });
    return res.end(animeTagsCache);
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const upstream = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'yts-library-browser/1.0' },
      body: JSON.stringify({ query: '{ MediaTagCollection { name category isAdult isGeneralSpoiler } }' }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const raw = await upstream.json();
    if (raw.errors) {
      return sendJson(res, 502, { status: 'error', status_message: raw.errors.map((e) => e.message).join('; ') });
    }
    // Drop only general-spoiler tags (adult tags are allowed); sort by category
    // then name so the frontend can build <optgroup>s in a single pass.
    const tags = (raw.data.MediaTagCollection || [])
      .filter((t) => !t.isGeneralSpoiler)
      .map((t) => ({ name: t.name, category: t.category || 'Other' }))
      .sort((a, b) => (a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category)));
    animeTagsCache = JSON.stringify({ status: 'ok', data: { tags } });

    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'MISS' });
    res.end(animeTagsCache);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'AniList request timed out' : err.message;
    sendJson(res, 502, { status: 'error', status_message: `AniList proxy error: ${reason}` });
  }
}

// Batched relations for a set of anime ids (one aliased query) — powers the
// series "Story order" sort. Only ids/relationTypes are returned.
async function handleAnimeRelations(res, url) {
  const idsParam = url.searchParams.get('ids') || '';
  const ids = [...new Set(idsParam.split(',').map((s) => Number(s.trim())).filter(Boolean))].slice(0, 50);
  if (!ids.length) return sendJson(res, 400, { status: 'error', status_message: 'missing ids' });

  const cacheKey = `relations:${ids.slice().sort((a, b) => a - b).join(',')}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'HIT' });
    return res.end(hit.body);
  }

  const query = 'query {\n' +
    ids.map((id) => `m${id}: Media(id:${id}){ id relations { edges { relationType(version:2) node { id } } } }`).join('\n') +
    '\n}';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const upstream = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'yts-library-browser/1.0' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const raw = await upstream.json();
    if (raw.errors) {
      return sendJson(res, 502, { status: 'error', status_message: raw.errors.map((e) => e.message).join('; ') });
    }
    const relations = {};
    for (const id of ids) {
      const m = raw.data ? raw.data[`m${id}`] : null;
      relations[id] = m && m.relations
        ? (m.relations.edges || []).map((e) => ({ to: e.node && e.node.id, type: e.relationType })).filter((x) => x.to)
        : [];
    }
    const body = JSON.stringify({ status: 'ok', data: { relations } });
    cache.set(cacheKey, { at: Date.now(), body });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);

    res.writeHead(200, { 'Content-Type': MIME['.json'], 'X-Cache': 'MISS' });
    res.end(body);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'AniList request timed out' : err.message;
    sendJson(res, 502, { status: 'error', status_message: `AniList proxy error: ${reason}` });
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

  if (url.pathname === '/api/anime_search') {
    handleAnimeSearch(res, url);
  } else if (url.pathname === '/api/anime_details') {
    handleAnimeDetails(res, url);
  } else if (url.pathname === '/api/anime_genres') {
    handleAnimeGenres(res);
  } else if (url.pathname === '/api/anime_tags') {
    handleAnimeTags(res);
  } else if (url.pathname === '/api/anime_relations') {
    handleAnimeRelations(res, url);
  } else if (url.pathname === '/api/mal_score') {
    handleMalScore(res, url);
  } else if (url.pathname.startsWith('/api/')) {
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
