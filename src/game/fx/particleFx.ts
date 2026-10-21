import * as THREE from 'three'
import { GpuParticles, type ParticleStyle, type RGBA } from '../../engine/gpuParticles'

/**
 * The particle language: every spark, ember, mote and glint in the game, drawn
 * by two stateless GPU pools (one additive for light, one alpha-blended for
 * dust and ash). Counts passed in are at high quality; they scale with q.
 */

/** A base colour, 0..1; helpers turn it into white-hot HDR heads and cooling tails. */
export type Tint = readonly [number, number, number]

export const GOLD: Tint = [1, 0.75, 0.35]
export const FIRE: Tint = [1, 0.5, 0.18]
export const WHITE_GOLD: Tint = [1, 0.9, 0.7]
export const EMBER: Tint = [1, 0.42, 0.1]
export const AMBER: Tint = [1, 0.62, 0.22]

export interface SparkOpts {
  /** Mean life in seconds (each spark gets 0.5x..1.4x). */
  life?: number
  /** Streak width in metres. */
  size?: number
  gravity?: number
  drag?: number
  /** Ground restitution; null lets them fall through the ground. */
  bounce?: number | null
  /** Seconds of motion smeared into each streak. */
  stretch?: number
  /** White-hot multiplier for the head colour. */
  heat?: number
  /** Postpone birth (world seconds); spread over [delay, delay + stagger]. */
  delay?: number
  stagger?: number
  /** Spawn jitter radius around p. */
  jitter?: number
  /** Flow drift on top of the ballistic arc. */
  curl?: number
}

export interface DriftOpts {
  color?: Tint
  /** Mean life in seconds. */
  life?: number
  size?: number
  /** Upward drift speed in m/s (terminal, from buoyancy and drag). */
  rise?: number
  /** Swirl strength in m/s. */
  curl?: number
  /** Initial outward speed. */
  burst?: number
  /** Constant velocity added (wind). */
  wind?: THREE.Vector3 | null
  delay?: number
  stagger?: number
  /** Flatten the spawn volume vertically (0..1). */
  flat?: number
  /** Brightness multiplier. */
  bright?: number
  /** Spawn in a vertical column of this height above p instead of a sphere. */
  height?: number
}

export interface RingOpts {
  /** Seconds until the ring has nearly stopped expanding. */
  expand?: number
  life?: number
  size?: number
  /** Radius jitter as a fraction (0 = a crisp ring, 1 = a filled disc). */
  fill?: number
  /** Out-of-plane jitter speed (thickness). */
  thick?: number
  stretch?: number
  heat?: number
  gravity?: number
  delay?: number
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const _d = new THREE.Vector3()
const _u = new THREE.Vector3()
const _w = new THREE.Vector3()
const _p = new THREE.Vector3()

/** Random unit vector; with `around`, biased into a cone (spread 0 = exact, ~1 = hemisphere). */
export function coneDir(out: THREE.Vector3, around: THREE.Vector3 | null, spread: number) {
  // uniform on the sphere (no normalise-a-cube bias)
  const z = Math.random() * 2 - 1
  const a = Math.random() * Math.PI * 2
  const r = Math.sqrt(1 - z * z)
  out.set(r * Math.cos(a), z, r * Math.sin(a))
  if (around) out.multiplyScalar(spread).add(around).normalize()
  return out
}

/** Two unit vectors spanning the plane perpendicular to n. */
export function planeBasis(n: THREE.Vector3, u: THREE.Vector3, w: THREE.Vector3) {
  u.set(0, 1, 0)
  if (Math.abs(n.y) > 0.9) u.set(1, 0, 0)
  u.cross(n).normalize()
  w.crossVectors(n, u).normalize()
}

const hot = (c: Tint, heat: number, a = 1): RGBA => [(c[0] * 0.72 + 0.28) * heat, (c[1] * 0.72 + 0.28) * heat, (c[2] * 0.72 + 0.28) * heat * 0.9, a]
const cool = (c: Tint, k = 1, a = 0): RGBA => [c[0] * 1.6 * k, c[1] * 0.7 * k, c[2] * 0.35 * k, a]
const flat = (c: Tint, k: number, a: number): RGBA => [c[0] * k, c[1] * k, c[2] * k, a]

export class ParticleFx {
  readonly root = new THREE.Group()
  /** Additive light: sparks, embers, glitter, motes, glows. */
  readonly light: GpuParticles
  /** Alpha-blended: dust motes and ash. */
  readonly soft: GpuParticles
  private q: number

