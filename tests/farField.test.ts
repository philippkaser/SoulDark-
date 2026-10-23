import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { horizonHeight, HORIZON_MAX, HORIZON_MIN } from '../src/game/player/arts'
import { FarField, MAX_SLICES, mountainHeight } from '../src/game/world/farField'

// a small field keeps the tests quick; the geometry is the same at any resolution
const far = new FarField(128)

/** A spot in the range with real height to cut. */
function peak() {
  let best = { x: 0, z: 0, h: 0 }
  for (let a = 0; a < Math.PI * 2; a += 0.1) {
    for (const r of [1400, 1800, 2200, 2600]) {
      const x = Math.sin(a) * r
      const z = Math.cos(a) * r
      const h = far.rawHeightAt(x, z)
      if (h > best.h) best = { x, z, h }
    }
  }
  return best
}

describe('the far field', () => {
  test('the plain stays flat around the arena; the range rises far out', () => {
    expect(mountainHeight(0, 0)).toBe(0)
    expect(mountainHeight(300, -200)).toBe(0)
    expect(peak().h).toBeGreaterThan(200)
  })

  test('a slice takes everything above its plane off within its radius, and nothing outside it', () => {
    far.reset()
    const p = peak()
    const y = p.h * 0.5
    far.slice(0, 0, 4000, y, 0)
    expect(far.heightAt(p.x, p.z)).toBeCloseTo(y)
    expect(far.rawHeightAt(p.x, p.z)).toBeCloseTo(p.h)
    // ground below the plane is untouched
    expect(far.heightAt(0, 0)).toBe(far.rawHeightAt(0, 0))
    far.reset()
    far.slice(p.x + 5000, p.z, 100, y, 0)
    expect(far.heightAt(p.x, p.z)).toBeCloseTo(p.h)
  })

  test('slices beyond the shader budget are baked into the heights, so nothing grows back', () => {
    far.reset()
    const p = peak()
    far.slice(0, 0, 4000, p.h * 0.4, 0)
    for (let i = 0; i < MAX_SLICES; i++) far.slice(9000 + i, 9000, 10, 500, 0)
    expect(far.slices.length).toBe(MAX_SLICES)
    expect(far.rawHeightAt(p.x, p.z)).toBeLessThanOrEqual(p.h * 0.4 + 1e-3)
    expect(far.sliceA.length).toBe(MAX_SLICES)
    far.reset()
    expect(far.slices.length).toBe(0)
    expect(far.rawHeightAt(p.x, p.z)).toBeCloseTo(p.h)
  })
})

describe('the Horizon Cut', () => {
  test('it cuts where the aim meets the range', () => {
    far.reset()
    const p = peak()
    const o = new THREE.Vector3(0, 30, 0)
    const target = new THREE.Vector3(p.x, p.h * 0.6, p.z)
    const dir = target.clone().sub(o).normalize()
    const r = horizonHeight(o, dir, (x, z) => far.heightAt(x, z), 2)
    expect(r.hit).not.toBeNull()
    expect(r.y).toBeLessThanOrEqual(p.h * 0.6 + 1)
    expect(r.y).toBeGreaterThanOrEqual(HORIZON_MIN)
  })

  test('aimed at empty sky it slants up from the chest, within limits', () => {
    const o = new THREE.Vector3(0, 3, 0)
    const up = horizonHeight(o, new THREE.Vector3(0, 0.2, -1).normalize(), () => -1e9, 2)
    expect(up.hit).toBeNull()
    expect(up.y).toBeGreaterThan(200)
    expect(horizonHeight(o, new THREE.Vector3(0, 0.99, -0.01).normalize(), () => -1e9, 2).y).toBe(HORIZON_MAX)
    expect(horizonHeight(o, new THREE.Vector3(0, -0.01, -1).normalize(), () => -1e9, 2).y).toBe(HORIZON_MIN)
  })
})
