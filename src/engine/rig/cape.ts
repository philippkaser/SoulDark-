import * as THREE from 'three'

export interface Capsule {
  a: THREE.Object3D
  b: THREE.Object3D
  r: number
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _p = new THREE.Vector3()
const _ab = new THREE.Vector3()

/**
 * Verlet cloth pinned to the character's upper back. Simulated in world space
 * with capsule collisions against the torso and legs.
 */
export class Cape {
  readonly mesh: THREE.Mesh
  private cols: number
  private rows: number
  private pos: Float32Array
  private prev: Float32Array
  private restX: number
  private restY: number
  private anchor: THREE.Object3D
  private anchors: THREE.Vector3[]
  private colliders: Capsule[]
  private initialized = false
  private scale = 1
  private geo: THREE.BufferGeometry
  private time = Math.random() * 10

  constructor(opts: {
    width: number
    length: number
    cols: number
    rows: number
    material: THREE.Material
    anchor: THREE.Object3D
    left: THREE.Vector3
    right: THREE.Vector3
    colliders: Capsule[]
  }) {
    this.cols = opts.cols
    this.rows = opts.rows
    this.restX = opts.width / (opts.cols - 1)
    this.restY = opts.length / (opts.rows - 1)
    this.anchor = opts.anchor
    this.colliders = opts.colliders
    this.anchors = []
    for (let c = 0; c < this.cols; c++) {
      this.anchors.push(new THREE.Vector3().lerpVectors(opts.left, opts.right, c / (this.cols - 1)))
    }
    this.geo = new THREE.PlaneGeometry(opts.width, opts.length, opts.cols - 1, opts.rows - 1)
    const n = this.cols * this.rows
    this.pos = new Float32Array(n * 3)
    this.prev = new Float32Array(n * 3)
    this.mesh = new THREE.Mesh(this.geo, opts.material)
    this.mesh.frustumCulled = false
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
  }

  reset() {
    this.anchor.updateWorldMatrix(true, false)
    this.scale = this.anchor.getWorldScale(_p).x
    for (let c = 0; c < this.cols; c++) {
      _a.copy(this.anchors[c]).applyMatrix4(this.anchor.matrixWorld)
      // hang down and slightly back
      this.anchor.getWorldDirection(_b)
      for (let r = 0; r < this.rows; r++) {
        const i = (r * this.cols + c) * 3
        this.pos[i] = _a.x - _b.x * r * this.restY * 0.15 * this.scale
        this.pos[i + 1] = _a.y - r * this.restY * this.scale
        this.pos[i + 2] = _a.z - _b.z * r * this.restY * 0.15 * this.scale
        this.prev[i] = this.pos[i]
        this.prev[i + 1] = this.pos[i + 1]
        this.prev[i + 2] = this.pos[i + 2]
      }
    }
    this.initialized = true
  }

  /** `floor`: ground height under the cloth (it rests on it). */
  update(dt: number, windX: number, windZ: number, floor = 0) {
    if (dt <= 0) return
    this.anchor.updateWorldMatrix(true, false)
    if (!this.initialized) this.reset()
    _a.copy(this.anchors[0]).applyMatrix4(this.anchor.matrixWorld)
    // teleported (respawn): start over
    if (Math.abs(_a.x - this.pos[0]) + Math.abs(_a.z - this.pos[2]) > 3 * this.scale) this.reset()
    this.time += dt
    const steps = dt > 1 / 45 ? 2 : 1
    const h = Math.min(dt, 1 / 30) / steps
    for (let s = 0; s < steps; s++) this.step(h, windX, windZ, floor)
    const attr = this.geo.attributes.position as THREE.BufferAttribute
    ;(attr.array as Float32Array).set(this.pos)
    attr.needsUpdate = true
    this.geo.computeVertexNormals()
    this.geo.computeBoundingSphere()
  }

