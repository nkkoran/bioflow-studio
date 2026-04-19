/**
 * Pipeline state store.
 *
 * Holds React Flow nodes/edges, selection, and pipeline metadata.
 * Supports undo/redo via a simple history stack (last 50 snapshots).
 */
import { create } from 'zustand'
import type { Node, Edge, NodeChange, EdgeChange, Connection } from '@xyflow/react'
import { applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import type {
  BioflowNodeType,
  FileNodeData,
  MergeNodeData,
  NoteNodeData,
  PipelineSnapshot,
  NodeGroup,
  TransformNodeData,
  ToolNodeData,
} from '@/types/pipeline'
import { getTool } from '@/lib/toolRegistry'

export type BioflowNode = Node<ToolNodeData | FileNodeData | MergeNodeData | TransformNodeData | NoteNodeData, BioflowNodeType>
export type BioflowEdge = Edge

interface HistoryEntry {
  nodes: BioflowNode[]
  edges: BioflowEdge[]
  groups: NodeGroup[]
}

interface PipelineState {
  /** Pipeline metadata */
  pipelineId: string
  pipelineName: string
  pipelineDescription: string

  /** Graph */
  nodes: BioflowNode[]
  edges: BioflowEdge[]
  groups: NodeGroup[]

  /** Selected node id (for the inspector panel) */
  selectedNodeId: string | null

  /** Undo/redo stacks for the currently-active pipeline. */
  past: HistoryEntry[]
  future: HistoryEntry[]

  /**
   * Per-pipeline history cache. When the user switches pipelines (loadSnapshot),
   * the outgoing pipeline's past/future are stashed here keyed by its id, and
   * the incoming pipeline's stacks are restored if present. Memory is bounded
   * per entry by HISTORY_LIMIT; we don't cap the number of cached pipelines
   * because users rarely hold more than a handful.
   */
  historyByPipeline: Record<string, { past: HistoryEntry[]; future: HistoryEntry[] }>

  /** Dirty flag (has unsaved changes) */
  dirty: boolean

  /** Internal graph clipboard for copy/paste shortcuts. */
  clipboard: HistoryEntry | null

  // --- actions ---
  setPipelineName: (name: string) => void
  setPipelineDescription: (desc: string) => void

  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (connection: Connection) => void

  addToolNode: (toolId: string, position: { x: number; y: number }) => string
  addFileNode: (position: { x: number; y: number }, data?: Partial<FileNodeData>) => string
  addMergeNode: (position: { x: number; y: number }, data?: Partial<MergeNodeData>) => string
  addTransformNode: (position: { x: number; y: number }, data?: Partial<TransformNodeData>) => string
  addNoteNode: (position: { x: number; y: number }) => string
  addNodesAndEdges: (nodes: BioflowNode[], edges: BioflowEdge[]) => void

  updateNodeData: (nodeId: string, patch: Partial<ToolNodeData | FileNodeData | MergeNodeData | TransformNodeData | NoteNodeData>) => void
  deleteNode: (nodeId: string) => void
  deleteEdge: (edgeId: string) => void
  duplicateNode: (nodeId: string) => void
  copySelection: () => void
  pasteClipboard: () => void
  createGroup: (nodeIds: string[], label?: string) => string
  updateGroup: (groupId: string, patch: Partial<NodeGroup>) => void
  deleteGroup: (groupId: string) => void

  setSelectedNode: (nodeId: string | null) => void

  undo: () => void
  redo: () => void

  loadSnapshot: (snapshot: PipelineSnapshot) => void
  exportSnapshot: () => PipelineSnapshot
  markSaved: () => void
  reset: () => void
  listPipelines: () => Promise<Array<{ id: string; name: string; updatedAt: number }>>
  deletePipeline: (id: string) => Promise<void>

  setNodeStatus: (nodeId: string, status: ToolNodeData['status'], jobId?: string, error?: string) => void
}

const HISTORY_LIMIT = 50

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

/** Build default paramValues from tool definition. */
function defaultParamValues(toolId: string): Record<string, unknown> {
  const tool = getTool(toolId)
  if (!tool) return {}
  const values: Record<string, unknown> = {}
  for (const p of tool.params) {
    if (p.default !== undefined) values[p.name] = p.default
  }
  return values
}

/** Push the current state onto the `past` stack before a mutation. */
function pushHistory(state: PipelineState): Pick<PipelineState, 'past' | 'future'> {
  const entry: HistoryEntry = {
    nodes: state.nodes,
    edges: state.edges,
    groups: state.groups,
  }
  const past = [...state.past, entry].slice(-HISTORY_LIMIT)
  return { past, future: [] }
}

export const usePipelineStore = create<PipelineState>()((set, get) => ({
  pipelineId: makeId('pipeline'),
  pipelineName: 'Untitled pipeline',
  pipelineDescription: '',

  nodes: [],
  edges: [],
  groups: [],
  selectedNodeId: null,

  past: [],
  future: [],
  historyByPipeline: {},
  dirty: false,
  clipboard: null,

  setPipelineName: (name) => set({ pipelineName: name, dirty: true }),
  setPipelineDescription: (description) => set({ pipelineDescription: description, dirty: true }),

  onNodesChange: (changes) => {
    // Only push history for structural changes (add/remove), not position/selection drags
    const structural = changes.some((c) => c.type === 'add' || c.type === 'remove')
    set((state) => {
      const next = applyNodeChanges(changes, state.nodes) as BioflowNode[]
      return {
        nodes: next,
        ...(structural ? pushHistory(state) : {}),
        dirty: state.dirty || structural,
      }
    })
  },

  onEdgesChange: (changes) => {
    const structural = changes.some((c) => c.type === 'add' || c.type === 'remove')
    set((state) => {
      const next = applyEdgeChanges(changes, state.edges)
      return {
        edges: next,
        ...(structural ? pushHistory(state) : {}),
        dirty: state.dirty || structural,
      }
    })
  },

  onConnect: (connection) => {
    set((state) => ({
      edges: addEdge({ ...connection, animated: false }, state.edges),
      ...pushHistory(state),
      dirty: true,
    }))
  },

  addToolNode: (toolId, position) => {
    const tool = getTool(toolId)
    if (!tool) {
      console.error(`Tool not found: ${toolId}`)
      return ''
    }
    const id = makeId('node')
    const node: BioflowNode = {
      id,
      type: 'tool',
      position,
      data: {
        toolId,
        label: tool.name,
        paramValues: defaultParamValues(toolId),
        status: 'idle',
      },
    }
    set((state) => ({
      nodes: [...state.nodes, node],
      selectedNodeId: id,
      ...pushHistory(state),
      dirty: true,
    }))
    return id
  },

  addFileNode: (position, data) => {
    const id = makeId('file')
    const node: BioflowNode = {
      id,
      type: 'file',
      position,
      data: {
        label: data?.label ?? 'File',
        path: data?.path ?? '',
        fileType: data?.fileType ?? 'any',
        isInput: data?.isInput ?? true,
      },
    }
    set((state) => ({
      nodes: [...state.nodes, node],
      selectedNodeId: id,
      ...pushHistory(state),
      dirty: true,
    }))
    return id
  },

  addMergeNode: (position, data) => {
    const id = makeId('merge')
    const node: BioflowNode = {
      id,
      type: 'merge',
      position,
      data: {
        label: data?.label ?? 'Merge',
        strategy: data?.strategy ?? 'auto',
        slurmOverride: data?.slurmOverride,
        status: 'idle',
      },
    }
    set((state) => ({
      nodes: [...state.nodes, node],
      selectedNodeId: id,
      ...pushHistory(state),
      dirty: true,
    }))
    return id
  },

  addTransformNode: (position, data) => {
    const id = makeId('transform')
    const node: BioflowNode = {
      id,
      type: 'transform',
      position,
      data: {
        label: data?.label ?? 'Transform',
        fileType: data?.fileType ?? 'tsv',
        selectedColumns: data?.selectedColumns,
        filters: data?.filters ?? [],
        renames: data?.renames ?? [],
        slurmOverride: data?.slurmOverride,
        status: 'idle',
      },
    }
    set((state) => ({
      nodes: [...state.nodes, node],
      selectedNodeId: id,
      ...pushHistory(state),
      dirty: true,
    }))
    return id
  },

  addNoteNode: (position) => {
    const id = makeId('note')
    const node: BioflowNode = {
      id,
      type: 'note',
      position,
      data: { text: 'Note', color: '#fbbf24' },
    }
    set((state) => ({
      nodes: [...state.nodes, node],
      selectedNodeId: id,
      ...pushHistory(state),
      dirty: true,
    }))
    return id
  },

  addNodesAndEdges: (newNodes, newEdges) => {
    set((state) => ({
      nodes: [...state.nodes, ...newNodes],
      edges: [...state.edges, ...newEdges],
      selectedNodeId: newNodes[0]?.id ?? state.selectedNodeId,
      ...pushHistory(state),
      dirty: true,
    }))
  },

  updateNodeData: (nodeId, patch) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...patch } as BioflowNode['data'] } : n,
      ),
      dirty: true,
    }))
  },

  deleteNode: (nodeId) => {
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      groups: state.groups
        .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== nodeId) }))
        .filter((group) => group.nodeIds.length > 1),
      selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
      ...pushHistory(state),
      dirty: true,
    }))
  },

  deleteEdge: (edgeId) => {
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== edgeId),
      ...pushHistory(state),
      dirty: true,
    }))
  },

  duplicateNode: (nodeId) => {
    set((state) => {
      const node = state.nodes.find((n) => n.id === nodeId)
      if (!node) return state
      const newNode: BioflowNode = {
        ...node,
        id: makeId('node'),
        position: { x: node.position.x + 40, y: node.position.y + 40 },
        selected: false,
        data: { ...node.data } as BioflowNode['data'],
      }
      return {
        nodes: [...state.nodes, newNode],
        ...pushHistory(state),
        dirty: true,
      }
    })
  },

  copySelection: () => {
    const state = get()
    const selectedNodes = state.nodes.filter((node) => node.selected || node.id === state.selectedNodeId)
    const selectedIds = new Set(selectedNodes.map((node) => node.id))
    const selectedEdges = state.edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    if (selectedNodes.length === 0) return
    set({
      clipboard: {
        nodes: selectedNodes,
        edges: selectedEdges,
        groups: [],
      },
    })
  },

  pasteClipboard: () => {
    set((state) => {
      if (!state.clipboard || state.clipboard.nodes.length === 0) return state
      const idMap = new Map<string, string>()
      const nodes = state.clipboard.nodes.map((node) => {
        const id = makeId(node.type ?? 'node')
        idMap.set(node.id, id)
        return {
          ...node,
          id,
          selected: true,
          position: { x: node.position.x + 40, y: node.position.y + 40 },
          data: { ...node.data } as BioflowNode['data'],
        } as BioflowNode
      })
      const edges = state.clipboard.edges.flatMap((edge) => {
        const source = idMap.get(edge.source)
        const target = idMap.get(edge.target)
        if (!source || !target) return []
        return [{
          ...edge,
          id: makeId('edge'),
          source,
          target,
          selected: false,
        }]
      })
      return {
        nodes: [
          ...state.nodes.map((node) => ({ ...node, selected: false })),
          ...nodes,
        ],
        edges: [...state.edges, ...edges],
        selectedNodeId: nodes[0]?.id ?? state.selectedNodeId,
        ...pushHistory(state),
        dirty: true,
      }
    })
  },

  createGroup: (nodeIds, label) => {
    const unique = [...new Set(nodeIds)].filter(Boolean)
    if (unique.length < 2) return ''
    const id = makeId('group')
    set((state) => ({
      groups: [...state.groups, { id, label: label ?? `Group ${state.groups.length + 1}`, nodeIds: unique }],
      ...pushHistory(state),
      dirty: true,
    }))
    return id
  },

  updateGroup: (groupId, patch) => {
    set((state) => ({
      groups: state.groups.map((group) =>
        group.id === groupId ? { ...group, ...patch, id: group.id } : group,
      ),
      ...pushHistory(state),
      dirty: true,
    }))
  },

  deleteGroup: (groupId) => {
    set((state) => ({
      groups: state.groups.filter((group) => group.id !== groupId),
      ...pushHistory(state),
      dirty: true,
    }))
  },

  setSelectedNode: (nodeId) => set({ selectedNodeId: nodeId }),

  undo: () => {
    const state = get()
    const prev = state.past[state.past.length - 1]
    if (!prev) return
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      groups: prev.groups,
      past: state.past.slice(0, -1),
      future: [{ nodes: state.nodes, edges: state.edges, groups: state.groups }, ...state.future],
      dirty: true,
    })
  },

  redo: () => {
    const state = get()
    const next = state.future[0]
    if (!next) return
    set({
      nodes: next.nodes,
      edges: next.edges,
      groups: next.groups,
      past: [...state.past, { nodes: state.nodes, edges: state.edges, groups: state.groups }],
      future: state.future.slice(1),
      dirty: true,
    })
  },

  loadSnapshot: (snapshot) => {
    const nodes: BioflowNode[] = snapshot.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data as BioflowNode['data'],
    }))
    set((state) => {
      // Stash the outgoing pipeline's history, then restore the incoming one's
      // if we've seen it before. Same-id reloads keep their stacks intact.
      const nextCache =
        state.pipelineId === snapshot.id
          ? state.historyByPipeline
          : {
              ...state.historyByPipeline,
              [state.pipelineId]: { past: state.past, future: state.future },
            }
      const restored = nextCache[snapshot.id] ?? { past: [], future: [] }
      return {
        pipelineId: snapshot.id,
        pipelineName: snapshot.name,
        pipelineDescription: snapshot.description ?? '',
        nodes,
        edges: snapshot.edges,
        groups: snapshot.groups ?? [],
        selectedNodeId: null,
        past: restored.past,
        future: restored.future,
        historyByPipeline: nextCache,
        dirty: false,
        clipboard: null,
      }
    })
  },

  exportSnapshot: (): PipelineSnapshot => {
    const state = get()
    return {
      version: 1,
      id: state.pipelineId,
      name: state.pipelineName,
      description: state.pipelineDescription,
      createdAt: Date.now(), // caller may overwrite
      updatedAt: Date.now(),
      nodes: state.nodes.map((n) => ({
        id: n.id,
        type: (n.type ?? 'tool') as BioflowNodeType,
        position: n.position,
        data: n.data as ToolNodeData | FileNodeData | MergeNodeData | TransformNodeData | NoteNodeData,
      })),
      edges: state.edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle ?? undefined,
        target: e.target,
        targetHandle: e.targetHandle ?? undefined,
      })),
      groups: state.groups,
    }
  },

  markSaved: () => set({ dirty: false }),

  reset: () => {
    set({
      pipelineId: makeId('pipeline'),
      pipelineName: 'Untitled pipeline',
      pipelineDescription: '',
      nodes: [],
      edges: [],
      groups: [],
      selectedNodeId: null,
      past: [],
      future: [],
      dirty: false,
    })
  },

  listPipelines: async () => {
    const ids = (await window.api.store.get<string[]>('pipelines:ids')) ?? []
    const rows = await Promise.all(ids.map(async (id) => {
      const snap = await window.api.store.get<PipelineSnapshot>(`pipeline:${id}`)
      return snap ? { id: snap.id, name: snap.name, updatedAt: snap.updatedAt } : null
    }))
    const liveRows = rows
      .filter((row): row is { id: string; name: string; updatedAt: number } => row !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const liveIds = liveRows.map((row) => row.id)
    if (liveIds.length !== ids.length || liveIds.some((id, index) => id !== ids[index])) {
      await window.api.store.set('pipelines:ids', liveIds)
    }
    return liveRows
  },

  deletePipeline: async (id) => {
    const ids = (await window.api.store.get<string[]>('pipelines:ids')) ?? []
    await window.api.store.set('pipelines:ids', ids.filter((existing) => existing !== id))
    await window.api.store.delete(`pipeline:${id}`)
    set((state) => {
      const { [id]: _history, ...historyByPipeline } = state.historyByPipeline
      if (state.pipelineId !== id) return { historyByPipeline }
      return {
        pipelineId: makeId('pipeline'),
        pipelineName: 'Untitled pipeline',
        pipelineDescription: '',
        nodes: [],
        edges: [],
        groups: [],
        selectedNodeId: null,
        past: [],
        future: [],
        dirty: false,
        clipboard: null,
        historyByPipeline,
      }
    })
  },

  setNodeStatus: (nodeId, status, jobId, error) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId && (n.type === 'tool' || n.type === 'merge' || n.type === 'transform')
          ? {
              ...n,
              data: { ...(n.data as ToolNodeData | MergeNodeData | TransformNodeData), status, jobId, error } as BioflowNode['data'],
            }
          : n,
      ),
    }))
  },
}))

/** Selector helper: find the currently selected node. */
export function useSelectedNode(): BioflowNode | null {
  return usePipelineStore((s) => {
    if (!s.selectedNodeId) return null
    return s.nodes.find((n) => n.id === s.selectedNodeId) ?? null
  })
}
