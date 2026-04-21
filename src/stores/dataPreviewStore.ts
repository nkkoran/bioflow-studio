import { create } from 'zustand'
import type { TransformFilterRule } from '@/types/pipeline'

export type PreviewMode = 'tabular' | 'text' | 'binary' | 'image' | 'pdf'
export type DelimiterOverride = 'auto' | '\t' | ',' | ' ' | ';' | '|'
const SAVED_VIEWS_KEY = 'dataPreview:savedViews:v1'

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
  savedView?: boolean
}

export interface SavedPreviewView {
  id: string
  name: string
  filters: TransformFilterRule[]
  delimiterOverride: DelimiterOverride
  scrollOffset: number
  sort?: { column: string; dir: 'asc' | 'desc' }
  createdAt: number
  updatedAt: number
}

interface DataPreviewStore {
  tabs: DataPreviewTab[]
  activeTabId: string | null
  visibleColumns: Record<string, string[]>
  filters: Record<string, TransformFilterRule[]>
  draftFilters: Record<string, TransformFilterRule[]>
  sort: Record<string, { column: string; dir: 'asc' | 'desc' } | undefined>
  delimiterOverride: Record<string, DelimiterOverride>
  scrollOffset: Record<string, number>
  savedViews: Record<string, SavedPreviewView[]>
  activeSavedViewId: Record<string, string | undefined>
  savedViewsLoaded: boolean
  schemas: Record<string, { columns: string[]; delimiter: string; fetchedAt: number; modified?: number }>

  loadSavedViews: () => Promise<void>
  openFile: (filePath: string, fileName: string, mode?: PreviewMode) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  setTabData: (id: string, data: DataPreviewData) => void
  setVisibleColumns: (filePath: string, columns: string[]) => void
  setFilters: (filePath: string, filters: TransformFilterRule[]) => void
  setDraftFilters: (filePath: string, filters: TransformFilterRule[]) => void
  applyDraftFilters: (filePath: string) => void
  resetDraftFilters: (filePath: string) => void
  setSort: (filePath: string, sort: { column: string; dir: 'asc' | 'desc' } | undefined) => void
  setDelimiterOverride: (filePath: string, delimiter: DelimiterOverride) => void
  setScrollOffset: (filePath: string, offset: number) => void
  setSchema: (filePath: string, schema: { columns: string[]; delimiter: string; modified?: number }) => void
  saveView: (filePath: string, name: string) => Promise<SavedPreviewView | null>
  applySavedView: (filePath: string, viewId: string) => void
  resetFreshView: (filePath: string) => void
  updateSavedView: (filePath: string, viewId: string) => Promise<void>
  renameSavedView: (filePath: string, viewId: string, name: string) => Promise<void>
  deleteSavedView: (filePath: string, viewId: string) => Promise<void>
  clearTabs: () => void
}

let nextPreviewId = 1

