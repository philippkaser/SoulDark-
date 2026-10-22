import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { mulberry32, smoothstep } from '../../engine/math'
import type { Game } from '../Game'

const N = 10
const _v = new THREE.Vector3()
const _p = new THREE.Vector3()
const _w = new THREE.Vector3()
const _q = new THREE.Quaternion()

/** A jagged chunk of rock: an icosphere pushed in and out by seeded noise. */
function chunkGeometry(seed: number) {
  const geo = new THREE.IcosahedronGeometry(1, 1)
  const rnd = mulberry32(seed)
  const pos = geo.attributes.position as THREE.BufferAttribute
  // weld by position so the faces stay closed after the push
  const pushes = new Map<string, number>()
  // one flat fracture face per chunk: everything past it is sheared off
  const cut = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize()
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i)
    const key = `${_v.x.toFixed(3)},${_v.y.toFixed(3)},${_v.z.toFixed(3)}`
    let k = pushes.get(key)
    if (k === undefined) {
      k = 0.65 + rnd() * 0.55
      pushes.set(key, k)
    }
    _v.multiplyScalar(k)
    const over = _v.dot(cut) - 0.25
    if (over > 0) _v.addScaledVector(cut, -over)
    _v.y *= 0.8
    pos.setXYZ(i, _v.x, _v.y, _v.z)
  }
  geo.computeVertexNormals()
  return geo
}

interface Shard {
  mesh: THREE.Mesh
  mat: THREE.MeshStandardMaterial
  on: boolean
  t: number
  life: number
  size: number
  vel: THREE.Vector3
  axis: THREE.Vector3
  rate: number
}

/**
 * The moon punched to pieces: huge burning chunks flung outward that streak
 * fire, shrink as they burn up and either flare out in the sky or crash.
 * World clock.
 */
export class Shards {
  readonly root = new THREE.Group()
  private list: Shard[] = []
  private g: Game
  /** Craters are dear: only the first few chunks to land dig one. */
  private craters = 0

  constructor(game: Game, map: THREE.Texture | null) {
    this.g = game
    const geos = [chunkGeometry(11), chunkGeometry(23), chunkGeometry(37), chunkGeometry(51)]
    for (let i = 0; i < N; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', map, roughness: 0.95, emissive: '#ff5a1a', emissiveIntensity: 0, flatShading: true })
      const mesh = new THREE.Mesh(geos[i % geos.length], mat)
      mesh.visible = false
      mesh.castShadow = true
      mesh.frustumCulled = false
      this.root.add(mesh)
      this.list.push({ mesh, mat, on: false, t: 0, life: 1, size: 1, vel: new THREE.Vector3(), axis: new THREE.Vector3(0, 1, 0), rate: 0 })
    }
  }

  get active() {
    return this.list.some((s) => s.on)
  }

  /** Break a body of `radius` at `at`: the chunks fly out from the blow along `dir`, keeping some of `vel`. */
  burst(at: THREE.Vector3, radius: number, dir: THREE.Vector3, vel: THREE.Vector3) {
    this.craters = 0
    for (const s of this.list) {
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
      s.on = true
      s.t = 0
      s.life = 7 + Math.random() * 4
      s.size = radius * (0.2 + Math.random() * 0.2)
      s.mesh.position.copy(at).addScaledVector(_v, radius * (0.3 + Math.random() * 0.35))
      // outward from the centre, the whole spray carried on down the line of the punch
      s.vel.copy(_v).multiplyScalar(45 + Math.random() * 70).addScaledVector(dir, 70 + Math.random() * 50).addScaledVector(vel, 0.3)
      s.vel.y += 10 + Math.random() * 25
      s.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
      s.rate = (0.3 + Math.random() * 0.9) * (Math.random() < 0.5 ? -1 : 1)
      s.mesh.quaternion.setFromAxisAngle(s.axis, Math.random() * 6)
      s.mesh.scale.setScalar(s.size)
      s.mat.emissiveIntensity = 0.6
      s.mesh.visible = true
    }
  }

  clear() {
    for (const s of this.list) {
      s.on = false
      s.mesh.visible = false
    }
  }

  update(dt: number) {
    if (dt <= 0) return
    const g = this.g
    const fx = g.fx
    let i = 0
    for (const s of this.list) {
      i++
      if (!s.on) continue
      s.t += dt
      const k = s.t / s.life
      s.vel.y -= 9 * dt
      s.vel.multiplyScalar(Math.exp(-dt * 0.06))
      s.mesh.position.addScaledVector(s.vel, dt)
      s.mesh.quaternion.premultiply(_q.setFromAxisAngle(s.axis, s.rate * dt))
      // burning up: white-hot, shrinking
      const burn = smoothstep(0.45, 1, k)
      const r = s.size * (1 - burn * 0.85)
      s.mesh.scale.setScalar(r)
      s.mat.emissiveIntensity = 0.6 + k * 4
      const p = s.mesh.position
      // a trail of fire and smoke behind each chunk
      const n = Math.floor(dt * 26 * g.q + Math.random())
      _v.copy(s.vel).normalize()
      for (let j = 0; j < n; j++) {
        _p.copy(p).addScaledVector(_v, -r * (0.4 + Math.random() * 0.6))
        _p.x += (Math.random() - 0.5) * r
        _p.y += (Math.random() - 0.5) * r
        _p.z += (Math.random() - 0.5) * r
        fx.fire.spawn(_p, _w.copy(_v).multiplyScalar(-8), [1, 0.5, 0.2], 0.85, r * (0.5 + Math.random() * 0.5), 0.7 + Math.random() * 0.6, 0, 1, { grow: 1.2 })
        if (Math.random() < 0.5) fx.smoke.spawn(_p, _w.copy(_v).multiplyScalar(-4), [0.12, 0.1, 0.09], 0.7, r * (0.7 + Math.random() * 0.6), 2.5 + Math.random() * 2, -0.4, 0.5, { grow: 2.5, heat: 0.8, cool: 0.7 })
      }
      const gy = g.terrain.heightAt(p.x, p.z)
      if (p.y - r * 0.5 <= gy) {
        // it lands
        s.on = false
        s.mesh.visible = false
        _p.set(p.x, gy, p.z)
        if (this.craters < 3) {
          this.craters++
          g.terrain.crater(_p.x, _p.z, r * 1.3, r * 0.3, { ejecta: 1 })
        }
        fx.explosion(_p.setY(gy + r * 0.3), Math.min(24, r * 0.6), { sound: i % 2 === 0 })
        fx.groundShock(_p.setY(gy), r * 1.5, '#ff9a60', true)
        g.cam.addTrauma(Math.max(0.1, 0.7 - p.distanceTo(g.player.pos) / 600))
        if (i % 3 === 0) audio.landing(3)
      } else if (k >= 1) {
        // burnt out in the sky
        s.on = false
        s.mesh.visible = false
        fx.explosion(p, Math.max(3, r * 0.8), { scorch: false, debris: false, sound: i % 3 === 0 })
        fx.emberDrift(p, 260, r * 2, { rise: 1, burst: 8, life: 4, size: 0.5 })
      }
    }
  }
}
