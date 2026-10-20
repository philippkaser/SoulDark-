import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { insideZones } from '../../../shared/collision'
import { ARENA, BOXES, CIRCLES, FOG_GATE, GRAVEYARD, SHRINE, ZONES } from '../../../shared/level'
import { mulberry32, TAU } from '../../../shared/math'
import { triplanarMaterial } from '../gfx/triplanar'
import { barkTexture, blockStoneTexture, rockTexture } from '../gfx/textures'
import { STANCES } from '../rig/clips'
import { buildKnight } from '../rig/models'
import { applySpec } from '../rig/pose'

const rand = mulberry32(4242)
const rr = (a: number, b: number) => a + rand() * (b - a)

export interface Materials {
  stone: THREE.Material
  darkStone: THREE.Material
  rock: THREE.Material
  bark: THREE.Material
  iron: THREE.Material
  window: THREE.MeshStandardMaterial
}

export function makeMaterials(): Materials {
  return {
    stone: triplanarMaterial({ tex: blockStoneTexture(), scale: 0.26, tint: '#9b9a96', roughness: 0.95, bump: 2.2, moss: 0.8 }),
    darkStone: triplanarMaterial({ tex: blockStoneTexture(), scale: 0.18, tint: '#6d6a66', roughness: 1, bump: 1.6, moss: 0.3, grime: 0.4 }),
    rock: triplanarMaterial({ tex: rockTexture(), scale: 0.11, tint: '#8a857c', roughness: 1, bump: 3.0, moss: 0.9 }),
    bark: triplanarMaterial({ tex: barkTexture(), scale: 0.6, tint: '#6a5a4a', roughness: 1, bump: 2.5, moss: 0.4 }),
    iron: new THREE.MeshStandardMaterial({ color: '#2b2622', metalness: 0.8, roughness: 0.65 }),
    window: new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#ff7a2a', emissiveIntensity: 2.2, roughness: 1 }),
  }
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, shadows = true) {
  const m = new THREE.Mesh(geo, mat)
  m.castShadow = shadows
  m.receiveShadow = true
  return m
}

function clean(g: THREE.BufferGeometry) {
  let out = g.index ? g.toNonIndexed() : g
  for (const k of Object.keys(out.attributes)) if (k !== 'position' && k !== 'normal') out.deleteAttribute(k)
  return out
}

function merge(geos: THREE.BufferGeometry[]) {
  return mergeGeometries(geos.map(clean), false)!
}

// ---------------------------------------------------------------------------
// Pillars and arches
// ---------------------------------------------------------------------------

function fluted(r: number, h: number, broken: boolean, seed: number) {
  const g = new THREE.CylinderGeometry(r, r * 1.04, h, 32, Math.max(2, Math.round(h / 1.5)), false)
  const pos = g.attributes.position as THREE.BufferAttribute
  const rnd = mulberry32(seed)
  const jag = Array.from({ length: 40 }, () => rnd())
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const rad = Math.hypot(x, z)
    if (rad < 1e-4) continue
    const a = Math.atan2(x, z)
    const flute = 1 - 0.06 * Math.pow(0.5 + 0.5 * Math.cos(a * 16), 2)
    let k = flute
    let ny = y
    if (broken && y > h / 2 - 1e-3) {
      const j = jag[Math.floor(((a + Math.PI) / TAU) * 39)]
      ny = y - j * Math.min(1.4, h * 0.3)
      k *= 0.85 + j * 0.15
    }
    pos.setXYZ(i, x * k, ny, z * k)
  }
  g.computeVertexNormals()
  return g
}

