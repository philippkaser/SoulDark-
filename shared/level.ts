import { mulberry32, TAU, wrapAngle } from './math'

/**
 * The world of SoulDark: a ruined shrine with a bonfire, a road to a graveyard,
 * a colonnade leading to a fog gate, and the Warden's circular arena.
 *
 * +Z points south (toward the shrine), -Z points north (toward the boss).
 * Everything here is shared by the client (rendering + local collision) and the
 * server (enemy simulation), so it must stay deterministic.
 */

export type Zone =
  | { kind: 'circle'; x: number; z: number; r: number; floor: FloorKind }
  | { kind: 'rect'; x0: number; z0: number; x1: number; z1: number; floor: FloorKind }

export type FloorKind = 'shrine' | 'road' | 'grave' | 'colonnade' | 'gate' | 'arena'

export const SHRINE = { x: 0, z: 44, r: 13 }
export const GRAVEYARD = { x: 0, z: 2, r: 15 }
export const ARENA = { x: 0, z: -58, r: 26 }
export const BONFIRE = { x: 0, z: 44 }
export const FOG_GATE = { x: 0, z: -29, halfWidth: 3.2 }
export const PLAYER_SPAWN = { x: 0, z: 40.5, yaw: Math.PI }

export const ZONES: Zone[] = [
  { kind: 'circle', ...SHRINE, floor: 'shrine' },
  { kind: 'rect', x0: -8, z0: 14, x1: 8, z1: 36, floor: 'road' },
  { kind: 'circle', ...GRAVEYARD, floor: 'grave' },
  { kind: 'rect', x0: -6.5, z0: -25, x1: 6.5, z1: -9, floor: 'colonnade' },
  { kind: 'rect', x0: -3.2, z0: -35, x1: 3.2, z1: -23, floor: 'gate' },
  { kind: 'circle', ...ARENA, floor: 'arena' },
]

export interface CircleObstacle {
  x: number
  z: number
  r: number
  /** Tall obstacles block the camera too. */
  tall: boolean
  kind: 'pillar' | 'brokenPillar' | 'grave' | 'tree' | 'bonfire' | 'brazier' | 'stub'
  /** Visual variation seed. */
  v: number
  h?: number
  rot?: number
}

export interface BoxObstacle {
  x: number
  z: number
  hw: number
  hd: number
  rot: number
  tall: boolean
  kind: 'statue' | 'fog' | 'altar' | 'sarcophagus'
}

export const CIRCLES: CircleObstacle[] = []
export const BOXES: BoxObstacle[] = []

const rand = mulberry32(1337)

// --- Shrine: ring of pillars, some shattered, around the bonfire.
CIRCLES.push({ x: BONFIRE.x, z: BONFIRE.z, r: 0.7, tall: false, kind: 'bonfire', v: 0 })
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * TAU + 0.13
  if (Math.abs(wrapAngle(a - Math.PI)) < 0.5) continue // opening toward the road
  const broken = i % 3 === 1
  CIRCLES.push({
    x: Math.sin(a) * 11,
    z: SHRINE.z + Math.cos(a) * 11,
    r: 0.8,
    tall: !broken,
    kind: broken ? 'brokenPillar' : 'pillar',
    v: rand(),
    h: broken ? 2 + rand() * 3 : 9 + rand() * 1.5,
  })
}

// --- Road: braziers flanking the way.
for (const z of [18, 29]) {
  for (const x of [-6.6, 6.6]) CIRCLES.push({ x, z, r: 0.45, tall: false, kind: 'brazier', v: rand() })
}

