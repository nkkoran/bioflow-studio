/**
 * Jobs panel — bottom-panel tab showing the active pipeline run's node status
 * and per-node logs. No live log streaming yet: we read log files via SFTP on
 * refresh (with a 5s auto-refresh for running jobs).
 */
import { useEffect, useMemo, useState } from 'react'
import { useRunStore } from '@/stores/runStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { Button } from '@/components/ui/Button'
import { ChevronLeft, ChevronRight, Copy, FileText, FolderOpen, RefreshCw, RotateCcw, X } from 'lucide-react'
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
import { useDialogStore } from '@/stores/dialogStore'
import { buildRunManifest } from '@/lib/runManifest'
import { resolveRunConnectionId, runConnectionUnavailableMessage } from '@/lib/runConnection'
import { RunReportModal } from '@/components/pipeline/RunReportModal'
import type { RunManifest } from '@/types/workspace'

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
  const loadSnapshot = usePipelineStore((s) => s.loadSnapshot)
  const dirty = usePipelineStore((s) => s.dirty)
  const pipelineId = usePipelineStore((s) => s.pipelineId)
  const pipelineNodes = usePipelineStore((s) => s.nodes)
  const navigate = useFileStore((s) => s.navigate)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const connections = useConnectionStore((s) => s.connections)
  const setActiveConnection = useConnectionStore((s) => s.setActiveConnection)
  const setBottomPanelMode = useUIStore((s) => s.setBottomPanelMode)
  const confirmDialog = useDialogStore((s) => s.confirm)
  const [nodesCollapsed, setNodesCollapsed] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [reportPreview, setReportPreview] = useState<RunManifest | null>(null)

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
  const activeRunConnectionId = activeRun ? resolveRunConnectionId(activeRun, activeConnectionId, connections) : null
  const activeRunQueueConnectionId = activeRunHasSshSteps ? activeRunConnectionId : null

  const openReport = async () => {
    if (!activeRun) return
    setReporting(true)
    try {
      const scripts = activeRun.snapshot
        ? await window.api.pipeline.generateScriptsDry(activeRunConnectionId ?? activeRun.connectionId, activeRun.snapshot, activeRun.workDir).catch(() => [])
        : []
      setReportPreview(buildRunManifest(activeRun, activeRun.snapshot, activeRun.workspace ?? null, { scripts }))
    } finally {
      setReporting(false)
    }
  }

  const restoreRunSnapshot = async () => {
    if (!activeRun?.snapshot) return
    if (dirty) {
      const ok = await confirmDialog({
        title: 'Restore run pipeline',
        message: 'Replace the current canvas with the exact pipeline snapshot captured for this run?',
        detail: 'Unsaved canvas changes will be discarded. The submitted run is kept in history.',
        confirmLabel: 'Restore snapshot',
        cancelLabel: 'Keep current',
      })
      if (!ok) return
    }
    loadSnapshot(activeRun.snapshot)
    window.dispatchEvent(new CustomEvent('bioflow:toast', { detail: { kind: 'success', message: 'Restored run pipeline snapshot' } }))
  }

  const copyWorkDir = async () => {
    if (!activeRun?.workDir) return
    await navigator.clipboard.writeText(activeRun.workDir)
    window.dispatchEvent(new CustomEvent('bioflow:toast', { detail: { kind: 'success', message: 'Copied run folder path' } }))
  }

  const openRunFolder = async () => {
    if (!activeRun?.workDir) return
    if (!activeRunConnectionId) {
      window.dispatchEvent(new CustomEvent('bioflow:toast', { detail: { kind: 'error', message: runConnectionUnavailableMessage(activeRun) } }))
      return
    }
    setActiveConnection(activeRunConnectionId)
    await navigate(activeRun.workDir, { connectionId: activeRunConnectionId })
  }

  const retryFromNode = async (nodeId: string) => {
    if (!activeRun || activeRun.pipelineId !== pipelineId) return
    const snapshot = exportSnapshot()
    const affected = downstreamNodeIds(snapshot, nodeId)
    const reused = Object.values(activeRun.nodes)
      .filter((node) => node.nodeId !== nodeId && !affected.includes(node.nodeId) && node.status === 'done' && (node.outputPaths?.length ?? 0) > 0)
      .map((node) => labelForNode(activeRun.snapshot?.nodes as Array<{ id: string; type?: string; data: Record<string, unknown> }> | undefined ?? pipelineNodes, node.nodeId))
    const ok = await confirmDialog({
      title: 'Retry from here',
      message: `Rerun ${affected.length} step${affected.length === 1 ? '' : 's'} from this point downstream?`,
      detail: [
        `Will rerun: ${affected.map((id) => labelForNode(snapshot.nodes as Array<{ id: string; type?: string; data: Record<string, unknown> }>, id)).join(', ')}`,
        reused.length ? `Will reuse completed upstream outputs from: ${reused.join(', ')}` : 'No completed upstream outputs will be reused.',
      ].join('\n'),
      confirmLabel: 'Retry from here',
      cancelLabel: 'Cancel',
    })
    if (!ok) return
    await rerunNode(activeRun.runId, nodeId, snapshot)
  }

  useEffect(() => {
    if (!activeRunId && sortedRuns[0]) setActiveRun(sortedRuns[0].runId)
  }, [activeRunId, sortedRuns, setActiveRun])

  if (sortedRuns.length === 0) {
    return (
      <div className="animate-fade-up flex-1 flex items-center justify-center text-center text-sm text-text-muted">
        No runs yet. Click Run on a pipeline to start one.
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header: run selector + cancel */}
      <div className="flex items-center gap-2 px-3 py-1.5 shrink-0">
        <span className="text-xs text-text-muted">Run:</span>
        <select
          value={activeRunId ?? ''}
          onChange={(e) => setActiveRun(e.target.value || null)}
          className="bioflow-field min-w-[280px] rounded px-2 py-0.5 text-xs text-text-primary focus:outline-none"
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

        {activeRun?.workDir && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Copy size={12} />}
            onClick={() => void copyWorkDir()}
            className="h-6 text-xs"
            title="Copy run folder path"
          >
            Copy folder
          </Button>
        )}

        {activeRun?.snapshot && (
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw size={12} />}
            onClick={() => void restoreRunSnapshot()}
            className="h-6 text-xs"
            title="Restore the exact pipeline snapshot captured for this run"
          >
            Restore pipeline
          </Button>
        )}

        {activeRun?.workDir && activeRunHasSshSteps && (
          <Button
            variant="ghost"
            size="sm"
            icon={<FolderOpen size={12} />}
            onClick={() => void openRunFolder()}
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

        {activeRun && (
          <Button
            variant="primary"
            size="sm"
            icon={<FileText size={12} />}
            onClick={() => void openReport()}
            disabled={reporting}
            className="h-6 text-xs"
            title="Generate a reproducibility report for this run"
          >
            {reporting ? 'Building...' : 'Report'}
          </Button>
        )}

        {activeRun && selectedNodeId && activeRun.nodes[selectedNodeId]?.status === 'failed' && activeRun.pipelineId === pipelineId && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void retryFromNode(selectedNodeId)}
            title="Retry this failed step and every downstream step, reusing completed upstream outputs"
            className="h-6 text-xs"
          >
            Retry from here
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
            <div className="w-[34%] min-w-[260px] max-w-[420px] flex flex-col min-h-0">
              <RunHistoryList runs={sortedRuns} activeRunId={activeRun.runId} onSelect={setActiveRun} />
              <div className="px-3 py-1.5 shrink-0 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-text-muted">Steps</span>
                <span className="text-[10px] text-text-muted">{Object.keys(activeRun.nodes).length}</span>
                <button
                  onClick={() => setNodesCollapsed(true)}
                  className="ml-auto flex h-6 w-6 items-center justify-center rounded bg-bg-tertiary text-text-muted shadow-sm hover:bg-bg-hover hover:text-text-primary"
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
              className="w-8 shrink-0 bg-bg-secondary/40 text-text-muted hover:bg-bg-hover hover:text-text-primary flex items-center justify-center"
              title="Show step list"
            >
              <ChevronRight size={14} />
            </button>
          )}
          <div className="flex-1 min-w-0 flex flex-col">
            <RunDetails run={activeRun} />
            <QueueDetails run={activeRun} connectionId={activeRunQueueConnectionId} />
            <RunRecoveryCard
              run={activeRun}
              canRerun={activeRun.pipelineId === pipelineId}
              onRerun={(nodeId) => {
                if (activeRun.pipelineId !== pipelineId) return
                void retryFromNode(nodeId)
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
                <JobSummary run={activeRun} runId={activeRun.runId} connectionId={activeRunConnectionId} ns={ns} />
              ) : null
            })()}
            {selectedNodeId && activeRun.nodes[selectedNodeId]?.status === 'failed' && activeRun.pipelineId === pipelineId && (
              <FailureDiagnostic
                nodeId={selectedNodeId}
                diagnostic={diagnostics[selectedNodeId]}
                onRerun={() => void retryFromNode(selectedNodeId)}
              />
            )}
            {activeRunIsDnxOnly ? (
              <div className="h-full flex flex-col items-center justify-center gap-1 px-6 text-center text-xs text-text-muted">
                <span>DNAnexus jobs stream their logs on the platform.</span>
                <span className="text-[10px]">Open the job in the DNAnexus web UI for real-time stdout/stderr.</span>
              </div>
            ) : activeRunHasSshSteps && activeRunConnectionId ? (
              <LogViewer run={activeRun} connectionId={activeRunConnectionId} />
            ) : activeRunHasSshSteps ? (
              <div className="h-full flex items-center justify-center text-xs text-text-muted">
                {runConnectionUnavailableMessage(activeRun)}
              </div>
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
      {reportPreview && (
        <RunReportModal report={reportPreview} onClose={() => setReportPreview(null)} />
      )}
    </div>
  )
}

