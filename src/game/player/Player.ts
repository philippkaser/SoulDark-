import * as THREE from 'three'
import { audio, type LoopHandle } from '../../audio/audio'
import { clamp, damp, turnToward, wrapAngle } from '../../engine/math'
import { Avatar } from '../../engine/rig/avatar'
import type { InputFrame } from '../../input/input'
import type { Game } from '../Game'
import { newHitId, type ParryResult, type Tier } from '../types'
import { ARENA_HARD, ARENA_R } from '../world/layout'
import { HIT_AT } from './heroClips'
import { buildHero, type HeroModel } from './heroModel'

export type PState =
  | 'free'
  | 'air'
  | 'slash'
  | 'airslash'
  | 'dash'
  | 'parry'
  | 'guard'
  | 'catch'
  | 'charge'
  | 'cleave'
  | 'dive'
  | 'land'
  | 'hurt'
  | 'judgment'
  | 'cine'
  | 'dead'
  | 'victory'

export const TIER_N: Record<Tier, number> = { small: 0, medium: 1, large: 2, cosmic: 3 }

const RUN = 11
const GRAVITY = 52
const PERFECT = 0.2
/** Bigger, slower, better-telegraphed threats allow a slightly longer window. */
const PERFECT_BY_TIER = [0.2, 0.2, 0.25, 0.3]
const MAX_HP = 1000
const CHARGE_TIME = 1.1

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _chest = new THREE.Vector3()
const _dir = new THREE.Vector3()

export class Player {
  readonly model: HeroModel
  readonly avatar: Avatar
  readonly pos = new THREE.Vector3()
  readonly vel = new THREE.Vector3()
  yaw = Math.PI
  state: PState = 'free'
  t = 0
  grounded = true
  hp = MAX_HP
  readonly maxHp = MAX_HP
  divinity = 0
  godMode = false
  /** Seconds since parry was pressed. */
  parryT = 99
  /** Highest tier parried during the current press (to avoid stacking spectacle). */
  private parriedTier = -1
  private parryLag = 0
  combo = 0
  private queued: 'slash' | null = null
  private fired = false
  charge = 0
  private chargeSnd: LoopHandle | null = null
  private chargeFull = false
  dashCd = 0
  private dashDir = new THREE.Vector3()
  private ghostTimer = 0
  invuln = 0
  lastHurt = 99
  speed = 0
  private moveAngle = 0
  private turnRate = 0
  private lastYaw = Math.PI
  private aimYaw = Math.PI
  private game: Game
  /** Judgment timeline state. */
  private jCuts = 0
  private jTimer = 0
  private energyFade = 0
  /** Externally driven pose (cinematics). */
  cineClip: string | null = null
  cineT = 0
  /** For the HUD: recent perfect parries. */
  perfectCount = 0

  constructor(game: Game) {
    this.game = game
    this.model = buildHero()
    this.avatar = new Avatar(this.model)
  }

  reset(x = 0, z = 0, yaw = Math.PI) {
    this.pos.set(x, 0, z)
    this.vel.set(0, 0, 0)
    this.yaw = this.lastYaw = this.aimYaw = yaw
    this.state = 'free'
    this.t = 0
    this.grounded = true
    this.hp = MAX_HP
    this.divinity = 0
    this.parryT = 99
    this.parryLag = 0
    this.combo = 0
    this.queued = null
    this.charge = 0
    this.chargeSnd?.stop()
    this.chargeSnd = null
    this.invuln = 0
    this.lastHurt = 99
    this.dashCd = 0
    this.model.energyBlade.visible = false
    this.avatar.resetCloth()
    this.perfectCount = 0
  }

  get alive() {
    return this.state !== 'dead'
  }

  get chest() {
    return _chest.set(this.pos.x, this.pos.y + 1.3, this.pos.z)
  }

  chestPos(out: THREE.Vector3) {
    return out.set(this.pos.x, this.pos.y + 1.3, this.pos.z)
  }

  /** Can threats touch the hero right now? */
  get untouchable() {
    return this.invuln > 0 || this.state === 'judgment' || this.state === 'dive' || this.state === 'cine' || this.state === 'victory'
  }

  get guarding() {
    return this.state === 'guard' || this.state === 'catch' || (this.state === 'parry' && this.parryT >= PERFECT)
  }

