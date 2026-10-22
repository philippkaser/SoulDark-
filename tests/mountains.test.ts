import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import {
  emptyBore,
  emptyNotch,
  FAR_RING,
  MAX_BORES,
  MAX_NOTCHES,
  NEAR_RING,
  packBores,
  packNotches,
  packRingSeed,
  pickSlot,
  Ridge,
  RIDGE_FLOOR,
} from '../src/game/world/ridge'

const near = new Ridge(NEAR_RING)
const far = new Ridge(FAR_RING)
const vec4s = (n: number) => Array.from({ length: n }, () => new THREE.Vector4())

/** Brute-force march along the ray: the first t inside the rock. */
function bruteEntry(r: Ridge, o: THREE.Vector3, d: THREE.Vector3, step = 0.5) {
  for (let t = 0; t < 4000; t += step) if (r.inside(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t)) return t
  return -1
}

describe('ridge profile', () => {
  test('the crest keeps the old horizon band silhouette range', () => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < 720; i++) {
      const h = near.crestHeight((i / 720) * Math.PI * 2)
      lo = Math.min(lo, h)
      hi = Math.max(hi, h)
    }
    expect(lo).toBeGreaterThanOrEqual(NEAR_RING.base)
    expect(hi).toBeLessThanOrEqual(NEAR_RING.base + NEAR_RING.amp)
    expect(hi - lo).toBeGreaterThan(NEAR_RING.amp * 0.3)
  })

  test('the ring has thickness: a summit, faces on both sides, and nothing on the plain', () => {
    const a = 0.7
    const rc = near.crestRadius(a)
    const H = near.crestHeight(a)
    const x = (r: number) => Math.sin(a) * r
    const z = (r: number) => Math.cos(a) * r
    // the summit stands near the crest height
    expect(near.heightAt(x(rc), z(rc))).toBeGreaterThan(H * 0.7)
    // the arena side falls away, then tucks under the plain
    expect(near.heightAt(x(rc - near.crestHalf(a) - (H / NEAR_RING.slopeIn) * 0.5), z(rc - near.crestHalf(a) - (H / NEAR_RING.slopeIn) * 0.5))).toBeLessThan(H * 0.8)
    expect(near.heightAt(x(near.rMin + 1), z(near.rMin + 1))).toBeLessThan(0)
    expect(near.heightAt(0, 0)).toBe(RIDGE_FLOOR)
    expect(near.heightAt(x(3000), z(3000))).toBe(RIDGE_FLOOR)
    // and so does the far side
    expect(near.heightAt(x(near.rMax - 1), z(near.rMax - 1))).toBeLessThan(0)
  })

  test('the table matches the analytic profile it was sampled from', () => {
    for (let i = 0; i < 50; i++) {
      const a = i * 0.37
      const r = near.crestRadius(a) + (i % 7) * 20 - 60
      const h = near.profile(r, a)
      const t = near.heightAt(Math.sin(a) * r, Math.cos(a) * r)
      expect(Math.abs(t - h)).toBeLessThan(Math.max(6, Math.abs(h) * 0.12))
    }
  })

  test('the rings do not overlap: the near ring is back under the plain before the far one rises', () => {
    for (let i = 0; i < 360; i++) {
      const a = (i / 360) * Math.PI * 2
      let nearEnd = 0
      let farStart = Infinity
      for (let r = near.rMin; r < far.rMax; r += 5) {
        const x = Math.sin(a) * r
        const z = Math.cos(a) * r
        if (near.heightAt(x, z) > 0) nearEnd = r
        if (far.heightAt(x, z) > 0 && r < farStart) farStart = r
      }
      expect(nearEnd).toBeLessThan(farStart)
    }
  })
})

