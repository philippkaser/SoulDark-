import * as THREE from 'three'
import { mulberry32 } from '../../engine/math'
import type { ParticleStyle } from '../../engine/gpuParticles'
import { DECAL_VERT, decalUniforms, TerrainDecal, type DecalGround } from './decal'

/** The bits of Fx levitation uses (Fx satisfies it structurally). */
export interface LevitateFx {
  dust(p: THREE.Vector3, n: number, spread: number, size: number, color?: readonly [number, number, number]): void
  debris: { burst(p: THREE.Vector3, count: number, speed: number, size: number, heat?: number, up?: number): void }
  gpu: { light: { emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, st: ParticleStyle, sizeMul?: number, bright?: number, delay?: number): void } }
}
export interface LevitateScorch {
  fissure(x0: number, z0: number, x1: number, z1: number, width: number, heat?: number, jag?: number): void
}
/** The deformable ground (Terrain satisfies it): rocks stand on it and leave pits in it. */
export interface LevitateGround extends DecalGround {
  heightAt(x: number, z: number): number
  crater?(x: number, z: number, radius: number, depth: number, opts?: { rim?: number; ejecta?: number; seed?: number }): void
}

// rock states
export const OFF = 0
export const WAIT = 1
export const RISE = 2
export const FLY = 3

const GRAVITY = 28

// the crack star: main cracks radiating from the feet, plus branches off them
export const CRACKS = 16
const MAIN = 9
const CRACK_R = 8.5

/** One crack of the star: a wobbling line from (ox, oz) along (dx, dz). */
export interface Crack {
  ox: number
  oz: number
  dx: number
  dz: number
  len: number
  width: number
  seed: number
  /** Power at which it starts to open. */
  need: number
  /** The crack this one branches off (-1 for a main crack) and how far along it. */
  parent: number
  at: number
}

/** How fast a crack's tip tears through the ground (m/s). */
export const CRACK_SPEED = 14

/** Sideways wander of a crack at `s` metres along it (the GPU draws the same curve). */
export function crackLat(s: number, seed: number) {
  return (0.32 * Math.sin(s * 0.85 + seed * 6.2832) + 0.11 * Math.sin(s * 2.9 + seed * 17.0)) * Math.min(1, s * 0.8)
}

/** World-relative point at `s` metres along a crack. */
export function crackPoint(c: Crack, s: number, out: { x: number; z: number }) {
  const l = crackLat(s, c.seed)
  out.x = c.ox + c.dx * s - c.dz * l
  out.z = c.oz + c.dz * s + c.dx * l
  return out
}

/** Open length of a crack once the power has peaked at `grow`. */
export function crackOpen(c: Crack, grow: number) {
  // every crack is fully open at full power
  const t = Math.min(1, Math.max(0, (grow - c.need) / Math.max(0.05, 1 - c.need)))
  return c.len * t * t * (3 - 2 * t)
}