function downstreamNodeIds(snapshot: RunState['snapshot'], nodeId: string): string[] {
  if (!snapshot) return [nodeId]
  const outgoing = new Map<string, string[]>()
  for (const edge of snapshot.edges) {
    const list = outgoing.get(edge.source) ?? []
    list.push(edge.target)
    outgoing.set(edge.source, list)
  }
  const seen = new Set<string>([nodeId])
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  const runnable = new Set(snapshot.nodes.filter((node) => node.type === 'tool' || node.type === 'merge' || node.type === 'transform' || node.type === 'transfer').map((node) => node.id))
  return [...seen].filter((id) => runnable.has(id))
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
      <div className="sticky top-0 bg-bg-secondary/95 px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-muted shadow-sm">
        Past runs
      </div>
      {runs.map((run) => (
        <button
          key={run.runId}
          onClick={() => onSelect(run.runId)}
          className={`mx-2 mb-1 w-[calc(100%-1rem)] rounded-md px-3 py-2 text-left transition-all duration-150 hover:bg-bg-hover hover:shadow-sm ${
            activeRunId === run.runId ? 'bg-bg-hover shadow-sm ring-1 ring-accent/30' : ''
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
    <div className="bg-bg-primary/70 px-3 py-2 shadow-sm shrink-0">
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
    <div className="bg-bg-secondary/30 px-3 py-2 shadow-sm shrink-0">
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
