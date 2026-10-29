const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { open } = require('./seal');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const PORT = process.env.PORT || 7001;
const BASE_URL = process.env.BASE_URL?.replace(/\/$/, '');
const BETA_URL = process.env.BETA_URL?.replace(/\/$/, '');
const INDEX_REPO = process.env.INDEX_REPO;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.tsv');
const TB = 'https://api.torbox.app/v1/api';
const VIDEO = /\.(mkv|mp4|avi|mov|m4v|ts|webm|wmv)$/i;
// Up to 25 at 2160p and 15 at 1080p so slower connections get smaller files; slots a title can't fill at
// those resolutions go to the best of the rest, 40 in all.
const MAX_STREAMS = 40, QUOTA = { '2160P': 25, '1080P': 15 };

const SITE = /^(\s*\[[^\]]*\]|\s*www\.\S+\s*-)+/;
const norm = s => s.replace(SITE, '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
// How a release's name (past the title) fits season s, episode e: 0 names it (or a range or complete run holding it),
// 1 says nothing about seasons, -1 names another season or episode.
function seasonFit(rest, s, e) {
  const ep = rest.match(/\bs(\d+) ?e(\d+)(?: (?:s\d+ ?)?e(\d+))?\b/);
  if (ep) return +ep[1] === s && e >= +ep[2] && e <= +(ep[3] || ep[2]) ? 0 : -1;
  const range = rest.match(/\bs(\d+) s(\d+)\b|\bseasons? (\d+) (?:to )?(\d+)\b/);
  if (range) {
    const [a, b] = (range[1] ? range.slice(1, 3) : range.slice(3, 5)).map(Number);
    if (b >= a && b < 100) return s >= a && s <= b ? 0 : -1;
  }
  const named = [...rest.matchAll(/\bs(\d+)\b|\bseason (\d+)\b/g)].map(m => +(m[1] || m[2]));
  if (named.length) return named.includes(s) ? 0 : -1;
  return /\b(complete|collection|integral)\b/.test(rest) ? 0 : 1;
}
// A movie release names a year within one of y and no season ("3% (2011) S01"). A short title ("3", "Up") starts
// many others' names ("3 Day Test 2012", "Up in the Air 2009"), so only the year, an edition tag or a bracketed or
// dashed subtitle ("RRR (Rise Roar Revolt)", "Up - Altas Aventuras") may follow it.
function movieFit(r, title, y) {
  const yr = r.rest.match(/\b(19|20)\d\d\b/);
  if (!yr || Math.abs(yr[0] - y) > 1 || /\bs\d+ ?e\d+\b|\bseason \d+\b|\bs0\d\b/.test(r.rest)) return false;
  return title.length > 3 || /^ (?:a ?k ?a .*?|(?:(?:3d|1|extended|unrated|uncut|remastered|imax) )*)(?:19|20)\d\d\b/.test(r.rest)
    // "3 - Prometheus", "3.[FakeTaxi.com]": a number before " - " or "[" is a list index, not the title.
    || norm(r.n.replace(SITE, '').split(/^\d+$/.test(title) ? /\(/ : /\s-\s|[([]/)[0]) === title;
}
// norm drops non-Latin letters, so "Люди в черном 3.2012" would read as the film "3 2012" ("Аватар Avatar" is fine).
const foreign = name => /^[^\p{L}\p{N}]*[^\P{L}\p{sc=Latin}][^\p{sc=Latin}\p{N}]*\p{N}/u.test(name.replace(SITE, ''));
const epRe = (s, e) => new RegExp(`(s0*${+s}[ ._-]*e0*${+e}|\\b0*${+s}x0*${+e})(?!\\d)`, 'i');
const biggest = a => a.sort((x, y) => y.size - x.size)[0];
// Streams list by resolution, then source (REMUX > BluRay > WEB-DL > WEBRip > HDTV > other), then size.
const RES = { '2160P': 4, '1080P': 3, '720P': 2, '480P': 1 };
const SOURCES = [/remux/i, /blu-?ray|bdrip|brrip/i, /web[ .-]?dl|\bweb\b/i, /webrip/i, /hdtv/i];
const source = name => { const i = SOURCES.findIndex(q => q.test(name)); return i < 0 ? 0 : SOURCES.length - i; };
const resolution = text => {
  const r = (text.match(/\b(2160p|4k|1080p|720p|480p)\b/i) || ['SD'])[0].toUpperCase();
  return r === '4K' ? '2160P' : r;
};
// A file's own tags win over its pack's; the pack fills in what the file name leaves out.
const rate = (file, pack) => ({ res: resolution(file + ' ' + pack), q: source(file) || source(pack) });
const byQuality = (a, b) => (RES[b.res] || 0) - (RES[a.res] || 0) || b.q - a.q || b.size - a.size;

// What a release name states, shown in this order: per group, the first label whose pattern matches. Whole words on
// the left only: "DDP5.1" and "AAC2.0" run a digit on. Same table as the LinkGenie addon's engine.facts.
const word = p => new RegExp(`(?<![a-z0-9])(?:${p})(?![a-z])`);
const FACTS = {
  video: [[['Remux', 'remux']],
    [['BluRay', 'blu[ .-]?ray|bdrip|brrip|bd'], ['WEB-DL', 'web[ .-]?dl'], ['WEBRip', 'web[ .-]?rip'], ['HDRip', 'hdrip'],
      ['HDTV', 'hdtv'], ['DVDRip', 'dvd[ .-]?rip'], ['CAM', 'cam|camrip|hdcam|hdts|telesync']],
    [['HEVC', 'x265|h[ .]?265|hevc'], ['AVC', 'x264|h[ .]?264|avc'], ['AV1', 'av1']],
    [['DV', 'dv|dovi|dolby[ .]?vision']], [['HDR10+', 'hdr10\\+|hdr10plus'], ['HDR', 'hdr10|hdr']], [['10bit', '10[ .-]?bit']]],
  audio: [[['TrueHD', 'truehd'], ['DTS-HD MA', 'dts[ .-]?hd[ .-]?ma|dts[ .-]?hdma'], ['DTS:X', 'dts[ .:-]?x'], ['DTS', 'dts'],
    ['DD+', 'ddpa?|dd\\+|e[ .-]?ac[ .-]?3'], ['DD', 'dd|ac3'], ['AAC', 'aac'], ['FLAC', 'flac'], ['Opus', 'opus']],
    [['Atmos', 'atmos']]],
};
const LANGS = ['Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Bengali', 'Marathi', 'Punjabi', 'Gujarati',
  'Urdu', 'Japanese', 'Korean', 'Chinese', 'Spanish', 'French', 'German', 'Italian', 'Russian', 'Multi', 'Dual'];
function facts(file, name = '') {
  const n = `${file} ${name}`.toLowerCase().replace(/_/g, ' ');
  const pick1 = groups => groups.map(g => g.find(([, p]) => word(p).test(n))?.[0]).filter(Boolean);
  const audio = pick1(FACTS.audio);
  const ch = [...n.matchAll(/(?<![0-9])([257])[ .]([01])(?![0-9])/g)].map(m => `${m[1]}.${m[2]}`).sort().pop();
  if (ch) audio.push(ch);  // several tracks: the most channels
  const langs = LANGS.filter(l => word(l.toLowerCase()).test(n)).sort((a, b) => n.indexOf(a.toLowerCase()) - n.indexOf(b.toLowerCase()));
  const box = file.match(/\.(mkv|mp4|avi|m2ts|webm)$/i);
  return [[...(box ? [box[1].toUpperCase()] : []), ...pick1(FACTS.video)], [...audio, ...langs]];
}
const gb = n => n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(2)} GB` : `${Math.round(n / 2 ** 20)} MB`;
// One fact per line, as the LinkGenie addon writes them; a pack's own name only when the file is one of its episodes.
function describe(r, ep) {
  const [video, audio] = facts(r.file, r.n), res = r.res === 'SD' ? [] : [r.res.toLowerCase()];
  return [['📄', r.file], ['📦', ep && r.n !== r.file ? r.n : ''], ['🎞️', [...res, ...video].join(' • ')],
    ['🔊', audio.join(' • ')], ['💾', r.size ? gb(r.size) : ''], ['📡', r.h.length === 40 ? 'TorBox cached' : 'TorBox web download']]
    .filter(([, t]) => t).map(([m, t]) => `${m} ${t}`).join('\n');
}
// Episode: the file matching SxxEyy (or the only video of a single-episode torrent). Movie: the biggest video,
// preferring files with the release year so a multi-movie pack yields the right film.
const pick = (files, name, ep, year) => {
  const v = files.filter(f => VIDEO.test(f.name));
  if (ep) return biggest(v.filter(f => ep.test(f.name))) || (ep.test(name) ? biggest(v) : undefined);
  const dated = year ? v.filter(f => path.basename(f.name).includes(year)) : [];
  return biggest(dated.length ? dated : v);
};

// data.tsv lines are "normkey \t name \t hash \t bytes [\t url]", sorted by build.js. '\t' sorts below every key
// character, so line order is key order and a title lookup is a binary-searched prefix scan. The file is kept as one
// Buffer plus line offsets, a quarter of the memory of 1.4M strings.
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

// GitHub Actions publishes the index sealed (seal.js) as `data.tsv.gz.enc` on INDEX_REPO's `index` release. A poll is
// one API call; the asset is downloaded only when its version changed, and the version is saved so restarts skip it.
let busy = false, version = null;
try { version = fs.readFileSync(DATA + '.version', 'utf8'); } catch {}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const headers = { 'User-Agent': 'hashbolt', ...(process.env.GITHUB_TOKEN && { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN }) };
    const rel = await (await get(`https://api.github.com/repos/${INDEX_REPO}/releases/tags/index`, { headers })).json();
    const a = rel.assets?.find(x => x.name === 'data.tsv.gz.enc');
    if (!a) throw new Error('no index asset: ' + (rel.message || 'missing'));
    if (a.updated_at !== version) {
      const r = await fetch(a.url, { headers: { ...headers, Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(10 * 60e3) });
      if (!r.ok) throw new Error('index download: HTTP ' + r.status);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(DATA + '.enc'));
      await open(DATA + '.enc', DATA + '.tmp');
      fs.renameSync(DATA + '.tmp', DATA);
      fs.rmSync(DATA + '.enc');
      load();
      version = a.updated_at;
      fs.writeFileSync(DATA + '.version', version);
    }
  } catch (e) { console.error('refresh failed:', e.message); }
  busy = false;
}

// Caches are cleared wholesale when full: no LRU bookkeeping, and enough at this scale.
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

// TMDB's titles too, through a keyless TMDB mirror (db.wecollege.net): Cinemeta and release names can spell one title
// differently ("Thanneermathan Dinangal" vs "Thanneer Mathan Dinangal"). Best effort: none when it doesn't answer.
const TMDB = 'https://db.wecollege.net/3';
const tmdbs = new Map();
const tmdbTitles = (type, id) => memo(tmdbs, id, 24 * 3600e3, async () => {
  const r = await get(`${TMDB}/find/${id}?external_source=imdb_id`, {}, 5000);
  if (!r.ok) throw new Error('TMDB HTTP ' + r.status);
  const d = await r.json(), m = (type === 'movie' ? d.movie_results : d.tv_results)?.[0] || {};
  return [m.title || m.name, m.original_title || m.original_name].filter(Boolean);
}).catch(() => []);

async function tb(key, p, opts = {}) {
  const r = await get(TB + p, { ...opts, headers: { Authorization: 'Bearer ' + key } });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`TorBox ${p.split('?')[0]}: ${j.detail || j.error || r.status}`);
  return j.data;
}
// Concurrency limits are per process.
function limiter(n) {
  let running = 0;
  const waiting = [];
  return async fn => {
    if (running < n) running++; else await new Promise(r => waiting.push(r));
    try { return await fn(); } finally { const next = waiting.shift(); next ? next() : running--; }
  };
}
const checkSlot = limiter(8);

