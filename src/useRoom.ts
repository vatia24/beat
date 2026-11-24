import { useCallback, useEffect, useRef, useState } from 'react'
import { SessionClock, type RoomSnapshot } from './protocol'
import { roomSocketUrl } from './endpoints'

export type { RoomSnapshot } from './protocol'
export type RoomAction = 'track' | 'play' | 'pause'
export type Role = 'host' | 'guest'

type ServerMessage =
  | { type: 'welcome'; room: RoomSnapshot; role: Role; participants: number }
  | { type: 'state'; room: RoomSnapshot }
  | { type: 'presence'; participants: number }
  | { type: 'pong'; id: string; t1: number; t2: number; t3: number }
  | { type: 'error'; code: string; message: string; room?: RoomSnapshot; requestId?: string }

function explainError(code: string) {
  switch (code) {
    case 'room_not_found': return 'ოთახი ვერ მოიძებნა. სთხოვე მასპინძელს ახალი ბმული.'
    case 'forbidden': return 'ამ ოთახის მართვა მხოლოდ მასპინძელს შეუძლია.'
    case 'stale_version': return 'ოთახის მდგომარეობა შეიცვალა. გადაამოწმე და ხელახლა სცადე.'
    case 'invalid_video': return 'ვიდეოს ბმული ვერ ამოვიცანით.'
    case 'no_track': return 'ჯერ აირჩიე YouTube ვიდეო.'
    default: return 'ოთახმა მოთხოვნა ვერ შეასრულა. გადაამოწმე მდგომარეობა და ხელახლა სცადე.'
  }
}

export function useRoom(roomId: string, hostToken: string | null) {
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [role, setRole] = useState<Role>('guest')
  const [connected, setConnected] = useState(false)
  const [participants, setParticipants] = useState(0)
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
      canControl.current = false
      clock.current.reset()
      setConnected(false)
      setClockReady(false)
      setRtt(null)
      setParticipants(0)
      clearCommand()
    }

    function acceptSnapshot(value: RoomSnapshot) {
      if (value.id !== roomId || (snapshot.current && value.version < snapshot.current.version)) return
      snapshot.current = value
      setRoom(value)
      if (pending.current && value.version > pending.current.version) clearCommand()
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
        setClockReady(clock.current.now(t1) !== null)
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
            setConnected(true)
            setError(null)
            break
          case 'state':
            acceptSnapshot(message.room)
            break
          case 'presence':
            setParticipants(message.participants)
            break
          case 'pong': {
            const sent = probes.get(message.id)
            if (sent === undefined || sent !== message.t1) return
            probes.delete(message.id)
            lastReply = received
            const roundTrip = clock.current.add(sent, message.t2, message.t3, received)
            if (roundTrip !== null) setRtt(roundTrip)
            setClockReady(clock.current.now(received) !== null)
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

  const sendCommand = useCallback((action: RoomAction, videoId?: string) => {
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
    ws.send(JSON.stringify({ type: 'command', action, videoId, version: state.version, requestId }))
    return true
  }, [clearCommand])

  return { room, role, connected, participants, rtt, clockReady, serverNow, error, sendCommand, commandPending }
}
