import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { standard } from '../../engine/gfx/materials'
import { canvasTexture, clothTextures } from '../../engine/gfx/textures'
import { shapeHitsCapsule, type Shape } from '../../engine/geom'
import { TAU } from '../../engine/math'
import type { BossBar } from '../../state/store'
import type { Game, System } from '../Game'
import { newHitId, type Hit, type ReflectTarget } from '../types'
import type { Projectiles } from './projectiles'

interface Ship extends ReflectTarget {
  group: THREE.Group
  hull: THREE.Group
  props: THREE.Object3D[]
  racks: THREE.Object3D[]
  hp: number
  alive: boolean
  angle: number
  orbit: number
  alt: number
  speed: number
  cooldown: number
  salvo: number
  salvoT: number
  falling: boolean
  fallT: number
  vel: THREE.Vector3
  hitIds: Set<number>
  a: THREE.Vector3
  b: THREE.Vector3
}

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const MAX_HP = 2200

function envelopeTexture() {
  return canvasTexture(512, 128, (ctx) => {
    ctx.fillStyle = '#4a0c10'
    ctx.fillRect(0, 0, 512, 128)
    for (let x = 0; x < 512; x += 32) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillRect(x, 0, 3, 128)
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    for (let i = 0; i < 400; i++) ctx.fillRect(Math.random() * 512, Math.random() * 128, 2 + Math.random() * 10, 1 + Math.random() * 3)
    // the Dominion sigil: a black sun
    for (const cx of [128, 384]) {
      ctx.fillStyle = '#1a0406'
      ctx.beginPath()
      ctx.arc(cx, 64, 30, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#c9a050'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.arc(cx, 64, 36, 0, Math.PI * 2)
      ctx.stroke()
    }
  })
}

function buildShip() {
  const C = clothTextures()
  const canvas = standard({ color: '#ffffff', roughness: 0.9, map: envelopeTexture(), normalMap: C.normalMap, normalScale: 0.4, rim: 0.4, rimColor: '#ff7040' })
  const iron = standard({ color: '#24221f', metalness: 0.85, roughness: 0.55, rim: 0.3, rimColor: '#ff7040' })
  const brass = standard({ color: '#8a6a30', metalness: 1, roughness: 0.4 })
  const glass = standard({ color: '#140808', emissive: '#ff8a30', emissiveIntensity: 3, rim: 0 })
  const group = new THREE.Group()
  const hull = new THREE.Group()
  group.add(hull)
  // cigar envelope along +Z
  const L = 46
  const R = 8.5
  const prof: THREE.Vector2[] = []
  for (let i = 0; i <= 24; i++) {
    const t = i / 24
    const y = (t - 0.5) * L
    const r = R * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.62) * (t > 0.85 ? 1 - (t - 0.85) * 2.2 : 1)
    prof.push(new THREE.Vector2(Math.max(0.05, r), y))
  }
  const env = new THREE.Mesh(new THREE.LatheGeometry(prof, 32).rotateX(Math.PI / 2), canvas)
  hull.add(env)
  for (let i = -3; i <= 3; i++) {
    const z = i * 6
    const rr = R * Math.pow(Math.sin(Math.PI * (0.5 + z / L)), 0.62) + 0.08
    hull.add(new THREE.Mesh(new THREE.TorusGeometry(rr, 0.12, 6, 40), iron).translateZ(z))
  }
  // fins
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 7, 8), canvas)
    const a = (i / 4) * TAU
    fin.position.set(Math.sin(a) * 6, Math.cos(a) * 6, -L / 2 + 5)
    fin.rotation.z = -a
    hull.add(fin)
  }
  // gondola with lit windows
  const gond = new THREE.Mesh(new THREE.BoxGeometry(5, 3.4, 18), iron)
  gond.position.set(0, -R - 1.6, 1)
  hull.add(gond)
  for (let i = 0; i < 7; i++) {
    for (const s of [1, -1]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 1.4), glass)
      w.position.set(s * 2.52, -R - 1.2, -6 + i * 2.2)
      hull.add(w)
    }
  }
  hull.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.2, 14), iron).translateY(-R + 0.4))
  // engines with propellers
  const props: THREE.Object3D[] = []
  for (const [x, z] of [
    [7.5, 6],
    [-7.5, 6],
    [7.5, -8],
    [-7.5, -8],
  ]) {
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, 4, 12).rotateX(Math.PI / 2), iron)
    pod.position.set(x, -R * 0.55, z)
    hull.add(pod)
    const strut = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x) - 4, 0.3, 0.6), iron)
    strut.position.set(x * 0.72, -R * 0.55, z)
    hull.add(strut)
    const prop = new THREE.Group()
    for (let b = 0; b < 4; b++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.2, 0.12), brass)
      blade.rotation.z = (b / 4) * TAU
      blade.position.set(0, 0, 0)
      prop.add(blade)
    }
    prop.position.set(x, -R * 0.55, z - 2.3)
    hull.add(prop)
    props.push(prop)
  }
  // missile racks
  const racks: THREE.Object3D[] = []
  for (const s of [1, -1]) {
    for (const z of [-4, 4]) {
      const rack = new THREE.Object3D()
      rack.position.set(s * 3.4, -R - 3.6, z)
      hull.add(rack)
      racks.push(rack)
      hull.add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 3), iron).translateX(s * 3.4).translateY(-R - 3.3).translateZ(z))
    }
  }
  group.traverse((o) => {
    o.castShadow = true
  })
  return { group, hull, props, racks }
}

