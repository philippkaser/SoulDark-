import * as THREE from 'three'
import { mulberry32 } from '../../../shared/math'

/**
 * Procedural, tileable texture generation on the CPU (canvas / typed arrays).
 * Everything the game shows is generated here or in shaders: no image assets.
 */

export class TileNoise {
  private grid: Float32Array
  constructor(
    readonly period: number,
    seed: number,
  ) {
    const r = mulberry32(seed)
    this.grid = new Float32Array(period * period)
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = r()
  }
  /** Smooth value noise in [0,1], tileable over `period` units. */
  get(x: number, y: number) {
    const p = this.period
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const x0 = ((xi % p) + p) % p
    const y0 = ((yi % p) + p) % p
    const x1 = (x0 + 1) % p
    const y1 = (y0 + 1) % p
    const g = this.grid
    const u = xf * xf * (3 - 2 * xf)
    const v = yf * yf * (3 - 2 * yf)
    const a = g[y0 * p + x0]
    const b = g[y0 * p + x1]
    const c = g[y1 * p + x0]
    const d = g[y1 * p + x1]
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
  }
}

/** Tileable fBm over a [0,1)² domain with `base` cells on the first octave. */
export function fbmField(size: number, base: number, octaves: number, seed: number, gain = 0.5) {
  const out = new Float32Array(size * size)
  const layers = Array.from({ length: octaves }, (_, o) => new TileNoise(base << o, seed + o * 101))
  let norm = 0
  for (let o = 0; o < octaves; o++) norm += Math.pow(gain, o)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0
      for (let o = 0; o < octaves; o++) {
        const f = (base << o) / size
        v += layers[o].get(x * f, y * f) * Math.pow(gain, o)
      }
      out[y * size + x] = v / norm
    }
  }
  return out
}

/** Tileable Voronoi: returns F1 distance and cell id per pixel. */
export function voronoiField(size: number, cells: number, seed: number, jitter = 0.85) {
  const r = mulberry32(seed)
  const pts = new Float32Array(cells * cells * 2)
  const ids = new Float32Array(cells * cells)
  for (let i = 0; i < cells * cells; i++) {
    pts[i * 2] = 0.5 + (r() - 0.5) * jitter
    pts[i * 2 + 1] = 0.5 + (r() - 0.5) * jitter
    ids[i] = r()
  }
  const f1 = new Float32Array(size * size)
  const f2 = new Float32Array(size * size)
  const id = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells
      const gy = (y / size) * cells
      const cx = Math.floor(gx)
      const cy = Math.floor(gy)
      let d1 = 9
      let d2 = 9
      let best = 0
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox
          const ny = cy + oy
          const wx = ((nx % cells) + cells) % cells
          const wy = ((ny % cells) + cells) % cells
          const k = wy * cells + wx
          const px = nx + pts[k * 2]
          const py = ny + pts[k * 2 + 1]
          const dd = Math.hypot(px - gx, py - gy)
          if (dd < d1) {
            d2 = d1
            d1 = dd
            best = ids[k]
          } else if (dd < d2) d2 = dd
        }
      }
      const i = y * size + x
      f1[i] = d1
      f2[i] = d2
      id[i] = best
    }
  }
  return { f1, f2, id }
}

function dataTexture(data: Uint8Array, size: number, srgb: boolean, repeat = 1) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(repeat, repeat)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 8
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

/** Normal map from a height field (tileable). */
function normalFromHeight(h: Float32Array, size: number, strength: number) {
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)]
      const r = h[y * size + ((x + 1) % size)]
      const u = h[((y - 1 + size) % size) * size + x]
      const d = h[((y + 1) % size) * size + x]
      let nx = (l - r) * strength
      let ny = (u - d) * strength
      let nz = 1
      const len = Math.hypot(nx, ny, nz)
      nx /= len
      ny /= len
      nz /= len
      const i = (y * size + x) * 4
      out[i] = (nx * 0.5 + 0.5) * 255
      out[i + 1] = (ny * 0.5 + 0.5) * 255
      out[i + 2] = (nz * 0.5 + 0.5) * 255
      out[i + 3] = 255
    }
  }
  return out
}

export interface PBRSet {
  map: THREE.Texture
  normalMap: THREE.Texture
  roughnessMap: THREE.Texture
}

