import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const PACKS = path.join(DATA, 'packs');
const ASSETS = path.join(DATA, 'assets');
const TMP = path.join(DATA, 'tmp');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 300 * 1024 * 1024);
const INDEX_FILE = path.join(DATA, 'library.json');

for (const dir of [PACKS, ASSETS, TMP]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, '[]');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));
app.use(express.json({ limit: '32kb' }));
app.use('/media', express.static(ASSETS, { immutable: true, maxAge: '1y', fallthrough: false }));
app.use(express.static(PUBLIC, { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false });
const postLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 4, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Upload limit reached. Try again in an hour.' } });
app.use('/api', apiLimiter);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP),
  filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.upload`)
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, fieldSize: 256 },
  fileFilter: (_req, file, cb) => {
    if (!/\.rbpack$/i.test(file.originalname || '')) return cb(new Error('Only .rbpack files are accepted.'));
    cb(null, true);
  }
});

let writeQueue = Promise.resolve();
function serializeWrite(task) {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => {});
  return next;
}
async function readIndex() {
  try { return JSON.parse(await fsp.readFile(INDEX_FILE, 'utf8')); }
  catch { return []; }
}
async function saveIndex(entries) {
  const temp = `${INDEX_FILE}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(entries), 'utf8');
  await fsp.rename(temp, INDEX_FILE);
}

const cleanText = (value, max = 100) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const basename = value => path.basename(String(value || 'upload.rbpack')).replace(/\.rbpack$/i, '').replace(/[._-]+/g, ' ').trim();
const isPlainObject = value => value && typeof value === 'object' && !Array.isArray(value);
function firstValue(...values) { return values.find(value => value !== undefined && value !== null && value !== '') ?? null; }
function asArray(value) { return Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : []; }
function decodePackBuffer(buffer) {
  let encoding = 'utf-8', offset = 0;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
  else if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) offset = 3;
  return new TextDecoder(encoding).decode(buffer.subarray(offset)).replace(/^\uFEFF/, '').replace(/\u0000+$/g, '').trim();
}
function isEmbeddedMedia(value, depth = 0) {
  if (value == null || value === '') return true;
  if (depth > 4) return false;
  if (Buffer.isBuffer(value)) return value.length > 0;
  if (Array.isArray(value)) return value.length > 0 && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  if (isPlainObject(value)) {
    if (Array.isArray(value.bytes) || (value.type === 'Buffer' && Array.isArray(value.data))) return true;
    const nested = firstValue(value.dataUrl, value.dataURL, value.url, value.base64, value.data, value.content, value.file, value.path, value.src);
    return nested !== null && isEmbeddedMedia(nested, depth + 1);
  }
  if (typeof value !== 'string') return false;
  const data = value.trim();
  if (/^https?:\/\//i.test(data)) return false;
  if (/^data:/i.test(data)) return data.includes(',');
  const base64 = data.replace(/^base64:/i, '').replace(/^base64,/i, '').replace(/[\s\r\n\t]/g, '');
  return base64.length >= 8 && /^[A-Za-z0-9+/_=-]+$/.test(base64);
}

function normalizePack(parsed) {
  if (Array.isArray(parsed)) return { format: 'LEGACY_RHYTHMBREAK_PACK', songs: parsed, playlists: [] };
  let root = parsed;
  for (let depth = 0; depth < 3 && isPlainObject(root); depth++) {
    if (isPlainObject(root.pack)) { root = root.pack; continue; }
    if (isPlainObject(root.data) && (Array.isArray(root.data.songs) || Array.isArray(root.data.tracks) || root.data.format)) { root = root.data; continue; }
    break;
  }
  if (!isPlainObject(root)) throw new Error('This file does not contain a RhythmBreak package.');
  const songs = asArray(firstValue(root.songs, root.tracks, root.musicTracks, root.items, root.song ? [root.song] : null));
  const playlists = asArray(firstValue(root.playlists, root.lists, []));
  const format = String(firstValue(root.format, root.type, root.packageFormat, '')).trim().toUpperCase().replace(/[\s-]+/g, '_');
  const accepted = ['RHYTHM_BREAK_PACK', 'FRACTURE_PACK', 'RHYTHMBREAK_PACK', 'LEGACY_RHYTHMBREAK_PACK', 'RHYTHMBREAK'];
  if (!songs.length || (!accepted.includes(format) && !Array.isArray(root.songs) && !Array.isArray(root.tracks) && !Array.isArray(root.items))) {
    throw new Error('Unrecognized or empty .rbpack file. Export the music again from RhythmBreak.');
  }
  if (songs.length > 100) throw new Error('A single upload can contain up to 100 tracks.');
  return { ...root, format: format || 'LEGACY_RHYTHMBREAK_PACK', songs, playlists };
}

function getTrackFiles(track) {
  const files = track.files || track.assets || track.media || {};
  return {
    audio: firstValue(track.audio, track.audioData, track.audioBase64, track.audio_base64, track.audioSrc, track.audioFile, track.trackAudio, files.audio, files.track),
    cover: firstValue(track.cover, track.coverImage, track.coverArt, track.cover_base64, track.artwork, track.thumbnail, track.image, files.cover, files.image),
    banner: firstValue(track.background, track.backgroundVideo, track.backgroundImage, track.background_base64, track.banner, track.bg, track.backgroundData, files.background, files.banner)
  };
}

function mediaBuffer(value, defaultMime) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return { buffer: value, mime: defaultMime };
  if (Array.isArray(value) && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return { buffer: Buffer.from(value), mime: defaultMime };
  let candidate = value, mime = defaultMime;
  if (isPlainObject(value)) {
    mime = String(value.mimeType || value.mime || value.type || defaultMime).slice(0, 100);
    if (Array.isArray(value.bytes)) return { buffer: Buffer.from(value.bytes), mime };
    if (value.type === 'Buffer' && Array.isArray(value.data)) return { buffer: Buffer.from(value.data), mime };
    candidate = firstValue(value.dataUrl, value.dataURL, value.url, value.base64, value.data, value.content, value.file, value.src);
  }
  if (typeof candidate !== 'string') return null;
  let data = candidate.trim();
  if (data.startsWith('base64:')) data = data.slice(7).trim();
  const dataUrl = data.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/i);
  if (dataUrl) { mime = dataUrl[1] || mime; data = dataUrl[2]; }
  else if (/^https?:\/\//i.test(data)) return null;
  else data = data.replace(/^base64,/i, '');
  data = data.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length < 8) return null;
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) return null;
  return { buffer, mime };
}

