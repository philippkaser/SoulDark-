import * as THREE from 'three'
import { mulberry32, smoothstep, TAU } from '../../engine/math'

/**
 * The mountain rings as a polar heightfield: a crest line with the old
 * horizon bands' ridged-noise silhouette, a summit plateau, steep gullied faces
 * and a talus foot tucked under the plain. Pure math (no GPU), shared by the
 * mesh, the GPU lookup table, the ray casts that aim the bores and the rubble
 * that rolls down the slopes.
 */

export interface RingDef {
  /** Radius of the crest line (m). */
  radius: number
  /** Crest height: floor and range (m). */
  base: number
  amp: number
  seed: number
  /** Summit half-width (m). */
  crest: number
  /** Face steepness (crest height over horizontal run), facing the arena and facing away. */
  slopeIn: number
  slopeOut: number
  /** How far the crest line wanders in and out (m). */
  meander: number
}

export const NEAR_RING: RingDef = { radius: 1350, base: 20, amp: 220, seed: 78, crest: 40, slopeIn: 1.9, slopeOut: 1.5, meander: 30 }
export const FAR_RING: RingDef = { radius: 2300, base: 80, amp: 620, seed: 77, crest: 70, slopeIn: 2.2, slopeOut: 1.7, meander: 55 }

/** Below the plain: where the skirt of each ring tucks under the ground. */
export const RIDGE_FLOOR = -40
/** Face coordinate (0 = summit edge, 1 = foot of the cliff) where the skirt has reached RIDGE_FLOOR. */
export const SKIRT = 1.6

/** Lookup-table resolution: azimuth columns x radial rows. */
export const TABLE_A = 2048
export const TABLE_R = 192

const wrap01 = (u: number) => u - Math.floor(u)

/** The old ridge() profile: four octaves of ridged value noise around the circle. */
function ridgedSampler(seed: number) {
  const r = mulberry32(seed)
  const octs = [7, 19, 47, 113].map((n) => Array.from({ length: n }, () => r()))
  return (u: number) => {
    let h = 0
    let w = 1
    let norm = 0
    for (const o of octs) {
      const x = u * o.length
      const i = Math.floor(x)
      const f = x - i
      const s = f * f * (3 - 2 * f)
      const n = o.length
      const a = o[((i % n) + n) % n]
      const v = a + (o[(((i + 1) % n) + n) % n] - a) * s
      h += (1 - Math.abs(v * 2 - 1)) * w
      norm += w
      w *= 0.5
    }
    return h / norm
  }
}

/** Smooth periodic 1D value noise (0..1) with `n` cells around the circle. */
function loopNoise(seed: number, n: number) {
  const r = mulberry32(seed)
  const t = Array.from({ length: n }, () => r())
  return (u: number) => {
    const x = wrap01(u) * n
    const i = Math.floor(x)
    const f = x - i
    const s = f * f * (3 - 2 * f)
    return t[i % n] + (t[(i + 1) % n] - t[i % n]) * s
  }
}

