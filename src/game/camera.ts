import * as THREE from 'three'
import { collide, raycastTall } from '../../shared/collision'
import { BONFIRE, inArena } from '../../shared/level'
import { angleDiff, clamp, damp, yawTo } from '../../shared/math'
import type { InputFrame } from '../input/input'
import type { PlayerController } from './player/controller'
import { world } from './world'

const _dir = new THREE.Vector3()
const _look = new THREE.Vector3()

export class CameraController {
  yaw = Math.PI
  pitch = 0.2
  dist = 4.4
  focus = new THREE.Vector3()
  pos = new THREE.Vector3()
  private look = new THREE.Vector3()
  private fov = 55
  private time = 0
  private ready = false
  private collDist = 4.4

  snap(player: PlayerController) {
    this.yaw = player.yaw
    this.pitch = 0.2
    this.focus.set(player.x, 1.55, player.z)
    this.ready = false
  }

  update(dt: number, f: InputFrame, player: PlayerController, cam: THREE.PerspectiveCamera, inputEnabled: boolean) {
    this.time += dt
    const lock = player.lock?.targetable ? player.lock : null

    if (inputEnabled && !lock) {
      this.yaw -= f.lookX
      this.pitch = clamp(this.pitch + f.lookY, -0.4, 1.15)
    }

    if (lock) {
      const want = yawTo(player.x, player.z, lock.x, lock.z)
      this.yaw += angleDiff(this.yaw, want) * damp(7, dt)
      const big = lock.def.height > 3
      const d = Math.hypot(lock.x - player.x, lock.z - player.z)
      const wantPitch = clamp((big ? 0.3 : 0.2) + (big ? Math.max(0, 6 - d) * 0.04 : 0), 0.05, 0.6)
      this.pitch += (wantPitch - this.pitch) * damp(4, dt)
    } else if (!inputEnabled && !player.dead) {
      // gentle auto-follow when the mouse is free (menus)
    }

    // follow the player with a little lag
    const fy = 1.5 + (player.action === 'rest' ? -0.35 : 0)
    const kx = this.ready ? damp(14, dt) : 1
    const ky = this.ready ? damp(8, dt) : 1
    this.focus.x += (player.x - this.focus.x) * kx
    this.focus.z += (player.z - this.focus.z) * kx
    this.focus.y += (fy - this.focus.y) * ky

    const bossFight = world.flags.boss === 1 && inArena(player.x, player.z)
    const want = lock?.type === 'boss' || bossFight ? 6.2 : player.dead ? 5.5 : 4.4
    this.dist += (want - this.dist) * damp(2.5, dt)

    _dir.set(Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch))
    let tx = this.focus.x - _dir.x * this.dist
    let tz = this.focus.z - _dir.z * this.dist
    // pull in when a pillar is in the way
    const frac = raycastTall(this.focus.x, this.focus.z, tx, tz, 0.35)
    const wantColl = Math.max(0.9, this.dist * frac)
    this.collDist += (wantColl - this.collDist) * damp(wantColl < this.collDist ? 30 : 4, dt)
    if (!this.ready) this.collDist = wantColl
    tx = this.focus.x - _dir.x * this.collDist
    tz = this.focus.z - _dir.z * this.collDist
    let ty = this.focus.y - _dir.y * this.collDist
    ;[tx, tz] = collide(tx, tz, 0, { fogClosed: false, skipObstacles: true, zoneMargin: 3 })
    ty = Math.max(0.35, ty)
    this.pos.set(tx, ty, tz)

    // look point: between the player and the lock target
    this.look.copy(this.focus)
    if (lock) {
      _look.set(lock.x, lock.def.height * 0.55, lock.z)
      this.look.lerp(_look, lock.type === 'boss' ? 0.32 : 0.22)
    }

    // trauma-based shake
    world.shake = Math.max(0, world.shake - dt * 1.5)
    const tr = world.shake * world.shake
    const t = this.time * 40
    const sx = (Math.sin(t * 1.1) + Math.sin(t * 2.3 + 1.3) * 0.5) * tr * 0.18
    const sy = (Math.sin(t * 1.7 + 2.1) + Math.sin(t * 2.9) * 0.5) * tr * 0.18
    const roll = Math.sin(t * 0.9 + 0.4) * tr * 0.045

    cam.position.set(this.pos.x + sx, this.pos.y + sy, this.pos.z)
    cam.lookAt(this.look)
    cam.rotateZ(roll)

    const wantFov = player.sprinting ? 61 : 55
    this.fov += (wantFov - this.fov) * damp(4, dt)
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov
      cam.updateProjectionMatrix()
    }
    this.ready = true
    world.cameraYaw = this.yaw
    world.cameraPitch = this.pitch
  }

  /** Slow cinematic orbit around the bonfire for the title screen. */
  title(dt: number, cam: THREE.PerspectiveCamera) {
    this.time += dt
    const a = this.time * 0.05 + 2.4
    const r = 9.5
    cam.position.set(BONFIRE.x + Math.sin(a) * r, 2.6 + Math.sin(this.time * 0.2) * 0.3, BONFIRE.z + Math.cos(a) * r)
    cam.lookAt(BONFIRE.x, 1.4, BONFIRE.z)
    if (cam.fov !== 50) {
      cam.fov = 50
      cam.updateProjectionMatrix()
    }
    world.cameraYaw = a + Math.PI
    this.ready = false
  }
}