  constructor(q: number) {
    this.q = q
    const cap = q >= 1 ? 65536 : q >= 0.75 ? 32768 : 16384
    this.light = new GpuParticles({ capacity: cap, blending: 'add', renderOrder: 9 })
    this.soft = new GpuParticles({ capacity: cap / 4, blending: 'normal', renderOrder: 6 })
    this.root.add(this.soft.mesh, this.light.mesh)
  }

  /** High-quality count scaled to the current quality (at least 1 when n > 0). */
  count(n: number) {
    return n <= 0 ? 0 : Math.max(1, Math.round(n * this.q))
  }

  clear() {
    this.light.clear()
    this.soft.clear()
  }

  update(dt: number, camera: THREE.PerspectiveCamera, viewportH: number) {
    this.light.setViewport(viewportH, camera.fov)
    this.soft.setViewport(viewportH, camera.fov)
    this.light.update(dt)
    this.soft.update(dt)
  }

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------

  sparkStyle(color: Tint, o: SparkOpts = {}): ParticleStyle {
    const size = o.size ?? 0.06
    return {
      c0: hot(color, o.heat ?? 5),
      c1: cool(color),
      s0: size,
      s1: size * 0.5,
      gravity: o.gravity ?? 12,
      drag: o.drag ?? 1.6,
      stretch: o.stretch ?? 0.035,
      bounce: o.bounce === null ? undefined : (o.bounce ?? 0.3),
      core: 0.85,
      curl: o.curl ?? 0,
      fadeIn: 0,
    }
  }

  emberStyle(color: Tint, o: DriftOpts = {}): ParticleStyle {
    const size = o.size ?? 0.16
    const rise = o.rise ?? 1
    const drag = 1.4
    const b = o.bright ?? 1
    return {
      // saturated: very bright embers tone-map to white
      c0: [color[0] * 3.2 * b, (color[1] * 0.75 + 0.06) * 3.2 * b, color[2] * 0.6 * 3.2 * b, 1],
      c1: flat(color, 1.8 * b, 0),
      s0: size,
      s1: size * 0.45,
      gravity: -rise * drag,
      drag,
      curl: o.curl ?? 1.1,
      curlFreq: 0.45,
      flicker: 0.5,
      core: 0.6,
      fadeIn: 0.08,
    }
  }

  // -------------------------------------------------------------------------
  // Vocabulary
  // -------------------------------------------------------------------------

  /**
   * Hot streak sparks from p in a cone around `dir` (null = every direction).
   * `spread` 0 is a laser, ~1 a hemisphere. They arc, bounce and skitter.
   */
  sparkShower(p: THREE.Vector3, dir: THREE.Vector3 | null, n: number, speed: number, spread = 0.6, color: Tint = GOLD, o: SparkOpts = {}) {
    n = this.count(n)
    if (!n) return
    const st = this.sparkStyle(color, o)
    const life = o.life ?? 0.8
    const j = o.jitter ?? 0
    const d0 = o.delay ?? 0
    const sg = o.stagger ?? 0
    for (let i = 0; i < n; i++) {
      coneDir(_d, dir, spread)
      // speeds skew fast with a slow tail: a crisp shell over a dense core
      const sp = speed * (0.2 + 0.8 * Math.pow(Math.random(), 0.6))
      this.light.emit(
        p.x + rnd(-j, j),
        p.y + rnd(-j, j),
        p.z + rnd(-j, j),
        _d.x * sp,
        _d.y * sp,
        _d.z * sp,
        life * rnd(0.45, 1.4),
        st,
        rnd(0.6, 1.4),
        rnd(0.6, 1.25),
        d0 + Math.random() * sg,
      )
    }
  }

