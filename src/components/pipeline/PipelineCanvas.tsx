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
  type FinalConnectionState,
  type NodeTypes,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { ToolNode } from './nodes/ToolNode'
import { FileNode } from './nodes/FileNode'
import { NoteNode } from './nodes/NoteNode'
import { MergeNode } from './nodes/MergeNode'
import { TransferNode } from './nodes/TransferNode'
import { TransformNode } from './nodes/TransformNode'
import { AxedEdge } from './edges/AxedEdge'
import { GroupOverlay } from './GroupOverlay'
import { PortPickerPopover, type PortPickerState } from './PortPickerPopover'
import { BUNDLE_DRAG_MIME, DRAG_MIME } from './ToolPalette'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { usePipelineStore, type BioflowNode } from '@/stores/pipelineStore'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { getTool, areTypesCompatible } from '@/lib/toolRegistry'
import { getActiveToolInputs } from '@/lib/analysisOptions'
import { getToolBundle } from '@/lib/toolBundles'
import { inferFileType } from '@/lib/fileTypeInference'
import { edgeAxisChips } from '@/lib/axisPlannerPure'
import { pathBasename } from '@/lib/utils'
import type { FileType } from '@/types/pipeline'
import type { NodeGroup } from '@/types/pipeline'
import { useDialogStore } from '@/stores/dialogStore'

const FILE_DRAG_MIME = 'application/x-bioflow-path'

