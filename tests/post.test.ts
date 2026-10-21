import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { godRaysBudget } from '../src/engine/gfx/godrays'
import { MAX_HAZE, MAX_SHOCKS } from '../src/engine/gfx/powerfx'
import { streakBudget } from '../src/engine/gfx/streak'
import { blastEnvelope, lightOnScreen, PostState, screenRadius } from '../src/game/post'

/** A camera at (0, 2, 10) looking down -z, like the follow camera facing the citadel. */
function cam() {
  const c = new THREE.PerspectiveCamera(62, 16 / 9, 0.25, 6000)
  c.position.set(0, 2, 10)
  c.lookAt(0, 2, 0)
  c.updateMatrixWorld()
  return c
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const run = (p: PostState, sec: number, camera?: THREE.Camera, wdt = 1 / 60) => {
  for (let i = 0; i < Math.round(sec * 60); i++) p.update(1 / 60, camera, wdt)
}
const live = (data: THREE.Vector4[]) => data.filter((d) => d.w > 0).length

describe('screen projection helpers', () => {
  test('a light dead ahead is centred and fully visible; behind the camera it is gone', () => {
    const c = cam()
    const out = new THREE.Vector2()
    expect(lightOnScreen(v(0, 2, -100), c, out)).toBeCloseTo(1)
    expect(out.x).toBeCloseTo(0.5)
    expect(out.y).toBeCloseTo(0.5)
    expect(lightOnScreen(v(0, 2, 100), c, out)).toBe(0)
  })

  test('a light past the frame edge fades out instead of popping', () => {
    const c = cam()
    const out = new THREE.Vector2()
    // just inside, a little outside, far outside the right edge
    const inside = lightOnScreen(v(50, 2, -100), c, out)
    const near = lightOnScreen(v(150, 2, -100), c, out)
    const far = lightOnScreen(v(185, 2, -100), c, out)
    expect(inside).toBeCloseTo(1)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(1)
    expect(far).toBeLessThan(near)
  })

  test('directions at infinity (the sun) project like very far points', () => {
    const c = cam()
    const a = new THREE.Vector2()
    const b = new THREE.Vector2()
    const dir = v(0.1, 0.3, -1).normalize()
    lightOnScreen(dir, c, a, true)
    lightOnScreen(dir.clone().multiplyScalar(5000).add(c.position), c, b)
    expect(a.x).toBeCloseTo(b.x, 2)
    expect(a.y).toBeCloseTo(b.y, 2)
    expect(a.y).toBeGreaterThan(0.5)
  })

  test('screen radius shrinks with distance and vanishes behind the camera', () => {
    const c = cam()
    const r10 = screenRadius(v(0, 2, 0), 1, c)
    const r20 = screenRadius(v(0, 2, -10), 1, c)
    // 1 m at 10 m with a 62 degree lens: 1 / (2 * 10 * tan 31) screen heights
    expect(r10).toBeCloseTo(1 / (2 * 10 * Math.tan((31 * Math.PI) / 180)), 4)
    expect(r20).toBeCloseTo(r10 / 2, 4)
    expect(screenRadius(v(0, 2, 20), 1, c)).toBe(0)
  })
})

describe('stacked refractive shocks', () => {
  test('several rings live at once and each expands and fades', () => {
    const p = new PostState()
    const c = cam()
    p.shock(v(-5, 1, -20), c, 0.04)
    p.shock(v(5, 1, -20), c, 0.03)
    p.shock(v(0, 1, -40), c, 0.02)
    expect(p.shockCount).toBe(3)
    run(p, 1 / 60, c)
    expect(live(p.shockData)).toBe(3)
    expect(p.shockOn).toBe(true)
    const r0 = p.shockData.find((d) => d.w > 0)!.z
    run(p, 0.3, c)
    expect(p.shockData.find((d) => d.w > 0)!.z).toBeGreaterThan(r0)
    run(p, 2, c)
    expect(p.shockCount).toBe(0)
    expect(p.shockOn).toBe(false)
  })

  test('past the limit the weakest ring gives way', () => {
    const p = new PostState()
    const c = cam()
    for (let i = 0; i < MAX_SHOCKS; i++) p.shock(v(i, 1, -20), c, 0.02 + i * 0.001)
    p.shock(v(0, 1, -20), c, 0.09)
    expect(p.shockCount).toBe(MAX_SHOCKS)
    run(p, 1 / 60, c)
    const strengths = p.shockData.map((d) => d.w)
    expect(Math.max(...strengths)).toBeGreaterThan(0.08)
    // the 0.020 ring was replaced
    expect(Math.min(...strengths)).toBeGreaterThan(0.0205 * Math.exp(-2.2 / 60) - 1e-6)
  })

  test('a delayed ring waits before it appears', () => {
    const p = new PostState()
    const c = cam()
    p.shock(v(0, 1, -20), c, 0.03, { delay: 0.2 })
    run(p, 0.1, c)
    expect(live(p.shockData)).toBe(0)
    run(p, 0.2, c)
    expect(live(p.shockData)).toBe(1)
  })

  test('rings stay anchored to their world point as the camera turns', () => {
    const p = new PostState()
    const c = cam()
    p.shock(v(0, 2, -20), c, 0.03)
    run(p, 1 / 60, c)
    const x0 = p.shockData.find((d) => d.w > 0)!.x
    c.lookAt(-5, 2, 0)
    c.updateMatrixWorld()
    run(p, 1 / 60, c)
    expect(p.shockData.find((d) => d.w > 0)!.x).toBeGreaterThan(x0 + 0.1)
  })
})

describe('heat haze', () => {
  test('fades in, holds, fades out', () => {
    expect(PostState.hazeEnvelope(0, 4)).toBe(0)
    expect(PostState.hazeEnvelope(0.2, 4)).toBeCloseTo(0.5)
    expect(PostState.hazeEnvelope(2, 4)).toBe(1)
    expect(PostState.hazeEnvelope(3.9, 4)).toBeLessThan(0.1)
    expect(PostState.hazeEnvelope(4, 4)).toBe(0)
  })

  test('a moving source refreshes one haze instead of filling every slot', () => {
    const p = new PostState()
    const c = cam()
    for (let i = 0; i < 30; i++) {
      p.haze(v(i * 0.5, 0, -30), 8, 1, 2)
      run(p, 0.08, c)
    }
    expect(live(p.hazeData)).toBe(1)
    // and it outlives a single 2 s request
    run(p, 1.5, c)
    expect(live(p.hazeData)).toBe(1)
  })

  test('separate fires get separate hazes, up to the limit', () => {
    const p = new PostState()
    const c = cam()
    for (let i = 0; i < MAX_HAZE + 3; i++) p.haze(v(-40 + i * 12, 0, -60), 4, 1, 3)
    run(p, 0.5, c)
    expect(live(p.hazeData)).toBe(MAX_HAZE)
    expect(p.hazeOn).toBe(true)
  })

  test('lives on world time: it freezes while time is stopped', () => {
    const p = new PostState()
    const c = cam()
    p.haze(v(0, 0, -30), 6, 1, 1)
    run(p, 0.5, c)
    const clock = p.hazeClock
    run(p, 3, c, 0)
    expect(p.hazeClock).toBe(clock)
    expect(live(p.hazeData)).toBe(1)
    run(p, 1, c)
    expect(live(p.hazeData)).toBe(0)
  })
})

describe('blast light shafts', () => {
  test('envelope starts full and runs out', () => {
    expect(blastEnvelope(0, 2)).toBe(1)
    expect(blastEnvelope(1, 2)).toBeCloseTo(0.25)
    expect(blastEnvelope(2, 2)).toBe(0)
    expect(blastEnvelope(5, 2)).toBe(0)
  })

  test('shines while the blast is in view, nothing behind the camera', () => {
    const p = new PostState()
    const c = cam()
    run(p, 1 / 60, c)
    p.rays(v(0, 20, -200), 2, 2)
    run(p, 0.2, c)
    expect(p.blastRays).toBeGreaterThan(1)
    expect(p.blastScreen.y).toBeGreaterThan(0.5)
    run(p, 2, c)
    expect(p.blastRays).toBe(0)
    p.rays(v(0, 20, 200), 2, 2)
    run(p, 0.2, c)
    expect(p.blastRays).toBe(0)
  })

  test('a lesser blast right after a big one does not steal its light', () => {
    const p = new PostState()
    const c = cam()
    run(p, 1 / 60, c)
    p.rays(v(0, 20, -200), 1.6, 2.6)
    // the follow-up explosions of the same frame and the next
    p.rays(v(30, 10, -200), 0.8, 1)
    run(p, 1 / 60, c)
    p.rays(v(-30, 10, -200), 0.8, 1)
    run(p, 0.1, c)
    expect(p.blastRays).toBeGreaterThan(1.3)
  })

  test('one in view beats a brighter one behind the camera', () => {
    const p = new PostState()
    const c = cam()
    run(p, 1 / 60, c)
    p.rays(v(0, 20, 200), 2, 3)
    p.rays(v(0, 10, -100), 0.8, 1)
    run(p, 0.1, c)
    expect(p.blastRays).toBeGreaterThan(0.5)
  })

  test('reduced flashes tone the shafts down', () => {
    const a = new PostState()
    const b = new PostState()
    b.reduce = true
    const c = cam()
    for (const p of [a, b]) {
      run(p, 1 / 60, c)
      p.rays(v(0, 20, -200), 2, 2)
      run(p, 0.2, c)
    }
    expect(b.blastRays).toBeLessThan(a.blastRays * 0.5)
  })

  test('the eclipse light is tracked every frame', () => {
    const p = new PostState()
    const c = cam()
    run(p, 1 / 60, c)
    // SUN_DIR sits north and up: in view of a camera facing -z
    expect(p.sunVis).toBeGreaterThan(0.9)
    expect(p.sunScreen.y).toBeGreaterThan(0.6)
    c.lookAt(0, 2, 20)
    c.updateMatrixWorld()
    run(p, 1 / 60, c)
    expect(p.sunVis).toBe(0)
  })
})

describe('anamorphic streak', () => {
  test('kicks decay back to the resting level', () => {
    const p = new PostState()
    p.streak(2)
    expect(p.streakAmount).toBeCloseTo(p.streakBase + 2)
    run(p, 1.5)
    expect(p.streakAmount).toBeCloseTo(p.streakBase, 2)
  })

  test('a blast behind the camera flares nothing; reduced flashes flare less', () => {
    const p = new PostState()
    const c = cam()
    run(p, 1 / 60, c)
    p.streak(1.5, v(0, 5, 200))
    expect(p.streakKick).toBe(0)
    p.streak(1.5, v(0, 5, -200))
    expect(p.streakKick).toBeCloseTo(1.5)
    const q = new PostState()
    q.reduce = true
    q.streak(1.5)
    expect(q.streakKick).toBeLessThan(0.6)
  })

  test('every flash flares the lens a little', () => {
    const p = new PostState()
    p.flashTo(0.5)
    expect(p.streakKick).toBeGreaterThan(0.4)
  })
})

describe('quality budgets', () => {
  test('lower quality means fewer taps and smaller buffers', () => {
    const [h, m, l] = [1, 0.75, 0.5].map(godRaysBudget)
    expect(h.samples).toBeGreaterThan(m.samples)
    expect(m.samples).toBeGreaterThan(l.samples)
    // god rays never run above half resolution
    expect(h.scale).toBeLessThanOrEqual(0.5)
    expect(l.scale).toBeLessThan(h.scale)
    const [sh, sl] = [1, 0.5].map(streakBudget)
    expect(sh.sx * sh.sy).toBeGreaterThan(sl.sx * sl.sy)
  })
})
