import { describe, expect, test } from 'bun:test'
import { angleDiff, mulberry32, turnToward, wrapAngle } from '../src/engine/math'
import { DEFAULT_SETTINGS, loadSave } from '../src/state/settings'

describe('save data', () => {
  test('without storage the game starts from defaults', () => {
    const s = loadSave()
    expect(s.settings).toEqual(DEFAULT_SETTINGS)
    expect(s.reached).toBe(0)
    expect(s.victories).toBe(0)
  })
})

describe('math', () => {
  test('angles wrap and turn the short way round', () => {
    expect(wrapAngle(2.5 * Math.PI)).toBeCloseTo(0.5 * Math.PI)
    expect(wrapAngle(-2.5 * Math.PI)).toBeCloseTo(-0.5 * Math.PI)
    expect(angleDiff(0.1, -0.1)).toBeCloseTo(-0.2)
    expect(angleDiff(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2)
    expect(turnToward(0, 1, 0.25)).toBeCloseTo(0.25)
    expect(turnToward(0, 0.1, 0.25)).toBeCloseTo(0.1)
  })

  test('seeded random is deterministic', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 5; i++) expect(a()).toBe(b())
  })
})
