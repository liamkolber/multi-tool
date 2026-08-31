// Manga — AniList's manga catalogue, in the same shape as the anime tab.
//
// The server normalises AniList into flat records, so everything here is
// rendering and filter state. Nothing is fetched twice: the server caches
// upstream responses and the reading list lives in this browser.

import { $, esc, fmtNumber, debounce, showModal } from '../lib/dom.js';

const TEMPLATE = `
  <div class="tool-head">
    <h1 class="tool-title"><span class="tool-title-icon">📖</span> Manga</h1>
    <p class="tool-sub">Manga, manhwa, manhua and light novels — covers, synopses and where to read them officially.</p>
  </div>

  <div class="mg-bar">
    <input id="mg-search" type="search" placeholder="Search by title…" autocomplete="off" />
    <select id="mg-sort">
      <option value="popularity">Most popular</option>
      <option value="trending">Trending now</option>
      <option value="score">Highest rated</option>
      <option value="favourites">Most favourited</option>
      <option value="newest">Newest</option>
      <option value="title">Title A–Z</option>
    </select>
    <button id="mg-list-btn" class="mg-btn" type="button">Reading list</button>
  </div>

  <div class="mg-filters">
    <label class="mg-field"><span>Genre</span><select id="mg-genre"></select></label>
    <label class="mg-field"><span>Kind</span>
      <select id="mg-format">
        <option value="All">Any</option>
        <option value="MANGA">Manga / manhwa</option>
        <option value="ONE_SHOT">One-shot</option>
        <option value="NOVEL">Light novel</option>
      </select>
    </label>
    <label class="mg-field"><span>Origin</span>
      <select id="mg-country">
        <option value="All">Anywhere</option>
        <option value="JP">Japan — manga</option>
        <option value="KR">Korea — manhwa</option>
        <option value="CN">China — manhua</option>
      </select>
    </label>
    <label class="mg-field"><span>Status</span>
      <select id="mg-status">
        <option value="All">Any</option>
        <option value="RELEASING">Ongoing</option>
        <option value="FINISHED">Completed</option>
        <option value="HIATUS">On hiatus</option>
        <option value="CANCELLED">Cancelled</option>
        <option value="NOT_YET_RELEASED">Not out yet</option>
      </select>
    </label>
    <label class="mg-field"><span>Min score</span>
      <select id="mg-score">
        <option value="any">Any</option>
        <option value="70">7+</option>
        <option value="80">8+</option>
        <option value="85">8.5+</option>
        <option value="90">9+</option>
      </select>
    </label>
    <label class="mg-field"><span>Mature</span>
      <select id="mg-adult">
        <option value="sfw">Hide</option>
        <option value="all">Include</option>
        <option value="adult">Only</option>
      </select>
    </label>
  </div>

  <div id="mg-status-line" class="mg-status"></div>
  <div id="mg-grid" class="mg-grid"></div>
  <div id="mg-more" class="mg-more" hidden></div>`;

const mg = {};
function cacheEls() {
  Object.assign(mg, {
    search: $('mg-search'),
    sort: $('mg-sort'),
    listBtn: $('mg-list-btn'),
    genre: $('mg-genre'),
    format: $('mg-format'),
    country: $('mg-country'),
    status: $('mg-status'),
    score: $('mg-score'),
    adult: $('mg-adult'),
    line: $('mg-status-line'),
    grid: $('mg-grid'),
    more: $('mg-more'),
  });
}

let mgItems = [];
let mgPage = 1;
let mgHasNext = false;
let mgLoading = false;
let mgShowingList = false;
let mgSeq = 0;   // guards against a slow response overwriting a newer one

// AniList caps pageInfo.total at 5000, so anything at the cap is "at least".
const MG_TOTAL_CAP = 5000;

const MG_LIST_KEY = 'multitool:manga-list';

