import * as THREE from 'three'
import { audio } from '../audio/audio'
import { clamp, smoothstep } from '../engine/math'
import { input, type InputFrame } from '../input/input'
import { useUI } from '../state/store'
import type { Shot } from './camera'
import { SonicBoom } from './fx/sonicBoom'
import { AMBER, GOLD, WHITE_GOLD } from './fx/particleFx'
import type { Game } from './Game'
import type { KillKind } from './score'

/**
 * Game feel: controller vibration, kill cams, the flash-step's sonic boom,
 * multi-kill punches and the rank-up flourish. The big moments call in here
 * (game.feel / game.rumble); it owns nothing that changes gameplay.
 */

const UP = new THREE.Vector3(0, 1, 0)
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _f = new THREE.Vector3()
const _s = new THREE.Vector3()
const DUST: readonly [number, number, number] = [0.3, 0.25, 0.21]

/** Slash hitstop for a swing that struck `hits` things: a longer beat the more fall, capped so a crowd never stalls the game. */
export function slashHitstop(hits: number, finisher: boolean) {
  if (hits <= 0) return 0
  const base = finisher ? 0.075 : 0.04
  return Math.min(finisher ? 0.15 : 0.1, base + Math.min(hits, 12) * 0.005)
}

/** Vibration falloff with distance from the hero: 1 on top of him, 0 at `range`. */
export function rumbleFalloff(d: number, range: number) {
  const k = clamp(1 - d / Math.max(1e-3, range), 0, 1)
  return k * k
}

/** Seconds three flash-steps must land within to chain. */
export const FLASH_CHAIN = 1.2

/** Record a flash-step at `now` and return how many fall within `window` (the list is pruned in place). */
export function flashChain(times: number[], now: number, window = FLASH_CHAIN) {
  times.push(now)
  while (times.length && now - times[0] > window) times.shift()
  return times.length
}

export type KillCamStyle = 'low' | 'orbit' | 'behind'

/**
 * A kill cam shot. `hero` is copied; `target` is read live (a falling ship
 * keeps its frame). 'low': down by the hero's boots looking up past him at
 * the kill, drifting round. 'orbit': a slow arc around the target. 'behind':
 * over the hero's shoulder toward the target, the lens narrowing on far kills.
 */
export function killShot(style: KillCamStyle, hero: THREE.Vector3, target: THREE.Vector3, size: number, dur: number): Shot {
  const h = hero.clone()
  const flat = new THREE.Vector3().subVectors(target, h).setY(0)
  const dist = Math.max(1, flat.length())
  flat.divideScalar(dist)
  if (dist <= 1) flat.set(0, 0, -1)
  const side = new THREE.Vector3(flat.z, 0, -flat.x)
  const a0 = Math.atan2(h.x - target.x, h.z - target.z)
  // a far kill is framed with a long lens so it still fills the screen
  const tele = clamp((Math.atan((size * 1.4) / dist) * 2 * 180) / Math.PI, 16, 56)
  return {
    dur,
    blendIn: 0.22,
    blendOut: 0.45,
    frame: (t, pos, look) => {
      const e = smoothstep(0, dur, t)
      if (style === 'low') {
        // the camera swings a quarter way round the hero at knee height
        const a = -0.45 + 0.6 * e
        _v.copy(flat).multiplyScalar(-3.4).addScaledVector(side, 1.7)
        _v.applyAxisAngle(UP, a)
        pos.copy(h).add(_v)
        pos.y = h.y + 0.55 + 0.25 * e
        look.lerpVectors(_w.copy(h).setY(h.y + 1.6), target, 0.72)
        return 60 - 8 * e
      }
      if (style === 'orbit') {
        const r = size * 2.2 + 24
        const a = a0 + 0.35 + 0.7 * e
        pos.set(target.x + Math.sin(a) * r, target.y + size * 0.25, target.z + Math.cos(a) * r)
        look.copy(target)
        return 52 - 6 * e
      }
      // behind the hero, the target ahead; the lens pushes in
      pos.copy(h).addScaledVector(flat, -(4.6 + 1.4 * e)).addScaledVector(side, 1.35)
      pos.y = h.y + 1.2 + 0.5 * e
      look.copy(target)
      return 58 + (tele - 58) * smoothstep(0.1, 0.9, e)
    },
  }
}

