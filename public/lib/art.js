// Character art lookup, shared by the anime and manga detail sheets.
//
// Its own overlay rather than the shared modal, because it is opened from
// inside that modal and nesting one into the other would fight over Escape and
// the scroll lock. This sits above it and hands focus back on close.

import { esc, fmtNumber } from './dom.js';

let arRoot = null;
let arState = null;

function arEnsureRoot() {
  if (arRoot) return arRoot;
  arRoot = document.createElement('div');
  arRoot.className = 'ar-overlay';
  arRoot.hidden = true;
  document.body.appendChild(arRoot);

  arRoot.addEventListener('click', (e) => {
    if (e.target === arRoot || e.target.closest('[data-ar-close]')) return arClose();

    const sortBtn = e.target.closest('[data-ar-sort]');
    if (sortBtn) return arSetSort(sortBtn.dataset.arSort);

    const rating = e.target.closest('[data-ar-rating]');
    if (rating) return arToggleRating(rating.dataset.arRating);

    const pick = e.target.closest('[data-ar-tag]');
    if (pick) return arRun(pick.dataset.arTag);

    if (e.target.closest('[data-ar-more]')) return arMore();
  });

  return arRoot;
}

// Escape closes the art overlay before the detail modal underneath sees it.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && arRoot && !arRoot.hidden && !document.fullscreenElement) {
    e.stopImmediatePropagation();
    arClose();
  }
}, true);

function arClose() {
  if (!arRoot) return;
  arRoot.hidden = true;
  arRoot.innerHTML = '';
  arState = null;
}

// One toggle per rating the server permits. The list comes from the server
// rather than being hardcoded, so narrowing ALLOWED_RATINGS removes the toggle
// too and the UI can never offer something the gate would drop anyway.
function arRatingsHtml() {
  const s = arState;
  if (!s.allowed || !s.allowed.length) return '';
  const on = new Set(s.ratings || []);
  return `<div class="ar-ratings">${s.allowed.map((r) => `
    <button class="ar-chip${on.has(r.value) ? ' on' : ''}" type="button"
      data-ar-rating="${esc(r.value)}" aria-pressed="${on.has(r.value)}"
      title="${esc(r.means || r.label)}">${esc(r.label)}</button>`).join('')}</div>`;
}

function arShell(body) {
  const s = arState || {};
  const sort = s.sort || 'score';
  return `
    <div class="ar-sheet" role="dialog" aria-label="Character artwork">
      <header class="ar-head">
        <div class="ar-titles">
          <h2 class="ar-title">${esc(s.name || 'Artwork')}</h2>
          ${s.tag ? `<span class="ar-tag-name">${esc(s.tag)}</span>` : ''}
        </div>
        ${arRatingsHtml()}
        <div class="ar-sorts">
          <button class="ar-btn${sort === 'score' ? ' on' : ''}" type="button" data-ar-sort="score">Top</button>
          <button class="ar-btn${sort === 'new' ? ' on' : ''}" type="button" data-ar-sort="new">Newest</button>
        </div>
        <button class="ar-close" type="button" data-ar-close aria-label="Close">✕</button>
      </header>
      <div class="ar-body">${body}</div>
    </div>`;
}

function arRender(body) {
  arEnsureRoot().innerHTML = arShell(body);
  arRoot.hidden = false;
}

function arNote(text, kind) {
  return `<p class="ar-note${kind ? ` ${kind}` : ''}">${esc(text)}</p>`;
}

function arCardHtml(p) {
  const dims = p.width && p.height ? `${p.width}×${p.height}` : '';
  return `
    <a class="ar-card" href="${esc(p.post)}" target="_blank" rel="noopener noreferrer"
       title="${esc(p.artist ? `by ${p.artist}` : 'View on Danbooru')}">
      <img src="${esc(p.preview)}" alt="" loading="lazy" />
      <span class="ar-card-meta">
        ${p.artist ? `<span class="ar-artist">${esc(p.artist)}</span>` : ''}
        <span class="ar-dims">${esc(dims)}</span>
      </span>
    </a>`;
}

// Reads back the live selection rather than asserting a fixed rating, which
// is how the footer came to claim "general-rated only" while serving more.
function arRatingNames() {
  const s = arState;
  if (!s.allowed || !s.ratings) return 'Filtered';
  const on = s.allowed.filter((r) => s.ratings.includes(r.value)).map((r) => r.label);
  return on.length ? on.join(' + ') : 'No';
}

function arGridHtml() {
  const s = arState;
  if (!s.posts.length) {
    return arNote(`No ${arRatingNames().toLowerCase()} artwork for this character.`);
  }
  return `
    <div class="ar-grid">${s.posts.map(arCardHtml).join('')}</div>
    ${s.hasNext ? '<div class="ar-more"><button class="ar-btn" type="button" data-ar-more>Load more</button></div>' : ''}
    ${arNote(`${arRatingNames()} artwork, filtered on the server. Opens on Danbooru.`, 'soft')}`;
}

