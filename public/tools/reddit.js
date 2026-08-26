// Reddit — your own account.
//
// The server holds the OAuth token and does the paging; this side keeps the
// whole listing in memory so filtering, sorting and bulk selection are instant.

import { $, esc, debounce, fmtNumber, optionHtml } from '../lib/dom.js';

const TEMPLATE = `
  <div class="tool-head">
    <h1 class="tool-title"><span class="tool-title-icon">👽</span> Reddit</h1>
    <p class="tool-sub">Your saved posts, submissions and votes — sorted, filtered, and cleared out.</p>
  </div>

  <div id="rd-setup" class="rd-setup" hidden></div>

  <div id="rd-main" hidden>
    <div class="rd-head">
      <div class="rd-account">
        <span id="rd-user" class="rd-user"></span>
        <button id="rd-refresh" class="btn-ghost" type="button" title="Re-fetch from Reddit">↻ Refresh</button>
        <button id="rd-logout" class="btn-ghost" type="button" title="Disconnect this account">Disconnect</button>
      </div>
      <nav id="rd-kinds" class="rd-kinds" role="tablist" aria-label="Reddit history"></nav>
    </div>

    <div class="rd-tools">
      <input id="rd-search" type="search" placeholder="Filter by title, subreddit, text…" autocomplete="off" spellcheck="false" />
      <select id="rd-sub" title="Subreddit"></select>
      <select id="rd-type" title="Type"></select>
      <select id="rd-sort" title="Sort"></select>
      <button id="rd-select" class="pill" type="button" title="Select every item currently shown">☑ Select all</button>
    </div>

    <div id="rd-notice" class="dl-notice" hidden></div>

    <div class="rd-bar">
      <span id="rd-info" class="rd-info"></span>
      <span id="rd-bulk" class="rd-bulk" hidden></span>
    </div>

    <div id="rd-list" class="rd-list"></div>
  </div>`;

// --- Reddit tab (your own account) ------------------------------------------
// The server holds the OAuth token and does the paging; this side keeps the
// whole listing in memory so filtering, sorting and bulk selection are instant.

const rd = {};
function cacheEls() {
  Object.assign(rd, {
  panel: $('reddit'),
  setup: $('rd-setup'),
  main: $('rd-main'),
  user: $('rd-user'),
  refresh: $('rd-refresh'),
  logout: $('rd-logout'),
  kinds: $('rd-kinds'),
  search: $('rd-search'),
  sub: $('rd-sub'),
  type: $('rd-type'),
  sort: $('rd-sort'),
  select: $('rd-select'),
  notice: $('rd-notice'),
  info: $('rd-info'),
  bulk: $('rd-bulk'),
  list: $('rd-list'),
});
}

const RD_KINDS = [
  ['saved', '🔖 Saved'],
  ['submitted', '📝 My posts'],
  ['comments', '💬 My comments'],
  ['upvoted', '⬆ Upvoted'],
  ['downvoted', '⬇ Downvoted'],
  ['hidden', '🙈 Hidden'],
];

const RD_SORTS = [
  ['new', 'Newest first'],
  ['old', 'Oldest first'],
  ['top', 'Highest score'],
  ['low', 'Lowest score'],
  ['comments', 'Most comments'],
  ['sub', 'Subreddit A–Z'],
  ['title', 'Title A–Z'],
];

const RD_TYPES = [['all', 'Posts & comments'], ['post', 'Posts only'], ['comment', 'Comments only']];

const rdState = {
  status: null,      // /api/reddit/status
  kind: 'saved',
  sort: 'new',
  sub: 'all',
  type: 'all',
  query: '',
  items: [],
  truncated: false,
  loading: false,
};

const rdSelected = new Set();
let rdOpened = false;
let rdUndo = null;   // { ids, label } — lets an accidental bulk unsave be put back

// --- Small helpers ---

