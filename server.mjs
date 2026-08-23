// YTS Library Browser — a tiny zero-dependency server.
//
// It does two things:
//   1. Serves the static frontend from ./public
//   2. Proxies a small whitelist of YTS API endpoints (adding a short-lived
//      in-memory cache) so the browser never has to worry about CORS and we
//      stay polite to the upstream API.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, basename, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const PORT = Number(process.env.PORT) || 8080;
// Loopback by default: the downloader can spawn processes, so it must not be
// reachable from the rest of the network. Set HOST=0.0.0.0 to override.
const HOST = process.env.HOST || '127.0.0.1';
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
      nextAiringEpisode { episode }
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
    nextEpisode: (m.nextAiringEpisode && m.nextAiringEpisode.episode) || null,
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

// --- YTS cross-language movie search -----------------------------------------
// YTS only searches the titles it stores, so an English title that differs from
// the stored (often original-language) title returns nothing. Bridge via IMDb's
// public suggestion endpoint: English title -> IMDb id -> YTS lookup by id.

async function ytsFetchData(qs) {
  const upstreamUrl = `${UPSTREAM}/list_movies.json${qs}`;
  const hit = cache.get(upstreamUrl);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    try { return JSON.parse(hit.body).data || { movie_count: 0, movies: [] }; } catch { /* refetch */ }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const r = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'yts-library-browser/1.0', Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await r.text();
    if (r.ok) {
      cache.set(upstreamUrl, { at: Date.now(), body });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return JSON.parse(body).data || { movie_count: 0, movies: [] };
  } catch {
    return { movie_count: 0, movies: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function imdbSuggest(term) {
  const key = `imdb:${term.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) { try { return JSON.parse(hit.body); } catch { /* refetch */ } }
  const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(term)}.json?includeVideos=0`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    if (!r.ok) return [];
    const j = await r.json();
    const ids = (j.d || []).map((x) => x && x.id)
      .filter((id) => typeof id === 'string' && id.startsWith('tt')).slice(0, 5);
    cache.set(key, { at: Date.now(), body: JSON.stringify(ids) });
    return ids;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function handleMovieSearch(res, url) {
  const q = url.searchParams;
  const term = q.get('query_term') || '';
  const page = Number(q.get('page')) || 1;
  // Run the IMDb bridge ALONGSIDE the YTS search on every text search (page 1
  // only, so pagination stays coherent) — a close "regular" match must not hide
  // the international film with a near-identical title. YTS + bridge run in
  // parallel; the bridge only contributes films YTS's own search missed.
  const bridge = /[a-z]/i.test(term) && !term.startsWith('tt') && page === 1;

  const [primary, ids] = await Promise.all([
    ytsFetchData(url.search),
    bridge ? imdbSuggest(term) : Promise.resolve([]),
  ]);

  if (!bridge || !ids.length) {
    return sendJson(res, 200, { status: 'ok', data: primary });
  }

  const movies = (primary.movies || []).slice();
  const seen = new Set(movies.map((m) => m.id));
  // Look each IMDb id up on YTS, carrying the same filters (genre/quality/etc.).
  const found = await Promise.all(ids.map((id) => {
    const p = new URLSearchParams(q);
    p.set('query_term', id);
    p.delete('page');
    return ytsFetchData('?' + p.toString());
  }));
  let bridged = 0;
  for (const d of found) {
    for (const m of (d.movies || [])) {
      if (!seen.has(m.id)) { seen.add(m.id); movies.push(m); bridged++; }
    }
  }

  const primaryCount = primary.movie_count || 0;
  sendJson(res, 200, {
    status: 'ok',
    data: {
      movie_count: primaryCount > 0 ? primaryCount : movies.length,
      limit: primary.limit || 20,
      page_number: 1,
      movies,
      bridged,
    },
  });
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

// --- Anime rating filter (MAL tiers via Jikan, re-hydrated from AniList) ------
// AniList has no rating; MAL does. We pull MAL ids at the requested tier(s) from
// Jikan, then re-hydrate the rich data from AniList via idMal_in.
const RATING_TIER_ORDER = ['g', 'pg', 'pg13', 'r17', 'r'];

async function jikanByRating(rating, page, q, perPage) {
  const p = new URLSearchParams({
    rating, order_by: 'members', sort: 'desc', page: String(page), limit: String(perPage), sfw: 'true',
  });
  if (q) p.set('q', q);
  const url = `https://api.jikan.moe/v4/anime?${p.toString()}`;
  const key = `jikan:${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) { try { return JSON.parse(hit.body); } catch { /* refetch */ } }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'yts-library-browser/1.0' }, signal: controller.signal });
    if (!r.ok) return { ids: [], hasNext: false };
    const j = await r.json();
    const out = {
      ids: (j.data || []).map((a) => a.mal_id).filter(Boolean),
      hasNext: !!(j.pagination && j.pagination.has_next_page),
    };
    cache.set(key, { at: Date.now(), body: JSON.stringify(out) });
    return out;
  } catch {
    return { ids: [], hasNext: false };
  } finally {
    clearTimeout(timer);
  }
}

async function anilistByMalIds(malIds) {
  if (!malIds.length) return {};
  const query = `query ($ids: [Int]) { Page(perPage: 50) { media(idMal_in: $ids, type: ANIME) {${ANIME_FIELDS}} } }`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const r = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'yts-library-browser/1.0' },
      body: JSON.stringify({ query, variables: { ids: malIds } }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const j = await r.json();
    const media = (j.data && j.data.Page && j.data.Page.media) || [];
    const byMal = {};
    media.forEach((m) => { if (m.idMal) byMal[m.idMal] = normalizeAnime(m); });
    return byMal;
  } catch {
    return {};
  }
}

async function handleAnimeByRating(res, url) {
  const q = url.searchParams;
  const tier = q.get('tier') || 'r17';
  const page = Number(q.get('page')) || 1;
  const search = q.get('q') || '';
  const start = RATING_TIER_ORDER.indexOf(tier);
  const buckets = start >= 0 ? RATING_TIER_ORDER.slice(start) : ['r17', 'r']; // "and up"
  const perPage = Math.max(6, Math.ceil(24 / buckets.length));

  // Sequential (not parallel) to respect Jikan's ~3 req/sec rate limit.
  const perBucket = [];
  for (const b of buckets) perBucket.push(await jikanByRating(b, page, search, perPage));
  // Interleave ids across tiers so the page blends them by popularity.
  const ordered = [];
  const maxLen = Math.max(0, ...perBucket.map((b) => b.ids.length));
  for (let i = 0; i < maxLen; i++) for (const b of perBucket) if (i < b.ids.length) ordered.push(b.ids[i]);
  const hasNext = perBucket.some((b) => b.hasNext);

  const byMal = await anilistByMalIds(ordered.slice(0, 50));
  const items = ordered.map((id) => byMal[id]).filter(Boolean);

  sendJson(res, 200, { status: 'ok', data: { items, page, hasNextPage: hasNext, total: null } });
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
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client, or a same-origin GET
  try {
    const host = new URL(origin).host;
    return host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}` || host === `[::1]:${PORT}`;
  } catch { return false; }
}

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
    const [ytdlp, ffmpeg] = await Promise.all([resolveTool('yt-dlp'), resolveTool('ffmpeg')]);
    toolCache = { ytdlp, ffmpeg };
  }
  return toolCache;
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

  const child = spawn(tools.ytdlp.path, ['-J', '--no-warnings', '--flat-playlist', '--', target.url], {
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
  req.on('close', () => { clearInterval(beat); sseClients.delete(res); });
}

function readBody(req) {
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
    preferMp4: !!payload.preferMp4,
    playlist: !!payload.playlist && !thumbnailOnly,
    title: payload.title,
    thumbnail: payload.thumbnail,
  };
  const job = createJob(target.url, opts);

  // Answer now rather than after the dialog: it can sit open indefinitely, and
  // everything from here on reaches the browser over the event stream anyway.
  sendJson(res, 200, { status: 'ok', data: publicJob(job) });
  broadcast(job);

  job.status = 'picking';
  broadcast(job);

  // Save-as needs a file name; a playlist writes many files, so it needs a folder.
  const mode = opts.playlist || process.platform !== 'win32' ? 'folder' : 'file';
  // The thumbnail keeps whatever format the host serves, so suggest that
  // extension rather than a video container.
  const suggestedExt = thumbnailOnly
    ? (/^[a-z0-9]{2,5}$/i.test(payload.thumbExt || '') ? String(payload.thumbExt).toLowerCase() : 'jpg')
    : containerFor(null, opts);
  const suggested = mode === 'file' ? safeFileName(payload.title, suggestedExt) : '';
  const picked = await pickDestination(mode, suggested, (child) => { job.picker = child; });
  job.picker = null;

  if (job.status === 'cancelled') return;   // cancelled from the UI while picking
  if (picked.cancelled || picked.error) {
    job.status = picked.error ? 'error' : 'cancelled';
    job.error = picked.error || null;
    job.finishedAt = Date.now();
    return broadcast(job);
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
  return sendJson(res, 404, { status: 'error', status_message: 'Unknown downloader endpoint.' });
}

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { status: 'error', status_message: 'Bad request URL' });
  }

  if (url.pathname === '/api/movie_search') {
    handleMovieSearch(res, url);
  } else if (url.pathname === '/api/anime_search') {
    handleAnimeSearch(res, url);
  } else if (url.pathname === '/api/anime_details') {
    handleAnimeDetails(res, url);
  } else if (url.pathname === '/api/anime_by_rating') {
    handleAnimeByRating(res, url);
  } else if (url.pathname === '/api/anime_genres') {
    handleAnimeGenres(res);
  } else if (url.pathname === '/api/anime_tags') {
    handleAnimeTags(res);
  } else if (url.pathname === '/api/anime_relations') {
    handleAnimeRelations(res, url);
  } else if (url.pathname === '/api/mal_score') {
    handleMalScore(res, url);
  } else if (url.pathname.startsWith('/api/dl/')) {
    handleDlApi(req, res, url);
  } else if (url.pathname.startsWith('/api/')) {
    handleApi(res, url);
  } else {
    handleStatic(res, url);
  }
});

server.listen(PORT, HOST, async () => {
  await loadDlConfig();
  const tools = await getTools();
  const missing = (what) => `not found — ${what}`;
  console.log(`\n  Media Library`);
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  upstream:  ${UPSTREAM}`);
  console.log(`  downloads: ${saveDir()}`);
  console.log(`  yt-dlp:    ${tools.ytdlp.found ? tools.ytdlp.version : missing('see the Download tab')}`);
  console.log(`  ffmpeg:    ${tools.ffmpeg.found ? 'found' : missing('needed above 720p')}\n`);
});
