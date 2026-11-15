// Photo storage: Vercel Blob (private) when BLOB_READ_WRITE_TOKEN is set, otherwise the local disk.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
const ACCESS = process.env.BLOB_ACCESS || 'private';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!useBlob) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const blob = useBlob ? require('@vercel/blob') : null;
const blobPath = (key) => `dresses/${key}`;

async function save(key, buffer, contentType) {
  if (useBlob) {
    await blob.put(blobPath(key), buffer, { access: ACCESS, contentType, addRandomSuffix: false });
  } else {
    await fs.promises.writeFile(path.join(UPLOAD_DIR, key), buffer);
  }
}

async function remove(keys) {
  if (!keys.length) return;
  try {
    if (useBlob) await blob.del(keys.map(blobPath));
    else await Promise.all(keys.map((k) => fs.promises.unlink(path.join(UPLOAD_DIR, k)).catch(() => {})));
  } catch (e) { console.error('photo delete failed', e); }
}

// Streams a photo to the response. Returns false if not found.
async function send(key, res) {
  const type = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' }[path.extname(key)] || 'application/octet-stream';
  res.set('Cache-Control', 'private, max-age=604800, immutable');
  if (useBlob) {
    const r = await blob.get(blobPath(key), { access: ACCESS });
    if (!r || r.statusCode !== 200) return false;
    res.type(r.blob.contentType || type);
    Readable.fromWeb(r.stream).pipe(res);
    return true;
  }
  const file = path.join(UPLOAD_DIR, key);
  if (!fs.existsSync(file)) return false;
  res.type(type);
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { save, remove, send, useBlob };
