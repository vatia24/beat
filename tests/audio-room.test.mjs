import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
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
      return { ws, next, send, welcome: await next('welcome') };
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
  assert.equal((await put(0, Buffer.from('ID3arbitrary text'))).status, 415);
  assert.equal((await put(0, wav, { 'content-type': 'text/plain' })).status, 415);

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
  host.send({ type: 'command', action: 'play', version: 1, requestId: 'p' });
  const playing = (await host.next('state')).room;
  assert.equal(playing.playing, true);
  const guest = await join();
  assert.deepEqual(guest.welcome.room, playing);
  assert.equal((await guest.next('readiness')).ready, 1);
  await host.next('presence');
  guest.send({ type: 'fileReady', fileId: 'stale', ready: true });
  guest.send({ type: 'fileReady', fileId: id, ready: true });
  assert.equal((await host.next('readiness')).ready, 2);
  assert.equal((await guest.next('readiness')).ready, 2);
  guest.ws.close();
  await host.next('presence');
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
    await frames.next(); // welcome
    await frames.next(); // readiness
    return { ws, frames };
  })();
  const stale = await partial();
  host.ws.send(JSON.stringify({ type: 'command', action: 'play', version: 1, requestId: 'race' }));
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
