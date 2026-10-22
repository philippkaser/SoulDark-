import * as THREE from 'three'
import { audio, type LoopHandle } from '../../audio/audio'
import type { Shape } from '../../engine/geom'
import { angleDiff, clamp, smoothstep } from '../../engine/math'
import type { InputFrame } from '../../input/input'
import { useUI } from '../../state/store'
import type { Game, System } from '../Game'
import { FIRE, GOLD, WHITE_GOLD } from '../fx/particleFx'
import { PunchFx, sideOf } from '../fx/punchFx'
import { newHitId, type ReflectTarget } from '../types'
import { eclipsePoint, SUN_DIR } from '../world/layout'

/** When the jab lands (s into the move), its cooldown, reach and cone. */
export const JAB_HIT = 0.05
export const JAB_CD = 0.5
export const JAB_RANGE = 45
export const JAB_HALF = (30 * Math.PI) / 180
/** Holding the punch this long past the jab starts the Serious Punch's charge. */
export const HOLD_TO_CHARGE = 0.16
export const SERIOUS_CHARGE = 1.4
export const SERIOUS_COST = 50
export const SERIOUS_HIT = 0.05
/** The Serious Punch's pressure wave: speed (m/s), reach, cone half-angle and starting radius. */
export const WAVE_SPEED = 900
export const WAVE_RANGE = 3000
export const WAVE_HALF = (20 * Math.PI) / 180
export const WAVE_R0 = 8
/** The wave follows the aim upward, never down, at most this steep (rad). */
export const MAX_TILT = 0.6
/** A falling moon within this heading of the aim pulls the wave up onto it. */
export const MOON_ASSIST = (30 * Math.PI) / 180
/** Aim within this heading of the eclipse to hit it. */
export const ECLIPSE_AIM = (15 * Math.PI) / 180
const WAVE_TAN = Math.tan(WAVE_HALF)
const WAVE_SEC = 1 / Math.cos(WAVE_HALF)
const WAVE_DMG = 99999
/** Struck reflect targets (the Sol Lance, cannons, silos) and the eclipse. */
const TARGET_DMG = 6000
const ECLIPSE_DMG = 6000
/** The trench torn along the axis, and how far the ground spray runs. */
const TRENCH_LEN = 250
const SPRAY_LEN = 950
/** The visible tunnel of rings is far narrower than the kill zone, so it reads as a corridor running off to the horizon. */
const VIS_TAN = Math.tan((4.5 * Math.PI) / 180)
const VIS_R0 = 4

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _p = new THREE.Vector3()
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _s = new THREE.Vector3()
const _fist = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const DUST: readonly [number, number, number] = [0.34, 0.28, 0.24]

/**
 * The wave's heading: the aim's, tilted up with the aim (never down), at most
 * MAX_TILT. The follow camera cannot look up far, so upward aim counts for
 * more (`gain`), and a slight upward glance still punches level (`bias`); a
 * direction straight at a target passes gain 1, bias 0.
 */
export function waveDir(aim: THREE.Vector3, out: THREE.Vector3, gain = 1.8, bias = 0.04) {
  const l = Math.hypot(aim.x, aim.z)
  const fx = l > 1e-5 ? aim.x / l : 0
  const fz = l > 1e-5 ? aim.z / l : -1
  const tilt = clamp((Math.atan2(aim.y, Math.max(l, 1e-5)) - bias) * gain, 0, MAX_TILT)
  return out.set(fx * Math.cos(tilt), Math.sin(tilt), fz * Math.cos(tilt))
}

/** Radius of the wave's kill zone `d` metres down the axis. */
export const waveRadius = (d: number) => WAVE_R0 + Math.max(0, d) * WAVE_TAN

/**
 * Where along the axis a target at `p` (radius r) is swept by the wave, or -1
 * if the wave never touches it.
 */
export function waveReach(origin: THREE.Vector3, dir: THREE.Vector3, p: THREE.Vector3, r: number, range = WAVE_RANGE) {
  _a.subVectors(p, origin)
  const along = _a.dot(dir)
  if (along <= 0 || along - r > range) return -1
  const perp = Math.sqrt(Math.max(0, _a.lengthSq() - along * along))
  return perp <= waveRadius(along) + r * WAVE_SEC ? Math.max(0, along - r) : -1
}

/** Heading difference (rad) between two directions, ignoring height. */
export function headingGap(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.abs(angleDiff(Math.atan2(a.x, a.z), Math.atan2(b.x, b.z)))
}

