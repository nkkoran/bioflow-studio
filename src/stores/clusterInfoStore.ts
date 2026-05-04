import { create } from 'zustand'
import type { ClusterAccountsResult, ClusterModulesResult } from '@/types/ssh'

const ACCOUNT_TTL_MS = 10 * 60 * 1000
const MODULE_TTL_MS = 10 * 60 * 1000

interface ClusterInfoState {
  accountsByConnection: Record<string, ClusterAccountsResult>
  modulesByConnection: Record<string, ClusterModulesResult>
  loadingAccounts: Record<string, boolean>
  loadingModules: Record<string, boolean>
  errorByConnection: Record<string, string | undefined>
  loadAccounts: (connectionId: string, options?: { force?: boolean }) => Promise<ClusterAccountsResult>
  loadModules: (connectionId: string, query?: string, options?: { force?: boolean }) => Promise<ClusterModulesResult>
  clearConnection: (connectionId?: string) => void
}

export const useClusterInfoStore = create<ClusterInfoState>((set, get) => ({
  accountsByConnection: {},
  modulesByConnection: {},
  loadingAccounts: {},
  loadingModules: {},
  errorByConnection: {},

  loadAccounts: async (connectionId, options) => {
    const cached = get().accountsByConnection[connectionId]
    if (!options?.force && cached && Date.now() - cached.cachedAt < ACCOUNT_TTL_MS) {
      return cached
    }

    set((state) => ({
      loadingAccounts: { ...state.loadingAccounts, [connectionId]: true },
      errorByConnection: { ...state.errorByConnection, [connectionId]: undefined },
    }))
    try {
      const result = await window.api.cluster.listAccounts(connectionId)
      set((state) => ({
        accountsByConnection: { ...state.accountsByConnection, [connectionId]: result },
        loadingAccounts: { ...state.loadingAccounts, [connectionId]: false },
      }))
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((state) => ({
        loadingAccounts: { ...state.loadingAccounts, [connectionId]: false },
        errorByConnection: { ...state.errorByConnection, [connectionId]: message },
      }))
      throw err
    }
  },

  loadModules: async (connectionId, query, options) => {
    const needle = String(query ?? '').trim().toLowerCase()
    const cached = get().modulesByConnection[connectionId]
    if (!options?.force && cached && !needle && Date.now() - cached.cachedAt < MODULE_TTL_MS) {
      return needle
        ? { ...cached, modules: cached.modules.filter((entry) => `${entry.name} ${entry.versions.join(' ')}`.toLowerCase().includes(needle)) }
        : cached
    }
    if (!options?.force && cached && needle && cached.modules.length > 0 && Date.now() - cached.cachedAt < MODULE_TTL_MS) {
      return {
        ...cached,
        modules: cached.modules.filter((entry) => `${entry.name} ${entry.versions.join(' ')}`.toLowerCase().includes(needle)),
      }
    }

    set((state) => ({
      loadingModules: { ...state.loadingModules, [connectionId]: true },
      errorByConnection: { ...state.errorByConnection, [connectionId]: undefined },
    }))
    try {
      const result = await window.api.cluster.listModules(connectionId, query)
      set((state) => ({
        modulesByConnection: {
          ...state.modulesByConnection,
          [connectionId]: needle ? mergeModuleResults(state.modulesByConnection[connectionId], result) : result,
        },
        loadingModules: { ...state.loadingModules, [connectionId]: false },
      }))
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((state) => ({
        loadingModules: { ...state.loadingModules, [connectionId]: false },
        errorByConnection: { ...state.errorByConnection, [connectionId]: message },
      }))
      throw err
    }
  },

  clearConnection: (connectionId) =>
    set((state) => {
      if (!connectionId) {
        return {
          accountsByConnection: {},
          modulesByConnection: {},
          loadingAccounts: {},
          loadingModules: {},
          errorByConnection: {},
        }
      }
      const { [connectionId]: _accounts, ...accountsByConnection } = state.accountsByConnection
      const { [connectionId]: _modules, ...modulesByConnection } = state.modulesByConnection
      const { [connectionId]: _loadingAccounts, ...loadingAccounts } = state.loadingAccounts
      const { [connectionId]: _loadingModules, ...loadingModules } = state.loadingModules
      const { [connectionId]: _error, ...errorByConnection } = state.errorByConnection
      return {
        accountsByConnection,
        modulesByConnection,
        loadingAccounts,
        loadingModules,
        errorByConnection,
      }
    }),
}))

function mergeModuleResults(cached: ClusterModulesResult | undefined, result: ClusterModulesResult): ClusterModulesResult {
  if (!cached) return result
  const byName = new Map(cached.modules.map((entry) => [entry.name, { ...entry, versions: [...entry.versions] }]))
  for (const entry of result.modules) {
    const current = byName.get(entry.name)
    if (!current) {
      byName.set(entry.name, { ...entry, versions: [...entry.versions] })
      continue
    }
    current.versions = [...new Set([...current.versions, ...entry.versions])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }
  return {
    ...result,
    modules: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    cachedAt: Date.now(),
  }
}
