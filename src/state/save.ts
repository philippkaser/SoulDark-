import { BASE_STATS, type Stats } from '../../shared/combat'
import type { Look } from '../../shared/protocol'

export type Quality = 'low' | 'medium' | 'high'

export interface Settings {
  quality: Quality
  sensitivity: number
  invertY: boolean
  volume: number
  music: number
}

export interface SaveData {
  name: string
  look: Look
  room: string
  stats: Stats
  souls: number
  /** Souls left where we last died. */
  stain: { x: number; z: number; souls: number } | null
  bonfireLit: boolean
  settings: Settings
  deaths: number
  bossKills: number
}

const KEY = 'souldark.save.v1'

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  sensitivity: 1,
  invertY: false,
  volume: 0.8,
  music: 0.7,
}

const defaults = (): SaveData => ({
  name: '',
  look: { cloak: 0, crest: 0 },
  room: 'lordran',
  stats: { ...BASE_STATS },
  souls: 0,
  stain: null,
  bonfireLit: false,
  settings: { ...DEFAULT_SETTINGS },
  deaths: 0,
  bossKills: 0,
})

/** `?q=low|medium|high` forces a graphics preset (handy for slow machines and testing). */
function withOverrides(d: SaveData): SaveData {
  const q = new URLSearchParams(location.search).get('q')
  if (q === 'low' || q === 'medium' || q === 'high') d.settings = { ...d.settings, quality: q }
  return d
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return withOverrides(defaults())
    const parsed = JSON.parse(raw)
    const d = defaults()
    return withOverrides({
      ...d,
      ...parsed,
      look: { ...d.look, ...parsed.look },
      stats: { ...d.stats, ...parsed.stats },
      settings: { ...d.settings, ...parsed.settings },
    })
  } catch {
    return withOverrides(defaults())
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
export function persist(data: SaveData) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(data))
    } catch {
      /* storage may be unavailable (private mode) */
    }
  }, 250)
}
