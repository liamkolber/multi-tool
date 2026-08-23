// Media Library — unified movie/TV (YTS) + anime (AniList) browser.
// One search box queries both sources; the source toggle narrows to one (or a
// local Watchlist). Anime detail also supplements AniList with a MyAnimeList
// link + score (via Jikan).

const MOVIE_GENRES = [
  'All', 'Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime',
  'Documentary', 'Drama', 'Family', 'Fantasy', 'Film-Noir', 'History', 'Horror',
  'Music', 'Musical', 'Mystery', 'News', 'Romance', 'Sci-Fi', 'Sport',
  'Thriller', 'War', 'Western',
];
// Mirrors AniList's own genre filter (their GenreCollection, minus adult).
// Replaced at startup by loadAnimeGenres(); this is the offline fallback.
let ANIME_GENRES = [
  'All', 'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror',
  'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance',
  'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
];
const QUALITIES = ['All', '480p', '720p', '1080p', '1080p.x265', '2160p', '3D'];

const MOVIE_SORTS = [
  ['date_added', 'Date added'], ['download_count', 'Downloads'],
  ['like_count', 'Likes'], ['rating', 'Rating'], ['year', 'Year'],
  ['title', 'Title'], ['peers', 'Peers'], ['seeds', 'Seeds'],
];
// YTS only exposes all-time download counts (no monthly stats); "This year"
// works by using the year as the search term, then sorting by downloads.
const MOVIE_POPULAR = [['off', '—'], ['all', 'All time'], ['year', 'This year']];
// YTS's mpa_rating mixes MPAA / TV / international values, so filter by bucket.
const MOVIE_RATINGS = [
  ['Any', 'Any'], ['g', 'G'], ['pg', 'PG'], ['pg-13', 'PG-13'],
  ['r', 'R'], ['nc-17', 'NC-17'], ['nr', 'Unrated'],
];
const ANIME_SORTS = [
  ['popularity', 'Popularity'], ['trending', 'Trending'], ['score', 'Top rated'],
  ['newest', 'Newest'], ['title', 'Title'],
];
const FORMATS = [
  ['All', 'Any format'], ['TV', 'TV series'], ['MOVIE', 'Movie'], ['OVA', 'OVA'],
  ['ONA', 'ONA'], ['SPECIAL', 'Special'], ['TV_SHORT', 'TV short'],
];
const STATUSES = [
  ['All', 'Any status'], ['RELEASING', 'Airing now'], ['FINISHED', 'Finished'],
  ['NOT_YET_RELEASED', 'Upcoming'],
];
// Unified anime maturity ladder. The MAL-tier options route through the Jikan
// -> AniList rating pipeline (SFW); "Adult (18+)" routes through AniList isAdult.
const ANIME_RATINGS = [
  ['any', 'Any'], ['pg', 'PG & up'], ['pg13', 'Teen 13+ & up'],
  ['r17', 'Mature 17+ & up'], ['adult', 'Adult (18+)'],
];
const MAL_TIER_KEYS = ['pg', 'pg13', 'r17'];
function ratingTierLabel(tier) {
  const f = ANIME_RATINGS.find(([v]) => v === tier);
  return f ? f[1] : tier;
}

// Public trackers YTS advertises — used to assemble magnet links client-side.
const TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://glotorrents.pw:6969/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://torrent.gresille.org:80/announce',
  'udp://p4p.arenabg.com:1337',
  'udp://tracker.leechers-paradise.org:6969',
];

const PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='170' height='255'>
       <rect width='100%' height='100%' fill='#1d2230'/>
       <text x='50%' y='50%' fill='#4a5265' font-family='sans-serif'
         font-size='16' text-anchor='middle'>No image</text>
     </svg>`
  );

const MOVIES_LIMIT = 20;
const ANIME_LIMIT = 24;
const ALL_HALF = 12; // per source in "All" mode
const WATCHLIST_KEY = 'media-library:watchlist';

const state = {
  query: '',
  source: 'all', // all | movies | anime | watchlist
  page: 1,
  // movie filters
  quality: 'All', moviePopular: 'off', movieRating: 'Any', movieGenre: 'All', movieSort: 'date_added', order: 'desc',
  // anime filters
  animeGenre: 'All', animeTag: 'All', format: 'All', animeStatus: 'All', animeSort: 'popularity', animeRating: 'any',
  // shared — grouping is on by default; the pill toggles it off
  groupSeries: true, streamingOnly: false,
  // chrome
  sidebarCollapsed: false,
  // pager
  hasNext: false, totalPages: null,
};

// Rendered items, keyed "source:id", so the modal/watchlist can read them.
const itemsByKey = new Map();

// --- DOM refs ---
const $ = (id) => document.getElementById(id);
const els = {
  search: $('search'),
  sourceToggle: $('source-toggle'),
  quality: $('quality'),
  moviePopular: $('movie-popular'),
  movieRating: $('movie-rating'),
  genre: $('genre'),
  tagSel: $('anime-tag'),
  format: $('format'),
  statusSel: $('anime-status'),
  animeRating: $('anime-rating'),
  groupSeries: $('group-series'),
  streamingOnly: $('streaming-only'),
  sort: $('sort'),
  order: $('order'),
  reset: $('reset'),
  app: $('app'),
  filters: $('filters'),
  sideToggle: $('side-toggle'),
  grid: $('grid'),
  status: $('status'),
  resultsInfo: $('results-info'),
  prev: $('prev'),
  next: $('next'),
  pageInfo: $('page-info'),
  modal: $('modal'),
  modalBody: $('modal-body'),
};

// --- Helpers ---
function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (selected) o.selected = true;
  return o;
}

function magnetLink(hash, title) {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackers}`;
}

function fmtNumber(n) {
  return Number(n || 0).toLocaleString();
}

