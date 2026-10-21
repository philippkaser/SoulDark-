import * as THREE from 'three'
import { clamp, damp } from '../engine/math'
import type { GroundSampler } from './world/terrain'

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
const _off = new THREE.Vector3()
const _kd = new THREE.Vector3()

const DEG = Math.PI / 180
/** Share of a dolly spent widening the lens; the rest eases it back. */
const DOLLY_ATTACK = 0.3
/** The dolly keeps a subject this far away (or nearer) the same size. */
const DOLLY_SUBJECT = 14

/** Dolly-zoom amount (0..1) at normalised time `u`: a fast ease-out rise, then a smooth return. */
export function dollyEnvelope(u: number) {
  if (u <= 0 || u >= 1) return 0
  if (u < DOLLY_ATTACK) {
    const a = 1 - u / DOLLY_ATTACK
    return 1 - a * a
  }
  const v = (u - DOLLY_ATTACK) / (1 - DOLLY_ATTACK)
  return 1 - v * v * (3 - 2 * v)
}

/** Distance factor that keeps a subject the same size when the FOV goes from `fov0` to `fov1` (degrees). */
export function dollyScale(fov0: number, fov1: number) {
  return Math.tan(fov0 * 0.5 * DEG) / Math.tan(fov1 * 0.5 * DEG)
}

/**
 * How far the camera moves toward its look point (negative: away) when the
 * lens goes from `fov0` to `fov1`, so a subject up to DOLLY_SUBJECT away keeps
 * its size. Never closer than 1.2 m to the look point.
 */
