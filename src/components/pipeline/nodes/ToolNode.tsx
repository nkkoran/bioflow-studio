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
import { CheckCircle2, Circle, AlertCircle, Loader2, Clock, Ban } from 'lucide-react'
import { ToolHoverCard } from '@/components/pipeline/ToolHoverCard'

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
  const connectedOutputs = new Set(edges.filter((edge) => edge.source === id).map((edge) => edge.sourceHandle ?? 'output'))

  return (
    <ToolHoverCard tool={tool} connectedPorts={connectedInputs.size + connectedOutputs.size}>
      <div
      className={classNames(
        'bg-bg-secondary border-2 rounded-md shadow-lg min-w-[260px] transition-all',
        selected ? 'border-accent ring-2 ring-accent/30' : borderColor,
      )}
      >
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-text-muted flex items-center gap-1">
            <ToolIcon size={10} className="shrink-0" />
            <span>{tool.category}</span>
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
        <div
          className="border-b border-border px-3 py-1 text-[10px] font-mono text-text-muted truncate"
          title={outputPreview}
        >
          {outputPreview}
        </div>
      )}

      {/* Ports — each row is a fixed-height flex container with the Handle
          absolutely positioned relative to that row so the circle lines up
          exactly with the port label. */}
      <div className="px-3 py-2 flex flex-col text-[11px]">
        {/* Inputs on the left */}
        {tool.inputs.length > 0 && (
          <div className="mb-1 text-[9px] uppercase tracking-wide text-text-muted">Inputs</div>
        )}
        {tool.inputs.map((port) => {
          const connected = connectedInputs.has(port.id)
          return (
            <div key={port.id} className="relative flex items-center h-7 gap-2">
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
              <span className={classNames('min-w-0 flex-1 truncate', connected ? 'text-text-primary' : 'text-text-secondary')}>
                {port.label}
                {port.required && <span className="text-error ml-0.5">*</span>}
              </span>
              <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[9px] text-text-muted shrink-0">
                {port.fileType}
              </span>
            </div>
          )
        })}

        {tool.inputs.length > 0 && tool.outputs.length > 0 && (
          <div className="h-px bg-border my-1" />
        )}

        {/* Outputs on the right */}
        {tool.outputs.length > 0 && (
          <div className="mb-1 text-[9px] uppercase tracking-wide text-text-muted">Outputs</div>
        )}
        {tool.outputs.map((port) => {
          const connected = connectedOutputs.has(port.id)
          return (
            <div key={port.id} className="relative flex items-center justify-end h-7 gap-2">
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
