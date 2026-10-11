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

const norm = s => s.replace(/^(\s*\[[^\]]*\]|\s*www\.\S+\s*-)+/, '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const epRe = (s, e) => new RegExp(`(s0*${+s}[ ._-]*e0*${+e}|\\b0*${+s}x0*${+e})(?!\\d)`, 'i');
const biggest = a => a.sort((x, y) => y.size - x.size)[0];
const pick = (files, name, ep) => {
  const v = files.filter(f => VIDEO.test(f.name));
  return ep ? biggest(v.filter(f => ep.test(f.name))) || (ep.test(name) ? biggest(v) : undefined) : biggest(v);
};

// data.tsv lines are "normkey \t name \t hash \t bytes [\t url]", pre-sorted by build.js. '\t' sorts below
// every key char, so line order equals key order and title lookup is a binary-searched prefix scan.
let db = [], urls = new Map();
const kind = h => h.length === 40 ? 'torrents' : 'webdl';
function load() {
  const lines = fs.readFileSync(DATA, 'utf8').split('\n');
  const u = new Map();
  for (const l of lines) if (l.includes('\thttp')) { const [, , h, , url] = l.split('\t'); if (url) u.set(h, url); }
  db = lines;
  urls = u;
  console.log('loaded', db.length, 'entries,', urls.size, 'webdl');
}
function prefix(p) {
  const rows = db;
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m] < p) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < rows.length && rows[i].startsWith(p); i++) {
    const [k, n, h, b] = rows[i].split('\t');
    out.push({ k, n, h, b: +b });
  }
  return out;
}

// The index is built by GitHub Actions and published as the `data.tsv.gz` asset of release `index` on INDEX_REPO.
// Polling costs one API call; the asset is only downloaded when it changed.
let busy = false, version = null;
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
const get = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });

const metas = new Map();
const meta = (type, id) => memo(metas, id, 24 * 3600e3, () =>
  get(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`).then(r => r.json()).then(j => j.meta));

async function tb(key, p, opts = {}) {
  const r = await get(TB + p, { ...opts, headers: { Authorization: 'Bearer ' + key } });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`TorBox ${p.split('?')[0]}: ${j.detail || j.error || r.status}`);
  return j.data;
}
async function cached(key, hashes) {
  const parts = [];
  for (const k of ['torrents', 'webdl']) {
    const hs = hashes.filter(h => kind(h) === k);
    for (let i = 0; i < hs.length; i += 100)
      parts.push(tb(key, `/${k}/checkcached?format=object&list_files=true&hash=${hs.slice(i, i + 100).join(',')}`));
  }
  return Object.assign({}, ...await Promise.all(parts));
}

// TorBox's cache is global, so lookups are shared across users; only the play URLs carry a key.
const found = new Map();
const find = (key, type, imdb, s, e) => memo(found, `${imdb}:${s}:${e}`, 10 * 60e3, async () => {
  const m = await meta(type, imdb);
  if (!m?.name) return [];
  const title = norm(m.name);
  let cands = prefix(title + ' ');
  if (type === 'movie') {
    const y = +String(m.year || m.releaseInfo || '').slice(0, 4);
    if (y) cands = cands.filter(r => { const yr = r.k.slice(title.length).match(/\b(19|20)\d\d\b/); return yr && Math.abs(yr[0] - y) <= 1; });
  } else {
    cands = cands.filter(r => { const x = r.k.match(/\bs(\d+) ?e(\d+)\b/); return !x || (+x[1] === +s && +x[2] === +e); });
  }
  // ponytail: cap at 500 biggest candidates, page through TorBox if long-running shows lose results
  cands = cands.sort((a, b) => b.b - a.b).slice(0, 500);
  const c = await cached(key, cands.map(r => r.h));
  const ep = s && epRe(s, e);
  const out = [];
  for (const r of cands) {
    const f = c[r.h] && pick(c[r.h].files || [], r.n, ep);
    if (f) out.push({ ...r, file: path.basename(f.name), size: f.size,
      res: ((r.n + ' ' + f.name).match(/\b(2160p|4k|1080p|720p|480p)\b/i) || ['SD'])[0].toUpperCase() });
  }
  return out.sort((a, b) => b.size - a.size);
});

// Pages through a TorBox list like MyTorbox (1000 per page, up to 50 pages); with `match`, stops at the first hit.
async function mylist(key, k, match) {
  const all = [];
  for (let page = 0; page < 50; page++) {
    const items = await tb(key, `/${k}/mylist?bypass_cache=true&limit=1000&offset=${page * 1000}`) || [];
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
const entry = (k, t) => JSON.stringify({ name: t.name, size: t.size,
  files: (t.files || []).map(f => f.short_name || f.name).filter(Boolean), ...(k === 'webdl' && { url: t.original_url }) });
function contribute(key) {
  const id = crypto.createHash('sha256').update(key).digest('hex');
  if (!process.env.REDIS_URL || Date.now() - (polled.get(id) || 0) < 6 * 3600e3) return;
  if (polled.size >= 20000) polled.clear();
  polled.set(id, Date.now());
  redis ||= new (require('ioredis'))(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
  (async () => {
    // Map dedupes repeats within a library; comparing against Redis skips entries that are already identical.
    const fresh = new Map();
    for (const k of ['torrents', 'webdl'])
      for (const t of await mylist(key, k))
        // Incomplete items have size -1 and no files and would overwrite a complete entry.
        if (t.hash && t.files?.length && (k === 'torrents' || t.original_url)) fresh.set(String(t.hash).toLowerCase(), entry(k, t));
    const hs = [...fresh.keys()];
    for (let i = 0; i < hs.length; i += 1000) {
      const chunk = hs.slice(i, i + 1000), old = await redis.hmget('hashlib', ...chunk);
      const changed = chunk.flatMap((h, j) => old[j] === fresh.get(h) ? [] : [h, fresh.get(h)]);
      if (changed.length) await redis.hset('hashlib', ...changed);
    }
  })().catch(e => console.error('contribute failed:', e.message));
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
    url: `${base}/${seg}/play/${r.h}${ep ? `/${s}/${e}` : ''}`,
    behaviorHints: { bingeGroup: 'hashbolt-' + r.res, filename: r.file, videoSize: r.size },
  }));
}

async function play(key, hash, s, e) {
  const k = kind(hash), web = k === 'webdl';
  let t = await mylist(key, k, x => String(x.hash).toLowerCase() === hash);
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
  const f = pick(t.files || [], t.name, s && epRe(s, e));
  if (!f) throw new Error('no matching video file');
  return tb(key, `/${k}/requestdl?token=${key}&${web ? 'web_id' : 'torrent_id'}=${t.id}&file_id=${f.id}`);
}

const manifest = {
  id: 'community.hashbolt', version: '1.0.0', name: 'Hashbolt',
  description: 'Instant TorBox-cached streams from the DMM hashlists. Only shows what plays right away.',
  resources: ['stream'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: true },
};
const CONFIGURE = fs.readFileSync(path.join(__dirname, 'configure.html'), 'utf8');

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const base = BASE_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (!p.length || p.at(-1) === 'configure') return send(res, 200, CONFIGURE, 'text/html');
    if (p[0] === 'manifest.json') return send(res, 200, manifest);
    if (p[0] === 'health') return send(res, db.length ? 200 : 503, { entries: db.length, webdl: urls.size, refreshing: busy });
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
    if (route === 'manifest.json') return send(res, 200, { ...manifest, behaviorHints: { configurable: true } });
    if (route === 'stream' && rest.length === 2 && ['movie', 'series'].includes(rest[0])) {
      if (cfg.contribute === true) contribute(key);
      const list = await streams(key, seg, rest[0], rest[1].replace(/\.json$/, ''), base).catch(e => (console.error(e.message), []));
      return send(res, 200, { streams: list });
    }
    if (route === 'play' && /^([a-f0-9]{40}|[a-f0-9]{32})$/i.test(rest[0]) && rest.slice(1).every(x => /^\d+$/.test(x))) {
      res.writeHead(302, { Location: await play(key, rest[0].toLowerCase(), rest[1], rest[2]) });
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
module.exports = { norm, epRe, pick, config };
