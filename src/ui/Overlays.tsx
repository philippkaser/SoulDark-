import { useEffect } from 'react'
import { audio } from '../audio/audio'
import type { Game } from '../game/Game'
import { RANKS } from '../game/score'
import { input } from '../input/input'
import { useUI, type Mode, type Stamp } from '../state/store'
import type { Quality } from '../state/settings'

export function Banner() {
  const banner = useUI((s) => s.banner)
  useEffect(() => {
    if (!banner || banner.kind === 'death') return
    const id = banner.id
    const t = setTimeout(() => {
      if (useUI.getState().banner?.id === id) useUI.getState().clearBanner()
    }, banner.kind === 'warning' ? 4200 : 3400)
    return () => clearTimeout(t)
  }, [banner])
  useEffect(() => {
    if (banner) audio.stamp(banner.kind === 'boss' || banner.kind === 'warning')
  }, [banner])
  if (!banner || banner.kind === 'death') return null
  return (
    <div className={`banner ${banner.kind}`} key={banner.id}>
      {banner.kind === 'warning' && <div className="stripes" />}
      <div className="banner-title">{banner.title}</div>
      {banner.sub && <div className="banner-sub">{banner.sub}</div>}
    </div>
  )
}

function StampView({ s }: { s: Stamp }) {
  useEffect(() => {
    audio.stamp(s.kind === 'divine' || s.kind === 'perfect')
    const t = setTimeout(() => useUI.getState().dropStamp(s.id), 1500)
    return () => clearTimeout(t)
  }, [s])
  return <div className={`stamp ${s.kind}`}>{s.text}</div>
}

