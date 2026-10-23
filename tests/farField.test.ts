import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { horizonHeight, HORIZON_MAX, HORIZON_MIN } from '../src/game/player/arts'
import { FarField, MAX_SLICES, mountainHeight, NO_CEIL } from '../src/game/world/farField'

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

  test('a cut ceiling flattens exactly the cells it covers, and reset restores them', () => {
    far.reset()
    const p = peak()
    const y = p.h * 0.5
    const n = far.res
    const i = Math.floor((p.x + far.half) / far.cell)
    const j = Math.floor((p.z + far.half) / far.cell)
    const cells: number[] = []
    for (let b = -6; b <= 6; b++) for (let a = -6; a <= 6; a++) cells.push((j + b) * n + (i + a))
    far.cutCeiling(cells, y)
    const cx = -far.half + (i + 0.5) * far.cell
    const cz = -far.half + (j + 0.5) * far.cell
    expect(far.heightAt(cx, cz)).toBeLessThanOrEqual(y + 1e-3)
    expect(far.rawHeightAt(cx, cz)).toBeGreaterThan(y)
    expect(far.ceilAt(cx, cz)).toBeCloseTo(y)
    // ground below the cut and ground far away are untouched
    expect(far.heightAt(0, 0)).toBe(far.rawHeightAt(0, 0))
    expect(far.ceilAt(-cx, -cz)).toBe(NO_CEIL)
    far.reset()
    expect(far.heightAt(cx, cz)).toBeCloseTo(far.rawHeightAt(cx, cz))
  })

  test('the glow records keep only the latest cuts', () => {
    far.reset()
    for (let i = 0; i < MAX_SLICES + 2; i++) far.slice(0, 0, 4000, 100 + i, i, 0.5, 0.9)
    expect(far.slices.length).toBe(MAX_SLICES)
    expect(far.slices[MAX_SLICES - 1].y).toBe(100 + MAX_SLICES + 1)
    expect(far.sliceB[0].z).toBeCloseTo(0.5)
    expect(far.sliceB[0].w).toBeCloseTo(0.9)
    far.reset()
    expect(far.slices.length).toBe(0)
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
