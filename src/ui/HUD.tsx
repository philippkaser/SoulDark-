import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { input } from '../input/input'
import { useUI } from '../state/store'
import type { GameSession } from '../game/session'
import { world, type EnemyView } from '../game/world'
import { FlaskIcon, ShieldIcon, SwordIcon } from './icons'

const _p = new THREE.Vector3()
const MAX_EBARS = 8

function project(x: number, y: number, z: number, cam: THREE.Camera): [number, number, boolean] {
  _p.set(x, y, z).project(cam)
  const visible = _p.z < 1 && _p.z > -1 && Math.abs(_p.x) < 1.2 && Math.abs(_p.y) < 1.2
  return [(_p.x * 0.5 + 0.5) * window.innerWidth, (-_p.y * 0.5 + 0.5) * window.innerHeight, visible]
}

function Bars({ session }: { session: GameSession }) {
  const hpBar = useRef<HTMLDivElement>(null!)
  const hpFill = useRef<HTMLDivElement>(null!)
  const hpLag = useRef<HTMLDivElement>(null!)
  const stBar = useRef<HTMLDivElement>(null!)
  const stFill = useRef<HTMLDivElement>(null!)
  const stLag = useRef<HTMLDivElement>(null!)
  const flask = useRef<HTMLSpanElement>(null!)
  const reticle = useRef<HTMLDivElement>(null!)
  const hurt = useRef<HTMLDivElement>(null!)
  const parry = useRef<HTMLDivElement>(null!)
  const ebarRefs = useRef<Array<{ root: HTMLDivElement; fill: HTMLDivElement; dmg: HTMLSpanElement } | null>>([])
  const [flaskEmpty, setFlaskEmpty] = useState(false)

  useEffect(() => {
    let raf = 0
    let hpLagV = 1
    let stLagV = 1
    let hpHold = 0
    let lastHp = session.player.hp
    let last = performance.now()
    let lastFlasks = -1
    const loop = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const p = session.player
      const hpR = Math.max(0, p.hp / p.maxHp)
      const stR = Math.max(0, p.stamina / p.maxStamina)
      hpBar.current.style.width = `${Math.min(window.innerWidth * 0.42, p.maxHp * 0.75)}px`
      stBar.current.style.width = `${Math.min(window.innerWidth * 0.36, p.maxStamina * 2.6)}px`
      if (p.hp < lastHp) hpHold = 0.6
      lastHp = p.hp
      hpHold -= dt
      if (hpHold <= 0) hpLagV += (hpR - hpLagV) * Math.min(1, dt * 3)
      if (hpLagV < hpR) hpLagV = hpR
      stLagV += (stR - stLagV) * Math.min(1, dt * 4)
      if (stLagV < stR) stLagV = stR
      hpFill.current.style.width = `${hpR * 100}%`
      hpLag.current.style.width = `${hpLagV * 100}%`
      stFill.current.style.width = `${stR * 100}%`
      stLag.current.style.width = `${stLagV * 100}%`
      if (p.flasks !== lastFlasks) {
        lastFlasks = p.flasks
        flask.current.textContent = String(p.flasks)
        setFlaskEmpty(p.flasks <= 0)
      }

      hurt.current.style.opacity = String(world.hurtFlash)
      parry.current.style.opacity = String(world.parryFlash)

      const cam = world.camera
      if (cam) {
        // lock-on reticle
        const lock = p.lock
        if (lock?.targetable) {
          const [x, y, vis] = project(lock.x, lock.def.height * 0.58, lock.z, cam)
          reticle.current.style.display = vis ? 'block' : 'none'
          reticle.current.style.transform = `translate(${x}px, ${y}px)`
        } else reticle.current.style.display = 'none'

        // floating enemy health bars with accumulated damage numbers
        const shown: EnemyView[] = []
        for (const e of world.enemies.values()) {
          if (e.type === 'boss' || e.state === 'dead' || e.state === 'dormant') continue
          if (now - e.dmgAt < 5000 || e === lock) shown.push(e)
        }
        for (let i = 0; i < MAX_EBARS; i++) {
          const r = ebarRefs.current[i]
          if (!r) continue
          const e = shown[i]
          if (!e) {
            r.root.style.display = 'none'
            continue
          }
          const [x, y, vis] = project(e.x, e.def.height + 0.45, e.z, cam)
          r.root.style.display = vis ? 'block' : 'none'
          r.root.style.transform = `translate(${x}px, ${y}px)`
          r.fill.style.width = `${Math.max(0, e.hp / e.mhp) * 100}%`
          r.dmg.textContent = now - e.dmgAt < 2500 && e.dmgAccum > 0 ? String(e.dmgAccum) : ''
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [session])

  return (
    <>
      <div className="vignette-hurt" ref={hurt} />
      <div className="flash-parry" ref={parry} />
      <div className="bars">
        <div className="bar hp" ref={hpBar}>
          <div className="lag" ref={hpLag} />
          <div className="fill" ref={hpFill} />
          <div className="cap" />
        </div>
        <div className="bar st" ref={stBar}>
          <div className="lag" ref={stLag} />
          <div className="fill" ref={stFill} />
          <div className="cap" />
        </div>
      </div>
      <div className="slots">
        <div className="slot top" />
        <div className="slot left">
          <ShieldIcon />
        </div>
        <div className="slot right">
          <SwordIcon />
        </div>
        <div className="slot bottom">
          <FlaskIcon empty={flaskEmpty} />
          <span className="count" ref={flask} />
        </div>
      </div>
      <div className="reticle" ref={reticle} style={{ left: 0, top: 0 }} />
      {Array.from({ length: MAX_EBARS }, (_, i) => (
        <div
          key={i}
          className="ebar"
          style={{ left: 0, top: 0 }}
          ref={(el) => {
            if (!el) {
              ebarRefs.current[i] = null
              return
            }
            ebarRefs.current[i] = {
              root: el,
              fill: el.querySelector('.fill') as HTMLDivElement,
              dmg: el.querySelector('.dmg') as HTMLSpanElement,
            }
          }}
        >
          <div className="bar">
            <div className="fill" />
          </div>
          <span className="dmg" />
        </div>
      ))}
    </>
  )
}

function Souls() {
  const souls = useUI((s) => s.save.souls)
  const prev = useRef(souls)
  const [gain, setGain] = useState<{ n: number; id: number } | null>(null)
  const [shown, setShown] = useState(souls)
  useEffect(() => {
    const d = souls - prev.current
    prev.current = souls
    if (d > 0) {
      setGain({ n: d, id: Date.now() })
      const t = setTimeout(() => setGain(null), 2200)
      // count up
      const start = performance.now()
      const from = souls - d
      let raf = 0
      const tick = () => {
        const k = Math.min(1, (performance.now() - start) / 900)
        setShown(Math.round(from + d * k))
        if (k < 1) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      return () => {
        clearTimeout(t)
        cancelAnimationFrame(raf)
      }
    }
    setShown(souls)
  }, [souls])
  return (
    <div className="souls">
      <span className="gain" style={{ opacity: gain ? 1 : 0 }}>
        {gain ? `+${gain.n}` : ''}
      </span>
      {shown.toLocaleString()}
    </div>
  )
}

function BossBar() {
  const boss = useUI((s) => s.boss)
  const lag = useRef(1)
  const [lagV, setLagV] = useState(1)
  useEffect(() => {
    if (!boss) {
      lag.current = 1
      return
    }
    const target = boss.hp / boss.max
    const id = setTimeout(() => {
      lag.current = target
      setLagV(target)
    }, 700)
    return () => clearTimeout(id)
  }, [boss])
  if (!boss) return null
  const r = Math.max(0, boss.hp / boss.max)
  return (
    <div className="bossbar">
      <div className="name">{boss.name}</div>
      <div className="bar">
        <div className="lag" style={{ width: `${Math.max(r, lagV) * 100}%`, transition: 'width 0.8s ease' }} />
        <div className="fill" style={{ width: `${r * 100}%` }} />
      </div>
    </div>
  )
}

function Prompt() {
  const prompt = useUI((s) => s.prompt)
  const [pad, setPad] = useState(false)
  useEffect(() => {
    const id = setInterval(() => setPad(input.frame.usingGamepad), 500)
    return () => clearInterval(id)
  }, [])
  if (!prompt) return null
  return (
    <div className="prompt">
      <span className="key">{pad ? 'A' : 'E'}</span>
      {prompt}
    </div>
  )
}

function Banner() {
  const banner = useUI((s) => s.banner)
  const clear = useUI((s) => s.clearBanner)
  useEffect(() => {
    if (!banner) return
    const t = setTimeout(() => clear(banner.id), banner.kind === 'death' ? 6500 : 5000)
    return () => clearTimeout(t)
  }, [banner, clear])
  if (!banner) return null
  return (
    <div className={`banner ${banner.kind}`} key={banner.id}>
      <div className="text">{banner.text}</div>
    </div>
  )
}

function ChatLog() {
  const chat = useUI((s) => s.chat)
  const open = useUI((s) => s.chatOpen)
  const setOpen = useUI((s) => s.setChatOpen)
  const [, force] = useState(0)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])
  const now = performance.now()
  const lines = chat.slice(-8)
  return (
    <div className="chatlog">
      {lines.map((l) => {
        const age = (now - l.at) / 1000
        const op = open ? 1 : age < 12 ? 1 : Math.max(0, 1 - (age - 12) / 3)
        return (
          <div key={l.id} className={`line ${l.system ? 'sys' : ''}`} style={{ opacity: op }}>
            {l.system ? l.text : (
              <>
                <b>{l.name}</b>: {l.text}
              </>
            )}
          </div>
        )
      })}
      {open && (
        <input
          ref={inputRef}
          className="chatinput"
          value={text}
          maxLength={140}
          placeholder="Speak to the other unkindled..."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const t = text.trim()
              if (t) window.dispatchEvent(new CustomEvent('souldark:chat', { detail: t }))
              setText('')
              setOpen(false)
              input.requestLock()
            } else if (e.key === 'Escape') {
              setText('')
              setOpen(false)
            }
            e.stopPropagation()
          }}
        />
      )}
    </div>
  )
}