interface KillCam {
  shot: Shot
  t: number
  live: boolean
  /** Movement held when it began must be let go before it counts as a skip. */
  held: boolean
}

export interface KillCamOpts {
  style: KillCamStyle
  /** Rough size of the thing (m): frames the shot. */
  size: number
  /** A stamp to show with it. */
  text?: string
  /** Real seconds. */
  dur?: number
}

export class Feel {
  readonly root = new THREE.Group()
  /** The flash-step's vapor cones. */
  readonly boom = new SonicBoom()
  private g: Game
  private kc: KillCam | null = null
  private lastKillCam = -99
  private dashTimes: number[] = []
  private bigDash = false
  private catchT = 0
  private lastMulti = -99
  private lastFlourish = new Map<number, number>()

  constructor(game: Game) {
    this.g = game
    this.root.add(this.boom.root)
  }

  // -------------------------------------------------------------------------
  // Vibration
  // -------------------------------------------------------------------------

  /** Rumble the pad (respects the setting). `at` attenuates with the distance from the hero out to `range`. */
  rumble(strong: number, weak: number, ms: number, at?: THREE.Vector3, range = 220) {
    if (!useUI.getState().save.settings.vibration) return
    let k = 1
    if (at) k = rumbleFalloff(at.distanceTo(this.g.player.pos), range)
    if (k < 0.03) return
    input.rumble(strong * k, weak * k, ms)
  }

  // -------------------------------------------------------------------------
  // Kill cams
  // -------------------------------------------------------------------------

  /** Is a kill cam allowed right now? Never over another cinematic, a time stop, a dead or scripted hero, or too soon after the last. */
  canKillCam() {
    const g = this.g
    const st = g.player.state
    if (g.mode === 'title' || g.cam.cinematic || this.kc) return false
    if (g.time.isStopped || st === 'cine' || st === 'dead' || st === 'victory' || st === 'judgment' || st === 'spunch') return false
    return g.time.real - this.lastKillCam > 5
  }

  /**
   * A short slow-motion beat on a big kill: letterbox, a cinematic shot, a
   * stamp. Returns false when it could not play (another cinematic owns the
   * camera); any input skips it.
   */
  killCam(target: THREE.Vector3, o: KillCamOpts) {
    if (!this.canKillCam()) return false
    const g = this.g
    const dur = o.dur ?? 1.4
    const shot = killShot(o.style, g.player.pos, target, o.size, dur)
    const kc: KillCam = { shot, t: 0, live: true, held: Math.hypot(input.frame.moveX, input.frame.moveY) > 0.3 }
    const frame = shot.frame
    // the shot reports in every frame it is on screen, so a shot that replaced it is never mistaken for ours
    shot.frame = (t, pos, look) => {
      kc.live = true
      return frame(t, pos, look)
    }
    this.kc = kc
    this.lastKillCam = g.time.real
    g.cam.play(shot)
    g.time.slowmo(dur, 0.28)
    g.player.invuln = Math.max(g.player.invuln, dur + 0.3)
    g.post.kickChroma(0.5)
    useUI.getState().setLetterbox(true)
    if (o.text) useUI.getState().stamp(o.text, 'divine')
    audio.duck(0.45, dur + 0.6)
    this.rumble(0.8, 0.45, 450)
    return true
  }

  get killCamActive() {
    return this.kc !== null
  }

  private endKillCam(skipped: boolean) {
    if (!this.kc) return
    this.kc = null
    useUI.getState().setLetterbox(false)
    if (skipped) {
      this.g.cam.stopShot()
      this.g.time.cancelSlowmo()
    }
  }

  // -------------------------------------------------------------------------
  // The flash-step: a sonic boom
  // -------------------------------------------------------------------------

