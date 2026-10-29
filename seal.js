// The index is published on the repo's public `index` release, and it holds what consenting users' libraries shared
// (release names, web download URLs), so it is encrypted: AES-256-GCM under INDEX_KEY (32 random bytes, base64), a
// secret only the workflow and the server have. A sealed file is a 12-byte IV, the gzipped index encrypted, and the
// 16-byte tag, which fails the open of a file that was altered or sealed under another key.
// `node seal.js data.tsv data.tsv.gz.enc` seals (the workflow); the server opens.
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

function key() {
  const k = Buffer.from(process.env.INDEX_KEY || '', 'base64');
  if (k.length !== 32) throw new Error('INDEX_KEY must be 32 bytes, base64');
  return k;
}

async function seal(src, dst) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), cipher, async function* (body) {
    yield iv;
    yield* body;
    yield cipher.getAuthTag();
  }, fs.createWriteStream(dst));
}

// Writes the plaintext to dst as it decrypts; the tag is checked at the end and rejects then, so the caller writes to
// a temporary file and renames it only once this resolves.
async function open(src, dst) {
  const { size } = fs.statSync(src);
  if (size < 28) throw new Error('sealed index too short');
  const iv = Buffer.alloc(12), tag = Buffer.alloc(16), fd = fs.openSync(src, 'r');
  try { fs.readSync(fd, iv, 0, 12, 0); fs.readSync(fd, tag, 0, 16, size - 16); } finally { fs.closeSync(fd); }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv).setAuthTag(tag);
  await pipeline(fs.createReadStream(src, { start: 12, end: size - 17 }), decipher, zlib.createGunzip(), fs.createWriteStream(dst));
}

if (require.main === module) seal(process.argv[2], process.argv[3]).catch(e => { console.error(e.message); process.exit(1); });
module.exports = { seal, open };