/** The Skyfleet: war airships that rain missiles. */
export class Airships implements System {
  readonly root = new THREE.Group()
  private game: Game
  private proj: Projectiles
  private list: Ship[] = []
  downed = 0

  constructor(game: Game, proj: Projectiles) {
    this.game = game
    this.proj = proj
  }

  reset() {
    for (const s of this.list) this.root.remove(s.group)
    this.list = []
    this.downed = 0
  }

  get count() {
    return this.list.filter((s) => s.alive).length
  }

  /** Bring `n` ships in over the horizon. */
  deploy(n: number) {
    for (let i = 0; i < n; i++) {
      const parts = buildShip()
      const angle = Math.PI + (i - (n - 1) / 2) * 0.55 + (Math.random() - 0.5) * 0.2
      const ship: Ship = {
        ...parts,
        hp: MAX_HP,
        alive: true,
        angle,
        orbit: 300,
        alt: 48 + Math.random() * 22,
        speed: (0.05 + Math.random() * 0.02) * (i % 2 ? 1 : -1),
        cooldown: 6 + i * 2.2,
        salvo: 0,
        salvoT: 0,
        falling: false,
        fallT: 0,
        vel: new THREE.Vector3(),
        hitIds: new Set(),
        a: new THREE.Vector3(),
        b: new THREE.Vector3(),
        radius: 12,
        aim: (out) => out.copy(ship.group.position).setY(ship.group.position.y - 4),
        struck: (dmg, at) => this.hurt(ship, dmg, at, null),
      }
      this.place(ship, 0)
      this.root.add(ship.group)
      this.list.push(ship)
    }
  }

  private place(s: Ship, dt: number) {
    s.orbit += (115 + (s.alt - 48) * 0.8 - s.orbit) * Math.min(1, dt * 0.25)
    s.angle += s.speed * dt * (90 / s.orbit)
    const x = Math.sin(s.angle) * s.orbit
    const z = Math.cos(s.angle) * s.orbit
    const y = s.alt + Math.sin(this.game.clock * 0.3 + s.angle * 3) * 1.5
    const prev = s.group.position.clone()
    s.group.position.set(x, y, z)
    if (dt > 0) s.vel.subVectors(s.group.position, prev).divideScalar(dt)
    // nose along the orbit tangent
    const yaw = Math.atan2(Math.cos(s.angle) * Math.sign(s.speed), -Math.sin(s.angle) * Math.sign(s.speed))
    s.group.rotation.set(0, yaw, Math.sin(this.game.clock * 0.4 + s.angle) * 0.03)
    // body capsule for hits (nose to tail)
    _v.set(0, 0, 22).applyQuaternion(s.group.quaternion)
    s.a.copy(s.group.position).add(_v)
    s.b.copy(s.group.position).sub(_v)
  }

  reflectTargets(out: ReflectTarget[]) {
    for (const s of this.list) if (s.alive) out.push(s)
  }

  points(out: THREE.Vector3[]) {
    for (const s of this.list) if (s.alive) out.push(s.group.position.clone())
  }

