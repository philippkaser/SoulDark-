import * as THREE from 'three'
import { mulberry32 } from '../../engine/math'
import { SCORCH_HALF } from './scorch'

/** Deepest the plain can be carved (m). */
export const TERRAIN_MIN = -14
/** Highest rims and ejecta can pile up (m). */
export const TERRAIN_MAX = 6
/** Texels along the border that fade to 0 so the field meets the flat outer plain. */
const BORDER = 8
/** Height texture uploads per second, at most. */
const UPLOAD_HZ = 15

/** Anything that can answer "how high is the ground here?" */
export interface GroundSampler {
  heightAt(x: number, z: number): number
}

export interface CraterOpts {
  /** Rim height as a fraction of depth (default 0.22). */
  rim?: number
  /** Ejecta rays and rubble beyond the rim, 0..1 (default 0.5). */
  ejecta?: number
  /** How far the rim wanders from a circle, 0..0.4 (default 0.16). */
  jag?: number
  seed?: number
}

export interface TrenchOpts {
  /** Lip height as a fraction of depth (default 0.18). */
  lip?: number
  /** Raggedness of the walls and centreline, 0..0.5 (default 0.25). */
  jag?: number
  seed?: number
  /**
   * Carve only the slice [from, to) of the line (fractions 0..1). Slices of the
   * same line and seed partition it exactly, so a trench can tear open piece by
   * piece without double-digging the joins.
   */
  from?: number
  to?: number
  /** Metres over which the ends ramp in and out (default: about a width; 0 for abutting segments). */
  taper?: number
}

// ---------------------------------------------------------------------------
// Cheap seeded noise (CPU side, deterministic for tests)
// ---------------------------------------------------------------------------

function hash2(ix: number, iz: number, seed: number) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const fade = (t: number) => t * t * (3 - 2 * t)

/** 2D value noise in 0..1. */
function vnoise(x: number, z: number, seed: number) {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = fade(x - ix)
  const fz = fade(z - iz)
  const a = hash2(ix, iz, seed)
  const b = hash2(ix + 1, iz, seed)
  const c = hash2(ix, iz + 1, seed)
  const d = hash2(ix + 1, iz + 1, seed)
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}

/** 1D value noise in 0..1. */
function noise1(t: number, seed: number) {
  const i = Math.floor(t)
  const a = hash2(i, 0, seed)
  return a + (hash2(i + 1, 0, seed) - a) * fade(t - i)
}

const smooth = (a: number, b: number, v: number) => {
  const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a)
  return t * t * (3 - 2 * t)
}

// float -> half for the upload (heights are small: tiny values flush to 0, no NaN/Inf)
const _f32 = new Float32Array(1)
const _u32 = new Uint32Array(_f32.buffer)
function toHalf(v: number) {
  _f32[0] = v
  const x = _u32[0]
  const sign = (x >>> 16) & 0x8000
  const e = ((x >>> 23) & 0xff) - 112
  if (e <= 0) return sign
  if (e >= 31) return sign | 0x7bff
  // round to nearest; a mantissa carry rolls correctly into the exponent
  return sign | ((e << 10) + (((x & 0x7fffff) + 0x1000) >>> 13))
}

// angular lookup tables for the crater being carved (rim wobble, ejecta rays)
const LUT = 256
const _rag = new Float32Array(LUT + 1)
const _ray = new Float32Array(LUT + 1)

function fillLuts(seed: number) {
  const r = mulberry32(seed)
  const ra: number[] = []
  const rp: number[] = []
  for (let k = 0; k < 6; k++) {
    ra.push((0.4 + r() * 0.6) / Math.pow(k + 2, 0.8))
    rp.push(r() * Math.PI * 2)
  }
  const ya: number[] = []
  const yp: number[] = []
  const yk: number[] = []
  for (let k = 0; k < 5; k++) {
    yk.push(5 + Math.floor(r() * 14))
    ya.push(0.5 + r() * 0.5)
    yp.push(r() * Math.PI * 2)
  }
  let rmax = 0
  for (const a of ra) rmax += a
  for (let i = 0; i <= LUT; i++) {
    const th = (i / LUT) * Math.PI * 2
    let s = 0
    for (let k = 0; k < 6; k++) s += ra[k] * Math.sin((k + 2) * th + rp[k])
    _rag[i] = s / rmax
    let y = 0
    for (let k = 0; k < 5; k++) y += ya[k] * Math.sin(yk[k] * th + yp[k])
    // keep only the crests: thin rays of thrown rubble
    _ray[i] = Math.max(0, y / 2.2 - 0.15) ** 1.5
  }
}

