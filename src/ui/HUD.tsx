import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Game } from '../game/Game'
import { RANKS } from '../game/score'
import type { Threat, Tier } from '../game/types'
import { useUI } from '../state/store'
import { Banner, Stamps } from './Overlays'

const TIER_COLOR: Record<Tier, string> = {
  small: '#f4ead8',
  medium: '#ffcf7a',
  large: '#ff9a3a',
  cosmic: '#ff3a2a',
}
const TIER_WINDOW: Record<Tier, number> = { small: 0.2, medium: 0.2, large: 0.25, cosmic: 0.3 }

const _p = new THREE.Vector3()

/** The parry cue, edge arrows and crosshair, drawn on a 2D canvas each frame. */
function drawOverlay(ctx: CanvasRenderingContext2D, game: Game, w: number, h: number, threats: Threat[], now: number) {
  ctx.clearRect(0, 0, w, h)
  const cx = w / 2
  const cy = h / 2
  const pl = game.player
  const cam = game.camera

  // edge arrows / brackets for every inbound threat
  for (const t of threats.slice(0, 8)) {
    _p.copy(t.pos).project(cam)
    const behind = _p.z > 1
    let sx = (_p.x * 0.5 + 0.5) * w
    let sy = (-_p.y * 0.5 + 0.5) * h
    if (behind) {
      sx = w - sx
      sy = h - sy
    }
    const col = TIER_COLOR[t.tier]
    const onScreen = !behind && sx > 40 && sx < w - 40 && sy > 40 && sy < h - 40
    if (onScreen) {
      const r = 12 + (t.tier === 'cosmic' ? 10 : 0)
      ctx.strokeStyle = col
      ctx.lineWidth = 2
      ctx.globalAlpha = 0.85
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        ctx.beginPath()
        ctx.moveTo(sx + dx * r, sy + dy * (r - 6))
        ctx.lineTo(sx + dx * r, sy + dy * r)
        ctx.lineTo(sx + dx * (r - 6), sy + dy * r)
        ctx.stroke()
      }
    } else {
      const a = Math.atan2(sy - cy, sx - cx)
      const ex = cx + Math.cos(a) * (w * 0.44)
      const ey = cy + Math.sin(a) * (h * 0.4)
      const s = t.tier === 'cosmic' ? 22 : t.tier === 'large' ? 17 : 13
      ctx.save()
      ctx.translate(ex, ey)
      ctx.rotate(a)
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now * 12)
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.moveTo(s, 0)
      ctx.lineTo(-s * 0.6, s * 0.65)
      ctx.lineTo(-s * 0.25, 0)
      ctx.lineTo(-s * 0.6, -s * 0.65)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }
  }
  ctx.globalAlpha = 1

  // the parry cue: a ring closing onto the crosshair
  const next = threats.find((t) => t.eta < 1.8 && t.eta > -0.1)
  if (next && pl.alive) {
    const col = TIER_COLOR[next.tier]
    const win = TIER_WINDOW[next.tier]
    const R0 = 30
    const r = R0 + Math.max(0, next.eta) * 150
    const inWindow = next.eta <= win
    ctx.lineWidth = 2
    ctx.strokeStyle = col
    ctx.globalAlpha = inWindow ? 1 : 0.55
    ctx.beginPath()
    ctx.arc(cx, cy, R0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = Math.min(1, 1.9 - next.eta)
    ctx.lineWidth = inWindow ? 5 : 2.5
    ctx.shadowColor = col
    ctx.shadowBlur = inWindow ? 22 : 8
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.font = '700 italic 15px "Barlow Condensed", sans-serif'
    ctx.textAlign = 'center'
    ctx.fillStyle = col
    ctx.globalAlpha = 0.95
    const label = `${next.label ?? (next.tier === 'small' ? 'INBOUND' : 'THREAT')}  ${Math.max(0, next.eta).toFixed(1)}s`
    ctx.fillText(label, cx, cy + Math.min(r, 140) + 22)
    if (inWindow) {
      ctx.font = '800 italic 30px "Barlow Condensed", sans-serif'
      ctx.fillStyle = '#fff6e4'
      ctx.shadowColor = col
      ctx.shadowBlur = 18
      ctx.fillText('PARRY', cx, cy - R0 - 16)
      ctx.shadowBlur = 0
    }
    ctx.globalAlpha = 1
  }

  // crosshair: a small diamond, with the guard arc beneath
  ctx.strokeStyle = 'rgba(255,246,228,0.9)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(cx, cy - 6)
  ctx.lineTo(cx + 6, cy)
  ctx.lineTo(cx, cy + 6)
  ctx.lineTo(cx - 6, cy)
  ctx.closePath()
  ctx.stroke()
  if (pl.guarding || pl.parryWindow > 0) {
    ctx.strokeStyle = pl.parryWindow > 0 ? '#fff2c8' : '#ffcf7a'
    ctx.lineWidth = pl.parryWindow > 0 ? 4 : 2.5
    ctx.globalAlpha = 0.5 + pl.parryWindow * 0.5
    ctx.beginPath()
    ctx.arc(cx, cy, 18, Math.PI * 0.15, Math.PI * 0.85)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  // charge gauge around the crosshair
  if (pl.state === 'charge') {
    ctx.strokeStyle = pl.charge >= 1 ? '#fff6e4' : '#ffcf7a'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(cx, cy, 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pl.charge)
    ctx.stroke()
  }
}

function BossBars() {
  const bosses = useUI((s) => s.bosses)
  return (
    <div className="bosses">
      {bosses.slice(0, 2).map((b) => (
        <div className="boss" key={b.id}>
          <div className="boss-name">{b.name}</div>
          <div className="boss-bar">
            <div className="boss-fill" style={{ width: `${Math.max(0, Math.min(1, b.hp / b.max)) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Cinema bars for kill cams; the HUD chrome fades while they are down. */
function Letterbox() {
  const on = useUI((s) => s.letterbox)
  return (
    <div className={`letterbox${on ? ' on' : ''}`}>
      <div className="bar top" />
      <div className="bar bottom" />
    </div>
  )
}

function Objective() {
  const objective = useUI((s) => s.objective)
  if (!objective) return null
  return <div className="objective">{objective}</div>
}

function Help() {
  const show = useUI((s) => s.showHelp)
  const mode = useUI((s) => s.mode)
  if (!show) return <div className="help-hint">H · controls</div>
  return (
    <div className="help">
      <div>
        <b>LMB</b> slash · flying crescent
      </div>
      <div>
        <b>RMB</b> parry · hold to guard / catch beams
      </div>
      <div>
        <b>E</b> hold · Heaven Splitter
      </div>
      <div>
        <b>F</b> punch · hold: Serious Punch (50 Divinity)
      </div>
      <div>
        <b>Shift</b> flash-step · <b>Space</b> leap / dive
      </div>
      <div>
        <b>Q</b> Judgment (Divinity full)
      </div>
      {mode === 'sandbox' && (
        <div className="summons">
          <div>
            <b>1</b> Legion · <b>2</b> Arrowstorm · <b>3</b> Artillery
          </div>
          <div>
            <b>4</b> Skyfleet · <b>5</b> Colossus · <b>6</b> Sol Lance
          </div>
          <div>
            <b>7</b> Nuke · <b>8</b> Meteors · <b>9</b> The Moon
          </div>
          <div>
            <b>0</b> immortality + full Divinity
          </div>
        </div>
      )}
      <div className="dim">H hide · Esc pause</div>
    </div>
  )
}

export function HUD({ game }: { game: Game }) {
  const canvas = useRef<HTMLCanvasElement>(null!)
  const hpFill = useRef<HTMLDivElement>(null!)
  const hpLag = useRef<HTMLDivElement>(null!)
  const hpText = useRef<HTMLSpanElement>(null!)
  const div = useRef<HTMLDivElement>(null!)
  const divFill = useRef<HTMLDivElement>(null!)
  const rankLetter = useRef<HTMLDivElement>(null!)
  const rankName = useRef<HTMLDivElement>(null!)
  const rankFill = useRef<HTMLDivElement>(null!)
  const score = useRef<HTMLDivElement>(null!)
  const combo = useRef<HTMLDivElement>(null!)
  const feed = useRef<HTMLDivElement>(null!)
  const burst = useRef<HTMLDivElement>(null!)
  const cine = useUI((s) => s.letterbox)

  useEffect(() => {
    let raf = 0
    let lag = 1
    let hold = 0
    let lastHp = game.player.hp
    let lastRank = -1
    let lastFeed = -1
    let shownScore = 0
    let last = performance.now()
    const ctx = canvas.current.getContext('2d')!
    const loop = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const pl = game.player
      // canvas size
      const cv = canvas.current
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const W = Math.round(window.innerWidth * dpr)
      const H = Math.round(window.innerHeight * dpr)
      if (cv.width !== W || cv.height !== H) {
        cv.width = W
        cv.height = H
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawOverlay(ctx, game, window.innerWidth, window.innerHeight, game.threats(), now / 1000)

      // vigor
      const r = Math.max(0, pl.hp / pl.maxHp)
      if (pl.hp < lastHp) hold = 0.5
      lastHp = pl.hp
      hold -= dt
      if (hold <= 0) lag += (r - lag) * Math.min(1, dt * 3)
      if (lag < r) lag = r
      hpFill.current.style.width = `${r * 100}%`
      hpLag.current.style.width = `${lag * 100}%`
      hpText.current.textContent = pl.godMode ? '∞' : String(Math.ceil(pl.hp))
      // divinity
      divFill.current.style.width = `${pl.divinity}%`
      div.current.classList.toggle('full', pl.divinity >= 100)

      // style
      const s = game.score
      if (s.rank !== lastRank) {
        // from S up, climbing a rank gets a flourish: the letter slams in and a ring of light bursts off it
        const flourish = s.rank > lastRank && s.rank >= 4 && lastRank >= 0
        lastRank = s.rank
        rankLetter.current.textContent = RANKS[s.rank].letter
        rankName.current.textContent = RANKS[s.rank].name
        rankLetter.current.dataset.rank = String(s.rank)
        rankLetter.current.classList.remove('pop', 'flourish')
        burst.current.classList.remove('go')
        void rankLetter.current.offsetWidth
        rankLetter.current.classList.add(flourish ? 'flourish' : 'pop')
        if (flourish) {
          burst.current.dataset.rank = String(s.rank)
          burst.current.classList.add('go')
        }
      }
      rankFill.current.style.width = `${s.progress * 100}%`
      shownScore += (s.points - shownScore) * Math.min(1, dt * 8)
      if (Math.abs(s.points - shownScore) < 1) shownScore = s.points
      score.current.textContent = Math.round(shownScore).toLocaleString('en-US')
      combo.current.textContent = s.combo > 1 ? `${s.combo} HITS` : ''
      // feats
      const fid = s.feed.length ? s.feed[s.feed.length - 1].id : 0
      if (fid !== lastFeed) {
        lastFeed = fid
        feed.current.innerHTML = s.feed
          .slice()
          .reverse()
          .map((l) => `<div class="feat${l.big ? ' big' : ''}"><span>${l.text}</span>${l.pts ? `<b>+${l.pts.toLocaleString('en-US')}</b>` : ''}</div>`)
          .join('')
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [game])

  return (
    <div className={`hud${cine ? ' cine' : ''}`}>
      <canvas ref={canvas} className="hud-canvas" />
      <BossBars />
      <Objective />
      <div className="style">
        <div className="rank-burst" ref={burst} />
        <div className="rank-letter" ref={rankLetter} />
        <div className="rank-name" ref={rankName} />
        <div className="rank-bar">
          <div ref={rankFill} />
        </div>
        <div className="score" ref={score} />
        <div className="combo" ref={combo} />
        <div className="feed" ref={feed} />
      </div>
      <div className="vitals">
        <div className="vigor">
          <span className="label">VIGOR</span>
          <span className="num" ref={hpText} />
          <div className="bar">
            <div className="lag" ref={hpLag} />
            <div className="fill" ref={hpFill} />
          </div>
        </div>
        <div className="divinity" ref={div}>
          <span className="label">DIVINITY</span>
          <span className="ready">Q · JUDGMENT</span>
          <div className="bar">
            <div className="fill" ref={divFill} />
          </div>
        </div>
      </div>
      <Help />
      <Letterbox />
      <Banner />
      <Stamps />
    </div>
  )
}
