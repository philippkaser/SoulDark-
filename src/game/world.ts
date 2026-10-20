import * as THREE from 'three'
import { ENEMY_TYPES, type EnemyTypeDef } from '../../shared/combat'
import type { EnemyTypeId } from '../../shared/level'
import { lerp, wrapAngle } from '../../shared/math'
import type {
  Bloodstain,
  EnemyStateName,
  GroundMessage,
  Look,
  PlayerSnap,
  WorldFlags,
} from '../../shared/protocol'

/** Render remote entities this far in the past so we always have two snapshots to blend. */
export const INTERP_DELAY = 110

// ---------------------------------------------------------------------------
// Effects bus
// ---------------------------------------------------------------------------

export type FxEvent =
  | { kind: 'spark'; p: THREE.Vector3; dir?: THREE.Vector3; count?: number; big?: boolean }
  | { kind: 'blood'; p: THREE.Vector3; dir?: THREE.Vector3; count?: number }
  | { kind: 'dust'; p: THREE.Vector3; count?: number; spread?: number }
  | { kind: 'shockwave'; p: THREE.Vector3; radius: number; color?: string; fire?: boolean }
  | { kind: 'souls'; from: THREE.Vector3; count: number }
  | { kind: 'heal'; p: THREE.Vector3 }
  | { kind: 'ash'; p: THREE.Vector3; count: number; spread: number; height: number }
  | { kind: 'parry'; p: THREE.Vector3 }
  | { kind: 'embers'; p: THREE.Vector3; count: number; spread: number }

// ---------------------------------------------------------------------------
// Remote players
// ---------------------------------------------------------------------------

interface RemoteSample {
  t: number
  x: number
  y: number
  z: number
  yaw: number
  vx: number
  vz: number
  a: string
  as: number
  hp: number
  sp: boolean
}

export class RemotePlayerView {
  id: string
  name: string
  look: Look
  buf: RemoteSample[] = []
  hp = 1
  mhp = 1
  lk = -1
  // rendered state
  x = 0
  y = 0
  z = 0
  yaw = 0
  speed = 0
  sprint = false
  action = ''
  actionStart = 0
  ready = false

  constructor(id: string, name: string, look: Look) {
    this.id = id
    this.name = name
    this.look = look
  }

  push(t: number, s: PlayerSnap) {
    const last = this.buf[this.buf.length - 1]
    if (last && t <= last.t) return
    this.buf.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, vx: s.vx, vz: s.vz, a: s.a, as: s.as, hp: s.hp, sp: s.sp })
    if (this.buf.length > 40) this.buf.shift()
    this.hp = s.hp
    this.mhp = s.mhp
    this.lk = s.lk
  }

  sample(t: number) {
    const b = this.buf
    if (!b.length) return
    this.ready = true
    let i = b.length - 1
    while (i > 0 && b[i].t > t) i--
    const a = b[i]
    const n = b[Math.min(i + 1, b.length - 1)]
    const k = n.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (n.t - a.t))) : 0
    this.x = lerp(a.x, n.x, k)
    this.y = lerp(a.y, n.y, k)
    this.z = lerp(a.z, n.z, k)
    this.yaw = wrapAngle(a.yaw + wrapAngle(n.yaw - a.yaw) * k)
    this.speed = Math.hypot(lerp(a.vx, n.vx, k), lerp(a.vz, n.vz, k))
    this.sprint = a.sp
    const src = k > 0.5 ? n : a
    this.action = src.a
    this.actionStart = src.as
  }
}

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------

interface EnemySample {
  t: number
  x: number
  z: number
  yaw: number
  s: EnemyStateName
  ss: number
  at: string
  r: number
  ph: number
  ld: number
}

export class EnemyView {
  id: number
  type: EnemyTypeId
  def: EnemyTypeDef
  buf: EnemySample[] = []
  hp: number
  mhp: number
  // rendered
  x = 0
  z = 0
  yaw = 0
  state: EnemyStateName = 'idle'
  ss = 0
  at = ''
  rate = 1
  phase = 1
  leap = 0
  /** Seconds into the current state at render time (rate applied). */
  animT = 0
  speed = 0
  /** Velocity direction relative to facing (for strafing legs). */
  moveAngle = 0
  // local feedback
  flash = 0
  freezeUntil = 0
  frozenT = 0
  dmgAccum = 0
  dmgAt = 0
  /** Attack instances that already hurt the local player: `${ss}:${hitIndex}`. */
  hitKeys = new Set<string>()
  /** Local time when the enemy was last seen alive (for death dissolve). */
  deathSeenAt = 0
  prevX = 0
  prevZ = 0

