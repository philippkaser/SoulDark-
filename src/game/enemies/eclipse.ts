import * as THREE from 'three'
import { audio } from '../../audio/audio'
import { standard } from '../../engine/gfx/materials'
import { canvasTexture } from '../../engine/gfx/textures'
import { shapeHitsSphere, type Shape } from '../../engine/geom'
import { clamp, mulberry32, smoothstep } from '../../engine/math'
import { useUI, type BossBar } from '../../state/store'
import type { Game, System } from '../Game'
import { newHitId, type Hit, type ReflectTarget, type Threat } from '../types'
import { eclipsePoint, SUN_DIR } from '../world/layout'
import { Shards } from '../fx/shards'
import { OrbitalBeam } from './beam'
import type { Projectiles } from './projectiles'

const MAX_HP = 30000
const MOON_R = 95
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()

type Stage = 'dormant' | 'rise' | 'storm' | 'moon' | 'frenzy' | 'falter' | 'finale' | 'dawn'

function moonTextures() {
  const r = mulberry32(42)
  const map = canvasTexture(1024, 512, (ctx) => {
    ctx.fillStyle = '#8a8580'
    ctx.fillRect(0, 0, 1024, 512)
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = `rgba(40,36,34,${0.25 + r() * 0.3})`
      ctx.beginPath()
      ctx.ellipse(r() * 1024, 80 + r() * 350, 40 + r() * 140, 30 + r() * 80, r() * 3, 0, Math.PI * 2)
      ctx.fill()
    }
    for (let i = 0; i < 260; i++) {
      const x = r() * 1024
      const y = r() * 512
      const s = 3 + Math.pow(r(), 3) * 40
      const g = ctx.createRadialGradient(x - s * 0.2, y - s * 0.2, 0, x, y, s)
      g.addColorStop(0, 'rgba(30,28,26,0.55)')
      g.addColorStop(0.8, 'rgba(60,56,52,0.4)')
      g.addColorStop(0.92, 'rgba(200,195,190,0.55)')
      g.addColorStop(1, 'rgba(200,195,190,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, s, 0, Math.PI * 2)
      ctx.fill()
    }
  })
  const emissive = canvasTexture(1024, 512, (ctx) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, 1024, 512)
    ctx.strokeStyle = '#ff6a20'
    for (let i = 0; i < 40; i++) {
      ctx.lineWidth = 1 + r() * 4
      let x = r() * 1024
      let y = r() * 512
      ctx.beginPath()
      ctx.moveTo(x, y)
      for (let j = 0; j < 12; j++) {
        x += (r() - 0.5) * 80
        y += (r() - 0.5) * 50
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  })
  return { map, emissive }
}

/** The Eclipse: the sky-god behind the Dominion, and the last fight. */
export class Eclipse implements System {
  readonly root = new THREE.Group()
  private game: Game
  private proj: Projectiles
  readonly beam: OrbitalBeam
  stage: Stage = 'dormant'
  t = 0
  hp = MAX_HP
  private meteorT = 0
  private aimedT = 0
  private beamT = 0
  private moon: THREE.Mesh
  private moonMat: THREE.MeshStandardMaterial
  private moonVel = new THREE.Vector3()
  private moonActive = false
  private moonReturning = false
  private moonDone = false
  /** The hero may cleave the sky. */
  finaleReady = false
  private target: ReflectTarget
  onVictory?: () => void
  private hitFlash = 0
  /** The moon cut to burning pieces. */
  private shards: Shards

