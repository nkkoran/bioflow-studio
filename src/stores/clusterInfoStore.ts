import { create } from 'zustand'
import type { ClusterAccountsResult } from '@/types/ssh'

const ACCOUNT_TTL_MS = 10 * 60 * 1000

interface ClusterInfoState {
  accountsByConnection: Record<string, ClusterAccountsResult>
  loadingAccounts: Record<string, boolean>
  errorByConnection: Record<string, string | undefined>
  loadAccounts: (connectionId: string, options?: { force?: boolean }) => Promise<ClusterAccountsResult>
}

export const useClusterInfoStore = create<ClusterInfoState>((set, get) => ({
  accountsByConnection: {},
  loadingAccounts: {},
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
}))
