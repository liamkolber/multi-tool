// Reddit — your own account, through the official OAuth API.
//
// Everything here talks to Reddit as *you*: it reads your saved items,
// submissions, comments and votes, and can unsave/delete them again. Nothing is
// scraped — it's all the documented oauth.reddit.com API.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, PORT, MIME, sendJson, readBody, sameOrigin, stripHtml, escapeHtml } from '../core.mjs';

const __dirname = ROOT;

// --- Reddit (your own account, via the official OAuth API) -------------------
// Everything here talks to Reddit as *you*: it reads your own saved items,
// submissions, comments and votes, and can unsave/delete them again. Nothing is
// scraped — it's all the documented oauth.reddit.com API.
//
// Credentials live in .reddit.json (gitignored). You create the app once at
// https://www.reddit.com/prefs/apps ("installed app", no secret needed) and
// paste the client ID into the Reddit tab.

const REDDIT_CONFIG_PATH = join(__dirname, '.reddit.json');
const REDDIT_UA = 'nodejs:liams-multi-tool:v2.0.0 (local personal client)';
const REDDIT_OAUTH = 'https://oauth.reddit.com';
const REDDIT_WWW = 'https://www.reddit.com';
// identity: who am I · history: saved/submitted/upvoted listings
// save: un/save · edit: delete own posts & comments · vote: unvote · read: fetch content
const REDDIT_SCOPES = 'identity history save edit vote read';

// Reddit matches the redirect URI byte-for-byte against the one registered on
// the app, so it has to be spelled exactly the same way in both places.
const redditRedirectUri = () =>
  process.env.REDDIT_REDIRECT_URI || `http://localhost:${PORT}/api/reddit/callback`;

let redditConfig = null;                 // { clientId, clientSecret, refreshToken, username }
let redditToken = null;                  // { access, expiresAt }
const redditPendingStates = new Map();   // state -> issued-at, for CSRF on the callback
const redditCache = new Map();           // kind -> { at, payload }
const REDDIT_CACHE_TTL_MS = 120_000;

async function loadRedditConfig() {
  if (redditConfig) return redditConfig;
  try {
    redditConfig = JSON.parse(await readFile(REDDIT_CONFIG_PATH, 'utf8'));
  } catch {
    redditConfig = {};
  }
  return redditConfig;
}