function hash2(ix: number, iy: number, seed: number) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 2D value noise, periodic in x with `px` cells. */
function vnoise(x: number, y: number, px: number, seed: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const x0 = ((ix % px) + px) % px
  const x1 = (x0 + 1) % px
  const a = hash2(x0, iy, seed)
  const b = hash2(x1, iy, seed)
  const c = hash2(x0, iy + 1, seed)
  const d = hash2(x1, iy + 1, seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

export interface RayHit {
  /** Distance along the ray where it first enters the rock, and where it finally leaves the ring. */
  tIn: number
  tOut: number
}

const _hit: RayHit = { tIn: 0, tOut: 0 }

/** Per-azimuth values of the profile. */
export interface Column {
  u: number
  H: number
  rc: number
  T: number
}
const _col: Column = { u: 0, H: 0, rc: 0, T: 0 }

export class Ridge {
  readonly def: RingDef
  /** Radial extent of the ring (and of its lookup table). */
  readonly rMin: number
  readonly rMax: number
  /** Heights on a regular (azimuth, radius) grid; rows of TABLE_A columns. */
  readonly table: Float32Array
  private crestSample: (u: number) => number
  private wander: (u: number) => number
  private width: (u: number) => number
  private gullyCells: number
  private cragCells: number

  constructor(def: RingDef) {
    this.def = def
    this.crestSample = ridgedSampler(def.seed)
    this.wander = loopNoise(def.seed * 31 + 5, 9)
    this.width = loopNoise(def.seed * 17 + 3, 37)
    this.gullyCells = Math.round((TAU * def.radius) / 26)
    this.cragCells = Math.round((TAU * def.radius) / 34)
    const top = def.base + def.amp
    this.rMin = def.radius - def.meander - def.crest * 1.4 - (top / def.slopeIn) * SKIRT - 8
    this.rMax = def.radius + def.meander + def.crest * 1.4 + (top / def.slopeOut) * SKIRT + 8
    this.table = new Float32Array(TABLE_A * TABLE_R)
    const col: Column = { u: 0, H: 0, rc: 0, T: 0 }
    for (let i = 0; i < TABLE_A; i++) {
      this.column((i / TABLE_A) * TAU, col)
      for (let j = 0; j < TABLE_R; j++) this.table[j * TABLE_A + i] = this.profileAt(this.rMin + ((this.rMax - this.rMin) * j) / (TABLE_R - 1), col)
    }
  }

  /** Everything about azimuth a that the profile needs (computed once per column). */
  column(a: number, out: Column = { u: 0, H: 0, rc: 0, T: 0 }) {
    out.u = wrap01(a / TAU)
    out.H = this.crestHeight(a)
    out.rc = this.crestRadius(a)
    out.T = this.crestHalf(a)
    return out
  }

  /** Crest height at azimuth a (radians; a = atan2(x, z), the old horizon band's convention). */
  crestHeight(a: number) {
    return this.def.base + Math.pow(this.crestSample(wrap01(a / TAU)), 2.2) * this.def.amp
  }

  /** Radius of the crest line at azimuth a. */
  crestRadius(a: number) {
    return this.def.radius + (this.wander(a / TAU) * 2 - 1) * this.def.meander
  }

  /** Summit half-width at azimuth a. */
  crestHalf(a: number) {
    return this.def.crest * (0.6 + 0.8 * this.width(a / TAU))
  }

  /**
   * Face coordinate of radius r at azimuth a: < 0 on the summit, 0 at its
   * edge, 1 at the foot of the cliff, SKIRT where it is under the plain.
   * `out` gets the signed distance from the crest line (negative = arena side).
   */
  faceX(r: number, a: number, H = this.crestHeight(a)) {
    const d = r - this.crestRadius(a)
    const W = H / (d > 0 ? this.def.slopeOut : this.def.slopeIn)
    return (Math.abs(d) - this.crestHalf(a)) / W
  }

  /** The analytic height (the mesh samples this; everything else reads the table). */
  profile(r: number, a: number) {
    return this.profileAt(r, this.column(a, _col))
  }

  profileAt(r: number, c: Column) {
    const def = this.def
    const u = c.u
    const H = c.H
    const d = r - c.rc
    const W = H / (d > 0 ? def.slopeOut : def.slopeIn)
    const x = (Math.abs(d) - c.T) / W
    if (x >= SKIRT) return RIDGE_FLOOR
    // a cliff with a rounded shoulder and a short talus apron
    let p = 1
    if (x > 0) p = 1 - 0.85 * smoothstep(0, 1, x) - 0.15 * smoothstep(0.55, 1.4, x)
    let h = H * p
    // gullies: narrow ridged cuts running down the faces
    if (x > 0 && x < 1.3) {
      const g = 1 - Math.abs(vnoise(u * this.gullyCells, d / 70, this.gullyCells, def.seed) * 2 - 1)
      h -= H * 0.11 * Math.sin((Math.PI * x) / 1.3) * g * g * g
    }
    // crags along the summit
    if (x < 1) h += (vnoise(u * this.cragCells, d / 28, this.cragCells, def.seed + 7) - 0.5) * Math.min(18, H * 0.12) * (1 - Math.max(0, x))
    if (x > 1.4) h = h + (RIDGE_FLOOR - h) * smoothstep(1.4, SKIRT, x)
    return h
  }

  /** Bilinear height from the table at (x, z); RIDGE_FLOOR outside the ring. Matches the GPU lookup. */
  heightAt(x: number, z: number) {
    const r = Math.sqrt(x * x + z * z)
    if (r <= this.rMin || r >= this.rMax) return RIDGE_FLOOR
    const fa = wrap01(Math.atan2(x, z) / TAU) * TABLE_A
    const fr = ((r - this.rMin) / (this.rMax - this.rMin)) * (TABLE_R - 1)
    const i0 = Math.floor(fa)
    const j0 = Math.min(TABLE_R - 2, Math.floor(fr))
    const ta = fa - i0
    const tr = fr - j0
    const i1 = (i0 + 1) % TABLE_A
    const c0 = i0 % TABLE_A
    const t = this.table
    const a = t[j0 * TABLE_A + c0]
    const b = t[j0 * TABLE_A + i1]
    const c = t[(j0 + 1) * TABLE_A + c0]
    const d = t[(j0 + 1) * TABLE_A + i1]
    return a + (b - a) * ta + (c - a) * tr + (a - b - c + d) * ta * tr
  }

  /** Is the point inside the rock? */
  inside(x: number, y: number, z: number) {
    return y < this.heightAt(x, z)
  }

  /**
   * Where a ray (unit `d`) first enters this ring's rock and where it finally
   * leaves the ring; null when it passes over (or never reaches) the ridge.
   */
  rayHit(o: THREE.Vector3, d: THREE.Vector3, out: RayHit = _hit): RayHit | null {
    const hl = Math.hypot(d.x, d.z)
    if (hl < 1e-4) return null
    const span = this.crossing(o, d, this.rMin)
    const end = this.crossing(o, d, this.rMax)
    if (end < 0) return null
    const t0 = Math.max(0, span)
    const step = ((this.rMax - this.rMin) / (TABLE_R - 1)) / hl
    const inside = (t: number) => o.y + d.y * t < this.heightAt(o.x + d.x * t, o.z + d.z * t)
    let tIn = -1
    let tOut = -1
    let prev = inside(t0)
    if (prev) tIn = t0
    for (let t = t0 + step; t <= end + step; t += step) {
      const tt = Math.min(t, end)
      const now = inside(tt)
      if (now !== prev) {
        let lo = tt - step
        let hi = tt
        for (let k = 0; k < 12; k++) {
          const m = (lo + hi) / 2
          if (inside(m) === prev) lo = m
          else hi = m
        }
        if (now && tIn < 0) tIn = hi
        if (!now) tOut = hi
        prev = now
      }
      if (tt >= end) break
    }
    if (tIn < 0) return null
    if (tOut < tIn) tOut = end
    out.tIn = tIn
    out.tOut = tOut
    return out
  }

  /** Ray distance where |xz| reaches radius R going outward, or -1. */
  private crossing(o: THREE.Vector3, d: THREE.Vector3, R: number) {
    const a = d.x * d.x + d.z * d.z
    const b = 2 * (o.x * d.x + o.z * d.z)
    const c = o.x * o.x + o.z * o.z - R * R
    const disc = b * b - 4 * a * c
    if (disc < 0) return -1
    const t = (-b + Math.sqrt(disc)) / (2 * a)
    return t
  }

  /** Half-float RED texture of the table: u = azimuth / TAU (repeat), v = (r - rMin) / (rMax - rMin). */
  texture() {
    const data = new Uint16Array(this.table.length)
    for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(this.table[i])
    const tex = new THREE.DataTexture(data, TABLE_A, TABLE_R, THREE.RedFormat, THREE.HalfFloatType)
    tex.magFilter = THREE.LinearFilter
    tex.minFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.colorSpace = THREE.NoColorSpace
    tex.unpackAlignment = 2
    tex.needsUpdate = true
    return tex
  }
}

// ---------------------------------------------------------------------------
// Carves: bores (tunnels) and notches, packed into shader uniform arrays
// ---------------------------------------------------------------------------

export const MAX_BORES = 8
export const MAX_NOTCHES = 4
/** How far in front of the face (in radii) a bore starts carving: enough for the slope below the hole, not the whole foothill. */
export const BORE_LEAD = 1.2
/** How fast a Heaven Splitter notch sweeps across a ring (m/s). */
export const CUT_SPEED = 1600

/** A tunnel through one ring along a ray. Inactive when radius is 0. */
export interface Bore {
  ring: number
  origin: THREE.Vector3
  dir: THREE.Vector3
  radius: number
  /** Ray distances: where the axis enters the rock, and where the carve ends (past the far mouth). */
  tFace: number
  tEnd: number
  /** Where the axis leaves the rock (the far mouth). */
  tExit: number
  /** Wave speed (m/s): the carve front runs down the tunnel at this speed. */
  speed: number
  /** World seconds since the wave reached the face (negative while it travels). */
  age: number
  seed: number
  /** Effects already fired: 1 = the face blew, 2 = the far mouth blew. */
  stage: number
  /** Countdown to the next wisp of smoke from the mouths. */
  wisp: number
}

/** A V-slot cut down from the crest of one ring along a vertical plane. Inactive when width is 0. */
export interface Notch {
  ring: number
  /** A point on the cut plane (the cut's origin) and the horizontal direction along the cut. */
  origin: THREE.Vector3
  fwd: THREE.Vector3
  /** Half-width at the bottom (m) and how much it widens per metre of height. */
  width: number
  flare: number
  /** Distance range along the cut covered by the slot. */
  s0: number
  s1: number
  /** Heights: above every crest it touches, and the bottom of the slot. */
  yTop: number
  yBottom: number
  age: number
  seed: number
  stage: number
}

export function emptyBore(): Bore {
  return { ring: 0, origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), radius: 0, tFace: 0, tEnd: 0, tExit: 0, speed: 1, age: -1, seed: 0, stage: 0, wisp: 0 }
}

export function emptyNotch(): Notch {
  return { ring: 0, origin: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, -1), width: 0, flare: 0, s0: 0, s1: 0, yTop: 0, yBottom: 0, age: -1, seed: 0, stage: 0 }
}