function fmtFormat(f) {
  return { TV: 'TV', MOVIE: 'Movie', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special', TV_SHORT: 'TV Short', MUSIC: 'Music' }[f] || f || 'Anime';
}

function niceStatus(s) {
  return { RELEASING: 'Airing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Upcoming', CANCELLED: 'Cancelled', HIATUS: 'Hiatus' }[s] || null;
}

// Episode count — falls back to "N aired" for airing shows with no defined total.
function episodeText(it) {
  if (it.episodes) return `${it.episodes} ep`;
  if (it.nextEpisode && it.nextEpisode > 1) return `${it.nextEpisode - 1} aired`;
  return null;
}

function esc(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// --- Watchlist (localStorage) ---
function getWatchlist() {
  try { return JSON.parse(localStorage.getItem(WATCHLIST_KEY)) || []; } catch { return []; }
}
function saveWatchlist(list) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
}
function inWatchlist(source, id) {
  return getWatchlist().some((x) => x.source === source && String(x.id) === String(id));
}
function toggleWatchlist(item) {
  const list = getWatchlist();
  const i = list.findIndex((x) => x.source === item.source && String(x.id) === String(item.id));
  if (i >= 0) list.splice(i, 1);
  else list.unshift(item);
  saveWatchlist(list);
  return i < 0; // true if it was added
}

// --- Trailer (lazy YouTube/Dailymotion embed) ---
function youtubeTrailer(id) {
  const thumb = `https://i.ytimg.com/vi/${esc(id)}/hqdefault.jpg`;
  const embed = `https://www.youtube-nocookie.com/embed/${esc(id)}?autoplay=1&rel=0`;
  return `<div class="trailer"><button class="trailer-facade" data-embed="${embed}"
    style="background-image:url('${thumb}')" aria-label="Play trailer"><span class="trailer-play">▶</span></button></div>`;
}
function animeTrailer(t) {
  if (!t || !t.id) return '';
  if (t.site === 'youtube') return youtubeTrailer(t.id);
  if (t.site === 'dailymotion') {
    const embed = `https://www.dailymotion.com/embed/video/${esc(t.id)}?autoplay=1`;
    return `<div class="trailer"><button class="trailer-facade dark" data-embed="${embed}"
      aria-label="Play trailer"><span class="trailer-play">▶</span></button></div>`;
  }
  return '';
}

function watchToggleBtn(source, id) {
  const saved = inWatchlist(source, id);
  return `<button class="link-btn watch-toggle ${saved ? 'saved' : ''}" data-watch-toggle
    data-source="${source}" data-id="${esc(id)}">${saved ? '✓ In Watchlist' : '★ Watchlist'}</button>`;
}

function bookmarkBtn(source, id) {
  const saved = inWatchlist(source, id);
  return `<button class="bookmark-btn ${saved ? 'saved' : ''}" data-bookmark data-source="${source}"
    data-id="${esc(id)}" title="Toggle watchlist" aria-label="Toggle watchlist">${saved ? '★' : '☆'}</button>`;
}

// --- Populate filter controls ---
function buildStaticControls() {
  QUALITIES.forEach((q) => els.quality.append(option(q, q, q === 'All')));
  MOVIE_POPULAR.forEach(([v, label]) => els.moviePopular.append(option(v, label, v === 'off')));
  MOVIE_RATINGS.forEach(([v, label]) => els.movieRating.append(option(v, label, v === 'Any')));
  FORMATS.forEach(([v, label]) => els.format.append(option(v, label, v === 'All')));
  STATUSES.forEach(([v, label]) => els.statusSel.append(option(v, label, v === 'All')));
  ANIME_RATINGS.forEach(([v, label]) => els.animeRating.append(option(v, label, v === 'any')));


  els.order.append(option('desc', 'Descending', true));
  els.order.append(option('asc', 'Ascending'));
}

// Genre + Sort options depend on the active source, so rebuild them on switch.
function rebuildDynamicFilters() {
  const isAnime = state.source === 'anime';
  els.genre.innerHTML = '';
  (isAnime ? ANIME_GENRES : MOVIE_GENRES).forEach((g) =>
    els.genre.append(option(g, g, g === (isAnime ? state.animeGenre : state.movieGenre)))
  );
  els.sort.innerHTML = '';
  (isAnime ? ANIME_SORTS : MOVIE_SORTS).forEach(([v, label]) =>
    els.sort.append(option(v, label, v === (isAnime ? state.animeSort : state.movieSort)))
  );
}

function applySourceUI() {
  // The Download tab isn't a library view: it swaps out the grid entirely and
  // has no filters, search, or pager of its own.
  const isDownload = state.source === 'download';
  let shown = 0;
  document.querySelectorAll('.filters [data-for]').forEach((el) => {
    const modes = el.dataset.for.split(' ');
    const show = !isDownload && modes.includes(state.source);
    el.classList.toggle('hide', !show);
    if (show) shown++;
  });
  document.querySelectorAll('.src-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.src === state.source)
  );
  // All / Watchlist / Download have no filters of their own, so the whole
  // block goes rather than leaving a bare heading and a Reset button.
  els.filters.classList.toggle('hide', shown === 0);
  document.querySelector('.topbar').classList.toggle('hide', isDownload);
  document.querySelector('.results-bar').classList.toggle('hide', isDownload);
  document.querySelector('.pager').classList.toggle('hide', isDownload);
  els.grid.classList.toggle('hide', isDownload);
  els.status.classList.toggle('hide', isDownload);
  dl.panel.hidden = !isDownload;
  if (isDownload) dlOnOpen();
}

function applySidebar() {
  els.app.classList.toggle('collapsed', state.sidebarCollapsed);
  els.sideToggle.textContent = state.sidebarCollapsed ? '›' : '‹';
  els.sideToggle.title = state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  els.sideToggle.setAttribute('aria-label', els.sideToggle.title);
  els.sideToggle.setAttribute('aria-expanded', String(!state.sidebarCollapsed));
}

// --- Normalisation (movies come raw from YTS; anime arrive pre-normalised) ---
function normalizeMovie(m) {
  return {
    source: 'yts',
    id: m.id,
    title: m.title,
    year: m.year || null,
    rating: m.rating || null,
    poster: m.medium_cover_image || m.large_cover_image || null,
    qualities: [...new Set((m.torrents || []).map((t) => t.quality))],
    mpa: m.mpa_rating || '',
  };
}

// Map YTS's inconsistent rating strings (MPAA / TV / international) into buckets.
function ratingBucket(mpa) {
  const v = String(mpa || '').toUpperCase().trim();
  if (!v) return 'nr';
  if (['G', 'TV-G', 'TV-Y', 'TV-Y7', 'U', '0+'].includes(v)) return 'g';
  if (['PG', 'TV-PG', '6+', '7+'].includes(v)) return 'pg';
  if (['PG-13', 'TV-14', '12+', '13+', '14+', '12', '13', '14', '15', '15+'].includes(v)) return 'pg-13';
  if (['R', 'TV-MA', '16+', '16', '17+', 'NC16', 'M', 'MA15+', 'R16', 'R15+'].includes(v)) return 'r';
  if (['NC-17', 'X', '18', '18+', 'R18', 'R18+', 'R21'].includes(v)) return 'nc-17';
  return 'nr'; // Not Rated / Unrated / Approved / Passed / etc.
}

function mpaChip(mpa) {
  if (!mpa) return '';
  const b = ratingBucket(mpa);
  const label = b === 'nr' ? 'NR' : mpa;
  return `<span class="mpa mpa-${b}">${esc(label)}</span>`;
}

function ratingLabel(bucket) {
  const found = MOVIE_RATINGS.find(([v]) => v === bucket);
  return found ? found[1] : bucket;
}

function interleave(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

// --- Series grouping (best-effort, title-based) ---
const seriesGroups = new Map();
let activeSeriesKey = null;

function titleCase(s) {
  return (s || '').split(' ').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Collapse a title to a rough "franchise key" so same-series entries cluster.
function franchiseKey(title) {
  let t = (title || '').toLowerCase().trim();
  t = t.replace(/^the\s+/, '');
  if (t.includes('/')) {
    t = t.split('/')[0]; // Fate/Zero, Fate/stay night -> fate
  } else {
    t = t.split(/[:：]|\s[-–—]\s/)[0]; // cut at colon or " - " subtitle
    t = t.replace(/\s+\b(the\s+)?(movie|film|season|part|cour|ova|ona|special|specials|recap)\b.*$/, '');
  }
  return t.replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function groupSeriesItems(items) {
  const groups = new Map();
  items.forEach((it) => {
    const fk = franchiseKey(it.title);
    const key = fk || `solo:${it.source}:${it.id}`;
    if (!groups.has(key)) groups.set(key, { key, name: titleCase(fk) || it.title, items: [] });
    groups.get(key).items.push(it);
  });
  return [...groups.values()];
}

function seriesCardHtml(g) {
  const rep = g.items.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0))[0];
  const poster = rep.poster || PLACEHOLDER;
  return `
    <article class="card series-card" data-series="${esc(g.key)}" tabindex="0">
      <div class="poster">
        <img src="${esc(poster)}" alt="${esc(g.name)}" loading="lazy"
             onerror="this.onerror=null;this.src='${PLACEHOLDER}'" />
        <div class="src-badge series">SERIES</div>
        <div class="series-count">${g.items.length} entries</div>
      </div>
      <div class="card-body">
        <h3 class="card-title">${esc(g.name)}</h3>
        <div class="card-meta">${g.items.length} entries</div>
      </div>
    </article>`;
}

let seriesSort = 'year';

function byYear(items) {
  return items.slice().sort((a, b) => (a.year || 9999) - (b.year || 9999));
}

function seriesRowHtml(e) {
  const meta = [e.year || '—', fmtFormat(e.format), episodeText(e)].filter(Boolean).join(' · ');
  const rating = e.rating ? ` <span class="star">★</span> ${e.rating}` : '';
  return `
    <button class="series-entry" data-entry-id="${e.id}" type="button">
      <img class="series-entry-poster" src="${esc(e.poster || PLACEHOLDER)}" alt="${esc(e.title)}" loading="lazy"
           onerror="this.onerror=null;this.src='${PLACEHOLDER}'" />
      <span class="series-entry-info">
        <span class="series-entry-title">${esc(e.title)}</span>
        <span class="series-entry-meta">${esc(meta)}${rating}</span>
      </span>
    </button>`;
}

function renderSeriesList(entries) {
  const el = document.getElementById('series-list');
  if (el) el.innerHTML = entries.map(seriesRowHtml).join('');
}

function openSeriesModal(key) {
  const g = seriesGroups.get(key);
  if (!g) return;
  activeSeriesKey = key;
  seriesSort = 'year';
  showModal(`
    <div class="series-modal">
      <h2 class="detail-title" id="modal-title">${esc(g.name)}</h2>
      <div class="detail-sub">${g.items.length} entries</div>
      <div class="series-sort">
        <button class="series-sort-btn active" data-series-sort="year" type="button">By year</button>
        <button class="series-sort-btn" data-series-sort="story" type="button">Story order</button>
      </div>
      <div id="series-list" class="series-list"></div>
    </div>`);
  renderSeriesList(byYear(g.items));
}

async function setSeriesSort(mode) {
  const g = seriesGroups.get(activeSeriesKey);
  if (!g) return;
  seriesSort = mode;
  document.querySelectorAll('[data-series-sort]').forEach((b) =>
    b.classList.toggle('active', b.dataset.seriesSort === mode)
  );
  if (mode === 'year') { renderSeriesList(byYear(g.items)); return; }

  const listEl = document.getElementById('series-list');
  if (listEl) listEl.innerHTML = '<div class="status" style="padding:34px 0"><div class="spinner"></div>Building story order…</div>';
  const relMap = await fetchRelations(g.items.map((e) => e.id));
  if (activeSeriesKey !== g.key || seriesSort !== 'story') return; // user moved on
  renderSeriesList(relMap ? storyOrder(g.items, relMap) : byYear(g.items));
}

async function fetchRelations(ids) {
  try {
    const res = await fetch(`/api/anime_relations?ids=${ids.join(',')}`);
    const json = await res.json();
    return json.status === 'ok' ? json.data.relations : null;
  } catch {
    return null;
  }
}

// Order a franchise via prequel/sequel edges (topological); ties break by year.
function storyOrder(entries, relMap) {
  const inGroup = new Set(entries.map((e) => String(e.id)));
  const adj = new Map();
  const indeg = new Map();
  entries.forEach((e) => { adj.set(String(e.id), new Set()); indeg.set(String(e.id), 0); });

  const addEdge = (a, b) => {
    a = String(a); b = String(b);
    if (a === b || !inGroup.has(a) || !inGroup.has(b)) return;
    if (!adj.get(a).has(b)) { adj.get(a).add(b); indeg.set(b, indeg.get(b) + 1); }
  };
  entries.forEach((e) => {
    (relMap[e.id] || relMap[String(e.id)] || []).forEach((r) => {
      if (r.type === 'SEQUEL') addEdge(e.id, r.to);       // e before its sequel
      else if (r.type === 'PREQUEL') addEdge(r.to, e.id);  // prequel before e
    });
  });

  const yearOf = (e) => e.year || 9999;
  const done = new Set();
  const result = [];
  while (result.length < entries.length) {
    const cand = entries
      .filter((e) => !done.has(String(e.id)) && indeg.get(String(e.id)) === 0)
      .sort((a, b) => yearOf(a) - yearOf(b));
    if (!cand.length) { // safety net for cycles/leftovers
      entries.filter((e) => !done.has(String(e.id))).sort((a, b) => yearOf(a) - yearOf(b))
        .forEach((e) => { result.push(e); done.add(String(e.id)); });
      break;
    }
    const n = cand[0];
    result.push(n); done.add(String(n.id));
    adj.get(String(n.id)).forEach((s) => { if (!done.has(s)) indeg.set(s, indeg.get(s) - 1); });
  }
  return result;
}

// --- Fetchers ---
async function fetchMovies(limit) {
  const p = new URLSearchParams({
    limit: String(limit),
    page: String(state.page),
    order_by: state.order,
    sort_by: state.source === 'all' ? 'download_count' : state.movieSort,
  });
  if (state.query) p.set('query_term', state.query);
  if (state.source === 'movies') {
    if (state.quality !== 'All') p.set('quality', state.quality);
    if (state.movieGenre !== 'All') p.set('genre', state.movieGenre);
    if (state.moviePopular !== 'off') {
      // YTS popularity = all-time download_count; "this year" via year-as-query.
      p.set('sort_by', 'download_count');
      p.set('order_by', 'desc');
      if (state.moviePopular === 'year') p.set('query_term', String(new Date().getFullYear()));
    }
  }
  const res = await fetch(`/api/movie_search?${p.toString()}`);
  const json = await res.json();
  if (json.status !== 'ok') throw new Error(json.status_message || 'Movie API error');

  const total = json.data.movie_count || 0;
  let items = (json.data.movies || []).map(normalizeMovie);
  // YTS can't filter by content rating server-side, so post-filter by bucket.
  if (state.source === 'movies' && state.movieRating !== 'Any') {
    items = items.filter((m) => ratingBucket(m.mpa) === state.movieRating);
  }
  return {
    items,
    total,
    hasNext: state.page < Math.ceil(total / limit),
    bridged: json.data.bridged || 0,
  };
}

async function fetchAnime(limit) {
  // Rating filter takes its own path: MAL tiers (Jikan) re-hydrated via AniList.
  // In this mode genre/tag/format/status/sort don't apply.
  if (state.source === 'anime' && MAL_TIER_KEYS.includes(state.animeRating)) {
    const rp = new URLSearchParams({ tier: state.animeRating, page: String(state.page) });
    if (state.query) rp.set('q', state.query);
    const rres = await fetch(`/api/anime_by_rating?${rp.toString()}`);
    const rjson = await rres.json();
    if (rjson.status !== 'ok') throw new Error(rjson.status_message || 'Anime rating API error');
    let ritems = rjson.data.items || [];
    if (state.streamingOnly) ritems = ritems.filter((i) => (i.streaming || []).length > 0);
    return { items: ritems, total: rjson.data.total, hasNext: rjson.data.hasNextPage };
  }

  const p = new URLSearchParams({ perPage: String(limit), page: String(state.page) });
  if (state.query) p.set('q', state.query);
  p.set('sort', state.source === 'all' ? (state.query ? 'match' : 'popularity') : state.animeSort);
  if (state.source === 'anime') {
    if (state.animeGenre !== 'All') p.set('genre', state.animeGenre);
    if (state.animeTag !== 'All') p.set('tag', state.animeTag);
    if (state.format !== 'All') p.set('format', state.format);
    if (state.animeStatus !== 'All') p.set('status', state.animeStatus);
    if (state.animeRating === 'adult') p.set('audience', 'adult');
  }
  const res = await fetch(`/api/anime_search?${p.toString()}`);
  const json = await res.json();
  if (json.status !== 'ok') throw new Error(json.status_message || 'Anime API error');

  let items = json.data.items;
  // AniList can't filter on "has streaming links" server-side, so drop titles
  // without an official streaming source here (each item carries `streaming`).
  if (state.source === 'anime' && state.streamingOnly) {
    items = items.filter((i) => (i.streaming || []).length > 0);
  }
  return { items, total: json.data.total, hasNext: json.data.hasNextPage };
}

// --- Load + render ---
function showStatus(html) {
  els.status.hidden = false;
  els.status.innerHTML = html;
  els.grid.innerHTML = '';
}

async function loadResults() {
  savePrefs();
  // The Download tab has no library query behind it.
  if (state.source === 'download') return;
  // Watchlist is local — no network, render immediately.
  if (state.source === 'watchlist') {
    let items = getWatchlist();
    if (state.query) {
      const q = state.query.toLowerCase();
      items = items.filter((it) => (it.title || '').toLowerCase().includes(q));
    }
    state.hasNext = false;
    state.totalPages = 1;
    state.page = 1;
    if (items.length === 0) {
      showStatus(`<div class="status">${state.query ? 'No saved titles match your search.' : 'Your watchlist is empty. Tap ☆ on any title to save it here.'}</div>`);
      els.resultsInfo.textContent = 'Watchlist';
    } else {
      els.status.hidden = true;
      render(items);
      els.resultsInfo.textContent = `Watchlist · ${items.length} saved`;
    }
    updatePager();
    return;
  }

  els.grid.classList.add('loading');
  els.resultsInfo.textContent = 'Loading…';

  try {
    let items = [];

    if (state.source === 'movies') {
      // Rating is post-filtered, so pull a bigger page to keep it from looking empty.
      const rated = state.movieRating !== 'Any';
      const limit = rated ? 50 : MOVIES_LIMIT;
      const r = await fetchMovies(limit);
      items = r.items;
      state.hasNext = r.hasNext;
      if (rated) {
        state.totalPages = null;
        els.resultsInfo.textContent = `Movies rated ${ratingLabel(state.movieRating)}`;
      } else {
        state.totalPages = Math.max(1, Math.ceil(r.total / limit));
        const baseLabel =
          state.moviePopular === 'all' ? `${fmtNumber(r.total)} movies · most downloaded (all time)`
          : state.moviePopular === 'year' ? `${fmtNumber(r.total)} from ${new Date().getFullYear()} · most downloaded`
          : `${fmtNumber(r.total)} movies found`;
        els.resultsInfo.textContent =
          (r.bridged && r.bridged >= r.total) ? `${fmtNumber(r.total)} found by English-title match`
          : r.bridged ? `${baseLabel} · +${r.bridged} cross-language`
          : baseLabel;
      }
    } else if (state.source === 'anime') {
      // Pull a bigger page when grouping or streaming-filtering so pages stay full.
      const limit = (state.groupSeries || state.streamingOnly) ? 50 : ANIME_LIMIT;
      const r = await fetchAnime(limit);
      items = r.items;
      state.hasNext = r.hasNext;
      if (MAL_TIER_KEYS.includes(state.animeRating)) {
        state.totalPages = null;
        els.resultsInfo.textContent = `Anime · ${ratingTierLabel(state.animeRating)} · MAL tiers`;
      } else if (state.streamingOnly) {
        // Post-filtered, so the raw total no longer applies.
        state.totalPages = null;
        els.resultsInfo.textContent = 'Anime with an official streaming source';
      } else {
        state.totalPages = r.total ? Math.max(1, Math.ceil(r.total / limit)) : null;
        els.resultsInfo.textContent = state.animeRating === 'adult'
          ? `${fmtNumber(r.total)} adult (18+) anime`
          : `${fmtNumber(r.total)} anime found`;
      }
    } else {
      const [mv, an] = await Promise.all([fetchMovies(ALL_HALF), fetchAnime(ALL_HALF)]);
      items = interleave(mv.items, an.items);
      state.hasNext = mv.hasNext || an.hasNext;
      state.totalPages = null;
      els.resultsInfo.textContent = state.query
        ? `Movies & anime · “${state.query}”`
        : 'Trending movies & anime';
    }

    els.status.hidden = true;

    if (items.length === 0) {
      showStatus('<div class="status">No results matched your search.</div>');
      els.resultsInfo.textContent = state.query ? `No results for “${state.query}”` : 'No results';
    } else {
      render(items);
    }

    updatePager();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    showStatus(`<div class="status">⚠️ Could not load results.<br><small>${esc(err.message)}</small></div>`);
    els.resultsInfo.textContent = '';
  } finally {
    els.grid.classList.remove('loading');
  }
}

function render(items) {
  itemsByKey.clear();
  items.forEach((it) => itemsByKey.set(`${it.source}:${it.id}`, it));

  if (state.groupSeries && state.source === 'anime') {
    seriesGroups.clear();
    const groups = groupSeriesItems(items);
    groups.forEach((g) => { if (g.items.length >= 2) seriesGroups.set(g.key, g); });
    els.grid.innerHTML = groups
      .map((g) => (g.items.length >= 2 ? seriesCardHtml(g) : cardHtml(g.items[0])))
      .join('');
  } else {
    els.grid.innerHTML = items.map(cardHtml).join('');
  }
}

function cardHtml(it) {
  const poster = it.poster || PLACEHOLDER;
  const rating = it.rating
    ? `<div class="rating-badge"><span class="star">★</span>${it.rating}</div>`
    : '';

  if (it.source === 'anime') {
    const meta = [it.year || '—', fmtFormat(it.format), episodeText(it)]
      .filter(Boolean).join(' · ');
    return `
      <article class="card" data-source="anime" data-id="${it.id}" tabindex="0">
        <div class="poster">
          <img src="${esc(poster)}" alt="${esc(it.title)} cover" loading="lazy"
               onerror="this.onerror=null;this.src='${PLACEHOLDER}'" />
          ${rating}
          <div class="src-badge anime">ANIME</div>
          ${bookmarkBtn('anime', it.id)}
        </div>
        <div class="card-body">
          <h3 class="card-title">${esc(it.title)}</h3>
          <div class="card-meta">${esc(meta)}</div>
        </div>
      </article>`;
  }

  const tags = (it.qualities || [])
    .map((q) => `<span class="quality-tag">${esc(q)}</span>`)
    .join('');
  return `
    <article class="card" data-source="yts" data-id="${it.id}" tabindex="0">
      <div class="poster">
        <img src="${esc(poster)}" alt="${esc(it.title)} poster" loading="lazy"
             onerror="this.onerror=null;this.src='${PLACEHOLDER}'" />
        ${rating}
        <div class="src-badge movie">MOVIE</div>
        ${bookmarkBtn('yts', it.id)}
        <div class="quality-tags">${tags}</div>
      </div>
      <div class="card-body">
        <h3 class="card-title">${esc(it.title)}</h3>
        <div class="card-meta">${it.year || '—'}${mpaChip(it.mpa)}</div>
      </div>
    </article>`;
}

function updatePager() {
  els.prev.disabled = state.page <= 1;
  els.next.disabled = !state.hasNext;
  if (state.source === 'watchlist') {
    els.pageInfo.textContent = '';
  } else if (state.source === 'all' || !state.totalPages) {
    els.pageInfo.textContent = `Page ${fmtNumber(state.page)}`;
  } else {
    els.pageInfo.textContent = `Page ${fmtNumber(state.page)} of ${fmtNumber(state.totalPages)}`;
  }
}

// --- Modal: movies (YTS torrents) ---
async function openMovieModal(id) {
  showModal('<div class="status" style="width:100%"><div class="spinner"></div>Loading details…</div>');
  try {
    const res = await fetch(`/api/movie_details?movie_id=${encodeURIComponent(id)}&with_images=true&with_cast=true`);
    const json = await res.json();
    if (json.status !== 'ok' || !json.data || !json.data.movie) {
      throw new Error(json.status_message || 'Movie not found.');
    }
    els.modalBody.innerHTML = movieDetailHtml(json.data.movie);
  } catch (err) {
    els.modalBody.innerHTML = `<div class="status" style="width:100%">⚠️ ${esc(err.message)}</div>`;
  }
}

function movieDetailHtml(m) {
  const poster = m.large_cover_image || m.medium_cover_image || PLACEHOLDER;
  const genres = (m.genres || []).map((g) => `<span class="chip">${esc(g)}</span>`).join('');
  const runtime = m.runtime ? `${m.runtime} min` : null;
  const subParts = [m.year, runtime, m.language ? m.language.toUpperCase() : null]
    .filter(Boolean).map(esc);
  const ratingHtml = m.rating ? `<span class="star">★</span> ${m.rating}/10` : '';

  const actions = [];
  if (m.imdb_code) {
    actions.push(`<a class="link-btn" target="_blank" rel="noopener" href="https://www.imdb.com/title/${esc(m.imdb_code)}/">IMDb</a>`);
  }
  if (m.url) {
    actions.push(`<a class="link-btn" target="_blank" rel="noopener" href="${esc(m.url)}">YTS page</a>`);
  }
  actions.push(watchToggleBtn('yts', m.id));

  const trailer = m.yt_trailer_code ? youtubeTrailer(m.yt_trailer_code) : '';

  const torrents = (m.torrents || []).map((t) => {
    const magnet = magnetLink(t.hash, m.title_long || m.title);
    const type = t.type ? ` · ${esc(t.type)}` : '';
    return `
      <div class="torrent">
        <span class="torrent-q">${esc(t.quality)}</span>
        <span class="torrent-meta">
          ${esc(t.size)}${type}
          &nbsp;·&nbsp; <span class="seeds">▲ ${fmtNumber(t.seeds)}</span>
          &nbsp; <span class="peers">▼ ${fmtNumber(t.peers)}</span>
        </span>
        <span class="torrent-links">
          <a href="${esc(magnet)}">Magnet</a>
          <a class="secondary" href="${esc(t.url)}" target="_blank" rel="noopener">.torrent</a>
        </span>
      </div>`;
  }).join('');

  return `
    <div class="detail-poster">
      <img src="${esc(poster)}" alt="${esc(m.title)} poster"
           onerror="this.onerror=null;this.src='${PLACEHOLDER}'" />
    </div>
    <div class="detail-main">
      <h2 class="detail-title" id="modal-title">${esc(m.title_english || m.title)}</h2>
      <div class="detail-sub">
        ${subParts.join('<span class="dot">·</span>')}
        ${ratingHtml ? `<span class="dot">·</span>${ratingHtml}` : ''}
        ${m.mpa_rating ? mpaChip(m.mpa_rating) : ''}
      </div>
      <div class="genre-chips">${genres}</div>
      <p class="detail-summary">${esc(m.description_full || m.summary || 'No synopsis available.')}</p>
      <div class="detail-actions">${actions.join('')}</div>
      ${trailer}
      <h4 class="torrents-title">Downloads</h4>
      <div class="torrent-list">${torrents || '<span class="card-meta">No torrents listed.</span>'}</div>
    </div>`;
}

// --- Modal: anime (AniList + MAL supplement) ---
function openAnimeModal(it, returnKey = null) {
  if (!it) return;
  showModal(animeDetailHtml(it, returnKey));
  if (it.malId) augmentMalScore(it.malId);
  augmentAnimeDetails(it.id);
}

// Open an anime we only know by id (e.g. a "related" entry) — fetch full detail.
async function openAnimeById(id) {
  showModal('<div class="status" style="width:100%"><div class="spinner"></div>Loading details…</div>');
  const full = await fetchAnimeDetails(id);
  if (!full) {
    els.modalBody.innerHTML = '<div class="status" style="width:100%">⚠️ Could not load this title.</div>';
    return;
  }
  itemsByKey.set(`anime:${full.id}`, full);
  els.modalBody.innerHTML = animeDetailHtml(full);
  fillAnimeExtra(full);
  if (full.malId) augmentMalScore(full.malId);
}

async function fetchAnimeDetails(id) {
  try {
    const res = await fetch(`/api/anime_details?id=${encodeURIComponent(id)}`);
    const json = await res.json();
    return json.status === 'ok' ? json.data.anime : null;
  } catch {
    return null;
  }
}

// Fetch the heavy detail (characters/relations/tags) and slot it into the modal.
async function augmentAnimeDetails(id) {
  const full = await fetchAnimeDetails(id);
  if (full) {
    itemsByKey.set(`anime:${full.id}`, full);
    fillAnimeExtra(full);
  }
}

function fillAnimeExtra(full) {
  const box = document.getElementById('anime-extra');
  if (!box || box.dataset.id !== String(full.id)) return; // modal moved on

  const stats = [full.source, full.season, full.duration ? `${full.duration} min/ep` : null]
    .filter(Boolean).map(esc);
  const statSlot = document.getElementById('anime-substats');
  if (statSlot && stats.length) {
    statSlot.innerHTML = stats.map((s) => `<span class="dot">·</span>${s}`).join('');
  }
  box.innerHTML = extraHtml(full);
}

function extraHtml(full) {
  let html = '';
  if ((full.tags || []).length) {
    html += `<div class="extra-tags">${full.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
  }
  if ((full.characters || []).length) {
    html += `<h4 class="extra-title">Characters</h4><div class="char-grid">${full.characters.map(charCardHtml).join('')}</div>`;
  }
  if ((full.relations || []).length) {
    html += `<h4 class="extra-title">Related</h4><div class="rel-row">${full.relations.map(relCardHtml).join('')}</div>`;
  }
  return html;
}

function charCardHtml(c) {
  const img = c.image || PLACEHOLDER;
  const va = c.va && c.va.name ? `<div class="char-va">CV: ${esc(c.va.name)}</div>` : '';
  return `
    <div class="char-card">
      <img class="char-portrait" src="${esc(img)}" alt="${esc(c.name)}" loading="lazy"
           onerror="this.onerror=null;this.src='${PLACEHOLDER}'" />
      <div class="char-name">${esc(c.name)}</div>
      ${c.role ? `<div class="char-role">${esc(c.role)}</div>` : ''}
      ${va}
    </div>`;
}

function relCardHtml(r) {
  const img = r.poster || PLACEHOLDER;
  const meta = [fmtFormat(r.format), r.year].filter(Boolean).join(' · ');
  return `
    <button class="rel-card" data-related-id="${r.id}" type="button">
      <img class="rel-poster" src="${esc(img)}" alt="${esc(r.title)}" loading="lazy"
           onerror="this.onerror=null;this.src='${PLACEHOLDER}'" />
      <span class="rel-type">${esc(r.relationType)}</span>
      <span class="rel-title">${esc(r.title)}</span>
      <span class="rel-meta">${esc(meta)}</span>
    </button>`;
}

function animeDetailHtml(it, returnKey = null) {
  const poster = it.poster || PLACEHOLDER;
  const back = returnKey && seriesGroups.has(returnKey)
    ? `<button class="back-btn" data-back-series="${esc(returnKey)}" type="button">← ${esc(seriesGroups.get(returnKey).name)}</button>`
    : '';
  const genres = (it.genres || []).map((g) => `<span class="chip">${esc(g)}</span>`).join('');
  const sub = [it.year, fmtFormat(it.format), episodeText(it), niceStatus(it.status), it.studio]
    .filter(Boolean).map(esc);
  const ratingHtml = it.rating ? `<span class="star">★</span> ${it.rating}/10` : '';

  const actions = [];
  if (it.siteUrl) actions.push(`<a class="link-btn" target="_blank" rel="noopener" href="${esc(it.siteUrl)}">AniList</a>`);
  if (it.malId) actions.push(`<a class="link-btn" target="_blank" rel="noopener" href="https://myanimelist.net/anime/${esc(it.malId)}">MyAnimeList</a>`);
  (it.info || []).slice(0, 2).forEach((l) =>
    actions.push(`<a class="link-btn" target="_blank" rel="noopener" href="${esc(l.url)}">${esc(l.site)}</a>`)
  );
  actions.push(watchToggleBtn('anime', it.id));

  const trailer = animeTrailer(it.trailer);

  const streaming = (it.streaming || []).length
    ? `<div class="watch-links">${it.streaming
        .map((l) => `<a class="watch-link" target="_blank" rel="noopener" href="${esc(l.url)}">▶ ${esc(l.site)}</a>`)
        .join('')}</div>`
    : `<p class="watch-empty">No official streaming links are listed on AniList for this title. Try the AniList page above for availability in your region.</p>`;

  return `
    <div class="detail-poster">
      <img src="${esc(poster)}" alt="${esc(it.title)} cover"
           onerror="this.onerror=null;this.src='${PLACEHOLDER}'" />
    </div>
    <div class="detail-main">
      ${back}
      <h2 class="detail-title" id="modal-title">${esc(it.title)}</h2>
      ${it.title_secondary ? `<div class="detail-secondary">${esc(it.title_secondary)}</div>` : ''}
      <div class="detail-sub">
        ${sub.join('<span class="dot">·</span>')}
        ${ratingHtml ? `<span class="dot">·</span>${ratingHtml}` : ''}
        <span id="mal-slot"></span>
        <span id="anime-substats"></span>
      </div>
      <div class="genre-chips">${genres}</div>
      <p class="detail-summary">${esc(it.summary || 'No synopsis available.')}</p>
      <div class="detail-actions">${actions.join('')}</div>
      ${trailer}
      <h4 class="watch-title">Where to watch (official)</h4>
      ${streaming}
      <div id="anime-extra" class="anime-extra" data-id="${it.id}"></div>
    </div>`;
}

// Fill in the MyAnimeList score once Jikan responds (best-effort).
async function augmentMalScore(malId) {
  try {
    const res = await fetch(`/api/mal_score?id=${encodeURIComponent(malId)}`);
    const json = await res.json();
    const slot = document.getElementById('mal-slot');
    if (slot && json.status === 'ok') {
      let html = '';
      if (json.data.score) html += `<span class="dot">·</span><span class="mal">MAL ${json.data.score}</span>`;
      if (json.data.rating) html += `<span class="dot">·</span><span class="age-rating">${esc(json.data.rating)}</span>`;
      slot.innerHTML = html;
    }
  } catch { /* MAL score is optional */ }
}

function showModal(html) {
  els.modal.hidden = false;
  document.body.style.overflow = 'hidden';
  els.modalBody.innerHTML = html;
}

function closeModal() {
  els.modal.hidden = true;
  document.body.style.overflow = '';
  els.modalBody.innerHTML = '';
}

// --- Events ---
function bindEvents() {
  els.search.addEventListener(
    'input',
    debounce((e) => {
      state.query = e.target.value.trim();
      // "Popular this year" hijacks the query term, so a text search cancels it.
      if (state.query && state.moviePopular === 'year') { state.moviePopular = 'off'; els.moviePopular.value = 'off'; }
      state.page = 1;
      loadResults();
    }, 400)
  );

  els.sideToggle.addEventListener('click', () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    applySidebar();
    savePrefs();
  });

  els.sourceToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.src-btn');
    if (!btn || btn.dataset.src === state.source) return;
    state.source = btn.dataset.src;
    state.page = 1;
    rebuildDynamicFilters();
    applySourceUI();
    loadResults();
  });

  els.quality.addEventListener('change', () => { state.quality = els.quality.value; reload(); });
  els.moviePopular.addEventListener('change', () => { state.moviePopular = els.moviePopular.value; reload(); });
  els.movieRating.addEventListener('change', () => { state.movieRating = els.movieRating.value; reload(); });
  els.format.addEventListener('change', () => { state.format = els.format.value; reload(); });
  els.tagSel.addEventListener('change', () => { state.animeTag = els.tagSel.value; reload(); });
  els.statusSel.addEventListener('change', () => { state.animeStatus = els.statusSel.value; reload(); });
  els.animeRating.addEventListener('change', () => { state.animeRating = els.animeRating.value; reload(); });
  els.groupSeries.addEventListener('click', () => {
    state.groupSeries = !state.groupSeries;
    els.groupSeries.classList.toggle('active', state.groupSeries);
    reload();
  });
  els.streamingOnly.addEventListener('click', () => {
    state.streamingOnly = !state.streamingOnly;
    els.streamingOnly.classList.toggle('active', state.streamingOnly);
    reload();
  });
  els.order.addEventListener('change', () => { state.order = els.order.value; reload(); });
  els.genre.addEventListener('change', () => {
    if (state.source === 'anime') state.animeGenre = els.genre.value;
    else state.movieGenre = els.genre.value;
    reload();
  });
  els.sort.addEventListener('change', () => {
    if (state.source === 'anime') state.animeSort = els.sort.value;
    // Choosing an explicit sort cancels the popularity preset (it forces its own sort).
    else { state.movieSort = els.sort.value; state.moviePopular = 'off'; els.moviePopular.value = 'off'; }
    reload();
  });

  els.reset.addEventListener('click', () => {
    Object.assign(state, {
      query: '', page: 1,
      quality: 'All', moviePopular: 'off', movieRating: 'Any', movieGenre: 'All', movieSort: 'date_added', order: 'desc',
      animeGenre: 'All', animeTag: 'All', format: 'All', animeStatus: 'All', animeSort: 'popularity',
      animeRating: 'any', groupSeries: true, streamingOnly: false,
    });
    els.search.value = '';
    els.quality.value = 'All';
    els.moviePopular.value = 'off';
    els.movieRating.value = 'Any';
    els.tagSel.value = 'All';
    els.format.value = 'All';
    els.statusSel.value = 'All';
    els.animeRating.value = 'any';
    els.order.value = 'desc';
    els.groupSeries.classList.add('active');
    els.streamingOnly.classList.remove('active');
    rebuildDynamicFilters();
    loadResults();
  });

  els.prev.addEventListener('click', () => { if (state.page > 1) { state.page--; loadResults(); } });
  els.next.addEventListener('click', () => { state.page++; loadResults(); });

  // Grid: bookmark toggle or open card.
  els.grid.addEventListener('click', (e) => {
    const bm = e.target.closest('[data-bookmark]');
    if (bm) {
      e.stopPropagation();
      handleBookmark(bm);
      return;
    }
    const series = e.target.closest('.series-card');
    if (series) { openSeriesModal(series.dataset.series); return; }
    const card = e.target.closest('.card');
    if (card) openCard(card);
  });
  els.grid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const series = e.target.closest('.series-card');
      if (series) { e.preventDefault(); openSeriesModal(series.dataset.series); return; }
      const card = e.target.closest('.card');
      if (card) { e.preventDefault(); openCard(card); }
    }
  });

  // Modal: watchlist toggle, trailer play, or close.
  els.modalBody.addEventListener('click', (e) => {
    const wt = e.target.closest('[data-watch-toggle]');
    if (wt) {
      const { source, id } = wt.dataset;
      const item = itemsByKey.get(`${source}:${id}`);
      if (item) {
        const added = toggleWatchlist(item);
        wt.classList.toggle('saved', added);
        wt.textContent = added ? '✓ In Watchlist' : '★ Watchlist';
        syncCardBookmark(source, id, added);
      }
      return;
    }
    const rel = e.target.closest('[data-related-id]');
    if (rel) { openAnimeById(rel.dataset.relatedId); return; }
    const ss = e.target.closest('[data-series-sort]');
    if (ss) { setSeriesSort(ss.dataset.seriesSort); return; }
    const back = e.target.closest('[data-back-series]');
    if (back) { openSeriesModal(back.dataset.backSeries); return; }
    const entry = e.target.closest('[data-entry-id]');
    if (entry) {
      const it = itemsByKey.get(`anime:${entry.dataset.entryId}`);
      if (it) openAnimeModal(it, activeSeriesKey);
      return;
    }
    const facade = e.target.closest('.trailer-facade');
    if (facade) {
      facade.closest('.trailer').innerHTML =
        `<iframe class="trailer-frame" src="${facade.dataset.embed}" title="Trailer"
          allow="autoplay; encrypted-media; fullscreen" allowfullscreen loading="lazy"></iframe>`;
    }
  });

  els.modal.addEventListener('click', (e) => {
    if (e.target.dataset.close !== undefined) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modal.hidden) closeModal();
  });
}

function handleBookmark(bm) {
  const { source, id } = bm.dataset;
  const item = itemsByKey.get(`${source}:${id}`);
  if (!item) return;
  const added = toggleWatchlist(item);
  bm.classList.toggle('saved', added);
  bm.textContent = added ? '★' : '☆';
  // In the watchlist view, removing an item should drop it from the grid.
  if (state.source === 'watchlist' && !added) loadResults();
}

function syncCardBookmark(source, id, added) {
  const bm = els.grid.querySelector(`[data-bookmark][data-source="${source}"][data-id="${CSS.escape(String(id))}"]`);
  if (bm) { bm.classList.toggle('saved', added); bm.textContent = added ? '★' : '☆'; }
}

function reload() {
  state.page = 1;
  loadResults();
}

function openCard(card) {
  const { source, id } = card.dataset;
  if (source === 'anime') openAnimeModal(itemsByKey.get(`anime:${id}`));
  else openMovieModal(id);
}

// Pull AniList's live genre list so the Anime tab matches their filter exactly.
async function loadAnimeGenres() {
  try {
    const res = await fetch('/api/anime_genres');
    const json = await res.json();
    if (json.status === 'ok' && Array.isArray(json.data.genres) && json.data.genres.length) {
      ANIME_GENRES = ['All', ...json.data.genres];
      if (state.source === 'anime') rebuildDynamicFilters();
    }
  } catch {
    /* keep the built-in fallback list */
  }
}

// Populate the anime Tag filter from AniList's tag collection, grouped by
// category via <optgroup>. Restores the saved tag selection when present.
async function loadAnimeTags() {
  els.tagSel.innerHTML = '';
  els.tagSel.append(option('All', 'All', state.animeTag === 'All'));
  try {
    const res = await fetch('/api/anime_tags');
    const json = await res.json();
    if (json.status !== 'ok' || !Array.isArray(json.data.tags)) return;
    let currentCat = null;
    let group = null;
    json.data.tags.forEach((t) => {
      if (t.category !== currentCat) {
        currentCat = t.category;
        group = document.createElement('optgroup');
        group.label = currentCat;
        els.tagSel.append(group);
      }
      group.append(option(t.name, t.name, t.name === state.animeTag));
    });
  } catch {
    /* leave just the "All" option */
  }
}

// --- Downloader tab (yt-dlp) -------------------------------------------------
// The server owns the yt-dlp process; this side probes a URL, starts a job, and
// renders whatever the /api/dl/events stream reports back.

const dl = {
  panel: $('downloader'),
  form: $('dl-form'),
  url: $('dl-url'),
  fetchBtn: $('dl-fetch'),
  tools: $('dl-tools'),
  error: $('dl-error'),
  probe: $('dl-probe'),
  jobs: $('dl-jobs'),
  jobsTitle: $('dl-jobs-title'),
  openFolder: $('dl-open-folder'),
  saveDir: $('dl-save-dir'),
};

let dlTools = null;              // { ytdlp, ffmpeg, dir, platform, canSaveAs }
let dlInfo = null;               // last successful probe
let dlStream = null;             // EventSource
let dlOpened = false;
let dlPreferMp4 = false;
const dlJobs = new Map();

const DL_LIVE = new Set(['picking', 'starting', 'downloading', 'merging']);

function dlBytes(n) {
  if (!n || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function dlClock(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

function dlShowError(msg) {
  dl.error.hidden = false;
  dl.error.innerHTML = esc(msg);
}

function dlClearError() {
  dl.error.hidden = true;
  dl.error.textContent = '';
}

// --- Tooling ---
async function dlLoadTools(refresh) {
  try {
    const res = await fetch(`/api/dl/tools${refresh ? '?refresh=1' : ''}`);
    const json = await res.json();
    if (json.status === 'ok') dlTools = json.data;
  } catch { /* leave the previous reading in place */ }
  dlRenderTools();
  dlRenderSaveDir();
}

function dlRenderTools() {
  if (!dlTools) { dl.tools.hidden = true; return; }
  const win = dlTools.platform === 'win32';
  let body = '';

  if (!dlTools.ytdlp.found) {
    body = `<strong>yt-dlp isn't installed.</strong> ${win
      ? 'Run <code>winget install yt-dlp.yt-dlp</code> (or <code>scoop install yt-dlp</code>), or drop <code>yt-dlp.exe</code> into a <code>bin\\</code> folder next to the server.'
      : 'Install it with <code>brew install yt-dlp</code> or <code>pipx install yt-dlp</code>.'}`;
  } else if (!dlTools.ffmpeg.found) {
    body = `<strong>ffmpeg isn't installed</strong>, so downloads are capped at 720p — anything higher arrives as
      separate video and audio streams that need merging. ${win
      ? 'Run <code>winget install Gyan.FFmpeg</code>'
      : 'Install it with <code>brew install ffmpeg</code>'} and re-check.`;
  }

  if (!body) { dl.tools.hidden = true; return; }
  dl.tools.hidden = false;
  dl.tools.className = `dl-notice ${dlTools.ytdlp.found ? 'warn' : 'error'}`;
  dl.tools.innerHTML = `${body} <button class="link-inline" type="button" data-dl-recheck>Re-check</button>`;
}

// --- Probe ---
async function dlDoProbe(e) {
  if (e) e.preventDefault();
  const url = dl.url.value.trim();
  if (!url) return;

  dlClearError();
  dl.probe.hidden = true;
  dl.fetchBtn.disabled = true;
  dl.fetchBtn.textContent = 'Reading…';

  try {
    const res = await fetch(`/api/dl/probe?url=${encodeURIComponent(url)}`);
    const json = await res.json();
    if (json.status !== 'ok') {
      dlShowError(json.status_message || 'Could not read that URL.');
      if (json.missing) dlLoadTools(true);
      return;
    }
    dlInfo = json.data;
    dlRenderProbe();
  } catch {
    dlShowError('Could not reach the server.');
  } finally {
    dl.fetchBtn.disabled = false;
    dl.fetchBtn.textContent = 'Fetch';
  }
}

function dlQualityRow(label, note, attrs, primary) {
  return `<button class="dl-q${primary ? ' primary' : ''}" type="button" ${attrs}>
    <span class="dl-q-label">${esc(label)}</span>
    <span class="dl-q-note">${esc(note || '')}</span>
    <span class="dl-q-go">Download</span>
  </button>`;
}

// The thumbnail row carries two actions, so it's a div with real buttons rather
// than one big button (which can't legally nest them).
function dlThumbRow(t) {
  const dims = t.width && t.height ? `${fmtNumber(t.width)}×${fmtNumber(t.height)}` : '';
  const note = [dims, t.ext].filter(Boolean).join(' · ');
  return `<div class="dl-q dl-q-multi">
    <span class="dl-q-label">Thumbnail</span>
    <span class="dl-q-note">${esc(note)}</span>
    <span class="dl-q-acts">
      <button class="dl-q-act" type="button" data-dl-thumb-view>View</button>
      <button class="dl-q-act primary" type="button" data-dl-thumb-get>Download</button>
    </span>
  </div>`;
}

function dlRenderProbe() {
  const d = dlInfo;
  if (!d) return;
  const noFfmpeg = dlTools && !dlTools.ffmpeg.found;

  const meta = [
    d.uploader,
    d.duration ? dlClock(d.duration) : null,
    d.extractor,
    d.isPlaylist ? `${fmtNumber(d.entryCount)} items` : null,
  ].filter(Boolean).map(esc).join(' · ');

  let rows;
  if (d.isPlaylist) {
    rows = dlQualityRow(
      `Download all ${fmtNumber(d.entryCount)} items`,
      'Best quality available for each',
      'data-dl-go data-playlist="1"', true
    );
  } else {
    // "Best" first, then one row per resolution, then audio.
    rows = dlQualityRow('Best available', 'Highest resolution + best audio', 'data-dl-go', true);
    rows += (d.rows || []).map((r) => {
      const blocked = noFfmpeg && r.needsMerge;
      const note = blocked ? `${r.note} — needs ffmpeg` : r.note;
      return dlQualityRow(r.label, note,
        `data-dl-go data-height="${r.height}"${blocked ? ' disabled' : ''}`);
    }).join('');
    if (d.audio) rows += dlQualityRow(d.audio.label, d.audio.note, 'data-dl-go data-audio="1"');
  }
  if (d.thumbBest) rows += dlThumbRow(d.thumbBest);

  dl.probe.hidden = false;
  dl.probe.innerHTML = `
    <div class="dl-card">
      ${d.thumbnail ? `<div class="dl-thumb"><img src="${esc(d.thumbnail)}" alt="" loading="lazy" /></div>` : ''}
      <div class="dl-card-main">
        <h2 class="dl-card-title">${esc(d.title)}</h2>
        ${meta ? `<div class="dl-card-meta">${meta}</div>` : ''}
        <label class="dl-check">
          <input type="checkbox" id="dl-mp4" ${dlPreferMp4 ? 'checked' : ''} />
          <span>Prefer MP4 (more compatible; MKV keeps the best streams untouched)</span>
        </label>
        <div class="dl-qualities">${rows}</div>
      </div>
    </div>`;

  const mp4 = $('dl-mp4');
  if (mp4) mp4.addEventListener('change', () => { dlPreferMp4 = mp4.checked; dlSavePrefs(); });
}

// The container preference is worth keeping across refreshes.
const DL_PREFS_KEY = 'media-library:dl-prefs';

function dlSavePrefs() {
  try {
    localStorage.setItem(DL_PREFS_KEY, JSON.stringify({ preferMp4: dlPreferMp4 }));
  } catch { /* ignore quota */ }
}

function dlLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DL_PREFS_KEY));
    if (saved && typeof saved.preferMp4 === 'boolean') dlPreferMp4 = saved.preferMp4;
  } catch { /* keep the defaults */ }
}

// --- Jobs ---
async function dlStart(opts) {
  dlClearError();
  try {
    const res = await fetch('/api/dl/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: dlInfo ? dlInfo.url : dl.url.value.trim(),
        title: dlInfo ? dlInfo.title : null,
        thumbnail: dlInfo ? dlInfo.thumbnail : null,
        preferMp4: dlPreferMp4,
        ...opts,
      }),
    });
    const json = await res.json();
    if (json.status !== 'ok') {
      dlShowError(json.status_message || 'Could not start the download.');
      if (json.missing) dlLoadTools(true);
      return;
    }
    dlJobs.set(json.data.id, json.data);
    dlRenderJobs();
  } catch {
    dlShowError('Could not reach the server.');
  }
}

async function dlCancel(id) {
  try { await fetch(`/api/dl/cancel?job=${encodeURIComponent(id)}`, { method: 'POST' }); } catch { /* ignore */ }
}

async function dlReveal(id) {
  const qs = id ? `?job=${encodeURIComponent(id)}` : '';
  try { await fetch(`/api/dl/reveal${qs}`, { method: 'POST' }); } catch { /* ignore */ }
}

function dlJobState(j) {
  if (j.status === 'downloading') {
    const of = j.itemCount > 1 ? ` · ${j.item}/${j.itemCount}` : '';
    return `${j.pct.toFixed(1)}%${of}`;
  }
  if (j.status === 'picking') return 'Choose a location…';
  if (j.status === 'starting') return 'Starting…';
  if (j.status === 'merging') return 'Merging…';
  if (j.status === 'done') return 'Done';
  if (j.status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function dlJobHtml(j) {
  const live = DL_LIVE.has(j.status);
  const meta = j.status === 'downloading'
    ? [
      j.total ? `${dlBytes(j.downloaded)} / ${dlBytes(j.total)}` : dlBytes(j.downloaded),
      j.speed ? `${dlBytes(j.speed)}/s` : '',
      j.eta ? `${dlClock(j.eta)} left` : '',
    ].filter(Boolean).join(' · ')
    : j.status === 'error'
      ? esc(j.error || 'Failed')
      : j.files.length
        ? esc(j.files[j.files.length - 1].split(/[\\/]/).pop())
        : '';

  const actions = live
    ? `<button class="btn-ghost" type="button" data-dl-cancel="${esc(j.id)}">Cancel</button>`
    : j.status === 'done' && j.files.length
      ? `<button class="btn-ghost" type="button" data-dl-reveal="${esc(j.id)}">Show in folder</button>`
      : '';

  return `<div class="dl-job ${esc(j.status)}">
    ${j.thumbnail ? `<div class="dl-job-thumb"><img src="${esc(j.thumbnail)}" alt="" loading="lazy" /></div>` : ''}
    <div class="dl-job-main">
      <div class="dl-job-top">
        <span class="dl-job-title" title="${esc(j.title)}">${esc(j.title)}</span>
        <span class="dl-job-state">${esc(dlJobState(j))}</span>
      </div>
      <div class="dl-track"><div class="dl-fill" style="width:${j.status === 'done' ? 100 : j.pct || 0}%"></div></div>
      <div class="dl-job-foot">
        <span class="dl-job-meta">${meta}</span>
        ${actions}
      </div>
    </div>
  </div>`;
}

function dlRenderJobs() {
  const list = [...dlJobs.values()].sort((a, b) => Number(b.id) - Number(a.id));
  dl.jobsTitle.hidden = list.length === 0;
  dl.openFolder.hidden = list.length === 0;
  dl.jobs.innerHTML = list.map(dlJobHtml).join('');
}

// The folder the next download defaults to — the last one actually saved into.
function dlRenderSaveDir() {
  if (!dlTools || !dlTools.dir) { dl.saveDir.hidden = true; return; }
  dl.saveDir.hidden = false;
  dl.saveDir.textContent = dlTools.dir;
  dl.saveDir.title = `Last used: ${dlTools.dir}`;
}

async function dlLoadJobs() {
  try {
    const res = await fetch('/api/dl/jobs');
    const json = await res.json();
    if (json.status === 'ok') {
      json.data.jobs.forEach((j) => dlJobs.set(j.id, j));
      dlRenderJobs();
    }
  } catch { /* the event stream will fill this in as jobs move */ }
}

function dlConnect() {
  if (dlStream) return;
  try {
    dlStream = new EventSource('/api/dl/events');
  } catch {
    return;
  }
  dlStream.onmessage = (e) => {
    let job;
    try { job = JSON.parse(e.data); } catch { return; }
    if (!job || !job.id) return; // the opening hello frame
    dlJobs.set(job.id, job);
    dlRenderJobs();
    // A job that picked a new folder is the server's record of "last used".
    if (job.folder && dlTools && job.folder !== dlTools.dir) {
      dlTools.dir = job.folder;
      dlRenderSaveDir();
    }
  };
  // EventSource reconnects on its own; a refetch resyncs anything missed.
  dlStream.onerror = () => { /* handled by the browser */ };
}

// Called every time the tab is shown; the heavy lifting only runs once.
function dlOnOpen() {
  if (dlOpened) return;
  dlOpened = true;
  dlLoadPrefs();
  dlLoadTools();
  dlLoadJobs();
  dlConnect();
  dl.url.focus();
}

function bindDownloader() {
  dl.form.addEventListener('submit', dlDoProbe);

  dl.probe.addEventListener('click', (e) => {
    const thumb = dlInfo && dlInfo.thumbBest;
    // Viewing is a plain navigation to the image host — no server round trip.
    if (e.target.closest('[data-dl-thumb-view]')) {
      if (thumb) window.open(thumb.url, '_blank', 'noopener');
      return;
    }
    if (e.target.closest('[data-dl-thumb-get]')) {
      if (thumb) dlStart({ thumbnailOnly: true, thumbExt: thumb.ext });
      return;
    }
    const go = e.target.closest('[data-dl-go]');
    if (!go || go.hasAttribute('disabled')) return;
    dlStart({
      height: go.dataset.height ? Number(go.dataset.height) : null,
      audioOnly: go.dataset.audio === '1',
      playlist: go.dataset.playlist === '1',
    });
  });

  dl.jobs.addEventListener('click', (e) => {
    const cancel = e.target.closest('[data-dl-cancel]');
    if (cancel) { dlCancel(cancel.dataset.dlCancel); return; }
    const reveal = e.target.closest('[data-dl-reveal]');
    if (reveal) dlReveal(reveal.dataset.dlReveal);
  });

  dl.tools.addEventListener('click', (e) => {
    if (e.target.closest('[data-dl-recheck]')) dlLoadTools(true);
  });

  dl.openFolder.addEventListener('click', () => dlReveal(null));
}

// --- Preferences (persist tab / query / filters across a refresh) ---
const PREFS_KEY = 'media-library:prefs';
const PREF_KEYS = ['query', 'source', 'page', 'quality', 'moviePopular', 'movieRating', 'movieGenre', 'movieSort',
  'order', 'animeGenre', 'animeTag', 'format', 'animeStatus', 'animeRating', 'animeSort', 'groupSeries', 'streamingOnly',
  'sidebarCollapsed'];

function savePrefs() {
  const data = {};
  PREF_KEYS.forEach((k) => { data[k] = state[k]; });
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(data)); } catch { /* ignore quota */ }
}

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (saved && typeof saved === 'object') {
      PREF_KEYS.forEach((k) => { if (k in saved) state[k] = saved[k]; });
    }
  } catch { /* ignore */ }
}

// Push restored state into the actual form controls.
function syncControlsToState() {
  els.search.value = state.query || '';
  els.quality.value = state.quality;
  els.moviePopular.value = state.moviePopular;
  els.movieRating.value = state.movieRating;
  els.format.value = state.format;
  els.statusSel.value = state.animeStatus;
  els.animeRating.value = state.animeRating;
  els.order.value = state.order;
  els.groupSeries.classList.toggle('active', state.groupSeries);
  els.streamingOnly.classList.toggle('active', state.streamingOnly);
  rebuildDynamicFilters(); // genre + sort selects, based on source + state
  applySidebar();          // collapsed / expanded rail
  applySourceUI();         // field visibility + active source button
}

// --- Init ---
buildStaticControls();
loadPrefs();
syncControlsToState();
bindEvents();
bindDownloader();
loadAnimeGenres();
loadAnimeTags();
loadResults();