  private step(h: number, windX: number, windZ: number, floor: number) {
    const { cols, rows, pos, prev } = this
    const sc = this.scale
    const damping = 0.985
    const g = -9.8 * h * h
    const gust = 0.6 + 0.4 * Math.sin(this.time * 1.7) * Math.sin(this.time * 0.6)
    for (let r = 1; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3
        const flutter = Math.sin(this.time * 7 + r * 0.9 + c * 1.3) * 0.25
        const vx = (pos[i] - prev[i]) * damping
        const vy = (pos[i + 1] - prev[i + 1]) * damping
        const vz = (pos[i + 2] - prev[i + 2]) * damping
        prev[i] = pos[i]
        prev[i + 1] = pos[i + 1]
        prev[i + 2] = pos[i + 2]
        pos[i] += vx + windX * gust * (1 + flutter) * h * h * (r / rows)
        pos[i + 1] += vy + g
        pos[i + 2] += vz + windZ * gust * (1 + flutter) * h * h * (r / rows)
      }
    }
    // pin the top row to the shoulders
    for (let c = 0; c < cols; c++) {
      _a.copy(this.anchors[c]).applyMatrix4(this.anchor.matrixWorld)
      const i = c * 3
      prev[i] = pos[i] = _a.x
      prev[i + 1] = pos[i + 1] = _a.y
      prev[i + 2] = pos[i + 2] = _a.z
    }
    const rx = this.restX * sc
    const ry = this.restY * sc
    for (let iter = 0; iter < 4; iter++) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c
          if (c < cols - 1) this.constrain(i, i + 1, rx, r === 0)
          if (r < rows - 1) this.constrain(i, i + cols, ry, r === 0)
          if (r < rows - 2) this.constrain(i, i + cols * 2, ry * 2, r === 0, 0.3)
        }
      }
      this.collide(floor)
    }
  }

  private constrain(a: number, b: number, rest: number, pinnedA: boolean, stiff = 1) {
    const p = this.pos
    const ia = a * 3
    const ib = b * 3
    const dx = p[ib] - p[ia]
    const dy = p[ib + 1] - p[ia + 1]
    const dz = p[ib + 2] - p[ia + 2]
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6
    if (stiff < 1 && d < rest) return
    const diff = ((d - rest) / d) * stiff
    if (pinnedA) {
      p[ib] -= dx * diff
      p[ib + 1] -= dy * diff
      p[ib + 2] -= dz * diff
    } else {
      p[ia] += dx * diff * 0.5
      p[ia + 1] += dy * diff * 0.5
      p[ia + 2] += dz * diff * 0.5
      p[ib] -= dx * diff * 0.5
      p[ib + 1] -= dy * diff * 0.5
      p[ib + 2] -= dz * diff * 0.5
    }
  }

  private collide(floor: number) {
    const p = this.pos
    const n = this.cols * this.rows
    for (const cap of this.colliders) {
      cap.a.getWorldPosition(_a)
      cap.b.getWorldPosition(_b)
      _ab.subVectors(_b, _a)
      const len2 = _ab.lengthSq() || 1e-6
      const r = cap.r * this.scale
      for (let i = this.cols; i < n; i++) {
        const k = i * 3
        _p.set(p[k], p[k + 1], p[k + 2])
        let t = _p.clone().sub(_a).dot(_ab) / len2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const cx = _a.x + _ab.x * t
        const cy = _a.y + _ab.y * t
        const cz = _a.z + _ab.z * t
        const dx = _p.x - cx
        const dy = _p.y - cy
        const dz = _p.z - cz
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 < r * r) {
          const d = Math.sqrt(d2) || 1e-6
          const k2 = r / d
          p[k] = cx + dx * k2
          p[k + 1] = cy + dy * k2
          p[k + 2] = cz + dz * k2
        }
      }
    }
    for (let i = this.cols; i < n; i++) {
      const k = i * 3 + 1
      if (p[k] < floor + 0.03) p[k] = floor + 0.03
    }
  }
}
