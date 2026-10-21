import * as THREE from 'three'
import { mulberry32 } from '../../engine/math'
import { billowFrag, billowVert, boulderFrag, boulderVert } from './mountainShaders'

/** Height of whatever rubble lands on: the rings and the plain. */
export type GroundFn = (x: number, z: number) => number

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _dq = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _p = new THREE.Vector3()
const _ax = new THREE.Vector3()
const _n = new THREE.Vector3()

const GRAVITY = 18

function boulderGeo() {
  const g = new THREE.IcosahedronGeometry(1, 2)
  const pos = g.attributes.position as THREE.BufferAttribute
  const r = mulberry32(4242)
  const ph = [r() * 6, r() * 6, r() * 6]
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    // a fractured slab: flattened, with facets
    const k = 0.78 + 0.22 * Math.sin(v.x * 3.1 + ph[0]) * Math.sin(v.y * 2.7 + ph[1]) + 0.12 * Math.sin(v.z * 5.3 + ph[2])
    v.multiplyScalar(k)
    v.y *= 0.7
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  g.computeVertexNormals()
  return g
}

/**
 * Mountain-scale rubble: slabs tens of metres across, thrown out of a bored
 * face, bouncing and rolling down the slopes. Lit and hazed like the rock.
 */
export class Boulders {
  readonly mesh: THREE.InstancedMesh
  readonly cap: number
  private pos: Float32Array
  private vel: Float32Array
  private rot: Float32Array
  private spin: Float32Array
  private size: Float32Array
  private life: Float32Array
  private heat: Float32Array
  private heatAttr: THREE.InstancedBufferAttribute
  private next = 0
  private live = 0
  /** Hard landings (for dust). */
  onLand?: (x: number, y: number, z: number, size: number) => void

  constructor(cap: number, common: Record<string, THREE.IUniform>) {
    this.cap = cap
    this.pos = new Float32Array(cap * 3)
    this.vel = new Float32Array(cap * 3)
    this.rot = new Float32Array(cap * 4)
    this.spin = new Float32Array(cap * 4)
    this.size = new Float32Array(cap)
    this.life = new Float32Array(cap)
    this.heat = new Float32Array(cap)
    const geo = boulderGeo()
    this.heatAttr = new THREE.InstancedBufferAttribute(this.heat, 1)
    this.heatAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('iHeat', this.heatAttr)
    const mat = new THREE.ShaderMaterial({ vertexShader: boulderVert, fragmentShader: boulderFrag, uniforms: { ...common }, fog: false })
    this.mesh = new THREE.InstancedMesh(geo, mat, cap)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1
    _m.makeScale(0, 0, 0)
    for (let i = 0; i < cap; i++) this.mesh.setMatrixAt(i, _m)
  }

  get count() {
    return this.live
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, size: number, heat: number, life: number) {
    const i = this.next
    this.next = (i + 1) % this.cap
    this.pos.set([p.x, p.y, p.z], i * 3)
    this.vel.set([v.x, v.y, v.z], i * 3)
    _q.setFromAxisAngle(_ax.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), Math.random() * 6.28)
    this.rot.set([_q.x, _q.y, _q.z, _q.w], i * 4)
    _ax.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
    this.spin.set([_ax.x, _ax.y, _ax.z, (Math.random() * 2 - 1) * (6 / Math.sqrt(size))], i * 4)
    this.size[i] = size
    this.life[i] = life
    this.heat[i] = heat
  }

  clear() {
    this.life.fill(0)
    this.heat.fill(0)
    _m.makeScale(0, 0, 0)
    for (let i = 0; i < this.cap; i++) {
      this.size[i] = 0
      this.mesh.setMatrixAt(i, _m)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.live = 0
  }

  update(dt: number, ground: GroundFn) {
    if (dt <= 0) return
    let live = 0
    let dirty = false
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) {
        if (this.size[i] > 0) {
          this.size[i] = 0
          this.heat[i] = 0
          _m.makeScale(0, 0, 0)
          this.mesh.setMatrixAt(i, _m)
          dirty = true
        }
        continue
      }
      live++
      dirty = true
      this.life[i] -= dt
      const k = i * 3
      const s = this.size[i]
      this.vel[k + 1] -= GRAVITY * dt
      const x = this.pos[k] + this.vel[k] * dt
      let y = this.pos[k + 1] + this.vel[k + 1] * dt
      const z = this.pos[k + 2] + this.vel[k + 2] * dt
      const h = ground(x, z)
      const r = i * 4
      if (y < h + s * 0.45) {
        // slope normal from the heightfield; bounce off it, then roll and slide downhill
        const e = Math.max(3, s * 0.5)
        _n.set(ground(x - e, z) - ground(x + e, z), 2 * e, ground(x, z - e) - ground(x, z + e)).normalize()
        const vn = this.vel[k] * _n.x + this.vel[k + 1] * _n.y + this.vel[k + 2] * _n.z
        if (vn < 0) {
          const rest = vn < -10 ? 0.28 : 0
          if (vn < -14 && s > 4) this.onLand?.(x, h, z, s)
          this.vel[k] -= (1 + rest) * vn * _n.x
          this.vel[k + 1] -= (1 + rest) * vn * _n.y
          this.vel[k + 2] -= (1 + rest) * vn * _n.z
        }
        const fr = Math.exp(-dt * 0.9)
        this.vel[k] *= fr
        this.vel[k + 2] *= fr
        y = h + s * 0.45
        // tumble at the rolling rate
        const sp = Math.hypot(this.vel[k], this.vel[k + 2])
        this.spin[r + 3] = (Math.sign(this.spin[r + 3]) || 1) * Math.min(3, sp / Math.max(1, s * 0.5))
      }
      // settle into the ground at the end
      const fade = Math.min(1, this.life[i] / 2)
      if (fade < 1) y -= (1 - fade) * s * 0.6
      this.pos[k] = x
      this.pos[k + 1] = y
      this.pos[k + 2] = z
      _ax.set(this.spin[r], this.spin[r + 1], this.spin[r + 2])
      _q.set(this.rot[r], this.rot[r + 1], this.rot[r + 2], this.rot[r + 3])
      _dq.setFromAxisAngle(_ax, this.spin[r + 3] * dt)
      _q.premultiply(_dq).normalize()
      this.rot.set([_q.x, _q.y, _q.z, _q.w], r)
      _s.setScalar(s)
      _m.compose(_p.set(x, y, z), _q, _s)
      this.mesh.setMatrixAt(i, _m)
      this.heat[i] = Math.max(0, this.heat[i] - dt * 0.12)
    }
    this.live = live
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true
      this.heatAttr.needsUpdate = true
    }
  }
}