async function saveRedditConfig(patch) {
  const cfg = { ...(await loadRedditConfig()), ...patch };
  redditConfig = cfg;
  try {
    await writeFile(REDDIT_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('  reddit: could not write .reddit.json —', err.message);
  }
  return cfg;
}



function redditBasicAuth(cfg) {
  // Installed apps have no secret; Reddit still wants the empty password half.
  return 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret || ''}`).toString('base64');
}

async function redditTokenRequest(cfg, form) {
  const res = await fetch(`${REDDIT_WWW}/api/v1/access_token`, {
    method: 'POST',
    headers: {
      Authorization: redditBasicAuth(cfg),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_UA,
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok || !json || json.error) {
    const why = json && json.error ? String(json.error) : `HTTP ${res.status}`;
    throw new Error(
      why === 'invalid_grant'
        ? 'Reddit rejected the authorisation — it may have expired, or the redirect URI does not match the one registered on your app.'
        : `Reddit token request failed: ${why}`
    );
  }
  return json;
}

// A valid bearer token, refreshing the hour-long one on demand.
async function redditAccessToken() {
  const cfg = await loadRedditConfig();
  if (!cfg.clientId) throw Object.assign(new Error('Reddit app is not set up yet.'), { code: 'unconfigured' });
  if (!cfg.refreshToken) throw Object.assign(new Error('Not connected to Reddit.'), { code: 'disconnected' });
  if (redditToken && Date.now() < redditToken.expiresAt) return redditToken.access;

  const json = await redditTokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: cfg.refreshToken });
  redditToken = {
    access: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 60_000,
  };
  // Reddit occasionally rotates the refresh token; keep whichever it last gave us.
  if (json.refresh_token && json.refresh_token !== cfg.refreshToken) {
    await saveRedditConfig({ refreshToken: json.refresh_token });
  }
  return redditToken.access;
}

async function redditApi(path, opts = {}) {
  const { method = 'GET', form = null, query = null } = opts;
  const token = await redditAccessToken();
  const url = new URL(path, REDDIT_OAUTH);
  if (query) {
    Object.entries(query).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': REDDIT_UA,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) {
    redditToken = null; // stale token — the next call re-refreshes
    throw new Error('Reddit rejected the token. Try reconnecting your account.');
  }
  if (res.status === 429) throw new Error('Reddit is rate-limiting us. Give it a minute, then try again.');
  if (!res.ok) throw new Error(`Reddit API error (HTTP ${res.status}) on ${url.pathname}`);
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error(`Unreadable response from ${url.pathname}`); }
}

// --- Normalising a listing child into one flat row the UI can sort -----------

function redditThumb(d) {
  const t = d.thumbnail;
  if (t && /^https?:\/\//.test(t)) return t;
  const prev = d.preview && d.preview.images && d.preview.images[0] && d.preview.images[0].resolutions;
  if (Array.isArray(prev) && prev.length) return stripHtml(prev[Math.min(1, prev.length - 1)].url);
  return null;
}

function normalizeRedditChild(child) {
  const d = child.data || {};
  const isComment = child.kind === 't1';
  const permalink = d.permalink ? `${REDDIT_WWW}${d.permalink}` : null;
  const base = {
    name: d.name,                       // fullname, e.g. t3_abc123 — what the API acts on
    id: d.id,
    type: isComment ? 'comment' : 'post',
    subreddit: d.subreddit || '',
    author: d.author || '[deleted]',
    created: Math.round(d.created_utc || 0),
    score: typeof d.score === 'number' ? d.score : null,
    permalink,
    nsfw: !!d.over_18,
    mine: false,                        // filled in below — the caller knows the username
  };
  if (isComment) {
    return {
      ...base,
      title: d.link_title || '(comment)',
      body: (d.body || '').slice(0, 600),
      url: permalink,
      comments: null,
      thumb: null,
      domain: d.subreddit ? `r/${d.subreddit}` : '',
      flair: null,
      self: true,
    };
  }
  return {
    ...base,
    title: d.title || '(untitled)',
    body: d.is_self ? (d.selftext || '').slice(0, 600) : '',
    url: d.url_overridden_by_dest || d.url || permalink,
    comments: typeof d.num_comments === 'number' ? d.num_comments : null,
    thumb: redditThumb(d),
    domain: d.domain || '',
    flair: d.link_flair_text || null,
    self: !!d.is_self,
  };
}

const REDDIT_LISTINGS = {
  saved: (u) => `/user/${u}/saved`,
  submitted: (u) => `/user/${u}/submitted`,
  comments: (u) => `/user/${u}/comments`,
  upvoted: (u) => `/user/${u}/upvoted`,
  downvoted: (u) => `/user/${u}/downvoted`,
  hidden: (u) => `/user/${u}/hidden`,
};

// Reddit pages these 100 at a time and caps history near 1000 items, so walking
// the whole listing once is cheap enough to then sort and filter locally.
const REDDIT_PAGE_CAP = 12;

async function redditFetchAll(kind, username) {
  const path = REDDIT_LISTINGS[kind](username);
  const items = [];
  let after = null;
  let truncated = false;
  for (let page = 0; page < REDDIT_PAGE_CAP; page++) {
    const json = await redditApi(path, { query: { limit: 100, after, raw_json: 1 } });
    const children = json && json.data && json.data.children;
    if (!Array.isArray(children) || children.length === 0) break;
    children.forEach((c) => items.push(normalizeRedditChild(c)));
    after = json.data.after;
    if (!after) break;
    if (page === REDDIT_PAGE_CAP - 1) truncated = true;
  }
  const me = (username || '').toLowerCase();
  items.forEach((it) => { it.mine = it.author.toLowerCase() === me; });
  return { items, truncated };
}

async function handleRedditStatus(res) {
  const cfg = await loadRedditConfig();
  sendJson(res, 200, {
    status: 'ok',
    data: {
      configured: !!cfg.clientId,
      connected: !!(cfg.clientId && cfg.refreshToken),
      username: cfg.username || null,
      clientId: cfg.clientId || '',
      hasSecret: !!cfg.clientSecret,
      redirectUri: redditRedirectUri(),
      scopes: REDDIT_SCOPES,
    },
  });
}

async function handleRedditConfig(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch {
    return sendJson(res, 400, { status: 'error', status_message: 'Bad request body.' });
  }
  const clientId = String(payload.clientId || '').trim();
  if (!clientId) return sendJson(res, 400, { status: 'error', status_message: 'A client ID is required.' });
  // Pointing at a different app invalidates any token the old one minted.
  const cfg = await loadRedditConfig();
  const changed = cfg.clientId !== clientId;
  await saveRedditConfig({
    clientId,
    clientSecret: String(payload.clientSecret || '').trim(),
    ...(changed ? { refreshToken: null, username: null } : {}),
  });
  if (changed) { redditToken = null; redditCache.clear(); }
  return handleRedditStatus(res);
}

async function handleRedditLogin(res) {
  const cfg = await loadRedditConfig();
  if (!cfg.clientId) {
    return sendJson(res, 400, { status: 'error', status_message: 'Set your Reddit client ID first.' });
  }
  const state = randomUUID();
  redditPendingStates.set(state, Date.now());
  // Drop anything older than ten minutes so the map can't grow unbounded.
  for (const [k, at] of redditPendingStates) {
    if (Date.now() - at > 600_000) redditPendingStates.delete(k);
  }

  const auth = new URL(`${REDDIT_WWW}/api/v1/authorize`);
  auth.searchParams.set('client_id', cfg.clientId);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('state', state);
  auth.searchParams.set('redirect_uri', redditRedirectUri());
  auth.searchParams.set('duration', 'permanent'); // so we get a refresh token
  auth.searchParams.set('scope', REDDIT_SCOPES);
  res.writeHead(302, { Location: auth.toString() });
  res.end();
}

function redditCallbackPage(title, message, ok) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{background:#0b0d12;color:#e8eaf0;font:15px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif;
display:grid;place-items:center;height:100vh;margin:0;text-align:center}
.card{max-width:460px;padding:28px 32px;background:#151922;border:1px solid #2a3140;border-radius:12px}
h1{font-size:19px;margin:0 0 8px}p{color:#969fb0;margin:0 0 16px}
a{color:#5b8cff;text-decoration:none}</style></head>
<body><div class="card"><h1>${ok ? '&#9989;' : '&#9888;&#65039;'} ${title}</h1><p>${message}</p>
<a href="/#/reddit">Back to Liam&rsquo;s Multi-Tool</a></div>
<script>setTimeout(function(){ location.replace('/'); }, ${ok ? 1200 : 8000});<\/script>
</body></html>`;
}

