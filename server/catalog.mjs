import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const types = new Map([['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.m4a', 'audio/mp4']]);

// An operator supplies this catalog and its playback rights. Only entries in
// manifest.json are offered, so files in the directory are never listed by accident.
export function loadCatalog(directory) {
  if (!directory) return new Map();
  const root = realpathSync(directory);
  const raw = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error('Invalid audio catalog manifest');
  const catalog = new Map();
  for (const item of raw) {
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(item.id) || catalog.has(item.id) ||
        typeof item.title !== 'string' || !item.title.trim() || item.title.length > 128 ||
        typeof item.file !== 'string' || !/^[\w .-]+\.(mp3|wav|m4a)$/i.test(item.file) ||
        typeof item.rights !== 'string' || !item.rights.trim()) throw new Error('Invalid audio catalog entry');
    const location = realpathSync(path.join(root, item.file));
    if (path.dirname(location) !== root) throw new Error('Catalog file escapes its directory');
    const info = statSync(location);
    if (!info.isFile() || info.size < 1 || info.size > 32 * 1024 * 1024) throw new Error('Catalog file size invalid');
    const youtubeId = item.youtubeId == null ? null : item.youtubeId;
    if (youtubeId !== null && (typeof youtubeId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(youtubeId))) {
      throw new Error('Invalid YouTube catalog mapping');
    }
    const mime = types.get(path.extname(location).toLowerCase());
    const file = { id: item.id, name: item.title, size: info.size, mime };
    catalog.set(item.id, {
      file, youtubeId, location,
      serve(request, response) {
        response.setHeader('Content-Type', mime);
        response.setHeader('Content-Length', info.size);
        if (request.method === 'HEAD') return response.end();
        const stream = createReadStream(location);
        response.on('close', () => stream.destroy());
        stream.on('error', () => response.destroy());
        stream.pipe(response);
      },
      release() {},
    });
  }
  return catalog;
}
