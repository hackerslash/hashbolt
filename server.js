const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const PORT = process.env.PORT || 7001;
const BASE_URL = process.env.BASE_URL?.replace(/\/$/, '');
const INDEX_REPO = process.env.INDEX_REPO;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.tsv');
const TB = 'https://api.torbox.app/v1/api';
const VIDEO = /\.(mkv|mp4|avi|mov|m4v|ts|webm|wmv)$/i;
const MAX_STREAMS = 40;

const norm = s => s.replace(/^(\s*\[[^\]]*\]|\s*www\.\S+\s*-)+/, '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const epRe = (s, e) => new RegExp(`(s0*${+s}[ ._-]*e0*${+e}|\\b0*${+s}x0*${+e})(?!\\d)`, 'i');
const biggest = a => a.sort((x, y) => y.size - x.size)[0];
// Streams list by resolution, then source (REMUX > BluRay > WEB-DL > WEBRip > HDTV > other), then size.
const RES = { '2160P': 4, '1080P': 3, '720P': 2, '480P': 1 };
const SOURCES = [/remux/i, /blu-?ray|bdrip|brrip/i, /web[ .-]?dl|\bweb\b/i, /webrip/i, /hdtv/i];
const source = name => { const i = SOURCES.findIndex(q => q.test(name)); return i < 0 ? 0 : SOURCES.length - i; };
const byQuality = (a, b) => (RES[b.res] || 0) - (RES[a.res] || 0) || b.q - a.q || b.size - a.size;
// Episode: the file matching SxxEyy (or the only video of a single-episode torrent). Movie: the biggest video,
// preferring files with the release year so a multi-movie pack yields the right film.
const pick = (files, name, ep, year) => {
  const v = files.filter(f => VIDEO.test(f.name));
  if (ep) return biggest(v.filter(f => ep.test(f.name))) || (ep.test(name) ? biggest(v) : undefined);
  const dated = year ? v.filter(f => path.basename(f.name).includes(year)) : [];
  return biggest(dated.length ? dated : v);
};

// data.tsv lines are "normkey \t name \t hash \t bytes [\t url]", pre-sorted by build.js. '\t' sorts below
// every key char, so line order equals key order and title lookup is a binary-searched prefix scan.
// The file stays one Buffer with line offsets (a quarter of the memory of 1.4M strings); lines decode on demand.
let db = { buf: Buffer.alloc(0), offs: new Uint32Array([0]) }, urls = new Map();
const kind = h => h.length === 40 ? 'torrents' : 'webdl';
const count = () => db.offs.length - 1;
const line = ({ buf, offs }, i) => buf.toString('utf8', offs[i], offs[i + 1] - 1);
function load() {
  const buf = fs.readFileSync(DATA);
  const starts = [0];
  for (let pos = buf.indexOf(10); pos !== -1; pos = buf.indexOf(10, pos + 1)) starts.push(pos + 1);
  starts.push(buf.length + 1);
  const next = { buf, offs: Uint32Array.from(starts) };
  const u = new Map();
  for (let pos = buf.indexOf('\thttp'); pos !== -1; pos = buf.indexOf('\thttp', pos + 1)) {
    const { offs } = next;
    let lo = 0, hi = offs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (offs[m] <= pos) lo = m; else hi = m - 1; }
    const [, , h, , url] = line(next, lo).split('\t');
    if (url) u.set(h, url);
  }
  db = next;
  urls = u;
  console.log('loaded', count(), 'entries,', urls.size, 'webdl');
}
function prefix(p) {
  const d = db, n = d.offs.length - 1;
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (line(d, m) < p) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < n; i++) {
    const l = line(d, i);
    if (!l.startsWith(p)) break;
    const [k, nm, h, b] = l.split('\t');
    out.push({ k, n: nm, h, b: +b });
  }
  return out;
}

