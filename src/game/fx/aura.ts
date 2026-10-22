import * as THREE from 'three'
import { damp } from '../../engine/math'
import type { ParticleStyle } from '../../engine/gpuParticles'
import type { HeroModel } from '../player/heroModel'
import { DECAL_VERT, decalUniforms, TerrainDecal, type DecalGround } from './decal'
import type { BoltOpts, Lightning } from './lightning'
import type { DriftOpts, RingOpts, Tint } from './particleFx'
import { NOISE3 } from './shaders'

/** The bits of Fx the aura uses (Fx satisfies it structurally). */
export interface AuraFx {
  gpu: { light: { emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, st: ParticleStyle, sizeMul?: number, bright?: number, delay?: number): void } }
  emberDrift(p: THREE.Vector3, n: number, radius: number, o?: DriftOpts): void
  motes(p: THREE.Vector3, n: number, radius: number, color?: Tint, normal?: THREE.Vector3 | null): void
  plasmaRing(p: THREE.Vector3, normal: THREE.Vector3, radius: number, n: number, color?: Tint, o?: RingOpts): void
}

export interface AuraGround extends DecalGround {
  heightAt(x: number, z: number): number
}

const GOLD = new THREE.Color('#ffb040')
const HOT = new THREE.Color('#fff0c4')
const ID = new THREE.Matrix4()
const UP = new THREE.Vector3(0, 1, 0)

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _c = new THREE.Color()
const _tint: [number, number, number] = [1, 0.8, 0.4]

/** Sparks of power streaming up off the body. */
const RISE: ParticleStyle = { c0: [4.4, 3, 1.3, 1], c1: [1.4, 0.4, 0.08, 0], s0: 0.04, s1: 0.015, gravity: -7, drag: 1.4, curl: 1.8, curlFreq: 1.4, stretch: 0.07, flicker: 0.3, core: 0.95, fadeIn: 0.02 }
/** The classic power lines: fast vertical streaks rising around the body. */
const LINE: ParticleStyle = { c0: [2.6, 1.9, 0.9, 1], c1: [1.6, 0.8, 0.25, 0], s0: 0.035, s1: 0.02, gravity: -4, drag: 0.6, stretch: 0.055, core: 0.7, fadeIn: 0.12 }
/** Pale dust lifted off the ground by the pressure of the power. */
const LIFT: ParticleStyle = { c0: [2.2, 1.4, 0.6, 1], c1: [0.7, 0.25, 0.06, 0], s0: 0.035, s1: 0.015, gravity: -4, drag: 1.2, curl: 2, curlFreq: 1.2, stretch: 0.06, flicker: 0.3, core: 0.9, fadeIn: 0.05 }

const NOISE2 = /* glsl */ `
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm2(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vn2(p); p = p * 2.03 + 1.7; a *= 0.5; } return v; }
`

type U = Record<string, THREE.IUniform>

/**
 * Fresnel flame shell on a skinned copy of the hero: vertices pushed out along
 * their normals and licked upward by scrolling noise. Only the rim burns, so
 * the body inside stays readable.
 */
function shellMaterial(u: U, inflate: number, rise: number, alpha: number) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uInflate: { value: inflate }, uRise: { value: rise }, uLayer: { value: alpha } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <skinning_pars_vertex>
      uniform float uTime;
      uniform float uInflate;
      uniform float uRise;
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vW;
      ${NOISE3}
      void main() {
        #include <skinbase_vertex>
        #include <beginnormal_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec3 n = normalize(objectNormal);
        vec3 w = (modelMatrix * vec4(transformed, 1.0)).xyz;
        float fl = n3(w * 4.0 + vec3(0.0, -uTime * 3.2, 0.0));
        transformed += n * uInflate * (0.55 + fl * 0.9);
        // flames lick upward off the surfaces that face the sky
        transformed.y += uRise * fl * fl * clamp(n.y * 0.6 + 0.5, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
        vView = normalize(-mv.xyz);
        vN = normalize(normalMatrix * n);
        vW = w;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uHot;
      uniform float uPower;
      uniform float uTime;
      uniform float uLayer;
      varying vec3 vN;
      varying vec3 vView;
      varying vec3 vW;
      ${NOISE3}
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vView)));
        float fl = fbm3(vW * vec3(6.0, 2.4, 6.0) + vec3(0.0, -uTime * 4.5, uTime * 0.3));
        float tongues = smoothstep(0.38, 0.78, fl);
        float rim = pow(f, 2.2);
        float v = rim * (0.3 + tongues * 1.2) * uPower * uLayer;
        vec3 c = mix(uColor, uHot, clamp(rim * tongues * 1.2 + uPower * 0.1, 0.0, 1.0));
        gl_FragColor = vec4(c * v, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}