function extensionFor(mime, fallback) {
  const value = String(mime || '').toLowerCase().split(';')[0].trim();
  const known = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm',
    'video/quicktime': '.mov'
  };
  return known[value] || fallback;
}

async function savePreviewAsset(id, type, media) {
  if (!media?.buffer?.length) return null;
  const allowed = type === 'cover'
    ? ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif']
    : ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime'];
  const mime = String(media.mime || '').toLowerCase().split(';')[0].trim();
  if (!allowed.includes(mime)) return null;
  if (media.buffer.length > 24 * 1024 * 1024) return null;
  const ext = extensionFor(mime, type === 'cover' ? '.img' : '.media');
  const filename = `${id}-${type}${ext}`;
  await fsp.writeFile(path.join(ASSETS, filename), media.buffer, { flag: 'wx' });
  return { url: `/media/${filename}`, mime, kind: mime.startsWith('video/') ? 'video' : 'image' };
}

function summarizeTrack(source, index) {
  if (!isPlainObject(source)) throw new Error(`Track ${index + 1} has invalid metadata.`);
  const name = cleanText(firstValue(source.name, source.title, source.trackName, source.song_name, 'Untitled Track'), 120) || 'Untitled Track';
  const creator = cleanText(firstValue(source.creator, source.artist, source.artist_name, source.author, 'Unknown creator'), 100) || 'Unknown creator';
  const bpm = Number(firstValue(source.bpm, source.tempo, 0));
  const difficultyRaw = String(firstValue(source.difficulty, source.level, 'normal')).toLowerCase();
  const difficultyMap = { easy: 'Easy', normal: 'Medium', medium: 'Medium', hard: 'Hard', expert: 'Insane', insane: 'Insane' };
  const difficulty = difficultyMap[difficultyRaw] || cleanText(difficultyRaw, 24) || 'Medium';
  return { name, creator, bpm: Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm) : null, difficulty, backgroundKind: String(firstValue(source.backgroundKind, source.backgroundType, '')).toLowerCase(), files: getTrackFiles(source) };
}