  get inPerfectWindow() {
    return this.state === 'parry' && this.parryT < PERFECT
  }

  /** 0..1 for the HUD's guard indicator. */
  get parryWindow() {
    return this.state === 'parry' ? clamp(1 - this.parryT / PERFECT, 0, 1) : 0
  }

  // -------------------------------------------------------------------------
  // Defence: every threat asks the hero what happens when it arrives
  // -------------------------------------------------------------------------

  /**
   * A threat of `tier` arrives from `from`. Returns 'perfect' (it will be sent
   * back), 'guard' (blocked) or 'none' (it lands). 'dodge' is reported as none
   * with `untouchable` for the caller to check first.
   */
  defend(tier: Tier, from: THREE.Vector3, quiet = false): ParryResult {
    if (!this.alive || this.state === 'cine') return 'none'
    const n = TIER_N[tier]
    if (this.state === 'parry' && this.parryT < PERFECT_BY_TIER[n]) {
      if (!quiet && n > this.parriedTier) {
        this.parriedTier = n
        this.parrySpectacle(n, from)
      } else {
        const p = this.chestPos(_v)
        this.game.fx.spark(p, _w.subVectors(from, p).normalize(), 10, 10)
      }
      if (!quiet) {
        // a perfect parry re-arms the window, so a whole salvo goes home in one chain
        this.parryT = Math.min(this.parryT, -0.3)
        this.t = Math.min(this.t, 0.04)
      }
      return 'perfect'
    }
    if (this.guarding) {
      if (!quiet) this.blockFx(n, from)
      return 'guard'
    }
    return 'none'
  }

  private parrySpectacle(n: number, from: THREE.Vector3) {
    const g = this.game
    const p = this.chestPos(_v).clone()
    const toward = _w.subVectors(from, p).normalize()
    const hitP = p.clone().addScaledVector(toward, 1.1)
    g.fx.parryBurst(hitP, toward, n)
    audio.parry(n, true)
    if (n >= 1) audio.musicSting(n >= 2 ? 'big' : 'parry')
    g.time.freeze([0.05, 0.085, 0.13, 0.24][n])
    g.time.divine([0.5, 1.0, 1.4, 1.8][n], [0.45, 0.25, 0.18, 0.12][n])
    g.post.flashTo([0.08, 0.15, 0.3, 0.6][n], '#fff4dc', 6)
    if (n >= 1) g.post.impactFrames(n >= 3 ? [1, 2, 1, 2, 0] : n >= 2 ? [1, 2, 0] : [1, 0])
    g.post.kickZoom([0.05, 0.12, 0.2, 0.3][n], hitP, g.camera)
    g.post.speedLines([0.4, 0.8, 1, 1][n], 0.15 + n * 0.1)
    g.post.kickChroma(0.6 + n * 0.5)
    if (n >= 2) g.post.shock(hitP, g.camera, 0.02 + n * 0.008)
    g.cam.addTrauma(0.25 + n * 0.18)
    g.cam.kickFov(-4 - n * 2)
    g.score.parry(n)
    this.gainDivinity(6 + n * 8)
    this.perfectCount++
    // the hero snaps to face the threat and flicks the blade
    this.yaw = Math.atan2(toward.x, toward.z)
    this.t = 0.04
    this.model.glowMat.emissiveIntensity = 20
  }

  private blockFx(n: number, from: THREE.Vector3) {
    const g = this.game
    const p = this.chestPos(_v)
    const toward = _w.subVectors(from, p).normalize()
    g.fx.impact(p.clone().addScaledVector(toward, 1), toward, 1 + n * 0.6, '#ffd8a0')
    audio.block()
    g.cam.addTrauma(0.15 + n * 0.12)
    g.time.freeze(0.03 + n * 0.02)
    // pushed back along the ground
    this.vel.addScaledVector(toward, -(6 + n * 6))
  }

  /** Take damage. Big hits stagger. */
  hurt(dmg: number, from: THREE.Vector3, knock = 0) {
    if (!this.alive || this.untouchable) return
    const g = this.game
    if (!this.godMode) this.hp = Math.max(0, this.hp - dmg)
    this.lastHurt = 0
    g.post.hurt = Math.min(1, g.post.hurt + Math.min(0.7, 0.1 + dmg / 250) * (this.godMode ? 0.4 : 1))
    g.cam.addTrauma(0.15 + Math.min(0.6, dmg / 400))
    audio.hurt(dmg >= 80)
    if (!this.godMode) g.score.hurt(dmg)
    if (knock > 0) {
      _v.subVectors(this.pos, from).setY(0).normalize()
      this.vel.addScaledVector(_v, knock)
    }
    if (this.hp <= 0) {
      this.die()
      return
    }
    if (dmg >= 90 && this.state !== 'charge') this.enter('hurt')
  }

