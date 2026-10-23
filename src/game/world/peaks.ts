import * as THREE from 'three'
import { audio } from '../../audio/audio'
import type { Game } from '../Game'
import { groundMaterial } from './ground'

/** Most peaks one Horizon Cut takes off as separate falling pieces. */
const MAX_CAPS = 28
/** Arcs of the range are split into pieces this wide (rad), so a long ridge comes apart as it falls. */
const SECTOR = (10 * Math.PI) / 180
/** Vertices per piece, at most (each layer). */
const MAX_VERTS = 5000
const GRAVITY = 30
// dust at a distance lit by the eclipse: darker than the arena's, or it glows white against the range
const DUST: readonly [number, number, number] = [0.17, 0.13, 0.115]
const UP = new THREE.Vector3(0, 1, 0)
const _p = new THREE.Vector3()
const _v = new THREE.Vector3()
const _m = new THREE.Matrix4()

interface Cap {
  pivot: THREE.Group
  mesh: THREE.Mesh
  u: { uCapY: THREE.IUniform<number>; uCapT0: THREE.IUniform<number>; uCapRot: THREE.IUniform<THREE.Matrix3> }
  /** Centroid of the footprint, on the slice plane. */
  c: THREE.Vector3
  /** Footprint radius and the tallest point above the plane. */
  r: number
  h: number
  dir: THREE.Vector3
  axis: THREE.Vector3
  /** Seconds until it starts to move (Infinity until the sheathe releases it). */
  wait: number
  t: number
  off: THREE.Vector3
  vel: THREE.Vector3
  angle: number
  spin: number
  /** 0 resting, 1 sliding, 2 toppling, 3 crashed and sinking */
  phase: number
  puffT: number
}

/**
 * The peaks the Horizon Cut takes off. Each piece is the old mountain surface
 * above the slice plane closed by a flat molten underside, drawn with the
 * ground's own material (so it is the same rock), sliding off its stump,
 * toppling down the range and crashing in a cloud of dust while the stump it
 * leaves glows flat and cools.
 */
export class Peaks {
  readonly root = new THREE.Group()
  private caps: Cap[] = []
  private g: Game

  constructor(game: Game) {
    this.g = game
  }

  /** How many pieces are still in the world (for tests and the HUD). */
  get count() {
    return this.caps.length
  }

