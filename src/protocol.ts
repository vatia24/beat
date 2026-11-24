export interface AudioFileInfo {
  id: string
  name: string
  mime: string
  size: number
}

export interface RoomSnapshot {
  id: string
  version: number
  videoId: string | null
  file?: AudioFileInfo | null
  playing: boolean
  anchorServerMs: number
  anchorMediaSec: number
}

interface ClockSample {
  localMs: number
  offsetMs: number
  rttMs: number
}

const freshForMs = 20_000

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// All timestamps use a monotonic clock in milliseconds. Fixed path asymmetry
// can bias this estimate, even if every round trip gives the same result.
export class SessionClock {
  private samples: ClockSample[] = []
  private model: { localMs: number; offsetMs: number; drift: number } | null = null
  private lastReplyAt = -Infinity
  private lastEstimate = -Infinity

  add(t1: number, t2: number, t3: number, t4: number): number | null {
    if (![t1, t2, t3, t4].every(Number.isFinite) || t4 < t1 || t3 < t2) return null
    const rttMs = Math.max(0, (t4 - t1) - (t3 - t2))
    if (t4 - t1 >= freshForMs || t3 - t2 > t4 - t1 + 2) return null
    if (t4 - this.lastReplyAt >= freshForMs) this.reset()
    this.lastReplyAt = t4
    this.samples = this.samples.filter(s => s.localMs >= t4 - 180_000)
    const sample = { localMs: (t1 + t4) / 2, offsetMs: ((t2 - t1) + (t3 - t4)) / 2, rttMs }
    this.samples.push(sample)
    if (this.samples.length < 3) return rttMs

    // Retain the least queued exchange from each epoch. A robust slope
    // across well-separated epochs estimates drift without chasing each RTT.
    const epochs = new Map<number, ClockSample>()
    for (const s of this.samples) {
      const key = Math.floor(s.localMs / 8_000)
      const best = epochs.get(key)
      if (!best || s.rttMs < best.rttMs) epochs.set(key, s)
    }
    const selected = Array.from(epochs.values())
    const slopes: number[] = []
    for (let i = 0; i < selected.length; i++) {
      for (let j = i + 1; j < selected.length; j++) {
        const separation = selected[j].localMs - selected[i].localMs
        if (Math.abs(separation) >= 40_000) slopes.push((selected[j].offsetMs - selected[i].offsetMs) / separation)
      }
    }
    const drift = slopes.length >= 3 ? Math.max(-0.0003, Math.min(0.0003, median(slopes))) : 0
    const recent = this.samples.filter(s => t4 - s.localMs < 30_000)
    recent.sort((a, b) => a.rttMs - b.rttMs)
    const best = recent.slice(0, Math.min(3, recent.length))
    this.model = { localMs: t4, offsetMs: median(best.map(s => s.offsetMs + drift * (t4 - s.localMs))), drift }
    return rttMs
  }

  now(localMs: number): number | null {
    if (!this.model || localMs - this.lastReplyAt >= freshForMs) return null
    const estimate = localMs + this.model.offsetMs + this.model.drift * (localMs - this.model.localMs)
    this.lastEstimate = Math.max(estimate, this.lastEstimate)
    return this.lastEstimate
  }

  reset() {
    this.samples = []
    this.model = null
    this.lastReplyAt = -Infinity
    this.lastEstimate = -Infinity
  }
}
