import * as THREE from 'three'
import { audio } from '../audio/audio'
import type { Shape } from '../engine/geom'
import { emptyFrame, type InputFrame } from '../input/input'
import type { Quality } from '../state/settings'
import { useUI, type BossBar } from '../state/store'
import { CameraRig } from './camera'
import { Fx } from './fx/fx'
import { Slicer } from './fx/slicer'
import { Player } from './player/Player'
import { Slashes } from './player/slashes'
import { PostState } from './post'
import { Score } from './score'
import { TimeCtl } from './time'
import { newHitId, type Damageable, type Hit, type ReflectTarget, type Threat } from './types'
import { buildGround } from './world/ground'
import { FOG_COLOR, SUN_DIR } from './world/layout'
import { Props } from './world/props'
import { ScorchMap } from './world/scorch'
import { Sky } from './world/sky'

/** A gameplay system that plugs into the frame loop. */
export interface System {
  readonly root?: THREE.Object3D
  update(dt: number, rdt: number): void
  reset(): void
  damage?(shape: Shape, hit: Hit): number
  /** Cut projectiles in flight. */
  cut?(shape: Shape): void
  obstacles?(out: Obstacle[]): void
  reflectTargets?(out: ReflectTarget[]): void
  /** Enemy positions (Judgment, aim assist). */
  points?(out: THREE.Vector3[]): void
  bosses?(out: BossBar[]): void
  threats?(out: Threat[]): void
}

export interface Obstacle {
  x: number
  z: number
  r: number
  h: number
}

export type GameMode = 'title' | 'campaign' | 'sandbox'

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()

export class Game {
  readonly root = new THREE.Group()
  readonly quality: Quality
  readonly q: number
  camera: THREE.PerspectiveCamera
  scene: THREE.Scene | null = null
  readonly time = new TimeCtl()
  readonly post = new PostState()
  readonly cam = new CameraRig()
  readonly sky = new Sky()
  readonly scorch = new ScorchMap()
  readonly fx: Fx
  readonly slicer = new Slicer()
  readonly props: Props
  readonly player: Player
  readonly slashes: Slashes
  readonly score = new Score()
  readonly wind = new THREE.Vector3(1.6, 0, -0.5)
  private windGust = new THREE.Vector3()
  readonly sun: THREE.DirectionalLight
  readonly fill: THREE.HemisphereLight
  private ground: THREE.Mesh
  private systems: System[] = []
  private damageables: Damageable[] = []
  mode: GameMode = 'title'
  director: import('./director').Director | null = null
  forces: import('./waves').Forces | null = null
  /** Overrides Q (the Eclipse finale). Returns true when it handled the press. */
  onUltimate: (() => boolean) | null = null
  /** Enemies hold fire (cinematics, wave intros). */
  ceasefire = false
  /** Seconds since the run started. */
  clock = 0
  private obstacleList: Obstacle[] = []
  private pointList: THREE.Vector3[] = []
  private bossTimer = 0
  private deathTimer = -1
  viewportH = 720

  constructor(quality: Quality, camera: THREE.PerspectiveCamera) {
    this.quality = quality
    this.q = quality === 'high' ? 1 : quality === 'medium' ? 0.75 : 0.5
    this.camera = camera
    this.fx = new Fx({
      camera,
      post: this.post,
      scorch: this.scorch,
      sky: this.sky,
      quality: this.q,
      wind: this.wind,
      shake: (a, at) => {
        let k = 1
        if (at) k = Math.max(0.1, 1 - at.distanceTo(this.player.pos) / 260)
        this.cam.addTrauma(a * k)
      },
    })
    this.player = new Player(this)
    this.slashes = new Slashes(this)
    this.props = new Props(this)
    this.ground = buildGround(this.scorch, quality)
    this.fx.ghosts.bind(this.player.model)

    // light: the eclipse's corona from the north, a bruised sky above
    this.sun = new THREE.DirectionalLight('#ffb27a', 2.2)
    this.sun.castShadow = true
    const size = quality === 'high' ? 4096 : quality === 'medium' ? 2048 : 1024
    this.sun.shadow.mapSize.set(size, size)
    const ext = 45
    Object.assign(this.sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 300 })
    this.sun.shadow.bias = -0.0003
    this.sun.shadow.normalBias = 0.04
    this.fill = new THREE.HemisphereLight('#5a3a66', '#1a0c0a', 0.85)
    const rimBack = new THREE.DirectionalLight('#7f8cff', 0.5)
    rimBack.position.set(40, 30, 80)

