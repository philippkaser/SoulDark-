import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { shapeBounds, shapeHitsSphere, type Shape } from '../../engine/geom'
import { angleDiff, TAU, turnToward } from '../../engine/math'
import type { Game, System } from '../Game'
import { newHitId, type Hit } from '../types'
import { soldierDepthMaterial, soldierGeometry, soldierMaterial } from './soldierGeo'

const enum St {
  Free = 0,
  March = 1,
  Fight = 2,
  Flying = 3,
  Dying = 4,
}

export const SPEAR = 0
export const ARCHER = 1

/** How fast soldiers can climb out of a crater (m/s up the wall). */
const CLIMB = 2.8
const CELL = 3
const GRID = 240 // cells per side (720 m)
const HALF = (GRID * CELL) / 2

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _v = new THREE.Vector3()

export interface LegionOpts {
  x: number
  z: number
  rows: number
  cols: number
  spacing?: number
  type?: number
  /** Fraction of archers mixed into the back ranks. */
  archers?: number
}

/**
 * The Legion: thousands of soldiers in one instanced draw call, animated in
 * the vertex shader. They march in formation, charge, stab, loose arrows,
 * and fly very far when struck.
 */
export class Horde implements System {
  readonly root = new THREE.Group()
  readonly capacity: number
  private mesh: THREE.InstancedMesh
  private aAnim: THREE.InstancedBufferAttribute
  private game: Game
  // state (struct of arrays)
  readonly px: Float32Array
  readonly pz: Float32Array
  private py: Float32Array
  private vx: Float32Array
  private vy: Float32Array
  private vz: Float32Array
  private yaw: Float32Array
  readonly st: Uint8Array
  readonly type: Uint8Array
  private phase: Float32Array
  private timer: Float32Array
  private prog: Float32Array
  private burn: Float32Array
  private spinX: Float32Array
  private spinZ: Float32Array
  private rotX: Float32Array
  private rotZ: Float32Array
  private offX: Float32Array
  private offZ: Float32Array
  private stride: Float32Array
  private bounced: Uint8Array
  private drawing: Uint8Array
  // spatial grid
  private head: Int32Array
  private next: Int32Array
  private free: number[] = []
  alive = 0
  archersAlive = 0
  /** Seconds until the archers loose a volley. */
  volleyIn = 8
  volleyEvery = 7
  /** Fired by the archers; the Arrows system listens. */
  onLoose?: (fromX: number, fromZ: number, idx: number) => void
  private killsThisFrame = 0
  private killAt = new THREE.Vector3()
  /** Counts kills toward wave objectives. */
  killed = 0
  archersKilled = 0

  constructor(game: Game, capacity: number) {
    this.game = game
    this.capacity = capacity
    const n = capacity
    this.px = new Float32Array(n)
    this.pz = new Float32Array(n)
    this.py = new Float32Array(n)
    this.vx = new Float32Array(n)
    this.vy = new Float32Array(n)
    this.vz = new Float32Array(n)
    this.yaw = new Float32Array(n)
    this.st = new Uint8Array(n)
    this.type = new Uint8Array(n)
    this.phase = new Float32Array(n)
    this.timer = new Float32Array(n)
    this.prog = new Float32Array(n)
    this.burn = new Float32Array(n)
    this.spinX = new Float32Array(n)
    this.spinZ = new Float32Array(n)
    this.rotX = new Float32Array(n)
    this.rotZ = new Float32Array(n)
    this.offX = new Float32Array(n)
    this.offZ = new Float32Array(n)
    this.stride = new Float32Array(n)
    this.bounced = new Uint8Array(n)
    this.drawing = new Uint8Array(n)
    this.head = new Int32Array(GRID * GRID)
    this.next = new Int32Array(n)
    const geo = soldierGeometry()
    this.aAnim = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
    this.aAnim.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aAnim', this.aAnim)
    this.mesh = new THREE.InstancedMesh(geo, soldierMaterial(), n)
    this.mesh.customDepthMaterial = soldierDepthMaterial()
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.castShadow = game.q >= 0.75
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.root.add(this.mesh)
    this.reset()
  }

