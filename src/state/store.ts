import { create } from 'zustand'
import { loadSave, persist, type SaveData, type Settings } from './settings'

export type Screen = 'title' | 'game' | 'results'
export type Mode = 'campaign' | 'sandbox'

export interface Banner {
  id: number
  kind: 'wave' | 'warning' | 'boss' | 'victory' | 'death' | 'info'
  title: string
  sub?: string
}

export interface Stamp {
  id: number
  text: string
  kind: 'parry' | 'perfect' | 'divine' | 'feat' | 'rank' | 'warn'
}

export interface BossBar {
  id: string
  name: string
  hp: number
  max: number
}

export interface Results {
  victory: boolean
  score: number
  rank: number
  wave: number
  tally: import('../game/score').Tally
  time: number
}

interface UIState {
  screen: Screen
  mode: Mode
  paused: boolean
  panel: 'pause' | 'settings' | 'controls' | null
  save: SaveData
  banner: Banner | null
  stamps: Stamp[]
  objective: string | null
  bosses: BossBar[]
  warning: string | null
  results: Results | null
  dead: boolean
  pointerLocked: boolean
  showHelp: boolean
  /** Cinema bars (kill cams). */
  letterbox: boolean

  setScreen: (s: Screen) => void
  setMode: (m: Mode) => void
  setPaused: (p: boolean, panel?: UIState['panel']) => void
  setPanel: (p: UIState['panel']) => void
  showBanner: (b: Omit<Banner, 'id'>) => void
  clearBanner: () => void
  stamp: (text: string, kind: Stamp['kind']) => void
  dropStamp: (id: number) => void
  setObjective: (o: string | null) => void
  setBosses: (b: BossBar[]) => void
  setWarning: (w: string | null) => void
  setResults: (r: Results | null) => void
  setDead: (d: boolean) => void
  setPointerLocked: (v: boolean) => void
  setShowHelp: (v: boolean) => void
  setLetterbox: (v: boolean) => void
  updateSave: (patch: Partial<SaveData>) => void
  updateSettings: (patch: Partial<Settings>) => void
}

let nextId = 1

export const useUI = create<UIState>((set, get) => ({
  screen: 'title',
  mode: 'campaign',
  paused: false,
  panel: null,
  save: loadSave(),
  banner: null,
  stamps: [],
  objective: null,
  bosses: [],
  warning: null,
  results: null,
  dead: false,
  pointerLocked: false,
  showHelp: true,
  letterbox: false,

  setScreen: (screen) => set({ screen }),
  setMode: (mode) => set({ mode }),
  setPaused: (paused, panel = paused ? 'pause' : null) => set({ paused, panel }),
  setPanel: (panel) => set({ panel }),
  showBanner: (b) => set({ banner: { ...b, id: nextId++ } }),
  clearBanner: () => set({ banner: null }),
  stamp: (text, kind) => set((s) => ({ stamps: [...s.stamps.slice(-4), { id: nextId++, text, kind }] })),
  dropStamp: (id) => set((s) => ({ stamps: s.stamps.filter((x) => x.id !== id) })),
  setObjective: (objective) => {
    if (get().objective !== objective) set({ objective })
  },
  setBosses: (bosses) => {
    const cur = get().bosses
    if (cur.length === bosses.length && cur.every((b, i) => b.id === bosses[i].id && Math.round(b.hp) === Math.round(bosses[i].hp) && b.max === bosses[i].max)) return
    set({ bosses })
  },
  setWarning: (warning) => {
    if (get().warning !== warning) set({ warning })
  },
  setResults: (results) => set({ results }),
  setDead: (dead) => set({ dead }),
  setPointerLocked: (pointerLocked) => set({ pointerLocked }),
  setShowHelp: (showHelp) => set({ showHelp }),
  setLetterbox: (letterbox) => {
    if (get().letterbox !== letterbox) set({ letterbox })
  },
  updateSave: (patch) => {
    const save = { ...get().save, ...patch }
    persist(save)
    set({ save })
  },
  updateSettings: (patch) => get().updateSave({ settings: { ...get().save.settings, ...patch } }),
}))