function mgList() {
  try {
    const raw = JSON.parse(localStorage.getItem(MG_LIST_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function mgSaveList(list) {
  try { localStorage.setItem(MG_LIST_KEY, JSON.stringify(list.slice(0, 500))); } catch { /* quota */ }
}

const mgOnList = (id) => mgList().some((x) => String(x.id) === String(id));

function mgToggleList(item) {
  const list = mgList();
  const i = list.findIndex((x) => String(x.id) === String(item.id));
  if (i >= 0) list.splice(i, 1);
  else list.unshift(item);
  mgSaveList(list);
  return i < 0;
}

// --- Rendering ---
const MG_STATUS = {
  RELEASING: 'Ongoing',
  FINISHED: 'Complete',
  HIATUS: 'Hiatus',
  CANCELLED: 'Cancelled',
  NOT_YET_RELEASED: 'Upcoming',
};

// What a card can honestly say about length. AniList leaves chapters null for
// anything still running, which is most of what people are looking for.
function mgLength(m) {
  if (m.chapters) return `${fmtNumber(m.chapters)} ch`;
  if (m.volumes) return `${fmtNumber(m.volumes)} vol`;
  return m.status === 'RELEASING' ? 'ongoing' : '';
}

function mgCardHtml(m) {
  const bits = [m.kind, m.year || null, mgLength(m)].filter(Boolean);
  const saved = mgOnList(m.id);
  return `<article class="mg-card" data-id="${esc(m.id)}">
    <button class="mg-cover" type="button" data-open="${esc(m.id)}" title="${esc(m.title)}">
      ${m.poster
    ? `<img src="${esc(m.poster)}" alt="" loading="lazy" decoding="async" />`
    : '<span class="mg-nocover">📖</span>'}
      ${m.rating ? `<span class="mg-score">${esc(m.rating.toFixed(1))}</span>` : ''}
      ${m.isAdult ? '<span class="mg-adult-flag">18+</span>' : ''}
    </button>
    <div class="mg-card-body">
      <div class="mg-card-title" title="${esc(m.title)}">${esc(m.title)}</div>
      <div class="mg-card-meta">${bits.map(esc).join(' · ')}</div>
    </div>
    <button class="mg-save${saved ? ' on' : ''}" type="button" data-save="${esc(m.id)}"
      title="${saved ? 'On your reading list' : 'Add to reading list'}">${saved ? '★' : '☆'}</button>
  </article>`;
}

function mgRenderGrid() {
  if (!mgItems.length) {
    mg.grid.innerHTML = `<div class="mg-empty">${
      mgShowingList ? 'Your reading list is empty. Star anything to keep it here.' : 'Nothing matched that.'
    }</div>`;
    mg.more.hidden = true;
    return;
  }
  mg.grid.innerHTML = mgItems.map(mgCardHtml).join('');
}

function mgSetLine(text, kind) {
  mg.line.textContent = text || '';
  mg.line.className = `mg-status${kind ? ` ${kind}` : ''}`;
}

// --- Fetching ---
function mgQuery(page) {
  const p = new URLSearchParams({
    page: String(page),
    perPage: '30',
    sort: mg.sort.value,
    adult: mg.adult.value,
  });
  const q = mg.search.value.trim();
  if (q) p.set('query', q);
  for (const [name, el] of [['genre', mg.genre], ['format', mg.format],
    ['country', mg.country], ['status', mg.status]]) {
    if (el.value && el.value !== 'All') p.set(name, el.value);
  }
  if (mg.score.value !== 'any') p.set('score', mg.score.value);
  return p.toString();
}

async function mgLoad(page = 1) {
  if (mgLoading) return;
  mgLoading = true;
  mgShowingList = false;
  mg.listBtn.classList.remove('on');

  const mine = ++mgSeq;
  if (page === 1) mgSetLine('Searching…');

  try {
    const res = await fetch(`/api/manga/search?${mgQuery(page)}`);
    const json = await res.json();
    // A slower earlier request must not overwrite a newer one's results.
    if (mine !== mgSeq) return;

    if (json.status !== 'ok') {
      mgSetLine(json.status_message || 'AniList could not answer that.', 'error');
      return;
    }

    mgPage = json.data.page;
    mgHasNext = json.data.hasNext;
    mgItems = page === 1 ? json.data.items : mgItems.concat(json.data.items);

    const total = json.data.total >= MG_TOTAL_CAP
      ? `${fmtNumber(MG_TOTAL_CAP)}+`
      : fmtNumber(json.data.total);
    mgSetLine(json.data.total
      ? `${total} titles · showing ${fmtNumber(mgItems.length)}`
      : 'Nothing matched that.');

    mgRenderGrid();
    mg.more.hidden = !mgHasNext;
    mg.more.innerHTML = mgHasNext
      ? '<button class="mg-btn" type="button" data-more>Show more</button>'
      : '';
  } catch {
    if (mine === mgSeq) mgSetLine('Could not reach the server.', 'error');
  } finally {
    if (mine === mgSeq) mgLoading = false;
  }
}

const mgSearchNow = debounce(() => mgLoad(1), 350);

function mgShowList() {
  mgShowingList = true;
  mg.listBtn.classList.add('on');
  mgItems = mgList();
  mg.more.hidden = true;
  mgSetLine(mgItems.length ? `${fmtNumber(mgItems.length)} on your reading list` : '');
  mgRenderGrid();
}

// --- Details ---
function mgLinkRows(links) {
  if (!links.length) return '';
  return `<div class="mg-links">${links.map((l) =>
    `<a class="mg-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.site)}</a>`
  ).join('')}</div>`;
}

async function mgOpen(id) {
  // One root element: .modal-body is a flex row, so siblings become columns.
  showModal('<div class="mg-detail"><div class="mg-detail-wait">Loading…</div></div>');

  let d;
  try {
    const res = await fetch(`/api/manga/details?id=${encodeURIComponent(id)}`);
    const json = await res.json();
    if (json.status !== 'ok') throw new Error(json.status_message || 'Could not load that title.');
    d = json.data;
  } catch (err) {
    showModal(`<div class="mg-detail"><div class="mg-detail-wait">${esc(err.message)}</div></div>`);
    return;
  }

  const facts = [
    ['Kind', d.kind],
    ['Ran', d.year ? `${d.year}${d.endYear && d.endYear !== d.year ? `–${d.endYear}` : d.status === 'RELEASING' ? '–' : ''}` : null],
    ['Status', MG_STATUS[d.status] || d.status],
    ['Chapters', d.chapters ? fmtNumber(d.chapters) : null],
    ['Volumes', d.volumes ? fmtNumber(d.volumes) : null],
    ['Score', d.rating ? `${d.rating.toFixed(1)} / 10` : null],
    ['Favourites', d.favourites ? fmtNumber(d.favourites) : null],
    ['Story', d.authors.join(', ') || null],
    ['Art', d.artists.join(', ') || null],
  ].filter(([, v]) => v);

  const saved = mgOnList(d.id);

  showModal(`<div class="mg-detail">
    <div class="mg-detail-top">
      ${d.poster ? `<img class="mg-detail-cover" src="${esc(d.poster)}" alt="" />` : ''}
      <div class="mg-detail-head">
        <h2 class="mg-detail-title">${esc(d.title)}</h2>
        ${d.title_secondary ? `<div class="mg-detail-alt">${esc(d.title_secondary)}</div>` : ''}
        ${d.native ? `<div class="mg-detail-alt">${esc(d.native)}</div>` : ''}
        <div class="mg-genres">${d.genres.map((g) => `<span class="mg-tag">${esc(g)}</span>`).join('')}</div>
        <dl class="mg-facts">${facts.map(([k, v]) =>
    `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <div class="mg-detail-actions">
          <button class="mg-btn${saved ? ' on' : ''}" type="button" data-save-detail="${esc(d.id)}">
            ${saved ? '★ On your list' : '☆ Add to reading list'}</button>
          ${d.siteUrl ? `<a class="mg-btn" href="${esc(d.siteUrl)}" target="_blank" rel="noopener noreferrer">AniList</a>` : ''}
        </div>
      </div>
    </div>

    ${d.summary ? `<p class="mg-summary">${esc(d.summary)}</p>` : ''}

    ${d.tags.length ? `<div class="mg-section"><h3>Themes</h3>
      <div class="mg-genres">${d.tags.map((t) => `<span class="mg-tag soft">${esc(t.name)}</span>`).join('')}</div></div>` : ''}

    ${d.links.length ? `<div class="mg-section"><h3>Read it officially</h3>
      ${mgLinkRows(d.links)}
      <p class="mg-note">Publisher and storefront links as listed by AniList.</p></div>` : ''}

    ${d.characters.length ? `<div class="mg-section"><h3>Characters</h3>
      <div class="mg-people">${d.characters.map((c) => `<div class="mg-person">
        ${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" />` : '<span class="mg-nocover">?</span>'}
        <span class="mg-person-name">${esc(c.name)}</span>
      </div>`).join('')}</div></div>` : ''}

    ${d.related.length ? `<div class="mg-section"><h3>Related</h3>
      <div class="mg-related">${d.related.map((r) => `
        <button class="mg-rel" type="button" data-open="${esc(r.id)}">
          ${r.poster ? `<img src="${esc(r.poster)}" alt="" loading="lazy" />` : ''}
          <span class="mg-rel-title">${esc(r.title)}</span>
          <span class="mg-rel-kind">${esc(r.relation)}</span>
        </button>`).join('')}</div></div>` : ''}
  </div>`);
}

// --- Wiring ---
async function mgLoadGenres() {
  mg.genre.innerHTML = '<option value="All">Any</option>';
  try {
    const res = await fetch('/api/manga/genres');
    const json = await res.json();
    if (json.status !== 'ok') return;
    for (const g of json.data.genres) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      mg.genre.append(opt);
    }
  } catch { /* the Any option still works */ }
}

function bindManga(panel) {
  mg.search.addEventListener('input', mgSearchNow);
  mg.search.addEventListener('keydown', (e) => { if (e.key === 'Enter') mgLoad(1); });

  for (const el of [mg.sort, mg.genre, mg.format, mg.country, mg.status, mg.score, mg.adult]) {
    el.addEventListener('change', () => mgLoad(1));
  }

  mg.listBtn.addEventListener('click', () => {
    if (mgShowingList) mgLoad(1);
    else mgShowList();
  });

  mg.more.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]') && mgHasNext) mgLoad(mgPage + 1);
  });

  mg.grid.addEventListener('click', (e) => {
    const save = e.target.closest('[data-save]');
    if (save) {
      const item = mgItems.find((x) => String(x.id) === save.dataset.save);
      if (!item) return;
      const nowOn = mgToggleList({
        id: item.id, title: item.title, poster: item.poster,
        kind: item.kind, year: item.year, chapters: item.chapters,
        volumes: item.volumes, status: item.status, rating: item.rating,
        isAdult: item.isAdult,
      });
      save.classList.toggle('on', nowOn);
      save.textContent = nowOn ? '★' : '☆';
      save.title = nowOn ? 'On your reading list' : 'Add to reading list';
      // Un-starring while viewing the list should take the card away.
      if (mgShowingList && !nowOn) mgShowList();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) mgOpen(open.dataset.open);
  });

  // Related titles and the save button live inside the modal.
  document.addEventListener('click', (e) => {
    const rel = e.target.closest('#modal-body [data-open]');
    if (rel) { mgOpen(rel.dataset.open); return; }

    const save = e.target.closest('#modal-body [data-save-detail]');
    if (!save) return;
    const id = save.dataset.saveDetail;
    const known = mgItems.find((x) => String(x.id) === String(id));
    const nowOn = mgToggleList(known || { id, title: save.dataset.title || `#${id}` });
    save.classList.toggle('on', nowOn);
    save.textContent = nowOn ? '★ On your list' : '☆ Add to reading list';
  });
}

export const tool = {
  id: 'manga',
  name: 'Manga',
  icon: '📖',
  blurb: 'Search manga, manhwa, manhua and light novels from AniList.',
  mount(panel) {
    panel.innerHTML = TEMPLATE;
    cacheEls();
    bindManga(panel);
    mgLoadGenres();
    mgLoad(1);
  },
  show() {
    mg.search?.focus();
  },
};
