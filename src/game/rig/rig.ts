import * as THREE from 'three'
import { S, VI, type Pose } from './pose'

export interface RigDims {
  hipH: number
  thigh: number
  shin: number
  spine: number
  chest: number
  neck: number
  head: number
  shoulderX: number
  shoulderY: number
  upper: number
  fore: number
  hipX: number
  pivotH: number
  /** Distance between hands on a two-handed grip. */
  grip: number
}

export const HUMAN_DIMS: RigDims = {
  hipH: 0.95,
  thigh: 0.44,
  shin: 0.44,
  spine: 0.13,
  chest: 0.22,
  neck: 0.24,
  head: 0.07,
  shoulderX: 0.2,
  shoulderY: 0.16,
  upper: 0.29,
  fore: 0.27,
  hipX: 0.1,
  pivotH: 0.95,
  grip: 0.2,
}

const _S = new THREE.Vector3()
const _T = new THREE.Vector3()
const _P = new THREE.Vector3()
const _E = new THREE.Vector3()
const _D = new THREE.Vector3()
const _X = new THREE.Vector3()
const _Y = new THREE.Vector3()
const _Z = new THREE.Vector3()
const _FD = new THREE.Vector3()
const _B = new THREE.Vector3()
const _Ed = new THREE.Vector3()
const _M = new THREE.Matrix4()
const _qU = new THREE.Quaternion()
const _qF = new THREE.Quaternion()
const _qH = new THREE.Quaternion()
const _ax = new THREE.Vector3(1, 0, 0)

function group(name: string, parent: THREE.Object3D, x = 0, y = 0, z = 0) {
  const g = new THREE.Group()
  g.name = name
  g.position.set(x, y, z)
  parent.add(g)
  return g
}

/** A procedural humanoid skeleton made of nested Object3Ds. */
export class Rig {
  readonly dims: RigDims
  readonly root = new THREE.Group()
  readonly pivot: THREE.Group
  readonly hips: THREE.Group
  readonly legs: THREE.Group
  readonly spine: THREE.Group
  readonly chest: THREE.Group
  readonly neck: THREE.Group
  readonly head: THREE.Group
  readonly shoulderL: THREE.Group
  readonly elbowL: THREE.Group
  readonly handL: THREE.Group
  readonly shoulderR: THREE.Group
  readonly elbowR: THREE.Group
  readonly handR: THREE.Group
  readonly thighL: THREE.Group
  readonly kneeL: THREE.Group
  readonly footL: THREE.Group
  readonly thighR: THREE.Group
  readonly kneeR: THREE.Group
  readonly footR: THREE.Group

  constructor(dims: RigDims = HUMAN_DIMS) {
    this.dims = dims
    const d = dims
    this.pivot = group('pivot', this.root, 0, d.pivotH, 0)
    this.hips = group('hips', this.pivot, 0, d.hipH - d.pivotH, 0)
    this.legs = group('legs', this.hips)
    this.thighL = group('thighL', this.legs, d.hipX, -0.04, 0)
    this.kneeL = group('kneeL', this.thighL, 0, -d.thigh, 0)
    this.footL = group('footL', this.kneeL, 0, -d.shin, 0)
    this.thighR = group('thighR', this.legs, -d.hipX, -0.04, 0)
    this.kneeR = group('kneeR', this.thighR, 0, -d.thigh, 0)
    this.footR = group('footR', this.kneeR, 0, -d.shin, 0)
    this.spine = group('spine', this.hips, 0, d.spine, 0)
    this.chest = group('chest', this.spine, 0, d.chest, 0)
    this.neck = group('neck', this.chest, 0, d.neck, 0)
    this.head = group('head', this.neck, 0, d.head, 0)
    this.shoulderL = group('shoulderL', this.chest, d.shoulderX, d.shoulderY, 0)
    this.elbowL = group('elbowL', this.shoulderL, 0, -d.upper, 0)
    this.handL = group('handL', this.elbowL, 0, -d.fore, 0)
    this.shoulderR = group('shoulderR', this.chest, -d.shoulderX, d.shoulderY, 0)
    this.elbowR = group('elbowR', this.shoulderR, 0, -d.upper, 0)
    this.handR = group('handR', this.elbowR, 0, -d.fore, 0)
  }

