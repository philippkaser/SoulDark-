import * as THREE from 'three'
import { damp } from '../../engine/math'
import type { ParticlePool } from '../../engine/particles'
import type { HeroModel } from '../player/heroModel'
import type { BoltOpts, Lightning } from './lightning'
import { NOISE3 } from './shaders'

/** The bits of Fx the aura uses (Fx satisfies it structurally). */
export interface AuraFx {
  glow: ParticlePool
  fire: ParticlePool
}

const GOLD = new THREE.Color('#ffb648')
const HOT = new THREE.Color('#fff1c8')
const ID = new THREE.Matrix4()

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _c = new THREE.Color()
const _mote: [number, number, number] = [1, 0.8, 0.4]

const NOISE2 = /* glsl */ `
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm2(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vn2(p); p = p * 2.03 + 1.7; a *= 0.5; } return v; }
`

/**
 * Fresnel flame shell on a skinned copy of the hero: vertices pushed out along
 * their normals and licked upward by scrolling noise, edges burning brightest.
 */
function shellMaterial(u: Record<string, THREE.IUniform>, inflate: number, rise: number, alpha: number) {
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
        float f = 1.0 - abs(dot(normalize(vN), vView));
        float fl = fbm3(vW * vec3(6.0, 2.4, 6.0) + vec3(0.0, -uTime * 4.5, uTime * 0.3));
        float tongues = smoothstep(0.38, 0.78, fl);
        float rim = pow(f, 1.7);
        float v = (rim * (0.35 + tongues * 1.3) + tongues * 0.06) * uPower * uLayer;
        vec3 c = mix(uColor, uHot, clamp(rim * tongues * 1.4 + uPower * 0.15, 0.0, 1.0));
        gl_FragColor = vec4(c * v, v);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}

/**
 * The flame envelope: a camera-facing (upright) teardrop of fire set just
 * behind the hero, so the body occludes its middle and it reads as a blazing
 * silhouette. Tongues scroll upward; streaks of energy rise through it.
 */
