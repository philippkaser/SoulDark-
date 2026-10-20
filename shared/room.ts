import {
  ALL_ENEMY_ATTACKS,
  BOSS_CRIT_MULT,
  BOSS_ROAR,
  ENEMY_STATE_DUR,
  ENEMY_TYPES,
  type EnemyAttack,
  type EnemyTypeDef,
} from './combat'
import { collide, insideZones } from './collision'
import { ENEMY_SPAWNS, inArena, type EnemySpawn, type EnemyTypeId } from './level'
import { angleDiff, clamp, dist2, sampleCurve, turnToward, wrapAngle, yawTo } from './math'
import {
  isValidMessage,
  sanitizeChat,
  sanitizeName,
  type Bloodstain,
  type ClientMsg,
  type EnemySnap,
  type EnemyStateName,
  type GroundMessage,
  type Look,
  type PlayerInfo,
  type PlayerSnap,
  type ServerMsg,
  type TrailSample,
  type WorldFlags,
} from './protocol'

const SNAP_INTERVAL = 50
const RESPAWN_MS = 75_000
const BOSS_RESPAWN_MS = 180_000

interface PlayerRec extends PlayerSnap {
  name: string
  look: Look
  send: (msg: ServerMsg) => void
  joined: boolean
  lastSeen: number
}

interface Enemy {
  id: number
  spawn: EnemySpawn
  type: EnemyTypeId
  def: EnemyTypeDef
  x: number
  z: number
  yaw: number
  hp: number
  maxHp: number
  poise: number
  lastHitAt: number
  state: EnemyStateName
  ss: number
  stateDur: number
  attack: EnemyAttack | null
  prevMove: number
  leapDist: number
  target: string | null
  retargetAt: number
  thinkAt: number
  phase: number
  rate: number
  strafeDir: 1 | -1
  cooldowns: Map<string, number>
  aggro: Map<string, number>
  contributors: Set<string>
  deadAt: number
  pendingPhase: boolean
  pendingDeath: boolean
}

export interface RoomOptions {
  name: string
  now?: () => number
  random?: () => number
  messages?: GroundMessage[]
  onMessagesChanged?: (messages: GroundMessage[]) => void
}

const SEED_MESSAGES: Array<Omit<GroundMessage, 'id'>> = [
  { x: 1.6, z: 41.5, text: 'Ahh, bonfire...', author: 'Solaire', rating: 41 },
  { x: -2, z: 30, text: 'Be wary of hollow', author: 'Siegmeyer', rating: 18 },
  { x: 1.5, z: -3.5, text: 'Try parrying', author: 'Patches', rating: 7 },
  { x: -1.2, z: -20, text: 'Be wary of knight', author: 'Laurentius', rating: 22 },
  { x: 1.4, z: -26.5, text: 'Time for courage', author: 'Anri', rating: 33 },
  { x: 2, z: -36, text: 'Praise the Sun!', author: 'Solaire', rating: 99 },
]

export class Room {
  readonly name: string
  private now: () => number
  private random: () => number
  private players = new Map<string, PlayerRec>()
  private enemies: Enemy[] = []
  private messages: GroundMessage[]
  private messageRaters = new Map<number, Set<string>>()
  private stains: Bloodstain[] = []
  private nextMsgId = 1
  private nextStainId = 1
  private lastTick: number
  private lastSnap = 0
  private bossState: 0 | 1 | 2 = 0
  private bossEmptySince = 0
  private bossDefeatedAt = 0
  private onMessagesChanged?: (m: GroundMessage[]) => void

  constructor(opts: RoomOptions) {
    this.name = opts.name
    this.now = opts.now ?? (() => performance.now())
    this.random = opts.random ?? Math.random
    this.onMessagesChanged = opts.onMessagesChanged
    this.messages = opts.messages?.length
      ? opts.messages
      : SEED_MESSAGES.map((m) => ({ ...m, id: 0 }))
    for (const m of this.messages) {
      m.id = this.nextMsgId++
    }
    this.lastTick = this.now()
    ENEMY_SPAWNS.forEach((spawn, i) => this.enemies.push(this.makeEnemy(i + 1, spawn)))
  }

