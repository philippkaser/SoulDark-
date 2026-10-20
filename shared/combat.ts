import type { EnemyTypeId } from './level'

/** Root motion curve: [time (s), cumulative forward distance (m)]. */
export type MoveCurve = ReadonlyArray<readonly [number, number]>

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export const PLAYER = {
  radius: 0.38,
  height: 1.85,
  walkSpeed: 2.0,
  runSpeed: 4.4,
  sprintSpeed: 6.8,
  lockSpeed: 3.5,
  baseHp: 380,
  hpPerVigor: 28,
  baseStamina: 88,
  staminaPerEnd: 5,
  staminaRegen: 52,
  staminaDelay: 0.5,
  sprintCost: 15,
  maxFlasks: 5,
  flaskHeal: 0.46,
  bladeLength: 1.0,
} as const

export type PlayerActionName =
  | 'light1'
  | 'light2'
  | 'light3'
  | 'heavy'
  | 'sprintAttack'
  | 'riposte'
  | 'parry'
  | 'roll'
  | 'backstep'
  | 'estus'
  | 'hurt'
  | 'knockdown'
  | 'death'
  | 'rest'
  | 'fog'
  | 'praise'
  | 'bow'
  | 'wave'
  | 'point'
  | 'pickup'

export interface PlayerActionDef {
  dur: number
  /** Active hit frames for weapon attacks. */
  hit?: readonly [number, number]
  dmg?: number
  poise?: number
  stamina?: number
  /** Time window in which a buffered attack chains into `next`. */
  combo?: readonly [number, number]
  next?: PlayerActionName
  /** After this time a roll / other action can interrupt. */
  cancel?: number
  move?: MoveCurve
  /** Player can steer facing until this time. */
  steer?: number
  iframes?: readonly [number, number]
  /** Window in which an incoming parryable attack is deflected. */
  parry?: readonly [number, number]
  /** Hits taken in this window do not interrupt the action. */
  hyperArmor?: readonly [number, number]
  /** Movement speed multiplier while performing (estus walk). */
  walk?: number
  loop?: boolean
}

export const PLAYER_ACTIONS: Record<PlayerActionName, PlayerActionDef> = {
  light1: {
    dur: 0.72,
    hit: [0.22, 0.34],
    dmg: 44,
    poise: 14,
    stamina: 17,
    combo: [0.3, 0.72],
    next: 'light2',
    cancel: 0.44,
    steer: 0.16,
    move: [
      [0, 0],
      [0.18, 0.2],
      [0.32, 0.85],
      [0.72, 0.95],
    ],
  },
  light2: {
    dur: 0.72,
    hit: [0.2, 0.32],
    dmg: 46,
    poise: 14,
    stamina: 17,
    combo: [0.28, 0.72],
    next: 'light3',
    cancel: 0.44,
    steer: 0.15,
    move: [
      [0, 0],
      [0.16, 0.2],
      [0.3, 0.8],
      [0.72, 0.9],
    ],
  },
  light3: {
    dur: 0.98,
    hit: [0.36, 0.48],
    dmg: 66,
    poise: 30,
    stamina: 22,
    combo: [0.55, 0.98],
    next: 'light1',
    cancel: 0.64,
    steer: 0.3,
    move: [
      [0, 0],
      [0.3, 0.3],
      [0.46, 1.25],
      [0.98, 1.35],
    ],
  },
  heavy: {
    dur: 1.3,
    hit: [0.62, 0.74],
    dmg: 112,
    poise: 55,
    stamina: 32,
    cancel: 0.95,
    steer: 0.5,
    hyperArmor: [0.3, 0.74],
    move: [
      [0, 0],
      [0.5, 0.25],
      [0.7, 1.3],
      [1.3, 1.4],
    ],
  },
  sprintAttack: {
    dur: 0.9,
    hit: [0.2, 0.36],
    dmg: 62,
    poise: 26,
    stamina: 22,
    cancel: 0.62,
    steer: 0.1,
    move: [
      [0, 0],
      [0.24, 2.3],
      [0.5, 2.9],
      [0.9, 3.0],
    ],
  },
  riposte: {
    dur: 1.9,
    hit: [0.55, 0.62],
    dmg: 300,
    move: [
      [0, 0],
      [0.45, 0.5],
      [0.62, 0.7],
      [1.9, 0.7],
    ],
  },
  parry: { dur: 0.68, parry: [0.04, 0.26], stamina: 12, cancel: 0.55 },
  roll: {
    dur: 0.76,
    iframes: [0.04, 0.44],
    stamina: 20,
    cancel: 0.56,
    move: [
      [0, 0],
      [0.06, 0.4],
      [0.42, 4.1],
      [0.6, 4.6],
      [0.76, 4.7],
    ],
  },
  backstep: {
    dur: 0.52,
    iframes: [0.02, 0.24],
    stamina: 14,
    cancel: 0.38,
    move: [
      [0, 0],
      [0.28, -2.3],
      [0.52, -2.5],
    ],
  },
  estus: { dur: 1.55, walk: 0.35 },
  hurt: { dur: 0.42 },
  knockdown: {
    dur: 1.75,
    iframes: [0.45, 1.75],
    move: [
      [0, 0],
      [0.35, -1.4],
      [0.6, -1.6],
    ],
  },
  death: { dur: 6, loop: true },
  rest: { dur: 1.2, loop: true },
  fog: {
    dur: 1.9,
    move: [
      [0, 0],
      [1.9, 5.2],
    ],
  },
  praise: { dur: 2.6 },
  bow: { dur: 2.0 },
  wave: { dur: 2.0 },
  point: { dur: 1.6 },
  pickup: { dur: 1.0 },
}

