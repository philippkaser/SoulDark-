import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { shapeBounds, shapeContact, shapeHitsCapsule, shapeHitsSphere, type Shape } from '../src/engine/geom'
import { discState, ringAlpha, ringRadius, sideOf } from '../src/game/fx/swordFx'
import { BLADE_MAX, bladeLength, discNormal, eclipseHeading, ECLIPSE_AIM, headingGap, IAI_HALF, IAI_MAX_TILT, IAI_RANGE, lineOffset } from '../src/game/player/arts'
import { partState } from '../src/game/world/sky'
import { SUN_DIR } from '../src/game/world/layout'

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const TAN = Math.tan((20 * Math.PI) / 180)
const R0 = 8

describe('the disc attack shape', () => {
  const disc: Shape = { t: 'disc', c: v(0, 1.4, 0), n: v(0, 1, 0), r: IAI_RANGE, h: IAI_HALF }

  test('everything in the plane out to the reach is cut, nothing above or beyond it', () => {
    expect(shapeHitsSphere(disc, 0, 1, -50, 0.6)).toBe(true)
    expect(shapeHitsSphere(disc, 300, 0.5, 200, 0.6)).toBe(true)
    // a soldier on lower ground is still inside the thickness
    expect(shapeHitsSphere(disc, 100, -1.5, 0, 0.6)).toBe(true)
    expect(shapeHitsSphere(disc, 0, 30, -50, 0.6)).toBe(false)
    expect(shapeHitsSphere(disc, 0, 1, -(IAI_RANGE + 5), 0.6)).toBe(false)
    // a giant's legs poke through it
    expect(shapeHitsCapsule(disc, v(200, 0, 0), v(200, 30, 0), 3)).toBe(true)
    expect(shapeHitsCapsule(disc, v(200, 20, 0), v(200, 40, 0), 3)).toBe(false)
  })

  test('a disc tilted up the aim passes through what the hero looks at', () => {
    const n = discNormal(v(0, 0.5, -1).normalize(), v(0, 0, 0))
    const tilted: Shape = { ...disc, n }
    // the plane rises ahead of him and dips behind him
    const ahead = -300
    const hAhead = 1.4 - (ahead * n.z) / n.y
    expect(hAhead).toBeGreaterThan(80)
    expect(shapeHitsSphere(tilted, 0, hAhead, ahead, 4)).toBe(true)
    expect(shapeHitsSphere(tilted, 0, 1, ahead, 0.6)).toBe(false)
    const [x0, z0, x1, z1] = shapeBounds(tilted)
    expect(x0).toBeCloseTo(-IAI_RANGE)
    expect(z1).toBeCloseTo(IAI_RANGE)
    expect(x1 - x0).toBeCloseTo(2 * IAI_RANGE)
    expect(z1 - z0).toBeCloseTo(2 * IAI_RANGE)
  })

  test('contact lies on the plane', () => {
    const out = shapeContact(disc, v(10, 6, 3), v(0, 0, 0))
    expect(out.y).toBeCloseTo(1.4)
    expect(out.x).toBeCloseTo(10)
  })
})

describe('the Iai', () => {
  test('a level or downward aim cuts level; looking up tilts the plane, never past the limit', () => {
    const out = v(0, 0, 0)
    discNormal(v(0, -0.3, -1).normalize(), out)
    expect(out.y).toBeCloseTo(1)
    discNormal(v(0, 0.02, -1).normalize(), out)
    expect(out.y).toBeCloseTo(1)
    discNormal(v(0, 0.3, -1).normalize(), out)
    expect(out.y).toBeLessThan(0.99)
    // tilted about the side axis: the normal leans back toward the hero (+z when aiming -z)
    expect(out.z).toBeGreaterThan(0)
    expect(out.x).toBeCloseTo(0)
    expect(out.length()).toBeCloseTo(1)
    discNormal(v(0, 5, -1).normalize(), out)
    expect(Math.acos(out.y)).toBeCloseTo(IAI_MAX_TILT)
    // aimed straight at something (gain 1, no bias), the aim lies in the plane
    const aim = v(3, 1, -4).normalize()
    discNormal(aim, out, 1, 0, 1.3)
    expect(aim.dot(out)).toBeCloseTo(0)
  })
})

