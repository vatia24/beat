import { useEffect, useRef, useState } from 'react'
import { mediaFileUrl } from './endpoints'
import { DriftController, OutputClock, RateHistory, startPoint, voiceAction } from './file-clock'
import type { RoomSnapshot } from './protocol'
import { fileStartReady, localAnchorMs, timelineTarget, type PlaybackSamplePayload } from './sync-diagnostics'

const OFFSET_KEY = 'beatroom-speaker-offset'
const OFFSET_STEP_MS = 5
const OFFSET_LIMIT_MS = 250

interface Props {
  room: RoomSnapshot
  serverNow: () => number | null
  connected: boolean
  clockReady: boolean
  onTelemetry: (value: { position: number | null; state: string; duration?: number }) => void
  onReadyChange: (fileId: string, ready: boolean) => void
  onPlaybackSample: (payload: PlaybackSamplePayload) => void
}

interface Voice {
  source: AudioBufferSourceNode
  gain: GainNode
  when: number
  history: RateHistory
  controller: DriftController
}

const messages = {
  LOADING: 'ფაილი იტვირთება…',
  DECODING: 'აუდიო დაკვრისთვის მზადდება…',
  LOCKED: 'ფაილი მზადაა. ჩართე ხმა ამ ტელეფონზე.',
  INTERRUPTED: 'ხმა შეჩერებულია. გასაგრძელებლად ჩართე ხმა ამ ტელეფონზე.',
  WAITING: 'სესიის საათს ველოდებით…',
  READY: 'ტელეფონი მზადაა საერთო სტარტისთვის.',
  PAUSED: 'დაკვრა დაპაუზებულია.',
  SCHEDULED: 'საერთო სტარტი დაგეგმილია.',
  PLAYING: 'უკრავს ამ ტელეფონზე. ავტომატური სინქრონიზაცია ჩართულია.',
  ENDED: 'ფაილის დაკვრა დასრულდა.',
  ERROR: 'ფაილი ვერ მომზადდა.',
}
type PlayerState = keyof typeof messages

function loadOffset(roomId: string): number {
  try {
    const raw = sessionStorage.getItem(`${OFFSET_KEY}-${roomId}`)
    const n = raw === null ? 0 : Number(raw)
    return Number.isFinite(n) ? Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, n)) : 0
  } catch {
    return 0
  }
}

function saveOffset(roomId: string, ms: number) {
  try {
    sessionStorage.setItem(`${OFFSET_KEY}-${roomId}`, String(ms))
  } catch { /* session-only preference */ }
}

function waitFor(decoded: boolean, running: boolean, clockOk: boolean): PlaybackSamplePayload['waitFor'] {
  if (!decoded) return 'decode'
  if (!running) return 'audio'
  if (!clockOk) return 'clock'
  return null
}

