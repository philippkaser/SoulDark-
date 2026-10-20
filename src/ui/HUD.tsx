import type { Game } from '../game/Game'

export function HUD({ game }: { game: Game }) {
  void game
  return <div className="crosshair" />
}