// TorBox's cache is global, so each hash's answer (its video files, or none when uncached) is shared by every user
// for 10 min, and requests in flight are shared too: episodes of one show check each season pack once.
const checks = new Map();
async function cached(key, hashes) {
  if (checks.size > 50000) checks.clear();
  const now = Date.now();
  const todo = hashes.filter(h => !(now - checks.get(h)?.t < 10 * 60e3));
  for (const k of ['torrents', 'webdl']) {
    const hs = todo.filter(h => kind(h) === k);
    for (let i = 0; i < hs.length; i += 100) {
      const batch = hs.slice(i, i + 100);
      const req = checkSlot(() => tb(key, `/${k}/checkcached?format=object&list_files=true&hash=${batch.join(',')}`));
      for (const h of batch) checks.set(h, { t: now, p: req.then(d => (d?.[h]?.files || []).filter(f => VIDEO.test(f.name)))
        .catch(e => { checks.delete(h); throw e; }) });
    }
  }
  // Free plans can check torrents but not web downloads; that refusal mustn't drop the cached torrents.
  const files = await Promise.all(hashes.map(h => kind(h) === 'webdl' ? checks.get(h).p.catch(() => []) : checks.get(h).p));
  return Object.fromEntries(hashes.flatMap((h, i) => files[i].length ? [[h, files[i]]] : []));
}

