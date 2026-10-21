import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { mulberry32 } from '../src/engine/math'
import { groundLattice, TerrainDecal, DECAL_VERT, decalUniforms } from '../src/game/fx/decal'
import { CRACKS, crackLayout, crackOpen, crackPoint, FLY, keepOut, Levitation, OFF, RISE, WAIT } from '../src/game/fx/levitate'
import { boltDepth, displaceLine, Lightning, MAX_BOLTS } from '../src/game/fx/lightning'
import { idlePower } from '../src/game/player/power'

/** A tilted, bumpy ground with a pit, standing in for the terrain. */
const bumpy = {
  heightAt: (x: number, z: number) => 0.05 * x + Math.sin(z * 0.3) - (Math.hypot(x - 20, z) < 6 ? 3 : 0),
}

describe('lightning paths', () => {
  test('midpoint displacement keeps the endpoints and the point count', () => {
    const out = new Float32Array(1024 * 3)
    const a = new THREE.Vector3(1, 30, -2)
    const b = new THREE.Vector3(9, 0.5, 14)
    for (const depth of [2, 4, 6]) {
      const n = displaceLine(out, 3, a, b, depth, 0.3, mulberry32(depth))
      expect(n).toBe((1 << depth) + 1)
      expect([out[9], out[10], out[11]]).toEqual([a.x, a.y, a.z])
      const e = (3 + n - 1) * 3
      expect(out[e]).toBeCloseTo(b.x, 5)
      expect(out[e + 1]).toBeCloseTo(b.y, 5)
      expect(out[e + 2]).toBeCloseTo(b.z, 5)
    }
  })

  test('jaggedness scales with jag and the path stays near the line', () => {
    const out = new Float32Array(65 * 3)
    const a = new THREE.Vector3(0, 10, 0)
    const b = new THREE.Vector3(20, 10, 0)
    const dev = (jag: number) => {
      displaceLine(out, 0, a, b, 6, jag, mulberry32(4))
      let m = 0
      for (let i = 0; i < 65; i++) m = Math.max(m, Math.hypot(out[i * 3 + 1] - 10, out[i * 3 + 2]))
      return m
    }
    expect(dev(0)).toBeCloseTo(0, 5)
    expect(dev(0.1)).toBeLessThan(dev(0.3))
    // a fractal of halving offsets: bounded by about jag x length
    expect(dev(0.3)).toBeLessThan(0.3 * 20 * 1.5)
  })

  test('midpoints never dive through the ground', () => {
    const out = new Float32Array(65 * 3)
    const a = new THREE.Vector3(10, 0.2 + bumpy.heightAt(10, 0), 0)
    const b = new THREE.Vector3(30, 0.2 + bumpy.heightAt(30, 3), 3)
    for (let s = 0; s < 20; s++) {
      const n = displaceLine(out, 0, a, b, 6, 0.6, mulberry32(s), bumpy)
      for (let i = 1; i < n - 1; i++) expect(out[i * 3 + 1]).toBeGreaterThanOrEqual(bumpy.heightAt(out[i * 3], out[i * 3 + 2]))
    }
  })

  test('subdivision depth is bounded', () => {
    expect(boltDepth(0.1, true)).toBe(2)
    expect(boltDepth(5000, false)).toBe(6)
    expect(boltDepth(5000, true)).toBe(5)
    expect(boltDepth(10, false)).toBeGreaterThan(boltDepth(1, false))
  })
})

