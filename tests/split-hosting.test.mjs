import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createBeatroomServer } from '../server/index.mjs';

test('room creation, browser preflight and WebSocket join from a separate frontend origin', async t => {
  const frontend = 'https://my-beatroom.vercel.app';
  const other = 'https://other-project.vercel.app';
  const app = createBeatroomServer({ publicOrigin: frontend });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const backend = new URL('http://127.0.0.1:' + app.server.address().port);
  const rooms = new URL('/api/rooms', backend);

  const preflight = await fetch(rooms, {
    method: 'OPTIONS',
    headers: { Origin: frontend, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), frontend);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');
  assert.equal(preflight.headers.get('access-control-allow-headers')?.toLowerCase(), 'content-type');

  for (const method of ['OPTIONS', 'POST']) {
    const denied = await fetch(rooms, { method, headers: { Origin: other } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.equal(denied.headers.get('vary'), 'Origin');
  }

  const created = await fetch(rooms, { method: 'POST', headers: { Origin: frontend } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('access-control-allow-origin'), frontend);
  assert.equal(created.headers.get('vary'), 'Origin');
  const { roomId, hostToken } = await created.json();
  const socketUrl = new URL('/ws', backend);
  socketUrl.protocol = 'ws:';
  const host = new WebSocket(socketUrl, { origin: frontend });
  await once(host, 'open');
  const first = once(host, 'message');
  host.send(JSON.stringify({ type: 'join', roomId, hostToken }));
  const [frame] = await first;
  const welcome = JSON.parse(frame.toString());
  assert.equal(welcome.role, 'host');
  assert.equal(welcome.room.id, roomId);
  const rejected = new WebSocket(socketUrl, { origin: other });
  const [error] = await once(rejected, 'error');
  assert.match(error.message, /403/);
});