function playlistTitle(pack, tracks, originalName) {
  const fromPlaylist = cleanText(firstValue(pack.playlists?.[0]?.name, pack.playlists?.[0]?.title, ''), 120);
  if (fromPlaylist) return fromPlaylist;
  const fileTitle = cleanText(basename(originalName), 120);
  if (fileTitle && !/^meg[a]?mix$/i.test(fileTitle)) return fileTitle;
  return `${tracks[0].name} + ${tracks.length - 1} more`;
}

function publicPack(entry) {
  const { storedFile, ...safe } = entry;
  return safe;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'RhythmBreak Community Library' }));
app.get('/api/packs', async (req, res, next) => {
  try {
    const q = cleanText(req.query.q, 80).toLocaleLowerCase();
    const type = ['song', 'playlist'].includes(req.query.type) ? req.query.type : 'all';
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
    const limit = Math.max(1, Math.min(48, Number.parseInt(req.query.limit, 10) || 24));
    let entries = await readIndex();
    if (type !== 'all') entries = entries.filter(item => item.type === type);
    if (q) entries = entries.filter(item => [item.title, item.publisher, ...(item.tracks || []).flatMap(track => [track.name, track.creator])].join(' ').toLocaleLowerCase().includes(q));
    entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const total = entries.length;
    const start = (page - 1) * limit;
    const packs = entries.slice(start, start + limit).map(publicPack);
    const all = await readIndex();
    res.json({ packs, page, limit, total, hasMore: start + packs.length < total,
      stats: { uploads: all.length, tracks: all.reduce((sum, item) => sum + item.trackCount, 0), downloads: all.reduce((sum, item) => sum + (item.downloads || 0), 0) } });
  } catch (error) { next(error); }
});

app.get('/api/packs/:id', async (req, res, next) => {
  try {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Pack not found.' });
    const entry = (await readIndex()).find(item => item.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Pack not found.' });
    res.json({ pack: publicPack(entry) });
  } catch (error) { next(error); }
});

app.get('/api/packs/:id/download', async (req, res, next) => {
  try {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'Pack not found.' });
    let entry;
    await serializeWrite(async () => {
      const entries = await readIndex();
      const index = entries.findIndex(item => item.id === req.params.id);
      if (index < 0) return;
      entries[index].downloads = (entries[index].downloads || 0) + 1;
      entry = entries[index];
      await saveIndex(entries);
    });
    if (!entry) return res.status(404).json({ error: 'Pack not found.' });
    const filePath = path.join(PACKS, path.basename(entry.storedFile));
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'This pack is no longer available.' });
    res.download(filePath, `${entry.downloadName}.rbpack`);
  } catch (error) { next(error); }
});

