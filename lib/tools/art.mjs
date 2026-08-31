// Character art lookup — Danbooru, general-rated only.
//
// Danbooru's `rating:general` is the safe bucket: non-sexual and
// non-suggestive, not merely "explicit removed". The query asks for it, and
// then every post in the response is checked again here, because a rating
// filter that only exists in a query string is a filter the caller can drop.
// A tag denylist runs as a second gate, and anything without a preview image
// or with an unexpected file type never reaches the client.
//
// Two steps, because AniList and Danbooru do not name characters the same way:
// AniList says "Aki Hayakawa", Danbooru says "hayakawa_aki_(chainsaw_man)".
// So we list the series' character tags and match locally, which survives the
// surname-first flip that a plain prefix search does not.

import { sendJson, cache, CACHE_TTL_MS, CACHE_MAX } from '../core.mjs';

const DANBOORU = 'https://danbooru.donmai.us';
const UA = 'LiamsMultiTool/1.0 (personal local app)';

// Danbooru ratings: g=general, s=sensitive, q=questionable, e=explicit.
// Only g is served.
const ALLOWED_RATING = 'g';

// Belt and braces. A general-rated post is non-sexual by definition, so these
// should never match — but the cost of checking is nothing and the cost of
// relying solely on someone else's rating field is not.
const BLOCKED_TAGS = new Set([
  'loli', 'lolicon', 'shota', 'shotacon', 'toddlercon', 'cub',
  'bestiality', 'guro', 'gore', 'rape', 'scat', 'necrophilia',
]);

const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

const CHARACTER_CATEGORY = 4;
const PER_PAGE = 40;
const TAG_SCAN_LIMIT = 200;

// Danbooru allows anonymous users two searchable tags; `rating:` and `order:`
// are metatags and do not count against it, which is why this fits.
const MAX_PAGE = 50;