export interface BillowOpts {
  /** Size multiplier gained over the life (grows with sqrt(age)). */
  grow?: number
  alpha?: number
  /** Emissive heat at birth and its loss per second. */
  heat?: number
  cool?: number
  /** 0 = pale dust, 1 = dark smoke. */
  dark?: number
  /** Velocity decay rate (1/s). */
  drag?: number
  /** Upward acceleration (m/s²), fading over the first seconds. */
  buoy?: number
  /** Hugs the ground and flows downhill (a pyroclastic surge) instead of floating. */
  flow?: boolean
  /** Postpone appearance (s). */
  delay?: number
}

/**
 * Rolling dust and smoke at mountain scale: big soft billboards that pour out
 * of a mouth, slide down the slopes and climb over the crest, backlit by the
 * eclipse. Sorted back to front; they meet the rock softly.
 */
export class Billows {
  readonly mesh: THREE.Mesh
  readonly cap: number
  private geo: THREE.InstancedBufferGeometry
  private pos: Float32Array
  private vel: Float32Array
  private size0: Float32Array
  private grow: Float32Array
  private age: Float32Array
  private life: Float32Array
  private alpha: Float32Array
  private heat: Float32Array
  private cool: Float32Array
  private dark: Float32Array
  private drag: Float32Array
  private buoy: Float32Array
  private flow: Uint8Array
  private rot: Float32Array
  private seed: Float32Array
  private iPos: THREE.InstancedBufferAttribute
  private iA: THREE.InstancedBufferAttribute
  private iB: THREE.InstancedBufferAttribute
  private order: number[] = []
  private dist: Float32Array
  private next = 0

