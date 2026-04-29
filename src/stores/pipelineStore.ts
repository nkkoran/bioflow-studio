/**
 * Pipeline state store.
 *
 * Holds React Flow nodes/edges, selection, and pipeline metadata.
 * Supports undo/redo via a simple history stack (last 50 snapshots).
 */
import { create } from 'zustand'
import type { Node, Edge, NodeChange, EdgeChange, Connection } from '@xyflow/react'
import { applyNodeChanges, applyEdgeChanges, addEdge, reconnectEdge as reconnectFlowEdge } from '@xyflow/react'
import type {
  BioflowNodeType,
  FileNodeData,
  MergeNodeData,
  NoteNodeData,
  PipelineSnapshot,
  NodeGroup,
  TransferNodeData,
  TransformNodeData,
  ToolNodeData,
} from '@/types/pipeline'
import { getTool } from '@/lib/toolRegistry'
import { areTypesCompatible } from '@/lib/toolRegistry'
import { ensureFlagBlocks, flagBlocksToParamValues, toolUsesFlagBuilder } from '@/lib/flagRegistry'
import { analysisOptionsToParamValues, getActiveToolInputs, normalizeAnalysisOptions } from '@/lib/analysisOptions'
import { defaultTransformPresetConfig } from '@/lib/transformPresets'
import { useSettingsStore } from '@/stores/settingsStore'

export type BioflowNode = Node<ToolNodeData | FileNodeData | MergeNodeData | TransferNodeData | TransformNodeData | NoteNodeData, BioflowNodeType>
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
  arrayChainMode: 'task-level' | 'job-level'
  fileLifecyclePolicy: 'keep-all' | 'keep-outputs-only' | 'delete-intermediates-on-success'

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
  setArrayChainMode: (mode: 'task-level' | 'job-level') => void
  setFileLifecyclePolicy: (policy: 'keep-all' | 'keep-outputs-only' | 'delete-intermediates-on-success') => void

  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (connection: Connection) => void
  reconnectEdge: (edgeId: string, connection: Connection) => void

  addToolNode: (toolId: string, position: { x: number; y: number }) => string
  addFileNode: (position: { x: number; y: number }, data?: Partial<FileNodeData>) => string
  addMergeNode: (position: { x: number; y: number }, data?: Partial<MergeNodeData>) => string
  addTransferNode: (position: { x: number; y: number }, data?: Partial<TransferNodeData>) => string
  addTransformNode: (position: { x: number; y: number }, data?: Partial<TransformNodeData>) => string
  addNoteNode: (position: { x: number; y: number }) => string
  addNodesAndEdges: (nodes: BioflowNode[], edges: BioflowEdge[]) => void
  insertTransferNodeForEdge: (edgeId: string) => string | null
  wireFileNodeToCompatibleInputs: (nodeId: string) => number

  updateNodeData: (nodeId: string, patch: Partial<ToolNodeData | FileNodeData | MergeNodeData | TransferNodeData | TransformNodeData | NoteNodeData>) => void
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

