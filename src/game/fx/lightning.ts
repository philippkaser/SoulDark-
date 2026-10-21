import * as THREE from 'three'
import type { GroundSampler } from '../world/terrain'

/**
 * Lightning: branching bolts drawn as camera-facing ribbons with a white-hot
 * core and a coloured additive halo. Every bolt re-jitters its path every
 * 40-60 ms so it crackles, and fades over its life. All bolts share one
 * dynamic mesh (one draw call); slots and buffers are pooled, nothing is
 * allocated per frame. Runs on the hero's clock: it crackles through divine
 * time and stopped time, and holds still in hitstop.
 */

export type BoltPalette = 'gold' | 'white' | 'violet' | 'red' | 'blue'

export interface BoltOpts {
  /** Halo colour: a palette name or any three.js colour. Default gold. */
  color?: BoltPalette | THREE.ColorRepresentation
  /** Ribbon width (halo included) at the trunk, metres. Default scales with length. */
  width?: number
  /** Seconds. Default 0.34 for bolts, 0.16 for arcs. */
  life?: number
  /** Branches off the trunk. Default scales with length. */
  forks?: number
  /** Sideways displacement as a fraction of each segment. Default 0.2 (bolts), 0.28 (arcs). */
  jag?: number
  /** Seconds between re-jitters. Default 0.04-0.06. */
  flicker?: number
  /** Seconds before it appears. */
  delay?: number
  /** Seconds for the leader to race from a to b (0 = instant). */
  grow?: number
  /** Brightness multiplier. Default 1. */
  intensity?: number
  /** Flash a light where it lands. Default true for bolts, false for arcs. */
  light?: boolean
  /** Sparks where it lands. Default true for bolts, false for arcs. */
  sparks?: boolean
  /** When it appears, re-seat both ends this high above the ground (the ground may have been carved since). */
  hug?: number
}

/** The bits of Fx lightning uses (Fx satisfies it structurally). */
export interface LightningFx {
  light(p: THREE.Vector3, color: THREE.ColorRepresentation, power: number, distance: number, decay?: number): void
  spark(p: THREE.Vector3, dir: THREE.Vector3 | null, n: number, speed: number, color?: readonly [number, number, number], size?: number): void
}

export const PALETTE: Record<BoltPalette, string> = {
  gold: '#ffb43c',
  white: '#b8ccff',
  violet: '#9a5cff',
  red: '#ff2a2a',
  blue: '#5aa8ff',
}

export const MAX_BOLTS = 64
const MAX_PTS = 256
const MAX_LINES = 14
const MAX_VERTS = 16384
/** Bolts never dip below the ground by more than this. */
const LIFT = 0.05
const ATTRS = ['position', 'aTan', 'aCol', 'aParams'] as const

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _d = new THREE.Vector3()
const _r = new THREE.Vector3()
const _c = new THREE.Color()
const _sparkCol: [number, number, number] = [1, 0.9, 0.7]
const UP = new THREE.Vector3(0, 1, 0)

function floorAt(ground: GroundSampler | null, x: number, z: number) {
  return (ground ? ground.heightAt(x, z) : 0) + LIFT
}

/**
 * Midpoint displacement: writes 2^depth + 1 points from a to b into
 * out[o * 3 ..]. Each midpoint moves sideways (perpendicular to its segment)
 * by up to `jag` times the segment length, so the path is fractal with the
 * endpoints exactly preserved. Midpoints never go below the ground. Returns
 * the point count.
 */