// --- Graveyard: a statue of the old Warden, dead trees and many graves.
BOXES.push({ x: GRAVEYARD.x, z: GRAVEYARD.z, hw: 1.4, hd: 1.4, rot: 0.2, tall: true, kind: 'statue' })
const trees: Array<[number, number]> = [
  [-10.5, 8],
  [9.5, -5.5],
  [11, 9],
  [-9, -8],
]
for (const [x, z] of trees) CIRCLES.push({ x, z, r: 0.45, tall: true, kind: 'tree', v: rand() })
{
  let placed = 0
  let attempts = 0
  while (placed < 30 && attempts < 2000) {
    attempts++
    const a = rand() * TAU
    const d = 4.2 + Math.sqrt(rand()) * 9.8
    const x = GRAVEYARD.x + Math.sin(a) * d
    const z = GRAVEYARD.z + Math.cos(a) * d
    if (Math.abs(x) < 2.6) continue // keep the north-south path clear
    let ok = true
    for (const c of CIRCLES) {
      const dx = c.x - x
      const dz = c.z - z
      if (dx * dx + dz * dz < (c.r + 1.7) ** 2) {
        ok = false
        break
      }
    }
    if (!ok) continue
    CIRCLES.push({ x, z, r: 0.42, tall: false, kind: 'grave', v: rand(), rot: (rand() - 0.5) * 0.6 })
    placed++
  }
}

// --- Colonnade: two rows of pillars leading to the fog gate.
for (const z of [-11, -16.5, -22]) {
  for (const x of [-5.4, 5.4]) {
    const broken = (z === -16.5 && x > 0) || (z === -22 && x < 0)
    CIRCLES.push({
      x,
      z,
      r: 0.75,
      tall: !broken,
      kind: broken ? 'brokenPillar' : 'pillar',
      v: rand(),
      h: broken ? 3 + rand() * 2 : 11,
    })
  }
}

// --- Fog gate (collider is toggled by world state).
BOXES.push({ x: FOG_GATE.x, z: FOG_GATE.z, hw: FOG_GATE.halfWidth + 0.5, hd: 0.25, rot: 0, tall: false, kind: 'fog' })

// --- Arena: towering pillars around the rim.
for (let i = 0; i < 14; i++) {
  const a = (i / 14) * TAU
  if (Math.abs(wrapAngle(a)) < 0.3) continue // the gate side
  const broken = i % 4 === 2
  CIRCLES.push({
    x: ARENA.x + Math.sin(a) * 23,
    z: ARENA.z + Math.cos(a) * 23,
    r: 1.15,
    tall: !broken,
    kind: broken ? 'brokenPillar' : 'pillar',
    v: rand(),
    h: broken ? 3 + rand() * 4 : 16 + rand() * 4,
  })
}
for (let i = 0; i < 5; i++) {
  const a = rand() * TAU
  const d = 12 + rand() * 7
  CIRCLES.push({
    x: ARENA.x + Math.sin(a) * d,
    z: ARENA.z + Math.cos(a) * d,
    r: 0.7,
    tall: false,
    kind: 'stub',
    v: rand(),
    h: 0.6 + rand() * 0.8,
  })
}

// --- Enemies
export type EnemyTypeId = 'hollow' | 'knight' | 'boss'
export interface EnemySpawn {
  type: EnemyTypeId
  x: number
  z: number
  yaw: number
}

export const ENEMY_SPAWNS: EnemySpawn[] = [
  { type: 'hollow', x: 3.5, z: 24, yaw: 0.4 },
  { type: 'hollow', x: -7, z: 7, yaw: 2.2 },
  { type: 'hollow', x: 6.5, z: 4, yaw: -0.8 },
  { type: 'hollow', x: -4, z: -5.5, yaw: 0.2 },
  { type: 'hollow', x: 8, z: -7.5, yaw: -2.8 },
  { type: 'hollow', x: -3, z: -14, yaw: 0 },
  { type: 'hollow', x: 3.5, z: -19, yaw: 0.3 },
  { type: 'knight', x: 0, z: -21.5, yaw: 0 },
  { type: 'boss', x: ARENA.x, z: ARENA.z - 10, yaw: 0 },
]

export const BOSS_HOME = ENEMY_SPAWNS.find((s) => s.type === 'boss')!

/** True if (x,z) lies in the arena beyond the fog gate. */
export function inArena(x: number, z: number) {
  const dx = x - ARENA.x
  const dz = z - ARENA.z
  return dx * dx + dz * dz < (ARENA.r - 0.3) ** 2 && z < FOG_GATE.z - 1.2
}
