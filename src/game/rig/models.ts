import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CLOAK_COLORS, type Look } from '../../../shared/protocol'
import { standard } from '../gfx/materials'
import {
  armorTextures,
  clothTextures,
  emberCrackTexture,
  shieldFaceTexture,
  skinTextures,
  tatteredAlpha,
} from '../gfx/textures'
import { Cape, type Capsule } from './cape'
import type { Archetype } from './clips'
import { HUMAN_DIMS, Rig } from './rig'
import { SwordTrail } from './trail'

export interface CharacterModel {
  arche: Archetype
  rig: Rig
  /** Identity-transform group: holds the rig plus world-space cloth and trails. */
  container: THREE.Group
  materials: THREE.MeshStandardMaterial[]
  swordBase: THREE.Object3D
  swordTip: THREE.Object3D
  flask: THREE.Object3D | null
  cape: Cape | null
  flapFront: THREE.Object3D | null
  flapBack: THREE.Object3D | null
  bladeFire: THREE.Mesh | null
  glowMats: THREE.MeshStandardMaterial[]
  trail: SwordTrail
  scale: number
}

type Mat = THREE.Material

function add(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: Mat,
  p: [number, number, number] = [0, 0, 0],
  r: [number, number, number] = [0, 0, 0],
  s: [number, number, number] = [1, 1, 1],
) {
  const m = new THREE.Mesh(geo, mat)
  m.position.set(...p)
  m.rotation.set(...r)
  m.scale.set(...s)
  m.castShadow = true
  m.receiveShadow = true
  parent.add(m)
  return m
}

/** Tube along a curve whose radius tapers from r0 to r1. */
function taperTube(points: THREE.Vector3[], r0: number, r1: number, seg = 16, radial = 8) {
  const curve = new THREE.CatmullRomCurve3(points)
  const geo = new THREE.TubeGeometry(curve, seg, 1, radial, false)
  const pos = geo.attributes.position as THREE.BufferAttribute
  const c = new THREE.Vector3()
  const v = new THREE.Vector3()
  for (let i = 0; i <= seg; i++) {
    const t = i / seg
    curve.getPointAt(t, c)
    const r = r0 + (r1 - r0) * t
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j
      v.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c)
      pos.setXYZ(k, v.x, v.y, v.z)
    }
  }
  geo.computeVertexNormals()
  return geo
}

/** Sword blade with a diamond cross-section. +Z runs from guard to tip, edges along ±Y. */
export function bladeGeometry(len: number, width: number, thick: number) {
  const rings = [
    { z: 0, w: width, t: thick },
    { z: len * 0.82, w: width * 0.82, t: thick * 0.9 },
    { z: len, w: 0.002, t: 0.002 },
  ]
  const pos: number[] = []
  const uv: number[] = []
  const quad = (a: number[], b: number[], c: number[], d: number[], v0: number, v1: number) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d)
    uv.push(0, v0, 1, v0, 1, v1, 0, v0, 1, v1, 0, v1)
  }
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i]
    const B = rings[i + 1]
    const ca = [
      [0, A.w, A.z],
      [A.t, 0, A.z],
      [0, -A.w, A.z],
      [-A.t, 0, A.z],
    ]
    const cb = [
      [0, B.w, B.z],
      [B.t, 0, B.z],
      [0, -B.w, B.z],
      [-B.t, 0, B.z],
    ]
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4
      quad(ca[k], ca[k2], cb[k2], cb[k], A.z / len, B.z / len)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.computeVertexNormals()
  return g
}

function heaterShape(w: number, h: number) {
  const s = new THREE.Shape()
  const top = h * 0.44
  s.moveTo(-w, top)
  s.lineTo(w, top)
  s.lineTo(w, h * 0.08)
  s.quadraticCurveTo(w * 0.96, -h * 0.32, 0, -h * 0.56)
  s.quadraticCurveTo(-w * 0.96, -h * 0.32, -w, h * 0.08)
  s.closePath()
  return s
}

/** Merge each joint's direct mesh children by material to cut draw calls. */
function mergeStatic(root: THREE.Object3D) {
  const joints: THREE.Object3D[] = []
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) joints.push(o)
  })
  for (const j of joints) {
    const byMat = new Map<THREE.Material, THREE.Mesh[]>()
    for (const c of j.children) {
      const m = c as THREE.Mesh
      if (!m.isMesh || m.userData.keep || c.children.length) continue
      const mat = m.material as THREE.Material
      if (!byMat.has(mat)) byMat.set(mat, [])
      byMat.get(mat)!.push(m)
    }
    for (const [mat, meshes] of byMat) {
      if (meshes.length < 2) continue
      const geos = meshes.map((m) => {
        m.updateMatrix()
        let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()
        g = g.applyMatrix4(m.matrix)
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name)
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
        return g
      })
      const merged = mergeGeometries(geos, false)
      if (!merged) continue
      for (const m of meshes) j.remove(m)
      const mm = new THREE.Mesh(merged, mat)
      mm.castShadow = true
      mm.receiveShadow = true
      j.add(mm)
    }
  }
}

