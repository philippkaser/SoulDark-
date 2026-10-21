import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { shapeBounds, shapeHitsCapsule, shapeHitsSphere, type Shape } from '../src/engine/geom'
import { ringAlpha, ringRadius, sideOf } from '../src/game/fx/punchFx'
import { eclipseHeading, ECLIPSE_AIM, headingGap, MAX_TILT, ringGap, WAVE_HALF, WAVE_R0, WAVE_RANGE, WAVE_SPEED, waveDir, waveRadius, waveReach } from '../src/game/player/punch'
import { partState } from '../src/game/world/sky'
import { SUN_DIR } from '../src/game/world/layout'

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const TAN = Math.tan(WAVE_HALF)

describe('the cone attack shape', () => {
  const cone: Shape = { t: 'cone', c: v(0, 1, 0), dir: v(0, 0, -1), tan: TAN, r0: WAVE_R0, d0: 100, d1: 120 }

  test('only the slice between d0 and d1 is struck', () => {
    expect(shapeHitsSphere(cone, 0, 1, -110, 0.5)).toBe(true)
    expect(shapeHitsSphere(cone, 0, 1, -50, 0.5)).toBe(false)
    expect(shapeHitsSphere(cone, 0, 1, -200, 0.5)).toBe(false)
    // behind the fist never
    expect(shapeHitsSphere({ ...cone, d0: 0 }, 0, 1, 20, 0.5)).toBe(false)
  })

  test('it widens with distance, and big targets poke in from outside the wall', () => {
    const r = WAVE_R0 + 110 * TAN
    expect(shapeHitsSphere(cone, r - 1, 1, -110, 0.5)).toBe(true)
    expect(shapeHitsSphere(cone, r + 3, 1, -110, 0.5)).toBe(false)
    expect(shapeHitsSphere(cone, r + 3, 1, -110, 4)).toBe(true)
    // the same lateral offset is out of reach much nearer the fist
    expect(shapeHitsSphere({ ...cone, d0: 10, d1: 12 }, r - 1, 1, -11, 0.5)).toBe(false)
  })

  test('tilted cones follow their axis upward', () => {
    const up = v(0, Math.sin(0.5), -Math.cos(0.5))
    const tilted: Shape = { ...cone, dir: up }
    expect(shapeHitsSphere(tilted, 0, 1 + 110 * Math.sin(0.5), -110 * Math.cos(0.5), 1)).toBe(true)
    // a soldier on the ground under the raised slice is spared
    expect(shapeHitsSphere(tilted, 0, 0, -110 * Math.cos(0.5), 0.6)).toBe(false)
  })

  test('capsules (giants) and bounds', () => {
    expect(shapeHitsCapsule(cone, v(5, 0, -110), v(5, 36, -110), 3)).toBe(true)
    expect(shapeHitsCapsule(cone, v(500, 0, -110), v(500, 36, -110), 3)).toBe(false)
    const [x0, z0, x1, z1] = shapeBounds(cone)
    const r = WAVE_R0 + 120 * TAN
    expect(x0).toBeCloseTo(-r)
    expect(x1).toBeCloseTo(r)
    expect(z0).toBeCloseTo(-120 - r)
    expect(z1).toBeCloseTo(-100 + r)
  })
})