const cache = new Map<string, unknown>()
function cached<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make())
  return cache.get(key) as T
}

/** Worn steel: scratches, dents and grime. Map is near-white to be tinted. */
export function armorTextures(): PBRSet {
  return cached('armor', () => {
    const size = 256
    const n = fbmField(size, 4, 5, 11)
    const fine = fbmField(size, 32, 2, 12)
    const h = new Float32Array(size * size)
    const albedo = new Uint8Array(size * size * 4)
    const rough = new Uint8Array(size * size * 4)
    const r = mulberry32(5)
    const scratch = new Float32Array(size * size)
    for (let s = 0; s < 260; s++) {
      let x = r() * size
      let y = r() * size
      const a = r() * Math.PI
      const len = 4 + r() * 40
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      for (let i = 0; i < len; i++) {
        const px = Math.floor(x + size) % size
        const py = Math.floor(y + size) % size
        scratch[py * size + px] = Math.max(scratch[py * size + px], 0.5 + r() * 0.5)
        x += dx
        y += dy
      }
    }
    for (let i = 0; i < size * size; i++) {
      const grime = Math.max(0, n[i] - 0.45) * 2.2
      h[i] = n[i] * 0.6 + fine[i] * 0.25 - scratch[i] * 0.25
      const v = 0.82 - grime * 0.45 + scratch[i] * 0.18 + (fine[i] - 0.5) * 0.08
      albedo[i * 4] = albedo[i * 4 + 1] = albedo[i * 4 + 2] = Math.max(0, Math.min(255, v * 255))
      albedo[i * 4 + 3] = 255
      const ro = 0.38 + grime * 0.4 - scratch[i] * 0.18 + (fine[i] - 0.5) * 0.2
      rough[i * 4 + 1] = Math.max(0, Math.min(255, ro * 255))
      rough[i * 4] = rough[i * 4 + 2] = 0
      rough[i * 4 + 3] = 255
    }
    return {
      map: dataTexture(albedo, size, true, 2),
      normalMap: dataTexture(normalFromHeight(h, size, 2.2), size, false, 2),
      roughnessMap: dataTexture(rough, size, false, 2),
    }
  })
}

/** Woven cloth with stains. */
export function clothTextures(): PBRSet {
  return cached('cloth', () => {
    const size = 256
    const n = fbmField(size, 4, 4, 21)
    const albedo = new Uint8Array(size * size * 4)
    const h = new Float32Array(size * size)
    const rough = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x
        const wx = Math.sin((x / size) * Math.PI * 2 * 64)
        const wy = Math.sin((y / size) * Math.PI * 2 * 64)
        const weave = (x + y) % 4 < 2 ? wx : wy
        h[i] = weave * 0.3 + n[i] * 0.5
        const stain = Math.max(0, n[i] - 0.5) * 1.6
        const v = 0.85 + weave * 0.06 - stain * 0.45
        albedo[i * 4] = albedo[i * 4 + 1] = albedo[i * 4 + 2] = Math.max(0, Math.min(255, v * 255))
        albedo[i * 4 + 3] = 255
        rough[i * 4 + 1] = 235
        rough[i * 4 + 3] = 255
      }
    }
    return {
      map: dataTexture(albedo, size, true, 3),
      normalMap: dataTexture(normalFromHeight(h, size, 1.2), size, false, 3),
      roughnessMap: dataTexture(rough, size, false, 3),
    }
  })
}

/** Dry, cracked skin of the hollowed. */
export function skinTextures(): PBRSet {
  return cached('skin', () => {
    const size = 256
    const n = fbmField(size, 8, 4, 31)
    const v = voronoiField(size, 14, 32)
    const albedo = new Uint8Array(size * size * 4)
    const h = new Float32Array(size * size)
    const rough = new Uint8Array(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      const crack = 1 - Math.min(1, (v.f2[i] - v.f1[i]) * 9)
      h[i] = n[i] * 0.6 - crack * 0.5
      const c = 0.8 + (n[i] - 0.5) * 0.4 - crack * 0.35
      albedo[i * 4] = Math.max(0, Math.min(255, c * 255))
      albedo[i * 4 + 1] = Math.max(0, Math.min(255, c * 0.93 * 255))
      albedo[i * 4 + 2] = Math.max(0, Math.min(255, c * 0.85 * 255))
      albedo[i * 4 + 3] = 255
      rough[i * 4 + 1] = 210
      rough[i * 4 + 3] = 255
    }
    return {
      map: dataTexture(albedo, size, true, 2),
      normalMap: dataTexture(normalFromHeight(h, size, 2.5), size, false, 2),
      roughnessMap: dataTexture(rough, size, false, 2),
    }
  })
}

