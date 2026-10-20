import * as THREE from 'three'
import { clamp, damp } from '../engine/math'

/** A scripted camera move. `frame` writes position + look target and returns the FOV. */
export interface Shot {
  dur: number
  /** Seconds to blend in from (and back out to) the gameplay camera. */
  blendIn: number
  blendOut: number
  frame(t: number, pos: THREE.Vector3, look: THREE.Vector3): number
}

export interface CamSubject {
  pos: THREE.Vector3
  /** Extra framing distance (bigger fights pull the camera back). */
  framing: number
}

const _dir = new THREE.Vector3()
const _right = new THREE.Vector3()
const _sp = new THREE.Vector3()
const _sl = new THREE.Vector3()
const _gp = new THREE.Vector3()
const _gl = new THREE.Vector3()

/**
 * Over-the-shoulder action camera with trauma shake, FOV punches and
 * blended cinematic shots. Also owns the aim ray every attack follows.
 */
export class CameraRig {
  yaw = Math.PI
  pitch = 0.12
  dist = 6.5
  readonly focus = new THREE.Vector3()
  readonly pos = new THREE.Vector3()
  readonly look = new THREE.Vector3()
  /** Aim ray (from the camera through the crosshair) and where it lands. */
  readonly aimOrigin = new THREE.Vector3()
  readonly aimDir = new THREE.Vector3(0, 0, -1)
  readonly aimPoint = new THREE.Vector3()
  trauma = 0
  shakeScale = 1
  private fov = 62
  private fovKick = 0
  private time = 0
  private ready = false
  private shot: Shot | null = null
  private shotT = 0
  private outBlend = 0
  private outDur = 1
  private outFrom = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 62 }
  private punch = new THREE.Vector3()

  snap(pos: THREE.Vector3, yaw: number) {
    this.yaw = yaw
    this.pitch = 0.12
    this.focus.copy(pos).setY(pos.y + 1.6)
    this.ready = false
  }

  addTrauma(a: number) {
    this.trauma = Math.min(1.3, this.trauma + a * this.shakeScale)
  }

  kickFov(deg: number) {
    this.fovKick = Math.max(this.fovKick, deg)
  }

  /** Directional camera punch (recoil). */
  kick(dir: THREE.Vector3, amount: number) {
    this.punch.addScaledVector(dir, amount * this.shakeScale)
  }

  play(shot: Shot) {
    this.shot = shot
    this.shotT = 0
  }

  get cinematic() {
    return this.shot !== null
  }

  stopShot() {
    if (!this.shot) return
    this.outFrom.pos.copy(this.pos)
    this.outFrom.look.copy(this.look)
    this.outFrom.fov = this.fov
    this.outBlend = this.shot.blendOut
    this.outDur = Math.max(0.001, this.shot.blendOut)
    this.shot = null
  }

  update(rdt: number, lookX: number, lookY: number, subject: CamSubject, cam: THREE.PerspectiveCamera, steer: boolean) {
    this.time += rdt
    if (steer && !this.shot) {
      this.yaw -= lookX
      this.pitch = clamp(this.pitch + lookY, -0.75, 1.2)
    }

    // follow the subject with a little lag (more vertical lag for leaps)
    const kx = this.ready ? damp(16, rdt) : 1
    const ky = this.ready ? damp(7, rdt) : 1
    this.focus.x += (subject.pos.x - this.focus.x) * kx
    this.focus.z += (subject.pos.z - this.focus.z) * kx
    this.focus.y += (subject.pos.y + 1.65 - this.focus.y) * ky
    const want = 6.4 + subject.framing
    this.dist += (want - this.dist) * damp(2.5, rdt)

    _dir.set(Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch))
    _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw))
    const shoulder = 0.75
    _gl.copy(this.focus).addScaledVector(_right, shoulder)
    _gp.copy(_gl).addScaledVector(_dir, -this.dist)
    _gp.y = Math.max(0.45, _gp.y)
    // when looking up, keep the camera low behind the hero
    if (this.pitch < 0) _gp.y = Math.max(0.45, _gp.y + this.pitch * 1.5)
    let fov = 62 + this.fovKick

    // cinematic override (with blends)
    if (this.shot) {
      this.shotT += rdt
      const sf = this.shot.frame(this.shotT, _sp, _sl)
      const kin = this.shot.blendIn > 0 ? clamp(this.shotT / this.shot.blendIn, 0, 1) : 1
      const k = kin * kin * (3 - 2 * kin)
      _gp.lerp(_sp, k)
      _gl.lerp(_sl, k)
      fov += (sf - fov) * k
      if (this.shotT >= this.shot.dur) this.stopShot()
    } else if (this.outBlend > 0) {
      this.outBlend = Math.max(0, this.outBlend - rdt)
      const kk = Math.min(1, this.outBlend / this.outDur)
      const s = kk * kk * (3 - 2 * kk)
      _gp.lerp(this.outFrom.pos, s)
      _gl.lerp(this.outFrom.look, s)
      fov += (this.outFrom.fov - fov) * s
    }
    this.pos.copy(_gp)
    this.look.copy(_gl)

    // trauma shake + punch
    this.trauma = Math.max(0, this.trauma - rdt * 1.4)
    const tr = this.trauma * this.trauma
    const t = this.time * 38
    const sx = (Math.sin(t * 1.1) + Math.sin(t * 2.3 + 1.3) * 0.5) * tr * 0.28
    const sy = (Math.sin(t * 1.7 + 2.1) + Math.sin(t * 2.9) * 0.5) * tr * 0.28
    const roll = Math.sin(t * 0.9 + 0.4) * tr * 0.05
    this.punch.multiplyScalar(Math.exp(-rdt * 10))

    cam.position.set(this.pos.x + sx + this.punch.x, this.pos.y + sy + this.punch.y, this.pos.z + this.punch.z)
    cam.lookAt(this.look)
    cam.rotateZ(roll)

    this.fovKick *= Math.exp(-rdt * 5)
    this.fov += (fov - this.fov) * damp(10, rdt)
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov
      cam.updateProjectionMatrix()
    }
    this.ready = true

    // aim ray through the screen centre
    cam.updateMatrixWorld()
    this.aimOrigin.copy(cam.position)
    cam.getWorldDirection(this.aimDir)
    const far = 420
    if (this.aimDir.y < -0.01) {
      const tHit = -this.aimOrigin.y / this.aimDir.y
      this.aimPoint.copy(this.aimOrigin).addScaledVector(this.aimDir, Math.min(far, tHit))
    } else {
      this.aimPoint.copy(this.aimOrigin).addScaledVector(this.aimDir, far)
    }
  }

  /** Horizontal yaw the camera is facing. */
  get aimYaw() {
    return Math.atan2(this.aimDir.x, this.aimDir.z)
  }
}
