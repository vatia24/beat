import { useCallback, useEffect, useRef, useState } from 'react'
import { SessionClock, type RoomSnapshot } from './protocol'
import { roomSocketUrl } from './endpoints'
import type { PlaybackSamplePayload, StoredSample } from './sync-diagnostics'

export type { RoomSnapshot } from './protocol'
export type RoomAction = 'track' | 'catalog' | 'play' | 'pause' | 'end'
export type Role = 'host' | 'guest'
export type StartPolicy = 'together' | 'ready'

type ServerMessage =
  | { type: 'welcome'; room: RoomSnapshot; role: Role; participants: number; participantId: string; roster: RosterEntry[] }
  | { type: 'state'; room: RoomSnapshot }
  | { type: 'presence'; participants: number; roster: RosterEntry[] }
  | { type: 'readiness'; fileId: string | null; ready: number }
  | { type: 'pong'; id: string; t1: number; t2: number; t3: number }
  | { type: 'participantSample'; participantId: string; role: Role; sample: PlaybackSamplePayload; receivedAt: number }
  | { type: 'participantGone'; participantId: string }
  | { type: 'error'; code: string; message: string; room?: RoomSnapshot; requestId?: string }

export interface RosterEntry {
  participantId: string
  role: Role
}

function explainError(code: string) {
  switch (code) {
    case 'room_not_found': return 'ოთახი ვერ მოიძებნა. სთხოვე მასპინძელს ახალი ბმული.'
    case 'forbidden': return 'ამ ოთახის მართვა მხოლოდ მასპინძელს შეუძლია.'
    case 'stale_version': return 'ოთახის მდგომარეობა შეიცვალა. გადაამოწმე და ხელახლა სცადე.'
    case 'invalid_video': return 'ვიდეოს ბმული ვერ ამოვიცანით.'
    case 'no_track': return 'ჯერ აირჩიე ტრეკი.'
    case 'not_ready': return 'ჯერ ყველა საჭირო ტელეფონი არ არის მზად. შეამოწმე პანელი და ხელახლა სცადე.'
    default: return 'ოთახმა მოთხოვნა ვერ შეასრულა. გადაამოწმე მდგომარეობა და ხელახლა სცადე.'
  }
}

