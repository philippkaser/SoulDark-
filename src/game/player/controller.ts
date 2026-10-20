import * as THREE from 'three'
import {
  ESTUS_HEAL_AT,
  PLAYER,
  PLAYER_ACTIONS,
  RIPOSTE_RANGE,
  damageMultFor,
  maxHpFor,
  maxStaminaFor,
  type EnemyAttack,
  type EnemyHit,
  type PlayerActionName,
  type PlayerActionDef,
  type Stats,
} from '../../../shared/combat'
import { collide } from '../../../shared/collision'
import { PLAYER_SPAWN } from '../../../shared/level'
import { angleDiff, clamp, damp, dist2, sampleCurve, turnToward, wrapAngle, yawTo } from '../../../shared/math'
import type { TrailSample } from '../../../shared/protocol'
import { audio } from '../../audio/audio'
import type { InputFrame } from '../../input/input'
import { segmentSegmentDist } from '../combat'
import type { Avatar } from '../rig/avatar'
import { addShake, emitFx, world, type EnemyView } from '../world'

type BufferKind = 'light' | 'heavy' | 'roll' | 'parry' | 'estus'

export interface PlayerHooks {
  send: (msg: import('../../../shared/protocol').ClientMsg) => void
  serverNow: () => number
  onActionChange: () => void
  onDeath: () => void
  onHeal: () => void
}

const LIGHTS: PlayerActionName[] = ['light1', 'light2', 'light3']
const GESTURES: PlayerActionName[] = ['praise', 'bow', 'wave', 'point']
const isAttack = (a: PlayerActionName | null) =>
  !!a && (LIGHTS.includes(a) || a === 'heavy' || a === 'sprintAttack' || a === 'riposte')

const _base = new THREE.Vector3()
const _tip = new THREE.Vector3()
const _pb = new THREE.Vector3()
const _pt = new THREE.Vector3()
const _ca = new THREE.Vector3()
const _cb = new THREE.Vector3()
const _hit = new THREE.Vector3()

export class PlayerController {
  x = PLAYER_SPAWN.x
  z = PLAYER_SPAWN.z
  yaw = PLAYER_SPAWN.yaw
  vx = 0
  vz = 0
  speed = 0
  moveAngle = 0
  turnRate = 0
  hp: number
  maxHp: number
  stamina: number
  maxStamina: number
  staminaDelay = 0
  flasks: number = PLAYER.maxFlasks
  maxFlasks: number = PLAYER.maxFlasks
  dmgMult = 1
  action: PlayerActionName | null = null
  actionT = 0
  actionStartServer = 0
  actionYaw = 0
  sprinting = false
  dead = false
  deathAt = 0
  lock: EnemyView | null = null
  buffer: { kind: BufferKind; at: number } | null = null
  /** Rolling record of recent movement for death echoes. */
  trail: TrailSample[] = []
  clock = 0
  /** Visual hit intensity for the HUD (lagging bar). */
  lastDamage = 0

  private prevMove = 0
  private hitSet = new Set<number>()
  private healed = false
  private ripTarget: EnemyView | null = null
  private riposteSent = false
  private swingPlayed = false
  private prevBladeValid = false
  private prevBase = new THREE.Vector3()
  private prevTip = new THREE.Vector3()
  private trailTimer = 0
  private inputYaw: number | null = null
  private lastYaw = this.yaw
  private hooks: PlayerHooks
  avatar: Avatar | null = null

  constructor(stats: Stats, hooks: PlayerHooks) {
    this.hooks = hooks
    this.maxHp = maxHpFor(stats)
    this.hp = this.maxHp
    this.maxStamina = maxStaminaFor(stats)
    this.stamina = this.maxStamina
    this.dmgMult = damageMultFor(stats)
  }

