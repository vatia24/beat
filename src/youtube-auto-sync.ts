// YouTube's iframe reports media position, not the instant sound leaves a speaker.
// Correct only persistent, clearly audible errors to avoid repeated seek glitches.
export class YouTubeAutoSync {
  private readings: { at: number; error: number }[] = []
  private lastSeek = -Infinity
  private started = -Infinity

  reset() {
    this.readings = []
    this.started = -Infinity
  }

  sample(at: number, target: number, position: number, duration: number): number | null {
    if (this.started === -Infinity) this.started = at
    if (at - this.started < 8000 || at - this.lastSeek < 30000 ||
      !Number.isFinite(target) || !Number.isFinite(position) ||
      target < 0 || (duration > 0 && target >= duration - 2)) return null
    this.readings.push({ at, error: position - target })
    this.readings = this.readings.filter(r => at - r.at <= 4500)
    if (this.readings.length < 3 || at - this.readings[0].at < 1500) return null
    const errors = this.readings.map(r => r.error).sort((a, b) => a - b)
    const middle = errors[Math.floor(errors.length / 2)]
    if (Math.abs(middle) < 0.65 || errors.at(-1)! - errors[0] > 0.25) return null
    this.lastSeek = at
    this.readings = []
    this.started = at
    return Math.max(0, target)
  }
}
