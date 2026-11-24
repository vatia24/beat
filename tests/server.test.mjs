import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createBeatroomServer } from '../server/index.mjs';

async function fixture(t, options = {}) {
  const app = createBeatroomServer(options);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const origin = options.publicOrigin || base;
  async function createRoom() {
    const response = await fetch(base + '/api/rooms', { method: 'POST', headers: { origin } });
    assert.equal(response.status, 201);
    return response.json();
  }
  async function connect() {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin });
    const received = [];
    ws.on('message', data => received.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    const next = async type => {
      const deadline = Date.now() + 1500;
      while (!received.length && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const msg = received.shift();
      assert.equal(msg?.type, type, JSON.stringify(msg));
      return msg;
    };
    return { ws, next, send: msg => ws.send(JSON.stringify(msg)) };
  }
  return { base, createRoom, connect };
}

test('room clock, authorization, idempotency, pause and independent late join', async t => {
  let clock = 1000;
  const { createRoom, connect } = await fixture(t, { now: () => clock });
  const { roomId, hostToken } = await createRoom();
  const host = await connect();
  const guest = await connect();
  host.send({ type: 'join', roomId, hostToken });
  const welcome = await host.next('welcome');
  assert.equal(welcome.role, 'host');
  assert.equal(welcome.room.version, 0);
  assert.equal(welcome.participants, 1);
  guest.send({ type: 'join', roomId, hostToken: 'wrong' });
  assert.equal((await guest.next('welcome')).role, 'guest');
  assert.equal((await host.next('presence')).participants, 2);

  guest.send({ type: 'ping', id: 123, t1: 9 });
  assert.deepEqual(await guest.next('pong'), { type: 'pong', id: 123, t1: 9, t2: clock, t3: clock });
  const select = { type: 'command', action: 'track', videoId: 'bqcPx0KRsRM', requestId: 'A', version: 0 };
  guest.send(select);
  assert.equal((await guest.next('error')).code, 'forbidden');
  host.send(select);
  const selected = (await host.next('state')).room;
  assert.equal(selected.videoId, select.videoId);
  assert.equal(selected.version, 1);
  assert.deepEqual((await guest.next('state')).room, selected);
  host.send(select);
  assert.deepEqual((await host.next('state')).room, selected);
  host.send({ type: 'command', action: 'play', requestId: 'B', version: 0 });
  const stale = await host.next('error');
  assert.equal(stale.code, 'stale_version');
  assert.deepEqual(stale.room, selected);

  const command = (action, version, requestId) => host.send({ type: 'command', action, version, requestId });
  command('play', 1, 'C');
  const playing = (await host.next('state')).room;
  assert.deepEqual((await guest.next('state')).room, playing);
  assert.equal(playing.anchorServerMs, clock + 1800);
  assert.equal(playing.anchorMediaSec, 0);
  assert.equal(playing.playing, true);
  assert.equal(playing.version, 2);

  clock = playing.anchorServerMs + 600_000;
  const third = await connect();
  third.send({ type: 'join', roomId });
  const midSong = await third.next('welcome');
  assert.equal(midSong.participants, 3);
  assert.deepEqual(midSong.room, playing);
  assert.equal((clock - midSong.room.anchorServerMs) / 1000, 600);
  assert.equal((await host.next('presence')).participants, 3);
  assert.equal((await guest.next('presence')).participants, 3);
  third.ws.close();
  assert.equal((await host.next('presence')).participants, 2);
  assert.equal((await guest.next('presence')).participants, 2);

  command('pause', 2, 'D');
  const paused = (await host.next('state')).room;
  assert.deepEqual((await guest.next('state')).room, paused);
  assert.equal(paused.playing, false);
  assert.equal(paused.anchorMediaSec, 600);
  command('play', 3, 'E');
  assert.equal((await host.next('state')).room.anchorMediaSec, 600);
  await guest.next('state');
  command('pause', 4, 'F'); // Cancel the scheduled start before the deadline.
  const cancelled = (await host.next('state')).room;
  assert.equal(cancelled.anchorMediaSec, 600);
  await guest.next('state');
  host.ws.close();
  assert.equal((await guest.next('presence')).participants, 1);
  const reconnected = await connect();
  reconnected.send({ type: 'join', roomId, hostToken });
  const restored = await reconnected.next('welcome');
  assert.equal(restored.role, 'host');
  assert.deepEqual(restored.room, cancelled);
});

test('static room routes, HTTPS room origin, microphone policy and missing room', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'beatroom-static-'));
  await writeFile(path.join(folder, 'index.html'), '<title>Beatroom</title>');
  t.after(() => rm(folder, { recursive: true, force: true }));
  const origin = 'https://beatroom.example';
  const { base, createRoom, connect } = await fixture(t, { distDirectory: folder, publicOrigin: origin });
  assert.equal((await fetch(base + '/api/rooms', { method: 'POST', headers: { origin: 'https://wrong.example' } })).status, 403);
  const rejected = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: 'https://wrong.example' });
  const [error] = await once(rejected, 'error');
  assert.match(error.message, /403/);
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true });
  const { roomId } = await createRoom();
  const page = await fetch(base + '/r/' + roomId);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('permissions-policy'), /microphone=\(\)/);
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(await page.text(), '<title>Beatroom</title>');
  assert.equal((await fetch(base + '/assets/missing.js')).status, 404);
  const visitor = await connect();
  visitor.send({ type: 'join', roomId: 'missing' });
  assert.equal((await visitor.next('error')).code, 'room_not_found');
});
