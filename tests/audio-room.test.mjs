import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBeatroomServer } from '../server/index.mjs';

const frontend = 'https://beatroom.example';

function pcmWav() {
  const b = Buffer.alloc(48);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(4, 40);
  return b;
}
const wav = pcmWav();

test('catalog persists across room server restarts and selected audio uses file player', { timeout: 8000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beatroom-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'Song.wav'), wav);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify([
    { id: 'song-1', file: 'Song.wav', title: 'Sample Song', rights: 'Provided by catalog operator', youtubeId: 'abcdefghijk' },
  ]));
  const { room, server } = await setup(t, { catalogDirectory: directory });
  const { url, join } = await room();
  const base = 'http://127.0.0.1:' + server.address().port;
  const catalog = await fetch(base + '/api/catalog?youtubeId=abcdefghijk', { headers: { Origin: frontend } });
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).results[0].id, 'song-1');
  const host = await join(true);
  host.send({ type: 'command', action: 'catalog', catalogId: 'song-1', version: 0, requestId: 'catalog-selection' });
  const selected = (await host.next('state')).room;
  assert.equal(selected.file.id, 'song-1');
  assert.equal(selected.videoId, null);
  const sound = await fetch(url + '/song-1', { headers: { Origin: frontend } });
  assert.equal(sound.status, 200);
  assert.deepEqual(Buffer.from(await sound.arrayBuffer()), wav);
  const another = createBeatroomServer({ catalogDirectory: directory });
  t.after(() => another.close().catch(() => {}));
  another.server.listen(0, '127.0.0.1');
  await once(another.server, 'listening');
  const repeated = await fetch('http://127.0.0.1:' + another.server.address().port + '/api/catalog?q=sample');
  assert.equal((await repeated.json()).results[0].id, 'song-1');
});

test('stale readiness cannot start everyone and an old end cannot stop a new session', { timeout: 8000 }, async t => {
  let time = 100;
  const { room } = await setup(t, { now: () => time });
  const { join, put } = await room();
  const host = await join(true);
  const guest = await join(false);
  const uploaded = await put(0);
  const { room: snapshot } = await uploaded.json();
  await host.take('state');
  await guest.take('state');
  host.send({ type: 'fileReady', fileId: snapshot.file.id, ready: true });
  guest.send({ type: 'fileReady', fileId: snapshot.file.id, ready: true });
  await host.take('readiness');
  await host.take('readiness');
  time += 9000;
  host.send({ type: 'ping', id: 'fresh', t1: time });
  await host.take('pong');
  host.send({ type: 'command', action: 'play', startPolicy: 'together', version: 1, requestId: 'all' });
  assert.equal((await host.take('error')).code, 'not_ready');
  host.send({ type: 'command', action: 'play', startPolicy: 'ready', version: 1, requestId: 'some' });
  const playing = (await host.take('state')).room;
  assert.equal(playing.version, 2);
  host.send({ type: 'command', action: 'end', version: 1, requestId: 'old-end' });
  assert.equal((await host.take('error')).code, 'stale_version');
  assert.equal(playing.playing, true);
});

async function setup(t, options = {}) {
  const app = createBeatroomServer({ publicOrigin: frontend, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function room() {
    const response = await fetch(base + '/api/rooms', { method: 'POST', headers: { origin: frontend } });
    const credentials = await response.json();
    assert.equal(response.status, 201);
    const url = base + '/api/rooms/' + credentials.roomId + '/audio';
    const headers = { Origin: frontend, Authorization: 'Bearer ' + credentials.hostToken, 'Content-Type': 'audio/wav' };
    async function put(version, body = wav, more = {}) {
      return fetch(url + '?name=Beat.wav&version=' + version, { method: 'PUT', headers: { ...headers, ...more }, body });
    }
    async function join(host = false) {
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: frontend });
      const frames = on(ws, 'message');
      await once(ws, 'open');
      const send = message => ws.send(JSON.stringify(message));
      send({ type: 'join', roomId: credentials.roomId, ...(host && { hostToken: credentials.hostToken }) });
      async function next(type) {
        const item = await frames.next();
        const msg = JSON.parse(item.value[0]);
        assert.equal(msg.type, type, JSON.stringify(msg));
        return msg;
      }
      async function take(...types) {
        for (;;) {
          const item = await frames.next();
          const msg = JSON.parse(item.value[0]);
          if (types.includes(msg.type)) return msg;
        }
      }
      return { ws, next, send, take, welcome: await next('welcome') };
    }
    return { url, headers, put, join };
  }
  return { room, server: app.server };
}