// The index is built by GitHub Actions and published as the `data.tsv.gz` asset of release `index` on INDEX_REPO.
// Polling costs one API call; the asset is only downloaded when it changed.
// The loaded release version is saved beside the data so a restart doesn't re-download an unchanged index.
let busy = false, version = null;
try { version = fs.readFileSync(DATA + '.version', 'utf8'); } catch {}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const headers = { 'User-Agent': 'hashbolt', ...(process.env.GITHUB_TOKEN && { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN }) };
    const rel = await (await get(`https://api.github.com/repos/${INDEX_REPO}/releases/tags/index`, { headers })).json();
    const a = rel.assets?.find(x => x.name === 'data.tsv.gz');
    if (!a) throw new Error('no index asset: ' + (rel.message || 'missing'));
    if (a.updated_at !== version) {
      const r = await fetch(a.url, { headers: { ...headers, Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(10 * 60e3) });
      if (!r.ok) throw new Error('index download: HTTP ' + r.status);
      await pipeline(Readable.fromWeb(r.body), zlib.createGunzip(), fs.createWriteStream(DATA + '.tmp'));
      fs.renameSync(DATA + '.tmp', DATA);
      load();
      version = a.updated_at;
      fs.writeFileSync(DATA + '.version', version);
    }
  } catch (e) { console.error('refresh failed:', e.message); }
  busy = false;
}

// ponytail: cap-and-clear caches, swap for an LRU if hit rates matter
function memo(map, key, ttl, fn) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  if (map.size >= 20000) map.clear();
  const v = fn().catch(e => { map.delete(key); throw e; });
  map.set(key, { t: Date.now(), v });
  return v;
}
const get = (url, opts = {}, ms = 15000) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) })
  .catch(e => { throw new Error(`${new URL(url).host}: ${e.message}`); });

// Cinemeta is occasionally slow or returns 504s: short timeout, one retry, and only titles get cached.
const metas = new Map();
const meta = (type, id) => memo(metas, id, 24 * 3600e3, async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await get(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, {}, 5000);
      if (!r.ok) throw new Error('Cinemeta HTTP ' + r.status);
      const m = (await r.json()).meta;
      if (!m?.name) throw new Error('Cinemeta has no title for ' + id);
      return m;
    } catch (e) { if (attempt) throw e; }
  }
});

async function tb(key, p, opts = {}) {
  const r = await get(TB + p, { ...opts, headers: { Authorization: 'Bearer ' + key } });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`TorBox ${p.split('?')[0]}: ${j.detail || j.error || r.status}`);
  return j.data;
}
// ponytail: per-instance limits, move to Redis if instances multiply
function limiter(n) {
  let running = 0;
  const waiting = [];
  return async fn => {
    if (running < n) running++; else await new Promise(r => waiting.push(r));
    try { return await fn(); } finally { const next = waiting.shift(); next ? next() : running--; }
  };
}
const checkSlot = limiter(8);

// TorBox's cache is global, so each hash's answer is shared by every user for 10 min, and requests in flight are
// shared too. Two layers: `present` asks only whether hashes are cached (small responses); `listed` fetches file
// lists, which are large, and is only asked about hashes already known to be cached.
const checks = new Map(), lists = new Map();
function batchInto(map, key, hashes, url) {
  if (map.size > 50000) map.clear();
  const now = Date.now();
  const todo = hashes.filter(h => !(now - map.get(h)?.t < 10 * 60e3));
  for (const k of ['torrents', 'webdl']) {
    const hs = todo.filter(h => kind(h) === k);
    for (let i = 0; i < hs.length; i += 100) {
      const batch = hs.slice(i, i + 100);
      const req = checkSlot(() => tb(key, url(k, batch)));
      for (const h of batch) map.set(h, { t: now, p: req.then(d => d?.[h] || null)
        .catch(e => { map.delete(h); throw e; }) });
    }
  }
  return Promise.all(hashes.map(h => map.get(h).p));
}
const present = (key, hashes) => batchInto(checks, key, hashes,
  (k, b) => `/${k}/checkcached?format=object&hash=${b.join(',')}`);
