import { create } from 'zustand'

interface TerminalTab {
  id: string
  terminalId: string
  title: string
  active: boolean
}

interface TerminalStore {
  tabs: TerminalTab[]
  activeTabId: string | null

  addTab: (terminalId: string, title: string) => void
  removeTab: (id: string) => void
  setActiveTab: (id: string) => void
}

let nextTabId = 1

export const useTerminalStore = create<TerminalStore>((set) => ({
  tabs: [],
  activeTabId: null,

  addTab: (terminalId, title) => {
    const id = `term-${nextTabId++}`
    set((state) => ({
      tabs: [
        ...state.tabs.map((t) => ({ ...t, active: false })),
        { id, terminalId, title, active: true },
      ],
      activeTabId: id,
    }))
  },

  removeTab: (id) =>
    set((state) => {
      const filtered = state.tabs.filter((t) => t.id !== id)
      const wasActive = state.activeTabId === id
      const newActiveId = wasActive
        ? (filtered.length > 0 ? filtered[filtered.length - 1].id : null)
        : state.activeTabId

      return {
        tabs: filtered.map((t) => ({ ...t, active: t.id === newActiveId })),
        activeTabId: newActiveId,
      }
    }),

  setActiveTab: (id) =>
    set((state) => ({
      tabs: state.tabs.map((t) => ({ ...t, active: t.id === id })),
      activeTabId: id,
    })),
}))