/**
 * The flame envelope: an upright camera-facing teardrop of fire set just
 * behind the hero, so the body occludes its middle and reads as a dark
 * silhouette inside a blazing outline. Tongues and power lines scroll upward.
 */
function envelopeMaterial(u: U) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uCenter: { value: new THREE.Vector3() }, uScale: { value: 1 }, uAlpha: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform vec3 uCenter;
      uniform float uScale;
      varying vec2 vP;
      void main() {
        vec3 toCam = cameraPosition - uCenter;
        toCam.y = 0.0;
        toCam = normalize(toCam + vec3(1e-4, 0.0, 0.0));
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        // hero-space metres: x across, y up from the feet
        vP = vec2(position.x * 3.0, (position.y + 0.5) * 4.4 - 0.2);
        vec3 p = uCenter - toCam * 0.5 + (right * vP.x + vec3(0.0, vP.y, 0.0)) * uScale;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uHot;
      uniform float uTime;
      uniform float uAlpha;
      uniform float uPower;
      varying vec2 vP;
      ${NOISE2}
      void main() {
        float t = uTime;
        float y = vP.y;
        // the whole flame sways a little, more toward the top
        float x = vP.x + (vn2(vec2(y * 0.8 - t * 1.5, 1.7)) - 0.5) * 0.3 * smoothstep(0.5, 3.0, y);
        // teardrop half-width: hugs the feet, swells around the body, draws up to a point
        float h = clamp(y / 3.4, 0.0, 1.0);
        float w = 0.95 * pow(sin(3.14159 * (h * 0.9 + 0.07)), 0.75);
        // tongues of flame break the outline, more toward the top
        float n1 = fbm2(vec2(x * 2.2, y * 1.1 - t * 2.8));
        float n2 = vn2(vec2(x * 6.0 + 3.0, y * 1.6 - t * 6.5));
        w *= 1.0 + (n1 - 0.5) * (0.5 + h * 0.9) + (n2 - 0.5) * h * 0.7;
        float d = abs(x) - w;
        float inside = (1.0 - smoothstep(-0.1, 0.06, d));
        // a bright band hugging the outline, falling off softly inward and sharply outward
        float edge = exp(-abs(d) * (d < 0.0 ? 4.0 : 14.0));
        float lines = smoothstep(0.72, 0.98, vn2(vec2(x * 11.0, y * 0.7 - t * 8.0))) * inside;
        float v = edge * (0.4 + n2 * 0.7) + inside * (0.025 + n1 * 0.05) + lines * 0.5;
        v *= smoothstep(-0.2, 0.25, y) * (1.0 - smoothstep(2.9, 4.3, y + n1 * 0.8));
        vec3 c = mix(uColor, uHot, clamp(edge * edge * edge * 0.8 + lines * 0.4, 0.0, 1.0));
        gl_FragColor = vec4(c * v * uAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

/** A glowing pool and broken ring of power on the ground under the feet. */
function ringMaterial(u: U) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, ...decalUniforms(), uAlpha: { value: 0 }, uR: { value: 2 } },
    vertexShader: DECAL_VERT,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uHot;
      uniform float uTime;
      uniform float uAlpha;
      uniform float uR;
      varying vec2 vRel;
      ${NOISE2}
      void main() {
        vec2 d = vRel / uR;
        float r = length(d);
        if (r > 1.0) discard;
        float a = atan(d.y, d.x);
        float n = vn2(vec2(a * 3.0 + uTime * 0.7, r * 5.0 - uTime * 2.5));
        float band = exp(-pow((r - 0.8 - (n - 0.5) * 0.06) * 13.0, 2.0)) * (0.5 + n);
        float inner = exp(-pow((r - 0.52) * 34.0, 2.0)) * 0.45 * step(0.35, vn2(vec2(a * 8.0 - uTime * 2.0, 1.0)));
        float rays = pow(max(0.0, sin(a * 7.0 + uTime * 1.3 + n * 2.0)), 18.0) * smoothstep(0.15, 0.6, r) * (1.0 - smoothstep(0.7, 1.0, r)) * 0.5;
        float pool = exp(-r * 4.0) * 0.35;
        float v = (band + inner + rays + pool) * (1.0 - smoothstep(0.9, 1.0, r));
        vec3 c = mix(uColor, uHot, clamp(pool + band * 0.4, 0.0, 1.0));
        gl_FragColor = vec4(c * v * uAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
}

/** Skeleton segments sampled for points on the body. */
type Seg = [THREE.Object3D, THREE.Object3D]

/**
 * The hero's visible power: a fresnel flame shell on the body, a blazing
 * envelope behind it, a ring of light on the ground, rising sparks and power
 * lines, a golden light, and crackling arcs at high power. setPower() holds a
 * level for a frame, flare() bursts. The flames run on the hero's clock; the
 * particles it sheds live on the world clock, so they hang in stopped time.
 */
export class Aura {
  readonly root = new THREE.Group()
  /** Simmer floor (0..1), set every frame by whoever decides the hero is mighty. */
  idle = 0
  /** Current visible intensity (power plus flares, up to ~1.6). */
  level = 0
  private held = 0
  private power = 0
  private flareV = 0
  private time = 0
  private tint = new THREE.Color()
  private tintT = 0
  private model: HeroModel
  private fx: AuraFx | null
  private bolts: Lightning | null
  private ground: AuraGround | null = null
  private q: number
  private u = {
    uTime: { value: 0 },
    uPower: { value: 0 },
    uColor: { value: GOLD.clone() },
    uHot: { value: HOT.clone() },
  }
  private shells: THREE.Group
  private inner: THREE.ShaderMaterial
  private outer: THREE.ShaderMaterial
  private outerMeshes: THREE.Object3D[] = []
  private envelope: THREE.Mesh
  private envMat: THREE.ShaderMaterial
  private ring: TerrainDecal
  private ringMat: THREE.ShaderMaterial
  private light: THREE.PointLight
  private segs: Seg[]
  private riseAcc = 0
  private lineAcc = 0
  private liftAcc = 0
  private arcAcc = 0
  private arcOpts: BoltOpts = { color: GOLD.clone(), life: 0.1, width: 0.07, forks: 1, intensity: 1 }

  constructor(model: HeroModel, fx: AuraFx | null, bolts: Lightning | null, quality = 1, cell = 2) {
    this.model = model
    this.fx = fx
    this.bolts = bolts
    this.q = quality
    this.inner = shellMaterial(this.u, 0.012, 0, 0.8)
    this.outer = shellMaterial(this.u, 0.06, 0.2, 0.5)
    this.shells = new THREE.Group()
    // skinned copies bound to the hero's live skeleton (detached, so they draw in world space)
    for (const mat of [this.inner, this.outer]) {
      for (const m of model.meshes) {
        const s = new THREE.SkinnedMesh(m.geometry, mat)
        s.bindMode = THREE.DetachedBindMode
        s.bind(model.skeleton, ID)
        s.frustumCulled = false
        s.renderOrder = mat === this.inner ? 6 : 7
        if (mat === this.outer) this.outerMeshes.push(s)
        this.shells.add(s)
      }
    }
    this.envMat = envelopeMaterial(this.u)
    this.envelope = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), this.envMat)
    this.envelope.frustumCulled = false
    this.envelope.renderOrder = 5
    this.ringMat = ringMaterial(this.u)
    this.ring = new TerrainDecal(5, this.ringMat, cell)
    this.ring.mesh.renderOrder = 4
    // the light never leaves the scene: a changing light count would recompile every lit material
    this.light = new THREE.PointLight(GOLD, 0, 16, 1.6)
    this.light.position.set(0, -50, 0)
    this.root.add(this.shells, this.envelope, this.ring.mesh, this.light)
    const r = model.rig
    this.segs = [
      [r.hips, r.spine],
      [r.spine, r.chest],
      [r.chest, r.neck],
      [r.chest, r.neck],
      [r.neck, r.head],
      [r.shoulderL, r.elbowL],
      [r.elbowL, r.handL],
      [r.shoulderR, r.elbowR],
      [r.elbowR, r.handR],
      [r.thighL, r.kneeL],
      [r.kneeL, r.footL],
      [r.thighR, r.kneeR],
      [r.kneeR, r.footR],
      [r.shoulderL, r.shoulderR],
    ]
    this.setVisible(false)
  }

  setGround(ground: AuraGround | null) {
    this.ground = ground
    this.ring.setGround(ground)
  }

  /** Hold the aura at `k` (0..1) for this frame; it falls back to the idle simmer when no one asks. */
  setPower(k: number) {
    this.held = Math.max(this.held, k)
  }

  /**
   * A one-shot burst: the aura blazes up and falls back. Optional colour tints
   * it for a moment; `particles` false skips the burst of sparks (stopped time).
   */
  flare(amount: number, color?: THREE.ColorRepresentation, particles = true) {
    this.flareV = Math.min(1.6, this.flareV + amount)
    if (color !== undefined) {
      this.tint.set(color)
      this.tintT = 1.4
    }
    const fx = this.fx
    if (fx && particles && amount > 0.05) {
      const c = this.currentColor()
      _tint[0] = Math.min(1, c.r * 0.4 + 0.6)
      _tint[1] = Math.min(1, c.g * 0.4 + 0.5)
      _tint[2] = Math.min(1, c.b * 0.4 + 0.3)
      const root = this.model.rig.root.position
      const n = Math.min(1.5, amount)
      fx.motes(this.bodyPoint(_v, 0.3), Math.round(80 * n), 1.2 + n, _tint, null)
      fx.emberDrift(_w.copy(root), Math.round(90 * n), 0.9, { height: 2.2, rise: 3 + n * 3, burst: 2 + n * 2, life: 1.4, size: 0.1, color: _tint, curl: 1.6 })
      fx.plasmaRing(_w.copy(root).setY(root.y + 0.25), UP, 2.5 + n * 3, Math.round(120 * n), _tint, { expand: 0.3, fill: 0.5, thick: 0.08, life: 0.5, size: 0.035, heat: 2.2 })
    }
    for (let i = 0; i < Math.round(2 + amount * 5); i++) this.crackle(0.35)
  }

  reset() {
    this.held = this.power = this.flareV = this.level = 0
    this.idle = 0
    this.tintT = 0
    this.setVisible(false)
    this.light.intensity = 0
  }

  private setVisible(on: boolean) {
    this.shells.visible = on
    this.envelope.visible = on
    this.ring.mesh.visible = on
  }

  private currentColor() {
    _c.copy(GOLD)
    if (this.tintT > 0) _c.lerp(this.tint, Math.min(1, this.tintT))
    return _c
  }

  /** A random point on (or just off) the hero's body. */
  private bodyPoint(out: THREE.Vector3, spread: number) {
    const s = this.segs[(Math.random() * this.segs.length) | 0]
    const t = Math.random()
    const a = s[0].matrixWorld.elements
    const b = s[1].matrixWorld.elements
    out.set(a[12] + (b[12] - a[12]) * t, a[13] + (b[13] - a[13]) * t, a[14] + (b[14] - a[14]) * t)
    out.x += (Math.random() - 0.5) * spread * 2
    out.y += (Math.random() - 0.5) * spread
    out.z += (Math.random() - 0.5) * spread * 2
    return out
  }

  /** A short arc jumping between two points around the body. */
  private crackle(reach: number) {
    if (!this.bolts) return
    this.bodyPoint(_v, reach)
    this.bodyPoint(_w, reach)
    if (_v.distanceToSquared(_w) < 0.09) _w.y += 0.5
    const o = this.arcOpts
    ;(o.color as THREE.Color).copy(this.currentColor()).lerp(HOT, 0.3)
    o.life = 0.06 + Math.random() * 0.08
    o.width = 0.04 + Math.random() * 0.04
    o.intensity = 0.7 + Math.random() * 0.5
    this.bolts.arc(_v, _w, o)
  }

  /** dt: the hero's clock (flames, arcs). wdt: the world clock (shed particles). */
  update(dt: number, wdt = dt) {
    this.time += dt
    const target = Math.max(this.idle, this.held)
    this.held = 0
    this.power += (target - this.power) * damp(target > this.power ? 9 : 3.5, dt)
    this.flareV *= Math.exp(-dt * 2.4)
    this.tintT = Math.max(0, this.tintT - dt)
    const L = this.power + this.flareV
    this.level = L
    const on = L > 0.01
    this.setVisible(on)
    if (!on) {
      this.light.intensity = 0
      return
    }
    const Lc = Math.min(1.5, L)
    const col = this.currentColor()
    this.u.uColor.value.copy(col)
    this.u.uHot.value.copy(HOT).lerp(col, this.tintT > 0 ? 0.25 : 0)
    this.u.uTime.value = this.time
    this.u.uPower.value = Lc
    // the outer flames only kindle once the power is real
    const outerOn = L > 0.15
    for (const m of this.outerMeshes) m.visible = outerOn
    this.outer.uniforms.uLayer.value = 0.5 * Math.min(1, (L - 0.15) * 2.5)
    this.outer.uniforms.uInflate.value = 0.035 + 0.075 * Lc
    this.outer.uniforms.uRise.value = 0.06 + 0.4 * Lc
    this.inner.uniforms.uLayer.value = 0.55 + 0.25 * Math.min(1, L)

    const root = this.model.rig.root.position
    const eu = this.envMat.uniforms
    eu.uCenter.value.copy(root)
    eu.uScale.value = 0.75 + Lc * 0.45
    const env = Math.min(1, Math.max(0, (L - 0.12) / 0.6))
    eu.uAlpha.value = env * env * (0.65 + 0.25 * Lc)
    this.envelope.visible = env > 0
    // the ring lies on the ground; it fades as the hero rises off it
    const gy = this.ground ? this.ground.heightAt(root.x, root.z) : 0
    const air = Math.max(0, 1 - (root.y - gy) / 5)
    this.ring.place(root.x, root.z)
    this.ringMat.uniforms.uR.value = 1.1 + Lc * 1.7
    this.ringMat.uniforms.uAlpha.value = Math.min(1, 0.8 * Math.pow(L, 1.5)) * air
    this.ring.mesh.visible = air > 0
    const ch = this.model.rig.chest.matrixWorld.elements
    this.light.position.set(ch[12], ch[13] + 0.4, ch[14])
    this.light.color.copy(col)
    this.light.intensity = 16 * Math.pow(Math.min(1.6, L), 1.3)
    this.light.distance = 10 + L * 10

    const fx = this.fx
    if (fx && wdt > 0) {
      const light = fx.gpu.light
      // sparks streaming up off the body
      this.riseAcc += wdt * (16 + 260 * L * L) * this.q
      while (this.riseAcc >= 1) {
        this.riseAcc -= 1
        this.bodyPoint(_v, 0.25)
        light.emit(_v.x, _v.y, _v.z, (Math.random() - 0.5) * 1.4, 1 + Math.random() * 3 * (0.5 + L), (Math.random() - 0.5) * 1.4, 0.5 + Math.random() * 0.7, RISE, 0.6 + Math.random() * 0.8, 0.6 + Math.random() * 0.6)
      }
      // power lines rush up around the body
      if (L > 0.3) {
        this.lineAcc += wdt * 90 * (L - 0.3) * this.q
        while (this.lineAcc >= 1) {
          this.lineAcc -= 1
          const a = Math.random() * Math.PI * 2
          const r = 0.45 + Math.random() * 0.5 * (0.6 + Lc * 0.5)
          light.emit(root.x + Math.sin(a) * r, root.y + Math.random() * 1.6, root.z + Math.cos(a) * r, 0, 7 + Math.random() * 7 * Lc, 0, 0.18 + Math.random() * 0.16, LINE, 0.7 + Math.random() * 0.6, 0.6 + Math.random() * 0.5)
        }
      }
      // grit lifts off the ground around the feet
      if (L > 0.45 && air > 0.5) {
        this.liftAcc += wdt * 50 * (L - 0.45) * this.q
        while (this.liftAcc >= 1) {
          this.liftAcc -= 1
          const a = Math.random() * Math.PI * 2
          const r = 0.8 + Math.random() * (1.5 + Lc * 2)
          const x = root.x + Math.sin(a) * r
          const z = root.z + Math.cos(a) * r
          const y = (this.ground ? this.ground.heightAt(x, z) : 0) + 0.05
          light.emit(x, y, z, Math.sin(a) * 0.4, 0.8 + Math.random() * 2, Math.cos(a) * 0.4, 1 + Math.random() * 1.2, LIFT, 0.6 + Math.random() * 0.8, 0.5 + Math.random() * 0.5)
        }
      }
    }
    // crackling arcs once the power runs high
    if (L > 0.55 && dt > 0) {
      this.arcAcc += dt * (L - 0.55) * 24
      while (this.arcAcc >= 1) {
        this.arcAcc -= 1
        this.crackle(0.3 + L * 0.2)
      }
    }
  }
}