async function find(key, type, imdb, s, e) {
  const [m, others] = await Promise.all([meta(type, imdb), tmdbTitles(type, imdb)]);
  // Each spelling, with and without a leading "the"; the year and season checks below keep strays out. A title in a
  // script norm drops ("തണ്ണീർ മത്തൻ ദിനങ്ങൾ") normalises to nothing and is skipped.
  const titles = [...new Set([m.name, ...others].map(norm).filter(Boolean))];
  const seen = new Map();
  for (const title of titles)
    for (const t of [title, title.startsWith('the ') ? title.slice(4) : 'the ' + title])
      for (const r of prefix(t + ' ')) if (!seen.has(r.h) && !foreign(r.n)) seen.set(r.h, { ...r, rest: r.k.slice(t.length), fit: 0, title });
  let cands = [...seen.values()], y;
  if (type === 'movie') {
    y = +String(m.year || m.releaseInfo || '').slice(0, 4);
    if (y) cands = cands.filter(r => movieFit(r, r.title, y));
  } else {
    cands = cands.map(r => ({ ...r, fit: seasonFit(r.rest, +s, +e) })).filter(r => r.fit >= 0);
  }
  // 500 candidates are checked: those naming the season first, then by size.
  cands = cands.sort((a, b) => a.fit - b.fit || b.b - a.b).slice(0, 500);
  // One round: file lists come back only for cached hashes, so a separate "is it cached" pass would only add a
  // round trip. A shared check may have run on another user's failing key; retry once on our own.
  const hs = cands.map(r => r.h);
  const c = await cached(key, hs).catch(() => cached(key, hs));
  const ep = s && epRe(s, e);
  const playable = cands.flatMap(r => {
    const f = c[r.h] && pick(c[r.h], r.n, ep, y);
    return f ? [{ ...r, file: path.basename(f.name), size: f.size, ...rate(path.basename(f.name), r.n) }] : [];
  }).sort(byQuality);
  // QUOTA per resolution first, then the best of the rest, MAX_STREAMS in all.
  const out = [], count = {}, taken = new Set();
  for (const capped of [true, false])
    for (const st of playable) {
      if (out.length >= MAX_STREAMS) break;
      if (taken.has(st) || (capped && (count[st.res] || 0) >= (QUOTA[st.res] || 0))) continue;
      taken.add(st);
      count[st.res] = (count[st.res] || 0) + 1;
      out.push(st);
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

// Consenting libraries are copied into MyTorbox's Redis `hashlib` in its entry shape: lowercase hash ->
// {name, size, files, url}. `url` (web downloads only) matters because a webdl hash is md5(original_url), and TorBox
// serves a cached webdl from that URL even after it expires. No key, auth_id or IP is stored.
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
    // Redis unreachable: nothing was claimed, so the next stream request tries again.
    const won = await redis.set(claim, '1', 'EX', COPY_EVERY, 'NX').catch(e => { polled.delete(id); throw e; });
    if (won !== 'OK') return;
    // A failed copy releases its claim so the next stream request retries instead of waiting 6h.
    await copySlot(() => copy(key)).catch(async e => { polled.delete(id); await redis.del(claim).catch(() => {}); throw e; });
  })().catch(e => console.error('contribute failed:', e.message));
}

