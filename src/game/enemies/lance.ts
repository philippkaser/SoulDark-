import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { standard } from '../../engine/gfx/materials'
import type { BossBar } from '../../state/store'
import type { Game, System } from '../Game'
import type { ReflectTarget, Threat } from '../types'
import { OrbitalBeam } from './beam'

const MAX_HP = 4000
const _v = new THREE.Vector3()

function buildStation() {
  const g = new THREE.Group()
  const hull = standard({ color: '#c8c6c0', metalness: 0.7, roughness: 0.4, rim: 0.5, rimColor: '#ff9070' })
  const dark = standard({ color: '#2a2a2e', metalness: 0.8, roughness: 0.5 })
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 1.2, 0.6), fog: false })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(34, 3, 10, 64), hull)
  ring.rotation.x = Math.PI / 2
  g.add(ring)
  for (let i = 0; i < 6; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 34), dark)
    spoke.rotation.y = (i / 6) * Math.PI
    g.add(spoke)
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(9, 6, 14, 16), hull)
  g.add(hub)
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(4, 6, 26, 16), dark)
  barrel.position.y = -18
  g.add(barrel)
  const lens = new THREE.Mesh(new THREE.SphereGeometry(4.5, 16, 10), glow)
  lens.position.y = -31
  g.add(lens)
  for (let i = 0; i < 4; i++) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(40, 0.6, 14), standard({ color: '#1a2440', metalness: 0.9, roughness: 0.25, emissive: '#3050a0', emissiveIntensity: 0.6 }))
    panel.position.set(Math.cos((i / 4) * Math.PI * 2) * 62, 0, Math.sin((i / 4) * Math.PI * 2) * 62)
    panel.rotation.y = -(i / 4) * Math.PI * 2
    g.add(panel)
  }
  const lights = new THREE.Group()
  for (let i = 0; i < 16; i++) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.9, 6, 4), glow)
    const a = (i / 16) * Math.PI * 2
    l.position.set(Math.cos(a) * 37.5, 0, Math.sin(a) * 37.5)
    lights.add(l)
  }
  g.add(lights)
  return { group: g, lens }
}

/** Sol Lance: the orbital weapon that hangs over the battlefield. */
export class Lance implements System {
  readonly root = new THREE.Group()
  private game: Game
  private station: THREE.Group
  private lens: THREE.Mesh
  readonly beam: OrbitalBeam
  hp = MAX_HP
  active = false
  alive = false
  destroyed = false
  private cooldown = 4
  private hitFlash = 0
  private target: ReflectTarget

  constructor(game: Game) {
    this.game = game
    const s = buildStation()
    this.station = s.group
    this.lens = s.lens
    this.station.position.set(160, 480, -320)
    this.station.visible = false
    this.root.add(this.station)
    this.beam = new OrbitalBeam(game, {
      color: '#ff5a3a',
      coreColor: '#ffd0c0',
      radius: 4.5,
      source: (out) => this.lens.getWorldPosition(out),
      sourceRadius: 45,
      dps: 220,
      label: 'ORBITAL STRIKE · SOL LANCE',
      onSourceHit: (dmg, dt, reflected) => this.hurt(reflected ? dmg : dmg * dt),
    })
    this.root.add(this.beam.root)
    const self = this
    this.target = {
      get alive() {
        return self.alive
      },
      radius: 40,
      aim: (out) => out.copy(self.station.position),
      struck: (dmg) => self.hurt(dmg),
    }
  }

  reset() {
    this.beam.reset()
    this.active = false
    this.alive = false
    this.destroyed = false
    this.hp = MAX_HP
    this.station.visible = false
    this.station.rotation.set(0, 0, 0)
    this.station.position.set(160, 480, -320)
  }

  /** The station drifts into position and starts firing. */
  activate() {
    this.reset()
    this.active = true
    this.alive = true
    this.station.visible = true
    this.cooldown = 3
  }

  /** Sandbox: a single strike, no station fight required. */
  strike() {
    if (!this.alive) {
      this.alive = true
      this.station.visible = true
    }
    this.beam.begin()
  }

  private hurt(dmg: number) {
    if (!this.alive) return
    this.hp -= dmg
    this.hitFlash = 1
    if (this.hp <= 0) this.explode()
  }

  private explode() {
    const g = this.game
    this.alive = false
    this.active = false
    this.destroyed = true
    this.beam.stop()
    const p = this.station.position.clone()
    g.fx.explosion(p, 60, { scorch: false, debris: false })
    for (let i = 0; i < 8; i++) g.fx.after(i * 0.18, () => g.fx.explosion(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 120, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 120)), 20 + Math.random() * 15, { scorch: false, debris: false, sound: i % 2 === 0 }))
    g.sky.flash(_v.subVectors(p, g.camera.position).normalize(), 2, '#ffd8b0')
    g.post.flashTo(0.5, '#fff0e0', 1.5)
    g.post.impactFrames([1, 2, 1, 0], 1 / 18)
    g.post.rays(p, 1.6, 2.6, '#ffd6b0')
    g.post.shock(p, g.camera, 0.045)
    g.post.shock(p, g.camera, 0.03, { delay: 0.22, speed: 1.2, width: 1.6 })
    g.post.streak(1.8, p)
    g.cam.addTrauma(0.5)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 0.2, 0.3).normalize(), p)
    g.slicer.slice([this.station], plane, {
      gravity: 8,
      separate: 25,
      spin: 0.4,
      life: 18,
      glow: 2,
      onCrash: (at) => {
        g.terrain.crater(at.x, at.z, 32, 9, { rim: 0.3, ejecta: 1 })
        g.fx.explosion(at.setY(10), 30)
      },
    })
    g.score.kill('station', 1, p)
    g.player.gainDivinity(40)
    audio.musicSting('big')
  }

  reflectTargets(out: ReflectTarget[]) {
    if (this.alive) out.push(this.target)
  }

  threats(out: Threat[]) {
    this.beam.threats(out)
  }

  bosses(out: BossBar[]) {
    if (this.alive && this.active) out.push({ id: 'lance', name: 'SOL LANCE', hp: this.hp, max: MAX_HP })
  }

  update(dt: number, rdt: number) {
    if (this.station.visible && this.alive) {
      this.station.rotation.y += dt * 0.06
      this.hitFlash = Math.max(0, this.hitFlash - dt * 3)
      ;(this.lens.material as THREE.MeshBasicMaterial).color.setRGB(5 + this.hitFlash * 20, 1.2 + this.hitFlash * 10, 0.6 + this.hitFlash * 8)
    }
    this.beam.update(dt, rdt)
    if (!this.active || !this.alive) return
    const g = this.game
    if (g.ceasefire || !g.player.alive) return
    if (!this.beam.busy) {
      this.cooldown -= dt
      if (this.cooldown <= 0) {
        this.cooldown = 7 + Math.random() * 3
        this.beam.begin()
      }
    }
  }
}
