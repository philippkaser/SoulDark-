import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { clamp, TAU } from '../../engine/math'
import { EMBER, FIRE, GOLD, WHITE_GOLD } from '../fx/particleFx'
import type { Game } from '../Game'
import { Billows, Boulders } from './mountainFx'
import { liningFrag, notchVert, ridgeFrag, ridgeVert, tubeVert } from './mountainShaders'
import { BORE_LEAD, CUT_SPEED, emptyBore, emptyNotch, FAR_RING, MAX_BORES, MAX_NOTCHES, NEAR_RING, packBores, packNotches, pickSlot, Ridge, SKIRT, type Bore, type Notch } from './ridge'

const _p = new THREE.Vector3()
const _q = new THREE.Vector3()
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _d = new THREE.Vector3()
const _f = new THREE.Vector3()
const _e1 = new THREE.Vector3()
const _e2 = new THREE.Vector3()
const _o = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

/** Face rows of a ring, from the plain up to the summit edge (face coordinate x). */
const INNER_X = [SKIRT, 1.4, 1.2, 1.02, 0.88, 0.74, 0.6, 0.47, 0.35, 0.24, 0.15, 0.08, 0.03]
const SUMMIT = [-0.6, -0.2, 0.2, 0.6]
const OUTER_X = [0.03, 0.1, 0.22, 0.4, 0.62, 0.9, 1.2, SKIRT]

/**
 * A ring as a grid that follows the profile: columns around the circle,
 * rows down the arena-side face, across the summit and down the far face.
 */
export function ringGeometry(ridge: Ridge, cols: number) {
  const rows: Array<[number, number]> = []
  for (const x of INNER_X) rows.push([-1, x])
  rows.push([-1, 0])
  for (const s of SUMMIT) rows.push([0, s])
  rows.push([1, 0])
  for (const x of OUTER_X) rows.push([1, x])
  const nr = rows.length
  const pos = new Float32Array((cols + 1) * nr * 3)
  const col = { u: 0, H: 0, rc: 0, T: 0 }
  for (let i = 0; i <= cols; i++) {
    const a = ((i % cols) / cols) * TAU
    const { H, rc, T } = ridge.column(a, col)
    const wi = H / ridge.def.slopeIn
    const wo = H / ridge.def.slopeOut
    const sa = Math.sin(a)
    const ca = Math.cos(a)
    for (let j = 0; j < nr; j++) {
      const [side, v] = rows[j]
      const d = side === 0 ? v * T : side < 0 ? -(T + v * wi) : T + v * wo
      const r = rc + d
      const k = (i * nr + j) * 3
      pos[k] = sa * r
      pos[k + 1] = ridge.profileAt(r, col)
      pos[k + 2] = ca * r
    }
  }
  const idx: number[] = []
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < nr - 1; j++) {
      const a = i * nr + j
      const b = (i + 1) * nr + j
      idx.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  // weld the seam's normals
  const n = g.attributes.normal as THREE.BufferAttribute
  for (let j = 0; j < nr; j++) {
    const a = j
    const b = cols * nr + j
    _v.fromBufferAttribute(n, a).add(_w.fromBufferAttribute(n, b)).normalize()
    n.setXYZ(a, _v.x, _v.y, _v.z)
    n.setXYZ(b, _v.x, _v.y, _v.z)
  }
  g.computeBoundingSphere()
  return g
}

function frame(d: THREE.Vector3, e1: THREE.Vector3, e2: THREE.Vector3) {
  e1.crossVectors(d, UP).normalize()
  e2.crossVectors(e1, d)
}

type TubeMesh = THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>
type SlotMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>

/**
 * The mountain rings on the horizon, solid enough to punch through: tunnels
 * bored along a ray by a travelling wave (ragged holes discarded in the rock
 * shader, a molten tube lining the tunnel), Heaven Splitter notches cut down
 * from the crest, and the boulders, dust surges, embers and late thunder that
 * go with them.
 */
