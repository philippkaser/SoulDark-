import * as THREE from 'three'

/**
 * The sword arts' own visual vocabulary: the Iai's cut racing out through
 * everything around the hero as a ring of light, the Worldsplitter's blade a
 * kilometre long and the curtain of light it leaves in the air along the cut,
 * shock rings, and the light gathered at the hilt while a technique charges.
 * Everything is additive; big moments read through shape and motion, not more
 * white.
 */

const Z = new THREE.Vector3(0, 0, 1)
const Y = new THREE.Vector3(0, 1, 0)
const _v = new THREE.Vector3()
const _m = new THREE.Matrix4()

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

/**
 * The Iai's cut ring at `t` seconds after the draw: its radius (a fraction of
 * full reach) and brightness. It races out, hangs as a hairline until the
 * sheathe (`flashAt`, or never while negative), then blazes and is gone.
 */
export function discState(t: number, expand: number, flashAt: number, fade: number) {
  const r = 1 - Math.pow(1 - Math.min(1, Math.max(0, t) / expand), 3)
  let a: number
  if (t < 0) a = 0
  else if (t < expand) a = 1
  else if (flashAt < 0 || t < flashAt) a = 0.3 + 0.7 * Math.exp(-(t - expand) * 9)
  else {
    const u = (t - flashAt) / fade
    a = u >= 1 ? 0 : (1.6 - 0.4 * Math.min(1, u * 8)) * Math.pow(1 - u, 1.4)
  }
  return { r, a }
}

const HASH = /* glsl */ `
  float h1(float n) { return fract(sin(n) * 43758.5453); }
  float vn(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h1(i), h1(i + 1.0), f); }
  float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
`

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
      ${HASH}
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float a = atan(vUv.y, vUv.x) / 6.2831853 + 0.5;
        // a ragged shock front: sharp outside, a soft compressed band trailing inside
        float wob = (vn(a * 23.0 + uSeed) - 0.5) * uThick * 0.35 + (vn(a * 71.0 + uAge * 3.0 + uSeed) - 0.5) * uThick * 0.15;
        float rr = r + wob;
        float edge = 1.0 - smoothstep(0.985 - uThick * 0.08, 1.0, rr);
        float band = smoothstep(1.0 - uThick, 0.995, rr) * edge;
        float rim = exp(-pow((rr - 0.975) / (0.02 + uThick * 0.06), 2.0));
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

