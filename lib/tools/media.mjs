// Media Library — movies & TV from YTS, anime from AniList, with MAL scores and
// age-rating tiers layered on top. A thin, cached, whitelisted proxy: the browser
// never talks to an upstream API directly.

import { MIME, sendJson, cache, CACHE_TTL_MS, CACHE_MAX, stripHtml } from '../core.mjs';

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

export const tool = {
  id: 'media',
  name: 'Media Library',
  icon: '🎬',
  blurb: 'Browse movies, TV and anime from one search box.',
  prefix: '/api/',
  handle(req, res, url) {
    const routes = {
      '/api/movie_search': () => handleMovieSearch(res, url),
      '/api/anime_search': () => handleAnimeSearch(res, url),
      '/api/anime_details': () => handleAnimeDetails(res, url),
      '/api/anime_by_rating': () => handleAnimeByRating(res, url),
      '/api/anime_genres': () => handleAnimeGenres(res),
      '/api/anime_tags': () => handleAnimeTags(res),
      '/api/anime_relations': () => handleAnimeRelations(res, url),
      '/api/mal_score': () => handleMalScore(res, url),
    };
    // Anything else under /api/ falls through to the whitelisted YTS proxy.
    return (routes[url.pathname] || (() => handleApi(res, url)))();
  },
  banner: () => [['upstream', UPSTREAM]],
};
