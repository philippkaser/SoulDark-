import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { sdUniforms } from '../../engine/gfx/materials'
import { shapeHitsCapsule, type Shape } from '../../engine/geom'
import { angleDiff, clamp, turnToward } from '../../engine/math'
import { Avatar } from '../../engine/rig/avatar'
import { bakeSkinned } from '../../engine/rig/build'
import { useUI, type BossBar } from '../../state/store'
import type { Game, Obstacle, System } from '../Game'
import { newHitId, type Hit, type ReflectTarget, type Threat } from '../types'
import { buildTitan, type TitanModel } from './titanModel'

type Act = 'walk' | 'slam' | 'sweep' | 'stomp' | 'stagger' | 'roar' | 'death'

const MAX_HP = 14000
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

interface Titan extends ReflectTarget {
  model: TitanModel
  avatar: Avatar
  x: number
  z: number
  yaw: number
  speed: number
  act: Act
  t: number
  hp: number
  alive: boolean
  cooldown: number
  target: THREE.Vector3
  fired: boolean
  ring: number
  ringHit: boolean
  flash: number
  hitIds: Set<number>
  marker: THREE.Mesh
  dissolve: number
  capsules: Array<[THREE.Vector3, THREE.Vector3, number]>
}

function markerMesh() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uAlpha; uniform float uTime; varying vec2 vUv;
      void main(){ float x = abs(vUv.x - 0.5) * 2.0; float core = smoothstep(1.0, 0.0, x);
      float stripes = 0.6 + 0.4 * sin(vUv.y * 60.0 - uTime * 20.0);
      gl_FragColor = vec4(vec3(2.5, 0.3, 0.1) * core * stripes * uAlpha, core * uAlpha); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5), mat)
  m.renderOrder = 9
  m.visible = false
  return m
}

/** The Colossus: a walking mountain with a sword to match. */
export class Titans implements System {
  readonly root = new THREE.Group()
  private game: Game
  private list: Titan[] = []
  felled = 0

  constructor(game: Game) {
    this.game = game
  }

  reset() {
    for (const t of this.list) this.root.remove(t.model.container, t.marker)
    this.list = []
    this.felled = 0
  }

  get count() {
    return this.list.filter((t) => t.alive).length
  }

  spawn(x: number, z: number) {
    const model = buildTitan()
    const avatar = new Avatar(model)
    const marker = markerMesh()
    this.root.add(model.container, marker)
    const t: Titan = {
      model,
      avatar,
      x,
      z,
      yaw: Math.atan2(-x, -z),
      speed: 0,
      act: 'roar',
      t: 0,
      hp: MAX_HP,
      alive: true,
      cooldown: 3,
      target: new THREE.Vector3(),
      fired: false,
      ring: -1,
      ringHit: false,
      flash: 0,
      hitIds: new Set(),
      marker,
      dissolve: 0,
      capsules: [],
      radius: 8,
      aim: (out) => model.rig.chest.getWorldPosition(out),
      struck: (dmg, at) => this.hurt(t, dmg, at, null),
    }
    avatar.onStep = (_f, p) => this.footfall(t, p)
    this.list.push(t)
    audio.roar(_v.set(x, 20, z), 0.7)
    useUI.getState().showBanner({ kind: 'boss', title: 'THE COLOSSUS', sub: 'A mountain that learned to hate' })
    return t
  }

  private footfall(t: Titan, p: THREE.Vector3) {
    const g = this.game
    audio.titanStep(p)
    // a mountain walking leaves footprints (under whichever foot is planted)
    const fl = t.model.rig.footL.getWorldPosition(_a)
    const fr = t.model.rig.footR.getWorldPosition(_b)
    const foot = fl.y < fr.y ? fl : fr
    g.terrain.crater(foot.x, foot.z, 2.8, 0.45, { rim: 0.35, ejecta: 0.2 })
    g.fx.dust(_v.copy(p).setY(0.5), 6, 4, 5)
    g.fx.ring(_v.copy(p).setY(0.1), 14, '#ffb070', 0.5, { thick: 0.1, alpha: 0.6 })
    const d = p.distanceTo(g.player.pos)
    g.cam.addTrauma(clamp(0.5 - d / 120, 0, 0.35))
    // soldiers underfoot have a bad day
    g.damage({ t: 'sphere', c: p, r: 5 }, { id: newHitId(), kind: 'blast', dmg: 500, power: 14, origin: p, friendly: false })
  }