  /** The step breaks the sound barrier at the hero's chest, heading `dir`. Three within FLASH_CHAIN seconds chain into a bigger boom. */
  dashStart(chest: THREE.Vector3, dir: THREE.Vector3) {
    const g = this.g
    const fx = g.fx
    const big = flashChain(this.dashTimes, g.time.real) >= 3
    this.bigDash = big
    if (big) {
      this.dashTimes.length = 0
      useUI.getState().stamp('FLASH STEP', 'perfect')
      g.score.feat('flash', 1)
    }
    this.boom.start(chest, dir, big)
    audio.sonicBoom(big)
    // the pressure ring the hero punches through, and the air rippling off him
    fx.ring(_v.copy(chest).addScaledVector(dir, 0.6), big ? 3.2 : 2, '#fff1dc', big ? 0.32 : 0.22, { normal: dir, thick: 0.1, alpha: big ? 0.9 : 0.6 })
    g.post.shock(chest, g.camera, big ? 0.03 : 0.012, { speed: 2.6, width: big ? 0.8 : 0.5 })
    fx.gpu.plasmaRing(_v.copy(chest).addScaledVector(dir, 0.4), dir, big ? 1.6 : 1.1, big ? 260 : 120, WHITE_GOLD, { expand: big ? 0.7 : 0.45, fill: 0.2, thick: 0.15, life: 0.3, size: 0.03, stretch: 0.03, heat: 2.2 })
    if (big) {
      g.cam.addTrauma(0.25)
      g.cam.kickFov(10)
      g.post.speedLines(1, 0.12)
      g.post.kickChroma(0.6)
      g.aura.flare(0.3, undefined, false)
    }
    const gy = g.terrain.heightAt(chest.x, chest.z)
    if (chest.y - gy < 3.5) fx.gpu.dustMotes(_v.set(chest.x, gy + 0.15, chest.z), big ? 40 : 16, 1, { out: big ? 12 : 7, up: 1.2, size: 0.3, life: 1.1, color: DUST })
    this.rumble(big ? 0.6 : 0.12, big ? 0.85 : 0.4, big ? 260 : 90)
  }

  /** Every hero frame of the step: dust ripped up along the path, peeling away to both sides. */
  dashStep(a: THREE.Vector3, b: THREE.Vector3, dir: THREE.Vector3) {
    const g = this.g
    const fx = g.fx
    const gy = g.terrain.heightAt(b.x, b.z)
    if (b.y - gy > 3) return
    const len = a.distanceTo(b)
    const n = Math.max(1, Math.round((len / 1.6) * g.q))
    _s.set(dir.z, 0, -dir.x)
    for (let i = 0; i < n; i++) {
      _v.lerpVectors(a, b, (i + Math.random()) / n)
      _v.y = g.terrain.heightAt(_v.x, _v.z) + 0.25
      const sgn = Math.random() < 0.5 ? -1 : 1
      _w.copy(_s).multiplyScalar(sgn * (2 + Math.random() * 4)).addScaledVector(dir, 4 + Math.random() * 6).setY(0.6 + Math.random() * 1.6)
      fx.smoke.spawn(_v, _w, [0.36, 0.3, 0.26], 0.42, 0.7 + Math.random() * 0.6, 0.8 + Math.random() * 0.6, -0.4, 2.4, { grow: 1.8 })
    }
  }

  /** The step ends: the cone tears off, a shock ring bursts where the hero stops. */
  dashEnd(chest: THREE.Vector3, dir: THREE.Vector3) {
    const g = this.g
    const fx = g.fx
    this.boom.release()
    const big = this.bigDash
    fx.ring(_v.copy(chest).addScaledVector(dir, 0.8), big ? 4.5 : 2.8, '#ffe8c8', big ? 0.4 : 0.3, { normal: dir, thick: 0.08, alpha: 0.8 })
    fx.gpu.plasmaRing(_v.copy(chest).addScaledVector(dir, 0.5), dir, big ? 2.2 : 1.4, big ? 320 : 150, AMBER, { expand: big ? 0.9 : 0.5, fill: 0.15, thick: 0.12, life: 0.35, size: 0.03, stretch: 0.03, heat: 2 })
    const gy = g.terrain.heightAt(chest.x, chest.z)
    if (chest.y - gy < 3.5) {
      fx.ring(_v.set(chest.x, gy + 0.1, chest.z), big ? 9 : 5, '#ffd8a0', big ? 0.5 : 0.35, { thick: 0.12, alpha: 0.75 })
      fx.gpu.dustMotes(_v, big ? 50 : 20, 1.2, { out: big ? 14 : 8, up: 1.5, size: 0.35, life: 1.4, color: DUST })
    }
  }

