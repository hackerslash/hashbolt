const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hashbolt-')), 'data.tsv');
const { norm, seasonFit, movieFit, foreign, epRe, pick, config, limiter, load, prefix, webUrl, source, byQuality, rate, facts, describe } = require('./server');

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

assert(source('Film.2001.1080p.BluRay.REMUX') > source('Film.2001.1080p.BluRay.x264'));
assert(source('Film.2001.BluRay') > source('Film.2001.WEB-DL') && source('Film.2001.WEB-DL') > source('Film.2001.WEBRip'));
assert.equal(source('Film.2001.AMZN.WEB.H264'), source('Film.2001.WEB-DL'));
assert(source('Film.2001.HDTV') > source('Film.2001.CAM'));
assert.deepEqual(rate('Show.S01E02.2160p.WEBRip.mkv', 'Show.S01.2160p.WEB-DL'), { res: '2160P', q: source('WEBRip') });
assert.deepEqual(rate('S01E02 - Pilot.mkv', 'Show.S01.1080p.BluRay'), { res: '1080P', q: source('BluRay') });
const ranked = [
  { res: '1080P', q: source('BluRay'), size: 9 }, { res: '2160P', q: source('WEBRip'), size: 1 },
  { res: '1080P', q: source('WEB-DL'), size: 20 }, { res: '1080P', q: source('BluRay'), size: 12 },
].sort(byQuality);
assert.deepEqual(ranked.map(r => [r.res, r.size]), [['2160P', 1], ['1080P', 12], ['1080P', 9], ['1080P', 20]]);