  applyStats(stats: Stats) {
    const hpRatio = this.hp / this.maxHp
    this.maxHp = maxHpFor(stats)
    this.hp = Math.round(this.maxHp * hpRatio)
    this.maxStamina = maxStaminaFor(stats)
    this.dmgMult = damageMultFor(stats)
  }

  get def(): PlayerActionDef | null {
    return this.action ? PLAYER_ACTIONS[this.action] : null
  }

  get invulnerable() {
    const d = this.def
    if (!d) return false
    if (this.action === 'riposte' || this.action === 'fog') return true
    return !!d.iframes && this.actionT >= d.iframes[0] && this.actionT <= d.iframes[1]
  }

  get parrying() {
    const d = this.def
    return !!d?.parry && this.actionT >= d.parry[0] && this.actionT <= d.parry[1]
  }

  get hyperArmor() {
    const d = this.def
    return !!d?.hyperArmor && this.actionT >= d.hyperArmor[0] && this.actionT <= d.hyperArmor[1]
  }

  get resting() {
    return this.action === 'rest'
  }

  /** Is the blade currently in a damaging part of a swing (for trails). */
  get swinging() {
    const d = this.def
    return !!d?.hit && this.actionT >= d.hit[0] - 0.06 && this.actionT <= d.hit[1] + 0.05
  }

  teleport(x: number, z: number, yaw: number) {
    this.x = x
    this.z = z
    this.yaw = yaw
    this.lastYaw = yaw
    this.vx = this.vz = 0
    this.trail = []
  }

  // -------------------------------------------------------------------------

