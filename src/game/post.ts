import * as THREE from 'three'
import { MAX_HAZE, MAX_SCREEN_CUTS, MAX_SHOCKS } from '../engine/gfx/powerfx'
import { clamp, smoothstep } from '../engine/math'
import { SUN_DIR } from './world/layout'

const _p = new THREE.Vector3()
const _cA = new THREE.Vector3()
const _cB = new THREE.Vector3()
const _c = new THREE.Vector3()
const _f = new THREE.Vector3()
const _s = new THREE.Vector2()

/**
 * Where a world point (or, with `isDir`, a direction at infinity such as the
 * sun) lands on screen, written to `out` as uv. Returns how visible a light
 * there is: 1 on screen, easing to 0 a little past the edges and behind the
 * camera, so light shafts fade instead of popping.
 */
export function lightOnScreen(p: THREE.Vector3, camera: THREE.Camera, out: THREE.Vector2, isDir = false): number {
  camera.getWorldPosition(_c)
  camera.getWorldDirection(_f)
  if (isDir) _p.copy(p).normalize()
  else _p.subVectors(p, _c).normalize()
  const facing = _p.dot(_f)
  if (facing <= 0.02) return 0
  if (isDir) _p.multiplyScalar(1000).add(_c)
  else _p.copy(p)
  _p.project(camera)
  out.set(clamp(_p.x * 0.5 + 0.5, -1, 2), clamp(_p.y * 0.5 + 0.5, -1, 2))
  const edge = Math.max(Math.abs(_p.x), Math.abs(_p.y))
  return smoothstep(0.02, 0.3, facing) * (1 - smoothstep(1, 1.7, edge))
}

/** Radius of a world-space sphere on screen, in screen heights (0 when behind). */
export function screenRadius(p: THREE.Vector3, worldRadius: number, camera: THREE.Camera) {
  _p.copy(p).applyMatrix4(camera.matrixWorldInverse)
  const z = -_p.z
  if (z <= 0.05) return 0
  // projectionMatrix[5] = 1 / tan(fov / 2)
  return (worldRadius * camera.projectionMatrix.elements[5]) / (2 * z)
}

interface Ring {
  on: boolean
  readonly world: THREE.Vector3
  x: number
  y: number
  r: number
  s: number
  speed: number
  sharp: number
  delay: number
}

interface Haze {
  on: boolean
  readonly pos: THREE.Vector3
  radius: number
  strength: number
  t: number
  dur: number
}

const HAZE_IN = 0.4
/** Blast light attack (real seconds). */
const BLAST_IN = 0.06

/** How much of a blast light is left at age `t` of `dur` (1 at the flash, easing to 0; the short attack is applied on top). */
export function blastEnvelope(t: number, dur: number) {
  const u = clamp(t / dur, 0, 1)
  return (1 - u) * (1 - u)
}