  reset() {
    this.st.fill(St.Free)
    this.free = []
    for (let i = this.capacity - 1; i >= 0; i--) this.free.push(i)
    this.alive = 0
    this.archersAlive = 0
    this.killed = 0
    this.archersKilled = 0
    this.volleyIn = 8
    this.mesh.count = 0
  }

  get freeSlots() {
    return this.free.length
  }

  /** A formation marching in from (x, z) toward the hero. */
  spawnLegion(o: LegionOpts) {
    const sp = o.spacing ?? 1.6
    const p = this.game.player.pos
    const face = Math.atan2(p.x - o.x, p.z - o.z)
    const cs = Math.cos(face)
    const sn = Math.sin(face)
    let made = 0
    for (let r = 0; r < o.rows; r++) {
      for (let c = 0; c < o.cols; c++) {
        const i = this.free.pop()
        if (i === undefined) return made
        // formation offset: columns across, rows behind
        const lx = (c - (o.cols - 1) / 2) * sp + (Math.random() - 0.5) * 0.4
        const lz = -r * sp + (Math.random() - 0.5) * 0.4
        const x = o.x + lx * cs + lz * sn
        const z = o.z - lx * sn + lz * cs
        const archer = o.type === ARCHER || (o.archers ?? 0) > 0 && r >= o.rows * (1 - (o.archers ?? 0))
        this.px[i] = x
        this.pz[i] = z
        this.py[i] = this.game.terrain.heightAt(x, z)
        this.vx[i] = this.vy[i] = this.vz[i] = 0
        this.yaw[i] = face
        this.st[i] = St.March
        this.type[i] = archer ? ARCHER : SPEAR
        this.phase[i] = Math.random() * TAU
        this.timer[i] = Math.random()
        this.prog[i] = 0
        this.burn[i] = 0
        this.offX[i] = lx
        this.offZ[i] = lz
        this.stride[i] = 0.9 + Math.random() * 0.25
        this.bounced[i] = 0
        this.drawing[i] = 0
        this.rotX[i] = this.rotZ[i] = 0
        this.alive++
        if (archer) this.archersAlive++
        made++
      }
    }
    return made
  }

  private kill(i: number, hit: Hit, hx: number, hz: number) {
    const wasArcher = this.type[i] === ARCHER
    this.alive--
    this.killed++
    if (wasArcher) {
      this.archersAlive--
      this.archersKilled++
    }
    this.killsThisFrame++
    this.killAt.set(this.px[i], this.py[i] + 1, this.pz[i])
    const vaporize = hit.kind === 'beam' || hit.kind === 'judgment' || (hit.kind === 'heaven' && Math.random() < 0.5)
    if (vaporize) {
      this.st[i] = St.Dying
      this.timer[i] = 0.7
      this.burn[i] = 1.4
      if (Math.random() < 0.5) this.game.fx.vaporize(_p.set(this.px[i], this.py[i], this.pz[i]), true)
      return
    }
    // thrown: away from the blow, high into the air
    let dx: number
    let dz: number
    if (hit.dir && hit.kind !== 'slam' && hit.kind !== 'blast') {
      dx = hit.dir.x + (this.px[i] - hx) * 0.15
      dz = hit.dir.z + (this.pz[i] - hz) * 0.15
    } else {
      dx = this.px[i] - hit.origin.x
      dz = this.pz[i] - hit.origin.z
    }
    const l = Math.hypot(dx, dz) || 1
    const pw = hit.power * (0.6 + Math.random() * 0.7)
    this.vx[i] = (dx / l) * pw
    this.vz[i] = (dz / l) * pw
    this.vy[i] = hit.power * (0.45 + Math.random() * 0.6) + 3
    this.py[i] += 0.2
    this.spinX[i] = (Math.random() - 0.5) * 18
    this.spinZ[i] = (Math.random() - 0.5) * 18
    this.st[i] = St.Flying
    this.bounced[i] = 0
    this.burn[i] = hit.kind === 'blast' || hit.kind === 'slam' ? 0.6 : 0.25
    if (Math.random() < 0.35) this.game.fx.vaporize(_p.set(this.px[i], this.py[i], this.pz[i]), false)
  }