async function copy(key) {
  // Map dedupes repeats within a library; comparing against Redis skips entries that are already identical.
  const fresh = new Map();
  for (const k of ['torrents', 'webdl'])
    for (const t of await mylist(key, k, { fresh: false }))
      // Incomplete items have size -1 and no files and would overwrite a complete entry; one still downloading is not
      // in TorBox's cache, so listing it would only cost every user a failed cache check.
      if (t.hash && t.files?.length && t.download_finished !== false && (k === 'torrents' || t.original_url))
        fresh.set(String(t.hash).toLowerCase(), entry(k, t));
  const hs = [...fresh.keys()];
  let written = 0;
  for (let i = 0; i < hs.length; i += 1000) {
    const chunk = hs.slice(i, i + 1000), old = await redis.hmget('hashlib', ...chunk);
    const changed = chunk.flatMap((h, j) => old[j] === fresh.get(h) ? [] : [h, fresh.get(h)]);
    if (changed.length) await redis.hset('hashlib', ...changed);
    written += changed.length / 2;
  }
  console.log(`contributed a library: ${hs.length} items, ${written} new or changed`);
}

// Install URL segment: base64url JSON {key, contribute, user?}. A bare key (pre-consent installs) never contributes.
// `user` is a beta-portal account token; without one, requests count as anonymous.
function config(seg) {
  try {
    const c = JSON.parse(Buffer.from(seg, 'base64url').toString());
    if (/^[\w-]+$/.test(c?.key)) { if (!/^[\w-]{8,64}$/.test(c.user)) delete c.user; return c; }
  } catch {}
  return /^[\w-]+$/.test(seg) ? { key: seg } : null;
}