function lut(t: Float32Array, th: number) {
  const f = ((th / (Math.PI * 2)) % 1 + 1) % 1 * LUT
  const i = Math.floor(f)
  return t[i] + (t[i + 1] - t[i]) * (f - i)
}

/**
 * The deformable battlefield: a heightfield over the same square as the
 * scorch map. Craters and trenches are carved on the CPU (heightAt/normalAt
 * read it back for gameplay) and mirrored into a half-float texture that the
 * ground, the particles and anything else displaced by the terrain sample.
 */
export class Terrain implements GroundSampler {
  readonly res: number
  readonly half = SCORCH_HALF
  /** Metres per texel. */
  readonly cell: number
  readonly heights: Float32Array
  /** R16F heights, texel centres at -half + (i + 0.5) * cell. */
  readonly tex: THREE.DataTexture
  /** Bumped by every carve and reset (cheap change detection for other systems). */
  version = 0
  /** Number of texture uploads so far. */
  uploads = 0
  private data: Uint16Array
  private dirty = false
  private d0 = [0, 0, 0, 0]
  private uploadTimer = 0
  private seq = 1
  private edge: Float32Array

  constructor(res = 512) {
    this.res = res
    this.cell = (this.half * 2) / res
    this.heights = new Float32Array(res * res)
    this.data = new Uint16Array(res * res)
    this.tex = new THREE.DataTexture(this.data, res, res, THREE.RedFormat, THREE.HalfFloatType)
    this.tex.magFilter = THREE.LinearFilter
    this.tex.minFilter = THREE.LinearFilter
    this.tex.generateMipmaps = false
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping
    this.tex.colorSpace = THREE.NoColorSpace
    this.tex.unpackAlignment = 2
    this.tex.needsUpdate = true
    this.edge = new Float32Array(res)
    for (let i = 0; i < res; i++) this.edge[i] = smooth(0, BORDER, Math.min(i, res - 1 - i))
  }

  reset() {
    this.heights.fill(0)
    this.data.fill(0)
    this.dirty = false
    this.tex.needsUpdate = true
    this.uploads++
    this.version++
  }

  /** Bilinear ground height at (x, z); 0 outside the field. Matches the GPU's linear sampling. */
  heightAt(x: number, z: number): number {
    const h = this.half
    if (x <= -h || x >= h || z <= -h || z >= h) return 0
    const n = this.res
    const u = (x + h) / this.cell - 0.5
    const v = (z + h) / this.cell - 0.5
    let i0 = Math.floor(u)
    let j0 = Math.floor(v)
    const fu = u - i0
    const fv = v - j0
    let i1 = i0 + 1
    let j1 = j0 + 1
    if (i0 < 0) i0 = 0
    if (j0 < 0) j0 = 0
    if (i1 > n - 1) i1 = n - 1
    if (j1 > n - 1) j1 = n - 1
    const H = this.heights
    const a = H[j0 * n + i0]
    const b = H[j0 * n + i1]
    const c = H[j1 * n + i0]
    const d = H[j1 * n + i1]
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv
  }

  /** Surface normal at (x, z) from central differences. */
  normalAt(x: number, z: number, out: THREE.Vector3) {
    const e = this.cell
    return out.set(this.heightAt(x - e, z) - this.heightAt(x + e, z), 2 * e, this.heightAt(x, z - e) - this.heightAt(x, z + e)).normalize()
  }

