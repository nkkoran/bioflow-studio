import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useRunStore } from '@/stores/runStore'
import type { ArrayTaskMapEntry, ArrayTaskState, ArrayTaskStatus, NodeRunState, RunState } from '@/types/pipeline'
import { classNames } from '@/lib/utils'
import { RefreshCw } from 'lucide-react'

type Filter = 'all' | 'running' | 'failed' | 'completed'

interface Props {
  run: RunState
  ns: NodeRunState
}

interface TaskRow extends ArrayTaskMapEntry {
  status: ArrayTaskStatus
}

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'failed', label: 'Failed' },
  { id: 'completed', label: 'Done' },
]

export function ArrayJobViewer({ run, ns }: Props) {
  const selectedArrayTaskId = useRunStore((state) => state.selectedArrayTaskId)
  const setSelectedArrayTask = useRunStore((state) => state.setSelectedArrayTask)
  const [filter, setFilter] = useState<Filter>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => taskRowsForNode(ns), [ns])
  const visibleRows = useMemo(() => rows.filter((row) => filterMatches(row.status.state, filter)), [filter, rows])
  const selectedTaskId = selectedArrayTaskId && rows.some((row) => row.taskId === selectedArrayTaskId)
    ? selectedArrayTaskId
    : rows[0]?.taskId ?? null
  const counts = useMemo(() => taskCounts(rows), [rows])

  useEffect(() => {
    if (!selectedTaskId || selectedArrayTaskId === selectedTaskId) return
    setSelectedArrayTask(selectedTaskId)
  }, [selectedArrayTaskId, selectedTaskId, setSelectedArrayTask])

  if (!ns.isArray || rows.length === 0) return null

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      await window.api.pipeline.refreshArrayTasks(run.runId, ns.nodeId)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="shrink-0 border-b border-border/60 bg-bg-secondary/35 px-3 py-2">
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-text-primary">
            Split job monitor
            <span className="ml-2 text-[10px] font-normal text-text-muted">
              {ns.arrayAxis ? `${ns.arrayAxis} axis` : 'Slurm array'} · {rows.length} tasks
            </span>
          </div>
          {error && <div className="mt-0.5 text-[10px] text-warning">{error}</div>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={classNames(
                'h-6 rounded px-2 text-[10px] transition-colors',
                filter === item.id
                  ? 'bg-bg-hover text-text-primary shadow-sm ring-1 ring-border'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {item.label}
            </button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />}
            disabled={refreshing}
            onClick={() => void refresh()}
            className="h-6 px-2 text-[10px]"
          >
            Refresh
          </Button>
        </div>
      </div>

      <StackedProgress counts={counts} total={rows.length} />

      <div className="mt-2 grid grid-cols-[minmax(180px,260px)_1fr] gap-2">
        <div className="grid max-h-28 grid-cols-6 gap-1 overflow-y-auto rounded-md border border-border/70 bg-bg-primary/60 p-1">
          {rows.map((row) => (
            <button
              key={row.taskId}
              type="button"
              onClick={() => setSelectedArrayTask(row.taskId)}
              title={`${row.label}\n${row.status.slurmState ?? row.status.state}${row.status.reason ? `\n${row.status.reason}` : ''}`}
              className={classNames(
                'h-6 rounded text-[10px] font-mono transition-all',
                taskPillClass(row.status.state),
                selectedTaskId === row.taskId && 'ring-2 ring-accent ring-offset-1 ring-offset-bg-primary',
              )}
            >
              {shortTaskLabel(row)}
            </button>
          ))}
        </div>

        <div className="max-h-28 overflow-auto rounded-md border border-border/70 bg-bg-primary/60">
          <table className="w-full border-collapse text-left text-[10px]">
            <thead className="sticky top-0 bg-bg-secondary text-text-muted">
              <tr>
                <th className="px-2 py-1 font-medium">Task</th>
                <th className="px-2 py-1 font-medium">State</th>
                <th className="px-2 py-1 font-medium">Elapsed</th>
                <th className="px-2 py-1 font-medium">Exit</th>
                <th className="px-2 py-1 font-medium">Node / reason</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={row.taskId}
                  onClick={() => setSelectedArrayTask(row.taskId)}
                  className={classNames(
                    'cursor-pointer border-t border-border/40 hover:bg-bg-hover',
                    selectedTaskId === row.taskId && 'bg-bg-hover',
                  )}
                >
                  <td className="px-2 py-1 font-mono text-text-primary">{row.label}</td>
                  <td className="px-2 py-1">
                    <span className={classNames('rounded px-1.5 py-0.5', statusTextClass(row.status.state))}>
                      {row.status.slurmState ?? row.status.state}
                    </span>
                  </td>
                  <td className="px-2 py-1 font-mono text-text-secondary">{row.status.elapsed ?? ''}</td>
                  <td className="px-2 py-1 font-mono text-text-secondary">{row.status.exitCode ?? ''}</td>
                  <td className="max-w-[260px] truncate px-2 py-1 text-text-muted" title={[row.status.nodeList, row.status.reason].filter(Boolean).join(' · ')}>
                    {[row.status.nodeList, row.status.reason].filter(Boolean).join(' · ')}
                  </td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-4 text-center text-text-muted">No tasks match this filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export function taskRowsForNode(ns: NodeRunState): TaskRow[] {
  const taskMap = ns.arrayTaskMap?.length ? ns.arrayTaskMap : fallbackTaskMap(ns.arraySize)
  const fallbackState = fallbackStateForNode(ns.status)
  return taskMap
    .map((entry) => ({
      ...entry,
      status: {
        taskId: entry.taskId,
        key: entry.key,
        state: fallbackState,
        updatedAt: Date.now(),
        ...ns.arrayTasks?.[entry.taskId],
      },
    }))
    .sort((a, b) => naturalTaskOrder(a, b))
}

function fallbackTaskMap(size: number | undefined): ArrayTaskMapEntry[] {
  return Array.from({ length: Math.max(0, size ?? 0) }, (_, index) => ({
    taskId: String(index),
    key: String(index),
    label: `task ${index}`,
    index,
  }))
}

function fallbackStateForNode(status: NodeRunState['status']): ArrayTaskState {
  if (status === 'done') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'running') return 'running'
  return 'queued'
}

