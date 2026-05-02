/**
 * Tool node — represents a single invocation of a bioinformatics tool
 * in the pipeline graph. Renders the tool name, a status pill, and input/output
 * handles on the left/right edges.
 *
 * Handle ids match ToolPort.id from the tool registry so edges encode which
 * port they attach to.
 */
import { memo, useMemo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
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
    <span className={classNames('flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium', cls)}>
      {icon}
      {label}
    </span>
  )
}

const CATEGORY_COLORS: Record<string, string> = {
  'gwas': 'border-purple-500/40',
  'qc': 'border-amber-500/40',
  'variant-calling': 'border-rose-500/40',
  'alignment': 'border-sky-500/40',
  'annotation': 'border-emerald-500/40',
  'format': 'border-teal-500/40',
  'utility': 'border-slate-500/40',
  'custom': 'border-fuchsia-500/40',
}

function ToolNodeInner({ id, data, selected }: NodeProps) {
  const nodeData = data as ToolNodeData
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

  const borderColor = CATEGORY_COLORS[tool.category] ?? 'border-border'
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

  return (
    <ToolHoverCard tool={tool} connectedPorts={connectedInputs.size + connectedOutputs.size}>
      <div
      className={classNames(
        'bg-bg-secondary border-2 rounded-md shadow-lg min-w-[260px] max-w-[320px] transition-all',
        selected ? 'border-accent ring-2 ring-accent/30' : borderColor,
      )}
      >
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-text-muted flex items-center gap-1">
            <ToolIcon size={10} className="shrink-0" />
            <span>{tool.category}</span>
            {tool.backends && tool.backends.length > 1 && (
              <span className="rounded bg-cyan-500/15 px-1 py-px text-[9px] text-cyan-200 normal-case tracking-normal">
                {nodeData.backend === 'dnx' ? 'dnx' : 'ssh'}
              </span>
            )}
            {nodeData.executionMode === 'login' && (
              <span className="rounded bg-yellow-500/15 px-1 py-px text-[9px] text-yellow-300 normal-case tracking-normal">
                login
              </span>
            )}
          </div>
          <div className="text-xs font-semibold text-text-primary truncate">
            {nodeData.label}
          </div>
        </div>
        <StatusBadge status={nodeData.status} />
      </div>

      {outputPreview && (
        <div className="border-b border-border px-3 py-1 text-[10px] font-mono text-text-muted truncate">
          <MiddleEllipsis value={outputPreview} max={44} />
        </div>
      )}

      {/* Ports — each row is a fixed-height flex container with the Handle
          absolutely positioned relative to that row so the circle lines up
          exactly with the port label. */}
      <div className="px-3 py-2 flex flex-col text-[11px]">
        {/* Inputs on the left */}
        {activeInputs.length > 0 && (
          <div className="mb-1 text-[9px] uppercase tracking-wide text-text-muted">Inputs</div>
        )}
        {activeInputs.map((port) => {
          const connected = connectedInputs.has(port.id)
          const missingRequired = port.required && !connected
          return (
            <div
              key={port.id}
              className={classNames(
                'relative flex h-7 items-center gap-2 rounded-sm px-1',
                missingRequired ? 'bg-error/5 ring-1 ring-error/25' : '',
              )}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={port.id}
                style={{
                  left: -8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 10,
                  height: 10,
                  background: connected ? 'var(--color-accent)' : 'var(--color-bg-secondary)',
                  border: connected ? '2px solid var(--color-bg-secondary)' : '2px solid var(--color-accent)',
                }}
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
                  'shrink-0 rounded px-1 py-0.5 text-[8px] font-medium uppercase',
                  port.required ? 'bg-error/15 text-error' : 'bg-bg-tertiary text-text-muted',
                )}
                title={port.required ? 'Required input' : 'Optional input'}
              >
                {port.required ? 'req' : 'opt'}
              </span>
              <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-muted shrink-0">
                {port.fileType}
              </span>
            </div>
          )
        })}

        {activeInputs.length > 0 && tool.outputs.length > 0 && (
          <div className="h-px bg-border my-1" />
        )}

        {/* Outputs on the right */}
        {tool.outputs.length > 0 && (
          <div className="mb-1 text-[9px] uppercase tracking-wide text-text-muted">Outputs</div>
        )}
        {tool.outputs.map((port) => {
          const connected = connectedOutputs.has(port.id)
          const outputCount = edges.filter((edge) => edge.source === id && (edge.sourceHandle ?? 'output') === port.id).length
          const mergeConfig = nodeData.outputMerge?.[port.id]
          const autoMergeEnabled = mergeConfig
            ? mergeConfig.mode === 'auto-merge'
            : Boolean(port.autoMergeDefault)
          return (
            <div key={port.id} className="relative flex items-center justify-end h-7 gap-2">
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
                  className={`rounded px-1.5 py-0.5 text-[9px] shrink-0 ${
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
                <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[9px] text-accent shrink-0">
                  {outputCount}x
                </span>
              )}
              <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-muted shrink-0">
                {port.fileType}
              </span>
              <span className={classNames('min-w-0 flex-1 truncate text-right', connected ? 'text-text-primary' : 'text-text-secondary')}>
                {port.label}
              </span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.id}
                style={{
                  right: -8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 10,
                  height: 10,
                  background: connected ? 'var(--color-success, #10b981)' : 'var(--color-bg-secondary)',
                  border: connected ? '2px solid var(--color-bg-secondary)' : '2px solid var(--color-success, #10b981)',
                }}
              />
            </div>
          )
        })}
      </div>

      {/* Error line */}
      {nodeData.error && (
        <div className="px-3 py-1.5 border-t border-error/20 bg-error/5 text-[10px] text-error truncate">
          {nodeData.error}
        </div>
      )}

      {/* Job ID */}
      {nodeData.jobId && (
        <div className="px-3 py-1 border-t border-border text-[10px] text-text-muted font-mono">
          job: {nodeData.jobId}
        </div>
      )}
      </div>
    </ToolHoverCard>
  )
}

export const ToolNode = memo(ToolNodeInner)
