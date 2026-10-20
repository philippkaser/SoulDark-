import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Rig } from './rig'

/**
 * Helpers for building characters out of primitives hung on a Rig.
 */

type Mat = THREE.Material

export function add(
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
export function taperTube(points: THREE.Vector3[], r0: number, r1: number, seg = 16, radial = 8) {
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

/**
 * Collapse the rigidly-attached body parts into one SkinnedMesh per material.
 * Each vertex is bound with full weight to the joint its part hung from, so a
 * whole character costs a handful of draw calls instead of dozens.
 */
export function mergeStatic(rig: Rig, bounds = new THREE.Sphere(new THREE.Vector3(0, 1.1, 0), 2.6)): MergedBody {
  const root = rig.root
  const saved = root.matrix.clone()
  const savedScale = root.scale.clone()
  root.scale.set(1, 1, 1)
  root.position.set(0, 0, 0)
  root.rotation.set(0, 0, 0)
  root.updateMatrixWorld(true)
  const boneIndex = new Map<THREE.Object3D, number>()
  rig.bones.forEach((b, i) => boneIndex.set(b, i))
  const byMat = new Map<THREE.Material, Array<{ mesh: THREE.Mesh; bone: number }>>()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || m.userData.keep || !(o.parent as THREE.Bone)?.isBone) return
    const bone = boneIndex.get(o.parent!)
    if (bone === undefined) return
    const mat = m.material as THREE.Material
    if (!byMat.has(mat)) byMat.set(mat, [])
    byMat.get(mat)!.push({ mesh: m, bone })
  })
  const skeleton = new THREE.Skeleton(rig.bones)
  const meshes: THREE.SkinnedMesh[] = []
  for (const [mat, parts] of byMat) {
    const geos = parts.map(({ mesh, bone }) => {
      let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
      g.applyMatrix4(mesh.matrixWorld)
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name)
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
      const n = g.attributes.position.count
      const si = new Uint16Array(n * 4)
      const sw = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        si[i * 4] = bone
        sw[i * 4] = 1
      }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4))
      return g
    })
    const merged = mergeGeometries(geos, false)
    if (!merged) continue
    for (const { mesh } of parts) mesh.removeFromParent()
    const sm = new THREE.SkinnedMesh(merged, mat)
    sm.castShadow = true
    sm.receiveShadow = true
    sm.bind(skeleton, new THREE.Matrix4())
    // generous bounds in rig space (covers rolls, leaps and outstretched swords)
    sm.boundingSphere = bounds.clone()
    root.add(sm)
    meshes.push(sm)
  }
  root.matrix.copy(saved)
  root.scale.copy(savedScale)
  root.updateMatrixWorld(true)
  return { skeleton, meshes }
}

export interface MergedBody {
  skeleton: THREE.Skeleton
  meshes: THREE.SkinnedMesh[]
}

const _m = new THREE.Matrix4()
const _n = new THREE.Matrix3()
const _v = new THREE.Vector3()

/**
 * Bake the current pose of a rigidly-skinned mesh (one bone per vertex, as
 * produced by mergeStatic) into a static world-space geometry. Used to turn a
 * posed character into something that can be sliced apart.
 */
export function bakeSkinned(mesh: THREE.SkinnedMesh): THREE.BufferGeometry {
  const src = mesh.geometry
  const skel = mesh.skeleton
  skel.update()
  const pos = src.attributes.position as THREE.BufferAttribute
  const nor = src.attributes.normal as THREE.BufferAttribute
  const idx = src.attributes.skinIndex as THREE.BufferAttribute
  const n = pos.count
  const outP = new Float32Array(n * 3)
  const outN = new Float32Array(n * 3)
  let lastBone = -1
  for (let i = 0; i < n; i++) {
    const b = idx.getX(i)
    if (b !== lastBone) {
      _m.fromArray(skel.boneMatrices!, b * 16)
      _n.getNormalMatrix(_m)
      lastBone = b
    }
    _v.fromBufferAttribute(pos, i).applyMatrix4(_m)
    outP[i * 3] = _v.x
    outP[i * 3 + 1] = _v.y
    outP[i * 3 + 2] = _v.z
    _v.fromBufferAttribute(nor, i).applyMatrix3(_n).normalize()
    outN[i * 3] = _v.x
    outN[i * 3 + 1] = _v.y
    outN[i * 3 + 2] = _v.z
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(outP, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(outN, 3))
  if (src.attributes.uv) g.setAttribute('uv', src.attributes.uv.clone())
  g.computeBoundingSphere()
  return g
}

