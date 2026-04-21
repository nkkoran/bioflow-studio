import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { getQueueSnapshot, useSlurmQueueStore } from '@/stores/slurmQueueStore'
import { useRunStore } from '@/stores/runStore'

export function QueuePanel() {
  const connectionId = useConnectionStore((s) => s.activeConnectionId)
  const snapshots = useSlurmQueueStore((s) => s.byConnection)
  const refreshQueue = useSlurmQueueStore((s) => s.refreshQueue)
  const runs = useRunStore((s) => s.runs)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [onlyBioFlow, setOnlyBioFlow] = useState(false)
  const [sortKey, setSortKey] = useState<'jobId' | 'name' | 'state' | 'elapsed' | 'partition'>('jobId')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const snapshot = connectionId ? getQueueSnapshot(snapshots, connectionId) : null
  const ourJobIds = useMemo(() => {
    const ids = new Set<string>()
    for (const run of Object.values(runs)) {
      for (const node of Object.values(run.nodes)) {
        if (node.jobId) ids.add(node.jobId)
      }
    }
    return ids
  }, [runs])

  useEffect(() => {
    if (!connectionId || connectionId === LOCAL_CONNECTION_ID) return
    void refreshQueue(connectionId)
  }, [connectionId, refreshQueue])

  // Auto-refresh pauses while an error is set — otherwise a dead SSH
  // connection produces a stream of error toasts every 10s. User can resume
  // by clicking Refresh, which clears the error on next success.
  useEffect(() => {
    if (!autoRefresh || !connectionId || connectionId === LOCAL_CONNECTION_ID) return
    if (snapshot?.error) return
    const timer = setInterval(() => void refreshQueue(connectionId), 10000)
    return () => clearInterval(timer)
  }, [autoRefresh, connectionId, refreshQueue, snapshot?.error])

  const rows = useMemo(() => {
    const base = snapshot?.entries ?? []
    const filtered = onlyBioFlow ? base.filter((entry) => isKnownJob(entry.jobId, ourJobIds)) : base
    const sign = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => sign * a[sortKey].localeCompare(b[sortKey], undefined, { numeric: true }))
  }, [onlyBioFlow, ourJobIds, snapshot?.entries, sortKey, sortDir])

  const onSort = (key: typeof sortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  // Only surface cancel on rows we submitted — scancel on arbitrary cluster jobs
  // is a foot-gun. The parent id (pre-`_`) is what scancel expects.
  const onCancel = async (jobId: string) => {
    if (!connectionId) return
    const parent = jobId.split('_')[0]
    if (!confirm(`Cancel Slurm job ${parent}?`)) return
    try {
      await window.api.pipeline.cancelJob(connectionId, parent)
      void refreshQueue(connectionId)
    } catch (err: any) {
      alert(`scancel failed: ${err?.message ?? err}`)
    }
  }

  if (!connectionId || connectionId === LOCAL_CONNECTION_ID) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-text-muted">
        Connect to a Slurm cluster to view the live queue.
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2 border-b border-border-light px-3 py-2">
        <div>
          <div className="text-xs font-medium text-text-primary">Slurm queue</div>
          <div className="text-[10px] text-text-muted">
            {snapshot?.fetchedAt ? `Updated ${new Date(snapshot.fetchedAt).toLocaleTimeString()}` : 'Not loaded yet'}
          </div>
        </div>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          <input type="checkbox" checked={onlyBioFlow} onChange={(e) => setOnlyBioFlow(e.target.checked)} className="accent-accent" />
          BioFlow only
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-accent" />
          Auto-refresh
        </label>
        <Button variant="ghost" size="sm" icon={<RefreshCw size={12} />} onClick={() => void refreshQueue(connectionId)} className="h-6 text-xs">
          Refresh
        </Button>
      </div>

      {snapshot?.error && (
        <div className="shrink-0 border-b border-error/20 bg-error/10 px-3 py-2 text-xs text-error">
          {snapshot.error.includes('squeue') ? 'Could not run squeue on this connection.' : snapshot.error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-bg-tertiary">
            <tr>
              {[
                ['jobId', 'Job ID'],
                ['name', 'Name'],
                ['state', 'State'],
                ['elapsed', 'Elapsed'],
                ['partition', 'Partition'],
              ].map(([key, label]) => (
                <th key={key} className="border-b border-border px-3 py-2 text-text-secondary">
                  <button onClick={() => onSort(key as typeof sortKey)} className="hover:text-text-primary">
                    {label}{sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </button>
                </th>
              ))}
              <th className="border-b border-border px-3 py-2 text-text-secondary">Limit</th>
              <th className="border-b border-border px-3 py-2 text-text-secondary">Reason</th>
              <th className="border-b border-border px-3 py-2 text-text-secondary w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => {
              const ours = isKnownJob(entry.jobId, ourJobIds)
              return (
                <tr key={entry.jobId} className={ours ? 'bg-accent/5' : 'odd:bg-bg-primary even:bg-bg-secondary'}>
                  <td className="border-b border-border/50 px-3 py-1.5 font-mono text-text-primary">{entry.jobId}</td>
                  <td className="border-b border-border/50 px-3 py-1.5 text-text-primary">{entry.name}</td>
                  <td className="border-b border-border/50 px-3 py-1.5 text-text-secondary">{entry.state}</td>
                  <td className="border-b border-border/50 px-3 py-1.5 text-text-muted font-mono">{entry.elapsed}</td>
                  <td className="border-b border-border/50 px-3 py-1.5 text-text-muted">{entry.partition}</td>
                  <td className="border-b border-border/50 px-3 py-1.5 text-text-muted font-mono">{entry.timeLimit}</td>
                  <td className="border-b border-border/50 px-3 py-1.5 text-text-muted">{entry.reason}</td>
                  <td className="border-b border-border/50 px-3 py-1.5 text-right">
                    {ours && (
                      <button
                        title="Cancel job (scancel)"
                        onClick={() => void onCancel(entry.jobId)}
                        className="p-1 rounded text-text-muted hover:text-error hover:bg-error/10"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {!snapshot?.loading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-text-muted">
                  No queued jobs visible for this connection.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Match both `12345` and `12345_3` / `12345_[0-5]` forms against our known parent ids. */
function isKnownJob(jobId: string, known: Set<string>): boolean {
  if (known.has(jobId)) return true
  const parent = jobId.split('_')[0]
  return known.has(parent)
}