/** Heading difference (rad) between a direction and the eclipse, ignoring height. */
export function eclipseHeading(dir: THREE.Vector3) {
  return headingGap(dir, SUN_DIR)
}

/** Spacing of the ring corridor: tight near the fist, sparse toward the horizon. */
export function ringGap(d: number) {
  return d < 400 ? 45 : d < 1200 ? 110 : 260
}

interface Strike {
  t: ReflectTarget
  d: number
}

/** One Serious Punch's pressure wave, out across the world. */
class Wave {
  on = false
  readonly origin = new THREE.Vector3()
  readonly dir = new THREE.Vector3()
  readonly flat = new THREE.Vector3()
  readonly side = new THREE.Vector3()
  /** Where the trench starts on the ground. */
  readonly foot = new THREE.Vector3()
  d = 0
  age = 0
  /** Next trench piece, ring and ground spray distances. */
  carved = 0
  ringAt = 0
  sprayAt = 0
  /** How far the ground is torn (0 when the wave left the ground). */
  ground = 0
  seed = 0
  mountain = -1
  eclipse = -1
  strikes: Strike[] = []
}

/**
 * The fist. A tap is a jab: a gunshot of air down the aim that flings
 * soldiers and swats projectiles. Held, the hero coils for the Serious Punch:
 * a pressure wave that tears a trench across the plain, bores the mountains
 * and splits the atmosphere. Hero-side moments run on the hero's clock
 * (Player calls them); the wave lives on the world's (it is a System).
 */
export class Punch implements System {
  readonly root = new THREE.Group()
  readonly fx = new PunchFx()
  private g: Game
  /** Jab cooldown (hero seconds). */
  cd = 0
  /** Serious charge 0..1. */
  charge = 0
  private charging = false
  private full = false
  private snd: LoopHandle | null = null
  private pulseT = 0
  private arcT = 0
  private waves = [new Wave(), new Wave()]
  /** The release cinematic: set by its frame callback, so a shot that replaced it is never skipped by us. */
  private shotLive = false
  private shotT = 0

  constructor(game: Game) {
    this.g = game
    this.root.add(this.fx.root)
  }

  get ready() {
    return this.cd <= 0
  }

  /** The extended fist: a little left of centre, shoulder high, an arm's length down the aim. */
  private fistAt(dir: THREE.Vector3, out: THREE.Vector3) {
    const p = this.g.player
    const fwd = _v.set(Math.sin(p.yaw), 0, Math.cos(p.yaw))
    sideOf(fwd, _w)
    return out.set(p.pos.x, p.pos.y + 1.42, p.pos.z).addScaledVector(dir, 0.7).addScaledVector(_w, -0.08)
  }

  /** The aim from the hero's chest, kept from burying itself at the feet. */
  private aim(out: THREE.Vector3) {
    const g = this.g
    const p = g.player
    p.chestPos(_p)
    out.subVectors(g.cam.aimPoint, _p)
    if (out.lengthSq() < 4) out.copy(g.cam.aimDir)
    out.normalize()
    out.y = clamp(out.y, -0.3, 0.6)
    return out.normalize()
  }

  // -------------------------------------------------------------------------
  // The jab
  // -------------------------------------------------------------------------

  /** The jab lands: a cone of pressure down the aim. */
  jab() {
    const g = this.g
    const p = g.player
    const dir = this.aim(new THREE.Vector3())
    const fwd = new THREE.Vector3(dir.x, 0, dir.z)
    if (fwd.lengthSq() < 1e-6) fwd.set(Math.sin(p.yaw), 0, Math.cos(p.yaw))
    fwd.normalize()
    const fist = this.fistAt(dir, new THREE.Vector3())
    // lethal to soldiers in the cone, heavy on anything big down the axis
    const sector: Shape = { t: 'sector', c: p.pos, dir: fwd, range: JAB_RANGE, cos: Math.cos(JAB_HALF), y0: p.pos.y - 3, y1: p.pos.y + 6 + Math.max(0, dir.y) * JAB_RANGE }
    const n = g.damage(sector, { id: newHitId(), kind: 'punch', dmg: 320, power: 46, origin: p.pos, dir: fwd, friendly: true })
    const end = _a.copy(fist).addScaledVector(dir, JAB_RANGE)
    g.damage({ t: 'capsule', a: fist, b: end.clone(), r: 3.5 }, { id: newHitId(), kind: 'punch', dmg: 1400, power: 30, origin: fist, dir: fwd, friendly: true })
    g.cutProjectiles(sector)
    this.jabFx(fist, dir, fwd, n)
    audio.punchJab()
    g.score.feat('punch', clamp(n / 12, 0, 1))
    if (n > 0) {
      g.time.freeze(0.035)
      g.cam.addTrauma(0.14)
    }
  }

