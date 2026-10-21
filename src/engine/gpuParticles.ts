import * as THREE from 'three'

/**
 * Stateless GPU particles. Each particle is written once, at emit time, into a
 * ring buffer of instance attributes; the vertex shader evaluates its whole
 * life in closed form from t = now - birth (ballistic motion with linear drag,
 * an optional ground bounce, a flow-noise drift that grows with age, colour and
 * size over life). The CPU never touches a particle again, so tens of
 * thousands cost one small buffer upload of the newly written range per frame.
 *
 * `now` is fed from the world clock, so particles slow in divine time and
 * freeze completely while time is stopped.
 */

/** Floats per particle in the interleaved instance buffer. */
export const STRIDE = 28
/** Longest streak, in widths. */
const MAX_ASPECT = 70
/** Widest streak on screen, in pixels. */
const MAX_STREAK_PX = 12

export type RGBA = readonly [number, number, number, number]
export type Vec3T = [number, number, number]

/** How a particle looks and moves. Packed on first use, so treat it as immutable. */
export interface ParticleStyle {
  /** Colour and alpha at birth and death. RGB may exceed 1 (it blooms). */
  c0: RGBA
  c1: RGBA
  /** World-space diameter at birth and at death. */
  s0: number
  s1: number
  /** Downward acceleration in m/s². Negative rises (buoyant embers). */
  gravity?: number
  /** Linear drag rate in 1/s: velocity decays as e^(-drag t). */
  drag?: number
  /** Flow-noise drift speed in m/s; the swirl grows with age. */
  curl?: number
  /** Spatial frequency of the flow field in 1/m (default 0.35). */
  curlFreq?: number
  /** Seconds of motion smeared into a streak along the velocity (0 = round sprite). */
  stretch?: number
  /** Ground at y = 0: undefined passes through, 0 slides along it, 0..1 bounces with that restitution. */
  bounce?: number
  /** 0..1 brightness flicker (embers, glitter). */
  flicker?: number
  /** 0 = soft glow, 1 = hard white-hot core. */
  core?: number
  /** Fraction of life spent fading in (default 0.02). */
  fadeIn?: number
}

// ---------------------------------------------------------------------------
// Pure helpers (mirrored by the GLSL below; tested against numeric integration)
// ---------------------------------------------------------------------------

/**
 * Instance ranges to upload after writing `count` particles from `start` into
 * a ring of `cap`: flat [start, count, start, count...], one range or two when
 * the writes wrapped.
 */
export function ringRanges(start: number, count: number, cap: number, out: number[] = []): number[] {
  out.length = 0
  if (count <= 0 || cap <= 0) return out
  if (count >= cap) {
    out.push(0, cap)
    return out
  }
  const end = start + count
  if (end <= cap) out.push(start, count)
  else out.push(start, cap - start, 0, end - cap)
  return out
}

/** ∫0..t e^(-k s) ds = (1 - e^(-kt)) / k, stable as k → 0. */
export function dragF(k: number, t: number) {
  const x = k * t
  if (x < 1e-3) return t * (1 - x * 0.5 + (x * x) / 6)
  return (1 - Math.exp(-x)) / k
}

/** ∫0..t F(k, s) ds = (t - F) / k, stable as k → 0 (the gravity term). */
export function dragG(k: number, t: number) {
  const x = k * t
  if (x < 0.05) return t * t * (0.5 - x / 6 + (x * x) / 24 - (x * x * x) / 120)
  return (t - (1 - Math.exp(-x)) / k) / k
}

/**
 * Closed-form motion under gravity `g` (downward) and linear drag `k`:
 * v' = -k v - g ŷ. Writes position and velocity at time t.
 */
export function ballistic(o: readonly number[], v: readonly number[], g: number, k: number, t: number, p: Vec3T, vel: Vec3T) {
  const F = dragF(k, t)
  const G = dragG(k, t)
  const e = Math.exp(-k * t)
  p[0] = o[0] + v[0] * F
  p[1] = o[1] + v[1] * F - g * G
  p[2] = o[2] + v[2] * F
  vel[0] = v[0] * e
  vel[1] = v[1] * e - g * F
  vel[2] = v[2] * e
}

/** Height at time t of the ballistic arc (the bisection target). */
function arcY(oy: number, vy: number, g: number, k: number, t: number) {
  return oy + vy * dragF(k, t) - g * dragG(k, t)
}

/** Horizontal speed kept on a ground bounce, by restitution. */
export const bounceFriction = (bounce: number) => 0.45 + 0.4 * bounce

const _bo: Vec3T = [0, 0, 0]
const _bv: Vec3T = [0, 0, 0]

