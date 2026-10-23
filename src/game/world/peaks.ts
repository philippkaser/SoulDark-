import * as THREE from 'three'
import { angleDiff } from '../../engine/math'
import { audio } from '../../audio/audio'
import type { Game } from '../Game'
import { groundMaterial } from './ground'

/** Most peaks one Horizon Cut takes off; anything smaller is left standing. */
const MAX_PIECES = 14
/** Vertices per piece, at most (each layer). */
const MAX_VERTS = 6000
/** A peak needs to stand this far above the cut to come off as a piece of its own; smaller ones join a neighbour. */
const MIN_RISE = 40
const MIN_CELLS = 12
// dust at a distance lit by the eclipse: darker than the arena's, or it glows white against the range
const DUST: readonly [number, number, number] = [0.17, 0.13, 0.115]
const UP = new THREE.Vector3(0, 1, 0)
const _p = new THREE.Vector3()
const _v = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _t = new THREE.Matrix4()

const enum Ph {
  Rest,
  Shudder,
  Slide,
  Settle,
  Crumble,
}

interface Piece {
  mesh: THREE.Mesh
  u: { uCapY: THREE.IUniform<number>; uCapT0: THREE.IUniform<number>; uCapRot: THREE.IUniform<THREE.Matrix3> }
  /** Footprint centroid on the cut plane, footprint radius, and the tallest point above the plane. */
  c0: THREE.Vector3
  r: number
  h: number
  /** Centre of mass at rest, and where it is now with the piece's turn. */
  cb: THREE.Vector3
  P: THREE.Vector3
  Q: THREE.Quaternion
  /** Every piece of one cut slides the same way, along the stroke, by about the same distance. */
  d: THREE.Vector3
  dist: number
  axis: THREE.Vector3
  phase: Ph
  wait: number
  t: number
  /** How long its collapse takes, and how deep it sinks into its stump. */
  crumble: number
  sink: number
  puffT: number
}

/**
 * The peaks the Horizon Cut takes off. Each piece is one peak's ground above
 * the cut, split from its neighbours along the valleys between them, drawn
 * with the ground's own material (so it is the same rock) and closed by a flat
 * molten underside. On the click it shudders, grinds sideways along the cut
 * with the stroke, tips over the edge of its stump, falls down the range and
 * breaks up in its own dust; the stump stays flat and glowing.
 */
export class Peaks {
  readonly root = new THREE.Group()
  private pieces: Piece[] = []
  private g: Game

  constructor(game: Game) {
    this.g = game
  }

  /** How many pieces are still in the world. */
  get count() {
    return this.pieces.length
  }

