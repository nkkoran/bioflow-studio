import { useEffect, useMemo } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getQueueSnapshot, useSlurmQueueStore } from '@/stores/slurmQueueStore'
import type { RunState } from '@/types/pipeline'

interface Props {
  run: RunState
}

export function QueueDetails({ run }: Props) {
  const snapshots = useSlurmQueueStore((s) => s.byConnection)
  const refreshQueue = useSlurmQueueStore((s) => s.refreshQueue)
  const snapshot = getQueueSnapshot(snapshots, run.connectionId)

  const knownJobIds = useMemo(() => {
    const ids = new Set<string>()
    for (const ns of Object.values(run.nodes)) {
      if (ns.jobId) ids.add(ns.jobId)
    }
    return ids
  }, [run.nodes])

  const rows = useMemo(
    () => snapshot.entries.map((entry) => ({ ...entry, isOurs: isKnownJob(entry.jobId, knownJobIds) })),
    [snapshot.entries, knownJobIds],
  )
  const oursCount = rows.filter((entry) => entry.isOurs).length

  useEffect(() => {
    if (!run.connectionId) return
    void refreshQueue(run.connectionId)
    const timer = setInterval(() => void refreshQueue(run.connectionId), 10_000)
    return () => clearInterval(timer)
  }, [run.connectionId, refreshQueue])

  return (
    <div className="border-b border-border-light bg-bg-secondary/50 shrink-0">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">Slurm queue</div>
          <div className="text-[11px] text-text-secondary truncate">
            {snapshot.error
              ? snapshot.error
              : rows.length > 0
                ? `${rows.length} job${rows.length === 1 ? '' : 's'} in your queue · ${oursCount} from this run`
                : 'No jobs currently visible in squeue'}
          </div>
        </div>
        {snapshot.fetchedAt && (
          <span className="text-[10px] text-text-muted whitespace-nowrap">
            {formatFetchedAt(snapshot.fetchedAt)}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={11} className={snapshot.loading ? 'animate-spin' : ''} />}
          onClick={() => void refreshQueue(run.connectionId)}
          disabled={snapshot.loading}
          className="h-6 px-2 text-[10px]"
        >
          Queue
        </Button>
      </div>

      {rows.length > 0 && (
        <div className="max-h-24 overflow-y-auto border-t border-border-light">
          <table className="w-full text-[10px] font-mono">
            <tbody>
              {rows.map((entry) => (
                <tr
                  key={entry.jobId}
                  className={`border-b border-border-light last:border-b-0 ${entry.isOurs ? 'bg-accent/5' : ''}`}
                >
                  <td className={`px-3 py-1 whitespace-nowrap ${entry.isOurs ? 'text-accent' : 'text-text-primary'}`}>
                    {entry.jobId}
                  </td>
                  <td className="px-2 py-1 text-text-secondary truncate max-w-[180px]">{entry.name}</td>
                  <td className={`px-2 py-1 whitespace-nowrap ${stateColor(entry.state)}`}>{entry.state}</td>
                  <td className="px-2 py-1 text-text-muted whitespace-nowrap">{entry.elapsed}</td>
                  <td className="px-2 py-1 text-text-muted whitespace-nowrap">{entry.timeLimit}</td>
                  <td className="px-2 py-1 text-text-muted truncate max-w-[120px]">{entry.partition}</td>
                  <td className="px-2 py-1 text-text-muted truncate max-w-[220px]">{entry.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function isKnownJob(jobId: string, knownJobIds: Set<string>): boolean {
  const parent = jobId.split('_')[0]
  return knownJobIds.has(jobId) || knownJobIds.has(parent)
}

function stateColor(state: string): string {
  if (state === 'RUNNING' || state === 'R') return 'text-warning'
  if (state === 'PENDING' || state === 'PD') return 'text-accent'
  if (state === 'COMPLETING' || state === 'CG') return 'text-success'
  return 'text-text-secondary'
}

function formatFetchedAt(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 2) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ago`
}
