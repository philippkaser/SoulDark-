import * as THREE from 'three'
import { CITADEL } from './layout'

/** The far field spans +/- this many metres on x and z. */
export const FAR_HALF = 4096
/** Most simultaneous molten canyons the ground shader keeps track of. */
export const MAX_CUTS = 12
/** How deep a canyon can go below the plain (m). */
export const CANYON_FLOOR = -90
/** The ceiling where nothing was ever cut away. */
export const NO_CEIL = 10000
/** Most Horizon Cuts whose cut lines the ground shader still draws glowing. */
export const MAX_SLICES = 4
/** How fast a slice's cut line races out across the world (m/s). */
export const SLICE_SPEED = 6000

// ---------------------------------------------------------------------------
// Seeded value noise (CPU; deterministic so tests and every run agree)
// ---------------------------------------------------------------------------

function hash2(ix: number, iz: number, seed: number) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function vnoise(x: number, z: number, seed: number) {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  let fx = x - ix
  let fz = z - iz
  fx = fx * fx * (3 - 2 * fx)
  fz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz, seed)
  const b = hash2(ix + 1, iz, seed)
  const c = hash2(ix, iz + 1, seed)
  const d = hash2(ix + 1, iz + 1, seed)
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}

const smooth = (a: number, b: number, v: number) => {
  const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a)
  return t * t * (3 - 2 * t)
}

/**
 * The mountain range around the battlefield, in metres above the plain: a
 * ridged multifractal that rises from foothills ~600 m out to peaks of ~900 m,
 * with a plain kept clear around the arena and the citadel, and a lower range
 * behind the citadel so the eclipse still sits above the skyline.
 */
export function mountainHeight(x: number, z: number, seed = 7) {
  const r = Math.hypot(x, z)
  let m = smooth(520, 1350, r)
  if (m <= 0) return 0
  m *= smooth(320, 700, Math.hypot(x - CITADEL.x, z - CITADEL.z))
  if (m <= 0) return 0
  // azimuth from north (-z): the range behind the citadel stays low
  const az = Math.abs(Math.atan2(x, -z))
  const north = 1 - smooth(0.2, 0.6, az)
  // a slow domain warp so ridges wander instead of following the grid
  const wx = x + (vnoise(x / 1900, z / 1900, seed + 91) - 0.5) * 900
  const wz = z + (vnoise(x / 1900 + 7.3, z / 1900, seed + 92) - 0.5) * 900
  let sum = 0
  let amp = 1
  let f = 1 / 1500
  let weight = 1
  let norm = 0
  for (let o = 0; o < 6; o++) {
    const n = vnoise(wx * f, wz * f, seed + o * 17)
    let ridge = 1 - Math.abs(n * 2 - 1)
    ridge = ridge * ridge * Math.sqrt(ridge)
    ridge *= weight
    weight = Math.min(1, ridge * 2.2)
    sum += ridge * amp
    norm += amp
    amp *= 0.5
    f *= 2.07
  }
  // broad valleys between the massifs
  const valley = smooth(0.25, 0.7, vnoise(x / 2600, z / 2600, seed + 5))
  const H = 220 + 1250 * smooth(850, 3000, r)
  return (sum / norm) * H * m * (0.45 + 0.55 * valley) * (1 - 0.62 * north)
}

export interface FarCut {
  ax: number
  az: number
  bx: number
  bz: number
  /** Half width of the canyon at the top. */
  hw: number
  /** World clock time it was cut (the walls cool from it). */
  time: number
  /** Canyon floor depth below the plain. */
  depth: number
}

export interface FarSlice {
  x: number
  z: number
  /** Everything within this radius above `y` is cut away. */
  r: number
  y: number
  /** World clock time of the cut. */
  time: number
  /** The arc it covered: centre heading (atan2(x, z)) and half-width. */
  heading: number
  half: number
}

export interface CutOpts {
  /** Raggedness of the walls, 0..0.5. */
  jag?: number
  seed?: number
  /** Metres over which the far end tapers out (default 18% of the length). */
  taper?: number
  /** Metres over which the depth ramps in from the start (default: a clean start). */
  rampIn?: number
}

/**
 * The world beyond the arena: a coarse heightfield over +/- FAR_HALF holding
 * the mountains, which the sword can cut. Canyons are carved on the CPU and
 * mirrored into a half-float texture for the ground shader; each canyon is
 * also kept as a segment so the shader can draw its molten walls crisply.
 */
export class FarField {
  readonly half = FAR_HALF
  readonly res: number
  readonly cell: number
  readonly heights: Float32Array
  readonly tex: THREE.DataTexture
  readonly cuts: FarCut[] = []
  /** Packed for the shader: (ax, az, bx, bz) and (hw, time, depth, 0) per cut. */
  readonly cutA: THREE.Vector4[] = []
  readonly cutB: THREE.Vector4[] = []
  readonly slices: FarSlice[] = []
  /** Packed for the shader: (x, z, r, y) and (time, on, heading, half) per slice. */
  readonly sliceA: THREE.Vector4[] = []
  readonly sliceB: THREE.Vector4[] = []
  version = 0
  private base: Float32Array
  private data: Uint16Array
  private dirty = false
  /** What the Horizon Cut left: a ceiling over every cell (NO_CEIL where nothing was cut), mirrored to the GPU. */
  readonly ceil: Float32Array
  readonly ceilTex: THREE.DataTexture
  private ceilData: Uint16Array
  private ceilDirty = false
  private seq = 1