/**
 * Motion with an optional ground bounce at y = 0: the first impact time is
 * found by bisection, the arc restarts with the reflected, damped velocity,
 * and a second impact clamps the particle to the ground where it slides.
 */
export function motion(o: readonly number[], v: readonly number[], g: number, k: number, t: number, bounce: number | undefined, p: Vec3T, vel: Vec3T) {
  ballistic(o, v, g, k, t, p, vel)
  if (bounce === undefined || bounce < 0 || p[1] >= 0) return
  if (o[1] <= 0) {
    p[1] = 0
    vel[1] = 0
    return
  }
  let lo = 0
  let hi = t
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) * 0.5
    if (arcY(o[1], v[1], g, k, mid) > 0) lo = mid
    else hi = mid
  }
  const t1 = (lo + hi) * 0.5
  ballistic(o, v, g, k, t1, _bo, _bv)
  const fr = bounceFriction(bounce)
  _bo[1] = 0
  _bv[0] *= fr
  _bv[1] = -_bv[1] * bounce
  _bv[2] *= fr
  ballistic(_bo, _bv, g, k, t - t1, p, vel)
  if (p[1] < 0) {
    p[1] = 0
    vel[1] = 0
  }
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const vert = /* glsl */ `
attribute vec4 aOB; // origin, birth
attribute vec4 aVL; // velocity, life
attribute vec4 aC0;
attribute vec4 aC1;
attribute vec4 aSz; // size0, size1, gravity, drag
attribute vec4 aFx; // curl, curlFreq, stretch, bounce
attribute vec4 aMs; // seed, flicker, core, fadeIn
uniform float uTime;
uniform float uScale;
uniform float uMinPx;
varying vec4 vColor;
varying vec2 vUv;
varying float vLen;
varying float vCore;
varying float vDepth;

float dragF(float k, float t) {
  float x = k * t;
  return x < 1e-3 ? t * (1.0 - x * 0.5 + x * x / 6.0) : (1.0 - exp(-x)) / k;
}
float dragG(float k, float t) {
  float x = k * t;
  return x < 0.05 ? t * t * (0.5 - x / 6.0 + x * x / 24.0 - x * x * x / 120.0) : (t - (1.0 - exp(-x)) / k) / k;
}
void ballistic(vec3 o, vec3 v, float g, float k, float t, out vec3 p, out vec3 vel) {
  float F = dragF(k, t);
  float G = dragG(k, t);
  float e = exp(-k * t);
  p = o + v * F - vec3(0.0, g * G, 0.0);
  vel = v * e - vec3(0.0, g * F, 0.0);
}
// a cheap swirling flow; evaluated where the particle is, so neighbours swirl together
vec3 flow(vec3 p, float s) {
  float T = uTime * 0.7 + s * 6.0;
  return vec3(
    sin(p.y * 1.7 + T + sin(p.z * 1.3 - T * 0.8)),
    sin(p.z * 1.5 - T * 0.9 + sin(p.x * 1.1 + T * 0.6)),
    sin(p.x * 1.6 + T * 1.1 + sin(p.y * 1.4 + T * 0.5)));
}

void main() {
  float t = uTime - aOB.w;
  float life = aVL.w;
  if (t < 0.0 || t >= life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float age = t / life;
  float g = aSz.z;
  float k = aSz.w;
  vec3 pos;
  vec3 vel;
  ballistic(aOB.xyz, aVL.xyz, g, k, t, pos, vel);
  float bounce = aFx.w;
  if (bounce >= 0.0 && pos.y < 0.0) {
    if (aOB.y <= 0.0) {
      pos.y = 0.0;
      vel.y = 0.0;
    } else {
      float lo = 0.0;
      float hi = t;
      for (int i = 0; i < 10; i++) {
        float mid = (lo + hi) * 0.5;
        float y = aOB.y + aVL.y * dragF(k, mid) - g * dragG(k, mid);
        if (y > 0.0) lo = mid; else hi = mid;
      }
      float t1 = (lo + hi) * 0.5;
      vec3 p1;
      vec3 v1;
      ballistic(aOB.xyz, aVL.xyz, g, k, t1, p1, v1);
      float fr = 0.45 + 0.4 * bounce;
      ballistic(vec3(p1.x, 0.0, p1.z), vec3(v1.x * fr, -v1.y * bounce, v1.z * fr), g, k, t - t1, pos, vel);
      if (pos.y < 0.0) {
        pos.y = 0.0;
        vel.y = 0.0;
      }
    }
  }
  float curl = aFx.x;
  if (curl > 0.0) {
    vec3 f = flow(pos * aFx.y + aMs.x * 3.0, aMs.x);
    pos += f * curl * t;
    vel += f * curl;
    if (bounce >= 0.0) pos.y = max(pos.y, 0.0);
  }

  float size = mix(aSz.x, aSz.y, age);
  vec4 col = mix(aC0, aC1, age * (2.0 - age));
  col.a = mix(aC0.a, aC1.a, age * age);
  float fi = aMs.w;
  if (fi > 0.0) col.a *= smoothstep(0.0, fi, age);
  float fl = aMs.y;
  if (fl > 0.0) {
    float ph = aMs.x * 91.0;
    float fw = 0.5 + 0.25 * sin(uTime * (9.0 + aMs.x * 17.0) + ph) + 0.25 * sin(uTime * 23.0 + ph * 1.7);
    col.rgb *= 1.0 - fl * fw;
  }

  vec3 P = (modelViewMatrix * vec4(pos, 1.0)).xyz;
  float depth = -P.z;
  if (depth < 0.3 || size <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float w = size * 0.5;
  // soft near plane: nothing pops through the lens
  col.a *= smoothstep(1.0, 4.0, depth);
  // never thinner than a pixel or two: keep the energy, spread it out
  float px = size * uScale / depth;
  float boost = 1.0;
  if (px < uMinPx) {
    boost = px / uMinPx;
    w *= uMinPx / px;
  }
  // sparks stay needles even right past the lens
  if (aFx.z > 0.0) w = min(w, ${MAX_STREAK_PX.toFixed(1)} * 0.5 * depth / uScale);

  vec3 view = normalize(P);
  vec3 A = (mat3(modelViewMatrix) * vel) * aFx.z;
  A -= dot(A, view) * view;
  // a streak is at most MAX_ASPECT widths long
  float L = min(length(A), w * ${MAX_ASPECT.toFixed(1)});
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 right = vec3(1.0, 0.0, 0.0);
  float lenW = 0.0;
  if (L > w * 0.3) {
    up = normalize(A);
    // keeps the quad's winding facing the camera
    right = normalize(cross(view, up));
    lenW = L / w;
    col.a *= boost;
  } else {
    L = 0.0;
    col.a *= boost * boost;
  }
  float s = mix(-1.0, lenW + 1.0, position.y + 0.5);
  vec3 vp = P - up * L + up * (s * w) + right * (position.x * 2.0 * w);
  gl_Position = projectionMatrix * vec4(vp, 1.0);
  vUv = vec2(position.x * 2.0, s);
  vLen = lenW;
  vColor = col;
  vCore = aMs.z;
  vDepth = depth;
}
`

