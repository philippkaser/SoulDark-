import * as THREE from 'three'
import type { FxEvent } from '../world'

const MAX = 3000

const vert = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
uniform float uScale;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
  vColor = aColor;
}
`
const frag = /* glsl */ `
varying vec4 vColor;
uniform float uSoft;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(uSoft, 1.0, d);
  if (a <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}
`

/** Struct-of-arrays particle pool rendered as one Points draw call. */
class ParticlePool {
  readonly points: THREE.Points
  private pos = new Float32Array(MAX * 3)
  private vel = new Float32Array(MAX * 3)
  private col = new Float32Array(MAX * 4)
  private base = new Float32Array(MAX * 3)
  private size = new Float32Array(MAX)
  private size0 = new Float32Array(MAX)
  private life = new Float32Array(MAX)
  private maxLife = new Float32Array(MAX)
  private grav = new Float32Array(MAX)
  private drag = new Float32Array(MAX)
  private alpha0 = new Float32Array(MAX)
  private home = new Uint8Array(MAX)
  private grow = new Float32Array(MAX)
  private next = 0
  private geo: THREE.BufferGeometry
  readonly uniforms: { uScale: { value: number }; uSoft: { value: number } }

  constructor(additive: boolean, soft: number) {
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    this.uniforms = { uScale: { value: 800 }, uSoft: { value: soft } }
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    this.points = new THREE.Points(this.geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = additive ? 8 : 7
  }

  spawn(
    p: THREE.Vector3,
    v: THREE.Vector3,
    color: [number, number, number],
    alpha: number,
    size: number,
    life: number,
    grav: number,
    drag: number,
    opts: { home?: boolean; grow?: number } = {},
  ) {
    const i = this.next
    this.next = (this.next + 1) % MAX
    this.pos[i * 3] = p.x
    this.pos[i * 3 + 1] = p.y
    this.pos[i * 3 + 2] = p.z
    this.vel[i * 3] = v.x
    this.vel[i * 3 + 1] = v.y
    this.vel[i * 3 + 2] = v.z
    this.base[i * 3] = color[0]
    this.base[i * 3 + 1] = color[1]
    this.base[i * 3 + 2] = color[2]
    this.alpha0[i] = alpha
    this.size0[i] = size
    this.life[i] = life
    this.maxLife[i] = life
    this.grav[i] = grav
    this.drag[i] = drag
    this.home[i] = opts.home ? 1 : 0
    this.grow[i] = opts.grow ?? 0
  }

  update(dt: number, homeTarget: THREE.Vector3) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        if (this.size[i] !== 0) {
          this.size[i] = 0
          this.col[i * 4 + 3] = 0
        }
        continue
      }
      this.life[i] -= dt
      const k = i * 3
      if (this.home[i]) {
        const dx = homeTarget.x - this.pos[k]
        const dy = homeTarget.y - this.pos[k + 1]
        const dz = homeTarget.z - this.pos[k + 2]
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4
        const age = this.maxLife[i] - this.life[i]
        const pull = Math.min(40, 6 + age * 26)
        this.vel[k] += (dx / d) * pull * dt
        this.vel[k + 1] += (dy / d) * pull * dt
        this.vel[k + 2] += (dz / d) * pull * dt
        if (d < 0.35 && age > 0.3) this.life[i] = Math.min(this.life[i], 0.05)
      }
      const dr = Math.exp(-this.drag[i] * dt)
      this.vel[k] *= dr
      this.vel[k + 1] = this.vel[k + 1] * dr - this.grav[i] * dt
      this.vel[k + 2] *= dr
      this.pos[k] += this.vel[k] * dt
      this.pos[k + 1] += this.vel[k + 1] * dt
      this.pos[k + 2] += this.vel[k + 2] * dt
      if (this.pos[k + 1] < 0.02 && this.grav[i] > 0) {
        this.pos[k + 1] = 0.02
        this.vel[k] *= 0.3
        this.vel[k + 1] *= -0.2
        this.vel[k + 2] *= 0.3
      }
      const t = Math.max(0, this.life[i] / this.maxLife[i])
      const fade = Math.min(1, t * 3) * Math.min(1, (1 - t) * 12 + 0.2)
      this.col[i * 4] = this.base[k]
      this.col[i * 4 + 1] = this.base[k + 1]
      this.col[i * 4 + 2] = this.base[k + 2]
      this.col[i * 4 + 3] = this.alpha0[i] * fade
      this.size[i] = this.size0[i] * (1 + this.grow[i] * (1 - t))
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.aColor.needsUpdate = true
    this.geo.attributes.aSize.needsUpdate = true
  }
}

const ringVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const ringFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float band = smoothstep(0.62, 0.93, r) * (1.0 - smoothstep(0.93, 1.0, r));
  gl_FragColor = vec4(uColor * band * uAlpha, band * uAlpha);
}
`

interface Ring {
  mesh: THREE.Mesh
  t: number
  dur: number
  radius: number
  mat: THREE.ShaderMaterial
}

