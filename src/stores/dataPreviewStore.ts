import { create } from 'zustand'
import type { TransformFilterRule } from '@/types/pipeline'

export type PreviewMode = 'tabular' | 'text' | 'binary' | 'image' | 'pdf'

interface DataPreviewData {
  headers: string[]
  rows: string[][]
  delimiter: string
  rawText?: string
}

interface DataPreviewTab {
  id: string
  filePath: string
  fileName: string
  mode: PreviewMode
  data: DataPreviewData | null
  loading: boolean
}

interface DataPreviewStore {
  tabs: DataPreviewTab[]
  activeTabId: string | null
  visibleColumns: Record<string, string[]>
  filters: Record<string, TransformFilterRule[]>
  sort: Record<string, { column: string; dir: 'asc' | 'desc' } | undefined>
  schemas: Record<string, { columns: string[]; delimiter: string; fetchedAt: number; modified?: number }>

  openFile: (filePath: string, fileName: string, mode?: PreviewMode) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  setTabData: (id: string, data: DataPreviewData) => void
  setVisibleColumns: (filePath: string, columns: string[]) => void
  setFilters: (filePath: string, filters: TransformFilterRule[]) => void
  setSort: (filePath: string, sort: { column: string; dir: 'asc' | 'desc' } | undefined) => void
  setSchema: (filePath: string, schema: { columns: string[]; delimiter: string; modified?: number }) => void
  clearTabs: () => void
}

let nextPreviewId = 1

export const useDataPreviewStore = create<DataPreviewStore>((set) => ({
  tabs: [],
  activeTabId: null,
  visibleColumns: {},
  filters: {},
  sort: {},
  schemas: {},

  openFile: (filePath, fileName, mode = 'tabular') => {
    set((state) => {
      // If already open, just activate it
      const existing = state.tabs.find((t) => t.filePath === filePath)
      if (existing) {
        return {
          activeTabId: existing.id,
          tabs: state.tabs.map((t) =>
            t.id === existing.id && t.mode !== mode
              ? { ...t, mode, loading: true, data: null }
              : t,
          ),
        }
      }

      const id = `preview-${nextPreviewId++}`
      return {
        tabs: [...state.tabs, { id, filePath, fileName, mode, data: null, loading: true }],
        activeTabId: id,
      }
    })
  },

  closeTab: (id) =>
    set((state) => {
      const closing = state.tabs.find((t) => t.id === id)
      const filtered = state.tabs.filter((t) => t.id !== id)
      const wasActive = state.activeTabId === id
      const newActiveId = wasActive
        ? (filtered.length > 0 ? filtered[filtered.length - 1].id : null)
        : state.activeTabId

      // Drop per-file view state so reopening the file gives a clean slate.
      // Schemas remain cached — they don't depend on user selections and are
      // useful for the tool-inspector column picker (item 8).
      if (!closing) return { tabs: filtered, activeTabId: newActiveId }
      const filePath = closing.filePath
      const stillOpen = filtered.some((t) => t.filePath === filePath)
      if (stillOpen) return { tabs: filtered, activeTabId: newActiveId }
      const { [filePath]: _vc, ...visibleColumns } = state.visibleColumns
      const { [filePath]: _f, ...filters } = state.filters
      const { [filePath]: _s, ...sort } = state.sort
      return { tabs: filtered, activeTabId: newActiveId, visibleColumns, filters, sort }
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  setTabData: (id, data) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id)
      return {
        tabs: state.tabs.map((t) =>
          t.id === id ? { ...t, data, loading: false } : t
        ),
        schemas: tab
          ? {
              ...state.schemas,
              [tab.filePath]: {
                columns: data.headers,
                delimiter: data.delimiter,
                fetchedAt: Date.now(),
              },
            }
          : state.schemas,
      }
    }),

  setVisibleColumns: (filePath, columns) =>
    set((state) => ({
      visibleColumns: { ...state.visibleColumns, [filePath]: columns },
    })),

  setFilters: (filePath, filters) =>
    set((state) => ({
      filters: { ...state.filters, [filePath]: filters },
    })),

  setSort: (filePath, sort) =>
    set((state) => ({
      sort: { ...state.sort, [filePath]: sort },
    })),

  setSchema: (filePath, schema) =>
    set((state) => ({
      schemas: {
        ...state.schemas,
        [filePath]: {
          ...schema,
          fetchedAt: Date.now(),
        },
      },
    })),

  clearTabs: () => set({
    tabs: [],
    activeTabId: null,
    visibleColumns: {},
    filters: {},
    sort: {},
  }),
}))