  bosses(out: BossBar[]) {
    const alive = this.list.filter((s) => s.alive)
    if (alive.length && this.game.mode === 'campaign') out.push({ id: 'fleet', name: `The Skyfleet · ${alive.length} ships`, hp: alive.reduce((a, s) => a + s.hp, 0), max: this.list.length * MAX_HP })
  }

  damage(shape: Shape, hit: Hit): number {
    if (!hit.friendly) return 0
    let n = 0
    for (const s of this.list) {
      if (!s.alive || s.hitIds.has(hit.id)) continue
      if (!shapeHitsCapsule(shape, s.a, s.b, 9)) continue
      s.hitIds.add(hit.id)
      if (s.hitIds.size > 40) s.hitIds.clear()
      n++
      this.hurt(s, hit.dmg, s.group.position, hit)
    }
    return n
  }

  private hurt(s: Ship, dmg: number, at: THREE.Vector3, hit: Hit | null) {
    if (!s.alive) return
    s.hp -= dmg
    const g = this.game
    g.fx.explosion(_w.copy(at).add(_v.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 20)), 3, { scorch: false, debris: false })
    if (s.hp <= 0) this.down(s, hit)
  }

  private down(s: Ship, hit: Hit | null) {
    const g = this.game
    s.alive = false
    this.downed++
    g.score.kill('airship', 1, s.group.position)
    g.player.gainDivinity(14)
    audio.musicSting('big')
    const crash = (p: THREE.Vector3, size: number) => {
      g.fx.explosion(p.setY(2), 10 + size * 0.1)
      g.fx.after(0.3, () => g.fx.explosion(p.clone().add(new THREE.Vector3(8, 3, 4)), 7, { sound: false }))
      g.damage({ t: 'sphere', c: p, r: 22 }, { id: newHitId(), kind: 'blast', dmg: 500, power: 34, origin: p, friendly: true })
      g.cam.addTrauma(0.5)
      g.fx.smokeColumn(p, 20, 10, 10, 1.5, 0.08)
    }
    if (hit?.plane) {
      g.slicer.slice([s.group], hit.plane, { gravity: 14, separate: 4, vel: s.vel.clone().multiplyScalar(0.5), spin: 0.25, life: 10, glow: 1.2, onCrash: crash })
      audio.cut(s.group.position, true)
      return
    }
    // burning, nose-down plunge
    s.falling = true
    s.fallT = 0
    s.vel.multiplyScalar(0.6)
    ;(s.group.userData as { crash?: typeof crash }).crash = crash
  }

  update(dt: number) {
    const g = this.game
    const pl = g.player
    for (const s of this.list) {
      for (const p of s.props) p.rotation.z += dt * (s.alive ? 14 : 3)
      if (s.falling) {
        s.fallT += dt
        s.vel.y -= 9 * dt
        s.group.position.addScaledVector(s.vel, dt)
        s.group.rotation.x = Math.min(0.9, s.group.rotation.x + dt * 0.25)
        s.group.rotation.z += dt * 0.15
        if (Math.random() < dt * 3) g.fx.explosion(_w.copy(s.group.position).add(_v.set((Math.random() - 0.5) * 10, 0, (Math.random() - 0.5) * 30)), 2.5, { scorch: false, debris: false, sound: Math.random() < 0.3 })
        g.fx.smokeColumn(_w.copy(s.group.position), 1, 6, 3, 1.2, 0.06)
        if (s.group.position.y < 6) {
          s.falling = false
          s.group.visible = false
          ;(s.group.userData as { crash?: (p: THREE.Vector3, size: number) => void }).crash?.(s.group.position.clone(), 30)
        }
        continue
      }
      if (!s.alive) continue
      this.place(s, dt)
      if (g.ceasefire || !pl.alive) continue
      s.cooldown -= dt
      if (s.cooldown <= 0 && s.salvo === 0) {
        s.salvo = 4
        s.salvoT = 0
        s.cooldown = 8 + Math.random() * 4
      }
      if (s.salvo > 0) {
        s.salvoT -= dt
        if (s.salvoT <= 0) {
          s.salvoT = 0.32
          s.salvo--
          s.racks[s.salvo % s.racks.length].getWorldPosition(_v)
          this.proj.fireMissile(_v.clone(), s, -0.3)
          g.fx.flare(_v, 4, '#ffc080', 0.15)
        }
      }
    }
    this.list = this.list.filter((s) => s.alive || s.falling || s.group.visible)
  }
}