async function handleRedditCallback(res, url) {
  const send = (title, msg, ok) => {
    res.writeHead(ok ? 200 : 400, { 'Content-Type': MIME['.html'] });
    res.end(redditCallbackPage(title, msg, ok));
  };
  const error = url.searchParams.get('error');
  if (error) {
    return send('Reddit declined', error === 'access_denied'
      ? 'You cancelled the authorisation. Nothing was connected.'
      : `Reddit returned: ${escapeHtml(error)}`, false);
  }
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !redditPendingStates.has(state)) {
    return send('Could not verify that login', 'The state token did not match. Start the connection again from the Reddit tab.', false);
  }
  redditPendingStates.delete(state);
  if (!code) return send('No authorisation code', 'Reddit did not send a code back. Try again.', false);

  try {
    const cfg = await loadRedditConfig();
    const json = await redditTokenRequest(cfg, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redditRedirectUri(),
    });
    if (!json.refresh_token) {
      return send('No refresh token', 'Reddit returned a one-hour token only. Make sure the app type is "installed app", then try again.', false);
    }
    await saveRedditConfig({ refreshToken: json.refresh_token });
    redditToken = {
      access: json.access_token,
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 60_000,
    };
    const me = await redditApi('/api/v1/me', { query: { raw_json: 1 } });
    await saveRedditConfig({ username: me.name });
    redditCache.clear();
    return send('Connected', `Signed in as u/${escapeHtml(me.name || '?')}. Taking you back&hellip;`, true);
  } catch (err) {
    return send('Connection failed', escapeHtml(err.message), false);
  }
}

