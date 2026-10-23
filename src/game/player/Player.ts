import * as THREE from 'three'
import { audio, type LoopHandle } from '../../audio/audio'
import { clamp, damp, turnToward, wrapAngle } from '../../engine/math'
import { Avatar } from '../../engine/rig/avatar'
import { shapeHitsSphere, type Shape } from '../../engine/geom'
import type { InputFrame } from '../../input/input'
import { useUI } from '../../state/store'
import { slashHitstop } from '../feel'
import { AMBER, FIRE, WHITE_GOLD } from '../fx/particleFx'
import type { Game } from '../Game'
import { newHitId, type ParryResult, type Tier } from '../types'
import { ARENA_HARD, ARENA_R } from '../world/layout'
import { HIT_AT } from './heroClips'
import { buildHero, type HeroModel } from './heroModel'
import { HeroPower } from './power'
import { HOLD_TO_CHARGE, HORIZON_COST, IAI_DRAW, IAI_DUR, IAI_SHEATHE, SwordArts, WORLD_DUR, WORLD_HIT } from './arts'

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
  | 'iai'
  | 'wcharge'
  | 'wsplit'
  | 'hcut'
  | 'chiburi'
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
const UP = new THREE.Vector3(0, 1, 0)

export class Player {
  readonly model: HeroModel
  readonly avatar: Avatar
  /** Aura, levitating rocks, cracks and lightning answering the hero's big moments. */
  readonly power: HeroPower
  /** The sword arts: the Iai's cut through everything around, the Worldsplitter's blade of light. */
  readonly arts: SwordArts
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
  /** Height the meteor dive started from (the slam crater grows with the fall). */
  private diveFrom = 0
  /** Until the next parry counter-crescent may fly. */
  private counterT = 0
  /** This leap has been boosted into a Sky Leap. */
  private skyLeaped = false
  /** The flash-step's path so far, and the cuts along finished ones waiting to land. */
  private dashPath: THREE.Vector3[] = []
  private dashCuts: Array<{ t: number; pts: THREE.Vector3[]; dir: THREE.Vector3 }> = []
  /** Footfalls: metres since the last print, and which foot. */
  private stepDist = 0
  private stepSide = 1
  /** Kills in the last moments (decaying), the soldiers counted so far, and whether a flourish is owed. */
  private killBurst = 0
  private lastKills = 0
  private flourishOwed = false
  private flourishCd = 0
  private idleT = 0

  constructor(game: Game) {
    this.game = game
    this.model = buildHero()
    this.avatar = new Avatar(this.model)
    this.power = new HeroPower(game)
    this.arts = new SwordArts(game)
  }

  reset(x = 0, z = 0, yaw = Math.PI) {
    this.pos.set(x, this.game.terrain.heightAt(x, z), z)
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
    this.power.reset()
    this.arts.cancel()
    this.arts.cd = 0
    this.dashCuts.length = 0
    this.dashPath = []
    this.killBurst = 0
    this.lastKills = 0
    this.flourishOwed = false
    this.flourishCd = 0
  }

  get alive() {
    return this.state !== 'dead'
  }

  /** How far out the hero's aura burns arrows to nothing: while gathering power, and at the top style ranks. */
  get auraBurn() {
    const s = this.state
    if (s === 'charge' || s === 'wcharge' || s === 'judgment' || s === 'hcut') return 9
    const r = this.game.score.rank
    return r >= 6 ? 8 : r >= 5 ? 6 : r >= 4 ? 3.5 : 0
  }