describe('the Serious Punch wave', () => {
  test('a level or downward aim punches level; looking up tilts it, never past the limit', () => {
    const out = v(0, 0, 0)
    waveDir(v(0, -0.2, -1).normalize(), out)
    expect(out.y).toBe(0)
    expect(out.length()).toBeCloseTo(1)
    waveDir(v(0, 0.25, -1).normalize(), out)
    expect(out.y).toBeGreaterThan(0.2)
    expect(out.z).toBeLessThan(0)
    waveDir(v(0, 5, -1).normalize(), out)
    expect(Math.asin(out.y)).toBeCloseTo(MAX_TILT)
    // aimed straight at something (gain 1, no bias), the direction is kept exactly
    waveDir(v(3, 1, -4).normalize(), out, 1, 0)
    expect(out.distanceTo(v(3, 1, -4).normalize())).toBeCloseTo(0)
  })

  test('the kill zone widens to ~20 degrees, and reaches three kilometres in a few seconds', () => {
    expect(waveRadius(0)).toBe(WAVE_R0)
    expect(waveRadius(1000)).toBeCloseTo(WAVE_R0 + 1000 * TAN)
    expect(WAVE_RANGE / WAVE_SPEED).toBeGreaterThan(3)
    expect(WAVE_RANGE / WAVE_SPEED).toBeLessThan(3.6)
  })

  test('targets are swept at their distance down the axis, or never', () => {
    const o = v(0, 1.4, 0)
    const d = v(0, 0, -1)
    expect(waveReach(o, d, v(0, 30, -400), 20)).toBeCloseTo(380)
    expect(waveReach(o, d, v(0, 30, 400), 20)).toBe(-1)
    expect(waveReach(o, d, v(0, 30, -4000), 20)).toBe(-1)
    // the Sol Lance hangs too high for a level punch, but not for one thrown up at it
    const lance = v(160, 480, -320)
    expect(waveReach(o, d, lance, 40)).toBe(-1)
    const up = waveDir(lance.clone().sub(o).normalize(), v(0, 0, 0), 1, 0)
    expect(waveReach(o, up, lance, 40)).toBeGreaterThan(0)
  })

  test('the eclipse is hit by heading alone', () => {
    expect(eclipseHeading(v(SUN_DIR.x, 0, SUN_DIR.z))).toBeCloseTo(0)
    expect(eclipseHeading(v(Math.sin(Math.PI - 0.1), 0, Math.cos(Math.PI - 0.1)))).toBeLessThan(ECLIPSE_AIM)
    expect(eclipseHeading(v(1, 0, 0))).toBeGreaterThan(ECLIPSE_AIM)
    expect(headingGap(v(0, 5, -1), v(0, 0, -1))).toBeCloseTo(0)
    expect(headingGap(v(0, 0, 1), v(0, 0, -1))).toBeCloseTo(Math.PI)
  })

  test('the ring corridor thins out toward the horizon', () => {
    expect(ringGap(100)).toBeLessThan(ringGap(800))
    expect(ringGap(800)).toBeLessThan(ringGap(2000))
  })
})

describe('pressure rings', () => {
  test('radius eases out from r0 to r1 and alpha snaps on, then fades to nothing', () => {
    expect(ringRadius(1, 5, 0)).toBe(1)
    expect(ringRadius(1, 5, 1)).toBe(5)
    expect(ringRadius(1, 5, 0.5)).toBeGreaterThan(3)
    expect(ringAlpha(0)).toBe(0)
    expect(ringAlpha(1)).toBe(0)
    expect(ringAlpha(0.1)).toBeGreaterThan(ringAlpha(0.6))
  })

  test('sideOf is horizontal and perpendicular', () => {
    const s = sideOf(v(0.3, 0.5, -1).normalize(), v(0, 0, 0))
    expect(s.y).toBe(0)
    expect(s.length()).toBeCloseTo(1)
    expect(s.x * 0.3 + s.z * -1).toBeCloseTo(0)
    // facing north, the right-hand side is east
    expect(sideOf(v(0, 0, -1), v(0, 0, 0)).x).toBeCloseTo(1)
  })
})

describe('the atmosphere split', () => {
  test('it tears out to the horizon over ~1.5 s, behind the hero too', () => {
    const a = partState(0.2)
    const b = partState(1.5)
    expect(a.reach).toBeLessThan(b.reach)
    expect(b.reach).toBeGreaterThan(6.25)
    expect(b.back).toBeGreaterThan(0)
    expect(b.back).toBeLessThan(b.reach)
    expect(partState(0).ring).toBe(0)
    expect(partState(3).ring).toBeGreaterThan(1)
  })

  test('the walls blaze when fresh, and the deck heals over ~90 s', () => {
    expect(partState(0.1).glow).toBeGreaterThan(partState(10).glow)
    expect(partState(20).width).toBeGreaterThan(0.3)
    expect(partState(60).width).toBeLessThan(partState(20).width)
    expect(partState(90).on).toBe(0)
    expect(partState(80).on).toBe(1)
  })
})