/** Moment the estus heals, relative to action start. */
export const ESTUS_HEAL_AT = 0.85
export const RIPOSTE_RANGE = 2.6

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------

export interface EnemyHit {
  t0: number
  t1: number
  dmg: number
  /** Arc hit: reach from enemy center and half-angle. */
  range?: number
  arc?: number
  /** Area hit: circle centered `offset` metres in front of the enemy. */
  aoe?: boolean
  radius?: number
  offset?: number
  knockdown?: boolean
  /** Visual + audio cue (shockwave, explosion). */
  fx?: 'slam' | 'nova' | 'stomp' | 'roar'
}

export interface EnemyAttack {
  id: string
  dur: number
  hits: EnemyHit[]
  /** Turning speed (rad/s) while winding up, until `trackUntil`. */
  tracking: number
  trackUntil: number
  move: MoveCurve
  /** Root motion is scaled to land on the target (leap). */
  leap?: boolean
  minD: number
  maxD: number
  weight: number
  cooldown?: number
  parryable: boolean
  /** Only usable in this phase or later. */
  phase?: number
  /** Chance to immediately chain into this attack id. */
  chain?: { id: string; p: number }
}

export interface EnemyTypeDef {
  name: string
  hp: number
  poise: number
  radius: number
  height: number
  walk: number
  run: number
  turn: number
  aggro: number
  leash: number
  souls: number
  /** Any hit interrupts (weak enemies). */
  flinch: boolean
  stagger: number
  attacks: EnemyAttack[]
  /** Pause range between attacks [min, max]. */
  recover: readonly [number, number]
}

const hollowAttacks: EnemyAttack[] = [
  {
    id: 'h_slash',
    dur: 1.35,
    hits: [{ t0: 0.66, t1: 0.82, range: 2.1, arc: 1.1, dmg: 46 }],
    tracking: 4.5,
    trackUntil: 0.5,
    move: [
      [0, 0],
      [0.55, 0.15],
      [0.75, 0.9],
      [1.35, 1.0],
    ],
    minD: 0,
    maxD: 2.4,
    weight: 3,
    parryable: true,
    chain: { id: 'h_backhand', p: 0.35 },
  },
  {
    id: 'h_backhand',
    dur: 1.1,
    hits: [{ t0: 0.42, t1: 0.58, range: 2.1, arc: 1.2, dmg: 40 }],
    tracking: 4,
    trackUntil: 0.3,
    move: [
      [0, 0],
      [0.35, 0.1],
      [0.55, 0.7],
      [1.1, 0.75],
    ],
    minD: 0,
    maxD: 2.2,
    weight: 1,
    parryable: true,
  },
  {
    id: 'h_lunge',
    dur: 1.55,
    hits: [{ t0: 0.78, t1: 0.94, range: 2.0, arc: 0.6, dmg: 52 }],
    tracking: 3.2,
    trackUntil: 0.6,
    move: [
      [0, 0],
      [0.6, -0.2],
      [0.9, 3.1],
      [1.55, 3.3],
    ],
    minD: 3,
    maxD: 5.6,
    weight: 2,
    cooldown: 3,
    parryable: true,
  },
]

