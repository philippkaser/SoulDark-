import { useEffect, useState } from 'react'
import { damageMultFor, levelCost, maxHpFor, maxStaminaFor, statsLevel, type Stats } from '../../shared/combat'
import { MESSAGE_TEMPLATES, MESSAGE_WORDS } from '../../shared/protocol'
import { audio } from '../audio/audio'
import { input } from '../input/input'
import type { Quality } from '../state/save'
import { useUI } from '../state/store'
import type { GameSession } from '../game/session'

function close(lock = true) {
  useUI.getState().setMenu(null)
  if (lock) input.requestLock()
}

function Bonfire({ session }: { session: GameSession }) {
  const setMenu = useUI((s) => s.setMenu)
  return (
    <div className="card menu">
      <h2>Bonfire</h2>
      <div className="list">
        <button
          className="item"
          onClick={() => {
            audio.ui('confirm')
            setMenu('levelup')
          }}
        >
          Level Up
        </button>
        <button
          className="item"
          onClick={() => {
            audio.ui('back')
            session.player.standUp()
            close()
          }}
        >
          Leave
        </button>
      </div>
      <p style={{ color: 'var(--ink-dim)', fontSize: 16, marginBottom: 0 }}>
        Your flasks are refilled. The fallen hollows of this world have risen again.
      </p>
    </div>
  )
}

const STAT_INFO: Array<{ key: keyof Stats; name: string; desc: string }> = [
  { key: 'vigor', name: 'Vigor', desc: 'Raises maximum HP' },
  { key: 'endurance', name: 'Endurance', desc: 'Raises maximum stamina' },
  { key: 'strength', name: 'Strength', desc: 'Raises attack power' },
]

function LevelUp({ session }: { session: GameSession }) {
  const save = useUI((s) => s.save)
  const levelUp = useUI((s) => s.levelUp)
  const setMenu = useUI((s) => s.setMenu)
  const level = statsLevel(save.stats)
  const cost = levelCost(level)
  return (
    <div className="card menu">
      <h2>Level Up</h2>
      <div className="derived" style={{ marginTop: 0, marginBottom: 10, fontSize: 19, color: 'var(--ink)' }}>
        <span>Level</span>
        <span>{level}</span>
        <span>Souls held</span>
        <span>{save.souls.toLocaleString()}</span>
        <span>Souls required</span>
        <span style={{ color: save.souls >= cost ? 'var(--ink)' : '#b44' }}>{cost.toLocaleString()}</span>
      </div>
      {STAT_INFO.map((s) => (
        <div className="stat-row" key={s.key}>
          <span>
            {s.name} <span style={{ color: 'var(--ink-dim)', fontSize: 15 }}>— {s.desc}</span>
          </span>
          <span className="val">{save.stats[s.key]}</span>
          <button
            className="plus"
            disabled={save.souls < cost}
            onClick={() => {
              if (levelUp(s.key)) {
                audio.ui('levelup')
                session.player.applyStats(useUI.getState().save.stats)
              } else audio.ui('error')
            }}
          >
            +
          </button>
        </div>
      ))}
      <div className="derived">
        <span>Max HP</span>
        <span>{maxHpFor(save.stats)}</span>
        <span>Max stamina</span>
        <span>{maxStaminaFor(save.stats)}</span>
        <span>Attack</span>
        <span>{Math.round(damageMultFor(save.stats) * 100)}%</span>
      </div>
      <button className="btn ghost" onClick={() => setMenu('bonfire')}>
        Back
      </button>
    </div>
  )
}