  obstacles(out: Obstacle[]) {
    for (const t of this.list) {
      if (!t.alive) continue
      t.model.rig.footL.getWorldPosition(_v)
      out.push({ x: _v.x, z: _v.z, r: 2.6, h: 12 })
      t.model.rig.footR.getWorldPosition(_v)
      out.push({ x: _v.x, z: _v.z, r: 2.6, h: 12 })
    }
  }

  reflectTargets(out: ReflectTarget[]) {
    for (const t of this.list) if (t.alive) out.push(t)
  }

  points(out: THREE.Vector3[]) {
    for (const t of this.list) if (t.alive) out.push(t.model.rig.chest.getWorldPosition(new THREE.Vector3()))
  }

  bosses(out: BossBar[]) {
    for (const t of this.list) if (t.alive) out.push({ id: 'titan', name: 'THE COLOSSUS', hp: t.hp, max: MAX_HP })
  }

  threats(out: Threat[]) {
    for (const t of this.list) {
      if (!t.alive) continue
      if (t.act === 'slam' && t.t < 1.97) out.push({ pos: _v.copy(t.target).setY(8).clone(), eta: 1.97 - t.t, tier: 'large', label: 'COLOSSUS' })
      if (t.act === 'sweep' && t.t < 1.55) out.push({ pos: new THREE.Vector3(t.x, 4, t.z), eta: 1.55 - t.t, tier: 'large', label: 'SWEEP' })
      if (t.act === 'stomp' && t.t < 1.12) out.push({ pos: new THREE.Vector3(t.x, 2, t.z), eta: 1.12 - t.t + 0.3, tier: 'medium', label: 'STOMP' })
    }
  }

  damage(shape: Shape, hit: Hit): number {
    if (!hit.friendly) return 0
    let n = 0
    for (const t of this.list) {
      if (!t.alive || t.hitIds.has(hit.id)) continue
      let touched = false
      for (const [a, b, r] of t.capsules) {
        if (shapeHitsCapsule(shape, a, b, r)) {
          touched = true
          _w.copy(a).lerp(b, 0.5)
          break
        }
      }
      if (!touched) continue
      t.hitIds.add(hit.id)
      if (t.hitIds.size > 50) t.hitIds.clear()
      n++
      this.hurt(t, hit.dmg, _w, hit)
    }
    return n
  }

  private hurt(t: Titan, dmg: number, at: THREE.Vector3, hit: Hit | null) {
    if (!t.alive) return
    const g = this.game
    const mult = t.act === 'stagger' ? 2.5 : 1
    t.hp -= dmg * mult
    t.flash = 1
    g.fx.impact(at, null, 3, '#ffb070')
    g.fx.embers(at, 20, 3, 3)
    if (dmg >= 1000) {
      g.cam.addTrauma(0.3)
      audio.cut(at, true)
    }
    if (t.hp <= 0) this.kill(t, hit)
  }

