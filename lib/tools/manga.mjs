// Manga — the same idea as the anime side of the Media Library, pointed at
// AniList's MANGA type instead of ANIME.
//
// AniList's public GraphQL API needs no key and covers manga, manhwa, manhua
// and light novels with the same Media type the anime tab already uses. This is
// a catalogue: titles, covers, synopses, chapter and volume counts, and the
// official links AniList curates. It does not serve pages.

import { sendJson, stripHtml, cache, CACHE_TTL_MS, CACHE_MAX } from '../core.mjs';

const ANILIST_URL = 'https://graphql.anilist.co';

const MANGA_SORTS = {
  match: 'SEARCH_MATCH',
  trending: 'TRENDING_DESC',
  popularity: 'POPULARITY_DESC',
  score: 'SCORE_DESC',
  favourites: 'FAVOURITES_DESC',
  newest: 'START_DATE_DESC',
  title: 'TITLE_ROMAJI',
};

// Where a title was published, which is what actually separates manga from
// manhwa and manhua — the format field calls all three "MANGA".
const ORIGIN = { JP: 'Manga', KR: 'Manhwa', CN: 'Manhua', TW: 'Manhua' };

const MANGA_FIELDS = `
      id
      idMal
      title { romaji english native }
      startDate { year }
      endDate { year }
      averageScore
      popularity
      favourites
      genres
      format
      chapters
      volumes
      status
      countryOfOrigin
      isAdult
      description(asHtml: false)
      coverImage { extraLarge large color }
      siteUrl
      staff(perPage: 4, sort: RELEVANCE) { edges { role node { name { full } } } }
      externalLinks { site url type language notes isDisabled }`;

// AniList treats an explicit null for a filter argument as a real constraint
// rather than ignoring it, so each one is only declared when it has a value.
// (The anime side learned this the hard way; same rule here.)
function buildMangaQuery(use) {
  const varDecls = ['$page: Int', '$perPage: Int', '$sort: [MediaSort]'];
  const args = ['type: MANGA', 'sort: $sort'];

  // No isAdult constraint at all: this is a single-user catalogue on a machine
  // its owner controls, and filtering the results would just hide entries.
  // AniList still flags each one, so the UI can mark them.

  if (use.search) { varDecls.push('$search: String'); args.push('search: $search'); }
  if (use.genre) { varDecls.push('$genre: String'); args.push('genre: $genre'); }
  if (use.tag) { varDecls.push('$tag: String'); args.push('tag: $tag'); }
  if (use.format) { varDecls.push('$format: MediaFormat'); args.push('format: $format'); }
  if (use.status) { varDecls.push('$status: MediaStatus'); args.push('status: $status'); }
  if (use.country) { varDecls.push('$country: CountryCode'); args.push('countryOfOrigin: $country'); }
  if (use.score) { varDecls.push('$scoreGreater: Int'); args.push('averageScore_greater: $scoreGreater'); }

  return `
query (${varDecls.join(', ')}) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage hasNextPage }
    media(${args.join(', ')}) {${MANGA_FIELDS}
    }
  }
}`;
}

function staffBy(m, roles) {
  const edges = (m.staff && m.staff.edges) || [];
  const hit = edges.filter((e) => roles.test(String(e.role || '')));
  const names = (hit.length ? hit : edges)
    .map((e) => e.node && e.node.name && e.node.name.full)
    .filter(Boolean);
  return [...new Set(names)];
}

// Where a link actually takes you. AniList only says STREAMING / INFO / SOCIAL,
// which does not separate "read the chapters here" from "buy the volumes here"
// — and that is the distinction you want when deciding what to open.
//
// Anything not listed falls back to "official", which is honest: it is a link
// the rightsholder registered, and guessing further would go stale as platforms
// change their models.
const READERS = new Set([
  'manga plus', 'shonen jump', 'shonen jump plus', 'webtoon', 'line manga',
  'tapas', 'comikey', 'azuki', 'inkr', 'manga up!', 'alpha manga', 'coolmic',
  'piccoma', 'kakaopage', 'naver series', 'pixiv comic', 'comic walker',
  'niconico seiga', 'sunday webry', 'magazine pocket', 'young ace up',
  'tonari no young jump', 'comic days', 'comic fuz', 'mangamo', 'toomics',
  'lezhin', 'tappytoon', 'manta', 'webcomics',
]);