export function Stamps() {
  const stamps = useUI((s) => s.stamps)
  return (
    <div className="stamps">
      {stamps.slice(-2).map((s) => (
        <StampView key={s.id} s={s} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settings + controls
// ---------------------------------------------------------------------------

export function SettingsPanel() {
  const s = useUI((st) => st.save.settings)
  const set = useUI((st) => st.updateSettings)
  const slider = (label: string, key: 'sensitivity' | 'volume' | 'music' | 'shake', min: number, max: number, step: number) => (
    <label className="row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={s[key]}
        onChange={(e) => {
          set({ [key]: Number(e.target.value) })
          if (key === 'volume' || key === 'music') {
            const n = useUI.getState().save.settings
            audio.setVolume(n.volume, n.music)
          }
        }}
      />
      <em>{key === 'sensitivity' ? s[key].toFixed(2) : Math.round(s[key] * 100)}</em>
    </label>
  )
  return (
    <div className="settings">
      <div className="row">
        <span>Graphics</span>
        <div className="chips">
          {(['low', 'medium', 'high'] as Quality[]).map((q) => (
            <button key={q} className={`chip ${s.quality === q ? 'on' : ''}`} onClick={() => set({ quality: q })}>
              {q}
            </button>
          ))}
        </div>
      </div>
      {slider('Mouse sensitivity', 'sensitivity', 0.2, 3, 0.05)}
      {slider('Master volume', 'volume', 0, 1, 0.01)}
      {slider('Music', 'music', 0, 1, 0.01)}
      {slider('Screen shake', 'shake', 0, 1, 0.05)}
      <label className="row check">
        <span>Invert Y</span>
        <input type="checkbox" checked={s.invertY} onChange={(e) => set({ invertY: e.target.checked })} />
      </label>
      <label className="row check">
        <span>Reduce flashes and impact frames</span>
        <input type="checkbox" checked={s.reduceFlashes} onChange={(e) => set({ reduceFlashes: e.target.checked })} />
      </label>
      <label className="row check">
        <span>Controller vibration</span>
        <input type="checkbox" checked={s.vibration} onChange={(e) => set({ vibration: e.target.checked })} />
      </label>
      <div className="note">Graphics changes rebuild the battlefield.</div>
    </div>
  )
}

const CONTROLS: Array<[string, string, string]> = [
  ['Move', 'W A S D', 'Left stick'],
  ['Aim', 'Mouse', 'Right stick'],
  ['Slash (flying crescent)', 'Left click', 'RB / X'],
  ['Parry · hold to guard', 'Right click', 'LB / LT'],
  ['Heaven Splitter (hold)', 'E', 'RT'],
  ['Iai · hold: Worldsplitter', 'F', 'R3'],
  ['Flash-step', 'Shift', 'B'],
  ['Leap · again to dive', 'Space', 'A'],
  ['Judgment', 'Q', 'Y'],
  ['Pause', 'Esc', 'Start'],
  ['Sandbox summons', '1 – 9, 0', ''],
]

export function ControlsTable() {
  return (
    <table className="controls">
      <tbody>
        {CONTROLS.map(([a, k, p]) => (
          <tr key={a}>
            <td>{a}</td>
            <td>
              <kbd>{k}</kbd>
            </td>
            <td className="dim">{p}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------------------
// Pause, defeat, results
// ---------------------------------------------------------------------------

function PauseMenu({ game, onQuit }: { game: Game; onQuit: () => void }) {
  const panel = useUI((s) => s.panel)
  const mode = useUI((s) => s.mode)
  const ui = useUI.getState()
  const resume = () => {
    audio.ui('confirm')
    ui.setPaused(false)
    input.requestLock()
  }
  return (
    <div className="modal">
      <div className="card">
        {panel === 'pause' && (
          <>
            <h2>Paused</h2>
            <button className="btn" onClick={resume}>
              Resume
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                audio.ui('confirm')
                ui.setPaused(false)
                ui.clearBanner()
                if (mode === 'campaign') game.director!.campaign!.retry()
                else game.director!.start('sandbox')
                input.requestLock()
              }}
            >
              {mode === 'campaign' ? 'Restart trial' : 'Reset sandbox'}
            </button>
            <div className="split">
              <button className="btn ghost" onClick={() => ui.setPanel('settings')}>
                Settings
              </button>
              <button className="btn ghost" onClick={() => ui.setPanel('controls')}>
                Controls
              </button>
            </div>
            <button className="btn ghost danger" onClick={onQuit}>
              Quit to title
            </button>
          </>
        )}
        {panel === 'settings' && (
          <>
            <h2>Settings</h2>
            <SettingsPanel />
            <button className="btn ghost" onClick={() => ui.setPanel('pause')}>
              Back
            </button>
          </>
        )}
        {panel === 'controls' && (
          <>
            <h2>Controls</h2>
            <ControlsTable />
            <button className="btn ghost" onClick={() => ui.setPanel('pause')}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function DeathScreen({ game, onQuit }: { game: Game; onQuit: () => void }) {
  const mode = useUI((s) => s.mode)
  useEffect(() => input.releaseLock(), [])
  return (
    <div className="modal death">
      <div className="death-title">DIVINITY FADES</div>
      <div className="death-sub">Even gods may fall. Rise again.</div>
      <div className="row-buttons">
        <button
          className="btn"
          onClick={() => {
            const ui = useUI.getState()
            ui.setDead(false)
            ui.clearBanner()
            if (mode === 'campaign') game.director!.campaign!.retry()
            else game.director!.start('sandbox')
            input.requestLock()
          }}
        >
          {mode === 'campaign' ? 'Rise · retry the trial' : 'Rise'}
        </button>
        <button className="btn ghost" onClick={onQuit}>
          Quit to title
        </button>
      </div>
    </div>
  )
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${m}:${r.toString().padStart(2, '0')}`
}

function ResultsScreen({ onStart, onQuit }: { onStart: (m: Mode) => void; onQuit: () => void }) {
  const r = useUI((s) => s.results)
  useEffect(() => input.releaseLock(), [])
  if (!r) return null
  const t = r.tally
  const rows: Array<[string, string | number]> = [
    ['Soldiers felled', t.soldiers.toLocaleString('en-US')],
    ['Perfect parries', t.perfects],
    ['Warheads returned', t.warheads],
    ['Airships downed', t.airships],
    ['Colossi cleaved', t.titans],
    ['Moons dealt with', t.moons],
    ['Longest chain', t.bestCombo],
    ['Damage taken', Math.round(t.damageTaken)],
    ['Time', fmtTime(r.time)],
  ]
  return (
    <div className="results">
      <div className="results-kicker">{r.victory ? 'THE SKY IS CLEAVED' : 'THE TRIAL ENDS'}</div>
      <div className="results-title">{r.victory ? 'DAWN' : 'DEFEAT'}</div>
      <div className="results-rank">
        <span className="rank-letter" data-rank={r.rank}>
          {RANKS[r.rank].letter}
        </span>
        <span>{RANKS[r.rank].name}</span>
      </div>
      <div className="results-score">{r.score.toLocaleString('en-US')}</div>
      <div className="results-grid">
        {rows.map(([k, v]) => (
          <div key={k}>
            <span>{k}</span>
            <b>{v}</b>
          </div>
        ))}
      </div>
      <div className="row-buttons">
        <button className="btn" onClick={() => onStart('sandbox')}>
          Sandbox
        </button>
        <button className="btn ghost" onClick={onQuit}>
          Title
        </button>
      </div>
    </div>
  )
}

export function Overlays({ game, onStart, onQuit }: { game: Game; onStart: (m: Mode) => void; onQuit: () => void }) {
  const screen = useUI((s) => s.screen)
  const paused = useUI((s) => s.paused)
  const dead = useUI((s) => s.dead)
  if (screen === 'results') return <ResultsScreen onStart={onStart} onQuit={onQuit} />
  if (screen !== 'game') return null
  if (dead) return <DeathScreen game={game} onQuit={onQuit} />
  if (paused) return <PauseMenu game={game} onQuit={onQuit} />
  return null
}