async function arFetch(page) {
  const s = arState;
  const q = new URLSearchParams({ tag: s.tag, page: String(page), sort: s.sort });
  if (s.ratings && s.ratings.length) q.set('ratings', s.ratings.join(','));

  const res = await fetch(`/api/art/search?${q}`);
  const json = await res.json();
  if (json.status !== 'ok') throw new Error(json.status_message || 'Could not load artwork.');

  // The server decides what is permitted and what is on; the client follows,
  // so an out-of-range selection corrects itself rather than sticking.
  s.allowed = json.data.allowed;
  s.ratings = json.data.ratings;
  return json.data;
}

async function arRun(tag) {
  const s = arState;
  s.tag = tag;
  s.page = 1;
  s.posts = [];
  s.hasNext = false;
  arRender('<div class="ar-wait">Loading artwork…</div>');

  const token = ++s.seq;
  try {
    const d = await arFetch(1);
    if (token !== s.seq) return;
    s.posts = d.posts;
    s.hasNext = d.hasNext;
    arRender(arGridHtml());
  } catch (err) {
    if (token !== s.seq) return;
    arRender(arNote(err.message, 'error'));
  }
}

async function arMore() {
  const s = arState;
  if (!s || !s.hasNext) return;
  const token = ++s.seq;
  try {
    const d = await arFetch(s.page + 1);
    if (token !== s.seq) return;
    s.page += 1;
    s.posts = s.posts.concat(d.posts);
    s.hasNext = d.hasNext;
    arRender(arGridHtml());
  } catch { /* the grid already on screen stays valid */ }
}

// Multi-select. Turning the last one off would ask the server for nothing,
// which it answers with the full permitted set — so it is refused here instead
// of silently showing more than was asked for.
function arToggleRating(value) {
  const s = arState;
  if (!s || !s.allowed) return;
  const on = new Set(s.ratings || []);
  if (on.has(value)) {
    if (on.size === 1) return;
    on.delete(value);
  } else {
    on.add(value);
  }
  // Keep the server's own order so the chips do not shuffle as you click.
  s.ratings = s.allowed.map((r) => r.value).filter((v) => on.has(v));
  arRun(s.tag);
}

function arSetSort(sort) {
  if (!arState || arState.sort === sort) return;
  arState.sort = sort;
  arRun(arState.tag);
}

// Self-registering trigger. A tool renders artButton(...) into a character
// card and wires up nothing: both detail sheets rebuild their contents on every
// open, so a delegated listener here beats re-binding in each of them.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ar-open]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  openArt(btn.dataset.arOpen, (btn.dataset.arSeries || '').split('|').filter(Boolean));
});

/** The button that opens the overlay, for a character card in a detail sheet. */
export function artButton(name, series = []) {
  const list = series.filter(Boolean).join('|');
  return `<button class="ar-open" type="button" data-ar-open="${esc(name)}"
    data-ar-series="${esc(list)}" title="Find artwork of ${esc(name)}">Art</button>`;
}

/**
 * Open the artwork overlay for a character.
 * @param {string} name    the character's name as the catalogue has it
 * @param {string[]} series title(s) of the work, English and romaji if both
 */
export async function openArt(name, series = []) {
  arState = { name, series, tag: null, sort: 'score', page: 1, posts: [], hasNext: false, seq: 0 };
  arRender('<div class="ar-wait">Finding this character…</div>');

  const q = new URLSearchParams({ name });
  for (const s of series) if (s) q.append('series', s);

  const token = ++arState.seq;
  let d;
  try {
    const res = await fetch(`/api/art/resolve?${q}`);
    const json = await res.json();
    if (json.status !== 'ok') throw new Error(json.status_message || 'Could not look that up.');
    d = json.data;
  } catch (err) {
    if (token === arState.seq) arRender(arNote(err.message, 'error'));
    return;
  }
  if (token !== arState.seq) return;

  if (!d.best) {
    arRender(arNote(`Danbooru has no character tag matching "${name}".`));
    return;
  }

  await arRun(d.best);

  // More than one plausible tag: offer the alternatives rather than silently
  // insisting the top match was right. Name matching across two naming schemes
  // is a guess, and a wrong guess should be one click to correct.
  if (arState && d.candidates.length > 1) {
    const others = d.candidates.filter((c) => c.tag !== d.best).slice(0, 5);
    const body = arRoot.querySelector('.ar-body');
    if (body && others.length) {
      body.insertAdjacentHTML('beforeend', `
        <details class="ar-alts">
          <summary>Wrong character?</summary>
          <div class="ar-alt-list">${others.map((c) => `
            <button class="ar-btn" type="button" data-ar-tag="${esc(c.tag)}">
              ${esc(c.tag)} <span class="ar-alt-count">${fmtNumber(c.count)}</span>
            </button>`).join('')}</div>
        </details>`);
    }
  }
}
