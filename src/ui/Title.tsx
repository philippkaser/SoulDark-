import { useEffect, useState } from 'react'
import { CLOAK_COLORS, CLOAK_NAMES, type Look } from '../../shared/protocol'
import { audio } from '../audio/audio'
import { useUI } from '../state/store'
import { ControlsTable, SettingsPanel } from './Menus'

const CRESTS = ['Plume', 'Bare', 'Horns', 'Crown']

interface ServerStatus {
  online: boolean
  players: number
}

export function TitleScreen({ onBegin }: { onBegin: (name: string, look: Look, room: string, offline: boolean) => void }) {
  const save = useUI((s) => s.save)
  const [name, setName] = useState(save.name || '')
  const [look, setLook] = useState<Look>(save.look)
  const [room, setRoom] = useState(save.room || 'lordran')
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [panel, setPanel] = useState<'main' | 'settings' | 'controls'>('main')

  useEffect(() => {
    let alive = true
    const check = () =>
      fetch('/api/status')
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((j: { worlds: Array<{ name: string; players: number }> }) => {
          if (!alive) return
          const w = j.worlds.find((x) => x.name === room.toLowerCase())
          setStatus({ online: true, players: w?.players ?? 0 })
        })
        .catch(() => alive && setStatus({ online: false, players: 0 }))
    check()
    const id = setInterval(check, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [room])

  const begin = (offline: boolean) => {
    audio.init()
    audio.ui('confirm')
    onBegin(name.trim() || 'Unkindled', look, room.trim() || 'lordran', offline)
  }

  return (
    <div className="title-screen" onMouseDown={() => audio.init()}>
      <div className="logo">
        <h1>SOULDARK</h1>
        <div className="sub">Fear not the dark</div>
        <div className="lore">
          The fire fades, and the eclipse hangs over the old cathedral. Beyond the white fog, the Ashen Warden still keeps
          his oath. Kindle the bonfire, Unkindled — and if you are not alone, summon your companions to share the burden.
        </div>
      </div>
      <div className="card">
        {panel === 'main' && (
          <>
            <h2>Create your knight</h2>
            <div className="field">
              <label>Name</label>
              <input value={name} maxLength={18} placeholder="Unkindled" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && begin(false)} />
            </div>
            <div className="field">
              <label>Cloak — {CLOAK_NAMES[look.cloak]}</label>
              <div className="swatches">
                {CLOAK_COLORS.map((c, i) => (
                  <div
                    key={c}
                    className={`swatch ${look.cloak === i ? 'on' : ''}`}
                    style={{ background: c }}
                    onClick={() => {
                      audio.ui('move')
                      setLook({ ...look, cloak: i })
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="field">
              <label>Helm</label>
              <div className="chips">
                {CRESTS.map((c, i) => (
                  <button
                    key={c}
                    className={`chip ${look.crest === i ? 'on' : ''}`}
                    onClick={() => {
                      audio.ui('move')
                      setLook({ ...look, crest: i })
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>World (share this name to play together)</label>
              <input value={room} maxLength={24} onChange={(e) => setRoom(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))} />
            </div>
            <button className="btn" onClick={() => begin(false)}>
              {status?.online ? 'Enter the world' : 'Begin'}
            </button>
            <button className="btn ghost" onClick={() => begin(true)}>
              Play offline
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={() => setPanel('settings')}>
                Settings
              </button>
              <button className="btn ghost" onClick={() => setPanel('controls')}>
                Controls
              </button>
            </div>
            <div className="status">
              <span className={`dot ${status?.online ? 'on' : ''}`} />
              {status === null
                ? 'Seeking other worlds…'
                : status.online
                  ? status.players > 0
                    ? `${status.players} unkindled walk this world`
                    : 'The world is quiet. Others may join you.'
                  : 'No server found — you will walk alone.'}
            </div>
          </>
        )}
        {panel === 'settings' && (
          <>
            <h2>Settings</h2>
            <SettingsPanel />
            <button className="btn ghost" onClick={() => setPanel('main')}>
              Back
            </button>
          </>
        )}
        {panel === 'controls' && (
          <>
            <h2>Controls</h2>
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