describe('Lightning pool', () => {
  const A = new THREE.Vector3(0, 20, 0)
  const B = new THREE.Vector3(4, 0, 3)

  test('bolts live for their life, then free their slot', () => {
    const L = new Lightning(null)
    const h = L.bolt(A, B, { life: 0.3 })
    expect(L.alive(h)).toBe(true)
    L.update(0.1)
    expect(L.count).toBe(1)
    expect(L.root.visible).toBe(true)
    expect(L.root.geometry.drawRange.count).toBeGreaterThan(0)
    for (let i = 0; i < 4; i++) L.update(0.1)
    expect(L.alive(h)).toBe(false)
    expect(L.count).toBe(0)
    expect(L.root.visible).toBe(false)
  })

  test('delayed bolts wait, and a leader takes `grow` seconds to land', () => {
    const L = new Lightning(null)
    const h = L.bolt(A, B, { delay: 0.2, grow: 0.1, life: 0.2 })
    L.update(0.1)
    expect(L.alive(h)).toBe(true)
    expect(L.root.visible).toBe(false)
    L.update(0.15)
    expect(L.root.visible).toBe(true)
    // delay 0.2 + grow 0.1 + life 0.2
    L.update(0.2)
    expect(L.alive(h)).toBe(true)
    L.update(0.06)
    expect(L.alive(h)).toBe(false)
  })

  test('handles go stale when a slot is reused; kill and move', () => {
    const L = new Lightning(null)
    const h = L.arc(A, B)
    L.kill(h)
    expect(L.alive(h)).toBe(false)
    const h2 = L.arc(A, B)
    expect(h2).not.toBe(h)
    expect(L.move(h, A, B)).toBe(false)
    expect(L.move(h2, new THREE.Vector3(1, 2, 3), B)).toBe(true)
    expect(L.alive(h2)).toBe(true)
  })

  test('a full pool steals the bolt nearest its end', () => {
    const L = new Lightning(null)
    const hs: number[] = []
    for (let i = 0; i < MAX_BOLTS; i++) {
      hs.push(L.bolt(A, B, { life: 1 }))
      L.update(0.001)
    }
    const fresh = L.bolt(A, B, { life: 1 })
    expect(L.alive(fresh)).toBe(true)
    expect(L.alive(hs[0])).toBe(false)
    expect(L.alive(hs[MAX_BOLTS - 1])).toBe(true)
  })

  test('a full storm of big bolts stays inside the vertex budget', () => {
    const L = new Lightning(null)
    for (let i = 0; i < MAX_BOLTS; i++) L.bolt(new THREE.Vector3(i, 80, 0), new THREE.Vector3(i * 2, 0, 30), { forks: 13 })
    L.update(0.01)
    const g = L.root.geometry
    const n = g.drawRange.count
    expect(n).toBeGreaterThan(0)
    const idx = g.index!.array
    const verts = (g.attributes.position as THREE.BufferAttribute).count
    let max = 0
    for (let i = 0; i < n; i++) max = Math.max(max, idx[i])
    expect(max).toBeLessThan(verts)
  })

  test('crawl chains bolts along the ground and re-seats them on ground carved since', () => {
    const ground = { h: 0, heightAt(x: number) {
      return x > 10 ? this.h : 0
    } }
    const L = new Lightning(null)
    L.ground = ground
    const t = L.crawl(new THREE.Vector3(0, 0, 0), new THREE.Vector3(90, 0, 0), 300, { hop: 10, height: 0.5 })
    expect(t).toBeCloseTo(0.3, 5)
    L.update(0)
    expect(L.count).toBe(9)
    // the ground drops 5 m before the front arrives
    ground.h = -5
    for (let i = 0; i < 40; i++) L.update(0.01)
    // the far links were born after the carve: their path dips below the old surface
    const pos = L.root.geometry.attributes.position as THREE.BufferAttribute
    let low = 0
    for (let i = 0; i < L.root.geometry.drawRange.count; i++) low = Math.min(low, pos.getY(L.root.geometry.index!.getX(i)))
    expect(low).toBeLessThan(-3)
  })

  test('storm and fan scale with quality, clear empties the pool', () => {
    const hi = new Lightning(null, 1)
    const lo = new Lightning(null, 0.5)
    hi.storm(new THREE.Vector3(), 8, 20, 0.5)
    lo.storm(new THREE.Vector3(), 8, 20, 0.5)
    hi.update(0)
    lo.update(0)
    expect(hi.count).toBe(8)
    expect(lo.count).toBe(6)
    hi.fan(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 1, 0), 4, 10)
    hi.update(0)
    expect(hi.count).toBe(12)
    hi.clear()
    expect(hi.count).toBe(0)
  })
})