  private jabFx(fist: THREE.Vector3, dir: THREE.Vector3, fwd: THREE.Vector3, hits: number) {
    const g = this.g
    const fx = g.fx
    const q = g.q
    // the air trail: a volley of rings racing down the line, each a little wider
    for (let i = 0; i < 7; i++) {
      _p.copy(fist).addScaledVector(dir, 1.2 + i * 2.2)
      this.fx.ring(_p, dir, 0.3 + i * 0.15, 1.4 + i * 0.9, 0.28 + i * 0.05, { speed: 60 + i * 34, delay: i * 0.014, alpha: 1 - i * 0.07, thick: 0.22 })
    }
    this.fx.vapor(_p.copy(fist).addScaledVector(dir, 0.25), dir, 1.5, 0.35, 1.25, 0.22, 0.75)
    // a spray of hot sparks off the fist, and a snap of light
    fx.sparkShower(fist, dir, 140, 46, 0.18, WHITE_GOLD, { life: 0.32, size: 0.04, drag: 2.6, stretch: 0.03, heat: 4 })
    fx.light(fist, '#ffe6c0', 40, 18, 14)
    // a wall of dust peels off the ground on both sides of the line
    const side = sideOf(fwd, _s)
    const gy = g.terrain.heightAt(fist.x, fist.z)
    const near = fist.y - gy < 6
    if (near) {
      const steps = Math.max(3, Math.round(9 * q))
      for (let i = 0; i < steps; i++) {
        const t = 3 + (i / steps) * 34
        _a.copy(g.player.pos).addScaledVector(fwd, t)
        _a.y = g.terrain.heightAt(_a.x, _a.z) + 0.4
        for (const sgn of [-1, 1]) {
          _p.copy(_a).addScaledVector(side, sgn * (0.8 + t * 0.12))
          _v.copy(side).multiplyScalar(sgn * (7 + Math.random() * 7)).addScaledVector(fwd, 6 + Math.random() * 8).setY(2 + Math.random() * 4)
          fx.smoke.spawn(_p, _v, DUST, 0.5, 1 + t * 0.04 + Math.random() * 0.8, 0.9 + Math.random() * 0.7, -0.3, 2.4, { grow: 1.6 })
        }
        fx.gpu.dustMotes(_a, 14, 1.2, { out: 9, up: 2.5, size: 0.3, life: 1.4 })
      }
    }
    // screen: a gunshot, not a flashbang
    const post = g.post
    post.shock(fist, g.camera, 0.02, { speed: 2.4, width: 0.6 })
    post.kickZoom(0.05, _p.copy(fist).addScaledVector(dir, 6), g.camera)
    post.kickChroma(0.35)
    post.speedLines(0.35, 0.02)
    g.cam.kick(dir, 0.14)
    g.cam.addTrauma(0.08)
    if (hits > 6) post.streak(0.2, fist)
  }

  // -------------------------------------------------------------------------
  // The Serious Punch: charge
  // -------------------------------------------------------------------------

  /** The coil begins (F still held after the jab). */
  beginCharge() {
    const g = this.g
    this.charge = 0
    this.charging = true
    this.full = false
    this.pulseT = 0.25
    this.arcT = 0
    this.snd?.stop()
    this.snd = audio.seriousCharge()
    // the world tightens around the hero
    g.cam.dolly(-8, SERIOUS_CHARGE * 2)
  }