  update(dt: number, f: InputFrame, camYaw: number, nowMs: number, enabled: boolean) {
    this.clock += dt
    const frozen = nowMs < world.hitstopUntil
    const adt = frozen ? dt * 0.05 : dt

    // stamina
    this.staminaDelay -= dt
    const regenBlocked = this.sprinting || isAttack(this.action) || this.action === 'roll' || this.action === 'backstep'
    if (this.staminaDelay <= 0 && !regenBlocked) {
      const rate = this.action === 'estus' ? 0.5 : 1
      this.stamina = Math.min(this.maxStamina, this.stamina + PLAYER.staminaRegen * rate * dt)
    }

    // camera-relative input direction
    const mag = Math.min(1, Math.hypot(f.moveX, f.moveY))
    const cs = Math.cos(camYaw)
    const sn = Math.sin(camYaw)
    let dirX = f.moveY * sn - f.moveX * cs
    let dirZ = f.moveY * cs + f.moveX * sn
    const dl = Math.hypot(dirX, dirZ)
    if (dl > 1e-4) {
      dirX /= dl
      dirZ /= dl
    }
    this.inputYaw = mag > 0.15 ? Math.atan2(dirX, dirZ) : null

    if (this.dead) {
      this.actionT += dt
      this.vx = this.vz = 0
      this.speed = 0
      this.updateAnimParams(dt)
      return
    }

    if (enabled) {
      if (f.light) this.queue('light')
      if (f.heavy) this.queue('heavy')
      if (f.roll) this.queue('roll')
      if (f.parry) this.queue('parry')
      if (f.estus) this.queue('estus')
    }

    let dx = 0
    let dz = 0

    // --- current action timeline
    const d = this.def
    if (d && this.action) {
      const prevT = this.actionT
      this.actionT += adt
      const t = this.actionT

      // steering during the early part of attacks
      if (d.steer && t < d.steer) {
        const want = this.lock?.targetable ? yawTo(this.x, this.z, this.lock.x, this.lock.z) : this.inputYaw
        if (want !== null) this.yaw = turnToward(this.yaw, want, 9 * adt)
        this.actionYaw = this.yaw
      }
      if (this.action === 'roll') this.yaw = turnToward(this.yaw, this.actionYaw, 20 * adt)

      if (d.move) {
        const m = sampleCurve(d.move, t)
        const delta = m - this.prevMove
        this.prevMove = m
        dx += Math.sin(this.actionYaw) * delta
        dz += Math.cos(this.actionYaw) * delta
      }

      // swing whoosh slightly before the blade connects
      if (d.hit && !this.swingPlayed && t >= d.hit[0] - 0.07) {
        this.swingPlayed = true
        audio.swing(this.action === 'heavy' || this.action === 'riposte' ? 'heavy' : 'light')
      }

      if (this.action === 'estus' && !this.healed && t >= ESTUS_HEAL_AT) {
        this.healed = true
        this.hp = Math.min(this.maxHp, this.hp + this.maxHp * PLAYER.flaskHeal)
        this.hooks.onHeal()
      }

      if (this.action === 'riposte') this.updateRiposte(prevT, t)

      if (this.action === 'roll' && prevT < 0.3 && t >= 0.3) audio.roll()

      if (t >= d.dur && !d.loop) {
        this.action = null
        this.actionT = 0
        this.hooks.onActionChange()
      }
    }

    // --- buffered input
    this.consumeBuffer()

    // --- locomotion
    const free = !this.action || !!this.def?.walk
    let targetSpeed = 0
    this.sprinting = false
    if (free && mag > 0.12) {
      const locked = !!this.lock?.targetable
      if (f.sprint && this.stamina > 0 && !this.action) {
        targetSpeed = PLAYER.sprintSpeed
        this.sprinting = true
        this.stamina = Math.max(0, this.stamina - PLAYER.sprintCost * dt)
        this.staminaDelay = 0.35
      } else if (locked) {
        targetSpeed = PLAYER.lockSpeed * Math.max(0.5, mag)
      } else {
        targetSpeed = mag < 0.55 ? PLAYER.walkSpeed * (mag / 0.55) : PLAYER.runSpeed
      }
      if (this.def?.walk) targetSpeed *= this.def.walk
    }
    const k = damp(free ? 13 : 30, dt)
    const tvx = free && mag > 0.12 ? dirX * targetSpeed : 0
    const tvz = free && mag > 0.12 ? dirZ * targetSpeed : 0
    this.vx += (tvx - this.vx) * k
    this.vz += (tvz - this.vz) * k
    if (free) {
      dx += this.vx * dt
      dz += this.vz * dt
      const locked = this.lock?.targetable && !this.sprinting
      let want: number | null = null
      if (locked) want = yawTo(this.x, this.z, this.lock!.x, this.lock!.z)
      else if (mag > 0.12) want = Math.atan2(dirX, dirZ)
      if (want !== null) this.yaw = turnToward(this.yaw, want, (this.def?.walk ? 5 : 14) * dt)
    }

    // --- riposte snaps into position in front of the victim
    if (this.action === 'riposte' && this.ripTarget && this.actionT < 0.45) {
      const e = this.ripTarget
      const a = yawTo(e.x, e.z, this.x, this.z)
      const r = e.def.radius + 0.8
      const tx = e.x + Math.sin(a) * r
      const tz = e.z + Math.cos(a) * r
      const kk = damp(10, dt)
      dx += (tx - this.x) * kk
      dz += (tz - this.z) * kk
      this.yaw = turnToward(this.yaw, yawTo(this.x, this.z, e.x, e.z), 12 * dt)
      this.actionYaw = this.yaw
    }

    // --- collide with the level and living enemies
    const extra: Array<{ x: number; z: number; r: number }> = []
    for (const e of world.enemies.values()) {
      if (e.state === 'dead' || e.state === 'riposted') continue
      extra.push({ x: e.x, z: e.z, r: e.def.radius })
    }
    const [nx, nz] = collide(this.x + dx, this.z + dz, PLAYER.radius, {
      fogClosed: world.flags.fog,
      ignoreFog: this.action === 'fog',
      extra,
    })
    const mvx = (nx - this.x) / Math.max(dt, 1e-4)
    const mvz = (nz - this.z) / Math.max(dt, 1e-4)
    this.x = nx
    this.z = nz
    const sp = Math.hypot(mvx, mvz)
    this.speed += (Math.min(sp, 9) - this.speed) * damp(14, dt)
    if (sp > 0.1) this.moveAngle = wrapAngle(Math.atan2(mvx, mvz) - this.yaw)
    if (!free) this.speed *= this.action === 'estus' || this.action === 'fog' ? 1 : 0

    this.updateAnimParams(dt)

    // lock validity
    if (this.lock) {
      const maxD = this.lock.type === 'boss' ? 50 : 24
      if (!this.lock.targetable || dist2(this.x, this.z, this.lock.x, this.lock.z) > maxD) this.lock = null
    }

    // death-echo trail (10 Hz, last 6 s)
    this.trailTimer -= dt
    if (this.trailTimer <= 0) {
      this.trailTimer = 0.1
      this.trail.push({ x: this.x, z: this.z, yaw: this.yaw, a: this.action ?? '', t: this.clock })
      while (this.trail.length && this.clock - this.trail[0].t > 6) this.trail.shift()
    }
  }