  constructor(id: number, type: EnemyTypeId) {
    this.id = id
    this.type = type
    this.def = ENEMY_TYPES[type]
    this.hp = this.def.hp
    this.mhp = this.def.hp
  }

  get alive() {
    return this.state !== 'dead' && this.state !== 'dormant'
  }

  get targetable() {
    return this.state !== 'dead' && this.hp > 0
  }

  push(t: number, s: EnemySample, hp: number, mhp: number) {
    const last = this.buf[this.buf.length - 1]
    if (last && t <= last.t) return
    this.buf.push(s)
    if (this.buf.length > 40) this.buf.shift()
    this.hp = hp
    this.mhp = mhp
  }

  sample(t: number, now: number, dt: number) {
    const b = this.buf
    if (!b.length) return
    let i = b.length - 1
    while (i > 0 && b[i].t > t) i--
    const a = b[i]
    const n = b[Math.min(i + 1, b.length - 1)]
    const k = n.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (n.t - a.t))) : 0
    this.prevX = this.x
    this.prevZ = this.z
    this.x = lerp(a.x, n.x, k)
    this.z = lerp(a.z, n.z, k)
    this.yaw = wrapAngle(a.yaw + wrapAngle(n.yaw - a.yaw) * k)
    // discrete state switches exactly at its server start time
    const src = n.ss <= t && n !== a ? n : a
    if (src.s !== this.state || src.ss !== this.ss) {
      if (src.s === 'dead' && this.state !== 'dead') this.deathSeenAt = now
      if (src.ss !== this.ss) this.hitKeys.clear()
    }
    this.state = src.s
    this.ss = src.ss
    this.at = src.at
    this.rate = src.r
    this.phase = src.ph
    this.leap = src.ld
    const rawT = Math.max(0, ((t - this.ss) / 1000) * this.rate)
    if (now < this.freezeUntil) {
      this.animT = this.frozenT
    } else {
      this.animT = rawT
      this.frozenT = rawT
    }
    if (dt > 0) {
      const vx = (this.x - this.prevX) / dt
      const vz = (this.z - this.prevZ) / dt
      const sp = Math.hypot(vx, vz)
      this.speed = lerp(this.speed, sp > 20 ? 0 : sp, 1 - Math.exp(-12 * dt))
      if (sp > 0.05) this.moveAngle = wrapAngle(Math.atan2(vx, vz) - this.yaw)
    }
    this.flash = Math.max(0, this.flash - dt * 5)
  }
}

// ---------------------------------------------------------------------------
// World singleton
// ---------------------------------------------------------------------------

export interface LocalPlayerState {
  x: number
  y: number
  z: number
  yaw: number
}

export const world = {
  localId: '',
  remotes: new Map<string, RemotePlayerView>(),
  enemies: new Map<number, EnemyView>(),
  messages: [] as GroundMessage[],
  stains: [] as Bloodstain[],
  flags: { fog: true, boss: 0 } as WorldFlags,
  fx: [] as FxEvent[],
  /** Seconds of camera trauma (decays). */
  shake: 0,
  /** Local-time ms until which the local player is frozen (hitstop). */
  hitstopUntil: 0,
  /** Global red flash on taking damage, 0..1 */
  hurtFlash: 0,
  /** Brightening flash for parries, 0..1 */
  parryFlash: 0,
  cameraYaw: Math.PI,
  cameraPitch: 0.2,
  camera: null as THREE.PerspectiveCamera | null,
  /** Local player position (updated by the controller each frame). */
  me: { x: 0, y: 0, z: 0, yaw: 0 } as LocalPlayerState,
  bossMusic: false,
  inGame: false,
}

export function emitFx(e: FxEvent) {
  world.fx.push(e)
  if (world.fx.length > 200) world.fx.shift()
}

export function addShake(amount: number) {
  world.shake = Math.min(1.2, world.shake + amount)
}

export function resetWorld() {
  world.remotes.clear()
  world.enemies.clear()
  world.messages = []
  world.stains = []
  world.fx = []
  world.flags = { fog: true, boss: 0 }
}
