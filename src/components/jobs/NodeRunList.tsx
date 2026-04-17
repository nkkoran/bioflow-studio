/**
 * Node run list — left pane of the Jobs panel. One row per tool/merge node
 * in the active run. Clicking a row selects it for the log viewer.
 *
 * Durations tick live once per second while any node is running.
 */
import { useEffect, useState } from 'react'
import { useRunStore } from '@/stores/runStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import type { RunState, NodeRunState } from '@/types/pipeline'
import { Loader2, CheckCircle2, XCircle, Clock, CircleSlash, CirclePause } from 'lucide-react'

interface Props { run: RunState }

export function NodeRunList({ run }: Props) {
  const selectedNodeId = useRunStore((s) => s.selectedNodeId)
  const setSelectedNode = useRunStore((s) => s.setSelectedNode)
  const pipelineNodes = usePipelineStore((s) => s.nodes)

  // Build a label lookup — pipeline store is the source of truth for user-visible labels.
  const labelFor = (nodeId: string): string => {
    const n = pipelineNodes.find((x) => x.id === nodeId)
    if (!n) return nodeId
    if (n.type === 'tool') return (n.data as { label: string }).label
    if (n.type === 'merge') return (n.data as { label: string }).label
    return nodeId
  }

  // 1s ticker so live durations actually update without hammering zustand.
  const [, setTick] = useState(0)
  useEffect(() => {
    const anyRunning = Object.values(run.nodes).some(
      (n) => n.status === 'running' || n.status === 'queued',
    )
    if (!anyRunning) return
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [run.nodes])

  const rows = Object.values(run.nodes).sort((a, b) => {
    // submittedAt preserves topo order for anything that's been submitted
    const sa = a.submittedAt ?? Infinity
    const sb = b.submittedAt ?? Infinity
    return sa - sb
  })

  // Auto-select the first node when nothing is selected so the log pane
  // has something to show.
  useEffect(() => {
    if (selectedNodeId == null && rows[0]) setSelectedNode(rows[0].nodeId)
  }, [selectedNodeId, rows, setSelectedNode])

  return (
    <div className="py-1">
      {rows.map((ns) => (
        <button
          key={ns.nodeId}
          onClick={() => setSelectedNode(ns.nodeId)}
          className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs border-l-2 transition-colors ${
            selectedNodeId === ns.nodeId
              ? 'bg-bg-hover border-accent'
              : 'border-transparent hover:bg-bg-hover'
          }`}
        >
          <StatusIcon status={ns.status} />
          <div className="flex-1 min-w-0">
            <div className="text-text-primary truncate font-medium">{labelFor(ns.nodeId)}</div>
            <div className="text-[10px] text-text-muted truncate">
              {ns.jobId ? `job ${ns.jobId}${ns.isArray ? ` [${ns.arraySize}]` : ''}` : '—'}
              {ns.exitCode !== undefined && ns.exitCode !== 0 && (
                <span className="text-error ml-2">exit {ns.exitCode}</span>
              )}
            </div>
          </div>
          <div className="text-[10px] text-text-muted font-mono shrink-0">
            {formatDuration(ns)}
          </div>
        </button>
      ))}
    </div>
  )
}

function StatusIcon({ status }: { status: NodeRunState['status'] }) {
  const cls = 'shrink-0'
  switch (status) {
    case 'running': return <Loader2 size={14} className={`${cls} text-warning animate-spin`} />
    case 'queued': return <Clock size={14} className={`${cls} text-warning`} />
    case 'done': return <CheckCircle2 size={14} className={`${cls} text-success`} />
    case 'failed': return <XCircle size={14} className={`${cls} text-error`} />
    case 'cancelled': return <CircleSlash size={14} className={`${cls} text-text-muted`} />
    case 'idle': return <CirclePause size={14} className={`${cls} text-text-muted`} />
    default: return <CirclePause size={14} className={`${cls} text-text-muted`} />
  }
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