// The beta portal (BETA_URL) gets one event per stream request and play. A revoked or unknown account gets no
// streams and no plays; the portal being down takes nothing away. Stream lists see a revoke within 30 s, plays
// check fresh so the lists Stremio already holds stop playing at once.
const actives = new Map();
const checkActive = async user => {
  const r = await get(`${BETA_URL}/check/${user}`, {}, 3000);
  return !r.ok || (await r.json()).active === true;
};
const active = (user, fresh) => !BETA_URL || !user ? Promise.resolve(true)
  : (fresh ? checkActive(user) : memo(actives, user, 30e3, () => checkActive(user))).catch(() => true);
// Only nginx (the tunnel) names a tester or a viewer's address: the LAN and tailnet port reaches Hashbolt directly,
// and a client there could otherwise claim any account or IP.
const lookups = new Map();
const nginxAt = () => memo(lookups, 'nginx', 60e3, () => dns.lookup('nginx').then(r => r.address)).catch(() => null);
const fromNginx = async req => {
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  if (peer === await nginxAt()) return true;
  lookups.delete('nginx');  // a recreated nginx has a new address: look again rather than distrust it for a minute
  return peer === await nginxAt();
};
// cloudflared puts the viewer's address in Cf-Connecting-Ip; on the LAN, nginx's X-Forwarded-For has it first.
const clientIp = req => (req.viaNginx && (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim()))
  || req.socket.remoteAddress;