/**
 * Screen-space "power" effects requested by gameplay; the post effects read
 * these every frame. Timings are in real seconds so they keep their punch
 * during slow motion, except heat haze, which lives on world time (it is
 * a thing in the world and freezes with it).
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
  /** Red edge vignette after taking damage. */
  hurt = 0
  /** Settings. */
  reduce = false
  shakeScale = 1

  /** Stacked shock rings for the shader: xy centre, z radius, w strength. */
  readonly shockData = Array.from({ length: MAX_SHOCKS }, () => new THREE.Vector4())
  readonly shockSharp = new Array<number>(MAX_SHOCKS).fill(14)
  private rings: Ring[] = Array.from({ length: MAX_SHOCKS }, () => ({ on: false, world: new THREE.Vector3(), x: 0.5, y: 0.5, r: 0, s: 0, speed: 1.6, sharp: 14, delay: 0 }))
  /** Heat haze for the shader: xy screen position, z radius, w strength. */
  readonly hazeData = Array.from({ length: MAX_HAZE }, () => new THREE.Vector4())
  private hazes: Haze[] = Array.from({ length: MAX_HAZE }, () => ({ on: false, pos: new THREE.Vector3(), radius: 1, strength: 0, t: 0, dur: 1 }))
  /** Shimmer clock (world time). */
  hazeClock = 0
  /** Any ring / haze visible this frame (lets the shader skip its loops). */
  shockOn = false
  hazeOn = false

  /** Eclipse / sun shafts: gameplay multiplier, and where the light is this frame. */
  sunRays = 1
  readonly sunDir = SUN_DIR.clone()
  readonly sunScreen = new THREE.Vector2(0.5, 0.8)
  /** Sun-shaft visibility after the off-screen fade (0..1). */
  sunVis = 0
  /** Transient blast light: screen position and current strength. */
  readonly blastScreen = new THREE.Vector2(0.5, 0.5)
  blastRays = 0
  readonly blastColor = new THREE.Color(1, 0.86, 0.66)
  private blast = { pos: new THREE.Vector3(), strength: 0, t: 0, dur: 1 }

  /** Screen cuts for the shader: xy a point on the line (uv), z angle, w slide; and each seam's glow. */
  readonly cutData = Array.from({ length: MAX_SCREEN_CUTS }, () => new THREE.Vector4())
  readonly cutGlow = new Array<number>(MAX_SCREEN_CUTS).fill(0)
  cutOn = false
  private cuts: Array<{ on: boolean; x: number; y: number; angle: number; slide: number; t: number; dur: number; hold: number }> = Array.from({ length: MAX_SCREEN_CUTS }, () => ({
    on: false,
    x: 0.5,
    y: 0.5,
    angle: 0,
    slide: 0,
    t: 0,
    dur: 1,
    hold: 0.2,
  }))

  /** Anamorphic streak: resting level for the hottest pixels, plus kicks. */
  streakBase = 0.1
  streakKick = 0
  /** Edge chromatic fringe (uv units at the corners). */
  fringe = 0.004

  /** The camera of the last update, for world-anchored requests that don't pass one. */
  private camera: THREE.Camera | null = null
  private seq: number[] = []
  private seqT = 0
  private seqStep = 1 / 24

  reset() {
    this.flash = this.zoom = this.lines = this.chroma = this.desat = this.desatTarget = 0
    this.hurt = this.invert = 0
    this.seq = []
    this.tint.setRGB(1, 1, 1)
    for (const r of this.rings) r.on = false
    for (const h of this.hazes) h.on = false
    for (const v of this.shockData) v.set(0, 0, 0, 0)
    for (const v of this.hazeData) v.set(0, 0, 0, 0)
    this.shockOn = this.hazeOn = false
    for (const c of this.cuts) c.on = false
    for (const v of this.cutData) v.set(0, 0, 0, 0)
    this.cutGlow.fill(0)
    this.cutOn = false
    this.blast.strength = 0
    this.blastRays = 0
    this.streakKick = 0
    this.sunRays = 1
  }

  flashTo(amount: number, color: THREE.ColorRepresentation = '#ffffff', decay = 3) {
    const a = this.reduce ? amount * 0.25 : amount
    if (a >= this.flash) {
      this.flash = a
      this.flashColor.set(color)
      this.flashDecay = decay
    }
    // every flash of light also flares the lens
    this.streakKick = Math.max(this.streakKick, a * 1.2)
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

  /**
   * A refractive ring expanding from a world point. Up to MAX_SHOCKS rings
   * stack; each stays anchored to its world point as the camera moves.
   * `delay` (real seconds) staggers a volley of rings, `speed` is in screen
   * heights per second, `width` scales the band thickness.
   */
  shock(worldPos: THREE.Vector3, camera: THREE.Camera, strength = 0.03, opts: { delay?: number; speed?: number; width?: number } = {}) {
    if (!this.toScreen(worldPos, camera, _s)) return
    let ring = this.rings[0]
    for (const r of this.rings) {
      if (!r.on) {
        ring = r
        break
      }
      if (r.s < ring.s) ring = r
    }
    ring.on = true
    ring.world.copy(worldPos)
    ring.x = _s.x
    ring.y = _s.y
    ring.r = 0.02
    ring.s = strength
    ring.speed = opts.speed ?? 1.6
    ring.sharp = 14 / (opts.width ?? 1)
    ring.delay = opts.delay ?? 0
  }

  /** Number of shock rings alive (including delayed ones). */
  get shockCount() {
    let n = 0
    for (const r of this.rings) if (r.on) n++
    return n
  }

  /**
   * Heat shimmer over a burning area, re-projected every frame. A haze
   * requested close to one already burning refreshes and extends it, so a
   * moving source (a beam's footprint) can call this every tick.
   */
  haze(worldPos: THREE.Vector3, worldRadius: number, strength = 1, dur = 4) {
    let slot: Haze | null = null
    for (const h of this.hazes) {
      if (h.on && h.pos.distanceTo(worldPos) < Math.max(h.radius, worldRadius) * 0.6) {
        h.pos.lerp(worldPos, 0.5)
        h.radius = Math.max(h.radius, worldRadius)
        h.strength = Math.max(h.strength, strength)
        h.dur = Math.max(h.dur, h.t + dur)
        return
      }
    }
    for (const h of this.hazes) {
      if (!h.on) {
        slot = h
        break
      }
      if (!slot || h.dur - h.t < slot.dur - slot.t) slot = h
    }
    const h = slot!
    h.on = true
    h.pos.copy(worldPos)
    h.radius = worldRadius
    h.strength = strength
    h.t = 0
    h.dur = Math.max(0.5, dur)
  }

  /** Haze strength at its age `t` (fade in, hold, fade out). */
  static hazeEnvelope(t: number, dur: number) {
    const out = Math.min(1.5, dur * 0.4)
    return Math.min(1, t / HAZE_IN) * clamp((dur - t) / out, 0, 1)
  }

  /**
   * Light shafts radiating from an explosion's screen position, through
   * whatever stands in front of it. Strength ~1 for a big blast, 2+ for a
   * nuke; `dur` in real seconds.
   */
  rays(worldPos: THREE.Vector3, strength = 1, dur = 1.5, color: THREE.ColorRepresentation = '#ffdcae') {
    const s = this.reduce ? strength * 0.35 : strength
    const b = this.blast
    if (b.strength > 0) {
      // one blast light at a time: the brighter one wins, and one the camera can see beats one it can't
      let cur = b.strength * blastEnvelope(b.t, b.dur)
      let next = s
      if (this.camera) {
        cur *= lightOnScreen(b.pos, this.camera, _s) + 0.01
        next *= lightOnScreen(worldPos, this.camera, _s) + 0.01
      }
      if (next < cur) return
    }
    this.blast.pos.copy(worldPos)
    this.blast.strength = s
    this.blast.t = 0
    this.blast.dur = Math.max(0.1, dur)
    this.blastColor.set(color)
  }

  /**
   * Anamorphic lens streak kick; decays fast. With `at`, the kick scales with
   * how visible that point is (a blast behind the camera flares nothing).
   */
  streak(amount: number, at?: THREE.Vector3) {
    if (at && this.camera) amount *= lightOnScreen(at, this.camera, _s)
    this.streakKick = Math.max(this.streakKick, this.reduce ? amount * 0.35 : amount)
  }

  /** Streak strength this frame. */
  get streakAmount() {
    return this.streakBase + this.streakKick
  }

  private toScreen(p: THREE.Vector3, camera: THREE.Camera, out: THREE.Vector2) {
    _p.copy(p).project(camera)
    if (_p.z > 1) return false
    out.set(clamp(_p.x * 0.5 + 0.5, -0.5, 1.5), clamp(_p.y * 0.5 + 0.5, -0.5, 1.5))
    return true
  }

  /**
   * Slice the image itself along a screen line through (x, y) (uv) at
   * `angle` radians: the two sides slide apart along it by `slide` screen
   * heights with a white-hot seam, hold for `hold` seconds, then knit back
   * over the rest of `dur` (real seconds).
   */
  cut(x: number, y: number, angle: number, slide = 0.03, dur = 0.9, hold = 0.18) {
    if (this.reduce) slide *= 0.4
    let c = this.cuts.find((q) => !q.on)
    if (!c) c = this.cuts.reduce((a, b) => (a.t / a.dur > b.t / b.dur ? a : b))
    Object.assign(c, { on: true, x, y, angle, slide, t: 0, dur, hold })
  }

  /** A screen cut along the projection of the world segment a-b (skipped when it is behind the camera). */
  cutWorld(a: THREE.Vector3, b: THREE.Vector3, slide = 0.03, dur = 0.9, hold = 0.18, camera = this.camera) {
    if (!camera) return
    const pa = _cA.copy(a).project(camera)
    const pb = _cB.copy(b).project(camera)
    if (pa.z > 1 && pb.z > 1) return
    // pull a point that is behind the camera onto the visible side so the line keeps its direction
    if (pa.z > 1) pa.lerp(pb, 0.999)
    if (pb.z > 1) pb.lerp(pa, 0.999)
    const ax = pa.x * 0.5 + 0.5
    const ay = pa.y * 0.5 + 0.5
    const bx = pb.x * 0.5 + 0.5
    const by = pb.y * 0.5 + 0.5
    const asp = (camera as THREE.PerspectiveCamera).aspect ?? 16 / 9
    const angle = Math.atan2(by - ay, (bx - ax) * asp)
    this.cut((ax + bx) / 2, (ay + by) / 2, angle, slide, dur, hold)
  }

  /**
   * `camera` re-projects the world-anchored effects (rings, haze, light
   * shafts); `wdt` drives the haze, which lives on world time.
   */
  update(rdt: number, camera?: THREE.Camera, wdt = rdt) {
    if (camera) this.camera = camera
    this.flash = Math.max(0, this.flash - rdt * this.flashDecay * Math.max(0.3, this.flash))
    this.zoom = Math.max(0, this.zoom - rdt * (0.6 + this.zoom * 3))
    if (this.linesHold > 0) this.linesHold -= rdt
    else this.lines = Math.max(0, this.lines - rdt * 2.5)
    this.chroma = Math.max(0, this.chroma - rdt * 2.2)
    this.desat += (this.desatTarget - this.desat) * Math.min(1, rdt * 8)
    this.hurt = Math.max(0, this.hurt - rdt * 1.4)
    this.streakKick = Math.max(0, this.streakKick * Math.exp(-rdt * 5) - rdt * 0.05)

    this.cutOn = false
    for (let i = 0; i < MAX_SCREEN_CUTS; i++) {
      const c = this.cuts[i]
      const v = this.cutData[i]
      if (!c.on) {
        v.w = 0
        this.cutGlow[i] = 0
        continue
      }
      c.t += rdt
      // snaps open in a few frames, holds, then eases shut
      const open = Math.min(1, c.t / 0.05)
      const close = c.t < c.hold ? 1 : Math.max(0, 1 - (c.t - c.hold) / Math.max(0.01, c.dur - c.hold))
      const k = open * close * close * (3 - 2 * close)
      v.set(c.x, c.y, c.angle, c.slide * k)
      this.cutGlow[i] = Math.max(0, 1 - c.t / (c.hold + 0.25)) * (this.reduce ? 0.4 : 1)
      if (c.t >= c.dur) c.on = false
      this.cutOn = true
    }

    this.shockOn = this.hazeOn = false
    for (let i = 0; i < MAX_SHOCKS; i++) {
      const r = this.rings[i]
      const v = this.shockData[i]
      v.w = 0
      if (!r.on) continue
      if (r.delay > 0) {
        r.delay -= rdt
        continue
      }
      r.r += rdt * r.speed
      r.s *= Math.exp(-rdt * 2.2)
      if (r.r > 1.6 || r.s < 0.001) {
        r.on = false
        continue
      }
      if (camera && this.toScreen(r.world, camera, _s)) {
        r.x = _s.x
        r.y = _s.y
      } else if (camera) continue
      v.set(r.x, r.y, r.r, r.s)
      this.shockSharp[i] = r.sharp
      this.shockOn = true
    }

    this.hazeClock += wdt
    for (let i = 0; i < MAX_HAZE; i++) {
      const h = this.hazes[i]
      const v = this.hazeData[i]
      v.w = 0
      if (!h.on) continue
      h.t += wdt
      if (h.t >= h.dur) {
        h.on = false
        continue
      }
      if (!camera) continue
      const sr = screenRadius(h.pos, h.radius, camera)
      if (sr <= 0 || !this.toScreen(h.pos, camera, _s)) continue
      // standing inside the heat shimmers the view, but must not melt it
      const inside = sr > 1.2 ? Math.max(0.35, 1.2 / sr) : 1
      v.set(_s.x, _s.y, Math.min(sr, 1.2), h.strength * PostState.hazeEnvelope(h.t, h.dur) * clamp(sr * 5, 0.3, 1) * inside)
      this.hazeOn = v.w > 0 || this.hazeOn
    }

    const b = this.blast
    this.blastRays = 0
    if (b.strength > 0) {
      b.t += rdt
      const u = b.t / b.dur
      if (u >= 1) b.strength = 0
      else {
        const vis = camera ? lightOnScreen(b.pos, camera, this.blastScreen) : 0
        this.blastRays = b.strength * Math.min(1, b.t / BLAST_IN) * blastEnvelope(b.t, b.dur) * vis
      }
    }
    if (camera) this.sunVis = lightOnScreen(this.sunDir, camera, this.sunScreen, true)

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
