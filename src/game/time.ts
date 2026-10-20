import { clamp } from '../engine/math'

/**
 * Two clocks: the world and the player. Hitstop freezes both for a few frames;
 * "divine time" slows the world while the player keeps full speed; cinematic
 * slow motion slows both; time stop freezes the world entirely.
 */
export class TimeCtl {
  /** Current scales (after easing). */
  world = 1
  player = 1
  /** Seconds of real time elapsed in-game. */
  real = 0
  /** Accumulated world time. */
  worldClock = 0
  private freezeLeft = 0
  private divineLeft = 0
  private divineScale = 1
  private divineLen = 1
  private slowLeft = 0
  private slowScale = 1
  private stopped = false
  /** Externally forced world scale (pause-like cinematics). */
  override: number | null = null

  /** Hitstop: freeze everything for `sec` real seconds. */
  freeze(sec: number) {
    this.freezeLeft = Math.max(this.freezeLeft, sec)
  }

  /** World slows to `scale` for `sec` real seconds, player unaffected. */
  divine(sec: number, scale: number) {
    if (this.divineLeft > 0 && scale > this.divineScale) {
      this.divineLeft = Math.max(this.divineLeft, sec)
      return
    }
    this.divineLeft = sec
    this.divineLen = sec
    this.divineScale = scale
  }

  /** Everything slows (cinematic beats). */
  slowmo(sec: number, scale: number) {
    this.slowLeft = Math.max(this.slowLeft, sec)
    this.slowScale = scale
  }

  stop(on: boolean) {
    this.stopped = on
  }

  get isStopped() {
    return this.stopped
  }

  get divineActive() {
    return this.divineLeft > 0
  }

  /** 0..1 strength of the current divine time (for post effects). */
  get divineAmount() {
    if (this.divineLeft <= 0) return 0
    const k = this.divineLeft / this.divineLen
    return clamp(k * 4, 0, 1) * clamp((1 - this.divineScale) * 1.4, 0, 1)
  }

  reset() {
    this.freezeLeft = this.divineLeft = this.slowLeft = 0
    this.stopped = false
    this.override = null
    this.world = this.player = 1
  }

  /** Advance by a real frame; returns [worldDt, playerDt]. */
  update(rdt: number): [number, number] {
    this.real += rdt
    let w = 1
    let p = 1
    if (this.divineLeft > 0) {
      this.divineLeft -= rdt
      // ease back to full speed over the final 30%
      const k = clamp(this.divineLeft / (this.divineLen * 0.3), 0, 1)
      w = Math.min(w, this.divineScale + (1 - this.divineScale) * (1 - k))
    }
    if (this.slowLeft > 0) {
      this.slowLeft -= rdt
      w = Math.min(w, this.slowScale)
      p = Math.min(p, this.slowScale)
    }
    if (this.stopped) w = 0
    if (this.override !== null) w = this.override
    if (this.freezeLeft > 0) {
      this.freezeLeft -= rdt
      w = Math.min(w, 0.02)
      p = Math.min(p, 0.02)
    }
    this.world = w
    this.player = p
    const wdt = rdt * w
    this.worldClock += wdt
    return [wdt, rdt * p]
  }
}