export function pillarGeometry(r: number, h: number, broken: boolean, seed: number) {
  const parts: THREE.BufferGeometry[] = []
  const base = new THREE.BoxGeometry(r * 2.6, 0.5, r * 2.6)
  base.translate(0, 0.25, 0)
  const base2 = new THREE.CylinderGeometry(r * 1.25, r * 1.35, 0.4, 24)
  base2.translate(0, 0.7, 0)
  parts.push(base, base2)
  const shaftH = broken ? h - 0.9 : h - 2.1
  const shaft = fluted(r, shaftH, broken, seed)
  shaft.translate(0, 0.9 + shaftH / 2, 0)
  parts.push(shaft)
  if (!broken) {
    const neck = new THREE.CylinderGeometry(r * 1.08, r * 1.08, 0.18, 24)
    neck.translate(0, 0.9 + shaftH + 0.09, 0)
    const cap = new THREE.CylinderGeometry(r * 1.45, r * 1.06, 0.9, 24)
    cap.translate(0, 0.9 + shaftH + 0.18 + 0.45, 0)
    const abacus = new THREE.BoxGeometry(r * 3, 0.42, r * 3)
    abacus.translate(0, h - 0.21, 0)
    parts.push(neck, cap, abacus)
  }
  return merge(parts)
}

/** A wall section with a pointed (gothic) arch opening. */
export function archWall(span: number, rise: number, thick: number, depth: number, top = 0.7) {
  const wi = span / 2
  const wo = wi + thick
  const s = new THREE.Shape()
  s.moveTo(-wo, 0)
  s.lineTo(wo, 0)
  s.lineTo(wo, rise + top)
  s.lineTo(-wo, rise + top)
  s.closePath()
  const hole = new THREE.Path()
  hole.moveTo(-wi, 0)
  hole.lineTo(-wi, rise * 0.35)
  hole.quadraticCurveTo(-wi, rise * 0.92, 0, rise)
  hole.quadraticCurveTo(wi, rise * 0.92, wi, rise * 0.35)
  hole.lineTo(wi, 0)
  hole.closePath()
  s.holes.push(hole)
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 10 })
  g.translate(0, 0, -depth / 2)
  return g
}

function lancetWindow(w: number, h: number) {
  const s = new THREE.Shape()
  s.moveTo(-w / 2, 0)
  s.lineTo(-w / 2, h * 0.6)
  s.quadraticCurveTo(-w / 2, h * 0.95, 0, h)
  s.quadraticCurveTo(w / 2, h * 0.95, w / 2, h * 0.6)
  s.lineTo(w / 2, 0)
  s.closePath()
  return s
}

// ---------------------------------------------------------------------------
// Rocks, trees, graves
// ---------------------------------------------------------------------------

export function rockGeometry(seed: number, detail = 2) {
  const g = new THREE.IcosahedronGeometry(1, detail)
  const pos = g.attributes.position as THREE.BufferAttribute
  const r = mulberry32(seed)
  const lobes = Array.from({ length: 6 }, () => new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize())
  const amp = lobes.map(() => r() * 0.45)
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    let k = 1
    for (let j = 0; j < lobes.length; j++) k += Math.max(0, v.dot(lobes[j])) ** 3 * amp[j]
    k += (Math.sin(v.x * 7 + seed) * Math.sin(v.y * 6) * Math.sin(v.z * 8)) * 0.06
    v.multiplyScalar(k)
    if (v.y < -0.2) v.y = -0.2 - (v.y + 0.2) * 0.15
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  // flat-shaded facets read as chiselled stone
  const flat = g.index ? g.toNonIndexed() : g
  flat.computeVertexNormals()
  return flat
}

export function treeGeometry(seed: number) {
  const r = mulberry32(seed)
  const parts: THREE.BufferGeometry[] = []
  const up = new THREE.Vector3(0, 1, 0)
  const q = new THREE.Quaternion()
  const branch = (from: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number) => {
    const g = new THREE.CylinderGeometry(rad * 0.62, rad, len, depth > 2 ? 7 : 5, 1)
    g.translate(0, len / 2, 0)
    q.setFromUnitVectors(up, dir)
    g.applyQuaternion(q)
    g.translate(from.x, from.y, from.z)
    parts.push(g)
    if (depth === 0) return
    const end = from.clone().addScaledVector(dir, len)
    const n = depth > 2 ? 2 : 2 + Math.floor(r() * 2)
    for (let i = 0; i < n; i++) {
      const a = r() * TAU
      const tilt = 0.35 + r() * 0.6
      const nd = dir.clone()
      const side = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
      nd.addScaledVector(side, tilt).normalize()
      if (depth < 3) nd.y -= 0.15 * r()
      nd.normalize()
      branch(end, nd, len * (0.6 + r() * 0.2), rad * 0.62, depth - 1)
    }
  }
  const trunkDir = new THREE.Vector3((r() - 0.5) * 0.15, 1, (r() - 0.5) * 0.15).normalize()
  branch(new THREE.Vector3(0, -0.3, 0), trunkDir, 3.4 + r() * 1.5, 0.32, 4)
  // roots
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + r()
    branch(new THREE.Vector3(0, 0.4, 0), new THREE.Vector3(Math.cos(a), -0.35, Math.sin(a)).normalize(), 1.2, 0.18, 0)
  }
  return merge(parts)
}