function WorldInfo() {
  const mode = useUI((s) => s.mode)
  const room = useUI((s) => s.roomName)
  useUI((s) => s.remotesVersion)
  const n = world.remotes.size
  return (
    <div className="worldinfo">
      {mode === 'online' ? (
        <>
          <b>{room}</b> · online
          <br />
          {n === 0 ? 'No phantoms nearby' : `${n} phantom${n > 1 ? 's' : ''} in this world`}
        </>
      ) : (
        <>
          <b>Offline</b>
          <br />
          The world is empty
        </>
      )}
      <br />
      <span style={{ fontSize: 14 }}>
        <span className="key" style={{ height: 22, minWidth: 22, fontSize: 13 }}>
          H
        </span>{' '}
        controls
      </span>
    </div>
  )
}

function ControlsHelp() {
  const show = useUI((s) => s.showControls)
  const set = useUI((s) => s.setShowControls)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyH' && (e.target as HTMLElement)?.tagName !== 'INPUT') set(!useUI.getState().showControls)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [set])
  if (!show) return null
  return (
    <div className="controls-help">
      WASD move · Mouse camera
      <br />
      LMB light attack · RMB heavy attack
      <br />
      Space roll · Shift sprint · F parry
      <br />
      Q / MMB lock on · wheel switch target
      <br />
      R estus · E interact · G gesture
      <br />
      T write message · Enter chat · Esc menu
    </div>
  )
}

function LockHint() {
  const locked = useUI((s) => s.pointerLocked)
  const menu = useUI((s) => s.menu)
  const chat = useUI((s) => s.chatOpen)
  const [pad, setPad] = useState(false)
  useEffect(() => {
    const id = setInterval(() => setPad(input.frame.usingGamepad), 500)
    return () => clearInterval(id)
  }, [])
  if (locked || menu || chat || pad) return null
  return <div className="hint">Click to take up your sword</div>
}

export function HUD({ session }: { session: GameSession }) {
  return (
    <div className="hud">
      <Bars session={session} />
      <Souls />
      <BossBar />
      <Prompt />
      <Banner />
      <ChatLog />
      <WorldInfo />
      <ControlsHelp />
      <LockHint />
    </div>
  )
}
