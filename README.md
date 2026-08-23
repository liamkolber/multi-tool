# Media Library

A local web app for browsing **movies & TV** (via the [YTS](https://yts.gg) API)
and **anime** (via the public [AniList](https://anilist.co) API) from one search
box. Filter, sort, and page through both libraries; open any title for details.

- **Movies/TV:** synopsis, trailer, IMDb link, and per-quality download rows
  (magnet + `.torrent`).
- **Anime:** synopsis, studio, trailer, and **official streaming links** (where
  it's legally available — Crunchyroll, Netflix, HIDIVE, …).
- **Download:** paste any URL yt-dlp supports and pull it at the highest
  quality available.

No build step, no npm dependencies — just Node. (The Download tab additionally
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

## Shortcuts (Windows)

For one-double-click access, create Desktop and Start Menu shortcuts:

```powershell
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1
```

This drops a **Media Library** shortcut (with a generated icon) on your Desktop and
in the Start Menu (searchable by typing "Media"; right-click it there to pin to
Start or the taskbar). Double-clicking it runs `launch.ps1`, which:

1. starts the server if it isn't already running (in a minimized
   *Media Library Server* window), then
2. opens <http://localhost:8080> in your default browser.

**To stop the app,** close the minimized *Media Library Server* window. Re-run
`install-shortcut.ps1` if you ever move the project folder.

## Downloading

The **⬇ Download** tab takes any URL [yt-dlp](https://github.com/yt-dlp/yt-dlp)
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

It needs two binaries, neither bundled:

| | | |
|---|---|---|
| **yt-dlp** | required | does the extraction and downloading |
| **ffmpeg** | for >720p | YouTube serves video and audio separately above 720p, so they must be merged |

Get both into a gitignored `bin/` folder next to the server:

```powershell
npm run get-tools
```

Or install them system-wide instead — `winget install yt-dlp.yt-dlp` and
`winget install Gyan.FFmpeg`. Either way the tab picks them up (`bin/` first,
then `PATH`); hit **Re-check** after installing. Without ffmpeg the tab still
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

## How it works

```
browser  ──►  server.mjs  ──►  YTS API (movies-api.accel.li/api/v2)
          ◄──  (static)   ◄──  (JSON, cached ~60s)
```

- **`server.mjs`** serves the frontend from `public/` and exposes a small proxy
  at `/api/*`: the YTS endpoints (`list_movies`, `movie_details`, …) plus
  `anime_search`, which calls the AniList GraphQL API server-side and normalises
  the result into the same shape as a movie. This sidesteps browser CORS and adds
  a short in-memory cache so paging is snappy.
- **`public/`** is the UI: a responsive poster grid (`app.js` + `styles.css`)
  driven entirely by those endpoints.

Point at a different mirror/upstream with the `YTS_API` env var:

```bash
YTS_API=https://yts.mx/api/v2 node server.mjs
```

## Features

- 🔍 One search box across movies/TV **and** anime, with an All / Movies & TV /
  Anime / ★ Watchlist / ⬇ Download toggle
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
- ⬇️ **Download tab** — paste any yt-dlp-supported URL, probe the real available
  resolutions, and pull one at full quality with live progress (see above)
- ⌨️ Keyboard friendly (open cards with Enter, close the modal with Esc)

## Notes

The library half is a read-only client for public APIs: it surfaces what the YTS
and AniList APIs return (including YTS's own torrent links and AniList's official
streaming links) and stores nothing itself.

The Download tab is the exception — it drives yt-dlp locally and writes files to
`downloads/`. It runs on your machine, for you; downloading from a site you do
not have the rights to is your call to make, and YouTube's terms only permit it
through their own offline feature.
