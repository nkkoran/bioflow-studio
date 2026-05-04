/**
 * Tool node — represents a single invocation of a bioinformatics tool
 * in the pipeline graph. Renders the tool name, a status pill, and input/output
 * handles on the left/right edges.
 *
 * Handle ids match ToolPort.id from the tool registry so edges encode which
 * port they attach to.
 */
import { memo, useMemo } from 'react'
import { Position, type NodeProps } from '@xyflow/react'
import { classNames } from '@/lib/utils'
import { getTool } from '@/lib/toolRegistry'
import type { ToolNodeData } from '@/types/pipeline'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { computeNodeOutputPreview } from '@/lib/outputPathPreview'
import { iconForTool } from '@/lib/toolIcons'
import { getActiveToolInputs } from '@/lib/analysisOptions'
import { CheckCircle2, Circle, AlertCircle, Loader2, Clock, Ban } from 'lucide-react'
import { ToolHoverCard } from '@/components/pipeline/ToolHoverCard'
import { MiddleEllipsis } from '@/components/ui/MiddleEllipsis'
import { useSuccessAnimation } from './useSuccessAnimation'
import { categoryTone, nodeChromeStyle } from './nodeTones'
import { PortHandle } from './PortHandle'
import { useSyncNodeHandles } from './useSyncNodeHandles'

interface StatusBadgeProps {
  status?: ToolNodeData['status']
}

function StatusBadge({ status = 'idle' }: StatusBadgeProps) {
  const map: Record<NonNullable<ToolNodeData['status']>, { icon: React.ReactNode; label: string; cls: string }> = {
    idle: { icon: <Circle size={10} />, label: 'Idle', cls: 'text-text-muted bg-bg-tertiary' },
    queued: { icon: <Clock size={10} />, label: 'Queued', cls: 'text-yellow-400 bg-yellow-500/10' },
    running: { icon: <Loader2 size={10} className="animate-spin" />, label: 'Running', cls: 'text-blue-400 bg-blue-500/10' },
    done: { icon: <CheckCircle2 size={10} />, label: 'Done', cls: 'text-green-400 bg-green-500/10' },
    failed: { icon: <AlertCircle size={10} />, label: 'Failed', cls: 'text-red-400 bg-red-500/10' },
    cancelled: { icon: <Ban size={10} />, label: 'Cancelled', cls: 'text-text-muted bg-bg-tertiary' },
  }
  const { icon, label, cls } = map[status]
  return (
    <span className={classNames('bioflow-status-badge flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium', cls)}>
      {icon}
      {label}
    </span>
  )
}

