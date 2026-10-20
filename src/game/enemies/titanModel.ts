import * as THREE from 'three'
import { standard } from '../../engine/gfx/materials'
import { armorTextures, emberCrackTexture } from '../../engine/gfx/textures'
import type { CharacterModel } from '../../engine/rig/avatar'
import { add, bladeGeometry, mergeStatic, taperTube } from '../../engine/rig/build'
import { registerClipSet, sw, type ClipDef } from '../../engine/rig/clips'
import { S, type PoseSpec } from '../../engine/rig/pose'
import { HUMAN_DIMS, Rig } from '../../engine/rig/rig'

export const TITAN_SCALE = 19

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

export interface TitanModel extends CharacterModel {
  core: THREE.MeshStandardMaterial
  ember: THREE.MeshStandardMaterial
}

export function buildTitan(): TitanModel {
  const rig = new Rig({ ...HUMAN_DIMS, shoulderX: 0.24, grip: 0.24 })
  rig.root.scale.setScalar(TITAN_SCALE)
  const A = armorTextures()
  const mats: THREE.MeshStandardMaterial[] = []
  const reg = <T extends THREE.MeshStandardMaterial>(m: T) => (mats.push(m), m)
  const iron = reg(standard({ color: '#3a3532', metalness: 0.85, roughness: 0.8, map: A.map, normalMap: A.normalMap, normalScale: 0.8, emissive: '#ff4a10', emissiveMap: emberCrackTexture(), emissiveIntensity: 1.4, rim: 0.4, rimColor: '#ff7030' }))
  const ember = iron
  const dark = reg(standard({ color: '#161312', metalness: 0.7, roughness: 0.6, rim: 0.35, rimColor: '#ff7030' }))
  const bone = reg(standard({ color: '#b9ab92', roughness: 0.8, rim: 0.3, rimColor: '#ff9a60' }))
  const core = reg(standard({ color: '#200800', emissive: '#ff6a1a', emissiveIntensity: 6, rim: 0 }))
  const cloth = reg(standard({ color: '#3a0a0c', roughness: 1, side: THREE.DoubleSide }))
  const b = 1.3

  // hips + loincloth
  add(rig.hips, new THREE.CylinderGeometry(0.2 * b, 0.22 * b, 0.22, 10), iron, [0, -0.04, 0], [0, 0, 0], [1, 1, 0.85])
  add(rig.hips, new THREE.BoxGeometry(0.28, 0.5, 0.02), cloth, [0, -0.3, 0.19])
  add(rig.hips, new THREE.BoxGeometry(0.32, 0.55, 0.02), cloth, [0, -0.32, -0.18])
  // torso
  add(rig.spine, new THREE.CylinderGeometry(0.17 * b, 0.19 * b, 0.2, 10), dark, [0, 0.04, 0], [0, 0, 0], [1, 1, 0.8])
  const prof = [
    [0.15, -0.2],
    [0.2, -0.1],
    [0.235, 0.02],
    [0.25, 0.12],
    [0.23, 0.2],
    [0.16, 0.26],
    [0.08, 0.28],
  ].map(([r, y]) => new THREE.Vector2(r * b, y))
  add(rig.chest, new THREE.LatheGeometry(prof, 12), iron, [0, 0, 0], [0, 0, 0], [1, 1, 0.78])
  // the furnace heart, behind a ribcage of iron
  add(rig.chest, new THREE.SphereGeometry(0.1, 12, 10), core, [0, 0.06, 0.17])
  for (let i = 0; i < 4; i++) add(rig.chest, new THREE.BoxGeometry(0.34, 0.025, 0.04), dark, [0, -0.04 + i * 0.07, 0.24], [0, 0, 0], [1, 1, 1])
  add(rig.chest, new THREE.CylinderGeometry(0.1 * b, 0.14 * b, 0.1, 10), dark, [0, 0.28, 0])
  // head: a horned crown and burning eyes
  const H = rig.head
  add(H, new THREE.BoxGeometry(0.2, 0.24, 0.22), iron, [0, 0.11, 0.01])
  add(H, new THREE.BoxGeometry(0.16, 0.03, 0.03), core, [0, 0.12, 0.12])
  for (const s of [1, -1]) {
    add(H, taperTube([V(0.09 * s, 0.18, 0), V(0.2 * s, 0.24, -0.02), V(0.28 * s, 0.38, 0.04), V(0.26 * s, 0.56, 0.12)], 0.045, 0.006, 12, 6), bone)
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI - Math.PI / 2
    add(H, new THREE.ConeGeometry(0.02, 0.14, 4), dark, [Math.sin(a) * 0.1, 0.27, Math.cos(a) * 0.08], [Math.cos(a) * 0.2, 0, -Math.sin(a) * 0.2])
  }
  // arms with spiked pauldrons
  for (const side of [1, -1]) {
    const sh = side > 0 ? rig.shoulderL : rig.shoulderR
    const el = side > 0 ? rig.elbowL : rig.elbowR
    const ha = side > 0 ? rig.handL : rig.handR
    add(sh, new THREE.SphereGeometry(0.16, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), iron, [0.03 * side, 0.03, 0], [0, 0, -0.4 * side], [1.3, 0.9, 1.15])
    for (let i = 0; i < 3; i++) add(sh, new THREE.ConeGeometry(0.035, 0.22, 5), bone, [0.09 * side, 0.15, -0.06 + i * 0.06], [0, 0, -0.5 * side])
    add(sh, new THREE.CylinderGeometry(0.075, 0.065, 0.26, 8), dark, [0, -0.15, 0])
    add(el, new THREE.CylinderGeometry(0.075, 0.06, 0.26, 8), iron, [0, -0.13, 0])
    add(ha, new THREE.BoxGeometry(0.1, 0.12, 0.13), dark, [0, -0.02, 0])
  }
  // legs
  for (const side of [1, -1]) {
    const th = side > 0 ? rig.thighL : rig.thighR
    const kn = side > 0 ? rig.kneeL : rig.kneeR
    const ft = side > 0 ? rig.footL : rig.footR
    add(th, new THREE.CylinderGeometry(0.12, 0.09, 0.42, 8), iron, [0, -0.21, 0])
    add(kn, new THREE.SphereGeometry(0.085, 8, 6), dark, [0, 0, 0.02])
    add(kn, new THREE.CylinderGeometry(0.09, 0.075, 0.42, 8), iron, [0, -0.21, 0])
    add(ft, new THREE.BoxGeometry(0.14, 0.09, 0.3), dark, [0, -0.04, 0.06])
  }
  // the greatsword
  const len = 1.65
  add(rig.handR, bladeGeometry(len, 0.11, 0.024), dark, [0, 0, 0.12])
  add(rig.handR, new THREE.BoxGeometry(0.03, 0.03, len * 0.85), core, [0, 0, 0.12 + len * 0.45])
  add(rig.handR, new THREE.BoxGeometry(0.06, 0.6, 0.07), iron, [0, 0, 0.1])
  add(rig.handR, new THREE.CylinderGeometry(0.028, 0.028, 0.46, 8), dark, [0, 0, -0.14], [Math.PI / 2, 0, 0])
  const swordBase = new THREE.Object3D()
  const swordTip = new THREE.Object3D()
  swordBase.position.set(0, 0, 0.16)
  swordTip.position.set(0, 0, 0.12 + len)
  rig.handR.add(swordBase, swordTip)

  const body = mergeStatic(rig, new THREE.Sphere(new THREE.Vector3(0, 1.1, 0), 3.2))
  const container = new THREE.Group()
  container.add(rig.root)
  return {
    set: 'titan',
    rig,
    container,
    materials: mats,
    skeleton: body.skeleton,
    meshes: body.meshes,
    swordBase,
    swordTip,
    capes: [],
    trail: null,
    scale: TITAN_SCALE,
    stepLen: 0.95 * TITAN_SCALE,
    core,
    ember,
  }
}

