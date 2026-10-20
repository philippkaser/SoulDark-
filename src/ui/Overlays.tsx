import type { Game } from '../game/Game'
import type { Mode } from '../state/store'

export function Overlays({ game, onStart, onQuit }: { game: Game; onStart: (m: Mode) => void; onQuit: () => void }) {
  void game
  void onStart
  void onQuit
  return null
}