/** Ring id in the integer part, seed (0..1) in the fraction: one float carries both. */
export function packRingSeed(ring: number, seed: number) {
  return ring + Math.min(0.999, Math.max(0, seed))
}

/**
 * Bores as three vec4 arrays for the shaders:
 * A = (origin, radius), B = (dir, age), C = (tFace, tEnd, speed, ring + seed).
 * An empty slot has radius 0, which the shader skips.
 */
export function packBores(bores: readonly Bore[], A: THREE.Vector4[], B: THREE.Vector4[], C: THREE.Vector4[]) {
  for (let i = 0; i < A.length; i++) {
    const b = bores[i]
    if (!b || b.radius <= 0) {
      A[i].set(0, 0, 0, 0)
      B[i].set(0, 0, -1, -1)
      C[i].set(0, 0, 1, 0)
      continue
    }
    A[i].set(b.origin.x, b.origin.y, b.origin.z, b.radius)
    B[i].set(b.dir.x, b.dir.y, b.dir.z, b.age)
    C[i].set(b.tFace, b.tEnd, b.speed, packRingSeed(b.ring, b.seed))
  }
}

/**
 * Notches as three vec4 arrays: A = (origin.x, origin.z, width, flare),
 * B = (fwd.x, fwd.z, s0, s1), C = (yTop, yBottom, age, ring + seed).
 * An empty slot has width 0.
 */
export function packNotches(notches: readonly Notch[], A: THREE.Vector4[], B: THREE.Vector4[], C: THREE.Vector4[]) {
  for (let i = 0; i < A.length; i++) {
    const n = notches[i]
    if (!n || n.width <= 0) {
      A[i].set(0, 0, 0, 0)
      B[i].set(0, -1, 0, 0)
      C[i].set(0, 0, -1, 0)
      continue
    }
    A[i].set(n.origin.x, n.origin.z, n.width, n.flare)
    B[i].set(n.fwd.x, n.fwd.z, n.s0, n.s1)
    C[i].set(n.yTop, n.yBottom, n.age, packRingSeed(n.ring, n.seed))
  }
}

/** Pick a slot: the first empty one, else the oldest. */
export function pickSlot(slots: ReadonlyArray<{ radius?: number; width?: number; age: number }>) {
  let best = 0
  let bestAge = -Infinity
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]
    const used = (s.radius ?? s.width ?? 0) > 0
    if (!used) return i
    if (s.age > bestAge) {
      bestAge = s.age
      best = i
    }
  }
  return best
}
