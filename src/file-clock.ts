// Map the audio output stream clock back to the browser's monotonic clock.
// A timestamp and a latency estimate are alternative mappings. Neither sees
// unreported device DSP or the acoustic path from speaker to listener.
export class OutputClock {
  private previous: AudioTimestamp | null = null
  private advancing = false
  usingTimestamp = false

  read(ctx: AudioContext, nowMs: number): number {
    const stamp = ctx.getOutputTimestamp?.()
    if (stamp && typeof stamp.contextTime === 'number' && typeof stamp.performanceTime === 'number') {
      const age = nowMs - stamp.performanceTime
      const valid = stamp.contextTime > 0 && stamp.performanceTime > 0 && age >= -25 && age < 250
      if (valid && this.previous) {
        if (stamp.contextTime > this.previous.contextTime! && stamp.performanceTime > this.previous.performanceTime!)
          this.advancing = true
        if (stamp.contextTime < this.previous.contextTime! || stamp.performanceTime < this.previous.performanceTime!)
          this.advancing = false
      }
      if (!valid) this.advancing = false
      this.previous = valid ? stamp : null
      const estimated = stamp.contextTime + age / 1000
      if (this.advancing && estimated >= 0 && estimated < ctx.currentTime + 0.03) {
        this.usingTimestamp = true
        return estimated
      }
    }
    this.usingTimestamp = false
    const latency = (v: number) => Number.isFinite(v) && v >= 0 && v <= 2 ? v : 0
    return ctx.currentTime - latency(ctx.baseLatency) - latency(ctx.outputLatency)
  }
}

export function startPoint(anchorMs: number, anchorSec: number, serverMs: number, outputSec: number, renderSec: number) {
  // A late participant starts a little in the future at the position the room
  // will reach then. A start announced sufficiently far ahead keeps offset zero.
  const delaySec = Math.max((anchorMs - serverMs) / 1000, renderSec - outputSec + 0.08)
  return {
    when: outputSec + delaySec,
    offset: anchorSec + Math.max(0, (serverMs - anchorMs) / 1000 + delaySec),
  }
}

// Changes take effect on the render clock. Position at the estimated output
// time can still refer to an older rate while those samples are in flight.
export class RateHistory {
  private segments: { time: number; position: number; rate: number }[]
  constructor(time: number, position: number) {
    this.segments = [{ time, position, rate: 1 }]
  }
  position(time: number): number {
    let i = this.segments.length - 1
    while (i > 0 && this.segments[i].time > time) i--
    const segment = this.segments[i]
    return segment.position + Math.max(0, time - segment.time) * segment.rate
  }
  change(time: number, rate: number) {
    this.segments.push({ time, position: this.position(time), rate })
    while (this.segments.length > 2 && this.segments[1].time < time - 5) this.segments.shift()
  }
}

export class DriftController {
  private phase = 0
  private largeSince = 0
  private direction = 0
  private rate = 1
  private lastUpdate = -Infinity
  update(errorSec: number, nowMs: number): { rate: number; restart: boolean } | null {
    if (nowMs - this.lastUpdate < 450) return null
    this.lastUpdate = nowMs
    this.phase += (errorSec - this.phase) * 0.3
    const direction = Math.abs(errorSec) >= 0.10 ? Math.sign(errorSec) : 0
    if (!direction || direction !== this.direction) this.largeSince = nowMs
    this.direction = direction
    const desired = 1 + (Math.abs(this.phase) < 0.003 ? 0 : Math.max(-0.003, Math.min(0.003, this.phase / 6)))
    this.rate += 0.35 * (desired - this.rate)
    return { rate: this.rate, restart: !!direction && nowMs - this.largeSince >= 1500 }
  }
}
