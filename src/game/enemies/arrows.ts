import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { shapeHitsSphere, type Shape } from '../../engine/geom'
import type { Game, System } from '../Game'
import { newHitId, type Threat } from '../types'
import type { Horde } from './horde'

const enum A {
  Free = 0,
  Incoming = 1,
  Reflected = 2,
  Stuck = 3,
  Falling = 4,
}

const G = 20
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _d = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)
const _c = new THREE.Color()
const Z = new THREE.Vector3(0, 0, 1)

function arrowGeometry() {
  const shaft = new THREE.BoxGeometry(0.025, 0.025, 0.95)
  const head = new THREE.ConeGeometry(0.035, 0.12, 4).rotateX(Math.PI / 2).translate(0, 0, 0.53)
  const fl1 = new THREE.BoxGeometry(0.1, 0.004, 0.14).translate(0, 0, -0.4)
  const fl2 = new THREE.BoxGeometry(0.004, 0.1, 0.14).translate(0, 0, -0.4)
  const parts = [shaft, head, fl1, fl2].map((g) => (g.index ? g.toNonIndexed() : g))
  let n = 0
  for (const g of parts) n += g.attributes.position.count
  const pos = new Float32Array(n * 3)
  const nor = new Float32Array(n * 3)
  let o = 0
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, o * 3)
    nor.set(g.attributes.normal.array as Float32Array, o * 3)
    o += g.attributes.position.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  return out
}

/**
 * Arrow storms. A perfect parry opens a field that sends every arrow within
 * reach back to the archer who loosed it, cutting down the ranks in between.
 */
export class Arrows implements System {
  readonly root = new THREE.Group()
  private mesh: THREE.InstancedMesh
  private n: number
  private pos: Float32Array
  private vel: Float32Array
  private st: Uint8Array
  private owner: Int32Array
  private life: Float32Array
  private next = 0
  private game: Game
  private horde: Horde
  private fieldOpen = 0

