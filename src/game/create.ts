import type * as THREE from 'three'
import type { Quality } from '../state/settings'
import { Director } from './director'
import { Game } from './Game'

/** Build the game with every system wired in. */
export function createGame(quality: Quality, camera: THREE.PerspectiveCamera) {
  const game = new Game(quality, camera)
  const director = new Director(game)
  game.director = director
  game.add(director)
  director.start('title')
  return game
}
