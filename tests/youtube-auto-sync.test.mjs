import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/youtube-auto-sync.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
})
const { YouTubeAutoSync } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'))

test('small errors and single spikes do not cause YouTube seeks', () => {
  const controller = new YouTubeAutoSync()
  for (let at = 0; at < 15000; at += 350) {
    const target = at / 1000
    assert.equal(controller.sample(at, target, target + (at === 10500 ? 2 : 0.1), 180), null)
  }
})

test('persistent large error seeks at most once per 30 seconds', () => {
  const controller = new YouTubeAutoSync()
  let seeks = []
  for (let at = 0; at < 25000; at += 500) {
    const target = at / 1000
    const seek = controller.sample(at, target, target - 1, 180)
    if (seek !== null) seeks.push(seek)
  }
  assert.equal(seeks.length, 1)
  assert.ok(seeks[0] >= 8)
})
