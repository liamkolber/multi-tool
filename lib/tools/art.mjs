// Character art lookup — Danbooru, within a configured rating ceiling.
//
// Everything about which ratings are served is set in the CONFIGURATION block
// directly below; nothing else in the project needs editing to change it.
//
// The ceiling is a ceiling: the caller picks a subset of it, the query asks
// for that subset, and then every post in the response is checked against it
// again here, because a rating filter that only exists in a query string is a
// filter the caller can drop. A tag denylist runs as a second gate, and
// anything without a preview image or with an unexpected file type never
// reaches the client.
//
// Two steps, because AniList and Danbooru do not name characters the same way:
// AniList says "Aki Hayakawa", Danbooru says "hayakawa_aki_(chainsaw_man)".
// So we list the series' character tags and match locally, which survives the
// surname-first flip that a plain prefix search does not.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { sendJson, cache, CACHE_TTL_MS, CACHE_MAX, ROOT } from '../core.mjs';

const DANBOORU = 'https://danbooru.donmai.us';
const YANDERE = 'https://yande.re';
const UA = 'LiamsMultiTool/1.0 (personal local app)';

// ══════════════════════════════════════════════════════════════════════════
//  CONFIGURATION — config/art.json, read live.
//
//  That file holds both knobs: which ratings to serve, and any extra tags to
//  block. Editing it takes effect on the next request — no restart, and
//  nothing else to touch. The overlay toggles, the Danbooru query, the
//  response gate, the cache key and the labels all follow from it.
//
//  It is a data file rather than a constant precisely so it can change while
//  the app runs. A constant would need the process restarted, and restarting
//  would kill any download or conversion in flight.
//
//  The one asymmetry: blockedTags ADDS to BLOCKED_FLOOR and cannot subtract
//  from it, so a slip in the config can widen what is served but never widen
//  it past that floor.
// ══════════════════════════════════════════════════════════════════════════

// Danbooru's four ratings, strictest first. Each is an exact bucket rather
// than a threshold, which is why this is a list and not a level: enabling
// 's' alone would exclude 'g' rather than adding to it.
const RATINGS = {
  g: { label: 'General', means: 'no nudity, nothing suggestive' },
  s: { label: 'Sensitive', means: 'swimsuits, underwear, revealing outfits — not pornographic' },
  q: { label: 'Questionable', means: 'partial nudity, strong suggestion, no explicit acts' },
  e: { label: 'Explicit', means: 'pornographic' },
};

const CONFIG_FILE = join(ROOT, 'config', 'art.json');
const CONFIG_NAME = 'config/art.json';

// Where a cold start lands if the file is missing or unreadable: the strictest
// rating, and the built-in denylist. A config problem must never fail open to
// something more permissive than was asked for.
const RATINGS_FALLBACK = ['g'];

// The floor for blocked tags. The config file adds to this list; it cannot
// take anything out of it. Removing one of these is a code edit on purpose —
// they are the entries that keep a character-list button away from sexualised
// art of characters who are minors, and that is not a thing to drop by
// mistyping a JSON array at midnight.
const BLOCKED_FLOOR = [];

// Danbooru tags are lowercase with underscores; accept either and normalise,
// so "Cow Print" filters the same as cow_print.
const tagKey = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '_');

// Re-read only when the file's mtime moves, so this costs one stat() per
// request rather than a parse.
let configState = { mtime: -1, value: null, reported: '' };

const defaultConfig = () => ({
  ratings: new Set(RATINGS_FALLBACK),
  blocked: new Set(BLOCKED_FLOOR),
  sources: ['danbooru'],
});

