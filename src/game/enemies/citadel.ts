import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { standard } from '../../engine/gfx/materials'
import { canvasTexture } from '../../engine/gfx/textures'
import { mulberry32 } from '../../engine/math'
import type { BossBar } from '../../state/store'
import type { Game, System } from '../Game'
import type { ReflectTarget } from '../types'
import { CITADEL } from '../world/layout'
import type { Projectiles } from './projectiles'

interface Silo extends ReflectTarget {
  x: number
  z: number
  group: THREE.Group
  lidL: THREE.Object3D
  lidR: THREE.Object3D
  open: number
  launching: number
  alive: boolean
  index: number
}

const _v = new THREE.Vector3()

function windowTexture() {
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, 256, 256)
    const r = mulberry32(5)
    for (let y = 8; y < 256; y += 22) {
      for (let x = 6; x < 256; x += 14) {
        if (r() < 0.32) {
          const hot = r()
          ctx.fillStyle = hot > 0.8 ? '#ffd090' : hot > 0.4 ? '#ff6a20' : '#a01808'
          ctx.fillRect(x, y, 4, 9)
        }
      }
    }
  })
}

function hullTexture() {
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#3c3836'
    ctx.fillRect(0, 0, 256, 256)
    const r = mulberry32(6)
    for (let x = 0; x < 256; x += 16) {
      ctx.fillStyle = `rgba(0,0,0,${0.25 + r() * 0.25})`
      ctx.fillRect(x, 0, 2, 256)
    }
    for (let y = 0; y < 256; y += 22) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)'
      ctx.fillRect(0, y, 256, 2)
    }
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = `rgba(0,0,0,${r() * 0.2})`
      ctx.fillRect(r() * 256, r() * 256, 1 + r() * 6, 1 + r() * 14)
    }
  })
}

/** Scale a box's UVs so the window grid keeps a constant size. */
function box(w: number, h: number, d: number) {
  const g = new THREE.BoxGeometry(w, h, d)
  const uv = g.attributes.uv as THREE.BufferAttribute
  const nor = g.attributes.normal as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nor.getX(i))
    const ny = Math.abs(nor.getY(i))
    const su = ny > 0.5 ? w : nx > 0.5 ? d : w
    const sv = ny > 0.5 ? d : h
    uv.setXY(i, (uv.getX(i) * su) / 40, (uv.getY(i) * sv) / 40)
  }
  return g
}

function tower(r: number, h: number, sides: number) {
  const g = new THREE.CylinderGeometry(r * 0.72, r, h, sides, 6)
  const uv = g.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * r * 6) / 40, (uv.getY(i) * h) / 40)
  return g
}