export function useRoom(roomId: string, hostToken: string | null) {
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [role, setRole] = useState<Role>('guest')
  const [connected, setConnected] = useState(false)
  const [participants, setParticipants] = useState(0)
  const [readyCount, setReadyCount] = useState(0)
  const [participantId, setParticipantId] = useState('')
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [participantSamples, setParticipantSamples] = useState<Map<string, StoredSample>>(new Map())
  const localReady = useRef<{ fileId: string; ready: boolean } | null>(null)
  const [rtt, setRtt] = useState<number | null>(null)
  const [clockReady, setClockReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [commandPending, setCommandPending] = useState(false)
  const clock = useRef(new SessionClock())
  const socket = useRef<WebSocket | null>(null)
  const snapshot = useRef<RoomSnapshot | null>(null)
  const canControl = useRef(false)
  const pending = useRef<{ requestId: string; version: number; timeout: number } | null>(null)

  const serverNow = useCallback(() => clock.current.now(performance.now()), [])
  const reportFileReady = useCallback((fileId: string, ready: boolean) => {
    if (snapshot.current && snapshot.current.file?.id !== fileId) return
    localReady.current = { fileId, ready }
    if (snapshot.current?.file?.id === fileId && socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'fileReady', fileId, ready }))
    }
  }, [])
  const reportPlaybackSample = useCallback((payload: PlaybackSamplePayload) => {
    const ws = socket.current
    if (ws?.readyState !== WebSocket.OPEN) return
    if (snapshot.current?.file?.id !== payload.fileId || snapshot.current?.version !== payload.version) return
    ws.send(JSON.stringify({ type: 'playbackSample', ...payload }))
  }, [])
  const clearCommand = useCallback(() => {
    if (pending.current) window.clearTimeout(pending.current.timeout)
    pending.current = null
    setCommandPending(false)
  }, [])

  useEffect(() => {
    let disposed = false
    let terminal = false
    let pageInactive = false
    let retry: number | undefined
    let attempts = 0
    let sampleTimer: number | undefined
    let probeNow: (() => void) | null = null

    function resetConnection() {
      snapshot.current = null
      localReady.current = null
      canControl.current = false
      clock.current.reset()
      setConnected(false)
      setClockReady(false)
      setRtt(null)
      setParticipants(0)
      setReadyCount(0)
      setParticipantId('')
      setRoster([])
      setParticipantSamples(new Map())
      clearCommand()
    }

    function acceptSnapshot(value: RoomSnapshot) {
      if (value.id !== roomId || (snapshot.current && value.version < snapshot.current.version)) return
      if (snapshot.current?.file?.id !== value.file?.id) {
        setReadyCount(0)
        setParticipantSamples(new Map())
        }
      if (localReady.current && localReady.current.fileId !== value.file?.id) localReady.current = null
      snapshot.current = value
      setRoom(value)
      if (pending.current && value.version > pending.current.version) clearCommand()
    }

    function applyRoster(entries: RosterEntry[]) {
      setRoster(entries)
      setParticipantSamples(prev => {
        const ids = new Set(entries.map(e => e.participantId))
        let changed = false
        const next = new Map(prev)
        for (const key of prev.keys()) {
          if (!ids.has(key)) {
            next.delete(key)
            changed = true
          }
        }
        return changed ? next : prev
      })
    }

    function connect() {
      if (disposed || terminal || pageInactive || socket.current || !roomId) return
      window.clearTimeout(retry)
      let ws: WebSocket
      try {
        ws = new WebSocket(roomSocketUrl())
      } catch {
        setError('ოთახის სერვერთან კავშირი ვერ შეიქმნა. გადაამოწმე სერვერის მისამართი.')
        return
      }
      socket.current = ws
      const probes = new Map<string, number>()
      let seq = 0
      let lastReply = performance.now()

      function ping() {
        if (ws.readyState !== WebSocket.OPEN || ws !== socket.current) return
        const t1 = performance.now()
        if (t1 - lastReply >= 30_000 && probes.size >= 3) {
          ws.close(4000, 'No clock replies')
          return
        }
        const id = String(++seq)
        for (const [key, sent] of probes) if (t1 - sent > 20_000) probes.delete(key)
        probes.set(id, t1)
        const fresh = clock.current.now(t1) !== null
        setClockReady(fresh)
        if (!fresh && localReady.current?.ready) {
          const fileId = localReady.current.fileId
          localReady.current = { fileId, ready: false }
          if (snapshot.current?.file?.id === fileId) {
            ws.send(JSON.stringify({ type: 'fileReady', fileId, ready: false }))
          }
        }
        ws.send(JSON.stringify({ type: 'ping', id, t1 }))
        window.clearTimeout(sampleTimer)
        sampleTimer = window.setTimeout(ping, seq < 7 || !clock.current.now(t1) ? 300 : 2500)
      }

      ws.onopen = () => {
        if (disposed || ws !== socket.current) return
        ws.send(JSON.stringify({ type: 'join', roomId, hostToken: hostToken || undefined }))
        lastReply = performance.now()
        probeNow = ping
        ping()
      }
      ws.onmessage = event => {
        const received = performance.now()
        if (disposed || ws !== socket.current) return
        let message: ServerMessage
        try { message = JSON.parse(event.data) as ServerMessage } catch { return }
        switch (message.type) {
          case 'welcome':
            attempts = 0
            acceptSnapshot(message.room)
            canControl.current = message.role === 'host'
            setRole(message.role)
            setParticipants(message.participants)
            setParticipantId(message.participantId)
            applyRoster(message.roster)
            setConnected(true)
            setError(null)
            if (localReady.current?.fileId === message.room.file?.id && localReady.current) {
              ws.send(JSON.stringify({ type: 'fileReady', ...localReady.current }))
            }
            break
          case 'state':
            acceptSnapshot(message.room)
            break
          case 'presence':
            setParticipants(message.participants)
            applyRoster(message.roster)
            break
          case 'readiness':
            if (message.fileId === snapshot.current?.file?.id) setReadyCount(message.ready)
            break
          case 'participantSample':
            if (message.sample.fileId !== snapshot.current?.file?.id) break
            setParticipantSamples(prev => {
              const next = new Map(prev)
              next.set(message.participantId, {
                participantId: message.participantId,
                role: message.role,
                receivedAt: message.receivedAt,
                payload: message.sample,
                sampleServerMs: message.sample.serverMs,
              })
              return next
            })
            break
          case 'participantGone':
            setParticipantSamples(prev => {
              if (!prev.has(message.participantId)) return prev
              const next = new Map(prev)
              next.delete(message.participantId)
              return next
            })
            break
          case 'pong': {
            const sent = probes.get(message.id)
            if (sent === undefined || sent !== message.t1) return
            probes.delete(message.id)
            lastReply = received
            const roundTrip = clock.current.add(sent, message.t2, message.t3, received)
            if (roundTrip !== null) setRtt(roundTrip)
            const fresh = clock.current.now(received) !== null
            setClockReady(fresh)
            if (!fresh && localReady.current?.ready) {
              const fileId = localReady.current.fileId
              localReady.current = { fileId, ready: false }
              if (snapshot.current?.file?.id === fileId) {
                ws.send(JSON.stringify({ type: 'fileReady', fileId, ready: false }))
              }
            }
            break
          }
          case 'error':
            if (message.room) acceptSnapshot(message.room)
            if (!message.requestId || message.requestId === pending.current?.requestId) clearCommand()
            setError(explainError(message.code))
            if (message.code === 'room_not_found') {
              terminal = true
              setRoom(null)
              ws.close()
            }
            break
        }
      }
      ws.onclose = () => {
        if (disposed || ws !== socket.current) return
        socket.current = null
        probeNow = null
        window.clearTimeout(sampleTimer)
        resetConnection()
        if (!terminal && !pageInactive) {
          setError('სერვერთან კავშირი გაწყდა. ვცდილობთ აღდგენას.')
          const backoff = Math.min(8000, 500 * 2 ** Math.min(4, attempts++))
          retry = window.setTimeout(connect, backoff + Math.random() * 200)
        }
      }
    }

    function wake() {
      if (document.visibilityState === 'hidden') return
      pageInactive = false
      if (socket.current) probeNow?.()
      else connect()
    }
    function hidePage() {
      pageInactive = true
      window.clearTimeout(retry)
      socket.current?.close()
    }

    setRoom(null)
    setRole('guest')
    setError(null)
    resetConnection()
    connect()
    window.addEventListener('online', wake)
    window.addEventListener('pageshow', wake)
    window.addEventListener('pagehide', hidePage)
    document.addEventListener('visibilitychange', wake)
    return () => {
      disposed = true
      window.clearTimeout(retry)
      window.clearTimeout(sampleTimer)
      if (pending.current) window.clearTimeout(pending.current.timeout)
      pending.current = null
      window.removeEventListener('online', wake)
      window.removeEventListener('pageshow', wake)
      window.removeEventListener('pagehide', hidePage)
      document.removeEventListener('visibilitychange', wake)
      socket.current?.close()
      socket.current = null
    }
  }, [roomId, hostToken, clearCommand])

  const sendCommand = useCallback((action: RoomAction, videoId?: string, options?: { startPolicy?: StartPolicy; version?: number; catalogId?: string }) => {
    const ws = socket.current
    const state = snapshot.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !state || !canControl.current || pending.current) return false
    const requestId = crypto.randomUUID()
    const timeout = window.setTimeout(() => {
      clearCommand()
      setError('სერვერის დასტური არ მიგვიღია. ოთახის მდგომარეობას თავიდან ვიღებთ.')
      ws.close(4001, 'Command acknowledgment timeout')
    }, 8000)
    pending.current = { requestId, version: state.version, timeout }
    setCommandPending(true)
    setError(null)
    ws.send(JSON.stringify({
      type: 'command',
      action,
      videoId,
      ...(action === 'catalog' ? { catalogId: options?.catalogId } : {}),
      version: options?.version ?? state.version,
      requestId,
      ...(action === 'play' && state.file ? { startPolicy: options?.startPolicy ?? 'together' } : {}),
    }))
    return true
  }, [clearCommand])

  return {
    room,
    role,
    connected,
    participants,
    readyCount,
    participantId,
    roster,
    participantSamples,
    reportFileReady,
    reportPlaybackSample,
    rtt,
    clockReady,
    serverNow,
    error,
    sendCommand,
    commandPending,
  }
}
