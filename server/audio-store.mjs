const fileLimit = 32 * 1024 * 1024;
export const defaultAudioBudget = 4 * fileLimit;

export class AudioRequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

// Inspect container headers before offering a file to other phones. Each phone's
// decoder still determines whether the whole file and codec are playable.
function wav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return false;
  let format = false;
  for (let pos = 12; pos + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(pos + 4);
    const end = pos + 8 + size;
    if (end > buffer.length) return false;
    const type = buffer.toString('ascii', pos, pos + 4);
    if (type === 'fmt ' && size >= 16) format = true;
    if (type === 'data' && size > 0 && format) return true;
    pos = end + (size % 2);
  }
  return false;
}

function mp3(buffer) {
  let pos = 0;
  if (buffer.toString('ascii', 0, 3) === 'ID3') {
    if (buffer.length < 10 || ![2, 3, 4].includes(buffer[3])) return false;
    const size = buffer.subarray(6, 10);
    if (size.some(byte => byte >= 128)) return false;
    pos = 10 + size.reduce((n, byte) => n * 128 + byte, 0);
    if (buffer[3] === 4 && (buffer[5] & 0x10)) pos += 10;
  }
  if (pos + 4 > buffer.length) return false;
  const bits = buffer[pos + 1];
  return buffer[pos] === 255 && (bits & 0xe0) === 0xe0 && (bits & 0x18) !== 0x08 &&
    (bits & 6) === 2 && (buffer[pos + 2] & 0xf0) !== 0xf0 && (buffer[pos + 2] & 0x0c) !== 0x0c;
}

// ISO BMFF four-character codes at known box boundaries. Avoid scanning media
// bytes for codec names. Bound even malformed files containing millions of boxes.
function m4a(buffer) {
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  let budget = 8192;
  function* boxes(start, limit) {
    for (let pos = start; pos + 8 <= limit && --budget > 0;) {
      let size = buffer.readUInt32BE(pos);
      let head = 8;
      if (size === 1) {
        if (pos + 16 > limit || buffer.readUInt32BE(pos + 8) !== 0) return;
        size = buffer.readUInt32BE(pos + 12);
        head = 16;
      } else if (size === 0) size = limit - pos;
      if (size < head || size > limit - pos) return;
      yield { type: buffer.toString('latin1', pos + 4, pos + 8), start: pos + head, end: pos + size };
      pos += size;
    }
  }
  function child(parent, type) {
    if (parent) for (const box of boxes(parent.start, parent.end)) if (box.type === type) return box;
  }
  const moov = child({ start: 0, end: buffer.length }, 'moov');
  if (!moov) return false;
  let audio = false;
  for (const track of boxes(moov.start, moov.end)) {
    if (track.type !== 'trak') continue;
    const media = child(track, 'mdia');
    const handler = child(media, 'hdlr');
    if (!handler || handler.end - handler.start < 12) return false;
    const type = buffer.toString('ascii', handler.start + 8, handler.start + 12);
    if (type === 'vide') return false;
    if (type !== 'soun') continue;
    const stsd = child(child(child(media, 'minf'), 'stbl'), 'stsd');
    if (stsd && stsd.end >= stsd.start + 8) {
      for (const entry of boxes(stsd.start + 8, stsd.end)) if (entry.type === 'mp4a') audio = true;
    }
  }
  return budget > 0 && audio;
}

export function createAudioStore(budgetBytes = defaultAudioBudget) {
  let used = 0;
  let inflight = 0;

  async function receive(request) {
    const declaredType = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (declaredType && declaredType !== 'application/octet-stream' && !declaredType.startsWith('audio/')) {
      throw new AudioRequestError(415, 'unsupported_audio');
    }
    // Fixed-size reservation, also for chunked uploads. No array of chunks or
    // second full-size copy during assembly. Downloads keep their lease on replacement.
    const capacity = Number(request.headers['content-length'] ?? fileLimit);
    if (capacity > fileLimit) throw new AudioRequestError(413, 'file_too_large');
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new AudioRequestError(415, 'unsupported_audio');
    if (inflight >= 4 || used + capacity > budgetBytes) throw new AudioRequestError(503, 'audio_store_full');
    let bytes = Buffer.allocUnsafeSlow(capacity);
    used += capacity;
    inflight++;
    let refs = 1;
    const release = () => {
      if (--refs === 0) {
        bytes = null;
        used -= capacity;
      }
    };
    try {
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        if (size + chunk.length > capacity) throw new AudioRequestError(413, 'file_too_large');
        chunk.copy(bytes, size);
        size += chunk.length;
      }
      if (!request.complete) throw new AudioRequestError(400, 'incomplete_upload');
      bytes = bytes.subarray(0, size);
      const mime = wav(bytes) ? 'audio/wav' : mp3(bytes) ? 'audio/mpeg' : m4a(bytes) ? 'audio/mp4' : null;
      if (!mime) throw new AudioRequestError(415, 'unsupported_audio');
      return {
        mime, size, release,
        serve(request, response) {
          response.setHeader('Content-Type', mime);
          response.setHeader('Content-Length', size);
          if (request.method === 'HEAD') return response.end();
          refs++;
          response.once('close', release);
          response.end(bytes);
        },
      };
    } catch (error) {
      release();
      throw error;
    } finally {
      inflight--;
    }
  }
  return { receive };
}