  /** Height above the terrain under the hero. */
  get altitude() {
    return this.pos.y - this.game.terrain.heightAt(this.pos.x, this.pos.z)
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
    this.power.parry(hitP, toward, n)
    audio.parry(n, true)
    if (n >= 1) audio.musicSting(n >= 2 ? 'big' : 'parry')
    g.time.freeze([0.05, 0.085, 0.13, 0.24][n])
    g.time.divine([0.5, 1.0, 1.4, 1.8][n], [0.45, 0.25, 0.18, 0.12][n])
    // the burst itself is blinding at the top tiers: the screen flash stays modest so the hero reads through it
    g.post.flashTo([0.08, 0.14, 0.22, 0.28][n], '#fff4dc', 6)
    // the impact frames stay short and the zoom light: a heavy radial blur over a blinding burst flattens the frame to one tone
    if (n >= 1) g.post.impactFrames(n >= 3 ? [1, 2, 0, 2, 0] : n >= 2 ? [1, 2, 0] : [1, 0])
    g.post.kickZoom([0.05, 0.1, 0.13, 0.15][n], hitP, g.camera)
    g.post.speedLines([0.4, 0.8, 1, 1][n], 0.15 + n * 0.1)
    g.post.kickChroma(0.6 + n * 0.5)
    if (n >= 2) g.post.shock(hitP, g.camera, 0.02 + n * 0.008)
    g.cam.addTrauma(0.25 + n * 0.18)
    g.cam.kickFov(-4 - n * 2)
    g.rumble([0.3, 0.5, 0.8, 1][n], [0.55, 0.65, 0.8, 1][n], [90, 150, 280, 520][n])
    // divine parries: vertigo, the world falls away behind the hero
    if (n >= 2) g.cam.dolly(n >= 3 ? 24 : 15, n >= 3 ? 1.7 : 1.2)
    g.score.parry(n)
    this.gainDivinity(6 + n * 8)
    this.perfectCount++
    // the blade answers: a crescent rolls back down the line the threat came in on, and a big parry cuts everything near
    if (n >= 1 && this.counterT <= 0) {
      this.counterT = 0.25
      const roll = (Math.random() - 0.5) * 0.5 + (Math.random() < 0.5 ? 0 : Math.PI / 2)
      g.slashes.fire(hitP.clone().addScaledVector(toward, 1.5), toward, { width: 10 + n * 6, roll, dmg: 900 + n * 600, speed: 220, life: 2.4, power: 40, color: '#ffd080' })
    }
    if (n >= 2) this.arts.counter()
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
    g.rumble(0.35 + n * 0.15, 0.3, 90 + n * 50)
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
    g.rumble(Math.min(1, 0.3 + dmg / 300), 0.45, 120 + Math.min(320, dmg))
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
    // the coil and the follow-through do not flinch
    if (dmg >= 90 && this.state !== 'charge' && this.state !== 'wcharge' && this.state !== 'wsplit') this.enter('hurt')
  }

