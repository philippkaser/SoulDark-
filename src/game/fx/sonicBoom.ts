import * as THREE from 'three'
import { NOISE3 } from './shaders'

/**
 * The flash-step's Prandtl-Glauert cone: a thin white shell of condensation
 * that snaps around the hero as he breaks the sound barrier, rides with him
 * for the length of the step and tears away when he stops. From the side it
 * is the classic cone; from behind (the usual view) it reads as a ragged ring
 * of vapor around the body, never a disc over the hero.
 */

const Z = new THREE.Vector3(0, 0, 1)
const _v = new THREE.Vector3()

/** The cone's alpha at age `t` (s): snaps on, holds while attached, then fades over `fade` once released (`rel` = age at release, or -1). */
export function coneAlpha(t: number, rel: number, fade: number) {
  const on = Math.min(1, t / 0.03)
  if (rel < 0) return on
  const u = (t - rel) / fade
  if (u >= 1) return 0
  return on * (1 - u) * (1 - u)
}

function coneMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uAge: { value: 0 }, uSeed: { value: 0 }, uColor: { value: new THREE.Color(1, 0.97, 0.93) } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vView;
      varying vec2 vUv;
      varying float vAxis;
      varying float vNear;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - wp.xyz);
        vec3 axis = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        vec3 c = modelMatrix[3].xyz;
        vAxis = abs(dot(normalize(cameraPosition - c), axis));
        // the camera can sweep through a cone left behind: it thins away up close instead of filling the lens
        float r = length(modelMatrix[0].xyz);
        vNear = smoothstep(r * 0.6 + 0.4, r * 1.6 + 1.8, length(cameraPosition - wp.xyz));
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
      varying float vAxis;
      varying float vNear;
      ${NOISE3}
      void main() {
        // fresnel: only the thin shell's silhouette shows
        float f = 1.0 - abs(dot(normalize(vN), vView));
        // condensation combed into streaks that stream back off the apex (uv.y = 1)
        float streak = fbm3(vec3(vUv.x * 46.0, vUv.y * 3.0 - uAge * 14.0, uSeed));
        float wisp = smoothstep(0.38, 0.78, streak);
        float side = pow(f, 2.6) * smoothstep(0.05, 0.6, vUv.y) * smoothstep(1.0, 0.86, vUv.y);
        // seen from behind: a ragged ring at the open lip, the shell over the hero left clear
        float lip = smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.1, 0.42, vUv.y));
        float back = lip * (0.4 + 0.6 * f);
        float v = mix(side, back, smoothstep(0.55, 0.92, vAxis)) * (0.3 + 0.7 * wisp);
        gl_FragColor = vec4(uColor * v * uAlpha * vNear, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

interface Cone {
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial
  on: boolean
  t: number
  /** Age at release (-1 while riding with the hero). */
  rel: number
  fade: number
  len: number
  r: number
  a0: number
  /** How far ahead of the anchor the apex sits. */
  lead: number
  readonly dir: THREE.Vector3
}

export class SonicBoom {
  readonly root = new THREE.Group()
  private cones: Cone[] = []

  constructor() {
    // apex at the origin, open end back along -z (so +z leads)
    const geo = new THREE.ConeGeometry(1, 1, 48, 8, true).translate(0, -0.5, 0).rotateX(Math.PI / 2)
    for (let i = 0; i < 3; i++) {
      const mat = coneMat()
      const mesh = new THREE.Mesh(geo, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 10
      this.root.add(mesh)
      this.cones.push({ mesh, mat, on: false, t: 0, rel: -1, fade: 0.2, len: 1, r: 1, a0: 1, lead: 0.9, dir: new THREE.Vector3(0, 0, 1) })
    }
  }

  /** A cone snaps on around `at` (the hero's chest) heading along `dir`; it rides along until `release`. */
  start(at: THREE.Vector3, dir: THREE.Vector3, big = false) {
    let c = this.cones[0]
    for (const x of this.cones) {
      if (!x.on) {
        c = x
        break
      }
      if (x.t > c.t) c = x
    }
    // a cone still riding with the hero lets go first
    for (const x of this.cones) if (x.on && x.rel < 0 && x !== c) x.rel = x.t
    c.on = true
    c.t = 0
    c.rel = -1
    c.fade = big ? 0.32 : 0.2
    c.len = big ? 4.2 : 3
    c.r = big ? 2.3 : 1.6
    c.a0 = big ? 0.85 : 0.6
    c.lead = 0.9
    c.dir.copy(dir).normalize()
    c.mat.uniforms.uSeed.value = Math.random() * 50
    this.place(c, at)
    c.mesh.visible = true
  }

  /** The step is over: the riding cone tears away and fades where it is. */
  release() {
    for (const c of this.cones) if (c.on && c.rel < 0) c.rel = c.t
  }

  private place(c: Cone, at: THREE.Vector3) {
    c.mesh.position.copy(at).addScaledVector(c.dir, c.lead)
    c.mesh.quaternion.setFromUnitVectors(Z, c.dir)
  }

  clear() {
    for (const c of this.cones) (c.on = false), (c.mesh.visible = false)
  }

  /** Hero dt; `at` is the hero's chest, which a riding cone follows. */
  update(dt: number, at: THREE.Vector3) {
    for (const c of this.cones) {
      if (!c.on) continue
      c.t += dt
      // a riding cone is released anyway if nobody does (a cancelled step)
      if (c.rel < 0 && c.t > 0.4) c.rel = c.t
      const a = coneAlpha(c.t, c.rel, c.fade)
      if (c.rel >= 0 && a <= 0) {
        c.on = false
        c.mesh.visible = false
        continue
      }
      if (c.rel < 0) this.place(c, at)
      // it flares open as it forms, and keeps billowing once torn off
      const grow = Math.min(1, c.t / 0.06)
      const after = c.rel >= 0 ? (c.t - c.rel) / c.fade : 0
      const r = c.r * (0.45 + 0.55 * grow) * (1 + after * 0.5)
      c.mesh.scale.set(r, r, c.len * (0.8 + 0.2 * grow) * (1 + after * 0.25))
      c.mat.uniforms.uAlpha.value = a * c.a0
      c.mat.uniforms.uAge.value = c.t
    }
  }

  /** Is any cone showing (tests, debugging)? */
  get active() {
    return this.cones.some((c) => c.on)
  }

  /** Where the riding cone's apex is (tests). */
  apex(out: THREE.Vector3) {
    const c = this.cones.find((x) => x.on && x.rel < 0)
    return c ? out.copy(c.mesh.position) : out.copy(_v.set(0, 0, 0))
  }
}
