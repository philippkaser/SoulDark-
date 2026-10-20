import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { standard } from '../../engine/gfx/materials'
import { armorTextures } from '../../engine/gfx/textures'
import { shapeHitsCapsule, type Shape } from '../../engine/geom'
import { turnToward } from '../../engine/math'
import type { BossBar } from '../../state/store'
import type { Game, Obstacle, System } from '../Game'
import { newHitId, type Hit, type ReflectTarget } from '../types'
import { ridgeSlots } from '../world/layout'
import type { Projectiles } from './projectiles'

interface Cannon extends ReflectTarget {
  group: THREE.Group
  turret: THREE.Group
  barrel: THREE.Group
  muzzle: THREE.Object3D
  hp: number
  maxHp: number
  alive: boolean
  cooldown: number
  burn: number
  x: number
  z: number
  hitIds: Set<number>
  a: THREE.Vector3
  b: THREE.Vector3
}

const _v = new THREE.Vector3()

let mats: { iron: THREE.MeshStandardMaterial; stone: THREE.MeshStandardMaterial; red: THREE.MeshStandardMaterial; brass: THREE.MeshStandardMaterial } | null = null
function materials() {
  if (!mats) {
    const A = armorTextures()
    mats = {
      iron: standard({ color: '#2c2a2a', metalness: 0.85, roughness: 0.7, map: A.map, normalMap: A.normalMap, normalScale: 0.5, rim: 0.3, rimColor: '#ff7a40' }),
      stone: standard({ color: '#3a3330', roughness: 0.95, rim: 0.15, rimColor: '#ff7a40' }),
      red: standard({ color: '#6a0c10', roughness: 0.8, side: THREE.DoubleSide }),
      brass: standard({ color: '#8a6a30', metalness: 1, roughness: 0.4 }),
    }
  }
  return mats
}

function buildCannon() {
  const m = materials()
  const group = new THREE.Group()
  const base = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 5, 2.2, 8), m.stone)
  base.position.y = 1.1
  group.add(base)
  for (let i = 0; i < 8; i++) {
    const merlon = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 0.8), m.stone)
    const a = (i / 8) * Math.PI * 2
    merlon.position.set(Math.sin(a) * 4.4, 2.6, Math.cos(a) * 4.4)
    merlon.rotation.y = a
    group.add(merlon)
  }
  const turret = new THREE.Group()
  turret.position.y = 2.2
  group.add(turret)
  const carriage = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.6, 3.4), m.iron)
  carriage.position.y = 0.8
  turret.add(carriage)
  for (const s of [1, -1]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.4, 16).rotateZ(Math.PI / 2), m.iron)
    wheel.position.set(s * 1.8, 1, 0)
    turret.add(wheel)
  }
  const barrel = new THREE.Group()
  barrel.position.y = 1.9
  barrel.rotation.x = -0.75
  turret.add(barrel)
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.05, 6, 16).rotateX(Math.PI / 2).translate(0, 0, 2), m.iron)
  barrel.add(tube)
  for (const z of [0.2, 2.6, 4.8]) barrel.add(new THREE.Mesh(new THREE.TorusGeometry(z > 4 ? 0.82 : 1.0, 0.12, 6, 18).translate(0, 0, z), m.brass))
  const muzzle = new THREE.Object3D()
  muzzle.position.z = 5.2
  barrel.add(muzzle)
  // a war banner
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 9, 6), m.iron)
  pole.position.set(-3.6, 6.7, -2.4)
  group.add(pole)
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 3.6, 4, 4), m.red)
  flag.position.set(-2.4, 9.2, -2.4)
  group.add(flag)
  group.traverse((o) => {
    o.castShadow = true
    o.receiveShadow = true
  })
  return { group, turret, barrel, muzzle }
}

/** Mortar emplacements on the northern ridge. */
export class Artillery implements System {
  readonly root = new THREE.Group()
  private game: Game
  private proj: Projectiles
  private list: Cannon[] = []
  destroyed = 0
  rate = 1

  constructor(game: Game, proj: Projectiles) {
    this.game = game
    this.proj = proj
  }

  reset() {
    for (const c of this.list) this.root.remove(c.group)
    this.list = []
    this.destroyed = 0
    this.rate = 1
  }

  get count() {
    return this.list.filter((c) => c.alive).length
  }

  /** Raise `n` emplacements on the ridge. */
  deploy(n: number) {
    for (const s of ridgeSlots(n)) {
      const parts = buildCannon()
      parts.group.position.set(s.x, 0, s.z)
      this.root.add(parts.group)
      const c: Cannon = {
        ...parts,
        hp: 1200,
        maxHp: 1200,
        alive: true,
        cooldown: 2 + Math.random() * 5,
        burn: 0,
        x: s.x,
        z: s.z,
        hitIds: new Set(),
        a: new THREE.Vector3(s.x, 0, s.z),
        b: new THREE.Vector3(s.x, 6, s.z),
        radius: 5,
        aim: (out) => out.set(s.x, 4, s.z),
        struck: (dmg, at) => this.hurt(c, dmg, at, null),
      }
      this.list.push(c)
    }
  }