  private updateAnimParams(dt: number) {
    const dy = wrapAngle(this.yaw - this.lastYaw)
    this.lastYaw = this.yaw
    this.turnRate += (dy / Math.max(dt, 1e-4) - this.turnRate) * damp(8, dt)
  }

  private queue(kind: BufferKind) {
    this.buffer = { kind, at: this.clock }
  }

  private canInterrupt() {
    if (!this.action) return true
    const d = this.def!
    if (GESTURES.includes(this.action) && this.actionT > 0.25) return true
    return d.cancel !== undefined && this.actionT >= d.cancel
  }

  private consumeBuffer() {
    const b = this.buffer
    if (!b) return
    if (this.clock - b.at > 0.42) {
      this.buffer = null
      return
    }
    const a = this.action
    const d = this.def
    let next: PlayerActionName | null = null
    switch (b.kind) {
      case 'light': {
        if (a && LIGHTS.includes(a)) {
          if (d!.combo && this.actionT >= d!.combo[0]) next = d!.next ?? 'light1'
        } else if (this.canInterrupt()) {
          const rip = this.findRiposteTarget()
          if (rip) {
            this.ripTarget = rip
            next = 'riposte'
          } else if (!a && this.speed > 5.2) next = 'sprintAttack'
          else next = 'light1'
        }
        break
      }
      case 'heavy':
        if (this.canInterrupt()) next = 'heavy'
        break
      case 'roll':
        if (this.canInterrupt()) next = this.inputYaw !== null ? 'roll' : 'backstep'
        break
      case 'parry':
        if (this.canInterrupt()) next = 'parry'
        break
      case 'estus':
        if (this.canInterrupt()) {
          if (this.flasks > 0) next = 'estus'
          else this.buffer = null
        }
        break
    }
    if (next && this.start(next)) this.buffer = null
  }

  private findRiposteTarget(): EnemyView | null {
    let best: EnemyView | null = null
    let bestD = Infinity
    for (const e of world.enemies.values()) {
      const ok = e.state === 'parried' || (e.type === 'boss' && e.state === 'stagger')
      if (!ok || !e.targetable) continue
      const d = dist2(this.x, this.z, e.x, e.z) - e.def.radius
      if (d > RIPOSTE_RANGE) continue
      const facing = Math.abs(angleDiff(this.yaw, yawTo(this.x, this.z, e.x, e.z)))
      if (facing > 1.3) continue
      if (d < bestD) {
        bestD = d
        best = e
      }
    }
    return best
  }

