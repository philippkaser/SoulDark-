import * as THREE from 'three'

/**
 * Struct-of-arrays particle simulation with two renderers:
 *  - 'points': additive sprites in one draw call (sparks, embers, glints)
 *  - 'quads':  depth-sorted, softly lit billboards with no size limit
 *              (smoke, dust, explosion billows, mushroom clouds)
 */

export interface SpawnOpts {
  /** Size multiplier reached at the end of life (0 = constant). */
  grow?: number
  /** Initial emissive heat (quads): glows hot, then cools. */
  heat?: number
  /** Heat lost per second. */
  cool?: number
  /** Rotation and spin (quads). */
  rot?: number
  spin?: number
  /** Ground bounce for gravity-affected particles. */
  bounce?: boolean
  /** Fade in over this fraction of life (default quick). */
  fadeIn?: number
}

const pointVert = /* glsl */ `
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
const pointFrag = /* glsl */ `
varying vec4 vColor;
uniform float uSoft;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(uSoft, 1.0, d);
  a *= a;
  if (a <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}
`

export const quadVert = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec4 iParams; // size, rotation, heat, seed
varying vec4 vColor;
varying vec2 vUv;
varying float vHeat;
varying float vSeed;
varying float vGround;
void main() {
  float cr = cos(iParams.y), sr = sin(iParams.y);
  vec2 c = mat2(cr, -sr, sr, cr) * position.xy;
  // billboard in world space so we know where each fragment sits
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 world = (modelMatrix * vec4(iPos, 1.0)).xyz + (right * c.x + up * c.y) * iParams.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  // soft contact with the ground plane instead of a hard cut
  vGround = clamp(world.y / (iParams.x * 0.35 + 0.05), 0.0, 1.0);
  vColor = iColor;
  vUv = position.xy * 2.0;
  vHeat = iParams.z;
  vSeed = iParams.w;
}
`
export const quadFrag = /* glsl */ `
uniform vec3 uLightDir;
uniform vec3 uAmbient;
uniform vec3 uHot;
uniform float uLit;
varying vec4 vColor;
varying vec2 vUv;
varying float vHeat;
varying float vSeed;
varying float vGround;
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  vec2 q = vUv * 2.2 + vSeed * 17.0;
  float n = vn(q) * 0.6 + vn(q * 2.3 + 5.0) * 0.4;
  float shape = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.7);
  if (shape <= 0.002) discard;
  // fake sphere normal for soft volumetric lighting
  vec3 nrm = normalize(vec3(vUv * 0.9, sqrt(max(0.0, 1.0 - r * r)) + 0.3));
  float diff = clamp(dot(nrm, uLightDir) * 0.5 + 0.5, 0.0, 1.0);
  vec3 lit = vColor.rgb * mix(vec3(1.0), uAmbient + diff * (1.0 - uAmbient), uLit);
  lit *= 0.85 + n * 0.3;
  vec3 hot = uHot * vHeat * (0.6 + n * 0.8) * (1.2 - r * 0.6);
  float a = vColor.a * shape * vGround;
  gl_FragColor = vec4(lit + hot, a);
}
`

export class ParticlePool {
  readonly object: THREE.Object3D
  readonly capacity: number
  private mode: 'points' | 'quads'
  private pos: Float32Array
  private vel: Float32Array
  private base: Float32Array
  private alpha0: Float32Array
  private size0: Float32Array
  private life: Float32Array
  private maxLife: Float32Array
  private grav: Float32Array
  private drag: Float32Array
  private grow: Float32Array
  private heat: Float32Array
  private cool: Float32Array
  private rot: Float32Array
  private spin: Float32Array
  private seed: Float32Array
  private flags: Uint8Array
  private fadeIn: Float32Array
  private next = 0
  private alive = 0
  // render buffers
  private geo: THREE.BufferGeometry
  private outPos: Float32Array
  private outCol: Float32Array
  private outSize: Float32Array | null = null
  private outParams: Float32Array | null = null
  private order: Uint32Array
  private depth: Float32Array
  readonly uniforms: Record<string, THREE.IUniform>
  /** Sort quads back to front each frame (needed for normal-blended smoke). */
  sort = true