  /** Every hero frame while coiled: power gathers in the fist, the ground gives, the air is shoved aside. */
  chargeTick(dt: number) {
    const g = this.g
    const p = g.player
    const fx = g.fx
    this.charge = Math.min(1, this.charge + dt / SERIOUS_CHARGE)
    const k = this.charge
    this.snd?.set(k)
    g.aura.setPower(0.25 + k * 0.75)
    // the rocks rise in front of the fist, clear of the camera, ready to be thrown down the line
    if (p.altitude < 8) g.levitate.setPower(k * 0.85, _p.set(p.pos.x + Math.sin(p.yaw) * 5, p.pos.y, p.pos.z + Math.cos(p.yaw) * 5), dt)
    g.cam.addTrauma(dt * (0.12 + k * k * 1.1))
    p.model.rig.handL.getWorldPosition(_fist)
    // light streams into the fist
    const n = Math.floor(dt * (40 + k * 160) * g.q + Math.random())
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const r = 3 + Math.random() * (5 + k * 9)
      _p.set(_fist.x + Math.sin(a) * r, _fist.y - 1 + Math.random() * (2 + k * 5), _fist.z + Math.cos(a) * r)
      _v.subVectors(_fist, _p).multiplyScalar(2.6)
      fx.glow.spawn(_p, _v, [1, 0.82, 0.5], 0.9, 0.05 + Math.random() * 0.06, 0.38, 0, 0)
    }
    this.fx.placeGlow(_fist, 0.35 + k * 0.55, 0.2 + k * 0.4)
    // dust dragged in along the ground toward the coiled fist
    if (p.altitude < 4 && Math.random() < dt * (6 + k * 22) * g.q) {
      const a = Math.random() * Math.PI * 2
      const r = 10 + Math.random() * 16
      _p.set(p.pos.x + Math.sin(a) * r, 0, p.pos.z + Math.cos(a) * r)
      _p.y = g.terrain.heightAt(_p.x, _p.z) + 0.4
      _v.set(p.pos.x - _p.x, 0.6, p.pos.z - _p.z).multiplyScalar(0.9 + k)
      fx.smoke.spawn(_p, _v, DUST, 0.42, 1.2 + Math.random() * 1.4, 1.1 + Math.random() * 0.6, 0, 0.6, { grow: 0.4 })
    }
    // arcs crawl from the fist into the ground
    this.arcT -= dt
    if (k > 0.25 && this.arcT <= 0) {
      this.arcT = k >= 1 ? 0.07 + Math.random() * 0.1 : 0.16 + Math.random() * 0.2 * (1 - k)
      const a = Math.random() * Math.PI * 2
      const r = 1.5 + Math.random() * (2 + k * 4)
      _p.set(p.pos.x + Math.sin(a) * r, 0, p.pos.z + Math.cos(a) * r)
      _p.y = g.terrain.heightAt(_p.x, _p.z) + 0.05
      if (k >= 1 && Math.random() < 0.35) g.lightning.bolt(_fist, _p, { width: 0.2, forks: 4, life: 0.18, sparks: Math.random() < 0.3, light: false })
      else g.lightning.arc(_fist, _p, { life: 0.1 + Math.random() * 0.12, width: 0.06 + k * 0.06, forks: 2, intensity: 0.8 + k * 0.3 })
    }
    // the pressure shoves everything near away from the hero
    this.pulseT -= dt
    if (k > 0.3 && this.pulseT <= 0) {
      this.pulseT = 0.32 - k * 0.12
      const c = p.pos
      const r = 4 + k * 14
      g.damage({ t: 'ring', c, r0: 0, r1: r, h: c.y + 4 }, { id: newHitId(), kind: 'punch', dmg: 60, power: 8 + k * 18, origin: c, friendly: true })
      if (p.altitude < 3) {
        fx.ring(_p.copy(c).setY(c.y + 0.08), r * 1.2, '#ffe2b0', 0.45, { thick: 0.08, alpha: 0.6 + k * 0.4 })
        fx.gpu.dustMotes(_p.copy(c).setY(c.y + 0.1), 30 + k * 40, 1.5, { out: r * 1.6, up: 1.2, size: 0.35, life: 1.4 })
      }
    }
    if (k >= 1 && !this.full) {
      this.full = true
      g.aura.flare(0.35)
      fx.flare(_fist, 5, '#fff0c8', 0.35, 0.7)
      if (p.altitude < 2) {
        // the ground gives under the stance
        g.terrain.crater(p.pos.x, p.pos.z, 5.5, 0.5, { rim: 0.5, ejecta: 0.4 })
        if (p.grounded) p.pos.y = g.terrain.heightAt(p.pos.x, p.pos.z)
        fx.ring(_p.copy(p.pos).setY(p.pos.y + 0.1), 16, '#ffd8a0', 0.6, { thick: 0.1, alpha: 0.9 })
        fx.gpu.dustMotes(_p, 90, 3, { out: 16, up: 2, size: 0.4, life: 1.8 })
        fx.debris.burst(_p, 10, 9, 0.18, 0.3)
      }
      audio.landing(1.2)
      if (p.divinity < SERIOUS_COST) useUI.getState().stamp(`SERIOUS PUNCH NEEDS ${SERIOUS_COST} DIVINITY`, 'warn')
    }
  }

  /** The coil is let go without a Serious Punch (cancelled, or released early). */
  cancel() {
    if (!this.charging) return
    this.charging = false
    this.charge = 0
    this.snd?.stop(0.15)
    this.snd = null
    this.fx.placeGlow(_fist, 0, 0)
    this.g.levitate.drop()
  }

  /** Is the coil complete and paid for? */
  get canRelease() {
    return this.charge >= 1 && this.g.player.divinity >= SERIOUS_COST
  }

  // -------------------------------------------------------------------------
  // The Serious Punch: release
  // -------------------------------------------------------------------------

  /** The fist goes through: everything down the line, out to the horizon. */
  serious() {
    const g = this.g
    const p = g.player
    this.charging = false
    this.charge = 0
    this.snd?.stop(0.05)
    this.snd = null
    this.fx.placeGlow(_fist, 0, 0)
    p.divinity = Math.max(0, p.divinity - SERIOUS_COST)
    p.invuln = Math.max(p.invuln, 1.4)
    const aim = this.aim(new THREE.Vector3())
    const w = this.waves.find((x) => !x.on) ?? this.waves.reduce((a, b) => (a.age > b.age ? a : b))
    waveDir(aim, w.dir)
    this.fistAt(w.dir, w.origin)
    // a falling moon roughly ahead draws the fist up to it
    const moon = g.forces?.eclipse.moonTarget
    if (moon && headingGap(_v.subVectors(moon, w.origin), w.dir) < MOON_ASSIST) {
      waveDir(_v, w.dir, 1, 0)
      this.fistAt(w.dir, w.origin)
    }
    w.flat.set(w.dir.x, 0, w.dir.z).normalize()
    sideOf(w.flat, w.side)
    w.on = true
    w.d = 0
    w.age = 0
    w.carved = 0
    w.ringAt = 40
    w.sprayAt = 0
    w.seed = (Math.random() * 1e6) | 0
    w.foot.copy(p.pos).addScaledVector(w.flat, 2.5)
    // a steep wave leaves the ground quickly: tear only what it skims
    const tilt = Math.asin(clamp(w.dir.y, 0, 1))
    w.ground = p.altitude > 6 ? 0 : tilt < 0.03 ? SPRAY_LEN : Math.min(SPRAY_LEN, 14 / Math.tan(tilt))
    this.aimTargets(w)
    w.mountain = g.boreMountains?.(w.origin, w.dir, 60, WAVE_SPEED) ?? -1
    this.releaseFx(w)
    this.playShot(w)
    audio.seriousPunch()
    g.fx.after(0.2, () => audio.skyRip())
    g.score.feat('serious', 1)
    useUI.getState().stamp('SERIOUS PUNCH', 'divine')
  }

  /** Who the wave will reach, and when: the eclipse by heading, reflect targets by the cone. */
  private aimTargets(w: Wave) {
    const g = this.g
    w.strikes.length = 0
    w.eclipse = -1
    const ecl = g.forces?.eclipse
    eclipsePoint(_b)
    if (ecl?.alive && eclipseHeading(w.dir) < ECLIPSE_AIM) w.eclipse = Math.min(WAVE_RANGE, w.origin.distanceTo(_b) * 0.8)
    for (const t of g.reflectTargets()) {
      if (!t.alive) continue
      t.aim(_p)
      if (_p.distanceToSquared(_b) < 1) continue
      const d = waveReach(w.origin, w.dir, _p, t.radius)
      if (d >= 0) w.strikes.push({ t, d })
    }
  }

  private releaseFx(w: Wave) {
    const g = this.g
    const fx = g.fx
    const p = g.player
    const o = w.origin
    const post = g.post
    // a beat of stillness, then the world is thrown back
    g.time.freeze(0.16)
    g.time.divine(1.5, 0.4)
    post.impactFrames([2, 0], 1 / 20)
    post.flashTo(0.1, '#fff2e0', 5)
    post.kickZoom(0.12, _p.copy(o).addScaledVector(w.dir, 8), g.camera)
    post.speedLines(0.85, 0.5)
    post.kickChroma(0.6)
    post.shock(o, g.camera, 0.06, { speed: 1.3, width: 1.6 })
    post.shock(_p.copy(o).addScaledVector(w.dir, 12), g.camera, 0.035, { delay: 0.12, speed: 1.8, width: 1 })
    post.rays(_p.copy(o).addScaledVector(w.dir, 30), 0.25, 0.8, '#ffe4bc')
    post.streak(0.35, o)
    g.cam.addTrauma(0.95)
    g.cam.dolly(22, 1.4)
    g.cam.kick(w.dir, 0.4)
    // the hero's power is spent all at once
    g.aura.flare(0.3, undefined, false)
    g.levitate.release(w.flat, 1.9)
    g.lightning.fan(_p.copy(o).addScaledVector(w.dir, 2), w.dir, 3, 18, 0.45, { width: 0.16, forks: 3, life: 0.3, intensity: 0.6, light: false, sparks: false })
    fx.light(o, '#ffe0b0', 80, 50, 8)
    // the fist's vapor cone and the first rings of the corridor
    this.fx.vapor(_p.copy(o).addScaledVector(w.dir, 0.4), w.dir, 4, 0.8, 4.5, 0.5, 0.55)
    for (let i = 0; i < 3; i++) {
      _p.copy(o).addScaledVector(w.dir, 2 + i * 4)
      this.fx.ring(_p, w.dir, 0.6 + i * 0.5, 3.5 + i * 2.2, 0.45 + i * 0.08, { speed: 160 + i * 80, delay: i * 0.012, alpha: 0.75, thick: 0.2 })
    }
    fx.sparkShower(_p.copy(o).addScaledVector(w.dir, 1.5), w.dir, 160, 90, 0.14, WHITE_GOLD, { life: 0.45, size: 0.045, drag: 2.2, stretch: 0.035, heat: 2.2 })
    // a ground-hugging shock ring around the hero, and the ground under him gives
    if (p.altitude < 4) {
      const gp = _p.copy(p.pos)
      g.terrain.crater(gp.x, gp.z, 9, 1.2, { rim: 0.6, ejecta: 0.8 })
      if (p.grounded) p.pos.y = g.terrain.heightAt(p.pos.x, p.pos.z)
      gp.y = g.terrain.heightAt(gp.x, gp.z)
      fx.ring(_w.copy(gp).setY(gp.y + 0.12), 60, '#ffd8a0', 0.9, { thick: 0.06, alpha: 1 })
      fx.ring(_w.copy(gp).setY(gp.y + 0.14), 28, '#fff0d8', 0.5, { thick: 0.12, alpha: 0.7 })
      fx.debris.burst(_w.copy(gp).setY(gp.y + 0.4), 30, 22, 0.3, 0.4, 0.8)
      fx.gpu.plasmaRing(_w.copy(gp).setY(gp.y + 0.3), UP, 70, 900, GOLD, { expand: 0.7, fill: 0.5, thick: 0.2, life: 1.3, size: 0.08, stretch: 0.04, heat: 2 })
      const ndust = Math.round(48 * g.q)
      for (let i = 0; i < ndust; i++) {
        const a = (i / ndust) * Math.PI * 2
        _w.set(gp.x + Math.sin(a) * 3, gp.y + 0.5, gp.z + Math.cos(a) * 3)
        _v.set(Math.sin(a) * (40 + Math.random() * 30), 2 + Math.random() * 5, Math.cos(a) * (40 + Math.random() * 30))
        fx.smoke.spawn(_w, _v, DUST, 0.5, 2.5 + Math.random() * 2, 1.4 + Math.random() * 0.8, -0.2, 1.6, { grow: 2.2 })
      }
    }
    // the wind follows the wave
    g.gust(_p.copy(p.pos).addScaledVector(w.flat, -10), 30)
    // the sky tears open along the line
    g.fx.after(0.08, () => g.sky.part(w.dir))
  }

  /** Pull back and tilt up: the wave racing for the mountains under a splitting sky. Any input skips it. */
  private playShot(w: Wave) {
    const g = this.g
    if (g.cam.cinematic) return
    const p0 = g.player.pos.clone()
    const flat = w.flat.clone()
    const side = w.side.clone()
    this.shotT = 0
    g.cam.play({
      dur: 2.7,
      blendIn: 0.45,
      blendOut: 0.9,
      frame: (t, pos, look) => {
        this.shotLive = true
        this.shotT = t
        const e = smoothstep(0.05, 1.9, t)
        pos.copy(p0).addScaledVector(flat, -(6 + 24 * e)).addScaledVector(side, 2.2 + 7 * e)
        pos.y = p0.y + 2.2 + 11 * e
        look.copy(p0).addScaledVector(flat, 30 + 520 * e)
        look.y = p0.y + 1.6 + 230 * e
        return 62 + 12 * e
      },
    })
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** Every hero frame: the cooldown, and letting any input cut the release cinematic short. */
  tick(dt: number, f: InputFrame, enabled: boolean) {
    this.cd -= dt
    // a cutscene can take the hero out of the coil without a state change of ours
    const st = this.g.player.state
    if (this.charging && st !== 'scharge' && st !== 'spunch') this.cancel()
    if (!this.charging) this.fx.placeGlow(_fist, 0, 0)
    const live = this.shotLive
    this.shotLive = false
    if (!live || !enabled || this.shotT < 0.5) return
    const any = f.slash || f.parry || f.dash || f.jump || f.punch || f.ult || f.heavy || Math.hypot(f.moveX, f.moveY) > 0.3 || Math.abs(f.lookX) + Math.abs(f.lookY) > 0.03
    if (any) this.g.cam.stopShot()
  }

  update(dt: number) {
    this.fx.update(dt)
    this.waves.forEach((w, i) => {
      if (w.on) this.step(w, dt)
      this.placeFront(w, i * 2)
    })
  }

  /** The travelling front: a colossal arch the width of the kill zone, and a tighter, brighter ring on the axis. */
  private placeFront(w: Wave, i: number) {
    const d = w.d
    const a = w.on && d < WAVE_RANGE ? 1 - smoothstep(WAVE_RANGE * 0.5, WAVE_RANGE, d) : 0
    // the arch only shows once it is out ahead: right at the lens it would be a bubble over the whole screen
    _p.copy(w.origin).addScaledVector(w.dir, d)
    this.fx.placeFront(i, _p, w.dir, waveRadius(d) * 0.96, a * 0.7 * smoothstep(30, 110, d), 0.3)
    _p.copy(w.origin).addScaledVector(w.dir, Math.max(0, d - 6))
    this.fx.placeFront(i + 1, _p, w.dir, VIS_R0 + d * VIS_TAN * 1.5, a * smoothstep(15, 50, d), 0.16)
  }

  /** Advance one wave: annihilate what it sweeps, tear the ground, leave rings behind. */
  private step(w: Wave, dt: number) {
    const g = this.g
    w.age += dt
    const d0 = w.d
    w.d = Math.min(WAVE_RANGE, w.d + WAVE_SPEED * dt)
    const d1 = w.d
    if (d1 > d0) {
      const shape: Shape = { t: 'cone', c: w.origin, dir: w.dir, tan: WAVE_TAN, r0: WAVE_R0, d0, d1 }
      g.damage(shape, { id: newHitId(), kind: 'punch', dmg: WAVE_DMG, power: 70, origin: w.origin, dir: w.flat, friendly: true })
      g.cutProjectiles(shape)
      for (const s of w.strikes) {
        if (s.d <= d0 || s.d > d1 || !s.t.alive) continue
        s.t.aim(_p)
        s.t.struck(TARGET_DMG, _p, 'punch')
      }
      if (w.eclipse > d0 && w.eclipse <= d1) this.punchEclipse()
      if (w.mountain > d0 && w.mountain <= d1) this.mountainBeat(w)
      this.tear(w, d0, d1)
      while (w.ringAt <= d1 && w.ringAt < WAVE_RANGE * 0.7) {
        const d = w.ringAt
        const r = VIS_R0 + d * VIS_TAN
        _p.copy(w.origin).addScaledVector(w.dir, d)
        this.fx.ring(_p, w.dir, r * 0.7, r * 1.25, 0.8 + d / 1600, { alpha: d < 400 ? 0.85 : 0.6, thick: 0.16, speed: 25 })
        w.ringAt += ringGap(d)
      }
    }
    if (d1 >= WAVE_RANGE && w.age > WAVE_RANGE / WAVE_SPEED + 2.5) w.on = false
  }

  /** The ground torn along the axis: the trench, the lips spraying rock, dust walls peeling off both sides. */
  private tear(w: Wave, d0: number, d1: number) {
    const g = this.g
    const fx = g.fx
    const q = g.q
    if (w.ground <= 0) return
    // the trench, carved piece by piece as the front passes (it partitions exactly by seed)
    const tl = Math.min(TRENCH_LEN, w.ground)
    while (w.carved < tl && d1 >= Math.min(tl, w.carved + 30)) {
      const from = w.carved
      const to = Math.min(tl, from + 30)
      w.carved = to
      _a.copy(w.foot).addScaledVector(w.flat, from)
      _b.copy(w.foot).addScaledVector(w.flat, to)
      const k = 1 - from / tl
      g.terrain.trench(w.foot.x, w.foot.z, w.foot.x + w.flat.x * tl, w.foot.z + w.flat.z * tl, 16, 6, { seed: w.seed, from: from / tl, to: to / tl, lip: 0.35 })
      g.scorch.fissure(_a.x, _a.z, _b.x, _b.z, 3.5, 1)
      _a.y = g.terrain.heightAt(_a.x, _a.z) + 0.5
      _b.y = g.terrain.heightAt(_b.x, _b.z) + 0.5
      fx.sparkWall(_a, _b, Math.round(500 + 500 * k), 40, FIRE, 0.03)
      _p.lerpVectors(_a, _b, 0.5)
      fx.debris.burst(_p, Math.round(5 + 6 * k), 26, 0.5 + k * 0.4, 0.7, 1.2)
    }
    // dust: two walls along the lips, and the edges of the swept wedge
    const end = Math.min(SPRAY_LEN, w.ground)
    while (w.sprayAt <= d1 && w.sprayAt < end) {
      // not right under the camera: the first spray is a little way down the line
      const d = Math.max(14, w.sprayAt)
      w.sprayAt += d < TRENCH_LEN ? 14 : 34
      _a.copy(w.foot).addScaledVector(w.flat, d)
      const gy = g.terrain.heightAt(_a.x, _a.z)
      _a.y = gy + 0.6
      const big = 1 + d * 0.012
      const nl = Math.max(1, Math.round(3 * q))
      for (const sgn of [-1, 1]) {
        // the lips of the trench throw rock and dust up and out
        for (let i = 0; i < nl; i++) {
          _p.copy(_a).addScaledVector(w.side, sgn * (7 + Math.random() * 3))
          _v.copy(w.side).multiplyScalar(sgn * (14 + Math.random() * 16) * big).addScaledVector(w.flat, 8 + Math.random() * 18).setY((6 + Math.random() * 10) * Math.sqrt(big))
          fx.smoke.spawn(_p, _v, DUST, 0.55, (2.4 + Math.random() * 2.6) * big, 1.6 + Math.random() * 1.6, -0.4, 1.4, { grow: 2.4 })
        }
        // the edge of the swept wedge: a sheet of dust lifted off the plain
        const e = waveRadius(d) * 0.92
        _p.copy(_a).addScaledVector(w.side, sgn * e)
        _p.y = g.terrain.heightAt(_p.x, _p.z) + 0.6
        _v.copy(w.side).multiplyScalar(sgn * (8 + Math.random() * 8) * big).addScaledVector(w.flat, 10 * big).setY(3 * Math.sqrt(big))
        fx.smoke.spawn(_p, _v, DUST, 0.4, (3 + Math.random() * 3) * big, 1.8 + Math.random() * 1.4, -0.2, 1.2, { grow: 2.6 })
        fx.gpu.dustMotes(_p, 24, 2 * big, { out: 10 * big, up: 3 * big, size: 0.4 * big, life: 2.2 })
      }
      fx.gpu.dustMotes(_a, 40, 4 * big, { out: 18 * big, up: 6 * big, size: 0.45 * big, life: 2.4 })
      if (d < TRENCH_LEN) fx.emberDrift(_a, 30, 3, { height: 2, rise: 3, burst: 4, life: 2, size: 0.12 })
    }
  }

  /** The front reaches the mountains (the mountains carve their own tunnel): the world answers late. */
  private mountainBeat(w: Wave) {
    const g = this.g
    audio.rumble(1, 5)
    audio.nukeShock()
    g.cam.addTrauma(0.45)
    g.sky.flash(w.flat, 0.45, '#ffcf9a')
  }

  private punchEclipse() {
    const g = this.g
    const ecl = g.forces?.eclipse
    if (!ecl) return
    const hp = ecl.hp
    ecl.hurt(ECLIPSE_DMG)
    if (ecl.hp < hp) {
      useUI.getState().stamp('THE ECLIPSE, PUNCHED', 'divine')
      audio.roar(eclipsePoint(_p), 0.35)
      g.cam.addTrauma(0.5)
    }
  }

  reset() {
    this.cancel()
    this.cd = 0
    this.charge = 0
    this.full = false
    for (const w of this.waves) w.on = false
    this.shotLive = false
    this.fx.clear()
  }
}