export class Mountains {
  readonly root = new THREE.Group()
  readonly ridges: Ridge[]
  readonly textures: THREE.DataTexture[]
  /** Uniforms every mountain material shares (eclipse light, fog, dawn, haze, clock). */
  readonly common: Record<string, THREE.IUniform>
  readonly bores: Bore[] = Array.from({ length: MAX_BORES }, emptyBore)
  readonly notches: Notch[] = Array.from({ length: MAX_NOTCHES }, emptyNotch)
  readonly boulders: Boulders
  readonly billows: Billows
  private game: Game
  private boreA = Array.from({ length: MAX_BORES }, () => new THREE.Vector4())
  private boreB = Array.from({ length: MAX_BORES }, () => new THREE.Vector4())
  private boreC = Array.from({ length: MAX_BORES }, () => new THREE.Vector4())
  private notchA = Array.from({ length: MAX_NOTCHES }, () => new THREE.Vector4())
  private notchB = Array.from({ length: MAX_NOTCHES }, () => new THREE.Vector4())
  private notchC = Array.from({ length: MAX_NOTCHES }, () => new THREE.Vector4())
  private tubes: TubeMesh[] = []
  private slots: SlotMesh[] = []
  /** Where each notch's crest is along its cut (for the blast). */
  private notchCrest = new Float32Array(MAX_NOTCHES)
  private ground = (x: number, z: number) => Math.max(0, this.ridges[0].heightAt(x, z), this.ridges[1].heightAt(x, z))