  /**
   * Cut the peaks within `r` of (x, z), inside the arc `heading` +/- `half`
   * (rad, atan2(x, z)), off at height `y`. The pieces rest until `release`.
   * Returns how many came off.
   */
  slice(x: number, z: number, r: number, y: number, heading: number, half: number) {
    const g = this.g
    const far = g.far
    const n = far.res
    const cell = far.cell
    const hf = far.half
    const H = far.heights
    const i0 = Math.max(1, Math.floor((x - r + hf) / cell))
    const i1 = Math.min(n - 2, Math.ceil((x + r + hf) / cell))
    const j0 = Math.max(1, Math.floor((z - r + hf) / cell))
    const j1 = Math.min(n - 2, Math.ceil((z + r + hf) / cell))
    const cx = (i: number) => -hf + (i + 0.5) * cell
    // ground near or above the cut (the fine relief rides up to ~30 m over the coarse heights)
    const cand = new Uint8Array(n * n)
    const S = new Float32Array(n * n)
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * n + i
        const dx = cx(i) - x
        const dz = cx(j) - z
        if (H[k] <= y - 30 || dx * dx + dz * dz > r * r) continue
        cand[k] = 1
        // smoothed, so the noise in the ridges doesn't make every bump a peak
        let s = 0
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) s += H[k + b * n + a]
        S[k] = s / 9
      }
    }
    // every cell climbs to its peak: the basins meet along the valleys, where the pieces are thinnest
    const label = new Int32Array(n * n).fill(-1)
    const peakOf: number[] = []
    const path: number[] = []
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        let k = j * n + i
        if (!cand[k] || label[k] >= 0) continue
        path.length = 0
        let id = -1
        for (;;) {
          if (label[k] >= 0) {
            id = label[k]
            break
          }
          path.push(k)
          let best = k
          for (let b = -1; b <= 1; b++) {
            for (let a = -1; a <= 1; a++) {
              const q = k + b * n + a
              if (cand[q] && S[q] > S[best]) best = q
            }
          }
          if (best === k) {
            id = peakOf.length
            peakOf.push(k)
            break
          }
          k = best
        }
        for (const q of path) label[q] = id
      }
    }
    // union small or low basins into the neighbour they share most ground with
    const parent = peakOf.map((_, i) => i)
    const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])))
    for (let pass = 0; pass < 3; pass++) {
      const count = new Array(peakOf.length).fill(0)
      const top = new Array(peakOf.length).fill(-1e9)
      const touch = new Map<number, number>()
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * n + i
          if (!cand[k]) continue
          const a = find(label[k])
          count[a]++
          top[a] = Math.max(top[a], H[k])
          for (const q of [k + 1, k + n]) {
            if (!cand[q]) continue
            const b = find(label[q])
            if (a === b) continue
            const key = Math.min(a, b) * 100000 + Math.max(a, b)
            touch.set(key, (touch.get(key) ?? 0) + 1)
          }
        }
      }
      let merged = 0
      for (let a = 0; a < peakOf.length; a++) {
        if (find(a) !== a || (count[a] >= MIN_CELLS && top[a] - y >= MIN_RISE)) continue
        let best = -1
        let most = 0
        for (const [key, c] of touch) {
          const lo = Math.floor(key / 100000)
          const hi = key % 100000
          const o = lo === a ? hi : hi === a ? lo : -1
          if (o < 0 || find(o) === a) continue
          if (c > most) {
            most = c
            best = find(o)
          }
        }
        if (best >= 0) {
          parent[a] = best
          merged++
        }
      }
      if (!merged) break
    }
    // the pieces: big enough, standing above the cut, peak inside the arc swept
    const groups = new Map<number, { cells: number[]; sx: number; sz: number; top: number; px: number; pz: number; bi0: number; bi1: number; bj0: number; bj1: number }>()
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * n + i
        if (!cand[k]) continue
        const a = find(label[k])
        label[k] = a
        let gr = groups.get(a)
        if (!gr) groups.set(a, (gr = { cells: [], sx: 0, sz: 0, top: -1e9, px: 0, pz: 0, bi0: i, bi1: i, bj0: j, bj1: j }))
        gr.cells.push(k)
        gr.sx += cx(i)
        gr.sz += cx(j)
        if (H[k] > gr.top) {
          gr.top = H[k]
          gr.px = cx(i)
          gr.pz = cx(j)
        }
        gr.bi0 = Math.min(gr.bi0, i)
        gr.bi1 = Math.max(gr.bi1, i)
        gr.bj0 = Math.min(gr.bj0, j)
        gr.bj1 = Math.max(gr.bj1, j)
      }
    }
    // everything standing above the cut inside the arc comes off; past the piece budget, the smallest go with a neighbour
    const inArc = [...groups.entries()]
      .filter(([, q]) => q.top > y + 4 && Math.abs(angleDiff(Math.atan2(q.px - x, q.pz - z), heading)) < half)
      .sort((a, b) => b[1].cells.length - a[1].cells.length)
    const kept = new Map(inArc.slice(0, MAX_PIECES))
    for (const [id, q] of inArc.slice(MAX_PIECES)) {
      // the kept piece this one borders most
      const votes = new Map<number, number>()
      for (const k of q.cells) {
        for (const o of [k + 1, k - 1, k + n, k - n]) {
          const l = label[o]
          if (l !== id && kept.has(l)) votes.set(l, (votes.get(l) ?? 0) + 1)
        }
      }
      let best = -1
      let most = 0
      for (const [l, c] of votes) if (c > most) (most = c), (best = l)
      if (best < 0) {
        // an island on its own: it is cut all the same, and crumbles where it stands
        far.cutCeiling(q.cells, y)
        continue
      }
      const into = kept.get(best)!
      for (const k of q.cells) label[k] = best
      into.cells.push(...q.cells)
      into.sx += q.sx
      into.sz += q.sz
      into.bi0 = Math.min(into.bi0, q.bi0)
      into.bi1 = Math.max(into.bi1, q.bi1)
      into.bj0 = Math.min(into.bj0, q.bj0)
      into.bj1 = Math.max(into.bj1, q.bj1)
    }
    const all: number[] = []
    for (const [id, q] of kept) {
      all.push(...q.cells)
      this.build(id, q, label, heading, y)
    }
    far.cutCeiling(all, y)
    this.ramp(all, y)
    far.slice(x, z, r, y, g.fx.time, heading, half)
    return kept.size
  }

  /**
   * Where the cut meets ground it left standing, a sheer wall would show the
   * grid's stair steps: shave the rim back into a steep slope instead.
   */
  private ramp(cells: number[], y: number) {
    const far = this.g.far
    const n = far.res
    const C = far.ceil
    const seen = new Uint8Array(n * n)
    for (const k of cells) seen[k] = 1
    let front = cells
    for (let step = 1; step <= 6; step++) {
      const next: number[] = []
      for (const k of front) {
        for (const o of [k + 1, k - 1, k + n, k - n]) {
          if (o < 0 || o >= n * n || seen[o]) continue
          seen[o] = 1
          next.push(o)
          const top = y + step * far.cell * 2.2
          if (top < C[o]) C[o] = top
        }
      }
      front = next
    }
    far.ceilChanged()
  }

  private build(id: number, q: { cells: number[]; sx: number; sz: number; top: number; bi0: number; bi1: number; bj0: number; bj1: number }, label: Int32Array, heading: number, y: number) {
    const g = this.g
    const far = g.far
    const n = far.res
    const cell = far.cell
    const hf = far.half
    const x0 = -hf + (q.bi0 - 1) * cell
    const z0 = -hf + (q.bj0 - 1) * cell
    const x1 = -hf + (q.bi1 + 2) * cell
    const z1 = -hf + (q.bj1 + 2) * cell
    const step = Math.max(g.quality === 'low' ? 14 : 8, Math.sqrt(((x1 - x0) * (z1 - z0)) / MAX_VERTS))
    const nx = Math.max(2, Math.ceil((x1 - x0) / step))
    const nz = Math.max(2, Math.ceil((z1 - z0) / step))
    const vx = nx + 1
    const vz = nz + 1
    const per = vx * vz
    const pos = new Float32Array(per * 2 * 3)
    const layer = new Float32Array(per * 2)
    const inside = new Float32Array(per * 2)
    const mine = (i: number, j: number) => (i >= 0 && j >= 0 && i < n && j < n && label[j * n + i] === id ? 1 : 0)
    for (let j = 0; j < vz; j++) {
      for (let i = 0; i < vx; i++) {
        const wx = x0 + ((x1 - x0) * i) / nx
        const wz = z0 + ((z1 - z0) * j) / nz
        // how much of this vertex belongs to the piece, filtered like the GPU filters the ceiling
        const u = (wx + hf) / cell - 0.5
        const v = (wz + hf) / cell - 0.5
        const ci = Math.floor(u)
        const cj = Math.floor(v)
        const fu = u - ci
        const fv = v - cj
        const m = mine(ci, cj) * (1 - fu) * (1 - fv) + mine(ci + 1, cj) * fu * (1 - fv) + mine(ci, cj + 1) * (1 - fu) * fv + mine(ci + 1, cj + 1) * fu * fv
        for (let l = 0; l < 2; l++) {
          const k = l * per + j * vx + i
          pos[k * 3] = wx
          pos[k * 3 + 1] = y
          pos[k * 3 + 2] = wz
          layer[k] = l
          inside[k] = m
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
        if (Math.max(inside[a], inside[b], inside[c], inside[d]) < 0.5) continue
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
    mesh.matrixAutoUpdate = false
    this.root.add(mesh)
    const c0 = new THREE.Vector3(q.sx / q.cells.length, y, q.sz / q.cells.length)
    const r = Math.sqrt((q.cells.length * cell * cell) / Math.PI)
    const h = q.top - y
    // the stroke runs from the hero's left to his right: every piece grinds that way along the cut
    const d = new THREE.Vector3(-Math.cos(heading), 0, Math.sin(heading))
    const cb = c0.clone().addScaledVector(UP, h * 0.3)
    this.pieces.push({
      mesh,
      u,
      c0,
      r,
      h,
      cb,
      P: cb.clone(),
      Q: new THREE.Quaternion(),
      d,
      dist: 36 + Math.min(60, r * 0.08) * (0.9 + Math.random() * 0.2),
      axis: new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(),
      phase: Ph.Rest,
      wait: Infinity,
      t: 0,
      crumble: 3.2 + Math.min(3, h / 180) + Math.random() * 0.6,
      sink: h + 40,
      puffT: 0,
    })
    this.place(this.pieces[this.pieces.length - 1])
  }

  /** The sheathe: every resting piece lets go, the nearer ones first. */
  release(hx: number, hz: number) {
    for (const p of this.pieces) {
      if (p.phase !== Ph.Rest) continue
      p.wait = Math.hypot(p.c0.x - hx, p.c0.z - hz) / 6000 + Math.random() * 0.25
    }
  }

  update(dt: number) {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i]
      if (p.phase === Ph.Rest) {
        p.wait -= dt
        if (p.wait > 0) continue
        p.phase = Ph.Shudder
        p.t = 0
        this.exhale(p)
      }
      p.t += dt
      const k = Math.min(1, p.r / 300)
      switch (p.phase) {
        case Ph.Shudder:
          // the whole peak trembles as the cut lets go of it
          p.P.copy(p.cb).add(_v.set((Math.random() - 0.5) * 1.6 * k, (Math.random() - 0.5) * 0.5 * k, (Math.random() - 0.5) * 1.6 * k))
          if (p.t > 0.4) {
            p.phase = Ph.Slide
            p.t = 0
          }
          break
        case Ph.Slide: {
          // it grinds along the polished cut and drags to a stop, the seam glowing open behind it
          const u = Math.min(1, p.t / 1.5)
          p.P.copy(p.cb).addScaledVector(p.d, p.dist * (1 - Math.pow(1 - u, 3)))
          this.grind(p, dt)
          if (u >= 1) {
            p.phase = Ph.Settle
            p.t = 0
          }
          break
        }
        case Ph.Settle:
          if (p.t > 0.5 + Math.random() * 0.3) {
            p.phase = Ph.Crumble
            p.t = 0
            this.collapse(p)
          }
          break
        case Ph.Crumble: {
          // its own weight brings it down into the stump, breaking up as it goes
          const u = Math.min(1, p.t / p.crumble)
          const e = u * u * (3 - 2 * u)
          p.P.copy(p.cb).addScaledVector(p.d, p.dist).addScaledVector(UP, -p.sink * e)
          p.Q.setFromAxisAngle(p.axis, Math.sin(p.t * 1.7) * 0.02 * e)
          p.P.x += (Math.random() - 0.5) * 0.8 * k * (1 - u)
          p.P.z += (Math.random() - 0.5) * 0.8 * k * (1 - u)
          this.avalanche(p, dt)
          if (u >= 1) {
            this.remove(i)
            continue
          }
          break
        }
      }
      this.place(p)
    }
  }

  /** Pose the piece's mesh: rotation Q about its centre of mass, which sits at P. */
  private place(p: Piece) {
    _m.makeTranslation(p.P.x, p.P.y, p.P.z)
    _m.multiply(_t.makeRotationFromQuaternion(p.Q))
    _m.multiply(_t.makeTranslation(-p.cb.x, -p.cb.y, -p.cb.z))
    p.mesh.matrix.copy(_m)
    p.mesh.matrixWorldNeedsUpdate = true
    p.u.uCapRot.value.setFromMatrix4(_t.makeRotationFromQuaternion(p.Q))
  }

  /** The cut breathes out: a ring of dust blown out flat from the line all round the base. */
  private exhale(p: Piece) {
    const fx = this.g.fx
    const np = Math.round(10 * this.g.q) + 4
    for (let i = 0; i < np; i++) {
      const a = (i / np) * Math.PI * 2
      _p.set(p.c0.x + Math.sin(a) * p.r * 0.9, p.c0.y + 3, p.c0.z + Math.cos(a) * p.r * 0.9)
      _v.set(Math.sin(a) * 26, -2 + Math.random() * 4, Math.cos(a) * 26)
      fx.smoke.spawn(_p, _v, DUST, 0.42, 22 + p.r * 0.1 + Math.random() * 20, 6 + Math.random() * 3, -0.1, 0.35, { grow: 1.8 })
    }
    audio.rumble(Math.min(1, 0.3 + p.r / 400), 3)
  }

  /** Dust spat sideways out of the seam while the piece grinds along it. */
  private grind(p: Piece, dt: number) {
    p.puffT -= dt
    if (p.puffT > 0) return
    p.puffT = 0.18
    const fx = this.g.fx
    const a = Math.random() * Math.PI * 2
    _p.set(p.c0.x + Math.sin(a) * p.r * 0.85, p.c0.y + 2, p.c0.z + Math.cos(a) * p.r * 0.85)
    _v.set(Math.sin(a) * 14, -1, Math.cos(a) * 14).addScaledVector(p.d, 10)
    fx.smoke.spawn(_p, _v, DUST, 0.4, 18 + p.r * 0.06, 5, -0.1, 0.4, { grow: 1.6 })
  }

  /** The moment it gives way: a cloud bursts out from under it and the thunder follows, late, at the speed of sound. */
  private collapse(p: Piece) {
    const g = this.g
    const at = _p.copy(p.c0)
    const size = Math.min(1, p.r / 300)
    const n = Math.round((8 + 10 * size) * g.q)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const q = at.clone().add(new THREE.Vector3(Math.sin(a) * p.r * 0.9, 5 + Math.random() * 20, Math.cos(a) * p.r * 0.9))
      _v.set(Math.sin(a) * (16 + Math.random() * 20), 6 + Math.random() * 14, Math.cos(a) * (16 + Math.random() * 20))
      g.fx.smoke.spawn(q, _v, DUST, 0.5, 40 + p.r * 0.18 + Math.random() * 40, 9 + Math.random() * 5, -0.15, 0.25, { grow: 1.6 })
    }
    const d = at.distanceTo(g.player.pos)
    const big = size * Math.max(0.2, 1 - d / 5000)
    g.fx.after(d / 1100, () => {
      audio.rumble(0.6 + big * 0.6, 5)
      if (big > 0.3) audio.nukeShock()
      g.cam.addTrauma(0.12 + big * 0.4)
      g.rumble(0.3 + big * 0.6, 0.3, 600 + big * 900)
    })
  }

  /** While it comes down: dust avalanches pour off the rim and down the slopes, rocks bounding ahead of them. */
  private avalanche(p: Piece, dt: number) {
    p.puffT -= dt
    if (p.puffT > 0) return
    p.puffT = 0.12
    const fx = this.g.fx
    for (let j = 0; j < 2; j++) {
      const a = Math.random() * Math.PI * 2
      const rr = p.r * (0.7 + Math.random() * 0.4)
      _p.set(p.c0.x + Math.sin(a) * rr, p.c0.y - Math.random() * 20, p.c0.z + Math.cos(a) * rr)
      _v.set(Math.sin(a) * (12 + Math.random() * 14), -6 - Math.random() * 10, Math.cos(a) * (12 + Math.random() * 14))
      fx.smoke.spawn(_p, _v, DUST, 0.45, 26 + p.r * 0.1 + Math.random() * 30, 7 + Math.random() * 4, 0.6, 0.3, { grow: 1.7 })
    }
    if (Math.random() < 0.35) {
      const a = Math.random() * Math.PI * 2
      _p.set(p.c0.x + Math.sin(a) * p.r * 0.8, p.c0.y, p.c0.z + Math.cos(a) * p.r * 0.8)
      fx.debris.burst(_p, 3, 14, 2.5 + Math.min(7, p.r * 0.02), 0.1, 0.4)
    }
  }

  private remove(i: number) {
    const p = this.pieces[i]
    this.root.remove(p.mesh)
    p.mesh.geometry.dispose()
    ;(p.mesh.material as THREE.Material).dispose()
    this.pieces.splice(i, 1)
  }

  reset() {
    while (this.pieces.length) this.remove(this.pieces.length - 1)
  }
}