/** A star of cracks: main cracks spread around the circle, then branches forking off them. */
export function crackLayout(seed: number, out: Crack[] = []) {
  const r = mulberry32(seed)
  out.length = 0
  const rot = r() * Math.PI * 2
  for (let i = 0; i < MAIN; i++) {
    const a = rot + ((i + 0.5 + (r() - 0.5) * 0.6) / MAIN) * Math.PI * 2
    const dx = Math.cos(a)
    const dz = Math.sin(a)
    out.push({ ox: dx * 0.45, oz: dz * 0.45, dx, dz, len: 3 + r() * 4, width: 0.05 + r() * 0.04, seed: r(), need: 0.04 + (i / MAIN) * 0.35 + r() * 0.15, parent: -1, at: 0 })
  }
  const p = { x: 0, z: 0 }
  for (let i = MAIN; i < CRACKS; i++) {
    const j = (r() * MAIN) | 0
    const m = out[j]
    const f = 0.3 + r() * 0.4
    crackPoint(m, m.len * f, p)
    const a = Math.atan2(m.dz, m.dx) + (r() < 0.5 ? -1 : 1) * (0.4 + r() * 0.5)
    out.push({ ox: p.x, oz: p.z, dx: Math.cos(a), dz: Math.sin(a), len: m.len * (0.25 + r() * 0.3), width: m.width * 0.6, seed: r(), need: m.need + 0.2 + f * 0.25, parent: j, at: m.len * f })
  }
  return out
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _dq = new THREE.Quaternion()
const _e = new THREE.Euler()
const _s = new THREE.Vector3()
const _p = new THREE.Vector3()
const _v = new THREE.Vector3()
const _ax = new THREE.Vector3()
const _side = new THREE.Vector3()
const _pt = { x: 0, z: 0 }
const _pt2 = { x: 0, z: 0 }
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

/** Hot stones shed embers as they fly. */
const EMBER: ParticleStyle = { c0: [3.2, 1.1, 0.2, 1], c1: [1.2, 0.25, 0.04, 0], s0: 0.09, s1: 0.04, gravity: -1.5, drag: 1.5, curl: 0.8, curlFreq: 0.5, flicker: 0.5, core: 0.6, fadeIn: 0.05 }

const _seg = new THREE.Vector3()
const _foc = new THREE.Vector3()

/**
 * Push p out of a capsule around the segment eye → (center at height y),
 * sideways and up. Returns how far it moved.
 */
export function keepOut(p: THREE.Vector3, eye: THREE.Vector3, center: THREE.Vector3, y: number, r: number) {
  _foc.set(center.x, y, center.z)
  _seg.subVectors(_foc, eye)
  const l2 = _seg.lengthSq()
  if (l2 < 1e-6) return 0
  const t = Math.max(0, Math.min(1, _v.subVectors(p, eye).dot(_seg) / l2))
  // near the hero the line is his own body: let rocks pass behind and around him
  if (t > 0.8) return 0
  _foc.copy(eye).addScaledVector(_seg, t)
  _v.subVectors(p, _foc)
  const d = _v.length()
  if (d >= r) return 0
  if (d < 1e-4) _v.set(0, 1, 0)
  else _v.divideScalar(d)
  // slip up and aside rather than down into the ground, square to the line
  if (_v.y < 0.3) _v.y = 0.3
  _seg.divideScalar(Math.sqrt(l2))
  _v.addScaledVector(_seg, -_v.dot(_seg)).normalize()
  p.copy(_foc).addScaledVector(_v, r)
  return r - d
}

/** A faceted boulder. */
function rockGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1)
  const pos = g.attributes.position as THREE.BufferAttribute
  const r = mulberry32(7)
  const v = new THREE.Vector3()
  // icosahedron vertices are duplicated per face; jitter by position so the hull stays closed
  const seen = new Map<string, number>()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`
    let k = seen.get(key)
    if (k === undefined) {
      k = 0.62 + r() * 0.55
      seen.set(key, k)
    }
    v.multiplyScalar(k)
    v.y *= 0.72
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  g.computeVertexNormals()
  return g
}

/**
 * Rocks torn out of the ground by the hero's power: they peel off one by one
 * as power builds (a dust puff and a pit where each boulder was), rise, bob
 * and orbit slowly, shudder at full power, then blast outward on release and
 * tumble down onto the terrain. One instanced draw call. Under them a star
 * of cracks opens, glowing with the power and burning scars into the scorch
 * map. Runs on the world clock.
 */
export class Levitation {
  readonly root = new THREE.Group()
  readonly mesh: THREE.InstancedMesh
  readonly max: number
  /** Where the rocks orbit (follows the hero). */
  readonly center = new THREE.Vector3()
  /** Where the crack star opened. */
  readonly crackCenter = new THREE.Vector3()
  ground: LevitateGround | null = null
  /** The camera: rocks aloft keep out of its line to the hero. */
  readonly eye = new THREE.Vector3(0, 1e4, 0)
  private fx: LevitateFx | null
  private scorch: LevitateScorch | null
  private q: number
  // per rock
  readonly state: Uint8Array
  readonly pos: Float32Array
  readonly vel: Float32Array
  private rot: Float32Array
  private spin: Float32Array
  private size: Float32Array
  private need: Float32Array
  private hover: Float32Array
  private orbitR: Float32Array
  private orbitA: Float32Array
  private orbitW: Float32Array
  private phase: Float32Array
  private life: Float32Array
  private bounces: Uint8Array
  private heat: Float32Array
  private glowAttr: THREE.InstancedBufferAttribute
  private power = 0
  private heldT = 0
  private sessionOn = false
  private time = 0
  // the crack star
  readonly cracks: Crack[] = []
  private painted = new Float32Array(CRACKS)
  /** How far each crack's tip has torn so far. */
  readonly opened = new Float32Array(CRACKS)
  private decal: TerrainDecal
  private crackA: THREE.Vector4[] = []
  private crackB: THREE.Vector4[] = []
  private crackU: Record<string, THREE.IUniform>
  private crackHeat = 0
  private crackGrow = 0
  private paintT = 0

  constructor(fx: LevitateFx | null, scorch: LevitateScorch | null, quality = 1, cell = 2) {
    this.fx = fx
    this.scorch = scorch
    this.q = quality
    const n = Math.round(84 * quality)
    this.max = n
    this.state = new Uint8Array(n)
    this.pos = new Float32Array(n * 3)
    this.vel = new Float32Array(n * 3)
    this.rot = new Float32Array(n * 4)
    this.spin = new Float32Array(n * 4)
    this.size = new Float32Array(n)
    this.need = new Float32Array(n)
    this.hover = new Float32Array(n)
    this.orbitR = new Float32Array(n)
    this.orbitA = new Float32Array(n)
    this.orbitW = new Float32Array(n)
    this.phase = new Float32Array(n)
    this.life = new Float32Array(n)
    this.bounces = new Uint8Array(n)
    this.heat = new Float32Array(n)

    const geo = rockGeometry()
    this.glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aGlow', this.glowAttr)
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0.05, flatShading: true })
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aGlow;\nvarying vec2 vGlow;\nvarying float vUp;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvUp = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal).y;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vGlow;\nvarying float vUp;').replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        {
          // x: molten heat on the torn underside; y: the golden rim of the hero's power
          // (basalt is nearly black: anything brighter than a sliver would wash it out)
          float under = 1.0 - smoothstep(-0.8, 0.2, vUp);
          totalEmissiveRadiance += vec3(1.6, 0.45, 0.08) * vGlow.x * (0.04 + under * 1.2);
          float fres = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 5.0);
          totalEmissiveRadiance += vec3(1.5, 0.95, 0.4) * vGlow.y * fres * 0.3;
        }`,
      )
    }
    mat.customProgramCacheKey = () => 'levitate-v2'
    this.mesh = new THREE.InstancedMesh(geo, mat, n)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    const c = new THREE.Color()
    const r = mulberry32(31)
    for (let i = 0; i < n; i++) {
      // basalt like the plain, a few paler ashy stones
      const g = r() < 0.2 ? 0.07 + r() * 0.04 : 0.025 + r() * 0.03
      this.mesh.setColorAt(i, c.setRGB(g * 1.1, g * 0.9, g * 0.82))
      this.mesh.setMatrixAt(i, ZERO)
    }
    this.mesh.visible = false

    for (let i = 0; i < CRACKS; i++) {
      this.crackA.push(new THREE.Vector4())
      this.crackB.push(new THREE.Vector4())
    }
    const cm = crackMaterial(this.crackA, this.crackB)
    this.crackU = cm.uniforms
    this.decal = new TerrainDecal(CRACK_R, cm, cell)
    this.decal.mesh.renderOrder = 3
    this.root.add(this.mesh, this.decal.mesh)
  }

  setGround(ground: LevitateGround | null) {
    this.ground = ground
    this.decal.setGround(ground)
  }

  private gy(x: number, z: number) {
    return this.ground ? this.ground.heightAt(x, z) : 0
  }

  /** Is anything still lifting, hovering or flying? */
  get active() {
    return this.sessionOn || this.state.some((s) => s !== OFF)
  }

  /** Rocks currently held aloft. */
  get aloft() {
    let n = 0
    for (let i = 0; i < this.max; i++) if (this.state[i] === RISE) n++
    return n
  }

  /** Start tearing rocks out of the ground around `center`. */
  begin(center: THREE.Vector3) {
    if (this.sessionOn) this.drop()
    this.sessionOn = true
    this.power = 0
    this.heldT = 0
    this.center.copy(center)
    this.crackCenter.copy(center)
    this.crackGrow = 0
    this.crackHeat = 0.4
    crackLayout((Math.random() * 1e9) | 0, this.cracks)
    this.painted.fill(0)
    this.opened.fill(0)
    this.paintT = 0
    this.crackU.uSeed.value = Math.random() * 100
    this.decal.place(center.x, center.z)
    const n = this.max
    for (let i = 0; i < n; i++) {
      if (this.state[i] !== OFF) continue
      // boulders, stones and pebbles; bigger ones need more power to tear loose
      const u = i / n
      const kind = u < 0.15 ? 2 : u < 0.42 ? 1 : 0
      this.size[i] = kind === 2 ? 0.3 + Math.random() * 0.3 : kind === 1 ? 0.13 + Math.random() * 0.14 : 0.04 + Math.random() * 0.07
      this.need[i] = kind === 2 ? 0.2 + Math.random() * 0.7 : kind === 1 ? 0.06 + Math.random() * 0.75 : Math.random() * 0.85
      // big ones keep clear of the hero so he stays in view
      this.orbitR[i] = kind === 2 ? 3.2 + Math.random() * 3.5 : kind === 1 ? 2 + Math.random() * 4.5 : 1.2 + Math.random() * 5.5
      this.orbitA[i] = Math.random() * Math.PI * 2
      this.orbitW[i] = (0.12 + Math.random() * 0.3) * (Math.random() < 0.5 ? -1 : 1) * (kind === 0 ? 2 : 1)
      this.hover[i] = kind === 2 ? 0.9 + Math.random() * 3.2 : 0.5 + Math.random() * 5
      this.phase[i] = Math.random() * Math.PI * 2
      this.state[i] = WAIT
      this.heat[i] = 0
      this.bounces[i] = 0
    }
  }

  /** Hold the power (0..1) for this frame; `center` lets the rocks follow the hero. Without calls they drop. */
  setPower(k: number, center?: THREE.Vector3, dt = 1 / 60) {
    if (!this.sessionOn) this.begin(center ?? this.center)
    this.power = Math.max(0, Math.min(1, k))
    this.heldT = 0
    if (center) {
      const f = 1 - Math.exp(-dt * 5)
      this.center.x += (center.x - this.center.x) * f
      this.center.z += (center.z - this.center.z) * f
    }
  }

  /** Blast the rocks outward (radially) or along `dir`; they tumble and fall. */
  release(dir?: THREE.Vector3 | null, speed = 1) {
    if (!this.sessionOn && !this.state.some((s) => s === RISE)) return
    this.sessionOn = false
    this.crackHeat = 1.15
    this.crackGrow = Math.max(this.crackGrow, 0.5 + this.power * 0.5)
    if (dir) _side.set(dir.z, 0, -dir.x).normalize()
    for (let i = 0; i < this.max; i++) {
      const st = this.state[i]
      if (st === WAIT) {
        this.state[i] = OFF
        continue
      }
      if (st !== RISE) continue
      const k = i * 3
      const sz = this.size[i]
      if (dir) {
        // down the cut: a wall of stone that fans out as it goes
        const fast = (40 + Math.random() * 60) * speed * (1.1 - Math.min(1, sz) * 0.45)
        const sx = (Math.random() - 0.5) * 20
        this.vel[k] = dir.x * fast + _side.x * sx
        this.vel[k + 1] = 4 + Math.random() * 11
        this.vel[k + 2] = dir.z * fast + _side.z * sx
      } else {
        _v.set(this.pos[k] - this.center.x, 0, this.pos[k + 2] - this.center.z)
        if (_v.lengthSq() < 1e-4) _v.set(Math.random() - 0.5, 0, Math.random() - 0.5)
        _v.normalize().multiplyScalar((20 + Math.random() * 28) * speed)
        this.vel[k] = _v.x
        this.vel[k + 1] = 6 + Math.random() * 12
        this.vel[k + 2] = _v.z
      }
      this.spin[i * 4 + 3] = (Math.random() * 2 - 1) * 14
      this.heat[i] = 0.7 + Math.random() * 0.3
      this.life[i] = 3 + Math.random() * 2
      this.bounces[i] = 0
      this.state[i] = FLY
    }
  }

  /** Let everything aloft fall where it is (the charge was cancelled). */
  drop() {
    this.sessionOn = false
    for (let i = 0; i < this.max; i++) {
      if (this.state[i] === WAIT) this.state[i] = OFF
      else if (this.state[i] === RISE) {
        this.state[i] = FLY
        this.life[i] = 3
        this.bounces[i] = 0
        const k = i * 3
        this.vel[k] *= 0.3
        this.vel[k + 2] *= 0.3
      }
    }
  }

  clear() {
    this.sessionOn = false
    this.state.fill(OFF)
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, ZERO)
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.visible = false
    this.decal.mesh.visible = false
    this.crackHeat = this.crackGrow = 0
    this.power = 0
  }

  /** A rock tears free of the ground. */
  private liftOff(i: number) {
    const k = i * 3
    const s = this.size[i]
    const a = this.orbitA[i]
    const r = this.orbitR[i] * (0.8 + Math.random() * 0.3)
    const x = this.center.x + Math.sin(a) * r
    const z = this.center.z + Math.cos(a) * r
    const gy = this.gy(x, z)
    this.pos[k] = x
    this.pos[k + 1] = gy - s * 0.4
    this.pos[k + 2] = z
    this.vel[k] = 0
    this.vel[k + 1] = 4 + Math.random() * 5 + (s < 0.2 ? 4 : 0)
    this.vel[k + 2] = 0
    _q.setFromEuler(_e.set(Math.random() * 6, Math.random() * 6, Math.random() * 6))
    this.rot[i * 4] = _q.x
    this.rot[i * 4 + 1] = _q.y
    this.rot[i * 4 + 2] = _q.z
    this.rot[i * 4 + 3] = _q.w
    _ax.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
    this.spin[i * 4] = _ax.x
    this.spin[i * 4 + 1] = _ax.y
    this.spin[i * 4 + 2] = _ax.z
    this.spin[i * 4 + 3] = (Math.random() * 2 - 1) * (s < 0.2 ? 2.5 : 0.8)
    this.heat[i] = 0.3 + Math.random() * 0.35
    this.state[i] = RISE
    const fx = this.fx
    if (!fx) return
    _p.set(x, gy + 0.2, z)
    if (s > 0.12) {
      if (s > 0.28) fx.dust(_p, 1, s * 1.2, 0.5 + s * 1.6)
      fx.debris.burst(_p, s > 0.28 ? 4 : 2, 3 + s * 5, 0.04 + s * 0.12, 0.6, 1.2)
      // boulders leave a pit where they tore out
      if (s > 0.28) this.ground?.crater?.(x, z, 0.5 + s * 1.4, 0.12 + s * 0.35, { rim: 0.6, ejecta: 0.2 })
    }
  }

  update(dt: number) {
    this.time += dt
    if (dt <= 0) return
    this.heldT += dt
    // nobody is holding the power any more: everything falls
    if (this.sessionOn && this.heldT > 0.3) this.drop()
    const pw = this.power
    const n = this.max
    const baseY = this.gy(this.center.x, this.center.z)
    let any = false
    for (let i = 0; i < n; i++) {
      const st = this.state[i]
      if (st === OFF) continue
      if (st === WAIT) {
        any = true
        if (this.sessionOn && pw >= this.need[i] && Math.random() < dt * 9) this.liftOff(i)
        continue
      }
      any = true
      const k = i * 3
      const s = this.size[i]
      if (st === RISE) {
        // spring toward a slow orbit around the centre, rising higher as power builds
        this.orbitA[i] += this.orbitW[i] * (0.4 + pw * 1.2) * dt
        const r = this.orbitR[i] * (1 - pw * 0.1)
        let tx = this.center.x + Math.sin(this.orbitA[i]) * r
        let tz = this.center.z + Math.cos(this.orbitA[i]) * r
        let ty = baseY + s * 0.6 + this.hover[i] * (0.35 + pw * 0.75) + Math.sin(this.time * 1.7 + this.phase[i]) * (0.12 + s * 0.15)
        // stay out of the shot: rocks drifting into the camera's line to the hero slip aside
        _p.set(tx, ty, tz)
        const d = keepOut(_p, this.eye, this.center, baseY + 1.2, 0.9 + s * 2)
        if (d > 0) {
          tx = _p.x
          ty = _p.y
          tz = _p.z
        }
        const kk = 7
        const c = 2 * Math.sqrt(kk) * 0.75
        this.vel[k] += ((tx - this.pos[k]) * kk - this.vel[k] * c) * dt
        this.vel[k + 1] += ((ty - this.pos[k + 1]) * kk - this.vel[k + 1] * c) * dt
        this.vel[k + 2] += ((tz - this.pos[k + 2]) * kk - this.vel[k + 2] * c) * dt
        this.pos[k] += this.vel[k] * dt
        this.pos[k + 1] += this.vel[k + 1] * dt
        this.pos[k + 2] += this.vel[k + 2] * dt
        this.heat[i] = Math.max(0.08, this.heat[i] - dt * 0.3)
      } else {
        this.vel[k + 1] -= GRAVITY * dt
        this.pos[k] += this.vel[k] * dt
        this.pos[k + 1] += this.vel[k + 1] * dt
        this.pos[k + 2] += this.vel[k + 2] * dt
        this.life[i] -= dt
        this.heat[i] = Math.max(0, this.heat[i] - dt * 0.5)
        const floor = this.gy(this.pos[k], this.pos[k + 2]) + s * 0.45
        if (this.pos[k + 1] < floor) {
          const vy = this.vel[k + 1]
          this.pos[k + 1] = floor
          this.vel[k + 1] = vy < 0 ? -vy * 0.3 : vy
          this.vel[k] *= 0.5
          this.vel[k + 2] *= 0.5
          this.spin[i * 4 + 3] *= 0.5
          if (vy < -6 && this.bounces[i] < 2 && s > 0.3 && this.fx) this.fx.dust(_p.set(this.pos[k], floor - s * 0.3, this.pos[k + 2]), 1, s, 0.6 + s * 1.5)
          if (++this.bounces[i] > 3 || Math.abs(vy) < 1.5) {
            this.vel[k] = this.vel[k + 2] = 0
            this.spin[i * 4 + 3] = 0
            this.life[i] = Math.min(this.life[i], 1.2)
          }
        }
        if (this.fx && this.heat[i] > 0.4 && s > 0.15 && Math.random() < dt * 30 * this.q) {
          this.fx.gpu.light.emit(this.pos[k], this.pos[k + 1], this.pos[k + 2], (Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2, 0.5 + Math.random() * 0.5, EMBER, 0.6 + s, 1)
        }
        if (this.life[i] <= 0) {
          this.state[i] = OFF
          this.mesh.setMatrixAt(i, ZERO)
          continue
        }
      }
      // tumble
      const r4 = i * 4
      _ax.set(this.spin[r4], this.spin[r4 + 1], this.spin[r4 + 2])
      _q.set(this.rot[r4], this.rot[r4 + 1], this.rot[r4 + 2], this.rot[r4 + 3])
      _dq.setFromAxisAngle(_ax, this.spin[r4 + 3] * dt)
      _q.premultiply(_dq).normalize()
      this.rot[r4] = _q.x
      this.rot[r4 + 1] = _q.y
      this.rot[r4 + 2] = _q.z
      this.rot[r4 + 3] = _q.w
      _p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2])
      // full power: everything shudders
      if (st === RISE && pw > 0.75) {
        const j = (pw - 0.75) * 0.5 * (0.3 + s)
        _p.x += (Math.random() - 0.5) * j
        _p.y += (Math.random() - 0.5) * j
        _p.z += (Math.random() - 0.5) * j
      }
      // spent rocks settle into the ground
      const fade = st === FLY ? Math.min(1, this.life[i] / 1.2) : 1
      if (fade < 1) _p.y -= s * 0.9 * (1 - fade)
      _s.setScalar(s * (0.6 + 0.4 * fade))
      _m.compose(_p, _q, _s)
      this.mesh.setMatrixAt(i, _m)
      this.glowAttr.setXY(i, this.heat[i], st === RISE ? 0.25 + pw * 0.75 : this.heat[i] * 0.4)
    }
    this.mesh.visible = any
    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true
      this.glowAttr.needsUpdate = true
    }
    this.updateCracks(dt)
  }

  /** The cracks spread with the power, glow, burn into the scorch map, and cool after the release. */
  private updateCracks(dt: number) {
    if (this.sessionOn) {
      this.crackGrow = Math.max(this.crackGrow, this.power)
      this.crackHeat += (0.35 + this.power * 0.6 - this.crackHeat) * Math.min(1, dt * 4)
    } else this.crackHeat = Math.max(0, this.crackHeat - dt * (this.crackHeat > 0.6 ? 1.5 : 0.3))
    const on = this.crackHeat > 0.01 && this.crackGrow > 0.01
    this.decal.mesh.visible = on
    if (!on) return
    const cx = this.crackCenter.x
    const cz = this.crackCenter.z
    // burn the opened stretches into the ground for good, a few times a second (every stroke re-uploads the scorch map)
    this.paintT -= dt
    const paint = this.scorch !== null && this.paintT <= 0
    if (paint) this.paintT = 0.2
    for (let i = 0; i < CRACKS; i++) {
      const c = this.cracks[i]
      if (!c) continue
      // tips tear outward at a finite speed; a branch waits for its parent to reach it
      const target = c.parent >= 0 && this.opened[c.parent] < c.at ? 0 : crackOpen(c, this.crackGrow)
      const open = (this.opened[i] = Math.min(target, Math.max(this.opened[i], this.opened[i] + dt * CRACK_SPEED)))
      this.crackA[i].set(c.ox, c.oz, c.dx, c.dz)
      this.crackB[i].set(c.len, open, c.width, c.seed)
      if (paint) this.burn(c, i, open, cx, cz)
    }
    this.crackU.uHeat.value = this.crackHeat
    this.crackU.uGrow.value = this.crackGrow
    this.crackU.uTime.value = this.time
  }

  /** Paint crack i from where it was last painted to `open`, in strokes of about a metre that follow its curve. */
  private burn(c: Crack, i: number, open: number, cx: number, cz: number) {
    let s0 = this.painted[i]
    if (open - s0 < 0.05) return
    const n = Math.ceil((open - s0) / 1.2)
    const step = (open - s0) / n
    crackPoint(c, s0, _pt)
    for (let j = 0; j < n; j++) {
      s0 += step
      crackPoint(c, s0, _pt2)
      // the star's strokes overlap near the feet: keep each one cool or they pool into a glowing disc
      this.scorch!.fissure(cx + _pt.x, cz + _pt.z, cx + _pt2.x, cz + _pt2.z, c.width * 3, 0.35, 0)
      _pt.x = _pt2.x
      _pt.z = _pt2.z
    }
    this.painted[i] = open
  }
}