function defaultOutputMerge(toolId: string): ToolNodeData['outputMerge'] | undefined {
  const tool = getTool(toolId)
  if (!tool) return undefined
  const entries = tool.outputs
    .filter((port) => port.autoMergeDefault)
    .map((port) => [port.id, { mode: 'auto-merge' as const, strategy: port.autoMergeDefault }])
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function defaultOutputIntermediate(toolId: string): ToolNodeData['outputIntermediate'] | undefined {
  return undefined
}

function migrateToolNodeData(data: ToolNodeData, connectedPortIds: Iterable<string> = []): ToolNodeData {
  const tool = getTool(data.toolId)
  const analysisOptions = tool
    ? normalizeAnalysisOptions(tool, data, { connectedPortIds })
    : data.analysisOptions
  const next: ToolNodeData = {
    ...data,
    backend: data.backend ?? (tool?.backends?.includes('dnx') && (tool.backends?.length ?? 0) === 1 ? 'dnx' : 'ssh'),
    analysisOptions,
    paramValues: tool && analysisOptions
      ? analysisOptionsToParamValues(tool, analysisOptions, data.paramValues)
      : data.paramValues,
    outputMerge: data.outputMerge ?? defaultOutputMerge(data.toolId),
    outputIntermediate: data.outputIntermediate,
  }
  if (!toolUsesFlagBuilder(data.toolId)) return next
  const flagBlocks = ensureFlagBlocks(data.toolId, data.flagBlocks, data.paramValues)
  return {
    ...next,
    flagBlocks,
    paramValues: tool && analysisOptions
      ? analysisOptionsToParamValues(tool, analysisOptions, flagBlocksToParamValues(data.toolId, flagBlocks, data.paramValues))
      : flagBlocksToParamValues(data.toolId, flagBlocks, data.paramValues),
  }
}

function migrateFileNodeData(data: FileNodeData): FileNodeData {
  const withOrigin: FileNodeData = {
    ...data,
    origin: data.origin ?? (data.source === 'local' ? 'local' : 'ssh'),
  }
  if (!withOrigin.split) return withOrigin
  const rawItems = (data.split as { items?: unknown }).items
  const items = Array.isArray(rawItems)
    ? rawItems.map((item, index) => {
      const row = item as { key?: unknown; path?: unknown }
      return {
        key: typeof row.key === 'string' && row.key.trim() ? row.key : String(index + 1),
        path: typeof row.path === 'string' ? row.path : '',
      }
    })
    : []
  return {
    ...withOrigin,
    split: {
      ...withOrigin.split,
      axis: withOrigin.split.axis || 'item',
      items,
      pattern: withOrigin.split.pattern ?? (withOrigin.split.glob ? { kind: 'brace', template: withOrigin.split.glob } : { kind: 'manual' }),
    },
  }
}

function migrateMergeNodeData(data: MergeNodeData): MergeNodeData {
  return {
    ...data,
    convergeMode: data.convergeMode ?? 'axed-fan-in',
    inputHandles: data.inputHandles?.length ? data.inputHandles : [{ id: 'input', label: 'Input 1' }],
  }
}

function migrateTransferNodeData(data: TransferNodeData): TransferNodeData {
  return {
    label: data.label || 'Transfer',
    from: data.from === 'dnx' ? 'dnx' : 'ssh',
    to: data.to === 'dnx' ? 'dnx' : 'ssh',
    dnxProjectId: data.dnxProjectId,
    dnxFolder: data.dnxFolder,
    sshFolder: data.sshFolder,
    outputName: data.outputName,
    status: data.status ?? 'idle',
    jobId: data.jobId,
    error: data.error,
  }
}

function migrateTransformNodeData(data: TransformNodeData): TransformNodeData {
  return {
    ...data,
    presetConfig: data.preset ? { ...defaultTransformPresetConfig(data.preset), ...(data.presetConfig ?? {}) } : data.presetConfig,
    filters: (data.filters ?? []).map((filter, index) => ({
      ...filter,
      join: index === 0 ? 'and' : (filter.join ?? 'and'),
    })),
  }
}

function executionDefaults(): Pick<PipelineState, 'arrayChainMode' | 'fileLifecyclePolicy'> {
  const settings = useSettingsStore.getState().settings
  return {
    arrayChainMode: settings.arrayChainMode ?? 'task-level',
    fileLifecyclePolicy: settings.fileLifecyclePolicy ?? 'keep-all',
  }
}

function transferBackendLabel(value: 'local' | 'ssh' | 'dnx'): string {
  if (value === 'dnx') return 'DNAnexus'
  if (value === 'local') return 'Local'
  return 'Rorqual'
}

function inferNodeBackend(node: BioflowNode, direction: 'input' | 'output'): 'local' | 'ssh' | 'dnx' | null {
  if (node.type === 'transfer') {
    const data = node.data as TransferNodeData
    return direction === 'input' ? data.from : data.to
  }
  if (node.type === 'tool') {
    return (node.data as ToolNodeData).backend === 'dnx' ? 'dnx' : 'ssh'
  }
  if (node.type === 'file') {
    const origin = (node.data as FileNodeData).origin
    if (origin === 'dnx') return 'dnx'
    if (origin === 'local') return 'local'
    if (origin === 'ssh') return 'ssh'
    return null
  }
  return 'ssh'
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
  ...executionDefaults(),

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
  setArrayChainMode: (arrayChainMode) => set({ arrayChainMode, dirty: true }),
  setFileLifecyclePolicy: (fileLifecyclePolicy) => set({ fileLifecyclePolicy, dirty: true }),

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
    const edge = { ...connection, id: makeId('edge'), animated: false } as Edge
    set((state) => ({
      edges: addEdge(edge, state.edges),
      ...pushHistory(state),
      dirty: true,
    }))
  },

  reconnectEdge: (edgeId, connection) => {
    set((state) => {
      const current = state.edges.find((edge) => edge.id === edgeId)
      if (!current) return state
      const nextConnection: Connection = {
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? null,
        targetHandle: connection.targetHandle ?? null,
      }
      return {
        edges: reconnectFlowEdge(current, nextConnection, state.edges),
        ...pushHistory(state),
        dirty: true,
      }
    })
  },

  addToolNode: (toolId, position) => {
    if (toolId === 'flow.filterFile') {
      return get().addTransformNode(position, { label: 'Filter file', fileType: 'tsv' })
    }
    const tool = getTool(toolId)
    if (!tool) {
      console.error(`Tool not found: ${toolId}`)
      return ''
    }
    const id = makeId('node')
    const paramValues = defaultParamValues(toolId)
    const flagBlocks = toolUsesFlagBuilder(toolId) ? ensureFlagBlocks(toolId, undefined, paramValues) : undefined
    const analysisOptions = normalizeAnalysisOptions(tool, { paramValues, flagBlocks })
    const node: BioflowNode = {
      id,
      type: 'tool',
      position,
      data: {
        toolId,
        label: tool.name,
        paramValues: analysisOptionsToParamValues(tool, analysisOptions, paramValues),
        flagBlocks,
        analysisOptions,
        backend: tool.backends?.includes('dnx') && (tool.backends?.length ?? 0) === 1 ? 'dnx' : 'ssh',
        outputMerge: defaultOutputMerge(toolId),
        outputIntermediate: defaultOutputIntermediate(toolId),
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
        source: data?.source ?? 'remote',
        origin: data?.origin ?? (data?.source === 'local' ? 'local' : 'ssh'),
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
        convergeMode: data?.convergeMode ?? 'axed-fan-in',
        inputHandles: data?.inputHandles ?? [{ id: 'input', label: 'Input 1' }],
        columnPreview: data?.columnPreview,
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

  addTransferNode: (position, data) => {
    const id = makeId('transfer')
    const node: BioflowNode = {
      id,
      type: 'transfer',
      position,
      data: {
        label: data?.label ?? 'Transfer',
        from: data?.from === 'dnx' ? 'dnx' : 'ssh',
        to: data?.to === 'dnx' ? 'dnx' : 'ssh',
        dnxProjectId: data?.dnxProjectId,
        dnxFolder: data?.dnxFolder,
        sshFolder: data?.sshFolder,
        outputName: data?.outputName,
        status: data?.status ?? 'idle',
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
        preset: data?.preset,
        roleMappings: data?.roleMappings,
        presetConfig: data?.preset ? { ...defaultTransformPresetConfig(data.preset), ...(data.presetConfig ?? {}) } : data?.presetConfig,
        selectedColumns: data?.selectedColumns,
        filters: data?.filters ?? [],
        renames: data?.renames ?? [],
        outputMerge: data?.outputMerge,
        outputIntermediate: data?.outputIntermediate,
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

  insertTransferNodeForEdge: (edgeId) => {
    const state = get()
    const edge = state.edges.find((candidate) => candidate.id === edgeId)
    if (!edge) return null
    const sourceNode = state.nodes.find((candidate) => candidate.id === edge.source)
    const targetNode = state.nodes.find((candidate) => candidate.id === edge.target)
    if (!sourceNode || !targetNode) return null
    if (sourceNode.type === 'transfer' || targetNode.type === 'transfer') return null
    const from = inferNodeBackend(sourceNode, 'output')
    const to = inferNodeBackend(targetNode, 'input')
    if (!from || !to || from === to) return null

    const transferId = makeId('transfer')
    const transferNode: BioflowNode = {
      id: transferId,
      type: 'transfer',
      position: {
        x: (sourceNode.position.x + targetNode.position.x) / 2,
        y: (sourceNode.position.y + targetNode.position.y) / 2,
      },
      data: {
        label: `${transferBackendLabel(from)} -> ${transferBackendLabel(to)}`,
        from,
        to,
        status: 'idle',
      },
    }

    set((current) => ({
      nodes: [...current.nodes, transferNode],
      edges: current.edges.flatMap((candidate) => {
        if (candidate.id !== edgeId) return [candidate]
        return [
          {
            id: makeId('edge'),
            source: candidate.source,
            sourceHandle: candidate.sourceHandle,
            target: transferId,
            targetHandle: 'input',
          },
          {
            id: makeId('edge'),
            source: transferId,
            sourceHandle: 'output',
            target: candidate.target,
            targetHandle: candidate.targetHandle,
          },
        ]
      }),
      selectedNodeId: transferId,
      ...pushHistory(current),
      dirty: true,
    }))

    return transferId
  },

  wireFileNodeToCompatibleInputs: (nodeId) => {
    const state = get()
    const sourceNode = state.nodes.find((node) => node.id === nodeId)
    if (!sourceNode || sourceNode.type !== 'file') return 0
    const sourceType = (sourceNode.data as FileNodeData).fileType
    const existing = new Set(
      state.edges.map((edge) => `${edge.source}:${edge.sourceHandle ?? 'output'}:${edge.target}:${edge.targetHandle ?? 'input'}`),
    )
    const nextEdges: BioflowEdge[] = []

    for (const target of state.nodes) {
      if (target.id === nodeId || target.type === 'note' || target.type === 'file') continue
      if (target.type === 'tool') {
        const tool = getTool((target.data as ToolNodeData).toolId)
        if (!tool) continue
        for (const port of getActiveToolInputs(tool, target.data as ToolNodeData)) {
          if (!areTypesCompatible(sourceType, port.fileType)) continue
          if (!port.multi && state.edges.some((edge) => edge.target === target.id && (edge.targetHandle ?? 'input') === port.id)) continue
          const key = `${nodeId}:output:${target.id}:${port.id}`
          if (existing.has(key)) continue
          nextEdges.push({
            id: makeId('edge'),
            source: nodeId,
            sourceHandle: 'output',
            target: target.id,
            targetHandle: port.id,
          })
          existing.add(key)
        }
      } else if (target.type === 'transform' || target.type === 'transfer') {
        const key = `${nodeId}:output:${target.id}:input`
        if (existing.has(key)) continue
        if (state.edges.some((edge) => edge.target === target.id && (edge.targetHandle ?? 'input') === 'input')) continue
        nextEdges.push({
          id: makeId('edge'),
          source: nodeId,
          sourceHandle: 'output',
          target: target.id,
          targetHandle: 'input',
        })
        existing.add(key)
      } else if (target.type === 'merge') {
        const key = `${nodeId}:output:${target.id}:input`
        if (existing.has(key)) continue
        nextEdges.push({
          id: makeId('edge'),
          source: nodeId,
          sourceHandle: 'output',
          target: target.id,
          targetHandle: 'input',
        })
        existing.add(key)
      }
    }

    if (nextEdges.length > 0) {
      set((current) => ({
        edges: [...current.edges, ...nextEdges],
        ...pushHistory(current),
        dirty: true,
      }))
    }
    return nextEdges.length
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
    const connectedPortsByNode = new Map<string, Set<string>>()
    for (const edge of snapshot.edges) {
      if (!connectedPortsByNode.has(edge.target)) connectedPortsByNode.set(edge.target, new Set())
      connectedPortsByNode.get(edge.target)!.add(edge.targetHandle ?? 'input')
    }
    const nodes: BioflowNode[] = snapshot.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: (
        n.type === 'tool'
          ? migrateToolNodeData(n.data as ToolNodeData, connectedPortsByNode.get(n.id) ?? [])
          : n.type === 'file'
            ? migrateFileNodeData(n.data as FileNodeData)
            : n.type === 'merge'
              ? migrateMergeNodeData(n.data as MergeNodeData)
              : n.type === 'transfer'
                ? migrateTransferNodeData(n.data as TransferNodeData)
              : n.type === 'transform'
                ? migrateTransformNodeData(n.data as TransformNodeData)
                : n.data
      ) as BioflowNode['data'],
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
        arrayChainMode: snapshot.execution?.arrayChainMode ?? executionDefaults().arrayChainMode,
        fileLifecyclePolicy: snapshot.execution?.fileLifecyclePolicy ?? executionDefaults().fileLifecyclePolicy,
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
      execution: {
        arrayChainMode: state.arrayChainMode,
        fileLifecyclePolicy: state.fileLifecyclePolicy,
      },
      createdAt: Date.now(), // caller may overwrite
      updatedAt: Date.now(),
      nodes: state.nodes.map((n) => ({
        id: n.id,
        type: (n.type ?? 'tool') as BioflowNodeType,
        position: n.position,
        data: n.data as ToolNodeData | FileNodeData | MergeNodeData | TransferNodeData | TransformNodeData | NoteNodeData,
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
    const defaults = executionDefaults()
    set({
      pipelineId: makeId('pipeline'),
      pipelineName: 'Untitled pipeline',
      pipelineDescription: '',
      arrayChainMode: defaults.arrayChainMode,
      fileLifecyclePolicy: defaults.fileLifecyclePolicy,
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
      const defaults = executionDefaults()
      const { [id]: _history, ...historyByPipeline } = state.historyByPipeline
      if (state.pipelineId !== id) return { historyByPipeline }
      return {
        pipelineId: makeId('pipeline'),
        pipelineName: 'Untitled pipeline',
        pipelineDescription: '',
        arrayChainMode: defaults.arrayChainMode,
        fileLifecyclePolicy: defaults.fileLifecyclePolicy,
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
        n.id === nodeId && (n.type === 'tool' || n.type === 'merge' || n.type === 'transform' || n.type === 'transfer')
          ? {
              ...n,
              data: { ...(n.data as ToolNodeData | MergeNodeData | TransferNodeData | TransformNodeData), status, jobId, error } as BioflowNode['data'],
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