  die() {
    this.state = 'dead'
    this.t = 0
    this.stopCharge()
    this.arts.cancel()
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
    if (this.state === 'wcharge' && s !== 'wsplit') this.arts.cancel()
    this.state = s
    this.t = 0
    this.fired = false
    this.leapt = false
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
    this.counterT -= dt
    this.flourishCd -= dt
    // a massacre leaves the hero owing his blade a flick
    const soldiers = g.score.tally.soldiers
    this.killBurst = this.killBurst * Math.exp(-dt / 1.5) + Math.max(0, soldiers - this.lastKills)
    this.lastKills = soldiers
    if (this.killBurst > 25 && this.flourishCd <= 0) this.flourishOwed = true
    for (let i = this.dashCuts.length - 1; i >= 0; i--) {
      const c = this.dashCuts[i]
      c.t -= dt
      if (c.t <= 0) {
        this.dashCuts.splice(i, 1)
        this.landDashCut(c.pts, c.dir)
      }
    }
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
    const cancellable =
      s === 'free' || s === 'air' || s === 'guard' || s === 'land' || s === 'chiburi' || ((s === 'slash' || s === 'airslash') && this.fired) || (s === 'iai' && this.fired && this.t > 0.16) || (s === 'cleave' && this.t > 0.3) || (s === 'parry' && this.parryT > 0.12) || (s === 'wsplit' && this.t > 0.9)
    this.arts.tick(dt, f, enabled)
    if (cancellable || s === 'charge' || s === 'catch' || s === 'wcharge') {
      if (want(f.parry) && this.parryLag <= 0) return this.startParry()
      if (want(f.dash) && this.dashCd <= 0) return this.startDash(mx, mz)
    }
    if (cancellable && want(f.ult)) {
      if (g.onUltimate?.()) return
      if (this.divinity >= 100) return this.startJudgment()
    }
    if (cancellable && want(f.art) && this.arts.ready) return this.startIai()
    if (cancellable && want(f.horizon)) {
      if (this.arts.horizonReady) return this.startHorizon()
      if (this.divinity < HORIZON_COST) useUI.getState().stamp(`HORIZON CUT NEEDS ${HORIZON_COST} DIVINITY`, 'warn')
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
        else if (!guard) {
          // standing still after a massacre: the blade is flicked clean
          this.idleT = mag < 0.1 && this.grounded && this.speed < 1 ? this.idleT + dt : 0
          if (this.flourishOwed && this.idleT > 0.45) {
            this.flourishOwed = false
            this.flourishCd = 8
            this.enter('chiburi')
          }
        }
        break
      }
      case 'chiburi':
        this.locomote(dt, mx, mz, mag, RUN)
        if (!this.fired && this.t >= 0.2) this.flickBlade()
        if (mag > 0.3 || this.t >= 0.8) this.enter('free')
        else if (want(f.slash)) this.startSlash(1)
        else if (want(f.jump)) this.leap()
        break
      case 'air': {
        // jump held through the start of the leap: the Sky Leap
        if (!this.skyLeaped && this.leapt && enabled && f.jumpHeld && this.t > 0.14 && this.t < 0.45 && this.vel.y > 0) this.skyLeap()
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
        // from a great height the hero comes down burning, like a meteor
        if (this.diveFrom - this.pos.y > 25 || this.altitude > 25) {
          this.chestPos(_v)
          g.fx.fire.spawn(_v, _w.set((Math.random() - 0.5) * 6, 30 + Math.random() * 20, (Math.random() - 0.5) * 6), [1, 0.55, 0.2], 0.9, 1.2 + Math.random(), 0.35, 0, 2, { grow: 1.6 })
          g.fx.sparkShower(_v, UP, Math.round(40 * dt * 60), 30, 0.4, FIRE, { life: 0.4, size: 0.04, drag: 2, stretch: 0.04, heat: 3 })
          this.arts.fx.placeGlow(_v, 2.2, 0.5)
        }
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
      case 'iai': {
        if (this.grounded) this.locomote(dt, 0, 0, 0, 0)
        else {
          // the draw holds him in the air
          this.vel.y = Math.max(this.vel.y - GRAVITY * 0.2 * dt, -2)
          this.integrate(dt)
        }
        if (this.t < IAI_DRAW) this.yaw = turnToward(this.yaw, this.aimYaw, 40 * dt)
        if (!this.fired && this.t >= IAI_DRAW) {
          this.fired = true
          this.arts.iai()
        }
        // still holding after the draw: the blade goes up for the Worldsplitter
        if (this.fired && enabled && f.artHeld && this.t >= HOLD_TO_CHARGE) this.startWorldCharge()
        else if (want(f.slash) && this.t > IAI_SHEATHE) this.startSlash(1)
        else if (want(f.jump) && this.fired && this.grounded) this.leap()
        else if (this.t >= IAI_DUR) this.enter(this.grounded ? 'free' : 'air')
        break
      }
      case 'wcharge':
        this.updateWorldCharge(dt, f, enabled)
        break
      case 'hcut':
        if (this.grounded) this.locomote(dt, 0, 0, 0, 0)
        else {
          this.vel.y = Math.max(this.vel.y - GRAVITY * 0.15 * dt, -1)
          this.integrate(dt)
        }
        if (!this.fired && this.t >= IAI_DRAW) {
          this.fired = true
          this.arts.horizonCut()
        }
        if (this.t >= IAI_DUR + 0.15) this.enter(this.grounded ? 'free' : 'air')
        break
      case 'wsplit':
        if (this.grounded) this.locomote(dt, 0, 0, 0, 0)
        else {
          this.vel.y = Math.max(this.vel.y - GRAVITY * 0.15 * dt, -1)
          this.integrate(dt)
        }
        if (!this.fired && this.t >= WORLD_HIT) {
          this.fired = true
          this.arts.strike()
        }
        if (this.t >= WORLD_DUR) this.enter(this.grounded ? 'free' : 'air')
        break
      case 'dead':
        this.vel.multiplyScalar(Math.exp(-dt * 6))
        break
      case 'cine':
      case 'victory':
        break
    }

    if (this.state !== 'parry') this.parriedTier = -1
    this.footfalls(dt)
    this.constrain()
    this.animate(dt)
    this.arts.place(dt)
    this.power.update(dt)
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
    // a Sky Leap hangs at its apex long enough to pick where to come down
    this.vel.y -= GRAVITY * dt * (this.skyLeaped && Math.abs(this.vel.y) < 12 ? 0.3 : 1)
    this.integrate(dt)
    if (this.grounded) {
      this.skyLeaped = false
      this.game.fx.dust(_v.copy(this.pos).setY(this.pos.y + 0.2), 4, 1, 1.2)
      audio.landing(0.3)
      this.enter('free')
    }
  }