  constructor(game: Game, proj: Projectiles) {
    this.game = game
    this.proj = proj
    const self = this
    this.target = {
      get alive() {
        return self.stage !== 'dormant' && self.stage !== 'dawn' && self.stage !== 'finale'
      },
      radius: 140,
      aim: (out) => eclipsePoint(out),
      struck: (dmg) => self.hurt(dmg),
    }
    this.beam = new OrbitalBeam(game, {
      color: '#ff2a1a',
      coreColor: '#ffb0a0',
      radius: 5.5,
      source: (out) => out.copy(SUN_DIR).multiplyScalar(600).add(new THREE.Vector3(0, 0, 0)),
      sourceRadius: 80,
      dps: 260,
      label: 'THE EYE OPENS',
      onSourceHit: (dmg, dt, reflected) => this.hurt(reflected ? 3500 : dmg * dt * 1.6),
    })
    this.root.add(this.beam.root)
    const tex = moonTextures()
    this.moonMat = standard({ color: '#ffffff', map: tex.map, roughness: 0.95, emissive: '#ffffff', emissiveMap: tex.emissive, emissiveIntensity: 0, rim: 0.4, rimColor: '#ff8a50' })
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_R, 64, 32), this.moonMat)
    this.moon.visible = false
    this.moon.castShadow = true
    this.root.add(this.moon)
    this.shards = new Shards(game, tex.map)
    this.root.add(this.shards.root)
  }

  reset() {
    this.stage = 'dormant'
    this.t = 0
    this.hp = MAX_HP
    this.beam.reset()
    this.moon.visible = false
    this.moonActive = false
    this.moonReturning = false
    this.moonDone = false
    this.finaleReady = false
    this.shards.clear()
  }

  get alive() {
    return this.stage !== 'dormant' && this.stage !== 'dawn'
  }

  awaken() {
    this.reset()
    this.stage = 'rise'
    this.t = 0
    audio.roar(_v.copy(SUN_DIR).multiplyScalar(300), 0.4)
    useUI.getState().showBanner({ kind: 'boss', title: 'THE ECLIPSE', sub: 'The thing behind the sun opens its eye' })
  }

  /** The falling moon, while it can still be struck (the sword arts draw their cuts onto it). */
  get moonTarget(): THREE.Vector3 | null {
    return this.moonActive && !this.moonReturning ? this.moon.position : null
  }

  /** Sandbox: drop the moon right now. */
  dropMoon() {
    if (this.moonActive) return
    this.moonDone = false
    this.sandboxMoon = this.stage === 'dormant'
    this.startMoon()
  }

  /** The moon was summoned on its own: afterwards the sky goes quiet again. */
  private sandboxMoon = false

  private afterMoon() {
    if (this.sandboxMoon) {
      this.sandboxMoon = false
      this.stage = 'dormant'
      this.hp = MAX_HP
      return
    }
    this.stage = 'frenzy'
    this.t = 0
    if (this.hp <= MAX_HP * 0.08) this.falter()
  }

  /** Sandbox: a meteor shower. */
  shower() {
    for (let i = 0; i < 10; i++) this.game.fx.after(i * 0.25, () => this.meteor(i % 3 === 0))
  }

  reflectTargets(out: ReflectTarget[]) {
    if (this.target.alive) out.push(this.target)
  }

  bosses(out: BossBar[]) {
    if (this.alive && !this.sandboxMoon && this.stage !== 'finale') out.push({ id: 'eclipse', name: 'THE ECLIPSE', hp: Math.max(0, this.hp), max: MAX_HP })
  }

  threats(out: Threat[]) {
    this.beam.threats(out)
    if (this.moonActive && !this.moonReturning) {
      const chest = this.game.player.chestPos(_w)
      const d = this.moon.position.distanceTo(chest) - MOON_R - 8
      out.push({ pos: this.moon.position.clone(), eta: d / Math.max(1, this.moonVel.length()), tier: 'cosmic', label: 'THE MOON' })
    }
  }

  /** The Heaven Splitter and the Worldsplitter cut the moon in half; the Iai cuts it to pieces. */
  damage(shape: Shape, hit: Hit): number {
    if (!this.moonActive || this.moonReturning || !hit.friendly) return 0
    if (hit.kind !== 'heaven' && hit.kind !== 'judgment' && hit.kind !== 'iai') return 0
    if (!shapeHitsSphere(shape, this.moon.position.x, this.moon.position.y, this.moon.position.z, MOON_R)) return 0
    if (hit.kind === 'iai') {
      this.shatterMoon(_w.subVectors(this.moon.position, hit.origin).setY(0).normalize())
      return 1
    }
    if (hit.dmg < 1800) {
      this.game.fx.impact(this.moon.position.clone().setY(this.moon.position.y - MOON_R), null, 8, '#ffd8a0')
      useUI.getState().stamp('NOT ENOUGH. CHARGE IT FULLY.', 'warn')
      return 1
    }
    this.cleaveMoon(hit.plane ?? new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 0, 0), this.moon.position))
    return 1
  }

  hurt(dmg: number) {
    if (!this.alive || this.sandboxMoon || this.stage === 'finale' || this.stage === 'falter') return
    this.hp -= dmg
    this.hitFlash = 1
    this.game.sky.flash(SUN_DIR, Math.min(1.2, 0.3 + dmg / 4000), '#ff6040')
    if (this.hp <= MAX_HP * 0.6 && !this.moonDone && !this.moonActive && this.stage === 'storm') this.startMoon()
    if (this.hp <= MAX_HP * 0.08) this.falter()
  }

  private falter() {
    this.stage = 'falter'
    this.t = 0
    if (this.moonActive) {
      // the eye loses its grip: the moon crumbles mid-fall
      this.moonActive = false
      this.moonDone = true
      this.moon.visible = false
      this.game.fx.explosion(this.moon.position.clone(), 90, { scorch: false, debris: false })
      this.game.sky.flash(SUN_DIR, 1.5, '#fff0d0')
    }
    this.hp = Math.max(1, this.hp)
    this.finaleReady = true
    this.beam.stop()
    this.game.player.divinity = 100
    this.game.ceasefire = true
    useUI.getState().showBanner({ kind: 'boss', title: 'THE ECLIPSE FALTERS', sub: 'Press Q · Cleave the sky' })
    audio.musicSting('big')
  }

  private meteor(aimed: boolean) {
    const g = this.game
    const p = g.player.pos
    const from = _v.copy(SUN_DIR).multiplyScalar(520).add(new THREE.Vector3((Math.random() - 0.5) * 160, Math.random() * 60, (Math.random() - 0.5) * 80)).clone()
    const to = aimed ? p.clone().setY(1.3) : new THREE.Vector3(p.x + (Math.random() - 0.5) * 120, 0, p.z + (Math.random() - 0.5) * 120)
    const size = aimed ? 2.6 : 2 + Math.random() * 4
    this.proj.meteor(from, to, size, aimed ? 110 : 130, this.target, aimed)
  }

  private startMoon() {
    const g = this.game
    this.stage = 'moon'
    this.moonActive = true
    this.moonReturning = false
    this.moon.visible = true
    this.moon.scale.setScalar(1)
    this.moon.position.copy(SUN_DIR).multiplyScalar(900).setY(520)
    const p = g.player.pos
    _v.set(p.x, MOON_R + 4, p.z)
    this.moonVel.subVectors(_v, this.moon.position).divideScalar(16)
    this.moonMat.emissiveIntensity = 0
    useUI.getState().showBanner({ kind: 'warning', title: 'THE MOON FALLS', sub: 'Parry it home, or charge the Heaven Splitter and cut it in two' })
    audio.roar(this.moon.position, 0.3)
    g.cam.addTrauma(0.4)
  }

  private cleaveMoon(plane: THREE.Plane) {
    const g = this.game
    this.moonActive = false
    this.moonDone = true
    const at = this.moon.position.clone()
    g.slicer.slice([this.moon], plane, {
      gravity: 5,
      separate: 55,
      vel: this.moonVel.clone().multiplyScalar(0.25).setY(-12),
      spin: 0.08,
      life: 26,
      glow: 3,
      onCrash: (p) => {
        g.terrain.crater(p.x, p.z, 60, 14, { rim: 0.3, ejecta: 1, jag: 0.12 })
        g.fx.nuke(p.setY(0), 0.8)
        g.cam.addTrauma(0.8)
        audio.nukeShock()
        g.gust(p, 10)
      },
    })
    g.time.slowmo(2.2, 0.25)
    g.post.flashTo(0.7, '#fff2d8', 1.5)
    g.post.impactFrames([1, 2, 1, 2, 1, 0], 1 / 16)
    // light floods out between the halves
    g.post.rays(at, 1.5, 3, '#fff0d0')
    g.post.streak(1.4, at)
    g.cam.dolly(18, 2.2)
    g.sky.flash(_v.subVectors(at, g.camera.position).normalize(), 1.5, '#fff0d0')
    g.score.kill('moon', 1, at)
    useUI.getState().stamp('THE MOON, CLEAVED', 'divine')
    useUI.getState().clearBanner()
    audio.cut(at, true)
    audio.skySplit()
    this.hp -= MAX_HP * 0.25
    this.afterMoon()
  }

  /** The Iai's click: the moon falls apart into burning chunks, flung on along the cut. */
  private shatterMoon(dir: THREE.Vector3) {
    const g = this.game
    this.moonActive = false
    this.moonDone = true
    this.moon.visible = false
    const at = this.moon.position.clone()
    this.shards.burst(at, MOON_R, dir, this.moonVel)
    g.fx.explosion(at, 40, { scorch: false, debris: false })
    g.time.slowmo(1.8, 0.3)
    g.post.impactFrames([2, 1, 0], 1 / 16)
    g.post.flashTo(0.18, '#fff0d8', 2)
    g.post.rays(at, 0.8, 2.5, '#ffd8a0')
    g.post.streak(1, at)
    g.cam.dolly(16, 2)
    g.cam.addTrauma(0.8)
    g.sky.flash(_v.subVectors(at, g.camera.position).normalize(), 1.2, '#ffd0a0')
    g.score.kill('moon', 1, at)
    useUI.getState().stamp('THE MOON, IN PIECES', 'divine')
    useUI.getState().clearBanner()
    audio.nukeShock()
    this.hp -= MAX_HP * 0.25
    this.afterMoon()
  }

  /** Q while faltering: the last cut. */
  finale() {
    if (!this.finaleReady) return
    this.finaleReady = false
    this.stage = 'finale'
    this.t = 0
    const g = this.game
    const pl = g.player
    pl.state = 'cine'
    pl.cineClip = 'iai'
    pl.cineT = 0
    g.ceasefire = true
    g.time.stop(false)
    audio.timeStop()
    useUI.getState().clearBanner()
    const start = pl.pos.clone()
    const crackN = new THREE.Vector3().crossVectors(SUN_DIR, new THREE.Vector3(0.35, 1, 0.1)).normalize()
    g.sky.u.uCrackN.value.copy(crackN)
    g.sky.u.uCrackA.value.copy(new THREE.Vector3().crossVectors(crackN, SUN_DIR).normalize())
    let slashed = false
    let rose = false
    let storm2 = false
    g.cam.play({
      dur: 14,
      blendIn: 0.5,
      blendOut: 1.5,
      frame: (t, pos, look) => {
        // rise
        const rise = smoothstep(0.8, 2.6, t) * (1 - smoothstep(5.5, 10, t))
        pl.pos.set(start.x, start.y + rise * 260, start.z)
        pl.cineT = t
        pl.cineClip = t < 0.8 ? 'iai' : t < 2.4 ? 'dive' : t < 3.4 ? 'slash4' : t < 9.5 ? 'fall' : 'victory'
        if (t > 2.4) pl.cineT = t - 2.4
        if (t > 9.5) pl.cineT = t - 9.5
        if (t > 0.8 && t < 2.6 && Math.random() < 0.5) g.fx.afterimage('#ffe0a0', 0.5, 0.9)
        // the hero ignites as he leaves the ground, and the sky answers with a storm around him
        if (t >= 0.8 && !rose) {
          rose = true
          g.aura.flare(1.4)
          g.lightning.storm(start, 14, 34, 1.2, { color: 'white', width: 0.7, sparks: false })
          g.lightning.fan(pl.chestPos(_v), _w.set(0, 1, 0), 6, 14, 1.1, { color: 'white', width: 0.14, light: false, sparks: false })
          g.rumble(0.8, 0.6, 900)
        }
        if (t >= 1.6 && !storm2) {
          storm2 = true
          g.aura.flare(0.6, '#fff4dc', false)
          g.lightning.fan(pl.chestPos(_v), _w.set(0, -1, 0), 8, 60, 0.5, { color: 'white', width: 0.5, life: 0.4, sparks: false })
        }
        if (t >= 2.6 && !slashed) {
          slashed = true
          this.skyCut()
        }
        const sky = SUN_DIR.clone()
        if (t < 2.6) {
          pos.copy(start).add(new THREE.Vector3(6, 2 + rise * 200, 10))
          look.copy(pl.pos).add(new THREE.Vector3(0, 2, 0))
          return 55
        }
        // behind the hero, the broken sky ahead
        pos.copy(pl.pos).addScaledVector(sky, -18).add(new THREE.Vector3(3, -4, 0))
        look.copy(pl.pos).addScaledVector(sky, 100)
        return 62
      },
    })
  }

  private skyCut() {
    const g = this.game
    audio.skySplit()
    audio.musicSting('big')
    audio.duck(0.8, 3)
    g.post.impactFrames([1, 2, 1, 2, 1, 2, 0], 1 / 14)
    // the light of the dawn pours through the crack past the hero: shafts and a vertigo pull, not a white screen
    g.post.flashTo(0.55, '#fff6e8', 1.4)
    g.post.rays(_v.copy(g.player.pos).addScaledVector(SUN_DIR, 400), 1.6, 4, '#fff0d8')
    g.post.streak(1.2)
    g.post.sunRays = 1.6
    g.cam.dolly(26, 2.4)
    g.cam.addTrauma(1)
    g.aura.flare(1, '#fff4dc', false)
    g.rumble(1, 1, 1500)
    this.stage = 'dawn'
    this.t = 0
    this.hp = 0
    this.beam.stop()
    g.score.kill('eclipse', 1, eclipsePoint(_v))
    audio.music('victory', 0)
  }

  update(dt: number, rdt: number) {
    const g = this.game
    this.t += dt
    this.beam.update(dt, rdt)
    // the pieces of a cut-up moon fall whatever the eclipse is doing (the sandbox moon leaves it dormant)
    this.shards.update(dt)
    const sky = g.sky.u
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2)
    this.sunShafts(rdt)
    switch (this.stage) {
      case 'dormant':
        return
      case 'rise':
        sky.uEye.value = smoothstep(0, 4, this.t)
        sky.uDoom.value = smoothstep(0, 4, this.t)
        if (this.t > 4) {
          this.stage = 'storm'
          this.t = 0
        }
        break
      case 'storm':
      case 'frenzy': {
        const fr = this.stage === 'frenzy' ? 1.7 : 1
        if (g.ceasefire || !g.player.alive) break
        this.meteorT -= dt * fr
        if (this.meteorT <= 0) {
          this.meteorT = 1.5
          for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) this.meteor(false)
        }
        this.aimedT -= dt * fr
        if (this.aimedT <= 0) {
          this.aimedT = 4.5
          this.meteor(true)
        }
        this.beamT -= dt * fr
        if (this.beamT <= 0 && !this.beam.busy) {
          this.beamT = 15
          this.beam.begin()
        }
        break
      }
      case 'moon':
        if (!this.moonActive) {
          this.stage = 'frenzy'
          this.t = 0
        }
        break
      case 'falter':
        sky.uEye.value = 0.6 + Math.sin(this.t * 6) * 0.1
        break
      case 'finale':
        break
      case 'dawn': {
        sky.uCrack.value = clamp(this.t / 0.6, 0, 1)
        sky.uSplit.value = smoothstep(0.8, 3.5, this.t)
        sky.uShatter.value = smoothstep(1, 3, this.t)
        sky.uEye.value = Math.max(0, 1 - this.t)
        sky.uDawn.value = smoothstep(2.5, 7, this.t)
        sky.uDoom.value = 1 - smoothstep(1, 5, this.t)
        if (this.t > 3 && this.t - dt <= 3) g.fx.ring(g.player.pos.clone().setY(0.1), 200, '#fff2d0', 4, { thick: 0.05 })
        if (this.t > 9.5 && this.t - dt <= 9.5) {
          const pl = g.player
          pl.pos.y = g.terrain.heightAt(pl.pos.x, pl.pos.z)
          pl.state = 'victory'
          pl.t = 0
          g.fx.groundShock(pl.pos.clone(), 18, '#fff0c0', false)
        }
        if (this.t > 12 && this.t - dt <= 12) this.onVictory?.()
        // light washes back over the world
        g.sun.intensity = 2.2 + smoothstep(2, 8, this.t) * 2.5
        g.sun.color.lerpColors(new THREE.Color('#ffb27a'), new THREE.Color('#fff2dc'), smoothstep(2, 8, this.t))
        g.fill.color.lerpColors(new THREE.Color('#5a3a66'), new THREE.Color('#b8b0d0'), smoothstep(2, 8, this.t))
        break
      }
    }
    if (this.stage !== 'dawn') sky.uFlash.value = Math.max(sky.uFlash.value, this.hitFlash * 0.5)
    this.updateMoon(dt)
  }

  /** The corona's light shafts dim while the moon or the Eye's beam stands in front of the sun; the dawn's burst fades back. */
  private sunShafts(rdt: number) {
    const g = this.game
    let want = 1
    if (this.moonActive && this.moon.visible) {
      _v.subVectors(this.moon.position, g.camera.position)
      const d = Math.max(1, _v.length())
      const r = Math.atan(MOON_R / d)
      want = 0.2 + 0.8 * smoothstep(r * 0.7, r * 1.6 + 0.04, _v.normalize().angleTo(SUN_DIR))
    }
    if (this.beam.busy) want = Math.min(want, 0.5)
    if (this.stage === 'dawn') want = 1 + 0.6 * (1 - smoothstep(0.5, 4, this.t))
    g.post.sunRays += (want - g.post.sunRays) * Math.min(1, rdt * 5)
  }

  private updateMoon(dt: number) {
    if (!this.moonActive) return
    const g = this.game
    const pl = g.player
    const m = this.moon
    m.rotation.y += dt * 0.05
    if (this.moonReturning) {
      // batted back into the eye
      eclipsePoint(_v)
      _w.subVectors(_v, m.position)
      const d = _w.length()
      m.position.addScaledVector(_w.normalize(), Math.min(d, dt * 420))
      if (d < 150) {
        this.moonActive = false
        this.moonDone = true
        m.visible = false
        g.sky.flash(SUN_DIR, 2.5, '#ffffff')
        g.post.flashTo(0.8, '#fff6e8', 1.2)
        g.cam.addTrauma(0.6)
        audio.nukeShock()
        this.hp -= MAX_HP * 0.35
        g.score.kill('moon', 1, _v)
        useUI.getState().stamp('THE MOON, RETURNED', 'divine')
        this.afterMoon()
      }
      return
    }
    // descend toward the hero, steering as they move
    _v.set(pl.pos.x, MOON_R + 4, pl.pos.z)
    _w.subVectors(_v, m.position)
    const speed = this.moonVel.length()
    this.moonVel.lerp(_w.normalize().multiplyScalar(Math.max(speed, 30)), Math.min(1, dt * 0.25))
    m.position.addScaledVector(this.moonVel, dt)
    const chest = pl.chestPos(_w)
    const dist = m.position.distanceTo(chest) - MOON_R
    this.moonMat.emissiveIntensity = clamp(3 - dist / 120, 0, 4)
    // atmospheric entry
    const n = Math.round(dt * 80 * g.q)
    for (let i = 0; i < n; i++) {
      _v.set(Math.random() - 0.5, -0.6 - Math.random() * 0.4, Math.random() - 0.5).normalize().multiplyScalar(MOON_R * 1.02).add(m.position)
      g.fx.fire.spawn(_v, _w.set(0, 20, 0), [1, 0.5, 0.2], 0.8, 18 + Math.random() * 20, 0.8, 0, 1, { grow: 1 })
    }
    g.cam.addTrauma(dt * clamp(1.5 - dist / 300, 0, 1.2))
    g.framing = clamp((400 - dist) / 40, 0, 6)
    if (dist < 8) {
      g.framing = 0
      const r = pl.untouchable ? 'none' : pl.defend('cosmic', m.position)
      if (r === 'perfect') {
        this.moonReturning = true
        useUI.getState().clearBanner()
        g.time.slowmo(1.5, 0.3)
        return
      }
      // it lands
      this.moonActive = false
      this.moonDone = true
      m.visible = false
      // it lands: a crater a hundred and fifty metres across, with the hero at the bottom
      g.terrain.crater(pl.pos.x, pl.pos.z, 75, 14, { rim: 0.32, ejecta: 1, jag: 0.12 })
      g.fx.nuke(pl.pos.clone(), 0.7)
      g.post.flashTo(1, '#fff2e0', 0.7)
      if (!pl.untouchable) pl.hurt(r === 'guard' ? 450 : 850, m.position, 30)
      g.damage({ t: 'sphere', c: pl.pos.clone(), r: 160 }, { id: newHitId(), kind: 'blast', dmg: 99999, power: 60, origin: pl.pos.clone(), friendly: true })
      useUI.getState().stamp('YOU SURVIVED THE MOON', 'feat')
      useUI.getState().clearBanner()
      this.afterMoon()
    }
  }
}
