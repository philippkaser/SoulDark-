import * as THREE from 'three'
import { mulberry32 } from '../../engine/math'
import type { ParticlePool } from '../../engine/particles'

/** The bits of Fx and the scorch map levitation uses (both satisfy it structurally). */
export interface LevitateFx {
  glow: ParticlePool
  dust(p: THREE.Vector3, n: number, spread: number, size: number, color?: readonly [number, number, number]): void
  debris: { burst(p: THREE.Vector3, count: number, speed: number, size: number, heat?: number, up?: number): void }
}
export interface LevitateScorch {
  crater(x: number, z: number, r: number, heat?: number): void
}

// rock states
const OFF = 0
const WAIT = 1
const RISE = 2
const FLY = 3

const GRAVITY = 28

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _dq = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _p = new THREE.Vector3()
const _v = new THREE.Vector3()
const _ax = new THREE.Vector3()
const _side = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _ember: [number, number, number] = [1, 0.55, 0.15]
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

/** A faceted boulder. */
function rockGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1)
  const pos = g.attributes.position as THREE.BufferAttribute
  const r = mulberry32(7)
  const v = new THREE.Vector3()
  // icosahedron vertices are shared by position; jitter by position so the hull stays closed
  const seen = new Map<string, number>()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`
    let k = seen.get(key)
    if (k === undefined) {
      k = 0.62 + r() * 0.55
      seen.set(key, k)
    }
    v.multiplyScalar(k)
    v.y *= 0.72
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  g.computeVertexNormals()
  return g
}

/**
 * Rocks torn out of the ground by the hero's power: they peel off one by one
 * as power builds (dust at lift-off), rise, bob and orbit slowly, shudder at
 * full power, then blast outward on release and tumble down. One instanced
 * draw call. A glowing star of cracks spreads under the rocks' origin.
 * Runs on the world clock.
 */
export class Levitation {
  readonly root = new THREE.Group()
  readonly mesh: THREE.InstancedMesh
  readonly max: number
  readonly center = new THREE.Vector3()
  private fx: LevitateFx | null
  private scorch: LevitateScorch | null
  private q: number
  // per rock
  private state: Uint8Array
  private pos: Float32Array
  private vel: Float32Array
  private rot: Float32Array
  private spin: Float32Array
  private size: Float32Array
  private need: Float32Array
  private hover: Float32Array
  private orbitR: Float32Array
  private orbitA: Float32Array
  private orbitW: Float32Array
  private phase: Float32Array
  private life: Float32Array
  private bounces: Uint8Array
  private heat: Float32Array
  private glowAttr: THREE.InstancedBufferAttribute
  private power = 0
  private heldT = 0
  private sessionOn = false
  private time = 0
  // the crack decal
  private crack: THREE.Mesh
  private crackU = { uGrow: { value: 0 }, uHeat: { value: 0 }, uTime: { value: 0 }, uSeed: { value: 0 } }
  private crackHeat = 0
  private crackGrow = 0

  constructor(fx: LevitateFx | null, scorch: LevitateScorch | null, quality = 1) {
    this.fx = fx
    this.scorch = scorch
    this.q = quality
    const n = Math.round(84 * quality)
    this.max = n
    this.state = new Uint8Array(n)
    this.pos = new Float32Array(n * 3)
    this.vel = new Float32Array(n * 3)
    this.rot = new Float32Array(n * 4)
    this.spin = new Float32Array(n * 4)
    this.size = new Float32Array(n)
    this.need = new Float32Array(n)
    this.hover = new Float32Array(n)
    this.orbitR = new Float32Array(n)
    this.orbitA = new Float32Array(n)
    this.orbitW = new Float32Array(n)
    this.phase = new Float32Array(n)
    this.life = new Float32Array(n)
    this.bounces = new Uint8Array(n)
    this.heat = new Float32Array(n)

    const geo = rockGeometry()
    this.glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aGlow', this.glowAttr)
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0.05, flatShading: true })
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aGlow;\nvarying vec2 vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vGlow;').replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        {
          // x: molten heat on the torn underside; y: golden rim of the hero's power
          vec3 wn = (vec4(normal, 0.0) * viewMatrix).xyz;
          float under = smoothstep(0.25, -0.75, wn.y);
          totalEmissiveRadiance += vec3(1.6, 0.5, 0.1) * vGlow.x * (0.25 + under * 1.4);
          float fres = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 2.0);
          totalEmissiveRadiance += vec3(1.4, 0.9, 0.35) * vGlow.y * fres;
        }`,
      )
    }
    mat.customProgramCacheKey = () => 'levitate-v1'
    this.mesh = new THREE.InstancedMesh(geo, mat, n)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
    const c = new THREE.Color()
    const r = mulberry32(31)
    for (let i = 0; i < n; i++) {
      const g = 0.16 + r() * 0.14
      this.mesh.setColorAt(i, c.setRGB(g * 1.05, g * 0.85, g * 0.74))
      this.mesh.setMatrixAt(i, ZERO)
    }
    this.mesh.visible = false

    this.crack = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), crackMaterial(this.crackU))
    this.crack.frustumCulled = false
    this.crack.renderOrder = 3
    this.crack.visible = false
    this.root.add(this.mesh, this.crack)
  }

  /** Is anything still lifting, hovering or flying? */
  get active() {
    return this.sessionOn || this.state.some((s) => s !== OFF)
  }

  /** Rocks currently held aloft (tests, debug). */
  get aloft() {
    let n = 0
    for (let i = 0; i < this.max; i++) if (this.state[i] === RISE) n++
    return n
  }

  /** Start tearing rocks out of the ground around `center`. */
  begin(center: THREE.Vector3) {
    if (this.sessionOn) this.drop()
    this.sessionOn = true
    this.power = 0
    this.heldT = 0
    this.center.copy(center).setY(0)
    this.crackGrow = 0
    this.crackHeat = 0.4
    this.crackU.uSeed.value = Math.random() * 100
    this.crack.position.set(center.x, 0.03, center.z)
    this.crack.visible = true
    const n = this.max
    for (let i = 0; i < n; i++) {
      if (this.state[i] !== OFF) continue
      // a mix of boulders, stones and pebbles; bigger ones need more power to lift
      const u = i / n
      const kind = u < 0.16 ? 2 : u < 0.45 ? 1 : 0
      const s = kind === 2 ? 0.5 + Math.random() * 0.55 : kind === 1 ? 0.2 + Math.random() * 0.24 : 0.05 + Math.random() * 0.1
      this.size[i] = s
      this.need[i] = kind === 2 ? 0.25 + Math.random() * 0.7 : kind === 1 ? 0.08 + Math.random() * 0.75 : Math.random() * 0.9
      this.orbitR[i] = (kind === 2 ? 3.2 : 1.6) + Math.random() * (kind === 2 ? 5 : 6.5)
      this.orbitA[i] = Math.random() * Math.PI * 2
      this.orbitW[i] = (0.12 + Math.random() * 0.3) * (Math.random() < 0.5 ? -1 : 1) * (kind === 0 ? 2 : 1)
      this.hover[i] = kind === 2 ? 0.8 + Math.random() * 3.2 : 0.5 + Math.random() * 5.5
      this.phase[i] = Math.random() * Math.PI * 2
      this.state[i] = WAIT
      this.heat[i] = 0
      this.bounces[i] = 0
    }
  }

  /** Hold the power (0..1) for this frame; `center` lets the rocks follow the hero. Without it they drop. */
  setPower(k: number, center?: THREE.Vector3) {
    if (!this.sessionOn) this.begin(center ?? this.center)
    this.power = Math.max(0, Math.min(1, k))
    this.heldT = 0
    if (center) {
      this.center.x += (center.x - this.center.x) * 0.08
      this.center.z += (center.z - this.center.z) * 0.08
    }
  }

  /** Blast the rocks outward (radially) or along `dir`; they tumble and fall. */
  release(dir?: THREE.Vector3, speed = 1) {
    this.sessionOn = false
    this.crackHeat = 1.6
    this.crackGrow = Math.max(this.crackGrow, 0.6 + this.power * 0.4)
    for (let i = 0; i < this.max; i++) {
      const st = this.state[i]
      if (st === WAIT) {
        this.state[i] = OFF
        continue
      }
      if (st !== RISE) continue
      const k = i * 3
      const sz = this.size[i]
      if (dir) {
        // down the cut: a wall of stone that fans out as it goes
        _side.set(dir.z, 0, -dir.x).normalize()
        const fast = (55 + Math.random() * 70) * speed * (1.1 - Math.min(1, sz) * 0.4)
        this.vel[k] = dir.x * fast + _side.x * (Math.random() - 0.5) * 22
        this.vel[k + 1] = 3 + Math.random() * 12
        this.vel[k + 2] = dir.z * fast + _side.z * (Math.random() - 0.5) * 22
      } else {
        _v.set(this.pos[k] - this.center.x, 0, this.pos[k + 2] - this.center.z)
        if (_v.lengthSq() < 1e-4) _v.set(Math.random() - 0.5, 0, Math.random() - 0.5)
        _v.normalize().multiplyScalar((22 + Math.random() * 30) * speed)
        this.vel[k] = _v.x
        this.vel[k + 1] = 6 + Math.random() * 14
        this.vel[k + 2] = _v.z
      }
      this.spin[i * 4 + 3] = (Math.random() * 2 - 1) * 14
      this.heat[i] = 0.7 + Math.random() * 0.3
      this.life[i] = 2.5 + Math.random() * 2
      this.bounces[i] = 0
      this.state[i] = FLY
    }
  }

  /** Let everything aloft fall where it is. */
  drop() {
    this.sessionOn = false
    for (let i = 0; i < this.max; i++) {
      if (this.state[i] === WAIT) this.state[i] = OFF
      else if (this.state[i] === RISE) {
        this.state[i] = FLY
        this.life[i] = 2.5
        this.bounces[i] = 0
        const k = i * 3
        this.vel[k] *= 0.3
        this.vel[k + 2] *= 0.3
      }
    }
  }

  clear() {
    this.sessionOn = false
    this.state.fill(OFF)
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, ZERO)
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.visible = false
    this.crack.visible = false
    this.crackHeat = this.crackGrow = 0
  }

  /** A rock tears free of the ground. */
  private liftOff(i: number) {
    const k = i * 3
    const s = this.size[i]
    const a = this.orbitA[i]
    const r = this.orbitR[i] * (0.8 + Math.random() * 0.3)
    this.pos[k] = this.center.x + Math.sin(a) * r
    this.pos[k + 1] = -s * 0.4
    this.pos[k + 2] = this.center.z + Math.cos(a) * r
    this.vel[k] = 0
    this.vel[k + 1] = 4 + Math.random() * 5 + (s < 0.2 ? 4 : 0)
    this.vel[k + 2] = 0
    _q.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6))
    this.rot.set([_q.x, _q.y, _q.z, _q.w], i * 4)
    _ax.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
    this.spin.set([_ax.x, _ax.y, _ax.z, (Math.random() * 2 - 1) * (s < 0.2 ? 2.5 : 0.8)], i * 4)
    this.heat[i] = 0.25 + Math.random() * 0.35
    this.state[i] = RISE
    const fx = this.fx
    if (!fx) return
    _p.set(this.pos[k], 0.2, this.pos[k + 2])
    if (s > 0.18) {
      fx.dust(_p, s > 0.45 ? 3 : 1, s * 1.4, 0.8 + s * 2.2)
      fx.debris.burst(_p, s > 0.45 ? 3 : 1, 3 + s * 4, s * 0.3, 0.6, 1)
      if (s > 0.45) this.scorch?.crater(_p.x, _p.z, s * 1.2, 0.5)
    }
  }

  update(dt: number) {
    this.time += dt
    if (dt <= 0 && !this.mesh.visible) return
    this.heldT += dt
    // nobody is holding the power any more: everything falls
    if (this.sessionOn && this.heldT > 0.3) this.drop()
    const pw = this.power
    const n = this.max
    let any = false
    for (let i = 0; i < n; i++) {
      const st = this.state[i]
      if (st === OFF) continue
      if (st === WAIT) {
        any = true
        if (this.sessionOn && pw >= this.need[i] && Math.random() < dt * 9) this.liftOff(i)
        continue
      }
      any = true
      const k = i * 3
      const s = this.size[i]
      if (st === RISE) {
        // spring toward a slow orbit around the centre, rising higher as power builds
        this.orbitA[i] += this.orbitW[i] * (0.4 + pw * 1.2) * dt
        const r = this.orbitR[i] * (1 - pw * 0.12)
        const tx = this.center.x + Math.sin(this.orbitA[i]) * r
        const tz = this.center.z + Math.cos(this.orbitA[i]) * r
        const ty = s * 0.6 + this.hover[i] * (0.35 + pw * 0.75) + Math.sin(this.time * 1.7 + this.phase[i]) * (0.12 + s * 0.15)
        const kk = 7
        const c = 2 * Math.sqrt(kk) * 0.75
        this.vel[k] += ((tx - this.pos[k]) * kk - this.vel[k] * c) * dt
        this.vel[k + 1] += ((ty - this.pos[k + 1]) * kk - this.vel[k + 1] * c) * dt
        this.vel[k + 2] += ((tz - this.pos[k + 2]) * kk - this.vel[k + 2] * c) * dt
        this.pos[k] += this.vel[k] * dt
        this.pos[k + 1] += this.vel[k + 1] * dt
        this.pos[k + 2] += this.vel[k + 2] * dt
        this.heat[i] = Math.max(0.15, this.heat[i] - dt * 0.3)
      } else {
        this.vel[k + 1] -= GRAVITY * dt
        this.pos[k] += this.vel[k] * dt
        this.pos[k + 1] += this.vel[k + 1] * dt
        this.pos[k + 2] += this.vel[k + 2] * dt
        this.life[i] -= dt
        this.heat[i] = Math.max(0, this.heat[i] - dt * 0.5)
        const floor = s * 0.5
        if (this.pos[k + 1] < floor) {
          const vy = this.vel[k + 1]
          this.pos[k + 1] = floor
          this.vel[k + 1] = -vy * 0.32
          this.vel[k] *= 0.5
          this.vel[k + 2] *= 0.5
          this.spin[i * 4 + 3] *= 0.5
          if (vy < -5 && this.bounces[i] < 2 && s > 0.3 && this.fx) this.fx.dust(_p.set(this.pos[k], 0.2, this.pos[k + 2]), 1, s, 0.6 + s * 1.5)
          if (++this.bounces[i] > 3 || Math.abs(vy) < 1.5) this.life[i] = Math.min(this.life[i], 0.5)
        }
        // hot stones shed embers as they fly
        if (this.fx && this.heat[i] > 0.4 && s > 0.15 && Math.random() < dt * 30 * this.q) {
          _p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2])
          _v.set((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2)
          this.fx.glow.spawn(_p, _v, _ember, 1, 0.04 + s * 0.05, 0.4 + Math.random() * 0.4, 2, 1.5)
        }
        if (this.life[i] <= 0) {
          this.state[i] = OFF
          this.mesh.setMatrixAt(i, ZERO)
          continue
        }
      }
      // tumble
      const r4 = i * 4
      _ax.set(this.spin[r4], this.spin[r4 + 1], this.spin[r4 + 2])
      _q.set(this.rot[r4], this.rot[r4 + 1], this.rot[r4 + 2], this.rot[r4 + 3])
      _dq.setFromAxisAngle(_ax, this.spin[r4 + 3] * dt)
      _q.premultiply(_dq).normalize()
      this.rot[r4] = _q.x
      this.rot[r4 + 1] = _q.y
      this.rot[r4 + 2] = _q.z
      this.rot[r4 + 3] = _q.w
      _p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2])
      // full power: everything shudders
      if (st === RISE && pw > 0.75) {
        const j = (pw - 0.75) * 0.5 * (0.3 + s)
        _p.x += (Math.random() - 0.5) * j
        _p.y += (Math.random() - 0.5) * j
        _p.z += (Math.random() - 0.5) * j
      }
      const fade = st === FLY ? Math.min(1, this.life[i] / 0.5) : 1
      _s.setScalar(s * fade)
      _m.compose(_p, _q, _s)
      this.mesh.setMatrixAt(i, _m)
      this.glowAttr.setXY(i, this.heat[i], st === RISE ? 0.25 + pw * 0.75 : this.heat[i] * 0.5)
    }
    this.mesh.visible = any
    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true
      this.glowAttr.needsUpdate = true
    }

    // the cracks spread with the power and cool after the release
    if (this.sessionOn) {
      this.crackGrow = Math.max(this.crackGrow, pw)
      this.crackHeat += (0.35 + pw * 0.9 - this.crackHeat) * Math.min(1, dt * 4)
    } else this.crackHeat = Math.max(0, this.crackHeat - dt * (this.crackHeat > 1 ? 1.4 : 0.45))
    this.crackU.uGrow.value = this.crackGrow
    this.crackU.uHeat.value = this.crackHeat
    this.crackU.uTime.value = this.time
    this.crack.scale.setScalar(9.5)
    this.crack.visible = this.crackHeat > 0.01 && this.crackGrow > 0.01
    void _up
  }
}

