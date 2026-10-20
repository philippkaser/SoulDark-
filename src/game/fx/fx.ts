import * as THREE from 'three'
import { ParticlePool } from '../../engine/particles'
import { audio } from '../../audio/audio'
import type { PostState } from '../post'
import type { ScorchMap } from '../world/scorch'
import type { Sky } from '../world/sky'
import { Afterimages } from './afterimage'
import { Debris } from './debris'
import { MushroomCloud } from './mushroom'
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
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const _v = new THREE.Vector3()
const _p = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

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
    this.glow = new ParticlePool({ capacity: Math.round(14000 * q), mode: 'points', additive: true, renderOrder: 9 })
    this.smoke = new ParticlePool({ capacity: Math.round(4200 * q), mode: 'quads', renderOrder: 7 })
    this.fire = new ParticlePool({ capacity: Math.round(2400 * q), mode: 'quads', additive: true, renderOrder: 8 })
    this.fire.sort = false
    this.fire.uniforms.uLit.value = 0
    this.root.add(this.glow.object, this.smoke.object, this.fire.object, this.debris.mesh, this.ghosts.root)
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
      if (Math.random() < 0.5) this.dust(_p.set(x, 0.2, z), 3, s, s * 1.4)
    }
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
    if (!opts.normal) r.mesh.position.y = Math.max(p.y, 0.06)
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
  }

  spark(p: THREE.Vector3, dir: THREE.Vector3 | null, n: number, speed: number, color: readonly [number, number, number] = [1, 0.75, 0.35], size = 0.06) {
    n = Math.round(n * this.host.quality)
    for (let i = 0; i < n; i++) {
      randomDir(_v, dir, 1.3).multiplyScalar(speed * rnd(0.3, 1))
      this.glow.spawn(p, _v, color, 1, size * rnd(0.6, 1.4), rnd(0.2, 0.6), 14, 2.2)
    }
  }

  embers(p: THREE.Vector3, n: number, spread: number, up = 2) {
    n = Math.round(n * this.host.quality)
    for (let i = 0; i < n; i++) {
      _p.set(p.x + rnd(-spread, spread), p.y + rnd(-spread * 0.3, spread * 0.5), p.z + rnd(-spread, spread))
      _v.set(rnd(-1, 1), rnd(0.5, 1.5) * up, rnd(-1, 1))
      this.glow.spawn(_p, _v, [1, rnd(0.3, 0.6), 0.1], 1, rnd(0.04, 0.09), rnd(0.8, 2.2), -0.6, 0.9)
    }
  }

  dust(p: THREE.Vector3, n: number, spread: number, size: number, color: readonly [number, number, number] = [0.32, 0.27, 0.24]) {
    n = Math.max(1, Math.round(n * this.host.quality))
    for (let i = 0; i < n; i++) {
      _p.set(p.x + rnd(-spread, spread), p.y + rnd(0, spread * 0.3), p.z + rnd(-spread, spread))
      _v.set(rnd(-1, 1) * spread, rnd(0.4, 1.6) * Math.max(1, spread * 0.4), rnd(-1, 1) * spread)
      this.smoke.spawn(_p, _v, color, 0.55, size * rnd(0.6, 1.3), rnd(1.4, 2.8), -0.3, 1.8, { grow: 1.4 })
    }
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
    const ground = p.y < s * 1.2
    this.light(_p.copy(p).setY(p.y + s * 0.5), opts.color ?? '#ff9a48', 40 * s * s, s * 14, 4)
    this.flare(p, s * 5, '#ffd8a0', 0.3)
    this.fireball(p, s, 0.7 + s * 0.05, s * 0.6)
    this.spark(p, null, 30 + s * 8, s * 9, [1, 0.6, 0.2], 0.08 + s * 0.012)
    const nf = Math.round((10 + s * 3) * this.host.quality)
    for (let i = 0; i < nf; i++) {
      randomDir(_v).multiplyScalar(s * rnd(1, 4))
      if (ground) _v.y = Math.abs(_v.y)
      this.fire.spawn(p, _v, [1, rnd(0.45, 0.7), 0.2], 0.9, s * rnd(0.5, 1.1), rnd(0.3, 0.7), -2, 3, { grow: 1.2 })
    }
    this.smokeColumn(_p.copy(p), 6 + s, s * 1.1, s * 1.6, 1.2, 0.1)
    if (ground) {
      this.ring(_p.copy(p).setY(0.1), s * 3.2, '#ffb070', 0.5 + s * 0.02, { thick: 0.18 })
      this.dust(_p.copy(p).setY(0.3), 6 + s, s * 1.2, s * 1.2)
      if (opts.scorch !== false) this.host.scorch.crater(p.x, p.z, s * 1.3, 0.9)
      if (opts.debris !== false && s > 1.5) this.debris.burst(_p.copy(p).setY(0.5), Math.min(40, Math.round(s * 4)), s * 3.5, 0.15 + s * 0.06, 1)
    }
    const d = p.distanceTo(this.host.camera.position)
    this.host.shake(Math.min(1, s * 0.12) * Math.max(0.15, 1 - d / (s * 30)), p)
    if (s > 4 && d < s * 25) this.host.post.shock(p, this.host.camera, 0.012 + s * 0.002)
    if (opts.sound !== false) audio.explosion(p, s)
  }

  /** Hero-side impact: sword strikes, parries, ground slams. */
  impact(p: THREE.Vector3, dir: THREE.Vector3 | null, size: number, color: THREE.ColorRepresentation = '#ffe0a0') {
    this.flare(p, size * 3, color, 0.18)
    this.spark(p, dir, 18 + size * 10, 8 + size * 4, [1, 0.85, 0.55], 0.05 + size * 0.01)
    this.light(p, color, 30 * size, 8 + size * 4, 10)
  }

  /** The burst of a parry; tier sets the scale. */
  parryBurst(p: THREE.Vector3, normal: THREE.Vector3, tier: number) {
    const s = 1 + tier * 1.4
    this.flare(p, 3 * s, '#fff2d0', 0.25 + tier * 0.08)
    this.ring(p, 2.5 * s, '#fff0c8', 0.35 + tier * 0.1, { normal, thick: 0.12 })
    this.ring(p, 5 * s, '#ffcf70', 0.5 + tier * 0.15, { normal, thick: 0.06, alpha: 1 })
    this.spark(p, normal, 50 + tier * 40, 14 + tier * 8, [1, 0.92, 0.7], 0.06 + tier * 0.02)
    this.bubble(p, 1.5 * s, '#ffd890', 0.3 + tier * 0.1, 1.2)
    this.light(p, '#fff0d0', 120 * s, 20 * s, 7)
    if (tier >= 2) this.ring(_p.copy(p).setY(0.1), 14 * s, '#ffdf9a', 0.8, { thick: 0.08 })
  }

  /** Landing / stomp shockwave on the ground. */
  groundShock(p: THREE.Vector3, radius: number, color: THREE.ColorRepresentation = '#ffd090', debris = true) {
    this.ring(_p.copy(p).setY(0.1), radius, color, 0.55, { thick: 0.2 })
    this.ring(_p.copy(p).setY(0.12), radius * 0.6, '#ffffff', 0.35, { thick: 0.3 })
    // a dust wall racing outward
    const n = Math.round(radius * 3 * this.host.quality)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.05, 0.05)
      _p.set(p.x + Math.sin(a) * 1.5, 0.4, p.z + Math.cos(a) * 1.5)
      _v.set(Math.sin(a) * radius * rnd(1.2, 2.2), rnd(0.5, 3), Math.cos(a) * radius * rnd(1.2, 2.2))
      this.smoke.spawn(_p, _v, [0.36, 0.31, 0.28], 0.5, rnd(1.2, 2.4), rnd(0.9, 1.6), -0.2, 2.6, { grow: 1.5 })
    }
    if (debris) this.debris.burst(_p.copy(p).setY(0.3), Math.round(radius * 1.5), radius * 0.9, 0.18, 0.4)
    this.host.scorch.crater(p.x, p.z, radius * 0.45, 0.8)
  }

  /** A soldier struck down: ember and ash burst. */
  vaporize(p: THREE.Vector3, hot: boolean) {
    const q = this.host.quality
    const n = Math.round((hot ? 26 : 12) * q)
    for (let i = 0; i < n; i++) {
      _p.set(p.x + rnd(-0.3, 0.3), p.y + rnd(0, 1.6), p.z + rnd(-0.3, 0.3))
      _v.set(rnd(-1.5, 1.5), rnd(0.5, 3), rnd(-1.5, 1.5))
      if (Math.random() < (hot ? 0.7 : 0.4)) this.glow.spawn(_p, _v, [1, rnd(0.35, 0.6), 0.1], 1, rnd(0.04, 0.09), rnd(0.5, 1.4), -0.5, 1.2)
      else {
        const g = rnd(0.05, 0.12)
        this.smoke.spawn(_p, _v, [g, g, g], 0.7, rnd(0.25, 0.5), rnd(0.8, 1.6), -0.3, 1.5, { grow: 1.2, heat: hot ? 0.8 : 0, cool: 1.5 })
      }
    }
  }

  /** A blood-red spurt of armour shards (enemies hit but not killed). */
  chip(p: THREE.Vector3, dir: THREE.Vector3 | null) {
    this.spark(p, dir, 12, 9, [1, 0.5, 0.2], 0.05)
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

