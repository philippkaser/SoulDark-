import { describe, expect, test } from 'bun:test'
import { RANKS, Score } from '../src/game/score'

describe('style and score', () => {
  test('ranks climb from Dreadful to Skycleaver and the multiplier follows', () => {
    const s = new Score()
    expect(RANKS[s.rank].name).toBe('Dreadful')
    expect(s.mult).toBe(1)
    let rose = 0
    s.onRankUp = () => rose++
    for (let i = 0; i < 6; i++) s.parry(3)
    expect(RANKS[s.rank].letter).toBe('SSS')
    expect(s.mult).toBe(1 + (RANKS.length - 1) * 0.5)
    expect(rose).toBeGreaterThan(0)
    expect(s.tally.bestRank).toBe(RANKS.length - 1)
  })

  test('kills score more at higher ranks', () => {
    const low = new Score()
    low.kill('airship', 1)
    const high = new Score()
    for (let i = 0; i < 6; i++) high.parry(3)
    const before = high.points
    high.kill('airship', 1)
    expect(high.points - before).toBeGreaterThan(low.points)
  })

  test('getting hit drains style and breaks the chain', () => {
    const s = new Score()
    s.kill('soldier', 30)
    s.parry(2)
    expect(s.combo).toBe(31)
    const style = s.style
    s.hurt(120)
    expect(s.style).toBeLessThan(style)
    expect(s.combo).toBe(0)
    expect(s.tally.damageTaken).toBe(120)
  })

  test('the meter drains over time', () => {
    const s = new Score()
    s.parry(3)
    const r = s.rank
    for (let i = 0; i < 60 * 30; i++) s.update(1 / 60)
    expect(s.rank).toBeLessThan(r)
    expect(s.combo).toBe(0)
  })

  test('tallies count what was beaten', () => {
    const s = new Score()
    s.kill('soldier', 200)
    s.kill('archer', 50)
    s.kill('warhead', 1)
    s.kill('titan', 1)
    s.kill('moon', 1)
    expect(s.tally.soldiers).toBe(250)
    expect(s.tally.warheads).toBe(1)
    expect(s.tally.titans).toBe(1)
    expect(s.tally.moons).toBe(1)
  })

  test('repeated feed lines fold together', () => {
    const s = new Score()
    for (let i = 0; i < 6; i++) s.kill('spire', 1)
    expect(s.feed.length).toBe(1)
    expect(s.feed[0].text).toBe('Spire felled ×6')
    s.kill('airship', 1)
    expect(s.feed.length).toBe(2)
    // far apart in time, they stay separate
    for (let i = 0; i < 60 * 3; i++) s.update(1 / 60)
    s.kill('airship', 1)
    expect(s.feed[s.feed.length - 1].text).toBe('Airship downed')
  })

  test('reset starts a fresh run', () => {
    const s = new Score()
    s.kill('titan', 1)
    s.reset()
    expect(s.points).toBe(0)
    expect(s.rank).toBe(0)
    expect(s.feed.length).toBe(0)
    expect(s.tally.titans).toBe(0)
  })
})
