import * as THREE from 'three'
import { mulberry32 } from '../../engine/math'
import type { GroundSampler } from '../world/terrain'

const MAX = 700

function rockGeo() {
  const g = new THREE.IcosahedronGeometry(1, 1)
  const pos = g.attributes.position as THREE.BufferAttribute
  const r = mulberry32(99)
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    v.multiplyScalar(0.7 + r() * 0.5)
    v.y *= 0.75
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  g.computeVertexNormals()
  return g
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _p = new THREE.Vector3()
const _c = new THREE.Color()
const _ax = new THREE.Vector3()

/**
 * Instanced rubble with simple rigid-body physics. Hot chunks glow (colour
 * channels above 1 are turned into emission).
 */
export class Debris {
  readonly mesh: THREE.InstancedMesh
  private pos = new Float32Array(MAX * 3)
  private vel = new Float32Array(MAX * 3)
  private rot = new Float32Array(MAX * 4)
  private spin = new Float32Array(MAX * 4) // axis xyz + rate
  private size = new Float32Array(MAX)
  private life = new Float32Array(MAX)
  private maxLife = new Float32Array(MAX)
  private heat = new Float32Array(MAX)
  private shade = new Float32Array(MAX)
  private next = 0
  onLand?: (x: number, z: number, size: number) => void
  /** Rubble lands on this (flat y = 0 when unset). */
  ground: GroundSampler | null = null

  constructor() {
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 })
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifdef USE_INSTANCING_COLOR
        totalEmissiveRadiance += max(vColor.rgb - 1.0, 0.0) * 3.0;
        diffuseColor.rgb = min(diffuseColor.rgb, vec3(0.5));
        #endif`,
      )
    }
    mat.customProgramCacheKey = () => 'debris-v1'
    this.mesh = new THREE.InstancedMesh(rockGeo(), mat, MAX)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    this.mesh.count = MAX
    for (let i = 0; i < MAX; i++) {
      this.mesh.setColorAt(i, _c.setRGB(0.3, 0.21, 0.16))
      _m.makeScale(0, 0, 0)
      this.mesh.setMatrixAt(i, _m)
    }
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, size: number, life: number, heat = 0, shade = 0.3) {
    const i = this.next
    this.next = (this.next + 1) % MAX
    this.pos.set([p.x, p.y, p.z], i * 3)
    this.vel.set([v.x, v.y, v.z], i * 3)
    _q.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6))
    this.rot.set([_q.x, _q.y, _q.z, _q.w], i * 4)
    _ax.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
    this.spin.set([_ax.x, _ax.y, _ax.z, (Math.random() * 2 - 1) * 12], i * 4)
    this.size[i] = size
    this.life[i] = life
    this.maxLife[i] = life
    this.heat[i] = heat
    this.shade[i] = shade
  }

  /** Burst of rubble thrown up and out from a point. */
  burst(p: THREE.Vector3, count: number, speed: number, size: number, heat = 0, up = 1) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const out = speed * (0.3 + Math.random() * 0.7)
      _p.set(Math.sin(a) * out, speed * up * (0.5 + Math.random() * 0.9), Math.cos(a) * out)
      this.spawn(p, _p, size * (0.4 + Math.random() * 0.8), 2.5 + Math.random() * 2.5, heat * Math.random(), 0.22 + Math.random() * 0.15)
    }
  }

  clear() {
    this.life.fill(0)
  }

  update(dt: number) {
    let colorDirty = false
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        if (this.size[i] > 0) {
          this.size[i] = 0
          _m.makeScale(0, 0, 0)
          this.mesh.setMatrixAt(i, _m)
        }
        continue
      }
      this.life[i] -= dt
      const k = i * 3
      const s = this.size[i]
      this.vel[k + 1] -= 28 * dt
      this.pos[k] += this.vel[k] * dt
      this.pos[k + 1] += this.vel[k + 1] * dt
      this.pos[k + 2] += this.vel[k + 2] * dt
      const r = i * 4
      const gy = this.ground ? this.ground.heightAt(this.pos[k], this.pos[k + 2]) : 0
      if (this.pos[k + 1] < gy + s * 0.6) {
        if (this.vel[k + 1] < -6 && s > 0.8) this.onLand?.(this.pos[k], this.pos[k + 2], s)
        this.pos[k + 1] = gy + s * 0.6
        this.vel[k + 1] *= -0.3
        this.vel[k] *= 0.55
        this.vel[k + 2] *= 0.55
        this.spin[r + 3] *= 0.6
      }
      _ax.set(this.spin[r], this.spin[r + 1], this.spin[r + 2])
      _q.set(this.rot[r], this.rot[r + 1], this.rot[r + 2], this.rot[r + 3])
      const dq = new THREE.Quaternion().setFromAxisAngle(_ax, this.spin[r + 3] * dt)
      _q.premultiply(dq)
      this.rot[r] = _q.x
      this.rot[r + 1] = _q.y
      this.rot[r + 2] = _q.z
      this.rot[r + 3] = _q.w
      const fade = Math.min(1, this.life[i] / 0.6)
      _s.setScalar(s * fade)
      _p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2])
      _m.compose(_p, _q, _s)
      this.mesh.setMatrixAt(i, _m)
      if (this.heat[i] > 0) {
        this.heat[i] = Math.max(0, this.heat[i] - dt * 0.6)
        const h = this.heat[i]
        const g = this.shade[i]
        this.mesh.setColorAt(i, _c.setRGB(g + h * 2.6, g + h * 1.4, g + h * 0.5))
        colorDirty = true
      } else if (this.shade[i] >= 0) {
        const g = this.shade[i]
        this.mesh.setColorAt(i, _c.setRGB(g, g * 0.7, g * 0.52))
        this.shade[i] = -1
        colorDirty = true
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (colorDirty) this.mesh.instanceColor!.needsUpdate = true
  }
}