export function displaceLine(out: Float32Array, o: number, a: THREE.Vector3, b: THREE.Vector3, depth: number, jag: number, rnd: () => number = Math.random, ground: GroundSampler | null = null) {
  const n = (1 << depth) + 1
  const base = o * 3
  out[base] = a.x
  out[base + 1] = a.y
  out[base + 2] = a.z
  const e = base + (n - 1) * 3
  out[e] = b.x
  out[e + 1] = b.y
  out[e + 2] = b.z
  for (let step = n - 1; step > 1; step >>= 1) {
    const half = step >> 1
    for (let i = 0; i < n - 1; i += step) {
      const i0 = base + i * 3
      const i1 = base + (i + step) * 3
      const im = base + (i + half) * 3
      const dx = out[i1] - out[i0]
      const dy = out[i1 + 1] - out[i0 + 1]
      const dz = out[i1 + 2] - out[i0 + 2]
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
      // a random direction perpendicular to the segment
      _d.set(dx, dy, dz).divideScalar(len || 1)
      _r.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1)
      _r.addScaledVector(_d, -_r.dot(_d))
      const rl = _r.length() || 1
      const off = ((rnd() * 2 - 1) * jag * len) / rl
      const x = (out[i0] + out[i1]) * 0.5 + _r.x * off
      const z = (out[i0 + 2] + out[i1 + 2]) * 0.5 + _r.z * off
      out[im] = x
      out[im + 1] = Math.max(floorAt(ground, x, z), (out[i0 + 1] + out[i1 + 1]) * 0.5 + _r.y * off)
      out[im + 2] = z
    }
  }
  return n
}

/** Subdivision depth for a bolt of `len` metres (segments of roughly 0.2-1.5 m). */
export function boltDepth(len: number, arc: boolean) {
  const d = Math.round(Math.log2(Math.max(1, len) / (arc ? 0.18 : 0.35)))
  return Math.max(2, Math.min(arc ? 5 : 6, d))
}

interface Bolt {
  active: boolean
  gen: number
  arc: boolean
  a: THREE.Vector3
  b: THREE.Vector3
  color: THREE.Color
  age: number
  life: number
  grow: number
  flicker: number
  jitterT: number
  width: number
  intensity: number
  jag: number
  forks: number
  depth: number
  bright: number
  light: boolean
  sparks: boolean
  struck: boolean
  hug: number
  born: boolean
  pts: Float32Array
  /** Per line: first point, point count. */
  lineStart: Int16Array
  lineCount: Int16Array
  /** Per line: width scale and where it branches off the trunk (0..1). */
  lineW: Float32Array
  lineAt: Float32Array
  nLines: number
  /** Endpoints at the last re-jitter (moving arcs are dragged along). */
  pa: THREE.Vector3
  pb: THREE.Vector3
}

function makeBolt(): Bolt {
  return {
    active: false,
    gen: 0,
    arc: false,
    a: new THREE.Vector3(),
    b: new THREE.Vector3(),
    color: new THREE.Color(),
    age: 0,
    life: 1,
    grow: 0,
    flicker: 0.05,
    jitterT: 0,
    width: 0.1,
    intensity: 1,
    jag: 0.2,
    forks: 0,
    depth: 3,
    bright: 1,
    light: false,
    sparks: false,
    struck: false,
    hug: -1,
    born: false,
    pts: new Float32Array(MAX_PTS * 3),
    lineStart: new Int16Array(MAX_LINES),
    lineCount: new Int16Array(MAX_LINES),
    lineW: new Float32Array(MAX_LINES),
    lineAt: new Float32Array(MAX_LINES),
    nLines: 0,
    pa: new THREE.Vector3(),
    pb: new THREE.Vector3(),
  }
}

const vert = /* glsl */ `
attribute vec3 aTan;
attribute vec3 aCol;
attribute vec4 aParams; // side (-1 / 1), width, core, alpha
uniform float uPx;
varying vec3 vCol;
varying float vV;
varying float vCore;
varying float vA;
void main() {
  vec3 p = position;
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  vec3 side = cross(aTan, toCam / max(dist, 1e-4));
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  // never thinner than a few pixels, so far bolts don't shimmer away
  float w = max(aParams.y, dist * uPx * 5.0);
  p += side * aParams.x * w * 0.5;
  vV = aParams.x;
  vCol = aCol;
  vCore = aParams.z;
  vA = aParams.w * sqrt(aParams.y / w);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`