assert.equal(norm('[QxR] Schindler’s List (1993) 1080p'), 'schindlers list 1993 1080p');
assert.equal(norm('Amélie.2001.BluRay'), 'amelie 2001 bluray');
assert.equal(norm('www.UIndex.org    -    Foo Bar 2026'), 'foo bar 2026');
assert.equal(norm('Mr.Robot - S01'), 'mr robot s01');
const mfit = (n, title, y) => movieFit({ n, rest: norm(n).slice(title.length) }, title, y);
assert(mfit('3 (2012) Tamil 1080p', '3', 2012) && mfit('3 (Three) (2012) Tamil', '3', 2012) && mfit('Up.3D.2009.1080p', 'up', 2009));
assert(mfit('Up - Altas Aventuras [2009] 1080p', 'up', 2009) && mfit('RRR a.k.a Rise Roar Revolt 2022', 'rrr', 2022));
assert(!mfit('3 Day Test 2012 1080p', '3', 2012) && !mfit('Up.in.the.Air.2009', 'up', 2009) && !mfit('Up in the Air (2009)', 'up', 2009));
assert(!mfit('3 - Prometheus (2012) BDRemux', '3', 2012) && !mfit('3.[FakeTaxi.com] =2012-10-01', '3', 2012));
assert(!mfit('3% (2011) Season 1 S01 1080p', '3', 2012) && mfit('Up (2009) [2160p x265 10bit S86 Joy]', 'up', 2009));
assert(mfit('Blade Runner Final Cut 1982 1080p', 'blade runner', 1982) && !mfit('Blade Runner 2049 (2017)', 'blade runner', 1982));
assert(foreign('Люди в черном 3.2012.UHD') && foreign('www.Site.org - Трансформеры 3 2011') && !foreign('[QxR] 3 (2012)'));
assert(!foreign('Amélie 2001') && !foreign('阿凡达.Avatar.2009') && !foreign('Аватар_Avatar_2009'));
const fit = (name, s, e) => seasonFit(' ' + norm(name), s, e);
assert.equal(fit('S01E02 1080p', 1, 2), 0);
assert.equal(fit('S01E03 1080p', 1, 2), -1);
assert.equal(fit('S01E01-E10 1080p', 1, 5), 0);
assert.equal(fit('S01E01-S01E04 1080p', 1, 5), -1);
assert.equal(fit('S01 1080p BluRay', 1, 2), 0);
assert.equal(fit('S03 1080p BluRay', 1, 2), -1);
assert.equal(fit('S01-S05 COMPLETE 1080p', 3, 1), 0);
assert.equal(fit('Season 1-5 1080p', 6, 1), -1);
assert.equal(fit('Season 2 1080p', 2, 4), 0);
assert.equal(fit('Season 1 1080p', 2, 4), -1);
assert.equal(fit('Complete Series 1080p', 4, 1), 0);
assert.equal(fit('2008 1080p BluRay', 1, 2), 1);
assert.equal(fit('with Benefits 2011 1080p', 1, 2), 1);
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
const withUser = u => config(Buffer.from(JSON.stringify({ key: 'k', user: u })).toString('base64url')).user;
assert.equal(withUser('abcdEFGH_123-xyz'), 'abcdEFGH_123-xyz');
assert.equal(withUser('../x'), undefined);
assert.equal(withUser('short'), undefined);
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
  globalThis.fetch = async url => {
    url = String(url);
    if (url.includes('cinemeta')) return { ok: true, json: async () => ({ meta: { name: 'Amélie', year: 2001 } }) };
    const q = new URL(url).searchParams, hs = q.get('hash').split(',');
    const data = Object.fromEntries(hs.map(h =>
      [h, q.has('list_files') ? { files: [{ name: 'Amelie.2001.mkv', size: 1e9 }] } : { size: 1 }]));
    return { ok: true, json: async () => ({ success: true, data }) };
  };
  const { find } = require('./server');
  const out = await find('k', 'movie', 'tt0119177', '', '');
  assert.equal(out.length, 2);
  assert(out.every(r => r.file && r.size && r.res));
  assert(out[0].size >= out[1].size);

  // a key whose plan refuses /webdl/checkcached still gets its cached torrents
  const plain = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('/webdl/')
    ? { ok: false, status: 403, json: async () => ({ success: false, detail: 'API feature not available on your plan.' }) }
    : plain(url);
  fs.writeFileSync(process.env.DATA_FILE, [`amelie 2001\tAmelie.2001.1080p\t${h('e')}\t1`, `amelie 2001 4k\tAmelie.2001.4K\t${w('f')}\t2\thttps://x.test/f`].join('\n'));
  load();
  assert.deepEqual((await find('free', 'movie', 'tt0119176', '', '')).map(r => r.h), [h('e')]);
  globalThis.fetch = plain;

  // 44 big 720p WEBRips and one small 2160p REMUX: ranking before the 40-stream cut must keep the REMUX, first.
  const hex = i => i.toString(16).padStart(40, '0');
  fs.writeFileSync(process.env.DATA_FILE, [
    `amelie 2001 2160p remux\tAmelie.2001.2160p.REMUX\t${hex(999)}\t1`,
    ...Array.from({ length: 44 }, (_, i) => `amelie 2001 720p webrip ${i}\tAmelie.2001.720p.WEBRip.${i}\t${hex(i + 1)}\t${1e10 + i}`),
  ].sort().join('\n'));
  load();
  const best = await find('k', 'movie', 'tt0119178', '', '');
  assert.equal(best.length, 40);
  assert.equal(best[0].n, 'Amelie.2001.2160p.REMUX');

  // Quotas: 30 at 2160p, 20 at 1080p, 5 at 720p -> 25 + 15, no 720p. Only 5 at 2160p -> the rest goes to 1080p.
  const mix = async (n4k, n1080, n720, id) => {
    let i = 0;
    const row = (res, src) => `amelie 2001 ${res} ${src} ${i}\tAmelie.2001.${res}.${src}.${i}\t${hex(1000 + ++i)}\t${1e9 + i}`;
    fs.writeFileSync(process.env.DATA_FILE, [
      ...Array.from({ length: n4k }, () => row('2160p', 'WEBRip')),
      ...Array.from({ length: n1080 }, (_, j) => row('1080p', j % 2 ? 'BluRay' : 'WEB-DL')),
      ...Array.from({ length: n720 }, () => row('720p', 'BluRay')),
    ].sort().join('\n'));
    load();
    const got = await find('k', 'movie', id, '', '');
    return Object.fromEntries(['2160P', '1080P', '720P'].map(r => [r, got.filter(x => x.res === r).length]).concat([['all', got]]));
  };
  const a = await mix(30, 20, 5, 'tt0119179');
  assert.deepEqual([a['2160P'], a['1080P'], a['720P']], [25, 15, 0]);
  const b = await mix(5, 50, 5, 'tt0119180');
  assert.deepEqual([b['2160P'], b['1080P'], b['720P']], [5, 35, 0]);
  const c = await mix(2, 3, 50, 'tt0119181');
  assert.deepEqual([c['2160P'], c['1080P'], c['720P']], [2, 3, 35]);
  // order: resolution, then source, then size
  const order = a.all.map(x => [x.res, x.q, x.size]);
  assert.deepEqual(order, [...order].sort((x, y) => (y[0] === '2160P') - (x[0] === '2160P') || y[1] - x[1] || y[2] - x[2]));
  assert(a.all.findIndex(x => x.res === '1080P' && /BluRay/.test(x.n)) < a.all.findIndex(x => x.res === '1080P' && /WEB-DL/.test(x.n)));
  // Cinemeta spells it as one word, the releases as two: TMDB's title finds them; its Malayalam title normalises away
  fs.writeFileSync(process.env.DATA_FILE, `thanneer mathan dinangal 2019 720p mkv\tThanneer Mathan Dinangal (2019) 720p.mkv\t${h('9')}\t1`);
  load();
  globalThis.fetch = async url => {
    url = String(url);
    if (url.includes('cinemeta')) return { ok: true, json: async () => ({ meta: { name: 'Thanneermathan Dinangal', year: 2019 } }) };
    if (url.includes('wecollege')) return { ok: true, json: async () => ({ movie_results: [
      { title: 'Thanneer Mathan Dinangal', original_title: 'തണ്ണീർ മത്തൻ ദിനങ്ങൾ' }] }) };
    return plain(url);
  };
  assert.deepEqual((await find('k', 'movie', 'tt10551608', '', '')).map(r => r.h), [h('9')]);
  globalThis.fetch = plain;
  console.log('ok');
})();

// the same facts the LinkGenie addon shows, from the file name and its pack's
assert.deepEqual(facts('Guru.2007.Hindi.1080p.BluRay.REMUX.AVC.DTS-HDMA.5.1-mAck.mkv'),
  [['MKV', 'Remux', 'BluRay', 'AVC'], ['DTS-HD MA', '5.1', 'Hindi']]);
assert.deepEqual(facts('S01E02.mkv', 'Show S01 2160p WEB-DL DDP5.1 Atmos DV HDR H.265'),
  [['MKV', 'WEB-DL', 'HEVC', 'DV', 'HDR'], ['DD+', 'Atmos', '5.1']]);
assert.equal(describe({ file: 'S01E02.mkv', n: 'Show S01 2160p WEB-DL', res: '2160P', size: 2 ** 31, h: 'a'.repeat(40) }, true),
  '📄 S01E02.mkv\n📦 Show S01 2160p WEB-DL\n🎞️ 2160p • MKV • WEB-DL\n💾 2.00 GB\n📡 TorBox cached');

// Tester and viewer headers count only from nginx: a client on the LAN port can't claim an account or an IP.
require('./server').fromNginx({ socket: { remoteAddress: '192.168.0.50' } })
  .then(trusted => assert.equal(trusted, false));
