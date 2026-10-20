import { useState } from 'react'
import { audio } from '../audio/audio'
import { useUI, type Mode } from '../state/store'
import { ControlsTable, SettingsPanel } from './Overlays'

const WAVES = ['The Legion', 'Arrowstorm', 'Iron Thunder', 'The Skyfleet', 'The Colossus', 'Sol Lance', 'Doctrine of Annihilation', 'The Eclipse']

export function TitleScreen({ ready, onStart }: { ready: boolean; onStart: (m: Mode, wave?: number) => void }) {
  const save = useUI((s) => s.save)
  const [panel, setPanel] = useState<'main' | 'settings' | 'controls'>('main')
  const go = (m: Mode, wave?: number) => {
    audio.init()
    audio.ui('confirm')
    onStart(m, wave)
  }
  return (
    <div className="title-screen" onMouseDown={() => audio.init()}>
      <div className="logo">
        <div className="kicker">The end of the world has a problem</div>
        <h1>SKYCLEAVER</h1>
        <div className="tagline">Parry the apocalypse.</div>
        <p className="lore">
          An empire of iron has brought armies, artillery, airships, a colossus, an orbital sun and its nuclear doctrine against one
          swordsman. Behind it all, the eclipse is watching. It has never met anyone who could cut the sky.
        </p>
        {(save.victories > 0 || save.soldiersFelled > 0) && (
          <div className="feats">
            {save.victories > 0 && <span>{save.victories}× dawn</span>}
            {save.nukesParried > 0 && <span>{save.nukesParried} warheads returned</span>}
            {save.bestScore > 0 && <span>best {save.bestScore.toLocaleString('en-US')}</span>}
          </div>
        )}
      </div>
      <div className="menu">
        {panel === 'main' && (
          <>
            <button className="btn big" disabled={!ready} onClick={() => go('campaign')}>
              Begin the apocalypse
            </button>
            {save.reached > 0 && (
              <button className="btn ghost" disabled={!ready} onClick={() => go('campaign', save.reached)}>
                Continue · {WAVES[save.reached]}
              </button>
            )}
            <button className="btn ghost" disabled={!ready} onClick={() => go('sandbox')}>
              Sandbox · summon anything
            </button>
            <div className="split">
              <button className="btn ghost" onClick={() => setPanel('settings')}>
                Settings
              </button>
              <button className="btn ghost" onClick={() => setPanel('controls')}>
                Controls
              </button>
            </div>
            <div className="hint">Mouse + keyboard or gamepad · headphones recommended</div>
          </>
        )}
        {panel === 'settings' && (
          <>
            <SettingsPanel />
            <button className="btn ghost" onClick={() => setPanel('main')}>
              Back
            </button>
          </>
        )}
        {panel === 'controls' && (
          <>
            <ControlsTable />
            <button className="btn ghost" onClick={() => setPanel('main')}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  )
}