  /**
   * Blast a bowl into the ground: a ragged raised rim, rubble, and rays of
   * ejecta. Overlapping craters merge (the deeper bowl wins, rims add up).
   */
  crater(x: number, z: number, radius: number, depth: number, opts: CraterOpts = {}) {
    if (!(radius > 0.2) || !(depth > 0)) return
    const seed = opts.seed ?? this.seq++ * 977 + 13
    const rimH = (opts.rim ?? 0.22) * depth
    const ej = opts.ejecta ?? 0.5
    const jag = Math.min(0.4, opts.jag ?? 0.16)
    fillLuts(seed)
    // ejecta reach (in radii past the rim); huge craters throw proportionally less
    const ejr = radius > 30 ? 0.9 : 1.5
    const reach = radius * (1 + jag) * (ej > 0 ? 1 + ejr : 1.8)
    const box = this.box(x - reach, z - reach, x + reach, z + reach)
    if (!box) return
    const [i0, j0, i1, j1] = box
    const hc = this.heightAt(x, z)
    // big bowls get flatter floors and steeper walls
    const pw = radius > 20 ? 3 : 2
    const ns = 1.6 / Math.max(1.5, radius * 0.25)
    const H = this.heights
    const n = this.res
    const c = this.cell
    const r2 = reach * reach
    for (let j = j0; j <= j1; j++) {
      const wz = -this.half + (j + 0.5) * c
      const dz = wz - z
      for (let i = i0; i <= i1; i++) {
        const wx = -this.half + (i + 0.5) * c
        const dx = wx - x
        const dd = dx * dx + dz * dz
        if (dd > r2) continue
        const th = Math.atan2(dz, dx)
        const d = Math.sqrt(dd) / (radius * (1 + jag * lut(_rag, th)))
        const rub = vnoise(wx * ns, wz * ns, seed) - 0.5
        const k = j * n + i
        const old = H[k]
        let h = old
        if (d < 1) h = Math.min(old, hc - depth * (1 - (pw === 3 ? d * d * d : d * d)) * (1 + rub * 0.25))
        // rim: sharp inside, a long slope outside
        let add = rimH * (d < 1 ? Math.exp(-((d - 1) * (d - 1)) / 0.04) : Math.exp(-((d - 1) * (d - 1)) / 0.2)) * (1 + rub * 0.9)
        if (d > 1 && ej > 0) {
          const fall = Math.max(0, 1 - (d - 1) / ejr)
          add += depth * 0.16 * ej * lut(_ray, th) * fall * fall * (0.7 + rub * 1.4)
        }
        if (add > 0) h += add * Math.max(0, 1 - Math.max(0, old) / TERRAIN_MAX)
        H[k] = (h < TERRAIN_MIN ? TERRAIN_MIN : h > TERRAIN_MAX ? TERRAIN_MAX : h) * this.edge[i] * this.edge[j]
      }
    }
    this.touch(i0, j0, i1, j1)
  }