/**
 * A star of jagged cracks radiating from the centre, glowing with the power
 * underneath, with a ring fracture where the ground heaves.
 */
function crackMaterial(u: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uGrow;
      uniform float uHeat;
      uniform float uTime;
      uniform float uSeed;
      varying vec2 vUv;
      float h11(float n) { return fract(sin(n * 12.9898 + uSeed) * 43758.5453); }
      float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float vn(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
      // distance (in metres at radius r) to the nearest radial crack of a family of n
      float cracks(float ang, float r, float n, float seed, float reach, out float lenK) {
        float a = ang / 6.28318 * n + seed;
        float cell = floor(a);
        float jit = (h11(cell + seed * 7.0) - 0.5) * 0.7;
        float wob = (vn(vec2(r * 2.2, cell * 3.1 + seed)) - 0.5) * 0.9 + (vn(vec2(r * 7.0, cell * 5.7)) - 0.5) * 0.25;
        float local = fract(a) - 0.5 - jit - wob * 0.35;
        lenK = reach * (0.45 + 0.55 * h11(cell * 1.7 + seed));
        return abs(local) / n * 6.28318 * r;
      }
      void main() {
        vec2 d = (vUv - 0.5) * 2.0;
        float r = length(d);
        if (r > 1.0) discard;
        float rm = r * 9.5;
        float ang = atan(d.y, d.x) + 3.14159;
        float reach = uGrow * 9.0;
        float l1, l2;
        float d1 = cracks(ang, rm, 11.0, 0.0, reach, l1);
        float d2 = cracks(ang, rm, 23.0, 0.37, reach * 0.6, l2);
        float w1 = mix(0.16, 0.03, clamp(rm / max(l1, 0.1), 0.0, 1.0));
        float w2 = mix(0.08, 0.02, clamp(rm / max(l2, 0.1), 0.0, 1.0));
        float c1 = smoothstep(w1, 0.0, d1) * step(rm, l1) * smoothstep(0.35, 0.9, rm);
        float c2 = smoothstep(w2, 0.0, d2) * step(rm, l2) * smoothstep(1.0, 1.8, rm);
        // ring fracture where the ground heaves up
        float rr = 1.6 + uGrow * 1.6 + (vn(vec2(ang * 3.0, uSeed)) - 0.5) * 0.5;
        float c3 = smoothstep(0.07, 0.0, abs(rm - rr)) * step(0.3, vn(vec2(ang * 5.0, 3.0 + uSeed))) * step(0.15, uGrow);
        float crack = max(max(c1, c2 * 0.8), c3 * 0.9);
        // scorched halo around the cracks (darkens the ground)
        float soot = max(smoothstep(w1 * 5.0, 0.0, d1) * step(rm, l1 * 1.1), smoothstep(2.4, 0.0, rm) * 0.5) * clamp(uGrow * 2.0, 0.0, 1.0) * 0.55;
        float flick = 0.8 + 0.2 * vn(vec2(rm * 1.5 - uTime * 2.0, ang * 4.0));
        float hot = clamp(uHeat, 0.0, 2.0);
        vec3 lava = mix(vec3(1.2, 0.25, 0.04), vec3(2.6, 1.5, 0.55), clamp(hot - 0.4, 0.0, 1.0));
        lava = mix(lava, vec3(4.0, 3.4, 2.4), clamp(hot - 1.1, 0.0, 1.0));
        vec3 glow = lava * crack * flick * min(1.0, hot * 1.5);
        float a = max(soot * smoothstep(1.0, 0.85, r), crack * min(1.0, hot * 2.0 + 0.3));
        if (a < 0.003) discard;
        gl_FragColor = vec4(glow / max(a, 0.001), a);
      }`,
    transparent: true,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
}
