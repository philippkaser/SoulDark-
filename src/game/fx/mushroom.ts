import * as THREE from 'three'
import { quadFrag, quadVert } from '../../engine/particles'
import { clamp, smoothstep, TAU } from '../../engine/math'

const enum Role {
  Cap,
  Stem,
  Surge,
}

interface Puff {
  role: Role
  /** Angle around the cloud's axis. */
  theta: number
  /** Angle around the torus tube (cap) or height fraction (stem). */
  phi: number
  /** Radial jitter 0..1. */
  rho: number
  size: number
  seed: number
  speed: number
}

/**
 * A procedural mushroom cloud: a rolling toroidal vortex (the cap) fed by a
 * rising stem, a base surge racing along the ground and a short-lived
 * condensation ring. Puffs are lit billboards that start incandescent and
 * cool into ash-brown smoke.
 */
export class MushroomCloud {
  readonly root = new THREE.Group()
  readonly center: THREE.Vector3
  readonly scale: number
  t = 0
  readonly life: number
  private puffs: Puff[] = []
  private geo: THREE.InstancedBufferGeometry
  private aPos: Float32Array
  private aCol: Float32Array
  private aPar: Float32Array
  private order: Uint32Array
  private depth: Float32Array
  private tmp: Float32Array
  private wilson: THREE.Mesh
  private wilsonMat: THREE.ShaderMaterial

