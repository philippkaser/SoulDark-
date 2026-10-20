import * as THREE from 'three'
import { audio, type LoopHandle } from '../../audio/audio'
import { standard } from '../../engine/gfx/materials'
import { emberCrackTexture } from '../../engine/gfx/textures'
import { distPointSegment, shapeHitsSphere, type Shape } from '../../engine/geom'
import { clamp } from '../../engine/math'
import { useUI } from '../../state/store'
import type { Game, System } from '../Game'
import { ringMaterial } from '../fx/shaders'
import type { KillKind } from '../score'
import { newHitId, type ReflectTarget, type Threat, type Tier } from '../types'

export type ProjKind = 'shell' | 'missile' | 'nuke' | 'meteor'

interface Spec {
  tier: Tier
  radius: number
  dmg: number
  blast: number
  boom: number
  returnSpeed: number
  kill: KillKind
}

const SPECS: Record<ProjKind, Spec> = {
  shell: { tier: 'medium', radius: 0.5, dmg: 90, blast: 7, boom: 4, returnSpeed: 150, kill: 'shell' },
  missile: { tier: 'medium', radius: 0.5, dmg: 110, blast: 7, boom: 4.5, returnSpeed: 140, kill: 'missile' },
  nuke: { tier: 'cosmic', radius: 1.2, dmg: 600, blast: 90, boom: 30, returnSpeed: 240, kill: 'warhead' },
  meteor: { tier: 'large', radius: 3, dmg: 260, blast: 14, boom: 9, returnSpeed: 200, kill: 'meteor' },
}

export interface Proj {
  kind: ProjKind
  spec: Spec
  mesh: THREE.Object3D
  pos: THREE.Vector3
  prev: THREE.Vector3
  vel: THREE.Vector3
  alive: boolean
  reflected: boolean
  owner: ReflectTarget | null
  target: ReflectTarget | null
  /** Aimed at the hero (parryable) or just bombarding. */
  aimed: boolean
  homing: number
  life: number
  t: number
  phase: number
  size: number
  deflected: boolean
  spin: THREE.Vector3
}

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _q = new THREE.Quaternion()
const Z = new THREE.Vector3(0, 0, 1)

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------

function shellMesh() {
  const g = new THREE.Group()
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), standard({ color: '#1c1410', metalness: 0.8, roughness: 0.5, emissive: '#ff3a0a', emissiveIntensity: 1.6, rim: 0.6, rimColor: '#ff8040' }))
  g.add(ball)
  return g
}

function missileMesh(scale: number, nuke: boolean) {
  const g = new THREE.Group()
  const L = nuke ? 6.5 : 2.4
  const R = nuke ? 0.62 : 0.2
  const bodyMat = standard({ color: nuke ? '#d9d6cc' : '#3a3836', metalness: 0.6, roughness: 0.45, rim: 0.4, rimColor: '#ffb070' })
  const dark = standard({ color: '#151515', metalness: 0.7, roughness: 0.5 })
  const red = standard({ color: '#9a1010', roughness: 0.6, emissive: nuke ? '#ff2010' : '#000000', emissiveIntensity: 0.6 })
  const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L, 16).rotateX(Math.PI / 2), bodyMat)
  g.add(body)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(R, L * 0.28, 16).rotateX(Math.PI / 2).translate(0, 0, L / 2 + L * 0.14), nuke ? dark : bodyMat)
  g.add(nose)
  if (nuke) {
    for (const z of [-L * 0.2, L * 0.15]) g.add(new THREE.Mesh(new THREE.CylinderGeometry(R * 1.01, R * 1.01, L * 0.08, 16).rotateX(Math.PI / 2).translate(0, 0, z), z < 0 ? red : dark))
  }
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(R * 0.12, R * 2.6, L * 0.2), dark)
    fin.position.z = -L / 2 + L * 0.1
    fin.rotation.z = (i / 4) * Math.PI
    fin.position.x = 0
    g.add(fin)
  }
  // exhaust
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(R * 0.9, L * (nuke ? 0.9 : 0.8), 12, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -L / 2 - L * 0.4),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.2, 0.8), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  )
  flame.name = 'flame'
  g.add(flame)
  g.scale.setScalar(scale)
  g.traverse((o) => (o.castShadow = true))
  return g
}

