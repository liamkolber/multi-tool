// YTS Library Browser — frontend logic.
// Talks to our own /api/* proxy (which forwards to the YTS API).

const GENRES = [
  'All', 'Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime',
  'Documentary', 'Drama', 'Family', 'Fantasy', 'Film-Noir', 'History', 'Horror',
  'Music', 'Musical', 'Mystery', 'News', 'Romance', 'Sci-Fi', 'Sport',
  'Thriller', 'War', 'Western',
];

const QUALITIES = ['All', '480p', '720p', '1080p', '1080p.x265', '2160p', '3D'];

const SORTS = [
  ['date_added', 'Date added'],
  ['download_count', 'Downloads'],
  ['like_count', 'Likes'],
  ['rating', 'Rating'],
  ['year', 'Year'],
  ['title', 'Title'],
  ['peers', 'Peers'],
  ['seeds', 'Seeds'],
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
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='170' height='255'>
       <rect width='100%' height='100%' fill='#1d2230'/>
       <text x='50%' y='50%' fill='#4a5265' font-family='sans-serif'
         font-size='16' text-anchor='middle'>No poster</text>
     </svg>`
  );

const LIMIT = 20;

const state = {
  query_term: '',
  quality: 'All',
  genre: 'All',
  minimum_rating: 0,
  sort_by: 'date_added',
  order_by: 'desc',
  page: 1,
  movieCount: 0,
};

// --- DOM refs ---
const $ = (id) => document.getElementById(id);
const els = {
  search: $('search'),
  quality: $('quality'),
  genre: $('genre'),
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

// Escape user/API text before inserting as HTML.
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

// --- Populate filter controls ---
function buildControls() {
  QUALITIES.forEach((q) => els.quality.append(option(q, q, q === state.quality)));
  GENRES.forEach((g) => els.genre.append(option(g, g, g === state.genre)));

  els.rating.append(option('0', 'Any', true));
  for (let r = 9; r >= 5; r--) els.rating.append(option(String(r), `${r}+ ★`));

  SORTS.forEach(([v, label]) => els.sort.append(option(v, label, v === state.sort_by)));

  els.order.append(option('desc', 'Descending', true));
  els.order.append(option('asc', 'Ascending'));
}

// --- Fetch + render list ---
function buildListUrl() {
  const p = new URLSearchParams({
    limit: String(LIMIT),
    page: String(state.page),
    sort_by: state.sort_by,
    order_by: state.order_by,
  });
  if (state.query_term) p.set('query_term', state.query_term);
  if (state.quality !== 'All') p.set('quality', state.quality);
  if (state.genre !== 'All') p.set('genre', state.genre);
  if (state.minimum_rating > 0) p.set('minimum_rating', String(state.minimum_rating));
  return `/api/list_movies?${p.toString()}`;
}

function showStatus(html) {
  els.status.hidden = false;
  els.status.innerHTML = html;
  els.grid.innerHTML = '';
}

async function loadMovies() {
  els.grid.classList.add('loading');
  els.resultsInfo.textContent = 'Loading…';

  try {
    const res = await fetch(buildListUrl());
    const json = await res.json();

    if (json.status !== 'ok') {
      throw new Error(json.status_message || 'The API returned an error.');
    }

    const data = json.data;
    state.movieCount = data.movie_count || 0;
    const movies = data.movies || [];

    els.status.hidden = true;

    if (movies.length === 0) {
      showStatus('<div class="status">No movies matched your filters.</div>');
      els.resultsInfo.textContent = '0 movies found';
      updatePager();
      return;
    }

    renderGrid(movies);
    els.resultsInfo.textContent = `${fmtNumber(state.movieCount)} movies found`;
    updatePager();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    showStatus(
      `<div class="status">⚠️ Could not load movies.<br><small>${esc(err.message)}</small></div>`
    );
    els.resultsInfo.textContent = '';
  } finally {
    els.grid.classList.remove('loading');
  }
}

function renderGrid(movies) {
  els.grid.innerHTML = movies.map(cardHtml).join('');
}

function cardHtml(m) {
  const qualities = [...new Set((m.torrents || []).map((t) => t.quality))];
  const tags = qualities
    .map((q) => `<span class="quality-tag">${esc(q)}</span>`)
    .join('');
  const poster = m.medium_cover_image || m.large_cover_image || PLACEHOLDER;
  const rating = m.rating
    ? `<div class="rating-badge"><span class="star">★</span>${m.rating}</div>`
    : '';

  return `
    <article class="card" data-id="${m.id}" tabindex="0">
      <div class="poster">
        <img src="${esc(poster)}" alt="${esc(m.title)} poster" loading="lazy"
             onerror="this.onerror=null;this.src='${PLACEHOLDER}'" />
        ${rating}
        <div class="quality-tags">${tags}</div>
      </div>
      <div class="card-body">
        <h3 class="card-title">${esc(m.title)}</h3>
        <div class="card-meta">${m.year || '—'}</div>
      </div>
    </article>`;
}

function updatePager() {
  const totalPages = Math.max(1, Math.ceil(state.movieCount / LIMIT));
  els.prev.disabled = state.page <= 1;
  els.next.disabled = state.page >= totalPages;
  els.pageInfo.textContent = `Page ${fmtNumber(state.page)} of ${fmtNumber(totalPages)}`;
}

// --- Detail modal ---
async function openModal(id) {
  els.modal.hidden = false;
  document.body.style.overflow = 'hidden';
  els.modalBody.innerHTML = '<div class="status" style="width:100%"><div class="spinner"></div>Loading details…</div>';

  try {
    const res = await fetch(`/api/movie_details?movie_id=${encodeURIComponent(id)}&with_images=true&with_cast=true`);
    const json = await res.json();
    if (json.status !== 'ok' || !json.data || !json.data.movie) {
      throw new Error(json.status_message || 'Movie not found.');
    }
    els.modalBody.innerHTML = detailHtml(json.data.movie);
  } catch (err) {
    els.modalBody.innerHTML = `<div class="status" style="width:100%">⚠️ ${esc(err.message)}</div>`;
  }
}

function detailHtml(m) {
  const poster = m.large_cover_image || m.medium_cover_image || PLACEHOLDER;
  const genres = (m.genres || [])
    .map((g) => `<span class="chip">${esc(g)}</span>`)
    .join('');

  const runtime = m.runtime ? `${m.runtime} min` : null;
  const subParts = [m.year, runtime, m.language ? m.language.toUpperCase() : null, m.mpa_rating]
    .filter(Boolean)
    .map(esc);
  const ratingHtml = m.rating ? `<span class="star">★</span> ${m.rating}/10` : '';

  const actions = [];
  if (m.yt_trailer_code) {
    actions.push(
      `<a class="link-btn primary" target="_blank" rel="noopener"
        href="https://www.youtube.com/watch?v=${esc(m.yt_trailer_code)}">▶ Trailer</a>`
    );
  }
  if (m.imdb_code) {
    actions.push(
      `<a class="link-btn" target="_blank" rel="noopener"
        href="https://www.imdb.com/title/${esc(m.imdb_code)}/">IMDb</a>`
    );
  }
  if (m.url) {
    actions.push(`<a class="link-btn" target="_blank" rel="noopener" href="${esc(m.url)}">YTS page</a>`);
  }

  const torrents = (m.torrents || [])
    .map((t) => {
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
    })
    .join('');

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
      <h4 class="torrents-title">Downloads</h4>
      <div class="torrent-list">${torrents || '<span class="card-meta">No torrents listed.</span>'}</div>
    </div>`;
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
      state.query_term = e.target.value.trim();
      state.page = 1;
      loadMovies();
    }, 400)
  );

  const onFilterChange = () => {
    state.quality = els.quality.value;
    state.genre = els.genre.value;
    state.minimum_rating = Number(els.rating.value);
    state.sort_by = els.sort.value;
    state.order_by = els.order.value;
    state.page = 1;
    loadMovies();
  };
  [els.quality, els.genre, els.rating, els.sort, els.order].forEach((el) =>
    el.addEventListener('change', onFilterChange)
  );

  els.reset.addEventListener('click', () => {
    Object.assign(state, {
      query_term: '', quality: 'All', genre: 'All', minimum_rating: 0,
      sort_by: 'date_added', order_by: 'desc', page: 1,
    });
    els.search.value = '';
    els.quality.value = 'All';
    els.genre.value = 'All';
    els.rating.value = '0';
    els.sort.value = 'date_added';
    els.order.value = 'desc';
    loadMovies();
  });

  els.prev.addEventListener('click', () => {
    if (state.page > 1) { state.page--; loadMovies(); }
  });
  els.next.addEventListener('click', () => {
    state.page++; loadMovies();
  });

  // Open modal from a card (click or keyboard).
  els.grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) openModal(card.dataset.id);
  });
  els.grid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('.card');
      if (card) { e.preventDefault(); openModal(card.dataset.id); }
    }
  });

  // Close modal.
  els.modal.addEventListener('click', (e) => {
    if (e.target.dataset.close !== undefined) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modal.hidden) closeModal();
  });
}

// --- Init ---
buildControls();
bindEvents();
loadMovies();