function graveGeometry(kind: number) {
  if (kind === 0) {
    const s = new THREE.Shape()
    s.moveTo(-0.34, 0)
    s.lineTo(0.34, 0)
    s.lineTo(0.34, 0.75)
    s.absarc(0, 0.75, 0.34, 0, Math.PI, false)
    s.closePath()
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1, curveSegments: 10 })
    g.translate(0, -0.15, -0.08)
    return g
  }
  if (kind === 1) {
    const a = new THREE.BoxGeometry(0.16, 1.35, 0.16)
    a.translate(0, 0.52, 0)
    const b = new THREE.BoxGeometry(0.7, 0.15, 0.15)
    b.translate(0, 0.86, 0)
    const ring = new THREE.TorusGeometry(0.2, 0.035, 6, 16)
    ring.translate(0, 0.86, 0)
    const base = new THREE.BoxGeometry(0.45, 0.25, 0.4)
    base.translate(0, 0, 0)
    return merge([a, b, ring, base])
  }
  const o = new THREE.CylinderGeometry(0.12, 0.24, 1.6, 4)
  o.rotateY(Math.PI / 4)
  o.translate(0, 0.65, 0)
  const tip = new THREE.ConeGeometry(0.12 * 1.414, 0.25, 4)
  tip.rotateY(Math.PI / 4)
  tip.translate(0, 1.57, 0)
  const base = new THREE.BoxGeometry(0.55, 0.3, 0.55)
  return merge([o, tip, base])
}

// ---------------------------------------------------------------------------
// The level
// ---------------------------------------------------------------------------

