import * as THREE from 'three'
import { ALL_ENEMY_ATTACKS, PLAYER, PLAYER_ACTIONS, type PlayerActionName } from '../../shared/combat'
import { ARENA, BONFIRE, FOG_GATE, GRAVEYARD, PLAYER_SPAWN, inArena } from '../../shared/level'
import { angleDiff, clamp, dist2, wrapAngle, yawTo } from '../../shared/math'
import type { Bloodstain, ClientMsg, GroundMessage, ServerMsg, TrailSample } from '../../shared/protocol'
import { audio } from '../audio/audio'
import { input, type InputFrame } from '../input/input'
import type { NetClient } from '../net/client'
import { useUI } from '../state/store'
import { CameraController } from './camera'
import { Effects } from './fx/effects'
import { PlayerController } from './player/controller'
import { Avatar } from './rig/avatar'
import { buildBoss, buildFallen, buildHollow, buildPlayer } from './rig/models'
import { INTERP_DELAY, addShake, emitFx, world, type EnemyView, type RemotePlayerView } from './world'

interface EnemyActor {
  view: EnemyView
  avatar: Avatar
  swingKeys: Set<number>
  fxKeys: Set<string>
  lastState: string
  lastSS: number
  gone: boolean
}

interface RemoteActor {
  view: RemotePlayerView
  avatar: Avatar
  label: THREE.Sprite
  swingKey: number
}

interface Ghost {
  avatar: Avatar
  trail: TrailSample[]
  t: number
  t0: number
}

type Interact =
  | { kind: 'rest'; d: number; text: string }
  | { kind: 'fog'; d: number; text: string; yaw: number }
  | { kind: 'souls'; d: number; text: string }
  | { kind: 'read'; d: number; text: string; msg: GroundMessage }
  | { kind: 'stain'; d: number; text: string; stain: Bloodstain }

const _v = new THREE.Vector3()
const _chest = new THREE.Vector3()

function isStone(x: number, z: number) {
  if (dist2(x, z, GRAVEYARD.x, GRAVEYARD.z) < GRAVEYARD.r - 1 && Math.abs(x) > 2.4) return false
  return true
}

function nameSprite(text: string, color: string) {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 96
  const ctx = c.getContext('2d')!
  ctx.font = '600 44px "EB Garamond", Georgia, serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(0,0,0,0.9)'
  ctx.shadowBlur = 10
  ctx.fillStyle = color
  ctx.fillText(text, 256, 48)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false })
  const s = new THREE.Sprite(mat)
  s.scale.set(1.6, 0.3, 1)
  s.renderOrder = 10
  return s
}

export class GameSession {
  readonly root = new THREE.Group()
  readonly net: NetClient
  readonly player: PlayerController
  readonly playerAvatar: Avatar
  readonly cam = new CameraController()
  readonly fx = new Effects()
  private enemies = new Map<number, EnemyActor>()
  private remotes = new Map<string, RemoteActor>()
  private ghosts: Ghost[] = []
  private stateTimer = 0
  private unsub: () => void
  private interact: Interact | null = null
  private deathBannerShown = false
  private musicOn = false
  private phase2Music = false
  private time = 0
  private lastHp = 0

  constructor(net: NetClient) {
    this.net = net
    const ui = useUI.getState()
    this.player = new PlayerController(ui.save.stats, {
      send: (m: ClientMsg) => net.send(m),
      serverNow: () => net.serverNow(),
      onActionChange: () => this.sendState(),
      onDeath: () => this.onDeath(),
      onHeal: () => {
        emitFx({ kind: 'heal', p: new THREE.Vector3(this.player.x, 0, this.player.z) })
        audio.estus()
      },
    })
    this.playerAvatar = new Avatar(buildPlayer(ui.save.look))
    this.player.avatar = this.playerAvatar
    this.playerAvatar.onStep = (_f, p) => audio.footstep(p, isStone(p.x, p.z), true, this.player.sprinting ? 1.2 : 0.9)
    this.root.add(this.playerAvatar.model.container, this.fx.root)
    this.cam.snap(this.player)
    this.lastHp = this.player.hp
    this.unsub = net.on((msg) => this.onNet(msg))
  }