  constructor(res = 512, seed = 7) {
    this.res = res
    this.cell = (this.half * 2) / res
    this.heights = new Float32Array(res * res)
    this.data = new Uint16Array(res * res)
    for (let i = 0; i < MAX_CUTS; i++) {
      this.cutA.push(new THREE.Vector4())
      this.cutB.push(new THREE.Vector4(0, -1e6, 0, 0))
    }
    for (let i = 0; i < MAX_SLICES; i++) {
      this.sliceA.push(new THREE.Vector4(0, 0, 0, 1e5))
      this.sliceB.push(new THREE.Vector4(-1e6, 0, 0, 0))
    }
    const H = this.heights
    for (let j = 0; j < res; j++) {
      const z = -this.half + (j + 0.5) * this.cell
      for (let i = 0; i < res; i++) H[j * res + i] = mountainHeight(-this.half + (i + 0.5) * this.cell, z, seed)
    }
    this.base = H.slice()
    this.ceil = new Float32Array(res * res).fill(NO_CEIL)
    this.ceilData = new Uint16Array(res * res)
    this.ceilTex = new THREE.DataTexture(this.ceilData, res, res, THREE.RedFormat, THREE.HalfFloatType)
    this.ceilTex.magFilter = THREE.LinearFilter
    this.ceilTex.minFilter = THREE.LinearFilter
    this.ceilTex.generateMipmaps = false
    this.ceilTex.wrapS = this.ceilTex.wrapT = THREE.ClampToEdgeWrapping
    this.ceilTex.colorSpace = THREE.NoColorSpace
    this.ceilTex.unpackAlignment = 2
    this.uploadCeil()
    this.tex = new THREE.DataTexture(this.data, res, res, THREE.RedFormat, THREE.HalfFloatType)
    this.tex.magFilter = THREE.LinearFilter
    this.tex.minFilter = THREE.LinearFilter
    this.tex.generateMipmaps = false
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping
    this.tex.colorSpace = THREE.NoColorSpace
    this.tex.unpackAlignment = 2
    this.upload()
  }

  /** Back to the untouched mountains. */
  reset() {
    this.heights.set(this.base)
    this.cuts.length = 0
    this.slices.length = 0
    this.ceil.fill(NO_CEIL)
    this.uploadCeil()
    this.pack()
    this.upload()
    this.version++
  }

  /** Height at (x, z) with whatever the Horizon Cut took off the top. */
  heightAt(x: number, z: number): number {
    return Math.min(this.rawHeightAt(x, z), this.sample(this.ceil, x, z))
  }

  /** The ceiling over (x, z): the height the Horizon Cut flattened the ground to (NO_CEIL where it never cut). */
  ceilAt(x: number, z: number) {
    return this.sample(this.ceil, x, z)
  }

  /** Flatten these cells (indices into the grid) at `y`: everything above it is gone. */
  cutCeiling(cells: ArrayLike<number>, y: number) {
    const C = this.ceil
    for (let i = 0; i < cells.length; i++) {
      const k = cells[i]
      if (y < C[k]) C[k] = y
    }
    this.ceilDirty = true
    this.version++
  }

  /** The ceiling was edited directly (`ceil`): send it to the GPU. */
  ceilChanged() {
    this.ceilDirty = true
    this.version++
  }

  /**
   * Record a Horizon Cut for the ground shader's glow: its plane, its reach
   * from (x, z), the arc it covered (centre heading and half-width, rad) and
   * when it happened. The flattening itself is `cutCeiling`.
   */
  slice(x: number, z: number, r: number, y: number, time: number, heading = 0, half = Math.PI) {
    if (this.slices.length >= MAX_SLICES) this.slices.shift()
    this.slices.push({ x, z, r, y, time, heading, half })
    this.pack()
    this.version++
  }

  /** Bilinear height at (x, z), matching the GPU's linear filtering (clamped at the edge). */
  rawHeightAt(x: number, z: number): number {
    return this.sample(this.heights, x, z)
  }

  private sample(H: Float32Array, x: number, z: number): number {
    const n = this.res
    let u = (x + this.half) / this.cell - 0.5
    let v = (z + this.half) / this.cell - 0.5
    if (u < 0) u = 0
    if (v < 0) v = 0
    if (u > n - 1) u = n - 1
    if (v > n - 1) v = n - 1
    const i0 = Math.floor(u)
    const j0 = Math.floor(v)
    const i1 = Math.min(n - 1, i0 + 1)
    const j1 = Math.min(n - 1, j0 + 1)
    const fu = u - i0
    const fv = v - j0
    const a = H[j0 * n + i0]
    const b = H[j0 * n + i1]
    const c = H[j1 * n + i0]
    const d = H[j1 * n + i1]
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv
  }

