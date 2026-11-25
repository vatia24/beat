import type { RoomSnapshot } from './protocol'

export type TimingMethod = 'timestamp' | 'latency' | 'unavailable'

export interface PlaybackSamplePayload {
  fileId: string
  version: number
  serverMs: number | null
  mediaSec: number | null
  playbackRate: number
  state: string
  clockFresh: boolean
  timingMethod: TimingMethod
  manualOffsetMs: number
  startReady: boolean
  waitFor: 'decode' | 'audio' | 'clock' | null
}

export interface StoredSample {
  participantId: string
  role: 'host' | 'guest'
  receivedAt: number
  payload: PlaybackSamplePayload
  sampleServerMs: number | null
}

// A positive adjustment advances this phone's audible timeline.
export const localAnchorMs = (anchorServerMs: number, offsetMs: number) => anchorServerMs - offsetMs
export const timelineTarget = (anchorMs: number, anchorSec: number, serverMs: number) =>
  anchorSec + Math.max(0, (serverMs - anchorMs) / 1000)

// manualOffsetMs > 0 compensates for a late-sounding output: play ahead of the room timeline
// without skipping attack samples at a scheduled start (see startPoint in file-clock.ts).
export function roomMediaTarget(room: RoomSnapshot, serverMs: number | null): number | null {
  if (serverMs === null || !room.file) return null
  return room.anchorMediaSec + (room.playing ? Math.max(0, (serverMs - room.anchorServerMs) / 1000) : 0)
}

export function fileStartReady(parts: { decoded: boolean; running: boolean; clockOk: boolean }) {
  return parts.decoded && parts.running && parts.clockOk
}

export function signedErrorMs(
  room: RoomSnapshot,
  payload: PlaybackSamplePayload,
  atServerMs: number | null,
  includeManualOffset = true,
): number | null {
  if (payload.fileId !== room.file?.id || payload.version !== room.version) return null
  if (!payload.clockFresh || payload.state !== 'PLAYING' || payload.mediaSec === null || atServerMs === null) return null
  const target = roomMediaTarget(room, atServerMs)
  if (target === null) return null
  const expected = includeManualOffset
    ? timelineTarget(localAnchorMs(room.anchorServerMs, payload.manualOffsetMs), room.anchorMediaSec, atServerMs)
    : target
  return (payload.mediaSec - expected) * 1000
}

const sampleFreshMs = 8000

export function interDeviceEstimateMs(
  room: RoomSnapshot,
  a: StoredSample,
  b: StoredSample,
  nowMs: number,
): { deltaMs: number | null; quality: 'estimated' | 'stale' | 'unavailable' } {
  if (a.payload.fileId !== b.payload.fileId || a.payload.version !== b.payload.version) {
    return { deltaMs: null, quality: 'unavailable' }
  }
  if (nowMs - a.receivedAt > sampleFreshMs || nowMs - b.receivedAt > sampleFreshMs) {
    return { deltaMs: null, quality: 'stale' }
  }
  const errA = signedErrorMs(room, a.payload, a.sampleServerMs, true)
  const errB = signedErrorMs(room, b.payload, b.sampleServerMs, true)
  if (errA === null || errB === null) return { deltaMs: null, quality: 'unavailable' }
  return { deltaMs: errA - errB, quality: 'estimated' }
}
