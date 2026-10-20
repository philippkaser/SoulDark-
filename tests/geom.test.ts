import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { distPointSegment, segmentSegmentDist, shapeBounds, shapeHitsCapsule, shapeHitsSphere, type Shape } from '../src/engine/geom'

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

describe('distances', () => {
  test('point to segment clamps to the ends', () => {
    expect(distPointSegment(0, 1, 0, -1, 0, 0, 1, 0, 0)).toBeCloseTo(1)
    expect(distPointSegment(3, 0, 0, -1, 0, 0, 1, 0, 0)).toBeCloseTo(2)
  })

  test('segment to segment: crossing, parallel and skew', () => {
    expect(segmentSegmentDist(v(-1, 0, 0), v(1, 0, 0), v(0, -1, 0), v(0, 1, 0))).toBeCloseTo(0)
    expect(segmentSegmentDist(v(0, 0, 0), v(1, 0, 0), v(0, 2, 0), v(1, 2, 0))).toBeCloseTo(2)
    expect(segmentSegmentDist(v(-1, 0, 0), v(1, 0, 0), v(0, 3, -1), v(0, 3, 1))).toBeCloseTo(3)
  })
})

describe('attack shapes', () => {
  test('sphere and capsule', () => {
    const s: Shape = { t: 'sphere', c: v(0, 0, 0), r: 2 }
    expect(shapeHitsSphere(s, 2.5, 0, 0, 0.6)).toBe(true)
    expect(shapeHitsSphere(s, 2.5, 0, 0, 0.5)).toBe(true)
    expect(shapeHitsSphere(s, 3.2, 0, 0, 0.5)).toBe(false)
    const c: Shape = { t: 'capsule', a: v(0, 0, 0), b: v(0, 0, -100), r: 1 }
    expect(shapeHitsSphere(c, 1.4, 0, -60, 0.5)).toBe(true)
    expect(shapeHitsSphere(c, 0, 0, -102, 0.5)).toBe(false)
  })

  test('sector: in front, behind, above, and the target-size pad', () => {
    const s: Shape = { t: 'sector', c: v(0, 0, 0), dir: v(0, 0, -1), range: 10, cos: Math.cos(Math.PI / 4), y0: -1, y1: 3 }
    expect(shapeHitsSphere(s, 0, 1, -5, 0.5)).toBe(true)
    expect(shapeHitsSphere(s, 0, 1, 5, 0.5)).toBe(false)
    expect(shapeHitsSphere(s, 0, 8, -5, 0.5)).toBe(false)
    // just outside 45°, but big enough to poke in
    expect(shapeHitsSphere(s, 5.5, 1, -5, 0.2)).toBe(false)
    expect(shapeHitsSphere(s, 5.5, 1, -5, 1.2)).toBe(true)
  })

  test('slab: the Heaven Splitter is a wall that reaches the sky', () => {
    const s: Shape = { t: 'slab', a: v(0, 0, 0), b: v(0, 0, -300), r: 2, h: 400 }
    expect(shapeHitsSphere(s, 0, 380, -250, 1)).toBe(true)
    expect(shapeHitsSphere(s, 4, 10, -100, 1)).toBe(false)
    expect(shapeHitsSphere(s, 0, 420, -100, 1)).toBe(false)
  })

  test('ring: an expanding shockwave only touches its band', () => {
    const s: Shape = { t: 'ring', c: v(0, 0, 0), r0: 50, r1: 60, h: 10 }
    expect(shapeHitsSphere(s, 55, 1, 0, 0.5)).toBe(true)
    expect(shapeHitsSphere(s, 20, 1, 0, 0.5)).toBe(false)
    expect(shapeHitsSphere(s, 0, 1, -70, 0.5)).toBe(false)
    expect(shapeHitsSphere(s, 55, 30, 0, 0.5)).toBe(false)
  })

  test('shapes against a giant capsule body', () => {
    const body = [v(0, 0, -30), v(0, 36, -30)] as const
    const slam: Shape = { t: 'sphere', c: v(0, 20, -27), r: 1 }
    expect(shapeHitsCapsule(slam, body[0], body[1], 3)).toBe(true)
    const wall: Shape = { t: 'slab', a: v(-50, 0, -30), b: v(50, 0, -30), r: 1, h: 100 }
    expect(shapeHitsCapsule(wall, body[0], body[1], 3)).toBe(true)
    const far: Shape = { t: 'capsule', a: v(20, 0, 0), b: v(20, 0, -100), r: 2 }
    expect(shapeHitsCapsule(far, body[0], body[1], 3)).toBe(false)
  })

  test('bounds enclose the shape', () => {
    expect(shapeBounds({ t: 'capsule', a: v(-2, 0, 5), b: v(4, 0, -1), r: 1 })).toEqual([-3, -2, 5, 6])
    expect(shapeBounds({ t: 'ring', c: v(10, 0, 10), r0: 2, r1: 5, h: 1 })).toEqual([5, 5, 15, 15])
  })
})