  constructor(cap: number, uniforms: Record<string, THREE.IUniform>) {
    this.cap = cap
    this.pos = new Float32Array(cap * 3)
    this.vel = new Float32Array(cap * 3)
    this.size0 = new Float32Array(cap)
    this.grow = new Float32Array(cap)
    this.age = new Float32Array(cap)
    this.life = new Float32Array(cap)
    this.alpha = new Float32Array(cap)
    this.heat = new Float32Array(cap)
    this.cool = new Float32Array(cap)
    this.dark = new Float32Array(cap)
    this.drag = new Float32Array(cap)
    this.buoy = new Float32Array(cap)
    this.flow = new Uint8Array(cap)
    this.rot = new Float32Array(cap)
    this.seed = new Float32Array(cap)
    this.dist = new Float32Array(cap)
    const quad = new THREE.PlaneGeometry(1, 1)
    this.geo = new THREE.InstancedBufferGeometry()
    this.geo.index = quad.index
    this.geo.setAttribute('position', quad.attributes.position)
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3)
    this.iA = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4)
    this.iB = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2)
    for (const a of [this.iPos, this.iA, this.iB]) a.setUsage(THREE.DynamicDrawUsage)
    this.geo.setAttribute('iPos', this.iPos)
    this.geo.setAttribute('iA', this.iA)
    this.geo.setAttribute('iB', this.iB)
    this.geo.instanceCount = 0
    const mat = new THREE.ShaderMaterial({
      vertexShader: billowVert,
      fragmentShader: billowFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
      fog: false,
    })
    this.mesh = new THREE.Mesh(this.geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 6
  }

  get count() {
    return this.geo.instanceCount
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, size: number, life: number, o: BillowOpts = {}) {
    const i = this.next
    this.next = (i + 1) % this.cap
    this.pos.set([p.x, p.y, p.z], i * 3)
    this.vel.set([v.x, v.y, v.z], i * 3)
    this.size0[i] = size
    this.grow[i] = o.grow ?? 1.5
    this.age[i] = -(o.delay ?? 0)
    this.life[i] = life
    this.alpha[i] = o.alpha ?? 0.7
    this.heat[i] = o.heat ?? 0
    this.cool[i] = o.cool ?? 0.35
    this.dark[i] = o.dark ?? 0.3
    this.drag[i] = o.drag ?? 0.5
    this.buoy[i] = o.buoy ?? 0
    this.flow[i] = o.flow ? 1 : 0
    this.rot[i] = Math.random() * 6.28
    this.seed[i] = Math.random()
  }

  clear() {
    this.life.fill(0)
    this.geo.instanceCount = 0
  }

  update(dt: number, eye: THREE.Vector3, ground: GroundFn) {
    const order = this.order
    order.length = 0
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue
      if (dt > 0) {
        this.age[i] += dt
        if (this.age[i] >= this.life[i]) {
          this.life[i] = 0
          continue
        }
      }
      const age = this.age[i]
      if (age < 0) continue
      const k = i * 3
      if (dt > 0) {
        const dr = Math.exp(-this.drag[i] * dt)
        let vx = this.vel[k] * dr
        let vy = this.vel[k + 1] * dr
        let vz = this.vel[k + 2] * dr
        vy += this.buoy[i] * Math.exp(-age / 6) * dt
        const size = this.size0[i] * (1 + this.grow[i] * Math.sqrt(age))
        const x = this.pos[k]
        const z = this.pos[k + 2]
        const h = Math.max(0, ground(x, z))
        const above = this.pos[k + 1] - h
        if (this.flow[i]) {
          // a density current: it hugs the slope and pours downhill
          if (above < size * 0.9) {
            const e = 6
            const gx = (ground(x + e, z) - ground(x - e, z)) / (2 * e)
            const gz = (ground(x, z + e) - ground(x, z - e)) / (2 * e)
            vx -= Math.max(-3, Math.min(3, gx)) * 16 * dt
            vz -= Math.max(-3, Math.min(3, gz)) * 16 * dt
            vy -= 6 * dt
          } else vy -= 4 * dt
        }
        this.vel[k] = vx
        this.vel[k + 1] = vy
        this.vel[k + 2] = vz
        this.pos[k] += vx * dt
        this.pos[k + 1] += vy * dt
        this.pos[k + 2] += vz * dt
        const floor = Math.max(0, ground(this.pos[k], this.pos[k + 2])) + size * 0.3
        if (this.pos[k + 1] < floor) {
          this.pos[k + 1] = floor
          if (this.vel[k + 1] < 0) this.vel[k + 1] *= -0.1
        }
        this.heat[i] = Math.max(0, this.heat[i] - this.cool[i] * dt)
        this.rot[i] += dt * 0.05 * (this.seed[i] - 0.5)
      }
      const dx = this.pos[k] - eye.x
      const dy = this.pos[k + 1] - eye.y
      const dz = this.pos[k + 2] - eye.z
      this.dist[i] = dx * dx + dy * dy + dz * dz
      order.push(i)
    }
    // back to front
    order.sort((a, b) => this.dist[b] - this.dist[a])
    const P = this.iPos.array as Float32Array
    const A = this.iA.array as Float32Array
    const B = this.iB.array as Float32Array
    for (let n = 0; n < order.length; n++) {
      const i = order[n]
      const age = this.age[i]
      const u = age / this.life[i]
      const fade = Math.min(1, age / 0.35) * (u > 0.55 ? 1 - (u - 0.55) / 0.45 : 1)
      P[n * 3] = this.pos[i * 3]
      P[n * 3 + 1] = this.pos[i * 3 + 1]
      P[n * 3 + 2] = this.pos[i * 3 + 2]
      A[n * 4] = this.size0[i] * (1 + this.grow[i] * Math.sqrt(age))
      A[n * 4 + 1] = this.rot[i]
      A[n * 4 + 2] = this.alpha[i] * fade * fade
      A[n * 4 + 3] = this.heat[i]
      B[n * 2] = this.seed[i]
      B[n * 2 + 1] = this.dark[i]
    }
    this.geo.instanceCount = order.length
    if (order.length) {
      this.iPos.needsUpdate = true
      this.iA.needsUpdate = true
      this.iB.needsUpdate = true
    }
  }
}
