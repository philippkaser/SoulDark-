import { describe, expect, test } from 'bun:test'
import { Room } from '../shared/room'
import type { EnemySnap, ServerMsg } from '../shared/protocol'

/** Drive a Room with a fake clock so the simulation is deterministic and fast. */
function harness() {
  let now = 0
  const room = new Room({ name: 'test', now: () => now, random: (() => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647) })() })
  const inbox: ServerMsg[] = []
  room.connect('p1', (m) => inbox.push(m))
  room.handle('p1', { t: 'join', name: 'Tester', look: { cloak: 0, crest: 0 } })
  const place = (x: number, z: number, hp = 400) =>
    room.handle('p1', { t: 'st', x, y: 0, z, yaw: 0, vx: 0, vz: 0, hp, mhp: 400, a: '', as: 0, lk: -1, sp: false })
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 30) {
      now += 1000 / 30
      room.tick()
    }
  }
  const lastSnap = () => [...inbox].reverse().find((m) => m.t === 'snap') as Extract<ServerMsg, { t: 'snap' }>
  const enemy = (id: number) => lastSnap().e.find((e) => e.id === id) as EnemySnap
  return { room, inbox, place, step, lastSnap, enemy, get now() { return now } }
}

describe('room simulation', () => {
  test('welcome carries world state', () => {
    const h = harness()
    const w = h.inbox.find((m) => m.t === 'welcome')
    expect(w).toBeTruthy()
    h.step(0.2)
    expect(h.lastSnap().e.length).toBe(9)
  })

  test('hollows wake, chase and attack a nearby player', () => {
    const h = harness()
    // enemy 1 sits on the road at (3.5, 24)
    h.place(3.5, 21)
    h.step(0.5)
    expect(h.enemy(1).s).toBe('wake')
    const seen = new Set<string>()
    for (let i = 0; i < 120; i++) {
      h.place(3.5, 21)
      h.step(0.1)
      seen.add(h.enemy(1).s)
    }
    expect(seen.has('chase') || seen.has('strafe')).toBe(true)
    expect(seen.has('attack')).toBe(true)
  })

  test('hits damage, flinch and kill an enemy and award souls', () => {
    const h = harness()
    h.place(3.5, 22.5)
    h.step(0.5)
    h.room.handle('p1', { t: 'hit', id: 1, dmg: 60, poise: 10, atk: 'light1' })
    h.step(0.1)
    expect(h.enemy(1).hp).toBe(80)
    expect(h.enemy(1).s).toBe('hurt')
    h.room.handle('p1', { t: 'hit', id: 1, dmg: 90, poise: 10, atk: 'light2' })
    h.step(0.1)
    expect(h.enemy(1).s).toBe('dead')
    const kill = h.inbox.find((m) => m.t === 'kill')
    expect(kill && kill.t === 'kill' && kill.by.includes('p1')).toBe(true)
  })

  test('out-of-range hits are rejected', () => {
    const h = harness()
    h.place(0, 40)
    h.step(0.2)
    h.room.handle('p1', { t: 'hit', id: 1, dmg: 60, poise: 10, atk: 'light1' })
    h.step(0.1)
    expect(h.enemy(1).hp).toBe(140)
  })

  test('the boss wakes when a player enters the arena and resets when they leave', () => {
    const h = harness()
    h.place(0, -40)
    h.step(0.3)
    expect(h.lastSnap().w.boss).toBe(1)
    expect(h.enemy(9).s).toBe('intro')
    h.step(4)
    expect(['chase', 'attack', 'recover', 'strafe']).toContain(h.enemy(9).s)
    // flee through the fog
    h.place(0, -20)
    h.step(6)
    expect(h.lastSnap().w.boss).toBe(0)
    expect(h.enemy(9).s).toBe('dormant')
  })

  test('boss enters phase two at half health and can be defeated', () => {
    const h = harness()
    h.place(0, -45)
    h.step(4)
    const boss = () => h.enemy(9)
    const max = boss().mhp
    // keep the player glued to the boss and hammer it
    let phased = false
    for (let i = 0; i < 400 && boss().s !== 'dead'; i++) {
      const b = boss()
      h.place(b.x, b.z + 2)
      h.room.handle('p1', { t: 'hit', id: 9, dmg: 120, poise: 20, atk: 'heavy' })
      h.step(0.2)
      if (h.enemy(9).ph === 2) phased = true
    }
    expect(phased).toBe(true)
    expect(boss().s).toBe('dead')
    expect(h.lastSnap().w.fog).toBe(false)
    expect(max).toBeGreaterThan(0)
  })

  test('parry then riposte', () => {
    const h = harness()
    h.place(3.5, 22.6)
    h.step(0.2)
    let parried = false
    for (let i = 0; i < 600 && !parried; i++) {
      h.place(3.5, 22.6)
      h.step(1 / 30)
      const e = h.enemy(1)
      if (e.s === 'attack' && (h.now - e.ss) / 1000 > 0.55) {
        h.room.handle('p1', { t: 'parry', id: 1 })
        h.step(1 / 30)
        parried = h.enemy(1).s === 'parried'
      }
    }
    expect(parried).toBe(true)
    h.room.handle('p1', { t: 'riposte', id: 1, dmg: 300 })
    h.step(0.1)
    expect(h.enemy(1).s).toBe('riposted')
    h.step(3)
    expect(h.enemy(1).s).toBe('dead')
  })

  test('messages are validated and persisted', () => {
    const h = harness()
    h.place(0, 40)
    h.room.handle('p1', { t: 'msg', x: 0, z: 38, text: 'Praise the Sun!' })
    h.room.handle('p1', { t: 'msg', x: 0, z: 38, text: 'arbitrary text <script>' })
    const adds = h.inbox.filter((m) => m.t === 'msgs' && m.add)
    expect(adds.length).toBe(1)
  })
})
