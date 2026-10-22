import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { climbRate } from '../src/game/enemies/projectiles'
import { CameraRig } from '../src/game/camera'
import { Feel, flashChain, FLASH_CHAIN, killShot, rumbleFalloff, slashHitstop, type KillCamStyle } from '../src/game/feel'
import { coneAlpha } from '../src/game/fx/sonicBoom'
import type { Game } from '../src/game/Game'
import { TimeCtl } from '../src/game/time'
import { emptyFrame, mergeRumble, RUMBLE_GAP, type Rumble } from '../src/input/input'
import { DEFAULT_SETTINGS } from '../src/state/settings'
import { useUI } from '../src/state/store'

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const idle = (): Rumble => ({ strong: 0, weak: 0, until: 0, sent: -1e9 })

describe('controller vibration merging', () => {
  test('nothing to play is not sent', () => {
    expect(mergeRumble(idle(), 0, 0, 100, 0)).toBeNull()
    expect(mergeRumble(idle(), 0.5, 0.5, 0, 0)).toBeNull()
  })

  test('an idle pad plays the request as asked, clamped', () => {
    const r = mergeRumble(idle(), 1.6, -1, 99999, 1000)!
    expect(r.strong).toBe(1)
    expect(r.weak).toBe(0)
    expect(r.until).toBe(1000 + 5000)
  })

  test('a weaker request under a live buzz adds nothing', () => {
    const cur = mergeRumble(idle(), 0.8, 0.6, 400, 0)!
    expect(mergeRumble(cur, 0.3, 0.2, 100, 100)).toBeNull()
  })

  test('a stronger one goes through at once and keeps the later end', () => {
    const cur = mergeRumble(idle(), 0.3, 0.3, 400, 0)!
    const next = mergeRumble(cur, 0.9, 0.1, 50, 5)!
    expect(next.strong).toBeCloseTo(0.9)
    expect(next.weak).toBeCloseTo(0.3)
    expect(next.until).toBe(400)
  })

  test('a longer one of the same strength is rate-limited, then extends', () => {
    const cur = mergeRumble(idle(), 0.4, 0.4, 100, 0)!
    expect(mergeRumble(cur, 0.4, 0.4, 300, RUMBLE_GAP / 2)).toBeNull()
    const later = mergeRumble(cur, 0.4, 0.4, 300, RUMBLE_GAP + 5)!
    expect(later.until).toBe(RUMBLE_GAP + 5 + 300)
  })

  test('a hundred hits in a frame make one buzz', () => {
    let cur = idle()
    let sent = 0
    for (let i = 0; i < 100; i++) {
      const r = mergeRumble(cur, 0.3, 0.4, 90, 1000)
      if (r) {
        cur = r
        sent++
      }
    }
    expect(sent).toBe(1)
  })

  test('on by default', () => {
    expect(DEFAULT_SETTINGS.vibration).toBe(true)
  })

  test('falloff with distance', () => {
    expect(rumbleFalloff(0, 100)).toBe(1)
    expect(rumbleFalloff(100, 100)).toBe(0)
    expect(rumbleFalloff(500, 100)).toBe(0)
    expect(rumbleFalloff(25, 100)).toBeGreaterThan(rumbleFalloff(50, 100))
  })
})