/** Ember cracks for the Warden's armor (emissive mask). */
export function emberCrackTexture(): THREE.Texture {
  return cached('embercrack', () => {
    const size = 256
    const v = voronoiField(size, 7, 41)
    const n = fbmField(size, 6, 3, 42)
    const data = new Uint8Array(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      const edge = 1 - Math.min(1, (v.f2[i] - v.f1[i]) * 14)
      const m = Math.pow(edge, 4) * (n[i] > 0.52 ? 1 : 0.05)
      data[i * 4] = m * 255
      data[i * 4 + 1] = m * 255
      data[i * 4 + 2] = m * 255
      data[i * 4 + 3] = 255
    }
    return dataTexture(data, size, true, 2)
  })
}

/** Ragged cape alpha: tattered bottom edge and moth holes. */
export function tatteredAlpha(seed: number, severity = 1): THREE.Texture {
  return cached(`tatter${seed}:${severity}`, () => {
    const w = 128
    const h = 256
    const r = mulberry32(seed)
    const n = new TileNoise(16, seed)
    const data = new Uint8Array(w * h * 4)
    const cuts = Array.from({ length: w }, (_, x) => {
      const jag = n.get(x / 8, 0.5) * 0.25 + (r() < 0.12 ? r() * 0.25 : 0)
      return 1 - (0.06 + jag * severity)
    })
    for (let y = 0; y < h; y++) {
      const v = 1 - y / h
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        let a = v < cuts[x] ? 1 : 0
        const hole = n.get(x / 6 + 3.3, y / 6) * n.get(x / 3, y / 3 + 7.1)
        if (hole > 0.62 - (1 - severity) * 0.2) a = 0
        if (x < 1 || x > w - 2) a = 0
        data[i] = data[i + 1] = data[i + 2] = 255 * a
        data[i + 3] = 255
      }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat)
    tex.flipY = false
    tex.needsUpdate = true
    tex.magFilter = THREE.LinearFilter
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.generateMipmaps = true
    return tex
  })
}

/** Canvas texture helper. */
export function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  draw(ctx)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.anisotropy = 8
  return tex
}

/** Painted shield face with an eclipse sigil. */
export function shieldFaceTexture(color: string): THREE.Texture {
  return cached(`shield${color}`, () =>
    canvasTexture(256, 256, (ctx) => {
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 256, 256)
      // worn paint
      const r = mulberry32(9)
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = `rgba(0,0,0,${r() * 0.12})`
        ctx.fillRect(r() * 256, r() * 256, 1 + r() * 6, 1 + r() * 3)
      }
      ctx.translate(128, 120)
      ctx.strokeStyle = '#c9a453'
      ctx.lineWidth = 10
      ctx.beginPath()
      ctx.arc(0, 0, 54, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = '#120c08'
      ctx.beginPath()
      ctx.arc(0, 0, 38, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#c9a453'
      ctx.lineWidth = 4
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2
        ctx.beginPath()
        ctx.moveTo(Math.cos(a) * 64, Math.sin(a) * 64)
        ctx.lineTo(Math.cos(a) * (i % 2 ? 78 : 92), Math.sin(a) * (i % 2 ? 78 : 92))
        ctx.stroke()
      }
    }),
  )
}

/** Soft radial sprite used by particles. */
export function softDotTexture(): THREE.Texture {
  return cached('softdot', () =>
    canvasTexture(64, 64, (ctx) => {
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.25, 'rgba(255,255,255,0.6)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 64, 64)
    }),
  )
}

export { cached }