  /** Glowing embers that swirl, flicker and rise around p for a few seconds. */
  emberDrift(p: THREE.Vector3, n: number, radius: number, o: DriftOpts = {}) {
    n = this.count(n)
    if (!n) return
    const st = this.emberStyle(o.color ?? EMBER, o)
    const life = o.life ?? 3.5
    const b = o.burst ?? 1
    const fl = 1 - (o.flat ?? 0.4)
    const wx = o.wind?.x ?? 0
    const wz = o.wind?.z ?? 0
    const h = o.height ?? 0
    for (let i = 0; i < n; i++) {
      coneDir(_d, null, 1)
      const r = radius * Math.cbrt(Math.random())
      this.light.emit(
        p.x + _d.x * r,
        p.y + (h > 0 ? Math.random() * h : Math.abs(_d.y) * r * fl),
        p.z + _d.z * r,
        _d.x * b + wx,
        Math.abs(_d.y) * b,
        _d.z * b + wz,
        life * rnd(0.5, 1.5),
        st,
        rnd(0.5, 1.5),
        rnd(0.6, 1.3),
        (o.delay ?? 0) + Math.random() * (o.stagger ?? 0),
      )
    }
  }

  /**
   * A flat ring of plasma sparks bursting outward in the plane perpendicular
   * to `normal`, decelerating to hang at `radius`.
   */
  plasmaRing(p: THREE.Vector3, normal: THREE.Vector3, radius: number, n: number, color: Tint = WHITE_GOLD, o: RingOpts = {}) {
    n = this.count(n)
    if (!n) return
    planeBasis(normal, _u, _w)
    const expand = o.expand ?? 0.5
    const k = 3 / expand
    const size = o.size ?? 0.06
    const st: ParticleStyle = {
      c0: hot(color, o.heat ?? 5),
      c1: cool(color, 1.2),
      s0: size,
      s1: size * 0.6,
      gravity: o.gravity ?? 0,
      drag: k,
      stretch: o.stretch ?? 0.06,
      core: 0.8,
      fadeIn: 0,
    }
    const fill = o.fill ?? 0.15
    const th = o.thick ?? radius * 0.05
    const life = o.life ?? expand * 2.2
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const r = radius * (1 - fill * Math.random())
      const sp = r * k
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const off = rnd(-th, th)
      this.light.emit(
        p.x,
        p.y,
        p.z,
        (_u.x * ca + _w.x * sa) * sp + normal.x * off * k,
        (_u.y * ca + _w.y * sa) * sp + normal.y * off * k,
        (_u.z * ca + _w.z * sa) * sp + normal.z * off * k,
        life * rnd(0.6, 1.3),
        st,
        rnd(0.6, 1.5),
        rnd(0.6, 1.2),
        o.delay ?? 0,
      )
    }
  }

  /**
   * Slow glowing motes that hang in the air: spawned on a ring of `radius`
   * around p (in the plane perpendicular to `normal`, or a sphere without it).
   */
  motes(p: THREE.Vector3, n: number, radius: number, color: Tint = WHITE_GOLD, normal: THREE.Vector3 | null = null, o: { life?: number; size?: number; delay?: number; drift?: number } = {}) {
    n = this.count(n)
    if (!n) return
    if (normal) planeBasis(normal, _u, _w)
    const size = o.size ?? 0.14
    const st: ParticleStyle = {
      c0: [color[0] * 3.4, color[1] * 2.6, color[2] * 1.6, 1],
      c1: flat(color, 1.2, 0),
      s0: size,
      s1: size * 0.6,
      gravity: -0.12,
      drag: 2.5,
      curl: 0.35,
      curlFreq: 0.25,
      flicker: 0.45,
      core: 0.5,
      fadeIn: 0.06,
    }
    const life = o.life ?? 4
    const dr = o.drift ?? 1.5
    for (let i = 0; i < n; i++) {
      if (normal) {
        const a = Math.random() * Math.PI * 2
        const r = radius * rnd(0.85, 1.1)
        _d.copy(_u).multiplyScalar(Math.cos(a) * r).addScaledVector(_w, Math.sin(a) * r)
      } else coneDir(_d, null, 1).multiplyScalar(radius * Math.cbrt(Math.random()))
      _p.copy(_d).normalize()
      this.light.emit(p.x + _d.x, p.y + _d.y, p.z + _d.z, _p.x * dr * rnd(0.3, 1), _p.y * dr * rnd(0.3, 1), _p.z * dr * rnd(0.3, 1), life * rnd(0.6, 1.3), st, rnd(0.5, 1.5), rnd(0.6, 1.3), (o.delay ?? 0) + Math.random() * 0.1)
    }
  }