// ---------------------------------------------------------------------------
// Knights (player, phantoms, Fallen Knight, the Warden)
// ---------------------------------------------------------------------------

interface KnightOpts {
  arche: Archetype
  armor: string
  cloth: string
  trim: string
  eyes: string | null
  eyeIntensity: number
  crest: number
  scale: number
  shield: 'heater' | 'tower' | null
  great: boolean
  phantom?: 'gold' | 'red'
  ember?: boolean
  bulk: number
  tatter: number
}

export function buildKnight(o: KnightOpts): CharacterModel {
  const rig = new Rig(o.great ? { ...HUMAN_DIMS, grip: 0.22 } : HUMAN_DIMS)
  rig.root.scale.setScalar(o.scale)
  const A = armorTextures()
  const C = clothTextures()
  const mats: THREE.MeshStandardMaterial[] = []
  const reg = <T extends THREE.MeshStandardMaterial>(m: T) => {
    mats.push(m)
    return m
  }
  const tint = o.phantom === 'red' ? '#ff3a24' : '#ffb54a'
  const rimColor = o.phantom === 'red' ? '#ff5a40' : o.phantom ? '#ffd27a' : o.ember ? '#ff8040' : '#8fa6c8'
  const rim = o.phantom ? 1.4 : 0.32
  const steel = reg(
    standard({
      color: o.armor,
      metalness: o.ember ? 0.85 : 0.78,
      roughness: 1,
      map: A.map,
      normalMap: A.normalMap,
      roughnessMap: A.roughnessMap,
      normalScale: 0.7,
      rim,
      rimColor,
      emissive: o.ember ? '#ff5a1a' : '#000000',
      emissiveMap: o.ember ? emberCrackTexture() : null,
      emissiveIntensity: o.ember ? 0.8 : 1,
    }),
  )
  const mail = reg(standard({ color: new THREE.Color(o.armor).multiplyScalar(0.55), metalness: 0.8, roughness: 1, roughnessMap: A.roughnessMap, normalMap: C.normalMap, normalScale: 1.5, rim, rimColor }))
  const leather = reg(standard({ color: '#33251b', roughness: 0.85, normalMap: C.normalMap, normalScale: 0.6, rim: rim * 0.6, rimColor }))
  const cloth = reg(
    standard({ color: o.cloth, roughness: 1, map: C.map, normalMap: C.normalMap, roughnessMap: C.roughnessMap, side: THREE.DoubleSide, rim: rim * 0.8, rimColor }),
  )
  const trim = reg(standard({ color: o.trim, metalness: 1, roughness: 0.38, rim, rimColor }))
  const glowMats: THREE.MeshStandardMaterial[] = []
  const visor = reg(standard({ color: '#030303', roughness: 1, emissive: o.eyes ?? '#000000', emissiveIntensity: o.eyes ? o.eyeIntensity : 0, rim: 0 }))
  if (o.eyes) glowMats.push(visor)
  const blade = reg(
    standard({ color: o.great ? '#8a8580' : '#cfd4da', metalness: 1, roughness: 0.7, roughnessMap: A.roughnessMap, normalMap: A.normalMap, normalScale: 0.3, rim, rimColor }),
  )

  if (o.phantom) {
    for (const m of mats) {
      m.transparent = true
      m.opacity = o.phantom === 'red' ? 0.55 : 0.82
      m.emissive = new THREE.Color(tint)
      m.emissiveIntensity = o.phantom === 'red' ? 0.9 : 0.35
      m.color.lerp(new THREE.Color(o.phantom === 'red' ? '#a02018' : '#e8c27a'), o.phantom === 'red' ? 0.7 : 0.45)
    }
  }

  const b = o.bulk
  // --- pelvis
  add(rig.hips, new THREE.CylinderGeometry(0.17 * b, 0.17 * b, 0.06, 18), leather, [0, 0.02, 0], [0, 0, 0], [1, 1, 0.82])
  add(rig.hips, new THREE.CylinderGeometry(0.172 * b, 0.22 * b, 0.17, 18, 1, true), steel, [0, -0.08, 0], [0, 0, 0], [1, 1, 0.82])
  add(rig.hips, new THREE.TorusGeometry(0.172 * b, 0.009, 6, 28), trim, [0, 0.005, 0], [Math.PI / 2, 0, 0], [1, 0.82, 1])
  // tabard flaps
  const flapFront = new THREE.Group()
  flapFront.position.set(0, -0.01, 0.15 * b)
  rig.hips.add(flapFront)
  add(flapFront, new THREE.BoxGeometry(0.21 * b, 0.5, 0.012), cloth, [0, -0.25, 0])
  const flapBack = new THREE.Group()
  flapBack.position.set(0, -0.01, -0.14 * b)
  rig.hips.add(flapBack)
  add(flapBack, new THREE.BoxGeometry(0.24 * b, 0.52, 0.012), cloth, [0, -0.26, 0])

  // --- abdomen & chest
  add(rig.spine, new THREE.CylinderGeometry(0.15 * b, 0.165 * b, 0.19, 16), mail, [0, 0.04, 0], [0, 0, 0], [1, 1, 0.8])
  const profile = [
    [0.13, -0.2],
    [0.165, -0.12],
    [0.19, -0.02],
    [0.207, 0.08],
    [0.198, 0.16],
    [0.16, 0.21],
    [0.1, 0.235],
    [0.07, 0.24],
  ].map(([r, y]) => new THREE.Vector2(r * b, y))
  add(rig.chest, new THREE.LatheGeometry(profile, 22), steel, [0, 0, 0], [0, 0, 0], [1, 1, 0.74])
  // plackart ridge
  add(rig.chest, new THREE.BoxGeometry(0.02, 0.3, 0.03), steel, [0, -0.02, 0.15 * b * 0.97], [0.12, 0, 0])
  add(rig.chest, new THREE.CylinderGeometry(0.082 * b, 0.115 * b, 0.075, 16), steel, [0, 0.245, 0])
  add(rig.chest, new THREE.TorusGeometry(0.1 * b, 0.008, 6, 24), trim, [0, 0.215, 0], [Math.PI / 2, 0, 0], [1, 0.8, 1])

  // --- head
  const H = rig.head
  if (o.great) {
    add(H, new THREE.CylinderGeometry(0.12, 0.125, 0.2, 20), steel, [0, 0.085, 0.005], [0, 0, 0], [1, 1, 1.05])
    add(H, new THREE.SphereGeometry(0.12, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), steel, [0, 0.185, 0.005], [0, 0, 0], [1, 0.8, 1.05])
  } else {
    add(H, new THREE.CylinderGeometry(0.112, 0.118, 0.19, 20), steel, [0, 0.085, 0], [0, 0, 0], [1, 1, 1.05])
    add(H, new THREE.SphereGeometry(0.112, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), steel, [0, 0.18, 0], [0, 0, 0], [1, 0.85, 1.05])
  }
  add(H, new THREE.BoxGeometry(0.018, 0.19, 0.035), steel, [0, 0.085, 0.112])
  const helmR = o.great ? 0.122 : 0.114
  const slit = add(H, new THREE.CylinderGeometry(helmR + 0.002, helmR + 0.002, 0.022, 18, 1, true, -0.85, 1.7), visor, [0, 0.118, 0.006])
  slit.userData.keep = true
  slit.castShadow = false
  add(H, new THREE.TorusGeometry(0.116, 0.008, 6, 26), trim, [0, 0.163, 0], [Math.PI / 2, 0, 0], [1, 1.05, 1])
  for (let i = 0; i < 3; i++) {
    const a = 0.25 + i * 0.16
    add(H, new THREE.BoxGeometry(0.008, 0.008, 0.012), visor, [Math.sin(a) * helmR, 0.065, Math.cos(a) * helmR + 0.004], [0, a, 0])
  }

  const crestMat = o.phantom ? trim : cloth
  if (o.crest === 0) {
    add(
      H,
      taperTube([new THREE.Vector3(0, 0.21, 0.07), new THREE.Vector3(0, 0.3, 0), new THREE.Vector3(0, 0.27, -0.12), new THREE.Vector3(0, 0.12, -0.24)], 0.032, 0.012),
      crestMat,
    )
  } else if (o.crest === 2) {
    for (const s of [1, -1]) {
      add(
        H,
        taperTube(
          [new THREE.Vector3(0.1 * s, 0.15, 0), new THREE.Vector3(0.2 * s, 0.19, 0.02), new THREE.Vector3(0.27 * s, 0.31, 0.06), new THREE.Vector3(0.24 * s, 0.46, 0.12)],
          0.035,
          0.004,
        ),
        o.great ? leather : trim,
      )
    }
  } else if (o.crest === 3) {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2
      add(H, new THREE.ConeGeometry(0.018, 0.09, 6), trim, [Math.sin(a) * 0.1, 0.24, Math.cos(a) * 0.1], [Math.cos(a) * 0.25, 0, -Math.sin(a) * 0.25])
    }
  }
  if (o.great) {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2
      add(H, new THREE.ConeGeometry(0.02, 0.13 + (i % 2) * 0.06, 6), trim, [Math.sin(a) * 0.105, 0.25, Math.cos(a) * 0.105], [Math.cos(a) * 0.3, 0, -Math.sin(a) * 0.3])
    }
  }

  // --- arms
  for (const side of [1, -1]) {
    const sh = side > 0 ? rig.shoulderL : rig.shoulderR
    const el = side > 0 ? rig.elbowL : rig.elbowR
    const ha = side > 0 ? rig.handL : rig.handR
    const pb = o.great ? 1.35 : 1
    add(sh, new THREE.SphereGeometry(0.118 * pb, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), steel, [0.01 * side, 0.03, 0], [0, 0, -0.38 * side], [1.15, 0.9, 1.05])
    add(sh, new THREE.CylinderGeometry(0.1 * pb, 0.114 * pb, 0.065, 16, 1, true), steel, [0.012 * side, -0.035, 0], [0, 0, -0.3 * side])
    add(sh, new THREE.TorusGeometry(0.105 * pb, 0.007, 6, 22), trim, [0.01 * side, 0.0, 0], [Math.PI / 2, -0.38 * side, 0])
    if (o.great) {
      for (let i = 0; i < 3; i++) add(sh, new THREE.ConeGeometry(0.025, 0.16, 6), trim, [0.06 * side, 0.1, -0.05 + i * 0.05], [0, 0, -0.6 * side])
    }
    add(sh, new THREE.CylinderGeometry(0.056, 0.05, 0.22, 12), steel, [0, -0.15, 0])
    add(el, new THREE.SphereGeometry(0.058, 12, 10), steel, [0, 0, -0.005])
    add(el, new THREE.CylinderGeometry(0.052, 0.044, 0.2, 12), steel, [0, -0.12, 0])
    add(el, new THREE.CylinderGeometry(0.066, 0.05, 0.06, 12, 1, true), steel, [0, -0.225, 0])
    add(ha, new THREE.BoxGeometry(0.072, 0.09, 0.1), mail, [0, -0.01, 0])
    add(ha, new THREE.BoxGeometry(0.076, 0.03, 0.105), steel, [0, 0.03, 0])
  }

  // --- legs
  for (const side of [1, -1]) {
    const th = side > 0 ? rig.thighL : rig.thighR
    const kn = side > 0 ? rig.kneeL : rig.kneeR
    const ft = side > 0 ? rig.footL : rig.footR
    add(th, new THREE.CylinderGeometry(0.09 * b, 0.072, 0.38, 12), steel, [0, -0.2, 0.005])
    add(th, new THREE.CylinderGeometry(0.094 * b, 0.092 * b, 0.06, 12, 1, true), trim, [0, -0.04, 0.005])
    add(kn, new THREE.SphereGeometry(0.064, 12, 10), steel, [0, 0, 0.012])
    add(kn, new THREE.BoxGeometry(0.11, 0.07, 0.02), steel, [0, -0.01, 0.06], [0.3, 0, 0])
    add(kn, new THREE.CylinderGeometry(0.066, 0.052, 0.37, 12), steel, [0, -0.21, 0])
    add(ft, new THREE.BoxGeometry(0.098, 0.075, 0.25), steel, [0, -0.035, 0.055])
    add(ft, new THREE.SphereGeometry(0.05, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), steel, [0, -0.06, 0.17], [Math.PI / 2, 0, 0], [1, 1.4, 0.8])
  }

  // --- weapon
  const swordBase = new THREE.Object3D()
  const swordTip = new THREE.Object3D()
  let bladeFire: THREE.Mesh | null = null
  if (o.great) {
    const len = 1.62
    add(rig.handR, bladeGeometry(len, 0.075, 0.018), blade, [0, 0, 0.1])
    add(rig.handR, new THREE.BoxGeometry(0.05, 0.52, 0.05), trim, [0, 0, 0.08])
    for (const s of [1, -1]) add(rig.handR, new THREE.ConeGeometry(0.03, 0.1, 6), trim, [0, 0.29 * s, 0.1], [s > 0 ? 0 : Math.PI, 0, 0])
    add(rig.handR, new THREE.CylinderGeometry(0.022, 0.022, 0.42, 10), leather, [0, 0, -0.12], [Math.PI / 2, 0, 0])
    add(rig.handR, new THREE.SphereGeometry(0.045, 12, 10), trim, [0, 0, -0.35])
    // glowing fuller runes
    const rune = standard({ color: '#1a0a04', emissive: '#ff6a20', emissiveIntensity: 3, rim: 0 })
    glowMats.push(rune)
    mats.push(rune)
    const r = add(rig.handR, new THREE.BoxGeometry(0.022, 0.012, len * 0.7), rune, [0, 0, 0.1 + len * 0.4])
    r.userData.keep = true
    swordBase.position.set(0, 0, 0.12)
    swordTip.position.set(0, 0, 0.1 + len)
    bladeFire = makeBladeFire(len)
    bladeFire.position.set(0, 0, 0.1 + len * 0.5)
    bladeFire.visible = false
    rig.handR.add(bladeFire)
  } else {
    const len = 0.95
    add(rig.handR, bladeGeometry(len, 0.042, 0.011), blade, [0, 0, 0.08])
    add(rig.handR, new THREE.BoxGeometry(0.032, 0.23, 0.032), trim, [0, 0, 0.065])
    add(rig.handR, new THREE.CylinderGeometry(0.017, 0.017, 0.16, 10), leather, [0, 0, -0.02], [Math.PI / 2, 0, 0])
    add(rig.handR, new THREE.SphereGeometry(0.028, 10, 8), trim, [0, 0, -0.11])
    swordBase.position.set(0, 0, 0.12)
    swordTip.position.set(0, 0, 0.08 + len)
  }
  rig.handR.add(swordBase, swordTip)

  // --- shield
  if (o.shield) {
    const w = o.shield === 'tower' ? 0.3 : 0.25
    const h = o.shield === 'tower' ? 0.86 : 0.66
    const shape = heaterShape(w, h)
    const body = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.014, bevelSegments: 2 })
    add(rig.handL, body, steel, [0, 0.02, 0.035])
    const faceShape = heaterShape(w * 0.86, h * 0.86)
    const faceGeo = new THREE.ShapeGeometry(faceShape, 12)
    const uv = faceGeo.attributes.uv as THREE.BufferAttribute
    const pos = faceGeo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / (2 * w) + 0.5, (pos.getY(i) + h * 0.56) / h)
    const paint = reg(
      standard({ color: '#ffffff', map: shieldFaceTexture(o.phantom ? '#c49a4a' : o.cloth), roughness: 0.75, normalMap: A.normalMap, normalScale: 0.5, rim, rimColor }),
    )
    if (o.phantom) {
      paint.transparent = true
      paint.opacity = 0.82
      paint.emissive = new THREE.Color(tint)
      paint.emissiveIntensity = 0.3
    }
    const face = add(rig.handL, faceGeo, paint, [0, 0.02, 0.035 + 0.03 + 0.0135])
    face.userData.keep = true
    // boss on the face
    add(rig.handL, new THREE.SphereGeometry(0.045, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), trim, [0, 0.06, 0.08], [Math.PI / 2, 0, 0], [1, 0.5, 1])
  }

  // --- estus flask (hidden until drinking)
  let flask: THREE.Object3D | null = null
  if (o.arche === 'knight') {
    flask = new THREE.Group()
    const glass = standard({ color: '#2a3b2a', roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.85, rim: 0.6, rimColor: '#ffcf8a' })
    const fire = standard({ color: '#ff8a2a', emissive: '#ff7a1a', emissiveIntensity: 2.5, rim: 0 })
    const b1 = add(flask, new THREE.SphereGeometry(0.042, 14, 10), glass, [0, 0, 0])
    b1.userData.keep = true
    const f = add(flask, new THREE.SphereGeometry(0.03, 12, 8), fire, [0, -0.008, 0])
    f.userData.keep = true
    add(flask, new THREE.CylinderGeometry(0.012, 0.016, 0.05, 8), glass, [0, 0.05, 0])
    flask.position.set(0.0, 0.0, 0.055)
    flask.visible = false
    rig.handR.add(flask)
  }

  mergeStatic(rig.root)

  // --- cape
  const container = new THREE.Group()
  container.add(rig.root)
  const capeMat = reg(
    standard({
      color: o.cloth,
      roughness: 1,
      map: C.map,
      normalMap: C.normalMap,
      side: THREE.DoubleSide,
      alphaMap: tatteredAlpha(o.great ? 7 : o.arche === 'fallen' ? 5 : 3, o.tatter),
      alphaTest: 0.5,
      rim: rim * 0.7,
      rimColor,
    }),
  )
  if (o.phantom) {
    capeMat.color.lerp(new THREE.Color(o.phantom === 'red' ? '#a02018' : '#e8c27a'), 0.45)
    capeMat.emissive = new THREE.Color(tint)
    capeMat.emissiveIntensity = 0.3
  }
  const colliders: Capsule[] = [
    { a: rig.hips, b: rig.neck, r: 0.21 * b },
    { a: rig.thighL, b: rig.kneeL, r: 0.11 },
    { a: rig.thighR, b: rig.kneeR, r: 0.11 },
    { a: rig.kneeL, b: rig.footL, r: 0.085 },
    { a: rig.kneeR, b: rig.footR, r: 0.085 },
  ]
  const cape = new Cape({
    width: (o.great ? 0.62 : 0.44) * b,
    length: o.great ? 1.25 : 1.08,
    cols: 8,
    rows: 12,
    material: capeMat,
    anchor: rig.chest,
    left: new THREE.Vector3(0.17 * b, 0.17, -0.12 * b),
    right: new THREE.Vector3(-0.17 * b, 0.17, -0.12 * b),
    colliders,
  })
  container.add(cape.mesh)

  const trail = new SwordTrail(o.ember ? '#ff7a30' : o.phantom ? '#ffd890' : '#cfe0ff', o.ember ? 2.2 : 1.3)
  container.add(trail.mesh)

  return {
    arche: o.arche,
    rig,
    container,
    materials: mats,
    swordBase,
    swordTip,
    flask,
    cape,
    flapFront,
    flapBack,
    bladeFire,
    glowMats,
    trail,
    scale: o.scale,
  }
}

const fireVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const fireFrag = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
void main() {
  vec2 uv = vUv;
  float across = abs(uv.x - 0.5) * 2.0;
  float flow = n(vec2(uv.x * 4.0, uv.y * 10.0 - uTime * 6.0)) * 0.6 + n(vec2(uv.x * 9.0, uv.y * 22.0 - uTime * 11.0)) * 0.4;
  float shape = smoothstep(1.0, 0.1, across + flow * 0.55);
  shape *= smoothstep(0.0, 0.08, uv.y) * smoothstep(1.0, 0.85, uv.y);
  vec3 col = mix(vec3(1.0, 0.25, 0.05), vec3(1.0, 0.8, 0.4), shape * shape);
  gl_FragColor = vec4(col * shape * uIntensity, shape);
}
`

function makeBladeFire(len: number) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: fireVert,
    fragmentShader: fireFrag,
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 2.5 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  })
  const g1 = new THREE.PlaneGeometry(0.42, len * 1.05)
  g1.rotateX(-Math.PI / 2)
  const g2 = g1.clone().rotateZ(Math.PI / 2)
  const geo = mergeGeometries([g1, g2])!
  const m = new THREE.Mesh(geo, mat)
  m.renderOrder = 6
  return m
}

// ---------------------------------------------------------------------------
// Hollow soldier
// ---------------------------------------------------------------------------

export function buildHollow(variant: number): CharacterModel {
  const rig = new Rig({ ...HUMAN_DIMS, shoulderX: 0.18, upper: 0.28, fore: 0.27 })
  const scale = 0.97 + (variant % 3) * 0.02
  rig.root.scale.setScalar(scale)
  const K = skinTextures()
  const C = clothTextures()
  const A = armorTextures()
  const mats: THREE.MeshStandardMaterial[] = []
  const reg = <T extends THREE.MeshStandardMaterial>(m: T) => {
    mats.push(m)
    return m
  }
  const skin = reg(standard({ color: '#8a7a69', roughness: 1, map: K.map, normalMap: K.normalMap, roughnessMap: K.roughnessMap, normalScale: 1.2, rim: 0.45, rimColor: '#9fb0cc' }))
  const rag = reg(
    standard({ color: ['#3b3226', '#2c2a2a', '#3a2b22'][variant % 3], roughness: 1, map: C.map, normalMap: C.normalMap, side: THREE.DoubleSide, rim: 0.2, alphaMap: tatteredAlpha(11 + variant, 1.4), alphaTest: 0.5 }),
  )
  const ragSolid = reg(standard({ color: ['#3b3226', '#2c2a2a', '#3a2b22'][variant % 3], roughness: 1, map: C.map, normalMap: C.normalMap, rim: 0.2 }))
  const rust = reg(standard({ color: '#6b5544', metalness: 0.65, roughness: 1, map: A.map, roughnessMap: A.roughnessMap, normalMap: A.normalMap, rim: 0.25 }))
  const leather = reg(standard({ color: '#2a1f17', roughness: 0.9, rim: 0.2 }))
  const eyeMat = reg(standard({ color: '#000000', emissive: '#ff8a3a', emissiveIntensity: 4, rim: 0 }))
  const socket = reg(standard({ color: '#050403', roughness: 1, rim: 0 }))

  // torso: emaciated ribcage under rags
  const profile = [
    [0.11, -0.2],
    [0.13, -0.1],
    [0.155, 0.0],
    [0.17, 0.1],
    [0.16, 0.17],
    [0.12, 0.21],
    [0.06, 0.23],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  add(rig.chest, new THREE.LatheGeometry(profile, 16), skin, [0, 0, 0], [0, 0, 0], [1, 1, 0.72])
  add(rig.chest, new THREE.CylinderGeometry(0.165, 0.15, 0.24, 14, 1, true), rag, [0, -0.02, 0], [0, 0, 0], [1.04, 1, 0.8])
  add(rig.spine, new THREE.CylinderGeometry(0.115, 0.13, 0.18, 12), skin, [0, 0.04, 0], [0, 0, 0], [1, 1, 0.8])
  add(rig.hips, new THREE.CylinderGeometry(0.135, 0.14, 0.12, 12), ragSolid, [0, -0.02, 0], [0, 0, 0], [1, 1, 0.8])
  add(rig.hips, new THREE.TorusGeometry(0.135, 0.012, 6, 20), leather, [0, 0.03, 0], [Math.PI / 2, 0, 0], [1, 0.8, 1])
  const flapFront = new THREE.Group()
  flapFront.position.set(0, -0.02, 0.11)
  rig.hips.add(flapFront)
  add(flapFront, new THREE.PlaneGeometry(0.2, 0.42), rag, [0, -0.2, 0])
  const flapBack = new THREE.Group()
  flapBack.position.set(0, -0.02, -0.11)
  rig.hips.add(flapBack)
  add(flapBack, new THREE.PlaneGeometry(0.22, 0.46), rag, [0, -0.22, 0])
  add(rig.chest, new THREE.CylinderGeometry(0.045, 0.06, 0.12, 10), skin, [0, 0.24, 0])

  // skull
  const H = rig.head
  add(H, new THREE.SphereGeometry(0.098, 18, 14), skin, [0, 0.1, 0.01], [0, 0, 0], [0.86, 1.05, 0.98])
  add(H, new THREE.BoxGeometry(0.1, 0.05, 0.08), skin, [0, 0.025, 0.04])
  for (const s of [1, -1]) {
    const so = add(H, new THREE.SphereGeometry(0.024, 10, 8), socket, [0.034 * s, 0.11, 0.077])
    so.userData.keep = true
    const e = add(H, new THREE.SphereGeometry(0.008, 8, 6), eyeMat, [0.034 * s, 0.11, 0.094])
    e.userData.keep = true
  }
  if (variant % 2 === 0) {
    add(H, new THREE.ConeGeometry(0.11, 0.1, 14, 1, true), rust, [0, 0.2, 0], [0, 0, 0], [1, 1, 1.05])
    add(H, new THREE.CylinderGeometry(0.17, 0.17, 0.012, 18), rust, [0, 0.15, 0])
  } else {
    // hood of rags
    add(H, new THREE.SphereGeometry(0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), ragSolid, [0, 0.1, -0.015], [-0.25, 0, 0], [1, 1.1, 1.05])
  }

  // arms
  for (const side of [1, -1]) {
    const sh = side > 0 ? rig.shoulderL : rig.shoulderR
    const el = side > 0 ? rig.elbowL : rig.elbowR
    const ha = side > 0 ? rig.handL : rig.handR
    add(sh, new THREE.SphereGeometry(0.052, 10, 8), skin, [0, -0.01, 0])
    add(sh, new THREE.CylinderGeometry(0.05, 0.04, 0.27, 9), skin, [0, -0.14, 0])
    add(el, new THREE.SphereGeometry(0.036, 8, 6), skin)
    add(el, new THREE.CylinderGeometry(0.04, 0.03, 0.25, 9), skin, [0, -0.13, 0])
    add(el, new THREE.CylinderGeometry(0.04, 0.036, 0.08, 9), ragSolid, [0, -0.17, 0])
    add(ha, new THREE.BoxGeometry(0.05, 0.075, 0.075), skin, [0, -0.01, 0])
  }
  if (variant % 3 === 1) add(rig.shoulderR, new THREE.SphereGeometry(0.09, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), rust, [-0.01, 0.02, 0], [0, 0, 0.4], [1.1, 0.8, 1])

  // legs
  for (const side of [1, -1]) {
    const th = side > 0 ? rig.thighL : rig.thighR
    const kn = side > 0 ? rig.kneeL : rig.kneeR
    const ft = side > 0 ? rig.footL : rig.footR
    add(th, new THREE.CylinderGeometry(0.07, 0.052, 0.42, 10), skin, [0, -0.21, 0])
    add(kn, new THREE.SphereGeometry(0.045, 8, 6), skin)
    add(kn, new THREE.CylinderGeometry(0.052, 0.04, 0.42, 10), skin, [0, -0.21, 0])
    add(kn, new THREE.CylinderGeometry(0.055, 0.05, 0.22, 10), ragSolid, [0, -0.28, 0])
    add(ft, new THREE.BoxGeometry(0.075, 0.06, 0.2), leather, [0, -0.03, 0.05])
  }

  // weapon: broken sword or hatchet
  const swordBase = new THREE.Object3D()
  const swordTip = new THREE.Object3D()
  if (variant % 2 === 0) {
    const len = 0.6
    add(rig.handR, bladeGeometry(len, 0.04, 0.01), rust, [0, 0, 0.07])
    add(rig.handR, new THREE.BoxGeometry(0.03, 0.18, 0.03), rust, [0, 0, 0.06])
    add(rig.handR, new THREE.CylinderGeometry(0.016, 0.016, 0.14, 8), leather, [0, 0, -0.02], [Math.PI / 2, 0, 0])
    swordBase.position.set(0, 0, 0.1)
    swordTip.position.set(0, 0, 0.07 + len)
  } else {
    add(rig.handR, new THREE.CylinderGeometry(0.018, 0.022, 0.62, 8), leather, [0, 0, 0.2], [Math.PI / 2, 0, 0])
    const head = new THREE.Shape()
    head.moveTo(0, 0)
    head.lineTo(0.16, 0.04)
    head.quadraticCurveTo(0.2, -0.06, 0.15, -0.16)
    head.lineTo(0, -0.06)
    head.closePath()
    const hg = new THREE.ExtrudeGeometry(head, { depth: 0.012, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 1 })
    add(rig.handR, hg, rust, [-0.006, 0.0, 0.46], [0, -Math.PI / 2, Math.PI / 2])
    swordBase.position.set(0, 0, 0.32)
    swordTip.position.set(0, 0.17, 0.5)
  }
  rig.handR.add(swordBase, swordTip)

  mergeStatic(rig.root)
  const container = new THREE.Group()
  container.add(rig.root)

  let cape: Cape | null = null
  if (variant % 3 === 2) {
    cape = new Cape({
      width: 0.4,
      length: 0.7,
      cols: 6,
      rows: 8,
      material: rag,
      anchor: rig.chest,
      left: new THREE.Vector3(0.15, 0.17, -0.1),
      right: new THREE.Vector3(-0.15, 0.17, -0.1),
      colliders: [
        { a: rig.hips, b: rig.neck, r: 0.17 },
        { a: rig.thighL, b: rig.kneeL, r: 0.08 },
        { a: rig.thighR, b: rig.kneeR, r: 0.08 },
      ],
    })
    container.add(cape.mesh)
  }
  const trail = new SwordTrail('#ffd2a0', 0.8)
  container.add(trail.mesh)

  return {
    arche: 'hollow',
    rig,
    container,
    materials: mats,
    swordBase,
    swordTip,
    flask: null,
    cape,
    flapFront,
    flapBack,
    bladeFire: null,
    glowMats: [eyeMat],
    trail,
    scale,
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function buildPlayer(look: Look, phantom?: 'gold' | 'red'): CharacterModel {
  return buildKnight({
    arche: 'knight',
    armor: '#b9bfc8',
    cloth: CLOAK_COLORS[look.cloak] ?? CLOAK_COLORS[0],
    trim: '#a8843e',
    eyes: null,
    eyeIntensity: 0,
    crest: look.crest,
    scale: 1,
    shield: 'heater',
    great: false,
    phantom,
    bulk: 1,
    tatter: 0.7,
  })
}

export function buildFallen(): CharacterModel {
  return buildKnight({
    arche: 'fallen',
    armor: '#3a3940',
    cloth: '#3d1010',
    trim: '#8a6a30',
    eyes: '#ff3a1a',
    eyeIntensity: 5,
    crest: 2,
    scale: 1.1,
    shield: 'tower',
    great: false,
    bulk: 1.08,
    tatter: 1.3,
  })
}

export function buildBoss(): CharacterModel {
  return buildKnight({
    arche: 'boss',
    armor: '#4a4540',
    cloth: '#24140f',
    trim: '#6e5a36',
    eyes: '#ff7a20',
    eyeIntensity: 7,
    crest: 2,
    scale: 2.35,
    shield: null,
    great: true,
    ember: true,
    bulk: 1.18,
    tatter: 1.6,
  })
}