test('host file upload, CORS and public bytes, independent readiness, play, rewind and source replacement', { timeout: 8000 }, async t => {
  const { room } = await setup(t);
  const { url, headers, join, put } = await room();
  const host = await join(true);
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: frontend, 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), frontend);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'PUT');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/i);
  assert.equal((await put(0, wav, { Authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await put(0, wav, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await put(-1)).status, 400);
  assert.equal((await put(0, Buffer.alloc(64, 0))).status, 415);
  assert.equal((await put(0, Buffer.alloc(32, 0), { 'content-type': 'text/plain' })).status, 415);

  const selected = await put(0);
  assert.equal(selected.status, 200);
  assert.equal(selected.headers.get('access-control-allow-origin'), frontend);
  const { room: snapshot } = await selected.json();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.playing, false);
  assert.equal(snapshot.videoId, null);
  const id = snapshot.file.id;
  assert.deepEqual(snapshot.file, { id, name: 'Beat.wav', size: wav.length, mime: 'audio/wav' });
  assert.deepEqual((await host.next('state')).room, snapshot);
  assert.deepEqual(await host.next('readiness'), { type: 'readiness', fileId: id, ready: 0 });
  const download = url + '/' + id;
  const bytes = await fetch(download, { headers: { Origin: frontend } });
  assert.equal(bytes.headers.get('access-control-allow-origin'), frontend);
  assert.equal(bytes.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), wav);
  assert.equal((await fetch(download, { method: 'HEAD', headers })).headers.get('content-length'), String(wav.length));
  assert.equal((await fetch(download, { headers: { Origin: 'https://other.example' } })).status, 403);
  const stranger = await room();
  assert.equal((await fetch(stranger.url + '/' + id)).status, 404);

  host.send({ type: 'fileReady', fileId: id, ready: true });
  assert.equal((await host.next('readiness')).ready, 1);
  const guest = await join();
  assert.equal(guest.welcome.participants, 2);
  assert.equal(guest.welcome.roster.length, 2);
  await host.next('presence');
  assert.equal((await guest.next('readiness')).ready, 1);
  host.send({ type: 'command', action: 'play', version: 1, requestId: 'p', startPolicy: 'together' });
  assert.equal((await host.next('error')).code, 'not_ready');
  host.send({ type: 'command', action: 'play', version: 1, requestId: 'p2', startPolicy: 'ready' });
  const playing = (await host.next('state')).room;
  assert.equal(playing.playing, true);
  assert.deepEqual((await guest.take('state')).room, playing);
  guest.send({ type: 'fileReady', fileId: 'stale', ready: true });
  guest.send({ type: 'fileReady', fileId: id, ready: true });
  assert.equal((await host.next('readiness')).ready, 2);
  assert.equal((await guest.next('readiness')).ready, 2);
  guest.ws.close();
  await host.next('presence');
  await host.next('participantGone');
  assert.equal((await host.next('readiness')).ready, 1);
  host.send({ type: 'command', action: 'end', version: 2, requestId: 'end' });
  const ended = (await host.next('state')).room;
  assert.equal(ended.playing, false);
  assert.equal(ended.anchorMediaSec, 0);
  assert.equal(ended.version, 3);
  assert.equal(ended.file.id, id);

  const replacement = await put(3);
  assert.equal(replacement.status, 200);
  const newId = (await host.next('state')).room.file.id;
  assert.notEqual(newId, id);
  assert.deepEqual(await host.next('readiness'), { type: 'readiness', fileId: newId, ready: 0 });
  assert.equal((await fetch(download)).status, 404);
  host.send({ type: 'command', action: 'track', videoId: 'bqcPx0KRsRM', version: 4, requestId: 'track' });
  assert.equal((await host.next('state')).room.file, null);
  assert.equal((await fetch(url + '/' + newId)).status, 404);
});

test('in-flight reservations are bounded, recover after disconnects, and cannot overwrite newer state', { timeout: 8000 }, async t => {
  const { room, server } = await setup(t, { audioBudgetBytes: wav.length * 2 });
  const { put, url, headers } = await room();
  const other = await room();
  assert.equal((await put(0)).status, 200);
  async function partial() {
    const incoming = once(server, 'request');
    const req = request(url + '?version=1', { method: 'PUT', headers: { ...headers, 'Content-Length': String(wav.length) } });
    req.on('error', () => {}); // This test deliberately aborts a partial upload.
    req.write(wav.subarray(0, 12));
    const [serverReq] = await incoming;
    return { req, serverReq };
  }
  const first = await partial();
  assert.equal((await other.put(0)).status, 503);
  const disconnected = once(first.serverReq, 'close').catch(() => {}); // abort may emit ECONNRESET first
  first.req.destroy();
  await disconnected;
  assert.equal((await other.put(0)).status, 200);

  const otherHost = await other.join(true);
  await otherHost.next('readiness');
  otherHost.send({ type: 'command', action: 'track', videoId: 'bqcPx0KRsRM', version: 1, requestId: 'release' });
  await otherHost.next('state');
  const host = await (async () => {
    const ws = new WebSocket(url.replace('http:', 'ws:').replace(/\/api\/rooms\/.*$/, '/ws'), { origin: frontend });
    await once(ws, 'open');
    const frames = on(ws, 'message');
    ws.send(JSON.stringify({ type: 'join', roomId: url.split('/')[5], hostToken: headers.Authorization.slice(7) }));
    const welcome = JSON.parse((await frames.next()).value[0].toString());
    await frames.next(); // readiness
    return { ws, frames, fileId: welcome.room.file.id, version: welcome.room.version };
  })();
  const stale = await partial();
  host.ws.send(JSON.stringify({ type: 'fileReady', fileId: host.fileId, ready: true }));
  host.ws.send(JSON.stringify({ type: 'command', action: 'play', version: host.version, requestId: 'race', startPolicy: 'ready' }));
  await host.frames.next();
  const finalResponse = once(stale.req, 'response');
  stale.req.end(wav.subarray(12));
  const [conflict] = await finalResponse;
  conflict.resume();
  assert.equal(conflict.statusCode, 409);
  assert.equal((await put(1)).status, 409);
  assert.equal((await put(2, Buffer.from('abc'))).status, 415);
  assert.equal((await put(2)).status, 200);
  assert.equal((await other.put(2)).status, 200);
});