  start(name: PlayerActionName, force = false) {
    const d = PLAYER_ACTIONS[name]
    if (!force && d.stamina) {
      if (this.stamina <= 0) return false
      this.stamina = Math.max(-10, this.stamina - d.stamina)
      this.staminaDelay = PLAYER.staminaDelay + (isAttack(name) ? 0.15 : 0)
    }
    if (name === 'roll') {
      this.actionYaw = this.inputYaw ?? this.yaw
    } else if (name === 'backstep') {
      this.actionYaw = this.yaw
    } else if (isAttack(name)) {
      if (this.lock?.targetable) this.yaw = yawTo(this.x, this.z, this.lock.x, this.lock.z)
      else if (this.inputYaw !== null) this.yaw = this.inputYaw
      this.actionYaw = this.yaw
    } else {
      this.actionYaw = this.yaw
    }
    if (name === 'estus') this.flasks--
    this.action = name
    this.actionT = 0
    this.prevMove = 0
    this.hitSet.clear()
    this.healed = false
    this.riposteSent = false
    this.swingPlayed = false
    this.prevBladeValid = false
    this.sprinting = false
    this.actionStartServer = this.hooks.serverNow()
    this.hooks.onActionChange()
    return true
  }

  private updateRiposte(prevT: number, t: number) {
    const d = PLAYER_ACTIONS.riposte
    const e = this.ripTarget
    if (!e || this.riposteSent || prevT >= d.hit![0] || t < d.hit![0]) return
    this.riposteSent = true
    const dmg = Math.round(d.dmg! * this.dmgMult)
    this.hooks.send({ t: 'riposte', id: e.id, dmg })
    _hit.set(e.x, e.def.height * 0.55, e.z)
    emitFx({ kind: 'blood', p: _hit.clone(), count: 60 })
    emitFx({ kind: 'spark', p: _hit.clone(), count: 20, big: true })
    world.hitstopUntil = performance.now() + 160
    e.freezeUntil = performance.now() + 160
    e.flash = 1
    e.dmgAccum = (performance.now() - e.dmgAt < 2500 ? e.dmgAccum : 0) + dmg
    e.dmgAt = performance.now()
    addShake(0.45)
    audio.hit(e.type === 'hollow' ? 'flesh' : 'armor', { x: e.x, z: e.z }, true)
  }

  /** Weapon hit detection; call after the avatar has been posed this frame. */
  postAnimate() {
    const d = this.def
    const av = this.avatar
    if (!av || !d?.hit || this.action === 'riposte' || this.dead) {
      this.prevBladeValid = false
      return
    }
    av.getBlade(_base, _tip)
    const t = this.actionT
    if (t >= d.hit[0] - 0.015 && t <= d.hit[1]) {
      if (!this.prevBladeValid) {
        this.prevBase.copy(_base)
        this.prevTip.copy(_tip)
      }
      for (const e of world.enemies.values()) {
        if (!e.targetable || e.state === 'dormant' || e.state === 'riposted' || this.hitSet.has(e.id)) continue
        if (dist2(this.x, this.z, e.x, e.z) > e.def.radius + 2.8) continue
        _ca.set(e.x, 0.25, e.z)
        _cb.set(e.x, e.def.height * 0.88, e.z)
        const r = e.def.radius + 0.06
        let hit = false
        for (let s = 0; s <= 3 && !hit; s++) {
          const k = s / 3
          _pb.lerpVectors(this.prevBase, _base, k)
          _pt.lerpVectors(this.prevTip, _tip, k)
          if (segmentSegmentDist(_pb, _pt, _ca, _cb, _hit) < r) hit = true
        }
        if (hit) this.landHit(e, d)
      }
    }
    this.prevBase.copy(_base)
    this.prevTip.copy(_tip)
    this.prevBladeValid = true
  }