function track(req, user, kind, ev) {
  if (!BETA_URL) return;
  fetch(BETA_URL + '/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ user, addon: 'hashbolt', kind, ip: clientIp(req), ...ev }) }).catch(e => console.error('beta event:', e.message));
}

async function streams(key, seg, type, id, base) {
  const [imdb, s, e] = id.split(':');
  const ep = type === 'series';
  if (!/^tt\d+$/.test(imdb) || (ep && !(/^\d+$/.test(s) && /^\d+$/.test(e)))) return [];
  return (await find(key, type, imdb, ep ? s : '', ep ? e : '')).map(r => ({
    name: (r.h.length === 40 ? 'Hashbolt ⚡ ' : 'Hashbolt 🌐⚡ ') + (r.res === 'SD' ? 'SD' : r.res.toLowerCase()),
    description: describe(r, ep),
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

// Every URL handed out carries the proxy's X-Forwarded-Prefix, if any. Headers are validated since they are
// written into the configure page.
function origin(req) {
  const proto = req.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https' ? 'https' : 'http';
  const host = /^[\w.-]+(:\d+)?$/.test(req.headers.host || '') ? req.headers.host : 'localhost';
  const prefix = req.headers['x-forwarded-prefix'] || '';
  return `${proto}://${host}${/^(\/[\w.-]+)+$/.test(prefix) ? prefix : ''}`;
}

const server = http.createServer(async (req, res) => {
  const base = BASE_URL || origin(req);
  try {
    req.viaNginx = await fromNginx(req);
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
    // On a tester's /hb/u/<token>/ link nginx names the account, checked by the portal before it got here; it wins
    // over whatever the install config claims.
    const beta = req.viaNginx && req.headers['x-beta-user'];
    if (/^[\w-]{8,64}$/.test(beta || '')) cfg.user = beta;
    if (route === 'manifest.json') return send(res, 200, { ...withLogo, behaviorHints: { configurable: true } });
    if (route === 'stream' && rest.length === 2 && ['movie', 'series'].includes(rest[0])) {
      if (!await active(cfg.user)) return send(res, 200, { streams: [], cacheMaxAge: 60 });
      if (cfg.contribute === true) contribute(key);
      const id = rest[1].replace(/\.json$/, ''), t0 = Date.now();
      let error;
      const list = await streams(key, seg, rest[0], id, base).catch(e => (console.error(e.message), error = e.message, []));
      // not awaited: with Cinemeta down, a second lookup would double the time this answer already took
      const ev = { item: id, ok: list.length > 0, n: list.length, ms: Date.now() - t0, detail: error };
      meta(rest[0], id.split(':')[0]).then(m => m.name, () => undefined).then(title => track(req, cfg.user, 'stream', { ...ev, title }));
      return send(res, 200, { streams: list, cacheMaxAge: 600 });
    }
    if (route === 'play' && rest.length === 2 && /^([a-f0-9]{40}|[a-f0-9]{32})$/i.test(rest[0])) {
      const h = rest[0].toLowerCase(), ev = { item: h, title: rest[1] };
      if (!await active(cfg.user, true)) {
        track(req, cfg.user, 'play', { ...ev, ok: false, detail: 'access revoked' });
        return send(res, 403, { error: 'access revoked' });
      }
      const to = await link(key, h, rest[1]).catch(e => { track(req, cfg.user, 'play', { ...ev, ok: false, detail: e.message }); throw e; });
      track(req, cfg.user, 'play', { ...ev, ok: true });
      res.writeHead(302, { Location: to });
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
module.exports = { fromNginx, norm, seasonFit, movieFit, foreign, epRe, pick, config, limiter, load, prefix, webUrl: h => urls.get(h), find, source, byQuality, rate, facts, describe };
