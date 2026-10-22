import type * as THREE from 'three'
import type { Quality } from '../state/settings'
import { Director } from './director'
import { Airships } from './enemies/airships'
import { Arrows } from './enemies/arrows'
import { Artillery } from './enemies/artillery'
import { Citadel } from './enemies/citadel'
import { Eclipse } from './enemies/eclipse'
import { ARCHER, Horde } from './enemies/horde'
import { Lance } from './enemies/lance'
import { Projectiles } from './enemies/projectiles'
import { Titans } from './enemies/titan'
import { Game } from './Game'
import { Campaign, type Forces } from './waves'

/** Build the game with every system wired in. */
export function createGame(quality: Quality, camera: THREE.PerspectiveCamera) {
  const game = new Game(quality, camera)
  const director = new Director(game)
  game.director = director
  const cap = quality === 'high' ? 2200 : quality === 'medium' ? 1400 : 800
  const horde = new Horde(game, cap)
  const arrows = new Arrows(game, horde, Math.round(cap * 0.6))
  const proj = new Projectiles(game)
  const artillery = new Artillery(game, proj)
  const airships = new Airships(game, proj)
  const titans = new Titans(game)
  const lance = new Lance(game)
  const citadel = new Citadel(game, proj)
  const eclipse = new Eclipse(game, proj)
  for (const s of [horde, arrows, proj, artillery, airships, titans, lance, citadel, eclipse, director]) game.add(s)
  // the sword arts' effects run on the world clock
  game.add(game.player.arts)
  const forces: Forces = { horde, proj, artillery, airships, titans, lance, citadel, eclipse }
  game.forces = forces
  director.campaign = new Campaign(game, forces)

  // Q during the Eclipse's last breath cleaves the sky instead of Judgment
  game.onUltimate = () => {
    if (!eclipse.finaleReady) return false
    eclipse.finale()
    return true
  }

  const around = (d: number, spread = 1.4) => {
    const a = Math.PI + (Math.random() - 0.5) * spread
    const p = game.player.pos
    return { x: p.x + Math.sin(a) * d, z: p.z + Math.cos(a) * d }
  }
  director.sandbox = {
    1: { name: 'THE LEGION', spawn: () => horde.spawnLegion({ ...around(110), rows: 10, cols: 14 }) },
    2: {
      name: 'ARROWSTORM',
      spawn: () => {
        if (horde.archersAlive < 20) horde.spawnLegion({ ...around(70, 0.8), rows: 7, cols: 12, type: ARCHER })
        horde.volleyIn = Math.min(horde.volleyIn, 3)
      },
    },
    3: { name: 'IRON THUNDER', spawn: () => (artillery.count === 0 ? artillery.deploy(4) : (artillery.rate = 3)) },
    4: { name: 'THE SKYFLEET', spawn: () => airships.deploy(2) },
    5: {
      name: 'THE COLOSSUS',
      spawn: () => {
        const p = around(90, 0.6)
        titans.spawn(p.x, p.z)
      },
    },
    6: { name: 'SOL LANCE', spawn: () => lance.strike() },
    7: {
      name: 'NUCLEAR LAUNCH',
      spawn: () => {
        if (citadel.silosLeft === 0) citadel.reset()
        citadel.launch()
      },
    },
    8: { name: 'METEOR SHOWER', spawn: () => eclipse.shower() },
    9: { name: 'THE MOON', spawn: () => eclipse.dropMoon() },
  }

  director.start('title')
  return game
}
