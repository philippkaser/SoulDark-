export type Quality = 'low' | 'medium' | 'high'

export interface Settings {
  quality: Quality
  sensitivity: number
  invertY: boolean
  volume: number
  music: number
  /** 0..1 camera shake scale. */
  shake: number
  /** Reduce full-screen flashes and inverted impact frames. */
  reduceFlashes: boolean
  /** Gamepad rumble on hits, parries, blasts and footsteps. */
  vibration: boolean
}

export interface SaveData {
  settings: Settings
  /** Highest campaign wave reached (index), to offer "continue". */
  reached: number
  bestScore: number
  victories: number
  /** Lifetime feats, for bragging on the title screen. */
  nukesParried: number
  soldiersFelled: number
}

const KEY = 'skycleaver.save.v1'

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  sensitivity: 1,
  invertY: false,
  volume: 0.8,
  music: 0.65,
  shake: 1,
  reduceFlashes: false,
  vibration: true,
}

const defaults = (): SaveData => ({
  settings: { ...DEFAULT_SETTINGS },
  reached: 0,
  bestScore: 0,
  victories: 0,
  nukesParried: 0,
  soldiersFelled: 0,
})

/** `?q=low|medium|high` forces a graphics preset (handy for slow machines and testing). */
function withOverrides(d: SaveData): SaveData {
  if (typeof location === 'undefined') return d
  const q = new URLSearchParams(location.search).get('q')
  if (q === 'low' || q === 'medium' || q === 'high') d.settings = { ...d.settings, quality: q }
  return d
}

export function loadSave(): SaveData {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
    if (!raw) return withOverrides(defaults())
    const parsed = JSON.parse(raw)
    const d = defaults()
    return withOverrides({ ...d, ...parsed, settings: { ...d.settings, ...parsed.settings } })
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