  reflectTargets(out: ReflectTarget[]) {
    for (const c of this.list) if (c.alive) out.push(c)
  }

  obstacles(out: Obstacle[]) {
    for (const c of this.list) if (c.alive) out.push({ x: c.x, z: c.z, r: 5, h: 4 })
  }

  points(out: THREE.Vector3[]) {
    for (const c of this.list) if (c.alive) out.push(new THREE.Vector3(c.x, 3, c.z))
  }

  bosses(out: BossBar[]) {
    const alive = this.list.filter((c) => c.alive)
    if (alive.length && this.game.mode === 'campaign') {
      const hp = alive.reduce((a, c) => a + Math.max(0, c.hp), 0)
      out.push({ id: 'artillery', name: `The Iron Thunder · ${alive.length} guns`, hp, max: this.list.length * 1200 })
    }
  }

  damage(shape: Shape, hit: Hit): number {
    if (!hit.friendly) return 0
    let n = 0
    for (const c of this.list) {
      if (!c.alive || c.hitIds.has(hit.id)) continue
      if (!shapeHitsCapsule(shape, c.a, c.b, 4.5)) continue
      c.hitIds.add(hit.id)
      if (c.hitIds.size > 40) c.hitIds.clear()
      n++
      this.hurt(c, hit.dmg, _v.set(c.x, 3, c.z), hit)
    }
    return n
  }

  private hurt(c: Cannon, dmg: number, at: THREE.Vector3, hit: Hit | null) {
    if (!c.alive) return
    c.hp -= dmg
    this.game.fx.spark(at, null, 20, 12, [1, 0.6, 0.25])
    if (c.hp <= 0) this.destroy(c, hit)
  }

  private destroy(c: Cannon, hit: Hit | null) {
    const g = this.game
    c.alive = false
    this.destroyed++
    const p = new THREE.Vector3(c.x, 3, c.z)
    g.fx.explosion(p, 9)
    g.fx.after(0.25, () => g.fx.explosion(p.clone().add(new THREE.Vector3(2, 2, -1)), 5, { sound: false }))
    g.fx.debris.burst(p, 40, 22, 0.6, 1)
    g.damage({ t: 'sphere', c: p, r: 14 }, { id: newHitId(), kind: 'blast', dmg: 300, power: 30, origin: p, friendly: true })
    if (hit?.plane) g.slicer.slice([c.group], hit.plane, { topple: true, staticBelow: true, life: 14, glow: 1 })
    else {
      c.turret.rotation.z = 0.5
      c.barrel.rotation.x = -0.1
      c.group.position.y = -1
    }
    c.burn = 30
    g.score.kill('cannon', 1, p)
    g.player.gainDivinity(10)
    audio.musicSting('big')
  }

  update(dt: number) {
    const g = this.game
    const pl = g.player
    for (const c of this.list) {
      if (!c.alive) {
        // the wreck burns
        if (c.burn > 0) {
          c.burn -= dt
          if (Math.random() < dt * 8) g.fx.smokeColumn(_v.set(c.x, 3, c.z), 1, 5, 8, 0.8, 0.1)
          if (Math.random() < dt * 12) g.fx.embers(_v.set(c.x, 3, c.z), 3, 3)
        }
        continue
      }
      const want = Math.atan2(pl.pos.x - c.x, pl.pos.z - c.z)
      c.turret.rotation.y = turnToward(c.turret.rotation.y, want, dt * 0.8)
      c.barrel.rotation.x += (-0.75 - c.barrel.rotation.x) * Math.min(1, dt * 4)
      if (g.ceasefire || !pl.alive) continue
      c.cooldown -= dt * this.rate
      if (c.cooldown <= 0) {
        c.cooldown = 5 + Math.random() * 3.5
        c.muzzle.getWorldPosition(_v)
        this.proj.fireShell(_v.clone(), c)
        // recoil, flash, smoke ring
        c.barrel.rotation.x = -0.5
        g.fx.flare(_v, 10, '#ffd090', 0.25)
        g.fx.light(_v, '#ff9a50', 3000, 60, 8)
        g.fx.smokeColumn(_v, 8, 3, 6, 1.4, 0.18)
        g.fx.spark(_v, null, 30, 20, [1, 0.7, 0.3])
        g.sky.flash(_v.clone().sub(g.camera.position).normalize(), 0.15, '#ff9a50')
      }
    }
  }
}