function loadConfig() {
  let stamp;
  try {
    stamp = statSync(CONFIG_FILE).mtimeMs;
  } catch {
    // No file at all. Warn once, then hold whatever we already had.
    if (configState.reported !== 'missing') {
      configState.reported = 'missing';
      console.warn(`[art] ${CONFIG_NAME} not found — using ${RATINGS_FALLBACK.join(',')} and the built-in denylist`);
    }
    return configState.value || defaultConfig();
  }

  if (stamp === configState.mtime && configState.value) return configState.value;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    // Mid-edit saves produce invalid JSON constantly. Keep the last good value
    // rather than tearing the running app down over a half-typed file.
    if (configState.reported !== `parse:${stamp}`) {
      configState.reported = `parse:${stamp}`;
      console.warn(`[art] ${CONFIG_NAME} is not valid JSON (${err.message}) — keeping previous`);
    }
    configState.mtime = stamp;
    return configState.value || defaultConfig();
  }

  const asked = (Array.isArray(parsed.enabled) ? parsed.enabled : []).map(tagKey);
  const bad = asked.filter((r) => !RATINGS[r]);
  const good = asked.filter((r) => RATINGS[r]);

  if (bad.length) {
    console.warn(`[art] ignoring unknown rating(s) ${bad.join(', ')} — valid: ${Object.keys(RATINGS).join(', ')}`);
  }
  if (!good.length) {
    console.warn(`[art] no valid ratings in ${CONFIG_NAME} — using ${RATINGS_FALLBACK.join(',')}`);
  }

  // Union, never replacement: whatever the file lists is added to the floor.
  const extraBlocked = (Array.isArray(parsed.blockedTags) ? parsed.blockedTags : [])
    .map(tagKey)
    .filter(Boolean);

  // Unknown ids are dropped rather than failing the whole config, and an
  // empty list falls back to Danbooru rather than to no sources at all.
  const askedSources = (Array.isArray(parsed.sources) ? parsed.sources : [])
    .map((s) => String(s).trim().toLowerCase());
  const badSources = askedSources.filter((s) => !SOURCES[s]);
  const goodSources = askedSources.filter((s) => SOURCES[s]);
  if (badSources.length) {
    console.warn(`[art] unknown source(s) ${badSources.join(', ')} — valid: ${Object.keys(SOURCES).join(', ')}`);
  }

  const value = {
    ratings: new Set(good.length ? good : RATINGS_FALLBACK),
    blocked: new Set([...BLOCKED_FLOOR, ...extraBlocked]),
    sources: goodSources.length ? goodSources : ['danbooru'],
  };

  const before = configState.value;
  const sameRatings = before && [...value.ratings].join() === [...before.ratings].join();
  const sameBlocked = before && value.blocked.size === before.blocked.size;
  if (!sameRatings) console.log(`[art] ratings now: ${[...value.ratings].join(', ')}`);
  if (!sameBlocked) {
    console.log(`[art] blocked tags now: ${value.blocked.size} (${BLOCKED_FLOOR.length} built in + ${extraBlocked.length} from config)`);
  }
  const sameSources = before && value.sources.join() === before.sources.join();
  if (!sameSources) console.log(`[art] sources now: ${value.sources.join(', ')}`);

  configState = { mtime: stamp, value, reported: '' };
  return value;
}

// ═══════════════════════ end of configuration ═════════════════════════════

// What the caller asked for, narrowed to what is permitted. An intersection,
// never a union: the configured set is a ceiling and no query string raises it,
// so ?ratings=e returns nothing rather than explicit posts. Asking for nothing
// valid falls back to the full permitted set rather than to empty, so a stale
// or malformed request degrades to the default view instead of a blank grid.
function requestedRatings(raw, allowed) {
  const asked = String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((r) => allowed.has(r));
  return asked.length ? new Set(asked) : new Set(allowed);
}

// The denylist is BLOCKED_FLOOR plus whatever blockedTags in the config adds,
// and it is load-bearing as soon as the rating set goes past 'g'. At 'g' these
// never matched — rating:g + loli returns zero posts on Danbooru. At 's' and
// 'q' both return plenty.
//
// It catches what is tagged, which is not the same as catching the category:
// of the top 100 g/s/q posts for kanna_kamui, 23 carry the loli tag and are
// dropped, while the rest stay — q-rated art of a child character that nobody
// tagged. Danbooru's tagging is inconsistent and no list can fix that.

const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