// ---------------------------------------------------------------------------
// Clips: slow, enormous, telegraphed
// ---------------------------------------------------------------------------

const STANCE: PoseSpec = {
  rootY: -0.06,
  spineX: 0.16,
  chestX: 0.05,
  chestY: -0.15,
  headX: -0.12,
  thighLX: -0.2,
  thighLZ: 0.14,
  kneeL: 0.3,
  thighRX: 0.15,
  thighRZ: -0.14,
  kneeR: 0.28,
  lowerY: 0.25,
  twoHand: 1,
  handR: [-0.12, -0.22, 0.34],
  bladeR: [0.15, -0.3, 1],
  edgeR: [0, 1, -0.2],
  poleR: [-0.7, -0.5, -0.2],
  handL: [0.1, -0.3, 0.3],
  bladeL: [0, 0, 1],
  edgeL: [0, 1, 0],
  poleL: [0.75, -0.5, -0.2],
}

const KNEEL: PoseSpec = {
  rootY: -0.42,
  thighLX: -1.5,
  kneeL: 1.6,
  thighRX: 0.15,
  kneeR: 2.3,
  footR: 0.9,
  lowerY: 0,
  spineX: 0.5,
  headX: 0.45,
  twoHand: 0.3,
  handR: [-0.08, -0.18, 0.42],
  bladeR: [0, -1, 0.15],
  edgeR: [0, 0, 1],
  handL: [0.28, -0.42, 0.22],
}

