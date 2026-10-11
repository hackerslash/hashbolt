const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hashbolt-')), 'data.tsv');
const { norm, epRe, pick, config, limiter, load, prefix, webUrl } = require('./server');

const h = c => c.repeat(40), w = c => c.repeat(32);
fs.writeFileSync(process.env.DATA_FILE, [
  `amelie 2001\tAmélie (2001) 1080p\t${h('a')}\t100`,
  `amelie 2001 4k\tAmélie.2001.4K\t${w('b')}\t200\thttps://x.test/a?b=1`,
  `amelie the musical\tAmélie The Musical\t${h('c')}\t300`,
  `zebra\tZebra\t${h('d')}\t400`,
].join('\n'));
load();
assert.deepEqual(prefix('amelie 2001').map(r => r.n), ['Amélie (2001) 1080p', 'Amélie.2001.4K']);
assert.deepEqual(prefix('zebra ').map(r => r.n), []);
assert.equal(prefix('zebra')[0].b, 400);
assert.equal(webUrl(w('b')), 'https://x.test/a?b=1');
assert.equal(webUrl(h('a')), undefined);

assert.equal(norm('[QxR] Schindler’s List (1993) 1080p'), 'schindlers list 1993 1080p');
assert.equal(norm('Amélie.2001.BluRay'), 'amelie 2001 bluray');
assert.equal(norm('www.UIndex.org    -    Foo Bar 2026'), 'foo bar 2026');
assert.equal(norm('Mr.Robot - S01'), 'mr robot s01');
const ep = epRe(1, 2);
assert(ep.test('Show.S01E02.mkv') && ep.test('Show 1x02.mkv') && ep.test('s1 e2'));
assert(!ep.test('Show.S01E20.mkv') && !ep.test('Show.S11E02.mkv'));
const files = [{ name: 'S01E01.mkv', size: 5 }, { name: 'S01E02.mkv', size: 4 }, { name: 'sample.txt', size: 9 }];
assert.equal(pick(files, 'pack', ep).name, 'S01E02.mkv');
assert.equal(pick(files, 'movie').name, 'S01E01.mkv');
assert.equal(pick([{ name: 'x.mkv', size: 1 }], 'Show.S01E02', ep).name, 'x.mkv');
const pack = [{ name: 'Matrix.1999.2003/The.Matrix.1999.mkv', size: 5 }, { name: 'Matrix.1999.2003/The.Matrix.Reloaded.2003.mkv', size: 9 }];
assert.equal(pick(pack, 'The.Matrix.Quadrilogy', undefined, 1999).name, 'Matrix.1999.2003/The.Matrix.1999.mkv');
assert.equal(pick(pack, 'The.Matrix.Quadrilogy').name, 'Matrix.1999.2003/The.Matrix.Reloaded.2003.mkv');
const seg = Buffer.from(JSON.stringify({ key: 'ab-12', contribute: true })).toString('base64url');
assert.deepEqual(config(seg), { key: 'ab-12', contribute: true });
assert.deepEqual(config('8976-5a24-4230'), { key: '8976-5a24-4230' });
assert.equal(config('bad key!'), null);
assert.equal(config(Buffer.from('{"key":"x/../y"}').toString('base64url')).contribute, undefined);
(async () => {
  const slot = limiter(3);
  let live = 0, peak = 0;
  const done = await Promise.all(Array.from({ length: 10 }, (_, i) => slot(async () => {
    peak = Math.max(peak, ++live);
    await new Promise(r => setTimeout(r, 5));
    live--;
    return i;
  })));
  assert.equal(peak, 3);
  assert.deepEqual(done, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await assert.rejects(slot(async () => { throw new Error('x'); }));
  assert.equal(await slot(async () => 'freed'), 'freed');
  console.log('ok');
})();