describe('hit feel', () => {
  test('slash hitstop grows with what the swing cuts down, capped', () => {
    expect(slashHitstop(0, false)).toBe(0)
    expect(slashHitstop(5, false)).toBeGreaterThan(slashHitstop(1, false))
    expect(slashHitstop(500, false)).toBe(slashHitstop(40, false))
    expect(slashHitstop(500, false)).toBeLessThanOrEqual(0.1)
    expect(slashHitstop(500, true)).toBeLessThanOrEqual(0.15)
    expect(slashHitstop(3, true)).toBeGreaterThan(slashHitstop(3, false))
  })

  test('flash-steps chain only inside the window', () => {
    const t: number[] = []
    expect(flashChain(t, 0)).toBe(1)
    expect(flashChain(t, 0.5)).toBe(2)
    expect(flashChain(t, 1.1)).toBe(3)
    const slow: number[] = []
    flashChain(slow, 0)
    flashChain(slow, FLASH_CHAIN * 0.8)
    expect(flashChain(slow, FLASH_CHAIN * 1.6)).toBe(2)
    expect(slow.length).toBe(2)
  })

  test('the vapor cone snaps on, rides along, and fades once released', () => {
    expect(coneAlpha(0, -1, 0.2)).toBe(0)
    expect(coneAlpha(0.03, -1, 0.2)).toBe(1)
    expect(coneAlpha(0.16, -1, 0.2)).toBe(1)
    expect(coneAlpha(0.2, 0.16, 0.2)).toBeLessThan(1)
    expect(coneAlpha(0.4, 0.16, 0.2)).toBe(0)
  })
})

describe('kill cam shots', () => {
  const hero = v(0, 0, 0)
  const target = v(0, 16, -90)
  const styles: KillCamStyle[] = ['low', 'orbit', 'behind', 'crane']
  for (const style of styles) {
    test(`${style}: a sane lens, aimed at the kill`, () => {
      const shot = killShot(style, hero, target, 36, 1.5)
      const pos = new THREE.Vector3()
      const look = new THREE.Vector3()
      for (let t = 0; t <= 1.5; t += 0.1) {
        const fov = shot.frame(t, pos, look)
        expect(fov).toBeGreaterThan(15)
        expect(fov).toBeLessThan(70)
        // the kill is in front of the lens, near the middle
        const toT = target.clone().sub(pos).normalize()
        const dir = look.clone().sub(pos).normalize()
        expect(dir.angleTo(toT)).toBeLessThan(0.6)
        if (style !== 'orbit') {
          // filmed from the hero's side of the fight, close to him
          expect(pos.distanceTo(hero)).toBeLessThan(20)
          expect(pos.clone().sub(hero).dot(target.clone().sub(hero))).toBeLessThan(0)
        }
      }
    })
  }

  test('orbit circles the target at a fixed range and follows it as it falls', () => {
    const live = target.clone()
    const shot = killShot('orbit', hero, live, 40, 1.4)
    const pos = new THREE.Vector3()
    const look = new THREE.Vector3()
    shot.frame(0.2, pos, look)
    const r0 = Math.hypot(pos.x - live.x, pos.z - live.z)
    live.y -= 30
    shot.frame(1, pos, look)
    expect(Math.hypot(pos.x - live.x, pos.z - live.z)).toBeCloseTo(r0, 5)
    expect(look.y).toBeCloseTo(live.y)
  })
})

describe('returned weapons climb clear of the ground', () => {
  test('flat ground with room to spare needs no climb', () => {
    const flat = { heightAt: () => 0 }
    expect(climbRate(v(0, 40, 0), v(200, 0, 0), flat, 20)).toBeLessThan(0)
  })

  test('a warhead batted back at chest height clears a crater rim ahead', () => {
    // a rim 6 m high, 30-60 m out: the old straight return flew into it
    const rim = { heightAt: (x: number) => (x > 30 && x < 60 ? 6 : 0) }
    const pos = v(0, 1.5, 0)
    const vel = v(240, 19, 0)
    const dt = 1 / 60
    for (let i = 0; i < 60; i++) {
      const need = climbRate(pos, vel, rim, 22)
      if (vel.y < need) vel.y = Math.min(need, vel.length() * 0.85)
      pos.addScaledVector(vel, dt)
      expect(pos.y).toBeGreaterThan(rim.heightAt(pos.x))
    }
    expect(pos.y).toBeGreaterThan(15)
  })
})

describe('time', () => {
  test('a skipped kill cam hands time back at once', () => {
    const t = new TimeCtl()
    t.slowmo(2, 0.3)
    expect(t.update(1 / 60)[1]).toBeCloseTo(0.3 / 60)
    t.cancelSlowmo()
    expect(t.update(1 / 60)[1]).toBeCloseTo(1 / 60)
  })
})