  /**
   * Cut a canyon from (ax, az) to (bx, bz): a sheer-walled slot `width` wide
   * whose floor drops to `depth` below the plain, through whatever stands in
   * the way (mountains included). Returns the world rectangle it changed.
   */
  cut(ax: number, az: number, bx: number, bz: number, width: number, depth: number, time: number, opts: CutOpts = {}) {
    const len = Math.hypot(bx - ax, bz - az)
    if (!(len > 1) || !(width > 1)) return null
    const seed = opts.seed ?? this.seq++ * 131 + 7
    const ux = (bx - ax) / len
    const uz = (bz - az) / len
    const hw = width / 2
    const jag = Math.min(0.5, opts.jag ?? 0.25)
    const reach = hw * (1 + jag) * 1.8 + this.cell
    const taper = opts.taper ?? len * 0.18
    const floor = Math.max(CANYON_FLOOR, -depth)
    const x0 = Math.min(ax, bx) - reach
    const z0 = Math.min(az, bz) - reach
    const x1 = Math.max(ax, bx) + reach
    const z1 = Math.max(az, bz) + reach
    const n = this.res
    const c = this.cell
    const i0 = Math.max(0, Math.floor((x0 + this.half) / c))
    const j0 = Math.max(0, Math.floor((z0 + this.half) / c))
    const i1 = Math.min(n - 1, Math.ceil((x1 + this.half) / c))
    const j1 = Math.min(n - 1, Math.ceil((z1 + this.half) / c))
    const H = this.heights
    const wob = 1 / (hw * 6 + 40)
    for (let j = j0; j <= j1; j++) {
      const rz = -this.half + (j + 0.5) * c - az
      for (let i = i0; i <= i1; i++) {
        const rx = -this.half + (i + 0.5) * c - ax
        const t = rx * ux + rz * uz
        if (t < -hw || t > len + hw) continue
        const s = rz * ux - rx * uz
        const w = hw * (1 + jag * (vnoise(t * wob, 0.5, seed) - 0.5) * 2)
        const a = Math.abs(s) / w
        if (a > 1.8) continue
        // the far end runs out; the near end is a clean start or a ramp
        const ramp = opts.rampIn ? 0.08 + 0.92 * smooth(0, opts.rampIn, t) : 1
        const end = smooth(-hw, 0, t) * smooth(0, taper, len - t) * ramp
        if (end <= 0) continue
        const k = j * n + i
        const old = H[k]
        // sheer walls: the slot is flat-bottomed, the lip falls away quickly
        const wall = a < 1 ? 1 : Math.max(0, 1 - (a - 1) / 0.8) ** 2 * 0.35
        const target = floor * end + (old - floor * end) * (a < 1 ? Math.pow(a, 6) : 1 - wall)
        if (target < old) H[k] = target
      }
    }
    this.cuts.push({ ax, az, bx, bz, hw: hw * (1 + jag * 0.5), time, depth: -floor })
    if (this.cuts.length > MAX_CUTS) this.cuts.shift()
    this.pack()
    this.dirty = true
    this.version++
    return [x0, z0, x1, z1] as const
  }

  /** Push the heights to the GPU when they changed (a canyon is a one-off, so a full upload is fine). */
  update() {
    if (this.dirty) this.upload()
    if (this.ceilDirty) this.uploadCeil()
  }

  private uploadCeil() {
    const C = this.ceil
    const D = this.ceilData
    for (let k = 0; k < C.length; k++) D[k] = toHalf(C[k])
    this.ceilTex.needsUpdate = true
    this.ceilDirty = false
  }

  private upload() {
    const H = this.heights
    const D = this.data
    for (let k = 0; k < H.length; k++) D[k] = toHalf(H[k])
    this.tex.needsUpdate = true
    this.dirty = false
  }

  private pack() {
    for (let i = 0; i < MAX_SLICES; i++) {
      const s = this.slices[i]
      if (s) {
        this.sliceA[i].set(s.x, s.z, s.r, s.y)
        this.sliceB[i].set(s.time, 1, s.heading, s.half)
      } else {
        this.sliceA[i].set(0, 0, 0, 1e5)
        this.sliceB[i].set(-1e6, 0, 0, 0)
      }
    }
    for (let i = 0; i < MAX_CUTS; i++) {
      const c = this.cuts[i]
      if (c) {
        this.cutA[i].set(c.ax, c.az, c.bx, c.bz)
        this.cutB[i].set(c.hw, c.time, c.depth, 1)
      } else {
        this.cutA[i].set(0, 0, 0, 0)
        this.cutB[i].set(0, -1e6, 0, 0)
      }
    }
  }
}

// float -> half (heights stay within a few hundred metres: plenty of precision)
const _f32 = new Float32Array(1)
const _u32 = new Uint32Array(_f32.buffer)
export function toHalf(v: number) {
  _f32[0] = v
  const x = _u32[0]
  const sign = (x >>> 16) & 0x8000
  const e = ((x >>> 23) & 0xff) - 112
  if (e <= 0) return sign
  if (e >= 31) return sign | 0x7bff
  return sign | ((e << 10) + (((x & 0x7fffff) + 0x1000) >>> 13))
}
