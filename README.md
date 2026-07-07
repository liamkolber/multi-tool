# YTS Library Browser

A local web app for browsing the [YTS](https://yts.gg) movie library through its
public API. Search, filter by quality / genre / rating, sort, page through the
whole ~76k-title catalog, and open any movie for its synopsis, trailer, and
download links (magnet + `.torrent`).

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

## How it works

```
browser  ──►  server.mjs  ──►  YTS API (movies-api.accel.li/api/v2)
          ◄──  (static)   ◄──  (JSON, cached ~60s)
```

- **`server.mjs`** serves the frontend from `public/` and exposes a small proxy
  at `/api/*`. The proxy only forwards a whitelist of endpoints
  (`list_movies`, `movie_details`, `movie_suggestions`,
  `movie_parental_guides`), which sidesteps browser CORS restrictions and adds a
  short in-memory cache so paging is snappy.
- **`public/`** is the UI: a responsive poster grid (`app.js` + `styles.css`)
  driven entirely by the API.

Point at a different mirror/upstream with the `YTS_API` env var:

```bash
YTS_API=https://yts.mx/api/v2 node server.mjs
```

## Features

- 🔍 Search by title, actor, director, or IMDb code
- 🎚️ Filter by quality, genre, and minimum rating
- ↕️ Sort by date added, downloads, likes, rating, year, title, peers, or seeds
- 🖼️ Poster grid with rating badges and available-quality tags
- 🎬 Detail view: synopsis, runtime, genres, trailer, IMDb link, and per-quality
  download rows (magnet links assembled client-side + `.torrent` files)
- ⌨️ Keyboard friendly (open cards with Enter, close the modal with Esc)

## Notes

This is a read-only client for a public API. It surfaces exactly what the YTS API
returns and does not download or store any media itself.