/** Just enough of a Game for the kill cam. */
function fakeGame() {
  const cam = new CameraRig()
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.25, 6000)
  const pos = v(0, 0, 0)
  const g = {
    mode: 'sandbox',
    cam,
    camera,
    time: new TimeCtl(),
    player: { state: 'free', pos, invuln: 0, alive: true, chestPos: (o: THREE.Vector3) => o.set(pos.x, pos.y + 1.3, pos.z) },
    post: { kickChroma() {} },
  }
  const feel = new Feel(g as unknown as Game)
  const subject = { pos, framing: 0 }
  cam.snap(pos, Math.PI)
  const step = (sec: number, press = false) => {
    const n = Math.max(1, Math.round(sec * 60))
    for (let i = 0; i < n; i++) {
      const f = emptyFrame()
      if (press && i === 0) f.slash = true
      const [, pdt] = g.time.update(1 / 60)
      feel.update(1 / 60, pdt, f, true)
      cam.update(1 / 60, 0, 0, subject, camera, true)
    }
  }
  return { g, feel, cam, step }
}

describe('kill cams', () => {
  test('play with bars and slow motion, end on their own', () => {
    const { g, feel, cam, step } = fakeGame()
    expect(feel.killCam(v(0, 16, -90), { style: 'crane', size: 36, dur: 1.2 })).toBe(true)
    step(0.1)
    expect(cam.cinematic).toBe(true)
    expect(useUI.getState().letterbox).toBe(true)
    expect(g.time.player).toBeLessThan(0.5)
    expect(g.player.invuln).toBeGreaterThan(1)
    step(1.6)
    expect(feel.killCamActive).toBe(false)
    expect(useUI.getState().letterbox).toBe(false)
  })

  test('any press skips one and gives time back', () => {
    const { g, feel, cam, step } = fakeGame()
    feel.killCam(v(0, 16, -90), { style: 'low', size: 36, dur: 1.5 })
    step(0.4)
    step(1 / 60, true)
    expect(feel.killCamActive).toBe(false)
    expect(cam.cinematic).toBe(false)
    expect(useUI.getState().letterbox).toBe(false)
    step(1 / 60)
    expect(g.time.player).toBe(1)
  })

  test('never over another cinematic, a scripted hero, or right after the last', () => {
    const { g, feel, cam, step } = fakeGame()
    cam.play({ dur: 3, blendIn: 0.2, blendOut: 0.2, frame: (_t, p, l) => (p.set(0, 5, 10), l.set(0, 0, 0), 60) })
    expect(feel.killCam(v(0, 16, -90), { style: 'behind', size: 60 })).toBe(false)
    cam.stopShot()
    g.player.state = 'cine'
    expect(feel.killCam(v(0, 16, -90), { style: 'behind', size: 60 })).toBe(false)
    g.player.state = 'free'
    expect(feel.killCam(v(0, 16, -90), { style: 'behind', size: 60, dur: 1 })).toBe(true)
    step(1.5)
    expect(feel.killCam(v(0, 16, -90), { style: 'behind', size: 60 })).toBe(false)
  })

  test('a shot that replaces ours ends it without a skip', () => {
    const { feel, cam, step } = fakeGame()
    feel.killCam(v(0, 16, -90), { style: 'orbit', size: 40, dur: 1.5 })
    step(0.3)
    cam.play({ dur: 5, blendIn: 0.2, blendOut: 0.2, frame: (_t, p, l) => (p.set(0, 5, 10), l.set(0, 0, 0), 60) })
    step(0.2)
    expect(feel.killCamActive).toBe(false)
    expect(cam.cinematic).toBe(true)
  })

  test('a delayed kill cam waits, then plays', () => {
    const { feel, cam, step } = fakeGame()
    expect(feel.killCam(v(0, 16, -90), { style: 'crane', size: 36, delay: 0.3 })).toBe(true)
    step(0.1)
    expect(cam.cinematic).toBe(false)
    step(0.3)
    expect(cam.cinematic).toBe(true)
    expect(feel.killCamActive).toBe(true)
  })
})
