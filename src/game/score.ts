import * as THREE from 'three'
import { audio } from '../audio/audio'

export const RANKS = [
  { letter: 'D', name: 'Dreadful', at: 0 },
  { letter: 'C', name: 'Cataclysmic', at: 120 },
  { letter: 'B', name: 'Biblical', at: 280 },
  { letter: 'A', name: 'Apocalyptic', at: 480 },
  { letter: 'S', name: 'Sovereign', at: 720 },
  { letter: 'SS', name: 'Supreme', at: 1000 },
  { letter: 'SSS', name: 'Skycleaver', at: 1320 },
] as const

export type KillKind =
  | 'soldier'
  | 'archer'
  | 'spire'
  | 'cannon'
  | 'airship'
  | 'titan'
  | 'station'
  | 'meteor'
  | 'missile'
  | 'shell'
  | 'warhead'
  | 'silo'
  | 'moon'
  | 'eclipse'

const KILL_POINTS: Record<KillKind, number> = {
  soldier: 10,
  archer: 15,
  spire: 120,
  cannon: 600,
  airship: 2000,
  titan: 8000,
  station: 6000,
  meteor: 400,
  missile: 150,
  shell: 120,
  warhead: 2500,
  silo: 5000,
  moon: 25000,
  eclipse: 50000,
}

const KILL_STYLE: Record<KillKind, number> = {
  soldier: 4,
  archer: 5,
  spire: 30,
  cannon: 90,
  airship: 180,
  titan: 400,
  station: 400,
  meteor: 60,
  missile: 30,
  shell: 25,
  warhead: 300,
  silo: 300,
  moon: 800,
  eclipse: 1000,
}

export interface FeedLine {
  id: number
  text: string
  pts: number
  at: number
  big: boolean
  /** Repeats of the same line close together fold into one: "Spire felled ×6". */
  base: string
  n: number
}

export interface Tally {
  soldiers: number
  airships: number
  cannons: number
  titans: number
  parries: number
  perfects: number
  warheads: number
  moons: number
  damageTaken: number
  bestRank: number
  bestCombo: number
}

const newTally = (): Tally => ({ soldiers: 0, airships: 0, cannons: 0, titans: 0, parries: 0, perfects: 0, warheads: 0, moons: 0, damageTaken: 0, bestRank: 0, bestCombo: 0 })

let feedId = 1

/** Style meter, combo, score, feats. */
export class Score {
  points = 0
  style = 0
  combo = 0
  private comboTimer = 0
  rank = 0
  tally: Tally = newTally()
  feed: FeedLine[] = []
  private clock = 0
  /** Called with the new rank when it rises (HUD flourish, divinity). */
  onRankUp?: (rank: number) => void
  onKill?: (kind: KillKind, count: number) => void

  reset() {
    this.points = 0
    this.style = 0
    this.combo = 0
    this.rank = 0
    this.tally = newTally()
    this.feed = []
  }

  get mult() {
    return 1 + this.rank * 0.5
  }

  get rankInfo() {
    return RANKS[this.rank]
  }

  /** 0..1 progress toward the next rank. */
  get progress() {
    const cur = RANKS[this.rank].at
    const next = RANKS[this.rank + 1]?.at ?? cur + 400
    return Math.max(0, Math.min(1, (this.style - cur) / (next - cur)))
  }

  private addStyle(a: number) {
    this.style = Math.min(RANKS[RANKS.length - 1].at + 380, this.style + a)
    this.refreshRank()
  }

  private refreshRank() {
    let r = 0
    for (let i = 0; i < RANKS.length; i++) if (this.style >= RANKS[i].at) r = i
    if (r > this.rank) {
      this.rank = r
      audio.rankUp(r)
      this.onRankUp?.(r)
    } else this.rank = r
    this.tally.bestRank = Math.max(this.tally.bestRank, this.rank)
  }

  private hit(n: number) {
    this.combo += n
    this.comboTimer = 3
    this.tally.bestCombo = Math.max(this.tally.bestCombo, this.combo)
  }

  log(text: string, pts: number, big = false) {
    const last = this.feed[this.feed.length - 1]
    if (last && last.base === text && this.clock - last.at < 2) {
      last.n++
      last.pts += pts
      last.text = `${text} ×${last.n}`
      last.at = this.clock
      last.id = feedId++
      return
    }
    this.feed.push({ id: feedId++, text, pts, at: this.clock, big, base: text, n: 1 })
    if (this.feed.length > 7) this.feed.shift()
  }

  kill(kind: KillKind, count: number, _at?: THREE.Vector3) {
    if (count <= 0) return
    const pts = Math.round(KILL_POINTS[kind] * count * this.mult)
    this.points += pts
    this.addStyle(KILL_STYLE[kind] * Math.min(count, 12))
    this.hit(count)
    if (kind === 'soldier' || kind === 'archer') this.tally.soldiers += count
    if (kind === 'airship') this.tally.airships += count
    if (kind === 'cannon') this.tally.cannons += count
    if (kind === 'titan') this.tally.titans += count
    if (kind === 'warhead') this.tally.warheads += count
    if (kind === 'moon') this.tally.moons += count
    if (kind !== 'soldier' && kind !== 'archer') {
      const names: Partial<Record<KillKind, string>> = {
        spire: 'Spire felled',
        cannon: 'Artillery silenced',
        airship: 'Airship downed',
        titan: 'COLOSSUS CLEAVED',
        station: 'SOL LANCE DESTROYED',
        meteor: 'Meteor returned',
        missile: 'Missile returned',
        shell: 'Shell returned',
        warhead: 'WARHEAD RETURNED',
        silo: 'SILO ANNIHILATED',
        moon: 'THE MOON, CLEAVED',
        eclipse: 'THE ECLIPSE FALLS',
      }
      this.log(names[kind] ?? kind, pts, KILL_POINTS[kind] >= 2000)
    } else if (count >= 20) this.log(`Massacre ×${count}`, pts)
    this.onKill?.(kind, count)
  }

  parry(tier: number) {
    const pts = Math.round([150, 400, 1200, 5000][tier] * this.mult)
    this.points += pts
    this.addStyle([30, 70, 160, 400][tier])
    this.hit(1)
    this.tally.parries++
    this.tally.perfects++
    if (tier >= 1) this.log(['', 'Parry', 'PERFECT PARRY', 'DIVINE PARRY'][tier], pts, tier >= 2)
  }

  feat(kind: 'heaven' | 'slam' | 'judgment' | 'catch', k: number) {
    const base = { heaven: 300, slam: 100, judgment: 2000, catch: 800 }[kind]
    const pts = Math.round(base * (0.5 + k) * this.mult)
    this.points += pts
    this.addStyle(kind === 'judgment' ? 250 : kind === 'heaven' ? 40 + k * 60 : 25)
    if (kind === 'judgment') this.log('JUDGMENT', pts, true)
  }

  hurt(dmg: number) {
    this.style = Math.max(0, this.style - dmg * 1.6)
    this.tally.damageTaken += dmg
    this.refreshRank()
    if (dmg >= 40) this.combo = 0
  }

  update(rdt: number) {
    this.clock += rdt
    // the meter drains; faster at the top
    this.style = Math.max(0, this.style - rdt * (14 + this.rank * 10))
    this.refreshRank()
    this.comboTimer -= rdt
    if (this.comboTimer <= 0) this.combo = 0
    while (this.feed.length && this.clock - this.feed[0].at > 5) this.feed.shift()
  }

  get now() {
    return this.clock
  }
}