  damage(shape: Shape, hit: Hit): number {
    const [x0, z0, x1, z1] = shapeBounds(shape)
    const cx0 = Math.max(0, Math.floor((x0 + HALF) / CELL))
    const cz0 = Math.max(0, Math.floor((z0 + HALF) / CELL))
    const cx1 = Math.min(GRID - 1, Math.floor((x1 + HALF) / CELL))
    const cz1 = Math.min(GRID - 1, Math.floor((z1 + HALF) / CELL))
    let n = 0
    const hx = (x0 + x1) / 2
    const hz = (z0 + z1) / 2
    for (let gz = cz0; gz <= cz1; gz++) {
      for (let gx = cx0; gx <= cx1; gx++) {
        let i = this.head[gz * GRID + gx]
        while (i >= 0) {
          const nx = this.next[i]
          const s = this.st[i]
          if ((s === St.March || s === St.Fight) && shapeHitsSphere(shape, this.px[i], this.py[i] + 0.95, this.pz[i], 0.55)) {
            if (hit.dmg >= 40) {
              this.kill(i, hit, hx, hz)
              n++
            }
          }
          i = nx
        }
      }
    }
    return n
  }

  /** A point hit test (arrows, debris). Kills at most one soldier. */
  hitPoint(x: number, y: number, z: number, r: number, hit: Hit): boolean {
    const gx = Math.floor((x + HALF) / CELL)
    const gz = Math.floor((z + HALF) / CELL)
    if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID || y > 8.2) return false
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = gx + ox
        const cz = gz + oz
        if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) continue
        let i = this.head[cz * GRID + cx]
        while (i >= 0) {
          const s = this.st[i]
          if ((s === St.March || s === St.Fight) && y - this.py[i] < 2.2 && y - this.py[i] > -1 && Math.hypot(this.px[i] - x, this.pz[i] - z) < r + 0.45) {
            this.kill(i, hit, x, z)
            return true
          }
          i = this.next[i]
        }
      }
    }
    return false
  }

  points(out: THREE.Vector3[]) {
    let k = 0
    for (let i = 0; i < this.capacity && k < 80; i += 7) {
      const s = this.st[i]
      if (s === St.March || s === St.Fight) {
        out.push(new THREE.Vector3(this.px[i], this.py[i] + 1, this.pz[i]))
        k++
      }
    }
  }

  /** Is there an archer near enough to be the source of reflected arrows? */
  archerPos(i: number, out: THREE.Vector3) {
    return out.set(this.px[i], this.py[i] + 1.4, this.pz[i])
  }

  isAliveArcher(i: number) {
    return this.type[i] === ARCHER && (this.st[i] === St.March || this.st[i] === St.Fight)
  }

  private rebuildGrid() {
    this.head.fill(-1)
    for (let i = 0; i < this.capacity; i++) {
      const s = this.st[i]
      if (s !== St.March && s !== St.Fight) continue
      const gx = Math.floor((this.px[i] + HALF) / CELL)
      const gz = Math.floor((this.pz[i] + HALF) / CELL)
      if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) continue
      const c = gz * GRID + gx
      this.next[i] = this.head[c]
      this.head[c] = i
    }
  }

  update(dt: number) {
    const g = this.game
    const pl = g.player
    const ppx = pl.pos.x
    const ppz = pl.pos.z
    const hold = g.ceasefire || !pl.alive
    const terrain = g.terrain
    this.rebuildGrid()
    const obstacles = g.obstacles()

    // archers: a coordinated volley
    if (this.archersAlive > 0 && !hold) {
      this.volleyIn -= dt
      if (this.volleyIn <= 1.0 && this.volleyIn + dt > 1.0) {
        for (let i = 0; i < this.capacity; i++) if (this.type[i] === ARCHER && this.st[i] === St.Fight) this.drawing[i] = 1
      }
      if (this.volleyIn <= 0) {
        this.volleyIn = this.volleyEvery + Math.random() * 2
        let n = 0
        for (let i = 0; i < this.capacity; i++) {
          if (this.drawing[i]) {
            this.drawing[i] = 0
            if (this.st[i] === St.Fight && n < 220) {
              this.onLoose?.(this.px[i], this.pz[i], i)
              n++
            }
          }
        }
        if (n) audio.volley({ x: ppx, z: ppz - 50 })
      }
    }

    let hitsOnPlayer = 0
    for (let i = 0; i < this.capacity; i++) {
      const s = this.st[i]
      if (s === St.Free) continue
      if (s === St.March || s === St.Fight) {
        const archer = this.type[i] === ARCHER
        const dx = ppx - this.px[i]
        const dz = ppz - this.pz[i]
        const d = Math.hypot(dx, dz) || 1
        let tx = dx / d
        let tz = dz / d
        let speed = 0
        if (archer) {
          // hold at bow range, facing the hero
          if (d > 62) speed = 4
          else if (d < 38) speed = -2.5
          if (d < 75) this.st[i] = St.Fight
        } else if (d > 55) {
          // march in formation: steer toward the hero offset by the formation slot
          const face = Math.atan2(dx, dz)
          const cs = Math.cos(face)
          const sn = Math.sin(face)
          const gx = ppx + this.offX[i] * cs + this.offZ[i] * sn * 0.3
          const gz = ppz - this.offX[i] * sn + this.offZ[i] * cs * 0.3
          const ex = gx - this.px[i]
          const ez = gz - this.pz[i]
          const el = Math.hypot(ex, ez) || 1
          tx = ex / el
          tz = ez / el
          speed = 5.2 * this.stride[i]
        } else if (d > 1.7) {
          speed = 8 * this.stride[i]
          this.st[i] = St.Fight
        } else {
          speed = 0
          this.st[i] = St.Fight
        }
        if (hold) speed = 0
        const x0 = this.px[i]
        const z0 = this.pz[i]
        let mvx = tx * speed
        let mvz = tz * speed
        // separation from neighbours
        const gx = Math.floor((this.px[i] + HALF) / CELL)
        const gz = Math.floor((this.pz[i] + HALF) / CELL)
        for (let oz = -1; oz <= 1; oz++) {
          for (let ox = -1; ox <= 1; ox++) {
            const cx = gx + ox
            const cz = gz + oz
            if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) continue
            let j = this.head[cz * GRID + cx]
            while (j >= 0) {
              if (j !== i) {
                const ax = this.px[i] - this.px[j]
                const az = this.pz[i] - this.pz[j]
                const a2 = ax * ax + az * az
                if (a2 < 1.1 && a2 > 1e-6) {
                  const a = Math.sqrt(a2)
                  const push = (1.05 - a) * 6
                  mvx += (ax / a) * push
                  mvz += (az / a) * push
                }
              }
              j = this.next[j]
            }
          }
        }
        // ...and from the hero's body
        if (d < 1.2) {
          mvx -= tx * (1.2 - d) * 10
          mvz -= tz * (1.2 - d) * 10
        }
        this.px[i] += mvx * dt
        this.pz[i] += mvz * dt
        for (const o of obstacles) {
          const ox = this.px[i] - o.x
          const oz = this.pz[i] - o.z
          const od = Math.hypot(ox, oz)
          const rr = o.r + 0.4
          if (od < rr && od > 1e-4) {
            this.px[i] = o.x + (ox / od) * rr
            this.pz[i] = o.z + (oz / od) * rr
          }
        }
        // stand on the terrain: crater walls are climbed slowly, drops are fallen into
        let gy = terrain.heightAt(this.px[i], this.pz[i])
        const rise = gy - this.py[i]
        if (rise > CLIMB * dt) {
          const f = (CLIMB * dt) / rise
          this.px[i] = x0 + (this.px[i] - x0) * f
          this.pz[i] = z0 + (this.pz[i] - z0) * f
          gy = terrain.heightAt(this.px[i], this.pz[i])
        }
        this.py[i] = gy < this.py[i] ? Math.max(gy, this.py[i] - 16 * dt) : gy
        this.yaw[i] = turnToward(this.yaw[i], Math.atan2(dx, dz), 5 * dt)
        const moving = Math.hypot(mvx, mvz)
        this.phase[i] += moving * dt * 3.2
        // stab the hero
        if (!archer && d < 2.1 && !hold) {
          this.timer[i] += dt
          this.prog[i] = (this.timer[i] % 1.3) / 0.6
          const cyc = this.timer[i] % 1.3
          if (cyc >= 0.33 && cyc - dt < 0.33 && Math.abs(angleDiff(this.yaw[i], Math.atan2(dx, dz))) < 0.6) hitsOnPlayer++
        } else if (this.drawing[i]) {
          this.prog[i] = Math.min(1, this.prog[i] + dt)
        } else {
          this.prog[i] = 0
          this.timer[i] = Math.random() * 0.3
        }
      } else if (s === St.Flying) {
        this.vy[i] -= 26 * dt
        this.px[i] += this.vx[i] * dt
        this.py[i] += this.vy[i] * dt
        this.pz[i] += this.vz[i] * dt
        this.rotX[i] += this.spinX[i] * dt
        this.rotZ[i] += this.spinZ[i] * dt
        this.phase[i] += dt * 6
        this.burn[i] = Math.max(0, this.burn[i] - dt * 0.6)
        const gy = terrain.heightAt(this.px[i], this.pz[i])
        if (this.py[i] <= gy && this.vy[i] < 0) {
          this.py[i] = gy
          if (!this.bounced[i] && this.vy[i] < -10) {
            this.bounced[i] = 1
            this.vy[i] *= -0.25
            this.vx[i] *= 0.4
            this.vz[i] *= 0.4
            if (Math.random() < 0.25) g.fx.dust(_p.set(this.px[i], gy + 0.2, this.pz[i]), 1, 0.6, 0.9)
          } else {
            this.st[i] = St.Dying
            this.timer[i] = 0.6
          }
        }
      } else if (s === St.Dying) {
        this.timer[i] -= dt
        this.burn[i] = Math.max(this.burn[i] * 0.98, 0.5)
        if (this.timer[i] <= 0) {
          this.st[i] = St.Free
          this.free.push(i)
        }
      }
    }

    if (hitsOnPlayer > 0) this.stabPlayer(hitsOnPlayer)
    if (this.killsThisFrame > 0) {
      g.score.kill('soldier', this.killsThisFrame, this.killAt)
      pl.gainDivinity(this.killsThisFrame * 0.6)
      audio.felled(this.killAt, this.killsThisFrame)
      this.killsThisFrame = 0
    }
    this.writeInstances()
  }

  private stabPlayer(n: number) {
    const g = this.game
    const pl = g.player
    if (pl.untouchable) return
    const from = _v.set(pl.pos.x, 0, pl.pos.z - 1)
    const r = pl.defend('small', from, true)
    if (r === 'perfect' || r === 'guard') {
      // the shield of light throws them back
      g.damage({ t: 'sphere', c: pl.pos, r: 3.2 }, { id: newHitId(), kind: 'parry', dmg: 100, power: r === 'perfect' ? 24 : 12, origin: pl.pos, friendly: true })
      return
    }
    pl.hurt(7 * n, from)
    audio.spearHit()
  }

  private writeInstances() {
    const a = this.aAnim.array as Float32Array
    let k = 0
    for (let i = 0; i < this.capacity; i++) {
      const s = this.st[i]
      if (s === St.Free) continue
      let scale = 1
      if (s === St.Dying) scale = Math.max(0.01, this.timer[i] / 0.6)
      if (s === St.Flying || s === St.Dying) _e.set(this.rotX[i], this.yaw[i], this.rotZ[i])
      else _e.set(0, this.yaw[i], 0)
      _q.setFromEuler(_e)
      _p.set(this.px[i], this.py[i] + (s === St.Flying ? 0.9 : 0), this.pz[i])
      if (s === St.Flying) {
        // rotate about the body's centre, not its feet
        _v.set(0, -0.9, 0).applyQuaternion(_q)
        _p.add(_v)
      }
      _s.setScalar(scale)
      _m.compose(_p, _q, _s)
      this.mesh.setMatrixAt(k, _m)
      let mode = 4
      if (s === St.March) mode = 0
      else if (s === St.Fight) mode = this.type[i] === ARCHER ? (this.drawing[i] ? 3 : 4) : this.prog[i] > 0 ? 1 : 0
      else mode = 2
      if (s === St.Fight && this.type[i] === SPEAR && this.prog[i] === 0) mode = 0
      a[k * 4] = this.phase[i]
      a[k * 4 + 1] = mode + 8 * this.type[i]
      a[k * 4 + 2] = this.prog[i]
      a[k * 4 + 3] = this.burn[i]
      k++
    }
    this.mesh.count = k
    this.mesh.instanceMatrix.needsUpdate = true
    this.aAnim.needsUpdate = true
  }
}
