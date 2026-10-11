# Hashbolt ⚡

Stremio addon that serves **only TorBox-cached streams** for movies and series, from the
[DMM hashlists](https://github.com/debridmediamanager/hashlists) plus an optional Redis `hashlib`.

- Torrents (⚡) and web downloads (🌐⚡), checked against the TorBox cache before listing
- Season packs: the right episode file is picked automatically
- Each user installs with their own TorBox key from `/configure`; keys are never stored server-side
- Users must opt in to sharing anonymized torrent data (hash, name, size) from their library, which grows the index

## How the index updates

```
GitHub Actions (every 30 min)                     Hashbolt server (every 10 min)
  clone hashlists + scan Redis                      GET release "index" (1 API call)
  build.js -> sorted data.tsv                       asset changed? download + gunzip
  publish data.tsv.gz to release "index"  ───────>  swap file, reload in memory
```

`build.js` caches each decoded list by its git blob sha (`actions/cache`), so a run only decompresses
lists that changed. The server needs no git; its only dependency is `ioredis`, for data sharing.

## Data sharing

The configure page requires consent before it hands out an install link. The consent is encoded in the install URL
(`base64url({"key", "contribute": true})`); installs with a bare key never contribute.

For opted-in users, a stream request reads their TorBox torrent list at most once every 6 hours (throttled in memory
by a SHA-256 of the key) and `HSETNX`es `{name, size}` per info hash into the Redis `hashlib`. The next index build
picks them up. Web downloads are skipped, and nothing ties an entry to the user. Without `REDIS_URL` on the
server, nothing is collected.

## Setup

1. Push this repo to GitHub as `hashbolt`.
2. Add the `REDIS_URL` repository secret (optional; without it only the git hashlists are indexed).
3. Run the **Build index** workflow once (Actions → Build index → Run workflow); after that it runs every 30 minutes.
4. Deploy the server with `INDEX_REPO=<owner>/hashbolt`, `REDIS_URL` (for contributions) and `GITHUB_TOKEN` if the repo is private.

> If the repo is public, the release (including the Redis entries) is public too.

## Run the server

```sh
cp .env.example .env
npm start              # http://localhost:7001/configure
```

Docker:

```sh
docker build -t hashbolt .
docker run -d --name hashbolt -p 7001:7001 -v hashbolt:/data --env-file .env hashbolt
```

Stremio needs HTTPS for remote addons: put it behind a reverse proxy (Caddy, nginx) and set `BASE_URL`.
Plan for ~1 GB RAM. `/health` returns 503 until the first index is loaded.

Without `INDEX_REPO` the server just serves the local `data.tsv`; build one with `npm ci && npm run build`
(needs `HASHLISTS_DIR` pointing at a hashlists clone).

## Endpoints

| Path | |
|---|---|
| `/configure` | install page |
| `/:key/manifest.json` | addon manifest |
| `/:key/stream/:type/:id.json` | cached streams |
| `/:key/play/:hash[/:s/:e]` | adds to TorBox if needed, redirects to the file |
| `/health` | index size, 503 until loaded |
