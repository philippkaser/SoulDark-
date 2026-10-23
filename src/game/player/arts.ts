import * as THREE from 'three'
import { audio, type LoopHandle } from '../../audio/audio'
import { shapeHitsSphere, type Shape } from '../../engine/geom'
import { angleDiff, clamp, smoothstep } from '../../engine/math'
import type { InputFrame } from '../../input/input'
import { useUI } from '../../state/store'
import type { Game, System } from '../Game'
import { FIRE, GOLD, WHITE_GOLD } from '../fx/particleFx'
import { bladeFrame, sideOf, SwordFx } from '../fx/swordFx'
import { newHitId } from '../types'
import { SLICE_SPEED } from '../world/farField'
import { eclipsePoint, SUN_DIR } from '../world/layout'

/** The Iai, in hero seconds into the move: the blade is out, back in its scabbard (everything falls apart), the move is over. */
export const IAI_DRAW = 0.065
export const IAI_SHEATHE = 0.43
export const IAI_DUR = 0.62
export const IAI_CD = 1.1
/** Everything within this many metres of the hero, in the plane of the cut, is cut. */
export const IAI_RANGE = 420
/** Half-thickness of the cut (m): soldiers on rough ground are still caught. */
export const IAI_HALF = 3.5
/** The cut follows the aim upward, never down, at most this steep (rad). */
export const IAI_MAX_TILT = 0.7
/** The ring of light runs on past what the cut kills. */
const IAI_VIS = 620
const IAI_DMG = 6000
/** A big parry's counter-cut reaches this far. */
export const COUNTER_RANGE = 160
/** Still holding the button this long into the Iai: the blade goes up instead of home, for the Worldsplitter. */
export const HOLD_TO_CHARGE = 0.2
export const WORLD_CHARGE = 1.3
export const WORLD_COST = 50
/** The swing: when the falling blade meets the world (hero s), and when the hero is free again. */
export const WORLD_HIT = 0.36
export const WORLD_DUR = 1.25
/** What the Worldsplitter cuts: a vertical sheet this long, this thick (half) and this tall. */
export const WORLD_RANGE = 6000
export const WORLD_HALF = 16
const WORLD_HEIGHT = 4000
/** The blade of light: its length at full charge, and as it lands. */
export const BLADE_MAX = 1800
const BLADE_STRIKE = 6000
/** The canyon it leaves across the world. */
const CANYON_W = 64
const CANYON_D = 90
/** A falling moon within this heading of the aim draws the cut onto it. */
export const MOON_ASSIST = (30 * Math.PI) / 180
/** Aim within this heading of the eclipse to cut it. */
export const ECLIPSE_AIM = (15 * Math.PI) / 180
const MOON_R = 95
/** The Horizon Cut: its price, its cooldown (hero s), its reach, and the lowest and highest it will cut. */
export const HORIZON_COST = 30
export const HORIZON_CD = 3
export const HORIZON_RANGE = 4200
export const HORIZON_MIN = 40
export const HORIZON_MAX = 1100
/** The Horizon Cut takes the peaks within this arc either side of the aim (rad). */
export const HORIZON_ARC = (55 * Math.PI) / 180
/** The draw happens at IAI_DRAW; the pieces are let go this long after it. */
const HORIZON_SHEATHE = 0.55
const TARGET_DMG = 8000
const ECLIPSE_DMG = 9000

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _p = new THREE.Vector3()
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _s = new THREE.Vector3()
const _hilt = new THREE.Vector3()
const _q = new THREE.Quaternion()
const UP = new THREE.Vector3(0, 1, 0)
const DUST: readonly [number, number, number] = [0.34, 0.28, 0.24]

/**
 * The plane of the Iai's cut: level for a level (or downward) aim, tilted up
 * about the hero's side axis when he looks up, so it passes through what he
 * looks at. The follow camera cannot look up far, so upward aim counts for
 * more (`gain`) and a slight glance up still cuts level (`bias`).
 */
export function discNormal(aim: THREE.Vector3, out: THREE.Vector3, gain = 1.8, bias = 0.05, max = IAI_MAX_TILT) {
  const l = Math.hypot(aim.x, aim.z)
  const fx = l > 1e-5 ? aim.x / l : 0
  const fz = l > 1e-5 ? aim.z / l : -1
  const tilt = clamp((Math.atan2(aim.y, Math.max(l, 1e-5)) - bias) * gain, 0, max)
  return out.set(-fx * Math.sin(tilt), Math.cos(tilt), -fz * Math.sin(tilt))
}

/** Heading difference (rad) between two directions, ignoring height. */
export function headingGap(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.abs(angleDiff(Math.atan2(a.x, a.z), Math.atan2(b.x, b.z)))
}

/** Heading difference (rad) between a direction and the eclipse, ignoring height. */
export function eclipseHeading(dir: THREE.Vector3) {
  return headingGap(dir, SUN_DIR)
}

/** The Worldsplitter's blade length at charge k. */
export const bladeLength = (k: number) => 5 + BLADE_MAX * Math.pow(clamp(k, 0, 1), 2.2)

/**
 * Where the Horizon Cut goes: the height at which the aim from `origin` along
 * `dir` first meets the ground (marched out to the Horizon Cut's reach), or, if
 * it meets nothing, a slant up into the sky from the hero's chest. Clamped to
 * HORIZON_MIN..HORIZON_MAX.
 */