export function buildArchitecture(m: Materials, quality: 'low' | 'medium' | 'high') {
  const root = new THREE.Group()
  root.name = 'architecture'

  // --- pillars from the shared collision data
  const pillarTops: Array<{ x: number; z: number; h: number; r: number; broken: boolean; ring: string }> = []
  for (const c of CIRCLES) {
    if (c.kind !== 'pillar' && c.kind !== 'brokenPillar') continue
    const broken = c.kind === 'brokenPillar'
    const h = c.h ?? 10
    const g = pillarGeometry(c.r * 0.82, h, broken, Math.floor(c.v * 1e6))
    const p = mesh(g, m.stone)
    p.position.set(c.x, 0, c.z)
    p.rotation.y = c.v * TAU
    root.add(p)
    const ring = Math.hypot(c.x - SHRINE.x, c.z - SHRINE.z) < 13 ? 'shrine' : Math.hypot(c.x - ARENA.x, c.z - ARENA.z) < 27 ? 'arena' : 'colonnade'
    pillarTops.push({ x: c.x, z: c.z, h, r: c.r, broken, ring })
    if (broken) {
      // fallen drum segments beside broken columns
      for (let i = 0; i < 2; i++) {
        const drum = mesh(new THREE.CylinderGeometry(c.r * 0.8, c.r * 0.8, rr(0.9, 1.6), 20), m.stone)
        const a = c.v * TAU + i * 1.7 + 0.6
        drum.position.set(c.x + Math.sin(a) * (c.r + 1.4 + i), c.r * 0.75, c.z + Math.cos(a) * (c.r + 1.4 + i))
        drum.rotation.set(Math.PI / 2, 0, a + rr(-0.4, 0.4))
        if (insideZones(drum.position.x, drum.position.z, -0.5)) continue
        root.add(drum)
      }
    }
  }

  // --- colonnade: arches across the nave and along each side
  const nave = pillarTops.filter((p) => p.ring === 'colonnade').sort((a, b) => a.z - b.z || a.x - b.x)
  const byZ = new Map<number, typeof nave>()
  for (const p of nave) byZ.set(p.z, [...(byZ.get(p.z) ?? []), p])
  for (const [z, row] of byZ) {
    if (row.length !== 2 || row.some((p) => p.broken)) continue
    const [l, r] = row
    const span = Math.abs(r.x - l.x) - 1.6
    const a = mesh(archWall(span, 4.6, 1.1, 1.0, 1.2), m.stone)
    a.position.set((l.x + r.x) / 2, Math.min(l.h, r.h) - 0.05, z)
    root.add(a)
  }
  for (const side of [-1, 1]) {
    const col = nave.filter((p) => Math.sign(p.x) === side).sort((a, b) => a.z - b.z)
    for (let i = 0; i < col.length - 1; i++) {
      const a = col[i]
      const b = col[i + 1]
      if (a.broken || b.broken) continue
      const span = Math.abs(b.z - a.z) - 1.6
      const g = mesh(archWall(span, 2.6, 0.8, 0.9, 0.9), m.stone)
      g.position.set(a.x, Math.min(a.h, b.h) - 0.05, (a.z + b.z) / 2)
      g.rotation.y = Math.PI / 2
      root.add(g)
    }
  }

  // --- shrine: broken entablature linking intact columns
  const shrineRing = pillarTops
    .filter((p) => p.ring === 'shrine')
    .sort((a, b) => Math.atan2(a.x - SHRINE.x, a.z - SHRINE.z) - Math.atan2(b.x - SHRINE.x, b.z - SHRINE.z))
  for (let i = 0; i < shrineRing.length; i++) {
    const a = shrineRing[i]
    const b = shrineRing[(i + 1) % shrineRing.length]
    if (a.broken || b.broken) continue
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len > 9) continue
    const beam = mesh(new THREE.BoxGeometry(1.2, 0.9, len + 1.6), m.stone)
    beam.position.set((a.x + b.x) / 2, Math.min(a.h, b.h) + 0.45, (a.z + b.z) / 2)
    beam.rotation.y = Math.atan2(b.x - a.x, b.z - a.z)
    root.add(beam)
  }

  // --- arena: towering ring with lintels and a crown of broken arches
  const arenaRing = pillarTops
    .filter((p) => p.ring === 'arena')
    .sort((a, b) => Math.atan2(a.x - ARENA.x, a.z - ARENA.z) - Math.atan2(b.x - ARENA.x, b.z - ARENA.z))
  for (let i = 0; i < arenaRing.length; i++) {
    const a = arenaRing[i]
    const b = arenaRing[(i + 1) % arenaRing.length]
    if (a.broken || b.broken) continue
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len > 12) continue
    const g = mesh(archWall(len - 2.2, 4.5, 1.1, 1.3, 1.6), m.stone)
    g.position.set((a.x + b.x) / 2, Math.min(a.h, b.h) - 0.1, (a.z + b.z) / 2)
    g.rotation.y = Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2
    root.add(g)
  }

  // --- perimeter walls hugging the walkable zones
  const wallGeos: THREE.BufferGeometry[] = []
  const rockSpots: Array<{ x: number; z: number; s: number; n: number }> = []
  const addWall = (x: number, z: number, nx: number, nz: number, len: number) => {
    const roll = rand()
    const yaw = Math.atan2(nx, nz)
    if (roll < 0.12) {
      rockSpots.push({ x: x + nx * 1.5, z: z + nz * 1.5, s: rr(1.4, 2.6), n: yaw })
      return
    }
    const h = roll < 0.3 ? rr(0.8, 1.8) : rr(3.5, 8.5)
    const g = new THREE.BoxGeometry(len + 0.35, h, 1.1, 1, 1, 1)
    // jagged ruined top
    const pos = g.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0) pos.setY(i, h / 2 - rand() * Math.min(1.6, h * 0.3))
    g.computeVertexNormals()
    g.translate(0, h / 2, 0)
    g.rotateY(yaw)
    g.translate(x, 0, z)
    wallGeos.push(g)
    if (h > 5 && rand() < 0.45) {
      // buttress
      const b = new THREE.BoxGeometry(0.9, h * 0.75, 1.6)
      b.translate(0, (h * 0.75) / 2, 1.2)
      b.rotateY(yaw)
      b.translate(x, 0, z)
      wallGeos.push(b)
    }
    if (rand() < 0.5) rockSpots.push({ x: x + nx * rr(3, 7), z: z + nz * rr(3, 7), s: rr(2.5, 6), n: yaw })
  }
  const step = 3.0
  for (const zone of ZONES) {
    if (zone.kind === 'circle') {
      const R = zone.r + 1.5
      const n = Math.ceil((TAU * R) / step)
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU
        const nx = Math.sin(a)
        const nz = Math.cos(a)
        const x = zone.x + nx * R
        const z = zone.z + nz * R
        if (insideZones(x, z, 1.4)) continue
        if (Math.abs(x - FOG_GATE.x) < 7 && Math.abs(z - FOG_GATE.z) < 4) continue
        addWall(x, z, nx, nz, (TAU * R) / n)
      }
    } else {
      const edges: Array<[number, number, number, number, number, number]> = [
        [zone.x0 - 1.5, zone.z0, zone.x0 - 1.5, zone.z1, -1, 0],
        [zone.x1 + 1.5, zone.z0, zone.x1 + 1.5, zone.z1, 1, 0],
      ]
      for (const [x0, z0, x1, z1, nx, nz] of edges) {
        const len = Math.hypot(x1 - x0, z1 - z0)
        const n = Math.ceil(len / step)
        for (let i = 0; i < n; i++) {
          const k = (i + 0.5) / n
          const x = x0 + (x1 - x0) * k
          const z = z0 + (z1 - z0) * k
          if (insideZones(x, z, 1.4)) continue
          if (Math.abs(x - FOG_GATE.x) < 7 && Math.abs(z - FOG_GATE.z) < 4) continue
          addWall(x, z, nx, nz, len / n)
        }
      }
    }
  }
  if (wallGeos.length) root.add(mesh(merge(wallGeos), m.stone))

  // --- lancet windows set into some tall walls along the colonnade
  for (const side of [-1, 1]) {
    for (const z of [-12.5, -20]) {
      const g = new THREE.ShapeGeometry(lancetWindow(1.3, 3.2))
      const w = mesh(g, m.window, false)
      w.position.set(side * 8.05, 3.2, z)
      w.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2
      root.add(w)
      const frame = mesh(archWall(1.3, 3.2, 0.35, 0.5, 0.6), m.stone)
      frame.position.set(side * 7.9, 3.2, z)
      frame.rotation.y = Math.PI / 2
      root.add(frame)
    }
  }

  // --- the fog gate: twin towers and a great arch
  {
    const gz = FOG_GATE.z
    for (const s of [-1, 1]) {
      const tower = mesh(new THREE.BoxGeometry(3.4, 15, 3.4), m.stone)
      tower.position.set(s * 5.3, 7.5, gz)
      root.add(tower)
      const roof = mesh(new THREE.ConeGeometry(2.9, 6, 4), m.darkStone)
      roof.position.set(s * 5.3, 18, gz)
      roof.rotation.y = Math.PI / 4
      root.add(roof)
      const ledge = mesh(new THREE.BoxGeometry(4, 0.6, 4), m.stone)
      ledge.position.set(s * 5.3, 15.2, gz)
      root.add(ledge)
      const wall = mesh(new THREE.BoxGeometry(10, 9, 1.6), m.stone)
      wall.position.set(s * 12, 4.5, gz)
      root.add(wall)
    }
    const arch = mesh(archWall(7.2, 8.2, 0.6, 2.0, 3.8), m.stone)
    arch.position.set(0, 0, gz)
    root.add(arch)
    const keystone = mesh(new THREE.BoxGeometry(1.2, 1.6, 2.2), m.darkStone)
    keystone.position.set(0, 8.4, gz)
    root.add(keystone)
  }

  // --- graveyard
  const graves = CIRCLES.filter((c) => c.kind === 'grave')
  const graveKinds = [0, 1, 2].map((k) => graveGeometry(k))
  graveKinds.forEach((geo, k) => {
    const list = graves.filter((_, i) => i % 3 === k)
    const inst = new THREE.InstancedMesh(geo, m.stone, list.length)
    const o = new THREE.Object3D()
    list.forEach((g, i) => {
      o.position.set(g.x, -0.05, g.z)
      o.rotation.set((g.rot ?? 0) * 0.4, Math.atan2(g.x - GRAVEYARD.x, g.z - GRAVEYARD.z) + (g.v - 0.5) * 0.8, g.rot ?? 0)
      o.scale.setScalar(0.9 + g.v * 0.4)
      o.updateMatrix()
      inst.setMatrixAt(i, o.matrix)
    })
    inst.castShadow = true
    inst.receiveShadow = true
    root.add(inst)
  })

  // statue of the old Warden, standing vigil
  {
    const statue = BOXES.find((b) => b.kind === 'statue')!
    const ped = mesh(new THREE.BoxGeometry(2.8, 1.5, 2.8), m.stone)
    ped.position.set(statue.x, 0.75, statue.z)
    ped.rotation.y = statue.rot
    root.add(ped)
    const ped2 = mesh(new THREE.BoxGeometry(3.4, 0.4, 3.4), m.stone)
    ped2.position.set(statue.x, 0.2, statue.z)
    ped2.rotation.y = statue.rot
    root.add(ped2)
    const model = buildKnight({
      arche: 'boss',
      armor: '#888',
      cloth: '#555',
      trim: '#777',
      eyes: null,
      eyeIntensity: 0,
      crest: 2,
      scale: 1.75,
      shield: null,
      great: true,
      bulk: 1.15,
      tatter: 1,
    })
    const pose = new Float32Array(STANCES.boss)
    applySpec(pose, {
      rootY: 0,
      spineX: 0.05,
      chestY: 0,
      headX: 0.35,
      thighLX: 0,
      thighRX: 0,
      kneeL: 0.02,
      kneeR: 0.02,
      lowerY: 0,
      thighLZ: 0.1,
      thighRZ: -0.1,
      twoHand: 1,
      handR: [-0.02, -0.02, 0.4],
      bladeR: [0, -1, 0.04],
      edgeR: [0, 0, 1],
      poleR: [-0.9, -0.3, 0],
      poleL: [0.9, -0.3, 0],
    })
    model.rig.apply(pose)
    model.rig.root.position.set(statue.x, 1.5, statue.z)
    model.rig.root.rotation.y = Math.PI + statue.rot
    model.rig.root.traverse((o) => {
      const mm = o as THREE.Mesh
      if (mm.isMesh) {
        mm.material = m.stone
        mm.castShadow = true
        mm.receiveShadow = true
      }
    })
    model.bladeFire?.removeFromParent()
    root.add(model.rig.root)
  }

  // dead trees
  for (const c of CIRCLES.filter((x) => x.kind === 'tree')) {
    const t = mesh(treeGeometry(Math.floor(c.v * 1e6)), m.bark)
    t.position.set(c.x, 0, c.z)
    t.rotation.y = c.v * TAU
    t.scale.setScalar(1.1 + c.v * 0.5)
    root.add(t)
  }
  // a few more trees outside the walls
  for (let i = 0; i < 14; i++) {
    const a = rand() * TAU
    const d = rr(20, 34)
    const x = Math.sin(a) * d
    const z = rr(-10, 30)
    if (insideZones(x, z, 3)) continue
    const t = mesh(treeGeometry(900 + i), m.bark)
    t.position.set(x, 0, z)
    t.scale.setScalar(rr(1.2, 2.2))
    root.add(t)
  }

  // arena stubs (low rubble)
  for (const c of CIRCLES.filter((x) => x.kind === 'stub')) {
    const r = mesh(rockGeometry(Math.floor(c.v * 1e5), 1), m.stone)
    r.position.set(c.x, 0, c.z)
    r.scale.set(c.r * 1.2, c.h ?? 0.8, c.r * 1.2)
    root.add(r)
  }

  // --- rocks and cliffs beyond the walls
  const rockGeos = [0, 1, 2, 3].map((i) => rockGeometry(100 + i, quality === 'low' ? 1 : 2))
  const rockBuckets: THREE.Matrix4[][] = [[], [], [], []]
  const o = new THREE.Object3D()
  const placeRock = (x: number, z: number, s: number, sy = 1, clearance = 0.9) => {
    // never let a rock intrude into walkable space (or the camera's)
    if (insideZones(x, z, s * clearance + 1.5)) return
    o.position.set(x, -s * 0.15, z)
    o.rotation.set(rr(-0.3, 0.3), rand() * TAU, rr(-0.3, 0.3))
    o.scale.set(s * rr(0.8, 1.3), s * sy * rr(0.7, 1.2), s * rr(0.8, 1.3))
    o.updateMatrix()
    rockBuckets[Math.floor(rand() * 4)].push(o.matrix.clone())
  }
  for (const r of rockSpots) placeRock(r.x, r.z, r.s, 1, 1.2)
  // cliffs: pushed outward from every zone boundary
  for (const zone of ZONES) {
    const pts: Array<[number, number, number, number]> = []
    if (zone.kind === 'circle') {
      const n = Math.ceil((TAU * zone.r) / 7)
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU
        pts.push([zone.x + Math.sin(a) * zone.r, zone.z + Math.cos(a) * zone.r, Math.sin(a), Math.cos(a)])
      }
    } else {
      for (let z = zone.z0; z <= zone.z1; z += 7) {
        pts.push([zone.x0, z, -1, 0], [zone.x1, z, 1, 0])
      }
    }
    for (const [bx, bz, nx, nz] of pts) {
      const north = bz < ARENA.z - ARENA.r * 0.6 && Math.abs(bx) < 20
      const sz = north ? rr(3, 6) : rr(7, 13)
      const d = sz * 1.7 + rr(3, 6)
      placeRock(bx + nx * d, bz + nz * d, sz, north ? rr(0.6, 1.0) : rr(1.2, 2.1), 1.6)
    }
  }
  // distant mountains (leaving the cathedral in view)
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * TAU + rr(-0.05, 0.05)
    if (Math.abs(Math.atan2(Math.sin(a - Math.PI), Math.cos(a - Math.PI))) < 0.4) continue
    const d = rr(170, 280)
    placeRock(Math.sin(a) * d, Math.cos(a) * d, rr(25, 55), rr(1.0, 2.4), 0.5)
  }
  rockBuckets.forEach((mats, i) => {
    if (!mats.length) return
    const inst = new THREE.InstancedMesh(rockGeos[i], m.rock, mats.length)
    mats.forEach((mx, j) => inst.setMatrixAt(j, mx))
    inst.castShadow = true
    inst.receiveShadow = true
    root.add(inst)
  })

  mergeByRegion(root)
  root.add(buildCathedral(m))
  return root
}