  constructor(game: Game) {
    this.game = game
    const q = game.q
    this.ridges = [new Ridge(NEAR_RING), new Ridge(FAR_RING)]
    this.textures = this.ridges.map((r) => r.texture())
    this.common = {
      uSunDir: game.sky.u.uSun,
      uFogColor: { value: game.sky.fogColor },
      uDawn: game.sky.u.uDawn,
      uDoom: game.sky.u.uDoom,
      uHaze: { value: 0.0006 },
      uTime: { value: 0 },
    }
    const carves = {
      uBoreA: { value: this.boreA },
      uBoreB: { value: this.boreB },
      uBoreC: { value: this.boreC },
      uNotchA: { value: this.notchA },
      uNotchB: { value: this.notchB },
      uNotchC: { value: this.notchC },
    }
    const cols = q >= 1 ? 1400 : q >= 0.75 ? 1100 : 800
    this.ridges.forEach((ridge, ring) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: ridgeVert,
        fragmentShader: ridgeFrag,
        uniforms: { ...this.common, ...carves, uRing: { value: ring }, uRadius: { value: ridge.def.radius }, uVeins: { value: ring === 0 ? 0.55 : 0.2 } },
        fog: false,
      })
      const mesh = new THREE.Mesh(ringGeometry(ridge, cols), mat)
      mesh.renderOrder = -2
      mesh.frustumCulled = false
      this.root.add(mesh)
    })
    // linings stay in the scene (collapsed when idle) so their shaders compile up front, not mid-punch
    const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 64, 20, true)
    for (let i = 0; i < MAX_BORES; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: tubeVert,
        fragmentShader: liningFrag,
        uniforms: {
          ...this.common,
          uO: { value: new THREE.Vector3() },
          uD: { value: new THREE.Vector3(0, 0, -1) },
          uR: { value: 0 },
          uT: { value: new THREE.Vector4() },
          uSpeed: { value: 1 },
          uAge: { value: -1 },
          uSeed: { value: 0 },
          uHF: { value: this.textures[0] },
          uHFR: { value: new THREE.Vector2(this.ridges[0].rMin, this.ridges[0].rMax) },
          uMolten: { value: 1 },
        },
        side: THREE.DoubleSide,
        fog: false,
      })
      const m = new THREE.Mesh(tubeGeo, mat)
      m.frustumCulled = false
      m.renderOrder = -2
      this.tubes.push(m)
      this.root.add(m)
    }
    const slotGeo = new THREE.PlaneGeometry(1, 1, 110, 40)
    for (let i = 0; i < MAX_NOTCHES; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: notchVert,
        fragmentShader: liningFrag,
        uniforms: {
          ...this.common,
          uA: { value: new THREE.Vector4() },
          uB: { value: new THREE.Vector4(0, -1, 0, 1) },
          uC: { value: new THREE.Vector4(-1000, -1000, -1, 0) },
          uHF: { value: this.textures[0] },
          uHFR: { value: new THREE.Vector2(this.ridges[0].rMin, this.ridges[0].rMax) },
          uMolten: { value: 1 },
        },
        side: THREE.DoubleSide,
        fog: false,
      })
      const m = new THREE.Mesh(slotGeo, mat)
      m.frustumCulled = false
      m.renderOrder = -2
      this.slots.push(m)
      this.root.add(m)
    }
    this.boulders = new Boulders(Math.round(200 * q), this.common)
    this.boulders.onLand = (x, y, z, s) => {
      if (Math.random() < 0.6) this.billows.spawn(_p.set(x, y + s * 0.5, z), _v.set(rnd(-4, 4), 3, rnd(-4, 4)), s * 1.6, rnd(6, 10), { grow: 0.8, alpha: 0.6, dark: 0.2, drag: 0.8, flow: true })
    }
    this.billows = new Billows(Math.round(340 * q), {
      ...this.common,
      uHF0: { value: this.textures[0] },
      uHFR0: { value: new THREE.Vector2(this.ridges[0].rMin, this.ridges[0].rMax) },
      uHF1: { value: this.textures[1] },
      uHFR1: { value: new THREE.Vector2(this.ridges[1].rMin, this.ridges[1].rMax) },
    })
    this.root.add(this.boulders.mesh, this.billows.mesh)
    this.syncUniforms()
  }

  /** Highest ground at (x, z): either ring's rock or the plain. */
  groundAt(x: number, z: number) {
    return this.ground(x, z)
  }

  // -------------------------------------------------------------------------
  // Carving
  // -------------------------------------------------------------------------

  /**
   * Bore a tunnel along the ray origin + t * dir (unit or not) with a wave
   * travelling at `speed` m/s: each ring the ray meets is holed when the wave
   * arrives there, the near ring first, then on through the far one. A ray that
   * skims just over a crest still bites a trench out of it. Returns the
   * distance to the first mountain face it meets, or -1 when it misses both.
   */
  bore(origin: THREE.Vector3, dir: THREE.Vector3, radius: number, speed: number): number {
    const d = _d.copy(dir)
    if (d.lengthSq() < 1e-8) return -1
    d.normalize()
    const R = clamp(radius, 6, 180)
    const sp = Math.max(30, speed)
    let first = -1
    for (let ring = 0; ring < this.ridges.length; ring++) {
      const ridge = this.ridges[ring]
      let hit = ridge.rayHit(origin, d)
      // aimed a little high: the lower half of the bore still takes the crest
      if (!hit) hit = ridge.rayHit(_o.copy(origin).addScaledVector(UP, -R * 0.55), d)
      if (!hit) continue
      if (first < 0) first = hit.tIn
      const b = this.bores[pickSlot(this.bores)]
      b.ring = ring
      b.origin.copy(origin)
      b.dir.copy(d)
      b.radius = R
      b.tFace = hit.tIn
      b.tExit = Math.max(hit.tOut, hit.tIn + R * 0.5)
      b.tEnd = b.tExit + R * 2.5
      b.speed = sp
      b.age = -hit.tIn / sp
      b.seed = Math.random()
      b.stage = 0
      b.wisp = 0
    }
    if (first >= 0) this.syncUniforms()
    return first
  }

  /**
   * The Heaven Splitter reaches the mountains: a slot is cut down from the
   * crest of the near ring along the cut's vertical plane (and through the far
   * ring too for a full charge). `a` is the cut's origin, `fwd` its direction,
   * `k` the charge (nothing below 0.55). Returns the distance to the near crest or -1.
   */
  cleave(a: THREE.Vector3, fwd: THREE.Vector3, k: number): number {
    if (k < 0.55) return -1
    const f = _f.set(fwd.x, 0, fwd.z)
    if (f.lengthSq() < 1e-8) return -1
    f.normalize()
    let first = -1
    const rings = k > 0.85 ? 2 : 1
    for (let ring = 0; ring < rings; ring++) {
      const ridge = this.ridges[ring]
      const sA = Math.max(0, this.reach(a, f, ridge.rMin))
      const sB = this.reach(a, f, ridge.rMax)
      if (sB <= sA) continue
      let hMax = -Infinity
      let sMax = sA
      for (let s = sA; s <= sB; s += 4) {
        const h = ridge.heightAt(a.x + f.x * s, a.z + f.z * s)
        if (h > hMax) {
          hMax = h
          sMax = s
        }
      }
      if (hMax < 12) continue
      const yBottom = Math.max(6, hMax * (0.55 - 0.32 * k))
      let s0 = -1
      let s1 = -1
      for (let s = sA; s <= sB; s += 4) {
        if (ridge.heightAt(a.x + f.x * s, a.z + f.z * s) > yBottom - 25) {
          if (s0 < 0) s0 = s
          s1 = s
        }
      }
      if (s0 < 0) continue
      const slot = pickSlot(this.notches)
      const n = this.notches[slot]
      n.ring = ring
      n.origin.set(a.x, 0, a.z)
      n.fwd.copy(f)
      n.width = 6 + 9 * k
      n.flare = 0.14 + 0.14 * k
      n.s0 = s0 - 30
      n.s1 = s1 + 30
      n.yTop = hMax + 40
      n.yBottom = yBottom
      n.age = -n.s0 / CUT_SPEED
      n.seed = Math.random()
      n.stage = 0
      this.notchCrest[slot] = sMax
      if (first < 0) first = sMax
    }
    if (first >= 0) this.syncUniforms()
    return first
  }

  /** Distance along a horizontal ray from p (inside the circle) to radius R. */
  private reach(p: THREE.Vector3, f: THREE.Vector3, R: number) {
    const b = p.x * f.x + p.z * f.z
    const c = p.x * p.x + p.z * p.z - R * R
    const disc = b * b - c
    return disc < 0 ? -1 : -b + Math.sqrt(disc)
  }

  reset() {
    for (const b of this.bores) Object.assign(b, emptyBore())
    for (const n of this.notches) Object.assign(n, emptyNotch())
    this.boulders.clear()
    this.billows.clear()
    this.syncUniforms()
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, rdt: number) {
    this.common.uTime.value += dt
    // the air clears at dawn
    this.common.uHaze.value = 0.0006 - 0.00018 * this.game.sky.u.uDawn.value
    for (const b of this.bores) {
      if (b.radius <= 0) continue
      b.age += dt
      if (b.stage === 0 && b.age >= 0) {
        b.stage = 1
        this.faceBlast(b)
      }
      if (b.stage === 1 && b.tFace + b.speed * b.age >= b.tExit) {
        b.stage = 2
        this.exitBlast(b)
      }
      // the mouths smoke and spit embers while they cool
      if (b.stage >= 1 && b.age < 26) {
        b.wisp -= dt
        if (b.wisp <= 0) {
          b.wisp = rnd(0.5, 0.9)
          this.wisp(b, b.tFace, -1)
          if (b.stage === 2) this.wisp(b, b.tExit, 1)
        }
      }
    }
    for (let i = 0; i < MAX_NOTCHES; i++) {
      const n = this.notches[i]
      if (n.width <= 0) continue
      n.age += dt
      if (n.stage === 0 && n.age >= (this.notchCrest[i] - n.s0) / CUT_SPEED) {
        n.stage = 1
        this.notchBlast(n, this.notchCrest[i])
      }
    }
    this.syncUniforms()
    this.boulders.update(dt, this.ground)
    this.billows.update(dt, this.game.camera.position, this.ground)
  }

  private syncUniforms() {
    packBores(this.bores, this.boreA, this.boreB, this.boreC)
    packNotches(this.notches, this.notchA, this.notchB, this.notchC)
    for (let i = 0; i < MAX_BORES; i++) {
      const b = this.bores[i]
      const u = this.tubes[i].material.uniforms
      if (b.radius <= 0 || b.age < 0) {
        u.uR.value = 0
        u.uAge.value = -1
        continue
      }
      const ridge = this.ridges[b.ring]
      u.uO.value.copy(b.origin)
      u.uD.value.copy(b.dir)
      u.uR.value = b.radius
      u.uT.value.set(b.tFace - b.radius * BORE_LEAD, b.tEnd, b.tFace, b.tExit)
      u.uSpeed.value = b.speed
      u.uAge.value = b.age
      u.uSeed.value = b.seed * 100
      u.uHF.value = this.textures[b.ring]
      u.uHFR.value.set(ridge.rMin, ridge.rMax)
    }
    for (let i = 0; i < MAX_NOTCHES; i++) {
      const n = this.notches[i]
      const u = this.slots[i].material.uniforms
      if (n.width <= 0 || n.age < 0) {
        u.uC.value.set(-1000, -1000, -1, 0)
        continue
      }
      const ridge = this.ridges[n.ring]
      u.uA.value.set(n.origin.x, n.origin.z, n.width, n.flare)
      u.uB.value.set(n.fwd.x, n.fwd.z, n.s0, n.s1)
      u.uC.value.set(n.yTop, n.yBottom, n.age, n.seed * 100)
      u.uHF.value = this.textures[n.ring]
      u.uHFR.value.set(ridge.rMin, ridge.rMax)
    }
  }

  // -------------------------------------------------------------------------
  // Spectacle
  // -------------------------------------------------------------------------

  /** Step from p along dir until it is out of the rock (at most `max` metres). */
  private outOfRock(p: THREE.Vector3, dir: THREE.Vector3, step: number, max: number) {
    for (let s = 0; s < max && p.y < this.ground(p.x, p.z) + 1; s += step) p.addScaledVector(dir, step)
    return p
  }

  /** Particle size boost so sparks stay visible from across the plain. */
  private zoom(p: THREE.Vector3) {
    return Math.max(1, p.distanceTo(this.game.camera.position) / 260)
  }

  /** The thunder: the ground carries the jolt first, the air blast takes distance / 340 s. */
  private thunder(p: THREE.Vector3, size: number, kind: 'bore' | 'exit' | 'notch') {
    const g = this.game
    const at = p.clone()
    const dist = at.distanceTo(g.camera.position)
    const k = clamp(size, 0.3, 2)
    g.fx.after(dist / 2600, () => g.cam.addTrauma(0.12 + 0.12 * k))
    g.fx.after(dist / 340, () => {
      if (kind === 'notch') audio.mountainCleave(at, k)
      else audio.mountainBoom(at, kind === 'exit' ? k * 0.8 : k)
      audio.rockslide(at, 5 + k * 3, k)
      g.cam.addTrauma(0.2 + 0.2 * k)
      g.gust(at, 3 + 4 * k)
    })
  }

  /** The wave reaches the near face: it blows inward, and the face spalls back out. */
  private faceBlast(b: Bore) {
    const g = this.game
    const fx = g.fx
    const R = b.radius
    const q = g.q
    frame(b.dir, _e1, _e2)
    const back = _w.copy(b.dir).negate()
    const p = _p.copy(b.origin).addScaledVector(b.dir, b.tFace)
    const mouth = this.outOfRock(_q.copy(p), back, R * 0.1, R * 2).clone()
    const z = this.zoom(mouth)
    // the flash: light outruns everything
    fx.flare(mouth, R * 2, '#fff0d8', 0.45, 0.8)
    g.sky.flash(_v.subVectors(mouth, g.camera.position).normalize(), 0.7, '#ffc890')
    g.post.rays(mouth, 1.4, 2.8, '#ffcf9a')
    g.post.streak(0.9, mouth)
    // molten spray back out of the mouth, a ring of plasma round it, embers
    fx.gpu.sparkShower(mouth, back, 1400, 150, 0.55, FIRE, { size: 0.42 * z, life: 2.6, gravity: 22, drag: 0.45, stretch: 0.05, heat: 6, bounce: null, jitter: R * 0.4 })
    fx.gpu.plasmaRing(mouth, back, R * 1.9, 1100, WHITE_GOLD, { expand: 0.7, size: 0.32 * z, life: 1.4 })
    fx.emberDrift(mouth, 900, R * 1.1, { rise: 9, burst: 18, life: 9, size: 0.4 * z, curl: 8, color: EMBER, stagger: 2, wind: null })
    // the face spalls: slabs topple out toward the arena and roll down the slope
    const nb = Math.round(36 * q)
    for (let i = 0; i < nb; i++) {
      const a = Math.random() * TAU
      const rr = R * rnd(0.8, 1.5)
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      _q.copy(p).addScaledVector(_e1, ca * rr).addScaledVector(_e2, sa * rr)
      this.outOfRock(_q, back, 4, R * 3)
      const big = i < nb * 0.3
      const size = big ? rnd(7, 18) : rnd(2.5, 6)
      _v.copy(back).multiplyScalar(rnd(12, 55)).addScaledVector(_e1, ca * rnd(8, 35)).addScaledVector(_e2, sa * rnd(8, 35))
      _v.y += rnd(0, 22)
      this.boulders.spawn(_q, _v, size, Math.random() < 0.5 ? rnd(0.4, 1.4) : 0, rnd(14, 22))
    }
    // a collar of dust rolls out of the mouth, then pours down the face
    const nd = Math.round(40 * q)
    for (let i = 0; i < nd; i++) {
      const a = (i / nd) * TAU + rnd(-0.1, 0.1)
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      _q.copy(p).addScaledVector(_e1, ca * R * 1.05).addScaledVector(_e2, sa * R * 1.05)
      this.outOfRock(_q, back, 4, R * 3)
      // spilling sideways and down, not toward the eye, so the hole clears in a few seconds
      _v.copy(back).multiplyScalar(rnd(4, 14)).addScaledVector(_e1, ca * rnd(22, 48)).addScaledVector(_e2, sa * rnd(22, 48))
      _v.y -= 6
      this.billows.spawn(_q, _v, rnd(20, 36), rnd(11, 18), { grow: 0.75, alpha: 0.8, heat: rnd(0.4, 1.2), cool: 0.35, dark: rnd(0.25, 0.65), drag: 0.4, flow: true })
    }
    this.thunder(p, R / 60, 'bore')
  }

  /** The wave bursts out of the far mouth: a cone of rock, dust and fire. */
  private exitBlast(b: Bore) {
    const g = this.game
    const fx = g.fx
    const R = b.radius
    const q = g.q
    const d = b.dir
    frame(d, _e1, _e2)
    const p = _p.copy(b.origin).addScaledVector(d, b.tExit)
    const mouth = this.outOfRock(_q.copy(p), d, R * 0.1, R * 2).clone()
    const z = this.zoom(mouth)
    g.post.rays(mouth, 1.1, 2.5, '#ffc890')
    fx.gpu.sparkShower(mouth, d, 2200, 230, 0.42, FIRE, { size: 0.5 * z, life: 3, gravity: 18, drag: 0.35, stretch: 0.05, heat: 7, bounce: null, jitter: R * 0.4 })
    fx.gpu.plasmaRing(mouth, d, R * 2.3, 900, WHITE_GOLD, { expand: 0.8, size: 0.36 * z, life: 1.6 })
    fx.emberDrift(mouth, 900, R * 1.4, { rise: 12, burst: 26, life: 10, size: 0.45 * z, curl: 9, color: EMBER, stagger: 2.5, wind: null })
    // the core of the mountain, thrown out of the far side
    const nb = Math.round(48 * q)
    for (let i = 0; i < nb; i++) {
      const a = Math.random() * TAU
      const rr = R * Math.sqrt(Math.random()) * 0.9
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      _q.copy(mouth).addScaledVector(_e1, ca * rr).addScaledVector(_e2, sa * rr)
      this.outOfRock(_q, d, 4, R * 3)
      const size = i < nb * 0.25 ? rnd(8, 20) : rnd(2.5, 7)
      _v.copy(d).multiplyScalar(rnd(60, 190)).addScaledVector(_e1, ca * rnd(10, 50)).addScaledVector(_e2, sa * rnd(10, 50))
      _v.y += rnd(15, 70)
      this.boulders.spawn(_q, _v, size, rnd(0.3, 1.5), rnd(14, 22))
    }
    // a jet of pulverised rock, and a column that climbs over the crest
    const nd = Math.round(44 * q)
    for (let i = 0; i < nd; i++) {
      const a = Math.random() * TAU
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      _q.copy(mouth).addScaledVector(_e1, ca * R * 0.6).addScaledVector(_e2, sa * R * 0.6)
      this.outOfRock(_q, d, 4, R * 3)
      // a wide cone, mostly up and aside: the line of sight back through the tunnel clears quickly
      _v.copy(d).multiplyScalar(rnd(40, 150)).addScaledVector(_e1, ca * rnd(40, 90)).addScaledVector(_e2, sa * rnd(30, 70))
      _v.y += rnd(10, 40)
      const rise = i % 2 === 0
      this.billows.spawn(_q, _v, rnd(28, 50), rnd(12, 20), { grow: 0.85, alpha: 0.7, heat: rnd(0.6, 1.6), cool: 0.3, dark: rnd(0.3, 0.7), drag: 0.45, buoy: rise ? 10 : 2, flow: !rise })
    }
    this.thunder(p, R / 60, 'exit')
  }

  /** A curl of smoke from a cooling mouth. */
  private wisp(b: Bore, t: number, side: number) {
    frame(b.dir, _e1, _e2)
    // from the upper lip, so the smoke climbs the face instead of veiling the hole
    const a = rnd(0.35, Math.PI - 0.35)
    const rr = b.radius * rnd(1.05, 1.25)
    _q.copy(b.origin).addScaledVector(b.dir, t).addScaledVector(_e1, Math.cos(a) * rr).addScaledVector(_e2, Math.sin(a) * rr)
    _w.copy(b.dir).multiplyScalar(side)
    this.outOfRock(_q, _w, 5, b.radius * 3)
    const hot = Math.exp(-b.age / 10)
    _v.copy(_w).multiplyScalar(rnd(2, 5)).addScaledVector(_e1, Math.cos(a) * 4)
    _v.y += rnd(5, 10)
    this.billows.spawn(_q, _v, rnd(14, 22), rnd(9, 14), { grow: 1.0, alpha: 0.38, heat: hot * 0.9, cool: 0.2, dark: 0.75, drag: 0.6, buoy: 5 })
    if (hot > 0.2) this.game.fx.emberDrift(_q, 40 * hot, b.radius * 0.5, { rise: 7, burst: 4, life: 5, size: 0.4 * this.zoom(_q), curl: 5, color: EMBER, wind: null })
  }

  /** The cut reaches the crest: the slot's rock is blasted up and out, its walls slide. */
  private notchBlast(n: Notch, sCrest: number) {
    const g = this.game
    const fx = g.fx
    const q = g.q
    const ridge = this.ridges[n.ring]
    const f = n.fwd
    const side = _e1.set(f.z, 0, -f.x)
    const at = (s: number, out: THREE.Vector3) => out.set(n.origin.x + f.x * s, 0, n.origin.z + f.z * s)
    at(sCrest, _p)
    const hc = ridge.heightAt(_p.x, _p.z)
    _p.y = hc
    const top = _p.clone()
    const z = this.zoom(top)
    const depth = Math.max(10, hc - n.yBottom)
    g.post.rays(_q.copy(top).setY(hc + 20), 1.3, 2.6, '#ffe2b0')
    g.post.streak(0.8, top)
    g.sky.flash(_v.subVectors(top, g.camera.position).normalize(), 0.6, '#ffd8a0')
    // sparks tear along the crest of the slot
    const a0 = at(n.s0 + 30, new THREE.Vector3())
    const a1 = at(n.s1 - 30, new THREE.Vector3())
    a0.y = a1.y = hc * 0.9
    fx.gpu.sparkWall(a0, a1, 2600, 110, GOLD, { sweep: 0.25, size: 0.35 * z, life: 1.6 })
    fx.gpu.sparkShower(_q.copy(top).setY(hc + 5), UP, 1200, 160, 0.5, FIRE, { size: 0.45 * z, life: 2.5, gravity: 20, drag: 0.4, heat: 6, bounce: null, jitter: depth * 0.3 })
    fx.emberDrift(top, 800, depth * 0.8, { rise: 10, burst: 16, life: 9, size: 0.4 * z, curl: 8, color: EMBER, stagger: 2, wind: null })
    // the wedge of rock in the slot is flung up and out
    const nb = Math.round(30 * q)
    const w = n.width + depth * n.flare
    for (let i = 0; i < nb; i++) {
      const s = sCrest + rnd(-1, 1) * Math.min(120, (n.s1 - n.s0) * 0.35)
      at(s, _q)
      const h = ridge.heightAt(_q.x, _q.z)
      _q.y = rnd(n.yBottom, Math.max(n.yBottom + 1, h))
      const lat = rnd(-1, 1)
      _q.addScaledVector(side, lat * w)
      _v.set(0, rnd(40, 110), 0).addScaledVector(side, lat * rnd(15, 45)).addScaledVector(f, rnd(-10, 40))
      this.boulders.spawn(_q, _v, i < nb * 0.3 ? rnd(7, 16) : rnd(2.5, 6), rnd(0.4, 1.4), rnd(14, 22))
    }
    // the walls slide: rubble and a dust surge pour down both faces from the lips
    const ns = Math.round(28 * q)
    for (let i = 0; i < ns; i++) {
      const s = rnd(n.s0 + 30, n.s1 - 30)
      at(s, _q)
      const sd = i % 2 === 0 ? 1 : -1
      _q.addScaledVector(side, sd * (w + rnd(4, 25)))
      _q.y = ridge.heightAt(_q.x, _q.z) + 4
      _v.copy(side).multiplyScalar(sd * rnd(4, 14))
      if (i % 3 === 0) this.boulders.spawn(_q, _v, rnd(3, 9), 0, rnd(14, 20))
      _q.y += 10
      this.billows.spawn(_q, _v, rnd(20, 36), rnd(14, 24), { grow: 0.8, alpha: 0.85, heat: rnd(0, 0.5), dark: rnd(0.2, 0.55), drag: 0.4, flow: true, delay: rnd(0, 1.2) })
    }
    const nr = Math.round(12 * q)
    for (let i = 0; i < nr; i++) {
      _q.copy(top).addScaledVector(f, rnd(-60, 60)).addScaledVector(side, rnd(-1, 1) * w * 0.6)
      _q.y = hc + rnd(0, 20)
      _v.set(rnd(-10, 10), rnd(20, 50), rnd(-10, 10))
      this.billows.spawn(_q, _v, rnd(26, 46), rnd(16, 26), { grow: 0.9, alpha: 0.8, heat: rnd(0.5, 1.2), dark: rnd(0.3, 0.6), drag: 0.5, buoy: 5 })
    }
    this.thunder(top, depth / 90, 'notch')
  }
}
