/**
 * Merge node — a fan-in that collapses an axed edge (e.g., per-chromosome
 * outputs) back into a single file. Runs as a single Slurm job with
 * `--dependency=afterok:<arrayJobId>`; the chosen strategy decides the merge
 * command (bcftools concat, plink2 --pmerge-list, tsv concat-with-header,
 * or plain cat).
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { classNames } from '@/lib/utils'
import { GitMerge, CheckCircle2, Circle, AlertCircle, Loader2, Clock, Ban } from 'lucide-react'
import type { MergeNodeData, ToolNodeData } from '@/types/pipeline'
import { useSuccessAnimation } from './useSuccessAnimation'

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
    <span className={classNames('bioflow-status-badge flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium', cls)}>
      {icon}
      {label}
    </span>
  )
}

function MergeNodeInner({ id, data, selected }: NodeProps) {
  const nodeData = data as MergeNodeData
  const successAnimating = useSuccessAnimation(nodeData.status)
  const convergeLabel = (nodeData.convergeMode ?? 'axed-fan-in') === 'parallel-branches' ? 'branches' : 'axis'
  const handles = nodeData.inputHandles?.length ? nodeData.inputHandles : [{ id: 'input', label: 'input' }]

  return (
    <div
      className={classNames(
        'animate-fade-up relative min-w-[200px] max-w-[320px] rounded-lg bg-bg-secondary/95 transition-all duration-150 ease-out',
        selected && 'translate-y-[-2px]',
        successAnimating && 'animate-success',
      )}
      style={{ boxShadow: selected ? 'var(--shadow-node-selected)' : 'var(--shadow-node)' }}
    >
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <GitMerge size={14} className="text-indigo-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-text-muted">merge</div>
            <div className="flex items-center gap-1.5">
              <div className="bioflow-canvas-node-label truncate text-xs font-semibold text-text-primary" title={nodeData.label}>{nodeData.label}</div>
              <span className="rounded bg-indigo-500/15 px-1 py-px text-[9px] text-indigo-200">
                {convergeLabel}
              </span>
            </div>
          </div>
        </div>
        <StatusBadge status={nodeData.status} />
      </div>

      <div className="px-3 py-2 text-[11px] text-text-secondary">
        <span className="text-text-muted">strategy: </span>
        <span className="font-mono truncate" title={nodeData.strategy}>{nodeData.strategy}</span>
        {handles.length > 1 && (
          <div className="mt-1 text-[10px] text-text-muted">{handles.length} inputs</div>
        )}
      </div>

      {handles.map((handle, index) => (
        <Handle
          key={handle.id}
          type="target"
          position={Position.Left}
          id={handle.id}
          className="bioflow-port-handle"
          data-port-node={id}
          data-port-id={handle.id}
          data-port-type="target"
          style={{
            position: 'absolute',
            left: -6,
            right: 'auto',
            top: `calc(${((index + 1) / (handles.length + 1)) * 100}% - 6px)`,
            width: 12,
            height: 12,
            borderRadius: '50%',
            transform: 'none',
            background: 'var(--color-accent)',
            border: '2px solid var(--color-bg-secondary)',
          }}
        />
      ))}
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
        <div className="px-3 py-1.5 bg-error/10 text-[10px] text-error truncate" title={nodeData.error}>
          {nodeData.error}
        </div>
      )}
      {nodeData.jobId && (
        <div className="px-3 py-1 text-[10px] text-text-muted font-mono truncate" title={nodeData.jobId}>
          job: {nodeData.jobId}
        </div>
      )}
    </div>
  )
}

export const MergeNode = memo(MergeNodeInner)
