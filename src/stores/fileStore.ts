import { create } from 'zustand'
import type { RemoteFileEntry, SortField, SortDirection } from '@/types'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'

interface FileStore {
  cwd: string
  entries: RemoteFileEntry[]
  loading: boolean
  error: string | null
  bookmarks: string[]
  sortField: SortField
  sortDirection: SortDirection
  selectedPaths: string[]

  navigate: (path: string) => Promise<void>
  refresh: () => Promise<void>
  addBookmark: (path: string) => void
  removeBookmark: (path: string) => void
  setSort: (field: SortField, direction: SortDirection) => void
  selectFile: (path: string) => void
  deselectFile: (path: string) => void
  clearSelection: () => void
}

/**
 * Route file operations through either local or SFTP based on connection type.
 */
async function listDirectory(path: string): Promise<RemoteFileEntry[]> {
  const { activeConnectionId } = useConnectionStore.getState()
  if (!activeConnectionId) throw new Error('Not connected')

  if (activeConnectionId === LOCAL_CONNECTION_ID) {
    return window.api.local.ls(path)
  } else {
    return window.api.sftp.ls(activeConnectionId, path)
  }
}

export async function headFile(filePath: string, lines: number): Promise<string> {
  const { activeConnectionId } = useConnectionStore.getState()
  if (!activeConnectionId) throw new Error('Not connected')

  if (activeConnectionId === LOCAL_CONNECTION_ID) {
    return window.api.local.head(filePath, lines)
  } else {
    return window.api.sftp.head(activeConnectionId, filePath, lines)
  }
}

export const useFileStore = create<FileStore>((set, get) => ({
  cwd: '~',
  entries: [],
  loading: false,
  error: null,
  bookmarks: [],
  sortField: 'name',
  sortDirection: 'asc',
  selectedPaths: [],

  navigate: async (path) => {
    set({ loading: true, error: null, selectedPaths: [] })
    try {
      const entries = await listDirectory(path)
      set({ cwd: path, entries, loading: false })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to list directory'
      set({ error: message, loading: false })
    }
  },

  refresh: async () => {
    const { cwd } = get()
    await get().navigate(cwd)
  },

  addBookmark: (path) =>
    set((state) =>
      state.bookmarks.includes(path)
        ? state
        : { bookmarks: [...state.bookmarks, path] }
    ),

  removeBookmark: (path) =>
    set((state) => ({
      bookmarks: state.bookmarks.filter((b) => b !== path),
    })),

  setSort: (field, direction) => set({ sortField: field, sortDirection: direction }),

  selectFile: (path) =>
    set((state) =>
      state.selectedPaths.includes(path)
        ? state
        : { selectedPaths: [...state.selectedPaths, path] }
    ),

  deselectFile: (path) =>
    set((state) => ({
      selectedPaths: state.selectedPaths.filter((p) => p !== path),
    })),

  clearSelection: () => set({ selectedPaths: [] }),
}))
