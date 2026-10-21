import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { Terrain, TERRAIN_MAX, TERRAIN_MIN } from '../src/game/world/terrain'

const n = new THREE.Vector3()

describe('terrain heightfield', () => {
  test('starts flat and reads 0 outside the field', () => {
    const t = new Terrain(256)
    expect(t.heightAt(0, 0)).toBe(0)
    expect(t.heightAt(1000, -1000)).toBe(0)
    t.normalAt(10, 10, n)
    expect(n.y).toBeCloseTo(1)
  })

  test('a crater is a bowl with a raised rim and leaves the far plain alone', () => {
    const t = new Terrain(512)
    t.crater(20, -30, 10, 4, { seed: 7 })
    const centre = t.heightAt(20, -30)
    expect(centre).toBeLessThan(-3)
    expect(centre).toBeGreaterThan(-5.5)
    // somewhere around the rim stands above the plain
    let rim = -Infinity
    for (let a = 0; a < Math.PI * 2; a += 0.1) for (let r = 8; r <= 13; r += 0.5) rim = Math.max(rim, t.heightAt(20 + Math.cos(a) * r, -30 + Math.sin(a) * r))
    expect(rim).toBeGreaterThan(0.4)
    expect(t.heightAt(80, 60)).toBe(0)
  })

  test('crater walls lean toward the centre', () => {
    const t = new Terrain(512)
    t.crater(0, 0, 12, 5, { seed: 3, jag: 0 })
    t.normalAt(6, 0, n)
    expect(n.x).toBeLessThan(-0.15)
    t.normalAt(0, -6, n)
    expect(n.z).toBeGreaterThan(0.15)
  })

  test('craters are ragged, not perfect circles', () => {
    const t = new Terrain(512)
    t.crater(0, 0, 14, 5, { seed: 11, jag: 0.25, ejecta: 0 })
    const hs: number[] = []
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) hs.push(t.heightAt(Math.cos(a) * 12, Math.sin(a) * 12))
    expect(Math.max(...hs) - Math.min(...hs)).toBeGreaterThan(0.5)
  })

  test('overlapping craters dig deeper but depth is clamped', () => {
    const t = new Terrain(256)
    t.crater(0, 0, 10, 4, { seed: 1 })
    const once = t.heightAt(0, 0)
    t.crater(0, 0, 10, 4, { seed: 2 })
    expect(t.heightAt(0, 0)).toBeLessThan(once - 2)
    for (let i = 0; i < 20; i++) t.crater(0, 0, 30, 12, { seed: 10 + i })
    let lo = Infinity
    let hi = -Infinity
    for (const h of t.heights) {
      lo = Math.min(lo, h)
      hi = Math.max(hi, h)
    }
    expect(lo).toBeGreaterThanOrEqual(TERRAIN_MIN)
    expect(hi).toBeLessThanOrEqual(TERRAIN_MAX)
  })

  test('heights fade to 0 at the border so the field meets the outer plain', () => {
    const t = new Terrain(256)
    const h = t.half
    t.crater(h - 2, 0, 20, 10, { seed: 5 })
    t.crater(0, -h + 1, 20, 10, { seed: 6 })
    const r = t.res
    for (let i = 0; i < r; i++) {
      for (const k of [i, (r - 1) * r + i, i * r, i * r + r - 1]) expect(Math.abs(t.heights[k])).toBe(0)
    }
    expect(t.heightAt(h - 0.01, 0)).toBeCloseTo(0, 3)
    // but well inside, the crater is there
    expect(t.heightAt(h - 12, 0)).toBeLessThan(-1)
  })

  test('a trench is a long gouge with raised lips', () => {
    const t = new Terrain(512)
    t.trench(-80, 0, 80, 0, 10, 8, { seed: 4 })
    expect(t.heightAt(0, 0)).toBeLessThan(-5)
    expect(t.heightAt(40, 0)).toBeLessThan(-4)
    // lips stand proud on both sides somewhere along the cut
    let lipA = -Infinity
    let lipB = -Infinity
    for (let x = -40; x <= 40; x += 2) {
      for (let s = 4; s <= 12; s += 0.5) {
        lipA = Math.max(lipA, t.heightAt(x, s))
        lipB = Math.max(lipB, t.heightAt(x, -s))
      }
    }
    expect(lipA).toBeGreaterThan(0.5)
    expect(lipB).toBeGreaterThan(0.5)
    // nothing past the ends or far to the side
    expect(t.heightAt(110, 0)).toBe(0)
    expect(t.heightAt(0, 40)).toBe(0)
  })

  test('trench slices partition the line exactly', () => {
    const whole = new Terrain(256)
    const parts = new Terrain(256)
    whole.trench(-100, -40, 120, 60, 12, 9, { seed: 99 })
    const steps = 17
    for (let i = 0; i < steps; i++) parts.trench(-100, -40, 120, 60, 12, 9, { seed: 99, from: i / steps, to: (i + 1) / steps })
    let diff = 0
    for (let i = 0; i < whole.heights.length; i++) diff = Math.max(diff, Math.abs(whole.heights[i] - parts.heights[i]))
    expect(diff).toBeLessThan(1e-5)
  })

  test('heightAt interpolates between texel centres like the GPU', () => {
    const t = new Terrain(256)
    const c = t.cell
    // texel (10, 20) and (11, 20)
    t.heights[20 * t.res + 10] = 2
    t.heights[20 * t.res + 11] = 4
    const x0 = -t.half + 10.5 * c
    const z = -t.half + 20.5 * c
    expect(t.heightAt(x0, z)).toBeCloseTo(2)
    expect(t.heightAt(x0 + c, z)).toBeCloseTo(4)
    expect(t.heightAt(x0 + c / 2, z)).toBeCloseTo(3)
  })

  test('uploads are throttled, only happen when dirty, and mirror the heights as half floats', () => {
    const t = new Terrain(256)
    const u0 = t.uploads
    t.update(1 / 60)
    expect(t.uploads).toBe(u0)
    t.crater(0, 0, 8, 3, { seed: 1 })
    const v = t.version
    expect(v).toBeGreaterThan(0)
    t.update(1 / 60)
    expect(t.uploads).toBe(u0 + 1)
    const k = Math.floor(t.res / 2) * t.res + Math.floor(t.res / 2)
    const data = t.tex.image.data as Uint16Array
    expect(THREE.DataUtils.fromHalfFloat(data[k])).toBeCloseTo(t.heights[k], 1)
    // a second carve right away waits for the throttle
    t.crater(30, 30, 8, 3, { seed: 2 })
    t.update(1 / 60)
    expect(t.uploads).toBe(u0 + 1)
    for (let i = 0; i < 6; i++) t.update(1 / 60)
    expect(t.uploads).toBe(u0 + 2)
  })

  test('reset flattens everything', () => {
    const t = new Terrain(256)
    t.crater(0, 0, 20, 8)
    t.trench(-50, 0, 50, 0, 6, 4)
    t.reset()
    expect(t.heights.every((h) => h === 0)).toBe(true)
    expect(t.heightAt(0, 0)).toBe(0)
  })
})