const searchVert = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`
const searchFrag = `uniform float uAlpha; varying vec2 vUv; void main(){ float a = (1.0 - vUv.y) * uAlpha * 0.18; gl_FragColor = vec4(vec3(1.0, 0.75, 0.55) * a, a); }`

/** The Dominion's fortress on the horizon, and its silos. */
export class Citadel implements System {
  readonly root = new THREE.Group()
  private game: Game
  private proj: Projectiles
  private silos: Silo[] = []
  private spire: THREE.Group
  private searchlights: THREE.Mesh[] = []
  private lightMats: THREE.ShaderMaterial[] = []
  private toppled = false
  private beacon: THREE.Mesh
  private sinking = 0

  constructor(game: Game, proj: Projectiles) {
    this.game = game
    this.proj = proj
    const hull = standard({ color: '#ffffff', map: hullTexture(), roughness: 0.85, metalness: 0.4, emissive: '#ffffff', emissiveMap: windowTexture(), emissiveIntensity: 2.2, rim: 0.2, rimColor: '#ff6a30' })
    const dark = standard({ color: '#1c1918', roughness: 0.9, metalness: 0.5, rim: 0.2, rimColor: '#ff6a30' })
    const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.8, 0.2), fog: false })
    const base = new THREE.Group()
    base.position.set(CITADEL.x, 0, CITADEL.z)
    this.root.add(base)
    // stepped keep
    const steps = [
      [420, 26, 200],
      [320, 30, 160],
      [220, 34, 120],
    ]
    let y = 0
    for (const [w, h, d] of steps) {
      const m = new THREE.Mesh(box(w, h, d), hull)
      m.position.y = y + h / 2
      base.add(m)
      y += h
    }
    // curtain walls with towers
    for (const s of [1, -1]) {
      const wall = new THREE.Mesh(box(260, 42, 14), hull)
      wall.position.set(s * 340, 21, 70)
      wall.rotation.y = s * -0.25
      base.add(wall)
    }
    const r = mulberry32(11)
    const towers = [
      [-180, 60, 18, 160],
      [180, 60, 18, 170],
      [-300, 40, 14, 120],
      [300, 40, 14, 130],
      [-110, -40, 16, 210],
      [110, -40, 16, 200],
      [-440, 100, 12, 95],
      [440, 100, 12, 100],
    ]
    for (const [x, z, rad, h] of towers) {
      const t = new THREE.Mesh(tower(rad, h, 8), hull)
      t.position.set(x, h / 2, z)
      base.add(t)
      const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.8, h * 0.35, 8), dark)
      cap.position.set(x, h + h * 0.17, z)
      base.add(cap)
      for (let i = 0; i < 4; i++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.12, h * 0.25, 4), dark)
        const a = (i / 4) * Math.PI * 2 + r()
        spike.position.set(x + Math.sin(a) * rad * 0.7, h + h * 0.08, z + Math.cos(a) * rad * 0.7)
        spike.rotation.set(Math.cos(a) * 0.3, 0, -Math.sin(a) * 0.3)
        base.add(spike)
      }
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rad * 0.76, 0.8, 6, 24), glow)
      ring.rotation.x = Math.PI / 2
      ring.position.set(x, h * 0.92, z)
      base.add(ring)
      // searchlights sweep the sky from the tallest towers
      if (h > 150) {
        const mat = new THREE.ShaderMaterial({ vertexShader: searchVert, fragmentShader: searchFrag, uniforms: { uAlpha: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false })
        const beam = new THREE.Mesh(new THREE.ConeGeometry(40, 700, 16, 1, true).translate(0, -350, 0).rotateX(Math.PI), mat)
        beam.position.set(x, h, z)
        beam.userData.phase = r() * 6
        base.add(beam)
        this.searchlights.push(beam)
        this.lightMats.push(mat)
      }
    }
    // the central spire
    this.spire = new THREE.Group()
    this.spire.position.y = y
    base.add(this.spire)
    const sp1 = new THREE.Mesh(tower(30, 160, 8), hull)
    sp1.position.y = 80
    this.spire.add(sp1)
    const sp2 = new THREE.Mesh(tower(19, 120, 8), hull)
    sp2.position.y = 220
    this.spire.add(sp2)
    const needle = new THREE.Mesh(new THREE.ConeGeometry(13, 90, 8), dark)
    needle.position.y = 325
    this.spire.add(needle)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const horn = new THREE.Mesh(new THREE.ConeGeometry(3, 46, 5), dark)
      horn.position.set(Math.sin(a) * 18, 290, Math.cos(a) * 18)
      horn.rotation.set(Math.cos(a) * 0.45, 0, -Math.sin(a) * 0.45)
      this.spire.add(horn)
    }
    this.beacon = new THREE.Mesh(new THREE.TorusGeometry(16, 1.6, 8, 40), glow)
    this.beacon.rotation.x = Math.PI / 2
    this.beacon.position.y = 282
    this.spire.add(this.beacon)
    base.traverse((o) => {
      o.castShadow = false
      o.receiveShadow = false
    })

    // the silos, out in front of the walls
    for (let i = 0; i < 3; i++) {
      const x = CITADEL.x + (i - 1) * 150
      const z = CITADEL.z + 120 + (i === 1 ? 20 : 0)
      const group = new THREE.Group()
      group.position.set(x, 0, z)
      const drum = new THREE.Mesh(tower(16, 20, 16), hull)
      drum.position.y = 10
      group.add(drum)
      const lidL = new THREE.Group()
      const lidR = new THREE.Group()
      for (const [lid, s] of [
        [lidL, 1],
        [lidR, -1],
      ] as const) {
        lid.position.set(s * 12, 20, 0)
        const half = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 1.6, 16, 1, false, s > 0 ? Math.PI : 0, Math.PI), dark)
        half.position.x = -s * 12
        lid.add(half)
        group.add(lid)
      }
      const warn = new THREE.Mesh(new THREE.TorusGeometry(12.5, 0.6, 6, 32), glow)
      warn.rotation.x = Math.PI / 2
      warn.position.y = 20.4
      group.add(warn)
      this.root.add(group)
      const silo: Silo = {
        x,
        z,
        group,
        lidL,
        lidR,
        open: 0,
        launching: 0,
        alive: true,
        index: i,
        radius: 20,
        aim: (out) => out.set(x, 18, z),
        struck: () => this.destroySilo(silo),
      }
      this.silos.push(silo)
    }
  }

  reset() {
    for (const s of this.silos) {
      s.alive = true
      s.open = 0
      s.launching = 0
      s.group.visible = true
      s.group.position.y = 0
    }
    this.spire.visible = true
    this.spire.rotation.set(0, 0, 0)
    this.toppled = false
    this.sinking = 0
  }

  get silosLeft() {
    return this.silos.filter((s) => s.alive).length
  }

  /** Open a silo and fire. Returns false when no silo is left. */
  launch() {
    const ready = this.silos.filter((s) => s.alive && s.launching <= 0)
    if (!ready.length) return false
    const s = ready[Math.floor(Math.random() * ready.length)]
    s.launching = 3.2
    audio.warHorn()
    return true
  }

  reflectTargets(out: ReflectTarget[]) {
    // the silos only become fair game in their own trial; a returned warhead
    // still finds its silo because it falls back to its sender
    if (!this.engaged) return
    for (const s of this.silos) if (s.alive) out.push(s)
  }

  bosses(out: BossBar[]) {
    const g = this.game
    if (g.mode === 'campaign' && this.engaged) out.push({ id: 'citadel', name: 'The Dominion Citadel', hp: this.silosLeft, max: 3 })
  }

  /** Show the citadel's bar (set by the wave that starts the nuclear exchange). */
  engaged = false

  private destroySilo(s: Silo) {
    if (!s.alive) return
    const g = this.game
    s.alive = false
    s.group.visible = false
    g.score.kill('silo', 1, _v.set(s.x, 10, s.z))
    if (this.silosLeft === 0) g.fx.after(3.5, () => this.topple())
  }

  private topple() {
    if (this.toppled) return
    this.toppled = true
    const g = this.game
    // the spire shears off and falls
    this.spire.updateWorldMatrix(true, true)
    const p = new THREE.Vector3(CITADEL.x, 140, CITADEL.z)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0.3, 1, 0.2).normalize(), p)
    g.slicer.slice([this.spire], plane, {
      gravity: 12,
      separate: 3,
      spin: 0.12,
      life: 24,
      glow: 1.5,
      onCrash: (at) => {
        g.fx.explosion(at.setY(20), 40)
        g.cam.addTrauma(0.3)
      },
    })
    this.sinking = 1
    g.sky.flash(_v.set(0, 0.2, -1), 1, '#ff8a40')
    audio.roar(_v.set(CITADEL.x, 100, CITADEL.z), 0.5)
  }

  update(dt: number, rdt: number) {
    const t = this.game.clock
    for (const [i, b] of this.searchlights.entries()) {
      const ph = b.userData.phase as number
      b.rotation.set(-0.35 + Math.sin(t * 0.21 + ph) * 0.25, 0, Math.sin(t * 0.17 + ph * 2) * 0.6)
      this.lightMats[i].uniforms.uAlpha.value = this.toppled ? Math.max(0, this.lightMats[i].uniforms.uAlpha.value - rdt * 0.3) : 1
    }
    const bm = this.beacon.material as THREE.MeshBasicMaterial
    const pulse = 3 + Math.sin(t * 2) * 2
    bm.color.setRGB(pulse * 1.5, pulse * 0.2, pulse * 0.05)
    for (const s of this.silos) {
      if (!s.alive) continue
      if (s.launching > 0) {
        const before = s.launching
        s.launching -= dt
        s.open = Math.min(1, s.open + dt * 0.9)
        if (before > 1.2 && s.launching <= 1.2) {
          this.proj.launchNuke(new THREE.Vector3(s.x, 14, s.z), s)
        }
      } else s.open = Math.max(0, s.open - dt * 0.3)
      s.lidL.rotation.z = -s.open * 1.9
      s.lidR.rotation.z = s.open * 1.9
    }
    if (this.sinking > 0) {
      this.sinking += dt
      if (Math.random() < dt * 4) {
        const r = Math.random()
        this.game.fx.explosion(_v.set(CITADEL.x + (r - 0.5) * 400, 30 + Math.random() * 60, CITADEL.z + (Math.random() - 0.5) * 120), 14, { sound: Math.random() < 0.2, scorch: false })
      }
      if (this.sinking > 20) this.sinking = 0
    }
  }
}
