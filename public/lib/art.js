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

    if (e.target.closest('[data-ar-extra-clear]')) return arSetExtra('');

    const by = e.target.closest('[data-ar-by]');
    if (by) {
      // Close the viewer first: the grid behind it is about to be replaced.
      arCloseViewer();
      return arSetExtra(by.dataset.arBy);
    }

    if (e.target.closest('[data-ar-viewer-close]')) return arCloseViewer();

    const step = e.target.closest('[data-ar-step]');
    if (step) return arStep(Number(step.dataset.arStep));

    const view = e.target.closest('[data-ar-view]');
    if (view) return arOpenViewer(Number(view.dataset.arView));

    // Clicking the backdrop closes the viewer without closing the sheet. The
    // exclusion is the image itself, not its container: .ar-stage is a centred
    // flex box filling the whole middle of the screen, so nearly all the black
    // around a portrait-shaped picture belongs to it and excluding it meant
    // there was almost nowhere left to click.
    const viewer = e.target.closest('[data-ar-viewer]');
    if (viewer && !e.target.closest('.ar-full, .ar-viewer-bar, .ar-nav')) return arCloseViewer();

    const only = e.target.closest('[data-ar-only]');
    if (only) return arSoloRating(only.dataset.arOnly);

    const rating = e.target.closest('[data-ar-rating]');
    if (rating) return arToggleRating(rating.dataset.arRating);

    const pick = e.target.closest('[data-ar-tag]');
    if (pick) return arRun(pick.dataset.arTag, { fresh: true });

    if (e.target.closest('[data-ar-more]')) return arMore();
  });

  // Double-click a rating to use only that one. It works because the fetch is
  // debounced: the two single clicks and the dblclick all land inside the
  // window, so the intermediate states never reach the network.
  arRoot.addEventListener('keydown', (e) => {
    const input = e.target.closest('[data-ar-extra]');
    if (!input) return;
    // The overlay's own Escape handler would close the sheet; here it should
    // only give up on the box.
    if (e.key === 'Escape') { e.stopPropagation(); input.blur(); return; }
    if (e.key === 'Enter') { e.preventDefault(); arSetExtra(input.value); }
  });

  arRoot.addEventListener('dblclick', (e) => {
    const rating = e.target.closest('[data-ar-rating]');
    if (!rating) return;
    e.preventDefault();
    arSoloRating(rating.dataset.arRating);
  });

  return arRoot;
}

