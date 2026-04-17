import { create } from 'zustand'

type BottomPanelMode = 'terminal' | 'data' | 'jobs'
type Theme = 'dark'

/**
 * File-picker hand-off between the pipeline inspector (requester) and the
 * sidebar FileExplorer (picker). When `active`, clicking a file in the
 * explorer resolves the pick instead of the normal select/preview.
 */
export interface FilePickMode {
  active: boolean
  nodeId: string | null
  /** Display label shown in the picker banner ("Picking input for …"). */
  requesterLabel?: string
  /** Optional list of file-type hints used to visually dim non-matching files. */
  accept?: string[]
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

  setSidebarWidth: (width: number) => void
  setBottomPanelHeight: (height: number) => void
  toggleBottomPanel: () => void
  setBottomPanelMode: (mode: BottomPanelMode) => void
  setTheme: (theme: Theme) => void
  setRightPanelWidth: (width: number) => void
  toggleRightPanel: () => void

  /** Ask the FileExplorer to pick a file for a node. */
  startFilePick: (args: { nodeId: string; requesterLabel?: string; accept?: string[] }) => void
  /** Called by FileExplorer when the user picks a file. */
  resolveFilePick: (path: string, fileType: string) => void
  /** Abort without picking (Escape / close button). */
  cancelFilePick: () => void
}

export const useUIStore = create<UIStore>((set, get) => ({
  sidebarWidth: 280,
  bottomPanelHeight: 250,
  bottomPanelMode: 'terminal',
  bottomPanelOpen: true,
  theme: 'dark',
  rightPanelWidth: 320,
  rightPanelOpen: false,
  filePickMode: { active: false, nodeId: null },

  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: height }),
  toggleBottomPanel: () => set((state) => ({ bottomPanelOpen: !state.bottomPanelOpen })),
  setBottomPanelMode: (mode) => set({ bottomPanelMode: mode, bottomPanelOpen: true }),
  setTheme: (theme) => set({ theme }),
  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),

  startFilePick: ({ nodeId, requesterLabel, accept }) => {
    set({ filePickMode: { active: true, nodeId, requesterLabel, accept } })
  },
  resolveFilePick: (path, fileType) => {
    const mode = get().filePickMode
    if (!mode.active || !mode.nodeId) return
    // Defer the pipelineStore import to runtime to avoid a circular dep with
    // stores that themselves import uiStore (runStore does).
    import('@/stores/pipelineStore').then(({ usePipelineStore }) => {
      usePipelineStore.getState().updateNodeData(mode.nodeId!, { path, fileType })
    })
    set({ filePickMode: { active: false, nodeId: null } })
  },
  cancelFilePick: () => set({ filePickMode: { active: false, nodeId: null } }),
}))
