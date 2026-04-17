/**
 * Jobs panel — bottom-panel tab showing the active pipeline run's node status
 * and per-node logs. No live log streaming yet: we read log files via SFTP on
 * refresh (with a 5s auto-refresh for running jobs).
 */
import { useMemo } from 'react'
import { useRunStore } from '@/stores/runStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { Button } from '@/components/ui/Button'
import { X } from 'lucide-react'
import { NodeRunList } from './NodeRunList'
import { LogViewer } from './LogViewer'
import { JobSummary } from './JobSummary'

export function JobsPanel() {
  const runs = useRunStore((s) => s.runs)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const setActiveRun = useRunStore((s) => s.setActiveRun)
  const cancelRun = useRunStore((s) => s.cancelRun)
  const selectedNodeId = useRunStore((s) => s.selectedNodeId)

  // Sort runs most-recent-first for the selector
  const sortedRuns = useMemo(
    () => Object.values(runs).sort((a, b) => b.createdAt - a.createdAt),
    [runs],
  )
  const activeRun = activeRunId ? runs[activeRunId] : null
  const isRunning = activeRun?.status === 'running' || activeRun?.status === 'queued'
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)

  if (sortedRuns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-text-muted">
        No runs yet. Click Run on a pipeline to start one.
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header: run selector + cancel */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-light shrink-0">
        <span className="text-xs text-text-muted">Run:</span>
        <select
          value={activeRunId ?? ''}
          onChange={(e) => setActiveRun(e.target.value || null)}
          className="bg-bg-primary border border-border rounded px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent min-w-[280px]"
        >
          {sortedRuns.map((r) => (
            <option key={r.runId} value={r.runId}>
              {formatRunLabel(r)}
            </option>
          ))}
        </select>

        {activeRun && (
          <span className={`text-xs px-2 py-0.5 rounded ${statusChipColor(activeRun.status)}`}>
            {activeRun.status}
          </span>
        )}

        <div className="flex-1" />

        {isRunning && activeRunId && (
          <Button
            variant="ghost"
            size="sm"
            icon={<X size={12} />}
            onClick={() => void cancelRun(activeRunId)}
            className="h-6 text-xs text-error"
          >
            Cancel run
          </Button>
        )}
      </div>

      {/* Body: node list (left) + log viewer (right) */}
      {activeRun ? (
        <div className="flex-1 flex min-h-0">
          <div className="w-[40%] min-w-[220px] max-w-[420px] border-r border-border-light overflow-y-auto">
            <NodeRunList run={activeRun} />
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            {(() => {
              const ns = selectedNodeId ? activeRun.nodes[selectedNodeId] : null
              const isTerminal =
                !!ns && (ns.status === 'done' || ns.status === 'failed' || ns.status === 'cancelled')
              return isTerminal && ns ? <JobSummary runId={activeRun.runId} ns={ns} /> : null
            })()}
            {activeConnectionId ? (
              <LogViewer run={activeRun} connectionId={activeConnectionId} />
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-text-muted">
                Connect to view logs.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-text-muted">
          Select a run to view its status.
        </div>
      )}
    </div>
  )
}

function formatRunLabel(run: { runId: string; createdAt: number; workDir: string; status: string }): string {
  const d = new Date(run.createdAt)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  // Extract the run folder name from workDir for a human label.
  const folder = run.workDir.split('/').pop() ?? run.runId.slice(0, 8)
  return `${date} ${time}  •  ${folder}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function statusChipColor(status: string): string {
  switch (status) {
    case 'running': return 'bg-warning/20 text-warning'
    case 'done': return 'bg-success/20 text-success'
    case 'failed': return 'bg-error/20 text-error'
    case 'cancelled': return 'bg-text-muted/20 text-text-muted'
    default: return 'bg-bg-primary text-text-secondary'
  }
}
