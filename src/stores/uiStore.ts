import { create } from 'zustand'

type BottomPanelMode = 'terminal' | 'data' | 'jobs' | 'queue'
type Theme = 'dark'

export type FilePickTarget = 'file' | 'directory'

export interface FilePickResult {
  path: string
  /** Present only for file picks. */
  fileType?: string
}

/**
 * File-picker hand-off between a requester (inspector, settings panel, ...) and
 * the sidebar FileExplorer. When `active`, the explorer banner takes over:
 *
 *   - `target === 'file'`       — clicking a file resolves the pick.
 *   - `target === 'directory'`  — a "Select this folder" button resolves with
 *                                 the current `cwd`; file clicks are ignored.
 *
 * Two resolution paths are supported so callers don't have to couple to
 * pipelineStore:
 *   - `onResolve` callback (preferred for non-node callers).
 *   - `nodeId`  — legacy shortcut that writes `{ path, fileType }` onto the
 *                 node's data via `pipelineStore.updateNodeData`.
 */
export interface FilePickMode {
  active: boolean
  target: FilePickTarget
  nodeId: string | null
  requesterLabel?: string
  accept?: string[]
  onResolve?: (result: FilePickResult) => void
}

interface UIStore {
  sidebarWidth: number
  bottomPanelHeight: number
  bottomPanelMode: BottomPanelMode
  bottomPanelOpen: boolean
  theme: Theme
  rightPanelWidth: number
  rightPanelOpen: boolean
  filePickMode: FilePickMode
  advancedExpanded: Record<string, boolean>

  setSidebarWidth: (width: number) => void
  setBottomPanelHeight: (height: number) => void
  toggleBottomPanel: () => void
  setBottomPanelMode: (mode: BottomPanelMode) => void
  setTheme: (theme: Theme) => void
  setRightPanelWidth: (width: number) => void
  toggleRightPanel: () => void
  setAdvancedExpanded: (toolId: string, expanded: boolean) => void
  loadAdvancedExpanded: () => Promise<void>

  /**
   * Ask the FileExplorer to pick a file or folder. Supply either `nodeId` (the
   * legacy node-data shortcut, file picks only) or `onResolve` (any caller).
   */
  startFilePick: (args: {
    target?: FilePickTarget
    nodeId?: string
    requesterLabel?: string
    accept?: string[]
    onResolve?: (result: FilePickResult) => void
  }) => void
  /** Called by FileExplorer when the user picks a file or folder. */
  resolveFilePick: (path: string, fileType?: string) => void
  /** Abort without picking (Escape / close button). */
  cancelFilePick: () => void
}

const IDLE_PICK: FilePickMode = { active: false, target: 'file', nodeId: null }

export const useUIStore = create<UIStore>((set, get) => ({
  sidebarWidth: 280,
  bottomPanelHeight: 250,
  bottomPanelMode: 'terminal',
  bottomPanelOpen: true,
  theme: 'dark',
  rightPanelWidth: 320,
  rightPanelOpen: false,
  filePickMode: IDLE_PICK,
  advancedExpanded: {},

  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: height }),
  toggleBottomPanel: () => set((state) => ({ bottomPanelOpen: !state.bottomPanelOpen })),
  setBottomPanelMode: (mode) => set({ bottomPanelMode: mode, bottomPanelOpen: true }),
  setTheme: (theme) => set({ theme }),
  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  setAdvancedExpanded: (toolId, expanded) => {
    set((state) => {
      const advancedExpanded = { ...state.advancedExpanded, [toolId]: expanded }
      void window.api.store.set('ui:advancedExpanded', advancedExpanded).catch((err) => {
        console.warn('[uiStore] failed to persist advanced params state:', err)
      })
      return { advancedExpanded }
    })
  },
  loadAdvancedExpanded: async () => {
    const stored = await window.api.store.get<Record<string, boolean>>('ui:advancedExpanded')
    if (stored && typeof stored === 'object') set({ advancedExpanded: stored })
  },

  startFilePick: ({ target = 'file', nodeId, requesterLabel, accept, onResolve }) => {
    set({
      filePickMode: {
        active: true,
        target,
        nodeId: nodeId ?? null,
        requesterLabel,
        accept,
        onResolve,
      },
    })
  },
  resolveFilePick: (path, fileType) => {
    const mode = get().filePickMode
    if (!mode.active) return
    if (mode.onResolve) {
      mode.onResolve({ path, fileType })
    } else if (mode.nodeId) {
      // Defer the pipelineStore import to runtime to avoid a circular dep with
      // stores that themselves import uiStore (runStore does).
      const nodeId = mode.nodeId
      import('@/stores/pipelineStore').then(({ usePipelineStore }) => {
        usePipelineStore.getState().updateNodeData(nodeId, { path, fileType })
      })
    }
    set({ filePickMode: IDLE_PICK })
  },
  cancelFilePick: () => set({ filePickMode: IDLE_PICK }),
}))