describe('crack star', () => {
  test('layout: main cracks around the feet, branches off them', () => {
    const c = crackLayout(1234)
    expect(c.length).toBe(CRACKS)
    for (const k of c) {
      expect(Math.hypot(k.dx, k.dz)).toBeCloseTo(1, 5)
      expect(k.len).toBeGreaterThan(0.5)
      expect(k.width).toBeGreaterThan(0)
    }
    // main cracks start at the feet; branches start on a main crack
    for (let i = 0; i < 9; i++) expect(Math.hypot(c[i].ox, c[i].oz)).toBeLessThan(0.5)
    for (let i = 9; i < CRACKS; i++) expect(Math.hypot(c[i].ox, c[i].oz)).toBeGreaterThan(0.5)
    // deterministic per seed
    expect(crackLayout(1234)).toEqual(c)
    expect(crackLayout(99)).not.toEqual(c)
  })

  test('cracks open monotonically with power, up to their length', () => {
    for (const k of crackLayout(7)) {
      let last = 0
      for (let g = 0; g <= 1.0001; g += 0.05) {
        const o = crackOpen(k, g)
        expect(o).toBeGreaterThanOrEqual(last - 1e-9)
        expect(o).toBeLessThanOrEqual(k.len + 1e-9)
        last = o
      }
      expect(crackOpen(k, 0)).toBe(0)
      expect(crackOpen(k, 1)).toBeCloseTo(k.len, 9)
    }
  })

  test('a crack begins at its origin and runs along its direction', () => {
    const k = crackLayout(5)[2]
    const p = crackPoint(k, 0, { x: 0, z: 0 })
    expect(p.x).toBeCloseTo(k.ox, 6)
    expect(p.z).toBeCloseTo(k.oz, 6)
    crackPoint(k, k.len, p)
    const along = (p.x - k.ox) * k.dx + (p.z - k.oz) * k.dz
    expect(along).toBeCloseTo(k.len, 5)
  })
})

describe('levitation', () => {
  const ground = { tex: new THREE.Texture(), half: 260, heightAt: (x: number, z: number) => 2 + 0.02 * x + 0.01 * z }
  const centre = new THREE.Vector3(5, 2.1, -3)

  function run(L: Levitation, sec: number, power?: number) {
    for (let t = 0; t < sec; t += 1 / 60) {
      if (power !== undefined) L.setPower(power, centre, 1 / 60)
      L.update(1 / 60)
    }
  }

  test('rocks tear loose as power builds, from the ground, and rise above it', () => {
    const L = new Levitation(null, null, 1)
    L.setGround(ground)
    L.begin(centre)
    run(L, 0.5, 0.05)
    const few = L.aloft
    run(L, 1.5, 1)
    expect(L.aloft).toBeGreaterThan(few)
    expect(L.aloft).toBeGreaterThan(L.max * 0.8)
    let above = 0
    for (let i = 0; i < L.max; i++) {
      if (L.state[i] !== RISE) continue
      const k = i * 3
      if (L.pos[k + 1] > ground.heightAt(L.pos[k], L.pos[k + 2]) + 0.3) above++
    }
    expect(above).toBeGreaterThan(L.aloft * 0.9)
    expect(L.mesh.visible).toBe(true)
  })

  test('release along a direction sends everything down it; the rocks land on the ground and settle', () => {
    const L = new Levitation(null, null, 1)
    L.setGround(ground)
    run(L, 2, 1)
    const dir = new THREE.Vector3(1, 0, 0)
    L.release(dir)
    let fly = 0
    for (let i = 0; i < L.max; i++) {
      if (L.state[i] === WAIT || L.state[i] === RISE) throw new Error('rock left behind')
      if (L.state[i] !== FLY) continue
      fly++
      expect(L.vel[i * 3]).toBeGreaterThan(0)
    }
    expect(fly).toBeGreaterThan(L.max * 0.8)
    // a moment later: on (not under) the ground
    run(L, 1.5)
    for (let i = 0; i < L.max; i++) {
      if (L.state[i] !== FLY) continue
      const k = i * 3
      expect(L.pos[k + 1]).toBeGreaterThanOrEqual(ground.heightAt(L.pos[k], L.pos[k + 2]) - 1e-3)
    }
    run(L, 6)
    expect(L.active).toBe(false)
    expect(L.state.every((s) => s === OFF)).toBe(true)
  })

  test('nobody holding the power: the rocks drop', () => {
    const L = new Levitation(null, null, 1)
    L.setGround(ground)
    run(L, 1.5, 0.8)
    expect(L.aloft).toBeGreaterThan(0)
    run(L, 0.5)
    expect(L.aloft).toBe(0)
  })

  test('the cracks burn into the scorch map a stretch at a time, end to end', () => {
    const calls: number[][] = []
    const L = new Levitation(null, { fissure: (...a: number[]) => void calls.push(a) }, 1)
    L.setGround(ground)
    L.begin(centre)
    run(L, 2, 1)
    // every crack tore all the way open, in pieces
    for (let i = 0; i < CRACKS; i++) expect(L.opened[i]).toBeCloseTo(L.cracks[i].len, 5)
    expect(calls.length).toBeGreaterThan(CRACKS * 2)
    // every stroke is short and starts where a crack (or its previous stroke) left off
    for (const [x0, z0, x1, z1] of calls) expect(Math.hypot(x1 - x0, z1 - z0)).toBeLessThan(1.6)
    const starts = new Set(calls.map(([x0, z0]) => `${x0.toFixed(3)},${z0.toFixed(3)}`))
    const ends = new Set(calls.map(([, , x1, z1]) => `${x1.toFixed(3)},${z1.toFixed(3)}`))
    let chained = 0
    for (const s of starts) if (ends.has(s)) chained++
    expect(chained).toBeGreaterThan(calls.length - CRACKS * 2)
  })

  test('clear empties everything', () => {
    const L = new Levitation(null, null, 0.5)
    run(L, 1, 1)
    L.clear()
    expect(L.active).toBe(false)
    expect(L.mesh.visible).toBe(false)
  })

  test('keep-out pushes rocks off the camera line but not off the hero', () => {
    const eye = new THREE.Vector3(0, 3, -8)
    const hero = new THREE.Vector3(0, 0, 0)
    const p = new THREE.Vector3(0.2, 2, -4)
    expect(keepOut(p, eye, hero, 1.2, 1.5)).toBeGreaterThan(0)
    // now clear of the line (distance to the segment >= r)
    const seg = new THREE.Line3(eye, new THREE.Vector3(0, 1.2, 0))
    const q = new THREE.Vector3()
    seg.closestPointToPoint(p, true, q)
    expect(p.distanceTo(q)).toBeGreaterThanOrEqual(1.5 - 1e-6)
    // right by the hero: allowed
    const r = new THREE.Vector3(0.1, 1.2, -0.3)
    expect(keepOut(r, eye, hero, 1.2, 1.5)).toBe(0)
    // far off the line: untouched
    const s = new THREE.Vector3(6, 2, -4)
    expect(keepOut(s, eye, hero, 1.2, 1.5)).toBe(0)
  })
})