const slug = (s) => String(s || '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

async function danbooru(path, params, cacheKey) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, json: hit.json };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const url = `${DANBOORU}${path}?${new URLSearchParams(params)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);

    if (!res.ok || !Array.isArray(json)) {
      return { ok: false, message: `Danbooru replied ${res.status}` };
    }

    cache.set(cacheKey, { at: Date.now(), json });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { ok: true, json };
  } catch (err) {
    return {
      ok: false,
      message: err.name === 'AbortError' ? 'Danbooru request timed out' : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tagsMatching(pattern) {
  return danbooru('/tags.json', {
    'search[name_matches]': pattern,
    'search[category]': String(CHARACTER_CATEGORY),
    'search[order]': 'count',
    limit: String(TAG_SCAN_LIMIT),
  }, `art:tags:${pattern}`);
}

// Everything inside the trailing (series) qualifier is disambiguation, not name.
const tagBase = (tag) => String(tag).replace(/_\([^)]*\)$/, '');

// Token overlap rather than string equality, so "Aki Hayakawa" still finds
// "hayakawa_aki_(chainsaw_man)". An exact set match outranks a partial one, and
// post count only breaks ties — it never promotes a worse name match.
function scoreTag(nameTokens, tag) {
  const tokens = new Set(tagBase(tag.name).split('_').filter(Boolean));
  let hits = 0;
  for (const t of nameTokens) if (tokens.has(t)) hits++;
  if (!hits) return -1;

  const exact = hits === nameTokens.length && tokens.size === nameTokens.length;
  const popularity = Math.min(50, Math.log10(Math.max(1, tag.post_count)) * 10);
  return (exact ? 1000 : 0) + hits * 100 + popularity;
}

function rankTags(name, tags) {
  const nameTokens = slug(name).split('_').filter(Boolean);
  if (!nameTokens.length) return [];

  return tags
    .map((t) => ({ tag: t.name, count: t.post_count || 0, score: scoreTag(nameTokens, t) }))
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score || b.count - a.count);
}

async function handleResolve(res, url) {
  const name = (url.searchParams.get('name') || '').trim();
  if (!name) return sendJson(res, 400, { status: 'error', status_message: 'A character name is required.' });

  // Both the English and romaji series titles, because Danbooru tags the one
  // the fandom uses: "Attack on Titan" is shingeki_no_kyojin over there.
  const series = url.searchParams.getAll('series').map(slug).filter(Boolean);

  const found = new Map();
  for (const s of series) {
    const out = await tagsMatching(`*_(${s})`);
    if (out.ok) for (const t of out.json) found.set(t.name, t);
  }

  let ranked = rankTags(name, [...found.values()]);

  // No series hit — Danbooru may not use that title. Fall back to the name.
  if (!ranked.length) {
    const parts = slug(name).split('_').filter(Boolean);
    const probes = new Set([slug(name)]);
    // Surname-first is the common flip, then each word alone as a last resort.
    if (parts.length > 1) probes.add(parts.slice().reverse().join('_'));
    for (const p of parts) probes.add(p);

    for (const probe of probes) {
      if (!probe) continue;
      const out = await tagsMatching(`${probe}*`);
      if (out.ok) for (const t of out.json) found.set(t.name, t);
    }
    ranked = rankTags(name, [...found.values()]);
  }

  return sendJson(res, 200, {
    status: 'ok',
    data: {
      name,
      best: ranked.length ? ranked[0].tag : null,
      candidates: ranked.slice(0, 8).map((c) => ({ tag: c.tag, count: c.count })),
    },
  });
}

// The gate. Anything that fails is dropped rather than shown with a warning.
function isServable(p) {
  if (!p || p.rating !== ALLOWED_RATING) return false;
  if (p.is_banned || p.is_deleted) return false;
  if (!p.preview_file_url || !p.large_file_url) return false;
  if (!ALLOWED_EXT.has(String(p.file_ext || '').toLowerCase())) return false;

  for (const tag of String(p.tag_string || '').split(/\s+/)) {
    if (BLOCKED_TAGS.has(tag)) return false;
  }
  return true;
}

function shapePost(p) {
  return {
    id: p.id,
    preview: p.preview_file_url,
    large: p.large_file_url,
    width: p.image_width || null,
    height: p.image_height || null,
    score: p.score || 0,
    artist: String(p.tag_string_artist || '').split(/\s+/).filter(Boolean)[0] || null,
    source: p.source && /^https?:\/\//.test(p.source) ? p.source : null,
    post: `${DANBOORU}/posts/${p.id}`,
  };
}

async function handleSearch(res, url) {
  const tag = (url.searchParams.get('tag') || '').trim();
  if (!tag) return sendJson(res, 400, { status: 'error', status_message: 'A character tag is required.' });

  // One tag from the caller, and it goes in as a tag rather than as free text.
  if (/\s/.test(tag)) {
    return sendJson(res, 400, { status: 'error', status_message: 'That is not a single tag.' });
  }

  const page = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('page')) || 1));
  const sort = url.searchParams.get('sort') === 'new' ? 'new' : 'score';

  const query = ['rating:general', tag];
  if (sort === 'score') query.push('order:score');

  const out = await danbooru('/posts.json', {
    tags: query.join(' '),
    limit: String(PER_PAGE),
    page: String(page),
  }, `art:posts:${sort}:${page}:${tag}`);

  if (!out.ok) return sendJson(res, 502, { status: 'error', status_message: out.message });

  const raw = out.json;
  const posts = raw.filter(isServable).map(shapePost);

  return sendJson(res, 200, {
    status: 'ok',
    data: {
      tag,
      page,
      sort,
      posts,
      // Whether Danbooru had more, not whether the gate let more through — so
      // a page filtered down to nothing still pages forward.
      hasNext: raw.length === PER_PAGE && page < MAX_PAGE,
      filtered: raw.length - posts.length,
    },
  });
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/art\/?/, '');
  if (route === 'resolve') return handleResolve(res, url);
  if (route === 'search') return handleSearch(res, url);
  return sendJson(res, 404, { status: 'error', status_message: 'Unknown art endpoint.' });
}

export const tool = {
  id: 'art',
  name: 'Character art',
  icon: '🎨',
  blurb: 'General-rated character artwork from Danbooru.',
  prefix: '/api/art/',
  handle: handleApi,
  // No panel of its own: this is opened from a character in the anime and
  // manga detail sheets.
  headless: true,
};