  dispose() {
    this.unsub()
    this.root.clear()
  }

  // -------------------------------------------------------------------------
  // Networking
  // -------------------------------------------------------------------------

  sendState() {
    const p = this.player
    this.net.send({
      t: 'st',
      x: p.x,
      y: 0,
      z: p.z,
      yaw: p.yaw,
      vx: p.vx,
      vz: p.vz,
      hp: p.hp,
      mhp: p.maxHp,
      a: p.action ?? '',
      as: p.actionStartServer,
      lk: p.lock?.id ?? -1,
      sp: p.sprinting,
    })
  }

  private onNet(msg: ServerMsg) {
    const ui = useUI.getState()
    switch (msg.t) {
      case 'kill': {
        const e = world.enemies.get(msg.id)
        if (msg.by.includes(world.localId)) {
          ui.addSouls(msg.souls)
          if (e) emitFx({ kind: 'souls', from: new THREE.Vector3(e.x, e.def.height * 0.6, e.z), count: msg.ty === 'boss' ? 160 : msg.ty === 'knight' ? 50 : 22 })
          setTimeout(() => audio.souls(), 500)
        }
        if (msg.ty === 'boss') {
          if (inArena(this.player.x, this.player.z) || msg.by.includes(world.localId)) {
            setTimeout(() => {
              audio.victory()
              useUI.getState().showBanner('GREAT ENEMY FELLED', 'victory')
            }, 1800)
            ui.updateSave({ bossKills: ui.save.bossKills + 1 })
          }
          if (this.player.lock?.id === msg.id) this.player.lock = null
        }
        return
      }
      case 'boss':
        if (msg.ev === 'reset' || msg.ev === 'defeated') {
          ui.setBoss(null)
        }
        return
      case 'msgs':
        if (msg.upd && msg.author === ui.save.name && msg.author) {
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + this.player.maxHp * 0.15)
          ui.pushChat({ name: '', text: 'Your message was appraised. Your HP has been restored.', system: true })
          audio.message()
        }
        return
    }
  }

  private onDeath() {
    const ui = useUI.getState()
    const p = this.player
    ui.updateSave({
      deaths: ui.save.deaths + 1,
      stain: ui.save.souls > 0 ? { x: p.x, z: p.z, souls: ui.save.souls } : null,
      souls: 0,
    })
    this.net.send({ t: 'died', x: p.x, z: p.z, trail: p.trail.map((s) => ({ ...s, t: s.t - (p.trail[0]?.t ?? 0) })) })
    audio.death()
    this.deathBannerShown = false
    ui.setMenu(null)
  }

  // -------------------------------------------------------------------------
  // Actors
  // -------------------------------------------------------------------------

  private syncActors() {
    for (const [id, view] of world.enemies) {
      if (this.enemies.has(id)) continue
      const model = view.type === 'boss' ? buildBoss() : view.type === 'knight' ? buildFallen() : buildHollow(id)
      const avatar = new Avatar(model)
      avatar.onStep = (_f, p) =>
        audio.footstep(p, isStone(p.x, p.z), view.type !== 'hollow', view.type === 'boss' ? 2 : view.type === 'knight' ? 1.1 : 0.7)
      this.root.add(model.container)
      this.enemies.set(id, { view, avatar, swingKeys: new Set(), fxKeys: new Set(), lastState: '', lastSS: 0, gone: false })
    }
    for (const [id, a] of this.enemies) {
      if (!world.enemies.has(id)) {
        this.root.remove(a.avatar.model.container)
        this.enemies.delete(id)
      }
    }
    for (const [id, view] of world.remotes) {
      if (this.remotes.has(id)) continue
      const avatar = new Avatar(buildPlayer(view.look, 'gold'))
      avatar.onStep = (_f, p) => audio.footstep(p, isStone(p.x, p.z), true, 0.6)
      const label = nameSprite(view.name, '#f3d58a')
      this.root.add(avatar.model.container, label)
      this.remotes.set(id, { view, avatar, label, swingKey: 0 })
    }
    for (const [id, r] of this.remotes) {
      if (!world.remotes.has(id)) {
        this.root.remove(r.avatar.model.container, r.label)
        this.remotes.delete(id)
      }
    }
  }

  private enemyClip(v: EnemyView): string | null {
    switch (v.state) {
      case 'attack':
        return v.at || null
      case 'hurt':
      case 'stagger':
      case 'parried':
      case 'riposted':
      case 'wake':
      case 'intro':
      case 'dormant':
        return v.state
      case 'dead':
        return 'death'
      case 'idle':
        return v.type === 'hollow' ? 'idle' : null
      default:
        return null
    }
  }

  private updateEnemies(dt: number, now: number) {
    const p = this.player
    for (const a of this.enemies.values()) {
      const v = a.view
      if (!v.buf.length) continue
      const isBoss = v.type === 'boss'
      // state transitions -> audio cues
      if (v.state !== a.lastState || v.ss !== a.lastSS) {
        if (v.state === 'wake') audio.groan({ x: v.x, z: v.z })
        if (v.state === 'intro') {
          audio.roar({ x: v.x, z: v.z })
          addShake(0.3)
        }
        if (v.state === 'parried' || (isBoss && v.state === 'stagger')) {
          audio.guardBreak({ x: v.x, z: v.z })
        }
        if (v.state === 'attack' && v.at === 'b_nova') audio.novaCharge({ x: v.x, z: v.z })
        a.lastState = v.state
        a.lastSS = v.ss
      }

      let dissolve = 0
      if (v.state === 'dead') {
        const t = (now - v.deathSeenAt) / 1000
        const start = isBoss ? 2.6 : 1.5
        const len = isBoss ? 3.2 : 1.6
        dissolve = clamp((t - start) / len, 0, 1)
        if (dissolve > 0 && dissolve < 1) {
          if (!a.gone && dissolve < 0.05) audio.enemyDeath({ x: v.x, z: v.z })
          emitFx({ kind: 'ash', p: new THREE.Vector3(v.x, 0.1, v.z), count: isBoss ? 14 : 4, spread: isBoss ? 1.2 : 0.4, height: v.def.height * (1 - dissolve) })
        }
        a.gone = dissolve >= 1
      } else {
        a.gone = false
      }
      a.avatar.model.container.visible = !a.gone
      if (a.gone) continue

      const clip = this.enemyClip(v)
      const atk = v.state === 'attack' ? ALL_ENEMY_ATTACKS[v.at] : null
      let trail = false
      if (atk) {
        for (const h of atk.hits) if (h.range && v.animT >= h.t0 - 0.05 && v.animT <= h.t1 + 0.04) trail = true
      }
      a.avatar.update(dt, {
        x: v.x,
        y: 0,
        z: v.z,
        yaw: v.yaw,
        speed: v.state === 'attack' || v.state === 'dead' ? 0 : v.speed,
        moveAngle: v.moveAngle,
        turnRate: 0,
        action: clip,
        actionT: v.animT,
        time: this.time + v.id,
        trail,
        flash: v.flash,
        dissolve,
      })

      if (isBoss) this.updateBossVisuals(a, dt)

      // enemy attacks vs. the local player
      if (atk && !p.dead) {
        atk.hits.forEach((h, i) => {
          const key = `${v.ss}:${i}`
          const cx = v.x + Math.sin(v.yaw) * (h.offset ?? 0)
          const cz = v.z + Math.cos(v.yaw) * (h.offset ?? 0)
          if (h.fx && v.animT >= h.t0 && !a.fxKeys.has(key)) {
            a.fxKeys.add(key)
            if (a.fxKeys.size > 40) a.fxKeys.clear()
            this.attackFx(h.fx, cx, cz, h.radius ?? 3, isBoss)
          }
          if (v.animT < h.t0 || v.animT > h.t1 || v.hitKeys.has(key)) return
          let hit = false
          if (h.aoe) {
            hit = dist2(p.x, p.z, cx, cz) <= (h.radius ?? 2) + PLAYER.radius
          } else {
            const d = dist2(v.x, v.z, p.x, p.z)
            const ang = Math.abs(angleDiff(v.yaw, yawTo(v.x, v.z, p.x, p.z)))
            hit = d <= (h.range ?? 2) + PLAYER.radius && ang <= (h.arc ?? 1) + Math.atan2(PLAYER.radius, Math.max(d, 0.1))
          }
          if (hit) {
            v.hitKeys.add(key)
            p.receiveHit(v, h, atk)
          }
        })
        if (!a.swingKeys.has(v.ss) && atk.hits.some((h) => h.range) && v.animT >= atk.hits[0].t0 - 0.14) {
          a.swingKeys.add(v.ss)
          if (a.swingKeys.size > 20) a.swingKeys.clear()
          audio.swing(isBoss ? 'boss' : 'enemy', { x: v.x, z: v.z })
        }
      }
    }
  }

  private attackFx(kind: string, x: number, z: number, radius: number, boss: boolean) {
    const p = new THREE.Vector3(x, 0, z)
    const d = dist2(x, z, this.player.x, this.player.z)
    const near = Math.max(0, 1 - d / 25)
    if (kind === 'nova') {
      emitFx({ kind: 'shockwave', p, radius, fire: true })
      audio.nova(p)
      addShake(0.4 + near * 0.6)
    } else if (kind === 'roar') {
      emitFx({ kind: 'shockwave', p, radius, color: '#ffd0a0' })
      emitFx({ kind: 'embers', p: new THREE.Vector3(x, 2.5, z), count: 120, spread: 1.5 })
      audio.roar(p)
      addShake(0.5 + near * 0.5)
    } else {
      emitFx({ kind: 'shockwave', p, radius: radius * 1.1 })
      emitFx({ kind: 'dust', p, count: boss ? 26 : 10, spread: boss ? 1.6 : 0.8 })
      audio.slam(p, kind === 'stomp' ? 0.8 : boss ? 1.4 : 1)
      addShake((boss ? 0.35 : 0.15) + near * 0.4)
    }
  }

  private updateBossVisuals(a: EnemyActor, dt: number) {
    const v = a.view
    const m = a.avatar.model
    const p2 = v.phase >= 2
    if (m.bladeFire) {
      m.bladeFire.visible = p2 && v.state !== 'dead'
      const u = (m.bladeFire.material as THREE.ShaderMaterial).uniforms
      u.uTime.value += dt
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.time * (p2 ? 5 : 2))
    const glow = (p2 ? 1.6 : 0.55) + pulse * (p2 ? 1.2 : 0.35)
    const steel = m.materials[0]
    if (steel) steel.emissiveIntensity = v.state === 'dead' ? 0.4 : glow
    if (p2 && v.state !== 'dead' && Math.random() < dt * 30) {
      m.rig.chest.getWorldPosition(_v)
      emitFx({ kind: 'embers', p: _v.clone(), count: 2, spread: 1.0 })
    }
  }

  private updateRemotes(dt: number, serverT: number) {
    for (const r of this.remotes.values()) {
      const v = r.view
      if (!v.ready) {
        r.avatar.model.container.visible = false
        r.label.visible = false
        continue
      }
      r.avatar.model.container.visible = true
      r.label.visible = true
      let action: string | null = v.action || null
      let t = (serverT - v.actionStart) / 1000
      const def = action ? PLAYER_ACTIONS[action as PlayerActionName] : null
      if (!def || t < 0 || (!def.loop && t > def.dur)) {
        action = null
        t = 0
      }
      const trail = !!def?.hit && t >= def.hit[0] - 0.06 && t <= def.hit[1] + 0.05
      if (def?.hit && action && r.swingKey !== v.actionStart && t >= def.hit[0] - 0.07) {
        r.swingKey = v.actionStart
        audio.swing(action === 'heavy' ? 'heavy' : 'light', { x: v.x, z: v.z })
      }
      const speed = action && !def?.walk ? 0 : v.speed
      r.avatar.update(dt, {
        x: v.x,
        y: v.y,
        z: v.z,
        yaw: v.yaw,
        speed,
        moveAngle: 0,
        turnRate: 0,
        action,
        actionT: t,
        time: this.time,
        trail,
        flask: action === 'estus' && t > 0.2 && t < 1.3,
      })
      r.label.position.set(v.x, 2.35, v.z)
    }
  }

  private spawnGhost(stain: Bloodstain) {
    if (!stain.trail.length) return
    const look = { cloak: 0, crest: 1 }
    const avatar = new Avatar(buildPlayer(look, 'red'))
    this.root.add(avatar.model.container)
    const t0 = stain.trail[0].t
    this.ghosts.push({ avatar, trail: stain.trail, t: t0, t0 })
    audio.message()
  }

  private updateGhosts(dt: number) {
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i]
      g.t += dt
      const tr = g.trail
      const end = tr[tr.length - 1].t
      if (g.t > end + 2.5) {
        this.root.remove(g.avatar.model.container)
        this.ghosts.splice(i, 1)
        continue
      }
      let j = 0
      while (j < tr.length - 2 && tr[j + 1].t < g.t) j++
      const a = tr[j]
      const b = tr[Math.min(j + 1, tr.length - 1)]
      const k = b.t > a.t ? clamp((g.t - a.t) / (b.t - a.t), 0, 1) : 0
      const x = a.x + (b.x - a.x) * k
      const z = a.z + (b.z - a.z) * k
      const speed = Math.hypot(b.x - a.x, b.z - a.z) / Math.max(0.05, b.t - a.t)
      // find when the current action started in the trail
      let action: string | null = a.a || null
      let at = 0
      if (action) {
        let s = j
        while (s > 0 && tr[s - 1].a === action) s--
        at = g.t - tr[s].t
      }
      if (g.t > end) {
        action = 'death'
        at = g.t - end
      }
      const def = action ? PLAYER_ACTIONS[action as PlayerActionName] : null
      if (def && !def.loop && at > def.dur) action = null
      g.avatar.update(dt, {
        x,
        y: 0,
        z,
        yaw: a.yaw + wrapAngle(b.yaw - a.yaw) * k,
        speed: action ? 0 : speed,
        moveAngle: 0,
        turnRate: 0,
        action,
        actionT: at,
        time: this.time,
        trail: !!def?.hit && at >= def.hit[0] && at <= def.hit[1],
        dissolve: g.t > end + 1.2 ? clamp((g.t - end - 1.2) / 1.2, 0, 1) : 0,
      })
    }
  }

  // -------------------------------------------------------------------------
  // Lock-on and interaction
  // -------------------------------------------------------------------------

  private pickTarget(): EnemyView | null {
    const p = this.player
    let best: EnemyView | null = null
    let bestScore = Infinity
    for (const e of world.enemies.values()) {
      if (!e.targetable || e.state === 'dormant') continue
      const d = dist2(p.x, p.z, e.x, e.z)
      if (d > (e.type === 'boss' ? 40 : 18)) continue
      const ang = Math.abs(angleDiff(world.cameraYaw, yawTo(p.x, p.z, e.x, e.z)))
      if (ang > 1.25 && d > 4) continue
      const score = ang * 4 + d * 0.15
      if (score < bestScore) {
        bestScore = score
        best = e
      }
    }
    return best
  }

  private switchTarget(dir: number) {
    const p = this.player
    const cur = p.lock
    if (!cur) return
    const rel = (e: EnemyView) => angleDiff(world.cameraYaw, yawTo(p.x, p.z, e.x, e.z))
    const base = rel(cur)
    let best: EnemyView | null = null
    let bestD = Infinity
    for (const e of world.enemies.values()) {
      if (e === cur || !e.targetable || e.state === 'dormant') continue
      if (dist2(p.x, p.z, e.x, e.z) > 20) continue
      // +dir = to the right on screen = negative relative angle
      const delta = (base - rel(e)) * dir
      if (delta <= 0.02) continue
      if (delta < bestD) {
        bestD = delta
        best = e
      }
    }
    if (best) {
      p.lock = best
      audio.lockOn()
    }
  }

  private findInteraction(): Interact | null {
    const p = this.player
    const ui = useUI.getState()
    if (p.dead || (p.action && p.action !== 'rest')) return null
    if (p.action === 'rest') return null
    const list: Interact[] = []
    const db = dist2(p.x, p.z, BONFIRE.x, BONFIRE.z)
    if (db < 2.7) list.push({ kind: 'rest', d: db, text: 'Rest at bonfire' })
    if (world.flags.fog && Math.abs(p.x - FOG_GATE.x) < FOG_GATE.halfWidth) {
      const dz = p.z - FOG_GATE.z
      if (dz > 0 && dz < 2.4) list.push({ kind: 'fog', d: dz, text: 'Traverse the white fog', yaw: Math.PI })
      else if (dz < 0 && dz > -2.4 && world.flags.boss !== 1) list.push({ kind: 'fog', d: -dz, text: 'Leave through the fog', yaw: 0 })
    }
    const st = ui.save.stain
    if (st) {
      const d = dist2(p.x, p.z, st.x, st.z)
      if (d < 1.6) list.push({ kind: 'souls', d, text: 'Retrieve lost souls' })
    }
    for (const m of world.messages) {
      const d = dist2(p.x, p.z, m.x, m.z)
      if (d < 1.4) list.push({ kind: 'read', d, text: 'Read message', msg: m })
    }
    for (const s of world.stains) {
      const d = dist2(p.x, p.z, s.x, s.z)
      if (d < 1.2) list.push({ kind: 'stain', d, text: 'Touch bloodstain', stain: s })
    }
    if (!list.length) return null
    list.sort((a, b) => a.d - b.d)
    return list[0]
  }

  private doInteract(it: Interact) {
    const ui = useUI.getState()
    const p = this.player
    switch (it.kind) {
      case 'rest': {
        p.rest()
        this.net.send({ t: 'rest' })
        if (!ui.save.bonfireLit) {
          ui.updateSave({ bonfireLit: true })
          ui.showBanner('BONFIRE LIT', 'lit')
          audio.bonfireLit()
        } else {
          audio.ui('confirm')
        }
        emitFx({ kind: 'embers', p: new THREE.Vector3(BONFIRE.x, 0.6, BONFIRE.z), count: 60, spread: 0.4 })
        ui.setMenu('bonfire')
        return
      }
      case 'fog': {
        p.teleport(clamp(p.x, -1.2, 1.2), it.yaw === Math.PI ? FOG_GATE.z + 1.6 : FOG_GATE.z - 1.6, it.yaw)
        p.start('fog', true)
        audio.fogGate()
        return
      }
      case 'souls': {
        const st = ui.save.stain!
        p.start('pickup', true)
        ui.updateSave({ souls: ui.save.souls + st.souls, stain: null })
        emitFx({ kind: 'souls', from: new THREE.Vector3(st.x, 0.5, st.z), count: 40 })
        setTimeout(() => audio.souls(), 400)
        ui.pushChat({ name: '', text: `Retrieved ${st.souls} souls.`, system: true })
        return
      }
      case 'read':
        ui.setReading(it.msg)
        ui.setMenu('read')
        audio.message()
        return
      case 'stain':
        this.spawnGhost(it.stain)
        return
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, camera: THREE.PerspectiveCamera, f: InputFrame, size: { height: number }) {
    this.time += dt
    world.inGame = true
    const now = performance.now()
    const ui = useUI.getState()
    const menuOpen = ui.menu !== null || ui.chatOpen
    const enabled = !menuOpen
    const serverT = this.net.serverNow() - INTERP_DELAY

    for (const r of world.remotes.values()) r.sample(serverT)
    for (const e of world.enemies.values()) e.sample(serverT, now, dt)
    this.syncActors()

    const p = this.player
    p.update(dt, f, world.cameraYaw, now, enabled)

    // lock-on
    if (enabled && f.lock && !p.dead) {
      if (p.lock) p.lock = null
      else {
        p.lock = this.pickTarget()
        if (!p.lock) this.cam.yaw = p.yaw
      }
      audio.lockOn()
    }
    if (enabled && p.lock && f.switchTarget) this.switchTarget(f.switchTarget)
    if (enabled && p.lock && !f.usingGamepad && Math.abs(f.lookX) > 0.09) this.switchTarget(f.lookX > 0 ? 1 : -1)

    // interactions
    this.interact = this.findInteraction()
    ui.setPrompt(this.interact && !menuOpen ? this.interact.text : null)
    if (enabled && f.interact && this.interact) this.doInteract(this.interact)

    // animate the player
    const pd = p.def
    this.playerAvatar.update(dt, {
      x: p.x,
      y: 0,
      z: p.z,
      yaw: p.yaw,
      speed: p.action && !pd?.walk && p.action !== 'fog' ? 0 : p.speed,
      moveAngle: p.moveAngle,
      turnRate: p.turnRate,
      action: p.action,
      actionT: p.actionT,
      time: this.time,
      trail: p.swinging,
      flask: p.action === 'estus' && p.actionT > 0.2 && p.actionT < 1.3,
    })
    p.postAnimate()
    world.me.x = p.x
    world.me.z = p.z
    world.me.yaw = p.yaw

    this.updateEnemies(dt, now)
    this.updateRemotes(dt, serverT)
    this.updateGhosts(dt)

    // effects
    for (const e of world.fx) this.fx.handle(e)
    world.fx.length = 0
    this.playerAvatar.getChest(_chest)
    this.fx.setViewport(size.height, camera.fov)
    this.fx.update(dt, _chest)
    world.hurtFlash = Math.max(0, world.hurtFlash - dt * 1.8)
    world.parryFlash = Math.max(0, world.parryFlash - dt * 3)

    // camera
    this.cam.update(dt, f, p, camera, enabled)

    // audio
    audio.setListener(camera.position.x, camera.position.z, world.cameraYaw)
    const arena = inArena(p.x, p.z)
    audio.update(dt, dist2(p.x, p.z, BONFIRE.x, BONFIRE.z), arena)
    const boss = [...world.enemies.values()].find((e) => e.type === 'boss')
    const wantMusic = world.flags.boss === 1 && arena && !p.dead && !!boss && boss.state !== 'dormant'
    if (wantMusic && !this.musicOn) {
      audio.startBossMusic()
      this.musicOn = true
      this.phase2Music = false
    } else if (!wantMusic && this.musicOn) {
      audio.stopBossMusic(boss?.state === 'dead' ? 4 : 2.5)
      this.musicOn = false
    }
    if (this.musicOn && boss && boss.phase >= 2 && !this.phase2Music) {
      this.phase2Music = true
      audio.bossPhase2()
    }

    // boss bar
    if (boss && world.flags.boss === 1 && boss.state !== 'dormant' && (arena || p.lock === boss) && boss.state !== 'dead') {
      ui.setBoss({ name: boss.def.name, hp: boss.hp, max: boss.mhp })
    } else if (ui.boss) {
      ui.setBoss(null)
    }

    // death and respawn
    if (p.dead) {
      const t = p.clock - p.deathAt
      if (t > 1.3 && !this.deathBannerShown) {
        this.deathBannerShown = true
        ui.showBanner('YOU DIED', 'death')
      }
      if (t > 6.2) {
        p.respawn(PLAYER_SPAWN.x, PLAYER_SPAWN.z, PLAYER_SPAWN.yaw)
        this.cam.snap(p)
        this.net.send({ t: 'rest' })
        ui.clearBanner()
      }
    }

    // network
    this.stateTimer -= dt
    if (this.stateTimer <= 0) {
      this.stateTimer = 0.05
      this.sendState()
    }
    if (p.hp !== this.lastHp) this.lastHp = p.hp
  }

  /** Title screen: idle orbit around the bonfire with the world simulating. */
  updateTitle(dt: number, camera: THREE.PerspectiveCamera, size: { height: number }) {
    this.time += dt
    const now = performance.now()
    const serverT = this.net.serverNow() - INTERP_DELAY
    for (const e of world.enemies.values()) e.sample(serverT, now, dt)
    for (const r of world.remotes.values()) r.sample(serverT)
    this.syncActors()
    this.updateEnemies(dt, now)
    this.updateRemotes(dt, serverT)
    for (const e of world.fx) this.fx.handle(e)
    world.fx.length = 0
    this.fx.setViewport(size.height, camera.fov)
    this.fx.update(dt, _chest.set(0, 1, 0))
    this.cam.title(dt, camera)
    this.playerAvatar.model.container.visible = false
    audio.setListener(camera.position.x, camera.position.z, world.cameraYaw)
    audio.update(dt, dist2(camera.position.x, camera.position.z, BONFIRE.x, BONFIRE.z) * 0.6, false)
  }

  showPlayer() {
    this.playerAvatar.model.container.visible = true
    world.cameraYaw = this.player.yaw
    this.cam.snap(this.player)
  }

  /** Expose for the HUD. */
  get arena() {
    return ARENA
  }
}

export { input }