  apply(p: Pose) {
    const d = this.dims
    this.pivot.position.set(0, d.pivotH + p[S.rootY], p[S.rootZ])
    this.pivot.rotation.set(p[S.pivotX], 0, p[S.pivotZ])
    this.hips.rotation.set(p[S.hipsX], p[S.hipsY], p[S.hipsZ])
    this.legs.rotation.set(0, p[S.lowerY], 0)
    this.spine.rotation.set(p[S.spineX], p[S.spineY], p[S.spineZ])
    this.chest.rotation.set(p[S.chestX], p[S.chestY], p[S.chestZ])
    this.neck.rotation.set(p[S.headX] * 0.4, p[S.headY] * 0.4, p[S.headZ] * 0.4)
    this.head.rotation.set(p[S.headX] * 0.6, p[S.headY] * 0.6, p[S.headZ] * 0.6)
    this.thighL.rotation.set(p[S.thighLX], 0, p[S.thighLZ])
    this.kneeL.rotation.set(p[S.kneeL], 0, 0)
    this.footL.rotation.set(p[S.footL], 0, 0)
    this.thighR.rotation.set(p[S.thighRX], 0, p[S.thighRZ])
    this.kneeR.rotation.set(p[S.kneeR], 0, 0)
    this.footR.rotation.set(p[S.footR], 0, 0)

    // right arm
    this.solveArm(
      this.shoulderR,
      this.elbowR,
      this.handR,
      p[VI.handR],
      p[VI.handR + 1],
      p[VI.handR + 2],
      p[VI.poleR],
      p[VI.poleR + 1],
      p[VI.poleR + 2],
      p[VI.bladeR],
      p[VI.bladeR + 1],
      p[VI.bladeR + 2],
      p[VI.edgeR],
      p[VI.edgeR + 1],
      p[VI.edgeR + 2],
    )

    // left arm, optionally gripping the same weapon two-handed
    let hx = p[VI.handL]
    let hy = p[VI.handL + 1]
    let hz = p[VI.handL + 2]
    let bx = p[VI.bladeL]
    let by = p[VI.bladeL + 1]
    let bz = p[VI.bladeL + 2]
    let ex = p[VI.edgeL]
    let ey = p[VI.edgeL + 1]
    let ez = p[VI.edgeL + 2]
    const th = p[S.twoHand]
    if (th > 0.001) {
      _B.set(p[VI.bladeR], p[VI.bladeR + 1], p[VI.bladeR + 2]).normalize()
      const gx = p[VI.handR] - _B.x * d.grip
      const gy = p[VI.handR + 1] - _B.y * d.grip
      const gz = p[VI.handR + 2] - _B.z * d.grip
      hx += (gx - hx) * th
      hy += (gy - hy) * th
      hz += (gz - hz) * th
      bx += (p[VI.bladeR] - bx) * th
      by += (p[VI.bladeR + 1] - by) * th
      bz += (p[VI.bladeR + 2] - bz) * th
      ex += (-p[VI.edgeR] - ex) * th
      ey += (-p[VI.edgeR + 1] - ey) * th
      ez += (-p[VI.edgeR + 2] - ez) * th
    }
    this.solveArm(
      this.shoulderL,
      this.elbowL,
      this.handL,
      hx,
      hy,
      hz,
      p[VI.poleL],
      p[VI.poleL + 1],
      p[VI.poleL + 2],
      bx,
      by,
      bz,
      ex,
      ey,
      ez,
    )
  }

  /** Analytic two-bone IK in chest space, plus hand orientation from blade/edge vectors. */
  private solveArm(
    shoulder: THREE.Object3D,
    elbow: THREE.Object3D,
    hand: THREE.Object3D,
    tx: number,
    ty: number,
    tz: number,
    px: number,
    py: number,
    pz: number,
    bx: number,
    by: number,
    bz: number,
    ex: number,
    ey: number,
    ez: number,
  ) {
    const a = this.dims.upper
    const b = this.dims.fore
    _S.copy(shoulder.position)
    _T.set(tx, ty, tz)
    _D.subVectors(_T, _S)
    let dist = _D.length()
    if (dist < 1e-4) {
      _D.set(0, -1, 0)
      dist = 1e-4
    }
    _D.divideScalar(dist)
    dist = Math.min(Math.max(dist, Math.abs(a - b) + 0.02), (a + b) * 0.999)
    const cosA = (a * a + dist * dist - b * b) / (2 * a * dist)
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA))
    _P.set(px, py, pz)
    _P.addScaledVector(_D, -_P.dot(_D))
    if (_P.lengthSq() < 1e-6) _P.set(0, -1, 0).addScaledVector(_D, -_D.y)
    _P.normalize()
    // elbow and (clamped) hand positions
    _E.copy(_S).addScaledVector(_D, cosA * a).addScaledVector(_P, sinA * a)
    _T.copy(_S).addScaledVector(_D, dist)

    _Y.subVectors(_S, _E).normalize()
    _FD.subVectors(_T, _E).normalize()
    _Z.copy(_FD).addScaledVector(_Y, -_FD.dot(_Y))
    if (_Z.lengthSq() < 1e-6) _Z.copy(_P).negate().addScaledVector(_Y, _P.dot(_Y))
    _Z.normalize()
    _X.crossVectors(_Y, _Z).normalize()
    _M.makeBasis(_X, _Y, _Z)
    _qU.setFromRotationMatrix(_M)
    shoulder.quaternion.copy(_qU)

    const fy = _FD.dot(_Y)
    const fz = _FD.dot(_Z)
    const theta = Math.atan2(-fz, -fy)
    elbow.quaternion.setFromAxisAngle(_ax, theta)
    _qF.copy(elbow.quaternion)

    // desired hand orientation in chest space
    _Z.set(bx, by, bz)
    if (_Z.lengthSq() < 1e-6) _Z.set(0, 0, 1)
    _Z.normalize()
    _Ed.set(ex, ey, ez)
    _Ed.addScaledVector(_Z, -_Ed.dot(_Z))
    if (_Ed.lengthSq() < 1e-6) _Ed.set(0, 1, 0).addScaledVector(_Z, -_Z.y)
    if (_Ed.lengthSq() < 1e-6) _Ed.set(1, 0, 0)
    _Ed.normalize()
    _X.crossVectors(_Ed, _Z).normalize()
    _M.makeBasis(_X, _Ed, _Z)
    _qH.setFromRotationMatrix(_M)
    _qU.multiply(_qF).invert()
    hand.quaternion.copy(_qU.multiply(_qH))
  }
}
