import { create } from 'zustand'
import type { ConnectionConfig, ConnectionState, LoginPolicy } from '@/types'

export const LOCAL_CONNECTION_ID = '__local__'

function normalizeConnectionConfig(config: ConnectionConfig): ConnectionConfig {
  return {
    ...config,
    name: config.name.trim(),
    host: config.host.trim(),
    username: config.username.trim(),
    privateKeyPath: config.privateKeyPath?.trim(),
    alias: config.alias?.trim(),
    defaultDirectory: config.defaultDirectory?.trim(),
  }
}

interface ConnectionEntry {
  config: ConnectionConfig
  status: ConnectionState
  connectedAt: number | null
  isLocal: boolean
  reused?: boolean
}

interface ConnectionStore {
  connections: Record<string, ConnectionEntry>
  activeConnectionId: string | null
  loginPolicy: Record<string, LoginPolicy>

  connect: (config: ConnectionConfig) => Promise<void>
  connectLocal: (directory?: string) => Promise<void>
  disconnect: (id: string) => Promise<void>
  setActiveConnection: (id: string | null) => void
  updateStatus: (id: string, status: ConnectionState) => void
  loadLoginPolicy: (id: string, options?: { force?: boolean }) => Promise<LoginPolicy | null>
  isLocalConnection: () => boolean
  /**
   * Re-populate the store from live connections held in the main process.
   * Call this on renderer mount — after a window reload the main-process
   * ssh2 Clients are still open, but the renderer's Zustand state was wiped,
   * so the UI would show "not connected" even though SSH is alive.
   */
  hydrateFromMain: () => Promise<void>
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  connections: {},
  activeConnectionId: null,
  loginPolicy: {},

  connect: async (config) => {
    const cleanConfig = normalizeConnectionConfig(config)
    const tempId = `${cleanConfig.host}-${cleanConfig.username}`
    set((state) => ({
      connections: {
        ...state.connections,
          [tempId]: { config: cleanConfig, status: 'connecting', connectedAt: null, isLocal: false },
      },
    }))

    try {
      const result = await window.api.ssh.connect(cleanConfig)
      set((state) => ({
        connections: {
          ...state.connections,
          [result.id]: {
            config: cleanConfig,
            status: 'connected',
            connectedAt: Date.now(),
            isLocal: false,
            reused: result.reused,
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
      void get().loadLoginPolicy(result.id).catch((err) => {
        console.warn('[connectionStore] login policy load failed:', err)
      })
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
        const { [id]: _policy, ...loginPolicy } = state.loginPolicy
        return {
          connections: rest,
          loginPolicy,
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

  loadLoginPolicy: async (id, options) => {
    const entry = get().connections[id]
    if (!entry || entry.isLocal) return null
    if (!window.api.cluster?.loginPolicy) return null
    if (!options?.force && get().loginPolicy[id]) return get().loginPolicy[id]
    const policy = await window.api.cluster.loginPolicy(id)
    set((state) => ({
      loginPolicy: {
        ...state.loginPolicy,
        [id]: policy,
      },
    }))
    return policy
  },

  isLocalConnection: () => {
    return get().activeConnectionId === LOCAL_CONNECTION_ID
  },

  hydrateFromMain: async () => {
    // Main-process ssh2 Clients survive renderer reloads, but the Zustand
    // store starts empty on mount. Ask the main process for its live
    // connections and re-populate so the UI reflects reality.
    if (typeof window === 'undefined' || !window.api?.ssh?.listConnections) return
    try {
      const live = await window.api.ssh.listConnections()
      if (!live || live.length === 0) return
      set((state) => {
        const next = { ...state.connections }
        for (const entry of live) {
          // Don't clobber an existing local entry, and don't overwrite a
          // connection that already exists (preserve any unsaved state).
          if (next[entry.id]) continue
          next[entry.id] = {
            config: entry.config as ConnectionConfig,
            status: entry.connected ? 'connected' : 'disconnected',
            connectedAt: entry.connectedAt,
            isLocal: false,
            reused: false,
          }
        }
        // If nothing is active and we hydrated at least one connection, pick
        // the most recently connected as the active one.
        let activeId = state.activeConnectionId
        if (!activeId) {
          const sorted = [...live].sort((a, b) => b.connectedAt - a.connectedAt)
          if (sorted[0]) activeId = sorted[0].id
        }
        return { connections: next, activeConnectionId: activeId }
      })
      for (const entry of live) {
        if (entry.connected) {
          void get().loadLoginPolicy(entry.id).catch((err) => {
            console.warn('[connectionStore] login policy hydrate failed:', err)
          })
        }
      }
    } catch (err) {
      console.error('[connectionStore] hydrateFromMain failed:', err)
    }
  },
}))

// Subscribe to SSH status change events from main process
if (typeof window !== 'undefined' && window.api?.ssh?.onStatusChange) {
  window.api.ssh.onStatusChange(
    (_event: any, data: { connectionId: string; status: string }) => {
      const store = useConnectionStore.getState()
      store.updateStatus(data.connectionId, data.status as ConnectionState)
      if (data.status === 'connected') {
        void store.loadLoginPolicy(data.connectionId, { force: true }).catch((err) => {
          console.warn('[connectionStore] login policy status refresh failed:', err)
        })
      }
    }
  )
}