function Compose({ session }: { session: GameSession }) {
  const [tpl, setTpl] = useState<string>(MESSAGE_TEMPLATES[0])
  const [cat, setCat] = useState<keyof typeof MESSAGE_WORDS>('Creatures')
  const [word, setWord] = useState<string>(MESSAGE_WORDS.Creatures[0])
  const text = tpl.replace('****', word)
  return (
    <div className="card menu wide">
      <h2>Orange Guidance Soapstone</h2>
      <div className="compose-cols">
        <div className="list">
          {MESSAGE_TEMPLATES.map((t) => (
            <button key={t} className={`item ${t === tpl ? 'on' : ''}`} onClick={() => setTpl(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="list">
          {(Object.keys(MESSAGE_WORDS) as Array<keyof typeof MESSAGE_WORDS>).map((c) => (
            <button
              key={c}
              className={`item ${c === cat ? 'on' : ''}`}
              onClick={() => {
                setCat(c)
                setWord(MESSAGE_WORDS[c][0])
              }}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="list">
          {MESSAGE_WORDS[cat].map((w) => (
            <button key={w} className={`item ${w === word ? 'on' : ''}`} onClick={() => setWord(w)}>
              {w}
            </button>
          ))}
        </div>
      </div>
      <div className="preview">“{text}”</div>
      <button
        className="btn"
        onClick={() => {
          const p = session.player
          session.net.send({ t: 'msg', x: p.x + Math.sin(p.yaw) * 0.9, z: p.z + Math.cos(p.yaw) * 0.9, text })
          p.start('pickup', true)
          audio.message()
          close()
        }}
      >
        Engrave message
      </button>
      <button className="btn ghost" onClick={() => close()}>
        Cancel
      </button>
    </div>
  )
}

const rated = new Set<number>()

function Read({ session }: { session: GameSession }) {
  const msg = useUI((s) => s.reading)
  const name = useUI((s) => s.save.name)
  if (!msg) return null
  const own = msg.author === name
  return (
    <div className="card menu">
      <h2>Message</h2>
      <div className="msgtext">“{msg.text}”</div>
      <div className="msgmeta">
        left by {msg.author} · appraised {msg.rating} time{msg.rating === 1 ? '' : 's'}
      </div>
      <button
        className="btn"
        disabled={own || rated.has(msg.id)}
        onClick={() => {
          rated.add(msg.id)
          session.net.send({ t: 'rate', id: msg.id })
          audio.ui('confirm')
          close()
        }}
      >
        {own ? 'Your own words' : rated.has(msg.id) ? 'Appraised' : 'Appraise — Good'}
      </button>
      <button className="btn ghost" onClick={() => close()}>
        Close
      </button>
    </div>
  )
}

const GESTURES = [
  { id: 'praise', name: 'Praise the Sun' },
  { id: 'bow', name: 'Bow' },
  { id: 'wave', name: 'Wave' },
  { id: 'point', name: 'Point Forward' },
] as const

function Gestures({ session }: { session: GameSession }) {
  const run = (id: (typeof GESTURES)[number]['id']) => {
    if (!session.player.action && !session.player.dead) session.player.start(id, true)
    close()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code)
      if (i >= 0) run(GESTURES[i].id)
      if (e.code === 'KeyG') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <div className="card menu">
      <h2>Gestures</h2>
      <div className="gestures">
        {GESTURES.map((g, i) => (
          <button key={g.id} className="item" onClick={() => run(g.id)}>
            <span className="key" style={{ marginRight: 10 }}>
              {i + 1}
            </span>
            {g.name}
          </button>
        ))}
      </div>
    </div>
  )
}

export function SettingsPanel() {
  const settings = useUI((s) => s.save.settings)
  const update = useUI((s) => s.updateSettings)
  return (
    <div className="settings-grid">
      <span>Graphics</span>
      <div className="chips">
        {(['low', 'medium', 'high'] as Quality[]).map((q) => (
          <button key={q} className={`chip ${settings.quality === q ? 'on' : ''}`} onClick={() => update({ quality: q })}>
            {q}
          </button>
        ))}
      </div>
      <span>Mouse sensitivity</span>
      <input type="range" min={0.2} max={3} step={0.05} value={settings.sensitivity} onChange={(e) => update({ sensitivity: Number(e.target.value) })} />
      <span>Invert camera Y</span>
      <div className="chips">
        <button className={`chip ${settings.invertY ? 'on' : ''}`} onClick={() => update({ invertY: !settings.invertY })}>
          {settings.invertY ? 'On' : 'Off'}
        </button>
      </div>
      <span>Master volume</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={settings.volume}
        onChange={(e) => {
          update({ volume: Number(e.target.value) })
          audio.setVolume(Number(e.target.value), settings.music)
        }}
      />
      <span>Music</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={settings.music}
        onChange={(e) => {
          update({ music: Number(e.target.value) })
          audio.setVolume(settings.volume, Number(e.target.value))
        }}
      />
    </div>
  )
}

export function ControlsTable() {
  const rows: Array<[string, string, string]> = [
    ['W A S D', 'Move', 'Left stick'],
    ['Mouse', 'Camera', 'Right stick'],
    ['Shift (hold)', 'Sprint', 'B (hold)'],
    ['Space', 'Roll / backstep', 'B'],
    ['Left click', 'Light attack (combo)', 'RB'],
    ['Right click', 'Heavy attack', 'RT'],
    ['F', 'Parry, then attack to riposte', 'LB / LT'],
    ['Q / Middle click', 'Lock on (wheel switches)', 'R3'],
    ['R', 'Drink Estus Flask', 'X'],
    ['E', 'Interact / rest at bonfire', 'A'],
    ['G', 'Gestures', 'Y'],
    ['T', 'Write a message', 'Back'],
    ['Enter', 'Chat', ''],
    ['Esc', 'Menu', 'Start'],
  ]
  return (
    <div className="controls-table">
      {rows.map(([k, a, g]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span className="k">{k}</span>
          <span>{a}</span>
          <span className="g">{g}</span>
        </div>
      ))}
    </div>
  )
}

function Pause({ onQuit }: { onQuit: () => void }) {
  const [view, setView] = useState<'main' | 'settings' | 'controls'>('main')
  return (
    <div className="card menu">
      {view === 'main' && (
        <>
          <h2>Menu</h2>
          <div className="list">
            <button className="item" onClick={() => close()}>
              Resume
            </button>
            <button className="item" onClick={() => setView('settings')}>
              Settings
            </button>
            <button className="item" onClick={() => setView('controls')}>
              Controls
            </button>
            <button
              className="item"
              onClick={() => {
                close(false)
                onQuit()
              }}
            >
              Quit to title
            </button>
          </div>
        </>
      )}
      {view === 'settings' && (
        <>
          <h2>Settings</h2>
          <SettingsPanel />
          <button className="btn ghost" onClick={() => setView('main')}>
            Back
          </button>
        </>
      )}
      {view === 'controls' && (
        <>
          <h2>Controls</h2>
          <ControlsTable />
          <button className="btn ghost" onClick={() => setView('main')}>
            Back
          </button>
        </>
      )}
    </div>
  )
}

/** Gamepad navigation for any open menu: D-pad/stick moves focus, A selects, B backs out. */
function useGamepadMenu(active: boolean) {
  useEffect(() => {
    if (!active) return
    let raf = 0
    let prev: boolean[] = []
    let stickHeld = 0
    const focusables = () => [...document.querySelectorAll<HTMLElement>('.menu-wrap button:not(:disabled), .menu-wrap .swatch')]
    const move = (dir: number) => {
      const list = focusables()
      if (!list.length) return
      const i = list.indexOf(document.activeElement as HTMLElement)
      const next = list[(i + dir + list.length) % list.length] ?? list[0]
      next.focus()
      audio.ui('move')
    }
    const loop = () => {
      const pad = Array.from(navigator.getGamepads?.() ?? []).find((g) => g && g.connected)
      if (pad) {
        const now = pad.buttons.map((b) => b.pressed)
        const down = (i: number) => now[i] && !prev[i]
        const ay = pad.axes[1] ?? 0
        if (down(12)) move(-1)
        if (down(13)) move(1)
        if (Math.abs(ay) > 0.6) {
          if (stickHeld <= 0) {
            move(ay > 0 ? 1 : -1)
            stickHeld = 14
          } else stickHeld--
        } else stickHeld = 0
        if (down(0)) (document.activeElement as HTMLElement | null)?.click()
        if (down(1)) {
          const ui = useUI.getState()
          if (ui.menu === 'levelup') ui.setMenu('bonfire')
          else if (ui.menu !== 'bonfire') close(false)
        }
        prev = now
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active])
}

export function Menus({ session, onQuit }: { session: GameSession; onQuit: () => void }) {
  const menu = useUI((s) => s.menu)
  useEffect(() => {
    if (menu) input.releaseLock()
  }, [menu])
  useGamepadMenu(!!menu)
  if (!menu) return null
  return (
    <div
      className="menu-wrap"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && menu !== 'bonfire' && menu !== 'levelup') close()
      }}
    >
      {menu === 'bonfire' && <Bonfire session={session} />}
      {menu === 'levelup' && <LevelUp session={session} />}
      {menu === 'compose' && <Compose session={session} />}
      {menu === 'read' && <Read session={session} />}
      {menu === 'gestures' && <Gestures session={session} />}
      {menu === 'pause' && <Pause onQuit={onQuit} />}
    </div>
  )
}
