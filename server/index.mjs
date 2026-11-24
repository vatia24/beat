import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { AudioRequestError, createAudioStore } from './audio-store.mjs';

const defaultDist = fileURLToPath(new URL('../dist/', import.meta.url));
const roomRoute = /^\/r\/[a-f0-9]{12}\/?$/;
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const audioRoute = /^\/api\/rooms\/([a-f0-9]{12})\/audio(?:\/([a-f0-9]{32}))?$/;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function setHeaders(response) {
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'microphone=(), camera=()');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
}

function respond(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function originAllowed(request, publicOrigin) {
  const raw = request.headers.origin;
  if (!raw) return true; // Browsers send Origin on WebSocket upgrades.
  try {
    const origin = new URL(raw);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== raw) return false;
    if (publicOrigin) return origin.origin === publicOrigin;
    return origin.host === request.headers.host;
  } catch {
    return false;
  }
}

function allowApi(request, response, origin, methods, headers) {
  response.setHeader('Vary', 'Origin');
  if (!originAllowed(request, origin)) {
    respond(response, 403, { error: 'origin_denied' });
    return false;
  }
  if (origin && request.headers.origin === origin) response.setHeader('Access-Control-Allow-Origin', origin);
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', methods.join(', '));
    response.setHeader('Access-Control-Allow-Headers', headers);
    response.writeHead(204);
    response.end();
    return false;
  }
  if (!methods.includes(request.method)) {
    respond(response, 405, { error: 'method_not_allowed' });
    return false;
  }
  return true;
}