const frag = /* glsl */ `
varying vec3 vCol;
varying float vV;
varying float vCore;
varying float vA;
void main() {
  float x = abs(vV);
  float halo = (1.0 - x) * (1.0 - x);
  float core = (1.0 - smoothstep(0.0, 0.22, x)) * vCore;
  vec3 c = vCol * halo * 0.8 + mix(vCol, vec3(1.0, 0.97, 0.92), 0.85) * core * 2.6;
  gl_FragColor = vec4(c * vA, 1.0);
}
`

export class Lightning {
  readonly root: THREE.Mesh
  /** The deformable ground, so bolts land on it and never dive through it. */
  ground: GroundSampler | null = null
  private bolts: Bolt[] = []
  private gen = 1
  private fx: LightningFx | null
  private q: number
  private geo: THREE.BufferGeometry
  private pos: Float32Array
  private tan: Float32Array
  private col: Float32Array
  private par: Float32Array
  private idx: Uint16Array
  private uniforms = { uPx: { value: 0.002 } }
  private lightCd = 0
  /** Live bolt count (tests, debug). */
  count = 0

  constructor(fx: LightningFx | null, quality = 1) {
    this.fx = fx
    this.q = quality
    for (let i = 0; i < MAX_BOLTS; i++) this.bolts.push(makeBolt())
    this.pos = new Float32Array(MAX_VERTS * 3)
    this.tan = new Float32Array(MAX_VERTS * 3)
    this.col = new Float32Array(MAX_VERTS * 3)
    this.par = new Float32Array(MAX_VERTS * 4)
    this.idx = new Uint16Array(MAX_VERTS * 3)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aTan', new THREE.BufferAttribute(this.tan, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aParams', new THREE.BufferAttribute(this.par, 4).setUsage(THREE.DynamicDrawUsage))
    g.setIndex(new THREE.BufferAttribute(this.idx, 1).setUsage(THREE.DynamicDrawUsage))
    g.setDrawRange(0, 0)
    this.geo = g
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    })
    this.root = new THREE.Mesh(g, mat)
    this.root.frustumCulled = false
    this.root.renderOrder = 11
    this.root.visible = false
  }

  /** A branching bolt from a to b. Returns a handle for move()/alive()/kill(). */
  bolt(a: THREE.Vector3, b: THREE.Vector3, opts: BoltOpts = {}) {
    return this.spawn(a, b, opts, false)
  }

  /** A thin sustained arc between two points (sword tip to ground); keep it attached with move(). */
  arc(a: THREE.Vector3, b: THREE.Vector3, opts: BoltOpts = {}) {
    return this.spawn(a, b, opts, true)
  }

  /** Re-anchor a live bolt or arc. Returns false once it has died. */
  move(handle: number, a: THREE.Vector3, b: THREE.Vector3) {
    const bolt = this.get(handle)
    if (!bolt) return false
    bolt.a.copy(a)
    bolt.b.copy(b)
    return true
  }

  /** Is the bolt behind this handle still alive? */
  alive(handle: number) {
    return this.get(handle) !== null
  }

  kill(handle: number) {
    const b = this.get(handle)
    if (b) b.active = false
  }

  /** `n` bolts from the sky onto the ground around `center` over `dur` seconds. */
  storm(center: THREE.Vector3, n: number, radius: number, dur: number, opts: BoltOpts = {}) {
    n = Math.max(1, Math.round(n * (0.5 + this.q * 0.5)))
    const o: BoltOpts = { ...opts }
    const d0 = opts.delay ?? 0
    o.grow = opts.grow ?? 0.06
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2
      const r = radius * (0.25 + Math.random() * 0.75)
      const bx = center.x + Math.sin(ang) * r
      const bz = center.z + Math.cos(ang) * r
      _b.set(bx, floorAt(this.ground, bx, bz), bz)
      const ang2 = ang + (Math.random() - 0.5) * 1.2
      const r2 = r * (0.3 + Math.random() * 0.9)
      _a.set(center.x + Math.sin(ang2) * r2, center.y + 28 + Math.random() * 30, center.z + Math.cos(ang2) * r2)
      o.delay = d0 + Math.random() * dur
      this.bolt(_a, _b, o)
    }
  }

  /** Forks thrown out of a point in a cone around `dir` (parry impacts, discharges). */
  fan(p: THREE.Vector3, dir: THREE.Vector3, n: number, len: number, spread = 0.8, opts: BoltOpts = {}) {
    n = Math.max(1, Math.round(n * (0.5 + this.q * 0.5)))
    const o: BoltOpts = { ...opts }
    const d0 = opts.delay ?? 0
    for (let i = 0; i < n; i++) {
      _d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize()
      _d.multiplyScalar(spread).add(dir).normalize()
      const l = len * (0.45 + Math.random() * 0.55)
      _b.copy(p).addScaledVector(_d, l)
      _b.y = Math.max(_b.y, floorAt(this.ground, _b.x, _b.z))
      o.delay = d0 + Math.random() * 0.06
      this.bolt(p, _b, o)
    }
  }

  /**
   * Lightning racing along the ground from a to b at `speed` m/s: a chain of
   * bolts hugging the surface, each striking as the front passes. Returns the
   * seconds the front takes to arrive.
   */
  crawl(a: THREE.Vector3, b: THREE.Vector3, speed: number, opts: BoltOpts & { hop?: number; height?: number } = {}) {
    const hop = opts.hop ?? 9
    const h = opts.height ?? 0.6
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    const n = Math.max(1, Math.min(MAX_BOLTS - 8, Math.ceil(len / hop)))
    const o: BoltOpts = { ...opts }
    const d0 = opts.delay ?? 0
    const seg = len / n
    o.grow = seg / speed
    o.life = opts.life ?? 0.32
    o.forks = opts.forks ?? 3
    for (let i = 0; i < n; i++) {
      const t0 = i / n
      const t1 = (i + 1) / n
      const x0 = a.x + (b.x - a.x) * t0
      const z0 = a.z + (b.z - a.z) * t0
      const x1 = a.x + (b.x - a.x) * t1
      const z1 = a.z + (b.z - a.z) * t1
      _a.set(x0, floorAt(this.ground, x0, z0) + h, z0)
      _b.set(x1, floorAt(this.ground, x1, z1) + h, z1)
      o.hug = h
      o.delay = d0 + (i * seg) / speed
      // a few links light the ground; the rest are carried by the flash of the cut
      o.light = opts.light ?? i % 4 === 0
      o.sparks = opts.sparks ?? i % 2 === 0
      this.bolt(_a, _b, o)
    }
    return len / speed
  }

  clear() {
    for (const b of this.bolts) b.active = false
    this.count = 0
    this.geo.setDrawRange(0, 0)
    this.root.visible = false
  }

  private get(handle: number): Bolt | null {
    if (handle < 0) return null
    const b = this.bolts[handle & 255]
    return b && b.active && b.gen === handle >> 8 ? b : null
  }

  private spawn(a: THREE.Vector3, b: THREE.Vector3, o: BoltOpts, arc: boolean) {
    // reuse a free slot, else the one closest to death
    let slot = 0
    let best = -Infinity
    for (let i = 0; i < MAX_BOLTS; i++) {
      const x = this.bolts[i]
      if (!x.active) {
        slot = i
        break
      }
      const k = x.age / x.life
      if (k > best) (best = k), (slot = i)
    }
    const bolt = this.bolts[slot]
    this.gen = (this.gen % 0x7fffff) + 1
    bolt.gen = this.gen
    bolt.active = true
    bolt.arc = arc
    bolt.a.copy(a)
    bolt.b.copy(b)
    const len = a.distanceTo(b)
    const c = o.color ?? 'gold'
    bolt.color.set(typeof c === 'string' && c in PALETTE ? PALETTE[c as BoltPalette] : c)
    bolt.age = -(o.delay ?? 0)
    bolt.life = (o.life ?? (arc ? 0.16 : 0.34)) + (o.grow ?? 0)
    bolt.grow = o.grow ?? 0
    bolt.flicker = o.flicker ?? 0.04 + Math.random() * 0.02
    bolt.jitterT = 0
    bolt.width = o.width ?? (arc ? Math.min(0.16, 0.05 + len * 0.02) : Math.min(2.2, 0.1 + len * 0.02))
    bolt.intensity = o.intensity ?? 1
    bolt.jag = o.jag ?? (arc ? 0.28 : 0.2)
    bolt.depth = boltDepth(len, arc)
    const maxForks = MAX_LINES - 1 - (bolt.depth >= 5 ? 4 : 0)
    bolt.forks = Math.min(maxForks, Math.max(0, Math.round(o.forks ?? (arc ? (len > 2 ? 1 : 0) : 2 + Math.min(5, len / 6)))))
    bolt.light = o.light ?? !arc
    bolt.sparks = o.sparks ?? !arc
    bolt.struck = false
    bolt.hug = o.hug ?? -1
    bolt.born = false
    bolt.bright = 1.25
    bolt.nLines = 0
    this.jitter(bolt)
    return slot | (bolt.gen << 8)
  }

  /** Regenerate the bolt's trunk and forks around its current endpoints. */
  private jitter(bolt: Bolt) {
    const pts = bolt.pts
    const ground = this.ground
    let np = displaceLine(pts, 0, bolt.a, bolt.b, bolt.depth, bolt.jag, Math.random, ground)
    const trunkN = np
    bolt.lineStart[0] = 0
    bolt.lineCount[0] = trunkN
    bolt.lineW[0] = 1
    bolt.lineAt[0] = 0
    let lines = 1
    const fdepth = Math.max(2, bolt.depth - 2)
    const fn = (1 << fdepth) + 1
    for (let f = 0; f < bolt.forks && lines < MAX_LINES && np + fn <= MAX_PTS; f++) {
      const t = 0.12 + Math.random() * 0.7
      const i = Math.min(trunkN - 2, Math.floor(t * (trunkN - 1)))
      const k = i * 3
      _a.set(pts[k], pts[k + 1], pts[k + 2])
      // branch roughly along the trunk, kicked sideways
      _d.set(pts[k + 3] - pts[k], pts[k + 4] - pts[k + 1], pts[k + 5] - pts[k + 2]).normalize()
      _r.subVectors(bolt.b, bolt.a).normalize().add(_d).normalize()
      _d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize()
      _r.addScaledVector(_d, 0.9).normalize()
      const remain = _a.distanceTo(bolt.b)
      _b.copy(_a).addScaledVector(_r, remain * (0.25 + Math.random() * 0.35) + 0.15)
      _b.y = Math.max(_b.y, floorAt(ground, _b.x, _b.z))
      bolt.lineStart[lines] = np
      bolt.lineCount[lines] = displaceLine(pts, np, _a, _b, fdepth, bolt.jag * 1.2, Math.random, ground)
      bolt.lineW[lines] = 0.55
      bolt.lineAt[lines] = i / (trunkN - 1)
      np += fn
      lines++
      // big bolts sprout twigs off their forks
      if (bolt.depth >= 5 && lines < MAX_LINES && Math.random() < 0.6) {
        const sd = Math.max(2, fdepth - 1)
        const sn = (1 << sd) + 1
        if (np + sn > MAX_PTS) continue
        const j = bolt.lineStart[lines - 1] + Math.floor(fn * (0.3 + Math.random() * 0.4))
        _a.set(pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2])
        _d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize()
        _r.add(_d).normalize()
        _b.copy(_a).addScaledVector(_r, remain * (0.1 + Math.random() * 0.15) + 0.1)
        _b.y = Math.max(_b.y, floorAt(ground, _b.x, _b.z))
        bolt.lineStart[lines] = np
        bolt.lineCount[lines] = displaceLine(pts, np, _a, _b, sd, bolt.jag * 1.3, Math.random, ground)
        bolt.lineW[lines] = 0.32
        bolt.lineAt[lines] = bolt.lineAt[lines - 1]
        np += sn
        lines++
      }
    }
    bolt.nLines = lines
    bolt.pa.copy(bolt.a)
    bolt.pb.copy(bolt.b)
  }

  update(dt: number, camera?: THREE.PerspectiveCamera, viewportH = 720) {
    if (camera) this.uniforms.uPx.value = 2 / (camera.projectionMatrix.elements[5] * Math.max(1, viewportH))
    this.lightCd -= dt
    let nv = 0
    let ni = 0
    let live = 0
    for (const bolt of this.bolts) {
      if (!bolt.active) continue
      bolt.age += dt
      if (bolt.age >= bolt.life) {
        bolt.active = false
        continue
      }
      live++
      if (bolt.age < 0) continue
      if (!bolt.born) {
        bolt.born = true
        if (bolt.hug >= 0) {
          bolt.a.y = floorAt(this.ground, bolt.a.x, bolt.a.z) + bolt.hug
          bolt.b.y = floorAt(this.ground, bolt.b.x, bolt.b.z) + bolt.hug
          this.jitter(bolt)
        }
      }
      if (!bolt.struck && (bolt.grow <= 0 || bolt.age >= bolt.grow)) this.strike(bolt)
      bolt.jitterT += dt
      if (bolt.jitterT >= bolt.flicker) {
        bolt.jitterT = 0
        this.jitter(bolt)
        bolt.bright = bolt.arc ? 0.7 + Math.random() * 0.5 : 0.5 + Math.random() * 0.7
      } else if (!bolt.pa.equals(bolt.a) || !bolt.pb.equals(bolt.b)) this.drag(bolt)
      // fade over the life after the leader has landed
      const k = bolt.grow > 0 ? Math.max(0, bolt.age - bolt.grow) / Math.max(0.01, bolt.life - bolt.grow) : bolt.age / bolt.life
      const fade = bolt.arc ? Math.min(1, (1 - k) * 4) : k < 0.12 ? 1.3 : Math.pow(1 - k, 1.4)
      const alpha = fade * bolt.bright * bolt.intensity
      const reach = bolt.grow > 0 ? Math.min(1, bolt.age / bolt.grow) : 1
      const r = bolt.color.r
      const g = bolt.color.g
      const bl = bolt.color.b
      for (let l = 0; l < bolt.nLines; l++) {
        if (bolt.lineAt[l] > reach) continue
        const start = bolt.lineStart[l]
        let n = bolt.lineCount[l]
        if (l === 0 && reach < 1) n = Math.max(2, Math.ceil(reach * (n - 1)) + 1)
        if (nv + n * 2 > MAX_VERTS) break
        const w0 = bolt.width * bolt.lineW[l] * (k < 0.08 && !bolt.arc ? 1.4 : 1)
        const core = l === 0 ? 1 : 0.75
        const v0 = nv
        for (let i = 0; i < n; i++) {
          const p = (start + i) * 3
          const pp = (start + Math.max(0, i - 1)) * 3
          const pn = (start + Math.min(n - 1, i + 1)) * 3
          const tx = bolt.pts[pn] - bolt.pts[pp]
          const ty = bolt.pts[pn + 1] - bolt.pts[pp + 1]
          const tz = bolt.pts[pn + 2] - bolt.pts[pp + 2]
          const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1
          const u = i / (n - 1)
          // trunks thin toward the end, forks taper to nothing
          const w = w0 * (l === 0 ? 1 - u * 0.45 : Math.pow(1 - u, 0.8) + 0.05)
          // the leader's head burns brightest while it races ahead
          const head = l === 0 && reach < 1 && i === n - 1 ? 2 : 1
          for (let s = 0; s < 2; s++) {
            const v = nv + s
            this.pos[v * 3] = bolt.pts[p]
            this.pos[v * 3 + 1] = bolt.pts[p + 1]
            this.pos[v * 3 + 2] = bolt.pts[p + 2]
            this.tan[v * 3] = tx / tl
            this.tan[v * 3 + 1] = ty / tl
            this.tan[v * 3 + 2] = tz / tl
            this.col[v * 3] = r
            this.col[v * 3 + 1] = g
            this.col[v * 3 + 2] = bl
            this.par[v * 4] = s === 0 ? -1 : 1
            this.par[v * 4 + 1] = w * head
            this.par[v * 4 + 2] = core
            this.par[v * 4 + 3] = alpha * (l === 0 ? 1 : 0.8)
          }
          nv += 2
        }
        for (let i = 0; i < n - 1; i++) {
          const a = v0 + i * 2
          this.idx[ni++] = a
          this.idx[ni++] = a + 1
          this.idx[ni++] = a + 2
          this.idx[ni++] = a + 1
          this.idx[ni++] = a + 3
          this.idx[ni++] = a + 2
        }
      }
    }
    this.count = live
    this.root.visible = ni > 0
    this.geo.setDrawRange(0, ni)
    if (ni > 0) {
      for (const name of ATTRS) {
        const attr = this.geo.attributes[name] as THREE.BufferAttribute
        attr.clearUpdateRanges()
        attr.addUpdateRange(0, nv * attr.itemSize)
        attr.needsUpdate = true
      }
      const index = this.geo.index!
      index.clearUpdateRanges()
      index.addUpdateRange(0, ni)
      index.needsUpdate = true
    }
  }

  /** Moving endpoints drag the current path along until the next re-jitter. */
  private drag(bolt: Bolt) {
    const dax = bolt.a.x - bolt.pa.x
    const day = bolt.a.y - bolt.pa.y
    const daz = bolt.a.z - bolt.pa.z
    const dbx = bolt.b.x - bolt.pb.x
    const dby = bolt.b.y - bolt.pb.y
    const dbz = bolt.b.z - bolt.pb.z
    for (let l = 0; l < bolt.nLines; l++) {
      const start = bolt.lineStart[l]
      const n = bolt.lineCount[l]
      for (let i = 0; i < n; i++) {
        const t = l === 0 ? i / (n - 1) : bolt.lineAt[l]
        const p = (start + i) * 3
        bolt.pts[p] += dax + (dbx - dax) * t
        bolt.pts[p + 1] += day + (dby - day) * t
        bolt.pts[p + 2] += daz + (dbz - daz) * t
      }
    }
    bolt.pa.copy(bolt.a)
    bolt.pb.copy(bolt.b)
  }

  /** The moment a bolt lands: light and sparks at the far end. */
  private strike(bolt: Bolt) {
    bolt.struck = true
    if (!this.fx) return
    const len = bolt.a.distanceTo(bolt.b)
    if (bolt.light && this.lightCd <= 0) {
      this.lightCd = 0.05
      _c.copy(bolt.color).lerp(_c.setRGB(1, 1, 1), 0.5)
      this.fx.light(_b.copy(bolt.b).addScaledVector(UP, 1), _c, (30 + len * 8) * bolt.intensity, 10 + len * 0.6, 14)
    }
    if (bolt.sparks) {
      _sparkCol[0] = Math.min(1, bolt.color.r * 0.5 + 0.6)
      _sparkCol[1] = Math.min(1, bolt.color.g * 0.5 + 0.55)
      _sparkCol[2] = Math.min(1, bolt.color.b * 0.5 + 0.5)
      this.fx.spark(bolt.b, UP, 2 + Math.min(6, len * 0.25), 3 + Math.min(8, len * 0.3), _sparkCol, 0.035)
    }
  }
}