  private landHit(e: EnemyView, d: PlayerActionDef) {
    this.hitSet.add(e.id)
    const heavy = this.action === 'heavy' || this.action === 'light3' || this.action === 'sprintAttack'
    const dmg = Math.round((d.dmg ?? 40) * this.dmgMult * (0.94 + Math.random() * 0.12))
    this.hooks.send({ t: 'hit', id: e.id, dmg, poise: d.poise ?? 10, atk: this.action ?? '' })
    const now = performance.now()
    e.flash = 1
    e.dmgAccum = (now - e.dmgAt < 2500 ? e.dmgAccum : 0) + dmg
    e.dmgAt = now
    const stop = heavy ? 105 : 70
    world.hitstopUntil = now + stop
    e.freezeUntil = now + stop
    addShake(heavy ? 0.26 : 0.13)
    const dir = new THREE.Vector3().subVectors(_tip, this.prevTip).normalize()
    if (e.type === 'hollow') {
      emitFx({ kind: 'blood', p: _hit.clone(), dir, count: heavy ? 40 : 24 })
      audio.hit('flesh', { x: e.x, z: e.z }, heavy)
    } else {
      emitFx({ kind: 'spark', p: _hit.clone(), dir, count: heavy ? 26 : 16 })
      emitFx({ kind: 'blood', p: _hit.clone(), dir, count: 10 })
      audio.hit(e.type === 'boss' ? 'boss' : 'armor', { x: e.x, z: e.z }, heavy)
    }
  }

  /** An enemy attack connected with us (client-authoritative for our own damage). */
  receiveHit(e: EnemyView, h: EnemyHit, atk: EnemyAttack) {
    if (this.dead) return 'none'
    if (this.invulnerable) return 'dodged'
    const toEnemy = yawTo(this.x, this.z, e.x, e.z)
    if (this.parrying && atk.parryable && Math.abs(angleDiff(this.yaw, toEnemy)) < 1.4) {
      this.hooks.send({ t: 'parry', id: e.id })
      audio.parry({ x: this.x, z: this.z })
      const p = new THREE.Vector3(this.x + Math.sin(this.yaw) * 0.5, 1.25, this.z + Math.cos(this.yaw) * 0.5)
      emitFx({ kind: 'parry', p })
      world.parryFlash = 1
      world.hitstopUntil = performance.now() + 130
      e.freezeUntil = performance.now() + 130
      addShake(0.2)
      return 'parried'
    }
    const dmg = h.dmg
    this.hp = Math.max(0, this.hp - dmg)
    this.lastDamage = dmg
    world.hurtFlash = Math.min(1, 0.45 + dmg / 250)
    addShake(0.3 + Math.min(0.5, dmg / 300))
    audio.hit('player', { x: this.x, z: this.z }, dmg > 100)
    emitFx({ kind: 'blood', p: new THREE.Vector3(this.x, 1.2, this.z), count: 30 })
    if (this.hp <= 0) {
      this.die()
      return 'killed'
    }
    if (!this.hyperArmor) {
      this.yaw = toEnemy
      this.start(h.knockdown ? 'knockdown' : 'hurt', true)
    }
    return 'hit'
  }

  die() {
    this.dead = true
    this.hp = 0
    this.lock = null
    this.buffer = null
    this.action = 'death'
    this.actionT = 0
    this.deathAt = this.clock
    this.actionStartServer = this.hooks.serverNow()
    this.hooks.onActionChange()
    this.hooks.onDeath()
  }

  respawn(x: number, z: number, yaw: number) {
    this.dead = false
    this.hp = this.maxHp
    this.stamina = this.maxStamina
    this.flasks = this.maxFlasks
    this.action = null
    this.actionT = 0
    this.teleport(x, z, yaw)
    this.avatar?.resetCloth()
    this.hooks.onActionChange()
  }

  rest() {
    this.hp = this.maxHp
    this.stamina = this.maxStamina
    this.flasks = this.maxFlasks
    this.lock = null
    this.start('rest', true)
  }

  standUp() {
    if (this.action === 'rest') {
      this.action = null
      this.actionT = 0
      this.hooks.onActionChange()
    }
  }

  get staminaRatio() {
    return clamp(this.stamina / this.maxStamina, 0, 1)
  }
}