const STORES = new Set([
  'viz', 'bookwalker', 'amazon', 'kindle', 'kobo', 'comixology', 'yen press',
  'seven seas', 'kodansha', 'square enix manga', 'j-novel club', 'denpa',
  'vertical', 'dark horse', 'fakku', 'irodori comics', 'renta', 'ebookjapan',
  'cmoa', 'google play books', 'apple books', 'barnes & noble',
]);

function linkKind(l) {
  const site = String(l.site || '').toLowerCase();
  if (l.type === 'SOCIAL') return 'social';
  if (READERS.has(site)) return 'read';
  if (STORES.has(site)) return 'buy';
  // "Volumes" in the notes means collected editions, which are a purchase.
  if (/volume/i.test(l.notes || '')) return 'buy';
  if (l.type === 'STREAMING') return 'read';
  return 'info';
}

// Deduped by site AND language: the same publisher legitimately appears once
// per territory, and collapsing those to one row throws away every language but
// the first — which was the bug in the previous version.
function normalizeLinks(links) {
  const seen = new Set();
  const out = [];
  for (const l of links) {
    if (l.isDisabled) continue;
    const key = [l.site, l.language, l.notes].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      site: l.site,
      url: l.url,
      kind: linkKind(l),
      language: l.language || null,
      notes: l.notes || null,
    });
  }
  return out;
}

