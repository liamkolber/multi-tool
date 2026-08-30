# Liam's Multi-Tool

A local web app that hosts a set of personal tools behind one launcher. Open it,
pick a tool, get on with it.

| | Tool | What it does |
|---|---|---|
| 🎬 | **Media Library** | Movies & TV via the [YTS](https://yts.gg) API and anime via [AniList](https://anilist.co), from one search box |
| ⬇ | **Downloader** | Paste any URL [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports and pull it at the highest quality available |
| 🎛️ | **Converter** | Convert, trim, resize, compress and extract — a front end for ffmpeg |
| 📚 | **Library** | Scan a folder and see what is really in it: sizes, quality, subtitles, duplicates |
| 🧪 | **Utilities** | Regex (build, infer, explain, test), JSON, encoding, hashes, timestamps, text |
| 👽 | **Reddit** | Sign into your own account and browse, sort and clear out your saved posts, submissions and votes |

No build step, no npm dependencies — just Node. (The Downloader additionally
wants the yt-dlp and ffmpeg binaries; everything else runs without them.)

## Requirements

- Node.js 18+ (uses the built-in `fetch` and HTTP server; no `npm install` needed)

## Run

```bash
npm start
# or:
node server.mjs
```

Then open <http://localhost:8080>.

Change the port with the `PORT` env var:

```bash
PORT=3000 node server.mjs
```

The launcher is at `/`; each tool has its own URL, so `#/media`, `#/downloader`
and `#/reddit` are bookmarkable and survive a refresh.

## Shortcuts (Windows)

For one-double-click access, create Desktop and Start Menu shortcuts:

```powershell
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1
```

This drops a **Liam's Multi-Tool** shortcut (with a generated icon) on your Desktop and
in the Start Menu (searchable by typing "Media"; right-click it there to pin to
Start or the taskbar). Double-clicking it runs `launch.vbs`, which:

1. starts the server with **no console window at all**,
2. puts a **Multi-Tool icon in the system tray**, then
3. opens <http://localhost:8080> in your default browser.

Right-click the tray icon for Open, Open downloads folder, View server log,
Restart server, and **Quit** — Quit is how you stop the app now. Double-clicking
the icon reopens it in the browser. Launching the shortcut a second time just
reopens the browser rather than stacking up a second server and icon.

> Windows 11 hides new tray icons behind the `^` chevron. Drag it onto the
> taskbar once to keep it in view.

With no console, server output goes to `server.log` (gitignored) — **View server
log** opens it. To watch it live instead, run `node server.mjs` in a terminal;
that path still works and prints the usual banner.

Re-run `install-shortcut.ps1` if you ever move the project folder, or to
re-point an older shortcut at the tray launcher.

## 🎬 Media Library

One search box across movies/TV **and** anime, with an All / Movies & TV / Anime
/ ★ Watchlist sub-nav in a collapsible sidebar.

- 🌐 Cross-language titles: anime search matches English / romaji / native
  (AniList does this natively); movie search runs an IMDb-id lookup **alongside**
  YTS on every text search and merges the results (deduped, page 1), so an
  English title also finds a film YTS only lists under its original title
  (e.g. "Crimson Gold" → "Talaye sorkh") — via IMDb's public suggestion endpoint
- 🎚️ Movie filters (quality, **popular: all-time / this-year**, **age rating**
  (R/PG-13/… as a color-coded chip on each card), genre, sort) and
  anime filters (genre,
  **tag** (AniList's full tag set, grouped by category), format,
  **status incl. "Airing now"**, **rating (one maturity ladder: Any / PG / Teen
  13+ / Mature 17+ & up via MAL tiers (Jikan→AniList), plus Adult 18+ via
  AniList `isAdult`)**, sort), plus a **▶ Streamable** toggle (only titles with an
  official streaming source), shown per source
- 🖼️ Unified poster grid with rating badges, a source badge, and a ☆ bookmark
  on every card
- 🗂️ **Group series** toggle (Anime tab) — collapse same-franchise entries
  (Fate/…, One Piece films) into one series card; open it for the full entry
  list, sortable **By year** or **Story order** (chronological prequel→sequel,
  derived from AniList's relation graph), with a back button between the two views
- ⭐ **Watchlist** saved in your browser (localStorage), with its own tab
- ▶️ **Inline trailers** — play the YouTube/Dailymotion trailer in the detail view
- 🎬 Movie detail: synopsis, IMDb, per-quality magnet + `.torrent` rows
- 🌸 Anime detail: synopsis, studio, tags, **characters + voice actors**,
  **related entries** (prequels/sequels/side stories — click to open), official
  "where to watch" streaming links, plus a **MyAnimeList link, score, and
  content rating** (G/PG-13/R…, via Jikan) alongside the AniList score
- ⭐ **Watchlist** saved in your browser (localStorage), with its own tab
- ▶️ **Inline trailers** — play the YouTube/Dailymotion trailer in the detail view
- 🎬 Movie detail: synopsis, IMDb, per-quality magnet + `.torrent` rows
- 🌸 Anime detail: synopsis, studio, tags, **characters + voice actors**,
  **related entries** (prequels/sequels/side stories — click to open), official
  "where to watch" streaming links, plus a **MyAnimeList link, score, and
  content rating** (G/PG-13/R…, via Jikan) alongside the AniList score
- ⌨️ Keyboard friendly (open cards with Enter, close the modal with Esc)

Point at a different mirror/upstream with the `YTS_API` env var:

```bash
YTS_API=https://yts.mx/api/v2 node server.mjs
```

## ⬇ Downloader

The **Downloader** takes any URL [yt-dlp](https://github.com/yt-dlp/yt-dlp)
supports, probes it, and lists the real resolutions available. Pick one (or
**Best available**) and a **Save as** dialog opens, prefilled with the video's
title. Choose a name and folder and it downloads there with live progress;
**Show in folder** reveals the finished file.

The dialog reopens in whatever folder you used last, the way a browser download
does. That folder is the only thing persisted (in a gitignored `.dl-config.json`),
and until you save something the first time it starts at `downloads/`.

The extension you choose in the dialog wins: naming the file `.mp4` gets you MP4
even with **Prefer MP4** unticked. Playlists ask for a folder rather than a file
name, and on macOS/Linux the dialog is a folder picker throughout.

Every probe also offers the video's **thumbnail** at its largest available size:
**View** opens it in a new tab, **Download** saves it through the same dialog.
It is kept in whatever format the host serves (usually `.webp` from YouTube) —
re-encoding to `.jpg` would only cost quality.

Finished downloads are listed with their thumbnail and survive a server restart
(kept in a gitignored `.dl-jobs.json`), so **Show in folder** keeps working after
a bounce.

It leans on three binaries, none bundled:

| | | |
|---|---|---|
| **yt-dlp** | required | does the extraction and downloading |
| **ffmpeg** | for >720p | YouTube serves video and audio separately above 720p, so they must be merged |
| **deno** | recommended | yt-dlp's JavaScript runtime; YouTube extraction without one is deprecated and some formats may be missing |

Get all three into a gitignored `bin/` folder next to the server:

```powershell
npm run get-tools
```

Or install them system-wide instead — `winget install yt-dlp.yt-dlp`, `winget install DenoLand.Deno`, and
`winget install Gyan.FFmpeg`. Either way the tool picks them up (`bin/` first,
then `PATH`); hit **Re-check** after installing. Without ffmpeg the tool still
works, capped at 720p, and says so.

Merged downloads default to **MKV**, which holds any codec combination yt-dlp
picks. Tick **Prefer MP4** for wider device compatibility at the cost of
sometimes settling for a lower-quality stream.

Notes:

- Playlist URLs are detected and offered as a single "download all N items" job.
  A plain video URL never pulls in the rest of its playlist.
- The server binds to `127.0.0.1` (override with `HOST`), and the download
  endpoints reject cross-origin requests and private/loopback targets — the
  downloader is the one part that takes an arbitrary URL, so it stays local.
- `DOWNLOAD_DIR` sets the starting folder, used until the first time you save
  somewhere; after that the remembered location wins. Delete `.dl-config.json`
  to forget it.

## 🎛️ Converter

A front end for the `ffmpeg` the Downloader already ships. Pick a file (or paste
a path), and only the operations that suit what it actually is are offered — a
JPEG is never asked for its audio track.

| Input | Operations |
| --- | --- |
| Video | Convert · Extract audio · Trim · Compress to size · Resize · Make GIF · Remove audio |
| Audio | Convert/extract · Trim |
| Image | Convert · Resize |

Notes on the ones with a catch:

- **Convert** defaults to *Remux* — a stream copy, so it is instant and lossless.
  It only works when the existing codecs are legal in the target container, so
  asking for WebM always re-encodes (it takes neither H.264 nor AAC).
- **Trim** in fast mode cuts on keyframes, so the start can land up to a second
  early. Exact mode re-encodes and is slow but frame-accurate.
- **Compress** is single-pass at a computed bitrate. It lands close to the target
  rather than exactly on it; two-pass would be more accurate and twice as slow.
- **Resize** rounds the width to an even number, which H.264 requires.

Progress is streamed over SSE the same way downloads are, and the queue keeps
failed and cancelled jobs with a **Retry** that replays the exact settings.

`ffprobe` is used to read a file's streams when present, falling back to parsing
`ffmpeg -i` when it isn't. Run `npm run get-tools` to add it — it comes out of
the same archive as ffmpeg, so it costs nothing extra.

## 📚 Library

Point it at a folder and it walks the whole tree, probes every media file it
finds, and hands the browser one flat index. Everything after that — search,
sort, filters — runs against that index in memory, so it is instant.

What it surfaces:

- **Totals** — file count, disk used, combined runtime
- **Below 1080p** — what is worth re-pulling at a better quality
- **No subtitles** — neither an embedded track nor a sidecar `.srt` beside it
- **Possible duplicates** — see below
- **Thumbnails** — a poster frame per file, taken 10% of the way in (the opening
  seconds are so often black or a title card). They are rendered on demand as
  rows scroll into view and cached to a gitignored `.library-thumbs/`, so a
  library of thousands costs nothing until you actually look at it. The cache key
  folds in size and mtime, so an edited file gets a fresh frame rather than a
  stale one. Toggle them off in the controls if you would rather have the density
- **Images** — only when **Include images** is ticked before scanning. They are
  off by default because a media folder can hold tens of thousands of them, each
  costing an ffmpeg process to probe, and because they count against the 20,000
  file index limit and can push the videos out of it. Folder sizes count them
  either way
- **Archives** — `.zip`, `.rar`, `.7z`, `.iso` and friends, indexed by size but
  never handed to ffmpeg, since there is nothing in one for it to read
- **Over 4 GB** and **Unreadable** (a file ffmpeg cannot make sense of)

Every row shows the folder it lives in, relative to the scanned root — click it
to filter the list to that folder — and offers **Open** (hands the file to
whatever Windows opens it with, exactly as a double-click would), **Reveal**
(shows it in Explorer), **Delete**, and for media **Convert** (hands it to the
Converter). Sorting by **Folder** groups everything by location, which is the
useful order when working through duplicates.

Sorting by **Duplicate sets** keeps each set together — ordered by the biggest
file in it, largest copy first inside it — so the one worth keeping heads its
group and everything under it is a candidate. Alternate sets are tinted so where
one ends and the next begins is obvious. Each row says which set it belongs to
("same length · 1 of 4"), and the **Reclaimable** figure is what deleting all
but the largest copy of every set would free, counted once per set.

### Seeing what a file is

Hovering a thumbnail builds a **contact sheet** — sixteen frames spread across
the whole running time, tiled into one image. A single poster frame says almost
nothing about a two-hour video and nothing at all about a file named after its
hash. Sheets cache alongside the thumbnails, keyed the same way.

Clicking a thumbnail **plays the file** in place. The server answers byte
ranges, so seeking works without downloading the whole thing first. Chromium
cannot decode Matroska or some codecs; when that happens the player says so and
offers to hand the file to the external app instead of just showing a black box.

Sheets are built from sixteen fast seeks in one ffmpeg process rather than one
pass with an  filter — the filter decodes the entire file, which on a long
video is minutes, while seeking to each point is near-instant. Measured at 265ms
for a two-minute clip, and 1.6ms once cached.

### Filters

Filters combine. Picking several ANDs them, so **Same length & size** plus
**Over 4 GB** is the duplicates actually worth reclaiming rather than either
list on its own. **All** clears the selection. Each chip's count is what it
would leave *given the other chips already on*, so it says what clicking it does
rather than what it would do alone.

Picking any duplicate filter switches the order to **Duplicate sets** for you,
since that filter is close to useless under any other one — you would get a list
of files that each have a match somewhere with no way to see what they match.
Dropping the last one puts your previous order back. Changing the sort by hand
stops it rearranging anything, and it only ever fires on the way in and the way
out, so adding a second duplicate filter never takes back a choice you just
made.

Members of a set are drawn as one block — the gap between them closed and the
facing corners squared — so a set reads as a single thing with several rows.

They are grouped by kind, duplicates, quality and size. Beyond the duplicate
signals there are vertical video, files with no audio track, under 20 MB, over
an hour, under five minutes, and the quality and subtitle filters.

Rows load a chunk at a time as you reach the end of the list. A fixed cap meant
a thousand duplicates you could never scroll to, and rendering all of them up
front means tens of thousands of DOM nodes before you have looked at one.

### Deleting

**Delete** moves the file to the **Recycle Bin**. Never straight off the disk —
this button sits next to duplicate detection that is explicitly heuristic, and
"same length" is a strong hint rather than proof, so getting it wrong has to be
survivable. On Windows that means `Microsoft.VisualBasic.FileIO.FileSystem`,
which is the only route that genuinely recycles rather than unlinking.

It takes two clicks: the first arms the button, the second within four seconds
does it. A dialog per row would make working down a list of duplicates
miserable; an unguarded button would be worse.

Deleted files stay listed in a strip above the results with a **Restore** button
for each, so an accident is one click to undo rather than a hunt through the
Recycle Bin for the right name. The last 50 stay undoable, and the list survives
a restart. **Dismiss** clears the list without restoring anything — the files
remain in the Recycle Bin regardless.

Folders are deliberately not deletable. Removing one file at a time is a mistake
you can undo; removing a tree is a different kind of afternoon.

Folder totals and the file index are adjusted as files come and go, so nothing
needs rescanning after a delete or a restore.

The last five folders you scanned appear as chips under the bar — one click
rescans one, which is the usual case when you keep a couple of libraries. The
box is prefilled with the most recent on arrival, so the shortcut still works
after the index has been cleared.

### Folders

The **Folders** view lists every subdirectory under the scanned root with its
recursive size and file count — what the folder holds including everything
nested beneath it — sortable by size, file count, name, path or depth, with a
"top level only" toggle for the overview.

Each row also reports what sits *directly* in that folder, because the two
numbers diverging is the interesting case: a folder can be enormous while
holding nothing itself.

These totals count **every** file, not just the media, so they agree with what
Explorer shows you. That is also why the scan stats every file it passes rather
than only the ones worth probing — `stat` is cheap next to an ffmpeg process.
Folders that the walk skips (hidden ones, `node_modules`, recycle bins,
Windows system directories) are not counted, so a scan pointed at a system drive
will not match Explorer there.



### How duplicates are decided

Three independent signals, because "duplicate" means more than one thing. Each
row says which one matched it.

| Signal | Means | Certainty |
| --- | --- | --- |
| **identical file** | Same byte count *and* the same hash of the first and last 64 KB | Effectively certain |
| **same length and size** | Same running time, and sizes within 12% of each other | Very strong |
| **same length and resolution** | Same running time and the same frame size | Strong |
| **same length** | Same running time, within half a second, over 30 seconds | Weakest — many files share a length |
| **same name** | The same filename, exactly, in two different folders | Strong |

The first is what catches *the same video under a completely different name*: a
plain copy or a rename shares every byte, so the name is irrelevant. Only files
that collide on size are ever read, and only 128 KB of each, so this costs
almost nothing even on a large library. Two different videos that happen to
share a byte count will differ in their container header or index, so the hash
separates them.

The middle three are all cuts through the same idea — the same content
**re-encoded, resized or remuxed**, where the bytes differ entirely but the
running time does not. The 30-second floor is there because two clips both eight
seconds long are not evidence of anything.

Running times are compared **within half a second**, not rounded to the nearest
one. Rounding put every 33-minute video in the same bucket, which across a few
thousand files is hundreds of unrelated collisions; a re-encode of the same
source lands within a frame or two of its original, so the tolerance can be that
tight without losing the case the signal exists for. Sets are anchored on their
first member rather than chained from the previous one, or forty files drifting
half a second apart would all end up in one group.

On top of that, **same length and size** (within 12%) and **same length and
resolution** narrow a length set to the members that agree on something else as
well. Those are the two filters worth reaching for first — plain "same length"
is the loose one.

The third is an exact filename match, case-insensitive. Two files cannot share
a name within one folder, so this always means copies sitting in different
places — worth flagging even when their sizes and running times differ, since
that is usually the same thing at two qualities.

It used to normalise release names instead — stripping resolutions, codecs and
release groups so that
`Movie.2019.1080p.BluRay.x264-GROUP.mkv` and `Movie (2019) [720p].mp4`
would match. On a real library that was a menace. The trailing-release-group
rule ate the only distinguishing part of names like
`CHANNEL - 13177.mov` and `CHANNEL - 13144.mp4`, collapsing hundreds of
unrelated files onto one key. It also contributed nothing the length signal did
not already cover, because a fuzzy name only counted as a duplicate when the
running times agreed anyway. Exact is what is left, and it is the version that
is actually true.

Probing is one process per file, so results are cached by path + size + mtime:
a rescan after adding a few files only probes the few that changed. The index
lives in a gitignored `.library-index.json`.

The walk skips hidden folders, `node_modules`, recycle bins and Windows system
directories, and stops at 12 levels deep or 20,000 files.

## 🧪 Utilities

The small conversions you reach for constantly, with no server half at all —
nothing it does leaves the browser.

Six sections on one page — Regex, JSON, Encode, Hash, Time and Text — each
under its own heading rather than hidden behind a tab.

**Regex** starts by asking what you are there to do, and shows only that:

- **Build it** — stack pieces ("a digit, exactly 3 times", "this exact text",
  "one of these words") and the pattern is written for you, correctly escaped
  and correctly wrapped. A multi-character piece is parenthesised before a
  quantifier, so "one or more of `abc`" gives `(?:abc)+` rather than
  `abc+`, which repeats only the c.
- **Infer it from examples** — paste strings you want matched, one per line, and
  it generalises them. `AB-1234` / `XY-5678` / `QQ-0001` gives
  `^[A-Z]{2}-\d{4}$`. Separators identical across every example are kept
  verbatim, since they are structure rather than something to guess at. Examples
  that share no structure fall back to matching them literally, and say so.
- **What it means** — any pattern, yours or one you pasted, described token by
  token in English.

Then test it against real text with live highlighting, a match count, and a
table of capture groups (named groups included).

Also here: **JSON** format/minify with the parse error resolved to a line and
column; **Encode** for Base64 (standard and URL-safe, UTF-8 correct), URL
components and HTML entities; **Hash** for SHA-1/256/384/512; **Time** for
converting between Unix seconds, milliseconds, ISO 8601 and local; and **Text**
for case conversion, slugs, trimming, deduping, sorting and reversing lines.

> One limit worth knowing: a JavaScript regex cannot be interrupted once it is
> running, so a pathological pattern against a large input can hang the tab.
> The subject is capped at 20,000 characters, which keeps the worst case
> survivable — it is a mitigation, not a cure.

## 👽 Reddit

Signs into **your own** Reddit account through the official OAuth API and shows
you your history so you can actually manage it. Nothing is scraped — every call
goes to `oauth.reddit.com` as you.

### One-time setup

> **Reddit closed this off to new apps (checked 2026-08-26).** Creating a Data
> API app now requires a *valid moderation use case*. Without one, **create app**
> at `/prefs/apps` silently does nothing: the `POST` to `updateapp` returns
> `200` with `"success": true`, creates no app, and renders only a link to the
> Responsible Builder Policy into the form's status line. There is no error
> message, and it is not a captcha, browser, extension or email-verification
> problem — it fails identically in a clean browser with a verified account.
> Client IDs issued before the change keep working; new ones are gated.
>
> The only sanctioned route is a **Data Access Request**:
> <https://support.reddithelp.com/hc/en-us/requests/new> → *Data Access Request*
> → *I'm a developer* → *"I'm a developer and want to build a Reddit App that
> does not work in the Devvit ecosystem."* Devvit itself is no substitute here:
> it builds subreddit-installed apps that run inside Reddit, and offers no way
> to read or modify your own cross-subreddit saved/voted history from a local
> client. Request submitted 2026-08-26; awaiting a response.
>
> The steps below are unchanged and still correct — they just can't be completed
> until Reddit issues a client ID.

Reddit requires each client to be registered, so the tool walks you through it
the first time you open it:

1. Open <https://www.reddit.com/prefs/apps> → **create another app…**
2. Any name; choose **installed app**.
3. Paste the redirect URI the tool shows you (click it to copy) — by default
   `http://localhost:8080/api/reddit/callback`. It must match byte for byte.
4. Copy the client ID (the string under the app name) into the tool and hit
   **Connect Reddit account**.

Reddit then asks you to approve the scopes `identity history save edit vote read`
— enough to list your history and clear it out, and nothing more. The refresh
token is stored locally in a gitignored `.reddit.json` and never leaves your
machine. **Disconnect** revokes it with Reddit and deletes it.

Finished downloads keep their place in the list with **Remove**, and the header
carries **Clear history**. Both drop records only — the downloaded files are
never touched. Clearing asks twice, since a thrown-away list has no undo even
when the files are safe. A download still running cannot be removed; cancel it
first, or it would be left with nothing watching it.

yt-dlp decides what is supported, not this tool, so anything it has an extractor
for works — RedGifs included (single posts, user galleries and searches).

Override the redirect URI with `REDDIT_REDIRECT_URI` if you run on another port.

### What you can do

- Browse **🔖 Saved**, **📝 My posts**, **💬 My comments**, **⬆ Upvoted**,
  **⬇ Downvoted** and **🙈 Hidden**
- Everything is fetched in one pass (Reddit caps history near 1000 items) and
  held in memory, so **search, sort and filter are instant** — sort by newest,
  oldest, score, comment count, subreddit or title; filter by subreddit, by
  posts-vs-comments, or by free text across title, body, author and domain
- **Tick items and clear them out in bulk** — Unsave, Unhide, Clear vote, or
  Delete (delete only appears for things you actually wrote, and always confirms)
- A bulk **Unsave** offers an **Undo** that puts everything straight back

## Tests

`npm test` covers the parts with real logic in them: regex building,
inference and explanation, plus the Base64 and text transforms. They run in
plain Node against the same modules the browser loads — no framework, no build
step.

## How it works

```
browser  ──►  server.mjs  ──►  lib/tools/media.mjs       ──►  YTS / AniList / Jikan
              (router)    ──►  lib/tools/downloader.mjs  ──►  yt-dlp
                          ──►  lib/tools/convert.mjs     ──►  ffmpeg
                          ──►  lib/tools/library.mjs     ──►  ffprobe
                          ──►  lib/tools/reddit.mjs      ──►  oauth.reddit.com
```

The server is deliberately thin: it serves `public/`, answers `/api/tools` with
the tool manifest, and hands every other `/api/` request to whichever tool claims
that path prefix. It knows nothing about what any of them do.

```
server.mjs              routing + startup banner, ~55 lines
lib/core.mjs            JSON replies, request bodies, same-origin guard,
                        upstream cache, static file serving
lib/tools/*.mjs         one file per tool; each exports a `tool` object
                        ({ id, name, icon, blurb, prefix, handle, init, banner })

public/index.html       the shell: rail, launcher, shared modal
public/app.js           tool registry + hash router; mounts panels on first visit
public/lib/dom.js       shared helpers ($, esc, debounce, modal, …)
public/tools/*.js       one file per tool; each exports a `tool` object
                        ({ id, name, icon, blurb, mount, show }) and owns its
                        own markup, styles and state
public/styles/          base.css (tokens + chrome), shell.css, one per tool
```

Tools are lazy: a panel stays empty until you first open that tool, so the
launcher loads instantly no matter how many are registered.

### Adding a tool

1. `lib/tools/yours.mjs` — export a `tool` with a `prefix` and a `handle`.
2. `public/tools/yours.js` — export a `tool` with a `mount(panel)`.
3. Add one import + one array entry in `server.mjs` and in `public/app.js`.
4. Optionally `public/styles/yours.css`, linked from `index.html`.

Nothing else changes: the rail, the launcher card and the route come from the
registry.

## Notes

The Media Library is a read-only client for public APIs: it surfaces what the YTS
and AniList APIs return (including YTS's own torrent links and AniList's official
streaming links) and stores nothing itself.

The Downloader drives yt-dlp locally and writes files to disk. It runs on your
machine, for you; downloading from a site you do not have the rights to is your
call to make, and YouTube's terms only permit it through their own offline
feature.

The Reddit tool only ever acts on your own account, with scopes you approve, and
can be revoked from <https://www.reddit.com/prefs/apps> at any time.

The server binds to `127.0.0.1` (override with `HOST`), and the tools that take
input reject cross-origin requests.

### Idling

The app never asks the system to stay awake — nothing here calls
`SetThreadExecutionState` or takes a power request, so it cannot keep the
machine from sleeping. Sitting idle with no browser tab attached, the server
uses no measurable CPU at all.

The one piece of ongoing chatter is the progress stream each tool holds open,
which the server pings every 25 seconds to keep alive. Those close themselves
once the tab has been hidden for 30 seconds with no work in flight, and reopen
and resync when you come back — which also covers waking from sleep, since a
suspended machine's sockets are usually dead on resume. A download, conversion
or scan still in flight keeps its stream open, because reporting that progress
is the only reason it exists.

If the machine is not sleeping when you expect it to, the cause is almost
certainly the OS rather than this app:

- `powercfg /a` — which sleep states the hardware supports. On S3 the idle
  timer is reset by user input and power requests, never by network traffic.
- `powercfg /requests` — from an elevated prompt, names whatever is actually
  holding the machine awake.
- `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` — the idle timeout,
  which on a Balanced plan can default to hours on AC power.
