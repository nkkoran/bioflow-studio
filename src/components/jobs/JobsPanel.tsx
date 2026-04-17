/**
 * Jobs panel — bottom-panel tab showing the active pipeline run's node status
 * and per-node logs. No live log streaming yet: we read log files via SFTP on
 * refresh (with a 5s auto-refresh for running jobs).
 */
import { useEffect, useMemo } from 'react'
import { useRunStore } from '@/stores/runStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { Button } from '@/components/ui/Button'
import { RefreshCw, X } from 'lucide-react'
import { NodeRunList } from './NodeRunList'
import { LogViewer } from './LogViewer'
import { JobSummary } from './JobSummary'
import { QueueDetails } from './QueueDetails'
import type { RunState } from '@/types/pipeline'

export function JobsPanel() {
  const runs = useRunStore((s) => s.runs)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const setActiveRun = useRunStore((s) => s.setActiveRun)
  const cancelRun = useRunStore((s) => s.cancelRun)
  const rerunNode = useRunStore((s) => s.rerunNode)
  const refreshRuns = useRunStore((s) => s.refreshRuns)
  const selectedNodeId = useRunStore((s) => s.selectedNodeId)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const pipelineId = usePipelineStore((s) => s.pipelineId)

  // Sort runs most-recent-first for the selector
  const sortedRuns = useMemo(
    () => Object.values(runs).sort((a, b) => b.createdAt - a.createdAt),
    [runs],
  )
  const activeRun = activeRunId ? runs[activeRunId] : null
  const isRunning = activeRun?.status === 'running' || activeRun?.status === 'queued'

  useEffect(() => {
    if (!activeRunId && sortedRuns[0]) setActiveRun(sortedRuns[0].runId)
  }, [activeRunId, sortedRuns, setActiveRun])

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

        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={12} />}
          onClick={() => void refreshRuns()}
          className="h-6 text-xs"
        >
          Refresh
        </Button>

        {activeRun && selectedNodeId && activeRun.nodes[selectedNodeId]?.status === 'failed' && activeRun.pipelineId === pipelineId && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void rerunNode(activeRun.runId, selectedNodeId, exportSnapshot())}
            className="h-6 text-xs"
          >
            Re-run step
          </Button>
        )}

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
          <div className="w-[42%] min-w-[260px] max-w-[460px] border-r border-border-light flex flex-col min-h-0">
            <RunHistoryList runs={sortedRuns} activeRunId={activeRun.runId} onSelect={setActiveRun} />
            <div className="border-t border-border-light px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-muted shrink-0">
              Nodes
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              <NodeRunList run={activeRun} />
            </div>
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            <RunDetails run={activeRun} />
            <QueueDetails run={activeRun} />
            {(() => {
              const ns = selectedNodeId ? activeRun.nodes[selectedNodeId] : null
              const isTerminal =
                !!ns && (ns.status === 'done' || ns.status === 'failed' || ns.status === 'cancelled')
              return isTerminal && ns ? (
                <JobSummary runId={activeRun.runId} connectionId={activeRun.connectionId} ns={ns} />
              ) : null
            })()}
            {activeRun.connectionId ? (
              <LogViewer run={activeRun} connectionId={activeRun.connectionId} />
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

function RunHistoryList({
  runs,
  activeRunId,
  onSelect,
}: {
  runs: RunState[]
  activeRunId: string
  onSelect: (runId: string) => void
}) {
  return (
    <div className="shrink-0 max-h-36 overflow-y-auto">
      <div className="sticky top-0 bg-bg-secondary border-b border-border-light px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-muted">
        Past runs
      </div>
      {runs.map((run) => (
        <button
          key={run.runId}
          onClick={() => onSelect(run.runId)}
          className={`w-full text-left px-3 py-2 border-l-2 border-b border-border-light/60 hover:bg-bg-hover ${
            activeRunId === run.runId ? 'bg-bg-hover border-accent' : 'border-transparent'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusChipColor(run.status)}`}>
              {run.status}
            </span>
            <span className="text-xs text-text-primary truncate">{run.workDir.split('/').pop() ?? run.runId.slice(0, 8)}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-text-muted truncate">
            {formatAbsoluteTime(run.createdAt)} · {Object.keys(run.nodes).length} node{Object.keys(run.nodes).length === 1 ? '' : 's'}
          </div>
        </button>
      ))}
    </div>
  )
}

function RunDetails({ run }: { run: RunState }) {
  return (
    <div className="border-b border-border-light bg-bg-secondary/30 px-3 py-2 shrink-0">
      <div className="flex items-center gap-3 text-[11px] text-text-secondary">
        <span className={`px-1.5 py-0.5 rounded ${statusChipColor(run.status)}`}>{run.status}</span>
        <span>
          <span className="text-text-muted">created </span>
          {formatAbsoluteTime(run.createdAt)}
        </span>
        <span>
          <span className="text-text-muted">updated </span>
          {formatAbsoluteTime(run.updatedAt)}
        </span>
      </div>
      <div className="mt-1 text-[10px] text-text-muted font-mono truncate" title={run.workDir}>
        {run.workDir}
      </div>
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

function formatAbsoluteTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