  constructor(opts: { capacity: number; mode: 'points' | 'quads'; additive?: boolean; soft?: number; renderOrder?: number }) {
    const n = opts.capacity
    this.capacity = n
    this.mode = opts.mode
    this.pos = new Float32Array(n * 3)
    this.vel = new Float32Array(n * 3)
    this.base = new Float32Array(n * 3)
    this.alpha0 = new Float32Array(n)
    this.size0 = new Float32Array(n)
    this.life = new Float32Array(n)
    this.maxLife = new Float32Array(n)
    this.grav = new Float32Array(n)
    this.drag = new Float32Array(n)
    this.grow = new Float32Array(n)
    this.heat = new Float32Array(n)
    this.cool = new Float32Array(n)
    this.rot = new Float32Array(n)
    this.spin = new Float32Array(n)
    this.seed = new Float32Array(n)
    this.flags = new Uint8Array(n)
    this.fadeIn = new Float32Array(n)
    this.order = new Uint32Array(n)
    this.depth = new Float32Array(n)
    this.outPos = new Float32Array(n * 3)
    this.outCol = new Float32Array(n * 4)
    if (opts.mode === 'points') {
      this.outSize = new Float32Array(n)
      this.geo = new THREE.BufferGeometry()
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.outPos, 3).setUsage(THREE.DynamicDrawUsage))
      this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.outCol, 4).setUsage(THREE.DynamicDrawUsage))
      this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.outSize, 1).setUsage(THREE.DynamicDrawUsage))
      this.geo.setDrawRange(0, 0)
      this.uniforms = { uScale: { value: 800 }, uSoft: { value: opts.soft ?? 0 } }
      const mat = new THREE.ShaderMaterial({
        vertexShader: pointVert,
        fragmentShader: pointFrag,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: opts.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
      })
      const pts = new THREE.Points(this.geo, mat)
      pts.frustumCulled = false
      pts.renderOrder = opts.renderOrder ?? 8
      this.object = pts
    } else {
      this.outParams = new Float32Array(n * 4)
      const g = new THREE.InstancedBufferGeometry()
      const quad = new THREE.PlaneGeometry(1, 1)
      g.index = quad.index
      g.setAttribute('position', quad.attributes.position)
      g.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.outPos, 3).setUsage(THREE.DynamicDrawUsage))
      g.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.outCol, 4).setUsage(THREE.DynamicDrawUsage))
      g.setAttribute('iParams', new THREE.InstancedBufferAttribute(this.outParams, 4).setUsage(THREE.DynamicDrawUsage))
      g.instanceCount = 0
      this.geo = g
      this.uniforms = {
        uLightDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },
        uAmbient: { value: new THREE.Color(0.42, 0.4, 0.44) },
        uHot: { value: new THREE.Color(1.0, 0.45, 0.12) },
        uLit: { value: 1 },
      }
      const mat = new THREE.ShaderMaterial({
        vertexShader: quadVert,
        fragmentShader: quadFrag,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      })
      const mesh = new THREE.Mesh(g, mat)
      mesh.frustumCulled = false
      mesh.renderOrder = opts.renderOrder ?? 7
      this.object = mesh
    }
  }

  get count() {
    return this.alive
  }

  spawn(
    p: THREE.Vector3,
    v: THREE.Vector3,
    color: readonly [number, number, number],
    alpha: number,
    size: number,
    life: number,
    grav: number,
    drag: number,
    o: SpawnOpts = {},
  ) {
    const i = this.next
    this.next = (this.next + 1) % this.capacity
    const k = i * 3
    this.pos[k] = p.x
    this.pos[k + 1] = p.y
    this.pos[k + 2] = p.z
    this.vel[k] = v.x
    this.vel[k + 1] = v.y
    this.vel[k + 2] = v.z
    this.base[k] = color[0]
    this.base[k + 1] = color[1]
    this.base[k + 2] = color[2]
    this.alpha0[i] = alpha
    this.size0[i] = size
    this.life[i] = life
    this.maxLife[i] = life
    this.grav[i] = grav
    this.drag[i] = drag
    this.grow[i] = o.grow ?? 0
    this.heat[i] = o.heat ?? 0
    this.cool[i] = o.cool ?? 1
    this.rot[i] = o.rot ?? Math.random() * 6.283
    this.spin[i] = o.spin ?? (Math.random() - 0.5) * 0.6
    this.seed[i] = Math.random()
    this.flags[i] = o.bounce ? 1 : 0
    this.fadeIn[i] = o.fadeIn ?? 0.08
    return i
  }

  setViewport(heightPx: number, fovDeg: number) {
    if (this.mode === 'points') this.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360))
  }

  clear() {
    this.life.fill(0)
  }

  update(dt: number, camera?: THREE.Camera) {
    const n = this.capacity
    let w = 0
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) continue
      this.life[i] -= dt
      if (this.life[i] <= 0) continue
      const k = i * 3
      const dr = Math.exp(-this.drag[i] * dt)
      this.vel[k] *= dr
      this.vel[k + 1] = this.vel[k + 1] * dr - this.grav[i] * dt
      this.vel[k + 2] *= dr
      this.pos[k] += this.vel[k] * dt
      this.pos[k + 1] += this.vel[k + 1] * dt
      this.pos[k + 2] += this.vel[k + 2] * dt
      if (this.flags[i] & 1 && this.pos[k + 1] < 0.03) {
        this.pos[k + 1] = 0.03
        this.vel[k] *= 0.4
        this.vel[k + 1] *= -0.25
        this.vel[k + 2] *= 0.4
      }
      this.heat[i] = Math.max(0, this.heat[i] - this.cool[i] * dt)
      this.rot[i] += this.spin[i] * dt
      this.order[w++] = i
    }
    this.alive = w

    if (this.mode === 'quads' && this.sort && camera && w > 1) {
      const e = camera.matrixWorldInverse.elements
      for (let j = 0; j < w; j++) {
        const k = this.order[j] * 3
        // view-space z (more negative = farther)
        this.depth[this.order[j]] = e[2] * this.pos[k] + e[6] * this.pos[k + 1] + e[10] * this.pos[k + 2] + e[14]
      }
      const ord = this.order.subarray(0, w)
      const dep = this.depth
      ord.sort((a, b) => dep[a] - dep[b])
    }

    for (let j = 0; j < w; j++) {
      const i = this.order[j]
      const k = i * 3
      const t = this.life[i] / this.maxLife[i]
      const age = 1 - t
      const fi = this.fadeIn[i]
      const fade = Math.min(1, t * 3) * (fi > 0 ? Math.min(1, age / fi) : 1)
      this.outPos[j * 3] = this.pos[k]
      this.outPos[j * 3 + 1] = this.pos[k + 1]
      this.outPos[j * 3 + 2] = this.pos[k + 2]
      this.outCol[j * 4] = this.base[k]
      this.outCol[j * 4 + 1] = this.base[k + 1]
      this.outCol[j * 4 + 2] = this.base[k + 2]
      this.outCol[j * 4 + 3] = this.alpha0[i] * fade
      const size = this.size0[i] * (1 + this.grow[i] * age)
      if (this.outSize) this.outSize[j] = size
      else if (this.outParams) {
        this.outParams[j * 4] = size
        this.outParams[j * 4 + 1] = this.rot[i]
        this.outParams[j * 4 + 2] = this.heat[i]
        this.outParams[j * 4 + 3] = this.seed[i]
      }
    }
    if (this.mode === 'points') {
      this.geo.setDrawRange(0, w)
      this.geo.attributes.position.needsUpdate = true
      this.geo.attributes.aColor.needsUpdate = true
      this.geo.attributes.aSize.needsUpdate = true
    } else {
      ;(this.geo as THREE.InstancedBufferGeometry).instanceCount = w
      this.geo.attributes.iPos.needsUpdate = true
      this.geo.attributes.iColor.needsUpdate = true
      this.geo.attributes.iParams.needsUpdate = true
    }
  }
}