function ToolNodeInner({ id, data, selected }: NodeProps) {
  const nodeData = data as ToolNodeData
  const successAnimating = useSuccessAnimation(nodeData.status)
  const tool = getTool(nodeData.toolId)
  const ToolIcon = iconForTool(nodeData.toolId)
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const groups = usePipelineStore((s) => s.groups)
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const pipelineId = usePipelineStore((s) => s.pipelineId)
  const pipelineName = usePipelineStore((s) => s.pipelineName)
  const pipelineDescription = usePipelineStore((s) => s.pipelineDescription)
  const pathSettings = useSettingsStore((s) => s.settings.paths)
  const outputPreview = useMemo(() => computeNodeOutputPreview(id, {
    version: 1,
    id: pipelineId,
    name: pipelineName,
    description: pipelineDescription,
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
  }, pathSettings), [id, nodes, edges, groups, pipelineId, pipelineName, pipelineDescription, pathSettings])

  if (!tool) {
    return (
      <div className="px-3 py-2 rounded-md bg-bg-secondary border border-error text-xs text-error">
        Unknown tool: {nodeData.toolId}
      </div>
    )
  }

  const connectedInputs = new Set(edges.filter((edge) => edge.target === id).map((edge) => edge.targetHandle ?? 'input'))
  const activeInputs = getActiveToolInputs(tool, nodeData, { connectedPortIds: connectedInputs })
  const connectedOutputs = new Set(edges.filter((edge) => edge.source === id).map((edge) => edge.sourceHandle ?? 'output'))
  const inputDetailsByPort = useMemo(() => {
    const details = new Map<string, string>()
    for (const edge of edges) {
      if (edge.target !== id) continue
      const portId = edge.targetHandle ?? 'input'
      const source = nodes.find((node) => node.id === edge.source)
      if (!source) continue
      if (source.type === 'file') {
        const sourceData = source.data as { path?: string; split?: { axis?: string; items?: Array<{ path: string }> } }
        if ((sourceData.split?.items?.length ?? 0) > 0) {
          details.set(portId, `${sourceData.split?.items?.length ?? 0} files split by ${sourceData.split?.axis ?? 'axis'}`)
        } else if (sourceData.path) {
          details.set(portId, sourceData.path)
        }
      } else {
        details.set(portId, `${source.data.label ?? source.id}`)
      }
    }
    return details
  }, [edges, id, nodes])
  const hasAxedInput = edges.some((edge) => {
    if (edge.target !== id) return false
    const source = nodes.find((node) => node.id === edge.source)
    if (!source || source.type !== 'file') return false
    const sourceData = source.data as { split?: { items?: unknown[] } }
    return (sourceData.split?.items?.length ?? 0) > 0
  })
  const tone = categoryTone(tool.category)

  useSyncNodeHandles(id, [
    selected,
    nodeData.label,
    nodeData.status,
    nodeData.backend,
    nodeData.executionMode,
    activeInputs.length,
    tool.outputs.length,
    outputPreview,
  ])

  return (
    <ToolHoverCard tool={tool} connectedPorts={connectedInputs.size + connectedOutputs.size} disabled={Boolean(selected)}>
      <div
        className={classNames(
          'animate-fade-up relative min-w-[260px] max-w-[320px] rounded-lg border bg-bg-secondary/95 transition-all duration-150 ease-out',
          successAnimating && 'animate-success',
        )}
        style={nodeChromeStyle(tone, Boolean(selected))}
      >
      {/* Header */}
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 text-xs uppercase tracking-wide text-text-muted">
            <ToolIcon size={10} className="shrink-0" />
            <span>{tool.category}</span>
            {tool.backends && tool.backends.length > 1 && (
              <span className="rounded bg-cyan-500/15 px-1 py-px text-xs text-cyan-200 normal-case tracking-normal">
                {nodeData.backend === 'dnx' ? 'dnx' : 'ssh'}
              </span>
            )}
            {nodeData.executionMode === 'login' && (
              <span className="rounded bg-yellow-500/15 px-1 py-px text-xs text-yellow-300 normal-case tracking-normal">
                login
              </span>
            )}
          </div>
          <div className="bioflow-canvas-node-label truncate text-xs font-semibold text-text-primary">
            {nodeData.label}
          </div>
        </div>
        <StatusBadge status={nodeData.status} />
      </div>

      {outputPreview && (
        <div className="px-3 pb-1 text-xs font-mono text-text-muted truncate">
          <MiddleEllipsis value={outputPreview} max={44} />
        </div>
      )}

      {/* Ports — each row is a fixed-height flex container with the Handle
          absolutely positioned relative to that row so the circle lines up
          exactly with the port label. */}
      <div className="py-2 flex flex-col text-[11px]">
        {/* Inputs on the left */}
        {activeInputs.length > 0 && (
          <div className="mb-1 px-3 text-xs uppercase tracking-wide text-text-muted">Inputs</div>
        )}
        {activeInputs.map((port) => {
          const connected = connectedInputs.has(port.id)
          const missingRequired = port.required && !connected
          return (
            <div
              key={port.id}
              className={classNames(
                'relative flex h-7 items-center gap-2 rounded-sm pl-4 pr-4',
                missingRequired ? 'bg-error/5 ring-1 ring-error/25' : '',
              )}
            >
              <PortHandle
                nodeId={id}
                type="target"
                position={Position.Left}
                id={port.id}
                tone="input"
                connected={connected}
              />
              <span
                className={classNames('min-w-0 flex-1 truncate', connected ? 'text-text-primary' : 'text-text-secondary')}
                title={inputDetailsByPort.get(port.id)}
              >
                {port.label}
                {port.required && <span className="text-error ml-0.5">*</span>}
              </span>
              <span
                className={classNames(
                  'shrink-0 rounded px-1 py-0.5 text-xs font-medium uppercase',
                  port.required ? 'bg-error/15 text-error' : 'bg-bg-tertiary text-text-muted',
                )}
                title={port.required ? 'Required input' : 'Optional input'}
              >
                {port.required ? 'req' : 'opt'}
              </span>
              <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-muted shrink-0">
                {port.fileType}
              </span>
            </div>
          )
        })}

        {activeInputs.length > 0 && tool.outputs.length > 0 && (
          <div className="mx-3 my-1 h-px bg-border-light" />
        )}

        {/* Outputs on the right */}
        {tool.outputs.length > 0 && (
          <div className="mb-1 px-3 text-xs uppercase tracking-wide text-text-muted">Outputs</div>
        )}
        {tool.outputs.map((port) => {
          const connected = connectedOutputs.has(port.id)
          const outputCount = edges.filter((edge) => edge.source === id && (edge.sourceHandle ?? 'output') === port.id).length
          const mergeConfig = nodeData.outputMerge?.[port.id]
          const autoMergeEnabled = mergeConfig
            ? mergeConfig.mode === 'auto-merge'
            : Boolean(port.autoMergeDefault)
          return (
            <div key={port.id} className="relative flex h-7 items-center justify-end gap-2 pl-4 pr-4">
              {hasAxedInput && (port.autoMergeDefault || mergeConfig) && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    updateNodeData(id, {
                      outputMerge: {
                        ...(nodeData.outputMerge ?? {}),
                        [port.id]: autoMergeEnabled
                          ? { mode: 'fan-out', strategy: mergeConfig?.strategy ?? port.autoMergeDefault }
                          : { mode: 'auto-merge', strategy: mergeConfig?.strategy ?? port.autoMergeDefault },
                      },
                    })
                  }}
                  className={`rounded px-1.5 py-0.5 text-xs shrink-0 ${
                    autoMergeEnabled
                      ? 'bg-emerald-500/15 text-emerald-200'
                      : 'bg-bg-tertiary text-text-muted hover:text-text-primary'
                  }`}
                  title={autoMergeEnabled ? 'Auto-merge this array output into one downstream file' : 'Keep this output as fan-out / one file per task'}
                >
                  {autoMergeEnabled ? '⇢1' : `⋮${outputCount > 1 ? outputCount : ''}`}
                </button>
              )}
              {outputCount > 1 && (
                <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent shrink-0">
                  {outputCount}x
                </span>
              )}
              <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-muted shrink-0">
                {port.fileType}
              </span>
              <span className={classNames('min-w-0 flex-1 truncate text-right', connected ? 'text-text-primary' : 'text-text-secondary')}>
                {port.label}
              </span>
              <PortHandle
                nodeId={id}
                type="source"
                position={Position.Right}
                id={port.id}
                tone="output"
                connected={connected}
              />
            </div>
          )
        })}
      </div>

      {/* Error line */}
      {nodeData.error && (
        <div className="px-3 py-1.5 bg-error/10 text-xs text-error truncate">
          {nodeData.error}
        </div>
      )}

      {/* Job ID */}
      {nodeData.jobId && (
        <div className="px-3 py-1 text-xs text-text-muted font-mono">
          job: {nodeData.jobId}
        </div>
      )}
      </div>
    </ToolHoverCard>
  )
}

export const ToolNode = memo(ToolNodeInner)
