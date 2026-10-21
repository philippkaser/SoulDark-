import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { CameraRig, dollyEnvelope, dollyMove, dollyScale } from '../src/game/camera'

const DEG = Math.PI / 180

function rig() {
  const r = new CameraRig()
  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.25, 6000)
  const subject = { pos: new THREE.Vector3(0, 0, 0), framing: 0 }
  r.snap(subject.pos, Math.PI)
  const step = (sec: number) => {
    for (let i = 0; i < Math.round(sec * 60); i++) r.update(1 / 60, 0, 0, subject, cam, true)
  }
  // settle the follow lag
  step(3)
  return { r, cam, step }
}

/** How tall something at the look point appears (screen heights per metre). */
const apparent = (r: CameraRig, cam: THREE.PerspectiveCamera) => 1 / (2 * cam.position.distanceTo(r.look) * Math.tan((cam.fov / 2) * DEG))

describe('dolly-zoom math', () => {
  test('envelope rises fast to full, then eases home', () => {
    expect(dollyEnvelope(0)).toBe(0)
    expect(dollyEnvelope(0.3)).toBeCloseTo(1)
    expect(dollyEnvelope(0.15)).toBeGreaterThan(0.7)
    expect(dollyEnvelope(0.65)).toBeCloseTo(0.5)
    expect(dollyEnvelope(1)).toBe(0)
    let prev = 0
    for (let u = 0.01; u <= 0.3; u += 0.01) {
      expect(dollyEnvelope(u)).toBeGreaterThanOrEqual(prev)
      prev = dollyEnvelope(u)
    }
  })

  test('the distance factor keeps a subject the same size', () => {
    expect(dollyScale(62, 62)).toBeCloseTo(1)
    const k = dollyScale(62, 90)
    expect(k).toBeLessThan(1)
    // size ~ 1 / (d tan(fov/2)): unchanged after scaling d by k
    expect(10 * Math.tan(31 * DEG)).toBeCloseTo(10 * k * Math.tan(45 * DEG))
  })

  test('widening moves in, narrowing pulls back, never through the subject', () => {
    expect(dollyMove(62, 85, 6.5)).toBeGreaterThan(0)
    expect(dollyMove(62, 45, 6.5)).toBeLessThan(0)
    expect(dollyMove(62, 150, 6.5)).toBeLessThanOrEqual(6.5 - 1.2)
    // far subjects: only the first DOLLY_SUBJECT metres count
    expect(dollyMove(62, 85, 400)).toBeCloseTo(dollyMove(62, 85, 14))
  })
})

describe('camera rig dolly-zoom', () => {
  test('the lens widens and the camera moves in, the subject keeps its size', () => {
    const { r, cam, step } = rig()
    const fov0 = cam.fov
    const size0 = apparent(r, cam)
    const d0 = cam.position.distanceTo(r.look)
    r.dolly(20, 1)
    step(0.3)
    expect(cam.fov).toBeGreaterThan(fov0 + 19)
    expect(cam.position.distanceTo(r.look)).toBeLessThan(d0 - 1)
    expect(apparent(r, cam)).toBeCloseTo(size0, 2)
    step(0.8)
    expect(r.dollyAmount).toBe(0)
    expect(cam.fov).toBeCloseTo(fov0, 1)
    expect(cam.position.distanceTo(r.look)).toBeCloseTo(d0, 1)
  })

  test('a weaker dolly never cuts a stronger one short; a stronger one takes over smoothly', () => {
    const { r, step } = rig()
    r.dolly(24, 1.5)
    step(0.45)
    const peak = r.dollyAmount
    r.dolly(10, 1)
    step(1 / 60)
    expect(r.dollyAmount).toBeGreaterThan(peak - 1)
    step(0.9)
    const low = r.dollyAmount
    r.dolly(30, 1)
    // restarts from where it was, no pop
    expect(r.dollyAmount).toBeCloseTo(low, 3)
    step(0.3)
    expect(r.dollyAmount).toBeCloseTo(30, 0)
  })

  test('never dips under the ground', () => {
    const { r, cam, step } = rig()
    r.ground = { heightAt: () => 2 }
    step(1)
    r.dolly(-25, 1)
    for (let i = 0; i < 60; i++) {
      step(1 / 60)
      expect(cam.position.y).toBeGreaterThanOrEqual(2.44)
    }
  })

  test('kickFrom punches the camera away from the blast', () => {
    const { r, cam, step } = rig()
    step(1 / 60)
    const z0 = cam.position.z
    // blast in front (north, -z) of a camera looking north: pushed back toward +z
    r.kickFrom(new THREE.Vector3(0, 0, -50), 0.8)
    step(1 / 60)
    expect(cam.position.z).toBeGreaterThan(z0 + 0.3)
    step(1)
    expect(cam.position.z).toBeCloseTo(z0, 1)
  })
})
