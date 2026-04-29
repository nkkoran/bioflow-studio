/**
 * Jobs panel — bottom-panel tab showing the active pipeline run's node status
 * and per-node logs. No live log streaming yet: we read log files via SFTP on
 * refresh (with a 5s auto-refresh for running jobs).
 */
import { useEffect, useMemo, useState } from 'react'
import { useRunStore } from '@/stores/runStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { Button } from '@/components/ui/Button'
import { ChevronLeft, ChevronRight, FolderOpen, RefreshCw, X } from 'lucide-react'
import { NodeRunList } from './NodeRunList'
import { LogViewer } from './LogViewer'
import { JobSummary } from './JobSummary'
import { QueueDetails } from './QueueDetails'
import { FailureDiagnostic } from './FailureDiagnostic'
import { RunRecoveryCard } from './RunRecoveryCard'
import type { NodeRunState, RunState } from '@/types/pipeline'
import { useFileStore } from '@/stores/fileStore'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useUIStore } from '@/stores/uiStore'

export function JobsPanel() {
  const runs = useRunStore((s) => s.runs)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const setActiveRun = useRunStore((s) => s.setActiveRun)
  const cancelRun = useRunStore((s) => s.cancelRun)
  const rerunNode = useRunStore((s) => s.rerunNode)
  const refreshRuns = useRunStore((s) => s.refreshRuns)
  const selectedNodeId = useRunStore((s) => s.selectedNodeId)
  const diagnostics = useRunStore((s) => s.diagnostics)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const pipelineId = usePipelineStore((s) => s.pipelineId)
  const pipelineNodes = usePipelineStore((s) => s.nodes)
  const navigate = useFileStore((s) => s.navigate)
  const setActiveConnection = useConnectionStore((s) => s.setActiveConnection)
  const setBottomPanelMode = useUIStore((s) => s.setBottomPanelMode)
  const [nodesCollapsed, setNodesCollapsed] = useState(false)

  // Sort runs most-recent-first for the selector
  const sortedRuns = useMemo(
    () => Object.values(runs).sort((a, b) => b.createdAt - a.createdAt),
    [runs],
  )
  // Group by status so the dropdown surfaces running / queued first.
  const groupedRuns = useMemo(() => {
    const groups: Record<string, RunState[]> = { running: [], queued: [], done: [], failed: [], cancelled: [], other: [] }
    for (const r of sortedRuns) {
      const bucket = groups[r.status] ? r.status : 'other'
      groups[bucket].push(r)
    }
    return groups
  }, [sortedRuns])
  const activeRun = activeRunId ? runs[activeRunId] : null
  const isRunning = activeRun?.status === 'running' || activeRun?.status === 'queued'
  const activeRunIsDnxOnly = useMemo(() => {
    if (!activeRun?.snapshot) return false
    return activeRun.snapshot.nodes.every((node: any) => {
      if (node.type === 'tool') return node.data?.backend === 'dnx'
      if (node.type === 'file') return node.data?.origin !== 'ssh'
      if (node.type === 'merge' || node.type === 'transform') return false
      return true
    })
  }, [activeRun])
  const activeRunHasSshSteps = !activeRunIsDnxOnly && activeRun?.connectionId && activeRun.connectionId !== LOCAL_CONNECTION_ID

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
          {(['running', 'queued', 'done', 'failed', 'cancelled', 'other'] as const).map((bucket) => {
            const list = groupedRuns[bucket]
            if (!list || list.length === 0) return null
            return (
              <optgroup key={bucket} label={bucket.toUpperCase()}>
                {list.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {formatRunLabel(r)}
                  </option>
                ))}
              </optgroup>
            )
          })}
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

        {activeRun?.workDir && activeRunHasSshSteps && (
          <Button
            variant="ghost"
            size="sm"
            icon={<FolderOpen size={12} />}
            onClick={() => {
              setActiveConnection(activeRun.connectionId)
              void navigate(activeRun.workDir)
            }}
            className="h-6 text-xs"
            title="Open run folder in the file explorer"
          >
            Run folder
          </Button>
        )}

        {activeRun && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setBottomPanelMode('results')}
            className="h-6 text-xs"
            title="Browse run outputs"
          >
            Results
          </Button>
        )}

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
          {!nodesCollapsed ? (
            <div className="w-[34%] min-w-[260px] max-w-[420px] border-r border-border-light flex flex-col min-h-0">
              <RunHistoryList runs={sortedRuns} activeRunId={activeRun.runId} onSelect={setActiveRun} />
              <div className="border-t border-border-light px-3 py-1.5 shrink-0 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-text-muted">Steps</span>
                <span className="text-[10px] text-text-muted">{Object.keys(activeRun.nodes).length}</span>
                <button
                  onClick={() => setNodesCollapsed(true)}
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded border border-border text-text-muted hover:bg-bg-hover hover:text-text-primary"
                  title="Collapse step list"
                >
                  <ChevronLeft size={13} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0">
                <NodeRunList run={activeRun} />
              </div>
            </div>
          ) : (
            <button
              onClick={() => setNodesCollapsed(false)}
              className="w-8 shrink-0 border-r border-border-light bg-bg-secondary/40 text-text-muted hover:bg-bg-hover hover:text-text-primary flex items-center justify-center"
              title="Show step list"
            >
              <ChevronRight size={14} />
            </button>
          )}
          <div className="flex-1 min-w-0 flex flex-col">
            <RunDetails run={activeRun} />
            <QueueDetails run={activeRun} />
            <RunRecoveryCard
              run={activeRun}
              canRerun={activeRun.pipelineId === pipelineId}
              onRerun={(nodeId) => {
                if (activeRun.pipelineId !== pipelineId) return
                void rerunNode(activeRun.runId, nodeId, exportSnapshot())
              }}
            />
            {selectedNodeId && activeRun.nodes[selectedNodeId] && (
              <SelectedNodeSummary
                ns={activeRun.nodes[selectedNodeId]}
                label={labelForNode(activeRun.snapshot?.nodes as Array<{ id: string; type?: string; data: Record<string, unknown> }> | undefined ?? pipelineNodes, selectedNodeId)}
              />
            )}
            {(() => {
              const ns = selectedNodeId ? activeRun.nodes[selectedNodeId] : null
              const isTerminal =
                !!ns && (ns.status === 'done' || ns.status === 'failed' || ns.status === 'cancelled')
              return isTerminal && ns ? (
                <JobSummary runId={activeRun.runId} connectionId={activeRun.connectionId} ns={ns} />
              ) : null
            })()}
            {selectedNodeId && activeRun.nodes[selectedNodeId]?.status === 'failed' && activeRun.pipelineId === pipelineId && (
              <FailureDiagnostic
                nodeId={selectedNodeId}
                diagnostic={diagnostics[selectedNodeId]}
                onRerun={() => void rerunNode(activeRun.runId, selectedNodeId, exportSnapshot())}
              />
            )}
            {activeRunIsDnxOnly ? (
              <div className="h-full flex flex-col items-center justify-center gap-1 px-6 text-center text-xs text-text-muted">
                <span>DNAnexus jobs stream their logs on the platform.</span>
                <span className="text-[10px]">Open the job in the DNAnexus web UI for real-time stdout/stderr.</span>
              </div>
            ) : activeRun.connectionId && activeRun.connectionId !== LOCAL_CONNECTION_ID ? (
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
            <span className="text-xs text-text-primary truncate">
              {run.pipelineName?.trim() || run.workDir.split('/').pop() || run.runId.slice(0, 8)}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-text-muted truncate">
            {formatRelativeTime(run.createdAt)} · {formatAbsoluteTime(run.createdAt)} · {Object.keys(run.nodes).length} step{Object.keys(run.nodes).length === 1 ? '' : 's'}
          </div>
        </button>
      ))}
    </div>
  )
}