  // -------------------------------------------------------------------------
  // Kills, ranks
  // -------------------------------------------------------------------------

  /** Score reported a kill: a huge multi-kill in one frame punches the lens. */
  onKill(kind: KillKind, count: number) {
    const g = this.g
    if (kind !== 'soldier' || count < 16) return
    if (g.cam.cinematic || g.time.isStopped || g.time.real - this.lastMulti < 0.35) return
    this.lastMulti = g.time.real
    const k = clamp((count - 16) / 60, 0, 1)
    g.cam.kickFov(4 + k * 8)
    g.post.kickZoom(0.035 + k * 0.06)
    g.post.kickChroma(0.3 + k * 0.4)
    this.rumble(0.25 + k * 0.45, 0.45, 140 + k * 160)
  }

  /** The style rank rose: from S up the hero answers with a flare, a ring of light and a thump. */
  rankUp(rank: number) {
    const g = this.g
    if (rank < 4 || !g.player.alive) return
    const now = g.time.real
    if (now - (this.lastFlourish.get(rank) ?? -99) < 4) return
    this.lastFlourish.set(rank, now)
    const k = rank - 3
    const p = g.player.pos
    const gy = g.terrain.heightAt(p.x, p.z)
    g.aura.flare(0.3 + k * 0.18, k >= 3 ? '#fff0c0' : undefined)
    g.fx.gpu.plasmaRing(_v.set(p.x, gy + 0.3, p.z), UP, 5 + k * 4, 300 + k * 260, k >= 3 ? WHITE_GOLD : GOLD, { expand: 0.5 + k * 0.15, fill: 0.3, thick: 0.12, life: 0.9, size: 0.06, stretch: 0.035, heat: 2.6 })
    g.fx.ring(_v.set(p.x, gy + 0.12, p.z), 8 + k * 6, '#ffd890', 0.6 + k * 0.1, { thick: 0.08, alpha: 0.8 })
    if (k >= 2) g.fx.gpu.motes(g.player.chestPos(_w), 60 + k * 50, 2 + k, GOLD, UP, { life: 2.5, size: 0.08 })
    g.cam.kickFov(3 + k * 2)
    g.post.kickChroma(0.3 + k * 0.15)
    this.rumble(0.2 + k * 0.15, 0.5, 200 + k * 80)
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** Before gameplay: kill-cam skips and endings, the hum of a caught beam. `pdt` drives the hero-attached cones. */
  update(rdt: number, pdt: number, f: InputFrame, enabled: boolean) {
    const g = this.g
    const kc = this.kc
    if (kc) {
      const live = kc.live
      kc.live = false
      kc.t += rdt
      const mag = Math.hypot(f.moveX, f.moveY)
      if (mag < 0.3) kc.held = false
      const any = f.slash || f.parry || f.dash || f.jump || f.punch || f.ult || f.menu || (mag > 0.3 && !kc.held) || Math.abs(f.lookX) + Math.abs(f.lookY) > 0.05
      if (!live && kc.t > 0.1) this.endKillCam(false)
      else if (enabled && kc.t > 0.25 && any) this.endKillCam(true)
      else if (kc.t > kc.shot.dur + 0.1) this.endKillCam(false)
    }
    // a caught beam hums in the hands
    if (g.player.state === 'catch') {
      this.catchT -= rdt
      if (this.catchT <= 0) {
        this.catchT = 0.12
        this.rumble(0.35 + Math.random() * 0.1, 0.6, 170)
      }
    } else this.catchT = 0
    this.boom.update(pdt, g.player.chestPos(_f))
  }

  reset() {
    if (this.kc) this.endKillCam(true)
    this.dashTimes.length = 0
    this.boom.clear()
    this.lastKillCam = -99
    useUI.getState().setLetterbox(false)
  }
}
