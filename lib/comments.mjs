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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Measured at roughly fifty a second once going, so these are deliberate
// choices rather than a slider: a thousand is twenty seconds, five thousand is
// nearly two minutes, and "all" on a busy video is however long it is.
export const COMMENT_LIMITS = [100, 500, 1000, 2500, 5000, 'all'];
const DEFAULT_LIMIT = 100;

// Roughly what was measured, used only to warn before a long wait.
export const COMMENTS_PER_SECOND = 50;

export const isValidLimit = (v) => COMMENT_LIMITS.includes(String(v) === 'all' ? 'all' : Number(v));

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
  const limit = isValidLimit(opts.limit)
    ? (String(opts.limit) === 'all' ? 'all' : Number(opts.limit))
    : DEFAULT_LIMIT;
  const sort = opts.sort === 'new' ? 'new' : 'top';

  return new Promise((resolve) => {
    // The info JSON goes to a file rather than to stdout.
    //
    // -J is the obvious way to get it, and it is the wrong one: it puts yt-dlp
    // into quiet mode, so the run is completely silent — no stderr at all,
    // measured. Everything worth knowing while it works is in that logging:
    // the running count, and the video's real comment total. Writing the JSON
    // to a file leaves the logging intact and costs one temp file.
    const dir = mkdtempSync(join(tmpdir(), 'mt-yt-'));
    const stem = join(dir, 'info');

    const child = spawn(ytdlpPath, [
      '--skip-download',
      '--write-info-json',
      '--write-comments',
      '--no-warnings',
      '-o', `${stem}.%(ext)s`,
      '--extractor-args', `youtube:${limitArg(limit)};comment_sort=${sort}`,
      '--', url,
    ], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });

    let log = '';
    let total = null;

    // "Downloading ~2457233 comments" — how many the video actually has, which
    // no field in the JSON reports once the fetch is capped.
    // "Downloading comment API JSON page 1 (240/~2457233)" — how far along.
    const onText = (d) => {
      const text = String(d);
      log += text;

      const totalLine = text.match(/Downloading ~?([\d,]+) comments/);
      if (totalLine) total = Number(totalLine[1].replace(/,/g, ''));

      for (const m of text.matchAll(/\((\d+)\/[^)]*\)/g)) {
        if (opts.onProgress) opts.onProgress(Number(m[1]));
      }
    };
    child.stdout.on('data', onText);
    child.stderr.on('data', onText);

    const timer = setTimeout(() => child.kill(), 30 * 60 * 1000);

    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } };

    child.on('error', () => {
      clearTimeout(timer);
      cleanup();
      resolve({ ok: false, message: 'Could not run yt-dlp.' });
    });

    child.on('close', () => {
      clearTimeout(timer);
      const file = `${stem}.info.json`;
      let json;
      try {
        json = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        cleanup();
        const line = log.split('\n').find((l) => l.includes('ERROR:'));
        return resolve({ ok: false, message: (line || 'yt-dlp could not read that video.').trim() });
      }
      cleanup();
      resolve({ ok: true, data: shape(json, limit, sort, total) });
    });
  });
}

// Replies carry the id of what they answer; top-level ones say "root".
const isReply = (c) => c.parent && c.parent !== 'root';

function shape(json, limit, sort, total) {
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
    // Not json.comment_count: when the fetch is capped that field comes back
    // equal to the cap — 25 when 25 were asked for — so it would claim the
    // search covered every comment when it covered the first few.
    //
    // The real figure comes from yt-dlp's own logging ("Downloading ~2457233
    // comments"), which is another reason the run is no longer silenced. It is
    // YouTube's own approximation, so it is shown as one.
    total: typeof total === 'number' && total > 0 ? total : null,
    fetched: comments.length,
    // Whether the cap was reached, which is the honest version of that: more
    // may exist beyond it. "all" is never capped — it stopped because it ran
    // out, which is the one case where the count really is the whole count.
    capped: limit !== 'all' && comments.length >= limit,
    complete: limit === 'all',
    limit,
    sort,
    comments,
  };
}
