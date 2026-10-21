import * as THREE from 'three'
import { NOISE3 } from './shaders'

/**
 * The fist's own visual vocabulary: pressure rings racing down the line of a
 * punch, the vapor cone that snaps around the fist, the long translucent wake
 * of compressed air, and the glow gathered in the fist while it charges.
 * Everything is additive and fairly dim on purpose: big moments read through
 * shape and motion, not more white.
 */

const Z = new THREE.Vector3(0, 0, 1)
const _v = new THREE.Vector3()

/** A ring's radius at normalised age u: a hard ease-out, the front racing outward then slowing. */
export function ringRadius(r0: number, r1: number, u: number) {
  const k = Math.min(1, Math.max(0, u))
  return r0 + (r1 - r0) * (1 - Math.pow(1 - k, 3))
}

/** A ring's brightness at normalised age u: snaps on, then fades. */
export function ringAlpha(u: number) {
  if (u <= 0 || u >= 1) return 0
  return Math.min(1, u * 14) * Math.pow(1 - u, 1.6)
}

function ringMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uThick: { value: 0.2 }, uSeed: { value: 0 }, uAge: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vFace;
      varying float vNear;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec3 n = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        vFace = abs(dot(normalize(cameraPosition - wp.xyz), n));
        // a ring right in front of the lens would wash the hero out: it thins away instead
        float r = length(modelMatrix[0].xyz);
        float dc = length(cameraPosition - modelMatrix[3].xyz);
        vNear = smoothstep(r * 1.2 + 2.0, r * 2.5 + 7.0, dc);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uThick;
      uniform float uSeed;
      uniform float uAge;
      varying vec2 vUv;
      varying float vFace;
      varying float vNear;
      float h(float n) { return fract(sin(n) * 43758.5453); }
      float vn(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h(i + uSeed), h(i + 1.0 + uSeed), f); }
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float a = atan(vUv.y, vUv.x) / 6.2831853 + 0.5;
        // a ragged shock front: sharp outside, a soft compressed band trailing inside
        float wob = (vn(a * 23.0) - 0.5) * uThick * 0.35 + (vn(a * 71.0 + uAge * 3.0) - 0.5) * uThick * 0.15;
        float rr = r + wob;
        float edge = 1.0 - smoothstep(0.985 - uThick * 0.08, 1.0, rr);
        float band = smoothstep(1.0 - uThick, 0.995, rr) * edge;
        float rim = exp(-pow((rr - 0.975) / (0.02 + uThick * 0.06), 2.0));
        // streaks of condensation around the ring
        float streak = 0.55 + 0.45 * vn(a * 140.0 + uSeed * 3.0);
        float v = (band * 0.45 + rim) * streak;
        // seen edge-on the quad is a sliver: let it go rather than alias
        v *= smoothstep(0.04, 0.35, vFace) * vNear;
        gl_FragColor = vec4(uColor * v * uAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

/** The vapor cone: a white shell of condensation flaring back over the fist. */
function vaporMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uAge: { value: 0 }, uSeed: { value: 0 }, uColor: { value: new THREE.Color(1, 0.97, 0.92) } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vView;
      varying vec2 vUv;
      varying float vSide;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - wp.xyz);
        // a cone seen down its own axis is a white disc over the hero: it only shows from the side
        vec3 axis = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        vec3 toCam = normalize(cameraPosition - modelMatrix[3].xyz);
        float r = length(modelMatrix[0].xyz);
        vSide = (1.0 - smoothstep(0.55, 0.9, abs(dot(toCam, axis)))) * smoothstep(r * 1.5 + 1.0, r * 3.0 + 4.0, length(cameraPosition - modelMatrix[3].xyz));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      uniform float uAge;
      uniform float uSeed;
      uniform vec3 uColor;
      varying vec3 vN;
      varying vec3 vView;
      varying vec2 vUv;
      varying float vSide;
      ${NOISE3}
      void main() {
        // a thin shell: only its silhouette shows, combed into streaks that trail off the fist
        float f = 1.0 - abs(dot(normalize(vN), vView));
        float streak = fbm3(vec3(vUv.x * 40.0, vUv.y * 2.0 - uAge * 8.0, uSeed));
        float wisp = smoothstep(0.42, 0.8, streak);
        // brightest just behind the apex (uv.y = 1), torn away toward the open end
        float along = smoothstep(0.0, 0.75, vUv.y) * smoothstep(1.0, 0.9, vUv.y);
        float v = pow(f, 3.0) * (0.35 + 0.65 * wisp) * along * vSide;
        gl_FragColor = vec4(uColor * v * uAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

/** The wake: a long funnel of compressed air streaming down the line of the punch. */
function wakeMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uTime: { value: 0 }, uReach: { value: 1 }, uLen: { value: 100 }, uSeed: { value: 0 }, uColor: { value: new THREE.Color(1, 0.88, 0.7) } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vView;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      uniform float uTime;
      uniform float uReach;
      uniform float uLen;
      uniform float uSeed;
      uniform vec3 uColor;
      varying vec3 vN;
      varying vec3 vView;
      varying vec2 vUv;
      ${NOISE3}
      void main() {
        // uv.y runs from the fist (0) to the far end (1)
        float y = vUv.y;
        if (y > uReach) discard;
        float f = 1.0 - abs(dot(normalize(vN), vView));
        // long streamers racing away from the fist
        float m = uLen / 40.0;
        float s = fbm3(vec3(vUv.x * 22.0, y * m - uTime * 2.4, uSeed));
        float streak = smoothstep(0.45, 0.8, s);
        float head = smoothstep(uReach - 0.04, uReach, y) * 1.5;
        float v = (streak * (0.3 + 0.7 * f * f) + head * f) * smoothstep(0.0, 0.02, y);
        // dimmer far away, so the horizon does not glow
        v *= mix(1.0, 0.35, y);
        gl_FragColor = vec4(uColor * v * uAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

function glowMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1, 0.85, 0.6) }, uAlpha: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 sc = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
        mv.xy += position.xy * sc;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        float r = length(vUv);
        float a = atan(vUv.y, vUv.x);
        float spikes = pow(abs(sin(a * 6.0 + uTime * 2.0)) * abs(sin(a * 9.0 - uTime * 3.1)), 3.0);
        float v = exp(-r * 7.0) * 2.0 + exp(-r * 3.0) * 0.35 + spikes * exp(-r * 4.0) * 0.5;
        v *= smoothstep(1.0, 0.6, r);
        gl_FragColor = vec4(uColor * v * uAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}

interface Ring {
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial
  on: boolean
  t: number
  dur: number
  r0: number
  r1: number
  a0: number
  speed: number
  /** Hold-ups: a ring can wait before appearing (a volley racing down the line). */
  delay: number
  origin: THREE.Vector3
  normal: THREE.Vector3
}

interface Vapor {
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial
  on: boolean
  t: number
  dur: number
  len: number
  r0: number
  r1: number
  a0: number
}

/** A held effect the caller places every frame (the Serious Punch's travelling front, its wake). */
export interface Held {
  readonly mesh: THREE.Mesh
  readonly mat: THREE.ShaderMaterial
}

export interface RingOpts {
  /** Metres per second along the normal. */
  speed?: number
  alpha?: number
  /** Band thickness as a fraction of the radius. */
  thick?: number
  color?: THREE.ColorRepresentation
  delay?: number
}

export class PunchFx {
  readonly root = new THREE.Group()
  private rings: Ring[] = []
  private vapors: Vapor[] = []
  /** The Serious Punch's moving fronts (two rings for each of two waves) and its wake. */
  readonly front: Held[] = []
  readonly wake: Held
  /** The light gathered in the fist while it charges. */
  readonly glow: THREE.Mesh
  private glowMat: THREE.ShaderMaterial
  private time = 0

  constructor() {
    const quad = new THREE.PlaneGeometry(2, 2)
    for (let i = 0; i < 40; i++) {
      const mat = ringMat()
      const mesh = new THREE.Mesh(quad, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 10
      this.root.add(mesh)
      this.rings.push({ mesh, mat, on: false, t: 0, dur: 1, r0: 0, r1: 1, a0: 1, speed: 0, delay: 0, origin: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1) })
    }
    // apex at +y, open at the bottom; rotated so the apex leads along +z
    const cone = new THREE.ConeGeometry(1, 1, 40, 6, true).translate(0, -0.5, 0).rotateX(Math.PI / 2)
    for (let i = 0; i < 4; i++) {
      const mat = vaporMat()
      const mesh = new THREE.Mesh(cone, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 10
      this.root.add(mesh)
      this.vapors.push({ mesh, mat, on: false, t: 0, dur: 1, len: 1, r0: 1, r1: 1, a0: 1 })
    }
    for (let i = 0; i < 4; i++) {
      const mat = ringMat()
      const mesh = new THREE.Mesh(quad, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 10
      this.root.add(mesh)
      this.front.push({ mesh, mat })
    }
    // a unit funnel along +z: radius 1 at the far end, `start` (set per use via scale) at the fist
    const tube = new THREE.CylinderGeometry(1, 0.06, 1, 48, 24, true).translate(0, 0.5, 0).rotateX(Math.PI / 2)
    // cylinder uv.y runs bottom (0) to top (1): bottom is the fist after the rotation
    const wm = wakeMat()
    const wake = new THREE.Mesh(tube, wm)
    wake.visible = false
    wake.frustumCulled = false
    wake.renderOrder = 10
    this.root.add(wake)
    this.wake = { mesh: wake, mat: wm }
    this.glowMat = glowMat()
    this.glow = new THREE.Mesh(quad, this.glowMat)
    this.glow.visible = false
    this.glow.frustumCulled = false
    this.glow.renderOrder = 12
    this.root.add(this.glow)
  }

  /**
   * A pressure ring at `p`, facing `normal`, growing from r0 to r1 over `dur`
   * world seconds while it races along the normal at `speed`.
   */
  ring(p: THREE.Vector3, normal: THREE.Vector3, r0: number, r1: number, dur: number, o: RingOpts = {}) {
    let r = this.rings[0]
    for (const x of this.rings) {
      if (!x.on) {
        r = x
        break
      }
      if (x.t / x.dur > r.t / r.dur) r = x
    }
    r.on = true
    r.t = 0
    r.dur = dur
    r.r0 = r0
    r.r1 = r1
    r.a0 = o.alpha ?? 1
    r.speed = o.speed ?? 0
    r.delay = o.delay ?? 0
    r.origin.copy(p)
    r.normal.copy(normal).normalize()
    r.mesh.quaternion.setFromUnitVectors(Z, r.normal)
    r.mat.uniforms.uColor.value.set(o.color ?? '#fff1dc')
    r.mat.uniforms.uThick.value = o.thick ?? 0.18
    r.mat.uniforms.uSeed.value = Math.random() * 100
    r.mat.uniforms.uAlpha.value = 0
    r.mesh.visible = false
  }

  /** The vapor cone snapping around a fist at `p` punching along `dir`. */
  vapor(p: THREE.Vector3, dir: THREE.Vector3, len: number, r0: number, r1: number, dur: number, alpha = 1) {
    let v = this.vapors[0]
    for (const x of this.vapors) {
      if (!x.on) {
        v = x
        break
      }
      if (x.t / x.dur > v.t / v.dur) v = x
    }
    v.on = true
    v.t = 0
    v.dur = dur
    v.len = len
    v.r0 = r0
    v.r1 = r1
    v.a0 = alpha
    v.mesh.position.copy(p)
    v.mesh.quaternion.setFromUnitVectors(Z, _v.copy(dir).normalize())
    v.mat.uniforms.uSeed.value = Math.random() * 50
    v.mesh.visible = true
  }

  /** Place a front ring this frame (radius in metres); alpha 0 hides it. */
  placeFront(i: number, p: THREE.Vector3, normal: THREE.Vector3, radius: number, alpha: number, thick = 0.12) {
    const f = this.front[i]
    f.mesh.visible = alpha > 0.001
    if (!f.mesh.visible) return
    f.mesh.position.copy(p)
    f.mesh.quaternion.setFromUnitVectors(Z, normal)
    f.mesh.scale.setScalar(radius)
    const u = f.mat.uniforms
    u.uAlpha.value = alpha
    u.uThick.value = thick
    u.uAge.value = this.time
    u.uColor.value.set('#ffe6c4')
  }

  /** Place the wake: a funnel from `a` along `dir`, `len` long, opening to `radius`; `reach` 0..1 of it drawn. */
  placeWake(a: THREE.Vector3, dir: THREE.Vector3, len: number, radius: number, reach: number, alpha: number) {
    const w = this.wake
    w.mesh.visible = alpha > 0.001 && len > 1
    if (!w.mesh.visible) return
    w.mesh.position.copy(a)
    w.mesh.quaternion.setFromUnitVectors(Z, dir)
    w.mesh.scale.set(radius, radius, len)
    const u = w.mat.uniforms
    u.uAlpha.value = alpha
    u.uReach.value = reach
    u.uLen.value = len
  }

  /** The fist's gathered light this frame (size in metres; 0 hides it). */
  placeGlow(p: THREE.Vector3, size: number, alpha: number) {
    this.glow.visible = alpha > 0.001
    if (!this.glow.visible) return
    this.glow.position.copy(p)
    this.glow.scale.setScalar(size)
    this.glowMat.uniforms.uAlpha.value = alpha
  }

  hideHeld() {
    for (const f of this.front) f.mesh.visible = false
    this.wake.mesh.visible = false
    this.glow.visible = false
  }

  clear() {
    for (const r of this.rings) (r.on = false), (r.mesh.visible = false)
    for (const v of this.vapors) (v.on = false), (v.mesh.visible = false)
    this.hideHeld()
  }

  /** World dt: a stopped world holds every ring in place. */
  update(dt: number) {
    this.time += dt
    this.wake.mat.uniforms.uTime.value = this.time
    this.wake.mat.uniforms.uSeed.value = 3.7
    this.glowMat.uniforms.uTime.value = this.time
    for (const r of this.rings) {
      if (!r.on) continue
      if (r.delay > 0) {
        r.delay -= dt
        continue
      }
      r.t += dt
      const u = r.t / r.dur
      if (u >= 1) {
        r.on = false
        r.mesh.visible = false
        continue
      }
      r.mesh.visible = true
      r.mesh.position.copy(r.origin).addScaledVector(r.normal, r.speed * r.t)
      r.mesh.scale.setScalar(ringRadius(r.r0, r.r1, u))
      r.mat.uniforms.uAlpha.value = r.a0 * ringAlpha(u)
      r.mat.uniforms.uAge.value = r.t
    }
    for (const v of this.vapors) {
      if (!v.on) continue
      v.t += dt
      const u = v.t / v.dur
      if (u >= 1) {
        v.on = false
        v.mesh.visible = false
        continue
      }
      const r = ringRadius(v.r0, v.r1, u)
      v.mesh.scale.set(r, r, v.len * (0.7 + 0.5 * u))
      v.mat.uniforms.uAlpha.value = v.a0 * ringAlpha(u)
      v.mat.uniforms.uAge.value = v.t
    }
  }
}

/** Unit vector perpendicular to `dir` on the ground (dir's right-hand side). */
export function sideOf(dir: THREE.Vector3, out: THREE.Vector3) {
  out.set(-dir.z, 0, dir.x)
  if (out.lengthSq() < 1e-8) out.set(1, 0, 0)
  return out.normalize()
}
