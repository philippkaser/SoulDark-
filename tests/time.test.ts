import { describe, expect, test } from 'bun:test'
import { TimeCtl } from '../src/game/time'

const run = (t: TimeCtl, sec: number, dt = 1 / 60) => {
  let w = 0
  let p = 0
  for (let i = 0; i < Math.round(sec / dt); i++) {
    const [a, b] = t.update(dt)
    w += a
    p += b
  }
  return [w, p]
}

describe('two clocks', () => {
  test('normal time runs both clocks at full speed', () => {
    const [w, p] = run(new TimeCtl(), 1)
    expect(w).toBeCloseTo(1)
    expect(p).toBeCloseTo(1)
  })

  test('hitstop freezes everything briefly', () => {
    const t = new TimeCtl()
    t.freeze(0.1)
    const [w, p] = run(t, 0.1)
    expect(w).toBeLessThan(0.01)
    expect(p).toBeLessThan(0.01)
    // one frame of slack for the freeze running out mid-frame
    const [w2] = run(t, 0.5)
    expect(w2).toBeGreaterThan(0.48)
  })

  test('divine time slows the world but not the hero', () => {
    const t = new TimeCtl()
    t.divine(1, 0.2)
    expect(t.divineActive).toBe(true)
    const [w, p] = run(t, 0.5)
    expect(p).toBeCloseTo(0.5)
    expect(w).toBeCloseTo(0.1, 1)
    run(t, 1)
    expect(t.divineActive).toBe(false)
    expect(t.world).toBe(1)
  })

  test('a weaker divine time never overrides a deeper one', () => {
    const t = new TimeCtl()
    t.divine(1, 0.1)
    t.divine(2, 0.5)
    run(t, 0.2)
    expect(t.world).toBeCloseTo(0.1)
  })

  test('time stop halts the world; the hero keeps moving', () => {
    const t = new TimeCtl()
    t.stop(true)
    const [w, p] = run(t, 1)
    expect(w).toBe(0)
    expect(p).toBeCloseTo(1)
    t.stop(false)
    expect(run(t, 1)[0]).toBeCloseTo(1)
  })

  test('slowmo slows both, and reset clears everything', () => {
    const t = new TimeCtl()
    t.slowmo(1, 0.25)
    const [w, p] = run(t, 0.5)
    expect(w).toBeCloseTo(0.125)
    expect(p).toBeCloseTo(0.125)
    t.freeze(5)
    t.stop(true)
    t.reset()
    expect(run(t, 1)[0]).toBeCloseTo(1)
  })
})