describe('decals and the idle simmer', () => {
  test('the decal grid sits on the ground mesh lattice', () => {
    const ground = new THREE.Group()
    ground.add(new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000)))
    ground.add(new THREE.Mesh(new THREE.PlaneGeometry(520, 520, 256, 256).rotateX(-Math.PI / 2)))
    const cell = groundLattice(ground, 260)
    expect(cell).toBeCloseTo(520 / 256, 9)
    const mat = new THREE.ShaderMaterial({ uniforms: decalUniforms(), vertexShader: DECAL_VERT, fragmentShader: 'void main() {}' })
    const d = new TerrainDecal(5, mat, cell)
    d.place(13.37, -7.7)
    expect(d.mesh.position.x / cell).toBeCloseTo(Math.round(d.mesh.position.x / cell), 9)
    expect(d.mesh.position.z / cell).toBeCloseTo(Math.round(d.mesh.position.z / cell), 9)
    expect(d.uniforms.uCenter.value.x).toBe(13.37)
    // every vertex lands on a lattice point
    const pos = d.mesh.geometry.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const x = (pos.getX(i) + d.mesh.position.x) / cell
      expect(Math.abs(x - Math.round(x))).toBeLessThan(1e-6)
    }
    // and covers the radius around the true centre
    d.mesh.geometry.computeBoundingBox()
    const bb = d.mesh.geometry.boundingBox!
    expect(bb.max.x + d.mesh.position.x).toBeGreaterThan(13.37 + 5)
    expect(bb.min.x + d.mesh.position.x).toBeLessThan(13.37 - 5)
  })

  test('the hero simmers at full Divinity or a rank of S and up', () => {
    expect(idlePower(0, 0)).toBe(0)
    expect(idlePower(99, 3)).toBe(0)
    expect(idlePower(100, 0)).toBeGreaterThan(0)
    expect(idlePower(0, 4)).toBeGreaterThan(0)
    expect(idlePower(0, 6)).toBeGreaterThan(idlePower(0, 4))
    // never more than a simmer
    expect(idlePower(100, 6)).toBeLessThanOrEqual(0.25)
  })
})