  private kill(t: Titan, hit: Hit | null) {
    const g = this.game
    t.alive = false
    t.marker.visible = false
    this.felled++
    g.score.kill('titan', 1, _v.set(t.x, 20, t.z))
    g.player.gainDivinity(30)
    audio.roar(_v.set(t.x, 20, t.z), 0.55)
    audio.musicSting('big')
    // a punch tears straight through: split down the line it travelled
    const punched = hit?.kind === 'punch'
    useUI.getState().stamp(punched ? 'COLOSSUS, PUNCHED THROUGH' : 'COLOSSUS CLEAVED', 'divine')
    g.time.slowmo(1.6, 0.35)
    g.post.flashTo(0.4, '#fff0d0', 2)
    g.post.impactFrames([2, 1, 2, 0], 1 / 16)
    const plane = punched && hit?.dir ? new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(hit.dir.z, 0.12, -hit.dir.x).normalize(), _v.set(t.x, 18, t.z)) : hit?.plane ?? new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(Math.cos(t.yaw), 0.15, -Math.sin(t.yaw)).normalize(), _v.set(t.x, 18, t.z))
    // freeze the pose into stone and cut it apart
    t.model.rig.root.updateMatrixWorld(true)
    const baked: THREE.Mesh[] = t.model.meshes.map((m) => {
      const mesh = new THREE.Mesh(bakeSkinned(m), m.material)
      mesh.castShadow = true
      return mesh
    })
    const holder = new THREE.Group()
    for (const m of baked) holder.add(m)
    this.root.add(holder)
    t.model.container.visible = false
    g.slicer.slice([holder], plane, {
      topple: true,
      gravity: 16,
      separate: 2.5,
      life: 22,
      glow: 1.6,
      onCrash: (p, size) => {
        g.terrain.crater(p.x, p.z, 10 + size * 0.25, 3.5, { ejecta: 1 })
        g.fx.explosion(p.setY(4), 16)
        g.fx.groundShock(p, size * 0.8)
        g.cam.addTrauma(0.9)
        audio.landing(4)
      },
    })
    this.root.remove(holder)
    g.fx.after(0.1, () => g.fx.explosion(_v.set(t.x, 26, t.z).clone(), 12))
  }

  update(dt: number) {
    const g = this.game
    const pl = g.player
    for (const t of this.list) {
      if (!t.alive) continue
      t.t += dt
      t.flash = Math.max(0, t.flash - dt * 4)
      const dx = pl.pos.x - t.x
      const dz = pl.pos.z - t.z
      const dist = Math.hypot(dx, dz)
      const face = Math.atan2(dx, dz)
      const hold = g.ceasefire || !pl.alive
      switch (t.act) {
        case 'roar':
          if (t.t > 0.8 && t.t - dt <= 0.8) {
            g.cam.addTrauma(0.5)
            g.fx.groundShock(_v.set(t.x, 0, t.z), 30, '#ff9a60', false)
          }
          if (t.t >= 3.2) this.setAct(t, 'walk')
          break
        case 'walk': {
          t.yaw = turnToward(t.yaw, face, dt * 0.7)
          const want = dist > 24 ? 5.5 : 0
          t.speed += (want - t.speed) * Math.min(1, dt * 1.5)
          t.x += Math.sin(t.yaw) * t.speed * dt
          t.z += Math.cos(t.yaw) * t.speed * dt
          t.cooldown -= dt
          if (!hold && t.cooldown <= 0 && Math.abs(angleDiff(t.yaw, face)) < 0.5) {
            if (dist < 13 && Math.random() < 0.6) this.setAct(t, 'stomp')
            else if (dist < 26) this.setAct(t, Math.random() < 0.55 ? 'slam' : 'sweep')
            else if (dist < 40) this.setAct(t, 'slam')
          }
          break
        }
        case 'slam':
          this.updateSlam(t, dt, face)
          break
        case 'sweep':
          this.updateSweep(t, dt, face)
          break
        case 'stomp':
          this.updateStomp(t, dt)
          break
        case 'stagger':
          if (t.t >= 5.2) this.setAct(t, 'walk')
          break
        case 'death':
          break
      }
      if (t.act !== 'walk') t.speed *= Math.exp(-dt * 4)
      // the ground ring from a stomp
      if (t.ring >= 0) {
        t.ring += dt * 48
        if (!t.ringHit && t.ring >= dist - 1) {
          t.ringHit = true
          if (pl.altitude < 1.2 && !pl.untouchable) {
            const r = pl.defend('medium', _v.set(t.x, 0, t.z))
            if (r === 'none') {
              pl.hurt(120, _v.set(t.x, 0, t.z), 16)
              pl.vel.y = 10
            } else if (r === 'guard') pl.hurt(20, _v.set(t.x, 0, t.z), 6)
          }
        }
        if (t.ring > 45) t.ring = -1
      }
      this.animate(t, dt)
    }
  }

  private setAct(t: Titan, act: Act) {
    t.act = act
    t.t = 0
    t.fired = false
    t.marker.visible = false
    if (act === 'walk') t.cooldown = 1.2 + Math.random() * 1.2
    if (act === 'slam' || act === 'sweep') audio.heavySwing(_v.set(t.x, 20, t.z))
  }

  private updateSlam(t: Titan, dt: number, face: number) {
    const g = this.game
    const pl = g.player
    // track the hero during the wind-up, then commit
    if (t.t < 1.45) {
      t.yaw = turnToward(t.yaw, face, dt * 1.2)
      t.target.copy(pl.pos).setY(0)
    }
    const fwdX = Math.sin(t.yaw)
    const fwdZ = Math.cos(t.yaw)
    // the blade lands along this line
    _a.set(t.x + fwdX * 6, 0.2, t.z + fwdZ * 6)
    const reach = clamp(Math.hypot(t.target.x - t.x, t.target.z - t.z) + 6, 18, 44)
    _b.set(t.x + fwdX * reach, 0.2, t.z + fwdZ * reach)
    if (t.t > 0.3 && t.t < 2.0) {
      t.marker.visible = true
      t.marker.position.copy(_a)
      t.marker.rotation.y = t.yaw
      t.marker.scale.set(3.2, 1, reach - 6)
      const m = t.marker.material as THREE.ShaderMaterial
      m.uniforms.uAlpha.value = clamp((t.t - 0.3) * 2, 0, 1) * (0.6 + 0.4 * Math.sin(t.t * 20))
      m.uniforms.uTime.value += dt
    } else t.marker.visible = false
    if (!t.fired && t.t >= 1.97) {
      t.fired = true
      const line: Shape = { t: 'capsule', a: _a.clone(), b: _b.clone(), r: 3.2 }
      g.scorch.fissure(_a.x, _a.z, _b.x, _b.z, 2.2, 0.9)
      g.terrain.trench(_a.x, _a.z, _b.x, _b.z, 6, 3)
      g.fx.groundShock(_b.clone(), 16, '#ff9a60')
      g.fx.explosion(_v.copy(_a).lerp(_b, 0.7).setY(1), 6, { scorch: false })
      g.cam.addTrauma(0.6)
      g.damage(line, { id: newHitId(), kind: 'blast', dmg: 800, power: 30, origin: _a.clone(), friendly: false })
      // does the blade meet the hero?
      const pd = Math.hypot(pl.pos.x - _a.x, pl.pos.z - _a.z)
      const onLine = shapeHitsCapsule(line, pl.pos, _v.copy(pl.pos).setY(pl.pos.y + 1.8), 0.5) && pd < reach + 2
      if (onLine && pl.altitude < 6) this.bladeMeetsHero(t, 260)
    }
    if (t.t >= 3.1) this.setAct(t, 'walk')
  }

  private updateSweep(t: Titan, dt: number, face: number) {
    const g = this.game
    const pl = g.player
    if (t.t < 1.2) t.yaw = turnToward(t.yaw, face, dt * 1.2)
    if (!t.fired && t.t >= 1.55) {
      t.fired = true
      const fwd = _w.set(Math.sin(t.yaw), 0, Math.cos(t.yaw)).clone()
      const c = new THREE.Vector3(t.x, 0, t.z)
      const arc: Shape = { t: 'sector', c, dir: fwd, range: 32, cos: Math.cos(1.2), y0: -1, y1: 4 }
      g.damage(arc, { id: newHitId(), kind: 'blast', dmg: 600, power: 34, origin: c, dir: new THREE.Vector3(-fwd.z, 0, fwd.x), friendly: false })
      g.fx.dust(_v.copy(c).addScaledVector(fwd, 18).setY(1), 18, 10, 4)
      g.cam.addTrauma(0.4)
      // leap over it, parry it, or flash-step through it
      const dist = Math.hypot(pl.pos.x - t.x, pl.pos.z - t.z)
      if (dist < 34 && pl.altitude < 3.5 && Math.abs(angleDiff(t.yaw, face)) < 1.25) this.bladeMeetsHero(t, 200)
    }
    if (t.t >= 2.5) this.setAct(t, 'walk')
  }

  private updateStomp(t: Titan, _dt: number) {
    const g = this.game
    if (!t.fired && t.t >= 1.12) {
      t.fired = true
      t.model.rig.footR.getWorldPosition(_v)
      g.terrain.crater(_v.x, _v.z, 8, 2.2, { rim: 0.3, ejecta: 1 })
      g.fx.groundShock(_v.clone().setY(0), 40, '#ffb070')
      g.fx.explosion(_v.clone().setY(1), 5, { scorch: false })
      g.cam.addTrauma(0.6)
      audio.landing(4)
      g.damage({ t: 'sphere', c: _v.clone(), r: 12 }, { id: newHitId(), kind: 'blast', dmg: 600, power: 28, origin: _v.clone(), friendly: false })
      t.ring = 0
      t.ringHit = false
    }
    if (t.t >= 1.9) this.setAct(t, 'walk')
  }

  /** The Colossus's blade arrives where the hero stands. */
  private bladeMeetsHero(t: Titan, dmg: number) {
    const g = this.game
    const pl = g.player
    if (pl.untouchable) return
    const from = t.model.rig.handR.getWorldPosition(new THREE.Vector3())
    const r = pl.defend('large', from)
    if (r === 'perfect') {
      // the hero stops a mountain's sword with one hand
      this.setAct(t, 'stagger')
      useUI.getState().stamp('THE COLOSSUS FALTERS', 'perfect')
      g.fx.groundShock(pl.pos.clone(), 26, '#fff0c0')
      g.scorch.crater(pl.pos.x, pl.pos.z, 9, 1)
      g.damage({ t: 'sphere', c: pl.pos.clone(), r: 14 }, { id: newHitId(), kind: 'parry', dmg: 400, power: 30, origin: pl.pos.clone(), friendly: true })
      this.hurt(t, 800, from, null)
      return
    }
    if (r === 'guard') {
      pl.hurt(dmg * 0.18, from, 14)
      g.scorch.crater(pl.pos.x, pl.pos.z, 6, 0.8)
      return
    }
    pl.hurt(dmg, from, 24)
  }

  private animate(t: Titan, dt: number) {
    const clip = t.act === 'walk' ? null : t.act
    t.avatar.update(dt, {
      x: t.x,
      // wades down into craters (never up onto rims, so its footfalls keep landing)
      y: Math.min(0.04, this.game.terrain.heightAt(t.x, t.z)),
      z: t.z,
      yaw: t.yaw,
      speed: t.speed,
      moveAngle: 0,
      turnRate: 0,
      action: clip,
      actionT: t.t,
      time: this.game.clock,
      trail: false,
      sharpness: 10,
      flash: t.flash,
    })
    // molten core pulses; brighter when staggered
    const pulse = 0.5 + 0.5 * Math.sin(this.game.clock * (t.act === 'stagger' ? 9 : 2.5))
    t.model.core.emissiveIntensity = 4 + pulse * (t.act === 'stagger' ? 10 : 4)
    const u = sdUniforms(t.model.ember)
    if (u) u.uFlash.value = t.flash
    // hit capsules from the skeleton
    const rig = t.model.rig
    const caps = t.capsules
    caps.length = 0
    const P = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3())
    caps.push([P(rig.footL), P(rig.hips), 3.2])
    caps.push([P(rig.footR), P(rig.hips), 3.2])
    caps.push([P(rig.hips), P(rig.neck), 5.5])
    caps.push([P(rig.neck), P(rig.head).add(new THREE.Vector3(0, 3, 0)), 3])
    caps.push([P(rig.shoulderL), P(rig.handL), 2.2])
    caps.push([P(rig.shoulderR), P(rig.handR), 2.2])
  }
}