async function handleRedditLogout(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  const cfg = await loadRedditConfig();
  // Best effort: ask Reddit to drop the token too, so the app disappears from
  // your authorised-apps list rather than lingering there.
  if (cfg.refreshToken && cfg.clientId) {
    try {
      await fetch(`${REDDIT_WWW}/api/v1/revoke_token`, {
        method: 'POST',
        headers: {
          Authorization: redditBasicAuth(cfg),
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': REDDIT_UA,
        },
        body: new URLSearchParams({ token: cfg.refreshToken, token_type_hint: 'refresh_token' }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { /* the local token is cleared regardless */ }
  }
  await saveRedditConfig({ refreshToken: null, username: null });
  redditToken = null;
  redditCache.clear();
  return handleRedditStatus(res);
}

async function handleRedditListing(res, url) {
  const kind = url.searchParams.get('kind') || 'saved';
  if (!REDDIT_LISTINGS[kind]) {
    return sendJson(res, 400, { status: 'error', status_message: `Unknown listing "${kind}".` });
  }
  const cfg = await loadRedditConfig();
  if (!cfg.refreshToken || !cfg.username) {
    return sendJson(res, 401, { status: 'error', status_message: 'Not connected to Reddit.', code: 'disconnected' });
  }
  const fresh = url.searchParams.get('refresh') === '1';
  const hit = redditCache.get(kind);
  if (!fresh && hit && Date.now() - hit.at < REDDIT_CACHE_TTL_MS) {
    return sendJson(res, 200, { status: 'ok', data: { ...hit.payload, cached: true } });
  }
  try {
    const { items, truncated } = await redditFetchAll(kind, cfg.username);
    const payload = { kind, username: cfg.username, items, truncated, cached: false };
    redditCache.set(kind, { at: Date.now(), payload });
    return sendJson(res, 200, { status: 'ok', data: payload });
  } catch (err) {
    return sendJson(res, 502, { status: 'error', status_message: err.message, code: err.code });
  }
}

// Acting on a selection: unsave, re-save (undo), delete, or clear a vote.
const REDDIT_ACTIONS = {
  unsave: { path: '/api/unsave', verb: 'unsaved' },
  save: { path: '/api/save', verb: 'saved' },
  del: { path: '/api/del', verb: 'deleted' },
  unhide: { path: '/api/unhide', verb: 'unhidden' },
  unvote: { path: '/api/vote', verb: 'unvoted', extra: { dir: 0 } },
};

async function handleRedditAction(req, res, url) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: 'error', status_message: 'Cross-origin request refused.' });
  const action = REDDIT_ACTIONS[url.searchParams.get('action')];
  if (!action) return sendJson(res, 400, { status: 'error', status_message: 'Unknown action.' });

  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch {
    return sendJson(res, 400, { status: 'error', status_message: 'Bad request body.' });
  }
  const ids = (Array.isArray(payload.ids) ? payload.ids : []).filter((s) => /^t[1-6]_[a-z0-9]+$/i.test(s));
  if (!ids.length) return sendJson(res, 400, { status: 'error', status_message: 'No valid item IDs given.' });
  if (ids.length > 500) return sendJson(res, 400, { status: 'error', status_message: 'Too many items at once (max 500).' });

  // Reddit takes one fullname per call, so walk them a few at a time — quick
  // enough for a bulk clear-out without tripping the rate limiter.
  const done = [];
  const failed = [];
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        await redditApi(action.path, { method: 'POST', form: { id, ...(action.extra || {}) } });
        done.push(id);
      } catch (err) {
        failed.push({ id, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  redditCache.clear(); // whatever we had cached is stale now
  return sendJson(res, 200, { status: 'ok', data: { action: action.verb, done, failed } });
}

async function handleRedditApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/reddit\/?/, '');
  try {
    if (route === 'status') return await handleRedditStatus(res);
    if (route === 'config' && req.method === 'POST') return await handleRedditConfig(req, res);
    if (route === 'login') return await handleRedditLogin(res);
    if (route === 'callback') return await handleRedditCallback(res, url);
    if (route === 'logout' && req.method === 'POST') return await handleRedditLogout(req, res);
    if (route === 'listing') return await handleRedditListing(res, url);
    if (route === 'action' && req.method === 'POST') return await handleRedditAction(req, res, url);
  } catch (err) {
    return sendJson(res, 500, { status: 'error', status_message: err.message, code: err.code });
  }
  return sendJson(res, 404, { status: 'error', status_message: 'Unknown Reddit endpoint.' });
}

export const tool = {
  id: 'reddit',
  name: 'Reddit',
  icon: '👽',
  blurb: 'Sort and clear out your saved posts, comments and votes.',
  prefix: '/api/reddit/',
  handle: handleRedditApi,
  async banner() {
    const cfg = await loadRedditConfig();
    return [['reddit', cfg.username ? `signed in as u/${cfg.username}` : 'not connected']];
  },
};