function rdAgo(sec) {
  if (!sec) return '';
  const d = Math.max(0, Date.now() / 1000 - sec);
  const units = [[31557600, 'y'], [2629800, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [size, label] of units) {
    if (d >= size) return `${Math.floor(d / size)}${label} ago`;
  }
  return 'just now';
}

function rdNotice(html, kind = '') {
  rd.notice.hidden = !html;
  rd.notice.className = `dl-notice${kind ? ' ' + kind : ''}`;
  rd.notice.innerHTML = html || '';
}

async function rdJson(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Unexpected response (HTTP ${res.status})`);
  if (json.status !== 'ok') {
    throw Object.assign(new Error(json.status_message || `HTTP ${res.status}`), { code: json.code });
  }
  return json.data;
}

// --- Setup / connection gate ---

function rdSetupHtml(s) {
  if (!s.configured) {
    return `
      <div class="rd-card">
        <h2>Connect your Reddit account</h2>
        <p>This uses Reddit's own API, so it needs a (free) app registered on your
        account. It takes about a minute, once.</p>
        <ol class="rd-steps">
          <li>Open <a href="https://www.reddit.com/prefs/apps" target="_blank" rel="noopener">reddit.com/prefs/apps</a>
              and click <strong>create another app…</strong></li>
          <li>Give it any name, choose <strong>installed app</strong>.</li>
          <li>Paste this exactly into <strong>redirect uri</strong>:
              <code class="rd-copy" data-rd-copy="${esc(s.redirectUri)}" title="Click to copy">${esc(s.redirectUri)}</code></li>
          <li>Create it, then copy the ID shown under the app name (just below
              “installed app”) into the box below.</li>
        </ol>
        <form id="rd-config-form" class="rd-form">
          <label class="rd-field">
            <span>Client ID</span>
            <input id="rd-client-id" type="text" autocomplete="off" spellcheck="false"
              placeholder="e.g. Xy3k_9dQ2LmNoPq" value="${esc(s.clientId || '')}" />
          </label>
          <label class="rd-field">
            <span>Client secret <em>(only for a “web app”; leave blank for installed)</em></span>
            <input id="rd-client-secret" type="password" autocomplete="off" spellcheck="false" placeholder="—" />
          </label>
          <button class="btn btn-primary" type="submit">Save &amp; continue</button>
        </form>
        <p class="rd-fine">Stored locally in <code>.reddit.json</code>, never sent anywhere but Reddit.</p>
      </div>`;
  }
  return `
    <div class="rd-card">
      <h2>Sign in to Reddit</h2>
      <p>Your app is set up. Reddit will ask you to approve access to:
      identity, history, save, edit, vote and read — enough to list your saved
      items and clear them out again.</p>
      <p><a class="btn btn-primary" href="/api/reddit/login">Connect Reddit account</a></p>
      <p class="rd-fine">Wrong app? <button class="link-btn" type="button" data-rd-reconfigure>Change the client ID</button></p>
    </div>`;
}

function rdRenderGate() {
  const s = rdState.status;
  const connected = !!(s && s.connected);
  rd.setup.hidden = connected;
  rd.main.hidden = !connected;
  if (!connected) {
    rd.setup.innerHTML = rdSetupHtml(s || { configured: false, redirectUri: '' });
  } else {
    rd.user.textContent = `u/${s.username}`;
  }
}

// --- Loading a listing ---

function rdBuildControls() {
  rd.kinds.innerHTML = RD_KINDS
    .map(([k, label]) => `<button class="rd-kind${k === rdState.kind ? ' active' : ''}" type="button" data-rd-kind="${k}">${label}</button>`)
    .join('');
  rd.sort.innerHTML = RD_SORTS.map(([v, l]) => optionHtml(v, l, v === rdState.sort)).join('');
  rd.type.innerHTML = RD_TYPES.map(([v, l]) => optionHtml(v, l, v === rdState.type)).join('');
}

async function rdLoad(refresh = false) {
  if (rdState.loading) return;
  rdState.loading = true;
  rdSelected.clear();
  rd.list.innerHTML = '';
  rd.info.textContent = refresh ? 'Fetching from Reddit…' : 'Loading…';
  rdNotice('');
  try {
    const data = await rdJson(`/api/reddit/listing?kind=${rdState.kind}${refresh ? '&refresh=1' : ''}`);
    rdState.items = data.items || [];
    rdState.truncated = !!data.truncated;
    rdRebuildSubFilter();
    rdRender();
  } catch (err) {
    if (err.code === 'disconnected' || err.code === 'unconfigured') {
      await rdRefreshStatus();
      return;
    }
    rd.info.textContent = '';
    rdNotice(`Could not load your ${rdState.kind} list.<br><small>${esc(err.message)}</small>`, 'error');
  } finally {
    rdState.loading = false;
  }
}

function rdRebuildSubFilter() {
  const counts = new Map();
  rdState.items.forEach((it) => counts.set(it.subreddit, (counts.get(it.subreddit) || 0) + 1));
  const subs = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!counts.has(rdState.sub)) rdState.sub = 'all';
  rd.sub.innerHTML = [optionHtml('all', `All subreddits (${subs.length})`, rdState.sub === 'all')]
    .concat(subs.map(([s, n]) => optionHtml(s, `r/${s} · ${n}`, s === rdState.sub)))
    .join('');
}

// --- Filter + sort (all local) ---

function rdFiltered() {
  const q = rdState.query.trim().toLowerCase();
  let items = rdState.items.filter((it) => {
    if (rdState.type !== 'all' && it.type !== rdState.type) return false;
    if (rdState.sub !== 'all' && it.subreddit !== rdState.sub) return false;
    if (!q) return true;
    return (
      it.title.toLowerCase().includes(q) ||
      it.subreddit.toLowerCase().includes(q) ||
      it.author.toLowerCase().includes(q) ||
      (it.body || '').toLowerCase().includes(q) ||
      (it.domain || '').toLowerCase().includes(q)
    );
  });
  const by = {
    new: (a, b) => b.created - a.created,
    old: (a, b) => a.created - b.created,
    top: (a, b) => (b.score ?? -1) - (a.score ?? -1),
    low: (a, b) => (a.score ?? Infinity) - (b.score ?? Infinity),
    comments: (a, b) => (b.comments ?? -1) - (a.comments ?? -1),
    sub: (a, b) => a.subreddit.localeCompare(b.subreddit) || b.created - a.created,
    title: (a, b) => a.title.localeCompare(b.title),
  }[rdState.sort];
  items = items.slice().sort(by);
  return items;
}

// --- Render ---

function rdRowHtml(it) {
  const checked = rdSelected.has(it.name) ? ' checked' : '';
  const thumb = it.thumb
    ? `<img class="rd-thumb" src="${esc(it.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<span class="rd-thumb rd-thumb-blank">${it.type === 'comment' ? '💬' : it.self ? '📄' : '🔗'}</span>`;
  const meta = [
    `r/${esc(it.subreddit)}`,
    it.type === 'comment' ? `comment on u/${esc(it.author)}’s post` : `u/${esc(it.author)}`,
    rdAgo(it.created),
    it.score != null ? `${fmtNumber(it.score)} pts` : '',
    it.comments != null ? `${fmtNumber(it.comments)} comments` : '',
    it.type === 'post' && !it.self && it.domain ? esc(it.domain) : '',
  ].filter(Boolean).join(' · ');
  const body = it.body
    ? `<div class="rd-body">${esc(it.body.slice(0, 240))}${it.body.length > 240 ? '…' : ''}</div>`
    : '';
  const actions = [
    rdState.kind === 'saved' ? `<button class="rd-act" type="button" data-rd-one="unsave" data-rd-id="${it.name}">Unsave</button>` : '',
    rdState.kind === 'hidden' ? `<button class="rd-act" type="button" data-rd-one="unhide" data-rd-id="${it.name}">Unhide</button>` : '',
    (rdState.kind === 'upvoted' || rdState.kind === 'downvoted')
      ? `<button class="rd-act" type="button" data-rd-one="unvote" data-rd-id="${it.name}">Clear vote</button>` : '',
    it.mine ? `<button class="rd-act danger" type="button" data-rd-one="del" data-rd-id="${it.name}">Delete</button>` : '',
  ].filter(Boolean).join('');

  return `
    <div class="rd-row${checked ? ' selected' : ''}" data-rd-row="${it.name}">
      <label class="rd-pick"><input type="checkbox" data-rd-check="${it.name}"${checked} /></label>
      ${thumb}
      <div class="rd-row-main">
        <a class="rd-title" href="${esc(it.permalink || it.url || '#')}" target="_blank" rel="noopener">${esc(it.title)}</a>
        ${it.flair ? `<span class="rd-flair">${esc(it.flair)}</span>` : ''}
        ${it.nsfw ? '<span class="rd-flair nsfw">NSFW</span>' : ''}
        <div class="rd-meta">${meta}</div>
        ${body}
      </div>
      <div class="rd-actions">
        ${it.type === 'post' && !it.self && it.url && it.url !== it.permalink
          ? `<a class="rd-act" href="${esc(it.url)}" target="_blank" rel="noopener">Link ↗</a>` : ''}
        ${actions}
      </div>
    </div>`;
}

function rdRender() {
  const items = rdFiltered();
  const total = rdState.items.length;
  const kindLabel = (RD_KINDS.find(([k]) => k === rdState.kind) || [null, rdState.kind])[1];

  rd.info.textContent = total === 0
    ? `Nothing in ${kindLabel.replace(/^\S+\s/, '').toLowerCase()}.`
    : items.length === total
      ? `${fmtNumber(total)} items${rdState.truncated ? ' (Reddit caps history around 1000)' : ''}`
      : `${fmtNumber(items.length)} of ${fmtNumber(total)} items`;

  rd.list.innerHTML = items.length
    ? items.map(rdRowHtml).join('')
    : `<div class="status">${total ? 'No items match those filters.' : 'Nothing here yet.'}</div>`;

  // Selecting only ever applies to what's on screen, so drop anything filtered out.
  const visible = new Set(items.map((it) => it.name));
  [...rdSelected].forEach((n) => { if (!visible.has(n)) rdSelected.delete(n); });
  rdRenderBulk(items);
}

function rdRenderBulk(items) {
  const n = rdSelected.size;
  rd.select.textContent = n && n === items.length ? '☐ Clear selection' : '☑ Select all';
  if (!n) { rd.bulk.hidden = true; rd.bulk.innerHTML = ''; return; }
  const picked = rdState.items.filter((it) => rdSelected.has(it.name));
  const allMine = picked.every((it) => it.mine);
  const buttons = [
    rdState.kind === 'saved' ? '<button class="btn btn-primary" type="button" data-rd-bulk="unsave">Unsave</button>' : '',
    rdState.kind === 'hidden' ? '<button class="btn" type="button" data-rd-bulk="unhide">Unhide</button>' : '',
    (rdState.kind === 'upvoted' || rdState.kind === 'downvoted')
      ? '<button class="btn" type="button" data-rd-bulk="unvote">Clear votes</button>' : '',
    allMine ? '<button class="btn danger" type="button" data-rd-bulk="del">Delete</button>' : '',
  ].filter(Boolean).join('');
  rd.bulk.hidden = false;
  rd.bulk.innerHTML = `<strong>${n} selected</strong>${buttons}`;
}

// --- Acting on items ---

const RD_ACTION_COPY = {
  unsave: { verb: 'Unsave', past: 'unsaved', confirm: (n) => `Unsave ${n} item${n > 1 ? 's' : ''}? They stay on Reddit — this only removes them from your saved list.` },
  unhide: { verb: 'Unhide', past: 'unhidden', confirm: (n) => `Unhide ${n} item${n > 1 ? 's' : ''}?` },
  unvote: { verb: 'Clear vote', past: 'cleared', confirm: (n) => `Remove your vote from ${n} item${n > 1 ? 's' : ''}?` },
  del: { verb: 'Delete', past: 'deleted', confirm: (n) => `Permanently delete ${n} of your own post${n > 1 ? 's' : ''}/comment${n > 1 ? 's' : ''} from Reddit? This cannot be undone.` },
  save: { verb: 'Re-save', past: 're-saved', confirm: null },
};

async function rdAct(action, ids, { skipConfirm = false } = {}) {
  if (!ids.length) return;
  const copy = RD_ACTION_COPY[action];
  if (!skipConfirm && copy.confirm && !confirm(copy.confirm(ids.length))) return;

  rdNotice(`${copy.verb}… (${ids.length})`);
  try {
    const data = await rdJson(`/api/reddit/action?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const done = new Set(data.done);
    // Drop what actually went through, so the list matches Reddit without a refetch.
    rdState.items = rdState.items.filter((it) => !done.has(it.name));
    done.forEach((id) => rdSelected.delete(id));
    rdUndo = action === 'unsave' && done.size ? { ids: [...done], label: 'unsaved' } : null;

    const failed = data.failed.length;
    rdNotice(
      `${done.size} ${copy.past}.` +
      (rdUndo ? ' <button class="link-btn" type="button" data-rd-undo>Undo</button>' : '') +
      (failed ? `<br><small>${failed} failed — ${esc(data.failed[0].error)}</small>` : ''),
      failed ? 'warn' : ''
    );
    rdRebuildSubFilter();
    rdRender();
  } catch (err) {
    rdNotice(`${copy.verb} failed.<br><small>${esc(err.message)}</small>`, 'error');
  }
}

async function rdUndoLast() {
  if (!rdUndo) return;
  const ids = rdUndo.ids;
  rdUndo = null;
  await rdAct('save', ids, { skipConfirm: true });
  await rdLoad(true); // re-saved items come back at the top of the saved list
  rdNotice(`Put ${ids.length} item${ids.length > 1 ? 's' : ''} back in your saved list.`);
}

// --- Preferences (which listing, which sort) ---

const RD_PREFS_KEY = 'media-library:reddit-prefs';

function rdSavePrefs() {
  try {
    localStorage.setItem(RD_PREFS_KEY, JSON.stringify({ kind: rdState.kind, sort: rdState.sort }));
  } catch { /* ignore quota */ }
}

function rdLoadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(RD_PREFS_KEY));
    if (saved && RD_KINDS.some(([k]) => k === saved.kind)) rdState.kind = saved.kind;
    if (saved && RD_SORTS.some(([v]) => v === saved.sort)) rdState.sort = saved.sort;
  } catch { /* defaults are fine */ }
}

// --- Status + wiring ---

async function rdRefreshStatus() {
  try {
    rdState.status = await rdJson('/api/reddit/status');
  } catch {
    rdState.status = { configured: false, connected: false, redirectUri: `${location.origin}/api/reddit/callback` };
  }
  rdRenderGate();
  if (rdState.status.connected && !rdState.items.length) rdLoad();
}

function bindReddit() {
  rd.setup.addEventListener('click', async (e) => {
    const copyEl = e.target.closest('[data-rd-copy]');
    if (copyEl) {
      navigator.clipboard?.writeText(copyEl.dataset.rdCopy);
      copyEl.classList.add('copied');
      setTimeout(() => copyEl.classList.remove('copied'), 1200);
      return;
    }
    if (e.target.closest('[data-rd-reconfigure]')) {
      rdState.status = { ...rdState.status, configured: false };
      rd.setup.innerHTML = rdSetupHtml(rdState.status);
    }
  });

  rd.setup.addEventListener('submit', async (e) => {
    if (e.target.id !== 'rd-config-form') return;
    e.preventDefault();
    const clientId = $('rd-client-id').value.trim();
    const clientSecret = $('rd-client-secret').value.trim();
    try {
      rdState.status = await rdJson('/api/reddit/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      rdRenderGate();
    } catch (err) {
      rd.setup.insertAdjacentHTML('beforeend', `<div class="dl-notice error">${esc(err.message)}</div>`);
    }
  });

  rd.kinds.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rd-kind]');
    if (!btn || btn.dataset.rdKind === rdState.kind) return;
    rdState.kind = btn.dataset.rdKind;
    rdState.sub = 'all';
    rdState.items = [];
    rdBuildControls();
    rdSavePrefs();
    rdLoad();
  });

  rd.search.addEventListener('input', debounce(() => {
    rdState.query = rd.search.value;
    rdRender();
  }, 200));

  rd.sub.addEventListener('change', () => { rdState.sub = rd.sub.value; rdRender(); });
  rd.type.addEventListener('change', () => { rdState.type = rd.type.value; rdRender(); });
  rd.sort.addEventListener('change', () => { rdState.sort = rd.sort.value; rdSavePrefs(); rdRender(); });

  rd.select.addEventListener('click', () => {
    const items = rdFiltered();
    if (rdSelected.size === items.length) rdSelected.clear();
    else items.forEach((it) => rdSelected.add(it.name));
    rdRender();
  });

  rd.refresh.addEventListener('click', () => rdLoad(true));

  rd.logout.addEventListener('click', async () => {
    if (!confirm('Disconnect this Reddit account? Nothing on Reddit changes.')) return;
    try {
      rdState.status = await rdJson('/api/reddit/logout', { method: 'POST' });
      rdState.items = [];
      rdSelected.clear();
      rdRenderGate();
    } catch (err) {
      rdNotice(esc(err.message), 'error');
    }
  });

  rd.list.addEventListener('change', (e) => {
    const box = e.target.closest('[data-rd-check]');
    if (!box) return;
    const id = box.dataset.rdCheck;
    if (box.checked) rdSelected.add(id); else rdSelected.delete(id);
    box.closest('.rd-row')?.classList.toggle('selected', box.checked);
    rdRenderBulk(rdFiltered());
  });

  rd.list.addEventListener('click', (e) => {
    const one = e.target.closest('[data-rd-one]');
    if (one) rdAct(one.dataset.rdOne, [one.dataset.rdId]);
  });

  rd.bulk.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rd-bulk]');
    if (btn) rdAct(btn.dataset.rdBulk, [...rdSelected]);
  });

  rd.notice.addEventListener('click', (e) => {
    if (e.target.closest('[data-rd-undo]')) rdUndoLast();
  });
}
export const tool = {
  id: 'reddit',
  name: 'Reddit',
  icon: '👽',
  blurb: 'Sort and clear out your saved posts, comments and votes.',
  mount(panel) {
    panel.innerHTML = TEMPLATE;
    cacheEls();
    rdLoadPrefs();
    rdBuildControls();
    bindReddit();
    rdRefreshStatus();
  },
};