  die() {
    this.state = 'dead'
    this.t = 0
    this.stopCharge()
    this.game.onPlayerDeath()
  }

  gainDivinity(a: number) {
    this.divinity = Math.min(100, this.divinity + a)
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  private enter(s: PState) {
    if (this.state === 'charge' && s !== 'cleave') this.stopCharge()
    this.state = s
    this.t = 0
    this.fired = false
  }

  private stopCharge() {
    this.chargeSnd?.stop()
    this.chargeSnd = null
    if (this.state !== 'cleave') this.model.energyBlade.visible = false
  }

  update(dt: number, f: InputFrame, enabled: boolean) {
    const g = this.game
    this.t += dt
    this.parryT += dt
    this.parryLag -= dt
    this.dashCd -= dt
    this.invuln -= dt
    this.lastHurt += dt
    if (this.lastHurt > 3 && this.alive && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + 45 * dt)

    // aim
    this.aimYaw = g.cam.aimYaw
    // camera-relative movement input
    const cy = Math.cos(g.cam.yaw)
    const sy = Math.sin(g.cam.yaw)
    const mag = enabled ? Math.min(1, Math.hypot(f.moveX, f.moveY)) : 0
    let mx = 0
    let mz = 0
    if (mag > 0.1) {
      mx = f.moveY * sy - f.moveX * cy
      mz = f.moveY * cy + f.moveX * sy
      const l = Math.hypot(mx, mz)
      mx /= l
      mz /= l
    }
    const want = (x: boolean) => enabled && x
    const s = this.state

    // ---- universal cancels: the hero is never stuck
    const cancellable = s === 'free' || s === 'air' || s === 'guard' || s === 'land' || ((s === 'slash' || s === 'airslash') && this.fired) || (s === 'cleave' && this.t > 0.3) || (s === 'parry' && this.parryT > 0.12)
    if (cancellable || s === 'charge' || s === 'catch') {
      if (want(f.parry) && this.parryLag <= 0) return this.startParry()
      if (want(f.dash) && this.dashCd <= 0) return this.startDash(mx, mz)
    }
    if (cancellable && want(f.ult)) {
      if (g.onUltimate?.()) return
      if (this.divinity >= 100) return this.startJudgment()
    }

    switch (this.state) {
      case 'free':
      case 'guard': {
        const guard = this.state === 'guard'
        this.locomote(dt, mx, mz, mag, guard ? 3 : RUN)
        if (guard) {
          this.yaw = turnToward(this.yaw, this.aimYaw, 10 * dt)
          if (!f.guard) this.enter('free')
        }
        if (want(f.slash)) this.startSlash(1)
        else if (want(f.jump)) this.leap()
        else if (want(f.heavy)) this.startCharge()
        break
      }
      case 'air': {
        this.airborne(dt, mx, mz)
        if (want(f.slash)) this.enter('airslash')
        else if (want(f.jump)) this.startDive()
        else if (want(f.heavy)) this.startCharge()
        break
      }
      case 'slash': {
        this.locomote(dt, 0, 0, 0, 0)
        this.yaw = turnToward(this.yaw, this.aimYaw, 30 * dt)
        const clip = `slash${this.combo}`
        const dur = this.combo === 4 ? 0.66 : this.combo === 3 ? 0.46 : 0.42
        if (!this.fired && this.t >= HIT_AT[clip]) this.fireSlash(this.combo)
        if (want(f.slash)) this.queued = 'slash'
        if (this.fired && this.queued && this.t > HIT_AT[clip] + 0.06) {
          this.queued = null
          this.startSlash(this.combo >= 4 ? 1 : this.combo + 1)
        } else if (want(f.jump) && this.fired) this.leap()
        else if (this.t >= dur) {
          this.enter('free')
          this.combo = 0
        }
        break
      }
      case 'airslash': {
        this.yaw = turnToward(this.yaw, this.aimYaw, 30 * dt)
        // aerial swings hold you up
        this.vel.y = Math.max(this.vel.y - GRAVITY * 0.25 * dt, -2)
        this.integrate(dt)
        if (!this.fired && this.t >= HIT_AT.airslash) this.fireAirSlash()
        if (want(f.slash) && this.fired && this.t > 0.16) this.enter('airslash')
        else if (want(f.jump) && this.fired) this.startDive()
        else if (this.t >= 0.36) this.enter(this.grounded ? 'free' : 'air')
        if (this.grounded && this.state === 'airslash' && this.t > 0.2) this.enter('free')
        break
      }
      case 'dash':
        this.updateDash(dt)
        break
      case 'parry': {
        this.locomote(dt, 0, 0, 0, 0, !this.grounded)
        if (this.t < 0.05 && this.parryT < 0.05) this.yaw = turnToward(this.yaw, this.aimYaw, 40 * dt)
        if (this.t >= 0.34) {
          if (f.guard) this.enter('guard')
          else {
            // a whiffed parry costs a moment before the next
            if (this.parriedTier < 0) this.parryLag = 0.08
            this.enter(this.grounded ? 'free' : 'air')
          }
        }
        break
      }
      case 'catch':
        this.locomote(dt, 0, 0, 0, 0)
        this.yaw = turnToward(this.yaw, this.aimYaw, 12 * dt)
        break
      case 'charge':
        this.updateCharge(dt, f, mx, mz, mag)
        break
      case 'cleave': {
        this.locomote(dt, 0, 0, 0, 0, !this.grounded)
        if (!this.fired && this.t >= HIT_AT.cleave) this.fireCleave()
        if (this.t >= 0.62) this.enter(this.grounded ? 'free' : 'air')
        break
      }
      case 'dive': {
        this.vel.y = -95
        this.integrate(dt)
        if (Math.random() < dt * 60) g.fx.afterimage('#ffcf80', 0.25, 0.6)
        if (this.grounded) this.slamLanding()
        break
      }
      case 'land':
        this.locomote(dt, 0, 0, 0, 0)
        if (this.t > 0.32 && (want(f.slash) || mag > 0.5)) this.enter('free')
        if (this.t >= 0.62) this.enter('free')
        break
      case 'hurt':
        this.locomote(dt, 0, 0, 0, 0)
        if (this.t >= 0.34) this.enter(this.grounded ? 'free' : 'air')
        break
      case 'judgment':
        this.updateJudgment(dt)
        break
      case 'dead':
        this.vel.multiplyScalar(Math.exp(-dt * 6))
        break
      case 'cine':
      case 'victory':
        break
    }

    if (this.state !== 'parry') this.parriedTier = -1
    this.constrain()
    this.animate(dt)
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  private locomote(dt: number, mx: number, mz: number, mag: number, speed: number, fall = false) {
    const k = damp(this.grounded ? 14 : 3, dt)
    const tx = mx * speed * Math.max(0.35, mag)
    const tz = mz * speed * Math.max(0.35, mag)
    this.vel.x += (tx - this.vel.x) * k
    this.vel.z += (tz - this.vel.z) * k
    if (this.state === 'free' && mag > 0.1) this.yaw = turnToward(this.yaw, Math.atan2(mx, mz), 16 * dt)
    if (fall || !this.grounded) this.vel.y -= GRAVITY * (this.state === 'parry' || this.state === 'cleave' ? 0.35 : 1) * dt
    this.integrate(dt)
  }

  private airborne(dt: number, mx: number, mz: number) {
    const k = damp(4, dt)
    this.vel.x += (mx * RUN - this.vel.x) * k
    this.vel.z += (mz * RUN - this.vel.z) * k
    if (Math.abs(mx) + Math.abs(mz) > 0.1) this.yaw = turnToward(this.yaw, Math.atan2(mx, mz), 6 * dt)
    this.vel.y -= GRAVITY * dt
    this.integrate(dt)
    if (this.grounded) {
      this.game.fx.dust(_v.copy(this.pos).setY(0.2), 4, 1, 1.2)
      audio.landing(0.3)
      this.enter('free')
    }
  }

  private integrate(dt: number) {
    this.pos.addScaledVector(this.vel, dt)
    if (this.pos.y <= 0) {
      this.pos.y = 0
      if (this.vel.y < 0) this.vel.y = 0
      this.grounded = true
    } else this.grounded = false
  }

  private constrain() {
    // obstacles (rock spires, giants' legs)
    for (const o of this.game.obstacles()) {
      const dx = this.pos.x - o.x
      const dz = this.pos.z - o.z
      const d = Math.hypot(dx, dz)
      const r = o.r + 0.45
      if (d < r && this.pos.y < o.h) {
        const k = (r - d) / Math.max(d, 1e-3)
        this.pos.x += dx * k
        this.pos.z += dz * k
      }
    }
    const d = Math.hypot(this.pos.x, this.pos.z)
    if (d > ARENA_R) {
      const pull = (d - ARENA_R) * 0.08
      this.pos.x -= (this.pos.x / d) * pull
      this.pos.z -= (this.pos.z / d) * pull
    }
    if (d > ARENA_HARD) {
      this.pos.x *= ARENA_HARD / d
      this.pos.z *= ARENA_HARD / d
    }
  }

  private leap() {
    this.enter('air')
    this.vel.y = 25
    this.grounded = false
    this.pos.y += 0.05
    audio.leap()
    this.game.fx.dust(_v.copy(this.pos).setY(0.2), 5, 1.2, 1.5)
    this.game.fx.ring(_v.copy(this.pos).setY(0.1), 4, '#ffe0a8', 0.3, { thick: 0.3 })
  }

  // -------------------------------------------------------------------------
  // Attacks
  // -------------------------------------------------------------------------

  private aimFrom(origin: THREE.Vector3, out: THREE.Vector3) {
    out.subVectors(this.game.cam.aimPoint, origin)
    if (out.lengthSq() < 4) out.copy(this.game.cam.aimDir)
    out.normalize()
    // keep crescents from burying themselves at your feet
    if (out.y < -0.45) {
      out.y = -0.45
      out.normalize()
    }
    return out
  }

  private startSlash(n: number) {
    this.enter('slash')
    this.combo = n
    this.queued = null
    this.yaw = this.aimYaw
    this.vel.multiplyScalar(0.3)
  }

  private fireSlash(n: number) {
    const g = this.game
    this.fired = true
    const origin = this.chestPos(new THREE.Vector3())
    const dir = this.aimFrom(origin, _dir)
    const fwd = _w.set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
    // melee sweep
    const melee = g.damage(
      { t: 'sector', c: this.pos, dir: fwd, range: n === 4 ? 7 : 5.5, cos: Math.cos(1.35), y0: -1, y1: 4 },
      { id: newHitId(), kind: 'slash', dmg: n === 4 ? 400 : 160, power: n === 4 ? 26 : 18, origin: this.pos, dir: fwd, friendly: true },
    )
    const launch = origin.clone().addScaledVector(dir, 1.2)
    const rolls = [0, 0.12, Math.PI - 0.12, -0.75, 0]
    if (n === 4) {
      for (const r of [0.85, -0.85]) g.slashes.fire(launch, dir, { width: 11, roll: Math.PI / 2 + r, dmg: 520, speed: 90, power: 40, color: '#ffc060' })
      g.post.impactFrames([2, 0])
      g.cam.addTrauma(0.35)
      g.time.freeze(0.06)
      g.fx.afterimage('#ffd080', 0.4)
      audio.slash(2)
    } else {
      g.slashes.fire(launch, dir, { width: 6.5, roll: rolls[n], dmg: 240, color: '#ffb850' })
      audio.slash(1)
    }
    audio.airSlash()
    g.cam.kick(dir, 0.08)
    g.post.kickChroma(0.25)
    if (melee > 0) {
      g.time.freeze(n === 4 ? 0.09 : 0.045)
      g.cam.addTrauma(0.12)
    }
  }

  private fireAirSlash() {
    const g = this.game
    this.fired = true
    const origin = this.chestPos(new THREE.Vector3())
    const dir = this.aimFrom(origin, _dir)
    g.damage(
      { t: 'sphere', c: origin, r: 4 },
      { id: newHitId(), kind: 'slash', dmg: 160, power: 16, origin, friendly: true },
    )
    g.slashes.fire(origin.clone().addScaledVector(dir, 1.2), dir, { width: 7, roll: 0.75, dmg: 240, color: '#ffb850' })
    audio.slash(1)
    audio.airSlash()
  }

  private startCharge() {
    this.enter('charge')
    this.charge = 0
    this.chargeFull = false
    this.chargeSnd = audio.charge()
    this.model.energyBlade.visible = true
    this.model.energyU.uPower.value = 0
  }

  private updateCharge(dt: number, f: InputFrame, mx: number, mz: number, mag: number) {
    const g = this.game
    if (this.grounded) this.locomote(dt, mx, mz, mag, 2.5)
    else {
      // hover in the air while gathering power
      this.vel.y = Math.max(this.vel.y - GRAVITY * 0.2 * dt, -1.5)
      this.vel.x *= Math.exp(-dt * 3)
      this.vel.z *= Math.exp(-dt * 3)
      this.integrate(dt)
    }
    this.yaw = turnToward(this.yaw, this.aimYaw, 10 * dt)
    this.charge = Math.min(1, this.charge + dt / CHARGE_TIME)
    const k = this.charge
    this.chargeSnd?.set(k)
    this.model.energyU.uLen.value = 2 + k * k * 70
    this.model.energyU.uPower.value = 0.4 + k * 0.6
    g.cam.addTrauma(dt * (0.2 + k * 1.2))
    // power gathers: light streams in, the ground stirs
    const n = Math.floor(dt * (60 + k * 240))
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const r = 4 + Math.random() * 10
      _v.set(this.pos.x + Math.sin(a) * r, this.pos.y + Math.random() * 5, this.pos.z + Math.cos(a) * r)
      _w.set(this.pos.x - _v.x, this.pos.y + 1.6 - _v.y, this.pos.z - _v.z).multiplyScalar(2.2)
      g.fx.glow.spawn(_v, _w, [1, 0.8, 0.45], 0.9, 0.06 + Math.random() * 0.06, 0.45, 0, 0)
    }
    if (this.grounded && Math.random() < dt * (4 + k * 14)) g.fx.dust(_v.copy(this.pos).setY(0.3), 1, 3 + k * 4, 1.4)
    if (k >= 1 && !this.chargeFull) {
      this.chargeFull = true
      g.fx.flare(_v.copy(this.pos).setY(this.pos.y + 2), 8, '#fff0c0', 0.4)
      g.fx.ring(_v.copy(this.pos).setY(0.1), 12, '#ffd890', 0.6, { thick: 0.15 })
      g.post.flashTo(0.12, '#fff2d0', 5)
      audio.parry(0, false)
    }
    if (!f.heavy) {
      if (this.charge < 0.12) {
        this.stopCharge()
        this.enter(this.grounded ? 'free' : 'air')
      } else {
        this.chargeSnd?.stop(0.05)
        this.chargeSnd = null
        this.enter('cleave')
      }
    }
  }

  /** The Heaven Splitter: a cut through the world along the aim. */
  private fireCleave() {
    const g = this.game
    this.fired = true
    const k = this.charge
    const len = 30 + 290 * k
    const half = 2 + 4 * k
    const fwd = new THREE.Vector3(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw))
    this.yaw = this.aimYaw
    const a = new THREE.Vector3(this.pos.x, 0, this.pos.z).addScaledVector(fwd, 1.5)
    const b = a.clone().addScaledVector(fwd, len)
    const normal = new THREE.Vector3(fwd.z, 0, -fwd.x)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, a)
    g.damage({ t: 'slab', a, b, r: half, h: 60 + len }, { id: newHitId(), kind: 'heaven', dmg: 500 + 3500 * k * k, power: 30 + 25 * k, origin: a, dir: fwd, plane, friendly: true })
    g.cutProjectiles({ t: 'slab', a, b, r: half + 2, h: 60 + len })
    g.cleaveFx(a, b, fwd, k)
    this.model.energyU.uLen.value = len
    this.energyFade = 0.45
    audio.cleave(k)
    g.score.feat('heaven', k)
    this.charge = 0
  }

  private startDive() {
    this.enter('dive')
    this.invuln = 0.4
    audio.dive()
    this.vel.x = Math.sin(this.aimYaw) * 4
    this.vel.z = Math.cos(this.aimYaw) * 4
  }

  private slamLanding() {
    const g = this.game
    this.enter('land')
    this.vel.set(0, 0, 0)
    const p = this.pos.clone()
    g.damage({ t: 'sphere', c: p, r: 15 }, { id: newHitId(), kind: 'slam', dmg: 380, power: 34, origin: p, friendly: true })
    g.fx.groundShock(p, 22)
    g.fx.flare(_v.copy(p).setY(0.6), 12, '#fff0c8', 0.3)
    g.fx.light(_v.copy(p).setY(2), '#ffd090', 400, 40, 5)
    g.cam.addTrauma(0.75)
    g.post.kickZoom(0.18)
    g.post.impactFrames([2, 0])
    g.time.freeze(0.08)
    audio.landing(2)
    g.score.feat('slam', 1)
  }

  private startDash(mx: number, mz: number) {
    const g = this.game
    this.stopCharge()
    this.model.energyBlade.visible = false
    this.enter('dash')
    if (Math.abs(mx) + Math.abs(mz) < 0.1) {
      mx = Math.sin(this.aimYaw)
      mz = Math.cos(this.aimYaw)
    }
    this.dashDir.set(mx, 0, mz).normalize()
    this.yaw = Math.atan2(mx, mz)
    this.dashCd = 0.32
    this.invuln = 0.28
    this.ghostTimer = 0
    this.vel.set(this.dashDir.x * 95, Math.max(0, this.vel.y * 0.2), this.dashDir.z * 95)
    audio.dash()
    g.post.speedLines(0.9, 0.05)
    g.cam.kickFov(14)
    g.fx.afterimage('#ffd080', 0.4)
  }

  private updateDash(dt: number) {
    const g = this.game
    const prev = this.pos.clone()
    this.integrate(dt)
    this.ghostTimer -= dt
    if (this.ghostTimer <= 0) {
      this.ghostTimer = 0.025
      g.fx.afterimage('#ffc070', 0.3, 0.8)
    }
    // flash-step: everything in the path is cut
    g.damage({ t: 'capsule', a: prev.setY(1), b: _v.copy(this.pos).setY(1), r: 1.6 }, { id: newHitId(), kind: 'dash', dmg: 200, power: 14, origin: this.pos, dir: this.dashDir, friendly: true })
    if (this.t >= 0.16) {
      this.vel.multiplyScalar(0.12)
      this.enter(this.grounded ? 'free' : 'air')
    }
  }

  private startParry() {
    this.stopCharge()
    this.model.energyBlade.visible = false
    this.enter('parry')
    this.parryT = 0
    this.parriedTier = -1
    this.yaw = this.aimYaw
    this.vel.x *= 0.2
    this.vel.z *= 0.2
    if (!this.grounded) this.vel.y = Math.max(this.vel.y, 2)
  }

  /** A beam was caught on the blade (Sol Lance): lock into the catch pose. */
  setCatching(on: boolean) {
    if (on && this.state !== 'catch') this.enter('catch')
    else if (!on && this.state === 'catch') this.enter('free')
  }

  // -------------------------------------------------------------------------
  // Judgment: stop time, cut everything, sheathe
  // -------------------------------------------------------------------------

  private startJudgment() {
    const g = this.game
    this.stopCharge()
    this.enter('judgment')
    this.jCuts = 0
    this.jTimer = 0
    this.vel.set(0, 0, 0)
    this.divinity = 0
    g.time.stop(true)
    g.post.desatTarget = 0.88
    g.post.tint.setRGB(0.72, 0.82, 1.15)
    audio.timeStop()
    audio.musicSting('big')
    g.score.feat('judgment', 1)
  }

  private updateJudgment(dt: number) {
    const g = this.game
    const t = this.t
    if (t > 0.55 && t < 1.65) {
      this.jTimer -= dt
      while (this.jTimer <= 0) {
        this.jTimer += 0.035
        const target = g.judgmentPoint(this.jCuts)
        const len = 18 + Math.random() * 40
        _v.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.9, Math.random() - 0.5).normalize()
        const a = target.clone().addScaledVector(_v, -len / 2)
        const b = target.clone().addScaledVector(_v, len / 2)
        g.fx.streak(a, b, 0.25 + Math.random() * 0.3, '#cfe4ff', 2.2)
        audio.judgmentCut(this.jCuts)
        if (this.jCuts % 4 === 0) {
          // flicker of the hero appearing among them
          this.ghostAt(target.x + (Math.random() - 0.5) * 4, target.z + (Math.random() - 0.5) * 4)
        }
        this.jCuts++
      }
    }
    if (t >= 1.7 && t - dt < 1.7) audio.sheathe()
    if (t >= 2.12 && t - dt < 2.12) g.judgmentStrike(this.pos)
    if (t >= 2.7) {
      g.post.desatTarget = 0
      g.post.tint.setRGB(1, 1, 1)
      this.enter('free')
    }
  }

  /** Freeze an afterimage of the hero mid-cut somewhere else. */
  private ghostAt(x: number, z: number) {
    const rig = this.model.rig.root
    const saved = rig.position.clone()
    const savedYaw = rig.rotation.y
    rig.position.set(x, 0, z)
    rig.rotation.y = Math.random() * Math.PI * 2
    rig.updateMatrixWorld(true)
    this.game.fx.afterimage('#bcd8ff', 1.0, 0.9)
    rig.position.copy(saved)
    rig.rotation.y = savedYaw
    rig.updateMatrixWorld(true)
  }

  // -------------------------------------------------------------------------
  // Animation
  // -------------------------------------------------------------------------

  private clip(): string | null {
    switch (this.state) {
      case 'free':
        return null
      case 'air':
        return this.vel.y > 2 ? 'air' : 'fall'
      case 'slash':
        return `slash${this.combo}`
      case 'airslash':
        return 'airslash'
      case 'dash':
        return 'dash'
      case 'parry':
        return 'parry'
      case 'guard':
        return 'guard'
      case 'catch':
        return 'catch'
      case 'charge':
        return 'charge'
      case 'cleave':
        return 'cleave'
      case 'dive':
        return 'dive'
      case 'land':
        return 'land'
      case 'hurt':
        return 'hurt'
      case 'judgment':
        return this.t < 1.68 ? 'iai' : 'sheathe'
      case 'dead':
        return 'death'
      case 'victory':
        return 'victory'
      case 'cine':
        return this.cineClip
    }
  }

  private animate(dt: number) {
    const g = this.game
    const dy = wrapAngle(this.yaw - this.lastYaw)
    this.lastYaw = this.yaw
    this.turnRate += (dy / Math.max(dt, 1e-4) - this.turnRate) * damp(8, dt)
    const hs = Math.hypot(this.vel.x, this.vel.z)
    this.speed += (hs - this.speed) * damp(12, dt)
    if (hs > 0.3) this.moveAngle = wrapAngle(Math.atan2(this.vel.x, this.vel.z) - this.yaw)
    const clip = this.clip()
    const free = clip === null || this.state === 'guard' || this.state === 'charge'
    const wind = g.wind
    this.avatar.update(dt, {
      x: this.pos.x,
      y: this.pos.y,
      z: this.pos.z,
      yaw: this.yaw,
      speed: free && this.grounded ? this.speed : 0,
      moveAngle: this.moveAngle,
      turnRate: this.turnRate,
      action: clip,
      actionT: this.state === 'judgment' && this.t >= 1.68 ? this.t - 1.68 : this.state === 'cine' ? this.cineT : this.t,
      time: g.time.real,
      trail: this.state === 'slash' || this.state === 'airslash' || this.state === 'cleave' || this.state === 'parry',
      sharpness: this.state === 'slash' || this.state === 'parry' || this.state === 'cleave' ? 45 : 30,
      windX: wind.x - this.vel.x * 0.6,
      windZ: wind.z - this.vel.z * 0.6,
      clothDt: dt,
    })
    // the halo turns; it blazes when Judgment is ready
    const ready = this.divinity >= 100
    this.model.halo.rotation.z += dt * (ready ? 3 : 0.6)
    const hm = this.model.halo.children[0] as THREE.Mesh
    const hb = ready ? 6 + Math.sin(g.time.real * 8) * 2 : 3.2
    ;(hm.material as THREE.MeshBasicMaterial).color.setRGB(hb * 1.25, hb * 0.9, hb * 0.45)
    const gm = this.model.glowMat
    gm.emissiveIntensity += ((ready ? 12 : 7) - gm.emissiveIntensity) * damp(6, dt)
    this.model.energyU.uTime.value += dt
    if (this.energyFade > 0) {
      this.energyFade -= dt
      this.model.energyU.uPower.value = Math.max(0, this.energyFade / 0.45)
      if (this.energyFade <= 0) this.model.energyBlade.visible = false
    }
  }
}