const _v = new THREE.Vector3()
const _p = new THREE.Vector3()
const rnd = (a: number, b: number) => a + Math.random() * (b - a)

function randomDir(out: THREE.Vector3, around?: THREE.Vector3, spread = 1) {
  out.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize()
  if (around) out.multiplyScalar(spread).add(around).normalize()
  return out
}

export class Effects {
  readonly root = new THREE.Group()
  private glow = new ParticlePool(true, 0.0)
  private soft = new ParticlePool(false, 0.2)
  private rings: Ring[] = []
  readonly light = new THREE.PointLight('#ff9a50', 0, 14, 2)
  private lightPower = 0

  constructor() {
    this.root.add(this.glow.points, this.soft.points, this.light)
    this.light.position.set(0, -10, 0)
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: ringVert,
        fragmentShader: ringFrag,
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)
      mesh.rotation.x = -Math.PI / 2
      mesh.visible = false
      mesh.renderOrder = 9
      this.root.add(mesh)
      this.rings.push({ mesh, t: 1, dur: 1, radius: 1, mat })
    }
  }

  setViewport(heightPx: number, fovDeg: number) {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360))
    this.glow.uniforms.uScale.value = s
    this.soft.uniforms.uScale.value = s
  }

  private flash(p: THREE.Vector3, color: string, power: number) {
    this.light.position.copy(p)
    this.light.color.set(color)
    this.lightPower = Math.max(this.lightPower, power)
  }

  private ring(p: THREE.Vector3, radius: number, color: string, dur: number) {
    const r = this.rings.find((x) => x.t >= x.dur) ?? this.rings[0]
    r.t = 0
    r.dur = dur
    r.radius = radius
    r.mesh.position.set(p.x, 0.08, p.z)
    r.mat.uniforms.uColor.value.set(color)
    r.mesh.visible = true
  }

  handle(e: FxEvent) {
    switch (e.kind) {
      case 'spark': {
        const n = e.count ?? 16
        for (let i = 0; i < n; i++) {
          randomDir(_v, e.dir, 1.2).multiplyScalar(rnd(3, e.big ? 11 : 8))
          const hot = Math.random()
          this.glow.spawn(e.p, _v, [1.0, 0.55 + hot * 0.4, 0.2 + hot * 0.3], 1, rnd(0.03, 0.06), rnd(0.18, 0.45), 9, 2.5)
        }
        this.flash(e.p, '#ffa060', e.big ? 30 : 14)
        return
      }
      case 'blood': {
        const n = e.count ?? 20
        for (let i = 0; i < n; i++) {
          randomDir(_v, e.dir, 1.5).multiplyScalar(rnd(1.5, 5.5))
          _v.y += rnd(0.5, 2.5)
          const dark = rnd(0.12, 0.3)
          this.soft.spawn(e.p, _v, [dark, 0.008, 0.01], 0.95, rnd(0.04, 0.1), rnd(0.4, 0.9), 11, 1.2)
        }
        for (let i = 0; i < n / 4; i++) {
          randomDir(_v).multiplyScalar(0.6)
          this.soft.spawn(e.p, _v, [0.2, 0.01, 0.01], 0.45, rnd(0.2, 0.35), rnd(0.3, 0.6), 0.5, 3, { grow: 1.2 })
        }
        return
      }
      case 'dust': {
        const n = e.count ?? 12
        const s = e.spread ?? 1
        for (let i = 0; i < n; i++) {
          _p.set(e.p.x + rnd(-s, s), e.p.y + rnd(0, 0.3), e.p.z + rnd(-s, s))
          _v.set(rnd(-1, 1), rnd(0.3, 1.4), rnd(-1, 1))
          const g = rnd(0.25, 0.4)
          this.soft.spawn(_p, _v, [g, g * 0.92, g * 0.82], 0.2, rnd(0.5, 1.1) * s, rnd(0.9, 1.6), -0.1, 1.8, { grow: 1.2 })
        }
        return
      }
      case 'shockwave': {
        const r = e.radius
        this.ring(e.p, r, e.fire ? '#ff6a20' : e.color ?? '#cfc6b8', e.fire ? 0.55 : 0.45)
        const n = Math.min(40, Math.floor(r * 5))
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2
          const d = rnd(0.5, 0.9) * r
          _p.set(e.p.x + Math.sin(a) * d, 0.12, e.p.z + Math.cos(a) * d)
          _v.set(Math.sin(a) * rnd(2, 5), rnd(0.2, 1.2), Math.cos(a) * rnd(2, 5))
          const g = rnd(0.25, 0.4)
          this.soft.spawn(_p, _v, [g, g * 0.92, g * 0.82], 0.2, rnd(0.5, 1.1), rnd(0.7, 1.4), 0.2, 2.6, { grow: 1.0 })
        }
        for (let i = 0; i < n / 2; i++) {
          _p.set(e.p.x + rnd(-1, 1), 0.2, e.p.z + rnd(-1, 1))
          _v.set(rnd(-3, 3), rnd(3, 8), rnd(-3, 3))
          this.soft.spawn(_p, _v, [0.18, 0.16, 0.14], 1, rnd(0.04, 0.09), rnd(0.6, 1.2), 14, 0.5)
        }
        if (e.fire) {
          for (let i = 0; i < 260; i++) {
            const a = Math.random() * Math.PI * 2
            _p.set(e.p.x + Math.sin(a) * 0.6, rnd(0.2, 2.5), e.p.z + Math.cos(a) * 0.6)
            _v.set(Math.sin(a) * rnd(6, 16), rnd(-1, 4), Math.cos(a) * rnd(6, 16))
            this.glow.spawn(_p, _v, [1, rnd(0.3, 0.6), 0.1], 1, rnd(0.08, 0.2), rnd(0.35, 0.8), -1, 2.2)
          }
          this.flash(e.p, '#ff6020', 140)
        } else {
          this.flash(e.p, '#ffb070', 20)
        }
        return
      }
      case 'souls': {
        for (let i = 0; i < e.count; i++) {
          _p.set(e.from.x + rnd(-0.4, 0.4), e.from.y + rnd(-0.5, 0.6), e.from.z + rnd(-0.4, 0.4))
          _v.set(rnd(-2, 2), rnd(1, 4), rnd(-2, 2))
          const c = Math.random()
          this.glow.spawn(_p, _v, [0.55 + c * 0.3, 0.75 + c * 0.2, 1], 0.9, rnd(0.08, 0.16), rnd(1.6, 2.4), 0, 1.5, { home: true })
        }
        return
      }
      case 'heal': {
        for (let i = 0; i < 70; i++) {
          const a = Math.random() * Math.PI * 2
          const r = rnd(0.2, 0.7)
          _p.set(e.p.x + Math.sin(a) * r, rnd(0.1, 1.6), e.p.z + Math.cos(a) * r)
          _v.set(0, rnd(0.6, 1.8), 0)
          this.glow.spawn(_p, _v, [1, rnd(0.55, 0.75), 0.25], 0.9, rnd(0.04, 0.09), rnd(0.8, 1.5), -0.2, 1)
        }
        this.flash(new THREE.Vector3(e.p.x, 1.2, e.p.z), '#ffb060', 12)
        return
      }
      case 'ash': {
        for (let i = 0; i < e.count; i++) {
          _p.set(e.p.x + rnd(-e.spread, e.spread), e.p.y + rnd(0, e.height), e.p.z + rnd(-e.spread, e.spread))
          _v.set(rnd(-0.3, 0.3), rnd(0.4, 1.5), rnd(-0.3, 0.3))
          if (Math.random() < 0.45) this.glow.spawn(_p, _v, [1, rnd(0.35, 0.55), 0.1], 1, rnd(0.03, 0.06), rnd(0.8, 1.8), -0.3, 0.6)
          else {
            const g = rnd(0.05, 0.12)
            this.soft.spawn(_p, _v, [g, g, g], 0.9, rnd(0.03, 0.07), rnd(1, 2.2), -0.2, 0.5)
          }
        }
        return
      }
      case 'parry': {
        for (let i = 0; i < 40; i++) {
          randomDir(_v).multiplyScalar(rnd(4, 12))
          this.glow.spawn(e.p, _v, [1, 0.9, 0.6], 1, rnd(0.03, 0.07), rnd(0.15, 0.4), 6, 3)
        }
        this.glow.spawn(e.p, _v.set(0, 0, 0), [1, 0.95, 0.8], 1, 1.4, 0.12, 0, 0, { grow: -0.8 })
        this.flash(e.p, '#fff0d0', 40)
        return
      }
      case 'embers': {
        for (let i = 0; i < e.count; i++) {
          _p.set(e.p.x + rnd(-e.spread, e.spread), e.p.y + rnd(-0.2, 0.4), e.p.z + rnd(-e.spread, e.spread))
          _v.set(rnd(-0.6, 0.6), rnd(0.8, 2.5), rnd(-0.6, 0.6))
          this.glow.spawn(_p, _v, [1, rnd(0.3, 0.55), 0.08], 1, rnd(0.03, 0.07), rnd(0.6, 1.4), -0.4, 0.8)
        }
        return
      }
    }
  }

  update(dt: number, homeTarget: THREE.Vector3) {
    this.glow.update(dt, homeTarget)
    this.soft.update(dt, homeTarget)
    for (const r of this.rings) {
      if (r.t >= r.dur) {
        r.mesh.visible = false
        continue
      }
      r.t += dt
      const k = Math.min(1, r.t / r.dur)
      const s = r.radius * (0.15 + 0.85 * (1 - Math.pow(1 - k, 3)))
      r.mesh.scale.setScalar(s)
      r.mat.uniforms.uAlpha.value = (1 - k) * 1.6
    }
    this.lightPower *= Math.exp(-dt * 9)
    this.light.intensity = this.lightPower
  }
}