const frag = /* glsl */ `
uniform vec3 fogColor;
uniform float fogDensity;
uniform float uAdditive;
varying vec4 vColor;
varying vec2 vUv;
varying float vLen;
varying float vCore;
varying float vDepth;
void main() {
  float y = vUv.y - clamp(vUv.y, 0.0, vLen);
  float d2 = vUv.x * vUv.x + y * y;
  if (d2 >= 1.0) discard;
  float soft = exp(-d2 * 4.0) * (1.0 - d2);
  float hard = exp(-d2 * 18.0) * 1.6 + exp(-d2 * 3.0) * (1.0 - d2) * 0.35;
  float shape = mix(soft, hard, vCore);
  vec3 rgb = vColor.rgb;
  // a streak is brightest at its head; hot ones cool to red along the tail
  if (vLen > 0.0) {
    float along = clamp(vUv.y / vLen, 0.0, 1.0);
    shape *= 0.12 + 0.88 * along * along;
    rgb *= mix(vec3(1.0, 0.55, 0.3), vec3(1.0), mix(1.0, along, vCore));
  }
  vec4 c = vec4(rgb, vColor.a * shape);
  #ifdef USE_FOG
    float f = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
    // light punches through haze better than dust does
    c.rgb = uAdditive > 0.5 ? c.rgb * (1.0 - f * 0.6) : mix(c.rgb, fogColor, f);
  #endif
  if (c.a <= 0.002) discard;
  gl_FragColor = c;
}
`

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

/** Floats of a particle's record that come from its style (offsets 8..27). */
const PACKED = STRIDE - 8
const packCache = new WeakMap<ParticleStyle, Float32Array>()

/** A style's constant part of the instance record, packed once (styles are treated as immutable). */
function packStyle(st: ParticleStyle): Float32Array {
  let a = packCache.get(st)
  if (a) return a
  a = new Float32Array([
    ...st.c0,
    ...st.c1,
    st.s0,
    st.s1,
    st.gravity ?? 0,
    st.drag ?? 0,
    st.curl ?? 0,
    st.curlFreq ?? 0.35,
    st.stretch ?? 0,
    st.bounce ?? -1,
    0, // seed, per particle
    st.flicker ?? 0,
    st.core ?? 0,
    st.fadeIn ?? 0.02,
  ])
  packCache.set(st, a)
  return a
}

