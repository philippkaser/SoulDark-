import { useCallback, useEffect, useState } from 'react'
import { audio } from './audio/audio'
import type { Game } from './game/Game'
import { GameCanvas } from './game/GameCanvas'
import { input } from './input/input'
import { useUI, type Mode } from './state/store'
import { HUD } from './ui/HUD'
import { Overlays } from './ui/Overlays'
import { TitleScreen } from './ui/Title'

export function App() {
  const screen = useUI((s) => s.screen)
  const quality = useUI((s) => s.save.settings.quality)
  const [game, setGame] = useState<Game | null>(null)

  const start = useCallback(
    (mode: Mode) => {
      if (!game) return
      const ui = useUI.getState()
      audio.init()
      audio.setVolume(ui.save.settings.volume, ui.save.settings.music)
      ui.setMode(mode)
      ui.setResults(null)
      ui.setDead(false)
      ui.setPaused(false)
      ui.clearBanner()
      ui.setScreen('game')
      game.director!.start(mode)
      input.requestLock()
    },
    [game],
  )

  const quit = useCallback(() => {
    const ui = useUI.getState()
    input.releaseLock()
    ui.setPaused(false)
    ui.setDead(false)
    ui.setObjective(null)
    ui.setWarning(null)
    ui.setBosses([])
    ui.clearBanner()
    ui.setScreen('title')
    game?.director!.start('title')
  }, [game])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyH' && useUI.getState().screen === 'game') useUI.getState().setShowHelp(!useUI.getState().showHelp)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <GameCanvas quality={quality} game={game} onGame={setGame} />
      {screen === 'title' && <TitleScreen ready={!!game} onStart={start} />}
      {screen !== 'title' && game && <HUD game={game} />}
      {game && <Overlays game={game} onStart={start} onQuit={quit} />}
    </>
  )
}
