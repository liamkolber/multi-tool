# Liam's Multi-Tool

A local web app that hosts a set of personal tools behind one launcher. Open it,
pick a tool, get on with it.

| | Tool | What it does |
|---|---|---|
| 🎬 | **Media Library** | Movies & TV via the [YTS](https://yts.gg) API and anime via [AniList](https://anilist.co), from one search box |
| ⬇ | **Downloader** | Paste any URL [yt-dlp](https://github.com/yt-dlp/yt-dlp) supports and pull it at the highest quality available |
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

## 👽 Reddit

Signs into **your own** Reddit account through the official OAuth API and shows
you your history so you can actually manage it. Nothing is scraped — every call
goes to `oauth.reddit.com` as you.

### One-time setup

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

## How it works

```
browser  ──►  server.mjs  ──►  lib/tools/media.mjs       ──►  YTS / AniList / Jikan
              (router)    ──►  lib/tools/downloader.mjs  ──►  yt-dlp
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