function normalizeManga(m) {
  const en = m.title && m.title.english;
  const ro = m.title && m.title.romaji;
  const links = (m.externalLinks || []).filter((l) => l && l.url);

  return {
    source: 'manga',
    id: m.id,
    malId: m.idMal || null,
    title: en || ro || 'Untitled',
    title_secondary: en && ro && en !== ro ? ro : null,
    native: (m.title && m.title.native) || null,
    year: (m.startDate && m.startDate.year) || null,
    endYear: (m.endDate && m.endDate.year) || null,
    rating: typeof m.averageScore === 'number' ? Math.round(m.averageScore) / 10 : null,
    popularity: m.popularity || 0,
    favourites: m.favourites || 0,
    poster: (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || null,
    color: (m.coverImage && m.coverImage.color) || null,
    genres: m.genres || [],
    format: m.format || null,
    // "Manga" for a Japanese release, "Manhwa" for Korean, and so on — but a
    // light novel is a light novel wherever it came from.
    kind: m.format === 'NOVEL' ? 'Light novel'
      : m.format === 'ONE_SHOT' ? 'One-shot'
        : ORIGIN[m.countryOfOrigin] || 'Manga',
    chapters: m.chapters || null,
    volumes: m.volumes || null,
    status: m.status || null,
    country: m.countryOfOrigin || null,
    isAdult: !!m.isAdult,
    summary: stripHtml(m.description),
    siteUrl: m.siteUrl || null,
    authors: staffBy(m, /story|author|original/i),
    artists: staffBy(m, /art/i),
    links: normalizeLinks(links),
    // Whether there is anywhere to read it in English without buying it, which
    // is the question the catalogue is usually being asked.
    readableEn: links.some((l) => !l.isDisabled
      && linkKind(l) === 'read'
      && String(l.language || '').toLowerCase() === 'english'),
  };
}

const MANGA_DETAILS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: MANGA) {${MANGA_FIELDS}
    meanScore
    source
    synonyms
    tags { name rank isMediaSpoiler }
    relations {
      edges {
        relationType(version: 2)
        node { id type format title { romaji english } coverImage { large } }
      }
    }
    characters(perPage: 8, sort: FAVOURITES_DESC) {
      edges { role node { id name { full } image { medium } } }
    }
  }
}`;

function normalizeDetails(m) {
  const base = normalizeManga(m);
  return {
    ...base,
    meanScore: typeof m.meanScore === 'number' ? Math.round(m.meanScore) / 10 : null,
    origin: m.source || null,
    synonyms: (m.synonyms || []).slice(0, 6),
    // Every tag, ranked, with spoilers flagged rather than removed — the UI
    // collapses the list and keeps spoilers behind a second click.
    tags: (m.tags || [])
      .slice()
      .sort((a, b) => (b.rank || 0) - (a.rank || 0))
      .map((t) => ({ name: t.name, rank: t.rank || 0, spoiler: !!t.isMediaSpoiler })),
    related: ((m.relations && m.relations.edges) || [])
      .filter((e) => e.node && e.node.type === 'MANGA')
      .slice(0, 8)
      .map((e) => ({
        id: e.node.id,
        relation: String(e.relationType || '').replace(/_/g, ' ').toLowerCase(),
        title: (e.node.title && (e.node.title.english || e.node.title.romaji)) || 'Untitled',
        poster: (e.node.coverImage && e.node.coverImage.large) || null,
      })),
    characters: ((m.characters && m.characters.edges) || [])
      .map((e) => ({
        id: e.node && e.node.id,
        name: (e.node && e.node.name && e.node.name.full) || null,
        role: String(e.role || '').toLowerCase(),
        image: (e.node && e.node.image && e.node.image.medium) || null,
      }))
      .filter((c) => c.name),
  };
}

// One place to talk to AniList, so the timeout, the cache and the error shape
// are the same for search and for details.
async function anilist(query, variables, cacheKey) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, json: hit.json, cached: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);

    if (!res.ok || !json || json.errors) {
      const why = (json && json.errors && json.errors[0] && json.errors[0].message)
        || `AniList replied ${res.status}`;
      return { ok: false, message: why };
    }

    cache.set(cacheKey, { at: Date.now(), json });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { ok: true, json, cached: false };
  } catch (err) {
    return {
      ok: false,
      message: err.name === 'AbortError' ? 'AniList request timed out' : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handleSearch(res, url) {
  const q = url.searchParams;
  const search = (q.get('query') || '').trim();
  const pick = (name) => {
    const v = (q.get(name) || '').trim();
    return v && v !== 'All' && v !== 'any' ? v : null;
  };

  const use = {
    search: search || null,
    genre: pick('genre'),
    tag: pick('tag'),
    format: pick('format'),
    status: pick('status'),
    country: pick('country'),
    score: Number(q.get('score')) || null,
  };

  const variables = {
    page: Math.max(1, Number(q.get('page')) || 1),
    perPage: Math.min(50, Math.max(1, Number(q.get('perPage')) || 30)),
    sort: [MANGA_SORTS[q.get('sort')] || (search ? 'SEARCH_MATCH' : 'POPULARITY_DESC')],
  };
  if (use.search) variables.search = use.search;
  if (use.genre) variables.genre = use.genre;
  if (use.tag) variables.tag = use.tag;
  if (use.format) variables.format = use.format;
  if (use.status) variables.status = use.status;
  if (use.country) variables.country = use.country;
  if (use.score) variables.scoreGreater = use.score;

  const key = `manga:${JSON.stringify(variables)}`;
  const out = await anilist(buildMangaQuery(use), variables, key);
  if (!out.ok) {
    return sendJson(res, 502, { status: 'error', status_message: `AniList error: ${out.message}` });
  }

  const page = (out.json.data && out.json.data.Page) || { pageInfo: {}, media: [] };
  const info = page.pageInfo || {};
  return sendJson(res, 200, {
    status: 'ok',
    data: {
      total: info.total || 0,
      page: info.currentPage || variables.page,
      hasNext: !!info.hasNextPage,
      items: (page.media || []).map(normalizeManga),
    },
  }, { 'X-Cache': out.cached ? 'HIT' : 'MISS' });
}

async function handleDetails(res, url) {
  const id = Number(url.searchParams.get('id'));
  if (!id) return sendJson(res, 400, { status: 'error', status_message: 'An id is required.' });

  const out = await anilist(MANGA_DETAILS_QUERY, { id }, `manga:details:${id}`);
  if (!out.ok) {
    return sendJson(res, 502, { status: 'error', status_message: `AniList error: ${out.message}` });
  }
  const media = out.json.data && out.json.data.Media;
  if (!media) return sendJson(res, 404, { status: 'error', status_message: 'No such title.' });

  return sendJson(res, 200, { status: 'ok', data: normalizeDetails(media) });
}

// The genre list AniList actually uses, so the dropdown cannot offer something
// that returns nothing.
async function handleGenres(res) {
  const out = await anilist('query { GenreCollection }', {}, 'manga:genres');
  if (!out.ok) return sendJson(res, 502, { status: 'error', status_message: out.message });
  return sendJson(res, 200, { status: 'ok', data: { genres: out.json.data.GenreCollection || [] } });
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/manga\/?/, '');
  if (route === 'search') return handleSearch(res, url);
  if (route === 'details') return handleDetails(res, url);
  if (route === 'genres') return handleGenres(res);
  return sendJson(res, 404, { status: 'error', status_message: 'Unknown manga endpoint.' });
}

export const tool = {
  id: 'manga',
  name: 'Manga',
  icon: '📖',
  blurb: 'Search manga, manhwa, manhua and light novels from AniList.',
  prefix: '/api/manga/',
  handle: handleApi,
};
