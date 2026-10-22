import * as THREE from 'three'
import type { Game } from '../Game'

const ARCS = 4
const UP = new THREE.Vector3(0, 1, 0)
const DOWN = new THREE.Vector3(0, -1, 0)
const _tip = new THREE.Vector3()
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()

/** How hard the hero simmers at rest: full Divinity, or a style rank of S (4) and up. */
export function idlePower(divinity: number, rank: number) {
  const r = rank >= 4 ? 0.1 + (rank - 4) * 0.04 : 0
  return Math.max(divinity >= 100 ? 0.2 : 0, r)
}

/**
 * The hero's visible power, choreographed: the aura, the rocks and cracks and
 * the lightning that answer the Heaven Splitter's charge and release,
 * Judgment and the biggest parries. Runs on the hero's clock; Player calls
 * one method per moment.
 */
export class HeroPower {
  private g: Game
  /** Sustained arcs from the sword tip to the ground, and where each one lands. */
  private arcs = new Int32Array(ARCS).fill(-1)
  private arcEnd: THREE.Vector3[] = []
  private boltT = 0
  private chargeK = -1
  private full = false

  constructor(game: Game) {
    this.g = game
    for (let i = 0; i < ARCS; i++) this.arcEnd.push(new THREE.Vector3())
  }

  reset() {
    this.chargeK = -1
    this.full = false
    this.arcs.fill(-1)
  }

  /** Every frame of the Heaven Splitter charge (k 0..1). */
  charge(k: number, dt: number) {
    const g = this.g
    const p = g.player
    if (this.chargeK < 0) this.full = false
    this.chargeK = k
    g.aura.setPower(0.22 + k * 0.78)
    // the power only tears up the ground it is near
    if (p.altitude < 8) g.levitate.setPower(k, p.pos, dt)
    if (k >= 1 && !this.full) {
      this.full = true
      g.aura.flare(0.2)
      if (p.altitude < 2) {
        // the ground gives under the feet
        g.terrain.crater(p.pos.x, p.pos.z, 4.5, 0.35, { rim: 0.6, ejecta: 0.35 })
        if (p.grounded) p.pos.y = g.terrain.heightAt(p.pos.x, p.pos.z)
      }
      p.model.swordTip.getWorldPosition(_tip)
      g.lightning.fan(_tip, DOWN, 3, 9, 1.1, { width: 0.2, forks: 4, sparks: false })
    }
  }

  /** The Heaven Splitter is released along a → b (a at the hero, on the ground). */
  release(a: THREE.Vector3, b: THREE.Vector3, fwd: THREE.Vector3, k: number) {
    const g = this.g
    this.endCharge()
    g.levitate.release(fwd, 0.6 + k * 0.7)
    // the cut is bright enough already: the aura only blazes (briefly: the hero must stay a silhouette against the cut), no burst of sparks
    g.aura.flare(0.18 + k * 0.17, undefined, false)
    // lightning races down the cut, just behind the wave of light
    const reach = Math.min(a.distanceTo(b), 50 + k * 150)
    _v.copy(a).addScaledVector(fwd, reach)
    g.lightning.crawl(a, _v, 380, { hop: 7 + k * 6, height: 0.4 + k * 1.2, width: 0.18 + k * 0.3, forks: 3 + Math.round(k * 3), intensity: 0.7 + k * 0.2, life: 0.3 + k * 0.2 })
    if (k > 0.7) {
      // the sky answers: bolts slam into the line as it tears open
      for (let i = 0; i < 4; i++) {
        const t = 0.15 + Math.random() * 0.8
        _w.copy(a).addScaledVector(fwd, reach * t)
        _w.y = g.terrain.heightAt(_w.x, _w.z)
        _v.set(_w.x + (Math.random() - 0.5) * 30, _w.y + 60 + Math.random() * 30, _w.z + (Math.random() - 0.5) * 30)
        g.lightning.bolt(_v, _w, { delay: (reach * t) / 380 + 0.05, grow: 0.05, width: 1.2, forks: 6 })
      }
    }
  }

  /** Judgment begins: the aura flares and a storm breaks around the hero while time stands still. */
  judgment() {
    const g = this.g
    this.endCharge()
    g.aura.flare(1.2, '#d8e6ff', false)
    g.lightning.storm(g.player.pos, 10, 24, 0.45, { color: 'white', width: 0.6, sparks: false })
    g.player.chestPos(_v)
    g.lightning.fan(_v, UP, 5, 5, 1.4, { color: 'white', width: 0.12, light: false, sparks: false })
  }

  /** A perfect parry of tier >= 2: forks are thrown out of the impact. */
  parry(p: THREE.Vector3, toward: THREE.Vector3, tier: number) {
    const g = this.g
    if (tier < 2) return
    // long-lived and long enough to reach out of the parry's own white-hot burst
    g.lightning.fan(p, toward, tier >= 3 ? 8 : 5, 12 + tier * 6, 1.25, { width: 0.18 + tier * 0.05, forks: 4, life: 0.6, intensity: 0.85, light: tier >= 3, sparks: false })
    g.aura.flare(0.25 + tier * 0.12)
  }

  private endCharge() {
    this.chargeK = -1
    for (let i = 0; i < ARCS; i++) {
      this.g.lightning.kill(this.arcs[i])
      this.arcs[i] = -1
    }
  }

  /** Every hero frame, after the pose: the idle simmer and the charge's arcs to the ground. */
  update(dt: number) {
    const g = this.g
    const p = g.player
    g.aura.idle = p.alive ? idlePower(p.divinity, g.score.rank) : 0
    if (p.state !== 'charge') {
      if (this.chargeK >= 0) this.endCharge()
      return
    }
    const k = this.chargeK
    if (k <= 0.5 || p.altitude > 9) return
    p.model.swordTip.getWorldPosition(_tip)
    const L = g.lightning
    const live = Math.ceil(((k - 0.5) / 0.5) * ARCS)
    for (let i = 0; i < ARCS; i++) {
      const e = this.arcEnd[i]
      if (L.move(this.arcs[i], _tip, e)) continue
      if (i >= live || Math.random() > dt * 14) continue
      // a fresh arc grounds somewhere around the feet
      const a = Math.random() * Math.PI * 2
      const r = 1.8 + Math.random() * (2 + k * 3)
      e.set(p.pos.x + Math.sin(a) * r, 0, p.pos.z + Math.cos(a) * r)
      e.y = g.terrain.heightAt(e.x, e.z) + 0.05
      this.arcs[i] = L.arc(_tip, e, { life: 0.12 + Math.random() * 0.16, width: 0.07 + k * 0.05, forks: 2, intensity: 0.8 + k * 0.3 })
    }
    // at full power the blade throws big forked bolts into the ground
    this.boltT -= dt
    if (k >= 1 && this.boltT <= 0) {
      this.boltT = 0.25 + Math.random() * 0.3
      const a = Math.random() * Math.PI * 2
      const r = 5 + Math.random() * 6
      _v.set(p.pos.x + Math.sin(a) * r, 0, p.pos.z + Math.cos(a) * r)
      _v.y = g.terrain.heightAt(_v.x, _v.z)
      L.bolt(_tip, _v, { width: 0.24, forks: 5, life: 0.2, sparks: Math.random() < 0.4 })
    }
  }
}
