import * as THREE from 'three'
import { clamp } from '../engine/math'

const _p = new THREE.Vector3()

/**
 * Screen-space "power" effects requested by gameplay; the PowerFX post effect
 * reads these every frame. All timings are in real seconds so they keep their
 * punch during slow motion.
 */
export class PostState {
  flash = 0
  readonly flashColor = new THREE.Color(1, 1, 1)
  private flashDecay = 3
  /** 0 = off, 1 = inverted impact frame, 2 = threshold impact frame. */
  invert = 0
  zoom = 0
  readonly center = new THREE.Vector2(0.5, 0.5)
  lines = 0
  private linesHold = 0
  chroma = 0
  desat = 0
  desatTarget = 0
  readonly tint = new THREE.Color(1, 1, 1)
  shockStrength = 0
  shockRadius = 0
  readonly shockCenter = new THREE.Vector2(0.5, 0.5)
  /** Red edge vignette after taking damage. */
  hurt = 0
  /** Settings. */
  reduce = false
  shakeScale = 1
  private seq: number[] = []
  private seqT = 0
  private seqStep = 1 / 24

  reset() {
    this.flash = this.zoom = this.lines = this.chroma = this.desat = this.desatTarget = 0
    this.shockStrength = this.hurt = this.invert = 0
    this.seq = []
    this.tint.setRGB(1, 1, 1)
  }

  flashTo(amount: number, color: THREE.ColorRepresentation = '#ffffff', decay = 3) {
    const a = this.reduce ? amount * 0.25 : amount
    if (a >= this.flash) {
      this.flash = a
      this.flashColor.set(color)
      this.flashDecay = decay
    }
  }

  /**
   * Anime impact frames: a pattern of frame modes (1 inverted, 2 threshold,
   * 0 normal), each held for `step` seconds.
   */
  impactFrames(pattern: number[], step = 1 / 24) {
    if (this.reduce) {
      this.chroma = Math.max(this.chroma, 0.6)
      this.zoom = Math.max(this.zoom, 0.12)
      return
    }
    this.seq = pattern.slice()
    this.seqT = 0
    this.seqStep = step
    this.invert = this.seq[0] ?? 0
  }

  kickZoom(amount: number, worldPos?: THREE.Vector3, camera?: THREE.Camera) {
    this.zoom = Math.max(this.zoom, amount)
    if (worldPos && camera) this.toScreen(worldPos, camera, this.center)
    else this.center.set(0.5, 0.5)
  }

  speedLines(amount: number, hold = 0) {
    this.lines = Math.max(this.lines, amount)
    this.linesHold = Math.max(this.linesHold, hold)
  }

  kickChroma(amount: number) {
    this.chroma = Math.max(this.chroma, amount)
  }

  /** A refractive ring expanding from a world point. */
  shock(worldPos: THREE.Vector3, camera: THREE.Camera, strength = 0.03) {
    if (!this.toScreen(worldPos, camera, this.shockCenter)) return
    this.shockStrength = Math.max(this.shockStrength, strength)
    this.shockRadius = 0.02
  }

  private toScreen(p: THREE.Vector3, camera: THREE.Camera, out: THREE.Vector2) {
    _p.copy(p).project(camera)
    if (_p.z > 1) return false
    out.set(clamp(_p.x * 0.5 + 0.5, -0.5, 1.5), clamp(_p.y * 0.5 + 0.5, -0.5, 1.5))
    return true
  }

  update(rdt: number) {
    this.flash = Math.max(0, this.flash - rdt * this.flashDecay * Math.max(0.3, this.flash))
    this.zoom = Math.max(0, this.zoom - rdt * (0.6 + this.zoom * 3))
    if (this.linesHold > 0) this.linesHold -= rdt
    else this.lines = Math.max(0, this.lines - rdt * 2.5)
    this.chroma = Math.max(0, this.chroma - rdt * 2.2)
    this.desat += (this.desatTarget - this.desat) * Math.min(1, rdt * 8)
    this.hurt = Math.max(0, this.hurt - rdt * 1.4)
    if (this.shockStrength > 0) {
      this.shockRadius += rdt * 1.6
      this.shockStrength *= Math.exp(-rdt * 2.2)
      if (this.shockRadius > 1.6 || this.shockStrength < 0.001) this.shockStrength = 0
    }
    if (this.seq.length) {
      this.seqT += rdt
      const i = Math.floor(this.seqT / this.seqStep)
      if (i >= this.seq.length) {
        this.seq = []
        this.invert = 0
      } else this.invert = this.seq[i]
    }
  }
}
