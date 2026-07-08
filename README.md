# Media Library

A local web app for browsing **movies & TV** (via the [YTS](https://yts.gg) API)
and **anime** (via the public [AniList](https://anilist.co) API) from one search
box. Filter, sort, and page through both libraries; open any title for details.

- **Movies/TV:** synopsis, trailer, IMDb link, and per-quality download rows
  (magnet + `.torrent`).
- **Anime:** synopsis, studio, trailer, and **official streaming links** (where
  it's legally available — Crunchyroll, Netflix, HIDIVE, …).

No build step, no dependencies — just Node.

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

This drops a **YTS Library** shortcut (with a generated icon) on your Desktop and
in the Start Menu (searchable by typing "YTS"; right-click it there to pin to
Start or the taskbar). Double-clicking it runs `launch.ps1`, which:

1. starts the server if it isn't already running (in a minimized
   *YTS Library Server* window), then
2. opens <http://localhost:8080> in your default browser.

**To stop the app,** close the minimized *YTS Library Server* window. Re-run
`install-shortcut.ps1` if you ever move the project folder.

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
  Anime / ★ Watchlist toggle
- 🎚️ Movie filters (quality, genre, rating, sort) and anime filters (genre,
  **tag** (AniList's full tag set, grouped by category), format,
  **status incl. "Airing now"**, score, sort), shown per source
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
  "where to watch" streaming links, plus a **MyAnimeList link + score** (via
  Jikan) alongside the AniList score
- ⌨️ Keyboard friendly (open cards with Enter, close the modal with Esc)

## Notes

Read-only client for public APIs. It surfaces what the YTS and AniList APIs
return (including YTS's own torrent links and AniList's official streaming links)
and does not download or store any media itself.