const nodeTypes: NodeTypes = {
  tool: ToolNode,
  file: FileNode,
  note: NoteNode,
  merge: MergeNode,
  transfer: TransferNode,
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
  const theme = useUIStore((s) => s.theme)
  const edges = usePipelineStore((s) => s.edges)
  const groups = usePipelineStore((s) => s.groups)
  const onNodesChange = usePipelineStore((s) => s.onNodesChange)
  const onEdgesChange = usePipelineStore((s) => s.onEdgesChange)
  const onConnect = usePipelineStore((s) => s.onConnect)
  const reconnectEdge = usePipelineStore((s) => s.reconnectEdge)
  const addToolNode = usePipelineStore((s) => s.addToolNode)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
  const addNoteNode = usePipelineStore((s) => s.addNoteNode)
  const addMergeNode = usePipelineStore((s) => s.addMergeNode)
  const addTransferNode = usePipelineStore((s) => s.addTransferNode)
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
  const deleteEdge = usePipelineStore((s) => s.deleteEdge)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const uploadsSubfolder = useSettingsStore((s) => s.settings.paths.uploadsSubfolder)
  const confirmDialog = useDialogStore((s) => s.confirm)

  const [portPicker, setPortPicker] = useState<PortPickerState | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'selection' | 'group'; group?: NodeGroup } | null>(null)
  const [groupResourceEditor, setGroupResourceEditor] = useState<null | {
    groupId: string
    label: string
    cpus: string
    memoryGB: string
    timeHours: string
    partition: string
  }>(null)
  const [dropMessage, setDropMessage] = useState<string | null>(null)
  const [dropBusy, setDropBusy] = useState(false)
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
    const fanOutGroups = new Map<string, string[]>()
    for (const edge of edges) {
      const key = `${edge.source}:${edge.sourceHandle ?? 'output'}`
      fanOutGroups.set(key, [...(fanOutGroups.get(key) ?? []), edge.id])
    }
    return edges.map((edge) => ({
      ...edge,
      type: 'axed',
      data: {
        ...(edge.data ?? {}),
        axisChip: chips[edge.id],
        label: chips[edge.id]?.label ?? '',
        fanOutIndex: fanOutGroups.get(`${edge.source}:${edge.sourceHandle ?? 'output'}`)?.indexOf(edge.id) ?? 0,
        fanOutTotal: fanOutGroups.get(`${edge.source}:${edge.sourceHandle ?? 'output'}`)?.length ?? 1,
      },
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

  const handleDroppedPath = useCallback(async (
    rawPath: string,
    position: { x: number; y: number },
    localDrop: boolean,
  ) => {
    setDropBusy(true)
    const fileType = inferFileType(rawPath) as FileType
    const label = pathBasename(rawPath)
    let resolvedPath = rawPath
    let source: 'local' | 'remote' = localDrop ? 'local' : 'remote'
    let origin: 'local' | 'ssh' = localDrop ? 'local' : 'ssh'
    try {
      setDropMessage(localDrop ? `Adding ${label}…` : 'Adding file…')
      if (localDrop && activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID) {
        const uploadNow = await confirmDialog({
          title: 'Upload dropped file',
          message: `Upload ${label} to the active cluster connection now?`,
          detail: 'Choose Upload now to copy the file into the cluster uploads folder before wiring it into the pipeline.',
          confirmLabel: 'Upload now',
          cancelLabel: 'Keep local',
        })
        if (uploadNow) {
          setDropMessage(`Uploading ${label} to the cluster…`)
          const home = (await window.api.ssh.exec(activeConnectionId, 'printf %s "$HOME"')).stdout.trim()
          const uploadDir = `${home}/${uploadsSubfolder.replace(/^\/+|\/+$/g, '')}`
          const remotePath = `${uploadDir}/${label}`
          await window.api.sftp.mkdir(activeConnectionId, uploadDir).catch(() => undefined)
          await window.api.sftp.upload(activeConnectionId, rawPath, remotePath)
          resolvedPath = remotePath
          source = 'remote'
          origin = 'ssh'
        }
      }
      const target = findDropTargetTool(nodes, position)
      if (!target) {
        addFileNode(position, { isInput: true, label, path: resolvedPath, fileType, source, origin })
        setDropMessage(source === 'remote' && localDrop ? `Uploaded ${label} and added it to the canvas.` : `Added ${label} to the canvas.`)
        return
      }

      const tool = getTool((target.data as any).toolId)
      const connectedPortIds = edges.filter((edge) => edge.target === target.id).map((edge) => edge.targetHandle ?? 'input')
      const activeInputs = tool ? getActiveToolInputs(tool, target.data as any, { connectedPortIds }) : []
      if (!tool || activeInputs.length === 0) {
        addFileNode(position, { isInput: true, label, path: resolvedPath, fileType, source, origin })
        setDropMessage(`Added ${label} to the canvas.`)
        return
      }

      const occupied = new Set<string>(
        edges.filter((edge) => edge.target === target.id && edge.targetHandle)
          .map((edge) => edge.targetHandle as string),
      )

      const attach = (portId: string) => {
        const fileId = addFileNode(
          { x: target.position.x - 220, y: target.position.y },
          { isInput: true, label, path: resolvedPath, fileType, source, origin },
        )
        onConnect({
          source: fileId,
          sourceHandle: 'output',
          target: target.id,
          targetHandle: portId,
        })
        setDropMessage(`Attached ${label} to ${target.data.label ?? 'the tool'}.`)
      }

      const compatible = activeInputs.filter((candidate) => {
        if (!areTypesCompatible(fileType, candidate.fileType)) return false
        if (candidate.multi) return true
        return !occupied.has(candidate.id)
      })

      if (compatible.length === 0) {
        addFileNode(position, { isInput: true, label, path: resolvedPath, fileType, source, origin })
        setDropMessage(`Added ${label} to the canvas.`)
        return
      }

      if (compatible.length === 1) {
        attach(compatible[0].id)
        return
      }

      setDropMessage(`Choose which input should receive ${label}.`)
      setPortPicker({
        x: wrapperRef.current?.getBoundingClientRect().left ?? position.x,
        y: wrapperRef.current?.getBoundingClientRect().top ?? position.y,
        ports: activeInputs,
        droppedType: fileType,
        occupiedPortIds: occupied,
        onPick: (portId) => {
          setPortPicker(null)
          attach(portId)
        },
        onDismiss: () => setPortPicker(null),
      })
    } catch (err) {
      setDropMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setDropBusy(false)
      window.setTimeout(() => setDropMessage(null), 3000)
    }
  }, [activeConnectionId, addFileNode, confirmDialog, edges, nodes, onConnect, uploadsSubfolder])

  const handleDroppedFolder = useCallback(async (
    folderPath: string,
    position: { x: number; y: number },
  ) => {
    setDropBusy(true)
    try {
      setDropMessage('Creating split input from folder…')
      const entries = (await window.api.local.ls(folderPath)).filter((entry) => !entry.isDirectory)
      if (entries.length === 0) {
        setDropMessage('Folder has no files to split.')
        return
      }
      const items = entries.map((entry) => ({ key: entry.name, path: entry.path }))
      const firstType = inferFileType(entries[0].name) as FileType
      const allSameType = entries.every((entry) => inferFileType(entry.name) === firstType)
      const label = pathBasename(folderPath) || 'Folder split'
      const fileId = addFileNode(position, {
        isInput: true,
        label,
        path: folderPath,
        fileType: allSameType ? firstType : 'any',
        source: 'local',
        origin: 'local',
        split: {
          axis: 'file',
          items,
          pattern: { kind: 'manual' },
        },
      })
      const target = findDropTargetTool(nodes, position)
      if (target) {
        const tool = getTool((target.data as any).toolId)
        const connectedPortIds = edges.filter((edge) => edge.target === target.id).map((edge) => edge.targetHandle ?? 'input')
        const activeInputs = tool ? getActiveToolInputs(tool, target.data as any, { connectedPortIds }) : []
        const compatible = activeInputs.find((port) => areTypesCompatible(allSameType ? firstType : 'any', port.fileType))
        if (compatible) {
          onConnect({ source: fileId, sourceHandle: 'output', target: target.id, targetHandle: compatible.id })
        }
      }
      setDropMessage(`Added ${items.length} files as an axis-split input.`)
    } catch (err) {
      setDropMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setDropBusy(false)
      window.setTimeout(() => setDropMessage(null), 3000)
    }
  }, [addFileNode, edges, nodes, onConnect])

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      const payload = event.dataTransfer.getData(DRAG_MIME)
      const bundlePayload = event.dataTransfer.getData(BUNDLE_DRAG_MIME)
      const filePath = event.dataTransfer.getData(FILE_DRAG_MIME)
      const droppedLocalPaths = readLocalDropPaths(event)
      if (!payload && !bundlePayload && !filePath && droppedLocalPaths.length === 0) return

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      if (droppedLocalPaths.length > 1) {
        const items = droppedLocalPaths.map((path) => ({ key: pathBasename(path), path }))
        addFileNode(position, {
          isInput: true,
          label: 'Dropped file split',
          path: '',
          fileType: 'any',
          source: 'local',
          origin: 'local',
          split: { axis: 'file', items, pattern: { kind: 'manual' } },
        })
        setDropMessage(`Added ${items.length} files as an axis-split input.`)
        window.setTimeout(() => setDropMessage(null), 3000)
        return
      }

      const droppedLocalPath = droppedLocalPaths[0]
      if (droppedLocalPath) {
        try {
          const stat = await window.api.local.stat(droppedLocalPath)
          if (stat.isDirectory) {
            await handleDroppedFolder(droppedLocalPath, position)
            return
          }
        } catch (err) {
          setDropMessage(err instanceof Error ? err.message : String(err))
          window.setTimeout(() => setDropMessage(null), 3000)
          return
        }
      }

      if (filePath || droppedLocalPath) {
        await handleDroppedPath(filePath || droppedLocalPath, position, Boolean(droppedLocalPath))
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
        else if (kind === 'transfer') addTransferNode(position)
        else if (kind === 'transform') addTransformNode(position)
      } else {
        addToolNode(payload, position)
      }
    },
    [screenToFlowPosition, handleDroppedPath, handleDroppedFolder, addFileNode, addToolNode, addNoteNode, addMergeNode, addTransferNode, addTransformNode, addNodesAndEdges],
  )

  useEffect(() => {
    const onGlobalDrop = (event: Event) => {
      const detail = (event as CustomEvent<{ clientX: number; clientY: number; paths: string[] }>).detail
      if (!detail?.paths?.[0]) return
      const position = screenToFlowPosition({ x: detail.clientX, y: detail.clientY })
      if (detail.paths.length > 1) {
        const items = detail.paths.map((path) => ({ key: pathBasename(path), path }))
        addFileNode(position, {
          isInput: true,
          label: 'Dropped file split',
          path: '',
          fileType: 'any',
          source: 'local',
          origin: 'local',
          split: { axis: 'file', items, pattern: { kind: 'manual' } },
        })
        return
      }
      void window.api.local.stat(detail.paths[0]).then((stat) => {
        if (stat.isDirectory) return handleDroppedFolder(detail.paths[0], position)
        return handleDroppedPath(detail.paths[0], position, true)
      })
    }
    window.addEventListener('bioflow:global-file-drop', onGlobalDrop as EventListener)
    return () => window.removeEventListener('bioflow:global-file-drop', onGlobalDrop as EventListener)
  }, [addFileNode, handleDroppedFolder, handleDroppedPath, screenToFlowPosition])

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
      } else if (sourceNode.type === 'transfer') {
        sourceType = 'any'
      }
      // merge nodes pass through — their output type matches upstream

      // Resolve target port file type
      let targetType = 'any'
      if (targetNode.type === 'tool') {
        const tool = getTool((targetNode.data as any).toolId)
        const connectedPortIds = nodes
          ? edges.filter((edge) => edge.target === targetNode.id).map((edge) => edge.targetHandle ?? 'input')
          : []
        const port = tool ? getActiveToolInputs(tool, targetNode.data as any, { connectedPortIds }).find((p) => p.id === conn.targetHandle) : undefined
        if (port) targetType = port.fileType
        else return false
      } else if (targetNode.type === 'file') {
        targetType = (targetNode.data as any).fileType
      } else if (targetNode.type === 'transform') {
        targetType = 'any'
      } else if (targetNode.type === 'transfer') {
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

  const handleReconnect = useCallback((oldEdge: typeof edges[number], connection: Connection) => {
    reconnectEdge(oldEdge.id, connection)
  }, [reconnectEdge])

  const handleReconnectEnd = useCallback((
    _event: MouseEvent | TouchEvent,
    edge: typeof edges[number],
    _handleType: 'source' | 'target',
    connectionState: FinalConnectionState,
  ) => {
    if (connectionState.isValid === true) return
    deleteEdge(edge.id)
  }, [deleteEdge])

  return (
    <div ref={wrapperRef} data-tour="canvas" className="relative flex-1 h-full w-full" onDrop={(event) => { void onDrop(event) }} onDragOver={onDragOver}>
      <ReactFlow
        nodes={displayNodes}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={handleReconnect}
        onReconnectEnd={handleReconnectEnd}
        onSelectionChange={onSelectionChange}
        onNodeContextMenu={onNodeContextMenu}
        isValidConnection={isValidConnection}
        defaultEdgeOptions={defaultEdgeOptions}
        edgesReconnectable
        proOptions={proOptions}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        snapToGrid
        snapGrid={[16, 16]}
        deleteKeyCode={['Delete', 'Backspace']}
        multiSelectionKeyCode={['Meta', 'Control']}
        colorMode={theme === 'light' ? 'light' : 'dark'}
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
            if (n.type === 'transfer') return '#22d3ee'
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
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="rounded-lg border border-dashed border-border bg-bg-secondary/70 px-6 py-5 text-center shadow-xl backdrop-blur-sm">
            <div className="text-sm font-medium text-text-primary">Build a pipeline</div>
            <div className="mt-1 text-xs text-text-secondary">
              Drag a file or folder here, or pick a tool from the left sidebar.
            </div>
            <div className="mt-1 text-[11px] text-text-muted">
              Folders become axis-split inputs. Help → Build Your First Pipeline for a guided tour.
            </div>
          </div>
        </div>
      )}
      {dropMessage && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-40 -translate-x-1/2 rounded border border-accent/40 bg-bg-secondary px-3 py-1 text-xs text-text-primary shadow">
          <div className="flex items-center gap-2">
            {dropBusy && <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />}
            <span>{dropMessage}</span>
          </div>
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
                      setGroupResourceEditor({
                        groupId: group.id,
                        label: group.label,
                        cpus: group.sharedResources?.cpus?.toString() ?? '',
                        memoryGB: group.sharedResources?.memoryGB?.toString() ?? '',
                        timeHours: group.sharedResources?.timeHours?.toString() ?? '',
                        partition: group.sharedResources?.partition ?? '',
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
      <Dialog
        open={groupResourceEditor !== null}
        onClose={() => setGroupResourceEditor(null)}
        title="Grouped sbatch resources"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setGroupResourceEditor(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!groupResourceEditor) return
                updateGroup(groupResourceEditor.groupId, {
                  sharedResources: {
                    cpus: groupResourceEditor.cpus.trim() ? Number(groupResourceEditor.cpus) : undefined,
                    memoryGB: groupResourceEditor.memoryGB.trim() ? Number(groupResourceEditor.memoryGB) : undefined,
                    timeHours: groupResourceEditor.timeHours.trim() ? Number(groupResourceEditor.timeHours) : undefined,
                    partition: groupResourceEditor.partition.trim() || undefined,
                  },
                })
                setGroupResourceEditor(null)
              }}
            >
              Save resources
            </Button>
          </>
        )}
      >
        {groupResourceEditor && (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 text-xs text-text-muted">
              Override the shared Slurm resources for <span className="text-text-primary">{groupResourceEditor.label}</span>. Leave fields blank to keep the automatic max-across-nodes behavior.
            </div>
            <Input
              label="CPUs"
              type="number"
              min={1}
              value={groupResourceEditor.cpus}
              onChange={(e) => setGroupResourceEditor((current) => current ? { ...current, cpus: e.target.value } : current)}
            />
            <Input
              label="Memory (GB)"
              type="number"
              min={1}
              value={groupResourceEditor.memoryGB}
              onChange={(e) => setGroupResourceEditor((current) => current ? { ...current, memoryGB: e.target.value } : current)}
            />
            <Input
              label="Time (hours)"
              type="number"
              min={0}
              step="0.5"
              value={groupResourceEditor.timeHours}
              onChange={(e) => setGroupResourceEditor((current) => current ? { ...current, timeHours: e.target.value } : current)}
            />
            <Input
              label="Partition"
              value={groupResourceEditor.partition}
              placeholder="Use connection default"
              onChange={(e) => setGroupResourceEditor((current) => current ? { ...current, partition: e.target.value } : current)}
            />
          </div>
        )}
      </Dialog>
    </div>
  )
}

function readLocalDropPaths(event: React.DragEvent): string[] {
  const files = Array.from(event.dataTransfer.files ?? [])
    .map((file) => window.api.local.pathForFile(file))
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
