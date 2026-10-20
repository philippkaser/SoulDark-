import { audio } from '../audio/audio'
import { useUI } from '../state/store'
import type { Airships } from './enemies/airships'
import type { Artillery } from './enemies/artillery'
import type { Citadel } from './enemies/citadel'
import type { Eclipse } from './enemies/eclipse'
import type { Horde } from './enemies/horde'
import type { Lance } from './enemies/lance'
import type { Projectiles } from './enemies/projectiles'
import type { Titans } from './enemies/titan'
import type { Game } from './Game'

export interface Forces {
  horde: Horde
  proj: Projectiles
  artillery: Artillery
  airships: Airships
  titans: Titans
  lance: Lance
  citadel: Citadel
  eclipse: Eclipse
}

interface WaveDef {
  name: string
  sub: string
  tip: string
  boss?: boolean
  setup(): void
  tick?(dt: number): void
  objective(): string | null
  done(): boolean
}


/** The campaign: eight escalating trials, ending with the sky itself. */
export class Campaign {
  wave = 0
  private game: Game
  private f: Forces
  private waves: WaveDef[]
  private phase: 'intro' | 'fight' | 'cleared' | 'won' = 'intro'
  private t = 0
  private reinforceT = 0
  private archersSpawned = 0
  private nukeT = 0
  private neutralized = 0
  startedAt = 0

  constructor(game: Game, f: Forces) {
    this.game = game
    this.f = f
    f.proj.onWarheadNeutralized = () => this.neutralized++
    f.proj.onWarheadReturned = () => this.neutralized++
    this.waves = this.build()
  }

  get count() {
    return this.waves.length
  }

  get waveName() {
    return this.waves[this.wave]?.name ?? ''
  }

  /** Legions come from the north, spread across the horizon. */
  private legion(rows: number, cols: number, archers = 0, spread = 1.2) {
    const a = Math.PI + (Math.random() - 0.5) * spread
    const d = 150 + Math.random() * 40
    const p = this.game.player.pos
    return this.f.horde.spawnLegion({ x: p.x + Math.sin(a) * d, z: p.z + Math.cos(a) * d, rows, cols, archers })
  }

  private build(): WaveDef[] {
    const { horde, artillery, airships, titans, lance, citadel, eclipse, proj } = this.f
    return [
      {
        name: 'THE LEGION',
        sub: 'Ten thousand spears. One blade.',
        tip: 'LMB slash · Shift flash-step · Space leap, Space again to dive',
        setup: () => {
          for (let i = 0; i < 3; i++) this.legion(9, 12)
          this.reinforceT = 14
        },
        tick: (dt) => {
          this.reinforceT -= dt
          if (this.reinforceT <= 0 && horde.killed < 380 && horde.alive < 220) {
            this.reinforceT = 10
            this.legion(8, 12)
          }
        },
        objective: () => `Annihilate the Legion · ${Math.min(horde.killed, 450)}/450`,
        done: () => horde.killed >= 450,
      },
      {
        name: 'ARROWSTORM',
        sub: 'They will darken the sky. Return it to them.',
        tip: 'RMB at the moment of impact: a PERFECT PARRY returns every arrow',
        setup: () => {
          this.archersSpawned = 0
          for (let i = 0; i < 2; i++) this.archersSpawned += Math.round(this.legion(10, 12, 0.45, 0.9) * 0.45)
          this.legion(8, 10)
          horde.volleyIn = 4
          horde.volleyEvery = 6.5
        },
        tick: (dt) => {
          this.reinforceT -= dt
          if (this.reinforceT <= 0 && horde.alive < 150) {
            this.reinforceT = 12
            this.legion(7, 10)
          }
        },
        objective: () => `Silence the archers · ${Math.min(horde.archersKilled, this.archersSpawned)}/${this.archersSpawned}`,
        done: () => horde.archersKilled >= this.archersSpawned * 0.92,
      },
      {
        name: 'IRON THUNDER',
        sub: 'The guns on the ridge have found you.',
        tip: 'Parry a shell while aiming at a cannon to choose where it lands',
        setup: () => {
          artillery.deploy(5)
          this.legion(8, 10)
          this.reinforceT = 15
        },
        tick: (dt) => {
          this.reinforceT -= dt
          if (this.reinforceT <= 0 && horde.alive < 120) {
            this.reinforceT = 15
            this.legion(7, 10, 0.3)
          }
        },
        objective: () => `Silence the artillery · ${artillery.destroyed}/5`,
        done: () => artillery.count === 0,
      },
      {
        name: 'THE SKYFLEET',
        sub: 'Iron whales, and every one of them armed.',
        tip: 'Parry missiles back into the ships · hold E for the Heaven Splitter',
        setup: () => {
          airships.deploy(4)
          this.legion(8, 10)
          this.reinforceT = 18
        },
        tick: (dt) => {
          this.reinforceT -= dt
          if (this.reinforceT <= 0 && horde.alive < 100) {
            this.reinforceT = 18
            this.legion(7, 10, 0.3)
          }
        },
        objective: () => `Down the Skyfleet · ${airships.downed}/4`,
        done: () => airships.count === 0 && airships.downed >= 4,
      },
      {
        name: 'THE COLOSSUS',
        sub: 'A mountain that learned to walk, and to hate.',
        tip: 'Parry its blade to bring it to its knees · leap over the sweep',
        boss: true,
        setup: () => {
          titans.spawn(0, -130)
          this.legion(6, 10)
          this.reinforceT = 25
        },
        tick: (dt) => {
          this.reinforceT -= dt
          if (this.reinforceT <= 0 && horde.alive < 60) {
            this.reinforceT = 25
            this.legion(6, 10)
          }
        },
        objective: () => null,
        done: () => titans.felled >= 1,
      },
      {
        name: 'SOL LANCE',
        sub: 'They built a sun to kill you.',
        tip: 'Hold RMB inside the beam to CATCH it · aim it at the station',
        boss: true,
        setup: () => {
          lance.activate()
          airships.deploy(2)
          this.legion(8, 10)
          this.reinforceT = 20
        },
        tick: (dt) => {
          this.reinforceT -= dt
          if (this.reinforceT <= 0 && horde.alive < 100) {
            this.reinforceT = 20
            this.legion(8, 10, 0.25)
          }
        },
        objective: () => null,
        done: () => lance.destroyed,
      },
      {
        name: 'DOCTRINE OF ANNIHILATION',
        sub: 'The Dominion opens its silos.',
        tip: 'PERFECT PARRY a warhead to send it home',
        boss: true,
        setup: () => {
          citadel.engaged = true
          artillery.deploy(3)
          this.legion(8, 12)
          this.nukeT = 6
          this.neutralized = 0
          this.reinforceT = 15
        },
        tick: (dt) => {
          const inFlight = proj.active.some((p) => p.kind === 'nuke' && p.alive)
          if (!inFlight && !this.game.cam.cinematic) this.nukeT -= dt
          if (this.nukeT <= 0 && citadel.silosLeft > 0) {
            this.nukeT = 18
            citadel.launch()
          }
          this.reinforceT -= dt
          if (this.reinforceT <= 0 && horde.alive < 120) {
            this.reinforceT = 14
            this.legion(8, 12, 0.2)
          }
        },
        objective: () => `Return the warheads · silos remaining ${citadel.silosLeft}/3`,
        done: () => (citadel.silosLeft === 0 || this.neutralized >= 6) && !proj.active.some((p) => p.kind === 'nuke' && p.alive) && !this.game.cam.cinematic,
      },
      {
        name: 'THE ECLIPSE',
        sub: 'The sun was never dead. It was watching.',
        tip: 'Parry the meteors into the Eye · when it falters, press Q',
        boss: true,
        setup: () => {
          citadel.engaged = false
          eclipse.awaken()
          eclipse.onVictory = () => this.victory()
          this.legion(6, 10)
        },
        objective: () => null,
        done: () => false,
      },
    ]
  }