  private integrate(dt: number) {
    const was = this.grounded
    this.pos.addScaledVector(this.vel, dt)
    const gy = this.game.terrain.heightAt(this.pos.x, this.pos.z)
    // stick to the ground running down slopes and crater walls instead of skipping off them
    const snap = was && this.vel.y <= 0 ? 0.3 + Math.hypot(this.vel.x, this.vel.z) * dt * 1.2 : 0
    if (this.pos.y <= gy + snap) {
      this.pos.y = gy
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

  /**
   * At the top of his power the ground cannot take his weight: each footfall
   * at a run cracks it and leaves a glowing print that cools.
   */
  private footfalls(dt: number) {
    const g = this.game
    if (this.state !== 'free' || !this.grounded || this.speed < 7) return
    if (g.score.rank < 3 && this.divinity < 100) return
    this.stepDist += this.speed * dt
    if (this.stepDist < 2.3) return
    this.stepDist = 0
    this.stepSide = -this.stepSide
    const fx = Math.sin(this.yaw)
    const fz = Math.cos(this.yaw)
    const x = this.pos.x + fz * 0.17 * this.stepSide
    const z = this.pos.z - fx * 0.17 * this.stepSide
    const y = g.terrain.heightAt(x, z)
    const hot = g.score.rank >= 5 ? 0.9 : 0.55
    g.scorch.crater(x, z, 0.55, hot)
    _v.set(x, y + 0.08, z)
    g.fx.gpu.emberDrift(_v, 6, 0.2, { rise: 0.8, burst: 1.5, life: 0.9, size: 0.05 })
    g.fx.gpu.dustMotes(_v, 6, 0.3, { out: 1.5, up: 0.6, size: 0.18, life: 0.8 })
    if (g.score.rank >= 6) g.fx.ring(_v, 1.6, '#ffd8a0', 0.25, { thick: 0.2, alpha: 0.6 })
  }

  /** The flourish: the blade snapped down and to the side, molten drops flung off it in an arc onto the ground. */
  private flickBlade() {
    const g = this.game
    this.fired = true
    this.model.swordTip.getWorldPosition(_v)
    const side = _w.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw))
    _dir.copy(side).multiplyScalar(0.8).setY(-0.6).normalize()
    g.fx.sparkShower(_v, _dir, 70, 16, 0.35, FIRE, { life: 1.1, size: 0.06, gravity: 22, drag: 0.6, stretch: 0.02, heat: 2.5 })
    g.fx.gpu.emberDrift(_v, 20, 0.3, { rise: 0.4, burst: 2, life: 1.4, size: 0.07 })
    // the drops land in a little arc of scorch marks beside him
    for (let i = 0; i < 5; i++) {
      const d = 1.2 + i * 0.45
      const a = (i - 2) * 0.12
      const x = this.pos.x + side.x * d * Math.cos(a) + Math.sin(this.yaw) * d * Math.sin(a)
      const z = this.pos.z + side.z * d * Math.cos(a) + Math.cos(this.yaw) * d * Math.sin(a)
      g.fx.after(0.25 + i * 0.03, () => g.scorch.crater(x, z, 0.3, 0.8))
    }
    g.fx.ring(_w.copy(this.pos).setY(this.pos.y + 0.06), 3.5, '#ffe2b8', 0.35, { thick: 0.12, alpha: 0.6 })
    audio.chiburi()
    g.rumble(0.15, 0.4, 60)
  }

  /** Did the hero leap into the current 'air' state (rather than fall or step off something)? */
  private leapt = false

