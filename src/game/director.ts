import { audio } from '../audio/audio'
import type { InputFrame } from '../input/input'
import { useUI } from '../state/store'
import type { Game, GameMode, System } from './Game'

export interface SpawnTable {
  /** Sandbox hotkeys 1..9, 0. */
  [key: number]: { name: string; spawn: () => void }
}

/**
 * Runs the show: the title screen's attract mode, the campaign's waves and
 * the sandbox's spawn keys.
 */
export class Director implements System {
  private game: Game
  private titleT = 0
  sandbox: SpawnTable = {}
  /** Campaign script (installed by the wave module). */
  campaign: { start(): void; update(dt: number, rdt: number): void; reset(): void; wave: number } | null = null

  constructor(game: Game) {
    this.game = game
  }

  reset() {
    this.titleT = 0
  }

  start(mode: GameMode) {
    const g = this.game
    g.resetWorld()
    g.mode = mode
    this.campaign?.reset()
    if (mode === 'title') {
      g.player.state = 'free'
      audio.music('title', 0)
      return
    }
    g.cam.stopShot()
    g.cam.snap(g.player.pos, Math.PI)
    if (mode === 'campaign') this.campaign?.start()
    else {
      g.player.godMode = false
      useUI.getState().showBanner({ kind: 'wave', title: 'SANDBOX', sub: 'Number keys summon the apocalypse. 0 grants immortality.' })
      useUI.getState().setObjective('1 Legion · 2 Arrows · 3 Artillery · 4 Airships · 5 Colossus · 6 Sol Lance · 7 NUKE · 8 Meteors · 9 The Moon')
      audio.music('battle', 1)
    }
  }

  input(f: InputFrame) {
    const g = this.game
    if (g.mode !== 'sandbox' || f.spawn < 0) return
    if (f.spawn === 0) {
      g.player.godMode = !g.player.godMode
      g.player.divinity = 100
      useUI.getState().stamp(g.player.godMode ? 'IMMORTAL' : 'MORTAL', 'feat')
      return
    }
    const s = this.sandbox[f.spawn]
    if (s) {
      s.spawn()
      useUI.getState().stamp(s.name, 'warn')
    }
  }

  update(dt: number, rdt: number) {
    const g = this.game
    if (g.mode === 'title') {
      this.titleT += rdt
      this.titleCamera()
      return
    }
    if (g.mode === 'campaign') this.campaign?.update(dt, rdt)
    if (g.mode === 'sandbox') {
      // music follows the style rank
      audio.music('battle', 1 + Math.min(3, Math.floor(g.score.rank / 2)))
    }
  }

  private titleCamera() {
    const g = this.game
    if (g.cam.cinematic) return
    const p = g.player.pos
    g.cam.play({
      dur: 1e9,
      blendIn: 0,
      blendOut: 1.2,
      frame: (t, pos, look) => {
        const a = Math.PI * 0.82 + Math.sin(t * 0.05) * 0.5
        const r = 6.5 + Math.sin(t * 0.13) * 0.8
        pos.set(p.x + Math.sin(a) * r, 1.3 + Math.sin(t * 0.17) * 0.25, p.z + Math.cos(a) * r)
        look.set(p.x - Math.sin(a) * 4, 2.6, p.z - Math.cos(a) * 4 - 6)
        return 50
      },
    })
  }
}