app.post('/api/packs', postLimiter, (req, res, next) => {
  upload.single('pack')(req, res, async error => {
    if (error) return next(error);
    let tempPath = req.file?.path;
    const createdAssets = [];
    try {
      if (!req.file) return res.status(400).json({ error: 'Choose a .rbpack file first.' });
      const publisher = cleanText(req.body.publisher, 40);
      if (!publisher) return res.status(400).json({ error: 'Enter the name of the person who published this music.' });
      if (publisher.length < 2) return res.status(400).json({ error: 'The publisher name must contain at least 2 characters.' });
      const rawBuffer = await fsp.readFile(tempPath);
      const raw = decodePackBuffer(rawBuffer);
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { throw new Error('The .rbpack is not valid JSON. Export it again from RhythmBreak and try again.'); }
      const pack = normalizePack(parsed);
      const tracks = pack.songs.map(summarizeTrack);
      for (let i = 0; i < tracks.length; i++) {
        if (!isEmbeddedMedia(tracks[i].files.audio)) throw new Error(`“${tracks[i].name}” is missing embedded audio or refers to an external URL. Export the track with its audio included.`);
        if (tracks[i].files.cover && !isEmbeddedMedia(tracks[i].files.cover)) throw new Error(`The cover for “${tracks[i].name}” is not embedded in this pack. Re-export it from RhythmBreak.`);
        if (tracks[i].files.banner && !isEmbeddedMedia(tracks[i].files.banner)) throw new Error(`The banner for “${tracks[i].name}” is not embedded in this pack. Re-export it from RhythmBreak.`);
      }
      const id = crypto.randomUUID();
      const primary = tracks[0];
      let cover = null, banner = null;
      for (const track of tracks) {
        if (!cover && track.files.cover) {
          const asset = await savePreviewAsset(id, 'cover', mediaBuffer(track.files.cover, 'image/png'));
          if (asset) { cover = asset; createdAssets.push(path.basename(asset.url)); }
        }
        if (!banner && track.files.banner) {
          const bannerValue = track.files.banner;
          const defaultMime = track.backgroundKind === 'video' || /video/i.test(String(track.files.banner?.mimeType || track.files.banner?.mime || track.files.banner?.type || '')) ? 'video/mp4' : 'image/png';
          const asset = await savePreviewAsset(id, 'banner', mediaBuffer(bannerValue, defaultMime));
          if (asset) { banner = asset; createdAssets.push(path.basename(asset.url)); }
        }
        if (cover && banner) break;
      }
      const isPlaylist = tracks.length > 1;
      const title = isPlaylist ? playlistTitle(pack, tracks, req.file.originalname) : primary.name;
      const createdAt = new Date().toISOString();
      const safeDownloadName = (isPlaylist ? title : primary.name).replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'RhythmBreak_Pack';
      const finalPath = path.join(PACKS, `${id}.rbpack`);
      await fsp.rename(tempPath, finalPath);
      tempPath = null;
      const entry = {
        id, type: isPlaylist ? 'playlist' : 'song', title, publisher,
        creator: isPlaylist ? `${tracks.length} tracks` : primary.creator,
        trackCount: tracks.length, tracks: tracks.map(({ name, creator, bpm, difficulty }) => ({ name, creator, bpm, difficulty })),
        cover, banner, bytes: req.file.size, downloads: 0, createdAt,
        downloadName: safeDownloadName, storedFile: `${id}.rbpack`
      };
      await serializeWrite(async () => { const entries = await readIndex(); entries.push(entry); await saveIndex(entries); });
      res.status(201).json({ pack: publicPack(entry), message: 'Published to the community library.' });
    } catch (err) {
      for (const filename of createdAssets) await fsp.rm(path.join(ASSETS, filename), { force: true }).catch(() => {});
      next(err);
    } finally {
      if (tempPath) await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  });
});

// Serve the library shell explicitly at the domain root. This avoids host/router
// configurations accidentally returning a 404 for the homepage.
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// Client-side fallback for browser routes only. API and media paths must never
// receive index.html as a misleading 200 response.
app.get(new RegExp('^(?!/api(?:/|$)|/media(?:/|$)).*'), (req, res, next) => {
  if (req.accepts('html')) return res.sendFile(path.join(PUBLIC, 'index.html'));
  return next();
});
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  return res.status(404).type('text').send('Page not found');
});
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? `The .rbpack is too large. Maximum upload size: ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` : error.message;
    return res.status(400).json({ error: message });
  }
  const status = error.status || 400;
  res.status(status).json({ error: error.message || 'Something went wrong while processing this request.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RhythmBreak Community Library is running on http://localhost:${PORT}`);
  console.log(`Upload limit: ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
});
