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
    map.set(hash, [norm(clean(name)), clean(name), hash, bytes || 0, ...(url ? [clean(url)] : [])].join('\t'));
};

const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).map(f => path.join(ROOT, f));
const ld = path.join(ROOT, 'lists');
if (fs.existsSync(ld)) for (const f of fs.readdirSync(ld)) if (f.endsWith('.txt')) files.push(path.join(ld, f));

// Decompressing every list takes minutes, so each is decoded once into OUT.cache/<file>.tsv ("<git blob sha>"
// header, then "hash \t name \t bytes" lines) and only re-decoded when its content changes.
const blobs = new Map(execFileSync('git', ['-C', ROOT, 'ls-files', '-s'], { maxBuffer: 1e8 }).toString()
  .split('\n').filter(Boolean).map(l => { const [meta, p] = l.split('\t'); return [p, meta.split(' ')[1]]; }));
// ponytail: caches of deleted lists are never pruned; they are just ignored
const CACHE = OUT + '.cache';
fs.mkdirSync(CACHE, { recursive: true });
let decoded = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f), stamp = blobs.get(rel.split(path.sep).join('/')) || String(fs.statSync(f).size);
  const cf = path.join(CACHE, rel.replace(/[\\/]/g, '_') + '.tsv');
  let txt; try { txt = fs.readFileSync(cf, 'utf8'); } catch {}
  if (!txt?.startsWith(stamp + '\n')) {
    decoded++;
    const m = fs.readFileSync(f, 'utf8').match(/hashlist#(id=)?([^"'\s]+)/);
    let d; try { d = !m || m[1] ? null : JSON.parse(LZ.decompressFromEncodedURIComponent(m[2])); } catch {}
    txt = stamp + '\n' + (d?.torrents || []).map(t => [t.hash, clean(t.filename), t.bytes || 0].join('\t')).join('\n');
    fs.writeFileSync(cf, txt);
  }
  for (const l of txt.split('\n').slice(1)) { const [h, n, b] = l.split('\t'); add(h, n, +b); }
}
console.log('repo:', map.size, '| decoded', decoded, 'of', files.length, 'files');

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
  console.log('total:', lines.length);
})();