/** The Iai's cut: a band of light on an open cylinder, a hairline core in a soft halo. */
function discBandMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color('#ffc46a') }, uAlpha: { value: 0 }, uSeed: { value: 0 }, uAge: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vNear;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vNear = smoothstep(1.5, 7.0, length(cameraPosition - wp.xyz));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uSeed;
      uniform float uAge;
      varying vec2 vUv;
      varying float vNear;
      ${HASH}
      void main() {
        float y = vUv.y - 0.5;
        float core = exp(-pow(y / 0.06, 2.0));
        float halo = exp(-pow(y / 0.26, 2.0));
        float flick = 0.7 + 0.3 * vn(vUv.x * 380.0 + uSeed + uAge * 40.0);
        vec3 col = uColor * halo * 0.9 + vec3(4.2, 3.8, 3.2) * core;
        gl_FragColor = vec4(col * uAlpha * flick * vNear, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

/** The plane of the Iai's cut seen from above: a faint sheen brightening toward the ring. */
function discSheetMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color('#ffb860') }, uAlpha: { value: 0 }, uSeed: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vFace;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec3 n = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        vFace = abs(dot(normalize(cameraPosition - wp.xyz), n));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uSeed;
      varying vec2 vUv;
      varying float vFace;
      ${HASH}
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float a = atan(vUv.y, vUv.x) / 6.2831853 + 0.5;
        float rays = 0.6 + 0.4 * vn(a * 90.0 + uSeed);
        float v = pow(r, 6.0) * 0.5 * rays;
        v *= smoothstep(0.02, 0.25, vFace);
        gl_FragColor = vec4(uColor * v * uAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

/** The curtain the Worldsplitter leaves along its cut: light standing up off the ground, tearing out to the horizon. */
function curtainMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uFront: { value: 0 }, uLen: { value: 1000 }, uHeight: { value: 600 }, uSeed: { value: 0 }, uAge: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vFace;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec3 n = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        vFace = abs(dot(normalize(cameraPosition - wp.xyz), n));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      uniform float uFront;
      uniform float uLen;
      uniform float uHeight;
      uniform float uSeed;
      uniform float uAge;
      varying vec2 vUv;
      varying float vFace;
      ${HASH}
      void main() {
        float m = vUv.x * uLen;
        float hgt = vUv.y * uHeight;
        // revealed up to the racing front, brightest just behind it
        float shown = smoothstep(uFront + 30.0, uFront - 30.0, m);
        float fresh = exp(-max(0.0, uFront - m) / 400.0);
        // a hot seam on the ground, a sheet climbing off it in streaks
        float seam = exp(-hgt / 14.0);
        float sheet = exp(-hgt / (uHeight * 0.22)) * (0.4 + 0.6 * n2(vec2(m * 0.02 + uSeed, hgt * 0.004 - uAge * 0.6)));
        float strands = pow(vn(m * 0.08 + uSeed), 6.0) * exp(-hgt / (uHeight * 0.5));
        vec3 col = vec3(4.0, 3.4, 2.6) * seam + vec3(1.2, 0.7, 0.32) * sheet * (0.35 + fresh) + vec3(2.0, 1.4, 0.8) * strands * fresh;
        // a sheet seen face-on is a lot of light: it dims, and edge-on it is a seam through the frame
        col *= mix(1.0, 0.3, vFace);
        // the near end must not swallow the camera behind the hero
        col *= smoothstep(4.0, 40.0, m) * smoothstep(1.0, 0.94, vUv.x);
        gl_FragColor = vec4(col * shown * uAlpha, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

/** The Worldsplitter's blade: light poured along the sword, out past the clouds. */
function bladeMat() {
  return new THREE.ShaderMaterial({
    uniforms: { uLen: { value: 10 }, uWidth: { value: 1 }, uPower: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uLen;
      uniform float uWidth;
      varying vec2 vUv;
      varying float vNear;
      void main() {
        vUv = uv;
        vec3 p = position;
        // narrow where it leaves the steel, full width a little way out
        p.xy *= uWidth * mix(0.08, 1.0, smoothstep(0.0, 0.05, uv.y));
        p.z *= uLen;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vNear = smoothstep(1.0, 6.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uLen;
      uniform float uPower;
      uniform float uTime;
      varying vec2 vUv;
      varying float vNear;
      ${HASH}
      void main() {
        float across = abs(vUv.x - 0.5) * 2.0;
        float along = vUv.y;
        float m = along * uLen;
        float flow = n2(vec2(vUv.x * 5.0, m * 0.012 - uTime * 5.0)) * 0.6 + n2(vec2(vUv.x * 13.0, m * 0.05 - uTime * 13.0)) * 0.4;
        float tip = smoothstep(1.0, 0.8, along);
        float root = smoothstep(0.0, 0.004, along);
        float core = smoothstep(0.28, 0.0, across) * tip;
        float halo = smoothstep(1.0, 0.0, across + flow * 0.45) * tip;
        // surges of power racing up toward the tip
        float pulse = pow(0.5 + 0.5 * sin(m * 0.025 - uTime * 22.0), 10.0) * smoothstep(0.7, 0.0, across) * tip;
        vec3 col = vec3(1.0, 0.6, 0.24) * halo * (1.5 + 0.8 * flow) + vec3(4.0, 3.6, 3.0) * core + vec3(2.6, 1.9, 1.1) * pulse;
        gl_FragColor = vec4(col * uPower * root * vNear, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

/** Two crossed quads along +z (0..1), unit wide, so the blade has body from every side. */
function crossedBlade() {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let k = 0; k < 2; k++) {
    const b = pos.length / 3
    for (const [u, z] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const a = u - 0.5
      pos.push(k === 0 ? a : 0, k === 0 ? 0 : a, z)
      uv.push(u, z)
    }
    idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
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

interface Disc {
  band: THREE.Mesh
  sheet: THREE.Mesh
  bandMat: THREE.ShaderMaterial
  sheetMat: THREE.ShaderMaterial
  on: boolean
  t: number
  radius: number
  expand: number
  flashAt: number
  fade: number
  /** Gives up waiting for the sheathe after this long. */
  maxHold: number
}

interface Curtain {
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial
  on: boolean
  t: number
  dur: number
  speed: number
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

export class SwordFx {
  readonly root = new THREE.Group()
  private rings: Ring[] = []
  private discs: Disc[] = []
  private curtains: Curtain[] = []
  /** The light gathered at the hilt while a technique charges. */
  readonly glow: THREE.Mesh
  private glowMat: THREE.ShaderMaterial
  /** The Worldsplitter's blade, placed by its owner every frame it shows. */
  readonly blade: THREE.Mesh
  readonly bladeU: { uLen: { value: number }; uWidth: { value: number }; uPower: { value: number }; uTime: { value: number } }
  private time = 0

  constructor() {
    const quad = new THREE.PlaneGeometry(2, 2)
    for (let i = 0; i < 32; i++) {
      const mat = ringMat()
      const mesh = new THREE.Mesh(quad, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 10
      this.root.add(mesh)
      this.rings.push({ mesh, mat, on: false, t: 0, dur: 1, r0: 0, r1: 1, a0: 1, speed: 0, delay: 0, origin: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1) })
    }
    // the band: an open cylinder around +y, one metre tall; the sheet: a disc facing +z
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 320, 1, true)
    const circle = new THREE.CircleGeometry(1, 96)
    for (let i = 0; i < 3; i++) {
      const bandMat = discBandMat()
      const sheetMat = discSheetMat()
      const band = new THREE.Mesh(cyl, bandMat)
      const sheet = new THREE.Mesh(circle, sheetMat)
      for (const m of [band, sheet]) {
        m.visible = false
        m.frustumCulled = false
        m.renderOrder = 10
        this.root.add(m)
      }
      this.discs.push({ band, sheet, bandMat, sheetMat, on: false, t: 0, radius: 1, expand: 0.2, flashAt: -1, fade: 0.5, maxHold: 1 })
    }
    // the curtain: x along the cut (0..1), y up (0..1)
    const sheet = new THREE.PlaneGeometry(1, 1).translate(0.5, 0.5, 0)
    for (let i = 0; i < 2; i++) {
      const mat = curtainMat()
      const mesh = new THREE.Mesh(sheet, mat)
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.renderOrder = 9
      this.root.add(mesh)
      this.curtains.push({ mesh, mat, on: false, t: 0, dur: 1, speed: 1 })
    }
    this.glowMat = glowMat()
    this.glow = new THREE.Mesh(quad, this.glowMat)
    this.glow.visible = false
    this.glow.frustumCulled = false
    this.glow.renderOrder = 12
    this.root.add(this.glow)
    const bm = bladeMat()
    this.bladeU = bm.uniforms as SwordFx['bladeU']
    this.blade = new THREE.Mesh(crossedBlade(), bm)
    this.blade.visible = false
    this.blade.frustumCulled = false
    this.blade.renderOrder = 11
    this.root.add(this.blade)
  }

  /**
   * A shock ring at `p`, facing `normal`, growing from r0 to r1 over `dur`
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

  /**
   * The Iai's cut: a ring of light around `c` in the plane facing `n`, racing
   * out to `radius` in `expand` seconds and hanging there as a hairline until
   * `flashDisc` (the sheathe) makes it blaze and vanish. Returns its handle.
   */
  disc(c: THREE.Vector3, n: THREE.Vector3, radius: number, expand = 0.16, fade = 0.55, maxHold = 1.5) {
    let i = this.discs.findIndex((d) => !d.on)
    if (i < 0) i = this.discs.reduce((b, d, k) => (d.t > this.discs[b].t ? k : b), 0)
    const d = this.discs[i]
    d.on = true
    d.t = 0
    d.radius = radius
    d.expand = expand
    d.fade = fade
    d.flashAt = -1
    d.maxHold = maxHold
    d.band.position.copy(c)
    d.band.quaternion.setFromUnitVectors(Y, _v.copy(n).normalize())
    d.sheet.position.copy(c)
    d.sheet.quaternion.setFromUnitVectors(Z, _v)
    const seed = Math.random() * 100
    d.bandMat.uniforms.uSeed.value = seed
    d.sheetMat.uniforms.uSeed.value = seed
    return i
  }

  /** The sheathe: disc `i` blazes once and is gone. */
  flashDisc(i: number) {
    const d = this.discs[i]
    if (d?.on && d.flashAt < 0) d.flashAt = Math.max(d.t, d.expand)
  }

  /**
   * The Worldsplitter's curtain: from `a` along the ground direction `dir`,
   * `len` metres long and `height` tall, tearing out at `speed` m/s and gone
   * after `dur` seconds.
   */
  curtain(a: THREE.Vector3, dir: THREE.Vector3, len: number, height: number, speed: number, dur: number) {
    const c = this.curtains.find((x) => !x.on) ?? this.curtains.reduce((p, x) => (x.t > p.t ? x : p))
    c.on = true
    c.t = 0
    c.dur = dur
    c.speed = speed
    const fx = _v.set(dir.x, 0, dir.z).normalize()
    const side = new THREE.Vector3().crossVectors(fx, Y)
    _m.makeBasis(fx, Y, side)
    c.mesh.quaternion.setFromRotationMatrix(_m)
    c.mesh.position.copy(a)
    c.mesh.scale.set(len, height, 1)
    const u = c.mat.uniforms
    u.uLen.value = len
    u.uHeight.value = height
    u.uFront.value = 0
    u.uSeed.value = Math.random() * 100
    u.uAlpha.value = 0
    c.mesh.visible = true
  }

  /** Place the colossal blade along `quat`'s +z from `p` this frame (power 0 hides it). */
  placeBlade(p: THREE.Vector3, quat: THREE.Quaternion, len: number, width: number, power: number) {
    this.blade.visible = power > 0.002
    if (!this.blade.visible) return
    this.blade.position.copy(p)
    this.blade.quaternion.copy(quat)
    this.bladeU.uLen.value = len
    this.bladeU.uWidth.value = width
    this.bladeU.uPower.value = power
  }

  /** The hilt's gathered light this frame (size in metres; 0 hides it). */
  placeGlow(p: THREE.Vector3, size: number, alpha: number) {
    this.glow.visible = alpha > 0.001
    if (!this.glow.visible) return
    this.glow.position.copy(p)
    this.glow.scale.setScalar(size)
    this.glowMat.uniforms.uAlpha.value = alpha
  }

  hideHeld() {
    this.glow.visible = false
    this.blade.visible = false
  }

  clear() {
    for (const r of this.rings) (r.on = false), (r.mesh.visible = false)
    for (const d of this.discs) (d.on = false), (d.band.visible = d.sheet.visible = false)
    for (const c of this.curtains) (c.on = false), (c.mesh.visible = false)
    this.hideHeld()
  }

  /** World dt: a stopped world holds every effect in place. */
  update(dt: number) {
    this.time += dt
    this.glowMat.uniforms.uTime.value = this.time
    this.bladeU.uTime.value = this.time
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
    for (const d of this.discs) {
      if (!d.on) continue
      d.t += dt
      if (d.flashAt < 0 && d.t > d.maxHold) d.flashAt = d.t
      const s = discState(d.t, d.expand, d.flashAt, d.fade)
      if (d.flashAt >= 0 && d.t >= d.flashAt + d.fade) {
        d.on = false
        d.band.visible = d.sheet.visible = false
        continue
      }
      const r = Math.max(0.5, s.r * d.radius)
      // the band thickens with distance so the far cut still reads as a line
      d.band.scale.set(r, 0.3 + r * 0.0045, r)
      d.sheet.scale.setScalar(r)
      d.band.visible = d.sheet.visible = s.a > 0.002
      d.bandMat.uniforms.uAlpha.value = s.a
      d.bandMat.uniforms.uAge.value = d.t
      d.sheetMat.uniforms.uAlpha.value = s.a * (d.t < d.expand ? 1 : 0.5)
    }
    for (const c of this.curtains) {
      if (!c.on) continue
      c.t += dt
      const u = c.t / c.dur
      if (u >= 1) {
        c.on = false
        c.mesh.visible = false
        continue
      }
      const cu = c.mat.uniforms
      cu.uFront.value = c.speed * c.t
      cu.uAge.value = c.t
      cu.uAlpha.value = Math.min(1, c.t * 30) * Math.pow(1 - u, 1.5)
    }
  }
}

/** Unit vector perpendicular to `dir` on the ground (dir's right-hand side). */
export function sideOf(dir: THREE.Vector3, out: THREE.Vector3) {
  out.set(-dir.z, 0, dir.x)
  if (out.lengthSq() < 1e-8) out.set(1, 0, 0)
  return out.normalize()
}

/** World position and orientation of the blade leaving `hand` (sword along the hand's +z). */
export function bladeFrame(hand: THREE.Object3D, pos: THREE.Vector3, quat: THREE.Quaternion, offset = 0.1) {
  hand.getWorldPosition(pos)
  hand.getWorldQuaternion(quat)
  return pos.add(_v.copy(Z).applyQuaternion(quat).multiplyScalar(offset))
}

