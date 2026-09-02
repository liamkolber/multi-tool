// Instagram media, fetched directly.
//
// yt-dlp handles Instagram videos and refuses everything else: a photo post
// comes back as "No video formats found", which is most of what Instagram is.
// gallery-dl would cover it but no longer ships a Windows binary, so there is
// nothing to vendor.
//
// So this asks Instagram's own web API, which is what the site itself calls.
// It needs a signed-in session, and the one hard part — Chromium encrypts
// cookie values — is handed to yt-dlp, which already knows how to decrypt them
// and will write a plain cookies.txt on request. That keeps DPAPI, AES-GCM and
// app-bound encryption out of this file entirely.
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The public web client's own app id. The API answers 400 without it.
const IG_APP_ID = '936619743392459';
const IG_API = 'https://www.instagram.com/api/v1';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Ask yt-dlp to decrypt the session profile's cookies into a file, then read
 * them back as a Cookie header.
 *
 * @param {string} ytdlpPath
 * @param {string} browserSpec  e.g. "brave:C:\\path\\to\\profile"
 */
export async function sessionCookies(ytdlpPath, browserSpec) {
  const file = join(tmpdir(), `mt-ig-${process.pid}-${Date.now()}.txt`);
  try {
    await new Promise((resolve) => {
      // --simulate against a trivial URL: the point is the export, not the
      // extraction, and yt-dlp writes the jar out on the way through.
      const child = spawn(ytdlpPath, [
        '--cookies-from-browser', browserSpec,
        '--cookies', file,
        '--simulate', '--no-warnings', '--quiet',
        '--', 'https://www.instagram.com/',
      ], { windowsHide: true, stdio: 'ignore' });
      child.on('exit', resolve);
      child.on('error', resolve);
      setTimeout(resolve, 30_000);
    });

    const text = await readFile(file, 'utf8');
    const jar = [];
    for (const line of text.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length < 7 || !parts[0].includes('instagram.com')) continue;
      jar.push(`${parts[5]}=${parts[6].trim()}`);
    }
    const header = jar.join('; ');
    return /(^|; )sessionid=/.test(header) ? header : null;
  } catch {
    return null;
  } finally {
    // The decrypted session does not linger on disk.
    await unlink(file).catch(() => {});
  }
}

function headersFor(cookies) {
  const csrf = (cookies.match(/csrftoken=([^;]+)/) || [])[1] || '';
  return {
    Cookie: cookies,
    'X-IG-App-ID': IG_APP_ID,
    'X-CSRFToken': csrf,
    'User-Agent': UA,
    Referer: 'https://www.instagram.com/',
    Accept: '*/*',
  };
}

async function apiGet(url, cookies) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { headers: headersFor(cookies), signal: controller.signal });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Instagram refused the session. Sign in again.' };
    }
    if (!res.ok) return { ok: false, message: `Instagram replied ${res.status}.` };
    return { ok: true, json: await res.json() };
  } catch (err) {
    return { ok: false, message: err.name === 'AbortError' ? 'Instagram timed out.' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// A shortcode is the numeric media id written in base64 with a URL-safe
// alphabet, so it converts back arithmetically — no lookup needed.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function shortcodeToMediaId(code) {
  let id = 0n;
  for (const ch of String(code)) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    id = id * 64n + BigInt(i);
  }
  return id ? id.toString() : null;
}

// Instagram lists every rendition it made; the largest is the original.
const largest = (list) => (list || []).slice()
  .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];

const extFromUrl = (url, fallback) => {
  const m = String(url).split('?')[0].match(/\.([a-z0-9]{3,4})$/i);
  return m ? m[1].toLowerCase() : fallback;
};

// One entry per downloadable thing, whatever shape it arrived in.
function normalizeItem(node, index) {
  const isVideo = node.media_type === 2 && node.video_versions;
  const best = isVideo ? largest(node.video_versions)
    : largest(node.image_versions2 && node.image_versions2.candidates);
  if (!best || !best.url) return null;

  return {
    index,
    kind: isVideo ? 'video' : 'photo',
    url: best.url,
    width: best.width || null,
    height: best.height || null,
    ext: extFromUrl(best.url, isVideo ? 'mp4' : 'jpg'),
  };
}

function itemsFrom(media) {
  // media_type 8 is a carousel — the album case.
  const nodes = media.media_type === 8 && Array.isArray(media.carousel_media)
    ? media.carousel_media
    : [media];
  return nodes.map(normalizeItem).filter(Boolean).map((item, i) => ({ ...item, index: i }));
}

/** Everything behind a /p/ or /reel/ link. */
export async function fetchPost(shortcode, cookies) {
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) return { ok: false, message: 'That is not an Instagram shortcode.' };

  const out = await apiGet(`${IG_API}/media/${mediaId}/info/`, cookies);
  if (!out.ok) return out;

  const media = out.json.items && out.json.items[0];
  if (!media) return { ok: false, message: 'Instagram returned no media for that link.' };

  const items = itemsFrom(media);
  if (!items.length) return { ok: false, message: 'Nothing downloadable in that post.' };

  return {
    ok: true,
    data: {
      kind: media.media_type === 8 ? 'album' : items[0].kind,
      owner: (media.user && media.user.username) || null,
      caption: (media.caption && media.caption.text) || '',
      shortcode,
      items,
    },
  };
}

/** The numeric id behind a username, which the stories endpoint needs. */
export async function fetchUserId(username, cookies) {
  const out = await apiGet(
    `${IG_API}/users/web_profile_info/?username=${encodeURIComponent(username)}`, cookies);
  if (!out.ok) return out;

  const user = out.json.data && out.json.data.user;
  if (!user) return { ok: false, message: `No account called ${username}.` };
  return {
    ok: true,
    data: {
      id: user.id,
      username: user.username,
      private: !!user.is_private,
      following: !!user.followed_by_viewer,
    },
  };
}

/**
 * The stories an account has up right now.
 *
 * Same session, same headers — a story is just another media list. Which is
 * also why this can only see accounts the signed-in user is allowed to see:
 * a private account you do not follow returns nothing, exactly as the app
 * would show you nothing.
 */
export async function fetchStories(username, cookies) {
  const who = await fetchUserId(username, cookies);
  if (!who.ok) return who;

  if (who.data.private && !who.data.following) {
    return { ok: false, message: `${username} is private and you do not follow them.` };
  }

  const out = await apiGet(`${IG_API}/feed/reels_media/?reel_ids=${who.data.id}`, cookies);
  if (!out.ok) return out;

  const reel = (out.json.reels_media && out.json.reels_media[0])
    || (out.json.reels && out.json.reels[who.data.id]);
  const raw = (reel && reel.items) || [];
  const items = raw.map(normalizeItem).filter(Boolean).map((item, i) => ({ ...item, index: i }));

  if (!items.length) {
    return { ok: false, message: `${username} has no stories up right now.` };
  }

  return {
    ok: true,
    data: { kind: 'stories', owner: who.data.username, caption: '', shortcode: null, items },
  };
}

/** Media bytes, fetched with the same session the listing came from. */
export async function fetchMedia(url, cookies, extra = {}) {
  const res = await fetch(url, {
    headers: {
      Cookie: cookies,
      'User-Agent': UA,
      Referer: 'https://www.instagram.com/',
      ...extra,
    },
  });
  // 206 is success for a ranged request, which is how video scrubbing works.
  if (!res.ok && res.status !== 206) throw new Error(`Instagram's CDN replied ${res.status}.`);
  return res;
}
