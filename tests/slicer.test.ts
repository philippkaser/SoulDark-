import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { Slicer } from '../src/game/fx/slicer'

function tower(h = 40) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(4, h, 4), new THREE.MeshStandardMaterial())
  m.position.set(0, h / 2, 0)
  const g = new THREE.Group()
  g.add(m)
  return g
}

describe('slicer', () => {
  test('a vertical cut makes two clipped halves that topple and crash', () => {
    const s = new Slicer()
    const t = tower()
    let crashes = 0
    s.slice([t], new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 20, 0)), {
      topple: true,
      life: 30,
      onCrash: () => crashes++,
    })
    expect(s.count).toBe(1)
    expect(t.visible).toBe(false)
    expect(s.root.children.length).toBe(2)
    // each half's materials clip against opposite sides of the cut
    const planes = s.root.children.map((pivot) => {
      let n = 0
      pivot.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined
        if (m?.clippingPlanes?.length) n = m.clippingPlanes[0].normal.x
      })
      return n
    })
    expect(planes.sort()).toEqual([-1, 1])
    for (let i = 0; i < 60 * 20; i++) s.update(1 / 60)
    expect(crashes).toBe(2)
  })

  test('a horizontal cut leaves the stump standing', () => {
    const s = new Slicer()
    const t = tower()
    s.slice([t], new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0.2, 1, 0).normalize(), new THREE.Vector3(0, 12, 0)), {
      staticBelow: true,
      life: 30,
    })
    const start = s.root.children.map((p) => p.position.clone())
    for (let i = 0; i < 60; i++) s.update(1 / 60)
    const moved = s.root.children.map((p, i) => p.position.distanceTo(start[i]))
    expect(Math.min(...moved)).toBe(0)
    expect(Math.max(...moved)).toBeGreaterThan(0.5)
  })

  test('halves dissolve after their life and the oldest cut makes room', () => {
    const s = new Slicer()
    s.max = 2
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)
    s.slice([tower()], plane, { life: 1 })
    s.slice([tower()], plane, { life: 1 })
    s.slice([tower()], plane, { life: 1 })
    expect(s.count).toBe(2)
    for (let i = 0; i < 60 * 4; i++) s.update(1 / 60)
    expect(s.count).toBe(0)
    expect(s.root.children.length).toBe(0)
  })
})