const knightAttacks: EnemyAttack[] = [
  {
    id: 'k_slash',
    dur: 1.15,
    hits: [{ t0: 0.5, t1: 0.64, range: 2.5, arc: 1.2, dmg: 62 }],
    tracking: 5,
    trackUntil: 0.38,
    move: [
      [0, 0],
      [0.4, 0.2],
      [0.6, 1.0],
      [1.15, 1.1],
    ],
    minD: 0,
    maxD: 2.8,
    weight: 3,
    parryable: true,
    chain: { id: 'k_rising', p: 0.45 },
  },
  {
    id: 'k_rising',
    dur: 1.2,
    hits: [{ t0: 0.44, t1: 0.6, range: 2.5, arc: 0.9, dmg: 58 }],
    tracking: 4,
    trackUntil: 0.3,
    move: [
      [0, 0],
      [0.38, 0.1],
      [0.56, 0.9],
      [1.2, 1.0],
    ],
    minD: 0,
    maxD: 2.6,
    weight: 1,
    parryable: true,
    chain: { id: 'k_overhead', p: 0.4 },
  },
  {
    id: 'k_overhead',
    dur: 1.5,
    hits: [{ t0: 0.78, t1: 0.92, range: 2.7, arc: 0.55, dmg: 88 }],
    tracking: 3.5,
    trackUntil: 0.62,
    move: [
      [0, 0],
      [0.7, 0.2],
      [0.88, 1.2],
      [1.5, 1.3],
    ],
    minD: 0,
    maxD: 2.9,
    weight: 2,
    parryable: true,
  },
  {
    id: 'k_thrust',
    dur: 1.45,
    hits: [{ t0: 0.72, t1: 0.88, range: 2.4, arc: 0.45, dmg: 70 }],
    tracking: 3,
    trackUntil: 0.6,
    move: [
      [0, 0],
      [0.6, -0.3],
      [0.85, 3.6],
      [1.45, 3.8],
    ],
    minD: 2.8,
    maxD: 6.5,
    weight: 2,
    cooldown: 4,
    parryable: true,
  },
  {
    id: 'k_bash',
    dur: 1.0,
    hits: [{ t0: 0.4, t1: 0.52, range: 1.9, arc: 1.0, dmg: 30, knockdown: true }],
    tracking: 6,
    trackUntil: 0.3,
    move: [
      [0, 0],
      [0.38, 0.1],
      [0.5, 0.9],
      [1.0, 1.0],
    ],
    minD: 0,
    maxD: 1.8,
    weight: 1,
    cooldown: 5,
    parryable: false,
  },
]

const bossAttacks: EnemyAttack[] = [
  {
    id: 'b_cleave',
    dur: 2.3,
    hits: [
      { t0: 1.08, t1: 1.22, range: 5.6, arc: 0.42, dmg: 165 },
      { t0: 1.14, t1: 1.2, aoe: true, offset: 4.4, radius: 2.4, dmg: 90, fx: 'slam' },
    ],
    tracking: 2.4,
    trackUntil: 0.9,
    move: [
      [0, 0],
      [0.9, 0.3],
      [1.12, 1.6],
      [2.3, 1.8],
    ],
    minD: 0,
    maxD: 5.6,
    weight: 3,
    parryable: false,
  },
  {
    id: 'b_sweep',
    dur: 1.95,
    hits: [{ t0: 0.86, t1: 1.06, range: 6.0, arc: 1.65, dmg: 130 }],
    tracking: 2.6,
    trackUntil: 0.7,
    move: [
      [0, 0],
      [0.8, 0.2],
      [1.0, 1.3],
      [1.95, 1.4],
    ],
    minD: 0,
    maxD: 5.6,
    weight: 3,
    parryable: false,
    chain: { id: 'b_cleave', p: 0.4 },
  },
  {
    id: 'b_thrust',
    dur: 2.05,
    hits: [{ t0: 0.94, t1: 1.16, range: 4.4, arc: 0.4, dmg: 150 }],
    tracking: 3.2,
    trackUntil: 0.82,
    move: [
      [0, 0],
      [0.78, -0.4],
      [1.1, 7.0],
      [2.05, 7.5],
    ],
    minD: 4,
    maxD: 11,
    weight: 2,
    cooldown: 5,
    parryable: false,
  },
  {
    id: 'b_leap',
    dur: 2.7,
    hits: [{ t0: 1.42, t1: 1.5, aoe: true, offset: 1.6, radius: 4.0, dmg: 175, knockdown: true, fx: 'slam' }],
    tracking: 4,
    trackUntil: 1.0,
    leap: true,
    move: [
      [0, 0],
      [0.55, 0],
      [1.42, 1],
      [2.7, 1],
    ],
    minD: 7.5,
    maxD: 22,
    weight: 2.5,
    cooldown: 7,
    parryable: false,
  },
  {
    id: 'b_stomp',
    dur: 1.35,
    hits: [{ t0: 0.56, t1: 0.62, aoe: true, offset: 0, radius: 3.3, dmg: 55, fx: 'stomp' }],
    tracking: 0,
    trackUntil: 0,
    move: [[0, 0]],
    minD: 0,
    maxD: 2.4,
    weight: 2,
    cooldown: 4,
    parryable: false,
  },
  {
    id: 'b_nova',
    dur: 3.1,
    hits: [{ t0: 1.66, t1: 1.74, aoe: true, offset: 0, radius: 7.6, dmg: 195, knockdown: true, fx: 'nova' }],
    tracking: 1.2,
    trackUntil: 1.0,
    move: [[0, 0]],
    minD: 0,
    maxD: 7,
    weight: 2,
    cooldown: 11,
    parryable: false,
    phase: 2,
  },
  {
    id: 'b_whirl',
    dur: 2.9,
    hits: [
      { t0: 0.8, t1: 0.98, range: 6.0, arc: 1.7, dmg: 120 },
      { t0: 1.5, t1: 1.68, range: 6.0, arc: 1.7, dmg: 120 },
      { t0: 2.08, t1: 2.2, aoe: true, offset: 3.6, radius: 2.8, dmg: 150, fx: 'slam' },
    ],
    tracking: 2.8,
    trackUntil: 1.9,
    move: [
      [0, 0],
      [0.75, 0.4],
      [1.0, 1.6],
      [1.6, 2.8],
      [2.1, 3.6],
      [2.9, 3.7],
    ],
    minD: 0,
    maxD: 6,
    weight: 2.5,
    cooldown: 6,
    parryable: false,
    phase: 2,
  },
]