export function horizonHeight(origin: THREE.Vector3, dir: THREE.Vector3, heightAt: (x: number, z: number) => number, chestY: number) {
  for (let t = 40; t <= HORIZON_RANGE; t += 15) {
    const x = origin.x + dir.x * t
    const y = origin.y + dir.y * t
    const z = origin.z + dir.z * t
    if (y < heightAt(x, z)) return { y: clamp(y, HORIZON_MIN, HORIZON_MAX), hit: new THREE.Vector3(x, y, z) }
  }
  const l = Math.max(1e-3, Math.hypot(dir.x, dir.z))
  return { y: clamp(chestY + (dir.y / l) * 1500, HORIZON_MIN, HORIZON_MAX), hit: null }
}

/** Distance from the line (xz) through `a` along unit `dir` to p, and how far along it p lies. */
export function lineOffset(a: THREE.Vector3, dir: THREE.Vector3, p: THREE.Vector3) {
  const dx = p.x - a.x
  const dz = p.z - a.z
  const along = dx * dir.x + dz * dir.z
  return { along, off: Math.abs(dx * dir.z - dz * dir.x) }
}

interface Pending {
  /** Hero seconds until the sheathe. */
  t: number
  /** Reach of the cut (m). */
  r: number
  /** Half-thickness of the cut (m). */
  h: number
  /** For a Horizon Cut: how many peaks it took off (they are let go on the click). */
  peaks?: number
  c: THREE.Vector3
  n: THREE.Vector3
  disc: number
}

/**
 * The sword arts. A tap is the Iai: the blade leaves its scabbard and goes
 * home again faster than the eye, and on the click everything around the hero,
 * out to four hundred metres, falls apart along one plane. Held, the blade
 * goes up instead and the light poured into it climbs past the clouds: the
 * Worldsplitter brings it down, cutting a vertical sheet through the world to
 * the horizon, the mountains, the cloud deck and whatever hangs in the sky
 * along it. Hero-side moments run on the hero's clock (Player calls them);
 * the effects live on the world's (it is a System).
 */
export class SwordArts implements System {
  readonly root = new THREE.Group()
  readonly fx = new SwordFx()
  private g: Game
  /** Iai cooldown (hero seconds). */
  cd = 0
  /** Worldsplitter charge 0..1. */
  charge = 0
  private charging = false
  private full = false
  private snd: LoopHandle | null = null
  private pulseT = 0
  private arcT = 0
  private skyT = 0
  private counterT = 0
  private pending: Pending[] = []
  /** The blade of light: its length, brightness, and the fade after it lands. */
  private bladeLen = 0
  private bladePow = 0
  private bladeFade = 0
  /** The Worldsplitter's heading, fixed when the swing starts. */
  private readonly wdir = new THREE.Vector3(0, 0, -1)
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

  /** The aim from the hero's chest, kept from burying itself at the feet. */
  private aim(out: THREE.Vector3) {
    const g = this.g
    g.player.chestPos(_p)
    out.subVectors(g.cam.aimPoint, _p)
    if (out.lengthSq() < 4) out.copy(g.cam.aimDir)
    out.normalize()
    out.y = clamp(out.y, -0.3, 0.75)
    return out.normalize()
  }

  // -------------------------------------------------------------------------
  // The Iai
  // -------------------------------------------------------------------------

  /** The draw: the cut is made, the world doesn't know it yet. */
  iai() {
    const g = this.g
    const p = g.player
    const c = p.chestPos(new THREE.Vector3())
    const aim = this.aim(_a)
    const n = discNormal(aim, new THREE.Vector3())
    // a falling moon nearby draws the cut up onto it
    const moon = g.forces?.eclipse.moonTarget
    if (moon) {
      _b.subVectors(moon, c)
      if (_b.length() < IAI_RANGE + MOON_R && headingGap(_b, aim) < MOON_ASSIST) discNormal(_b.normalize(), n, 1, 0, 1.3)
    }
    const disc = this.fx.disc(c, n, IAI_VIS, 0.16, 0.6, 1.4)
    this.pending.push({ t: IAI_SHEATHE - IAI_DRAW, r: IAI_RANGE, h: IAI_HALF, c, n, disc })
    this.cd = IAI_CD
    // the steel flashes once across the front, a ring of pressure in the plane of the cut
    const fwd = _w.set(aim.x, 0, aim.z)
    if (fwd.lengthSq() < 1e-6) fwd.set(Math.sin(p.yaw), 0, Math.cos(p.yaw))
    fwd.normalize()
    _p.copy(c).addScaledVector(fwd, 1.2)
    g.fx.flare(_p, 2.2, '#fff4dc', 0.12, 0.8)
    // the stroke runs from the hero's left across to his right: the sparks fly with it
    g.fx.sparkShower(_p, sideOf(fwd, _s).addScaledVector(fwd, 0.6).normalize(), 90, 40, 0.5, WHITE_GOLD, { life: 0.3, size: 0.035, drag: 2.4, stretch: 0.03, heat: 3 })
    this.fx.ring(c, n, 1.5, 34, 0.32, { thick: 0.05, alpha: 0.9, color: '#ffe8c8' })
    this.fx.ring(c, n, 1, 90, 0.6, { thick: 0.03, alpha: 0.5, color: '#ffd8a0', delay: 0.03 })
    // the cut sweeps across the frame: the picture slides apart along it until the sheathe
    const cam = g.camera
    cam.getWorldDirection(_v)
    _v.addScaledVector(n, -_v.dot(n))
    if (_v.lengthSq() < 1e-4) _v.copy(fwd)
    _v.normalize()
    _s.crossVectors(n, _v).normalize()
    _a.copy(c).addScaledVector(_v, 300).addScaledVector(_s, 220)
    _b.copy(c).addScaledVector(_v, 300).addScaledVector(_s, -220)
    g.post.cutWorld(_a, _b, 0.03, 0.7, IAI_SHEATHE - IAI_DRAW + 0.05, cam)
    // the dust jumps off the ground around the stance
    if (p.altitude < 3) {
      const gp = _p.copy(p.pos)
      gp.y = g.terrain.heightAt(gp.x, gp.z) + 0.1
      g.fx.ring(gp, 22, '#ffe2b8', 0.4, { thick: 0.06, alpha: 0.8 })
      g.fx.gpu.dustMotes(gp, 60, 2, { out: 22, up: 1.4, size: 0.32, life: 1.3 })
    }
    g.time.freeze(0.04)
    g.time.divine(0.55, 0.4)
    g.cam.kickFov(-3)
    g.cam.addTrauma(0.12)
    g.post.kickChroma(0.3)
    g.post.flashTo(0.03, '#fff6e8', 8)
    g.rumble(0.25, 0.5, 70)
    audio.iaiDraw()
  }

