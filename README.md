# Hashbolt ⚡

Stremio addon that lists only TorBox-cached streams for movies and series, from the
[DMM hashlists](https://github.com/debridmediamanager/hashlists) and the Redis `hashlib` shared with MyTorbox.

- Cached torrents (⚡) and web downloads (🌐⚡); season packs resolve to the requested episode
- Each user installs with their own TorBox key from `/configure`; keys are never stored server-side
- Installing requires agreeing to share your library into the index (see [Data sharing](#data-sharing))

## How it works

```
GitHub Actions, hourly (dispatched)             Hashbolt server, every 10 min
  blobless clone of hashlists + scan Redis         check release "index" (1 API call)
  build.js -> sorted data.tsv                      changed? download, decrypt, reload
  seal.js -> data.tsv.gz.enc on release "index" ─>
```

- **Build:** each list's decoded contents are cached by git blob sha (`actions/cache`), so a run only fetches and
  decompresses lists that changed.
- **Schedule:** GitHub's cron is best-effort and skips most slots, so the deployment starts the workflow every
  hour with `gh workflow run index.yml`; the workflow's own cron is a 6-hourly backup.
- **Encryption:** the release is public and the index holds what consenting users shared, so only a sealed copy is
  published: gzipped, then AES-256-GCM under `INDEX_KEY` (32 random bytes, base64), which only the workflow (an
  Actions secret) and the server have. The server rejects a file that fails the GCM tag.
- **Lookup:** IMDb id -> Cinemeta title -> binary search over the sorted index (kept as one buffer, ~500 MB RSS),
  with and without a leading "the"; movies must match the year, series drop releases naming another season
  -> one round of TorBox cache checks with file lists (at most 5 parallel calls), cached per hash for 10 min and
  shared across users and episodes. Up to 25 streams at 2160p and 15 at 1080p, spare slots to the next best,
  listed by resolution, then source, then size.
- **Play:** `/play` reuses the item if it's already in the user's library, otherwise adds it only if cached, then
  redirects to the TorBox link (reused for 5 min).

## Data sharing

The configure page only issues an install link after the user accepts a consent that lists exactly what is shared.
Consent is encoded in the install URL (`base64url({"key", "contribute": true})`); bare-key installs never contribute.

For consenting users, a stream request triggers a background copy of their TorBox torrents and web downloads, at
most once per 6 hours (Redis `SET NX EX` claim, shared across restarts and instances) and at most 3 copies at once.
Each finished item is written to `hashlib` in MyTorbox's shape, `lowercase hash -> {name, size, files, url}` (`url`
only for web downloads), deduplicated by hash and skipped when already identical. No key, email, `auth_id` or IP
is stored. Without `REDIS_URL` on the server, nothing is collected.

## Setup

1. Make a key and add the Actions secrets: `openssl rand -base64 32` is `INDEX_KEY`; `gh secret set INDEX_KEY` and
   `gh secret set REDIS_URL`.
2. Run **Build index** once (Actions → Build index → Run workflow), then schedule it (see above).
3. Deploy the server with `INDEX_REPO=<owner>/hashbolt`, the same `INDEX_KEY`, and `REDIS_URL`. `GITHUB_TOKEN` is
   optional: it lifts the API rate limit, and is needed only if the repo is private.

```sh
cp .env.example .env
npm start                # http://localhost:7001/configure
```

```sh
docker build -t hashbolt .
docker run -d --name hashbolt -p 7001:7001 -v hashbolt:/data --env-file .env hashbolt
```

Stremio needs HTTPS for remote addons: run it behind a reverse proxy, sending `X-Forwarded-Proto` (and
`X-Forwarded-Prefix` if it is mounted under a path), or set `BASE_URL`.
With `BETA_URL` (the homelab beta portal), each stream request and play is reported there with the viewer's IP and
the install's beta account: the `X-Beta-User` header the homelab's nginx sets on a tester's `/hb/u/<token>/` route, else `user` in the config. A revoked account gets no streams and no plays.
Without `INDEX_REPO` the server serves a local `data.tsv`, built with `npm run build` (`HASHLISTS_DIR` = a hashlists clone).

## Endpoints

| Path | |
|---|---|
| `/configure` | install page |
| `/:config/manifest.json` | addon manifest |
| `/:config/stream/:type/:id.json` | cached streams |
| `/:config/play/:hash[/:season/:episode]` | resolve and redirect to the TorBox link |
| `/health` | index size; 503 until loaded |
