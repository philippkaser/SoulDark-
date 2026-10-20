import * as THREE from 'three'
import { mulberry32, TAU } from '../../engine/math'

/** Soft edge of the battlefield: the player is eased back beyond this. */
export const ARENA_R = 150
export const ARENA_HARD = 175

/** The Dominion citadel on the northern horizon. */
export const CITADEL = { x: 0, z: -760 }

/** Direction toward the eclipse (north, above the citadel). */
export const SUN_DIR = new THREE.Vector3(0.06, 0.3, -1).normalize()
/** How far away the Eclipse "is" for gameplay (projectile origins). */
export const ECLIPSE_DIST = 900

export const FOG_COLOR = new THREE.Color('#2a1420')

export function eclipsePoint(out: THREE.Vector3) {
  return out.copy(SUN_DIR).multiplyScalar(ECLIPSE_DIST)
}

/** Artillery emplacements on the northern ridge. */
export function ridgeSlots(n: number) {
  const out: Array<{ x: number; z: number; yaw: number }> = []
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n - 0.5) * 1.6
    const r = 205 + (i % 2) * 22
    const x = Math.sin(a) * r
    const z = -Math.cos(a) * r
    out.push({ x, z, yaw: Math.atan2(-x, -z) })
  }
  return out
}

export interface SpireDef {
  x: number
  z: number
  r: number
  h: number
  seed: number
}

/** Rock spires scattered over the plain (seeded so every run looks the same). */
export function spireDefs(): SpireDef[] {
  const r = mulberry32(1337)
  const out: SpireDef[] = []
  let guard = 0
  while (out.length < 22 && guard++ < 500) {
    const a = r() * TAU
    const d = 34 + Math.pow(r(), 0.8) * 120
    const x = Math.sin(a) * d
    const z = Math.cos(a) * d
    if (out.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + 18)) continue
    const big = r() < 0.25
    out.push({ x, z, r: big ? 4 + r() * 3 : 1.8 + r() * 2.2, h: big ? 26 + r() * 22 : 9 + r() * 14, seed: Math.floor(r() * 1e6) })
  }
  return out
}
