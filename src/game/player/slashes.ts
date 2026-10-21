import * as THREE from 'three'
import type { Shape } from '../../engine/geom'
import type { Game } from '../Game'
import { crescentGeometry, crescentMaterial } from '../fx/shaders'
import { newHitId, type HitKind } from '../types'

interface Crescent {
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial
  pos: THREE.Vector3
  prev: THREE.Vector3
  dir: THREE.Vector3
  speed: number
  life: number
  maxLife: number
  width: number
  roll: number
  dmg: number
  power: number
  id: number
  kind: HitKind
  active: boolean
  trenchFrom: THREE.Vector3 | null
  normal: THREE.Vector3
  hits: number
  visualOnly: boolean
}

export interface CrescentOpts {
  width: number
  roll: number
  dmg: number
  speed?: number
  life?: number
  color?: THREE.ColorRepresentation
  power?: number
  kind?: HitKind
  visualOnly?: boolean
}

const UP = new THREE.Vector3(0, 1, 0)
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _a = new THREE.Vector3()

/**
 * Flying slashes: crescents of light released by every swing. They cleave
 * whatever they pass through, cut projectiles out of the air and carve
 * trenches when they skim the ground.
 */
export class Slashes {
  readonly root = new THREE.Group()
  private list: Crescent[] = []
  private game: Game
  private geo = crescentGeometry()

  constructor(game: Game) {
    this.game = game
    for (let i = 0; i < 24; i++) {
      const mat = crescentMaterial()
      const mesh = new THREE.Mesh(this.geo, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 10
      this.root.add(mesh)
      this.list.push({
        mesh,
        mat,
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        speed: 0,
        life: 0,
        maxLife: 1,
        width: 1,
        roll: 0,
        dmg: 0,
        power: 0,
        id: 0,
        kind: 'air',
        active: false,
        trenchFrom: null,
        normal: new THREE.Vector3(),
        hits: 0,
        visualOnly: false,
      })
    }
  }

  clear() {
    for (const c of this.list) {
      c.active = false
      c.mesh.visible = false
    }
  }

  fire(origin: THREE.Vector3, dir: THREE.Vector3, o: CrescentOpts) {
    let c = this.list.find((x) => !x.active)
    if (!c) c = this.list.reduce((a, b) => (a.life < b.life ? a : b))
    c.active = true
    c.pos.copy(origin)
    c.prev.copy(origin)
    c.dir.copy(dir).normalize()
    c.speed = o.speed ?? 80
    c.life = c.maxLife = o.life ?? 1.25
    c.width = o.width
    c.roll = o.roll
    c.dmg = o.dmg
    c.power = o.power ?? 30
    c.kind = o.kind ?? 'air'
    c.id = newHitId()
    c.hits = 0
    c.visualOnly = !!o.visualOnly
    c.trenchFrom = null
    c.mat.uniforms.uColor.value.set(o.color ?? '#ffb850')
    c.mesh.visible = true
    this.orient(c)
  }

  private orient(c: Crescent) {
    const z = c.dir
    _x.crossVectors(UP, z)
    if (_x.lengthSq() < 1e-4) _x.set(1, 0, 0)
    _x.normalize()
    _y.crossVectors(z, _x).normalize()
    // roll the swing plane about the travel axis
    const cr = Math.cos(c.roll)
    const sr = Math.sin(c.roll)
    const rx = _a.copy(_x).multiplyScalar(cr).addScaledVector(_y, sr)
    _y.multiplyScalar(cr).addScaledVector(_x, -sr)
    _m.makeBasis(rx, _y, z)
    c.mesh.quaternion.setFromRotationMatrix(_m)
    c.normal.copy(_y)
  }

  update(dt: number) {
    const g = this.game
    for (const c of this.list) {
      if (!c.active) continue
      c.life -= dt
      if (c.life <= 0) {
        c.active = false
        c.mesh.visible = false
        continue
      }
      c.prev.copy(c.pos)
      c.pos.addScaledVector(c.dir, c.speed * dt)
      // aimed into the ground: skim along it (and up crater walls) instead of burrowing
      const gy = g.terrain.heightAt(c.pos.x, c.pos.z)
      if (c.pos.y < gy + 1 && c.dir.y <= 0 && !c.visualOnly) {
        c.pos.y = gy + 1
        c.dir.y = 0
        c.dir.normalize()
        this.orient(c)
      }
      const age = 1 - c.life / c.maxLife
      const w = c.width * (1 + age * 0.6)
      c.mesh.position.copy(c.pos)
      c.mesh.scale.setScalar(w)
      c.mat.uniforms.uAlpha.value = Math.min(1, c.life / (c.maxLife * 0.35)) * Math.min(1, age * 12 + 0.3)
      c.mat.uniforms.uTime.value += dt
      if (c.visualOnly) continue

      // cleave everything along the swept path
      const shape: Shape = { t: 'capsule', a: c.prev, b: c.pos, r: w * 0.55 }
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(c.normal, c.pos)
      const n = g.damage(shape, { id: c.id, kind: c.kind, dmg: c.dmg, power: c.power, origin: c.prev, dir: c.dir, plane, friendly: true })
      c.hits += n
      g.cutProjectiles(shape)

      // skimming the ground: carve a glowing trench and kick up debris
      const groundY = c.pos.y - gy - Math.abs(Math.cos(c.roll)) * 0.05 - Math.abs(Math.sin(c.roll)) * w * 0.5
      if (groundY < 0.6) {
        if (!c.trenchFrom) c.trenchFrom = c.prev.clone()
        if (c.trenchFrom.distanceTo(c.pos) > 3) {
          g.scorch.fissure(c.trenchFrom.x, c.trenchFrom.z, c.pos.x, c.pos.z, 0.5 + w * 0.06, 0.8)
          g.terrain.trench(c.trenchFrom.x, c.trenchFrom.z, c.pos.x, c.pos.z, 1 + w * 0.12, 0.4, { taper: 0, lip: 0.6, jag: 0.15, seed: c.id })
          c.trenchFrom.copy(c.pos)
          _p.copy(c.pos).setY(gy + 0.2)
          g.fx.spark(_p, UP, 10, 9, [1, 0.7, 0.3])
          g.fx.dust(_p, 2, 1.2, 1.6)
          if (Math.random() < 0.5) g.fx.debris.burst(_p, 3, 7, 0.14, 0.6)
        }
      } else if (Math.random() < dt * 30) {
        g.fx.glow.spawn(c.pos, _p.copy(c.dir).multiplyScalar(-c.speed * 0.08), [1, 0.8, 0.45], 0.8, 0.12, 0.25, 0, 2)
      }
    }
  }
}
