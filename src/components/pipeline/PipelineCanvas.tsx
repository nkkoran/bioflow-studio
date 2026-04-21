/**
 * PipelineCanvas — the React Flow graph editor.
 *
 * Responsibilities:
 *   - Render the nodes and edges from the pipeline store
 *   - Handle drops from the ToolPalette (tool/file/note creation)
 *   - Validate connections against tool port file-type compatibility
 *   - Sync selection back to the store (for the Inspector)
 *   - Keyboard shortcuts: Delete (remove selection), Ctrl/Cmd+Z (undo), Shift+Ctrl/Cmd+Z (redo)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { ToolNode } from './nodes/ToolNode'
import { FileNode } from './nodes/FileNode'
import { NoteNode } from './nodes/NoteNode'
import { MergeNode } from './nodes/MergeNode'
import { TransformNode } from './nodes/TransformNode'
import { AxedEdge } from './edges/AxedEdge'
import { GroupOverlay } from './GroupOverlay'
import { PortPickerPopover, type PortPickerState } from './PortPickerPopover'
import { BUNDLE_DRAG_MIME, DRAG_MIME } from './ToolPalette'
import { usePipelineStore, type BioflowNode } from '@/stores/pipelineStore'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { getTool, areTypesCompatible } from '@/lib/toolRegistry'
import { getToolBundle } from '@/lib/toolBundles'
import { inferFileType } from '@/lib/fileTypeInference'
import { edgeAxisChips } from '@/lib/axisPlannerPure'
import { pathBasename } from '@/lib/utils'
import type { FileType } from '@/types/pipeline'
import type { NodeGroup } from '@/types/pipeline'

const FILE_DRAG_MIME = 'application/x-bioflow-path'

const nodeTypes: NodeTypes = {
  tool: ToolNode,
  file: FileNode,
  note: NoteNode,
  merge: MergeNode,
  transform: TransformNode,
}

const edgeTypes: EdgeTypes = {
  axed: AxedEdge,
}

const proOptions = { hideAttribution: true }

function CanvasInner() {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition } = useReactFlow()

  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const groups = usePipelineStore((s) => s.groups)
  const onNodesChange = usePipelineStore((s) => s.onNodesChange)
  const onEdgesChange = usePipelineStore((s) => s.onEdgesChange)
  const onConnect = usePipelineStore((s) => s.onConnect)
  const addToolNode = usePipelineStore((s) => s.addToolNode)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
  const addNoteNode = usePipelineStore((s) => s.addNoteNode)
  const addMergeNode = usePipelineStore((s) => s.addMergeNode)
  const addTransformNode = usePipelineStore((s) => s.addTransformNode)
  const addNodesAndEdges = usePipelineStore((s) => s.addNodesAndEdges)
  const setSelectedNode = usePipelineStore((s) => s.setSelectedNode)
  const undo = usePipelineStore((s) => s.undo)
  const redo = usePipelineStore((s) => s.redo)
  const duplicateNode = usePipelineStore((s) => s.duplicateNode)
  const copySelection = usePipelineStore((s) => s.copySelection)
  const pasteClipboard = usePipelineStore((s) => s.pasteClipboard)
  const createGroup = usePipelineStore((s) => s.createGroup)
  const updateGroup = usePipelineStore((s) => s.updateGroup)
  const deleteGroup = usePipelineStore((s) => s.deleteGroup)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const uploadsSubfolder = useSettingsStore((s) => s.settings.paths.uploadsSubfolder)

  const [portPicker, setPortPicker] = useState<PortPickerState | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'selection' | 'group'; group?: NodeGroup } | null>(null)
  const [dropMessage, setDropMessage] = useState<string | null>(null)
  const displayEdges = useMemo(() => {
    const snapshot = {
      version: 1 as const,
      id: 'canvas',
      name: 'Canvas',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type ?? 'tool',
        position: node.position,
        data: node.data as any,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle ?? undefined,
        target: edge.target,
        targetHandle: edge.targetHandle ?? undefined,
      })),
      groups,
    }
    const chips = edgeAxisChips(snapshot)
    return edges.map((edge) => ({
      ...edge,
      type: 'axed',
      data: { ...(edge.data ?? {}), axisChip: chips[edge.id], label: chips[edge.id]?.label ?? '' },
    }))
  }, [edges, nodes, groups])
  const hiddenNodeIds = useMemo(() => {
    const visualMembership = new Map<string, Array<{ collapsed: boolean }>>()
    for (const group of groups) {
      if (group.kind !== 'visual') continue
      for (const nodeId of group.nodeIds) {
        visualMembership.set(nodeId, [...(visualMembership.get(nodeId) ?? []), { collapsed: Boolean(group.collapsed) }])
      }
    }
    const ids = new Set<string>()
    for (const [nodeId, memberships] of visualMembership) {
      if (memberships.length > 0 && memberships.every((membership) => membership.collapsed)) {
        ids.add(nodeId)
      }
    }
    return ids
  }, [groups])
  const displayNodes = useMemo(
    () => nodes.filter((node) => !hiddenNodeIds.has(node.id)),
    [hiddenNodeIds, nodes],
  )
  const visibleEdges = useMemo(
    () => displayEdges.filter((edge) => !hiddenNodeIds.has(edge.source) && !hiddenNodeIds.has(edge.target)),
    [displayEdges, hiddenNodeIds],
  )

  /** Accept drop events from the tool palette */
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      const payload = event.dataTransfer.getData(DRAG_MIME)
      const bundlePayload = event.dataTransfer.getData(BUNDLE_DRAG_MIME)
      const filePath = event.dataTransfer.getData(FILE_DRAG_MIME)
      const droppedLocalPaths = readLocalDropPaths(event)
      if (!payload && !bundlePayload && !filePath && droppedLocalPaths.length === 0) return

      if (droppedLocalPaths.length > 1) {
        setDropMessage('Drag one file at a time for now.')
        window.setTimeout(() => setDropMessage(null), 3000)
        return
      }

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      const droppedLocalPath = droppedLocalPaths[0]
      if (droppedLocalPath) {
        try {
          const stat = await window.api.local.stat(droppedLocalPath)
          if (stat.isDirectory) {
            setDropMessage('Dropping folders is not supported yet. Drop a single file instead.')
            window.setTimeout(() => setDropMessage(null), 3000)
            return
          }
        } catch (err) {
          setDropMessage(err instanceof Error ? err.message : String(err))
          window.setTimeout(() => setDropMessage(null), 3000)
          return
        }
      }

      if (filePath || droppedLocalPath) {
        const rawPath = filePath || droppedLocalPath
        const localDrop = Boolean(droppedLocalPath)
        const fileType = inferFileType(rawPath) as FileType
        const label = pathBasename(rawPath)
        let resolvedPath = rawPath
        let source: 'local' | 'remote' = localDrop ? 'local' : 'remote'
        if (localDrop && activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID) {
          const uploadNow = window.confirm(`Upload ${label} to the active cluster connection now?`)
          if (uploadNow) {
            try {
              const home = (await window.api.ssh.exec(activeConnectionId, 'printf %s "$HOME"')).stdout.trim()
              const uploadDir = `${home}/${uploadsSubfolder.replace(/^\/+|\/+$/g, '')}`
              const remotePath = `${uploadDir}/${label}`
              await window.api.sftp.mkdir(activeConnectionId, uploadDir).catch(() => undefined)
              await window.api.sftp.upload(activeConnectionId, rawPath, remotePath)
              resolvedPath = remotePath
              source = 'remote'
              setDropMessage(`Uploaded ${label} to ${remotePath}`)
              window.setTimeout(() => setDropMessage(null), 3000)
            } catch (err) {
              setDropMessage(err instanceof Error ? err.message : String(err))
              window.setTimeout(() => setDropMessage(null), 3000)
            }
          }
        }
        const target = findDropTargetTool(nodes, position)
        if (!target) {
          addFileNode(position, { isInput: true, label, path: resolvedPath, fileType, source })
          return
        }

        const tool = getTool((target.data as any).toolId)
        if (!tool || tool.inputs.length === 0) {
          addFileNode(position, { isInput: true, label, path: resolvedPath, fileType, source })
          return
        }

        const occupied = new Set<string>(
          edges.filter((edge) => edge.target === target.id && edge.targetHandle)
            .map((edge) => edge.targetHandle as string),
        )

        const attach = (portId: string) => {
          const fileId = addFileNode(
            { x: target.position.x - 220, y: target.position.y },
            { isInput: true, label, path: resolvedPath, fileType, source },
          )
          onConnect({
            source: fileId,
            sourceHandle: 'output',
            target: target.id,
            targetHandle: portId,
          })
        }

        const compatible = tool.inputs.filter((candidate) => {
          if (!areTypesCompatible(fileType, candidate.fileType)) return false
          if (candidate.multi) return true
          return !occupied.has(candidate.id)
        })

        if (compatible.length === 0) {
          addFileNode(position, { isInput: true, label, path: resolvedPath, fileType, source })
          return
        }

        if (compatible.length === 1) {
          attach(compatible[0].id)
          return
        }

        setPortPicker({
          x: event.clientX,
          y: event.clientY,
          ports: tool.inputs,
          droppedType: fileType,
          occupiedPortIds: occupied,
          onPick: (portId) => {
            setPortPicker(null)
            attach(portId)
          },
          onDismiss: () => setPortPicker(null),
        })
        return
      }

      if (bundlePayload) {
        const bundle = getToolBundle(bundlePayload)
        if (!bundle) return
        const built = bundle.build(position)
        addNodesAndEdges(built.nodes, built.edges)
        return
      }

      if (payload.startsWith('__special__:')) {
        const kind = payload.slice('__special__:'.length)
        if (kind === 'file-input') addFileNode(position, { isInput: true, label: 'Input file' })
        else if (kind === 'file-output') addFileNode(position, { isInput: false, label: 'Output file' })
        else if (kind === 'note') addNoteNode(position)
        else if (kind === 'merge') addMergeNode(position)
        else if (kind === 'transform') addTransformNode(position)
      } else {
        addToolNode(payload, position)
      }
    },
    [activeConnectionId, uploadsSubfolder, screenToFlowPosition, nodes, edges, addToolNode, addFileNode, addNoteNode, addMergeNode, addTransformNode, addNodesAndEdges, onConnect],
  )

  /**
   * Validate a proposed connection. Rejects connections where the source
   * output file-type is incompatible with the target input file-type.
   */
  const isValidConnection = useCallback(
    (conn: Connection | { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => {
      if (!conn.source || !conn.target) return false
      if (conn.source === conn.target) return false

      const sourceNode = nodes.find((n) => n.id === conn.source)
      const targetNode = nodes.find((n) => n.id === conn.target)
      if (!sourceNode || !targetNode) return false

      // Resolve source port file type
      let sourceType = 'any'
      if (sourceNode.type === 'tool') {
        const tool = getTool((sourceNode.data as any).toolId)
        const port = tool?.outputs.find((p) => p.id === conn.sourceHandle)
        if (port) sourceType = port.fileType
      } else if (sourceNode.type === 'file') {
        sourceType = (sourceNode.data as any).fileType
      } else if (sourceNode.type === 'transform') {
        sourceType = (sourceNode.data as any).fileType
      }
      // merge nodes pass through — their output type matches upstream

      // Resolve target port file type
      let targetType = 'any'
      if (targetNode.type === 'tool') {
        const tool = getTool((targetNode.data as any).toolId)
        const port = tool?.inputs.find((p) => p.id === conn.targetHandle)
        if (port) targetType = port.fileType
      } else if (targetNode.type === 'file') {
        targetType = (targetNode.data as any).fileType
      } else if (targetNode.type === 'transform') {
        targetType = 'any'
      }
      // merge nodes accept any input — validation happens at plan time

      return areTypesCompatible(sourceType, targetType)
    },
    [nodes],
  )

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      const selected = params.nodes[0]
      setSelectedNode(selected ? selected.id : null)
    },
    [setSelectedNode],
  )

  const onNodeContextMenu = useCallback((event: React.MouseEvent) => {
    const selected = usePipelineStore.getState().nodes.filter((node) => node.selected)
    if (selected.length < 2) return
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, kind: 'selection' })
  }, [])

  const onGroupContextMenu = useCallback((event: React.MouseEvent, group: NodeGroup) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, kind: 'group', group })
  }, [])

  /** Keyboard shortcuts */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      // Ignore when typing in inputs
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }

      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        const selected = usePipelineStore.getState().selectedNodeId
        if (selected) duplicateNode(selected)
        return
      }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        copySelection()
        return
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        pasteClipboard()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undo, redo, duplicateNode, copySelection, pasteClipboard])

  const defaultEdgeOptions = useMemo(
    () => ({
      style: { stroke: 'var(--color-accent, #6366f1)', strokeWidth: 1.5 },
      animated: false,
    }),
    [],
  )

  return (
    <div ref={wrapperRef} className="relative flex-1 h-full w-full" onDrop={(event) => { void onDrop(event) }} onDragOver={onDragOver}>
      <ReactFlow
        nodes={displayNodes}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onNodeContextMenu={onNodeContextMenu}
        isValidConnection={isValidConnection}
        defaultEdgeOptions={defaultEdgeOptions}
        proOptions={proOptions}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        snapToGrid
        snapGrid={[16, 16]}
        deleteKeyCode={['Delete', 'Backspace']}
        multiSelectionKeyCode={['Meta', 'Control']}
        colorMode="dark"
      >
        <Background gap={16} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="top-right"
          pannable
          zoomable
          nodeColor={(n) => {
            if (n.type === 'tool') return '#6366f1'
            if (n.type === 'file') return '#f59e0b'
            if (n.type === 'note') return '#fbbf24'
            if (n.type === 'merge') return '#818cf8'
            if (n.type === 'transform') return '#2dd4bf'
            return '#888'
          }}
          maskColor="rgba(0,0,0,0.5)"
          style={{ background: 'var(--color-bg-secondary)' }}
        />
        <GroupOverlay
          groups={groups}
          nodes={nodes}
          onContextMenu={onGroupContextMenu}
          onToggleCollapse={(group) => updateGroup(group.id, { collapsed: !group.collapsed })}
        />
      </ReactFlow>
      {dropMessage && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-40 -translate-x-1/2 rounded border border-accent/40 bg-bg-secondary px-3 py-1 text-xs text-text-primary shadow">
          {dropMessage}
        </div>
      )}
      {portPicker && <PortPickerPopover state={portPicker} />}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div
            className="fixed z-50 min-w-[180px] rounded border border-border bg-bg-secondary py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {menu.kind === 'selection' && (
                <button
                  className="w-full px-3 py-1.5 text-left text-xs text-text-primary hover:bg-bg-hover"
                  onClick={() => {
                    const selected = usePipelineStore.getState().nodes.filter((node) => node.selected).map((node) => node.id)
                    createGroup(selected)
                    setMenu(null)
                  }}
                >
                  Group into single sbatch
                </button>
            )}
            {menu.kind === 'group' && menu.group && (
              <>
                {menu.group.kind === 'visual' && (
                  <button
                    className="w-full px-3 py-1.5 text-left text-xs text-text-primary hover:bg-bg-hover"
                    onClick={() => {
                      updateGroup(menu.group!.id, { collapsed: !menu.group!.collapsed })
                      setMenu(null)
                    }}
                  >
                    {menu.group.collapsed ? 'Expand group' : 'Collapse group'}
                  </button>
                )}
                <button
                  className="w-full px-3 py-1.5 text-left text-xs text-text-primary hover:bg-bg-hover"
                  onClick={() => {
                    deleteGroup(menu.group!.id)
                    setMenu(null)
                  }}
                >
                  Ungroup
                </button>
                {menu.group.kind !== 'visual' && (
                  <button
                    className="w-full px-3 py-1.5 text-left text-xs text-text-primary hover:bg-bg-hover"
                    onClick={() => {
                      const group = menu.group!
                      const cpus = prompt('CPUs for grouped sbatch (blank = max across nodes)', group.sharedResources?.cpus?.toString() ?? '')
                      const memoryGB = prompt('Memory GB for grouped sbatch (blank = max across nodes)', group.sharedResources?.memoryGB?.toString() ?? '')
                      const timeHours = prompt('Time hours for grouped sbatch (blank = max across nodes)', group.sharedResources?.timeHours?.toString() ?? '')
                      const partition = prompt('Partition for grouped sbatch (blank = default)', group.sharedResources?.partition ?? '')
                      updateGroup(group.id, {
                        sharedResources: {
                          cpus: cpus ? Number(cpus) : undefined,
                          memoryGB: memoryGB ? Number(memoryGB) : undefined,
                          timeHours: timeHours ? Number(timeHours) : undefined,
                          partition: partition || undefined,
                        },
                      })
                      setMenu(null)
                    }}
                  >
                    Edit group resources...
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function readLocalDropPaths(event: React.DragEvent): string[] {
  const files = Array.from(event.dataTransfer.files ?? [])
    .map((file) => ((file as File & { path?: string }).path ?? ''))
    .filter(Boolean)
  return [...new Set(files)]
}

function findDropTargetTool(
  nodes: ReturnType<typeof usePipelineStore.getState>['nodes'],
  position: { x: number; y: number },
) {
  return nodes.find((node) => {
    if (node.type !== 'tool') return false
    const width = node.width ?? 220
    const height = node.height ?? 140
    return (
      position.x >= node.position.x &&
      position.x <= node.position.x + width &&
      position.y >= node.position.y &&
      position.y <= node.position.y + height
    )
  })
}

export function PipelineCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