async function sendFile(request, response, pathname, dist) {
  const page = pathname === '/' || roomRoute.test(pathname);
  const decoded = decodeURIComponent(pathname);
  if (/[\\:\0]/.test(decoded)) return respond(response, 404, { error: 'not_found' });
  const filename = page ? path.join(dist, 'index.html') : path.resolve(dist, '.' + decoded);
  if (!filename.startsWith(dist + path.sep)) return respond(response, 404, { error: 'not_found' });
  const file = await stat(filename);
  if (!file.isFile()) return respond(response, 404, { error: 'not_found' });
  const mime = contentTypes[path.extname(filename)] ?? 'application/octet-stream';
  response.setHeader('Content-Type', mime);
  response.setHeader('Content-Length', file.size);
  if (!page && /-[\w-]{8,}\.[a-z0-9]+$/i.test(filename)) {
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  if (request.method === 'HEAD') return response.end();
  const stream = createReadStream(filename);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room, message, except) {
  for (const socket of room.members) {
    if (socket !== except) send(socket, message);
  }
}

function hostMatches(token, candidate) {
  if (typeof candidate !== 'string' || token.length !== candidate.length) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createBeatroomServer({
  now = () => performance.now(),
  startLeadMs = 1800,
  emptyRoomTtlMs = 6 * 60 * 60 * 1000,
  distDirectory = defaultDist,
  publicOrigin = process.env.PUBLIC_ORIGIN,
  audioBudgetBytes,
} = {}) {
  const rooms = new Map();
  const audioStore = createAudioStore(audioBudgetBytes);
  const dist = path.resolve(distDirectory);
  const origin = publicOrigin ? new URL(publicOrigin).origin : null;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });

  function releaseAudio(room) {
    room.audio?.release();
    room.audio = null;
    room.readyMembers.clear();
  }

  function readiness(room) {
    return { type: 'readiness', fileId: room.state.file.id, ready: room.readyMembers.size };
  }

  function prune() {
    const cutoff = now() - emptyRoomTtlMs;
    for (const [id, room] of rooms) {
      if (!room.members.size && room.emptySince <= cutoff) {
        releaseAudio(room);
        rooms.delete(id);
      }
    }
  }

  const server = createServer(async (request, response) => {
    setHeaders(response);
    try {
      const { pathname, searchParams } = new URL(request.url ?? '/', 'http://localhost');
      if (pathname === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
        return respond(response, 200, { ok: true });
      }
      if (pathname === '/api/rooms' && (request.method === 'POST' || request.method === 'OPTIONS')) {
        if (!allowApi(request, response, origin, ['POST'], 'Content-Type')) return;
        if (rooms.size >= 4096) prune();
        if (rooms.size >= 4096) return respond(response, 503, { error: 'server_busy' });
        let id;
        do { id = randomBytes(6).toString('hex'); } while (rooms.has(id));
        const hostToken = randomBytes(32).toString('base64url');
        const created = now();
        const state = { id, version: 0, videoId: null, file: null, playing: false, anchorServerMs: created, anchorMediaSec: 0 };
        rooms.set(id, { state, hostToken, members: new Set(), readyMembers: new Set(), audio: null, seen: new Set(), emptySince: created });
        return respond(response, 201, { roomId: id, hostToken });
      }
      const audioMatch = pathname.match(audioRoute);
      if (audioMatch) {
        const [, roomId, fileId] = audioMatch;
        if (!allowApi(request, response, origin, fileId ? ['GET', 'HEAD'] : ['PUT'], 'Content-Type, Authorization')) return;
        const room = rooms.get(roomId);
        if (!room) return respond(response, 404, { error: 'room_not_found' });
        if (fileId) {
          if (room.state.file?.id !== fileId) return respond(response, 404, { error: 'file_not_found' });
          return room.audio.serve(request, response);
        }
        const bearer = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(request.headers.authorization ?? '');
        if (!hostMatches(room.hostToken, bearer?.[1])) return respond(response, 403, { error: 'forbidden' });
        const rawVersion = searchParams.get('version');
        if (!rawVersion || !/^(0|[1-9]\d*)$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion))) {
          return respond(response, 400, { error: 'invalid_version' });
        }
        const version = Number(rawVersion);
        if (room.state.version !== version) return respond(response, 409, { error: 'stale_version', room: room.state });
        const name = (searchParams.get('name') ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 128) || 'Audio';
        const asset = await audioStore.receive(request);
        // Commands, a competing PUT or room expiry may have intervened while reading.
        if (rooms.get(roomId) !== room || room.state.version !== version) {
          asset.release();
          return rooms.has(roomId) ? respond(response, 409, { error: 'stale_version', room: room.state }) :
            respond(response, 404, { error: 'room_not_found' });
        }
        releaseAudio(room);
        const file = { id: randomBytes(16).toString('hex'), name, size: asset.size, mime: asset.mime };
        room.audio = asset;
        room.state = { ...room.state, version: version + 1, videoId: null, file, playing: false, anchorServerMs: now(), anchorMediaSec: 0 };
        broadcast(room, { type: 'state', room: room.state });
        broadcast(room, readiness(room));
        return respond(response, 200, { room: room.state });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return respond(response, 405, { error: 'method_not_allowed' });
      await sendFile(request, response, pathname, dist);
    } catch (err) {
      if (response.destroyed) return;
      if (response.headersSent) return response.destroy();
      if (err instanceof AudioRequestError) {
        if (!request.complete) response.setHeader('Connection', 'close');
        return respond(response, err.status, { error: err.message });
      }
      const status = err instanceof URIError || err instanceof TypeError ? 400 :
        ['ENOENT', 'ENOTDIR'].includes(err.code) ? 404 : 500;
      respond(response, status, { error: status === 404 ? 'not_found' : 'request_failed' });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    if (request.url?.split('?')[0] !== '/ws' || !originAllowed(request, origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });

  wss.on('connection', socket => {
    let room;
    let role;
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
    socket.on('error', () => socket.terminate());
    const joinTimeout = setTimeout(() => socket.close(1008, 'Join required'), 20_000).unref();

    function fail(code, message, requestId, snapshot = false) {
      send(socket, { type: 'error', code, message, requestId, ...(snapshot && { room: room.state }) });
    }

    socket.on('message', (bytes, binary) => {
      const received = now();
      let msg;
      try {
        if (!binary) msg = JSON.parse(bytes.toString());
      } catch { /* A malformed message must not affect room state. */ }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail('invalid_message', 'შეტყობინების ფორმატი არასწორია.');
      if (msg.type === 'ping') {
        if (!Number.isFinite(msg.t1) || !['number', 'string'].includes(typeof msg.id)) return;
        return send(socket, { type: 'pong', id: msg.id, t1: msg.t1, t2: received, t3: now() });
      }
      if (msg.type === 'join') {
        const requested = rooms.get(msg.roomId);
        if (!requested) return fail('room_not_found', 'ოთახი ვერ მოიძებნა ან მისი ვადა გავიდა.');
        if (room && room !== requested) return fail('already_joined', 'ეს კავშირი უკვე სხვა ოთახშია.');
        const isNew = !room;
        room = requested;
        role = hostMatches(room.hostToken, msg.hostToken) ? 'host' : 'guest';
        clearTimeout(joinTimeout);
        room.members.add(socket);
        send(socket, { type: 'welcome', room: room.state, role, participants: room.members.size });
        if (room.state.file) send(socket, readiness(room));
        if (isNew) broadcast(room, { type: 'presence', participants: room.members.size }, socket);
        return;
      }
      if (msg.type === 'fileReady') {
        if (!room?.state.file || msg.fileId !== room.state.file.id || typeof msg.ready !== 'boolean') return;
        if (room.readyMembers.has(socket) !== msg.ready) {
          if (msg.ready) room.readyMembers.add(socket);
          else room.readyMembers.delete(socket);
          broadcast(room, readiness(room));
        }
        return;
      }
      if (msg.type !== 'command') return fail('invalid_message', 'უცნობი შეტყობინებაა.');
      const { requestId, action, version, videoId } = msg;
      if (!room) return fail('not_joined', 'ჯერ ოთახში შედი.', requestId);
      if (role !== 'host') return fail('forbidden', 'ოთახის დაკვრას მასპინძელი მართავს.', requestId);
      if (typeof requestId !== 'string' || !requestId.length || requestId.length > 128) {
        return fail('invalid_command', 'ბრძანების იდენტიფიკატორი არასწორია.');
      }
      if (room.seen.has(requestId)) return send(socket, { type: 'state', room: room.state });
      const state = room.state;
      if (version !== state.version) return fail('stale_version', 'ოთახის მდგომარეობა განახლდა.', requestId, true);
      if (action === 'track') {
        if (typeof videoId !== 'string' || !videoIdPattern.test(videoId)) {
          return fail('invalid_video', 'ვიდეოს იდენტიფიკატორი არასწორია.', requestId);
        }
        releaseAudio(room);
        room.state = { ...state, videoId, file: null, playing: false, anchorMediaSec: 0, anchorServerMs: received };
      } else if (action === 'end' && state.file && state.playing) {
        room.state = { ...state, playing: false, anchorMediaSec: 0, anchorServerMs: received };
      } else if (action === 'play' || action === 'pause') {
        if (!state.videoId && !state.file) return fail('no_track', 'ჯერ აირჩიე ტრეკი.', requestId);
        const playing = action === 'play';
        if (state.playing === playing) return fail('no_change', 'ოთახი უკვე ამ მდგომარეობაშია.', requestId, true);
        const elapsed = state.playing ? Math.max(0, received - state.anchorServerMs) / 1000 : 0;
        room.state = { ...state, playing, anchorMediaSec: state.anchorMediaSec + elapsed,
          anchorServerMs: received + (playing ? startLeadMs : 0) };
      } else {
        return fail('invalid_command', 'უცნობი ბრძანებაა.', requestId);
      }
      room.state.version++;
      room.seen.add(requestId);
      if (room.seen.size > 256) room.seen.delete(room.seen.values().next().value);
      broadcast(room, { type: 'state', room: room.state });
    });

    socket.on('close', () => {
      clearTimeout(joinTimeout);
      if (!room) return;
      room.members.delete(socket);
      if (!room.members.size) room.emptySince = now();
      broadcast(room, { type: 'presence', participants: room.members.size });
      if (room.readyMembers.delete(socket) && room.state.file) broadcast(room, readiness(room));
    });
  });

  const sweep = setInterval(() => {
    prune();
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 30_000).unref();

  function close() {
    clearInterval(sweep);
    for (const room of rooms.values()) releaseAudio(room);
    rooms.clear();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    const done = new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    server.closeAllConnections();
    return done;
  }
  return { server, close };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { server, close } = createBeatroomServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Beatroom listening on port ${server.address().port}`);
  });
  process.once('SIGTERM', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
}
