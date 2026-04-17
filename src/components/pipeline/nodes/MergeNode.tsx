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

function MergeNodeInner({ data, selected }: NodeProps) {
  const nodeData = data as MergeNodeData

  return (
    <div
      className={classNames(
        'bg-bg-secondary border-2 rounded-md shadow-lg min-w-[200px] transition-all',
        selected ? 'border-accent ring-2 ring-accent/30' : 'border-indigo-500/40',
      )}
    >
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <GitMerge size={14} className="text-indigo-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-text-muted">merge</div>
            <div className="text-xs font-semibold text-text-primary truncate">{nodeData.label}</div>
          </div>
        </div>
        <StatusBadge status={nodeData.status} />
      </div>

      <div className="px-3 py-2 text-[11px] text-text-secondary">
        <span className="text-text-muted">strategy: </span>
        <span className="font-mono">{nodeData.strategy}</span>
      </div>

      <Handle
        type="target"
        position={Position.Left}
        id="input"
        style={{
          left: -8,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 10,
          height: 10,
          background: 'var(--color-accent)',
          border: '2px solid var(--color-bg-secondary)',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        style={{
          right: -8,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 10,
          height: 10,
          background: 'var(--color-success, #10b981)',
          border: '2px solid var(--color-bg-secondary)',
        }}
      />

      {nodeData.error && (
        <div className="px-3 py-1.5 border-t border-error/20 bg-error/5 text-[10px] text-error truncate">
          {nodeData.error}
        </div>
      )}
      {nodeData.jobId && (
        <div className="px-3 py-1 border-t border-border text-[10px] text-text-muted font-mono">
          job: {nodeData.jobId}
        </div>
      )}
    </div>
  )
}

export const MergeNode = memo(MergeNodeInner)
