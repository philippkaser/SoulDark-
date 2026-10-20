import * as THREE from 'three'

/** World extent covered by the scorch maps (metres, centred on the origin). */
export const SCORCH_HALF = 260
const RES = 1024

/**
 * Two canvases painted with the battle's scars: a permanent burn layer and a
 * glowing heat layer that cools over time. Craters, fissures and beam trails
 * are painted here and sampled by the ground shader.
 */
export class ScorchMap {
  readonly burnTex: THREE.CanvasTexture
  readonly glowTex: THREE.CanvasTexture
  private burn: CanvasRenderingContext2D
  private glow: CanvasRenderingContext2D
  private dirty = false
  private uploadTimer = 0
  private coolTimer = 0
  private headless: boolean

  constructor() {
    this.headless = typeof document === 'undefined'
    const mk = () => {
      const c = this.headless ? null : document.createElement('canvas')
      if (c) {
        c.width = RES
        c.height = RES
      }
      return c
    }
    const bc = mk()
    const gc = mk()
    this.burn = (bc?.getContext('2d') ?? null) as CanvasRenderingContext2D
    this.glow = (gc?.getContext('2d') ?? null) as CanvasRenderingContext2D
    this.burnTex = new THREE.CanvasTexture(bc ?? undefined)
    this.glowTex = new THREE.CanvasTexture(gc ?? undefined)
    for (const t of [this.burnTex, this.glowTex]) {
      // canvas rows map straight to world z
      t.flipY = false
      t.colorSpace = THREE.NoColorSpace
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
      t.generateMipmaps = true
      t.minFilter = THREE.LinearMipmapLinearFilter
    }
    this.clear()
  }

  clear() {
    if (this.headless) return
    this.burn.clearRect(0, 0, RES, RES)
    this.glow.fillStyle = '#000'
    this.glow.fillRect(0, 0, RES, RES)
    this.burnTex.needsUpdate = true
    this.glowTex.needsUpdate = true
  }

  private px(x: number) {
    return ((x + SCORCH_HALF) / (SCORCH_HALF * 2)) * RES
  }

  private m(v: number) {
    return (v / (SCORCH_HALF * 2)) * RES
  }

  /** Radial burn + glowing crater. */
  crater(x: number, z: number, r: number, heat = 1) {
    if (this.headless) return
    const cx = this.px(x)
    const cy = this.px(z)
    const R = Math.max(1, this.m(r))
    let g = this.burn.createRadialGradient(cx, cy, 0, cx, cy, R)
    g.addColorStop(0, 'rgba(0,0,0,0.95)')
    g.addColorStop(0.55, 'rgba(0,0,0,0.75)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    this.burn.fillStyle = g
    this.burn.beginPath()
    this.burn.arc(cx, cy, R, 0, Math.PI * 2)
    this.burn.fill()
    // radial streaks
    this.burn.strokeStyle = 'rgba(0,0,0,0.35)'
    this.burn.lineWidth = Math.max(1, R * 0.06)
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2
      const l = R * (1.1 + Math.random() * 0.8)
      this.burn.beginPath()
      this.burn.moveTo(cx + Math.cos(a) * R * 0.4, cy + Math.sin(a) * R * 0.4)
      this.burn.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l)
      this.burn.stroke()
    }
    g = this.glow.createRadialGradient(cx, cy, 0, cx, cy, R * 0.75)
    g.addColorStop(0, `rgba(255,255,255,${0.9 * heat})`)
    g.addColorStop(0.5, `rgba(255,255,255,${0.45 * heat})`)
    g.addColorStop(1, 'rgba(255,255,255,0)')
    this.glow.fillStyle = g
    this.glow.beginPath()
    this.glow.arc(cx, cy, R * 0.75, 0, Math.PI * 2)
    this.glow.fill()
    this.dirty = true
  }

  /** A jagged glowing fissure (Heaven Splitter, crescent trenches, beams). */
  fissure(x0: number, z0: number, x1: number, z1: number, width: number, heat = 1, jag = 0.6) {
    if (this.headless) return
    const ax = this.px(x0)
    const ay = this.px(z0)
    const bx = this.px(x1)
    const by = this.px(z1)
    const len = Math.hypot(bx - ax, by - ay)
    const nx = -(by - ay) / (len || 1)
    const ny = (bx - ax) / (len || 1)
    const W = Math.max(1, this.m(width))
    const steps = Math.max(2, Math.floor(len / 4))
    const pts: Array<[number, number]> = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const off = i === 0 || i === steps ? 0 : (Math.random() - 0.5) * W * jag * 2
      pts.push([ax + (bx - ax) * t + nx * off, ay + (by - ay) * t + ny * off])
    }
    const stroke = (ctx: CanvasRenderingContext2D, w: number, style: string) => {
      ctx.strokeStyle = style
      ctx.lineWidth = w
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(pts[0][0], pts[0][1])
      for (const p of pts) ctx.lineTo(p[0], p[1])
      ctx.stroke()
    }
    stroke(this.burn, W * 3.2, 'rgba(0,0,0,0.45)')
    stroke(this.burn, W * 1.4, 'rgba(0,0,0,0.9)')
    stroke(this.glow, W * 2.2, `rgba(255,255,255,${0.35 * heat})`)
    stroke(this.glow, W * 0.8, `rgba(255,255,255,${heat})`)
    this.dirty = true
  }

  update(dt: number) {
    if (this.headless) return
    this.coolTimer += dt
    if (this.coolTimer > 1) {
      // the heat layer cools: blend toward black (big steps so 8-bit values never get stuck)
      this.glow.fillStyle = `rgba(0,0,0,${Math.min(0.25, this.coolTimer * 0.09)})`
      this.glow.fillRect(0, 0, RES, RES)
      this.coolTimer = 0
      this.dirty = true
    }
    this.uploadTimer -= dt
    if (this.dirty && this.uploadTimer <= 0) {
      this.uploadTimer = 1 / 15
      this.burnTex.needsUpdate = true
      this.glowTex.needsUpdate = true
      this.dirty = false
    }
  }
}
