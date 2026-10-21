import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { ballistic, bounceFriction, dragF, dragG, GpuParticles, motion, ringRanges, STRIDE, type ParticleStyle, type Vec3T } from '../src/engine/gpuParticles'

/** RK4 on v' = -k v - g ŷ, p' = v. */
function integrate(o: number[], v: number[], g: number, k: number, t: number, h = 1e-4) {
  const p = [...o]
  const u = [...v]
  const acc = (w: number[]) => [-k * w[0], -k * w[1] - g, -k * w[2]]
  let s = 0
  while (s < t - 1e-12) {
    const dt = Math.min(h, t - s)
    const a1 = acc(u)
    const u2 = u.map((x, i) => x + a1[i] * dt * 0.5)
    const a2 = acc(u2)
    const u3 = u.map((x, i) => x + a2[i] * dt * 0.5)
    const a3 = acc(u3)
    const u4 = u.map((x, i) => x + a3[i] * dt)
    const a4 = acc(u4)
    for (let i = 0; i < 3; i++) {
      p[i] += (dt / 6) * (u[i] + 2 * u2[i] + 2 * u3[i] + u4[i])
      u[i] += (dt / 6) * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i])
    }
    s += dt
  }
  return { p, v: u }
}

/** Small-step simulation with the same bounce rule: reflect once, then slide. */
function simulateBounce(o: number[], v: number[], g: number, k: number, t: number, bounce: number, h = 2e-5) {
  const p = [...o]
  const u = [...v]
  let bounced = false
  let sliding = false
  for (let s = 0; s < t - 1e-12; s += h) {
    const e = Math.exp(-k * h)
    u[0] *= e
    u[2] *= e
    if (!sliding) u[1] = u[1] * e - g * h
    const py = p[1]
    p[0] += u[0] * h
    p[1] += u[1] * h
    p[2] += u[2] * h
    if (!sliding && p[1] < 0 && py >= 0) {
      if (!bounced) {
        bounced = true
        const fr = bounceFriction(bounce)
        p[1] = 0
        u[0] *= fr
        u[2] *= fr
        u[1] = -u[1] * bounce
      } else {
        sliding = true
        p[1] = 0
        u[1] = 0
      }
    }
  }
  return p
}

const close = (a: readonly number[], b: readonly number[], eps: number) => {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps)
}

describe('ring buffer upload ranges', () => {
  test('a contiguous write is one range', () => {
    expect(ringRanges(10, 5, 100)).toEqual([10, 5])
    expect(ringRanges(95, 5, 100)).toEqual([95, 5])
  })
  test('a write that wraps becomes two ranges', () => {
    expect(ringRanges(98, 5, 100)).toEqual([98, 2, 0, 3])
  })
  test('writing the whole ring or more uploads everything once', () => {
    expect(ringRanges(40, 100, 100)).toEqual([0, 100])
    expect(ringRanges(40, 250, 100)).toEqual([0, 100])
  })
  test('nothing written, nothing uploaded', () => {
    expect(ringRanges(3, 0, 100)).toEqual([])
  })
  test('ranges cover exactly the written slots', () => {
    for (const [start, count] of [
      [0, 1],
      [7, 9],
      [12, 4],
      [15, 1],
    ]) {
      const cap = 16
      const r = ringRanges(start, count, cap)
      const hit = new Set<number>()
      for (let i = 0; i < r.length; i += 2) for (let j = 0; j < r[i + 1]; j++) hit.add(r[i] + j)
      const want = new Set<number>()
      for (let j = 0; j < count; j++) want.add((start + j) % cap)
      expect([...hit].sort((a, b) => a - b)).toEqual([...want].sort((a, b) => a - b))
    }
  })
})

describe('closed-form drag', () => {
  test('series and exact forms agree around the switch-over', () => {
    for (const x of [0.0009, 0.001, 0.0011, 0.049, 0.05, 0.051]) {
      const t = 1.3
      const k = x / t
      expect(dragF(k, t)).toBeCloseTo((1 - Math.exp(-k * t)) / k, 7)
      expect(dragG(k, t)).toBeCloseTo((t - (1 - Math.exp(-k * t)) / k) / k, 6)
    }
  })
  test('no drag is plain projectile motion', () => {
    expect(dragF(0, 2)).toBeCloseTo(2, 9)
    expect(dragG(0, 2)).toBeCloseTo(2, 9)
  })
})

describe('ballistic motion matches numeric integration', () => {
  const cases: [number[], number[], number, number, number][] = [
    [[0, 5, 0], [12, 20, -7], 9.8, 0, 1.7],
    [[3, 1, -2], [40, 10, 25], 14, 2.2, 0.9],
    [[0, 0, 0], [1, 2, 3], -0.8, 1.1, 5],
    [[0, 0, 0], [80, 0, 0], 0, 6, 2],
    [[1, 2, 3], [0, 0, 0], 9.8, 0.4, 3],
  ]
  for (const [o, v, g, k, t] of cases) {
    test(`g=${g} k=${k} t=${t}`, () => {
      const p: Vec3T = [0, 0, 0]
      const vel: Vec3T = [0, 0, 0]
      ballistic(o, v, g, k, t, p, vel)
      const ref = integrate(o, v, g, k, t)
      close(p, ref.p, 1e-4 * (1 + Math.hypot(...ref.p)))
      close(vel, ref.v, 1e-4 * (1 + Math.hypot(...ref.v)))
    })
  }
})