function meteorMesh() {
  const geo = new THREE.IcosahedronGeometry(1, 3)
  const pos = geo.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i)
    const n = Math.sin(_v.x * 4.1) * Math.sin(_v.y * 3.7) * Math.sin(_v.z * 4.3)
    _v.multiplyScalar(1 + n * 0.18 + (Math.random() - 0.5) * 0.06)
    pos.setXYZ(i, _v.x, _v.y, _v.z)
  }
  geo.computeVertexNormals()
  const mat = standard({ color: '#2a1a14', roughness: 0.9, emissive: '#ff4a10', emissiveMap: emberCrackTexture(), emissiveIntensity: 4, rim: 0.8, rimColor: '#ff7030' })
  const m = new THREE.Mesh(geo, mat)
  m.castShadow = true
  return m
}

// ---------------------------------------------------------------------------

interface Shock {
  c: THREE.Vector3
  r: number
  speed: number
  max: number
  id: number
  mesh: THREE.Mesh
  reachedPlayer: boolean
  friendly: boolean
}

/**
 * Everything the enemy throws: artillery shells, missiles, warheads, meteors.
 * All of it can be parried back at whoever is under the crosshair (or the
 * sender), blocked, dodged, or cut out of the sky.
 */
export class Projectiles implements System {
  readonly root = new THREE.Group()
  private list: Proj[] = []
  private game: Game
  private shocks: Shock[] = []
  private siren: LoopHandle | null = null
  /** Called when a returned warhead is on its way home. */
  onWarheadReturned?: (p: Proj) => void
  onWarheadNeutralized?: (how: 'returned' | 'cut' | 'blocked' | 'hit') => void

  constructor(game: Game) {
    this.game = game
  }

  reset() {
    for (const p of this.list) this.root.remove(p.mesh)
    this.list = []
    for (const s of this.shocks) this.root.remove(s.mesh)
    this.shocks = []
    this.siren?.stop(0.2)
    this.siren = null
  }

  get active(): readonly Proj[] {
    return this.list
  }