  /** The click of the guard against the scabbard: everything in the plane comes apart at once. */
  private sheathe(s: Pending) {
    const g = this.g
    const fx = g.fx
    const shape: Shape = { t: 'disc', c: s.c, n: s.n, r: s.r, h: s.h }
    // the cut lines show on everything caught in the plane before it falls
    const pts = g.enemyPoints
    const order: number[] = []
    for (let i = 0; i < pts.length; i++) if (shapeHitsSphere(shape, pts[i].x, pts[i].y, pts[i].z, 1.2)) order.push(i)
    const shown = Math.min(order.length, Math.round(48 * g.q))
    for (let k = 0; k < shown; k++) {
      const q = pts[order[Math.floor((k / shown) * order.length)]]
      // on the plane, tangent to the circle around the hero
      _p.copy(q).sub(s.c)
      _p.addScaledVector(s.n, -_p.dot(s.n)).add(s.c)
      _v.subVectors(_p, s.c)
      _w.crossVectors(s.n, _v).normalize()
      const half = 1.2 + Math.random() * 1.8
      fx.streak(_a.copy(_p).addScaledVector(_w, -half), _b.copy(_p).addScaledVector(_w, half), 0.12, '#fff0d0', 0.3)
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(s.n, s.c)
    const n = g.damage(shape, { id: newHitId(), kind: 'iai', dmg: IAI_DMG, power: 16, origin: s.c, plane, friendly: true })
    g.cutProjectiles({ ...shape, h: 8 })
    eclipsePoint(_b)
    for (const t of g.reflectTargets()) {
      if (!t.alive) continue
      t.aim(_p)
      if (_p.distanceToSquared(_b) < 1) continue
      if (shapeHitsSphere(shape, _p.x, _p.y, _p.z, t.radius)) t.struck(TARGET_DMG, _p, 'iai')
    }
    this.fx.flashDisc(s.disc)
    if (s.peaks !== undefined) return this.horizonFall(s, n)
    // sparks thrown out flat along the plane, the air snapping shut behind the cut
    fx.plasmaRing(s.c, s.n, 70, Math.round(900 * g.q), WHITE_GOLD, { expand: 0.5, fill: 0.85, thick: 0.4, life: 0.9, size: 0.05, stretch: 0.05, heat: 2.5 })
    this.fx.ring(s.c, s.n, 4, 160, 0.7, { thick: 0.04, alpha: 0.7, color: '#fff0d8' })
    g.post.shock(s.c, g.camera, 0.018, { speed: 2.2, width: 0.7 })
    g.post.kickChroma(0.45)
    g.cam.addTrauma(0.18 + Math.min(0.4, n * 0.01))
    if (n > 0) {
      if (n > 40) g.post.impactFrames([2, 0], 1 / 30)
      g.time.freeze(0.05 + Math.min(0.08, n * 0.002))
      g.rumble(0.35 + Math.min(0.6, n * 0.02), 0.7, 120 + Math.min(220, n * 6))
      audio.cut(s.c, true)
    }
    audio.sheathe(0)
    g.score.feat('iai', clamp(n / 30, 0, 1))
    // a massacre in one stroke: whoever is left backs away
    if (n > 20) g.forces?.horde.terrify(s.c.x, s.c.z, s.r + 200, 3)
  }

  /** A big perfect parry answers on its own: a level ring of steel through everything near, at most once a second. */
  counter() {
    if (this.counterT > 0) return
    this.counterT = 1
    const c = this.g.player.chestPos(new THREE.Vector3())
    const n = new THREE.Vector3(0, 1, 0)
    const disc = this.fx.disc(c, n, COUNTER_RANGE * 1.6, 0.12, 0.45, 0.4)
    this.pending.push({ t: 0.16, r: COUNTER_RANGE, h: IAI_HALF, c, n, disc })
    this.fx.ring(c, n, 1, 40, 0.3, { thick: 0.05, alpha: 0.8, color: '#ffe8c8' })
  }

  // -------------------------------------------------------------------------
  // The Horizon Cut
  // -------------------------------------------------------------------------

  /** Until the Horizon Cut can be drawn again (hero s). */
  hcd = 0

  get horizonReady() {
    return this.hcd <= 0 && this.g.player.divinity >= HORIZON_COST
  }

  /**
   * The draw: one level stroke at the height the hero looks at, out to four
   * kilometres. Every peak standing above it is cut off where it stands.
   */
  horizonCut() {
    const g = this.g
    const p = g.player
    p.divinity = Math.max(0, p.divinity - HORIZON_COST)
    this.hcd = HORIZON_CD
    const chest = p.chestPos(new THREE.Vector3())
    const aim = horizonHeight(g.cam.aimOrigin, g.cam.aimDir, (x, z) => g.far.heightAt(x, z), chest.y)
    const c = new THREE.Vector3(p.pos.x, aim.y, p.pos.z)
    const n = new THREE.Vector3(0, 1, 0)
    const peaks = g.peaks.slice(c.x, c.z, HORIZON_RANGE, aim.y, Math.atan2(g.cam.aimDir.x, g.cam.aimDir.z), HORIZON_ARC)
    const disc = this.fx.disc(c, n, HORIZON_RANGE, HORIZON_RANGE / SLICE_SPEED, 1.4, 3, { heading: Math.atan2(g.cam.aimDir.x, g.cam.aimDir.z), half: HORIZON_ARC })
    this.pending.push({ t: HORIZON_SHEATHE, r: HORIZON_RANGE, h: 30, c, n, disc, peaks })
    // the stroke: the blade flashes, the frame slides apart along the far line of the cut
    const fwd = _w.set(g.cam.aimDir.x, 0, g.cam.aimDir.z)
    if (fwd.lengthSq() < 1e-6) fwd.set(Math.sin(p.yaw), 0, Math.cos(p.yaw))
    fwd.normalize()
    _p.copy(chest).addScaledVector(fwd, 1.2)
    g.fx.flare(_p, 3, '#fff4dc', 0.18, 0.9)
    g.fx.sparkShower(_p, sideOf(fwd, _s).addScaledVector(fwd, 0.6).normalize(), 160, 60, 0.5, WHITE_GOLD, { life: 0.4, size: 0.04, drag: 2.2, stretch: 0.035, heat: 3 })
    this.fx.ring(chest, fwd, 1, 26, 0.4, { thick: 0.05, alpha: 0.8, color: '#ffe8c8' })
    sideOf(fwd, _s)
    _a.copy(c).addScaledVector(fwd, 2500).addScaledVector(_s, 2000)
    _b.copy(c).addScaledVector(fwd, 2500).addScaledVector(_s, -2000)
    g.post.cutWorld(_a, _b, 0.04, 1.2, HORIZON_SHEATHE + 0.1, g.camera)
    g.post.flashTo(0.05, '#fff6e8', 6)
    g.post.kickChroma(0.5)
    g.post.speedLines(0.6, 0.2)
    g.sky.flash(fwd, 0.5, '#ffe2b8')
    g.time.freeze(0.06)
    g.time.divine(1.2, 0.4)
    g.cam.addTrauma(0.25)
    g.rumble(0.4, 0.6, 160)
    audio.iaiDraw()
    audio.skyRip()
    this.horizonShot(aim.hit, aim.y, fwd)
    if (peaks === 0) useUI.getState().stamp('NOTHING STANDS THAT TALL', 'warn')
  }

  /** The click: the peaks let go and start to slide; anything flying in the plane falls apart. */
  private horizonFall(s: Pending, hits: number) {
    const g = this.g
    const p = g.player
    g.peaks.release(p.pos.x, p.pos.z)
    g.forces?.horde.terrify(p.pos.x, p.pos.z, 800, 5)
    audio.sheathe(0)
    audio.cut(s.c, true)
    audio.rumble(1, 6)
    audio.duck(0.6, 3)
    g.post.impactFrames([2, 0], 1 / 24)
    g.post.kickChroma(0.6)
    g.cam.addTrauma(0.35)
    g.rumble(0.6, 0.8, 600)
    g.sky.flash(UP, 0.7, '#ffe2b8')
    g.score.feat('horizon', clamp((s.peaks ?? 0) / 8, 0, 1))
    const k = s.peaks ?? 0
    if (k > 0) useUI.getState().stamp(k === 1 ? 'A MOUNTAIN, CUT DOWN' : `${k} PEAKS, CUT DOWN`, 'divine')
    void hits
  }

  /** Back over the hero's shoulder and up: the cut line racing across the range, the peaks sliding off. Any input skips it. */
  private horizonShot(hit: THREE.Vector3 | null, y: number, fwd: THREE.Vector3) {
    const g = this.g
    if (g.cam.cinematic) return
    const p0 = g.player.pos.clone()
    const flat = fwd.clone()
    const side = sideOf(flat, new THREE.Vector3())
    const look0 = hit ? hit.clone() : p0.clone().addScaledVector(flat, 1800).setY(y)
    look0.y = Math.max(look0.y, y * 0.9)
    this.shotT = 0
    g.cam.play({
      dur: 6,
      blendIn: 0.5,
      blendOut: 1,
      frame: (t, pos, look) => {
        this.shotLive = true
        this.shotT = t
        const e = smoothstep(0.1, 5.5, t)
        pos.copy(p0).addScaledVector(flat, -(8 + 50 * e)).addScaledVector(side, 6 + 24 * e)
        pos.y = p0.y + 4 + 60 * e
        look.copy(look0)
        look.y -= 60 * e
        return 46 - 6 * e
      },
    })
  }

  // -------------------------------------------------------------------------
  // The Worldsplitter: charge
  // -------------------------------------------------------------------------

  /** The blade goes up (the button still held after the draw). */
  beginCharge() {
    const g = this.g
    this.charge = 0
    this.charging = true
    this.full = false
    this.pulseT = 0.25
    this.arcT = 0
    this.skyT = 0.4
    this.bladeFade = 0
    this.snd?.stop()
    this.snd = audio.worldCharge()
    g.cam.dolly(10, WORLD_CHARGE * 2)
  }

  /** Every hero frame while the blade is raised: the light climbs it into the sky, the ground gives, the air is shoved aside. */
  chargeTick(dt: number) {
    const g = this.g
    const p = g.player
    const fx = g.fx
    this.charge = Math.min(1, this.charge + dt / WORLD_CHARGE)
    const k = this.charge
    this.snd?.set(k)
    this.bladeLen = bladeLength(k)
    this.bladePow = 0.35 + 0.65 * k
    g.aura.setPower(0.3 + k * 0.7)
    g.sky.swirl(0.3 + k * 0.7)
    if (p.altitude < 8) g.levitate.setPower(k * 0.9, _p.set(p.pos.x + Math.sin(p.yaw) * 5, p.pos.y, p.pos.z + Math.cos(p.yaw) * 5), dt)
    g.cam.addTrauma(dt * (0.12 + k * k * 1.2))
    g.rumble(0.06 + k * k * 0.6, 0.1 + k * 0.4, 120)
    bladeFrame(p.model.rig.handR, _hilt, _q)
    const axis = _s.set(0, 0, 1).applyQuaternion(_q)
    // light streams in and climbs the blade
    const n = Math.floor(dt * (60 + k * 220) * g.q + Math.random())
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const r = 3 + Math.random() * (6 + k * 10)
      _p.set(_hilt.x + Math.sin(a) * r, p.pos.y + Math.random() * (2 + k * 6), _hilt.z + Math.cos(a) * r)
      _v.subVectors(_hilt, _p).multiplyScalar(2.4).addScaledVector(axis, 6 + k * 30)
      fx.glow.spawn(_p, _v, [1, 0.82, 0.5], 0.9, 0.05 + Math.random() * 0.06, 0.45, 0, 0)
    }
    this.fx.placeGlow(_hilt, 0.4 + k * 0.7, 0.25 + k * 0.45)
    // the ground stirs, dust dragged in toward the stance
    if (p.altitude < 4 && Math.random() < dt * (6 + k * 22) * g.q) {
      const a = Math.random() * Math.PI * 2
      const r = 10 + Math.random() * 18
      _p.set(p.pos.x + Math.sin(a) * r, 0, p.pos.z + Math.cos(a) * r)
      _p.y = g.terrain.heightAt(_p.x, _p.z) + 0.4
      _v.set(p.pos.x - _p.x, 0.6, p.pos.z - _p.z).multiplyScalar(0.9 + k)
      fx.smoke.spawn(_p, _v, DUST, 0.42, 1.2 + Math.random() * 1.4, 1.1 + Math.random() * 0.6, 0, 0.6, { grow: 0.4 })
    }
    // lightning crawls up the blade, and the sky answers it
    this.arcT -= dt
    if (k > 0.2 && this.arcT <= 0) {
      this.arcT = 0.05 + Math.random() * 0.12 * (1.2 - k)
      const len = this.bladeLen
      const h0 = Math.random() * len * 0.7
      const h1 = h0 + (12 + Math.random() * 60) * (0.3 + k)
      _a.copy(_hilt).addScaledVector(axis, h0)
      _b.copy(_hilt).addScaledVector(axis, Math.min(len, h1)).add(_v.set(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(h1 * 0.15))
      g.lightning.bolt(_a, _b, { width: 0.3 + k * 1.4, forks: 3, life: 0.14, sparks: false, light: false })
      if (Math.random() < 0.35) {
        const a = Math.random() * Math.PI * 2
        _p.set(p.pos.x + Math.sin(a) * 4, 0, p.pos.z + Math.cos(a) * 4)
        _p.y = g.terrain.heightAt(_p.x, _p.z) + 0.05
        g.lightning.arc(_hilt, _p, { life: 0.12, width: 0.06 + k * 0.06, forks: 2, intensity: 0.8 + k * 0.3 })
      }
    }
    this.skyT -= dt
    if (k > 0.35 && this.skyT <= 0) {
      this.skyT = 0.25 + Math.random() * 0.3
      g.sky.flash(UP, 0.15 + k * 0.35, '#ffd8a0')
    }
    // the pressure shoves everything near away from the hero
    this.pulseT -= dt
    if (k > 0.3 && this.pulseT <= 0) {
      this.pulseT = 0.32 - k * 0.12
      const c = p.pos
      const r = 5 + k * 16
      // the ranks lose their nerve
      g.forces?.horde.terrify(c.x, c.z, 50 + k * 160, 1.2)
      g.damage({ t: 'ring', c, r0: 0, r1: r, h: c.y + 4 }, { id: newHitId(), kind: 'slam', dmg: 60, power: 8 + k * 18, origin: c, friendly: true })
      if (p.altitude < 3) {
        fx.ring(_p.copy(c).setY(c.y + 0.08), r * 1.2, '#ffe2b0', 0.45, { thick: 0.08, alpha: 0.6 + k * 0.4 })
        fx.gpu.dustMotes(_p.copy(c).setY(c.y + 0.1), 30 + k * 40, 1.5, { out: r * 1.6, up: 1.2, size: 0.35, life: 1.4 })
      }
    }
    if (k >= 1 && !this.full) {
      this.full = true
      g.aura.flare(0.35)
      fx.flare(_p.copy(_hilt).addScaledVector(axis, 6), 7, '#fff0c8', 0.35, 0.7)
      g.sky.flash(UP, 0.9, '#ffe2b0')
      if (p.altitude < 2) {
        // the ground gives under the stance
        g.terrain.crater(p.pos.x, p.pos.z, 6, 0.6, { rim: 0.5, ejecta: 0.4 })
        if (p.grounded) p.pos.y = g.terrain.heightAt(p.pos.x, p.pos.z)
        fx.ring(_p.copy(p.pos).setY(p.pos.y + 0.1), 18, '#ffd8a0', 0.6, { thick: 0.1, alpha: 0.9 })
        fx.gpu.dustMotes(_p, 90, 3, { out: 16, up: 2, size: 0.4, life: 1.8 })
        fx.debris.burst(_p, 10, 9, 0.18, 0.3)
      }
      audio.landing(1.2)
      if (p.divinity < WORLD_COST) useUI.getState().stamp(`WORLDSPLITTER NEEDS ${WORLD_COST} DIVINITY`, 'warn')
    }
  }

  /** The blade comes down without a Worldsplitter (cancelled, or let go early). */
  cancel() {
    if (!this.charging) return
    this.charging = false
    this.charge = 0
    this.snd?.stop(0.15)
    this.snd = null
    this.fx.placeGlow(_hilt, 0, 0)
    this.bladeFade = Math.max(this.bladeFade, 0.25)
    this.g.levitate.drop()
  }

  /** Is the blade fully raised and paid for? */
  get canRelease() {
    return this.charge >= 1 && this.g.player.divinity >= WORLD_COST
  }

  // -------------------------------------------------------------------------
  // The Worldsplitter: the swing
  // -------------------------------------------------------------------------

  /** The swing begins: the blade of light starts its fall. */
  worldsplit() {
    const g = this.g
    const p = g.player
    this.charging = false
    this.snd?.stop(0.05)
    this.snd = null
    this.fx.placeGlow(_hilt, 0, 0)
    p.divinity = Math.max(0, p.divinity - WORLD_COST)
    p.invuln = Math.max(p.invuln, 1.8)
    const aim = this.aim(_a)
    this.wdir.set(aim.x, 0, aim.z)
    if (this.wdir.lengthSq() < 1e-6) this.wdir.set(Math.sin(p.yaw), 0, Math.cos(p.yaw))
    this.wdir.normalize()
    // a falling moon roughly ahead draws the cut onto it
    const moon = g.forces?.eclipse.moonTarget
    if (moon && headingGap(_v.subVectors(moon, p.pos), this.wdir) < MOON_ASSIST) this.wdir.set(_v.x, 0, _v.z).normalize()
    p.yaw = Math.atan2(this.wdir.x, this.wdir.z)
    this.bladeLen = Math.max(this.bladeLen, BLADE_MAX)
    this.bladePow = 1
    g.time.divine(0.9, 0.45)
    g.cam.addTrauma(0.3)
    audio.worldSwing()
    this.playShot()
  }

  /** The blade lands: the world is cut in two along the line, out to the horizon. */
  strike() {
    const g = this.g
    const p = g.player
    const fx = g.fx
    const post = g.post
    const fwd = this.wdir
    const side = sideOf(fwd, new THREE.Vector3())
    this.charge = 0
    const a = new THREE.Vector3(p.pos.x, 0, p.pos.z)
    a.y = g.terrain.heightAt(a.x, a.z)
    const b = a.clone().addScaledVector(fwd, WORLD_RANGE)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(side, a)
    const slab: Shape = { t: 'slab', a, b, r: WORLD_HALF, h: WORLD_HEIGHT }
    const n = g.damage(slab, { id: newHitId(), kind: 'heaven', dmg: 99999, power: 60, origin: a, dir: fwd, plane, friendly: true })
    g.cutProjectiles({ t: 'slab', a, b, r: WORLD_HALF + 6, h: WORLD_HEIGHT })
    eclipsePoint(_b)
    for (const t of g.reflectTargets()) {
      if (!t.alive) continue
      t.aim(_p)
      if (_p.distanceToSquared(_b) < 1) continue
      const o = lineOffset(a, fwd, _p)
      if (o.along > 0 && o.along < WORLD_RANGE && o.off < WORLD_HALF + t.radius) {
        const at = _p.clone()
        fx.after(o.along / 2500, () => t.alive && t.struck(TARGET_DMG, at, 'heaven'))
      }
    }
    const ecl = g.forces?.eclipse
    if (ecl?.alive && eclipseHeading(fwd) < ECLIPSE_AIM) fx.after(0.45, () => this.cutEclipse())
    // the ground: a trench from the hero's feet into a canyon across the world, through the mountains
    const seed = (Math.random() * 1e6) | 0
    const start = CANYON_W / 2 + 10
    g.terrain.trench(a.x + fwd.x * 2.5, a.z + fwd.z * 2.5, a.x + fwd.x * (start + 30), a.z + fwd.z * (start + 30), 7, 7, { seed, lip: 0.3 })
    g.scorch.fissure(a.x + fwd.x * 2, a.z + fwd.z * 2, a.x + fwd.x * 400, a.z + fwd.z * 400, 4, 1)
    g.canyon(a.x + fwd.x * start, a.z + fwd.z * start, b.x, b.z, CANYON_W, CANYON_D, { rampIn: 70, jag: 0.18, taper: 500, seed })
    // the sky: split from overhead to the horizon
    g.sky.part(fwd, { width: 0.75, ring: 1, tear: 1.1 })
    g.sky.flash(fwd, 1, '#ffe2b8')
    // light stands up along the whole cut and tears out to the horizon
    this.fx.curtain(a, fwd, WORLD_RANGE, 900, 4200, 2.6)
    fx.sparkWall(_p.copy(a).addScaledVector(fwd, 6), _w.copy(a).addScaledVector(fwd, 320), Math.round(4500 * g.q), 70, FIRE, 0.12)
    for (let i = 0; i < 3; i++) {
      g.slashes.fire(_p.copy(a).addScaledVector(fwd, 8 + i * 10).setY(a.y + 20 + i * 18), fwd, { width: 70 + i * 40, roll: Math.PI / 2, dmg: 0, speed: 1500 - i * 300, life: 2.2, color: '#ffcf70', visualOnly: true })
    }
    this.tearGround(a, fwd, side)
    this.mountainBeat(a, fwd)
    g.forces?.horde.terrify(a.x, a.z, 500, 5)
    // the hero's power is spent all at once
    this.bladeLen = BLADE_STRIKE
    this.bladeFade = 0.7
    g.aura.flare(0.3, undefined, false)
    g.levitate.release(fwd, 2.2)
    if (p.altitude < 4) {
      const gp = _p.copy(p.pos)
      g.terrain.crater(gp.x, gp.z, 9, 1.2, { rim: 0.6, ejecta: 0.8 })
      if (p.grounded) p.pos.y = g.terrain.heightAt(p.pos.x, p.pos.z)
      gp.y = g.terrain.heightAt(gp.x, gp.z)
      fx.ring(_w.copy(gp).setY(gp.y + 0.12), 70, '#ffd8a0', 0.9, { thick: 0.06, alpha: 1 })
      fx.debris.burst(_w.copy(gp).setY(gp.y + 0.4), 30, 22, 0.3, 0.4, 0.8)
      fx.gpu.plasmaRing(_w.copy(gp).setY(gp.y + 0.3), UP, 80, Math.round(1000 * g.q), GOLD, { expand: 0.7, fill: 0.5, thick: 0.2, life: 1.3, size: 0.08, stretch: 0.04, heat: 2 })
    }
    fx.light(_p.copy(a).addScaledVector(fwd, 30).setY(a.y + 10), '#ffe0b0', 400, 160, 3)
    g.gust(_p.copy(p.pos).addScaledVector(fwd, -10), 36)
    // the screen: split down the line, flash frames, light pouring through the cut
    post.impactFrames([2, 1, 2, 0], 1 / 20)
    post.flashTo(0.14, '#fff2e0', 5)
    post.kickZoom(0.14, _p.copy(a).addScaledVector(fwd, 60).setY(a.y + 10), g.camera)
    post.speedLines(0.9, 0.5)
    post.kickChroma(0.7)
    post.shock(_p.copy(a).setY(a.y + 1.5), g.camera, 0.06, { speed: 1.3, width: 1.6 })
    post.rays(_p.copy(a).addScaledVector(fwd, 80).setY(a.y + 25), 1, 2.4, '#ffe4bc')
    post.streak(0.8, _p)
    post.cutWorld(_p.copy(a).addScaledVector(fwd, 120), _w.copy(a).addScaledVector(fwd, 120).setY(a.y + 160), 0.05, 1.3, 0.35, g.camera)
    g.cam.addTrauma(1)
    g.cam.kick(_v.set(0, -1, 0), 0.35)
    g.time.freeze(0.16)
    g.time.divine(1.8, 0.35)
    audio.worldSplit()
    audio.deafen(1.5, 0.6)
    audio.duck(0.9, 3)
    g.rumble(1, 1, 1000)
    fx.after(0.2, () => audio.skyRip())
    g.score.feat('worldsplit', 1)
    useUI.getState().stamp(n > 0 ? 'WORLDSPLITTER' : 'THE WORLD, SPLIT', 'divine')
  }

  /** Dust walls peel off both lips of the cut, rock sprays out of it, embers hang in the trench. */
  private tearGround(a: THREE.Vector3, fwd: THREE.Vector3, side: THREE.Vector3) {
    const g = this.g
    const fx = g.fx
    const q = g.q
    const steps = Math.round(26 * Math.max(0.5, q))
    for (let i = 0; i < steps; i++) {
      const d = 18 + Math.pow(i / steps, 1.4) * 900
      fx.after(d / 2500, () => {
        _a.copy(a).addScaledVector(fwd, d)
        _a.y = g.terrain.heightAt(_a.x, _a.z) + 1
        const big = 1 + d * 0.006
        for (const sgn of [-1, 1]) {
          _p.copy(_a).addScaledVector(side, sgn * (CANYON_W * 0.5 + 2))
          _p.y = g.terrain.heightAt(_p.x, _p.z) + 1
          for (let k = 0; k < 2; k++) {
            _v.copy(side).multiplyScalar(sgn * (14 + Math.random() * 18) * big).addScaledVector(fwd, 6 + Math.random() * 10).setY((10 + Math.random() * 16) * Math.sqrt(big))
            fx.smoke.spawn(_p, _v, DUST, 0.55, (4 + Math.random() * 4) * big, 2 + Math.random() * 2, -0.4, 1.3, { grow: 2.4 })
          }
          fx.gpu.dustMotes(_p, 30, 3 * big, { out: 14 * big, up: 6 * big, size: 0.45 * big, life: 2.4 })
        }
        if (d < 400) {
          fx.debris.burst(_a, Math.round(4 + 6 * (1 - d / 400)), 30, 0.6, 0.7, 1.3)
          fx.emberDrift(_a, 40, 8, { height: 3, rise: 4, burst: 6, life: 2.4, size: 0.12 })
        }
      })
    }
  }

  /** Where the cut meets the mountains, the world answers late: light, thunder, a pillar of dust. */
  private mountainBeat(a: THREE.Vector3, fwd: THREE.Vector3) {
    const g = this.g
    let d = 600
    for (; d < 4000; d += 40) if (g.far.heightAt(a.x + fwd.x * d, a.z + fwd.z * d) > 80) break
    if (d >= 4000) return
    const at = new THREE.Vector3(a.x + fwd.x * d, 0, a.z + fwd.z * d)
    at.y = Math.max(g.far.heightAt(at.x, at.z), 60) * 0.6
    g.fx.after(d / 2500, () => {
      const fx = g.fx
      fx.flare(at, 160, '#ffe0b0', 0.6, 0.8)
      fx.light(at, '#ffcf90', 900, 1600, 2)
      for (let i = 0; i < 10; i++) {
        _p.copy(at).add(_v.set((Math.random() - 0.5) * 90, Math.random() * 80, (Math.random() - 0.5) * 90))
        _v.set((Math.random() - 0.5) * 30, 30 + Math.random() * 50, (Math.random() - 0.5) * 30)
        fx.smoke.spawn(_p, _v, DUST, 0.5, 60 + Math.random() * 70, 6 + Math.random() * 4, -0.2, 0.25, { grow: 1.6 })
      }
      g.sky.flash(fwd, 0.6, '#ffcf9a')
    })
    g.fx.after(0.9 + d / 1400, () => {
      audio.rumble(1, 5)
      audio.nukeShock()
      g.rumble(0.75, 0.35, 1100)
      g.cam.addTrauma(0.45)
    })
  }

  private cutEclipse() {
    const g = this.g
    const ecl = g.forces?.eclipse
    if (!ecl) return
    const hp = ecl.hp
    ecl.hurt(ECLIPSE_DMG)
    if (ecl.hp < hp) {
      useUI.getState().stamp('THE ECLIPSE, CUT', 'divine')
      audio.roar(eclipsePoint(_p), 0.35)
      g.cam.addTrauma(0.5)
    }
  }

  /** Off the hero's shoulder, low: the blade falls across the frame, then the view follows the cut to the horizon. Any input skips it. */
  private playShot() {
    const g = this.g
    if (g.cam.cinematic) return
    const p0 = g.player.pos.clone()
    const flat = this.wdir.clone()
    const side = sideOf(flat, new THREE.Vector3())
    this.shotT = 0
    g.cam.play({
      dur: 3.4,
      blendIn: 0.3,
      blendOut: 0.9,
      frame: (t, pos, look) => {
        this.shotLive = true
        this.shotT = t
        const e = smoothstep(0.2, 2.8, t)
        const down = smoothstep(0.15, 0.75, t)
        pos.copy(p0).addScaledVector(flat, -(16 + 34 * e)).addScaledVector(side, -(14 + 22 * e))
        pos.y = p0.y + 3 + 46 * e
        look.copy(p0).addScaledVector(flat, 60 + 900 * down + 600 * e)
        look.y = p0.y + 260 * (1 - down) + 40 * down
        return 72 - 10 * e
      },
    })
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** Every hero frame: cooldowns, the pending sheathe, and letting any input cut the release cinematic short. */
  tick(dt: number, f: InputFrame, enabled: boolean) {
    this.cd -= dt
    this.hcd -= dt
    this.counterT -= dt
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const s = this.pending[i]
      s.t -= dt
      if (s.t <= 0) {
        this.pending.splice(i, 1)
        this.sheathe(s)
      }
    }
    // a cutscene can take the hero out of the stance without a state change of ours
    const st = this.g.player.state
    if (this.charging && st !== 'wcharge' && st !== 'wsplit') this.cancel()
    if (!this.charging) this.fx.placeGlow(_hilt, 0, 0)
    const live = this.shotLive
    this.shotLive = false
    if (!live || !enabled || this.shotT < 0.9) return
    const any = f.slash || f.parry || f.dash || f.jump || f.art || f.ult || f.heavy || Math.hypot(f.moveX, f.moveY) > 0.3 || Math.abs(f.lookX) + Math.abs(f.lookY) > 0.03
    if (any) this.g.cam.stopShot()
  }

  /** After the hero's pose is set for the frame: the blade of light follows the sword. */
  place(dt: number) {
    const st = this.g.player.state
    const held = st === 'wcharge' || (st === 'wsplit' && this.bladeFade <= 0)
    if (!held && this.bladeFade > 0) {
      this.bladeFade -= dt
      this.bladePow = Math.max(0, this.bladeFade / 0.7)
    }
    if (!held && this.bladeFade <= 0) {
      this.fx.placeBlade(_hilt, _q, 0, 0, 0)
      return
    }
    bladeFrame(this.g.player.model.rig.handR, _hilt, _q, 0.12)
    const len = this.bladeLen
    this.fx.placeBlade(_hilt, _q, len, 1.6 + Math.min(len, BLADE_MAX) * 0.03, this.bladePow)
  }

  update(dt: number) {
    this.fx.update(dt)
  }

  reset() {
    this.cancel()
    this.cd = 0
    this.hcd = 0
    this.counterT = 0
    this.charge = 0
    this.full = false
    this.pending.length = 0
    this.bladeFade = 0
    this.bladePow = 0
    this.shotLive = false
    this.fx.clear()
  }
}