describe('ground bounce', () => {
  test('without bounce particles pass through the ground', () => {
    const p: Vec3T = [0, 0, 0]
    const v: Vec3T = [0, 0, 0]
    motion([0, 1, 0], [0, 0, 0], 9.8, 0, 2, undefined, p, v)
    expect(p[1]).toBeLessThan(-10)
  })
  test('a bouncing spark never goes below the ground', () => {
    const p: Vec3T = [0, 0, 0]
    const v: Vec3T = [0, 0, 0]
    for (let t = 0; t < 3; t += 0.01) {
      motion([0, 2, 0], [6, 9, 3], 14, 1.5, t, 0.35, p, v)
      expect(p[1]).toBeGreaterThanOrEqual(0)
    }
  })
  for (const [o, v, g, k, b] of [
    [[0, 2, 0], [6, 9, 3], 14, 1.5, 0.35],
    [[1, 0.5, -1], [-20, -4, 10], 9.8, 0.6, 0.5],
    [[0, 3, 0], [3, 0, 0], 9.8, 0, 0.3],
    [[0, 1, 0], [15, 6, 0], 12, 3, 0],
  ] as [number[], number[], number, number, number][]) {
    test(`matches a stepped simulation (g=${g} k=${k} bounce=${b})`, () => {
      const p: Vec3T = [0, 0, 0]
      const vel: Vec3T = [0, 0, 0]
      for (const t of [0.2, 0.6, 1.1, 1.8, 2.6]) {
        motion(o, v, g, k, t, b, p, vel)
        const ref = simulateBounce(o, v, g, k, t, b)
        close(p, ref, 0.02 * (1 + Math.hypot(...ref) * 0.05))
      }
    })
  }
})

describe('GPU particle pool', () => {
  const style: ParticleStyle = { c0: [4, 2, 1, 1], c1: [1, 0.2, 0, 0], s0: 0.1, s1: 0.02, gravity: 9.8, drag: 1, stretch: 0.03, bounce: 0.3 }
  const buffer = (pool: GpuParticles) => (pool.mesh.geometry.getAttribute('aOB') as THREE.InterleavedBufferAttribute).data

  test('emits write the instance buffer and only the new range is uploaded', () => {
    const pool = new GpuParticles({ capacity: 64 })
    pool.update(0.5)
    buffer(pool).clearUpdateRanges()
    for (let i = 0; i < 10; i++) pool.emit(i, 1, 2, 3, 4, 5, 2, style, 2, 0.5)
    pool.update(0.016)
    const data = buffer(pool)
    expect(data.updateRanges).toEqual([{ start: 0, count: 10 * STRIDE }])
    const a = data.array as Float32Array
    expect(a[STRIDE * 3]).toBe(3)
    expect(a[3]).toBeCloseTo(0.5, 6) // birth on the pool's clock
    expect(a[7]).toBe(2) // life
    expect(a[8]).toBe(2) // colour scaled by bright
    expect(a[16]).toBeCloseTo(0.2, 6) // size scaled by sizeMul
    expect(a[23]).toBeCloseTo(0.3, 6) // bounce
    expect(pool.mesh.visible).toBe(true)
    expect((pool.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(10)
  })

  test('styles fill defaults and alternate correctly', () => {
    const pool = new GpuParticles({ capacity: 16 })
    const plain: ParticleStyle = { c0: [1, 1, 1, 1], c1: [0, 0, 0, 0], s0: 1, s1: 2 }
    pool.emit(0, 0, 0, 0, 0, 0, 1, plain)
    pool.emit(0, 0, 0, 0, 0, 0, 1, style)
    pool.emit(0, 0, 0, 0, 0, 0, 1, plain, 3)
    const a = buffer(pool).array as Float32Array
    // plain: no gravity or drag, no ground, default flow frequency and fade-in
    expect([a[18], a[19], a[22], a[23]]).toEqual([0, 0, 0, -1])
    expect(a[21]).toBeCloseTo(0.35, 6)
    expect(a[27]).toBeCloseTo(0.02, 6)
    expect(a[STRIDE + 18]).toBeCloseTo(9.8, 5)
    expect(a[STRIDE * 2 + 16]).toBe(3)
    expect(a[STRIDE * 2 + 17]).toBe(6)
    // every particle gets its own seed
    expect(a[24]).not.toBe(a[STRIDE + 24])
  })

  test('wrapping the ring uploads two ranges', () => {
    const pool = new GpuParticles({ capacity: 32 })
    for (let i = 0; i < 28; i++) pool.emit(0, 0, 0, 0, 0, 0, 1, style)
    pool.update(0.016)
    buffer(pool).clearUpdateRanges()
    for (let i = 0; i < 8; i++) pool.emit(0, 0, 0, 0, 0, 0, 1, style)
    pool.update(0.016)
    expect(buffer(pool).updateRanges).toEqual([
      { start: 28 * STRIDE, count: 4 * STRIDE },
      { start: 0, count: 4 * STRIDE },
    ])
    expect((pool.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(32)
  })

  test('the pool hides itself once everything has died, and the clock is world time', () => {
    const pool = new GpuParticles({ capacity: 32 })
    pool.emit(0, 0, 0, 0, 0, 0, 1, style, 1, 1, 0.5)
    pool.update(1.2)
    expect(pool.mesh.visible).toBe(true)
    // a stopped world (dt = 0) keeps them alive forever
    for (let i = 0; i < 100; i++) pool.update(0)
    expect(pool.mesh.visible).toBe(true)
    pool.update(0.4)
    expect(pool.mesh.visible).toBe(false)
  })

  test('clear kills everything and restarts the clock', () => {
    const pool = new GpuParticles({ capacity: 32 })
    pool.emit(0, 0, 0, 0, 0, 0, 5, style)
    pool.update(1)
    pool.clear()
    pool.update(0)
    expect(pool.time).toBe(0)
    expect(pool.mesh.visible).toBe(false)
    expect((buffer(pool).array as Float32Array)[7]).toBe(0)
  })
})
