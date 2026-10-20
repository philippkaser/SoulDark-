import * as THREE from 'three'
import { damp } from '../../../shared/math'
import { sdUniforms } from '../gfx/materials'
import { getClip, locomotion, sampleClip, type Archetype } from './clips'
import type { CharacterModel } from './models'
import { blendPose, newPose, S } from './pose'

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
  flask?: boolean
  flash?: number
  dissolve?: number
  windX?: number
  windZ?: number
}

const STEP_LEN: Record<Archetype, number> = { knight: 0.78, hollow: 0.62, fallen: 0.8, boss: 0.86 }
const GAIT: Record<Archetype, number> = { knight: 1, hollow: 1, fallen: 1, boss: 1.45 }

const _base = new THREE.Vector3()
const _tip = new THREE.Vector3()

export class Avatar {
  readonly model: CharacterModel
  readonly arche: Archetype
  private pose = newPose()
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
    this.arche = model.arche
  }

  get root() {
    return this.model.rig.root
  }

  update(dt: number, st: AvatarState) {
    const m = this.model
    const rig = m.rig
    rig.root.position.set(st.x, st.y, st.z)
    rig.root.rotation.set(0, st.yaw, 0)

    const stepLen = STEP_LEN[this.arche] * m.scale * (st.speed > 3 ? 1.45 : 1) * (st.speed > 5.5 ? 1.18 : 1)
    this.phase += (st.speed / stepLen) * Math.PI * dt
    const stepIdx = Math.floor(this.phase / Math.PI)
    if (stepIdx !== this.lastStep) {
      this.lastStep = stepIdx
      if (st.speed > 0.5 && !st.action) this.onStep?.((stepIdx & 1) as 0 | 1, rig.root.position)
    }

    locomotion(this.loco, this.arche, {
      phase: this.phase,
      speed: st.speed,
      moveAngle: st.moveAngle,
      turnRate: st.turnRate,
      time: st.time,
      gaitScale: GAIT[this.arche],
    })

    let sharp = 12
    const clip = st.action ? getClip(this.arche, st.action) : null
    if (clip) {
      sampleClip(this.act, clip, st.actionT, this.loco, this.loco)
      this.target.set(this.act)
      sharp = 30
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

    // tabard flaps follow the legs with a little sway
    const tl = this.pose[S.thighLX]
    const tr = this.pose[S.thighRX]
    const sway = Math.sin(st.time * 3.1) * 0.03
    if (m.flapFront) m.flapFront.rotation.x = Math.min(tl, tr, 0) * 0.8 + sway
    if (m.flapBack) m.flapBack.rotation.x = Math.max(tl, tr, 0) * 0.7 + 0.04 - sway

    if (m.flask) m.flask.visible = !!st.flask

    rig.root.updateMatrixWorld(true)
    m.cape?.update(dt, st.windX ?? 1.2, st.windZ ?? -0.6)

    m.swordBase.getWorldPosition(_base)
    m.swordTip.getWorldPosition(_tip)
    m.trail.update(dt, _base, _tip, st.trail)

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
      if (m.cape) m.cape.mesh.visible = dis < 0.6
    }
  }

  getBlade(base: THREE.Vector3, tip: THREE.Vector3) {
    this.model.swordBase.getWorldPosition(base)
    this.model.swordTip.getWorldPosition(tip)
  }

  /** World position of the chest (lock-on point, effects). */
  getChest(out: THREE.Vector3) {
    return this.model.rig.chest.getWorldPosition(out)
  }

  resetCloth() {
    this.model.cape?.reset()
  }
}
