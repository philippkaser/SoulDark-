import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { standard } from '../../engine/gfx/materials'
import { rockTexture } from '../../engine/gfx/textures'
import { shapeHitsCapsule, type Shape } from '../../engine/geom'
import { mulberry32 } from '../../engine/math'
import type { Game } from '../Game'
import type { Damageable, Hit } from '../types'
import { spireDefs, type SpireDef } from './layout'
import { Mountains } from './mountains'

interface Spire {
  def: SpireDef
  mesh: THREE.Mesh
  /** Rock below the plain, seen only when a crater digs around the spire. */
  base: THREE.Mesh
  hp: number
  alive: boolean
  hitIds: Set<number>
  a: THREE.Vector3
  b: THREE.Vector3
}

function spireGeometry(d: SpireDef) {
  const r = mulberry32(d.seed)
  const seg = 14
  const g = new THREE.CylinderGeometry(d.r * (0.35 + r() * 0.3), d.r, d.h, 11, seg, false)
  g.translate(0, d.h / 2, 0)
  const pos = g.attributes.position as THREE.BufferAttribute
  const leanX = (r() - 0.5) * 0.18
  const leanZ = (r() - 0.5) * 0.18
  const phase = r() * 10
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const a = Math.atan2(z, x)
    const t = y / d.h
    const bulge = 1 + 0.18 * Math.sin(a * 3 + phase + t * 6) + 0.1 * Math.sin(a * 7 - t * 11 + phase) + 0.12 * Math.sin(t * 9 + phase)
    pos.setXYZ(i, x * bulge + leanX * y, y, z * bulge + leanZ * y)
  }
  g.computeVertexNormals()
  return g
}

/** The spire's root below the plain: its foot continued down, flaring as it goes. */
function spireBaseGeometry(d: SpireDef, deep: number) {
  const r = mulberry32(d.seed)
  r()
  const leanX = (r() - 0.5) * 0.18
  const leanZ = (r() - 0.5) * 0.18
  const phase = r() * 10
  const g = new THREE.CylinderGeometry(d.r, d.r, deep, 11, 3).translate(0, -deep / 2 + 0.05, 0)
  const pos = g.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const a = Math.atan2(z, x)
    const bulge = (1 + 0.18 * Math.sin(a * 3 + phase) + 0.1 * Math.sin(a * 7 + phase) + 0.12 * Math.sin(phase)) * (1 - y * 0.03)
    pos.setXYZ(i, x * bulge + leanX * y, y, z * bulge + leanZ * y)
  }
  g.computeVertexNormals()
  return g
}

/** Rock spires across the plain (sliceable) and the mountains on the horizon. */
export class Props implements Damageable {
  readonly root = new THREE.Group()
  /** The mountain rings on the horizon (boreable, notchable). */
  readonly mountains: Mountains
  private spires: Spire[] = []
  private game: Game
  private mat: THREE.MeshStandardMaterial

  constructor(game: Game) {
    this.game = game
    const tex = rockTexture()
    tex.repeat.set(2, 3)
    this.mat = standard({ color: '#6e625e', roughness: 0.95, map: tex, rim: 0.15, rimColor: '#ff9a60' })
    this.mountains = new Mountains(game)
    this.root.add(this.mountains.root)
    game.boreMountains = (o, d, r, s) => this.mountains.bore(o, d, r, s)
    this.build()
  }

  /** World dt (the carves, rubble and dust live on the world clock) and real dt. */
  update(dt: number, rdt: number) {
    this.mountains.update(dt, rdt)
  }

  private build() {
    for (const s of this.spires) {
      this.root.remove(s.mesh, s.base)
      s.base.geometry.dispose()
    }
    this.spires = []
    for (const def of spireDefs()) {
      const mesh = new THREE.Mesh(spireGeometry(def), this.mat)
      mesh.position.set(def.x, 0, def.z)
      mesh.castShadow = true
      mesh.receiveShadow = true
      const base = new THREE.Mesh(spireBaseGeometry(def, 15), this.mat)
      base.position.copy(mesh.position)
      base.castShadow = true
      base.receiveShadow = true
      this.root.add(mesh, base)
      this.spires.push({
        def,
        mesh,
        base,
        hp: 220 + def.r * def.h * 4,
        alive: true,
        hitIds: new Set(),
        a: new THREE.Vector3(def.x, 0, def.z),
        b: new THREE.Vector3(def.x, def.h * 0.9, def.z),
      })
    }
  }

  reset() {
    this.build()
    this.mountains.reset()
  }

  /** Collision circles for the hero and the legions. */
  obstacles(out: Array<{ x: number; z: number; r: number; h: number }>) {
    for (const s of this.spires) if (s.alive) out.push({ x: s.def.x, z: s.def.z, r: s.def.r * 0.95, h: s.def.h })
    return out
  }

  damage(shape: Shape, hit: Hit): number {
    if (!hit.friendly && hit.kind !== 'blast' && hit.kind !== 'beam') return 0
    let n = 0
    for (const s of this.spires) {
      if (!s.alive || s.hitIds.has(hit.id)) continue
      if (!shapeHitsCapsule(shape, s.a, s.b, s.def.r)) continue
      s.hitIds.add(hit.id)
      if (s.hitIds.size > 30) s.hitIds.clear()
      n++
      s.hp -= hit.dmg
      if (s.hp <= 0) this.destroy(s, hit)
      else this.game.fx.spark(new THREE.Vector3(s.def.x, Math.min(s.def.h * 0.5, 2), s.def.z), null, 6, 6, [1, 0.6, 0.3])
    }
    return n
  }

  private destroy(s: Spire, hit: Hit) {
    const g = this.game
    s.alive = false
    const top = new THREE.Vector3(s.def.x, s.def.h * 0.6, s.def.z)
    if (hit.plane) {
      g.slicer.slice([s.mesh], hit.plane, {
        topple: true,
        staticBelow: true,
        separate: 0.6,
        life: 16,
        glow: 0.8,
        onCrash: (p, size) => {
          g.fx.dust(p.setY(1), 10, size * 0.4, size * 0.5)
          g.fx.debris.burst(p.setY(1), 18, size * 0.5, 0.4, 0)
          g.cam.addTrauma(Math.min(0.5, size * 0.02))
          audio.landing(Math.min(3, size * 0.1))
        },
      })
      audio.cut(top, true)
    } else {
      s.mesh.visible = false
      s.base.visible = false
      g.fx.debris.burst(top, 30, 10, 0.5, 0.2)
      g.fx.dust(top.setY(2), 12, s.def.r, s.def.r * 1.5)
    }
    g.score.kill('spire', 1, top)
  }
}
