import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/sync-diagnostics.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
})
const {
  localAnchorMs,
  timelineTarget,
  fileStartReady,
  interDeviceEstimateMs,
  signedErrorMs,
} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'))

const room = {
  id: 'abc',
  version: 2,
  videoId: null,
  file: { id: 'f1', name: 'x', mime: 'audio/wav', size: 1 },
  playing: true,
  anchorServerMs: 1000,
  anchorMediaSec: 0,
}

test('decoded guests without a fresh clock are not start-ready', () => {
  assert.equal(fileStartReady({ decoded: true, running: true, clockOk: false }), false)
  assert.equal(fileStartReady({ decoded: true, running: true, clockOk: true }), true)
})

test('manual offset applies ahead on the room target consistently', () => {
  assert.equal(localAnchorMs(1000, 20), 980)
  assert.equal(localAnchorMs(1000, -15), 1015)
  assert.equal(timelineTarget(980, 0, 2000), 1.02)
  assert.equal(timelineTarget(1015, 0, 2000), 0.985)
})

test('telemetry comparison uses each sample server time, not delivery order', () => {
  const base = {
    fileId: 'f1',
    version: 2,
    playbackRate: 1,
    state: 'PLAYING',
    clockFresh: true,
    timingMethod: 'timestamp',
    manualOffsetMs: 0,
    startReady: true,
    waitHint: null,
  }
  const a = {
    participantId: 'a',
    role: 'host',
    receivedAt: 5000,
    sampleServerMs: 2000,
    payload: { ...base, serverMs: 2000, mediaSec: 1.0 },
  }
  const b = {
    participantId: 'b',
    role: 'guest',
    receivedAt: 5150,
    sampleServerMs: 2150,
    payload: { ...base, serverMs: 2150, mediaSec: 1.15 },
  }
  const result = interDeviceEstimateMs(room, a, b, 5200)
  assert.equal(result.quality, 'estimated')
  assert.ok(Math.abs(result.deltaMs) < 5)
})

test('stale samples are not compared', () => {
  const base = {
    fileId: 'f1',
    version: 2,
    serverMs: 2000,
    mediaSec: 1,
    playbackRate: 1,
    state: 'PLAYING',
    clockFresh: true,
    timingMethod: 'timestamp',
    manualOffsetMs: 0,
    startReady: true,
    waitHint: null,
  }
  const a = { participantId: 'a', role: 'host', receivedAt: 0, sampleServerMs: 2000, payload: base }
  const b = { participantId: 'b', role: 'guest', receivedAt: 100, sampleServerMs: 2000, payload: base }
  assert.equal(interDeviceEstimateMs(room, a, b, 20_000).quality, 'stale')
})

test('signed error honors intentional offset separately from residual', () => {
  const payload = {
    fileId: 'f1',
    version: 2,
    serverMs: 3000,
    mediaSec: 2.03,
    playbackRate: 1,
    state: 'PLAYING',
    clockFresh: true,
    timingMethod: 'timestamp',
    manualOffsetMs: 30,
    startReady: true,
    waitHint: null,
  }
  const err = signedErrorMs(room, payload, 3000)
  assert.ok(Math.abs(err) < 5)
  payload.manualOffsetMs = 0
  const raw = signedErrorMs(room, payload, 3000)
  assert.ok(Math.abs(raw - 30) < 5)
})