describe('the Worldsplitter', () => {
  test('the blade climbs past the clouds as it charges', () => {
    expect(bladeLength(0)).toBeLessThan(10)
    expect(bladeLength(0.5)).toBeLessThan(BLADE_MAX * 0.3)
    expect(bladeLength(1)).toBeCloseTo(BLADE_MAX + 5)
    expect(bladeLength(2)).toBe(bladeLength(1))
  })

  test('targets are found by their distance from the line and how far along it they are', () => {
    const o = lineOffset(v(0, 0, 0), v(0, 0, -1), v(12, 400, -900))
    expect(o.along).toBeCloseTo(900)
    expect(o.off).toBeCloseTo(12)
    expect(lineOffset(v(0, 0, 0), v(0, 0, -1), v(0, 0, 50)).along).toBeLessThan(0)
  })

  test('the eclipse is cut by heading alone', () => {
    expect(eclipseHeading(v(SUN_DIR.x, 0, SUN_DIR.z))).toBeCloseTo(0)
    expect(eclipseHeading(v(Math.sin(Math.PI - 0.1), 0, Math.cos(Math.PI - 0.1)))).toBeLessThan(ECLIPSE_AIM)
    expect(eclipseHeading(v(1, 0, 0))).toBeGreaterThan(ECLIPSE_AIM)
    expect(headingGap(v(0, 5, -1), v(0, 0, -1))).toBeCloseTo(0)
    expect(headingGap(v(0, 0, 1), v(0, 0, -1))).toBeCloseTo(Math.PI)
  })
})

describe('the cone attack shape', () => {
  const cone: Shape = { t: 'cone', c: v(0, 1, 0), dir: v(0, 0, -1), tan: TAN, r0: R0, d0: 100, d1: 120 }

  test('only the slice between d0 and d1 is struck', () => {
    expect(shapeHitsSphere(cone, 0, 1, -110, 0.5)).toBe(true)
    expect(shapeHitsSphere(cone, 0, 1, -50, 0.5)).toBe(false)
    expect(shapeHitsSphere(cone, 0, 1, -200, 0.5)).toBe(false)
    // behind the apex never
    expect(shapeHitsSphere({ ...cone, d0: 0 }, 0, 1, 20, 0.5)).toBe(false)
  })

  test('it widens with distance, and big targets poke in from outside the wall', () => {
    const r = R0 + 110 * TAN
    expect(shapeHitsSphere(cone, r - 1, 1, -110, 0.5)).toBe(true)
    expect(shapeHitsSphere(cone, r + 3, 1, -110, 0.5)).toBe(false)
    expect(shapeHitsSphere(cone, r + 3, 1, -110, 4)).toBe(true)
    // the same lateral offset is out of reach much nearer the apex
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
    const r = R0 + 120 * TAN
    expect(x0).toBeCloseTo(-r)
    expect(x1).toBeCloseTo(r)
    expect(z0).toBeCloseTo(-120 - r)
    expect(z1).toBeCloseTo(-100 + r)
  })
})

describe('shock rings and the Iai\'s ring of light', () => {
  test('radius eases out from r0 to r1 and alpha snaps on, then fades to nothing', () => {
    expect(ringRadius(1, 5, 0)).toBe(1)
    expect(ringRadius(1, 5, 1)).toBe(5)
    expect(ringRadius(1, 5, 0.5)).toBeGreaterThan(3)
    expect(ringAlpha(0)).toBe(0)
    expect(ringAlpha(1)).toBe(0)
    expect(ringAlpha(0.1)).toBeGreaterThan(ringAlpha(0.6))
  })

  test('the cut races out, hangs as a hairline until the sheathe, blazes and is gone', () => {
    expect(discState(0, 0.16, -1, 0.5).r).toBe(0)
    expect(discState(0.16, 0.16, -1, 0.5).r).toBeCloseTo(1)
    expect(discState(0.08, 0.16, -1, 0.5).a).toBe(1)
    const hang = discState(0.6, 0.16, -1, 0.5).a
    expect(hang).toBeGreaterThan(0.25)
    expect(hang).toBeLessThan(0.5)
    const blaze = discState(0.62, 0.16, 0.6, 0.5).a
    expect(blaze).toBeGreaterThan(1)
    expect(discState(1.1, 0.16, 0.6, 0.5).a).toBe(0)
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
