/**
 * Tool node — represents a single invocation of a bioinformatics tool
 * in the pipeline graph. Renders the tool name, a status pill, and input/output
 * handles on the left/right edges.
 *
 * Handle ids match ToolPort.id from the tool registry so edges encode which
 * port they attach to.
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { classNames } from '@/lib/utils'
import { getTool } from '@/lib/toolRegistry'
import type { ToolNodeData } from '@/types/pipeline'
import { CheckCircle2, Circle, AlertCircle, Loader2, Clock, Ban } from 'lucide-react'

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

function ToolNodeInner({ data, selected }: NodeProps) {
  const nodeData = data as ToolNodeData
  const tool = getTool(nodeData.toolId)

  if (!tool) {
    return (
      <div className="px-3 py-2 rounded-md bg-bg-secondary border border-error text-xs text-error">
        Unknown tool: {nodeData.toolId}
      </div>
    )
  }

  const borderColor = CATEGORY_COLORS[tool.category] ?? 'border-border'

  return (
    <div
      className={classNames(
        'bg-bg-secondary border-2 rounded-md shadow-lg min-w-[200px] transition-all',
        selected ? 'border-accent ring-2 ring-accent/30' : borderColor,
      )}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">
            {tool.category}
          </div>
          <div className="text-xs font-semibold text-text-primary truncate">
            {nodeData.label}
          </div>
        </div>
        <StatusBadge status={nodeData.status} />
      </div>

      {/* Ports */}
      <div className="px-3 py-2 flex flex-col gap-1 text-[11px]">
        {/* Inputs on the left */}
        {tool.inputs.map((port, idx) => (
          <div key={port.id} className="relative flex items-center">
            <Handle
              type="target"
              position={Position.Left}
              id={port.id}
              style={{
                left: -8,
                top: `${(idx + 0.5) * 20 + 4}px`,
                width: 10,
                height: 10,
                background: 'var(--color-accent)',
                border: '2px solid var(--color-bg-secondary)',
              }}
            />
            <span className="text-text-secondary">
              <span className="text-text-muted">◀ </span>
              {port.label}
              {port.required && <span className="text-error ml-0.5">*</span>}
            </span>
          </div>
        ))}

        {tool.inputs.length > 0 && tool.outputs.length > 0 && (
          <div className="h-px bg-border my-1" />
        )}

        {/* Outputs on the right */}
        {tool.outputs.map((port, idx) => (
          <div key={port.id} className="relative flex items-center justify-end">
            <span className="text-text-secondary">
              {port.label}
              <span className="text-text-muted"> ▶</span>
            </span>
            <Handle
              type="source"
              position={Position.Right}
              id={port.id}
              style={{
                right: -8,
                top: `${(tool.inputs.length + (tool.inputs.length > 0 ? 1 : 0) + idx + 0.5) * 20 + 4}px`,
                width: 10,
                height: 10,
                background: 'var(--color-success, #10b981)',
                border: '2px solid var(--color-bg-secondary)',
              }}
            />
          </div>
        ))}
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
  )
}

export const ToolNode = memo(ToolNodeInner)
