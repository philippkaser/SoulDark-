import * as THREE from 'three'
import { clonePatched, sdUniforms } from '../../engine/gfx/materials'
import type { GroundSampler } from '../world/terrain'

export interface SliceOpts {
  /** Gravity (m/s²) applied to free halves. */
  gravity?: number
  /** Push the halves apart along the cut normal (m/s). */
  separate?: number
  /** Standing objects cut vertically: each half hinges over at its base. */
  topple?: boolean
  /** When the cut is roughly horizontal, the lower half stays put. */
  staticBelow?: boolean
  /** Base velocity of both halves (falling airships, flung moons). */
  vel?: THREE.Vector3
  /** Tumble rate (rad/s). */
  spin?: number
  /** Seconds before the halves dissolve. */
  life?: number
  /** Called once per half when it hits the ground. */
  onCrash?: (p: THREE.Vector3, size: number) => void
  /** Molten glow of the cut face (0..1+). */
  glow?: number
  /** Ground height for crash detection. */
  ground?: number
}

interface Half {
  pivot: THREE.Group
  inner: THREE.Group
  planeLocal: THREE.Plane
  planeWorld: THREE.Plane
  mats: THREE.Material[]
  vel: THREE.Vector3
  axis: THREE.Vector3
  rate: number
  angle: number
  hinge: boolean
  fixed: boolean
  crashed: boolean
  size: number
  low: number
}

interface Sliced {
  halves: Half[]
  t: number
  life: number
  opts: SliceOpts
}

const UP = new THREE.Vector3(0, 1, 0)
const _box = new THREE.Box3()
const _c = new THREE.Vector3()
const _s = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _d = new THREE.Vector3()

/**
 * Cuts objects in two along a plane. Each half is a set of clones of the
 * source meshes whose materials are clipped by the plane (the back faces show
 * through the cut as a molten cross-section), then the halves topple, slide
 * or tumble apart, crash and finally dissolve.
 */
export class Slicer {
  readonly root = new THREE.Group()
  private list: Sliced[] = []
  max = 10
  /** Halves crash onto this when a slice gives no fixed ground height. */
  ground: GroundSampler | null = null

  get count() {
    return this.list.length
  }

  slice(sources: THREE.Object3D[], plane: THREE.Plane, opts: SliceOpts = {}) {
    if (this.list.length >= this.max) this.remove(this.list[0])
    _box.makeEmpty()
    for (const s of sources) {
      s.updateWorldMatrix(true, true)
      _box.expandByObject(s)
    }
    if (_box.isEmpty()) return
    _box.getCenter(_c)
    _box.getSize(_s)
    const size = _s.length() * 0.5
    const n = plane.normal
    const horizontalCut = Math.abs(n.y) > 0.55
    const halves: Half[] = []
    for (const sign of [1, -1]) {
      const planeLocal = plane.clone()
      if (sign < 0) planeLocal.negate()
      // approximate centre of this half
      const hc = _c.clone().addScaledVector(n, (sign * size) / 4)
      const low = _box.min.y
      const isLower = horizontalCut && (sign > 0 ? n.y < 0 : n.y > 0)
      // the top of something cut across slides off its stump and goes over like a felled tree
      const slideTop = !!opts.topple && horizontalCut && !isLower
      const hinge = !!opts.topple && (!horizontalCut || slideTop)
      if (slideTop) {
        _d.set(opts.vel?.x ?? 0, 0, opts.vel?.z ?? 0)
        if (_d.lengthSq() < 1e-4) _d.set(Math.random() - 0.5, 0, Math.random() - 0.5)
        _d.normalize()
      }
      const pivotP = slideTop
        ? plane.projectPoint(hc, new THREE.Vector3()).addScaledVector(_d, (_s.x + _s.z) * 0.22)
        : hinge
          ? new THREE.Vector3(hc.x, low, hc.z).addScaledVector(n, sign * _s.length() * 0.08)
          : hc
      const pivot = new THREE.Group()
      pivot.position.copy(pivotP)
      const inner = new THREE.Group()
      inner.position.copy(pivotP).negate()
      pivot.add(inner)
      const matMap = new Map<THREE.Material, THREE.Material>()
      const cloneMat = (m: THREE.Material) => {
        let c = matMap.get(m)
        if (!c) {
          c = (m as THREE.MeshStandardMaterial).isMeshStandardMaterial ? clonePatched(m as THREE.MeshStandardMaterial) : m.clone()
          c.side = THREE.DoubleSide
          c.clippingPlanes = [planeLocal.clone()]
          c.clipShadows = true
          const u = sdUniforms(c)
          if (u) u.uCut.value = opts.glow ?? 1
          matMap.set(m, c)
        }
        return c
      }
      for (const src of sources) {
        src.traverse((o) => {
          const m = o as THREE.Mesh
          if (!m.isMesh || !m.visible) return
          const mat = Array.isArray(m.material) ? m.material.map(cloneMat) : cloneMat(m.material)
          const copy = new THREE.Mesh(m.geometry, mat)
          copy.matrixAutoUpdate = false
          copy.matrix.copy(m.matrixWorld)
          copy.castShadow = m.castShadow
          copy.receiveShadow = true
          copy.frustumCulled = false
          inner.add(copy)
        })
      }
      // which way does this half go?
      const fixed = !!opts.staticBelow && isLower
      const vel = (opts.vel?.clone() ?? new THREE.Vector3()).addScaledVector(n, sign * (opts.separate ?? 1.5))
      if (slideTop) vel.set(0, 0, 0).addScaledVector(_d, 2 + Math.random() * 2)
      else if (horizontalCut && !isLower) {
        // the top slides off down the cut's slope
        const slope = UP.clone().multiplyScalar(-1).projectOnPlane(n)
        vel.addScaledVector(slope, 3)
      }
      const axis = slideTop
        ? new THREE.Vector3().crossVectors(UP, _d).normalize()
        : hinge
          ? new THREE.Vector3().crossVectors(UP, n).multiplyScalar(sign).normalize()
        : new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
      const rate = hinge ? 0.15 : (opts.spin ?? 0.6) * (0.5 + Math.random())
      this.root.add(pivot)
      halves.push({
        pivot,
        inner,
        planeLocal,
        planeWorld: planeLocal.clone(),
        mats: [...matMap.values()],
        vel,
        axis,
        rate,
        angle: 0,
        hinge,
        fixed,
        crashed: false,
        size,
        low: low - pivotP.y,
      })
    }
    for (const s of sources) s.visible = false
    this.list.push({ halves, t: 0, life: opts.life ?? 12, opts })
  }