export interface GpuParticlesOpts {
  capacity: number
  /** 'add' for light (sparks, embers), 'normal' for dust and ash. */
  blending?: 'add' | 'normal'
  renderOrder?: number
}

export class GpuParticles {
  readonly mesh: THREE.Mesh
  readonly capacity: number
  readonly uniforms: { uTime: THREE.IUniform<number>; uScale: THREE.IUniform<number>; uMinPx: THREE.IUniform<number>; uAdditive: THREE.IUniform<number> }
  /** World seconds since the pool was created or cleared. */
  time = 0
  private data: Float32Array
  private buf: THREE.InstancedInterleavedBuffer
  private geo: THREE.InstancedBufferGeometry
  private head = 0
  private written = 0
  private dirtyStart = 0
  private dirtyCount = 0
  private lastDeath = 0
  private ranges: number[] = []
  private style: ParticleStyle | null = null
  private packed: Float32Array = new Float32Array(PACKED)

  constructor(o: GpuParticlesOpts) {
    const n = (this.capacity = Math.max(16, Math.floor(o.capacity)))
    this.data = new Float32Array(n * STRIDE)
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1)
    this.buf.setUsage(THREE.DynamicDrawUsage)
    const g = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(1, 1)
    g.index = quad.index
    g.setAttribute('position', quad.attributes.position)
    const names = ['aOB', 'aVL', 'aC0', 'aC1', 'aSz', 'aFx', 'aMs']
    names.forEach((name, i) => g.setAttribute(name, new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4)))
    g.instanceCount = 0
    this.geo = g
    const additive = o.blending !== 'normal'
    this.uniforms = { uTime: { value: 0 }, uScale: { value: 600 }, uMinPx: { value: 1.3 }, uAdditive: { value: additive ? 1 : 0 } }
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...this.uniforms },
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    this.mesh = new THREE.Mesh(g, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = o.renderOrder ?? 9
    this.mesh.visible = false
  }

  /** Particles alive or waiting to be born (upper bound, by death time). */
  get active() {
    return this.time < this.lastDeath
  }

  /**
   * Write one particle. `delay` postpones its birth in world seconds (negative
   * pre-ages it, so it appears mid-flight); `sizeMul` and `bright` vary the
   * style per particle (bright scales RGB).
   */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, st: ParticleStyle, sizeMul = 1, bright = 1, delay = 0) {
    const i = this.head
    this.head = i + 1 === this.capacity ? 0 : i + 1
    if (this.dirtyCount === 0) this.dirtyStart = i
    if (this.dirtyCount < this.capacity) this.dirtyCount++
    if (this.written < this.capacity) this.written++
    const birth = this.time + delay
    if (birth + life > this.lastDeath) this.lastDeath = birth + life
    if (st !== this.style) {
      this.style = st
      this.packed = packStyle(st)
    }
    const s = this.packed
    const d = this.data
    const k = i * STRIDE
    d[k] = x
    d[k + 1] = y
    d[k + 2] = z
    d[k + 3] = birth
    d[k + 4] = vx
    d[k + 5] = vy
    d[k + 6] = vz
    d[k + 7] = life
    for (let j = 0; j < PACKED; j++) d[k + 8 + j] = s[j]
    if (bright !== 1) {
      d[k + 8] *= bright
      d[k + 9] *= bright
      d[k + 10] *= bright
      d[k + 12] *= bright
      d[k + 13] *= bright
      d[k + 14] *= bright
    }
    d[k + 16] *= sizeMul
    d[k + 17] *= sizeMul
    d[k + 24] = Math.random()
  }

  setViewport(heightPx: number, fovDeg: number) {
    this.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360))
  }

  /** Kill everything and restart the clock. */
  clear() {
    for (let k = 7; k < this.data.length; k += STRIDE) this.data[k] = 0
    this.time = 0
    this.lastDeath = 0
    this.head = 0
    this.dirtyStart = 0
    this.dirtyCount = this.capacity
  }

  /** Advance the clock by world `dt` and upload what was written since last frame. */
  update(dt: number) {
    this.time += dt
    this.uniforms.uTime.value = this.time
    if (this.dirtyCount > 0) {
      const r = ringRanges(this.dirtyStart, this.dirtyCount, this.capacity, this.ranges)
      for (let i = 0; i < r.length; i += 2) this.buf.addUpdateRange(r[i] * STRIDE, r[i + 1] * STRIDE)
      this.buf.needsUpdate = true
      this.dirtyCount = 0
    }
    this.geo.instanceCount = this.written
    this.mesh.visible = this.written > 0 && this.time < this.lastDeath
  }
}