function envelopeMaterial(u: Record<string, THREE.IUniform>) {
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
        vP = vec2(position.x * 2.8, (position.y + 0.5) * 4.0 - 0.15);
        vec3 p = uCenter - toCam * 0.45 + (right * vP.x + vec3(0.0, vP.y, 0.0)) * uScale;
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
        vec2 p = vP;
        float t = uTime;
        // teardrop around the body: round below, drawn up into a crown of flame
        vec2 q = vec2(p.x, p.y - 1.0);
        q.y *= q.y > 0.0 ? 0.56 : 1.05;
        float r = length(q) / 0.92;
        float n1 = fbm2(vec2(p.x * 2.6, p.y * 1.5 - t * 2.4));
        float n2 = vn2(vec2(p.x * 7.0 + 3.0, p.y * 2.2 - t * 5.0));
        float crown = smoothstep(1.1, 2.4, p.y);
        float R = 0.84 + (n1 - 0.5) * 0.55 + crown * (n2 - 0.3) * 0.8;
        float d = r - R;
        float fill = smoothstep(0.1, -0.35, d);
        float rim = exp(-abs(d + 0.05) * 10.0) * smoothstep(0.3, -0.05, d);
        float streak = smoothstep(0.6, 0.95, vn2(vec2(p.x * 11.0, p.y * 0.9 - t * 6.5))) * fill;
        float v = fill * (0.16 + n1 * 0.22) + rim * (0.55 + n2 * 0.6) + streak * 0.55;
        v *= smoothstep(-0.15, 0.25, p.y);
        vec3 c = mix(uColor, uHot, clamp(rim * 0.7 + streak * 0.6 + uPower * 0.1, 0.0, 1.0));
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
function ringMaterial(u: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, uAlpha: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uHot;
      uniform float uTime;
      uniform float uAlpha;
      varying vec2 vUv;
      ${NOISE2}
      void main() {
        vec2 d = (vUv - 0.5) * 2.0;
        float r = length(d);
        if (r > 1.0) discard;
        float a = atan(d.y, d.x);
        float n = vn2(vec2(a * 3.0 + uTime * 0.7, r * 5.0 - uTime * 2.5));
        float band = exp(-pow((r - 0.8 - (n - 0.5) * 0.06) * 13.0, 2.0)) * (0.5 + n);
        float inner = exp(-pow((r - 0.52) * 34.0, 2.0)) * 0.45 * step(0.35, vn2(vec2(a * 8.0 - uTime * 2.0, 1.0)));
        float rays = pow(max(0.0, sin(a * 7.0 + uTime * 1.3 + n * 2.0)), 18.0) * smoothstep(0.15, 0.6, r) * smoothstep(1.0, 0.7, r) * 0.5;
        float pool = exp(-r * 3.2) * 0.75;
        float v = (band + inner + rays + pool) * smoothstep(1.0, 0.9, r);
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

/**
 * The hero's visible power: a flame shell on the body, a blazing envelope, a
 * ring of light on the ground, rising motes and fire, a golden light, and
 * crackling arcs at high power. Runs on the player's clock.
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
  private envelope: THREE.Mesh
  private envMat: THREE.ShaderMaterial
  private ring: THREE.Mesh
  private ringMat: THREE.ShaderMaterial
  private light: THREE.PointLight
  private emitters: THREE.Object3D[]
  private moteAcc = 0
  private wispAcc = 0
  private arcAcc = 0
  private arcOpts: BoltOpts = { color: GOLD.clone(), life: 0.1, width: 0.07, forks: 1, intensity: 1 }

  constructor(model: HeroModel, fx: AuraFx | null, bolts: Lightning | null, quality = 1) {
    this.model = model
    this.fx = fx
    this.bolts = bolts
    this.q = quality
    this.inner = shellMaterial(this.u, 0.018, 0.02, 0.9)
    this.outer = shellMaterial(this.u, 0.06, 0.2, 0.55)
    this.shells = new THREE.Group()
    // skinned copies bound to the hero's live skeleton (detached, so they draw in world space)
    for (const mat of [this.inner, this.outer]) {
      for (const m of model.meshes) {
        const s = new THREE.SkinnedMesh(m.geometry, mat)
        s.bindMode = THREE.DetachedBindMode
        s.bind(model.skeleton, ID)
        s.frustumCulled = false
        s.renderOrder = mat === this.inner ? 6 : 7
        this.shells.add(s)
      }
    }
    this.envMat = envelopeMaterial(this.u)
    this.envelope = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), this.envMat)
    this.envelope.frustumCulled = false
    this.envelope.renderOrder = 5
    this.ringMat = ringMaterial(this.u)
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), this.ringMat)
    this.ring.frustumCulled = false
    this.ring.renderOrder = 4
    this.light = new THREE.PointLight(GOLD, 0, 16, 1.6)
    this.root.add(this.shells, this.envelope, this.ring, this.light)
    const r = model.rig
    this.emitters = [r.hips, r.spine, r.chest, r.chest, r.neck, r.head, r.shoulderL, r.shoulderR, r.elbowL, r.elbowR, r.handL, r.handR, r.kneeL, r.kneeR, r.footL, r.footR]
    this.root.visible = false
  }

  /** Hold the aura at `k` (0..1) for this frame; it falls back to the idle simmer when no one asks. */
  setPower(k: number) {
    this.held = Math.max(this.held, k)
  }

  /** A one-shot burst: the aura blazes up and falls back. Optional colour tints it for a moment. */
  flare(amount: number, color?: THREE.ColorRepresentation) {
    this.flareV = Math.min(1.6, this.flareV + amount)
    if (color !== undefined) {
      this.tint.set(color)
      this.tintT = 1.4
    }
    const fx = this.fx
    if (fx) {
      const n = Math.round(60 * amount * this.q)
      const c = this.currentColor()
      for (let i = 0; i < n; i++) {
        this.emitPoint(_v, 0.15)
        _w.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 6)
        _w.y = 2 + Math.random() * 9
        _mote[0] = Math.min(1, c.r * 0.4 + 0.65)
        _mote[1] = Math.min(1, c.g * 0.4 + 0.6)
        _mote[2] = Math.min(1, c.b * 0.4 + 0.5)
        fx.glow.spawn(_v, _w, _mote, 1, 0.05 + Math.random() * 0.07, 0.5 + Math.random() * 0.7, -2, 1.6)
      }
    }
    for (let i = 0; i < Math.round(2 + amount * 6); i++) this.crackle(0.35)
  }

  reset() {
    this.held = this.power = this.flareV = this.level = 0
    this.idle = 0
    this.tintT = 0
    this.root.visible = false
    this.light.intensity = 0
  }

  private currentColor() {
    _c.copy(GOLD)
    if (this.tintT > 0) _c.lerp(this.tint, Math.min(1, this.tintT))
    return _c
  }

  /** A random point on (or just off) the hero's body. */
  private emitPoint(out: THREE.Vector3, spread: number) {
    const b = this.emitters[(Math.random() * this.emitters.length) | 0]
    b.getWorldPosition(out)
    out.x += (Math.random() - 0.5) * spread * 2
    out.y += (Math.random() - 0.5) * spread
    out.z += (Math.random() - 0.5) * spread * 2
    return out
  }

  /** A short arc jumping between two points around the body. */
  private crackle(reach: number) {
    if (!this.bolts) return
    this.emitPoint(_v, reach)
    this.emitPoint(_w, reach)
    if (_v.distanceToSquared(_w) < 0.09) _w.y += 0.5
    const o = this.arcOpts
    ;(o.color as THREE.Color).copy(this.currentColor())
    o.life = 0.06 + Math.random() * 0.08
    o.width = 0.05 + Math.random() * 0.05
    o.intensity = 0.8 + Math.random() * 0.5
    this.bolts.arc(_v, _w, o)
  }

  update(dt: number) {
    this.time += dt
    const target = Math.max(this.idle, this.held)
    this.held = 0
    this.power += (target - this.power) * damp(target > this.power ? 9 : 3.5, dt)
    this.flareV *= Math.exp(-dt * 2.4)
    this.tintT = Math.max(0, this.tintT - dt)
    const L = this.power + this.flareV
    this.level = L
    const on = L > 0.008
    this.root.visible = on
    if (!on) {
      this.light.intensity = 0
      return
    }
    const col = this.currentColor()
    this.u.uColor.value.copy(col)
    this.u.uHot.value.copy(HOT).lerp(col, this.tintT > 0 ? 0.25 : 0)
    this.u.uTime.value = this.time
    this.u.uPower.value = Math.min(1.5, L)
    this.outer.uniforms.uInflate.value = 0.035 + 0.08 * Math.min(1.4, L)
    this.outer.uniforms.uRise.value = 0.06 + 0.42 * Math.min(1.4, L)

    const root = this.model.rig.root.position
    const eu = this.envMat.uniforms
    eu.uCenter.value.copy(root)
    eu.uScale.value = 0.78 + Math.min(1.5, L) * 0.42
    eu.uAlpha.value = Math.min(1.5, L * (0.55 + L * 0.45))
    // the ring lies on the ground; it fades as the hero rises off it
    const air = Math.max(0, 1 - root.y / 5)
    this.ring.position.set(root.x, 0.035, root.z)
    this.ring.scale.setScalar(1.2 + Math.min(1.5, L) * 2.6)
    this.ringMat.uniforms.uAlpha.value = Math.min(1.4, L * 1.1) * air
    this.ring.visible = air > 0
    this.model.rig.chest.getWorldPosition(this.light.position)
    this.light.position.y += 0.4
    this.light.color.copy(col)
    this.light.intensity = 30 * Math.pow(Math.min(1.6, L), 1.4)
    this.light.distance = 10 + L * 10

    // motes and wisps stream upward off the body
    const fx = this.fx
    if (fx && dt > 0) {
      this.moteAcc += dt * (12 + 230 * L * L) * this.q
      while (this.moteAcc >= 1) {
        this.moteAcc -= 1
        this.emitPoint(_v, 0.35)
        _w.set((Math.random() - 0.5) * 1.2, 1.5 + Math.random() * 3.5 * (0.5 + L), (Math.random() - 0.5) * 1.2)
        const white = Math.random() < 0.35
        _mote[0] = 1
        _mote[1] = white ? 0.95 : Math.min(1, col.g * 0.5 + 0.45)
        _mote[2] = white ? 0.85 : Math.min(1, col.b * 0.5 + 0.2)
        fx.glow.spawn(_v, _w, _mote, 0.9, 0.03 + Math.random() * 0.05, 0.5 + Math.random() * 0.8, -1.5, 1.2)
      }
      if (L > 0.35) {
        this.wispAcc += dt * 34 * (L - 0.35) * this.q
        while (this.wispAcc >= 1) {
          this.wispAcc -= 1
          this.emitPoint(_v, 0.25)
          _w.set((Math.random() - 0.5) * 0.8, 3 + Math.random() * 4, (Math.random() - 0.5) * 0.8)
          _mote[0] = Math.min(1, col.r * 0.6 + 0.4)
          _mote[1] = Math.min(1, col.g * 0.6 + 0.2)
          _mote[2] = Math.min(1, col.b * 0.6 + 0.05)
          fx.fire.spawn(_v, _w, _mote, 0.45, 0.22 + Math.random() * 0.25, 0.3 + Math.random() * 0.25, -3, 2, { grow: -0.6 })
        }
      }
    }
    // crackling arcs once the power runs high
    if (L > 0.55 && dt > 0) {
      this.arcAcc += dt * (L - 0.55) * 26
      while (this.arcAcc >= 1) {
        this.arcAcc -= 1
        this.crackle(0.3 + L * 0.2)
      }
    }
  }
}