  constructor(center: THREE.Vector3, scale: number, quality: number) {
    this.center = center.clone()
    this.scale = scale
    this.life = 70
    const nCap = Math.round(560 * quality)
    const nStem = Math.round(260 * quality)
    const nSurge = Math.round(260 * quality)
    for (let i = 0; i < nCap; i++)
      this.puffs.push({ role: Role.Cap, theta: Math.random() * TAU, phi: Math.random() * TAU, rho: Math.sqrt(Math.random()), size: 0.7 + Math.random() * 0.6, seed: Math.random(), speed: 0.8 + Math.random() * 0.4 })
    for (let i = 0; i < nStem; i++)
      this.puffs.push({ role: Role.Stem, theta: Math.random() * TAU, phi: Math.random(), rho: Math.sqrt(Math.random()), size: 0.8 + Math.random() * 0.5, seed: Math.random(), speed: 0.7 + Math.random() * 0.6 })
    for (let i = 0; i < nSurge; i++)
      this.puffs.push({ role: Role.Surge, theta: Math.random() * TAU, phi: Math.random(), rho: Math.random(), size: 0.8 + Math.random() * 0.6, seed: Math.random(), speed: 0.7 + Math.random() * 0.6 })
    const n = this.puffs.length
    this.aPos = new Float32Array(n * 3)
    this.aCol = new Float32Array(n * 4)
    this.aPar = new Float32Array(n * 4)
    this.tmp = new Float32Array(n * 3)
    this.order = new Uint32Array(n)
    this.depth = new Float32Array(n)
    const g = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(1, 1)
    g.index = quad.index
    g.setAttribute('position', quad.attributes.position)
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.aCol, 4).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('iParams', new THREE.InstancedBufferAttribute(this.aPar, 4).setUsage(THREE.DynamicDrawUsage))
    g.instanceCount = n
    this.geo = g
    const mat = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: quadFrag,
      uniforms: {
        uLightDir: { value: new THREE.Vector3(0.2, 0.9, 0.35).normalize() },
        uAmbient: { value: new THREE.Color(0.35, 0.3, 0.32) },
        uHot: { value: new THREE.Color(1.0, 0.42, 0.1) },
        uLit: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    })
    const mesh = new THREE.Mesh(g, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 7
    this.root.add(mesh)

    // the condensation (Wilson) ring: a flat soft annulus around the stem
    this.wilsonMat = new THREE.ShaderMaterial({
      uniforms: { uAlpha: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform float uAlpha; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
        void main(){
          vec2 d = vUv - 0.5; float r = length(d) * 2.0;
          float band = smoothstep(0.45, 0.8, r) * smoothstep(1.0, 0.85, r);
          float a = atan(d.y, d.x);
          float wisps = n(vec2(a * 12.0, r * 6.0)) * 0.6 + n(vec2(a * 30.0, r * 14.0)) * 0.4;
          gl_FragColor = vec4(vec3(0.95, 0.93, 0.9), band * wisps * uAlpha);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    this.wilson = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.wilsonMat)
    this.wilson.rotation.x = -Math.PI / 2
    this.wilson.renderOrder = 7
    this.root.add(this.wilson)
  }

  get done() {
    return this.t >= this.life
  }

  /** Current height of the cap centre (for the fireball and the camera). */
  get capHeight() {
    return this.scale * (60 + 420 * (1 - Math.exp(-this.t / 9)))
  }

  update(dt: number, camera: THREE.Camera) {
    this.t += dt
    const t = this.t
    const S = this.scale
    const c = this.center
    const H = this.capHeight
    const Rmaj = S * (45 + 120 * (1 - Math.exp(-t / 10)))
    const rmin = S * (28 + 70 * (1 - Math.exp(-t / 9)))
    const surgeR = S * 300 * (1 - Math.exp(-t / 5))
    const fadeIn = clamp(t / 0.6, 0, 1)
    const fadeOut = 1 - smoothstep(this.life * 0.62, this.life, t)
    const cool = Math.exp(-t / 7)
    const roll = 0.35 * Math.exp(-t / 25) + 0.05
    const n = this.puffs.length
    for (let i = 0; i < n; i++) {
      const p = this.puffs[i]
      let x = 0
      let y = 0
      let z = 0
      let size = 0
      let heat = 0
      let alpha = 0
      let shade = 0.4
      if (p.role === Role.Cap) {
        p.phi -= roll * p.speed * dt
        p.theta += 0.015 * dt * p.speed
        const tube = rmin * (0.35 + 0.65 * p.rho)
        const rr = Rmaj + tube * Math.cos(p.phi)
        x = Math.cos(p.theta) * rr
        z = Math.sin(p.theta) * rr
        y = H + tube * Math.sin(p.phi) * 0.85
        size = rmin * 0.85 * p.size
        // the underside glows from the fireball for the first seconds
        const under = clamp(-Math.sin(p.phi), 0, 1)
        heat = cool * (1.6 - p.rho * 0.6) + under * Math.exp(-t / 14) * 0.8
        alpha = 0.9
        shade = 0.36 + p.seed * 0.14
      } else if (p.role === Role.Stem) {
        p.phi += dt * 0.06 * p.speed
        if (p.phi > 1) p.phi -= 1
        p.theta += dt * 0.25 * p.speed
        const top = Math.max(10 * S, H - rmin * 0.4)
        const u = p.phi
        const rStem = S * (12 + 22 * u + 10 * u * u) * (0.3 + 0.7 * p.rho)
        x = Math.cos(p.theta) * rStem
        z = Math.sin(p.theta) * rStem
        y = u * top
        size = S * (26 + 18 * u) * p.size
        heat = cool * 1.2 * u + Math.exp(-t / 3) * 1.4
        alpha = 0.75 * smoothstep(0, 0.08, u) * smoothstep(1.0, 0.85, u) * smoothstep(0.4, 2.0, t)
        shade = 0.32 + p.seed * 0.12
      } else {
        // base surge: a ring of dust racing outward, hugging the ground
        const rr = surgeR * (0.55 + 0.45 * p.phi)
        p.theta += dt * 0.01
        x = Math.cos(p.theta) * rr
        z = Math.sin(p.theta) * rr
        y = S * (6 + p.rho * 26)
        size = S * (30 + 30 * p.rho) * p.size
        heat = Math.exp(-t / 1.5) * 0.8
        alpha = 0.7 * smoothstep(0.3, 1.2, t) * (1 - smoothstep(this.life * 0.35, this.life * 0.7, t))
        shade = 0.42 + p.seed * 0.12
      }
      this.tmp[i * 3] = c.x + x
      this.tmp[i * 3 + 1] = c.y + y
      this.tmp[i * 3 + 2] = c.z + z
      this.aCol[i * 4] = shade * 1.05
      this.aCol[i * 4 + 1] = shade * 0.92
      this.aCol[i * 4 + 2] = shade * 0.82
      this.aCol[i * 4 + 3] = alpha * fadeIn * fadeOut
      this.aPar[i * 4] = size * (0.6 + 0.4 * fadeIn)
      this.aPar[i * 4 + 1] = p.seed * 6.28 + t * 0.05 * (p.seed - 0.5)
      this.aPar[i * 4 + 2] = heat
      this.aPar[i * 4 + 3] = p.seed
    }

    // back-to-front
    const e = camera.matrixWorldInverse.elements
    for (let i = 0; i < n; i++) {
      this.order[i] = i
      const k = i * 3
      this.depth[i] = e[2] * this.tmp[k] + e[6] * this.tmp[k + 1] + e[10] * this.tmp[k + 2] + e[14]
    }
    const dep = this.depth
    this.order.sort((a, b) => dep[a] - dep[b])
    // reorder in place via a scratch copy of the per-puff data
    const col = this.aCol.slice()
    const par = this.aPar.slice()
    for (let j = 0; j < n; j++) {
      const i = this.order[j]
      this.aPos[j * 3] = this.tmp[i * 3]
      this.aPos[j * 3 + 1] = this.tmp[i * 3 + 1]
      this.aPos[j * 3 + 2] = this.tmp[i * 3 + 2]
      for (let q = 0; q < 4; q++) {
        this.aCol[j * 4 + q] = col[i * 4 + q]
        this.aPar[j * 4 + q] = par[i * 4 + q]
      }
    }
    this.geo.attributes.iPos.needsUpdate = true
    this.geo.attributes.iColor.needsUpdate = true
    this.geo.attributes.iParams.needsUpdate = true

    // condensation ring: appears around the stem a moment after the blast
    const w = smoothstep(1.2, 2.2, t) * (1 - smoothstep(4.5, 9, t))
    this.wilsonMat.uniforms.uAlpha.value = w * 0.8 * fadeOut
    this.wilson.visible = w > 0.01
    this.wilson.position.set(c.x, c.y + H * 0.55, c.z)
    this.wilson.scale.setScalar(S * (90 + t * 40))
  }

  dispose() {
    this.geo.dispose()
    ;((this.root.children[0] as THREE.Mesh).material as THREE.Material).dispose()
    this.wilsonMat.dispose()
  }
}