export const useDataPreviewStore = create<DataPreviewStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  visibleColumns: {},
  filters: {},
  draftFilters: {},
  sort: {},
  delimiterOverride: {},
  scrollOffset: {},
  savedViews: {},
  activeSavedViewId: {},
  savedViewsLoaded: false,
  schemas: {},

  loadSavedViews: async () => {
    const raw = await window.api.store.get<Record<string, SavedPreviewView[]>>(SAVED_VIEWS_KEY)
    set({
      savedViews: raw ?? {},
      savedViewsLoaded: true,
    })
  },

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
      const { [filePath]: _filters, ...filters } = state.filters
      const { [filePath]: _draftFilters, ...draftFilters } = state.draftFilters
      const { [filePath]: _sort, ...sort } = state.sort
      const { [filePath]: _activeSavedViewId, ...activeSavedViewId } = state.activeSavedViewId
      return {
        tabs: [...state.tabs, { id, filePath, fileName, mode, data: null, loading: true }],
        activeTabId: id,
        filters,
        draftFilters,
        sort,
        activeSavedViewId,
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
      const { [filePath]: _df, ...draftFilters } = state.draftFilters
      const { [filePath]: _s, ...sort } = state.sort
      return { tabs: filtered, activeTabId: newActiveId, visibleColumns, filters, draftFilters, sort }
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
      draftFilters: { ...state.draftFilters, [filePath]: filters },
      activeSavedViewId: { ...state.activeSavedViewId, [filePath]: undefined },
    })),

  setDraftFilters: (filePath, filters) =>
    set((state) => ({
      draftFilters: { ...state.draftFilters, [filePath]: filters },
    })),

  applyDraftFilters: (filePath) =>
    set((state) => ({
      filters: { ...state.filters, [filePath]: state.draftFilters[filePath] ?? state.filters[filePath] ?? [] },
      activeSavedViewId: { ...state.activeSavedViewId, [filePath]: undefined },
    })),

  resetDraftFilters: (filePath) =>
    set((state) => ({
      draftFilters: { ...state.draftFilters, [filePath]: state.filters[filePath] ?? [] },
    })),

  setSort: (filePath, sort) =>
    set((state) => ({
      sort: { ...state.sort, [filePath]: sort },
      activeSavedViewId: { ...state.activeSavedViewId, [filePath]: undefined },
    })),

  setDelimiterOverride: (filePath, delimiter) =>
    set((state) => ({
      delimiterOverride: { ...state.delimiterOverride, [filePath]: delimiter },
      activeSavedViewId: { ...state.activeSavedViewId, [filePath]: undefined },
      tabs: state.tabs.map((tab) =>
        tab.filePath === filePath && tab.mode === 'tabular'
          ? { ...tab, data: null, loading: true }
          : tab,
      ),
    })),

  setScrollOffset: (filePath, offset) =>
    set((state) => ({
      scrollOffset: { ...state.scrollOffset, [filePath]: offset },
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

  saveView: async (filePath, name) => {
    const trimmed = name.trim()
    if (!trimmed) return null
    const state = get()
    const now = Date.now()
    const view: SavedPreviewView = {
      id: `view-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      filters: state.filters[filePath] ?? [],
      delimiterOverride: state.delimiterOverride[filePath] ?? 'auto',
      scrollOffset: state.scrollOffset[filePath] ?? 0,
      sort: state.sort[filePath],
      createdAt: now,
      updatedAt: now,
    }
    const next = {
      ...state.savedViews,
      [filePath]: [...(state.savedViews[filePath] ?? []), view],
    }
    set({
      savedViews: next,
      activeSavedViewId: { ...state.activeSavedViewId, [filePath]: view.id },
    })
    await window.api.store.set(SAVED_VIEWS_KEY, next)
    return view
  },

  applySavedView: (filePath, viewId) =>
    set((state) => {
      const view = (state.savedViews[filePath] ?? []).find((entry) => entry.id === viewId)
      if (!view) return state
      return {
        filters: { ...state.filters, [filePath]: view.filters },
        draftFilters: { ...state.draftFilters, [filePath]: view.filters },
        delimiterOverride: { ...state.delimiterOverride, [filePath]: view.delimiterOverride },
        scrollOffset: { ...state.scrollOffset, [filePath]: view.scrollOffset },
        sort: { ...state.sort, [filePath]: view.sort },
        activeSavedViewId: { ...state.activeSavedViewId, [filePath]: view.id },
        tabs: state.tabs.map((tab) =>
          tab.filePath === filePath && tab.mode === 'tabular'
            ? { ...tab, data: null, loading: true, savedView: true }
            : tab,
        ),
      }
    }),

  resetFreshView: (filePath) =>
    set((state) => {
      const { [filePath]: _filters, ...filters } = state.filters
      const { [filePath]: _sort, ...sort } = state.sort
      const nextActive = { ...state.activeSavedViewId, [filePath]: undefined }
      return {
        filters,
        draftFilters: { ...state.draftFilters, [filePath]: [] },
        sort,
        delimiterOverride: { ...state.delimiterOverride, [filePath]: 'auto' },
        scrollOffset: { ...state.scrollOffset, [filePath]: 0 },
        activeSavedViewId: nextActive,
        tabs: state.tabs.map((tab) =>
          tab.filePath === filePath && tab.mode === 'tabular'
            ? { ...tab, data: null, loading: true, savedView: false }
            : tab,
        ),
      }
    }),

  updateSavedView: async (filePath, viewId) => {
    const state = get()
    const current = state.savedViews[filePath] ?? []
    const next = current.map((view) =>
      view.id === viewId
        ? {
            ...view,
            filters: state.filters[filePath] ?? [],
            delimiterOverride: state.delimiterOverride[filePath] ?? 'auto',
            scrollOffset: state.scrollOffset[filePath] ?? 0,
            sort: state.sort[filePath],
            updatedAt: Date.now(),
          }
        : view,
    )
    set({
      savedViews: { ...state.savedViews, [filePath]: next },
      activeSavedViewId: { ...state.activeSavedViewId, [filePath]: viewId },
    })
    await window.api.store.set(SAVED_VIEWS_KEY, { ...state.savedViews, [filePath]: next })
  },

  renameSavedView: async (filePath, viewId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const state = get()
    const next = (state.savedViews[filePath] ?? []).map((view) =>
      view.id === viewId ? { ...view, name: trimmed, updatedAt: Date.now() } : view,
    )
    set({ savedViews: { ...state.savedViews, [filePath]: next } })
    await window.api.store.set(SAVED_VIEWS_KEY, { ...state.savedViews, [filePath]: next })
  },

  deleteSavedView: async (filePath, viewId) => {
    const state = get()
    const nextViews = (state.savedViews[filePath] ?? []).filter((view) => view.id !== viewId)
    const nextSavedViews = { ...state.savedViews, [filePath]: nextViews }
    const nextActive = { ...state.activeSavedViewId, [filePath]: state.activeSavedViewId[filePath] === viewId ? undefined : state.activeSavedViewId[filePath] }
    set({ savedViews: nextSavedViews, activeSavedViewId: nextActive })
    await window.api.store.set(SAVED_VIEWS_KEY, nextSavedViews)
  },

  clearTabs: () => set({
    tabs: [],
    activeTabId: null,
    visibleColumns: {},
    filters: {},
    sort: {},
    scrollOffset: {},
  }),
}))