const listed = (key, hashes) => batchInto(lists, key, hashes,
  (k, b) => `/${k}/checkcached?format=object&list_files=true&hash=${b.join(',')}`)
  .then(es => Object.fromEntries(hashes.flatMap((h, i) => {
    const files = (es[i]?.files || []).filter(f => VIDEO.test(f.name));
    return files.length ? [[h, files]] : [];
  })));

async function find(key, type, imdb, s, e) {
  const m = await meta(type, imdb);
  const title = norm(m.name);
  let cands = prefix(title + ' '), y;
  if (type === 'movie') {
    y = +String(m.year || m.releaseInfo || '').slice(0, 4);
    if (y) cands = cands.filter(r => { const yr = r.k.slice(title.length).match(/\b(19|20)\d\d\b/); return yr && Math.abs(yr[0] - y) <= 1; });
  } else {
    cands = cands.filter(r => { const x = r.k.match(/\bs(\d+) ?e(\d+)\b/); return !x || (+x[1] === +s && +x[2] === +e); });
  }
  // Biggest first: presence (small responses, no file lists) for all chunks runs concurrently,
  // then file lists are fetched only for the first ~20 cached hashes, in chunk order. A popular
  // title answers with ~5 small calls + 1 file-list call instead of ~5 full file-list calls.
  // ponytail: page through TorBox if long-running shows lose results past the 500 cap
  // ponytail: cap at 500 biggest candidates, page through TorBox if long-running shows lose results
  cands = cands.sort((a, b) => b.b - a.b).slice(0, 500);
  // A shared check may have run on another user's failing key; retry once on our own.
  const retry = fn => fn().catch(() => fn());
  const pres = await retry(() => present(key, cands.map(r => r.h)));
  const hits = cands.filter((r, i) => pres[i]);
  // File lists go biggest-first, a window at a time, until MAX_STREAMS resolve. A hit can still fail to resolve
  // (a season pack without the episode), so the next window picks up where this one stopped.
  const ep = s && epRe(s, e);
  const out = [];
  for (let i = 0; i < hits.length && out.length < MAX_STREAMS;) {
    const win = hits.slice(i, i + MAX_STREAMS - out.length);
    i += win.length;
    const c = await retry(() => listed(key, win.map(r => r.h)));
    for (const r of win) {
      const f = c[r.h] && pick(c[r.h], r.n, ep, y);
      const res = ((r.n + ' ' + f?.name).match(/\b(2160p|4k|1080p|720p|480p)\b/i) || ['SD'])[0].toUpperCase();
      if (f) out.push({ ...r, file: path.basename(f.name), size: f.size, res: res === '4K' ? '2160P' : res, q: source(r.n + ' ' + f.name) });
    }
  }
  return out.sort(byQuality);
}

// Pages through a TorBox list like MyTorbox (1000 per page, up to 50 pages); with `match`, stops at the first hit.
async function mylist(key, k, { match, fresh = true } = {}) {
  const all = [];
  for (let page = 0; page < 50; page++) {
    const items = await tb(key, `/${k}/mylist?bypass_cache=${fresh}&limit=1000&offset=${page * 1000}`) || [];
    if (match) { const hit = items.find(match); if (hit) return hit; } else all.push(...items);
    if (items.length < 1000) break;
  }
  return match ? undefined : all;
}

// Opted-in libraries go into the same Redis `hashlib` as MyTorbox, in its entry shape:
// lowercase hash -> {name, size, files, url (webdl only)}. A webdl hash is md5(original_url), and TorBox claims a
// cached webdl from that URL even after it expires. Nothing identifying is kept (no key, auth_id or IP), and keys
// are never stored: a library is read at most every 6h, only while its owner's Stremio is calling us.
let redis;
const polled = new Map();
const COPY_EVERY = 6 * 3600;

const copySlot = limiter(3);

const entry = (k, t) => JSON.stringify({ name: t.name, size: t.size,
  files: (t.files || []).map(f => f.short_name || f.name).filter(Boolean), ...(k === 'webdl' && { url: t.original_url }) });
