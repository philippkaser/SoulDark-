import * as THREE from 'three'
import { damp } from '../math'
import { sdUniforms } from '../gfx/materials'
import type { Cape } from './cape'
import { getClip, getClipSet, locomotion, sampleClip } from './clips'
import { blendPose, newPose, type Pose } from './pose'
import type { Rig } from './rig'
import type { SwordTrail } from './trail'

/** Anything with a Rig that an Avatar can animate. */
export interface CharacterModel {
  /** Clip set name registered with registerClipSet. */
  set: string
  rig: Rig
  /** Identity-transform group: holds the rig plus world-space cloth and trails. */
  container: THREE.Group
  materials: THREE.MeshStandardMaterial[]
  skeleton: THREE.Skeleton
  meshes: THREE.SkinnedMesh[]
  swordBase: THREE.Object3D
  swordTip: THREE.Object3D
  capes: Cape[]
  trail: SwordTrail | null
  scale: number
  /** Stride length in metres at walking pace. */
  stepLen: number
}

export interface AvatarState {
  x: number
  y: number
  z: number
  yaw: number
  speed: number
  /** Direction of travel relative to facing. */
  moveAngle: number
  turnRate: number
  /** Clip to play, or null for locomotion. */
  action: string | null
  actionT: number
  time: number
  trail: boolean
  /** How fast the pose chases its target (higher = snappier). */
  sharpness?: number
  flash?: number
  dissolve?: number
  windX?: number
  windZ?: number
  /** Simulation step for cloth (lets cloth keep moving in slow motion). */
  clothDt?: number
  /** Ground height the cloth rests on (default 0). */
  floor?: number
}

const _base = new THREE.Vector3()
const _tip = new THREE.Vector3()

export class Avatar {
  readonly model: CharacterModel
  readonly pose: Pose = newPose()
  private loco = newPose()
  private act = newPose()
  private target = newPose()
  private phase = Math.random() * 6
  private lastStep = 0
  private first = true
  onStep?: (foot: 0 | 1, pos: THREE.Vector3) => void
  private flashV = -1
  private dissolveV = -1

  constructor(model: CharacterModel) {
    this.model = model
  }

  get root() {
    return this.model.rig.root
  }

  update(dt: number, st: AvatarState) {
    const m = this.model
    const rig = m.rig
    rig.root.position.set(st.x, st.y, st.z)
    rig.root.rotation.set(0, st.yaw, 0)

    const gait = getClipSet(m.set).loco.gait
    const stepLen = m.stepLen * (1 + Math.min(1, st.speed / gait) * 0.9)
    this.phase += (st.speed / stepLen) * Math.PI * dt
    const stepIdx = Math.floor(this.phase / Math.PI)
    if (stepIdx !== this.lastStep) {
      this.lastStep = stepIdx
      if (st.speed > 0.5 && !st.action && st.y < 0.05) this.onStep?.((stepIdx & 1) as 0 | 1, rig.root.position)
    }

    locomotion(this.loco, m.set, {
      phase: this.phase,
      speed: st.speed,
      moveAngle: st.moveAngle,
      turnRate: st.turnRate,
      time: st.time,
    })

    let sharp = 12
    const clip = st.action ? getClip(m.set, st.action) : null
    if (clip) {
      sampleClip(this.act, clip, st.actionT, this.loco, getClipSet(m.set).stance)
      this.target.set(this.act)
      sharp = st.sharpness ?? 30
    } else {
      this.target.set(this.loco)
    }
    if (this.first) {
      this.pose.set(this.target)
      this.first = false
    } else {
      blendPose(this.pose, this.pose, this.target, damp(sharp, dt))
    }
    rig.apply(this.pose)
    rig.root.updateMatrixWorld(true)

    const cdt = st.clothDt ?? dt
    for (const c of m.capes) c.update(cdt, st.windX ?? 1.2, st.windZ ?? -0.6, st.floor ?? 0)

    if (m.trail) {
      m.swordBase.getWorldPosition(_base)
      m.swordTip.getWorldPosition(_tip)
      m.trail.update(dt, _base, _tip, st.trail)
    }

    const flash = st.flash ?? 0
    const dis = st.dissolve ?? 0
    if (flash !== this.flashV || dis !== this.dissolveV) {
      this.flashV = flash
      this.dissolveV = dis
      for (const mat of m.materials) {
        const u = sdUniforms(mat)
        if (!u) continue
        u.uFlash.value = flash
        u.uDissolve.value = dis
      }
    }
  }

  getBlade(base: THREE.Vector3, tip: THREE.Vector3) {
    this.model.swordBase.getWorldPosition(base)
    this.model.swordTip.getWorldPosition(tip)
  }

  /** World position of the chest. */
  getChest(out: THREE.Vector3) {
    return this.model.rig.chest.getWorldPosition(out)
  }

  resetCloth() {
    for (const c of this.model.capes) c.reset()
  }
}
