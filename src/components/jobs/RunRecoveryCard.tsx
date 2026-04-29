import { useMemo } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { RunState } from '@/types/pipeline'

export function RunRecoveryCard({
  run,
  onRerun,
  canRerun,
}: {
  run: RunState
  onRerun: (nodeId: string) => void
  canRerun: boolean
}) {
  const snapshotNodes = run.snapshot?.nodes ?? []
  const snapshotEdges = run.snapshot?.edges ?? []
  const failedNodeIds = useMemo(
    () => Object.entries(run.nodes).filter(([, node]) => node.status === 'failed').map(([nodeId]) => nodeId),
    [run.nodes],
  )
  const completedCount = useMemo(
    () => Object.values(run.nodes).filter((node) => node.status === 'done').length,
    [run.nodes],
  )
  const blockedLabels = failedNodeIds.flatMap((nodeId) =>
    snapshotEdges
      .filter((edge) => edge.source === nodeId)
      .map((edge) => snapshotNodes.find((candidate) => candidate.id === edge.target)?.data?.label)
      .filter((label): label is string => Boolean(label)),
  )

  if (run.status !== 'failed' && run.status !== 'cancelled') return null

  return (
    <div className="border-b border-border-light bg-warning/5 px-3 py-2">
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="mt-0.5 text-warning shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-text-primary">
            Recovery assistant
          </div>
          <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
            {completedCount} step{completedCount === 1 ? '' : 's'} finished successfully and can usually be reused.
            {failedNodeIds.length > 0 && ` ${failedNodeIds.length} step${failedNodeIds.length === 1 ? '' : 's'} failed.`}
            {blockedLabels.length > 0 && ` Downstream work blocked: ${blockedLabels.slice(0, 3).join(', ')}${blockedLabels.length > 3 ? '…' : ''}.`}
          </div>
          {failedNodeIds[0] && canRerun && (
            <div className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCcw size={12} />}
                className="h-6 text-xs"
                onClick={() => onRerun(failedNodeIds[0])}
              >
                Re-run first failed step
              </Button>
            </div>
          )}
          {failedNodeIds[0] && !canRerun && (
            <div className="mt-2 text-[11px] text-text-muted">
              Re-run is only available when this run matches the pipeline currently open on the canvas.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