  /** A rising column of twinkling glitter: fills a cylinder of `radius` and climbs. */
  glitter(p: THREE.Vector3, n: number, radius: number, height: number, color: Tint = WHITE_GOLD, o: { life?: number; size?: number; rise?: number; stagger?: number; delay?: number } = {}) {
    n = this.count(n)
    if (!n) return
    const size = o.size ?? 0.1
    const rise = o.rise ?? height * 0.2
    const drag = 0.7
    const st: ParticleStyle = {
      c0: hot(color, 6),
      c1: flat(color, 1.4, 0),
      s0: size,
      s1: size * 0.7,
      gravity: -rise * drag,
      drag,
      curl: Math.max(0.6, radius * 0.08),
      curlFreq: 0.3 / Math.max(1, radius * 0.1),
      flicker: 0.92,
      core: 1,
      fadeIn: 0.1,
    }
    const life = o.life ?? 5
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const r = radius * Math.sqrt(Math.random())
      this.light.emit(p.x + Math.cos(a) * r, p.y + Math.random() * height, p.z + Math.sin(a) * r, Math.cos(a) * rnd(0, 1), rnd(0, rise), Math.sin(a) * rnd(0, 1), life * rnd(0.5, 1.4), st, rnd(0.5, 1.6), rnd(0.5, 1.2), (o.delay ?? 0) + Math.random() * (o.stagger ?? 0))
    }
  }

  /** A big soft glow that swells and fades (the core of a blast, a muzzle). */
  glowPuff(p: THREE.Vector3, size: number, color: Tint, life = 0.3, n = 3, bright = 1) {
    const st: ParticleStyle = { c0: hot(color, 2.2 * bright, 0.55), c1: flat(color, 0.8 * bright, 0), s0: size, s1: size * 1.8, drag: 4, fadeIn: 0 }
    for (let i = 0; i < n; i++) {
      coneDir(_d, null, 1).multiplyScalar(size * 0.6)
      this.light.emit(p.x + _d.x * 0.3, p.y + _d.y * 0.3, p.z + _d.z * 0.3, _d.x, _d.y, _d.z, life * rnd(0.7, 1.3), st, rnd(0.7, 1.3))
    }
  }

  /** Sparks skittering outward along the ground from p (a stomp, a landing). */
  groundSparks(p: THREE.Vector3, radius: number, n: number, color: Tint = GOLD, o: { life?: number; size?: number; delay?: number } = {}) {
    n = this.count(n)
    if (!n) return
    const k = 2.4
    const st = this.sparkStyle(color, { size: o.size ?? 0.09, drag: k, gravity: 10, bounce: 0.2, stretch: 0.05, heat: 6 })
    const life = o.life ?? 1.1
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = radius * k * rnd(0.5, 1.15)
      this.light.emit(p.x + Math.sin(a) * 0.6, 0.12, p.z + Math.cos(a) * 0.6, Math.sin(a) * sp, rnd(0.5, 3.5), Math.cos(a) * sp, life * rnd(0.5, 1.3), st, rnd(0.6, 1.4), rnd(0.7, 1.2), (o.delay ?? 0) + Math.random() * 0.04)
    }
  }

  /**
   * A wall of sparks erupting along the segment a → b, tearing along it over
   * `sweep` seconds (the Heaven Splitter's cut).
   */
  sparkWall(a: THREE.Vector3, b: THREE.Vector3, n: number, speed: number, color: Tint = GOLD, o: { sweep?: number; life?: number; size?: number; side?: number } = {}) {
    n = this.count(n)
    if (!n) return
    const st = this.sparkStyle(color, { size: o.size ?? 0.09, gravity: 16, drag: 0.9, stretch: 0.03, bounce: 0.3, heat: 3.6 })
    _u.subVectors(b, a)
    // the side vector: horizontal, perpendicular to the cut
    _w.set(_u.z, 0, -_u.x).normalize()
    const side = o.side ?? 0.18
    const sweep = o.sweep ?? 0.35
    const life = o.life ?? 1.4
    for (let i = 0; i < n; i++) {
      const t = Math.random()
      const s = (Math.random() - 0.5) * 2 * side
      const sp = speed * (0.3 + 0.7 * Math.pow(Math.random(), 0.5)) * (1.1 - t * 0.4)
      _d.set(_w.x * s + (Math.random() - 0.5) * 0.1, 1, _w.z * s + (Math.random() - 0.5) * 0.1).normalize()
      this.light.emit(a.x + _u.x * t, a.y + _u.y * t + 0.2, a.z + _u.z * t, _d.x * sp, _d.y * sp, _d.z * sp, life * rnd(0.5, 1.3), st, rnd(0.6, 1.5), rnd(0.6, 1.3), t * sweep + Math.random() * 0.12)
    }
  }

  /**
   * Sparks spraying off a cut through the air from a to b. They are born a
   * little in the past, so a stopped world shows them frozen mid-flight.
   */
  cutSparks(a: THREE.Vector3, b: THREE.Vector3, n: number, speed: number, color: Tint = WHITE_GOLD, o: { size?: number; life?: number; preAge?: number } = {}) {
    n = this.count(n)
    if (!n) return
    const st = this.sparkStyle(color, { size: o.size ?? 0.07, gravity: 10, drag: 1.8, stretch: 0.045, bounce: 0.3, heat: 4.5 })
    _u.subVectors(b, a)
    const len = _u.length()
    _u.divideScalar(len || 1)
    const life = o.life ?? 0.9
    const pre = o.preAge ?? 0.12
    for (let i = 0; i < n; i++) {
      const t = Math.random()
      // mostly perpendicular to the cut, a little along it
      coneDir(_d, null, 1)
      _d.addScaledVector(_u, -_d.dot(_u) * 0.8).normalize()
      const sp = speed * (0.25 + 0.75 * Math.random())
      this.light.emit(a.x + _u.x * len * t, a.y + _u.y * len * t, a.z + _u.z * len * t, _d.x * sp, _d.y * sp, _d.z * sp, life * rnd(0.5, 1.4), st, rnd(0.6, 1.4), rnd(0.6, 1.2), -Math.random() * pre)
    }
  }

  /** Dark ash flakes that tumble on the wind. */
  ash(p: THREE.Vector3, n: number, radius: number, o: { life?: number; size?: number; wind?: THREE.Vector3 | null; fall?: number; grey?: number; delay?: number; height?: number } = {}) {
    n = this.count(n)
    if (!n) return
    const g = o.grey ?? 0.08
    const size = o.size ?? 0.08
    const st: ParticleStyle = { c0: [g, g * 0.95, g * 0.92, 0.85], c1: [g * 1.4, g * 1.35, g * 1.3, 0], s0: size, s1: size * 0.8, gravity: (o.fall ?? 0.5) * 1.2, drag: 1.2, curl: 0.9, curlFreq: 0.5, fadeIn: 0.12 }
    const life = o.life ?? 4
    const wx = o.wind?.x ?? 0
    const wz = o.wind?.z ?? 0
    const h = o.height ?? 0
    for (let i = 0; i < n; i++) {
      coneDir(_d, null, 1)
      const r = radius * Math.cbrt(Math.random())
      this.soft.emit(p.x + _d.x * r, p.y + (h > 0 ? Math.random() * h : Math.abs(_d.y) * r), p.z + _d.z * r, _d.x + wx, Math.abs(_d.y) * 1.5, _d.z + wz, life * rnd(0.6, 1.3), st, rnd(0.6, 1.4), 1, (o.delay ?? 0) + Math.random() * 0.1)
    }
  }

  private ambEmber: ParticleStyle = { c0: [3.6, 1.3, 0.25, 1], c1: [1.2, 0.3, 0.05, 0], s0: 0.12, s1: 0.06, gravity: -0.3, drag: 0.4, curl: 0.9, curlFreq: 0.18, flicker: 0.7, core: 0.4, fadeIn: 0.15 }
  private ambAsh: ParticleStyle = this.ashStyle(0)
  private ashDawn = 0

  /** Ash greys toward pale cinders as the dawn comes. */
  private ashStyle(dawn: number): ParticleStyle {
    const g = 0.18 + dawn * 0.5
    return { c0: [g, g * 0.95, g * 0.92, 0.75], c1: [g, g * 0.95, g * 0.92, 0], s0: 0.12, s1: 0.09, gravity: 0.25, drag: 0.5, curl: 0.7, curlFreq: 0.3, fadeIn: 0.15 }
  }

  /**
   * The end of the world drifting past the camera: embers rising, ash falling.
   * Call every frame with world dt; nothing spawns while time is stopped.
   */
  ambient(dt: number, c: THREE.Vector3, wind: THREE.Vector3, dawn: number) {
    const n = Math.floor(dt * 300 * this.q + Math.random())
    if (Math.abs(dawn - this.ashDawn) > 0.03) {
      this.ashDawn = dawn
      this.ambAsh = this.ashStyle(dawn)
    }
    for (let i = 0; i < n; i++) {
      const x = c.x + rnd(-55, 55)
      const y = Math.max(0.3, c.y + rnd(-8, 26))
      const z = c.z + rnd(-55, 55)
      if (Math.random() < 0.5 * (1 - dawn)) {
        const big = Math.random() < 0.06
        this.light.emit(x, y, z, wind.x * 0.6 + rnd(-0.6, 0.6), rnd(0.5, 1.6), wind.z * 0.6 + rnd(-0.6, 0.6), rnd(4, 9), this.ambEmber, big ? rnd(1.8, 3) : rnd(0.5, 1.3), big ? 1.6 : rnd(0.5, 1.2))
      } else this.soft.emit(x, y, z, wind.x * 0.8, rnd(-0.6, -0.2), wind.z * 0.8, rnd(5, 8), this.ambAsh, rnd(0.6, 1.5))
    }
  }

  /** Fine dust motes kicked up from the ground (alpha-blended, settle slowly). */
  dustMotes(p: THREE.Vector3, n: number, radius: number, o: { life?: number; size?: number; color?: Tint; up?: number; out?: number; delay?: number } = {}) {
    n = this.count(n)
    if (!n) return
    const c = o.color ?? [0.36, 0.31, 0.28]
    const size = o.size ?? 0.25
    const st: ParticleStyle = { c0: [c[0], c[1], c[2], 0.32], c1: [c[0] * 1.1, c[1] * 1.1, c[2] * 1.1, 0], s0: size, s1: size * 2.5, gravity: 0.6, drag: 2.2, curl: 0.5, curlFreq: 0.3, fadeIn: 0.1, bounce: 0 }
    const life = o.life ?? 2.2
    const up = o.up ?? 2
    const out = o.out ?? radius * 2
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const r = radius * Math.sqrt(Math.random())
      const sa = Math.sin(a)
      const ca = Math.cos(a)
      this.soft.emit(p.x + sa * r, Math.max(0.05, p.y + rnd(0, 0.4)), p.z + ca * r, sa * out * rnd(0.3, 1), up * rnd(0.3, 1.2), ca * out * rnd(0.3, 1), life * rnd(0.6, 1.3), st, rnd(0.6, 1.5), 1, (o.delay ?? 0) + Math.random() * 0.08)
    }
  }
}
