import * as THREE from 'three'
import { audio, type LoopHandle } from '../../audio/audio'
import { useUI } from '../../state/store'
import type { Game } from '../Game'
import { beamGeometry, beamMaterial, ringMaterial } from '../fx/shaders'
import { newHitId, type Threat } from '../types'

export type BeamPhase = 'idle' | 'target' | 'fire' | 'reflect'

export interface BeamOpts {
  color: string
  coreColor?: string
  radius: number
  /** Where the beam comes from. */
  source: (out: THREE.Vector3) => THREE.Vector3
  /** The source is hit by its own beam (reflected or redirected). */
  onSourceHit: (dps: number, dt: number, reflected: boolean) => void
  /** Aim radius around the source for redirected beams. */
  sourceRadius: number
  /** Damage per second to the hero standing in it. */
  dps: number
  label: string
}

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _q = new THREE.Quaternion()
const UP = new THREE.Vector3(0, 1, 0)

/**
 * A beam weapon fired from the sky at the hero. Stand in it and burn; parry
 * it at the right moment and it goes home; hold the guard inside it and the
 * hero catches it on the blade and points it wherever they like.
 */
export class OrbitalBeam {
  readonly root = new THREE.Group()
  phase: BeamPhase = 'idle'
  t = 0
  readonly point = new THREE.Vector3()
  private game: Game
  private o: BeamOpts
  private beam: THREE.Mesh
  private glow: THREE.Mesh
  private guide: THREE.Mesh
  private out: THREE.Mesh
  private outGlow: THREE.Mesh
  private reticle: THREE.Mesh
  private mats: THREE.ShaderMaterial[] = []
  private sound: LoopHandle | null = null
  private catchSound: LoopHandle | null = null
  private scorchT = 0
  private tickT = 0
  catching = false
  private caughtFor = 0
  fireDur = 5.5