  constructor(game: Game, horde: Horde, capacity: number) {
    this.game = game
    this.horde = horde
    this.n = capacity
    this.pos = new Float32Array(capacity * 3)
    this.vel = new Float32Array(capacity * 3)
    this.st = new Uint8Array(capacity)
    this.owner = new Int32Array(capacity)
    this.life = new Float32Array(capacity)
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 })
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifdef USE_INSTANCING_COLOR
        totalEmissiveRadiance += max(vColor.rgb - 1.0, 0.0) * 2.5;
        #endif`,
      )
    }
    mat.customProgramCacheKey = () => 'arrow-v1'
    this.mesh = new THREE.InstancedMesh(arrowGeometry(), mat, capacity)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, _c.setRGB(0.35, 0.28, 0.22))
    this.root.add(this.mesh)
    horde.onLoose = (x, z, idx) => this.fire(x, z, idx)
  }

  reset() {
    this.st.fill(A.Free)
    this.mesh.count = 0
  }

  fire(fx: number, fz: number, owner: number) {
    const i = this.next
    this.next = (this.next + 1) % this.n
    const p = this.game.player.pos
    // most arrows are aimed true, the rest blanket the ground around the hero
    const spread = Math.random() < 0.6 ? 1.6 : 7
    const a = Math.random() * Math.PI * 2
    const rr = Math.sqrt(Math.random()) * spread
    const tx = p.x + Math.sin(a) * rr
    const tz = p.z + Math.cos(a) * rr
    const ty = p.y + 1.2
    const T = 1.9 + Math.random() * 0.45
    const sy = this.game.terrain.heightAt(fx, fz) + 1.6
    this.pos.set([fx, sy, fz], i * 3)
    this.vel.set([(tx - fx) / T, (ty - sy) / T + 0.5 * G * T, (tz - fz) / T], i * 3)
    this.st[i] = A.Incoming
    this.owner[i] = owner
    this.life[i] = 6
  }

  private reflect(i: number) {
    const k = i * 3
    const o = this.owner[i]
    if (this.horde.isAliveArcher(o)) this.horde.archerPos(o, _p)
    else _p.set(this.pos[k] - this.vel[k], 1.2, this.pos[k + 2] - this.vel[k + 2])
    _d.set(_p.x - this.pos[k], _p.y - this.pos[k + 1], _p.z - this.pos[k + 2]).normalize().multiplyScalar(95)
    this.vel.set([_d.x, _d.y, _d.z], k)
    this.st[i] = A.Reflected
    this.life[i] = 1.6
  }

  cut(shape: Shape) {
    for (let i = 0; i < this.n; i++) {
      if (this.st[i] !== A.Incoming) continue
      const k = i * 3
      if (shapeHitsSphere(shape, this.pos[k], this.pos[k + 1], this.pos[k + 2], 0.3)) {
        this.st[i] = A.Falling
        this.vel[k] *= -0.1
        this.vel[k + 2] *= -0.1
        this.vel[k + 1] = 2
      }
    }
  }

  threats(out: Threat[]) {
    const p = this.game.player.pos
    let best = Infinity
    let cx = 0
    let cz = 0
    let cnt = 0
    for (let i = 0; i < this.n; i++) {
      if (this.st[i] !== A.Incoming) continue
      const k = i * 3
      const dx = p.x - this.pos[k]
      const dz = p.z - this.pos[k + 2]
      const d = Math.hypot(dx, dz)
      const v = Math.hypot(this.vel[k], this.vel[k + 2]) || 1
      // only arrows actually heading for the hero
      if ((dx * this.vel[k] + dz * this.vel[k + 2]) / (d * v) < 0.9) continue
      const eta = d / v
      if (eta < best) best = eta
      cx += this.pos[k]
      cz += this.pos[k + 2]
      cnt++
    }
    if (cnt > 8 && best < 3) out.push({ pos: new THREE.Vector3(cx / cnt, 8, cz / cnt), eta: best, tier: 'small', label: 'ARROWS' })
  }

  update(dt: number) {
    const g = this.game
    const pl = g.player
    const chest = pl.chestPos(new THREE.Vector3())
    const perfect = pl.inPerfectWindow
    if (perfect) this.fieldOpen = 0.12
    else this.fieldOpen -= dt
    let landed = 0
    let reflected = 0
    let blocked = 0
    let burned = 0
    // at the top of his power the air around the hero is too hot for arrows
    const burnR = pl.auraBurn
    const hitId = newHitId()
    let count = 0
    for (let i = 0; i < this.n; i++) {
      const s = this.st[i]
      if (s === A.Free) continue
      const k = i * 3
      this.life[i] -= dt
      if (this.life[i] <= 0) {
        this.st[i] = A.Free
        continue
      }
      if (s !== A.Stuck) {
        if (s !== A.Reflected) this.vel[k + 1] -= G * dt
        this.pos[k] += this.vel[k] * dt
        this.pos[k + 1] += this.vel[k + 1] * dt
        this.pos[k + 2] += this.vel[k + 2] * dt
      }
      const gy = s === A.Incoming || s === A.Falling ? g.terrain.heightAt(this.pos[k], this.pos[k + 2]) : 0
      if (s === A.Incoming) {
        const dx = this.pos[k] - chest.x
        const dy = this.pos[k + 1] - chest.y
        const dz = this.pos[k + 2] - chest.z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        // the deflection field of a perfect parry
        if (this.fieldOpen > 0 && d < 9 && this.vel[k + 1] < 0) {
          this.reflect(i)
          reflected++
        } else if (d < burnR && !pl.untouchable) {
          this.st[i] = A.Free
          if (burned++ < 24) {
            _p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2])
            g.fx.gpu.emberDrift(_p, 10, 0.25, { rise: 1.2, burst: 2.5, life: 0.9, size: 0.06 })
            g.fx.glow.spawn(_p, _d.set(this.vel[k] * 0.05, 1, this.vel[k + 2] * 0.05), [1, 0.6, 0.25], 0.9, 0.18, 0.25, 0, 0)
          }
          continue
        } else if (d < 1.0) {
          if (pl.untouchable) {
            /* passes through a flash-step */
          } else if (pl.guarding) {
            this.st[i] = A.Falling
            this.vel.set([-this.vel[k] * 0.2 + (Math.random() - 0.5) * 6, 6, -this.vel[k + 2] * 0.2 + (Math.random() - 0.5) * 6], k)
            blocked++
          } else {
            this.st[i] = A.Free
            landed++
          }
        } else if (this.pos[k + 1] <= gy + 0.05) {
          this.pos[k + 1] = gy + 0.05
          this.st[i] = A.Stuck
          this.life[i] = Math.min(this.life[i], 3)
          if (Math.random() < 0.1) audio.arrowHit({ x: this.pos[k], z: this.pos[k + 2] })
        }
      } else if (s === A.Reflected) {
        if (this.horde.hitPoint(this.pos[k], this.pos[k + 1], this.pos[k + 2], 0.4, { id: hitId, kind: 'reflect', dmg: 100, power: 16, origin: chest, dir: _d.set(this.vel[k], 0, this.vel[k + 2]).normalize(), friendly: true })) {
          this.st[i] = A.Free
          g.fx.spark(_p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]), null, 6, 6, [1, 0.8, 0.4])
        } else if (Math.random() < dt * 12) {
          g.fx.glow.spawn(_p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]), _d.set(0, 0, 0), [1, 0.8, 0.45], 0.8, 0.08, 0.2, 0, 0)
        }
      } else if (s === A.Falling && this.pos[k + 1] <= gy + 0.05) {
        this.st[i] = A.Stuck
        this.pos[k + 1] = gy + 0.05
        this.life[i] = 2
      }
      // draw
      _d.set(this.vel[k], this.vel[k + 1], this.vel[k + 2])
      if (this.st[i] === A.Stuck) _d.set(this.vel[k], Math.min(this.vel[k + 1], -Math.abs(this.vel[k + 1])), this.vel[k + 2])
      if (_d.lengthSq() < 1e-4) _d.set(0, -1, 0)
      _q.setFromUnitVectors(Z, _d.normalize())
      _p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2])
      _m.compose(_p, _q, _s)
      this.mesh.setMatrixAt(count, _m)
      this.mesh.setColorAt(count, this.st[i] === A.Reflected ? _c.setRGB(3, 2.2, 1) : _c.setRGB(0.35, 0.28, 0.22))
      count++
    }
    this.mesh.count = count
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true

    if (reflected > 0) {
      pl.defend('small', _p.set(chest.x, chest.y + 8, chest.z - 6))
      if (reflected > 20) g.score.log(`Arrowstorm returned ×${reflected}`, reflected * 10)
    }
    if (burned > 0) audio.sizzle(Math.min(1, burned / 20))
    if (blocked > 0) {
      g.fx.spark(chest, null, Math.min(30, blocked * 3), 7)
      audio.block()
    }
    if (landed > 0) {
      pl.hurt(4 * landed, _p.set(chest.x, chest.y, chest.z - 5))
      audio.arrowHit(chest)
    }
  }
}