/** Ashlar stone blocks with mortar. RGB = albedo, A = height. */
export function blockStoneTexture(): THREE.Texture {
  return cached('blockstone', () => {
    const size = 512
    const n = fbmField(size, 8, 5, 51)
    const fine = fbmField(size, 64, 2, 52)
    const r = mulberry32(53)
    const rows = 8
    const data = new Uint8Array(size * size * 4)
    // per row random block widths (tileable: each row sums to 1)
    const rowBlocks: number[][] = []
    for (let y = 0; y < rows; y++) {
      const cuts: number[] = [0]
      let x = 0
      while (x < 1) {
        x += 0.18 + r() * 0.22
        cuts.push(Math.min(1, x))
      }
      if (1 - cuts[cuts.length - 2] < 0.1) cuts.splice(cuts.length - 2, 1)
      cuts[cuts.length - 1] = 1
      rowBlocks.push(cuts)
    }
    const offsets = Array.from({ length: rows }, () => r())
    const tint = Array.from({ length: 256 }, () => r())
    for (let py = 0; py < size; py++) {
      const v = py / size
      const row = Math.floor(v * rows)
      const fy = v * rows - row
      const cuts = rowBlocks[row]
      for (let px = 0; px < size; px++) {
        const u = (px / size + offsets[row]) % 1
        let bi = 0
        while (bi < cuts.length - 2 && cuts[bi + 1] <= u) bi++
        const x0 = cuts[bi]
        const x1 = cuts[bi + 1]
        const ex = Math.min(u - x0, x1 - u) * 1.0
        const ey = Math.min(fy, 1 - fy) / rows
        const i = py * size + px
        const chip = (n[i] - 0.5) * 0.012
        const edge = Math.min(ex, ey) + chip
        const mortar = edge < 0.004
        const bevel = Math.min(1, Math.max(0, (edge - 0.004) / 0.01))
        const id = tint[(row * 31 + bi * 7) & 255]
        const h = mortar ? 0.1 : 0.55 + bevel * 0.35 + (n[i] - 0.5) * 0.25 + (fine[i] - 0.5) * 0.08
        let c = mortar ? 0.36 : 0.6 + (id - 0.5) * 0.18 + (n[i] - 0.5) * 0.38 + (fine[i] - 0.5) * 0.12
        c *= 0.85 + bevel * 0.15
        data[i * 4] = Math.max(0, Math.min(255, c * 255 * 1.0))
        data[i * 4 + 1] = Math.max(0, Math.min(255, c * 255 * 0.985))
        data[i * 4 + 2] = Math.max(0, Math.min(255, c * 255 * 0.96))
        data[i * 4 + 3] = Math.max(0, Math.min(255, h * 255))
      }
    }
    return dataTexture(data, size, true, 1)
  })
}

/** Weathered rock. RGB = albedo, A = height. */
export function rockTexture(): THREE.Texture {
  return cached('rock', () => {
    const size = 512
    const n = fbmField(size, 6, 6, 61)
    const v = voronoiField(size, 10, 62)
    const data = new Uint8Array(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      const crack = 1 - Math.min(1, (v.f2[i] - v.f1[i]) * 6)
      const h = n[i] * 0.8 - Math.pow(crack, 4) * 0.4 + 0.2
      const c = 0.5 + (n[i] - 0.5) * 0.6 - Math.pow(crack, 4) * 0.25 + (v.id[i] - 0.5) * 0.1
      data[i * 4] = Math.max(0, Math.min(255, c * 255))
      data[i * 4 + 1] = Math.max(0, Math.min(255, c * 0.97 * 255))
      data[i * 4 + 2] = Math.max(0, Math.min(255, c * 0.93 * 255))
      data[i * 4 + 3] = Math.max(0, Math.min(255, h * 255))
    }
    return dataTexture(data, size, true, 1)
  })
}

/** Bark with vertical grooves. RGB = albedo, A = height. */
export function barkTexture(): THREE.Texture {
  return cached('bark', () => {
    const size = 256
    const n = fbmField(size, 4, 4, 71)
    const tn = new TileNoise(16, 72)
    const data = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x
        const g = tn.get((x / size) * 16, (y / size) * 2 + n[i] * 2)
        const groove = Math.pow(Math.abs(Math.sin(g * Math.PI * 3)), 0.5)
        const h = groove * 0.7 + n[i] * 0.3
        const c = 0.35 + h * 0.35
        data[i * 4] = c * 255 * 0.9
        data[i * 4 + 1] = c * 255 * 0.8
        data[i * 4 + 2] = c * 255 * 0.7
        data[i * 4 + 3] = h * 255
      }
    }
    return dataTexture(data, size, true, 1)
  })
}