/**
 * The crack star drawn crisply over the terrain: jagged glowing lines (the
 * same curves the CPU burns into the scorch map), hot growing tips, soot
 * around them and a broken ring where the ground heaves.
 */
function crackMaterial(a: THREE.Vector4[], b: THREE.Vector4[]) {
  return new THREE.ShaderMaterial({
    uniforms: { ...decalUniforms(), uCrackA: { value: a }, uCrackB: { value: b }, uGrow: { value: 0 }, uHeat: { value: 0 }, uTime: { value: 0 }, uSeed: { value: 0 }, uRadius: { value: CRACK_R } },
    vertexShader: DECAL_VERT,
    fragmentShader: /* glsl */ `
      uniform vec4 uCrackA[${CRACKS}];
      uniform vec4 uCrackB[${CRACKS}];
      uniform float uGrow;
      uniform float uHeat;
      uniform float uTime;
      uniform float uSeed;
      uniform float uRadius;
      varying vec2 vRel;
      float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vn(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
      // piecewise-linear noise in -1..1: fractures run in straight jagged runs, not waves
      float zig(float s, float seed) { float i = floor(s); float f = s - i; return mix(h21(vec2(i, seed * 91.0)), h21(vec2(i + 1.0, seed * 91.0)), f) * 2.0 - 1.0; }
      float lat(float s, float seed) { return (0.32 * sin(s * 0.85 + seed * 6.2832) + 0.11 * sin(s * 2.9 + seed * 17.0)) * min(1.0, s * 0.8); }
      void main() {
        float r = length(vRel);
        if (r > uRadius) discard;
        float crack = 0.0;
        float soot = 0.0;
        float tip = 0.0;
        for (int i = 0; i < ${CRACKS}; i++) {
          vec4 A = uCrackA[i];
          vec4 B = uCrackB[i];
          if (B.y < 0.02) continue;
          vec2 p = vRel - A.xy;
          float along = dot(p, A.zw);
          if (along < -0.4 || along > B.y + 0.6) continue;
          float perp = dot(p, vec2(-A.w, A.z));
          float fine = zig(along * 2.2, B.w) * 0.09 + zig(along * 7.0, B.w + 3.1) * 0.025;
          float d = abs(perp - lat(along, B.w) - fine);
          float u = clamp(along / B.x, 0.0, 1.0);
          float w = B.z * (1.0 - u * 0.7);
          float inside = smoothstep(-0.25, 0.1, along) * (1.0 - smoothstep(B.y - 0.3, B.y + 0.05, along));
          crack = max(crack, (1.0 - smoothstep(w * 0.15, w, d)) * inside);
          soot = max(soot, (1.0 - smoothstep(0.0, w * 7.0, d)) * inside);
          // the hot point where a crack is still tearing open
          float growing = step(B.y, B.x - 0.05);
          tip = max(tip, exp(-pow((along - B.y) * 4.0, 2.0) - d * d * 120.0) * growing);
        }
        // a broken ring where the ground heaves up around the feet
        float ang = atan(vRel.y, vRel.x);
        float rr = 1.3 + uGrow * 1.3 + (vn(vec2(ang * 3.0, uSeed)) - 0.5) * 0.4;
        float ring = (1.0 - smoothstep(0.0, 0.035, abs(r - rr))) * step(0.45, vn(vec2(ang * 5.0, 3.0 + uSeed))) * step(0.2, uGrow);
        crack = max(crack, ring * 0.6);
        soot = max(soot, (1.0 - smoothstep(0.0, 2.6, r)) * 0.6 * min(1.0, uGrow * 2.0));
        float flick = 0.8 + 0.2 * vn(vec2(r * 1.5 - uTime * 2.0, ang * 4.0));
        float hot = clamp(uHeat, 0.0, 2.0);
        vec3 lava = mix(vec3(0.9, 0.16, 0.02), vec3(2.0, 0.85, 0.22), clamp(hot - 0.35, 0.0, 1.0));
        lava = mix(lava, vec3(2.8, 1.9, 0.9), clamp(hot - 1.0, 0.0, 1.0));
        vec3 glow = lava * (crack * flick * min(1.0, hot * 1.5) + tip * 1.6 * min(1.0, hot));
        float edge = (1.0 - smoothstep(uRadius - 1.5, uRadius, r));
        float a = max(soot * 0.55 * edge, min(1.0, crack * min(1.0, hot * 2.0 + 0.3) + tip));
        if (a < 0.003) discard;
        gl_FragColor = vec4(glow / max(a, 0.001), a);
      }`,
    transparent: true,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
}