  constructor(game: Game, o: BeamOpts) {
    this.game = game
    this.o = o
    const geo = beamGeometry()
    const mk = (color: string, alpha: number) => {
      const m = beamMaterial(color)
      m.uniforms.uAlpha.value = alpha
      this.mats.push(m)
      const mesh = new THREE.Mesh(geo, m)
      mesh.frustumCulled = false
      mesh.visible = false
      mesh.renderOrder = 10
      this.root.add(mesh)
      return mesh
    }
    this.beam = mk(o.coreColor ?? o.color, 1)
    this.glow = mk(o.color, 0.5)
    this.guide = mk(o.color, 0.8)
    this.out = mk('#ffd890', 1)
    this.outGlow = mk('#ffb050', 0.5)
    const rm = ringMaterial()
    rm.uniforms.uColor.value.set(o.color)
    rm.uniforms.uThick.value = 0.08
    this.reticle = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), rm)
    this.reticle.rotation.x = -Math.PI / 2
    this.reticle.visible = false
    this.reticle.renderOrder = 9
    this.root.add(this.reticle)
  }

  get busy() {
    return this.phase !== 'idle'
  }

  reset() {
    this.stop()
  }

  /** Lock on and fire. */
  begin() {
    if (this.phase !== 'idle') return
    const p = this.game.player.pos
    this.phase = 'target'
    this.t = 0
    this.point.set(p.x + (Math.random() - 0.5) * 20, 0, p.z + (Math.random() - 0.5) * 20)
    audio.laserCharge(this.o.source(_v))
    useUI.getState().showBanner({ kind: 'warning', title: this.o.label, sub: 'Parry the beam, or hold your guard and take it' })
  }

  stop() {
    this.phase = 'idle'
    this.catching = false
    this.game.player.setCatching(false)
    for (const m of [this.beam, this.glow, this.guide, this.out, this.outGlow, this.reticle]) m.visible = false
    this.sound?.stop(0.3)
    this.sound = null
    this.catchSound?.stop(0.2)
    this.catchSound = null
  }

  threats(out: Threat[]) {
    if (this.phase === 'target') out.push({ pos: this.point.clone().setY(2), eta: 2.8 - this.t, tier: 'cosmic', label: 'BEAM' })
  }

  private place(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, r: number) {
    _w.subVectors(b, a)
    const len = _w.length()
    mesh.position.copy(a)
    _q.setFromUnitVectors(UP, _w.normalize())
    mesh.quaternion.copy(_q)
    mesh.scale.set(r, len, r)
    ;(mesh.material as THREE.ShaderMaterial).uniforms.uLen.value = len
    mesh.visible = true
  }

  update(dt: number, rdt: number) {
    if (this.phase === 'idle') return
    const g = this.game
    const pl = g.player
    this.t += dt
    for (const m of this.mats) m.uniforms.uTime.value += rdt
    const src = this.o.source(new THREE.Vector3())
    const R = this.o.radius

    if (this.phase === 'target') {
      // the guide laser drifts toward the hero
      _v.copy(pl.pos).setY(0).sub(this.point)
      const d = _v.length()
      if (d > 0.01) this.point.addScaledVector(_v.normalize(), Math.min(d, dt * 14))
      this.place(this.guide, src, this.point, 0.35)
      this.reticle.visible = true
      this.reticle.position.copy(this.point).setY(0.15)
      const k = this.t / 2.8
      this.reticle.scale.setScalar(R * (3 - k * 2))
      const rm = this.reticle.material as THREE.ShaderMaterial
      rm.uniforms.uAlpha.value = 1.5 + Math.sin(this.t * 30) * 0.5
      rm.uniforms.uTime.value += dt
      if (this.t >= 2.8) {
        this.phase = 'fire'
        this.t = 0
        this.guide.visible = false
        this.reticle.visible = false
        this.sound = audio.beam('red')
        g.fx.flare(this.point.clone().setY(2), 30, '#fff', 0.4)
        g.cam.addTrauma(0.5)
        g.post.flashTo(0.25, this.o.color, 4)
        g.sky.flash(_v.subVectors(src, g.camera.position).normalize(), 0.6, this.o.color)
      }
      return
    }

    if (this.phase === 'reflect') {
      // the beam runs back up its own path
      const k = Math.min(1, this.t / 0.5)
      const head = _v.lerpVectors(pl.chestPos(_w), src, k).clone()
      this.place(this.beam, pl.chestPos(_w).clone(), head, R * 0.7)
      this.place(this.glow, pl.chestPos(_w).clone(), head, R * 1.6)
      if (k >= 1 && this.t - dt < 0.5) this.o.onSourceHit(99999, 1, true)
      if (this.t > 1.2) this.stop()
      return
    }

    // firing: it sweeps after the hero
    _v.copy(pl.pos).setY(0).sub(this.point)
    const d = _v.length()
    if (!this.catching && d > 0.01) this.point.addScaledVector(_v.normalize(), Math.min(d, dt * 6.5))
    const inBeam = Math.hypot(pl.pos.x - this.point.x, pl.pos.z - this.point.z) < R + 0.6
    const blade = pl.chestPos(new THREE.Vector3()).setY(pl.pos.y + 2.2)
    let end = this.point
    if (inBeam && !pl.untouchable) {
      // first contact resolves like any threat; once caught, a parry sends it home
      const r = this.catching ? (pl.inPerfectWindow ? pl.defend('cosmic', src) : 'guard') : pl.defend('cosmic', src)
      if (r === 'perfect') {
        this.phase = 'reflect'
        this.t = 0
        this.catching = false
        pl.setCatching(false)
        this.catchSound?.stop(0.1)
        this.catchSound = null
        useUI.getState().stamp('BEAM RETURNED', 'divine')
        useUI.getState().clearBanner()
        return
      }
      if (pl.guarding || this.catching) {
        if (!this.catching) {
          this.catching = true
          pl.setCatching(true)
          this.catchSound = audio.beam('gold')
          useUI.getState().stamp('CAUGHT', 'perfect')
          g.score.feat('catch', 1)
        }
        end = blade
      } else {
        this.tickT -= dt
        if (this.tickT <= 0) {
          this.tickT = 0.15
          pl.hurt(this.o.dps * 0.15, this.point, 4)
        }
      }
    }
    if (this.catching && (!pl.guarding || !inBeam)) {
      this.catching = false
      pl.setCatching(false)
      this.catchSound?.stop(0.2)
      this.catchSound = null
    }

    this.place(this.beam, src, end, R * 0.55)
    this.place(this.glow, src, end, R * 1.4)
    this.sound?.set(1, end)

    // where it touches the world: melt, burn, vaporize
    if (!this.catching) {
      this.scorchT -= dt
      if (this.scorchT <= 0) {
        this.scorchT = 0.08
        g.scorch.crater(this.point.x, this.point.z, R * 1.1, 1)
        g.damage({ t: 'capsule', a: this.point.clone().setY(0), b: this.point.clone().setY(30), r: R }, { id: newHitId(), kind: 'beam', dmg: 1000, power: 10, origin: this.point.clone(), friendly: false })
      }
      g.fx.spark(_v.copy(this.point).setY(0.3), UP, 8, 22, [1, 0.6, 0.4])
      if (Math.random() < dt * 30) g.fx.smokeColumn(_v.copy(this.point).setY(1), 1, R, 10, 1.5, 0.1)
      g.fx.light(_v.copy(this.point).setY(4), this.o.color, 800, 50, 30)
      this.out.visible = false
      this.outGlow.visible = false
    } else {
      // the caught beam pours out of the blade along the hero's aim
      this.caughtFor += dt
      const dir = g.cam.aimDir.clone()
      const far = blade.clone().addScaledVector(dir, 700)
      // stop where it meets the ground
      if (dir.y < -0.01) {
        const tHit = -blade.y / dir.y
        if (tHit < 700) far.copy(blade).addScaledVector(dir, tHit)
      }
      this.place(this.out, blade, far, R * 0.5)
      this.place(this.outGlow, blade, far, R * 1.2)
      g.fx.spark(blade, null, 6, 12, [1, 0.85, 0.5])
      g.fx.light(blade, '#ffd890', 600, 30, 30)
      g.cam.addTrauma(dt * 1.2)
      this.tickT -= dt
      if (this.tickT <= 0) {
        this.tickT = 0.1
        g.damage({ t: 'capsule', a: blade, b: far, r: R * 0.9 }, { id: newHitId(), kind: 'beam', dmg: 2500, power: 18, origin: blade, dir, friendly: true })
        if (far.y < 1) {
          g.scorch.crater(far.x, far.z, R, 1)
          g.fx.explosion(far.clone().setY(1), 3, { sound: Math.random() < 0.3, debris: false })
        }
        pl.hurt(2, this.point)
      }
      // swept across its own source?
      this.o.source(_v)
      const along = _v.clone().sub(blade)
      const proj = along.dot(dir)
      if (proj > 0) {
        const miss = along.addScaledVector(dir, -proj).length()
        if (miss < this.o.sourceRadius) this.o.onSourceHit(1800, dt, false)
      }
    }
    if (this.t >= this.fireDur) this.stop()
  }
}
