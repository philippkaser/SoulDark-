import { useCallback, useEffect, useRef, useState } from 'react'
import type { Look } from '../shared/protocol'
import { audio } from './audio/audio'
import { GameCanvas } from './game/GameCanvas'
import { GameSession } from './game/session'
import { resetWorld, world } from './game/world'
import { input } from './input/input'
import { NetClient } from './net/client'
import { attachSync } from './net/sync'
import { useUI } from './state/store'
import { HUD } from './ui/HUD'
import { Menus } from './ui/Menus'
import { TitleScreen } from './ui/Title'

export function App() {
  const screen = useUI((s) => s.screen)
  const quality = useUI((s) => s.save.settings.quality)
  const [session, setSession] = useState<GameSession | null>(null)
  const sessionRef = useRef<GameSession | null>(null)
  sessionRef.current = session

  const begin = useCallback(async (name: string, look: Look, room: string, offline: boolean) => {
    const ui = useUI.getState()
    ui.setIdentity(name, look, room)
    audio.setVolume(ui.save.settings.volume, ui.save.settings.music)
    ui.setScreen('loading')
    resetWorld()
    const net = new NetClient()
    attachSync(net)
    const mode = await net.connect(name, look, room, offline)
    ui.setMode(mode, room)
    const s = new GameSession(net)
    setSession(s)
    ui.setScreen('game')
    ui.pushChat({
      name: '',
      system: true,
      text: mode === 'online' ? `You have entered the world of ${room}.` : 'No world could be reached. You walk alone.',
    })
    input.requestLock()
  }, [])

  const quit = useCallback(() => {
    const s = sessionRef.current
    if (s) {
      s.dispose()
      s.net.close()
    }
    audio.stopBossMusic(0.5)
    input.releaseLock()
    resetWorld()
    world.inGame = false
    setSession(null)
    const ui = useUI.getState()
    ui.setBoss(null)
    ui.setPrompt(null)
    ui.setMenu(null)
    ui.setScreen('title')
  }, [])

  useEffect(() => {
    const onChat = (e: Event) => {
      const text = (e as CustomEvent<string>).detail
      sessionRef.current?.net.send({ t: 'chat', text })
    }
    window.addEventListener('souldark:chat', onChat)
    return () => window.removeEventListener('souldark:chat', onChat)
  }, [])

  useEffect(() => {
    audio.titleMode = screen === 'title'
  }, [screen])

  useEffect(() => {
    // debugging / automation handle (dev builds only)
    if (import.meta.env.DEV) Object.assign(window, { __sd: { session, world, ui: useUI, input } })
  }, [session])

  return (
    <>
      <GameCanvas session={screen === 'game' ? session : null} quality={quality} />
      {screen === 'title' && <TitleScreen onBegin={begin} />}
      {screen === 'loading' && <div className="loading">Kindling the flame…</div>}
      {screen === 'game' && session && (
        <>
          <HUD session={session} />
          <Menus session={session} onQuit={quit} />
        </>
      )}
    </>
  )
}
