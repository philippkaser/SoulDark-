import * as THREE from 'three'
import { ParticlePool } from '../../engine/particles'
import { clamp } from '../../engine/math'
import { audio } from '../../audio/audio'
import type { PostState } from '../post'
import type { ScorchMap } from '../world/scorch'
import type { Sky } from '../world/sky'
import { Afterimages } from './afterimage'
import { Debris } from './debris'
import { MushroomCloud } from './mushroom'
import { AMBER, EMBER, FIRE, GOLD, ParticleFx, WHITE_GOLD, type DriftOpts, type RingOpts, type SparkOpts, type Tint } from './particleFx'
import { bubbleMaterial, fireballMaterial, flareMaterial, ringMaterial, streakMaterial } from './shaders'

export interface FxHost {
  camera: THREE.PerspectiveCamera
  post: PostState
  scorch: ScorchMap
  sky: Sky
  /** Camera trauma; `at` lets distance attenuate it. */
  shake(amount: number, at?: THREE.Vector3): void
  /** 0.5 low .. 1 high: scales particle counts. */
  quality: number
  /** The wind that carries embers and ash. */
  wind?: THREE.Vector3
}

/** Answers "how high is the ground here?" (the deformable terrain). */
export interface GroundSampler {
  heightAt(x: number, z: number): number
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const _v = new THREE.Vector3()
const _p = new THREE.Vector3()
const _c = new THREE.Color()
const UP = new THREE.Vector3(0, 1, 0)

/** A colour as a particle tint (linear RGB); tints pass through. */
function tint(c: Tint | THREE.ColorRepresentation): Tint {
  if (Array.isArray(c)) return c as Tint
  _c.set(c as THREE.ColorRepresentation)
  return [_c.r, _c.g, _c.b]
}

function randomDir(out: THREE.Vector3, around?: THREE.Vector3 | null, spread = 1) {
  out.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize()
  if (around) out.multiplyScalar(spread).add(around).normalize()
  return out
}

interface Timed {
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial
  t: number
  dur: number
  active: boolean
  // per-kind data
  r0: number
  r1: number
  a0: number
  heat0: number
  rise: number
  dir: THREE.Vector3
}

function pool(n: number, make: () => THREE.Mesh, root: THREE.Object3D): Timed[] {
  const out: Timed[] = []
  for (let i = 0; i < n; i++) {
    const mesh = make()
    mesh.visible = false
    mesh.frustumCulled = false
    root.add(mesh)
    out.push({ mesh, mat: mesh.material as THREE.ShaderMaterial, t: 0, dur: 1, active: false, r0: 0, r1: 1, a0: 1, heat0: 1, rise: 0, dir: new THREE.Vector3() })
  }
  return out
}

function take(list: Timed[]) {
  let best = list[0]
  for (const x of list) {
    if (!x.active) return x
    if (x.t / x.dur > best.t / best.dur) best = x
  }
  return best
}

interface FlashLight {
  light: THREE.PointLight
  power: number
  decay: number
}

interface Scheduled {
  at: number
  fn: () => void
}

/** Every visual effect in the game. */
export class Fx {
  readonly root = new THREE.Group()
  readonly glow: ParticlePool
  readonly smoke: ParticlePool
  readonly fire: ParticlePool
  readonly debris = new Debris()
  readonly ghosts = new Afterimages()
  /** GPU particles: the spark / ember / mote vocabulary (see particleFx.ts). */
  readonly gpu: ParticleFx
  private rings: Timed[]
  private flares: Timed[]
  private fireballs: Timed[]
  private bubbles: Timed[]
  private streaks: Timed[]
  private lights: FlashLight[] = []
  private clouds: MushroomCloud[] = []
  private queue: Scheduled[] = []
  private clock = 0
  private host: FxHost