export default function FilePlayer(props: Props) {
  const latest = useRef(props)
  latest.current = props
  const actions = useRef<{ enable(): void; refresh(): void; resync(): void } | null>(null)
  const [state, setState] = useState<PlayerState>('LOADING')
  const [error, setError] = useState('')
  const [canEnable, setCanEnable] = useState(true)
  const [startReady, setStartReady] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [manualOffsetMs, setManualOffsetMs] = useState(() => loadOffset(props.room.id))
  const offsetRef = useRef(manualOffsetMs)
  const fileId = props.room.file?.id
  const roomId = props.room.id

  useEffect(() => { saveOffset(roomId, manualOffsetMs) }, [roomId, manualOffsetMs])

  useEffect(() => {
    if (!fileId) return
    const id = fileId
    let disposed = false
    let context: AudioContext | null = null
    let buffer: AudioBuffer | null = null
    let voice: Voice | null = null
    const retired = new Set<Voice>()
    let outputClock = new OutputClock()
    let appliedVersion = -1
    let lastStartReady: boolean | null = null
    let lastConnected = false
    let stage: 'LOADING' | 'DECODING' | 'ERROR' = 'LOADING'
    let lastRestartMs = -Infinity
    let lastReportedState: PlayerState = 'LOADING'
    let playerState: PlayerState = 'LOADING'
    let lastSampleAt = 0
    let dirty = true
    const abort = new AbortController()
    setError('')
    setStartReady(false)
    setCanEnable(true)


    function emitSample(
      playerState: PlayerState,
      position: number | null,
      rate = voice?.source.playbackRate.value ?? 1,
      force = false,
    ) {
      const { room, connected, clockReady, serverNow, onPlaybackSample } = latest.current
      const nowMs = performance.now()
      const important = force || playerState !== lastReportedState || (dirty && nowMs - lastSampleAt >= 500) || nowMs - lastSampleAt >= 5000
      if (!important) return
      lastReportedState = playerState
      lastSampleAt = nowMs
      dirty = false
      const running = context?.state === 'running'
      const clockOk = connected && clockReady && serverNow() !== null
      const sampleServerMs = serverNow()
      onPlaybackSample({
        fileId: id,
        version: room.version,
        serverMs: sampleServerMs,
        mediaSec: position,
        playbackRate: rate,
        state: playerState,
        clockFresh: clockOk,
        timingMethod: outputClock.method,
        manualOffsetMs: offsetRef.current,
        startReady: !!buffer && running && clockOk,
        waitFor: waitFor(!!buffer, !!running, clockOk),
      })
    }

    function report(next: PlayerState, position: number | null = null, forceSample = false) {
      playerState = next
      setState(next)
      latest.current.onTelemetry({ state: next, position, duration: buffer?.duration })
      emitSample(next, position, voice?.source.playbackRate.value ?? 1, forceSample)
    }

    function release(v: Voice) {
      try { v.source.stop() } catch { /* It has already ended. */ }
      v.source.disconnect()
      v.gain.disconnect()
    }

    function stop() {
      if (voice) release(voice)
      voice = null
      for (const v of retired) release(v)
      retired.clear()
      appliedVersion = -1
    }

    function schedule(room: RoomSnapshot, serverMs: number, outputSec: number) {
      const ctx = context!
      const audio = buffer!
      const { when, offset } = startPoint(
        localAnchorMs(room.anchorServerMs, offsetRef.current),
        room.anchorMediaSec,
        serverMs,
        outputSec,
        ctx.currentTime,
      )
      const old = voice
      appliedVersion = room.version
      lastRestartMs = performance.now()
      if (offset >= audio.duration) {
        if (old) release(old)
        voice = null
        return
      }
      const source = ctx.createBufferSource()
      source.buffer = audio
      const gain = ctx.createGain()
      source.connect(gain).connect(ctx.destination)
      if (offset > 0.001) {
        gain.gain.setValueAtTime(0, when)
        gain.gain.linearRampToValueAtTime(1, when + 0.006)
      }
      if (old) {
        if (old.when >= ctx.currentTime || old.when >= when) {
          release(old)
        } else {
          old.gain.gain.cancelScheduledValues(when)
          old.gain.gain.setValueAtTime(1, when)
          old.gain.gain.linearRampToValueAtTime(0, when + 0.006)
          retired.add(old)
          old.source.onended = () => { retired.delete(old); old.source.disconnect(); old.gain.disconnect() }
          old.source.stop(when + 0.006)
        }
      }
      voice = { source, gain, when, history: new RateHistory(when, offset), controller: new DriftController() }
      source.start(when, offset)
      dirty = true
      emitSample('SCHEDULED', offset, 1, true)
    }

    function tick(force = false) {
      if (disposed) return
      const { room, connected, clockReady, serverNow, onReadyChange } = latest.current
      const running = context?.state === 'running'
      const nowMs = performance.now()
      const serverMs = connected ? serverNow() : null
      const clockOk = clockReady && serverMs !== null
      const ready = fileStartReady({ decoded: !!buffer, running: !!running, clockOk })
      const canPlay = !!buffer && running
      setCanEnable(!running)
      if (ready !== lastStartReady || (connected && !lastConnected)) {
        lastStartReady = ready
        setStartReady(ready)
        onReadyChange(id, ready)
        emitSample(playerState, voice && context && running ? voice.history.position(outputClock.read(context, nowMs)) : null, 1, true)
      }
      lastConnected = connected

      if (!canPlay || !buffer || !context) {
        if (voice && context?.state !== 'running') stop()
        if (!buffer) return report(stage)
        return report(context ? 'INTERRUPTED' : 'LOCKED')
      }

      const outputSec = outputClock.read(context, nowMs)

      const action = voiceAction({ canRender: true, roomPlaying: room.playing, roomVersion: room.version,
        appliedVersion, clockFresh: serverMs !== null, force })
      if (action === 'stop') {
        if (voice) stop()
        appliedVersion = -1
        return report(room.anchorMediaSec > 0 ? 'PAUSED' : 'READY', Math.min(buffer.duration, room.anchorMediaSec))
      }

      if (action === 'wait') {
        if (voice) stop()
        return report('WAITING')
      }
      if (action === 'schedule' && serverMs !== null) schedule(room, serverMs, outputSec)
      if (!voice) return report('ENDED', buffer.duration)
      if (outputSec < voice.when) return report('SCHEDULED')
      const position = voice.history.position(outputSec)
      if (position >= buffer.duration) return report('ENDED', buffer.duration, true)
      report('PLAYING', position)
      if (serverMs === null || nowMs - lastRestartMs < 800) return
      const target = timelineTarget(localAnchorMs(room.anchorServerMs, offsetRef.current), room.anchorMediaSec, serverMs)
      const correction = voice.controller.update(target - position, nowMs)
      if (!correction) return
      if (correction.restart && nowMs - lastRestartMs >= 5000) {
        schedule(room, serverMs, outputSec)
        return
      }
      const changeAt = context.currentTime
      voice.source.playbackRate.setValueAtTime(correction.rate, changeAt)
      voice.history.change(changeAt, correction.rate)
      if (Math.abs(target - position) > 0.08) dirty = true
    }

    function enable() {
      if (disposed) return
      try {
        if (!context || context.state === 'closed') {
          context = new AudioContext({ latencyHint: 'interactive' })
          context.onstatechange = () => {
            if (context?.state !== 'running') {
              stop()
              outputClock = new OutputClock()
            }
            tick()
          }
        }
        const resumed = context.resume()
        void resumed.then(() => { if (!disposed) { setError(''); tick() } }).catch(() => {
          if (!disposed) setError('ხმის ჩართვა ვერ მოხერხდა. დაბრუნდი გვერდზე და კვლავ შეეხე ღილაკს.')
        })
        tick()
      } catch {
        setError('ამ ბრაუზერში აუდიოს ჩართვა ვერ მოხერხდა.')
      }
    }

    async function preload() {
      try {
        const response = await fetch(mediaFileUrl(roomId, id), { signal: abort.signal })
        if (!response.ok) throw new Error()
        const bytes = await response.arrayBuffer()
        if (disposed) return
        stage = 'DECODING'
        tick()
        const decoder = new OfflineAudioContext(1, 1, 48000)
        const decoded = await decoder.decodeAudioData(bytes)
        if (disposed) return
        buffer = decoded
        tick()
      } catch {
        if (disposed) return
        const why = stage === 'DECODING'
          ? 'ეს ტელეფონი ფაილს ვერ კითხულობს. სცადე სხვა MP3 ან WAV ფაილი.'
          : 'ჩამოტვირთვა ვერ დასრულდა. შეამოწმე კავშირი და ხელახლა სცადე.'
        stage = 'ERROR'
        setError(why)
        tick()
      }
    }

    actions.current = { enable, refresh: () => tick(), resync: () => tick(true) }
    const visibility = () => { tick() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pageshow', visibility)
    const timer = window.setInterval(tick, 250)
    tick()
    void preload()
    return () => {
      disposed = true
      abort.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pageshow', visibility)
      actions.current = null
      if (lastStartReady) latest.current.onReadyChange(id, false)
      stop()
      buffer = null
      if (context) {
        context.onstatechange = null
        void context.close().catch(() => {})
      }
    }
  }, [roomId, fileId, attempt])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      offsetRef.current = manualOffsetMs
      if (props.room.playing) actions.current?.resync()
      else actions.current?.refresh()
    }, 400)
    return () => window.clearTimeout(timer)
  }, [manualOffsetMs])

  useEffect(() => { actions.current?.refresh() }, [props.room.version, props.connected, props.clockReady])

  function shiftOffset(deltaMs: number) {
    setManualOffsetMs(v => Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, v + deltaMs)))
    actions.current?.refresh()
  }

  return <section className="panel player-panel" aria-label="აუდიოფაილის პლეერი">
    <div className="panel-heading"><h2 className="panel-title">აუდიოფაილის პლეერი</h2></div>
    <p className="status-note" style={{ overflowWrap: 'anywhere' }}>{props.room.file?.name}</p>
    <p className="status-note">თითოეულ ტელეფონში ხმის გამოსვლა შეიძლება ოდნავ განსხვავდებოდეს. მცირე სინქრონიზაცია აქ ავტომატურია.</p>
    <div className="player-controls">
      {canEnable && state !== 'ERROR' && <button className="btn btn-primary" onClick={() => actions.current?.enable()}>ხმის ჩართვა ამ ტელეფონზე</button>}
      <button className="btn btn-secondary" disabled={!startReady || !props.room.playing || !props.connected || state === 'WAITING' || state === 'ENDED'}
        onClick={() => actions.current?.resync()}>ხელახლა სინქრონიზაცია</button>
      {state === 'ERROR' && <button className="btn btn-secondary" onClick={() => setAttempt(n => n + 1)}>ხელახლა ჩატვირთვა</button>}
    </div>
  <details className="speaker-offset">
      <summary>ამ დინამიკის დროებითი გასწორება</summary>
      <p className="status-note">„დაგვიანებულად ჟღერს“ — ხმას ადრე გაიტანს. „ადრე ჟღერს“ — უკან გადაიწევს.</p>
      <div className="offset-controls">
        <button type="button" className="btn btn-secondary" onClick={() => shiftOffset(OFFSET_STEP_MS)}>დინამიკი დაგვიანებულად ჟღერს</button>
        <button type="button" className="btn btn-secondary" onClick={() => shiftOffset(-OFFSET_STEP_MS)}>დინამიკი ადრე ჟღერს</button>
        <span aria-live="polite">{manualOffsetMs > 0 ? '+' : ''}{manualOffsetMs} ms</span>
        <button type="button" className="btn btn-secondary" onClick={() => { setManualOffsetMs(0); actions.current?.refresh() }}>განულება</button>
      </div>
    </details>
    <p className="status-note" role="status">{error || messages[state]}</p>
  </section>
}