  private leap() {
    this.enter('air')
    this.leapt = true
    this.skyLeaped = false
    this.vel.y = 25
    this.grounded = false
    this.pos.y += 0.05
    audio.leap()
    this.game.fx.dust(_v.copy(this.pos).setY(this.pos.y + 0.15), 5, 1.2, 1.5)
    this.game.fx.ring(_v.copy(this.pos).setY(this.pos.y + 0.05), 4, '#ffe0a8', 0.3, { thick: 0.3 })
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
      { t: 'sector', c: this.pos, dir: fwd, range: n === 4 ? 7 : 5.5, cos: Math.cos(1.35), y0: this.pos.y - 1, y1: this.pos.y + 4 },
      { id: newHitId(), kind: 'slash', dmg: n === 4 ? 400 : 160, power: n === 4 ? 26 : 18, origin: this.pos, dir: fwd, friendly: true },
    )
    const launch = origin.clone().addScaledVector(dir, 1.2)
    const rolls = [0, 0.12, Math.PI - 0.12, -0.75, 0]
    if (n === 4) {
      for (const r of [0.85, -0.85]) g.slashes.fire(launch, dir, { width: 15, roll: Math.PI / 2 + r, dmg: 900, speed: 170, life: 2.4, power: 40, color: '#ffc060' })
      g.post.impactFrames([2, 0])
      g.cam.addTrauma(0.35)
      g.time.freeze(0.06)
      g.fx.afterimage('#ffd080', 0.4)
      audio.slash(2)
    } else {
      g.slashes.fire(launch, dir, { width: 8, roll: rolls[n], dmg: 320, speed: 150, life: 2, color: '#ffb850' })
      audio.slash(1)
    }
    audio.airSlash()
    // the camera leans with the swing: across for the sweeps, down for the finisher
    const sweep = n === 4 ? 0 : n % 2 === 1 ? 1 : -1
    _v.set(fwd.z, 0, -fwd.x).multiplyScalar(sweep * 0.07).addScaledVector(dir, 0.08)
    if (n === 4) _v.y -= 0.1
    g.cam.kick(_v, 1 + Math.min(1, melee * 0.12))
    g.post.kickChroma(0.25)
    if (melee > 0) {
      // a longer beat the more the swing cuts down
      g.time.freeze(slashHitstop(melee, n === 4))
      g.cam.addTrauma(0.12 + Math.min(0.25, melee * 0.025))
      g.rumble(0.12 + Math.min(0.4, melee * 0.05), 0.35, 70 + Math.min(110, melee * 12))
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
    g.slashes.fire(origin.clone().addScaledVector(dir, 1.2), dir, { width: 8.5, roll: 0.75, dmg: 320, speed: 150, life: 2, color: '#ffb850' })
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
    this.power.charge(k, dt)
    this.chargeSnd?.set(k)
    g.sky.swirl(k * 0.6)
    if (k > 0.4) g.forces?.horde.terrify(this.pos.x, this.pos.z, 30 + k * 100, 0.8)
    this.model.energyU.uLen.value = 2 + k * k * 70
    this.model.energyU.uPower.value = 0.4 + k * 0.6
    g.cam.addTrauma(dt * (0.2 + k * 1.2))
    g.rumble(0.04 + k * k * 0.3, 0.08 + k * 0.3, 110)
    // power gathers: light streams in, the ground stirs
    const n = Math.floor(dt * (60 + k * 240))
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const r = 4 + Math.random() * 10
      _v.set(this.pos.x + Math.sin(a) * r, this.pos.y + Math.random() * 5, this.pos.z + Math.cos(a) * r)
      _w.set(this.pos.x - _v.x, this.pos.y + 1.6 - _v.y, this.pos.z - _v.z).multiplyScalar(2.2)
      g.fx.glow.spawn(_v, _w, [1, 0.8, 0.45], 0.9, 0.06 + Math.random() * 0.06, 0.45, 0, 0)
    }
    if (this.grounded && Math.random() < dt * (4 + k * 14)) g.fx.dust(_v.copy(this.pos).setY(this.pos.y + 0.3), 1, 3 + k * 4, 1.4)
    if (k >= 1 && !this.chargeFull) {
      this.chargeFull = true
      // the light gathers at the raised blade, above the hero, so his outline stays readable
      g.fx.flare(_v.copy(this.pos).setY(this.pos.y + 4.2), 4.5, '#fff0c0', 0.3)
      g.fx.ring(_v.copy(this.pos).setY(this.pos.y + 0.1), 12, '#ffd890', 0.6, { thick: 0.15 })
      g.post.flashTo(0.06, '#fff2d0', 6)
      g.cam.kickFov(-4)
      g.rumble(0.5, 0.7, 220)
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
    a.y = g.terrain.heightAt(a.x, a.z)
    const b = a.clone().addScaledVector(fwd, len)
    const normal = new THREE.Vector3(fwd.z, 0, -fwd.x)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, a)
    g.damage({ t: 'slab', a, b, r: half, h: 60 + len }, { id: newHitId(), kind: 'heaven', dmg: 500 + 3500 * k * k, power: 30 + 25 * k, origin: a, dir: fwd, plane, friendly: true })
    g.cutProjectiles({ t: 'slab', a, b, r: half + 2, h: 60 + len })
    g.cleaveFx(a, b, fwd, k)
    this.power.release(a, b, fwd, k)
    this.model.energyU.uLen.value = len
    this.energyFade = 0.45
    audio.cleave(k)
    g.score.feat('heaven', k)
    this.charge = 0
  }

  /** The Iai: planted, the hand on the hilt, turned to the aim. */
  private startIai() {
    this.stopCharge()
    this.model.energyBlade.visible = false
    this.enter('iai')
    this.yaw = this.aimYaw
    this.vel.x *= 0.15
    this.vel.z *= 0.15
    if (!this.grounded) this.vel.y = Math.max(this.vel.y, 1)
  }

  /** The Horizon Cut: the same draw as the Iai, aimed at the skyline. */
  private startHorizon() {
    this.stopCharge()
    this.model.energyBlade.visible = false
    this.enter('hcut')
    this.yaw = this.aimYaw
    this.vel.x *= 0.15
    this.vel.z *= 0.15
  }

  private startWorldCharge() {
    this.enter('wcharge')
    this.arts.beginCharge()
    this.vel.x *= 0.2
    this.vel.z *= 0.2
  }

  private updateWorldCharge(dt: number, f: InputFrame, enabled: boolean) {
    if (this.grounded) this.locomote(dt, 0, 0, 0, 0)
    else {
      // hang in the air with the blade raised
      this.vel.y = Math.max(this.vel.y - GRAVITY * 0.15 * dt, -1)
      this.vel.x *= Math.exp(-dt * 4)
      this.vel.z *= Math.exp(-dt * 4)
      this.integrate(dt)
    }
    this.yaw = turnToward(this.yaw, this.aimYaw, 8 * dt)
    this.arts.chargeTick(dt)
    if (enabled && f.artHeld) return
    if (this.arts.canRelease) {
      this.yaw = this.aimYaw
      this.enter('wsplit')
      this.arts.worldsplit()
      return
    }
    // let go early, or without the Divinity to pay for it: the blade comes down harmlessly
    this.arts.cancel()
    this.enter(this.grounded ? 'free' : 'air')
  }

  /**
   * The leap goes on up: the hero breaks the sound barrier straight up and
   * hangs high over the battlefield, the ground cracking where he left it.
   */
  private skyLeap() {
    const g = this.game
    this.skyLeaped = true
    this.vel.y = 80
    this.vel.x *= 1.4
    this.vel.z *= 1.4
    const gy = g.terrain.heightAt(this.pos.x, this.pos.z)
    const foot = new THREE.Vector3(this.pos.x, gy, this.pos.z)
    g.terrain.crater(foot.x, foot.z, 4.5, 0.8, { rim: 0.4, ejecta: 0.5 })
    g.fx.groundShock(foot, 18)
    this.arts.fx.ring(_v.copy(this.pos).setY(this.pos.y + 0.5), UP, 1, 9, 0.35, { thick: 0.08, alpha: 1, color: '#fff1dc' })
    this.arts.fx.ring(_v.copy(this.pos).setY(this.pos.y + 3), UP, 1, 6, 0.3, { thick: 0.1, alpha: 0.8, speed: 30, delay: 0.04 })
    g.fx.gpu.plasmaRing(_v.copy(foot).setY(gy + 0.4), UP, 14, 500, WHITE_GOLD, { expand: 0.5, fill: 0.3, thick: 0.1, life: 0.7, size: 0.05, stretch: 0.04, heat: 2.4 })
    g.post.shock(_v.copy(this.pos).setY(this.pos.y + 1), g.camera, 0.03, { speed: 2.4, width: 0.8 })
    g.post.speedLines(0.9, 0.2)
    g.post.kickChroma(0.5)
    g.cam.kick(_w.set(0, -1, 0), 0.25)
    g.cam.kickFov(12)
    g.cam.addTrauma(0.3)
    g.fx.afterimage('#ffd080', 0.5, 0.9)
    g.rumble(0.6, 0.6, 220)
    audio.sonicBoom(true)
    audio.landing(1.2)
  }

  private startDive() {
    const g = this.game
    this.enter('dive')
    this.diveFrom = this.pos.y
    this.invuln = 0.4
    audio.dive()
    this.vel.x = Math.sin(this.aimYaw) * 4
    this.vel.z = Math.cos(this.aimYaw) * 4
    // from high enough the dive is aimed: it comes down where the crosshair is
    const h = this.altitude
    if (h > 15) {
      const t = h / 95
      const a = g.cam.aimPoint
      if (a.y < this.pos.y - 5) {
        this.vel.x = clamp((a.x - this.pos.x) / t, -120, 120)
        this.vel.z = clamp((a.z - this.pos.z) / t, -120, 120)
      }
      g.post.speedLines(1, 0.4)
      g.cam.kickFov(10)
    }
  }

  private slamLanding() {
    const g = this.game
    this.enter('land')
    this.vel.set(0, 0, 0)
    // the ground caves in: the higher the dive, the bigger the crater
    const fall = Math.max(0, this.diveFrom - this.pos.y)
    g.terrain.crater(this.pos.x, this.pos.z, Math.min(26, 6 + fall * 1.3), Math.min(9, 1.4 + fall * 0.45), { rim: 0.3, ejecta: 0.8 })
    this.pos.y = g.terrain.heightAt(this.pos.x, this.pos.z)
    const p = this.pos.clone()
    g.damage({ t: 'sphere', c: p, r: 15 }, { id: newHitId(), kind: 'slam', dmg: 380, power: 34, origin: p, friendly: true })
    g.fx.groundShock(p, 22)
    // low and tight on the crater floor: the hero stands dark against it
    g.fx.flare(_v.copy(p).setY(p.y + 0.4), 7, '#fff0c8', 0.25)
    g.fx.light(_v.copy(p).setY(p.y + 2), '#ffd090', 260, 40, 5)
    // the camera drops with the impact and bounces back; the power gathered on the way down is spent
    const big = Math.min(1, fall / 30)
    if (fall > 25) this.meteorFall(p, Math.min(1, (fall - 25) / 40))
    g.cam.kick(_w.set(0, -1, 0), 0.3 + big * 0.35)
    g.cam.addTrauma(0.75 + big * 0.3)
    g.cam.kickFov(6 + big * 8)
    g.post.kickZoom(0.18 + big * 0.1)
    g.post.impactFrames([2, 0])
    g.post.shock(_v.copy(p).setY(p.y + 0.5), g.camera, 0.02 + big * 0.025, { speed: 1.8, width: 1 })
    g.levitate.release(null, 1 + big * 0.6)
    g.aura.flare(0.4 + big * 0.1)
    g.time.freeze(0.08 + big * 0.04)
    g.rumble(0.7 + big * 0.3, 0.6, 260 + big * 240)
    audio.landing(2 + big * 2)
    g.score.feat('slam', 1)
  }

  /**
   * Coming down from a Sky Leap: the plain caves in a bowl a hundred metres
   * across, cracks race out of it in every direction, and a shockwave throws
   * everything near over the horizon. `k` 0..1 grows with the height.
   */
  private meteorFall(p: THREE.Vector3, k: number) {
    const g = this.game
    const fx = g.fx
    g.terrain.crater(p.x, p.z, 34 + 22 * k, 10 + 5 * k, { rim: 0.5, ejecta: 1 })
    this.pos.y = g.terrain.heightAt(this.pos.x, this.pos.z)
    const r = 45 + 75 * k
    g.damage({ t: 'ring', c: p, r0: 0, r1: r, h: p.y + 14 }, { id: newHitId(), kind: 'slam', dmg: 900, power: 46 + 20 * k, origin: p, friendly: true })
    g.cutProjectiles({ t: 'sphere', c: p, r: r * 0.6 })
    // cracks race out of the crater, glowing
    const n = 9 + Math.round(5 * k)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
      let x0 = p.x + Math.sin(a) * 20
      let z0 = p.z + Math.cos(a) * 20
      const len = 40 + Math.random() * (40 + 60 * k)
      const segs = 4
      for (let j = 0; j < segs; j++) {
        const b = a + (Math.random() - 0.5) * 0.5
        const x1 = x0 + Math.sin(b) * (len / segs)
        const z1 = z0 + Math.cos(b) * (len / segs)
        const sx0 = x0
        const sz0 = z0
        fx.after(j * 0.05 + 0.03, () => {
          g.scorch.fissure(sx0, sz0, x1, z1, 1.4 - j * 0.25, 1)
          g.terrain.trench(sx0, sz0, x1, z1, 2.4 - j * 0.4, 1.2 - j * 0.2, { lip: 0.5, jag: 0.3 })
        })
        x0 = x1
        z0 = z1
      }
    }
    fx.groundShock(p, 70 + 50 * k)
    fx.gpu.plasmaRing(_v.copy(p).setY(p.y + 0.6), UP, 60 + 40 * k, Math.round(1600 * g.q), AMBER, { expand: 0.9, fill: 0.4, thick: 0.35, life: 1.6, size: 0.08, stretch: 0.04, heat: 2.4 })
    fx.debris.burst(_v.copy(p).setY(p.y + 1), 60, 34 + 14 * k, 0.4 + 0.4 * k, 0.8, 1.3)
    const nd = Math.round(40 * g.q)
    for (let i = 0; i < nd; i++) {
      const a = (i / nd) * Math.PI * 2
      _v.set(p.x + Math.sin(a) * 12, p.y + 1, p.z + Math.cos(a) * 12)
      _w.set(Math.sin(a) * (60 + Math.random() * 40), 6 + Math.random() * 10, Math.cos(a) * (60 + Math.random() * 40))
      fx.smoke.spawn(_v, _w, [0.36, 0.3, 0.26], 0.5, 6 + Math.random() * 5, 2.5 + Math.random() * 2, -0.3, 1.3, { grow: 2.4 })
    }
    fx.light(_v.copy(p).setY(p.y + 6), '#ffc070', 500, 140, 3)
    g.post.impactFrames([2, 0], 1 / 24)
    g.post.flashTo(0.05, '#fff0d8', 5)
    g.post.shock(_v.copy(p).setY(p.y + 1), g.camera, 0.06, { speed: 1.4, width: 1.6 })
    g.post.streak(0.6, p)
    g.time.freeze(0.12)
    g.time.divine(1.2, 0.3)
    g.sky.flash(UP, 0.5, '#ffd8a0')
    g.gust(p, 34)
    g.rumble(1, 1, 700)
    audio.nukeShock()
    audio.duck(0.6, 2)
    g.forces?.horde.terrify(p.x, p.z, 260, 3.5)
    useUI.getState().stamp('METEOR FALL', 'divine')
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
    this.dashPath = [this.pos.clone().setY(this.pos.y + 1)]
    this.dashCd = 0.32
    this.invuln = 0.28
    this.ghostTimer = 0
    this.vel.set(this.dashDir.x * 95, Math.max(0, this.vel.y * 0.2), this.dashDir.z * 95)
    audio.dash()
    g.post.speedLines(0.9, 0.05)
    g.cam.kickFov(14)
    g.fx.afterimage('#ffd080', 0.4)
    g.feel.dashStart(this.chestPos(_v), this.dashDir)
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
    g.feel.dashStep(prev, this.pos, this.dashDir)
    // flash-step: nothing it passes through knows it has been cut until a beat after it stops
    this.dashPath.push(this.pos.clone().setY(this.pos.y + 1))
    if (this.t >= 0.16) {
      if (this.dashPath.length > 1) this.dashCuts.push({ t: 0.3, pts: this.dashPath, dir: this.dashDir.clone() })
      this.dashPath = []
      g.feel.dashEnd(this.chestPos(_v), this.dashDir)
      this.vel.multiplyScalar(0.12)
      this.enter(this.grounded ? 'free' : 'air')
    }
  }

  /**
   * The beat after a flash-step: cut lines flare across everything it passed
   * through, the guard clicks home, and they all fall apart at once.
   */
  private landDashCut(pts: THREE.Vector3[], dir: THREE.Vector3) {
    const g = this.game
    const shapes: Shape[] = []
    for (let i = 1; i < pts.length; i++) shapes.push({ t: 'capsule', a: pts[i - 1], b: pts[i], r: 3.4 })
    // the cut lines: one slanted stroke across each victim
    const enemies = g.enemyPoints
    let shown = 0
    const side = _w.set(dir.z, 0, -dir.x)
    for (const q of enemies) {
      if (shown >= 40 * g.q) break
      if (!shapes.some((s) => shapeHitsSphere(s, q.x, q.y + 1, q.z, 0.8))) continue
      const tilt = (Math.random() - 0.5) * 1.4
      _v.copy(side).multiplyScalar(Math.cos(tilt) * 1.3).setY(Math.sin(tilt) * 1.3)
      g.fx.streak(_dir.copy(q).setY(q.y + 1.1).sub(_v), new THREE.Vector3().copy(q).setY(q.y + 1.1).add(_v), 0.1, '#fff0d0', 0.28)
      shown++
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(dir.z, 0.35, -dir.x).normalize(), pts[0])
    const id = newHitId()
    let n = 0
    for (const s of shapes) n += g.damage(s, { id, kind: 'dash', dmg: 900, power: 9, origin: pts[0], dir, plane, friendly: true })
    for (const s of shapes) g.cutProjectiles(s)
    audio.sheathe(0)
    if (n > 0) {
      audio.cut(pts[pts.length - 1], n > 8)
      g.time.freeze(0.04 + Math.min(0.08, n * 0.004))
      g.cam.addTrauma(0.12 + Math.min(0.3, n * 0.01))
      g.post.kickChroma(0.4)
      g.rumble(0.3 + Math.min(0.5, n * 0.02), 0.6, 100 + Math.min(200, n * 6))
      if (n > 15) g.post.impactFrames([2, 0], 1 / 30)
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
    this.power.judgment()
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
        g.rumble(0.08, 0.4, 45)
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
    rig.position.set(x, this.game.terrain.heightAt(x, z), z)
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
      case 'iai':
      case 'hcut':
        return 'iaiDraw'
      case 'chiburi':
        return 'chiburi'
      case 'wcharge':
        return 'charge'
      case 'wsplit':
        return 'worldsplit'
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
    const free = clip === null || this.state === 'guard' || this.state === 'charge' || this.state === 'wcharge'
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
      trail: this.state === 'slash' || this.state === 'airslash' || this.state === 'cleave' || this.state === 'parry' || this.state === 'iai' || this.state === 'hcut' || this.state === 'wsplit',
      sharpness: this.state === 'slash' || this.state === 'parry' || this.state === 'cleave' || this.state === 'iai' || this.state === 'wsplit' ? 45 : 30,
      windX: wind.x - this.vel.x * 0.6,
      windZ: wind.z - this.vel.z * 0.6,
      clothDt: dt,
      floor: g.terrain.heightAt(this.pos.x, this.pos.z),
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
