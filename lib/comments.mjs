// YouTube comments, via yt-dlp.
//
// yt-dlp already knows how to page through YouTube's comment API, so this asks
// it for them rather than re-implementing that. --write-comments puts them in
// the info JSON; nothing is downloaded.
//
// Fetching is the slow part and scales with how many are asked for, so the
// count is the caller's choice and the result is cached: searching is then
// instant, because it runs over what is already in hand rather than asking
// YouTube again for every keystroke.
import { spawn } from 'node:child_process';

// Comment fetching is measured in seconds per hundred, so these are deliberate
// choices rather than a slider.
export const COMMENT_LIMITS = [100, 250, 500, 1000];
const DEFAULT_LIMIT = 100;

export const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

export function isYouTube(raw) {
  try {
    return YOUTUBE_HOST.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

// yt-dlp's four numbers are: total, top-level, replies overall, replies per
// thread. Replies are left out — they multiply the fetch time and a search is
// almost always after the top-level remark.
const limitArg = (n) => `max_comments=${n},${n},0,0`;

/**
 * @param {string} ytdlpPath
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {'top'|'new'} [opts.sort]
 * @param {(n:number)=>void} [opts.onProgress]  comments seen so far
 */
export function fetchComments(ytdlpPath, url, opts = {}) {
  const limit = COMMENT_LIMITS.includes(Number(opts.limit)) ? Number(opts.limit) : DEFAULT_LIMIT;
  const sort = opts.sort === 'new' ? 'new' : 'top';

  return new Promise((resolve) => {
    const child = spawn(ytdlpPath, [
      '-J',
      '--write-comments',
      '--no-warnings',
      '--extractor-args', `youtube:${limitArg(limit)};comment_sort=${sort}`,
      '--', url,
    ], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });

    let out = '';
    let err = '';
    // A long fetch with no sign of life reads as a hang, and yt-dlp reports its
    // progress on stderr — "Downloading comment API JSON reply 3 (50/200)".
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      err += d;
      const m = String(d).match(/\((\d+)\/[\d~]+\)/);
      if (m && opts.onProgress) opts.onProgress(Number(m[1]));
    });

    const timer = setTimeout(() => child.kill(), 5 * 60 * 1000);

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, message: 'Could not run yt-dlp.' });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) {
        const line = err.split('\n').find((l) => l.includes('ERROR:'));
        return resolve({ ok: false, message: (line || 'yt-dlp could not read that video.').trim() });
      }
      let json;
      try { json = JSON.parse(out); } catch {
        return resolve({ ok: false, message: 'yt-dlp returned something unreadable.' });
      }
      resolve({ ok: true, data: shape(json, limit, sort) });
    });
  });
}

// Replies carry the id of what they answer; top-level ones say "root".
const isReply = (c) => c.parent && c.parent !== 'root';

function shape(json, limit, sort) {
  const raw = Array.isArray(json.comments) ? json.comments : [];

  const comments = raw.map((c) => ({
    id: String(c.id || ''),
    parent: isReply(c) ? String(c.parent) : null,
    text: String(c.text || ''),
    author: c.author || 'unknown',
    authorUrl: c.author_url || null,
    avatar: c.author_thumbnail || null,
    likes: Number(c.like_count) || 0,
    // Absolute where yt-dlp has it; YouTube's own "3 years ago" otherwise.
    time: c.timestamp ? c.timestamp * 1000 : null,
    timeText: c._time_text || null,
    byUploader: !!c.author_is_uploader,
    verified: !!c.author_is_verified,
    pinned: !!c.is_pinned,
  }));

  return {
    videoId: json.id || null,
    title: json.title || null,
    uploader: json.uploader || json.channel || null,
    // Deliberately not reporting json.comment_count as a site total: when the
    // fetch is capped it comes back equal to the cap — 25 when 25 were asked
    // for, 100 when 100 were — so showing it as "100 of 100" would claim the
    // search covered every comment on the video when it covered the first
    // hundred. What was fetched is knowable; what exists is not.
    fetched: comments.length,
    // Whether the cap was reached, which is the honest version of that: more
    // may exist beyond it.
    capped: comments.length >= limit,
    limit,
    sort,
    comments,
  };
}
