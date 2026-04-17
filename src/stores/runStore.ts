/**
 * Run store — renderer-side view of the main-process PipelineRunner state.
 *
 * The main process is authoritative; this store just mirrors events for the
 * canvas and (later) the Jobs panel. On a node-status event it also forwards
 * to pipelineStore.setNodeStatus so the canvas badges update live.
 */
import { create } from 'zustand'
import type { PipelineSnapshot, RunState, RunStatus } from '@/types/pipeline'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useUIStore } from '@/stores/uiStore'

interface RunStoreState {
  activeRunId: string | null
  /** Which node the Jobs panel is focused on (for log view). */
  selectedNodeId: string | null
  runs: Record<string, RunState>

  startRun: (connectionId: string, snapshot: PipelineSnapshot) => Promise<string>
  cancelRun: (runId: string) => Promise<void>
  cancelNode: (runId: string, nodeId: string) => Promise<void>
  setActiveRun: (runId: string | null) => void
  setSelectedNode: (nodeId: string | null) => void
  refreshRuns: () => Promise<void>
  subscribeToEvents: () => () => void
}

export const useRunStore = create<RunStoreState>((set, get) => ({
  activeRunId: null,
  selectedNodeId: null,
  runs: {},

  startRun: async (connectionId, snapshot) => {
    const { runId } = await window.api.pipeline.run(connectionId, snapshot)
    set({ activeRunId: runId, selectedNodeId: null })
    // Reset statuses on tool/merge nodes to 'queued' locally for instant feedback;
    // authoritative state arrives via the node-status event channel moments later.
    const pipelineStore = usePipelineStore.getState()
    for (const n of pipelineStore.nodes) {
      if (n.type === 'tool' || n.type === 'merge') {
        pipelineStore.setNodeStatus(n.id, 'idle')
      }
    }
    await get().refreshRuns()
    // Auto-reveal the Jobs panel so the user sees live progress + logs.
    useUIStore.getState().setBottomPanelMode('jobs')
    return runId
  },

  cancelRun: async (runId) => {
    await window.api.pipeline.cancel(runId)
  },

  cancelNode: async (runId, nodeId) => {
    await window.api.pipeline.cancelNode(runId, nodeId)
  },

  setActiveRun: (runId) => set({ activeRunId: runId, selectedNodeId: null }),

  setSelectedNode: (nodeId) => set({ selectedNodeId: nodeId }),

  refreshRuns: async () => {
    const list = await window.api.pipeline.listRuns()
    const byId: Record<string, RunState> = {}
    for (const r of list) byId[r.runId] = r
    set({ runs: byId })
  },

  subscribeToEvents: () => {
    const offNode = window.api.pipeline.onNodeStatus(({ runId, nodeId, status, jobId, error }) => {
      // Mirror into the pipeline store so the canvas badge updates.
      const pipelineStore = usePipelineStore.getState()
      pipelineStore.setNodeStatus(nodeId, status as any, jobId, error)
      // Update local cache
      set((state) => {
        const run = state.runs[runId]
        if (!run) return state
        const nodes = {
          ...run.nodes,
          [nodeId]: {
            ...(run.nodes[nodeId] ?? { nodeId, status: 'idle' }),
            status: status as any,
            jobId: jobId ?? run.nodes[nodeId]?.jobId,
            error,
          },
        }
        return { runs: { ...state.runs, [runId]: { ...run, nodes, updatedAt: Date.now() } } }
      })
    })

    const offRun = window.api.pipeline.onRunStatus(({ runId, status }) => {
      set((state) => {
        const run = state.runs[runId]
        if (!run) return state
        return { runs: { ...state.runs, [runId]: { ...run, status: status as RunStatus, updatedAt: Date.now() } } }
      })
    })

    return () => { offNode(); offRun() }
  },
}))
