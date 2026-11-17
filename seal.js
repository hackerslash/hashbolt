// The public release holds users' libraries, so it is sealed: 12-byte IV | AES-256-GCM(gzip(index)) | 16-byte tag.
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

// The tag is only checked at the end: dst must be a temp file, renamed once this resolves.
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
