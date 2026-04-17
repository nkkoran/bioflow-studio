import { create } from 'zustand'

export interface SlurmQueueEntry {
  jobId: string
  name: string
  state: string
  elapsed: string
  timeLimit: string
  partition: string
  reason: string
}

interface QueueSnapshot {
  entries: SlurmQueueEntry[]
  loading: boolean
  error: string | null
  fetchedAt: number | null
}

interface SlurmQueueStore {
  byConnection: Record<string, QueueSnapshot>
  refreshQueue: (connectionId: string) => Promise<void>
}

const EMPTY_SNAPSHOT: QueueSnapshot = {
  entries: [],
  loading: false,
  error: null,
  fetchedAt: null,
}

export const useSlurmQueueStore = create<SlurmQueueStore>((set) => ({
  byConnection: {},

  refreshQueue: async (connectionId) => {
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: {
          ...(state.byConnection[connectionId] ?? EMPTY_SNAPSHOT),
          loading: true,
          error: null,
        },
      },
    }))

    try {
      const entries = await window.api.slurm.queue(connectionId)
      set((state) => ({
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            entries,
            loading: false,
            error: null,
            fetchedAt: Date.now(),
          },
        },
      }))
    } catch (err: any) {
      set((state) => ({
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...(state.byConnection[connectionId] ?? EMPTY_SNAPSHOT),
            loading: false,
            error: String(err?.message ?? err),
            fetchedAt: Date.now(),
          },
        },
      }))
    }
  },
}))

export function getQueueSnapshot(
  snapshots: Record<string, QueueSnapshot>,
  connectionId: string,
): QueueSnapshot {
  return snapshots[connectionId] ?? EMPTY_SNAPSHOT
}
