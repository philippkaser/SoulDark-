import type * as THREE from 'three'
import type { Shape } from '../engine/geom'

/** How big a threat is: drives parry spectacle, slow motion and damage. */
export type Tier = 'small' | 'medium' | 'large' | 'cosmic'

export type HitKind =
  | 'slash' // melee swing
  | 'air' // flying crescent
  | 'heaven' // the charged Heaven Splitter
  | 'dash' // flash-step through
  | 'slam' // meteor dive / superhero landing
  | 'blast' // explosions
  | 'beam' // orbital laser (caught or otherwise)
  | 'reflect' // the enemy's own weapon, returned
  | 'judgment' // the ultimate
  | 'parry' // knocked back by a parry

export interface Hit {
  /** Unique per attack instance so persistent volumes don't hit twice. */
  id: number
  kind: HitKind
  dmg: number
  /** Knockback speed (m/s). */
  power: number
  /** Where the force comes from (things are thrown away from it). */
  origin: THREE.Vector3
  /** Optional push direction overriding "away from origin". */
  dir?: THREE.Vector3
  /** Slicing plane in world space: a killing blow cuts along it. */
  plane?: THREE.Plane
  /** Dealt by the player's side. */
  friendly: boolean
}

/** A system that owns damageable things. */
export interface Damageable {
  /** Apply the hit to everything the shape touches. Returns how many things were hit. */
  damage(shape: Shape, hit: Hit): number
}

/** Something a reflected projectile can be sent home to. */
export interface ReflectTarget {
  readonly alive: boolean
  /** Point to aim at. */
  aim(out: THREE.Vector3): THREE.Vector3
  /** Collision radius around the aim point. */
  readonly radius: number
  /** Struck by its own (or someone else's) returned weapon. */
  struck(dmg: number, at: THREE.Vector3, kind: string): void
}

export type ParryResult = 'perfect' | 'guard' | 'none'

let nextHitId = 1
export const newHitId = () => nextHitId++