export function dollyMove(fov0: number, fov1: number, lookDist: number) {
  const sd = Math.min(lookDist, DOLLY_SUBJECT)
  return Math.min(sd - sd * dollyScale(fov0, fov1), lookDist - 1.2)
}

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
  private dollyDeg = 0
  private dollyT = 0
  private dollyDur = 0
  /** The terrain: the camera stays above it and the aim ray lands on it (flat y = 0 when unset). */
  ground: GroundSampler | null = null
  private lift = 0

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

  /** Punch the camera away from a world point (a blast, an impact), with a little lift. */
  kickFrom(from: THREE.Vector3, amount: number) {
    _kd.subVectors(this.pos, from).setY(0)
    if (_kd.lengthSq() < 1e-6) _kd.set(0, 0, 1)
    _kd.normalize().setY(0.35)
    this.kick(_kd, amount)
  }

  /**
   * Vertigo dolly-zoom: the lens widens by `amountDeg` while the camera moves
   * in, so the subject keeps its size and the world stretches away behind it.
   * Negative narrows the lens and pulls back. Rises over the first third of
   * `dur` (real seconds), then eases home. A weaker request never cuts a
   * stronger one short.
   */
  dolly(amountDeg: number, dur = 1) {
    const cur = this.dollyAmount
    if (Math.abs(amountDeg) < Math.abs(cur) || amountDeg === 0) return
    this.dollyDeg = amountDeg
    this.dollyDur = Math.max(0.05, dur)
    // start the rise where the current one is, so a re-trigger never pops
    const k = clamp(cur / amountDeg, 0, 0.999)
    this.dollyT = this.dollyDur * DOLLY_ATTACK * (1 - Math.sqrt(1 - k))
  }

  /** Current dolly-zoom FOV offset in degrees. */
  get dollyAmount() {
    return this.dollyDur > 0 ? this.dollyDeg * dollyEnvelope(this.dollyT / this.dollyDur) : 0
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
    const floor = (this.ground ? this.ground.heightAt(_gp.x, _gp.z) : 0) + 0.45
    _gp.y = Math.max(floor, _gp.y)
    // when looking up, keep the camera low behind the hero
    if (this.pitch < 0) _gp.y = Math.max(floor, _gp.y + this.pitch * 1.5)
    // in a crater or a canyon: rise until the line to the hero clears the rim
    if (this.ground) {
      let lift = 0
      // sight line from the hero's knees, so the whole body stays in view
      const ky = _gl.y - 1.2
      for (let i = 0; i < 5; i++) {
        const t = 0.4 + i * 0.15
        const h = this.ground.heightAt(_gl.x + (_gp.x - _gl.x) * t, _gl.z + (_gp.z - _gl.z) * t) + 0.5
        const y = ky + (_gp.y - ky) * t
        if (h > y) lift = Math.max(lift, (h - y) / t)
      }
      this.lift += (lift - this.lift) * (this.ready ? damp(lift > this.lift ? 14 : 3, rdt) : 1)
      _gp.y += this.lift
    }
    let fov = 62 + this.fovKick

    // cinematic override (with blends)
    const shot = this.shot
    if (shot) {
      this.shotT += rdt
      // a shot may end itself from inside its own frame
      const sf = shot.frame(this.shotT, _sp, _sl)
      // never film from under the ground
      _sp.y = Math.max(_sp.y, (this.ground ? this.ground.heightAt(_sp.x, _sp.z) : 0) + 1.2)
      const kin = shot.blendIn > 0 ? clamp(this.shotT / shot.blendIn, 0, 1) : 1
      const k = kin * kin * (3 - 2 * kin)
      _gp.lerp(_sp, k)
      _gl.lerp(_sl, k)
      fov += (sf - fov) * k
      if (this.shot === shot && this.shotT >= shot.dur) this.stopShot()
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

    this.fovKick *= Math.exp(-rdt * 5)
    this.fov += (fov - this.fov) * damp(10, rdt)
    let fovOut = this.fov
    if (this.dollyDur > 0) {
      this.dollyT += rdt
      if (this.dollyT >= this.dollyDur) this.dollyDur = 0
      else {
        fovOut = clamp(this.fov + this.dollyAmount, 15, 150)
        // move along the view line so the subject keeps its size
        _off.subVectors(this.look, this.pos)
        const d = _off.length()
        if (d > 1e-3) this.pos.addScaledVector(_off, dollyMove(this.fov, fovOut, d) / d)
        this.pos.y = Math.max((this.ground ? this.ground.heightAt(this.pos.x, this.pos.z) : 0) + 0.45, this.pos.y)
      }
    }

    cam.position.set(this.pos.x + sx + this.punch.x, this.pos.y + sy + this.punch.y, this.pos.z + this.punch.z)
    cam.lookAt(this.look)
    cam.rotateZ(roll)

    if (Math.abs(cam.fov - fovOut) > 0.01) {
      cam.fov = fovOut
      cam.updateProjectionMatrix()
    }
    this.ready = true

    // aim ray through the screen centre
    cam.updateMatrixWorld()
    this.aimOrigin.copy(cam.position)
    cam.getWorldDirection(this.aimDir)
    const far = 420
    if (this.ground) {
      this.aimPoint.copy(this.aimOrigin).addScaledVector(this.aimDir, this.groundHit(this.aimOrigin, this.aimDir, far, this.ground))
    } else if (this.aimDir.y < -0.01) {
      const tHit = -this.aimOrigin.y / this.aimDir.y
      this.aimPoint.copy(this.aimOrigin).addScaledVector(this.aimDir, Math.min(far, tHit))
    } else {
      this.aimPoint.copy(this.aimOrigin).addScaledVector(this.aimDir, far)
    }
  }

  /** Distance along a ray to the terrain (march, then bisect), or `far`. */
  private groundHit(o: THREE.Vector3, d: THREE.Vector3, far: number, ground: GroundSampler) {
    const above = (t: number) => o.y + d.y * t - ground.heightAt(o.x + d.x * t, o.z + d.z * t)
    let t0 = 0
    let t = 0
    while (t < far) {
      t = Math.min(far, t + 0.5 + t * 0.03)
      if (above(t) < 0) {
        for (let i = 0; i < 8; i++) {
          const m = (t0 + t) / 2
          if (above(m) < 0) t = m
          else t0 = m
        }
        return t
      }
      // rising above anything the terrain can reach: no hit
      if (d.y >= 0 && o.y + d.y * t > 8) break
      t0 = t
    }
    return far
  }

  /** Horizontal yaw the camera is facing. */
  get aimYaw() {
    return Math.atan2(this.aimDir.x, this.aimDir.z)
  }
}
