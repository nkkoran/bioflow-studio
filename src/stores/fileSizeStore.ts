import { create } from 'zustand'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'

const TTL_MS = 30_000

interface CachedSize {
  size: number
  fetchedAt: number
}

interface FileSizeState {
  sizes: Record<string, CachedSize>
  getSize: (connectionId: string, path: string) => Promise<number>
  clear: (connectionId?: string) => void
  pruneConnections: (liveConnectionIds: string[]) => void
}

function keyFor(connectionId: string, path: string): string {
  return `${connectionId}:${path}`
}

export const useFileSizeStore = create<FileSizeState>((set, get) => ({
  sizes: {},

  getSize: async (connectionId, path) => {
    if (!path) return 0
    const key = keyFor(connectionId, path)
    const cached = get().sizes[key]
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.size

    try {
      const stat = connectionId === LOCAL_CONNECTION_ID
        ? await window.api.local.stat(path)
        : await window.api.sftp.stat(connectionId, path)
      const size = stat.isDirectory ? 0 : stat.size
      set((state) => ({ sizes: { ...state.sizes, [key]: { size, fetchedAt: Date.now() } } }))
      return size
    } catch {
      set((state) => ({ sizes: { ...state.sizes, [key]: { size: 0, fetchedAt: Date.now() } } }))
      return 0
    }
  },

  clear: (connectionId) =>
    set((state) => {
      if (!connectionId) return { sizes: {} }
      return {
        sizes: Object.fromEntries(
          Object.entries(state.sizes).filter(([key]) => !key.startsWith(`${connectionId}:`)),
        ),
      }
    }),

  pruneConnections: (liveConnectionIds) => {
    const live = new Set([LOCAL_CONNECTION_ID, ...liveConnectionIds])
    set((state) => ({
      sizes: Object.fromEntries(Object.entries(state.sizes).filter(([key]) => live.has(key.split(':', 1)[0]))),
    }))
  },
}))

useConnectionStore.subscribe((state) => {
  useFileSizeStore.getState().pruneConnections(
    Object.entries(state.connections)
      .filter(([, connection]) => connection.status === 'connected')
      .map(([id]) => id),
  )
})
