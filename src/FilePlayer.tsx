import { useEffect, useRef, useState } from 'react'
import { mediaFileUrl } from './endpoints'
import { DriftController, OutputClock, RateHistory, startPoint } from './file-clock'
import type { RoomSnapshot } from './protocol'

interface Props {
  room: RoomSnapshot
  serverNow: () => number | null
  connected: boolean
  onTelemetry: (value: { position: number | null; state: string; duration?: number }) => void
  onReadyChange: (fileId: string, ready: boolean) => void
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
  HIDDEN: 'დაკვრა განახლდება გვერდზე დაბრუნებისას.',
  WAITING: 'სესიის საათს ველოდებით…',
  READY: 'ტელეფონი მზადაა საერთო სტარტისთვის.',
  PAUSED: 'დაკვრა დაპაუზებულია.',
  SCHEDULED: 'საერთო სტარტი დაგეგმილია.',
  PLAYING: 'უკრავს ამ ტელეფონზე. ავტომატური სინქრონიზაცია ჩართულია.',
  ENDED: 'ფაილის დაკვრა დასრულდა.',
  ERROR: 'ფაილი ვერ მომზადდა.',
}
type PlayerState = keyof typeof messages

export default function FilePlayer(props: Props) {
  const latest = useRef(props)
  latest.current = props
  const actions = useRef<{ enable(): void; refresh(): void; resync(): void } | null>(null)
  const [state, setState] = useState<PlayerState>('LOADING')
  const [error, setError] = useState('')
  const [canEnable, setCanEnable] = useState(true)
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const fileId = props.room.file?.id
  const roomId = props.room.id

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
    let lastReady: boolean | null = null
    let lastConnected = false
    let stage: 'LOADING' | 'DECODING' | 'ERROR' = 'LOADING'
    let lastRestartMs = -Infinity
    const abort = new AbortController()
    setError('')
    setReady(false)
    setCanEnable(true)

    function report(state: PlayerState, position: number | null = null) {
      setState(state)
      latest.current.onTelemetry({ state, position, duration: buffer?.duration })
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
      const { when, offset } = startPoint(room.anchorServerMs, room.anchorMediaSec, serverMs, outputSec, ctx.currentTime)
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
      // Preserve the attack at the first sample. Crossfade a local rejoin.
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
    }

    function tick(force = false) {
      if (disposed) return
      const { room, connected, serverNow, onReadyChange } = latest.current
      const running = context?.state === 'running'
      const available = !document.hidden && running && !!buffer
      setCanEnable(!running)
      if (available !== lastReady || (connected && !lastConnected)) {
        lastReady = available
        setReady(available)
        onReadyChange(id, available)
      }
      lastConnected = connected
      if (!available || !buffer || !context) {
        if (voice) stop()
        if (!buffer) return report(stage)
        if (document.hidden) return report('HIDDEN')
        return report(context ? 'INTERRUPTED' : 'LOCKED')
      }
      const nowMs = performance.now()
      const outputSec = outputClock.read(context, nowMs)
      const serverMs = connected ? serverNow() : null
      if (!room.playing) {
        if (voice) stop()
        appliedVersion = -1
        return report(room.anchorMediaSec > 0 ? 'PAUSED' : 'READY', Math.min(buffer.duration, room.anchorMediaSec))
      }
      if (appliedVersion !== room.version || force) {
        if (serverMs === null) return report('WAITING')
        schedule(room, serverMs, outputSec)
      }
      if (!voice) return report('ENDED', buffer.duration)
      if (outputSec < voice.when) return report('SCHEDULED')
      const position = voice.history.position(outputSec)
      if (position >= buffer.duration) return report('ENDED', buffer.duration)
      report('PLAYING', position)
      if (serverMs === null || nowMs - lastRestartMs < 800) return
      const target = room.anchorMediaSec + Math.max(0, (serverMs - room.anchorServerMs) / 1000)
      const correction = voice.controller.update(target - position, nowMs)
      if (!correction) return
      if (correction.restart && nowMs - lastRestartMs >= 5000) {
        schedule(room, serverMs, outputSec)
        return
      }
      const changeAt = context.currentTime
      voice.source.playbackRate.setValueAtTime(correction.rate, changeAt)
      voice.history.change(changeAt, correction.rate)
    }

    function enable() {
      if (disposed) return
      try {
        if (!context || context.state === 'closed') {
          context = new AudioContext({ latencyHint: 'interactive' })
          context.onstatechange = () => {
            if (context?.state !== 'running') { stop(); outputClock = new OutputClock() }
            tick()
          }
        }
        // Must be invoked in the button's own click stack on mobile Safari.
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
        // Decode before the gesture without opening a hardware output device.
        // Each device decodes to the same sample rate, including on 44.1 kHz sinks.
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
    const visibility = () => {
      if (document.hidden) { stop(); outputClock = new OutputClock() }
      tick()
    }
    document.addEventListener('visibilitychange', visibility)
    const timer = window.setInterval(tick, 250)
    tick()
    void preload()
    return () => {
      disposed = true
      abort.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
      actions.current = null
      if (lastReady) latest.current.onReadyChange(id, false)
      stop()
      buffer = null
      if (context) {
        context.onstatechange = null
        void context.close().catch(() => {})
      }
    }
  }, [roomId, fileId, attempt])

  useEffect(() => { actions.current?.refresh() }, [props.room.version, props.connected])

  return <section className="panel player-panel" aria-label="აუდიოფაილის პლეერი">
    <div className="panel-heading"><h2 className="panel-title">აუდიოფაილის პლეერი</h2></div>
    <p className="status-note" style={{ overflowWrap: 'anywhere' }}>{props.room.file?.name}</p>
    <div className="player-controls">
      {canEnable && state !== 'ERROR' && <button className="btn btn-primary" onClick={() => actions.current?.enable()}>ხმის ჩართვა ამ ტელეფონზე</button>}
      <button className="btn btn-secondary" disabled={!ready || !props.room.playing || !props.connected || state === 'WAITING' || state === 'ENDED'}
        onClick={() => actions.current?.resync()}>ხელახლა სინქრონიზაცია</button>
      {state === 'ERROR' && <button className="btn btn-secondary" onClick={() => setAttempt(n => n + 1)}>ხელახლა ჩატვირთვა</button>}
    </div>
    <p className="status-note" role="status">{error || messages[state]}</p>
  </section>
}