const CLIPS: Record<string, ClipDef> = {
  slam: {
    dur: 3.1,
    keys: [
      [1.0, sw([-0.08, 0.52, -0.02], [0.05, 0.55, -1], 'chop', { spineX: -0.22, chestX: -0.12, chestY: 0, headX: -0.25, rootY: 0.02, poleR: [-0.8, 0.2, -0.2], poleL: [0.8, 0.2, -0.2] })],
      [1.6, sw([-0.06, 0.58, 0.04], [0.04, 0.8, -0.6], 'chop', { spineX: -0.3 })],
      [1.85, sw([-0.05, 0.3, 0.44], [0, 0.6, 0.8], 'chop', { spineX: 0.15, poleR: [-0.7, -0.5, -0.2], poleL: [0.75, -0.5, -0.2] })],
      [1.97, sw([-0.04, -0.12, 0.52], [0, -0.42, 1], 'chop', { spineX: 0.55, rootY: -0.2, thighLX: -0.6, kneeL: 0.75 })],
      [2.05, sw([-0.04, -0.3, 0.44], [0, -0.75, 0.65], 'chop', { spineX: 0.62, rootY: -0.26 })],
      [2.7, {}],
      [3.1, {}],
    ],
  },
  sweep: {
    dur: 2.5,
    keys: [
      [0.9, sw([-0.46, 0.0, -0.05], [-0.9, -0.15, -0.45], 'rl', { chestY: -0.8, spineY: -0.25, rootY: -0.16, kneeL: 0.6, kneeR: 0.55 })],
      [1.3, sw([-0.48, 0.0, 0.0], [-1, -0.2, -0.2], 'rl')],
      [1.42, sw([-0.3, -0.05, 0.4], [-0.5, -0.3, 1], 'rl', { chestY: -0.3 })],
      [1.55, sw([0.0, -0.08, 0.52], [0.4, -0.3, 1], 'rl', { chestY: 0.25, spineY: 0 })],
      [1.68, sw([0.3, -0.08, 0.36], [1, -0.25, 0.2], 'rl', { chestY: 0.7, spineY: 0.2 })],
      [2.1, {}],
      [2.5, {}],
    ],
  },
  stomp: {
    dur: 1.9,
    keys: [
      [0.75, { thighRX: -1.15, kneeR: 1.35, rootY: 0.04, spineX: -0.12, chestY: 0.25, headX: -0.2 }],
      [1.0, { thighRX: -1.2 }],
      [1.12, { thighRX: -0.1, kneeR: 0.25, rootY: -0.16, spineX: 0.3 }],
      [1.5, {}],
      [1.9, {}],
    ],
  },
  stagger: {
    dur: 5.2,
    keys: [
      [0.2, { spineX: -0.45, headX: -0.5, rootY: -0.04, twoHand: 0.4, handR: [-0.42, 0.25, 0.05], bladeR: [-0.6, 0.6, -0.4] }],
      [0.8, KNEEL],
      [4.3, { ...KNEEL, spineX: 0.58, headX: 0.6 }],
      [5.2, {}],
    ],
    proc: (out, t) => {
      if (t > 0.8 && t < 4.3) out[S.spineZ] += Math.sin(t * 9) * 0.015
    },
  },
  roar: {
    dur: 3.2,
    keys: [
      [0.6, { spineX: 0.4, headX: 0.4, rootY: -0.12 }],
      [1.1, { spineX: -0.45, headX: -0.65, chestX: -0.2, rootY: 0.02, twoHand: 0, handL: [0.5, 0.3, 0.1], bladeL: [1, 0.3, 0.2], handR: [-0.5, 0.3, 0.12], bladeR: [-0.6, 0.6, 0.4] }],
      [2.5, {}],
      [3.2, {}],
    ],
    proc: (out, t) => {
      if (t > 1.1 && t < 2.5) out[S.headY] += Math.sin(t * 13) * 0.07
    },
  },
  death: {
    dur: 6,
    hold: true,
    keys: [
      [0.4, { spineX: -0.4, headX: -0.6, twoHand: 0 }],
      [1.6, { ...KNEEL, twoHand: 0, spineX: 0.7, headX: 0.7, handR: [-0.3, -0.42, 0.2], bladeR: [-0.3, -1, 0.2] }],
      [3.0, { pivotX: 1.3, rootY: -0.8, spineX: 0.3 }],
      [6, {}],
    ],
  },
}

registerClipSet('titan', STANCE, CLIPS, { amp: 0.36, knee0: 0.2, bob: 0.03, breath: 0.9, gait: 9 })