// Escape closes the art overlay before the detail modal underneath sees it.
document.addEventListener('keydown', (e) => {
  if (!arRoot || arRoot.hidden || document.fullscreenElement) return;
  // Typing in the filter box: arrows move the caret and Escape clears the box,
  // neither of which should reach the sheet.
  if (e.target && e.target.closest && e.target.closest('[data-ar-extra]')) return;
  const inViewer = arState && arState.viewing >= 0;

  if (e.key === 'Escape') {
    e.stopImmediatePropagation();
    // Escape backs out one layer at a time: viewer, then sheet, then the
    // detail modal underneath gets its turn on the next press.
    return inViewer ? arCloseViewer() : arClose();
  }

  if (!inViewer) return;
  if (e.key === 'ArrowLeft') { e.stopImmediatePropagation(); arStep(-1); }
  if (e.key === 'ArrowRight') { e.stopImmediatePropagation(); arStep(1); }
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
    <span class="ar-chip-wrap">
      <button class="ar-chip${on.has(r.value) ? ' on' : ''}" type="button"
        data-ar-rating="${esc(r.value)}" aria-pressed="${on.has(r.value)}"
        title="${esc(r.means || r.label)}&#10;Click to toggle · double-click for only this"
        >${esc(r.label)}</button>
      <button class="ar-only" type="button" data-ar-only="${esc(r.value)}"
        title="Show only ${esc(r.label)}" aria-label="Show only ${esc(r.label)}">only</button>
    </span>`).join('')}</div>`;
}

// Repaint the chips without replacing them.
//
// The previous version re-rendered the whole row with outerHTML on every
// toggle, which destroyed the button between the two halves of a double-click.
// A dblclick only fires when both clicks land on the same element, so the
// gesture never fired at all — the row just flickered off and on, which is
// exactly what it looked like.
function arSyncChips() {
  if (!arRoot || !arState) return;
  const on = new Set(arState.ratings || []);
  for (const btn of arRoot.querySelectorAll('[data-ar-rating]')) {
    const isOn = on.has(btn.dataset.arRating);
    btn.classList.toggle('on', isOn);
    btn.setAttribute('aria-pressed', String(isOn));
  }
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
          <button class="ar-btn${sort === 'score' ? ' on' : ''}"
            type="button" data-ar-sort="score" title="Highest scoring first">Top</button>
          <button class="ar-btn${sort === 'new' ? ' on' : ''}" type="button" data-ar-sort="new">Newest</button>
        </div>
        <button class="ar-close" type="button" data-ar-close aria-label="Close">✕</button>
      </header>
      ${arFilterBarHtml()}
      <div class="ar-body">${body}</div>
    </div>`;
}

// One extra tag, because Danbooru allows an anonymous search two and the
// character has already spent one. Artists are ordinary tags over there, so
// the same field covers "only anal" and "only by this artist".
function arFilterBarHtml() {
  const s = arState || {};
  return `
    <div class="ar-filterbar">
      <input class="ar-extra-input" type="search" data-ar-extra
        placeholder="Also tagged… (a theme, or an artist)"
        value="${esc(s.extra || '')}" autocomplete="off" spellcheck="false"
        aria-label="Narrow by one more tag" />
      ${s.extra ? `<button class="ar-chip on" type="button" data-ar-extra-clear
        title="Remove this filter">${esc(s.extra)} ✕</button>` : ''}
    </div>`;
}

function arRender(body) {
  arEnsureRoot().innerHTML = arShell(body);
  arRoot.hidden = false;
}

// Marks the sheet busy without replacing what is on it. Re-rendering into a
// "Loading…" string collapsed the sheet to the height of one line and threw
// away the grid, which made every filter click a jarring full reset.
function arSetBusy(on) {
  const sheet = arRoot && arRoot.querySelector('.ar-sheet');
  if (sheet) sheet.classList.toggle('busy', !!on);
}

function arNote(text, kind) {
  return `<p class="ar-note${kind ? ` ${kind}` : ''}">${esc(text)}</p>`;
}

function arCardHtml(p, i) {
  const dims = p.width && p.height ? `${p.width}×${p.height}` : '';
  return `
    <button class="ar-card" type="button" data-ar-view="${i}"
       title="${esc(p.artist ? `by ${p.artist}` : 'Open')}">
      <img src="${esc(p.preview)}" alt="" loading="lazy" />
      <span class="ar-card-meta">
        ${p.artist ? `<span class="ar-artist">${esc(p.artist)}</span>` : ''}
        <span class="ar-dims">${esc(dims)}</span>
      </span>
    </button>`;
}

const DANBOORU_POSTS = 'https://danbooru.donmai.us/posts';

const arBytes = (n) => {
  if (!n) return '';
  const mb = n / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
};

// The viewer. Shows the sample immediately and swaps in the original once it
// has decoded, so there is a picture on screen straight away rather than a
// blank frame while a 12 MB png arrives. Some posts have no original at all,
// in which case the sample is the best there is and it says so.
function arViewerHtml() {
  const s = arState;
  const p = s.posts[s.viewing];
  if (!p) return '';
  const dims = p.width && p.height ? `${p.width} × ${p.height}` : '';
  const size = arBytes(p.bytes);

  return `
    <div class="ar-viewer" data-ar-viewer>
      <div class="ar-viewer-bar">
        <span class="ar-viewer-pos">${s.viewing + 1} / ${s.posts.length}</span>
        ${p.artist ? `
          <button class="ar-viewer-artist" type="button" data-ar-by="${esc(p.artist)}"
            title="Show only this artist">${esc(p.artist)}</button>
          <a class="ar-viewer-out" href="${esc(DANBOORU_POSTS)}?tags=${
            encodeURIComponent(`${p.artist} ${arState.tag}`)}"
            target="_blank" rel="noopener noreferrer"
            title="This artist on Danbooru">↗</a>` : ''}
        <span class="ar-viewer-dims">${esc(dims)}${size ? ` · ${size}` : ''}</span>
        <span class="ar-viewer-quality" data-ar-quality>${p.full ? 'loading original…' : 'sample only'}</span>
        <a class="ar-btn" href="${esc(p.post)}" target="_blank" rel="noopener noreferrer">Danbooru</a>
        <button class="ar-close" type="button" data-ar-viewer-close aria-label="Close">✕</button>
      </div>
      <button class="ar-nav prev" type="button" data-ar-step="-1" aria-label="Previous">‹</button>
      <div class="ar-stage">
        <img class="ar-full" data-ar-full src="${esc(p.large || p.preview)}" alt="" />
      </div>
      <button class="ar-nav next" type="button" data-ar-step="1" aria-label="Next">›</button>
    </div>`;
}

// Swapping only after the original has decoded avoids the flash of a
// half-painted image replacing a complete one.
function arUpgradeImage() {
  const s = arState;
  const p = s && s.posts[s.viewing];
  const el = arRoot && arRoot.querySelector('[data-ar-full]');
  const badge = arRoot && arRoot.querySelector('[data-ar-quality]');
  if (!p || !el || !p.full) return;

  const token = s.viewing;
  const hi = new Image();
  hi.onload = () => {
    if (!arState || arState.viewing !== token) return;
    const live = arRoot.querySelector('[data-ar-full]');
    if (live) live.src = p.full;
    const b = arRoot.querySelector('[data-ar-quality]');
    if (b) b.textContent = 'original';
  };
  hi.onerror = () => {
    if (!arState || arState.viewing !== token) return;
    const b = arRoot.querySelector('[data-ar-quality]');
    if (b) b.textContent = 'sample';
  };
  hi.src = p.full;
  if (badge) badge.textContent = 'loading original…';
}

function arOpenViewer(index) {
  const s = arState;
  if (!s || !s.posts[index]) return;
  s.viewing = index;
  const existing = arRoot.querySelector('[data-ar-viewer]');
  if (existing) existing.outerHTML = arViewerHtml();
  else arRoot.insertAdjacentHTML('beforeend', arViewerHtml());
  arUpgradeImage();
}

function arCloseViewer() {
  const el = arRoot && arRoot.querySelector('[data-ar-viewer]');
  if (el) el.remove();
  if (arState) arState.viewing = -1;
}

function arStep(delta) {
  const s = arState;
  if (!s || s.viewing < 0) return;
  const next = s.viewing + delta;
  if (next < 0 || next >= s.posts.length) return;
  arOpenViewer(next);
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
    ${arNote(`${arRatingNames()} artwork, filtered on the server.${
      s.sortExact === false ? ' Ranked within the 200 most recent matches.' : ''}`, 'soft')}`;
}

async function arFetch(page) {
  const s = arState;
  const q = new URLSearchParams({ tag: s.tag, page: String(page), sort: s.sort });
  if (s.ratings && s.ratings.length) q.set('ratings', s.ratings.join(','));
  if (s.extra) q.set('extra', s.extra);

  const res = await fetch(`/api/art/search?${q}`);
  const json = await res.json();
  if (json.status !== 'ok') throw new Error(json.status_message || 'Could not load artwork.');

  // The server decides what is permitted and what is on; the client follows,
  // so an out-of-range selection corrects itself rather than sticking.
  s.allowed = json.data.allowed;
  s.ratings = json.data.ratings;
  s.sort = json.data.sort;
  s.sortExact = json.data.sortExact !== false;
  return json.data;
}

// Keeps whatever is already on screen until the replacement is ready, so the
// grid does not blink out and the sheet does not resize under the pointer.
// Only a first load, which has nothing to keep, renders the waiting state.
async function arRun(tag, opts = {}) {
  const s = arState;
  const hadContent = s.posts.length > 0 && !opts.fresh;
  s.tag = tag;
  s.page = 1;
  s.hasNext = false;

  if (hadContent) {
    arSetBusy(true);
  } else {
    s.posts = [];
    arRender('<div class="ar-wait">Loading artwork…</div>');
  }

  const token = ++s.seq;
  try {
    const d = await arFetch(1);
    if (token !== s.seq) return;
    s.posts = d.posts;
    s.hasNext = d.hasNext;
    s.viewing = -1;
    arRender(arGridHtml());
  } catch (err) {
    if (token !== s.seq) return;
    arSetBusy(false);
    if (!hadContent) arRender(arNote(err.message, 'error'));
    else arSetError(err.message);
  }
}

// A failure after a successful load leaves the previous grid in place rather
// than trading real results for an error page.
function arSetError(message) {
  const body = arRoot && arRoot.querySelector('.ar-body');
  if (!body) return;
  const old = body.querySelector('.ar-inline-error');
  if (old) old.remove();
  body.insertAdjacentHTML('afterbegin',
    `<p class="ar-note error ar-inline-error">${esc(message)}</p>`);
}

async function arMore() {
  const s = arState;
  if (!s || !s.hasNext) return;
  const token = ++s.seq;
  try {
    const d = await arFetch(s.page + 1);
    if (token !== s.seq) return;
    s.page += 1;
    s.hasNext = d.hasNext;

    const grid = arRoot.querySelector('.ar-grid');
    if (!grid) {
      s.posts = s.posts.concat(d.posts);
      arRender(arGridHtml());
      return;
    }

    // Append rather than re-render, so the page does not jump back to the top.
    // Indices continue from the current length or the viewer would open the
    // wrong picture.
    const start = s.posts.length;
    s.posts = s.posts.concat(d.posts);
    grid.insertAdjacentHTML('beforeend',
      d.posts.map((p, i) => arCardHtml(p, start + i)).join(''));

    if (!s.hasNext) {
      const more = arRoot.querySelector('.ar-more');
      if (more) more.remove();
    }
  } catch { /* the grid already on screen stays valid */ }
}

// Chips repaint immediately; the request waits. Clicking three chips in a row
// then costs one fetch instead of three, and it is what lets double-click mean
// something different from two single clicks.
const AR_FETCH_DELAY = 320;
let arFetchTimer = null;

function arApplyRatings(next) {
  const s = arState;
  // Keep the server's own order so the chips do not shuffle as you click.
  s.ratings = s.allowed.map((r) => r.value).filter((v) => next.has(v));

  arSyncChips();

  clearTimeout(arFetchTimer);
  arSetBusy(true);
  arFetchTimer = setTimeout(() => arRun(s.tag), AR_FETCH_DELAY);
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
  arApplyRatings(on);
}

// Double-click: only this one. Doing it again restores everything permitted,
// so the same gesture goes both ways rather than stranding you on one chip.
function arSoloRating(value) {
  const s = arState;
  if (!s || !s.allowed) return;
  const alone = s.ratings.length === 1 && s.ratings[0] === value;
  arApplyRatings(alone
    ? new Set(s.allowed.map((r) => r.value))
    : new Set([value]));
}

// Danbooru tags have no spaces; typing "blue hair" means blue_hair. Doing the
// substitution here rather than rejecting it saves a pointless error.
function arSetExtra(value) {
  const s = arState;
  if (!s) return;
  const next = String(value || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/:/g, '');
  if (next === s.extra) return;
  s.extra = next;
  arRun(s.tag, { fresh: true });
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
  arState = {
    name, series, tag: null, sort: 'score',
    page: 1, posts: [], hasNext: false, seq: 0,
    viewing: -1, extra: '',
  };
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