  /**
   * Cut everything within `r` of (x, z) above `y` off the mountains. The
   * pieces stay put until `release`. Returns how many came off.
   */
  slice(x: number, z: number, r: number, y: number) {
    const g = this.g
    const far = g.far
    const n = far.res
    const cell = far.cell
    const half = far.half
    const H = far.heights
    // cells standing above the plane (the fine relief can poke up to ~30 m above the coarse heights)
    const i0 = Math.max(0, Math.floor((x - r + half) / cell))
    const i1 = Math.min(n - 1, Math.ceil((x + r + half) / cell))
    const j0 = Math.max(0, Math.floor((z - r + half) / cell))
    const j1 = Math.min(n - 1, Math.ceil((z + r + half) / cell))
    const label = new Int32Array(n * n).fill(-1)
    const above = (i: number, j: number) => {
      const k = j * n + i
      if (H[k] <= y - 30) return false
      const cx = -half + (i + 0.5) * cell - x
      const cz = -half + (j + 0.5) * cell - z
      return cx * cx + cz * cz < r * r
    }
    // pieces: connected regions, split into sectors around the hero
    const groups = new Map<number, { id: number; cells: number[]; sx: number; sz: number; top: number; bi0: number; bi1: number; bj0: number; bj1: number }>()
    const queue = new Int32Array(n * n)
    let comp = 0
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k0 = j * n + i
        if (label[k0] !== -1 || !above(i, j)) continue
        // flood fill one connected region
        let qh = 0
        let qt = 0
        queue[qt++] = k0
        label[k0] = -2
        while (qh < qt) {
          const k = queue[qh++]
          const ci = k % n
          const cj = (k - ci) / n
          const wx = -half + (ci + 0.5) * cell
          const wz = -half + (cj + 0.5) * cell
          const sector = Math.floor((Math.atan2(wx - x, wz - z) + Math.PI) / SECTOR)
          const key = comp * 64 + sector
          let gr = groups.get(key)
          if (!gr) {
            gr = { id: groups.size, cells: [], sx: 0, sz: 0, top: -1e9, bi0: ci, bi1: ci, bj0: cj, bj1: cj }
            groups.set(key, gr)
          }
          gr.cells.push(k)
          gr.sx += wx
          gr.sz += wz
          gr.top = Math.max(gr.top, H[k])
          gr.bi0 = Math.min(gr.bi0, ci)
          gr.bi1 = Math.max(gr.bi1, ci)
          gr.bj0 = Math.min(gr.bj0, cj)
          gr.bj1 = Math.max(gr.bj1, cj)
          label[k] = gr.id
          for (const [di, dj] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const ni = ci + di
            const nj = cj + dj
            if (ni < i0 || ni > i1 || nj < j0 || nj > j1) continue
            const nk = nj * n + ni
            if (label[nk] !== -1 || !above(ni, nj)) continue
            label[nk] = -2
            queue[qt++] = nk
          }
        }
        comp++
      }
    }
    far.slice(x, z, r, y, g.fx.time)
    // the pieces in view matter most: anything behind the camera can simply be gone when it turns round
    g.camera.getWorldDirection(_v).setY(0).normalize()
    const score = (q: { cells: number[]; sx: number; sz: number }) => {
      const dx = q.sx / q.cells.length - x
      const dz = q.sz / q.cells.length - z
      const l = Math.hypot(dx, dz) || 1
      const facing = (dx * _v.x + dz * _v.z) / l
      return q.cells.length * (facing > 0.45 ? 6 : facing > 0 ? 2 : 1)
    }
    const list = [...groups.values()].filter((q) => q.top > y + 4 && q.cells.length >= 2).sort((a, b) => score(b) - score(a)).slice(0, MAX_CAPS)
    for (const q of list) this.build(q, label, x, z, y)
    return list.length
  }

  private build(q: { id: number; cells: number[]; sx: number; sz: number; top: number; bi0: number; bi1: number; bj0: number; bj1: number }, label: Int32Array, hx: number, hz: number, y: number) {
    const g = this.g
    const far = g.far
    const n = far.res
    const cell = far.cell
    const half = far.half
    const x0 = -half + (q.bi0 - 1) * cell
    const z0 = -half + (q.bj0 - 1) * cell
    const x1 = -half + (q.bi1 + 2) * cell
    const z1 = -half + (q.bj1 + 2) * cell
    const step = Math.max(g.quality === 'low' ? 16 : 10, Math.sqrt(((x1 - x0) * (z1 - z0)) / MAX_VERTS))
    const nx = Math.max(2, Math.ceil((x1 - x0) / step))
    const nz = Math.max(2, Math.ceil((z1 - z0) / step))
    const vx = nx + 1
    const vz = nz + 1
    const per = vx * vz
    const pos = new Float32Array(per * 2 * 3)
    const layer = new Float32Array(per * 2)
    const inside = new Float32Array(per * 2)
    for (let j = 0; j < vz; j++) {
      for (let i = 0; i < vx; i++) {
        const wx = x0 + ((x1 - x0) * i) / nx
        const wz = z0 + ((z1 - z0) * j) / nz
        const ci = Math.min(n - 1, Math.max(0, Math.floor((wx + half) / cell)))
        const cj = Math.min(n - 1, Math.max(0, Math.floor((wz + half) / cell)))
        const mine = label[cj * n + ci] === q.id ? 1 : 0
        for (let l = 0; l < 2; l++) {
          const k = l * per + j * vx + i
          pos[k * 3] = wx
          pos[k * 3 + 1] = y
          pos[k * 3 + 2] = wz
          layer[k] = l
          inside[k] = mine
        }
      }
    }
    const idx: number[] = []
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * vx + i
        const b = a + 1
        const c = a + vx
        const d = c + 1
        if (!(inside[a] || inside[b] || inside[c] || inside[d])) continue
        idx.push(a, c, b, b, c, d)
        idx.push(per + a, per + b, per + c, per + b, per + d, per + c)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(per * 2 * 3), 3))
    geo.setAttribute('aLayer', new THREE.BufferAttribute(layer, 1))
    geo.setAttribute('aIn', new THREE.BufferAttribute(inside, 1))
    geo.setIndex(idx)
    const shared = (g.ground.userData.uniforms ?? {}) as Record<string, THREE.IUniform>
    const u = { uCapY: { value: y }, uCapT0: { value: g.fx.time }, uCapRot: { value: new THREE.Matrix3() } }
    const mat = groundMaterial(g.scorch, g.terrain, far, g.quality, 'cap', { ...shared, ...u })
    mat.side = THREE.DoubleSide
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    const c = new THREE.Vector3(q.sx / q.cells.length, y, q.sz / q.cells.length)
    mesh.position.copy(c).negate()
    const pivot = new THREE.Group()
    pivot.position.copy(c)
    pivot.add(mesh)
    this.root.add(pivot)
    const r = Math.sqrt((q.cells.length * cell * cell) / Math.PI)
    // pushed out away from the hero by the stroke, and a little along it
    const dir = new THREE.Vector3(c.x - hx, 0, c.z - hz).normalize()
    dir.applyAxisAngle(UP, (Math.random() - 0.5) * 0.5)
    this.caps.push({
      pivot,
      mesh,
      u,
      c,
      r,
      h: q.top - y,
      dir,
      axis: new THREE.Vector3().crossVectors(UP, dir).normalize(),
      wait: Infinity,
      t: 0,
      off: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      angle: 0,
      spin: 0,
      phase: 0,
      puffT: 0,
    })
  }

  /** The sheathe: every resting piece starts to move, the nearer ones first. */
  release(hx: number, hz: number) {
    for (const c of this.caps) {
      if (c.phase !== 0 || c.wait !== Infinity) continue
      c.wait = Math.hypot(c.c.x - hx, c.c.z - hz) / 6000 + Math.random() * 0.25
      // the cut lets go of the rock: a sigh of dust all round the footprint
      const fx = this.g.fx
      const np = Math.round(8 * this.g.q) + 4
      for (let i = 0; i < np; i++) {
        const a = (i / np) * Math.PI * 2
        _p.set(c.c.x + Math.sin(a) * c.r, c.c.y + 2, c.c.z + Math.cos(a) * c.r)
        _v.set(Math.sin(a) * 18, -3 + Math.random() * 6, Math.cos(a) * 18)
        fx.smoke.spawn(_p, _v, DUST, 0.45, 30 + c.r * 0.12 + Math.random() * 30, 7 + Math.random() * 4, -0.2, 0.25, { grow: 1.8 })
      }
    }
  }

  update(dt: number) {
    const g = this.g
    for (let i = this.caps.length - 1; i >= 0; i--) {
      const c = this.caps[i]
      if (c.wait > 0) {
        c.wait -= dt
        if (c.wait > 0) continue
        c.phase = 1
        c.vel.copy(c.dir).multiplyScalar(30 + c.r * 0.12 + Math.random() * 20)
      }
      c.t += dt
      if (c.phase === 1) {
        // sliding off the stump on the polished cut
        c.off.addScaledVector(c.vel, dt)
        if (c.off.length() > c.r * 0.3) {
          c.phase = 2
          c.spin = 0.12
        }
      } else if (c.phase === 2) {
        // over the edge: it tips forward and falls, faster and faster
        c.spin += (0.3 + Math.sin(c.angle) * 1.1) * dt
        c.angle += c.spin * dt
        c.vel.y -= GRAVITY * dt
        c.off.addScaledVector(c.vel, dt)
        const gx = c.c.x + c.off.x
        const gz = c.c.z + c.off.z
        if (c.c.y + c.off.y < g.far.heightAt(gx, gz) + c.h * 0.25 && c.vel.y < 0) this.crash(c)
      } else if (c.phase === 3) {
        // ground into the range under its own weight, buried in its dust
        c.vel.multiplyScalar(Math.exp(-dt * 0.8))
        c.vel.y = -10 - c.t * 0.5
        c.spin *= Math.exp(-dt * 1.5)
        c.angle += c.spin * dt
        c.off.addScaledVector(c.vel, dt)
        if (c.c.y + c.off.y + c.h < g.far.heightAt(c.c.x + c.off.x, c.c.z + c.off.z) - 40 || c.t > 30) {
          this.remove(i)
          continue
        }
      }
      c.pivot.position.copy(c.c).add(c.off)
      c.pivot.quaternion.setFromAxisAngle(c.axis, c.angle)
      c.u.uCapRot.value.setFromMatrix4(_m.makeRotationFromQuaternion(c.pivot.quaternion))
      // a trail of dust off the leading edge as it goes over
      c.puffT -= dt
      if (c.phase === 2 && c.puffT <= 0) {
        c.puffT = 0.45
        _p.copy(c.c).add(c.off).addScaledVector(c.dir, c.r * 0.6)
        _v.copy(c.dir).multiplyScalar(-6).setY(-4)
        g.fx.smoke.spawn(_p, _v, DUST, 0.4, 25 + c.r * 0.1, 6, 0.3, 0.3, { grow: 1.6 })
      }
    }
  }

  private crash(c: Cap) {
    const g = this.g
    c.phase = 3
    c.t = 0
    const at = _p.copy(c.c).add(c.off)
    at.y = g.far.heightAt(at.x, at.z)
    const size = Math.min(1, c.r / 300)
    const n = Math.round((10 + 14 * size) * g.q)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      _v.set(Math.sin(a) * (20 + Math.random() * 40), 15 + Math.random() * 45, Math.cos(a) * (20 + Math.random() * 40))
      const q = at.clone().add(new THREE.Vector3(Math.sin(a) * c.r * 0.4, Math.random() * 30, Math.cos(a) * c.r * 0.4))
      g.fx.smoke.spawn(q, _v, DUST, 0.55, 80 + c.r * 0.3 + Math.random() * 80, 10 + Math.random() * 6, -0.3, 0.2, { grow: 1.4 })
    }
    g.fx.debris.burst(at.clone().setY(at.y + 10), Math.round(14 * size) + 6, 40, 4 + 8 * size, 0.2, 1.4)
    const d = at.distanceTo(g.player.pos)
    const delay = d / 1100
    const big = size * Math.max(0.2, 1 - d / 5000)
    g.fx.after(delay, () => {
      audio.rumble(0.6 + big * 0.6, 4)
      if (big > 0.3) audio.nukeShock()
      g.cam.addTrauma(0.15 + big * 0.5)
      g.rumble(0.3 + big * 0.6, 0.3, 500 + big * 800)
    })
  }

  private remove(i: number) {
    const c = this.caps[i]
    this.root.remove(c.pivot)
    c.mesh.geometry.dispose()
    ;(c.mesh.material as THREE.Material).dispose()
    this.caps.splice(i, 1)
  }

  reset() {
    while (this.caps.length) this.remove(this.caps.length - 1)
  }
}