  private remove(s: Sliced) {
    for (const h of s.halves) {
      this.root.remove(h.pivot)
      for (const m of h.mats) m.dispose()
    }
    this.list.splice(this.list.indexOf(s), 1)
  }

  clear() {
    while (this.list.length) this.remove(this.list[0])
  }

  update(dt: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i]
      s.t += dt
      const o = s.opts
      const g = o.gravity ?? 30
      for (const h of s.halves) {
        const ground = o.ground ?? this.ground?.heightAt(h.pivot.position.x, h.pivot.position.z) ?? 0
        if (!h.fixed && !h.crashed) {
          if (h.hinge) {
            // falls like a tree: accelerates as it leans
            h.rate += (1.2 + Math.sin(h.angle) * 6) * dt * (g / 30)
            h.angle += h.rate * dt
            h.pivot.position.addScaledVector(h.vel, dt * Math.max(0, 1 - s.t))
            h.pivot.quaternion.setFromAxisAngle(h.axis, h.angle)
            if (h.angle > 1.45) {
              h.crashed = true
              // the far end lands away from the cut
              _p.copy(h.axis).cross(UP).multiplyScalar(h.size * 0.9).add(h.pivot.position)
              o.onCrash?.(_p, h.size)
            }
          } else {
            h.vel.y -= g * dt
            h.pivot.position.addScaledVector(h.vel, dt)
            _q.setFromAxisAngle(h.axis, h.rate * dt)
            h.pivot.quaternion.premultiply(_q)
            if (h.pivot.position.y - h.size * 0.45 < ground && h.vel.y < 0) {
              h.crashed = true
              h.vel.set(0, 0, 0)
              o.onCrash?.(h.pivot.position.clone().setY(ground), h.size)
            }
          }
        }
        // keep the clipping plane glued to the half as it moves
        h.pivot.updateMatrixWorld(true)
        h.planeWorld.copy(h.planeLocal).applyMatrix4(h.inner.matrixWorld)
        const k = s.t / s.life
        for (const m of h.mats) {
          m.clippingPlanes![0].copy(h.planeWorld)
          const u = sdUniforms(m)
          if (u) {
            u.uCut.value = (o.glow ?? 1) * Math.max(0.15, 1 - s.t / 6)
            u.uDissolve.value = Math.max(0, (k - 0.8) / 0.2)
          }
        }
      }
      if (s.t >= s.life) this.remove(s)
    }
  }
}