/** Merge plain static meshes per material and per area of the level. */
function mergeByRegion(root: THREE.Group) {
  const region = (z: number) => (z > 30 ? 0 : z > 12 ? 1 : z > -12 ? 2 : z > -36 ? 3 : 4)
  const groups = new Map<string, { mat: THREE.Material; meshes: THREE.Mesh[] }>()
  for (const c of [...root.children]) {
    const m = c as THREE.Mesh
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) continue
    if (m.children.length) continue
    const mat = m.material as THREE.Material
    m.updateMatrix()
    const key = `${mat.uuid}:${region(m.position.z)}:${m.castShadow}`
    if (!groups.has(key)) groups.set(key, { mat, meshes: [] })
    groups.get(key)!.meshes.push(m)
  }
  for (const { mat, meshes } of groups.values()) {
    if (meshes.length < 2) continue
    const geo = merge(meshes.map((m) => m.geometry.clone().applyMatrix4(m.matrix)))
    for (const m of meshes) root.remove(m)
    const merged = mesh(geo, mat, meshes[0].castShadow)
    root.add(merged)
  }
}

// ---------------------------------------------------------------------------
// The cathedral looming beyond the arena
// ---------------------------------------------------------------------------

function buildCathedral(m: Materials) {
  const g = new THREE.Group()
  const cz = -150
  const parts: THREE.BufferGeometry[] = []
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const b = new THREE.BoxGeometry(w, h, d)
    b.translate(x, y + h / 2, z)
    parts.push(b)
  }
  const cone = (r: number, h: number, x: number, y: number, z: number, sides = 8) => {
    const c = new THREE.ConeGeometry(r, h, sides)
    c.translate(x, y + h / 2, z)
    parts.push(c)
  }
  // nave and roof
  box(34, 38, 70, 0, 0, cz - 20)
  const roof = new THREE.CylinderGeometry(0.01, 24, 22, 4, 1)
  roof.rotateY(Math.PI / 4)
  roof.scale(1, 1, 2.1)
  roof.translate(0, 38 + 11, cz - 20)
  parts.push(roof)
  // facade towers with spires
  for (const s of [-1, 1]) {
    box(14, 72, 14, s * 22, 0, cz + 14)
    box(10, 14, 10, s * 22, 72, cz + 14)
    cone(7, 38, s * 22, 86, cz + 14)
    for (const t of [-1, 1]) cone(1.4, 14, s * 22 + t * 5, 72, cz + 14 + 5, 6)
    // flying buttresses along the nave
    for (let i = 0; i < 5; i++) {
      box(3, 30, 4, s * 26, 0, cz - 2 - i * 14)
      const fly = new THREE.BoxGeometry(10, 2, 2.5)
      fly.rotateZ(s * -0.55)
      fly.translate(s * 21.5, 30, cz - 2 - i * 14)
      parts.push(fly)
      cone(1.3, 10, s * 26, 30, cz - 2 - i * 14, 6)
    }
  }
  // central gable and crossing spire
  box(30, 18, 6, 0, 38, cz + 13)
  cone(5, 60, 0, 48, cz - 40, 8)
  box(20, 10, 20, 0, 38, cz - 40)
  const body = mesh(merge(parts), m.darkStone, false)
  g.add(body)

  // glowing windows: rose window and tall lancets
  const rose = mesh(new THREE.CircleGeometry(7, 40), m.window, false)
  rose.position.set(0, 44, cz + 16.1)
  g.add(rose)
  const rim = mesh(new THREE.TorusGeometry(7.3, 0.7, 8, 40), m.darkStone, false)
  rim.position.copy(rose.position)
  g.add(rim)
  for (const x of [-9, 0, 9]) {
    const w = mesh(new THREE.ShapeGeometry(lancetWindow(3, x === 0 ? 20 : 16)), m.window, false)
    w.position.set(x, 8, cz + 15.1)
    g.add(w)
  }
  for (const s of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const w = mesh(new THREE.ShapeGeometry(lancetWindow(3.4, 16)), m.window, false)
      w.position.set(s * 17.1, 12, cz - 5 - i * 14)
      w.rotation.y = s * (Math.PI / 2)
      g.add(w)
    }
    for (let k = 0; k < 4; k++) {
      const w = mesh(new THREE.ShapeGeometry(lancetWindow(2, 7)), m.window, false)
      w.position.set(s * 22, 20 + k * 13, cz + 21.1)
      g.add(w)
    }
  }
  // castle walls flanking it
  const wallParts: THREE.BufferGeometry[] = []
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const x = s * (45 + i * 22)
      const z = cz + 10 + i * 8
      const w = new THREE.BoxGeometry(22, 22, 6)
      w.translate(x, 11, z)
      wallParts.push(w)
      const t = new THREE.CylinderGeometry(5, 5.5, 34, 12)
      t.translate(x + s * 11, 17, z)
      wallParts.push(t)
      const r = new THREE.ConeGeometry(6.2, 14, 12)
      r.translate(x + s * 11, 41, z)
      wallParts.push(r)
    }
  }
  g.add(mesh(merge(wallParts), m.darkStone, false))
  return g
}

export { graveGeometry }