function SelectedNodeSummary({ ns, label }: { ns: NodeRunState; label: string }) {
  return (
    <div className="border-b border-border-light bg-bg-primary px-3 py-2 shrink-0">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-text-primary truncate">{label}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] ${statusChipColor(ns.status ?? 'idle')}`}>
          {ns.status ?? 'idle'}
        </span>
        {ns.isArray && <span className="text-[10px] text-accent">array {ns.arraySize ?? '?'}</span>}
        <span className="ml-auto text-[10px] text-text-muted font-mono">{formatDuration(ns)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-muted">
        {ns.jobId && <span>job <span className="font-mono text-text-secondary">{ns.jobId}</span></span>}
        {ns.exitCode !== undefined && <span>exit <span className="font-mono text-text-secondary">{ns.exitCode}</span></span>}
        {ns.outputDir && <span className="truncate">outputs <span className="font-mono text-text-secondary">{ns.outputDir}</span></span>}
      </div>
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

function formatRunLabel(run: { runId: string; createdAt: number; workDir: string; status: string; pipelineName?: string }): string {
  const folder = run.workDir.split('/').pop() ?? run.runId.slice(0, 8)
  const name = run.pipelineName?.trim()
  return `${name || folder}  •  ${formatRelativeTime(run.createdAt)}  •  ${run.status}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatAbsoluteTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatRelativeTime(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function labelForNode(nodes: Array<{ id: string; type?: string; data: Record<string, unknown> }>, nodeId: string): string {
  const node = nodes.find((candidate) => candidate.id === nodeId)
  const label = typeof node?.data.label === 'string' ? node.data.label.trim() : ''
  return label || nodeId
}

function formatDuration(ns: NodeRunState): string {
  const start = ns.startedAt ?? ns.submittedAt
  if (!start) return ''
  const end = ns.finishedAt ?? Date.now()
  const sec = Math.round((end - start) / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
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