  get playerCount() {
    return this.players.size
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  connect(id: string, send: (msg: ServerMsg) => void) {
    const now = this.now()
    this.players.set(id, {
      id,
      name: 'Unkindled',
      look: { cloak: 0, crest: 0 },
      send,
      joined: false,
      lastSeen: now,
      x: 0,
      y: 0,
      z: 40,
      yaw: Math.PI,
      vx: 0,
      vz: 0,
      hp: 1,
      mhp: 1,
      a: '',
      as: 0,
      lk: -1,
      sp: false,
    })
  }

  disconnect(id: string) {
    const p = this.players.get(id)
    if (!p) return
    this.players.delete(id)
    for (const e of this.enemies) {
      if (e.target === id) e.target = null
      e.aggro.delete(id)
    }
    if (p.joined) {
      this.broadcast({ t: 'leave', id })
      this.broadcast({ t: 'sys', text: `${p.name} has returned to their world` })
    }
  }

  handle(id: string, msg: ClientMsg) {
    const p = this.players.get(id)
    if (!p || !msg || typeof msg !== 'object') return
    const now = this.now()
    p.lastSeen = now
    switch (msg.t) {
      case 'join': {
        if (p.joined) return
        p.name = sanitizeName(msg.name)
        p.look = {
          cloak: clamp(Math.floor(Number(msg.look?.cloak) || 0), 0, 5),
          crest: clamp(Math.floor(Number(msg.look?.crest) || 0), 0, 3),
        }
        p.joined = true
        const others: PlayerInfo[] = []
        for (const o of this.players.values()) if (o.joined && o.id !== id) others.push(this.info(o))
        p.send({
          t: 'welcome',
          id,
          time: now,
          room: this.name,
          players: others,
          messages: this.messages,
          stains: this.stains,
          w: this.flags(),
        })
        this.broadcast({ t: 'join', p: this.info(p) }, id)
        this.broadcast({ t: 'sys', text: `Phantom ${p.name} has been summoned` }, id)
        return
      }
      case 'st': {
        if (!p.joined) return
        if (![msg.x, msg.y, msg.z, msg.yaw, msg.hp, msg.mhp].every(Number.isFinite)) return
        p.x = msg.x
        p.y = msg.y
        p.z = msg.z
        p.yaw = msg.yaw
        p.vx = Number(msg.vx) || 0
        p.vz = Number(msg.vz) || 0
        p.hp = msg.hp
        p.mhp = msg.mhp
        p.a = typeof msg.a === 'string' ? msg.a.slice(0, 16) : ''
        p.as = Number(msg.as) || 0
        p.lk = Number(msg.lk) || -1
        p.sp = !!msg.sp
        return
      }
      case 'hit':
        return this.onHit(p, msg.id, msg.dmg, msg.poise)
      case 'parry':
        return this.onParry(p, msg.id)
      case 'riposte':
        return this.onRiposte(p, msg.id, msg.dmg)
      case 'died':
        return this.onDied(p, msg.x, msg.z, msg.trail)
      case 'rest':
        return this.onRest()
      case 'msg':
        return this.onMessage(p, msg.x, msg.z, msg.text)
      case 'rate':
        return this.onRate(p, msg.id)
      case 'chat': {
        const text = sanitizeChat(msg.text)
        if (text) this.broadcast({ t: 'chat', id, name: p.name, text })
        return
      }
      case 'ping':
        p.send({ t: 'pong', c: msg.c, s: now })
        return
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  tick() {
    const now = this.now()
    const dt = Math.min(0.1, (now - this.lastTick) / 1000)
    this.lastTick = now
    if (dt <= 0) return
    this.updateBossFlow(now)
    for (const e of this.enemies) this.updateEnemy(e, dt, now)
    this.separate()
    if (now - this.lastSnap >= SNAP_INTERVAL) {
      this.lastSnap = now
      this.broadcastSnap(now)
    }
  }

  private makeEnemy(id: number, spawn: EnemySpawn): Enemy {
    const def = ENEMY_TYPES[spawn.type]
    return {
      id,
      spawn,
      type: spawn.type,
      def,
      x: spawn.x,
      z: spawn.z,
      yaw: spawn.yaw,
      hp: def.hp,
      maxHp: def.hp,
      poise: def.poise,
      lastHitAt: 0,
      state: spawn.type === 'boss' ? 'dormant' : 'idle',
      ss: this.now(),
      stateDur: 0,
      attack: null,
      prevMove: 0,
      leapDist: 0,
      target: null,
      retargetAt: 0,
      thinkAt: 0,
      phase: 1,
      rate: 1,
      strafeDir: 1,
      cooldowns: new Map(),
      aggro: new Map(),
      contributors: new Set(),
      deadAt: 0,
      pendingPhase: false,
      pendingDeath: false,
    }
  }

  private resetEnemy(e: Enemy) {
    Object.assign(e, this.makeEnemy(e.id, e.spawn))
  }

  private alive(p: PlayerRec) {
    return p.joined && p.hp > 0 && p.a !== 'death'
  }

  private setState(e: Enemy, s: EnemyStateName, now: number, dur = 0) {
    e.state = s
    e.ss = now
    e.stateDur = dur
    if (s !== 'attack') e.attack = null
  }

  private startAttack(e: Enemy, atk: EnemyAttack, now: number) {
    e.state = 'attack'
    e.ss = now
    e.attack = atk
    e.prevMove = 0
    e.leapDist = 0
    if (atk.leap) {
      const t = e.target ? this.players.get(e.target) : undefined
      e.leapDist = t ? clamp(dist2(e.x, e.z, t.x, t.z) - 1.6, 0, 16) : 6
    }
    if (atk.cooldown) e.cooldowns.set(atk.id, now + atk.cooldown * 1000)
  }

  /** Called when an enemy finishes something interruptible and could act again. */
  private resume(e: Enemy, now: number) {
    if (e.pendingDeath) return this.kill(e, now)
    if (e.pendingPhase) {
      e.pendingPhase = false
      e.phase = 2
      e.rate = 1.12
      this.startAttack(e, BOSS_ROAR, now)
      this.broadcast({ t: 'boss', ev: 'phase' })
      return
    }
    this.setState(e, 'chase', now)
  }

  private moveEnemy(e: Enemy, dx: number, dz: number) {
    const [x, z] = collide(e.x + dx, e.z + dz, e.def.radius, { fogClosed: true })
    e.x = x
    e.z = z
  }

  private findTarget(e: Enemy, range: number, requireArena = false): PlayerRec | null {
    let best: PlayerRec | null = null
    let bestScore = Infinity
    for (const p of this.players.values()) {
      if (!this.alive(p)) continue
      if (requireArena && !inArena(p.x, p.z)) continue
      const d = dist2(e.x, e.z, p.x, p.z)
      // enemies notice players in front of them from farther away
      const facing = Math.abs(angleDiff(e.yaw, yawTo(e.x, e.z, p.x, p.z)))
      const reach = facing < 1.3 ? range : range * 0.55
      if (d > reach) continue
      const score = d - (e.aggro.get(p.id) ?? 0) * 0.01
      if (score < bestScore) {
        bestScore = score
        best = p
      }
    }
    return best
  }

  private updateEnemy(e: Enemy, dt: number, now: number) {
    const def = e.def
    const t = ((now - e.ss) / 1000) * e.rate
    const isBoss = e.type === 'boss'

    if (e.state === 'dead') {
      if (isBoss) return
      if (now - e.deadAt > RESPAWN_MS && !this.anyPlayerNear(e.spawn.x, e.spawn.z, 18)) this.resetEnemy(e)
      return
    }
    if (e.state === 'dormant') return

    // poise recovers after a few seconds without being hit
    if (now - e.lastHitAt > 4000) e.poise = def.poise
    // aggro decays over time
    for (const [k, v] of e.aggro) e.aggro.set(k, v * Math.exp(-dt * 0.15))

    let target = e.target ? this.players.get(e.target) : undefined
    if (target && !this.alive(target)) target = undefined
    if (isBoss && target && !inArena(target.x, target.z)) target = undefined

    // periodic re-targeting so co-op partners can draw aggro
    if (e.state !== 'idle' && e.state !== 'return' && (now > e.retargetAt || !target)) {
      e.retargetAt = now + 3000
      const nt = this.findTarget(e, isBoss ? 80 : def.aggro * 1.6, isBoss)
      if (nt) {
        target = nt
        e.target = nt.id
      } else if (!target) {
        e.target = null
      }
    }

    switch (e.state) {
      case 'idle': {
        // slowly heal at home
        e.hp = Math.min(e.maxHp, e.hp + dt * 40)
        if (now < e.thinkAt) return
        e.thinkAt = now + 200
        const nt = this.findTarget(e, def.aggro)
        if (nt) {
          e.target = nt.id
          e.retargetAt = now + 3000
          if (e.type === 'hollow') this.setState(e, 'wake', now, ENEMY_STATE_DUR.wake)
          else this.setState(e, 'chase', now)
        }
        return
      }
      case 'wake':
      case 'intro': {
        if (target) e.yaw = turnToward(e.yaw, yawTo(e.x, e.z, target.x, target.z), def.turn * 0.5 * dt)
        const dur = e.state === 'wake' ? ENEMY_STATE_DUR.wake : ENEMY_STATE_DUR.intro
        if (t >= dur) this.setState(e, 'chase', now)
        return
      }
      case 'return': {
        e.hp = Math.min(e.maxHp, e.hp + dt * 60)
        const d = dist2(e.x, e.z, e.spawn.x, e.spawn.z)
        if (d < 0.4) {
          e.yaw = e.spawn.yaw
          e.hp = e.maxHp
          e.aggro.clear()
          e.contributors.clear()
          this.setState(e, 'idle', now)
          return
        }
        const yaw = yawTo(e.x, e.z, e.spawn.x, e.spawn.z)
        e.yaw = turnToward(e.yaw, yaw, def.turn * dt)
        const step = Math.min(d, def.walk * 1.4 * dt)
        this.moveEnemy(e, Math.sin(yaw) * step, Math.cos(yaw) * step)
        if (t > 2) {
          const nt = this.findTarget(e, def.aggro * 0.8)
          if (nt) {
            e.target = nt.id
            this.setState(e, 'chase', now)
          }
        }
        return
      }
      case 'chase':
      case 'strafe': {
        if (!target) {
          if (isBoss) {
            this.setState(e, 'recover', now, 1)
          } else {
            e.target = null
            this.setState(e, 'return', now)
          }
          return
        }
        if (!isBoss && dist2(e.x, e.z, e.spawn.x, e.spawn.z) > def.leash) {
          e.target = null
          this.setState(e, 'return', now)
          return
        }
        const d = dist2(e.x, e.z, target.x, target.z)
        const want = yawTo(e.x, e.z, target.x, target.z)
        e.yaw = turnToward(e.yaw, want, def.turn * dt)
        const facing = Math.abs(angleDiff(e.yaw, want))

        if (now >= e.thinkAt) {
          e.thinkAt = now + 120 + this.random() * 180
          if (facing < 0.7) {
            const atk = this.pickAttack(e, d, now)
            if (atk) {
              this.startAttack(e, atk, now)
              return
            }
          }
          if (e.state === 'chase' && !isBoss && d > 2.4 && d < 6.5 && this.random() < 0.06) {
            e.strafeDir = this.random() < 0.5 ? 1 : -1
            this.setState(e, 'strafe', now, 1 + this.random() * 1.4)
            return
          }
        }

        if (e.state === 'strafe') {
          if (t >= e.stateDur) {
            this.setState(e, 'chase', now)
            return
          }
          const side = want + (Math.PI / 2) * e.strafeDir
          const radial = clamp((d - 3.4) * 0.6, -0.6, 0.6)
          const sp = def.walk * 0.85 * dt
          this.moveEnemy(
            e,
            (Math.sin(side) + Math.sin(want) * radial) * sp,
            (Math.cos(side) + Math.cos(want) * radial) * sp,
          )
          return
        }

        const close = isBoss ? 3.2 : 1.7
        if (d > close) {
          const fast = isBoss ? d > 11 : d > 5.5
          const sp = (fast ? def.run : def.walk) * dt * (facing < 1.2 ? 1 : 0.3)
          this.moveEnemy(e, Math.sin(e.yaw) * sp, Math.cos(e.yaw) * sp)
        }
        return
      }
      case 'attack': {
        const atk = e.attack!
        if (target && t < atk.trackUntil && atk.tracking > 0) {
          e.yaw = turnToward(e.yaw, yawTo(e.x, e.z, target.x, target.z), atk.tracking * e.rate * dt)
        }
        const scale = atk.leap ? e.leapDist : 1
        const m = sampleCurve(atk.move, t) * scale
        const delta = m - e.prevMove
        e.prevMove = m
        if (delta !== 0) this.moveEnemy(e, Math.sin(e.yaw) * delta, Math.cos(e.yaw) * delta)
        if (t >= atk.dur) {
          if (e.pendingPhase || e.pendingDeath) return this.resume(e, now)
          if (atk.chain && target && this.random() < atk.chain.p) {
            const next = ALL_ENEMY_ATTACKS[atk.chain.id]
            const d = dist2(e.x, e.z, target.x, target.z)
            if (next && d <= next.maxD + 1) {
              this.startAttack(e, next, now)
              return
            }
          }
          const [a, b] = def.recover
          this.setState(e, 'recover', now, a + this.random() * (b - a))
        }
        return
      }
      case 'recover': {
        if (target) e.yaw = turnToward(e.yaw, yawTo(e.x, e.z, target.x, target.z), def.turn * 0.6 * dt)
        if (t >= e.stateDur) this.resume(e, now)
        return
      }
      case 'hurt':
        if (t >= ENEMY_STATE_DUR.hurt) this.resume(e, now)
        return
      case 'stagger':
        if (t >= def.stagger) this.resume(e, now)
        return
      case 'parried':
        if (t >= ENEMY_STATE_DUR.parried) this.resume(e, now)
        return
      case 'riposted':
        if (t >= ENEMY_STATE_DUR.riposted) this.resume(e, now)
        return
    }
  }

  private pickAttack(e: Enemy, d: number, now: number): EnemyAttack | null {
    let total = 0
    const options: EnemyAttack[] = []
    for (const a of e.def.attacks) {
      if (a.phase && e.phase < a.phase) continue
      if (d < a.minD || d > a.maxD) continue
      if ((e.cooldowns.get(a.id) ?? 0) > now) continue
      options.push(a)
      total += a.weight
    }
    if (!options.length) return null
    let r = this.random() * total
    for (const a of options) {
      r -= a.weight
      if (r <= 0) return a
    }
    return options[options.length - 1]
  }

  private separate() {
    const es = this.enemies
    for (let i = 0; i < es.length; i++) {
      const a = es[i]
      if (a.state === 'dead' || a.state === 'dormant') continue
      for (let j = i + 1; j < es.length; j++) {
        const b = es[j]
        if (b.state === 'dead' || b.state === 'dormant') continue
        const dx = b.x - a.x
        const dz = b.z - a.z
        const min = a.def.radius + b.def.radius
        const d2 = dx * dx + dz * dz
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2)
          const push = (min - d) / 2
          this.moveEnemy(a, (-dx / d) * push, (-dz / d) * push)
          this.moveEnemy(b, (dx / d) * push, (dz / d) * push)
        }
      }
      if (a.state === 'riposted') continue
      for (const p of this.players.values()) {
        if (!this.alive(p)) continue
        const dx = a.x - p.x
        const dz = a.z - p.z
        const min = a.def.radius + 0.36
        const d2 = dx * dx + dz * dz
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2)
          this.moveEnemy(a, (dx / d) * (min - d), (dz / d) * (min - d))
        }
      }
    }
  }

  private anyPlayerNear(x: number, z: number, r: number) {
    for (const p of this.players.values()) {
      if (p.joined && dist2(x, z, p.x, p.z) < r) return true
    }
    return false
  }

  private updateBossFlow(now: number) {
    const boss = this.enemies.find((e) => e.type === 'boss')
    if (!boss) return
    let inside = 0
    let joined = 0
    for (const p of this.players.values()) {
      if (!p.joined) continue
      joined++
      if (this.alive(p) && inArena(p.x, p.z)) inside++
    }
    if (this.bossState === 0) {
      if (inside > 0) {
        this.bossState = 1
        boss.maxHp = Math.round(boss.def.hp * (1 + 0.65 * Math.max(0, joined - 1)))
        boss.hp = boss.maxHp
        boss.target = this.findTarget(boss, 80, true)?.id ?? null
        this.setState(boss, 'intro', now)
        this.broadcast({ t: 'boss', ev: 'start' })
      }
    } else if (this.bossState === 1) {
      if (inside === 0) {
        if (!this.bossEmptySince) this.bossEmptySince = now
        if (now - this.bossEmptySince > 4500) {
          this.bossEmptySince = 0
          this.bossState = 0
          this.resetEnemy(boss)
          this.broadcast({ t: 'boss', ev: 'reset' })
        }
      } else {
        this.bossEmptySince = 0
      }
    } else if (this.bossState === 2) {
      if (now - this.bossDefeatedAt > BOSS_RESPAWN_MS && inside === 0 && !this.anyPlayerNear(0, -50, 30)) {
        this.bossState = 0
        this.resetEnemy(boss)
        this.broadcast({ t: 'boss', ev: 'reset' })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Player-originated combat events
  // -------------------------------------------------------------------------

  private onHit(p: PlayerRec, id: number, dmg: number, poise: number) {
    const e = this.enemies.find((x) => x.id === id)
    if (!e || e.state === 'dead' || e.state === 'dormant' || e.state === 'riposted' || e.pendingDeath) return
    if (!Number.isFinite(dmg) || !Number.isFinite(poise)) return
    if (dist2(p.x, p.z, e.x, e.z) > e.def.radius + 4.5) return
    const now = this.now()
    dmg = clamp(dmg, 0, 420)
    poise = clamp(poise, 0, 90)
    e.hp -= dmg
    e.lastHitAt = now
    e.contributors.add(p.id)
    e.aggro.set(p.id, (e.aggro.get(p.id) ?? 0) + dmg)
    if (!e.target || e.state === 'idle' || e.state === 'return') {
      e.target = p.id
      e.retargetAt = now + 3000
    }
    if (e.hp <= 0) {
      e.hp = 0
      return this.kill(e, now)
    }
    if (e.type === 'boss' && e.phase === 1 && e.hp <= e.maxHp * 0.5) e.pendingPhase = true
    e.poise -= poise
    if (e.def.flinch) {
      this.setState(e, 'hurt', now)
    } else if (e.poise <= 0) {
      e.poise = e.def.poise
      this.setState(e, 'stagger', now)
    } else if (e.state === 'idle' || e.state === 'return' || e.state === 'wake') {
      this.setState(e, 'chase', now)
    }
    if (e.pendingPhase && (e.state === 'chase' || e.state === 'strafe' || e.state === 'recover')) this.resume(e, now)
  }

  private onParry(p: PlayerRec, id: number) {
    const e = this.enemies.find((x) => x.id === id)
    if (!e || e.state !== 'attack' || !e.attack?.parryable) return
    if (dist2(p.x, p.z, e.x, e.z) > 4.5) return
    const now = this.now()
    const t = ((now - e.ss) / 1000) * e.rate
    const first = e.attack.hits[0]
    const last = e.attack.hits[e.attack.hits.length - 1]
    // generous window to absorb latency between client and server
    if (t < first.t0 - 0.45 || t > last.t1 + 0.35) return
    e.target = p.id
    this.setState(e, 'parried', now)
  }

  private onRiposte(p: PlayerRec, id: number, dmg: number) {
    const e = this.enemies.find((x) => x.id === id)
    if (!e || e.pendingDeath) return
    const ok = e.state === 'parried' || (e.type === 'boss' && e.state === 'stagger')
    if (!ok || dist2(p.x, p.z, e.x, e.z) > e.def.radius + 3.2) return
    if (!Number.isFinite(dmg)) return
    const now = this.now()
    dmg = clamp(dmg, 0, 1200) * (e.type === 'boss' ? BOSS_CRIT_MULT : 1)
    e.hp -= dmg
    e.lastHitAt = now
    e.contributors.add(p.id)
    e.aggro.set(p.id, (e.aggro.get(p.id) ?? 0) + dmg)
    e.yaw = yawTo(e.x, e.z, p.x, p.z)
    if (e.hp <= 0) {
      e.hp = 0
      e.pendingDeath = true
    } else if (e.type === 'boss' && e.phase === 1 && e.hp <= e.maxHp * 0.5) {
      e.pendingPhase = true
    }
    this.setState(e, 'riposted', now)
  }

  private kill(e: Enemy, now: number) {
    e.pendingDeath = false
    e.pendingPhase = false
    e.hp = 0
    e.deadAt = now
    this.setState(e, 'dead', now)
    this.broadcast({ t: 'kill', id: e.id, souls: e.def.souls, by: [...e.contributors], ty: e.type })
    e.contributors.clear()
    if (e.type === 'boss') {
      this.bossState = 2
      this.bossDefeatedAt = now
      this.broadcast({ t: 'boss', ev: 'defeated' })
    }
  }

  private onDied(p: PlayerRec, x: number, z: number, trail: TrailSample[]) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return
    const clean: TrailSample[] = Array.isArray(trail)
      ? trail.slice(-80).map((s) => ({
          x: Number(s.x) || 0,
          z: Number(s.z) || 0,
          yaw: Number(s.yaw) || 0,
          a: typeof s.a === 'string' ? s.a.slice(0, 16) : '',
          t: Number(s.t) || 0,
        }))
      : []
    const stain: Bloodstain = { id: this.nextStainId++, x, z, name: p.name, trail: clean }
    this.stains.push(stain)
    if (this.stains.length > 24) this.stains.shift()
    this.broadcast({ t: 'stain', s: stain }, p.id)
  }

  private onRest() {
    for (const e of this.enemies) {
      if (e.type === 'boss' || e.state !== 'dead') continue
      if (!this.anyPlayerNear(e.spawn.x, e.spawn.z, 12)) this.resetEnemy(e)
    }
  }

  private onMessage(p: PlayerRec, x: number, z: number, text: string) {
    if (!isValidMessage(text) || !Number.isFinite(x) || !Number.isFinite(z)) return
    if (!insideZones(x, z, 0.5)) return
    const mine = this.messages.filter((m) => m.author === p.name)
    if (mine.length >= 5) this.messages.splice(this.messages.indexOf(mine[0]), 1)
    if (this.messages.length > 120) this.messages.shift()
    const m: GroundMessage = { id: this.nextMsgId++, x, z, text, author: p.name, rating: 0 }
    this.messages.push(m)
    this.broadcast({ t: 'msgs', add: [m] })
    this.onMessagesChanged?.(this.messages)
  }

  private onRate(p: PlayerRec, id: number) {
    const m = this.messages.find((x) => x.id === id)
    if (!m || m.author === p.name) return
    let raters = this.messageRaters.get(id)
    if (!raters) this.messageRaters.set(id, (raters = new Set()))
    if (raters.has(p.id)) return
    raters.add(p.id)
    m.rating++
    this.broadcast({ t: 'msgs', upd: { id, rating: m.rating }, author: m.author })
    this.onMessagesChanged?.(this.messages)
  }

  // -------------------------------------------------------------------------
  // Networking helpers
  // -------------------------------------------------------------------------

  private info(p: PlayerRec): PlayerInfo {
    return { id: p.id, name: p.name, look: p.look }
  }

  private flags(): WorldFlags {
    return { fog: this.bossState !== 2, boss: this.bossState }
  }

  private broadcast(msg: ServerMsg, except?: string) {
    for (const p of this.players.values()) {
      if (!p.joined || p.id === except) continue
      p.send(msg)
    }
  }

  private broadcastSnap(now: number) {
    const r2 = (v: number) => Math.round(v * 100) / 100
    const ps: PlayerSnap[] = []
    for (const p of this.players.values()) {
      if (!p.joined) continue
      ps.push({
        id: p.id,
        x: r2(p.x),
        y: r2(p.y),
        z: r2(p.z),
        yaw: Math.round(wrapAngle(p.yaw) * 1000) / 1000,
        vx: r2(p.vx),
        vz: r2(p.vz),
        hp: Math.round(p.hp),
        mhp: Math.round(p.mhp),
        a: p.a,
        as: Math.round(p.as),
        lk: p.lk,
        sp: p.sp,
      })
    }
    const es: EnemySnap[] = this.enemies.map((e) => ({
      id: e.id,
      ty: e.type,
      x: r2(e.x),
      z: r2(e.z),
      yaw: Math.round(wrapAngle(e.yaw) * 1000) / 1000,
      hp: Math.max(0, Math.round(e.hp)),
      mhp: e.maxHp,
      s: e.state,
      ss: Math.round(e.ss),
      at: e.attack?.id ?? '',
      r: e.rate,
      ph: e.phase,
      ld: r2(e.leapDist),
    }))
    const msg: ServerMsg = { t: 'snap', time: Math.round(now), p: ps, e: es, w: this.flags() }
    for (const p of this.players.values()) if (p.joined) p.send(msg)
  }
}