  reset() {
    this.phase = 'intro'
    this.t = 0
  }

  start() {
    this.wave = 0
    this.startedAt = this.game.clock
    this.begin()
  }

  /** Restart the current wave after a defeat. */
  retry() {
    const w = this.wave
    this.game.resetWorld()
    this.game.mode = 'campaign'
    this.wave = w
    this.begin()
  }

  /** Start at a chosen wave (continue from the save). */
  startAt(w: number) {
    this.wave = Math.max(0, Math.min(this.waves.length - 1, w))
    this.startedAt = this.game.clock
    this.begin()
  }

  private begin() {
    const w = this.waves[this.wave]
    this.phase = 'intro'
    this.t = 0
    const ui = useUI.getState()
    ui.showBanner({ kind: 'wave', title: w.name, sub: `${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][this.wave]} · ${w.sub}` })
    ui.setObjective(w.tip)
    audio.warHorn()
    const save = ui.save
    if (this.wave > save.reached) ui.updateSave({ reached: this.wave })
  }

  private victory() {
    const ui = useUI.getState()
    const g = this.game
    this.phase = 'won'
    ui.updateSave({ victories: ui.save.victories + 1, bestScore: Math.max(ui.save.bestScore, g.score.points), soldiersFelled: ui.save.soldiersFelled + g.score.tally.soldiers, nukesParried: ui.save.nukesParried + g.score.tally.warheads })
    ui.setResults({ victory: true, score: g.score.points, rank: g.score.tally.bestRank, wave: this.wave, tally: { ...g.score.tally }, time: g.clock - this.startedAt })
    ui.setScreen('results')
    audio.victory()
  }

  update(dt: number, rdt: number) {
    const g = this.game
    const w = this.waves[this.wave]
    if (!w || this.phase === 'won') return
    this.t += rdt
    const ui = useUI.getState()
    if (this.phase === 'intro') {
      if (this.t > 2.6) {
        this.phase = 'fight'
        this.t = 0
        w.setup()
      }
    } else if (this.phase === 'fight') {
      w.tick?.(dt)
      const o = w.objective()
      if (this.t > 6 || o) ui.setObjective(o ?? (this.t < 6 ? w.tip : null))
      if (w.done()) {
        this.phase = 'cleared'
        this.t = 0
        ui.showBanner({ kind: 'victory', title: 'TRIAL OVERCOME', sub: `${w.name} · +${(this.wave + 1) * 5000}` })
        g.score.points += (this.wave + 1) * 5000
        g.player.hp = Math.min(g.player.maxHp, g.player.hp + g.player.maxHp * 0.5)
        g.player.gainDivinity(40)
        audio.victory()
      }
    } else if (this.phase === 'cleared') {
      if (this.t > 4.5 && this.wave < this.waves.length - 1) {
        this.wave++
        this.begin()
      }
    }
    // music: the wave sets the floor, style lifts it
    const base = w.boss ? 2 : 1
    audio.music(w.boss ? 'boss' : 'battle', Math.min(4, base + Math.floor(g.score.rank / 2) + (this.phase === 'fight' ? 0 : -1)))
  }
}