  /**
   * Gouge a long ragged trench from (x0, z0) to (x1, z1) with raised lips:
   * the Heaven Splitter's canyon, a colossus's sword stroke. `width` is the
   * full width at the top. Trenches dig into whatever is already there.
   */
  trench(x0: number, z0: number, x1: number, z1: number, width: number, depth: number, opts: TrenchOpts = {}) {
    if (!(width > 0.2) || !(depth > 0)) return
    const len = Math.hypot(x1 - x0, z1 - z0)
    if (len < 0.5) return this.crater(x0, z0, width / 2, depth, { seed: opts.seed })
    const seed = opts.seed ?? this.seq++ * 977 + 13
    const ux = (x1 - x0) / len
    const uz = (z1 - z0) / len
    const hw = width / 2
    const lipH = (opts.lip ?? 0.18) * depth
    const jag = Math.min(0.5, opts.jag ?? 0.25)
    const t0 = Math.max(0, opts.from ?? 0) * len
    const t1 = Math.min(1, opts.to ?? 1) * len
    if (t1 <= t0) return
    const reach = hw * (1 + jag) * 2.6
    const taper = opts.taper ?? Math.min(len * 0.3, hw * 2 + 2)
    const ax = x0 + ux * t0
    const az = z0 + uz * t0
    const bx = x0 + ux * t1
    const bz = z0 + uz * t1
    const box = this.box(Math.min(ax, bx) - reach, Math.min(az, bz) - reach, Math.max(ax, bx) + reach, Math.max(az, bz) + reach)
    if (!box) return
    const [i0, j0, i1, j1] = box
    const wob = 1 / (hw * 3 + 4)
    const wid = 1 / (hw * 2 + 3)
    const ns = 1.6 / Math.max(1.5, hw * 0.5)
    const H = this.heights
    const n = this.res
    const c = this.cell
    for (let j = j0; j <= j1; j++) {
      const rz = -this.half + (j + 0.5) * c - z0
      for (let i = i0; i <= i1; i++) {
        const rx = -this.half + (i + 0.5) * c - x0
        const t = rx * ux + rz * uz
        if (t < t0 || t >= t1) continue
        const s = rz * ux - rx * uz
        if (Math.abs(s) > reach) continue
        const off = jag * hw * (noise1(t * wob, seed) - 0.5) * 2
        const w = hw * (1 + jag * 0.8 * (noise1(t * wid, seed + 1) - 0.5) * 2)
        const a = Math.abs(s - off) / w
        const end = smooth(0, taper, t) * smooth(0, taper, len - t)
        if (end <= 0) continue
        const rub = vnoise((rx + x0) * ns, (rz + z0) * ns, seed) - 0.5
        const k = j * n + i
        const old = H[k]
        let h = old
        if (a < 1) h -= depth * end * (1 - a * a * a) * (0.8 + 0.4 * noise1(t / 14, seed + 2)) * (1 + rub * 0.3)
        const lip = lipH * end * (a < 1 ? Math.exp(-((a - 1) * (a - 1)) / 0.03) : Math.exp(-((a - 1) * (a - 1)) / 0.45)) * (1 + rub)
        if (lip > 0) h += lip * Math.max(0, 1 - Math.max(0, old) / TERRAIN_MAX)
        H[k] = (h < TERRAIN_MIN ? TERRAIN_MIN : h > TERRAIN_MAX ? TERRAIN_MAX : h) * this.edge[i] * this.edge[j]
      }
    }
    this.touch(i0, j0, i1, j1)
  }

  /** Push pending changes to the GPU, at most UPLOAD_HZ times a second (real time). */
  update(dt: number) {
    this.uploadTimer -= dt
    if (!this.dirty || this.uploadTimer > 0) return
    this.uploadTimer = 1 / UPLOAD_HZ
    const [i0, j0, i1, j1] = this.d0
    const n = this.res
    const H = this.heights
    const D = this.data
    for (let j = j0; j <= j1; j++) for (let k = j * n + i0, e = j * n + i1; k <= e; k++) D[k] = toHalf(H[k])
    this.tex.needsUpdate = true
    this.uploads++
    this.dirty = false
  }

  /** Texel box covering a world-space rectangle, clipped to the field (null when outside). */
  private box(x0: number, z0: number, x1: number, z1: number): [number, number, number, number] | null {
    const n = this.res
    const i0 = Math.max(0, Math.floor((x0 + this.half) / this.cell))
    const j0 = Math.max(0, Math.floor((z0 + this.half) / this.cell))
    const i1 = Math.min(n - 1, Math.ceil((x1 + this.half) / this.cell))
    const j1 = Math.min(n - 1, Math.ceil((z1 + this.half) / this.cell))
    return i0 > i1 || j0 > j1 ? null : [i0, j0, i1, j1]
  }

  private touch(i0: number, j0: number, i1: number, j1: number) {
    const d = this.d0
    if (!this.dirty) {
      d[0] = i0
      d[1] = j0
      d[2] = i1
      d[3] = j1
      this.dirty = true
    } else {
      d[0] = Math.min(d[0], i0)
      d[1] = Math.min(d[1], j0)
      d[2] = Math.max(d[2], i1)
      d[3] = Math.max(d[3], j1)
    }
    this.version++
  }
}
