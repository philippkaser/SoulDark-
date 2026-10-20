import { describe, expect, test } from 'bun:test'
import { PLAYER, PLAYER_ACTIONS, BASE_STATS, ALL_ENEMY_ATTACKS } from '../shared/combat'
import type { ClientMsg } from '../shared/protocol'
import type { InputFrame } from '../src/input/input'
import { PlayerController } from '../src/game/player/controller'
import { EnemyView, world } from '../src/game/world'

const frame = (p: Partial<InputFrame> = {}): InputFrame => ({
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  sprint: false,
  roll: false,
  light: false,
  heavy: false,
  parry: false,
  lock: false,
  estus: false,
  interact: false,
  gesture: false,
  compose: false,
  menu: false,
  chat: false,
  switchTarget: 0,
  usingGamepad: false,
  ...p,
})

function make() {
  world.enemies.clear()
  world.flags = { fog: true, boss: 0 }
  const sent: ClientMsg[] = []
  const p = new PlayerController(BASE_STATS, {
    send: (m) => sent.push(m),
    serverNow: () => 0,
    onActionChange: () => {},
    onDeath: () => {},
    onHeal: () => {},
  })
  // open space on the road, facing north (camera yaw PI = forward is -z)
  p.teleport(0, 25, Math.PI)
  const run = (seconds: number, f: Partial<InputFrame> = {}, first: Partial<InputFrame> = {}) => {
    const dt = 1 / 60
    let t = 0
    let i = 0
    while (t < seconds - 1e-9) {
      p.update(dt, frame(i === 0 ? { ...f, ...first } : f), Math.PI, 0, true)
      t += dt
      i++
    }
  }
  return { p, run, sent }
}

describe('player controller', () => {
  test('runs at full speed toward camera-forward', () => {
    const { p, run } = make()
    run(1.5, { moveY: 1 })
    const z0 = p.z
    run(1, { moveY: 1 })
    expect(z0 - p.z).toBeGreaterThan(PLAYER.runSpeed * 0.95)
    expect(z0 - p.z).toBeLessThan(PLAYER.runSpeed * 1.05)
  })

  test('sprinting is faster and drains stamina', () => {
    const { p, run } = make()
    run(2, { moveY: 1, sprint: true })
    expect(p.stamina).toBeLessThan(p.maxStamina)
    const z0 = p.z
    run(0.5, { moveY: 1, sprint: true })
    expect((z0 - p.z) / 0.5).toBeGreaterThan(PLAYER.runSpeed + 1)
  })

  test('roll travels ~4.7m, costs stamina and grants i-frames', () => {
    const { p, run } = make()
    const z0 = p.z
    const st0 = p.stamina
    run(1 / 60, { moveY: 1 }, { roll: true })
    expect(p.action).toBe('roll')
    expect(p.stamina).toBeCloseTo(st0 - PLAYER_ACTIONS.roll.stamina!, 0)
    run(0.2, { moveY: 1 })
    expect(p.invulnerable).toBe(true)
    run(0.6)
    expect(p.action).toBe(null)
    expect(z0 - p.z).toBeGreaterThan(4.2)
    expect(z0 - p.z).toBeLessThan(5.6)
  })

  test('backstep when rolling with no direction', () => {
    const { p, run } = make()
    run(1 / 60, {}, { roll: true })
    expect(p.action).toBe('backstep')
  })

  test('buffered light attacks chain into a combo', () => {
    const { p, run } = make()
    run(1 / 60, {}, { light: true })
    expect(p.action).toBe('light1')
    run(0.2, {}, { light: true })
    // still in light1 before the combo window, the input is buffered
    expect(p.action).toBe('light1')
    run(0.2)
    expect(p.action).toBe('light2')
    run(0.35, {}, { light: true })
    run(0.2)
    expect(p.action).toBe('light3')
  })

  test('attacks are locked in until their cancel window', () => {
    const { p, run } = make()
    run(1 / 60, {}, { heavy: true })
    expect(p.action).toBe('heavy')
    run(0.2, { moveY: 1 }, { roll: true })
    expect(p.action).toBe('heavy')
    // pressed too early: the buffer (0.42 s) expires before the cancel window
    run(0.6, { moveY: 1 })
    expect(p.action).toBe('heavy')
    // pressed just before the cancel window: it comes out as soon as allowed
    run(0.3, { moveY: 1 }, { roll: true })
    expect(p.action).toBe('roll')
  })

  test('stamina regenerates after a short delay', () => {
    const { p, run } = make()
    run(1 / 60, { moveY: 1 }, { roll: true })
    run(0.6)
    const low = p.stamina
    expect(low).toBeLessThan(p.maxStamina - 15)
    run(1.5)
    expect(p.stamina).toBe(p.maxStamina)
  })

  test('estus heals once and uses a flask', () => {
    const { p, run } = make()
    p.hp = 100
    run(1 / 60, {}, { estus: true })
    expect(p.flasks).toBe(PLAYER.maxFlasks - 1)
    run(0.5)
    expect(p.hp).toBe(100)
    run(0.5)
    expect(p.hp).toBeGreaterThan(100 + p.maxHp * 0.4)
  })

  test('rolling through an enemy attack dodges it, parrying deflects it', () => {
    const { p, run, sent } = make()
    const e = new EnemyView(1, 'hollow')
    e.x = 0
    e.z = 23.5
    world.enemies.set(1, e)
    const atk = ALL_ENEMY_ATTACKS.h_slash
    run(1 / 60, { moveY: 1 }, { roll: true })
    run(0.1)
    expect(p.receiveHit(e, atk.hits[0], atk)).toBe('dodged')
    run(1)
    // face the enemy and parry
    p.yaw = Math.PI
    run(1 / 60, {}, { parry: true })
    run(0.1)
    expect(p.receiveHit(e, atk.hits[0], atk)).toBe('parried')
    expect(sent.some((m) => m.t === 'parry')).toBe(true)
  })

  test('taking lethal damage kills the player', () => {
    const { p } = make()
    const e = new EnemyView(9, 'boss')
    const atk = ALL_ENEMY_ATTACKS.b_cleave
    p.hp = 10
    expect(p.receiveHit(e, atk.hits[0], atk)).toBe('killed')
    expect(p.dead).toBe(true)
    expect(p.action).toBe('death')
  })
})
