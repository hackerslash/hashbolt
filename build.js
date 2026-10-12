// Rebuild data.tsv from the hashlists repo + Redis `hashlib`: "normkey \t name \t hash \t bytes [\t url]" sorted by key.
// 40-char hash = torrent, 32-char = webdl (kept only with a url). Runs in GitHub Actions, see .github/workflows/index.yml.
const fs = require('fs');
const path = require('path');
const LZ = require('lz-string');
const { execFileSync } = require('child_process');
const { norm } = require('./server');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const ROOT = process.env.HASHLISTS_DIR || path.join(__dirname, 'hashlists');
const OUT = process.env.DATA_FILE || path.join(__dirname, 'data.tsv');
const clean = s => String(s || '').replace(/[\t\n\r]/g, ' ');
const map = new Map();
const add = (hash, name, bytes, url) => {
  if ((hash?.length === 40 || (hash?.length === 32 && url)) && !map.has(hash))
    // Copy the key: a substring would keep its whole source string (a cache file) alive, ~2.5 GB in total.
    map.set(Buffer.from(hash, 'latin1').toString('latin1'), [norm(clean(name)), clean(name), hash, bytes || 0, ...(url ? [clean(url)] : [])].join('\t'));
};

// Lists and their blob shas come from the git tree, so a blobless clone works: decoded lists are cached in
// OUT.cache/<file>.tsv ("<blob sha>" header, then "hash \t name \t bytes" lines), and only lists whose cache is
// missing or stale get their contents fetched and decompressed.
// Caches of deleted lists stay on disk, unused.
const tree = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '-z', 'HEAD'], { maxBuffer: 1e8 }).toString().split('\0')
  .map(l => { const [meta, p] = l.split('\t'); return [p, meta.split(' ')[2]]; })
  .filter(([p]) => /^[^/]+\.html$/.test(p) || /^lists\/[^/]+\.txt$/.test(p));
const CACHE = OUT + '.cache';
fs.mkdirSync(CACHE, { recursive: true });
const cachePath = p => path.join(CACHE, p.replace(/\//g, '_') + '.tsv');
const header = Buffer.alloc(41);
const fresh = ([p, sha]) => {
  try { const fd = fs.openSync(cachePath(p), 'r'); fs.readSync(fd, header, 0, 41, 0); fs.closeSync(fd); } catch { return false; }
  return header.toString() === sha + '\n';
};
const stale = tree.filter(t => !fresh(t));
const absent = stale.map(([p]) => p).filter(p => !fs.existsSync(path.join(ROOT, p)));
if (absent.length) execFileSync('git', ['-C', ROOT, 'checkout', 'HEAD', '--pathspec-from-file=-'], { input: absent.join('\n'), stdio: ['pipe', 'ignore', 'inherit'] });
for (const [p, sha] of stale) {
  const m = fs.readFileSync(path.join(ROOT, p), 'utf8').match(/hashlist#(id=)?([^"'\s]+)/);
  let d; try { d = !m || m[1] ? null : JSON.parse(LZ.decompressFromEncodedURIComponent(m[2])); } catch {}
  fs.writeFileSync(cachePath(p), sha + '\n' + (d?.torrents || []).map(t => [t.hash, clean(t.filename), t.bytes || 0].join('\t')).join('\n'));
}
for (const [p] of tree)
  for (const l of fs.readFileSync(cachePath(p), 'utf8').split('\n').slice(1)) { const [h, n, b] = l.split('\t'); add(h, n, +b); }
console.log('repo:', map.size, '| decoded', stale.length, 'of', tree.length, 'lists, fetched', absent.length);

(async () => {
  if (process.env.REDIS_URL) {
    const r = new (require('ioredis'))(process.env.REDIS_URL, { tls: {}, maxRetriesPerRequest: 3 });
    let cursor = '0';
    do {
      const [c, pairs] = await r.hscan('hashlib', cursor, 'COUNT', 1000);
      cursor = c;
      for (let i = 0; i < pairs.length; i += 2) {
        let v = {}; try { v = JSON.parse(pairs[i + 1]) || {}; } catch {}
        add(pairs[i], v.name, v.size, v.url);
      }
    } while (cursor !== '0');
    r.disconnect();
  }
  const lines = [...map.values()].sort();
  map.clear();
  const fd = fs.openSync(OUT + '.tmp', 'w');
  for (let i = 0; i < lines.length; i += 50000) fs.writeSync(fd, (i ? '\n' : '') + lines.slice(i, i + 50000).join('\n'));
  fs.closeSync(fd);
  fs.renameSync(OUT + '.tmp', OUT);
  fs.rmSync(OUT + '.version', { force: true });
  console.log('total:', lines.length);
})();