  private make(kind: ProjKind, from: THREE.Vector3, vel: THREE.Vector3, owner: ReflectTarget | null, aimed: boolean, size = 1): Proj {
    const mesh = kind === 'shell' ? shellMesh() : kind === 'meteor' ? meteorMesh() : missileMesh(kind === 'nuke' ? 1 : 1, kind === 'nuke')
    if (kind === 'meteor') mesh.scale.setScalar(size)
    mesh.position.copy(from)
    this.root.add(mesh)
    const spec = kind === 'meteor' ? { ...SPECS.meteor, radius: size * 0.9, blast: size * 3.2, boom: size * 1.8 } : SPECS[kind]
    const p: Proj = {
      kind,
      spec,
      mesh,
      pos: from.clone(),
      prev: from.clone(),
      vel: vel.clone(),
      alive: true,
      reflected: false,
      owner,
      target: null,
      aimed,
      homing: 0,
      life: kind === 'nuke' ? 30 : 14,
      t: 0,
      phase: 0,
      size,
      deflected: false,
      spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2),
    }
    this.list.push(p)
    return p
  }

  /** An artillery shell lobbed at the hero. */
  fireShell(from: THREE.Vector3, owner: ReflectTarget | null) {
    const pl = this.game.player
    const d = from.distanceTo(pl.pos)
    const T = 2.6 + d / 140
    const tgt = _v.copy(pl.pos).addScaledVector(pl.vel, T * 0.4).setY(1.3)
    const g = 22
    const vel = new THREE.Vector3((tgt.x - from.x) / T, (tgt.y - from.y) / T + 0.5 * g * T, (tgt.z - from.z) / T)
    audio.cannon(from)
    return this.make('shell', from, vel, owner, true)
  }

  /** A homing missile from a launcher or airship. */
  fireMissile(from: THREE.Vector3, owner: ReflectTarget | null, up = 1) {
    const vel = new THREE.Vector3((Math.random() - 0.5) * 18, 18 * up + Math.random() * 10, (Math.random() - 0.5) * 18)
    const p = this.make('missile', from, vel, owner, true)
    p.homing = 0
    audio.missileLaunch(from)
    return p
  }

  /** A nuclear warhead from a silo. */
  launchNuke(from: THREE.Vector3, owner: ReflectTarget | null) {
    const p = this.make('nuke', from, new THREE.Vector3(0, 10, 0), owner, true)
    p.phase = 0
    audio.nukeLaunch(from)
    if (!this.siren) this.siren = audio.siren()
    useUI.getState().showBanner({ kind: 'warning', title: 'NUCLEAR LAUNCH DETECTED', sub: 'Parry it. Send it home.' })
    this.game.fx.flare(from.clone().setY(from.y + 10), 120, '#fff0d0', 0.8)
    this.game.fx.smokeColumn(from.clone(), 30, 25, 20, 1.5, 0.3)
    return p
  }

  /** A meteor called down from the sky. */
  meteor(from: THREE.Vector3, to: THREE.Vector3, size: number, speed: number, owner: ReflectTarget | null, aimed: boolean) {
    const vel = _v.subVectors(to, from).normalize().multiplyScalar(speed).clone()
    const p = this.make('meteor', from, vel, owner, aimed, size)
    audio.meteor(to)
    return p
  }

  // -------------------------------------------------------------------------

  /** Blades cut projectiles out of the air. */
  cut(shape: Shape) {
    for (const p of this.list) {
      if (!p.alive || p.reflected) continue
      if (!shapeHitsSphere(shape, p.pos.x, p.pos.y, p.pos.z, p.spec.radius + 0.5)) continue
      const g = this.game
      audio.cut(p.pos, p.kind !== 'shell')
      g.fx.impact(p.pos, null, 2, '#ffe0a0')
      if (p.kind === 'nuke') {
        // bisected: the halves tumble out of the sky, harmless
        g.fx.spark(p.pos, null, 80, 20)
        g.fx.debris.burst(p.pos, 10, 10, 0.6, 1)
        g.score.kill('warhead', 1, p.pos)
        g.score.log('WARHEAD BISECTED', 0, true)
        useUI.getState().stamp('BISECTED', 'divine')
        this.onWarheadNeutralized?.('cut')
        this.remove(p)
      } else if (p.kind === 'meteor') {
        g.fx.explosion(p.pos, p.spec.boom * 0.6, { scorch: false })
        g.fx.debris.burst(p.pos, 30, 18, p.size * 0.3, 1)
        g.score.kill('meteor', 1, p.pos)
        this.remove(p)
      } else {
        g.fx.explosion(p.pos, 2.5, { scorch: false })
        g.score.kill(p.spec.kill, 1, p.pos)
        this.remove(p)
      }
    }
  }

  threats(out: Threat[]) {
    const chest = this.game.player.chestPos(_w)
    for (const p of this.list) {
      if (!p.alive || p.reflected || !p.aimed || p.deflected) continue
      const d = p.pos.distanceTo(chest) - (p.spec.radius + 1.8)
      const sp = Math.max(1, p.vel.length())
      // nukes in their climb are still "incoming"
      const eta = p.kind === 'nuke' && p.phase < 2 ? 3 + d / 120 : d / sp
      out.push({ pos: p.pos.clone(), eta, tier: p.spec.tier, label: p.kind === 'nuke' ? 'WARHEAD' : p.kind === 'meteor' ? 'METEOR' : undefined })
    }
  }

  private remove(p: Proj) {
    p.alive = false
    this.root.remove(p.mesh)
  }

  /** Blow it up. `byHero` explosions don't hurt the hero. */
  private detonate(p: Proj, at: THREE.Vector3, byHero: boolean) {
    const g = this.game
    this.remove(p)
    if (p.kind === 'nuke') {
      this.nukeBlast(at, byHero)
      return
    }
    g.fx.explosion(at, p.spec.boom)
    g.damage({ t: 'sphere', c: at, r: p.spec.blast }, { id: newHitId(), kind: 'blast', dmg: 300, power: 26, origin: at, friendly: byHero })
    if (!byHero) {
      const d = at.distanceTo(g.player.pos)
      if (d < p.spec.blast && !g.player.untouchable) g.player.hurt(p.spec.dmg * clamp(1 - d / p.spec.blast, 0.2, 1) * 0.5, at, 8)
    }
  }

  private nukeBlast(at: THREE.Vector3, byHero: boolean) {
    const g = this.game
    const far = at.distanceTo(g.player.pos) > 200
    const scale = far ? 1 : 0.45
    g.fx.nuke(at.clone().setY(Math.max(0, at.y - 10)), scale)
    g.post.flashTo(far ? 1 : 1.2, '#fff8ec', far ? 0.9 : 0.6)
    g.post.impactFrames([1, 2, 1, 2, 1, 0], 1 / 18)
    g.cam.addTrauma(far ? 0.4 : 1.2)
    audio.nukeFlash()
    g.damage({ t: 'sphere', c: at, r: 60 * scale + 20 }, { id: newHitId(), kind: 'blast', dmg: 20000, power: 60, origin: at, friendly: byHero || far })
    // the shockwave crosses the plain
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ringMaterial())
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(at.x, 0.3, at.z)
    mesh.renderOrder = 9
    ;(mesh.material as THREE.ShaderMaterial).uniforms.uColor.value.set('#ffd8a8')
    ;(mesh.material as THREE.ShaderMaterial).uniforms.uThick.value = 0.04
    this.root.add(mesh)
    this.shocks.push({ c: at.clone().setY(0), r: 10, speed: far ? 165 : 120, max: far ? 1100 : 400, id: newHitId(), mesh, reachedPlayer: false, friendly: true })
    if (!far && !byHero && !g.player.untouchable) g.player.hurt(g.player.guarding ? 220 : 600, at, 30)
  }

  // -------------------------------------------------------------------------

  private reflect(p: Proj) {
    const g = this.game
    p.reflected = true
    p.target = g.pickReflectTarget(p.owner)
    p.life = 8
    const speed = p.spec.returnSpeed
    if (p.target) p.target.aim(_v)
    else _v.copy(g.cam.aimPoint)
    p.vel.subVectors(_v, p.pos).normalize().multiplyScalar(speed)
    // a small kick upward reads better than a dead-straight line
    p.vel.y += speed * 0.08
    if (p.kind === 'nuke') {
      p.life = 20
      this.siren?.stop(1)
      this.siren = null
      useUI.getState().stamp('RETURN TO SENDER', 'divine')
      useUI.getState().clearBanner()
      this.onWarheadReturned?.(p)
      this.nukeCinematic(p)
    } else {
      useUI.getState().stamp(p.kind === 'meteor' ? 'RETURNED' : 'PARRY', p.kind === 'meteor' ? 'perfect' : 'parry')
    }
  }

  private nukeCinematic(p: Proj) {
    const g = this.game
    const pl = g.player
    const start = pl.pos.clone()
    const back = _v.subVectors(start, p.pos).setY(0).normalize().clone()
    let boomAt = -1
    const boomPos = new THREE.Vector3()
    g.ceasefire = true
    pl.state = 'cine'
    pl.cineClip = 'victory'
    pl.cineT = 0
    g.cam.play({
      dur: 12,
      blendIn: 0.6,
      blendOut: 1.4,
      frame: (t, pos, look) => {
        pl.cineT = t
        const live = p.alive
        if (!live && boomAt < 0) {
          boomAt = t
          boomPos.copy(p.pos)
        }
        const k = Math.min(1, t / 2.5)
        pos.copy(start).addScaledVector(back, 8 + k * 10).setY(3 + k * 7)
        if (live) look.copy(p.pos)
        else look.copy(boomPos).setY(boomPos.y + 120 + (t - boomAt) * 12)
        // done: the cloud is up and the shock has passed
        if (boomAt >= 0 && t - boomAt > 7.5) {
          g.cam.stopShot()
          g.ceasefire = false
          if (pl.state === 'cine') pl.state = 'free'
        }
        return live ? 50 - k * 12 : 46
      },
    })
  }

  update(dt: number) {
    const g = this.game
    const pl = g.player
    const chest = pl.chestPos(new THREE.Vector3())
    for (const p of this.list) {
      if (!p.alive) continue
      p.t += dt
      p.life -= dt
      p.prev.copy(p.pos)
      const spec = p.spec
      if (!p.reflected) this.steerIncoming(p, dt, chest)
      else this.steerReturn(p, dt)
      p.pos.addScaledVector(p.vel, dt)
      // orientation + spin
      if (p.kind === 'meteor') {
        p.mesh.rotation.x += p.spin.x * dt
        p.mesh.rotation.y += p.spin.y * dt
      } else if (p.vel.lengthSq() > 1e-3) {
        _q.setFromUnitVectors(Z, _v.copy(p.vel).normalize())
        p.mesh.quaternion.copy(_q)
        if (p.kind === 'shell') p.mesh.rotation.z += dt * 10
      }
      p.mesh.position.copy(p.pos)
      this.trail(p, dt)

      if (p.life <= 0) {
        this.detonate(p, p.pos, p.reflected)
        continue
      }
      // arrival at the hero
      if (!p.reflected && !p.deflected && p.aimed) {
        const reach = spec.radius + 1.8
        const d = distPointSegment(chest.x, chest.y, chest.z, p.prev.x, p.prev.y, p.prev.z, p.pos.x, p.pos.y, p.pos.z)
        if (d < reach) {
          this.contact(p, chest)
          continue
        }
      }
      // the ground
      if (p.pos.y <= spec.radius * 0.5 && !(p.kind === 'nuke' && p.phase < 2)) {
        _v.copy(p.pos).setY(0.5)
        this.detonate(p, _v, p.reflected)
      }
    }
    this.list = this.list.filter((p) => p.alive)
    if (this.siren && !this.list.some((p) => p.kind === 'nuke' && !p.reflected)) {
      this.siren.stop(1.5)
      this.siren = null
    }
    this.updateShocks(dt)
  }

  private contact(p: Proj, chest: THREE.Vector3) {
    const g = this.game
    const pl = g.player
    if (pl.untouchable) {
      // flash-stepped through: it sails past
      p.aimed = false
      return
    }
    const r = pl.defend(p.spec.tier, p.pos)
    if (r === 'perfect') {
      this.reflect(p)
      return
    }
    if (r === 'guard') {
      p.deflected = true
      if (p.kind === 'nuke') {
        // held back by the blade: it detonates just ahead of the hero
        _v.subVectors(p.pos, chest).normalize().multiplyScalar(26).add(chest)
        this.onWarheadNeutralized?.('blocked')
        this.detonate(p, _v, false)
        return
      }
      if (p.kind === 'meteor') {
        this.detonate(p, _v.copy(p.pos), true)
        pl.hurt(p.spec.dmg * 0.25, p.pos, 10)
        return
      }
      // batted away: it bursts in the air
      p.vel.reflect(_v.subVectors(p.pos, chest).normalize()).multiplyScalar(0.6)
      p.vel.y = Math.abs(p.vel.y) + 12
      p.life = 0.7
      pl.hurt(p.spec.dmg * 0.08, p.pos)
      return
    }
    // it lands
    if (p.kind === 'nuke') {
      this.onWarheadNeutralized?.('hit')
      this.detonate(p, chest.clone(), false)
      return
    }
    pl.hurt(p.spec.dmg, p.pos, p.kind === 'meteor' ? 18 : 10)
    this.detonate(p, _v.copy(p.pos), true)
  }

  private steerIncoming(p: Proj, dt: number, chest: THREE.Vector3) {
    const pl = this.game.player
    if (p.kind === 'shell') {
      p.vel.y -= 22 * dt
      // fuse toward the hero in the last stretch so a parry can always meet it
      const d = p.pos.distanceTo(chest)
      if (d < 35 && p.aimed) {
        _v.subVectors(chest, p.pos).normalize().multiplyScalar(p.vel.length())
        p.vel.lerp(_v, Math.min(1, dt * 3))
      }
    } else if (p.kind === 'missile') {
      p.homing = Math.min(3.2, p.homing + dt * 1.6)
      const sp = Math.min(72, p.vel.length() + dt * 40)
      _v.subVectors(chest, p.pos)
      // wobble for character
      _v.x += Math.sin(p.t * 5 + p.spin.x * 10) * 3
      _v.y += Math.cos(p.t * 4) * 2
      _v.normalize().multiplyScalar(sp)
      p.vel.lerp(_v, Math.min(1, dt * p.homing)).setLength(sp)
    } else if (p.kind === 'nuke') {
      const target = _w.copy(pl.pos).setY(1.3)
      if (p.phase === 0) {
        // climb out of the silo
        p.vel.y = Math.min(140, p.vel.y + dt * 60)
        if (p.pos.y > 260) p.phase = 1
      } else if (p.phase === 1) {
        // arc over toward the hero
        _v.subVectors(target, p.pos).setY(0)
        const hd = _v.length()
        _v.normalize().multiplyScalar(170)
        _v.y = hd < 300 ? -60 : 0
        p.vel.lerp(_v, Math.min(1, dt * 0.9))
        if (hd < 260) p.phase = 2
      } else {
        // terminal dive, tracking
        _v.subVectors(target, p.pos).normalize().multiplyScalar(150)
        p.vel.lerp(_v, Math.min(1, dt * 2.5))
      }
    } else if (p.kind === 'meteor') {
      if (p.aimed) {
        _v.subVectors(chest, p.pos).normalize().multiplyScalar(p.vel.length())
        p.vel.lerp(_v, Math.min(1, dt * 0.6))
      }
    }
  }

  private steerReturn(p: Proj, dt: number) {
    const t = p.target
    if (t && t.alive) {
      t.aim(_v)
      const sp = Math.max(p.vel.length(), p.spec.returnSpeed)
      _w.subVectors(_v, p.pos)
      const d = _w.length()
      if (d < t.radius + sp * dt + 1) {
        p.pos.copy(_v)
        t.struck(p.kind === 'nuke' ? 99999 : p.kind === 'meteor' ? 900 : 600, _v, p.kind)
        this.game.score.kill(p.spec.kill, 1, _v)
        this.game.player.gainDivinity(4)
        this.detonate(p, _v.clone(), true)
        return
      }
      _w.normalize().multiplyScalar(sp)
      p.vel.lerp(_w, Math.min(1, dt * 4))
    } else if (p.kind !== 'nuke') {
      p.vel.y -= 6 * dt
    }
    // returned weapons cut through the ranks on the way home
    if (p.pos.y < 4) this.game.damage({ t: 'sphere', c: p.pos, r: 2.5 }, { id: newHitId(), kind: 'reflect', dmg: 200, power: 20, origin: p.pos, dir: p.vel.clone().normalize(), friendly: true })
  }

  private trail(p: Proj, dt: number) {
    const fx = this.game.fx
    const gold = p.reflected
    const n = Math.max(1, Math.round(dt * (p.kind === 'nuke' ? 90 : p.kind === 'meteor' ? 70 : 40)))
    for (let i = 0; i < n; i++) {
      _v.lerpVectors(p.prev, p.pos, i / n)
      if (p.kind === 'meteor') {
        fx.fire.spawn(_v, _w.set((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3), [1, 0.5, 0.15], 0.8, p.size * (1 + Math.random()), 0.5, -1, 2, { grow: 1 })
        fx.smoke.spawn(_v, _w.set(0, 1, 0), [0.1, 0.08, 0.07], 0.6, p.size * 1.6, 3, -0.3, 0.5, { grow: 2, heat: 1.2, cool: 0.8 })
      } else {
        const big = p.kind === 'nuke'
        const g = gold ? [0.6, 0.5, 0.3] : [0.3, 0.29, 0.28]
        fx.smoke.spawn(_v, _w.set((Math.random() - 0.5) * 0.6, 0.6, (Math.random() - 0.5) * 0.6), g as [number, number, number], big ? 0.7 : 0.5, big ? 2.4 : 0.7, big ? 6 : 2.2, -0.15, 0.4, { grow: big ? 3 : 2.5, heat: p.kind === 'shell' ? 0.3 : 0.8, cool: 2 })
        if (gold || p.kind !== 'shell') fx.glow.spawn(_v, _w.set(0, 0, 0), gold ? [1, 0.85, 0.5] : [1, 0.55, 0.2], 0.9, big ? 0.9 : 0.25, 0.15, 0, 0)
      }
    }
    const flame = p.mesh.getObjectByName('flame') as THREE.Mesh | undefined
    if (flame) flame.scale.setScalar(0.8 + Math.random() * 0.4)
  }

  private updateShocks(dt: number) {
    const g = this.game
    const pl = g.player
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i]
      const r0 = s.r
      s.r += s.speed * dt
      s.mesh.scale.setScalar(s.r)
      const k = s.r / s.max
      const mat = s.mesh.material as THREE.ShaderMaterial
      mat.uniforms.uAlpha.value = (1 - k) * 2
      mat.uniforms.uTime.value += dt
      // the wall of dust and everything in its path is thrown
      g.damage({ t: 'ring', c: s.c, r0, r1: s.r, h: 40 }, { id: s.id, kind: 'blast', dmg: 2000, power: 38 * (1 - k * 0.6), origin: s.c, friendly: s.friendly })
      const nd = Math.round(dt * 260 * g.q)
      for (let j = 0; j < nd; j++) {
        const a = Math.random() * Math.PI * 2
        _v.set(s.c.x + Math.sin(a) * s.r, 2 + Math.random() * 10, s.c.z + Math.cos(a) * s.r)
        if (_v.distanceTo(pl.pos) > 500) continue
        _w.set(Math.sin(a) * s.speed * 0.25, 4 + Math.random() * 6, Math.cos(a) * s.speed * 0.25)
        g.fx.smoke.spawn(_v, _w, [0.42, 0.36, 0.32], 0.55, 10 + Math.random() * 12, 2.4, -0.4, 1.2, { grow: 1.5, heat: 0.3, cool: 0.5 })
      }
      const dp = Math.hypot(pl.pos.x - s.c.x, pl.pos.z - s.c.z)
      if (!s.reachedPlayer && s.r >= dp) {
        s.reachedPlayer = true
        audio.nukeShock()
        g.cam.addTrauma(1.1)
        g.gust(s.c, 14)
        g.post.shock(_v.copy(pl.pos).setY(1.5), g.camera, 0.05)
        g.post.kickChroma(1.5)
        useUI.getState().stamp('THE SHOCKWAVE BREAKS ON YOU', 'feat')
      }
      if (s.r >= s.max) {
        this.root.remove(s.mesh)
        ;(s.mesh.material as THREE.Material).dispose()
        this.shocks.splice(i, 1)
      }
    }
  }
}

