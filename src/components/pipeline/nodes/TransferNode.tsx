import { memo } from 'react'
import { Position, type NodeProps } from '@xyflow/react'
import { ArrowRightLeft, CheckCircle2, Circle, AlertCircle, Loader2, Clock, Ban } from 'lucide-react'
import { classNames } from '@/lib/utils'
import type { ToolNodeData, TransferNodeData } from '@/types/pipeline'
import { useSuccessAnimation } from './useSuccessAnimation'
import { nodeChromeStyle, nodeTypeTone } from './nodeTones'
import { PortHandle } from './PortHandle'

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
    <span className={classNames('bioflow-status-badge flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium', cls)}>
      {icon}
      {label}
    </span>
  )
}

function backendLabel(value: 'local' | 'ssh' | 'dnx'): string {
  if (value === 'dnx') return 'DNAnexus'
  if (value === 'local') return 'Local'
  return 'Rorqual'
}

function TransferNodeInner({ id, data, selected }: NodeProps) {
  const nodeData = data as TransferNodeData
  const successAnimating = useSuccessAnimation(nodeData.status)
  const tone = nodeTypeTone('transfer')

  return (
    <div
      className={classNames(
        'animate-fade-up relative min-w-[220px] rounded-lg border bg-bg-secondary/95 transition-all duration-150 ease-out',
        successAnimating && 'animate-success',
      )}
      style={nodeChromeStyle(tone, Boolean(selected))}
    >
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <ArrowRightLeft size={14} className="text-cyan-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase tracking-wide text-text-muted">transfer</div>
            <div className="bioflow-canvas-node-label truncate text-xs font-semibold text-text-primary">{nodeData.label}</div>
          </div>
        </div>
        <StatusBadge status={nodeData.status} />
      </div>

      <div className="px-3 py-2 text-xs text-text-secondary space-y-1">
        <div>
          <span className="text-text-muted">route: </span>
          <span>{backendLabel(nodeData.from)} {'->'} {backendLabel(nodeData.to)}</span>
        </div>
        {nodeData.outputName && (
          <div>
            <span className="text-text-muted">name: </span>
            <span className="font-mono">{nodeData.outputName}</span>
          </div>
        )}
      </div>

      <PortHandle
        nodeId={id}
        type="target"
        position={Position.Left}
        id="input"
        tone="input"
      />
      <PortHandle
        nodeId={id}
        type="source"
        position={Position.Right}
        id="output"
        tone="output"
      />

      {nodeData.error && (
        <div className="px-3 py-1.5 bg-error/10 text-xs text-error truncate" title={nodeData.error}>
          {nodeData.error}
        </div>
      )}
      {nodeData.jobId && (
        <div className="px-3 py-1 text-xs text-text-muted font-mono truncate" title={nodeData.jobId}>
          job: {nodeData.jobId}
        </div>
      )}
    </div>
  )
}

export const TransferNode = memo(TransferNodeInner)