/** Phase transition roar. */
export const BOSS_ROAR: EnemyAttack = {
  id: 'b_roar',
  dur: 2.8,
  hits: [{ t0: 1.05, t1: 1.12, aoe: true, offset: 0, radius: 5.5, dmg: 40, knockdown: true, fx: 'roar' }],
  tracking: 0,
  trackUntil: 0,
  move: [[0, 0]],
  minD: 0,
  maxD: 0,
  weight: 0,
  parryable: false,
}

export const ENEMY_TYPES: Record<EnemyTypeId, EnemyTypeDef> = {
  hollow: {
    name: 'Hollow Soldier',
    hp: 140,
    poise: 1,
    radius: 0.42,
    height: 1.75,
    walk: 1.5,
    run: 3.9,
    turn: 6,
    aggro: 12,
    leash: 24,
    souls: 90,
    flinch: true,
    stagger: 0.5,
    attacks: hollowAttacks,
    recover: [0.6, 1.6],
  },
  knight: {
    name: 'Fallen Knight',
    hp: 460,
    poise: 75,
    radius: 0.5,
    height: 2.0,
    walk: 1.7,
    run: 4.1,
    turn: 5,
    aggro: 14,
    leash: 22,
    souls: 700,
    flinch: false,
    stagger: 1.25,
    attacks: knightAttacks,
    recover: [0.35, 1.0],
  },
  boss: {
    name: 'Malgrave, the Ashen Warden',
    hp: 2800,
    poise: 260,
    radius: 1.3,
    height: 4.6,
    walk: 2.5,
    run: 4.2,
    turn: 2.8,
    aggro: 80,
    leash: 999,
    souls: 15000,
    flinch: false,
    stagger: 2.6,
    attacks: bossAttacks,
    recover: [0.4, 1.1],
  },
}

export const ALL_ENEMY_ATTACKS: Record<string, EnemyAttack> = {}
for (const t of Object.values(ENEMY_TYPES)) for (const a of t.attacks) ALL_ENEMY_ATTACKS[a.id] = a
ALL_ENEMY_ATTACKS[BOSS_ROAR.id] = BOSS_ROAR

/** Timed enemy states and their durations (seconds). */
export const ENEMY_STATE_DUR = {
  wake: 1.3,
  hurt: 0.5,
  parried: 2.3,
  riposted: 2.4,
  intro: 3.4,
  deathFall: 1.6,
} as const

/** Riposte damage multiplier on staggered bosses (posture break). */
export const BOSS_CRIT_MULT = 0.6

// ---------------------------------------------------------------------------
// Leveling
// ---------------------------------------------------------------------------

export interface Stats {
  vigor: number
  endurance: number
  strength: number
}

export const BASE_STATS: Stats = { vigor: 10, endurance: 10, strength: 10 }

export const statsLevel = (s: Stats) => s.vigor + s.endurance + s.strength - 29
export const levelCost = (level: number) => Math.round(220 + 40 * level + 6 * level * level)
export const maxHpFor = (s: Stats) => PLAYER.baseHp + (s.vigor - 10) * PLAYER.hpPerVigor
export const maxStaminaFor = (s: Stats) => PLAYER.baseStamina + (s.endurance - 10) * PLAYER.staminaPerEnd
export const damageMultFor = (s: Stats) => 1 + (s.strength - 10) * 0.045