  constructor(host: FxHost) {
    this.host = host
    const q = host.quality
    // sparks and embers live on the GPU now; this pool keeps trails and glints
    this.glow = new ParticlePool({ capacity: Math.round(6000 * q), mode: 'points', additive: true, renderOrder: 9 })
    this.smoke = new ParticlePool({ capacity: Math.round(4200 * q), mode: 'quads', renderOrder: 7 })
    this.fire = new ParticlePool({ capacity: Math.round(2400 * q), mode: 'quads', additive: true, renderOrder: 8 })
    this.fire.sort = false
    this.fire.uniforms.uLit.value = 0
    this.gpu = new ParticleFx(q)
    this.root.add(this.glow.object, this.smoke.object, this.fire.object, this.debris.mesh, this.ghosts.root, this.gpu.root)
    this.rings = pool(28, () => new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ringMaterial()), this.root)
    this.flares = pool(24, () => new THREE.Mesh(new THREE.PlaneGeometry(2, 2), flareMaterial()), this.root)
    this.fireballs = pool(14, () => new THREE.Mesh(new THREE.IcosahedronGeometry(1, 4), fireballMaterial()), this.root)
    this.bubbles = pool(10, () => new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), bubbleMaterial()), this.root)
    this.streaks = pool(90, () => new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1).translate(0, 0.5, 0), streakMaterial()), this.root)
    for (const r of this.rings) r.mesh.renderOrder = 9
    for (const f of this.flares) f.mesh.renderOrder = 12
    for (const f of this.fireballs) f.mesh.renderOrder = 8
    for (const s of this.streaks) s.mesh.renderOrder = 11
    for (let i = 0; i < 5; i++) {
      const light = new THREE.PointLight('#ffb070', 0, 60, 1.6)
      light.position.set(0, -50, 0)
      this.root.add(light)
      this.lights.push({ light, power: 0, decay: 6 })
    }
    this.debris.onLand = (x, z, s) => {
      if (Math.random() < 0.5) this.dust(_p.set(x, this.gy(x, z) + 0.2, z), 3, s, s * 1.4)
    }
  }

  /** The ground under effects that hug it (craters are carved into the terrain). */
  ground: GroundSampler | null = null

  private gy(x: number, z: number) {
    return this.ground ? this.ground.heightAt(x, z) : 0
  }

  get time() {
    return this.clock
  }

  /** Run a function after `sec` of world time. */
  after(sec: number, fn: () => void) {
    this.queue.push({ at: this.clock + sec, fn })
  }

  clear() {
    this.glow.clear()
    this.smoke.clear()
    this.fire.clear()
    this.gpu.clear()
    this.debris.clear()
    this.ghosts.clear()
    for (const list of [this.rings, this.flares, this.fireballs, this.bubbles, this.streaks]) for (const x of list) (x.active = false), (x.mesh.visible = false)
    for (const c of this.clouds) {
      this.root.remove(c.root)
      c.dispose()
    }
    this.clouds = []
    this.queue = []
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  light(p: THREE.Vector3, color: THREE.ColorRepresentation, power: number, distance: number, decay = 6) {
    let l = this.lights[0]
    for (const x of this.lights) if (x.power < l.power) l = x
    l.light.position.copy(p)
    l.light.color.set(color)
    l.light.distance = distance
    l.power = power
    l.decay = decay
  }

  ring(p: THREE.Vector3, radius: number, color: THREE.ColorRepresentation, dur: number, opts: { normal?: THREE.Vector3; thick?: number; from?: number; alpha?: number } = {}) {
    const r = take(this.rings)
    r.active = true
    r.t = 0
    r.dur = dur
    r.r0 = opts.from ?? radius * 0.1
    r.r1 = radius
    r.a0 = opts.alpha ?? 1.4
    r.mesh.position.copy(p)
    if (opts.normal) r.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), opts.normal)
    else r.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), UP)
    if (!opts.normal) r.mesh.position.y = Math.max(p.y, this.gy(p.x, p.z) + 0.06)
    r.mat.uniforms.uColor.value.set(color)
    r.mat.uniforms.uThick.value = opts.thick ?? 0.25
    r.mesh.visible = true
  }

  flare(p: THREE.Vector3, size: number, color: THREE.ColorRepresentation, dur = 0.25, alpha = 1) {
    const f = take(this.flares)
    f.active = true
    f.t = 0
    f.dur = dur
    f.r0 = size
    f.a0 = alpha
    f.mesh.position.copy(p)
    f.mesh.scale.setScalar(size)
    f.mat.uniforms.uColor.value.set(color)
    f.mat.uniforms.uRot.value = Math.random() * 0.6
    f.mesh.visible = true
  }

  fireball(p: THREE.Vector3, radius: number, dur: number, rise = 0, heat = 1.2) {
    const f = take(this.fireballs)
    f.active = true
    f.t = 0
    f.dur = dur
    f.r1 = radius
    f.rise = rise
    f.heat0 = heat
    f.mesh.position.copy(p)
    f.mat.uniforms.uSeed.value = Math.random() * 50
    f.mesh.visible = true
  }

  bubble(p: THREE.Vector3, radius: number, color: THREE.ColorRepresentation, dur: number, alpha = 1.5) {
    const b = take(this.bubbles)
    b.active = true
    b.t = 0
    b.dur = dur
    b.r1 = radius
    b.a0 = alpha
    b.mesh.position.copy(p)
    b.mat.uniforms.uColor.value.set(color)
    b.mesh.visible = true
  }

  /** A glowing cut through the air from a to b. */
  streak(a: THREE.Vector3, b: THREE.Vector3, width: number, color: THREE.ColorRepresentation, dur: number, delay = 0) {
    const s = take(this.streaks)
    s.active = true
    s.t = -delay
    s.dur = dur
    s.a0 = 1
    s.r0 = width
    const len = a.distanceTo(b)
    s.mesh.position.copy(a)
    _v.subVectors(b, a).normalize()
    s.mesh.quaternion.setFromUnitVectors(UP, _v)
    s.mesh.scale.set(1, len, 1)
    s.mat.uniforms.uColor.value.set(color)
    s.mat.uniforms.uWidth.value = width
    s.mat.uniforms.uAlpha.value = 0
    s.mesh.visible = delay <= 0
    // sparks spray off the cut (frozen mid-flight while time is stopped)
    if (delay <= 0) this.gpu.cutSparks(a, b, Math.min(160, 30 + len * 2.5), 14 + width * 20, tint(color))
  }

  /** A burst of `n` sparks (n is the old point count: the GPU throws four streaks for each). */
  spark(p: THREE.Vector3, dir: THREE.Vector3 | null, n: number, speed: number, color: readonly [number, number, number] = [1, 0.75, 0.35], size = 0.06) {
    this.gpu.sparkShower(p, dir, n * 4, speed * 1.25, 1.3, color, { size: size * 0.75, life: 0.5, gravity: 14, drag: 2, stretch: 0.03 })
  }

  embers(p: THREE.Vector3, n: number, spread: number, up = 2) {
    this.gpu.emberDrift(p, n * 3, spread, { rise: up * 0.7, burst: up * 0.6, life: 2.4, wind: this.host.wind })
  }

  // -------------------------------------------------------------------------
  // GPU particle vocabulary (counts are at high quality and scale down)
  // -------------------------------------------------------------------------

  /** Hot streak sparks from p in a cone around `dir` (null = all around); spread 0 = laser, ~1 = hemisphere. They arc, bounce and skitter. */
  sparkShower(p: THREE.Vector3, dir: THREE.Vector3 | null, n: number, speed: number, spread = 0.6, color: Tint | THREE.ColorRepresentation = GOLD, o?: SparkOpts) {
    this.gpu.sparkShower(p, dir, n, speed, spread, tint(color), o)
  }

  /** Glowing embers that swirl, flicker and rise within `radius` of p for a few seconds. */
  emberDrift(p: THREE.Vector3, n: number, radius: number, o: DriftOpts = {}) {
    this.gpu.emberDrift(p, n, radius, { wind: this.host.wind, ...o })
  }

  /** A flat ring of plasma sparks bursting out in the plane perpendicular to `normal`, slowing to hang at `radius`. */
  plasmaRing(p: THREE.Vector3, normal: THREE.Vector3, radius: number, n: number, color: Tint | THREE.ColorRepresentation = WHITE_GOLD, o?: RingOpts) {
    this.gpu.plasmaRing(p, normal, radius, n, tint(color), o)
  }

  /** A rising column of twinkling glitter (radius, height in metres). */
  glitter(p: THREE.Vector3, n: number, radius: number, height: number, color: Tint = WHITE_GOLD) {
    this.gpu.glitter(p, n, radius, height, color)
  }

  /** Slow glowing motes that hang in the air on a ring (or a sphere without a normal). */
  motes(p: THREE.Vector3, n: number, radius: number, color: Tint = WHITE_GOLD, normal: THREE.Vector3 | null = null) {
    this.gpu.motes(p, n, radius, color, normal)
  }

  /** Dark ash flakes carried off on the wind. */
  ash(p: THREE.Vector3, n: number, radius: number) {
    this.gpu.ash(p, n, radius, { wind: this.host.wind })
  }

  /** Sparks skittering outward along the ground from p to about `radius`. */
  groundSparks(p: THREE.Vector3, radius: number, n: number, color: Tint = GOLD) {
    this.gpu.groundSparks(p, radius, n, color)
  }

  /** A wall of sparks erupting along a → b, tearing along it over `sweep` seconds. */
  sparkWall(a: THREE.Vector3, b: THREE.Vector3, n: number, speed: number, color: Tint = GOLD, sweep = 0.35) {
    this.gpu.sparkWall(a, b, n, speed, color, { sweep })
  }

  /** Ambient embers and ash around the camera; call every frame with world dt. */
  ambient(dt: number, camera: THREE.Vector3, wind: THREE.Vector3, dawn: number) {
    this.gpu.ambient(dt, camera, wind, dawn)
  }

  dust(p: THREE.Vector3, n: number, spread: number, size: number, color: readonly [number, number, number] = [0.32, 0.27, 0.24]) {
    n = Math.max(1, Math.round(n * this.host.quality))
    for (let i = 0; i < n; i++) {
      _p.set(p.x + rnd(-spread, spread), p.y + rnd(0, spread * 0.3), p.z + rnd(-spread, spread))
      _v.set(rnd(-1, 1) * spread, rnd(0.4, 1.6) * Math.max(1, spread * 0.4), rnd(-1, 1) * spread)
      this.smoke.spawn(_p, _v, color, 0.55, size * rnd(0.6, 1.3), rnd(1.4, 2.8), -0.3, 1.8, { grow: 1.4 })
    }
    this.gpu.dustMotes(p, n * 5, spread, { size: Math.min(0.5, size * 0.2), out: spread * 1.6, up: 1.5, color })
  }

  smokeColumn(p: THREE.Vector3, n: number, size: number, rise: number, heat = 0, dark = 0.12) {
    n = Math.max(1, Math.round(n * this.host.quality))
    for (let i = 0; i < n; i++) {
      _p.set(p.x + rnd(-size, size) * 0.4, p.y + rnd(0, size * 0.5), p.z + rnd(-size, size) * 0.4)
      _v.set(rnd(-0.5, 0.5) * size * 0.3, rise * rnd(0.6, 1.2), rnd(-0.5, 0.5) * size * 0.3)
      const g = dark + Math.random() * 0.08
      this.smoke.spawn(_p, _v, [g, g * 0.92, g * 0.88], 0.8, size * rnd(0.7, 1.3), rnd(2.5, 5), -0.5, 0.6, { grow: 1.6, heat, cool: 0.6 })
    }
  }

  /** The hero's afterimage. */
  afterimage(color: THREE.ColorRepresentation = '#ffc070', life = 0.32, alpha = 1) {
    this.ghosts.spawn(color, life, alpha)
  }

  // -------------------------------------------------------------------------
  // Composites
  // -------------------------------------------------------------------------

  /** Generic explosion. `size` is roughly the fireball radius in metres. */
  explosion(p: THREE.Vector3, size: number, opts: { color?: string; scorch?: boolean; debris?: boolean; sound?: boolean; quiet?: boolean } = {}) {
    const s = size
    const gy = this.gy(p.x, p.z)
    const ground = p.y - gy < s * 1.2
    this.light(_p.copy(p).setY(p.y + s * 0.5), opts.color ?? '#ff9a48', 40 * s * s, s * 14, 4)
    this.flare(p, s * 5, '#ffd8a0', 0.3)
    this.fireball(p, s, 0.7 + s * 0.05, s * 0.6)
    this.explosionParticles(p, s, ground)
    const nf = Math.round((10 + s * 3) * this.host.quality)
    for (let i = 0; i < nf; i++) {
      randomDir(_v).multiplyScalar(s * rnd(1, 4))
      if (ground) _v.y = Math.abs(_v.y)
      this.fire.spawn(p, _v, [1, rnd(0.45, 0.7), 0.2], 0.9, s * rnd(0.5, 1.1), rnd(0.3, 0.7), -2, 3, { grow: 1.2 })
    }
    this.smokeColumn(_p.copy(p), 6 + s, s * 1.1, s * 1.6, 1.2, 0.1)
    if (ground) {
      this.ring(_p.copy(p).setY(gy + 0.1), s * 3.2, '#ffb070', 0.5 + s * 0.02, { thick: 0.18 })
      this.dust(_p.copy(p).setY(gy + 0.3), 6 + s, s * 1.2, s * 1.2)
      if (opts.scorch !== false) this.host.scorch.crater(p.x, p.z, s * 1.3, 0.9)
      if (opts.debris !== false && s > 1.5) this.debris.burst(_p.copy(p).setY(gy + 0.5), Math.min(40, Math.round(s * 4)), s * 3.5, 0.15 + s * 0.06, 1)
    }
    const d = p.distanceTo(this.host.camera.position)
    this.host.shake(Math.min(1, s * 0.12) * Math.max(0.15, 1 - d / (s * 30)), p)
    const post = this.host.post
    if (s > 4 && d < s * 25) post.shock(p, this.host.camera, 0.012 + s * 0.002)
    post.streak(Math.min(1.2, 0.1 + s * 0.04), p)
    // heat shimmers over the burning ground; big blasts throw shafts of light (gentler when the fireball fills the view)
    if (ground && s >= 4) post.haze(_p.copy(p).setY(gy + s * 0.3), s * 2.2, Math.min(1, 0.4 + s * 0.04), 2 + s * 0.12)
    if (s >= 12) post.rays(p, Math.min(1.3, s / 40) * clamp(d / (s * 8), 0.35, 1), 0.7 + s * 0.015)
    if (opts.sound !== false) audio.explosion(p, s)
  }

  /** Thousands of streak sparks, a glowing core and embers that linger and swirl. */
  private explosionParticles(p: THREE.Vector3, s: number, ground: boolean) {
    const gp = this.gpu
    const sv = 6 * Math.pow(s, 0.75)
    const ns = Math.min(3200, 160 + s * 110)
    const dir = ground ? UP : null
    // a shell of fast white-hot streaks, then a slower, denser spill of fat sparks
    gp.sparkShower(p, dir, ns, sv * 1.9, ground ? 1.5 : 1, FIRE, { size: 0.05 + s * 0.012, life: 0.65 + s * 0.04, drag: 1.3, stretch: 0.03, jitter: s * 0.2 })
    gp.sparkShower(p, dir, ns * 0.35, sv, 2, GOLD, { size: 0.09 + s * 0.02, life: 1.2 + s * 0.04, drag: 2, heat: 3.5, jitter: s * 0.4 })
    gp.glowPuff(p, s * 2.2, FIRE, 0.22 + s * 0.012, 3)
    gp.emberDrift(p, Math.min(1600, 80 + s * 45), s * 1.2, { rise: 0.8 + Math.min(6, s * 0.3), burst: s * 0.9, life: 3 + Math.min(4, s * 0.15), size: 0.16 + s * 0.025, curl: 0.8 + Math.min(4, s * 0.12), wind: this.host.wind, stagger: 0.25 })
    if (ground) {
      gp.groundSparks(p, s * 3, 50 + s * 22, FIRE)
      gp.dustMotes(_p.copy(p).setY(this.gy(p.x, p.z) + 0.2), 20 + s * 10, s * 0.8, { out: s * 2.5, up: s * 0.6, size: 0.3 + s * 0.08, life: 2.6 })
    }
  }

  /** Hero-side impact: sword strikes, parries, ground slams. */
  impact(p: THREE.Vector3, dir: THREE.Vector3 | null, size: number, color: THREE.ColorRepresentation = '#ffe0a0') {
    this.flare(p, size * 3, color, 0.18)
    const c = tint(color)
    // a sharp, directional spray plus a few needle-fast glints
    this.gpu.sparkShower(p, dir, 60 + size * 45, 12 + size * 6, dir ? 0.75 : 1, c, { size: 0.035 + size * 0.008, life: 0.45, drag: 2.4, stretch: 0.03 })
    this.gpu.sparkShower(p, dir, 12 + size * 8, 30 + size * 10, 0.3, WHITE_GOLD, { size: 0.025 + size * 0.004, life: 0.22, heat: 7, gravity: 4, drag: 3, stretch: 0.025 })
    this.light(p, color, 30 * size, 8 + size * 4, 10)
  }

  /** The burst of a parry; tier sets the scale. */
  parryBurst(p: THREE.Vector3, normal: THREE.Vector3, tier: number) {
    const s = 1 + tier * 1.4
    // the flash and the bubble stay hand-sized even for a warhead: at the hero's chest, right in front of the
    // lens, anything bigger whites out the frame; the rings and sparks carry the scale instead
    const core = Math.min(s, 2.6)
    this.flare(p, 3 * core, '#fff2d0', 0.22 + tier * 0.05)
    this.ring(p, 2.5 * s, '#fff0c8', 0.35 + tier * 0.1, { normal, thick: 0.12 })
    this.ring(p, 5 * s, '#ffcf70', 0.5 + tier * 0.15, { normal, thick: 0.06, alpha: 1 })
    this.bubble(p, 1.5 * core, '#ffd890', 0.3 + tier * 0.08, 1)
    this.light(p, '#fff0d0', 120 * s, 20 * s, 7)
    if (tier >= 2) this.ring(_p.copy(p).setY(this.gy(p.x, p.z) + 0.1), 14 * s, '#ffdf9a', 0.8, { thick: 0.08 })
    // the lens flares and the blade throws brief shafts; kept low, the burst itself is already blinding
    this.host.post.streak([0.3, 0.4, 0.5, 0.55][Math.min(3, tier)], p)
    if (tier >= 3) this.host.post.rays(p, 0.35, 0.7, '#fff0d0')
    // a radial corona of sparks around the parry axis, and a spray back along it
    const gp = this.gpu
    const n = [200, 380, 560, 560][Math.min(3, tier)]
    // big parries play out in divine time, so they stay dense for a long while: keep them cooler
    const heat = tier >= 2 ? 3.6 : 5
    gp.plasmaRing(p, normal, 2 + Math.min(2, tier) * 1.2, n, WHITE_GOLD, { expand: 0.2 + tier * 0.04, fill: 0.9, thick: 0.2 + tier * 0.1, life: 0.4 + tier * 0.1, size: 0.03 + tier * 0.008, stretch: 0.03, heat })
    gp.sparkShower(p, normal, n * 0.8, 16 + tier * 10, 0.85, GOLD, { size: 0.035 + tier * 0.01, life: 0.55 + tier * 0.15, drag: 1.6, heat })
    // big parries lay a flat disc of sparks across the battlefield, and motes that hang in the air
    // the disc skims the ground: a shockwave of sparks across the plain, clear of the camera
    const low = _p.copy(p).setY(Math.max(0.4, p.y - 1.1))
    if (tier >= 3) {
      gp.plasmaRing(low, UP, 48, 1800, AMBER, { expand: 0.8, fill: 0.6, thick: 0.5, life: 2, size: 0.11, stretch: 0.035, heat: 3 })
      gp.plasmaRing(p, UP, 30, 800, WHITE_GOLD, { expand: 0.6, fill: 0.05, thick: 0.15, life: 1.6, size: 0.09, stretch: 0.04, heat: 3.5 })
      gp.motes(p, 360, 16, GOLD, UP, { life: 6, size: 0.14, drift: 2.5 })
      gp.motes(p, 160, 6, WHITE_GOLD, null, { life: 4, size: 0.1, drift: 1 })
    } else if (tier >= 2) {
      gp.plasmaRing(low, UP, 18, 800, AMBER, { expand: 0.5, fill: 0.5, thick: 0.25, life: 1.2, size: 0.07, stretch: 0.035, heat: 4 })
      gp.motes(p, 120, 7, GOLD, UP, { life: 3.5, size: 0.12 })
    } else if (tier >= 1) gp.motes(p, 40, 2.5, GOLD, normal, { life: 2, size: 0.09 })
  }

  /** Landing / stomp shockwave on the ground. */
  groundShock(p: THREE.Vector3, radius: number, color: THREE.ColorRepresentation = '#ffd090', debris = true) {
    const gy = this.gy(p.x, p.z)
    this.ring(_p.copy(p).setY(gy + 0.1), radius, color, 0.55, { thick: 0.2 })
    this.ring(_p.copy(p).setY(gy + 0.12), radius * 0.6, '#ffffff', 0.35, { thick: 0.3 })
    // a dust wall racing outward
    const n = Math.round(radius * 3 * this.host.quality)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.05, 0.05)
      _p.set(p.x + Math.sin(a) * 1.5, gy + 0.4, p.z + Math.cos(a) * 1.5)
      _v.set(Math.sin(a) * radius * rnd(1.2, 2.2), rnd(0.5, 3), Math.cos(a) * radius * rnd(1.2, 2.2))
      this.smoke.spawn(_p, _v, [0.36, 0.31, 0.28], 0.5, rnd(1.2, 2.4), rnd(0.9, 1.6), -0.2, 2.6, { grow: 1.5 })
    }
    if (debris) this.debris.burst(_p.copy(p).setY(gy + 0.3), Math.round(radius * 1.5), radius * 0.9, 0.18, 0.4)
    this.host.scorch.crater(p.x, p.z, radius * 0.45, 0.8)
    // a ring of sparks racing out along the ground, dust and embers in its wake
    const c = tint(color)
    this.gpu.groundSparks(_p.copy(p).setY(gy), radius * 0.9, 140 + radius * 18, c, { size: 0.09 + radius * 0.002 })
    this.gpu.plasmaRing(_p.copy(p).setY(gy + 0.35), UP, radius * 0.75, 200 + radius * 10, c, { expand: 0.35, fill: 0.2, thick: 0.05, life: 0.6, size: 0.07, gravity: 4 })
    this.gpu.dustMotes(_p.copy(p).setY(gy + 0.1), 40 + radius * 4, radius * 0.25, { out: radius * 1.4, up: 2.2, life: 2.6, size: 0.45 })
    this.gpu.emberDrift(_p.copy(p).setY(gy + 0.2), 30 + radius * 3, radius * 0.5, { rise: 1.2, burst: 2, flat: 0.85, life: 2.5, wind: this.host.wind })
  }

  /** A soldier struck down: the body burns away into glowing ash that drifts off on the wind. */
  vaporize(p: THREE.Vector3, hot: boolean) {
    const wind = this.host.wind
    this.gpu.emberDrift(p, hot ? 34 : 14, 0.32, { height: 1.7, rise: hot ? 1.1 : 0.6, burst: hot ? 1.4 : 0.5, life: hot ? 2.4 : 1.6, size: 0.13, curl: 1.4, wind, color: EMBER, stagger: 0.12 })
    this.gpu.ash(p, hot ? 12 : 20, 0.32, { height: 1.7, wind, life: 2.8, fall: -0.15, grey: hot ? 0.06 : 0.1 })
    const n = Math.round((hot ? 3 : 2) * this.host.quality)
    for (let i = 0; i < n; i++) {
      _p.set(p.x + rnd(-0.3, 0.3), p.y + rnd(0.3, 1.5), p.z + rnd(-0.3, 0.3))
      _v.set(rnd(-1, 1), rnd(0.5, 2), rnd(-1, 1))
      const g = rnd(0.05, 0.12)
      this.smoke.spawn(_p, _v, [g, g, g], 0.6, rnd(0.35, 0.6), rnd(0.8, 1.6), -0.3, 1.5, { grow: 1.3, heat: hot ? 0.8 : 0, cool: 1.5 })
    }
  }

  /** A blood-red spurt of armour shards (enemies hit but not killed). */
  chip(p: THREE.Vector3, dir: THREE.Vector3 | null) {
    this.gpu.sparkShower(p, dir, 44, 12, dir ? 0.7 : 1, FIRE, { size: 0.035, life: 0.4, drag: 2.5, stretch: 0.03 })
  }

  /** A nuclear detonation: flash, fireball, mushroom cloud, ground shock. */
  nuke(p: THREE.Vector3, scale: number) {
    const cloud = new MushroomCloud(p, scale, this.host.quality)
    this.clouds.push(cloud)
    this.root.add(cloud.root)
    this.fireball(_p.copy(p).setY(p.y + 40 * scale), 70 * scale, 9, 30 * scale, 1.6)
    this.fireball(_p.copy(p).setY(p.y + 20 * scale), 45 * scale, 4, 10 * scale, 2)
    this.flare(_p.copy(p).setY(p.y + 40 * scale), 900 * scale, '#fff6e0', 1.4, 1.5)
    this.light(_p.copy(p).setY(80 * scale), '#ffe0b0', 2e6 * scale, 2000, 0.8)
    this.host.sky.flash(_v.subVectors(p, this.host.camera.position).normalize(), 3, '#ffd8a0')
    this.ring(_p.copy(p).setY(1), 420 * scale, '#ffcf90', 4.5, { thick: 0.05, from: 20 })
    for (let i = 0; i < 6; i++) this.debris.burst(_p.copy(p).setY(2), 20, 70 * scale, 2.2 * scale, 1)
    this.host.scorch.crater(p.x, p.z, 120 * scale, 1)
    // the blast throws a storm of sparks, embers swirl up with the cap, glitter climbs the stem
    const gp = this.gpu
    const S = scale
    // sized to stay visible from across the plain
    const z = S * Math.max(1, p.distanceTo(this.host.camera.position) / 260)
    gp.sparkShower(_p.copy(p).setY(p.y + 25 * S), UP, 3600, 190 * S, 1.4, FIRE, { size: 0.8 * z, life: 3.2, gravity: 22, drag: 0.55, stretch: 0.045, heat: 6, bounce: 0.25, jitter: 15 * S })
    gp.emberDrift(_p.copy(p).setY(p.y + 30 * S), 7000, 170 * S, { rise: 14 * S, burst: 30 * S, life: 10, size: 1.8 * z, curl: 7 * S, color: EMBER, flat: 0.35, stagger: 2.5, bright: 1.4, wind: null })
    gp.glitter(p, 5000, 34 * S, 90 * S, WHITE_GOLD, { life: 9, size: 1.1 * z, rise: 34 * S, stagger: 5 })
    gp.groundSparks(p, 260 * S, 2600, FIRE, { size: 0.9 * z, life: 2.4 })
    // shafts of light through everything in front of the fireball, the lens flares, heat shimmers over ground zero
    const post = this.host.post
    _p.copy(p).setY(p.y + 40 * S)
    post.rays(_p, 1.2 + S * 1.2, 4)
    post.streak(2.2, _p)
    post.haze(_p.copy(p).setY(this.gy(p.x, p.z) + 6 * S), 110 * S, 1.3, 16)
    return cloud
  }

  // -------------------------------------------------------------------------

  update(dt: number, rdt: number, camera: THREE.PerspectiveCamera, viewportH: number) {
    this.clock += dt
    if (this.queue.length) {
      const due = this.queue.filter((q) => q.at <= this.clock)
      if (due.length) {
        this.queue = this.queue.filter((q) => q.at > this.clock)
        for (const d of due) d.fn()
      }
    }
    this.glow.setViewport(viewportH, camera.fov)
    this.glow.update(dt)
    this.gpu.update(dt, camera, viewportH)
    this.smoke.update(dt, camera)
    this.fire.update(dt)
    this.debris.update(dt)
    this.ghosts.update(rdt)

    for (const r of this.rings) {
      if (!r.active) continue
      r.t += dt
      const k = Math.min(1, r.t / r.dur)
      const s = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 3))
      r.mesh.scale.setScalar(s)
      r.mat.uniforms.uAlpha.value = (1 - k) * r.a0
      r.mat.uniforms.uTime.value += dt
      if (k >= 1) (r.active = false), (r.mesh.visible = false)
    }
    for (const f of this.flares) {
      if (!f.active) continue
      f.t += rdt
      const k = Math.min(1, f.t / f.dur)
      f.mat.uniforms.uAlpha.value = f.a0 * (1 - k) * (1 - k)
      f.mesh.scale.setScalar(f.r0 * (1 + k * 0.4))
      if (k >= 1) (f.active = false), (f.mesh.visible = false)
    }
    for (const f of this.fireballs) {
      if (!f.active) continue
      f.t += dt
      const k = Math.min(1, f.t / f.dur)
      const grow = 1 - Math.pow(1 - Math.min(1, k * 4), 3)
      f.mesh.scale.setScalar(f.r1 * (0.25 + 0.75 * grow) * (1 + k * 0.35))
      f.mesh.position.y += f.rise * dt * (1 - k)
      f.mat.uniforms.uTime.value += dt
      f.mat.uniforms.uHeat.value = f.heat0 * Math.pow(1 - k, 1.6)
      f.mat.uniforms.uAlpha.value = 1 - Math.pow(k, 3)
      if (k >= 1) (f.active = false), (f.mesh.visible = false)
    }
    for (const b of this.bubbles) {
      if (!b.active) continue
      b.t += dt
      const k = Math.min(1, b.t / b.dur)
      b.mesh.scale.setScalar(b.r1 * (0.2 + 0.8 * (1 - Math.pow(1 - k, 2))))
      b.mat.uniforms.uAlpha.value = b.a0 * (1 - k)
      b.mat.uniforms.uTime.value += dt
      if (k >= 1) (b.active = false), (b.mesh.visible = false)
    }
    for (const s of this.streaks) {
      if (!s.active) continue
      s.t += rdt
      if (s.t < 0) continue
      s.mesh.visible = true
      const k = Math.min(1, s.t / s.dur)
      const appear = Math.min(1, s.t / 0.05)
      s.mat.uniforms.uAlpha.value = appear * (1 - k * k)
      s.mat.uniforms.uWidth.value = s.r0 * (1 + k * 0.5)
      if (k >= 1) (s.active = false), (s.mesh.visible = false)
    }
    for (const l of this.lights) {
      l.power *= Math.exp(-dt * l.decay)
      l.light.intensity = l.power < 0.5 ? 0 : l.power
    }
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i]
      c.update(dt, camera)
      if (c.done) {
        this.root.remove(c.root)
        c.dispose()
        this.clouds.splice(i, 1)
      }
    }
  }

  /** Is anything big (a mushroom cloud) still in progress? */
  get busy() {
    return this.clouds.length > 0
  }

  get activeClouds(): readonly MushroomCloud[] {
    return this.clouds
  }
}