function contribute(key) {
  const id = crypto.createHash('sha256').update(key).digest('hex');
  // The local map only saves a Redis round trip; the Redis claim is what holds across restarts and instances.
  if (!process.env.REDIS_URL || Date.now() - (polled.get(id) || 0) < COPY_EVERY * 1e3) return;
  if (polled.size >= 20000) polled.clear();
  polled.set(id, Date.now());
  redis ||= new (require('ioredis'))(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const claim = 'hashbolt:polled:' + id;
  (async () => {
    if (await redis.set(claim, '1', 'EX', COPY_EVERY, 'NX') !== 'OK') return;
    // A failed copy releases its claim so the next stream request retries instead of waiting 6h.
    await copySlot(() => copy(key)).catch(async e => { polled.delete(id); await redis.del(claim); throw e; });
  })().catch(e => console.error('contribute failed:', e.message));
}

async function copy(key) {
  // Map dedupes repeats within a library; comparing against Redis skips entries that are already identical.
  const fresh = new Map();
  for (const k of ['torrents', 'webdl'])
    for (const t of await mylist(key, k, { fresh: false }))
      // Incomplete items have size -1 and no files and would overwrite a complete entry.
      if (t.hash && t.files?.length && (k === 'torrents' || t.original_url)) fresh.set(String(t.hash).toLowerCase(), entry(k, t));
  const hs = [...fresh.keys()];
  for (let i = 0; i < hs.length; i += 1000) {
    const chunk = hs.slice(i, i + 1000), old = await redis.hmget('hashlib', ...chunk);
    const changed = chunk.flatMap((h, j) => old[j] === fresh.get(h) ? [] : [h, fresh.get(h)]);
    if (changed.length) await redis.hset('hashlib', ...changed);
  }
}

// Install URL segment: base64url JSON {key, contribute}. A bare key (pre-consent installs) never contributes.
function config(seg) {
  try { const c = JSON.parse(Buffer.from(seg, 'base64url').toString()); if (/^[\w-]+$/.test(c?.key)) return c; } catch {}
  return /^[\w-]+$/.test(seg) ? { key: seg } : null;
}

async function streams(key, seg, type, id, base) {
  const [imdb, s, e] = id.split(':');
  const ep = type === 'series';
  if (!/^tt\d+$/.test(imdb) || (ep && !(/^\d+$/.test(s) && /^\d+$/.test(e)))) return [];
  return (await find(key, type, imdb, ep ? s : '', ep ? e : '')).map(r => ({
    name: (r.h.length === 40 ? 'Hashbolt ⚡\n' : 'Hashbolt 🌐⚡\n') + r.res,
    description: `${r.n}${ep ? '\n' + r.file : ''}\n💾 ${(r.size / 1e9).toFixed(2)} GB`,
    url: `${base}/${seg}/play/${r.h}/${encodeURIComponent(r.file)}`,
    behaviorHints: { bingeGroup: 'hashbolt-' + r.res, filename: r.file, videoSize: r.size },
  }));
}

// Players often request a stream URL twice at once; share one resolve and reuse the link for 5 min.
const links = new Map();
const link = (key, hash, file) => memo(links, `${key}:${hash}:${file}`, 5 * 60e3, () => play(key, hash, file));

// `file` is the basename chosen when the stream was listed, so playback opens exactly what was shown.
async function play(key, hash, file) {
  const k = kind(hash), web = k === 'webdl';
  let t = await mylist(key, k, { match: x => String(x.hash).toLowerCase() === hash });
  if (!t) {
    const fd = new FormData();
    if (web) {
      if (!urls.has(hash)) throw new Error('unknown web download');
      fd.append('link', urls.get(hash));
    } else fd.append('magnet', 'magnet:?xt=urn:btih:' + hash);
    fd.append('add_only_if_cached', 'true');
    const d = await tb(key, web ? '/webdl/createwebdownload' : '/torrents/createtorrent', { method: 'POST', body: fd });
    t = await tb(key, `/${k}/mylist?bypass_cache=true&id=${d.torrent_id ?? d.webdownload_id}`);
  }
  const f = (t.files || []).find(x => path.basename(x.name) === file) || pick(t.files || [], t.name);
  if (!f) throw new Error('no matching video file');
  return tb(key, `/${k}/requestdl?token=${key}&${web ? 'web_id' : 'torrent_id'}=${t.id}&file_id=${f.id}`);
}

const manifest = {
  id: 'community.hashbolt', version: '1.0.1', name: 'Hashbolt',
  description: 'Instant TorBox-cached streams from the DMM hashlists. Only shows what plays right away.',
  resources: ['stream'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: true },
};
const CONFIGURE = fs.readFileSync(path.join(__dirname, 'configure.html'), 'utf8');
const LOGO = fs.readFileSync(path.join(__dirname, 'logo.png'));

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type === 'image/png' ? type : type + '; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// Behind a proxy that mounts us under a path, X-Forwarded-Prefix names it, so every URL we hand out (stream and
// play links, the logo, the configure page's own calls) carries it. Header values are checked because they end up
// in that page.
function origin(req) {
  const proto = req.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https' ? 'https' : 'http';
  const host = /^[\w.-]+(:\d+)?$/.test(req.headers.host || '') ? req.headers.host : 'localhost';
  const prefix = req.headers['x-forwarded-prefix'] || '';
  return `${proto}://${host}${/^(\/[\w.-]+)+$/.test(prefix) ? prefix : ''}`;
}

const server = http.createServer(async (req, res) => {
  const base = BASE_URL || origin(req);
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (!p.length || p.at(-1) === 'configure') return send(res, 200, CONFIGURE.replaceAll('__BASE__', base), 'text/html');
    if (p[0] === 'logo.png') return send(res, 200, LOGO, 'image/png');
    const withLogo = { ...manifest, logo: base + '/logo.png' };
    if (p[0] === 'manifest.json') return send(res, 200, withLogo);
    if (p[0] === 'health') return send(res, count() ? 200 : 503, { entries: count(), webdl: urls.size, refreshing: busy });
    if (p[0] === 'api' && p[1] === 'validate') {
      const key = url.searchParams.get('key') || '';
      if (!/^[\w-]+$/.test(key)) return send(res, 200, { valid: false, detail: 'Malformed key' });
      const me = await tb(key, '/user/me').catch(() => null);
      return send(res, 200, me ? { valid: true, detail: `Valid · ${me.email}` } : { valid: false, detail: 'TorBox rejected this key' });
    }
    const [seg, route, ...rest] = p;
    const cfg = config(seg);
    if (!cfg) return send(res, 400, { error: 'bad config' });
    const { key } = cfg;
    if (route === 'manifest.json') return send(res, 200, { ...withLogo, behaviorHints: { configurable: true } });
    if (route === 'stream' && rest.length === 2 && ['movie', 'series'].includes(rest[0])) {
      if (cfg.contribute === true) contribute(key);
      const list = await streams(key, seg, rest[0], rest[1].replace(/\.json$/, ''), base).catch(e => (console.error(e.message), []));
      return send(res, 200, { streams: list });
    }
    if (route === 'play' && rest.length === 2 && /^([a-f0-9]{40}|[a-f0-9]{32})$/i.test(rest[0])) {
      res.writeHead(302, { Location: await link(key, rest[0].toLowerCase(), rest[1]) });
      return res.end();
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  if (fs.existsSync(DATA)) load();
  server.listen(PORT, () => console.log(`Hashbolt on http://localhost:${PORT}/configure`));
  if (INDEX_REPO) {
    refresh();
    setInterval(refresh, 10 * 60e3);
  } else console.log('INDEX_REPO not set: serving local data.tsv only (run `npm run build` to rebuild it)');
}
module.exports = { norm, epRe, pick, config, limiter, load, prefix, webUrl: h => urls.get(h), find, source, byQuality };