function naturalTaskOrder(a: ArrayTaskMapEntry, b: ArrayTaskMapEntry): number {
  const ca = chromRank(a.key)
  const cb = chromRank(b.key)
  if (ca !== cb) return ca - cb
  return a.index - b.index
}

function chromRank(key: string): number {
  const clean = key.replace(/^chr/i, '').toUpperCase()
  if (/^\d+$/.test(clean)) return Number(clean)
  if (clean === 'X') return 23
  if (clean === 'Y') return 24
  if (clean === 'M' || clean === 'MT') return 25
  return 1000
}

function filterMatches(state: ArrayTaskState, filter: Filter): boolean {
  if (filter === 'all') return true
  if (filter === 'running') return state === 'running' || state === 'queued' || state === 'unknown'
  if (filter === 'failed') return state === 'failed' || state === 'timeout' || state === 'cancelled'
  return state === 'completed'
}

function taskCounts(rows: TaskRow[]): Record<ArrayTaskState, number> {
  const counts: Record<ArrayTaskState, number> = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timeout: 0,
    unknown: 0,
  }
  for (const row of rows) counts[row.status.state] += 1
  return counts
}

function StackedProgress({ counts, total }: { counts: Record<ArrayTaskState, number>; total: number }) {
  const sections: Array<{ state: ArrayTaskState; label: string }> = [
    { state: 'completed', label: 'Done' },
    { state: 'running', label: 'Running' },
    { state: 'queued', label: 'Queued' },
    { state: 'failed', label: 'Failed' },
    { state: 'timeout', label: 'Timeout' },
    { state: 'cancelled', label: 'Cancelled' },
    { state: 'unknown', label: 'Unknown' },
  ]
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-bg-primary shadow-inner">
        {sections.map(({ state }) => {
          const count = counts[state]
          if (!count) return null
          return (
            <div
              key={state}
              className={stackedBarClass(state)}
              style={{ width: `${Math.max(2, (count / total) * 100)}%` }}
            />
          )
        })}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-muted">
        {sections.filter(({ state }) => counts[state] > 0).map(({ state, label }) => (
          <span key={state}>
            <span className={classNames('mr-1 inline-block h-2 w-2 rounded-full', stackedBarClass(state))} />
            {label}: {counts[state]}
          </span>
        ))}
      </div>
    </div>
  )
}

function shortTaskLabel(row: TaskRow): string {
  const key = row.key.replace(/^chr/i, '')
  return key.length > 4 ? key.slice(0, 4) : key
}

function stackedBarClass(state: ArrayTaskState): string {
  switch (state) {
    case 'completed': return 'bg-success'
    case 'running': return 'bg-accent'
    case 'failed': return 'bg-error'
    case 'timeout': return 'bg-red-400'
    case 'cancelled': return 'bg-text-muted'
    case 'unknown': return 'bg-warning'
    case 'queued': return 'bg-bg-hover'
  }
}

function taskPillClass(state: ArrayTaskState): string {
  switch (state) {
    case 'completed': return 'bg-success/20 text-success hover:bg-success/30'
    case 'running': return 'bg-accent/20 text-accent hover:bg-accent/30'
    case 'failed': return 'bg-error/20 text-error hover:bg-error/30'
    case 'timeout': return 'bg-red-500/20 text-red-200 hover:bg-red-500/30'
    case 'cancelled': return 'bg-text-muted/20 text-text-muted hover:bg-text-muted/30'
    case 'unknown': return 'bg-warning/20 text-warning hover:bg-warning/30'
    case 'queued': return 'bg-bg-hover text-text-secondary hover:text-text-primary'
  }
}

function statusTextClass(state: ArrayTaskState): string {
  switch (state) {
    case 'completed': return 'bg-success/15 text-success'
    case 'running': return 'bg-accent/15 text-accent'
    case 'failed': return 'bg-error/15 text-error'
    case 'timeout': return 'bg-red-500/15 text-red-200'
    case 'cancelled': return 'bg-text-muted/15 text-text-muted'
    case 'unknown': return 'bg-warning/15 text-warning'
    case 'queued': return 'bg-bg-hover text-text-secondary'
  }
}
