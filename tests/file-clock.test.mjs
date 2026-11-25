import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/file-clock.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
})
const { DriftController, OutputClock, RateHistory, startPoint, voiceAction } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
)
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} vs ${b}`)

test('future start preserves the attack, late join advances the offset to its output deadline', () => {
  const first = startPoint(12000, 0, 10000, 5.96, 6)
  near(first.when, 7.96)
  near(first.offset, 0)
  const joined = startPoint(2000, 8, 10000, 5.96, 6)
  near(joined.when, 6.08)
  near(joined.offset, 16.12)
})

test('speaker offset advances scheduled output without skipping attack samples', () => {
  const first = startPoint(11960, 0, 10000, 5.96, 6)
  near(first.offset, 0)
  near(first.when, 7.96 - 0.04)
  const joined = startPoint(1960, 8, 10000, 5.96, 6)
  near(joined.offset, 16.16)
  const delayed = startPoint(12040, 0, 10000, 5.96, 6)
  near(delayed.when, 8)
  near(delayed.offset, 0)
  const shortLead = startPoint(10020, 0, 10000, 5.96, 6)
  near(shortLead.when, 6.08)
  near(shortLead.offset, 0.1)
})

test('hidden rendering continues while a missed revision waits for clock', () => {
  const input = { canRender: true, roomPlaying: true, roomVersion: 1, appliedVersion: 1, clockFresh: false, force: false }
  assert.equal(voiceAction(input), 'keep')
  assert.equal(voiceAction({ ...input, roomVersion: 2 }), 'wait')
  assert.equal(voiceAction({ ...input, roomVersion: 2, clockFresh: true }), 'schedule')
  assert.equal(voiceAction({ ...input, roomPlaying: false }), 'stop')
  assert.equal(voiceAction({ ...input, canRender: false }), 'stop')
})

test('output mapping requires advancing, fresh timestamps and avoids double-counting latency', () => {
  const c = new OutputClock()
  let stamp = { contextTime: 0, performanceTime: 0 }
  const ctx = { currentTime: 5, baseLatency: 0.01, outputLatency: 0.03, getOutputTimestamp: () => stamp }
  near(c.read(ctx, 2000), 4.96)
  stamp = { contextTime: 4.90, performanceTime: 2050 }
  near(c.read(ctx, 2065), 4.96)
  stamp = { contextTime: 4.92, performanceTime: 2070 }
  near(c.read(ctx, 2085), 4.935)
  near(c.read(ctx, 2500), 4.96)
})

test('output positions integrate rate changes, including when a new rate is still in flight', () => {
  const history = new RateHistory(10, 5)
  history.change(12, 1.003)
  history.change(14, 0.998)
  near(history.position(11), 6)
  near(history.position(13), 8.003)
  near(history.position(15), 10.004)
})

test('a ten-minute simulation corrects both signs of 180 ppm oscillator error', () => {
  for (const ppm of [-180, 180]) {
    const control = new DriftController()
    const history = new RateHistory(0, 0)
    for (let room = 0.5; room <= 600; room += 0.5) {
      const audio = room * (1 + ppm / 1e6)
      const error = room - history.position(audio)
      const response = control.update(error, room * 1000)
      assert.ok(response && !response.restart && Math.abs(1 - response.rate) <= 0.003)
      history.change(audio, response.rate)
      if (room >= 120) assert.ok(Math.abs(error) < 0.005)
    }
  }
})

test('a transient clock spike is ignored, persistent large error of either sign requests a new anchor', () => {
  for (const sign of [-1, 1]) {
    const c = new DriftController()
    assert.equal(c.update(sign * 0.75, 0).restart, false)
    assert.equal(c.update(0, 500).restart, false)
    for (const time of [1000, 1500, 2000]) assert.equal(c.update(sign * 0.75, time).restart, false)
    assert.equal(c.update(sign * 0.75, 2500).restart, true)
  }
})
