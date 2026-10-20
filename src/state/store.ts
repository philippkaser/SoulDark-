import { create } from 'zustand'
import { levelCost, statsLevel, type Stats } from '../../shared/combat'
import type { GroundMessage, Look } from '../../shared/protocol'
import { loadSave, persist, type SaveData, type Settings } from './save'

export type BannerKind = 'death' | 'victory' | 'lit' | 'info' | 'retrieved'
export type Menu = null | 'bonfire' | 'levelup' | 'compose' | 'read' | 'pause' | 'gestures'

export interface Banner {
  id: number
  text: string
  kind: BannerKind
  sub?: string
}

export interface ChatLine {
  id: number
  name: string
  text: string
  at: number
  system?: boolean
}

export interface BossBar {
  name: string
  hp: number
  max: number
}

interface UIState {
  screen: 'title' | 'loading' | 'game'
  mode: 'online' | 'offline' | null
  roomName: string
  save: SaveData
  prompt: string | null
  banner: Banner | null
  boss: BossBar | null
  menu: Menu
  reading: GroundMessage | null
  chat: ChatLine[]
  chatOpen: boolean
  remotesVersion: number
  worldVersion: number
  pointerLocked: boolean
  showControls: boolean

  setScreen: (s: UIState['screen']) => void
  setMode: (m: UIState['mode'], room: string) => void
  setPrompt: (p: string | null) => void
  showBanner: (text: string, kind: BannerKind, sub?: string) => void
  clearBanner: (id?: number) => void
  setBoss: (b: BossBar | null) => void
  setMenu: (m: Menu) => void
  setReading: (m: GroundMessage | null) => void
  pushChat: (line: Omit<ChatLine, 'id' | 'at'>) => void
  setChatOpen: (v: boolean) => void
  bumpRemotes: () => void
  bumpWorld: () => void
  setPointerLocked: (v: boolean) => void
  setShowControls: (v: boolean) => void

  updateSave: (patch: Partial<SaveData>) => void
  setIdentity: (name: string, look: Look, room: string) => void
  updateSettings: (patch: Partial<Settings>) => void
  addSouls: (n: number) => void
  levelUp: (stat: keyof Stats) => boolean
}

let bannerId = 1
let chatId = 1

export const useUI = create<UIState>((set, get) => ({
  screen: 'title',
  mode: null,
  roomName: 'lordran',
  save: loadSave(),
  prompt: null,
  banner: null,
  boss: null,
  menu: null,
  reading: null,
  chat: [],
  chatOpen: false,
  remotesVersion: 0,
  worldVersion: 0,
  pointerLocked: false,
  showControls: false,

  setScreen: (screen) => set({ screen }),
  setMode: (mode, roomName) => set({ mode, roomName }),
  setPrompt: (prompt) => {
    if (get().prompt !== prompt) set({ prompt })
  },
  showBanner: (text, kind, sub) => set({ banner: { id: bannerId++, text, kind, sub } }),
  clearBanner: (id) => {
    const b = get().banner
    if (!b || (id !== undefined && b.id !== id)) return
    set({ banner: null })
  },
  setBoss: (boss) => {
    const cur = get().boss
    if (cur === boss) return
    if (cur && boss && cur.hp === boss.hp && cur.max === boss.max && cur.name === boss.name) return
    set({ boss })
  },
  setMenu: (menu) => set({ menu }),
  setReading: (reading) => set({ reading }),
  pushChat: (line) =>
    set((s) => ({ chat: [...s.chat.slice(-30), { ...line, id: chatId++, at: performance.now() }] })),
  setChatOpen: (chatOpen) => set({ chatOpen }),
  bumpRemotes: () => set((s) => ({ remotesVersion: s.remotesVersion + 1 })),
  bumpWorld: () => set((s) => ({ worldVersion: s.worldVersion + 1 })),
  setPointerLocked: (pointerLocked) => set({ pointerLocked }),
  setShowControls: (showControls) => set({ showControls }),

  updateSave: (patch) => {
    const save = { ...get().save, ...patch }
    persist(save)
    set({ save })
  },
  setIdentity: (name, look, room) => get().updateSave({ name, look, room }),
  updateSettings: (patch) => get().updateSave({ settings: { ...get().save.settings, ...patch } }),
  addSouls: (n) => get().updateSave({ souls: Math.max(0, get().save.souls + n) }),
  levelUp: (stat) => {
    const { save } = get()
    const cost = levelCost(statsLevel(save.stats))
    if (save.souls < cost || save.stats[stat] >= 60) return false
    get().updateSave({ souls: save.souls - cost, stats: { ...save.stats, [stat]: save.stats[stat] + 1 } })
    return true
  },
}))