describe('ray vs ridge', () => {
  test('a level ray from the arena meets the near face where a brute-force march does', () => {
    const o = new THREE.Vector3(0, 6, 0)
    for (const az of [0.3, 1.1, 2.4, 3.9, 5.5]) {
      const d = new THREE.Vector3(Math.sin(az), 0.004, Math.cos(az)).normalize()
      const hit = near.rayHit(o, d)
      expect(hit).not.toBeNull()
      const brute = bruteEntry(near, o, d)
      expect(Math.abs(hit!.tIn - brute)).toBeLessThan(1)
      // the entry lies between the foot and the crest line, and the tunnel has depth
      const rIn = Math.hypot(o.x + d.x * hit!.tIn, o.z + d.z * hit!.tIn)
      expect(rIn).toBeGreaterThan(near.rMin)
      expect(rIn).toBeLessThan(near.crestRadius(az) + 1)
      expect(hit!.tOut - hit!.tIn).toBeGreaterThan(40)
      expect(hit!.tOut - hit!.tIn).toBeLessThan(700)
      // just past the exit the ray is in the open again
      const t = hit!.tOut + 2
      expect(near.inside(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t)).toBe(false)
    }
  })

  test('it carries on to the far ring', () => {
    const o = new THREE.Vector3(0, 6, 0)
    const d = new THREE.Vector3(0.8, 0.02, -0.6).normalize()
    const n = near.rayHit(o, d)
    const f = far.rayHit(o, d, { tIn: 0, tOut: 0 })
    expect(n).not.toBeNull()
    expect(f).not.toBeNull()
    expect(f!.tIn).toBeGreaterThan(n!.tOut)
  })

  test('a ray that climbs over the crest misses', () => {
    const o = new THREE.Vector3(0, 6, 0)
    expect(near.rayHit(o, new THREE.Vector3(0, 0.4, -1).normalize())).toBeNull()
    expect(near.rayHit(o, new THREE.Vector3(0, 1, 0))).toBeNull()
  })

  test('a ray aimed at a low saddle clips just the top', () => {
    // find the lowest crest and aim at a point just under it
    let best = 0
    for (let i = 0; i < 2000; i++) if (near.crestHeight((i / 2000) * Math.PI * 2) < near.crestHeight(best)) best = (i / 2000) * Math.PI * 2
    const H = near.crestHeight(best)
    const rc = near.crestRadius(best)
    const o = new THREE.Vector3(0, 6, 0)
    const target = new THREE.Vector3(Math.sin(best) * rc, H - 4, Math.cos(best) * rc)
    const d = target.clone().sub(o).normalize()
    const hit = near.rayHit(o, d)
    expect(hit).not.toBeNull()
    expect(hit!.tIn).toBeGreaterThan(rc - 300)
  })
})

describe('carve uniforms', () => {
  test('bores pack as (origin, radius), (dir, age), (tFace, tEnd, speed, ring + seed)', () => {
    const bores = Array.from({ length: MAX_BORES }, emptyBore)
    const b = bores[2]
    b.ring = 1
    b.origin.set(1, 2, 3)
    b.dir.set(0, 0, -1)
    b.radius = 60
    b.age = -0.5
    b.tFace = 1300
    b.tEnd = 1700
    b.speed = 900
    b.seed = 0.25
    const A = vec4s(MAX_BORES)
    const B = vec4s(MAX_BORES)
    const C = vec4s(MAX_BORES)
    packBores(bores, A, B, C)
    expect(A[2].toArray()).toEqual([1, 2, 3, 60])
    expect(B[2].toArray()).toEqual([0, 0, -1, -0.5])
    expect(C[2].x).toBe(1300)
    expect(C[2].y).toBe(1700)
    expect(C[2].z).toBe(900)
    expect(Math.floor(C[2].w)).toBe(1)
    expect(C[2].w - 1).toBeCloseTo(0.25, 6)
    // empty slots are skipped by the shader (radius 0)
    for (const i of [0, 1, 3, 7]) expect(A[i].w).toBe(0)
  })

  test('notches pack their plane, range and heights', () => {
    const notches = Array.from({ length: MAX_NOTCHES }, emptyNotch)
    const n = notches[0]
    n.ring = 0
    n.origin.set(5, 0, -7)
    n.fwd.set(0.6, 0, -0.8)
    n.width = 12
    n.flare = 0.2
    n.s0 = 1000
    n.s1 = 1600
    n.yTop = 260
    n.yBottom = 40
    n.age = 0.3
    n.seed = 0.5
    const A = vec4s(MAX_NOTCHES)
    const B = vec4s(MAX_NOTCHES)
    const C = vec4s(MAX_NOTCHES)
    packNotches(notches, A, B, C)
    expect(A[0].toArray()).toEqual([5, -7, 12, 0.2])
    expect(B[0].x).toBeCloseTo(0.6)
    expect(B[0].y).toBeCloseTo(-0.8)
    expect([B[0].z, B[0].w]).toEqual([1000, 1600])
    expect([C[0].x, C[0].y, C[0].z]).toEqual([260, 40, 0.3])
    expect(C[0].w).toBeCloseTo(0.5, 6)
    expect(A[1].z).toBe(0)
  })

  test('the ring id survives in the integer part, the seed in the fraction', () => {
    expect(Math.floor(packRingSeed(1, 0.999999))).toBe(1)
    expect(Math.floor(packRingSeed(0, 2))).toBe(0)
    expect(packRingSeed(1, -1)).toBe(1)
  })

  test('slots fill empty ones first, then reuse the oldest', () => {
    const bores = Array.from({ length: 4 }, emptyBore)
    expect(pickSlot(bores)).toBe(0)
    bores.forEach((b, i) => {
      b.radius = 10
      b.age = [3, 9, -1, 5][i]
    })
    expect(pickSlot(bores)).toBe(1)
    bores[3].radius = 0
    expect(pickSlot(bores)).toBe(3)
    const notches = Array.from({ length: 2 }, emptyNotch)
    notches[0].width = 5
    expect(pickSlot(notches)).toBe(1)
  })
})
