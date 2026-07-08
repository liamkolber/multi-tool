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
const AUDIENCES = [
  ['sfw', 'All ages'], ['adult', 'Adult (18+)'], ['all', 'All (incl. adult)'],
];

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
  quality: 'All', moviePopular: 'off', movieGenre: 'All', movieSort: 'date_added', order: 'desc',
  // anime filters
  animeGenre: 'All', animeTag: 'All', format: 'All', animeStatus: 'All', animeSort: 'popularity', audience: 'sfw',
  // shared — grouping is on by default; the pill toggles it off
  minRating: 0, groupSeries: true, streamingOnly: false,
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
  genre: $('genre'),
  tagSel: $('anime-tag'),
  format: $('format'),
  statusSel: $('anime-status'),
  audience: $('anime-audience'),
  groupSeries: $('group-series'),
  streamingOnly: $('streaming-only'),
  rating: $('rating'),
  sort: $('sort'),
  order: $('order'),
  reset: $('reset'),
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
  FORMATS.forEach(([v, label]) => els.format.append(option(v, label, v === 'All')));
  STATUSES.forEach(([v, label]) => els.statusSel.append(option(v, label, v === 'All')));
  AUDIENCES.forEach(([v, label]) => els.audience.append(option(v, label, v === 'sfw')));

  els.rating.append(option('0', 'Any', true));
  for (let r = 9; r >= 5; r--) els.rating.append(option(String(r), `${r}+ ★`));

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
  document.querySelectorAll('.filters [data-for]').forEach((el) => {
    const modes = el.dataset.for.split(' ');
    el.classList.toggle('hide', !modes.includes(state.source));
  });
  document.querySelectorAll('.src-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.src === state.source)
  );
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
  };
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
  const meta = [e.year || '—', fmtFormat(e.format), e.episodes ? `${e.episodes} ep` : null].filter(Boolean).join(' · ');
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
  if (state.minRating > 0) p.set('minimum_rating', String(state.minRating));

  const res = await fetch(`/api/list_movies?${p.toString()}`);
  const json = await res.json();
  if (json.status !== 'ok') throw new Error(json.status_message || 'Movie API error');

  const total = json.data.movie_count || 0;
  return {
    items: (json.data.movies || []).map(normalizeMovie),
    total,
    hasNext: state.page < Math.ceil(total / limit),
  };
}

async function fetchAnime(limit) {
  const p = new URLSearchParams({ perPage: String(limit), page: String(state.page) });
  if (state.query) p.set('q', state.query);
  p.set('sort', state.source === 'all' ? (state.query ? 'match' : 'popularity') : state.animeSort);
  if (state.source === 'anime') {
    if (state.animeGenre !== 'All') p.set('genre', state.animeGenre);
    if (state.animeTag !== 'All') p.set('tag', state.animeTag);
    if (state.format !== 'All') p.set('format', state.format);
    if (state.animeStatus !== 'All') p.set('status', state.animeStatus);
    if (state.audience !== 'sfw') p.set('audience', state.audience);
  }
  if (state.minRating > 0) p.set('min_score', String(state.minRating * 10));

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
      const r = await fetchMovies(MOVIES_LIMIT);
      items = r.items;
      state.hasNext = r.hasNext;
      state.totalPages = Math.max(1, Math.ceil(r.total / MOVIES_LIMIT));
      els.resultsInfo.textContent =
        state.moviePopular === 'all' ? `${fmtNumber(r.total)} movies · most downloaded (all time)`
        : state.moviePopular === 'year' ? `${fmtNumber(r.total)} from ${new Date().getFullYear()} · most downloaded`
        : `${fmtNumber(r.total)} movies found`;
    } else if (state.source === 'anime') {
      // Pull a bigger page when grouping or streaming-filtering so pages stay full.
      const limit = (state.groupSeries || state.streamingOnly) ? 50 : ANIME_LIMIT;
      const r = await fetchAnime(limit);
      items = r.items;
      state.hasNext = r.hasNext;
      if (state.streamingOnly) {
        // Post-filtered, so the raw total no longer applies.
        state.totalPages = null;
        els.resultsInfo.textContent = 'Anime with an official streaming source';
      } else {
        state.totalPages = r.total ? Math.max(1, Math.ceil(r.total / limit)) : null;
        els.resultsInfo.textContent = `${fmtNumber(r.total)} anime found`;
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
    const meta = [it.year || '—', fmtFormat(it.format), it.episodes ? `${it.episodes} ep` : null]
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
        <div class="card-meta">${it.year || '—'}</div>
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
  const subParts = [m.year, runtime, m.language ? m.language.toUpperCase() : null, m.mpa_rating]
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
  const sub = [it.year, fmtFormat(it.format), it.episodes ? `${it.episodes} ep` : null, niceStatus(it.status), it.studio]
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
  els.format.addEventListener('change', () => { state.format = els.format.value; reload(); });
  els.tagSel.addEventListener('change', () => { state.animeTag = els.tagSel.value; reload(); });
  els.statusSel.addEventListener('change', () => { state.animeStatus = els.statusSel.value; reload(); });
  els.audience.addEventListener('change', () => { state.audience = els.audience.value; reload(); });
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
  els.rating.addEventListener('change', () => { state.minRating = Number(els.rating.value); reload(); });
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
      quality: 'All', moviePopular: 'off', movieGenre: 'All', movieSort: 'date_added', order: 'desc',
      animeGenre: 'All', animeTag: 'All', format: 'All', animeStatus: 'All', animeSort: 'popularity',
      audience: 'sfw', minRating: 0, groupSeries: true, streamingOnly: false,
    });
    els.search.value = '';
    els.quality.value = 'All';
    els.moviePopular.value = 'off';
    els.tagSel.value = 'All';
    els.format.value = 'All';
    els.statusSel.value = 'All';
    els.audience.value = 'sfw';
    els.rating.value = '0';
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

// --- Preferences (persist tab / query / filters across a refresh) ---
const PREFS_KEY = 'media-library:prefs';
const PREF_KEYS = ['query', 'source', 'page', 'quality', 'moviePopular', 'movieGenre', 'movieSort',
  'order', 'animeGenre', 'animeTag', 'format', 'animeStatus', 'audience', 'animeSort', 'minRating', 'groupSeries', 'streamingOnly'];

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
  els.format.value = state.format;
  els.statusSel.value = state.animeStatus;
  els.audience.value = state.audience;
  els.rating.value = String(state.minRating);
  els.order.value = state.order;
  els.groupSeries.classList.toggle('active', state.groupSeries);
  els.streamingOnly.classList.toggle('active', state.streamingOnly);
  rebuildDynamicFilters(); // genre + sort selects, based on source + state
  applySourceUI();         // field visibility + active source button
}

// --- Init ---
buildStaticControls();
loadPrefs();
syncControlsToState();
bindEvents();
loadAnimeGenres();
loadAnimeTags();
loadResults();
