import { create } from 'zustand'
import type { ConnectionConfig, ConnectionState } from '@/types'

export const LOCAL_CONNECTION_ID = '__local__'

interface ConnectionEntry {
  config: ConnectionConfig
  status: ConnectionState
  connectedAt: number | null
  isLocal: boolean
}

interface ConnectionStore {
  connections: Record<string, ConnectionEntry>
  activeConnectionId: string | null

  connect: (config: ConnectionConfig) => Promise<void>
  connectLocal: (directory?: string) => Promise<void>
  disconnect: (id: string) => Promise<void>
  setActiveConnection: (id: string | null) => void
  updateStatus: (id: string, status: ConnectionState) => void
  isLocalConnection: () => boolean
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  connections: {},
  activeConnectionId: null,

  connect: async (config) => {
    const tempId = `${config.host}-${config.username}`
    set((state) => ({
      connections: {
        ...state.connections,
        [tempId]: { config, status: 'connecting', connectedAt: null, isLocal: false },
      },
    }))

    try {
      const result = await window.api.ssh.connect(config)
      set((state) => ({
        connections: {
          ...state.connections,
          [result.id]: {
            config,
            status: 'connected',
            connectedAt: Date.now(),
            isLocal: false,
          },
        },
        activeConnectionId: result.id,
      }))

      // Clean up temp entry if id differs
      if (result.id !== tempId) {
        set((state) => {
          const { [tempId]: _, ...rest } = state.connections
          return { connections: { ...rest, [result.id]: state.connections[result.id] } }
        })
      }
    } catch (err) {
      set((state) => ({
        connections: {
          ...state.connections,
          [tempId]: { ...state.connections[tempId], status: 'error' },
        },
      }))
      throw err
    }
  },

  connectLocal: async (directory?: string) => {
    const homeDir = await window.api.local.homedir()
    const defaultDir = directory || homeDir

    const localConfig: ConnectionConfig = {
      name: 'Local',
      host: 'localhost',
      port: 0,
      username: 'local',
      authMethod: 'agent',
      defaultDirectory: defaultDir,
    }

    set({
      connections: {
        ...get().connections,
        [LOCAL_CONNECTION_ID]: {
          config: localConfig,
          status: 'connected',
          connectedAt: Date.now(),
          isLocal: true,
        },
      },
      activeConnectionId: LOCAL_CONNECTION_ID,
    })
  },

  disconnect: async (id) => {
    const entry = get().connections[id]
    try {
      if (!entry?.isLocal) {
        await window.api.ssh.disconnect(id)
      }
    } finally {
      set((state) => {
        const { [id]: _, ...rest } = state.connections
        return {
          connections: rest,
          activeConnectionId:
            state.activeConnectionId === id ? null : state.activeConnectionId,
        }
      })
    }
  },

  setActiveConnection: (id) => set({ activeConnectionId: id }),

  updateStatus: (id, status) =>
    set((state) => {
      const entry = state.connections[id]
      if (!entry) return state
      return {
        connections: {
          ...state.connections,
          [id]: {
            ...entry,
            status,
            connectedAt: status === 'connected' ? (entry.connectedAt ?? Date.now()) : entry.connectedAt,
          },
        },
      }
    }),

  isLocalConnection: () => {
    return get().activeConnectionId === LOCAL_CONNECTION_ID
  },
}))

// Subscribe to SSH status change events from main process
if (typeof window !== 'undefined' && window.api?.ssh?.onStatusChange) {
  window.api.ssh.onStatusChange(
    (_event: any, data: { connectionId: string; status: string }) => {
      useConnectionStore.getState().updateStatus(data.connectionId, data.status as ConnectionState)
    }
  )
}