    this.root.add(this.sky.mesh, this.ground, this.props.root, this.fx.root, this.slicer.root, this.slashes.root)
    this.root.add(this.player.model.container, this.sun, this.sun.target, this.fill, rimBack)
    this.damageables.push(this.props)
    this.player.reset()
    this.cam.snap(this.player.pos, Math.PI)
  }

  /** Register a gameplay system (enemies, threats, the director). */
  add(sys: System) {
    this.systems.push(sys)
    if (sys.root) this.root.add(sys.root)
    if (sys.damage) this.damageables.push(sys as Damageable)
    return sys
  }

  attach(scene: THREE.Scene) {
    this.scene = scene
    scene.fog = new THREE.FogExp2(FOG_COLOR.clone(), 0.0016)
  }

  // -------------------------------------------------------------------------
  // Queries used by systems
  // -------------------------------------------------------------------------

  /** Apply a hit to everything the shape touches. */
  damage(shape: Shape, hit: Hit): number {
    let n = 0
    for (const d of this.damageables) n += d.damage(shape, hit)
    return n
  }

  cutProjectiles(shape: Shape) {
    for (const s of this.systems) s.cut?.(shape)
  }

  obstacles(): Obstacle[] {
    return this.obstacleList
  }

  /** Inbound dangers, soonest first. */
  threats(): Threat[] {
    const out: Threat[] = []
    for (const s of this.systems) s.threats?.(out)
    return out.sort((a, b) => a.eta - b.eta)
  }

  reflectTargets(): ReflectTarget[] {
    const out: ReflectTarget[] = []
    for (const s of this.systems) s.reflectTargets?.(out)
    return out
  }

  /** Best reflect target near the crosshair, else the fallback (the sender). */
  pickReflectTarget(fallback: ReflectTarget | null, maxAngle = 0.22): ReflectTarget | null {
    const o = this.cam.aimOrigin
    const d = this.cam.aimDir
    let best: ReflectTarget | null = null
    let bestA = maxAngle
    for (const t of this.reflectTargets()) {
      if (!t.alive) continue
      t.aim(_v)
      const a = _w.subVectors(_v, o).normalize().angleTo(d)
      if (a < bestA) {
        bestA = a
        best = t
      }
    }
    return best ?? (fallback?.alive ? fallback : null)
  }

  // -------------------------------------------------------------------------
  // Big moves (shared visuals)
  // -------------------------------------------------------------------------

  cleaveFx(a: THREE.Vector3, b: THREE.Vector3, fwd: THREE.Vector3, k: number) {
    const fx = this.fx
    const len = a.distanceTo(b)
    const steps = Math.ceil(len / 6)
    // the fissure tears open along the line, outrunning sound
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps
      const t1 = (i + 1) / steps
      fx.after(t0 * 0.35, () => {
        const p0 = _v.lerpVectors(a, b, t0).clone()
        const p1 = _w.lerpVectors(a, b, t1).clone()
        this.scorch.fissure(p0.x, p0.z, p1.x, p1.z, 0.8 + k * 1.6, 1)
        const mid = p0.clone().lerp(p1, 0.5).setY(0.3)
        fx.debris.burst(mid, Math.round(2 + k * 4), 8 + k * 14, 0.12 + k * 0.18, 1, 1.4)
        fx.dust(mid, 2, 2 + k * 3, 2 + k * 3)
        fx.emberDrift(mid, 30 + k * 70, 1.5 + k * 3, { height: 1 + k * 4, rise: 2 + k * 3, burst: 2, life: 2.5 + k * 2 })
        fx.glitter(mid, 14 + k * 50, 1 + k * 2, 2 + k * 8)
        const nf = Math.round(3 * this.q)
        for (let j = 0; j < nf; j++) fx.fire.spawn(mid, _v.set((Math.random() - 0.5) * 4, 6 + Math.random() * 14 * k, (Math.random() - 0.5) * 4), [1, 0.55, 0.2], 0.9, 1.5 + k * 2.5, 0.6, -2, 2, { grow: 1.2 })
      })
    }
    // a wall of sparks erupts along the cut as it tears open
    fx.sparkWall(a, b, 1200 + k * 3800, 18 + k * 46, undefined, 0.35)
    // a towering wave of light races down the line
    this.slashes.fire(_v.copy(a).setY(8 + k * 10), fwd, { width: 14 + k * 26, roll: Math.PI / 2, dmg: 0, speed: 420, life: len / 420 + 0.05, color: '#ffcf70', visualOnly: true })
    fx.flare(_v.copy(a).setY(1.5), 10 + k * 20, '#fff2d0', 0.4)
    fx.light(_v.copy(a).addScaledVector(fwd, 10).setY(6), '#ffd8a0', 150 + k * 600, 50 + k * 80, 4)
    if (k > 0.6) this.sky.flash(fwd, 0.6 * k, '#ffd8a0')
    this.cam.addTrauma(0.4 + k * 0.6)
    this.cam.kickFov(6 + k * 8)
    this.post.impactFrames(k > 0.7 ? [2, 1, 2, 0] : [2, 0])
    this.post.kickZoom(0.05 + k * 0.08)
    this.post.flashTo(0.06 + k * 0.12, '#fff4dc', 5)
    this.time.freeze(0.06 + k * 0.08)
    if (k > 0.8) this.time.divine(0.9, 0.3)
    audio.rumble(0.6 * k, 3)
  }

  /** Points for Judgment's cuts: enemies first, then the air around the hero. */
  judgmentPoint(i: number): THREE.Vector3 {
    const pts = this.pointList
    const p = this.player.pos
    if (pts.length && i < pts.length * 2) {
      const near = pts.filter((q) => q.distanceTo(p) < 140)
      if (near.length) return near[i % near.length].clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3))
    }
    const a = Math.random() * Math.PI * 2
    const r = 6 + Math.random() * 40
    return new THREE.Vector3(p.x + Math.sin(a) * r, 1 + Math.random() * 12, p.z + Math.cos(a) * r)
  }

  /** The sheathe: everything that was cut falls apart at once. */
  judgmentStrike(at: THREE.Vector3) {
    this.time.stop(false)
    const c = at.clone().setY(2)
    const n = this.damage({ t: 'sphere', c, r: 150 }, { id: newHitId(), kind: 'judgment', dmg: 4000, power: 40, origin: c, friendly: true })
    this.cutProjectiles({ t: 'sphere', c, r: 150 })
    const near = this.pointList.filter((q) => q.distanceTo(at) < 150).slice(0, 24)
    near.forEach((q, i) => this.fx.after(0.02 + i * 0.03, () => this.fx.explosion(q.clone().setY(Math.max(1, q.y)), 2 + Math.random() * 3, { sound: i % 4 === 0 })))
    this.post.impactFrames([1, 2, 1, 2, 0], 1 / 20)
    this.post.flashTo(0.9, '#ffffff', 2.5)
    this.post.kickZoom(0.35)
    this.post.shock(c, this.camera, 0.06)
    this.cam.addTrauma(1)
    this.time.freeze(0.12)
    this.time.divine(1.2, 0.25)
    this.sky.flash(new THREE.Vector3(0, 1, 0), 1.2, '#cfe4ff')
    audio.explosion(c, 18)
    audio.cleave(1)
    void n
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Restore the world to a fresh battlefield. */
  resetWorld() {
    this.time.reset()
    this.post.reset()
    this.sky.reset()
    this.scorch.clear()
    this.fx.clear()
    this.slicer.clear()
    this.slashes.clear()
    this.props.reset()
    // the dawn relights the world; put the eclipse light back
    this.sun.color.set('#ffb27a')
    this.sun.intensity = 2.2
    this.fill.color.set('#5a3a66')
    for (const s of this.systems) s.reset()
    this.score.reset()
    this.player.reset()
    this.cam.snap(this.player.pos, Math.PI)
    this.ceasefire = false
    this.clock = 0
    this.deathTimer = -1
  }

  onPlayerDeath() {
    this.deathTimer = 0
    audio.defeat()
    this.time.slowmo(2.5, 0.3)
    useUI.getState().showBanner({ kind: 'death', title: 'DIVINITY FADES', sub: 'Even gods may fall. Rise again.' })
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(realDt: number, f: InputFrame, inputEnabled: boolean) {
    const rdt = Math.min(realDt, 1 / 20)
    const [wdt, pdt] = this.time.update(rdt)
    this.clock += rdt
    const playing = this.mode !== 'title'
    const frame = playing && inputEnabled ? f : emptyFrame()

    // collision helpers for this frame
    this.obstacleList.length = 0
    this.props.obstacles(this.obstacleList)
    for (const s of this.systems) s.obstacles?.(this.obstacleList)
    this.pointList.length = 0
    for (const s of this.systems) s.points?.(this.pointList)

    // wind gusts (shockwaves set the gust)
    this.windGust.multiplyScalar(Math.exp(-rdt * 1.5))
    this.wind.set(1.6 + Math.sin(this.clock * 0.7) * 0.8, 0, -0.5 + Math.cos(this.clock * 0.4) * 0.6).add(this.windGust)

    this.director?.input(frame)
    this.player.update(pdt, frame, playing && inputEnabled)
    this.slashes.update(pdt)
    for (const s of this.systems) s.update(wdt, rdt)
    this.slicer.update(wdt)
    this.props.root.updateMatrixWorld()
    this.scorch.update(rdt)
    this.score.update(rdt)

    // camera
    const big = this.player.state === 'charge' ? this.player.charge * 3 : 0
    this.cam.update(rdt, frame.lookX, frame.lookY, { pos: this.player.pos, framing: big + this.framing }, this.camera, playing && inputEnabled)
    this.ambience(wdt)
    this.fx.update(wdt, rdt, this.camera, this.viewportH)
    this.sky.update(rdt, this.camera, true)
    this.post.update(rdt)
    if (this.scene?.fog) {
      const fog = this.scene.fog as THREE.FogExp2
      fog.color.copy(this.sky.fogColor)
      // the air clears at dawn
      fog.density = 0.0016 - 0.0008 * this.sky.u.uDawn.value
    }

    // keep the shadow camera on the hero
    const px = Math.round(this.player.pos.x)
    const pz = Math.round(this.player.pos.z)
    this.sun.target.position.set(px, 0, pz)
    this.sun.position.set(px + SUN_DIR.x * -60 - 40, 90, pz + SUN_DIR.z * 90)
    this.sun.target.updateMatrixWorld()

    // audio
    audio.setListener(this.camera.position.x, this.camera.position.y, this.camera.position.z, this.cam.yaw)
    audio.setWarp(this.time.isStopped ? 1 : this.time.divineAmount * 0.8)
    audio.update(this.windGust.length() * 0.1)

    // UI: boss bars at a modest rate
    this.bossTimer -= rdt
    if (this.bossTimer <= 0 && playing) {
      this.bossTimer = 0.1
      const bars: BossBar[] = []
      for (const s of this.systems) s.bosses?.(bars)
      useUI.getState().setBosses(bars)
    }
    if (this.deathTimer >= 0) {
      this.deathTimer += rdt
      if (this.deathTimer > 3.2) {
        this.deathTimer = -1
        useUI.getState().setDead(true)
      }
    }
  }

  /** Extra camera distance requested by big fights. */
  framing = 0

  /** The end of the world drifts by: embers rising, ash falling. */
  private ambience(dt: number) {
    this.fx.ambient(dt, this.camera.position, this.wind, this.sky.u.uDawn.value)
  }

  /** Blow everything around with a shockwave gust. */
  gust(from: THREE.Vector3, strength: number) {
    _v.subVectors(this.player.pos, from).setY(0).normalize().multiplyScalar(strength)
    this.windGust.add(_v)
  }
}
