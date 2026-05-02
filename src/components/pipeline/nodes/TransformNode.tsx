import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { SlidersHorizontal, CheckCircle2, Circle, AlertCircle, Loader2, Clock, Ban } from 'lucide-react'
import { classNames } from '@/lib/utils'
import type { ToolNodeData, TransformNodeData } from '@/types/pipeline'
import { useSuccessAnimation } from './useSuccessAnimation'

function StatusBadge({ status = 'idle' }: { status?: ToolNodeData['status'] }) {
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
    <span className={classNames('bioflow-status-badge flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium', cls)}>
      {icon}
      {label}
    </span>
  )
}

function TransformNodeInner({ id, data, selected }: NodeProps) {
  const nodeData = data as TransformNodeData
  const successAnimating = useSuccessAnimation(nodeData.status)
  const filterCount = nodeData.filters?.length ?? 0
  const columnCount = nodeData.selectedColumns?.length ?? 0

  return (
    <div
      className={classNames(
        'animate-fade-up relative min-w-[200px] rounded-lg bg-bg-secondary/95 transition-all duration-150 ease-out',
        selected && 'translate-y-[-2px]',
        successAnimating && 'animate-success',
      )}
      style={{ boxShadow: selected ? 'var(--shadow-node-selected)' : 'var(--shadow-node)' }}
    >
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <SlidersHorizontal size={14} className="text-teal-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-text-muted">transform</div>
            <div className="bioflow-canvas-node-label truncate text-xs font-semibold text-text-primary">{nodeData.label}</div>
          </div>
        </div>
        <StatusBadge status={nodeData.status} />
      </div>

      <div className="px-3 py-2 text-[11px] text-text-secondary space-y-1">
        <div><span className="text-text-muted">columns: </span>{columnCount > 0 ? columnCount : 'all'}</div>
        <div><span className="text-text-muted">filters: </span>{filterCount}</div>
      </div>

      <Handle
        type="target"
        position={Position.Left}
        id="input"
        className="bioflow-port-handle"
        data-port-node={id}
        data-port-id="input"
        data-port-type="target"
        style={{
          position: 'absolute',
          left: -6,
          right: 'auto',
          top: 'calc(50% - 6px)',
          width: 12,
          height: 12,
          borderRadius: '50%',
          transform: 'none',
          background: 'var(--color-accent)',
          border: '2px solid var(--color-bg-secondary)',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        className="bioflow-port-handle"
        data-port-node={id}
        data-port-id="output"
        data-port-type="source"
        style={{
          position: 'absolute',
          left: 'auto',
          right: -6,
          top: 'calc(50% - 6px)',
          width: 12,
          height: 12,
          borderRadius: '50%',
          transform: 'none',
          background: 'var(--color-success)',
          border: '2px solid var(--color-bg-secondary)',
        }}
      />

      {nodeData.error && (
        <div className="px-3 py-1.5 bg-error/10 text-[10px] text-error truncate">
          {nodeData.error}
        </div>
      )}
      {nodeData.jobId && (
        <div className="px-3 py-1 text-[10px] text-text-muted font-mono">
          job: {nodeData.jobId}
        </div>
      )}
    </div>
  )
}

export const TransformNode = memo(TransformNodeInner)
