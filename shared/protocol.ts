import type { EnemyTypeId } from './level'

export interface Look {
  /** Tabard / cape color index into CLOAK_COLORS. */
  cloak: number
  /** Helm crest variant. */
  crest: number
}

export const CLOAK_COLORS = ['#7a1a1a', '#1f3b6e', '#2d4a2a', '#4a4a4a', '#6b4e1a', '#3d1f4a'] as const
export const CLOAK_NAMES = ['Crimson', 'Azure', 'Moss', 'Ash', 'Amber', 'Violet'] as const

export type EnemyStateName =
  | 'dormant'
  | 'idle'
  | 'wake'
  | 'chase'
  | 'strafe'
  | 'attack'
  | 'recover'
  | 'hurt'
  | 'stagger'
  | 'parried'
  | 'riposted'
  | 'dead'
  | 'return'
  | 'intro'

export interface PlayerSnap {
  id: string
  x: number
  y: number
  z: number
  yaw: number
  vx: number
  vz: number
  hp: number
  mhp: number
  /** Current action name ('' for locomotion). */
  a: string
  /** Action start in server time (ms). */
  as: number
  /** Locked-on enemy id or -1. */
  lk: number
  sp: boolean
}

export interface PlayerInfo {
  id: string
  name: string
  look: Look
}

export interface EnemySnap {
  id: number
  ty: EnemyTypeId
  x: number
  z: number
  yaw: number
  hp: number
  mhp: number
  s: EnemyStateName
  /** State start in server time (ms). */
  ss: number
  /** Attack id when attacking. */
  at: string
  /** Animation rate. */
  r: number
  ph: number
  /** Leap distance for scaled root motion. */
  ld: number
}

export interface WorldFlags {
  fog: boolean
  /** 0 dormant, 1 fighting, 2 defeated */
  boss: 0 | 1 | 2
}

export interface GroundMessage {
  id: number
  x: number
  z: number
  text: string
  author: string
  rating: number
}

export interface TrailSample {
  x: number
  z: number
  yaw: number
  a: string
  /** Seconds since the start of the trail. */
  t: number
}

export interface Bloodstain {
  id: number
  x: number
  z: number
  name: string
  trail: TrailSample[]
}

export type ClientMsg =
  | { t: 'join'; name: string; look: Look }
  | ({ t: 'st' } & Omit<PlayerSnap, 'id'>)
  | { t: 'hit'; id: number; dmg: number; poise: number; atk: string }
  | { t: 'parry'; id: number }
  | { t: 'riposte'; id: number; dmg: number }
  | { t: 'died'; x: number; z: number; trail: TrailSample[] }
  | { t: 'rest' }
  | { t: 'msg'; x: number; z: number; text: string }
  | { t: 'rate'; id: number }
  | { t: 'chat'; text: string }
  | { t: 'ping'; c: number }

export type ServerMsg =
  | {
      t: 'welcome'
      id: string
      time: number
      room: string
      players: PlayerInfo[]
      messages: GroundMessage[]
      stains: Bloodstain[]
      w: WorldFlags
    }
  | { t: 'snap'; time: number; p: PlayerSnap[]; e: EnemySnap[]; w: WorldFlags }
  | { t: 'join'; p: PlayerInfo }
  | { t: 'leave'; id: string }
  | { t: 'kill'; id: number; souls: number; by: string[]; ty: EnemyTypeId }
  | { t: 'msgs'; add?: GroundMessage[]; upd?: { id: number; rating: number }; author?: string }
  | { t: 'stain'; s: Bloodstain }
  | { t: 'chat'; id: string; name: string; text: string }
  | { t: 'pong'; c: number; s: number }
  | { t: 'boss'; ev: 'start' | 'phase' | 'defeated' | 'reset' }
  | { t: 'sys'; text: string }

// ---------------------------------------------------------------------------
// Ground messages are composed from templates and words (no free text).
// ---------------------------------------------------------------------------

export const MESSAGE_TEMPLATES = [
  '**** ahead',
  'No **** ahead',
  '**** required ahead',
  'Be wary of ****',
  'Try ****',
  'Could this be a ****?',
  'If only I had a ****...',
  'Visions of ****...',
  'Time for ****',
  '****',
  '****!',
  '****?',
  'Huh. It\'s a ****...',
  'Praise the ****!',
  'Let there be ****',
  'Ahh, ****...',
] as const

export const MESSAGE_WORDS = {
  Creatures: ['enemy', 'monster', 'hollow', 'knight', 'boss', 'phantom', 'warden', 'ally', 'coward', 'liar'],
  Things: ['bonfire', 'fog wall', 'item', 'shield', 'sword', 'treasure', 'souls', 'estus', 'statue', 'grave'],
  Tactics: ['rolling', 'parrying', 'patience', 'attacking', 'running', 'retreat', 'riposte', 'courage', 'jumping', 'praying'],
  Concepts: ['hope', 'despair', 'victory', 'defeat', 'fire', 'dark', 'light', 'Sun', 'eclipse', 'ash'],
  Directions: ['left', 'right', 'ahead', 'behind', 'up', 'down', 'a hole', 'a trap', 'an ambush', 'a shortcut'],
  Feelings: ['joy', 'sorrow', 'rage', 'fear', 'gratitude', 'regret', 'good', 'bad', 'beautiful', 'tears'],
} as const

const VALID_MESSAGES = new Set<string>()
for (const tpl of MESSAGE_TEMPLATES) {
  for (const words of Object.values(MESSAGE_WORDS)) {
    for (const w of words) VALID_MESSAGES.add(tpl.replace('****', w))
  }
}
export const isValidMessage = (text: string) => VALID_MESSAGES.has(text)

export const sanitizeName = (name: unknown) => {
  const s = typeof name === 'string' ? name : ''
  const clean = s.replace(/[^\p{L}\p{N} _\-'.]/gu, '').trim().slice(0, 18)
  return clean || 'Unkindled'
}

export const sanitizeChat = (text: unknown) => {
  const s = typeof text === 'string' ? text : ''
  return s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 140)
}