const CHARACTER_CATEGORY = 4;
const PER_PAGE = 40;

// Danbooru's ceiling for one request. Used when order:score cannot be part of
// the query: ask for as much as it will give and sort here instead.
const OVERFETCH = 200;
const TAG_SCAN_LIMIT = 200;

// Danbooru allows anonymous users two searchable tags; `rating:` and `order:`
// are metatags and do not count against it, which is why this fits.
const MAX_PAGE = 50;

const slug = (s) => String(s || '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

async function fetchJson(base, params, cacheKey) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, json: hit.json };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const url = `${base}?${new URLSearchParams(params)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);

    if (!res.ok || !Array.isArray(json)) {
      return { ok: false, message: `${new URL(base).hostname} replied ${res.status}` };
    }

    cache.set(cacheKey, { at: Date.now(), json });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { ok: true, json };
  } catch (err) {
    return {
      ok: false,
      message: err.name === 'AbortError' ? `${new URL(base).hostname} timed out` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function tagsMatching(pattern) {
  return fetchJson(`${DANBOORU}/tags.json`, {
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
  // A tag with no posts can never show anything. Danbooru keeps empty and
  // deprecated ones around — seiko_ayase_(dandadan) exists with zero posts
  // while the character actually lives at ayase_seiko — and one of those
  // outranking a real tag is how "Momo Ayase" ended up showing an empty grid.
  if (!tag.post_count) return -1;

  const tokens = new Set(tagBase(tag.name).split('_').filter(Boolean));
  let hits = 0;
  for (const t of nameTokens) if (tokens.has(t)) hits++;
  if (!hits) return -1;

  const exact = hits === nameTokens.length && tokens.size === nameTokens.length;

  // A partial match is usually a relative sharing a surname, so it has to be
  // worth much less than a complete one rather than a little less.
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
  const collect = async (pattern) => {
    const out = await tagsMatching(pattern);
    if (out.ok) for (const t of out.json) found.set(t.name, t);
  };

  const nameSlug = slug(name);
  const parts = nameSlug.split('_').filter(Boolean);

  // The series scan and the name probe both run, always. Searching only the
  // series was wrong twice over: Danbooru adds a "_(series)" qualifier only
  // when a name is ambiguous, so a series scan misses the unqualified majority
  // — Momo Ayase is plain ayase_momo with 4,000+ posts and never appears under
  // *_(dandadan) — and a weak match inside the series was enough to stop the
  // name probe from ever running, because it only fired when nothing at all
  // had been found.
  const probes = new Set(series.map((s) => `*_(${s})`));
  if (nameSlug) probes.add(`${nameSlug}*`);
  // Surname-first is the common flip: AniList's "Aki Hayakawa" is Danbooru's
  // hayakawa_aki.
  if (parts.length > 1) probes.add(`${parts.slice().reverse().join('_')}*`);

  for (const p of probes) await collect(p);

  let ranked = rankTags(name, [...found.values()]);

  // Nothing matched the whole name. Widen to single words, which finds people
  // Danbooru records under one name, and accept the extra requests only here.
  if (!ranked.length || ranked[0].score < 1000) {
    for (const p of parts) {
      if (!probes.has(`${p}*`)) await collect(`${p}*`);
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
// Runs on a normalised post, so it applies identically whichever site the
// post came from. Each source maps its own rating vocabulary to ours before
// this sees it.
function isServable(p, active, blocked) {
  if (!p || !active.has(p.rating)) return false;
  if (!p.preview || !p.large) return false;
  if (!ALLOWED_EXT.has(String(p.ext || '').toLowerCase())) return false;

  for (const tag of p.tags) {
    if (blocked.has(tag)) return false;
  }
  return true;
}

// Three sizes, because the viewer wants all of them: the preview for the grid,
// the sample to put something on screen instantly, and the original to swap in
// once it arrives. The original is absent on some posts, so `full` can be null
// and the viewer stays on the sample.
//
// Held to the same extension allowlist as the rest — the original of a post
// whose sample is a jpg can be something else entirely.
const httpUrl = (u) => (/^https?:\/\//.test(u || '') ? u : null);

function shapeDanbooru(p) {
  const ext = String(p.file_ext || '').toLowerCase();
  return {
    site: 'danbooru',
    id: p.id,
    hash: p.md5 || null,
    rating: p.rating,
    tags: String(p.tag_string || '').split(/\s+/).filter(Boolean),
    preview: p.preview_file_url,
    large: p.large_file_url,
    full: ALLOWED_EXT.has(ext) ? httpUrl(p.file_url) : null,
    ext,
    bytes: p.file_size || null,
    width: p.image_width || null,
    height: p.image_height || null,
    score: p.score || 0,
    artist: String(p.tag_string_artist || '').split(/\s+/).filter(Boolean)[0] || null,
    source: httpUrl(p.source),
    post: `${DANBOORU}/posts/${p.id}`,
    dead: !!(p.is_banned || p.is_deleted),
  };
}

// Moebooru's three tiers written in Danbooru's four-tier vocabulary, which is
// what the rest of the tool speaks. 's' is SAFE here, not Danbooru's
// "sensitive": verified rather than assumed, since of 30 rating:s posts none
// carried an explicit body tag against 11 of 30 at rating:q.
//
// Nothing maps to 's'. Moebooru has no tier between safe and questionable, and
// inventing one would mean a Sensitive-only request — a deliberately narrow
// one — quietly serving posts from a site that cannot express that narrowness.
const MOEBOORU_RATING = { s: 'g', q: 'q', e: 'e' };

// Moebooru gives a flat tag string with no categories, so there is no way to
// tell which of them is the artist. Better null than a guess that turns the
// artist filter into a lie.
function shapeYandere(p) {
  const ext = String(p.file_ext || '').toLowerCase();
  return {
    site: 'yandere',
    id: p.id,
    hash: p.md5 || null,
    // Canonical, not the raw letter: the gate compares against what was asked
    // for, and what was asked for is in Danbooru's vocabulary.
    rating: MOEBOORU_RATING[p.rating] || null,
    tags: String(p.tags || '').split(/\s+/).filter(Boolean),
    preview: p.preview_url,
    large: p.sample_url || p.jpeg_url || p.file_url,
    full: ALLOWED_EXT.has(ext) ? httpUrl(p.file_url) : null,
    ext,
    bytes: p.file_size || null,
    width: p.width || null,
    height: p.height || null,
    score: p.score || 0,
    artist: null,
    source: httpUrl(p.source),
    post: `${YANDERE}/post/show/${p.id}`,
    dead: p.status === 'deleted',
  };
}

// ---------------------------------------------------------------- sources ---
//
// Each entry maps its site's rating vocabulary onto ours and knows how to run
// one search. Everything downstream — the gate, the denylist, the viewer —
// works on the normalised post and does not care where it came from.

const SOURCES = {
  danbooru: {
    label: 'Danbooru',
    // Danbooru's four tiers are the vocabulary the rest of the tool speaks,
    // so this is the identity mapping.
    canonical: { g: 'g', s: 's', q: 'q', e: 'e' },
    search: searchDanbooru,
  },
  yandere: {
    label: 'yande.re',
    // Moebooru has three tiers and its 's' means SAFE, not Danbooru's
    // "sensitive". Verified rather than assumed: of 30 rating:s posts none
    // carried an explicit body tag, against 11 of 30 at rating:q. Mapping the
    // letter across would have served safe art under Sensitive and left
    // nothing answering for the tier in between.
    //
    // There is no moebooru equivalent of sensitive, so a Sensitive-only
    // selection returns nothing from here. That is the honest outcome:
    // inventing a mapping would widen what a deliberately narrow request
    // serves, which is the one direction this tool must never move in.
    canonical: MOEBOORU_RATING,
    search: searchYandere,
  },
};

// Which of a source's own rating letters correspond to what was asked for.
function sourceRatings(source, active) {
  return Object.entries(source.canonical)
    .filter(([, ours]) => active.has(ours))
    .map(([theirs]) => theirs);
}

async function searchDanbooru({ tag, extra, sort, page, active, blocked }) {
  // Danbooru allows an anonymous search two tags. Measured, because guessing
  // was wrong: rating: is free and does not count, order: does, and so does
  // every plain tag. The character spends one, which leaves exactly one more.
  //
  // So the contest is between the extra tag and order:score — the rating stays
  // either way. When both are wanted, the extra tag goes in the query and the
  // sorting happens here instead, over a page of OVERFETCH rather than
  // PER_PAGE.
  //
  // That is not the compromise it sounds like. Narrowing by a second tag cuts
  // the result set hard — power + anal is 32 posts in total — so 200 usually
  // is every match there is, and sorting them by score gives exactly the same
  // answer order:score would have. Only past 200 does it become "the best of
  // the 200 most recent", and sortExact says which of the two you got.
  const wantScore = sort === 'score';
  const localSort = !!extra && wantScore;

  const query = [`rating:${sourceRatings(SOURCES.danbooru, active).join(',')}`, tag];
  if (extra) query.push(extra);
  else if (wantScore) query.push('order:score');

  const limit = localSort ? OVERFETCH : PER_PAGE;
  // Local sorting needs the whole set in hand, so it always pulls the same
  // first page and does its own paging inside it.
  const fetchPage = localSort ? 1 : page;

  // The rating set belongs in the cache key: it is part of the query sent to
  // Danbooru, so leaving it out served the previously cached page and merely
  // re-filtered it. Narrowing to General then showed the one general post that
  // happened to rank inside the unfiltered top forty, rather than the forty
  // top-ranked general posts — the right pictures, but the wrong page of them.
  const out = await fetchJson(`${DANBOORU}/posts.json`, {
    tags: query.join(' '),
    limit: String(limit),
    page: String(fetchPage),
  }, `art:danbooru:${sort}:${fetchPage}:${limit}:${[...active].join('')}:${tag}:${extra}`);

  if (!out.ok) return { posts: [], filtered: 0, hasNext: false, sortExact: true, error: out.message };

  const raw = out.json;
  let posts = raw.map(shapeDanbooru).filter((p) => !p.dead && isServable(p, active, blocked));
  const filtered = raw.length - posts.length;

  if (localSort) {
    posts.sort((a, b) => b.score - a.score || b.id - a.id);
    const start = (page - 1) * PER_PAGE;
    const slice = posts.slice(start, start + PER_PAGE);
    return {
      posts: slice,
      filtered,
      hasNext: posts.length > start + PER_PAGE,
      sortExact: raw.length < OVERFETCH,
    };
  }

  return {
    posts,
    filtered,
    hasNext: raw.length === PER_PAGE && page < MAX_PAGE,
    sortExact: true,
  };
}

// Moebooru puts no ceiling on how many tags a search may use, so the extra tag
// and order:score coexist happily and none of the Danbooru juggling applies.
// Its rating syntax takes one value rather than a list, though, so the rating
// is left out of the query and the gate does that part.
const YANDERE_LIMIT = 100;

async function searchYandere({ tag, extra, sort, page, active, blocked }) {
  if (!sourceRatings(SOURCES.yandere, active).length) {
    return { posts: [], filtered: 0, hasNext: false, sortExact: true };
  }

  const query = [tag];
  if (extra) query.push(extra);
  if (sort === 'score') query.push('order:score');

  const out = await fetchJson(`${YANDERE}/post.json`, {
    tags: query.join(' '),
    limit: String(YANDERE_LIMIT),
    page: String(page),
  }, `art:yandere:${sort}:${page}:${tag}:${extra}`);

  if (!out.ok) return { posts: [], filtered: 0, hasNext: false, sortExact: true, error: out.message };

  const raw = out.json;
  const kept = raw.map(shapeYandere).filter((p) => !p.dead && isServable(p, active, blocked));

  return {
    posts: kept.slice(0, PER_PAGE),
    filtered: raw.length - kept.length,
    hasNext: raw.length === YANDERE_LIMIT,
    sortExact: true,
  };
}

async function handleSearch(res, url) {
  const tag = (url.searchParams.get('tag') || '').trim();
  if (!tag) return sendJson(res, 400, { status: 'error', status_message: 'A character tag is required.' });

  // One tag from the caller, and it goes in as a tag rather than as free text.
  if (/\s/.test(tag)) {
    return sendJson(res, 400, { status: 'error', status_message: 'That is not a single tag.' });
  }

  // A second tag to narrow by — a theme, or an artist, since Danbooru stores
  // artists as ordinary tags too. Colons are refused: they are what turns a
  // tag into a metatag, and "rating:e" arriving here would otherwise be a way
  // to write the rating filter out of the query. The response gate would still
  // catch it, but a query that cannot say something is better than one that
  // says it and is overruled.
  const extra = (url.searchParams.get('extra') || '').trim().toLowerCase();
  if (extra && (/\s/.test(extra) || extra.includes(':'))) {
    return sendJson(res, 400, {
      status: 'error',
      status_message: 'An extra filter must be a single tag with no colon.',
    });
  }

  const page = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get('page')) || 1));
  const sort = url.searchParams.get('sort') === 'new' ? 'new' : 'score';

  // Read per request, so editing the config file takes effect immediately.
  const config = loadConfig();
  const allowed = config.ratings;
  const active = requestedRatings(url.searchParams.get('ratings'), allowed);

  // Every enabled source in parallel — one slow site should not add its
  // latency to the others.
  const chosen = config.sources.filter((id) => SOURCES[id]);
  const results = await Promise.all(chosen.map((id) => SOURCES[id].search({
    tag, extra, sort, page, active, blocked: config.blocked,
  })));

  // If every source failed there is nothing to show and saying so beats an
  // empty grid; if only some did, the rest still have results worth showing.
  const errors = results.map((r, i) => (r.error ? `${SOURCES[chosen[i]].label}: ${r.error}` : null))
    .filter(Boolean);
  if (errors.length === chosen.length && chosen.length) {
    return sendJson(res, 502, { status: 'error', status_message: errors.join('; ') });
  }

  // The same picture is often posted to several boorus. md5 collapses those to
  // one tile, keeping whichever source listed it first.
  const seen = new Set();
  let duplicates = 0;
  let posts = [];
  for (const r of results) {
    for (const p of r.posts) {
      if (p.hash && seen.has(p.hash)) { duplicates++; continue; }
      if (p.hash) seen.add(p.hash);
      posts.push(p);
    }
  }

  if (sort === 'score') posts.sort((a, b) => b.score - a.score);
  posts = posts.slice(0, PER_PAGE);

  const hasNext = results.some((r) => r.hasNext) && page < MAX_PAGE;
  const sortExact = results.every((r) => r.sortExact);

  return sendJson(res, 200, {
    status: 'ok',
    data: {
      tag,
      extra: extra || null,
      sources: chosen.map((id) => ({ id, label: SOURCES[id].label })),
      warnings: errors,
      page,
      sort,
      // True when the ranking covers every match; false when it ranks only the
      // OVERFETCH most recent, which the UI mentions rather than hides.
      sortExact,
      posts,
      // What is on, and what the server would permit — the client renders one
      // toggle per allowed rating and cannot offer more than this.
      ratings: [...active],
      allowed: [...allowed].map((r) => ({
        value: r,
        label: RATINGS[r].label,
        means: RATINGS[r].means,
      })),
      // Whether Danbooru had more, not whether the gate let more through — so
      // a page filtered down to nothing still pages forward.
      hasNext,
      // What every source's gate dropped, plus the cross-source duplicates the
      // hash check collapsed.
      filtered: results.reduce((n, r) => n + (r.filtered || 0), 0) + duplicates,
      duplicates,
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
  blurb: 'Character artwork from Danbooru, by character.',
  prefix: '/api/art/',
  handle: handleApi,
  // No panel of its own: this is opened from a character in the anime and
  // manga detail sheets.
  headless: true,
};
